import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Cookie, Page } from 'puppeteer-core'
import { type AppMap, type AppPage, type Playbook, type Step, type Take } from '@shared/appRecon'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import { asPhone, enforcePolicy, launch } from './browser'
import { scrubMap, scrubText } from './detect'
import { parseDirectives, readUrls, readUseCase } from './directives'
import { checkCompatibility, explore, openPage, passInterstitial, settle, type Depth, type Exploration } from './explore'
import { narrate, voiceLine, voiceTone, type LaunchInfo } from './narrate'
import { adoptFile, findVoice, writeRecordingRecord, type RecordedCard } from './recordingRecord'
import { planBeats, type Plan } from './planner'
import { interpretGuardrails, PolicyGate, type RestrictionChecks } from './policy'
import { produce, recordingScreen, type CardPlan, type InsertPlan } from './produce'
import { scriptPlan, type ScriptOutcome, type VisionPick } from './script'
import { parseStepScript, type StepScript } from './stepScript'
import { goalNotes, goalSegments, performWithGoals, scriptFromPlan, type GoalReport } from './goalPlanner'
import { ambientBrief, chooseMusic, clipSeconds, parseMediaAsk, parseMusicAsk, parseStructure, planMedia, withStyle, withoutProductionSentences, type Placement } from './aiMedia'
import { musicBrief } from '../audio/cue'
import { soundsFromWords } from '../audio/ambience'
import { pickMotif } from './scenes'
import { designFilmBackgrounds } from '../introBg/film'
import { IntroBackgroundLibrary } from '../introBg/library'
import { introBackgroundsDir } from '../paths'
import { decodeStereo } from '../audio/pcm'
import { probe } from '../assets/probe'
import type { VideoSpec } from '@shared/spec'
import { FrameRecorder, prepare, runPlaybook } from './recorder'
import type { RedactionConfig } from './redact'
import { buildAppMap, scoutPage } from './scout'
import { captureSiteBrand, type SiteBrand } from './siteBrand'
import { lookFromPalette } from './style'
import { filmFrame } from '@shared/shapes'
import type { PariReport } from '@shared/agentBrief'
import { actStage, agentFilmsPages, buildReport, clipRequests, narrationBrief, planStage, PariStopped, reviewStage, wantsProblemCard, type ActOutcome, type PariHooks, type PlanOutcome } from './agent/loop'
import { musicPrompt } from './agent/musicBrief'
import { framedWords, withoutFramed } from './agent/brief'
import type { PlatformId } from '@shared/spec'

/**
 * One recording, start to finish:
 *
 *   explore → plan → (review) → script → record → produce
 *
 * Every stage writes its result next to the run, so a person can see what was
 * found and decided, and a stage can be re-run on its own. The explorer's
 * sign-in counts as the first of at most two sign-in attempts per run; the
 * recording's own sign-in is the second.
 */

/** what the AI media models can do for this run (supplied by the app; absent = the free engine only) */
export interface MediaTools {
  /** one clip of this many whole seconds (3 to 10); resolves to the file. `imageFile` is a still used as the clip's first frame (image-to-video) */
  clip(prompt: string, seconds: number, opts?: { imageFile?: string; /** a tall 9:16 clip for a tall film (default wide 16:9) */ portrait?: boolean }): Promise<{ file: string; durationSec?: number }>
  /**
   * a cheap still (the user's image model) saved to a file, wide 16:9 or tall 9:16; absent = clips start from text only.
   * `refs` are local pictures the still should show (a product photo, a logo); an image model that cannot look at
   * pictures ignores them, and `refsUsed` (absent or 0) says so.
   */
  still?(prompt: string, opts?: { portrait?: boolean; refs?: string[] }): Promise<{ file: string; costUsd?: number; refsUsed?: number }>
  /** true when `still` can use `refs` (the image model looks at pictures); absent = it cannot */
  stillTakesRefs?: boolean
  /** checks a still is a coherent, concrete picture with no readable text (`allowBrand` = the business's own logo on its packaging is fine); null/absent = no review available (the still is used unchecked) */
  reviewStill?(file: string, opts?: { allowBrand?: boolean }): Promise<{ ok: boolean; reason?: string } | null>
  /** one finished track (an audio file's bytes) for this brief */
  music(brief: string, /** the model the plan assigned ("gemini:lyria-3.5", "elevenlabs:music_v2_5"); absent = Settings decide */ model?: string): Promise<Buffer>
}

/** the still's prompt: the clip prompt, asking for the shot's first frame */
export const keyframePrompt = (clipPrompt: string, style?: 'infographic' | null): string =>
  style === 'infographic' ? `First frame of this animation, a clean flat 2D vector infographic illustration (not a photograph, no readable text): ${clipPrompt}` : `First frame of this shot, a still photograph: ${clipPrompt}`

/** one clip in a long film gets up to 5 seconds, otherwise the planner's length stands */
export const clipLength = (planned: number, clipCount: number, targetSec: number): number => (clipCount === 1 && targetSec > 25 ? Math.max(planned, 5) : planned)

/**
 * the opening picture for one AI clip: a still made and checked before any video is paid for.
 * `skip` = the picture failed the check twice, so no clip is to be made; no `imageFile` and no `skip` = the clip starts from text only.
 */
export async function openingPicture(tools: MediaTools, clipPrompt: string, index: number, notes: string[], signal?: AbortSignal, portrait = false, style: 'infographic' | null = null): Promise<{ imageFile?: string; skip?: boolean }> {
  if (!tools.still) return {}
  let imageFile: string | undefined
  try {
    for (let attempt = 0; attempt < 2 && !imageFile; attempt++) {
      const still = await tools.still(keyframePrompt(clipPrompt, style), { portrait })
      const verdict = tools.reviewStill ? await tools.reviewStill(still.file).catch(() => null) : null
      if (!verdict || verdict.ok) {
        imageFile = still.file
        if (attempt > 0) notes.push(`The opening picture for AI clip ${index + 1} was made again after the first one failed the check.`)
      } else if (attempt === 1) {
        notes.push('The opening picture for an AI clip did not pass the check, so no clip was paid for.')
        return { skip: true }
      }
    }
  } catch (err) {
    if (err instanceof RunCancelled || signal?.aborted) throw err
    notes.push(`The opening picture for AI clip ${index + 1} could not be made (${String((err as Error)?.message ?? err).slice(0, 120)}), so the clip starts from text only.`)
    return {}
  }
  notes.push(`AI clip ${index + 1} started from a keyframe picture.`)
  return { imageFile }
}

/** a model that looks at the screen to name the control a step means (only when the chosen model can see pictures) */
export function visionPicker(chat: LLMProvider | null): VisionPick | undefined {
  if (!chat || chat.supportsVision?.() === false) return undefined
  return async ({ shot, said, candidates }) => {
    const list = candidates.map((c) => `${c.i}. [${c.kind}] ${c.text || '(no text)'}  (${Math.round(c.rect.x)},${Math.round(c.rect.y)})`).join('\n')
    const out = await chat.generateJSON<{ index?: number | null }>({
      system: 'You help a screen recorder do a step a person wrote on a web page. You are given the step, a screenshot of the page and a numbered list of the controls on it. Name the control the step means. If none of them fits, answer null.',
      prompt: `The step: "${said}"\n\nControls on the page:\n${list}\n\nWhich number is the control the step means?`,
      schemaName: 'pick_control',
      jsonSchema: { type: 'object', properties: { index: { type: ['integer', 'null'] } }, required: ['index'], additionalProperties: false },
      images: [{ mimeType: 'image/jpeg', base64: shot.toString('base64') }],
      temperature: 0,
      maxTokens: 120
    })
    return typeof out?.index === 'number' ? out.index : null
  }
}

export type Stage = 'explore' | 'plan' | 'script' | 'record' | 'produce'

export interface RunInput {
  runDir: string
  startUrl: string
  /** every address the person gave in "Your app" (startUrl is the first); each is scouted, and the film may go to any of them */
  startUrls?: string[]
  /** what the video should show: typed text plus any attached document, already read */
  context: string
  mode: 'walkthrough' | 'launch'
  launch?: LaunchInfo
  /** how the app is signed in to */
  signIn: 'saved' | 'self' | 'none'
  vault?: { username: string; password: string }
  /** a public demo account may show its login name; real accounts must not */
  revealUsername?: boolean
  guardrailText: string
  checks: RestrictionChecks
  depth: Depth
  targetSec?: number
  /** pause after planning so the person can edit the steps */
  reviewFirst?: boolean
  chat: LLMProvider | null
  /** where AI-designed intro backgrounds are kept for later films (default: the app's intro-backgrounds folder; null = not kept) */
  introLibrary?: IntroBackgroundLibrary | null
  speech: SpeechProvider | null
  signal?: AbortSignal
  /** keep frames and the browser profile (for debugging) */
  keepFiles?: boolean
  /** stop early (tests, and "just show me the plan") */
  stopAfter?: 'explore' | 'plan' | 'record'
  musicMood?: 'corporate' | 'upbeat'
  /** the person's brand kit: accent colour (hex without #) and logo file for the title and closing cards */
  brand?: { accent?: string; logo?: string }
  /** take the logo and colours from the website being recorded instead (wins over `brand`) */
  siteBrand?: boolean
  /** colours from the person's reference pictures: backdrop and card accent */
  look?: { backdrop: [string, string]; accent: string }
  /** style read from YouTube references (look, motion graphics, music, narration): information for the script writer, never instructions */
  styleDirection?: string
  /** the steps of an earlier run: they are checked against the app as it is now, and only the broken ones are changed */
  reuse?: Plan
  /** the person can press Take over while the app is being explored */
  control?: { takeover: boolean }
  /**
   * AI-made supporting media. `clips`: the person ticked "AI video clips" (one opening clip is added when they wrote no request);
   * `music`: the person ticked "AI music". Sentences in the typed words that ask for an AI video are carried out whenever `tools` exist.
   */
  media?: { tools: MediaTools | null; clips: boolean; music: boolean }
  /** where the film will be posted; sets its frame (default: wide YouTube 1920×1080). A tall or portrait film records the app on a phone screen */
  platform?: PlatformId
  /** the PARI agent: the whole brief is read into a plan, models are chosen with the person (or on autopilot), and every part is checked */
  pari?: PariHooks
}

export interface RunHooks {
  progress: (stage: Stage, message: string) => void
  log?: (message: string) => void
  /** the person has to do something in a browser window; resolves when they are done */
  handoff: (info: { reason: 'sign-in' | 'code' | 'captcha' | 'takeover'; url: string; message: string }) => Promise<void>
  /** the person may edit the plan; return null to cancel */
  review?: (plan: Plan, advisory: string[]) => Promise<Plan | null>
}

export interface RunOutput {
  video?: string
  durationSec?: number
  plan: Plan
  map: AppMap
  compat: { level: string; reason: string }
  stoppedBy: Exploration['stoppedBy']
  pages: number
  actions: number
  blockedHosts: Array<{ host: string; count: number }>
  enforced: string[]
  advisory: string[]
  redactionMisses: number
  runDir: string
  /** what was taken from the website's own branding, in plain words */
  brandNotes?: string[]
  /** what happened with AI clips and music, in plain words */
  mediaNotes?: string[]
  aiClips?: number
  aiMusic?: boolean
  /** what was asked, what was done, and what was not (PARI runs only) */
  pari?: PariReport
  /** everything the video is made of was kept, so it can be changed later without recording again */
  editable?: boolean
}

export class RunCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

export async function runAppRecording(inp: RunInput, hooks: RunHooks): Promise<RunOutput> {
  const frame = filmFrame(inp.platform)
  const portrait = frame.height > frame.width
  // a portrait film records the app as a phone shows it (mobile layout, touch); a wide one records a desktop page
  const screen = recordingScreen(frame)
  const device = { width: screen.width, height: screen.height, scale: screen.scale, mobile: screen.mobile }
  const say = (m: string) => hooks.log?.(m)
  if (screen.mobile) say(`Recording the app on a phone screen (${screen.width}×${screen.height}), for a ${frame.width}×${frame.height} film.`)
  mkdirSync(inp.runDir, { recursive: true })
  const check = () => {
    if (inp.signal?.aborted) throw new RunCancelled()
  }
  // every address the person gave in "Your app", startUrl first, without repeats (the same page with a trailing slash is one address)
  const starts = [inp.startUrl, ...(inp.startUrls ?? [])].filter((u, i, all) => all.findIndex((x) => sameAddress(x, u)) === i)
  // ------------------------------------------------------------ PARI: plan (before anything is opened, recorded or paid for)
  let pari: PlanOutcome | null = null
  if (inp.pari && !inp.reuse) {
    hooks.progress('plan', 'Reading your brief')
    try {
      pari = await planStage({ context: inp.context, startUrl: inp.startUrl, startUrls: starts, mode: inp.mode, launch: inp.launch, targetSec: inp.targetSec }, { chat: inp.chat, secrets: inp.vault ? [inp.vault.password, inp.vault.username] : [], say }, inp.pari)
    } catch (err) {
      if (err instanceof PariStopped && inp.signal?.aborted) throw new RunCancelled()
      throw err
    }
    writeFileSync(join(inp.runDir, 'film-plan.json'), JSON.stringify(pari, null, 2))
    check()
  }
  const fp = pari?.plan ?? null
  // words the person ordered at the very start / end ("Start the intro with a question: ...") are the title / closing scene's narration, not a beat over a page
  const framedAsked = fp && inp.mode === 'launch' && inp.launch ? framedWords(fp) : {}
  const fpBeats = fp && (framedAsked.intro || framedAsked.outro) ? withoutFramed(fp) : fp
  const assigned = pari?.assignment ?? {}

  const ctxClean = withoutProductionSentences(inp.context)
  // a numbered list of steps is a script: it is performed exactly, and nothing else is opened
  const agentPages = !!fp && !inp.reuse && agentFilmsPages(fp)
  const script = inp.reuse || agentPages ? null : parseStepScript(ctxClean)
  // the addresses pasted into the brief ("What should the video show?") are pages of the app too, on every path but a typed script
  const promptUrls = script ? [] : readUrls(ctxClean)
  const { guardrails, enforced, advisory } = interpretGuardrails(inp.guardrailText, [...starts, ...promptUrls], inp.checks)
  const gate = new PolicyGate(guardrails)
  const vault = inp.vault ?? { username: '', password: '' }
  const useVault = inp.signIn === 'saved' && !!inp.vault
  const secrets = inp.vault ? [vault.password, vault.username] : []
  const redaction: RedactionConfig = { selectors: [], values: inp.vault ? [vault.password, ...(inp.revealUsername ? [] : [vault.username])] : [], privacy: !!guardrails.privacyMode }
  const scoutDir = join(inp.runDir, 'scout')
  // sentences that ask for AI video are instructions for the media step, never steps to perform on the app
  const ask = parseMediaAsk(inp.context)
  const musicAsk = parseMusicAsk(inp.context)
  const structure = parseStructure(inp.context)
  const reveal = !!inp.revealUsername
  const speech = assigned.voice === 'none' ? null : inp.speech

  const browser = await launch({ ...device, userDataDir: join(inp.runDir, 'profile'), headless: inp.signIn !== 'self' })
  const onAbort = () => void browser.close().catch(() => undefined)
  inp.signal?.addEventListener('abort', onAbort)
  try {
    // ------------------------------------------------------------ explore
    hooks.progress('explore', 'Opening the app')
    const ctx = await browser.createBrowserContext()
    const page = await ctx.newPage()
    await enforcePolicy(page, gate)
    await prepare(page, redaction)
    /** the person acts in a visible window with the same session; when they press Done the app carries on from where they left it */
    const takeOver = async (): Promise<string | void> => {
      const msg = 'You have the controls. Do what you need in the browser window (open the page you want in the video, for example), then press Done.'
      if (inp.signIn === 'self') {
        await hooks.handoff({ reason: 'takeover', url: page.url(), message: msg })
        await settle(page)
        return page.url()
      }
      const toParam = (c: Cookie) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })
      let win: Browser | null = null
      try {
        win = await launch({ ...device, userDataDir: join(inp.runDir, 'profile-takeover'), headless: false })
        const wctx = await win.createBrowserContext()
        const wp = await wctx.newPage()
        if (screen.mobile) await asPhone(wp)
        const mine = await ctx.cookies()
        if (mine.length) await wp.setCookie(...mine.map(toParam))
        await wp.goto(page.url(), { waitUntil: 'load', timeout: 30000 }).catch(() => undefined)
        await hooks.handoff({ reason: 'takeover', url: wp.url(), message: msg })
        const where = wp.url()
        const theirs = await wctx.cookies()
        if (theirs.length) await page.setCookie(...theirs.map(toParam))
        if (gate.hostAllowed(where)) {
          await page.goto(where, { waitUntil: 'load', timeout: 30000 }).catch(() => undefined)
          await settle(page)
          return where
        }
      } catch (err) {
        if (err instanceof RunCancelled) throw err
        say(`Take over could not open a window: ${(err as Error).message}`)
      } finally {
        await win?.close().catch(() => undefined)
        await removeQuietly(join(inp.runDir, 'profile-takeover'))
      }
    }
    if (!(await openPage(page, inp.startUrl, 30000))) throw new Error(BROWSER_CHECK)
    const compat = await checkCompatibility(page)
    hooks.progress('explore', `Compatibility: ${compat.reason}`)
    if (compat.level === 'unlikely') throw new Error(`This app probably cannot be recorded. ${compat.reason}`)
    check()

    const first = await scoutPage(page, scoutDir, 'p0-start', { revealIdentifiers: reveal })
    // the website's own logo and colours, read from the page it opens on (before anything is typed or clicked)
    let site: SiteBrand | undefined
    if (inp.siteBrand) {
      hooks.progress('explore', "Reading the website's logo and colours")
      site = await captureSiteBrand(page, { dir: inp.runDir, siteHost: new URL(page.url()).hostname, log: say }).catch((err) => ({ colors: [], notes: [`Branding from the website could not be read (${(err as Error).message.slice(0, 80)}), so the video uses its normal look.`] }) as SiteBrand)
      for (const n of site.notes) say(n)
      await page.evaluate(() => scrollTo(0, 0)).catch(() => undefined)
    }
    const brand = site ? { accent: site.accent, logo: site.logo } : inp.brand
    // reference pictures the person chose win for the backdrop; otherwise the brand (the site's or the kit's colour) tints it
    const look = inp.look ?? site?.look ?? (!site && inp.brand?.accent ? (lookFromPalette([`#${inp.brand.accent}`]) ?? undefined) : undefined)
    const pages: AppPage[] = [first]
    let map = buildAppMap(inp.startUrl, pages)
    // the sign-in is often one click away from the page the app opens on
    if (!map.login.detected && inp.signIn !== 'none') {
      const door = first.controls.find((c) => SIGN_IN_LINK.test(c.label.trim()) && (!c.href || gate.hostAllowed(c.href)) && gate.peekClick({ label: c.label, kind: c.kind, href: c.href }).allow)
      if (door) {
        hooks.progress('explore', `Opening "${door.label.trim()}"`)
        if (door.kind === 'link' && door.href) {
          if (!(await openPage(page, door.href))) throw new Error(BROWSER_CHECK)
        } else {
          await page.click(door.selector).catch(() => undefined)
          await passInterstitial(page)
          await settle(page)
        }
        pages.push(await scoutPage(page, scoutDir, 'p0-sign-in', { revealIdentifiers: reveal }))
        map = buildAppMap(inp.startUrl, pages)
      }
    }
    const L = map.login
    if (inp.signIn === 'saved' && inp.vault && !(L.detected && L.usernameSelector && L.passwordSelector && L.submitSelector)) {
      throw new Error(
        `No sign-in form was found at ${displayHost(inp.startUrl)}, so the saved login could not be used and no video was made. ` +
          `The page that opened is "${first.title || first.url}". Put the address of the sign-in page in "Your app", choose "I'll sign in myself", or choose "No sign-in needed" if the app is public.`
      )
    }
    let signedIn = false

    if (L.detected && useVault && L.usernameSelector && L.passwordSelector && L.submitSelector) {
      hooks.progress('explore', 'Signing in (attempt 1 of 2)')
      const r = await runPlaybook(
        page,
        {
          version: 1,
          title: 'sign-in',
          startUrl: inp.startUrl,
          steps: [
            { id: 'l1', beat: 0, kind: 'type', selector: L.usernameSelector, label: 'username', text: '{{secret:username}}' },
            { id: 'l2', beat: 0, kind: 'type', selector: L.passwordSelector, label: 'password', text: '{{secret:password}}' },
            { id: 'l3', beat: 0, kind: 'click', selector: L.submitSelector, label: L.submitLabel, intent: 'login-submit', expect: { selectorGone: L.passwordSelector } }
          ]
        },
        { vault: { username: vault.username, password: vault.password }, gate, redaction, pace: 0, log: say }
      )
      if (!r.ok) throw new Error(`Signing in did not work (${r.failure}). Check the username and password, or choose "I'll sign in myself".`)
      await settle(page)
      const after = await scoutPage(page, scoutDir, 'p0-after-login', { revealIdentifiers: reveal })
      if (after.fields.some((f) => f.kind === 'otp')) {
        hooks.progress('explore', 'The app asks for a one-time code')
        await hooks.handoff({ reason: 'code', url: page.url(), message: 'Type the one-time code in the browser window, then press Done.' })
      }
      signedIn = true
    } else if (L.detected && inp.signIn === 'self') {
      hooks.progress('explore', 'Waiting for you to sign in')
      await hooks.handoff({ reason: 'sign-in', url: page.url(), message: 'Sign in to the app in the browser window, then press Done.' })
      await settle(page)
      signedIn = true
    }
    check()
    // the address the person gave is where the video is meant to be: go back to it once signed in
    if (signedIn && !sameAddress(page.url(), inp.startUrl) && !sameAddress(L.pageUrl ?? '', inp.startUrl)) {
      hooks.progress('explore', 'Opening the page you asked for')
      await openPage(page, inp.startUrl).catch(() => false)
      // an app that sends a signed-in person elsewhere is left where it put them
    }

    // the other addresses the person gave in "Your app": each is scouted too, so the plan knows what every one offers
    if (!inp.reuse) {
      for (let i = 0; i < starts.length - 1; i++) {
        check()
        const url = starts[i + 1]
        hooks.progress('explore', `Opening the other address you gave (${i + 2} of ${starts.length})`)
        try {
          if (await openPage(page, url, 30000)) pages.push(await scoutPage(page, scoutDir, `p0-extra-${i}`, { revealIdentifiers: reveal }))
          else say(`The other address ${url} could not be opened (its "checking your browser" page never went away), so it is left out.`)
        } catch (err) {
          say(`The other address ${url} could not be opened (${String((err as Error)?.message ?? err).slice(0, 80)}), so it is left out.`)
        }
      }
      // the flow below starts where it always did, on the address the film is built around
      if (starts.length > 1) await openPage(page, inp.startUrl).catch(() => false)
    }

    let scriptOut = null as ScriptOutcome | null
    let beganAt = ''
    // goals: a brief that says what to show instead of which buttons to press. The pages of the plan become steps, and each goal is
    // worked out on the real page (goalPlanner.ts); a typed list that holds a goal step is performed the same way, in its order
    let goalScript: StepScript | null = !inp.reuse && !script && fp && goalSegments(fp).length ? scriptFromPlan(fp) : null
    let doneScript = null as StepScript | null
    let goalReports = [] as GoalReport[]
    const runSteps = async (s: StepScript): Promise<void> => {
      beganAt = page.url()
      const g = await performWithGoals({ page, gate, script: s, log: say, signal: inp.signal, vision: visionPicker(inp.chat), chat: inp.chat, brief: ctxClean, secrets, known: [...pages] })
      scriptOut = g.outcome
      doneScript = g.script
      goalReports = g.reports
      if (g.outcome.failure) {
        if (inp.signal?.aborted) throw new RunCancelled()
        throw new Error(g.outcome.failure)
      }
      pages.push(await scoutPage(page, scoutDir, 'p-steps-end', { revealIdentifiers: reveal }))
    }
    const directives = inp.reuse || script || goalScript || agentPages ? [] : parseDirectives(ctxClean)
    const scripted = directives.some((d) => d.kind === 'type') || (directives.length > 0 && /->|→|=>|⇒|➜|>>/.test(ctxClean))
    if (directives.length) say(`Steps you asked for: ${directives.map((d) => (d.kind === 'open' ? `open "${d.target}"` : `type "${d.text}" into "${d.into || 'the search box'}"`)).join(', then ')}`)

    let exploration: Exploration = { visits: [], actions: 0, stoppedBy: 'done', elapsedMs: 0 }
    let acted: ActOutcome | null = null
    let reused: Plan | null = null
    const reuseNotes: string[] = []
    const pause = async (): Promise<string | void> => {
      if (!inp.control?.takeover) return
      inp.control.takeover = false
      return takeOver()
    }
    if (inp.reuse) {
      await pause()
      // the saved steps are run once, fast, to see which still work; only the ones that broke are changed
      hooks.progress('explore', 'Checking the saved steps against the app as it is now')
      const isLogin = (st: Step) => st.intent === 'login-submit' || /\{\{secret:/.test(st.text ?? '')
      const saved = inp.reuse.playbook
      // the sign-in beats are left out (the person is already signed in), and so is the page they start on
      const signInBeats = new Set(inp.reuse.beats.filter((b) => b.kind.startsWith('login')).map((b) => b.beat))
      const probe: Playbook = { ...saved, steps: saved.steps.filter((st) => !isLogin(st) && !signInBeats.has(st.beat)) }
      const rr = await runPlaybook(page, probe, {
        vault: { username: vault.username, password: vault.password },
        gate, redaction, pace: 0, repair: true, log: say,
        afterBeat: async (b) => { pages.push(await scoutPage(page, scoutDir, `p-check-${b}`, { revealIdentifiers: reveal })) }
      })
      if (!rr.ok || !rr.playbook) throw new Error(`The saved steps could not be checked (${rr.failure}). Make the video again without reusing them.`)
      const fixed = new Map(rr.playbook.steps.map((st) => [st.id, st]))
      const probeIds = new Set(probe.steps.map((st) => st.id))
      const steps = saved.steps.filter((st) => !probeIds.has(st.id) || fixed.has(st.id)).map((st) => fixed.get(st.id) ?? st)
      const live = new Set(steps.map((st) => st.beat))
      reused = { ...inp.reuse, playbook: { ...saved, steps }, beats: inp.reuse.beats.filter((b) => live.has(b.beat)) }
      reuseNotes.push(...(rr.repairs?.length ? rr.repairs.map((r) => `Repaired: ${r}`) : ['The saved steps still work, so none were changed.']))
      hooks.progress('explore', rr.repairs?.length ? `${rr.repairs.length} saved step(s) needed repair` : 'All saved steps still work')
      await settle(page)
    } else if (agentPages && fp && inp.pari) {
      await pause()
      // ACT: every page the plan names is opened behind the gate, in the person's order; a failure is retried, substituted or put to the person
      hooks.progress('explore', `Opening the ${fp.segments.filter((s) => s.kind === 'page').length} pages your brief names`)
      acted = await actStage({ page, plan: fpBeats ?? fp, gate, outDir: scoutDir, startUrl: inp.startUrl, known: [...pages], startBeat: signedIn && useVault ? 1 : 0, say, hooks: inp.pari, check, signedIn,
        targetSec: inp.targetSec ?? inp.launch?.targetSec,
        // a fresh, signed-out page behind the same gate: the recording signs in itself, so public pages are filmed before it
        publicPage: useVault ? async () => { const c = await browser.createBrowserContext(); const p = await c.newPage(); await enforcePolicy(p, gate); await prepare(p, redaction); return p } : undefined })
      for (const a of acted.acted.values()) pages.push(a.reached)
      if (!acted.acted.size) {
        // names that are not links and were no address are goals (what to show), not pages: they are worked out on the app's own page
        // instead of stopping the run. Only an address the person gave that would not open is a reason to stop.
        const asGoals = !fp.segments.some((s) => s.kind === 'page' && s.url) && [...acted.skipped.values()].some((s) => s.notALink)
        if (!asGoals) throw new Error(`None of the pages in your brief could be opened, so no video was made: ${[...acted.skipped.values()].map((s) => s.why).join('; ')}.`)
        say('The names in the brief are not links in the app: they are worked out as things to show on the page.')
        acted = null
        goalScript = scriptFromPlan(fp, { asGoals: true })
        hooks.progress('explore', `Working out ${goalScript.items.length} thing${goalScript.items.length === 1 ? '' : 's'} to show`)
        await runSteps(goalScript)
      }
    } else if (script || goalScript) {
      await pause()
      const todo = (script ?? goalScript) as StepScript
      hooks.progress('explore', script ? `Doing your ${todo.items.filter((i) => !i.login).length} steps, exactly as written` : `Working out ${todo.items.length} thing${todo.items.length === 1 ? '' : 's'} to show`)
      await runSteps(todo)
    } else {
      hooks.progress('explore', 'Exploring the app')
      exploration = await explore({ page, gate, startUrl: inp.startUrl, extraStarts: [...starts.slice(1), ...promptUrls], outDir: scoutDir, depth: inp.depth, revealIdentifiers: reveal, log: say, signal: inp.signal, pause, directives, scripted, topics: readUseCase(ctxClean).topics })
      pages.push(...exploration.visits.map((v) => v.page))
      // a typed step that could not be done stops the run here, before anything is recorded or paid for
      const missed = (exploration.asked ?? []).filter((a) => !a.done)
      const hard = missed.filter((a) => a.directive.kind === 'type')
      if (hard.length && exploration.stoppedBy !== 'cancelled') {
        throw new Error(`A step you asked for could not be done, so no video was made: ${hard.map((a) => `"${a.directive.said}" (${a.why})`).join('; ')}. Reword the step with the name the box has on screen, or use Take over to open the right page.`)
      }
    }
    check()
    map = buildAppMap(inp.startUrl, pages)
    const safeMap = scrubMap(map, { values: secrets, kinds: guardrails.privacyMode ? undefined : ['token', 'card', 'ssn', 'secret'] })
    writeFileSync(join(inp.runDir, 'app-map.json'), JSON.stringify(safeMap, null, 2))
    const cookies = inp.signIn === 'self' ? await ctx.cookies() : []
    hooks.progress('explore', acted ? `Planned ${acted.steps.length} step(s) across ${acted.acted.size} page(s)` : scriptOut ? `Did ${scriptOut.results.filter((r) => !r.item.login).length} step(s) with ${scriptOut.actions} action(s)` : `Explored ${exploration.visits.length} page(s) with ${exploration.actions} action(s)`)

    // ------------------------------------------------------------ plan
    hooks.progress('plan', 'Choosing what the video shows')
    let plan: Plan = acted
      ? pariPlan(acted, { startUrl: inp.startUrl, login: signedIn && useVault ? L : null, title: fp?.product || displayHost(inp.startUrl) })
      : reused
      ? { ...reused, notes: [...reused.notes.filter((n) => !n.startsWith('Repaired: ') && !n.startsWith('The saved steps') && !/explored page/.test(n)), ...reuseNotes] }
      : scriptOut && doneScript
        ? scriptPlan({ script: doneScript, outcome: scriptOut, map: safeMap, startUrl: inp.startUrl, beganAt, hasVault: useVault, secrets })
        : planBeats({ map: safeMap, exploration, context: ctxClean, startUrl: inp.startUrl, targetSec: inp.targetSec ?? inp.launch?.targetSec, hasVault: useVault, secrets, scripted })
    if (goalReports.length) {
      // scriptPlan counts the actions worked out for a goal as steps of their own: say it as it was
      plan.notes[0] = `Your steps were carried out in order. ${goalReports.length === 1 ? 'One of them was a goal' : `${goalReports.length} of them were goals`} (what to show, not what to press): the engine worked out the actions for ${goalReports.length === 1 ? 'it' : 'them'} on the real page. What it decided to show and why, and what it could not do, is listed below.`
      plan.notes.push(...goalReports.flatMap(goalNotes))
    }
    writeFileSync(join(inp.runDir, 'playbook.json'), JSON.stringify(plan.playbook, null, 2))
    writeFileSync(join(inp.runDir, 'beats.json'), JSON.stringify(plan.beats, null, 2))
    const base: RunOutput = {
      plan, map: safeMap, compat, stoppedBy: exploration.stoppedBy, pages: scriptOut ? scriptOut.results.length : exploration.visits.length, actions: exploration.actions,
      blockedHosts: gate.blockedHosts(), enforced, advisory, redactionMisses: 0, runDir: inp.runDir, brandNotes: site?.notes ?? []
    }
    if (inp.stopAfter === 'explore' || inp.stopAfter === 'plan') return base
    if ((inp.reviewFirst || advisory.length) && hooks.review) {
      hooks.progress('plan', 'Waiting for your review of the steps')
      const edited = await hooks.review(plan, advisory)
      if (!edited) throw new RunCancelled()
      plan = edited
      writeFileSync(join(inp.runDir, 'playbook.json'), JSON.stringify(plan.playbook, null, 2))
    }
    check()

    // ------------------------------------------------------------ script
    hooks.progress('script', 'Writing and voicing the script')
    // which AI clips the film will have (so the story is written around them): only when they can really be made
    // the plan's clips replace the keyword-matched ones; the person's model choice can switch them off
    if (fp) {
      ask.requests = clipRequests(fp)
      ask.style = fp.look.style === 'infographic' || fp.segments.some((s) => s.kind === 'ai-clip' && s.style === 'infographic') ? 'infographic' : null
      ask.noAbstract = fp.look.noAbstract
      if (assigned.video === 'none' || assigned.video === 'skip') ask.requests = []
    }
    const clipsPossible = !!inp.media?.tools && !ask.declined
    const clipPlaces: Placement[] = !clipsPossible ? [] : ask.requests.length ? [...new Set(ask.requests.map((r) => r.placement))] : inp.media?.clips && !fp ? ['start'] : []
    const problemAsked = fp ? wantsProblemCard(fp, clipsPossible && ask.requests.some((r) => r.part === 'problem')) : structure.problem
    const narration = await narrate({ chat: inp.chat, speech, beats: plan.beats, mode: inp.mode, launch: inp.launch, context: fpBeats ? narrationBrief(fpBeats) : ctxClean, secrets, targetSec: inp.targetSec, styleDirection: inp.styleDirection, brand: brand || look ? { accent: brand?.accent ?? look?.accent.slice(1), logo: brand?.logo } : undefined, problem: problemAsked, clips: clipPlaces, voiceStyle: fp?.voice.tone, opening: framedAsked.intro, closing: framedAsked.outro, product: inp.launch?.feature.split(/\s+/)[0]?.replace(/['\u2019]s$/i, ''), dir: inp.runDir, say })
    // a result the person asked to see stays on screen long enough to be taken in, whatever the narration length
    for (const b of plan.beats) if ((b.kind === 'result' || b.kind === 'detail') && (narration.minSec.get(b.beat) ?? 0) < RESULT_HOLD_SEC) narration.minSec.set(b.beat, RESULT_HOLD_SEC)
    check()

    // ------------------------------------------------------------ record
    hooks.progress('record', inp.signIn === 'saved' ? 'Recording (signing in again, attempt 2 of 2)' : 'Recording')
    // what the scout found to be sensitive (a login name, an email box) is blurred in every frame
    const recRedaction: RedactionConfig = { ...redaction, selectors: map.sensitiveSelectors }
    const rctx = await browser.createBrowserContext()
    const rpage: Page = await rctx.newPage()
    await enforcePolicy(rpage, gate)
    await prepare(rpage, recRedaction)
    if (cookies.length) await rpage.setCookie(...cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite })))
    // a browser check is waited out before the camera rolls, so it is never in the film
    if (!(await openPage(rpage, plan.playbook.startUrl, 30000))) throw new Error(BROWSER_CHECK)
    await new Promise((r) => setTimeout(r, 400))
    const rec = new FrameRecorder(rpage, join(inp.runDir, 'frames'))
    await rec.start(Math.round(screen.width * screen.scale), Math.round(screen.height * screen.scale), { sharp: screen.mobile })
    const run = await runPlaybook(rpage, plan.playbook, { vault: { username: vault.username, password: vault.password }, gate, redaction: recRedaction, recorder: rec, beatMinSec: narration.minSec, pace: 1, log: say })
    await new Promise((r) => setTimeout(r, 1300))
    const framed = await rec.stop()
    const take: Take = { fps: 30, viewport: { width: screen.width, height: screen.height }, durationSec: framed.durationSec, beats: run.beats, navigations: run.navigations, log: run.log, redactionMisses: run.redactionMisses }
    writeFileSync(join(inp.runDir, 'take.json'), JSON.stringify({ ...take, frames: framed.frameCount }, null, 2))
    writeFileSync(join(inp.runDir, 'policy-audit.json'), JSON.stringify(gate.audit.filter((a) => !a.allow || a.kind === 'click'), null, 2))
    if (!run.ok) throw new Error(`Recording stopped: ${run.failure}`)
    if (take.redactionMisses > 0) throw new Error('Something private was not hidden in the recording, so no video was made. Turn on "Hide personal data in tables and lists" and try again.')
    if (inp.stopAfter === 'record') return { ...base, plan, redactionMisses: 0 }
    check()

    // ------------------------------------------------------------ AI media (only now: the recording is verified, so nothing is paid for in vain)
    const mediaNotes: string[] = []
    // steps the recording could not do are left out and said, never a silent hole in the film
    for (const k of run.skipped ?? []) mediaNotes.push(`A step was skipped while filming (${k.label || k.step}): ${k.why}.`)
    for (const k of run.stuck ?? []) mediaNotes.push(`Parts ${k.from + 1} to ${k.to + 1} of the film stayed on one screen although steps were done in them, so the voice may describe things that are not shown there.`)
    const motif = pickMotif(`${inp.launch ? `${inp.launch.feature} ${inp.launch.tagline}` : ''} ${ctxClean}`)
    const inserts: InsertPlan[] = []
    const tools = inp.media?.tools ?? null
    const askedClips = ask.requests.length > 0
    const lengthSec = inp.targetSec ?? inp.launch?.targetSec ?? 44
    if (ask.declined) mediaNotes.push('You wrote that you do not want an AI video, so none was made.')
    else if (askedClips && !tools) mediaNotes.push('You asked for an AI video, but AI media is not available for this video (the AI option is off, the plan does not include it, or no Gemini key is set), so it was made without one.')
    else if (inp.media?.clips && !tools) mediaNotes.push('AI video clips were ticked, but AI media is not available for this video, so it was made without them.')
    const clipsMade = new Map<string, number>()
    if (tools && !ask.declined && (askedClips || (inp.media?.clips && !fp))) {
      hooks.progress('produce', 'Making AI video clips')
      const sec = clipSeconds(lengthSec)
      const topic = inp.launch ? `${inp.launch.feature}${inp.launch.tagline ? ` - ${inp.launch.tagline}` : ''}` : (ctxClean.split('\n').map((l) => l.trim()).find((l) => l.length > 12 && !/^(?:(?:step\s*)?\d{1,2}\s*[.):-]|[-*])\s/i.test(l) && !/:$/.test(l)) ?? '').slice(0, 200)
      // what the app does, from the beats of the film itself: the writer builds its visual metaphor from these
      const clipFacts = [...new Set(plan.beats.flatMap((b) => b.facts))].filter((f) => f.length > 8).slice(0, 14)
      const planned = await planMedia({ chat: inp.chat, requests: ask.requests, auto: !!inp.media?.clips, appName: displayHost(inp.startUrl), topic, brand: look ? { accent: look.accent.replace('#', ''), backdrop: look.backdrop } : brand?.accent ? { accent: brand.accent } : undefined, motif, lines: narration.clipLines, facts: clipFacts, subjectHint: inp.launch ? `${inp.launch.feature}: ${inp.launch.tagline}` : undefined, style: ask.style, noAbstract: ask.noAbstract, context: ctxClean, mode: inp.mode, secrets, say })
      const totalClipSec = planned.reduce((a, c) => a + (c.seconds ?? clipLength(sec, planned.length, lengthSec)), 0)
      say(`AI video: ${planned.length} clip${planned.length === 1 ? '' : 's'}, about ${totalClipSec} seconds in all (roughly $${(totalClipSec * 0.1).toFixed(2)})${ask.style ? `, in the ${ask.style} look you asked for` : ''}.`)
      const tone = voiceTone(inp.mode === 'launch', fp?.voice.tone)
      const middle = (): number => plan.beats[Math.max(0, Math.ceil(plan.beats.length / 2) - 1)]?.beat ?? 0
      const where = (p: Placement): InsertPlan['at'] => (p === 'start' ? { kind: 'start' } : p === 'end' ? { kind: 'end' } : { kind: 'afterBeat', beat: middle() })
      const clipSec1 = clipLength(sec, planned.length, lengthSec)
      let n = 0
      for (const c of planned) {
        check()
        const secs = c.seconds ?? clipSec1
        say(`AI clip ${n + 1} of ${planned.length} (${secs}s): ${c.said.slice(0, 100)}`)
        try {
          const start = await openingPicture(tools, c.prompt, n, mediaNotes, inp.signal, portrait, ask.style)
          if (start.skip) continue
          const imageFile = start.imageFile
          const made = await tools.clip(c.prompt, secs, { ...(imageFile ? { imageFile } : {}), portrait })
          const clipSec = made.durationSec ?? probe(made.file).durationSec ?? sec
          mkdirSync(join(inp.runDir, 'final'), { recursive: true })
          const pcm = await voiceLine(narration.plans.some((p) => p.pcm.length) ? speech : null, join(inp.runDir, 'final'), `voice-clip-${n}`, c.line, tone).catch((err) => {
            mediaNotes.push(`The voice for an AI clip could not be made (${String((err as Error)?.message ?? err).slice(0, 120)}), so it shows only as subtitles.`)
            return new Float32Array(0)
          })
          inserts.push({ at: where(c.placement), file: made.file, clipSec, text: c.line, pcm, tag: 'AI-generated illustration' })
          clipsMade.set(c.said.slice(0, 400), (clipsMade.get(c.said.slice(0, 400)) ?? 0) + clipSec)
          mediaNotes.push(`AI clip (${c.placement === 'start' ? 'at the start' : c.placement === 'end' ? 'at the end' : 'in the middle'}): ${c.said.slice(0, 120)}`)
          n++
        } catch (err) {
          if (err instanceof RunCancelled || inp.signal?.aborted) throw err
          mediaNotes.push(`An AI clip could not be made (${String((err as Error)?.message ?? err).slice(0, 140)}), so the video goes on without it.`)
        }
      }
    }
    let musicChoice: Awaited<ReturnType<typeof chooseMusic>> | undefined
    // a written music wish (nature sounds, no instruments) is an instruction, like a written AI video request
    // PARI: the plan's music and the model the person approved win over the keyword rules
    const planMusic = fp && !fp.music.none && fp.music.description ? fp.music : null
    const aiMusicModel = assigned.music && !/^(?:none|builtin)/.test(assigned.music) ? assigned.music : undefined
    const musicWish = !planMusic && !!musicAsk && !musicAsk.none && (musicAsk.sounds.length > 0 || musicAsk.noInstruments)
    // natural sounds are made on this PC: free, instrument-free, and they cannot fail the way a music model does
    const ambience = musicWish ? soundsFromWords(musicAsk!.sounds) : undefined
    const noMusic = fp ? fp.music.none || assigned.music === 'none' : !!musicAsk?.none
    const wantAiMusic = fp ? !!aiMusicModel && !noMusic : inp.media?.music && !musicWish && !(musicAsk?.none)
    if (noMusic) mediaNotes.push(fp && !fp.music.none ? 'You chose no music, so the film has voice only.' : 'You wrote that you do not want music, so the film has voice only.')
    if (tools && wantAiMusic && planMusic) {
      musicChoice = { mood: inp.mode === 'launch' ? 'upbeat' : 'cinematic', style: planMusic.description, why: `as your brief asks (${aiMusicModel})` }
      say(`AI music (${aiMusicModel}): ${planMusic.description}`)
    } else if (tools && wantAiMusic) {
      musicChoice = await chooseMusic({ ask: musicAsk, chat: inp.chat, context: inp.context, mode: inp.mode, targetSec: lengthSec, styleMood: inp.musicMood, styleDirection: inp.styleDirection, secrets, say })
      say(`AI music: ${musicChoice.mood}${musicChoice.style ? ` — ${musicChoice.style}` : ''} (${musicChoice.why})`)
    } else if (inp.media?.music && !musicAsk?.none && !musicWish) mediaNotes.push('AI music was ticked, but it is not available for this video (the AI option is off, the plan does not include it, or no Gemini key is set), so the built-in score plays.')
    check()

    // ------------------------------------------------------------ the title and closing backgrounds: designed by the AI for this film, never a template
    hooks.progress('produce', 'Designing the opening and closing backgrounds')
    const sceneSecs = { title: 6, outro: 6 }
    const designed = await designFilmBackgrounds({
      chat: inp.chat,
      library: inp.introLibrary === undefined ? new IntroBackgroundLibrary(introBackgroundsDir) : inp.introLibrary,
      dir: join(inp.runDir, 'intro-background'),
      size: frame,
      topic: inp.launch ? `${inp.launch.feature}: ${inp.launch.tagline}` : plan.playbook.title,
      product: inp.launch?.feature ?? plan.playbook.title,
      about: ctxClean,
      narration: [narration.introText, ...narration.lines.map((l) => l.text), narration.outroText].filter(Boolean).join(' '),
      title: { pill: narration.intro?.pill, headline: narration.intro?.headline ?? plan.playbook.title, sub: narration.intro?.sub },
      outro: narration.outro ? { pill: narration.outro.pill, headline: narration.outro.headline, sub: narration.outro.sub } : undefined,
      hasLogo: !!(narration.intro?.logo && existsSync(narration.intro.logo)),
      logo: narration.intro?.logo && existsSync(narration.intro.logo) ? narration.intro.logo : undefined,
      accent: look?.accent.replace('#', '') ?? brand?.accent,
      backdrop: look?.backdrop,
      style: inp.styleDirection ?? null,
      mood: inp.mode === 'launch' ? 'upbeat' : 'corporate',
      pictures: pages.map((p) => (p.screenshot ? join(scoutDir, p.screenshot) : '')).filter((f) => f && existsSync(f)).slice(0, 3),
      titleSec: sceneSecs.title,
      outroSec: sceneSecs.outro,
      drawnName: motif,
      signal: inp.signal,
      say
    })
    check()
    mediaNotes.push(...designed.notes)
    // what the scenes sit on is kept with the run, so a later change to the film re-renders them on the same backgrounds
    for (const k of ['title', 'outro'] as const) if (designed[k]) writeFileSync(join(inp.runDir, `intro-background-${k}.json`), JSON.stringify(designed[k], null, 2))
    // ------------------------------------------------------------ produce
    hooks.progress('produce', inserts.length || musicChoice ? 'Making the video, with AI media' : 'Making the video')
    const res = await produce({
      dir: join(inp.runDir, 'final'),
      size: frame,
      framesList: framed.listFile,
      offsetSec: rec.offsetSec(),
      take,
      beats: narration.plans,
      title: inp.mode === 'launch' && inp.launch ? `${inp.launch.feature} launch` : plan.playbook.title,
      musicMood: musicChoice?.mood ?? inp.musicMood ?? (inp.mode === 'launch' ? 'upbeat' : 'corporate'),
      inserts,
      log: say,
      aiMusic:
        musicChoice && tools
          ? async ({ total, cuts }) => {
              const stub = { musicMood: musicChoice!.mood, style: 'social', design: { look: 'social' }, voiceover: narration.plans.some((p) => p.pcm.length) ? [1] : [], narration: [] } as unknown as VideoSpec
              const voiced = narration.plans.some((p) => p.pcm.length)
              const brief = planMusic ? musicPrompt(planMusic, total, voiced) : musicChoice!.ambient ? ambientBrief(musicChoice!, total, voiced) : musicBrief(stub, cuts, total)
              if (!brief) return null
              const audio = await tools.music(planMusic || musicChoice!.ambient ? brief : withStyle(brief, musicChoice!.style), aiMusicModel)
              const file = join(inp.runDir, 'final', 'ai-music.mp3')
              writeFileSync(file, audio)
              return decodeStereo(file)
            }
          : undefined,
      intro: narration.intro,
      problem: narration.problem,
      outro: narration.outro,
      noBuiltinMusic: noMusic,
      ambience,
      musicLevel: musicAsk?.quiet ? 0.45 : undefined,
      motif,
      backgrounds: designed.title ? { title: designed.title, outro: designed.outro } : undefined,
      targetSec: inp.mode === 'launch' ? inp.launch?.targetSec : undefined,
      keep: false,
      look
    })
    if (musicChoice) mediaNotes.push(res.musicSource === 'ai' ? `AI music: ${musicChoice.ambient ? 'natural sounds' : musicChoice.mood} — ${musicChoice.why}` : `The AI music could not be used${res.musicError ? ` (${res.musicError})` : ''}, so the built-in score plays.`)
    if (res.musicSource === 'ambience') mediaNotes.push(`Background sound: ${musicAsk!.sounds.length ? musicAsk!.sounds.join(', ') : 'natural ambience'}, made on this computer with no instruments, as you asked.`)
    if (res.drawnScenes?.length) mediaNotes.push(`The ${res.drawnScenes.join(', ')} scene${res.drawnScenes.length === 1 ? ' is' : 's are'} animated around a "${motif}" motif (the drawn template, the last resort), because no AI background could be made for ${res.drawnScenes.length === 1 ? 'it' : 'them'}.`)
    if (narration.problem) mediaNotes.push('Problem statement added after the opening, as you asked (written by the engine from your words).')
    // ------------------------------------------------------------ keep what the video is made of, so changes can be typed later without recording again
    let editable = false
    try {
      const cardRec = (c: CardPlan | undefined, voice: string): RecordedCard | undefined =>
        c ? { pill: c.pill, headline: c.headline, sub: c.sub, text: c.text, accent: c.accent, logo: adoptFile(c.logo, inp.runDir), voice: findVoice(inp.runDir, voice) } : undefined
      writeRecordingRecord(inp.runDir, {
        version: 1,
        mode: inp.mode,
        launch: inp.launch,
        platform: inp.platform,
        size: frame,
        offsetSec: rec.offsetSec(),
        title: inp.mode === 'launch' && inp.launch ? `${inp.launch.feature} launch` : plan.playbook.title,
        targetSec: inp.targetSec ?? inp.launch?.targetSec,
        context: scrubText(ctxClean, { values: secrets }).slice(0, 4000),
        styleDirection: inp.styleDirection,
        tone: voiceTone(inp.mode === 'launch', fp?.voice.tone),
        voiced: narration.plans.some((p) => p.pcm.length > 0),
        lines: narration.plans.map((p) => ({ beat: p.beat, chapter: p.chapter, text: p.text, voice: findVoice(inp.runDir, `voice-${p.beat}`) })),
        intro: cardRec(narration.intro, 'voice-intro'),
        problem: cardRec(narration.problem, 'voice-problem'),
        outro: cardRec(narration.outro, 'voice-outro'),
        inserts: inserts
          .map((ins, k) => ({ at: ins.at, file: adoptFile(ins.file, inp.runDir) ?? '', clipSec: ins.clipSec, text: ins.text, tag: ins.tag, voice: findVoice(inp.runDir, `final/voice-clip-${k}`) }))
          .filter((i) => i.file),
        music: {
          source: res.musicSource,
          mood: musicChoice?.mood ?? inp.musicMood ?? (inp.mode === 'launch' ? 'upbeat' : 'corporate'),
          style: planMusic?.description ?? musicChoice?.style,
          file: res.musicSource === 'ai' && existsSync(join(inp.runDir, 'final', 'ai-music.mp3')) ? 'final/ai-music.mp3' : undefined,
          sounds: res.musicSource === 'ambience' ? ambience : undefined,
          model: aiMusicModel,
          level: musicAsk?.quiet ? 0.45 : undefined
        },
        motif,
        introBackground: designed.title ? { title: `intro-background-title.json`, outro: designed.outro ? `intro-background-${designed.results.outro?.background ? 'outro' : 'title'}.json` : undefined } : undefined,
        look,
        raw: 'final/raw.mp4'
      })
      editable = true
    } catch (err) {
      say(`(This video could not be saved for later changes: ${String((err as Error)?.message ?? err).slice(0, 120)})`)
    }
    // ------------------------------------------------------------ PARI: review, and the honest report
    let report: PariReport | undefined
    if (fp && inp.pari) {
      const lines = [narration.introText ?? '', ...narration.lines.map((l) => l.text), narration.problem?.text ?? '', ...inserts.map((i) => i.text ?? ''), narration.outroText ?? ''].filter(Boolean)
      const planClips = fp.segments.some((s) => s.kind === 'ai-clip')
      const clipsSkipped = !planClips ? undefined : assigned.video === 'none' || assigned.video === 'skip' ? 'you chose not to make AI clips' : !tools ? 'AI clips are not available on this account' : undefined
      const checks = reviewStage({ plan: fp, acted, take, clipsMade, clipsSkipped, lines, problemDrawn: !!narration.problem, scripted: scriptOut ? { said: scriptOut.results.filter((r) => !r.item.login).map((r) => r.item.said), actions: scriptOut.actions, choices: scriptOut.results.reduce((n, r) => n + r.picks.length, 0), skipped: [...scriptOut.skipped.map((k) => `step ${k.n}: ${k.what} (${k.why})`), ...(run.skipped ?? []).map((k) => `${k.label || k.step} (${k.why})`)] } : undefined })
      for (const c of checks) inp.pari.emit({ kind: 'pari-check', check: c })
      report = buildReport(fp, pari, checks)
      inp.pari.emit({ kind: 'pari-report', report })
      writeFileSync(join(inp.runDir, 'pari-report.json'), JSON.stringify(report, null, 2))
      mediaNotes.push(...(pari?.notes ?? []).map((n) => `Choice: ${n}`), ...report.shortfalls)
    }
    return { ...base, plan, video: res.file, durationSec: res.durationSec, redactionMisses: take.redactionMisses, mediaNotes, aiClips: inserts.length, aiMusic: res.musicSource === 'ai', pari: report, editable }
  } finally {
    inp.signal?.removeEventListener('abort', onAbort)
    await browser.close().catch(() => undefined)
    // temporary files go once the browser has let go of them; a stubborn file never fails a finished run
    if (!inp.keepFiles) {
      await removeQuietly(join(inp.runDir, 'frames'))
      await removeQuietly(join(inp.runDir, 'profile'))
    }
  }
}

/** the recorder's plan for a PARI run: the sign-in (when the recording signs in) then every page segment's steps, in order */
function pariPlan(acted: ActOutcome, o: { startUrl: string; login: AppMap['login'] | null; title: string }): Plan {
  const steps: Step[] = []
  const beats: Plan['beats'] = []
  const notes = [...acted.notes]
  const L = o.login
  const entries = [...acted.acted.values()]
  const pub = L ? entries.filter((e) => e.public) : []
  const priv = entries.filter((e) => !pub.includes(e))
  // public pages (seen signed out) come first, then the sign-in, then the rest, each in the person's order
  for (const e of pub) {
    steps.push(...e.act.steps)
    beats.push(...e.act.beats)
  }
  if (pub.length && entries.indexOf(pub[pub.length - 1]) > pub.length - 1) notes.push('Public pages are filmed before the sign-in, because the app sends a signed-in person away from them.')
  if (L && L.usernameSelector && L.passwordSelector && L.submitSelector) {
    steps.push(
      { id: 'l1', beat: 0, kind: 'goto', url: L.pageUrl ?? o.startUrl, selector: L.usernameSelector, intent: 'navigate', focus: 'form' },
      { id: 'l2', beat: 0, kind: 'type', selector: L.usernameSelector, label: 'username', text: '{{secret:username}}', focus: 'target' },
      { id: 'l3', beat: 0, kind: 'type', selector: L.passwordSelector, label: 'password', text: '{{secret:password}}', focus: 'target' },
      { id: 'l4', beat: 0, kind: 'click', selector: L.submitSelector, label: L.submitLabel, intent: 'login-submit', expect: { selectorGone: L.passwordSelector }, focus: 'banner' }
    )
    beats.push({ beat: 0, kind: 'login', chapter: 'Signing in', facts: ['The person signs in with a username and a blurred password'], fallback: 'First we sign in. The password stays hidden.', launchFallback: 'Sign in with your account to get started.' })
  }
  for (const e of priv) {
    steps.push(...e.act.steps)
    beats.push(...e.act.beats)
  }
  // beats numbered again in film order (the objects are shared with the review, so it sees the same numbers)
  const loginBeats = new Set(beats.filter((b) => b.kind === 'login'))
  const renumber = new Map<object, number>()
  let k = 0
  const seen = new Map<string, number>()
  for (const st of steps) {
    const key = st.id.startsWith('l') && /^l\d$/.test(st.id) ? 'login' : `${st.id.split('-')[0]}:${st.beat}`
    if (!seen.has(key)) seen.set(key, k++)
    renumber.set(st, seen.get(key)!)
  }
  for (const b of beats) {
    const key = loginBeats.has(b) ? 'login' : `${prefixOfBeat(b, acted)}:${b.beat}`
    b.beat = seen.get(key) ?? b.beat
  }
  for (const st of steps) st.beat = renumber.get(st)!
  const first = steps[0]
  return { playbook: { version: 1, title: o.title, startUrl: first?.kind === 'goto' && first.url ? first.url : o.startUrl, steps }, beats, loginFocus: false, notes }
}

/** which segment's step-id prefix a beat belongs to ("p2") */
function prefixOfBeat(b: Plan['beats'][number], acted: ActOutcome): string {
  for (const e of acted.acted.values()) if (e.act.beats.includes(b)) return e.act.steps[0]?.id.split('-')[0] ?? ''
  return ''
}

const BROWSER_CHECK = 'The site kept showing its "checking your browser" page and never opened the app, so no video was made. Choose "I\'ll sign in myself" so the check runs in a window you can see, or ask whoever runs the site to let this computer through.'
/** the least time the result of a typed step (and what was opened to make the point) is held on screen */
const RESULT_HOLD_SEC = 6.5
/** a link or button that leads to the sign-in form */
const SIGN_IN_LINK = /^(?:login\s+)?(?:log\s?-?in|sign\s?-?in|sign\s?-?on|member\s+login|account\s+login)$/i

function displayHost(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * The same page, whatever the query string or a trailing slash says. A #fragment counts when the wanted address (`b`)
 * has one: on many apps it picks the view the page opens on, and a sign-in redirect drops it.
 */
export function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    if (y.hash.length > 1 && x.hash !== y.hash) return false
    return x.host === y.host && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '')
  } catch {
    return false
  }
}

/** remove a folder, waiting out Windows file locks; gives up quietly */
export async function removeQuietly(path: string, tries = 8): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 400))
    }
  }
}
