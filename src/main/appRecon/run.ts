import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Browser, Cookie, Page } from 'puppeteer-core'
import type { AppMap, AppPage, Playbook, Step, Take } from '@shared/appRecon'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import { enforcePolicy, launch } from './browser'
import { scrubMap } from './detect'
import { parseDirectives, readUseCase } from './directives'
import { checkCompatibility, explore, openPage, passInterstitial, settle, type Depth, type Exploration } from './explore'
import { narrate, voiceLine, type LaunchInfo } from './narrate'
import { planBeats, type Plan } from './planner'
import { interpretGuardrails, PolicyGate, type RestrictionChecks } from './policy'
import { produce, type InsertPlan } from './produce'
import { performScript, scriptPlan, type ScriptOutcome } from './script'
import { parseStepScript } from './stepScript'
import { ambientBrief, chooseMusic, clipSeconds, parseMediaAsk, parseMusicAsk, parseStructure, planMedia, withStyle, withoutProductionSentences, type Placement } from './aiMedia'
import { musicBrief } from '../audio/cue'
import { soundsFromWords } from '../audio/ambience'
import { pickMotif } from './scenes'
import { decodeStereo } from '../audio/pcm'
import { probe } from '../assets/probe'
import type { VideoSpec } from '@shared/spec'
import { FrameRecorder, prepare, runPlaybook } from './recorder'
import type { RedactionConfig } from './redact'
import { buildAppMap, scoutPage } from './scout'
import { captureSiteBrand, type SiteBrand } from './siteBrand'
import { lookFromPalette } from './style'

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
  /** one clip of this many whole seconds (3 to 10); resolves to the file */
  clip(prompt: string, seconds: number): Promise<{ file: string; durationSec?: number }>
  /** one finished track (an audio file's bytes) for this brief */
  music(brief: string): Promise<Buffer>
}

export type Stage = 'explore' | 'plan' | 'script' | 'record' | 'produce'

export interface RunInput {
  runDir: string
  startUrl: string
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
}

export class RunCancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

export async function runAppRecording(inp: RunInput, hooks: RunHooks): Promise<RunOutput> {
  const say = (m: string) => hooks.log?.(m)
  mkdirSync(inp.runDir, { recursive: true })
  const check = () => {
    if (inp.signal?.aborted) throw new RunCancelled()
  }

  const { guardrails, enforced, advisory } = interpretGuardrails(inp.guardrailText, inp.startUrl, inp.checks)
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
  // the same goes for sentences about the music and the shape of the film
  const ctxClean = withoutProductionSentences(inp.context)
  const reveal = !!inp.revealUsername

  const browser = await launch({ userDataDir: join(inp.runDir, 'profile'), headless: inp.signIn !== 'self' })
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
        win = await launch({ userDataDir: join(inp.runDir, 'profile-takeover'), headless: false })
        const wctx = await win.createBrowserContext()
        const wp = await wctx.newPage()
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

    // a numbered list of steps is a script: it is performed exactly, and nothing else is explored
    const script = inp.reuse ? null : parseStepScript(ctxClean)
    let scriptOut: ScriptOutcome | null = null
    let beganAt = ''
    const directives = inp.reuse || script ? [] : parseDirectives(ctxClean)
    const scripted = directives.some((d) => d.kind === 'type') || (directives.length > 0 && /->|→|=>|⇒|➜|>>/.test(ctxClean))
    if (directives.length) say(`Steps you asked for: ${directives.map((d) => (d.kind === 'open' ? `open "${d.target}"` : `type "${d.text}" into "${d.into || 'the search box'}"`)).join(', then ')}`)

    let exploration: Exploration = { visits: [], actions: 0, stoppedBy: 'done', elapsedMs: 0 }
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
    } else if (script) {
      await pause()
      hooks.progress('explore', `Doing your ${script.items.filter((i) => !i.login).length} steps, exactly as written`)
      beganAt = page.url()
      scriptOut = await performScript({ page, gate, script, log: say, signal: inp.signal })
      if (scriptOut.failure) {
        if (inp.signal?.aborted) throw new RunCancelled()
        throw new Error(scriptOut.failure)
      }
      pages.push(await scoutPage(page, scoutDir, 'p-steps-end', { revealIdentifiers: reveal }))
    } else {
      hooks.progress('explore', 'Exploring the app')
      exploration = await explore({ page, gate, startUrl: inp.startUrl, outDir: scoutDir, depth: inp.depth, revealIdentifiers: reveal, log: say, signal: inp.signal, pause, directives, scripted, topics: readUseCase(ctxClean).topics })
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
    hooks.progress('explore', scriptOut ? `Did ${scriptOut.results.filter((r) => !r.item.login).length} step(s) with ${scriptOut.actions} action(s)` : `Explored ${exploration.visits.length} page(s) with ${exploration.actions} action(s)`)

    // ------------------------------------------------------------ plan
    hooks.progress('plan', 'Choosing what the video shows')
    let plan: Plan = reused
      ? { ...reused, notes: [...reused.notes.filter((n) => !n.startsWith('Repaired: ') && !n.startsWith('The saved steps') && !/explored page/.test(n)), ...reuseNotes] }
      : scriptOut && script
        ? scriptPlan({ script, outcome: scriptOut, map: safeMap, startUrl: inp.startUrl, beganAt, hasVault: useVault, secrets })
        : planBeats({ map: safeMap, exploration, context: ctxClean, startUrl: inp.startUrl, targetSec: inp.targetSec ?? inp.launch?.targetSec, hasVault: useVault, secrets, scripted })
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
    const clipsPossible = !!inp.media?.tools && !ask.declined
    const clipPlaces: Placement[] = !clipsPossible ? [] : ask.requests.length ? [...new Set(ask.requests.map((r) => r.placement))] : inp.media?.clips ? ['start'] : []
    const narration = await narrate({ chat: inp.chat, speech: inp.speech, beats: plan.beats, mode: inp.mode, launch: inp.launch, context: ctxClean, secrets, targetSec: inp.targetSec, styleDirection: inp.styleDirection, brand: brand || look ? { accent: brand?.accent ?? look?.accent.slice(1), logo: brand?.logo } : undefined, problem: structure.problem, clips: clipPlaces, product: inp.launch?.feature.split(/\s+/)[0]?.replace(/['\u2019]s$/i, ''), dir: inp.runDir, say })
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
    await rec.start(2560, 1440)
    const run = await runPlaybook(rpage, plan.playbook, { vault: { username: vault.username, password: vault.password }, gate, redaction: recRedaction, recorder: rec, beatMinSec: narration.minSec, pace: 1, log: say })
    await new Promise((r) => setTimeout(r, 1300))
    const framed = await rec.stop()
    const take: Take = { fps: 30, viewport: { width: 1280, height: 720 }, durationSec: framed.durationSec, beats: run.beats, navigations: run.navigations, log: run.log, redactionMisses: run.redactionMisses }
    writeFileSync(join(inp.runDir, 'take.json'), JSON.stringify({ ...take, frames: framed.frameCount }, null, 2))
    writeFileSync(join(inp.runDir, 'policy-audit.json'), JSON.stringify(gate.audit.filter((a) => !a.allow || a.kind === 'click'), null, 2))
    if (!run.ok) throw new Error(`Recording stopped: ${run.failure}`)
    if (take.redactionMisses > 0) throw new Error('Something private was not hidden in the recording, so no video was made. Turn on "Hide personal data in tables and lists" and try again.')
    if (inp.stopAfter === 'record') return { ...base, plan, redactionMisses: 0 }
    check()

    // ------------------------------------------------------------ AI media (only now: the recording is verified, so nothing is paid for in vain)
    const mediaNotes: string[] = []
    const motif = pickMotif(`${inp.launch ? `${inp.launch.feature} ${inp.launch.tagline}` : ''} ${ctxClean}`)
    const inserts: InsertPlan[] = []
    const tools = inp.media?.tools ?? null
    const askedClips = ask.requests.length > 0
    const lengthSec = inp.targetSec ?? inp.launch?.targetSec ?? 44
    if (ask.declined) mediaNotes.push('You wrote that you do not want an AI video, so none was made.')
    else if (askedClips && !tools) mediaNotes.push('You asked for an AI video, but AI media is not available for this video (the AI option is off, the plan does not include it, or no Gemini key is set), so it was made without one.')
    else if (inp.media?.clips && !tools) mediaNotes.push('AI video clips were ticked, but AI media is not available for this video, so it was made without them.')
    if (tools && !ask.declined && (askedClips || inp.media?.clips)) {
      hooks.progress('produce', 'Making AI video clips')
      const sec = clipSeconds(lengthSec)
      const topic = inp.launch ? `${inp.launch.feature}${inp.launch.tagline ? ` - ${inp.launch.tagline}` : ''}` : (ctxClean.split('\n').map((l) => l.trim()).find((l) => l.length > 12 && !/^(?:(?:step\s*)?\d{1,2}\s*[.):-]|[-*])\s/i.test(l) && !/:$/.test(l)) ?? '').slice(0, 200)
      const planned = await planMedia({ chat: inp.chat, requests: ask.requests, auto: !!inp.media?.clips, appName: displayHost(inp.startUrl), topic, brand: look ? { accent: look.accent.replace('#', ''), backdrop: look.backdrop } : brand?.accent ? { accent: brand.accent } : undefined, motif, lines: narration.clipLines, context: ctxClean, mode: inp.mode, secrets, say })
      const tone = inp.mode === 'launch' ? 'Confident, upbeat product-launch announcer. Warm, energetic, with a clear sense of occasion, at a brisk but natural pace.' : 'Calm, clear, friendly product-demo narrator at an unhurried pace.'
      const middle = (): number => plan.beats[Math.max(0, Math.ceil(plan.beats.length / 2) - 1)]?.beat ?? 0
      const where = (p: Placement): InsertPlan['at'] => (p === 'start' ? { kind: 'start' } : p === 'end' ? { kind: 'end' } : { kind: 'afterBeat', beat: middle() })
      let n = 0
      for (const c of planned) {
        check()
        say(`AI clip ${n + 1} of ${planned.length} (${sec}s): ${c.said.slice(0, 100)}`)
        try {
          const made = await tools.clip(c.prompt, sec)
          const clipSec = made.durationSec ?? probe(made.file).durationSec ?? sec
          const pcm = await voiceLine(narration.plans.some((p) => p.pcm.length) ? inp.speech : null, join(inp.runDir, 'final'), `voice-clip-${n}`, c.line, tone).catch(() => new Float32Array(0))
          inserts.push({ at: where(c.placement), file: made.file, clipSec, text: c.line, pcm, tag: 'AI-generated illustration' })
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
    const musicWish = !!musicAsk && !musicAsk.none && (musicAsk.sounds.length > 0 || musicAsk.noInstruments)
    // natural sounds are made on this PC: free, instrument-free, and they cannot fail the way a music model does
    const ambience = musicWish ? soundsFromWords(musicAsk!.sounds) : undefined
    const wantAiMusic = inp.media?.music && !musicWish && !(musicAsk?.none)
    if (musicAsk?.none) mediaNotes.push('You wrote that you do not want music, so the film has voice only.')
    if (tools && wantAiMusic) {
      musicChoice = await chooseMusic({ ask: musicAsk, chat: inp.chat, context: inp.context, mode: inp.mode, targetSec: lengthSec, styleMood: inp.musicMood, styleDirection: inp.styleDirection, secrets, say })
      say(`AI music: ${musicChoice.mood}${musicChoice.style ? ` — ${musicChoice.style}` : ''} (${musicChoice.why})`)
    } else if (inp.media?.music && !musicAsk?.none && !musicWish) mediaNotes.push('AI music was ticked, but it is not available for this video (the AI option is off, the plan does not include it, or no Gemini key is set), so the built-in score plays.')
    check()

    // ------------------------------------------------------------ produce
    hooks.progress('produce', inserts.length || musicChoice ? 'Making the video, with AI media' : 'Making the video')
    const res = await produce({
      dir: join(inp.runDir, 'final'),
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
              const brief = musicChoice!.ambient ? ambientBrief(musicChoice!, total, voiced) : musicBrief(stub, cuts, total)
              if (!brief) return null
              const audio = await tools.music(musicChoice!.ambient ? brief : withStyle(brief, musicChoice!.style))
              const file = join(inp.runDir, 'final', 'ai-music.mp3')
              writeFileSync(file, audio)
              return decodeStereo(file)
            }
          : undefined,
      intro: narration.intro,
      problem: narration.problem,
      outro: narration.outro,
      noBuiltinMusic: !!musicAsk?.none,
      ambience,
      motif,
      targetSec: inp.mode === 'launch' ? inp.launch?.targetSec : undefined,
      keep: false,
      look
    })
    if (musicChoice) mediaNotes.push(res.musicSource === 'ai' ? `AI music: ${musicChoice.ambient ? 'natural sounds' : musicChoice.mood} — ${musicChoice.why}` : `The AI music could not be used${res.musicError ? ` (${res.musicError})` : ''}, so the built-in score plays.`)
    if (res.musicSource === 'ambience') mediaNotes.push(`Background sound: ${musicAsk!.sounds.length ? musicAsk!.sounds.join(', ') : 'natural ambience'}, made on this computer with no instruments, as you asked.`)
    if (res.scenes) mediaNotes.push(`The title${narration.problem ? ', problem' : ''} and closing scenes are animated around a "${motif}" motif chosen from what your video is about.`)
    if (narration.problem) mediaNotes.push('Problem statement added after the opening, as you asked (written by the engine from your words).')
    return { ...base, plan, video: res.file, durationSec: res.durationSec, redactionMisses: take.redactionMisses, mediaNotes, aiClips: inserts.length, aiMusic: res.musicSource === 'ai' }
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

/** the same page, whatever the query string or a trailing slash says */
function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
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
