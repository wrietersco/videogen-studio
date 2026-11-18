import { describe, expect, it } from 'vitest'
import { MarketStopped, buildReport, planStage, reviewFilm, type MarketPariHooks } from '../src/main/marketing/agent/loop'
import { planFromCard } from '../src/main/marketing/agent/brief'
import { avoidHit, coverage, fitBeats, chooseElements } from '../src/main/marketing/film'
import type { CapabilityReport, DecisionAnswer } from '../src/shared/agentBrief'
import type { MadePart, MarketBriefInput, MarketPlan, MarketPariEvent } from '../src/shared/marketBrief'
import type { MediaTools } from '../src/main/appRecon/run'

const input = (brief: string): MarketBriefInput => ({
  brief,
  business: { name: 'Pipe Heroes', tagline: 'Leaks fixed fast', about: 'Emergency plumbing.', services: [] },
  card: { title: 'The midnight leak', problem: 'A pipe bursts at night and every call goes to voicemail.', solution: 'Pipe Heroes sends a plumber within the hour. The price is agreed before the work starts.', cta: 'Call us now', targetSec: 30 }
})

const opt = (id: string, label: string, cost: string, available = true) => ({ id, label, cost, available, strengths: [], limits: [] })
const caps: CapabilityReport = {
  access: 'plan',
  planName: 'Plus',
  limits: [],
  jobs: [
    { job: 'writer', configured: 'openai:gpt-6-luna', options: [opt('openai:gpt-6-luna', 'GPT', '≈ $0.01')] },
    { job: 'voice', configured: 'openai:tts', options: [opt('openai:tts', 'OpenAI voice', '≈ $0.02')] },
    { job: 'music', configured: 'builtin:procedural', options: [opt('builtin:procedural', 'Built-in music', 'free'), opt('gemini:lyria-3.5', 'Lyria', '≈ $0.08')] },
    { job: 'video', configured: 'stock', options: [opt('stock', 'Stock footage', 'free'), opt('gemini:veo-3.2-lite', 'Veo Lite', '≈ $0.40')] }
  ]
}

function hooks(mode: 'ask' | 'autopilot', answer?: (r: Parameters<MarketPariHooks['decide']>[0]) => DecisionAnswer[] | null) {
  const events: Array<Omit<MarketPariEvent, 'businessId' | 'runId'>> = []
  const h: MarketPariHooks = { mode, capabilities: caps, emit: (e) => events.push(e), decide: async (r) => (answer ? answer(r) : null) }
  return { h, events }
}
const deps = { chat: null, say: () => undefined, business: 'Pipe Heroes' }

describe('PLAN: the person is asked, or autopilot decides', () => {
  const BRIEF = 'Open with an AI video of a leaking pipe at night. Use Arabic music with vocals and duff only.'
  it('autopilot takes the best option, says so, and never asks', async () => {
    const { h, events } = hooks('autopilot', () => { throw new Error('must not ask') })
    const out = await planStage(input(BRIEF), deps, h)
    expect(out.assignment.music).toBe('gemini:lyria-3.5')
    expect(out.assignment.video).toBe('gemini:veo-3.2-lite')
    const decide = events.find((e) => e.kind === 'pari-decide') as Extract<MarketPariEvent, { kind: 'pari-decide' }>
    expect(decide.auto).toBe(true)
    expect(decide.requests.map((r) => r.id).sort()).toEqual(['music', 'video'])
    expect(events[0].kind).toBe('pari-plan')
  })
  it('in ask mode the answers decide, and a stop stops everything', async () => {
    const { h } = hooks('ask', (reqs) => reqs.map((r) => ({ id: r.id, option: r.id === 'music' ? 'builtin:procedural' : 'none', auto: false })))
    const out = await planStage(input(BRIEF), deps, h)
    expect(out.assignment.music).toBe('builtin:procedural')
    expect(out.assignment.video).toBe('none')
    await expect(planStage(input(BRIEF), deps, hooks('ask', () => null).h)).rejects.toBeInstanceOf(MarketStopped)
  })
  it('a card with no brief asks nothing', async () => {
    const { h, events } = hooks('ask', () => { throw new Error('must not ask') })
    const out = await planStage(input(''), deps, h)
    expect(out.plan.source).toBe('card')
    expect(events.some((e) => e.kind === 'pari-decide')).toBe(false)
  })
})

describe('the film helpers', () => {
  it('coverage and avoid', () => {
    expect(coverage('we answer calls within the hour', 'Calls are answered within the hour, day or night.')).toBeGreaterThanOrEqual(0.5)
    expect(coverage('free consultation', 'Book a visit.')).toBe(0)
    expect(avoidHit('Prices start low', ['prices'])).toBe('prices')
    expect(avoidHit('A fair deal', ['prices'])).toBeUndefined()
  })
  it('fitBeats drops nice-to-have points, last first, never a required one', () => {
    const plan: MarketPlan = { ...planFromCard(input('')), points: ['one', 'two', 'three', 'four', 'five'].map((w, i) => ({ id: `p${i + 1}`, say: `${w} ${'word '.repeat(18)}`, said: '', show: 'any' as const, required: i === 0 })) }
    const script = { problemHeadline: 'x', problemLine: 'a '.repeat(25), beats: plan.points.map((p) => ({ headline: 'h', line: p.say, chapter: 'c', pointId: p.id })), close: 'Pipe Heroes. Call us now.' }
    const r = fitBeats(script, plan, 20)
    expect(r.dropped.length).toBeGreaterThan(0)
    expect(r.script.beats.map((b) => b.pointId)).toContain('p1')
    expect(r.script.beats.length).toBeGreaterThanOrEqual(2)
  })
  it('chooseElements gives the person clips first and says why a clip became a card', () => {
    const base = planFromCard(input(''))
    const plan: MarketPlan = { ...base, problem: { ...base.problem, show: 'clip' }, points: [{ id: 'p1', say: 'a', said: 'a', show: 'clip', required: true }, { id: 'p2', say: 'b', said: 'b', show: 'clip', required: true }, { id: 'p3', say: 'c', said: 'c', show: 'image', required: true }] }
    const beats = plan.points.map((p) => ({ headline: p.say, line: p.say, chapter: '', pointId: p.id }))
    const tools = { clip: async () => ({ file: 'x' }), still: async () => ({ file: 'y' }), music: async () => Buffer.alloc(0) } as unknown as MediaTools
    const r = chooseElements(beats, plan, { tools, maxClips: 2, noClips: false })
    expect(r.problem).toBe('clip')
    expect(r.kinds).toEqual(['clip', 'scene', 'still'])
    expect(r.why.get('p2')).toMatch(/no more AI clips/)
    const none = chooseElements(beats, plan, { tools: null, maxClips: 2, noClips: false })
    expect(none.problem).toBe('scene')
    expect(none.why.get('problem')).toMatch(/not available/)
    const off = chooseElements(beats, plan, { tools, maxClips: 2, noClips: true })
    expect(off.kinds).toEqual(['scene', 'scene', 'still'])
    expect(off.why.get('p1')).toMatch(/drawn scenes/)
  })
})

describe('REVIEW: what was asked against what was made', () => {
  const base = planFromCard(input(''))
  const plan: MarketPlan = {
    ...base,
    problem: { say: 'A pipe bursts at night', said: 'Open with a leaking pipe', show: 'clip' },
    points: [
      { id: 'p1', say: 'we answer calls within the hour', said: 'Say we answer calls within the hour', show: 'clip', required: true },
      { id: 'p2', say: 'the price is agreed first', said: '', show: 'any', required: false }
    ],
    avoid: ['competitors'],
    music: { none: false, description: 'Arabic vocals and duff', vocals: 'wordless', instruments: ['duff'], exclude: [], ambience: [], quiet: false, genre: 'arabic' },
    voice: { language: 'Arabic' },
    targetSec: 20,
    unplaced: ['Make the logo spin']
  }
  const made: MadePart[] = [
    { id: 'problem', wanted: 'clip', made: 'clip', line: 'A pipe bursts at night and nobody answers.', attempts: 1 },
    { id: 'p1', wanted: 'clip', made: 'scene', line: 'Calls are answered within the hour.', fellBack: 'your plan allows no more AI clips in one film', attempts: 1 },
    { id: 'p2', wanted: 'any', made: 'scene', line: 'The price is agreed first, then we start.', attempts: 1 },
    { id: 'close', wanted: 'close', made: 'scene', line: 'Pipe Heroes. Call us now.', attempts: 1 }
  ]
  const rv = reviewFilm(plan, { made, dropped: [], durationSec: 21, musicSource: 'builtin', voiced: true, written: true })
  const by = (id: string) => rv.checks.find((c) => c.segment === id)!
  it('marks what was made as asked, replaced, or missed', () => {
    expect(by('problem').status).toBe('done')
    expect(by('p1').status).toBe('substituted')
    expect(by('p1').note).toMatch(/no more AI clips/)
    expect(by('p2').status).toBe('done')
    expect(by('close').status).toBe('done')
    expect(by('music').status).toBe('missed')
    expect(by('music').note).toMatch(/vocals/)
    expect(by('length').status).toBe('done')
  })
  it('catches a mention the person ruled out', () => {
    const bad = reviewFilm(plan, { made: [...made.slice(0, 3), { ...made[3], line: 'Better than competitors. Call us now.' }], dropped: [], durationSec: 21, musicSource: 'ai', voiced: true, written: true })
    expect(bad.checks.find((c) => c.segment === 'avoid')!.status).toBe('missed')
  })
  it('the report lists every shortfall, including what could not be placed', () => {
    const rep = buildReport(plan, { assignment: {}, answers: [] }, rv, 21)
    expect(rep.shortfalls.join(' ')).toMatch(/Make the logo spin/)
    expect(rep.shortfalls.join(' ')).toMatch(/no more AI clips/)
    expect(rep.shortfalls.join(' ')).toMatch(/vocals/)
    const tidy: MarketPlan = { ...plan, unplaced: [], music: base.music, voice: {}, avoid: [], problem: { ...plan.problem, show: 'scene' }, points: plan.points.map((p) => ({ ...p, show: 'any' as const })) }
    const ok = buildReport(tidy, { assignment: {}, answers: [] }, reviewFilm(tidy, { made, dropped: [], durationSec: 21, musicSource: 'builtin', voiced: true, written: true }), 21)
    expect(ok.shortfalls).toEqual([])
  })
  it('a point dropped for length is reported as skipped', () => {
    const r = reviewFilm(plan, { made: made.filter((m) => m.id !== 'p2'), dropped: ['p2'], durationSec: 21, musicSource: 'ai', voiced: true, written: true })
    expect(r.checks.find((c) => c.segment === 'p2')!.status).toBe('skipped')
  })
})
