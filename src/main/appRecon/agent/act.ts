import type { Page } from 'puppeteer-core'
import type { AppPage, Step } from '@shared/appRecon'
import type { PageSegment } from '@shared/agentBrief'
import type { BeatFacts } from '../planner'
import { labelMatches, pageMatches } from '../directives'
import { DEFAULT_BLOCKED_WORDS, type PolicyGate } from '../policy'
import { scoutPage } from '../scout'

/**
 * ACT — carries out one page segment of the film's plan.
 *
 *   scoutSegment()  opens the page the segment names in the live browser, behind the policy gate, and reads it
 *   planSegment()   turns what was read into playbook steps + beat facts the recorder runs as they are
 *
 * Nothing here clicks or navigates by itself: it only writes steps. The recorder
 * runs them, and every goto and click still passes through the PolicyGate there.
 */

type Section = NonNullable<AppPage['sections']>[number]

export interface ActOptions {
  /** first beat number to use (beats continue from the film so far) */
  startBeat: number
  /** step ids are `${idPrefix}1`, `${idPrefix}2` … so two segments never collide */
  idPrefix: string
  /** used to decide whether an expander or tab may be clicked */
  gate?: PolicyGate
  /** the most sections / stages / features this segment may show, so the whole film keeps to its length */
  maxParts?: number
  /** the step was worded as something to do on this page: these controls are used in turn instead of touring it */
  onPage?: OnPageAction
}

export interface ActPlan {
  steps: Step[]
  beats: BeatFacts[]
  /** what the segment planned to show, in order: the review compares this with what ran */
  planned: Array<{ stepId: string; label: string }>
  /** things worth telling the person (a page with no stages, a section left out …) */
  notes: string[]
}

const HOLD = { brief: 2200, normal: 3600, long: 5500 } as const
const SECTION_HOLD = { brief: 1400, normal: 2200, long: 3200 } as const
const MAX_TOUR = { brief: 3, normal: 6, long: 8 } as const
const MAX_FEATURES = { brief: 3, normal: 4, long: 5 } as const
const WRITE_WORDS = new RegExp(`\\b(${[...DEFAULT_BLOCKED_WORDS, 'save', 'submit', 'create', 'add', 'send', 'post', 'publish', 'update', 'apply'].map((w) => w.replace(/\s+/g, '\\s+')).join('|')})\\b`, 'i')

const lower = (s: string) => s.toLowerCase()
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)

function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname.replace(/\/+$/, '') || '/'
  } catch {
    return url
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** a link on the scouted pages that leads where `target` says (by its name, or by what the page it leads to is called) */
export function findLinkFor(target: string, pages: AppPage[]): { url: string; label: string } | null {
  for (const p of pages) {
    for (const c of p.controls) {
      if (c.kind === 'link' && c.href && labelMatches(c.label, target)) return { url: c.href, label: c.label }
    }
  }
  for (const p of pages) {
    if (pageMatches(p, undefined, target)) return { url: p.url, label: p.title || target }
  }
  return null
}

// ------------------------------------------------------------------ a step worded as something to do, not a link's name

export interface OnPagePick {
  label: string
  selector: string
  via: 'tab' | 'button'
}

export interface OnPageAction {
  /** the person's words for the step */
  goal: string
  picks: OnPagePick[]
}

const WORD_STOP = new Set(['the', 'and', 'this', 'that', 'one', 'of', 'to', 'for', 'with', 'all', 'any', 'each', 'every', 'show', 'see', 'use', 'try', 'different', 'various', 'several', 'other', 'its', 'their', 'then', 'also', 'page', 'view'])
/** words that say "go through all of them" */
const MANY_WORDS = /\b(different|various|several|all|each|every|options?|choices?|modes?|variants?|types?|views?|tabs?|switch|cycle|toggle|compare|try)\b/i
const OPTION_WORDS = new Set(['option', 'options', 'choice', 'choices', 'mode', 'modes', 'variant', 'variants', 'type', 'types', 'tab', 'tabs', 'toggle', 'switch', 'cycle', 'chart', 'charts', 'graph', 'graphs', 'compare', 'comparison', 'views'])

const stem = (w: string) => w.replace(/(ing|ies|es|s|ed)$/, '')
const wordsIn = (s: string): string[] => (lower(s).match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !WORD_STOP.has(w)).map(stem)

/** how well a control's label fits the person's words: shared stems, partial credit allowed */
function fit(label: string, target: string): number {
  const want = wordsIn(target)
  const have = wordsIn(label)
  if (!want.length || !have.length) return 0
  return want.filter((w) => have.some((h) => h === w || (w.length > 3 && (h.startsWith(w) || w.startsWith(h))))).length / want.length
}

/** loose match of a target against links, tabs and buttons on pages already seen (a looser step than findLinkFor, still by words) */
export function findControlFor(target: string, pages: AppPage[]): { url: string; label: string } | null {
  let best: { url: string; label: string; s: number } | null = null
  for (const p of pages) {
    for (const c of p.controls) {
      if (c.kind !== 'link' || !c.href || c.label.length > 60) continue
      const s = fit(c.label, target)
      if (s >= 0.6 && (!best || s > best.s)) best = { url: c.href, label: c.label, s }
    }
  }
  return best ? { url: best.url, label: best.label } : null
}

/**
 * The controls on one page that a step worded as an action means: tabs and buttons whose names fit the words;
 * when the words ask for "the different options" and none is named, the page's tabs, else its option-like buttons.
 * Nothing that writes data is ever picked.
 */
export function onPageActions(target: string, page: AppPage, gate?: PolicyGate): { picks: OnPagePick[]; found: string[] } {
  const cands: OnPagePick[] = []
  const seen = new Set<string>()
  const add = (label: string, selector: string, via: OnPagePick['via']) => {
    const k = lower(label)
    if (!selector || !label || label.length > 40 || seen.has(k) || !mayClick(label, gate)) return
    seen.add(k)
    cands.push({ label, selector, via })
  }
  for (const s of ofKind(page, 'tab')) add(s.label, s.selector, 'tab')
  for (const c of page.controls) if (c.kind === 'button') add(c.label, c.selector, 'button')
  const found = [...cands.map((c) => c.label), ...page.fields.filter((f) => /select/.test(f.inputType)).map((f) => `dropdown "${f.label || f.name}"`)].slice(0, 16)
  const named = cands.filter((c) => fit(c.label, target) >= 0.5)
  if (named.length && !(MANY_WORDS.test(target) && named.length < 2 && cands.filter((c) => c.via === 'tab').length >= 2)) return { picks: named.slice(0, 6), found }
  if (!MANY_WORDS.test(target) && !wordsIn(target).some((w) => OPTION_WORDS.has(w) || OPTION_WORDS.has(w + 's'))) return { picks: [], found }
  const tabs = cands.filter((c) => c.via === 'tab')
  if (tabs.length >= 2) return { picks: tabs.slice(0, 6), found }
  // buttons that read like options of one group: short names, not navigation or generic chrome
  const chrome = /^(menu|close|back|next|previous|help|settings|login|log in|sign in|sign up|cancel|ok|accept|decline|search|more|share|copy|download|upload)$/i
  const opts = cands.filter((c) => c.via === 'button' && !chrome.test(c.label) && c.label.length <= 24)
  return { picks: opts.length >= 2 ? opts.slice(0, 6) : [], found }
}

function ofKind(page: AppPage, kind: Section['kind']): Section[] {
  return (page.sections ?? []).filter((s) => s.kind === kind)
}

/** headings from the scout, for pages scouted before `sections` existed */
function fallbackSections(page: AppPage): Section[] {
  return page.headings.slice(1).map((h, i) => ({ label: h, selector: '', kind: 'section' as const, y: i }))
}

function mayClick(label: string, gate?: PolicyGate): boolean {
  if (WRITE_WORDS.test(label)) return false
  if (!gate) return true
  return gate.checkClick({ label, kind: 'button', intent: 'inspect' }).allow
}

function lookForHits(sec: Section, lookFor: string[]): number {
  const hay = lower(`${sec.label} ${sec.text ?? ''}`)
  return lookFor.filter((w) => lower(w).split(/\s+/).filter((t) => t.length > 2).every((t) => hay.includes(t))).length
}

export function planSegment(seg: PageSegment, page: AppPage, opts: ActOptions): ActPlan {
  const steps: Step[] = []
  const beats: BeatFacts[] = []
  const planned: ActPlan['planned'] = []
  const notes: string[] = []
  let n = 0
  let beat = opts.startBeat
  const id = () => `${opts.idPrefix}${++n}`
  const lookFor = seg.lookFor ?? []
  const explain = seg.explain ?? []
  const url = seg.url ?? page.url
  const pageName = page.headings[0] || page.title || pathOf(url)

  const explainFacts = explain.length ? [`The person asked the film to get this across: ${explain.join('; ')}`] : []
  const textFact = (t?: string) => (t ? [`On screen: ${short(t, 400)}`] : [])

  // 1) always: open the page
  const path = pathOf(url)
  steps.push({ id: id(), beat, kind: 'goto', url, intent: 'navigate', expect: path === '/' ? undefined : { urlIncludes: path } })

  const openFacts = [
    `This is ${pageName}${page.title && page.title !== pageName ? ` (${page.title})` : ''}`,
    ...(seg.target ? [`The person called it "${seg.target}"`] : []),
    ...explainFacts,
    ...(seg.how === 'glance' || seg.how === 'script' ? textFact(page.text) : []),
    ...(page.headings.length > 1 ? [`Headings: ${page.headings.slice(0, 6).join('; ')}`] : [])
  ]
  const openLine = explain.length ? `${pageName}. ${explain[0]}.` : `Here is ${pageName}.`

  const openBeat = (hold: number): void => {
    steps.push({ id: id(), beat, kind: 'wait', holdMs: hold })
    beats.push({ beat, kind: 'page', chapter: short(pageName, 32), facts: openFacts, fallback: openLine, long: explain.length > 0 || undefined })
    beat++
  }

  const sectionBeat = (sec: Section, stepKind: 'section' | 'stage' | 'feature', index: number, total: number, click?: Step): void => {
    if (click) steps.push({ ...click, id: id(), beat })
    const rid = id()
    steps.push({ id: rid, beat, kind: 'reveal', selector: sec.selector || undefined, label: sec.label, holdMs: SECTION_HOLD[seg.emphasis], focus: 'target', find: sec.selector ? undefined : { target: sec.label, kind: 'scroll' } })
    planned.push({ stepId: rid, label: sec.label })
    const facts = [stepKind === 'stage' ? `Stage ${index + 1} of ${total}: ${sec.label}` : `Section: ${sec.label}`, ...textFact(sec.text), ...(index === 0 ? explainFacts : [])]
    const fallback = stepKind === 'stage' ? `${index === 0 ? 'It starts with' : index === total - 1 ? 'And it ends with' : 'Then comes'} ${sec.label}.` : `${index === 0 ? 'First' : 'Next'}, ${sec.label}.`
    beats.push({ beat, kind: stepKind === 'stage' ? 'step' : 'page', chapter: short(sec.label, 32), facts, fallback, long: (index === 0 && explain.length > 0) || undefined })
    beat++
  }

  // a click that only reveals more (tab, expander): allowed only when the gate agrees and the label does not write data
  const clickFor = (sec: Section): Step | undefined => {
    if (!(sec.kind === 'tab' || sec.expandable)) return undefined
    if (!sec.selector || !mayClick(sec.label, opts.gate)) {
      notes.push(`"${sec.label}" is shown without opening it`)
      return undefined
    }
    return { id: '', beat: 0, kind: 'click', selector: sec.selector, label: sec.label, intent: 'inspect', focus: 'target' }
  }

  if (opts.onPage) {
    // a step worded as an action: the page is opened, then each control that fits is used, one beat each, in page order
    const goal = opts.onPage.goal
    openBeat(HOLD.brief)
    opts.onPage.picks.forEach((p, i) => {
      steps.push({ id: id(), beat, kind: 'click', selector: p.selector, label: p.label, intent: 'inspect', focus: 'target', find: { target: p.label, kind: 'click', ...(p.via === 'tab' ? { role: 'tab' as const } : {}) } })
      steps.push({ id: id(), beat, kind: 'wait', holdMs: SECTION_HOLD[seg.emphasis] + 600, focus: 'page' })
      beats.push({
        beat, kind: 'page', chapter: short(p.label, 32),
        facts: [`The person asked to: ${goal}`, `Option ${i + 1} of ${opts.onPage!.picks.length}: ${p.label}`, ...(i === 0 ? explainFacts : [])],
        fallback: `${i === 0 ? 'First' : 'Next'}, ${p.label}.`
      })
      planned.push({ stepId: steps[steps.length - 2].id, label: p.label })
      beat++
    })
    notes.push(`"${goal}" was done on the page itself: ${opts.onPage.picks.map((p) => p.label).join(', ')}`)
    return { steps, beats, planned, notes }
  }

  switch (seg.how) {
    case 'glance':
    case 'script': {
      if (seg.how === 'script') notes.push('exact actions are run by the typed-step engine; this opens the page and holds')
      openBeat(HOLD[seg.emphasis])
      break
    }
    case 'tour': {
      openBeat(HOLD.brief)
      let secs = ofKind(page, 'section')
      if (!secs.length) secs = fallbackSections(page)
      secs = secs.filter((s) => lower(s.label) !== lower(pageName))
      const cap = Math.min(MAX_TOUR[seg.emphasis], opts.maxParts ?? Infinity)
      if (secs.length > cap) notes.push(`the page has ${secs.length} sections; ${cap} are shown`)
      // keep page order, but make sure what the person named is among those kept
      const keep = new Set(
        secs
          .map((s, i) => ({ i, hit: lookForHits(s, lookFor) }))
          .sort((a, b) => b.hit - a.hit || a.i - b.i)
          .slice(0, cap)
          .map((x) => x.i)
      )
      const chosen = secs.filter((_, i) => keep.has(i))
      if (!chosen.length) notes.push('no separate sections were found, so the page is held as a whole')
      chosen.forEach((s, i) => sectionBeat(s, 'section', i, chosen.length))
      break
    }
    case 'steps': {
      openBeat(HOLD.brief)
      let stages = ofKind(page, 'stage')
      if (stages.length < 2) {
        // no stepper: numbered or "Step N" headings, else the sections in order
        const numbered = ofKind(page, 'section').filter((s) => /^(step|stage|phase)?\s*\d+[.):\s]/i.test(s.label))
        stages = numbered.length >= 2 ? numbered : []
      }
      if (stages.length < 2) {
        notes.push('no stages were found on the page, so its sections are walked through in order instead')
        stages = ofKind(page, 'section').filter((s) => lower(s.label) !== lower(pageName)).slice(0, MAX_TOUR[seg.emphasis])
      }
      stages = stages.slice(0, 12)
      // too many stages for the film's length: the first, the last and evenly spread ones between, in order
      const room = Math.max(2, opts.maxParts ?? stages.length)
      const all = stages.length
      if (all > room) {
        const pick = new Set(Array.from({ length: room }, (_, k) => Math.round((k * (all - 1)) / (room - 1))))
        stages = stages.filter((_, i) => pick.has(i))
        notes.push(`${room} of the ${all} stages are shown, so the film keeps to its length`)
      }
      stages.forEach((s, i) => sectionBeat(s, 'stage', i, stages.length, clickFor(s)))
      break
    }
    case 'features': {
      openBeat(HOLD.brief)
      const pool = [...ofKind(page, 'tab'), ...ofKind(page, 'card'), ...ofKind(page, 'section').filter((s) => lower(s.label) !== lower(pageName))]
      const seen = new Set<string>()
      const distinct = pool.filter((s) => {
        if (seen.has(lower(s.label))) return false
        seen.add(lower(s.label))
        return true
      })
      const cap = Math.min(MAX_FEATURES[seg.emphasis], Math.max(1, opts.maxParts ?? Infinity))
      const named = distinct.filter((s) => lookForHits(s, lookFor) > 0)
      const rest = distinct.filter((s) => lookForHits(s, lookFor) === 0)
      const missing = lookFor.filter((w) => !named.some((s) => lookForHits(s, [w]) > 0))
      if (missing.length) notes.push(`could not find on the page: ${missing.join(', ')}`)
      const chosen = [...named, ...rest].slice(0, cap)
      chosen.sort((a, b) => distinct.indexOf(a) - distinct.indexOf(b))
      if (distinct.length < 3) notes.push(`only ${distinct.length} distinct feature${distinct.length === 1 ? '' : 's'} found on the page`)
      else if (distinct.length > chosen.length && opts.maxParts !== undefined && chosen.length >= opts.maxParts) notes.push(`${chosen.length} of the ${distinct.length} features are shown, so the film keeps to its length`)
      chosen.forEach((s, i) => sectionBeat(s, 'feature', i, chosen.length, clickFor(s)))
      break
    }
  }
  return { steps, beats, planned, notes }
}

// ------------------------------------------------------------------ opening the page

export interface ScoutResult {
  ok: boolean
  page?: AppPage
  /** plain words: blocked host, sign-in wall, 404, redirected elsewhere */
  why?: string
  /** the step was an action on this page, not a link: what to do there */
  onPage?: OnPageAction
}

export interface ScoutOptions {
  /** folder for the scout's own screenshot */
  outDir: string
  name: string
  /** pages already scouted, to find a link for a `target` named in words */
  known?: AppPage[]
  /** the app's start address, used when a target must be looked for */
  startUrl?: string
}

const SIGN_IN_PATH = /(^|\/)(log-?in|sign-?in|sign-?on|auth|session|sso)(\/|$|\.)/i

/** opens the segment's page in the live browser and reads it; never types or clicks */
export async function scoutSegment(page: Page, seg: PageSegment, gate: PolicyGate, o: ScoutOptions): Promise<ScoutResult> {
  let url = seg.url
  if (!url) {
    if (!seg.target) return { ok: false, why: 'the segment names neither an address nor a page' }
    let link = findLinkFor(seg.target, o.known ?? [])
    let here: AppPage | undefined
    if (!link && o.startUrl) {
      if (!gate.hostAllowed(o.startUrl)) return { ok: false, why: `${hostOf(o.startUrl)} is not one of the allowed sites` }
      await page.goto(o.startUrl, { waitUntil: 'load', timeout: 20000 }).catch(() => undefined)
      here = await scoutPage(page, o.outDir, `${o.name}-home`)
      link = findLinkFor(seg.target, [here])
    }
    // looser, still by words: a link whose name only partly fits
    link ??= findControlFor(seg.target, [...(o.known ?? []), ...(here ? [here] : [])])
    if (!link) {
      // not a link's name: the step is something to do. It is done on the page the film is on (the start page when none yet).
      const base = o.known?.find((p) => p.url === page.url()) ?? here ?? o.known?.[0]
      if (!base) return { ok: false, why: `no link called "${seg.target}" was found in the app` }
      const { picks, found } = onPageActions(seg.target, base, gate)
      if (!picks.length) {
        return { ok: false, page: base, why: `"${seg.target}" is not a link, and no control on ${base.url} fits it. I looked for a link, tab or button with those words${found.length ? `; the page's controls are: ${found.join(', ')}` : '; the page showed no tabs, buttons or dropdowns'}` }
      }
      // the page is left as it was found: planSegment writes the open and the clicks, the recorder runs them behind the gate
      return { ok: true, page: base, onPage: { goal: seg.target, picks } }
    }
    url = link.url
  }
  if (!gate.hostAllowed(url)) return { ok: false, why: `${hostOf(url)} is not one of the allowed sites` }
  let status = 0
  try {
    const res = await page.goto(url, { waitUntil: 'load', timeout: 20000 })
    status = res?.status() ?? 0
  } catch (err) {
    const msg = (err as Error).message
    if (!/timeout/i.test(msg)) return { ok: false, why: `the page would not open (${msg.split('\n')[0].slice(0, 120)})` }
  }
  const reached = page.url()
  if (!gate.hostAllowed(reached)) return { ok: false, why: `the page sent the browser to ${hostOf(reached)}, which is not an allowed site` }
  if (status === 404 || status === 410) return { ok: false, why: 'the page does not exist (404)' }
  if (status >= 500) return { ok: false, why: `the site had an error opening it (${status})` }
  const scouted = await scoutPage(page, o.outDir, o.name)
  const wantPath = pathOf(url)
  const gotPath = pathOf(reached)
  const sameHost = hostOf(url).replace(/^www\./, '') === hostOf(reached).replace(/^www\./, '')
  if (wantPath !== gotPath || !sameHost) {
    if (scouted.fields.some((f) => f.kind === 'password') || (SIGN_IN_PATH.test(gotPath) && !SIGN_IN_PATH.test(wantPath))) return { ok: false, page: scouted, why: 'the page is behind a sign-in wall' }
    return { ok: false, page: scouted, why: `the address redirected elsewhere (to ${gotPath})` }
  }
  if (status === 401 || status === 403) return { ok: false, page: scouted, why: 'the page is behind a sign-in wall' }
  if (/\b(404|not found)\b/i.test(`${scouted.title} ${scouted.headings[0] ?? ''}`)) return { ok: false, page: scouted, why: 'the page says it was not found (404)' }
  return { ok: true, page: scouted }
}
