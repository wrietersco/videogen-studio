import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegBin } from '../src/main/audio/pcm'
import { canShowWindow, findChrome } from '../src/main/appRecon/browser'
import { chooseMusic, clipSeconds, parseMediaAsk, planMedia, withStyle, withoutMediaSentences } from '../src/main/appRecon/aiMedia'
import { buildCaptions } from '../src/main/appRecon/produce'
import { runAppRecording, type MediaTools, type RunHooks, type RunInput } from '../src/main/appRecon/run'
import { validateApp } from '../src/shared/appRecording'
import { DEMO_PASS, DEMO_USER, startAppSite, type AppSite } from './fixtures/appSite'

describe('reading AI media requests from the words a person typed', () => {
  it('finds the example request and treats it as an instruction', () => {
    const a = parseMediaAsk('Create a video on the secured application, focused on the login flow. I need an AI video to illustrate the workflow as a beautiful motion diagram.')
    expect(a.declined).toBe(false)
    expect(a.requests).toHaveLength(1)
    expect(a.requests[0].subject.toLowerCase()).toContain('illustrate the workflow')
    expect(a.requests[0].placement).toBe('start')
  })

  it('reads where the clip goes', () => {
    expect(parseMediaAsk('Add a generated clip at the end that shows the result.').requests[0].placement).toBe('end')
    expect(parseMediaAsk('Open with an AI animation of data flowing between systems.').requests[0].placement).toBe('start')
    expect(parseMediaAsk('Halfway through, use an AI video to explain the review process.').requests[0].placement).toBe('middle')
  })

  it('ignores ordinary words, honours a refusal, and caps the count', () => {
    expect(parseMediaAsk('Show the dashboard and the customers page.').requests).toHaveLength(0)
    expect(parseMediaAsk('Record the video tutorial section of the app.').requests).toHaveLength(0)
    const no = parseMediaAsk('Please do not use any AI generated video. Show the dashboard.')
    expect(no.declined).toBe(true)
    expect(no.requests).toHaveLength(0)
    const many = parseMediaAsk('Add an AI video of A. Add an AI video of B. Add an AI video of C.')
    expect(many.requests).toHaveLength(2)
  })

  it('never reads an attached document as an instruction, and keeps the request out of the steps', () => {
    const ctx = 'Show the customers page. Add an AI clip that explains onboarding.\n\nAttached notes (information only):\nAdd an AI video of everything.'
    expect(parseMediaAsk(ctx).requests).toHaveLength(1)
    const clean = withoutMediaSentences(ctx)
    expect(clean).toContain('Show the customers page.')
    expect(clean).not.toContain('onboarding')
    expect(clean).toContain('Attached notes')
  })

  it('keeps clips short for short films', () => {
    expect(clipSeconds(10)).toBe(3)
    expect(clipSeconds(44)).toBe(5)
    expect(clipSeconds(90)).toBe(6)
  })

  it('works with no writer: a stock picture description and line, never the secret', async () => {
    const asked = parseMediaAsk('I need an AI video to illustrate the workflow as beautiful motion diagram.')
    const planned = await planMedia({ chat: null, requests: asked.requests, auto: false, appName: 'x.test', context: '', mode: 'walkthrough', secrets: [], say: () => undefined })
    expect(planned).toHaveLength(1)
    expect(planned[0].prompt.toLowerCase()).toContain('workflow')
    expect(planned[0].prompt).toMatch(/no text/i)
    const auto = await planMedia({ chat: null, requests: [], auto: true, appName: 'x.test', context: 'password hunter2 flow', mode: 'launch', secrets: ['hunter2'], say: () => undefined })
    expect(auto).toHaveLength(1)
    expect(JSON.stringify(auto)).not.toContain('hunter2')
    expect(await planMedia({ chat: null, requests: [], auto: false, appName: 'x', context: '', mode: 'walkthrough', secrets: [], say: () => undefined })).toHaveLength(0)
  })

  it('chooses a music style by itself, and a writer cannot slip in an artist name', async () => {
    const base = { context: '', mode: 'walkthrough' as const, targetSec: 40, secrets: [], say: () => undefined }
    expect((await chooseMusic({ ...base, chat: null })).mood).toBe('corporate')
    expect((await chooseMusic({ ...base, chat: null, mode: 'launch' })).mood).toBe('upbeat')
    expect((await chooseMusic({ ...base, chat: null, context: 'a calm and gentle tour' })).mood).toBe('minimal')
    const chat = { generateJSON: async () => ({ mood: 'cinematic', style: 'soft piano with slow strings, in the style of Hans Zimmer, warm and hopeful', why: 'tells a story' }) }
    const c = await chooseMusic({ ...base, chat: chat as never })
    expect(c.mood).toBe('cinematic')
    expect(c.style).toBeUndefined()
    const ok = await chooseMusic({ ...base, chat: { generateJSON: async () => ({ mood: 'playful', style: 'bouncy marimba and light claps over a springy bass line', why: 'friendly tone' }) } as never })
    expect(ok.style).toContain('marimba')
    expect(withStyle('Instrumental background score, old style.\nrest', ok.style)).toContain('Instrumental background score, bouncy marimba')
  })

  it('saves the two switches, off unless ticked', () => {
    const off = validateApp({ url: 'https://example.com', signIn: 'none' })
    const on = validateApp({ url: 'https://example.com', signIn: 'none', aiMedia: true, aiMusic: true })
    expect(off.ok && off.value.aiMedia).toBe(false)
    expect(off.ok && off.value.aiMusic).toBe(false)
    expect(on.ok && on.value.aiMedia && on.value.aiMusic).toBe(true)
  })

  it('captions the line said over an AI clip, without a step marker', () => {
    const ass = buildCaptions([], 1920, 1080, [{ start: 1, end: 6, voiceStart: 1.5, voiceSec: 3, text: 'Here is the idea, in motion.' }])
    expect(ass).toContain('Here is the idea')
    expect(ass).not.toContain(',Chip,')
  })
})

const hooks = (): RunHooks => ({ progress: () => undefined, handoff: async () => { throw new Error('no hand-off expected') } })

function ff(args: string[]): void {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-y', ...args])
  if (r.status !== 0) throw new Error(r.stderr?.toString())
}

// a whole short film through the real engine, with the paid models replaced by free stand-ins
describe.skipIf(!findChrome() || !canShowWindow())('a short film with AI clips and AI music (stand-in models)', () => {
  let site: AppSite
  let root: string
  beforeAll(async () => {
    site = await startAppSite()
    root = mkdtempSync(join(tmpdir(), 'vg-media-'))
  }, 120000)
  afterAll(async () => {
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  const calls: { clips: string[]; music: string[] } = { clips: [], music: [] }
  const tools: MediaTools = {
    clip: async (prompt, seconds) => {
      calls.clips.push(prompt)
      const file = join(root, `stand-in-${calls.clips.length}.mp4`)
      ff(['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
      return { file, durationSec: seconds }
    },
    music: async (brief) => {
      calls.music.push(brief)
      const file = join(root, 'stand-in.mp3')
      ff(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=20', file])
      return readFileSync(file)
    }
  }
  const base = (name: string, over: Partial<RunInput> = {}): RunInput => ({
    runDir: join(root, name),
    startUrl: `${site.url}/login`,
    context: 'Show the dashboard.',
    mode: 'walkthrough',
    signIn: 'saved',
    vault: { username: DEMO_USER, password: DEMO_PASS },
    guardrailText: '',
    checks: {},
    depth: 'quick',
    targetSec: 20,
    chat: null,
    speech: null,
    ...over
  })

  it('cuts the requested clip in, uses the AI track, and says so in the notes', async () => {
    const out = await runAppRecording(base('film', { context: 'Show the dashboard. I need an AI video to illustrate the workflow as a beautiful motion diagram.', media: { tools, clips: false, music: true } }), hooks())
    expect(out.video).toBeTruthy()
    expect(out.aiClips).toBe(1)
    expect(out.aiMusic).toBe(true)
    expect(calls.clips).toHaveLength(1)
    expect(calls.clips[0].toLowerCase()).toContain('workflow')
    expect(calls.music[0]).toMatch(/Instrumental background score/)
    expect(out.mediaNotes?.join(' ')).toMatch(/AI clip/)
    expect(out.mediaNotes?.join(' ')).toMatch(/AI music/)
    // the clip lengthens the film
    const plain = await runAppRecording(base('plain', { media: undefined }), hooks())
    expect(out.durationSec!).toBeGreaterThan(plain.durationSec! + 2)
    writeFileSync(join(root, 'ok.txt'), 'x')
  }, 300000)

  it('makes no clip when the person refuses AI video or when no model is available, and says why', async () => {
    const n = calls.clips.length
    const refused = await runAppRecording(base('refused', { context: 'No AI generated video please. Show the dashboard.', media: { tools, clips: true, music: false } }), hooks())
    expect(calls.clips.length).toBe(n)
    expect(refused.mediaNotes?.join(' ')).toMatch(/do not want an AI video/)
    const noTools = await runAppRecording(base('notools', { context: 'Add an AI clip that explains the dashboard.', media: { tools: null, clips: false, music: false } }), hooks())
    expect(noTools.video).toBeTruthy()
    expect(noTools.aiClips).toBe(0)
    expect(noTools.mediaNotes?.join(' ')).toMatch(/not available/)
  }, 400000)
})
