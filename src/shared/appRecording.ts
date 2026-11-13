/**
 * Record an app — the things the screen, the main process and the engine all agree on.
 * Plain data only, so it can cross the bridge and be saved as JSON.
 */

export type SignInMode = 'saved' | 'self' | 'none'
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
  /** use the AI writer and voice when the plan allows; off = the free engine */
  useAi: boolean
  reviewFirst: boolean
  /** a brand kit whose logo and colour go on a launch film's cards ('' = none) */
  brandId?: string
  /** reference pictures (up to 3) whose colours steer the backdrop and cards, and one reference video whose pace steers the music */
  styleImages: string[]
  styleVideo?: string
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
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** the single place a screen's input becomes something the main process will store and run */
export function validateApp(raw: unknown): { ok: true; value: AppInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Nothing to save' }
  const r = raw as Record<string, unknown>
  const url = str(r.url, 2000)
  let parsed: URL
  try {
    parsed = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`)
  } catch {
    return { ok: false, error: 'That does not look like a web address' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, error: 'Only web addresses (http or https) can be recorded' }
  const name = str(r.name, 80) || parsed.hostname
  const signIn: SignInMode = r.signIn === 'self' || r.signIn === 'none' ? r.signIn : 'saved'
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
      url: parsed.toString(),
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
      useAi: r.useAi !== false,
      reviewFirst: r.reviewFirst === true,
      brandId: typeof r.brandId === 'string' && /^[\w-]{1,60}$/.test(r.brandId) ? r.brandId : undefined,
      styleImages: (Array.isArray(r.styleImages) ? r.styleImages : []).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 600).slice(0, 3),
      styleVideo: typeof r.styleVideo === 'string' && r.styleVideo.length > 0 && r.styleVideo.length < 600 ? r.styleVideo : undefined
    }
  }
}

export const isAppId = (s: unknown): s is string => typeof s === 'string' && /^app-[a-z0-9]{6,24}$/.test(s)
export const isRunId = (s: unknown): s is string => typeof s === 'string' && /^run-[a-z0-9-]{6,40}$/.test(s)
