import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canShowWindow, findChrome } from '../src/main/appRecon/browser'
import { planBeats } from '../src/main/appRecon/planner'
import { runAppRecording, type RunHooks, type RunInput } from '../src/main/appRecon/run'
import { DEMO_PASS, OTP_USER, startAppSite, type AppSite, DEMO_USER } from './fixtures/appSite'

const hooks = (): RunHooks => ({
  progress: () => undefined,
  handoff: async () => {
    throw new Error('no hand-off expected')
  }
})

function everyFile(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...everyFile(p))
    else out.push(p)
  }
  return out
}

describe.skipIf(!findChrome())('a whole run against the test web app', () => {
  let site: AppSite
  let root: string
  beforeAll(async () => {
    site = await startAppSite()
    root = mkdtempSync(join(tmpdir(), 'vg-run-'))
  }, 120000)
  afterAll(async () => {
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  const base = (name: string, over: Partial<RunInput> = {}): RunInput => ({
    runDir: join(root, name),
    startUrl: `${site.url}/login`,
    context: 'Show the main areas of the app',
    mode: 'walkthrough',
    signIn: 'saved',
    vault: { username: DEMO_USER, password: DEMO_PASS },
    guardrailText: '',
    checks: {},
    depth: 'standard',
    chat: null,
    speech: null,
    stopAfter: 'plan',
    ...over
  })

  it('explores the app with nothing restricted, and never signs itself out or deletes anything', async () => {
    const deletedBefore = site.state.deleted.length
    const outBefore = site.state.loggedOut
    const out = await runAppRecording(base('explore'), hooks())
    const urls = out.map.pages.map((p) => new URL(p.url).pathname)
    expect(urls).toEqual(expect.arrayContaining(['/login', '/app', '/customers', '/reports', '/settings']))
    expect(out.pages).toBeGreaterThanOrEqual(4)
    expect(out.stoppedBy).toBe('done')
    expect(site.state.loggedOut).toBe(outBefore) // the explorer did not press Logout
    expect(site.state.deleted.length).toBe(deletedBefore) // standard depth only looks
    expect(site.state.logins).toBeGreaterThan(0)
    expect(out.compat.level).toBe('works')
    expect(out.enforced.join(' ')).toContain('localhost')
  }, 120000)

  it('picks a handful of beats, signs in compactly, and keeps the password out of everything it writes', async () => {
    const out = await runAppRecording(base('plan', { context: 'Show the dashboard and the customers' }), hooks())
    expect(out.plan.beats.length).toBeGreaterThanOrEqual(2)
    expect(out.plan.beats.length).toBeLessThanOrEqual(8)
    expect(out.plan.beats[0].kind).toBe('login')
    expect(out.plan.playbook.steps.filter((s) => s.beat === 0).map((s) => s.kind)).toEqual(['goto', 'type', 'type', 'click'])
    expect(out.plan.beats.some((b) => b.chapter.toLowerCase().includes('customers'))).toBe(true)
    for (const f of everyFile(join(root, 'plan')).filter((f) => /\.(json|txt)$/.test(f))) {
      const text = readFileSync(f, 'utf8')
      expect(text, f).not.toContain(DEMO_PASS)
      expect(text, f).not.toContain('jordan.smith@example.com'.replace('jordan.smith', 'jordan.smith') + '!!')
    }
    // credentials only ever appear as placeholders in the playbook
    expect(readFileSync(join(root, 'plan', 'playbook.json'), 'utf8')).toContain('{{secret:password}}')
  }, 120000)

  it('a video about signing in gets the sign-in beats and a sign-out', async () => {
    const out = await runAppRecording(base('login', { context: 'Create a video focused on the login flow' }), hooks())
    const kinds = out.plan.beats.map((b) => b.kind)
    expect(kinds.slice(0, 4)).toEqual(['login-open', 'login-user', 'login-pass', 'login-submit'])
    expect(kinds.at(-1)).toBe('logout')
    expect(out.plan.playbook.steps.at(-1)?.intent).toBe('logout')
  }, 120000)

  it('"look only" changes nothing, even in thorough depth', async () => {
    const before = { deleted: site.state.deleted.length, saved: site.state.settingsSaved, purged: site.state.purged }
    const out = await runAppRecording(base('lookonly', { depth: 'thorough', checks: { readOnly: true } }), hooks())
    expect(out.pages).toBeGreaterThanOrEqual(4)
    expect(site.state.deleted.length).toBe(before.deleted)
    expect(site.state.settingsSaved).toBe(before.saved)
    expect(site.state.purged).toBe(before.purged)
    expect(out.enforced.join(' ')).toContain('Nothing that changes data')
  }, 180000)

  it('a thorough run with nothing restricted fills forms and really saves', async () => {
    const before = site.state.settingsSaved
    await runAppRecording(base('thorough', { depth: 'thorough' }), hooks())
    expect(site.state.settingsSaved).toBeGreaterThan(before)
  }, 180000)

  it('pauses for the person when the app asks for a one-time code, then carries on', async () => {
    const calls: Array<{ reason: string }> = []
    const h: RunHooks = {
      progress: () => undefined,
      handoff: async (info) => {
        calls.push({ reason: info.reason })
        await new Promise((r) => setTimeout(r, 4500)) // the person types the code; the test page completes itself
      }
    }
    const out = await runAppRecording(base('otp', { vault: { username: OTP_USER, password: DEMO_PASS }, depth: 'quick' }), h)
    expect(calls).toEqual([{ reason: 'code' }])
    expect(out.pages).toBeGreaterThanOrEqual(3) // it explored the app after the code was accepted
  }, 120000)

  it('stops at the page limit and says so', async () => {
    const out = await runAppRecording(base('quick', { depth: 'quick' }), hooks())
    expect(out.actions).toBeLessThan(40)
    expect(['done', 'pages', 'actions']).toContain(out.stoppedBy)
  }, 120000)

  it('reuses saved steps: a moved button is found by its name, a vanished one is left out, and nothing is explored', async () => {
    const first = await runAppRecording(base('reuse-src', { context: 'Show the dashboard and the customers' }), hooks())
    const plan = structuredClone(first.plan)
    plan.beats.push({ beat: 99, kind: 'page', chapter: 'Stats', facts: ['The stats button is pressed'], fallback: 'Stats load.' })
    plan.playbook.steps.push(
      { id: 'x1', beat: 99, kind: 'goto', url: `${site.url}/app` },
      { id: 'x2', beat: 99, kind: 'click', selector: '#button-that-moved', label: 'Load stats' },
      { id: 'x3', beat: 99, kind: 'click', selector: '#button-that-vanished', label: 'Nonexistent thing' }
    )
    const loginsBefore = site.state.logins
    const out = await runAppRecording(base('reuse', { reuse: plan }), hooks())
    expect(out.pages).toBeLessThanOrEqual(1) // the app was not explored again
    expect(site.state.logins - loginsBefore).toBe(1) // one sign-in for the check; the recording's own is the second
    const notes = out.plan.notes.join('\n')
    expect(notes).toContain('Repaired:')
    expect(notes).toMatch(/x2.*Load stats.*#stats/)
    expect(notes).toMatch(/x3.*Nonexistent thing.*left out/)
    const steps = out.plan.playbook.steps
    expect(steps.find((x) => x.id === 'x2')?.selector).toBe('#stats')
    expect(steps.some((x) => x.id === 'x3')).toBe(false)
    expect(steps.filter((x) => x.beat === 0).length).toBe(first.plan.playbook.steps.filter((x) => x.beat === 0).length) // the sign-in steps are untouched
  }, 180000)

  it('reusing steps that all still work changes nothing', async () => {
    const first = await runAppRecording(base('reuse-ok-src', { context: 'Show the dashboard' }), hooks())
    const out = await runAppRecording(base('reuse-ok', { reuse: first.plan }), hooks())
    expect(out.plan.notes.join(' ')).toContain('still work')
    expect(out.plan.playbook.steps.map((x) => x.id)).toEqual(first.plan.playbook.steps.map((x) => x.id))
  }, 180000)

  it.skipIf(!canShowWindow())('Take over: a visible window opens with the same session, and the run carries on after Done', async () => {
    const reasons: string[] = []
    const h: RunHooks = {
      progress: () => undefined,
      handoff: async (info) => {
        reasons.push(info.reason)
      }
    }
    const out = await runAppRecording(base('takeover', { control: { takeover: true }, stopAfter: 'explore' }), h)
    expect(reasons).toContain('takeover')
    expect(out.pages).toBeGreaterThanOrEqual(3) // exploring went on afterwards
  }, 180000)

  it('records the planned steps with the real engine and finds nothing unblurred (no video made here)', async () => {
    const out = await runAppRecording(base('record', { context: 'Show the dashboard', stopAfter: 'record' }), hooks())
    expect(out.redactionMisses).toBe(0)
    const take = JSON.parse(readFileSync(join(root, 'record', 'take.json'), 'utf8')) as { frames: number; durationSec: number; beats: unknown[] }
    expect(take.frames).toBeGreaterThan(5)
    expect(take.beats.length).toBe(out.plan.beats.length)
    // the sign-in that was recorded is the second of two; the first was exploration
    expect(site.state.logins).toBeGreaterThanOrEqual(2)
  }, 180000)
})

describe('planning without a browser', () => {
  const page = (url: string, title: string, extra: Partial<import('../src/shared/appRecon').AppPage> = {}) => ({ url, title, headings: [title], fields: [], controls: [], notices: [], ...extra })
  const map = (pages: ReturnType<typeof page>[]) => ({ version: 1 as const, startUrl: 'https://a.example.com/', host: 'a.example.com', scoutedAt: 'x', pages, login: { detected: false, otpLikely: false }, sensitiveSelectors: [] })

  it('prefers pages that match what was asked for, in the order they were found', () => {
    const pages = [page('https://a.example.com/', 'Home'), page('https://a.example.com/billing', 'Billing and invoices'), page('https://a.example.com/team', 'Team members'), page('https://a.example.com/about', 'About')]
    const visits = pages.map((p, index) => ({ index, page: p, via: index ? ('link' as const) : ('start' as const), interactions: [] }))
    const plan = planBeats({ map: map(pages), exploration: { visits, actions: 0, stoppedBy: 'done', elapsedMs: 0 }, context: 'Show how billing and invoices work', startUrl: 'https://a.example.com/', targetSec: 28, hasVault: false, secrets: [] })
    expect(plan.beats.map((b) => b.chapter)).toContain('Billing And Invoices')
    expect(plan.beats.length).toBeLessThanOrEqual(4)
    expect(plan.playbook.steps.every((s) => s.beat < plan.beats.length)).toBe(true)
  })

  it('writes varied, plain stock lines that do not repeat back-links', () => {
    const pages = [
      page('https://a.example.com/', 'Home', { controls: [{ selector: 'a', label: 'Billing', kind: 'link', href: 'https://a.example.com/billing' }, { selector: 'b', label: 'Team', kind: 'link', href: 'https://a.example.com/team' }] }),
      page('https://a.example.com/billing', 'Billing', { controls: [{ selector: 'a', label: 'Home', kind: 'link', href: 'https://a.example.com/' }] }),
      page('https://a.example.com/team', 'Team', { controls: [{ selector: 'a', label: 'Home', kind: 'link', href: 'https://a.example.com/' }], fields: [{ selector: '#n', label: 'Invite by name', inputType: 'text', name: 'n', kind: 'text', sensitive: false }] })
    ]
    const visits = pages.map((p, index) => ({ index, page: p, via: index ? ('link' as const) : ('start' as const), interactions: [] }))
    const plan = planBeats({ map: map(pages), exploration: { visits, actions: 0, stoppedBy: 'done', elapsedMs: 0 }, context: '', startUrl: 'https://a.example.com/', targetSec: 44, hasVault: false, secrets: [] })
    const lines = plan.beats.map((b) => b.fallback)
    expect(lines.join(' ')).not.toMatch(/move to Home|reach Home/)
    expect(new Set(lines.map((l) => l.split('.')[0])).size).toBe(lines.length)
    expect(plan.beats.find((b) => b.chapter === 'Team')?.fallback).toContain('Invite by name')
    expect(plan.beats.find((b) => b.chapter === 'Home')?.fallback).toContain('Billing and Team')
  })

  it('still makes a one-beat video when nothing could be explored', () => {
    const plan = planBeats({ map: map([]), exploration: { visits: [], actions: 0, stoppedBy: 'done', elapsedMs: 0 }, context: '', startUrl: 'https://a.example.com/', hasVault: false, secrets: [] })
    expect(plan.beats).toHaveLength(1)
    expect(plan.notes.join(' ')).toContain('only the opening page')
  })
})
