/**
 * Hardcoded price book — shipped with each release, shown in the UI, and
 * used to turn metered usage into real dollars. Rates are USD, read from the
 * providers' official pricing pages on the date below:
 *   platform.claude.com/docs/en/about-claude/pricing
 *   ai.google.dev/gemini-api/docs/pricing (last updated 2026-10-27)
 *   developers.openai.com/api/docs/pricing
 *   elevenlabs.io/pricing/api
 */

export const PRICES_AS_OF = '2026-10-28'

export type MediaKind = 'text' | 'image' | 'voice' | 'music' | 'sfx' | 'video' | 'transcribe'

export interface Rate {
  /** $ per 1M input tokens */
  inTok?: number
  /** $ per 1M output tokens (incl. reasoning/thinking tokens) */
  outTok?: number
  /** $ per generated image (when billed per image) */
  perImage?: number
  /** $ per 1K characters (TTS billed by characters) */
  perKChars?: number
  /** $ per minute of generated or transcribed audio */
  perMinute?: number
  /** $ per second of generated video */
  perSecond?: number
  /** $ per generated song/clip */
  perItem?: number
}

/** model id → rate. Unknown ids cost $0 and are flagged "unpriced" in the receipt. */
export const RATES: Record<string, Rate> = {
  // ---- Anthropic ----
  'claude-fable-5-1': { inTok: 10, outTok: 50 },
  'claude-opus-5-5': { inTok: 4, outTok: 20 },
  'claude-opus-5': { inTok: 5, outTok: 25 },
  'claude-sonnet-5-5': { inTok: 2, outTok: 10 },
  'claude-sonnet-5': { inTok: 2, outTok: 10 },
  'claude-sonnet-4-5': { inTok: 3, outTok: 15 },
  'claude-haiku-5-5': { inTok: 0.1, outTok: 0.5 },
  'claude-haiku-4-5': { inTok: 1, outTok: 5 },
  // ---- OpenAI chat ----
  'gpt-6-astra': { inTok: 10, outTok: 50 },
  'gpt-6.1-sol': { inTok: 2, outTok: 10 },
  'gpt-6-sol': { inTok: 2, outTok: 10 },
  'gpt-6.1-terra': { inTok: 1, outTok: 5 },
  'gpt-6-luna': { inTok: 0.1, outTok: 0.5 },
  'gpt-5.6-sol': { inTok: 4, outTok: 20 },
  'gpt-5.6-terra': { inTok: 2, outTok: 12 },
  'gpt-5.6-luna': { inTok: 0.2, outTok: 1.2 },
  'gpt-5.5': { inTok: 5, outTok: 30 },
  'gpt-4o-mini': { inTok: 0.15, outTok: 0.6 },
  // ---- OpenAI image (image tokens) ----
  'gpt-image-2': { inTok: 8, outTok: 30 },
  'gpt-image-2.5-flare': { inTok: 8, outTok: 30 },
  'gpt-image-2.5-sunburst': { inTok: 8, outTok: 30 },
  'gpt-image-1-mini': { inTok: 2.5, outTok: 8 },
  // ---- OpenAI audio ----
  'gpt-4o-mini-tts': { inTok: 0.6, outTok: 12 },
  'tts-1': { perKChars: 0.015 },
  'tts-1-hd': { perKChars: 0.03 },
  'whisper-1': { perMinute: 0.006 },
  // ---- Gemini text ----
  'gemini-4-argon': { inTok: 2, outTok: 10 },
  'gemini-3.1-pro-preview': { inTok: 2, outTok: 12 },
  'gemini-3.8-flash': { inTok: 0.75, outTok: 3.75 },
  'gemini-3.6-flash': { inTok: 0.75, outTok: 3.75 },
  'gemini-3.5-flash-lite': { inTok: 0.3, outTok: 2.5 },
  'gemini-3.1-flash-lite': { inTok: 0.25, outTok: 1.5 },
  'gemini-2.5-pro': { inTok: 1.25, outTok: 10 },
  'gemini-2.5-flash': { inTok: 0.3, outTok: 2.5 },
  'gemini-2.5-flash-lite': { inTok: 0.1, outTok: 0.4 },
  // ---- Gemini image (per ~1K image) ----
  'gemini-nano-banana-2.1': { perImage: 0.0336 },
  'gemini-3.1-flash-image': { perImage: 0.067 },
  'gemini-3.1-flash-lite-image': { perImage: 0.0336 },
  'gemini-3-pro-image': { perImage: 0.134 },
  // ---- Gemini TTS ----
  'gemini-3.8-flash-tts': { inTok: 0.5, outTok: 9 },
  'gemini-2.5-flash-preview-tts': { inTok: 0.5, outTok: 10 },
  'gemini-2.5-pro-preview-tts': { inTok: 1, outTok: 20 },
  // ---- ElevenLabs ----
  eleven_v3: { perKChars: 0.08 },
  eleven_multilingual_v2: { perKChars: 0.08 },
  eleven_flash_v2_5: { perKChars: 0.04 },
  eleven_turbo_v2_5: { perKChars: 0.04 },
  music_v1: { perMinute: 0.15 },
  eleven_text_to_sound_v2: { perMinute: 0.12 }
}

export interface UsageNumbers {
  inputTokens?: number
  outputTokens?: number
  images?: number
  chars?: number
  seconds?: number
  items?: number
}

/** dollars for one metered call; `priced: false` when the model isn't in the book */
export function priceUsage(model: string, u: UsageNumbers): { usd: number; priced: boolean } {
  const r = RATES[model]
  if (!r) return { usd: 0, priced: false }
  let usd = 0
  if (r.inTok && u.inputTokens) usd += (u.inputTokens / 1e6) * r.inTok
  if (r.outTok && u.outputTokens) usd += (u.outputTokens / 1e6) * r.outTok
  if (r.perImage && u.images) usd += u.images * r.perImage
  if (r.perKChars && u.chars) usd += (u.chars / 1000) * r.perKChars
  if (r.perMinute && u.seconds) usd += (u.seconds / 60) * r.perMinute
  if (r.perSecond && u.seconds) usd += u.seconds * r.perSecond
  if (r.perItem && u.items) usd += u.items * r.perItem
  return { usd, priced: true }
}

// ---------------- media model catalog (Settings → Media models) ----------------

export type ProviderKey = 'openai' | 'anthropic' | 'gemini' | 'elevenlabs' | 'builtin' | 'stock' | 'mock'

export interface MediaModel {
  kind: Exclude<MediaKind, 'text' | 'transcribe'>
  provider: ProviderKey
  id: string
  label: string
  /** rough cost of one typical unit, shown to the user (e.g. "≈ $0.05 / image") */
  typical: string
  /** 1 (cheapest) … 4 (priciest) */
  cost: 1 | 2 | 3 | 4
  /** 1 (slow) … 3 (fast) */
  speed: 1 | 2 | 3
  /** 1 (ok) … 3 (best) */
  quality: 1 | 2 | 3
  note?: string
}

export const MEDIA_MODELS: MediaModel[] = [
  // images
  { kind: 'image', provider: 'stock', id: 'stock', label: 'Free stock photos', typical: 'free', cost: 1, speed: 3, quality: 2, note: 'Openverse + Pexels, licence saved with each photo' },
  { kind: 'image', provider: 'gemini', id: 'gemini-nano-banana-2.1', label: 'Nano Banana 2.1', typical: '≈ $0.03 / image', cost: 1, speed: 3, quality: 2 },
  { kind: 'image', provider: 'gemini', id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image', typical: '≈ $0.07 / image', cost: 2, speed: 3, quality: 2 },
  { kind: 'image', provider: 'gemini', id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image', typical: '≈ $0.13 / image', cost: 3, speed: 2, quality: 3 },
  { kind: 'image', provider: 'openai', id: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', typical: '≈ $0.05–0.19 / image', cost: 3, speed: 3, quality: 3 },
  { kind: 'image', provider: 'openai', id: 'gpt-image-2.5-sunburst', label: 'GPT Image 2.5 Sunburst', typical: '≈ $0.05–0.19 / image', cost: 3, speed: 2, quality: 3, note: 'highest fidelity' },
  // voice
  { kind: 'voice', provider: 'openai', id: 'gpt-4o-mini-tts', label: 'OpenAI mini TTS', typical: '≈ $0.015 / min', cost: 1, speed: 3, quality: 2, note: 'steerable tone, word timings via Whisper' },
  { kind: 'voice', provider: 'gemini', id: 'gemini-2.5-flash-preview-tts', label: 'Gemini Flash TTS', typical: '≈ $0.02 / min', cost: 1, speed: 3, quality: 2 },
  { kind: 'voice', provider: 'elevenlabs', id: 'eleven_flash_v2_5', label: 'ElevenLabs Flash', typical: '≈ $0.04 / 1K chars', cost: 2, speed: 3, quality: 2 },
  { kind: 'voice', provider: 'elevenlabs', id: 'eleven_multilingual_v2', label: 'ElevenLabs Multilingual v2', typical: '≈ $0.08 / 1K chars', cost: 3, speed: 2, quality: 3 },
  { kind: 'voice', provider: 'elevenlabs', id: 'eleven_v3', label: 'ElevenLabs v3', typical: '≈ $0.08 / 1K chars', cost: 3, speed: 2, quality: 3, note: 'most expressive' },
  // music
  { kind: 'music', provider: 'builtin', id: 'procedural', label: 'Built-in composer', typical: 'free', cost: 1, speed: 3, quality: 2, note: 'beat-synced score made on your PC' },
  { kind: 'music', provider: 'elevenlabs', id: 'music_v1', label: 'ElevenLabs Music', typical: '≈ $0.15 / min', cost: 2, speed: 2, quality: 3 },
  // sfx
  { kind: 'sfx', provider: 'builtin', id: 'procedural', label: 'Built-in sound design', typical: 'free', cost: 1, speed: 3, quality: 2 },
  // video
  { kind: 'video', provider: 'stock', id: 'stock', label: 'Free stock clips', typical: 'free', cost: 1, speed: 3, quality: 2, note: 'Pexels videos (free key)' }
]

/** human tags for a model card: 💰 cheap · ⚡ fast · 🏆 best */
export function modelTags(m: Pick<MediaModel, 'cost' | 'speed' | 'quality'>): string[] {
  const t: string[] = []
  if (m.cost === 1) t.push('💰 cheapest')
  else if (m.cost === 4) t.push('💸 premium')
  else if (m.cost === 3) t.push('💵 pricier')
  if (m.speed === 3) t.push('⚡ fast')
  if (m.quality === 3) t.push('🏆 best quality')
  return t
}

/** "$0.0042" style formatting that stays readable for tiny amounts */
export function fmtUsd(v: number): string {
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}
