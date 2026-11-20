import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Take } from '../src/shared/appRecon'
import { SR, ffmpegBin, writeWav } from '../src/main/audio/pcm'
import { probe } from '../src/main/assets/probe'
import type { LLMProvider, SpeechProvider } from '../src/main/providers/types'
import { readPreviousRecording, writeRecordingRecord, type PreviousRecording, type RecordingRecord } from '../src/main/appRecon/recordingRecord'
import { findChrome } from '../src/main/appRecon/browser'
import { runAppRecording } from '../src/main/appRecon/run'
import { DEMO_PASS, DEMO_USER, startAppSite, type AppSite } from './fixtures/appSite'
import { mapper, planPieces, remapTake, retimeFootage } from '../src/main/appRecon/retime'
import { applyEdit, beatsIn, editIsEmpty, interpretRevision, needsRerecord, normaliseEdit, partRef, readRevisionByRules, reviseRecording, type RecordingEdit } from '../src/main/appRecon/revise'

/**
 * Changing a finished app recording by typing what should be different: the request read
 * (rules and the AI writer), what it means for the kept recording, the footage cut and held,
 * and a real video made again from the kept screen recording. Stand-in models only.
 */

const root = mkdtempSync(join(tmpdir(), 'vg-apprev-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
const ff = (args: string[]) => {
  const r = spawnSync(ffmpegBin(), ['-y', '-v', 'error', ...args])
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-400))
}

/** a narrator stand-in: a tone as long as the words take to say (a quarter second a word), and a count of what it was asked to say */
function fakeSpeech(): SpeechProvider & { said: string[]; tones: string[] } {
  const said: string[] = []
  const tones: string[] = []
  return {
    id: 'test',
    label: 'Test voice',
    model: 'fake',
    voices: ['v'],
    said,
    tones,
    defaultVoice: () => 'v',
    async tts(req) {
      said.push(req.text)
      tones.push(req.instructions ?? '')
      const n = Math.max(SR / 2, Math.round(req.text.split(/\s+/).filter(Boolean).length * 0.25 * SR))
      const l = Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR))
      const file = join(root, `tts-${said.length}.wav`)
      writeWav(file, { l, r: l })
      return { audio: readFileSync(file), mimeType: 'audio/wav' }
    }
  }
}

const chatOf = (answer: (prompt: string) => unknown): LLMProvider & { calls: number } => {
  const c = { calls: 0, id: 'test', label: 'Test writer', isConfigured: async () => true, listModels: async () => [], generateJSON: async (req: { prompt: string }) => (c.calls++, answer(req.prompt)) }
  return c as unknown as LLMProvider & { calls: number }
}

/** a finished recording written by hand: 12 s of footage, three beats, a voice for each */
function fakePrev(name: string, launch = false): PreviousRecording {
  const dir = join(root, name)
  mkdirSync(join(dir, 'final'), { recursive: true })
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', join(dir, 'final', 'raw.mp4')])
  const texts = ['First we sign in to the app.', 'Here is the reports page with every chart.', 'Settings keep everything in order.']
  const voice = (file: string, text: string) => {
    const n = Math.round(text.split(/\s+/).length * 0.25 * SR)
    const l = Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin((2 * Math.PI * 220 * i) / SR))
    writeWav(join(dir, file), { l, r: l })
    return file
  }
  const take: Take = {
    fps: 30,
    viewport: { width: 1920, height: 1080 },
    durationSec: 12,
    beats: [
      { beat: 0, startSec: 0.2, endSec: 4.1, url: 'https://app.test/login' },
      { beat: 1, startSec: 4.2, endSec: 8.1, url: 'https://app.test/reports' },
      { beat: 2, startSec: 8.2, endSec: 12, url: 'https://app.test/settings' }
    ],
    navigations: [
      { t: 0.2, url: 'https://app.test/login' },
      { t: 4.3, url: 'https://app.test/reports' },
      { t: 8.4, url: 'https://app.test/settings' }
    ],
    log: [],
    redactionMisses: 0
  }
  writeFileSync(join(dir, 'take.json'), JSON.stringify(take))
  writeFileSync(join(dir, 'beats.json'), JSON.stringify([
    { beat: 0, kind: 'login', chapter: 'Signing in', facts: ['A username and a hidden password are typed'], fallback: 'x' },
    { beat: 1, kind: 'page', chapter: 'Reports', facts: ['A page of charts called Reports'], fallback: 'x' },
    { beat: 2, kind: 'page', chapter: 'Settings', facts: ['A page of options called Settings'], fallback: 'x' }
  ]))
  const rec: RecordingRecord = {
    version: 1,
    mode: launch ? 'launch' : 'walkthrough',
    launch: launch ? { feature: 'Reports', tagline: 'See it all', closing: 'Try it today', cta: 'Available now', targetSec: 30 } : undefined,
    size: { width: 1920, height: 1080 },
    offsetSec: 0.2,
    title: 'Test app',
    targetSec: launch ? 30 : undefined,
    context: 'Show the reports and the settings.',
    tone: 'Calm, clear, friendly product-demo narrator at an unhurried pace.',
    voiced: true,
    lines: [
      { beat: 0, chapter: 'Signing in', text: texts[0], voice: voice('voice-0.wav', texts[0]) },
      { beat: 1, chapter: 'Reports', text: texts[1], voice: voice('voice-1.wav', texts[1]) },
      { beat: 2, chapter: 'Settings', text: texts[2], voice: voice('voice-2.wav', texts[2]) }
    ],
    ...(launch
      ? {
          intro: { pill: 'NEW', headline: 'Reports', sub: 'See it all', text: 'Introducing Reports. See it all.', voice: voice('voice-intro.wav', 'Introducing Reports. See it all.') },
          outro: { pill: 'Available now', headline: 'Reports', sub: 'Try it today', text: 'Reports. Available now.', voice: voice('voice-outro.wav', 'Reports. Available now.') }
        }
      : {}),
    inserts: [],
    music: { source: 'builtin', mood: launch ? 'upbeat' : 'corporate' },
    raw: 'final/raw.mp4'
  }
  writeRecordingRecord(dir, rec)
  return readPreviousRecording(`run-${name}`, dir)!
}

const noTools = { hasChat: false, hasSpeech: true, tools: null }

describe('the timeline of a recording that is cut and held', () => {
  const take = fakePrev('t-pure').take
  it('cuts a beat out without a gap and moves the rest up', () => {
    const plan = planPieces(take, 0.2, new Set([1]))
    expect(plan.pieces).toEqual([{ a: 0, b: 4, hold: 0 }, { a: 8, b: 12, hold: 0 }])
    expect(plan.kept).toEqual([0, 2])
    expect(plan.total).toBeCloseTo(8, 5)
    const t = remapTake(take, 0.2, plan)
    expect(t.durationSec).toBeCloseTo(8, 5)
    expect(t.beats.map((b) => b.beat)).toEqual([0, 2])
    expect(t.beats[1].startSec).toBeCloseTo(4.2, 5)
    expect(t.beats[1].endSec).toBeCloseTo(8.0, 5)
    // the address bar keeps showing a real page across the jump
    expect(t.navigations[0]).toEqual({ t: 0.2, url: 'https://app.test/login' })
    expect(t.navigations.some((n) => Math.abs(n.t - 4.2) < 1e-6 && n.url === 'https://app.test/reports')).toBe(true)
  })
  it('holds the picture at the end of a beat, and every later time moves by the hold', () => {
    const plan = planPieces(take, 0.2, new Set(), new Map([[0, 2]]))
    expect(plan.total).toBeCloseTo(14, 5)
    const map = mapper(plan)
    expect(map(3.9)).toBeCloseTo(5.9, 5) // the end of beat 0 is after the held picture
    expect(map(4.0)).toBeCloseTo(6.0, 5)
    const t = remapTake(take, 0.2, plan)
    expect(t.beats[0].endSec).toBeCloseTo(5.9 + 0.2, 5)
    expect(t.beats[1].startSec).toBeCloseTo(6.0 + 0.2, 5)
  })
  it('knows when nothing changed, and refuses to cut everything', () => {
    expect(planPieces(take, 0.2, new Set()).unchanged).toBe(true)
    const none = planPieces(take, 0.2, new Set([0, 1, 2]))
    expect(none.pieces).toEqual([])
    expect(() => retimeFootage('a.mp4', join(root, 'x.mp4'), none)).toThrow(/Every part/)
  })
  it('makes a real file of the planned length', () => {
    const prev = fakePrev('t-ffmpeg')
    const out = join(root, 't-ffmpeg', 'cut.mp4')
    const plan = planPieces(prev.take, 0.2, new Set([1]), new Map([[2, 1.5]]))
    retimeFootage(join(prev.dir, 'final', 'raw.mp4'), out, plan)
    expect(probe(out).durationSec).toBeCloseTo(plan.total, 0)
    expect(plan.total).toBeCloseTo(9.5, 1)
  })
})

describe('reading a change request by rules', () => {
  const prev = fakePrev('r-rules')
  it('reads the common asks', () => {
    const e = readRevisionByRules('No music. Cut the second scene. Make the voice warmer. Say it in Urdu. Change the tagline to "Ready in minutes". Make the cards green.', prev)
    expect(e.music).toEqual({ mode: 'none' })
    expect(e.cut).toEqual([1])
    expect(e.tone).toBe('warmer')
    expect(e.language).toBe('Urdu')
    expect(e.cards.tagline).toBe('Ready in minutes')
    expect(e.look.accent).toBe('#34c759')
    expect(e.cannot).toEqual([])
    expect(needsRerecord(e)).toBe(false)
  })
  it('finds a part by what it is called, and the sign-in by its name', () => {
    expect(beatsIn('skip the settings part', prev)).toEqual([2])
    expect(beatsIn('cut the sign-in', prev)).toEqual([0])
    expect(beatsIn('scenes 2 and 3', prev)).toEqual([1, 2])
    expect(beatsIn('the last scene', prev)).toEqual([2])
    expect(partRef('the second scene', prev)).toBe('b1')
    expect(readRevisionByRules('Cut the sign-in part. Remove the music', prev).cut).toEqual([0])
  })
  it('exact words for a scene are used; words with no scene named are listed honestly', () => {
    const e = readRevisionByRules('Make the second scene say "Every chart in one place."', prev)
    expect(e.lines).toEqual([{ part: 'b1', text: 'Every chart in one place.' }])
    const lost = readRevisionByRules('Say "Hello there"', prev)
    expect(lost.lines).toEqual([])
    expect(lost.cannot.join(' ')).toMatch(/which part/)
  })
  it('a change to what is filmed, the shape or the length needs the app again', () => {
    const e = readRevisionByRules('Also show the billing page. Make it 30 seconds for TikTok.', prev)
    expect(e.rerecord).toEqual(['Also show the billing page'])
    expect(e.platform).toBe('tiktok')
    expect(e.targetSec).toBe(30)
    expect(needsRerecord(e)).toBe(true)
  })
  it('a creative ask with no words given needs the writer and is listed, not guessed', () => {
    const e = readRevisionByRules('make it funnier', prev)
    expect(editIsEmpty(e)).toBe(true)
    expect(e.cannot.join(' ')).toMatch(/funnier.*AI writer/)
  })
  it('a request made before the pieces were kept can still be read for its shape and length', () => {
    const e = readRevisionByRules('Make it 45 seconds for Instagram reels', null)
    expect(e.targetSec).toBe(45)
    expect(e.platform).toBe('instagram-reels')
  })
})

describe('reading a change request with the AI writer', () => {
  const prev = fakePrev('r-ai')
  it('keeps only known fields and parts that exist, and reads colours', () => {
    const e = normaliseEdit({ lines: [{ part: 'b1', text: 'Every chart, one place.' }, { part: 'b9', text: 'nope' }], cut: ['b2', 'zzz'], music: { mode: 'builtin', mood: 'upbeat' }, look: { accent: 'orange', backdrop: 'not a colour' }, targetSec: 5, platform: 'myspace', voice: 'off', drop: ['outro', 'cats'] }, prev)!
    expect(e.lines).toEqual([{ part: 'b1', text: 'Every chart, one place.' }])
    expect(e.cut).toEqual([2])
    expect(e.music).toEqual({ mode: 'builtin', mood: 'upbeat' })
    expect(e.look).toEqual({ accent: '#ff9500' })
    expect(e.targetSec).toBe(20)
    expect(e.platform).toBeUndefined()
    expect(e.voice).toBe('off')
    expect(e.drop).toEqual(['outro'])
    expect(e.cannot.join(' ')).toMatch(/not in this video/)
  })
  it('asks the writer once, with the parts listed, and falls back to rules when it fails', async () => {
    const chat = chatOf((prompt) => {
      expect(prompt).toContain('b1 — Reports')
      expect(prompt).toContain('every chart')
      return { rewrite: [{ part: 'all', how: 'more formal' }], music: { mode: 'none' } }
    })
    const e = await interpretRevision('make everything more formal and drop the music', prev, { chat })
    expect(chat.calls).toBe(1)
    expect(e.source).toBe('ai')
    expect(e.rewrite).toEqual([{ part: 'all', how: 'more formal' }])
    const broken = { ...chatOf(() => null), generateJSON: async () => { throw new Error('offline') } } as unknown as LLMProvider
    const f = await interpretRevision('no music', prev, { chat: broken })
    expect(f.source).toBe('rules')
    expect(f.music).toEqual({ mode: 'none' })
  })
  it('never sends a credential to the writer', async () => {
    let seen = ''
    const chat = chatOf((p) => ((seen = p), { music: { mode: 'none' } }))
    await interpretRevision('no music, and my password is hunter2secret', prev, { chat, secrets: ['hunter2secret'] })
    expect(seen).not.toContain('hunter2secret')
  })
})

describe('what an edit means for this video', () => {
  const ed = (over: Partial<RecordingEdit>): RecordingEdit => ({ lines: [], rewrite: [], cards: {}, drop: [], cut: [], look: {}, rerecord: [], cannot: [], source: 'rules', ...over })
  it('cut, music and colour are plain changes; the rest of the video is kept', () => {
    const prev = fakePrev('a-basic')
    const a = applyEdit(prev, ed({ cut: [1], music: { mode: 'none' }, look: { accent: '#34c759' } }), noTools)
    expect(a.lines.map((l) => l.beat)).toEqual([0, 2])
    expect(a.music.source).toBe('none')
    expect(a.look?.accent).toBe('#34c759')
    expect(a.changed.join(' ')).toMatch(/Cut “Reports”/)
    expect(a.kept.join(' ')).toMatch(/screen recording/)
    expect(a.kept.join(' ')).toMatch(/voice of 2 of 2/)
  })
  it('only the lines whose words changed are voiced again', () => {
    const prev = fakePrev('a-lines')
    const a = applyEdit(prev, ed({ lines: [{ part: 'b2', text: 'Settings keep it tidy.' }] }), noTools)
    expect(a.lines.map((l) => l.redo)).toEqual([false, false, true])
  })
  it('a new tone voices everything again; with no voice there is nothing to change', () => {
    const prev = fakePrev('a-tone')
    expect(applyEdit(prev, ed({ tone: 'warmer' }), noTools).lines.every((l) => l.redo)).toBe(true)
    const off = applyEdit(prev, ed({ voice: 'off' }), noTools)
    expect(off.voiced).toBe(false)
    expect(off.changed.join(' ')).toMatch(/Took the voice out/)
  })
  it('refuses what it cannot do, and says why', () => {
    const prev = fakePrev('a-cannot')
    const a = applyEdit(prev, ed({ language: 'Urdu', rewrite: [{ part: 'all', how: 'funnier' }], music: { mode: 'ai', style: 'epic' }, cards: { tagline: 'x' }, cut: [0, 1, 2], lines: [{ part: 'b1', text: 'It is completely secure and unbreakable.' }] }), noTools)
    const text = a.cannot.join(' | ')
    expect(text).toMatch(/AI writer to translate/)
    expect(text).toMatch(/funnier.*AI writer/)
    expect(text).toMatch(/AI music is not available/)
    expect(text).toMatch(/no title or closing card/)
    expect(text).toMatch(/cut every part/)
    expect(text).toMatch(/absolute claim|unbreakable/)
    expect(a.cut.size).toBe(0)
    expect(a.language).toBeUndefined()
  })
  it('a launch film’s cards change together with what is said over them', () => {
    const prev = fakePrev('a-launch', true)
    const a = applyEdit(prev, ed({ cards: { feature: 'Insights', tagline: 'Know sooner', cta: 'Start now' } }), noTools)
    expect(a.launch).toMatchObject({ feature: 'Insights', tagline: 'Know sooner', cta: 'Start now' })
    expect(a.intro).toMatchObject({ headline: 'Insights', sub: 'Know sooner', redo: true })
    expect(a.intro!.text).toBe('Introducing Insights. Know sooner.')
    expect(a.outro).toMatchObject({ headline: 'Insights', pill: 'Start now', redo: true })
    expect(a.outro!.text).toBe('Insights. Start now.')
    const gone = applyEdit(prev, ed({ drop: ['outro', 'problem'] }), noTools)
    expect(gone.outro).toBeUndefined()
    expect(gone.cannot.join(' ')).toMatch(/no problem card/)
  })
  it('with the writer, a translation voices and rewrites every part', () => {
    const prev = fakePrev('a-lang', true)
    const a = applyEdit(prev, ed({ language: 'Urdu' }), { hasChat: true, hasSpeech: true, tools: null })
    expect(a.translate).toBe(true)
    expect(a.language).toBe('Urdu')
    expect([...a.lines, a.intro!, a.outro!].every((x) => x.redo)).toBe(true)
  })
})

describe('making the changed video from the kept recording', () => {
  const run = (prev: PreviousRecording, edit: Partial<RecordingEdit>, deps: { chat?: LLMProvider | null; speech?: SpeechProvider | null } = {}) => {
    const dir = join(root, `new-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(dir, { recursive: true })
    const stages: string[] = []
    const e: RecordingEdit = { lines: [], rewrite: [], cards: {}, drop: [], cut: [], look: {}, rerecord: [], cannot: [], source: 'rules', ...edit }
    return reviseRecording({ prev, edit: e, runDir: dir, chat: deps.chat ?? null, speech: deps.speech ?? null, tools: null, progress: (s, m) => stages.push(`${s}:${m}`) }).then((out) => ({ out, dir, stages }))
  }

  it('cuts a part, says only the changed line again, and the new video is as long as what is left', async () => {
    const prev = fakePrev('m-cut')
    const speech = fakeSpeech()
    const { out, dir, stages } = await run(prev, { cut: [1], lines: [{ part: 'b2', text: 'Settings keep it tidy.' }], music: { mode: 'none' } }, { speech })
    expect(speech.said).toEqual(['Settings keep it tidy.'])
    expect(existsSync(out.video)).toBe(true)
    expect(probe(out.video).durationSec).toBeGreaterThan(7.7)
    expect(probe(out.video).durationSec).toBeLessThan(8.6)
    expect(out.changed.join(' ')).toMatch(/Cut “Reports”/)
    expect(out.kept.join(' ')).toMatch(/screen recording/)
    expect(stages.some((s) => s.startsWith('produce:'))).toBe(true)
    // the earlier recording is untouched
    expect(probe(join(prev.dir, 'final', 'raw.mp4')).durationSec).toBeGreaterThan(11.9)
    // and the new one can be changed again, from its own folder
    const next = readPreviousRecording('run-next', dir)!
    expect(next.record.lines.map((l) => l.beat)).toEqual([0, 2])
    expect(next.record.lines[1].text).toBe('Settings keep it tidy.')
    expect(next.record.music.source).toBe('none')
    expect(next.take.beats.map((b) => b.beat)).toEqual([0, 2])
    expect(probe(join(dir, 'final', 'raw.mp4')).durationSec).toBeCloseTo(8, 0)
  }, 180_000)

  it('longer words hold the picture so they fit; a second change builds on the first', async () => {
    const prev = fakePrev('m-hold')
    const speech = fakeSpeech()
    const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const first = await run(prev, { lines: [{ part: 'b0', text: long }], music: { mode: 'none' } }, { speech })
    expect(first.out.changed.join(' ')).toMatch(/Held the picture/)
    expect(probe(first.out.video).durationSec).toBeGreaterThan(14.5)
    const next = readPreviousRecording('run-first', first.dir)!
    const second = await run(next, { voice: 'off' })
    expect(second.out.record.voiced).toBe(false)
    expect(second.out.changed.join(' ')).toMatch(/Took the voice out/)
    expect(existsSync(second.out.video)).toBe(true)
  }, 240_000)

  it('writes the words again with the writer, checks them, and voices only what was rewritten', async () => {
    const prev = fakePrev('m-ai')
    const speech = fakeSpeech()
    const chat = chatOf(() => ({ items: [{ id: 'b1', text: 'The reports page shows every chart in one place.' }] }))
    const { out } = await run(prev, { rewrite: [{ part: 'b1', how: 'more formal' }], music: { mode: 'none' } }, { speech, chat })
    expect(chat.calls).toBe(1)
    expect(speech.said).toEqual(['The reports page shows every chart in one place.'])
    expect(out.record.lines[1].text).toBe('The reports page shows every chart in one place.')
    expect(out.changed.join(' ')).toMatch(/“Reports” is written again: more formal/)
  }, 180_000)

  it('words that fail the check are not used, and the line stays as it was', async () => {
    const prev = fakePrev('m-bad')
    const chat = chatOf(() => ({ items: [{ id: 'b1', text: 'Your data is completely secure and unbreakable.' }] }))
    const { out } = await run(prev, { rewrite: [{ part: 'b1', how: 'more confident' }], music: { mode: 'none' } }, { speech: fakeSpeech(), chat })
    expect(out.record.lines[1].text).toBe('Here is the reports page with every chart.')
    expect(out.cannot.join(' ')).toMatch(/not used/)
  }, 180_000)

  it('a launch film: the tagline changes on the card and in what is said, and the new run carries its own files', async () => {
    const prev = fakePrev('m-launch', true)
    const speech = fakeSpeech()
    const { out, dir } = await run(prev, { cards: { tagline: 'Know sooner' }, music: { mode: 'none' } }, { speech })
    expect(speech.said).toEqual(['Introducing Reports. Know sooner.'])
    expect(out.record.intro!.sub).toBe('Know sooner')
    expect(existsSync(join(dir, 'final', 'launch.mp4'))).toBe(true)
    // the voice files of the lines that did not change were copied, so deleting the earlier run would not break this one
    rmSync(prev.dir, { recursive: true, force: true })
    const next = readPreviousRecording('run-launch', dir)!
    expect(existsSync(join(dir, next.record.lines[0].voice!))).toBe(true)
  }, 180_000)
})

describe.skipIf(!findChrome())('a real recording, then changed by typing', () => {
  let site: AppSite
  beforeAll(async () => {
    site = await startAppSite()
  }, 120000)
  afterAll(async () => {
    await site?.close()
  }, 60000)

  it('keeps what the video is made of, and a typed change is made from it without opening the app again', async () => {
    const runDir = join(root, 'real')
    const out = await runAppRecording(
      { runDir, startUrl: `${site.url}/login`, context: 'Show the dashboard and the customers', mode: 'walkthrough', signIn: 'saved', vault: { username: DEMO_USER, password: DEMO_PASS }, guardrailText: '', checks: {}, depth: 'quick', chat: null, speech: null },
      { progress: () => undefined, handoff: async () => { throw new Error('no hand-off expected') } }
    )
    expect(out.video && existsSync(out.video)).toBe(true)
    expect(out.editable).toBe(true)
    const prev = readPreviousRecording('run-real', runDir)!
    expect(prev).toBeTruthy()
    expect(prev.record.lines.length).toBe(out.plan.beats.length)
    // nothing private is kept with it
    expect(readFileSync(join(runDir, 'recording-record.json'), 'utf8')).not.toContain(DEMO_PASS)
    const loginsBefore = site.state.logins
    const edit = readRevisionByRules('Cut the last scene. No music. Say "Welcome aboard" on the first scene.', prev)
    expect(edit.cut).toEqual([prev.record.lines.at(-1)!.beat])
    const res = await reviseRecording({ prev, edit, runDir: join(root, 'real2'), chat: null, speech: null, tools: null, progress: () => undefined })
    expect(site.state.logins).toBe(loginsBefore) // the app was not opened again
    expect(res.record.lines.length).toBe(prev.record.lines.length - 1)
    expect(res.record.lines[0].text).toBe('Welcome aboard')
    expect(res.record.music.source).toBe('none')
    expect(res.durationSec).toBeLessThan(out.durationSec!)
    expect(existsSync(res.video)).toBe(true)
  }, 400000)
})
