import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyField, isSensitive } from '../src/main/appRecon/sensitivity'
import { interpretGuardrails, PolicyGate } from '../src/main/appRecon/policy'
import { addressTimeline, cameraKeys, viewFor } from '../src/main/appRecon/produce'
import { redactionInitScript, verifyScript } from '../src/main/appRecon/redact'
import { findChrome, launch } from '../src/main/appRecon/browser'
import { AppMap, Playbook, type Guardrails, type Take } from '../src/shared/appRecon'

describe('field sensitivity', () => {
  it('classifies from what the page says about the field', () => {
    expect(classifyField({ type: 'password' })).toBe('password')
    expect(classifyField({ type: 'text', name: 'pwd' })).toBe('password')
    expect(classifyField({ type: 'text', autocomplete: 'one-time-code' })).toBe('otp')
    expect(classifyField({ type: 'text', label: 'Verification code' })).toBe('otp')
    expect(classifyField({ type: 'text', autocomplete: 'cc-number' })).toBe('card')
    expect(classifyField({ type: 'email' })).toBe('email')
    expect(classifyField({ type: 'tel' })).toBe('phone')
    expect(classifyField({ type: 'text', label: 'Last name' })).toBe('person-name')
    expect(classifyField({ type: 'text', name: 'username' })).toBe('username')
    expect(classifyField({ type: 'search' })).toBe('search')
    expect(classifyField({ type: 'text', label: 'Project title' })).toBe('text')
  })

  it('always hides secrets and personal data; shows a login name only when allowed', () => {
    for (const k of ['password', 'otp', 'card', 'ssn', 'email', 'phone', 'person-name', 'address'] as const) expect(isSensitive(k, { revealIdentifiers: true })).toBe(true)
    expect(isSensitive('username')).toBe(true)
    expect(isSensitive('username', { revealIdentifiers: true })).toBe(false)
    expect(isSensitive('text')).toBe(false)
  })
})

describe('policy gate', () => {
  const base = { allowedHosts: ['app.example.com'], blockedWords: [] as string[], advisory: [] as string[] }
  const gate = (over: Partial<Guardrails> = {}, now: () => number = () => 1000) => new PolicyGate({ ...base, readOnly: false, ...over }, now)
  const req = (method: string, url: string, resourceType = 'fetch', postData?: string) => ({ method, url, resourceType, postData })

  it('keeps navigation and calls on the allowed host (subdomains included)', () => {
    const g = gate()
    expect(g.checkRequest(req('GET', 'https://app.example.com/x', 'document')).allow).toBe(true)
    expect(g.checkRequest(req('GET', 'https://eu.app.example.com/x')).allow).toBe(true)
    expect(g.checkRequest(req('GET', 'https://evil.example.net/x', 'document')).allow).toBe(false)
    expect(g.checkRequest(req('GET', 'https://notapp.example.com.evil.io/', 'xhr')).allow).toBe(false)
    expect(g.checkRequest(req('GET', 'file:///etc/passwd', 'document')).allow).toBe(false)
  })

  it('lets a page load scripts, styles, fonts and pictures from other hosts, but not send data out', () => {
    const g = gate()
    for (const type of ['image', 'font', 'stylesheet', 'media', 'script']) {
      expect(g.checkRequest(req('GET', 'https://cdn.other.com/a', type)).allow, type).toBe(true)
    }
    expect(g.checkRequest(req('GET', 'https://api.other.com/data', 'fetch')).allow).toBe(false)
    expect(g.checkRequest(req('POST', 'https://cdn.other.com/log', 'fetch')).allow).toBe(false)
  })

  it('reports the hosts it turned away, and learns one when the person allows it', () => {
    const g = gate()
    g.checkRequest(req('GET', 'https://api.other.com/a'))
    g.checkRequest(req('GET', 'https://api.other.com/b'))
    expect(g.blockedHosts()).toEqual([{ host: 'api.other.com', count: 2 }])
    g.allowHost('api.other.com')
    expect(g.checkRequest(req('GET', 'https://api.other.com/c')).allow).toBe(true)
  })

  it('can be told to leave the app\'s own sites', () => {
    const g = gate({ stayOnSites: false })
    expect(g.checkRequest(req('GET', 'https://anywhere.example.net/', 'document')).allow).toBe(true)
    expect(g.checkRequest(req('GET', 'file:///etc/passwd', 'document')).allow).toBe(false)
  })

  it('restricts nothing else by default: data-changing requests and any control are allowed', () => {
    const g = gate()
    expect(g.checkRequest(req('POST', 'https://app.example.com/orders')).allow).toBe(true)
    expect(g.checkRequest(req('DELETE', 'https://app.example.com/orders/1')).allow).toBe(true)
    for (const label of ['Delete account', 'Pay now', 'Place order', 'Send', 'Save changes']) expect(g.checkClick({ label }).allow, label).toBe(true)
    expect(g.checkClick({ label: '', kind: 'button' }).allow).toBe(true)
  })

  it('read-only blocks requests that change data, except in the short window opened by a declared sign-in', () => {
    let t = 1000
    const g = gate({ readOnly: true }, () => t)
    const post = req('POST', 'https://app.example.com/orders')
    expect(g.checkRequest(post).allow).toBe(false)
    g.openSessionWindow(5000)
    expect(g.checkRequest(post).allow).toBe(true)
    t += 6000
    expect(g.checkRequest(post).allow).toBe(false)
  })

  it('read-only still lets an app read with POST: GraphQL queries, searches and endpoints seen answering reads', () => {
    const g = gate({ readOnly: true })
    const gql = (body: unknown) => g.checkRequest(req('POST', 'https://app.example.com/graphql', 'fetch', JSON.stringify(body))).allow
    expect(gql({ query: 'query Customers { customers { id } }' })).toBe(true)
    expect(gql({ query: '{ customers { id } }' })).toBe(true)
    expect(gql({ query: '# list them\nquery { a }' })).toBe(true)
    expect(gql({ query: 'mutation Delete { deleteCustomer(id: 1) }' })).toBe(false)
    expect(gql([{ query: 'query A { a }' }, { query: 'mutation B { b }' }])).toBe(false)
    expect(gql({ operationName: 'GetCustomers' })).toBe(true)
    expect(gql({ operationName: 'DeleteCustomer' })).toBe(false)
    expect(g.checkRequest(req('POST', 'https://app.example.com/graphql', 'fetch', 'not json')).allow).toBe(false)
    expect(g.checkRequest(req('POST', 'https://app.example.com/api/customers/search')).allow).toBe(true)
    expect(g.checkRequest(req('POST', 'https://app.example.com/api/customers/list-all')).allow).toBe(true)
    expect(g.checkRequest(req('POST', 'https://app.example.com/api/customers/create')).allow).toBe(false)
    expect(g.checkRequest(req('POST', 'https://app.example.com/api/report')).allow).toBe(false)
    g.learnReadEndpoint('POST', 'https://app.example.com/api/report')
    expect(g.checkRequest(req('POST', 'https://app.example.com/api/report')).allow).toBe(true)
  })

  it('read-only never clicks controls that change, remove or spend something', () => {
    const g = gate({ readOnly: true })
    for (const label of ['Delete account', 'Pay now', 'Place order', 'Send', 'Save changes', 'Cancel subscription', 'Reset password']) {
      expect(g.checkClick({ label }).allow, label).toBe(false)
    }
    for (const label of ['Next', 'Overview', 'Customers', 'Open report']) expect(g.checkClick({ label }).allow, label).toBe(true)
  })

  it('"never delete" stops delete controls, links and icon-only buttons, and nothing else', () => {
    const g = gate({ noDelete: true })
    expect(g.checkClick({ label: 'Delete customer' }).allow).toBe(false)
    expect(g.checkClick({ label: 'Remove', kind: 'button' }).allow).toBe(false)
    expect(g.checkClick({ label: 'Details', kind: 'link', href: 'https://app.example.com/customers/3/delete?confirm=1' }).allow).toBe(false)
    expect(g.checkClick({ label: '', kind: 'button', hint: 'icon-btn btn-trash' }).allow).toBe(false)
    expect(g.checkClick({ label: '', kind: 'button', hint: 'icon-btn' }).allow).toBe(false)
    expect(g.checkClick({ label: '', kind: 'link', href: 'https://app.example.com/reports' }).allow).toBe(true)
    expect(g.checkClick({ label: 'Pay now' }).allow).toBe(true)
    expect(g.checkRequest(req('POST', 'https://app.example.com/orders')).allow).toBe(true)
  })

  it('"never spend" and "never change settings" are separate boxes', () => {
    const spend = gate({ noSpend: true })
    expect(spend.checkClick({ label: 'Pay now' }).allow).toBe(false)
    expect(spend.checkClick({ label: 'Delete' }).allow).toBe(true)
    const settings = gate({ noSettings: true })
    expect(settings.checkClick({ label: 'Change password' }).allow).toBe(false)
    expect(settings.checkClick({ label: 'Pay now' }).allow).toBe(true)
  })

  it('never presses sign-out while exploring, in any mode, only as a declared step', () => {
    const g = gate()
    expect(g.checkClick({ label: 'Log out' }).allow).toBe(false)
    expect(g.checkClick({ label: 'Sign Out' }).allow).toBe(false)
    expect(g.checkClick({ label: 'Account', kind: 'link', href: 'https://app.example.com/session/logout' }).allow).toBe(false)
    expect(g.checkClick({ label: 'Log out', intent: 'logout' }).allow).toBe(true)
  })

  it('a declared sign-in may only press a sign-in control, and a sign-out only a sign-out control', () => {
    const g = gate()
    expect(g.checkClick({ label: 'Log in', intent: 'login-submit' }).allow).toBe(true)
    expect(g.checkClick({ label: 'Delete everything', intent: 'login-submit' }).allow).toBe(false)
    expect(g.checkClick({ label: 'Sign out', intent: 'logout' }).allow).toBe(true)
    expect(g.checkClick({ label: 'Pay', intent: 'logout' }).allow).toBe(false)
  })

  it('keeps an audit trail', () => {
    const g = gate({ noDelete: true })
    g.checkClick({ label: 'Delete' })
    g.checkRequest(req('GET', 'https://app.example.com/', 'document'))
    expect(g.audit.map((a) => [a.kind, a.allow])).toEqual([['click', false], ['request', true]])
  })
})

describe('restrictions from ticks and text', () => {
  it('restricts nothing by default except leaving the app\'s own sites', () => {
    const r = interpretGuardrails('', 'https://app.example.com/login')
    expect(r.guardrails).toMatchObject({ allowedHosts: ['app.example.com'], readOnly: false, stayOnSites: true, noDelete: false, noSpend: false, noSettings: false, privacyMode: false })
    expect(r.enforced).toHaveLength(1)
    expect(r.enforced[0]).toContain('app.example.com')
    expect(r.advisory).toEqual([])
  })

  it('turns "do not delete or update" into rules, and says what it cannot enforce', () => {
    const r = interpretGuardrails('Only record the customer01 customer in the ABC module. Do not delete or update any data.', 'https://app.example.com/login')
    expect(r.guardrails.readOnly).toBe(true)
    expect(r.guardrails.noDelete).toBe(true)
    expect(r.enforced.join(' ')).toContain('Nothing that changes data')
    expect(r.advisory).toHaveLength(1)
    expect(r.advisory[0]).toContain('customer01')
    expect(r.advisory[0]).toContain('cannot check')
  })

  it('reads the ticked boxes', () => {
    const r = interpretGuardrails('', 'https://a.example.com', { noSpend: true, privacyMode: true, stayOnSites: false })
    expect(r.guardrails).toMatchObject({ noSpend: true, privacyMode: true, stayOnSites: false, readOnly: false })
    expect(r.enforced.join(' ')).toContain('bought, paid for')
    expect(r.enforced.join(' ')).not.toContain('Only pages on')
  })

  it('does not treat permission as a restriction', () => {
    expect(interpretGuardrails('You may delete test records.', 'https://a.example.com').guardrails).toMatchObject({ readOnly: false, noDelete: false })
  })

  it('keeps what it cannot turn into a rule as advice', () => {
    const r = interpretGuardrails('Never touch the billing area.', 'https://a.example.com')
    expect(r.advisory).toEqual(['Never touch the billing area.'])
  })

  it('turns "do not press X" into a block', () => {
    const r = interpretGuardrails('Do not click Export.', 'https://a.example.com')
    expect(r.guardrails.blockedWords).toContain('export')
    expect(new PolicyGate(r.guardrails).checkClick({ label: 'Export all' }).allow).toBe(false)
  })
})

describe('camera', () => {
  const vp = { width: 1280, height: 720 }
  it('zooms to a small target and stays at 1× for the whole page', () => {
    expect(viewFor(undefined, vp)).toEqual({ z: 1, cx: 0.5, cy: 0.5 })
    const v = viewFor({ x: 156, y: 334, w: 469, h: 32 }, vp)
    expect(v.z).toBeGreaterThan(1.3)
    expect(v.z).toBeLessThanOrEqual(1.5)
    // the window never leaves the picture
    expect(v.cx - 0.5 / v.z).toBeGreaterThanOrEqual(-1e-9)
    expect(v.cx + 0.5 / v.z).toBeLessThanOrEqual(1 + 1e-9)
    expect(viewFor({ x: 0, y: 0, w: 1280, h: 720 }, vp).z).toBe(1)
  })

  it('moves between beats with increasing key times', () => {
    const take: Take = {
      fps: 30, viewport: vp, durationSec: 20, redactionMisses: 0, log: [], navigations: [],
      beats: [
        { beat: 0, startSec: 0, endSec: 8, url: 'https://a/', focus: { x: 100, y: 300, w: 900, h: 200, zoom: 1 } },
        { beat: 1, startSec: 8, endSec: 14, url: 'https://a/' },
        { beat: 2, startSec: 14, endSec: 20, url: 'https://a/', focus: { x: 150, y: 330, w: 400, h: 40, zoom: 1 } }
      ]
    }
    const keys = cameraKeys(take, 0, 20)
    for (let i = 1; i < keys.length; i++) expect(keys[i].t).toBeGreaterThan(keys[i - 1].t)
    expect(keys[0].z).toBe(1)
    expect(keys.at(-1)!.t).toBe(20)
  })

  it('shows the address that was on screen, and when it changed', () => {
    const take = { navigations: [{ t: 0.5, url: 'https://a.example.com/login' }, { t: 10, url: 'https://a.example.com/secure' }, { t: 20, url: 'https://a.example.com/login' }] } as Take
    const a = addressTimeline(take, 0.5, 30)
    expect(a.map((x) => x.text)).toEqual(['a.example.com/login', 'a.example.com/secure', 'a.example.com/login'])
    expect(a[0].from).toBe(0)
    expect(a[1].from).toBeCloseTo(9.5)
  })
})

describe('saved files are valid', () => {
  it('app map and playbook schemas accept what the stages produce', () => {
    expect(() => Playbook.parse({ version: 1, title: 't', startUrl: 'https://a/', steps: [{ id: 's1', beat: 0, kind: 'type', selector: '#u', text: '{{secret:username}}', focus: 'target' }] })).not.toThrow()
    expect(() => Playbook.parse({ version: 1, title: 't', startUrl: 'https://a/', steps: [{ id: 's1', beat: 0, kind: 'teleport' }] })).toThrow()
    expect(() => AppMap.parse({ version: 1, startUrl: 'https://a/', host: 'a', scoutedAt: 'now', pages: [], login: { detected: false, otpLikely: false }, sensitiveSelectors: [] })).not.toThrow()
  })
})

// a real browser, a real page: sensitive things must be blurred BEFORE anything is drawn
describe.skipIf(!findChrome())('redaction in a real page', () => {
  const html = encodeURIComponent(`<html><body><p id="hint">The secret is hunter2secret, keep it safe.</p><input id="pw" type="password" value="x"><input id="nm" type="text" value="Ada"></body></html>`)
  it('blurs password fields and known secret text, and notices when something is not blurred', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-recon-'))
    const browser = await launch({ userDataDir: dir, scale: 1 })
    try {
      const cfg = { selectors: [], values: ['hunter2secret'] }
      const page = await browser.newPage()
      await page.evaluateOnNewDocument(redactionInitScript(cfg))
      await page.goto(`data:text/html,${html}`)
      await new Promise((r) => setTimeout(r, 300))
      const filters = await page.evaluate(() => ({
        pw: getComputedStyle(document.getElementById('pw')!).filter,
        nm: getComputedStyle(document.getElementById('nm')!).filter,
        wrapped: document.querySelectorAll('[data-vg-redact]').length
      }))
      expect(filters.pw).toContain('blur')
      expect(filters.nm).toBe('none')
      expect(filters.wrapped).toBe(1)
      const ok = JSON.parse((await page.evaluate(verifyScript(cfg))) as string) as { misses: number }
      expect(ok.misses).toBe(0)

      // a page that never had the rules installed is caught by the check
      const bare = await browser.newPage()
      await bare.goto(`data:text/html,${html}`)
      const bad = JSON.parse((await bare.evaluate(verifyScript(cfg))) as string) as { misses: number }
      expect(bad.misses).toBeGreaterThan(0)
    } finally {
      await browser.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})
