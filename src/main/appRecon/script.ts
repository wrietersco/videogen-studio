import type { Page } from 'puppeteer-core'
import type { AppMap, FindSpec, Playbook, Step } from '@shared/appRecon'
import { scrubText } from './detect'
import { settle } from './explore'
import type { Plan, BeatFacts } from './planner'
import { PlaybookSchemaCheck } from './schemaCheck'
import type { PolicyGate } from './policy'
import { findElement, scrollArea } from './resolve'
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

export interface ItemResult {
  item: ScriptItem
  /** the steps to record, without ids */
  steps: Array<Omit<Step, 'id' | 'beat'>>
  /** the text of the area the step ends on (a scrolled pane, or the page) */
  areaText: string
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
    failure: `Step ${item.n} ("${item.said.slice(0, 90)}") could not be done, so no video was made: ${why} Reword the step with the name the page shows, or use Take over to get to the right place first.`
  })

  for (const item of inp.script.items) {
    if (inp.signal?.aborted) return { results, actions, failure: 'Cancelled' }
    const steps: ItemResult['steps'] = []
    let areaText = ''
    if (item.login) {
      results.push({ item, steps, areaText })
      continue
    }
    inp.log(`  step ${item.n}: ${item.said}`)
    for (const atom of item.atoms as Atom[]) {
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
    if (steps.length && !steps.every((s) => s.kind === 'scroll')) steps.push({ kind: 'wait', intent: 'inspect', label: 'result', focus: 'page' })
    results.push({ item, steps, areaText })
  }
  return { results, actions }
}

/** a short label for the step's chapter marker */
function chapterOf(item: ScriptItem): string {
  const a = item.atoms.find((x) => x.action !== 'scroll')
  const base = a ? (a.action === 'type' ? `Search ${a.text}` : a.label) : item.explain ? 'Explained' : `Step ${item.n}`
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
  const notes: string[] = [`The ${inp.outcome.results.filter((r) => !r.item.login).length} steps you wrote are done exactly as written and in order; nothing else was explored.`]
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
    for (const st of r.steps) steps.push({ ...st, id: id(), beat })
    if (!steps.some((x) => x.beat === beat)) steps.push({ id: id(), beat, kind: 'wait', focus: 'page' })
    const facts: string[] = [`The person's own instruction for this step: "${s(r.item.said)}"`]
    for (const a of r.item.atoms) {
      if (a.action === 'click') facts.push(`Clicks "${s(a.label)}"${where(a.find) ? ` (${where(a.find)})` : ''}`)
      else if (a.action === 'type') facts.push(`Types "${s(a.text)}" into the ${s(a.label)} box`)
      else facts.push(`Scrolls ${a.dir}${where(a.find) ? ` (${where(a.find)})` : ''} through the area`)
    }
    if (r.item.explain) facts.push(`The video must make this clear to the viewer, in the person's words: ${s(r.item.explain)}`)
    if (r.item.explain && r.areaText) facts.push(`What that area of the screen says (explain from this, do not invent anything beyond it): ${s(r.areaText).slice(0, 1500)}`)
    for (const n of r.item.notes) facts.push(`Also in the step: ${s(n)}`)
    const line = plainStep(r.item)
    beats.push({ beat, kind: 'step', chapter: chapterOf(r.item), facts, fallback: r.item.explain ? `${line.replace(/\.$/, '')}. Take a moment to read what this area lists.` : line, launchFallback: line, long: !!r.item.explain })
    beat++
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
