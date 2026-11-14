/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { Page } from 'puppeteer-core'
import type { FindSpec, Rect } from '@shared/appRecon'

/**
 * Finds a control the way a person describes it: "the Ontology item in the left
 * menu", "the suggestion psychology", "the fit-to-view icon just above the pause
 * icon". It reads the page's own words (visible text, tooltips, labels, icon
 * names), where the thing sits (left, right, top, inside a menu or pane) and what
 * it is next to, scores every candidate, and returns the best one, or nothing.
 * It never guesses wildly: below a minimum score it says it did not find it.
 */

export interface Found {
  selector: string
  rect: Rect
  /** what the control is called on the page */
  label: string
  score: number
}

export interface Miss {
  /** what was closest, to tell the person what the page does have */
  closest: string[]
}

type Result = ({ ok: true } & Found) | ({ ok: false } & Miss)

const MIN_SCORE = 45

function locate(spec: FindSpec, minScore: number): Result {
  const STOP = new Set(['the', 'a', 'an', 'of', 'on', 'in', 'to', 'icon', 'button', 'tab', 'link', 'item', 'option', 'section', 'page', 'pane', 'panel', 'bar', 'box', 'field', 'menu', 'just', 'right', 'left', 'above', 'below', 'top', 'my', 'this', 'that'])
  const norm = (s: string): string[] =>
    (s || '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
  const keyOf = (s: string): string[] => {
    const all = norm(s)
    const k = all.filter((w) => !STOP.has(w))
    return k.length ? k : all
  }
  const vw = innerWidth
  const vh = innerHeight
  const rectOf = (el: Element) => el.getBoundingClientRect()
  const shown = (el: Element): boolean => {
    const r = rectOf(el)
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.left >= vw) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0
  }
  const textOf = (el: Element): string => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const cssPath = (el: Element): string => {
    const one = (sel: string) => document.querySelectorAll(sel).length === 1
    if (el.id && one('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id)
    const parts: string[] = []
    for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && one('#' + CSS.escape(n.id))) { parts.unshift('#' + CSS.escape(n.id)); break }
      const sibs = Array.from(n.parentElement?.children ?? [])
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
    }
    return parts.join(' > ')
  }
  const attrs = (el: Element, names: string[]): string[] => names.map((n) => el.getAttribute(n) ?? '').filter(Boolean)
  const classTokens = (el: Element): string => (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : (el.getAttribute('class') ?? ''))

  const strongOf = (el: Element): string[] => {
    const out = attrs(el, ['aria-label', 'title', 'alt', 'placeholder', 'data-tooltip', 'data-tip', 'data-title', 'data-original-title', 'data-bs-original-title', 'mattooltip', 'aria-description', 'data-label'])
    const t = textOf(el)
    if (t && t.length <= 160) out.push(t)
    const v = (el as HTMLInputElement).value
    if (v && /^(button|submit)$/i.test((el as HTMLInputElement).type || '')) out.push(v)
    const st = el.querySelector('svg title')?.textContent
    if (st) out.push(st)
    const ia = el.querySelector('img[alt]')?.getAttribute('alt')
    if (ia) out.push(ia)
    const by = el.getAttribute('aria-labelledby')
    if (by) { const l = document.getElementById(by.split(' ')[0]); if (l) out.push(textOf(l)) }
    const lab = (el as HTMLInputElement).labels?.[0]
    if (lab) out.push(textOf(lab))
    // a tooltip that lives in a child element
    const tip = el.querySelector('[role=tooltip],.tooltip,[class*=tooltip]')
    if (tip) out.push(textOf(tip))
    return out
  }
  const weakOf = (el: Element): string[] => {
    const out = [el.id, classTokens(el), el.getAttribute('name') ?? '', ...attrs(el, ['data-testid', 'data-icon', 'data-action', 'data-id', 'data-test', 'data-cy'])]
    const href = el.getAttribute('href')
    if (href) out.push(href.split(/[/?#]/).filter(Boolean).pop() ?? '')
    const img = el.querySelector('img')?.getAttribute('src')
    if (img) out.push((img.split('/').pop() ?? '').replace(/\.\w+$/, ''))
    const use = el.querySelector('use')?.getAttribute('href') ?? el.querySelector('use')?.getAttribute('xlink:href')
    if (use) out.push(use)
    for (const c of Array.from(el.querySelectorAll('i,svg,span')).slice(0, 3)) out.push(classTokens(c), c.getAttribute('data-icon') ?? '')
    return out.filter(Boolean)
  }

  const key = keyOf(spec.target)
  const scoreText = (el: Element, k: string[], full: string): number => {
    if (!k.length) return 0
    let best = 0
    for (const s of strongOf(el)) {
      const ts = norm(s)
      const have = k.filter((w) => ts.includes(w) || (w.length >= 4 && ts.some((t) => t.startsWith(w))))
      const frac = have.length / k.length
      let sc = 0
      if (frac === 1) {
        sc = 100
        const same = ts.length === norm(full).length && ts.every((t, i) => t === norm(full)[i])
        if (same) sc += 40
        else sc += Math.max(0, 25 - Math.max(0, ts.length - k.length) * 3)
        if (ts.length > 12) sc -= 30
      } else if (frac >= 0.5) sc = 40 * frac
      best = Math.max(best, sc)
    }
    const wt = weakOf(el).flatMap(norm)
    if (wt.length) {
      const have = k.filter((w) => wt.includes(w) || wt.some((t) => t.length >= 3 && (t.startsWith(w) || (w.length >= 4 && w.startsWith(t)))))
      const frac = have.length / k.length
      best = Math.max(best, frac === 1 ? 55 : frac >= 0.5 ? 25 * frac : 0)
    }
    return best
  }

  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role=button],[role=tab],[role=menuitem],[role=option],[role=treeitem],[role=link],[role=switch],[role=checkbox],[role=radio],[role=searchbox],[role=combobox],[role=textbox],[tabindex],[onclick],li,[contenteditable=true],[class*=btn],[class*=icon],[class*=item],[class*=tab],[class*=suggest],[class*=option]'
  const isField = (el: Element): boolean => {
    const t = el.tagName
    if (t === 'TEXTAREA') return true
    if (t === 'INPUT') return !/^(button|submit|reset|checkbox|radio|image|hidden|file|range|color|password)$/i.test((el as HTMLInputElement).type)
    return el.getAttribute('contenteditable') === 'true' || /^(searchbox|textbox|combobox)$/.test(el.getAttribute('role') ?? '')
  }
  const all = Array.from(document.querySelectorAll('*')).slice(0, 9000)
  const pool: Element[] = []
  for (const el of all) {
    if (/^(HTML|BODY|HEAD|SCRIPT|STYLE|META|LINK|TITLE|NOSCRIPT|BR|HR)$/.test(el.tagName)) continue
    if (spec.kind === 'type') { if (isField(el) && shown(el)) pool.push(el); continue }
    if (!shown(el)) continue
    if (el.matches(INTERACTIVE)) { pool.push(el); continue }
    if (/^(svg|path|g|circle|rect|text|use|i|img|span|div|p|td|th)$/i.test(el.tagName) && el.parentElement) {
      const cs = getComputedStyle(el)
      if (cs.cursor === 'pointer' && getComputedStyle(el.parentElement).cursor !== 'pointer') pool.push(el)
    }
  }
  const clickable = spec.kind === 'type' ? pool : pool.filter((el) => !isField(el))

  const WITHIN: Record<string, RegExp> = {
    menu: /menu|nav|sidebar|side-?bar|drawer|rail|aside/,
    sidebar: /sidebar|side-?bar|drawer|rail|aside|nav/,
    nav: /nav|menu|sidebar/,
    search: /search|filter|query|find/,
    pane: /pane|panel|sidebar|drawer|inspector|detail|aside|side/,
    panel: /pane|panel|sidebar|drawer|inspector|detail|aside|side/,
    header: /header|toolbar|topbar|navbar|appbar|banner/,
    toolbar: /toolbar|header|topbar|controls|actions/,
    dropdown: /suggest|autocomplete|dropdown|listbox|option|popup|popover|results|combobox/,
    suggestion: /suggest|autocomplete|dropdown|listbox|option|popup|popover|results|combobox/
  }
  const ancestry = (el: Element): string => {
    const out: string[] = []
    let n: Element | null = el.parentElement
    for (let i = 0; i < 10 && n && n !== document.body; i++, n = n.parentElement) out.push([n.id, classTokens(n), n.getAttribute('role') ?? '', n.getAttribute('aria-label') ?? '', n.tagName].join(' ').toLowerCase())
    return out.join(' | ')
  }

  const anchorInput = ((): Element | null => {
    const a = document.activeElement
    if (a && isField(a) && shown(a)) return a
    return Array.from(document.querySelectorAll('input,textarea')).filter((e) => isField(e) && shown(e)).find((e) => /search|filter|find|query/i.test(`${(e as HTMLInputElement).type} ${e.getAttribute('placeholder') ?? ''} ${e.getAttribute('name') ?? ''} ${e.id} ${classTokens(e)}`)) ?? null
  })()

  const refs = ((): Element | null => {
    if (!spec.relation) return null
    const rk = keyOf(spec.relation.to)
    let best: { el: Element; s: number } | null = null
    for (const el of clickable) {
      const s = scoreText(el, rk, spec.relation.to)
      if (s >= minScore && (!best || s > best.s)) best = { el, s }
    }
    return best?.el ?? null
  })()

  const scored: Array<{ el: Element; s: number; label: string }> = []
  for (const el of clickable) {
    if (el === refs) continue
    let s = scoreText(el, key, spec.target)
    if (spec.kind === 'type' && s < minScore && !key.length) s = 50
    if (spec.kind === 'type' && (el as HTMLInputElement).type === 'search') s += 25
    if (spec.kind === 'type' && s < minScore && /search|filter|find|query/.test(`${el.id} ${classTokens(el)} ${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''}`.toLowerCase()) && key.every((w) => /search|filter|find|query|text|input/.test(w))) s = 60
    if (s <= 0) continue
    const r = rectOf(el)
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    const reg = spec.region
    if (reg === 'left') s += cx < vw * 0.38 ? 25 : -45
    if (reg === 'right') s += cx > vw * 0.58 ? 25 : -45
    if (reg === 'top') s += cy < vh * 0.32 ? 25 : -35
    if (reg === 'bottom') s += cy > vh * 0.68 ? 25 : -35
    const anc = ancestry(el)
    for (const w of spec.within ?? []) {
      const re = WITHIN[w.toLowerCase()]
      if (re && re.test(anc)) s += 30
    }
    if (spec.role === 'suggestion') {
      if (el.getAttribute('role') === 'option' || /suggest|autocomplete|dropdown|listbox|option|popup|popover|results|combobox/.test(anc + ' ' + classTokens(el).toLowerCase())) s += 50
      if (anchorInput && !isField(el)) {
        const a = rectOf(anchorInput)
        if (r.top >= a.bottom - 6 && r.top - a.bottom < 520 && r.right > a.left && r.left < a.right + 40) s += 40
      }
    }
    if (spec.role === 'tab' && (el.getAttribute('role') === 'tab' || /tab/.test(classTokens(el).toLowerCase()))) s += 15
    if (spec.role === 'icon') {
      if (r.width < 90 && r.height < 90) s += 10
      if (!textOf(el)) s += 10
    }
    if (refs) {
      const f = rectOf(refs)
      const fx = (f.left + f.right) / 2
      const fy = (f.top + f.bottom) / 2
      const rel = spec.relation!.rel
      const near = Math.abs(cx - fx) < Math.max(f.width, r.width) * 1.3
      const level = Math.abs(cy - fy) < Math.max(f.height, r.height) * 1.3
      const dx = Math.abs(cx - fx)
      const dy = Math.abs(cy - fy)
      if (rel === 'above') s += cy < fy - 2 && near ? 70 - Math.min(60, dy / 8) : -60
      else if (rel === 'below') s += cy > fy + 2 && near ? 70 - Math.min(60, dy / 8) : -60
      else if (rel === 'leftOf') s += cx < fx - 2 && level ? 70 - Math.min(60, dx / 8) : -60
      else if (rel === 'rightOf') s += cx > fx + 2 && level ? 70 - Math.min(60, dx / 8) : -60
      else s += Math.hypot(dx, dy) < 160 ? 50 - Math.hypot(dx, dy) / 5 : -20
    }
    if (cy >= 0 && cy <= vh && cx >= 0 && cx <= vw) {
      const top = document.elementFromPoint(cx, cy)
      if (top && !(el.contains(top) || top.contains(el))) s -= 35
    } else s -= 8
    scored.push({ el, s, label: strongOf(el)[0] ?? textOf(el) ?? el.id })
  }
  scored.sort((a, b) => b.s - a.s)
  const best = scored[0]
  if (!best || best.s < minScore) return { ok: false, closest: scored.slice(0, 5).map((c) => (c.label || c.el.tagName.toLowerCase()).slice(0, 40)) }
  const el = best.el
  const r = rectOf(el)
  return { ok: true, selector: cssPath(el), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, label: (strongOf(el)[0] ?? textOf(el) ?? '').slice(0, 80), score: Math.round(best.s) }
}

/** looks for the control, waiting while the page draws it (menus open, suggestions arrive) */
export async function findElement(page: Page, spec: FindSpec, waitMs = 8000): Promise<{ found: Found | null; miss?: Miss }> {
  const until = Date.now() + waitMs
  let miss: Miss | undefined
  for (;;) {
    const r = (await page.evaluate(locate, spec, MIN_SCORE).catch(() => null)) as Result | null
    if (r?.ok) return { found: { selector: r.selector, rect: r.rect, label: r.label, score: r.score } }
    if (r && !r.ok) miss = { closest: r.closest }
    if (Date.now() >= until) return { found: null, miss }
    await new Promise((res) => setTimeout(res, 350))
  }
}

export interface ScrollOutcome {
  /** the text of what was scrolled (what a viewer sees listed), for the narration */
  text: string
  moved: number
  /** the scrolled area, when it is a part of the page and not the page itself */
  rect?: Rect
}

/** the scrollable area the person meant: in the named region, else the biggest one; null means the page itself */
function pickScroller(spec: FindSpec | undefined, near: string | undefined): { x: number; y: number; room: number; sel: string | null } {
  const vw = innerWidth
  const vh = innerHeight
  const cands = Array.from(document.querySelectorAll('*')).filter((el) => {
    const cs = getComputedStyle(el)
    if (!/(auto|scroll|overlay)/.test(cs.overflowY)) return false
    const r = el.getBoundingClientRect()
    return el.scrollHeight > el.clientHeight + 20 && r.width * r.height > 12000 && r.right > 0 && r.left < vw
  })
  const path = (el: Element): string => {
    const parts: string[] = []
    for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break }
      const sibs = Array.from(n.parentElement?.children ?? [])
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
    }
    return parts.join(' > ')
  }
  const anchor = near ? document.querySelector(near) : null
  const scored = cands.map((el) => {
    const r = el.getBoundingClientRect()
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    let s = Math.min(20, (r.width * r.height) / 60000)
    if (anchor && el.contains(anchor)) s += 60
    if (spec?.region === 'left') s += cx < vw * 0.4 ? 40 : -40
    if (spec?.region === 'right') s += cx > vw * 0.55 ? 40 : -40
    if (spec?.region === 'top') s += cy < vh * 0.4 ? 40 : -40
    if (spec?.region === 'bottom') s += cy > vh * 0.6 ? 40 : -40
    const anc = [el.id, typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : '', el.getAttribute('role') ?? '', el.getAttribute('aria-label') ?? ''].join(' ').toLowerCase()
    if ((spec?.within ?? []).some((w) => anc.includes(w.toLowerCase()))) s += 25
    return { el, s, r }
  }).sort((a, b) => b.s - a.s)
  const top = scored[0]
  if (top && (top.s > 5 || !spec?.region)) return { x: (top.r.left + top.r.right) / 2, y: (top.r.top + top.r.bottom) / 2, room: top.el.scrollHeight - top.el.clientHeight - top.el.scrollTop, sel: path(top.el) }
  return { x: vw / 2, y: vh / 2, room: document.documentElement.scrollHeight - vh - scrollY, sel: null }
}

/**
 * Scrolls the area the person meant, the way a hand does: the pointer moves over
 * it and the wheel turns in steps. `budgetMs` is how long the scroll should take
 * (so it lasts as long as the explanation); with `instant` the end is reached
 * at once (exploring, where nobody is watching). Returns the text of the area.
 */
export async function scrollArea(page: Page, spec: FindSpec | undefined, dir: 'down' | 'up', o: { near?: string; budgetMs: number; instant: boolean; mouseTo?: (x: number, y: number) => Promise<void> }): Promise<ScrollOutcome> {
  const area = await page.evaluate(pickScroller, spec, o.near)
  if (o.instant || !area.room) {
    const moved = await page.evaluate((sel, d) => {
      const el = sel ? document.querySelector(sel) : document.scrollingElement
      if (!el) return 0
      let last = -1
      let total = 0
      for (let i = 0; i < 4 && el.scrollHeight !== last; i++) {
        last = el.scrollHeight
        const before = el.scrollTop
        el.scrollTop = d === 'down' ? el.scrollHeight : 0
        total += Math.abs(el.scrollTop - before)
      }
      return total
    }, area.sel, dir)
    const text = await page.evaluate((sel) => ((sel ? document.querySelector(sel) : document.body) as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 3000) ?? '', area.sel)
    return { text, moved }
  }
  await (o.mouseTo ? o.mouseTo(area.x, area.y) : page.mouse.move(area.x, area.y))
  const stops = Math.max(3, Math.min(16, Math.ceil(area.room / 240)))
  const wait = Math.max(250, Math.min(1500, o.budgetMs / stops))
  let moved = 0
  for (let i = 0; i < stops; i++) {
    const before = await page.evaluate((sel) => (sel ? (document.querySelector(sel) as HTMLElement | null)?.scrollTop : scrollY) ?? 0, area.sel)
    await page.mouse.wheel({ deltaY: (dir === 'down' ? 1 : -1) * Math.ceil(area.room / stops) })
    await new Promise((res) => setTimeout(res, wait))
    const after = await page.evaluate((sel) => (sel ? (document.querySelector(sel) as HTMLElement | null)?.scrollTop : scrollY) ?? 0, area.sel)
    moved += Math.abs(after - before)
    if (Math.abs(after - before) < 2) break
  }
  const text = await page.evaluate((sel) => ((sel ? document.querySelector(sel) : document.body) as HTMLElement | null)?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 3000) ?? '', area.sel)
  return { text, moved }
}
