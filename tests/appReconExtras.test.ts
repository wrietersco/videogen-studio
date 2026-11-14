import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome } from '../src/main/appRecon/browser'
import { readUseCase } from '../src/main/appRecon/directives'
import { topicHits } from '../src/main/appRecon/explore'
import { applyReviewEdits, planBeats } from '../src/main/appRecon/planner'
import { runAppRecording, type RunHooks } from '../src/main/appRecon/run'
import { brandSourceOf, validateApp } from '../src/shared/appRecording'

const ASK = 'go to -> ontology graph -> type in "psychology" in the filter, and explain how the quran covers psychology, and there are so many verses in surah baqarah'

describe('reading what the person is getting at', () => {
  it('keeps the goal and its key words apart from the steps', () => {
    const u = readUseCase(ASK)
    expect(u.steps.map((s) => s.kind)).toEqual(['open', 'type'])
    expect(u.topics).toEqual(expect.arrayContaining(['psychology', 'quran', 'baqarah', 'verses']))
    expect(u.topics).not.toContain('explain')
    expect(u.goal).toMatch(/quran covers psychology/)
  })
  it('counts how many of those words a label mentions', () => {
    expect(topicHits('Surah Al-Baqarah: psychology verses', ['psychology', 'baqarah', 'law'])).toBe(2)
    expect(topicHits('Trade', ['psychology'])).toBe(0)
  })
})

describe('choosing where the branding comes from', () => {
  const base = { name: 'x', url: 'https://example.com', context: '', signIn: 'none', checks: {}, depth: 'quick', mode: 'walkthrough', targetSec: 44, styleImages: [] }
  it('keeps old apps working and refuses a kit that was never chosen', () => {
    expect(brandSourceOf(undefined, true)).toBe('kit')
    expect(brandSourceOf(undefined, false)).toBe('none')
    expect(brandSourceOf('kit', false)).toBe('none')
    expect(brandSourceOf('site', false)).toBe('site')
  })
  it('is saved with the app', () => {
    const r = validateApp({ ...base, brandSource: 'site' })
    expect(r.ok && r.value.brandSource).toBe('site')
    const k = validateApp({ ...base, brandId: 'kit-1' })
    expect(k.ok && k.value.brandSource).toBe('kit')
  })
})

describe('the plan for a typed step', () => {
  it('shows the result and the closer look as beats of their own, and drops them with the step that made them', () => {
    const page = { url: 'http://x/g', title: 'Graph', headings: ['Graph'], fields: [], controls: [], notices: [], text: 'Graph | Labels drawn on the page: psychology, Al-Baqarah, verses' }
    const exploration = {
      visits: [{ index: 0, page, via: 'start' as const, asked: 'go to graph', interactions: [
        { steps: [{ kind: 'type' as const, selector: '#f', label: 'Filter', text: 'psychology' }], changed: true, writes: false, after: page, asked: 'type "psychology" in the filter' },
        { steps: [{ kind: 'click' as const, selector: '#a', label: 'Al-Baqarah' }], changed: true, writes: false, after: page, followed: 'Al-Baqarah' }
      ] }],
      actions: 3, stoppedBy: 'done' as const, elapsedMs: 1
    }
    const plan = planBeats({ map: { version: 1, startUrl: 'http://x/g', host: 'x', scoutedAt: '', pages: [page], login: { detected: false, otpLikely: false }, sensitiveSelectors: [] }, exploration, context: ASK, startUrl: 'http://x/g', hasVault: false, secrets: [], scripted: true })
    expect(plan.beats.map((b) => b.kind)).toEqual(['page', 'result', 'detail'])
    const result = plan.beats[1]
    expect(result.facts.join(' ')).toMatch(/quran covers psychology/)
    expect(plan.playbook.steps.filter((s) => s.intent === 'inspect')).toHaveLength(2)
    const trimmed = applyReviewEdits(plan, { removeBeats: [0], lines: {} })
    expect(trimmed.beats).toHaveLength(0)
  })
})

const hooks = (): RunHooks => ({ progress: () => undefined, handoff: async () => { throw new Error('no hand-off expected') } })

describe.skipIf(!findChrome())('a website with its own branding', () => {
  let server: Server
  let url = ''
  let root = ''
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 48" width="160" height="48"><rect width="160" height="48" rx="8" fill="#e11d48"/><circle cx="24" cy="24" r="12" fill="#ffffff"/></svg>'
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'vg-extras-'))
    server = createServer((req, res) => {
      const path = (req.url ?? '/').split('?')[0]
      const html = (b: string, t = 'App', head = '') => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><title>${t}</title>${head}<body style="margin:0;font-family:sans-serif">${b}`) }
      if (path === '/logo.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(svg) }
      // site 1: a real logo file in the header, a theme colour
      if (path === '/') return html('<header style="padding:14px 24px;background:#fff"><a href="/" class="logo"><img src="/logo.svg" alt="Acme" width="160" height="48"></a><a href="/about">About</a></header><h1>Welcome to Acme</h1>', 'Acme', '<meta name="theme-color" content="#e11d48">')
      // site 2: three logo candidates whose files cannot be fetched; the logo is only a coloured box on the page
      if (path === '/broken') return html('<header style="padding:14px 24px;background:#fff"><a href="/" class="logo"><img src="/missing-a.png" alt="Acme" width="120" height="44" style="background:#1d4ed8"></a><a href="/x"><img class="logo-alt" src="/missing-b.png" alt="Acme two" width="60" height="40" style="background:#1d4ed8"></a><a href="/y"><img class="brand-mark" src="/missing-c.png" alt="Acme three" width="50" height="40" style="background:#1d4ed8"></a></header><h1>Broken files</h1>', 'Broken')
      // site 3: the name is only text in a coloured header, no picture at all
      if (path === '/texty') return html('<header style="padding:14px 24px;background:#fff"><a href="/" class="logo" style="font-size:28px;font-weight:800;color:#0f766e;text-decoration:none">GreenCo</a></header><h1>Words only</h1>', 'GreenCo')
      // the graph for the extra mile
      if (path === '/ontology/graph') return html('<nav><a href="/ontology/graph">Ontology graph</a></nav><h1>Ontology graph</h1><input placeholder="Filter nodes" id="f"><ul id="n"><li><a href="/node/baqarah">Surah Al-Baqarah: psychology verses</a></li><li><a href="/node/law">Law and trade</a></li><li><a href="/node/nisa">Surah An-Nisa</a></li></ul><script>f.oninput=()=>{[...n.children].forEach(li=>li.hidden=!li.textContent.toLowerCase().includes(f.value.toLowerCase()))}</script>', 'Ontology graph')
      if (path === '/node/baqarah') return html('<nav><a href="/ontology/graph">Ontology graph</a></nav><h1>Surah Al-Baqarah</h1><p>Verses on the self, the heart and the mind.</p>', 'Al-Baqarah')
      res.writeHead(404).end('nope')
    })
    await new Promise<void>((r) => server.listen(0, 'localhost', r))
    url = `http://localhost:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => { server?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) })

  const input = (name: string, over = {}) => ({
    runDir: join(root, name), startUrl: `${url}/`, context: 'Show the app', mode: 'walkthrough' as const, signIn: 'none' as const,
    guardrailText: '', checks: {}, depth: 'quick' as const, chat: null, speech: null, stopAfter: 'plan' as const, ...over
  })
  const record = (dir: string) => JSON.parse(readFileSync(join(dir, 'brand', 'site-brand.json'), 'utf8')) as { how?: string; colors: string[]; tries: number; failures: string[] }

  it('takes the site\'s own logo file and its colours', async () => {
    const out = await runAppRecording(input('own', { siteBrand: true }), hooks())
    const r = record(out.runDir)
    expect(r.how).toBe('file')
    expect(existsSync(join(out.runDir, 'brand', 'site-logo-ondark.png'))).toBe(true)
    expect(out.brandNotes?.join(' ')).toMatch(/site's own logo file/)
    expect(r.colors[0]).toMatch(/^#(?:e[0-9a-f]|d[0-9a-f])[0-3][0-9a-f][4-6][0-9a-f]$/i)
  }, 120000)

  it('does nothing about branding unless asked', async () => {
    const out = await runAppRecording(input('off'), hooks())
    expect(out.brandNotes).toEqual([])
    expect(existsSync(join(out.runDir, 'brand'))).toBe(false)
  }, 120000)

  it('tries three times, then takes a picture of the logo when the files cannot be fetched', async () => {
    const out = await runAppRecording(input('broken', { siteBrand: true, startUrl: `${url}/broken` }), hooks())
    const r = record(out.runDir)
    expect(r.tries).toBe(3)
    expect(r.failures).toHaveLength(3)
    expect(r.how).toBe('screenshot')
    expect(existsSync(join(out.runDir, 'brand', 'site-logo-ondark.png'))).toBe(true)
    expect(out.brandNotes?.join(' ')).toMatch(/3 tries.*picture of the logo/)
    expect(r.colors[0]).toMatch(/^#[0-9a-f]{2}[0-9a-f]{2}[c-f][0-9a-f]$/i)
  }, 120000)

  it('photographs a name written in text, with no tries to make', async () => {
    const out = await runAppRecording(input('texty', { siteBrand: true, startUrl: `${url}/texty` }), hooks())
    const r = record(out.runDir)
    expect(r.how).toBe('screenshot')
    expect(r.tries).toBe(0)
    expect(r.colors.length).toBeGreaterThan(0)
  }, 120000)

  it('opens what shows the point after the typed step, and holds the result on screen', async () => {
    const out = await runAppRecording(input('extra', { startUrl: `${url}/ontology/graph`, context: ASK, stopAfter: 'record' as const }), hooks())
    const kinds = out.plan.beats.map((b) => b.kind)
    expect(kinds).toEqual(['page', 'result', 'detail'])
    const steps = out.plan.playbook.steps
    expect(steps.some((s) => s.kind === 'type' && s.text === 'psychology')).toBe(true)
    expect(steps.some((s) => s.kind === 'click' && /Baqarah/.test(s.label ?? ''))).toBe(true)
    const take = JSON.parse(readFileSync(join(out.runDir, 'take.json'), 'utf8')) as { beats: Array<{ beat: number; startSec: number; endSec: number; url: string }> }
    const resultBeat = take.beats.find((b) => b.beat === 1)!
    expect(resultBeat.endSec - resultBeat.startSec).toBeGreaterThanOrEqual(6.4)
    expect(take.beats.find((b) => b.beat === 2)!.url).toMatch(/\/node\/baqarah/)
  }, 240000)
})
