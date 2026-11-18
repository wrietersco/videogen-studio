import { describe, expect, it } from 'vitest'
import { planFromCard, readMarketBrief, readMarketBriefByRules, normaliseMarketPlan, toFilmPlan, withUnplaced } from '../src/main/marketing/agent/brief'
import { cleanBrief, cardPatchOf } from '../src/shared/marketing'
import type { MarketBriefInput } from '../src/shared/marketBrief'
import type { LLMProvider } from '../src/main/providers/types'

const input = (brief: string): MarketBriefInput => ({
  brief,
  business: {
    name: 'Pipe Heroes',
    tagline: 'Leaks fixed fast',
    about: 'Emergency plumbing for homes in Lisbon.',
    services: [
      { name: 'Emergency repairs', summary: 'A plumber at your door within the hour.', benefits: ['Arrives within the hour', 'Fixed price quoted first'] },
      { name: 'Boiler care', summary: 'Yearly boiler checks.', benefits: ['A full safety check'] }
    ]
  },
  card: { title: 'The midnight leak', problem: 'A pipe bursts at night and every call goes to voicemail.', solution: 'Pipe Heroes sends a plumber within the hour. The price is agreed before the work starts.', cta: 'Call us now', serviceIdx: 0, targetSec: 30 }
})

const BRIEF = [
  'Open with an AI video of a leaking pipe at night.',
  'Say we answer calls within the hour.',
  'Do not mention prices.',
  'Warm Arabic voice.',
  'Calm music with oud and no lyrics.',
  'About 20 seconds for Reels.',
  'End with Book a free visit.'
].join(' ')

describe('the card alone is a plan', () => {
  it('has the problem, the solution as points, and the card call to action', () => {
    const plan = planFromCard(input(''))
    expect(plan.source).toBe('card')
    expect(plan.problem.say).toMatch(/pipe bursts/)
    expect(plan.problem.show).toBe('scene')
    expect(plan.points.length).toBeGreaterThanOrEqual(2)
    expect(plan.points.every((p) => p.said === '' && p.show === 'any')).toBe(true)
    expect(plan.close.cta).toBe('Call us now')
    expect(plan.targetSec).toBe(30)
    expect(plan.music.vocals).toBe('none')
    expect(plan.unplaced).toEqual([])
  })
  it('a blank brief never calls the writer', async () => {
    const chat = { generateJSON: async () => { throw new Error('should not be called') } } as unknown as LLMProvider
    const plan = await readMarketBrief(input('   '), { chat })
    expect(plan.source).toBe('card')
  })
})

describe('a brief read by rules (no AI)', () => {
  const plan = readMarketBriefByRules(input(BRIEF))
  it('opens with the AI clip the person asked for, keeping the picture they described', () => {
    expect(plan.problem.show).toBe('clip')
    expect(plan.problem.visual).toMatch(/leaking pipe/i)
    expect(plan.problem.said).toMatch(/^Open with/)
  })
  it('keeps what must be said as a required point and what must not as an avoid list', () => {
    expect(plan.points.some((p) => /answer calls within the hour/i.test(p.say) && p.required && p.said)).toBe(true)
    expect(plan.avoid).toContain('prices')
    expect(plan.points.some((p) => /prices/i.test(p.say))).toBe(false)
  })
  it('reads the voice, the music, the length, where it is posted and how it ends', () => {
    expect(plan.voice.language).toBe('Arabic')
    expect(plan.voice.tone).toMatch(/warm/i)
    expect(plan.music.instruments).toContain('oud')
    expect(plan.music.vocals).toBe('none')
    expect(plan.targetSec).toBe(20)
    expect(plan.platform).toBe('instagram-reels')
    expect(plan.close.cta).toBe('Book a free visit')
  })
  it('puts the plan in the shape the model-choice step reads: one AI clip needed', () => {
    const film = toFilmPlan(plan, 'Pipe Heroes')
    expect(film.segments.filter((s) => s.kind === 'ai-clip')).toHaveLength(1)
    expect(film.music.instruments).toContain('oud')
  })
  it('loses nothing silently', () => {
    expect(withUnplaced(BRIEF, plan, 'Pipe Heroes').unplaced).toEqual([])
  })
})

describe('vocals and styles are the person own call', () => {
  it('Arabic music with vocals allows vocals and names the style', () => {
    const plan = readMarketBriefByRules(input('Use Arabic music with vocals and duff only.'))
    expect(plan.music.genre).toBe('arabic')
    expect(plan.music.vocals).not.toBe('none')
    expect(plan.music.instruments).toContain('duff')
  })
  it('no music is honoured', () => {
    expect(readMarketBriefByRules(input('No music please.')).music.none).toBe(true)
  })
})

describe('the AI reading', () => {
  const raw = {
    goal: 'A calm night-time rescue film',
    problem: { say: 'A pipe bursts at night', said: 'Open with a leaking pipe', show: 'clip', visual: 'a leaking pipe at night' },
    points: [
      { say: 'We answer calls within the hour', said: 'Say we answer calls within the hour', show: 'any', required: true },
      { say: 'The price is agreed first', said: '', show: 'image', required: false, visual: 'a handshake over a quote' }
    ],
    close: { cta: 'Call us now', say: 'Pipe Heroes. Call us now.' },
    avoid: ['competitors'],
    music: { vocals: 'wordless', genre: 'arabic', description: 'Arabic vocals and duff', instruments: ['duff'] },
    voice: { language: 'Arabic' },
    look: { style: 'infographic', noAbstract: true },
    targetSec: 200,
    platform: 'tiktok',
    unplaced: ['Make the logo spin']
  }
  it('is validated and clamped', () => {
    const plan = normaliseMarketPlan(raw, input('x'))!
    expect(plan.source).toBe('ai')
    expect(plan.points).toHaveLength(2)
    expect(plan.points[1].show).toBe('image')
    expect(plan.targetSec).toBe(90)
    expect(plan.platform).toBe('tiktok')
    expect(plan.look.style).toBe('infographic')
    expect(plan.music.vocals).toBe('wordless')
  })
  it('an unusable answer falls back to the rules', async () => {
    const chat = { generateJSON: async () => ({ nonsense: true }) } as unknown as LLMProvider
    const plan = await readMarketBrief(input(BRIEF), { chat })
    expect(plan.source).toBe('rules')
    expect(plan.voice.language).toBe('Arabic')
  })
  it('keeps what the writer could not place, but only what the person really wrote', async () => {
    const chat = { generateJSON: async () => raw } as unknown as LLMProvider
    const typed = 'Open with a leaking pipe. Say we answer calls within the hour. Make the logo spin.'
    const plan = await readMarketBrief(input(typed), { chat })
    expect(plan.unplaced).toContain('Make the logo spin')
    const invented = await readMarketBrief(input('Open with a leaking pipe. Say we answer calls within the hour.'), { chat })
    expect(invented.unplaced).not.toContain('Make the logo spin')
  })
})

describe('the brief on a card', () => {
  it('keeps line breaks, drops stray spaces and is capped', () => {
    expect(cleanBrief('  one  two \r\n\r\n\r\n\r\n three\t ')).toBe('one two\n\nthree')
    expect(cardPatchOf({ brief: 'x'.repeat(5000) }).brief).toHaveLength(2000)
    expect(cardPatchOf({ brief: '' }).brief).toBe('')
  })
})
