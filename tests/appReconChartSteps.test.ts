import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { findChrome, launch } from '../src/main/appRecon/browser'
import { parseStepScript, coloursIn } from '../src/main/appRecon/stepScript'
import { performScript, scriptPlan } from '../src/main/appRecon/script'
import { prepare, runPlaybook } from '../src/main/appRecon/recorder'
import { PolicyGate } from '../src/main/appRecon/policy'
import { scrollToSection, revealHidden } from '../src/main/appRecon/sections'
import { colourOf, colourSpots, pickChart } from '../src/main/appRecon/marks'
import type { AppMap, Playbook } from '../src/shared/appRecon'
import { PRESET, startChartSite, type ChartSite } from './fixtures/chartSite'

/**
 * The run that showed the bug: a phone-sized recording of a research page where steps 3 to 9 ("scroll down to Whole-Quran
 * even–odd circle", "hover over a line on the chart", "click blue, green and orange lines", "use and explain the tab …") were
 * silently turned into nothing, and the voice described screens the film never showed.
 */

const STEPS = `1. go to \`http://localhost/compare.html\`
2. click the button: \`${PRESET}\`
3. scroll down to Whole-Quran even–odd circle
5. hover over a line on the chart to display the tooltip and explain the tooltip
>>6. click blue, green, and orange lines on the charts and explain how to read them. show examples
7. from the right panel, use and explain the tab \`About the words\`. click the arabic word in the verse to show the details provided below against the word
8. from the right panel, use and explain the tab \`Verse\`
9. from the right panel, use and explain the tab \`Matches\`
10. use the \`< match\` and \`match >\`  options to illustrate quick jumps to the word matches found in quran.`

describe('reading the steps that showed the bug', () => {
  const s = parseStepScript(STEPS)!
  const by = (n: number) => s.items.find((i) => i.written === n)!
  it('keeps every step, including the one with ">>" in front and the numbers that skip', () => {
    expect(s.items.map((i) => i.written)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10])
    expect(s.goal).toBe('')
  })
  it('reads "scroll down to <a part of the page>" as a scroll to that part, not a scroll of nothing', () => {
    expect(by(3).atoms).toEqual([expect.objectContaining({ action: 'scrollto', label: 'Whole-Quran even–odd circle', dir: 'down' })])
  })
  it('reads hovering over a line of a chart, and keeps what must be explained', () => {
    expect(by(5).atoms).toEqual([expect.objectContaining({ action: 'mark', verb: 'hover', noun: 'line', find: expect.objectContaining({ chart: 'chart' }) })])
    expect(by(5).explain).toMatch(/tooltip/)
  })
  it('reads "click blue, green, and orange lines" as one list of colours, not as three clicks on "blue", "green" and "orange lines"', () => {
    expect(by(6).atoms).toHaveLength(1)
    expect(by(6).atoms[0]).toMatchObject({ action: 'mark', verb: 'click', colours: ['blue', 'green', 'orange'], noun: 'line' })
    expect(by(6).explain).toMatch(/how to read them/)
  })
  it('does the tab named in "use and explain the tab X", and a click that follows the explanation', () => {
    expect(by(7).atoms.map((a) => a.action)).toEqual(['click', 'click'])
    expect(by(7).atoms[0]).toMatchObject({ label: 'About the words', find: { role: 'tab', region: 'right' } })
    expect(by(7).atoms[1]).toMatchObject({ label: 'arabic word', find: { within: expect.arrayContaining(['verse']) } })
    expect(by(8).atoms[0]).toMatchObject({ action: 'click', label: 'Verse', find: { role: 'tab' } })
    expect(by(9).atoms[0]).toMatchObject({ action: 'click', label: 'Matches', find: { role: 'tab' } })
    expect(by(10).atoms.map((a) => (a as { label: string }).label)).toEqual(['< match', 'match >'])
  })
  it('does not leave an empty "go to" in the notes of the step that opens an address', () => {
    expect(by(1).notes).toEqual([])
  })
  it('reads colour lists in any order and spelling', () => {
    expect(coloursIn('light blue, grey and Violet')).toEqual(['blue', 'gray', 'purple'])
  })
})

describe('colours seen on a picture', () => {
  it('tells the colours a person names, and ignores paper and faint grid lines', () => {
    expect(colourOf(31, 111, 208)).toBe('blue')
    expect(colourOf(42, 157, 58)).toBe('green')
    expect(colourOf(240, 138, 26)).toBe('orange')
    expect(colourOf(255, 255, 255)).toBeNull()
    expect(colourOf(235, 235, 235)).toBeNull()
  })
  it('finds a thin line of one colour and not the other colours', () => {
    const w = 120
    const h = 80
    const data = Buffer.alloc(w * h * 4, 255)
    for (let x = 10; x < 110; x++) for (let t = 0; t < 3; t++) { const i = ((20 + t) * w + x) * 4; data[i] = 31; data[i + 1] = 111; data[i + 2] = 208 }
    for (let x = 10; x < 110; x++) for (let t = 0; t < 3; t++) { const i = ((50 + t) * w + x) * 4; data[i] = 240; data[i + 1] = 138; data[i + 2] = 26 }
    const blue = colourSpots({ data, w, h, k: 1 }, 'blue', { thin: true })
    expect(blue.length).toBeGreaterThan(0)
    expect(blue.every((p) => p.colour === 'blue' && p.y > 15 && p.y < 28)).toBe(true)
    const orange = colourSpots({ data, w, h, k: 1 }, 'orange', { thin: true })
    expect(orange[0].y).toBeGreaterThan(45)
  })
})

const chrome = findChrome()

describe.skipIf(!chrome)('the steps, done on a phone-sized page', () => {
  let site: ChartSite
  let browser: Browser
  let dir = ''
  let page: Page
  const gate = () => new PolicyGate({ allowedHosts: ['localhost', '127.0.0.1'], readOnly: false, blockedWords: [], advisory: [] })
  const open = async (): Promise<Page> => {
    const p = await browser.newPage()
    await prepare(p, { selectors: [], values: [] })
    await p.goto(site.url, { waitUntil: 'load' })
    return p
  }
  const log: string[] = []
  const script = (text: string) => parseStepScript(text.replace('http://localhost/compare.html', site.url))!

  beforeAll(async () => {
    site = await startChartSite()
    dir = mkdtempSync(join(tmpdir(), 'vg-chart-'))
    browser = await launch({ userDataDir: dir, width: 390, height: 688, scale: 1, mobile: true })
  }, 90000)
  afterAll(async () => {
    await Promise.race([browser?.close().catch(() => undefined), new Promise((r) => setTimeout(r, 20000))])
    browser?.process()?.kill()
    await site?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 120000)

  it('finds a part of the page by its name, with another dash and different capitals, and scrolls there', async () => {
    page = await open()
    await page.click('#preset')
    const out = await scrollToSection(page, 'whole-quran EVEN-ODD circle', { budgetMs: 0, instant: true })
    expect(out.found).toBe(true)
    const top = await page.evaluate(() => document.querySelector('h3:nth-of-type(3)')?.getBoundingClientRect().top ?? -1)
    const y = await page.evaluate(() => scrollY)
    expect(y).toBeGreaterThan(1000)
    expect(top).toBeLessThan(200)
    // a name no part has is not found (and nothing moves)
    const none = await scrollToSection(page, 'Quantum teleporter', { budgetMs: 0, instant: true })
    expect(none.found).toBe(false)
    await page.close()
  }, 60000)

  it('scrolls to it in steps a viewer can watch when it is filmed', async () => {
    page = await open()
    await page.click('#preset')
    const ys: number[] = []
    const watcher = setInterval(() => void page.evaluate(() => scrollY).then((y) => ys.push(y)).catch(() => undefined), 40)
    const out = await scrollToSection(page, 'Whole-Quran even–odd circle', { budgetMs: 1500, instant: false })
    clearInterval(watcher)
    expect(out.found).toBe(true)
    expect(new Set(ys.map((y) => Math.round(y / 40))).size).toBeGreaterThan(5) // it travelled, it did not jump
    await page.close()
  }, 60000)

  it('opens a panel that a phone keeps folded behind a button, to reach the tab in it', async () => {
    page = await open()
    await page.click('#preset')
    const hidden = await page.evaluate(() => getComputedStyle(document.querySelector('#detail-pane')!).display)
    expect(hidden).toBe('none')
    const toggle = await revealHidden(page, { target: 'About the words', kind: 'click', role: 'tab', region: 'right' })
    expect(toggle).toMatchObject({ label: 'Show details' })
    await page.close()
  }, 60000)

  it('picks the chart the words point at and sees its coloured lines', async () => {
    page = await open()
    await page.click('#preset')
    await scrollToSection(page, 'Whole-Quran even–odd circle', { budgetMs: 0, instant: true })
    const chart = await pickChart(page, 'chart')
    expect(chart?.kind).toBe('canvas')
    await page.close()
  }, 60000)

  it('does steps 3 to 10: scrolls there, shows the tooltip, clicks the three lines, opens the folded panel and its tabs, jumps between matches', async () => {
    page = await open()
    site.events.length = 0
    const out = await performScript({ page, gate: gate(), script: script(STEPS), log: (m) => log.push(m) })
    expect(out.failure).toBeUndefined()
    expect(out.skipped).toEqual([])
    // the lines were really clicked, one of each colour, in the order written
    expect(site.events.filter((e) => e.startsWith('line:'))).toEqual(['line:blue', 'line:green', 'line:orange'])
    // the folded panel was opened, and its three tabs, then the Arabic word, were used
    expect(site.events).toContain('panel-toggle')
    expect(site.events.filter((e) => e.startsWith('tab:'))).toEqual(['tab:About the words', 'tab:Verse', 'tab:Matches'])
    expect(site.events).toContain('word:w1')
    expect(site.events.filter((e) => e === 'prev').length).toBe(1)
    expect(site.events.filter((e) => e === 'next').length).toBe(1)
    // the page really went down to the chart
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(1000)
    // what the tooltip said is known to the narration, so it can be explained and not invented
    const hover = out.results.find((r) => r.item.written === 5)!
    expect(hover.seen.join(' ')).toMatch(/tooltip that says: ".*(Blue|Green|Orange) line/)
    expect(hover.skipped).toEqual([])
    const click = out.results.find((r) => r.item.written === 6)!
    expect(click.seen).toHaveLength(3)
    expect(click.seen.join(' ')).toMatch(/Selected/)
    const plan = scriptPlan({ script: script(STEPS), outcome: out, map: { host: 'localhost', login: { detected: false } } as unknown as AppMap, startUrl: site.url, beganAt: site.url, hasVault: false, secrets: [] })
    const kinds = plan.playbook.steps.map((st) => st.kind)
    expect(kinds).toEqual(expect.arrayContaining(['scrollto', 'mark', 'click']))
    expect(plan.beats.length).toBe(9)
    const hoverBeat = plan.beats.find((b) => b.facts.some((f) => /tooltip that says/.test(f)))
    expect(hoverBeat).toBeTruthy()
    await page.close()
  }, 180000)

  it('does not press a button twice, and says so when a step changed nothing on screen', async () => {
    page = await open()
    site.events.length = 0
    const text = `1. go to \`${site.url}\`\n2. click the button: \`${PRESET}\`\n3. scroll down to Whole-Quran even–odd circle\n4. click \`< match\` and explain what it does`
    const sc = parseStepScript(text)!
    const out = await performScript({ page, gate: gate(), script: sc, log: () => undefined })
    // the first match is already the first: pressing "previous" changes nothing, and it is pressed once
    expect(site.events.filter((e) => e === 'prev')).toHaveLength(1)
    const last = out.results[out.results.length - 1]
    expect(last.unchanged).toBe(true)
    const plan = scriptPlan({ script: sc, outcome: out, map: { host: 'localhost', login: { detected: false } } as unknown as AppMap, startUrl: site.url, beganAt: site.url, hasVault: false, secrets: [] })
    expect(plan.notes.join(' ')).toMatch(/Step 4: the screen did not visibly change/)
    expect(plan.beats[plan.beats.length - 1].facts.join(' ')).toMatch(/did not visibly change/)
    await page.close()
  }, 120000)

  it('skips a step that cannot be done, says so, and tells the narration not to claim it', async () => {
    page = await open()
    site.events.length = 0
    const text = `1. go to \`${site.url}\`\n2. click the button: \`${PRESET}\`\n3. click the "Quantum teleporter" button and explain it\n4. scroll down to Whole-Quran even–odd circle\n5. click \`Verse\` tab`
    const sc = parseStepScript(text)!
    const out = await performScript({ page, gate: gate(), script: sc, log: () => undefined })
    expect(out.failure).toBeUndefined()
    expect(out.skipped).toHaveLength(1)
    expect(out.skipped[0]).toMatchObject({ n: 3 })
    expect(out.skipped[0].why).toMatch(/no control called that was found/)
    // the later steps were still done
    expect(site.events).toContain('tab:Verse')
    const plan = scriptPlan({ script: sc, outcome: out, map: { host: 'localhost', login: { detected: false } } as unknown as AppMap, startUrl: site.url, beganAt: site.url, hasVault: false, secrets: [] })
    expect(plan.notes.join(' ')).toMatch(/Step 3 was not fully done: clicking "Quantum teleporter" was skipped/)
    const beat = plan.beats.find((b) => b.facts.some((f) => /Quantum teleporter/.test(f) && /NOT SHOWN/.test(f)))!
    expect(beat.facts.some((f) => /^Clicks "Quantum teleporter"/.test(f))).toBe(false)
    expect(beat.fallback).not.toMatch(/Quantum/)
    await page.close()
  }, 120000)

  it('records the same steps and the film really leaves the top of the page: scroll, tooltip, line clicks and tabs happen on the recording page', async () => {
    const sc = script(STEPS)
    const scout = await open()
    const out = await performScript({ page: scout, gate: gate(), script: sc, log: () => undefined })
    await scout.close()
    const plan = scriptPlan({ script: sc, outcome: out, map: { host: 'localhost', login: { detected: false } } as unknown as AppMap, startUrl: site.url, beganAt: site.url, hasVault: false, secrets: [] })
    const rec = await open()
    site.events.length = 0
    const ys: number[] = []
    const watcher = setInterval(() => void rec.evaluate(() => scrollY).then((y) => ys.push(y)).catch(() => undefined), 80)
    const run = await runPlaybook(rec, plan.playbook as Playbook, { vault: {}, gate: gate(), redaction: { selectors: [], values: [] }, pace: 0.2, log: () => undefined })
    clearInterval(watcher)
    expect(run.ok).toBe(true)
    expect(run.skipped ?? []).toEqual([])
    expect(run.stuck ?? []).toEqual([])
    expect(site.events.filter((e) => e.startsWith('line:'))).toEqual(['line:blue', 'line:green', 'line:orange'])
    expect(site.events.filter((e) => e.startsWith('tab:'))).toContain('tab:Matches')
    // after the scroll to the circle the page stays down there: a "look at the result" never sends it back to the top
    expect(Math.max(...ys)).toBeGreaterThan(1000)
    expect(await rec.evaluate(() => scrollY)).toBeGreaterThan(1000)
    // every beat ended on a different screen than the one before it, except where a step legitimately leaves it as it was
    const urls = new Set(run.beats.map((b) => b.url))
    expect(urls.size).toBe(1)
    await rec.close()
  }, 240000)
})
