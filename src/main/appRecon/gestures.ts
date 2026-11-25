/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { ElementHandle, Page } from 'puppeteer-core'
import type { Rect } from '@shared/appRecon'
import { deepHandle, deepPathInPage } from './deep'
import { clearOverlays } from './overlays'
import { aimAt, baselineOf, blank, doClick, nap, policyOf, stateDiff, stateOf, waitForChange, type Env, type Outcome } from './actions'

/**
 * The gestures beyond a plain click: key presses and chords ("Control+K", "Tab until Export is focused"), dragging a card
 * (with the pointer, falling back to the browser's own drag-and-drop events), sliders (one thumb or two), dates (a native
 * date box or a calendar that is read, navigated by month and clicked by its day), and scrolling until some text shows.
 * Each one reads the result back from the page and says whether it worked.
 */

// ---------------------------------------------------------------- keys

const NAMES: Record<string, string> = {
  ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', win: 'Meta', windows: 'Meta', super: 'Meta', option: 'Alt', opt: 'Alt', alt: 'Alt', shift: 'Shift',
  esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', del: 'Delete', delete: 'Delete', backspace: 'Backspace', space: 'Space', spacebar: 'Space', tab: 'Tab',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  pageup: 'PageUp', pagedown: 'PageDown', pgup: 'PageUp', pgdn: 'PageDown', home: 'Home', end: 'End', insert: 'Insert', slash: '/', backslash: '\\', comma: ',', period: '.', dot: '.', minus: '-'
}
const MODS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

/** "Control+K", "Tab", "ArrowDown ArrowDown Enter" → chords, each a list of keys (modifiers first) */
export function parseKeys(keys: string): string[][] {
  const chords: string[][] = []
  for (const part of keys.replace(/\s*\+\s*/g, '+').trim().split(/[\s,]+/).filter(Boolean)) {
    const raw = part.split('+').filter(Boolean)
    const ks = raw.map((k) => NAMES[k.toLowerCase()] ?? (k.length === 1 ? k : /^f\d{1,2}$/i.test(k) ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)))
    const mods = ks.filter((k) => MODS.has(k))
    const rest = ks.filter((k) => !MODS.has(k))
    // a letter in a chord is the key itself, not a capital (Shift is named when it is wanted)
    const main = rest.map((k) => (mods.length && k.length === 1 ? k.toLowerCase() : k))
    if (mods.length || main.length) chords.push([...mods, ...main])
  }
  return chords
}

async function chord(page: Page, ks: string[]): Promise<void> {
  const mods = ks.filter((k) => MODS.has(k))
  const rest = ks.filter((k) => !MODS.has(k))
  for (const m of mods) await page.keyboard.down(m as 'Control')
  for (const k of rest) await page.keyboard.press(k as 'Enter')
  if (!rest.length && mods.length) await nap(40)
  for (const m of [...mods].reverse()) await page.keyboard.up(m as 'Control')
}

/** in the page: does the focused control go by this name? */
function focusIs(wanted: string): { is: boolean; name: string } {
  const norm = (s: string) => (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !/^(the|a|an|button|field|link|box|input|control|icon)$/.test(w))
  let a: Element | null = document.activeElement
  for (let i = 0; a && i < 8 && (a as HTMLElement).shadowRoot?.activeElement; i++) a = (a as HTMLElement).shadowRoot!.activeElement
  if (!a || a === document.body) return { is: false, name: '' }
  const el = a as HTMLInputElement
  const labels = Array.from(el.labels ?? []).map((l) => (l as HTMLElement).innerText ?? '')
  const names = [el.getAttribute('aria-label'), el.getAttribute('title'), (el as HTMLElement).innerText, el.value, el.getAttribute('placeholder'), el.getAttribute('name'), el.id, ...labels].filter(Boolean) as string[]
  const want = norm(wanted)
  const lev = (x: string, y: string) => {
    if (Math.abs(x.length - y.length) > 1) return 9
    const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => [i, ...new Array(y.length).fill(0)])
    for (let j = 0; j <= y.length; j++) d[0][j] = j
    for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    return d[x.length][y.length]
  }
  const hit = names.some((n) => { const t = norm(n); return want.length > 0 && want.every((w) => t.some((x) => x === w || x.startsWith(w) || w.startsWith(x) || (w.length >= 4 && lev(x, w) <= 1))) })
  return { is: hit, name: (names[0] ?? el.tagName).slice(0, 40) }
}

export async function doKey(env: Env, keys: string, repeatUntil?: string): Promise<Outcome> {
  const { page } = env
  const out = blank()
  const chords = parseKeys(keys)
  const what = `pressing ${keys}`
  if (!chords.length) return { ...out, skipped: { what, why: 'no key could be made out of that' } }
  const base = await baselineOf(page)
  const before = await stateOf(page)
  before.noisy = base.noisy
  if (repeatUntil) {
    const check = async () => (await page.evaluate(focusIs, repeatUntil).catch(() => ({ is: false, name: '' }))).is
    let presses = 0
    let reached = await check()
    for (; !reached && presses < 40; presses++) {
      await chord(page, chords[0])
      await nap(env.pace ? 160 : 40)
      reached = await check()
    }
    out.did = presses
    out.changed = presses > 0
    out.verified = reached
    out.landed = true
    if (!reached) return { ...out, did: presses, verified: false, skipped: { what: `pressing ${keys} until "${repeatUntil}" is focused`, why: `after ${presses} presses the focus never reached "${repeatUntil}"` } }
    out.seen.push(`Pressing ${keys}${presses ? ` ${presses} time${presses === 1 ? '' : 's'}` : ''} moves the focus to "${repeatUntil}"`)
    return out
  }
  for (const c of chords) {
    await chord(page, c)
    await nap(env.pace ? 220 : 80)
    out.did++
  }
  const res = await waitForChange(page, before, { ms: 1800, focus: true })
  out.changed = res.changed
  out.verified = res.changed
  out.landed = true
  if (!res.changed) out.note = `${keys} was pressed but the page did not visibly react`
  return out
}

// ---------------------------------------------------------------- drag and drop

/** in the page: where a thing sits in its group (its column's heading and its place in the order) */
function placeIn(el: Element | null, label: string): string {
  const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  let e = el && el.isConnected ? el : null
  if (!e) {
    const w = norm(label)
    let best: Element | null = null
    for (const c of Array.from(document.querySelectorAll('*'))) {
      const t = norm((c as HTMLElement).innerText ?? '')
      if (!t || !t.includes(w) || t.length > w.length + 60) continue
      if (!best || t.length <= norm((best as HTMLElement).innerText ?? '').length) best = c
    }
    e = best
  }
  if (!e) return 'gone'
  const col = e.closest('[class*=col i],[class*=lane i],[class*=list i],[class*=board i],[class*=stage i],section,ul,ol') ?? e.parentElement
  const head = col?.querySelector('h1,h2,h3,h4,h5,[class*=title i],[class*=head i],legend')
  const sibs = e.parentElement ? Array.from(e.parentElement.children) : []
  return `${norm((head as HTMLElement | null)?.innerText ?? '')}|${sibs.indexOf(e)}/${sibs.length}|${e.parentElement?.id ?? ''}`
}

/** in the page: the members of the list a drop goes into (siblings like the thing that is dragged) */
function membersIn(container: Element, like: Element): Array<{ top: number; bottom: number; left: number; right: number }> {
  const cls = typeof (like as HTMLElement).className === 'string' ? (like as HTMLElement).className.split(/\s+/)[0] : ''
  const out: Array<{ top: number; bottom: number; left: number; right: number }> = []
  for (const c of Array.from(container.querySelectorAll('*'))) {
    if (c === like) continue
    if (c.tagName === like.tagName && ((cls && (c as HTMLElement).classList.contains(cls)) || c.getAttribute('draggable') === 'true')) {
      const r = c.getBoundingClientRect()
      if (r.width > 4 && r.height > 4) out.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })
    }
  }
  return out.sort((a, b) => a.top - b.top)
}

/** in the page: send the browser's own drag-and-drop events (for pages that listen for those) */
function html5Drop(from: Element, x: number, y: number, fx: number, fy: number): void {
  const dt = new DataTransfer()
  const fire = (el: Element, type: string, cx: number, cy: number) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: cx, clientY: cy }))
  fire(from, 'dragstart', fx, fy)
  let t = document.elementFromPoint(x, y) ?? document.body
  fire(t, 'dragenter', x, y)
  fire(t, 'dragover', x, y)
  t = document.elementFromPoint(x, y) ?? t
  fire(t, 'dragover', x + 1, y + 1)
  fire(t, 'drop', x, y)
  fire(from, 'dragend', x, y)
}

export interface DragSpec {
  from: { selector: string; label: string }
  /** the list or card dropped on */
  to?: { selector: string; label: string }
  /** a card the drop is relative to */
  ref?: { selector: string; label: string }
  position?: 'before' | 'after' | 'top' | 'bottom'
}

export async function doDrag(env: Env, d: DragSpec): Promise<Outcome> {
  const { page } = env
  const out = blank()
  const what = `dragging "${d.from.label}"${d.to ? ` to "${d.to.label}"` : ''}`
  const target = d.ref ?? d.to
  if (!target) return { ...out, skipped: { what, why: 'no place to drop it was named' } }
  let fh = await deepHandle(page, d.from.selector)
  if (!fh) return { ...out, skipped: { what, why: `"${d.from.label}" was not found` } }
  const cl = await clearOverlays(page, { policy: policyOf(page), target: d.from.selector, stepWords: d.from.label, allow: env.allow, log: env.log, move: env.move ? (x, y) => env.move!(x, y, 450) : undefined, pace: env.pace })
  out.closed.push(...cl.closed)
  fh = await deepHandle(page, d.from.selector)
  const th = await deepHandle(page, target.selector)
  if (!fh || !th) return { ...out, skipped: { what, why: `"${!fh ? d.from.label : target.label}" was not found` } }
  await fh.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => undefined)
  await nap(100)
  const fb = await fh.boundingBox()
  const tb0 = await th.boundingBox()
  if (!fb || !tb0) return { ...out, skipped: { what, why: 'it is not visible on the page' } }
  // where to let go
  let tb = tb0
  const vp = page.viewport() ?? { width: 1280, height: 720 }
  if (tb.y + tb.height > vp.height || tb.y < 0) {
    await th.evaluate((el) => el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => undefined)
    await nap(80)
    tb = (await th.boundingBox()) ?? tb0
  }
  const fbNow = (await fh.boundingBox()) ?? fb
  const members = await th.evaluate(membersIn, await fh.evaluateHandle((e) => e)).catch(() => [] as Array<{ top: number; bottom: number; left: number; right: number }>)
  let dropX = tb.x + tb.width / 2
  let dropY = tb.y + tb.height / 2
  const pos = d.position ?? (d.ref ? 'before' : 'bottom')
  if (d.ref) {
    dropY = pos === 'after' ? tb.y + tb.height * 0.8 : tb.y + tb.height * 0.2
  } else if (members.length) {
    if (pos === 'top') { dropY = members[0].top + 4; dropX = (members[0].left + members[0].right) / 2 }
    else { const l = members[members.length - 1]; dropY = Math.min(tb.y + tb.height - 4, l.bottom + 10); dropX = (l.left + l.right) / 2 }
  } else if (pos === 'top') dropY = tb.y + Math.min(tb.height * 0.3, 60)
  else if (pos === 'bottom') dropY = tb.y + tb.height - Math.min(tb.height * 0.2, 40)
  dropY = Math.max(tb.y + 2, Math.min(dropY, Math.max(tb.y + 2, Math.min(tb.y + tb.height - 2, vp.height - 4))))
  // the pointer goes down on a point that really shows the card (never on whatever is laid over it)
  const grab = await aimAt(page, fh)
  if (!grab.pts.length) return { ...out, skipped: { what, why: `something else on the page${grab.by ? ` (${grab.by})` : ''} is over "${d.from.label}", so it cannot be picked up` } }
  const fromPt = grab.pts[0] ?? { x: fbNow.x + fbNow.width / 2, y: fbNow.y + fbNow.height / 2 }
  const placeBefore = await page.evaluate(placeIn, fh, d.from.label).catch(() => '')
  const base = await baselineOf(page)
  const before = await stateOf(page)
  before.noisy = base.noisy
  const moved = async (): Promise<boolean> => {
    await nap(env.pace ? 700 : 450)
    const after = await page.evaluate(placeIn, (await deepHandle(page, d.from.selector)) as ElementHandle<Element> | null, d.from.label).catch(() => '')
    return after !== placeBefore && after !== 'gone'
  }
  const drag = async (jiggle: boolean) => {
    await page.mouse.move(fromPt.x, fromPt.y, { steps: 3 })
    if (env.move) await env.move(fromPt.x, fromPt.y, 500)
    await nap(160 * Math.max(env.pace, 0.5))
    await page.mouse.down()
    await nap(120)
    // a drag library wants a few pixels of movement before it lets go of a click
    await page.mouse.move(fromPt.x + 6, fromPt.y + 6, { steps: 3 })
    if (jiggle) { await page.mouse.move(fromPt.x + 14, fromPt.y + 10, { steps: 4 }); await nap(120) }
    const steps = env.pace ? 22 : 10
    for (let i = 1; i <= steps; i++) {
      const k = i / steps
      await page.mouse.move(fromPt.x + (dropX - fromPt.x) * k, fromPt.y + (dropY - fromPt.y) * k, { steps: 1 })
      await nap(env.pace ? 22 : 4)
    }
    await nap(250 * Math.max(env.pace, 0.5))
    await page.mouse.move(dropX, dropY + 1, { steps: 2 })
    await nap(120)
    await page.mouse.up()
  }
  let how = 'with the pointer'
  let ok = false
  try {
    await drag(false)
    ok = await moved()
    if (!ok) { how = 'with the pointer, moving off slowly'; await drag(true); ok = await moved() }
  } catch (e) {
    env.log(`    the drag with the pointer failed: ${(e as Error).message}`)
  }
  if (!ok) {
    const f2 = await deepHandle(page, d.from.selector)
    if (f2 && (await f2.evaluate((el) => el.getAttribute('draggable') === 'true' || !!el.closest('[draggable=true]')).catch(() => false))) {
      how = "with the browser's own drag-and-drop"
      await f2.evaluate(html5Drop, dropX, dropY, fromPt.x, fromPt.y).catch(() => undefined)
      ok = await moved()
    }
  }
  const res = await waitForChange(page, before, { ms: 600 })
  out.did = 1
  out.landed = true
  out.changed = res.changed || ok
  out.verified = ok
  out.last = d.from.selector
  out.rect = { x: Math.min(fromPt.x, dropX) - 60, y: Math.min(fromPt.y, dropY) - 60, w: Math.abs(dropX - fromPt.x) + 120, h: Math.abs(dropY - fromPt.y) + 120 }
  if (!ok) return { ...out, did: 1, verified: false, skipped: { what, why: `it was dragged to the place but it did not move (the page ignored the drag)` } }
  out.seen.push(`Dragging "${d.from.label}" ${how} ${d.ref ? `${pos === 'after' ? 'below' : 'above'} "${d.ref.label}"` : d.to ? `into "${d.to.label}"${d.position ? ` (${d.position})` : ''}` : ''} moves it there`.replace(/\s+/g, ' '))
  return out
}

// ---------------------------------------------------------------- sliders

interface SliderInfo {
  kind: 'range' | 'aria'
  min: number
  max: number
  step: number
  now: number
  rect: { x: number; y: number; w: number; h: number }
  /** the track an aria slider's thumb runs along */
  track: { x: number; y: number; w: number; h: number } | null
  vertical: boolean
}

function infoIn(el: Element): SliderInfo | null {
  const r = el.getBoundingClientRect()
  const num = (v: string | null, d: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)
  if (el instanceof HTMLInputElement && el.type === 'range') {
    return { kind: 'range', min: num(el.min, 0), max: num(el.max, 100), step: num(el.step, 1) || 1, now: Number(el.value), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, track: null, vertical: r.height > r.width * 1.5 }
  }
  if (el.getAttribute('role') === 'slider') {
    const p = el.parentElement?.getBoundingClientRect()
    return { kind: 'aria', min: num(el.getAttribute('aria-valuemin'), 0), max: num(el.getAttribute('aria-valuemax'), 100), step: 1, now: num(el.getAttribute('aria-valuenow'), 0), rect: { x: r.x, y: r.y, w: r.width, h: r.height }, track: p ? { x: p.x, y: p.y, w: p.width, h: p.height } : null, vertical: el.getAttribute('aria-orientation') === 'vertical' }
  }
  return null
}

/** in the page: the sliders at or around an element (the thumbs of one control, in order along it) */
function slidersAround(el: Element): Element[] {
  const find = (root: Element): Element[] => Array.from(root.querySelectorAll('input[type=range],[role=slider]')).filter((s) => { const r = s.getBoundingClientRect(); return r.width > 2 && r.height > 2 })
  if (el.matches('input[type=range],[role=slider]')) {
    // the other thumb of the same control: siblings in the same wrapper
    const group = el.closest('[class*=range i],[class*=slider i],[class*=dual i],[class*=price i]') ?? el.parentElement
    const mates = group ? find(group) : [el]
    return mates.length >= 1 && mates.includes(el) ? mates : [el]
  }
  let box: Element | null = el
  for (let i = 0; i < 4 && box; i++, box = box.parentElement) {
    const s = find(box)
    if (s.length) return s
  }
  return []
}

/** in the page: the sliders a name points at (a group of thumbs of one control), by their label, or the text around them */
function slidersNamed(label: string): Element[] {
  const norm = (s: string) => (s || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter((w) => w && !/^(the|a|an|slider|range|bar|control|thumb|handle)$/.test(w)).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
  const want = norm(label)
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 }
  const all = Array.from(document.querySelectorAll('input[type=range],[role=slider]')).filter(vis)
  if (!all.length) return []
  const score = (el: Element): number => {
    const names: string[] = []
    const i = el as HTMLInputElement
    for (const l of Array.from(i.labels ?? [])) names.push((l as HTMLElement).innerText ?? '')
    names.push(el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', el.id, el.getAttribute('name') ?? '')
    const lb = el.getAttribute('aria-labelledby')
    if (lb) names.push(document.getElementById(lb.split(' ')[0])?.textContent ?? '')
    let n: Element | null = el
    for (let k = 0; k < 3 && n; k++, n = n.parentElement) {
      // a box that holds several controls says nothing about this one; a box that holds just the thumbs of this control does
      if (k > 0 && n.querySelectorAll('input[type=range],[role=slider]').length > 2) break
      const t = ((n as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
      if (t && t.length <= 100) names.push(t)
      const p = n.previousElementSibling
      const pt = p ? ((p as HTMLElement).innerText ?? '').trim() : ''
      if (pt && pt.length <= 40) names.push(pt)
    }
    let best = 0
    for (const nm of names) {
      const t = norm(nm)
      if (!want.length) { best = Math.max(best, 0.5); continue }
      const have = want.filter((w) => t.some((x) => x === w || x.startsWith(w) || w.startsWith(x)))
      best = Math.max(best, have.length / want.length)
    }
    return best
  }
  const ranked = all.map((el) => ({ el, s: score(el) })).sort((a, b) => b.s - a.s)
  const top = ranked[0]
  if (!top || top.s < 0.6) return []
  // the other thumbs of the same control: the nearest wrapper that holds more than one slider
  let box: Element | null = top.el.parentElement
  for (let k = 0; k < 3 && box; k++, box = box.parentElement) {
    const mates = all.filter((x) => box!.contains(x))
    if (mates.length >= 2 && mates.length <= 3 && mates.every((m) => score(m) >= 0.6 || mates.length === 2)) return mates
    if (mates.length > 3) break
  }
  return [top.el]
}

export async function doSlider(env: Env, target: { selector?: string; label: string }, want: { value?: number; min?: number; max?: number }): Promise<Outcome> {
  const { page } = env
  const out = blank()
  const what = `setting the slider "${target.label}"`
  // the sliders by their name; when the name finds none, the ones at the control the name led to
  let thumbsH = await page.evaluateHandle(slidersNamed, target.label)
  let props = await thumbsH.getProperties()
  let thumbs = [...props.values()].map((p) => p.asElement()).filter((e): e is ElementHandle<Element> => !!e)
  if (!thumbs.length && target.selector) {
    const h = await deepHandle(page, target.selector)
    if (h) {
      thumbsH = await h.evaluateHandle(slidersAround)
      props = await thumbsH.getProperties()
      thumbs = [...props.values()].map((p) => p.asElement()).filter((e): e is ElementHandle<Element> => !!e)
    }
  }
  if (!thumbs.length) return { ...out, skipped: { what, why: 'no slider was found there' } }
  const cl = await clearOverlays(page, { policy: policyOf(page), target: target.selector, stepWords: target.label, allow: env.allow, log: env.log, move: env.move ? (x, y) => env.move!(x, y, 450) : undefined, pace: env.pace })
  out.closed.push(...cl.closed)
  await thumbs[0].evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => undefined)
  await nap(100)
  const infos = await Promise.all(thumbs.map((t) => t.evaluate(infoIn)))
  // along the track; two thumbs on the very same track (two inputs laid over each other) go by their values
  const order = thumbs.map((_, i) => i).sort((a, b) => {
    const A = infos[a]!
    const B = infos[b]!
    if (Math.abs(A.rect.x - B.rect.x) < 4 && Math.abs(A.rect.y - B.rect.y) < 4) return A.now - B.now
    return A.vertical ? A.rect.y - B.rect.y : A.rect.x - B.rect.x
  })
  thumbs = order.map((i) => thumbs[i])
  const dual = want.min !== undefined && want.max !== undefined && thumbs.length >= 2
  if (want.min !== undefined && want.max !== undefined && thumbs.length < 2) return { ...out, skipped: { what, why: 'a range of two values was asked for but this slider has one thumb' } }
  const jobs: Array<{ th: ElementHandle<Element>; v: number; name: string }> = dual
    ? [{ th: thumbs[0], v: want.min!, name: 'lower' }, { th: thumbs[thumbs.length - 1], v: want.max!, name: 'upper' }]
    : [{ th: thumbs[0], v: (want.value ?? want.min ?? want.max)!, name: '' }]
  if (jobs.some((j) => j.v === undefined || !Number.isFinite(j.v))) return { ...out, skipped: { what, why: 'no value was given for it' } }
  // when the lower value is above where the upper thumb is now, the upper moves first
  if (dual) {
    const upNow = (await thumbs[thumbs.length - 1].evaluate(infoIn))!.now
    if (want.min! > upNow) jobs.reverse()
  }
  const results: string[] = []
  let allOk = true
  for (const j of jobs) {
    const r = await moveThumb(env, j.th, j.v)
    results.push(`${j.name ? j.name + ' ' : ''}${r.now}`)
    env.log(`    slider ${j.name || 'thumb'}: wanted ${j.v}, reads ${r.now}`)
    if (!r.ok) allOk = false
    out.rect = r.rect ?? out.rect
  }
  out.did = 1
  out.landed = true
  out.changed = true
  out.verified = allOk
  out.last = (await thumbs[0].evaluate(deepPathInPage).catch(() => undefined)) as string | undefined
  if (!allOk) return { ...out, verified: false, skipped: { what, why: `the slider could not be set exactly (it reads ${results.join(', ')}, not ${jobs.map((j) => j.v).join(' and ')})` } }
  out.seen.push(`The slider "${target.label}" is set to ${dual ? `${want.min} to ${want.max}` : jobs[0].v}`)
  return out
}

async function moveThumb(env: Env, th: ElementHandle<Element>, v: number): Promise<{ ok: boolean; now: number; rect?: Rect }> {
  const { page } = env
  let info = (await th.evaluate(infoIn))!
  const target = Math.max(info.min, Math.min(info.max, v))
  const tol = Math.max(info.step / 2, (info.max - info.min) * 0.002)
  const read = async () => (await th.evaluate(infoIn))!.now
  const xFor = (i: SliderInfo, val: number): { x: number; y: number } => {
    const frac = (val - i.min) / (i.max - i.min || 1)
    if (i.kind === 'range') {
      const t = 8 // half of the browser's own thumb
      return i.vertical ? { x: i.rect.x + i.rect.w / 2, y: i.rect.y + i.rect.h - t - (i.rect.h - 2 * t) * frac } : { x: i.rect.x + t + (i.rect.w - 2 * t) * frac, y: i.rect.y + i.rect.h / 2 }
    }
    const tr = i.track ?? i.rect
    return i.vertical ? { x: i.rect.x + i.rect.w / 2, y: tr.y + tr.h - tr.h * frac } : { x: tr.x + tr.w * frac, y: i.rect.y + i.rect.h / 2 }
  }
  if (Math.abs(info.now - target) > tol) {
    // the pointer takes the thumb where it is and carries it to the new place
    const from = info.kind === 'range' ? xFor(info, info.now) : { x: info.rect.x + info.rect.w / 2, y: info.rect.y + info.rect.h / 2 }
    const to = xFor(info, target)
    const top = await th.evaluate((el, x, y) => { let t = document.elementFromPoint(x, y); for (let i = 0; i < 6 && t && (t as HTMLElement).shadowRoot; i++) { const n = (t as HTMLElement).shadowRoot!.elementFromPoint(x, y); if (!n || n === t) break; t = n } for (let n: Node | null = t; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === el) return true; return false }, from.x, from.y).catch(() => false)
    if (top) {
      if (env.move) await env.move(from.x, from.y, 500)
      else await page.mouse.move(from.x, from.y, { steps: 4 })
      await nap(150 * Math.max(env.pace, 0.3))
      await page.mouse.down()
      const steps = env.pace ? 24 : 8
      for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (to.x - from.x) * (i / steps), from.y + (to.y - from.y) * (i / steps)); await nap(env.pace ? 20 : 3) }
      await page.mouse.up()
      await nap(200)
    }
  }
  // the keys finish the job exactly
  info = (await th.evaluate(infoIn))!
  if (Math.abs(info.now - target) > tol) {
    await th.evaluate((el) => (el as HTMLElement).focus({ preventScroll: true })).catch(() => undefined)
    for (let guard = 0; guard < 4; guard++) {
      const now = await read()
      const diff = target - now
      if (Math.abs(diff) <= tol) break
      const n = Math.min(120, Math.max(1, Math.round(Math.abs(diff) / info.step)))
      const key = diff > 0 ? 'ArrowRight' : 'ArrowLeft'
      for (let i = 0; i < n; i++) await page.keyboard.press(key)
      await nap(60)
    }
  }
  // a page that ignores keys: set the value and tell the page, as a drag would
  info = (await th.evaluate(infoIn))!
  if (info.kind === 'range' && Math.abs(info.now - target) > tol) {
    await th.evaluate((el, val) => {
      const i = el as HTMLInputElement
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      set?.call(i, String(val))
      i.dispatchEvent(new Event('input', { bubbles: true }))
      i.dispatchEvent(new Event('change', { bubbles: true }))
    }, target)
    await nap(120)
  }
  const now = await read()
  const b = await th.boundingBox()
  return { ok: Math.abs(now - target) <= tol, now, rect: b ? { x: b.x - 40, y: b.y - 40, w: b.width + 80, h: b.height + 80 } : undefined }
}

// ---------------------------------------------------------------- dates

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const SHORT = MONTHS.map((m) => m.slice(0, 3))

/** in the page: the calendar that is open (a grid of days with a month and year) and what it shows */
function calendarIn(): { sel: string; month: number; year: number; days: number; prev: string | null; next: string | null; selects: boolean } | null {
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 && getComputedStyle(e).visibility !== 'hidden' }
  const pathOf = (el: Element): string => {
    const parts: string[] = []
    for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break }
      const sibs = Array.from(n.parentElement?.children ?? [])
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
    }
    return parts.join(' > ')
  }
  const cands = Array.from(document.querySelectorAll('[role=grid],[role=dialog],table,[class*=calendar i],[class*=datepicker i],[class*=date-picker i],[class*=picker i],[class*=flatpickr],[class*=ui-datepicker],[class*=DayPicker],[class*=rdp]')).filter(vis)
  let best: { el: Element; days: number } | null = null
  for (const c of cands) {
    const cells = Array.from(c.querySelectorAll('td,button,[role=gridcell],[role=button],div,span')).filter((e) => e.children.length === 0 && /^\d{1,2}$/.test((e.textContent ?? '').trim()) && vis(e))
    const n = new Set(cells.map((e) => Number((e.textContent ?? '').trim()))).size
    if (n >= 27 && (!best || c.querySelectorAll('*').length < best.el.querySelectorAll('*').length)) best = { el: c, days: n }
  }
  if (!best) return null
  // the grid of days alone has no heading: the calendar is the nearest box around it that says which month it shows
  let cal = best.el
  const monthWord = new RegExp(String.raw`(${MONTHS.map((m) => m.slice(0, 3)).join('|')})[a-z]*\.?,?\s+\d{4}|\d{4}\s*[-/.]\s*\d{1,2}`, 'i')
  for (let i = 0; i < 4 && cal.parentElement && !monthWord.test((cal as HTMLElement).innerText ?? '') && !cal.querySelector('select'); i++) cal = cal.parentElement
  const text = ((cal as HTMLElement).innerText ?? '').toLowerCase()
  let month = -1
  let year = 0
  let selects = false
  const ms = Array.from(cal.querySelectorAll('select')) as HTMLSelectElement[]
  if (ms.length) {
    for (const s of ms) {
      const t = (s.selectedOptions[0]?.text ?? '').toLowerCase()
      const mi = MONTHS.findIndex((m) => t.startsWith(m.slice(0, 3)))
      if (mi >= 0) month = mi
      else if (/^\d{4}$/.test(t.trim())) year = Number(t.trim())
    }
    selects = month >= 0
  }
  if (month < 0 || !year) {
    const head = Array.from(cal.querySelectorAll('*')).map((e) => ((e as HTMLElement).innerText ?? '').trim()).find((t) => t.length < 28 && new RegExp(`(${MONTHS.map((m) => m.slice(0, 3)).join('|')})[a-z]*\\.?,?\\s+\\d{4}`, 'i').test(t))
    const src = (head ?? text).toLowerCase()
    const m = new RegExp(`(${MONTHS.map((x) => x.slice(0, 3)).join('|')})[a-z]*\\.?,?\\s+(\\d{4})`).exec(src)
    if (m) { month = MONTHS.findIndex((x) => x.startsWith(m[1])); year = Number(m[2]) }
    else {
      const n = /(\d{4})\s*[-/.]\s*(\d{1,2})\b/.exec(src)
      if (n) { year = Number(n[1]); month = Number(n[2]) - 1 }
    }
  }
  const btns = Array.from(cal.querySelectorAll('button,[role=button],a,span,div')).filter((e) => vis(e) && e.children.length <= 1)
  const named = (re: RegExp) => btns.find((b) => re.test(`${b.getAttribute('aria-label') ?? ''} ${b.getAttribute('title') ?? ''} ${(b as HTMLElement).className && typeof (b as HTMLElement).className === 'string' ? (b as HTMLElement).className : ''} ${(b.textContent ?? '').trim().length <= 2 ? (b.textContent ?? '').trim() : ''}`))
  const prev = named(/prev|previous|back|‹|«|←|<|chevron-left|arrow-left/i)
  const next = named(/next|forward|›|»|→|>|chevron-right|arrow-right/i)
  return { sel: pathOf(cal), month, year, days: best.days, prev: prev ? pathOf(prev) : null, next: next ? pathOf(next) : null, selects }
}

/** in the page: the cell of a day, by what it says it is (its label, a data attribute, or its number) */
function dayCellIn(calSel: string, iso: string): string | null {
  const cal = document.querySelector(calSel)
  if (!cal) return null
  const [y, m, d] = iso.split('-').map(Number)
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
  const vis = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 }
  const disabled = (e: Element) => { const t = `${e.getAttribute('class') ?? ''} ${e.getAttribute('aria-disabled') ?? ''}`; return e.hasAttribute('disabled') || /\b(disabled|unavailable)\b|true/i.test(t) }
  const outside = (e: Element) => /outside|other-?month|prevMonth|nextMonth|muted|adjacent|ghost|not-?current|out-of-month/i.test(`${e.getAttribute('class') ?? ''} ${e.parentElement?.getAttribute('class') ?? ''}`) || e.getAttribute('data-outside') === 'true' || e.getAttribute('aria-hidden') === 'true'
  const pathOf = (el: Element): string => {
    const parts: string[] = []
    for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break }
      const sibs = Array.from(n.parentElement?.children ?? [])
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
    }
    return parts.join(' > ')
  }
  const all = Array.from(cal.querySelectorAll('*')).filter(vis)
  const iso0 = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  // 1. the date written in an attribute
  for (const e of all) {
    for (const a of ['data-date', 'datetime', 'data-day', 'data-value', 'data-iso', 'data-timestamp']) {
      const v = e.getAttribute(a)
      if (v && (v.startsWith(iso0) || v === String(d) && a === 'data-day')) { if (!disabled(e) && !(outside(e) && v === String(d))) return pathOf(e) }
    }
  }
  // 2. a label that names the day, month and year
  const mn = MONTHS[m - 1]
  const re = new RegExp(`(?:^|\\b)(?:${d}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mn.slice(0, 3)}[a-z]*|${mn.slice(0, 3)}[a-z]*\\.?\\s+${d}(?:st|nd|rd|th)?)\\b(?:,?\\s*${y})?`, 'i')
  for (const e of all) {
    const t = `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('title') ?? ''}`
    if (t.trim() && re.test(t) && !disabled(e)) return pathOf(e)
  }
  // 3. the number itself, among the days of the month shown
  const num = all.filter((e) => e.children.length === 0 && (e.textContent ?? '').trim() === String(d) && !outside(e) && !disabled(e))
  if (num.length) {
    const cell = num[0]
    const btn = cell.closest('button,td,[role=gridcell],[role=button]') ?? cell
    return pathOf(btn)
  }
  return null
}

/** in the page: what a date box shows */
function dateValueIn(el: Element): string {
  const i = el as HTMLInputElement
  return typeof i.value === 'string' && /^(INPUT|TEXTAREA)$/.test(el.tagName) ? i.value : ((el as HTMLElement).innerText ?? el.textContent ?? '')
}

export function dateWords(iso: string): { y: number; m: number; d: number; long: string; short: string } {
  const [y, m, d] = iso.split('-').map(Number)
  return { y, m, d, long: `${MONTHS[m - 1]} ${d}`, short: `${SHORT[m - 1]} ${d}` }
}

/** does text written by a page say this date? ("2026-11-27", "27/11/2026", "Nov 27, 2026", "27 November 2026", "Fri, Nov 27") */
export function saysDate(text: string, iso: string): boolean {
  const { y, m, d } = dateWords(iso)
  const t = text.toLowerCase().replace(/\s+/g, ' ')
  const dd = String(d).padStart(2, '0')
  const mm = String(m).padStart(2, '0')
  if (t.includes(`${y}-${mm}-${dd}`) || t.includes(`${dd}/${mm}/${y}`) || t.includes(`${mm}/${dd}/${y}`) || t.includes(`${d}/${m}/${y}`) || t.includes(`${m}/${d}/${y}`) || t.includes(`${dd}.${mm}.${y}`) || t.includes(`${dd}-${mm}-${y}`)) return true
  const mon = `${SHORT[m - 1]}[a-z]*\\.?`
  return new RegExp(`\\b${d}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon},?\\s+${y}\\b`).test(t) || new RegExp(`\\b${mon}\\s+${d}(?:st|nd|rd|th)?,?\\s+${y}\\b`).test(t)
}

export async function doDate(env: Env, target: { selector: string; label: string } | null, iso: string, phrase: string): Promise<Outcome> {
  const { page } = env
  const out = blank()
  const what = `choosing the date "${phrase}"`
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return { ...out, skipped: { what, why: 'the date could not be worked out' } }
  const day = iso.slice(0, 10)
  const { y, m, d } = dateWords(day)
  // a calendar that is already open (nothing to press first): it is read and used as it is
  const open0 = await page.evaluate(calendarIn).catch(() => null)
  const nativeOnPage = await page.evaluate(() => Array.from(document.querySelectorAll('input[type=date],input[type=datetime-local]')).some((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 })).catch(() => false)
  if (open0 && !nativeOnPage && open0.month >= 0 && open0.year) {
    const cl0 = await clearOverlays(page, { policy: policyOf(page), stepWords: phrase, allow: env.allow, log: env.log, pace: env.pace })
    out.closed.push(...cl0.closed)
    return chooseOnCalendar(env, out, open0, day, what, target?.label ?? 'the calendar', undefined, async () => '')
  }
  let h = target ? await deepHandle(page, target.selector) : null
  if (!h) {
    // a date box nobody named: the first one on the page
    h = (await page.evaluateHandle(() => Array.from(document.querySelectorAll('input[type=date],input[type=datetime-local],input[placeholder*=date i],input[name*=date i],input[id*=date i],input[aria-label*=date i],[class*=date i] input')).find((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 }) ?? null)).asElement() as ElementHandle<Element> | null
  }
  if (!h) return { ...out, skipped: { what, why: 'no date box or calendar was found' } }
  // a label, or a wrapper around the box, stands for the box it names
  h = ((await h.evaluateHandle((el) => (el as HTMLLabelElement).control ?? (el.matches('input,textarea') ? el : el.querySelector('input[type=date],input[type=datetime-local],input:not([type=hidden]),textarea')) ?? el)).asElement() as ElementHandle<Element> | null) ?? h
  const label = target?.label ?? 'the date'
  const cl = await clearOverlays(page, { policy: policyOf(page), target: target?.selector, stepWords: label, allow: env.allow, log: env.log, move: env.move ? (x, y) => env.move!(x, y, 450) : undefined, pace: env.pace })
  out.closed.push(...cl.closed)
  await h.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })).catch(() => undefined)
  await nap(100)
  const aim = await aimAt(page, h, 'left')
  const bb = await h.boundingBox()
  const pt = aim.pts[0] ?? (bb ? { x: bb.x + Math.min(bb.width / 2, 30), y: bb.y + bb.height / 2 } : null)
  if (!pt) return { ...out, skipped: { what, why: 'the date box is not visible on the page' } }
  const native = await h.evaluate((el) => (el instanceof HTMLInputElement && /^(date|datetime-local)$/.test(el.type) ? el.type : '')).catch(() => '')
  const tagIsInput = await h.evaluate((el) => el.tagName === 'INPUT').catch(() => false)
  const read = async () => (await h.evaluate(dateValueIn).catch(() => '')) as string
  out.rect = bb ? { x: bb.x - 20, y: bb.y - 20, w: bb.width + 40, h: bb.height + 40 } : undefined
  // a native date box takes its digits in the order of the browser's language
  if (native) {
    if (env.move) await env.move(pt.x, pt.y, 600)
    else await page.mouse.move(pt.x, pt.y, { steps: 5 })
    await nap(150 * env.pace)
    await page.mouse.click(pt.x - (bb ? bb.width / 2 - 12 : 0), pt.y)
    await nap(150)
    await page.keyboard.type(`${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}${y}`, { delay: env.pace ? 80 : 10 })
    await nap(200)
    let v = await read()
    if (!v.startsWith(day)) {
      // the other order (day first), then the value itself
      await h.evaluate((el) => { (el as HTMLInputElement).value = '' })
      await page.mouse.click(pt.x - (bb ? bb.width / 2 - 12 : 0), pt.y)
      await page.keyboard.type(`${String(d).padStart(2, '0')}${String(m).padStart(2, '0')}${y}`, { delay: 10 })
      v = await read()
    }
    if (!v.startsWith(day)) {
      await h.evaluate((el, val) => {
        const i = el as HTMLInputElement
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(i, val)
        i.dispatchEvent(new Event('input', { bubbles: true }))
        i.dispatchEvent(new Event('change', { bubbles: true }))
      }, native === 'date' ? day : `${day}T09:00`)
      v = await read()
    }
    out.did = 1
    out.landed = true
    out.changed = true
    out.verified = v.startsWith(day)
    out.last = target?.selector
    if (!out.verified) return { ...out, skipped: { what, why: `the box reads "${v}", not ${day}` } }
    out.seen.push(`The date box "${label}" now says ${day}`)
    return out
  }
  // a calendar: open it, read the month it shows, move to the right one, press the day
  if (env.move) await env.move(pt.x, pt.y, 600)
  else await page.mouse.move(pt.x, pt.y, { steps: 5 })
  await nap(150 * env.pace)
  await page.mouse.click(pt.x, pt.y)
  await nap(450)
  let cal = await page.evaluate(calendarIn).catch(() => null)
  if (!cal && tagIsInput) {
    // some pickers open on a second look, or want a typed date
    await nap(500)
    cal = await page.evaluate(calendarIn).catch(() => null)
  }
  if (!cal) {
    if (tagIsInput) {
      // no calendar: type it (the page may parse it itself)
      for (const text of [day, `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`, `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`]) {
        await h.evaluate((el) => { const i = el as HTMLInputElement; if (typeof i.select === 'function') i.select() })
        await page.keyboard.type(text, { delay: env.pace ? 45 : 5 })
        await page.keyboard.press('Enter')
        await nap(300)
        if (saysDate(await read(), day)) {
          out.did = 1; out.landed = true; out.changed = true; out.verified = true; out.last = target?.selector
          out.seen.push(`The date box "${label}" now says ${text}`)
          return out
        }
      }
    }
    return { ...out, skipped: { what, why: 'no calendar opened and the box did not take a typed date' } }
  }
  return chooseOnCalendar(env, out, cal, day, what, label, target?.selector, read)
}

type Cal = { sel: string; month: number; year: number; days: number; prev: string | null; next: string | null; selects: boolean }

/** moves an open calendar to the month of a day and presses the day; the box (when there is one) is read back to check */
async function chooseOnCalendar(env: Env, out: Outcome, cal0: Cal, day: string, what: string, label: string, last: string | undefined, read: () => Promise<string>): Promise<Outcome> {
  const { page } = env
  const { y, m, d } = dateWords(day)
  let cal: Cal = cal0
  const target = last ? { selector: last } : null
  if (cal.month < 0 || !cal.year) return { ...out, skipped: { what, why: 'the month the calendar shows could not be read' } }
  const wantIdx = y * 12 + (m - 1)
  for (let guard = 0; guard < 26; guard++) {
    const diff = wantIdx - (cal.year * 12 + cal.month)
    if (diff === 0) break
    if (cal.selects) {
      // month and year are drop-downs
      await page.evaluate((sel, mi, yy) => {
        const root = document.querySelector(sel)
        for (const s of Array.from(root?.querySelectorAll('select') ?? []) as HTMLSelectElement[]) {
          const idx = Array.from(s.options).findIndex((o) => (/^\d{4}$/.test(o.text.trim()) ? Number(o.text.trim()) === yy : o.text.toLowerCase().startsWith(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][mi])))
          if (idx >= 0) { s.selectedIndex = idx; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })) }
        }
      }, cal.sel, m - 1, y)
    } else {
      const btn = diff > 0 ? cal.next : cal.prev
      if (!btn) return { ...out, skipped: { what, why: `the calendar shows ${MONTHS[cal.month]} ${cal.year} and has no ${diff > 0 ? 'next' : 'previous'} month button` } }
      // pressed the way any control is: brought into view, a point that really shows it, and the press must land
      const pressed = await doClick(env, { selector: btn, label: diff > 0 ? 'next month' : 'previous month' }, { once: true })
      if (pressed.skipped) return { ...out, skipped: { what, why: `the calendar's ${diff > 0 ? 'next' : 'previous'} month button could not be pressed (${pressed.skipped.why})` } }
    }
    await nap(env.pace ? 380 : 160)
    const again = await page.evaluate(calendarIn).catch(() => null)
    if (!again || (again.year === cal.year && again.month === cal.month && !cal.selects)) return { ...out, skipped: { what, why: 'the calendar did not move to another month' } }
    cal = again
  }
  if (cal.year * 12 + cal.month !== wantIdx) return { ...out, skipped: { what, why: `the calendar could not be moved to ${MONTHS[m - 1]} ${y}` } }
  const cellSel = await page.evaluate(dayCellIn, cal.sel, day)
  if (!cellSel) return { ...out, skipped: { what, why: `${MONTHS[m - 1]} ${d}, ${y} is not on the calendar, or it is not available` } }
  const dayPress = await doClick(env, { selector: cellSel, label: `${MONTHS[m - 1]} ${d}` }, { once: true })
  if (dayPress.skipped) return { ...out, skipped: { what, why: `the day could not be pressed (${dayPress.skipped.why})` } }
  await nap(450)
  // some calendars wait for "Apply" / "Done"
  const apply = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button,[role=button]')).find((x) => /^(apply|done|ok|select|set date|choose)$/i.test(((x as HTMLElement).innerText ?? '').trim()) && x.getBoundingClientRect().width > 4)
    if (!b) return null
    const parts: string[] = []
    for (let n: Element | null = b; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break }
      const sibs = Array.from(n.parentElement?.children ?? [])
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
    }
    return parts.join(' > ')
  }).catch(() => null)
  let v = await read()
  if (apply && !saysDate(v, day)) { await doClick(env, { selector: apply, label: 'apply' }, { once: true }); await nap(350); v = await read() }
  const shown = saysDate(v, day) || (!v && saysDate(await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''), day)) || (await page.evaluate((sel) => { const e = document.querySelector(sel); return e ? (e.getAttribute('aria-selected') === 'true' || /selected|active|checked/.test(e.getAttribute('class') ?? '') || e.getAttribute('aria-pressed') === 'true') : false }, cellSel).catch(() => false))
  out.did = 1
  out.landed = true
  out.changed = true
  out.verified = shown
  out.last = target?.selector
  if (!shown) out.note = `the day was pressed in the calendar, but the date box reads "${v.slice(0, 40)}"`
  else out.seen.push(`The calendar is moved to ${MONTHS[m - 1]} ${y} and ${d} is chosen${v ? `; the box says "${v.slice(0, 40)}"` : ''}`)
  return out
}

// ---------------------------------------------------------------- scrolling until something shows

/** in the page: where the words are on the page and whether they are on screen now */
function textState(wanted: string): { found: boolean; visible: boolean; path: string } {
  const norm = (s: string) => (s || '').toLowerCase().replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const w = norm(wanted)
  if (!w) return { found: false, visible: false, path: '' }
  const pathOf = (el: Element): string => {
    const parts: string[] = []
    for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id && document.querySelectorAll('#' + CSS.escape(n.id)).length === 1) { parts.unshift('#' + CSS.escape(n.id)); break }
      const sibs = Array.from(n.parentElement?.children ?? [])
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
    }
    return parts.join(' > ')
  }
  let best: Element | null = null
  const els = Array.from(document.querySelectorAll('body *')).slice(0, 9000)
  for (const el of els) {
    if (/^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue
    const t = norm((el as HTMLElement).innerText ?? el.textContent ?? '')
    if (!t.includes(w)) continue
    if (Array.from(el.children).some((c) => norm((c as HTMLElement).innerText ?? c.textContent ?? '').includes(w))) continue
    best = el
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) break
  }
  if (!best) return { found: false, visible: false, path: '' }
  const r = best.getBoundingClientRect()
  const visible = r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left < innerWidth && getComputedStyle(best).visibility !== 'hidden'
  return { found: true, visible, path: pathOf(best) }
}

/** in the page: the place the wheel should turn (the area the words name, else the biggest scrolling area, else the page) and how far it can go */
function scrollerPoint(within: string[], horizontal: boolean): { x: number; y: number; inner: boolean; room: number } {
  const vw = innerWidth
  const vh = innerHeight
  const words = within.map((w) => w.toLowerCase()).filter((w) => w.length > 2 && !/^(the|row|list|feed|area|section|panel)$/.test(w))
  const over = horizontal ? 'overflowX' : 'overflowY'
  let best: { el: Element; a: number; named: boolean } | null = null
  for (const el of Array.from(document.querySelectorAll('*')).slice(0, 5000)) {
    const cs = getComputedStyle(el)
    const room = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    if (!/(auto|scroll)/.test(cs[over]) || room <= 40) continue
    const r = el.getBoundingClientRect()
    const a = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
    if (a < 6000) continue
    const hay = `${el.id} ${typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : ''} ${el.getAttribute('aria-label') ?? ''} ${((el.previousElementSibling as HTMLElement | null)?.innerText ?? '').slice(0, 40)}`.toLowerCase()
    const named = words.length > 0 && words.every((w) => hay.includes(w))
    if (!best || (named && !best.named) || (named === best.named && a > best.a)) best = { el, a, named }
  }
  const pageRoom = horizontal ? document.documentElement.scrollWidth - vw - scrollX : document.documentElement.scrollHeight - vh - scrollY
  if (best && (best.named || (horizontal ? best.el.scrollWidth - best.el.clientWidth - best.el.scrollLeft : best.el.scrollHeight - best.el.clientHeight - best.el.scrollTop) > 10 || pageRoom < 10)) {
    const r = best.el.getBoundingClientRect()
    const room = horizontal ? best.el.scrollWidth - best.el.clientWidth - best.el.scrollLeft : best.el.scrollHeight - best.el.clientHeight - best.el.scrollTop
    return { x: (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2, y: (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2, inner: true, room }
  }
  return { x: vw / 2, y: vh / 2, inner: false, room: pageRoom }
}

/** in the page: how far the scrolled things are from their start, so a scroll that moved nothing is known */
function scrollSum(): number {
  let n = scrollY + scrollX
  for (const el of Array.from(document.querySelectorAll('*')).slice(0, 4000)) n += (el as HTMLElement).scrollTop + (el as HTMLElement).scrollLeft
  return n
}

export async function doScrollUntil(env: Env, text: string, o: { dir?: 'down' | 'up' | 'left' | 'right'; within?: string[]; cap?: number } = {}): Promise<Outcome> {
  const cap = o.cap ?? 45
  const dir = o.dir ?? 'down'
  const horizontal = dir === 'left' || dir === 'right'
  const sign = dir === 'up' || dir === 'left' ? -1 : 1
  const { page } = env
  const out = blank()
  const what = `scrolling until "${text}" shows`
  let steps = 0
  let stuck = 0
  const base = await stateOf(page)
  for (; steps < cap; steps++) {
    const st = await page.evaluate(textState, text).catch(() => ({ found: false, visible: false, path: '' }))
    if (st.visible) {
      out.did = steps
      out.changed = steps > 0
      out.verified = true
      out.landed = true
      out.last = st.path
      out.seen.push(`Scrolling ${steps ? `down ${steps} time${steps === 1 ? '' : 's'}` : 'is not needed:'} "${text}" is on screen`.replace(': "', ' because "'))
      return out
    }
    if (st.found) {
      // it is on the page, below or above the view: bring it to the middle
      await deepHandle(page, st.path).then((h) => h?.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'smooth' }))).catch(() => undefined)
      await nap(env.pace ? 900 : 400)
      const after = await page.evaluate(textState, text).catch(() => ({ found: false, visible: false, path: '' }))
      if (after.visible) {
        out.did = steps + 1
        out.changed = true
        out.verified = true
        out.landed = true
        out.last = after.path
        out.seen.push(`Scrolling down brings "${text}" into view`)
        return out
      }
    }
    const sp = await page.evaluate(scrollerPoint, o.within ?? [], horizontal)
    const before = await page.evaluate(scrollSum)
    if (env.move) await env.move(sp.x, sp.y, 300)
    else await page.mouse.move(sp.x, sp.y)
    const vp = page.viewport() ?? { width: 1280, height: 720 }
    await page.mouse.wheel(horizontal ? { deltaX: sign * Math.round(vp.width * 0.6) } : { deltaY: sign * Math.round(vp.height * 0.7) })
    // a feed loads more when the end comes near: give it a moment
    await nap(env.pace ? 650 : 380)
    const room = (await page.evaluate(scrollerPoint, o.within ?? [], horizontal)).room
    const moved = Math.abs((await page.evaluate(scrollSum)) - before)
    if (moved < 2 && (room < 5 || dir === 'up' || dir === 'left')) {
      stuck++
      await nap(900) // a slow feed
      if (stuck >= 3) break
    } else stuck = 0
  }
  // "wait for X to load": no direction was given, so the text is waited for even when nothing scrolls
  if (!o.dir) {
    const stop = Date.now() + 10000
    while (Date.now() < stop) {
      const st = await page.evaluate(textState, text).catch(() => ({ found: false, visible: false, path: '' }))
      if (st.visible) break
      if (st.found) { await deepHandle(page, st.path).then((h) => h?.evaluate((el) => el.scrollIntoView({ block: 'center' }))).catch(() => undefined) }
      await nap(300)
    }
  }
  const final = await page.evaluate(textState, text).catch(() => ({ found: false, visible: false, path: '' }))
  const moved = stateDiff(base, await stateOf(page)).length > 0
  if (final.visible) {
    out.did = steps; out.changed = moved; out.verified = true; out.landed = true; out.last = final.path
    out.seen.push(`Scrolling down ${steps} time${steps === 1 ? '' : 's'} brings "${text}" into view`)
    return out
  }
  return { ...out, did: steps, changed: moved, verified: false, skipped: { what, why: steps >= cap ? `"${text}" did not appear after ${steps} scrolls` : `the end of the page was reached and "${text}" never showed` } }
}
