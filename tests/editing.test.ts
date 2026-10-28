import { describe, it, expect } from 'vitest'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'
import type { VideoSpec } from '../src/shared/spec'
import {
  changeCount,
  duplicateScene,
  estimateDuration,
  headlineOf,
  moveScene,
  narrationOf,
  removeScene,
  setHeadline,
  setNarration,
  setPicturePrompt
} from '../src/renderer/src/editing'

async function base(): Promise<VideoSpec> {
  const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'a snappy tiktok about cats', platform: 'tiktok', styleHint: 'social' })
  spec.narration = spec.scenes.map((s, i) => ({ sceneId: s.id, text: `line number ${i + 1} of the story` }))
  spec.voiceover = spec.scenes.map((s) => ({ sceneId: s.id, key: 'k', file: 'a.mp3', durationSec: 2, speechStartSec: 0, leadSec: 0.2, words: [] }))
  spec.crafts = [
    { sceneId: spec.scenes[0].id, background: 'plate', headline: 'Cats run the web', accentWord: 'Cats', deck: '', hud: { left: '', right: '', chips: [] }, widgets: [], caption: '', keyWord: '', plate: { prompt: 'a cat', camera: 'push', subject: 'center', subjectLabel: 'cat', file: 'p.png', depthFile: 'd.png' } }
  ]
  return spec
}

describe('editor operations', () => {
  it('never mutate the spec they were given', async () => {
    const s = await base()
    const frozen = JSON.stringify(s)
    moveScene(s, 0, 1)
    removeScene(s, s.scenes[0].id)
    setNarration(s, s.scenes[0].id, 'hello there')
    duplicateScene(s, s.scenes[0].id)
    expect(JSON.stringify(s)).toBe(frozen)
  })

  it('reorders scenes and keeps their narration attached by id', async () => {
    const s = await base()
    const first = s.scenes[0].id
    const moved = moveScene(s, 0, s.scenes.length - 1)
    expect(moved.scenes.at(-1)?.id).toBe(first)
    expect(narrationOf(moved, first)).toBe(narrationOf(s, first))
  })

  it('removing a scene drops its narration, craft and voice take, and refits the total', async () => {
    const s = await base()
    const id = s.scenes[0].id
    const r = removeScene(s, id)
    expect(r.scenes.some((x) => x.id === id)).toBe(false)
    expect(narrationOf(r, id)).toBe('')
    expect(r.crafts.some((c) => c.sceneId === id)).toBe(false)
    expect(r.voiceover.some((t) => t.sceneId === id)).toBe(false)
    expect(r.durationSec).toBeCloseTo(r.scenes.reduce((a, x) => a + x.durationSec, 0), 1)
  })

  it('refuses to remove the last scene', async () => {
    let s = await base()
    while (s.scenes.length > 1) s = removeScene(s, s.scenes[0].id)
    expect(removeScene(s, s.scenes[0].id)).toBe(s)
  })

  it('a changed line drops only its own voice take so it is re-voiced', async () => {
    const s = await base()
    const n = setNarration(s, s.scenes[1].id, 'a brand new line')
    expect(n.voiceover.some((t) => t.sceneId === s.scenes[1].id)).toBe(false)
    expect(n.voiceover.length).toBe(s.voiceover.length - 1)
    expect(narrationOf(n, s.scenes[1].id)).toBe('a brand new line')
  })

  it('clearing a line removes the narration entry', async () => {
    const s = await base()
    expect(setNarration(s, s.scenes[0].id, '   ').narration.some((x) => x.sceneId === s.scenes[0].id)).toBe(false)
  })

  it('headline edits go to the director craft when there is one, and fix a stale accent word', async () => {
    const s = await base()
    const id = s.scenes[0].id
    expect(headlineOf(s, s.scenes[0])).toBe('Cats run the web')
    const h = setHeadline(s, id, 'Dogs run the web')
    expect(h.crafts[0].headline).toBe('Dogs run the web')
    expect(h.crafts[0].accentWord).toBe('')
  })

  it('a new picture brief clears the painted file so apply repaints it', async () => {
    const s = await base()
    const p = setPicturePrompt(s, s.scenes[0].id, 'a lion')
    expect(p.crafts[0].plate?.prompt).toBe('a lion')
    expect(p.crafts[0].plate?.file).toBeUndefined()
    expect(p.crafts[0].plate?.depthFile).toBeUndefined()
  })

  it('duplicates a scene with its words and picture under a new id', async () => {
    const s = await base()
    const d = duplicateScene(s, s.scenes[0].id)
    expect(d.scenes.length).toBe(s.scenes.length + 1)
    const copy = d.scenes[1]
    expect(copy.id).not.toBe(s.scenes[0].id)
    expect(narrationOf(d, copy.id)).toBe(narrationOf(s, s.scenes[0].id))
    expect(d.crafts.some((c) => c.sceneId === copy.id)).toBe(true)
  })

  it('counts changes and estimates length', async () => {
    const s = await base()
    expect(changeCount(s, s)).toBe(0)
    expect(changeCount(s, moveScene(s, 0, 1))).toBeGreaterThan(0)
    expect(changeCount(s, setHeadline(s, s.scenes[0].id, 'x'))).toBe(1)
    expect(estimateDuration(s)).toBeCloseTo(s.scenes.reduce((a, x) => a + x.durationSec, 0), 1)
  })
})
