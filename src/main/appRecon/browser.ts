import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import electronModule from 'electron'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { FILM, REC_SCALE } from '@shared/appRecon'
import type { PolicyGate } from './policy'

/** BrowserWindow/screen only exist inside the Electron runtime; CLI/test runs get an empty stub. */
const electron = electronModule as unknown as Partial<typeof import('electron')>

/**
 * Our own Chromium, driven over the DevTools protocol. It never touches the
 * user's everyday browser profile: every run gets a fresh, empty one, so
 * saved logins, cookies and extensions can neither leak in nor out.
 */

export function findChrome(): string | null {
  const env = process.env.VG_CHROME
  if (env && existsSync(env)) return env
  const fixed = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ]
  for (const f of fixed) if (existsSync(f)) return f
  const cache = join(homedir(), '.cache', 'puppeteer', 'chrome')
  try {
    for (const v of readdirSync(cache).sort().reverse()) {
      const exe = join(cache, v, 'chrome-win64', 'chrome.exe')
      if (existsSync(exe)) return exe
    }
  } catch {
    /* no puppeteer cache */
  }
  return findHeadlessShell()
}

/**
 * The app already downloads a headless Chrome for rendering videos. It can
 * record (headless) when no Edge or Chrome is installed, but it cannot show a
 * window, so "I'll sign in myself" is not possible with it.
 */
export function findHeadlessShell(): string | null {
  const base = join(homedir(), '.cache', 'hyperframes', 'chrome', 'chrome-headless-shell')
  const exeName = process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell'
  try {
    for (const v of readdirSync(base).sort().reverse()) {
      for (const inner of readdirSync(join(base, v))) {
        const exe = join(base, v, inner, exeName)
        if (existsSync(exe)) return exe
      }
    }
  } catch {
    /* not downloaded yet */
  }
  return null
}

/** true when the browser can open a visible window (a person can sign in, or type a code) */
export function canShowWindow(path: string | null = findChrome()): boolean {
  return !!path && !/headless-shell/i.test(path)
}

export interface LaunchOptions {
  width?: number
  height?: number
  /** pixel density of the pictures taken (2 = crisp when zoomed in) */
  scale?: number
  userDataDir: string
  /** false opens a normal window (a person has to sign in, or type a code) */
  headless?: boolean
}

export async function launch(opts: LaunchOptions): Promise<Browser> {
  const executablePath = findChrome()
  if (!executablePath) throw new Error('No Edge or Chrome was found on this computer, and the app has not downloaded its own browser yet. Install Edge or Chrome and try again.')
  const wantsWindow = opts.headless === false
  if (wantsWindow && !canShowWindow(executablePath)) throw new Error("“I’ll sign in myself” needs Edge or Chrome installed, because it opens a window for you. Install one, or save a login instead.")
  const width = opts.width ?? FILM.width
  const height = opts.height ?? FILM.height
  const args = ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--no-first-run', '--disable-extensions', '--lang=en-US', '--disable-features=Translate,MediaRouter']
  if (wantsWindow) args.push(...windowArgs(width, height))
  const browser = await puppeteer.launch({
    executablePath,
    // the downloaded headless-only browser uses the classic headless mode
    headless: wantsWindow ? false : /headless-shell/i.test(executablePath) ? 'shell' : true,
    userDataDir: opts.userDataDir,
    defaultViewport: { width, height, deviceScaleFactor: opts.scale ?? REC_SCALE },
    args
  })
  if (wantsWindow) await fitWindow(browser, width, height)
  return browser
}

/** how much bigger than the page a browser window is (title bar, toolbars, borders) */
export interface ChromeDelta { w: number; h: number }

/**
 * First guess at that difference, deliberately generous: an oversized window
 * shows the page at its true size with small blank margins, while a small
 * window squeezes the whole film frame to fit. A second pass corrects it.
 */
export const CHROME_GUESS: ChromeDelta = { w: 48, h: 160 }

/**
 * The window size and position that shows a page of the given size at 1:1,
 * once the real chrome is measured. Stays inside the screen's work area when
 * one is known, so a small monitor simply fills the screen — the recorded
 * film never depends on the window, only on the page itself.
 */
export function windowBounds(pageW: number, pageH: number, chrome: ChromeDelta, work?: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  const width = Math.min(pageW + chrome.w, work?.width ?? pageW + chrome.w)
  const height = Math.min(pageH + chrome.h, work?.height ?? pageH + chrome.h)
  const x = (work?.x ?? 0) + Math.max(0, Math.round(((work?.width ?? width) - width) / 2))
  const y = (work?.y ?? 0) + Math.max(0, Math.round(((work?.height ?? height) - height) / 2))
  return { x, y, width, height }
}

/** the screen area windows should stay inside, when running inside the desktop app */
function workArea(): { x: number; y: number; width: number; height: number } | undefined {
  try {
    const screen = electron.screen
    if (typeof screen?.getPrimaryDisplay !== 'function') return undefined
    return screen.getPrimaryDisplay().workArea
  } catch {
    return undefined
  }
}

/** first-pass launch args: a generous, centred window so the page starts at its true size */
function windowArgs(width: number, height: number): string[] {
  const b = windowBounds(width, height, CHROME_GUESS, workArea())
  return [`--window-position=${b.x},${b.y}`, `--window-size=${b.width},${b.height}`]
}

/**
 * Second pass: with the page already shown 1:1, the real borders can be
 * measured from the window itself and the frame fitted exactly.
 * Cosmetic only — the recording captures the page, never the window.
 */
async function fitWindow(browser: Browser, width: number, height: number): Promise<void> {
  try {
    const page = (await browser.pages())[0]
    if (!page) return
    const chrome = await page.evaluate(() => ({ w: Math.max(0, window.outerWidth - window.innerWidth), h: Math.max(0, window.outerHeight - window.innerHeight) }))
    const b = windowBounds(width, height, chrome, workArea())
    const client = await page.createCDPSession()
    const { windowId } = await client.send('Browser.getWindowForTarget')
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal', left: b.x, top: b.y, width: b.width, height: b.height } })
    await client.detach()
  } catch {
    /* sizing is best effort */
  }
}

/** every request the page makes goes through the policy gate first */
export async function enforcePolicy(page: Page, gate: PolicyGate): Promise<void> {
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return
    const v = gate.checkRequest({ method: req.method(), url: req.url(), resourceType: req.resourceType(), postData: req.postData() })
    if (v.allow) void req.continue()
    else void req.abort('blockedbyclient')
  })
}
