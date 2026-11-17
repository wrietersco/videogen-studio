import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import puppeteer from 'puppeteer-core'
import type { AppPage } from '../src/shared/appRecon'
import type { ClipSegment, NarrationSegment, PageSegment } from '../src/shared/agentBrief'
import { findHeadlessShell } from '../src/main/appRecon/browser'
import { PolicyGate } from '../src/main/appRecon/policy'
import { planSegment, scoutSegment } from '../src/main/appRecon/agent/act'
import { nextMove, reviewSegment, reviewSegmentWithVision, type PageEvidence } from '../src/main/appRecon/agent/review'

const sec = (label: string, kind: 'section' | 'stage' | 'tab' | 'card' = 'section', extra: object = {}) => ({ label, kind, selector: `#${label.toLowerCase().replace(/\W+/g, '-')}`, text: `${label} text`, ...extra })
const page = (url: string, headings: string[], sections: ReturnType<typeof sec>[]): AppPage => ({ url, title: headings[0], headings, fields: [], controls: [], notices: [], text: 'some text', sections })
const seg = (over: Partial<PageSegment>): PageSegment => ({ id: 's1', said: 'x', required: true, kind: 'page', how: 'tour', emphasis: 'normal', url: 'http://app.test/', ...over })

const home = page('http://app.test/', ['Acme', 'Features', 'How it works', 'Pricing', 'Customers', 'FAQ'], ['Features', 'How it works', 'Pricing', 'Customers', 'FAQ'].map((l) => sec(l)))
const run = page('http://app.test/run', ['Research run'], ['Plan', 'Search', 'Read', 'Analyse', 'Draft', 'Review'].map((l) => sec(l, 'stage')))
const report = page('http://app.test/report', ['Report', 'Summary', 'Sources'], [sec('Overview', 'tab'), sec('Perspectives', 'tab'), sec('Save report', 'tab'), sec('Timeline', 'card'), sec('Summary'), sec('Sources')])

describe('planSegment', () => {
  it('tour: goto, then one beat per section in page order', () => {
    const p = planSegment(seg({ how: 'tour', explain: ['it is simple'] }), home, { startBeat: 3, idPrefix: 'a' })
    expect(p.steps[0]).toMatchObject({ kind: 'goto', url: 'http://app.test/', beat: 3 })
    const reveals = p.steps.filter((s) => s.kind === 'reveal')
    expect(reveals.map((s) => s.label)).toEqual(['Features', 'How it works', 'Pricing', 'Customers', 'FAQ'])
    expect(p.beats.map((b) => b.beat)).toEqual([3, 4, 5, 6, 7, 8])
    expect(new Set(p.steps.map((s) => s.id)).size).toBe(p.steps.length)
    expect(p.beats[0].facts.join(' ')).toContain('it is simple')
    expect(p.planned).toHaveLength(5)
  })

  it('tour keeps what the person named when it must cut', () => {
    const p = planSegment(seg({ how: 'tour', emphasis: 'brief', lookFor: ['faq'] }), home, { startBeat: 0, idPrefix: 'a' })
    const labels = p.steps.filter((s) => s.kind === 'reveal').map((s) => s.label)
    expect(labels).toHaveLength(3)
    expect(labels).toContain('FAQ')
    expect(p.notes.join(' ')).toContain('5 sections')
  })

  it('steps: the six stages in order', () => {
    const p = planSegment(seg({ how: 'steps', url: 'http://app.test/run' }), run, { startBeat: 0, idPrefix: 'b' })
    expect(p.steps.filter((s) => s.kind === 'reveal').map((s) => s.label)).toEqual(['Plan', 'Search', 'Read', 'Analyse', 'Draft', 'Review'])
    expect(p.beats.filter((b) => b.kind === 'step')).toHaveLength(6)
    expect(p.beats[1].facts[0]).toBe('Stage 1 of 6: Plan')
    expect(p.steps.some((s) => s.kind === 'click')).toBe(false)
  })

  it('steps: clicks an expander only when it does not write data', () => {
    const pg = page('http://app.test/run', ['Run'], [sec('Plan', 'stage', { expandable: true }), sec('Delete everything', 'stage', { expandable: true })])
    const p = planSegment(seg({ how: 'steps', url: 'http://app.test/run' }), pg, { startBeat: 0, idPrefix: 'b' })
    const clicks = p.steps.filter((s) => s.kind === 'click')
    expect(clicks.map((c) => c.label)).toEqual(['Plan'])
    expect(clicks[0].intent).toBe('inspect')
    expect(p.notes.join(' ')).toContain('Delete everything')
  })

  it('steps: says so when the page has no stages', () => {
    const p = planSegment(seg({ how: 'steps' }), home, { startBeat: 0, idPrefix: 'b' })
    expect(p.notes.join(' ')).toContain('no stages')
    expect(p.planned.length).toBeGreaterThan(0)
  })

  it('features: 3 to 5 distinct regions, lookFor first, writing tab not clicked', () => {
    const p = planSegment(seg({ how: 'features', url: 'http://app.test/report', lookFor: ['perspectives'] }), report, { startBeat: 0, idPrefix: 'c' })
    const labels = p.steps.filter((s) => s.kind === 'reveal').map((s) => s.label!)
    expect(labels.length).toBeGreaterThanOrEqual(3)
    expect(labels.length).toBeLessThanOrEqual(5)
    expect(labels).toContain('Perspectives')
    expect(new Set(labels).size).toBe(labels.length)
    const clicked = p.steps.filter((s) => s.kind === 'click').map((s) => s.label)
    expect(clicked).toContain('Perspectives')
    expect(clicked).not.toContain('Save report')
  })

  it('features: reports a lookFor that is not on the page', () => {
    const p = planSegment(seg({ how: 'features', url: 'http://app.test/report', lookFor: ['chat box'] }), report, { startBeat: 0, idPrefix: 'c' })
    expect(p.notes.join(' ')).toContain('chat box')
  })

  it('glance: goto and one hold scaled by emphasis', () => {
    const brief = planSegment(seg({ how: 'glance', emphasis: 'brief' }), home, { startBeat: 0, idPrefix: 'g' })
    const long = planSegment(seg({ how: 'glance', emphasis: 'long' }), home, { startBeat: 0, idPrefix: 'g' })
    expect(brief.steps.map((s) => s.kind)).toEqual(['goto', 'wait'])
    expect(brief.beats).toHaveLength(1)
    expect(long.steps[1].holdMs!).toBeGreaterThan(brief.steps[1].holdMs!)
  })

  it('a segment named in words goes to the address that was found', () => {
    const p = planSegment(seg({ url: undefined, target: 'research run', how: 'glance' }), run, { startBeat: 0, idPrefix: 'g' })
    expect(p.steps[0].url).toBe('http://app.test/run')
  })
})

describe('reviewSegment: pages', () => {
  const s = seg({ how: 'tour', url: 'http://app.test/' })
  const planned = [{ stepId: 'a3', label: 'Features' }, { stepId: 'a4', label: 'Pricing' }]
  const ev = (over: Partial<PageEvidence> = {}): PageEvidence => ({
    kind: 'page',
    reachedUrl: 'http://app.test/',
    planned,
    log: [{ t: 0, step: 'a1', note: 'opened' }, { t: 2, step: 'a3', note: 'showed "Features"' }, { t: 4, step: 'a4', note: 'showed "Pricing"' }],
    beatsRecorded: 3,
    ...over
  })

  it('done when everything planned was shown', () => expect(reviewSegment(s, ev()).status).toBe('done'))
  it('partial when some were not found', () => {
    const c = reviewSegment(s, ev({ log: [{ t: 0, step: 'a1', note: 'opened' }, { t: 2, step: 'a3', note: 'showed "Features"' }, { t: 4, step: 'a4', note: 'could not find "Pricing", so it was not shown' }] }))
    expect(c.status).toBe('partial')
    expect(c.note).toContain('1 of 2')
  })
  it('partial when a repair dropped a step', () => expect(reviewSegment(s, ev({ repairs: ['a4: "Pricing" is no longer there, so that step is left out'] })).status).toBe('partial'))
  it('substituted when another page was shown', () => {
    const c = reviewSegment(s, ev({ reachedUrl: 'http://app.test/login' }))
    expect(c.status).toBe('substituted')
    expect(c.note).toContain('/login')
  })
  it('path match ignores query, trailing slash and case', () => expect(reviewSegment(seg({ url: 'http://app.test/Run/' }), ev({ reachedUrl: 'http://app.test/run?x=1', planned: [], log: [{ t: 0, step: 'a1', note: 'x' }] })).status).toBe('partial'))
  it('missed when it never got there', () => expect(reviewSegment(s, ev({ reachedUrl: undefined, beatsRecorded: 0, log: [] })).status).toBe('missed'))
  it('skipped with its reason', () => {
    const c = reviewSegment(s, { kind: 'page', planned: [], log: [], skippedBecause: 'blocked host', attempts: 0 })
    expect(c.status).toBe('skipped')
    expect(c.note).toContain('blocked host')
  })
  it('a segment named in words is matched on the title', () => expect(reviewSegment(seg({ url: undefined, target: 'pipeline', how: 'glance' }), ev({ planned: [], reachedUrl: 'http://app.test/pipeline' })).status).toBe('done'))
  it('narration that skips what was asked downgrades done', () => {
    const c = reviewSegment(seg({ explain: ['you can refine the research by chatting'] }), ev({ lines: ['Here is the homepage.'] }))
    expect(c.status).toBe('partial')
  })
  it('vision that finds nothing downgrades done; one that finds it keeps it', async () => {
    const withLook = seg({ lookFor: ['perspectives'] })
    const frames = ['a.jpg', 'b.jpg']
    const no = await reviewSegmentWithVision(withLook, ev(), frames, async () => ({ ok: false, why: 'only a login box' }))
    expect(no.status).toBe('partial')
    const yes = await reviewSegmentWithVision(withLook, ev(), frames, async (f) => ({ ok: f === 'b.jpg', why: 'tabs visible' }))
    expect(yes.status).toBe('done')
    const none = await reviewSegmentWithVision(withLook, ev(), frames, async () => null)
    expect(none.status).toBe('done')
  })
})

describe('reviewSegment: clips and narration', () => {
  const clip: ClipSegment = { id: 'c1', said: 'x', required: true, kind: 'ai-clip', subject: 'a tired researcher', purpose: 'problem', style: null, seconds: 6 }
  it('clip: missing, off length, bad keyframe, fine', () => {
    expect(reviewSegment(clip, { kind: 'ai-clip', exists: false }).status).toBe('missed')
    expect(reviewSegment(clip, { kind: 'ai-clip', exists: true, seconds: 1 }).status).toBe('partial')
    expect(reviewSegment(clip, { kind: 'ai-clip', exists: true, seconds: 6, keyframe: { ok: false, why: 'shows a cat' } }).status).toBe('partial')
    expect(reviewSegment(clip, { kind: 'ai-clip', exists: true, seconds: 6, keyframe: { ok: true, why: 'matches' } }).status).toBe('done')
  })
  const nar: NarrationSegment = { id: 'n1', said: 'x', required: true, kind: 'narration', claims: ['you can refine the research by chatting', 'reports export to PDF'], over: 'card' }
  it('narration: fuzzy word overlap per claim', () => {
    expect(reviewSegment(nar, { kind: 'narration', lines: ['Refine your research by chatting with it.', 'Export the report to PDF.'] }).status).toBe('done')
    expect(reviewSegment(nar, { kind: 'narration', lines: ['You refine the research just by chatting.'] }).status).toBe('partial')
    expect(reviewSegment(nar, { kind: 'narration', lines: ['Welcome to the app.'] }).status).toBe('missed')
  })
})

describe('nextMove', () => {
  const chk = (status: 'done' | 'partial' | 'missed' | 'substituted' | 'skipped') => ({ segment: 's1', status, evidence: [], note: '', attempts: 1 })
  it('accepts done and skipped', () => {
    expect(nextMove(chk('done'), 1)).toBe('accept')
    expect(nextMove(chk('skipped'), 2)).toBe('accept')
  })
  it('retries until two attempts', () => {
    expect(nextMove(chk('missed'), 1)).toBe('retry')
    expect(nextMove(chk('partial'), 1)).toBe('retry')
  })
  it('asks for a required segment that still fails', () => {
    expect(nextMove(chk('missed'), 2)).toBe('ask')
    expect(nextMove(chk('substituted'), 2, true)).toBe('ask')
  })
  it('substitutes a missed optional one, accepts a partial one', () => {
    expect(nextMove(chk('missed'), 2, false)).toBe('substitute')
    expect(nextMove(chk('partial'), 2, false)).toBe('accept')
  })
})

describe('scoutSegment against a local page', () => {
  const shell = findHeadlessShell()
  const html = (body: string) => `<!doctype html><title>${body.slice(0, 20)}</title><body><main>${body}</main></body>`
  it.skipIf(!shell)('opens, scouts sections, and explains 404, redirects and blocked hosts', async () => {
    const server = createServer((req, res) => {
      const u = req.url ?? '/'
      if (u === '/') {
        res.setHeader('content-type', 'text/html')
        res.end(html('<h1>Acme</h1>' + ['Alpha', 'Beta', 'Gamma'].map((h) => `<section><h2>${h}</h2><p>${h} is here</p></section>`).join('') + '<ol class="steps"><li><h3>One</h3></li><li><h3>Two</h3></li></ol><a href="/xylo">Xylophone</a>'))
      } else if (u === '/old') {
        res.statusCode = 302
        res.setHeader('location', '/login')
        res.end()
      } else if (u === '/login') {
        res.setHeader('content-type', 'text/html')
        res.end(html('<h1>Sign in</h1><input type="password" name="pw">'))
      } else {
        res.statusCode = 404
        res.end('nope')
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const dir = mkdtempSync(join(tmpdir(), 'vg-act-'))
    const browser = await puppeteer.launch({ executablePath: shell!, headless: 'shell', userDataDir: join(dir, 'u') })
    try {
      const pg = await browser.newPage()
      const gate = new PolicyGate({ allowedHosts: ['127.0.0.1'], readOnly: false, blockedWords: [], advisory: [] })
      const o = { outDir: join(dir, 's'), name: 'p' }
      const ok = await scoutSegment(pg, seg({ url: `${base}/` }), gate, o)
      expect(ok.ok).toBe(true)
      const labels = ok.page!.sections!.map((s) => `${s.kind}:${s.label}`)
      expect(labels).toEqual(expect.arrayContaining(['section:Alpha', 'section:Beta', 'section:Gamma', 'stage:One', 'stage:Two']))
      const plan = planSegment(seg({ url: `${base}/`, how: 'tour' }), ok.page!, { startBeat: 0, idPrefix: 't', gate })
      expect(plan.planned.map((p) => p.label)).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Gamma']))
      // the selectors the scout wrote resolve to the elements again
      for (const s of plan.steps.filter((s) => s.selector)) expect(await pg.$(s.selector!)).not.toBeNull()

      expect((await scoutSegment(pg, seg({ url: `${base}/nope` }), gate, o)).why).toContain('404')
      expect((await scoutSegment(pg, seg({ url: `${base}/old` }), gate, o)).why).toContain('sign-in')
      expect((await scoutSegment(pg, seg({ url: 'http://elsewhere.example/' }), gate, o)).why).toContain('not one of the allowed sites')
      const byWords = await scoutSegment(pg, seg({ url: undefined, target: "xylophone" }), gate, { ...o, startUrl: `${base}/` })
      expect(byWords.ok).toBe(false) // /x is a 404 here, found through the link and reported plainly
      expect(byWords.why).toContain('404')
    } finally {
      await browser.close()
      server.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  }, 90000)
})
