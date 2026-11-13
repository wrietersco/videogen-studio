import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'puppeteer-core'
import type { AppMap, AppPage, Take } from '@shared/appRecon'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import { enforcePolicy, launch } from './browser'
import { scrubMap } from './detect'
import { checkCompatibility, explore, settle, type Depth, type Exploration } from './explore'
import { narrate, type LaunchInfo } from './narrate'
import { planBeats, type Plan } from './planner'
import { interpretGuardrails, PolicyGate, type RestrictionChecks } from './policy'
import { produce } from './produce'
import { FrameRecorder, prepare, runPlaybook } from './recorder'
import type { RedactionConfig } from './redact'
import { buildAppMap, scoutPage } from './scout'

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
}

export interface RunHooks {
  progress: (stage: Stage, message: string) => void
  log?: (message: string) => void
  /** the person has to do something in a browser window; resolves when they are done */
  handoff: (info: { reason: 'sign-in' | 'code' | 'captcha'; url: string; message: string }) => Promise<void>
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
    await page.goto(inp.startUrl, { waitUntil: 'load', timeout: 30000 })
    await settle(page)
    const compat = await checkCompatibility(page)
    hooks.progress('explore', `Compatibility: ${compat.reason}`)
    if (compat.level === 'unlikely') throw new Error(`This app probably cannot be recorded. ${compat.reason}`)
    check()

    const first = await scoutPage(page, scoutDir, 'p0-start', { revealIdentifiers: reveal })
    let map = buildAppMap(inp.startUrl, [first])
    const L = map.login

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
    } else if (L.detected && inp.signIn === 'self') {
      hooks.progress('explore', 'Waiting for you to sign in')
      await hooks.handoff({ reason: 'sign-in', url: page.url(), message: 'Sign in to the app in the browser window, then press Done.' })
      await settle(page)
    }
    check()

    hooks.progress('explore', 'Exploring the app')
    const exploration = await explore({ page, gate, startUrl: inp.startUrl, outDir: scoutDir, depth: inp.depth, revealIdentifiers: reveal, log: say, signal: inp.signal })
    check()
    const pages: AppPage[] = [first, ...exploration.visits.map((v) => v.page)]
    map = buildAppMap(inp.startUrl, pages)
    const safeMap = scrubMap(map, { values: secrets, kinds: guardrails.privacyMode ? undefined : ['token', 'card', 'ssn', 'secret'] })
    writeFileSync(join(inp.runDir, 'app-map.json'), JSON.stringify(safeMap, null, 2))
    const cookies = inp.signIn === 'self' ? await ctx.cookies() : []
    hooks.progress('explore', `Explored ${exploration.visits.length} page(s) with ${exploration.actions} action(s)`)

    // ------------------------------------------------------------ plan
    hooks.progress('plan', 'Choosing what the video shows')
    let plan = planBeats({ map: safeMap, exploration, context: inp.context, startUrl: inp.startUrl, targetSec: inp.targetSec ?? inp.launch?.targetSec, hasVault: useVault, secrets })
    writeFileSync(join(inp.runDir, 'playbook.json'), JSON.stringify(plan.playbook, null, 2))
    writeFileSync(join(inp.runDir, 'beats.json'), JSON.stringify(plan.beats, null, 2))
    const base: RunOutput = {
      plan, map: safeMap, compat, stoppedBy: exploration.stoppedBy, pages: exploration.visits.length, actions: exploration.actions,
      blockedHosts: gate.blockedHosts(), enforced, advisory, redactionMisses: 0, runDir: inp.runDir
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
    const narration = await narrate({ chat: inp.chat, speech: inp.speech, beats: plan.beats, mode: inp.mode, launch: inp.launch, context: inp.context, secrets, targetSec: inp.targetSec, dir: inp.runDir, say })
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
    await rpage.goto(plan.playbook.startUrl, { waitUntil: 'load', timeout: 30000 })
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

    // ------------------------------------------------------------ produce
    hooks.progress('produce', 'Making the video')
    const res = await produce({
      dir: join(inp.runDir, 'final'),
      framesList: framed.listFile,
      offsetSec: rec.offsetSec(),
      take,
      beats: narration.plans,
      title: inp.mode === 'launch' && inp.launch ? `${inp.launch.feature} launch` : plan.playbook.title,
      musicMood: inp.musicMood ?? (inp.mode === 'launch' ? 'upbeat' : 'corporate'),
      intro: narration.intro,
      outro: narration.outro,
      targetSec: inp.mode === 'launch' ? inp.launch?.targetSec : undefined,
      keep: false
    })
    return { ...base, plan, video: res.file, durationSec: res.durationSec, redactionMisses: take.redactionMisses }
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
