import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/main/appRecon/browser'
import { parseDirectives } from '../src/main/appRecon/directives'
import { runAppRecording, type RunHooks } from '../src/main/appRecon/run'

const ASK = 'log into the app -> go to -> ontology graph -> type in "psychology" in the filter, and explain how does quran cover the subject of psychology, and there are so many verses on psychology just alone in surah baqarah'

describe('reading the steps a person typed', () => {
  it('finds the page to open and the text to type, and leaves the explaining to the narration', () => {
    const d = parseDirectives(ASK)
    expect(d).toEqual([
      expect.objectContaining({ kind: 'open', target: 'ontology graph' }),
      expect.objectContaining({ kind: 'type', text: 'psychology', into: 'filter' })
    ])
  })
  it('does not turn a plain topic into steps, or notes into steps', () => {
    expect(parseDirectives('Show the main areas of the app')).toEqual([])
    expect(parseDirectives('Make a video about sign in\n\nAttached notes (information only):\nclick "Delete all"')).toEqual([])
  })
  it('reads ordinary sentences too', () => {
    const d = parseDirectives('Open the Reports page, then search for "invoice" in the search box.')
    expect(d).toEqual([expect.objectContaining({ kind: 'open', target: 'Reports' }), expect.objectContaining({ kind: 'type', text: 'invoice', into: 'search' })])
  })
})

const hooks = (): RunHooks => ({ progress: () => undefined, handoff: async () => { throw new Error('no hand-off expected') } })

/** a site like the one that failed: a browser check first, a landing page with a Sign in link, then a graph page with a filter */
describe.skipIf(!findChrome())('a site with a browser check and a sign-in link', () => {
  let server: Server
  let url = ''
  let root = ''
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'vg-asked-'))
    const born = Date.now()
    const logged = (c?: string) => /sid=1/.test(c ?? '')
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]
      const html = (b: string, t = 'App') => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>${t}</title><body>${b}`) }
      if (Date.now() - born < 4000 && !path.startsWith('/api')) return html('<h1>Checking your browser before accessing the site</h1><p>Please wait for up to 5 seconds...</p><script>setTimeout(()=>location.reload(),1200)</script>', 'Just a moment...')
      if (path === '/') return html('<nav><a href="/login">Sign in</a> <a href="/register">Start</a></nav><h1>Welcome</h1><p>Landing words</p>', 'Home')
      if (path === '/login' && req.method === 'POST') { res.writeHead(302, { location: '/ontology/graph', 'set-cookie': 'sid=1; Path=/' }); return res.end() }
      if (path === '/login') return html('<h1>Sign in</h1><form method="post" action="/login"><label>Email or username <input name="identifier"></label><label>Password <input type="password" name="password"></label><button type="submit">Sign in</button></form>', 'Sign in')
      if (path === '/ontology/graph') {
        if (!logged(req.headers.cookie)) { res.writeHead(302, { location: '/login' }); return res.end() }
        return html('<nav><a href="/ontology/graph">Ontology graph</a></nav><h1>Ontology graph</h1><input placeholder="Filter nodes" id="f"><ul id="n"><li>psychology of the self</li><li>law</li><li>trade</li></ul><script>f.oninput=()=>{[...n.children].forEach(li=>li.hidden=!li.textContent.includes(f.value))}</script>', 'Ontology graph')
      }
      res.writeHead(404).end()
    })
    await new Promise<void>((r) => server.listen(0, 'localhost', r))
    url = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => { server?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) })

  const input = (name: string, over = {}) => ({
    runDir: join(root, name), startUrl: `${url}/ontology/graph`, context: ASK, mode: 'walkthrough' as const, signIn: 'saved' as const,
    vault: { username: 'me@example.com', password: 'pw-12345' }, guardrailText: '', checks: {}, depth: 'thorough' as const,
    chat: null, speech: null, stopAfter: 'plan' as const, ...over
  })

  it('waits out the browser check, signs in, opens the named page and types the text', async () => {
    const out = await runAppRecording(input('ok'), hooks())
    const urls = out.map.pages.map((p) => new URL(p.url).pathname)
    expect(urls).toContain('/ontology/graph')
    expect(out.map.pages.some((p) => /checking your browser/i.test(p.title))).toBe(false)
    const steps = out.plan.playbook.steps
    expect(steps.some((s) => s.kind === 'type' && s.text === 'psychology')).toBe(true)
    expect(steps.some((s) => s.text === '{{secret:password}}')).toBe(true)
    expect(out.plan.playbook.title).not.toMatch(/Sign-in and sign-out/)
  }, 120000)

  it('says plainly when a typed step cannot be done, instead of making a video of something else', async () => {
    await expect(runAppRecording(input('miss', { context: 'go to ontology graph -> type "x" in the zodiac box' }), hooks())).rejects.toThrow(/could not be done/)
  }, 120000)

  it('still makes a plan for a public landing page that has no sign-in form of its own', async () => {
    await expect(runAppRecording(input('nologin', { startUrl: `${url}/` , context: 'Show the app' }), hooks())).resolves.toBeDefined()
  }, 120000)
})
