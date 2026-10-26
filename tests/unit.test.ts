import { describe, it, expect } from 'vitest'
import { VideoSpec } from '../src/shared/spec'
import { PLATFORM_PRESETS, PACING_TUNING, listPlatformPresets } from '../src/shared/presets'
import { Planner, videoSpecJsonSchema } from '../src/main/pipeline/planner'
import { applyDeterministicFixes } from '../src/main/pipeline/orchestrator'
import type { CheckReport } from '../src/main/rendererService/hyperframes'
import { MockProvider } from '../src/main/providers/mock'
import { compose } from '../src/main/composer'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('platform presets', () => {
  it('covers all platforms with valid geometry', () => {
    for (const p of listPlatformPresets()) {
      expect(p.width).toBeGreaterThan(0)
      expect(p.height).toBeGreaterThan(0)
      expect(p.durationRange[0]).toBeLessThan(p.durationRange[1])
      expect(Object.keys(PLATFORM_PRESETS)).toContain(p.id)
    }
    expect(PACING_TUNING.calm.durationScale).toBeGreaterThan(PACING_TUNING.frantic.durationScale)
  })
})

describe('videoSpec JSON schema', () => {
  it('derives a draft-7 schema from the zod spec', () => {
    const schema = videoSpecJsonSchema()
    expect(schema.type).toBe('object')
    const props = schema.properties as Record<string, unknown>
    expect(props.scenes).toBeTruthy()
    expect(props.platform).toBeTruthy()
  })
})

describe('planner clamp', () => {
  it('rescales scenes to the platform duration window', async () => {
    const planner = new Planner(new MockProvider())
    const spec = await planner.plan({ userPrompt: 'a video about teamwork', platform: 'tiktok' })
    expect(spec.durationSec).toBeGreaterThanOrEqual(PLATFORM_PRESETS.tiktok.durationRange[0])
    expect(spec.durationSec).toBeLessThanOrEqual(PLATFORM_PRESETS.tiktok.durationRange[1])
    // readability floors: every scene long enough for its text
    for (const scene of spec.scenes) {
      expect(scene.durationSec).toBeGreaterThanOrEqual(1.0)
    }
  })
})

describe('deterministic QA fixes', () => {
  const baseSpec = {
    schemaVersion: 1 as const,
    title: 'T',
    platform: 'tiktok' as const,
    style: 'social' as const,
    pacing: 'standard' as const,
    durationSec: 30,
    fps: 30 as const,
    palette: { bg: '#202028', surface: '#2a2a38', fg: '#dddddd', muted: '#888', accent: '#7C5CFF', accent2: '#00E5FF' },
    typography: { display: 'Archivo Black, sans-serif', body: 'Inter, sans-serif', capsDisplay: true },
    scenes: [
      {
        id: 'scene-1',
        kind: 'title' as const,
        durationSec: 4,
        transitionIn: 'cut' as const,
        transitionOut: 'cut' as const,
        headline: 'A very long headline that definitely overflows the safe area of the screen'
      }
    ],
    narration: [],
    assetNeeds: [],
    musicMood: 'upbeat' as const,
    captionStyle: { enabled: true, position: 'bottom' as const, uppercase: true }
  }

  it('shortens overflowing headlines', () => {
    const report: CheckReport = { ok: false, errors: [{ message: 'text overflows bounds', selector: '#scene-1-hl' }], warnings: [] }
    const fixed = applyDeterministicFixes(baseSpec, report)
    expect(fixed).not.toBe(baseSpec)
    const scene = fixed.scenes[0] as { headline: string }
    expect(scene.headline.length).toBeLessThan(baseSpec.scenes[0].headline.length)
  })

  it('darkens background on contrast errors', () => {
    const report: CheckReport = { ok: false, errors: [{ message: 'contrast ratio below WCAG AA' }], warnings: [] }
    const fixed = applyDeterministicFixes(baseSpec, report)
    expect(fixed.palette.fg.toLowerCase()).toBe('#ffffff')
  })

  it('returns the same spec when no fix applies (stops the loop)', () => {
    const report: CheckReport = { ok: false, errors: [{ message: 'render worker crashed' }], warnings: [] }
    expect(applyDeterministicFixes(baseSpec, report)).toBe(baseSpec)
  })
})

describe('composer determinism', () => {
  it('produces byte-identical HTML for the same spec', async () => {
    const planner = new Planner(new MockProvider())
    const spec = await planner.plan({ userPrompt: 'byte identical test about bridges', platform: 'youtube' })
    const vendorDir = resolve(appRoot, 'vendor')
    const a = compose(spec, vendorDir, resolve(appRoot, 'vendor/fonts'))
    const b = compose(spec, vendorDir, resolve(appRoot, 'vendor/fonts'))
    expect(b.html).toBe(a.html)
    expect(b.assets).toEqual(a.assets)
  })

  it('rejects structurally invalid specs', () => {
    expect(VideoSpec.safeParse({ nope: true }).success).toBe(false)
  })
})
