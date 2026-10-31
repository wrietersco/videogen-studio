import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditPlan, planDuration, shapeSize, type FootageClip, type PlanRequest } from '../src/shared/footage'
import { runFfmpeg } from '../src/main/footage/ffmpeg'
import { buildShots, listVideoFiles, measureLufs, parseProbe, probeFile, scanClip } from '../src/main/footage/scan'
import { buildCatalog, fitLength, heuristicPlan, planEdit, sanitize } from '../src/main/footage/planner'
import { buildSegmentGraph, renderPlan, shouldBlur, stemGainDb } from '../src/main/footage/render'
import { FootageStore } from '../src/main/footage/store'
import { FootageService } from '../src/main/footage/service'
import { estimateUnderstanding, watchClip } from '../src/main/footage/understand'
import { MockProvider } from '../src/main/providers/mock'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

let root: string
let footage: string
const ok = async (args: string[]) => {
  const r = await runFfmpeg(['-v', 'error', '-y', ...args])
  if (r.code !== 0) throw new Error(r.stderr)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'footage-'))
  footage = join(root, 'my videos')
  mkdirSync(join(footage, 'sub'), { recursive: true })
  const enc = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast']
  // A: landscape, loud tone, a hard cut at 3s (test pattern → solid red)
  await ok(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=3', '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=300:d=6',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v];[2:a]volume=0.5[a]', '-map', '[v]', '-map', '[a]', ...enc, '-c:a', 'aac', '-shortest', join(footage, 'a-beach.mp4')])
  // B: portrait, much quieter tone
  await ok(['-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=500:d=4', '-af', 'volume=0.04', '-map', '0:v', '-map', '1:a', ...enc, '-c:a', 'aac', '-shortest', join(footage, 'sub', 'b-portrait.mp4')])
  // C: landscape, no sound at all
  await ok(['-f', 'lavfi', '-i', 'smptebars=s=1280x720:r=30:d=5', ...enc, join(footage, 'sub', 'c-silent.mov')])
  writeFileSync(join(footage, 'notes.txt'), 'not a video')
  writeFileSync(join(footage, 'broken.mp4'), 'definitely not a video')
}, 120_000)

afterAll(() => rmSync(root, { recursive: true, force: true }))

const clip = (over: Partial<FootageClip> & { id: string }): FootageClip => ({
  path: `C:/v/${over.id}.mp4`, name: `${over.id}.mp4`, folder: 'C:/v', sizeBytes: 1, mtimeMs: 1, durationSec: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, lufs: -23,
  shots: [{ startSec: 0, endSec: 5, score: 8, description: 'a dog runs' }, { startSec: 5, endSec: 10, score: 3, description: 'blurry floor' }],
  watched: true, listened: true, status: 'ok', ...over
})

describe('scanning footage', () => {
  it('lists videos recursively, skipping other files, in a stable order', () => {
    const files = listVideoFiles([footage]).map((f) => f.path.replace(footage, '').replace(/\\/g, '/'))
    expect(files).toEqual(['/broken.mp4', '/a-beach.mp4', '/sub/b-portrait.mp4', '/sub/c-silent.mov'].sort((a, b) => files.indexOf(a) - files.indexOf(b)))
    expect(files).toHaveLength(4)
    expect(files.some((f) => f.endsWith('.txt'))).toBe(false)
  })

  it('probes length, size, fps and sound, applying rotation', async () => {
    const p = await probeFile(join(footage, 'a-beach.mp4'))
    expect(p).toMatchObject({ width: 1280, height: 720, hasAudio: true })
    expect(p!.durationSec).toBeCloseTo(6, 0)
    expect(parseProbe('Duration: 00:00:10.00\n Stream #0:0: Video: h264, yuv420p, 1920x1080, 30 fps\n    displaymatrix: rotation of -90.00 degrees')).toMatchObject({ width: 1080, height: 1920 })
    expect(await probeFile(join(footage, 'broken.mp4'))).toBeNull()
  })

  it('finds shots at hard cuts, makes keyframes, and measures loudness', async () => {
    const dir = join(root, 'proj-scan')
    mkdirSync(dir, { recursive: true })
    const a = await scanClip({ path: join(footage, 'a-beach.mp4'), folder: footage }, dir)
    expect(a.status).toBe('ok')
    expect(a.shots.length).toBe(2)
    expect(a.shots[0].endSec).toBeCloseTo(3, 0)
    expect(existsSync(join(dir, a.shots[0].frame!))).toBe(true)
    expect(a.hasAudio && a.lufs !== undefined).toBe(true)
    const b = await scanClip({ path: join(footage, 'sub', 'b-portrait.mp4'), folder: footage }, dir)
    expect(b.lufs!).toBeLessThan(a.lufs! - 10)
    const c = await scanClip({ path: join(footage, 'sub', 'c-silent.mov'), folder: footage }, dir)
    expect(c).toMatchObject({ hasAudio: false, listened: true })
    const bad = await scanClip({ path: join(footage, 'broken.mp4'), folder: footage }, dir)
    expect(bad).toMatchObject({ status: 'unreadable' })
    expect(bad.error).toBeTruthy()
  })

  it('merges tiny shots and splits very long ones', () => {
    expect(buildShots(10, [1, 1.4, 5])).toEqual([{ startSec: 0, endSec: 5 }, { startSec: 5, endSec: 10 }])
    const long = buildShots(40, [])
    expect(long.length).toBe(3)
    expect(long.every((s) => s.endSec - s.startSec <= 15)).toBe(true)
  })
})

describe('footage store', () => {
  it('creates, lists and deletes only its own folder, and refuses ids that escape it', () => {
    const outside = join(root, 'precious.txt')
    writeFileSync(outside, 'keep me')
    const store = new FootageStore(join(root, 'store'))
    const p = store.create('Holiday  trip!', [footage, footage.toUpperCase()])
    expect(p.folders).toHaveLength(1)
    expect(store.list().map((s) => s.id)).toEqual([p.id])
    expect(() => store.dir('../precious.txt')).toThrow()
    expect(store.delete(p.id)).toBe(true)
    expect(store.read(p.id)).toBeNull()
    expect(existsSync(footage) && existsSync(outside)).toBe(true)
  })

  it('only removes an edit file that lives in its own edits folder', () => {
    const store = new FootageStore(join(root, 'store2'))
    const p = store.create('x', [])
    const mine = join(store.editsDir(p.id), 'e.mp4')
    const foreign = join(root, 'foreign.mp4')
    writeFileSync(mine, 'a')
    writeFileSync(foreign, 'b')
    store.addEdit(p.id, { id: 'e1', title: 't', createdAt: '', prompt: '', shape: '9:16', durationSec: 1, file: mine })
    store.addEdit(p.id, { id: 'e2', title: 't', createdAt: '', prompt: '', shape: '9:16', durationSec: 1, file: foreign })
    store.removeEdit(p.id, 'e1')
    store.removeEdit(p.id, 'e2')
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
    expect(store.read(p.id)!.edits).toHaveLength(0)
  })
})

describe('edit planning', () => {
  const clips = [clip({ id: 'one' }), clip({ id: 'two', durationSec: 20, shots: [{ startSec: 0, endSec: 20, score: 9, description: 'sunset' }] })]
  const req: PlanRequest = { prompt: 'a short reel', shape: '9:16', durationSec: 8, music: 'auto-mood' }

  it('sanitizes a model plan: drops unknown clips, clamps times, fits the length', () => {
    const { refs } = buildCatalog(clips)
    const plan = sanitize(
      {
        title: ' Reel ', music: 'auto', musicMood: 'cinematic', notes: ['one'],
        segments: [
          { clip: 'c9', start: 0, end: 3 },
          { clip: 'c1', start: -5, end: 99, why: 'dog' },
          { clip: 'c2', start: 2, end: 2.1 },
          { clip: 'c2', start: 0, end: 20, speed: 9, fade: true }
        ]
      },
      refs,
      req
    )
    expect(plan.title).toBe('Reel')
    expect(plan.segments.every((s) => s.startSec >= 0 && s.endSec <= 20 && s.speed <= 4)).toBe(true)
    expect(plan.segments[0]).toMatchObject({ clipId: 'one', startSec: 0, transition: 'cut' })
    expect(plan.segments.length).toBe(2)
    expect(planDuration(plan)).toBeLessThanOrEqual(8 * 1.05 + 0.3)
    const uncut = sanitize({ title: 't', music: 'auto', musicMood: 'x', notes: [], segments: [{ clip: 'c1', start: -5, end: 99 }] }, refs, { ...req, durationSec: 0 })
    expect(uncut.segments[0]).toMatchObject({ startSec: 0, endSec: 10 })
    expect(plan.music).toMatchObject({ mode: 'auto', mood: 'cinematic' })
  })

  it('keeps spoken sentences whole when a cut lands inside one', () => {
    const talky = clip({ id: 'talk', transcript: [{ startSec: 2, endSec: 5, text: 'hello there' }] })
    const { refs } = buildCatalog([talky])
    const plan = sanitize({ title: 't', music: 'none', musicMood: 'x', notes: [], segments: [{ clip: 'c1', start: 2.8, end: 4.9, keepAudio: true }] }, refs, { ...req, durationSec: 0 })
    expect(plan.segments[0].startSec).toBe(2)
    expect(plan.segments[0].endSec).toBe(5)
    expect(plan.music.mode).toBe('none')
  })

  it('never keeps sound for a clip that has none', () => {
    const { refs } = buildCatalog([clip({ id: 'mute', hasAudio: false, lufs: undefined })])
    const plan = sanitize({ title: 't', music: 'auto', musicMood: 'upbeat', notes: [], segments: [{ clip: 'c1', start: 0, end: 4, keepAudio: true }] }, refs, req)
    expect(plan.segments[0].keepAudio).toBe(false)
  })

  it('shrinks the longest shots first and honours the music choice the person made', () => {
    const segs = EditPlan.parse({ segments: [{ clipId: 'a', startSec: 0, endSec: 10 }, { clipId: 'b', startSec: 0, endSec: 3 }] }).segments
    const fitted = fitLength(segs, 6)
    expect(planDuration({ segments: fitted })).toBeLessThanOrEqual(6 * 1.05 + 0.25)
    expect(fitted[1].endSec).toBe(3)
    const { refs } = buildCatalog(clips)
    const own = sanitize({ title: 't', music: 'auto', musicMood: 'dark', notes: [], segments: [{ clip: 'c1', start: 0, end: 4 }] }, refs, { ...req, music: { mode: 'none', mood: 'upbeat' } })
    expect(own.music.mode).toBe('none')
  })

  it('plans offline by spreading the best shots across clips without exceeding the footage', () => {
    const plan = heuristicPlan(clips, req, 'note')
    expect(planDuration(plan)).toBeLessThanOrEqual(8.5)
    expect(new Set(plan.segments.map((s) => s.clipId)).size).toBe(2)
    expect(plan.notes).toEqual(['note'])
    expect(planDuration(heuristicPlan([clip({ id: 'tiny', durationSec: 3, shots: [{ startSec: 0, endSec: 3 }] })], { ...req, durationSec: 60 }, ''))).toBeLessThanOrEqual(3.1)
  })

  it('asks the model with a compact catalog and falls back when it keeps failing', async () => {
    const asked: GenerateJSONRequest[] = []
    const model = (reply: () => unknown): LLMProvider => ({
      id: 'openai', label: 'fake', isConfigured: async () => true, listModels: async () => [], generateText: async () => '',
      generateJSON: async <T,>(r: GenerateJSONRequest) => { asked.push(r); return reply() as T }
    })
    const good = await planEdit(model(() => ({ title: 'Dogs', music: 'auto', musicMood: 'upbeat', notes: [], segments: [{ clip: 'c1', start: 0, end: 4, why: 'the dog' }] })), clips, req)
    expect(good.source).toBe('ai')
    expect(good.plan.segments[0]).toMatchObject({ clipId: 'one', why: 'the dog' })
    const sent = JSON.parse(asked[0].prompt)
    expect(sent.clips[0]).toMatchObject({ ref: 'c1', name: 'one.mp4', shots: [[0, 5, 8, 'a dog runs'], [5, 10, 3, 'blurry floor']] })
    asked.length = 0
    const bad = await planEdit(model(() => ({ nonsense: true })), clips, req)
    expect(bad.source).toBe('basic')
    expect(asked.length).toBe(2)
    expect(JSON.parse(asked[1].prompt).correction).toMatch(/invalid/)
    expect((await planEdit(new MockProvider(), clips, req)).source).toBe('basic')
    await expect(planEdit(new MockProvider(), [], req)).rejects.toThrow(/folder/)
  })

  it('shrinks the catalog for huge libraries instead of blowing the model’s context', () => {
    const many = Array.from({ length: 400 }, (_, i) => clip({ id: `m${i}`, shots: Array.from({ length: 12 }, (_, k) => ({ startSec: k, endSec: k + 1, score: 1 + (k % 9), description: 'a long description of what happens in this shot '.repeat(2) })) }))
    const small = buildCatalog(many, 60_000)
    expect(JSON.stringify(small.clips).length).toBeLessThan(120_000)
    expect(small.trimmedNote).toBeTruthy()
  })
})

describe('understanding estimates and vision', () => {
  it('prices only what is not done yet', () => {
    const todo = [clip({ id: 'x', watched: false, listened: false, durationSec: 120 }), clip({ id: 'y' })]
    const est = estimateUnderstanding(todo, 'gpt-6-luna', true)
    expect(est).toMatchObject({ shots: 2, clips: 1, speechMinutes: 2 })
    expect(est.usd).toBeGreaterThanOrEqual(0.012)
    expect(estimateUnderstanding(todo, 'gpt-6-luna', false).speechMinutes).toBe(0)
    expect(estimateUnderstanding([clip({ id: 'z' })], 'gpt-6-luna', true).usd).toBe(0)
  })

  it('writes descriptions back onto the right shots, tolerating a sloppy reply', async () => {
    const dir = join(root, 'proj-watch')
    mkdirSync(dir, { recursive: true })
    const a = await scanClip({ path: join(footage, 'a-beach.mp4'), folder: footage }, dir)
    const provider: LLMProvider = {
      id: 'openai', label: 'fake', isConfigured: async () => true, listModels: async () => [], generateText: async () => '',
      generateJSON: async <T,>() => ({ shots: [{ n: 2, description: '  A red screen  ', tags: ['RED', ' color '], score: 99 }, { n: 7, description: 'ghost', tags: [], score: 1 }, { n: 1, description: '', tags: [], score: 5 }] }) as T
    }
    await watchClip(provider, a, dir, () => false)
    expect(a.shots[1]).toMatchObject({ description: 'A red screen', tags: ['red', 'color'], score: 10 })
    expect(a.shots[0].description).toBeUndefined()
    expect(a.watched).toBe(false)
  })
})

describe('rendering', () => {
  const sizeOf = async (f: string) => {
    const p = await probeFile(f)
    return p!
  }

  it('balances quiet and loud clips against each other', () => {
    expect(stemGainDb(clip({ id: 'l', lufs: -30 }))).toBe(10)
    expect(stemGainDb(clip({ id: 'l', lufs: -50 }))).toBe(12)
    expect(stemGainDb(clip({ id: 'l', lufs: -8 }))).toBe(-12)
    expect(stemGainDb(clip({ id: 'l', lufs: undefined }))).toBe(0)
  })

  it('chooses crop or blurred sides by how different the shapes are', () => {
    const t = shapeSize('9:16')
    const plan = EditPlan.parse({ segments: [{ clipId: 'a', startSec: 0, endSec: 1 }] })
    expect(shouldBlur(plan, clip({ id: 'a' }), t)).toBe(true)
    expect(shouldBlur(plan, clip({ id: 'a', width: 1080, height: 1920 }), t)).toBe(false)
    expect(shouldBlur({ ...plan, reframe: 'crop' }, clip({ id: 'a' }), t)).toBe(false)
  })

  const scanned = async (): Promise<FootageClip[]> => {
    const dir = join(root, 'proj-render')
    mkdirSync(dir, { recursive: true })
    const out: FootageClip[] = []
    for (const p of [join(footage, 'a-beach.mp4'), join(footage, 'sub', 'b-portrait.mp4'), join(footage, 'sub', 'c-silent.mov')]) out.push(await scanClip({ path: p, folder: footage }, dir))
    return out
  }

  it('renders a tall edit with cuts, a fade, slow motion, muted b-roll, music and platform loudness', async () => {
    const clips = await scanned()
    const [a, b, c] = clips
    const plan = EditPlan.parse({
      title: 'Test reel', shape: '9:16', music: { mode: 'auto', mood: 'cinematic' },
      segments: [
        { clipId: a.id, startSec: 0, endSec: 2.5 },
        { clipId: b.id, startSec: 0.5, endSec: 3.5, transition: 'fade' },
        { clipId: c.id, startSec: 0, endSec: 2, speed: 2, keepAudio: false },
        { clipId: a.id, startSec: 3.5, endSec: 5.5, speed: 0.5 }
      ]
    })
    const expected = planDuration(plan)
    expect(buildSegmentGraph(plan, new Map(clips.map((x) => [x.id, x]))).totalSec).toBeCloseTo(expected, 1)
    const out = join(root, 'reel.mp4')
    const seen: number[] = []
    const res = await renderPlan({ plan, clips, workDir: join(root, 'work'), outFile: out, isCancelled: () => false, onProgress: (p) => seen.push(p) })
    expect(res.file).toBe(out)
    const info = await sizeOf(out)
    expect(info).toMatchObject({ width: 1080, height: 1920, hasAudio: true })
    expect(Math.abs(info.durationSec - expected)).toBeLessThan(0.5)
    const lufs = await measureLufs(out)
    expect(lufs!).toBeGreaterThan(-15.5)
    expect(lufs!).toBeLessThan(-12.5)
    expect(seen.at(-1)).toBe(100)
    expect(existsSync(join(root, 'work'))).toBe(false)
  }, 180_000)

  it('renders a wide edit with no music and the sound left alone', async () => {
    const clips = await scanned()
    const plan = EditPlan.parse({ shape: '16:9', music: { mode: 'none' }, loudness: 'off', fadeInOut: false, reframe: 'crop', segments: [{ clipId: clips[1].id, startSec: 0, endSec: 2 }, { clipId: clips[2].id, startSec: 1, endSec: 3 }] })
    const out = join(root, 'wide.mp4')
    await renderPlan({ plan, clips, workDir: join(root, 'work2'), outFile: out, isCancelled: () => false, onProgress: () => {} })
    expect(await sizeOf(out)).toMatchObject({ width: 1920, height: 1080, hasAudio: true })
  }, 120_000)

  it('can be cancelled, leaving no half-written file behind', async () => {
    const clips = await scanned()
    const plan = EditPlan.parse({ shape: '1:1', segments: [{ clipId: clips[0].id, startSec: 0, endSec: 5 }] })
    const out = join(root, 'cancelled.mp4')
    await expect(renderPlan({ plan, clips, workDir: join(root, 'work3'), outFile: out, isCancelled: () => true, onProgress: () => {} })).rejects.toThrow()
    expect(existsSync(out)).toBe(false)
    expect(existsSync(join(root, 'work3'))).toBe(false)
  }, 60_000)

  it('refuses to render when a source file has gone missing', async () => {
    const clips = await scanned()
    const gone = [{ ...clips[0], path: join(root, 'nowhere.mp4') }]
    const plan = EditPlan.parse({ segments: [{ clipId: gone[0].id, startSec: 0, endSec: 2 }] })
    await expect(renderPlan({ plan, clips: gone, workDir: join(root, 'work4'), outFile: join(root, 'x.mp4'), isCancelled: () => false, onProgress: () => {} })).rejects.toThrow(/moved or deleted/)
  })
})

describe('footage service', () => {
  it('scans a folder end to end, is incremental, and never writes into the source folder', async () => {
    const before = readdirSync(footage, { recursive: true }).length
    const store = new FootageStore(join(root, 'store3'))
    const events: string[] = []
    const svc = new FootageService({ store, provider: () => new MockProvider(), whisperKey: () => '', chatModel: () => undefined, emit: (e) => events.push(`${e.kind}:${e.status}`) })
    const p = store.create('Trip', [footage])
    await svc.scan(p.id)
    let saved = store.read(p.id)!
    expect(saved.clips.filter((c) => c.status === 'ok')).toHaveLength(3)
    expect(saved.clips.filter((c) => c.status === 'unreadable')).toHaveLength(1)
    expect(events).toContain('scan:done')
    const first = saved.clips.find((c) => c.name === 'a-beach.mp4')!
    first.shots[0].description = 'kept'
    store.write(saved)
    await svc.scan(p.id)
    saved = store.read(p.id)!
    expect(saved.clips.find((c) => c.name === 'a-beach.mp4')!.shots[0].description).toBe('kept')
    expect(Object.keys(svc.posters(p.id))).toHaveLength(3)
    // plan offline, render through the service
    const planned = await svc.plan(p.id, { prompt: 'quick reel', shape: '1:1', durationSec: 6, music: { mode: 'none', mood: 'upbeat' } })
    expect(planned.source).toBe('basic')
    expect(planned.thumbs.every((t) => t.startsWith('data:image/jpeg'))).toBe(true)
    const edit = await svc.render(p.id, planned.plan, 'quick reel', () => {})
    expect(existsSync(edit.file)).toBe(true)
    expect(store.read(p.id)!.edits).toHaveLength(1)
    expect(readdirSync(footage, { recursive: true }).length).toBe(before)
    // a file that disappears is flagged, not silently dropped
    rmSync(join(footage, 'sub', 'c-silent.mov'))
    await svc.scan(p.id)
    expect(store.read(p.id)!.clips.find((c) => c.name === 'c-silent.mov')!.status).toBe('missing')
    await expect(svc.understand(p.id)).resolves.toBeUndefined()
    expect(events).toContain('understand:failed')
  }, 240_000)
})
