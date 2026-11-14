import { describe, expect, it } from 'vitest'
import { fixPrompt, planMedia, promptIssues, type MediaRequest } from '../src/main/appRecon/aiMedia'

const GOOD =
  'An old leather book lies open on a dark oak table. Its pages release thin glowing threads that rise through the air and tie, one by one, into a hanging constellation of brass lanterns. ' +
  'The camera slowly dollies in as the lanterns brighten under warm lamplight, and the last thread settles into stillness above the pages.'
const VAGUE = 'Abstract glowing particles flowing in a dynamic futuristic energy field of glowing lines.'

const brand = { accent: '35c48b', backdrop: ['0b2a1f', '0b2a1f'] as [string, string] }
const req = (placement: MediaRequest['placement'], subject = 'a graph of linked topics'): MediaRequest => ({ said: 'ai video', subject, placement, generic: false })

function fake(replies: unknown[]) {
  const calls: Array<{ system: string; prompt: string }> = []
  const chat = {
    generateJSON: async (r: { system: string; prompt: string }) => {
      calls.push({ system: r.system, prompt: r.prompt })
      return replies[Math.min(calls.length - 1, replies.length - 1)]
    }
  }
  return { chat: chat as never, calls }
}
const plan = (chat: never, extra: object = {}, reqs = [req('start')]) =>
  planMedia({ chat, requests: reqs, auto: false, appName: 'x.app', topic: 'a graph', context: '', mode: 'launch', secrets: [], brand, say: () => undefined, ...extra })

describe('clip storyboards', () => {
  it('asks the writer for the storyboard fields and shows it the facts and hint', async () => {
    const f = fake([{ clips: [{ n: 1, metaphor: 'm', action: 'a', camera: 'c', light: 'l', prompt: GOOD, line: 'A line that is long enough here.' }] }])
    await plan(f.chat, { facts: ['The graph page lists linked topics', 'Clicking a topic opens its details'], subjectHint: 'a knowledge graph' })
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].prompt).toContain('The graph page lists linked topics')
    expect(f.calls[0].prompt).toContain('a knowledge graph')
    for (const k of ['metaphor', 'action', 'camera', 'light']) expect(f.calls[0].system).toContain(`"${k}"`)
  })

  it('scrubs secrets from facts and trims them', async () => {
    const f = fake([{ clips: [] }])
    await plan(f.chat, { secrets: ['hunter2'], facts: ['password hunter2 field', 'x'.repeat(2000)] })
    expect(f.calls[0].prompt).not.toContain('hunter2')
    expect(f.calls[0].prompt.length).toBeLessThan(2200)
  })

  it('flags vague prompts and accepts a concrete shot', () => {
    const bad = promptIssues('abstract glowing particles flowing')
    expect(bad.length).toBeGreaterThan(0)
    expect(promptIssues(VAGUE).join(' ')).toMatch(/abstract/)
    expect(promptIssues(GOOD)).toEqual([])
    expect(promptIssues(GOOD + ' A screen showing the interface and a logo with text.').join(' ')).toMatch(/banned/)
    expect(promptIssues(GOOD + ' No text, no letters, no logos.')).toEqual([])
  })

  it('repairs a vague writer prompt with exactly one extra call', async () => {
    const f = fake([{ clips: [{ n: 1, metaphor: 'm', action: 'a', camera: 'c', light: 'l', prompt: VAGUE, line: 'A line that is long enough here.' }] }, { prompt: GOOD }])
    const out = await plan(f.chat)
    expect(f.calls).toHaveLength(2)
    expect(out[0].prompt).toContain('brass lanterns')
    expect(out[0].prompt).toContain('#35c48b')
  })

  it('falls back to the stock prompt when the repair still has banned content', async () => {
    const f = fake([{ clips: [{ n: 1, metaphor: 'm', action: 'a', camera: 'c', light: 'l', prompt: VAGUE, line: 'A line that is long enough here.' }] }, { prompt: GOOD + ' The glass shows the text of a title.' }])
    const out = await plan(f.chat)
    expect(f.calls).toHaveLength(2)
    expect(out[0].prompt).not.toContain('glass shows')
    expect(out[0].prompt).toMatch(/ENDS by settling/)
    const direct = await fixPrompt({ chat: fake([{ prompt: GOOD + ' with text on it' }]).chat, prompt: VAGUE })
    expect(direct.usedStock).toBe(true)
  })

  it('does not call the writer for a good prompt', async () => {
    const r = await fixPrompt({ chat: fake([{ prompt: 'x' }]).chat, prompt: GOOD })
    expect(r.repaired).toBe(false)
  })
})

describe('stock prompts', () => {
  for (const motif of ['graph', 'flow', 'cards'] as const) {
    for (const placement of ['start', 'middle', 'end'] as const) {
      it(`${motif}/${placement} is concrete, deterministic and brand-coloured`, async () => {
        const a = (await plan(null as never, { motif }, [req(placement)]))[0].prompt
        const b = (await plan(null as never, { motif }, [req(placement)]))[0].prompt
        expect(a).toBe(b)
        expect(promptIssues(a)).toEqual([])
        expect(a).toContain('#35c48b')
        expect(a).toContain('#0b2a1f')
      })
    }
  }

  it('keeps religious subjects free of people, and the opening ends settled into the background', async () => {
    const out = await plan(null as never, { motif: 'graph', topic: 'Taaweel ontology - visually understand Quran' }, [req('start', 'Taaweel ontology'), req('end', 'Taaweel ontology')])
    for (const c of out) {
      expect(promptIssues(c.prompt, { sacred: true })).toEqual([])
      expect(c.prompt).toMatch(/no depiction of people/i)
    }
    const s = out[0].prompt
    expect(s.trim().endsWith('Smooth, slow, continuous motion.')).toBe(true)
    expect(s).toMatch(/ENDS by settling into a calm, dark, nearly empty field of [^.]*#0b2a1f/)
  })
})
