/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { Page } from 'puppeteer-core'
import type { FindSpec } from '@shared/appRecon'

/**
 * Parts of a page, by the name a person gives them.
 *
 * "scroll down to Whole-Quran even–odd circle" names a heading far below the first screen. It is found by its words
 * (any kind of dash, accents, plural or not), and the page is then scrolled to it the way a hand does it, so the viewer
 * sees the page travel there. A part that sits behind a toggle (a collapsed side panel on a phone, a closed <details>) is
 * opened by `revealHidden` first.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** waits until the page has stopped scrolling (a page can scroll smoothly, over a second) */
export async function settleScroll(page: Page, maxMs = 3000): Promise<void> {
  const until = Date.now() + maxMs
  let last = -1
  let still = 0
  while (Date.now() < until && still < 2) {
    await sleep(90)
    const y = await page.evaluate(() => scrollY).catch(() => -1)
    still = y === last ? still + 1 : 0
    last = y
  }
}

export interface SectionHit {
  ok: true
  selector: string
  label: string
  /** how far from the top of the page it is */
  top: number
  score: number
}
export interface SectionMiss {
  ok: false
  closest: string[]
}

/** in the page: the heading or label whose words are the ones given */
function locateSection(text: string, relaxed: boolean): SectionHit | SectionMiss {
  const STOP = new Set(['the', 'a', 'an', 'of', 'on', 'in', 'to', 'section', 'area', 'part', 'chart', 'graph', 'block', 'heading', 'panel', 'page', 'below', 'above'])
  const words = (s: string): string[] =>
    s
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[̀-ͯ]/g, '')
      .replace(/[‐-―−\-_/]+/g, ' ')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
  const all = words(text)
  const want = all.filter((w) => !STOP.has(w))
  const key = want.length ? want : all
  if (!key.length) return { ok: false, closest: [] }
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
  const HEADING = /^(H1|H2|H3|H4|H5|H6|SUMMARY|LEGEND|CAPTION|TH|DT|LABEL)$/
  const scored: Array<{ el: Element; s: number; text: string }> = []
  const pool = Array.from(document.querySelectorAll('*')).slice(0, 12000)
  for (const el of pool) {
    if (/^(HTML|BODY|HEAD|SCRIPT|STYLE|META|LINK|TITLE|NOSCRIPT|SVG|PATH|CANVAS|OPTION|SELECT|INPUT|TEXTAREA)$/i.test(el.tagName)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!t || t.length > 160) continue
    // a wrapper around the heading says the same words: the innermost element is the one meant
    if (Array.from(el.children).some((c) => ((c as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim() === t)) continue
    const tw = words(t)
    const have = key.filter((w) => tw.includes(w) || (w.length >= 4 && tw.some((x) => x.startsWith(w) || w.startsWith(x))))
    const frac = have.length / key.length
    if (frac < (relaxed ? 0.5 : 1)) { if (frac > 0) scored.push({ el, s: frac * 30, text: t }); continue }
    let s = 100 * frac
    const extra = Math.max(0, tw.length - key.length)
    s += tw.length === key.length ? 40 : Math.max(0, 25 - extra * 4)
    if (HEADING.test(el.tagName) || el.getAttribute('role') === 'heading') s += 25
    const fs = parseFloat(cs.fontSize) || 14
    if (fs >= 18) s += 8
    if (cs.fontWeight === 'bold' || Number(cs.fontWeight) >= 600) s += 6
    scored.push({ el, s, text: t })
  }
  scored.sort((a, b) => b.s - a.s)
  const best = scored[0]
  if (!best || best.s < (relaxed ? 45 : 90)) return { ok: false, closest: scored.slice(0, 5).map((c) => c.text.slice(0, 50)) }
  const r = best.el.getBoundingClientRect()
  return { ok: true, selector: cssPath(best.el), label: best.text.slice(0, 80), top: r.top + scrollY, score: Math.round(best.s) }
}

/** in the page: where the named part sits now, and the words of the card or section around it */
function whereIs(sel: string): { top: number; vh: number; area: string } | null {
  const el = document.querySelector(sel) as HTMLElement | null
  if (!el) return null
  const r = el.getBoundingClientRect()
  const box = el.closest('section,article,[class*=card],[class*=panel],[class*=box]') as HTMLElement | null
  const area = (box ?? el.parentElement ?? el).innerText.replace(/\s+/g, ' ').trim().slice(0, 1800)
  return { top: r.top, vh: innerHeight, area }
}

export interface SectionOutcome {
  found: boolean
  label?: string
  /** the words of the area now on screen, for the narration */
  text: string
  /** the page really moved */
  moved: boolean
  closest?: string[]
}

/**
 * Scrolls until the named part is near the top of the screen. Nothing is clicked. `instant` jumps there (the scouting run);
 * otherwise the wheel is turned in steps, taking about `budgetMs`, so the film shows the page travelling.
 */
export async function scrollToSection(page: Page, text: string, o: { budgetMs: number; instant: boolean; mouseTo?: (x: number, y: number) => Promise<void> }): Promise<SectionOutcome> {
  let hit = (await page.evaluate(locateSection, text, false).catch(() => null)) as SectionHit | SectionMiss | null
  if (!hit?.ok) hit = (await page.evaluate(locateSection, text, true).catch(() => null)) as SectionHit | SectionMiss | null
  if (!hit?.ok) return { found: false, text: '', moved: false, closest: hit && !hit.ok ? hit.closest : [] }
  const startY = await page.evaluate(() => scrollY)
  const want = 70 // the heading ends up just under the top edge
  if (o.instant) {
    await page.evaluate((sel, w) => {
      const el = document.querySelector(sel)
      if (!el) return
      el.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior })
      window.scrollBy({ top: -w, behavior: 'instant' as ScrollBehavior })
    }, hit.selector, want)
    await settleScroll(page)
  } else {
    const first = await page.evaluate(whereIs, hit.selector)
    const dist = first ? Math.abs(first.top - want) : 0
    const stops = Math.max(3, Math.min(30, Math.ceil(dist / 300)))
    const wait = Math.max(45, Math.min(260, o.budgetMs / stops))
    const vw = await page.evaluate(() => innerWidth)
    const vh = await page.evaluate(() => innerHeight)
    await (o.mouseTo ? o.mouseTo(vw / 2, vh / 2) : page.mouse.move(vw / 2, vh / 2))
    let stalled = 0
    for (let i = 0; i < 60; i++) {
      const w = await page.evaluate(whereIs, hit.selector)
      if (!w) break
      const remaining = w.top - want
      if (Math.abs(remaining) < 24) break
      const before = await page.evaluate(() => scrollY)
      const step = Math.sign(remaining) * Math.min(Math.abs(remaining), 320)
      await page.mouse.wheel({ deltaY: step })
      await sleep(wait)
      const after = await page.evaluate(() => scrollY)
      stalled = Math.abs(after - before) < 2 ? stalled + 1 : 0
      if (stalled >= 2) {
        // the wheel does not move this part (it sits in a scrolled box): bring it into view directly
        await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), hit.selector)
        await sleep(700)
        break
      }
    }
  }
  const endY = await page.evaluate(() => scrollY)
  const end = await page.evaluate(whereIs, hit.selector)
  const onScreen = !!end && end.top > -20 && end.top < end.vh * 0.9
  return { found: true, label: hit.label, text: end?.area ?? '', moved: Math.abs(endY - startY) > 2 || onScreen }
}

export interface Toggle {
  selector: string
  label: string
  rect: { x: number; y: number; w: number; h: number }
}

/**
 * The part the step names is not on the page right now: it can be inside a closed <details>, or in a panel that a phone keeps
 * folded away behind a button. A closed <details> is opened here; for a folded panel the button that opens it is returned (the
 * caller presses it, behind the same rules as every other click).
 */
export async function revealHidden(page: Page, spec: FindSpec): Promise<Toggle | 'opened' | null> {
  return (await page
    .evaluate((target) => {
      const norm = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
      const need = norm(target).split(' ').filter((w) => w.length > 1 && !['the', 'tab', 'button', 'icon', 'link'].includes(w))
      if (!need.length) return null
      const isShown = (el: Element) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const hasWords = (el: Element) => {
        const t = norm(((el as HTMLElement).textContent ?? '') + ' ' + (el.getAttribute('aria-label') ?? '') + ' ' + (el.getAttribute('title') ?? ''))
        return need.every((w) => t.includes(w))
      }
      const cssPath = (el: Element): string => {
        if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) return '#' + CSS.escape(el.id)
        const parts: string[] = []
        for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
          if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break }
          const sibs = Array.from(n.parentElement?.children ?? [])
          parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
        }
        return parts.join(' > ')
      }
      // 1. the words are inside a closed <details>
      for (const d of Array.from(document.querySelectorAll('details:not([open])'))) {
        if (!hasWords(d)) continue
        const sum = d.querySelector('summary')
        if (sum && isShown(sum)) {
          const r = sum.getBoundingClientRect()
          return { selector: cssPath(sum), label: ((sum as HTMLElement).innerText || '').trim().slice(0, 60), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }
        }
        ;(d as HTMLDetailsElement).open = true
        return 'opened' as const
      }
      // 2. the words are in something that is not drawn: find what shows it
      const hidden = Array.from(document.querySelectorAll('body *')).filter((el) => !isShown(el) && !/^(SCRIPT|STYLE|OPTION|TITLE|META|LINK|NOSCRIPT|TEMPLATE|HEAD)$/.test(el.tagName) && hasWords(el) && (el.textContent ?? '').length < 400)
      for (const h of hidden.slice(0, 12)) {
        // the outermost box that is not drawn
        let box: Element = h
        while (box.parentElement && !isShown(box.parentElement) && box.parentElement !== document.body) box = box.parentElement
        const idOrClass = [box.id, typeof (box as HTMLElement).className === 'string' ? (box as HTMLElement).className : ''].join(' ').trim()
        const toggles = Array.from(document.querySelectorAll('button,a,[role=button],summary,[aria-controls],[aria-expanded],[data-target],[data-bs-target],[data-toggle],label')).filter(isShown)
        const direct = toggles.find((t) => box.id && [t.getAttribute('aria-controls'), t.getAttribute('data-target'), t.getAttribute('data-bs-target'), t.getAttribute('href')].some((v) => v && v.replace(/^#/, '').split(/\s+/).includes(box.id)))
        const byName = toggles.find((t) => {
          if (!idOrClass) return false
          const name = norm(`${t.getAttribute('aria-label') ?? ''} ${t.getAttribute('title') ?? ''} ${t.id} ${typeof (t as HTMLElement).className === 'string' ? (t as HTMLElement).className : ''} ${(t as HTMLElement).innerText ?? ''}`)
          const toks = norm(idOrClass).split(' ').filter((w) => w.length > 3 && !/^(hidden|collapse|collapsed|closed|show|open|panel|pane|body|content)$/.test(w))
          return toks.some((w) => name.includes(w)) && /toggle|open|menu|panel|pane|details|info|more|show|expand|side/.test(name)
        })
        const t = direct ?? byName
        if (t) {
          const r = t.getBoundingClientRect()
          return { selector: cssPath(t), label: ((t as HTMLElement).innerText || t.getAttribute('aria-label') || t.getAttribute('title') || '').trim().slice(0, 60), rect: { x: r.x, y: r.y, w: r.width, h: r.height } }
        }
      }
      return null
    }, spec.target)
    .catch(() => null)) as Toggle | 'opened' | null
}
