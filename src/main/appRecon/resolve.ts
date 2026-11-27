/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { Page } from 'puppeteer-core'
import type { FindSpec, Rect } from '@shared/appRecon'
import { DEEP, frameOffset, framePrefix, framesOf } from './deep'

/**
 * Finds a control the way a person describes it: "the Ontology item in the left
 * menu", "the suggestion psychology", "the fit-to-view icon just above the pause
 * icon". It reads the page's own words (visible text, tooltips, labels, icon
 * names), where the thing sits (left, right, top, inside a menu or pane) and what
 * it is next to, scores every candidate, and returns the best one, or nothing.
 * It never guesses wildly: below a minimum score it says it did not find it.
 *
 * It looks everywhere a person can: the page, every open shadow root and every iframe. The address it returns is a
 * chain of CSS paths joined by ` >>> ` (see deep.ts), so a control in a frame or a shadow root is found again later.
 *
 * Wording is forgiving the way a person is: filler and role words are dropped ("daniel as the stylist" is "daniel"),
 * apostrophes do not matter ("mens" is "Men's"), a typo is one or two letters, a colour word matches a swatch drawn in that
 * colour, and an icon is called by what it does ("gear" is "settings", "heart" is "wishlist").
 */

export interface Found {
  /** the address of the control (see deep.ts: `a > b >>> c` crosses a shadow root or an iframe) */
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
  const STOP = new Set(['the', 'a', 'an', 'of', 'on', 'in', 'to', 'icon', 'button', 'tab', 'link', 'item', 'option', 'section', 'page', 'pane', 'panel', 'bar', 'box', 'field', 'menu', 'just', 'right', 'left', 'above', 'below', 'top', 'my', 'this', 'that', 'one', 'please', 'colour', 'color', 'swatch', 'dot', 'shade', 'choice', 'entry', 'toggle', 'control'])
  // words about the control, not part of its name
  const FILLER_TAIL = /\s+(?:(?:as|for|is|are|was|be|with|to be|from)\s+(?:the|my|our|a|an|your)\s+[\w'’ -]{1,30}|(?:is|are|looks?|seems?|works?|will do|would be)\s+(?:fine|good|ok|okay|great|perfect|best|enough|right)\b.*|please|one|option|button|icon|link|tab|here|there|again|too|now)$/i
  const stripFiller = (t: string): string => {
    let out = (t || '').trim()
    for (let i = 0; i < 3; i++) {
      const next = out.replace(FILLER_TAIL, '').replace(/^(?:the|a|an|my|our)\s+/i, '').trim()
      if (next === out) break
      out = next
    }
    return out
  }
  const SYN: Record<string, string[]> = {
    gear: ['settings', 'setting', 'preferences', 'cog', 'config', 'options'],
    cog: ['settings', 'gear', 'preferences'],
    cogwheel: ['settings', 'gear'],
    settings: ['gear', 'cog', 'preferences'],
    heart: ['wishlist', 'favourite', 'favorite', 'like', 'save', 'saved', 'favourites', 'favorites'],
    wishlist: ['heart', 'favourite', 'favorite'],
    favourite: ['heart', 'wishlist', 'star'],
    favorite: ['heart', 'wishlist', 'star'],
    bin: ['delete', 'remove', 'trash', 'clear', 'discard'],
    trash: ['delete', 'remove', 'bin', 'clear'],
    rubbish: ['delete', 'remove', 'trash'],
    bell: ['notifications', 'notification', 'alerts', 'alert', 'reminders'],
    magnifier: ['search', 'find'],
    magnifying: ['search', 'find'],
    glass: ['search', 'find'],
    cart: ['basket', 'bag', 'checkout', 'trolley'],
    basket: ['cart', 'bag', 'checkout'],
    bag: ['cart', 'basket'],
    person: ['account', 'profile', 'user', 'avatar'],
    user: ['account', 'profile', 'person', 'avatar'],
    profile: ['account', 'user', 'avatar'],
    pencil: ['edit', 'rename', 'write'],
    pen: ['edit', 'rename'],
    plus: ['add', 'new', 'create'],
    cross: ['close', 'dismiss', 'remove', 'clear', 'delete'],
    hamburger: ['menu', 'navigation', 'nav'],
    envelope: ['mail', 'email', 'inbox', 'message', 'messages'],
    mail: ['email', 'envelope', 'inbox'],
    house: ['home'],
    home: ['house', 'dashboard'],
    share: ['send'],
    arrow: ['next', 'prev', 'back', 'forward'],
    star: ['favourite', 'favorite', 'rating', 'rate'],
    download: ['export', 'save'],
    upload: ['import'],
    refresh: ['reload', 'sync'],
    reload: ['refresh'],
    info: ['help', 'about', 'details'],
    question: ['help'],
    lock: ['security', 'private', 'password'],
    filter: ['filters', 'refine'],
    funnel: ['filter', 'filters'],
    dots: ['more', 'menu', 'options', 'actions'],
    kebab: ['more', 'menu', 'options', 'actions'],
    ellipsis: ['more', 'menu', 'options', 'actions']
  }
  const COLOUR_WORDS = new Set(['red', 'orange', 'yellow', 'green', 'teal', 'cyan', 'blue', 'purple', 'violet', 'pink', 'brown', 'black', 'gray', 'grey', 'white', 'navy', 'gold', 'silver', 'maroon', 'magenta', 'crimson', 'olive', 'lime', 'indigo', 'beige', 'tan', 'khaki', 'turquoise'])
  const APOS = /['’‘ʼ`´]/g
  const normWords = (s: string): string[] =>
    (s || '')
      // arrows say which way a control goes: "< match" is the previous one, "match >" the next one
      .replace(/[<‹«◀◄←⟵❮⏴]/g, ' prev ')
      .replace(/[>›»▶►→⟶❯⏵]/g, ' next ')
      // "Men's" and "mens" are the same word
      .replace(APOS, '')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
  // a control named only by a symbol (a ✓ key, a ⌫ key, a trash can) has no words: its symbol is its name, the same mark in any of its forms
  const norm = (s: string): string[] => {
    const words = normWords(s)
    if (words.length) return words
    const sym = (s || '').normalize('NFKC').replace(/[\s\uFE0E\uFE0F\u200D]+/g, '').replace(/[✔☑✅]/g, '✓').replace(/[✕✖✗✘×]/g, '✕').replace(/[−–—]/g, '-')
    return sym ? ['sym' + Array.from(sym).map((c) => (c.codePointAt(0) ?? 0).toString(16)).join('_')] : []
  }
  const keyOf = (s: string): string[] => {
    const all = norm(s)
    const k = all.filter((w) => !STOP.has(w))
    return k.length ? k : all
  }
  const lev = (a: string, b: string): number => {
    if (Math.abs(a.length - b.length) > 2) return 9
    const d: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]
      d[0] = i
      for (let j = 1; j <= b.length; j++) {
        const tmp = d[j]
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = tmp
      }
    }
    return d[b.length]
  }
  /** a typo: one letter off for a word of 4 to 7 letters, two for a longer one */
  const typo = (w: string, t: string): boolean => w.length >= 4 && t.length >= 4 && lev(w, t) <= (w.length >= 8 ? 2 : 1)
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
  const attrs = (el: Element, names: string[]): string[] => names.map((n) => el.getAttribute(n) ?? '').filter(Boolean)
  const classTokens = (el: Element): string => (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : (el.getAttribute('class') ?? ''))
  const rootOf = (el: Element): Document | ShadowRoot => el.getRootNode() as Document | ShadowRoot
  const byId = (el: Element, id: string): HTMLElement | null => {
    const r = rootOf(el)
    return (r as Document).getElementById ? (r as Document).getElementById(id) : (r as ShadowRoot).querySelector('#' + CSS.escape(id))
  }
  /** the element a point shows, looking into shadow roots too */
  const deepFromPoint = (x: number, y: number): Element | null => {
    let t = document.elementFromPoint(x, y)
    for (let i = 0; i < 8 && t && (t as HTMLElement).shadowRoot; i++) {
      const n = (t as HTMLElement).shadowRoot!.elementFromPoint(x, y)
      if (!n || n === t) break
      t = n
    }
    return t
  }
  /** a contains b, across shadow roots */
  const composedContains = (a: Element, b: Element | null): boolean => {
    for (let n: Node | null = b; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === a) return true
    return false
  }

  // ---- colour of a swatch
  const colourName = (r: number, g: number, b: number): string | null => {
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const l = (mx + mn) / 510
    const d = mx - mn
    const s = d === 0 ? 0 : d / (255 - Math.abs(mx + mn - 255))
    if (l > 0.93) return 'white'
    if (l < 0.12) return 'black'
    if (s < 0.14) return l > 0.78 ? 'white' : 'gray'
    let h = 0
    if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    h = (h * 60 + 360) % 360
    if (h < 12 || h >= 346) return l > 0.78 ? 'pink' : 'red'
    if (h < 22 && l < 0.42) return 'brown'
    if (h < 40) return l < 0.4 ? 'brown' : 'orange'
    if (h < 68) return 'yellow'
    if (h < 160) return 'green'
    if (h < 190) return 'teal'
    if (h < 205) return 'cyan'
    if (h < 255) return 'blue'
    if (h < 300) return 'purple'
    return 'pink'
  }
  const parseRgb = (c: string): [number, number, number, number] | null => {
    const m = c.match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
    return p.length >= 3 ? [p[0], p[1], p[2], p.length > 3 ? p[3] : 1] : null
  }
  /** the colours an element is drawn in: its fill, its background, its ring, or the first thing inside it */
  const coloursOf = (el: Element): string[] => {
    const out = new Set<string>()
    const add = (c: string | null | undefined, minAlpha = 0.5) => {
      const p = c ? parseRgb(c) : null
      if (p && p[3] >= minAlpha) { const n = colourName(p[0], p[1], p[2]); if (n) out.add(n) }
    }
    const cs = getComputedStyle(el)
    add(cs.backgroundColor)
    if (el instanceof SVGElement) { add(cs.fill); add(cs.stroke) }
    if (!out.size && parseFloat(cs.borderTopWidth) >= 2) add(cs.borderTopColor)
    if (!out.size) { const c = el.firstElementChild; if (c && rectOf(c).width < 60) { const cc = getComputedStyle(c); add(cc.backgroundColor); if (c instanceof SVGElement) add(cc.fill) } }
    return Array.from(out)
  }

  const strongOf = (el: Element): string[] => {
    const out = attrs(el, ['aria-label', 'title', 'alt', 'placeholder', 'data-tooltip', 'data-tip', 'data-title', 'data-original-title', 'data-bs-original-title', 'mattooltip', 'aria-description', 'data-label'])
    const t = textOf(el)
    if (t && t.length <= 160) out.push(t)
    const v = (el as HTMLInputElement).value
    if (v && /^(button|submit)$/i.test((el as HTMLInputElement).type || '')) out.push(v)
    // a box that holds a document (a request body) is also named by the names written in it ("plan" in {"plan": "pro"})
    if (el.tagName === 'TEXTAREA' && v && v.length <= 300) out.push(v)
    const st = el.querySelector('svg title')?.textContent
    if (st) out.push(st)
    const ia = el.querySelector('img[alt]')?.getAttribute('alt')
    if (ia) out.push(ia)
    const by = el.getAttribute('aria-labelledby')
    if (by) { const l = byId(el, by.split(' ')[0]); if (l) out.push(textOf(l)) }
    const lab = (el as HTMLInputElement).labels?.[0]
    if (lab) out.push(textOf(lab))
    // a dropdown is usually named by the small text beside it ("TEXT TO STUDY"), not by its own entries
    if (el.tagName === 'SELECT' || el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'listbox') {
      // the few elements in front of it (a label, then maybe a "previous" arrow)
      for (let p = el.previousElementSibling, i = 0; p && i < 3; p = p.previousElementSibling, i++) {
        const t2 = textOf(p)
        if (t2 && t2.length <= 60) out.push(t2)
      }
      const own = Array.from(el.parentElement?.childNodes ?? []).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim()
      if (own && own.length <= 60) out.push(own)
      const wrap = el.parentElement ? textOf(el.parentElement) : ''
      if (el.tagName === 'SELECT' && wrap && wrap.length <= 60) out.push(wrap)
    }
    // a slider or a bare box is named by the text just before it
    if (/^(range|number|date|time|datetime-local|month|week)$/i.test((el as HTMLInputElement).type || '') || el.getAttribute('role') === 'slider' || el.hasAttribute('contenteditable')) {
      const p = el.previousElementSibling
      const t2 = p ? textOf(p) : ''
      if (t2 && t2.length <= 50) out.push(t2)
      const wrap = el.parentElement ? textOf(el.parentElement) : ''
      if (wrap && wrap.length <= 60) out.push(wrap)
    }
    // a tooltip that lives in a child element
    const tip = el.querySelector('[role=tooltip],.tooltip,[class*=tooltip]')
    if (tip) out.push(textOf(tip))
    return out
  }
  const weakOf = (el: Element): string[] => {
    const out = [el.id, classTokens(el), el.getAttribute('name') ?? '', ...attrs(el, ['data-testid', 'data-icon', 'data-action', 'data-id', 'data-test', 'data-cy', 'data-value', 'value'])]
    const href = el.getAttribute('href')
    if (href) out.push(href.split(/[/?#]/).filter(Boolean).pop() ?? '')
    const img = el.querySelector('img')?.getAttribute('src')
    if (img) out.push((img.split('/').pop() ?? '').replace(/\.\w+$/, ''))
    const use = el.querySelector('use')?.getAttribute('href') ?? el.querySelector('use')?.getAttribute('xlink:href')
    if (use) out.push(use)
    for (const c of Array.from(el.querySelectorAll('i,svg,span')).slice(0, 3)) out.push(classTokens(c), c.getAttribute('data-icon') ?? '')
    return out.filter(Boolean)
  }

  // the person's words: as written, and without the filler
  const variants = (() => {
    const set: string[] = [spec.target]
    const s = stripFiller(spec.target)
    if (s && s !== spec.target) set.push(s)
    // a symbol described in words ("the green button with tick mark", "the cross"): the symbol is the control's name
    const SYMBOL_WORDS: Array<[RegExp, string]> = [
      [/\b(?:tick|check)\s*-?\s*marks?\b|\bcheckmarks?\b|\bticks?\b|\bcheck\s+sign\b/gi, '✓'],
      [/\b(?:cross|x)\s*-?\s*marks?\b|\bcross\b/gi, '✕'],
      [/\bbackspace\b|\bdelete\s+key\b/gi, '⌫']
    ]
    for (const [re, symbol] of SYMBOL_WORDS) {
      if (!re.test(spec.target)) continue
      const rest = normWords(spec.target.replace(re, ' ')).filter((w) => !COLOUR_WORDS.has(w) && !STOP.has(w) && !['with', 'sign', 'symbol', 'key', 'mark', 'shaped', 'that', 'ha', 'has', 'showing', 'small', 'big', 'round'].includes(w))
      if (!rest.length) { set.push(symbol); break }
    }
    return set
  })()
  const keys = variants.map((v) => ({ full: v, key: keyOf(v) })).filter((k) => k.key.length)
  const key = keys[keys.length - 1]?.key ?? keyOf(spec.target)
  const colourWanted = Array.from(new Set(norm(spec.target).filter((w) => COLOUR_WORDS.has(w)))).map((w) => (w === 'grey' ? 'gray' : w))
  /** a key with each word that has a synonym swapped for it (an icon is called by what it does) */
  const synonymKeys = (k: string[]): string[][] => {
    const out: string[][] = []
    k.forEach((w, i) => {
      for (const s of SYN[w] ?? []) if (out.length < 12) out.push(k.map((x, j) => (j === i ? s : x)))
    })
    return out
  }

  const scoreWith = (el: Element, k: string[], fullText: string, penalty: number): number => {
    if (!k.length) return 0
    let best = 0
    const fullNorm = norm(fullText)
    for (const s of strongOf(el)) {
      const ts = norm(s)
      let fuzzy = 0
      const have = k.filter((w) => {
        if (ts.includes(w) || (w.length >= 4 && ts.some((t) => t.startsWith(w)))) return true
        if (ts.some((t) => typo(w, t))) { fuzzy++; return true }
        return false
      })
      const frac = have.length / k.length
      let sc = 0
      if (frac === 1) {
        sc = 100
        const same = ts.length === fullNorm.length && ts.every((t, i) => t === fullNorm[i])
        if (same) sc += 40
        else sc += Math.max(0, 25 - Math.max(0, ts.length - k.length) * 3)
        if (ts.length > 12) sc -= 30
        sc -= fuzzy * 8
      } else if (frac >= 0.5) sc = 40 * frac
      best = Math.max(best, sc - penalty)
    }
    const wt = weakOf(el).flatMap(norm)
    if (wt.length) {
      const have = k.filter((w) => wt.includes(w) || wt.some((t) => t.length >= 3 && (t.startsWith(w) || (w.length >= 4 && w.startsWith(t)))))
      const frac = have.length / k.length
      best = Math.max(best, (frac === 1 ? 55 : frac >= 0.5 ? 25 * frac : 0) - penalty)
    }
    return best
  }
  const scoreText = (el: Element, k: string[], full: string): number => {
    let best = 0
    // what was written, then without the filler, each as itself
    if (k === key) {
      for (const v of keys) best = Math.max(best, scoreWith(el, v.key, v.full, 0))
      if (best < 100) for (const v of keys) for (const alt of synonymKeys(v.key)) best = Math.max(best, scoreWith(el, alt, v.full, 6))
    } else best = scoreWith(el, k, full, 0)
    return best
  }

  const INTERACTIVE = 'a,button,input,select,textarea,summary,label,[role=button],[role=tab],[role=menuitem],[role=option],[role=treeitem],[role=link],[role=switch],[role=checkbox],[role=radio],[role=searchbox],[role=combobox],[role=textbox],[role=slider],[role=gridcell],[tabindex],[onclick],[draggable=true],li,[contenteditable],[class*=btn],[class*=icon],[class*=item],[class*=tab],[class*=suggest],[class*=option],[class*=swatch]'
  const EDITOR = '.cm-content,.CodeMirror,.monaco-editor,.ace_editor,.ProseMirror,.ql-editor,.trix-content,.tox-edit-area,[role=textbox]'
  const isEditable = (el: Element): boolean => {
    const ce = el.getAttribute('contenteditable')
    return ce !== null && ce !== 'false'
  }
  const isField = (el: Element): boolean => {
    const t = el.tagName
    if (t === 'TEXTAREA') return shown(el) || !!el.closest(EDITOR)
    if (t === 'INPUT') return !/^(button|submit|reset|checkbox|radio|image|hidden|file|range|color|password)$/i.test((el as HTMLInputElement).type)
    if (isEditable(el)) return true
    if (el.matches(EDITOR)) return true
    return /^(searchbox|textbox|combobox)$/.test(el.getAttribute('role') ?? '')
  }
  const listening = (window as unknown as { __vgListening?: WeakSet<Element> }).__vgListening
  // every element of the page, the ones in open shadow roots too
  const all: Element[] = []
  const collect = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (all.length >= 12000) return
      all.push(el)
      const sr = (el as HTMLElement).shadowRoot
      if (sr) collect(sr)
    }
  }
  collect(document)
  const pool: Element[] = []
  for (const el of all) {
    if (/^(HTML|BODY|HEAD|SCRIPT|STYLE|META|LINK|TITLE|NOSCRIPT|BR|HR|SLOT)$/.test(el.tagName)) continue
    if (spec.kind === 'type') {
      if (isField(el) && shown(el)) {
        // the hidden box inside an editor is not the place to type: the editor itself is
        const outer = el.closest(EDITOR)
        if (outer && outer !== el && shown(outer)) continue
        pool.push(el)
      }
      continue
    }
    if (spec.kind === 'select') { if ((el.tagName === 'SELECT' || /^(combobox|listbox)$/.test(el.getAttribute('role') ?? '') || el.getAttribute('aria-haspopup') === 'listbox') && shown(el)) pool.push(el); continue }
    if (!shown(el)) continue
    if (el.matches(INTERACTIVE)) { pool.push(el); continue }
    if (listening?.has(el)) { pool.push(el); continue }
    if (/^(svg|path|g|circle|rect|text|use|i|img|span|div|p|td|th|figure|article|section)$/i.test(el.tagName) && el.parentElement) {
      const cs = getComputedStyle(el)
      const pc = getComputedStyle(el.parentElement).cursor
      if (/^(pointer|grab|grabbing|move)$/.test(cs.cursor) && cs.cursor !== pc) pool.push(el)
    }
  }
  const clickable = spec.kind === 'type' || spec.kind === 'select' ? pool : pool.filter((el) => !isField(el))

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
    suggestion: /suggest|autocomplete|dropdown|listbox|option|popup|popover|results|combobox/,
    legend: /legend|key/,
    dialog: /dialog|modal|popup|popover/,
    form: /form|fieldset/
  }
  const ancestry = (el: Element): string => {
    const out: string[] = []
    let n: Element | null = el.parentElement
    for (let i = 0; i < 10 && n && n !== document.body; i++, n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null)) out.push([n.id, classTokens(n), n.getAttribute('role') ?? '', n.getAttribute('aria-label') ?? '', n.tagName].join(' ').toLowerCase())
    return out.join(' | ')
  }

  const anchorInput = ((): Element | null => {
    const a = document.activeElement
    if (a && isField(a) && shown(a)) return a
    return Array.from(document.querySelectorAll('input,textarea')).filter((e) => isField(e) && shown(e)).find((e) => /search|filter|find|query/i.test(`${(e as HTMLInputElement).type} ${e.getAttribute('placeholder') ?? ''} ${e.getAttribute('name') ?? ''} ${e.id} ${classTokens(e)}`)) ?? null
  })()

  // what a relation points at ("the chart", "the price list"): any element that has a name, a control or not
  const refs = ((): Element | null => {
    if (!spec.relation) return null
    const rk = keyOf(spec.relation.to)
    const things: Element[] = [...clickable]
    for (const el of all) {
      if (/^(CANVAS|FIGURE|TABLE|IMG|H1|H2|H3|H4|SECTION|ASIDE|FORM|UL|OL)$/.test(el.tagName) || (el.tagName.toLowerCase() === 'svg' && rectOf(el).width > 90) || /chart|graph|plot|map|table|list|card/i.test(classTokens(el) + ' ' + el.id)) if (shown(el) && !things.includes(el)) things.push(el)
    }
    const chartish = rk.some((w) => /^(chart|graph|plot|diagram)$/.test(w))
    let best: { el: Element; s: number } | null = null
    for (const el of things) {
      let s = scoreText(el, rk, spec.relation.to)
      if (chartish && (el.tagName === 'CANVAS' || (el.tagName.toLowerCase() === 'svg' && rectOf(el).width > 120) || /chart|graph|plot/i.test(classTokens(el) + ' ' + el.id))) s = Math.max(s, 70) + Math.min(10, (rectOf(el).width * rectOf(el).height) / 20000)
      if (s >= minScore && (!best || s > best.s)) best = { el, s }
    }
    return best?.el ?? null
  })()

  const ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/
  const arabicWanted = key.includes('arabic')
  const scored: Array<{ el: Element; s: number; label: string }> = []
  const nameKey = key.filter((w) => !COLOUR_WORDS.has(w))
  for (const el of clickable) {
    if (el === refs || (refs && composedContains(el, refs))) continue
    let s = scoreText(el, key, spec.target)
    // a colour named: the swatch drawn in it (or, with more words, a control that has them and is drawn in it)
    if (colourWanted.length && spec.kind !== 'type') {
      const r0 = rectOf(el)
      const dr = coloursOf(el)
      const hit = colourWanted.some((c) => dr.includes(c))
      if (hit && r0.width <= 140 && r0.height <= 140) {
        const base = nameKey.length ? scoreWith(el, nameKey, nameKey.join(' '), 0) : 0
        s = Math.max(s, nameKey.length ? (base >= 40 ? 90 + base / 10 : 0) : 88 + (textOf(el).length <= 2 ? 6 : 0))
      } else if (!hit && dr.length && nameKey.length === 0 && r0.width <= 140) s = Math.min(s, 20)
    }
    // "the arabic word": the page's words are Arabic script, which a plain-letter match cannot read
    if (arabicWanted && s < minScore && ARABIC.test(textOf(el)) && textOf(el).length <= 40) s = 60
    if ((spec.kind === 'type' || spec.kind === 'select') && s < minScore && !key.length) s = 50
    if (spec.kind === 'type' && (el as HTMLInputElement).type === 'search') s += 25
    if (spec.kind === 'type' && s < minScore && /search|filter|find|query/.test(`${el.id} ${classTokens(el)} ${el.getAttribute('name') ?? ''} ${el.getAttribute('placeholder') ?? ''}`.toLowerCase()) && key.every((w) => /search|filter|find|query|text|input/.test(w))) s = 60
    if (s <= 0) continue
    const r = rectOf(el)
    const cx = (r.left + r.right) / 2
    const cy = (r.top + r.bottom) / 2
    // a phone stacks the page in one column: "on the right" says nothing about where a control is there
    const reg = vw < 700 && (spec.region === 'left' || spec.region === 'right') ? undefined : spec.region
    if (reg === 'left') s += cx < vw * 0.38 ? 25 : -45
    if (reg === 'right') s += cx > vw * 0.58 ? 25 : -45
    if (reg === 'top') s += cy < vh * 0.32 ? 25 : -35
    if (reg === 'bottom') s += cy > vh * 0.68 ? 25 : -35
    const anc = ancestry(el)
    for (const w of spec.within ?? []) {
      // a word the page may use for the area ("verse", "details") is looked for as it is
      const re = WITHIN[w.toLowerCase()] ?? (w.length >= 3 ? new RegExp(w.toLowerCase().replace(/[^a-z0-9]/g, '.')) : null)
      if (re && re.test(anc + ' | ' + [el.id, classTokens(el), el.getAttribute('aria-label') ?? '', el.getAttribute('name') ?? ''].join(' ').toLowerCase())) s += 30
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
      const top = deepFromPoint(cx, cy)
      if (top && !(composedContains(el, top) || composedContains(top, el))) s -= 35
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

/** looks for the control everywhere on the page (its frames included), waiting while the page draws it (menus open, suggestions arrive) */
export async function findElement(page: Page, spec: FindSpec, waitMs = 8000, minScore = MIN_SCORE): Promise<{ found: Found | null; miss?: Miss }> {
  const until = Date.now() + waitMs
  let miss: Miss | undefined
  for (;;) {
    const frames = framesOf(page)
    const rs = await Promise.all(frames.map(async (f) => ({ f, r: (await f.evaluate(locate, spec, minScore).catch(() => null)) as Result | null })))
    const hits = rs.filter((x): x is { f: (typeof frames)[number]; r: { ok: true } & Found } => !!x.r && x.r.ok)
    if (hits.length) {
      hits.sort((a, b) => b.r.score - a.r.score)
      const { f, r } = hits[0]
      if (f === page.mainFrame()) return { found: { selector: r.selector, rect: r.rect, label: r.label, score: r.score } }
      const off = await frameOffset(page, f)
      const prefix = await framePrefix(page, f)
      return { found: { selector: [...prefix, r.selector].join(DEEP), rect: { x: r.rect.x + off.x, y: r.rect.y + off.y, w: r.rect.w, h: r.rect.h }, label: r.label, score: r.score } }
    }
    const closest = rs.flatMap((x) => (x.r && !x.r.ok ? x.r.closest : []))
    if (rs.some((x) => x.r && !x.r.ok)) miss = { closest: closest.slice(0, 5) }
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
