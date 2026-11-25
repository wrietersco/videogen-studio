import { z } from 'zod'

/**
 * App walkthrough recording — the data that flows between its stages.
 *
 *   Scout    → AppMap     (what the app looks like, which fields are sensitive)
 *   Plan     → Playbook   (a reviewable, replayable list of steps)
 *   Record   → Take       (raw frames + the timeline of what happened when)
 *
 * Everything here is plain JSON so it can be saved with the project, shown to
 * the user for approval, versioned, and replayed without an AI in the loop.
 */

/** the finished film's frame: the browser window opens at exactly this size, so the page is never squeezed */
export const FILM = { width: 1920, height: 1080 }
/** CSS pixel density of the frames recorded (4/3 keeps the frames at 2560×1440, the size they always were, so the pipeline stays just as fast) */
export const REC_SCALE = 4 / 3

export const FieldKind = z.enum(['password', 'otp', 'card', 'ssn', 'email', 'phone', 'person-name', 'address', 'username', 'search', 'text', 'other'])
export type FieldKind = z.infer<typeof FieldKind>

const Rect = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
export type Rect = z.infer<typeof Rect>

export const AppField = z.object({
  selector: z.string(),
  label: z.string(),
  inputType: z.string(),
  name: z.string(),
  kind: FieldKind,
  /** blurred in every frame that is recorded */
  sensitive: z.boolean(),
  rect: Rect.optional()
})
export type AppField = z.infer<typeof AppField>

export const AppControl = z.object({ selector: z.string(), label: z.string(), kind: z.enum(['button', 'link']), href: z.string().optional(), rect: Rect.optional() })
export type AppControl = z.infer<typeof AppControl>

export const AppPage = z.object({
  url: z.string(),
  title: z.string(),
  /** file relative to the scout folder (sensitive fields already blurred) */
  screenshot: z.string().optional(),
  /** every picture of this page, in page order from the top (screenshot is always the first) */
  shots: z.array(z.string()).optional(),
  /** how many screen-heights of scrolling the whole page needs (0 = it all fits on screen) */
  scrolls: z.number().optional(),
  headings: z.array(z.string()),
  fields: z.array(AppField),
  controls: z.array(AppControl),
  /** the visible message on the page, if any (flash banners, errors) */
  notices: z.array(z.string()),
  /** the start of what the page says, and the labels drawn in its charts or graphs: what a writer may describe */
  text: z.string().optional(),
  /** the parts of the page a person would scroll through or step through, in page order (headings, stepper stages, tabs, cards) */
  sections: z
    .array(
      z.object({
        label: z.string(),
        selector: z.string(),
        kind: z.enum(['section', 'stage', 'tab', 'card']),
        /** top of the part, in CSS px from the top of the page */
        y: z.number().optional(),
        /** the start of what it says */
        text: z.string().optional(),
        /** it opens and closes (summary, aria-expanded): clicking it only shows more */
        expandable: z.boolean().optional()
      })
    )
    .optional(),
  /** what a person could be referring to on this page: its tabs, sections, stages, cards, headings, chart labels and messages, as short human lines */
  possibilities: z.array(z.string()).optional()
})
export type AppPage = z.infer<typeof AppPage>

export const AppMap = z.object({
  version: z.literal(1),
  startUrl: z.string(),
  host: z.string(),
  scoutedAt: z.string(),
  pages: z.array(AppPage),
  login: z.object({
    detected: z.boolean(),
    pageUrl: z.string().optional(),
    usernameSelector: z.string().optional(),
    passwordSelector: z.string().optional(),
    submitSelector: z.string().optional(),
    submitLabel: z.string().optional(),
    /** a second factor field is on the page (a person has to type the code) */
    otpLikely: z.boolean()
  }),
  /** CSS selectors that must be blurred wherever they appear */
  sensitiveSelectors: z.array(z.string())
})
export type AppMap = z.infer<typeof AppMap>

export const Guardrails = z.object({
  allowedHosts: z.array(z.string()).min(1),
  /** stay on the app's own sites (default true; sign-in and API hosts learned while exploring are added) */
  stayOnSites: z.boolean().optional(),
  /** no request that changes data may leave the browser (the sign-in itself is the one allowed exception). Opt-in. */
  readOnly: z.boolean(),
  /** never press delete/remove-type controls. Opt-in. */
  noDelete: z.boolean().optional(),
  /** never pay, buy, order, send or publish. Opt-in. */
  noSpend: z.boolean().optional(),
  /** never change settings, passwords or accounts. Opt-in. */
  noSettings: z.boolean().optional(),
  /** blur the contents of tables, lists and cards. Opt-in. */
  privacyMode: z.boolean().optional(),
  /** a control whose label matches any of these is never clicked */
  blockedWords: z.array(z.string()),
  /** the user's own words that cannot be enforced mechanically — shown back to them, passed to the planner */
  advisory: z.array(z.string())
})
export type Guardrails = z.infer<typeof Guardrails>

/** how to find a control by what a person would say about it: its name, where it sits, what it is next to */
export const FindSpec = z.object({
  /** the name the person used: visible text, an icon's tooltip or label, or the box's placeholder */
  target: z.string(),
  kind: z.enum(['click', 'type', 'scroll', 'select', 'hover']),
  region: z.enum(['left', 'right', 'top', 'bottom']).optional(),
  /** words for the area it sits in: menu, search, pane, header, dropdown ... */
  within: z.array(z.string()).optional(),
  relation: z.object({ rel: z.enum(['above', 'below', 'leftOf', 'rightOf', 'near']), to: z.string() }).optional(),
  role: z.enum(['suggestion', 'tab', 'icon']).optional(),
  /** colours of the chart marks meant ("blue, green and orange lines"): found by looking at the pixels, so SVG, canvas and WebGL charts all work */
  colours: z.array(z.string()).optional(),
  /** what kind of mark (line, bar, point, slice ...) */
  noun: z.string().optional(),
  /** which chart, in the person's words ("the even-odd circle") */
  chart: z.string().optional()
})
export type FindSpec = z.infer<typeof FindSpec>

/**
 * The kinds a recorded step can have. The second row is the atom contract (see `Atom` below): a step of one of those kinds
 * carries its details as JSON in `text` (the same way a 'mark' step does) and the words the person used in `label`/`find`.
 */
export const StepKind = z.enum([
  'goto', 'type', 'click', 'press', 'wait', 'expect', 'handoff', 'scroll', 'reveal', 'select', 'scrollto', 'hover', 'mark',
  'key', 'drag', 'dblclick', 'slider', 'date', 'scrollUntil', 'whenever'
])
export const Step = z.object({
  id: z.string(),
  /** which narrated beat of the video this step belongs to */
  beat: z.number().int().nonnegative(),
  kind: StepKind,
  selector: z.string().optional(),
  /** what a person would call the thing being used */
  label: z.string().optional(),
  url: z.string().optional(),
  /** literal text, or {{secret:name}} — the secret is filled in on this computer and never reaches a model */
  text: z.string().optional(),
  intent: z.enum(['navigate', 'login-submit', 'logout', 'inspect']).optional(),
  expect: z
    .object({
      urlIncludes: z.string().optional(),
      textVisible: z.string().optional(),
      selectorGone: z.string().optional(),
      selectorVisible: z.string().optional()
    })
    .optional(),
  /** a step the person wrote: the control is found again by this description each time, so a moved page still works */
  find: FindSpec.optional(),
  /** the part of the screen the viewer should look at once this step is done */
  focus: z.enum(['target', 'form', 'banner', 'page']).optional(),
  /** how long to stay on this step once done, in ms (scaled by the recording's pace) */
  holdMs: z.number().optional()
})
export type Step = z.infer<typeof Step>

export const Playbook = z.object({
  version: z.literal(1),
  title: z.string(),
  startUrl: z.string(),
  steps: z.array(Step)
})
export type Playbook = z.infer<typeof Playbook>

/** what happened when, in seconds from the first frame */
export interface TimelineBeat {
  beat: number
  startSec: number
  endSec: number
  /** the area (CSS px) to bring forward, if the beat has one */
  focus?: Rect & { zoom: number }
  url: string
}

export interface Take {
  fps: number
  /** viewport in CSS px */
  viewport: { width: number; height: number }
  durationSec: number
  beats: TimelineBeat[]
  /** each time the address changed (seconds from recording start) */
  navigations: Array<{ t: number; url: string }>
  /** every action that was performed, for the audit log and the playbook diff */
  log: Array<{ t: number; step: string; note: string }>
  /** elements that should have been blurred but were not, per beat (must be empty to ship) */
  redactionMisses: number
}

// ---------------------------------------------------------------------------------------------------------------------------
// The atom contract: the small actions a person's step is read into (parsed by main/appRecon/stepScript.ts, performed by
// main/appRecon/script.ts, which hands the kinds below the older code does not know to main/appRecon/atomExec.ts).
//
// Rules every atom follows:
//  - `label` is what the person called the thing (or a short description of the action) — used for the chapter name, the
//    narration facts and the run notes. It is never an instruction to the page.
//  - `find` (where there is one) is how the control is looked for; `find.target` is the cleaned name (filler and role words removed).
//  - An executor reports what it DID: `did` counts only actions really performed, `verified` is true only when the page showed the
//    expected effect afterwards (a key that moved focus, a slider whose value changed, a drag that reordered...). Anything that
//    could not be done is a `skipped` entry with a plain reason. Nothing is ever dropped silently.
// ---------------------------------------------------------------------------------------------------------------------------

/** a single key or chord (puppeteer names: "Escape", "Tab", "ArrowDown", "Control+K"); a space separates a sequence ("ArrowDown ArrowDown Enter") */
export interface KeyAtom {
  action: 'key'
  label: string
  keys: string
  /** keep pressing the key until this is true: a control with this name has focus, or this text is on screen ("Tab until Export is focused") */
  repeatUntil?: string
}
/** press on `from`, move to `to`, release */
export interface DragAtom {
  action: 'drag'
  label: string
  /** what is picked up ("the Fix login redirect card") */
  from: string
  /** where it is dropped: a column, a list or a card ("In progress", "the Done column") */
  to: string
  /** where in `to`, or beside `ref`: before/after a card, or at the top/bottom of the list */
  position?: 'before' | 'after' | 'top' | 'bottom'
  /** the card the drop is relative to ("above the first card" → position 'before', ref "the first card") */
  ref?: string
  find: FindSpec
}
/** two quick clicks on the same control (an inline edit opens). A text to put in follows as a `type` atom with `replace: true` */
export interface DblClickAtom {
  action: 'dblclick'
  label: string
  find: FindSpec
}
/** a range input (single thumb: `value`; a range of two: `min` and `max`), by a number or "about £40–£80" */
export interface SliderAtom {
  action: 'slider'
  label: string
  value?: number
  min?: number
  max?: number
  find: FindSpec
}
/** a calendar day. `date` is computed from today by the parser; `phrase` keeps the person's words and `rule` says which rule was used when the words are ambiguous */
export interface DateAtom {
  action: 'date'
  label: string
  date: string
  phrase: string
  rule?: string
  find: FindSpec
}
/** scroll (the page, or the feed named in `find`) until this text is on screen, with a safety limit */
export interface ScrollUntilAtom {
  action: 'scrollUntil'
  label: string
  text: string
  find: FindSpec
}
/**
 * a rule for the whole rest of the run ("if a cookie banner shows, accept only essentials"): armed once, checked before every later
 * action. (`action` is the atom's discriminant, so what to do is called `then`.)
 */
export interface WheneverAtom {
  action: 'whenever'
  label: string
  condition: 'popup' | 'cookie' | 'banner'
  then: 'close' | 'accept-essential' | 'accept'
}
/**
 * pick one thing out of several by where it is or what it holds, then do `verb` to it ("the second card in the third column",
 * "the row with the highest total", "the cheapest jacket", "the button under the chart", "the June peak").
 * `label` is what is picked (the noun: "card", "row", "jacket"); the rest narrows it down.
 */
export interface PickAtom {
  action: 'pick'
  label: string
  /** what to do with it (default click) */
  verb?: 'click' | 'hover' | 'dblclick'
  /** 1-based position among the matches; -1 is the last */
  ordinal?: number
  /** the part of the page it is in ("the chart", "the Done column", "the cart") */
  within?: string
  /** which column of a board or table, by number (1-based) or by its heading */
  column?: number | string
  /** choose by value: the highest/lowest, the cheapest/most expensive */
  criterion?: 'highest' | 'lowest' | 'cheapest' | 'most-expensive'
  /** the value the criterion reads (a table column's heading, "total", "price"); omitted for price words */
  field?: string
  find: FindSpec
}

/** every small action a step is read into */
export type Atom =
  /** go to an address the step names, whole (the #fragment can pick the view the page opens on) */
  | { action: 'open'; label: string; url: string }
  | { action: 'click'; label: string; find: FindSpec }
  /** choose one entry in a dropdown ("select Surah An-Nur" in the "Text to Study" dropdown) */
  | { action: 'select'; label: string; option: string; find: FindSpec }
  /** `replace`: select what is in the box first and type over it ("change plan to team", "rename it to X"); otherwise the text is added */
  | { action: 'type'; label: string; text: string; find: FindSpec; replace?: boolean }
  | { action: 'scroll'; dir: 'down' | 'up'; find: FindSpec }
  /** scroll until a named part of the page ("the Whole-Quran even–odd circle") is on screen */
  | { action: 'scrollto'; dir: 'down' | 'up'; label: string; find: FindSpec }
  /** rest the pointer on something so its tooltip shows */
  | { action: 'hover'; label: string; find: FindSpec }
  /** click or hover marks of a chart ("blue, green and orange lines"), found by their colour on screen */
  | { action: 'mark'; verb: 'click' | 'hover'; label: string; colours: string[]; noun: string; find: FindSpec }
  | KeyAtom
  | DragAtom
  | DblClickAtom
  | SliderAtom
  | DateAtom
  | ScrollUntilAtom
  | WheneverAtom
  | PickAtom

/** the atoms whose executors live in main/appRecon/atomExec.ts */
export type NewAtom = Extract<Atom, { action: 'key' | 'drag' | 'dblclick' | 'slider' | 'date' | 'scrollUntil' | 'whenever' | 'pick' }>

/** what performing one atom did (the shape script.ts keeps for each part of a step) */
export interface AtomResult {
  /** the steps to record, without ids */
  steps: Array<Omit<Step, 'id' | 'beat'>>
  /** what the page showed while it was done (a tooltip's words, what a click opened), for the narration */
  seen: string[]
  /** what could not be done, with a plain reason (never empty when `did` is 0) */
  skipped: Array<{ what: string; why: string }>
  /** actions really performed */
  did: number
  /** the screen looked different afterwards */
  changed: boolean
  /** the page showed the expected effect (focus moved, value set, card moved, day chosen...). Narration facts come only from verified actions */
  verified: boolean
  /** the selector of the control last used (a later scroll stays near it) */
  last?: string
}
