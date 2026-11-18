/**
 * PARI for "Market my business": Plan → Act → Review → Iterate.
 *
 * The person's brief (what this one video must say and how it should feel) and
 * the card they edited become a MarketPlan. The plan is checked against what
 * this account can do (models, clips left), the person is asked or autopilot
 * decides, the film is made from the plan, and every part is checked against
 * what was asked. Nothing the person wrote is silently dropped: what the
 * film does not carry goes into `unplaced` and the final report.
 *
 * The decision, capability and music types are the ones "Record an app" uses.
 */
import type { CapabilityReport, DecisionAnswer, DecisionRequest, JobAssignment, MusicSpec, SegmentCheck } from './agentBrief'
import type { PlatformId } from './spec'

/** how a part of the film is shown: an AI video clip, an AI picture, an animated card, or the engine's choice */
export type Show = 'clip' | 'image' | 'scene' | 'any'

/** the trouble that opens the film */
export interface MarketProblem {
  /** the trouble in the customer's everyday words (never names the business) */
  say: string
  /** the person's own words it came from ('' = taken from the card) */
  said: string
  show: 'clip' | 'scene'
  /** what the shot should look like, when the person described it */
  visual?: string
}

/** one thing the film must get across */
export interface MarketPoint {
  /** stable id ("p1", "p2"…), in film order */
  id: string
  /** what this part must get across, in plain words */
  say: string
  /** the person's own words it came from ('' = taken from the card) */
  said: string
  show: Show
  /** what the shot should look like, when the person described it */
  visual?: string
  /** false = a nice-to-have the film may drop to stay short; true = the person asked for it outright */
  required: boolean
  /** whole seconds the person asked this part to last */
  seconds?: number
}

export interface MarketPlan {
  /** the film's purpose in one sentence */
  goal: string
  /** the service the film sells, by its name on the profile */
  service?: string
  /** who it is for, if said */
  audience?: string
  problem: MarketProblem
  points: MarketPoint[]
  close: {
    /** the last words: the business and the next step */
    say: string
    /** the call to action, short */
    cta: string
    said: string
  }
  /** things the person said must NOT be mentioned or shown ("prices", "competitors") */
  avoid: string[]
  music: MusicSpec
  /** narration tone and language, if said */
  voice: { tone?: string; language?: string; none?: boolean }
  /** look for AI pictures and clips, if said */
  look: { style: 'infographic' | 'cinematic' | null; noAbstract: boolean }
  /** target length in seconds, if said */
  targetSec?: number
  /** where it will be posted, if the brief says so (it wins over the card's choice) */
  platform?: PlatformId
  /** every instruction the reader could NOT place, word for word. Never dropped silently. */
  unplaced: string[]
  source: 'ai' | 'rules' | 'card'
}

export interface MarketBriefInput {
  /** the brief the person typed; '' = none, the card alone is the brief */
  brief: string
  business: { name: string; tagline: string; about: string; services: Array<{ name: string; summary: string; benefits: string[] }> }
  card: { title: string; problem: string; solution: string; cta: string; serviceIdx?: number; targetSec: number; platform?: PlatformId }
}

/** what the film actually made for one part, so the review can compare it with what was asked */
export interface MadePart {
  /** 'problem', 'p1'…, 'close' */
  id: string
  /** what was asked for */
  wanted: Show | 'close'
  /** what was made */
  made: 'clip' | 'image' | 'scene'
  /** the words spoken over it */
  line: string
  /** why a clip or picture became an animated card, in plain words */
  fellBack?: string
  /** tries made to get the wanted element */
  attempts: number
  /** the pictures of an earlier film were used again (a revision) */
  reused?: boolean
}

export interface MarketReport {
  plan: MarketPlan
  assignment: JobAssignment
  decisions: DecisionAnswer[]
  checks: SegmentCheck[]
  /** instructions the film does not carry out, and why */
  shortfalls: string[]
  /** the film's length against the one asked for */
  durationSec?: number
  /** this film is a revision of an earlier one: what was changed, kept and could not be done */
  revision?: MarketRevision
}

/** a finished film made again with the changes the person typed */
export interface MarketRevision {
  /** what the person typed, word for word */
  request: string
  /** the film this one was made from */
  parentRunId: string
  /** what was changed, in plain words */
  changed: string[]
  /** what was used again from the earlier film */
  kept: string[]
  /** what was asked but could not be done, and why */
  cannot: string[]
  /** who read the request: the AI writer or the rules */
  source: 'ai' | 'rules'
}

/** events to the screen (inside 'market:event') */
export type MarketPariEvent =
  | { kind: 'pari-plan'; businessId: string; runId: string; plan: MarketPlan; capabilities: CapabilityReport }
  | { kind: 'pari-decide'; businessId: string; runId: string; requests: DecisionRequest[]; /** true = autopilot already answered: show the choices in the log, do not ask */ auto?: boolean }
  | { kind: 'pari-check'; businessId: string; runId: string; check: SegmentCheck }
  | { kind: 'pari-report'; businessId: string; runId: string; report: MarketReport }

/** ipc channel the screen answers decisions on: invoke('market:decide', answers | null)  (null = stop) */
export const MARKET_DECIDE_CHANNEL = 'market:decide'
