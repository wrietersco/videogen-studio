/**
 * Record an app — the things the screen, the main process and the engine all agree on.
 * Plain data only, so it can cross the bridge and be saved as JSON.
 */

import { MAX_STYLE_LINKS, parseYouTubeUrl } from './youtube'
import { isPlatformId } from './shapes'
import type { PlatformId } from './spec'
import type { AgentMode } from './agentBrief'

export type SignInMode = 'saved' | 'self' | 'none' | 'profile'
export type Depth = 'quick' | 'standard' | 'thorough'
export type VideoMode = 'walkthrough' | 'launch'

/** the ticks on the form; all off except staying on the app's own sites */
export interface AppChecks {
  stayOnSites: boolean
  readOnly: boolean
  noDelete: boolean
  noSpend: boolean
  noSettings: boolean
  privacyMode: boolean
}

export const DEFAULT_CHECKS: AppChecks = { stayOnSites: true, readOnly: false, noDelete: false, noSpend: false, noSettings: false, privacyMode: false }

export interface LaunchText {
  feature: string
  tagline: string
  closing: string
  cta: string
}

/** what the person fills in (the password is only ever sent here, never read back) */
export interface AppInput {
  id?: string
  name: string
  url: string
  /** more addresses of the same app; `url` is where the video starts */
  urls?: string[]
  /** what the video should show */
  context: string
  /** an attached document, read as text; treated as information, never as instructions */
  document?: { name: string; text: string } | null
  signIn: SignInMode
  username?: string
  /** set to change the stored password; leave out to keep it */
  password?: string
  guardrailText: string
  checks: AppChecks
  depth: Depth
  /** show the login name in the video (a public demo account); real accounts keep it blurred */
  revealUsername: boolean
  mode: VideoMode
  launch?: LaunchText
  targetSec: number
  /** where the film will be posted, which sets its shape (absent = wide YouTube 1920×1080); a tall or portrait one records the app on a phone screen */
  platform?: PlatformId
  /** use the AI writer and voice when the plan allows; off = the free engine */
  useAi: boolean
  /** allow AI-made video clips (a cutaway illustrating the idea). Sentences in "What should the video show?" that ask for an AI video are carried out whether or not this is ticked. Off by default: clips cost money. */
  aiMedia?: boolean
  /** use Gemini's AI music; the engine chooses the style itself. Off by default. */
  aiMusic?: boolean
  /** PARI agent: 'ask' (default when absent) pauses for the person on every model decision; 'autopilot' decides and reports */
  agentMode?: AgentMode
  reviewFirst: boolean
  /** a brand kit whose logo and colour go on a launch film's cards ('' = none) */
  brandId?: string
  /** where the video's branding comes from: none, one of the person's own brand kits, or the website being recorded (its logo and colours) */
  brandSource?: BrandSource
  /** reference pictures (up to 3) whose colours steer the backdrop and cards, and one reference video whose pace steers the music */
  styleImages: string[]
  styleVideo?: string
  /** up to 3 public YouTube links the AI reads for look, motion graphics, music and narration style (nothing is downloaded) */
  styleLinks?: string[]
  /** what the person likes most about the references, or what to focus on */
  styleNotes?: string
}

export interface SavedApp extends Omit<AppInput, 'password'> {
  id: string
  hasPassword: boolean
  /** the steps of the last finished video are kept, so a later run can reuse them */
  hasPlan?: boolean
  createdAt: string
  updatedAt: string
  lastRunAt?: string
}

export type RunStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** a finished video made again with the changes the person typed */
export interface RecordingRevision {
  /** what the person typed, word for word */
  request: string
  /**
   * how it was made again: 'footage' = the kept screen recording was edited and produced again (minutes, no
   * browser); 'rerecord' = the request changes what is filmed, so the app was recorded again with it added to the brief
   */
  route: 'footage' | 'rerecord'
  /** what was changed, in plain words */
  changed: string[]
  /** what was used again from the earlier video */
  kept: string[]
  /** what was asked but could not be done, and why */
  cannot: string[]
  /** who read the request: the AI writer or the rules */
  source: 'ai' | 'rules'
}

export interface RunRecord {
  id: string
  appId: string
  startedAt: string
  finishedAt?: string
  status: RunStatus
  stage?: string
  video?: string
  durationSec?: number
  pages?: number
  actions?: number
  stoppedBy?: string
  notes: string[]
  error?: string
  blockedHosts?: Array<{ host: string; count: number }>
  enforced?: string[]
  advisory?: string[]
  /** the screen recording and everything the video is made of were kept, so changes can be typed and applied without recording again */
  editable?: boolean
  /** the film is made, but most of the typed steps changed nothing: it is only partly what was asked (the notes say which) */
  partial?: { reason: string }
  /** the video this one was made from by typing changes (that video is kept) */
  parentRunId?: string
  revision?: RecordingRevision
}

export interface ReviewBeat {
  beat: number
  kind: string
  chapter: string
  text: string
  /** a sign-in beat cannot be removed (the sign-in would break) */
  removable: boolean
}

export interface ReviewEdits {
  removeBeats: number[]
  lines: Record<number, string>
}

export type RunEvent =
  | { kind: 'started'; runId: string; appId: string }
  | { kind: 'stage'; runId: string; stage: string; message: string }
  | { kind: 'log'; runId: string; message: string }
  | { kind: 'handoff'; runId: string; reason: string; message: string }
  | { kind: 'review'; runId: string; beats: ReviewBeat[]; advisory: string[]; notes: string[] }
  | { kind: 'done'; runId: string; run: RunRecord }
  | { kind: 'failed'; runId: string; run: RunRecord }
  | { kind: 'cancelled'; runId: string; run: RunRecord }

export const DEPTH_LABELS: Record<Depth, { label: string; hint: string }> = {
  quick: { label: 'Quick', hint: 'The main pages only. Up to 8 pages, about 4 minutes.' },
  standard: { label: 'Standard', hint: 'Pages, searches and view buttons. Up to 25 pages, about 15 minutes.' },
  thorough: { label: 'Thorough', hint: 'Also fills in and submits forms with sample data. Up to 60 pages, about 40 minutes.' }
}

const DEPTHS: Depth[] = ['quick', 'standard', 'thorough']

export type BrandSource = 'none' | 'kit' | 'site'
/** an app saved before the choice existed keeps working: a chosen kit means "my kit" */
export function brandSourceOf(v: unknown, hasKit: boolean): BrandSource {
  if (v === 'site') return 'site'
  if (v === 'kit') return hasKit ? 'kit' : 'none'
  if (v === 'none') return 'none'
  return hasKit ? 'kit' : 'none'
}
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** how many addresses beyond the first one a single app may carry */
export const MAX_EXTRA_URLS = 6

/** one typed address, cleaned the same way everywhere: trimmed, https assumed when no scheme is typed, http/https only */
const parseAddress = (v: unknown): { ok: true; url: string } | { ok: false; why: 'shape' | 'scheme' } => {
  const s = typeof v === 'string' ? v.trim().slice(0, 2000) : ''
  try {
    const p = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`)
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return { ok: false, why: 'scheme' }
    return { ok: true, url: p.toString() }
  } catch {
    return { ok: false, why: 'shape' }
  }
}

/** the single place a screen's input becomes something the main process will store and run */
export function validateApp(raw: unknown): { ok: true; value: AppInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Nothing to save' }
  const r = raw as Record<string, unknown>
  const primary = parseAddress(r.url)
  if (!primary.ok) return { ok: false, error: primary.why === 'scheme' ? 'Only web addresses (http or https) can be recorded' : 'That does not look like a web address' }
  const url = primary.url
  // the extra addresses of the same app, cleaned exactly like the main one; repeats collapse, and only up to MAX_EXTRA_URLS may stay
  const urls: string[] = []
  for (const raw of Array.isArray(r.urls) ? r.urls : []) {
    const s = typeof raw === 'string' ? raw.trim() : ''
    if (!s) continue
    const extra = parseAddress(s)
    if (!extra.ok) return { ok: false, error: extra.why === 'scheme' ? `“${s}” is not a web address — only http or https can be recorded` : `“${s}” does not look like a web address` }
    if (extra.url === url || urls.includes(extra.url)) continue
    if (urls.length >= MAX_EXTRA_URLS) return { ok: false, error: `Up to ${MAX_EXTRA_URLS} extra addresses can be added` }
    urls.push(extra.url)
  }
  const name = str(r.name, 80) || new URL(url).hostname
  const signIn: SignInMode = r.signIn === 'self' || r.signIn === 'none' || r.signIn === 'profile' ? r.signIn : 'saved'
  const depth: Depth = DEPTHS.includes(r.depth as Depth) ? (r.depth as Depth) : 'standard'
  const c = (r.checks && typeof r.checks === 'object' ? r.checks : {}) as Record<string, unknown>
  const checks: AppChecks = {
    stayOnSites: c.stayOnSites !== false,
    readOnly: c.readOnly === true,
    noDelete: c.noDelete === true,
    noSpend: c.noSpend === true,
    noSettings: c.noSettings === true,
    privacyMode: c.privacyMode === true
  }
  const mode: VideoMode = r.mode === 'launch' ? 'launch' : 'walkthrough'
  const l = (r.launch && typeof r.launch === 'object' ? r.launch : {}) as Record<string, unknown>
  const launch: LaunchText | undefined =
    mode === 'launch'
      ? { feature: str(l.feature, 60) || name, tagline: str(l.tagline, 80) || 'Simple. Fast. Safe.', closing: str(l.closing, 60) || 'Try it today', cta: str(l.cta, 30) || 'Available now' }
      : undefined
  const d = r.document && typeof r.document === 'object' ? (r.document as Record<string, unknown>) : null
  const document = d && typeof d.text === 'string' && d.text.trim() ? { name: str(d.name, 120) || 'document', text: d.text.slice(0, 40000) } : null
  const target = Number(r.targetSec)
  const username = str(r.username, 200)
  if (signIn === 'saved' && !r.id && !username) return { ok: false, error: 'Enter the username to sign in with, or choose “I’ll sign in myself”' }
  return {
    ok: true,
    value: {
      id: typeof r.id === 'string' ? r.id : undefined,
      name,
      url,
      // left out entirely when there are none, so a saved app from before this existed stays byte-for-byte the same
      ...(urls.length ? { urls } : {}),
      context: str(r.context, 20000),
      document,
      signIn,
      username: username || undefined,
      password: typeof r.password === 'string' && r.password.length ? r.password.slice(0, 500) : undefined,
      guardrailText: str(r.guardrailText, 4000),
      checks,
      depth,
      revealUsername: r.revealUsername === true,
      mode,
      launch,
      targetSec: Number.isFinite(target) ? Math.max(20, Math.min(120, Math.round(target))) : 44,
      platform: isPlatformId(r.platform) ? r.platform : undefined,
      useAi: r.useAi !== false,
      aiMedia: r.aiMedia === true,
      aiMusic: r.aiMusic === true,
      agentMode: r.agentMode === 'autopilot' ? 'autopilot' : 'ask',
      reviewFirst: r.reviewFirst === true,
      brandId: typeof r.brandId === 'string' && /^[\w-]{1,60}$/.test(r.brandId) ? r.brandId : undefined,
      brandSource: brandSourceOf(r.brandSource, typeof r.brandId === 'string' && /^[\w-]{1,60}$/.test(r.brandId)),
      styleImages: (Array.isArray(r.styleImages) ? r.styleImages : []).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 600).slice(0, 3),
      styleVideo: typeof r.styleVideo === 'string' && r.styleVideo.length > 0 && r.styleVideo.length < 600 ? r.styleVideo : undefined,
      styleLinks: [...new Set((Array.isArray(r.styleLinks) ? r.styleLinks : []).map((x) => (typeof x === 'string' ? parseYouTubeUrl(x)?.url : undefined)).filter((x): x is string => !!x))].slice(0, MAX_STYLE_LINKS),
      styleNotes: str(r.styleNotes, 1000)
    }
  }
}

export const isAppId = (s: unknown): s is string => typeof s === 'string' && /^app-[a-z0-9]{6,24}$/.test(s)
export const isRunId = (s: unknown): s is string => typeof s === 'string' && /^run-[a-z0-9-]{6,40}$/.test(s)
