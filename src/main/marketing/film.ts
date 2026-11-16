import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderScene, pickMotif, type Motif } from '../appRecon/scenes'
import { voiceLine, neutralProblemTitle, problemLineOk, problemTitleOk } from '../appRecon/narrate'
import { chooseMusic, clipLook, fixPrompt, promptIssues, clipSeconds, withStyle, type MusicChoice } from '../appRecon/aiMedia'
import type { MediaTools } from '../appRecon/run'
import { scanNarration } from '../appRecon/detect'
import { readSec } from '../appRecon/produce'
import { musicBrief } from '../audio/cue'
import { decodeStereo, SR } from '../audio/pcm'
import type { VideoSpec } from '@shared/spec'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import type { BusinessProfile, MarketStage, VideoCard } from '@shared/marketing'
import { assemble, type FilmPiece } from './assemble'
import { filmFrame } from '@shared/shapes'

/**
 * One card's film, made with the record-an-app engine minus the recording:
 * a problem scene, a run of value beats (each an AI clip, an AI picture or an
 * animated point), and a closing card — voice, music and captions throughout.
 * The engine decides which element each beat needs; nothing is asked of the
 * person once the button is pressed.
 */

export class FilmCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export interface FilmInput {
  runDir: string
  card: VideoCard
  profile: BusinessProfile
  chat: LLMProvider | null
  speech: SpeechProvider | null
  /** the AI clip, picture and music models; null = the free engine (scenes, captions, built-in score) */
  tools: MediaTools | null
  /** AI music was asked for (the plan allows it or the person ticked it) */
  aiMusic: boolean
  /** the most AI clips the account may put in one film */
  maxClips: number
  signal?: AbortSignal
  progress: (stage: MarketStage, message: string) => void
  log?: (m: string) => void
}

export interface FilmResult {
  file: string
  durationSec: number
  /** what the engine chose, shown under the card */
  notes: string[]
  elements: string[]
}

interface Beat {
  /** words on the point scene, 3 to 6 words */
  headline: string
  /** what is said */
  line: string
  /** chip label, 2 to 4 words */
  chapter: string
}

interface Script {
  /** the trouble, in 2 to 4 words on the problem card */
  problemHeadline: string
  /** the trouble, spoken */
  problemLine: string
  beats: Beat[]
  /** the last words: the business and the next step */
  close: string
}

const NO_TEXT = 'No text, no letters, no logos, no watermarks, no faces. Smooth, slow, continuous motion.'
const clean = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

/** the script the rules alone can write, straight from the card the person edited */
function stockScript(card: VideoCard, p: BusinessProfile): Script {
  const service = card.serviceIdx !== undefined ? p.services[card.serviceIdx] : undefined
  const sentences = card.solution.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 10)
  const benefits = (service?.benefits ?? p.services.flatMap((s) => s.benefits)).filter((b) => b.length > 8).slice(0, 3)
  const beats: Beat[] = []
  if (sentences[0]) beats.push({ headline: clean(headlineOf(sentences[0]), 40) || 'The fix', line: clean(sentences[0], 220), chapter: 'The fix' })
  for (const b of benefits.slice(0, sentences[0] ? 2 : 3)) beats.push({ headline: clean(headlineOf(b), 40) || 'What you get', line: clean(b.endsWith('.') ? b : `${b}.`, 220), chapter: 'What you get' })
  if (sentences[1] && beats.length < 3) beats.push({ headline: 'How it works', line: clean(sentences[1], 220), chapter: 'How it works' })
  while (beats.length < 2) beats.push({ headline: beats.length === 0 ? 'The fix' : 'What you get', line: beats.length === 0 ? clean(card.solution, 220) : `With ${p.name}, ${p.tagline.toLowerCase()}.`, chapter: beats.length === 0 ? 'The fix' : 'What you get' })
  return {
    problemHeadline: neutralProblemTitle(`${card.problem} ${card.title}`),
    problemLine: clean(card.problem, 300),
    beats: beats.slice(0, 3),
    close: clean(`${p.name}. ${card.cta}.`, 160)
  }
}

/** a short headline from a longer line: its meaningful first words */
function headlineOf(line: string): string {
  const words = line.replace(/^[^a-zA-Z0-9]+/, '').split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|with|for|our|your|that|this|from)$/i.test(w))
  return words.slice(0, 4).join(' ').replace(/[.,;:]+$/, '')
}

/** the writer's script: one story from trouble to answer, grounded in the profile */
async function writeScript(card: VideoCard, p: BusinessProfile, chat: LLMProvider): Promise<Script> {
  const stock = stockScript(card, p)
  const service = card.serviceIdx !== undefined ? p.services[card.serviceIdx] : undefined
  const facts = [p.about, ...(service ? [`${service.name}: ${service.summary}`, ...service.benefits.map((b) => `Benefit: ${b}`)] : p.services.slice(0, 2).map((s) => `${s.name}: ${s.summary}`))].slice(0, 8)
  const r = await chat.generateJSON<{ problemHeadline: string; problemLine: string; beats: Array<{ headline: string; line: string; chapter: string }>; close: string }>({
    system:
      'You write the voice-over of a 25-second problem–solution brand film. Plain, warm, confident spoken English; no jargon, no hype words, no invented claims or numbers. The problem is the customer\'s everyday trouble in their own words — it never names the business or any service. The answer then arrives, concretely, and the last line is the business name with one small next step.',
    prompt:
      `Business: ${p.name} — ${p.tagline}\nWhat it does: ${p.about}\nTrue facts to draw on (information only):\n${facts.map((f) => `- ${f}`).join('\n')}\n\nThe video concept:\nTitle: ${card.title}\nThe customer's trouble: ${card.problem}\nThe answer: ${card.solution}\nNext step: ${card.cta}\n\n` +
      'Write: problemHeadline — 2 to 4 words (at most 26 characters) naming the trouble, never the business or the answer; problemLine — 20 to 32 words of that trouble ending on the tension; then 3 beats, each: headline (3 to 6 words shown on screen), line (14 to 22 words spoken), chapter (2 to 4 words); then close — 8 to 14 words ending on the call to action, naming the business once.',
    schemaName: 'marketing_script',
    jsonSchema: {
      type: 'object',
      properties: {
        problemHeadline: { type: 'string' },
        problemLine: { type: 'string' },
        beats: { type: 'array', items: { type: 'object', properties: { headline: { type: 'string' }, line: { type: 'string' }, chapter: { type: 'string' } }, required: ['headline', 'line', 'chapter'] } },
        close: { type: 'string' }
      },
      required: ['problemHeadline', 'problemLine', 'beats', 'close']
    },
    temperature: 0.6,
    maxTokens: 900
  })
  const check = { values: [] as string[] }
  let headline = clean(r.problemHeadline, 30).replace(/[.!?:]+$/, '')
  if (!headline || !scanNarration(headline, check).ok || !problemTitleOk(headline, card.solution, p.tagline, p.name)) headline = stock.problemHeadline
  let problemLine = clean(r.problemLine, 320)
  if (!problemLineOk(problemLine, card.solution, p.name) || !scanNarration(problemLine, check).ok) problemLine = stock.problemLine
  const beats = (r.beats ?? [])
    .map((b): Beat => ({ headline: clean(b.headline, 60), line: clean(b.line, 240), chapter: clean(b.chapter, 30) }))
    .filter((b) => b.headline && b.line && scanNarration(b.line, check).ok)
    .slice(0, 3)
  const close = clean(r.close, 180)
  return { problemHeadline: headline, problemLine, beats: beats.length >= 2 ? beats : stock.beats, close: scanNarration(close, check).ok && close ? close : stock.close }
}

/** which element tells each beat: an AI clip, an AI picture, or an animated point */
function planElements(beats: Beat[], opts: { tools: MediaTools | null; maxClips: number }): Array<'scene' | 'still' | 'clip'> {
  if (!opts.tools) return beats.map(() => 'scene')
  const CLIP_WORDS = /process|workflow|pipeline|build|create|craft|design|deliver|manage|connect|integrate|automat|install|repair|clean|train|coach|produce|ship|grow|plan|organize|organise|run\b/i
  const STILL_WORDS = /team|office|studio|kitchen|workshop|clinic|garden|home|room|table|desk|hands?|tools?|material|product|device|machine|plant|dish|plate|field/i
  const kinds: Array<'scene' | 'still' | 'clip'> = []
  let clips = 0
  let stills = 0
  const room = (k: 'scene' | 'still' | 'clip'): boolean => (k === 'clip' ? clips < opts.maxClips : k === 'still' ? stills < 2 : true)
  for (const b of beats) {
    const t = `${b.headline} ${b.line}`
    let kind: 'scene' | 'still' | 'clip'
    if (room('clip') && CLIP_WORDS.test(t) && kinds.at(-1) !== 'clip') kind = 'clip'
    else if (room('still') && STILL_WORDS.test(t) && kinds.at(-1) !== 'still') kind = 'still'
    else {
      // keep the film varied: never the same element twice in a row when there is a choice
      const order: Array<'scene' | 'still' | 'clip'> = ['scene', 'still', 'clip']
      kind = order.find((k) => room(k) && k !== kinds.at(-1)) ?? 'scene'
    }
    if (kind === 'clip') clips++
    if (kind === 'still') stills++
    kinds.push(kind)
  }
  return kinds
}

/** a picture prompt built without a writer: the beat told as one slow physical shot */
function stockClipPrompt(beat: Beat, brand: { accent?: string; backdrop?: [string, string] }, motif: Motif): string {
  const look = clipLook('middle', brand, motif)
  return [`One slow, continuous shot: ${beat.line.replace(/\.$/, '')}, shown as a real physical scene with concrete objects and materials.`, 'Slow, smooth camera move forward. Soft, even light.', look.palette, look.motif, NO_TEXT].filter(Boolean).join(' ')
}

/** the writer's storyboards for the clips: concrete, filmable, brand-coloured */
async function writeClipPrompts(beats: Beat[], kinds: Array<'scene' | 'still' | 'clip'>, card: VideoCard, p: BusinessProfile, chat: LLMProvider, brand: { accent?: string; backdrop?: [string, string] }, motif: Motif, say: (m: string) => void): Promise<Map<number, string>> {
  const idx = beats.map((_, i) => i).filter((i) => kinds[i] === 'clip')
  const out = new Map<number, string>()
  for (const i of idx) out.set(i, stockClipPrompt(beats[i], brand, motif))
  if (!idx.length) return out
  try {
    const look = clipLook('middle', brand, motif)
    const r = await chat.generateJSON<{ shots: Array<{ n: number; prompt: string }> }>({
      system:
        'You direct short AI-generated cutaway clips for a brand film. Each shot is a storyboard for a text-to-video model: ONE specific physical, filmable metaphor with named objects (never "energy", "flow" or "glowing lines" alone) that illustrates the sentence it accompanies. FORBIDDEN, always: readable text, letters, numbers, interfaces, logos, watermarks, faces or recognisable people. ' +
        `Use this palette and no other: ${look.palette} ` +
        'Return "prompt": 60 to 100 words, in this order: subject and setting, the action over time, one camera move, the lighting, the palette, the style.',
      prompt:
        `Business: ${p.name} — ${p.tagline}\nClips to make (each illustrates its sentence):\n${idx.map((i) => `${i + 1}. ${beats[i].line}`).join('\n')}\n` +
        `Aim: ${card.solution}`,
      schemaName: 'marketing_shots',
      jsonSchema: {
        type: 'object',
        properties: { shots: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, prompt: { type: 'string' } }, required: ['n', 'prompt'] } } },
        required: ['shots']
      },
      temperature: 0.7,
      maxTokens: 800
    })
    for (const i of idx) {
      const shot = (r.shots ?? []).find((s) => s.n === i + 1)
      const body = clean(shot?.prompt ?? '', 800)
      if (!body || promptIssues(body).length) {
        if (body) say(`  (clip ${i + 1} storyboard was too vague, using the plain one)`)
        continue
      }
      const fixed = await fixPrompt({ chat, prompt: body, context: card.solution, secrets: [], say })
      if (!fixed.usedStock) out.set(i, [fixed.prompt.replace(/\.*$/, '.'), look.palette, NO_TEXT].join(' '))
    }
  } catch (err) {
    say(`  (the writer could not storyboard the clips: ${(err as Error).message.slice(0, 80)})`)
  }
  return out
}

/** a still made and checked before it is used; null = fall back to an animated point */
async function checkedStill(tools: MediaTools, prompt: string, runDir: string, i: number, notes: string[], signal?: AbortSignal, portrait = false): Promise<string | null> {
  if (!tools.still) return null
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new FilmCancelled()
      const still = await tools.still(`A still photograph for a brand film. ${prompt}`, { portrait })
      const verdict = tools.reviewStill ? await tools.reviewStill(still.file).catch(() => null) : null
      if (!verdict || verdict.ok) return still.file
    }
    notes.push('A picture for one beat did not pass the check, so an animated point is used instead.')
  } catch (err) {
    if (err instanceof FilmCancelled || signal?.aborted) throw err
    notes.push(`A picture for one beat could not be made (${String((err as Error)?.message ?? err).slice(0, 100)}), so an animated point is used instead.`)
  }
  return null
}

export async function runMarketingFilm(inp: FilmInput): Promise<FilmResult> {
  const say = (m: string) => inp.log?.(m)
  const check = () => {
    if (inp.signal?.aborted) throw new FilmCancelled()
  }
  const { card, profile: p } = inp
  // the card's frame: where it will be posted (wide when none is chosen)
  const frame = filmFrame(card.platform)
  const portrait = frame.height > frame.width
  mkdirSync(inp.runDir, { recursive: true })
  const brand = { accent: p.brand.accent, backdrop: p.brand.backdrop }
  const motif = pickMotif(`${card.solution} ${p.about}`)
  const notes: string[] = []
  const elements: string[] = []

  // ------------------------------------------------------------ the script
  inp.progress('script', 'Writing the story')
  let script = stockScript(card, p)
  if (inp.chat) {
    try {
      script = await writeScript(card, p, inp.chat)
    } catch (err) {
      say(`the writer could not write the script (${(err as Error).message.slice(0, 80)}); the card's own words are used`)
    }
  }
  say(`script: "${script.problemHeadline}" + ${script.beats.length} beats + close`)
  check()

  // ------------------------------------------------------------ the voice
  inp.progress('voice', 'Recording the voice-over')
  const tone = 'Confident, warm brand-film narrator. Clear and engaging, at an unhurried pace, with a smile in the voice.'
  const spokenSec = (pcm: Float32Array, text: string) => (pcm.length ? pcm.length / SR : readSec(text))
  const problemPcm = await voiceLine(inp.speech, inp.runDir, 'voice-problem', script.problemLine, tone)
  const beatPcms: Float32Array[] = []
  for (let i = 0; i < script.beats.length; i++) beatPcms.push(await voiceLine(inp.speech, inp.runDir, `voice-beat-${i + 1}`, script.beats[i].line, tone))
  const closePcm = await voiceLine(inp.speech, inp.runDir, 'voice-close', script.close, tone)
  if (inp.speech) elements.push('AI voice-over')
  check()

  // ------------------------------------------------------------ the pictures
  inp.progress('media', 'Choosing the elements')
  const kinds = planElements(script.beats, { tools: inp.tools, maxClips: inp.maxClips })
  say(`elements per beat: ${kinds.join(', ') || '(none)'}`)
  const clipPrompts = inp.chat && inp.tools ? await writeClipPrompts(script.beats, kinds, card, p, inp.chat, brand, motif, say) : new Map<number, string>()
  const clipSec = clipSeconds(card.targetSec)
  const logo = p.brand.logoFile && existsSync(p.brand.logoFile) ? p.brand.logoFile : undefined

  const pieces: FilmPiece[] = []
  // the trouble opens the film, on the problem scene
  pieces.push({ kind: 'scene', file: '', text: script.problemLine, pcm: problemPcm, sec: Math.max(4.2, spokenSec(problemPcm, script.problemLine) + 1.9), chapter: '' })

  for (let i = 0; i < script.beats.length; i++) {
    const b = script.beats[i]
    const pcm = beatPcms[i]
    const spoken = spokenSec(pcm, b.line)
    check()
    if (kinds[i] === 'clip' && inp.tools) {
      const prompt = clipPrompts.get(i) ?? stockClipPrompt(b, brand, motif)
      try {
        // the clip's first frame is made and checked before any video is paid for
        let imageFile: string | undefined
        if (inp.tools.still) {
          const still = await inp.tools.still(`First frame of this shot, a still photograph: ${prompt}`, { portrait })
          const verdict = inp.tools.reviewStill ? await inp.tools.reviewStill(still.file).catch(() => null) : null
          if (!verdict || verdict.ok) imageFile = still.file
        }
        const clip = await inp.tools.clip(prompt, clipSec, { imageFile, portrait })
        pieces.push({ kind: 'clip', file: clip.file, text: b.line, chapter: b.chapter, pcm, sec: Math.max(clipSec, spoken + 1.0), clipSec: clip.durationSec ?? clipSec })
        elements.push('AI video clip')
        notes.push('AI clip: ' + clean(b.headline, 60))
        continue
      } catch (err) {
        if (err instanceof FilmCancelled || inp.signal?.aborted) throw err
        notes.push(`An AI clip for "${clean(b.headline, 40)}" could not be made (${String((err as Error)?.message ?? err).slice(0, 100)}), so an animated point is used.`)
        say(`  clip ${i + 1} failed: ${(err as Error).message.slice(0, 80)}; falling back to a scene`)
      }
    }
    if (kinds[i] === 'still' && inp.tools) {
      const file = await checkedStill(inp.tools, stockClipPrompt(b, brand, motif), inp.runDir, i, notes, inp.signal, portrait)
      if (file) {
        pieces.push({ kind: 'still', file, text: b.line, chapter: b.chapter, pcm, sec: Math.max(4.2, spoken + 1.4) })
        elements.push('AI image')
        continue
      }
    }
    // the animated point: the beat as its own moving card
    const want = Math.min(8, Math.max(4.2, spoken + 1.5))
    const scene = await renderScene({ kind: 'point', motif, pill: b.chapter, headline: b.headline, accent: p.brand.accent, backdrop: p.brand.backdrop, logo, durationSec: want, size: frame }, join(inp.runDir, `scene-beat-${i + 1}.mp4`))
    pieces.push({ kind: 'scene', file: scene.file, text: b.line, chapter: b.chapter, pcm, sec: Math.max(want, spoken + 1.5), srcSec: scene.durationSec })
  }
  check()

  // ------------------------------------------------------------ the music
  let choice: MusicChoice | null = null
  if (inp.chat) {
    try {
      choice = await chooseMusic({ chat: inp.chat, context: `${card.title}. ${card.solution}`, mode: 'launch', targetSec: card.targetSec, secrets: [], say })
    } catch {
      choice = null
    }
  }

  // ------------------------------------------------------------ the closing card and the assembly
  inp.progress('assemble', 'Building the film')
  const closeText = script.close
  const outroSpoken = spokenSec(closePcm, closeText)
  const outroSec = Math.max(4.2, outroSpoken + 2.3)
  const problemSec = Math.max(4.2, spokenSec(problemPcm, script.problemLine) + 1.9)
  const problemScene = await renderScene({ kind: 'problem', motif, headline: script.problemHeadline, accent: p.brand.accent, backdrop: p.brand.backdrop, logo, durationSec: Math.min(8, problemSec), size: frame }, join(inp.runDir, 'scene-problem.mp4'))
  pieces[0] = { ...pieces[0], file: problemScene.file, sec: problemSec, srcSec: problemScene.durationSec }
  const outroScene = await renderScene({ kind: 'outro', motif, pill: clean(card.cta.toUpperCase(), 24), headline: p.name, sub: p.tagline, accent: p.brand.accent, backdrop: p.brand.backdrop, logo, durationSec: Math.min(8, outroSec), size: frame }, join(inp.runDir, 'scene-outro.mp4'))
  pieces.push({ kind: 'scene', file: outroScene.file, text: closeText, pcm: closePcm, sec: outroSec, srcSec: outroScene.durationSec, chapter: '', fadeOut: true })
  elements.push('Animated scenes (HTML/canvas)')

  const wantAiMusic = inp.aiMusic && !!inp.tools?.music
  const out = await assemble({
    dir: inp.runDir,
    size: frame,
    pieces,
    title: card.title,
    musicMood: choice?.mood,
    aiMusic: wantAiMusic
      ? async ({ cuts, total }) => {
          const spec = { title: card.title, musicMood: choice?.mood ?? 'corporate', design: { look: 'social' }, voiceover: ['x'], narration: [] } as unknown as VideoSpec
          const brief = withStyle(musicBrief(spec, cuts, total) ?? `Instrumental background music for a short brand film, ${choice?.mood ?? 'corporate'} and warm, ending gently, no vocals.`, choice?.style)
          const audio = await inp.tools!.music(brief)
          const file = join(inp.runDir, 'music.mp3')
          writeFileSync(file, audio)
          return decodeStereo(file)
        }
      : undefined,
    log: inp.log
  })
  if (out.musicSource === 'ai') elements.push('AI music')
  else elements.push('Built-in score')
  if (p.brand.colors.length) notes.push(`Brand colours from ${p.domain}: ${p.brand.colors.slice(0, 3).join(', ')}`)
  if (choice) notes.push(`Music: ${choice.mood} — ${choice.why}`)
  return { file: out.file, durationSec: out.durationSec, notes, elements }
}
