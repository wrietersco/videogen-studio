import { describe, it, expect } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, cpSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'
import { compose } from '../src/main/composer'
import { VideoSpec } from '../src/shared/spec'

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
