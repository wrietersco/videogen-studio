/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import { mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CDPSession, Page } from 'puppeteer-core'
import { FILM, type Playbook, type Rect, type Step, type Take, type TimelineBeat } from '@shared/appRecon'
import type { PolicyGate } from './policy'
import { checkSecretFill } from './detect'
import { classifyField } from './sensitivity'
import { asPhone } from './browser'
import { redactionInitScript, cursorInitScript, verifyScript, type RedactionConfig } from './redact'
import { probeInitScript } from './probes'
import { findElement, scrollArea } from './resolve'
import { findMark, findSvgMark, pickChart } from './marks'
import { scrollToSection } from './sections'
import { chooseNative, matchOption, readChoices } from './pick'
import { deepEval, deepRect } from './deep'
import { sweepOverlays } from './overlays'
import { armWhenever, clickMarkChecked, doClick, doHover, doType, focusedEditable, policyOf, type Env, type Outcome } from './actions'
import { doDate, doDrag, doKey, doScrollUntil, doSlider } from './gestures'
import { dropZone } from './atomExec'
import { pickByStructure, type PickSpec } from './pageModel'
import { judgeLogin, type LoginVerdict } from './loginCheck'
import { isInterstitial } from './explore'

/**
 * Recorder — a screencast of the page, plus a timeline of what was done when.
 *
 * Frames are taken straight from the browser (not a screen grab), so nothing
 * else on the computer can appear in them. The timeline is what lets the video
 * stage zoom to the right place at the right moment and line the narration up
 * with the action.
 */

const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Let the viewer see the result of what was just done. A filter, a graph or a
 * search draws for a moment, so this waits until the page stops changing (at
 * most 6 seconds); then, when the page itself runs past the screen, it scrolls
 * down through the result and back up. It scrolls the page, never the mouse
 * wheel, so a graph that zooms on the wheel is left exactly as it is.
 */
export async function inspectView(page: Page, pace: number): Promise<void> {
  if (pace === 0) {
    await nap(250)
    return
  }
  let last = ''
  let still = 0
  const until = Date.now() + 6000
  while (Date.now() < until && still < 3) {
    await nap(300)
    const now = await page.evaluate(() => `${document.body?.innerText.length ?? 0}|${document.querySelectorAll('*').length}|${document.querySelectorAll('svg *').length}`).catch(() => '')
    if (now === last) still++
    else {
      still = 0
      last = now
    }
  }
  // a step that took the viewer to a part of the page (a scroll, a chart, a panel) is left exactly there: the tour below is only for
  // a result drawn at the top of the page, and it never ends by sending the page back to the top
  const y0 = await page.evaluate(() => scrollY).catch(() => 0)
  const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight).catch(() => 0)
  if (room > 120 && y0 < 40) {
    const stops = Math.min(4, Math.ceil(room / 300))
    for (let i = 1; i <= stops; i++) {
      await page.evaluate((y) => scrollTo({ top: y, behavior: 'smooth' }), (room * i) / stops).catch(() => undefined)
      await nap(900)
    }
    await nap(600)
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'smooth' })).catch(() => undefined)
    await nap(700)
  } else await nap(900)
}

export class FrameRecorder {
  private client: CDPSession | null = null
  private frames: Array<{ n: number; ts: number }> = []
  private writes: Promise<void>[] = []
  private n = 0
  private t0 = 0
  private endTs = 0

  constructor(private readonly page: Page, readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  /** seconds since recording began */
  now(): number {
    return Date.now() / 1000 - this.t0
  }

  private stills: Promise<void> | null = null
  private rolling = false

  /**
   * Starts recording. Chrome's screencast only ever sends pictures at the page's
   * CSS size, which for a phone (390 px wide) is far too small for a 1080 px
   * film; `sharp` takes full-density screenshots back to back instead (about as
   * smooth, a little slower to record).
   */
  async start(width: number, height: number, o: { sharp?: boolean } = {}): Promise<void> {
    this.client = await this.page.createCDPSession()
    this.t0 = Date.now() / 1000
    if (o.sharp) {
      const client = this.client
      const vp = this.page.viewport() ?? { width, height }
      // the clip's scale is what makes the picture full size (the page's own pixel density is not applied to it)
      const clip = { x: 0, y: 0, width: vp.width, height: vp.height, scale: width / vp.width }
      this.rolling = true
      // three pictures in flight at once keep the frame rate up while each one is being encoded
      const worker = async () => {
        while (this.rolling) {
          const ts = Date.now() / 1000
          // the clip is in page coordinates, not screen ones: once the page has been scrolled a clip at 0,0 is blank white, so it follows the view
          const at = await client.send('Page.getLayoutMetrics').then((m) => ({ x: m.cssVisualViewport?.pageX ?? 0, y: m.cssVisualViewport?.pageY ?? 0 })).catch(() => ({ x: 0, y: 0 }))
          const shot = await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 90, optimizeForSpeed: true, clip: { ...clip, x: at.x, y: at.y } }).catch(() => null)
          if (!shot) {
            await nap(30)
            continue
          }
          const n = ++this.n
          this.frames.push({ n, ts })
          this.writes.push(writeFile(join(this.dir, `f${String(n).padStart(6, '0')}.jpg`), Buffer.from(shot.data, 'base64')))
        }
      }
      this.stills = Promise.all([worker(), worker(), worker()]).then(() => {
        this.frames.sort((p, q) => p.ts - q.ts)
      })
      return
    }
    this.client.on('Page.screencastFrame', (f) => {
      const n = ++this.n
      this.frames.push({ n, ts: f.metadata.timestamp ?? Date.now() / 1000 })
      this.writes.push(writeFile(join(this.dir, `f${String(n).padStart(6, '0')}.jpg`), Buffer.from(f.data, 'base64')))
      void this.client?.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
    })
    await this.client.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: width, maxHeight: height, everyNthFrame: 1 })
  }

  /** stops, and writes the frame list ffmpeg needs (each picture is shown until the next arrives) */
  async stop(): Promise<{ listFile: string; durationSec: number; frameCount: number }> {
    this.endTs = Date.now() / 1000
    this.rolling = false
    await this.stills
    await this.client?.send('Page.stopScreencast').catch(() => undefined)
    await Promise.all(this.writes)
    const frames = this.frames
    if (frames.length === 0) throw new Error('The browser produced no frames')
    const lines: string[] = []
    for (let i = 0; i < frames.length; i++) {
      const next = i + 1 < frames.length ? frames[i + 1].ts : this.endTs
      const dur = Math.max(0.001, next - frames[i].ts)
      lines.push(`file 'f${String(frames[i].n).padStart(6, '0')}.jpg'`, `duration ${dur.toFixed(4)}`)
    }
    lines.push(`file 'f${String(frames.at(-1)!.n).padStart(6, '0')}.jpg'`) // concat demuxer quirk: last file listed twice
    const listFile = join(this.dir, 'frames.txt')
    writeFileSync(listFile, lines.join('\n'))
    // seconds the first picture is shown before recording nominally began → trim by the caller
    return { listFile, durationSec: this.endTs - frames[0].ts, frameCount: frames.length }
  }

  /** where recording-time 0 sits relative to the first frame, so beats line up with the video */
  offsetSec(): number {
    return this.frames.length ? this.frames[0].ts - this.t0 : 0
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)

export interface RunOptions {
  /** {{secret:name}} values — filled in here, never sent to a model */
  vault: Record<string, string>
  gate: PolicyGate
  redaction: RedactionConfig
  /** pause for a person (a one-time code, a CAPTCHA) */
  onHandoff?: (step: Step) => Promise<void>
  /** per beat: how long the beat must last at least (the narration for it) */
  beatMinSec?: Map<number, number>
  recorder?: FrameRecorder
  /** pace of the human-like motion; 0 = as fast as possible (rehearsal) */
  pace?: number
  log?: (msg: string) => void
  /** a step whose target moved is pointed at the same-named control; one that is gone is dropped (a rehearsal of saved steps) */
  repair?: boolean
  /** called after each beat (the rehearsal looks at the page the beat ended on) */
  afterBeat?: (beat: number) => Promise<void>
}

export interface RunResult {
  ok: boolean
  failure?: string
  beats: TimelineBeat[]
  navigations: Take['navigations']
  log: Take['log']
  redactionMisses: number
  /** with repair on: the steps as they should be recorded, and what was changed */
  playbook?: Playbook
  repairs?: string[]
  /** steps that could not be done on the page and were left out (the film goes on without them) */
  skipped?: Array<{ step: string; label: string; why: string }>
  /** runs of beats that were filmed on the very same screen, though steps were done in them (the voice would describe screens the film never shows) */
  stuck?: Array<{ from: number; to: number }>
  /** pop-ups and banners that were closed on the way ("s4: closed the cookie banner by pressing "Only necessary"") */
  closed?: string[]
  /** steps that were done but the page did not show any effect (never to be narrated as having worked) */
  unverified?: Array<{ step: string; label: string; why: string }>
}

/** the control a saved step meant, found again by its name when its address in the page changed; null unless exactly one fits */
async function findByLabel(page: Page, step: Step): Promise<string | null> {
  const label = (step.label ?? '').trim()
  if (!label) return null
  return page.evaluate(
    (want, isType) => {
      const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()
      const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
      const path = (el: Element): string => {
        if (el.id) return '#' + CSS.escape(el.id)
        const name = el.getAttribute('name')
        if (name && document.querySelectorAll(el.tagName.toLowerCase() + '[name="' + name + '"]').length === 1) return el.tagName.toLowerCase() + '[name="' + name + '"]'
        const parts: string[] = []
        for (let n: Element | null = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
          if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break }
          const same = Array.from(n.parentElement?.children ?? []).filter((c) => c.tagName === n!.tagName)
          parts.unshift(n.tagName.toLowerCase() + (same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : ''))
        }
        return parts.join(' > ')
      }
      const nameOf = (el: Element): string => {
        const i = el as HTMLInputElement
        const lab = i.labels && i.labels[0] ? i.labels[0].innerText : ''
        return norm(lab || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || (el as HTMLElement).innerText || i.value || el.getAttribute('title') || '')
      }
      const pool = Array.from(document.querySelectorAll(isType ? 'input,select,textarea' : 'button,input[type=submit],input[type=button],a[href],[role=button]')).filter(shown)
      const w = norm(want)
      const exact = pool.filter((el) => nameOf(el) === w)
      if (exact.length === 1) return path(exact[0])
      if (exact.length > 1) return null
      const part = pool.filter((el) => { const n = nameOf(el); return n && (n.includes(w) || w.includes(n)) })
      return part.length === 1 ? path(part[0]) : null
    },
    label,
    step.kind === 'type'
  ).catch(() => null)
}

/** installs the cursor and redaction on every page this tab will ever open */
export async function prepare(page: Page, redaction: RedactionConfig): Promise<void> {
  const phone = !!page.viewport()?.isMobile
  if (phone) await asPhone(page)
  await page.evaluateOnNewDocument(redactionInitScript(redaction))
  await page.evaluateOnNewDocument(probeInitScript())
  await page.evaluateOnNewDocument(cursorInitScript(phone))
}

export async function runPlaybook(page: Page, playbook: Playbook, o: RunOptions): Promise<RunResult> {
  const pace = o.pace ?? 1
  const t = () => (o.recorder ? o.recorder.now() : 0)
  const log: Take['log'] = []
  const beats: TimelineBeat[] = []
  // the page may already be open when recording starts: that address is where the film begins
  const navigations: Take['navigations'] = /^https?:/.test(page.url()) ? [{ t: 0, url: page.url() }] : []
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push({ t: t(), url: f.url() }) })
  let misses = 0
  const vp = page.viewport() ?? FILM
  let mouse = { x: vp.width / 2, y: vp.height / 2 }
  const say = (step: string, note: string) => {
    log.push({ t: t(), step, note })
    o.log?.(`  ${step}: ${note}`)
  }

  const resolve = (text: string) => text.replace(/\{\{secret:(\w+)\}\}/g, (_, k: string) => {
    const v = o.vault[k]
    if (v === undefined) throw new Error(`no secret named "${k}" in the vault`)
    return v
  })

  const rectOf = async (selector: string): Promise<Rect | null> => deepRect(page, selector, { scroll: true })

  const glide = async (x: number, y: number, ms: number) => {
    if (pace === 0) { await page.mouse.move(x, y); mouse = { x, y }; return }
    const steps = Math.max(8, Math.round((ms * pace) / 16))
    const { x: x0, y: y0 } = mouse
    // a slight arc, the way a hand moves
    const bow = Math.min(60, Math.hypot(x - x0, y - y0) * 0.12)
    for (let i = 1; i <= steps; i++) {
      const k = ease(i / steps)
      const px = x0 + (x - x0) * k + Math.sin(k * Math.PI) * bow * 0.4
      const py = y0 + (y - y0) * k - Math.sin(k * Math.PI) * bow
      await page.mouse.move(px, py)
      await sleep(16)
    }
    mouse = { x, y }
  }

  const verify = async (where: string) => {
    // every frame is checked, embedded ones included
    let total = 0
    const detail: string[] = []
    for (const frame of page.frames()) {
      try {
        const res = JSON.parse((await frame.evaluate(verifyScript(o.redaction))) as string) as { misses: number; detail: string[] }
        total += res.misses
        detail.push(...res.detail)
      } catch {
        /* a frame that is gone or not scriptable cannot be checked; it is not counted */
      }
    }
    if (total) {
      misses += total
      say(where, `REDACTION MISS ×${total}: ${detail.slice(0, 8).join(', ')}`)
    }
  }

  const waitFor = async (check: () => Promise<boolean>, ms = 6000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (await check().catch(() => false)) return true
      await sleep(120)
    }
    return false
  }

  let stepFromUrl = ''
  /** sign-in check: waits long, survives redirects and browser-check pages, fails only on a refusal message */
  const checkLogin = async (step: Step, sel: string): Promise<string | null> => {
    const until = Date.now() + 25000
    const urlBefore = stepFromUrl
    let last: LoginVerdict = 'waiting'
    let lastErr = ''
    let enterSent = false
    let clickSent = false
    while (Date.now() < until) {
      const sig = await page
        .evaluate((s) => {
          const vis = (el: Element) => !!(el as HTMLElement).offsetParent || getComputedStyle(el).position === 'fixed'
          const pw = document.querySelector(s)
          const errEl = Array.from(document.querySelectorAll('[role=alert],.error,.alert,.alert-danger,.flash,.invalid-feedback,.form-error,.text-danger,[class*=error i]')).find((el) => vis(el) && (el as HTMLElement).innerText.trim())
          const acct = Array.from(document.querySelectorAll('a,button')).some((el) => vis(el) && /^(log ?out|sign ?out|logout)$/i.test(((el as HTMLElement).innerText || '').trim()))
          return { passwordVisible: !!pw && vis(pw), errorText: errEl ? (errEl as HTMLElement).innerText.trim().slice(0, 200) : '', accountControl: acct }
        }, sel)
        .catch(() => null) // the page is navigating: look again
      if (sig) {
        const interstitial = await isInterstitial(page).catch(() => false)
        lastErr = sig.errorText || lastErr
        last = judgeLogin({ urlBefore, urlNow: page.url(), interstitial, ...sig })
        if (last === 'success') return null
        if (last === 'failed') return `the page said "${sig.errorText}"`
      }
      const waited = Date.now() - (until - 25000)
      if (!enterSent && waited > 5000 && last === 'waiting') {
        // still on the form and quiet: the click may have missed, so submit the way a person would, with Enter in the password field
        enterSent = true
        await page.focus(sel).catch(() => undefined)
        await page.keyboard.press('Enter').catch(() => undefined)
        say(step.id, 'the sign-in page did not move on, so Enter was pressed')
      } else if (!clickSent && waited > 12000 && last === 'waiting' && step.selector) {
        clickSent = true
        await page.$eval(step.selector, (el) => (el as HTMLElement).click()).catch(() => undefined)
        say(step.id, 'still on the sign-in page, so the button was pressed directly')
      }
      await sleep(250)
    }
    // no sign of success but no refusal message either: the film carries on rather than stopping on a doubtful check
    say(step.id, `WARNING: could not confirm the sign-in worked (still on ${page.url()}${lastErr ? `, page text: "${lastErr}"` : ''}); carrying on`)
    return null
  }

  const checkExpect = async (step: Step): Promise<string | null> => {
    const e = step.expect
    if (!e) return null
    if (e.selectorGone && step.intent === 'login-submit') return checkLogin(step, e.selectorGone)
    if (e.urlIncludes && !(await waitFor(async () => page.url().includes(e.urlIncludes!)))) return `expected the address to contain "${e.urlIncludes}" but it is ${page.url()}`
    if (e.textVisible && !(await waitFor(async () => (await page.evaluate(() => document.body.innerText)).toLowerCase().includes(e.textVisible!.toLowerCase())))) return `expected to see "${e.textVisible}"`
    if (e.selectorGone && !(await waitFor(async () => (await page.$(e.selectorGone!)) === null || !(await page.$eval(e.selectorGone!, (el) => (el as HTMLElement).offsetParent !== null).catch(() => false))))) return `"${e.selectorGone}" should have gone`
    if (e.selectorVisible && !(await waitFor(async () => (await page.$(e.selectorVisible!)) !== null))) return `expected "${e.selectorVisible}" to appear`
    return null
  }

  const repairs: string[] = []
  const skipped: NonNullable<RunResult['skipped']> = []
  const skipStep = (step: Step, why: string) => {
    skipped.push({ step: step.id, label: step.label ?? step.find?.target ?? step.selector ?? '', why })
    say(step.id, `SKIPPED: ${why}`)
  }
  const closedAll: string[] = []
  const unverified: NonNullable<RunResult['unverified']> = []
  let current = ''
  const env: Env = {
    page,
    allow: (label) => o.gate.checkClick({ label, kind: 'button' }).allow,
    log: (m) => say(current, m.trim()),
    move: (x, y, ms) => glide(x, y, ms ?? 600),
    pace
  }
  /** pop-ups and banners that sit over the page are closed before a step (the privacy-preserving choice), unless the step is about them */
  const sweep = async (step: Step): Promise<void> => {
    // (a pause or a look at the result after a click is no reason to clear the page: the dialog that click opened is the next step's to use)
    if (step.kind === 'goto' || step.kind === 'handoff' || step.kind === 'whenever' || step.kind === 'wait') return
    try {
      // where the step is going, so that an overlay it is about (a form it fills) is left alone
      // (a dialog that has only just opened fades in: its keys are looked for for a moment, so that the step's own dialog is not swept away)
      const where = step.find ? (await findElement(page, step.find, 1200).catch(() => ({ found: null }))).found?.selector : step.selector
      const r = await sweepOverlays(page, { target: where, policy: policyOf(page), allow: env.allow, log: (m) => say(step.id, m.trim()), move: (x, y) => glide(x, y, 450), stepWords: step.label ?? step.find?.target ?? '', pace })
      for (const c of r.closed) closedAll.push(`${step.id}: ${c}`)
    } catch {
      /* a page that is changing under us: the next step looks again */
    }
  }
  const noteOutcome = (step: Step, out: Outcome, what: string) => {
    for (const c of out.closed) closedAll.push(`${step.id}: ${c}`)
    if (out.did && !out.verified) unverified.push({ step: step.id, label: step.label ?? step.find?.target ?? '', why: out.note ?? `${what}, but the page did not show the effect` })
  }
  /** a control found again by the words the person used (or by its address) */
  const targetOf = async (step: Step, kindFallback: 'click' | 'type' = 'click', words?: string): Promise<{ selector: string; label: string; rect: Rect } | null> => {
    const spec = step.find ?? (words ? { target: words, kind: kindFallback } : null)
    if (spec) {
      const { found } = await findElement(page, spec, 6000)
      if (found) return { selector: found.selector, label: found.label || step.label || spec.target, rect: found.rect }
    }
    if (step.selector) {
      const r = await rectOf(step.selector)
      if (r) return { selector: step.selector, label: step.label ?? step.selector, rect: r }
    }
    return null
  }
  for (const st of playbook.steps) {
    // a rule for the whole run is armed from the start
    if (st.kind === 'whenever') try { const j = JSON.parse(st.text ?? '{}') as { condition?: string; then?: string }; if (j.condition) armWhenever(page, { condition: j.condition, action: j.then ?? 'close' }) } catch { /* a rule that cannot be read is left out */ }
  }
  const seenViews: Array<{ beat: number; sig: string; acted: boolean }> = []
  const dropped = new Set<string>()
  // the steps are copied: finding a control again by its description changes the copy, never the saved playbook
  const steps = playbook.steps.map((st) => ({ ...st, expect: st.expect ? { ...st.expect } : undefined }))
  let lastSel: string | undefined
  /** where a step's target is now; 'gone' (repair mode only) when it cannot be found any more */
  const locate = async (step: Step): Promise<Rect | 'gone' | null> => {
    // a step the person wrote is found by what they called the control, so a page that moved or redrew still works
    if (step.find) {
      const { found } = await findElement(page, step.find, 8000)
      if (found) {
        step.selector = found.selector
        const r0 = await rectOf(found.selector)
        if (r0) return r0
      }
      if (!step.selector) return null
    }
    const r = await rectOf(step.selector!)
    if (r || !o.repair) return r
    const fixed = await findByLabel(page, step)
    if (fixed) {
      repairs.push(`${step.id}: "${step.label}" moved, now found as ${fixed}`)
      step.selector = fixed
      const again = await rectOf(fixed)
      if (again) return again
    }
    repairs.push(`${step.id}: "${step.label ?? step.selector}" is no longer there, so that step is left out`)
    dropped.add(step.id)
    return 'gone'
  }
  const beatIds = [...new Set(steps.map((s) => s.beat))].sort((a, b) => a - b)
  for (const beat of beatIds) {
    const startedAt = t()
    const startMs = Date.now()
    let focus: (Rect & { zoom: number }) | undefined
    let focusKind: Step['focus']
    let focusRect: Rect | null = null
    for (const step of steps.filter((s) => s.beat === beat)) {
      stepFromUrl = page.url()
      current = step.id
      try {
        await sweep(step)
        if (step.kind === 'goto') {
          const url = step.url ?? playbook.startUrl
          if (!o.gate.hostAllowed(url)) return { ok: false, failure: `${step.id}: ${url} is outside the allowed sites`, beats, navigations, log, redactionMisses: misses }
          // the recording may already be sitting on this page (so the video never opens on a blank screen)
          if (page.url() !== url) await page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch(async (err: Error) => { if (!/timeout/i.test(err.message) || !(await page.evaluate(() => document.readyState !== 'loading' && (document.body?.innerText.trim().length ?? 0) > 20).catch(() => false))) throw err })
          await page.mouse.move(mouse.x, mouse.y) // the pointer reappears on the new page
          say(step.id, `opened ${url}`)
        } else if (step.kind === 'type' && (step.selector || step.find)) {
          if (step.focused) {
            // the text goes where the cursor is; the words that named the box are the fallback
            const f = await focusedEditable(page)
            if (f) { step.selector = f; step.find = undefined }
          }
          const found = await locate(step)
          if (found === 'gone') continue
          const r = found
          if (!r && step.find) { skipStep(step, `no box called "${step.label ?? step.find.target}" was found`); continue }
          if (!r) return { ok: false, failure: `${step.id}: could not find "${step.label ?? step.selector}"`, beats, navigations, log, redactionMisses: misses }
          // a stored secret goes only into the field it is for, on the app's own pages
          for (const m of (step.text ?? '').matchAll(/\{\{secret:(\w+)\}\}/g)) {
            const h = await deepEval(page, step.selector!, (el) => {
              const i = el as HTMLInputElement
              const lab = i.labels && i.labels[0] ? i.labels[0].innerText : ''
              return { type: i.type || '', name: i.getAttribute('name') ?? '', id: i.id, label: lab || i.getAttribute('aria-label') || '', placeholder: i.getAttribute('placeholder') ?? '', autocomplete: i.getAttribute('autocomplete') ?? '' }
            })
            if (!h) return { ok: false, failure: `${step.id}: could not find "${step.label ?? step.selector}"`, beats, navigations, log, redactionMisses: misses }
            const fill = checkSecretFill({ secret: m[1], fieldKind: classifyField(h), pageAllowed: o.gate.hostAllowed(page.url()) })
            if (!fill.allow) return { ok: false, failure: `${step.id}: blocked — ${fill.reason}`, beats, navigations, log, redactionMisses: misses }
          }
          const value = resolve(step.text ?? '')
          const typed = await doType(env, { selector: step.selector!, label: step.label ?? step.find?.target ?? step.selector! }, value, { key: step.replace && step.find ? step.label : undefined, replace: step.replace ?? (step.find ? undefined : true), secret: /\{\{secret:/.test(step.text ?? ''), delay: step.find ? 55 : 70, stepWords: step.label })
          noteOutcome(step, typed, 'typed')
          if (typed.skipped) {
            if (step.find) { skipStep(step, typed.skipped.why); continue }
            return { ok: false, failure: `${step.id}: ${typed.skipped.why}`, beats, navigations, log, redactionMisses: misses }
          }
          say(step.id, `typed into "${step.label ?? step.selector}" (${value.length} characters)${typed.verified ? '' : ' (it does not read back as typed)'}`)
          lastSel = step.selector
          focusRect = typed.rect ?? r
          focusKind = step.focus
        } else if ((step.kind === 'click' || step.kind === 'dblclick' || step.kind === 'pick') && (step.selector || step.find || /^\{"pick"/.test(step.text ?? ''))) {
          // a pick by place or by value ("the cheapest jacket") is decided again on the page as it is now
          let pickNote = ''
          let pickVerb: string | undefined
          if (/^\{"pick"/.test(step.text ?? '')) {
            try {
              const parsed = JSON.parse(step.text!) as { pick: PickSpec; verb?: string }
              pickVerb = parsed.verb
              const spec = parsed.pick
              const res = await pickByStructure(page, spec)
              if (!res.ok) { skipStep(step, res.why); continue }
              step.selector = res.selector
              pickNote = res.reason
            } catch {
              /* a pick that cannot be read keeps the address it was made with */
            }
          }
          const found = pickNote ? await rectOf(step.selector!) : await locate(step)
          if (found === 'gone') continue
          const r = found
          if (!r && step.find) { skipStep(step, `no control called "${step.label ?? step.find.target}" was found`); continue }
          if (!r) return { ok: false, failure: `${step.id}: could not find "${step.label ?? step.selector}"`, beats, navigations, log, redactionMisses: misses }
          const info = await deepEval(page, step.selector!, (el) => {
            const h = el as HTMLElement
            const label = (h.innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector('img[alt]')?.getAttribute('alt') || el.querySelector('svg title')?.textContent || '').trim()
            const hint = [el.id, h.className && typeof h.className === 'string' ? h.className : '', el.getAttribute('name'), el.getAttribute('data-testid'), el.getAttribute('data-action')].filter(Boolean).join(' ')
            return { label, hint, kind: el.tagName === 'A' ? 'link' : 'button', href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : undefined }
          })
          if (!info) { if (step.find) { skipStep(step, 'it disappeared before it could be used'); continue } return { ok: false, failure: `${step.id}: could not find "${step.label ?? step.selector}"`, beats, navigations, log, redactionMisses: misses } }
          const label = info.label
          const verdict = o.gate.checkClick({ label: label || step.label || '', intent: step.intent, kind: info.kind as 'button' | 'link', href: info.href, hint: info.hint })
          if (!verdict.allow && step.find) { skipStep(step, `your own rules do not allow it (${verdict.reason})`); continue }
          if (!verdict.allow) return { ok: false, failure: `${step.id}: blocked by guardrails — ${verdict.reason}`, beats, navigations, log, redactionMisses: misses }
          // a page that is still drawing (help icons, banners) moves its controls: wait until this one holds still
          let target: Rect = r
          for (let k = 0; k < 15; k++) {
            await sleep(200)
            const again = await rectOf(step.selector!)
            if (!again) break
            const still = Math.abs(again.x - target.x) < 1 && Math.abs(again.y - target.y) < 1
            target = again
            if (still) break
          }
          if (step.intent === 'login-submit' || step.intent === 'logout') o.gate.openSessionWindow()
          const out = await doClick(env, { selector: step.selector!, label: label || step.label || step.selector! }, { double: step.kind === 'dblclick' || pickVerb === 'dblclick', stepWords: step.label ?? step.find?.target })
          noteOutcome(step, out, 'clicked')
          await page.mouse.move(mouse.x, mouse.y)
          if (out.skipped) {
            // a click that did not reach the control is never reported as done; the sign-in has its own check afterwards
            if (step.intent === 'login-submit') say(step.id, `the sign-in button was not reached (${out.skipped.why}); the sign-in check goes on`)
            else if (step.find || step.intent === 'logout' || step.intent === 'navigate') { skipStep(step, out.skipped.why); continue }
            else { skipStep(step, out.skipped.why); continue }
          } else {
            say(step.id, `${step.kind === 'dblclick' ? 'double-clicked' : 'clicked'} "${label || step.label}" (${verdict.reason})${out.verified ? '' : ' — the page did not visibly change'}${pickNote ? ` — ${pickNote}` : ''}`)
          }
          lastSel = step.selector
          focusRect = out.rect ?? r
          focusKind = step.focus
        } else if (step.kind === 'select' && step.text && (step.selector || step.find)) {
          // choose an entry in a dropdown: the pointer goes to it, then the entry is set (a real <select>'s list is drawn by the
          // browser itself and cannot be filmed, so the dropdown shows its new value instead)
          const found = await locate(step)
          if (found === 'gone') continue
          const r = found
          if (!r && step.find) { skipStep(step, `no dropdown called "${step.label ?? step.find.target}" was found`); continue }
          if (!r) return { ok: false, failure: `${step.id}: could not find the dropdown "${step.label ?? step.selector}"`, beats, navigations, log, redactionMisses: misses }
          const choices = await readChoices(page, step.selector!)
          await glide(r.x + Math.min(r.w * 0.5, 160), r.y + r.h / 2, 700)
          await sleep(450 * pace)
          if (choices.native) {
            const at = matchOption(choices.entries, step.text)
            if (at < 0 && step.find) { skipStep(step, `the dropdown has no entry called "${step.text}"`); continue }
            if (at < 0) return { ok: false, failure: `${step.id}: the dropdown has no entry called "${step.text}"`, beats, navigations, log, redactionMisses: misses }
            const verdict = o.gate.checkClick({ label: choices.entries[at], kind: 'button' })
            if (!verdict.allow) return { ok: false, failure: `${step.id}: blocked by guardrails — ${verdict.reason}`, beats, navigations, log, redactionMisses: misses }
            await chooseNative(page, step.selector!, at)
            say(step.id, `chose "${choices.entries[at]}" in "${step.label ?? step.selector}"`)
          } else {
            await page.mouse.click(mouse.x, mouse.y)
            await sleep(500 * pace)
            const entry = await findElement(page, { target: step.text, kind: 'click', within: ['suggestion'] }, 4000)
            if (!entry.found) return { ok: false, failure: `${step.id}: the dropdown has no entry called "${step.text}"`, beats, navigations, log, redactionMisses: misses }
            const verdict = o.gate.checkClick({ label: entry.found.label || step.text, kind: 'button' })
            if (!verdict.allow) return { ok: false, failure: `${step.id}: blocked by guardrails — ${verdict.reason}`, beats, navigations, log, redactionMisses: misses }
            await glide(entry.found.rect.x + entry.found.rect.w / 2, entry.found.rect.y + entry.found.rect.h / 2, 500)
            await sleep(250 * pace)
            await page.mouse.click(mouse.x, mouse.y)
            say(step.id, `chose "${entry.found.label || step.text}" in "${step.label ?? step.selector}"`)
          }
          await sleep(pace === 0 ? 300 : 900) // the page redraws for the new entry
          lastSel = step.selector
        } else if (step.kind === 'scrollto') {
          // the page travels to the part the person named, the way a hand scrolls, over as long as the explanation of it allows
          const need = (o.beatMinSec?.get(beat) ?? 0) * 1000
          const budget = pace === 0 ? 0 : Math.max(2200, Math.min(6000, need - (Date.now() - startMs) - 1500))
          const out = await scrollToSection(page, step.label ?? step.find?.target ?? '', { budgetMs: budget, instant: pace === 0, mouseTo: (x, y) => glide(x, y, 500) })
          if (out.found) say(step.id, `scrolled to "${out.label}"${out.moved ? '' : ' (it was already on screen)'}`)
          else skipStep(step, `no part of the page called "${step.label ?? step.find?.target}" was found`)
        } else if (step.kind === 'hover' && (step.selector || step.find)) {
          const found = await locate(step)
          if (found === 'gone') continue
          if (!found) { skipStep(step, `nothing called "${step.label ?? step.find?.target}" was found`); continue }
          const hv = await doHover(env, { selector: step.selector!, label: step.label ?? step.find?.target ?? step.selector! }, async (x, y) => {
            await glide(x, y, 800)
            await sleep(1100 * pace) // the tooltip appears and is read
            return ''
          })
          noteOutcome(step, hv, 'hovered')
          if (hv.skipped) { skipStep(step, hv.skipped.why); continue }
          say(step.id, `rested the pointer on "${step.label ?? step.selector}"`)
          lastSel = step.selector
          focusRect = hv.rect ?? found
          focusKind = step.focus
        } else if (step.kind === 'mark' && step.find) {
          // a mark of a chart: found by its colour on screen, or by its label or size when the chart is SVG. The place the rehearsal used is tried first.
          const info = ((): { verb?: string; colour?: string; fx?: number; fy?: number; tap?: boolean; svg?: { label?: string; labels?: string[]; extreme?: 'max' | 'min'; kind?: 'bar' | 'point' } } => {
            try {
              return JSON.parse(step.text ?? '{}')
            } catch {
              return {}
            }
          })()
          const hover = info.verb === 'hover'
          const chart = await pickChart(page, step.find.chart ?? '')
          let at: { x: number; y: number } | null = null
          let alts: Array<{ x: number; y: number }> = []
          if (chart && info.svg) {
            const sv = await findSvgMark(page, { chart: step.find.chart, label: info.svg.label, labels: info.svg.labels, colour: info.colour, extreme: info.svg.extreme, kind: info.svg.kind })
            if (!sv.hit) { skipStep(step, sv.why ?? 'no such mark was found'); continue }
            at = { x: sv.hit.x, y: sv.hit.y }
          } else if (chart && typeof info.fx === 'number' && typeof info.fy === 'number') at = { x: chart.rect.x + info.fx * chart.rect.w, y: chart.rect.y + info.fy * chart.rect.h }
          if (chart && !at) {
            const res = await findMark(page, { spec: step.find, colour: info.colour, hover, move: (x, y) => glide(x, y, 350), allowTap: hover && o.gate.checkClick({ label: `${info.colour ?? ''} ${step.find.noun ?? 'mark'} on a chart`.trim(), kind: 'button' }).allow })
            if (res.hit) { at = { x: res.hit.x, y: res.hit.y }; alts = res.hit.alts ?? [] }
            else { skipStep(step, res.why ?? 'no such mark was found'); continue }
          }
          if (!chart || !at) { skipStep(step, 'there is no chart on the screen'); continue }
          if (!hover) {
            const verdict = o.gate.checkClick({ label: `${info.colour ?? ''} ${step.find.noun ?? 'mark'} on a chart`.trim(), kind: 'button' })
            if (!verdict.allow) { skipStep(step, `your own rules do not allow it (${verdict.reason})`); continue }
            // the chart must answer the click: a readout, or the picture changing. A miss by a pixel is tried again elsewhere.
            const res = await clickMarkChecked(env, chart.rect, [at, ...alts])
            if (!res.ok) { skipStep(step, `the ${step.label ?? 'mark'} was clicked in ${res.tries} places but the chart showed no reaction`); continue }
            at = res.at
          } else {
            await glide(at.x, at.y, 800)
            await sleep(1500 * pace)
            if (info.tap) {
              await page.mouse.click(at.x, at.y) // a phone shows its tooltip on a tap
              await sleep(900 * pace)
            }
          }
          say(step.id, `${hover ? 'rested the pointer on' : 'clicked'} a ${step.label ?? 'mark'} of the chart`)
          focusRect = { x: Math.max(0, at.x - 80), y: Math.max(0, at.y - 80), w: 160, h: 160 }
          focusKind = 'target'
        } else if (step.kind === 'key') {
          const j = ((): { keys?: string; repeatUntil?: string } => { try { return JSON.parse(step.text ?? '{}') } catch { return {} } })()
          if (!j.keys) { skipStep(step, 'no key was named'); continue }
          const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 3000 }).catch(() => null)
          const k = await doKey(env, j.keys, j.repeatUntil)
          noteOutcome(step, k, 'pressed')
          await Promise.race([nav, sleep(300)])
          if (k.skipped) { skipStep(step, k.skipped.why); continue }
          say(step.id, `pressed ${j.keys}${j.repeatUntil ? ` until "${j.repeatUntil}" was focused` : ''}${k.verified ? '' : ' — the page did not visibly react'}`)
        } else if (step.kind === 'drag') {
          const j = ((): { from?: string; to?: string; position?: 'before' | 'after' | 'top' | 'bottom'; ref?: string } => { try { return JSON.parse(step.text ?? '{}') } catch { return {} } })()
          const from = await targetOf(step, 'click', j.from)
          if (!from) { skipStep(step, `"${j.from ?? step.label}" was not found`); continue }
          const ref = j.ref ? await targetOf({ ...step, find: { target: j.ref, kind: 'click' }, selector: undefined }) : null
          const zone = j.to ? (await dropZone(page, j.to))?.found ?? (await targetOf({ ...step, find: { target: j.to, kind: 'click' }, selector: undefined })) : null
          const d = await doDrag(env, { from: { selector: from.selector, label: from.label }, to: zone ? { selector: zone.selector, label: j.to! } : undefined, ref: ref ? { selector: ref.selector, label: j.ref! } : undefined, position: j.position })
          noteOutcome(step, d, 'dragged')
          if (d.skipped) { skipStep(step, d.skipped.why); continue }
          say(step.id, `dragged "${from.label}"${j.to ? ` to "${j.to}"` : ''}`)
          focusRect = d.rect ?? from.rect
          focusKind = 'target'
        } else if (step.kind === 'slider') {
          const j = ((): { value?: number; min?: number; max?: number } => { try { return JSON.parse(step.text ?? '{}') } catch { return {} } })()
          const sl = await doSlider(env, { selector: step.selector, label: step.label ?? step.find?.target ?? 'slider' }, j)
          noteOutcome(step, sl, 'set')
          if (sl.skipped) { skipStep(step, sl.skipped.why); continue }
          say(step.id, `set the slider "${step.label}" to ${j.min !== undefined && j.max !== undefined ? `${j.min}–${j.max}` : j.value}`)
          focusRect = sl.rect ?? null
          focusKind = 'target'
        } else if (step.kind === 'date') {
          const j = ((): { date?: string; phrase?: string } => { try { return JSON.parse(step.text ?? '{}') } catch { return {} } })()
          const t = await targetOf(step, 'click')
          const dt = await doDate(env, t ? { selector: t.selector, label: t.label } : null, j.date ?? '', j.phrase ?? j.date ?? '')
          noteOutcome(step, dt, 'chose the date')
          if (dt.skipped) { skipStep(step, dt.skipped.why); continue }
          say(step.id, `chose the date ${j.date}`)
          focusRect = dt.rect ?? null
          focusKind = 'target'
        } else if (step.kind === 'scrolluntil') {
          const j = ((): { text?: string; dir?: 'down' | 'up' | 'left' | 'right'; within?: string[] } => { try { return JSON.parse(step.text ?? '{}') } catch { return {} } })()
          const su = await doScrollUntil(env, j.text ?? '', { dir: j.dir, within: j.within })
          if (su.skipped) { skipStep(step, su.skipped.why); continue }
          say(step.id, `scrolled until "${j.text}" was on screen`)
        } else if (step.kind === 'whenever') {
          say(step.id, `from now on: ${step.label ?? step.text}`)
        } else if (step.kind === 'press' && step.text) {
          await sleep(200 * pace)
          const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 6000 }).catch(() => null)
          await page.keyboard.press(step.text as 'Enter')
          await Promise.race([nav, sleep(1500)])
          say(step.id, `pressed ${step.text}`)
        } else if (step.kind === 'scroll') {
          // turn the wheel over the area the person named, as long as the explanation of it lasts
          const need = (o.beatMinSec?.get(beat) ?? 0) * 1000
          const budget = pace === 0 ? 0 : Math.max(3500, need - (Date.now() - startMs) - 1800)
          const out = await scrollArea(page, step.find, step.text === 'up' ? 'up' : 'down', { near: lastSel, budgetMs: budget, instant: pace === 0, mouseTo: (x, y) => glide(x, y, 700) })
          say(step.id, `scrolled ${step.text === 'up' ? 'up' : 'down'}${out.moved ? '' : ' (nothing moved)'}`)
        } else if (step.kind === 'reveal') {
          // bring one part of the page into view and stay on it (a section of a tour, a stage of a process)
          const r = step.selector ? await rectOf(step.selector) : null
          if (r) {
            await glide(r.x + Math.min(r.w * 0.5, 240), r.y + Math.min(r.h * 0.5, 80), 700)
            await sleep((step.holdMs ?? 1500) * pace)
            focusRect = r
            focusKind = step.focus ?? 'target'
            lastSel = step.selector
            say(step.id, `showed "${step.label ?? step.selector}"`)
          } else say(step.id, `could not find "${step.label ?? step.selector}", so it was not shown`)
        } else if (step.kind === 'wait' && step.intent === 'inspect') {
          // the result of what was just done: wait for it to finish drawing, then let the viewer see all of it
          await inspectView(page, pace)
          say(step.id, 'looked at the result')
        } else if (step.kind === 'wait') {
          await sleep(((step.expect ? 0 : 800) + (step.holdMs ?? 0)) * pace)
        } else if (step.kind === 'handoff') {
          say(step.id, 'waiting for a person')
          await o.onHandoff?.(step)
        }
        const problem = await checkExpect(step)
        if (problem && step.intent === 'logout') {
          // the sign-out is the engine's own last step: a page that does not show the sign-in form again is not a reason to stop the film
          say(step.id, `WARNING: ${problem}; carrying on`)
        } else if (problem && o.repair) {
          // a check that no longer holds must not stop the film: it is taken off the step
          repairs.push(`${step.id}: ${problem}, so that check is left out`)
          step.expect = undefined
        } else if (problem) return { ok: false, failure: `${step.id}: ${problem}`, beats, navigations, log, redactionMisses: misses }
        await sleep(200 * pace)
        await verify(step.id)
        if (step.focus) focusKind = step.focus
        if (step.focus === 'banner') {
          focusRect = await page.evaluate(() => {
            const el = document.querySelector('[role=alert],[role=status],.flash,.alert,#flash,.notification,h1,h2')
            if (!el) return null
            const r = el.getBoundingClientRect()
            return { x: r.x, y: r.y, w: r.width, h: r.height }
          })
        } else if (step.focus === 'form') {
          focusRect = await page.evaluate((sel) => {
            const el = sel ? document.querySelector(sel) : null
            const box = el?.closest('form') ?? el?.parentElement
            if (!box) return null
            const r = box.getBoundingClientRect()
            return { x: r.x, y: r.y, w: r.width, h: r.height }
          }, step.selector ?? '')
        } else if (step.focus === 'page') {
          focusRect = null
        }
      } catch (err) {
        return { ok: false, failure: `${step.id}: ${(err as Error).message}`, beats, navigations, log, redactionMisses: misses }
      }
    }
    // hold the beat for as long as its narration needs
    const need = (o.beatMinSec?.get(beat) ?? 0) * 1000
    const left = need - (Date.now() - startMs)
    if (left > 0 && pace !== 0) await sleep(left)
    if (focusKind && focusKind !== 'page' && focusRect) focus = { ...focusRect, zoom: 1 }
    // what the screen looks like at the end of the beat (to see later whether the film ever left one screen)
    const sig = await page
      .evaluate(() => {
        let sc = 0
        for (const e of Array.from(document.querySelectorAll('*')).slice(0, 3000)) if (e !== document.scrollingElement && (e as HTMLElement).scrollTop > 0) sc += (e as HTMLElement).scrollTop
        return `${location.pathname}${location.search}${location.hash}|${Math.round(scrollY / 12)}|${Math.round(sc / 12)}|${(document.body?.innerText ?? '').length}`
      })
      .catch(() => '')
    seenViews.push({ beat, sig, acted: steps.some((s) => s.beat === beat && s.kind !== 'wait' && s.kind !== 'goto') })
    beats.push({ beat, startSec: startedAt, endSec: t(), focus, url: page.url() })
    await o.afterBeat?.(beat)
  }
  const kept = steps.filter((st) => !dropped.has(st.id))
  // beats with steps in them that all ended on the same screen: the voice talks about things the film never shows
  const stuck: NonNullable<RunResult['stuck']> = []
  for (let i = 0; i < seenViews.length; ) {
    let j = i
    while (j + 1 < seenViews.length && seenViews[j + 1].sig === seenViews[i].sig && seenViews[j + 1].sig) j++
    if (j - i >= 2 && seenViews.slice(i + 1, j + 1).some((v) => v.acted)) stuck.push({ from: seenViews[i].beat, to: seenViews[j].beat })
    i = j + 1
  }
  return { ok: true, beats, navigations, log, redactionMisses: misses, ...(skipped.length ? { skipped } : {}), ...(stuck.length ? { stuck } : {}), ...(closedAll.length ? { closed: closedAll } : {}), ...(unverified.length ? { unverified } : {}), ...(o.repair ? { playbook: { ...playbook, steps: kept }, repairs } : {}) }
}
