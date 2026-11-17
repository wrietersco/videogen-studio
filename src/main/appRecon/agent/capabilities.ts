/**
 * PLAN stage, part 2: what can this account use for each job?
 *
 * Pure: settings + access mode + plan entitlements + which keys exist go in,
 * a CapabilityReport comes out. Nothing here reads files, the network or Electron.
 *
 * Availability rules (they mirror license/access.ts):
 *   plan         a model is available when the plan lists it (video also needs clipsPerVideo > 0)
 *   own-keys     a model is available when its provider's key is present
 *   programmatic no AI at all: only the free engine (built-in composer, free stock, no narration)
 *
 * Strengths / limits are written for what matters to a film plan. Anything we
 * have not proven by running it is marked UNVERIFIED in a comment, and phrased
 * cautiously in the text the person sees.
 */
import type { Entitlements } from '@shared/plans'
import { MEDIA_MODELS, type MediaModel } from '@shared/pricing'
import type { CapabilityReport, JobCapability, JobKind, ModelOption } from '@shared/agentBrief'
import type { Settings } from '../../settings'

export type AccessKind = 'plan' | 'own-keys' | 'programmatic'
export type KeyName = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'elevenlabs' | 'pexels' | 'pixabay'

export interface CapabilitySource {
  settings: Pick<Settings, 'provider' | 'models' | 'media' | 'useOwnKeys'>
  access: AccessKind
  /** the plan's entitlements; null when signed out */
  entitlements: Entitlements | null
  /** which provider keys exist (own-keys mode only matters; on a plan the licence server relays) */
  keys: Partial<Record<KeyName, boolean>>
}

/** a model-id → can it sing? (the built-in composer is procedural and cannot) */
export function modelCanSing(id: string): boolean {
  return /^(gemini:lyria|elevenlabs:music)/.test(id)
}

/** 0 = free, else the price book's cost tier (1 cheapest … 4 premium) */
export function costRank(id: string): number {
  if (/^(none|stock|builtin(:.*)?)$/.test(id)) return 0
  const [provider, ...rest] = id.split(':')
  const m = MEDIA_MODELS.find((x) => x.provider === provider && x.id === rest.join(':'))
  return m ? m.cost : 1
}

/** the writer defaults the app uses when Settings do not name a model (index.ts footage.chatModel) */
const WRITER_DEFAULTS: Record<string, string> = { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash', deepseek: 'deepseek-flash' }
const WRITER_LABEL: Record<string, string> = { openai: 'OpenAI', anthropic: 'Claude', gemini: 'Gemini', deepseek: 'DeepSeek' }

const idOf = (m: MediaModel): string => (m.provider === 'stock' ? 'stock' : `${m.provider}:${m.id}`)

// ---- strengths / limits -------------------------------------------------------------------

function strengthsFor(kind: JobKind, m: MediaModel): { strengths: string[]; limits: string[] } {
  if (kind === 'music') {
    if (m.provider === 'builtin') {
      // verified in code: audio/score.ts is a procedural, beat-synced composer with moods only
      return {
        strengths: ['free', 'works offline', 'lines up with the cuts'],
        limits: ['instrumental only: cannot sing or add vocals', 'moods only: cannot play a named style such as Arabic or nasheed']
      }
    }
    if (m.provider === 'gemini') {
      // Verified in code: gemini.music() sends only { model, input: prompt }, so "instrumental" or "vocals"
      // ride entirely in the prompt (the engine's own brief says "no vocals"). UNVERIFIED: how well Lyria
      // sings Arabic or sticks to "vocals and duff only"; Google documents vocals, so we allow it.
      return {
        strengths: ['can make a finished track with singing or wordless vocals when the brief asks', 'follows style words and timed sections', 'cheapest AI option'],
        limits: ['length is a request in the words, not exact', 'cannot promise "no other instruments" (unverified for Arabic)', 'needs a Gemini key on the paid tier']
      }
    }
    // elevenlabs. Verified in code: elevenlabs.music() sends { prompt, music_length_ms, model_id }.
    // UNVERIFIED: vocals quality in Arabic; ElevenLabs documents sung vocals and exact length control.
    return {
      strengths: ['can make a track with vocals when the brief asks', 'exact length (10 s to 5 min)', 'follows detailed style notes'],
      limits: m.id === 'music_v1' ? ['older model: ElevenLabs retires it 31 Jan 2027'] : ['costs more than Lyria', 'needs an ElevenLabs key or a plan that includes it']
    }
  }
  if (kind === 'video') {
    if (m.provider === 'stock') return { strengths: ['free', 'real footage'], limits: ['generic: cannot show your product or a specific idea'] }
    return { strengths: ['animates a picture into a short clip', 'can show a metaphor or a problem scene'], limits: ['a few seconds per clip', 'a few clips per video', 'slow'] }
  }
  if (kind === 'image') {
    if (m.provider === 'stock') return { strengths: ['free', 'real photos with licence saved'], limits: ['generic: cannot draw a specific idea'] }
    return { strengths: ['draws what the scene needs', m.quality === 3 ? 'highest quality' : 'good for most scenes'], limits: m.cost >= 3 ? ['pricier per picture'] : [] }
  }
  if (kind === 'voice') {
    return {
      strengths: [m.provider === 'elevenlabs' ? 'natural voices' : 'clear, steady narration', m.provider === 'openai' ? 'steerable tone' : 'many languages'],
      limits: m.provider === 'elevenlabs' && m.cost >= 3 ? ['pricier per minute'] : []
    }
  }
  return { strengths: [], limits: [] }
}

// ---- availability -------------------------------------------------------------------------

type KindKey = 'image' | 'voice' | 'music' | 'video'

function availability(src: CapabilitySource, kind: KindKey, m: MediaModel): { ok: boolean; reason?: string } {
  const free = m.provider === 'builtin' || m.provider === 'stock'
  const ent = src.entitlements
  if (m.provider === 'stock') {
    if (kind === 'image') return { ok: true } // Openverse needs no key
    return src.keys.pexels || src.keys.pixabay ? { ok: true } : { ok: false, reason: 'needs a free Pexels or Pixabay key in Settings' }
  }
  if (free) return { ok: true }
  if (src.access === 'own-keys') {
    return src.keys[m.provider as KeyName] ? { ok: true } : { ok: false, reason: `needs ${m.provider === 'gemini' ? 'a Gemini' : m.provider === 'elevenlabs' ? 'an ElevenLabs' : 'an OpenAI'} key in Settings` }
  }
  if (src.access === 'programmatic' || !ent) {
    return { ok: false, reason: ent && !ent.aiAllowed && ent.aiBlockedReason ? ent.aiBlockedReason : 'AI is off on this account: sign in, or add your own keys' }
  }
  if (src.access === 'plan') {
    if (!ent.models[kind].includes(m.id)) return { ok: false, reason: `not in the ${ent.label} plan` }
    if (kind === 'video' && ent.clipsPerVideo <= 0) return { ok: false, reason: `the ${ent.label} plan has no AI clips` }
    return { ok: true }
  }
  return { ok: true }
}

function mediaOptions(src: CapabilitySource, kind: KindKey): ModelOption[] {
  const opts = MEDIA_MODELS.filter((m) => m.kind === kind).map((m): ModelOption => {
    const a = availability(src, kind, m)
    const sl = strengthsFor(kind, m)
    return { id: idOf(m), label: m.label, cost: m.typical, available: a.ok, ...(a.reason ? { reason: a.reason } : {}), ...sl }
  })
  if (kind === 'voice') {
    opts.push({ id: 'none', label: 'No narration', cost: 'free', available: true, strengths: ['text on screen only'], limits: ['no spoken explanation'] })
  }
  // free options last so "first available" lists lead with the better choices
  return opts.sort((a, b) => Number(costRank(a.id) === 0) - Number(costRank(b.id) === 0))
}

function textOptions(src: CapabilitySource, job: 'writer' | 'vision'): ModelOption[] {
  // UNVERIFIED which chat models see images best; any chat provider is allowed to try
  const strengths = job === 'writer' ? ['reads your brief and plans the film', 'writes the narration'] : ['looks at pages and film frames to check what was filmed']
  const out: ModelOption[] = []
  const ent = src.entitlements
  if (src.access === 'plan' && ent) {
    for (const model of ent.models.chat) out.push({ id: `openai:${model}`, label: model, cost: 'included in your plan', available: ent.aiAllowed, ...(ent.aiAllowed ? {} : { reason: ent.aiBlockedReason }), strengths, limits: [] })
  } else if (src.access === 'own-keys') {
    for (const p of ['openai', 'anthropic', 'gemini', 'deepseek'] as const) {
      const model = (src.settings.provider === p && src.settings.models[p]) || WRITER_DEFAULTS[p]
      const has = Boolean(src.keys[p])
      out.push({ id: `${p}:${model}`, label: `${WRITER_LABEL[p]} ${model}`, cost: 'billed by your provider', available: has, ...(has ? {} : { reason: `needs a ${WRITER_LABEL[p]} key in Settings` }), strengths, limits: [] })
    }
  }
  out.push({
    id: 'builtin:rules',
    label: job === 'writer' ? 'Built-in rules' : 'No picture checking',
    cost: 'free',
    available: true,
    strengths: ['free', 'always works'],
    limits: job === 'writer' ? ['reads the brief with fixed rules: odd wording may be missed'] : ['cannot check what was filmed']
  })
  return out.sort((a, b) => Number(a.id.startsWith('builtin')) - Number(b.id.startsWith('builtin')))
}

function configuredFor(src: CapabilitySource, job: JobKind): string | undefined {
  const ent = src.entitlements
  if (job === 'writer' || job === 'vision') {
    if (src.access === 'plan' && ent) return `openai:${ent.models.chat.includes(src.settings.models.openai ?? '') ? src.settings.models.openai : ent.chatModel}`
    if (src.access === 'own-keys') {
      const p = src.settings.provider
      if (p in WRITER_DEFAULTS) return `${p}:${src.settings.models[p] || WRITER_DEFAULTS[p]}`
    }
    return 'builtin:rules'
  }
  return src.settings.media[job] || undefined
}

/** read what this account can use for each job */
export function readCapabilities(src: CapabilitySource): CapabilityReport {
  const ent = src.entitlements
  const jobs: JobCapability[] = (['writer', 'voice', 'music', 'video', 'image', 'vision'] as JobKind[]).map((job) => ({
    job,
    configured: configuredFor(src, job),
    options: job === 'writer' || job === 'vision' ? textOptions(src, job) : mediaOptions(src, job)
  }))
  const limits: string[] = []
  if (src.access === 'plan' && ent) {
    limits.push(ent.clipsPerVideo > 0 ? `up to ${ent.clipsPerVideo} AI clip${ent.clipsPerVideo === 1 ? '' : 's'} per video` : 'no AI clips in this plan')
    if (ent.aiVideosPerMonth != null) limits.push(`${ent.aiVideosPerMonth} AI videos a month`)
    limits.push(`longest AI video ${ent.maxVideoSeconds} s`)
  } else if (src.access === 'programmatic') {
    limits.push('free engine only: built-in music, stock pictures, no AI')
  }
  return { access: src.access, ...(ent && src.access === 'plan' ? { planName: ent.label } : {}), jobs, limits }
}

/** a pure mapping from the app's own state (index.ts: settings, mode, planEnt(), keyOf) to a CapabilitySource */
export function capabilitySourceFromApp(a: { settings: Settings; mode: AccessKind; ent: Entitlements | null; hasKey?: (id: KeyName) => boolean }): CapabilitySource {
  const names: KeyName[] = ['openai', 'anthropic', 'gemini', 'deepseek', 'elevenlabs', 'pexels', 'pixabay']
  return {
    settings: { provider: a.settings.provider, models: a.settings.models, media: a.settings.media, useOwnKeys: a.settings.useOwnKeys },
    access: a.mode,
    entitlements: a.ent,
    keys: Object.fromEntries(names.map((k) => [k, a.hasKey ? a.hasKey(k) : Boolean(a.settings.keys[k])]))
  }
}
