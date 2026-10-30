import { describe, it, expect } from 'vitest'
import { normalizeCheckReport, parseCheckOutput } from '../src/main/rendererService/hyperframes'

describe('HyperFrames diagnostics', () => {
  it('surfaces errors from current top-level check sections', () => {
    const pretty = JSON.stringify({ ok: false, contrast: { findings: [{ severity: 'error', message: 'low contrast' }] } }, null, 2)
    expect(parseCheckOutput(`check starting\n${pretty}\nfinished`)?.errors[0].message).toBe('low contrast')
    const report = normalizeCheckReport({ ok: false, contrast: { findings: [{ severity: 'error', message: 'Contrast is too low', selector: '#title', fixHint: 'darken background' }] }, layout: { findings: [{ severity: 'info', message: 'intentional edge' }] } })
    expect(report.ok).toBe(false)
    expect(report.errors.map(e => e.message)).toEqual(['Contrast is too low'])
    expect(report.warnings).toEqual([])
  })
})
import { VideoSpec } from '../src/shared/spec'
import { PLATFORM_PRESETS, PACING_TUNING, listPlatformPresets } from '../src/shared/presets'
import { Planner, videoSpecJsonSchema } from '../src/main/pipeline/planner'
import { applyDeterministicFixes } from '../src/main/pipeline/orchestrator'
import type { CheckReport } from '../src/main/rendererService/hyperframes'
import { MockProvider } from '../src/main/providers/mock'
import { compose } from '../src/main/composer'
import { fitScenes } from '../src/main/audio/voice'
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
    expect(props.customScenes).toBeUndefined()
    expect(props.customVideos).toBeUndefined()
  })
  it('discards engine-owned code and paths even if a provider returns them', async () => {
    const base = await new Planner(new MockProvider()).plan({ userPrompt: 'orbit', platform: 'tiktok' })
    const provider = { id: 'mock' as const, label: 'test', isConfigured: async () => true, listModels: async () => [], generateText: async () => '', generateJSON: async <T,>() => ({ ...base, customScenes: [{ sceneId: base.scenes[0].id, svg: '<script>unsafe</script>' }], customVideos: [{ sceneId: base.scenes[0].id, file: '../../unsafe.mp4', source: 'unsafe' }] }) as T }
    const planned = await new Planner(provider).plan({ userPrompt: 'orbit', platform: 'tiktok' })
    expect(planned.customScenes).toBeUndefined()
    expect(planned.customVideos).toBeUndefined()
  })
})

describe('planner recovery', () => {
  it('repairs an unsupported music mood without another paid call', async () => {
    const prompt = 'Explain how coffee gets from a ripe cherry to a cup. Show the actual steps: harvesting, processing, roasting, grinding and brewing. Make it warm, clear and visually engaging'
    const base = await new Planner(new MockProvider()).plan({ userPrompt: prompt, platform: 'youtube' })
    let calls = 0
    const provider = { id: 'openai' as const, label: 'test', isConfigured: async () => true, listModels: async () => [], generateText: async () => '', generateJSON: async <T,>() => { calls++; return { ...base, musicMood: 'warm and calm' } as T } }
    const result = await new Planner(provider).plan({ userPrompt: prompt, platform: 'youtube' })
    expect(result.musicMood).toBe('minimal')
    expect(calls).toBe(1)
  })
  it('stops after three invalid plans instead of retrying indefinitely', async () => {
    const base = await new Planner(new MockProvider()).plan({ userPrompt: 'coffee', platform: 'youtube' })
    let calls = 0
    const provider = { id: 'openai' as const, label: 'test', isConfigured: async () => true, listModels: async () => [], generateText: async () => '', generateJSON: async <T,>() => { calls++; return { ...base, scenes: [] } as T } }
    await expect(new Planner(provider).plan({ userPrompt: 'coffee', platform: 'youtube' })).rejects.toThrow(/invalid VideoSpec/)
    expect(calls).toBe(3)
  })
  it('asks the same provider to repair an invalid plan and bounds retries', async () => {
    const base = await new Planner(new MockProvider()).plan({ userPrompt: 'coffee', platform: 'youtube' })
    const prompts: string[] = []
    const provider = { id: 'openai' as const, label: 'test', isConfigured: async () => true, listModels: async () => [], generateText: async () => '', generateJSON: async <T,>(req: { prompt: string }) => { prompts.push(req.prompt); return (prompts.length === 1 ? { ...base, scenes: [] } : base) as T } }
    const result = await new Planner(provider).plan({ userPrompt: 'coffee', platform: 'youtube' })
    expect(result.scenes.length).toBeGreaterThan(0)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('previous plan was invalid')
  })
})

describe('planner clamp', () => {
  it('preserves the selected platform and creative style when the planner disagrees', async () => {
    const base = await new Planner(new MockProvider()).plan({ userPrompt: 'space', platform: 'youtube', styleHint: 'motion3d' })
    const provider = { id: 'mock' as const, label: 'test', isConfigured: async () => true, listModels: async () => [], generateText: async () => '', generateJSON: async <T,>() => base as T }
    const planned = await new Planner(provider).plan({ userPrompt: 'orbit', platform: 'tiktok', styleHint: 'explainer' })
    expect(planned.platform).toBe('tiktok')
    expect(planned.style).toBe('explainer')
  })
  it('fits measured narration into the requested duration when it can do so without truncation', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'coffee', platform: 'tiktok', durationHintSec: 15 })
    spec.voiceover = spec.scenes.map((scene, i) => ({ sceneId: scene.id, key: `${i}`, file: `take-${i}.mp3`, durationSec: 2.2, speechStartSec: 0.1, leadSec: 0.1, words: [] }))
    const minimum = spec.scenes.length * 2.45
    const target = Math.max(15, Math.ceil(minimum))
    fitScenes(spec, target)
    expect(spec.durationSec).toBe(target)
    for (const scene of spec.scenes) expect(scene.durationSec).toBeGreaterThanOrEqual(2.45)
  })

  it('preserves spoken audio instead of cutting it when the requested duration is impossible', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'coffee', platform: 'tiktok', durationHintSec: 15 })
    spec.voiceover = spec.scenes.map((scene, i) => ({ sceneId: scene.id, key: `${i}`, file: `take-${i}.mp3`, durationSec: 5, speechStartSec: 0, leadSec: 0.2, words: [] }))
    fitScenes(spec, 15)
    expect(spec.durationSec).toBeGreaterThan(15)
    for (const scene of spec.scenes) expect(scene.durationSec).toBeGreaterThan(5)
  })
  it('asks the selected provider to condense a substantially overlong plan', async () => {
    const mock = new MockProvider()
    const long = await new Planner(mock).plan({ userPrompt: 'coffee', platform: 'tiktok', durationHintSec: 30 })
    const short = await new Planner(mock).plan({ userPrompt: 'coffee', platform: 'tiktok', durationHintSec: 15 })
    let calls = 0
    const provider = {
      id: 'openai' as const, label: 'fake', isConfigured: async () => true, listModels: async () => [], generateText: async () => '',
      generateJSON: async <T,>() => structuredClone(++calls === 1 ? long : short) as T
    }
    const result = await new Planner(provider).plan({ userPrompt: 'coffee', platform: 'tiktok', durationHintSec: 15 })
    expect(calls).toBe(2)
    expect(Math.abs(result.durationSec - 15)).toBeLessThan(Math.abs(long.durationSec - 15))
  })
  it('asks for a tighter plan when the requested duration is exceeded by less than 15 percent', async () => {
    const mock = new MockProvider()
    const short = await new Planner(mock).plan({ userPrompt: 'coffee', platform: 'tiktok', durationHintSec: 15 })
    const long = structuredClone(short)
    long.scenes[0].durationSec += 0.9
    long.durationSec += 0.9
    let calls = 0
    const provider = { id: 'openai' as const, label: 'fake', isConfigured: async () => true, listModels: async () => [], generateText: async () => '', generateJSON: async <T,>() => structuredClone(++calls === 1 ? long : short) as T }
    const result = await new Planner(provider).plan({ userPrompt: 'coffee', platform: 'tiktok', durationHintSec: short.durationSec })
    expect(calls).toBe(2)
    expect(result.durationSec).toBe(short.durationSec)
  })
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
