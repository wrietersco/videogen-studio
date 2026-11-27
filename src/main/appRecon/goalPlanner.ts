import type { Page } from 'puppeteer-core'
import type { AppPage } from '@shared/appRecon'
import type { FilmPlan, PageSegment } from '@shared/agentBrief'
import type { LLMProvider } from '../providers/types'
import { scrubText } from './detect'
import type { PolicyGate } from './policy'
import { performScript, type ItemResult, type ScriptInput, type ScriptOutcome, type VisionPick } from './script'
import type { Atom, ScriptItem, StepScript } from './stepScript'
import { buildAtom, bestSection, BASE_ACTIONS, describeAtom, tokens, type Capable, type ModelAction, type Rails } from './goalGuard'
import { diffStudy, renderStudy, screenshotForModel, studyPage, type PageStudy, type StudyControl } from './goalStudy'

/**
 * Goal-to-steps planning.
 *
 * Some steps a person writes are not actions but goals: "explain the Regional distribution section and give live examples",
 * "find a gift under £50 for a runner and put it in the cart", "walk through what happens when a task is overdue". Nothing in
 * them says what to click. This turns such a goal into real actions on the real page, the way a person would demo it:
 *
 *   study   the page as an outline (headings, controls with their state, the data in cards and rows) and a picture of it
 *   plan    a model names the part of the app the goal is about and the next few actions, each with a plain reason
 *   guard   every action must name something really on the page, stay in the goal's part of the app, and pass the person's rules
 *   act     the actions are performed by the same engine that performs a typed list of steps (atoms in, steps to record out)
 *   look    the page is studied again (what appeared, what went, did the view move) and the model is shown the result
 *
 * It repeats until the goal is visibly met and at least two real live interactions were done, or a budget runs out. The run
 * never stops because of a goal: one that cannot be done is skipped with its reason, and the notes and the narration say so.
 * Without a model the same loop runs on rules (find the section by its words, exercise the first controls in it).
 */

// ------------------------------------------------------------------ what counts as a goal

/** words that make a step a goal to be worked out, not an action to be clicked */
const GOAL_CUE = new RegExp(
  [
    'demonstrat\\w*',
    'walk\\w*\\s+(?:me\\s+|us\\s+|them\\s+)?through',
    'live\\s+examples?',
    'examples?\\b',
    'difference\\s+between',
    'compar\\w+',
    'what\\s+happens',
    'how\\s+(?:a|an|the|to|it|does|do|would|can|they|you|customers?|users?|someone|people|[\\w-]+\\s+(?:handles?|works?|looks?))',
    'find\\s+(?:a|an|the|me|something|out|which|one)\\b',
    'show\\s+(?:how|what|where|which|me\\s+how|a\\s+(?:customer|user|person|visitor|team)|the\\s+difference|that\\b)',
    'put\\s+(?:it|them|that)\\s+in',
    'under\\s+[£$€]',
    'which\\s+[\\w\\s]{0,24}(?:drives?|uses?|has|costs?)',
    'step\\s+by\\s+step'
  ].map((a) => String.raw`\b(?:${a})`).join('|'),
  'i'
)
const EXPLAIN_TOPIC = /\b(section|feature|chart|table|panel|widget|tab|dashboard|form|flow|screen|tool|playground|workflow|process)\b/i
/** a step that only says something: it needs no page work */
const NARRATION_ONLY = /^(?:(?:then|and|finally|lastly|also)\s+)*(?:in\s+(?:your|my)\s+own\s+words\s+)?(?:tell|say|mention|thank|conclude|(?:end|finish|close)\s+with\b|add\s+(?:a\s+)?(?:cta|call\s+to\s+action)|provide\s+a\s+conclusion|keep\s+it|make\s+it\s+(?:sound|feel)|speak|be\s+(?:warm|quick|short|friendly)|wait|pause|hold|stay|sign\s+off)\b/i

/** is this wording a goal (something to be worked out) rather than an action or a plain statement? */
export function isGoalText(text: string): boolean {
  const t = text.trim()
  if (!t || NARRATION_ONLY.test(t)) return false
  if (GOAL_CUE.test(t)) return true
  return /\bexplain\b/i.test(t) && EXPLAIN_TOPIC.test(t)
}

/** a step the typed-step reader marked as a goal (it has no atoms and carries the person's words in `goal`) */
export function isGoalItem(item: ScriptItem): boolean {
  return !item.login && !item.atoms.length && !!item.goal
}

/** the older, wording-only reading of a step as a goal (kept for plans that are not read by the step reader) */
export function looksLikeGoalItem(item: ScriptItem): boolean {
  if (item.login) return false
  if (item.atoms.length === 0) {
    if (isGoalText(item.said)) return true
    // a clause the reader kept only as a note: long enough to be a sentence of its own, not narration or a wait
    return item.notes.length > 0 && !item.explain && item.said.trim().split(/\s+/).length >= 5 && !NARRATION_ONLY.test(item.said.trim())
  }
  // clicks whose "label" is a sentence ("click how errors are handled") are goals in disguise
  return item.atoms.every((a) => a.action === 'click' && (a.label.trim().split(/\s+/).length >= 6 || /^(?:how|what|why|which|where|when)\b/i.test(a.label.trim())))
}

const segText = (s: PageSegment): string => [s.said, ...(s.explain ?? []), s.target ?? ''].join('. ')

/** page segments of a film plan that name no address and are worded as a goal */
export function goalSegments(plan: FilmPlan): PageSegment[] {
  return plan.segments.filter((s): s is PageSegment => s.kind === 'page' && !s.url && s.how !== 'script' && isGoalText(segText(s)))
}

/**
 * The plan's pages as a list of steps to perform: an address is opened, a named link is clicked, a goal is worked out.
 * Used when at least one page of the plan is a goal (a whole brief that says what to show, not which buttons to press).
 */
export function scriptFromPlan(plan: FilmPlan, o: { asGoals?: boolean } = {}): StepScript {
  const items: ScriptItem[] = []
  let n = 0
  for (const s of plan.segments) {
    if (s.kind !== 'page') continue
    const explain = s.explain?.length ? s.explain.join(' ') : undefined
    const base = { n: ++n, login: false, notes: [] as string[], unread: [] as string[], ...(explain ? { explain } : {}) }
    if (s.url) {
      items.push({ ...base, said: `Open ${s.url}`, atoms: [{ action: 'open', label: 'Open page', url: s.url }] })
    } else if (o.asGoals || isGoalText(segText(s))) {
      items.push({ ...base, said: s.said.trim(), atoms: [], goal: s.said.trim() })
    } else if (s.target) {
      items.push({ ...base, said: `Open ${s.target}`, atoms: [{ action: 'click', label: s.target, find: { target: s.target, kind: 'click' } }] })
    }
  }
  return { items, goal: plan.goal, source: 'plan', tone: [], whenever: [] }
}

// ------------------------------------------------------------------ what the model is asked

export interface Budget {
  /** rounds of look → plan → act */
  turns: number
  /** actions performed in all */
  actions: number
  /** milliseconds for the whole goal */
  ms: number
  /** live interactions the goal should show (fewer only when the page offers fewer) */
  live: number
  /** preparation / way-finding steps allowed in all */
  support: number
  /** other pages the goal may move to */
  moves: number
}
export const DEFAULT_BUDGET: Budget = { turns: 10, actions: 14, ms: 200_000, live: 2, support: 5, moves: 3 }

/** atom kinds beyond the original ones that the engine can perform (the executor layer performs all of them; `type` with `replace`/`focused` is part of the base `type`) */
export const NEW_ATOMS_READY: ReadonlySet<string> = new Set<string>(['key', 'drag', 'dblclick', 'slider', 'date', 'scrollUntil', 'pick'])
const DEFAULT_CAPS: Capable = { newAtoms: NEW_ATOMS_READY }

interface Decision {
  example: number
  status: 'continue' | 'done' | 'impossible'
  reason: string
  sections: string[]
  actions: ModelAction[]
  source: 'model' | 'rules'
}

const SCHEMA = {
  type: 'object',
  properties: {
    sections: { type: 'array', items: { type: 'string' }, description: 'headings of the part of the app this goal is about' },
    status: { type: 'string', enum: ['continue', 'done', 'impossible'] },
    reason: { type: 'string' },
    example: { type: 'integer', description: 'which example (1, 2, 3 ...) the actions of this answer belong to; 0 when the person asked for no examples or these actions only prepare' },
    actions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          do: { type: 'string', enum: ['click', 'type', 'select', 'scrollto', 'hover', 'mark', 'key', 'slider', 'dblclick', 'scrollUntil', 'drag', 'date', 'pick'] },
          target: { type: 'string' },
          text: { type: 'string' },
          replace: { type: 'boolean' },
          near: { type: 'string' },
          relation: { type: 'string', enum: ['feature', 'prerequisite', 'navigation', 'support'] },
          colours: { type: 'array', items: { type: 'string' } },
          noun: { type: 'string' },
          why: { type: 'string' }
        },
        required: ['do', 'target', 'text', 'replace', 'near', 'relation', 'colours', 'noun', 'why'],
        additionalProperties: false
      }
    }
  },
  required: ['sections', 'status', 'reason', 'example', 'actions'],
  additionalProperties: false
}

const SYSTEM = `You direct a screen recording of a REAL web app. The person who ordered the video wrote a GOAL instead of exact clicks. Work out concrete actions on the real page that show the goal, a few at a time, and look at the page after each batch.

How to work:
1. FIND the part of the app the goal is about: a section, a feature or a flow. Use the page outline (headings in page order, controls under each heading, the data in cards/rows, charts) and the picture. If it is not on this page, look for the way there: a link, tab, menu entry or FOLDED group in the outline, or a page listed under OTHER PAGES. Never invent a control or a feature. If the app has no such feature, answer status "impossible" and say so plainly in "reason".
2. PREPARE only what the feature needs first (data not loaded yet, a folded group, being on the right page) and give the reason. A popup, survey or cookie banner in front of the page: close it with its own button (one or two tries). If it will not go away, carry on anyway and work around it (scroll so the control you need is clear of it); never answer "impossible" only because of a banner, and never stop to keep pressing its buttons. Scroll to the section ("scrollto" with its heading) before working in it.
3. SHOW IT WORKING with at least TWO different real live interactions inside the feature (choose, filter, type, press, step through, pick a data point). Choose examples from the data you can see: the largest or most telling item, a value that fits the limit the goal states (a budget, a date), the item that matches the goal's condition (the overdue one, the one with an error). Prefer examples that change what is on screen.
4. STOP: when what is on screen now visibly shows the goal met and at least two live interactions were done, answer status "done" with no actions and say in "reason" what is now visible. Never add actions after that.

Rules:
- Copy control names EXACTLY as written in the outline (target). For "scrollto" give the section heading exactly.
- If several controls share a label (same=N), say which one with "near": other text from the same card or row (the item's own name).
- Do things in the feature's own part of the app. No aimless clicking, no leaving the section unless the goal needs it ("navigation"), no settings, themes, language, terms, share, export, sign out, delete, pay or checkout unless the goal asks for it. Closing a popup that is in front of the page is always fine.
- "relation" says why the action belongs to the goal: "feature" (it is the feature itself), "prerequisite" (the feature needs it first), "navigation" (finding the way to it), "support" (a step the goal's wording asks for outside the feature, such as putting a found item in the cart). Anything that is not "feature" needs a real reason in "why".
- Do not repeat an action that already worked. If an action was refused or skipped, do not propose it again as it is; choose another control or say "impossible".
- "why" is one plain sentence for a viewer: what this shows. It must only claim what the page will really show; never state a value you have not been shown.
- Only these actions work: click, type (text = what to type; replace = true to select what is in the box and type over it, for a code editor or a field that already has a value), select (text = the option to choose), scrollto, hover, mark (text = "click" or "hover"; noun = bar/line/point/slice; colours = [the colour] or []; target = the chart's title) for drawn charts{NEW}.
- Propose only controls that are on the page NOW. An action that opens something (a dialog, a number pad, a menu, a confirm bar) ends your batch: the controls it shows are proposed in the next answer.
- Games and canvas apps: play them like a person would. Press the buttons that start, size, cut or choose; enter numbers by pressing the digit keys one at a time and then the confirm key; then confirm and look at the result before doing the next thing. A symbol is a control's name when it has no words (✓, ✔, ⌫, ✕, ＋, －).
- Give at most 3 actions per answer, in the order they must happen. Answer with JSON only.`

const EXTRA_ACTIONS: Record<string, string> = {
  key: 'key (text = the key or chord, e.g. "Control+K")',
  slider: 'slider (target = the slider, text = the value, or "min-max")',
  dblclick: 'dblclick',
  scrollUntil: 'scrollUntil (text = words that must appear)',
  drag: 'drag (target = what is picked up, text = where it is dropped, near = "before X"/"after X" when the place in the list matters)',
  date: 'date (target = the date box, text = the day as YYYY-MM-DD)',
  pick: 'pick (target = the kind of thing, e.g. card, row, product; text = which one: "second", "last", "cheapest", "highest"; near = the part of the page it is in)'
}

const systemFor = (caps: Capable): string => SYSTEM.replace('{NEW}', [...caps.newAtoms].map((k) => `, ${EXTRA_ACTIONS[k] ?? k}`).join(''))

// ------------------------------------------------------------------ one goal

export interface GoalReport {
  n: number
  said: string
  /** what the planner took the goal to be about */
  sections: string[]
  status: 'done' | 'partial' | 'unreachable' | 'stopped'
  reason: string
  /** what was performed, with the reason the planner gave, in order */
  shown: Array<{ what: string; why: string; skipped?: string }>
  /** proposals that were not carried out, with why */
  refused: string[]
  live: number
  turns: number
  modelCalls: number
  ms: number
  mode: 'model' | 'rules'
}

export interface GoalDeps {
  page: Page
  gate: PolicyGate
  chat: LLMProvider | null
  vision?: VisionPick
  log: (m: string) => void
  signal?: AbortSignal
  /** everything the person wrote for the video */
  brief: string
  secrets: string[]
  /** pages of the app already read */
  known: AppPage[]
  caps?: Capable
  budget?: Partial<Budget>
  /** what the person's other steps say, before and after this goal */
  around?: { before: string[]; after: string[] }
}

export interface GoalRun {
  items: ScriptItem[]
  results: ItemResult[]
  skipped: ScriptOutcome['skipped']
  actions: number
  report: GoalReport
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const interactive = new Set(['click', 'type', 'select', 'mark', 'hover', 'key', 'slider', 'dblclick', 'drag', 'date', 'pick'])

function otherPages(known: AppPage[], current: string): string {
  const path = (u: string): string => {
    try {
      const x = new URL(u)
      return x.pathname + x.search
    } catch {
      return u
    }
  }
  const here = path(current)
  const lines = known
    .filter((p) => path(p.url) !== here)
    .slice(0, 8)
    .map((p) => `- ${path(p.url)} "${p.title}": ${p.headings.slice(0, 6).join('; ')}`)
  return lines.length ? lines.join('\n') : '(none read)'
}

function briefContext(brief: string, goal: string, scrub: (t: string) => string): string {
  const rest = brief.replace(/\r/g, '').split('\n').filter((l) => l.trim() && !goal.includes(l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim().slice(0, 60))).join('\n')
  return scrub(rest).slice(0, 900)
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: ReturnType<typeof setTimeout> | undefined
  const out = await Promise.race([p, new Promise<null>((res) => { t = setTimeout(() => res(null), ms) })])
  if (t) clearTimeout(t)
  return out
}

function readDecision(raw: unknown): Decision | null {
  const o = raw as { status?: unknown; reason?: unknown; sections?: unknown; actions?: unknown; example?: unknown } | null
  if (!o || typeof o !== 'object') return null
  const status = o.status === 'done' || o.status === 'impossible' ? o.status : 'continue'
  const str = (v: unknown, n = 160): string => (typeof v === 'string' ? v.trim().slice(0, n) : '')
  const actions: ModelAction[] = (Array.isArray(o.actions) ? o.actions : []).slice(0, 3).flatMap((a: Record<string, unknown>) => {
    if (!a || typeof a !== 'object') return []
    return [{ do: str(a.do, 20), target: str(a.target, 100), text: str(a.text, 300), replace: a.replace === true, near: str(a.near, 80), relation: str(a.relation, 20), colours: Array.isArray(a.colours) ? a.colours.filter((c): c is string => typeof c === 'string').slice(0, 1) : [], noun: str(a.noun, 20), why: str(a.why, 200) }]
  })
  return { example: typeof o.example === 'number' && o.example > 0 ? Math.min(Math.round(o.example), 8) : 0, status, reason: str(o.reason, 400), sections: (Array.isArray(o.sections) ? o.sections : []).filter((s): s is string => typeof s === 'string').map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 4), actions, source: 'model' }
}

interface Ask {
  goal: string
  explain?: string
  brief: string
  history: string[]
  study: PageStudy
  shot: { mimeType: string; base64: string } | null
  live: number
  want: number
  /** how many distinct examples the person asked for (0: not said) */
  examples: number
  /** one small step: do exactly it and stop */
  small: boolean
  used: number
  max: number
  pushed: boolean
  known: AppPage[]
  scrub: (t: string) => string
  /** the person's steps before and after this goal */
  before: string[]
  after: string[]
}

async function askModel(chat: LLMProvider, a: Ask, caps: Capable): Promise<Decision | null> {
  const prompt = [
    `GOAL (the person's words): ${a.goal}`,
    a.explain ? `What the video must make clear: ${a.explain}` : '',
    a.small ? 'THIS GOAL IS ONE SMALL STEP of a list the person wrote. Do exactly what it says on the page, nothing more: no extra examples, no exploring. As soon as the page visibly shows it done, answer "done" with no actions.' : '',
    a.examples > 1 ? `THE PERSON ASKED FOR ${a.examples} DIFFERENT EXAMPLES. Show exactly ${a.examples} complete examples, one after another, each with different values (change more than one thing between examples, for instance both the size and the count, so no two examples share their numbers), and let each one finish with its result visible on screen before the next begins. Count them from WHAT HAS BEEN DONE SO FAR. Answer \"done\" only after example ${a.examples} shows its result. Set "example" to the number of the example each answer's actions belong to (1 to ${a.examples}); setting up a ruler, entering its length, cutting and confirming are all part of the same example.` : '',
    a.before.length ? `STEPS ALREADY DONE before this goal (do not redo them):\n${a.before.map((s) => `- ${s}`).join('\n')}` : '',
    a.after.length ? `STEPS THAT COME AFTER this goal (the person wrote them; do not do them here):\n${a.after.map((s) => `- ${s}`).join('\n')}` : '',
    a.brief ? `REST OF THE BRIEF (context only; limits like a budget or a person's role matter):\n${a.brief}` : '',
    `OTHER PAGES OF THE APP already read:\n${otherPages(a.known, a.study.url)}`,
    `WHAT HAS BEEN DONE SO FAR for this goal (${a.used}/${a.max} actions, ${a.live} live interactions; at least ${a.want} wanted):\n${a.history.length ? a.history.join('\n') : '(nothing yet)'}`,
    a.pushed ? `NOTE: you said "done" earlier with fewer than ${a.want} live interactions. Do more real examples from the data on screen; say "done" again only if the page truly offers fewer, and say so in "reason".` : '',
    'THE PAGE NOW:',
    renderStudy(a.study, { scrub: a.scrub, maxChars: 13000 }),
    'Answer with the JSON.'
  ].filter(Boolean).join('\n\n')
  const vision = chat.supportsVision?.() !== false && a.shot
  const raw = await withTimeout(
    chat.generateJSON<unknown>({
      system: systemFor(caps),
      prompt,
      schemaName: 'goal_plan',
      jsonSchema: SCHEMA,
      ...(vision && a.shot ? { images: [a.shot] } : {}),
      temperature: 0.2,
      maxTokens: 1400
    }),
    90_000
  ).catch(() => null)
  return readDecision(raw)
}

// ------------------------------------------------------------------ the free engine: the same loop on rules

const SAFE_PRESS = /\b(next|prev(?:ious)?|apply|filter|sort|view|details?|more|expand|toggle|show|compare|select|choose|open|try|run|load|sample|demo|overdue|all|preview|inspect)\b/i

/** without a model: find the section by the goal's words, then exercise the first controls in it */
function ruleDecision(goal: string, study: PageStudy, o: { sections: string[]; live: number; want: number; usedKeys: Set<string>; refused: number }): Decision {
  const words = goal.replace(/\b(explain|show|demonstrate|section|give|live|examples?|walk|through|the|and|on|dashboard|a|an|of|how|what)\b/gi, ' ')
  const sec = o.sections[0] ? { heading: o.sections[0], y: study.sections.find((s) => s.heading === o.sections[0])?.y ?? 0 } : bestSection(study, words)
  if (!sec) return { example: 0, status: 'impossible', reason: `no part of the page is called anything like what the goal names; the headings are: ${study.sections.slice(0, 8).map((s) => s.heading).join('; ') || 'none'}`, sections: [], actions: [], source: 'rules' }
  const actions: ModelAction[] = []
  if (!o.usedKeys.has(`scrollto|${sec.heading.toLowerCase()}`)) actions.push({ do: 'scrollto', target: sec.heading, relation: 'feature', why: `Bring "${sec.heading}" into view.` })
  const mine = study.controls.filter((c) => c.section === sec.heading && !c.disabled && c.kind !== 'link')
  const pool: StudyControl[] = [...mine.filter((c) => c.kind === 'tab'), ...mine.filter((c) => c.kind === 'select'), ...mine.filter((c) => c.kind === 'button' && SAFE_PRESS.test(c.label)), ...mine.filter((c) => c.kind === 'button')]
  const fresh = pool.filter((c) => !o.usedKeys.has(`click|${c.label.toLowerCase()}|`) && !o.usedKeys.has(`select|${c.label.toLowerCase()}|`))
  for (const c of fresh) {
    if (actions.length >= 3 || o.live + actions.filter((a) => a.do !== 'scrollto').length >= o.want) break
    if (c.kind === 'select') {
      const opt = (c.options ?? []).find((x) => x !== c.value && x.trim() && !/^(select|choose|all|any)\b/i.test(x)) ?? (c.options ?? []).find((x) => x !== c.value)
      if (opt) actions.push({ do: 'select', target: c.label, text: opt, relation: 'feature', why: `Choose ${opt} in ${c.label} to show how the section responds.` })
    } else actions.push({ do: 'click', target: c.label, relation: 'feature', why: `Press ${c.label} to show what it does in ${sec.heading}.` })
  }
  if (o.live + actions.filter((a) => a.do !== 'scrollto').length < o.want && study.charts.some((c) => likelyIn(c.title, sec.heading))) {
    actions.push({ do: 'mark', target: sec.heading, text: 'click', noun: 'bar', relation: 'feature', why: `Pick a bar of the ${sec.heading} chart to show its value.` })
  }
  if (!actions.length) return { example: 0, status: o.live > 0 ? 'done' : 'impossible', reason: o.live > 0 ? 'the section was shown' : `"${sec.heading}" was found but offers nothing safe to try`, sections: [sec.heading], actions: [], source: 'rules' }
  return { example: 0, status: 'continue', reason: '', sections: [sec.heading], actions, source: 'rules' }
}
const likelyIn = (a: string, b: string): boolean => tokens(a).some((w) => tokens(b).includes(w))

// ------------------------------------------------------------------ the loop

export async function runGoal(goalItem: ScriptItem, deps: GoalDeps): Promise<GoalRun> {
  const t0 = Date.now()
  const N = Math.max(0, Math.min(goalItem.count ?? 0, 8))
  // "give 3 examples": three separate demonstrations, each of several actions, take more rounds, actions and time than one goal
  const small = !!goalItem.small
  const B: Budget = { ...DEFAULT_BUDGET, ...(small ? { turns: 8, actions: 10, ms: 100_000, live: 1, support: 3, moves: 1 } : {}), ...(N > 1 ? { turns: DEFAULT_BUDGET.turns + 5 * N, actions: DEFAULT_BUDGET.actions + 9 * N, ms: DEFAULT_BUDGET.ms + 100_000 * N, live: Math.max(DEFAULT_BUDGET.live, 2 * N) } : {}), ...deps.budget }
  const caps = deps.caps ?? DEFAULT_CAPS
  const scrub = (t: string): string => scrubText(t, { values: deps.secrets })
  const goal = (goalItem.goal ?? goalItem.said).trim()
  const explain = goalItem.explain ?? goal
  const written = goalItem.written ?? goalItem.n
  const report: GoalReport = { n: written, said: goal, sections: [], status: 'partial', reason: '', shown: [], refused: [], live: 0, turns: 0, modelCalls: 0, ms: 0, mode: deps.chat ? 'model' : 'rules' }
  const items: ScriptItem[] = []
  const results: ItemResult[] = []
  /** the example each performed batch belongs to (0: none), parallel to `items` */
  const exampleOf: number[] = []
  const skipped: ScriptOutcome['skipped'] = []
  let actions = 0
  const done = new Set<string>()
  const rails: Rails = { goal: `${goal} ${explain}`, sections: [], gate: deps.gate, done, support: { used: 0, max: B.support }, moves: { used: 0, max: B.moves }, caps }
  const history: string[] = []
  const brief = briefContext(deps.brief, goal, scrub)
  const log = (m: string) => deps.log(`    [goal ${written}] ${m}`)
  let pushed = false
  let idle = 0
  let study = await studyPage(deps.page)
  let model: LLMProvider | null = deps.chat
  const finish = (status: GoalReport['status'], reason: string): void => {
    report.status = status
    report.reason = reason
    report.ms = Date.now() - t0
  }
  log(`working out: "${goal.slice(0, 100)}" (${model ? 'model' : 'rules'})`)

  for (let turn = 1; turn <= B.turns; turn++) {
    if (deps.signal?.aborted) break
    if (Date.now() - t0 > B.ms) { finish(report.live >= 1 ? 'partial' : 'stopped', `the time set aside for this goal (${Math.round(B.ms / 1000)} s) ran out`); break }
    if (actions >= B.actions) { finish(report.live >= 1 ? 'partial' : 'stopped', `the limit of ${B.actions} actions for one goal was reached`); break }
    report.turns = turn
    if (turn > 1) study = await studyPage(deps.page)
    const tPlan = Date.now()
    let d: Decision | null = null
    if (model) {
      const shot = model.supportsVision?.() === false ? null : await screenshotForModel(deps.page)
      report.modelCalls++
      const ask = { goal, explain: goalItem.explain, brief, history, study, shot, live: report.live, want: B.live, examples: N, small, used: actions, max: B.actions, pushed, known: deps.known, scrub, before: deps.around?.before ?? [], after: deps.around?.after ?? [] }
      d = await askModel(model, ask, caps)
      if (!d) {
        // one more try: a slow answer is not a reason to hand the goal to rules half way through
        log('the planning model gave no usable answer; asking once more')
        report.modelCalls++
        d = await askModel(model, ask, caps)
      }
      if (!d) { log('the planning model gave no usable answer; continuing on rules'); model = null; report.mode = 'rules' }
    }
    if (!d) d = ruleDecision(`${goal} ${explain}`, study, { sections: rails.sections, live: report.live, want: B.live, usedKeys: done, refused: report.refused.length })
    log(`turn ${turn}: ${d.status}${d.actions.length ? `, ${d.actions.length} action(s)` : ''} (${Math.round((Date.now() - tPlan) / 100) / 10} s ${d.source})${d.reason ? ` — ${d.reason.slice(0, 120)}` : ''}`)

    // what the planner says the goal is about, kept only when it is really a heading / chart on the page
    for (const s of d.sections) {
      const hit = bestSection(study, s)
      if (hit && !rails.sections.includes(hit.heading)) rails.sections.push(hit.heading)
    }
    report.sections = [...rails.sections]

    if (d.status === 'impossible') {
      if (report.live > 0) { finish('partial', d.reason || 'nothing more fits the goal'); break }
      finish('unreachable', d.reason || 'the goal does not match anything on the pages of this app')
      break
    }
    if (d.status === 'done' && !d.actions.length) {
      if (report.live < B.live && !pushed && turn < B.turns && d.source === 'model' && !small) {
        pushed = true
        history.push(`(you said done with ${report.live} live interaction${report.live === 1 ? '' : 's'}; more are wanted)`)
        continue
      }
      finish(report.live >= 1 ? 'done' : 'partial', d.reason || 'the goal is on screen')
      break
    }

    // the guard
    const built: Array<{ atom: Atom; why: string; label: string; key: string; leaves: boolean; support: boolean }> = []
    for (const a of d.actions) {
      const b = buildAtom(a, study, rails)
      // a control that only appears after an earlier action of this batch (a number pad, a confirm bar) is not wrong, it is early: the batch ends here and the next look at the page offers it
      if ('reject' in b && built.length && /^no (?:control|text box|dropdown) called/.test(b.reject)) {
        history.push(`("${a.target}" is not on the page yet; propose it after the page has changed)`)
        break
      }
      if ('reject' in b) {
        report.refused.push(`${a.do} "${a.target}": ${b.reject}`)
        history.push(`REFUSED ${a.do} "${a.target}": ${b.reject}`)
        log(`refused ${a.do} "${a.target}": ${b.reject}`)
        continue
      }
      if (b.support) rails.support.used++
      if (b.leaves) rails.moves.used++
      built.push({ atom: b.atom, why: a.why || '', label: b.label, key: b.key, leaves: b.leaves, support: b.support })
      // an action that moves the page ends the batch: what comes next depends on the page it leads to
      if (b.leaves || (b.atom.action === 'click' && study.controls.find((c) => c.label === b.label)?.collapsed)) break
    }
    if (!built.length) {
      idle++
      if (idle >= 3 || report.refused.length >= 8) { finish(report.live >= 1 ? 'partial' : 'stopped', report.refused.length ? `every action proposed was refused (${report.refused.at(-1)})` : 'no action could be worked out'); break }
      continue
    }
    idle = 0

    // act, with the same engine that performs a typed list of steps
    const first = items.length === 0
    const atoms = built.map((b) => b.atom)
    const item: ScriptItem = {
      n: goalItem.n * 100 + items.length + 1,
      written,
      said: first ? goal : atoms.map(describeAtom).join(', then '),
      login: false,
      atoms,
      notes: built.map((b) => b.why).filter(Boolean),
      unread: [],
      ...(first ? { explain } : {})
    }
    const before = study
    const out = await performScript({ page: deps.page, gate: deps.gate, script: { items: [item], goal: '', source: 'plan', tone: [], whenever: [] }, log: deps.log, signal: deps.signal, vision: deps.vision })
    if (out.failure) { finish(report.live >= 1 ? 'partial' : 'stopped', out.failure); break }
    const r = out.results[0]
    actions += out.actions
    const after = await studyPage(deps.page)
    const diff = diffStudy(before, after)
    if (diff.appeared.length && !r.unchanged) r.seen.push(`After this, the screen newly shows: ${scrub(diff.appeared.slice(0, 5).join(' · ')).slice(0, 320)}`)
    for (const k of out.skipped) skipped.push(k)
    // which of the atoms really ran: those whose name is not in a skipped part
    const notDone = (label: string): boolean => r.skipped.some((s) => s.what.toLowerCase().includes(label.toLowerCase()))
    const verified = (r as ItemResult & { verified?: boolean }).verified
    for (const b of built) {
      const ran = !notDone(b.label)
      const live = ran && interactive.has(b.atom.action) && !r.unchanged && (verified !== false)
      // an action that changed nothing may be tried again (a click that a popup swallowed)
      if (ran && !r.unchanged) done.add(done.has(b.key) ? `${b.key}#2` : b.key)
      if (live) report.live++
      report.shown.push({ what: describeAtom(b.atom), why: b.why, ...(ran ? {} : { skipped: r.skipped.find((s) => s.what.toLowerCase().includes(b.label.toLowerCase()))?.why ?? 'it could not be done' }) })
    }
    items.push(item)
    results.push(r)
    exampleOf.push(N > 1 ? d.example : 0)
    // "pressed twice already" is about the same control pressed again and again; once something else was done, a tool of a game (Size, Cut) may be used again
    for (const k of [...done]) if (k.endsWith('#2') && !built.some((b) => `${b.key}#2` === k)) done.delete(k)
    const did = built.map((b) => `${notDone(b.label) ? 'COULD NOT' : 'DID'} ${describeAtom(b.atom)}${b.why ? ` (${b.why})` : ''}`)
    history.push(`${did.join('; ')} → ${r.unchanged ? 'the screen did not change' : diff.navigated ? `moved to ${after.url.replace(/^https?:\/\/[^/]+/, '')}` : diff.appeared.length ? `newly on screen: ${scrub(diff.appeared.slice(0, 4).join(' · ')).slice(0, 260)}` : diff.moved ? 'the view scrolled' : 'no new text'}${diff.gone.length ? `; gone: ${scrub(diff.gone.slice(0, 2).join(' · ')).slice(0, 100)}` : ''}`)
    if (d.status === 'done') { finish(report.live >= 1 ? 'done' : 'partial', d.reason || 'the goal is on screen'); break }
    if (turn === B.turns) finish(report.live >= 1 ? 'partial' : 'stopped', `the ${B.turns} planning rounds were used`)
    await sleep(150)
  }
  if (!report.reason) finish(report.live >= 1 ? 'partial' : 'stopped', 'the planner stopped before the goal was met')
  report.ms = Date.now() - t0

  // "give 3 examples": the presses of one example are one beat of the film, told as one story
  if (N > 1 && results.length > 1 && exampleOf.some((e) => e > 0)) mergeExamples(items, results, exampleOf, N, goal)

  // a goal that produced no action still has to be said in the film's notes: honest about what was and was not shown
  if (!results.length) {
    const why = report.reason || 'nothing on the page could be used for it'
    const item: ScriptItem = { n: goalItem.n * 100 + 1, written, said: goal, login: false, atoms: [], notes: [], unread: [], explain }
    const left = report.status === 'unreachable' || report.status === 'stopped'
    // a goal that is only to be said (the page already shows it) is narrated; one that could not be shown is not done, and says why
    const r: ItemResult = { item, steps: [], areaText: '', picks: [], skipped: left ? [{ what: `the goal "${goal.slice(0, 90)}"`, why }] : [], seen: [], parts: [], status: left ? 'not-done' : 'narrated' }
    if (r.skipped.length) skipped.push({ ...r.skipped[0], n: written, said: goal })
    items.push(item)
    results.push(r)
  }
  log(`${report.status}: ${report.reason.slice(0, 140)} — ${report.live} live interaction(s), ${actions} action(s), ${(report.ms / 1000).toFixed(1)} s, ${report.modelCalls} model call(s)`)
  return { items, results, skipped, actions, report }
}

/** the batches of each example (same number, next to each other) become one item and one result, in place */
function mergeExamples(items: ScriptItem[], results: ItemResult[], exampleOf: number[], N: number, goal: string): void {
  const outItems: ScriptItem[] = []
  const outResults: ItemResult[] = []
  for (let i = 0; i < items.length; ) {
    const e = exampleOf[i]
    let j = i + 1
    if (e > 0) while (j < items.length && exampleOf[j] === e) j++
    if (j - i === 1 && e === 0) {
      outItems.push(items[i])
      outResults.push(results[i])
      i = j
      continue
    }
    const group = results.slice(i, j)
    const first = items[i]
    const whys = [...new Set(items.slice(i, j).flatMap((it) => it.notes).filter(Boolean))]
    const item: ScriptItem = {
      ...first,
      said: e > 0 ? `Example ${e} of ${N}: ${goal.slice(0, 120)}` : first.said,
      atoms: items.slice(i, j).flatMap((it) => it.atoms),
      notes: [],
      summary: whys,
      ...(e > 0 ? { example: { n: e, of: N } } : {})
    }
    const merged: ItemResult = {
      item,
      steps: [...group.flatMap((g) => g.steps), { kind: 'wait', intent: 'inspect', focus: 'page' } as ItemResult['steps'][number]],
      areaText: group[group.length - 1].areaText,
      picks: group.flatMap((g) => g.picks),
      skipped: group.flatMap((g) => g.skipped),
      seen: group.flatMap((g) => g.seen),
      parts: group.flatMap((g) => g.parts),
      ...(group.every((g) => g.unchanged) ? { unchanged: true } : {}),
      status: group.every((g) => g.status === 'done') ? 'done' : group.some((g) => g.status === 'done' || g.status === 'partial') ? 'partial' : group[0].status
    }
    outItems.push(item)
    outResults.push(merged)
    i = j
  }
  items.splice(0, items.length, ...outItems)
  results.splice(0, results.length, ...outResults)
}

/** the run notes for one goal: what was decided to be shown and why, and what could not be done */
export function goalNotes(r: GoalReport): string[] {
  const head = `Goal in step ${r.n} ("${r.said.slice(0, 90)}"): `
  const out: string[] = []
  if (r.status === 'unreachable' || (r.status === 'stopped' && !r.live && !r.shown.some((s) => !s.skipped))) {
    out.push(`${head}could not be shown (${r.reason}). Nothing was invented, and the narration does not claim it.`)
  } else {
    const about = r.sections.length ? `took it to be about "${r.sections.join('", "')}"` : 'looked at the page it was on'
    const did = r.shown.filter((s) => !s.skipped)
    out.push(`${head}${about}. Shown, in order: ${did.map((s) => `${s.what}${s.why ? ` — ${s.why.replace(/[.]+$/, '')}` : ''}`).join('; ') || 'nothing'}. ${r.live} live interaction${r.live === 1 ? '' : 's'} on the real page.`)
    if (r.status !== 'done') out.push(`${head}only partly shown: ${r.reason}.`)
  }
  for (const s of r.shown.filter((x) => x.skipped)) out.push(`${head}could not do ${s.what} (${s.skipped}).`)
  if (r.refused.length) out.push(`${head}${r.refused.length} proposed action${r.refused.length === 1 ? ' was' : 's were'} not carried out: ${r.refused.slice(0, 3).join('; ')}${r.refused.length > 3 ? '; …' : ''}.`)
  out.push(`${head}planned in ${(r.ms / 1000).toFixed(0)} s over ${r.turns} round${r.turns === 1 ? '' : 's'} (${r.modelCalls} model call${r.modelCalls === 1 ? '' : 's'}${r.mode === 'rules' ? ', rules' : ''}).`)
  return out
}

// ------------------------------------------------------------------ the hook of performScript

export interface GoalHookDeps {
  gate: PolicyGate
  chat: LLMProvider | null
  vision?: VisionPick
  brief: string
  secrets: string[]
  /** pages of the app read so far (the list may grow while the run goes on) */
  known: AppPage[]
  /** the script being performed (to tell the planner what comes before and after the goal) */
  script: () => StepScript | null
  signal?: AbortSignal
  caps?: Capable
  budget?: Partial<Budget>
}

/**
 * The goal planner as performScript's `planGoal` hook: it is called for a step that is a goal (`item.goal`, no atoms), works the
 * goal out on the live page (planning, acting and looking, a few actions at a time) and answers with what it already performed.
 * `reports` collects one report per goal for the run notes.
 */
export function goalPlanHook(deps: GoalHookDeps): { plan: NonNullable<ScriptInput['planGoal']>; reports: GoalReport[] } {
  const reports: GoalReport[] = []
  const plan: NonNullable<ScriptInput['planGoal']> = async ({ item, page, log }) => {
    // what the person's other steps say, so the goal does not redo the steps before it or do the steps after it
    const all = deps.script()?.items ?? []
    const at = all.findIndex((i) => i === item)
    const said = (i: ScriptItem): string => i.said.replace(/\s+/g, ' ').trim().slice(0, 140)
    const before = at < 0 ? [] : all.slice(0, at).filter((i) => !i.login)
    const after = at < 0 ? [] : all.slice(at + 1)
    const g = await runGoal(item, { page, gate: deps.gate, chat: deps.chat, vision: deps.vision, log, signal: deps.signal, brief: deps.brief, secrets: deps.secrets, known: deps.known, caps: deps.caps, budget: deps.budget, around: { before: before.map(said), after: after.map(said) } })
    reports.push(g.report)
    return { performed: g.results, skipped: g.skipped, actions: g.actions }
  }
  return { plan, reports }
}

export { BASE_ACTIONS }
