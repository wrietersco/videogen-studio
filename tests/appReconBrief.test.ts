import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ffmpegBin } from '../src/main/audio/pcm'
import { canShowWindow, findChrome } from '../src/main/appRecon/browser'
import { ambientBrief, chooseMusic, parseMediaAsk, parseMusicAsk, parseStructure, planMedia, withoutProductionSentences } from '../src/main/appRecon/aiMedia'
import { runAppRecording, type MediaTools, type RunHooks, type RunInput } from '../src/main/appRecon/run'
import { DEMO_PASS, DEMO_USER, startAppSite, type AppSite } from './fixtures/appSite'

/** the brief that went wrong: AI intro, nature sounds that are "halal", a problem statement, steps, AI outro */
const BRIEF = `use ai video intro.
natural white noise birds and thunders as background music - halal music
after intro, present problem statement and then show screen recording as answer
steps to follow for screen recording:
1. log into the app
2. from left menu, click ontology
3. from search section on top, click "Explore the graph"

ai-video based outro`

describe('reading a whole brief: AI intro and outro, nature sounds, problem statement', () => {
  it('finds both AI clips, the intro first and the outro last, and neither is a step', () => {
    const a = parseMediaAsk(BRIEF)
    expect(a.requests.map((r) => r.placement)).toEqual(['start', 'end'])
    expect(a.requests.every((r) => r.generic)).toBe(true)
    const clean = withoutProductionSentences(BRIEF)
    expect(clean).not.toMatch(/ai video|ai-video|white noise|problem statement/i)
    expect(clean).toContain('1. log into the app')
    expect(clean).toContain('3. from search section on top')
  })

  it('reads the music wish: natural sounds, no instruments', () => {
    const m = parseMusicAsk(BRIEF)!
    expect(m.noInstruments).toBe(true)
    expect(m.none).toBe(false)
    expect(m.sounds.join(' ')).toMatch(/white noise/)
    expect(m.sounds.join(' ')).toMatch(/birdsong/)
    expect(m.sounds.join(' ')).toMatch(/thunder/)
    expect(parseMusicAsk('Make it fast. 1. click Music in the menu')).toBeNull()
    expect(parseMusicAsk('No music please.')!.none).toBe(true)
  })

  it('turns the wish into an ambience brief, with no built-in score as a fallback', async () => {
    const c = await chooseMusic({ ask: parseMusicAsk(BRIEF), chat: null, context: BRIEF, mode: 'launch', targetSec: 40, secrets: [], say: () => undefined })
    expect(c.ambient).toBe(true)
    expect(c.noBuiltin).toBe(true)
    const brief = ambientBrief(c, 40, true)
    expect(brief).toMatch(/birdsong/)
    expect(brief).toMatch(/no instruments/i)
    expect(brief).not.toMatch(/BPM|motif/)
  })

  it('reads a problem statement request, not a step that says "problem"', () => {
    expect(parseStructure(BRIEF).problem).toBe(true)
    expect(parseStructure('1. search for "problem" in the box').problem).toBe(false)
    expect(parseStructure('No problem statement, just the demo.').problem).toBe(false)
  })

  it('a clip that only says where it goes is about the film, and respectful for a religious subject', async () => {
    const asked = parseMediaAsk(BRIEF)
    const planned = await planMedia({ chat: null, requests: asked.requests, auto: false, appName: 'x.test', topic: 'Taaweel ontology - visually understand Quran', context: '', mode: 'launch', secrets: [], say: () => undefined })
    expect(planned).toHaveLength(2)
    expect(planned[0].prompt).toMatch(/introduces Taaweel ontology/)
    expect(planned[0].prompt).toMatch(/no depiction of people/i)
    expect(planned[1].prompt).toMatch(/closing sequence/)
    expect(planned[0].line).not.toMatch(/introducing/i)
  })
})

const hooks = (): RunHooks => ({ progress: () => undefined, handoff: async () => { throw new Error('no hand-off expected') } })
const ff = (args: string[]) => { const r = spawnSync(ffmpegBin(), ['-y', '-v', 'error', ...args]); if (r.status !== 0) throw new Error(String(r.stderr)) }

describe.skipIf(!findChrome() || !canShowWindow())('the film follows the brief (stand-in models)', () => {
  let site: AppSite
  let root: string
  beforeAll(async () => { site = await startAppSite(); root = mkdtempSync(join(tmpdir(), 'vg-brief-')) }, 120000)
  afterAll(async () => { await site?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }, 60000)

  const briefs: string[] = []
  const tools: MediaTools = {
    clip: async (_p, seconds) => {
      const file = join(root, `red-${briefs.length}.mp4`)
      briefs.push('clip')
      ff(['-f', 'lavfi', '-i', `color=c=red:size=1280x720:rate=24:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
      return { file, durationSec: seconds }
    },
    music: async (brief) => {
      briefs.push(brief)
      const file = join(root, 'amb.mp3')
      ff(['-f', 'lavfi', '-i', 'anoisesrc=d=20:c=pink', file])
      return readFileSync(file)
    }
  }
  const frameAt = async (video: string, t: number) => {
    const out = join(root, `f-${Math.round(t * 10)}.png`)
    ff(['-ss', String(t), '-i', video, '-frames:v', '1', out])
    const s = await sharp(out).stats()
    return { r: s.channels[0].mean, g: s.channels[1].mean, b: s.channels[2].mean }
  }

  it('AI clip first, then the title and the problem, the demo, an AI clip, and the closing card last', async () => {
    const input: RunInput = {
      runDir: join(root, 'film'),
      startUrl: `${site.url}/login`,
      context: 'use ai video intro.\nnatural white noise birds and thunders as background music - halal music\nafter intro, present problem statement and then show screen recording as answer\nShow the dashboard.\n\nai-video based outro',
      mode: 'launch',
      launch: { feature: "Taaweel's Ontology feature", tagline: 'Visually understand Quran', closing: 'Available now', cta: 'Try it', targetSec: 30 },
      signIn: 'saved',
      vault: { username: DEMO_USER, password: DEMO_PASS },
      guardrailText: '',
      checks: {},
      depth: 'quick',
      targetSec: 30,
      chat: null,
      speech: null,
      media: { tools, clips: false, music: false }
    }
    const out = await runAppRecording(input, hooks())
    expect(out.video).toBeTruthy()
    expect(out.aiClips).toBe(2)
    // natural sounds are made on this PC: the music model is never called
    expect(out.aiMusic).toBe(false)
    expect(briefs.filter((b) => b !== 'clip')).toHaveLength(0)
    const notes = (out.mediaNotes ?? []).join(' | ')
    expect(notes).toMatch(/at the start/)
    expect(notes).toMatch(/at the end/)
    expect(notes).toMatch(/Problem statement/)
    expect(notes).toMatch(/Background sound: .*birdsong.*no instruments/)
    expect(notes).toMatch(/animated around a/)
    const first = await frameAt(out.video!, 1)
    expect(first.r).toBeGreaterThan(180)
    expect(first.g).toBeLessThan(80)
    // the closing card has the last word; the AI closing clip leads into it
    const last = await frameAt(out.video!, out.durationSec! - 1.5)
    expect(last.r < 150 || last.g > 80).toBe(true)
    // the title card is not the first thing on screen
    const second = await frameAt(out.video!, 5.2)
    expect(second.r < 150 || second.g > 80).toBe(true)
  }, 400000)
})
