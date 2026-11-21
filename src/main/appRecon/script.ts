import type { Page } from 'puppeteer-core'
import type { AppMap, FindSpec, Playbook, Step } from '@shared/appRecon'
import { scrubText } from './detect'
import { openPage, settle } from './explore'
import type { Plan, BeatFacts } from './planner'
import { PlaybookSchemaCheck } from './schemaCheck'
import type { PolicyGate } from './policy'
import { findElement, scrollArea } from './resolve'
import { chooseNative, matchOption, readChoices, shortName } from './pick'
import { plainStep, type Atom, type ScriptItem, type StepScript } from './stepScript'

/**
 * Carries out the steps a person wrote, exactly and in order, on the live app.
 *
 * This is not exploring. Nothing is visited, clicked or typed that the person did
 * not write, and when a step cannot be done the run stops here, before anything
 * is recorded or paid for, and says which step and why. What is learned while
 * doing the steps (the control each one meant, and the text of the area to be
 * explained) becomes the playbook and the narration facts.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** where the page is, without the query (it can hold a token) */
const safeUrl = (page: Page): string => {
  try {
    const u = new URL(page.url())
    return `${u.origin}${u.pathname}${u.hash}`
  } catch {
    return 'unknown'
  }
}

export interface ItemResult {
  item: ScriptItem
  /** the steps to record, without ids */
  steps: Array<Omit<Step, 'id' | 'beat'>>
  /** the text of the area the step ends on (a scrolled pane, or the page) */
  areaText: string
  /** the entries chosen in dropdowns, in order, with the page's text right after each choice */
  picks: Array<{ dropdown: string; option: string; areaText: string }>
  /** the page's text just before the first choice (what the step's own beat is about) */
  beforeText?: string
}

export interface ScriptOutcome {
  results: ItemResult[]
  actions: number
  failure?: string
}

export interface ScriptInput {
  page: Page
  gate: PolicyGate
  script: StepScript
  log: (m: string) => void
  signal?: AbortSignal
}

const where = (f: FindSpec): string => [f.region ? `on the ${f.region}` : '', f.within?.length ? `in the ${f.within.join('/')} area` : '', f.relation ? `${f.relation.rel.replace('Of', ' of')} "${f.relation.to}"` : ''].filter(Boolean).join(', ')

export async function performScript(inp: ScriptInput): Promise<ScriptOutcome> {
  const { page, gate } = inp
  const results: ItemResult[] = []
  let actions = 0
  let last: string | undefined
  const fail = (item: ScriptItem, why: string): ScriptOutcome => ({
    results,
    actions,
    failure: `Step ${item.n} ("${item.said.slice(0, 90)}") could not be done, so no video was made: ${why} The page it was on: ${safeUrl(page)}. Reword the step with the name the page shows, check the address, or use Take over to get to the right place first.`
  })

  for (const item of inp.script.items) {
    if (inp.signal?.aborted) return { results, actions, failure: 'Cancelled' }
    const steps: ItemResult['steps'] = []
    const picks: ItemResult['picks'] = []
    let beforeText: string | undefined
    let areaText = ''
    if (item.login) {
      results.push({ item, steps, areaText, picks })
      continue
    }
    inp.log(`  step ${item.n}: ${item.said}`)
    for (const atom of item.atoms as Atom[]) {
      if (atom.action === 'open') {
        // the whole address is opened, #fragment and all: on many apps it is what picks the view the page opens on
        if (!gate.hostAllowed(atom.url)) return fail(item, `${atom.url} is outside the allowed sites.`)
        if (!(await openPage(page, atom.url, 30000).catch(() => false))) return fail(item, `${atom.url} would not open.`)
        await sleep(400)
        // an address that opens the site's "not found" page is a wrong address, not a page to look for controls on
        const notFound = await page.evaluate(() => {
          const title = document.title ?? ''
          const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()
          return /\b404\b|not found|page (?:does not|doesn['’]t) exist/i.test(title) || (body.length < 400 && /\b404\b|page not found|not found/i.test(body)) ? (title || body).slice(0, 80) : ''
        }).catch(() => '')
        if (notFound) return fail(item, `${atom.url} opened a "not found" page ("${notFound}"), so the address is probably wrong.`)
        steps.push({ kind: 'goto', url: atom.url, intent: 'navigate', label: 'open page', focus: 'page' })
        actions++
        inp.log(`    opened ${atom.url} (now at ${page.url()})`)
        continue
      }
      if (atom.action === 'select') {
        const { found, miss } = await findElement(page, atom.find)
        if (!found) {
          const near = miss?.closest.filter(Boolean).slice(0, 5)
          return fail(item, `no dropdown called "${atom.label}"${where(atom.find) ? ` (${where(atom.find)})` : ''} was found on the page.${near?.length ? ` The closest things on the page are: ${near.map((n) => `"${n}"`).join(', ')}.` : ''}`)
        }
        const choices = await readChoices(page, found.selector)
        if (beforeText === undefined) beforeText = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500)).catch(() => '')
        let chosen = atom.option
        if (choices.native) {
          const at = matchOption(choices.entries, atom.option)
          if (at < 0) return fail(item, `the dropdown "${found.label || atom.label}" has no entry called "${atom.option}". It lists, for example: ${choices.entries.slice(0, 6).map((e) => `"${e}"`).join(', ')}.`)
          chosen = choices.entries[at]
          const verdict = gate.checkClick({ label: chosen, kind: 'button' })
          if (!verdict.allow) return fail(item, `your own rules do not allow it (${verdict.reason}).`)
          await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'nearest' }), found.selector)
          await chooseNative(page, found.selector, at)
        } else {
          // a drawn dropdown: open it, then press the entry that has the name
          const r = found.rect
          await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2)
          await sleep(400)
          const entry = await findElement(page, { target: atom.option, kind: 'click', within: ['suggestion'] }, 4000)
          if (!entry.found) return fail(item, `the dropdown "${found.label || atom.label}" has no entry called "${atom.option}".`)
          const verdict = gate.checkClick({ label: entry.found.label || atom.option, kind: 'button' })
          if (!verdict.allow) return fail(item, `your own rules do not allow it (${verdict.reason}).`)
          await page.mouse.click(entry.found.rect.x + entry.found.rect.w / 2, entry.found.rect.y + entry.found.rect.h / 2)
          chosen = entry.found.label || atom.option
        }
        await settle(page)
        await sleep(600)
        steps.push({ kind: 'select', selector: found.selector, label: atom.label, text: atom.option, find: atom.find, focus: 'page' })
        // each choice is a result of its own: the viewer is given time to see what the page made of it
        steps.push({ kind: 'wait', intent: 'inspect', label: 'result', focus: 'page' })
        picks.push({ dropdown: atom.label, option: chosen, areaText: await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500)).catch(() => '') })
        inp.log(`    chose "${chosen}" in "${found.label || atom.label}"`)
        actions++
        last = found.selector
        continue
      }
      if (atom.action === 'scroll') {
        const out = await scrollArea(page, atom.find, atom.dir, { near: last, budgetMs: 0, instant: true })
        actions++
        areaText = out.text || areaText
        steps.push({ kind: 'scroll', text: atom.dir, label: 'scroll', find: atom.find, focus: 'page' })
        inp.log(`    scrolled ${atom.dir}${where(atom.find) ? ` (${where(atom.find)})` : ''}${out.moved ? '' : ' (nothing moved: it already fit)'}`)
        await sleep(300)
        continue
      }
      const { found, miss } = await findElement(page, atom.find)
      if (!found) {
        const near = miss?.closest.filter(Boolean).slice(0, 5)
        return fail(item, `no ${atom.action === 'type' ? 'box' : 'control'} called "${atom.label}"${where(atom.find) ? ` (${where(atom.find)})` : ''} was found on the page.${near?.length ? ` The closest things on the page are: ${near.map((n) => `"${n}"`).join(', ')}.` : ''}`)
      }
      await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'nearest' }), found.selector)
      await sleep(120)
      const r = await page.evaluate((sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null }, found.selector)
      if (!r) return fail(item, `"${atom.label}" disappeared before it could be used.`)
      if (atom.action === 'click') {
        const verdict = gate.checkClick({ label: found.label || atom.label, kind: 'button' })
        if (!verdict.allow) return fail(item, `your own rules do not allow it (${verdict.reason}).`)
        await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
        await sleep(80)
        const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 2500 }).catch(() => null)
        await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2)
        await Promise.race([nav, sleep(900)])
        await settle(page)
        await sleep(300)
        steps.push({ kind: 'click', selector: found.selector, label: atom.label, find: atom.find, focus: 'target' })
        inp.log(`    clicked "${found.label || atom.label}"`)
      } else {
        const typed = atom as Extract<Atom, { action: 'type' }>
        await page.mouse.click(r.x + Math.min(r.w * 0.5, 120), r.y + r.h / 2)
        await page.evaluate((sel) => { const e = document.querySelector(sel) as HTMLInputElement | null; if (e && typeof e.select === 'function') e.select() }, found.selector)
        await page.keyboard.type(typed.text, { delay: 25 })
        // a search box shows its suggestions a moment later
        await sleep(900)
        await settle(page)
        steps.push({ kind: 'type', selector: found.selector, label: atom.label, text: typed.text, find: atom.find, focus: 'target' })
        inp.log(`    typed "${typed.text}" into "${found.label || atom.label}"`)
      }
      actions++
      last = found.selector
    }
    if (!areaText) areaText = await page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500)).catch(() => '')
    const lastStep = steps[steps.length - 1]
    if (steps.length && !steps.every((s) => s.kind === 'scroll') && !(lastStep.kind === 'wait' && lastStep.intent === 'inspect')) steps.push({ kind: 'wait', intent: 'inspect', label: 'result', focus: 'page' })
    results.push({ item, steps, areaText, picks, beforeText })
  }
  return { results, actions }
}

/** a short label for the step's chapter marker */
function chapterOf(item: ScriptItem): string {
  const a = item.atoms.find((x) => x.action !== 'scroll' && x.action !== 'select') // each choice in a dropdown has its own beat
  const base = a ? (a.action === 'type' ? `Search ${a.text}` : a.action === 'open' ? 'Opening page' : a.label) : item.explain ? 'Explained' : `Step ${item.n}`
  const w = base.replace(/[^\p{L}\p{N} '&-]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ')
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : `Step ${item.n}`
}

export interface ScriptPlanInput {
  script: StepScript
  outcome: ScriptOutcome
  map: AppMap
  startUrl: string
  /** the address the steps began on (after signing in) */
  beganAt: string
  /** the recording signs in on camera */
  hasVault: boolean
  secrets: string[]
}

/** the playbook and the narration facts for the steps, one beat for each step the person wrote */
export function scriptPlan(inp: ScriptPlanInput): Plan {
  const s = (t: string) => scrubText(t, { values: inp.secrets })
  const steps: Step[] = []
  const beats: BeatFacts[] = []
  const notes: string[] = [`Your ${inp.outcome.results.length} steps are done exactly as written and in order${inp.outcome.results.some((r) => r.item.login) ? ' (the log-in step is done by the sign-in you set up)' : ''}; nothing else was explored.`]
  let sid = 0
  const id = () => `s${++sid}`
  const L = inp.map.login
  const signIn = inp.hasVault && L.detected && !!L.usernameSelector && !!L.passwordSelector && !!L.submitSelector
  let beat = 0
  if (signIn) {
    const loginUrl = L.pageUrl ?? inp.startUrl
    steps.push({ id: id(), beat, kind: 'goto', url: loginUrl, selector: L.usernameSelector, intent: 'navigate', focus: 'form' })
    steps.push({ id: id(), beat, kind: 'type', selector: L.usernameSelector, label: 'username', text: '{{secret:username}}', focus: 'target' })
    steps.push({ id: id(), beat, kind: 'type', selector: L.passwordSelector, label: 'password', text: '{{secret:password}}', focus: 'target' })
    steps.push({ id: id(), beat, kind: 'click', selector: L.submitSelector, label: L.submitLabel, intent: 'login-submit', expect: { selectorGone: L.passwordSelector }, focus: 'banner' })
    // the steps were done from this page: the recording opens it again after the sign-in
    if (inp.beganAt && inp.beganAt !== loginUrl) steps.push({ id: id(), beat, kind: 'goto', url: inp.beganAt, intent: 'navigate', focus: 'page' })
    beats.push({ beat, kind: 'login', chapter: 'Signing in', facts: ['The person signs in with a username and a blurred password'], fallback: 'First we sign in. The password is blurred on screen, because secrets should never be shown.', launchFallback: 'Sign in with your account to get started. Your password stays hidden.' })
    beat++
  } else if (inp.script.items.some((i) => i.login)) {
    notes.push('Step 1 (signing in) was done before recording started, so it is not shown on camera.')
  }
  const first = beat
  for (const r of inp.outcome.results) {
    if (r.item.login) continue
    // each entry chosen in a dropdown starts a beat of its own, so the page is shown (and explained) for every choice
    const groups: Array<{ steps: typeof r.steps; pick?: ItemResult['picks'][number] }> = [{ steps: [] }]
    let pi = 0
    for (const st of r.steps) {
      if (st.kind === 'select') groups.push({ steps: [], pick: r.picks[pi++] })
      groups[groups.length - 1].steps.push(st)
    }
    const hasMain = !!r.item.explain || r.item.atoms.some((a) => a.action !== 'select') || r.item.notes.length > 0
    if (groups.length > 1 && !groups[0].steps.length && !hasMain) groups.shift()
    for (const g of groups) {
      for (const st of g.steps) steps.push({ ...st, id: id(), beat })
      if (!steps.some((x) => x.beat === beat)) steps.push({ id: id(), beat, kind: 'wait', intent: groups.length > 1 ? 'inspect' : undefined, focus: 'page' })
      const lastOf = steps[steps.length - 1]
      if (groups.length > 1 && !g.pick && steps.some((x) => x.beat === beat && x.kind !== 'wait') && !(lastOf.kind === 'wait' && lastOf.intent === 'inspect')) steps.push({ id: id(), beat, kind: 'wait', intent: 'inspect', focus: 'page' })
      if (g.pick) {
        const option = s(g.pick.option)
        const facts: string[] = [`The person switches the "${s(g.pick.dropdown)}" dropdown to "${option}"`, `The page now shows ${option}`]
        if (r.item.explain) facts.push(`Keep to what the person wants made clear, in their words: ${s(r.item.explain)}`)
        if (g.pick.areaText) facts.push(`What the screen says now (explain from this, do not invent anything beyond it): ${s(g.pick.areaText).slice(0, 1500)}`)
        const name = shortName(option).split(/\s+/).slice(0, 4).join(' ')
        beats.push({ beat, kind: 'step', chapter: `Switch to ${name}`, facts, fallback: `Now ${name}. Take a moment to read what this shows.`, launchFallback: `Now ${name}.`, long: !!r.item.explain })
      } else {
        const facts: string[] = [`The person's own instruction for this step: "${s(r.item.said)}"`]
        for (const a of r.item.atoms) {
          if (a.action === 'select') continue // each choice has its beat below
          if (a.action === 'open') facts.push('Opens the page the person named')
          else if (a.action === 'click') facts.push(`Clicks "${s(a.label)}"${where(a.find) ? ` (${where(a.find)})` : ''}`)
          else if (a.action === 'type') facts.push(`Types "${s(a.text)}" into the ${s(a.label)} box`)
          else facts.push(`Scrolls ${a.dir}${where(a.find) ? ` (${where(a.find)})` : ''} through the area`)
        }
        if (r.item.explain) facts.push(`The video must make this clear to the viewer, in the person's words: ${s(r.item.explain)}`)
        const text = groups.length > 1 ? (r.beforeText ?? r.areaText) : r.areaText
        if (r.item.explain && text) facts.push(`What that area of the screen says (explain from this, do not invent anything beyond it): ${s(text).slice(0, 1500)}`)
        for (const n of r.item.notes) facts.push(`Also in the step: ${s(n)}`)
        const line = plainStep(r.item)
        beats.push({ beat, kind: 'step', chapter: chapterOf(r.item), facts, fallback: r.item.explain ? `${line.replace(/\.$/, '')}. Take a moment to read what this area lists.` : line, launchFallback: line, long: !!r.item.explain })
      }
      beat++
    }
  }
  if (beat === first && !signIn) {
    steps.push({ id: id(), beat: 0, kind: 'goto', url: inp.beganAt || inp.startUrl, intent: 'navigate', focus: 'page' })
    beats.push({ beat: 0, kind: 'page', chapter: 'Opening page', facts: ['The app opens'], fallback: 'This is where the app opens.' })
    beat++
  }
  // without an on-camera sign-in the film starts on the page the steps began on
  const startUrl = signIn ? (L.pageUrl ?? inp.startUrl) : (inp.beganAt || inp.startUrl)
  const playbook: Playbook = { version: 1, title: `Steps: ${inp.map.host}`, startUrl, steps }
  PlaybookSchemaCheck(playbook)
  return { playbook, beats, loginFocus: false, notes }
}
