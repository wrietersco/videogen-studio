import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ffmpegBin, SR } from '../src/main/audio/pcm'
import { findChrome, findHeadlessShell } from '../src/main/appRecon/browser'
import { renderScene } from '../src/main/appRecon/scenes'
import type { LLMProvider, SpeechProvider } from '../src/main/providers/types'
import type { MediaTools } from '../src/main/appRecon/run'
import { assemble } from '../src/main/marketing/assemble'
import { FilmCancelled, runMarketingFilm } from '../src/main/marketing/film'
import type { BusinessProfile, VideoCard } from '../src/shared/marketing'

/**
 * The film engine without the recording: pieces are cross-faded into one
 * video with voice, music and captions. Stand-in models make the clips,
 * pictures and voices (a colour, a gradient, a tone), so no model is paid
 * for and the picture is still real ffmpeg work.
 */

const ff = (args: string[]) => {
  const r = spawnSync(ffmpegBin(), ['-y', '-v', 'error', ...args])
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-400))
}
const root = mkdtempSync(join(tmpdir(), 'vg-mkt-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

const profile: BusinessProfile = {
  id: 'biz-test0001',
  domain: 'greenleaf.test',
  name: 'GreenLeaf Landscapes',
  tagline: 'Gardens that take care of themselves',
  about: 'Garden design and monthly care for busy families in Lisbon, from one team.',
  services: [
    { name: 'Garden design', url: 'https://greenleaf.test/garden-design', summary: 'A planting plan matched to your soil and light.', benefits: ['A plan you can read at a glance', 'One revision included'], audience: 'busy families' },
    { name: 'Garden care plans', url: 'https://greenleaf.test/garden-care', summary: 'A monthly visit that keeps the garden healthy.', benefits: ['The same gardener every month', 'Watering checks included'] }
  ],
  brand: { colors: ['#1a5c1a'], accent: '2f9e44', backdrop: ['#1b2a1b', '#0a120a'] },
  cards: [],
  siteMd: 'site.md',
  notes: [],
  createdAt: '2026-11-15T10:00:00Z',
  updatedAt: '2026-11-15T10:00:00Z'
}
const card: VideoCard = {
  id: 'card-test01',
  title: 'The weekend the garden took back',
  problem: 'Weekends disappear into watering, pruning and guessing what each plant needs — and the garden still looks tired by Sunday.',
  solution: 'GreenLeaf designs a garden that fits your light and soil, then keeps it healthy with one monthly visit.',
  cta: 'Book a free visit',
  serviceIdx: 1,
  targetSec: 25
}

/** a quiet second of voice, as raw samples */
const tone = (sec: number): Float32Array => {
  const pcm = new Float32Array(Math.round(sec * SR))
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((i / SR) * 2 * Math.PI * 220) * 0.2
  return pcm
}

describe('assembling pieces into one film (no browser needed)', () => {
  it('cross-fades scenes, a zooming still and a clip, with voice and captions baked in', async () => {
    const dir = join(root, 'assemble')
    mkdirSync(dir, { recursive: true })
    // "rendered scenes": shorter than their slots, so the last frame is held
    ff(['-f', 'lavfi', '-i', 'color=c=0x224466:size=1920x1080:rate=30:duration=4', '-pix_fmt', 'yuv420p', join(dir, 'scene-a.mp4')])
    ff(['-f', 'lavfi', '-i', 'color=c=0x664422:size=1920x1080:rate=30:duration=5', '-pix_fmt', 'yuv420p', join(dir, 'scene-b.mp4')])
    // a still (bigger than the frame, like a good picture) and a clip shorter than its slot
    await sharp({ create: { width: 2400, height: 1350, channels: 3, background: '#3a7d44' } }).jpeg().toFile(join(dir, 'still.jpg'))
    ff(['-f', 'lavfi', '-i', 'color=c=0x883333:size=1920x1080:rate=30:duration=4', '-pix_fmt', 'yuv420p', join(dir, 'clip.mp4')])

    const out = await assemble({
      dir,
      pieces: [
        { kind: 'scene', file: join(dir, 'scene-a.mp4'), text: 'The trouble, spoken at length so the captions have something to chew on.', pcm: tone(2.2), sec: 6.5, srcSec: 4 },
        { kind: 'still', file: join(dir, 'still.jpg'), text: 'One picture, slowly pushing in.', chapter: 'The fix', pcm: tone(1.8), sec: 5.5 },
        { kind: 'clip', file: join(dir, 'clip.mp4'), text: 'A clip whose last frame is held a moment.', chapter: 'Proof', pcm: tone(1.6), sec: 6.0, clipSec: 4 },
        { kind: 'scene', file: join(dir, 'scene-b.mp4'), text: 'The close.', pcm: tone(1.4), sec: 5.5, srcSec: 5, fadeOut: true }
      ],
      title: card.title
    })
    expect(existsSync(out.file)).toBe(true)
    expect(out.durationSec).toBeGreaterThan(18)
    expect(out.durationSec).toBeLessThan(26)
    expect(existsSync(out.captionsFile)).toBe(true)
    expect(out.musicSource).toBe('builtin')
    // the film is a real video with sound
    const probe = spawnSync(ffmpegBin(), ['-i', out.file, '-f', 'null', '-'], { encoding: 'utf8' })
    expect(probe.stderr).toMatch(/Video: h264/)
    expect(probe.stderr).toMatch(/Audio: aac/)
  }, 180000)
})

// scenes render headless, so the downloaded headless shell is enough
const canFilm = !!findChrome() || !!findHeadlessShell()

describe.skipIf(!canFilm)('one card\'s film (stand-in models)', () => {
  const speech = {
    id: 'fake', label: 'Fake voice', model: 'fake-1', voices: ['v'], defaultVoice: () => 'v',
    tts: async (req: { text: string }) => {
      expect(req.text.length).toBeGreaterThan(3)
      const file = join(root, `voice-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.wav`)
      ff(['-f', 'lavfi', '-i', 'sine=frequency=200:duration=1.4', '-ar', '24000', '-ac', '1', file])
      return { audio: readFileSync(file), mimeType: 'audio/wav', words: [] }
    }
  } as unknown as SpeechProvider

  const made: string[] = []
  const tools: MediaTools = {
    clip: async (_p, seconds) => {
      made.push('clip')
      const file = join(root, `clip-${made.length}.mp4`)
      ff(['-f', 'lavfi', '-i', `color=c=0x446688:size=1920x1080:rate=30:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
      return { file, durationSec: seconds }
    },
    still: async () => {
      made.push('still')
      const file = join(root, `still-${made.length}.jpg`)
      await sharp({ create: { width: 2400, height: 1350, channels: 3, background: '#5a8a3a' } }).jpeg().toFile(file)
      return { file }
    },
    reviewStill: async () => ({ ok: true, reason: '' }),
    music: async () => {
      made.push('music')
      const file = join(root, 'track.mp3')
      ff(['-f', 'lavfi', '-i', 'anoisesrc=d=30:c=pink', file])
      return readFileSync(file)
    }
  }

  it('the free engine makes a film of animated scenes, captions and the built-in score', async () => {
    const out = await runMarketingFilm({
      runDir: join(root, 'free'), card, profile, chat: null, speech, tools: null, aiMusic: false, maxClips: 0,
      progress: (stage) => expect(['script', 'voice', 'media', 'assemble']).toContain(stage), log: () => undefined
    })
    expect(existsSync(out.file)).toBe(true)
    expect(out.durationSec).toBeGreaterThan(15)
    expect(out.elements.join(' ')).toMatch(/Animated scenes/)
    expect(out.elements.join(' ')).not.toMatch(/AI video clip/)
    expect(out.notes.join(' ')).toMatch(/Brand colours from greenleaf\.test/)
  }, 300000)

  it('with AI on, the engine chooses clips, pictures and music itself', async () => {
    const chat = {
      generateJSON: async (req: { schemaName?: string }) => {
        if (req.schemaName === 'marketing_script')
          return {
            problemHeadline: 'The garden wins',
            problemLine: 'Every weekend ends in watering cans and brown leaves, while the garden still looks tired.',
            beats: [
              { headline: 'A garden that fits', line: 'GreenLeaf designs around your light and soil, so planting works the first time.', chapter: 'The fix' },
              { headline: 'One monthly visit', line: 'The same gardener returns each month to water, prune and feed everything.', chapter: 'How it works' },
              { headline: 'Weekends back', line: 'Families get their weekends back, and the garden looks better every month.', chapter: 'What you get' }
            ],
            close: 'GreenLeaf Landscapes. Book a free visit.'
          }
        if (req.schemaName === 'marketing_shots') return { shots: [{ n: 1, prompt: 'A slow shot over a Lisbon rooftop garden at golden hour, hose water arcing onto dark green leaves, camera drifting forward, warm low light, photographic.' }] }
        if (req.schemaName === 'music_choice') return { mood: 'minimal', style: 'Soft acoustic guitar over gentle strings, unhurried and warm.', why: 'calm gardens' }
        throw new Error(`unexpected schema ${(req as { schemaName?: string }).schemaName}`)
      }
    } as unknown as LLMProvider
    made.length = 0
    const out = await runMarketingFilm({
      runDir: join(root, 'ai'), card, profile, chat, speech, tools, aiMusic: true, maxClips: 1,
      progress: () => undefined, log: () => undefined
    })
    expect(existsSync(out.file)).toBe(true)
    // the engine picked its own elements
    expect(made).toContain('music')
    expect(out.elements.join(' ')).toMatch(/AI voice-over/)
    expect(out.elements.join(' ')).toMatch(/Animated scenes/)
    expect(out.durationSec).toBeGreaterThan(15)
  }, 300000)

  it('a cancelled film stops before anything is made', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      runMarketingFilm({ runDir: join(root, 'stopped'), card, profile, chat: null, speech: null, tools: null, aiMusic: false, maxClips: 0, signal: abort.signal, progress: () => undefined, log: () => undefined })
    ).rejects.toBeInstanceOf(FilmCancelled)
  }, 60000)
})

describe.skipIf(!canFilm)('the point scene', () => {
  it('renders a mid-film statement under the brand colour', async () => {
    const out = await renderScene({ kind: 'point', motif: 'flow', pill: 'The fix', headline: 'One monthly visit', accent: profile.brand.accent, backdrop: profile.brand.backdrop, durationSec: 2.5 }, join(root, 'point.mp4'))
    expect(existsSync(out.file)).toBe(true)
    expect(out.durationSec).toBeGreaterThanOrEqual(2.4)
  }, 120000)
})
