/**
 * PLAN stage, part 3: what the film needs, and the questions to put to the person.
 *
 * Pure. A request exists only where there is a real choice or a mismatch (the
 * settings' engine cannot do what the plan asks, or is not usable). Where the
 * person's settings already fit, the job is simply assigned and reported.
 *
 * `autopick` rule: if the configured model meets the need, it; otherwise the
 * cheapest AVAILABLE option that meets the need (price book cost tier, ties by
 * list order); if nothing meets it, the best honest free fallback. It is never
 * a model the account cannot use. Exception: AI clips the person asked for
 * outright (required segment) are taken even when Settings say "stock", because
 * the plan's own entitlements already allow them.
 */
import type {
  CapabilityReport, DecisionAnswer, DecisionOption, DecisionRequest, FilmPlan, JobAssignment, JobKind, JobNeed, ModelOption, MusicSpec
} from '@shared/agentBrief'
import { costRank, modelCanSing } from './capabilities'

// ---------------------------------------------------------------- needs

/** vocals are REQUIRED for wordless/lyrics; 'any' only allows them */
export function musicNeedsVocals(m: MusicSpec): boolean {
  return !m.none && (m.vocals === 'wordless' || m.vocals === 'lyrics')
}

/** a named style (Arabic, nasheed…) only an AI model can play; the built-in composer has moods only */
function musicNeedsStyle(m: MusicSpec): boolean {
  return !m.none && Boolean(m.genre?.trim())
}

function describeMusic(m: MusicSpec): string {
  const bits = [m.description.trim()]
  if (m.vocals !== 'none') bits.push(`vocals: ${m.vocals}`)
  if (m.instruments.length) bits.push(`only: ${m.instruments.join(', ')}`)
  if (m.exclude.length) bits.push(`not: ${m.exclude.join(', ')}`)
  return bits.filter(Boolean).join(' · ') || 'background music'
}

/** what each job has to do for this plan */
export function needsOf(plan: FilmPlan): JobNeed[] {
  const all = plan.segments.map((s) => s.id)
  const clips = plan.segments.filter((s) => s.kind === 'ai-clip')
  const pages = plan.segments.filter((s) => s.kind === 'page').map((s) => s.id)
  const needs: JobNeed[] = [{ job: 'writer', for: all, asks: `read the brief and write the narration${plan.voice.tone ? ` in a ${plan.voice.tone} tone` : ''}${plan.voice.language ? ` in ${plan.voice.language}` : ''}` }]
  if (!plan.voice.none) needs.push({ job: 'voice', for: all, asks: `speak the narration${plan.voice.language ? ` in ${plan.voice.language}` : ''}${plan.voice.tone ? `, ${plan.voice.tone}` : ''}` })
  if (!plan.music.none) needs.push({ job: 'music', for: ['music'], asks: describeMusic(plan.music) })
  if (clips.length) {
    needs.push({ job: 'video', for: clips.map((c) => c.id), asks: clips.map((c) => (c.kind === 'ai-clip' ? `${c.subject}${c.seconds ? ` (${c.seconds}s)` : ''}` : '')).join('; ') })
    needs.push({ job: 'image', for: clips.map((c) => c.id), asks: `first-frame pictures for the clips${plan.look.style ? `, ${plan.look.style} look` : ''}${plan.look.noAbstract ? ', nothing abstract' : ''}` })
  }
  if (pages.length) needs.push({ job: 'vision', for: pages, asks: 'look at the filmed pages and check each one shows what was asked' })
  return needs
}

// ---------------------------------------------------------------- helpers

const jobOf = (report: CapabilityReport, job: JobKind) => report.jobs.find((j) => j.job === job)
const labelOf = (o: ModelOption) => o.label
const cheapest = (os: ModelOption[]): ModelOption | undefined => [...os].sort((a, b) => costRank(a.id) - costRank(b.id))[0]

function unavailableNote(opts: ModelOption[]): string {
  const bad = opts.filter((o) => !o.available && o.reason && costRank(o.id) > 0)
  if (!bad.length) return ''
  // one line per distinct reason, naming up to two models
  const byReason = new Map<string, string[]>()
  for (const o of bad) byReason.set(o.reason!, [...(byReason.get(o.reason!) ?? []), o.label])
  return [...byReason].map(([r, ls]) => `${ls.slice(0, 2).join(' and ')}: ${r}`).join('; ')
}

function modelOption(o: ModelOption, extra: string, recommended: boolean): DecisionOption {
  return { id: o.id, label: `Use ${labelOf(o)}`, detail: `${extra} ${o.cost === 'free' ? 'Free.' : `Costs ${o.cost}.`}`.trim(), ...(recommended ? { recommended: true } : {}) }
}

// ---------------------------------------------------------------- decisions

export interface Decisions {
  requests: DecisionRequest[]
  /** every job's pick before any answer: configured where it fits, else the autopick */
  assignment: JobAssignment
}

function musicDecision(plan: FilmPlan, report: CapabilityReport, assignment: JobAssignment): DecisionRequest | null {
  if (plan.music.none) { assignment.music = 'none'; return null }
  const cap = jobOf(report, 'music')
  if (!cap) return null
  const sings = musicNeedsVocals(plan.music)
  const styled = musicNeedsStyle(plan.music)
  const wantsAi = sings || styled
  const configured = assignment.music ?? cap.configured
  const cfg = cap.options.find((o) => o.id === configured)
  const cfgFits = !!cfg && cfg.available && (!sings || modelCanSing(cfg.id)) && (!styled || cfg.id !== 'builtin:procedural')
  if (cfgFits || !wantsAi) {
    if (cfg?.available) assignment.music = cfg.id
    else assignment.music = cap.options.find((o) => o.available && costRank(o.id) === 0)?.id
    return null
  }
  // a mismatch: the configured engine cannot do what was asked
  const capable = cap.options.filter((o) => o.available && modelCanSing(o.id)).sort((a, b) => costRank(a.id) - costRank(b.id))
  const builtin = cap.options.find((o) => o.id === 'builtin:procedural' && o.available)
  const why = sings
    ? `Your brief asks for music with vocals ("${plan.music.description.trim() || 'vocals'}")`
    : `Your brief asks for ${plan.music.genre} music`
  const cfgName = cfg ? `${cfg.label} (set in Settings)` : 'the engine in Settings'
  const unavail = unavailableNote(cap.options.filter((o) => modelCanSing(o.id)))
  const options: DecisionOption[] = []
  capable.slice(0, 2).forEach((o, i) => options.push(modelOption(o, `Can make vocals${plan.music.genre ? ` and ${plan.music.genre} style` : ''}.`, i === 0)))
  if (builtin) options.push({ id: builtin.id, label: 'Keep the built-in music', detail: `Free, but it will not have ${sings ? 'vocals' : `${plan.music.genre} style`}: it plays an instrumental mood score.`, ...(capable.length ? {} : { recommended: true }) })
  options.push({ id: 'none', label: 'No music', detail: 'Narration only. Free.' })
  const rec = capable[0]?.id ?? builtin?.id ?? 'none'
  const context = capable.length
    ? `${why}, but ${cfgName} ${cfg?.id === 'builtin:procedural' ? 'cannot sing' : 'is not usable here'}.${unavail ? ` Not available: ${unavail}.` : ''}`
    : `${why}, but no AI music is available on this account, so the film cannot have it.${unavail ? ` ${unavail}.` : ''} Access: ${report.access === 'programmatic' ? 'free engine only (sign in or add your own keys for AI music)' : report.access}.`
  const req: DecisionRequest = { id: 'music', topic: 'music', question: capable.length ? 'Which music should I use?' : 'AI music is not available. What should I do?', context, options: options.slice(0, 4), autopick: rec }
  assignment.music = rec
  return req
}

function videoDecision(plan: FilmPlan, report: CapabilityReport, assignment: JobAssignment): DecisionRequest | null {
  const clips = plan.segments.filter((s) => s.kind === 'ai-clip')
  if (!clips.length) return null
  const cap = jobOf(report, 'video')
  if (!cap) return null
  const aiOpts = cap.options.filter((o) => o.available && costRank(o.id) > 0)
  const cfg = cap.options.find((o) => o.id === cap.configured)
  if (cfg?.available && costRank(cfg.id) > 0) { assignment.video = cfg.id; return null }
  const required = clips.some((c) => c.required)
  const n = clips.length
  const limit = report.limits.find((l) => /clip/i.test(l))
  if (aiOpts.length) {
    const best = cheapest(aiOpts)!
    const options: DecisionOption[] = aiOpts.slice(0, 2).map((o) => modelOption(o, `Animates your ${n} clip${n === 1 ? '' : 's'}.`, o.id === best.id && required))
    options.push({ id: 'none', label: 'Use drawn scenes instead', detail: 'Free: the same moments as designed cards, no video clips.', ...(required ? {} : { recommended: true }) })
    const pick = required ? best.id : 'none'
    assignment.video = pick
    return { id: 'video', topic: 'video', question: `Make the ${n} AI clip${n === 1 ? '' : 's'}?`, context: `Your brief asks for ${n} AI-made clip${n === 1 ? '' : 's'}, but Settings choose ${cfg ? cfg.label : 'free stock footage'}, which cannot make them.${limit ? ` Your plan allows ${limit}.` : ''}`, options, autopick: pick }
  }
  assignment.video = 'none'
  const why = unavailableNote(cap.options) || 'AI clips are not available on this account'
  return {
    id: 'video', topic: 'video',
    question: 'AI clips are not available. What should I do?',
    context: `Your brief asks for ${n} AI-made clip${n === 1 ? '' : 's'}. ${why}.`,
    options: [
      { id: 'none', label: 'Use drawn scenes instead', detail: 'Free: those moments become designed cards.', recommended: true },
      { id: 'skip', label: 'Leave those scenes out', detail: 'Free: the film goes straight to the next part.' }
    ],
    autopick: 'none'
  }
}

function voiceDecision(plan: FilmPlan, report: CapabilityReport, assignment: JobAssignment): DecisionRequest | null {
  if (plan.voice.none) { assignment.voice = 'none'; return null }
  const cap = jobOf(report, 'voice')
  if (!cap) return null
  const cfg = cap.options.find((o) => o.id === cap.configured)
  const aiVoices = cap.options.filter((o) => o.available && costRank(o.id) > 0)
  if (cfg?.available) { assignment.voice = cfg.id; return null }
  if (cap.configured === 'auto' || !cap.configured) {
    // "auto": the app picks its own default; no question
    assignment.voice = cheapest(aiVoices)?.id ?? 'none'
    return null
  }
  if (!aiVoices.length) { assignment.voice = 'none'; return null } // no AI at all: reported, not asked
  const best = cheapest(aiVoices)!
  assignment.voice = best.id
  return {
    id: 'voice', topic: 'voice', question: 'Which voice should narrate?',
    context: `Settings choose ${cfg?.label ?? cap.configured}, which this account cannot use${cfg?.reason ? ` (${cfg.reason})` : ''}.`,
    options: [...aiVoices.slice(0, 2).map((o, i) => modelOption(o, 'Spoken narration.', i === 0)), { id: 'none', label: 'No narration', detail: 'Text on screen only. Free.' }],
    autopick: best.id
  }
}

/** the first available option for a job that needs no question */
function quietPick(report: CapabilityReport, job: JobKind): string | undefined {
  const cap = jobOf(report, job)
  if (!cap) return undefined
  const cfg = cap.options.find((o) => o.id === cap.configured)
  if (cfg?.available) return cfg.id
  const ai = cap.options.filter((o) => o.available && costRank(o.id) > 0)
  // never costlier than the person's own pick: when the configured one is unusable, prefer the cheapest usable
  return cheapest(ai)?.id ?? cap.options.find((o) => o.available)?.id
}

/** the questions for this plan (none when settings already fit), and the assignment before any answer */
export function decisionsFor(plan: FilmPlan, report: CapabilityReport, assignmentDefaults?: JobAssignment): Decisions {
  const assignment: JobAssignment = { ...assignmentDefaults }
  for (const job of ['writer', 'vision'] as JobKind[]) assignment[job] ??= quietPick(report, job)
  if (!plan.segments.some((s) => s.kind === 'ai-clip')) { /* image only matters with clips */ } else assignment.image ??= quietPick(report, 'image')
  const requests: DecisionRequest[] = []
  for (const make of [voiceDecision, musicDecision, videoDecision]) {
    const r = make(plan, report, assignment)
    if (r) requests.push(r)
  }
  if (plan.unplaced.length) {
    requests.push({
      id: 'unplaced', topic: 'unplaced',
      question: plan.unplaced.length === 1 ? 'I could not place one instruction. Go on without it?' : `I could not place ${plan.unplaced.length} instructions. Go on without them?`,
      context: `Left out so far: ${plan.unplaced.map((u) => `"${u}"`).join('; ')}.`,
      options: [
        { id: 'go-on', label: 'Go on without them', detail: 'The film is made now, and the report lists what was left out.', recommended: true },
        { id: 'stop', label: 'Stop, I will reword', detail: 'Nothing is recorded or spent.' }
      ],
      autopick: 'go-on'
    })
  }
  return { requests, assignment }
}

// ---------------------------------------------------------------- answers

/** autopilot: take every request's `autopick` and say so */
export function autopilotAnswers(requests: DecisionRequest[]): DecisionAnswer[] {
  return requests.map((r) => ({ id: r.id, option: r.autopick, auto: true }))
}

export interface Applied {
  assignment: JobAssignment
  /** the person chose to stop */
  stop: boolean
  /** plain-language lines for the report: what was chosen and why it matters */
  notes: string[]
}

/** fold answers into the assignment. 'none' means "no model for this job" (no music, no narration, no AI clips); 'skip' drops the clip scenes. */
export function applyAnswers(requests: DecisionRequest[], answers: DecisionAnswer[], assignment: JobAssignment): Applied {
  const out: JobAssignment = { ...assignment }
  let stop = false
  const notes: string[] = []
  for (const req of requests) {
    const ans = answers.find((a) => a.id === req.id)
    const optId = ans && req.options.some((o) => o.id === ans.option) ? ans.option : req.autopick
    const opt = req.options.find((o) => o.id === optId)
    notes.push(`${req.question} → ${opt?.label ?? optId}${ans?.auto ? ' (picked automatically)' : ''}`)
    if (req.topic === 'unplaced') { if (optId === 'stop') stop = true; continue }
    if (req.topic === 'music' || req.topic === 'video' || req.topic === 'voice') out[req.topic] = optId
  }
  return { assignment: out, stop, notes }
}
