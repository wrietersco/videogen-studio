/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { Page } from 'puppeteer-core'
import type { Rect } from '@shared/appRecon'
import { deepRect, deepHandle, deepEval } from './deep'

/**
 * Pop-ups, modals and cookie banners that cover what a step wants to press.
 *
 * Before an action the element at the target's centre is checked; when a dialog, a fixed overlay or a consent banner
 * sits on top it is closed first, the way a person would: the most privacy-preserving choice ("Only necessary",
 * "No thanks", ×), then Escape, then a click outside it. What was closed is returned so the run can say so. A step's own
 * overlay is never closed: when the target is inside it, or the overlay holds a password box, it is left alone.
 */

export type OverlayKind = 'cookie' | 'popup' | 'modal' | 'banner'

/** the person's standing rules ("whenever a pop-up appears, close it"), run-wide */
export interface OverlayPolicy {
  /** pop-ups, modals, surveys, promos */
  popup: 'close' | 'leave'
  /** cookie / consent banners: the privacy-preserving choice by default; 'accept' only when the person said so */
  cookie: 'accept-essential' | 'accept' | 'leave'
  /** other things the person named ("chat widget"): text found in the overlay, and what to do with it */
  extra?: Array<{ match: string; action: 'close' | 'accept' | 'leave' }>
}

export const DEFAULT_POLICY: OverlayPolicy = { popup: 'close', cookie: 'accept-essential' }

export interface Whenever {
  condition: string
  action: string
}

/** the run-wide `whenever` atoms of the brief, as a policy (anything not named keeps the default) */
export function policyFromWhenever(list: Whenever[] | undefined | null): OverlayPolicy {
  const p: OverlayPolicy = { ...DEFAULT_POLICY, extra: [] }
  for (const w of list ?? []) {
    const c = (w.condition ?? '').toLowerCase()
    const a = (w.action ?? '').toLowerCase()
    const action = /accept-essential|reject|decline|essential|necessary/.test(a) ? 'accept-essential' : /accept|agree|allow/.test(a) ? 'accept' : /leave|ignore|keep|none/.test(a) ? 'leave' : 'close'
    if (/cookie|consent|gdpr|privacy/.test(c)) p.cookie = action === 'close' ? 'accept-essential' : (action as OverlayPolicy['cookie'])
    else if (/pop-?up|modal|dialog|banner|promo|survey|newsletter|offer|notification|overlay|window/.test(c)) p.popup = action === 'leave' ? 'leave' : 'close'
    else if (c.trim()) p.extra!.push({ match: c.trim(), action: action === 'accept-essential' ? 'close' : (action as 'close' | 'accept' | 'leave') })
  }
  return p
}

// ---------------------------------------------------------------- what a control on an overlay means

export type ControlRole = 'reject' | 'close' | 'ack' | 'accept' | 'other'

const REJECT = /^(?:(?:only|use|accept only|allow only|save|continue with)\s+)?(?:strictly\s+)?(?:necessary|essential|required)(?:\s+(?:cookies|only))?$|reject|decline|deny|refuse|opt[ -]?out|do not (?:accept|consent|sell)|disagree|necessary only|essential only|continue without (?:accepting|agreeing)|no,? thanks?|no thank you|i'?ll pass|not interested/i
const CLOSE = /^(?:[×✕✖✗╳xX]|close(?: (?:this|dialog|popup|pop-up|window|banner|message|notice))?|dismiss(?: (?:this|banner|message|notice))?|hide|skip(?: for now)?|not now|maybe later|remind me later|later|no|cancel|exit|continue without .{1,30})$/i
const ACK = /^(?:got it|ok|okay|understood|i understand|done|alright|sounds good|dismiss all|continue|continue browsing)$/i
const ACCEPT = /^(?:accept|allow|agree|i agree|yes,? i agree|consent|enable|accept all|allow all|agree and (?:close|continue)|accept (?:all )?(?:cookies|and close))/i
/** things that must never be pressed to get rid of a pop-up */
const NEVER = /subscribe|sign ?up|join|claim|buy|purchase|checkout|download|install|get (?:\d|my|the|your)|apply|redeem|upgrade|delete|remove|confirm|submit|send|pay|yes,? (?:please|sign|send)/i

export function controlRole(label: string, aria = ''): ControlRole {
  const l = (label ?? '').replace(/\s+/g, ' ').trim()
  const a = (aria ?? '').replace(/\s+/g, ' ').trim()
  if (!l && !a) return 'other'
  if (l && NEVER.test(l)) return 'other'
  if (l && REJECT.test(l)) return 'reject'
  if (l && CLOSE.test(l)) return 'close'
  if (l && ACK.test(l)) return 'ack'
  if (l && ACCEPT.test(l)) return 'accept'
  // an icon button names itself by its aria-label or title
  if (!l || l.length <= 2) {
    if (/\b(close|dismiss|hide)\b/i.test(a)) return 'close'
  }
  return 'other'
}

/** which of the controls to press, in order, for this kind of overlay under this policy (indices into the list) */
export function pressOrder(kind: OverlayKind, roles: ControlRole[], policy: OverlayPolicy, extraAction?: 'close' | 'accept'): number[] {
  const rank = (order: ControlRole[]) => order.flatMap((r) => roles.flatMap((x, i) => (x === r ? [i] : [])))
  if (kind === 'cookie') {
    if (policy.cookie === 'leave') return []
    if (policy.cookie === 'accept') return rank(['accept', 'ack', 'close', 'reject'])
    return rank(['reject', 'close', 'ack'])
  }
  if (extraAction === 'accept') return rank(['accept', 'ack', 'close', 'reject'])
  return rank(['close', 'reject', 'ack'])
}

// ---------------------------------------------------------------- reading the page

export interface OverlayControl {
  label: string
  aria: string
  selector: string
  rect: Rect
  role: ControlRole
}

export interface OverlayInfo {
  selector: string
  rect: Rect
  text: string
  kind: OverlayKind
  /** covers a good part of the screen, or dims it: a person cannot reach what is behind it */
  blocking: boolean
  hasPassword: boolean
  hasFields: boolean
  controls: OverlayControl[]
  /** the point asked about lies under it (and the target is not part of it) */
  coversPoint: boolean
  /** the target (a selector) is inside this overlay */
  holdsTarget: boolean
  /** a custom word of the person's rules matched it */
  extra?: 'close' | 'accept' | 'leave'
}

/** in the page: every overlay that is showing, with the controls it offers */
function scanOverlays(point: { x: number; y: number } | null, extraWords: Array<{ match: string; action: string }>): Array<Omit<OverlayInfo, 'controls'> & { controls: Array<Omit<OverlayControl, 'role' | 'selector'> & { path: string }>; path: string }> {
  const vw = innerWidth
  const vh = innerHeight
  const DEEPS = ' >>> '
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
    return hops.join(DEEPS)
  }
  const all: Element[] = []
  const collect = (root: Document | ShadowRoot | Element) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      all.push(el)
      const sr = (el as HTMLElement).shadowRoot
      if (sr) collect(sr)
    }
  }
  collect(document)
  const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim()
  const classes = (el: Element) => (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : el.getAttribute('class') ?? '')
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
  }
  const NAVLIKE = /\b(nav|navbar|navigation|header|topbar|toolbar|sidebar|menu|footer|breadcrumb|tabbar|appbar)\b/i
  const OVERLAYISH = /modal|pop-?up|overlay|dialog|lightbox|cookie|consent|gdpr|newsletter|subscribe|promo|survey|feedback|offer|welcome|announcement|what-?s-?new|interstitial|toast|snackbar|banner|notice|backdrop/i
  const cands: Array<{ el: Element; score: number; cookie: boolean }> = []
  for (const el of all) {
    if (/^(HTML|BODY|HEAD|SCRIPT|STYLE|META|LINK|TITLE|NOSCRIPT|SVG|PATH|G)$/i.test(el.tagName)) continue
    if ((el as HTMLElement).id === '__vg_cursor' || el.hasAttribute('data-vg-ui') || el.closest('#__vg_cursor,[data-vg-ui]')) continue
    const cs = getComputedStyle(el)
    const role = el.getAttribute('role') ?? ''
    const isDialog = el.tagName === 'DIALOG' ? (el as HTMLDialogElement).open : /^(dialog|alertdialog)$/.test(role) || el.getAttribute('aria-modal') === 'true'
    const z = parseInt(cs.zIndex, 10)
    const floating = cs.position === 'fixed' || cs.position === 'sticky' || (cs.position === 'absolute' && z >= 20)
    if (!isDialog && !floating) continue
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 80 || r.height < 28) continue
    const area = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0))
    if (area <= 0) continue
    const text = textOf(el)
    const idc = `${el.id} ${classes(el)} ${role} ${el.getAttribute('aria-label') ?? ''}`
    let score = 0
    if (isDialog) score += 3
    if (OVERLAYISH.test(idc)) score += 2
    if (NAVLIKE.test(idc) || /^(NAV|HEADER|FOOTER|ASIDE)$/.test(el.tagName) || /^(navigation|toolbar|menu|menubar|tablist)$/.test(role)) score -= 4
    const cookie = /cookie|consent|gdpr|privacy (?:preferences|settings|policy)|we use (?:cookies|analytics)/i.test(text + ' ' + idc)
    if (cookie) score += 2
    if (area > vw * vh * 0.25 && cs.position === 'fixed') score += 1
    const bg = cs.backgroundColor.match(/rgba?\(([^)]+)\)/)
    const alpha = bg ? (bg[1].split(',').length > 3 ? parseFloat(bg[1].split(',')[3]) : 1) : 0
    if (area > vw * vh * 0.7 && alpha > 0.15 && alpha < 0.98) score += 2 // a dimming layer
    const links = el.querySelectorAll('a[href]').length
    if (links > 6) score -= 2
    // a bar stuck to an edge with a short message and a button: a banner
    if (!isDialog && (r.top <= 2 || r.bottom >= vh - 2) && r.width > vw * 0.6 && text.length > 20 && text.length < 500 && el.querySelector('button,[role=button],a')) score += 1
    if (el.querySelector('button,[role=button],a,[class*=close i],[aria-label*=close i]') && text.length) score += 1
    if (score >= 3 && text) cands.push({ el, score, cookie })
  }
  // an overlay that holds another one is one overlay: the outer one
  const keep = cands.filter((c) => !cands.some((o) => o !== c && o.el !== c.el && o.el.contains(c.el)))
  const out: ReturnType<typeof scanOverlays> = []
  for (const c of keep) {
    const el = c.el
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const text = textOf(el).slice(0, 400)
    const area = (Math.min(r.right, vw) - Math.max(r.left, 0)) * (Math.min(r.bottom, vh) - Math.max(r.top, 0))
    const isDialog = el.tagName === 'DIALOG' || /^(dialog|alertdialog)$/.test(el.getAttribute('role') ?? '') || el.getAttribute('aria-modal') === 'true'
    const cookie = c.cookie
    const blocking = area > vw * vh * 0.22 || isDialog || (cs.position === 'fixed' && area > vw * vh * 0.1 && !cookie) || cookie
    const kind: OverlayKind = cookie ? 'cookie' : isDialog || area > vw * vh * 0.22 ? 'modal' : (r.top <= 2 || r.bottom >= vh - 2) && r.width > vw * 0.6 ? 'banner' : 'popup'
    // the controls it offers
    const controls: Array<{ label: string; aria: string; path: string; rect: Rect }> = []
    const pool: Element[] = []
    const walk = (root: Element | ShadowRoot) => {
      for (const n of Array.from(root.querySelectorAll('*'))) {
        pool.push(n)
        const sr = (n as HTMLElement).shadowRoot
        if (sr) walk(sr)
      }
    }
    walk(el)
    for (const n of pool) {
      const tag = n.tagName
      const isCtl = /^(BUTTON|A|SUMMARY)$/.test(tag) || /^(button|link|menuitem)$/.test(n.getAttribute('role') ?? '') || (tag === 'INPUT' && /^(button|submit)$/i.test((n as HTMLInputElement).type)) || (getComputedStyle(n).cursor === 'pointer' && n.children.length === 0 && textOf(n).length <= 24) || /close|dismiss/i.test(classes(n)) && textOf(n).length <= 3
      if (!isCtl || !visible(n)) continue
      const nr = n.getBoundingClientRect()
      let label = textOf(n) || (n as HTMLInputElement).value || ''
      if (!label) label = n.querySelector('svg title')?.textContent ?? ''
      const aria = [n.getAttribute('aria-label'), n.getAttribute('title'), n.getAttribute('data-dismiss'), /close|dismiss/i.test(classes(n)) ? 'close' : ''].filter(Boolean).join(' ')
      controls.push({ label: label.slice(0, 60), aria: aria.slice(0, 60), path: pathOf(n), rect: { x: nr.x, y: nr.y, w: nr.width, h: nr.height } })
      if (controls.length >= 14) break
    }
    const extraHit = extraWords.find((w) => w.match && (text + ' ' + el.id + ' ' + classes(el)).toLowerCase().includes(w.match.toLowerCase()))
    out.push({
      path: pathOf(el),
      selector: '',
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      text,
      kind,
      blocking,
      hasPassword: !!el.querySelector('input[type=password]'),
      hasFields: !!el.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,select'),
      controls: controls.map((k) => ({ label: k.label, aria: k.aria, rect: k.rect, path: k.path })),
      coversPoint: !!point && point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom,
      holdsTarget: false,
      ...(extraHit ? { extra: extraHit.action as 'close' | 'accept' | 'leave' } : {})
    })
  }
  return out
}

export async function readOverlays(page: Page, o: { point?: { x: number; y: number }; target?: string; policy?: OverlayPolicy } = {}): Promise<OverlayInfo[]> {
  const raw = await page.evaluate(scanOverlays, o.point ?? null, (o.policy?.extra ?? []) as never).catch(() => [])
  const list = raw.map((r) => {
    const { path, controls, ...rest } = r as unknown as { path: string; controls: Array<{ label: string; aria: string; path: string; rect: Rect }> } & OverlayInfo
    return { ...rest, selector: path, controls: controls.map((k) => ({ label: k.label, aria: k.aria, rect: k.rect, selector: k.path, role: controlRole(k.label, k.aria) })) } as OverlayInfo
  })
  // an overlay that holds the target (even across a shadow root) is the step's own place, not something in its way
  if (o.target) {
    const t = await deepHandle(page, o.target)
    if (t) {
      for (const ov of list) {
        const oh = await deepHandle(page, ov.selector)
        if (!oh) continue
        ov.holdsTarget = await oh.evaluate((a, b) => { for (let n: Node | null = b as Node; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === a) return true; return false }, t).catch(() => false)
        await oh.dispose().catch(() => undefined)
      }
      await t.dispose().catch(() => undefined)
    }
  }
  return list
}

// ---------------------------------------------------------------- closing

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export interface ClearOptions {
  policy?: OverlayPolicy
  /** the control that is about to be used (a deep address): an overlay that holds it is not closed; its centre is the point looked at */
  target?: string
  /** words the step itself names ("Accept cookies"): an overlay control with that name is the step's own business */
  stepWords?: string
  /** a gate that can refuse a click (the person's own rules) */
  allow?: (label: string) => boolean
  log?: (m: string) => void
  /** moves the pointer the way the film shows it */
  move?: (x: number, y: number) => Promise<void>
  /** only look for overlays that block (no target): called after a step and at load */
  sweep?: boolean
  pace?: number
}

export interface ClearResult {
  /** what was closed, in words ("closed the cookie banner by pressing "Only necessary"") */
  closed: string[]
  /** an overlay that is still in the way */
  stuck?: string
}

const describeKind = (k: OverlayKind) => (k === 'cookie' ? 'cookie banner' : k === 'modal' ? 'dialog' : k === 'banner' ? 'banner' : 'pop-up')

async function gone(page: Page, ov: OverlayInfo): Promise<boolean> {
  const r = await deepRect(page, ov.selector)
  if (!r || r.w < 4 || r.h < 4) return true
  const hidden = await deepEval(page, ov.selector, (el) => {
    const cs = getComputedStyle(el)
    return cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05
  })
  return hidden === true || hidden === null
}

/** closes one overlay; true when it is gone */
async function closeOne(page: Page, ov: OverlayInfo, o: ClearOptions, policy: OverlayPolicy): Promise<{ done: boolean; how: string }> {
  const roles = ov.controls.map((c) => c.role)
  const order = pressOrder(ov.kind, roles, policy, ov.extra === 'accept' ? 'accept' : undefined).filter((i) => {
    const c = ov.controls[i]
    if (o.allow && !o.allow(c.label || c.aria)) return false
    // a control the step itself is about is not the overlay's to press away
    return !(o.stepWords && c.label && o.stepWords.toLowerCase().includes(c.label.toLowerCase()) && c.label.length > 2)
  })
  const pause = (ms: number) => nap(ms * (o.pace ?? 1))
  for (const i of order.slice(0, 2)) {
    const c = ov.controls[i]
    const rect = (await deepRect(page, c.selector)) ?? c.rect
    const x = rect.x + rect.w / 2
    const y = rect.y + rect.h / 2
    if (o.move) await o.move(x, y)
    else await page.mouse.move(x, y, { steps: 5 })
    await pause(250)
    await page.mouse.click(x, y)
    await pause(450)
    for (let k = 0; k < 6; k++) {
      if (await gone(page, ov)) return { done: true, how: `by pressing "${c.label || c.aria}"` }
      await nap(150)
    }
  }
  // no control worked or there was none: the keyboard
  await page.keyboard.press('Escape').catch(() => undefined)
  await pause(350)
  if (await gone(page, ov)) return { done: true, how: 'with the Escape key' }
  // a modal closes when its backdrop is pressed
  if (ov.kind === 'modal' && ov.blocking) {
    const vp = page.viewport() ?? { width: 1280, height: 720 }
    const spots = [
      { x: 6, y: 6 },
      { x: vp.width - 6, y: 6 },
      { x: 6, y: vp.height - 6 }
    ].filter((p) => !(p.x >= ov.rect.x && p.x <= ov.rect.x + ov.rect.w && p.y >= ov.rect.y && p.y <= ov.rect.y + ov.rect.h))
    if (spots.length && ov.rect.w < vp.width * 0.95) {
      await page.mouse.click(spots[0].x, spots[0].y)
      await pause(400)
      if (await gone(page, ov)) return { done: true, how: 'by pressing outside it' }
    }
  }
  return { done: false, how: '' }
}

/**
 * Clears the way: closes the overlays that sit on top of the target (or, in a sweep, the ones that block the page).
 * Returns what was closed. Never closes an overlay the target lives in, one with a password box, or one the policy leaves.
 */
export async function clearOverlays(page: Page, o: ClearOptions = {}): Promise<ClearResult> {
  const policy = o.policy ?? DEFAULT_POLICY
  const closed: string[] = []
  let stuck: string | undefined
  const tried = new Set<string>()
  for (let round = 0; round < 4; round++) {
    let point: { x: number; y: number } | undefined
    if (o.target) {
      const r = await deepRect(page, o.target)
      if (r) point = { x: r.x + r.w / 2, y: r.y + r.h / 2 }
    }
    const list = await readOverlays(page, { point, target: o.target, policy })
    const todo = list.filter((ov) => {
      if (tried.has(ov.selector + '|' + ov.text.slice(0, 30))) return false
      if (ov.holdsTarget || ov.hasPassword) return false
      // the step is about this very overlay ("Accept all cookies", "No thanks"): it is the step's to deal with
      if (o.stepWords && ov.controls.some((c) => c.label.trim().length > 2 && (o.stepWords!.toLowerCase().includes(c.label.trim().toLowerCase()) || (o.stepWords!.length > 4 && c.label.toLowerCase().includes(o.stepWords!.toLowerCase()))))) return false
      if (ov.extra === 'leave') return false
      if (ov.kind === 'cookie' && policy.cookie === 'leave') return false
      if (ov.kind !== 'cookie' && !ov.extra && policy.popup === 'leave') return false
      if (o.sweep) return ov.blocking || ov.kind === 'cookie'
      // in the way of the target, or an overlay that dims the whole page
      return ov.coversPoint || (ov.blocking && ov.kind !== 'banner')
    })
    if (!todo.length) break
    // the biggest first: a dimmer holds the dialog on it
    todo.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)
    const ov = todo[0]
    tried.add(ov.selector + '|' + ov.text.slice(0, 30))
    // a form the person is meant to fill is not a pop-up to dismiss (it holds the field the step names)
    if (ov.hasFields && !ov.controls.some((c) => c.role === 'close' || c.role === 'reject')) continue
    const res = await closeOne(page, ov, o, policy)
    const what = `the ${describeKind(ov.kind)}${ov.text ? ` ("${ov.text.slice(0, 50).replace(/\s+\S*$/, '')}…")` : ''}`
    if (res.done) {
      closed.push(`closed ${what} ${res.how}`)
      o.log?.(`    closed ${what} ${res.how}`)
    } else {
      stuck = `${what} could not be closed`
      o.log?.(`    ${stuck}`)
    }
  }
  return { closed, ...(stuck ? { stuck } : {}) }
}

/** a page-wide check at load and after each step: closes what blocks the page (a banner, a dimming pop-up) */
export async function sweepOverlays(page: Page, o: Omit<ClearOptions, 'sweep'> = {}): Promise<ClearResult> {
  return clearOverlays(page, { ...o, sweep: true })
}

