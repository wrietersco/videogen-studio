import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '../src/main/providers/types'
import { stockFacts, readFacts, brandOf } from '../src/main/marketing/profile'
import { generateCards, stockCards } from '../src/main/marketing/cards'
import type { SiteRead } from '../src/main/marketing/crawl'
import { cardPatchOf, type BusinessProfile } from '../src/shared/marketing'

/** the profile and the video ideas: what the writer understands, and what the rules alone can build */

function fakeChat(reply: (req: { schemaName?: string; prompt: string }) => unknown): LLMProvider {
  return { generateJSON: async (req) => reply(req) } as unknown as LLMProvider
}

const read: SiteRead = {
  home: { url: 'https://greenleaf.test/', title: 'GreenLeaf Landscapes — gardens that take care of themselves', md: '# Gardens that take care of themselves\n\nGreenLeaf Landscapes designs, builds and maintains gardens for busy families across Lisbon.\n\n## How we work\n\n- We visit your garden and listen\n\nA paragraph that is long enough to be the about text of the business, describing garden design and care across Lisbon in everyday words.' },
  pages: [
    { url: 'https://greenleaf.test/garden-design', title: 'Garden design — GreenLeaf Landscapes', md: '# Garden design\n\nWe measure your garden and watch where the sun falls.\n\n## What you get\n\n- A planting plan matched to your soil\n- A shopping list of plants with sizes\n- One revision round included' },
    { url: 'https://greenleaf.test/garden-care', title: 'Garden care plans — GreenLeaf Landscapes', md: '# Garden care plans\n\nA trained gardener visits every month: watering, pruning, seasonal colour.\n\n## What is covered\n\n- Monthly visit by the same gardener\n- Watering and irrigation checks' }
  ],
  brand: { colors: ['#1a5c1a', '#f4f1ea'], accent: '35c48b', look: { backdrop: ['#22325a', '#0a0f1e'], accent: '35c48b' }, notes: [] },
  taglineCandidates: ['Garden design and care for busy families in Lisbon.'],
  notes: []
}

const profileOf = (facts: { name: string; tagline: string; about: string; services: BusinessProfile['services'] }): BusinessProfile => ({
  id: 'biz-abcdef12', domain: 'greenleaf.test', cards: [], siteMd: 'site.md', notes: [], createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z',
  brand: { colors: read.brand.colors, accent: read.brand.accent, backdrop: read.brand.look?.backdrop, logoFile: undefined },
  ...facts
})

describe('the profile the rules build alone', () => {
  it('takes the name from the title, the tagline from the meta text, and one service per page', () => {
    const f = stockFacts(read)
    expect(f.name).toBe('GreenLeaf Landscapes')
    expect(f.tagline).toMatch(/Garden design and care/)
    expect(f.about.length).toBeGreaterThan(20)
    expect(f.services.map((s) => s.name)).toEqual(['Garden design', 'Garden care plans'])
    expect(f.services[0].benefits).toHaveLength(3)
    expect(f.services[0].url).toBe('https://greenleaf.test/garden-design')
  })

  it('the site look becomes the films\' brand', () => {
    const b = brandOf(read)
    expect(b.colors).toContain('#1a5c1a')
    expect(b.accent).toBe('35c48b')
    expect(b.backdrop).toEqual(['#22325a', '#0a0f1e'])
  })
})

describe('the writer\'s reading of the site', () => {
  it('becomes the profile, with every service page url it names', async () => {
    const chat = fakeChat((req) => {
      expect(req.schemaName).toBe('business_profile')
      return {
        name: 'GreenLeaf Landscapes',
        tagline: 'Gardens that take care of themselves',
        about: 'Garden design and monthly care for busy families in Lisbon, from one team.',
        services: [
          { name: 'Garden design', url: 'https://greenleaf.test/garden-design', summary: 'A planting plan matched to your garden.', benefits: ['A plan you can read at a glance', 'One revision included'] },
          { name: 'Garden care', url: 'made-up://nowhere', summary: 'Monthly visits that keep it healthy.', benefits: ['Same gardener every month'] }
        ]
      }
    })
    const f = await readFacts(read, { chat, say: () => undefined })
    expect(f.name).toBe('GreenLeaf Landscapes')
    expect(f.services).toHaveLength(2)
    // an address the site does not have falls back to a real page, never an invented one
    expect(f.services[1].url).not.toMatch(/nowhere/)
    expect(f.services.every((s) => s.url.startsWith('https://greenleaf.test/'))).toBe(true)
  })

  it('a failed reading is the rules\' profile, not a failure', async () => {
    const chat = fakeChat(() => {
      throw new Error('model down')
    })
    const f = await readFacts(read, { chat, say: () => undefined })
    expect(f.name).toBe('GreenLeaf Landscapes')
    expect(f.services).toHaveLength(2)
  })
})

describe('the problem–solution cards', () => {
  const profile = profileOf(stockFacts(read))

  it('the stock cards cover every service and never name the business in the problem', () => {
    const cards = stockCards(profile, 5, () => 'card-00000001')
    expect(cards.length).toBeGreaterThanOrEqual(2)
    for (const c of cards) expect(c.problem).not.toContain('GreenLeaf')
    expect(cards.some((c) => c.cta)).toBe(true)
  })

  it('the writer\'s cards keep their trouble honest: a problem that names the business is rewritten', async () => {
    const chat = fakeChat((req) => {
      expect(req.schemaName).toBe('video_cards')
      return {
        cards: [
          { title: 'The garden that got away', problem: 'Weekends disappear into watering and pruning, and the garden still looks tired.', solution: 'GreenLeaf keeps it healthy with one monthly visit.', cta: 'Book a free visit', service: 1 },
          { title: 'Why GreenLeaf is best', problem: 'GreenLeaf Landscapes is the best garden company in Lisbon, call today.', solution: 'We are great.', cta: 'Call now' },
          { title: '', problem: '', solution: '', cta: '' }
        ]
      }
    })
    const cards = await generateCards(profile, { chat, count: 3, idOf: () => `card-${Math.random().toString(16).slice(2, 8)}`, say: () => undefined })
    expect(cards.length).toBe(2)
    expect(cards[0].problem).toMatch(/watering and pruning/)
    expect(cards[0].serviceIdx).toBe(1)
    // the ad-like card got a plain trouble instead: it no longer sells inside the problem
    expect(cards[1].problem).not.toMatch(/GreenLeaf|best garden company/)
  })

  it('without a writer, the services become the starting points', async () => {
    const cards = await generateCards(profile, { chat: null, count: 5, idOf: () => 'card-00000002', say: () => undefined })
    expect(cards.length).toBeGreaterThanOrEqual(2)
    expect(cards.every((c) => c.problem && c.solution && c.cta)).toBe(true)
  })

  it('a card only keeps what a card may hold', () => {
    const p = cardPatchOf({ title: '  Padded  title ', problem: 'x'.repeat(900), cta: 'Book a call', targetSec: 999, serviceIdx: -1, other: 'dropped' })
    expect(p.title).toBe('Padded title')
    expect(p.problem).toHaveLength(400)
    expect(p.cta).toBe('Book a call')
    expect(p.targetSec).toBeUndefined()
    expect(p.serviceIdx).toBeUndefined()
    expect((p as Record<string, unknown>).other).toBeUndefined()
  })
})
