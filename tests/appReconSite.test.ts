import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { enforcePolicy, findChrome, launch } from '../src/main/appRecon/browser'
import { ALL_KINDS, findPrivate, pageDetectorSource } from '../src/main/appRecon/detect'
import { PolicyGate } from '../src/main/appRecon/policy'
import { prepare } from '../src/main/appRecon/recorder'
import { verifyScript, type RedactionConfig } from '../src/main/appRecon/redact'
import type { Guardrails } from '../src/shared/appRecon'
import { startAppSite, type AppSite } from './fixtures/appSite'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => Promise<boolean>, ms = 6000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check().catch(() => false)) return true
    await wait(80)
  }
  return false
}

describe.skipIf(!findChrome())('the test web app, in a real browser', () => {
  let site: AppSite
  let browser: Browser
  let dir: string

  beforeAll(async () => {
    site = await startAppSite()
    dir = mkdtempSync(join(tmpdir(), 'vg-site-'))
    browser = await launch({ userDataDir: dir, scale: 1 })
  }, 180000)
  afterAll(async () => {
    await browser?.close()
    await site?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  const guard = (over: Partial<Guardrails> = {}) => new PolicyGate({ allowedHosts: ['localhost'], readOnly: false, blockedWords: [], advisory: [], ...over })

  /** a logged-in dashboard with the gate and (optionally) the redaction installed */
  async function open(gate: PolicyGate, redaction?: RedactionConfig): Promise<Page> {
    const ctx = await browser.createBrowserContext()
    const p = await ctx.newPage()
    await enforcePolicy(p, gate)
    if (redaction) await prepare(p, redaction)
    await p.setCookie({ name: 'sid', value: '1', url: site.url })
    await p.goto(`${site.url}/app`, { waitUntil: 'load' })
    await wait(400)
    return p
  }
  const click = (p: Page, sel: string) => p.click(sel)
  const blurOf = (p: Page, sel: string) => p.$eval(sel, (el) => getComputedStyle(el).filter)

  it('lets a page load a script from another origin, but not send a data request there (D2)', async () => {
    const gate = guard()
    const p = await open(gate)
    expect(await p.evaluate(() => (window as unknown as { __libLoaded?: boolean }).__libLoaded)).toBe(true)
    const reached = await p.evaluate(async (u) => fetch(`${u}/api/data`).then(() => true).catch(() => false), site.otherUrl)
    expect(reached).toBe(false)
    expect(gate.blockedHosts().map((h) => h.host)).toContain('127.0.0.1')
    await p.close()
  }, 60000)

  it('read-only still lets the app search with POST and load stats with a GraphQL query (D1)', async () => {
    const gate = guard({ readOnly: true })
    const p = await open(gate)
    await p.type('#q', 'ada')
    await click(p, '#go')
    expect(await until(async () => (await p.$eval('#results', (e) => e.textContent ?? '')).includes('Ada Lovelace'))).toBe(true)
    await click(p, '#stats')
    expect(await until(async () => (await p.$eval('#statsout', (e) => e.textContent ?? '')).includes('customers: 2'))).toBe(true)
    await p.close()
  }, 60000)

  it('read-only changes nothing: delete, save and a GraphQL mutation are all blocked', async () => {
    const before = { deleted: site.state.deleted.length, saved: site.state.settingsSaved, purged: site.state.purged }
    const gate = guard({ readOnly: true })
    const p = await open(gate)
    await click(p, '.btn-trash')
    await click(p, '#save')
    await click(p, '#purge')
    await wait(800)
    expect(site.state.deleted.length).toBe(before.deleted)
    expect(site.state.settingsSaved).toBe(before.saved)
    expect(site.state.purged).toBe(before.purged)
    expect(gate.audit.filter((a) => a.kind === 'request' && !a.allow).length).toBeGreaterThanOrEqual(3)
    await p.close()
  }, 60000)

  it('with nothing restricted, the app does what it is asked: save and purge go through', async () => {
    const before = { saved: site.state.settingsSaved, purged: site.state.purged }
    const gate = guard()
    const p = await open(gate)
    await click(p, '#save')
    await click(p, '#purge')
    expect(await until(async () => site.state.settingsSaved > before.saved && site.state.purged > before.purged)).toBe(true)
    await p.close()
  }, 60000)

  it('blurs a password and a token inside shadow DOM, and the check looks there too', async () => {
    const cfg: RedactionConfig = { selectors: [], values: [] }
    const p = await open(guard(), cfg)
    const inShadow = await p.evaluate(() => {
      const root = document.getElementById('sbox')!.shadowRoot!
      return { pw: getComputedStyle(root.getElementById('spw')!).filter, wrapped: root.querySelectorAll('[data-vg-redact]').length }
    })
    expect(inShadow.pw).toContain('blur')
    expect(inShadow.wrapped).toBeGreaterThan(0)
    const res = JSON.parse((await p.evaluate(verifyScript(cfg))) as string) as { misses: number; detail: string[] }
    expect(res.detail).toEqual([])
    await p.close()
  }, 60000)

  it('blurs a password and a token inside a frame from another origin', async () => {
    const cfg: RedactionConfig = { selectors: [], values: [] }
    // the frame's host is allowed (a host the person approved after the review listed it)
    const p = await open(guard({ allowedHosts: ['localhost', '127.0.0.1'] }), cfg)
    await until(async () => p.frames().some((f) => f.url().includes('/frame')))
    const frame = p.frames().find((f) => f.url().includes('/frame'))!
    expect(await until(async () => (await frame.$eval('#fpw', (el) => getComputedStyle(el).filter)).includes('blur'))).toBe(true)
    expect(await frame.$$eval('[data-vg-redact]', (e) => e.length)).toBeGreaterThan(0)
    await p.close()
  }, 60000)

  it('by default blurs credential-like text but leaves emails, the table and the chart readable', async () => {
    const p = await open(guard(), { selectors: [], values: [] })
    expect(await p.$$eval('#tokentext [data-vg-redact]', (e) => e.length)).toBeGreaterThan(0)
    expect(await blurOf(p, '#contact')).toBe('none')
    expect(await p.$$eval('#contact [data-vg-redact]', (e) => e.length)).toBe(0)
    expect(await blurOf(p, '#customers td')).toBe('none')
    expect(await blurOf(p, '#chart')).toBe('none')
    await p.close()
  }, 60000)

  it('privacy mode blurs email text, the table, the chart and the frame, and the check agrees', async () => {
    const cfg: RedactionConfig = { selectors: [], values: [], privacy: true }
    const p = await open(guard(), cfg)
    expect(await p.$$eval('#contact [data-vg-redact]', (e) => e.length)).toBeGreaterThan(0)
    expect(await blurOf(p, '#customers td')).toContain('blur')
    expect(await blurOf(p, '#chart')).toContain('blur')
    expect(await blurOf(p, '#frm')).toContain('blur')
    const res = JSON.parse((await p.evaluate(verifyScript(cfg))) as string) as { misses: number; detail: string[] }
    expect(res.detail).toEqual([])
    await p.close()
  }, 60000)

  it('the check notices private text that was not blurred', async () => {
    const p = await open(guard()) // no redaction installed at all
    const res = JSON.parse((await p.evaluate(verifyScript({ selectors: [], values: [], privacy: true }))) as string) as { misses: number }
    expect(res.misses).toBeGreaterThan(0)
    await p.close()
  }, 60000)

  it('the page-side detector finds exactly what the Node-side detector finds', async () => {
    const samples = [
      'write to jordan.smith@example.com today',
      'call +1 (415) 555-0134 now',
      'card 4242 4242 4242 4242 and 1234 5678 9012 3456',
      'ssn 123-45-6789 and token ' + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGHijkl',
      'Invoice 2026-11-13 total $1,234.50 for order 4821',
      'account 123456789012'
    ]
    const p = await open(guard())
    const src = pageDetectorSource(ALL_KINDS.filter((k) => k !== 'secret'))
    for (const s of samples) {
      const fromPage = (await p.evaluate(`(${src})(${JSON.stringify(s)})`)) as Array<{ kind: string; start: number; end: number }>
      const pageFound = fromPage.map((r) => `${r.kind}:${s.slice(r.start, r.end)}`).sort()
      const nodeFound = findPrivate(s, { kinds: ALL_KINDS.filter((k) => k !== 'secret') }).map((f) => `${f.kind}:${f.text}`).sort()
      expect(pageFound, s).toEqual(nodeFound)
    }
    await p.close()
  }, 60000)
})
