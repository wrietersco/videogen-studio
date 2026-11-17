import { describe, expect, it } from 'vitest'
import { expandRequests, parseClipStyle, parseMediaAsk, parseMusicAsk, partSeconds, planMedia, promptIssues, withoutProductionSentences } from '../src/main/appRecon/aiMedia'
import { parseDirectives } from '../src/main/appRecon/directives'
import { keyframePrompt } from '../src/main/appRecon/run'

const BRIEF = [
  'for intro -> use AI video to illustrate motion graphics styled illustration of problem and solution. problem statement would take 20s and solution will take 20s. do not show abstract graphics. use infographic styled video.',
  'low volumed natural white noise birds and thunders as background music - halal music',
  'after intro, then show screen recording as answer',
  'steps to follow for screen recording:',
  '1. log into the app',
  '2. click "Ontology" in the left menu',
  '3. type "psychology" in the search bar'
].join('\n')

describe('an intro asked for in one run-on line', () => {
  it('reads the opening video as a problem part and a solution part, each with its length', () => {
    const a = parseMediaAsk(BRIEF)
    expect(a.declined).toBe(false)
    expect(a.requests.map((r) => [r.part, r.seconds, r.placement])).toEqual([['problem', 20, 'start'], ['solution', 20, 'start']])
    expect(partSeconds(BRIEF)).toEqual({ problem: 20, solution: 20 })
  })

  it('reads the look the person named, and the ban on abstract graphics', () => {
    expect(parseClipStyle(BRIEF)).toEqual({ style: 'infographic', noAbstract: true })
    const a = parseMediaAsk(BRIEF)
    expect(a.style).toBe('infographic')
    expect(a.noAbstract).toBe(true)
    // plain requests have no style
    expect(parseMediaAsk('Open with an AI animation of data flowing between systems.').style).toBeNull()
  })

  it('reads the quiet nature sounds, and nothing from the intro line is left to be read as a step', () => {
    const m = parseMusicAsk(BRIEF)!
    expect(m.sounds).toEqual(expect.arrayContaining(['soft, airy white noise', 'birdsong', 'distant, soft rolling thunder']))
    expect(m.noInstruments).toBe(true)
    expect(m.quiet).toBe(true)
    const rest = withoutProductionSentences(BRIEF)
    expect(rest).not.toMatch(/infographic|abstract|20s|white noise|AI video/i)
    // the numbered steps are untouched
    expect(rest).toContain('1. log into the app')
    expect(parseDirectives(rest).map((d) => d.kind)).toEqual(expect.arrayContaining(['open', 'type']))
  })

  it('a quiet wish is not set by ordinary music words', () => {
    expect(parseMusicAsk('Calm piano music please.')).toBeNull()
    expect(parseMusicAsk('Soft birdsong as background music.')!.quiet).toBe(true)
    expect(parseMusicAsk('Natural birdsong as background music.')!.quiet).toBe(false)
  })

  it('splits sentences written without capitals, but not abbreviations or addresses', () => {
    expect(parseMediaAsk('use ai video for the intro. then open example.com and go on e.g. like this.').requests).toHaveLength(1)
  })
})

describe('long parts are chained from several clips', () => {
  const ask = parseMediaAsk(BRIEF)
  it('20 seconds becomes three clips of about seven seconds, in order', () => {
    const w = expandRequests(ask.requests, 'a research app', (t) => t)
    expect(w.map((x) => [x.part, x.seconds, x.shot, x.shots])).toEqual([
      ['problem', 7, 0, 3], ['problem', 7, 1, 3], ['problem', 7, 2, 3],
      ['solution', 7, 0, 3], ['solution', 7, 1, 3], ['solution', 7, 2, 3]
    ])
  })

  it('without a writer the clips are flat infographics, never photographed scenes', async () => {
    const planned = await planMedia({ chat: null, requests: ask.requests, auto: false, appName: 'taaweel.example', topic: 'a research app', context: '', mode: 'walkthrough', secrets: [], style: ask.style, noAbstract: ask.noAbstract, say: () => undefined })
    expect(planned).toHaveLength(6)
    expect(planned.every((c) => c.seconds === 7)).toBe(true)
    for (const c of planned) {
      expect(c.prompt).toMatch(/flat 2D vector infographic/)
      expect(c.prompt).not.toMatch(/lantern|candle|photograph|cinematic/i)
      expect(promptIssues(c.prompt, { style: 'infographic' })).toEqual([])
    }
    // the problem half is about the problem, the solution half about the fix
    expect(planned[0].prompt).toMatch(/warning-triangle|tangled/)
    expect(planned[3].prompt).toMatch(/check-mark/)
    // only the last opening clip settles into the title scene
    expect(planned.filter((c) => /cross-fades cleanly into the title scene/.test(c.prompt))).toHaveLength(1)
    expect(/cross-fades cleanly/.test(planned[5].prompt)).toBe(true)
    // the opening line is spoken once per part, not over every shot
    expect(planned.map((c) => c.line.length > 0)).toEqual([true, false, false, true, false, false])
    expect(planned[0].line).toMatch(/problem/i)
    expect(planned[3].line).toMatch(/solved/i)
  })

  it('a writer is told to draw infographics and not abstract graphics', async () => {
    let system = ''
    let prompt = ''
    const chat = {
      id: 'fake',
      generateJSON: async (o: { system: string; prompt: string }) => {
        system = o.system
        prompt = o.prompt
        return { clips: ask.requests.map((_, i) => ({ n: i + 1, metaphor: 'm', action: 'a', camera: 'locked frame', light: 'flat', prompt: 'x', line: 'Plain spoken line about the idea here.' })) }
      }
    } as never
    await planMedia({ chat, requests: ask.requests.slice(0, 1), auto: false, appName: 'a', topic: 't', context: '', mode: 'walkthrough', secrets: [], style: 'infographic', noAbstract: true, say: () => undefined })
    expect(system).toMatch(/INFOGRAPHIC/)
    expect(system).toMatch(/NO abstract graphics/)
    expect(system).not.toMatch(/for example books, pages, lanterns/)
    expect(prompt).toMatch(/\[PROBLEM\]/)
    expect(prompt).toMatch(/\[about 7 seconds\]/)
  })

  it('the cinematic default is untouched when no look was asked for', async () => {
    const plain = parseMediaAsk('Open with an AI animation of data flowing between systems.')
    const planned = await planMedia({ chat: null, requests: plain.requests, auto: false, appName: 'a', topic: 't', context: '', mode: 'walkthrough', secrets: [], say: () => undefined })
    expect(planned).toHaveLength(1)
    expect(planned[0].prompt).not.toMatch(/infographic/)
    expect(planned[0].seconds).toBeUndefined()
  })

  it('the opening picture is drawn flat when an infographic was asked for', () => {
    expect(keyframePrompt('p', 'infographic')).toMatch(/flat 2D vector infographic.*not a photograph/)
    expect(keyframePrompt('p')).toBe('First frame of this shot, a still photograph: p')
  })

  it('a photographed or lettered infographic description is rejected', () => {
    const base = 'A flat 2D vector infographic animation on a clean canvas. Icons of a checklist, a gear and a shield slide in one after another and connect with arrows into one tidy flow, then a check-mark badge appears. Smooth motion, locked frame, even flat light.'
    expect(promptIssues(base, { style: 'infographic' })).toEqual([])
    expect(promptIssues(base + ' A cinematic dolly shot past candles.', { style: 'infographic' }).join(' ')).toMatch(/wrong look/)
    expect(promptIssues(base + ' The headline says Welcome in large letters.', { style: 'infographic' }).join(' ')).toMatch(/banned content/)
  })
})
