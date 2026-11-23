import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Browser } from 'puppeteer-core'
import { findChrome, launch } from '../src/main/appRecon/browser'
import { possibilitiesOf, scoutPage } from '../src/main/appRecon/scout'

/**
 * The scout is meant to understand a whole page, not just its first screen:
 * a short page is pictured to the bottom, a long one is read deeper instead.
 * The two fixture pages are served by a local HTTP server (no internet), and
 * the browser tests need a real Chrome or Edge (skipped when none is installed).
 */

const SHORT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Quarterly review</title></head><body style="margin:0;font:16px system-ui">
<nav><a href="#overview">Overview</a><a href="#guide">Rollout guide</a></nav>
<h1>Quarterly review</h1>
<label>Api password <input type="password" name="pw"></label>
<section id="overview" style="height:520px"><h2>Overview</h2><p>How the quarter went, in numbers.</p></section>
<div id="guide" style="height:620px"><h2>Rollout guide</h2><ol><li><strong>1. Upload data</strong></li><li><strong>2. Pick a look</strong></li></ol></div>
<div class="card" style="height:280px"><h3>Risk score</h3><svg width="240" height="60"><text x="10" y="26">Latency</text><text x="10" y="52">Uptime</text></svg></div>
<div role="alert">Report saved successfully</div>
<div style="height:900px"></div>
</body></html>`

const part = (i: number) =>
  `<section id="part-${i}" style="height:1050px"><h2>Part ${i} — findings</h2><p>Section ${i} carries the measurements collected during this pass of the review, together with the caveats the team noted while reading them and the follow-up work each one implies for the next quarter.</p></section>`

const TALL_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Long report</title></head><body style="margin:0;font:16px system-ui">
<nav><a href="#part-1">Part 1</a><a href="#part-2">Part 2</a><a href="#part-3">Part 3</a></nav>
<h1>Long report</h1>
<div role="status">Loaded every measurement</div>
${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(part).join('\n')}
<div style="height:400px"><svg width="300" height="60"><text x="10" y="26">Throughput</text><text x="10" y="52">Errors</text></svg></div>
</body></html>`

describe('possibilitiesOf', () => {
  it('names the tabs, sections, stages and cards a person could mean', () => {
    const lines = possibilitiesOf({
      headings: [],
      notices: [],
      sections: [
        { label: 'Overview', selector: '#t', kind: 'tab' },
        { label: 'Markov chain analysis', selector: '#s', kind: 'section' },
        { label: '1. Upload data', selector: '#st', kind: 'stage' },
        { label: 'Risk score', selector: '#c', kind: 'card' }
      ]
    })
    expect(lines).toEqual(['Tab: "Overview"', 'Section: "Markov chain analysis"', 'Stage: "1. Upload data"', 'Card: "Risk score"'])
  })

  it('adds headings, one line for the chart labels, and the page messages', () => {
    const lines = possibilitiesOf({
      headings: ['Deploy guide'],
      notices: ['Saved successfully'],
      text: 'A page of words | Labels drawn on the page: Latency, Uptime, Cost',
      sections: []
    })
    expect(lines).toContain('Heading: "Deploy guide"')
    expect(lines).toContain('Charts label: Latency, Uptime, Cost')
    expect(lines).toContain('Message: "Saved successfully"')
  })

  it('dedupes case-insensitively and drops empty, over-long and missing things', () => {
    const lines = possibilitiesOf({
      headings: ['Overview', 'overview', '', 'x'.repeat(95)],
      notices: ['   ', 'Saved'],
      sections: [{ label: 'Overview', selector: '#a', kind: 'section' }]
    })
    expect(lines).toEqual(['Section: "Overview"', 'Heading: "Overview"', 'Message: "Saved"'])
  })

  it('never carries more than 12 lines', () => {
    const lines = possibilitiesOf({
      headings: Array.from({ length: 30 }, (_, i) => `Heading number ${i + 1}`),
      notices: [],
      sections: []
    })
    expect(lines.length).toBe(12)
  })
})

describe.skipIf(!findChrome())('the scout reads a whole page, in a real browser', () => {
  let site: Server
  let url: string
  let browser: Browser
  let profile: string

  beforeAll(async () => {
    site = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end((req.url ?? '').startsWith('/tall') ? TALL_PAGE : SHORT_PAGE)
    })
    await new Promise<void>((r) => site.listen(0, 'localhost', r))
    url = `http://localhost:${(site.address() as AddressInfo).port}`
    profile = mkdtempSync(join(tmpdir(), 'vg-scroll-'))
    browser = await launch({ userDataDir: profile, scale: 1 })
  }, 180000)
  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((r) => site.close(() => r()))
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  it('a short page is pictured to the bottom, one stop per screen', async () => {
    const p = await browser.newPage()
    await p.goto(`${url}/short`, { waitUntil: 'load' })
    const outDir = mkdtempSync(join(tmpdir(), 'vg-shots-'))
    const page = await scoutPage(p, outDir, 'p1')
    expect(page.screenshot).toBe('p1.jpg')
    expect(page.shots?.[0]).toBe(page.screenshot)
    expect(page.shots?.length).toBeGreaterThanOrEqual(2)
    expect(page.scrolls ?? 0).toBeLessThanOrEqual(5)
    expect(page.shots?.length).toBe((page.scrolls ?? 0) + 1)
    for (const f of page.shots ?? []) expect(existsSync(join(outDir, f)), f).toBe(true)
    expect(page.possibilities?.length).toBeGreaterThan(0)
    // the blur style only comes off once every picture has been taken
    expect(await p.evaluate(() => document.querySelectorAll('style').length)).toBe(0)
    await p.close()
    rmSync(outDir, { recursive: true, force: true })
  }, 120000)

  it('a long page keeps one picture and is read deeper instead', async () => {
    const p = await browser.newPage()
    await p.goto(`${url}/tall`, { waitUntil: 'load' })
    const outDir = mkdtempSync(join(tmpdir(), 'vg-shots-'))
    const page = await scoutPage(p, outDir, 'p2')
    expect(page.scrolls ?? 0).toBeGreaterThan(5)
    expect(page.shots?.length).toBe(1)
    expect(page.shots?.[0]).toBe(page.screenshot)
    // deeper than the first screen's caps: 13 headings (cap 8 shallow) and more text (cap 1400 shallow)
    expect(page.headings.length).toBeGreaterThan(8)
    expect((page.text ?? '').length).toBeGreaterThan(1400)
    // the page's named landmarks came along, with the stable way back to them
    expect(page.sections?.some((s) => s.selector === '#part-3')).toBe(true)
    expect(page.possibilities?.some((l) => l.startsWith('Section: "Part 3'))).toBe(true)
    expect(await p.evaluate(() => document.querySelectorAll('style').length)).toBe(0)
    await p.close()
    rmSync(outDir, { recursive: true, force: true })
  }, 120000)
})
