import type { Page } from 'puppeteer-core'
import type {
  AgentMode, BriefInput, CapabilityReport, ClipSegment, DecisionAnswer, DecisionRequest, FilmPlan, JobAssignment,
  NarrationSegment, PageSegment, PariEvent, PariReport, Segment, SegmentCheck
} from '@shared/agentBrief'
import type { AppPage, Step, Take } from '@shared/appRecon'
import type { LLMProvider } from '../../providers/types'
import type { BeatFacts } from '../planner'
import type { PolicyGate } from '../policy'
import type { MediaRequest, Placement } from '../aiMedia'
import { readBrief } from './brief'
import { applyAnswers, autopilotAnswers, decisionsFor } from './decide'
import { planSegment, scoutSegment, type ActPlan } from './act'
import { MAX_ATTEMPTS, nextMove, reviewSegment, type Evidence } from './review'
import { goalSegments } from '../goalPlanner'

/**
 * PARI — Plan, Act, Review, Iterate — for "Record an app".
 *
 *   planStage()   reads the whole brief into a FilmPlan, works out which model does which job, and asks the
 *                 person (or, on autopilot, decides and says so)
 *   actStage()    opens every page segment behind the policy gate, retries / substitutes / asks when one fails,
 *                 and writes the playbook the recorder runs
 *   reviewStage() checks each segment against what was really recorded, made and said
 *
 * The hard rails are not the agent's: the gate, redaction, sign-in attempts and spend limits stay where they are.
 */

type Emit = (e: DistributiveOmit<PariEvent, 'runId'>) => void
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

export interface PariHooks {
  mode: AgentMode
  capabilities: CapabilityReport
  /** shows the requests to the person and waits; null = they stopped the run */
  decide: (requests: DecisionRequest[]) => Promise<DecisionAnswer[] | null>
  emit: Emit
}

export class PariStopped extends Error {}

export interface PlanOutcome {
  plan: FilmPlan
  assignment: JobAssignment
  answers: DecisionAnswer[]
  notes: string[]
}

/** answers for these requests: the person's in 'ask' mode, the autopicks on autopilot (always shown) */
async function settle(requests: DecisionRequest[], hooks: PariHooks): Promise<DecisionAnswer[]> {
  if (!requests.length) return []
  hooks.emit({ kind: 'pari-decide', requests, auto: hooks.mode === 'autopilot' })
  if (hooks.mode === 'autopilot') return autopilotAnswers(requests)
  const answers = await hooks.decide(requests)
  if (!answers) throw new PariStopped('You stopped the video before anything was recorded.')
  return answers
}

export async function planStage(input: BriefInput, deps: { chat: LLMProvider | null; secrets: string[]; say: (m: string) => void }, hooks: PariHooks): Promise<PlanOutcome> {
  const plan = await readBrief(input, deps)
  hooks.emit({ kind: 'pari-plan', plan, capabilities: hooks.capabilities })
  deps.say(`Plan (${plan.source === 'ai' ? 'read by the AI writer' : 'read by rules'}): ${plan.segments.map(describe).join(' → ')}`)
  if (plan.unplaced.length) deps.say(`Could not place: ${plan.unplaced.map((u) => `"${u}"`).join('; ')}`)
  const d = decisionsFor(plan, hooks.capabilities)
  const answers = await settle(d.requests, hooks)
  const applied = applyAnswers(d.requests, answers, d.assignment)
  for (const n of applied.notes) deps.say(n)
  if (applied.stop) throw new PariStopped('You chose to stop and reword the brief, so nothing was recorded.')
  return { plan, assignment: applied.assignment, answers, notes: applied.notes }
}

const describe = (s: Segment): string =>
  s.kind === 'page' ? `${s.how} ${s.url ?? s.target ?? '?'}` : s.kind === 'ai-clip' ? `AI clip (${s.purpose}${s.style ? `, ${s.style}` : ''})` : s.kind === 'card' ? `${s.card} card` : 'narration'

// ------------------------------------------------------------------ act

const pathKey = (url: string): string => {
  try {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}`
  } catch {
    return url
  }
}

const pageSegs = (plan: FilmPlan): PageSegment[] => plan.segments.filter((s): s is PageSegment => s.kind === 'page')

/**
 * the agent films this plan itself when it names pages to show (a numbered script still goes to the exact-steps path).
 * A page that is a goal ("explain the Regional distribution section and give live examples", "find a gift under £50") is no page
 * to open: such a plan goes the steps way, where each goal is worked out on the real page (goalPlanner.ts).
 */
export function agentFilmsPages(plan: FilmPlan): boolean {
  const pages = pageSegs(plan)
  return pages.length > 0 && pages.every((p) => p.how !== 'script' && !!(p.url || p.target)) && goalSegments(plan).length === 0
}

export interface ActOutcome {
  steps: Step[]
  beats: BeatFacts[]
  /** per page segment: what was planned and the page reached */
  acted: Map<string, { act: ActPlan; reached: AppPage; substituted: boolean; attempts: number; /** seen signed out: filmed before the sign-in */ public?: boolean }>
  /** page segments not filmed, with why */
  skipped: Map<string, { why: string; attempts: number; /** the words named no link and no address: a goal to work out on the page, not a page to open */ notALink?: boolean }>
  notes: string[]
}

export async function actStage(inp: {
  page: Page
  plan: FilmPlan
  gate: PolicyGate
  outDir: string
  startUrl: string
  known: AppPage[]
  /** beats already used (the sign-in) */
  startBeat: number
  say: (m: string) => void
  hooks: PariHooks
  check: () => void
  /** the app was signed in to (a bounce to the home page then is not a sign-in wall) */
  signedIn: boolean
  /** a fresh signed-out page: a public page that a signed-in person is sent away from (a homepage → dashboard) is read there */
  publicPage?: () => Promise<Page>
  /** the film's length: how many sections, stages and features fit */
  targetSec?: number
}): Promise<ActOutcome> {
  const out: ActOutcome = { steps: [], beats: [], acted: new Map(), skipped: new Map(), notes: [] }
  const budget = partsBudget(inp.plan, inp.targetSec)
  let publicTab: Page | null = null
  const filmed = new Set<string>()
  let beat = inp.startBeat
  let n = 0
  for (const seg of pageSegs(inp.plan)) {
    inp.check()
    n++
    let attempts = 0
    let tried: PageSegment = seg
    let substituted = false
    let res: Awaited<ReturnType<typeof scoutSegment>> = { ok: false, why: 'not tried' }
    let firstWhy: string | undefined
    let isPublic = false
    const bouncedTo = new Set<string>()
    for (;;) {
      attempts++
      inp.say(`Opening ${tried.url ?? `"${tried.target}"`} (attempt ${attempts})`)
      res = await scoutSegment(inp.page, tried, inp.gate, { outDir: inp.outDir, name: `pari-${seg.id}-${attempts}`, known: inp.known, startUrl: inp.startUrl, hints: [inp.plan.product ?? '', inp.plan.heroFeature ?? '', inp.plan.goal] })
      // a page found by name is no substitute when it is one already filmed, or the very page the address bounced to
      if (res.ok && substituted && res.page && (filmed.has(pathKey(res.page.url)) || bouncedTo.has(pathKey(res.page.url)))) {
        res = { ok: false, why: `the only page called "${seg.target}" is ${res.page.url}, which is not the page you asked for` }
      }
      if (res.ok) break
      // signed in, the app sends the person away from a public page: read it the way a visitor sees it, and film it before the sign-in
      if (inp.signedIn && inp.publicPage && !substituted && tried.url && /redirected elsewhere/.test(res.why ?? '') && !isPublic) {
        publicTab ??= await inp.publicPage()
        const pub = await scoutSegment(publicTab, tried, inp.gate, { outDir: inp.outDir, name: `pari-${seg.id}-public`, known: inp.known, startUrl: inp.startUrl })
        if (pub.ok) {
          inp.say('  Signed out it opens, so it is filmed before the sign-in')
          res = pub
          isPublic = true
          break
        }
      }
      if (res.page && !substituted) bouncedTo.add(pathKey(res.page.url))
      if (/redirected elsewhere/.test(res.why ?? '') && !inp.signedIn && res.page && pathKey(res.page.url) !== pathKey(tried.url ?? '')) res = { ...res, why: `${res.why}; it probably needs you to be signed in (choose a sign-in option for this app)` }
      firstWhy ??= res.why
      inp.say(`  It did not open: ${res.why}`)
      const fake: SegmentCheck = { segment: seg.id, status: 'missed', evidence: [], note: res.why ?? '', attempts }
      const move = nextMove(fake, attempts, seg.required)
      if (move === 'retry' && attempts < MAX_ATTEMPTS) continue
      // the same page named in words, when the address itself failed
      if (!substituted && tried.url && seg.target) {
        tried = { ...seg, url: undefined }
        substituted = true
        continue
      }
      break
    }
    if (!res.ok || !res.page) {
      // the address's own failure is the honest reason; the by-name search only adds to it
      const why = firstWhy && firstWhy !== res.why ? `${firstWhy}; ${res.why}` : (res.why ?? 'it would not open')
      if (seg.required) {
        const ask: DecisionRequest = {
          id: `miss-${seg.id}`,
          topic: 'misalignment',
          question: `I could not open "${seg.url ?? seg.target}". Go on without it?`,
          context: `You asked: "${seg.said.slice(0, 160)}". I tried ${attempts} time${attempts === 1 ? '' : 's'}: ${why}.`,
          options: [
            { id: 'go-on', label: 'Go on without it', detail: 'The film is made from the other parts, and the report says this one is missing.', recommended: true },
            { id: 'stop', label: 'Stop', detail: 'Nothing is recorded or spent. Check the address or the sign-in, then try again.' }
          ],
          autopick: 'go-on'
        }
        const [a] = await settle([ask], inp.hooks)
        if (a?.option === 'stop') throw new PariStopped(`Stopped: "${seg.url ?? seg.target}" could not be opened (${why}).`)
      }
      out.skipped.set(seg.id, { why, attempts, ...(/is not a link/.test(why) ? { notALink: true } : {}) })
      out.notes.push(`Not filmed: ${seg.url ?? seg.target} (${why}).`)
      continue
    }
    inp.known.push(res.page)
    filmed.add(pathKey(res.page.url))
    const act = planSegment(tried.url ? tried : { ...tried, url: res.page.url }, res.page, { startBeat: beat, idPrefix: `p${n}-`, gate: inp.gate, maxParts: budget.get(seg.id), onPage: res.onPage })
    if (res.onPage) inp.say(`  "${seg.target}" is an action on the page, not a link: using ${res.onPage.picks.map((p) => p.label).join(', ')}`)
    for (const note of act.notes) inp.say(`  ${note}`)
    out.steps.push(...act.steps)
    out.beats.push(...act.beats)
    out.notes.push(...act.notes)
    out.acted.set(seg.id, { act, reached: res.page, substituted, attempts, ...(isPublic ? { public: true } : {}) })
    beat = Math.max(beat, ...act.beats.map((b) => b.beat + 1))
  }
  if (publicTab) await publicTab.browserContext().close().catch(() => undefined)
  attachClaims(inp.plan, out)
  return out
}

const WEIGHT: Record<PageSegment['how'], number> = { steps: 2, features: 1, tour: 1, glance: 0, script: 0 }

/**
 * how many parts each page segment may show: about one part per 5 seconds of the film after the opening and
 * closing scenes. A brief that sets no length gets at least a minute; "steps" get twice the share of a tour.
 */
export function partsBudget(plan: FilmPlan, targetSec?: number): Map<string, number> {
  const sec = Math.max(plan.targetSec ?? targetSec ?? 60, plan.targetSec ? 20 : 60)
  const clips = plan.segments.filter((s) => s.kind === 'ai-clip').length * 5
  const pages = pageSegs(plan)
  const total = Math.max(pages.length * 2, Math.round((sec - 15 - clips) / 5))
  const sum = pages.reduce((a, p) => a + WEIGHT[p.how], 0) || 1
  return new Map(pages.map((p) => [p.id, Math.max(2, Math.round((total * WEIGHT[p.how]) / sum))]))
}

/** "tell that …" claims ride on the page beat they belong to (or the nearest one before them) and must be said there */
export function attachClaims(plan: FilmPlan, out: Pick<ActOutcome, 'beats' | 'acted'>): void {
  let lastPage: string | null = null
  const homeless: NarrationSegment[] = []
  for (const s of plan.segments) {
    if (s.kind === 'page' && out.acted.has(s.id)) {
      lastPage = s.id
      continue
    }
    if (s.kind !== 'narration') continue
    const over = typeof s.over === 'object' && out.acted.has(s.over.segment) ? s.over.segment : lastPage
    if (!over) {
      homeless.push(s)
      continue
    }
    pin(out, over, s.claims)
  }
  // claims said before any page was shown go on the first page that was
  const first = plan.segments.find((s) => s.kind === 'page' && out.acted.has(s.id))
  if (first) for (const s of homeless) pin(out, first.id, s.claims)
}

/** a "tell that…" point gets its own short beat, holding on the page it belongs to (never one long beat for all of them) */
function pin(out: Pick<ActOutcome, 'beats' | 'acted'>, segId: string, claims: string[]): void {
  const a = out.acted.get(segId)
  const last = a?.act.beats.at(-1)
  if (!a || !last || !claims.length) return
  const prefix = a.act.steps[0]?.id.split('-')[0] ?? 'p'
  const beat = 1000 + out.beats.length
  const page = last.facts.find((f) => f.startsWith('This is ')) ?? a.act.beats[0]?.facts[0] ?? ''
  a.act.steps.push({ id: `${prefix}-c${beat}`, beat, kind: 'wait', holdMs: 1200 })
  const b: BeatFacts = { beat, kind: 'page', chapter: claims[0].split(/\s+/).slice(0, 4).join(' '), facts: [...claims.map((c) => `Say this plainly, in one or two short sentences: ${c}`), ...(page ? [page] : [])], fallback: claims.map((c) => c.replace(/[.]+$/, '')).join('. ') + '.' }
  a.act.beats.push(b)
  out.beats.push(b)
}

// ------------------------------------------------------------------ what the other stages need from the plan

const PLACE: Record<ClipSegment['purpose'], Placement> = { problem: 'start', solution: 'start', intro: 'start', outro: 'end', illustration: 'middle' }

/** the plan's AI clips in the shape the media planner already takes */
export function clipRequests(plan: FilmPlan): MediaRequest[] {
  return plan.segments
    .filter((s): s is ClipSegment => s.kind === 'ai-clip')
    .map((c) => ({
      said: c.said.slice(0, 400),
      subject: c.subject.slice(0, 300),
      placement: PLACE[c.purpose],
      generic: false,
      ...(c.seconds ? { seconds: c.seconds } : {}),
      ...(c.purpose === 'problem' || c.purpose === 'solution' ? { part: c.purpose } : {})
    }))
}

/** what the narration writer is told the film is for: the goal and every explain/claim, never the production notes */
export function narrationBrief(plan: FilmPlan): string {
  const lines = [plan.goal]
  if (plan.product) lines.push(`Product: ${plan.product}.`)
  if (plan.heroFeature) lines.push(`The film is built around this feature: ${plan.heroFeature}.`)
  for (const s of plan.segments) {
    if (s.explain?.length) lines.push(...s.explain.map((e) => `Make clear: ${e}`))
    if (s.kind === 'narration') lines.push(...s.claims.map((c) => `Say: ${c}`))
  }
  return lines.join('\n')
}

export function wantsProblemCard(plan: FilmPlan, clipsWillBeMade: boolean): boolean {
  if (plan.segments.some((s) => s.kind === 'card' && s.card === 'problem')) return true
  // the problem was asked for as an AI clip: when no clip can be made it is drawn as a card instead
  return !clipsWillBeMade && plan.segments.some((s) => s.kind === 'ai-clip' && s.purpose === 'problem')
}

// ------------------------------------------------------------------ review

export interface ReviewInput {
  plan: FilmPlan
  acted: ActOutcome | null
  take: Take | null
  /** said of each clip that made it into the film */
  clipsMade: Map<string, number>
  /** the clips were not tried at all, and why */
  clipsSkipped?: string
  lines: string[]
  problemDrawn: boolean
  /** the typed steps were performed exactly (the exact-steps path): the words of each step done, and how much was done */
  scripted?: { said: string[]; actions: number; choices: number; /** parts of steps that could not be done and were left out, in words */ skipped?: string[] }
}

const flat = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/** a page segment the exact-steps run filmed: it is judged by what that run did, not reported as skipped */
function scriptedCheck(seg: PageSegment, s: NonNullable<ReviewInput['scripted']>): SegmentCheck | null {
  const mine = flat(seg.said)
  const done = s.said.filter((w) => {
    const f = flat(w)
    return f.length > 6 && (mine.includes(f.slice(0, 60)) || f.includes(mine.slice(0, 60)))
  })
  if (seg.how !== 'script' && !done.length) return null
  const proof = [`${s.said.length} typed step${s.said.length === 1 ? '' : 's'} done in order`, `${s.actions} action${s.actions === 1 ? '' : 's'} performed`]
  if (s.choices) proof.push(`${s.choices} dropdown choice${s.choices === 1 ? '' : 's'} made`)
  if (s.skipped?.length) return { segment: seg.id, status: 'partial', evidence: [...proof, ...s.skipped.map((k) => `left out: ${k}`)], note: `Done on the real page, except ${s.skipped.length === 1 ? 'one part' : `${s.skipped.length} parts`} that could not be done and are not in the film (the narration does not claim them): ${s.skipped.slice(0, 4).join('; ')}.`, attempts: 1 }
  return { segment: seg.id, status: 'done', evidence: proof, note: 'Done by the exact-steps run: every step was performed on the real page, then filmed.', attempts: 1 }
}

export function reviewStage(r: ReviewInput): SegmentCheck[] {
  const checks = r.plan.segments.map((seg) => {
    if (seg.kind === 'page' && r.scripted && !r.acted) {
      const c = scriptedCheck(seg, r.scripted)
      if (c) return c
    }
    return reviewSegment(seg, evidenceFor(seg, r))
  })
  // what each reached page offers (its tabs, sections), for the person to read in the report; display only, no decisions ride on it
  for (const c of checks) {
    const poss = r.acted?.acted.get(c.segment)?.reached.possibilities
    if (poss?.length) c.note = `${c.note} ${`This page offers: ${poss.join('; ')}`.slice(0, 160)}`.trim()
  }
  return checks
}

function evidenceFor(seg: Segment, r: ReviewInput): Evidence {
  if (seg.kind === 'page') {
    const skipped = r.acted?.skipped.get(seg.id)
    if (skipped) return { kind: 'page', skippedBecause: skipped.why, attempts: skipped.attempts, planned: [], log: [], lines: r.lines }
    const a = r.acted?.acted.get(seg.id)
    if (!a) return { kind: 'page', skippedBecause: r.acted ? 'it was not part of the recording' : 'the exact-steps path filmed this part', planned: [], log: [], lines: r.lines }
    const ids = new Set(a.act.steps.map((s) => s.id))
    const beats = new Set(a.act.beats.map((b) => b.beat))
    return {
      kind: 'page',
      attempts: a.attempts,
      reachedUrl: a.substituted ? `${a.reached.url}#substituted` : a.reached.url,
      reachedTitle: a.reached.title,
      planned: a.act.planned,
      log: (r.take?.log ?? []).filter((l) => ids.has(l.step)),
      beatsRecorded: (r.take?.beats ?? []).filter((b) => beats.has(b.beat)).length,
      lines: r.lines
    }
  }
  if (seg.kind === 'ai-clip') {
    if (r.clipsSkipped) return { kind: 'ai-clip', exists: false, skippedBecause: r.clipsSkipped, lines: r.lines }
    const sec = r.clipsMade.get(seg.said.slice(0, 400))
    return { kind: 'ai-clip', exists: sec !== undefined, seconds: sec, lines: r.lines }
  }
  if (seg.kind === 'narration') return { kind: 'narration', lines: r.lines }
  // there is no scene of its own for a solution yet: say so instead of calling it done
  if (seg.card === 'solution') return { kind: 'card', drawn: false, skippedBecause: 'there is no separate solution scene yet; the title scene names the product and the narration over the pages presents it as the answer', lines: r.lines }
  return { kind: 'card', drawn: seg.card === 'problem' ? r.problemDrawn : true, lines: r.lines }
}

export function buildReport(plan: FilmPlan, outcome: PlanOutcome | null, checks: SegmentCheck[]): PariReport {
  const shortfalls = [
    ...plan.unplaced.map((u) => `Not understood, so not in the film: "${u}"`),
    ...checks.filter((c) => c.status !== 'done').map((c) => {
      const seg = plan.segments.find((s) => s.id === c.segment)
      return `${c.status === 'substituted' ? 'Done differently' : c.status === 'partial' ? 'Only partly done' : 'Not done'}: "${(seg?.said ?? c.segment).slice(0, 120)}". ${c.note}`
    })
  ]
  return { plan, assignment: outcome?.assignment ?? {}, decisions: outcome?.answers ?? [], checks, shortfalls }
}
