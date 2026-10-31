import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  accessState,
  checkCall,
  checkStartVideo,
  DEFAULT_POLICY,
  entitlements,
  mergePolicy,
  validatePolicyUpdate,
  type Account,
  type License,
  type MonthUsage
} from '@shared/plans'
import { createApp } from '../server/src/app'
import { devVerifier, hashKey, newLicenseKey, LICENSE_KEY_RE } from '../server/src/auth'
import { MemoryStore } from '../server/src/memoryStore'
import { matchRoute, meterCall } from '../server/src/upstream'

const NOW = new Date('2026-11-15T12:00:00Z')
const acct = (over: Partial<Account> = {}): Account => ({ uid: 'u1', email: 'a@b.co', emailVerified: true, status: 'active', licenseId: null, trialEndsAt: null, ...over })
const lic = (over: Partial<License> = {}): License => ({ id: 'lic_1', plan: 'pro', seats: 1, status: 'active', paidThrough: null, allowOwnKeys: false, ...over })
const usage = (over: Partial<MonthUsage> = {}): MonthUsage => ({ month: '2026-11', videoKeys: [], costUsd: 0, utilityByDay: {}, ...over })

describe('plans — the four tiers', () => {
  it('ships Free 3 / Plus 10 / Pro 15 / Ultra 27 AI videos on Luna, Luna, Terra, Sol', () => {
    const p = DEFAULT_POLICY.plans
    expect([p.free.aiVideosPerMonth, p.plus.aiVideosPerMonth, p.pro.aiVideosPerMonth, p.ultra.aiVideosPerMonth]).toEqual([3, 10, 15, 27])
    expect([p.free.chatModel, p.plus.chatModel, p.pro.chatModel, p.ultra.chatModel]).toEqual(['gpt-6-luna', 'gpt-6-luna', 'gpt-6.1-terra', 'gpt-6.1-sol'])
    // Free gets the least models: no clips, no paid music, the cheapest painter
    expect(p.free.clipsPerVideo).toBe(0)
    expect(p.free.models.video).toEqual([])
    expect(p.free.models.image).toEqual(['gemini-nano-banana-2.1'])
    // every higher plan includes everything Free has
    for (const id of ['plus', 'pro', 'ultra'] as const) for (const m of p.free.models.image) expect(p[id].models.image).toContain(m)
    expect(p.pro.models.image).toContain('gpt-image-2.5-sunburst')
    expect(p.plus.models.image).not.toContain('gpt-image-2.5-sunburst')
  })

  it('lets the superadmin change any number, and refuses nonsense with a reason', () => {
    const merged = validatePolicyUpdate({ plans: { plus: { aiVideosPerMonth: 12 } } })
    expect(merged.plans.plus.aiVideosPerMonth).toBe(12)
    expect(merged.plans.pro.aiVideosPerMonth).toBe(15) // untouched plans keep defaults
    expect(() => validatePolicyUpdate({ plans: { gold: {} } })).toThrow(/Unknown plan/)
    expect(() => validatePolicyUpdate({ plans: { pro: { aiVideosPerMonth: -1 } } })).toThrow(/AI videos/)
    expect(() => validatePolicyUpdate({ plans: { pro: { models: { chat: [] } } } })).toThrow(/at least one chat model/)
    // a stored headline model that left the plan's list falls back to one that is on it
    expect(mergePolicy({ plans: { pro: { models: { chat: ['gpt-6-luna'] } } } }).plans.pro.chatModel).toBe('gpt-6-luna')
  })
})

describe('the lapse ladder', () => {
  const pol = DEFAULT_POLICY
  it('walks active → grace → free_only → suspended', () => {
    const l = lic({ paidThrough: '2026-11-01T23:59:59Z' })
    expect(accessState(pol, l, new Date('2026-11-01T12:00:00Z')).state).toBe('active')
    expect(accessState(pol, l, new Date('2026-11-05T12:00:00Z')).state).toBe('grace')
    expect(accessState(pol, l, new Date('2026-11-12T12:00:00Z')).state).toBe('free_only')
    expect(accessState(pol, l, new Date('2026-11-30T12:00:00Z')).state).toBe('suspended')
    expect(accessState(pol, lic({ status: 'suspended' }), NOW).state).toBe('suspended')
  })

  it('drops a lapsed Pro to Free allowances, then stops AI', () => {
    const l = lic({ paidThrough: '2026-11-01T23:59:59Z' })
    const lapsed = entitlements(pol, acct(), l, new Date('2026-11-12T12:00:00Z'))
    expect(lapsed.plan).toBe('free')
    expect(lapsed.soldPlan).toBe('pro')
    expect(lapsed.aiVideosPerMonth).toBe(3)
    const gone = entitlements(pol, acct(), l, new Date('2026-12-30T12:00:00Z'))
    expect(gone.aiAllowed).toBe(false)
  })

  it('multiplies a paid plan by seats, and a licence override beats it', () => {
    expect(entitlements(pol, acct(), lic({ seats: 3 }), NOW).aiVideosPerMonth).toBe(45)
    expect(entitlements(pol, acct(), lic({ overrides: { aiVideosPerMonth: 100 } }), NOW).aiVideosPerMonth).toBe(100)
  })

  it('gives a new free account the trial plan models but only the trial count', () => {
    const e = entitlements(pol, acct({ trialEndsAt: '2026-11-20T00:00:00Z' }), null, NOW)
    expect(e.trial.active).toBe(true)
    expect(e.plan).toBe('plus')
    expect(e.aiVideosPerMonth).toBe(3) // max(free 3, trial 2)
    expect(entitlements(pol, acct({ trialEndsAt: '2026-11-10T00:00:00Z' }), null, NOW).plan).toBe('free')
  })

  it('refuses AI to an unverified email or a blocked account', () => {
    expect(entitlements(pol, acct({ emailVerified: false }), null, NOW).aiAllowed).toBe(false)
    expect(entitlements(pol, acct({ status: 'blocked' }), null, NOW).aiBlockedReason).toMatch(/blocked/)
  })
})

describe('quota gates', () => {
  const ent = entitlements(DEFAULT_POLICY, acct(), null, NOW)
  it('counts a project once a month and stops at the allowance', () => {
    expect(checkStartVideo(ent, usage(), null, {}, NOW)).toMatchObject({ allowed: true, counts: true })
    const full = usage({ videoKeys: ['a', 'b', 'c'] })
    expect(checkStartVideo(ent, full, null, {}, NOW)).toMatchObject({ allowed: false, code: 'video_quota_exceeded' })
    // reopening one of this month's videos to edit it is free of count
    const grant = { projectKey: 'a', plan: 'free' as const, models: ent.models, costUsd: 0.1, costCapUsd: 0.6, clips: 0, clipsAllowed: 0, createdAt: '', month: '2026-11' }
    expect(checkStartVideo(ent, full, grant, {}, NOW)).toMatchObject({ allowed: true, counts: false })
    expect(checkStartVideo(ent, full, { ...grant, costUsd: 0.6 }, {}, NOW).code).toBe('video_cost_cap')
  })

  it('refuses a model outside the plan, and clips on Free', () => {
    const grant = { projectKey: 'a', plan: 'free' as const, models: ent.models, costUsd: 0, costCapUsd: 0.6, clips: 0, clipsAllowed: 0, createdAt: '', month: '2026-11' }
    expect(checkCall(ent, usage(), grant, { kind: 'chat', model: 'gpt-6.1-sol' }, NOW).code).toBe('model_not_in_plan')
    expect(checkCall(ent, usage(), grant, { kind: 'chat', model: 'gpt-6-luna' }, NOW).allowed).toBe(true)
    expect(checkCall(ent, usage(), grant, { kind: 'video', model: 'gemini-omni-1.1-flash', isClip: true }, NOW).code).toBe('model_not_in_plan')
    expect(checkCall(ent, usage(), grant, { kind: 'utility', model: 'whisper-1' }, NOW).allowed).toBe(true)
  })

  it('stops a month at its dollar fuse', () => {
    expect(checkStartVideo(ent, usage({ costUsd: 1.5 }), null, {}, NOW).code).toBe('monthly_cost_cap')
  })
})

describe('relay allow-list', () => {
  it('reads the model from each provider shape and refuses anything else', () => {
    expect(matchRoute('openai', 'POST', 'chat/completions', { model: 'gpt-6-luna' }).kind).toBe('chat')
    expect(matchRoute('gemini', 'POST', 'models/gemini-nano-banana-2.1:generateContent', {}).kind).toBe('image')
    expect(matchRoute('gemini', 'POST', 'models/gemini-2.5-flash-preview-tts:generateContent', {}).kind).toBe('voice')
    expect(matchRoute('gemini', 'POST', 'interactions', { model: 'gemini-omni-1.1-flash' }).isClip).toBe(true)
    expect(matchRoute('elevenlabs', 'POST', 'text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=mp3_44100_128&x=1', { model_id: 'eleven_v3' }).path).toBe(
      'text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps?output_format=mp3_44100_128'
    )
    expect(() => matchRoute('openai', 'POST', 'files', {})).toThrow(/not available/)
    expect(() => matchRoute('openai', 'POST', 'chat/completions', {})).toThrow(/model/)
    expect(() => matchRoute('openai', 'POST', 'chat/completions', { model: 'gpt-6-luna', stream: true })).toThrow(/Streaming/)
  })

  it('prices a chat call from the usage the provider reports', () => {
    const route = matchRoute('openai', 'POST', 'chat/completions', { model: 'gpt-6.1-terra' })
    expect(meterCall(route, {}, { usage: { prompt_tokens: 1_000_000, completion_tokens: 100_000 } }).usd).toBeCloseTo(1.5)
  })
})

// ---------------- the server end to end (in-memory store, fake provider) ----------------

describe('licence server', () => {
  let server: Server
  let base = ''
  let store: MemoryStore
  let upstreamCalls: Array<{ url: string; auth: string }>
  const token = (uid: string, verified = true) => `dev:${uid}:${uid}@example.com${verified ? ':verified' : ''}`
  const DEVICE = 'device-0001'

  const call = async (path: string, opts: { method?: string; token?: string; body?: unknown; device?: string; project?: string } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.device ? { 'X-VG-Device': opts.device } : {}),
        ...(opts.project ? { 'X-VG-Project': opts.project } : {})
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    })
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  const signIn = (uid: string, verified = true, device = DEVICE) => call('/v1/account/sync', { token: token(uid, verified), body: { device: { id: device, name: 'PC' } } })

  beforeEach(async () => {
    store = new MemoryStore()
    store.admins.set('boss', { uid: 'boss', email: 'boss@example.com', role: 'superadmin' })
    upstreamCalls = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      upstreamCalls.push({ url, auth: String((init.headers as Record<string, string>).Authorization ?? '') })
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 10_000, completion_tokens: 2_000 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch
    const handler = createApp({ store, verifier: devVerifier, secret: async (p) => (p === 'openai' ? 'sk-server-held' : null), fetch: fakeFetch, now: () => NOW })
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  it('refuses every account route without a valid sign-in', async () => {
    expect((await call('/v1/entitlements')).status).toBe(401)
    expect((await call('/v1/entitlements', { token: 'forged' })).status).toBe(401)
    expect((await call('/v1/plans')).status).toBe(200) // the price list is public
  })

  it('signs up as Free, makes 3 AI videos, then is refused the 4th', async () => {
    store.policy = { trial: { days: 0 } }
    const s = await signIn('alice')
    expect(s.status).toBe(200)
    expect(s.json.entitlements.plan).toBe('free')
    expect(s.json.entitlements.aiVideosPerMonth).toBe(3)
    // a computer that never signed in cannot use the account
    expect((await call('/v1/entitlements', { token: token('alice'), device: 'other-device-1' })).status).toBe(403)
    for (const key of ['proj-1', 'proj-2', 'proj-3']) {
      expect((await call('/v1/videos/start', { token: token('alice'), device: DEVICE, body: { projectKey: key } })).json.counted).toBe(true)
    }
    // editing an already-counted video does not use another
    expect((await call('/v1/videos/start', { token: token('alice'), device: DEVICE, body: { projectKey: 'proj-1' } })).json.counted).toBe(false)
    const fourth = await call('/v1/videos/start', { token: token('alice'), device: DEVICE, body: { projectKey: 'proj-4' } })
    expect(fourth.status).toBe(403)
    expect(fourth.json.error.code).toBe('video_quota_exceeded')
  })

  it('keeps unverified emails away from AI', async () => {
    await signIn('bob', false)
    const r = await call('/v1/videos/start', { token: token('bob', false), device: DEVICE, body: { projectKey: 'proj-1' } })
    expect(r.json.error.code).toBe('ai_blocked')
  })

  it('relays only plan models, with the server key, and charges the video', async () => {
    store.policy = { trial: { days: 0 } }
    await signIn('carol')
    await call('/v1/videos/start', { token: token('carol'), device: DEVICE, body: { projectKey: 'film-1' } })
    const ok = await call('/v1/ai/openai/chat/completions', { token: token('carol'), device: DEVICE, project: 'film-1', body: { model: 'gpt-6-luna', messages: [] } })
    expect(ok.status).toBe(200)
    expect(upstreamCalls[0]).toEqual({ url: 'https://api.openai.com/v1/chat/completions', auth: 'Bearer sk-server-held' })
    const grant = await store.getGrant('usr_carol', 'film-1')
    expect(grant!.costUsd).toBeGreaterThan(0)
    // Sol is an Ultra model
    const sol = await call('/v1/ai/openai/chat/completions', { token: token('carol'), device: DEVICE, project: 'film-1', body: { model: 'gpt-6.1-sol', messages: [] } })
    expect(sol.json.error.code).toBe('model_not_in_plan')
    // a video that was never started cannot spend
    const stray = await call('/v1/ai/openai/chat/completions', { token: token('carol'), device: DEVICE, project: 'film-9', body: { model: 'gpt-6-luna', messages: [] } })
    expect(stray.json.error.code).toBe('video_not_started')
    // a provider with no server key is off, not open: its models drop out of the plan
    const g = await call('/v1/ai/gemini/models/gemini-nano-banana-2.1:generateContent', { token: token('carol'), device: DEVICE, project: 'film-1', body: {} })
    expect(g.json.error.code).toBe('model_not_in_plan')
    expect((await call('/v1/entitlements', { token: token('carol'), device: DEVICE })).json.entitlements.models.image).toEqual([])
    expect(upstreamCalls).toHaveLength(1)
  })

  it('caps how many computers one account may use', async () => {
    await signIn('dave', true, 'device-0001')
    await signIn('dave', true, 'device-0002')
    const third = await signIn('dave', true, 'device-0003')
    expect(third.status).toBe(403)
    expect(third.json.error.code).toBe('device_limit')
    expect(third.json.error.devices).toHaveLength(2)
    await call('/v1/account/devices/remove', { token: token('dave'), body: { deviceId: 'device-0001' } })
    expect((await signIn('dave', true, 'device-0003')).status).toBe(200)
  })

  it('lets only a superadmin issue keys; a key unlocks its plan for as many people as it has seats', async () => {
    expect((await call('/admin/overview', { token: token('mallory') })).status).toBe(403)
    const created = await call('/admin/licenses', { token: token('boss'), body: { plan: 'ultra', seats: 1, customerName: 'Acme' } })
    expect(created.status).toBe(200)
    const key = created.json.licenseKey as string
    expect(key).toMatch(LICENSE_KEY_RE)
    // the key is never stored or listed, only its hash
    expect(JSON.stringify([...store.licenses.values()])).not.toContain(key)
    expect(JSON.stringify((await call('/admin/overview', { token: token('boss') })).json)).not.toContain(key)

    await signIn('erin')
    const act = await call('/v1/account/activate', { token: token('erin'), device: DEVICE, body: { licenseKey: key } })
    expect(act.json.entitlements.plan).toBe('ultra')
    expect(act.json.entitlements.aiVideosPerMonth).toBe(27)
    expect(act.json.entitlements.chatModel).toBe('gpt-6.1-sol')

    await signIn('frank')
    const second = await call('/v1/account/activate', { token: token('frank'), device: DEVICE, body: { licenseKey: key } })
    expect(second.json.error.code).toBe('seats_full')
    const wrong = await call('/v1/account/activate', { token: token('frank'), device: DEVICE, body: { licenseKey: newLicenseKey() } })
    expect(wrong.json.error.code).toBe('invalid_license_key')

    // suspending the licence stops its AI on the next call
    const id = created.json.license.id
    await call('/admin/licenses/update', { token: token('boss'), body: { id, status: 'suspended' } })
    expect((await call('/v1/videos/start', { token: token('erin'), device: DEVICE, body: { projectKey: 'x-001' } })).json.error.code).toBe('ai_blocked')
    expect(store.auditLog.map((a) => a.action)).toEqual(expect.arrayContaining(['license_created', 'license_activated', 'license_updated']))
  })

  it('rotating a key retires the old one', async () => {
    const created = await call('/admin/licenses', { token: token('boss'), body: { plan: 'plus' } })
    const rotated = await call('/admin/licenses/rotate', { token: token('boss'), body: { id: created.json.license.id } })
    expect(await store.findLicenseByKeyHash(hashKey(created.json.licenseKey))).toBeNull()
    expect(await store.findLicenseByKeyHash(hashKey(rotated.json.licenseKey))).not.toBeNull()
  })

  it('lets the superadmin change plan numbers live', async () => {
    store.policy = { trial: { days: 0 } }
    const bad = await call('/admin/policy', { token: token('boss'), body: { policy: { plans: { free: { aiVideosPerMonth: 'lots' } } } } })
    expect(bad.status).toBe(400)
    const saved = await call('/admin/policy', { token: token('boss'), body: { policy: { trial: { days: 0 }, plans: { free: { aiVideosPerMonth: 5 } } } } })
    expect(saved.json.policy.plans.free.aiVideosPerMonth).toBe(5)
    expect((await signIn('gina')).json.entitlements.aiVideosPerMonth).toBe(5)
  })
})

// ---------------- desktop: what a run is allowed to use ----------------

import { accessMode, clampMedia, effectiveSettings } from '../src/main/license/access'
import { route, setManagedRouter, withProject } from '../src/main/license/route'
import { DEFAULT_SETTINGS } from '../src/main/settings'

describe('desktop access', () => {
  const freeEnt = entitlements(DEFAULT_POLICY, acct(), null, NOW)
  const proEnt = entitlements(DEFAULT_POLICY, acct(), lic({ plan: 'pro' }), NOW)

  it('picks plan, own keys (only when the licence allows) or programmatic', () => {
    expect(accessMode({ signedIn: false, ent: null, wantsOwnKeys: true })).toBe('programmatic')
    expect(accessMode({ signedIn: true, ent: freeEnt, wantsOwnKeys: true })).toBe('plan')
    expect(accessMode({ signedIn: true, ent: entitlements(DEFAULT_POLICY, acct(), lic({ allowOwnKeys: true }), NOW), wantsOwnKeys: true })).toBe('own-keys')
    expect(accessMode({ signedIn: true, ent: entitlements(DEFAULT_POLICY, acct({ emailVerified: false }), null, NOW), wantsOwnKeys: false })).toBe('programmatic')
  })

  it('clamps every engine to the plan, keeping free engines', () => {
    const wanted = { image: 'openai:gpt-image-2.5-sunburst', voice: 'elevenlabs:eleven_v3', music: 'gemini:lyria-3.5', video: 'gemini:gemini-omni-1.1-flash' }
    expect(clampMedia(wanted, freeEnt)).toEqual({ image: 'gemini:gemini-nano-banana-2.1', voice: 'openai:gpt-4o-mini-tts', music: 'builtin:procedural', video: 'stock' })
    expect(clampMedia(wanted, proEnt)).toEqual(wanted)
    expect(clampMedia({ image: 'none', voice: 'none', music: 'library', video: 'stock' }, freeEnt)).toEqual({ image: 'none', voice: 'none', music: 'library', video: 'stock' })
  })

  it('runs the plan model on a plan, and no AI when programmatic', () => {
    const own = { ...DEFAULT_SETTINGS, provider: 'anthropic' as const, models: { openai: 'gpt-6.1-sol' } }
    const onPro = effectiveSettings(own, 'plan', proEnt)
    expect(onPro.provider).toBe('openai')
    expect(onPro.models.openai).toBe('gpt-6.1-terra') // Sol is Ultra-only
    expect(effectiveSettings(own, 'programmatic', null).provider).toBe('mock')
    expect(effectiveSettings(own, 'programmatic', null).media.voice).toBe('none')
  })

  it('sends plan calls to the licence server, tagged with the video', async () => {
    const direct = { base: 'https://api.openai.com/v1', headers: { Authorization: 'Bearer sk-own' } }
    expect(route('openai', direct)).toEqual(direct)
    setManagedRouter((p) => ({ base: `https://vg.test/v1/ai/${p}`, headers: { Authorization: 'Bearer id-token', 'X-VG-Device': 'pc-1' } }))
    try {
      const r = await withProject('vg-abc123', async () => route('openai', direct))
      expect(r).toEqual({ base: 'https://vg.test/v1/ai/openai', headers: { Authorization: 'Bearer id-token', 'X-VG-Device': 'pc-1', 'X-VG-Project': 'vg-abc123' } })
      expect(route('openai', direct).headers['X-VG-Project']).toBeUndefined()
    } finally {
      setManagedRouter(null)
    }
  })
})
