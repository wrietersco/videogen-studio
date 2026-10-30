import { describe, expect, it } from 'vitest'
import { applyAutopilot, chooseLook, decide, decideCreative } from '../src/main/autopilot'
import { MockProvider } from '../src/main/providers/mock'
import { DEFAULT_SETTINGS, type Settings } from '../src/main/settings'

const base = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  provider: 'openai',
  models: { openai: 'gpt-6-luna' },
  keys: { openai: 'enc' },
  ...over
})

describe('autopilot', () => {
  it('picks documentary for story prompts when images exist, infographic otherwise', () => {
    expect(chooseLook('a documentary about the sinking of the Titanic', true).look).toBe('documentary')
    expect(chooseLook('a documentary about the sinking of the Titanic', false).look).toBe('infographic')
    expect(chooseLook('explain how sleep affects memory with stats', true).look).toBe('infographic')
  })

  it('skips paid clips when the idea is not about motion, keeps them when it is', () => {
    const s = base({ media: { ...DEFAULT_SETTINGS.media, video: 'gemini:gemini-omni-1.1-flash' } })
    expect(decide({ prompt: 'history of the Roman empire', settings: s, imageAvailable: true }).media.video).toBeUndefined()
    expect(decide({ prompt: 'a cinematic astronaut walking across a desert at sunrise', durationHintSec: 20, settings: s, imageAvailable: true }).media.video).toBeUndefined()
  })

  it('chooses different Create settings from simple and complex briefs without changing models', async () => {
    const mock = new MockProvider()
    expect(await decideCreative('Make a 15 second TikTok hype edit about gaming', mock)).toMatchObject({ platform: 'tiktok', styleHint: 'social', durationHintSec: 15 })
    expect(await decideCreative('A 60 second YouTube 3D logo reveal with particles', mock)).toMatchObject({ platform: 'youtube', styleHint: 'motion3d', durationHintSec: 60 })
    expect(await decideCreative('Explain how coffee is made', mock)).toMatchObject({ platform: 'youtube', styleHint: 'explainer' })
  })

  it('uses the configured provider decision and rejects invalid decisions', async () => {
    const provider = new MockProvider()
    Object.defineProperty(provider, 'id', { value: 'openai' })
    provider.generateJSON = async <T>() => ({ platform: 'instagram-reels', styleHint: 'social', durationHintSec: 22, look: 'documentary', reason: 'A visual teaser' }) as T
    expect(await decideCreative('A product teaser', provider)).toMatchObject({ platform: 'instagram-reels', durationHintSec: 22, look: 'documentary' })
    provider.generateJSON = async <T>() => ({ platform: 'invalid' }) as T
    expect(await decideCreative('A 15 second TikTok hype edit', provider)).toMatchObject({ platform: 'tiktok', durationHintSec: 15 })
  })

  it('never changes provider, models or keys, and never steps up to a costlier engine', () => {
    const s = base()
    const out = applyAutopilot(s, decide({ prompt: 'anything', settings: s, imageAvailable: true }))
    expect(out.provider).toBe(s.provider)
    expect(out.models).toBe(s.models)
    expect(out.keys).toBe(s.keys)
    expect(() => applyAutopilot(s, { media: { video: 'gemini:gemini-omni-1.1-flash' }, reasons: [] })).toThrow(/costlier/)
    expect(() => applyAutopilot(s, { media: { image: 'gemini:gemini-3-pro-image' }, reasons: [] })).toThrow(/image/)
  })

  it('forces smart reuse (cheaper) but leaves quality, GPU and sharing alone', () => {
    const s = base({ reuse: 'fresh', quality: 'delivery', allowGpu: true, sharing: 'shareable' })
    const out = applyAutopilot(s, decide({ prompt: 'x', settings: s, imageAvailable: true }))
    expect(out.reuse).toBe('smart')
    expect([out.quality, out.allowGpu, out.sharing]).toEqual(['delivery', true, 'shareable'])
  })
})
