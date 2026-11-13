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
  headings: z.array(z.string()),
  fields: z.array(AppField),
  controls: z.array(AppControl),
  /** the visible message on the page, if any (flash banners, errors) */
  notices: z.array(z.string())
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

export const StepKind = z.enum(['goto', 'type', 'click', 'wait', 'expect', 'handoff'])
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
  /** the part of the screen the viewer should look at once this step is done */
  focus: z.enum(['target', 'form', 'banner', 'page']).optional()
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
