import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import {
  checkCall,
  checkStartVideo,
  dayKey,
  DEFAULT_POLICY,
  entitlements,
  entitlementView,
  withProviders,
  mergePolicy,
  monthKey,
  PLAN_IDS,
  validatePolicyUpdate,
  type Entitlements,
  type License,
  type PlanId,
  type Policy
} from '../../src/shared/plans'
import { AuthError, bearer, hashKey, keyHint, LICENSE_KEY_RE, newId, newLicenseKey, type Caller, type TokenVerifier } from './auth'
import { StoreError, subjectOf, type DeviceRecord, type GrantRecord, type LicenseRecord, type Store, type UserRecord } from './store'
import { authHeader, estimateCall, matchRoute, meterCall, refsFromResponse, RouteError, UPSTREAM_BASE, type ProviderName, type RouteMatch } from './upstream'

/**
 * The licence server: accounts, licence keys, plans and quotas, the AI relay,
 * and the superadmin API + console. Three auth models, never mixed:
 *   /v1/plans, /health       public
 *   /v1/*                    a signed-in account (Firebase ID token) on a registered computer
 *   /admin/*                 a signed-in account listed in vg_admins (token revocation checked)
 */

export interface AppDeps {
  store: Store
  verifier: TokenVerifier
  /** the server-held provider key, or null when that provider is not switched on */
  secret: (provider: ProviderName) => Promise<string | null>
  fetch?: typeof fetch
  now?: () => Date
  /** folder of the superadmin console's static files */
  consoleDir?: string
  /** console page config (Firebase web config); public by design */
  consoleConfig?: Record<string, string>
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

const MAX_BODY = 30 * 1024 * 1024
const MAX_ADMIN_BODY = 256 * 1024
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/
const PROJECT_KEY = /^[A-Za-z0-9_-]{4,80}$/

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000'
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new HttpError(413, 'too_large', 'That request is too large.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'too_large', 'That request is too large.')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

function parseJson(buf: Buffer): Record<string, unknown> {
  if (!buf.length) return {}
  try {
    const v = JSON.parse(buf.toString('utf8')) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'bad_json', 'The request body is not valid JSON.')
}

/** a per-key sliding window; one Cloud Run instance's view, which is enough to blunt a loop or a guesser */
class RateLimiter {
  private hits = new Map<string, number[]>()
  allow(key: string, max: number, windowMs: number, now: number): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs)
    if (list.length >= max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 50_000) this.hits.clear()
    return true
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const iso = (d: Date): string => d.toISOString()

export function createApp(deps: AppDeps) {
  const { store, verifier } = deps
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? (() => new Date())
  const limiter = new RateLimiter()
  let policyCache: { at: number; policy: Policy } | null = null

  async function policy(): Promise<Policy> {
    if (policyCache && Date.now() - policyCache.at < 30_000) return policyCache.policy
    const p = mergePolicy(await store.getPolicy())
    policyCache = { at: Date.now(), policy: p }
    return p
  }

  async function availableProviders(): Promise<Set<string>> {
    const names: ProviderName[] = ['openai', 'gemini', 'elevenlabs']
    const keys = await Promise.all(names.map((p) => deps.secret(p)))
    return new Set(names.filter((_, i) => Boolean(keys[i])))
  }

  function limit(key: string, max: number, windowMs = 60_000): void {
    if (!limiter.allow(key, max, windowMs, now().getTime())) throw new HttpError(429, 'rate_limited', 'Too many requests. Wait a minute and try again.')
  }

  // ---------------- callers ----------------

  async function caller(req: IncomingMessage, checkRevoked = false): Promise<Caller> {
    return verifier.verify(bearer(req.headers.authorization), { checkRevoked })
  }

  interface Ctx {
    caller: Caller
    user: UserRecord
    license: LicenseRecord | null
    policy: Policy
    ent: Entitlements
    subject: string
  }

  async function context(c: Caller, user: UserRecord): Promise<Ctx> {
    const pol = await policy()
    const lic = user.licenseId ? await store.getLicense(user.licenseId) : null
    const account = { ...user, email: c.email, emailVerified: c.emailVerified }
    const ent = withProviders(entitlements(pol, account, lic, now()), await availableProviders())
    return { caller: c, user, license: lic, policy: pol, ent, subject: subjectOf(user.uid, lic?.id) }
  }

  /** a signed-in account on a computer it registered through /v1/account/sync */
  async function account(req: IncomingMessage): Promise<Ctx> {
    const c = await caller(req)
    const user = await store.getUser(c.uid)
    if (!user) throw new HttpError(403, 'sync_required', 'Sign in again to register this computer.')
    const deviceId = String(req.headers['x-vg-device'] ?? '')
    if (!DEVICE_ID.test(deviceId) || !(await store.listDevices(c.uid)).some((d) => d.id === deviceId)) {
      throw new HttpError(403, 'device_not_registered', 'This computer is not registered to your account. Sign in again.')
    }
    return context(c, user)
  }

  async function view(ctx: Ctx, devices?: DeviceRecord[]) {
    const usage = await store.getUsage(ctx.subject, monthKey(now()))
    return {
      account: {
        uid: ctx.user.uid,
        email: ctx.caller.email,
        emailVerified: ctx.caller.emailVerified,
        status: ctx.user.status,
        displayName: ctx.user.displayName ?? ''
      },
      license: ctx.license
        ? {
            id: ctx.license.id,
            keyHint: ctx.license.keyHint,
            plan: ctx.license.plan,
            seats: ctx.license.seats,
            customerName: ctx.license.customerName,
            status: ctx.license.status,
            paidThrough: ctx.license.paidThrough
          }
        : null,
      entitlements: entitlementView(ctx.policy, ctx.ent, usage, now()),
      ...(devices ? { devices } : {})
    }
  }

  // ---------------- /v1 account routes ----------------

  async function sync(req: IncomingMessage) {
    const c = await caller(req)
    limit(`sync:${c.uid}`, 20)
    const body = parseJson(await readBody(req, 16 * 1024))
    const d = (body.device ?? {}) as Record<string, unknown>
    const deviceId = str(d.id, 64)
    if (!DEVICE_ID.test(deviceId)) throw new HttpError(400, 'bad_device', 'This computer did not send a valid id.')
    const pol = await policy()
    const t = now()
    const existing = await store.getUser(c.uid)
    if (existing?.status === 'blocked') throw new HttpError(403, 'account_blocked', 'This account has been blocked. Contact support.')
    const user = await store.upsertUser(
      c.uid,
      { email: c.email, emailVerified: c.emailVerified, lastSeenAt: iso(t) },
      {
        createdAt: iso(t),
        status: 'active',
        licenseId: null,
        // one trial per account, set when the account first appears
        trialEndsAt: pol.trial.days > 0 ? iso(new Date(t.getTime() + pol.trial.days * 86_400_000)) : null,
        displayName: ''
      }
    )
    try {
      await store.touchDevice(c.uid, { id: deviceId, name: str(d.name, 80), platform: str(d.platform, 40), appVersion: str(d.appVersion, 20) }, pol.devicesPerSeat, iso(t))
    } catch (e) {
      if (e instanceof StoreError && e.code === 'device_limit') {
        throw new HttpError(403, e.code, e.message, { devices: await store.listDevices(c.uid) })
      }
      throw e
    }
    if (!existing) await store.audit({ at: iso(t), actor: c.email, action: 'account_created', target: c.uid, details: {} })
    return view(await context(c, user), await store.listDevices(c.uid))
  }

  async function activate(req: IncomingMessage) {
    const ctx = await account(req)
    // keys are ~186 bits, so this is about stopping noise, not guessing
    limit(`activate:${ctx.user.uid}`, 10, 60 * 60_000)
    const key = str(parseJson(await readBody(req, 4096)).licenseKey, 80)
    if (!LICENSE_KEY_RE.test(key)) throw new HttpError(400, 'bad_license_key', 'That is not a VideoGen licence key. It starts with vg_live_.')
    const lic = await store.findLicenseByKeyHash(hashKey(key))
    if (!lic) throw new HttpError(404, 'invalid_license_key', 'That licence key was not found. Check it and try again.')
    if (lic.status !== 'active') throw new HttpError(403, 'license_suspended', 'That licence has been suspended. Contact support.')
    if (ctx.user.licenseId && ctx.user.licenseId !== lic.id) await store.leaveLicense(ctx.user.uid)
    await store.joinLicense(ctx.user.uid, lic.id)
    await store.audit({ at: iso(now()), actor: ctx.caller.email, action: 'license_activated', target: lic.id, details: { uid: ctx.user.uid, from: ctx.user.licenseId ?? null } })
    const user = (await store.getUser(ctx.user.uid))!
    return view(await context(ctx.caller, user), await store.listDevices(ctx.user.uid))
  }

  async function leave(req: IncomingMessage) {
    const ctx = await account(req)
    if (!ctx.user.licenseId) return view(ctx)
    await store.leaveLicense(ctx.user.uid)
    await store.audit({ at: iso(now()), actor: ctx.caller.email, action: 'license_left', target: ctx.user.licenseId, details: { uid: ctx.user.uid } })
    return view(await context(ctx.caller, (await store.getUser(ctx.user.uid))!))
  }

  async function removeOwnDevice(req: IncomingMessage) {
    // works without a registered device: it is how someone at the device limit frees a slot
    const c = await caller(req)
    limit(`devices:${c.uid}`, 20)
    const id = str(parseJson(await readBody(req, 4096)).deviceId, 64)
    if (!DEVICE_ID.test(id)) throw new HttpError(400, 'bad_device', 'Pick a computer to remove.')
    await store.removeDevice(c.uid, id)
    return { devices: await store.listDevices(c.uid) }
  }

  // ---------------- AI videos ----------------

  async function startVideo(req: IncomingMessage) {
    const ctx = await account(req)
    limit(`start:${ctx.user.uid}`, 30)
    const body = parseJson(await readBody(req, 8192))
    const projectKey = str(body.projectKey, 80)
    if (!PROJECT_KEY.test(projectKey)) throw new HttpError(400, 'bad_project', 'The project id is not valid.')
    const durationSec = typeof body.durationSec === 'number' && body.durationSec > 0 ? body.durationSec : undefined
    const t = now()
    const month = monthKey(t)
    const out = await store.startVideo(ctx.subject, projectKey, month, (usage, existing) => {
      const verdict = checkStartVideo(ctx.ent, usage, existing, { durationSec }, t)
      if (!verdict.allowed) throw new HttpError(403, verdict.code, verdict.message)
      const fresh: GrantRecord = {
        projectKey,
        subject: ctx.subject,
        uid: ctx.user.uid,
        title: str(body.title, 120),
        plan: ctx.ent.plan,
        models: ctx.ent.models,
        costUsd: 0,
        costCapUsd: ctx.ent.costCapUsdPerVideo,
        clips: 0,
        clipsAllowed: ctx.ent.clipsPerVideo,
        createdAt: iso(t),
        month,
        refs: existing?.refs ?? []
      }
      // reopening a counted video keeps its tab; a new month (or a new video) starts a new one
      return { grant: verdict.counts || !existing ? fresh : existing, counts: verdict.counts }
    })
    if (out.counted) await store.audit({ at: iso(t), actor: ctx.caller.email, action: 'ai_video_started', target: ctx.subject, details: { projectKey, plan: ctx.ent.plan } })
    return {
      projectKey,
      counted: out.counted,
      plan: out.grant.plan,
      models: out.grant.models,
      clipsAllowed: out.grant.clipsAllowed,
      costCapUsd: out.grant.costCapUsd,
      costUsd: +out.grant.costUsd.toFixed(4),
      entitlements: entitlementView(ctx.policy, ctx.ent, out.usage, t)
    }
  }

  async function relay(req: IncomingMessage, res: ServerResponse, provider: string, rest: string): Promise<void> {
    const ctx = await account(req)
    limit(`ai:${ctx.user.uid}`, 120)
    if (!ctx.ent.aiAllowed) throw new HttpError(403, 'ai_blocked', ctx.ent.aiBlockedReason)
    const method = req.method === 'GET' ? 'GET' : req.method === 'POST' ? 'POST' : ''
    if (!method) throw new HttpError(405, 'method', 'Method not allowed.')
    const raw = method === 'POST' ? await readBody(req, MAX_BODY) : Buffer.alloc(0)
    const contentType = String(req.headers['content-type'] ?? '')
    const isJson = contentType.includes('application/json')
    const reqJson = isJson ? parseJson(raw) : null
    const multipartModel = contentType.startsWith('multipart/form-data') ? /name="model"\r\n\r\n([^\r\n]{1,64})\r\n/.exec(raw.toString('latin1'))?.[1] : undefined

    let route: RouteMatch
    try {
      route = matchRoute(provider, method, rest, reqJson, multipartModel)
    } catch (e) {
      if (e instanceof RouteError) throw new HttpError(e.status, e.code, e.message)
      throw e
    }

    const t = now()
    const month = monthKey(t)
    const projectKey = String(req.headers['x-vg-project'] ?? '')
    let grant: GrantRecord | null = null
    if (projectKey) {
      if (!PROJECT_KEY.test(projectKey)) throw new HttpError(400, 'bad_project', 'The project id is not valid.')
      grant = await store.getGrant(ctx.subject, projectKey)
      if (!grant || grant.month !== month) throw new HttpError(403, 'video_not_started', 'This video has not been started this month. Start it again.')
    }
    if (route.ref) {
      // polling or downloading something: only what this video's own calls produced
      if (!grant || !grant.refs.includes(route.ref)) throw new HttpError(403, 'not_yours', 'That result does not belong to this video.')
    } else {
      const usage = await store.getUsage(ctx.subject, month)
      const verdict = checkCall(ctx.ent, usage, grant, { kind: route.kind, model: route.model, isClip: route.isClip }, t)
      if (!verdict.allowed) throw new HttpError(403, verdict.code, verdict.message)
      const est = estimateCall(route)
      if (grant && grant.costUsd + est > grant.costCapUsd) throw new HttpError(403, 'video_cost_cap', 'This video has used its AI budget. Start a new video to keep going.')
      if (usage.costUsd + est > ctx.ent.costCapUsdPerMonth) throw new HttpError(403, 'monthly_cost_cap', "This month's AI spending limit is reached.")
    }

    const key = await deps.secret(route.provider)
    if (!key) throw new HttpError(503, 'provider_unavailable', 'This kind of AI is not switched on yet. Pick another model.')

    let upstream: Response
    try {
      upstream = await doFetch(`${UPSTREAM_BASE[route.provider]}/${route.path}`, {
        method: route.method,
        headers: { ...authHeader(route.provider, key), ...(route.method === 'POST' ? { 'Content-Type': contentType || 'application/json' } : {}) },
        body: route.method === 'POST' ? new Uint8Array(raw) : undefined,
        redirect: 'follow',
        signal: AbortSignal.timeout(10 * 60_000)
      })
    } catch {
      throw new HttpError(502, 'upstream_unreachable', 'The AI provider could not be reached. Try again.')
    }

    const charge = async (resJson: unknown, audioBytes?: number) => {
      if (!upstream.ok || route.ref) return
      const m = meterCall(route, reqJson, resJson, { audioBytes })
      await store.charge(ctx.subject, month, { projectKey: grant ? projectKey : null, day: dayKey(t), usd: m.usd, isClip: route.isClip, model: route.model, refs: grant ? refsFromResponse(resJson) : [] })
    }

    const outType = upstream.headers.get('content-type') ?? 'application/octet-stream'
    if (route.stream && upstream.ok && upstream.body) {
      res.writeHead(upstream.status, { ...SECURITY_HEADERS, 'Content-Type': outType, 'Cache-Control': 'no-store' })
      let bytes = 0
      for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
        bytes += chunk.length
        res.write(chunk)
      }
      res.end()
      await charge(null, bytes)
      return
    }
    const buf = Buffer.from(await upstream.arrayBuffer())
    let resJson: unknown = null
    if (outType.includes('json')) {
      try {
        resJson = JSON.parse(buf.toString('utf8'))
      } catch {
        resJson = null
      }
    }
    await charge(resJson)
    res.writeHead(upstream.status, { ...SECURITY_HEADERS, 'Content-Type': outType, 'Cache-Control': 'no-store', 'Content-Length': buf.length })
    res.end(buf)
  }

  // ---------------- /admin ----------------

  async function admin(req: IncomingMessage): Promise<{ email: string; uid: string }> {
    const c = await caller(req, true)
    limit(`admin:${c.uid}`, 120)
    const record = await store.getAdmin(c.uid)
    if (!record || record.role !== 'superadmin') throw new HttpError(403, 'not_admin', 'This account is not a VideoGen superadmin.')
    if (!c.emailVerified) throw new HttpError(403, 'email_unverified', 'Verify this admin email address first.')
    return { email: c.email, uid: c.uid }
  }

  const audit = (actor: string, action: string, target: string | null, details: Record<string, unknown>) =>
    store.audit({ at: iso(now()), actor, action, target, details })

  function publicLicense(l: LicenseRecord) {
    const { keyHash: _hidden, ...rest } = l
    return rest
  }

  function cleanLicensePatch(body: Record<string, unknown>, creating: boolean): Partial<LicenseRecord> {
    const out: Partial<LicenseRecord> = {}
    if (body.plan !== undefined) {
      if (!PLAN_IDS.includes(body.plan as PlanId)) throw new HttpError(400, 'bad_plan', `Plan must be one of ${PLAN_IDS.join(', ')}.`)
      out.plan = body.plan as PlanId
    } else if (creating) throw new HttpError(400, 'bad_plan', 'Pick a plan.')
    if (body.seats !== undefined) {
      const s = Number(body.seats)
      if (!Number.isInteger(s) || s < 1 || s > 1000) throw new HttpError(400, 'bad_seats', 'Seats must be a whole number from 1 to 1000.')
      out.seats = s
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'suspended') throw new HttpError(400, 'bad_status', 'Status must be active or suspended.')
      out.status = body.status
    }
    if (body.paidThrough !== undefined) {
      if (body.paidThrough === null || body.paidThrough === '') out.paidThrough = null
      else {
        const s = String(body.paidThrough)
        // "paid through the 30th" covers the whole of the 30th
        const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59Z`) : new Date(s)
        if (Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_date', 'Paid-through must be a date (YYYY-MM-DD).')
        out.paidThrough = d.toISOString()
      }
    }
    if (body.allowOwnKeys !== undefined) out.allowOwnKeys = body.allowOwnKeys === true
    if (body.customerName !== undefined) out.customerName = str(body.customerName, 120)
    if (body.contactEmail !== undefined) {
      const e = str(body.contactEmail, 200).toLowerCase()
      if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new HttpError(400, 'bad_email', 'That contact email does not look right.')
      out.contactEmail = e
    }
    if (body.notes !== undefined) out.notes = str(body.notes, 2000)
    if (body.revenueUsdMonthly !== undefined) {
      const r = Number(body.revenueUsdMonthly)
      if (!Number.isFinite(r) || r < 0 || r > 1_000_000) throw new HttpError(400, 'bad_revenue', 'Revenue must be a positive number.')
      out.revenueUsdMonthly = r
    }
    if (body.overrides !== undefined) {
      const o = (body.overrides ?? {}) as Record<string, unknown>
      const clean: NonNullable<License['overrides']> = {}
      for (const [field, max] of [['aiVideosPerMonth', 100_000], ['costCapUsdPerMonth', 100_000], ['clipsPerVideo', 12]] as const) {
        const v = o[field]
        if (v === undefined || v === '' ) continue
        if (v === null) continue
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, 'bad_override', `${field} must be 0–${max}, or empty to use the plan's.`)
        clean[field] = field === 'costCapUsdPerMonth' ? n : Math.floor(n)
      }
      out.overrides = clean
    }
    return out
  }

  async function adminRoute(req: IncomingMessage, path: string, url: URL): Promise<unknown> {
    const me = await admin(req)
    const body = req.method === 'POST' ? parseJson(await readBody(req, MAX_ADMIN_BODY)) : {}
    const t = now()
    const month = monthKey(t)

    switch (`${req.method} ${path}`) {
      case 'GET /admin/me':
        return { email: me.email, role: 'superadmin' }

      case 'GET /admin/overview': {
        const pol = await policy()
        const licenses = await store.listLicenses()
        const users = await store.listUsers({ limit: 500 })
        const rows = await Promise.all(
          licenses.map(async (l) => {
            const usage = await store.getUsage(subjectOf('', l.id), month)
            const ent = entitlements(pol, { uid: '', email: '', emailVerified: true, status: 'active' }, l, t)
            return {
              ...publicLicense(l),
              members: users.filter((u) => u.licenseId === l.id).length,
              access: ent.access,
              aiVideosPerMonth: ent.aiVideosPerMonth,
              aiVideosUsed: usage.videoKeys.length,
              costUsd: +usage.costUsd.toFixed(4)
            }
          })
        )
        const free = users.filter((u) => !u.licenseId)
        const freeUsage = await Promise.all(free.map((u) => store.getUsage(subjectOf(u.uid, null), month)))
        return {
          month,
          policy: pol,
          licenses: rows,
          totals: {
            users: users.length,
            freeUsers: free.length,
            licenses: licenses.length,
            revenueUsdMonthly: licenses.filter((l) => l.status === 'active').reduce((s, l) => s + (l.revenueUsdMonthly || 0), 0),
            costUsdThisMonth: +(rows.reduce((s, r) => s + r.costUsd, 0) + freeUsage.reduce((s, u) => s + u.costUsd, 0)).toFixed(4),
            freeAiVideosThisMonth: freeUsage.reduce((s, u) => s + u.videoKeys.length, 0)
          }
        }
      }

      case 'POST /admin/licenses': {
        const patch = cleanLicensePatch(body, true)
        const key = newLicenseKey()
        const record: LicenseRecord = {
          id: newId('lic'),
          keyHash: hashKey(key),
          keyHint: keyHint(key),
          plan: patch.plan!,
          seats: patch.seats ?? 1,
          status: 'active',
          paidThrough: patch.paidThrough ?? null,
          allowOwnKeys: patch.allowOwnKeys ?? false,
          overrides: patch.overrides ?? {},
          customerName: patch.customerName ?? '',
          contactEmail: patch.contactEmail ?? '',
          notes: patch.notes ?? '',
          revenueUsdMonthly: patch.revenueUsdMonthly ?? 0,
          createdAt: iso(t),
          createdBy: me.email
        }
        await store.createLicense(record)
        await audit(me.email, 'license_created', record.id, { plan: record.plan, seats: record.seats, customerName: record.customerName })
        // the only time the full key leaves the server
        return { license: publicLicense(record), licenseKey: key }
      }

      case 'POST /admin/licenses/update': {
        const id = str(body.id, 40)
        const before = await store.getLicense(id)
        if (!before) throw new HttpError(404, 'license_not_found', 'No such licence.')
        const patch = cleanLicensePatch(body, false)
        const after = await store.updateLicense(id, { ...patch, updatedAt: iso(t) })
        const changed = Object.fromEntries(Object.keys(patch).map((k) => [k, { before: (before as unknown as Record<string, unknown>)[k] ?? null, after: (after as unknown as Record<string, unknown>)[k] ?? null }]))
        await audit(me.email, 'license_updated', id, changed)
        return { license: publicLicense(after) }
      }

      case 'POST /admin/licenses/rotate': {
        const id = str(body.id, 40)
        if (!(await store.getLicense(id))) throw new HttpError(404, 'license_not_found', 'No such licence.')
        const key = newLicenseKey()
        const after = await store.updateLicense(id, { keyHash: hashKey(key), keyHint: keyHint(key), updatedAt: iso(t) })
        await audit(me.email, 'license_key_rotated', id, {})
        return { license: publicLicense(after), licenseKey: key }
      }

      case 'GET /admin/users': {
        const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
        const licenseId = url.searchParams.get('licenseId') ?? undefined
        let users = await store.listUsers({ limit: 500, licenseId })
        if (q) users = users.filter((u) => u.email.toLowerCase().includes(q) || u.uid === q)
        const pol = await policy()
        return {
          users: await Promise.all(
            users.slice(0, 200).map(async (u) => {
              const lic = u.licenseId ? await store.getLicense(u.licenseId) : null
              const ent = entitlements(pol, u, lic, t)
              const usage = await store.getUsage(subjectOf(u.uid, lic?.id), month)
              return { ...u, plan: ent.plan, trialActive: ent.trial.active, aiVideosUsed: usage.videoKeys.length, aiVideosPerMonth: ent.aiVideosPerMonth, costUsd: +usage.costUsd.toFixed(4), devices: (await store.listDevices(u.uid)).length }
            })
          )
        }
      }

      case 'GET /admin/users/devices': {
        const uid = str(url.searchParams.get('uid'), 128)
        return { devices: await store.listDevices(uid) }
      }

      case 'POST /admin/users/update': {
        const uid = str(body.uid, 128)
        const before = await store.getUser(uid)
        if (!before) throw new HttpError(404, 'user_not_found', 'No such user.')
        const patch: Partial<UserRecord> = {}
        if (body.status !== undefined) {
          if (body.status !== 'active' && body.status !== 'blocked') throw new HttpError(400, 'bad_status', 'Status must be active or blocked.')
          patch.status = body.status
        }
        if (body.trialEndsAt !== undefined) {
          const d = body.trialEndsAt ? new Date(String(body.trialEndsAt)) : null
          if (d && Number.isNaN(d.getTime())) throw new HttpError(400, 'bad_date', 'Trial end must be a date.')
          patch.trialEndsAt = d ? d.toISOString() : null
        }
        if (Object.keys(patch).length) await store.upsertUser(uid, patch, {})
        if (body.licenseId === null && before.licenseId) await store.leaveLicense(uid)
        else if (typeof body.licenseId === 'string' && body.licenseId !== before.licenseId) {
          if (before.licenseId) await store.leaveLicense(uid)
          await store.joinLicense(uid, body.licenseId)
        }
        await audit(me.email, 'user_updated', uid, { ...patch, ...(body.licenseId !== undefined ? { licenseId: body.licenseId } : {}) })
        return { user: await store.getUser(uid) }
      }

      case 'POST /admin/users/devices/remove': {
        const uid = str(body.uid, 128)
        const deviceId = str(body.deviceId, 64)
        await store.removeDevice(uid, deviceId)
        await audit(me.email, 'device_removed', uid, { deviceId })
        return { devices: await store.listDevices(uid) }
      }

      case 'GET /admin/policy':
        return { policy: await policy(), defaults: DEFAULT_POLICY }

      case 'POST /admin/policy': {
        let next: Policy
        try {
          next = validatePolicyUpdate(body.policy)
        } catch (e) {
          throw new HttpError(400, 'bad_policy', (e as Error).message)
        }
        const before = await policy()
        await store.savePolicy(next)
        policyCache = null
        await audit(me.email, 'policy_updated', null, { before, after: next })
        return { policy: next }
      }

      case 'GET /admin/audit':
        return { entries: await store.listAudit(Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100))) }

      case 'GET /admin/usage': {
        const subject = str(url.searchParams.get('subject'), 160)
        return { usage: await store.getUsage(subject, str(url.searchParams.get('month'), 7) || month) }
      }
    }
    throw new HttpError(404, 'not_found', 'Not found.')
  }

  // ---------------- console (static) ----------------

  const CONSOLE_FILES: Record<string, string> = { '': 'index.html', 'index.html': 'index.html', 'console.js': 'console.js', 'console.css': 'console.css' }
  const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' }

  async function serveConsole(res: ServerResponse, rest: string): Promise<void> {
    if (rest === 'config.json') return sendJson(res, 200, deps.consoleConfig ?? {})
    const file = CONSOLE_FILES[rest]
    if (!file || !deps.consoleDir) throw new HttpError(404, 'not_found', 'Not found.')
    const body = await readFile(normalize(join(deps.consoleDir, file)))
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': TYPES[file.split('.').pop()!],
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        // Google sign-in needs Google's script host and the project's auth frame
        `default-src 'self'; script-src 'self' https://www.gstatic.com https://apis.google.com; style-src 'self'; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; frame-src https://${deps.consoleConfig?.authDomain ?? 'localhost'} https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
    })
    res.end(body)
  }

  // ---------------- router ----------------

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    try {
      if (path === '/health' && req.method === 'GET') return sendJson(res, 200, { status: 'ok' })
      if (path === '/v1/plans' && req.method === 'GET') {
        limit(`plans:${req.socket.remoteAddress ?? ''}`, 60)
        const pol = await policy()
        return sendJson(res, 200, { plans: pol.plans, trial: pol.trial })
      }
      if (path === '/console' || path.startsWith('/console/')) {
        if (path === '/console') {
          res.writeHead(301, { ...SECURITY_HEADERS, Location: '/console/' })
          return void res.end()
        }
        return await serveConsole(res, path.slice('/console/'.length))
      }
      if (path.startsWith('/admin/')) return sendJson(res, 200, await adminRoute(req, path, url))

      if (req.method === 'POST' && path === '/v1/account/sync') return sendJson(res, 200, await sync(req))
      if (req.method === 'POST' && path === '/v1/account/activate') return sendJson(res, 200, await activate(req))
      if (req.method === 'POST' && path === '/v1/account/leave') return sendJson(res, 200, await leave(req))
      if (req.method === 'POST' && path === '/v1/account/devices/remove') return sendJson(res, 200, await removeOwnDevice(req))
      if (req.method === 'GET' && path === '/v1/entitlements') {
        const ctx = await account(req)
        return sendJson(res, 200, await view(ctx))
      }
      if (req.method === 'POST' && path === '/v1/videos/start') return sendJson(res, 200, await startVideo(req))
      const ai = /^\/v1\/ai\/([a-z]+)\/(.+)$/.exec(path)
      if (ai) return await relay(req, res, ai[1], ai[2] + url.search)

      throw new HttpError(404, 'not_found', 'Not found.')
    } catch (e) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      if (e instanceof HttpError || e instanceof AuthError || e instanceof StoreError) {
        return sendJson(res, e.status, { error: { code: e.code, message: e.message, ...(e instanceof HttpError ? e.extra : {}) } })
      }
      console.error('[server] unexpected error', e)
      return sendJson(res, 500, { error: { code: 'internal', message: 'Something went wrong on the server.' } })
    }
  }
}
