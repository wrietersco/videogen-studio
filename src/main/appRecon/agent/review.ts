import type { CheckStatus, ClipSegment, NarrationSegment, PageSegment, Segment, SegmentCheck } from '@shared/agentBrief'

/**
 * REVIEW — did the take, clip or narration do what the segment asked?
 *
 * reviewSegment() is pure logic over the evidence the loop collects; it never
 * touches the browser or a model. reviewSegmentWithVision() first asks an
 * optional vision hook about one or two sampled frames, then calls it.
 */

/** asks a vision model "does this frame show …?"; null = no verdict (no model, or it failed) */
export type VisionHook = (frameFile: string, question: string) => Promise<{ ok: boolean; why: string } | null>

export interface VisionVerdict {
  frame: string
  ok: boolean
  why: string
}

interface EvidenceBase {
  /** the agent did not try this segment: why, in plain words (a blocked host, a missing model, a budget) */
  skippedBecause?: string
  attempts?: number
  /** the narration lines written for the film, for checking that `explain` / `claims` were said */
  lines?: string[]
}

export interface PageEvidence extends EvidenceBase {
  kind: 'page'
  /** the address the recorder was actually on for this segment (last navigation, or the beat's url) */
  reachedUrl?: string
  /** the page's title and first heading as scouted, to check a segment that named its page in words */
  reachedTitle?: string
  /** step ids the planner wrote for the parts to show (ActPlan.planned) */
  planned: Array<{ stepId: string; label: string }>
  /** the recorder's Take.log entries */
  log: Array<{ t: number; step: string; note: string }>
  /** RunResult.repairs: steps dropped because their target was gone */
  repairs?: string[]
  /** a beat of this segment was recorded at all */
  beatsRecorded?: number
  /** vision verdicts on sampled frames, when the hook was used */
  vision?: VisionVerdict[]
}

export interface ClipEvidence extends EvidenceBase {
  kind: 'ai-clip'
  exists: boolean
  seconds?: number
  /** the keyframe review result (does the first/last frame look like the subject) */
  keyframe?: { ok: boolean; why: string } | null
}

export interface NarrationEvidence extends EvidenceBase {
  kind: 'narration'
}

export interface CardEvidence extends EvidenceBase {
  kind: 'card'
  drawn: boolean
}

export type Evidence = PageEvidence | ClipEvidence | NarrationEvidence | CardEvidence

// ------------------------------------------------------------------ helpers

const STOP = new Set(['the', 'and', 'that', 'this', 'with', 'for', 'you', 'your', 'can', 'are', 'from', 'into', 'will', 'have', 'has', 'its', 'about', 'what', 'how', 'when', 'them', 'they', 'then', 'also', 'make', 'sure', 'tell', 'explain', 'mention', 'show'])
const words = (s: string): string[] => s.toLowerCase().normalize('NFKD').match(/[\p{L}\p{N}]{3,}/gu)?.filter((w) => !STOP.has(w)) ?? []
const stem = (w: string): string => w.replace(/(ing|ed|es|s)$/, '')

/** the share (0..1) of a claim's meaningful words found in the best-matching line */
const CTA_CLAIM = /\b(?:cta|call[\s-]+to[\s-]+action)\b/i
const CTA_SAID = /\b(?:try|visit|start|join|sign|explore|discover|learn|begin|click|open|go\s+to|head\s+to|get\s+started|today|now|yourself|waiting|await\w*|ready)\b|https?:\/\/|\.(?:com|app|org|io)\b/i
const CLOSING_CLAIM = /\b(?:conclusion|conclude|concluding|wrap(?:ping)?[\s-]+up|closing|summary|summari[sz]e)\b/i

export function claimCoverage(claim: string, lines: string[]): number {
  // a claim about the KIND of line ("add a call to action", "give a conclusion") is met by the film's closing words, not by matching its words
  if (CTA_CLAIM.test(claim)) return lines.slice(-3).some((l) => CTA_SAID.test(l)) ? 1 : 0
  if (CLOSING_CLAIM.test(claim) && words(claim.replace(CLOSING_CLAIM, ' ')).length <= 2) return lines.length >= 2 ? 1 : 0
  const want = [...new Set(words(claim).map(stem))]
  if (!want.length) return 1
  let best = 0
  for (const line of lines) {
    const have = new Set(words(line).map(stem))
    const hit = want.filter((w) => have.has(w) || [...have].some((h) => h.length > 4 && w.length > 4 && (h.startsWith(w) || w.startsWith(h)))).length
    best = Math.max(best, hit / want.length)
  }
  return best
}
const CLAIM_OK = 0.6

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/+$/, '').toLowerCase() || '/'
  } catch {
    return url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase() || '/'
  }
}

/** did the recording end up on the page the segment named? */
function reachedAsked(seg: PageSegment, ev: PageEvidence): boolean | null {
  if (!ev.reachedUrl) return null
  if (seg.url) return pathOf(seg.url) === pathOf(ev.reachedUrl)
  if (seg.target) {
    const hay = `${ev.reachedUrl} ${ev.reachedTitle ?? ''}`.toLowerCase()
    const want = words(seg.target)
    return want.length > 0 && want.every((w) => hay.includes(w) || hay.includes(stem(w)))
  }
  return true
}

function shownCount(ev: PageEvidence): number {
  const dropped = new Set((ev.repairs ?? []).map((r) => r.split(':')[0]))
  return ev.planned.filter((p) => !dropped.has(p.stepId) && ev.log.some((l) => l.step === p.stepId && !/^could not/i.test(l.note))).length
}

function make(seg: Segment, status: CheckStatus, evidence: string[], note: string, ev: Evidence): SegmentCheck {
  return { segment: seg.id, status, evidence, note, attempts: ev.attempts ?? 1 }
}

// ------------------------------------------------------------------ the review

export function reviewSegment(seg: Segment, ev: Evidence): SegmentCheck {
  if (ev.skippedBecause) return { segment: seg.id, status: 'skipped', evidence: [], note: `Not attempted: ${ev.skippedBecause}`, attempts: ev.attempts ?? 0 }
  if (seg.kind === 'page' && ev.kind === 'page') return reviewPage(seg, ev)
  if (seg.kind === 'ai-clip' && ev.kind === 'ai-clip') return reviewClip(seg, ev)
  if (seg.kind === 'narration') return reviewNarration(seg, ev)
  if (seg.kind === 'card') {
    const drawn = ev.kind === 'card' ? ev.drawn : true
    return make(seg, drawn ? 'done' : 'missed', [], drawn ? 'The card was drawn.' : 'The card was not drawn.', ev)
  }
  return make(seg, 'missed', [], 'Nothing was recorded for this part.', ev)
}

function spoken(seg: Segment, ev: Evidence): { lines: string[]; missing: string[] } | null {
  const claims = seg.explain ?? []
  if (!claims.length || !ev.lines) return null
  return { lines: ev.lines, missing: claims.filter((c) => claimCoverage(c, ev.lines!) < CLAIM_OK) }
}

function reviewPage(seg: PageSegment, ev: PageEvidence): SegmentCheck {
  const proof: string[] = []
  const reached = reachedAsked(seg, ev)
  const ranAnything = (ev.beatsRecorded ?? 0) > 0 || ev.log.length > 0
  if (ev.reachedUrl) proof.push(`reached ${ev.reachedUrl}`)
  if (seg.url) proof.push(`asked for ${seg.url}`)
  else if (seg.target) proof.push(`asked for "${seg.target}"`)

  if (reached === null || !ranAnything) return make(seg, 'missed', proof, 'The recording never got to this page.', ev)
  if (reached === false) {
    const where = ev.reachedUrl ?? 'another page'
    return make(seg, 'substituted', proof, `The film shows ${where} instead of ${seg.url ?? `"${seg.target}"`}.`, ev)
  }

  const total = ev.planned.length
  const shown = shownCount(ev)
  const bad = (ev.vision ?? []).filter((v) => !v.ok)
  const good = (ev.vision ?? []).filter((v) => v.ok)
  if (ev.vision?.length) proof.push(...ev.vision.map((v) => `${v.ok ? 'saw' : 'did not see'} what was asked in ${v.frame}: ${v.why}`))
  if (total) proof.push(`${shown} of ${total} ${seg.how === 'steps' ? 'stages' : seg.how === 'features' ? 'features' : 'sections'} shown`)

  let status: CheckStatus = 'done'
  let note = seg.how === 'glance' || seg.how === 'script' ? 'The page was opened and held.' : `All ${total} planned parts were shown.`
  if (total > 0) {
    const need = seg.how === 'features' ? Math.min(3, total) : total
    if (shown === 0) {
      status = 'partial'
      note = 'The page was opened, but none of its parts were shown.'
    } else if (shown < need) {
      status = 'partial'
      note = `Only ${shown} of ${total} parts were shown.`
    }
  } else if (seg.how === 'tour' || seg.how === 'steps' || seg.how === 'features') {
    status = 'partial'
    note = 'The page was opened, but it had no separate parts to go through, so it was held as a whole.'
  }
  // a vision model that looked and found nothing of what was asked overrides a clean run
  if (status === 'done' && ev.vision?.length && !good.length && bad.length) {
    status = 'partial'
    note = `The page was shown, but the frames did not show what was asked: ${bad[0].why}`
  }
  const talk = spoken(seg, ev)
  if (talk && talk.missing.length) {
    if (status === 'done') status = 'partial'
    note += ` The narration does not say: ${talk.missing.join('; ')}.`
  }
  return make(seg, status, proof, note, ev)
}

function reviewClip(seg: ClipSegment, ev: ClipEvidence): SegmentCheck {
  const proof: string[] = []
  if (!ev.exists) return make(seg, 'missed', proof, 'The clip was not made.', ev)
  if (ev.seconds !== undefined) proof.push(`clip is ${ev.seconds.toFixed(1)}s long`)
  if (ev.keyframe) proof.push(`keyframe check: ${ev.keyframe.ok ? 'matches' : 'does not match'} (${ev.keyframe.why})`)
  if (ev.keyframe && !ev.keyframe.ok) return make(seg, 'partial', proof, `The clip exists but does not look like what was asked: ${ev.keyframe.why}`, ev)
  if (seg.seconds && ev.seconds !== undefined && (ev.seconds < seg.seconds * 0.5 || ev.seconds > seg.seconds * 1.6)) {
    return make(seg, 'partial', proof, `The clip is ${ev.seconds.toFixed(1)}s, but ${seg.seconds}s was asked.`, ev)
  }
  const talk = spoken(seg, ev)
  if (talk && talk.missing.length) return make(seg, 'partial', proof, `The clip is fine, but the narration does not say: ${talk.missing.join('; ')}.`, ev)
  return make(seg, 'done', proof, 'The clip was made and matches.', ev)
}

function reviewNarration(seg: NarrationSegment, ev: Evidence): SegmentCheck {
  const lines = ev.lines ?? []
  const proof = [`${lines.length} narration line${lines.length === 1 ? '' : 's'} checked`]
  if (!seg.claims.length) return make(seg, 'done', proof, 'Nothing specific had to be said.', ev)
  const said = seg.claims.filter((c) => claimCoverage(c, lines) >= CLAIM_OK)
  const missing = seg.claims.filter((c) => !said.includes(c))
  proof.push(...said.map((c) => `said: ${c}`))
  if (!missing.length) return make(seg, 'done', proof, 'Every point is in the narration.', ev)
  if (said.length) return make(seg, 'partial', proof, `The narration does not say: ${missing.join('; ')}.`, ev)
  return make(seg, 'missed', proof, `The narration says none of: ${missing.join('; ')}.`, ev)
}

/** the question put to the vision model about a page segment's frames */
export function visionQuestion(seg: PageSegment): string {
  const what = (seg.lookFor ?? []).length ? seg.lookFor!.join(', ') : (seg.explain ?? []).join('; ') || seg.target || seg.url || 'the page'
  return `Does this frame show ${what}? Answer yes or no and say what you see.`
}

/**
 * Asks `vision` about up to two of the sampled frames (first and last), adds the
 * verdicts to the evidence, and reviews. A segment with nothing specific to
 * look for is not sent to the model.
 */
export async function reviewSegmentWithVision(seg: Segment, ev: Evidence, frames: string[], vision?: VisionHook): Promise<SegmentCheck> {
  if (seg.kind !== 'page' || ev.kind !== 'page' || !vision || !frames.length || ev.skippedBecause) return reviewSegment(seg, ev)
  if (!(seg.lookFor?.length || seg.explain?.length)) return reviewSegment(seg, ev)
  const picks = frames.length > 1 ? [frames[0], frames[frames.length - 1]] : frames
  const verdicts: VisionVerdict[] = []
  for (const f of picks) {
    const v = await vision(f, visionQuestion(seg)).catch(() => null)
    if (v) verdicts.push({ frame: f, ok: v.ok, why: v.why })
  }
  return reviewSegment(seg, { ...ev, vision: [...(ev.vision ?? []), ...verdicts] })
}

// ------------------------------------------------------------------ iterate

export type Move = 'accept' | 'retry' | 'substitute' | 'ask'
export const MAX_ATTEMPTS = 2

/**
 * What the loop does next. Done and skipped are final. Anything else is tried
 * again until MAX_ATTEMPTS; after that a required segment goes to the person,
 * and an optional one is replaced (missed) or taken as it is (partial /
 * substituted), always with the note kept for the report.
 */
export function nextMove(check: SegmentCheck, attempts: number, required = true): Move {
  if (check.status === 'done' || check.status === 'skipped') return 'accept'
  if (attempts < MAX_ATTEMPTS) return 'retry'
  if (required) return 'ask'
  return check.status === 'missed' ? 'substitute' : 'accept'
}
