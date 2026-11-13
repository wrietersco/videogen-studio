import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'
import { canShowWindow, findHeadlessShell } from '../src/main/appRecon/browser'

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
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60000)
})
