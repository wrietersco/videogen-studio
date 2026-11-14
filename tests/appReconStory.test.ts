import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { colourName, planMedia } from '../src/main/appRecon/aiMedia'
import { narrate, problemTitleOk, type NarrateInput } from '../src/main/appRecon/narrate'

const beats = [
  { beat: 0, kind: 'open', chapter: 'Landing', facts: ['the home page opens'], fallback: 'We open the app.' },
  { beat: 1, kind: 'act', chapter: 'The graph', facts: ['a graph of linked topics is shown'], fallback: 'The graph appears.' }
] as never

const launch = { feature: "Taaweel's Ontology feature", tagline: 'Visually understand Quran', closing: 'Available now', cta: 'Try it today', targetSec: 40 }

function fake(reply: unknown) {
  const prompts: string[] = []
  const chat = {
    generateJSON: async (req: { prompt: string }) => {
      prompts.push(req.prompt)
      return reply
    }
  }
  return { chat: chat as never, prompts }
}

const story = {
  clipStart: 'A quiet field of light slowly gathers, and something begins to form.',
  intro: "Introducing Taaweel's ontology feature. Visually understand Quran.",
  problemTitle: 'Lost Between Topics',
  problemLine: 'Following one idea across many pages means jumping between tabs and losing the thread. Nothing shows how it all fits together.',
  lines: [
    { beat: 0, chapter: 'Landing', text: 'Here is how it comes together, starting from the home page.' },
    { beat: 1, chapter: 'The graph', text: 'Linked topics appear as one graph you can explore at a glance.' }
  ],
  clipEnd: 'Everything you saw now rests in one clear picture.',
  outro: "Taaweel's ontology feature. Try it today."
}

const base = (over: Partial<NarrateInput>): NarrateInput => ({
  chat: null,
  speech: null,
  beats,
  mode: 'launch',
  launch,
  context: 'show the ontology graph',
  secrets: [],
  dir: mkdtempSync(join(tmpdir(), 'story-')),
  say: () => undefined,
  ...over
})

describe('one story', () => {
  it('writes the whole film in a single call and returns the clip lines', async () => {
    const f = fake(story)
    const n = await narrate(base({ chat: f.chat, problem: true, clips: ['start', 'end'] }))
    expect(f.prompts).toHaveLength(1)
    expect(n.clipLines).toEqual({ start: story.clipStart, end: story.clipEnd })
    expect(n.problem?.headline).toBe('Lost Between Topics')
    expect(n.lines[0].text).toBe(story.lines[0].text)
    expect(n.introText).toBe(story.intro)
    expect(f.prompts[0]).toContain('ONE story')
  })

  it('replaces a problem title that is just the feature name', async () => {
    const f = fake({ ...story, problemTitle: 'Quran Ontology Graph' })
    const n = await narrate(base({ chat: f.chat, problem: true }))
    expect(n.problem?.headline).not.toBe('Quran Ontology Graph')
    expect(n.problem!.headline.length).toBeLessThanOrEqual(26)
  })

  it('replaces a problem line that names the feature', async () => {
    const f = fake({ ...story, problemLine: "Meet Taaweel's ontology, which shows every link between topics in one graph for you." })
    const n = await narrate(base({ chat: f.chat, problem: true }))
    expect(n.problem?.text).toContain('There is a better way')
  })

  it('replaces a line that contains a secret', async () => {
    const f = fake({ ...story, lines: [{ beat: 0, chapter: 'Landing', text: 'Sign in with hunter2secret to continue today.' }, story.lines[1]] })
    const n = await narrate(base({ chat: f.chat, secrets: ['hunter2secret'] }))
    expect(n.lines[0].text).toBe('We open the app.')
    expect(n.lines[1].text).toBe(story.lines[1].text)
  })

  it('works with no writer', async () => {
    const n = await narrate(base({ chat: null, problem: true, clips: ['start'] }))
    expect(n.lines.map((l) => l.text)).toEqual(['We open the app.', 'The graph appears.'])
    expect(n.clipLines).toBeUndefined()
    expect(n.problem?.headline.length).toBeLessThanOrEqual(26)
    expect(n.introText).toContain('Introducing')
  })
})

describe('problemTitleOk', () => {
  it('rejects the solution name and accepts a real problem', () => {
    expect(problemTitleOk('Quran Ontology Graph', "Taaweel's Ontology feature", 'Visually understand Quran')).toBe(false)
    expect(problemTitleOk('Lost Between Topics', "Taaweel's Ontology feature", 'Visually understand Quran')).toBe(true)
  })
  it('rejects a title with no hint of trouble or with the product name', () => {
    expect(problemTitleOk('A Better Way', 'X', 'Y')).toBe(false)
    expect(problemTitleOk('Lost Without Acme', 'Thing', 'Tag', 'Acme')).toBe(false)
  })
})

describe('planMedia', () => {
  const req = (placement: 'start' | 'end') => ({ said: 'ai video', subject: 'the film', placement, generic: true })
  const brand = { accent: '#35c48b', backdrop: ['#0b2a1f', '#12382a'] as [string, string] }

  it('names colours in words', () => {
    expect(colourName('#0b2a1f')).toContain('green')
    expect(colourName('#d4a537')).toContain('gold')
  })

  it('puts brand colours, settle sentence and motif in stock prompts and uses given lines verbatim', async () => {
    const out = await planMedia({ chat: null, requests: [req('start'), req('end')], auto: false, appName: 'x.app', topic: 'a graph', context: '', mode: 'launch', secrets: [], brand, motif: 'graph', lines: { start: 'A calm field of light gathers slowly.' }, say: () => undefined })
    const start = out.find((c) => c.placement === 'start')!
    const end = out.find((c) => c.placement === 'end')!
    expect(start.line).toBe('A calm field of light gathers slowly.')
    expect(start.prompt).toContain('#35c48b')
    expect(start.prompt).toContain('#0b2a1f')
    expect(start.prompt).toMatch(/green/)
    expect(start.prompt).toContain('ENDS by settling into a calm, dark, nearly empty field')
    expect(start.prompt).toContain('network')
    expect(end.prompt).toContain('BEGINS from a calm, dark, nearly empty field')
    expect(start.prompt).not.toContain('dark blue')
  })

  it('carries the palette through the writer and skips asking for a given line', async () => {
    const f = fake({ clips: [{ n: 1, prompt: 'Points of light gather and join into a luminous network across the frame.', line: 'writer line that should lose' }] })
    const out = await planMedia({ chat: f.chat, requests: [req('start')], auto: false, appName: 'x.app', topic: 'a graph', context: '', mode: 'launch', secrets: [], brand, lines: { start: 'Given line, used as is.' }, say: () => undefined })
    expect(out[0].line).toBe('Given line, used as is.')
    expect(out[0].prompt).toContain('#35c48b')
    expect(out[0].prompt).toContain('settling into')
    expect(f.prompts[0]).toContain('already written')
  })
})
