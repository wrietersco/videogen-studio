import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeMono, SR } from '../audio/pcm'
import { speechBounds } from '../audio/voice'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import { scanNarration, scrubText } from './detect'
import type { BeatFacts } from './planner'
import { readSec, type BeatPlan, type CardPlan } from './produce'

/**
 * The words of the video, and the voice that says them.
 *
 * A writer model (when there is one) is told only what is on screen, in plain
 * words with private data already removed, never a credential. Every line is
 * checked before it is voiced; a line that repeats a secret, contains private
 * data or promises more than the video can show is replaced by the stock line.
 * With no writer and no narrator the stock lines are still a complete video,
 * timed by reading speed.
 */

export interface LaunchInfo {
  feature: string
  tagline: string
  closing: string
  cta: string
  targetSec: number
}

export interface NarrateInput {
  chat: LLMProvider | null
  speech: SpeechProvider | null
  beats: BeatFacts[]
  mode: 'walkthrough' | 'launch'
  launch?: LaunchInfo
  /** what the person asked for (typed words; scrubbed here before a model sees it) */
  context: string
  /** secret values: must never be said or shown to a model */
  secrets: string[]
  /** length to aim for (walkthroughs only; a launch film carries its own) */
  targetSec?: number
  /** the person's brand: its accent colour (hex without #) and logo file go on the launch cards */
  brand?: { accent?: string; logo?: string }
  dir: string
  say: (m: string) => void
}

export interface Narration {
  lines: Array<{ beat: number; chapter: string; text: string }>
  plans: BeatPlan[]
  minSec: Map<number, number>
  intro?: CardPlan
  outro?: CardPlan
  introText?: string
  outroText?: string
  narrator: string
}

export async function narrate(inp: NarrateInput): Promise<Narration> {
  const { say } = inp
  const launch = inp.mode === 'launch' ? inp.launch : undefined
  const stock = (b: BeatFacts) => (launch && b.launchFallback ? b.launchFallback : b.fallback)
  let lines = inp.beats.map((b) => ({ beat: b.beat, chapter: b.chapter, text: stock(b) }))
  let introText = launch ? `Introducing ${launch.feature}. ${launch.tagline}.` : undefined
  let outroText = launch ? `${launch.feature}. ${launch.cta}.` : undefined
  const scan = { values: inp.secrets }

  if (inp.chat) {
    try {
      const ctx = scrubText(inp.context, scan).slice(0, 1500)
      const r = await inp.chat.generateJSON<{ intro?: string; outro?: string; lines: Array<{ beat: number; chapter: string; text: string }> }>({
        system: launch
          ? 'You write voice-over for short product launch videos. Confident, warm, upbeat spoken English with a sense of occasion. No jargon, never read out any credential, password or personal data. Claim only what the beat describes: no invented features, numbers or brand names, and no absolute security promises (never words like fully protected, unbreakable, no trace, instantly). Write the feature name in normal sentence case, not capitalised mid-sentence.'
          : 'You write voice-over for short product walkthrough videos. Plain, warm, confident spoken English. No jargon, no brand names, never read out any credential, password or personal data. Say only what the beat shows; do not invent features.',
        prompt: `${launch ? `This is the launch film for a new feature: "${launch.feature}" (${launch.tagline}).\nAlso write an opening line (10 to 14 words, it must announce the feature by name) and a closing line (6 to 10 words, ends on the feature being available now).\n` : ''}The person asked for: ${ctx || '(nothing specific)'}\n\nWrite one narration line for each beat below, in order, ${launch ? '11 to 16 words' : '14 to 24 words'} each, one or two short sentences, written to be spoken aloud, plus a chapter label of 2 to 4 words. Use the beat numbers given.\n\n${inp.beats.map((b) => `Beat ${b.beat}:\n${b.facts.map((f) => `  - ${f}`).join('\n')}`).join('\n')}`,
        schemaName: 'walkthrough_script',
        jsonSchema: {
          type: 'object',
          properties: {
            intro: { type: 'string' },
            outro: { type: 'string' },
            lines: { type: 'array', items: { type: 'object', properties: { beat: { type: 'integer' }, chapter: { type: 'string' }, text: { type: 'string' } }, required: ['beat', 'chapter', 'text'] } }
          },
          required: launch ? ['intro', 'outro', 'lines'] : ['lines']
        },
        temperature: 0.6
      })
      const byBeat = new Map(r.lines.map((l) => [l.beat, l]))
      if (inp.beats.every((b) => byBeat.has(b.beat))) lines = inp.beats.map((b) => ({ beat: b.beat, chapter: byBeat.get(b.beat)!.chapter || b.chapter, text: byBeat.get(b.beat)!.text }))
      if (launch && r.intro && r.outro) { introText = r.intro; outroText = r.outro }
    } catch (err) {
      say(`  (writer unavailable, using the stock script: ${(err as Error).message.slice(0, 80)})`)
    }
  }

  // nothing is voiced until it has been checked
  lines = lines.map((l, i) => {
    const c = scanNarration(l.text, scan)
    if (c.ok) return l
    say(`  (beat ${l.beat} line replaced with the stock line: ${c.problems.join('; ')})`)
    return { beat: l.beat, chapter: l.chapter, text: stock(inp.beats[i]) }
  })
  if (launch) {
    if (!scanNarration(introText ?? '', scan).ok) introText = `Introducing ${launch.feature}. ${launch.tagline}.`
    if (!scanNarration(outroText ?? '', scan).ok) outroText = `${launch.feature}. ${launch.cta}.`
  }

  const tone = launch ? 'Confident, upbeat product-launch announcer. Warm, energetic, with a clear sense of occasion, at a brisk but natural pace.' : 'Calm, clear, friendly product-demo narrator at an unhurried pace.'
  const voiceOf = async (name: string, text: string): Promise<Float32Array> => {
    if (!inp.speech) return new Float32Array(0)
    const voice = inp.speech.defaultVoice('documentary')
    const tts = await inp.speech.tts({ text, voice, instructions: tone })
    const file = join(inp.dir, `${name}${tts.mimeType === 'audio/wav' ? '.wav' : '.mp3'}`)
    writeFileSync(file, tts.audio)
    const raw = decodeMono(file)
    const b = speechBounds(raw)
    return raw.slice(Math.max(0, Math.round((b.start - 0.04) * SR)), Math.round(b.end * SR))
  }

  const plans: BeatPlan[] = []
  const minSec = new Map<number, number>()
  for (const l of lines) {
    const pcm = await voiceOf(`voice-${l.beat}`, l.text)
    const spoken = pcm.length ? pcm.length / SR : readSec(l.text)
    plans.push({ beat: l.beat, chapter: l.chapter, text: l.text, pcm })
    minSec.set(l.beat, spoken + (l.beat === 0 ? 1.8 : 1.1))
    say(`  beat ${l.beat} [${l.chapter}] ${spoken.toFixed(1)}s ${pcm.length ? '(voice)' : '(no narrator)'} — ${l.text}`)
  }

  let intro: CardPlan | undefined
  let outro: CardPlan | undefined
  const sp = (c: CardPlan) => (c.pcm.length ? c.pcm.length / SR : readSec(c.text))
  if (launch && introText && outroText) {
    intro = { pill: 'NEW', headline: launch.feature, sub: launch.tagline, text: introText, pcm: await voiceOf('voice-intro', introText), accent: inp.brand?.accent, logo: inp.brand?.logo }
    outro = { pill: launch.cta, headline: launch.feature, sub: launch.closing, text: outroText, pcm: await voiceOf('voice-outro', outroText), accent: inp.brand?.accent ?? '35c48b', logo: inp.brand?.logo }
    // spread the time left over between the beats, so the film lands on its target length
    const introSec = Math.max(4.2, sp(intro) + 1.4)
    const outroMin = sp(outro) + 2.3
    const budget = launch.targetSec - (introSec - 0.6) - (outroMin - 0.6)
    const base = [...minSec.values()].reduce((a, c) => a + c, 0) + 1.7
    const extra = Math.max(0, Math.min(2, (budget - base) / Math.max(1, minSec.size)))
    for (const [k, v] of minSec) minSec.set(k, v + extra)
    say(`  time plan: intro ${introSec.toFixed(1)}s · demo ≈ ${(base + extra * minSec.size).toFixed(1)}s · closing ≥ ${outroMin.toFixed(1)}s → target ${launch.targetSec}s`)
  } else if (inp.targetSec) {
    const base = [...minSec.values()].reduce((a, c) => a + c, 0) + 1.7
    const extra = Math.max(0, Math.min(3, (inp.targetSec - base) / Math.max(1, minSec.size)))
    for (const [k, v] of minSec) minSec.set(k, v + extra)
  }

  writeFileSync(join(inp.dir, 'script.json'), JSON.stringify({ lines, intro: introText, outro: outroText, narrator: inp.speech ? `${inp.speech.label} · ${inp.speech.model}` : 'none' }, null, 2))
  return { lines, plans, minSec, intro, outro, introText, outroText, narrator: inp.speech ? `${inp.speech.label} · ${inp.speech.model}` : 'none' }
}
