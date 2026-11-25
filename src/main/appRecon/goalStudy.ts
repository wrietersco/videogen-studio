/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import sharp from 'sharp'
import type { Page } from 'puppeteer-core'

/**
 * Studying a page for the goal planner: what a person sees when they look around a page before acting.
 *
 * It reads the page as an outline (headings in page order, the controls under each heading with their state, the repeated
 * items of lists / tables / cards with their words, the charts, any dialog in front) plus a picture of the screen. It never
 * clicks, types or scrolls, and it never reads the value of a password or hidden field.
 */

export interface StudyControl {
  i: number
  kind: 'button' | 'link' | 'tab' | 'input' | 'select' | 'range' | 'checkbox' | 'summary' | 'other'
  label: string
  /** top of the control in CSS px from the top of the page */
  y: number
  /** centre and size, for telling which of several same-named controls sits beside / under / over a given thing */
  cx: number
  cy: number
  w: number
  h: number
  inView: boolean
  /** the heading it sits under */
  section: string
  /** the repeated item (card / row / list entry) it belongs to, when it is one of several */
  item?: number
  /** how many visible controls on the page carry this very label */
  same: number
  /** folded: pressing it only shows more (a closed <details>, aria-expanded=false) */
  collapsed?: boolean
  checked?: boolean
  disabled?: boolean
  /** a field's or a dropdown's current value (never for password / hidden fields) */
  value?: string
  options?: string[]
  min?: string
  max?: string
  href?: string
}

export interface StudySection {
  heading: string
  level: number
  y: number
  inView: boolean
  /** the start of what it says */
  text: string
}

export interface StudyItem {
  n: number
  section: string
  text: string
  /** labels of the controls in it */
  controls: string[]
}

export interface PageStudy {
  url: string
  title: string
  scrollY: number
  pageH: number
  viewW: number
  viewH: number
  sections: StudySection[]
  controls: StudyControl[]
  items: StudyItem[]
  charts: Array<{ title: string; kind: 'svg' | 'canvas'; y: number; inView: boolean }>
  /** a dialog / popup / banner laid over the page, in words, with the buttons on it */
  overlays: string[]
  /** every visible line of text, for telling what changed */
  lines: string[]
}

export const MAX_CONTROLS = 170

/** in the page */
function readPage(maxControls: number): Omit<PageStudy, 'url'> {
  const vh = innerHeight
  const vw = innerWidth
  const sy = scrollY
  const clean = (s: string | null | undefined, n = 90): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    if (r.width < 3 || r.height < 3) return false
    const cs = getComputedStyle(el)
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0
  }
  const inView = (el: Element): boolean => {
    const r = el.getBoundingClientRect()
    return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
  }
  const isHeading = (el: Element): boolean => /^H[1-6]$/.test(el.tagName) || el.getAttribute('role') === 'heading'
  const headEls = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,[role=heading],legend,caption')).filter((e) => shown(e) && clean((e as HTMLElement).innerText).length > 1)
  const sections = headEls.map((h) => {
    const r = h.getBoundingClientRect()
    const box = h.closest('section,article,[class*=card],[class*=panel]') ?? h.parentElement
    const full = clean((box as HTMLElement | null)?.innerText, 400)
    const own = clean((h as HTMLElement).innerText, 80)
    return { heading: own, level: isHeading(h) && /^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : 3, y: Math.round(r.top + sy), inView: inView(h), text: clean(full.startsWith(own) ? full.slice(own.length) : full, 220), el: h }
  })
  const sectionOf = (el: Element): string => {
    let best = ''
    for (const s of sections) {
      if (s.el === el) continue
      const pos = s.el.compareDocumentPosition(el)
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = s.heading
      else if (!(pos & Node.DOCUMENT_POSITION_CONTAINED_BY)) break
    }
    return best
  }

  const CONTROL = 'a[href],button,[role=button],[role=tab],[role=menuitem],[role=switch],[role=checkbox],[role=radio],[role=option],[role=link],summary,input:not([type=hidden]),select,textarea,[contenteditable=true],[contenteditable=plaintext-only],[role=textbox],[onclick],[tabindex]:not([tabindex="-1"])'
  /** the words of a <label> that wraps a control, without the control's own entries ("Category All Shoes Socks" is "Category") */
  const ownLabel = (inp: HTMLInputElement): string => {
    const l = inp.labels?.[0]
    if (!l) return ''
    const c = l.cloneNode(true) as HTMLElement
    c.querySelectorAll('select,input,textarea,option,button').forEach((n) => n.remove())
    return clean(c.textContent, 70)
  }
  const labelOf = (el: Element): string => {
    const h = el as HTMLElement
    const inp = el as HTMLInputElement
    const own = clean(h.innerText || el.textContent, 70)
    const aria = clean(el.getAttribute('aria-label'), 70)
    const title = clean(el.getAttribute('title'), 70)
    const ph = clean(el.getAttribute('placeholder'), 70)
    const lab = ownLabel(inp)
    const by = el.getAttribute('aria-labelledby')
    const named = by ? clean(document.getElementById(by.split(' ')[0])?.innerText, 70) : ''
    const alt = clean(el.querySelector('img[alt]')?.getAttribute('alt'), 70)
    const val = /^(button|submit|reset)$/i.test(inp.type || '') ? clean(inp.value, 70) : ''
    if (el.tagName === 'SELECT' || inp.type === 'range') return lab || aria || named || title || ph || clean(inp.name, 40) || own
    return aria || own || lab || named || title || ph || val || alt || clean(inp.name, 40)
  }
  const kindOf = (el: Element): StudyControl['kind'] => {
    const t = el.tagName
    const role = el.getAttribute('role') ?? ''
    if (t === 'SELECT') return 'select'
    if (t === 'SUMMARY') return 'summary'
    if (t === 'INPUT') {
      const ty = (el as HTMLInputElement).type
      if (ty === 'range') return 'range'
      if (ty === 'checkbox' || ty === 'radio') return 'checkbox'
      if (/^(button|submit|reset|image)$/.test(ty)) return 'button'
      return 'input'
    }
    if (t === 'TEXTAREA' || (el as HTMLElement).isContentEditable || role === 'textbox') return 'input'
    if (role === 'tab') return 'tab'
    if (role === 'switch' || role === 'checkbox' || role === 'radio') return 'checkbox'
    if (t === 'A' || role === 'link') return 'link'
    if (t === 'BUTTON' || role === 'button' || role === 'menuitem' || role === 'option') return 'button'
    return 'other'
  }

  // repeated items: three or more siblings of the same kind (cards, rows, list entries), each with something to press
  const itemOf = new Map<Element, number>()
  const items: Array<{ n: number; section: string; text: string; el: Element }> = []
  const seenParents = new Set<Element>()
  for (const el of Array.from(document.querySelectorAll('tr,li,article,[class*=card],[class*=item],[class*=product],[class*=task],[class*=row]'))) {
    const p = el.parentElement
    if (!p || seenParents.has(p)) continue
    const kids = Array.from(p.children).filter((k) => k.tagName === el.tagName && shown(k) && clean((k as HTMLElement).innerText).length > 1)
    if (kids.length < 3 || kids.length > 80) continue
    if (/^(UL|OL|NAV)$/.test(p.tagName) && p.closest('nav,header,footer')) continue
    seenParents.add(p)
    for (const k of kids.slice(0, 40)) {
      const n = items.length + 1
      itemOf.set(k, n)
      items.push({ n, section: sectionOf(k), text: clean((k as HTMLElement).innerText, 150), el: k })
    }
  }
  const itemIdOf = (el: Element): number | undefined => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      const id = itemOf.get(n)
      if (id) return id
    }
    return undefined
  }

  const raw: Array<{ el: Element; c: StudyControl }> = []
  for (const el of Array.from(document.querySelectorAll(CONTROL))) {
    if (!shown(el) && !(el.tagName === 'INPUT' && /^(checkbox|radio)$/.test((el as HTMLInputElement).type))) continue
    const label = labelOf(el)
    if (!label) continue
    const r = el.getBoundingClientRect()
    const kind = kindOf(el)
    const c: StudyControl = { i: 0, kind, label, y: Math.round(r.top + sy), cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + sy + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), inView: inView(el), section: sectionOf(el), same: 1 }
    const it = itemIdOf(el)
    if (it) c.item = it
    const exp = el.getAttribute('aria-expanded')
    const det = el.tagName === 'SUMMARY' ? el.parentElement : null
    if (exp === 'false' || (det && det.tagName === 'DETAILS' && !(det as HTMLDetailsElement).open)) c.collapsed = true
    if (el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled) c.disabled = true
    const inp = el as HTMLInputElement
    if (kind === 'checkbox') c.checked = inp.checked ?? el.getAttribute('aria-checked') === 'true'
    if (kind === 'input' && !/^(password|hidden|file)$/i.test(inp.type)) c.value = clean(inp.value ?? (el as HTMLElement).innerText, el.tagName === 'INPUT' ? 40 : 160)
    if (kind === 'select') {
      c.options = Array.from((el as HTMLSelectElement).options ?? []).map((o) => clean(o.text, 40)).slice(0, 14)
      c.value = clean((el as HTMLSelectElement).selectedOptions?.[0]?.text, 40)
    }
    if (kind === 'range') {
      c.min = inp.min || '0'
      c.max = inp.max || '100'
      c.value = inp.value
    }
    if (kind === 'link') {
      const href = (el as HTMLAnchorElement).href ?? ''
      try {
        const u = new URL(href)
        c.href = u.origin === location.origin ? u.pathname + u.search + u.hash : u.hostname
      } catch {
        c.href = href.slice(0, 60)
      }
    }
    raw.push({ el, c })
  }
  const count = new Map<string, number>()
  for (const { c } of raw) count.set(c.label.toLowerCase(), (count.get(c.label.toLowerCase()) ?? 0) + 1)
  // page order; a long list of the same card keeps its first few
  const perLabel = new Map<string, number>()
  const controls: StudyControl[] = []
  for (const { c } of raw) {
    const k = c.label.toLowerCase()
    c.same = count.get(k) ?? 1
    const seen = (perLabel.get(k) ?? 0) + 1
    perLabel.set(k, seen)
    if (seen > 8) continue
    if (controls.length >= maxControls) break
    c.i = controls.length + 1
    controls.push(c)
  }

  const charts: PageStudy['charts'] = []
  for (const el of Array.from(document.querySelectorAll('canvas,svg'))) {
    if (el.parentElement?.closest('svg')) continue
    const r = el.getBoundingClientRect()
    if (r.width < 140 || r.height < 90 || !shown(el)) continue
    if (el.tagName.toLowerCase() === 'svg' && el.querySelectorAll('path,circle,rect,line,polyline').length < 6) continue
    const box = el.closest('section,article,[class*=card],[class*=panel],[class*=chart]') ?? el.parentElement
    const head = box?.querySelector('h1,h2,h3,h4,h5,legend,figcaption,[class*=title]')
    charts.push({ title: clean((head as HTMLElement | null)?.innerText ?? el.getAttribute('aria-label'), 70) || sectionOf(el), kind: el.tagName.toLowerCase() === 'canvas' ? 'canvas' : 'svg', y: Math.round(r.top + sy), inView: inView(el) })
  }

  // a dialog or a banner laid over the page
  const overlays: string[] = []
  for (const el of Array.from(document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open],[class*=modal],[class*=popup],[class*=banner],[class*=cookie],[class*=overlay],[class*=toast]'))) {
    if (!shown(el)) continue
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const covers = r.width * r.height > vw * vh * 0.04
    if (!(cs.position === 'fixed' || cs.position === 'sticky' || el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true') || !covers || !inView(el)) continue
    const btns = Array.from(el.querySelectorAll('button,a[href],[role=button]')).filter(shown).map((b) => clean((b as HTMLElement).innerText || b.getAttribute('aria-label'), 30)).filter(Boolean).slice(0, 5)
    overlays.push(`${clean((el as HTMLElement).innerText, 110)}${btns.length ? ` [buttons: ${btns.join(' | ')}]` : ''}`)
    if (overlays.length >= 3) break
  }

  const lines = ((document.body?.innerText ?? '') as string)
    .split('\n')
    .map((l) => clean(l, 120))
    .filter((l) => l.length > 1)
    .slice(0, 400)

  return {
    title: clean(document.title, 80),
    scrollY: Math.round(sy),
    pageH: Math.round(document.documentElement.scrollHeight),
    viewW: vw,
    viewH: vh,
    sections: sections.map(({ el: _el, ...s }) => s).slice(0, 60),
    controls,
    items: items.map(({ el: _el, ...i }) => ({ ...i, controls: [] as string[] })).slice(0, 80),
    charts: charts.slice(0, 8),
    overlays,
    lines
  }
}

export async function studyPage(page: Page, maxControls = MAX_CONTROLS): Promise<PageStudy> {
  const s = await page.evaluate(readPage, maxControls)
  const study: PageStudy = { url: page.url(), ...s }
  for (const it of study.items) it.controls = study.controls.filter((c) => c.item === it.n).map((c) => c.label)
  return study
}

/** a small picture of the screen for the model that looks at it */
export async function screenshotForModel(page: Page): Promise<{ mimeType: string; base64: string } | null> {
  try {
    const png = (await page.screenshot({ type: 'png' })) as Uint8Array
    const jpg = await sharp(Buffer.from(png)).resize({ width: 1000, withoutEnlargement: true }).jpeg({ quality: 62 }).toBuffer()
    return { mimeType: 'image/jpeg', base64: jpg.toString('base64') }
  } catch {
    return null
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}£$€%.]+/gu, ' ').trim()

/** what changed on screen between two looks: lines that appeared, lines that went, and whether the view moved */
export function diffStudy(before: PageStudy, after: PageStudy): { appeared: string[]; gone: string[]; moved: boolean; navigated: boolean } {
  const a = new Set(before.lines.map(norm))
  const b = new Set(after.lines.map(norm))
  const appeared = after.lines.filter((l) => !a.has(norm(l))).slice(0, 8)
  const gone = before.lines.filter((l) => !b.has(norm(l))).slice(0, 6)
  const path = (u: string): string => {
    try {
      const x = new URL(u)
      return x.pathname + x.search + x.hash
    } catch {
      return u
    }
  }
  return { appeared, gone, moved: Math.abs(before.scrollY - after.scrollY) > 40, navigated: path(before.url) !== path(after.url) }
}

// ---------------------------------------------------------------- the outline in words

const q = (s: string): string => `"${s.replace(/"/g, "'")}"`

/** the page outline the model reads; `secrets` are kept out of it by the caller's scrub */
export function renderStudy(s: PageStudy, o: { maxChars?: number; scrub?: (t: string) => string } = {}): string {
  const scrub = o.scrub ?? ((t: string) => t)
  const out: string[] = []
  out.push(`PAGE ${q(s.title)} ${s.url}`)
  out.push(`View: scrolled ${s.scrollY}px of ${s.pageH}px, window ${s.viewW}×${s.viewH}.`)
  if (s.overlays.length) out.push(`IN FRONT OF THE PAGE (blocks it until closed): ${s.overlays.map((o2) => scrub(o2)).join(' // ')}`)
  const secs = s.sections
  out.push(`SECTIONS in page order (y = px from top; * = on screen now): ${secs.length ? secs.map((x) => `${x.inView ? '*' : ''}${q(x.heading)}@${x.y}`).join(' · ') : '(no headings)'}`)
  if (s.charts.length) out.push(`CHARTS (drawn, no text inside; marks are picked by colour or position): ${s.charts.map((c) => `${q(c.title)} ${c.kind}@${c.y}${c.inView ? '*' : ''}`).join(' · ')}`)
  const bySection = new Map<string, StudyControl[]>()
  for (const c of s.controls) {
    const k = c.section || '(top of page)'
    bySection.set(k, [...(bySection.get(k) ?? []), c])
  }
  out.push('CONTROLS by section (c# kind "exact label" [state]; item# = which card/row it belongs to; same=N means N controls share this label):')
  for (const [sec, cs] of bySection) {
    const y = secs.find((x) => x.heading === sec)?.y
    out.push(` § ${sec}${y !== undefined ? ` @${y}` : ''}`)
    for (const c of cs) {
      const st = [
        c.inView ? 'on screen' : '',
        c.collapsed ? 'FOLDED (press to open)' : '',
        c.disabled ? 'disabled' : '',
        c.checked !== undefined ? (c.checked ? 'ticked' : 'not ticked') : '',
        c.kind === 'range' ? `range ${c.min}–${c.max}, now ${c.value}` : '',
        c.kind === 'select' ? `now ${q(c.value ?? '')}, options ${(c.options ?? []).map(q).join(', ')}` : '',
        c.kind === 'input' ? `now ${q(c.value ?? '')}` : '',
        c.href ? `→ ${c.href}` : '',
        c.item ? `item${c.item}` : '',
        c.same > 1 ? `same=${c.same}` : ''
      ].filter(Boolean)
      out.push(`   c${c.i} ${c.kind} ${q(scrub(c.label))}${st.length ? ` [${st.join('; ')}]` : ''}`)
    }
  }
  if (s.items.length) {
    out.push('REPEATED ITEMS (cards / rows / list entries with their words):')
    let last = ''
    for (const it of s.items.slice(0, 60)) {
      if (it.section !== last) {
        out.push(` § ${it.section || '(top of page)'}`)
        last = it.section
      }
      out.push(`   item${it.n}: ${q(scrub(it.text))}`)
    }
  }
  const secText = secs.filter((x) => x.text).slice(0, 14)
  if (secText.length) {
    out.push('WHAT THE SECTIONS SAY (start of each):')
    for (const x of secText) out.push(` § ${x.heading}: ${scrub(x.text)}`)
  }
  const text = out.join('\n')
  return text.length > (o.maxChars ?? 14000) ? `${text.slice(0, o.maxChars ?? 14000)}\n…(outline cut)` : text
}
