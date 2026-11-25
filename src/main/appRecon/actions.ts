/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import sharp from 'sharp'
import type { ElementHandle, Frame, Page } from 'puppeteer-core'
import type { Rect } from '@shared/appRecon'
import { classifyField, isSensitive } from './sensitivity'
import { findPrivate } from './detect'
import { deepHandle, framesOf, frameOffset } from './deep'
import { clearOverlays, policyFromWhenever, type OverlayPolicy, type Whenever } from './overlays'
import { newTexts, snapshotTexts } from './marks'

/**
 * The primitives every action is built from, shared by the rehearsal (script.ts, which learns the steps) and the recording
 * (recorder.ts, which films them):
 *
 *  - before an action, whatever sits over the target (a pop-up, a cookie banner) is closed, and the point pressed is one
 *    that really shows the target (a hit test), never one an overlay covers;
 *  - after an action the page is compared with how it was (address, words, markup, focus, scroll, a picture of the area),
 *    and the click is also watched where it landed, so "an overlay took the click" is known, not guessed;
 *  - a click that did not land is retried once differently (another point, the keyboard, a model looking at the screen),
 *    and an action that cannot be shown to have worked is reported as such, never as done.
 */

export const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface Env {
  page: Page
  /** the person's own rules: false refuses to press a control with this name */
  allow?: (label: string) => boolean
  log: (m: string) => void
  /** moves the pointer the way the film shows it; without it the pointer goes straight there */
  move?: (x: number, y: number, ms?: number) => Promise<void>
  /** 0 while rehearsing (no showing-off pauses), 1 while filming */
  pace: number
}

export interface Outcome {
  /** actions really performed */
  did: number
  /** the page looked different afterwards */
  changed: boolean
  /** the page showed the effect that was expected (a click that landed AND changed something, a value that reads back right...) */
  verified: boolean
  /** the pointer / key reached the target (false: something else took it) */
  landed?: boolean
  seen: string[]
  /** overlays closed on the way, in words */
  closed: string[]
  /** why nothing was done (set when did is 0) */
  skipped?: { what: string; why: string }
  /** something worth telling the run's notes (done, but no visible change) */
  note?: string
  /** the address of what was used last */
  last?: string
  /** where the pointer was put (viewport pixels) */
  at?: { x: number; y: number }
  rect?: Rect
}

export const blank = (): Outcome => ({ did: 0, changed: false, verified: false, seen: [], closed: [] })

// ---------------------------------------------------------------- the person's standing rules

const rules = new WeakMap<Page, Whenever[]>()
/** arms a rule for the rest of the run on this page ("whenever a cookie banner shows, accept only the essentials") */
export function armWhenever(page: Page, w: Whenever): void {
  rules.set(page, [...(rules.get(page) ?? []).filter((x) => x.condition !== w.condition), w])
}
export function policyOf(page: Page): OverlayPolicy {
  return policyFromWhenever(rules.get(page))
}

// ---------------------------------------------------------------- what the page looks like

interface Sig {
  text: string
  dom: string
  scroll: number
  focus: string
  mut: number
}

/** in the page: a short fingerprint of what can be seen and what state the controls are in */
function sigIn(): Sig {
  const hash = (s: string): string => {
    let h = 5381
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
    return s.length + ':' + h
  }
  const body = (document.body?.innerText ?? '').replace(/\s+/g, ' ')
  const all: Element[] = []
  const collect = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (all.length >= 3500) return
      all.push(el)
      const sr = (el as HTMLElement).shadowRoot
      if (sr) collect(sr)
    }
  }
  collect(document)
  let sc = 0
  let d = ''
  for (const el of all) {
    if (el.id === '__vg_cursor' || el.hasAttribute('data-vg-ui')) continue
    if ((el as HTMLElement).scrollTop > 0 && el !== document.scrollingElement) sc += (el as HTMLElement).scrollTop
    const t = el.tagName
    if (/^(SCRIPT|STYLE|HEAD|META|LINK)$/.test(t)) continue
    const cls = typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : el.getAttribute('class') ?? ''
    d += t + cls + (el.getAttribute('aria-expanded') ?? '') + (el.getAttribute('aria-pressed') ?? '') + (el.getAttribute('aria-checked') ?? '') + (el.getAttribute('aria-selected') ?? '') + (el.getAttribute('aria-current') ?? '') + (el.hasAttribute('hidden') ? 'h' : '') + (el.hasAttribute('disabled') ? 'd' : '') + (el.hasAttribute('open') ? 'o' : '')
    if (el instanceof SVGElement) d += (el.getAttribute('fill') ?? '') + (el.getAttribute('opacity') ?? '') + (el.getAttribute('stroke-width') ?? '') + (el.getAttribute('style') ?? '').slice(0, 60)
    else d += (el.getAttribute('style') ?? '').slice(0, 60)
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') d += (el as HTMLInputElement).value + ((el as HTMLInputElement).checked ? 'c' : '')
  }
  const ae = document.activeElement
  const focus = ae && ae !== document.body ? `${ae.tagName}#${ae.id}.${(ae.getAttribute('aria-label') ?? '').slice(0, 20)}.${(ae as HTMLInputElement).type ?? ''}` : ''
  const probe = (window as unknown as { __vgProbe?: { mut: number } }).__vgProbe
  return { text: hash(body), dom: hash(d), scroll: Math.round(scrollY) + Math.round(sc), focus, mut: probe?.mut ?? -1 }
}

export interface State {
  url: string
  parts: Sig[]
  /** parts of the page that changed on their own (a clock, a carousel) while it was being looked at, so they say nothing */
  noisy?: { text: boolean; dom: boolean }
}

export async function stateOf(page: Page): Promise<State> {
  const parts = await Promise.all(framesOf(page).map((f) => f.evaluate(sigIn).catch(() => null)))
  return { url: page.url(), parts: parts.map((p) => p ?? { text: '', dom: '', scroll: 0, focus: '', mut: -1 }) }
}

/** two looks at the page 150 ms apart: what moved without anybody touching it is noise */
export async function baselineOf(page: Page): Promise<State> {
  const a = await stateOf(page)
  await nap(150)
  const b = await stateOf(page)
  return { ...b, noisy: { text: a.parts.some((p, i) => p.text !== b.parts[i]?.text), dom: a.parts.some((p, i) => p.dom !== b.parts[i]?.dom) } }
}

export function stateDiff(a: State, b: State, o: { focus?: boolean } = {}): string[] {
  const why: string[] = []
  if (a.url !== b.url) why.push('the address changed')
  if (a.parts.length !== b.parts.length) why.push('a frame appeared or went')
  const n = Math.min(a.parts.length, b.parts.length)
  for (let i = 0; i < n; i++) {
    if (!a.noisy?.text && a.parts[i].text !== b.parts[i].text) why.push('the words on the page changed')
    if (!a.noisy?.dom && a.parts[i].dom !== b.parts[i].dom) why.push('the page changed')
    if (Math.abs(a.parts[i].scroll - b.parts[i].scroll) >= 8) why.push('the page scrolled')
    if (o.focus && a.parts[i].focus !== b.parts[i].focus) why.push('the focus moved')
  }
  return [...new Set(why)]
}

/** a small grey picture of an area, to see a change that is not in the markup (a canvas, an image) */
export async function thumbOf(page: Page, rect: Rect): Promise<Buffer | null> {
  try {
    const vp = page.viewport() ?? { width: 1280, height: 720 }
    const x = Math.max(0, Math.floor(rect.x))
    const y = Math.max(0, Math.floor(rect.y))
    const w = Math.max(8, Math.min(Math.ceil(rect.w), vp.width - x))
    const h = Math.max(8, Math.min(Math.ceil(rect.h), vp.height - y))
    const png = (await page.screenshot({ type: 'png', clip: { x, y, width: w, height: h } })) as Uint8Array
    return await sharp(Buffer.from(png)).resize(40, 40, { fit: 'fill' }).greyscale().raw().toBuffer()
  } catch {
    return null
  }
}
export function thumbDiff(a: Buffer | null, b: Buffer | null): number {
  if (!a || !b || a.length !== b.length) return 0
  let d = 0
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i])
  return d / a.length
}

/**
 * Waits for the page to react: returns as soon as something differs (then lets it finish drawing), or after `ms`.
 * A page that is slow to answer (a result that arrives 2 s later) is waited for, instead of a fixed pause.
 */
export async function waitForChange(page: Page, before: State, o: { ms?: number; thumb?: { rect: Rect; was: Buffer | null }; expect?: () => Promise<boolean>; focus?: boolean } = {}): Promise<{ changed: boolean; why: string[]; expected?: boolean }> {
  const until = Date.now() + (o.ms ?? 2000)
  let why: string[] = []
  for (;;) {
    if (o.expect && (await o.expect().catch(() => false))) return { changed: true, why: ['the expected thing appeared'], expected: true }
    const now = await stateOf(page).catch(() => null)
    if (now) why = stateDiff(before, now, { focus: o.focus })
    if (why.length) {
      // it is changing: wait until it holds still (at most 1.2 s), so the result is whole
      let last = now!
      const calm = Date.now() + 1200
      let still = 0
      while (Date.now() < calm && still < 2) {
        await nap(180)
        const n2 = await stateOf(page).catch(() => last)
        if (stateDiff(last, n2, { focus: o.focus }).length === 0) still++
        else still = 0
        last = n2
      }
      return { changed: true, why }
    }
    if (Date.now() >= until) break
    await nap(140)
  }
  if (o.thumb) {
    // the cursor's click ripple is gone after 0.7 s: only then is a picture of the area worth comparing
    await nap(350)
    const d = thumbDiff(o.thumb.was, await thumbOf(page, o.thumb.rect))
    if (d > 2.2) return { changed: true, why: ['the picture of the area changed'] }
  }
  return { changed: false, why: [] }
}

// ---------------------------------------------------------------- where to press

interface Aim {
  visible: boolean
  /** points that really show the target, frame-local, best first */
  pts: Array<{ x: number; y: number }>
  /** what covers the middle of it, when something does */
  by: string
}

/** in the page: points on the element that are not covered by something else */
function aimIn(el: Element, prefer: 'centre' | 'left'): Aim {
  const vw = innerWidth
  const vh = innerHeight
  const r = el.getBoundingClientRect()
  const L = Math.max(r.left, 0)
  const T = Math.max(r.top, 0)
  const R = Math.min(r.right, vw - 1)
  const B = Math.min(r.bottom, vh - 1)
  if (R - L < 2 || B - T < 2) return { visible: false, pts: [], by: '' }
  const deepFromPoint = (x: number, y: number): Element | null => {
    let t = document.elementFromPoint(x, y)
    for (let i = 0; i < 8 && t && (t as HTMLElement).shadowRoot; i++) {
      const n = (t as HTMLElement).shadowRoot!.elementFromPoint(x, y)
      if (!n || n === t) break
      t = n
    }
    return t
  }
  const has = (a: Element, b: Element | null): boolean => {
    for (let n: Node | null = b; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === a) return true
    return false
  }
  const fr: Array<[number, number]> = prefer === 'left' ? [[0.25, 0.5], [0.5, 0.5], [0.12, 0.5], [0.4, 0.3], [0.4, 0.7], [0.75, 0.5]] : [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.28], [0.5, 0.72], [0.2, 0.25], [0.8, 0.75], [0.2, 0.75], [0.8, 0.25]]
  const pts: Aim['pts'] = []
  let by = ''
  fr.forEach(([fx, fy], i) => {
    const x = L + (R - L) * fx
    const y = T + (B - T) * fy
    const top = deepFromPoint(x, y)
    // the target, something inside it, or the label / wrapper it sits in all take the press to it
    const ok = !!top && (has(el, top) || has(top, el))
    if (ok) pts.push({ x, y })
    else if (i === 0 && top) by = `${top.tagName.toLowerCase()}${top.id ? '#' + top.id : ''}${typeof (top as HTMLElement).className === 'string' && (top as HTMLElement).className ? '.' + (top as HTMLElement).className.split(/\s+/)[0] : ''}${((top as HTMLElement).innerText ?? '').trim() ? ' "' + ((top as HTMLElement).innerText ?? '').trim().replace(/\s+/g, ' ').slice(0, 30) + '"' : ''}`
  })
  return { visible: true, pts, by }
}

/** the points to press on an element, page coordinates, best first */
export async function aimAt(page: Page, h: ElementHandle<Element>, prefer: 'centre' | 'left' = 'centre'): Promise<Aim> {
  const frame = h.frame
  const a = await h.evaluate(aimIn, prefer).catch(() => ({ visible: false, pts: [], by: '' }) as Aim)
  const off = await frameOffset(page, frame)
  return { ...a, pts: a.pts.map((p) => ({ x: p.x + off.x, y: p.y + off.y })) }
}

// ---------------------------------------------------------------- did the click land?

/** in the frame of the target: listen (capture phase) for where clicks go */
function installClickProbe(el: Element): void {
  const w = window as unknown as { __vgT?: Element; __vgClicks?: boolean[]; __vgCH?: boolean }
  w.__vgT = el
  w.__vgClicks = []
  if (w.__vgCH) return
  w.__vgCH = true
  const f = (e: Event) => {
    const T = w.__vgT
    const p = e.composedPath ? e.composedPath() : []
    // the control itself, something inside it, or the button / link / label it sits in (a press on the frame around a text)
    const hit = !!T && (p.includes(T) || p.some((n) => n instanceof Element && T.contains(n)) || p.slice(0, 3).some((n) => n instanceof Element && n.contains(T) && /^(A|BUTTON|LABEL|SUMMARY|LI)$/.test(n.tagName)))
    w.__vgClicks!.push(hit)
  }
  addEventListener('click', f, true)
}
async function readClickProbe(frame: Frame): Promise<boolean | null> {
  return frame.evaluate(() => { const w = window as unknown as { __vgClicks?: boolean[] }; return w.__vgClicks ? w.__vgClicks.some(Boolean) : null }).catch(() => null)
}

const desc = (e: unknown): string => String((e as Error)?.message ?? e)

async function go(env: Env, x: number, y: number, ms = 600): Promise<void> {
  if (env.move) await env.move(x, y, ms)
  else await env.page.mouse.move(x, y, { steps: 5 })
}

export interface ClickOptions {
  double?: boolean
  /** words of the step itself: an overlay control with these words is not closed away */
  stepWords?: string
  /** looks for the control again, differently (a model looking at the screen); its address */
  relocate?: () => Promise<string | null>
  /** something that must appear for the click to count as done */
  expect?: () => Promise<boolean>
  /** a press on a field wants the pointer toward its left, where the text is */
  prefer?: 'centre' | 'left'
  /** nothing may be retried (an action that must not happen twice) */
  once?: boolean
}

/**
 * Presses a control the way a person does, and finds out what happened. Never reports a click that did not land as done.
 */
export async function doClick(env: Env, target: { selector: string; label: string }, o: ClickOptions = {}): Promise<Outcome> {
  const { page } = env
  const out = blank()
  const what = `${o.double ? 'double-clicking' : 'clicking'} "${target.label}"`
  let sel = target.selector
  let blockedBy = ''
  let base: State | null = null
  let before: State = await stateOf(page)
  let relocated = false
  const plan: Array<'point' | 'point2' | 'key' | 'relocate'> = o.once ? ['point'] : ['point', 'point2', 'key', 'relocate']
  for (let ai = 0; ai < plan.length; ai++) {
    const kind = plan[ai]
    let h = await deepHandle(page, sel)
    if (!h) {
      if (kind === 'relocate' || !o.relocate || relocated) return { ...out, skipped: { what, why: 'it disappeared before it could be used' } }
      continue
    }
    // 1. whatever sits on top of it goes first
    const cl = await clearOverlays(page, { policy: policyOf(page), target: sel, stepWords: o.stepWords ?? target.label, allow: env.allow, log: env.log, move: env.move ? (x, y) => env.move!(x, y, 450) : undefined, pace: env.pace })
    out.closed.push(...cl.closed)
    h = await deepHandle(page, sel)
    if (!h) return { ...out, skipped: { what, why: 'it disappeared before it could be used' } }
    await h.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => undefined)
    await nap(90)
    const frame = h.frame
    if (kind === 'relocate') {
      const again = o.relocate ? await o.relocate() : null
      if (!again) break
      sel = again
      relocated = true
      h = await deepHandle(page, sel)
      if (!h) break
    }
    // a control the page keeps switched off swallows every press: said as it is, not as a click that failed
    const off = await h.evaluate((el) => !!(el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset:disabled')).catch(() => false)
    if (off) return { ...out, skipped: { what, why: 'it is disabled: the page keeps it switched off until something it needs is done first' } }
    const aim = await aimAt(page, h, o.prefer ?? 'centre')
    out.rect = (await h.boundingBox().then((b) => (b ? { x: b.x, y: b.y, w: b.width, h: b.height } : undefined)).catch(() => undefined)) ?? out.rect
    if (!aim.visible) return { ...out, skipped: { what, why: 'it is not visible on the page' } }
    if (aim.by) blockedBy = aim.by
    await h.evaluate(installClickProbe).catch(() => undefined)
    let point = aim.pts[kind === 'point2' ? Math.min(1, aim.pts.length - 1) : 0]
    if (kind === 'point2' && aim.pts.length > 1) point = aim.pts[Math.min(aim.pts.length - 1, 1 + Math.floor(aim.pts.length / 3))]
    const thumbRect = out.rect ? { x: out.rect.x - 40, y: out.rect.y - 40, w: out.rect.w + 80, h: out.rect.h + 80 } : null
    let was: Buffer | null = null
    const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 2500 }).catch(() => null)
    try {
      if (kind === 'key') {
        const tag = await h.evaluate((el) => `${el.tagName}|${el.getAttribute('type') ?? ''}|${el.getAttribute('role') ?? ''}`)
        await h.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true }))
        await nap(120)
        base = await baselineOf(page)
        before = { ...base }
        const space = /checkbox|radio|switch|option/i.test(tag) && !/^A\|/.test(tag)
        await page.keyboard.press(space ? 'Space' : 'Enter')
        env.log(`    pressed ${space ? 'Space' : 'Enter'} on "${target.label}" because the click did not land`)
      } else {
        if (!point) {
          // everything over it is covered: still try the middle (the cover may be a layer the page lets presses through)
          const b = out.rect!
          point = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
        }
        await go(env, point.x, point.y, 600)
        await nap(150 * env.pace)
        // what the page does as the pointer arrives (a hover tooltip) is not the click's doing: the page is looked at now
        base = await baselineOf(page)
        before = { ...base }
        if (thumbRect) was = await thumbOf(page, thumbRect)
        await page.mouse.click(point.x, point.y, { count: o.double ? 2 : 1 })
        out.at = point
      }
    } catch (e) {
      env.log(`    the press failed: ${desc(e)}`)
    }
    await Promise.race([nav, nap(env.pace ? 1500 : 700)])
    const landedRaw = await readClickProbe(frame)
    const urlMoved = before.url !== page.url()
    const landed = landedRaw === null ? (urlMoved ? true : null) : landedRaw || urlMoved
    const res = await waitForChange(page, before, { ms: env.pace ? 1800 : 2200, thumb: thumbRect ? { rect: thumbRect, was } : undefined, expect: o.expect })
    if (landed !== false || res.changed) {
      // the click reached the control (or the page changed in response to it): whatever happened is the answer
      if (res.changed) env.log(`    after "${target.label}": ${res.why.join(', ')}`)
      out.did = 1
      out.landed = landed !== false
      out.changed = res.changed
      out.verified = res.changed && landed !== false
      out.last = sel
      if (!res.changed) out.note = `"${target.label}" was ${o.double ? 'double-clicked' : 'clicked'} but the page did not visibly change`
      if (o.expect) out.verified = !!res.expected
      return out
    }
    env.log(`    the click on "${target.label}" did not reach it${aim.by ? ` (${aim.by} was on top)` : ''}${ai < plan.length - 1 ? '; trying again differently' : ''}`)
    // an overlay that arrived while the pointer travelled is closed on the next round
  }
  return { ...out, skipped: { what, why: blockedBy ? `something else on the page (${blockedBy}) took the click and could not be moved out of the way` : 'the click did not reach it' } }
}

// ---------------------------------------------------------------- typing

const EDITOR = '.cm-content,.CodeMirror,.monaco-editor,.ace_editor,.ProseMirror,.ql-editor,.trix-content,.tox-edit-area'

/** in the page: what the box holds, as text */
function valueIn(el: Element): string {
  const e = el as HTMLElement & { CodeMirror?: { getValue(): string }; value?: string }
  if (typeof e.value === 'string' && /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName)) return e.value
  if (e.CodeMirror) return e.CodeMirror.getValue()
  const cm = el.closest('.CodeMirror') as (HTMLElement & { CodeMirror?: { getValue(): string } }) | null
  if (cm?.CodeMirror) return cm.CodeMirror.getValue()
  const m = (window as unknown as { monaco?: { editor: { getModels(): Array<{ getValue(): string }> } } }).monaco
  if (m && el.closest('.monaco-editor')) { const ms = m.editor.getModels(); if (ms.length) return ms[0].getValue() }
  const lines = el.querySelectorAll('.cm-line,.view-line,.ace_line')
  if (lines.length) return Array.from(lines).map((l) => l.textContent ?? '').join('\n')
  return e.innerText ?? e.textContent ?? ''
}

/** in the page: is focus inside the element (a code editor keeps it in a hidden box inside)? */
function focusInside(el: Element): boolean {
  let a: Element | null = document.activeElement
  for (let i = 0; a && i < 8 && (a as HTMLElement).shadowRoot?.activeElement; i++) a = (a as HTMLElement).shadowRoot!.activeElement
  for (let n: Node | null = a; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === el) return true
  return false
}

/** what the page itself says about a box, for deciding if it holds private things */
async function fieldHints(h: ElementHandle<Element>): Promise<{ type: string; name: string; id: string; label: string; placeholder: string; autocomplete: string; editor: boolean }> {
  return h.evaluate((el, editorSel) => {
    const i = el as HTMLInputElement
    const labels: string[] = []
    for (const l of Array.from(i.labels ?? [])) labels.push((l as HTMLElement).innerText ?? '')
    labels.push(el.getAttribute('aria-label') ?? '')
    if (!labels.join('').trim()) { const lab = el.closest('label'); if (lab) labels.push((lab as HTMLElement).innerText ?? '') }
    return { type: (i.type || el.getAttribute('type') || '').toLowerCase(), name: el.getAttribute('name') ?? '', id: el.id, label: labels.join(' ').replace(/\s+/g, ' ').trim(), placeholder: el.getAttribute('placeholder') ?? '', autocomplete: el.getAttribute('autocomplete') ?? '', editor: !!el.closest(editorSel) || (el as HTMLElement).isContentEditable }
  }, EDITOR)
}

const compact = (s: string): string => s.replace(/[\s ]+/g, '')

/** in the page: the address of the box that has focus (a field, an editable area, a code editor), or null */
function focusedBox(): string | null {
  let a: Element | null = document.activeElement
  for (let i = 0; a && i < 8 && (a as HTMLElement).shadowRoot?.activeElement; i++) a = (a as HTMLElement).shadowRoot!.activeElement
  if (!a || a === document.body) return null
  const editorSel = '.cm-content,.CodeMirror,.monaco-editor,.ace_editor,.ProseMirror,.ql-editor,.trix-content,.tox-edit-area'
  const box = a.closest(editorSel) ?? a
  const ok = /^(INPUT|TEXTAREA)$/.test(box.tagName) ? !/^(button|submit|reset|checkbox|radio|image|hidden|file|range|color)$/i.test((box as HTMLInputElement).type) : (box as HTMLElement).isContentEditable || box !== a || box.getAttribute('role') === 'textbox'
  if (!ok) return null
  const one = (root: Document | ShadowRoot, sel: string) => { try { return root.querySelectorAll(sel).length === 1 } catch { return false } }
  const hops: string[] = []
  let cur: Element | null = box
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

/** the address of the box that has focus now, in the page or in a frame, or null when nothing editable has it */
export async function focusedEditable(page: Page): Promise<string | null> {
  for (const f of framesOf(page)) {
    const r = await f.evaluate(focusedBox).catch(() => null)
    if (!r) continue
    if (f === page.mainFrame()) return r
    const fe = await f.frameElement().catch(() => null)
    if (!fe) continue
    const prefix = await fe.evaluate((el) => { const parts: string[] = []; for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) { if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break } const sibs = Array.from(n.parentElement?.children ?? []); parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : '')) } return parts.join(' > ') })
    await fe.dispose().catch(() => undefined)
    return prefix + ' >>> ' + r
  }
  return null
}

/**
 * "change plan to team" in a box that holds `{"plan": "pro"}`: the value that belongs to the name is replaced, the rest of the
 * text stays. Returns the whole new text, or null when the name is not in it.
 */
export function editKeyedValue(doc: string, key: string, value: string): string | null {
  const k = key.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!k) return null
  const re = new RegExp(`(["']?${k}["']?\\s*[:=]\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^,}\\]\\n]*[^,}\\]\\s\\n])`, 'i')
  const m = re.exec(doc)
  if (!m) return null
  const old = m[2]
  let v = value
  // a quoted value stays quoted
  if (/^["']/.test(old) && !/^["']/.test(value)) v = old[0] + value + old[0]
  return doc.slice(0, m.index) + m[1] + v + doc.slice(m.index + m[0].length)
}

export interface TypeOptions {
  /** the name of a value inside the box ("plan" in {"plan": "pro"}): only that value is replaced */
  key?: string
  /** select what is in the box first and type over it (the default for a plain box); false adds to the end */
  replace?: boolean
  /** the text came from the vault: never read back, always blurred */
  secret?: boolean
  delay?: number
  stepWords?: string
}

/**
 * Puts text into a box (a plain field, a contenteditable, a code editor). The box is blurred on the film first when it is a
 * private kind (password, e-mail, phone, card, name, address) or the text itself looks private. Reads the value back.
 */
export async function doType(env: Env, target: { selector: string; label: string }, text: string, o: TypeOptions = {}): Promise<Outcome> {
  const { page } = env
  const out = blank()
  const what = `typing into "${target.label}"`
  let h = await deepHandle(page, target.selector)
  if (!h) return { ...out, skipped: { what, why: 'the box disappeared before it could be used' } }
  const cl = await clearOverlays(page, { policy: policyOf(page), target: target.selector, stepWords: o.stepWords ?? target.label, allow: env.allow, log: env.log, move: env.move ? (x, y) => env.move!(x, y, 450) : undefined, pace: env.pace })
  out.closed.push(...cl.closed)
  h = await deepHandle(page, target.selector)
  if (!h) return { ...out, skipped: { what, why: 'the box disappeared before it could be used' } }
  await h.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => undefined)
  await nap(90)
  // private boxes are blurred BEFORE anything is typed, whatever the scout knew
  const hints = await fieldHints(h)
  const kind = classifyField(hints)
  const privateText = o.secret || findPrivate(text, { kinds: ['email', 'phone', 'card', 'ssn', 'token'] }).length > 0
  if ((isSensitive(kind) && kind !== 'username') || privateText) await h.evaluate((el) => el.setAttribute('data-vg-blur', 'typed')).catch(() => undefined)
  const aim = await aimAt(page, h, 'left')
  if (!aim.visible) return { ...out, skipped: { what, why: 'the box is not visible on the page' } }
  const b = await h.boundingBox()
  out.rect = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : undefined
  const point = aim.pts[0] ?? (b ? { x: b.x + Math.min(b.width / 2, 120), y: b.y + b.height / 2 } : null)
  if (!point) return { ...out, skipped: { what, why: 'the box could not be pressed' } }
  await go(env, point.x, point.y, 600)
  await nap(180 * env.pace)
  await page.mouse.click(point.x, point.y)
  await nap(220 * env.pace)
  let focused = await h.evaluate(focusInside).catch(() => false)
  if (!focused) {
    // another point, then the keyboard's own way in
    const p2 = aim.pts[1]
    if (p2) { await go(env, p2.x, p2.y, 300); await page.mouse.click(p2.x, p2.y); await nap(150) }
    focused = await h.evaluate(focusInside).catch(() => false)
    if (!focused) {
      await h.evaluate((el) => { const t = (el.matches('input,textarea,[contenteditable]') ? el : el.querySelector('textarea,input,[contenteditable]')) as HTMLElement | null; (t ?? (el as HTMLElement)).focus() }).catch(() => undefined)
      await nap(120)
      focused = await h.evaluate(focusInside).catch(() => false)
    }
  }
  if (!focused) return { ...out, skipped: { what, why: 'the box did not take focus (something else is in front of it)' } }
  const editor = hints.editor
  // a value named inside a code editor or a text area: that value is replaced, not the whole text
  if (o.key && o.replace) {
    const doc = await h.evaluate(valueIn).catch(() => '')
    const edited = editKeyedValue(doc, o.key, text)
    if (edited !== null && compact(edited) !== compact(doc)) {
      await h.evaluate((el) => (el as HTMLElement).focus()).catch(() => undefined)
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
      if (edited.length <= 240) await page.keyboard.type(edited, { delay: env.pace === 0 ? 4 : 18 })
      else await page.evaluate((t) => document.execCommand('insertText', false, t), edited)
      await nap(env.pace === 0 ? 250 : 600)
      let got = await h.evaluate(valueIn).catch(() => null)
      if (got === null || compact(got) !== compact(edited)) {
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
        await page.evaluate((t) => document.execCommand('insertText', false, t), edited).catch(() => undefined)
        await nap(200)
        got = await h.evaluate(valueIn).catch(() => null)
      }
      out.did = 1
      out.changed = true
      out.verified = got !== null && compact(got) === compact(edited)
      out.landed = true
      out.last = target.selector
      out.at = point
      if (!out.verified) out.note = `"${o.key}" was set in "${target.label}" but the box does not read back as expected`
      else out.seen.push(`The value of "${o.key}" in "${target.label}" is changed to ${text}`)
      return out
    }
  }
  const plainBox = !editor && (await h.evaluate((el) => /^(INPUT|TEXTAREA)$/.test(el.tagName)))
  if (plainBox) {
    if (o.replace === false) await h.evaluate((el) => { const i = el as HTMLInputElement; try { i.setSelectionRange(i.value.length, i.value.length) } catch { /* a type that has no caret */ } })
    else await h.evaluate((el) => { const i = el as HTMLInputElement; if (typeof i.select === 'function') i.select() })
  } else if (o.replace === true) {
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await page.keyboard.press('Backspace')
  } else {
    await page.keyboard.down('Control')
    await page.keyboard.press('End')
    await page.keyboard.up('Control')
  }
  const before = plainBox || editor ? await h.evaluate(valueIn).catch(() => '') : ''
  await page.keyboard.type(text, { delay: env.pace === 0 ? 8 : o.delay ?? 60 })
  await nap(env.pace === 0 ? 300 : 900) // suggestions arrive a moment later
  let now = await h.evaluate(valueIn).catch(() => null)
  const want = o.replace === false || (editor && o.replace !== true) ? compact(before) + compact(text) : compact(text)
  let ok = now !== null && (compact(now) === want || compact(now).endsWith(compact(text)) && (o.replace === false || editor || compact(now) === compact(text)))
  if (!ok && editor && now !== null) {
    // an editor that closes brackets or indents by itself typed something else: put the text in whole
    await h.evaluate((el) => (el as HTMLElement).focus()).catch(() => undefined)
    if (o.replace === true || compact(before) === '') {
      await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control')
    }
    await page.evaluate((t) => document.execCommand('insertText', false, t), text).catch(() => undefined)
    await nap(200)
    now = await h.evaluate(valueIn).catch(() => null)
    ok = now !== null && compact(now).endsWith(compact(text))
  }
  out.did = 1
  out.changed = now !== null && now !== before
  out.verified = ok
  out.landed = true
  out.last = target.selector
  out.at = point
  if (!ok) out.note = `the text was typed into "${target.label}" but the box does not read back as expected`
  return out
}

// ---------------------------------------------------------------- hovering

export async function doHover(env: Env, target: { selector: string; label: string }, read: (x: number, y: number) => Promise<string>): Promise<Outcome & { tip: string }> {
  const { page } = env
  const out = { ...blank(), tip: '' }
  const what = `hovering over "${target.label}"`
  let h = await deepHandle(page, target.selector)
  if (!h) return { ...out, skipped: { what, why: 'it disappeared before it could be used' } }
  const cl = await clearOverlays(page, { policy: policyOf(page), target: target.selector, stepWords: target.label, allow: env.allow, log: env.log, move: env.move ? (x, y) => env.move!(x, y, 450) : undefined, pace: env.pace })
  out.closed.push(...cl.closed)
  h = await deepHandle(page, target.selector)
  if (!h) return { ...out, skipped: { what, why: 'it disappeared before it could be used' } }
  await h.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => undefined)
  await nap(120)
  const aim = await aimAt(page, h)
  const b = await h.boundingBox()
  const p = aim.pts[0] ?? (b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null)
  if (!p) return { ...out, skipped: { what, why: 'it is not visible on the page' } }
  out.tip = await read(p.x, p.y)
  out.did = 1
  out.changed = !!out.tip
  out.verified = !!out.tip
  out.last = target.selector
  out.at = p
  out.rect = b ? { x: b.x, y: b.y, w: b.width, h: b.height } : undefined
  return out
}

// ---------------------------------------------------------------- clicking a mark of a chart

/**
 * Clicks a chart mark and checks that the chart reacted (a readout appeared or changed, the picture changed around it):
 * a click can miss a thin line by a pixel, so the next place is tried until one answers. Returns where it answered.
 */
export async function clickMarkChecked(env: Env, chartRect: Rect, spots: Array<{ x: number; y: number }>): Promise<{ ok: boolean; at: { x: number; y: number }; fresh: string[]; tries: number }> {
  const { page } = env
  const tries: Array<{ x: number; y: number }> = []
  for (const s of spots.slice(0, 4)) {
    tries.push(s)
    for (const j of [[0, 0], [2, 0], [0, 2], [-2, 0], [0, -2]]) tries.push({ x: s.x + j[0], y: s.y + j[1] })
  }
  const order = [...tries.filter((_, i) => i % 6 === 0), ...tries.filter((_, i) => i % 6 !== 0)].slice(0, 9)
  const first = await snapshotTexts(page)
  let n = 0
  for (const p of order) {
    n++
    await go(env, p.x, p.y, 500)
    await nap(220 * Math.max(env.pace, 0.4))
    const snap = await snapshotTexts(page)
    const was = await thumbOf(page, chartRect)
    await page.mouse.click(p.x, p.y)
    await nap(550)
    const fresh = await newTexts(page, snap, 6)
    const d = thumbDiff(was, await thumbOf(page, chartRect))
    if (fresh.length || d > 1.6) return { ok: true, at: p, fresh, tries: n }
  }
  // the chart may already show the very selection this press makes (an earlier tap chose the same line): a readout that was there before
  // and is still there says so; nothing that was not already there is claimed
  const readouts = [...(await snapshotTexts(page))].filter((t) => /selected|selection|chosen/i.test(t) && first.has(t))
  if (readouts.length) return { ok: true, at: spots[0] ?? { x: chartRect.x + chartRect.w / 2, y: chartRect.y + chartRect.h / 2 }, fresh: readouts.slice(0, 2).map((t) => `${t} (the chart was already showing it)`), tries: n }
  return { ok: false, at: spots[0] ?? { x: chartRect.x + chartRect.w / 2, y: chartRect.y + chartRect.h / 2 }, fresh: [], tries: n }
}
