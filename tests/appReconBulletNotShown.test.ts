import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { BULLET } from '../src/main/appRecon/stepScript'
import { unitsOf } from '../src/main/appRecon/agent/brief'
import { isDurationSentence, isStyleSentence } from '../src/main/appRecon/aiMedia'
import { beatFacts, beatPrompt, isNotShown, narrate, NOT_SHOWN_RULE, type NarrateInput } from '../src/main/appRecon/narrate'
import type { LLMProvider } from '../src/main/providers/types'

describe('one step-line pattern everywhere (">>6." is a list line)', () => {
  const LINES = ['>>6. hover over a line to see its tooltip', '6) click the infographic video button', 'step 6: scroll down to the circle', '- open the Verse tab']

  it('the brief reader keeps each such line whole, never split into sentences', () => {
    for (const l of LINES) expect(unitsOf(`${l}. Then wait.`)).toEqual([`${l}. Then wait.`])
    expect(unitsOf('>>6. scroll down to the circle. Then click the blue line.\nA plain sentence. Another one.')).toEqual([
      '>>6. scroll down to the circle. Then click the blue line.',
      'A plain sentence.',
      'Another one.'
    ])
  })

  it('a step line is never mistaken for a request for footage or a duration', () => {
    expect(isStyleSentence('>>6. click the infographic video button')).toBe(false)
    expect(isStyleSentence('step 6: click the infographic video button')).toBe(false)
    expect(isDurationSentence('>>7. click the problem for 20 seconds')).toBe(false)
    expect(isStyleSentence('Make it an infographic style video')).toBe(true)
  })

  it('the pattern is the one stepScript exports', () => {
    for (const l of LINES) expect(BULLET.test(l)).toBe(true)
    expect(BULLET.test('Overall structure')).toBe(false)
  })
})

describe('a fact that was NOT SHOWN is never narrated as done', () => {
  const facts = [
    'The person\'s own instruction for this step: "click the orange line"',
    'NOT SHOWN: click the orange line could not be done on the page (no such mark). Do not say or imply that it was done; describe only what is on screen.',
    'Clicks "Verse"'
  ]

  it('is recognised and turned into an explicit prohibition for the writer', () => {
    expect(isNotShown(facts[1])).toBe(true)
    expect(isNotShown(facts[0])).toBe(false)
    const out = beatFacts(facts)
    expect(out[0]).toBe(facts[0])
    expect(out[2]).toBe(facts[2])
    expect(out[1]).toMatch(/^DID NOT HAPPEN \(never narrate this as done\): click the orange line could not be done/)
    expect(out[1]).not.toMatch(/NOT SHOWN/)
    expect(beatPrompt({ beat: 3, long: true, facts })).toContain('Beat 3 (EXPLAIN):')
  })

  it('reaches the model: the rule is in the system or prompt text and the fact is marked', async () => {
    let seen = ''
    const chat = {
      generateJSON: async (req: { system?: string; prompt: string }) => {
        seen = `${req.system ?? ''}\n${req.prompt}`
        return { lines: [{ beat: 1, chapter: 'Chart', text: 'Here is what the chart shows on screen.' }] }
      }
    } as unknown as LLMProvider
    const inp = {
      chat,
      speech: null,
      mode: 'walkthrough',
      context: 'click the orange line',
      secrets: [], dir: tmpdir(), say: () => {},
      beats: [{ beat: 1, kind: 'step', chapter: 'Chart', facts, fallback: 'Take a look at what is on screen here.' }]
    } as unknown as NarrateInput
    const n = await narrate(inp)
    expect(seen).toContain(NOT_SHOWN_RULE)
    expect(seen).toContain('DID NOT HAPPEN (never narrate this as done): click the orange line')
    expect(seen).not.toContain('NOT SHOWN:')
    expect(n.lines[0].text).toBe('Here is what the chart shows on screen.')
  })

  it('no beat marked NOT SHOWN, no extra rule', async () => {
    let seen = ''
    const chat = {
      generateJSON: async (req: { system?: string; prompt: string }) => {
        seen = `${req.system ?? ''}\n${req.prompt}`
        return { lines: [{ beat: 1, chapter: 'Chart', text: 'Here is the chart on screen today.' }] }
      }
    } as unknown as LLMProvider
    await narrate({ chat, speech: null, mode: 'walkthrough', context: '', secrets: [], dir: tmpdir(), say: () => {}, beats: [{ beat: 1, kind: 'step', chapter: 'Chart', facts: ['Clicks "Verse"'], fallback: 'Take a look.' }] } as unknown as NarrateInput)
    expect(seen).not.toContain('DID NOT HAPPEN')
  })
})
