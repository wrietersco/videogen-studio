import { describe, expect, it } from 'vitest'
import { guardCraft, pickClipScenes, preserveFinishedPlates, sameShot } from '../src/main/director/director'
import type { SceneCraft } from '../shared/spec'

/**
 * The money guard — regression tests for the bug where the vision critic's
 * re-direction silently threw away paid plates and clips: an LLM rewording
 * the same shot failed the exact-prompt match, the finished painting was
 * dropped and repainted (billed twice), and a motion-flag flip deleted a
 * finished Gemini clip from the film entirely.
 */

const craft = (id: string, plate: Partial<NonNullable<SceneCraft['plate']>> = {}): SceneCraft =>
  guardCraft(
    {
      background: 'plate',
      headline: 'x',
      accentWord: '',
      deck: '',
      hud: { left: '', right: '', chips: [] },
      widgets: [],
      caption: 'c',
      keyWord: '',
      plate: { prompt: 'lava', camera: 'push', subject: 'center', subjectLabel: 'lava', motion: false, ...plate }
    },
    id,
    { platesAvailable: true, clipsAvailable: true, narration: '' }
  )

/** a craft as it looks after the plate stage finished: painting + depth + maybe a clip */
const withFiles = (c: SceneCraft, clipFile?: string): SceneCraft => ({
  ...c,
  plate: { ...c.plate!, file: 'assets/plates/x.jpg', depthFile: 'assets/plates/x-depth.png', anchor: { x: 0.5, y: 0.6 }, clipFile }
})

describe('sameShot', () => {
  it('sees through rewording, rejects a different subject', () => {
    expect(sameShot('Lava pouring into the sea at night', 'Night view of lava pouring into the sea')).toBe(true)
    expect(sameShot('Lava pouring into the sea', 'A quiet village under volcanic ash')).toBe(false)
    expect(sameShot('', '')).toBe(false)
  })
})

describe('preserveFinishedPlates (the critic pass)', () => {
  const old = withFiles(craft('s1', { prompt: 'Lava pouring into the sea at night', motion: true }), 'assets/plates/s1.mp4')
  const prev = new Map([['s1', old]])

  it('keeps a reworded plate and its paid clip — motion flag or not', () => {
    const fresh = craft('s1', { prompt: 'Night view of lava pouring into the sea', motion: false })
    const r = preserveFinishedPlates([fresh], prev, 'subject')
    expect(r.crafts[0].plate).toMatchObject({ file: 'assets/plates/x.jpg', clipFile: 'assets/plates/s1.mp4', motion: true })
    expect(r.keptReworded).toBe(1)
    expect(r.droppedPlates).toBe(0)
    // a new subject label re-locates the anchor on the same painting
    const relabel = craft('s1', { prompt: 'Night view of lava pouring into the sea', subjectLabel: 'the flow', motion: true })
    expect(preserveFinishedPlates([relabel], prev, 'subject').crafts[0].plate?.anchor).toBeUndefined()
  })

  it('repaints a genuinely different shot and counts the loss (user feedback path)', () => {
    const fresh = craft('s1', { prompt: 'A quiet village buried in ash', motion: false })
    const r = preserveFinishedPlates([fresh], prev, 'exact')
    expect(r.crafts[0].plate?.file).toBeUndefined()
    expect(r).toMatchObject({ keptReworded: 0, droppedPlates: 1, droppedClips: 1 })
    // and the same reworded shot repaints under 'exact' — the user asked for a change
    const reworded = craft('s1', { prompt: 'Night view of lava pouring into the sea', motion: true })
    expect(preserveFinishedPlates([reworded], prev, 'exact').crafts[0].plate?.file).toBeUndefined()
  })

  it('keeps an identical prompt in both modes without counting a reword', () => {
    const same = craft('s1', { prompt: 'Lava pouring into the sea at night', motion: true })
    for (const mode of ['exact', 'subject'] as const) {
      const r = preserveFinishedPlates([same], prev, mode)
      expect(r.crafts[0].plate?.file).toBe('assets/plates/x.jpg')
      expect(r.keptReworded).toBe(0)
    }
  })

  it('counts a scene the director flipped to grid', () => {
    const grid: SceneCraft = { ...craft('s1'), background: 'grid', plate: undefined }
    expect(preserveFinishedPlates([grid], prev, 'subject')).toMatchObject({ droppedPlates: 1, droppedClips: 1 })
  })
})

describe('pickClipScenes never demotes a paid clip', () => {
  it('keeps an over-budget scene that already holds a clip, demotes the rest as before', () => {
    const a = craft('a', { motion: true }) // opening scene — in budget
    const b = withFiles(craft('b', { motion: true }), 'assets/plates/b.mp4') // over budget, clip already made
    const c = craft('c', { motion: true }) // over budget, nothing made yet
    const out = pickClipScenes([a, b, c], 10) // budget 1
    expect(out.map((x) => x.plate?.motion)).toEqual([true, true, false])
    expect(out[1].plate?.clipFile).toBe('assets/plates/b.mp4')
    expect(out[2].plate?.clipFile).toBeUndefined()
  })
})
