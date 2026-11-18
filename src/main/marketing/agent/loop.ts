import type { LLMProvider } from '../../providers/types'
import type { CapabilityReport, DecisionAnswer, DecisionRequest, JobAssignment, SegmentCheck } from '@shared/agentBrief'
import type { MadePart, MarketBriefInput, MarketPariEvent, MarketPlan, MarketReport } from '@shared/marketBrief'
import { applyAnswers, autopilotAnswers, decisionsFor } from '../../appRecon/agent/decide'
import { coverage, avoidHit } from '../film'
import { readMarketBrief, toFilmPlan } from './brief'

/**
 * PLAN, REVIEW and the report of "Market my business".
 *
 *   planStage()    read the brief into a plan, show it, work out which model does which job, ask the person
 *                  (or take the best option on autopilot), and settle the assignment
 *   reviewFilm()   after the film: did each part say what it was asked to, in the way it was asked? what was replaced?
 *   buildReport()  the plain list of what was done and what was not
 *
 * The retry and substitute steps of ACT/ITERATE live where the work is done (film.ts): a line that drifts from what
 * the person asked is replaced before any voice is paid for, a clip that fails is tried once more and then drawn as
 * an animated card, and every such step is recorded for this review.
 */

export type MarketEmit = (e: DistributiveOmit<MarketPariEvent, 'businessId' | 'runId'>) => void
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export interface MarketPariHooks {
  mode: 'ask' | 'autopilot'
  capabilities: CapabilityReport
  /** shows the requests to the person and waits; null = they stopped the run */
  decide: (requests: DecisionRequest[]) => Promise<DecisionAnswer[] | null>
  emit: MarketEmit
}

export class MarketStopped extends Error {}

export interface MarketPlanOutcome {
  plan: MarketPlan
  assignment: JobAssignment
  answers: DecisionAnswer[]
  notes: string[]
}

/** answers for these requests: the person's in 'ask' mode, the autopicks on autopilot (always shown) */
async function settle(requests: DecisionRequest[], hooks: MarketPariHooks): Promise<DecisionAnswer[]> {
  if (!requests.length) return []
  hooks.emit({ kind: 'pari-decide', requests, auto: hooks.mode === 'autopilot' })
  if (hooks.mode === 'autopilot') return autopilotAnswers(requests)
  const answers = await hooks.decide(requests)
  if (!answers) throw new MarketStopped('You stopped the video before anything was made.')
  return answers
}

export async function planStage(input: MarketBriefInput, deps: { chat: LLMProvider | null; say: (m: string) => void; business: string }, hooks: MarketPariHooks): Promise<MarketPlanOutcome> {
  const plan = await readMarketBrief(input, { chat: deps.chat, say: deps.say })
  hooks.emit({ kind: 'pari-plan', plan, capabilities: hooks.capabilities })
  deps.say(`Plan (${plan.source === 'ai' ? 'read by the AI writer' : plan.source === 'rules' ? 'read by rules' : "from the card's own words"}): ${plan.points.length} point${plan.points.length === 1 ? '' : 's'}${plan.targetSec ? `, about ${plan.targetSec}s` : ''}`)
  if (plan.unplaced.length) deps.say(`Could not place: ${plan.unplaced.map((u) => `"${u}"`).join('; ')}`)
  const d = decisionsFor(toFilmPlan(plan, deps.business), hooks.capabilities)
  const answers = await settle(d.requests, hooks)
  const applied = applyAnswers(d.requests, answers, d.assignment)
  for (const n of applied.notes) deps.say(n)
  if (applied.stop) throw new MarketStopped('You chose to stop and reword the brief, so nothing was made.')
  return { plan, assignment: applied.assignment, answers, notes: applied.notes }
}

// ------------------------------------------------------------------ review

export interface ReviewFacts {
  made: MadePart[]
  dropped: string[]
  durationSec: number
  musicSource: 'ai' | 'builtin' | 'none'
  voiced: boolean
  /** the AI writer wrote the script */
  written: boolean
  /** why AI music could not be used, if it was tried */
  musicError?: string
}

const SHOW_WORD: Record<string, string> = { clip: 'an AI video clip', image: 'an AI picture', scene: 'an animated card' }
const MADE_WORD: Record<string, string> = { clip: 'an AI video clip', image: 'an AI picture', scene: 'an animated card' }

/** one part: was it made the way it was asked, and does what is said carry what was asked? */
function checkPart(label: string, id: string, say: string | null, wanted: string, m: MadePart | undefined, strict: boolean): SegmentCheck {
  if (!m) return { segment: id, status: 'skipped', evidence: [], note: `${label} was left out.`, attempts: 0 }
  const evidence = [`shown as ${MADE_WORD[m.made]}`, `said: "${m.line.slice(0, 80)}${m.line.length > 80 ? '…' : ''}"`]
  const asked = wanted === 'any' || wanted === 'close' ? null : wanted
  const sameKind = !asked || asked === 'scene' || m.made === asked
  const carried = !say || !strict || coverage(say, m.line) >= 0.4
  if (!sameKind) return { segment: id, status: 'substituted', evidence, note: `${label}: you asked for ${SHOW_WORD[asked!]}, but ${m.fellBack ?? 'it could not be made'}, so it is ${MADE_WORD[m.made]} instead.`, attempts: m.attempts }
  if (!carried) return { segment: id, status: 'partial', evidence, note: `${label}: the spoken line may not carry all of "${say!.slice(0, 80)}".`, attempts: m.attempts }
  return { segment: id, status: 'done', evidence, note: asked ? `${label}: made as ${MADE_WORD[m.made]}, as asked.` : `${label} is in the film.`, attempts: m.attempts }
}

export function reviewFilm(plan: MarketPlan, f: ReviewFacts): { checks: SegmentCheck[]; shortfalls: string[] } {
  const checks: SegmentCheck[] = []
  const byId = new Map(f.made.map((m) => [m.id, m]))
  checks.push(checkPart('The problem', 'problem', plan.problem.said ? plan.problem.say : null, plan.problem.show, byId.get('problem'), true))
  plan.points.forEach((pt, i) => {
    if (f.dropped.includes(pt.id)) {
      checks.push({ segment: pt.id, status: 'skipped', evidence: [], note: `Point ${i + 1} ("${pt.say.slice(0, 60)}") was left out to keep the film near ${plan.targetSec ?? 'its'}s.`, attempts: 0 })
      return
    }
    checks.push(checkPart(`Point ${i + 1}`, pt.id, pt.said ? pt.say : null, pt.show, byId.get(pt.id), true))
  })
  const close = byId.get('close')
  const closeOk = !!close && (coverage(plan.close.cta, close.line) >= 0.5 || close.line.toLowerCase().includes(plan.close.cta.toLowerCase().slice(0, 12)))
  checks.push(close ? { segment: 'close', status: closeOk ? 'done' : 'partial', evidence: [`said: "${close.line.slice(0, 80)}"`], note: closeOk ? `The film ends on "${plan.close.cta}".` : `The closing line may not carry "${plan.close.cta}".`, attempts: 1 } : { segment: 'close', status: 'skipped', evidence: [], note: 'The closing card was left out.', attempts: 0 })

  // what the person said not to mention
  if (plan.avoid.length) {
    const hit = f.made.map((m) => avoidHit(m.line, plan.avoid)).find(Boolean)
    checks.push(hit ? { segment: 'avoid', status: 'missed', evidence: [], note: `"${hit}" is mentioned, though you asked not to mention it.`, attempts: 1 } : { segment: 'avoid', status: 'done', evidence: [], note: `Nothing mentions ${plan.avoid.map((a) => `"${a}"`).join(', ')}.`, attempts: 1 })
  }

  // the music
  const m = plan.music
  const sings = !m.none && (m.vocals === 'wordless' || m.vocals === 'lyrics')
  const styled = !m.none && !!m.genre
  if (m.none) checks.push({ segment: 'music', status: f.musicSource === 'none' ? 'done' : 'missed', evidence: [], note: f.musicSource === 'none' ? 'No music, as asked.' : 'You asked for no music, but there is some.', attempts: 1 })
  else if ((sings || styled) && f.musicSource !== 'ai') checks.push({ segment: 'music', status: 'missed', evidence: [], note: `You asked for ${sings ? 'music with vocals' : `${m.genre} music`}, but ${f.musicError ? `the AI music could not be made (${f.musicError})` : 'no AI music was used'}, so the built-in instrumental score plays.`, attempts: 1 })
  else if (f.musicSource === 'ai') checks.push({ segment: 'music', status: 'done', evidence: [], note: m.description ? `AI music made from your words: ${m.description.slice(0, 100)}.` : 'AI music made for the film.', attempts: 1 })
  else checks.push({ segment: 'music', status: 'done', evidence: [], note: 'The built-in score plays.', attempts: 1 })

  // the voice
  if (plan.voice.language || plan.voice.tone) {
    const ok = f.voiced && f.written
    checks.push({ segment: 'voice', status: ok ? 'done' : 'partial', evidence: [], note: ok ? `Narrated${plan.voice.language ? ` in ${plan.voice.language}` : ''}${plan.voice.tone ? `, ${plan.voice.tone}` : ''}.` : !f.voiced ? 'No AI voice was available, so the film has captions only.' : `The AI writer was not available to write in ${plan.voice.language ?? 'your tone'}, so the plain words are used.`, attempts: 1 })
  }

  // the length
  if (plan.targetSec) {
    const ratio = f.durationSec / plan.targetSec
    const fine = ratio >= 0.65 && ratio <= 1.4
    checks.push({ segment: 'length', status: fine ? 'done' : 'partial', evidence: [`${Math.round(f.durationSec)}s`], note: fine ? `The film is ${Math.round(f.durationSec)}s (you asked for about ${plan.targetSec}s).` : `The film is ${Math.round(f.durationSec)}s, not the ${plan.targetSec}s you asked for.`, attempts: 1 })
  }
  return { checks, shortfalls: [] }
}

/** the end-of-run report: what was asked, what was done */
export function buildReport(plan: MarketPlan, outcome: Pick<MarketPlanOutcome, 'assignment' | 'answers'>, review: { checks: SegmentCheck[] }, durationSec?: number): MarketReport {
  const shortfalls: string[] = []
  for (const u of plan.unplaced) shortfalls.push(`I could not place this instruction, so it is not in the film: "${u}".`)
  for (const c of review.checks) if (c.status === 'missed' || c.status === 'partial' || c.status === 'substituted' || c.status === 'skipped') shortfalls.push(c.note)
  return { plan, assignment: outcome.assignment, decisions: outcome.answers, checks: review.checks, shortfalls, ...(durationSec ? { durationSec } : {}) }
}
