/**
 * PARI for "Record an app": Plan → Act → Review → Iterate.
 *
 * This file is the CONTRACT between the parts of the agent. Every module codes
 * against these types; none of them changes this file without the orchestrator.
 *
 *   PLAN     main/appRecon/agent/brief.ts         readBrief()        the whole brief → FilmPlan (AI first, rules as fallback)
 *            main/appRecon/agent/capabilities.ts  readCapabilities() what this account can use for each job (settings + plan + keys)
 *            main/appRecon/agent/decide.ts        decisionsFor()     the questions to put to the person (or autopilot answers)
 *   ACT      main/appRecon/agent/act.ts           actSegment()       carry out one page segment in the browser (open URL, tour sections…)
 *   REVIEW   main/appRecon/agent/review.ts        reviewSegment()    did the take / clip / narration do what the segment asked?
 *   ITERATE  main/appRecon/agent/loop.ts          runPari()          retry, substitute, ask, or report honestly
 *
 * Hard rails are NOT the agent's to decide: the policy gate (what may be
 * clicked), redaction, sign-in attempts, and spending limits stay in code.
 */

// ------------------------------------------------------------------ the plan

/** a kind of work a model does for the film */
export type JobKind = 'writer' | 'voice' | 'music' | 'video' | 'image' | 'vision'

export type Placement = 'start' | 'middle' | 'end'

interface SegmentBase {
  /** stable id ("s1", "s2"…), in film order */
  id: string
  /** the person's own words this segment came from (kept for review and for the report) */
  said: string
  /** false = a nice-to-have the agent may drop with a note; true = the person asked for it outright */
  required: boolean
  /** what the narration over this segment must get across (the person's "explain …", "tell that …") */
  explain?: string[]
}

/** an AI-generated cutaway (problem statement, metaphor, solution) */
export interface ClipSegment extends SegmentBase {
  kind: 'ai-clip'
  /** what the clip is about, in plain words (the picture writer turns it into a prompt) */
  subject: string
  purpose: 'problem' | 'solution' | 'intro' | 'outro' | 'illustration'
  style: 'infographic' | 'cinematic' | null
  /** whole seconds the person asked for, if any */
  seconds?: number
}

/** a part of the real app filmed in the browser */
export interface PageSegment extends SegmentBase {
  kind: 'page'
  /** an exact address the person gave (wins over `target`) */
  url?: string
  /** a page or control named in words ("the pipeline page", "Ontology") when no URL was given */
  target?: string
  /**
   * how to film it:
   *  tour    scroll through the page's sections, holding on each (homepage "show sections")
   *  steps   walk through the steps/stages shown on the page in order ("go through the steps of research")
   *  glance  open it and hold briefly ("briefly show")
   *  features show several distinct features of the page, one after another ("show different features of the report")
   *  script  perform `actions` exactly, in order (a numbered step list)
   */
  how: 'tour' | 'steps' | 'glance' | 'features' | 'script'
  /** for `script`: the person's actions in order, in their words ("click Ontology", "type \"psychology\" in the search") */
  actions?: string[]
  /** things on the page the person named that should be seen ("perspectives", "chat box") */
  lookFor?: string[]
  /** "briefly" → short; otherwise the agent picks */
  emphasis: 'brief' | 'normal' | 'long'
}

/** something to say that has no page of its own (a feature named but not shown) */
export interface NarrationSegment extends SegmentBase {
  kind: 'narration'
  /** the claims to make, in the person's words ("you can refine the research by chatting") */
  claims: string[]
  /**
   * what to show while it is said: a page segment id to hold on, a drawn card, or let the agent
   * look for a page that shows it (and fall back to a card)
   */
  over: { segment: string } | 'card' | 'find'
}

/** a drawn scene (title, problem statement card, closing) */
export interface CardSegment extends SegmentBase {
  kind: 'card'
  card: 'title' | 'problem' | 'solution' | 'outro'
  /** text the person gave for it, if any */
  text?: string
}

export type Segment = ClipSegment | PageSegment | NarrationSegment | CardSegment

export interface MusicSpec {
  /** "no music" */
  none: boolean
  /** free-text description of the music, faithful to the person ("Arabic vocals and duff only, no lyrics, no other instruments") */
  description: string
  vocals: 'none' | 'wordless' | 'lyrics' | 'any'
  /** instruments the person allowed; empty = not said */
  instruments: string[]
  /** instruments or elements the person excluded ("no song", "no drums") */
  exclude: string[]
  /** natural sounds asked for ("rain", "birdsong") */
  ambience: string[]
  quiet: boolean
  /** an Arabic/regional/genre tag, if any ("arabic", "nasheed") */
  genre?: string
}

export interface FilmPlan {
  /** the film's purpose in one sentence, in plain words */
  goal: string
  kind: 'launch' | 'walkthrough' | 'explainer'
  /** product name, if said */
  product?: string
  /** the feature the film is built around, if said ("scientific research") */
  heroFeature?: string
  segments: Segment[]
  music: MusicSpec
  /** narration tone and language, if said */
  voice: { tone?: string; language?: string; none?: boolean }
  /** look for AI pictures, if said */
  look: { style: 'infographic' | 'cinematic' | null; noAbstract: boolean }
  /** target length in seconds, if said */
  targetSec?: number
  /**
   * every instruction the reader could NOT place into the plan, word for word.
   * Never silently dropped: these go into the approval request and the final report.
   */
  unplaced: string[]
  /** who wrote this plan */
  source: 'ai' | 'rules'
}

export interface BriefInput {
  /** the typed brief plus any attached notes ("Attached notes (information only):" marks the start of notes) */
  context: string
  /** the app's start address from "Your app" */
  startUrl: string
  mode: 'walkthrough' | 'launch'
  launch?: { feature: string; tagline: string; targetSec?: number }
  targetSec?: number
}

// ------------------------------------------------------------------ capabilities and decisions

/** one model the account could use for a job */
export interface ModelOption {
  /** "gemini:lyria-3.5", "elevenlabs:music_v2_5", "builtin:procedural" */
  id: string
  label: string
  /** "≈ $0.08 / track", "free" */
  cost: string
  /** usable right now on this account */
  available: boolean
  /** why not, in plain words ("needs a Gemini key", "not in the Plus plan") */
  reason?: string
  /** what this model can and cannot do that matters for the plan ("instrumental only", "can sing wordless vocals") */
  strengths: string[]
  limits: string[]
}

export interface JobCapability {
  job: JobKind
  /** what the person's settings currently choose for this job, if anything */
  configured?: string
  options: ModelOption[]
}

export interface CapabilityReport {
  /** 'plan' = the subscription's AI, 'own-keys' = the person's keys, 'programmatic' = free engine only */
  access: 'plan' | 'own-keys' | 'programmatic'
  planName?: string
  jobs: JobCapability[]
  /** clips left / video budget, in plain words, if limited */
  limits: string[]
}

/** what one plan item needs */
export interface JobNeed {
  job: JobKind
  /** which segments (or 'music') need it */
  for: string[]
  /** what the plan asks of the model, so a model's limits can be matched ("wordless Arabic vocals with duff") */
  asks: string
}

export interface DecisionOption {
  id: string
  label: string
  /** one line: what happens, what it costs */
  detail: string
  recommended?: boolean
}

export interface DecisionRequest {
  id: string
  /** the topic, for grouping in the UI */
  topic: JobKind | 'plan' | 'unplaced' | 'misalignment'
  /** one short question in plain words */
  question: string
  /** why the agent is asking (what it found) */
  context: string
  options: DecisionOption[]
  /** the option autopilot takes */
  autopick: string
}

export interface DecisionAnswer {
  id: string
  option: string
  /** true when autopilot chose it */
  auto: boolean
}

/** 'ask' = pause for the person on every decision · 'autopilot' = take `autopick` and report it */
export type AgentMode = 'ask' | 'autopilot'

/** the model chosen for each job after decisions */
export type JobAssignment = Partial<Record<JobKind, string>>

// ------------------------------------------------------------------ review

export type CheckStatus = 'done' | 'partial' | 'missed' | 'substituted' | 'skipped'

export interface SegmentCheck {
  segment: string
  status: CheckStatus
  /** what was looked at (page address reached, frames seen, clip checked) */
  evidence: string[]
  /** plain-language note for the person */
  note: string
  /** how many times the agent tried */
  attempts: number
}

/** the honest end-of-run report: what was asked, what was done */
export interface PariReport {
  plan: FilmPlan
  assignment: JobAssignment
  decisions: DecisionAnswer[]
  checks: SegmentCheck[]
  /** instructions the film does not carry out, and why */
  shortfalls: string[]
}

// ------------------------------------------------------------------ events to the UI (ipc 'apprec:event')

export type PariEvent =
  | { kind: 'pari-plan'; runId: string; plan: FilmPlan; capabilities: CapabilityReport }
  | { kind: 'pari-decide'; runId: string; requests: DecisionRequest[]; /** true = autopilot already answered: show the choices in the log, do not ask */ auto?: boolean }
  | { kind: 'pari-check'; runId: string; check: SegmentCheck }
  | { kind: 'pari-report'; runId: string; report: PariReport }

/** ipc channel the UI answers decisions on: invoke('apprec:decide', answers: DecisionAnswer[] | null)  (null = cancel the run) */
export const DECIDE_CHANNEL = 'apprec:decide'
