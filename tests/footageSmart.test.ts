import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AI_CLIP_MAX, EditPlan, aiClipsIn, aiCostUsd, planDuration, type FootageClip, type PlanRequest } from '../src/shared/footage'
import { runFfmpeg } from '../src/main/footage/ffmpeg'
import { focusFromFrames, subjectFocus } from '../src/main/footage/focus'
import { heuristicShorts, planEdit, planShorts, sanitize } from '../src/main/footage/planner'
import { buildSegmentGraph, renderPlan } from '../src/main/footage/render'
import { scanClip } from '../src/main/footage/scan'
import { FootageService } from '../src/main/footage/service'
import { FootageStore } from '../src/main/footage/store'
import { MockProvider } from '../src/main/providers/mock'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

let root: string
const ok = async (args: string[]) => {
  const r = await runFfmpeg(['-v', 'error', '-y', ...args])
  if (r.code !== 0) throw new Error(r.stderr)
}
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'footage-smart-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const clip = (over: Partial<FootageClip> & { id: string }): FootageClip => ({
  path: `C:/v/${over.id}.mp4`, name: `${over.id}.mp4`, folder: 'C:/v', sizeBytes: 1, mtimeMs: 1, durationSec: 100, width: 1920, height: 1080, fps: 30, hasAudio: true, lufs: -23,
  shots: [], watched: true, listened: true, status: 'ok', ...over
})
const model = (reply: () => unknown, asked: GenerateJSONRequest[] = []): LLMProvider => ({
  id: 'openai', label: 'fake', isConfigured: async () => true, listModels: async () => [], generateText: async () => '',
  generateJSON: async <T,>(r: GenerateJSONRequest) => { asked.push(r); return reply() as T }
})

describe('smart crop', () => {
  it('finds the busy side of a frame and stays central when nothing stands out', () => {
    const w = 48
    const h = 27
    const flat = new Uint8Array(w * h).fill(100)
    expect(focusFromFrames([flat, flat], w, h)).toEqual({ x: 0.5, y: 0.5 })
    // a bright square on the right edge appears in the second frame
    const moved = new Uint8Array(flat)
    for (let y = 8; y < 18; y++) for (let x = 36; x < 46; x++) moved[y * w + x] = 255
    const f = focusFromFrames([flat, moved], w, h)
    expect(f.x).toBeGreaterThan(0.65)
    expect(f.y).toBeGreaterThan(0.35)
    expect(f.y).toBeLessThan(0.65)
    expect(focusFromFrames([], 0, 0)).toEqual({ x: 0.5, y: 0.5 })
  })

  it('writes the crop position into the picture filter', () => {
    const c = clip({ id: 'a', width: 1920, height: 1080 })
    const plan = EditPlan.parse({ shape: '9:16', reframe: 'crop', segments: [{ clipId: 'a', startSec: 0, endSec: 2, focus: { x: 0.8, y: 0.5 } }, { clipId: 'a', startSec: 2, endSec: 4 }] })
    const g = buildSegmentGraph(plan, new Map([['a', c]])).filter
    expect(g).toContain("crop=1080:1920:x='min(max(0.8*iw-ow/2,0),iw-ow)'")
    expect(g.match(/crop=1080:1920,/g)).toHaveLength(1)
  })

  it('crops towards the subject in a real render', async () => {
    const dir = join(root, 'wide')
    mkdirSync(dir, { recursive: true })
    // a dark wide frame with one bright, detailed block on the far right
    await ok(['-f', 'lavfi', '-i', 'color=c=0x202020:s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'testsrc2=s=240x240:r=30:d=4', '-filter_complex', '[0:v][1:v]overlay=980:240[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', join(dir, 'w.mp4')])
    const focus = await subjectFocus(join(dir, 'w.mp4'), 0, 4)
    expect(focus.x).toBeGreaterThan(0.62)
    const c = await scanClip({ path: join(dir, 'w.mp4'), folder: dir }, dir)
    const plan = EditPlan.parse({ shape: '9:16', reframe: 'crop', music: { mode: 'none' }, loudness: 'off', fadeInOut: false, segments: [{ clipId: c.id, startSec: 0, endSec: 2 }] })
    const out = join(root, 'smart.mp4')
    await renderPlan({ plan, clips: [c], workDir: join(root, 'w1'), outFile: out, isCancelled: () => false, onProgress: () => {} })
    // the subject (bright, busy) must be inside the tall frame, not cropped away
    const r = await runFfmpeg(['-v', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-vf', 'scale=108:192,format=gray', '-f', 'rawvideo', '-'], { collectStdout: true })
    let bright = 0
    for (const v of r.stdout) if (v > 150) bright++
    expect(bright).toBeGreaterThan(300)
  }, 120_000)
})

describe('AI scenes in a plan', () => {
  const refs = new Map([['c1', clip({ id: 'one' })]])
  const base = { title: 'x', music: 'auto' as const, musicMood: 'upbeat', titles: [], notes: [] }
  const segs = [
    { clip: 'c1', start: 0, end: 4 },
    { aiPrompt: 'Slow aerial shot over a misty harbour at dawn', aiSec: 20 },
    { aiPrompt: 'Close-up of steam rising from a coffee cup', aiSec: 1 },
    { aiPrompt: 'a third one', aiSec: 5 },
    { clip: 'c1', start: 10, end: 14 }
  ]

  it('only accepts them when the person allowed them, a few at a time, with sane lengths', () => {
    const req: PlanRequest = { prompt: 'x', shape: '9:16', music: 'auto-mood' }
    expect(aiClipsIn(sanitize({ ...base, segments: segs }, refs, req))).toBe(0)
    const plan = sanitize({ ...base, segments: segs }, refs, { ...req, aiClips: true })
    const ai = plan.segments.filter((s) => s.ai)
    expect(ai).toHaveLength(2)
    expect(ai.map((s) => s.clipId)).toEqual(['ai-1', 'ai-2'])
    expect(ai[0].endSec - ai[0].startSec).toBe(8)
    expect(ai[1].endSec - ai[1].startSec).toBe(3)
    expect(ai.every((s) => !s.keepAudio)).toBe(true)
    expect(aiCostUsd(plan)).toBeCloseTo(1.1, 2)
    expect(AI_CLIP_MAX).toBeGreaterThanOrEqual(2)
  })

  it('tells the model whether AI scenes are allowed', async () => {
    const asked: GenerateJSONRequest[] = []
    const c = [clip({ id: 'one' })]
    await planEdit(model(() => ({ segments: [{ clip: 'c1', start: 0, end: 4 }] }), asked), c, { prompt: 'x', shape: '9:16', music: 'auto-mood', aiClips: true })
    await planEdit(model(() => ({ segments: [{ clip: 'c1', start: 0, end: 4 }] }), asked), c, { prompt: 'x', shape: '9:16', music: 'auto-mood' })
    expect(JSON.parse(asked[0].prompt).aiClips).toMatch(/allowed/)
    expect(JSON.parse(asked[1].prompt).aiClips).toBe('not allowed')
  })

  it('renders the AI scene it is handed, and refuses politely without a way to make one', async () => {
    const dir = join(root, 'ai')
    mkdirSync(dir, { recursive: true })
    await ok(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=4', '-filter_complex', '[0:v]null[a];[1:v]null[b]', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', join(dir, 'real.mp4'), '-map', '[b]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', join(dir, 'fake-ai.mp4')])
    const real = await scanClip({ path: join(dir, 'real.mp4'), folder: dir }, dir)
    const plan = EditPlan.parse({
      shape: '16:9', music: { mode: 'none' }, loudness: 'off', fadeInOut: false,
      segments: [{ clipId: real.id, startSec: 0, endSec: 2, keepAudio: false }, { clipId: 'ai-1', startSec: 0, endSec: 3, ai: { prompt: 'blue sky' } }]
    })
    const asked: Array<[string, string, number]> = []
    const out = join(root, 'with-ai.mp4')
    const res = await renderPlan({ plan, clips: [real], workDir: join(root, 'w2'), outFile: out, isCancelled: () => false, onProgress: () => {}, makeClip: async (p, a, s) => { asked.push([p, a, s]); return join(dir, 'fake-ai.mp4') } })
    expect(asked).toEqual([['blue sky', '16:9', 3]])
    expect(res.durationSec).toBeCloseTo(5, 0)
    await expect(renderPlan({ plan, clips: [real], workDir: join(root, 'w3'), outFile: join(root, 'no-ai.mp4'), isCancelled: () => false, onProgress: () => {} })).rejects.toThrow(/Gemini key/)
  }, 120_000)
})

describe('several shorts from one long recording', () => {
  // an hour-long talk: 12 shots of 5 minutes, speech in each
  const talk = clip({
    id: 'talk', durationSec: 3600,
    shots: Array.from({ length: 12 }, (_, i) => ({ startSec: i * 300, endSec: (i + 1) * 300, score: 7, description: `topic ${i}` })),
    transcript: Array.from({ length: 12 }, (_, i) => ({ startSec: i * 300, endSec: i * 300 + 40, text: `topic ${i} explained` }))
  })
  const req: PlanRequest = { prompt: 'best moments as shorts', shape: '9:16', music: 'auto-mood', shorts: 3, durationSec: 30 }

  it('keeps every short self-contained and never reuses a moment', async () => {
    const reply = {
      shorts: [
        { title: 'A', segments: [{ clip: 'c1', start: 0, end: 30, keepAudio: true }], musicMood: 'upbeat' },
        // overlaps the first short in its first half: that part must be dropped
        { title: 'B', segments: [{ clip: 'c1', start: 10, end: 25 }, { clip: 'c1', start: 600, end: 630 }], musicMood: 'calm' },
        { title: 'C', segments: [{ clip: 'c1', start: 1200, end: 1230 }], musicMood: 'cinematic' }
      ],
      notes: ['Skipped the intro']
    }
    const asked: GenerateJSONRequest[] = []
    const out = await planShorts(model(() => reply, asked), [talk], req)
    expect(out.source).toBe('ai')
    expect(out.plans.map((p) => p.title)).toEqual(['A', 'B', 'C'])
    expect(out.plans[1].segments).toHaveLength(1)
    expect(out.plans[1].segments[0].startSec).toBeGreaterThanOrEqual(600)
    expect(out.plans[1].music.mood).toBe('upbeat') // an unknown mood falls back
    expect(out.plans[0].notes).toEqual(['Skipped the intro'])
    expect(JSON.parse(asked[0].prompt)).toMatchObject({ shortsWanted: 3, lengthOfEachSec: 30 })
    // no AI scenes inside shorts
    expect(out.plans.every((p) => aiClipsIn(p) === 0)).toBe(true)
  })

  it('does not throw away a part when a cut lands in the middle of a long sentence', () => {
    const refs = new Map([['c1', clip({ id: 'one', transcript: [{ startSec: 0, endSec: 40, text: 'a long answer' }, { startSec: 60, endSec: 90, text: 'another' }] })]])
    const base = { title: 'x', music: 'auto' as const, musicMood: 'upbeat', titles: [], notes: [] }
    const r: PlanRequest = { prompt: 'x', shape: '9:16', music: 'auto-mood', durationSec: 0 }
    // ends 10s before the sentence ends: finish the sentence instead of cutting it to nothing
    expect(sanitize({ ...base, segments: [{ clip: 'c1', start: 0, end: 30 }] }, refs, r).segments[0]).toMatchObject({ startSec: 0, endSec: 40 })
    // starts and ends mid-sentence with plenty of other speech: step back to whole sentences
    expect(sanitize({ ...base, segments: [{ clip: 'c1', start: 50, end: 75 }] }, refs, r).segments[0]).toMatchObject({ startSec: 50, endSec: 60 })
  })

  it('says so when the footage supports fewer shorts than asked', async () => {
    const out = await planShorts(model(() => ({ shorts: [{ title: 'Only', segments: [{ clip: 'c1', start: 0, end: 30 }] }] })), [talk], req)
    expect(out.plans).toHaveLength(1)
    expect(out.plans[0].notes.join(' ')).toMatch(/Only 1 good short/)
  })

  it('falls back to equal parts of the footage in order, with no overlap', async () => {
    for (const out of [await planShorts(new MockProvider(), [talk], req), await planShorts(model(() => ({ nope: 1 })), [talk], req)]) {
      expect(out.source).toBe('basic')
      expect(out.plans.length).toBe(3)
      let last = -1
      for (const p of out.plans) {
        for (const s of p.segments) {
          expect(s.startSec).toBeGreaterThanOrEqual(last)
          last = s.endSec
        }
        expect(planDuration(p)).toBeLessThanOrEqual(31)
      }
      expect(out.plans[0].notes.length).toBe(1)
    }
    expect(heuristicShorts([talk], req, 4, 'n').length).toBeLessThanOrEqual(4)
    await expect(planShorts(new MockProvider(), [], req)).rejects.toThrow(/folder/)
  })

  it('is what the service returns when several shorts are asked for', async () => {
    const store = new FootageStore(join(root, 'store'))
    const p = store.create('Talk', [root])
    store.update(p.id, (x) => { x.clips = [talk] })
    const svc = new FootageService({ store, provider: () => new MockProvider(), whisperKey: () => '', chatModel: () => undefined, emit: () => {} })
    expect(svc.capabilities()).toEqual({ ai: false })
    const res = await svc.plan(p.id, { ...req, music: 'auto-mood' })
    expect(res.shorts?.length).toBe(3)
    expect(res.plan).toBe(res.shorts![0].plan)
    // thumbnails are tried per short (the fake paths do not exist, so they stay empty)
    expect(res.shorts![0].thumbs.length).toBe(res.shorts![0].plan.segments.length)
  })
})
