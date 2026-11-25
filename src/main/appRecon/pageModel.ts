/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { Page } from 'puppeteer-core'
import type { Rect } from '@shared/appRecon'
import { DEEP, frameOffset, framePrefix, framesOf } from './deep'

/**
 * A light model of what a page is made of, so a step can name a thing by where it is in a group or by its value:
 * "the second card in the third column", "the first product", "the row with the highest total", "the cheapest jacket".
 *
 * It looks for REPEATED structures (lists, grids of cards, table rows, kanban columns: siblings that look alike), puts
 * their members in reading order, and reads numbers out of them (prices, totals, ratings). Nothing is guessed: when the
 * numbers needed for a comparison cannot be read from every member, the answer is "cannot tell", with the reason.
 */

export interface PickSpec {
  /** what is picked ("card", "product", "jacket", "row", "stylist", "time") */
  label: string
  /** 1 is the first; -1 the last */
  ordinal?: number
  /** the group it is in: "third column", "the Done column", "pricing section" */
  within?: string
  /** a table column or field named for the comparison ("total", "price") */
  column?: string
  criterion?: 'highest' | 'lowest' | 'cheapest' | 'most-expensive'
  field?: string
  /** a control inside the pick that is pressed instead of the pick itself ("the heart" of the second stylist, "the menu" of a card) */
  inner?: string
}

export interface Picked {
  ok: true
  selector: string
  rect: Rect
  label: string
  /** how it was chosen, in words the narration can use ("the row with the highest total: 1,240") */
  reason: string
  /** the values compared, when a comparison was made */
  values?: Array<{ label: string; value: number }>
}
export interface NotPicked {
  ok: false
  /** why not, in words for the run's notes */
  why: string
}
export type PickResult = Picked | NotPicked

const ORD: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10, last: -1, final: -1 }

/** an ordinal word in a phrase ("third column" → 3) and the phrase without it */
export function ordinalIn(text: string): { n?: number; rest: string } {
  const m = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|\d+(?:st|nd|rd|th))\b/i.exec(text)
  if (!m) return { rest: text }
  const w = m[1].toLowerCase()
  return { n: ORD[w] ?? (parseInt(w, 10) || undefined), rest: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() }
}

/** a number as a page writes it: "£1,299.00", "1.299,00 €", "12.5%", "-3" (null when there is none) */
export function parseNumber(text: string): number | null {
  const m = /-?\d[\d.,   ]*\d|-?\d/.exec(text.replace(/−/g, '-'))
  if (!m) return null
  let s = m[0].replace(/[   ]/g, '')
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    // the one that comes last is the decimal mark
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (lastComma >= 0) {
    s = /,\d{1,2}$/.test(s) && (s.match(/,/g) ?? []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '')
  } else if (lastDot >= 0 && (s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** in the page */
function pickIn(spec: PickSpec): { ok: true; path: string; rect: Rect; label: string; reason: string; values?: Array<{ label: string; value: number }> } | { ok: false; why: string } {
  const ORDW: Record<string, number> = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, sixth: 6, '6th': 6, seventh: 7, '7th': 7, eighth: 8, '8th': 8, ninth: 9, '9th': 9, tenth: 10, '10th': 10, last: -1, final: -1 }
  const ordinalIn = (text: string): { n?: number; rest: string } => {
    const m = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|\d+(?:st|nd|rd|th))\b/i.exec(text)
    if (!m) return { rest: text }
    const w = m[1].toLowerCase()
    return { n: ORDW[w] ?? (parseInt(w, 10) || undefined), rest: (text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim() }
  }
  const parseNumber = (text: string): number | null => {
    const m = /-?\d[\d.,\u00a0\u202f ]*\d|-?\d/.exec(text.replace(/\u2212/g, '-'))
    if (!m) return null
    let s = m[0].replace(/[\u00a0\u202f ]/g, '')
    const lastDot = s.lastIndexOf('.')
    const lastComma = s.lastIndexOf(',')
    if (lastDot >= 0 && lastComma >= 0) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
    else if (lastComma >= 0) s = /,\d{1,2}$/.test(s) && (s.match(/,/g) ?? []).length === 1 ? s.replace(',', '.') : s.replace(/,/g, '')
    else if (lastDot >= 0 && (s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '')
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  const textOf = (el: Element): string => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const classOf = (el: Element): string => (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : el.getAttribute('class') ?? '')
  const visible = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) return false
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
  }
  const pathOf = (el: Element): string => {
    const one = (root: Document | ShadowRoot, sel: string) => { try { return root.querySelectorAll(sel).length === 1 } catch { return false } }
    const hops: string[] = []
    let cur: Element | null = el
    for (let guard = 0; cur && guard < 12; guard++) {
      const root = cur.getRootNode() as Document | ShadowRoot
      const parts: string[] = []
      for (let n: Element | null = cur; n && n.nodeType === 1; n = n.parentElement) {
        if (n === document.documentElement) break
        if (n.id && one(root, '#' + CSS.escape(n.id))) { parts.unshift('#' + CSS.escape(n.id)); break }
        const sibs = Array.from(n.parentElement?.children ?? [])
        parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
      }
      hops.unshift(parts.join(' > '))
      cur = root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null
    }
    return hops.join(' >>> ')
  }
  const wordsOf = (s: string): string[] => (s || '').toLowerCase().replace(/['’]/g, '').normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
  const NOISE = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'that', 'with', 'one', 'button', 'item', 'thing', 'option', 'entry', 'listing'])
  const nounWords = wordsOf(spec.label).filter((w) => !NOISE.has(w))
  const GENERIC_ITEM = /^(card|tile|product|row|item|result|entry|slot|cell|task|ticket|post|article|listing|option|stylist|time|button|link|record|line|member|plan|package)$/

  // ---- every element, the ones in open shadow roots too
  const all: Element[] = []
  const collect = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (all.length > 14000) return
      all.push(el)
      const sr = (el as HTMLElement).shadowRoot
      if (sr) collect(sr)
    }
  }
  collect(document)

  // ---- repeated structures: siblings that look alike
  const sigOf = (el: Element): string => {
    const cls = classOf(el).split(/\s+/).filter((c) => c && !/^(active|selected|open|on|is-|has-|hover|focus|current|show|hidden|dragging|drag-over)/i.test(c)).sort().slice(0, 3).join('.')
    return el.tagName.toLowerCase() + '.' + cls + '|' + (el.getAttribute('role') ?? '')
  }
  interface Group { parent: Element; items: Element[]; sig: string }
  const groups: Group[] = []
  const seen = new Set<Element>()
  for (const p of all) {
    if (/^(HTML|HEAD|SCRIPT|STYLE|SELECT|OPTION|SVG|TR|THEAD|COLGROUP)$/.test(p.tagName) || seen.has(p)) continue
    const kids = Array.from(p.children).filter((c) => !/^(SCRIPT|STYLE|TEMPLATE|BR|HR)$/.test(c.tagName) && visible(c))
    if (kids.length < 2) continue
    const bySig = new Map<string, Element[]>()
    for (const k of kids) {
      const s = sigOf(k)
      bySig.set(s, [...(bySig.get(s) ?? []), k])
    }
    for (const [sig, items] of bySig) {
      if (items.length < 2) continue
      // members with something in them (words or a control)
      const filled = items.filter((i) => textOf(i).length > 0 || i.querySelector('button,a,input,img,svg,canvas'))
      if (filled.length >= 2) groups.push({ parent: p, items: filled, sig })
    }
  }
  // table rows are a group of their own
  for (const t of Array.from(document.querySelectorAll('table,[role=table],[role=grid]'))) {
    if (!visible(t)) continue
    const rows = Array.from(t.querySelectorAll('tbody > tr, [role=row]')).filter((r) => visible(r) && !r.querySelector('th,[role=columnheader]') && r.querySelectorAll('td,[role=cell],[role=gridcell]').length > 0)
    if (rows.length >= 1) groups.push({ parent: t, items: rows, sig: 'table-row' })
  }

  const rectOfItem = (el: Element) => el.getBoundingClientRect()
  const inReadingOrder = (items: Element[]): Element[] => {
    const rects = new Map(items.map((i) => [i, rectOfItem(i)]))
    const med = items.map((i) => rects.get(i)!.height).sort((a, b) => a - b)[Math.floor(items.length / 2)] || 20
    return [...items].sort((a, b) => {
      const ra = rects.get(a)!
      const rb = rects.get(b)!
      // the same row when the tops are within half an item's height
      if (Math.abs(ra.top - rb.top) < med * 0.5) return ra.left - rb.left
      return ra.top - rb.top
    })
  }

  // ---- which group does the noun name?
  const itemHay = (it: Element): string => `${it.tagName} ${classOf(it)} ${it.getAttribute('role') ?? ''} ${it.getAttribute('data-type') ?? ''}`.toLowerCase()
  const groupHay = (g: Group): string => `${classOf(g.parent)} ${g.parent.id} ${g.parent.getAttribute('aria-label') ?? ''} ${g.parent.getAttribute('role') ?? ''}`.toLowerCase()

  /** the groups to look in, best first, each with the members that fit the noun */
  const candidatesFor = (words: string[], scope: Element | null): Array<{ g: Group; items: Element[]; fit: number }> => {
    const out: Array<{ g: Group; items: Element[]; fit: number }> = []
    for (const g of groups) {
      if (scope && !scope.contains(g.parent) && scope !== g.parent) continue
      let items = g.items
      let fit = 0
      const hay = itemHay(g.items[0]) + ' ' + groupHay(g)
      const structural = words.filter((w) => GENERIC_ITEM.test(w) || /^(column|lane|list|board|stage|panel|section|group|category)$/.test(w))
      const content = words.filter((w) => !structural.includes(w))
      const SYNS: Record<string, string[]> = { column: ['col', 'lane', 'stage', 'board', 'kanban'], card: ['card', 'tile', 'task', 'item', 'ticket'], row: ['row', 'tr'], list: ['list', 'ul', 'ol'] }
      const wantsContainer = structural.filter((w) => /^(column|lane|board|stage|panel|section|group|category)$/.test(w))
      const hit = (w: string) => hay.includes(w) || (SYNS[w] ?? []).some((x) => hay.includes(x)) || (w === 'row' && g.sig === 'table-row')
      // a group of "columns" has to look like columns, whatever else is in the page
      if (wantsContainer.length && !wantsContainer.some(hit)) continue
      if (structural.some(hit)) fit += 3
      if (content.length) {
        // the words that are not about structure ("jacket", "afternoon") must be in the members' own words
        const mine = items.filter((i) => { const t = wordsOf(textOf(i) + ' ' + (i.getAttribute('aria-label') ?? '') + ' ' + (i.getAttribute('title') ?? '')); return content.every((w) => t.some((x) => x === w || x.startsWith(w) || w.startsWith(x))) })
        if (!mine.length) continue
        items = mine
        fit += 2 + (mine.length === g.items.length ? 0 : 1)
      }
      if (!structural.length && !content.length) fit += 1
      // an interactive member is what a step can use
      if (items.some((i) => i.matches('a,button,[role=button],[tabindex]') || i.querySelector('a,button,[role=button]'))) fit += 1
      // bigger visible groups beat tiny ones
      fit += Math.min(2, items.length / 6)
      if (fit > 0) out.push({ g, items, fit })
    }
    return out.sort((a, b) => b.fit - a.fit)
  }

  // ---- "within": an ordinal group ("third column") or a named one ("the Done column")
  let scope: Element | null = null
  let reasonScope = ''
  let filterWords: string[] = []
  if (spec.within) {
    const { n, rest } = ordinalIn(spec.within)
    const ww = wordsOf(rest).filter((w) => !NOISE.has(w))
    const named = ww.filter((w) => !/^(column|lane|list|board|stage|panel|section|group|category|row|area|part|region)$/.test(w))
    if (n !== undefined && !named.length) {
      // the Nth member of the group of columns
      const cands = candidatesFor(ww.length ? ww : ['column'], null).filter((c) => c.items.every((i) => i.querySelectorAll('a,button,li,[class*=card],[draggable],[class*=item],tr').length > 0 || textOf(i).length > 20))
      const c = cands[0]
      if (!c) return { ok: false, why: `there is no group of "${rest || 'columns'}" on the page to count in` }
      const ord = inReadingOrder(c.items)
      const el = n > 0 ? ord[n - 1] : ord[ord.length + n]
      if (!el) return { ok: false, why: `there are only ${ord.length} ${rest || 'columns'}, not ${n}` }
      scope = el
      reasonScope = `${n === -1 ? 'last' : 'number ' + n} ${rest || 'column'}`
    } else if (named.length) {
      // a heading or a label with those words: its group
      let best: { el: Element; s: number } | null = null
      for (const h of all) {
        if (!visible(h)) continue
        const own = Array.from(h.childNodes).filter((x) => x.nodeType === 3).map((x) => x.textContent ?? '').join(' ') || (h.children.length === 0 ? textOf(h) : '')
        const t = wordsOf(own + ' ' + (h.getAttribute('aria-label') ?? ''))
        if (!t.length || t.length > 6) continue
        if (!named.every((w) => t.some((x) => x === w || x.startsWith(w)))) continue
        const s = (/^H[1-6]$/.test(h.tagName) ? 3 : 1) + (t.length === named.length ? 2 : 0)
        if (!best || s > best.s) best = { el: h, s }
      }
      if (!best) {
        // not a place on the page: a word that narrows down the members ("the second afternoon time", "the overdue task")
        filterWords = named
      } else {
        // the group the heading sits at the top of: the nearest ancestor that holds more than the heading
        let box: Element | null = best.el
        for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
          if (box !== best.el && textOf(box).length > textOf(best.el).length + 10) break
        }
        scope = box ?? best.el.parentElement
        reasonScope = `the "${spec.within}" area`
      }
    }
  }

  // ---- the members
  const cand = candidatesFor(nounWords.length ? nounWords : ['item'], scope)
  if (!cand.length) {
    // a single group without a noun fit: any group inside the scope
    const any = candidatesFor([], scope)
    if (!any.length) return { ok: false, why: `no list, row or group of "${spec.label}" could be found${spec.within ? ` in ${reasonScope || spec.within}` : ''}` }
    cand.push(any[0])
  }
  // when there are several equally good groups (a card grid and a table of the same things) the biggest on screen wins
  const top = cand.filter((c) => c.fit >= cand[0].fit - 0.5).sort((a, b) => b.items.length - a.items.length)[0]
  let items = inReadingOrder(top.items)
  if (filterWords.length) {
    // the part of the day a time belongs to; any other word has to be in the member's own words
    const hourOf = (t: string): number | null => {
      const m = /(\d{1,2})[:.](\d{2})\s*(am|pm)?/i.exec(t)
      if (!m) return null
      let h = Number(m[1])
      if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0)
      return h + Number(m[2]) / 60
    }
    const kept = items.filter((it) => {
      const t = textOf(it)
      return filterWords.every((w) => {
        if (/^(morning|am)$/.test(w)) { const h = hourOf(t); return h !== null && h >= 5 && h < 12 }
        if (/^(afternoon|pm)$/.test(w)) { const h = hourOf(t); return h !== null && h >= 12 && h < 18 }
        if (/^(evening|night)$/.test(w)) { const h = hourOf(t); return h !== null && h >= 17 }
        const ws = wordsOf(t + ' ' + (it.getAttribute('aria-label') ?? '') + ' ' + classOf(it))
        return ws.some((x) => x === w || x.startsWith(w) || w.startsWith(x))
      })
    })
    if (!kept.length) return { ok: false, why: `none of the ${spec.label}s is "${filterWords.join(' ')}"` }
    items = kept
    reasonScope = reasonScope || filterWords.join(' ')
  }

  // ---- the choice: an ordinal, or the best by a value
  const clickable = (it: Element): Element => {
    if (it.matches('a,button,[role=button],input,[role=link],[role=option],[role=tab],[tabindex]')) return it
    const inner = it.querySelector('h1 a,h2 a,h3 a,h4 a,a[href],button,[role=button],[role=link]') as Element | null
    return inner && visible(inner) ? inner : it
  }
  const nameOf = (it: Element): string => (it.getAttribute('aria-label') || (it.querySelector('h1,h2,h3,h4,h5,strong,[class*=title],[class*=name]') ? textOf(it.querySelector('h1,h2,h3,h4,h5,strong,[class*=title],[class*=name]')!) : textOf(it))).slice(0, 60)
  const INNER: Record<string, string[]> = {
    heart: ['heart', '♡', '♥', '❤', 'favourite', 'favorite', 'wishlist', 'like', 'save'],
    menu: ['menu', 'more', 'options', 'actions', 'kebab', 'dots', '⋯', '…', '⋮', '···', '...'],
    gear: ['gear', 'settings', 'cog', 'preferences'],
    star: ['star', 'rate', 'favourite', '★', '☆'],
    trash: ['trash', 'delete', 'bin', 'remove'],
    close: ['close', '×', '✕', 'dismiss'],
    edit: ['edit', 'pencil', 'rename'],
    plus: ['plus', 'add', '+'],
    cart: ['cart', 'basket', 'bag', 'add to']
  }
  const innerIn = (it: Element): Element | null => {
    const want = wordsOf(spec.inner ?? '').filter((w) => !/^(icon|button|the|little|small)$/.test(w))
    const keys = want.flatMap((w) => INNER[w] ?? [w])
    const cands = Array.from(it.querySelectorAll('button,a,[role=button],[tabindex],[onclick],input,svg,i,span,div')).filter(visible)
    if (!keys.length) return cands.find((c) => c.matches('button,a,[role=button]')) ?? null
    const hit = cands.find((c) => {
      const hay = `${(c as HTMLElement).innerText ?? ''} ${c.getAttribute('aria-label') ?? ''} ${c.getAttribute('title') ?? ''} ${classOf(c)} ${(c as HTMLInputElement).value ?? ''} ${c.getAttribute('data-icon') ?? ''}`.toLowerCase()
      return keys.some((k) => hay.includes(k.toLowerCase()))
    })
    // the smallest thing that has it: a button, not the card that holds the button
    if (!hit) return null
    return hit.closest('button,a,[role=button]') ?? hit
  }
  const done = (it: Element, reason: string, values?: Array<{ label: string; value: number }>) => {
    let t = clickable(it)
    if (spec.inner) {
      const inner = innerIn(it)
      if (!inner) return { ok: false as const, why: `"${nameOf(it)}" has no "${spec.inner}" control to press` }
      t = inner
    }
    const r = t.getBoundingClientRect()
    return { ok: true as const, path: pathOf(t), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, label: nameOf(it), reason: `${reason}${reasonScope ? ` in ${reasonScope}` : ''}`, ...(values ? { values } : {}) }
  }
  if (spec.criterion) {
    const crit = spec.criterion
    const field = (spec.field || spec.column || (crit === 'cheapest' || crit === 'most-expensive' ? 'price' : '')).toLowerCase().trim()
    const fw = wordsOf(field).filter((w) => !NOISE.has(w))
    const money = /(?:[$£€¥₹₩₽]|\b(?:usd|gbp|eur|aed|sar|pkr|inr|cad|aud)\b)\s?\d|\d\s?(?:[$£€¥₹]|\b(?:usd|gbp|eur|aed|sar|pkr|inr)\b)/i
    const valueOf = (it: Element): number | null => {
      // a table: the cell under the column's header
      const row = it.closest('tr,[role=row]')
      if (row && fw.length) {
        const table = row.closest('table,[role=table],[role=grid]')
        const heads = table ? Array.from(table.querySelectorAll('th,[role=columnheader]')).filter((h) => visible(h)) : []
        const hi = heads.findIndex((h) => { const t = wordsOf(textOf(h)); return fw.every((w) => t.some((x) => x === w || x.startsWith(w) || w.startsWith(x))) })
        if (hi >= 0) {
          const cells = Array.from(row.children).filter((c) => /^(TD|TH)$/.test(c.tagName) || /cell/.test(c.getAttribute('role') ?? ''))
          const headRow = heads[hi].parentElement
          const idx = headRow ? Array.from(headRow.children).indexOf(heads[hi]) : hi
          const cell = cells[idx]
          return cell ? parseNumber(textOf(cell)) : null
        }
      }
      // a data attribute named for the field
      if (fw.length) {
        for (const a of Array.from(it.attributes)) if (/^data-/.test(a.name) && fw.every((w) => a.name.includes(w)) ) { const n = parseNumber(a.value); if (n !== null) return n }
      }
      // a price: an element named for it, not a struck-out old price
      const priceEl = (): Element | null => {
        const cands = Array.from(it.querySelectorAll('[class*=price i],[itemprop=price],[data-price],[class*=cost i],[class*=amount i]')).filter((e) => !e.closest('del,s,strike,[class*=old i],[class*=was i],[class*=compare i],[class*=original i]') && visible(e))
        return cands[0] ?? null
      }
      if (/^(price|cost|amount|prize)$/.test(fw[0] ?? '') || crit === 'cheapest' || crit === 'most-expensive') {
        const pe = priceEl()
        if (pe) { const n = parseNumber(pe.getAttribute('content') || pe.getAttribute('data-price') || textOf(pe)); if (n !== null) return n }
        const clone = it.cloneNode(true) as Element
        for (const x of Array.from(clone.querySelectorAll('del,s,strike,[class*=old i],[class*=was i],[class*=compare i],[class*=original i]'))) x.remove()
        const t = (clone as HTMLElement).innerText ?? clone.textContent ?? ''
        const m = money.exec(t)
        if (m) return parseNumber(t.slice(Math.max(0, m.index - 1), m.index + m[0].length + 12))
        return null
      }
      // a number written after the field's name ("Total: 120", "Rating 4.5")
      if (fw.length) {
        const t = textOf(it)
        const m = new RegExp(`${fw.join('[^0-9-]{0,8}')}[^0-9-]{0,14}(-?[\\d.,]+)`, 'i').exec(t)
        if (m) return parseNumber(m[1])
      }
      // a table with one numeric column, or a card with one number
      const nums = (textOf(it).match(/-?\d[\d.,]*/g) ?? []).map(parseNumber).filter((n): n is number => n !== null)
      return !fw.length && nums.length === 1 ? nums[0] : null
    }
    const vals = items.map((it) => ({ it, v: valueOf(it) }))
    const bad = vals.filter((x) => x.v === null)
    if (bad.length) return { ok: false, why: `the ${field || 'values'} to compare could not be read for ${bad.length} of ${vals.length} ${spec.label}${vals.length === 1 ? '' : 's'}, so nothing was picked` }
    if (vals.length < 2) return { ok: false, why: `only one ${spec.label} was found, so there is nothing to compare` }
    const want = crit === 'highest' || crit === 'most-expensive' ? Math.max(...vals.map((x) => x.v!)) : Math.min(...vals.map((x) => x.v!))
    const winners = vals.filter((x) => x.v === want)
    const values = vals.map((x) => ({ label: nameOf(x.it), value: x.v! }))
    const word = crit === 'cheapest' ? 'the cheapest' : crit === 'most-expensive' ? 'the most expensive' : crit === 'highest' ? `the highest ${field}` : `the lowest ${field}`
    return done(winners[0].it, `${word}: ${want}${winners.length > 1 ? ` (${winners.length} tie; the first is used)` : ''}`, values)
  }
  const n = spec.ordinal ?? 1
  const el = n > 0 ? items[n - 1] : items[items.length + n]
  if (!el) return { ok: false, why: `there are only ${items.length} ${spec.label}${items.length === 1 ? '' : 's'}, not ${n}` }
  return done(el, `${n === -1 ? 'the last' : n === 1 ? 'the first' : n === 2 ? 'the second' : n === 3 ? 'the third' : 'number ' + n} ${spec.label}`)
}

/** picks the thing a step names by its place in a group or by a value (null address when it cannot be told) */
export async function pickByStructure(page: Page, spec: PickSpec): Promise<PickResult> {
  let last: PickResult = { ok: false, why: 'nothing on the page could be read' }
  for (const f of framesOf(page)) {
    const r = await f.evaluate(pickIn, spec).catch(() => null)
    if (!r) continue
    if (!r.ok) {
      if (last.ok === false && (last.why === 'nothing on the page could be read' || f === page.mainFrame())) last = { ok: false, why: r.why }
      continue
    }
    const base = { ok: true as const, label: r.label, reason: r.reason, ...(r.values ? { values: r.values } : {}) }
    if (f === page.mainFrame()) return { ...base, selector: r.path, rect: r.rect }
    const off = await frameOffset(page, f)
    const prefix = await framePrefix(page, f)
    return { ...base, selector: [...prefix, r.path].join(DEEP), rect: { x: r.rect.x + off.x, y: r.rect.y + off.y, w: r.rect.w, h: r.rect.h } }
  }
  return last
}
