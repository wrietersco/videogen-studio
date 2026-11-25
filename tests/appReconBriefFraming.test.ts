import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '../src/main/providers/types'
import type { BriefInput, FilmPlan, NarrationSegment } from '../src/shared/agentBrief'
import { accountFor, framedWords, framingOf, musicOffIn, normaliseOutline, readBrief, readBriefByRules, voiceOffIn, withoutFramed } from '../src/main/appRecon/agent/brief'
import { reviewSegment } from '../src/main/appRecon/agent/review'
import { buildReport, narrationBrief, reviewStage } from '../src/main/appRecon/agent/loop'
import { closingLine, narrate, openingLine, type NarrateInput } from '../src/main/appRecon/narrate'

/** the brief of run-ee7a3b1da48a9c6a: an intro question under "overall structure", music "none" under its heading */
const QUESTION =
  'We have always wondered how many times each word has occurred in Quran and in what ratio to another word, and in exactly which places did the two words occur, and how they relate with each other. This one simple chart would help you.'
const BRIEF = `# overall structure
Start the intro with a question: ${QUESTION}

# background music

none

# steps

1. go to https://taaweel.snapkodex.com/numerical_analysis/compare.html
2. scroll down to Whole-Quran even–odd circle`

const input = (context: string, mode: 'walkthrough' | 'launch' = 'launch'): BriefInput => ({ context, startUrl: 'https://taaweel.snapkodex.com/', mode })
const chatReturning = (reply: unknown): LLMProvider => ({ generateJSON: async () => reply } as unknown as LLMProvider)

describe('words ordered at the start or end of the film', () => {
  it('reads "start the intro with a question: …" as the intro narration, in the person\'s words only', () => {
    const f = framingOf(`Start the intro with a question: ${QUESTION}`)
    expect(f).toMatchObject({ at: 'intro', asQuestion: true })
    expect(f?.text).toBe(QUESTION)
  })

  it('generalises: open with …, begin by asking …, end with …, finish by saying …', () => {
    expect(framingOf('Open with a question: Why is this hard?')).toMatchObject({ at: 'intro', asQuestion: true, text: 'Why is this hard?' })
    expect(framingOf('Begin by asking how many times a word occurs')).toMatchObject({ at: 'intro', asQuestion: true, text: 'how many times a word occurs' })
    expect(framingOf('Then start the video with the line: This changes how you read.')).toMatchObject({ at: 'intro', asQuestion: false, text: 'This changes how you read.' })
    expect(framingOf('End with a call to action: try it today at example.com')).toMatchObject({ at: 'outro', text: 'try it today at example.com' })
    expect(framingOf('Finish by saying: Thank you for watching.')).toMatchObject({ at: 'outro', text: 'Thank you for watching.' })
  })

  it('leaves instructions that are not words to say alone', () => {
    expect(framingOf('End with a short conclusion.')).toBeNull()
    expect(framingOf('Open the app with the login page: https://x.test/login')).toBeNull()
    expect(framingOf('Start with the logo on screen: a green leaf')).toBeNull()
    expect(framingOf('Show the dashboard')).toBeNull()
  })

  it('the rules reader keeps the question and the sentence after it as the intro narration', () => {
    const plan = readBriefByRules(input(BRIEF))
    const n = plan.segments.find((s): s is NarrationSegment => s.kind === 'narration')
    expect(n).toMatchObject({ at: 'intro', asQuestion: true })
    expect(n?.claims.join(' ')).toMatch(/^We have always wondered .* each other\. This one simple chart would help you$/)
    expect(framedWords(plan).intro).toEqual({ text: QUESTION, asQuestion: true })
    expect(withoutFramed(plan).segments.some((s) => s.kind === 'narration')).toBe(false)
  })

  it('the AI reader\'s narration is placed the same way, whether or not it copied the instruction into its claims', async () => {
    const raw = {
      segments: [
        { kind: 'narration', said: `Start the intro with a question: ${QUESTION}`, claims: [QUESTION] },
        { kind: 'narration', said: 'End with a thank you: Thanks for watching, see you next time.', claims: ['End with a thank you: Thanks for watching, see you next time.'] }
      ],
      music: { none: true }
    }
    const plan = await readBrief(input(BRIEF), { chat: chatReturning(raw), secrets: [] })
    const [a, b] = plan.segments as NarrationSegment[]
    expect(a).toMatchObject({ at: 'intro', asQuestion: true, claims: [QUESTION] })
    expect(b).toMatchObject({ at: 'outro', claims: ['Thanks for watching, see you next time.'] })
  })
})

describe('"none" under a known heading is understood', () => {
  it('"# background music" with "none" under it (blank line between) turns music off', () => {
    expect(normaliseOutline('# background music\n\nnone')).toBe('background music: none')
    expect(musicOffIn('# background music\n\nnone')).toBe(true)
    expect(readBriefByRules(input(BRIEF)).music.none).toBe(true)
    expect(voiceOffIn('# voiceover\n\nnone')).toBe(true)
    expect(voiceOffIn('# voiceover\nA calm voice')).toBe(false)
  })

  it('a described music line under the heading is read as music, not left unplaced', () => {
    const typed = '# background music\n\nsoft piano, no vocals'
    const plan = readBriefByRules(input(typed))
    expect(plan.music.none).toBe(false)
    expect(plan.music.instruments).toContain('piano')
    expect(accountFor(typed, plan).unplaced).toEqual([])
  })

  it('the rules path lists nothing as unplaced for the run\'s brief', () => {
    const typed = BRIEF
    expect(accountFor(typed, readBriefByRules(input(typed))).unplaced).toEqual([])
  })

  it('the AI reader that returns "none" as unplaced is overruled: no unplaced report, so no "go on without it?" question', async () => {
    const raw = {
      segments: [
        { kind: 'narration', said: `Start the intro with a question: ${QUESTION}`, claims: [QUESTION] },
        { kind: 'page', said: '1. go to https://taaweel.snapkodex.com/numerical_analysis/compare.html\n2. scroll down to Whole-Quran even–odd circle', url: 'https://taaweel.snapkodex.com/numerical_analysis/compare.html', how: 'script', actions: ['go to https://taaweel.snapkodex.com/numerical_analysis/compare.html', 'scroll down to Whole-Quran even–odd circle'] }
      ],
      music: { none: true },
      unplaced: ['none']
    }
    const plan = await readBrief(input(BRIEF), { chat: chatReturning(raw), secrets: [] })
    expect(plan.music.none).toBe(true)
    expect(plan.unplaced).toEqual([])
  })

  it('a "none" that answers nothing is still reported', () => {
    const typed = 'Show the dashboard.\nnone'
    expect(accountFor(typed, readBriefByRules(input(typed))).unplaced).toEqual(['none'])
  })

  it('"none" under a music heading is NOT accepted when music was not turned off', () => {
    const typed = '# background music\n\nnone'
    const plan = readBriefByRules(input(typed))
    plan.music.none = false
    expect(accountFor(typed, plan).unplaced).toEqual(['none'])
  })
})

describe('the title line carries the ordered opening', () => {
  const beats = [
    { beat: 0, kind: 'login', chapter: 'Account Sign In', facts: ['the sign-in page'], fallback: 'We sign in to begin.' },
    { beat: 1, kind: 'act', chapter: 'Chart', facts: ['the chart is shown'], fallback: 'The chart appears.' }
  ] as never
  const launch = { feature: "Taaweel's Mizan Tool", tagline: 'Mathematically Compare words in Quran', closing: 'Available now', cta: 'Try it today', targetSec: 60 }
  const base = (over: Partial<NarrateInput>): NarrateInput => ({
    chat: null, speech: null, beats, mode: 'launch', launch, context: 'show the chart', secrets: [],
    dir: mkdtempSync(join(tmpdir(), 'framing-')), say: () => undefined, ...over
  })
  const opening = { text: QUESTION, asQuestion: true }
  const polished = 'Have you ever wondered how many times each word has occurred in the Quran, and in what ratio to another word, and in exactly which places, and how they relate? This one simple chart would help you.'

  it('polishes the question without losing a point, and does it without any model', () => {
    const line = openingLine(QUESTION, true)
    expect(line).toMatch(/^Have you ever wondered how many times each word has occurred in the Quran and in what ratio to another word/)
    expect(line).toMatch(/how they relate with each other\? This one simple chart would help you\.$/)
    expect(openingLine('How often does a word occur?', true)).toBe('How often does a word occur?')
    expect(openingLine('Words are counted here.', true)).toBe('Words are counted here.')
    expect(closingLine("Taaweel's Mizan Tool", 'Try it today.')).toBe("Taaweel's Mizan Tool. Try it today.")
  })

  it('no writer: the title line is the question, and "introducing" is not what opens the film', async () => {
    const n = await narrate(base({ opening }))
    expect(n.introText).toBe(openingLine(QUESTION, true))
    expect(n.intro?.text).toBe(n.introText)
    expect(n.introText).not.toMatch(/^Introducing/)
  })

  it('the writer is told the order, and its polished question is kept', async () => {
    const prompts: string[] = []
    const chat = { generateJSON: async (r: { prompt: string }) => { prompts.push(r.prompt); return { intro: polished, outro: "Taaweel's Mizan Tool. Try it today.", lines: [{ beat: 0, chapter: 'Sign in', text: 'First we sign in.' }, { beat: 1, chapter: 'The chart', text: 'The chart appears.' }] } } } as unknown as LLMProvider
    const n = await narrate(base({ chat, opening }))
    expect(n.introText).toBe(polished)
    expect(prompts[0]).toMatch(/ordered how the film OPENS/)
    expect(prompts[0]).toContain('how many times each word has occurred')
    expect(n.lines[0].text).toBe('First we sign in.')
  })

  it('a writer that ignores the order (the old "Introducing …" line) is overruled by the person\'s own words', async () => {
    const chat = chatReturning({ intro: "Introducing Taaweel's mizan tool, designed to mathematically compare words across the entire Quran.", outro: 'Explore it now.', lines: [{ beat: 0, chapter: 'Sign in', text: 'We have always wondered how often Quranic words occur; sign in to begin.' }, { beat: 1, chapter: 'The chart', text: 'The chart appears.' }] })
    const n = await narrate(base({ chat, opening }))
    expect(n.introText).toBe(openingLine(QUESTION, true))
  })

  it('an ordered ending is said at the end', async () => {
    const n = await narrate(base({ closing: { text: 'Thanks for watching, see you next time.' } }))
    expect(n.outroText).toBe("Taaweel's Mizan Tool. Thanks for watching, see you next time.")
  })

  it('the narration writer is not asked to say the question over a page beat, and the sign-in beat stays a sign-in', () => {
    const plan = readBriefByRules(input(BRIEF))
    expect(narrationBrief(plan)).toContain('Say: We have always wondered')
    expect(narrationBrief(withoutFramed(plan))).not.toMatch(/wondered/)
  })
})

describe('the check that compares the brief to the narration', () => {
  const plan = readBriefByRules(input(BRIEF)) as FilmPlan
  const seg = plan.segments.find((s): s is NarrationSegment => s.kind === 'narration') as NarrationSegment

  it('fails when the intro is the old stock line (what the user saw)', () => {
    const lines = ["Introducing Taaweel's mizan tool, designed to mathematically compare words across the entire Quran.", 'We have always wondered how often Quranic words occur; sign in to begin.', "Explore Taaweel's mizan tool, available to use right now."]
    expect(reviewSegment(seg, { kind: 'narration', lines }).status).not.toBe('done')
  })

  it('passes when the intro opens with the question', () => {
    const lines = [openingLine(QUESTION, true), 'First we sign in.']
    expect(reviewSegment(seg, { kind: 'narration', lines }).status).toBe('done')
    const checks = reviewStage({ plan, acted: null, take: null, clipsMade: new Map(), lines, problemDrawn: false })
    expect(buildReport(plan, null, checks).shortfalls.filter((x) => /Start the intro|none/.test(x))).toEqual([])
  })
})
