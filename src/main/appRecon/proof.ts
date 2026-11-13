import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppMap as AppMapSchema, Playbook as PlaybookSchema, type AppPage, type Playbook, type Step, type Take } from '@shared/appRecon'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import { decodeMono, SR } from '../audio/pcm'
import { speechBounds } from '../audio/voice'
import { enforcePolicy, launch } from './browser'
import { scanNarration } from './detect'
import { interpretGuardrails, PolicyGate } from './policy'
import { produce, readSec, type BeatPlan, type CardPlan } from './produce'
import { FrameRecorder, prepare, runPlaybook } from './recorder'
import { buildAppMap, scoutPage } from './scout'

/**
 * The whole chain on one sign-in flow: scout → rehearse → script and voice →
 * record → produce. This is the proof that the idea holds together; the
 * product version wraps the same stages in a guided screen with approvals.
 */

export interface ProofInput {
  outDir: string
  startUrl: string
  topic: string
  guardrailText: string
  /** credentials for the account used in the video; kept on this computer */
  vault: { username: string; password: string }
  /** a public demo account may show its login name; real accounts must not */
  revealUsername: boolean
  /** make a feature-launch film (title card, demo, closing card) instead of a plain walkthrough */
  launch?: { feature: string; tagline: string; closing: string; cta: string; targetSec: number }
  chat: LLMProvider | null
  speech: SpeechProvider | null
  log?: (m: string) => void
}

const FALLBACK_LINES = [
  { chapter: 'Open sign-in', text: 'Every secured application starts at the sign-in page. Let us walk through how signing in works, one step at a time.' },
  { chapter: 'Enter username', text: 'First, type your username. This tells the application which account you are asking to open.' },
  { chapter: 'Enter password', text: 'Next comes the password. Notice it is blurred here on purpose, because secrets should never appear on screen.' },
  { chapter: 'Sign in', text: 'Press the sign-in button. The application checks your details and, if they match, lets you into the secure area.' },
  { chapter: 'Sign out', text: 'When you are finished, always sign out. That ends your session and returns you safely to the sign-in page.' }
]

const LAUNCH_LINES = {
  intro: 'Introducing secure sign-in. The simple, safe way back into your account.',
  beats: [
    { chapter: 'One clean page', text: 'It all starts on one clean page. Nothing to hunt for, nothing to learn.' },
    { chapter: 'Your username', text: 'Type your username, and the app knows exactly whose account to open.' },
    { chapter: 'Password, protected', text: 'Your password stays hidden as you type, so nobody can read it over your shoulder.' },
    { chapter: 'One click in', text: 'One click on sign in, and you are through to your secure area.' },
    { chapter: 'Sign out safely', text: 'And when you are done, signing out ends your session cleanly.' }
  ],
  outro: 'Secure sign-in. Available now.'
}

export async function runProof(inp: ProofInput): Promise<{ video: string; durationSec: number }> {
  const out = inp.outDir
  mkdirSync(out, { recursive: true })
  const say = inp.log ?? ((m: string) => console.log(m))

  const { guardrails, enforced, advisory } = interpretGuardrails(inp.guardrailText, inp.startUrl)
  say('GUARDRAILS enforced:\n  - ' + enforced.join('\n  - ') + (advisory.length ? '\nadvisory (not enforced):\n  - ' + advisory.join('\n  - ') : ''))
  const gate = new PolicyGate(guardrails)
  const VAULT = inp.vault
  const redactionValues = [VAULT.password, ...(inp.revealUsername ? [] : [VAULT.username])]

  const browser = await launch({ userDataDir: join(out, 'profile') })
  try {
    // ---------------------------------------------------------- 1. scout
    say('\n[1] SCOUT')
    const sp = await (await browser.createBrowserContext()).newPage()
    await enforcePolicy(sp, gate)
    await sp.goto(inp.startUrl, { waitUntil: 'load' })
    const pages: AppPage[] = [await scoutPage(sp, join(out, 'scout'), 'p1-login', { revealIdentifiers: inp.revealUsername })]
    let map = buildAppMap(inp.startUrl, pages)
    const L = map.login
    say(`  sign-in form: user=${L.usernameSelector} password=${L.passwordSelector} submit=${L.submitSelector} ("${L.submitLabel}") second-factor=${L.otpLikely}`)
    if (!L.detected || !L.usernameSelector || !L.passwordSelector || !L.submitSelector) throw new Error('No sign-in form was found on the start page')
    if (L.otpLikely) throw new Error('This sign-in asks for a one-time code; the guided version pauses for the user here')

    // ---------------------------------------------------------- 2. rehearse
    say('\n[2] REHEARSE')
    const redaction = { selectors: map.sensitiveSelectors, values: redactionValues }
    const rp = await (await browser.createBrowserContext()).newPage()
    await enforcePolicy(rp, gate)
    await prepare(rp, redaction)
    const base: Step[] = [
      { id: 's1', beat: 0, kind: 'goto', url: inp.startUrl, selector: L.usernameSelector, intent: 'navigate', focus: 'form' },
      { id: 's2', beat: 1, kind: 'type', selector: L.usernameSelector, label: 'username', text: '{{secret:username}}', focus: 'target' },
      { id: 's3', beat: 2, kind: 'type', selector: L.passwordSelector, label: 'password', text: '{{secret:password}}', focus: 'target' },
      { id: 's4', beat: 3, kind: 'click', selector: L.submitSelector, label: L.submitLabel, intent: 'login-submit', expect: { selectorGone: L.passwordSelector }, focus: 'banner' }
    ]
    const ropts = { vault: VAULT, gate, redaction, pace: 0, log: say }
    const first = await runPlaybook(rp, { version: 1, title: 'rehearsal', startUrl: inp.startUrl, steps: base }, ropts)
    if (!first.ok) throw new Error('Rehearsal failed: ' + first.failure)
    pages.push(await scoutPage(rp, join(out, 'scout'), 'p2-after-login', { revealIdentifiers: inp.revealUsername }))
    const after = pages[1]
    const logout = after.controls.find((c) => /log\s?-?out|sign\s?-?out/i.test(c.label))
    say(`  signed in → "${after.title}" | notice: ${after.notices[0] ?? '-'} | sign-out control: ${logout?.label ?? 'NOT FOUND'}`)
    if (!logout) throw new Error('No sign-out control was found after signing in')
    const outStep: Step = { id: 's5', beat: 4, kind: 'click', selector: logout.selector, label: logout.label, intent: 'logout', expect: { selectorVisible: L.passwordSelector }, focus: 'banner' }
    const second = await runPlaybook(rp, { version: 1, title: 'rehearsal-out', startUrl: inp.startUrl, steps: [outStep] }, ropts)
    if (!second.ok) throw new Error('Rehearsal sign-out failed: ' + second.failure)
    say(`  signed out; unblurred items seen in rehearsal: ${first.redactionMisses + second.redactionMisses}`)
    map = buildAppMap(inp.startUrl, pages)
    AppMapSchema.parse(map)
    writeFileSync(join(out, 'app-map.json'), JSON.stringify(map, null, 2))
    const playbook: Playbook = { version: 1, title: 'Sign-in and sign-out', startUrl: inp.startUrl, steps: [...base, outStep] }
    PlaybookSchema.parse(playbook)
    writeFileSync(join(out, 'playbook.json'), JSON.stringify(playbook, null, 2))

    // ---------------------------------------------------------- 3. script and voice
    say('\n[3] SCRIPT AND VOICE')
    const brief = [
      'The sign-in page opens. The viewer sees the form that every secured app starts with.',
      'The username is typed into the first box.',
      'The password is typed into the second box. In this video that box is blurred on purpose: secrets never appear on screen.',
      'The sign-in button is pressed and the app confirms the person is now inside the secure area.',
      'The person signs out, the session ends and the app is back at the sign-in page with a confirmation.'
    ]
    const L5 = inp.launch ? LAUNCH_LINES.beats.map((l, beat) => ({ beat, ...l })) : FALLBACK_LINES.map((l, beat) => ({ beat, ...l }))
    let lines = L5
    let introText = LAUNCH_LINES.intro
    let outroText = LAUNCH_LINES.outro
    if (inp.chat) {
      try {
        const lc = inp.launch
        const r = await inp.chat.generateJSON<{ intro?: string; outro?: string; lines: Array<{ beat: number; chapter: string; text: string }> }>({
          system: lc
            ? 'You write voice-over for short product launch videos. Confident, warm, upbeat spoken English with a sense of occasion. No jargon, never read out any credential or password. Claim only what the beat describes: no invented features, numbers or brand names, and no absolute security promises (never words like fully protected, unbreakable, no trace, instantly). Write the feature name in normal sentence case, not capitalised mid-sentence.'
            : 'You write voice-over for short product walkthrough videos. Plain, warm, confident spoken English. No jargon, no brand names, never read out any credential or password.',
          prompt: lc
            ? `This is the launch film for a new feature: "${lc.feature}" (${lc.tagline}).\nWrite: an opening line (10 to 14 words, it must announce the feature by name), one line for each of the 5 beats below (11 to 16 words each, one sentence, written to be spoken aloud) and a closing line (6 to 10 words, ends on the feature being available now). Give each beat a chapter label of 2 to 4 words.\n\n${brief.map((b, i) => `Beat ${i}: ${b}`).join('\n')}`
            : `Video topic: ${inp.topic}.\nWrite one narration line for each of the 5 beats below, in order. Each line 16 to 24 words, one or two short sentences, written to be spoken aloud. Also give each beat a chapter label of 2 to 4 words.\n\n${brief.map((b, i) => `Beat ${i}: ${b}`).join('\n')}`,
          schemaName: 'walkthrough_script',
          jsonSchema: {
            type: 'object',
            properties: {
              intro: { type: 'string' },
              outro: { type: 'string' },
              lines: { type: 'array', items: { type: 'object', properties: { beat: { type: 'integer' }, chapter: { type: 'string' }, text: { type: 'string' } }, required: ['beat', 'chapter', 'text'] } }
            },
            required: lc ? ['intro', 'outro', 'lines'] : ['lines']
          },
          temperature: 0.6
        })
        if (r.lines.length === 5) lines = r.lines.sort((a, b) => a.beat - b.beat)
        if (lc && r.intro && r.outro) { introText = r.intro; outroText = r.outro }
      } catch (err) {
        say(`  (writer unavailable, using the stock script: ${(err as Error).message.slice(0, 80)})`)
      }
    }
    // nothing is voiced until it has been checked: no secret, no private data, no promise the video cannot show
    const scanOpts = { values: [VAULT.password, VAULT.username] }
    lines = lines.map((l, i) => {
      const c = scanNarration(l.text, scanOpts)
      if (c.ok) return l
      say(`  (beat ${l.beat} line replaced with the stock line: ${c.problems.join('; ')})`)
      return { ...L5[i], beat: l.beat }
    })
    for (const which of ['intro', 'outro'] as const) {
      const text = which === 'intro' ? introText : outroText
      const c = scanNarration(text, scanOpts)
      if (c.ok) continue
      say(`  (${which} line replaced with the stock line: ${c.problems.join('; ')})`)
      if (which === 'intro') introText = LAUNCH_LINES.intro
      else outroText = LAUNCH_LINES.outro
    }
    const voiceOf = async (name: string, text: string, tone: string): Promise<Float32Array> => {
      if (!inp.speech) return new Float32Array(0)
      const voice = inp.speech.defaultVoice('documentary')
      const tts = await inp.speech.tts({ text, voice, instructions: tone })
      const wav = join(out, `${name}${tts.mimeType === 'audio/wav' ? '.wav' : '.mp3'}`)
      writeFileSync(wav, tts.audio)
      const raw = decodeMono(wav)
      const b = speechBounds(raw)
      return raw.slice(Math.max(0, Math.round((b.start - 0.04) * SR)), Math.round(b.end * SR))
    }
    const tone = inp.launch ? 'Confident, upbeat product-launch announcer. Warm, energetic, with a clear sense of occasion, at a brisk but natural pace.' : 'Calm, clear, friendly product-demo narrator at an unhurried pace.'
    const plans: BeatPlan[] = []
    const minSec = new Map<number, number>()
    for (const l of lines) {
      const pcm = await voiceOf(`voice-${l.beat}`, l.text, tone)
      const spoken = pcm.length ? pcm.length / SR : readSec(l.text)
      plans.push({ beat: l.beat, chapter: l.chapter, text: l.text, pcm })
      minSec.set(l.beat, spoken + (l.beat === 0 ? 1.8 : 1.1))
      say(`  beat ${l.beat} [${l.chapter}] ${spoken.toFixed(1)}s ${pcm.length ? '(voice)' : '(no narrator)'} — ${l.text}`)
    }
    let intro: CardPlan | undefined
    let outro: CardPlan | undefined
    if (inp.launch) {
      const lc = inp.launch
      intro = { pill: 'NEW', headline: lc.feature, sub: lc.tagline, text: introText, pcm: await voiceOf('voice-intro', introText, tone) }
      outro = { pill: lc.cta, headline: lc.feature, sub: lc.closing, text: outroText, pcm: await voiceOf('voice-outro', outroText, tone), accent: '35c48b' }
      say(`  intro ${(intro.pcm.length / SR).toFixed(1)}s — ${introText}\n  outro ${(outro.pcm.length / SR).toFixed(1)}s — ${outroText}`)
      // spread the time left over between the demo's beats, so the film lands on its target length
      const sp = (c: CardPlan) => (c.pcm.length ? c.pcm.length / SR : readSec(c.text))
      const introSec = Math.max(4.2, sp(intro) + 1.4)
      const outroMin = sp(outro) + 2.3
      const budget = lc.targetSec - (introSec - 0.6) - (outroMin - 0.6)
      const base = [...minSec.values()].reduce((a, c) => a + c, 0) + 1.7
      const extra = Math.max(0, Math.min(2, (budget - base) / minSec.size))
      for (const [k, v] of minSec) minSec.set(k, v + extra)
      say(`  time plan: intro ${introSec.toFixed(1)}s · demo ≈ ${(base + extra * minSec.size).toFixed(1)}s · closing ≥ ${outroMin.toFixed(1)}s → target ${lc.targetSec}s`)
    }
    writeFileSync(join(out, 'script.json'), JSON.stringify({ lines, intro: introText, outro: outroText, narrator: inp.speech ? `${inp.speech.label} · ${inp.speech.model}` : 'none' }, null, 2))

    // ---------------------------------------------------------- 4. record
    say('\n[4] RECORD')
    const page = await (await browser.createBrowserContext()).newPage()
    await enforcePolicy(page, gate)
    await prepare(page, redaction)
    // load the start page first: the film opens on the finished page, not a blank one
    await page.goto(inp.startUrl, { waitUntil: 'load' })
    await new Promise((r) => setTimeout(r, 400))
    const rec = new FrameRecorder(page, join(out, 'frames'))
    await rec.start(2560, 1440)
    const run = await runPlaybook(page, playbook, { vault: VAULT, gate, redaction, recorder: rec, beatMinSec: minSec, pace: 1, log: say })
    await new Promise((r) => setTimeout(r, 1300))
    const framed = await rec.stop()
    if (!run.ok) throw new Error('Recording failed: ' + run.failure)
    const take: Take = { fps: 30, viewport: { width: 1280, height: 720 }, durationSec: framed.durationSec, beats: run.beats, navigations: run.navigations, log: run.log, redactionMisses: run.redactionMisses }
    writeFileSync(join(out, 'take.json'), JSON.stringify({ ...take, frames: framed.frameCount }, null, 2))
    writeFileSync(join(out, 'policy-audit.json'), JSON.stringify(gate.audit.filter((a) => !a.allow || a.kind === 'click'), null, 2))
    say(`  ${framed.frameCount} frames, ${framed.durationSec.toFixed(1)}s, unblurred items: ${take.redactionMisses}`)
    if (take.redactionMisses > 0) throw new Error('Unblurred sensitive content was detected — no video was produced')

    // ---------------------------------------------------------- 5. produce
    say('\n[5] PRODUCE')
    const res = await produce({ dir: join(out, 'final'), framesList: framed.listFile, offsetSec: rec.offsetSec(), take, beats: plans, title: inp.launch ? `${inp.launch.feature} launch` : 'Secure sign-in walkthrough', musicMood: inp.launch ? 'upbeat' : 'corporate', intro, outro, targetSec: inp.launch?.targetSec, keep: true })
    say(`  → ${res.file} (${res.durationSec.toFixed(1)}s)`)
    return { video: res.file, durationSec: res.durationSec }
  } finally {
    await browser.close().catch(() => undefined)
  }
}
