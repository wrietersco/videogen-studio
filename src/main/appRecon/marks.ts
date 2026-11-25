/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import sharp from 'sharp'
import type { Page } from 'puppeteer-core'
import type { FindSpec, Rect } from '@shared/appRecon'
import { settleScroll } from './sections'

/**
 * Marks of a chart: "hover a line on the chart", "click the blue, green and orange lines".
 *
 * A chart can be SVG, a canvas or WebGL, and in the last two there is nothing in the page's markup to point at. So the chart
 * is looked at the way a person looks at it: a picture of its area is taken, the pixels of the colour named are found (blue,
 * green, orange ...), and the pointer goes there. Whether a tooltip appears is seen from the page itself (new text, a tooltip
 * box) or, for charts that draw their own tooltip, from the picture changing around the pointer.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ChartBox {
  title: string
  /** the visible part of the chart, in viewport pixels */
  rect: Rect
  kind: 'svg' | 'canvas' | 'other'
}

/** in the page: the charts (canvas / big svg) that are on screen, the one the words point at first */
function chartsOnScreen(hint: string): { title: string; rect: Rect; kind: 'svg' | 'canvas' | 'other'; area: number; hinted: boolean; marks: number } | null {
  const vw = innerWidth
  const vh = innerHeight
  const words = (hint || '').toLowerCase().normalize('NFKD').replace(/[‐-―−\-_/]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'chart', 'charts', 'graph', 'plot', 'circle'].includes(w))
  type C = { el: Element; r: DOMRect; title: string; area: number; hinted: boolean; marks: number }
  const out: C[] = []
  for (const el of Array.from(document.querySelectorAll('canvas,svg'))) {
    if (el.closest('svg') && el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) continue // a drawing inside a drawing
    const r = el.getBoundingClientRect()
    if (r.width < 120 || r.height < 80) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue
    const x0 = Math.max(0, r.left)
    const y0 = Math.max(0, r.top)
    const x1 = Math.min(vw, r.right)
    const y1 = Math.min(vh, r.bottom)
    const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
    const box = el.closest('section,article,[class*=card],[class*=panel],[class*=box],[class*=chart],[class*=plot]') ?? el.parentElement
    const head = box?.querySelector('h1,h2,h3,h4,h5,h6,legend,figcaption,[class*=title]')
    const title = ((head as HTMLElement | null)?.innerText ?? el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    const around = `${title} ${el.id} ${typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : (el.getAttribute('class') ?? '')} ${(box as HTMLElement | null)?.innerText?.slice(0, 200) ?? ''}`.toLowerCase().normalize('NFKD').replace(/[‐-―−\-_/]+/g, ' ')
    const hinted = words.length > 0 && words.every((w) => around.includes(w))
    out.push({ el, r, title, area, hinted, marks: el.tagName.toLowerCase() === 'svg' ? el.querySelectorAll('path,circle,rect,line,polyline').length : 0 })
  }
  // a chart library stacks several drawings in the same place: the one with the most in it stands for them
  const seen = new Map<string, C>()
  for (const c of out) {
    const k = `${Math.round(c.r.left / 8)}:${Math.round(c.r.top / 8)}:${Math.round(c.r.width / 8)}:${Math.round(c.r.height / 8)}`
    const have = seen.get(k)
    if (!have || c.marks > have.marks) seen.set(k, c)
  }
  // a drawing counts as a chart when it is a canvas or has a good many marks in it (not a logo or an icon)
  const list = Array.from(seen.values()).filter((c) => c.area >= 6000 && (c.el.tagName.toLowerCase() !== 'svg' || c.marks >= 6))
  list.sort((a, b) => Number(b.hinted) - Number(a.hinted) || b.area - a.area)
  const best = list[0]
  if (!best) return null
  const x0 = Math.max(0, best.r.left)
  const y0 = Math.max(0, best.r.top)
  const x1 = Math.min(vw, best.r.right)
  const y1 = Math.min(vh, best.r.bottom)
  return { title: best.title, rect: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, kind: best.el.tagName.toLowerCase() === 'svg' ? 'svg' : best.el.tagName.toLowerCase() === 'canvas' ? 'canvas' : 'other', area: best.area, hinted: best.hinted, marks: best.marks }
}

/** in the page: scroll the best chart (by the words, else the biggest) to the middle of the screen */
function bringChartIntoView(hint: string): string | null {
  const words = (hint || '').toLowerCase().normalize('NFKD').replace(/[‐-―−\-_/]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'chart', 'charts', 'graph', 'plot', 'circle'].includes(w))
  let best: { el: Element; s: number } | null = null
  for (const el of Array.from(document.querySelectorAll('canvas,svg'))) {
    const r = el.getBoundingClientRect()
    if (r.width < 120 || r.height < 80) continue
    // a chart library keeps scratch drawings far off the page (top: -10000px): they are not on the page at all
    if (r.bottom + scrollY < 0 || r.right < 0 || r.left > innerWidth) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none') continue
    if (el.tagName.toLowerCase() === 'svg' && el.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse').length < 6) continue // a logo or an icon
    const box = el.closest('section,article,[class*=card],[class*=panel],[class*=box],[class*=chart],[class*=plot]') ?? el.parentElement
    const around = `${(box as HTMLElement | null)?.innerText?.slice(0, 200) ?? ''} ${el.id} ${el.getAttribute('class') ?? ''}`.toLowerCase().normalize('NFKD').replace(/[‐-―−\-_/]+/g, ' ')
    // the chart the person is looking at: the nearest one to the screen wins, then the biggest
    const gap = r.bottom < 0 ? -r.bottom : r.top > innerHeight ? r.top - innerHeight : 0
    const s = (r.width * r.height) / 1000 - gap * 10 + (words.length && words.every((w) => around.includes(w)) ? 1e7 : 0)
    if (!best || s > best.s) best = { el, s }
  }
  if (!best) return null
  // a page can ask for smooth scrolling: this jump is made at once
  best.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior })
  return `${best.el.tagName}.${best.el.getAttribute('class') ?? ''} at ${Math.round(best.el.getBoundingClientRect().top + scrollY)}`
}

/** the chart the words point at (or the biggest on screen), brought into view when none is */
export async function pickChart(page: Page, hint = ''): Promise<ChartBox | null> {
  let c = await page.evaluate(chartsOnScreen, hint).catch(() => null)
  if (!c || (hint && !c.hinted)) {
    if (await page.evaluate(bringChartIntoView, hint).catch(() => false)) {
      await settleScroll(page)
      c = await page.evaluate(chartsOnScreen, hint).catch(() => null)
    }
  }
  for (let i = 0; c && i < 2; i++) {
    const btn = await page.evaluate(coverDismissAt, c.rect).catch(() => null)
    if (!btn) break
    await page.mouse.click(btn.x, btn.y)
    await sleep(700)
    c = (await page.evaluate(chartsOnScreen, hint).catch(() => null)) ?? c
  }
  return c ? { title: c.title, rect: c.rect, kind: c.kind } : null
}

/**
 * in the page: a help card, tour or banner laid over the chart (a first-visit "How to read this circle" with a "Got it") hides the
 * marks and takes every hover and click. Returns where its dismiss button is (viewport pixels), or null when nothing covers the chart.
 */
function coverDismissAt(rect: { x: number; y: number; w: number; h: number }): { x: number; y: number; label: string } | null {
  const WORDS = /^(?:got it|ok|okay|close|dismiss|skip|skip tour|no thanks|not now|maybe later|done|hide|hide this|understood|×|✕|✖|x)$/i
  const pts = [
    [0.5, 0.5],
    [0.25, 0.3],
    [0.75, 0.3],
    [0.25, 0.7],
    [0.75, 0.7]
  ]
  for (const [fx, fy] of pts) {
    const x = rect.x + rect.w * fx
    const y = rect.y + rect.h * fy
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
    const top = document.elementFromPoint(x, y)
    if (!top || top.closest('canvas,svg')) continue
    // the layer that lies over the chart: the nearest positioned ancestor that holds a button which only closes it
    let layer: Element | null = top
    for (let i = 0; i < 8 && layer && layer !== document.body; i++, layer = layer.parentElement) {
      const pos = getComputedStyle(layer).position
      if (pos !== 'absolute' && pos !== 'fixed' && pos !== 'sticky') continue
      for (const b of Array.from(layer.querySelectorAll('button,[role=button],a'))) {
        const label = ((b as HTMLElement).innerText || b.getAttribute('aria-label') || b.getAttribute('title') || '').trim()
        if (!WORDS.test(label)) continue
        const r = b.getBoundingClientRect()
        if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, label }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------- colours

/** red, orange ... by hue; `light` says it must be bright enough to be a line and not a shadow */
export type ColourName = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'cyan' | 'blue' | 'purple' | 'pink' | 'brown' | 'black' | 'gray' | 'white'

export function isColour(name: string): name is ColourName {
  return ['red', 'orange', 'yellow', 'green', 'teal', 'cyan', 'blue', 'purple', 'pink', 'brown', 'black', 'gray', 'white'].includes(name)
}

/** which named colour a pixel is, or null for the paper and the faint grid */
export function colourOf(r: number, g: number, b: number): ColourName | null {
  const mx = Math.max(r, g, b) / 255
  const mn = Math.min(r, g, b) / 255
  const d = mx - mn
  const s = mx === 0 ? 0 : d / mx
  const v = mx
  if (s < 0.2) {
    if (v < 0.22) return 'black'
    if (v > 0.93) return null // paper
    return v > 0.35 && v < 0.78 && s < 0.12 ? 'gray' : null
  }
  if (s < 0.32 || v < 0.28) return null // pale tints and shadows are not lines
  let h = 0
  const R = r / 255
  const G = g / 255
  const B = b / 255
  if (d > 0) {
    if (mx === R) h = ((G - B) / d) % 6
    else if (mx === G) h = (B - R) / d + 2
    else h = (R - G) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  if (h >= 345 || h < 15) return 'red'
  if (h < 45) return v < 0.58 ? 'brown' : 'orange'
  if (h < 70) return 'yellow'
  if (h < 165) return 'green'
  if (h < 190) return 'teal'
  if (h < 205) return 'cyan'
  if (h < 258) return 'blue'
  if (h < 298) return 'purple'
  return 'pink'
}

export interface MarkPoint {
  colour: ColourName
  /** viewport pixels */
  x: number
  y: number
  /** how much of that colour is around the point */
  weight: number
}

async function pictureOf(page: Page, rect: Rect): Promise<{ data: Buffer; w: number; h: number; k: number } | null> {
  try {
    const sc = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
    const png = (await page.screenshot({ type: 'png', clip: { x: rect.x + sc.x, y: rect.y + sc.y, width: rect.w, height: rect.h }, captureBeyondViewport: true })) as Uint8Array
    const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return { data, w: info.width, h: info.height, k: info.width / rect.w }
  } catch {
    return null
  }
}

/**
 * The places in a picture where a colour is drawn, best first: cells of the picture that hold that colour, the densest
 * ones, spread apart so that several marks of the same colour can be shown one after another. A thin line is wanted as a
 * line (not a filled swatch of the legend) when `thin` is set.
 */
export function colourSpots(pic: { data: Buffer; w: number; h: number; k: number }, want: ColourName | null, o: { thin?: boolean; max?: number; spread?: number } = {}): MarkPoint[] {
  const cell = Math.max(6, Math.round(8 * pic.k))
  const cols = Math.ceil(pic.w / cell)
  const rows = Math.ceil(pic.h / cell)
  type Cell = { n: Record<string, number>; sx: Record<string, number>; sy: Record<string, number> }
  const grid: Cell[] = new Array(cols * rows)
  for (let y = 0; y < pic.h; y++) {
    for (let x = 0; x < pic.w; x++) {
      const i = (y * pic.w + x) * 4
      const c = colourOf(pic.data[i], pic.data[i + 1], pic.data[i + 2])
      if (!c || (want ? c !== want : c === 'black' || c === 'gray' || c === 'white')) continue
      const ci = Math.floor(y / cell) * cols + Math.floor(x / cell)
      const g = (grid[ci] ??= { n: {}, sx: {}, sy: {} })
      g.n[c] = (g.n[c] ?? 0) + 1
      g.sx[c] = (g.sx[c] ?? 0) + x
      g.sy[c] = (g.sy[c] ?? 0) + y
    }
  }
  const area = cell * cell
  const all: MarkPoint[] = []
  for (let ci = 0; ci < grid.length; ci++) {
    const g = grid[ci]
    if (!g) continue
    for (const c of Object.keys(g.n) as ColourName[]) {
      const n = g.n[c]
      if (n < Math.max(4, Math.round(area * 0.04))) continue
      const fill = n / area
      // a thin line fills little of its cell; a legend swatch or a filled shape fills most of it
      const w = o.thin && fill > 0.7 ? n * 0.3 : n
      all.push({ colour: c, x: g.sx[c] / n / pic.k, y: g.sy[c] / n / pic.k, weight: w })
    }
  }
  all.sort((a, b) => b.weight - a.weight)
  const spread = o.spread ?? 36
  const out: MarkPoint[] = []
  for (const p of all) {
    if (out.some((q) => q.colour === p.colour && Math.hypot(q.x - p.x, q.y - p.y) < spread)) continue
    out.push(p)
    if (out.length >= (o.max ?? 12)) break
  }
  return out
}

/** the pixel nearest the centre of a spot that really has the colour (the centre of a thin diagonal line can sit between its pixels) */
function snapToColour(pic: { data: Buffer; w: number; h: number; k: number }, p: MarkPoint): MarkPoint {
  const cx = Math.round(p.x * pic.k)
  const cy = Math.round(p.y * pic.k)
  const R = Math.round(10 * pic.k)
  let best: { d: number; x: number; y: number } | null = null
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= pic.w || y >= pic.h) continue
      const i = (y * pic.w + x) * 4
      if (colourOf(pic.data[i], pic.data[i + 1], pic.data[i + 2]) !== p.colour) continue
      const d = dx * dx + dy * dy
      if (!best || d < best.d) best = { d, x, y }
    }
  }
  return best ? { ...p, x: best.x / pic.k, y: best.y / pic.k } : p
}

// ---------------------------------------------------------------- tooltips

/** in the page: the short texts that are drawn right now */
function visibleTexts(): string[] {
  const out = new Set<string>()
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 6000)) {
    if (el.children.length > 3) continue
    const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!t || t.length > 220) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    out.add(t)
  }
  return Array.from(out)
}

/** in the page: tooltip-like boxes that are showing */
function tooltipBoxes(): string[] {
  const out: string[] = []
  for (const el of Array.from(document.querySelectorAll('[role=tooltip],[class*=tooltip i],[class*=tippy],[class*=popover i],.hovertext,[class*=hover-text i],[class*=hoverlabel i],[id*=tooltip i]'))) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    if (r.width < 4 || r.height < 4 || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) continue
    const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (t) out.push(t.slice(0, 240))
  }
  // a tooltip with no telling name: a box floating over the page (fixed or absolute), a few words long, that is not a whole panel
  const vw = innerWidth
  const vh = innerHeight
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, 5000)) {
    const cs = getComputedStyle(el)
    if ((cs.position !== 'fixed' && cs.position !== 'absolute') || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) continue
    const r = el.getBoundingClientRect()
    if (r.width < 40 || r.height < 16 || r.width * r.height > vw * vh * 0.6 || r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue
    if (el.querySelectorAll('button,a,input,select').length > 2) continue
    const t = ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()
    if (t.length >= 8 && t.length <= 600) out.push(t.slice(0, 240))
  }
  return out
}

/** in the page: the browser's own tooltip text under the pointer (a title attribute, an svg <title>) */
function titleAt(x: number, y: number): string {
  const el = document.elementFromPoint(x, y)
  const t = el?.closest('[title]')?.getAttribute('title') ?? el?.querySelector('title')?.textContent ?? ''
  return (t ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
}

export interface Probed {
  x: number
  y: number
  /** what the tooltip says, when it is made of page text */
  tooltip?: string
  /** the chart drew something of its own around the pointer (a canvas tooltip or highlight) */
  drawn?: boolean
}

/** how many pixels differ between two pictures of the same area, leaving out the discs around the two pointer positions */
export function changedPixels(a: { data: Buffer; w: number; h: number; k: number }, b: { data: Buffer; w: number; h: number; k: number }, ignore: Array<{ x: number; y: number }>, radius = 48): number {
  if (a.w !== b.w || a.h !== b.h) return 0
  let n = 0
  const r2 = (radius * a.k) ** 2
  for (let y = 0; y < a.h; y += 2) {
    for (let x = 0; x < a.w; x += 2) {
      if (ignore.some((p) => (x - p.x * a.k) ** 2 + (y - p.y * a.k) ** 2 < r2)) continue
      const i = (y * a.w + x) * 4
      if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) > 60) n++
    }
  }
  return n
}

/** rests the pointer on each place in turn until the page shows a tooltip (or the chart draws one) */
export async function probeTooltips(page: Page, chart: ChartBox, spots: Array<{ x: number; y: number }>, o: { move?: (x: number, y: number) => Promise<void>; dwellMs?: number } = {}): Promise<Probed | null> {
  const move = o.move ?? (async (x: number, y: number) => { await page.mouse.move(x, y, { steps: 4 }) })
  const before = new Set(await page.evaluate(visibleTexts).catch(() => [] as string[]))
  const boxesBefore = new Set(await page.evaluate(tooltipBoxes).catch(() => [] as string[]))
  const still = await pictureOf(page, chart.rect)
  let prev = { x: -999, y: -999 }
  let drawnAt: Probed | null = null
  for (const s of spots.slice(0, 16)) {
    await move(s.x, s.y)
    await sleep(o.dwellMs ?? 220)
    const boxes = (await page.evaluate(tooltipBoxes).catch(() => [] as string[])).filter((t) => !boxesBefore.has(t))
    const fresh = (await page.evaluate(visibleTexts).catch(() => [] as string[])).filter((t) => !before.has(t) && t.length > 2)
    const text = boxes[0] ?? (fresh.length && fresh.length <= 6 ? fresh.join(' · ').slice(0, 240) : '')
    if (text) return { x: s.x, y: s.y, tooltip: text }
    const own = await page.evaluate(titleAt, s.x, s.y).catch(() => '')
    if (own) return { x: s.x, y: s.y, tooltip: own }
    if (still) {
      const now = await pictureOf(page, chart.rect)
      if (now && changedPixels(still, now, [{ x: s.x - chart.rect.x, y: s.y - chart.rect.y }, { x: prev.x - chart.rect.x, y: prev.y - chart.rect.y }]) > 120) {
        // the chart reacted to the pointer: a tooltip that waits for the pointer to rest (hover intent) shows a moment later
        await sleep(700)
        const late = (await page.evaluate(tooltipBoxes).catch(() => [] as string[])).filter((t) => !boxesBefore.has(t))
        if (late[0]) return { x: s.x, y: s.y, tooltip: late[0] }
        drawnAt ??= { x: s.x, y: s.y, drawn: true }
      }
    }
    prev = s
  }
  return drawnAt
}

// ---------------------------------------------------------------- the whole job

export interface MarkQuery {
  spec: FindSpec
  /** the colour to look for now (one of spec.colours) */
  colour?: string
  hover: boolean
  /** places already used (the next colour or mark must be somewhere else) */
  avoid?: Array<{ x: number; y: number }>
  move?: (x: number, y: number) => Promise<void>
  /** on a touch screen a tooltip often shows on a tap, not on a hover: when a hover shows none, the mark may be tapped (allowed by the person's rules) */
  allowTap?: boolean
}

export interface MarkHit {
  x: number
  y: number
  colour?: string
  tooltip?: string
  drawn?: boolean
  /** the tooltip showed when the mark was tapped (a phone), not when the pointer rested on it */
  tapped?: boolean
  chart: ChartBox
}

/** the place on a chart to put the pointer: a mark of the colour asked for; for a hover, one that shows a tooltip */
export async function findMark(page: Page, q: MarkQuery): Promise<{ hit?: MarkHit; why?: string }> {
  const chart = await pickChart(page, q.spec.chart ?? '')
  if (!chart) return { why: 'there is no chart on the screen' }
  const pic = await pictureOf(page, chart.rect)
  if (!pic) return { why: 'the chart could not be looked at' }
  const want = q.colour && isColour(q.colour) ? q.colour : null
  const thin = /line|curve|path|trace|series/.test(q.spec.noun ?? '')
  let spots = colourSpots(pic, want, { thin, max: 14 }).map((p) => snapToColour(pic, p))
  if (thin && spots.length) {
    // the broad bands of a chart are lines too, to the person: they follow the thin ones, so a hover tries both
    const broad = colourSpots(pic, want, { thin: false, max: 14 }).map((p) => snapToColour(pic, p)).filter((b) => !spots.some((t) => Math.hypot(t.x - b.x, t.y - b.y) < 24))
    spots = spots.flatMap((t, i) => (broad[i] ? [t, broad[i]] : [t])).concat(broad.slice(spots.length))
  }
  // the colour is not drawn (the chart shows others): any mark will do, said afterwards
  const exact = spots.length > 0
  if (!spots.length && want) spots = colourSpots(pic, null, { thin, max: 14 }).map((p) => snapToColour(pic, p))
  if (!spots.length) return { why: want ? `no ${want} marks could be seen on the chart${chart.title ? ` "${chart.title}"` : ''}` : `no marks could be seen on the chart${chart.title ? ` "${chart.title}"` : ''}` }
  const abs = spots.map((p) => ({ ...p, x: chart.rect.x + p.x, y: chart.rect.y + p.y })).filter((p) => !(q.avoid ?? []).some((a) => Math.hypot(a.x - p.x, a.y - p.y) < 30))
  if (!abs.length) return { why: 'every mark of that colour was already shown' }
  if (q.hover) {
    const probed = await probeTooltips(page, chart, abs, { move: q.move })
    if (!probed?.tooltip && q.allowTap && (await page.evaluate(() => navigator.maxTouchPoints > 0 || 'ontouchstart' in window).catch(() => false))) {
      const had = new Set(await page.evaluate(tooltipBoxes).catch(() => [] as string[]))
      for (const at of [...(probed ? [probed] : []), ...abs].slice(0, 9)) {
        await (q.move ? q.move(at.x, at.y) : page.mouse.move(at.x, at.y, { steps: 4 }))
        await page.mouse.click(at.x, at.y)
        await sleep(650)
        const tip = (await page.evaluate(tooltipBoxes).catch(() => [] as string[])).find((t) => !had.has(t))
        if (tip) return { hit: { x: at.x, y: at.y, colour: want ?? undefined, tooltip: tip, tapped: true, chart } }
      }
    }
    if (probed) return { hit: { x: probed.x, y: probed.y, colour: want ?? undefined, tooltip: probed.tooltip, drawn: probed.drawn, chart } }
    // nothing answered: the pointer still goes to the best mark
    return { hit: { x: abs[0].x, y: abs[0].y, colour: want ?? undefined, chart } }
  }
  const pick = abs[0]
  return { hit: { x: pick.x, y: pick.y, colour: exact ? (pick.colour as string) : (want ?? undefined), chart } }
}

// ---------------------------------------------------------------- what showed up

/** the short texts on screen now, to tell later what appeared */
export async function snapshotTexts(page: Page): Promise<Set<string>> {
  return new Set(await page.evaluate(visibleTexts).catch(() => [] as string[]))
}

/** texts that were not there in the snapshot (a tooltip, a detail panel, a changed readout) */
export async function newTexts(page: Page, before: Set<string>, max = 8): Promise<string[]> {
  const now = await page.evaluate(visibleTexts).catch(() => [] as string[])
  return now.filter((t) => !before.has(t) && t.length > 2).slice(0, max)
}

/** puts the pointer on a place and says what the page shows for it ('' when nothing appears) */
export async function hoverText(page: Page, x: number, y: number, o: { move?: (x: number, y: number) => Promise<void>; dwellMs?: number } = {}): Promise<string> {
  const before = await snapshotTexts(page)
  const boxesBefore = new Set(await page.evaluate(tooltipBoxes).catch(() => [] as string[]))
  await (o.move ? o.move(x, y) : page.mouse.move(x, y, { steps: 4 }))
  await sleep(o.dwellMs ?? 320)
  const boxes = (await page.evaluate(tooltipBoxes).catch(() => [] as string[])).filter((t) => !boxesBefore.has(t))
  if (boxes[0]) return boxes[0]
  const fresh = await newTexts(page, before, 6)
  if (fresh.length && fresh.length <= 6) return fresh.join(' · ').slice(0, 240)
  return page.evaluate(titleAt, x, y).catch(() => '')
}
