import { MEDIA_MODELS } from '../shared/pricing'
import type { MediaSettings, Settings } from './settings'

/**
 * "Full autonomous agent": when the user opts in, the app tunes the options it
 * is allowed to touch for each video. Pure rules — no LLM call, so deciding
 * costs nothing.
 *
 * Hard limits (enforced in applyAutopilot, not just by convention):
 *  - provider, model ids and API keys are never changed;
 *  - a media engine is never swapped for a costlier one than the user picked;
 *    the agent may only keep it, or step down to something cheaper.
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

const DOC_RE = /\b(histor\w*|documentar\w*|cinematic|film|story|stories|biograph\w*|myster\w*|war|empire|ancient|expedition|astronaut|desert|ocean|jungle|mountain|voyage|disaster|sinking|battle|journey|legend|nature|wildlife|city|landscape|portrait)\b/i
const INFO_RE = /\b(explain\w*|how (does|do|to)|tips?|reasons?|steps?|compar\w+|vs\.?|stats?|percent\w*|data|science|health|money|saving|productivity|tutorial|guide|brain|memory|sleep)\b/i
const MOTION_RE = /\b(walk\w*|run\w*|crash\w*|wave\w*|storm|erupt\w*|surge|surging|flying|fly|drive|driving|chase|explo\w+|flow\w*|spin\w*|cinematic|sunrise|sunset|fire|rain)\b/i

/** documentary needs imagery; infographic is the safe default for how-it-works content */
export function chooseLook(prompt: string, imageAvailable: boolean): { look: Look; why: string } {
  const doc = (prompt.match(new RegExp(DOC_RE.source, 'gi')) ?? []).length
  const info = (prompt.match(new RegExp(INFO_RE.source, 'gi')) ?? []).length
  if (doc > info && imageAvailable) return { look: 'documentary', why: 'a story/place prompt reads best with painted pictures' }
  if (doc > info) return { look: 'infographic', why: 'looks like a story, but no image engine is set up' }
  return { look: 'infographic', why: 'explanatory content reads best as diagrams' }
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

  // paid moving clips only when the idea is about motion, and never on a very short film
  if (costTier('video', settings.media.video) > 1) {
    const wantsMotion = MOTION_RE.test(prompt) && look === 'documentary' && (input.durationHintSec ?? 20) >= 12
    if (!wantsMotion) {
      media.video = 'stock'
      reasons.push('clips: skipped paid video — nothing in the idea needs real movement')
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
  if (costTier('video', out.media.video) > costTier('video', settings.media.video))
    throw new Error('autopilot may not pick a costlier video engine than the user chose')
  for (const k of ['image', 'voice', 'music'] as const)
    if (out.media[k] !== settings.media[k]) throw new Error(`autopilot does not change the ${k} engine`)
  return out
}
