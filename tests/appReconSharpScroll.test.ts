import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer, { type Browser } from 'puppeteer-core'
import sharp from 'sharp'
import { findChrome } from '../src/main/appRecon/browser'
import { FrameRecorder } from '../src/main/appRecon/recorder'

/**
 * The phone recording takes full-density pictures with a clip. A clip is in page coordinates, so once the page had been scrolled
 * (the steps now go to the chart, the tabs…) every picture was blank white. The pictures must follow the scrolled view.
 */
const chrome = findChrome()
const PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0">
<div style="height:700px;background:#ff0000">TOP</div><div style="height:2400px;background:#0000ff">LOWER PART</div></body>`

describe.skipIf(!chrome)('a phone recording of a page that has been scrolled', () => {
  let browser: Browser
  const dir = mkdtempSync(join(tmpdir(), 'vg-sharp-'))
  beforeAll(async () => {
    browser = await puppeteer.launch({ executablePath: chrome!, headless: true })
  })
  afterAll(async () => {
    await browser?.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('films the part of the page in view, not the blank top-left of the document', async () => {
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 688, deviceScaleFactor: 1, isMobile: true, hasTouch: true })
    await page.setContent(PAGE)
    const rec = new FrameRecorder(page, join(dir, 'frames'))
    await rec.start(780, 1376, { sharp: true })
    await new Promise((r) => setTimeout(r, 500))
    await page.evaluate(() => scrollTo(0, 1200)) // the viewport now shows only the blue part
    await new Promise((r) => setTimeout(r, 1200))
    await rec.stop()
    const files = readdirSync(join(dir, 'frames')).filter((f) => f.endsWith('.jpg')).sort()
    expect(files.length).toBeGreaterThan(3)
    const last = await sharp(join(dir, 'frames', files.at(-1)!)).stats()
    const [r, , b] = last.channels.map((c) => c.mean)
    expect(b).toBeGreaterThan(200) // blue, not white (white would have all three channels near 255)
    expect(r).toBeLessThan(80)
    await page.close()
  }, 60000)
})
