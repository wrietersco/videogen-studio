import { afterAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditPlan, OVERLAY_EFFECTS, type FootageClip, type OverlayEffect, type OverlayPlan } from '../src/shared/footage'
import { buildSegmentGraph, fixesChain, prepareMusicFor } from '../src/main/footage/render'
import { OVERLAY_PARAMS, canRenderOverlays, overlayTemplatesDir, renderOverlayFrames, validateOverlay } from '../src/main/footage/overlays/index'

const clip = (over: Partial<FootageClip> & { id: string }): FootageClip => ({
  path: `C:/v/${over.id}.mp4`, name: `${over.id}.mp4`, folder: 'C:/v', sizeBytes: 1, mtimeMs: 1, durationSec: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, lufs: -23,
  shots: [], watched: true, listened: true, status: 'ok', ...over
})

const overlay = (effect: OverlayEffect, params: Record<string, string | number>, over: Partial<OverlayPlan> = {}): OverlayPlan => ({
  id: '', effect, startSec: 1, endSec: 4, params, why: '', ...over
})

describe('overlay params and validation', () => {
  it('has a schema for every effect', () => {
    for (const effect of OVERLAY_EFFECTS) expect(OVERLAY_PARAMS[effect]).toBeTruthy()
  })

  it('throws a friendly error for each missing required field', () => {
    expect(() => validateOverlay(overlay('lowerThird', {}))).toThrow(/needs a name/)
    expect(() => validateOverlay(overlay('lowerThird', { name: 'Ada', role: '' }))).not.toThrow()
    expect(() => validateOverlay(overlay('refCard', { title: 'Specs' }))).toThrow(/needs a text/)
    expect(() => validateOverlay(overlay('chapterTitle', {}))).toThrow(/needs a text/)
    expect(() => validateOverlay(overlay('quoteBand', { text: '   ' }))).toThrow(/needs a text/)
    expect(() => validateOverlay(overlay('statChip', { label: 'of views' }))).toThrow(/needs a stat/)
    expect(() => validateOverlay(overlay('emotionAccent', {}))).toThrow(/needs an emotion/)
  })

  it('accepts optional fields and keeps finite numbers', () => {
    expect(validateOverlay(overlay('lowerThird', { name: 'Ada' })).params).toEqual({ name: 'Ada' })
    expect(validateOverlay(overlay('lowerThird', { name: 'Ada', role: 'Engineer' })).params).toEqual({ name: 'Ada', role: 'Engineer' })
    expect(validateOverlay(overlay('emotionAccent', { emotion: 'calm' })).params).toEqual({ emotion: 'calm' })
    expect(validateOverlay(overlay('emotionAccent', { emotion: 'joy', color: '#2bd4c4' })).params).toEqual({ emotion: 'joy', color: '#2bd4c4' })
    expect(validateOverlay(overlay('statChip', { stat: 87, label: 'percent' })).params).toEqual({ stat: 87, label: 'percent' })
    expect(() => validateOverlay(overlay('statChip', { stat: Number.POSITIVE_INFINITY, label: 'x' }))).toThrow(/stat/)
    expect(() => validateOverlay(overlay('emotionAccent', { emotion: 'calm', color: 'teal' }))).toThrow(/not valid/)
  })

  it('rejects strings longer than 160 characters', () => {
    expect(() => validateOverlay(overlay('lowerThird', { name: 'x'.repeat(300) }))).toThrow(/name/)
    expect(() => validateOverlay(overlay('quoteBand', { text: 'q'.repeat(161) }))).toThrow(/text/)
    expect(() => validateOverlay(overlay('chapterTitle', { text: 'c'.repeat(160) }))).not.toThrow()
  })

  it('normalizes: trims whitespace, drops unknown keys, keeps the plan intact', () => {
    const plan = overlay('refCard', { title: '  Frame rates  ', text: ' 24 fps ', extra: 'gone' }, { id: 'r1', why: 'because', startSec: 2, endSec: 6 })
    const valid = validateOverlay(plan)
    expect(valid.params).toEqual({ title: 'Frame rates', text: '24 fps' })
    expect(valid.id).toBe('r1')
    expect(valid.why).toBe('because')
    expect(valid.startSec).toBe(2)
    expect(valid.endSec).toBe(6)
  })

  it('refuses an unknown effect', () => {
    expect(() => validateOverlay(overlay('sparkles' as OverlayEffect, {}))).toThrow(/not a known overlay effect/)
  })
})

describe('fixesChain', () => {
  it('is empty for nothing asked', () => {
    expect(fixesChain(undefined)).toBe('')
    expect(fixesChain({})).toBe('')
  })

  it('maps each fix to its filter, exactly', () => {
    expect(fixesChain({ exposure: 1 })).toBe('eq=brightness:0.350')
    expect(fixesChain({ exposure: -1 })).toBe('eq=brightness:-0.350')
    expect(fixesChain({ exposure: 0 })).toBe('eq=brightness:0.000')
    expect(fixesChain({ contrast: 0.5 })).toBe('eq=contrast:1.300')
    expect(fixesChain({ contrast: -0.25 })).toBe('eq=contrast:0.850')
    expect(fixesChain({ warmth: 0.4 })).toBe('colorbalance=rs:0.100:bs:-0.100')
    expect(fixesChain({ warmth: -0.6 })).toBe('colorbalance=rs:-0.150:bs:0.150')
    expect(fixesChain({ stabilize: true })).toBe('deshake=rx=16:ry=16')
    expect(fixesChain({ stabilize: false })).toBe('')
  })

  it('joins every fix in a stable order with no stray commas', () => {
    expect(fixesChain({ stabilize: true, warmth: -1, contrast: 1, exposure: -0.5 })).toBe(
      'eq=brightness:-0.175,eq=contrast:1.600,colorbalance=rs:-0.250:bs:0.250,deshake=rx=16:ry=16'
    )
  })
})

describe('segment graph with overlays and fixes', () => {
  const clips = new Map([['one', clip({ id: 'one' })], ['two', clip({ id: 'two', width: 1080, height: 1920 })]])
  const plan = EditPlan.parse({
    shape: '9:16',
    segments: [
      { clipId: 'one', startSec: 0, endSec: 2 },
      { clipId: 'two', startSec: 0, endSec: 2, transition: 'fade' }
    ]
  })

  it('chains one overlay filter per use, in order, before the final line', () => {
    const graph = buildSegmentGraph(plan, clips, undefined, [
      { inputIndex: 2, startSec: 0.5, endSec: 2 },
      { inputIndex: 3, startSec: 3, endSec: 4.5 }
    ])
    expect(graph.filter).toContain(`[xv1][2:v]overlay=0:0:enable='between(t,0.5,2)'[ov0]`)
    expect(graph.filter).toContain(`[ov0][3:v]overlay=0:0:enable='between(t,3,4.5)'[ov1]`)
    expect(graph.filter).toContain('[ov1]null')
    expect(graph.filter).not.toContain('[xv1]null')
    // the overlay inputs themselves are added by renderPlan, after the segment inputs
    expect(graph.inputs).toHaveLength(12)
    expect(graph.totalSec).toBeCloseTo(3.5, 5)
  })

  it('keeps the plain final line when no overlays are given', () => {
    const graph = buildSegmentGraph(plan, clips)
    expect(graph.filter).toContain('[xv1]null')
    expect(graph.filter).not.toContain('overlay=0:0')
    expect(graph.inputs).toHaveLength(12)
  })

  it('inserts corrective fixes after the fit, before the trim tail (blur and crop paths)', () => {
    const fixed = EditPlan.parse({
      shape: '9:16',
      segments: [{ clipId: 'one', startSec: 0, endSec: 2, fixes: { exposure: 0.5, stabilize: true } }]
    })
    const blur = buildSegmentGraph(fixed, clips)
    expect(blur.filter).toContain('overlay=(W-w)/2:(H-h)/2,eq=brightness:0.175,deshake=rx=16:ry=16,trim=duration=')
    const cropped = buildSegmentGraph(EditPlan.parse({ ...fixed, reframe: 'crop' }), clips)
    expect(cropped.filter).toContain(',crop=1080:1920,eq=brightness:0.175,deshake=rx=16:ry=16,trim=duration=')
    const warm = buildSegmentGraph(EditPlan.parse({ shape: '9:16', reframe: 'crop', segments: [{ clipId: 'one', startSec: 0, endSec: 2, fixes: { warmth: 0.4 } }] }), clips)
    expect(warm.filter).toContain('colorbalance=rs:0.100:bs:-0.100,trim=duration=')
  })
})

describe('music: the lyra branch', () => {
  const root = mkdtempSync(join(tmpdir(), 'footage-lyra-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const work = (name: string) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  const lyraPlan = EditPlan.parse({
    title: 'Reel',
    music: { mode: 'lyra', styleBrief: 'warm analog synth, slow build', mood: 'cinematic' },
    segments: [{ clipId: 'a', startSec: 0, endSec: 2 }]
  })

  it('falls back to the built-in score with a note when the AI track cannot be made', async () => {
    const notes: string[] = []
    const calls: Array<[string, string, number]> = []
    const file = await prepareMusicFor(lyraPlan, 2, work('w1'), notes, async (styleBrief, mood, totalSec) => {
      calls.push([styleBrief, mood, totalSec])
      return null
    })
    expect(calls).toEqual([['warm analog synth, slow build', 'cinematic', 2]])
    expect(file).toBeTruthy()
    expect(existsSync(file!)).toBe(true)
    expect(notes.some((n) => n.includes('built-in score'))).toBe(true)
  })

  it('uses the returned AI track like a user music file', async () => {
    const track = join(root, 'lyra.wav')
    writeFileSync(track, 'audio')
    const notes: string[] = []
    let calls = 0
    const file = await prepareMusicFor(lyraPlan, 2, work('w2'), notes, async () => {
      calls++
      return track
    })
    expect(calls).toBe(1)
    expect(file).toBe(track)
    expect(notes).toEqual([])
  })

  it('falls back with the note when composing throws, and when no composer is wired', async () => {
    const notes: string[] = []
    const file = await prepareMusicFor(lyraPlan, 2, work('w3'), notes, async () => {
      throw new Error('quota')
    })
    expect(file).toBeTruthy()
    expect(notes.some((n) => n.includes('built-in score'))).toBe(true)
    const notes2: string[] = []
    expect(await prepareMusicFor(lyraPlan, 2, work('w4'), notes2)).toBeTruthy()
    expect(notes2.some((n) => n.includes('built-in score'))).toBe(true)
  })

  it('leaves the none and file modes exactly as they were', async () => {
    expect(await prepareMusicFor(EditPlan.parse({ music: { mode: 'none' }, segments: [{ clipId: 'a', startSec: 0, endSec: 1 }] }), 1, work('w5'), [])).toBeNull()
    const own = join(root, 'own.mp3')
    writeFileSync(own, 'x')
    expect(await prepareMusicFor(EditPlan.parse({ music: { mode: 'file', file: own }, segments: [{ clipId: 'a', startSec: 0, endSec: 1 }] }), 1, work('w6'), [])).toBe(own)
  })
})

describe('overlay templates', () => {
  it('ships one self-contained html template per effect', () => {
    const dir = overlayTemplatesDir()
    expect(readdirSync(dir).filter((f) => f.endsWith('.html')).sort()).toEqual([...OVERLAY_EFFECTS].map((e) => `${e}.html`).sort())
    for (const effect of OVERLAY_EFFECTS) {
      const html = readFileSync(join(dir, `${effect}.html`), 'utf8')
      expect(html).toContain('renderAt')
      expect(html).toContain('__params')
    }
  })
})

describe('overlay rendering availability', () => {
  it('reports the sandbox as unavailable outside the desktop app', () => {
    expect(canRenderOverlays()).toBe(false)
  })

  it('fails cleanly when the BrowserWindow sandbox is not importable', async () => {
    await expect(
      renderOverlayFrames({ effect: 'chapterTitle', params: { text: 'One' }, width: 1080, height: 1920, durationSec: 1, outDir: join(tmpdir(), 'no-overlays') })
    ).rejects.toThrow(/desktop app/)
  })
})
