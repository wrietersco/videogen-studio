import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ffmpegBin } from '../src/main/audio/pcm'
import { findChrome, findHeadlessShell } from '../src/main/appRecon/browser'
import type { LLMProvider, SpeechProvider } from '../src/main/providers/types'
import type { MediaTools } from '../src/main/appRecon/run'
import { runMarketingFilm } from '../src/main/marketing/film'
import { readFilmRecord, type FilmRecord } from '../src/main/marketing/filmRecord'
import { readMarketBriefByRules } from '../src/main/marketing/agent/brief'
import { applyEdit, interpretRevision, normaliseEdit, readPreviousRun, readRevisionByRules, reviseFilm, spendRequest, type PreviousRun } from '../src/main/marketing/agent/revise'
import type { MarketPariHooks } from '../src/main/marketing/agent/loop'
import type { BusinessProfile, VideoCard } from '../src/shared/marketing'

/**
 * Making a finished film again with the changes the person typed: the request
 * read (rules and AI), only what changed made again, the rest used again, and
 * an honest list of what could not be done. Stand-in models only.
 */

const root = mkdtempSync(join(tmpdir(), 'vg-mkrev-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))
const ff = (args: string[]) => {
  const r = spawnSync(ffmpegBin(), ['-y', '-v', 'error', ...args])
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-400))
}

const profile: BusinessProfile = {
  id: 'biz-test0003',
  domain: 'crumbs.test',
  name: 'Crumbs',
  tagline: 'Warm cookies to your door',
  about: 'A small bakery in Lahore that bakes cookies to order and delivers them warm.',
  services: [{ name: 'Cookie boxes', url: 'https://crumbs.test/boxes', summary: 'Boxes of fresh cookies delivered the same day.', benefits: ['Baked to order', 'Delivered warm'] }],
  brand: { colors: ['#8b4513'], accent: '8b4513', backdrop: ['#2a160a', '#120a04'] },
  cards: [],
  siteMd: 'site.md',
  notes: [],
  createdAt: '2026-11-18T10:00:00Z',
  updatedAt: '2026-11-18T10:00:00Z'
}
const card: VideoCard = { id: 'card-test03', title: 'Midnight cravings', problem: 'It is late, you want something sweet and every shop is closed.', solution: 'Crumbs bakes your cookies to order and brings them warm to your door.', cta: 'Order on WhatsApp', targetSec: 30 }
const business = { name: profile.name, tagline: profile.tagline, about: profile.about, services: profile.services }
const plan0 = readMarketBriefByRules({ brief: 'Say we bake every cookie to order. Show an AI picture of a warm chocolate cookie box. Say we deliver warm across Lahore. End with Order on WhatsApp.', business, card: { title: card.title, problem: card.problem, solution: card.solution, cta: card.cta, targetSec: 30 } })

/** an earlier film written by hand: the shape a finished run leaves behind */
function fakePrev(): PreviousRun {
  const dir = join(root, 'prev-fake')
  mkdirSync(dir, { recursive: true })
  const still = join(dir, 'still-a.jpg')
  writeFileSync(still, 'x')
  const clip = join(dir, 'clip-a.mp4')
  writeFileSync(clip, 'x')
  const film: FilmRecord = {
    version: 1,
    script: {
      hook: 'Craving cookies at midnight?',
      problemHeadline: 'Late night cravings',
      problemLine: 'It is late and every shop is closed.',
      beats: plan0.points.map((p, i) => ({ headline: `Headline ${i + 1}`, line: p.say, chapter: 'What you get', pointId: p.id })),
      close: 'Crumbs. Order on WhatsApp.'
    },
    parts: [
      { id: 'problem', headline: 'Late night cravings', line: 'It is late and every shop is closed.', kind: 'scene', shots: [] },
      ...plan0.points.map((p, i) => ({ id: p.id, headline: `Headline ${i + 1}`, line: p.say, kind: (i === 0 ? 'clip' : 'image') as 'clip' | 'image', shots: i === 0 ? [{ kind: 'clip' as const, file: clip, sec: 5 }] : [{ kind: 'still' as const, file: still }] }))
    ],
    voices: [],
    music: { source: 'builtin', mood: 'warm' },
    frame: { width: 1920, height: 1080 },
    style: {},
    targetSec: 30,
    durationSec: 31
  }
  return { runId: 'mrun-aaaaaaaaaaaaaaaa', dir, plan: plan0, assignment: {}, decisions: [], report: null, film }
}

describe('reading a change request by rules', () => {
  const prev = fakePrev()
  it('reads the common asks', () => {
    const e = readRevisionByRules('Shorter, 15 seconds. Urdu voice. No music. Say we deliver on Sundays. Change the ending to "Call now". Brighter captions. No stickers. Use a different picture in the second scene.', prev)
    expect(e.targetSec).toBe(15)
    expect(e.voice?.language).toBe('Urdu')
    expect(e.music?.none).toBe(true)
    expect(e.add[0].say).toBe('We deliver on Sundays.')
    expect(e.cta).toBe('Call now')
    expect(e.style.captionColor).toBe('brighter')
    expect(e.style.stickers).toBe(false)
    expect(e.remake).toEqual([{ part: plan0.points[0].id }])
    expect(e.cannot).toEqual([])
  })
  it('finds a part by what it shows, and slows its clip', () => {
    const e = readRevisionByRules('make the cookie clip slower', prev)
    expect(e.pace).toEqual([{ part: plan0.points[0].id, slow: 1.5 }])
  })
  it('a hook with the words given is used; a creative ask with none needs the writer and is listed honestly', () => {
    expect(readRevisionByRules('change the hook to "Midnight cookie emergency?"', prev).hook).toBe('Midnight cookie emergency?')
    const e = readRevisionByRules('make the hook funnier. Add my logo dancing in the corner with fireworks', prev)
    expect(e.hook).toBeUndefined()
    expect(e.cannot.join(' ')).toMatch(/funnier.*AI writer/)
    expect(e.cannot.length).toBe(2)
  })
})

describe('reading a change request with the AI writer', () => {
  const prev = fakePrev()
  it('normalises the writer’s edit: unknown parts dropped, colours read, numbers clamped', () => {
    const e = normaliseEdit({ hook: 'Cookies at 2am? Yes.', lines: [{ part: plan0.points[1].id, line: 'Warm across Lahore, every night.' }, { part: 'nope', line: 'x' }], remake: [{ part: 'close' }], style: { captionColor: 'yellow', captionScale: 9 }, targetSec: 2, cannot: ['Changing the logo is not something I can do.'] }, prev)!
    expect(e.hook).toBe('Cookies at 2am? Yes.')
    expect(e.lines).toHaveLength(1)
    expect(e.remake).toHaveLength(0)
    expect(e.style).toEqual({ captionColor: '#ffd400', captionScale: 1.6 })
    expect(e.targetSec).toBe(6)
    expect(e.cannot).toHaveLength(1)
  })
  it('falls back to rules when the writer fails', async () => {
    const chat = { generateJSON: async () => { throw new Error('offline') } } as unknown as LLMProvider
    const e = await interpretRevision('no music', prev, { chat })
    expect(e.source).toBe('rules')
    expect(e.music?.none).toBe(true)
  })
})

describe('applying an edit', () => {
  it('keeps untouched parts’ pictures, re-makes the one asked for, and counts what is new', () => {
    const prev = fakePrev()
    const e = readRevisionByRules('Use a different picture in the third scene showing a box on an office desk. Make the cookie clip slower.', prev)
    const a = applyEdit(prev, e, { profile, hasChat: false, tools: { clip: async () => ({ file: '' }), still: async () => ({ file: '' }), music: async () => Buffer.alloc(0) }, voiced: true })
    const [p1, p2] = plan0.points.map((p) => p.id)
    expect(a.reuse.shots?.[p1]?.[0].slow).toBe(1.5)
    expect(a.reuse.shots?.[p2]).toBeUndefined()
    expect(a.plan.points.find((p) => p.id === p2)?.visual).toBe('box on an office desk')
    expect(a.reuse.script).toBeDefined()
    expect(a.spend.pictures).toBeGreaterThan(0)
    expect(a.spend.clips).toBe(0)
    expect(spendRequest(a.spend)?.options.map((o) => o.id)).toEqual(['make', 'free', 'stop'])
  })
  it('lists honestly what cannot be done without the writer or the tools', () => {
    const prev = fakePrev()
    const e = readRevisionByRules('Urdu voice. Make it 60 seconds. Use a different picture in the second scene.', prev)
    const a = applyEdit(prev, e, { profile, hasChat: false, tools: null, voiced: false })
    const all = a.cannot.join(' ')
    expect(all).toMatch(/Urdu.*AI writer/)
    expect(all).toMatch(/no new words to fill 60s/)
    expect(all).toMatch(/not available on this account/)
    expect(a.plan.voice.language).toBeUndefined()
  })
})

const canFilm = !!findChrome() || !!findHeadlessShell()

describe.skipIf(!canFilm)('a whole revision (stand-in models)', () => {
  const spoken: string[] = []
  const speech = {
    id: 'fake', label: 'Fake voice', model: 'fake-1', voices: ['v'], defaultVoice: () => 'v',
    tts: async (req: { text: string }) => {
      spoken.push(req.text)
      const file = join(root, `voice-${spoken.length}.wav`)
      ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.4', '-ar', '24000', '-ac', '1', file])
      return { audio: readFileSync(file), mimeType: 'audio/wav', words: [] }
    }
  } as unknown as SpeechProvider
  const calls: string[] = []
  const tools: MediaTools = {
    clip: async (_p, seconds) => {
      calls.push('clip')
      const file = join(root, `clip-${calls.length}.mp4`)
      ff(['-f', 'lavfi', '-i', `color=c=0x664422:size=1280x720:rate=30:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
      return { file, durationSec: seconds }
    },
    still: async () => {
      calls.push('still')
      const file = join(root, `still-${calls.length}.jpg`)
      await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#a0602a' } }).jpeg().toFile(file)
      return { file }
    },
    reviewStill: async () => ({ ok: true, reason: '' }),
    music: async () => { throw new Error('no music in this test') }
  }

  it('changes the hook and one line: only that line is said again, every picture is used again', async () => {
    // the first film
    const dir1 = join(root, 'runs', 'mrun-1111111111111111')
    const first = await runMarketingFilm({ runDir: dir1, card, profile, chat: null, speech, tools, aiMusic: false, maxClips: 0, plan: plan0, assignment: { music: 'builtin:procedural' }, progress: () => undefined, log: () => undefined })
    writeFileSync(join(dir1, 'market-plan.json'), JSON.stringify({ plan: plan0, assignment: { music: 'builtin:procedural' }, decisions: [] }))
    const rec = readFilmRecord(dir1)!
    expect(rec.voices.length).toBe(first.made.length)
    expect(rec.parts.filter((p) => p.shots.length).length).toBeGreaterThan(0)
    const prev = readPreviousRun('mrun-1111111111111111', dir1)!
    const target = plan0.points[1].id

    spoken.length = 0
    calls.length = 0
    const chat = {
      generateJSON: async (req: { schemaName?: string }) => {
        if (req.schemaName === 'market_revision') return { hook: 'Cookies at midnight? Easy.', lines: [{ part: target, line: 'We bring them warm to any door in Lahore.' }], cannot: ['Your logo cannot dance: the film has no logo animation.'] }
        throw new Error('not in this test')
      }
    } as unknown as LLMProvider
    const events: string[] = []
    const hooks: MarketPariHooks = { mode: 'autopilot', capabilities: { access: 'plan', jobs: [], limits: [] }, emit: (e) => events.push(e.kind), decide: async () => null }
    const dir2 = join(root, 'runs', 'mrun-2222222222222222')
    mkdirSync(dir2, { recursive: true })
    const r = await reviseFilm({ prev, request: 'Make the hook funnier and say we bring them warm to any door in Lahore in the third scene. Make my logo dance.', runDir: dir2, profile, card, chat, speech, tools, maxClips: 0, hooks, progress: () => undefined, log: () => undefined })

    expect(existsSync(r.out.file)).toBe(true)
    // only the changed line was voiced; no picture or clip was made again
    expect(spoken).toEqual(['We bring them warm to any door in Lahore.'])
    expect(calls).toEqual([])
    expect(r.out.reused?.voices).toBe(first.made.length - 1)
    const rec2 = readFilmRecord(dir2)!
    expect(rec2.script.hook).toBe('Cookies at midnight? Easy.')
    expect(rec2.parts.find((p) => p.id === target)?.shots).toEqual(rec.parts.find((p) => p.id === target)?.shots)
    // the report says what changed, what was kept and what could not be done
    expect(r.revision.changed.join(' ')).toMatch(/hook now says/)
    expect(r.revision.kept.join(' ')).toMatch(/voice line/)
    expect(r.revision.cannot.join(' ')).toMatch(/logo/)
    expect(r.report.shortfalls.join(' ')).toMatch(/logo/)
    expect(events).toContain('pari-plan')
    expect(events).toContain('pari-report')
    expect(JSON.parse(readFileSync(join(dir2, 'market-report.json'), 'utf8')).revision.parentRunId).toBe('mrun-1111111111111111')
  }, 600000)
})
