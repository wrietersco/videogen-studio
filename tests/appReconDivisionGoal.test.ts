import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'
import { enforcePolicy, findChrome, launch } from '../src/main/appRecon/browser'
import { interpretGuardrails, PolicyGate } from '../src/main/appRecon/policy'
import { prepare } from '../src/main/appRecon/recorder'
import { findElement } from '../src/main/appRecon/resolve'
import { accountFor, readBriefByRules } from '../src/main/appRecon/agent/brief'
import { audienceOf, exampleCount, parseProseScript, parseStepScript, scriptFromActions, splitGoalTail } from '../src/main/appRecon/stepScript'
import { runGoal } from '../src/main/appRecon/goalPlanner'
import { buildAtom, likeness, type Rails } from '../src/main/appRecon/goalGuard'
import { startDivisionGame, type DivisionGame } from './fixtures/divisionGame'

// the brief of a parent who wants a film of a kids' division game
const BRIEF = 'click "Let\'s Play" button and show different options of how your 7yo kid can play and learn to divide using this game. give 3 examples'

describe('a click, then something to show, with a count', () => {
  it('reads the brief as one step and one goal asking for 3 examples, with the audience', () => {
    const s = parseProseScript(BRIEF)!
    expect(s).toBeTruthy()
    expect(s.items.map((i) => (i.atoms.length ? 'step' : i.goal ? 'goal' : 'other'))).toEqual(['step', 'goal'])
    expect(s.items[0].atoms[0]).toMatchObject({ action: 'click', label: "Let's Play" })
    expect(s.items[1].count).toBe(3)
    // the whole wording of the goal is kept (not its first clause), with what the person said about the viewer
    expect(s.items[1].goal).toMatch(/learn to divide using this game/)
    expect(s.items.every((i) => i.unread.length === 0)).toBe(true)
    expect(s.audience).toMatch(/parent or teacher of a 7-year-old/)
  })

  it('reads the same words the same way when they come as the plan\'s action lines or as a list', () => {
    const fromLines = scriptFromActions(['click "Let\'s Play" button', 'show different options of how your 7yo kid can play and learn to divide using this game', 'give 3 examples'])!
    expect(fromLines.items.map((i) => (i.atoms.length ? 'step' : 'goal'))).toEqual(['step', 'goal'])
    expect(fromLines.items[1].count).toBe(3)
    const list = parseStepScript('1. click "Let\'s Play" and show 3 different examples of dividing\n2. say thanks')!
    expect(list.items.map((i) => (i.atoms.length ? 'step' : i.goal ? 'goal' : 'say'))).toEqual(['step', 'goal', 'say'])
    // the click and the goal of one written step are one step of the person's list
    expect(list.items[0].written).toBe(1)
    expect(list.items[1].written).toBe(1)
    expect(list.items[1].count).toBe(3)
  })

  it('counts examples in the ways people write them', () => {
    expect(exampleCount('give 3 examples')).toBe(3)
    expect(exampleCount('show me three different ways to play')).toBe(3)
    expect(exampleCount('show one example')).toBeUndefined()
    expect(exampleCount('click Pricing')).toBeUndefined()
    expect(audienceOf('for my 5 year old son')).toMatch(/5-year-old boy/)
    expect(splitGoalTail('click "Start" and show how it works')).toEqual(['click "Start"', 'show how it works'])
    // a quote is never cut, and a second click is not a goal
    expect(splitGoalTail('click "Save and show" then click Done')).toBeNull()
  })

  it('does not call a brief with one click and no goal a script', () => {
    expect(parseProseScript('click "Pricing"')).toBeNull()
  })

  for (const mode of ['walkthrough', 'launch'] as const) {
    it(`places both sentences in a ${mode} film when the AI reader is not available (nothing is "could not place")`, () => {
      const input = { context: BRIEF, startUrl: 'https://x.test/', mode, targetSec: 44, ...(mode === 'launch' ? { launch: { feature: 'homeschooling', tagline: 'Simple. Fast. Safe.', closing: 'Try it today', cta: 'Available now', targetSec: 44 } } : {}) } as never
      const plan = accountFor(BRIEF, readBriefByRules(input, BRIEF))
      expect(plan.unplaced).toEqual([])
      const page = plan.segments.find((s) => s.kind === 'page')!
      expect(page).toMatchObject({ kind: 'page', how: 'script' })
      expect((page as { actions: string[] }).actions[0]).toMatch(/Let's Play/)
      // what was understood is the person's own steps, not the launch tagline
      expect(plan.goal).toMatch(/Let's Play/)
      expect(plan.goal).not.toBe('Simple. Fast. Safe.')
    })
  }
})

describe('a control named by a symbol', () => {
  it('is its own name', () => {
    expect(likeness('✓', '✓')).toBe(1)
    expect(likeness('✔', '✓')).toBe(0) // the guard asks the page for the exact label it was shown
    expect(likeness('⌫', '✓')).toBe(0)
    expect(likeness('✂️ Cut', 'Cut')).toBe(1)
  })
  it('the guard accepts the symbol key and a toolbar button while a dialog is the part in hand', () => {
    const control = (label: string, section: string, i: number) => ({ i, kind: 'button', label, y: 10, inView: true, section, same: 1, cx: 10 * i, cy: 10, w: 40, h: 30 })
    const st = { url: 'http://x.test/', scrollY: 0, viewH: 720, pageH: 720, sections: [{ heading: 'Cut into how many parts?', y: 100 }], charts: [], items: [], controls: [control('✂️ Cut', '', 1), control('3', 'Cut into how many parts?', 2), control('✓', 'Cut into how many parts?', 3)] } as never
    const r = { goal: 'show 3 examples', sections: ['Cut into how many parts?'], gate: new PolicyGate(interpretGuardrails('', ['http://x.test/'], {}).guardrails), done: new Set<string>(['click|3|', 'click|3|#2']), support: { used: 0, max: 5 }, moves: { used: 0, max: 3 }, caps: { newAtoms: new Set<string>() } } as Rails
    const act = (target: string) => ({ do: 'click', target, text: '', replace: false, near: '', relation: 'feature', colours: [], noun: '', why: '' })
    expect(buildAtom(act('✓'), st, r)).toMatchObject({ atom: { action: 'click', label: '✓' } })
    // the third press of a digit key is fine: a number pad is pressed as often as the number needs
    expect(buildAtom(act('3'), st, r)).toMatchObject({ atom: { action: 'click', label: '3' } })
    // a button of the page's own toolbar is not "outside the part" of a single-screen game
    expect(buildAtom(act('✂️ Cut'), st, r)).toMatchObject({ atom: { action: 'click' } })
  })
})

// ------------------------------------------------------------------ the real page

type Answer = Record<string, unknown>
const decision = (status: 'continue' | 'done' | 'impossible', actions: Array<Record<string, unknown>> = [], extra: { sections?: string[]; reason?: string } = {}): Answer => ({
  status, reason: extra.reason ?? '', sections: extra.sections ?? [], actions: actions.map((a) => ({ text: '', near: '', relation: 'feature', colours: [], noun: '', why: '', ...a }))
})
function fakeModel(answers: Answer[]): LLMProvider & { prompts: GenerateJSONRequest[] } {
  const prompts: GenerateJSONRequest[] = []
  let i = 0
  return {
    id: 'openai', label: 'recorded', prompts,
    supportsVision: () => true,
    isConfigured: async () => true, listModels: async () => [],
    generateJSON: async (req: GenerateJSONRequest) => {
      prompts.push(req)
      if (req.schemaName === 'pick_control') return { index: null }
      return answers[Math.min(i++, answers.length - 1)]
    },
    generateText: async () => ''
  } as unknown as LLMProvider & { prompts: GenerateJSONRequest[] }
}
const click = (target: string, why = '') => ({ do: 'click', target, why })

describe.skipIf(!findChrome())('the planner plays a kids\' division game (SVG ruler, number pad, confirm bar)', () => {
  let game: DivisionGame
  let browser: Browser
  let root: string
  beforeAll(async () => {
    game = await startDivisionGame()
    root = mkdtempSync(join(tmpdir(), 'vg-div-'))
    browser = await launch({ width: 1280, height: 720, scale: 1, userDataDir: join(root, 'p'), headless: true })
  }, 120000)
  afterAll(async () => {
    await browser?.close().catch(() => undefined)
    await game?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  async function open(): Promise<{ page: Page; gate: PolicyGate }> {
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    const gate = new PolicyGate(interpretGuardrails('', [game.url], {}).guardrails)
    await enforcePolicy(page, gate)
    await prepare(page, { selectors: [], values: [], privacy: false })
    await page.goto(game.url, { waitUntil: 'load' })
    game.events.length = 0
    return { page, gate }
  }

  it('"Let\'s Play" is the button called "▶ Let\'s Play!"', async () => {
    const { page } = await open()
    const { found } = await findElement(page, { target: "Let's Play", kind: 'click' }, 4000)
    expect(found).toBeTruthy()
    expect(found!.label).toMatch(/Let.s Play/)
    // and a key named only by a symbol is found by that symbol
    await page.click('#start')
    await page.click('#tSize')
    const check = await findElement(page, { target: '✓', kind: 'click' }, 4000)
    expect(check.found?.label).toBe('✓')
    await page.close()
  }, 60000)

  it('shows 3 different division examples, each with its result on screen, and does not call an early control "refused"', async () => {
    const { page, gate } = await open()
    await page.click('#start')
    game.events.length = 0
    const model = fakeModel([
      // "1" is not on the page until Size opens the pad: it is early, not wrong
      decision('continue', [click('📏 Size', 'Set the ruler first.'), click('1')]),
      decision('continue', [click('1', 'a 12 cm ruler'), click('2'), click('✓')]),
      decision('continue', [click('✂️ Cut', 'Cut it into equal parts.')]),
      decision('continue', [click('3', 'three equal parts'), click('✓')]),
      decision('continue', [click('✔', 'Confirm the cut.')]),
      decision('continue', [click('📏 Size', 'A second ruler: 10 cm.')]),
      decision('continue', [click('1'), click('0'), click('✓')]),
      decision('continue', [click('✂️ Cut')]),
      decision('continue', [click('4', 'four parts: a decimal answer'), click('✓')]),
      decision('continue', [click('✔')]),
      decision('continue', [click('📏 Size', 'A third ruler: 9 cm.')]),
      decision('continue', [click('9'), click('✓')]),
      decision('continue', [click('✂️ Cut')]),
      decision('continue', [click('2'), click('✓')]),
      decision('continue', [click('✔')]),
      decision('continue', [click('🔬 Max', 'Zoom all the way in to see the millimetres.')]),
      decision('done', [], { reason: 'Three examples show their results: 12 ÷ 3 = 4, 10 ÷ 4 = 2.5, 9 ÷ 2 = 4.5.' })
    ])
    const goal = { n: 2, written: 2, said: 'show different options of how your 7yo kid can play and learn to divide using this game. give 3 examples', goal: 'show different options of how your 7yo kid can play and learn to divide using this game. give 3 examples', count: 3, login: false, atoms: [], notes: [], unread: [] }
    const out = await runGoal(goal as never, { page, gate, chat: model, log: () => undefined, brief: BRIEF, secrets: [], known: [] })
    // three different sums were really played on the page, each cut confirmed
    expect(game.events.filter((e) => /^(size|cut):/.test(e))).toEqual(['size:12', 'cut:12/3', 'size:10', 'cut:10/4', 'size:9', 'cut:9/2'])
    expect(game.events).toContain('zoom:max')
    // each result is on the screen (the math book) and they are all different
    const book = await page.$$eval('#book li', (l) => l.map((x) => x.textContent))
    expect(book).toEqual(['📓 12 ÷ 3 = 4', '📓 10 ÷ 4 = 2.5', '📓 9 ÷ 2 = 4.5'])
    expect(await page.$eval('#result', (x) => x.textContent)).toMatch(/zoomed all the way in/i)
    expect(out.report.status).toBe('done')
    expect(out.report.live).toBeGreaterThanOrEqual(6)
    // "1" asked for before the pad was open is not a refused action
    expect(out.report.refused).toEqual([])
    // the model was told how many examples the person asked for
    expect(model.prompts[0].prompt).toMatch(/ASKED FOR 3 DIFFERENT EXAMPLES/)
    expect(out.skipped).toEqual([])
    await page.close()
  }, 240000)
})
