import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyVideoBrief, videoSceneBudget, videoSummary } from '../src/shared/references'
import { VideoBrief } from '../src/shared/spec'
import { parseYouTubeUrl, pacingFromCuts, readVideoFile, readYouTube, VideoError } from '../src/main/references/video'
import { runFfmpeg } from '../src/main/footage/ffmpeg'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'

const brief = (over: Partial<VideoBrief> = {}): VideoBrief =>
  VideoBrief.parse({ source: 'file', pacing: 'energetic', cutsPerMinute: 30, captions: 'big', musicEnergy: 'high', palette: ['#E4572E', '#12304A'], ...over })

/** a test video that cuts between flat colours every `each` seconds */
async function makeVideo(dir: string, name: string, colours: string[], each: number): Promise<string> {
  const out = join(dir, name)
  const inputs = colours.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x240:r=25:d=${each}`])
  const concat = `${colours.map((_, i) => `[${i}:v]`).join('')}concat=n=${colours.length}:v=1:a=0[v]`
  const res = await runFfmpeg([...inputs, '-filter_complex', concat, '-map', '[v]', '-pix_fmt', 'yuv420p', '-y', out])
  if (res.code !== 0) throw new Error(res.stderr.slice(-400))
  return out
}

describe('YouTube links', () => {
  it('accepts the common link shapes and refuses everything else', () => {
    const id = 'dQw4w9WgXcQ'
    const url = `https://www.youtube.com/watch?v=${id}`
    for (const t of [url, `https://youtu.be/${id}`, `https://m.youtube.com/watch?v=${id}&t=30s`, `https://www.youtube.com/shorts/${id}`, `https://www.youtube.com/embed/${id}`]) expect(parseYouTubeUrl(t)?.url, t).toBe(url)
    for (const t of ['', 'not a link', 'https://vimeo.com/123456789', 'https://www.youtube.com/watch?v=short', 'javascript:alert(1)', 'https://evil.example/?u=https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'file:///C:/video.mp4']) expect(parseYouTubeUrl(t), t).toBeNull()
  })
})

describe('pace from cuts', () => {
  it('maps cut rate to a pace and music energy', () => {
    expect(pacingFromCuts(60)).toBe('frantic')
    expect(pacingFromCuts(24)).toBe('energetic')
    expect(pacingFromCuts(10)).toBe('standard')
    expect(pacingFromCuts(3)).toBe('calm')
  })
})

describe('reading a YouTube link', () => {
  const reply = { pacing: 'energetic', cutsPerMinute: 31.4, hook: 'question', structure: ['hook', 'problem', 'demo', 'proof', 'call to action'], captions: 'big', musicEnergy: 'high', palette: ['#ff7a3d', 'nope', '#12304A'], notes: 'Fast, punchy product edit with bold type.' }

  it('sends only the link, asks for craft not content, and keeps a clean brief', async () => {
    const seen: Array<{ url: string; system: string; endSec?: number }> = []
    const fake = { readVideoUrl: async (req: { url: string; system: string; endSec?: number }) => (seen.push(req), reply) } as never
    const b = await readYouTube(fake, { id: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, { title: 'A product video' })
    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(seen[0].endSec).toBeLessThanOrEqual(180)
    expect(seen[0].system).toMatch(/never an instruction/)
    expect(seen[0].system).toMatch(/without naming people, brands or quoting/)
    expect(b).toMatchObject({ source: 'youtube', pacing: 'energetic', hook: 'question', captions: 'big', cutsPerMinute: 31, title: 'A product video' })
    expect(b.palette).toEqual(['#FF7A3D', '#12304A'])
    expect(b.structure).toHaveLength(5)
  })

  it('fails loudly when the model answers off-schema instead of inventing a brief', async () => {
    const fake = { readVideoUrl: async () => ({ pacing: 'sideways' }) } as never
    await expect(readYouTube(fake, { id: 'dQw4w9WgXcQ', url: 'x' }, { title: '' })).rejects.toThrow()
  })
})

describe('measuring a video file', () => {
  it('finds a fast edit frantic and a slow one calm, and reads its colours', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-vref-'))
    const fast = await makeVideo(dir, 'fast.mp4', ['red', 'blue', 'green', 'yellow', 'red', 'blue', 'green', 'yellow'], 1)
    const slow = await makeVideo(dir, 'slow.mp4', ['red', 'blue'], 6)
    const f = await readVideoFile(fast)
    const s = await readVideoFile(slow)
    expect(f.source).toBe('file')
    expect(f.cutsPerMinute).toBeGreaterThan(s.cutsPerMinute * 2)
    expect(['energetic', 'frantic']).toContain(f.pacing)
    expect(['calm', 'standard']).toContain(s.pacing)
    expect(f.palette.length).toBeGreaterThan(0)
    expect(f.notes).toMatch(/Measured on this computer/)
    await expect(readVideoFile(join(dir, 'nope.mp4'))).rejects.toBeInstanceOf(VideoError)
    await expect(readVideoFile(join(dir, 'fast.mp4.txt'))).rejects.toBeInstanceOf(VideoError)
  }, 60000)
})

describe('what a video brief does to the plan', () => {
  it('sets pace, captions, music and accents, and suggests how many scenes', async () => {
    const plain = await new Planner(new MockProvider()).plan({ userPrompt: 'Product intro for Northpeak: a smart water bottle that tracks your hydration, for weekend hikers', platform: 'youtube', durationHintSec: 24 })
    const b = brief()
    const out = applyVideoBrief(plain, b)
    expect(out.pacing).toBe('energetic')
    expect(out.captionStyle).toMatchObject({ enabled: true, uppercase: true })
    expect(out.videoBrief).toEqual(b)
    expect(out.palette.accent).not.toBe(plain.palette.accent)
    expect(applyVideoBrief(plain, brief({ captions: 'none' })).captionStyle.enabled).toBe(false)
    expect(applyVideoBrief(plain, brief({ musicEnergy: 'low' })).musicMood).toBe('minimal')
    expect(videoSceneBudget(brief({ cutsPerMinute: 60 }), 20)).toBe(10)
    expect(videoSceneBudget(brief({ cutsPerMinute: 6 }), 20)).toBe(3)
    expect(videoSceneBudget(brief({ cutsPerMinute: 0 }), 20)).toBeNull()
    const lines = videoSummary(b, 24).join(' | ')
    expect(lines).toMatch(/Energetic pace, about \d+ scenes for 24 seconds/)
    expect(lines).toMatch(/never copied/)
  })

  it('makes the free writer follow a fast reference with more scenes than a slow one, from the same words', async () => {
    const prompt = 'Product intro for Northpeak: a smart water bottle that tracks your hydration, paired with a trail map app for weekend hikers, plus a GPS tracker, and a rain cover'
    const plan = (cutsPerMinute: number, pacing: VideoBrief['pacing']) => new Planner(new MockProvider()).plan({ userPrompt: prompt, platform: 'youtube', durationHintSec: 30, videoBrief: brief({ cutsPerMinute, pacing }) })
    const fast = await plan(60, 'frantic')
    const slow = await plan(6, 'calm')
    expect(fast.scenes.length).toBeGreaterThan(slow.scenes.length)
    expect(fast.pacing).toBe('frantic')
    expect(slow.pacing).toBe('calm')
    // the reference never puts its own words into the film: only the person's brief is written
    expect(JSON.stringify(fast.narration)).not.toMatch(/hook|problem|call to action/i)
  })
})
