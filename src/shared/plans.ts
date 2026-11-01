/**
 * Plans, quotas and the licence ladder — shared by the desktop app (to show
 * what a plan includes) and the licence server (which is the only place any
 * of it is enforced). Every function here is pure: (policy, account, usage,
 * now) in, a verdict out, so the whole state machine is testable without a
 * network or a database.
 *
 * Two kinds of video:
 *   programmatic  made on the user's PC from code and templates, no AI call.
 *                 Unlimited on every plan; the server never sees it.
 *   AI video      planned, directed and painted by AI models that the server
 *                 runs with its own keys. Counted once per project per month
 *                 against the plan's allowance, and fused by dollars per
 *                 video and per month so a runaway edit loop cannot cost more
 *                 than a known amount.
 *
 * The superadmin edits the policy (numbers, model lists, prices) and may
 * override any one licence; nothing here is hard-wired into a release.
 */

export type PlanId = 'free' | 'plus' | 'pro' | 'ultra'
export const PLAN_IDS: readonly PlanId[] = ['free', 'plus', 'pro', 'ultra']

/** media kinds a plan lists models for */
export type PlanMediaKind = 'chat' | 'image' | 'voice' | 'music' | 'video'
export const PLAN_MEDIA_KINDS: readonly PlanMediaKind[] = ['chat', 'image', 'voice', 'music', 'video']

export interface PlanPolicy {
  label: string
  /** what the plan sells for, shown in the app and the panel; billing is manual */
  priceUsdMonthly: number
  /** AI videos per seat per month; null = unlimited */
  aiVideosPerMonth: number | null
  /** the plan's headline chat model — the default the app picks */
  chatModel: string
  /** every model id the server will run for this plan, by kind */
  models: Record<PlanMediaKind, string[]>
  /** AI-animated clips per video (Gemini Omni ≈ $0.80 each) */
  clipsPerVideo: number
  /** longest AI video the server will start */
  maxVideoSeconds: number
  /** dollar fuse for one video, its edits and re-makes included */
  costCapUsdPerVideo: number
  /** dollar fuse per seat per month, all AI use together */
  costCapUsdPerMonth: number
  /** small AI helpers outside a video (prompt polish, one-off library pictures) */
  utilityUsdPerDay: number
}

export interface Policy {
  plans: Record<PlanId, PlanPolicy>
  /** a new free account may try a better plan for a few days */
  trial: { days: number; plan: PlanId; aiVideos: number }
  /** days of full service after a paid licence lapses */
  graceDays: number
  /** then days on Free allowances before AI stops altogether */
  freeFallbackDays: number
  /** computers one seat may use */
  devicesPerSeat: number
  /** no AI until the account's email is verified (stops throwaway sign-ups) */
  requireVerifiedEmail: boolean
}

/** utility models every plan may call: Whisper times narration words for captions */
export const UTILITY_MODELS: readonly string[] = ['whisper-1']

const FREE_MEDIA = {
  chat: ['gpt-6-luna'],
  image: ['gemini-nano-banana-2.1'],
  voice: ['gpt-4o-mini-tts', 'gemini-2.5-flash-preview-tts'],
  music: [] as string[],
  video: [] as string[]
}
const PLUS_MEDIA = {
  chat: ['gpt-6-luna'],
  image: [...FREE_MEDIA.image, 'gemini-3.1-flash-image', 'gemini-3.1-flash-lite-image'],
  voice: [...FREE_MEDIA.voice, 'eleven_flash_v2_5', 'eleven_turbo_v2_5'],
  music: ['lyria-3.5'],
  video: ['gemini-omni-1.1-flash']
}
const BEST_MEDIA = {
  image: [...PLUS_MEDIA.image, 'gemini-3-pro-image', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'],
  voice: [...PLUS_MEDIA.voice, 'eleven_multilingual_v2', 'eleven_v3', 'gemini-2.5-pro-preview-tts'],
  music: [...PLUS_MEDIA.music, 'music_v1'],
  video: [...PLUS_MEDIA.video]
}

/**
 * Defaults, priced from the shipped price book (estimateVideoCost): a 60 s
 * directed video costs about $0.24 on Free's models, $0.46 + $0.81 per clip on
 * Plus, $1.40 + clips on Pro (Terra) and $1.60 + clips on Ultra (Sol). The
 * per-video fuse leaves room for edits; the monthly fuse is ~1.5× a month of
 * full-length videos, so it only trips on abuse.
 */
export const DEFAULT_POLICY: Policy = {
  plans: {
    free: {
      label: 'Free',
      priceUsdMonthly: 0,
      aiVideosPerMonth: 3,
      chatModel: 'gpt-6-luna',
      models: FREE_MEDIA,
      clipsPerVideo: 0,
      maxVideoSeconds: 60,
      costCapUsdPerVideo: 0.6,
      costCapUsdPerMonth: 1.5,
      utilityUsdPerDay: 0.02
    },
    plus: {
      label: 'Plus',
      priceUsdMonthly: 19,
      aiVideosPerMonth: 10,
      chatModel: 'gpt-6-luna',
      models: PLUS_MEDIA,
      clipsPerVideo: 1,
      maxVideoSeconds: 90,
      costCapUsdPerVideo: 2.5,
      costCapUsdPerMonth: 20,
      utilityUsdPerDay: 0.1
    },
    pro: {
      label: 'Pro',
      priceUsdMonthly: 59,
      aiVideosPerMonth: 15,
      chatModel: 'gpt-6.1-terra',
      models: { chat: ['gpt-6-luna', 'gpt-6.1-terra'], ...BEST_MEDIA },
      clipsPerVideo: 2,
      maxVideoSeconds: 120,
      costCapUsdPerVideo: 5,
      costCapUsdPerMonth: 60,
      utilityUsdPerDay: 0.25
    },
    ultra: {
      label: 'Ultra',
      priceUsdMonthly: 149,
      aiVideosPerMonth: 27,
      chatModel: 'gpt-6.1-sol',
      models: { chat: ['gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'], ...BEST_MEDIA },
      clipsPerVideo: 3,
      maxVideoSeconds: 180,
      costCapUsdPerVideo: 7,
      costCapUsdPerMonth: 150,
      utilityUsdPerDay: 0.5
    }
  },
  trial: { days: 7, plan: 'plus', aiVideos: 2 },
  graceDays: 7,
  freeFallbackDays: 14,
  devicesPerSeat: 2,
  requireVerifiedEmail: true
}

// ---------------- policy merge + validation ----------------

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function num(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i

/** the stored policy laid over the defaults, so a partial edit never leaves a hole */
export function mergePolicy(stored: unknown): Policy {
  const policy = clone(DEFAULT_POLICY)
  if (!stored || typeof stored !== 'object') return policy
  const s = stored as Partial<Record<keyof Policy, unknown>>
  const plans = (s.plans ?? {}) as Record<string, Partial<PlanPolicy>>
  for (const id of PLAN_IDS) {
    const p = plans[id]
    if (!p || typeof p !== 'object') continue
    Object.assign(policy.plans[id], cleanPlan(p, policy.plans[id]))
  }
  const t = (s.trial ?? {}) as Partial<Policy['trial']>
  if (num(t.days, 0, 90) !== undefined) policy.trial.days = num(t.days, 0, 90)!
  if (t.plan && PLAN_IDS.includes(t.plan)) policy.trial.plan = t.plan
  if (num(t.aiVideos, 0, 1000) !== undefined) policy.trial.aiVideos = Math.floor(num(t.aiVideos, 0, 1000)!)
  if (num(s.graceDays, 0, 90) !== undefined) policy.graceDays = Math.floor(num(s.graceDays, 0, 90)!)
  if (num(s.freeFallbackDays, 0, 365) !== undefined) policy.freeFallbackDays = Math.floor(num(s.freeFallbackDays, 0, 365)!)
  if (num(s.devicesPerSeat, 1, 20) !== undefined) policy.devicesPerSeat = Math.floor(num(s.devicesPerSeat, 1, 20)!)
  if (typeof s.requireVerifiedEmail === 'boolean') policy.requireVerifiedEmail = s.requireVerifiedEmail
  return policy
}

function cleanPlan(p: Partial<PlanPolicy>, base: PlanPolicy): Partial<PlanPolicy> {
  const out: Partial<PlanPolicy> = {}
  if (typeof p.label === 'string' && p.label.trim()) out.label = p.label.trim().slice(0, 30)
  if (num(p.priceUsdMonthly, 0, 100_000) !== undefined) out.priceUsdMonthly = num(p.priceUsdMonthly, 0, 100_000)
  if (p.aiVideosPerMonth === null) out.aiVideosPerMonth = null
  else if (num(p.aiVideosPerMonth, 0, 100_000) !== undefined) out.aiVideosPerMonth = Math.floor(num(p.aiVideosPerMonth, 0, 100_000)!)
  if (num(p.clipsPerVideo, 0, 12) !== undefined) out.clipsPerVideo = Math.floor(num(p.clipsPerVideo, 0, 12)!)
  if (num(p.maxVideoSeconds, 10, 1800) !== undefined) out.maxVideoSeconds = Math.floor(num(p.maxVideoSeconds, 10, 1800)!)
  if (num(p.costCapUsdPerVideo, 0, 1000) !== undefined) out.costCapUsdPerVideo = num(p.costCapUsdPerVideo, 0, 1000)
  if (num(p.costCapUsdPerMonth, 0, 100_000) !== undefined) out.costCapUsdPerMonth = num(p.costCapUsdPerMonth, 0, 100_000)
  if (num(p.utilityUsdPerDay, 0, 100) !== undefined) out.utilityUsdPerDay = num(p.utilityUsdPerDay, 0, 100)
  if (p.models && typeof p.models === 'object') {
    const models = clone(base.models)
    for (const kind of PLAN_MEDIA_KINDS) {
      const list = (p.models as Record<string, unknown>)[kind]
      if (Array.isArray(list)) models[kind] = [...new Set(list.filter((m): m is string => typeof m === 'string' && MODEL_ID.test(m)))].slice(0, 40)
    }
    out.models = models
  }
  if (typeof p.chatModel === 'string' && MODEL_ID.test(p.chatModel)) out.chatModel = p.chatModel
  const chat = out.models?.chat ?? base.models.chat
  const head = out.chatModel ?? base.chatModel
  if (!chat.includes(head)) out.chatModel = chat[chat.length - 1] ?? head
  return out
}

/**
 * What the panel may write. Throws a readable reason instead of silently
 * dropping a bad value, so the superadmin sees why a save did nothing.
 */
export function validatePolicyUpdate(payload: unknown): Policy {
  if (!payload || typeof payload !== 'object') throw new Error('Policy must be an object.')
  const p = payload as Record<string, unknown>
  const plans = (p.plans ?? {}) as Record<string, Record<string, unknown>>
  for (const [id, plan] of Object.entries(plans)) {
    if (!PLAN_IDS.includes(id as PlanId)) throw new Error(`Unknown plan "${id}". Plans are ${PLAN_IDS.join(', ')}.`)
    if (!plan || typeof plan !== 'object') throw new Error(`Plan "${id}" must be an object.`)
    const v = plan.aiVideosPerMonth
    if (v !== undefined && v !== null && num(v, 0, 100_000) === undefined) throw new Error(`${id}: AI videos per month must be 0–100000, or empty for unlimited.`)
    for (const [field, max] of [['costCapUsdPerVideo', 1000], ['costCapUsdPerMonth', 100_000], ['priceUsdMonthly', 100_000], ['utilityUsdPerDay', 100]] as const) {
      if (plan[field] !== undefined && num(plan[field], 0, max) === undefined) throw new Error(`${id}: ${field} must be a number from 0 to ${max}.`)
    }
    if (plan.clipsPerVideo !== undefined && num(plan.clipsPerVideo, 0, 12) === undefined) throw new Error(`${id}: clips per video must be 0–12.`)
    if (plan.maxVideoSeconds !== undefined && num(plan.maxVideoSeconds, 10, 1800) === undefined) throw new Error(`${id}: longest video must be 10–1800 seconds.`)
    const models = plan.models as Record<string, unknown> | undefined
    if (models) {
      for (const [kind, list] of Object.entries(models)) {
        if (!PLAN_MEDIA_KINDS.includes(kind as PlanMediaKind)) throw new Error(`${id}: unknown model kind "${kind}".`)
        if (!Array.isArray(list) || list.some((m) => typeof m !== 'string' || !MODEL_ID.test(m))) throw new Error(`${id}: ${kind} models must be a list of model ids.`)
      }
      if (Array.isArray(models.chat) && models.chat.length === 0) throw new Error(`${id}: a plan needs at least one chat model.`)
    }
  }
  return mergePolicy(payload)
}

// ---------------- accounts, licences, the lapse ladder ----------------

/** a licence key the superadmin sells; one key may carry several seats */
export interface License {
  id: string
  plan: PlanId
  seats: number
  status: 'active' | 'suspended'
  /** end of the paid period (ISO); null = no billing date set, treated as paid */
  paidThrough: string | null
  /** the superadmin let this licence use its own provider keys (no counting) */
  allowOwnKeys: boolean
  /** per-licence numbers that beat the plan's (totals, not per seat) */
  overrides?: { aiVideosPerMonth?: number | null; costCapUsdPerMonth?: number | null; clipsPerVideo?: number | null }
}

export interface Account {
  uid: string
  email: string
  emailVerified: boolean
  status: 'active' | 'blocked'
  licenseId?: string | null
  /** free-trial end (ISO), set once when the account is created */
  trialEndsAt?: string | null
}

export type AccessState = 'active' | 'grace' | 'free_only' | 'suspended'

export interface Access {
  state: AccessState
  /** shown to people: names dates, not codes */
  reason: string
  paidThrough: string | null
  graceEndsAt: string | null
}

const DAY = 86_400_000
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/**
 * Where a paid licence sits on the lapse ladder. It walks down rather than
 * dropping straight to "off": cutting a paying customer off mid-project over a
 * late bank transfer costs more goodwill than the invoice is worth.
 *   active → grace (full plan, banner) → free_only (Free allowances) → suspended
 */
export function accessState(policy: Policy, license: License | null, now: Date): Access {
  if (!license) return { state: 'active', reason: '', paidThrough: null, graceEndsAt: null }
  if (license.status === 'suspended') {
    return { state: 'suspended', reason: 'This licence has been suspended. Contact support.', paidThrough: license.paidThrough, graceEndsAt: null }
  }
  const paid = license.paidThrough ? Date.parse(license.paidThrough) : NaN
  if (!Number.isFinite(paid)) return { state: 'active', reason: '', paidThrough: null, graceEndsAt: null }
  const graceEnds = paid + policy.graceDays * DAY
  const fallbackEnds = graceEnds + policy.freeFallbackDays * DAY
  const t = now.getTime()
  const base = { paidThrough: license.paidThrough, graceEndsAt: new Date(graceEnds).toISOString() }
  if (t <= paid) return { state: 'active', reason: '', ...base }
  if (t <= graceEnds) {
    return { state: 'grace', reason: `Your plan lapsed on ${isoDay(paid)}. Everything keeps working until ${isoDay(graceEnds)}.`, ...base }
  }
  if (t <= fallbackEnds) {
    return { state: 'free_only', reason: `Payment is ${Math.floor((t - paid) / DAY)} days overdue, so you are on Free allowances until the plan is renewed.`, ...base }
  }
  return { state: 'suspended', reason: `Payment is ${Math.floor((t - paid) / DAY)} days overdue. AI videos are paused until the plan is renewed.`, ...base }
}

export interface Entitlements {
  plan: PlanId
  /** the plan sold, when a lapse has the account running on less */
  soldPlan: PlanId
  label: string
  access: Access
  trial: { active: boolean; endsAt: string | null; daysLeft: number }
  /** AI videos this month; null = unlimited */
  aiVideosPerMonth: number | null
  chatModel: string
  models: Record<PlanMediaKind, string[]>
  clipsPerVideo: number
  maxVideoSeconds: number
  costCapUsdPerVideo: number
  costCapUsdPerMonth: number
  utilityUsdPerDay: number
  seats: number
  allowOwnKeys: boolean
  /** false when no AI may run at all (blocked account, suspended licence) */
  aiAllowed: boolean
  /** why AI is off, for people */
  aiBlockedReason: string
  /** a superadmin: sees models and costs, and nothing is limited */
  superadmin?: boolean
}

/**
 * Everything an account may do right now. A licence's plan applies unless the
 * lapse ladder says otherwise; a free account inside its trial gets the trial
 * plan's models, but only the trial's own count of videos.
 */
export function entitlements(policy: Policy, account: Account, license: License | null, now: Date): Entitlements {
  const access = accessState(policy, license, now)
  const sold: PlanId = license?.plan ?? 'free'
  const trialEnds = account.trialEndsAt ? Date.parse(account.trialEndsAt) : NaN
  const trialActive = !license && Number.isFinite(trialEnds) && now.getTime() < trialEnds && policy.trial.days > 0
  let plan: PlanId = access.state === 'free_only' ? 'free' : sold
  if (trialActive) plan = policy.trial.plan
  const p = policy.plans[plan]
  const seats = license && plan !== 'free' ? Math.max(1, Math.floor(license.seats || 1)) : 1
  const o = (access.state === 'active' || access.state === 'grace') ? license?.overrides ?? {} : {}

  let videos: number | null = p.aiVideosPerMonth === null ? null : p.aiVideosPerMonth * seats
  if (trialActive) videos = Math.max(policy.plans.free.aiVideosPerMonth ?? 0, policy.trial.aiVideos)
  if (o.aiVideosPerMonth !== undefined) videos = o.aiVideosPerMonth

  let aiBlockedReason = ''
  if (account.status === 'blocked') aiBlockedReason = 'This account has been blocked. Contact support.'
  else if (access.state === 'suspended') aiBlockedReason = access.reason
  else if (policy.requireVerifiedEmail && !account.emailVerified) aiBlockedReason = 'Verify your email address to make AI videos.'

  return {
    plan,
    soldPlan: sold,
    label: p.label,
    access,
    trial: { active: trialActive, endsAt: trialActive ? account.trialEndsAt ?? null : null, daysLeft: trialActive ? Math.ceil((trialEnds - now.getTime()) / DAY) : 0 },
    aiVideosPerMonth: videos,
    chatModel: p.chatModel,
    models: clone(p.models),
    clipsPerVideo: o.clipsPerVideo ?? p.clipsPerVideo,
    maxVideoSeconds: p.maxVideoSeconds,
    costCapUsdPerVideo: p.costCapUsdPerVideo,
    costCapUsdPerMonth: o.costCapUsdPerMonth ?? +(p.costCapUsdPerMonth * seats).toFixed(2),
    utilityUsdPerDay: p.utilityUsdPerDay,
    seats,
    allowOwnKeys: Boolean(license?.allowOwnKeys) && (access.state === 'active' || access.state === 'grace'),
    aiAllowed: !aiBlockedReason,
    aiBlockedReason
  }
}

/** which provider runs a model id */
export function providerOfModel(model: string): 'openai' | 'gemini' | 'elevenlabs' {
  if (/^gpt-|^whisper|^tts-/.test(model)) return 'openai'
  if (/^eleven_|^music_v1$/.test(model)) return 'elevenlabs'
  return 'gemini'
}

/**
 * Drop models whose provider the server has no key for, so the app never
 * picks an engine that would only fail (it falls back to free stock instead).
 */
export function withProviders(ent: Entitlements, available: ReadonlySet<string>): Entitlements {
  const models = Object.fromEntries(PLAN_MEDIA_KINDS.map((k) => [k, ent.models[k].filter((m) => available.has(providerOfModel(m)))])) as Entitlements['models']
  return { ...ent, models, chatModel: models.chat.includes(ent.chatModel) ? ent.chatModel : models.chat[models.chat.length - 1] ?? ent.chatModel, clipsPerVideo: models.video.length ? ent.clipsPerVideo : 0 }
}

/**
 * Superadmins: every model of every plan, no monthly count, no dollar fuses,
 * own keys allowed, never blocked by billing. Granted only by the server from
 * its own allow-list (vg_admins / vg_admin_emails), never by the app.
 */
export const UNRESTRICTED = 1_000_000

export function superadminEntitlements(policy: Policy, base: Entitlements): Entitlements {
  const all = (kind: PlanMediaKind) => [...new Set(PLAN_IDS.flatMap((id) => policy.plans[id].models[kind]))]
  const models = Object.fromEntries(PLAN_MEDIA_KINDS.map((k) => [k, all(k)])) as Entitlements['models']
  return {
    ...base,
    plan: 'ultra',
    label: 'Superadmin',
    access: { state: 'active', reason: '', paidThrough: null, graceEndsAt: null },
    trial: { active: false, endsAt: null, daysLeft: 0 },
    aiVideosPerMonth: null,
    chatModel: policy.plans.ultra.chatModel,
    models,
    clipsPerVideo: Math.max(...PLAN_IDS.map((id) => policy.plans[id].clipsPerVideo)),
    maxVideoSeconds: 1800,
    costCapUsdPerVideo: UNRESTRICTED,
    costCapUsdPerMonth: UNRESTRICTED,
    utilityUsdPerDay: UNRESTRICTED,
    allowOwnKeys: true,
    aiAllowed: true,
    aiBlockedReason: '',
    superadmin: true
  }
}

// ---------------- usage + the gates ----------------

/** one month of AI use for a subject (a licence, or a free account) */
export interface MonthUsage {
  month: string
  /** projects counted as AI videos this month */
  videoKeys: string[]
  costUsd: number
  /** utility spend by day (YYYY-MM-DD → $) */
  utilityByDay: Record<string, number>
}

export const monthKey = (now: Date): string => now.toISOString().slice(0, 7)
export const dayKey = (now: Date): string => now.toISOString().slice(0, 10)
export function nextMonthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

/** an AI video's running tab: created by /videos/start, charged by every call */
export interface Grant {
  projectKey: string
  plan: PlanId
  /** models the plan allowed when the video started */
  models: Record<PlanMediaKind, string[]>
  costUsd: number
  costCapUsd: number
  clips: number
  clipsAllowed: number
  createdAt: string
  /** the month it was counted in */
  month: string
}

export interface Verdict {
  allowed: boolean
  code: string
  message: string
}
const ok: Verdict = { allowed: true, code: 'ok', message: '' }
const no = (code: string, message: string): Verdict => ({ allowed: false, code, message })

export function videosLeft(ent: Entitlements, usage: MonthUsage): number | null {
  return ent.aiVideosPerMonth === null ? null : Math.max(0, ent.aiVideosPerMonth - usage.videoKeys.length)
}

/**
 * Whether an AI video may start (or an earlier one be reopened for edits).
 * A project already counted this month is never counted again; editing it
 * only meets the dollar fuses.
 */
export function checkStartVideo(ent: Entitlements, usage: MonthUsage, existing: Grant | null, req: { durationSec?: number }, now: Date): Verdict & { counts: boolean } {
  if (!ent.aiAllowed) return { ...no('ai_blocked', ent.aiBlockedReason), counts: false }
  if (usage.costUsd >= ent.costCapUsdPerMonth) {
    return { ...no('monthly_cost_cap', `This month's AI spending limit is reached. It resets on ${nextMonthStart(now).slice(0, 10)}.`), counts: false }
  }
  if (req.durationSec && req.durationSec > ent.maxVideoSeconds) {
    return { ...no('too_long', `${ent.label} makes AI videos up to ${ent.maxVideoSeconds} seconds. Pick a shorter length or upgrade.`), counts: false }
  }
  const counted = usage.videoKeys.includes(existing?.projectKey ?? '\u0000')
  if (existing && counted) {
    if (existing.costUsd >= existing.costCapUsd) return { ...no('video_cost_cap', 'This video has used its AI budget. Start a new video to keep going.'), counts: false }
    return { ...ok, counts: false }
  }
  const left = videosLeft(ent, usage)
  if (left !== null && left <= 0) {
    const total = ent.aiVideosPerMonth ?? 0
    const msg = total === 0
      ? `${ent.label} does not include AI videos. Programmatic videos are still unlimited.`
      : `You have used all ${total} AI videos for this month. They reset on ${nextMonthStart(now).slice(0, 10)}. Programmatic videos are still unlimited.`
    return { ...no('video_quota_exceeded', msg), counts: false }
  }
  return { ...ok, counts: true }
}

/** one model call: inside a video's grant, or (no grant) a small utility helper */
export function checkCall(ent: Entitlements, usage: MonthUsage, grant: Grant | null, call: { kind: PlanMediaKind | 'utility'; model: string; isClip?: boolean }, now: Date): Verdict {
  if (!ent.aiAllowed) return no('ai_blocked', ent.aiBlockedReason)
  if (usage.costUsd >= ent.costCapUsdPerMonth) return no('monthly_cost_cap', `This month's AI spending limit is reached. It resets on ${nextMonthStart(now).slice(0, 10)}.`)
  const allowedModels = grant ? grant.models : ent.models
  const isUtility = UTILITY_MODELS.includes(call.model)
  if (!isUtility) {
    const kind = call.kind === 'utility' ? 'chat' : call.kind
    if (!allowedModels[kind]?.includes(call.model)) {
      return no('model_not_in_plan', `${call.model} is not part of ${ent.label}. ${upgradeHint(ent.plan)}`)
    }
  }
  if (grant) {
    if (grant.costUsd >= grant.costCapUsd) return no('video_cost_cap', 'This video has used its AI budget. Start a new video to keep going.')
    // edits may re-make a clip once, so the hard stop sits at twice the plan's clips
    if (call.isClip && grant.clips >= Math.max(grant.clipsAllowed * 2, grant.clipsAllowed)) {
      return no('clip_limit', grant.clipsAllowed ? `This video has used its ${grant.clipsAllowed} animated clip${grant.clipsAllowed === 1 ? '' : 's'}.` : `Animated clips are not part of ${ent.label}. ${upgradeHint(ent.plan)}`)
    }
    return ok
  }
  // outside a video: chat on the plan's cheapest model and Whisper only, within a daily budget
  if (call.isClip || (call.kind !== 'chat' && call.kind !== 'utility' && call.kind !== 'image')) return no('video_required', 'Start a video to use this model.')
  const spent = usage.utilityByDay[dayKey(now)] ?? 0
  if (spent >= ent.utilityUsdPerDay) return no('utility_cap', "Today's allowance for AI helpers is used up. It resets at midnight UTC.")
  return ok
}

export function upgradeHint(plan: PlanId): string {
  const next = PLAN_IDS[PLAN_IDS.indexOf(plan) + 1]
  return next ? `Upgrade to ${DEFAULT_POLICY.plans[next].label} to use it.` : ''
}

/** what /v1/entitlements returns: the plan, the numbers, and this month's use */
export interface EntitlementView extends Entitlements {
  usage: { month: string; aiVideosUsed: number; aiVideosLeft: number | null; costUsd: number; resetsAt: string }
  prices: Record<PlanId, { label: string; priceUsdMonthly: number; aiVideosPerMonth: number | null; chatModel: string; clipsPerVideo: number }>
}

export function entitlementView(policy: Policy, ent: Entitlements, usage: MonthUsage, now: Date): EntitlementView {
  return {
    ...ent,
    usage: {
      month: usage.month,
      aiVideosUsed: usage.videoKeys.length,
      aiVideosLeft: videosLeft(ent, usage),
      costUsd: +usage.costUsd.toFixed(4),
      resetsAt: nextMonthStart(now)
    },
    prices: Object.fromEntries(
      PLAN_IDS.map((id) => {
        const p = policy.plans[id]
        return [id, { label: p.label, priceUsdMonthly: p.priceUsdMonthly, aiVideosPerMonth: p.aiVideosPerMonth, chatModel: p.chatModel, clipsPerVideo: p.clipsPerVideo }]
      })
    ) as EntitlementView['prices']
  }
}
