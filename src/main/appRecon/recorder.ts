/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import { mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CDPSession, Page } from 'puppeteer-core'
import type { Playbook, Rect, Step, Take, TimelineBeat } from '@shared/appRecon'
import type { PolicyGate } from './policy'
import { redactionInitScript, cursorInitScript, verifyScript, type RedactionConfig } from './redact'

/**
 * Recorder — a screencast of the page, plus a timeline of what was done when.
 *
 * Frames are taken straight from the browser (not a screen grab), so nothing
 * else on the computer can appear in them. The timeline is what lets the video
 * stage zoom to the right place at the right moment and line the narration up
 * with the action.
 */

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

  async start(width: number, height: number): Promise<void> {
    this.client = await this.page.createCDPSession()
    this.t0 = Date.now() / 1000
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
}

export interface RunResult {
  ok: boolean
  failure?: string
  beats: TimelineBeat[]
  navigations: Take['navigations']
  log: Take['log']
  redactionMisses: number
}

/** installs the cursor and redaction on every page this tab will ever open */
export async function prepare(page: Page, redaction: RedactionConfig): Promise<void> {
  await page.evaluateOnNewDocument(redactionInitScript(redaction))
  await page.evaluateOnNewDocument(cursorInitScript())
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
  let mouse = { x: 640, y: 360 }
  const say = (step: string, note: string) => {
    log.push({ t: t(), step, note })
    o.log?.(`  ${step}: ${note}`)
  }

  const resolve = (text: string) => text.replace(/\{\{secret:(\w+)\}\}/g, (_, k: string) => {
    const v = o.vault[k]
    if (v === undefined) throw new Error(`no secret named "${k}" in the vault`)
    return v
  })

  const rectOf = async (selector: string): Promise<Rect | null> =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      el.scrollIntoView({ block: 'center', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }, selector)

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
    const res = JSON.parse((await page.evaluate(verifyScript(o.redaction))) as string) as { misses: number; detail: string[] }
    if (res.misses) {
      misses += res.misses
      say(where, `REDACTION MISS ×${res.misses}: ${res.detail.join(', ')}`)
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

  const checkExpect = async (step: Step): Promise<string | null> => {
    const e = step.expect
    if (!e) return null
    if (e.urlIncludes && !(await waitFor(async () => page.url().includes(e.urlIncludes!)))) return `expected the address to contain "${e.urlIncludes}" but it is ${page.url()}`
    if (e.textVisible && !(await waitFor(async () => (await page.evaluate(() => document.body.innerText)).toLowerCase().includes(e.textVisible!.toLowerCase())))) return `expected to see "${e.textVisible}"`
    if (e.selectorGone && !(await waitFor(async () => (await page.$(e.selectorGone!)) === null || !(await page.$eval(e.selectorGone!, (el) => (el as HTMLElement).offsetParent !== null).catch(() => false))))) return `"${e.selectorGone}" should have gone`
    if (e.selectorVisible && !(await waitFor(async () => (await page.$(e.selectorVisible!)) !== null))) return `expected "${e.selectorVisible}" to appear`
    return null
  }

  const beatIds = [...new Set(playbook.steps.map((s) => s.beat))].sort((a, b) => a - b)
  for (const beat of beatIds) {
    const startedAt = t()
    const startMs = Date.now()
    let focus: (Rect & { zoom: number }) | undefined
    let focusKind: Step['focus']
    let focusRect: Rect | null = null
    for (const step of playbook.steps.filter((s) => s.beat === beat)) {
      try {
        if (step.kind === 'goto') {
          const url = step.url ?? playbook.startUrl
          if (!o.gate.hostAllowed(url)) return { ok: false, failure: `${step.id}: ${url} is outside the allowed sites`, beats, navigations, log, redactionMisses: misses }
          // the recording may already be sitting on this page (so the video never opens on a blank screen)
          if (page.url() !== url) await page.goto(url, { waitUntil: 'load', timeout: 20000 })
          await page.mouse.move(mouse.x, mouse.y) // the pointer reappears on the new page
          say(step.id, `opened ${url}`)
        } else if (step.kind === 'type' && step.selector) {
          const r = await rectOf(step.selector)
          if (!r) return { ok: false, failure: `${step.id}: could not find "${step.label ?? step.selector}"`, beats, navigations, log, redactionMisses: misses }
          await glide(r.x + Math.min(r.w * 0.5, 120), r.y + r.h / 2, 600)
          await sleep(180 * pace)
          await page.mouse.click(mouse.x, mouse.y)
          await sleep(220 * pace)
          const value = resolve(step.text ?? '')
          await page.keyboard.type(value, { delay: pace === 0 ? 0 : 70 })
          say(step.id, `typed into "${step.label ?? step.selector}" (${value.length} characters)`)
          focusRect = r
          focusKind = step.focus
        } else if (step.kind === 'click' && step.selector) {
          const r = await rectOf(step.selector)
          if (!r) return { ok: false, failure: `${step.id}: could not find "${step.label ?? step.selector}"`, beats, navigations, log, redactionMisses: misses }
          const info = await page.$eval(step.selector, (el) => {
            const h = el as HTMLElement
            const label = (h.innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || el.getAttribute('title') || el.querySelector('img[alt]')?.getAttribute('alt') || el.querySelector('svg title')?.textContent || '').trim()
            const hint = [el.id, h.className && typeof h.className === 'string' ? h.className : '', el.getAttribute('name'), el.getAttribute('data-testid'), el.getAttribute('data-action')].filter(Boolean).join(' ')
            return { label, hint, kind: el.tagName === 'A' ? 'link' : 'button', href: el.tagName === 'A' ? (el as HTMLAnchorElement).href : undefined }
          })
          const label = info.label
          const verdict = o.gate.checkClick({ label: label || step.label || '', intent: step.intent, kind: info.kind as 'button' | 'link', href: info.href, hint: info.hint })
          if (!verdict.allow) return { ok: false, failure: `${step.id}: blocked by guardrails — ${verdict.reason}`, beats, navigations, log, redactionMisses: misses }
          await glide(r.x + r.w / 2, r.y + r.h / 2, 700)
          await sleep(350 * pace)
          if (step.intent === 'login-submit' || step.intent === 'logout') o.gate.openSessionWindow()
          const nav = page.waitForNavigation({ waitUntil: 'load', timeout: 8000 }).catch(() => null)
          await page.mouse.click(mouse.x, mouse.y)
          await Promise.race([nav, sleep(1800)])
          await page.mouse.move(mouse.x, mouse.y)
          say(step.id, `clicked "${label || step.label}" (${verdict.reason})`)
          focusRect = r
          focusKind = step.focus
        } else if (step.kind === 'wait') {
          await sleep((step.expect ? 0 : 800) * pace)
        } else if (step.kind === 'handoff') {
          say(step.id, 'waiting for a person')
          await o.onHandoff?.(step)
        }
        const problem = await checkExpect(step)
        if (problem) return { ok: false, failure: `${step.id}: ${problem}`, beats, navigations, log, redactionMisses: misses }
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
    beats.push({ beat, startSec: startedAt, endSec: t(), focus, url: page.url() })
  }
  return { ok: true, beats, navigations, log, redactionMisses: misses }
}
