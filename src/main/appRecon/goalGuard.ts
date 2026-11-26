import type { Atom } from './stepScript'
import type { FindSpec } from '@shared/appRecon'
import type { PolicyGate } from './policy'
import type { PageStudy, StudyControl } from './goalStudy'

/**
 * The goal planner's rails.
 *
 * A model proposes actions in words; nothing it says reaches the page unless it
 *   - names a control, section, chart or option that is really in the page outline (no invented features),
 *   - is about the part of the app the goal names (or is said to be a step the goal needs, with the reason),
 *   - is not something that deletes, pays, signs out or changes settings when the goal never asked for it,
 *   - passes the person's own rules (the policy gate), and is not a repeat of what was already done.
 * A refused action is kept with its reason, so the run notes can say what was left out.
 */

/** what the model proposes (every field the schema asks for; blanks are empty strings) */
export interface ModelAction {
  do: string
  target: string
  text?: string
  /** type: select what is in the box first and type over it */
  replace?: boolean
  near?: string
  /** why this action belongs to the goal: part of the feature itself, a thing it needs first, finding the way there, or a supporting step */
  relation?: string
  colours?: string[]
  noun?: string
  why?: string
}

/** which atom kinds the engine can perform right now */
export interface Capable {
  newAtoms: ReadonlySet<string>
}

export const BASE_ACTIONS = ['click', 'type', 'select', 'scrollto', 'hover', 'mark'] as const

const STOP = new Set(['the', 'a', 'an', 'of', 'on', 'in', 'to', 'and', 'for', 'button', 'link', 'tab', 'icon', 'section', 'page', 'panel', 'view'])
const stem = (w: string): string => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w)
export const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}£$€]+/gu, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .map(stem)

/** 0..1: how much of the two phrases is the same */
export function likeness(a: string, b: string): number {
  const x = tokens(a)
  const y = tokens(b)
  if (!x.length || !y.length) return 0
  if (x.join(' ') === y.join(' ')) return 1
  const common = x.filter((w) => y.includes(w)).length
  return common / Math.max(x.length, y.length)
}

function bestControl(study: PageStudy, label: string, kinds?: StudyControl['kind'][]): StudyControl | null {
  let best: { c: StudyControl; s: number } | null = null
  for (const c of study.controls) {
    if (kinds && !kinds.includes(c.kind)) continue
    const s = likeness(c.label, label)
    // among controls with the same words, one on screen beats one far away
    const rank = s + (c.inView ? 0.01 : 0)
    if (s >= 0.6 && (!best || rank > best.s)) best = { c, s: rank }
  }
  return best?.c ?? null
}

/** the section heading (or chart title) the words name */
export function bestSection(study: PageStudy, words: string): { heading: string; y: number } | null {
  let best: { heading: string; y: number; s: number } | null = null
  for (const s of study.sections) {
    const l = likeness(s.heading, words)
    // "Regional distribution section on the dashboard": the heading's words are all in what was said
    const hs = tokens(s.heading)
    const ws = tokens(words)
    const contained = hs.length > 0 && hs.every((w) => ws.includes(w)) ? 0.8 : 0
    const sc = Math.max(l, contained)
    if (sc >= 0.6 && (!best || sc > best.s)) best = { heading: s.heading, y: s.y, s: sc }
  }
  for (const c of study.charts) {
    const l = likeness(c.title, words)
    if (l >= 0.6 && (!best || l > best.s)) best = { heading: c.title, y: c.y, s: l }
  }
  return best ? { heading: best.heading, y: best.y } : null
}

const WRITE = /\b(delete|remove|erase|destroy|sign\s*out|log\s*out|logout|unsubscribe|deactivate|pay|purchase|place\s+order|checkout|check\s*out|buy|confirm|submit|send|post|publish|subscribe|upgrade|invite|create|save|add|book|order|reset|clear)\b/i
const DESTRUCTIVE = /\b(delete|remove|erase|destroy|sign\s*out|log\s*out|logout|unsubscribe|deactivate|pay|purchase|place\s+order|checkout|check\s*out|buy|cancel\s+(?:plan|subscription|account))\b/i
const CHROME = /\b(dark\s*mode|light\s*mode|theme|language|cookies?|privacy|terms|settings?|preferences|profile|my\s*account|help|feedback|contact(?:\s*us)?|about|share|download|export|print)\b/i
/** closing a popup or a banner is always allowed: it is what a person would do before anything else */
const CLOSER = /^(?:close|dismiss|no\s*thanks|not\s*now|maybe\s*later|skip|got\s*it|ok(?:ay)?|accept(?:\s+(?:all|essential|necessary|only necessary|cookies))?|only\s+necessary|reject(?:\s+all)?|decline|×|✕|x|cancel)$/i

/** a goal that says one thing also asks for the control that does it ("put it in the cart" asks for "Add to cart") */
const IMPLIED: Record<string, RegExp> = {
  add: /\b(cart|basket|bag|put|place|wish\s*list|favou?rite|bookmark|queue|new|create|enrol)/i,
  save: /\b(keep|store|remember|bookmark)/i,
  create: /\b(new|make|start|set\s*up|open\s+a)\b/i,
  book: /\b(appointment|reserve|schedule)/i,
  order: /\b(buy|purchase|checkout|cart)/i,
  submit: /\b(send|apply|finish|complete|confirm|enrol)/i,
  send: /\b(submit|share|message|invite)/i,
  confirm: /\b(finish|complete|book|order|buy|check\s*out)/i,
  clear: /\b(reset|remove|empty)/i,
  reset: /\b(clear|restore|default)/i
}

/** the words of the goal the guard compares a control against */
const wordIn = (re: RegExp, goal: string, label: string): boolean => {
  const m = re.exec(label)
  if (!m) return true
  const w = (m[1] ?? m[0]).toLowerCase()
  if (new RegExp(`\\b${w.replace(/\s+/g, '\\s*')}`, 'i').test(goal) || tokens(goal).some((t) => t === stem(w))) return true
  return !!IMPLIED[w]?.test(goal)
}

export interface Rails {
  goal: string
  /** headings that belong to the feature (grows as the planner narrows it down) */
  sections: string[]
  gate: PolicyGate
  /** actions already done on the page this goal: "click|label|text" */
  done: Set<string>
  /** how many steps that only find the way / prepare were let through */
  support: { used: number; max: number }
  /** how many pages were left */
  moves: { used: number; max: number }
  caps: Capable
}

export type Built = { atom: Atom; label: string; support: boolean; leaves: boolean; key: string } | { reject: string }

const inFeature = (c: StudyControl, sections: string[]): boolean => !sections.length || sections.some((s) => likeness(s, c.section) >= 0.5 || (c.section && tokens(s).every((w) => tokens(c.section).includes(w))))

/**
 * which of several controls that share a label is meant, and how to say where it is: the planner names text from the same card or
 * row ("near"); the control of that card is the one meant, and its place relative to another control of the card (to the right of
 * the product's name, under it, over it) is what lets the engine find that very one and no other.
 */
function instanceFor(c: StudyControl, study: PageStudy, said?: string): { c: StudyControl; relation?: FindSpec['relation']; why?: string } {
  if (c.same <= 1) return { c }
  const sameLabel = study.controls.filter((x) => x.label.toLowerCase() === c.label.toLowerCase())
  const words = tokens(said ?? '')
  // the card or row whose words hold what was named
  const item = words.length ? study.items.find((it) => words.every((w) => tokens(it.text).includes(w))) : undefined
  let mine = item ? sameLabel.find((x) => x.item === item.n) : undefined
  let anchor: StudyControl | undefined
  if (mine) anchor = study.controls.find((m) => m.item === mine!.item && m !== mine && m.same === 1 && m.label.length > 2)
  if (!mine && words.length) {
    // no card holds those words: a control named so, and the same-labelled one closest to it
    anchor = study.controls.filter((m) => m.same === 1 && likeness(m.label, said ?? '') >= 0.6).sort((p, q) => likeness(q.label, said ?? '') - likeness(p.label, said ?? ''))[0]
    // one on the same line as that control, else the one right under it, else the closest
    const rank = (b: StudyControl): number => {
      const dx = Math.abs(b.cx - anchor!.cx)
      const dy = b.cy - anchor!.cy
      return (Math.abs(dy) < Math.max(b.h, anchor!.h) * 1.3 ? 0 : dy > 0 && dx < Math.max(b.w, anchor!.w) * 1.3 ? 1 : 2) * 100000 + Math.hypot(dx, dy)
    }
    if (anchor) mine = [...sameLabel].sort((p, q) => rank(p) - rank(q))[0]
  }
  if (!mine) mine = c.item ? c : undefined
  if (!mine) return { c, why: words.length ? `several controls are called "${c.label}" and none is in a card that holds "${said}"` : `several controls are called "${c.label}": say which one with "near"` }
  if (!anchor) anchor = study.controls.find((m) => m.item === mine!.item && m !== mine && m.same === 1 && m.label.length > 2)
  if (!anchor) return { c: mine, why: `"${c.label}" is in a card with nothing else to tell it apart from the other ${c.same - 1}` }
  const dx = mine.cx - anchor.cx
  const dy = mine.cy - anchor.cy
  const level = Math.abs(dy) < Math.max(mine.h, anchor.h) * 1.3
  const aligned = Math.abs(dx) < Math.max(mine.w, anchor.w) * 1.3
  const rel: NonNullable<FindSpec['relation']>['rel'] = level ? (dx > 0 ? 'rightOf' : 'leftOf') : aligned ? (dy > 0 ? 'below' : 'above') : 'near'
  return { c: mine, relation: { rel, to: anchor.label } }
}

/** one model action → an atom the engine can perform, or the reason it is refused */
export function buildAtom(a: ModelAction, study: PageStudy, r: Rails): Built {
  const kind = (a.do || '').trim().toLowerCase()
  const relation = (a.relation || 'feature').toLowerCase()
  const why = (a.why ?? '').trim()
  const supportRel = relation === 'prerequisite' || relation === 'navigation' || relation === 'support'
  const target = (a.target ?? '').trim()
  if (!target && kind !== 'key') return { reject: `the action "${kind}" named nothing to act on` }
  if (!(BASE_ACTIONS as readonly string[]).includes(kind) && !r.caps.newAtoms.has(kind)) return { reject: `"${kind}" is not something the recorder can do yet` }
  if (supportRel && why.length < 6) return { reject: `"${target}" was proposed as a step the goal needs, with no reason given` }

  const gateOk = (label: string): string | null => {
    const v = r.gate.checkClick({ label, kind: 'button' })
    return v.allow ? null : `your own rules do not allow it (${v.reason})`
  }
  const risky = (label: string, ctl = ''): string | null => {
    if (CLOSER.test(label.trim())) return null
    // a link in a docs sidebar or a menu ("Create a user") names a place, not a write: only the destructive ones are held back
    const write = ctl === 'link' && !DESTRUCTIVE.test(label) ? /(?!)/ : WRITE
    if (!wordIn(write, r.goal, label)) return `"${label}" changes or sends data and the goal does not ask for that`
    if (!wordIn(CHROME, r.goal, label)) return `"${label}" is a setting or site control that has nothing to do with the goal`
    return null
  }
  const support = supportRel && !CLOSER.test(target)
  const spend = (): string | null => {
    if (!support) return null
    if (r.support.used >= r.support.max) return `enough preparation steps were already used for this goal (${r.support.max}); "${target}" is not part of the feature`
    return null
  }

  if (kind === 'scrollto') {
    const sec = bestSection(study, target)
    if (!sec) return { reject: `no part of the page is called "${target}" (the headings are: ${study.sections.slice(0, 8).map((s) => s.heading).join('; ') || 'none'})` }
    const dir = sec.y < study.scrollY ? 'up' : 'down'
    const key = `scrollto|${sec.heading.toLowerCase()}`
    if (r.done.has(key) && Math.abs(sec.y - study.scrollY) < study.viewH * 0.7) return { reject: `already at "${sec.heading}"` }
    return { atom: { action: 'scrollto', dir, label: sec.heading, find: { target: sec.heading, kind: 'scroll' } }, label: sec.heading, support: false, leaves: false, key }
  }

  if (kind === 'click' || kind === 'hover') {
    let c = bestControl(study, target)
    if (!c) return { reject: `no control called "${target}" is on the page (closest: ${study.controls.slice(0, 5).map((x) => x.label).join('; ')})` }
    if (kind === 'click' && c.disabled) return { reject: `"${c.label}" is disabled right now` }
    const bad = kind === 'click' ? risky(c.label, c.kind) ?? gateOk(c.label) : null
    if (bad) return { reject: bad }
    const inst = instanceFor(c, study, a.near?.trim())
    if (inst.why) return { reject: inst.why }
    const rel = inst.relation
    c = inst.c
    const key = `${kind}|${c.label.toLowerCase()}|${(a.near ?? '').toLowerCase()}`
    // pressed twice already (the first press may have been swallowed by a popup that came up): a third time would not help
    if (r.done.has(`${key}#2`) && kind === 'click' && !c.collapsed && !CLOSER.test(c.label.trim())) return { reject: `"${c.label}" was already pressed twice and changed the page each time` }
    const leaves = c.kind === 'link' && !!c.href && c.href.startsWith('/') && !c.href.startsWith(new URL(study.url).pathname + '#') && c.href.split('#')[0] !== new URL(study.url).pathname + new URL(study.url).search
    if (c.kind === 'link' && c.href && !c.href.startsWith('/')) return { reject: `"${c.label}" leads out of the app (${c.href})` }
    // a link in the feature itself (a product, a task, a row) is the feature at work; one from elsewhere must be given as the way there
    if (leaves && relation === 'feature' && r.sections.length && !inFeature(c, r.sections)) return { reject: `"${c.label}" opens another page, and is not part of the section the goal is about` }
    if (leaves && r.moves.used >= r.moves.max) return { reject: `already moved between pages ${r.moves.max} times for this goal` }
    if (!supportRel && kind === 'click' && r.sections.length && !inFeature(c, r.sections) && !(leaves && relation === 'navigation')) {
      return { reject: `"${c.label}" is under "${c.section || 'the top of the page'}", not in the part this goal is about (${r.sections.join('; ')})` }
    }
    const lim = spend()
    if (lim) return { reject: lim }
    const find: FindSpec = { target: c.label, kind: kind === 'hover' ? 'hover' : 'click', ...(c.kind === 'tab' ? { role: 'tab' as const } : {}), ...(rel ? { relation: rel } : {}) }
    return { atom: kind === 'hover' ? { action: 'hover', label: c.label, find } : { action: 'click', label: c.label, find }, label: c.label, support, leaves, key }
  }

  if (kind === 'type') {
    const c = bestControl(study, target, ['input'])
    if (!c) return { reject: `no text box called "${target}" is on the page` }
    const text = (a.text ?? '').trim()
    if (!text) return { reject: `nothing to type into "${c.label}"` }
    if (/password|passcode|pin\b|card|cvc|cvv|secret/i.test(c.label)) return { reject: `"${c.label}" is a private field` }
    if (!supportRel && r.sections.length && !inFeature(c, r.sections)) return { reject: `the box "${c.label}" is under "${c.section || 'the top of the page'}", not in the part this goal is about` }
    const lim = spend()
    if (lim) return { reject: lim }
    const key = `type|${c.label.toLowerCase()}|${text.toLowerCase().slice(0, 80)}`
    if (r.done.has(key)) return { reject: `"${text}" was already typed into "${c.label}"` }
    return { atom: { action: 'type', label: c.label, text, find: { target: c.label, kind: 'type' }, ...(a.replace ? { replace: true } : {}) }, label: c.label, support, leaves: false, key }
  }

  if (kind === 'select') {
    const c = bestControl(study, target, ['select'])
    if (!c) return { reject: `no dropdown called "${target}" is on the page` }
    const want = (a.text ?? '').trim()
    const opt = (c.options ?? []).find((o) => o.toLowerCase() === want.toLowerCase()) ?? (c.options ?? []).map((o) => ({ o, s: likeness(o, want) })).filter((x) => x.s >= 0.6).sort((x, y) => y.s - x.s)[0]?.o
    if (!opt) return { reject: `the dropdown "${c.label}" has no entry "${want}" (it lists: ${(c.options ?? []).join('; ')})` }
    const bad = risky(opt) ?? gateOk(opt)
    if (bad) return { reject: bad }
    if (!supportRel && r.sections.length && !inFeature(c, r.sections)) return { reject: `the dropdown "${c.label}" is under "${c.section || 'the top of the page'}", not in the part this goal is about` }
    const lim = spend()
    if (lim) return { reject: lim }
    const key = `select|${c.label.toLowerCase()}|${opt.toLowerCase()}`
    if (r.done.has(key)) return { reject: `"${opt}" was already chosen in "${c.label}"` }
    return { atom: { action: 'select', label: c.label, option: opt, find: { target: c.label, kind: 'select' } }, label: c.label, support, leaves: false, key }
  }

  if (kind === 'mark') {
    const chart = study.charts.find((ch) => likeness(ch.title, target) >= 0.5) ?? study.charts.find((ch) => ch.inView) ?? study.charts[0]
    if (!chart) return { reject: 'there is no drawn chart on the page to pick a mark on' }
    const verb = /hover/i.test(a.text ?? '') ? 'hover' : 'click'
    const colours = (a.colours ?? []).filter(Boolean).slice(0, 1)
    const noun = (a.noun || 'bar').toLowerCase().replace(/s$/, '')
    const label = `${colours.join(' ')} ${noun} on the ${chart.title || 'chart'}`.trim()
    const key = `mark|${verb}|${label.toLowerCase()}|${(a.near ?? '').toLowerCase()}`
    if (r.done.has(key)) return { reject: `that mark was already used` }
    const find: FindSpec = { target: label, kind: verb === 'hover' ? 'hover' : 'click', ...(colours.length ? { colours } : {}), noun, ...(chart.title ? { chart: chart.title } : {}) }
    return { atom: { action: 'mark', verb, label, colours, noun, find }, label, support: false, leaves: false, key }
  }

  // kinds the contract adds (key, slider, dblclick, drag, date, scrollUntil, pick): built in the shape the contract fixes
  const text = (a.text ?? '').trim()
  if (kind === 'key') {
    if (!text) return { reject: 'no key was named' }
    const key = `key|${text.toLowerCase()}`
    return { atom: { action: 'key', label: `press ${text}`, keys: text } as unknown as Atom, label: `press ${text}`, support: true, leaves: false, key }
  }
  if (kind === 'slider') {
    const c = bestControl(study, target, ['range'])
    if (!c) return { reject: `no slider called "${target}" is on the page` }
    const nums = (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    if (!nums.length) return { reject: `no value for the slider "${c.label}"` }
    const find: FindSpec = { target: c.label, kind: 'click' }
    const key = `slider|${c.label.toLowerCase()}|${nums.join('-')}`
    if (r.done.has(key)) return { reject: 'that slider value was already set' }
    const atom = (nums.length >= 2 ? { action: 'slider', label: c.label, min: nums[0], max: nums[1], find } : { action: 'slider', label: c.label, value: nums[0], find }) as unknown as Atom
    return { atom, label: c.label, support: false, leaves: false, key }
  }
  if (kind === 'dblclick') {
    const c = bestControl(study, target)
    if (!c) return { reject: `no control called "${target}" is on the page` }
    return { atom: { action: 'dblclick', label: c.label, find: { target: c.label, kind: 'click' } } as unknown as Atom, label: c.label, support: false, leaves: false, key: `dblclick|${c.label.toLowerCase()}` }
  }
  if (kind === 'scrolluntil') {
    return { atom: { action: 'scrollUntil', label: target, text: text || target, find: { target: 'scroll', kind: 'scroll' } } as unknown as Atom, label: target, support: false, leaves: false, key: `scrolluntil|${target.toLowerCase()}` }
  }
  if (kind === 'drag') {
    if (!text) return { reject: `nothing says where to drop "${target}"` }
    const pos = /\b(before|above)\b/i.test(a.near ?? '') ? 'before' : /\b(after|below)\b/i.test(a.near ?? '') ? 'after' : undefined
    const key = `drag|${target.toLowerCase()}|${text.toLowerCase()}`
    if (r.done.has(key)) return { reject: 'that drag was already done' }
    const atom = { action: 'drag', label: `drag ${target} to ${text}`, from: target, to: text, ...(pos ? { position: pos, ref: (a.near ?? '').replace(/^(before|above|after|below)\s+/i, '') } : {}), find: { target, kind: 'click' } } as unknown as Atom
    return { atom, label: `drag ${target}`, support: false, leaves: false, key }
  }
  if (kind === 'date') {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : Number.isNaN(Date.parse(text)) ? '' : new Date(Date.parse(text) - new Date(Date.parse(text)).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
    if (!iso) return { reject: `"${text || 'no date'}" is not a day the calendar can be set to (give it as YYYY-MM-DD)` }
    const key = `date|${target.toLowerCase()}|${iso}`
    if (r.done.has(key)) return { reject: 'that date was already set' }
    return { atom: { action: 'date', label: target, date: iso, phrase: text, find: { target, kind: 'click' } } as unknown as Atom, label: target, support: false, leaves: false, key }
  }
  if (kind === 'pick') {
    const words = text.toLowerCase()
    const ord: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, last: -1 }
    const o = Object.keys(ord).find((w) => new RegExp(`\\b${w}\\b`).test(words))
    const criterion = /cheapest|lowest price/.test(words) ? 'cheapest' : /most expensive/.test(words) ? 'most-expensive' : /\bhighest\b/.test(words) ? 'highest' : /\blowest\b/.test(words) ? 'lowest' : undefined
    if (o === undefined && !criterion) return { reject: `"${text || target}" does not say which ${target} to pick (an ordinal such as "second", or cheapest/highest/lowest)` }
    const key = `pick|${target.toLowerCase()}|${words}|${(a.near ?? '').toLowerCase()}`
    if (r.done.has(key)) return { reject: 'that pick was already made' }
    const atom = { action: 'pick', label: target, verb: 'click', ...(o !== undefined ? { ordinal: ord[o] } : {}), ...(a.near?.trim() ? { within: a.near.trim() } : {}), ...(criterion ? { criterion } : {}), find: { target, kind: 'click' } } as unknown as Atom
    return { atom, label: target, support: false, leaves: false, key }
  }
  return { reject: `"${kind}" is not an action the planner may use` }
}

/** a short plain description of what an atom does, for the step's own words */
export function describeAtom(atom: Atom): string {
  switch (atom.action) {
    case 'click': return `click "${atom.label}"`
    case 'hover': return `rest the pointer on "${atom.label}"`
    case 'type': return `type "${atom.text}" into "${atom.label}"`
    case 'select': return `choose "${atom.option}" in "${atom.label}"`
    case 'scrollto': return `scroll to "${atom.label}"`
    case 'mark': return `${atom.verb} a ${atom.colours.length ? `${atom.colours.join('/')} ` : ''}${atom.noun} on the chart`
    default: return `${(atom as { action: string }).action} ${(atom as { label?: string }).label ?? ''}`.trim()
  }
}
