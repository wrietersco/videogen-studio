import { MEDIA_MODELS } from '../shared/pricing'
import type { MediaSettings, Settings } from './settings'
import { PlatformId, StyleFamily } from '../shared/spec'
import type { LLMProvider } from './providers/types'
import { PLATFORM_PRESETS } from '../shared/presets'

/**
 * "Full autonomous agent": when the user opts in, the app tunes the options it
 * is allowed to touch for each video. Creative decisions use the configured
 * language model, with a rules-based fallback if it is unavailable.
 *
 * Hard limits (enforced in applyAutopilot, not just by convention):
 *  - provider, model ids and API keys are never changed;
 *  - selected media engines are never changed.
 */

export type Look = 'documentary' | 'infographic'

export interface AutopilotInput {
  prompt: string
  durationHintSec?: number
  settings: Settings
  /** a painter exists (image key or stock) so documentary stills are possible */
  imageAvailable: boolean
}

export interface AutopilotDecision {
  look?: Look
  media: Partial<MediaSettings>
  reuse?: Settings['reuse']
  /** plain-language lines shown in the project's activity log */
  reasons: string[]
}

export interface CreativeDecision {
  platform: PlatformId
  styleHint: StyleFamily
  durationHintSec: number
  look: Look
  reason: string
}

/** Decide the Create options using the user's already-selected language model. */
export async function decideCreative(prompt: string, provider: LLMProvider): Promise<CreativeDecision> {
  const fallback = (): CreativeDecision => {
    const platform: PlatformId = /\b(youtube shorts?|shorts)\b/i.test(prompt) ? 'youtube-shorts'
      : /\b(tiktok)\b/i.test(prompt) ? 'tiktok'
      : /\b(reels?)\b/i.test(prompt) ? 'instagram-reels'
      : /\b(instagram (post|feed))\b/i.test(prompt) ? 'instagram-feed'
      : /\bfacebook\b/i.test(prompt) ? 'facebook-feed' : 'youtube'
    const styleHint: StyleFamily = /\b(3d|logo reveal|particles?)\b/i.test(prompt) ? 'motion3d'
      : /\b(hype|meme|viral|punchy)\b/i.test(prompt) ? 'social' : 'explainer'
    const seconds = /\b(\d{1,3})\s*(seconds?|secs?|s)\b/i.exec(prompt)
    const requested = seconds ? Number(seconds[1]) : PLATFORM_PRESETS[platform].defaultDuration
    const [min, max] = PLATFORM_PRESETS[platform].durationRange
    return { platform, styleHint, durationHintSec: Math.max(min, Math.min(max, requested)), look: chooseLook(prompt, true).look, reason: 'format inferred from the prompt' }
  }
  if (provider.id === 'mock') return fallback()
  try {
    const result = await provider.generateJSON<CreativeDecision>({
      system: 'Choose the best video format, style and duration for the user’s brief. Honor explicit platform and duration requests. Choose a suitable platform if unspecified. Look controls visual styling, not the availability of photographs, footage or graphics: explainers often need a rich mix of all three. Honor an explicit all-isometric, no-photos or no-video brief; describe its code-drawn motion graphics without suggesting footage or generated imagery. Explain the choice briefly. Do not choose or change any AI provider or model.',
      prompt,
      schemaName: 'CreativeDecision',
      jsonSchema: { type: 'object', properties: { platform: { type: 'string', enum: PlatformId.options }, styleHint: { type: 'string', enum: StyleFamily.options }, durationHintSec: { type: 'number' }, look: { type: 'string', enum: ['documentary', 'infographic'] }, reason: { type: 'string' } }, required: ['platform', 'styleHint', 'durationHintSec', 'look', 'reason'], additionalProperties: false },
      temperature: 0.2,
      maxTokens: 400
    })
    const platform = PlatformId.parse(result.platform)
    const styleHint = StyleFamily.parse(result.styleHint)
    if (result.look !== 'documentary' && result.look !== 'infographic') throw new Error('invalid look')
    if (!Number.isFinite(result.durationHintSec)) throw new Error('invalid duration')
    const [min, max] = PLATFORM_PRESETS[platform].durationRange
    return { platform, styleHint, look: result.look, durationHintSec: Math.max(min, Math.min(max, Math.round(result.durationHintSec))), reason: String(result.reason).slice(0, 240) }
  } catch {
    return fallback()
  }
}

/**
 * The person chose the video's shape themselves: keep the agent's platform when
 * it already has that shape (e.g. Reels for Tall), otherwise use theirs.
 */
export function honorShape(decision: CreativeDecision, chosen: PlatformId): CreativeDecision {
  if (PLATFORM_PRESETS[decision.platform].aspectLabel === PLATFORM_PRESETS[chosen].aspectLabel) return decision
  const [min, max] = PLATFORM_PRESETS[chosen].durationRange
  return { ...decision, platform: chosen, durationHintSec: Math.max(min, Math.min(max, decision.durationHintSec)), reason: `${decision.reason} Shape ${PLATFORM_PRESETS[chosen].aspectLabel} kept as you chose.`.trim() }
}

const DOC_RE = /\b(histor\w*|documentar\w*|cinematic|film|story|stories|biograph\w*|myster\w*|war|empire|ancient|expedition|astronaut|desert|ocean|jungle|mountain|voyage|disaster|sinking|battle|journey|legend|nature|wildlife|city|landscape|portrait)\b/i
const INFO_RE = /\b(explain\w*|how (does|do|to)|tips?|reasons?|steps?|compar\w+|vs\.?|stats?|percent\w*|data|science|health|money|saving|productivity|tutorial|guide|brain|memory|sleep)\b/i
const MOTION_RE = /\b(walk\w*|run\w*|crash\w*|wave\w*|storm|erupt\w*|surge|surging|flying|fly|drive|driving|chase|explo\w+|flow\w*|spin\w*|cinematic|sunrise|sunset|fire|rain)\b/i

/** Look is an art direction; either look may use photographs and footage. */
export function chooseLook(prompt: string, imageAvailable: boolean): { look: Look; why: string } {
  const doc = (prompt.match(new RegExp(DOC_RE.source, 'gi')) ?? []).length
  const info = (prompt.match(new RegExp(INFO_RE.source, 'gi')) ?? []).length
  if (doc > info && imageAvailable) return { look: 'documentary', why: 'a story/place prompt reads best with painted pictures' }
  if (doc > info) return { look: 'infographic', why: 'looks like a story, but no image engine is set up' }
  return { look: 'infographic', why: 'an explanatory graphic treatment can accompany relevant visual media' }
}

/** 1 (free/cheapest) … 4; unknown ids count as 4 so they are never "stepped up" to */
export function costTier(kind: 'video', value: string): number {
  if (value === 'stock' || value === 'none') return 1
  const [provider, id] = value.split(':')
  const m = MEDIA_MODELS.find((x) => x.kind === kind && x.provider === provider && x.id === id)
  return m ? m.cost : 4
}

export function decide(input: AutopilotInput): AutopilotDecision {
  const { prompt, settings } = input
  const reasons: string[] = []
  const media: Partial<MediaSettings> = {}

  const { look, why } = chooseLook(prompt, input.imageAvailable)
  reasons.push(`look: ${look} — ${why}`)

  // Keep the selected engine intact; the director still decides which scenes need motion.
  if (costTier('video', settings.media.video) > 1) {
    const wantsMotion = MOTION_RE.test(prompt) && look === 'documentary' && (input.durationHintSec ?? 20) >= 12
    if (!wantsMotion) {
      reasons.push('clips: use motion selectively — the idea does not obviously require it')
    } else reasons.push('clips: allowed (budgeted at 1–3 per film) — the idea is about motion')
  }

  let reuse: Settings['reuse'] | undefined
  if (settings.reuse !== 'smart') {
    reuse = 'smart'
    reasons.push('library: reusing matching pictures/clips before paying for new ones')
  }

  return { look, media, reuse, reasons }
}

/**
 * The settings a run uses. Starts from the user's settings and layers the
 * decision on top, then verifies the limits above, throwing if they are broken.
 */
export function applyAutopilot(settings: Settings, d: AutopilotDecision): Settings {
  const out: Settings = {
    ...settings,
    media: { ...settings.media, ...d.media },
    reuse: d.reuse ?? settings.reuse
  }
  if (out.provider !== settings.provider || out.models !== settings.models || out.keys !== settings.keys)
    throw new Error('autopilot may not change the LLM provider, models or keys')
  if (out.media.video !== settings.media.video)
    throw new Error('autopilot may not change the selected video engine or choose a costlier one')
  for (const k of ['image', 'voice', 'music'] as const)
    if (out.media[k] !== settings.media[k]) throw new Error(`autopilot does not change the ${k} engine`)
  return out
}
