import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import type { PolicyGate } from './policy'

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
  return null
}

export interface LaunchOptions {
  width?: number
  height?: number
  /** pixel density of the pictures taken (2 = crisp when zoomed in) */
  scale?: number
  userDataDir: string
}

export async function launch(opts: LaunchOptions): Promise<Browser> {
  const executablePath = findChrome()
  if (!executablePath) throw new Error('No Chrome or Edge was found on this computer')
  return puppeteer.launch({
    executablePath,
    headless: true,
    userDataDir: opts.userDataDir,
    defaultViewport: { width: opts.width ?? 1280, height: opts.height ?? 720, deviceScaleFactor: opts.scale ?? 2 },
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none', '--no-first-run', '--disable-extensions', '--lang=en-US', '--disable-features=Translate,MediaRouter']
  })
}

/** every request the page makes goes through the policy gate first */
export async function enforcePolicy(page: Page, gate: PolicyGate): Promise<void> {
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return
    const v = gate.checkRequest({ method: req.method(), url: req.url(), resourceType: req.resourceType() })
    if (v.allow) void req.continue()
    else void req.abort('blockedbyclient')
  })
}
