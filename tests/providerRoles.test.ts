import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from '../src/main/providers/registry'
import { DEFAULT_SETTINGS, type Settings } from '../src/main/settings'
import { ALL_ROLES, DEFAULT_ROLES, PROVIDER_CAPABILITIES, enforceExclusive, roleOwners } from '@shared/providerRoles'

/** settings for one test: every provider keyed, so key presence never hides a candidate */
function registryWith(roles: Settings['roles'], keyed: string[] = ['openai', 'anthropic', 'gemini', 'deepseek'], roleMode?: Settings['roleMode']): ProviderRegistry {
  const r = new ProviderRegistry()
  r.reconfigure({ provider: 'gemini', models: {}, roles, ...(roleMode ? { roleMode } : {}) }, Object.fromEntries(keyed.map((k) => [k, 'test-key'])))
  return r
}

describe('provider capability matrix', () => {
  it('defaults to every provider doing everything it can', () => {
    for (const [p, roles] of Object.entries(DEFAULT_ROLES)) expect(roles).toEqual(PROVIDER_CAPABILITIES[p as keyof typeof PROVIDER_CAPABILITIES])
    expect(DEFAULT_SETTINGS.roles).toEqual(DEFAULT_ROLES)
  })

  it('keeps generation out of DeepSeek and planning in every chat provider', () => {
    expect(PROVIDER_CAPABILITIES.deepseek).toEqual(['text', 'code', 'image-process'])
    for (const p of ['openai', 'anthropic', 'gemini', 'deepseek'] as const) expect(PROVIDER_CAPABILITIES[p]).toContain('text')
    expect(ALL_ROLES.length).toBe(8)
  })
})

describe('registry role routing', () => {
  it('asks the brain provider first, then falls through the fixed order', () => {
    const r = registryWith(DEFAULT_ROLES)
    expect(r.forRole('text')?.id).toBe('gemini') // brain pick
    const geminiOff = { ...DEFAULT_ROLES, gemini: ['image-gen'] as (typeof ALL_ROLES)[number][] }
    expect(registryWith(geminiOff).forRole('text')?.id).toBe('openai')
  })

  it('never hands a generation job to a provider without the method', () => {
    const r = registryWith(DEFAULT_ROLES)
    const painter = r.forRole('image-gen')
    expect(painter).not.toBeNull()
    expect(typeof painter!.generateImage).toBe('function')
    const deepseekOnly = { ...DEFAULT_ROLES, openai: ['text'], gemini: ['text'], anthropic: ['text'] } as Settings['roles']
    expect(registryWith(deepseekOnly).forRole('image-gen')).toBeNull() // deepseek cannot paint
  })

  it('skips providers without a key and providers the role is disabled for', () => {
    const openaiOnly = { openai: ['text', 'code'], gemini: ['text'], anthropic: [], deepseek: ['text'] } as Settings['roles']
    const r = registryWith(openaiOnly, ['openai', 'gemini']) // anthropic/deepseek keys missing
    expect(r.forRole('code')?.id).toBe('openai')
    expect(r.forRole('text')?.id).toBe('gemini') // brain first among the enabled+keyed
    const none = { openai: [], gemini: [], anthropic: [], deepseek: [] } as Settings['roles']
    expect(registryWith(none).forRole('text')).toBeNull()
  })

  it('gates out-of-registry services with roleEnabled', () => {
    const r = registryWith(DEFAULT_ROLES)
    expect(r.roleEnabled('gemini', 'video-gen')).toBe(true)
    expect(r.roleEnabled('elevenlabs', 'audio-gen')).toBe(true)
    expect(r.roleEnabled('deepseek', 'video-gen')).toBe(false)
    expect(r.roleEnabled('deepseek', 'image-gen')).toBe(false)
    expect(r.roleEnabled('openai', 'audio-process')).toBe(true)
    const quiet = { ...DEFAULT_ROLES, openai: ['text'] } as Settings['roles']
    expect(registryWith(quiet).roleEnabled('openai', 'audio-process')).toBe(false)
  })

  it('still answers imageProvider() from the enabled painters', () => {
    expect(registryWith(DEFAULT_ROLES).imageProvider()?.id).toBe('gemini') // brain paints
    const geminiNoPaint = { ...DEFAULT_ROLES, gemini: ['text'] } as Settings['roles']
    expect(registryWith(geminiNoPaint).imageProvider()?.id).toBe('openai')
    const noPainters = { ...DEFAULT_ROLES, openai: ['text'], gemini: ['text'] } as Settings['roles']
    expect(registryWith(noPainters).imageProvider()).toBeNull()
  })

  it('defaults to run-in-order and keeps standby candidates', () => {
    expect(DEFAULT_SETTINGS.roleMode).toBe('order')
    expect(registryWith(DEFAULT_ROLES).candidates('code')).toEqual(['gemini', 'openai', 'anthropic', 'deepseek'])
  })

  it('exclusive mode runs the job on exactly one provider', () => {
    expect(registryWith(DEFAULT_ROLES, undefined, 'exclusive').candidates('code')).toEqual(['gemini'])
    const both = { ...DEFAULT_ROLES } as Settings['roles']
    const r = registryWith(both, undefined, 'exclusive')
    expect(r.forRole('text')?.id).toBe('gemini') // brain, not openai-despite-order
    expect(r.forRole('image-gen')?.id).toBe('gemini')
  })

  it('enforceExclusive keeps the first owner per role and drops later ticks', () => {
    const roles = { openai: ['text', 'code'], gemini: ['text', 'code', 'image-gen'], deepseek: ['code'] } as Settings['roles']
    const enforced = enforceExclusive(roles, ['openai', 'gemini', 'deepseek'])
    expect(enforced).toEqual({ openai: ['text', 'code'], gemini: ['image-gen'] })
    const owners = roleOwners(roles, ['gemini', 'openai', 'deepseek'])
    expect(owners.get('text')).toBe('gemini')
    expect(owners.get('code')).toBe('gemini')
    expect(owners.get('image-gen')).toBe('gemini')
  })
})
