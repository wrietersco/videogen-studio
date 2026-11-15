import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { canShowWindow, CHROME_GUESS, findHeadlessShell, windowBounds } from '../src/main/appRecon/browser'
import { FILM } from '../src/shared/appRecon'

describe('the fallback browser', () => {
  it('cannot show a window, so signing in yourself needs Edge or Chrome', () => {
    expect(canShowWindow('C:/x/chrome-headless-shell.exe')).toBe(false)
    expect(canShowWindow('C:/Program Files/Google/Chrome/Application/chrome.exe')).toBe(true)
    expect(canShowWindow(null)).toBe(false)
  })

  const shell = findHeadlessShell()
  it.skipIf(!shell)('can record: it opens a page and takes a picture in classic headless mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-shell-'))
    const browser = await puppeteer.launch({ executablePath: shell!, headless: 'shell', userDataDir: dir })
    try {
      const page = await browser.newPage()
      await page.goto('data:text/html,<h1>hello</h1>')
      const shot = await page.screenshot({ type: 'jpeg' })
      expect(shot.length).toBeGreaterThan(500)
    } finally {
      await browser.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  }, 60000)
})

describe('the visible window', () => {
  const film = { w: FILM.width, h: FILM.height }

  it('is centred and fits on the screen when the screen is big enough', () => {
    const b = windowBounds(film.w, film.h, { w: 20, h: 120 }, { x: 0, y: 0, width: 2560, height: 1400 })
    expect(b.width).toBe(film.w + 20)
    expect(b.height).toBe(film.h + 120)
    expect(b.x).toBe((2560 - b.width) / 2)
    expect(b.y).toBe((1400 - b.height) / 2)
  })

  it('never grows past the screen; a small monitor just fills the screen', () => {
    const b = windowBounds(film.w, film.h, CHROME_GUESS, { x: 0, y: 0, width: 1366, height: 768 })
    expect(b.width).toBe(1366)
    expect(b.height).toBe(768)
  })

  it('the first guess is generous: an oversized window shows the page at its true size', () => {
    const b = windowBounds(film.w, film.h, CHROME_GUESS)
    expect(b.width).toBeGreaterThan(film.w)
    expect(b.height).toBeGreaterThan(film.h)
  })

  it('stays inside a screen whose origin is not the top-left corner', () => {
    const work = { x: 100, y: 80, width: 2560, height: 1400 }
    const b = windowBounds(film.w, film.h, { w: 20, h: 120 }, work)
    expect(b.x).toBeGreaterThanOrEqual(work.x)
    expect(b.y).toBeGreaterThanOrEqual(work.y)
    expect(b.x + b.width).toBeLessThanOrEqual(work.x + work.width)
    expect(b.y + b.height).toBeLessThanOrEqual(work.y + work.height)
  })
})
