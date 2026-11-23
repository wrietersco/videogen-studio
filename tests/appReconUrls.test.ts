import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/main/appRecon/browser'
import { readUrls } from '../src/main/appRecon/directives'
import { interpretGuardrails } from '../src/main/appRecon/policy'
import { parseStepScript } from '../src/main/appRecon/stepScript'
import { runAppRecording, type RunHooks, type RunInput } from '../src/main/appRecon/run'
import { DEMO_PASS, DEMO_USER, startAppSite, type AppSite } from './fixtures/appSite'

describe('the addresses a person gives or pastes (no browser needed)', () => {
  it('accepts every address the person gave: the gate allows each host once', () => {
    const r = interpretGuardrails('', ['https://App.Example.com/start', 'https://app.example.com/start/', 'http://other.example.com/'], {})
    expect(r.guardrails.allowedHosts).toEqual(['app.example.com', 'other.example.com'])
    expect(r.enforced.join(' ')).toContain('Only pages on app.example.com and other.example.com (and sign-in or API hosts they need) are opened.')
  })

  it('still speaks of one address the old way, so nothing already read changes', () => {
    const r = interpretGuardrails('', 'https://a.example.com/x', {})
    expect(r.guardrails.allowedHosts).toEqual(['a.example.com'])
    expect(r.enforced.join(' ')).toContain('Only pages on a.example.com (and sign-in or API hosts it needs) are opened.')
  })

  it('reads the addresses pasted in the brief: in sentences, on their own line, punctuation trimmed, repeats collapsed', () => {
    const text = 'First show https://a.example.com/one.\nhttps://b.example.com/two.\nAnd also https://a.example.com/one again, then explain it.'
    expect(readUrls(text)).toEqual(['https://a.example.com/one', 'https://b.example.com/two'])
    expect(readUrls('no address here at all')).toEqual([])
  })

  it('a step that says "open <address>" is read as opening that page (performed as a goto step)', () => {
    const script = parseStepScript('1. open https://app.example.com/reports\n2. type "psychology" in the search bar')
    expect(script?.items[0].atoms).toContainEqual({ action: 'open', label: 'Open page', url: 'https://app.example.com/reports' })
  })
})

describe.skipIf(!findChrome())('several addresses, against the test web app', () => {
  let site: AppSite
  let root: string
  beforeAll(async () => {
    site = await startAppSite()
    root = mkdtempSync(join(tmpdir(), 'vg-urls-'))
  }, 120000)
  afterAll(async () => {
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  const hooks = (): RunHooks => ({
    progress: () => undefined,
    handoff: async () => {
      throw new Error('no hand-off expected')
    }
  })

  const base = (name: string, over: Partial<RunInput> = {}): RunInput => ({
    runDir: join(root, name),
    startUrl: `${site.url}/login`,
    context: 'Show the main areas of the app',
    mode: 'walkthrough',
    signIn: 'saved',
    vault: { username: DEMO_USER, password: DEMO_PASS },
    guardrailText: '',
    checks: {},
    depth: 'quick',
    chat: null,
    speech: null,
    stopAfter: 'explore',
    ...over
  })

  it('every address given in "Your app" is scouted, and the gate names them all', async () => {
    const out = await runAppRecording(base('two', { startUrls: [`${site.otherUrl}/frame`] }), hooks())
    const urls = out.map.pages.map((p) => p.url)
    expect(urls.some((u) => u === `${site.url}/login`)).toBe(true)
    expect(urls.some((u) => u.startsWith(site.otherUrl))).toBe(true)
    expect(out.enforced.join(' ')).toContain('localhost and 127.0.0.1')
  }, 180000)

  it('an address pasted into the brief is opened and scouted too, not blocked by the gate', async () => {
    const out = await runAppRecording(base('pasted', { context: `Show the main areas of the app. Also show ${site.otherUrl}/frame.` }), hooks())
    expect(out.map.pages.some((p) => p.url.startsWith(site.otherUrl))).toBe(true)
    expect(out.blockedHosts.some((b) => b.host === '127.0.0.1')).toBe(false)
  }, 180000)
})
