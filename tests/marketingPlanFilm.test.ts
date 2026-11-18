import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ffmpegBin } from '../src/main/audio/pcm'
import { findChrome, findHeadlessShell } from '../src/main/appRecon/browser'
import type { LLMProvider, SpeechProvider } from '../src/main/providers/types'
import type { MediaTools } from '../src/main/appRecon/run'
import { runMarketingFilm } from '../src/main/marketing/film'
import { planFromCard, readMarketBriefByRules } from '../src/main/marketing/agent/brief'
import { reviewFilm, buildReport } from '../src/main/marketing/agent/loop'
import type { BusinessProfile, VideoCard } from '../src/shared/marketing'

/**
 * A film made from a plan: what the person's brief asked is what is made,
 * and what could not be made is recorded for the report. Stand-in models
 * make the clips, pictures, voices and music, so nothing is paid for.
 */

const ff = (args: string[]) => {
  const r = spawnSync(ffmpegBin(), ['-y', '-v', 'error', ...args])
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-400))
}
const root = mkdtempSync(join(tmpdir(), 'vg-mkp-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

const profile: BusinessProfile = {
  id: 'biz-test0002',
  domain: 'pipeheroes.test',
  name: 'Pipe Heroes',
  tagline: 'Leaks fixed fast',
  about: 'Emergency plumbing for homes in Lisbon.',
  services: [{ name: 'Emergency repairs', url: 'https://pipeheroes.test/repairs', summary: 'A plumber at your door within the hour.', benefits: ['Arrives within the hour', 'Fixed price quoted first'] }],
  brand: { colors: ['#1a4c8c'], accent: '3b82f6', backdrop: ['#10203a', '#08101c'] },
  cards: [],
  siteMd: 'site.md',
  notes: [],
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z'
}
const card: VideoCard = {
  id: 'card-test02',
  title: 'The midnight leak',
  problem: 'A pipe bursts at night and every call goes to voicemail.',
  solution: 'Pipe Heroes sends a plumber within the hour. The price is agreed before the work starts.',
  cta: 'Call us now',
  targetSec: 30
}
const business = { name: profile.name, tagline: profile.tagline, about: profile.about, services: profile.services }

const canFilm = !!findChrome() || !!findHeadlessShell()

describe.skipIf(!canFilm)('a film made from a brief (stand-in models)', () => {
  const spoken: string[] = []
  const speech = {
    id: 'fake', label: 'Fake voice', model: 'fake-1', voices: ['v'], defaultVoice: () => 'v',
    tts: async (req: { text: string }) => {
      spoken.push(req.text)
      const file = join(root, `voice-${spoken.length}.wav`)
      ff(['-f', 'lavfi', '-i', 'sine=frequency=200:duration=1.4', '-ar', '24000', '-ac', '1', file])
      return { audio: readFileSync(file), mimeType: 'audio/wav', words: [] }
    }
  } as unknown as SpeechProvider

  const calls: string[] = []
  const musicAsks: Array<{ brief: string; model?: string }> = []
  const tools: MediaTools = {
    clip: async (_p, seconds) => {
      calls.push('clip')
      const file = join(root, `clip-${calls.length}.mp4`)
      ff(['-f', 'lavfi', '-i', `color=c=0x446688:size=1080x1920:rate=30:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
      return { file, durationSec: seconds }
    },
    still: async () => {
      calls.push('still')
      const file = join(root, `still-${calls.length}.jpg`)
      await sharp({ create: { width: 1350, height: 2400, channels: 3, background: '#5a8a3a' } }).jpeg().toFile(file)
      return { file }
    },
    reviewStill: async () => ({ ok: true, reason: '' }),
    music: async (brief, model) => {
      musicAsks.push({ brief, model })
      const file = join(root, 'track.mp3')
      ff(['-f', 'lavfi', '-i', 'anoisesrc=d=40:c=pink', file])
      return readFileSync(file)
    }
  }

  const BRIEF = 'Open with an AI video of a leaking pipe at night. Say we answer calls within the hour. Show an AI video of the plumber arriving. Show an AI video of the repair. Do not mention prices. Arabic music with vocals and duff only. About 20 seconds for TikTok. End with Book a free visit.'

  it('makes what the brief asked, says why a clip became a card, and the music follows the chosen model', async () => {
    const plan = readMarketBriefByRules({ brief: BRIEF, business, card: { title: card.title, problem: card.problem, solution: card.solution, cta: card.cta, targetSec: card.targetSec } })
    expect(plan.platform).toBe('tiktok')
    const out = await runMarketingFilm({
      runDir: join(root, 'brief'), card, profile, chat: null, speech, tools, aiMusic: true, maxClips: 2,
      plan, assignment: { music: 'gemini:lyria-3.5', video: 'gemini:veo-3.2-lite' },
      progress: () => undefined, log: () => undefined
    })
    expect(existsSync(out.file)).toBe(true)
    // a tall film, because the brief said TikTok
    const probe = spawnSync(ffmpegBin(), ['-i', out.file, '-f', 'null', '-'], { encoding: 'utf8' })
    expect(probe.stderr).toMatch(/Video: h264.*1080x1920/)
    // the person's clips come first: the problem and the first asked-for point; the third could not be made (the plan allows two)
    expect(calls.filter((c) => c === 'clip')).toHaveLength(2)
    const by = (id: string) => out.made.find((m) => m.id === id)!
    expect(by('problem')).toMatchObject({ wanted: 'clip', made: 'clip' })
    const clipPoints = out.made.filter((m) => m.wanted === 'clip' && m.id !== 'problem')
    expect(clipPoints.filter((m) => m.made === 'clip')).toHaveLength(1)
    const fallen = clipPoints.find((m) => m.made === 'scene')!
    expect(fallen.fellBack).toMatch(/no more AI clips/)
    // the music is the described one, from the chosen model
    expect(musicAsks).toHaveLength(1)
    expect(musicAsks[0].model).toBe('gemini:lyria-3.5')
    expect(musicAsks[0].brief).toMatch(/arabic/i)
    expect(musicAsks[0].brief).toMatch(/duff/i)
    expect(musicAsks[0].brief).not.toMatch(/Instrumental only/)
    expect(out.musicSource).toBe('ai')
    // nothing the person ruled out is said
    expect(spoken.join(' ')).not.toMatch(/prices?/i)
    // the review tells the truth about the clip that became a card
    const review = reviewFilm(plan, { made: out.made, dropped: out.dropped, durationSec: out.durationSec, musicSource: out.musicSource, voiced: out.voiced, written: out.written })
    const report = buildReport(plan, { assignment: {}, answers: [] }, review, out.durationSec)
    expect(report.shortfalls.join(' ')).toMatch(/AI video clip.*animated card/)
  }, 420000)

  it('no music and no voice when the person chose them off', async () => {
    const plan = { ...planFromCard({ brief: '', business, card: { title: card.title, problem: card.problem, solution: card.solution, cta: card.cta, targetSec: card.targetSec } }), music: { none: true, description: '', vocals: 'none' as const, instruments: [], exclude: [], ambience: [], quiet: false }, voice: { none: true } }
    spoken.length = 0
    musicAsks.length = 0
    const out = await runMarketingFilm({
      runDir: join(root, 'quiet'), card, profile, chat: null, speech, tools, aiMusic: true, maxClips: 0,
      plan, assignment: { music: 'none', voice: 'none' },
      progress: () => undefined, log: () => undefined
    })
    expect(spoken).toHaveLength(0)
    expect(musicAsks).toHaveLength(0)
    expect(out.musicSource).toBe('none')
    expect(out.voiced).toBe(false)
  }, 420000)

  it('a writer that drifts from the person words is replaced before any voice is paid for', async () => {
    const plan = readMarketBriefByRules({ brief: 'Say we answer calls within the hour. Say the first visit is free. Do not mention prices.', business, card: { title: card.title, problem: card.problem, solution: card.solution, cta: card.cta, targetSec: 40 } })
    const chat = {
      generateJSON: async (req: { schemaName?: string }) => {
        if (req.schemaName === 'marketing_script')
          return {
            problemHeadline: 'Midnight panic',
            problemLine: 'Water is spreading across the kitchen floor and nobody picks up the phone.',
            beats: [
              { headline: 'Fast answers', line: 'Somebody picks up every call, whatever the hour, and a plumber is on the way.', chapter: 'The fix' },
              { headline: 'Fair deals', line: 'Prices are clear from the start, so there are no surprises on the bill.', chapter: 'What you get' }
            ].concat(plan.points.length > 2 ? [{ headline: 'More', line: 'Another warm line about care and trust in every visit.', chapter: 'More' }] : []),
            close: 'Pipe Heroes. Book a free visit.'
          }
        throw new Error(`unexpected schema ${req.schemaName}`)
      }
    } as unknown as LLMProvider
    spoken.length = 0
    const out = await runMarketingFilm({
      runDir: join(root, 'drift'), card, profile, chat, speech, tools: null, aiMusic: false, maxClips: 0,
      plan, assignment: {}, progress: () => undefined, log: () => undefined
    })
    // the line that mentions prices is never spoken
    expect(spoken.join(' ')).not.toMatch(/prices?/i)
    expect(out.notes.join(' ')).toMatch(/asked not to mention/)
    // and every point the person asked for is carried
    expect(spoken.join(' ').toLowerCase()).toMatch(/free/)
  }, 420000)
})
