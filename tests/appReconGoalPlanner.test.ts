import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import type { CapabilityReport, FilmPlan, PageSegment } from '../src/shared/agentBrief'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'
import { canShowWindow, enforcePolicy, findChrome, launch } from '../src/main/appRecon/browser'
import { interpretGuardrails, PolicyGate } from '../src/main/appRecon/policy'
import { prepare } from '../src/main/appRecon/recorder'
import { runAppRecording, type RunHooks } from '../src/main/appRecon/run'
import { parseStepScript } from '../src/main/appRecon/stepScript'
import { agentFilmsPages } from '../src/main/appRecon/agent/loop'
import { goalListScript, goalNotes, goalSegments, isGoalItem, isGoalText, performWithGoals, runGoal, scriptFromPlan } from '../src/main/appRecon/goalPlanner'
import { buildAtom, type Rails } from '../src/main/appRecon/goalGuard'
import { renderStudy, studyPage } from '../src/main/appRecon/goalStudy'
import { startGoalSites, type GoalSites } from './fixtures/goalSites'

// ------------------------------------------------------------------ what counts as a goal

const SEG = (said: string, over: Partial<PageSegment> = {}): PageSegment => ({ id: 's1', said, required: true, kind: 'page', how: 'features', emphasis: 'normal', ...over })
const PLAN = (...segments: PageSegment[]): FilmPlan => ({ goal: 'g', kind: 'walkthrough', segments, music: { none: false, description: '', vocals: 'any', instruments: [], exclude: [], ambience: [], quiet: false }, voice: {}, look: { style: null, noAbstract: false }, unplaced: [], source: 'ai' } as unknown as FilmPlan)

describe('what is a goal and what is an action', () => {
  it('reads the abstract lines of the QA briefs as goals and the concrete ones as actions', () => {
    const mixed = parseStepScript('1. open `http://localhost:4712/`\n2. click the button `Load sample data`\n3. explain the Regional distribution section on the dashboard and give live examples\n4. scroll back to the top')!
    expect(mixed.items.map(isGoalItem)).toEqual([false, false, true, false])
    const shop = parseStepScript('1. open `http://localhost:4715/`\n2. find a gift under £50 for a runner\n3. add it to the cart')!
    expect(shop.items.map(isGoalItem)).toEqual([false, true, true])
    const tasks = parseStepScript('1. log in\n2. walk through what happens when a task is overdue\n3. open Settings and turn on Dark mode')!
    expect(tasks.items.map(isGoalItem)).toEqual([false, true, false])
    const forge = parseStepScript('1. open `http://localhost:4714/`\n2. open the sidebar\n3. demonstrate the API playground\'s error handling\n4. click Yes, helpful')!
    expect(forge.items.map(isGoalItem)).toEqual([false, false, true, false])
  })

  it('leaves plain narration alone: it needs no page work', () => {
    expect(isGoalText('in your own words tell that with the help of mathematics the verses are balanced')).toBe(false)
    expect(isGoalText('then provide a conclusion statement and add CTA')).toBe(false)
    expect(isGoalText('keep it warm and quick')).toBe(false)
    expect(isGoalText('click the Pricing link')).toBe(false)
    expect(isGoalText('briefly show the pricing page')).toBe(false)
  })

  it('finds the page segments of a plan that name no address and are worded as goals', () => {
    const plan = PLAN(SEG('Explain which sector drives the summer peak. Show live examples on the charts.', { target: 'Electricity-use charts' }), SEG('briefly show the pricing page', { target: 'pricing page' }), SEG('tour the home page', { url: 'https://x.test/' }))
    expect(goalSegments(plan).map((s) => s.target)).toEqual(['Electricity-use charts'])
    // such a plan is not opened page by page: each goal is worked out on the page
    expect(agentFilmsPages(plan)).toBe(false)
    expect(agentFilmsPages(PLAN(SEG('briefly show the pricing page', { target: 'pricing page' }), SEG('tour the home page', { url: 'https://x.test/' })))).toBe(true)
  })

  it('reads a list made only of goals and a sign-in, and keeps the steps around them in order', () => {
    const brief = '# steps\n\n1. sign in with the test account\n2. show how a customer would book a colour appointment with the colour specialist for a weekday morning next week\n3. finish by confirming the booking and closing the confirmation'
    expect(parseStepScript(brief)).toBeNull()
    const s = goalListScript(brief)!
    expect(s.items.map((i) => (i.login ? 'login' : isGoalItem(i) ? 'goal' : 'step'))).toEqual(['login', 'goal', 'goal'])
    expect(goalListScript('1. click Pricing\n2. click Contact')).toBeNull()
  })

  it('turns the pages of a plan into steps: an address is opened, a goal is kept whole, with what must be made clear', () => {
    const s = scriptFromPlan(PLAN(SEG('open the site', { url: 'https://x.test/' }), SEG('Show how a customer would find a gift under £50 for a runner and put it in the cart.', { target: 'gift', explain: ['how to find a gift'] })))
    expect(s.items.map((i) => i.atoms.map((a) => a.action))).toEqual([['open'], []])
    expect(s.items.map(isGoalItem)).toEqual([false, true])
    expect(s.items[1].explain).toBe('how to find a gift')
  })
})

// ------------------------------------------------------------------ the rails (no browser)

const CONTROLS = [
  { i: 1, kind: 'button', label: 'East', y: 950, inView: false, section: 'Regional distribution', same: 1 },
  { i: 2, kind: 'button', label: 'Dark mode', y: 10, inView: true, section: 'Settings', same: 1 },
  { i: 3, kind: 'button', label: 'Delete data', y: 3000, inView: false, section: 'Regional distribution', same: 1 },
  { i: 4, kind: 'link', label: 'Billing', y: 20, inView: true, section: '', same: 1, href: '/billing' },
  { i: 5, kind: 'link', label: 'Daily Sneakers', y: 500, inView: true, section: 'Regional distribution', same: 1, item: 1, href: '/p/1', cx: 300 },
  { i: 6, kind: 'button', label: 'Add to cart', y: 500, inView: true, section: 'Regional distribution', same: 3, item: 1, cx: 420 },
  { i: 7, kind: 'link', label: 'Merino Socks', y: 560, inView: true, section: 'Regional distribution', same: 1, item: 2, href: '/p/2', cx: 300 },
  { i: 8, kind: 'button', label: 'Add to cart', y: 560, inView: true, section: 'Regional distribution', same: 3, item: 2, cx: 420 },
  { i: 9, kind: 'link', label: 'Mini Crossbody', y: 620, inView: true, section: 'Regional distribution', same: 1, item: 3, href: '/p/3', cx: 300 },
  { i: 10, kind: 'button', label: 'Add to cart', y: 620, inView: true, section: 'Regional distribution', same: 3, item: 3, cx: 420 }
].map((c) => ({ cx: 100, w: 90, h: 30, ...c, cy: c.y + 15 }))
const study = (over: object = {}) => ({
  url: 'http://x.test/', title: 't', scrollY: 0, pageH: 3000, viewW: 1280, viewH: 720,
  sections: [{ heading: 'Regional distribution', level: 2, y: 900, inView: false, text: '' }, { heading: 'Settings', level: 2, y: 100, inView: true, text: '' }],
  controls: CONTROLS,
  items: [{ n: 1, section: 'Regional distribution', text: 'Daily Sneakers £55 Add to cart', controls: [] }, { n: 2, section: 'Regional distribution', text: 'Merino Socks £18 Add to cart', controls: [] }, { n: 3, section: 'Regional distribution', text: 'Mini Crossbody £45 Add to cart', controls: [] }],
  charts: [], overlays: [], lines: [], ...over
}) as never

const rails = (over: Partial<Rails> = {}): Rails => ({
  goal: 'explain the regional distribution section and give live examples', sections: ['Regional distribution'],
  gate: new PolicyGate(interpretGuardrails('', ['http://x.test/'], {}).guardrails), done: new Set(), support: { used: 0, max: 3 }, moves: { used: 0, max: 2 }, caps: { newAtoms: new Set() }, ...over
})
const act = (o: object) => ({ do: 'click', target: '', text: '', near: '', relation: 'feature', colours: [], noun: '', why: '', ...o })

describe('the planner may only do what is on the page and about the goal', () => {
  it('builds an atom for a control that is on the page', () => {
    const b = buildAtom(act({ target: 'East' }), study(), rails())
    expect(b).toMatchObject({ atom: { action: 'click', label: 'East', find: { target: 'East', kind: 'click' } } })
  })
  it('refuses a control that is not on the page, a settings control, a delete, and a control from another part of the app', () => {
    expect(buildAtom(act({ target: 'Export CSV' }), study(), rails())).toMatchObject({ reject: expect.stringMatching(/no control called "Export CSV"/) })
    expect(buildAtom(act({ target: 'Dark mode' }), study(), rails())).toMatchObject({ reject: expect.stringMatching(/setting or site control|not in the part/) })
    expect(buildAtom(act({ target: 'Delete data' }), study(), rails())).toMatchObject({ reject: expect.stringMatching(/changes or sends data/) })
    expect(buildAtom(act({ target: 'Billing' }), study(), rails())).toMatchObject({ reject: expect.stringMatching(/opens another page/) })
  })
  it('lets a step the goal needs first through, with a reason, and no more than the limit', () => {
    expect(buildAtom(act({ target: 'Dark mode', relation: 'prerequisite', why: '' }), study(), rails({ goal: 'dark mode check' }))).toMatchObject({ reject: expect.stringMatching(/no reason/) })
    const ok = buildAtom(act({ target: 'Billing', relation: 'navigation', why: 'The invoices are on the billing page.' }), study(), rails())
    expect(ok).toMatchObject({ leaves: true, support: true })
    expect(buildAtom(act({ target: 'Billing', relation: 'navigation', why: 'The invoices are on the billing page.' }), study(), rails({ moves: { used: 2, max: 2 } }))).toMatchObject({ reject: expect.stringMatching(/already moved/) })
  })
  it('a goal that asks for the cart asks for "Add to cart"; one that does not, does not', () => {
    const add = (goal: string) => buildAtom(act({ target: 'Add to cart', near: 'Merino Socks' }), study(), rails({ goal }))
    expect(add('find a gift for a runner and put it in the cart')).toMatchObject({ atom: { action: 'click', find: { relation: { rel: 'rightOf', to: 'Merino Socks' } } } })
    expect(add('show the regional distribution')).toMatchObject({ reject: expect.stringMatching(/changes or sends data/) })
  })
  it('a docs link called "Create a user" is a place, not a write; a delete link is still held back', () => {
    const st = study({ controls: [...CONTROLS, { i: 11, kind: 'link', label: 'Create a user', y: 900, cx: 100, cy: 915, w: 90, h: 30, inView: false, section: 'Regional distribution', same: 1, href: '/#create-user' }, { i: 12, kind: 'link', label: 'Delete account', y: 910, cx: 100, cy: 925, w: 90, h: 30, inView: false, section: 'Regional distribution', same: 1, href: '/#del' }] })
    expect(buildAtom(act({ target: 'Create a user' }), st, rails({ goal: 'demonstrate the API playground' }))).toMatchObject({ atom: { action: 'click', label: 'Create a user' } })
    expect(buildAtom(act({ target: 'Delete account' }), st, rails({ goal: 'demonstrate the API playground' }))).toMatchObject({ reject: expect.stringMatching(/changes or sends data/) })
  })
  it('never repeats an action that was done, and respects the person\'s own rules', () => {
    const done = new Set(['click|east|'])
    expect(buildAtom(act({ target: 'East' }), study(), rails({ done }))).toMatchObject({ reject: expect.stringMatching(/already pressed/) })
    const strict = new PolicyGate(interpretGuardrails('', ['http://x.test/'], { noSettings: true }).guardrails)
    expect(strict).toBeTruthy()
  })
})

// ------------------------------------------------------------------ a model that answers from recorded plans

type Answer = Record<string, unknown>
const decision = (status: 'continue' | 'done' | 'impossible', actions: Array<Record<string, unknown>> = [], extra: { sections?: string[]; reason?: string } = {}): Answer => ({
  status, reason: extra.reason ?? '', sections: extra.sections ?? [], actions: actions.map((a) => ({ text: '', near: '', relation: 'feature', colours: [], noun: '', why: '', ...a }))
})

function fakeModel(answers: Answer[], o: { vision?: boolean; fail?: boolean } = {}): LLMProvider & { prompts: GenerateJSONRequest[] } {
  const prompts: GenerateJSONRequest[] = []
  let i = 0
  return {
    id: 'openai', label: 'recorded', prompts,
    supportsVision: () => o.vision !== false,
    isConfigured: async () => true, listModels: async () => [],
    generateJSON: async (req: GenerateJSONRequest) => {
      prompts.push(req)
      if (o.fail) throw new Error('the model is down')
      if (req.schemaName === 'pick_control') return { index: null }
      return answers[Math.min(i++, answers.length - 1)]
    },
    generateText: async () => ''
  } as unknown as LLMProvider & { prompts: GenerateJSONRequest[] }
}

// ------------------------------------------------------------------ the real page

const runnable = !!findChrome()

describe.skipIf(!runnable)('the goal planner on real pages', () => {
  let sites: GoalSites
  let browser: Browser
  let root: string
  beforeAll(async () => {
    sites = await startGoalSites()
    root = mkdtempSync(join(tmpdir(), 'vg-goal-'))
    browser = await launch({ width: 1280, height: 720, scale: 1, userDataDir: join(root, 'p'), headless: true })
  }, 120000)
  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await sites?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  const gate = () => new PolicyGate(interpretGuardrails('', [sites.url], {}).guardrails)
  async function open(path: string): Promise<{ page: Page; gate: PolicyGate }> {
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    const g = gate()
    await enforcePolicy(page, g)
    await prepare(page, { selectors: [], values: [], privacy: false })
    await page.goto(sites.url + path, { waitUntil: 'load' })
    sites.events.length = 0
    return { page, gate: g }
  }
  const goal = (said: string, extra: object = {}) => ({ n: 3, written: 3, said, login: false, atoms: [], notes: [], ...extra })
  const deps = (o: { page: Page; gate: PolicyGate }, chat: LLMProvider | null, brief = '') => ({ page: o.page, gate: o.gate, chat, log: () => undefined, brief, secrets: [], known: [] })

  it('studies a long page as an outline: headings in order, controls under them, the data in the rows', async () => {
    const { page } = await open('/')
    const s = await studyPage(page)
    expect(s.sections.map((x) => x.heading)).toEqual(expect.arrayContaining(['Monthly consumption trend', 'Regional distribution']))
    expect(s.pageH).toBeGreaterThan(2500)
    const text = renderStudy(s)
    expect(text).toMatch(/§ Regional distribution/)
    expect(text).toMatch(/button "East"/)
    expect(text).toMatch(/item\d+: "East 52 TWh"/)
    await page.close()
  }, 60000)

  it('finds the section far down the page, then shows two live examples from the data, and leaves the rest of the app alone', async () => {
    const o = await open('/')
    const model = fakeModel([
      decision('continue', [{ do: 'scrollto', target: 'Regional distribution', why: 'The section is far down the page.' }], { sections: ['Regional distribution'] }),
      decision('continue', [
        { do: 'click', target: 'Dark mode', why: 'Make it look better.' },
        { do: 'click', target: 'Export CSV', why: 'Save the data.' },
        { do: 'click', target: 'East', why: 'East is the biggest region at 52 TWh.' }
      ]),
      decision('continue', [{ do: 'click', target: 'South', why: 'South is the smallest, 17 TWh, for contrast.' }]),
      decision('done', [], { reason: 'The readout says Selected: South — 17 TWh after East — 52 TWh.' })
    ])
    const out = await runGoal(goal('explain the Regional distribution section on the dashboard and give live examples', { explain: 'the Regional distribution section on the dashboard and give live examples' }) as never, deps(o, model, '1. open the app\n2. explain the Regional distribution section on the dashboard and give live examples'))
    expect(await o.page.evaluate(() => scrollY)).toBeGreaterThan(1500)
    expect(sites.events).toEqual(['pick:East', 'pick:South'])
    expect(sites.events).not.toContain('dark-mode')
    expect(out.report.status).toBe('done')
    expect(out.report.live).toBeGreaterThanOrEqual(2)
    expect(out.report.refused.join(' ')).toMatch(/Dark mode/)
    expect(out.report.refused.join(' ')).toMatch(/Export CSV/)
    // the steps to record are the engine's own: a scroll to the section and a click on each region, in order
    const steps = out.results.flatMap((r) => r.steps.map((s) => `${s.kind}:${s.label}`))
    expect(steps.filter((s) => /^(scrollto|click)/.test(s))).toEqual(['scrollto:Regional distribution', 'click:East', 'click:South'])
    expect(out.results[0].item.explain).toMatch(/Regional distribution/)
    // the model saw the data and the picture, and what each earlier action did
    const last = model.prompts.at(-1)!
    expect(last.prompt).toMatch(/East 52 TWh/)
    expect(last.prompt).toMatch(/Selected: East/)
    expect(last.images?.length).toBe(1)
    // the reasons are kept for the narration, and the notes say what was shown and why
    expect(out.items.flatMap((i) => i.notes).join(' ')).toMatch(/biggest region/)
    const notes = goalNotes(out.report).join('\n')
    expect(notes).toMatch(/Regional distribution/)
    expect(notes).toMatch(/not carried out/)
    await o.page.close()
  }, 120000)

  it('picks the right card of several identical buttons, and puts only the cheap gift in the cart', async () => {
    const o = await open('/shop')
    const model = fakeModel([
      decision('continue', [
        { do: 'select', target: 'Category', text: 'Socks', why: 'A runner needs socks, shoes or a belt; socks are the cheapest.' },
        { do: 'type', target: 'Max price', text: '50', why: 'The budget is £50.' },
        { do: 'click', target: 'Apply filters', why: 'Show only what fits.' }
      ], { sections: ['Filters', 'Products'] }),
      decision('continue', [{ do: 'click', target: 'Add to cart', near: 'Merino Trail Socks', relation: 'support', why: 'The goal asks for it to be put in the cart.' }]),
      decision('done', [], { reason: 'Added to cart: Merino Trail Socks (£18, under £50).' })
    ])
    const out = await runGoal(goal('find a gift under £50 for a runner and put it in the cart') as never, deps(o, model))
    expect(sites.events).toEqual(['cat:Socks', 'max:5', 'max:50', 'filter:Socks:50', 'add:Merino Trail Socks'])
    expect(out.report.live).toBeGreaterThanOrEqual(2)
    expect(await o.page.evaluate(() => document.getElementById('count')?.textContent)).toBe('1')
    expect(model.prompts[0].prompt).toMatch(/£18/)
    expect(model.prompts[0].prompt).toMatch(/same=4/)
    await o.page.close()
  }, 120000)

  it('uses "near" to press the Add to cart of the product named, not the first one', async () => {
    const o = await open('/shop')
    const model = fakeModel([
      decision('continue', [{ do: 'click', target: 'Add to cart', near: 'Mini Crossbody', relation: 'support', why: 'The goal asks for the crossbody bag in the cart.' }], { sections: ['Products'] }),
      decision('done', [], { reason: 'The cart has one item.' })
    ])
    await runGoal(goal('put the Mini Crossbody in the cart') as never, deps(o, model))
    expect(sites.events).toEqual(['add:Mini Crossbody'])
    await o.page.close()
  }, 120000)

  it('walks through the overdue task: the filter, the task, what the page says about it', async () => {
    const o = await open('/tasks')
    const model = fakeModel([
      decision('continue', [{ do: 'click', target: 'Overdue', why: 'Shows only the late tasks.' }, { do: 'click', target: 'Settings', why: 'Check the settings.' }], { sections: ['Sprint board'] }),
      decision('continue', [{ do: 'click', target: 'Fix login redirect', why: 'It is the overdue one.' }]),
      decision('continue', [{ do: 'click', target: 'Reschedule', why: 'Shows how an overdue task is put right.' }]),
      decision('done', [], { reason: 'The detail says overdue by 14 days and Moved to tomorrow.' })
    ])
    const out = await runGoal(goal('walk through what happens when a task is overdue') as never, deps(o, model))
    expect(sites.events).toEqual(['filter:overdue', 'open:Fix login redirect', 'reschedule'])
    expect(out.report.status).toBe('done')
    expect(out.report.live).toBe(3)
    expect(model.prompts[2].prompt).toMatch(/overdue by 14 days/)
    await o.page.close()
  }, 120000)

  it('says plainly that the feature does not exist, skips the goal, and never stops the run', async () => {
    const o = await open('/')
    const model = fakeModel([decision('impossible', [], { reason: 'This app has no invoices or billing section.' })])
    const out = await runGoal(goal('show how the billing invoices are exported') as never, deps(o, model))
    expect(sites.events).toEqual([])
    expect(out.report.status).toBe('unreachable')
    expect(out.skipped).toHaveLength(1)
    expect(out.skipped[0].why).toMatch(/no invoices/)
    expect(out.results[0].skipped[0].what).toMatch(/billing invoices/)
    expect(goalNotes(out.report).join(' ')).toMatch(/could not be shown \(This app has no invoices/)
    await o.page.close()
  }, 60000)

  it('works on rules when the model fails: finds the section by its words and exercises its controls', async () => {
    const o = await open('/')
    const out = await runGoal(goal('explain the Regional distribution section on the dashboard and give live examples') as never, deps(o, fakeModel([], { fail: true })))
    expect(out.report.mode).toBe('rules')
    expect(await o.page.evaluate(() => scrollY)).toBeGreaterThan(1500)
    expect(out.report.live).toBeGreaterThanOrEqual(2)
    expect(sites.events).not.toContain('dark-mode')
    expect(sites.events).not.toContain('delete-data')
    await o.page.close()
  }, 120000)

  it('with no model at all, a goal that matches nothing is skipped with the headings it did see', async () => {
    const o = await open('/')
    const out = await runGoal(goal('demonstrate the invoice export wizard') as never, deps(o, null))
    expect(out.report.status).toBe('unreachable')
    expect(out.report.reason).toMatch(/Regional distribution/)
    await o.page.close()
  }, 60000)

  it('is bounded: a model that keeps proposing the same action ends the goal instead of looping', async () => {
    const o = await open('/')
    const model = fakeModel([decision('continue', [{ do: 'click', target: 'Next ▶', why: 'Step on.' }], { sections: ['Regional distribution'] })])
    const t = Date.now()
    const out = await runGoal(goal('explain the Regional distribution section and give live examples') as never, deps(o, model))
    expect(Date.now() - t).toBeLessThan(90000)
    expect(out.report.turns).toBeLessThanOrEqual(8)
    expect(out.report.live).toBe(1)
    expect(out.report.status).not.toBe('done')
    expect(out.report.reason).toMatch(/refused|planning rounds|limit/)
    await o.page.close()
  }, 120000)

  it('runs a written list in order with the goal worked out where it stands', async () => {
    const o = await open('/')
    const script = parseStepScript('1. click the button `Residential`\n2. explain the Regional distribution section on the dashboard and give live examples\n3. click the button `Commercial`')!
    const model = fakeModel([
      decision('continue', [{ do: 'scrollto', target: 'Regional distribution', why: 'Go to the section.' }, { do: 'click', target: 'East', why: 'The biggest region.' }], { sections: ['Regional distribution'] }),
      decision('continue', [{ do: 'click', target: 'West', why: 'A middle value for comparison.' }]),
      decision('done', [], { reason: 'Two regions shown.' })
    ])
    const out = await performWithGoals({ page: o.page, gate: o.gate, script, log: () => undefined, chat: model, brief: '', secrets: [], known: [] })
    expect(sites.events).toEqual(['tab:residential', 'pick:East', 'pick:West', 'tab:commercial'])
    expect(out.reports).toHaveLength(1)
    expect(out.outcome.failure).toBeUndefined()
    // the script that was performed has the goal replaced by the actions worked out for it, in the same place
    expect(out.script.items.map((i) => i.atoms.map((a) => a.action).join('+'))).toEqual(['click', 'scrollto+click', 'click', 'click'])
    expect(out.outcome.results.map((r) => r.item.written ?? r.item.n)).toEqual([1, 2, 2, 3])
    await o.page.close()
  }, 120000)

  it('a script with no goal in it is performed exactly as before, with no model call', async () => {
    const o = await open('/')
    const script = parseStepScript('1. click the button `Residential`\n2. click the button `Commercial`')!
    const model = fakeModel([])
    const out = await performWithGoals({ page: o.page, gate: o.gate, script, log: () => undefined, chat: model, brief: '', secrets: [], known: [] })
    expect(model.prompts).toHaveLength(0)
    expect(out.reports).toHaveLength(0)
    expect(sites.events).toEqual(['tab:residential', 'tab:commercial'])
    await o.page.close()
  }, 120000)
})

// ------------------------------------------------------------------ a whole run

const CAPS: CapabilityReport = { access: 'plan', jobs: [], limits: [] } as unknown as CapabilityReport
const hooks = (): RunHooks => ({ progress: () => undefined, log: (m) => { if (process.env.GOAL_DEBUG) console.log(m) }, handoff: async () => { throw new Error('no hand-off expected') } })

describe.skipIf(!runnable || !canShowWindow())('a whole brief that only says what to show', () => {
  let sites: GoalSites
  let root: string
  beforeAll(async () => {
    sites = await startGoalSites()
    root = mkdtempSync(join(tmpdir(), 'vg-goalrun-'))
  }, 60000)
  afterAll(async () => {
    await sites?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  /** one model for the whole run: it reads the brief (a recorded film plan) and plans the goal (recorded decisions) */
  function runModel(plan: Answer, goals: Answer[]): LLMProvider {
    const g = fakeModel(goals)
    return {
      ...g,
      generateJSON: async (req: GenerateJSONRequest) => (req.schemaName === 'film_plan' ? plan : g.generateJSON(req))
    } as unknown as LLMProvider
  }
  const pari = { mode: 'autopilot' as const, capabilities: CAPS, decide: async () => null, emit: () => undefined }
  const base = (name: string, context: string, chat: LLMProvider) => ({ runDir: join(root, name), startUrl: `${sites.url}/shop`, context, mode: 'walkthrough' as const, signIn: 'none' as const, guardrailText: '', checks: {}, depth: 'quick' as const, targetSec: 40, chat, speech: null, stopAfter: 'plan' as const, pari })

  it('does not stop with "… is not a link": it works the goal out on the app\'s page and says what it did', async () => {
    sites.events.length = 0
    const brief = 'Show how a customer would find a gift under £50 for a runner and put it in the cart.'
    const plan = { goal: brief, kind: 'walkthrough', segments: [{ kind: 'page', said: brief, required: true, how: 'features', emphasis: 'normal', target: 'Gift for a runner under £50', explain: ['how a customer finds a gift and puts it in the cart'] }], music: {}, voice: {}, look: {}, unplaced: [] }
    const chat = runModel(plan, [
      decision('continue', [{ do: 'type', target: 'Max price', text: '50', why: 'The budget is £50.' }, { do: 'click', target: 'Apply filters', why: 'Only what fits.' }], { sections: ['Filters', 'Products'] }),
      decision('continue', [{ do: 'click', target: 'Add to cart', near: 'Merino Trail Socks', relation: 'support', why: 'Put the cheapest runner gift in the cart.' }]),
      decision('done', [], { reason: 'Added to cart: Merino Trail Socks.' })
    ])
    const out = await runAppRecording(base('whole', brief, chat), hooks())
    expect(sites.events.filter((e) => e.startsWith('add:'))).toEqual(['add:Merino Trail Socks'])
    const notes = out.plan.notes.join('\n')
    expect(notes).toMatch(/was a goal/)
    expect(notes).toMatch(/Max price/)
    expect(notes).not.toMatch(/is not a link/)
    // what the film will say comes from actions that were performed on the real page
    const facts = out.plan.beats.flatMap((b) => b.facts).join('\n')
    expect(facts).toMatch(/Merino Trail Socks/)
    expect(out.plan.playbook.steps.some((s) => s.kind === 'click' && /Add to cart/.test(s.label ?? ''))).toBe(true)
  }, 300000)

  it('says so, and still finishes, when the app has nothing like what the goal asks for', async () => {
    const brief = 'Show how the invoice export wizard works.'
    const plan = { goal: brief, kind: 'walkthrough', segments: [{ kind: 'page', said: brief, required: true, how: 'steps', emphasis: 'normal', target: 'invoice export wizard' }], music: {}, voice: {}, look: {}, unplaced: [] }
    const out = await runAppRecording(base('none', brief, runModel(plan, [decision('impossible', [], { reason: 'There is no invoice export in this app.' })])), hooks())
    const notes = out.plan.notes.join('\n')
    expect(notes).toMatch(/could not be shown \(There is no invoice export/)
    expect(out.plan.beats.length).toBeGreaterThan(0)
    expect(out.plan.beats.flatMap((b) => b.facts).join('\n')).toMatch(/NOT SHOWN|could not be done/)
  }, 300000)
})
