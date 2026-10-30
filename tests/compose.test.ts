import { describe, it, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'
import { compose } from '../src/main/composer'
import { SceneCraft, VideoSpec } from '../src/shared/spec'
import { TRANSITIONS } from '../src/main/composer/anim'
import { designContext } from '../src/main/composer/layout'
import { PLATFORM_PRESETS } from '../src/shared/presets'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = resolve(appRoot, 'vendor')
const fontsDir = resolve(appRoot, 'vendor', 'fonts')

const CASES: Array<{ style: 'social' | 'explainer' | 'motion3d'; prompt: string; platform: 'tiktok' | 'youtube' | 'instagram-reels' }> = [
  { style: 'social', prompt: 'make a snappy tiktok about why cats rule the internet', platform: 'tiktok' },
  { style: 'explainer', prompt: 'create a product explainer for a habit tracking app', platform: 'youtube' },
  { style: 'motion3d', prompt: 'a cinematic 3d logo sting with particles for a sci-fi game trailer', platform: 'instagram-reels' }
]

async function buildCase(c: (typeof CASES)[number]) {
  const provider = new MockProvider()
  const planner = new Planner(provider)
  const spec = await planner.plan({ userPrompt: c.prompt, platform: c.platform, styleHint: c.style })
  const result = compose(spec, vendorDir, fontsDir)
  return { spec, result }
}

describe('scene transitions', () => {
  it('overlaps incoming and outgoing visuals before a scene boundary', async () => {
    const { spec } = await buildCase(CASES[0])
    const ctx = designContext(spec, PLATFORM_PRESETS[spec.platform])
    for (const name of ['fade', 'slide', 'whip', 'zoom', 'wipe']) {
      const steps = TRANSITIONS[name].build('#old', '#new', 4, ctx)
      const incoming = steps.find(step => 'sel' in step && step.sel === '#new')
      expect(incoming?.t, name).toBeLessThan(4)
    }
  })
})

describe('mock planner', () => {
  it('produces valid, platform-clamped specs for every style family', async () => {
    for (const c of CASES) {
      const { spec } = await buildCase(c)
      expect(spec.style).toBe(c.style)
      expect(spec.platform).toBe(c.platform)
      const preset = { tiktok: [8, 60], youtube: [20, 300], 'instagram-reels': [8, 90] }[c.platform] as [number, number]
      expect(spec.durationSec).toBeGreaterThanOrEqual(preset[0])
      expect(spec.durationSec).toBeLessThanOrEqual(preset[1])
      const sceneSum = spec.scenes.reduce((a, s) => a + s.durationSec, 0)
      expect(Math.abs(sceneSum - spec.durationSec)).toBeLessThan(1.5)
      // determinism: same prompt → same spec
      const spec2 = await new Planner(new MockProvider()).plan({
        userPrompt: c.prompt,
        platform: c.platform,
        styleHint: c.style
      })
      expect(spec2).toEqual(spec)
    }
  })

  it('different prompts yield different specs (genuine dynamism)', async () => {
    const a = await new Planner(new MockProvider()).plan({ userPrompt: 'corporate video about quarterly results', platform: 'youtube' })
    const b = await new Planner(new MockProvider()).plan({ userPrompt: 'hype gaming clip montage', platform: 'tiktok' })
    expect(a.style).not.toEqual(b.style)
    expect(a.palette).not.toEqual(b.palette)
  })
})

describe('composer', () => {
  const specs: Array<{ style: string; spec: VideoSpec; html: string }> = []

  it('preserves planned 3D scenes even when directed crafts exist', async () => {
    const { spec } = await buildCase(CASES[2])
    expect(spec.scenes.some((s) => s.kind === 'showcase3d' || s.kind === 'particles')).toBe(true)
    spec.design = { look: 'infographic', series: 'SPACE', imageStyle: '', accent: '#ff6600', accent2: '#00ccff' }
    spec.crafts = spec.scenes.map((scene) => SceneCraft.parse({ sceneId: scene.id, headline: 'Fallback scene', widgets: [] }))
    const result = compose(spec, vendorDir, fontsDir, { clips: [], captions: [{ startSec: 0, endSec: 1, text: 'A narrated line' }] })
    expect(result.needsThree).toBe(true)
    expect(result.html).toContain('canvas-host')
    expect(result.html).toContain('caption-text')
  })

  it('uses extruded text geometry for supported 3D logos and keeps a readable fallback', async () => {
    const { spec } = await buildCase(CASES[2])
    const scene = spec.scenes.find((s) => s.kind === 'showcase3d')
    if (!scene || scene.kind !== 'showcase3d') throw new Error('Expected a 3D scene')
    scene.objectStyle = 'logoText'
    scene.logoText = 'STARFALL'
    const supported = compose(spec, vendorDir, fontsDir)
    expect(supported.html).toContain('new TextGeometry("STARFALL"')
    expect(supported.html).toContain('type="importmap"')
    expect(supported.assets.some((a) => a.to.endsWith('TextGeometry.js'))).toBe(true)
    scene.logoText = '星'
    const fallback = compose(spec, vendorDir, fontsDir)
    expect(fallback.html).toContain('logo-overlay')
  })

  it('composes every style family', async () => {
    for (const c of CASES) {
      const { spec, result } = await buildCase(c)
      expect(result.html).toContain('data-composition-id="main"')
      expect(result.html).toContain('window.__timelines')
      expect(result.html).not.toContain('undefined')
      expect(result.html).not.toContain('[object Object]')
      specs.push({ style: c.style, spec, html: result.html })
    }
  })

  it('writes hyperframes-runnable projects for external check', async () => {
    const outDir = resolve(appRoot, 'tmp-test', 'compose-probe')
    rmSync(outDir, { recursive: true, force: true })
    for (const { style, spec, html } of specs) {
      const projDir = resolve(outDir, style)
      mkdirSync(resolve(projDir, 'assets', 'vendor'), { recursive: true })
      mkdirSync(resolve(projDir, 'assets', 'fonts'), { recursive: true })
      writeFileSync(resolve(projDir, 'index.html'), html)
      const result = compose(spec, vendorDir, fontsDir)
      for (const a of result.assets) {
        const dest = resolve(projDir, a.to)
        mkdirSync(dirname(dest), { recursive: true })
        cpSync(a.from, dest)
      }
    }
  })
})
