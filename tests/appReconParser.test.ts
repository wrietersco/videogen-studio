import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isToneSentence, parseProseScript, parseStepScript, scriptFromActions, type ScriptItem, type StepScript } from '../src/main/appRecon/stepScript'
import { readDate } from '../src/main/appRecon/dates'
import { scriptPlan, type ItemResult, type ScriptOutcome } from '../src/main/appRecon/script'
import type { AppMap, Atom } from '../src/shared/appRecon'

const brief = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'qa-briefs', `${name}.md`), 'utf8')
const steps = (name: string): StepScript => {
  const s = parseStepScript(brief(name)) ?? parseProseScript(brief(name))
  if (!s) throw new Error(`${name} did not parse`)
  return s
}
const at = (s: StepScript, n: number): ScriptItem => s.items.find((i) => (i.written ?? i.n) === n) as ScriptItem
const kinds = (i: ScriptItem): string[] => i.atoms.map((a) => a.action)
const labels = (i: ScriptItem): string[] => i.atoms.map((a) => ('label' in a ? a.label : ''))
const MON = new Date(2026, 10, 23) // Monday 23 Nov 2026

/** nothing a person wrote is dropped silently: every step has atoms, says something, is a goal, or is listed as not understood */
function accounted(s: StepScript): string[] {
  return s.items.filter((i) => !i.login && !i.atoms.length && !i.explain && !i.narration && !i.goal && !i.unread.length).map((i) => i.said)
}

describe('dates from words', () => {
  it('says which rule it used when the words mean two days', () => {
    const r = readDate('next friday', MON)!
    expect(r.date).toBe('2026-12-04')
    expect(r.rule).toMatch(/Friday of next week.*not the nearer Friday 2026-11-27/)
    expect(readDate('next friday', new Date(2026, 10, 28))!.date).toBe('2026-12-04') // from the Saturday
    expect(readDate('next friday', new Date(2026, 10, 26))!.date).toBe('2026-12-04') // from Thursday 26 Nov
    expect(readDate('this friday', MON)!.date).toBe('2026-11-27')
  })
  it('counts days, weeks and months from today', () => {
    expect(readDate('three weeks from today', MON)!.date).toBe('2026-12-14')
    expect(readDate('in 2 days', MON)!.date).toBe('2026-11-25')
    expect(readDate('tomorrow', MON)!.date).toBe('2026-11-24')
    expect(readDate('next week', MON)!.date).toBe('2026-11-30')
    expect(readDate('the 14th', MON)!.date).toBe('2026-12-14')
    expect(readDate('the 30th', MON)!.date).toBe('2026-11-30')
    expect(readDate('14 December', MON)!.date).toBe('2026-12-14')
    expect(readDate('next month', MON)!.date).toBe('2026-12-23')
  })
})

describe('salon (brief 1 prose, 1b numbered)', () => {
  it('reads the casual prose brief as a script that books the haircut, and keeps the tone sentences out', () => {
    const s = steps('1-brief')
    expect(s.source).toBe('prose')
    expect(s.items[0].login).toBe(true)
    expect(labels(at(s, 2))).toEqual(['book now'])
    // "pick a haircut, the mens cut is fine, and daniel as the stylist"
    expect(labels(at(s, 3))).toEqual(['haircut', 'mens cut', 'daniel'])
    expect(kinds(at(s, 4))).toEqual(['date', 'pick'])
    const date = at(s, 4).atoms[0] as Extract<Atom, { action: 'date' }>
    expect(date.phrase).toBe('next friday')
    expect(date.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(date.rule).toBeTruthy()
    expect(at(s, 4).atoms[1]).toMatchObject({ action: 'pick', label: 'time', within: 'morning' })
    expect(at(s, 5).atoms[0]).toMatchObject({ action: 'type', label: 'phone number', text: '07700 900123' })
    expect(labels(at(s, 5))).toContain('finish booking')
    // tone and context are not steps
    expect(s.items.flatMap((i) => labels(i)).join(' ')).not.toMatch(/fancy|warm|loud|techy/)
    expect(s.tone.join(' ')).toMatch(/techy/)
    expect(s.tone.join(' ')).toMatch(/warm and welcoming/)
    expect(accounted(s)).toEqual([])
  })
  it('reads the numbered version with the same actions (typos and role words cleaned)', () => {
    const s = steps('1b-brief')
    expect(s.items).toHaveLength(7)
    expect(labels(at(s, 3))).toEqual(['haircut', 'mens cut'])
    expect(labels(at(s, 4))).toEqual(['daniel'])
    expect(kinds(at(s, 5))).toEqual(['date', 'pick'])
    expect(at(s, 6).atoms[0]).toMatchObject({ action: 'type', label: 'phone number', text: '07700 900123' })
    expect(at(s, 7).atoms[0]).toMatchObject({ action: 'click', label: 'finish booking' })
  })
  it('turns the actions of an AI plan into a script as well', () => {
    const s = scriptFromActions(['sign in with the test account', 'click Book now', "choose the men's cut", 'pick Daniel as the stylist', 'put in phone number 07700 900123'])!
    expect(s.source).toBe('plan')
    expect(s.items[0].login).toBe(true)
    expect(labels(s.items[1])).toEqual(['Book now'])
    expect(labels(s.items[2])).toEqual(["men's cut"])
    expect(labels(s.items[3])).toEqual(['Daniel'])
  })
})

describe('prose, bullets and chains', () => {
  it('reads "first … then … after that …" and one sentence per step', () => {
    const s = parseProseScript('First open the Reports page, then click Customers. After that tick the Active box. Finally press Save.')!
    expect(s.items.map((i) => labels(i)[0])).toEqual(['Reports page', 'Customers', 'Active', 'save'].map((x) => expect.stringMatching(new RegExp(x, 'i'))))
    const t = parseProseScript('Click Reports.\nClick Customers.\nPress Save.')!
    expect(t.items).toHaveLength(3)
  })
  it('does not read a plain description of what the video is about as steps', () => {
    expect(parseProseScript('Show the dashboard and the customers page')).toBeNull()
    expect(parseProseScript('Make a short friendly video of my app. Keep it simple.')).toBeNull()
  })
  it('reads bullets', () => {
    const s = parseStepScript('Steps:\n- click Reports\n- tick the Active box\n* press Save')!
    expect(s.items).toHaveLength(3)
    expect(labels(s.items[1])).toEqual(['Active'])
  })
  it('knows a tone sentence from an instruction', () => {
    for (const t of ['my customers are not techy so keep it simple', 'Warm, quick, no jargon.', 'hi! i run a small hair salon', 'make it sound warm and welcoming like a friend explaining it', 'no loud music pls']) expect(isToneSentence(t)).toBe(true)
    for (const t of ['click the Reports tab', 'show the dashboard', 'press book now', 'open Settings and turn on Dark mode']) expect(isToneSentence(t)).toBe(false)
  })
})

describe('vocabulary: ticks, toggles, closes, sorts, quantities', () => {
  const one = (line: string): ScriptItem => parseStepScript(`1. log in\n2. ${line}`)!.items[1]
  it('reads the verbs a person uses for a control', () => {
    expect(one('tick Shoes in the filters').atoms[0]).toMatchObject({ action: 'click', label: 'Shoes', find: { within: ['filters'] } })
    expect(one('untick the terms box').atoms[0]).toMatchObject({ label: 'terms' })
    expect(one('turn on Dark mode').atoms[0]).toMatchObject({ label: 'Dark mode' })
    expect(one('switch the filter off again').atoms[0]).toMatchObject({ label: 'filter' })
    expect(one('add it to the cart').atoms[0]).toMatchObject({ label: 'add to cart' })
    expect(one('increase the quantity to 2 in the mini cart').atoms[0]).toMatchObject({ label: 'increase quantity', find: { within: ['mini cart'] } })
    expect(one('close the panel').atoms[0]).toMatchObject({ label: 'close', find: { within: ['panel'] } })
    expect(one('dismiss it').atoms[0]).toMatchObject({ label: 'close' })
    expect(one('confirm the booking').atoms[0]).toMatchObject({ label: 'confirm booking' })
    expect(one('sort by price from high to low').atoms[0]).toMatchObject({ action: 'select', label: 'sort', option: 'price high to low' })
    expect(one('sort the table by the Total column').atoms[0]).toMatchObject({ action: 'click', label: 'Total' })
    expect(one('press Yes, helpful in the feedback widget at the bottom').atoms[0]).toMatchObject({ label: 'Yes, helpful' })
  })
  it('strips filler and role words from names', () => {
    expect(labels(one('pick daniel as the stylist'))).toEqual(['daniel'])
    expect(labels(one('the mens cut is fine'))).toEqual(['mens cut'])
    expect(labels(one('choose the red colour and size XL'))).toEqual(['red', 'XL'])
    expect(labels(one('pick the blue one'))).toEqual(['blue'])
    expect(labels(one('press the book now button'))).toEqual(['book now'])
  })
  it('keeps an apostrophe inside a name from being a quote', () => {
    expect(labels(one("choose the haircut and then the kids' cut, press continue"))).toEqual(['haircut', "kids' cut", 'continue'])
  })
})

describe('typing', () => {
  const one = (line: string): ScriptItem => parseStepScript(`1. log in\n2. ${line}`)!.items[1]
  it('reads fields said in natural words', () => {
    expect(one('put in phone number 07700 900123').atoms[0]).toMatchObject({ action: 'type', label: 'phone number', text: '07700 900123' })
    expect(one('enter your email grace@example.com').atoms[0]).toMatchObject({ action: 'type', text: 'grace@example.com' })
    expect(one('search for rate limits').atoms[0]).toMatchObject({ action: 'type', label: 'search', text: 'rate limits' })
    expect(one('fill in the name field with Mei').atoms[0]).toMatchObject({ action: 'type', label: 'name', text: 'Mei' })
    expect(one('change `plan` to `team` in the request body').atoms[0]).toMatchObject({ action: 'type', label: 'plan', text: 'team', replace: true })
    expect(one('set the quantity to 3').atoms[0]).toMatchObject({ action: 'type', label: 'quantity', text: '3', replace: true })
  })
  it('reads several fields in one step', () => {
    const a = parseStepScript(brief('5b-brief'))!
    expect(at(a, 6).atoms).toMatchObject([{ action: 'type', label: 'Expiry', text: '12/30' }, { action: 'type', label: 'CVC', text: '123' }])
    const b = parseStepScript(brief('5-brief'))!
    const fields = at(b, 8).atoms.filter((x) => x.action === 'type') as Array<Extract<Atom, { action: 'type' }>>
    expect(fields.map((f) => [f.label, f.text])).toEqual([['name', 'Demo Shopper'], ['email', 'demo@example.test'], ['address', '1 Test Street'], ['card', '4242 4242 4242 4242'], ['expiry', '12/30'], ['CVC', '123']])
    const c = parseStepScript('1. log in\n2. type `A` in the Expiry box and `B` in the CVC box')!
    expect(c.items[1].atoms).toMatchObject([{ label: 'Expiry', text: 'A' }, { label: 'CVC', text: 'B' }])
  })
})

describe('keys, drag, double-click, sliders, dates, scrolling until, popups, picks (hard briefs)', () => {
  it('3-hard: whenever, drag with a position, inline rename, keys, scroll until', () => {
    const s = steps('3-hard')
    expect(s.whenever).toHaveLength(1)
    expect(at(s, 2).atoms[0]).toMatchObject({ action: 'whenever', condition: 'popup', then: 'close' })
    expect(at(s, 3).atoms[0]).toMatchObject({ action: 'drag', from: 'Fix login redirect', to: 'Done', position: 'before', ref: 'first card' })
    expect(at(s, 4).atoms[0]).toMatchObject({ action: 'drag', from: 'Mobile navigation', to: 'To do', position: 'bottom' })
    expect(at(s, 5).atoms).toMatchObject([{ action: 'dblclick', label: 'Onboarding emails' }, { action: 'type', text: 'Welcome emails', replace: true }])
    expect(at(s, 6).atoms[0]).toMatchObject({ action: 'pick', label: 'card menu', ordinal: 2, column: 3 })
    expect(at(s, 6).atoms[1]).toMatchObject({ action: 'click', label: 'move to In progress' })
    expect(at(s, 7).atoms.map((a) => a.action)).toEqual(['click', 'click', 'date'])
    expect(at(s, 7).atoms[2]).toMatchObject({ action: 'date', phrase: 'next week' })
    expect(at(s, 9).atoms.map((a) => ('keys' in a ? a.keys : 'label' in a ? a.label : ''))).toEqual(['Control+K', 'Move task', 'Logo refresh', 'Move to To do'])
    expect(at(s, 10).atoms[0]).toMatchObject({ action: 'key', keys: 'Control+K' })
    expect(at(s, 10).atoms[1]).toMatchObject({ action: 'type', text: 'insights', focused: true })
    expect(at(s, 10).atoms[2]).toMatchObject({ action: 'key', keys: 'Enter' })
    expect(at(s, 10).atoms[3]).toMatchObject({ action: 'scrollUntil', text: 'team velocity chart' })
    expect(at(s, 11).atoms[1]).toMatchObject({ action: 'scrollUntil', text: 'Release notes v2.0' })
    // keyboard only: Tab until each is focused, Space to toggle
    expect(at(s, 13).atoms.filter((a) => a.action === 'key').map((a) => (a as { keys: string }).keys)).toEqual(['Tab', 'Space', 'Tab', 'Space'])
    expect(accounted(s)).toEqual([])
  })
  it('2-hard: picks by criterion, ordinal and position; legend toggles; arrow keys; repeats', () => {
    const s = steps('2-hard')
    expect(at(s, 6).atoms[0]).toMatchObject({ action: 'pick', label: 'row', criterion: 'highest', field: 'total' })
    expect(at(s, 7).atoms[1]).toMatchObject({ action: 'pick', criterion: 'highest', find: { colours: ['blue'] } })
    expect(at(s, 8).atoms[0]).toMatchObject({ action: 'pick', criterion: 'lowest', find: { colours: ['green'] } })
    expect(labels(at(s, 9))).toEqual(['Commercial', 'Commercial']) // hide it, then bring it back
    expect(at(s, 10).atoms[0]).toMatchObject({ action: 'click', label: 'gear', find: { role: 'icon' } })
    expect(at(s, 11).atoms[1]).toMatchObject({ action: 'pick', label: 'bar', criterion: 'highest' })
    const next = at(s, 12).atoms
    expect(next).toHaveLength(2) // "twice"
    expect(next[0]).toMatchObject({ action: 'pick', label: 'next region', find: { relation: { rel: 'below', to: 'chart' } } })
    expect(at(s, 14).atoms.map((a) => a.action)).toEqual(['click', 'key', 'key'])
    expect(at(s, 14).atoms[1]).toMatchObject({ keys: 'ArrowRight', repeatUntil: 'Notes' })
    expect(at(s, 14).atoms[2]).toMatchObject({ keys: 'ArrowRight', repeatUntil: 'Sources' })
    expect(at(s, 13).atoms[0]).toMatchObject({ action: 'click', label: 'طاقة' })
    expect(at(s, 13).explain).toBeTruthy()
  })
  it('1-hard: cookie banner rule, keyboard, ordinals, icons, dates', () => {
    const s = steps('1-hard')
    expect(s.whenever.map((w) => [w.condition, w.then])).toEqual([['cookie', 'accept-essential'], ['popup', 'close']])
    expect(labels(at(s, 4))).toEqual(['haircut', "kids' cut", 'continue'])
    expect(at(s, 5).atoms[0]).toMatchObject({ action: 'pick', label: 'heart icon', within: 'second stylist', find: { role: 'icon' } })
    expect(labels(at(s, 6))).toEqual(['Mei', 'continue'])
    expect(at(s, 7).atoms[0]).toMatchObject({ action: 'date', phrase: 'three weeks from today' })
    expect(at(s, 8).atoms[0]).toMatchObject({ action: 'pick', label: 'time', ordinal: 2, within: 'afternoon' })
    expect(at(s, 9).atoms.map((a) => a.action)).toEqual(['click', 'type', 'click'])
    expect(at(s, 12).atoms).toMatchObject([{ action: 'key', keys: 'Tab', repeatUntil: 'continue' }, { action: 'key', keys: 'Enter' }])
    expect(at(s, 13).explain).toMatch(/summary says/)
    expect(accounted(s)).toEqual([])
  })
  it('4-hard: editor replace, slash key, arrow keys, repeated presses, banners', () => {
    const s = steps('4-hard')
    expect(at(s, 2).atoms[0]).toMatchObject({ action: 'whenever', condition: 'banner' })
    expect(at(s, 4).atoms[1]).toMatchObject({ action: 'type', label: 'code editor', text: '{"name": "Grace"}', replace: true })
    expect(at(s, 5).atoms[0]).toMatchObject({ action: 'type', replace: true })
    expect(JSON.parse((at(s, 5).atoms[0] as { text: string }).text)).toEqual({ email: 'grace@example.com', plan: 'team' })
    expect(at(s, 6).atoms.map((a) => a.action)).toEqual(['key', 'type', 'key', 'key'])
    expect(at(s, 6).atoms[0]).toMatchObject({ keys: '/' })
    expect(at(s, 6).atoms[2]).toMatchObject({ keys: 'ArrowDown', repeatUntil: 'Rate limits' })
    expect(at(s, 9).atoms).toHaveLength(3)
    expect(at(s, 10).atoms[0]).toMatchObject({ label: 'Yes, helpful', find: { region: 'bottom' } })
    expect(at(s, 12).atoms[0]).toMatchObject({ action: 'scrollto', label: 'changelog' })
  })
  it('5-hard: slider, sort, ordinal picks, cheapest, quantity, scrolling a row', () => {
    const s = steps('5-hard')
    expect(at(s, 4).atoms[0]).toMatchObject({ action: 'slider', label: 'price', min: 40, max: 80 })
    expect(at(s, 5).atoms[0]).toMatchObject({ action: 'select', label: 'sort', option: 'price high to low' })
    expect(at(s, 6).atoms[0]).toMatchObject({ action: 'pick', label: 'heart icon', within: 'first product in the list' })
    expect(at(s, 7).atoms[0]).toMatchObject({ action: 'pick', label: 'product', ordinal: 2 })
    expect(at(s, 8).atoms.map((a) => ('label' in a ? a.label : ''))).toEqual(['back', 'clear filters', 'Jackets', 'sort'])
    expect(at(s, 9).atoms[0]).toMatchObject({ action: 'pick', label: 'jacket', criterion: 'cheapest' })
    expect(at(s, 10).atoms[0]).toMatchObject({ action: 'hover', label: 'zipper' })
    expect(at(s, 11).atoms.map((a) => ('label' in a ? a.label : ''))).toEqual(['red', 'XL'])
    expect(at(s, 12).atoms.map((a) => ('label' in a ? a.label : ''))).toEqual(['add to cart', 'increase quantity', 'close'])
    expect(at(s, 13).atoms[0]).toMatchObject({ action: 'scrollUntil', text: 'Mini Crossbody', dir: 'right', find: { within: ['customers also bought'] } })
    expect(accounted(s)).toEqual([])
  })
  it('5: out-of-order wording is reordered and the later step is not done twice', () => {
    const s = steps('5-brief')
    expect(at(s, 2).atoms[1]).toMatchObject({ action: 'slider', label: 'max price', value: 130 })
    expect(labels(at(s, 5))).toEqual(['blue']) // "before adding to cart, first pick the blue one": the add-to-cart is step 6's
    expect(at(s, 5).notes.join(' ')).toMatch(/before adding to cart/)
    expect(labels(at(s, 6))).toEqual(['L', 'add to cart'])
    expect(at(s, 7).atoms.pop()).toMatchObject({ label: 'next', find: { role: 'icon', within: ['customers also bought'] } })
  })
})

describe('the other numbered briefs still read the same', () => {
  it('2 (phone atlas)', () => {
    const s = steps('2-brief')
    expect(s.items.map((i) => i.written ?? i.n)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11])
    expect(at(s, 6).atoms[0]).toMatchObject({ action: 'mark', colours: ['blue', 'green', 'orange'] })
    expect(labels(at(s, 11))).toEqual(['details panel', 'Notes · ملاحظات', 'Sources'])
    expect(accounted(s)).toEqual([])
  })
  it('3 and 4 (sprintly, forge)', () => {
    const a = steps('3-brief')
    expect(at(a, 2).atoms[0]).toMatchObject({ action: 'drag', from: 'Fix login redirect', to: 'Done' })
    expect(at(a, 3).atoms[0]).toMatchObject({ action: 'dblclick' })
    expect(at(a, 4).atoms.map((x) => x.action)).toEqual(['key', 'type', 'key'])
    expect(at(a, 5).atoms[0]).toMatchObject({ action: 'scrollUntil', text: 'team velocity chart' })
    expect(accounted(a)).toEqual([])
    const b = steps('4-brief')
    expect(at(b, 3).atoms[0]).toMatchObject({ action: 'type', label: 'plan', text: 'team', replace: true })
    expect(labels(at(b, 4))).toEqual(['SDK installation', 'cURL', 'Node.js', 'Python', 'copy snippet'])
    expect(accounted(b)).toEqual([])
  })
})

describe('abstract goals are never silently dropped', () => {
  it('a goal step carries its words; clicks around it are still read', () => {
    const s = steps('1-abstract')
    expect(s.items[0].login).toBe(true)
    expect(at(s, 2).goal).toMatch(/book a colour appointment/)
    expect(labels(at(s, 3))).toEqual(['confirm booking', 'close'])
    const a2 = steps('2-abstract')
    expect(at(a2, 3).goal).toBeTruthy()
    expect(at(a2, 4).atoms[0]).toMatchObject({ action: 'scroll', dir: 'up' })
    expect(at(steps('3-abstract'), 2).goal).toMatch(/overdue/)
    expect(at(steps('4-abstract'), 3).goal).toMatch(/error handling/)
    expect(at(steps('5-abstract'), 2).goal).toMatch(/gift under/)
  })
  it('a list with a step nobody can read keeps it as "not understood"', () => {
    const s = parseStepScript('1. log in\n2. click Reports\n3. frobnicate the widgets')!
    expect(at(s, 3).atoms).toHaveLength(0)
    expect(at(s, 3).unread).toEqual(['frobnicate the widgets'])
    const t = parseStepScript('1. click Reports and flibber the zorp\n2. click Customers')!
    expect(t.items[0].atoms).toHaveLength(1)
    expect(t.items[0].unread).toEqual(['flibber the zorp'])
  })
})

// ----------------------------------------------------------------------------------------------------- reporting

const MAP: AppMap = { version: 1, startUrl: 'http://x.test/', host: 'x.test', scoutedAt: '', pages: [], login: { detected: false, otpLikely: false }, sensitiveSelectors: [] }
const part = (done: boolean, changed = true) => ({ done, verified: done, changed })
const result = (item: ScriptItem, status: ItemResult['status'], parts: ItemResult['parts'], extra: Partial<ItemResult> = {}): ItemResult => ({ item, steps: status === 'not-done' ? [] : [{ kind: 'click', label: 'x', focus: 'target' }], areaText: '', picks: [], skipped: [], seen: [], parts, status, ...extra })

describe('the run notes and the narration only tell what was done', () => {
  const script = parseStepScript('1. click Reports\n2. click Nothing here\n3. frobnicate the widgets\n4. click Customers')!
  const [i1, i2, i3, i4] = script.items
  const outcome: ScriptOutcome = {
    results: [
      result(i1, 'done', [part(true)]),
      result(i2, 'not-done', [part(false)], { skipped: [{ what: 'clicking "Nothing here"', why: 'no control called that was found' }] }),
      result(i3, 'not-done', [], { skipped: [{ what: '"frobnicate the widgets"', why: 'no action understood in "frobnicate the widgets"' }] }),
      result(i4, 'done', [part(true, false)], { unchanged: true })
    ],
    actions: 2,
    skipped: [
      { n: 2, said: i2.said, what: 'clicking "Nothing here"', why: 'no control called that was found' },
      { n: 3, said: i3.said, what: '"frobnicate the widgets"', why: 'no action understood in "frobnicate the widgets"' }
    ],
    stats: { total: 4, done: 2, partial: 0, notDone: 2, narrated: 0, unchanged: 1, effective: 1 },
    mostlyUnchanged: true
  }
  const plan = scriptPlan({ script, outcome, map: MAP, startUrl: 'http://x.test/', beganAt: 'http://x.test/', hasVault: false, secrets: [] })
  it('does not say "exactly as written" when steps were not done, and lists every one', () => {
    expect(plan.notes[0]).not.toMatch(/exactly as written/)
    expect(plan.notes[0]).toMatch(/2 were done as written/)
    expect(plan.notes[0]).toMatch(/2 could not be done at all/)
    const all = plan.notes.join('\n')
    expect(all).toMatch(/Step 2 was not fully done: clicking "Nothing here" was skipped/)
    expect(all).toMatch(/Step 3 was not fully done: "frobnicate the widgets" was skipped \(no action understood/)
    expect(all).toMatch(/Step 2 \(.*\) was not done at all/)
    expect(all).toMatch(/Step 4: the screen did not visibly change/)
  })
  it('says the film is only partly what was asked when most steps changed nothing', () => {
    expect(plan.notes.join('\n')).toMatch(/Only 1 of 4 steps changed the page as written/)
  })
  it('gives no beat to a step that was not done, and does not hold a step that changed nothing', () => {
    expect(plan.beats).toHaveLength(2)
    expect(plan.beats.map((b) => b.facts.join(' ')).join(' ')).not.toMatch(/Nothing here|frobnicate/)
    const last = plan.playbook.steps.filter((s) => s.beat === 1)
    expect(last.every((s) => (s.holdMs ?? 0) <= 1500)).toBe(true)
  })
  it('takes the narration facts only from parts that were performed and verified', () => {
    const s2 = parseStepScript('1. log in\n2. click Reports and press Ctrl+K')!
    const item = s2.items[1]
    expect(item.atoms.map((a) => a.action)).toEqual(['click', 'key'])
    const out: ScriptOutcome = { results: [result(item, 'partial', [part(true), part(false)], { skipped: [{ what: 'press Ctrl+K', why: 'skipped: not supported yet' }] })], actions: 1, skipped: [{ n: 1, said: item.said, what: 'press Ctrl+K', why: 'skipped: not supported yet' }], stats: { total: 1, done: 0, partial: 1, notDone: 0, narrated: 0, unchanged: 0, effective: 0 }, mostlyUnchanged: true }
    const p = scriptPlan({ script: s2, outcome: out, map: MAP, startUrl: 'http://x.test/', beganAt: 'http://x.test/', hasVault: false, secrets: [] })
    const facts = p.beats[0].facts.join('\n')
    expect(facts).toMatch(/Clicks "Reports"/)
    expect(facts).not.toMatch(/Uses the keyboard/)
    expect(facts).toMatch(/NOT SHOWN: press Ctrl\+K/)
  })
})
