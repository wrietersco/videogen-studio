import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseBrief } from '../src/main/story/brief'
import { buildStory, sceneBudget } from '../src/main/story/arcs'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'
import { SceneDirector } from '../src/main/director/director'
import { compose } from '../src/main/composer'
import { varyBackgrounds } from '../src/shared/look'
import { BgStyle, SceneCraft, VideoSpec } from '../src/shared/spec'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = resolve(appRoot, 'vendor')
const fontsDir = resolve(appRoot, 'vendor', 'fonts')

const NORTHPEAK =
  'A 20 second vertical product intro for Northpeak: a smart water bottle that tracks your hydration, paired with a trail map app for weekend hikers. Calm, golden-hour mood. Show the bottle, the trail map screen, and end on the brand.'

const rng = () => {
  let s = 7
  return () => ((s = (s * 16807) % 2147483647) / 2147483647)
}

describe('brief parser', () => {
  it('finds the name, the thing, the audience, what it does, the mood and what to show', () => {
    const b = parseBrief(NORTHPEAK)
    expect(b.subject).toBe('Northpeak')
    expect(b.what).toBe('smart water bottle')
    expect(b.audience).toBe('weekend hikers')
    expect(b.features).toEqual(['tracks your hydration', 'trail map app'])
    expect(b.tone).toBe('calm')
    expect(b.kind).toBe('product')
    expect(b.wants.endOnBrand).toBe(true)
    expect(b.wants.show).toEqual(['bottle', 'the trail map screen'])
    // the durations in the brief are never mistaken for facts
    expect(b.numbers).toEqual([])
  })

  it('reads topics, facts, comparisons, lists and the person\'s own script', () => {
    expect(parseBrief('Explain how coffee is made, calm and cinematic')).toMatchObject({ what: 'how coffee is made', kind: 'explainer', tone: 'calm', features: [] })
    const sleep = parseBrief('Why sleep matters: 8 hours, 3 cycles, 90% of memory work happens at night')
    expect(sleep.kind).toBe('why')
    expect(sleep.what).toBe('Why sleep matters')
    expect(sleep.features).toEqual(['8 hours', '3 cycles', '90% of memory work happens at night'])
    expect(parseBrief('Make a video comparing electric bikes vs scooters for city commuters')).toMatchObject({ kind: 'versus', versus: ['electric bikes', 'scooters'], audience: 'city commuters' })
    expect(parseBrief('Top 5 productivity tips for remote workers')).toMatchObject({ kind: 'list', audience: 'remote workers' })
    const script = parseBrief('Scene 1: Meet Luma, the lamp that wakes you gently\nScene 2: It fades in light\nScene 3: No more jolting alarms\nScene 4: Luma. Wake up softly.')
    expect(script.script).toHaveLength(4)
    expect(script.subject).toBe('Luma')
  })
})

describe('story engine', () => {
  it('writes the product film from the brief\'s own words, in a sensible order', () => {
    const story = buildStory(parseBrief(NORTHPEAK), 20, rng())
    expect(story.map((s) => s.kind)).toEqual(['title', 'statement', 'statement', 'statement', 'cta'])
    const says = story.map((s) => s.say)
    expect(says[0]).toMatch(/^(Meet|Introducing|Say hello to) Northpeak, a smart water bottle\.$/)
    expect(says).toContain('Made for weekend hikers.')
    expect(says).toContain('Northpeak tracks your hydration.')
    expect(says).toContain('Plus a trail map app.')
    expect(says[4]).toMatch(/^Northpeak\. /)
  })

  it('keeps the important scenes when time is short and never invents a number', () => {
    const prompts = [NORTHPEAK, 'Explain how coffee is made, calm and cinematic', 'Hype edit about why retro gaming is back', 'Product intro for a habit tracker app', 'Why sleep matters: 8 hours, 3 cycles, 90% of memory work happens at night', 'Make a video comparing electric bikes vs scooters for city commuters']
    for (const p of prompts) {
      const story = buildStory(parseBrief(p), 20, rng())
      expect(story.length).toBeGreaterThanOrEqual(3)
      expect(story[0].kind === 'title' || story[0].kind === 'statement').toBe(true)
      expect(story[story.length - 1].kind).toBe('cta')
      const given = new Set((p.match(/\d[\d,.]*/g) ?? []).map((n) => n.replace(/[,.]+$/, '')))
      const text = story.map((s) => `${s.say} ${JSON.stringify(s.content)}`).join(' ')
      for (const n of text.match(/\d[\d,.]*/g) ?? []) expect(given.has(n.replace(/[,.]+$/, '')), `invented number ${n} for "${p.slice(0, 40)}"`).toBe(true)
    }
    expect(sceneBudget(20, 'calm')).toBe(5)
    expect(sceneBudget(30, 'hype')).toBeGreaterThan(sceneBudget(30, 'calm'))
  })

  it('turns numbers into counters, and a comparison into a side-by-side', () => {
    const sleep = buildStory(parseBrief('Why sleep matters: 8 hours, 3 cycles, 90% of memory work happens at night'), 30, rng())
    expect(sleep.filter((s) => s.kind === 'stat').map((s) => s.content.value)).toEqual(['8', '3', '90%'])
    const versus = buildStory(parseBrief('Make a video comparing electric bikes vs scooters for city commuters'), 24, rng())
    expect(versus.map((s) => s.kind)).toEqual(['title', 'comparison', 'statement', 'cta'])
  })

  it('uses the person\'s own script as the scenes, word for word', () => {
    const story = buildStory(parseBrief('Scene 1: Meet Luma, the lamp that wakes you gently\nScene 2: It fades in light 30 minutes before your alarm\nScene 3: 94% of testers woke up calmer\nScene 4: Luma. Wake up softly.'), 24, rng())
    expect(story.map((s) => s.kind)).toEqual(['title', 'statement', 'stat', 'cta'])
    expect(story[1].say).toBe('It fades in light 30 minutes before your alarm.')
    expect(story[2].content).toMatchObject({ value: '94%', label: 'Testers woke up calmer' })
  })

  it('plans a whole video through the planner with varied scene types and transitions', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'Why sleep matters: 8 hours, 3 cycles, 90% of memory work happens at night', platform: 'tiktok', durationHintSec: 28 })
    expect(spec.title).toMatch(/^Why Sleep Matters/)
    const t = spec.scenes.map((s) => s.transitionIn)
    for (let i = 2; i < t.length; i++) expect(t[i]).not.toBe(t[i - 1])
    expect(spec.narration.map((n) => n.text).join(' ')).not.toMatch(/Introducing why|closer look at why/i)
  })
})

describe('procedural backgrounds', () => {
  async function directed(prompt = NORTHPEAK): Promise<VideoSpec> {
    const plain = await new Planner(new MockProvider()).plan({ userPrompt: prompt, platform: 'youtube', durationHintSec: 30 })
    const director = new SceneDirector({ provider: new MockProvider(), platesAvailable: false, userPrompt: prompt })
    const design = await director.directFilm(plain)
    const withDesign: VideoSpec = { ...plain, design }
    return { ...withDesign, crafts: await director.directScenes(withDesign, design) }
  }

  it('never repeats a background twice in a row, and gives the same answer every time', async () => {
    const spec = await directed()
    const a = varyBackgrounds(spec).map((c) => c.bgStyle)
    expect(varyBackgrounds(spec).map((c) => c.bgStyle)).toEqual(a)
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1])
    expect(new Set(a).size).toBeGreaterThanOrEqual(3)
    // a full-bleed photo scene keeps its picture, not procedural art
    const cover = { ...spec.crafts[0], media: { refId: 'ref-1', file: 'assets/refs/ref-1.jpg', fit: 'cover' as const, width: 800, height: 600 } }
    expect(varyBackgrounds({ ...spec, crafts: [cover, ...spec.crafts.slice(1)] })[0].bgStyle).toBe('grid')
  })

  it('draws every style as static vector art inside the composition', async () => {
    const spec = await directed()
    for (const style of BgStyle.options.filter((s) => s !== 'grid')) {
      const crafts = spec.crafts.map((c) => SceneCraft.parse({ ...c, bgStyle: style }))
      const out = compose(VideoSpec.parse({ ...spec, crafts }), vendorDir, fontsDir)
      expect(out.html, style).toContain('class="cr-bgart"')
      // static means no filters or animation inside the art
      const art = [...out.html.matchAll(/<svg class="cr-bgart"[\s\S]*?<\/svg>/g)].map((m) => m[0]).join('')
      expect(art, style).not.toMatch(/<animate|filter=|<script/)
      expect(art.length).toBeGreaterThan(400)
    }
    const grid = compose(VideoSpec.parse({ ...spec, crafts: spec.crafts.map((c) => ({ ...c, bgStyle: 'grid' })) }), vendorDir, fontsDir)
    expect(grid.html).not.toContain('class="cr-bgart"')
    expect(grid.html).toContain('class="cr-grid"')
  })
})

describe('scripts pasted on one line', () => {
  it('still reads "Scene 1: ... Scene 2: ..." as the person\'s own scenes', () => {
    const b = parseBrief('Scene 1: Meet Luma, the lamp that wakes you gently Scene 2: It fades in light 30 minutes before your alarm Scene 3: 94% of testers woke up calmer Scene 4: Luma. Wake up softly.')
    expect(b.script).toHaveLength(4)
    expect(b.subject).toBe('Luma')
    expect(b.script[2]).toBe('94% of testers woke up calmer')
  })
})
