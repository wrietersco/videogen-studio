import { providerOfModel, type Entitlements, type PlanMediaKind } from '@shared/plans'
import type { MediaSettings, Settings } from '../settings'

/**
 * How the user's own settings become the settings a video actually runs with.
 *
 *   plan        signed in, AI through the licence server: the chat model and
 *               every media engine are clamped to what the plan includes
 *   own-keys    the superadmin let this licence use its own provider keys:
 *               the user's settings run unchanged, billed by their provider
 *   programmatic  no AI at all: the mock planner, free stock, the built-in
 *               composer. Unlimited on every plan, and what runs when
 *               nobody is signed in.
 *
 * Pure, so the clamping rules are testable without Electron.
 */

export type AccessMode = 'plan' | 'own-keys' | 'programmatic'

export function accessMode(o: { signedIn: boolean; ent: Entitlements | null; wantsOwnKeys: boolean }): AccessMode {
  if (o.ent?.allowOwnKeys && o.wantsOwnKeys) return 'own-keys'
  if (o.signedIn && o.ent?.aiAllowed) return 'plan'
  return 'programmatic'
}

/** the engines each plan starts on; voices stay on OpenAI so a plan never depends on an optional provider */
function planDefaults(ent: Entitlements): MediaSettings {
  const pick = (kind: PlanMediaKind, prefer: string[], fallback: string): string => prefer.find((m) => ent.models[kind].includes(m)) ?? fallback
  const image = pick('image', ['gpt-image-2.5-flare', 'gemini-3.1-flash-image', 'gemini-nano-banana-2.1'], '')
  const music = pick('music', ['lyria-3.5'], '')
  const video = pick('video', ['gemini-omni-1.1-flash'], '')
  return {
    image: image ? `${providerOf(image)}:${image}` : 'stock',
    voice: ent.models.voice.includes('gpt-4o-mini-tts') ? 'openai:gpt-4o-mini-tts' : ent.models.voice[0] ? `${providerOf(ent.models.voice[0])}:${ent.models.voice[0]}` : 'none',
    music: music ? `gemini:${music}` : 'builtin:procedural',
    video: video && ent.clipsPerVideo > 0 ? `gemini:${video}` : 'stock'
  }
}

export const providerOf = providerOfModel

/** engines that never call a paid model */
const FREE_ENGINE = /^(none|stock|library|builtin(:.*)?)$/

function clampOne(value: string, kind: PlanMediaKind, ent: Entitlements, fallback: string): string {
  if (FREE_ENGINE.test(value)) return kind === 'video' && value !== 'stock' ? fallback : value
  if (value === 'auto' || !value) return fallback
  const model = value.split(':').slice(1).join(':')
  return ent.models[kind].includes(model) && (kind !== 'video' || ent.clipsPerVideo > 0) ? value : fallback
}

export function clampMedia(media: MediaSettings, ent: Entitlements): MediaSettings {
  const d = planDefaults(ent)
  return {
    image: clampOne(media.image, 'image', ent, d.image),
    voice: clampOne(media.voice, 'voice', ent, d.voice),
    music: clampOne(media.music, 'music', ent, d.music),
    video: clampOne(media.video, 'video', ent, d.video)
  }
}

export const PROGRAMMATIC_MEDIA: MediaSettings = { image: 'stock', voice: 'none', music: 'builtin:procedural', video: 'stock' }

/**
 * The settings a programmatic run uses. Always the free planner (mock) — a
 * programmatic video is never counted. With `artistic` (the licence allows
 * own keys and the user runs them), the user's media engines and models stay
 * live so their code model authors bespoke scenes and their image/voice keys
 * make media; without it the run is the plain free engine.
 */
export function programmaticSettings(settings: Settings, artistic: boolean): Settings {
  return artistic
    ? { ...settings, provider: 'mock' }
    : { ...settings, provider: 'mock', autopilot: settings.autopilot, media: { ...PROGRAMMATIC_MEDIA } }
}

/** the settings a run uses under `mode` */
export function effectiveSettings(settings: Settings, mode: AccessMode, ent: Entitlements | null): Settings {
  if (mode === 'own-keys') return settings
  if (mode === 'programmatic' || !ent) return programmaticSettings(settings, false)
  const chosen = settings.models.openai
  const chat = chosen && ent.models.chat.includes(chosen) ? chosen : ent.chatModel
  const painter = clampMedia(settings.media, ent).image
  return {
    ...settings,
    provider: 'openai',
    models: { ...settings.models, openai: chat, ...(painter.startsWith('openai:') ? { 'openai-image': painter.slice(7) } : {}), ...(painter.startsWith('gemini:') ? { 'gemini-image': painter.slice(7) } : {}) },
    media: clampMedia(settings.media, ent)
  }
}
