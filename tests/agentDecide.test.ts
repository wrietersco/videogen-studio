import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICY, type Entitlements } from '../src/shared/plans'
import type { FilmPlan, MusicSpec } from '../src/shared/agentBrief'
import { readCapabilities, type CapabilitySource } from '../src/main/appRecon/agent/capabilities'
import { applyAnswers, autopilotAnswers, decisionsFor, needsOf } from '../src/main/appRecon/agent/decide'
import { musicPrompt } from '../src/main/appRecon/agent/musicBrief'

const ent = (plan: 'free' | 'plus' | 'ultra', over: Partial<Entitlements> = {}): Entitlements => {
  const p = DEFAULT_POLICY.plans[plan]
  return {
    plan, soldPlan: plan, label: p.label,
    access: { state: 'active', reason: '', paidThrough: null, graceEndsAt: null },
    trial: { active: false, endsAt: null, daysLeft: 0 },
    aiVideosPerMonth: p.aiVideosPerMonth, chatModel: p.chatModel, models: JSON.parse(JSON.stringify(p.models)),
    clipsPerVideo: p.clipsPerVideo, maxVideoSeconds: p.maxVideoSeconds, costCapUsdPerVideo: p.costCapUsdPerVideo,
    costCapUsdPerMonth: p.costCapUsdPerMonth, utilityUsdPerDay: p.utilityUsdPerDay, seats: 1,
    allowOwnKeys: false, aiAllowed: true, aiBlockedReason: '', ...over
  }
}

const media = (m: Partial<Record<'image' | 'voice' | 'music' | 'video', string>> = {}) => ({ image: 'auto', voice: 'auto', music: 'builtin:procedural', video: 'stock', ...m })

const MUSIC: MusicSpec = { none: false, description: 'Arabic music with vocals and duff only, no song', vocals: 'wordless', instruments: ['duff'], exclude: ['song'], ambience: [], quiet: false, genre: 'arabic' }

const plan = (over: Partial<FilmPlan> = {}): FilmPlan => ({
  goal: 'Show Taaweel', kind: 'walkthrough', segments: [{ id: 's1', kind: 'page', said: 'open home', required: true, url: 'https://x.test', how: 'glance', emphasis: 'normal' }],
  music: MUSIC, voice: {}, look: { style: null, noAbstract: false }, unplaced: [], source: 'ai', ...over
})

const planSrc = (musicPick: string, e = ent('plus')): CapabilitySource => ({ settings: { provider: 'mock', models: {}, media: media({ music: musicPick }), useOwnKeys: false }, access: 'plan', entitlements: e, keys: {} })
const ownKeys = (keys: CapabilitySource['keys'], musicPick = 'builtin:procedural'): CapabilitySource => ({ settings: { provider: 'openai', models: {}, media: media({ music: musicPick }), useOwnKeys: true }, access: 'own-keys', entitlements: null, keys })
const free: CapabilitySource = { settings: { provider: 'mock', models: {}, media: media(), useOwnKeys: false }, access: 'programmatic', entitlements: null, keys: {} }

describe('readCapabilities', () => {
  it('on Plus, Lyria is available, ElevenLabs Music is not in the plan', () => {
    const music = readCapabilities(planSrc('gemini:lyria-3.5')).jobs.find((j) => j.job === 'music')!
    expect(music.options.find((o) => o.id === 'gemini:lyria-3.5')!.available).toBe(true)
    const el = music.options.find((o) => o.id === 'elevenlabs:music_v2_5')!
    expect(el.available).toBe(false)
    expect(el.reason).toMatch(/Plus plan/)
    expect(music.options.find((o) => o.id === 'builtin:procedural')!.limits.join(' ')).toMatch(/cannot sing/)
  })
  it('own keys: only keyed providers are available', () => {
    const music = readCapabilities(ownKeys({ elevenlabs: true })).jobs.find((j) => j.job === 'music')!
    expect(music.options.filter((o) => o.available).map((o) => o.id).sort()).toEqual(['builtin:procedural', 'elevenlabs:music_v1', 'elevenlabs:music_v2_5'])
  })
  it('programmatic: every AI option is unavailable, with a reason', () => {
    const r = readCapabilities(free)
    for (const j of r.jobs) for (const o of j.options.filter((x) => !/^(builtin|stock|none)/.test(x.id))) expect(o.available).toBe(false)
    expect(r.jobs.find((j) => j.job === 'music')!.options.find((o) => o.id === 'gemini:lyria-3.5')!.reason).toMatch(/AI is off/)
  })
})

describe('decisionsFor: Taaweel music (vocals and duff)', () => {
  it('plan, built-in chosen in Settings: asks, offers Lyria first, never ElevenLabs', () => {
    const { requests, assignment } = decisionsFor(plan(), readCapabilities(planSrc('builtin:procedural')))
    const r = requests.find((q) => q.id === 'music')!
    expect(r.options.map((o) => o.id)).toEqual(['gemini:lyria-3.5', 'builtin:procedural', 'none'])
    expect(r.options.filter((o) => o.recommended)).toHaveLength(1)
    expect(r.autopick).toBe('gemini:lyria-3.5')
    expect(r.options.find((o) => o.id === 'builtin:procedural')!.detail).toMatch(/not have vocals/)
    expect(assignment.music).toBe('gemini:lyria-3.5')
  })
  it('plan with Lyria already chosen: no question, Lyria assigned', () => {
    const { requests, assignment } = decisionsFor(plan(), readCapabilities(planSrc('gemini:lyria-3.5')))
    expect(requests.find((q) => q.id === 'music')).toBeUndefined()
    expect(assignment.music).toBe('gemini:lyria-3.5')
  })
  it('own keys with only ElevenLabs: offers ElevenLabs, not Lyria', () => {
    const { requests } = decisionsFor(plan(), readCapabilities(ownKeys({ elevenlabs: true })))
    const r = requests.find((q) => q.id === 'music')!
    expect(r.options.map((o) => o.id)).toEqual(['elevenlabs:music_v2_5', 'elevenlabs:music_v1', 'builtin:procedural', 'none'])
    expect(r.autopick).toBe('elevenlabs:music_v2_5')
    expect(r.context).toMatch(/Gemini key/)
  })
  it('settings pick ElevenLabs and it is usable: respected, no question', () => {
    const { requests, assignment } = decisionsFor(plan(), readCapabilities(ownKeys({ elevenlabs: true, gemini: true }, 'elevenlabs:music_v2_5')))
    expect(requests.find((q) => q.id === 'music')).toBeUndefined()
    expect(assignment.music).toBe('elevenlabs:music_v2_5')
  })
  it('programmatic: no AI option is offered and the request explains why', () => {
    const { requests, assignment } = decisionsFor(plan(), readCapabilities(free))
    const r = requests.find((q) => q.id === 'music')!
    expect(r.options.map((o) => o.id)).toEqual(['builtin:procedural', 'none'])
    expect(r.context).toMatch(/no AI music is available/)
    expect(r.context).toMatch(/AI is off|free engine only/)
    expect(r.autopick).toBe('builtin:procedural')
    expect(assignment.music).toBe('builtin:procedural')
  })
  it('instrumental request with the built-in engine needs no question', () => {
    const p = plan({ music: { ...MUSIC, vocals: 'none', genre: undefined, instruments: [], exclude: [], description: 'calm' } })
    expect(decisionsFor(p, readCapabilities(planSrc('builtin:procedural'))).requests).toEqual([])
  })
  it('no music wanted: assigned none', () => {
    const { requests, assignment } = decisionsFor(plan({ music: { ...MUSIC, none: true } }), readCapabilities(planSrc('builtin:procedural')))
    expect(requests).toEqual([])
    expect(assignment.music).toBe('none')
  })
})

describe('decisionsFor: unplaced, clips, answers', () => {
  it('unplaced items get a go-on / stop request', () => {
    const { requests } = decisionsFor(plan({ unplaced: ['make it pop'] }), readCapabilities(planSrc('gemini:lyria-3.5')))
    const r = requests.find((q) => q.id === 'unplaced')!
    expect(r.options.map((o) => o.id)).toEqual(['go-on', 'stop'])
    expect(r.context).toContain('make it pop')
    expect(applyAnswers(requests, [{ id: 'unplaced', option: 'stop', auto: false }], {}).stop).toBe(true)
  })
  const clipPlan = plan({ segments: [{ id: 's1', kind: 'ai-clip', said: 'a clip', required: true, subject: 'a stressed researcher', purpose: 'problem', style: null }] })
  it('required AI clip with stock in Settings: asks, autopicks the AI model on a plan', () => {
    const { requests, assignment } = decisionsFor(clipPlan, readCapabilities(planSrc('gemini:lyria-3.5')))
    const r = requests.find((q) => q.id === 'video')!
    expect(r.autopick).toMatch(/^gemini:gemini-omni/)
    expect(r.options.at(-1)!.id).toBe('none')
    expect(assignment.video).toBe(r.autopick)
  })
  it('clips with no AI on the account: drawn scenes or leave out', () => {
    const r = decisionsFor(clipPlan, readCapabilities(free)).requests.find((q) => q.id === 'video')!
    expect(r.options.map((o) => o.id)).toEqual(['none', 'skip'])
  })
  it('autopilot takes autopick; applyAnswers writes it to the assignment', () => {
    const d = decisionsFor(plan({ unplaced: ['x'] }), readCapabilities(ownKeys({ elevenlabs: true })))
    const answers = autopilotAnswers(d.requests)
    expect(answers.every((a) => a.auto)).toBe(true)
    const done = applyAnswers(d.requests, answers, d.assignment)
    expect(done.assignment.music).toBe('elevenlabs:music_v2_5')
    expect(done.stop).toBe(false)
    expect(done.notes.length).toBe(d.requests.length)
  })
  it('an answer naming an option that was not offered falls back to autopick', () => {
    const d = decisionsFor(plan(), readCapabilities(planSrc('builtin:procedural')))
    expect(applyAnswers(d.requests, [{ id: 'music', option: 'elevenlabs:music_v2_5', auto: false }], d.assignment).assignment.music).toBe('gemini:lyria-3.5')
  })
  it('needsOf lists music with the ask in the person\'s words', () => {
    const n = needsOf(plan()).find((x) => x.job === 'music')!
    expect(n.asks).toMatch(/duff/)
  })
})

describe('musicPrompt', () => {
  it('keeps vocals, duff, Arabic and the exclusion', () => {
    const p = musicPrompt(MUSIC, 60, true)
    expect(p).toMatch(/with vocals/)
    expect(p).toMatch(/WORDLESS/)
    expect(p).toMatch(/duff/)
    expect(p).toMatch(/arabic/i)
    expect(p).toMatch(/No song structure/)
    expect(p).not.toMatch(/no vocals/i)
    expect(p).toMatch(/narrator/)
  })
  it('instrumental when no vocals; empty when none', () => {
    expect(musicPrompt({ ...MUSIC, vocals: 'none' }, 30, false)).toMatch(/no vocals, no lyrics/)
    expect(musicPrompt({ ...MUSIC, none: true }, 30, false)).toBe('')
  })
  it('natural sounds and quiet are kept', () => {
    const p = musicPrompt({ ...MUSIC, vocals: 'none', ambience: ['rain'], quiet: true, exclude: [], genre: undefined, instruments: [] }, 45, false)
    expect(p).toMatch(/rain/)
    expect(p).toMatch(/soft and low/)
  })
})
