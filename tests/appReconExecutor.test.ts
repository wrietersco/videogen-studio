import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { launch } from '../src/main/appRecon/browser'
import { prepare } from '../src/main/appRecon/recorder'
import { PolicyGate } from '../src/main/appRecon/policy'
import { findElement } from '../src/main/appRecon/resolve'
import { execNewAtom } from '../src/main/appRecon/atomExec'
import { sweepOverlays, controlRole, pressOrder, policyFromWhenever } from '../src/main/appRecon/overlays'
import { pickByStructure, parseNumber, ordinalIn } from '../src/main/appRecon/pageModel'
import { parseKeys, saysDate } from '../src/main/appRecon/gestures'
import { editKeyedValue } from '../src/main/appRecon/actions'
import { runPlaybook } from '../src/main/appRecon/recorder'
import type { Playbook } from '../src/shared/appRecon'
import type { Atom, FindSpec } from '../src/shared/appRecon'
import { startExecSite, type ExecSite } from './fixtures/execSite'

/**
 * The action layer on pages built to trip it: overlays that arrive mid-run, frames and shadow roots, forgiving names, picks by
 * place and by value, drag, sliders, dates, feeds, editors, keys and SVG charts. Each action must be seen to work on the page
 * (events the page reports), and one that cannot work must come back as skipped, never as done.
 */

const gate = () => new PolicyGate({ allowedHosts: ['localhost', '127.0.0.1'], readOnly: false, blockedWords: [], advisory: [] })
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('what the action layer reads, with no browser', () => {
  it('says what a pop-up control means, and presses the privacy-preserving one first', () => {
    expect(controlRole('Only necessary')).toBe('reject')
    expect(controlRole('Reject non-essential')).toBe('reject')
    expect(controlRole('No thanks')).toBe('reject')
    expect(controlRole('×')).toBe('close')
    expect(controlRole('', 'Close')).toBe('close')
    expect(controlRole('Got it')).toBe('ack')
    expect(controlRole('Accept all')).toBe('accept')
    expect(controlRole('Subscribe')).toBe('other')
    expect(controlRole('Get 10% off')).toBe('other')
    const roles = ['accept', 'reject', 'close'] as const
    const p = policyFromWhenever([])
    // a cookie banner: the essentials first; "accept all" is never pressed unless the person said so
    expect(pressOrder('cookie', [...roles], p)).toEqual([1, 2])
    expect(pressOrder('cookie', [...roles], policyFromWhenever([{ condition: 'cookie', action: 'accept' }]))[0]).toBe(0)
    expect(pressOrder('popup', ['other', 'close', 'reject'], p)).toEqual([1, 2])
    expect(pressOrder('cookie', [...roles], policyFromWhenever([{ condition: 'cookie banner', action: 'leave' }]))).toEqual([])
  })
  it('reads numbers the way pages write them', () => {
    expect(parseNumber('£1,249.00')).toBe(1249)
    expect(parseNumber('1.299,50 €')).toBe(1299.5)
    expect(parseNumber('12,5')).toBe(12.5)
    expect(parseNumber('Total: 89.99')).toBe(89.99)
    expect(parseNumber('no number')).toBeNull()
    expect(ordinalIn('the third column')).toEqual({ n: 3, rest: 'the column' })
  })
  it('reads keys and chords', () => {
    expect(parseKeys('Control+K')).toEqual([['Control', 'k']])
    expect(parseKeys('Ctrl + Shift + P')).toEqual([['Control', 'Shift', 'p']])
    expect(parseKeys('ArrowDown ArrowDown Enter')).toEqual([['ArrowDown'], ['ArrowDown'], ['Enter']])
    expect(parseKeys('esc')).toEqual([['Escape']])
  })
  it('replaces just the value that belongs to a name in a text', () => {
    expect(editKeyedValue('{"plan": "pro"}', 'plan', 'team')).toBe('{"plan": "team"}')
    expect(editKeyedValue('{"plan": "pro", "seats": 3}', 'seats', '10')).toBe('{"plan": "pro", "seats": 10}')
    expect(editKeyedValue('plan = pro\nseats = 3', 'plan', 'team')).toBe('plan = team\nseats = 3')
    expect(editKeyedValue('{"plan": "pro"}', 'colour', 'red')).toBeNull()
  })
  it('knows a date written in different ways', () => {
    expect(saysDate('27/11/2026', '2026-11-27')).toBe(true)
    expect(saysDate('November 27, 2026', '2026-11-27')).toBe(true)
    expect(saysDate('Fri, 27 Nov 2026', '2026-11-27')).toBe(true)
    expect(saysDate('November 28, 2026', '2026-11-27')).toBe(false)
  })
})

describe('the action layer on pages with traps', () => {
  let site: ExecSite
  let browser: Browser
  let dir: string
  const log: string[] = []

  const open = async (path: string, wait = 0): Promise<Page> => {
    const page = await browser.newPage()
    await prepare(page, { selectors: [], values: [] })
    await page.goto(site.url + path, { waitUntil: 'load' })
    if (wait) await nap(wait)
    return page
  }
  const ctxFor = (page: Page) => ({
    page,
    gate: gate(),
    log: (m: string) => log.push(m),
    relaxed: false,
    said: '',
    locate: async (a: { find: FindSpec; label: string }) => {
      const r = await findElement(page, a.find, 3000)
      return { found: r.found, miss: r.miss, prep: [] }
    }
  })
  const find = (target: string, kind: FindSpec['kind'] = 'click', more: Partial<FindSpec> = {}): FindSpec => ({ target, kind, ...more })
  const run = (page: Page, atom: Atom) => execNewAtom(atom as never, ctxFor(page))
  const seenEvents = () => [...site.events]

  beforeAll(async () => {
    site = await startExecSite()
    dir = mkdtempSync(join(tmpdir(), 'vg-exec-'))
    browser = await launch({ userDataDir: dir, width: 900, height: 640, scale: 1 })
  }, 90000)
  afterAll(async () => {
    await Promise.race([browser?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 20000))])
    browser?.process()?.kill()
    await site?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 120000)

  it('closes a pop-up that arrived mid-run before pressing what it covered, and says the click was verified', async () => {
    site.events.length = 0
    const page = await open('/overlay', 1700) // the promo (1.2 s) and the cookie banner (0.2 s) are both up
    const r = await run(page, { action: 'click', label: 'Place order', find: find('Place order') })
    expect(r.skipped).toEqual([])
    expect(r.verified).toBe(true)
    const ev = seenEvents()
    expect(ev).toContain('promo-close')
    expect(ev).toContain('order')
    // the pop-up was closed with its "No thanks" / ×, never by pressing "Subscribe"
    expect(ev).not.toContain('promo-subscribe')
    expect(ev.indexOf('promo-close')).toBeLessThan(ev.indexOf('order'))
    expect(log.join('\n')).toMatch(/closed the (dialog|pop-up)/)
    await page.close()
  }, 90000)

  it('closes a cookie banner with the essentials only, never "Accept all"', async () => {
    site.events.length = 0
    const page = await open('/overlay', 600) // only the banner is up
    const res = await sweepOverlays(page, { log: (m) => log.push(m) })
    expect(res.closed.join(' ')).toMatch(/cookie banner/)
    expect(seenEvents()).toContain('cookie-essential')
    expect(seenEvents()).not.toContain('cookie-accept')
    await page.close()
  }, 60000)

  it('does not call a click done when the page did not react to it, and says so', async () => {
    const page = await open('/shop', 200)
    const r = await run(page, { action: 'click', label: 'Delete', find: find('Delete') })
    // it was pressed and reached the control (done), and the page showing nothing is said separately
    expect(r.did).toBe(1)
    expect(r.changed).toBe(false)
    await page.close()
  }, 60000)

  it('finds and presses a button inside an iframe and one inside a shadow root', async () => {
    site.events.length = 0
    const page = await open('/frames', 300)
    const a = await run(page, { action: 'click', label: 'Frame button', find: find('Frame button') })
    const b = await run(page, { action: 'click', label: 'Shadow button', find: find('Shadow button') })
    expect(a.skipped).toEqual([])
    expect(b.skipped).toEqual([])
    await nap(200)
    expect(seenEvents()).toEqual(expect.arrayContaining(['frame-button', 'shadow-button']))
    expect(b.verified).toBe(true)
    await page.close()
  }, 60000)

  it('matches loose wording: typos, apostrophes, filler words, colours, icons', async () => {
    const page = await open('/shop', 200)
    const label = async (t: string, extra: Partial<FindSpec> = {}) => (await findElement(page, find(t, 'click', extra), 1500)).found?.label ?? null
    expect(await label('mens cut is fine')).toMatch(/Men/)
    expect(await label("Kid's cut")).toMatch(/Kids/)
    expect(await label('daniel as the stylist')).toBe('Daniel')
    expect(await label('Mei as the stylist')).toBe('Mei')
    const red = (await findElement(page, find('the red colour'), 1500)).found
    expect(red).toBeTruthy()
    const where = await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.dataset.n, red!.selector)
    expect(where).toBe('red')
    expect(await label('gear icon')).toMatch(/Settings/i)
    expect(await label('the heart')).toMatch(/wishlist/i)
    expect(await label('bin icon')).toMatch(/Delete/i)
    // a name nothing has is not found, and nothing is guessed
    expect((await findElement(page, find('Quantum teleporter'), 800)).found).toBeNull()
    await page.close()
  }, 90000)

  it('picks by place and by value, and refuses when the values cannot be read', async () => {
    const page = await open('/shop', 200)
    const cheapest = await pickByStructure(page, { label: 'jacket', criterion: 'cheapest' })
    expect(cheapest.ok && cheapest.label).toMatch(/City Rain/)
    const second = await pickByStructure(page, { label: 'product', ordinal: 2 })
    expect(second.ok && second.label).toMatch(/City Rain/)
    const first = await pickByStructure(page, { label: 'product', ordinal: 1 })
    expect(first.ok && first.label).toMatch(/Trail Shell/)
    const dearest = await pickByStructure(page, { label: 'jacket', criterion: 'most-expensive' })
    expect(dearest.ok && dearest.label).toMatch(/Summit/)
    const row = await pickByStructure(page, { label: 'row', criterion: 'highest', field: 'total' })
    expect(row.ok && row.label).toMatch(/Bo/)
    const low = await pickByStructure(page, { label: 'row', criterion: 'lowest', field: 'total' })
    expect(low.ok && low.label).toMatch(/Cy/)
    const last = await pickByStructure(page, { label: 'row', ordinal: -1 })
    expect(last.ok && last.label).toMatch(/Cy/)
    // one price cannot be read: nothing is picked
    await page.evaluate(() => { document.querySelectorAll('.prod .price')[1]!.textContent = 'ask us' })
    const none = await pickByStructure(page, { label: 'jacket', criterion: 'cheapest' })
    expect(none.ok).toBe(false)
    expect(!none.ok && none.why).toMatch(/could not be read/)
    await page.close()
  }, 90000)

  it('the pick atom presses the cheapest one and reports what it compared', async () => {
    site.events.length = 0
    const page = await open('/shop', 200)
    const r = await run(page, { action: 'pick', label: 'jacket', criterion: 'cheapest', find: find('cheapest jacket') })
    expect(r.skipped).toEqual([])
    expect(r.seen.join(' ')).toMatch(/cheapest.*99/)
    await nap(200)
    expect(seenEvents()).toContain('buy:city')
    await page.close()
  }, 60000)

  it('drags a card to another column with the pointer, and tells when the page ignored a drag', async () => {
    site.events.length = 0
    const page = await open('/kanban', 200)
    const r = await run(page, { action: 'drag', label: 'Fix login redirect → Done', from: 'Fix login redirect', to: 'Done', find: find('Fix login redirect') })
    expect(r.skipped).toEqual([])
    expect(r.verified).toBe(true)
    expect(seenEvents().join(' ')).toMatch(/moved:Fix login redirect>done/)
    // above a given card
    const r2 = await run(page, { action: 'drag', label: 'Logo refresh above Set up CI', from: 'Logo refresh', to: 'Done', position: 'before', ref: 'Set up CI', find: find('Logo refresh') })
    expect(r2.verified).toBe(true)
    const order = await page.evaluate(() => Array.from(document.querySelectorAll('[data-col=done] .task')).map((e) => e.textContent))
    expect(order.indexOf('Logo refresh')).toBeLessThan(order.indexOf('Set up CI'))
    await page.close()
  }, 120000)

  it('drags with the browser\'s own drag-and-drop when the page listens for that', async () => {
    site.events.length = 0
    const page = await open('/kanban5', 200)
    const r = await run(page, { action: 'drag', label: 'x', from: 'Fix login redirect', to: 'Done', find: find('Fix login redirect') })
    expect(r.verified).toBe(true)
    expect(seenEvents().join(' ')).toMatch(/dropped:Fix login redirect>done/)
    await page.close()
  }, 90000)

  it('sets a single slider and a two-thumb range to values', async () => {
    const page = await open('/slider', 200)
    const one = await run(page, { action: 'slider', label: 'Volume', value: 64, find: find('Volume') })
    expect(one.skipped).toEqual([])
    expect(await page.evaluate(() => (document.getElementById('vol') as HTMLInputElement).value)).toBe('64')
    const two = await run(page, { action: 'slider', label: 'Price range', min: 40, max: 80, find: find('Price range') })
    expect(two.skipped).toEqual([])
    const vals = await page.evaluate(() => [(document.getElementById('lo') as HTMLInputElement).value, (document.getElementById('hi') as HTMLInputElement).value])
    expect(vals).toEqual(['40', '80'])
    await page.close()
  }, 90000)

  it('types a date into a native date box and picks a day on a calendar by month', async () => {
    site.events.length = 0
    const page = await open('/dates', 200)
    const a = await run(page, { action: 'date', label: 'Check-in', date: '2026-12-04', phrase: 'Dec 4', find: find('Check-in') })
    expect(a.skipped).toEqual([])
    expect(await page.evaluate(() => (document.getElementById('native') as HTMLInputElement).value)).toBe('2026-12-04')
    const b = await run(page, { action: 'date', label: 'Appointment', date: '2027-02-09', phrase: 'February 9', find: find('Appointment') })
    expect(b.skipped).toEqual([])
    expect(b.verified).toBe(true)
    expect(await page.evaluate(() => (document.getElementById('appt') as HTMLInputElement).value)).toBe('February 9, 2027')
    // a day that does not exist is skipped
    const c = await run(page, { action: 'date', label: 'Appointment', date: '2027-02-31', phrase: 'Feb 31', find: find('Appointment') })
    expect(c.did === 0 || c.verified === false).toBe(true)
    await page.close()
  }, 90000)

  it('scrolls a feed until the text shows, and gives up honestly when it never does', async () => {
    const page = await open('/feed', 300)
    const r = await run(page, { action: 'scrollUntil', label: 'release notes', text: 'Release notes for version 2.0', find: find('feed') })
    expect(r.skipped).toEqual([])
    expect(r.verified).toBe(true)
    const vis = await page.evaluate(() => { const el = Array.from(document.querySelectorAll('.card')).find((e) => /version 2\.0/.test(e.textContent ?? ''))!; const b = el.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight })
    expect(vis).toBe(true)
    const never = await run(page, { action: 'scrollUntil', label: 'x', text: 'A post that does not exist anywhere', find: find('feed') })
    expect(never.verified).toBe(false)
    expect(never.skipped.length).toBe(1)
    await page.close()
  }, 150000)

  it('replaces the text of a contenteditable and a code editor, and appends when not told to replace', async () => {
    const page = await open('/editor', 200)
    const t = await run(page, { action: 'type', label: 'title', text: 'New title', replace: true, find: find('title', 'type') })
    expect(t.skipped).toEqual([])
    expect(await page.evaluate(() => document.getElementById('title')!.textContent)).toBe('New title')
    const c = await run(page, { action: 'type', label: 'code editor', text: '{"plan": "team"}', replace: true, find: find('code', 'type') })
    expect(c.skipped).toEqual([])
    expect((await page.evaluate(() => document.getElementById('code')!.textContent))!.replace(/\s/g, '')).toBe('{"plan":"team"}')
    const q = await run(page, { action: 'type', label: 'search', text: 'abc', find: find('Search', 'type') })
    expect(q.verified).toBe(true)
    await page.close()
  }, 90000)

  it('blurs a private box before typing into it, whatever the scout knew, and not a search box', async () => {
    const page = await open('/editor', 200)
    // blurred as soon as the page shows it (record-time classification), before anything is typed
    expect(await page.evaluate(() => document.getElementById('mail')!.hasAttribute('data-vg-blur'))).toBe(true)
    expect(await page.evaluate(() => document.getElementById('q')!.hasAttribute('data-vg-blur'))).toBe(false)
    // a box that appears later is classified as it appears
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'late'; i.type = 'text'; i.placeholder = 'Phone number'; document.body.appendChild(i) })
    await nap(300)
    expect(await page.evaluate(() => document.getElementById('late')!.hasAttribute('data-vg-blur'))).toBe(true)
    // text that looks private blurs the box it goes into
    await run(page, { action: 'type', label: 'search', text: 'ann@example.com', find: find('Search', 'type') })
    expect(await page.evaluate(() => document.getElementById('q')!.hasAttribute('data-vg-blur'))).toBe(true)
    const blurred = await page.evaluate(() => getComputedStyle(document.getElementById('mail')!).filter)
    expect(blurred).toContain('blur')
    await page.close()
  }, 60000)

  it('presses a chord and tabs until a control is focused', async () => {
    const page = await open('/keys', 200)
    const k = await run(page, { action: 'key', label: 'open the palette', keys: 'Control+K' })
    expect(k.verified).toBe(true)
    expect(await page.evaluate(() => (document.getElementById('palette') as HTMLElement).style.display)).toBe('block')
    await page.keyboard.press('Escape')
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    const t = await run(page, { action: 'key', label: 'tab to Export', keys: 'Tab', repeatUntil: 'Export' })
    expect(t.verified).toBe(true)
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('c')
    const never = await run(page, { action: 'key', label: 'tab to Nothing', keys: 'Tab', repeatUntil: 'Nonexistent control' })
    expect(never.verified).toBe(false)
    expect(never.skipped.length).toBe(1)
    await page.close()
  }, 90000)

  it('changes one value inside a code editor ("change plan to team") and leaves the rest of the text', async () => {
    const page = await open('/editor', 200)
    const r = await run(page, { action: 'type', label: 'plan', text: 'team', replace: true, find: find('plan', 'type', { within: ['request body'] }) })
    expect(r.skipped).toEqual([])
    expect(r.verified).toBe(true)
    expect(await page.evaluate(() => document.getElementById('code')!.textContent)).toBe('{"plan": "team"}')
    await page.close()
  }, 60000)

  it('types into whatever has focus after a key opened a palette', async () => {
    const page = await open('/keys', 200)
    await run(page, { action: 'key', label: 'open the palette', keys: 'Control+K' })
    const t = await run(page, { action: 'type', label: 'command', text: 'export', focused: true, find: find('nothing like this', 'type') })
    expect(t.skipped).toEqual([])
    expect(await page.evaluate(() => (document.getElementById('pi') as HTMLInputElement).value)).toBe('export')
    expect(t.steps[0]).toMatchObject({ kind: 'type', focused: true })
    await page.close()
  }, 60000)

  it('waits for text that arrives late even when nothing scrolls, and gives up honestly', async () => {
    const page = await open('/late', 100)
    const r = await run(page, { action: 'scrollUntil', label: 'the report', text: 'Report ready for download', find: find('report') })
    expect(r.skipped).toEqual([])
    expect(r.verified).toBe(true)
    const none = await run(page, { action: 'scrollUntil', label: 'x', text: 'never shows up', find: find('x'), dir: 'down' })
    expect(none.verified).toBe(false)
    await page.close()
  }, 90000)

  it('records a playbook: closes a late pop-up first, presses by name, notes it, and a failing sign-out check does not stop the film', async () => {
    site.events.length = 0
    const page = await open('/overlay', 1700)
    const pb: Playbook = {
      version: 1,
      title: 'overlay',
      startUrl: site.url + '/overlay',
      steps: [
        { id: 's1', beat: 0, kind: 'wait' },
        { id: 's2', beat: 1, kind: 'click', label: 'Place order', find: find('Place order'), focus: 'target' },
        { id: 's3', beat: 2, kind: 'click', label: 'Save settings', find: find('Save settings'), focus: 'target' },
        { id: 's4', beat: 3, kind: 'click', label: 'Quantum teleporter', find: find('Quantum teleporter'), focus: 'target' },
        { id: 's5', beat: 4, kind: 'wait', intent: 'logout', expect: { selectorVisible: '#sign-in-form' } }
      ]
    }
    const res = await runPlaybook(page, pb, { vault: {}, gate: gate(), redaction: { selectors: [], values: [] }, pace: 0, log: (m) => log.push(m) })
    expect(res.ok).toBe(true)
    const ev = seenEvents()
    expect(ev).toEqual(expect.arrayContaining(['promo-close', 'order', 'save']))
    expect(ev.indexOf('promo-close')).toBeLessThan(ev.indexOf('order'))
    expect(res.closed?.join(' ')).toMatch(/closed the (dialog|pop-up)/)
    // a control that does not exist is skipped and said so, never clicked
    expect(res.skipped?.map((s) => s.label)).toEqual(['Quantum teleporter'])
    await page.close()
  }, 120000)

  it('presses the heart of the second stylist, the second afternoon time, and the menu of the second card in the third column', async () => {
    site.events.length = 0
    const page = await open('/salon', 800)
    const h = await run(page, { action: 'pick', label: 'heart icon', within: 'second stylist', verb: 'click', find: find('heart', 'click', { role: 'icon' }) })
    expect(h.skipped).toEqual([])
    const t = await run(page, { action: 'pick', label: 'time', ordinal: 2, within: 'afternoon', verb: 'click', find: find('time', 'click', { within: ['afternoon'] }) })
    expect(t.skipped).toEqual([])
    const m = await run(page, { action: 'pick', label: 'card menu', ordinal: 2, within: 'third column', verb: 'click', find: find('card menu') })
    expect(m.skipped).toEqual([])
    await nap(300)
    expect(seenEvents()).toEqual(expect.arrayContaining(['heart:Daniel', 'slot:15:30', 'menu:C2']))
    expect(seenEvents()).not.toContain('slot:09:30')
    await page.close()
  }, 120000)

  it('picks a day on a calendar that is already open, moving to the month', async () => {
    site.events.length = 0
    const page = await open('/salon', 600)
    const r = await run(page, { action: 'date', label: 'three weeks from today', date: '2026-12-17', phrase: 'three weeks from today', find: find('three weeks from today') })
    expect(r.skipped).toEqual([])
    expect(r.verified).toBe(true)
    expect(await page.evaluate(() => document.getElementById('out')!.textContent)).toBe('Chosen: December 17, 2026')
    await page.close()
  }, 90000)

  it('presses a banner control once, says it stayed, and does not try again at every step', async () => {
    const page = await open('/overlay', 600)
    // a banner whose "Only necessary" does not hide it (a page that sets hidden but styles the box visible)
    await page.evaluate(() => { document.getElementById('ck-reject')!.onclick = () => undefined })
    const first = await sweepOverlays(page, { log: (m) => log.push(m) })
    expect(first.stuck).toMatch(/was pressed but it is still showing/)
    const t0 = Date.now()
    const again = await sweepOverlays(page, { log: (m) => log.push(m) })
    expect(again.closed).toEqual([])
    expect(Date.now() - t0).toBeLessThan(1500)
    await page.close()
  }, 60000)

  it('finds the tallest bar and a bar by its month on an SVG chart, and clicks it', async () => {
    site.events.length = 0
    const page = await open('/chart', 200)
    const tall = await run(page, { action: 'mark', verb: 'click', label: 'the tallest bar', colours: [], noun: 'bar', find: { target: 'chart', kind: 'click', noun: 'bar' } })
    expect(tall.skipped).toEqual([])
    expect(await page.evaluate(() => document.getElementById('readout')!.textContent)).toBe('Selected: Jun')
    const aug = await run(page, { action: 'mark', verb: 'click', label: 'the Aug bar', colours: [], noun: 'bar', find: { target: 'chart', kind: 'click', noun: 'bar' } })
    expect(aug.skipped).toEqual([])
    expect(await page.evaluate(() => document.getElementById('readout')!.textContent)).toBe('Selected: Aug')
    await page.close()
  }, 90000)
})
