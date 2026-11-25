/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import sharp from 'sharp'
import type { Page } from 'puppeteer-core'
import type { AppMap, FindSpec, Playbook, Rect, Step } from '@shared/appRecon'
import { scrubText } from './detect'
import { openPage, settle } from './explore'
import type { Plan, BeatFacts } from './planner'
import { PlaybookSchemaCheck } from './schemaCheck'
import type { PolicyGate } from './policy'
import { findElement, scrollArea, type Found } from './resolve'
import { chooseNative, matchOption, readChoices, shortName } from './pick'
import { findMark, hoverText, newTexts, snapshotTexts } from './marks'
import { revealHidden, scrollToSection } from './sections'
import type { Atom } from '@shared/appRecon'
import { plainStep, type ScriptItem, type StepScript } from './stepScript'
import { execNewAtom, isNewAtom } from './atomExec'

/**
 * Carries out the steps a person wrote, exactly and in order, on the live app.
 *
 * This is not exploring. Nothing is visited, clicked or typed that the person did
 * not write. What is learned while doing the steps (the control each one meant,
 * the text of the area to be explained, what a tooltip said) becomes the playbook
 * and the narration facts.
 *
 * A step that cannot be done is SKIPPED, never allowed to stop the film: the step
 * is looked for again with the page studied more closely (hidden panels opened,
 * looser names, a model looking at the screen), and when it still cannot be done
 * it is left out, the narration is told not to claim it, and the run says so.
 * A step that was done but changed nothing on screen is retried the same way, so a
 * film never stays on one screen while the voice describes others.
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

export interface SkippedPart {
  /** what could not be done, in the person's words */
  what: string
  why: string
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
  /** the parts of the step that could not be done (left out of the film) */
  skipped: SkippedPart[]
  /** what the page showed while the step was done (a tooltip's words, what a click opened), for the narration */
  seen: string[]
  /** the step was done but the screen looks the same as before it (said so to the narration, and in the run's notes) */
  unchanged?: boolean
  /** what became of each small action of the step, in the order of `item.atoms` */
  parts: PartResult[]
  /**
   * done: every part was performed and verified; partial: some were; not-done: none (the step is listed in the run notes);
   * narrated: the step only says something (nothing was to be done on the page); login: the engine's own sign-in
   */
  status: 'done' | 'partial' | 'not-done' | 'narrated' | 'login'
}

export interface PartResult {
  /** it was performed */
  done: boolean
  /** the page showed the expected effect (an action that was performed but not verified is reported as skipped, never as done) */
  verified: boolean
  /** the screen changed because of it */
  changed: boolean
}

export interface ScriptOutcome {
  results: ItemResult[]
  actions: number
  /** how the steps went: the film is only `done` when most of them changed the page as written */
  stats?: { total: number; done: number; partial: number; notDone: number; narrated: number; unchanged: number; effective: number }
  /** most of the steps did nothing visible: the run is partial, not done */
  mostlyUnchanged?: boolean
  failure?: string
  /** every part left out, with the step it belonged to */
  skipped: Array<SkippedPart & { n: number; said: string }>
}

/** a model that looks at the screen: told what the step says and the numbered controls, it names the one meant (null: none) */
export type VisionPick = (req: { shot: Buffer; said: string; candidates: Array<{ i: number; text: string; kind: string; rect: Rect }> }) => Promise<number | null>

export interface ScriptInput {
  page: Page
  gate: PolicyGate
  script: StepScript
  log: (m: string) => void
  signal?: AbortSignal
  vision?: VisionPick
  /** a step that is a goal ("show how a customer books ...") has no clicks yet: this makes them from the page (null: it cannot) */
  planGoal?: (req: { item: ScriptItem; page: Page; log: (m: string) => void }) => Promise<Atom[] | null>
}

const where = (f: FindSpec): string => [f.region ? `on the ${f.region}` : '', f.within?.length ? `in the ${f.within.join('/')} area` : '', f.relation ? `${f.relation.rel.replace('Of', ' of')} "${f.relation.to}"` : ''].filter(Boolean).join(', ')
/** the number the person wrote for the step */
const numberOf = (item: ScriptItem): number => item.written ?? item.n

// ---------------------------------------------------------------- is the screen different?

interface View {
  url: string
  y: number
  scrolled: number
  text: string
  thumb: Buffer | null
}

async function viewOf(page: Page): Promise<View> {
  const m = await page
    .evaluate(() => {
      let sc = 0
      for (const e of Array.from(document.querySelectorAll('*')).slice(0, 4000)) if (e !== document.scrollingElement && (e as HTMLElement).scrollTop > 0) sc += (e as HTMLElement).scrollTop
      const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()
      // the whole text counts (a changed readout far down the page is a change), as a short fingerprint
      let h = 5381
      for (let i = 0; i < body.length; i++) h = ((h << 5) + h + body.charCodeAt(i)) | 0
      return { url: location.pathname + location.search + location.hash, y: scrollY, sc: Math.round(sc), text: `${body.length}:${h}` }
    })
    .catch(() => ({ url: '', y: 0, sc: 0, text: '' }))
  let thumb: Buffer | null = null
  try {
    const png = (await page.screenshot({ type: 'png' })) as Uint8Array
    thumb = await sharp(Buffer.from(png)).resize(24, 40, { fit: 'fill' }).greyscale().raw().toBuffer()
  } catch {
    thumb = null
  }
  return { url: m.url, y: m.y, scrolled: m.sc, text: m.text, thumb }
}

/** the two screens are the same one: same address, same place on the page, same words, same picture */
export function sameView(a: View, b: View): boolean {
  if (a.url !== b.url || Math.abs(a.y - b.y) >= 8 || Math.abs(a.scrolled - b.scrolled) >= 8 || a.text !== b.text) return false
  if (!a.thumb || !b.thumb || a.thumb.length !== b.thumb.length) return true
  let d = 0
  for (let i = 0; i < a.thumb.length; i++) d += Math.abs(a.thumb[i] - b.thumb[i])
  return d / a.thumb.length < 1.5
}

// ---------------------------------------------------------------- finding what a step means

export interface Located {
  found: Found | null
  miss?: { closest: string[] }
  /** steps that had to be done to bring the control into reach (a folded panel opened) */
  prep: Array<Omit<Step, 'id' | 'beat'>>
}

/** a model looks at the screen for the control the step means */
async function visionFind(page: Page, find: FindSpec, said: string, vision: VisionPick): Promise<Found | null> {
  const cands = await page
    .evaluate(() => {
      const out: Array<{ i: number; text: string; kind: string; rect: { x: number; y: number; w: number; h: number }; path: string }> = []
      const path = (el: Element): string => {
        const parts: string[] = []
        for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
          if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break }
          const sibs = Array.from(n.parentElement?.children ?? [])
          parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
        }
        return parts.join(' > ')
      }
      const els = Array.from(document.querySelectorAll('a,button,[role=button],[role=tab],[role=menuitem],summary,input:not([type=hidden]),select,[onclick],[tabindex]:not([tabindex="-1"])'))
      for (const el of els) {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
        const text = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).value || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 70)
        out.push({ i: out.length, text, kind: el.getAttribute('role') ?? el.tagName.toLowerCase(), rect: { x: r.x, y: r.y + scrollY, w: r.width, h: r.height }, path: path(el) })
        if (out.length >= 90) break
      }
      return out
    })
    .catch(() => [])
  if (!cands.length) return null
  let shot: Buffer
  try {
    shot = Buffer.from((await page.screenshot({ type: 'jpeg', quality: 55 })) as Uint8Array)
  } catch {
    return null
  }
  const pick = await vision({ shot, said, candidates: cands.map((c) => ({ i: c.i, text: c.text, kind: c.kind, rect: c.rect })) }).catch(() => null)
  const c = pick === null || pick === undefined ? undefined : cands.find((x) => x.i === pick)
  if (!c) return null
  const r = await page.evaluate((sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null }, c.path).catch(() => null)
  return r ? { selector: c.path, rect: r, label: c.text || find.target, score: 40 } : null
}

/** finds the control a step means: by its name, then looser, then behind a folded panel, then by a model looking at the screen */
async function locateControl(page: Page, atom: { find: FindSpec; label: string }, o: { relaxed: boolean; said: string; vision?: VisionPick; gate: PolicyGate; log: (m: string) => void }): Promise<Located> {
  const prep: Located['prep'] = []
  let { found, miss } = await findElement(page, atom.find, o.relaxed ? 2500 : 7000)
  if (found) return { found, prep }
  // a panel a phone keeps folded away, or a closed <details>: open it, then look again
  const toggle = await revealHidden(page, atom.find)
  if (toggle && toggle !== 'opened') {
    const verdict = o.gate.checkClick({ label: toggle.label, kind: 'button' })
    if (verdict.allow) {
      await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'nearest' }), toggle.selector)
      await sleep(150)
      const b = await page.evaluate((sel) => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }, toggle.selector)
      if (b) {
        await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2)
        await settle(page)
        await sleep(400)
        prep.push({ kind: 'click', selector: toggle.selector, label: toggle.label || 'open the panel', focus: 'target' })
        o.log(`    opened "${toggle.label || 'a folded panel'}" to reach "${atom.label}"`)
      }
    }
  }
  if (toggle) {
    ;({ found, miss } = await findElement(page, atom.find, 2500))
    if (found) return { found, prep }
  }
  // looser: the words alone, wherever on the page (the step's idea of where it sits may not hold on this layout)
  const loose: FindSpec = { target: atom.find.target, kind: atom.find.kind, ...(atom.find.role ? { role: atom.find.role } : {}) }
  const l = await findElement(page, loose, 1500, o.relaxed ? 28 : 36)
  if (l.found) return { found: l.found, prep }
  if (o.vision) {
    const v = await visionFind(page, atom.find, o.said, o.vision)
    if (v) {
      o.log(`    "${atom.label}" was found by looking at the screen: "${v.label}"`)
      return { found: v, prep }
    }
  }
  return { found: null, miss: miss ?? l.miss, prep }
}

type Failure = { failure: string }

// ---------------------------------------------------------------- doing the steps

/** what one part of a step did */
interface AtomRun {
  steps: ItemResult['steps']
  picks: ItemResult['picks']
  skipped: SkippedPart[]
  seen: string[]
  did: number
  /** the screen looked different afterwards (a click that changes nothing at all is suspect) */
  changed: boolean
  /** what was done showed its expected effect (until the executors report it, a performed action counts as verified) */
  verified?: boolean
}

/** one pass over the parts of a step (a part that was not tried is a hole in `per`) */
interface Run {
  per: AtomRun[]
  areaText: string
  beforeText?: string
  last?: string
}

const flat = (per: AtomRun[]): AtomRun => ({
  steps: per.flatMap((p) => p?.steps ?? []),
  picks: per.flatMap((p) => p?.picks ?? []),
  skipped: per.flatMap((p) => p?.skipped ?? []),
  seen: per.flatMap((p) => p?.seen ?? []),
  did: per.reduce((n, p) => n + (p?.did ?? 0), 0),
  changed: per.some((p) => p?.changed)
})

export async function performScript(inp: ScriptInput): Promise<ScriptOutcome> {
  const { page, gate } = inp
  const results: ItemResult[] = []
  const skippedAll: ScriptOutcome['skipped'] = []
  let actions = 0
  let last: string | undefined
  const fail = (item: ScriptItem, why: string): ScriptOutcome => ({
    results,
    actions,
    skipped: skippedAll,
    failure: `Step ${numberOf(item)} ("${item.said.slice(0, 90)}") could not be done, so no video was made: ${why} The page it was on: ${safeUrl(page)}. Check the address, or use Take over to get to the right place first.`
  })
  const textOf = (): Promise<string> => page.evaluate(() => (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 2500)).catch(() => '')

  /** every part of one step, once. `relaxed` is the second look: looser names, a model's help */
  const runAtoms = async (item: ScriptItem, relaxed: boolean, only?: Set<number>): Promise<Run | Failure> => {
    const run: Run = { per: [], areaText: '', last }
    let cur: AtomRun = { steps: [], picks: [], skipped: [], seen: [], did: 0, changed: false }
    const skip = (what: string, why: string) => {
      cur.skipped.push({ what, why })
      inp.log(`    SKIPPED ${what}: ${why}`)
    }
    const loc = (atom: { find: FindSpec; label: string }) => locateControl(page, atom, { relaxed, said: item.said, vision: inp.vision, gate, log: inp.log })
    const used: Array<{ x: number; y: number }> = []
    for (const [ai, atom] of (item.atoms as Atom[]).entries()) {
      // the second look redoes only what was not done: a button that worked is never pressed twice
      if (only && !only.has(ai)) continue
      cur = { steps: [], picks: [], skipped: [], seen: [], did: 0, changed: false }
      run.per[ai] = cur
      // the newer kinds (keys, drag, double-click, sliders, dates, scroll-until, whenever, pick) are performed by atomExec.ts
      if (isNewAtom(atom)) {
        const res = await execNewAtom(atom, { page, gate, log: inp.log, relaxed, said: item.said, vision: inp.vision, last: run.last, locate: loc })
        const tried = res.did > 0 && !res.verified
        const skips = [...res.skipped]
        // performed but the page did not show the expected effect: it is not claimed as done, and it is not recorded
        if (tried && !skips.length) skips.push({ what: `${atom.label}`, why: 'it was tried, but the page did not show the expected result' })
        for (const k of skips) inp.log(`    SKIPPED ${k.what}: ${k.why}`)
        cur.skipped.push(...skips)
        if (!tried) {
          cur.steps.push(...res.steps)
          cur.seen.push(...res.seen)
          cur.did += res.did
          cur.changed = res.changed
          cur.verified = res.verified
        }
        if (res.last) run.last = res.last
        continue
      }
      if (atom.action === 'open') {
        if (relaxed) continue // the page is already open: opening it again would undo what was done
        // the whole address is opened, #fragment and all: on many apps it is what picks the view the page opens on
        if (!gate.hostAllowed(atom.url)) return { failure: `${atom.url} is outside the allowed sites.` }
        if (!(await openPage(page, atom.url, 30000).catch(() => false))) return { failure: `${atom.url} would not open.` }
        await sleep(400)
        // an address that opens the site's "not found" page is a wrong address, not a page to look for controls on
        const notFound = await page.evaluate(() => {
          const title = document.title ?? ''
          const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim()
          return /\b404\b|not found|page (?:does not|doesn['’]t) exist/i.test(title) || (body.length < 400 && /\b404\b|page not found|not found/i.test(body)) ? (title || body).slice(0, 80) : ''
        }).catch(() => '')
        if (notFound) return { failure: `${atom.url} opened a "not found" page ("${notFound}"), so the address is probably wrong.` }
        cur.steps.push({ kind: 'goto', url: atom.url, intent: 'navigate', label: 'open page', focus: 'page' })
        cur.did++
        cur.changed = true
        inp.log(`    opened ${atom.url} (now at ${page.url()})`)
        continue
      }
      if (atom.action === 'select') {
        const l = await loc(atom)
        const found = l.found
        if (!found) {
          const near = l.miss?.closest.filter(Boolean).slice(0, 5)
          skip(`the dropdown "${atom.label}"`, `no dropdown called that was found${where(atom.find) ? ` (${where(atom.find)})` : ''}${near?.length ? `; the closest things are ${near.map((n) => `"${n}"`).join(', ')}` : ''}`)
          continue
        }
        cur.steps.push(...l.prep)
        const choices = await readChoices(page, found.selector)
        if (run.beforeText === undefined) run.beforeText = await textOf()
        let chosen = atom.option
        if (choices.native) {
          const at = matchOption(choices.entries, atom.option)
          if (at < 0) { skip(`choosing "${atom.option}" in "${found.label || atom.label}"`, `the dropdown lists, for example: ${choices.entries.slice(0, 6).map((e) => `"${e}"`).join(', ')}`); continue }
          chosen = choices.entries[at]
          const verdict = gate.checkClick({ label: chosen, kind: 'button' })
          if (!verdict.allow) { skip(`choosing "${chosen}"`, `your own rules do not allow it (${verdict.reason})`); continue }
          await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'nearest' }), found.selector)
          await chooseNative(page, found.selector, at)
        } else {
          // a drawn dropdown: open it, then press the entry that has the name
          const r = found.rect
          await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2)
          await sleep(400)
          const entry = await findElement(page, { target: atom.option, kind: 'click', within: ['suggestion'] }, 4000)
          if (!entry.found) { skip(`choosing "${atom.option}" in "${found.label || atom.label}"`, 'the dropdown has no entry called that'); continue }
          const verdict = gate.checkClick({ label: entry.found.label || atom.option, kind: 'button' })
          if (!verdict.allow) { skip(`choosing "${atom.option}"`, `your own rules do not allow it (${verdict.reason})`); continue }
          await page.mouse.click(entry.found.rect.x + entry.found.rect.w / 2, entry.found.rect.y + entry.found.rect.h / 2)
          chosen = entry.found.label || atom.option
        }
        await settle(page)
        await sleep(600)
        cur.steps.push({ kind: 'select', selector: found.selector, label: atom.label, text: atom.option, find: atom.find, focus: 'page' })
        // each choice is a result of its own: the viewer is given time to see what the page made of it
        cur.steps.push({ kind: 'wait', intent: 'inspect', label: 'result', focus: 'page' })
        cur.picks.push({ dropdown: atom.label, option: chosen, areaText: await textOf() })
        inp.log(`    chose "${chosen}" in "${found.label || atom.label}"`)
        cur.did++
        cur.changed = true
        run.last = found.selector
        continue
      }
      if (atom.action === 'scroll') {
        const out = await scrollArea(page, atom.find, atom.dir, { near: run.last, budgetMs: 0, instant: true })
        cur.did++
        cur.changed = out.moved > 0
        run.areaText = out.text || run.areaText
        cur.steps.push({ kind: 'scroll', text: atom.dir, label: 'scroll', find: atom.find, focus: 'page' })
        inp.log(`    scrolled ${atom.dir}${where(atom.find) ? ` (${where(atom.find)})` : ''}${out.moved ? '' : ' (nothing moved: it already fit)'}`)
        await sleep(300)
        continue
      }
      if (atom.action === 'scrollto') {
        let out = await scrollToSection(page, atom.label, { budgetMs: 0, instant: true })
        if (!out.found) {
          // the part may be folded away (a closed <details>, a panel behind a button): open it and look again
          const toggle = await revealHidden(page, atom.find)
          if (toggle && toggle !== 'opened' && gate.checkClick({ label: toggle.label, kind: 'button' }).allow) {
            await page.mouse.click(toggle.rect.x + toggle.rect.w / 2, toggle.rect.y + toggle.rect.h / 2)
            await settle(page)
            cur.steps.push({ kind: 'click', selector: toggle.selector, label: toggle.label || 'open', focus: 'target' })
          }
          out = await scrollToSection(page, atom.label, { budgetMs: 0, instant: true })
        }
        if (!out.found) {
          skip(`scrolling to "${atom.label}"`, `no part of the page is called that${out.closest?.length ? `; the closest headings are ${out.closest.map((n) => `"${n}"`).join(', ')}` : ''}`)
          continue
        }
        cur.did++
        cur.changed = out.moved
        run.areaText = out.text || run.areaText
        cur.steps.push({ kind: 'scrollto', text: atom.dir, label: atom.label, find: atom.find, focus: 'page' })
        inp.log(`    scrolled to "${out.label}"${out.moved ? '' : ' (it was already on screen)'}`)
        await sleep(300)
        continue
      }
      if (atom.action === 'mark') {
        const hover = atom.verb === 'hover'
        const wanted = atom.colours.length ? atom.colours : [undefined]
        for (const colour of wanted) {
          const name = `${hover ? 'hovering' : 'clicking'} ${colour ? `a ${colour}` : 'a'} ${atom.noun} on the chart`
          if (!hover) {
            const v = gate.checkClick({ label: `${colour ?? ''} ${atom.noun} on a chart`.trim(), kind: 'button' })
            if (!v.allow) { skip(name, `your own rules do not allow it (${v.reason})`); continue }
          }
          const before = await snapshotTexts(page)
          const res = await findMark(page, { spec: atom.find, colour, hover, avoid: used, allowTap: hover && gate.checkClick({ label: `${colour ?? ''} ${atom.noun} on a chart`.trim(), kind: 'button' }).allow })
          if (!res.hit) { skip(name, res.why ?? 'no such mark was found'); continue }
          const h = res.hit
          used.push({ x: h.x, y: h.y })
          const rel = { fx: (h.x - h.chart.rect.x) / h.chart.rect.w, fy: (h.y - h.chart.rect.y) / h.chart.rect.h }
          const what = `${colour ? `${colour} ` : ''}${atom.noun}`
          if (hover) {
            cur.changed = cur.changed || !!(h.tooltip || h.drawn)
            if (h.tooltip) cur.seen.push(`${h.tapped ? 'Tapping' : 'Resting the pointer on'} a ${what} of the chart${h.chart.title ? ` "${h.chart.title}"` : ''} shows a tooltip that says: "${h.tooltip}"`)
            else if (h.drawn) cur.seen.push(`Resting the pointer on a ${what} of the chart makes the chart highlight it and draw a label`)
            else cur.seen.push(`Resting the pointer on a ${what} of the chart: no tooltip text could be read`)
          } else {
            await page.mouse.move(h.x, h.y, { steps: 4 })
            await sleep(120)
            const pre = await viewOf(page)
            await page.mouse.click(h.x, h.y)
            await settle(page)
            await sleep(500)
            const fresh = await newTexts(page, before)
            cur.changed = cur.changed || fresh.length > 0 || !sameView(pre, await viewOf(page))
            cur.seen.push(`Clicking a ${what} of the chart${h.chart.title ? ` "${h.chart.title}"` : ''}${h.colour ? ` (drawn in ${h.colour})` : ''} ${fresh.length ? `brings up: ${fresh.join(' · ').slice(0, 300)}` : 'changes the chart (no new words appear)'}`)
          }
          cur.steps.push({ kind: 'mark', label: what, find: { ...atom.find, ...(colour ? { colours: [colour] } : {}) }, text: JSON.stringify({ verb: atom.verb, colour: h.colour ?? colour, ...rel, tooltip: h.tooltip, tap: h.tapped || undefined }), focus: 'page' })
          cur.did++
          inp.log(`    ${name}${h.tooltip ? ` — tooltip: "${h.tooltip.slice(0, 80)}"` : ''}`)
        }
        continue
      }
      if (atom.action === 'hover') {
        const l = await loc(atom)
        if (!l.found) { skip(`hovering over "${atom.label}"`, `nothing called that was found on the page${l.miss?.closest.length ? `; the closest things are ${l.miss.closest.slice(0, 4).map((n) => `"${n}"`).join(', ')}` : ''}`); continue }
        cur.steps.push(...l.prep)
        await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'nearest' }), l.found.selector)
        await sleep(150)
        const r = await page.evaluate((sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null }, l.found.selector)
        if (!r) { skip(`hovering over "${atom.label}"`, 'it disappeared before it could be used'); continue }
        const tip = await hoverText(page, r.x + r.w / 2, r.y + r.h / 2)
        if (tip) cur.seen.push(`Resting the pointer on "${l.found.label || atom.label}" shows: "${tip}"`)
        cur.changed = !!tip
        cur.steps.push({ kind: 'hover', selector: l.found.selector, label: atom.label, find: atom.find, focus: 'target' })
        inp.log(`    hovered "${l.found.label || atom.label}"${tip ? ` — "${tip.slice(0, 80)}"` : ''}`)
        cur.did++
        run.last = l.found.selector
        continue
      }
      // click / type
      const l = await loc(atom)
      const found = l.found
      if (!found) {
        const near = l.miss?.closest.filter(Boolean).slice(0, 5)
        skip(`${atom.action === 'type' ? 'typing into' : 'clicking'} "${atom.label}"`, `no ${atom.action === 'type' ? 'box' : 'control'} called that was found${where(atom.find) ? ` (${where(atom.find)})` : ''}${near?.length ? `; the closest things on the page are ${near.map((n) => `"${n}"`).join(', ')}` : ''}`)
        continue
      }
      cur.steps.push(...l.prep)
      await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', inline: 'nearest' }), found.selector)
      await sleep(120)
      const r = await page.evaluate((sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null }, found.selector)
      if (!r) { skip(`"${atom.label}"`, 'it disappeared before it could be used'); continue }
      if (atom.action === 'click') {
        const verdict = gate.checkClick({ label: found.label || atom.label, kind: 'button' })
        if (!verdict.allow) { skip(`clicking "${atom.label}"`, `your own rules do not allow it (${verdict.reason})`); continue }
        const before = await snapshotTexts(page)
        const pre = await viewOf(page)
        await page.mouse.move(r.x + r.w / 2, r.y + r.h / 2)
        await sleep(80)
        const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 2500 }).catch(() => null)
        await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2)
        await Promise.race([nav, sleep(900)])
        await settle(page)
        await sleep(300)
        const fresh = await newTexts(page, before, 5)
        cur.changed = fresh.length > 0 || !sameView(pre, await viewOf(page))
        if (fresh.length) cur.seen.push(`After clicking "${found.label || atom.label}" the page shows: ${fresh.join(' · ').slice(0, 300)}`)
        cur.steps.push({ kind: 'click', selector: found.selector, label: atom.label, find: atom.find, focus: 'target' })
        inp.log(`    clicked "${found.label || atom.label}"`)
      } else {
        const typed = atom as Extract<Atom, { action: 'type' }>
        await page.mouse.click(r.x + Math.min(r.w * 0.5, 120), r.y + r.h / 2)
        await page.evaluate((sel) => { const e = document.querySelector(sel) as HTMLInputElement | null; if (e && typeof e.select === 'function') e.select() }, found.selector)
        await page.keyboard.type(typed.text, { delay: 25 })
        // a search box shows its suggestions a moment later
        await sleep(900)
        await settle(page)
        cur.changed = true
        cur.steps.push({ kind: 'type', selector: found.selector, label: atom.label, text: typed.text, find: atom.find, focus: 'target' })
        inp.log(`    typed "${typed.text}" into "${found.label || atom.label}"`)
      }
      cur.did++
      run.last = found.selector
    }
    return run
  }

  for (const item0 of inp.script.items) {
    let item = item0
    if (inp.signal?.aborted) return { results, actions, failure: 'Cancelled', skipped: skippedAll }
    if (item.login) {
      results.push({ item, steps: [], areaText: '', picks: [], skipped: [], seen: [], parts: [], status: 'login' })
      continue
    }
    inp.log(`  step ${numberOf(item)}: ${item.said}`)
    // a goal has no clicks yet: they are made from the page when something can do that
    if (!item.atoms.length && item.goal && inp.planGoal) {
      const planned = await inp.planGoal({ item, page, log: inp.log }).catch(() => null)
      if (planned?.length) item = { ...item, atoms: planned, goal: undefined }
    }
    const acts = item.atoms.some((a) => a.action !== 'open')
    const first = await runAtoms(item, false)
    if ('failure' in first) return fail(item, first.failure)
    let run: Run = first
    let unchanged = false
    if (acts) {
      const done = flat(run.per)
      unchanged = done.did > 0 && !done.changed
      const undone = run.per.flatMap((p, i) => (p?.skipped.length ? [i] : []))
      // part of the step was not done, or the screen did not change at all: look again, with the page studied more closely.
      // Only the parts that were not done are tried again; when the screen did not change, the parts that look at or move
      // around the page are redone, never a button (a "next" pressed twice would be a second jump).
      const redo = new Set<number>(undone)
      if (!redo.size && unchanged) item.atoms.forEach((a, i) => { if (a.action === 'scroll' || a.action === 'scrollto' || a.action === 'hover' || a.action === 'mark') redo.add(i) })
      if (redo.size) {
        inp.log(`    ${undone.length ? 'part of the step was not done' : 'nothing changed on screen'}: looking again`)
        const again = await runAtoms(item, true, redo)
        if (!('failure' in again)) {
          const per = [...run.per]
          for (const i of redo) {
            const a = again.per[i]
            // what the second look did replaces the first only when it did more
            if (a && (a.skipped.length < (per[i]?.skipped.length ?? 99) || a.did > (per[i]?.did ?? 0))) per[i] = a
          }
          run = { ...run, per, areaText: again.areaText || run.areaText, last: again.last ?? run.last }
          const now = flat(run.per)
          unchanged = now.did > 0 && !now.changed
        }
      }
      if (unchanged && flat(run.per).did) inp.log('    still nothing changed on screen for this step')
    }
    const all = flat(run.per)
    actions += all.did
    last = run.last ?? last
    const areaText = run.areaText || (await textOf())
    const steps = all.steps
    const lastStep = steps[steps.length - 1]
    if (steps.length && !steps.every((s) => s.kind === 'scroll' || s.kind === 'scrollto') && !(lastStep.kind === 'wait' && lastStep.intent === 'inspect')) steps.push({ kind: 'wait', intent: 'inspect', label: 'result', focus: 'page' })
    // nothing is dropped silently: what was written but not understood, and a step with no action at all, are skipped parts with a reason
    const skipped = [...all.skipped]
    for (const u of item.unread) skipped.push({ what: `"${u}"`, why: `no action understood in "${u}"` })
    const onlySays = !item.atoms.length && (item.narration || !!item.explain)
    if (!item.atoms.length && !onlySays && !item.unread.length) {
      skipped.push(item.goal
        ? { what: `the goal "${item.goal.slice(0, 90)}"`, why: 'no concrete action was worked out for it, so nothing was done on the page' }
        : { what: `the step "${item.said.slice(0, 90)}"`, why: `no action understood in "${item.said.slice(0, 90)}"` })
    }
    for (const s of skipped) skippedAll.push({ ...s, n: numberOf(item), said: item.said })
    const parts: PartResult[] = item.atoms.map((_, i) => {
      const p = run.per[i]
      return { done: !!p && p.did > 0, verified: !!p && p.did > 0 && p.verified !== false, changed: !!p?.changed }
    })
    const doneParts = parts.filter((x) => x.done && x.verified).length
    const status: ItemResult['status'] = onlySays ? 'narrated' : !item.atoms.length ? 'not-done' : doneParts === 0 ? 'not-done' : doneParts === parts.length && !skipped.length ? 'done' : 'partial'
    results.push({ item, steps, areaText, picks: all.picks, beforeText: run.beforeText, skipped, seen: all.seen, parts, status, ...(unchanged ? { unchanged: true } : {}) })
  }
  // how the steps went
  const counted = results.filter((r) => r.status !== 'login' && r.status !== 'narrated')
  const stats = {
    total: counted.length,
    done: counted.filter((r) => r.status === 'done').length,
    partial: counted.filter((r) => r.status === 'partial').length,
    notDone: counted.filter((r) => r.status === 'not-done').length,
    narrated: results.filter((r) => r.status === 'narrated').length,
    unchanged: counted.filter((r) => r.unchanged).length,
    effective: counted.filter((r) => r.status === 'done' && !r.unchanged).length
  }
  const mostlyUnchanged = stats.total > 0 && stats.effective * 2 < stats.total
  return { results, actions, skipped: skippedAll, stats, mostlyUnchanged }
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
  const st0 = inp.outcome.stats
  const loginNote = inp.outcome.results.some((r) => r.item.login) ? ' (the log-in step is done by the sign-in you set up)' : ''
  // "exactly as written" is said only when it is true: every step was done and the page showed it
  const allDone = !st0 || (st0.partial === 0 && st0.notDone === 0)
  const notes: string[] = [
    allDone
      ? `Your ${inp.outcome.results.length} steps are done exactly as written and in order${loginNote}; nothing else was explored.`
      : `Of your ${inp.outcome.results.length} steps, ${st0.done} were done as written${st0.partial ? `, ${st0.partial} only in part` : ''}${st0.notDone ? ` and ${st0.notDone} could not be done at all` : ''} (each one is listed below), in order${loginNote}; nothing else was explored.`
  ]
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
  for (const k of inp.outcome.skipped ?? []) notes.push(`Step ${k.n} was not fully done: ${k.what} was skipped (${k.why}). The narration does not claim it.`)
  for (const r of inp.outcome.results) {
    if (r.item.login) continue
    if (r.status === 'not-done') notes.push(`Step ${r.item.written ?? r.item.n} ("${r.item.said.slice(0, 80)}") was not done at all, so it is not in the film and the narration does not mention it.`)
    else if (r.unchanged) notes.push(`Step ${r.item.written ?? r.item.n}: the screen did not visibly change, so the narration describes only what is on screen.`)
  }
  if (inp.outcome.mostlyUnchanged && st0) notes.push(`Only ${st0.effective} of ${st0.total} steps changed the page as written, so this film is only partly what you asked for. Check the notes above and record it again if you need every step.`)
  const first = beat
  for (const r of inp.outcome.results) {
    if (r.item.login) continue
    // a step that could not be done at all has no beat: the film never shows or says what did not happen (the notes list it)
    if (r.status === 'not-done') continue
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
      // a step that changed nothing is not held on screen (the film's length follows what was really shown)
      for (const st of g.steps) steps.push({ ...st, id: id(), beat, ...(r.unchanged ? { holdMs: Math.min(st.holdMs ?? 1500, 1500) } : {}) })
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
        const left = r.skipped.length > 0
        const facts: string[] = [left ? `The person's own instruction for this step (part of it could not be done on the page, see below): "${s(r.item.said)}"` : `The person's own instruction for this step: "${s(r.item.said)}"`]
        // facts come only from parts that were performed and verified
        r.item.atoms.forEach((a, i) => {
          if (a.action === 'select' || a.action === 'mark') return // each choice has its beat below; a chart mark is told by what was seen
          const ok = !!r.parts[i]?.done && r.parts[i]?.verified !== false
          if (!ok) return
          if (a.action === 'open') facts.push('Opens the page the person named')
          else if (a.action === 'click') facts.push(`Clicks "${s(a.label)}"${where(a.find) ? ` (${where(a.find)})` : ''}`)
          else if (a.action === 'type') facts.push(a.replace ? `Replaces the text in the ${s(a.label)} box with "${s(a.text)}"` : `Types "${s(a.text)}" into the ${s(a.label)} box`)
          else if (a.action === 'hover') facts.push(`Rests the pointer on "${s(a.label)}"`)
          else if (a.action === 'scrollto') facts.push(`Scrolls ${a.dir} to the part of the page called "${s(a.label)}"`)
          else if (a.action === 'scroll') facts.push(`Scrolls ${a.dir}${where(a.find) ? ` (${where(a.find)})` : ''} through the area`)
          else if (a.action === 'key') facts.push(`Uses the keyboard: ${s(a.label)}`)
          else if (a.action === 'drag') facts.push(`Drags "${s(a.from)}" to "${s(a.to)}"${a.position ? ` (${a.position === 'top' || a.position === 'bottom' ? `at the ${a.position}` : `${a.position === 'before' ? 'above' : 'below'}${a.ref ? ` "${s(a.ref)}"` : ' a card'}`})` : ''}`)
          else if (a.action === 'dblclick') facts.push(`Double-clicks "${s(a.label)}"`)
          else if (a.action === 'slider') facts.push(`Moves the "${s(a.label)}" slider${a.min !== undefined && a.max !== undefined ? ` to cover ${a.min} to ${a.max}` : a.value !== undefined ? ` to about ${a.value}` : ''}`)
          else if (a.action === 'date') facts.push(`Picks the date ${a.date} (the person said "${s(a.phrase)}")`)
          else if (a.action === 'scrollUntil') facts.push(`Scrolls until "${s(a.text)}" is on screen`)
          else if (a.action === 'pick') facts.push(`Chooses the ${s(a.label)}${a.ordinal ? ` (number ${a.ordinal})` : ''}${a.criterion ? ` with the ${a.criterion.replace('-', ' ')} ${a.field ? s(a.field) : 'value'}` : ''}`)
        })
        for (const o of r.seen) facts.push(s(o))
        for (const k of r.skipped) facts.push(`NOT SHOWN: ${s(k.what)} could not be done on the page (${s(k.why)}). Do not say or imply that it was done; describe only what is on screen.`)
        if (r.unchanged) facts.push('The screen did not visibly change during this step. Do not say that something opened, changed or was revealed; describe only what is on screen.')
        if (r.item.explain) facts.push(`The video must make this clear to the viewer, in the person's words: ${s(r.item.explain)}`)
        const text = groups.length > 1 ? (r.beforeText ?? r.areaText) : r.areaText
        if (r.item.explain && text) facts.push(`What that area of the screen says (explain from this, do not invent anything beyond it): ${s(text).slice(0, 1500)}`)
        for (const n of r.item.notes) facts.push(`Also in the step: ${s(n)}`)
        // what is said without any model must not claim what was not done
        const nothingDone = left && r.item.atoms.every((a, i) => a.action === 'open' || a.action === 'select' || !r.parts[i]?.done)
        const line = nothingDone ? 'This is what the page shows at this point.' : r.unchanged || left ? 'Take a look at what is on screen here.' : plainStep(r.item)
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
