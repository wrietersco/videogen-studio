import { describe, expect, it } from 'vitest'
import { applyAutopilot, chooseLook, decide } from '../src/main/autopilot'
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
    expect(decide({ prompt: 'history of the Roman empire', settings: s, imageAvailable: true }).media.video).toBe('stock')
    expect(decide({ prompt: 'a cinematic astronaut walking across a desert at sunrise', durationHintSec: 20, settings: s, imageAvailable: true }).media.video).toBeUndefined()
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
