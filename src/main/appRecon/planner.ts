import type { AppMap, AppPage, Playbook, Step } from '@shared/appRecon'
import { PlaybookSchemaCheck } from './schemaCheck'
import { scrubText } from './detect'
import { readUseCase } from './directives'
import type { ExploredStep, Exploration, Interaction, Visit } from './explore'

/**
 * The planner: chooses what the video shows.
 *
 * Exploring everything does not mean recording everything. From what the
 * explorer found, this picks the few beats (4 to 8) that best answer what the
 * person asked for, in the order a viewer should meet them, and turns them
 * into a playbook that can be replayed the same way every time. It is
 * deterministic; an AI writer can improve the wording afterwards, never the
 * steps.
 */

export type BeatKind = 'login-open' | 'login-user' | 'login-pass' | 'login-submit' | 'login' | 'page' | 'result' | 'detail' | 'logout' | 'step'

export interface BeatFacts {
  beat: number
  kind: BeatKind
  /** a short label (2 to 4 words) */
  chapter: string
  /** what is on screen, in plain words, scrubbed of private data: all a writer model is told */
  facts: string[]
  /** the line used when no writer is available (walkthrough tone) */
  fallback: string
  /** the same, in the tone of a launch film */
  launchFallback?: string
  /** the person asked for this to be explained: the line may be longer and must draw on the facts */
  long?: boolean
}

export interface PlanInput {
  map: AppMap
  exploration: Exploration
  /** what the person asked the video to show (typed text plus any attached document, already read) */
  context: string
  startUrl: string
  targetSec?: number
  /** a saved login is available, so the recording can sign in on camera */
  hasVault: boolean
  /** values that must never appear in what a writer sees */
  secrets: string[]
  /** the person wrote the steps themselves: show those pages, and only those */
  scripted?: boolean
}

export interface Plan {
  playbook: Playbook
  beats: BeatFacts[]
  loginFocus: boolean
  /** why pages were left out, for the review */
  notes: string[]
}

const STOP = new Set(['video', 'make', 'create', 'show', 'with', 'that', 'this', 'from', 'about', 'focus', 'focused', 'around', 'topic', 'please', 'want', 'need', 'the', 'and', 'for', 'app', 'flow'])

export const LOGIN_FOCUS = /\b(log\s?-?in|sign\s?-?in|sign\s?-?on|authenticat\w*|secure access|credentials?|access control)\b/i
const WRITE_INTENT = /\b(create|add|new|submit|save|register|book|order|upload)\b/i

const LOGIN_LINES = {
  walk: [
    'Every secured application starts at the sign-in page. Let us walk through how signing in works, one step at a time.',
    'First, type your username. This tells the application which account you are asking to open.',
    'Next comes the password. Notice it is blurred here on purpose, because secrets should never appear on screen.',
    'Press the sign-in button. The application checks your details and, if they match, lets you into the secure area.',
    'When you are finished, always sign out. That ends your session and returns you safely to the sign-in page.'
  ],
  launch: [
    'It all starts on one clean page. Nothing to hunt for, nothing to learn.',
    'Type your username, and the app knows exactly whose account to open.',
    'Your password stays hidden as you type, so nobody can read it over your shoulder.',
    'One click on sign in, and you are through to your secure area.',
    'And when you are done, signing out ends your session cleanly.'
  ]
}

const words = (s: string): string[] => s.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? []
const list = (xs: string[]): string => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)
const titleCase = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase())

function chapterOf(p: AppPage, n: number, secrets: string[]): string {
  const raw = scrubText(p.headings[0] || p.title || '', { values: secrets }).replace(/[^\p{L}\p{N} '&-]/gu, ' ').replace(/\s+/g, ' ').trim()
  const w = raw.split(' ').filter(Boolean).slice(0, 4)
  return w.length ? titleCase(w.join(' ')) : `Page ${n}`
}

/** how much a page is worth showing: relevance to the request first, then how much there is to see */
export function scoreVisit(v: Visit, keywords: Set<string>, writeIntent: boolean): number {
  const p = v.page
  const text = words([p.title, ...p.headings, ...p.controls.map((c) => c.label), v.fromLabel ?? ''].join(' '))
  const hits = text.filter((w) => keywords.has(w)).length
  const changed = v.interactions.filter((i) => i.changed && (writeIntent || !i.writes)).length
  const writes = v.interactions.some((i) => i.writes && !writeIntent)
  return hits * 4 + Math.min(p.fields.length, 6) * 0.6 + Math.min(p.controls.length, 10) * 0.25 + changed * 2.5 + (v.index === 0 ? 1.5 : 0) - (writes ? 5 : 0)
}

function factsFor(v: Visit, secrets: string[]): string[] {
  const s = (t: string) => scrubText(t, { values: secrets })
  const p = v.page
  const out = [`Page title: ${s(p.title)}`]
  if (p.headings.length) out.push(`Headings: ${p.headings.slice(0, 4).map(s).join('; ')}`)
  const links = p.controls.filter((c) => c.kind === 'link' && c.label).slice(0, 5).map((c) => s(c.label))
  if (links.length) out.push(`Links: ${links.join(', ')}`)
  const buttons = p.controls.filter((c) => c.kind === 'button' && c.label).slice(0, 4).map((c) => s(c.label))
  if (buttons.length) out.push(`Buttons: ${buttons.join(', ')}`)
  const fields = p.fields.filter((f) => !f.sensitive && f.label).slice(0, 4).map((f) => s(f.label))
  if (fields.length) out.push(`Fields: ${fields.join(', ')}`)
  if (p.text) out.push(`On screen: ${s(p.text).slice(0, 600)}`)
  for (const i of v.interactions.filter((x) => x.asked && x.steps.some((t) => t.kind === 'type')).slice(0, 2)) {
    const t = i.steps.find((x) => x.kind === 'type')!
    out.push(`The person types "${t.text}" into the ${s(t.label || 'search')} box${i.changed ? ' and the page updates to show only matching results' : ''}`)
    if (i.after?.text) out.push(`After typing, the page shows: ${s(i.after.text).slice(0, 600)}`)
  }
  for (const i of v.interactions.filter((x) => x.changed && !x.writes && !x.asked).slice(0, 1)) {
    out.push(`Doing "${i.steps.map((t) => t.label || t.text || t.kind).join(' then ')}" changes what the page shows`)
  }
  return out
}

/** the labels a graph or chart draws on itself, from the text the scout read */
function drawnLabels(text: string | undefined): string[] {
  const m = /Labels drawn on the page: (.*)$/s.exec(text ?? '')
  return m ? m[1].split(', ').map((s) => s.trim()).filter(Boolean) : []
}

/** the beat that shows what a typed step produced: the person's goal, and what the page shows now */
function resultBeat(i: Interaction, goal: string, secrets: string[], beat: number): BeatFacts {
  const s = (t: string) => scrubText(t, { values: secrets })
  const typed = i.steps.find((t) => t.kind === 'type')
  const what = typed?.text ?? ''
  const facts: string[] = [`The page has finished updating after "${s(what)}" was typed, and the result is on screen`]
  if (goal) facts.push(`What the person wants this video to get across, in their words: ${s(goal).slice(0, 400)}`)
  if (i.after?.text) facts.push(`The page now shows: ${s(i.after.text).slice(0, 700)}`)
  if (i.after?.headings.length) facts.push(`Headings now: ${i.after.headings.slice(0, 4).map(s).join('; ')}`)
  const labels = drawnLabels(i.after?.text).filter((l) => l.toLowerCase() !== what.toLowerCase()).slice(0, 3)
  const shows = labels.length ? ` Among what is shown: ${list(labels.map(s))}.` : ''
  const line = `With ${what ? `"${s(what)}"` : 'that'} entered, the view narrows to what matches.${shows} Take a moment to look at the result.`
  return { beat, kind: 'result', chapter: 'The result', facts, fallback: line, launchFallback: `Type ${what ? `"${s(what)}"` : 'it in'}, and the view narrows to just what you asked for.${shows}` }
}

/** the beat for the thing opened to make the point */
function detailBeat(i: Interaction, goal: string, secrets: string[], beat: number): BeatFacts {
  const s = (t: string) => scrubText(t, { values: secrets })
  const name = s(i.followed ?? 'one of the results')
  const facts: string[] = [`The person opens "${name}" from the results to look closer`]
  if (goal) facts.push(`What the person wants this video to get across, in their words: ${s(goal).slice(0, 400)}`)
  if (i.after?.title) facts.push(`Page title: ${s(i.after.title)}`)
  if (i.after?.headings.length) facts.push(`Headings: ${i.after.headings.slice(0, 4).map(s).join('; ')}`)
  if (i.after?.text) facts.push(`On screen: ${s(i.after.text).slice(0, 700)}`)
  return { beat, kind: 'detail', chapter: titleCase(name.replace(/[^\p{L}\p{N} '&-]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 4).join(' ')) || 'A closer look', facts, fallback: `Opening ${name} gives a closer look at it.`, launchFallback: `One click on ${name}, and the detail is right there.` }
}

const OPENERS =[(c: string) => `Next, ${c}.`, (c: string) => `Now the ${c} page.`, (c: string) => `Here is ${c}.`, (c: string) => `Then, ${c}.`]
/** links that only lead back to where the viewer has been */
const BACK_LINK = /^(home|back|dashboard|overview|main|menu|logo)$/i

/** the stock line for a page: only what is on the page, in varied plain words */
function pageLine(v: Visit, chapter: string, first: boolean, secrets: string[], position: number): string {
  const s = (t: string) => scrubText(t, { values: secrets })
  const p = v.page
  const heads = p.headings.slice(1, 3).map(s).filter((h) => h.length < 60 && h.toLowerCase() !== chapter.toLowerCase())
  const links = [...new Set(p.controls.filter((c) => c.kind === 'link' && c.label).map((c) => s(c.label)))]
    .filter((l) => l.length < 30 && !BACK_LINK.test(l.trim()) && l.toLowerCase() !== chapter.toLowerCase())
    .slice(0, 3)
  const fields = [...new Set(p.fields.filter((f) => !f.sensitive && f.label).map((f) => s(f.label)))].filter((f) => f.length < 30).slice(0, 3)
  const parts: string[] = [first ? `After signing in you arrive at ${chapter}.` : OPENERS[position % OPENERS.length](chapter)]
  if (heads.length) parts.push(`It covers ${list(heads)}.`)
  if (fields.length) parts.push(`There is room to fill in ${list(fields)}.`)
  const ch = v.interactions.find((i) => i.asked) ?? v.interactions.find((i) => i.changed && !i.writes)
  if (ch) {
    const typed = ch.steps.find((t) => t.kind === 'type')
    parts.push(typed ? `Typing in the ${s(typed.label || 'search')} box updates what the page shows.` : `Pressing ${s(ch.steps[0]?.label || 'a button')} updates what the page shows.`)
  }
  if (links.length >= 2 && (first || parts.length < 3)) parts.push(`From here you can reach ${list(links)}.`)
  if (parts.length === 1) parts.push('Take a moment to look around it.')
  return parts.join(' ')
}

export function planBeats(inp: PlanInput): Plan {
  const { map, exploration, context } = inp
  const notes: string[] = []
  const loginFocus = !inp.scripted && LOGIN_FOCUS.test(context)
  const keywords = new Set(words(context))
  const goal = readUseCase(context).goal
  const writeIntent = WRITE_INTENT.test(context)
  const maxBeats = Math.max(4, Math.min(8, Math.round((inp.targetSec ?? 44) / 7)))

  const steps: Step[] = []
  const beats: BeatFacts[] = []
  let sid = 0
  const id = () => `s${++sid}`
  const L = map.login
  const signIn = inp.hasVault && L.detected && !!L.usernameSelector && !!L.passwordSelector && !!L.submitSelector
  const loginUrl = L.pageUrl ?? inp.startUrl
  let beat = 0

  if (signIn) {
    if (loginFocus) {
      // the proof's flow: open, username, password, press the button
      steps.push({ id: id(), beat, kind: 'goto', url: loginUrl, selector: L.usernameSelector, intent: 'navigate', focus: 'form' })
      beats.push({ beat, kind: 'login-open', chapter: 'Sign-in page opens', facts: ['The sign-in page opens'], fallback: LOGIN_LINES.walk[0], launchFallback: LOGIN_LINES.launch[0] })
      beat++
      steps.push({ id: id(), beat, kind: 'type', selector: L.usernameSelector, label: 'username', text: '{{secret:username}}', focus: 'target' })
      beats.push({ beat, kind: 'login-user', chapter: 'Username', facts: ['The username is typed into the first box'], fallback: LOGIN_LINES.walk[1], launchFallback: LOGIN_LINES.launch[1] })
      beat++
      steps.push({ id: id(), beat, kind: 'type', selector: L.passwordSelector, label: 'password', text: '{{secret:password}}', focus: 'target' })
      beats.push({ beat, kind: 'login-pass', chapter: 'Password, protected', facts: ['The password is typed into the second box and is blurred'], fallback: LOGIN_LINES.walk[2], launchFallback: LOGIN_LINES.launch[2] })
      beat++
      steps.push({ id: id(), beat, kind: 'click', selector: L.submitSelector, label: L.submitLabel, intent: 'login-submit', expect: { selectorGone: L.passwordSelector }, focus: 'banner' })
      beats.push({ beat, kind: 'login-submit', chapter: 'Access confirmed', facts: ['The sign-in button is pressed and the app lets the person in'], fallback: LOGIN_LINES.walk[3], launchFallback: LOGIN_LINES.launch[3] })
      beat++
    } else {
      steps.push({ id: id(), beat, kind: 'goto', url: loginUrl, selector: L.usernameSelector, intent: 'navigate', focus: 'form' })
      steps.push({ id: id(), beat, kind: 'type', selector: L.usernameSelector, label: 'username', text: '{{secret:username}}', focus: 'target' })
      steps.push({ id: id(), beat, kind: 'type', selector: L.passwordSelector, label: 'password', text: '{{secret:password}}', focus: 'target' })
      steps.push({ id: id(), beat, kind: 'click', selector: L.submitSelector, label: L.submitLabel, intent: 'login-submit', expect: { selectorGone: L.passwordSelector }, focus: 'banner' })
      beats.push({
        beat, kind: 'login', chapter: 'Signing in', facts: ['The person signs in with a username and a blurred password'],
        fallback: 'First we sign in. The password is blurred on screen, because secrets should never be shown.',
        launchFallback: 'Sign in with your account to get started. Your password stays hidden.'
      })
      beat++
    }
  }

  // pages worth showing
  const candidates = exploration.visits
  const reserved = signIn && loginFocus ? 1 : 0 // the sign-out beat
  const room = Math.max(0, maxBeats - beat - reserved)
  const scored = candidates.map((v) => ({ v, score: scoreVisit(v, keywords, writeIntent) }))
  const chosen = [...scored].sort((a, b) => b.score - a.score).slice(0, room).sort((a, b) => a.v.index - b.v.index)
  // after a login-focused sign-in only the landing page adds anything
  const asked = (v: Visit) => !!v.asked || v.interactions.some((i) => i.asked)
  const picked = inp.scripted && candidates.some(asked)
    // what the person typed is shown in full: the cap on beats does not apply to it, so nothing they asked for is cut
    ? scored.filter((c) => asked(c.v)).slice(0, 6)
    : signIn && loginFocus ? chosen.filter((c) => c.v.index === 0).slice(0, Math.min(room, 1)) : chosen
  if (candidates.length > picked.length) notes.push(`${candidates.length - picked.length} explored page(s) left out to keep the video short`)

  let first = true
  for (const { v } of picked) {
    const chapter = chapterOf(v.page, v.index + 1, inp.secrets)
    const justArrived = signIn && v.index === 0
    if (!justArrived) steps.push({ id: id(), beat, kind: 'goto', url: v.page.url, intent: 'navigate', focus: 'page' })
    const doneAsked = v.interactions.filter((i) => i.asked)
    const act = doneAsked.length ? undefined : v.interactions.find((i) => i.changed && (writeIntent || !i.writes))
    for (const i of doneAsked) for (const e of i.steps) steps.push(toStep(e, id(), beat))
    if (act) for (const e of act.steps) steps.push(toStep(e, id(), beat))
    if (!steps.some((s) => s.beat === beat)) steps.push({ id: id(), beat, kind: 'wait', focus: 'page' })
    beats.push({ beat, kind: 'page', chapter, facts: factsFor(v, inp.secrets), fallback: pageLine(v, chapter, first && signIn, inp.secrets, beats.length) })
    first = false
    beat++
    // the extra mile: a typed step is followed by a beat that lets its result be seen, and by what was opened to make the point
    const typedAsk = doneAsked.find((i) => i.steps.some((t) => t.kind === 'type'))
    if (typedAsk) {
      steps.push({ id: id(), beat, kind: 'wait', intent: 'inspect', label: 'result', focus: 'page' })
      beats.push(resultBeat(typedAsk, goal, inp.secrets, beat))
      beat++
      for (const f of v.interactions.filter((i) => i.followed && i.steps.length).slice(0, 2)) {
        for (const e of f.steps) steps.push(toStep(e, id(), beat))
        steps.push({ id: id(), beat, kind: 'wait', intent: 'inspect', label: 'opened', focus: 'page' })
        beats.push(detailBeat(f, goal, inp.secrets, beat))
        beat++
      }
    }
  }

  // sign out, when the video is about signing in and out
  if (signIn && loginFocus) {
    const out = candidates.flatMap((v) => v.page.controls).find((c) => /log\s?-?out|sign\s?-?out/i.test(c.label))
    if (out) {
      steps.push({ id: id(), beat, kind: 'click', selector: out.selector, label: out.label, intent: 'logout', expect: L.passwordSelector ? { selectorVisible: L.passwordSelector } : undefined, focus: 'banner' })
      beats.push({ beat, kind: 'logout', chapter: 'Sign out safely', facts: ['The person signs out and the session ends'], fallback: LOGIN_LINES.walk[4], launchFallback: LOGIN_LINES.launch[4] })
      beat++
    } else notes.push('No sign-out control was found, so the video ends after signing in')
  }

  if (!steps.length) {
    steps.push({ id: id(), beat: 0, kind: 'goto', url: inp.startUrl, intent: 'navigate', focus: 'page' })
    beats.push({ beat: 0, kind: 'page', chapter: 'Opening page', facts: ['The app opens'], fallback: 'This is where the app opens.' })
    notes.push('Nothing could be explored, so the video shows only the opening page')
  }

  const playbook: Playbook = { version: 1, title: loginFocus ? 'Sign-in and sign-out' : `Tour of ${map.host}`, startUrl: signIn ? loginUrl : (candidates[0]?.page.url ?? inp.startUrl), steps }
  PlaybookSchemaCheck(playbook)
  return { playbook, beats, loginFocus, notes }
}

/** what the review screen shows for a plan: the beats and the words that will be said */
export function reviewBeats(plan: Plan, launch: boolean): Array<{ beat: number; kind: string; chapter: string; text: string; removable: boolean }> {
  return plan.beats.map((b) => ({ beat: b.beat, kind: b.kind, chapter: b.chapter, text: launch && b.launchFallback ? b.launchFallback : b.fallback, removable: b.kind === 'page' || b.kind === 'result' || b.kind === 'detail' }))
}

/**
 * Apply what a person changed in the review: drop some pages and reword
 * lines. A sign-in or sign-out beat cannot be dropped (the recording would
 * break), and edited words still go through the narration check later.
 */
export function applyReviewEdits(plan: Plan, edits: { removeBeats: number[]; lines: Record<number, string> }): Plan {
  const drop = new Set(plan.beats.filter((b) => (b.kind === 'page' || b.kind === 'result' || b.kind === 'detail') && edits.removeBeats.includes(b.beat)).map((b) => b.beat))
  // the result and the closer look belong to the beat that typed: without it they would show a page nobody opened
  let gone = false
  for (const b of plan.beats) {
    if (b.kind === 'page') gone = drop.has(b.beat)
    else if ((b.kind === 'result' || b.kind === 'detail') && gone) drop.add(b.beat)
  }
  const beats = plan.beats
    .filter((b) => !drop.has(b.beat))
    .map((b) => {
      const text = edits.lines[b.beat]?.trim()
      return text ? { ...b, fallback: text, launchFallback: text } : b
    })
  const steps = plan.playbook.steps.filter((s) => !drop.has(s.beat))
  return { ...plan, beats, playbook: { ...plan.playbook, steps } }
}

function toStep(e: ExploredStep, id: string, beat: number): Step {
  if (e.kind === 'type') return { id, beat, kind: 'type', selector: e.selector, label: e.label, text: e.text, focus: 'target' }
  if (e.kind === 'press') return { id, beat, kind: 'press', text: e.text, focus: 'page' }
  return { id, beat, kind: 'click', selector: e.selector, label: e.label, focus: 'target' }
}
