/**
 * Market your business — the things the screen, the main process and the
 * engine all agree on. Plain data only, so it can cross the bridge and be
 * saved as JSON.
 */

import type { PlatformId } from './spec'
import { isPlatformId } from './shapes'
import type { MarketPariEvent } from './marketBrief'
import type { AgentMode } from './agentBrief'

/** one service the business sells, as read from its website */
export interface ServiceInfo {
  name: string
  /** the page it was read from */
  url: string
  summary: string
  /** what the customer gets, in the customer's words */
  benefits: string[]
  audience?: string
  /** the service's own pictures from the site, saved in the business folder (absent on profiles read before pictures were kept) */
  images?: string[]
}

/** a problem–solution video the person can edit and then have made */
export interface VideoCard {
  id: string
  title: string
  /** the customer's trouble, in everyday words; never names the business */
  problem: string
  /** how the business answers that trouble */
  solution: string
  /** the last thing the viewer is asked to do */
  cta: string
  /** which service this card sells (index into the profile), when it is about one */
  serviceIdx?: number
  /** length to aim for */
  targetSec: number
  /** where the film will be posted, which sets its shape (absent = wide YouTube 1920×1080) */
  platform?: PlatformId
  /** what the person wants this video to say and how it should feel, in their own words ('' = the card alone) */
  brief?: string
  /** the video this card last made, and how it ended */
  runId?: string
  video?: string
}

export interface BusinessBrand {
  /** the site's own colours, as hex with # */
  colors: string[]
  /** the accent for the cards: hex without #, readable on a dark card */
  accent?: string
  /** two CSS colours for the backdrop gradient */
  backdrop?: [string, string]
  /** the logo prepared for dark cards, when one was found */
  logoFile?: string
  /** product pictures from the site that belong to no one service, saved in the business folder */
  productImages?: string[]
}

export interface BusinessProfile {
  id: string
  /** the domain the person typed, e.g. example.com */
  domain: string
  name: string
  tagline: string
  about: string
  services: ServiceInfo[]
  brand: BusinessBrand
  cards: VideoCard[]
  /** where the unified markdown of the site is kept (relative to the profile folder) */
  siteMd: string
  /** 'ask' (default) = the agent asks before choosing models; 'autopilot' = it decides and tells afterwards */
  agentMode?: AgentMode
  notes: string[]
  createdAt: string
  updatedAt: string
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface MarketRunRecord {
  id: string
  businessId: string
  cardId: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  stage?: string
  video?: string
  durationSec?: number
  /** what the engine put in the film, shown under the card */
  notes: string[]
  /** what the film does not carry out of what was asked, and why (empty = everything is in it) */
  shortfalls?: string[]
  error?: string
}

/** the two jobs the feature runs: reading the website, and making one card's film */
export type MarketJob = 'analyze' | 'film'

export type MarketStage = 'fetch' | 'read' | 'brand' | 'ideas' | 'plan' | 'script' | 'voice' | 'media' | 'assemble'

export type MarketEvent =
  | { kind: 'started'; businessId: string; job: MarketJob; runId?: string; cardId?: string }
  | { kind: 'stage'; businessId: string; job: MarketJob; runId?: string; stage: MarketStage; message: string }
  | { kind: 'log'; businessId: string; job: MarketJob; runId?: string; message: string }
  | { kind: 'done'; businessId: string; job: MarketJob; runId?: string; profile?: BusinessProfile; run?: MarketRunRecord }
  | { kind: 'failed'; businessId: string; job: MarketJob; runId?: string; error: string; run?: MarketRunRecord }
  | { kind: 'cancelled'; businessId: string; job: MarketJob; runId?: string; run?: MarketRunRecord }
  | MarketPariEvent

const ID = /^[a-z]+-[0-9a-f]{8,24}$/

export const isBusinessId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
export const isMarketRunId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
export const isCardId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

/**
 * A domain the person typed, made safe: "example.com", "https://example.com/"
 * and "www.example.com/pricing" all become one site address. Local and
 * private addresses are refused unless the engine asks for them (tests).
 */
export function normalizeDomain(input: string, allowPrivate = false): { ok: true; url: string; host: string } | { ok: false; error: string } {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: 'Type your website address, for example example.com' }
  if (raw.length > 200) return { ok: false, error: 'That address is too long' }
  if (/[\s`"'<>|]/.test(raw)) return { ok: false, error: 'That does not look like a website address' }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return { ok: false, error: 'That does not look like a website address' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: 'Only http and https addresses can be read' }
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const privateHost = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$)/i.test(host)
  if (!host.includes('.') && !privateHost) return { ok: false, error: 'Type the whole address, for example example.com' }
  if (privateHost && !allowPrivate) return { ok: false, error: 'That is a private address. Type your public website, for example example.com' }
  // the site is read from its home page, whatever path was pasted (a port is kept: tests read a local server)
  const origin = `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}/`
  return { ok: true, url: origin, host }
}

/** what a card may hold — trimmed and length-checked, so a paste can never break a film */
export function cardPatchOf(raw: unknown): Partial<VideoCard> {
  const p = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : undefined)
  const out: Partial<VideoCard> = {}
  const title = str(p.title, 80)
  if (title) out.title = title
  const problem = str(p.problem, 400)
  if (problem) out.problem = problem
  const solution = str(p.solution, 400)
  if (solution) out.solution = solution
  const cta = str(p.cta, 60)
  if (cta) out.cta = cta
  if (typeof p.brief === 'string') out.brief = cleanBrief(p.brief)
  if (typeof p.serviceIdx === 'number' && Number.isInteger(p.serviceIdx) && p.serviceIdx >= 0) out.serviceIdx = p.serviceIdx
  if (typeof p.targetSec === 'number' && p.targetSec >= 15 && p.targetSec <= 90) out.targetSec = Math.round(p.targetSec)
  if (isPlatformId(p.platform)) out.platform = p.platform
  return out
}


/** a brief keeps its line breaks but not stray spaces, carriage returns or long runs of blank lines */
export function cleanBrief(raw: string): string {
  const lines = raw.replace(/\r/g, '').replace(/\t/g, ' ').split('\n').map((l) => l.replace(/ {2,}/g, ' ').trim())
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 2000)
}
