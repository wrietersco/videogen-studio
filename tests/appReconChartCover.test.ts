import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import puppeteer, { type Browser } from 'puppeteer-core'
import { findChrome } from '../src/main/appRecon/browser'
import { pickChart } from '../src/main/appRecon/marks'

/**
 * A first-visit help card ("How to read this circle … Got it") lies over the chart on a phone. Every hover and click of the
 * steps then lands on the card and the film shows the card, not the chart. The card is closed with its own button first.
 */
const chrome = findChrome()
const COVERED = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;font:14px sans-serif">
<h3>Whole-Quran even–odd circle</h3>
<div id="stage" style="position:relative;width:338px;height:420px;margin:0 26px">
  <canvas id="c" width="338" height="420" style="display:block;background:#eef"></canvas>
  <div id="guide" style="position:absolute;left:14px;top:14px;width:300px;height:380px;background:#fff;border:1px solid #888;z-index:7">
    <h4>How to read this circle</h4><p>Each ring is one verse.</p>
    <button id="demo">Show me a match</button><button id="gotit" onclick="document.getElementById('guide').style.display='none'">Got it</button>
  </div>
</div>
<p>after</p></body>`
const UNCOVERED = COVERED.replace(/<div id="guide"[\s\S]*?<\/div>\s*<\/div>/, '</div>')

describe.skipIf(!chrome)('a help card over a chart', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: chrome!, headless: true })
  })
  afterAll(async () => {
    await browser?.close()
  })
  const open = async (html: string) => {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 688, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.setContent(html)
    return page
  }

  it('closes the card with its own "Got it" so the chart itself is in view, and does not press its demo button', async () => {
    const page = await open(COVERED)
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('guide')!).display)).toBe('block')
    const chart = await pickChart(page, 'chart')
    expect(chart).not.toBeNull()
    expect(chart!.kind).toBe('canvas')
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('guide')!).display)).toBe('none')
    await page.close()
  }, 30000)

  it('leaves a chart that nothing covers alone', async () => {
    const page = await open(UNCOVERED)
    expect(await page.$('#guide')).toBeNull()
    const chart = await pickChart(page, 'chart')
    expect(chart?.kind).toBe('canvas')
    await page.close()
  }, 30000)
})
