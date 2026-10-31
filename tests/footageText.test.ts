import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditPlan, planDuration, segmentStarts, type FootageClip } from '../src/shared/footage'
import { assText, buildAss, captionCues, clampToLength } from '../src/main/footage/captions'
import { runFfmpeg } from '../src/main/footage/ffmpeg'
import { sanitizeTitles } from '../src/main/footage/planner'
import { renderPlan } from '../src/main/footage/render'
import { scanClip } from '../src/main/footage/scan'
import { parseSilences, splitAtGaps, tightenPlan } from '../src/main/footage/silence'

let root: string
const ok = async (args: string[]) => {
  const r = await runFfmpeg(['-v', 'error', '-y', ...args])
  if (r.code !== 0) throw new Error(r.stderr)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'footage-text-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const line = (startSec: number, endSec: number, text: string) => ({ startSec, endSec, text })
const clip = (over: Partial<FootageClip> & { id: string }): FootageClip => ({
  path: `C:/v/${over.id}.mp4`, name: `${over.id}.mp4`, folder: 'C:/v', sizeBytes: 1, mtimeMs: 1, durationSec: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, lufs: -23,
  shots: [], watched: true, listened: true, status: 'ok', ...over
})

describe('captions and titles', () => {
  const talky = clip({ id: 't', durationSec: 20, transcript: [line(0, 4, 'one two three four five six seven eight'), line(5, 7, 'nine ten eleven twelve')] })
  const byId = new Map([[talky.id, talky]])

  it('times captions on the finished video, across speed changes and crossfades', () => {
    const plan = EditPlan.parse({
      segments: [
        { clipId: 't', startSec: 0, endSec: 4 },
        { clipId: 't', startSec: 5, endSec: 7, speed: 2, transition: 'fade' }
      ]
    })
    const cues = captionCues(plan, byId)
    expect(cues[0].text).toBe('one two three four five')
    expect(cues[0].startSec).toBeCloseTo(0, 1)
    expect(cues.map((c) => c.text).join(' ')).toBe('one two three four five six seven eight nine ten eleven twelve')
    // the second part overlaps the first by the crossfade, and plays at double speed
    expect(segmentStarts(plan)[1]).toBeCloseTo(3.5, 1)
    expect(cues.at(-1)!.endSec).toBeLessThanOrEqual(planDuration(plan) + 0.01)
    for (let i = 1; i < cues.length; i++) expect(cues[i].startSec).toBeGreaterThanOrEqual(cues[i - 1].endSec - 0.001)
  })

  it('only captions the words inside the kept part, and skips muted parts', () => {
    const plan = EditPlan.parse({ segments: [{ clipId: 't', startSec: 0, endSec: 2 }, { clipId: 't', startSec: 5, endSec: 7, keepAudio: false }] })
    const text = captionCues(plan, byId).map((c) => c.text).join(' ')
    expect(text.startsWith('one two')).toBe(true)
    expect(text).not.toContain('eight')
    expect(text).not.toContain('nine')
  })

  it('writes safe ASS text and clamps items past the end', () => {
    expect(assText('hi {\\b1}there\nfriend')).toBe('hi /b1there\\Nfriend')
    expect(clampToLength([{ startSec: 1, endSec: 9 }, { startSec: 12, endSec: 14 }], 10)).toEqual([{ startSec: 1, endSec: 9 }])
    expect(clampToLength([{ startSec: 8, endSec: 14 }], 10)).toEqual([{ startSec: 8, endSec: 10 }])
    const ass = buildAss({ shape: '9:16', captions: 'bold' }, [{ startSec: 0.5, endSec: 1.5, text: 'hello' }], [{ text: 'Big title', startSec: 0, endSec: 2, position: 'top' }])
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('Dialogue: 0,0:00:00.50,0:00:01.50,Cap,,0,0,0,,{\\fad(80,80)}HELLO')
    expect(ass).toContain('TitleTop')
    expect(buildAss({ shape: '9:16', captions: 'off' }, [{ startSec: 0, endSec: 1, text: 'x' }], [])).not.toContain('Dialogue')
  })

  it('lets the model suggest titles but keeps them few, short and inside the video', () => {
    const raw = [
      { text: '  Summer   2026  ', start: 0.2, end: 3, position: 'bottom' },
      { text: 'overlaps', start: 2, end: 5 },
      { text: 'x'.repeat(200), start: 6, end: 20, position: 'nonsense' },
      { text: 'too late', start: 29.5, end: 31 }
    ]
    const t = sanitizeTitles(raw, 30)
    expect(t.map((x) => x.text)).toEqual(['Summer 2026', 'x'.repeat(60)])
    expect(t[0].position).toBe('bottom')
    expect(t[1].position).toBe('center')
    expect(t[1].endSec - t[1].startSec).toBeLessThanOrEqual(5)
  })

  it('keeps old plans valid: captions off, no titles', () => {
    const p = EditPlan.parse({ segments: [{ clipId: 'a', startSec: 0, endSec: 1 }] })
    expect(p.captions).toBe('off')
    expect(p.titles).toEqual([])
  })
})

describe('silence removal', () => {
  it('splits a part at long pauses, keeping a little quiet around each cut', () => {
    const seg = EditPlan.parse({ segments: [{ clipId: 't', startSec: 10, endSec: 20, transition: 'fade' }] }).segments[0]
    const pieces = splitAtGaps(seg, [{ start: 2, end: 4 }])
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toMatchObject({ startSec: 10, endSec: 12.18, transition: 'fade' })
    expect(pieces[1]).toMatchObject({ startSec: 13.82, endSec: 20, transition: 'cut' })
    // a short gap is left alone; a pause at the very start only trims
    expect(splitAtGaps(seg, [{ start: 3, end: 3.3 }])).toHaveLength(1)
    const trimmed = splitAtGaps(seg, [{ start: 0, end: 1.5 }])
    expect(trimmed).toHaveLength(1)
    expect(trimmed[0].startSec).toBeCloseTo(11.32, 1)
    expect(parseSilences('[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 3.2 | silence_duration: 1.7\n[silencedetect] silence_start: 8', 10)).toEqual([{ start: 1.5, end: 3.2 }, { start: 8, end: 10 }])
  })
})

describe('rendering text over real footage', () => {
  let talk: FootageClip
  const base = () => ({ shape: '9:16' as const, music: { mode: 'none' as const }, loudness: 'off' as const, fadeInOut: false, segments: [{ clipId: talk.id, startSec: 0, endSec: 6 }] })
  const run = (plan: unknown, out: string, wd: string) => renderPlan({ plan: EditPlan.parse(plan), clips: [talk], workDir: join(root, wd), outFile: out, isCancelled: () => false, onProgress: () => {} })
  // the lower part of the frame, where subtitles sit
  const frameAt = async (file: string, at: number) => {
    const r = await runFfmpeg(['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'crop=1080:700:0:1000,format=gray', '-f', 'rawvideo', '-'], { collectStdout: true })
    return r.stdout
  }
  const meanDiff = (a: Buffer, b: Buffer) => {
    let d = 0
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i])
    return d / a.length
  }

  beforeAll(async () => {
    const dir = join(root, 'talk')
    mkdirSync(dir, { recursive: true })
    // 2s tone, 2s of nothing, 2s tone
    await ok(['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=2', '-f', 'lavfi', '-i', 'sine=f=300:d=2',
      '-filter_complex', '[1:a][2:a][3:a]concat=n=3:v=0:a=1[a]', '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', join(dir, 'talk.mp4')])
    talk = await scanClip({ path: join(dir, 'talk.mp4'), folder: dir }, dir)
    talk.transcript = [line(0, 2, 'hello there and welcome'), line(4, 6, 'thanks for watching')]
  }, 120_000)

  it('cuts the silent pause out of a talking part', async () => {
    const tight = await tightenPlan(EditPlan.parse(base()), [talk])
    expect(tight.plan.segments.length).toBe(2)
    expect(tight.removedSec).toBeGreaterThan(1.2)
    expect(planDuration(tight.plan)).toBeLessThan(4.7)
  }, 60_000)

  it('burns captions and titles into the picture', async () => {
    const plain = join(root, 'plain.mp4')
    const texty = join(root, 'texty.mp4')
    await run(base(), plain, 'w-plain')
    const res = await run({ ...base(), captions: 'bold', titles: [{ text: 'Welcome', startSec: 0, endSec: 3, position: 'center' }] }, texty, 'w-texty')
    expect(res.notes).toEqual([])
    const withText = meanDiff(await frameAt(plain, 1), await frameAt(texty, 1))
    expect(withText).toBeGreaterThan(1.5)
    // at 3.6s no caption is showing (the pause), so the two renders agree far more closely
    expect(meanDiff(await frameAt(plain, 3.6), await frameAt(texty, 3.6))).toBeLessThan(withText / 3)
  }, 180_000)

  it('says so when captions are asked for but nothing was transcribed', async () => {
    const quiet = { ...talk, transcript: undefined }
    const res = await renderPlan({
      plan: EditPlan.parse({ shape: '1:1', music: { mode: 'none' }, captions: 'clean', segments: [{ clipId: quiet.id, startSec: 0, endSec: 2 }] }),
      clips: [quiet], workDir: join(root, 'w-quiet'), outFile: join(root, 'quiet.mp4'), isCancelled: () => false, onProgress: () => {}
    })
    expect(res.notes.join(' ')).toMatch(/no captions/i)
  }, 120_000)
})
