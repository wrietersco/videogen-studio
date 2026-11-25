/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { ElementHandle, Page } from 'puppeteer-core'
import type { Atom, AtomResult, FindSpec, NewAtom, Step } from '@shared/appRecon'
import type { PolicyGate } from './policy'
import type { Found } from './resolve'
import type { Located, VisionPick } from './script'
import { armWhenever, clickMarkChecked, doClick, doHover, doType, type Env, type Outcome } from './actions'
import { doDate, doDrag, doKey, doScrollUntil, doSlider } from './gestures'
import { findMark, findSvgMark, hoverText, newTexts, snapshotTexts } from './marks'
import { pickByStructure, type PickSpec } from './pageModel'
import { deepPathInPage } from './deep'
import { sweepOverlays } from './overlays'

/**
 * Performs every atom that has to touch the page: clicks, typing, hovering, chart marks, keys, drag, double-click, sliders,
 * dates, scroll-until, "whenever" rules and ordinal/criterion picks. script.ts hands each of them here and keeps what comes
 * back: the steps to record, what was seen, what could not be done and why, and whether the page showed the effect.
 *
 * Every executor reports what it really did. A click that an overlay swallowed, a value that does not read back, a drag the
 * page ignored: all of them come back as `skipped` with a reason, never as done.
 */

export interface AtomExecCtx {
  page: Page
  gate: PolicyGate
  log: (m: string) => void
  /** the second look: looser names, a model's help */
  relaxed: boolean
  /** the person's words for the whole step */
  said: string
  vision?: VisionPick
  /** the selector of the control used just before (for "scroll near it") */
  last?: string
  /** the usual way to find a control by its name (name, then looser, then behind a folded panel, then by a model looking) */
  locate: (atom: { find: FindSpec; label: string }) => Promise<Located>
}

export type { Found }

/** the kinds this file performs: the newer ones, and the older ones (click, type, hover, mark) that now need its checks too */
export const NEW_ACTIONS = ['key', 'drag', 'dblclick', 'slider', 'date', 'scrollUntil', 'whenever', 'pick', 'click', 'type', 'hover', 'mark'] as const

/** true for every atom this file performs (the type is the contract's; click, type, hover and mark are included at run time) */
export const isNewAtom = (a: Atom): a is NewAtom => (NEW_ACTIONS as readonly string[]).includes(a.action)

type Skip = { what: string; why: string }
const miss = (what: string, why: string, steps: AtomResult['steps'] = []): AtomResult => ({ steps, seen: [], did: 0, changed: false, verified: false, skipped: [{ what, why }] })
const done = (o: Outcome, steps: AtomResult['steps'], extra: string[] = [], keepSkip = true): AtomResult => ({
  steps,
  seen: [...o.seen, ...extra],
  did: o.did,
  changed: o.changed,
  verified: o.verified,
  skipped: keepSkip && o.skipped ? [o.skipped] : [],
  ...(o.last ? { last: o.last } : {})
})

const whereWords = (f: FindSpec): string => [f.region ? `on the ${f.region}` : '', f.within?.length ? `in the ${f.within.join('/')} area` : '', f.relation ? `${f.relation.rel.replace('Of', ' of')} "${f.relation.to}"` : ''].filter(Boolean).join(', ')
const nearWords = (l: Located): string => {
  const near = l.miss?.closest.filter(Boolean).slice(0, 5)
  return near?.length ? `; the closest things on the page are ${near.map((n) => `"${n}"`).join(', ')}` : ''
}

/** a model looks at the screen for a control (a last resort; main page only): its address */
async function visionAddress(page: Page, said: string, find: FindSpec, vision: VisionPick): Promise<string | null> {
  const cands = await page
    .evaluate(() => {
      const out: Array<{ i: number; text: string; kind: string; rect: { x: number; y: number; w: number; h: number } }> = []
      const els = Array.from(document.querySelectorAll('a,button,[role=button],[role=tab],[role=menuitem],summary,input:not([type=hidden]),select,[onclick],[tabindex]:not([tabindex="-1"]),[draggable=true]'))
      for (const el of els) {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
        const text = ((el as HTMLElement).innerText || el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).value || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 70)
        out.push({ i: out.length, text, kind: el.getAttribute('role') ?? el.tagName.toLowerCase(), rect: { x: r.x, y: r.y + scrollY, w: r.width, h: r.height } })
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
  const pick = await vision({ shot, said: said || find.target, candidates: cands }).catch(() => null)
  if (pick === null || pick === undefined) return null
  // the same list again, in the same order, gives the element behind the number
  const addr = await page.evaluateHandle((n) => {
    const els = Array.from(document.querySelectorAll('a,button,[role=button],[role=tab],[role=menuitem],summary,input:not([type=hidden]),select,[onclick],[tabindex]:not([tabindex="-1"]),[draggable=true]'))
    let k = -1
    for (const el of els) {
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      if (r.width < 4 || r.height < 4 || cs.visibility === 'hidden' || cs.display === 'none') continue
      if (++k === n) return el
    }
    return null
  }, pick).catch(() => null)
  const el = addr?.asElement() as ElementHandle<Element> | null | undefined
  return el ? ((await el.evaluate(deepPathInPage).catch(() => null)) as string | null) : null
}

const ORDINAL_WORDS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']
const RELATION = /\b(under|underneath|beneath|below|above|over|next to|beside|left of|right of|near|just after|just before)\b\s+(?:the\s+)?(.+)$/i
const RELMAP: Record<string, NonNullable<FindSpec['relation']>['rel']> = { under: 'below', underneath: 'below', beneath: 'below', below: 'below', above: 'above', over: 'above', 'next to': 'near', beside: 'near', near: 'near', 'left of': 'leftOf', 'right of': 'rightOf', 'just after': 'rightOf', 'just before': 'leftOf' }

const wanted = (kind: 'click' | 'type' | 'hover', label: string, find: FindSpec): FindSpec => ({ ...find, kind, target: find.target || label })

/** words about a mark of a chart that say which one, by its size or its label */
function markWords(label: string, noun: string): { extreme?: 'max' | 'min'; name?: string; kind?: 'bar' | 'point' } {
  const t = `${label} ${noun}`.toLowerCase()
  const extreme = /\b(tall|tallest|high|highest|peak|peaks|max|maximum|biggest|largest|top|best)\b/.test(t) ? 'max' : /\b(low|lowest|short|shortest|min|minimum|smallest|bottom|trough|dip|worst)\b/.test(t) ? 'min' : undefined
  const months = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|q[1-4]|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/.exec(t)
  const kind = /\bbars?\b|columns?/.test(t) ? 'bar' : /\b(point|points|dot|dots|marker|peak|peaks)\b/.test(t) ? 'point' : undefined
  return { extreme, name: months?.[1], kind }
}

export async function execNewAtom(atom: NewAtom, ctx: AtomExecCtx): Promise<AtomResult> {
  const a = atom as unknown as Atom
  const { page, gate } = ctx
  const allow = (label: string) => gate.checkClick({ label, kind: 'button' }).allow
  const env: Env = { page, allow, log: ctx.log, pace: 0 }
  const say = ctx.log

  switch (a.action) {
    case 'whenever': {
      armWhenever(page, { condition: a.condition, action: a.then })
      const swept = await sweepOverlays(page, { policy: undefined, allow, log: say }).catch(() => ({ closed: [] as string[] }))
      const step: Omit<Step, 'id' | 'beat'> = { kind: 'whenever', label: a.label, text: JSON.stringify({ condition: a.condition, then: a.then }), focus: 'page' }
      say(`    from now on: ${a.condition} → ${a.then}`)
      return { steps: [step], seen: [], skipped: [], did: 1, changed: swept.closed.length > 0, verified: true }
    }

    case 'key': {
      const o = await doKey(env, a.keys, a.repeatUntil)
      const step: Omit<Step, 'id' | 'beat'> = { kind: 'key', label: a.label, text: JSON.stringify({ keys: a.keys, repeatUntil: a.repeatUntil }), focus: 'page' }
      if (o.note) say(`    ${o.note}`)
      return done(o, o.did || !o.skipped ? [step] : [])
    }

    case 'scrollUntil': {
      const o = await doScrollUntil(env, a.text)
      const step: Omit<Step, 'id' | 'beat'> = { kind: 'scrollUntil', label: a.label, find: a.find, text: JSON.stringify({ text: a.text }), focus: 'page' }
      return done(o, o.verified ? [step] : [])
    }

    case 'click':
    case 'dblclick':
    case 'hover':
    case 'type':
    case 'slider':
    case 'date':
    case 'pick': {
      return onElement(a, ctx, env, allow)
    }

    case 'drag': {
      const find = (label: string): Promise<Located> => ctx.locate({ find: { target: label, kind: 'click' }, label })
      const from = await ctx.locate({ find: wanted('click', a.from, a.find), label: a.from })
      if (!from.found) return miss(`dragging "${a.from}"`, `nothing called that was found on the page${nearWords(from)}`)
      const refTarget = a.ref ? await find(a.ref) : null
      if (a.ref && !refTarget?.found) return miss(`dragging "${a.from}" ${a.position ?? 'before'} "${a.ref}"`, `nothing called "${a.ref}" was found to drop it next to${refTarget ? nearWords(refTarget) : ''}`)
      let to: Located | null = null
      if (a.to) {
        to = await dropZone(page, a.to)
        if (!to) to = await find(a.to)
        if (!to.found && !refTarget?.found) return miss(`dragging "${a.from}" to "${a.to}"`, `nothing called "${a.to}" was found to drop it on${nearWords(to)}`)
      }
      const o = await doDrag(env, {
        from: { selector: from.found.selector, label: from.found.label || a.from },
        to: to?.found ? { selector: to.found.selector, label: a.to } : undefined,
        ref: refTarget?.found ? { selector: refTarget.found.selector, label: a.ref! } : undefined,
        position: a.position
      })
      const step: Omit<Step, 'id' | 'beat'> = { kind: 'drag', label: a.label, find: wanted('click', a.from, a.find), text: JSON.stringify({ from: a.from, to: a.to, position: a.position, ref: a.ref }), focus: 'target' }
      return done(o, [...from.prep, ...(o.verified ? [step] : [])])
    }

    case 'mark': {
      return doMarkAtom(a, ctx, env)
    }
  }
  return miss('the step', 'this kind of step is not known')
}

// ---------------------------------------------------------------- a control found by name, picked by place, or by value

async function onElement(a: Extract<Atom, { action: 'click' | 'dblclick' | 'hover' | 'type' | 'slider' | 'date' | 'pick' }>, ctx: AtomExecCtx, env: Env, allow: (l: string) => boolean): Promise<AtomResult> {
  const { page, gate } = ctx
  const say = ctx.log
  const verb = a.action === 'pick' ? (a.verb ?? 'click') : a.action
  const label = a.label
  const stepsFor: Array<Omit<Step, 'id' | 'beat'>> = []
  let found: Found | null = null
  let pickNote = ''
  let pickText: string | undefined
  let prep: Located['prep'] = []
  let missed: Located | null = null

  if (a.action === 'pick') {
    const rel = a.within ? RELATION.exec(a.within) : null
    const hasStructure = a.ordinal !== undefined || a.criterion !== undefined || (a.within && !rel) || a.column !== undefined
    if (rel || !hasStructure) {
      // "the button under the chart": the control, by what it is next to
      const find: FindSpec = { ...a.find, kind: 'click', target: a.find.target || a.label, ...(rel ? { relation: { rel: RELMAP[rel[1].toLowerCase()] ?? 'near', to: rel[2].trim() } } : {}) }
      const l = await ctx.locate({ find, label })
      missed = l
      found = l.found
      prep = l.prep
      if (found && rel) pickNote = `the ${label} ${rel[1].toLowerCase()} the ${rel[2].trim()}`
    } else {
      const spec: PickSpec = {
        label: a.label,
        ordinal: a.ordinal,
        within: a.within ?? (typeof a.column === 'number' ? `${ORDINAL_WORDS[a.column] ?? a.column + 'th'} column` : undefined),
        column: typeof a.column === 'string' ? a.column : undefined,
        criterion: a.criterion,
        field: a.field ?? (typeof a.column === 'string' ? a.column : undefined)
      }
      const r = await pickByStructure(page, spec)
      if (!r.ok) return miss(`choosing "${label}"${a.criterion ? ` by ${a.criterion}` : a.ordinal ? ` (number ${a.ordinal})` : ''}`, r.why)
      found = { selector: r.selector, rect: r.rect, label: r.label, score: 100 }
      pickNote = r.reason
      pickText = JSON.stringify({ pick: spec })
      if (r.values) pickNote += `. The values compared: ${r.values.map((v) => `${v.label} ${v.value}`).join('; ')}`
    }
  } else {
    const kind = a.action === 'type' ? 'type' : a.action === 'hover' ? 'hover' : 'click'
    const l = await ctx.locate({ find: wanted(kind, label, a.find), label })
    missed = l
    found = l.found
    prep = l.prep
  }
  if (!found) {
    const box = verb === 'type' ? 'box' : verb === 'slider' ? 'slider' : verb === 'date' ? 'date box' : 'control'
    const w = a.action === 'date' ? ' (and no date box or calendar was found)' : ''
    const what = verb === 'type' ? `typing into "${label}"` : verb === 'hover' ? `hovering over "${label}"` : verb === 'slider' ? `setting the slider "${label}"` : verb === 'date' ? `choosing the date "${a.action === 'date' ? a.phrase : label}"` : `${verb === 'dblclick' ? 'double-clicking' : 'clicking'} "${label}"`
    if (a.action === 'date') {
      // no box was named, or it was not found: a date box anywhere on the page may be the one
      const o = await doDate(env, null, a.date, a.phrase)
      const step: Omit<Step, 'id' | 'beat'> = { kind: 'date', label, find: a.find, text: JSON.stringify({ date: a.date, phrase: a.phrase, rule: a.rule }), focus: 'target' }
      return done(o, o.verified ? [step] : [])
    }
    const find = (a as { find: FindSpec }).find
    return miss(what, `no ${box} called that was found${find && whereWords(find) ? ` (${whereWords(find)})` : ''}${missed ? nearWords(missed) : ''}${w}`)
  }
  stepsFor.push(...prep)
  const name = found.label || label
  const target = { selector: found.selector, label: name }
  if ((verb === 'click' || verb === 'dblclick') && !allow(name)) {
    const v = gate.checkClick({ label: name, kind: 'button' })
    return miss(`${verb === 'dblclick' ? 'double-clicking' : 'clicking'} "${label}"`, `your own rules do not allow it (${v.reason})`, stepsFor)
  }
  const relocate = ctx.vision ? () => visionAddress(page, ctx.said, a.find, ctx.vision!) : undefined
  const before = await snapshotTexts(page)

  if (verb === 'hover') {
    const o = await doHover(env, target, (x, y) => hoverText(page, x, y))
    if (o.skipped) return miss(o.skipped.what, o.skipped.why, stepsFor)
    const seen = o.tip ? [`Resting the pointer on "${name}" shows: "${o.tip}"`] : []
    say(`    hovered "${name}"${o.tip ? ` — "${o.tip.slice(0, 80)}"` : ''}`)
    stepsFor.push({ kind: 'hover', selector: found.selector, label, find: wanted('hover', label, a.find as FindSpec), focus: 'target' })
    return { steps: stepsFor, seen: [...seen, ...(pickNote ? [`Picked ${pickNote}`] : [])], skipped: [], did: 1, changed: !!o.tip, verified: !!o.tip, last: found.selector }
  }

  if (verb === 'type') {
    const t = a as Extract<Atom, { action: 'type' }>
    const o = await doType(env, target, t.text, { replace: t.replace, stepWords: label })
    if (o.skipped) return miss(o.skipped.what, o.skipped.why, stepsFor)
    say(`    typed "${t.text}" into "${name}"${o.verified ? '' : ' (it does not read back as typed)'}`)
    for (const c of o.closed) say(`    ${c}`)
    stepsFor.push({ kind: 'type', selector: found.selector, label, text: t.text, find: wanted('type', label, t.find), focus: 'target', ...(t.replace !== undefined ? { replace: t.replace } : {}) })
    const out = done(o, stepsFor)
    // typed text is a change by itself; what matters is that it reads back
    return { ...out, changed: true, verified: o.verified }
  }

  if (verb === 'slider') {
    const s = a as Extract<Atom, { action: 'slider' }>
    const o = await doSlider(env, target, { value: s.value, min: s.min, max: s.max })
    if (o.skipped) return miss(o.skipped.what, o.skipped.why, stepsFor)
    say(`    set the slider "${name}"${s.min !== undefined && s.max !== undefined ? ` to ${s.min}–${s.max}` : ` to ${s.value}`}`)
    stepsFor.push({ kind: 'slider', selector: found.selector, label, find: wanted('click', label, s.find), text: JSON.stringify({ value: s.value, min: s.min, max: s.max }), focus: 'target' })
    return done(o, stepsFor)
  }

  if (verb === 'date') {
    const d = a as Extract<Atom, { action: 'date' }>
    const o = await doDate(env, target, d.date, d.phrase)
    if (o.skipped) return miss(o.skipped.what, o.skipped.why, stepsFor)
    say(`    chose the date ${d.date}${d.rule ? ` (${d.rule})` : ''}`)
    stepsFor.push({ kind: 'date', selector: found.selector, label, find: wanted('click', label, d.find), text: JSON.stringify({ date: d.date, phrase: d.phrase, rule: d.rule }), focus: 'target' })
    return done(o, stepsFor, d.rule ? [`The date "${d.phrase}" was taken as ${d.date} (${d.rule})`] : [])
  }

  // click / double-click
  const o = await doClick(env, target, { double: verb === 'dblclick', stepWords: label, relocate })
  for (const c of o.closed) say(`    ${c}`)
  if (o.skipped) return miss(o.skipped.what, o.skipped.why, stepsFor)
  const fresh = await newTexts(page, before, 5)
  const seen: string[] = []
  if (fresh.length) seen.push(`After ${verb === 'dblclick' ? 'double-clicking' : 'clicking'} "${name}" the page shows: ${fresh.join(' · ').slice(0, 300)}`)
  if (pickNote) seen.push(`Picked ${pickNote}`)
  stepsFor.push({
    kind: verb === 'dblclick' ? 'dblclick' : 'click',
    selector: found.selector,
    label: a.action === 'pick' ? name : label,
    ...(a.action === 'pick' && pickText ? { text: pickText } : { find: wanted('click', label, a.find as FindSpec) }),
    focus: 'target'
  })
  say(`    ${verb === 'dblclick' ? 'double-clicked' : 'clicked'} "${name}"${o.note ? ` (${o.note})` : ''}`)
  return { steps: stepsFor, seen, skipped: [], did: o.did, changed: o.changed || fresh.length > 0, verified: o.verified, last: found.selector }
}

/** a list or column named by its heading ("the Done column"): the box that holds its cards */
async function dropZone(page: Page, name: string): Promise<Located | null> {
  const clean = name.replace(/\b(the|column|lane|list|board|section|area)\b/gi, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  const h = await page
    .evaluateHandle((w) => {
      const norm = (s: string) => (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
      const want = norm(w)
      let best: Element | null = null
      for (const head of Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[class*=title i],[class*=heading i],[class*=header i],legend,[role=heading]'))) {
        const t = norm((head as HTMLElement).innerText ?? '')
        if (!t || !(t === want || t.startsWith(want + ' ') || t.endsWith(' ' + want) || t.replace(/\b\d+\b/g, '').trim() === want)) continue
        const r = head.getBoundingClientRect()
        if (r.width < 4 || r.height < 4) continue
        // the box that holds the heading and the things under it
        let box: Element | null = head
        for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
          if (box !== head && box.querySelectorAll('[draggable=true],li,[class*=card i],[class*=task i],[class*=item i]').length > 0) { best = box; break }
          if (box !== head && /col|lane|list|board|stage|drop/i.test(`${box.className} ${box.id}`)) { best = box; break }
        }
        if (best) break
      }
      return best
    }, clean)
    .catch(() => null)
  const el = h?.asElement() as ElementHandle<Element> | null | undefined
  if (!el) return null
  const selector = (await el.evaluate(deepPathInPage).catch(() => '')) as string
  const b = await el.boundingBox()
  if (!selector || !b) return null
  return { found: { selector, rect: { x: b.x, y: b.y, w: b.width, h: b.height }, label: name, score: 90 }, prep: [] }
}

// ---------------------------------------------------------------- a mark of a chart

const usedMarks = new WeakMap<Page, { said: string; pts: Array<{ x: number; y: number }> }>()

async function doMarkAtom(a: Extract<Atom, { action: 'mark' }>, ctx: AtomExecCtx, env: Env): Promise<AtomResult> {
  const { page, gate } = ctx
  const say = ctx.log
  let used = usedMarks.get(page)
  if (!used || used.said !== ctx.said) usedMarks.set(page, (used = { said: ctx.said, pts: [] }))
  const hover = a.verb === 'hover'
  const steps: Array<Omit<Step, 'id' | 'beat'>> = []
  const seen: string[] = []
  const skipped: Skip[] = []
  let did = 0
  let changed = false
  let verified = true
  const wantedColours = a.colours.length ? a.colours : [undefined]
  for (const colour of wantedColours) {
    const name = `${hover ? 'hovering' : 'clicking'} ${colour ? `a ${colour}` : 'a'} ${a.noun} on the chart`
    const what = `${colour ? `${colour} ` : ''}${a.noun}`
    if (!hover) {
      const v = gate.checkClick({ label: `${colour ?? ''} ${a.noun} on a chart`.trim(), kind: 'button' })
      if (!v.allow) { skipped.push({ what: name, why: `your own rules do not allow it (${v.reason})` }); continue }
    }
    // a bar or point by its label or size ("the June peak", "the tallest bar"): read from the chart's own markup
    const mw = markWords(a.label, a.noun)
    if (!colour && (mw.extreme || mw.name)) {
      const svg = await findSvgMark(page, { chart: a.find.chart, label: mw.name, extreme: mw.extreme, kind: mw.kind, avoid: used.pts })
      if (svg.hit) {
        const h = svg.hit
        used.pts.push({ x: h.x, y: h.y })
        let tip = ''
        let ok = true
        if (hover) {
          tip = await hoverText(page, h.x, h.y, { dwellMs: 450 })
          changed = changed || !!tip
          seen.push(`Resting the pointer on ${h.why}${tip ? ` shows a tooltip that says: "${tip}"` : ' shows no tooltip text'}`)
        } else {
          const r = await clickMarkChecked(env, h.chart.rect, [{ x: h.x, y: h.y }])
          ok = r.ok
          if (r.ok) { changed = true; seen.push(`Clicking ${h.why} ${r.fresh.length ? `brings up: ${r.fresh.join(' · ').slice(0, 300)}` : 'changes the chart'}`) }
          else { skipped.push({ what: name, why: `${h.why} was clicked but the chart showed no reaction` }); verified = false; continue }
        }
        steps.push({ kind: 'mark', label: what, find: { ...a.find }, text: JSON.stringify({ verb: a.verb, svg: { label: mw.name, extreme: mw.extreme, kind: mw.kind }, tooltip: tip || undefined }), focus: 'page' })
        did++
        verified = verified && (hover ? !!tip : ok)
        say(`    ${name}: ${h.why}`)
        continue
      }
      if (!a.colours.length) {
        // not an svg chart: a picture of the chart can only be read by colour, and none was named
        skipped.push({ what: name, why: svg.why ?? 'the mark could not be found' })
        continue
      }
    }
    const before = await snapshotTexts(page)
    const res = await findMark(page, { spec: a.find, colour, hover, avoid: used.pts, allowTap: hover && gate.checkClick({ label: `${colour ?? ''} ${a.noun} on a chart`.trim(), kind: 'button' }).allow })
    if (!res.hit) { skipped.push({ what: name, why: res.why ?? 'no such mark was found' }); continue }
    const h = res.hit
    used.pts.push({ x: h.x, y: h.y })
    const rel = { fx: (h.x - h.chart.rect.x) / h.chart.rect.w, fy: (h.y - h.chart.rect.y) / h.chart.rect.h }
    if (hover) {
      changed = changed || !!(h.tooltip || h.drawn)
      if (h.tooltip) seen.push(`${h.tapped ? 'Tapping' : 'Resting the pointer on'} a ${what} of the chart${h.chart.title ? ` "${h.chart.title}"` : ''} shows a tooltip that says: "${h.tooltip}"`)
      else if (h.drawn) seen.push(`Resting the pointer on a ${what} of the chart makes the chart highlight it and draw a label`)
      else seen.push(`Resting the pointer on a ${what} of the chart: no tooltip text could be read`)
    } else {
      const r = await clickMarkChecked(env, h.chart.rect, [{ x: h.x, y: h.y }, ...(h.alts ?? [])])
      if (!r.ok) {
        skipped.push({ what: name, why: `it was clicked in ${r.tries} places on the ${colour ? colour + ' ' : ''}${a.noun} but the chart showed no reaction (no readout or change)` })
        verified = false
        continue
      }
      changed = true
      if (r.fresh.length || before.size >= 0) seen.push(`Clicking a ${what} of the chart${h.chart.title ? ` "${h.chart.title}"` : ''}${h.colour ? ` (drawn in ${h.colour})` : ''} ${r.fresh.length ? `brings up: ${r.fresh.join(' · ').slice(0, 300)}` : 'changes the chart (no new words appear)'}`)
      const at = r.at
      rel.fx = (at.x - h.chart.rect.x) / h.chart.rect.w
      rel.fy = (at.y - h.chart.rect.y) / h.chart.rect.h
    }
    steps.push({ kind: 'mark', label: what, find: { ...a.find, ...(colour ? { colours: [colour] } : {}) }, text: JSON.stringify({ verb: a.verb, colour: h.colour ?? colour, ...rel, tooltip: h.tooltip, tap: h.tapped || undefined }), focus: 'page' })
    did++
    say(`    ${name}${h.tooltip ? ` — tooltip: "${h.tooltip.slice(0, 80)}"` : ''}`)
  }
  return { steps, seen, skipped, did, changed, verified: did > 0 && verified }
}
