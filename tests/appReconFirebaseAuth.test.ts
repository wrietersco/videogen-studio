import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { enforcePolicy, findChrome, launch } from '../src/main/appRecon/browser'
import { followPopups } from '../src/main/appRecon/popups'
import { backingServiceOf, interpretGuardrails, PolicyGate } from '../src/main/appRecon/policy'
import { signInWindowArgs } from '../src/main/appRecon/signInWindow'

/**
 * Firebase (and every other single sign-in) needs its own hosts: with "stay on this app's sites" on, the
 * recorder used to abort the call to identitytoolkit.googleapis.com, and Firebase reported
 * "auth/network-request-failed". These tests use no internet: real host names are mapped to a local
 * stub server with the browser's host-resolver switch, so the policy sees the real names.
 */

const gateFor = (url: string, checks: Parameters<typeof interpretGuardrails>[2] = {}) => new PolicyGate(interpretGuardrails('', url, checks).guardrails)
const post = (url: string, resourceType = 'fetch') => ({ method: 'POST', url, resourceType })

describe('which hosts count as the sign-in an app is built on', () => {
  it('knows the Firebase and Google sign-in hosts', () => {
    for (const u of [
      'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k',
      'https://securetoken.googleapis.com/v1/token?key=k',
      'https://my-project.firebaseapp.com/__/auth/handler?apiKey=k',
      'https://accounts.google.com/o/oauth2/auth?client_id=1',
      'https://apis.google.com/js/api.js',
      'https://www.googleapis.com/identitytoolkit/v3/relyingparty/getProjectConfig',
      'https://www.google.com/recaptcha/api.js',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
    ]) expect(backingServiceOf(u), u).toBe('sign-in')
    expect(backingServiceOf('https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel')).toBe('firebase-data')
  })

  it('does not trust look-alikes or the rest of googleapis.com', () => {
    for (const u of ['https://googleapis.com.evil.test/x', 'https://identitytoolkit.googleapis.com.evil.test/x', 'https://evilfirebaseapp.com/x', 'https://www.googleapis.com/drive/v3/files', 'https://www.google.com/search?q=x', 'https://tracker.example.com/collect', 'ftp://accounts.google.com/x', 'not a url'])
      expect(backingServiceOf(u), u).toBeUndefined()
  })
})

describe('the request gate and sign-in hosts', () => {
  it('lets the Firebase email and password call through (it used to be aborted, which Firebase reports as a network failure)', () => {
    const g = gateFor('https://app.example.com/login')
    expect(g.checkRequest(post('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k')).allow).toBe(true)
    expect(g.checkRequest({ method: 'OPTIONS', url: 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k', resourceType: 'other' }).allow).toBe(true)
    expect(g.checkRequest(post('https://securetoken.googleapis.com/v1/token?key=k')).allow).toBe(true)
    expect(g.checkRequest({ method: 'GET', url: 'https://accounts.google.com/o/oauth2/auth', resourceType: 'document' }).allow).toBe(true)
    expect(g.blockedHosts()).toEqual([])
  })

  it('still keeps the app on its own sites for everything else', () => {
    const g = gateFor('https://app.example.com/login')
    expect(g.checkRequest(post('https://tracker.example.net/collect')).allow).toBe(false)
    expect(g.checkRequest({ method: 'GET', url: 'https://www.googleapis.com/drive/v3/files', resourceType: 'fetch' }).allow).toBe(false)
    expect(g.blockedHosts().map((h) => h.host).sort()).toEqual(['tracker.example.net', 'www.googleapis.com'])
  })

  it('read-only still signs in and keeps the session alive, but never creates or changes an account', () => {
    const g = gateFor('https://app.example.com/login', { readOnly: true })
    expect(g.checkRequest(post('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=k')).allow).toBe(true)
    expect(g.checkRequest(post('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=k')).allow).toBe(true)
    expect(g.checkRequest(post('https://securetoken.googleapis.com/v1/token?key=k')).allow).toBe(true)
    expect(g.checkRequest(post('https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=k')).allow).toBe(false)
    expect(g.checkRequest(post('https://identitytoolkit.googleapis.com/v1/accounts:update?key=k')).allow).toBe(false)
    expect(g.checkRequest(post('https://identitytoolkit.googleapis.com/v1/accounts:delete?key=k')).allow).toBe(false)
    expect(g.checkRequest(post('https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents:runQuery')).allow).toBe(true)
    expect(g.checkRequest(post('https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents:commit')).allow).toBe(false)
  })

  it('with "stay on this app\'s sites" ticked off nothing is gated by host, as before', () => {
    const g = gateFor('https://app.example.com/login', { stayOnSites: false })
    expect(g.checkRequest(post('https://tracker.example.net/collect')).allow).toBe(true)
  })
})

describe('the sign-in window ("Sign in once")', () => {
  it('is a plain browser: its own profile, and no automation or debugging switches', () => {
    const args = signInWindowArgs('C:/p/profile', 'https://app.example.com/login')
    expect(args).toContain('--user-data-dir=C:/p/profile')
    expect(args.at(-1)).toBe('https://app.example.com/login')
    expect(args.join(' ')).not.toMatch(/remote-debugging|enable-automation|headless|disable-blink|user-agent/i)
  })
})

// ---------------------------------------------------------------- the real browser, against local stand-ins

const chrome = findChrome()
let appServer: Server
let stub: Server
let appPort = 0
let stubPort = 0
let browser: Browser
let dir = ''

const cors = (res: ServerResponse, origin: string) => {
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
}
const html = (res: ServerResponse, body: string) => {
  res.setHeader('content-type', 'text/html')
  res.end(`<!doctype html><meta charset=utf-8><body>${body}`)
}

/** the app: an email sign-in (cross-origin fetch), a pop-up sign-in, a redirect sign-in and a tracker call */
function appPage(): string {
  return `
<button id=email>Sign in</button> <button id=google>Continue with Google</button> <button id=redirect>Redirect sign in</button> <button id=tracker>Track</button>
<p id=out>idle</p>
<script>
const out = (t) => { document.getElementById('out').textContent = t }
const idt = 'http://identitytoolkit.googleapis.com:${stubPort}/v1/accounts:signInWithPassword?key=k'
document.getElementById('email').onclick = async () => {
  try {
    const r = await fetch(idt, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody-qa@example.invalid', password: 'x', returnSecureToken: true }) })
    const j = await r.json()
    out('server said ' + j.error.message)
  } catch (e) { out('network-request-failed') }
}
document.getElementById('google').onclick = () => { window.open('http://qa-demo.firebaseapp.com:${stubPort}/__/auth/handler', 'auth', 'width=480,height=600') }
window.addEventListener('message', (e) => { if (e.data && e.data.auth) out('popup said ' + JSON.stringify(e.data)) })
document.getElementById('redirect').onclick = () => { location.href = 'http://qa-demo.firebaseapp.com:${stubPort}/__/auth/start?back=' + encodeURIComponent(location.origin + '/done') }
document.getElementById('tracker').onclick = async () => { try { await fetch('http://tracker.example.test:${stubPort}/collect', { method: 'POST', body: 'x' }); out('tracker reached') } catch (e) { out('tracker blocked') } }
</script>`
}

beforeAll(async () => {
  if (!chrome) return
  appServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith('/done')) return html(res, '<p id=out>back from the provider</p>')
    html(res, appPage())
  })
  await new Promise<void>((r) => appServer.listen(0, '127.0.0.1', r))
  appPort = (appServer.address() as AddressInfo).port
  stub = createServer((req, res) => {
    const origin = `http://127.0.0.1:${appPort}`
    // like the real service: the caller's own origin is allowed (the app's page, or the handler page on its firebaseapp.com name)
    cors(res, req.headers.origin ?? origin)
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    const path = (req.url ?? '').split('?')[0]
    if (path === '/v1/accounts:signInWithPassword') {
      res.setHeader('content-type', 'application/json')
      res.statusCode = 400
      return res.end(JSON.stringify({ error: { message: 'INVALID_LOGIN_CREDENTIALS' } }))
    }
    if (path === '/collect') return res.end('ok')
    if (path === '/__/auth/start') {
      const back = new URL(req.url!, 'http://x').searchParams.get('back')!
      res.statusCode = 302
      res.setHeader('location', back)
      return res.end()
    }
    if (path === '/__/auth/handler') {
      // the provider's page: calls the sign-in service, tries a tracker, tells the page that opened it, and closes
      return html(
        res,
        `<script>
setTimeout(async () => {
  let idt = 'failed'; let tracker = 'reached'
  try { const r = await fetch('http://identitytoolkit.googleapis.com:${stubPort}/v1/accounts:signInWithPassword?key=k', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); idt = (await r.json()).error.message } catch (e) {}
  try { await fetch('http://tracker.example.test:${stubPort}/collect', { method: 'POST', body: 'x' }) } catch (e) { tracker = 'blocked' }
  window.opener.postMessage({ auth: 'handler', idt, tracker }, '${origin}')
  setTimeout(() => window.close(), 150)
}, 500)
</script>handler`
      )
    }
    res.statusCode = 404
    res.end('no')
  })
  await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r))
  stubPort = (stub.address() as AddressInfo).port
  dir = mkdtempSync(join(tmpdir(), 'vg-fb-'))
  // the real launch (same switches as a recording) plus the host mapping that sends the real sign-in names to the stub
  browser = await launch({
    userDataDir: dir,
    headless: true,
    extraArgs: ['--host-resolver-rules=MAP *.googleapis.com 127.0.0.1, MAP *.firebaseapp.com 127.0.0.1, MAP tracker.example.test 127.0.0.1']
  })
}, 90000)

afterAll(async () => {
  await browser?.close().catch(() => undefined)
  appServer?.close()
  stub?.close()
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

async function openApp(gate: PolicyGate) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await enforcePolicy(page, gate)
  const popups = followPopups(page, gate)
  await page.goto(`http://127.0.0.1:${appPort}/`)
  return { page, popups, ctx }
}
const said = (page: Page) => page.$eval('#out', (e) => e.textContent ?? '')

describe.skipIf(!chrome)("the recorder's browser, with its real launch settings and request gate", () => {
  it('email and password: the cross-origin call to identitytoolkit reaches the sign-in service', async () => {
    const gate = gateFor(`http://127.0.0.1:${appPort}/`)
    const { page, ctx } = await openApp(gate)
    await page.click('#email')
    await page.waitForFunction(() => document.getElementById('out')!.textContent !== 'idle', { timeout: 10000 })
    expect(await said(page)).toBe('server said INVALID_LOGIN_CREDENTIALS')
    expect(gate.blockedHosts()).toEqual([])
    await ctx.close()
  }, 60000)

  it('a tracker is still kept out', async () => {
    const gate = gateFor(`http://127.0.0.1:${appPort}/`)
    const { page, ctx } = await openApp(gate)
    await page.click('#tracker')
    await page.waitForFunction(() => document.getElementById('out')!.textContent !== 'idle', { timeout: 10000 })
    expect(await said(page)).toBe('tracker blocked')
    expect(gate.blockedHosts().map((h) => h.host)).toContain('tracker.example.test')
    await ctx.close()
  }, 60000)

  it("Google pop-up: the handler window opens, is followed under the same rules, answers the page and closes; the recording goes on on the app's page", async () => {
    const gate = gateFor(`http://127.0.0.1:${appPort}/`)
    const { page, popups, ctx } = await openApp(gate)
    await page.click('#google')
    await popups.settled(15000)
    expect(popups.seen().some((u) => u.includes('/__/auth/handler'))).toBe(true)
    expect(popups.open()).toHaveLength(0)
    await page.waitForFunction(() => document.getElementById('out')!.textContent!.startsWith('popup said'), { timeout: 10000 })
    const msg = JSON.parse((await said(page)).replace('popup said ', ''))
    expect(msg.idt).toBe('INVALID_LOGIN_CREDENTIALS')
    // the pop-up is held to the same rules as the page: its call to a tracker was refused
    expect(msg.tracker).toBe('blocked')
    expect(page.isClosed()).toBe(false)
    await ctx.close()
  }, 60000)

  it('Google redirect: the page may go to the provider and come back', async () => {
    const gate = gateFor(`http://127.0.0.1:${appPort}/`)
    const { page, ctx } = await openApp(gate)
    await Promise.all([page.waitForFunction(() => location.pathname === '/done', { timeout: 15000 }), page.click('#redirect')])
    expect(await said(page)).toBe('back from the provider')
    await ctx.close()
  }, 60000)
})

describe.skipIf(!chrome)('"Sign in once": the recording opens the same profile and is already signed in', () => {
  it('keeps what Firebase stores (IndexedDB and local storage) from one launch to the next, in the default browser context', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'vg-fb-profile-'))
    const url = `http://127.0.0.1:${appPort}/done`
    try {
      // the person signs in by hand (stood in for here by writing what Firebase writes)
      const first = await launch({ userDataDir: profile, headless: true })
      const p1 = await first.defaultBrowserContext().newPage()
      await p1.goto(url)
      await p1.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            localStorage.setItem('firebase:authUser:key:[DEFAULT]', '{"uid":"u1"}')
            const req = indexedDB.open('firebaseLocalStorageDb', 1)
            req.onupgradeneeded = () => req.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
            req.onerror = () => reject(req.error)
            req.onsuccess = () => {
              const tx = req.result.transaction('firebaseLocalStorage', 'readwrite')
              tx.objectStore('firebaseLocalStorage').put({ fbase_key: 'firebase:authUser:key:[DEFAULT]', value: { uid: 'u1' } })
              tx.oncomplete = () => resolve()
              tx.onerror = () => reject(tx.error)
            }
          })
      )
      await first.close()
      // the recording: same profile, default context (a throwaway context would start empty)
      const second = await launch({ userDataDir: profile, headless: true })
      const p2 = await second.defaultBrowserContext().newPage()
      await p2.goto(url)
      const seen = await p2.evaluate(
        () =>
          new Promise<{ local: string | null; idb: unknown }>((resolve) => {
            const req = indexedDB.open('firebaseLocalStorageDb', 1)
            req.onsuccess = () => {
              const get = req.result.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').get('firebase:authUser:key:[DEFAULT]')
              get.onsuccess = () => resolve({ local: localStorage.getItem('firebase:authUser:key:[DEFAULT]'), idb: get.result?.value })
            }
          })
      )
      expect(seen.local).toBe('{"uid":"u1"}')
      expect(seen.idb).toEqual({ uid: 'u1' })
      const throwaway = await second.createBrowserContext()
      const p3 = await throwaway.newPage()
      await p3.goto(url)
      expect(await p3.evaluate(() => localStorage.getItem('firebase:authUser:key:[DEFAULT]'))).toBeNull()
      await second.close()
    } finally {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  }, 90000)
})
