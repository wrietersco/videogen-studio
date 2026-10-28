import { describe, it, expect } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'
import { compose } from '../src/main/composer'
import { renderCraftedScene, craftTheme, balancedLines } from '../src/main/composer/crafted'
import { designContext } from '../src/main/composer/layout'
import { validateSelectors } from '../src/main/composer/selectors'
import { SceneDirector, guardCraft, type SceneCraftDraft } from '../src/main/director/director'
import { platePrompt } from '../src/main/director/plates'
import { PLATFORM_PRESETS } from '../src/shared/presets'
import { SceneCraft, type FilmDesign, type VideoSpec, type Widget } from '../src/shared/spec'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = resolve(appRoot, 'vendor')
const fontsDir = resolve(appRoot, 'vendor', 'fonts')

const INFO: FilmDesign = { look: 'infographic', series: 'BRAIN CHEMISTRY · 02', imageStyle: '', accent: '#FFB547', accent2: '#3EE6FF' }
const DOC: FilmDesign = { look: 'documentary', series: 'CASE 04 · THE SOUND', imageStyle: 'painterly, 1880s', accent: '#FF4A2E', accent2: '#3EE6FF' }

const ALL_WIDGETS: Widget[] = [
  { type: 'ringGauge', label: 'Sleep pressure', value: 78, after: 26, afterLabel: 'what you feel' },
  { type: 'counter', label: 'Heard up to', from: 0, to: 4800, unit: 'km', prefix: '' },
  { type: 'bars', label: 'Per serving', unit: 'mg', items: [{ label: 'Espresso', value: 63 }, { label: 'Cold brew', value: 200 }] },
  { type: 'toggle', from: 'Tired', to: 'Alert', label: 'Receptor' },
  { type: 'timeline', items: [{ label: '0:00', text: 'First sip' }, { label: '0:45', text: 'Peak' }] },
  { type: 'quoteCard', text: 'Caffeine borrows energy from later.', attribution: 'Researcher' },
  { type: 'statPair', a: { label: 'Actual', value: '78%' }, b: { label: 'Felt', value: '26%' } },
  { type: 'slots', label: 'Signal', total: 6, filled: 6, blocked: 4, fillLabel: 'Adenosine', blockLabel: 'Caffeine' },
  { type: 'distanceBar', label: 'Heard up to', max: 4800, unit: 'km' },
  { type: 'waveform', label: 'Pressure' }
]

async function plannedSpec(platform: VideoSpec['platform'] = 'tiktok'): Promise<VideoSpec> {
  return new Planner(new MockProvider()).plan({ userPrompt: 'how caffeine tricks your brain', platform, durationHintSec: 30 })
}

function craftFor(sceneId: string, widgets: Widget[], extra: Partial<SceneCraft> = {}): SceneCraft {
  return SceneCraft.parse({ sceneId, headline: 'Caffeine doesn’t give you energy', accentWord: 'energy', caption: 'It plugs the receptors that tell you you are tired.', keyWord: 'tired.', widgets, ...extra })
}

describe('scene director (mock heuristics)', () => {
  it('directs every scene with a valid, deterministic craft', async () => {
    const spec = await plannedSpec()
    const director = new SceneDirector({ provider: new MockProvider(), platesAvailable: false, userPrompt: 'x' })
    const design = await director.directFilm(spec)
    const crafts = await director.directScenes({ ...spec, design }, design)
    expect(crafts.map((c) => c.sceneId)).toEqual(spec.scenes.map((s) => s.id))
    for (const c of crafts) {
      expect(SceneCraft.safeParse(c).success).toBe(true)
      expect(c.background).toBe('grid') // no image model → never plates
    }
    const again = await new SceneDirector({ provider: new MockProvider(), platesAvailable: false, userPrompt: 'x' }).directScenes({ ...spec, design }, design)
    expect(JSON.stringify(again)).toBe(JSON.stringify(crafts))
  })

  it('repairs over-long model output instead of rejecting it', async () => {
    const spec = await plannedSpec()
    const calls: GenerateJSONRequest[] = []
    const sloppy: LLMProvider = {
      id: 'openai',
      label: 'fake',
      isConfigured: async () => true,
      listModels: async () => [],
      generateText: async () => '',
      generateJSON: async <T,>(req: GenerateJSONRequest): Promise<T> => {
        calls.push(req)
        return {
          background: 'plate',
          plate: { prompt: 'a lighthouse in a storm', camera: 'push', subject: 'right', subjectLabel: 'lighthouse' },
          headline: 'This headline is far far far far far far far far far far far far far far far far far far far too long for the screen',
          accentWord: 'nonexistent',
          widgets: [{ type: 'annotation', label: 'Lighthouse' }, { type: 'counter', label: 'Waves', to: 12 }, { type: 'ringGauge', label: 'x', value: 50 }],
          caption: 'short'
        } as T
      }
    }
    const craft = await new SceneDirector({ provider: sloppy, platesAvailable: true, userPrompt: 'x' }).directScene(spec, DOC, 0)
    expect(calls.length).toBe(1)
    expect(craft.headline.length).toBeLessThanOrEqual(90)
    expect(craft.accentWord).toBe('') // not in the headline → dropped
    expect(craft.background).toBe('plate')
    expect(craft.widgets.map((w) => w.type)).toEqual(['annotation', 'counter']) // plate: annotation + one compact
  })
})

describe('craft guards', () => {
  const draft = (widgets: Widget[], background: 'grid' | 'plate' = 'grid'): SceneCraftDraft => ({
    background,
    plate: background === 'plate' ? { prompt: 'p', camera: 'push', subject: 'center', subjectLabel: 's' } : undefined,
    headline: 'Hello world',
    accentWord: 'world',
    deck: '',
    hud: { left: '', right: '', chips: [] },
    widgets,
    caption: '',
    keyWord: ''
  })

  it('drops annotations when there is no picture to annotate', () => {
    const c = guardCraft(draft([{ type: 'annotation', label: 'x' }, { type: 'toggle', from: 'a', to: 'b', label: '' }]), 's1', { platesAvailable: false, narration: 'n' })
    expect(c.widgets.map((w) => w.type)).toEqual(['toggle'])
    expect(c.caption).toBe('n') // falls back to the narration line
  })

  it('downgrades plate scenes to the grid when no image model exists', () => {
    const c = guardCraft(draft([{ type: 'annotation', label: 'x' }], 'plate'), 's1', { platesAvailable: false, narration: '' })
    expect(c.background).toBe('grid')
    expect(c.plate).toBeUndefined()
    expect(c.widgets).toEqual([])
  })

  it('clamps slot counts into a renderable story', () => {
    const c = guardCraft(draft([{ type: 'slots', label: 'x', total: 4, filled: 8, blocked: 8, fillLabel: '', blockLabel: '' }]), 's1', { platesAvailable: false, narration: '' })
    const w = c.widgets[0] as Extract<Widget, { type: 'slots' }>
    expect(w.filled).toBe(4)
    expect(w.blocked).toBe(4)
  })
})

describe('directed composition', () => {
  it('every widget renders with animation steps that all hit real elements', async () => {
    for (const platform of ['tiktok', 'youtube', 'instagram-feed'] as const) {
      const spec = await plannedSpec(platform)
      const ctx = designContext(spec, PLATFORM_PRESETS[platform])
      for (const design of [INFO, DOC]) {
        const th = craftTheme(design)
        for (const w of ALL_WIDGETS) {
          const out = renderCraftedScene({ ...spec, design }, craftFor('scene-1', [w]), 0, 0, 6, ctx, th)
          expect(out.html).toContain('id="scene-1-w0"')
          expect(validateSelectors(out.html, out.steps)).toEqual([])
          for (const s of out.steps) if ('t' in s) expect(s.t).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  it('plate scenes emit the plate engine and pin the annotation to the located subject', async () => {
    const spec = await plannedSpec('tiktok')
    const design = DOC
    const crafts = spec.scenes.map((s, i) =>
      craftFor(s.id, i === 0 ? [{ type: 'annotation', label: 'Source' }, { type: 'distanceBar', label: 'Heard up to', max: 4800, unit: 'km' }] : [], {
        background: i === 0 ? 'plate' : 'grid',
        plate: i === 0 ? { prompt: 'volcano', camera: 'push', subject: 'left', subjectLabel: 'volcano', file: 'assets/plates/scene-1.jpg', depthFile: 'assets/plates/scene-1-depth.png', anchor: { x: 0.25, y: 0.6 } } : undefined
      })
    )
    const result = compose({ ...spec, design, crafts }, vendorDir, fontsDir)
    expect(result.html).toContain('id="scene-1-plate"')
    expect(result.html).toContain('window.__vgWait')
    expect(result.html).toContain('"cx":0.25')
    expect(result.html).toContain('id="scene-1-anno"')
    expect(result.html).not.toContain('class="caption-layer') // directed films caption themselves
    expect(result.assets.some((a) => a.to === 'assets/fonts/BarlowCondensed-ExtraBold.woff2')).toBe(true)
    // deterministic
    expect(compose({ ...spec, design, crafts }, vendorDir, fontsDir).html).toBe(result.html)
  })

  it('a plate craft whose files never arrived renders as a grid scene', async () => {
    const spec = await plannedSpec('tiktok')
    const crafts = spec.scenes.map((s) => craftFor(s.id, [], { background: 'plate', plate: { prompt: 'x', camera: 'push', subject: 'center', subjectLabel: '' } }))
    const html = compose({ ...spec, design: DOC, crafts }, vendorDir, fontsDir).html
    expect(html).not.toContain('-plate"')
    expect(html).not.toContain('window.__vgWait.push')
    expect(html).toContain('class="cr-grid"')
  })

  it('classic specs (no design) are untouched by the directed path', async () => {
    const spec = await plannedSpec('tiktok')
    const html = compose(spec, vendorDir, fontsDir).html
    expect(html).not.toContain('scene crafted')
    expect(html).not.toContain('grain-layer')
  })
})

describe('typesetting + prompts', () => {
  it('balances headline lines instead of greedy-filling them', () => {
    const lines = balancedLines('The loudest sound ever recorded', 3, 700, 60)
    expect(lines.length).toBeGreaterThan(1)
    const lens = lines.map((l) => l.length)
    expect(Math.max(...lens) - Math.min(...lens)).toBeLessThanOrEqual(10)
    expect(lines.join(' ')).toBe('The loudest sound ever recorded')
  })

  it('plate prompts reserve space for text per aspect and forbid lettering', () => {
    const portrait = platePrompt({ prompt: 'A ship at sea', subject: 'left' }, DOC, 1080, 1920)
    const wide = platePrompt({ prompt: 'A ship at sea', subject: 'left' }, DOC, 1920, 1080)
    expect(portrait).toMatch(/top 35%/)
    expect(wide).toMatch(/right third/) // text column is on the left in 16:9
    expect(portrait).toMatch(/No text/)
    expect(portrait).toContain('painterly, 1880s')
  })
})

describe('planner font hygiene', () => {
  it('maps described fonts onto bundled families and keeps real ones', async () => {
    const { bundledFont } = await import('../src/main/pipeline/planner')
    expect(bundledFont('condensed bold sans-serif', 'display')).toBe('Archivo Black, sans-serif')
    expect(bundledFont('clean sans-serif', 'body')).toBe('Inter, sans-serif')
    expect(bundledFont('elegant serif', 'display')).toBe('Playfair Display, serif')
    expect(bundledFont('Space Grotesk, sans-serif', 'display')).toBe('Space Grotesk, sans-serif')
  })
})
