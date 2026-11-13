/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { Page } from 'puppeteer-core'
import type { AppPage } from '@shared/appRecon'
import { pathTemplate } from './detect'
import type { PolicyGate } from './policy'
import { scoutPage } from './scout'

/**
 * The explorer: goes through an app the way a person getting to know it would.
 *
 * It is deterministic and needs no AI. It starts on the page it is given and
 * follows the app's own links (main navigation first), looks at each page,
 * and, depending on depth, tries what a person would try: search boxes,
 * filters, tabs, "show more" buttons and (thorough) forms filled with made-up
 * sample data. Everything it does is really performed, unless the person
 * restricted it; the restrictions are enforced by the policy gate, not here.
 *
 * Hard limits on pages, actions and time stop it, and it says which one did.
 */

export type Depth = 'quick' | 'standard' | 'thorough'

export const DEPTH_LIMITS: Record<Depth, { pages: number; actions: number; ms: number }> = {
  quick: { pages: 8, actions: 40, ms: 4 * 60_000 },
  standard: { pages: 25, actions: 150, ms: 15 * 60_000 },
  thorough: { pages: 60, actions: 400, ms: 40 * 60_000 }
}

export interface ExploredStep {
  kind: 'type' | 'click' | 'press'
  selector?: string
  label?: string
  text?: string
}

export interface Interaction {
  steps: ExploredStep[]
  /** what the page looked like after, if it changed */
  changed: boolean
  /** a form was submitted: this may have created or changed data */
  writes: boolean
  after?: AppPage
}

export interface Visit {
  index: number
  page: AppPage
  /** how the explorer got here */
  via: 'start' | 'link'
  fromLabel?: string
  interactions: Interaction[]
}

export interface Exploration {
  visits: Visit[]
  actions: number
  stoppedBy: 'done' | 'pages' | 'actions' | 'time' | 'cancelled'
  elapsedMs: number
}

export interface ExploreInput {
  page: Page
  gate: PolicyGate
  startUrl: string
  outDir: string
  depth: Depth
  revealIdentifiers: boolean
  log?: (m: string) => void
  signal?: AbortSignal
  /** called before each page: the person may have taken over; a returned address is visited next */
  pause?: () => Promise<string | void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** let the page finish what it is doing after a click or a load */
export async function settle(page: Page): Promise<void> {
  await page.waitForNetworkIdle({ idleTime: 350, timeout: 4000 }).catch(() => undefined)
  await sleep(150)
}

/** something cheap that changes when the page changes */
async function fingerprint(page: Page): Promise<string> {
  return page.evaluate(() => `${location.href}|${document.body?.innerText.length ?? 0}|${document.body?.innerText.slice(0, 200) ?? ''}`).catch(() => '')
}

const SAFE_BUTTON = /^(search|find|filter|apply|show|view|open|details?|more|expand|load|next|previous|refresh|sort|tab|overview|reports?|stats?|go)\b/i
const SUBMIT_BUTTON = /^(save|submit|add|create|apply|send|update|post|new)\b/i
const SKIP_FIELD_KINDS = new Set(['password', 'otp', 'card', 'ssn'])

/** made-up values, unique per run so created records do not collide */
export function sampleFor(f: { kind: string; inputType: string; label: string }, stamp: string): string | null {
  if (SKIP_FIELD_KINDS.has(f.kind)) return null
  switch (f.kind) {
    case 'email': return `sample.${stamp}@example.com`
    case 'phone': return '+1 555 0100'
    case 'person-name': return `Sample User ${stamp}`
    case 'address': return '1 Example Street'
    case 'search': return 'test'
  }
  if (f.inputType === 'number') return '10'
  if (f.inputType === 'date') return new Date().toISOString().slice(0, 10)
  if (f.inputType === 'select' || f.inputType === 'select-one') return null
  return `Sample ${stamp}`
}

function normalize(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.toString()
  } catch {
    return url
  }
}

export async function explore(inp: ExploreInput): Promise<Exploration> {
  const { page, gate, outDir } = inp
  const lim = DEPTH_LIMITS[inp.depth]
  const t0 = Date.now()
  const say = (m: string) => inp.log?.(`  ${m}`)
  const visits: Visit[] = []
  const seen = new Set<string>()
  const templates = new Map<string, number>()
  const stamp = Date.now().toString(36).slice(-5)
  let actions = 0
  let stoppedBy: Exploration['stoppedBy'] = 'done'

  const limit = (): Exploration['stoppedBy'] | null =>
    inp.signal?.aborted ? 'cancelled' : Date.now() - t0 > lim.ms ? 'time' : visits.length >= lim.pages ? 'pages' : actions >= lim.actions ? 'actions' : null

  const queue: Array<{ url: string; from?: string }> = [{ url: /^https?:/.test(page.url()) ? page.url() : inp.startUrl }]

  while (queue.length) {
    const extra = await inp.pause?.()
    if (extra) queue.unshift({ url: extra, from: 'you' })
    const why = limit()
    if (why) { stoppedBy = why; break }
    const next = queue.shift()!
    const key = normalize(next.url)
    const tpl = pathTemplate(next.url)
    if (seen.has(key) || (templates.get(tpl) ?? 0) >= 2 || !gate.hostAllowed(next.url)) continue
    seen.add(key)
    templates.set(tpl, (templates.get(tpl) ?? 0) + 1)
    try {
      if (normalize(page.url()) !== key) {
        await page.goto(next.url, { waitUntil: 'load', timeout: 20000 })
        actions++
      }
      await settle(page)
    } catch (err) {
      say(`could not open ${next.url}: ${(err as Error).message.slice(0, 80)}`)
      continue
    }
    const sp = await scoutPage(page, outDir, `p${visits.length + 1}`, { revealIdentifiers: inp.revealIdentifiers })
    const visit: Visit = { index: visits.length, page: sp, via: visits.length === 0 ? 'start' : 'link', fromLabel: next.from, interactions: [] }
    visits.push(visit)
    say(`page ${visits.length}: "${sp.title || sp.url}" (${sp.fields.length} fields, ${sp.controls.length} controls)`)

    if (inp.depth !== 'quick') {
      try {
        actions += await interact(page, gate, visit, inp.depth, stamp, outDir, say, () => !!limit())
      } catch (err) {
        say(`interaction stopped: ${(err as Error).message.slice(0, 80)}`)
      }
      // leave the page as it was found
      if (normalize(page.url()) !== key) await page.goto(next.url, { waitUntil: 'load', timeout: 20000 }).catch(() => undefined)
    }

    for (const c of sp.controls) {
      if (c.kind !== 'link' || !c.href) continue
      if (!gate.hostAllowed(c.href)) continue
      if (!gate.peekClick({ label: c.label, kind: 'link', href: c.href }).allow) continue
      const k = normalize(c.href)
      if (!seen.has(k) && !queue.some((q) => normalize(q.url) === k)) queue.push({ url: c.href, from: c.label })
    }
  }
  if (!queue.length && stoppedBy === 'done') stoppedBy = 'done'
  say(`explored ${visits.length} pages with ${actions} actions (${stoppedBy === 'done' ? 'nothing left to visit' : `stopped by the ${stoppedBy} limit`})`)
  return { visits, actions, stoppedBy, elapsedMs: Date.now() - t0 }
}

/** try what a person would try on this page; returns how many actions were taken */
async function interact(page: Page, gate: PolicyGate, visit: Visit, depth: Depth, stamp: string, outDir: string, say: (m: string) => void, atLimit: () => boolean): Promise<number> {
  const sp = visit.page
  let n = 0
  const cap = depth === 'thorough' ? 6 : 3
  const record = async (steps: ExploredStep[], before: string, writes: boolean) => {
    await settle(page)
    const after = await fingerprint(page)
    const changed = after !== before
    let afterPage: AppPage | undefined
    if (changed) afterPage = await scoutPage(page, outDir, `p${visit.index + 1}-a${visit.interactions.length + 1}`, { revealIdentifiers: false }).catch(() => undefined)
    visit.interactions.push({ steps, changed, writes, after: afterPage })
    return changed
  }
  const backToPage = async () => {
    if (page.url().split('#')[0] !== sp.url.split('#')[0]) await page.goto(sp.url, { waitUntil: 'load', timeout: 20000 }).catch(() => undefined)
    else await page.reload({ waitUntil: 'load' }).catch(() => undefined)
    await settle(page)
  }

  // search boxes
  const box = sp.fields.find((f) => !f.sensitive && (f.kind === 'search' || /search/i.test(`${f.label} ${f.name}`)))
  if (box && !atLimit() && visit.interactions.length < cap) {
    const before = await fingerprint(page)
    const text = sampleFor(box, stamp) ?? 'test'
    try {
      await page.click(box.selector, { count: 3 })
      await page.keyboard.type(text, { delay: 20 })
      const go = sp.controls.find((c) => c.kind === 'button' && /^(search|go|find)\b/i.test(c.label) && gate.checkClick({ label: c.label, kind: 'button' }).allow)
      const steps: ExploredStep[] = [{ kind: 'type', selector: box.selector, label: box.label || 'search', text }]
      if (go) {
        await page.click(go.selector)
        steps.push({ kind: 'click', selector: go.selector, label: go.label })
      } else {
        await page.keyboard.press('Enter')
        steps.push({ kind: 'press', text: 'Enter' })
      }
      n += 2
      if (await record(steps, before, false)) say(`searched "${text}" in ${box.label || 'the search box'}: the page changed`)
      await backToPage()
    } catch { /* not usable */ }
  }

  // buttons that only look at things
  for (const c of sp.controls) {
    if (atLimit() || visit.interactions.length >= cap) break
    if (c.kind !== 'button' || !SAFE_BUTTON.test(c.label.trim())) continue
    if (/^(search|go|find)\b/i.test(c.label.trim()) && box) continue
    if (!gate.checkClick({ label: c.label, kind: 'button' }).allow) continue
    const before = await fingerprint(page)
    try {
      await page.click(c.selector)
      n++
      if (await record([{ kind: 'click', selector: c.selector, label: c.label }], before, false)) say(`pressed "${c.label}": the page changed`)
      if (page.url().split('#')[0] !== sp.url.split('#')[0]) await backToPage()
    } catch { /* gone or covered */ }
  }

  // thorough: forms, filled with sample data
  if (depth === 'thorough') {
    const fillable = sp.fields.filter((f) => !f.sensitive && f.kind !== 'search' && sampleFor(f, stamp))
    const submit = sp.controls.find((c) => c.kind === 'button' && SUBMIT_BUTTON.test(c.label.trim()) && gate.peekClick({ label: c.label, kind: 'button' }).allow)
    if (fillable.length && submit && !atLimit() && visit.interactions.length < cap) {
      const before = await fingerprint(page)
      const steps: ExploredStep[] = []
      try {
        for (const f of fillable.slice(0, 6)) {
          const text = sampleFor(f, stamp)!
          await page.click(f.selector, { count: 3 })
          await page.keyboard.type(text, { delay: 10 })
          steps.push({ kind: 'type', selector: f.selector, label: f.label || f.name, text })
          n++
        }
        if (gate.checkClick({ label: submit.label, kind: 'button' }).allow) {
          await page.click(submit.selector)
          steps.push({ kind: 'click', selector: submit.selector, label: submit.label })
          n++
          if (await record(steps, before, true)) say(`submitted the form with "${submit.label}": the page changed`)
          await backToPage()
        }
      } catch { /* the form did not take it */ }
    }
  }
  return n
}

/** how likely it is that the app can be recorded, from the page that loaded (cheap, before any money is spent) */
export async function checkCompatibility(page: Page): Promise<{ level: 'works' | 'needs-help' | 'unlikely'; reason: string }> {
  const info = await page.evaluate(() => {
    const text = (document.body?.innerText ?? '').trim()
    const big = Array.from(document.querySelectorAll("canvas")).some((c) => c.getBoundingClientRect().width * c.getBoundingClientRect().height > innerWidth * innerHeight * 0.5)
    const frames = Array.from(document.querySelectorAll("iframe")).map((f) => f.src || '')
    return { len: text.length, text: text.slice(0, 600), big, frames }
  })
  if (/access denied|unusual traffic|are you a robot|blocked/i.test(info.text) && info.len < 400) return { level: 'unlikely', reason: 'The site seems to block automated browsers.' }
  if (info.frames.some((s) => /recaptcha|hcaptcha|captcha|turnstile/i.test(s)) || /verify you are human|captcha/i.test(info.text)) return { level: 'needs-help', reason: 'There is a human check; you will be asked to complete it.' }
  if (info.big && info.len < 80) return { level: 'unlikely', reason: 'The page is drawn on a canvas, so its buttons and fields cannot be read.' }
  if (info.len < 20) return { level: 'needs-help', reason: 'The page is nearly empty; it may still be loading or need a sign-in.' }
  return { level: 'works', reason: 'The page can be read.' }
}
