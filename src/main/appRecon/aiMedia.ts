import type { LLMProvider } from '../providers/types'
import { scanNarration, scrubText } from './detect'

/**
 * AI-made supporting media for a recorded app video.
 *
 * Two optional extras, both off unless the person asks for them:
 *   - AI video clips: short cutaways (a motion diagram of the workflow, an
 *     opening visual) made by the person's video model and cut into the film;
 *   - AI music: one track from the person's music model, scored to the film,
 *     in a style the engine chooses.
 *
 * What the person writes in "What should the video show?" counts as an
 * instruction: a sentence that asks for an AI video, clip or animation is read
 * out here, planned, generated and placed. The words are matched by rules, so
 * this works with no AI at all; an AI writer (when there is one) only makes
 * the picture description richer. Nothing here sees a credential.
 */

export type Placement = 'start' | 'middle' | 'end'

export interface MediaRequest {
  /** the sentence the person wrote */
  said: string
  /** what the clip should be about, in their words, lead-in removed */
  subject: string
  placement: Placement
  /** the sentence only says where the clip goes ("use ai video intro"); the subject is then the film itself */
  generic: boolean
}

export interface MediaAsk {
  requests: MediaRequest[]
  /** the person said they do NOT want AI video */
  declined: boolean
}

const MEDIA_NOUN = /\b(?:videos?|clips?|animations?|animated|motion\s+(?:graphics?|diagrams?|visuals?|design)|footage|b-?rolls?|cutaways?|illustrations?)\b/i
const AI_WORD = /\b(?:ai|a\.i\.|generated?|generative|gemini|omni|veo|synthetic)\b/i
const MOTION_DIAGRAM = /\bmotion\s+(?:graphics?|diagrams?|visuals?|design)\b|\banimated?\s+(?:diagram|explainer|illustration|visual|infographic|graphic)s?\b/i
const INTENT = /\b(?:illustrat\w*|visuali[sz]\w*|explain\w*|show\w*|depict\w*|demonstrat\w*|support\w*|add\w*|insert\w*|include\w*|use\w*|need\w*|want\w*|make\w*|create\w*|generate\w*|produce\w*|put\w*|with)\b/i
const NEGATIVE = /\b(?:no|not|don'?t|do\s+not|without|never|skip|avoid)\b[^.!?\n]{0,40}\b(?:ai|a\.i\.|generated?)\b[^.!?\n]{0,30}\b(?:videos?|clips?|animations?|footage|media)\b/i
const LEAD = /^(?:(?:and|also|then|please|plus|finally|lastly|first|firstly|next)[,\s]+)*(?:(?:i|we)\s+(?:would\s+like|need|want|'d\s+like|d\s+like|require)\s+(?:to\s+(?:have|see|use|add|include)\s+)?|(?:please\s+)?(?:add|include|insert|use|make|create|generate|put\s+in|show)\s+)?/i
const KIND = /^(?:(?:an?|the|some|one|two)\s+)?(?:(?:ai|a\.i\.)[-\s]+)?(?:generated\s+)?(?:short\s+)?(?:(?:ai|a\.i\.)[-\s]+)?(?:videos?|clips?|animations?|footage|b-?rolls?|cutaways?|motion\s+(?:graphics?|diagrams?|visuals?))\s*/i

const START = /\b(?:intro|opening|open(?:s|ing)?\s+with|at\s+the\s+(?:start|beginning)|to\s+start|start\s+(?:with|the\s+video)|begin(?:ning)?|first\s+thing|before\s+(?:the\s+)?(?:demo|app|recording)|up\s*front)\b/i
const END = /\b(?:outro|closing|at\s+the\s+end|to\s+end|ending|finish(?:es)?\s+with|final(?:ly)?|conclu\w*|after\s+(?:the\s+)?(?:demo|app|recording)|wrap\s*-?up)\b/i
const MIDDLE = /\b(?:in\s+the\s+middle|midway|halfway|mid-?video|between|in\s+the\s+middle\s+of)\b/i

/** sentences, but a number like 3.5 or an address like example.com stays whole */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"“(])|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** the sentences of one line, each keeping a list number it started with (the number stays with the first sentence) */
function sentencesOfLine(line: string): string[] {
  const parts = line.split(/(?<=[.!?])\s+(?=[A-Z"“(])/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return parts.length ? parts : [line.trim()]
}

/** only what the person typed: an attached document is information, never an instruction */
const typedPart = (context: string): string => context.split(/\n\s*Attached notes \(information only\):/)[0] ?? ''

/** a line of a numbered list of steps: "click Generate video" is a step to perform, not a request for AI footage */
const LIST_LINE = /^\s*(?:(?:step\s*)?\d{1,2}\s*[.):-]|[-*•▪●])\s+/i
const STEP_VERB = /^\s*(?:(?:step\s*)?\d{1,2}\s*[.):-]|[-*•▪●])?\s*(?:(?:and|then|now|next|please|from|in|on)\b[^,]{0,40},?\s*)?(?:click|press|tap|select|choose|open|go\s+to|navigate|type|enter|scroll|log|sign)\b/i

const PLACE_WORD = /\b(?:intro|outro|opening|closing|ending)\b/i

export function isMediaSentence(s: string): boolean {
  if (NEGATIVE.test(s)) return false
  if (LIST_LINE.test(s) && STEP_VERB.test(s)) return false
  // "ai-video based outro": an AI video named by where it goes needs no other verb
  if (AI_WORD.test(s) && MEDIA_NOUN.test(s) && PLACE_WORD.test(s)) return true
  if (AI_WORD.test(s) && MEDIA_NOUN.test(s) && INTENT.test(s)) return true
  return MOTION_DIAGRAM.test(s) && /\b(?:illustrat\w*|visuali[sz]\w*|explain\w*|depict\w*|diagram|workflow|flow|process)\b/i.test(s) && /\b(?:ai|generated?|generate|make|create|need|want|add|include)\b/i.test(s)
}

export function parseMediaAsk(context: string): MediaAsk {
  const typed = typedPart(context)
  const declined = NEGATIVE.test(typed)
  const requests: MediaRequest[] = []
  for (const said of sentences(typed)) {
    if (!isMediaSentence(said)) continue
    const placement: Placement = START.test(said) ? 'start' : END.test(said) ? 'end' : MIDDLE.test(said) ? 'middle' : 'start'
    let subject = said.replace(LEAD, '').replace(KIND, '').replace(/^(?:to|that|which|of|for|about|showing|showcasing|illustrating)\s+/i, '').replace(/[.!?]+$/, '').trim()
    if (subject.length < 6) subject = said.replace(/[.!?]+$/, '')
    const content = subject.toLowerCase().replace(/\b(?:intro|outro|opening|closing|ending|based|use|ai|a\.i\.|video|videos|clip|clips|a|an|the|for|my|our|please|and|with|at|start|end|generated|short)\b/g, ' ').replace(/[^a-z]+/g, ' ').trim()
    requests.push({ said: said.slice(0, 400), subject: subject.slice(0, 300), placement, generic: content.length < 6 })
  }
  return { requests: requests.slice(0, MAX_CLIPS), declined }
}

/** the typed context with the sentences that ask for AI media taken out (so they are never read as steps to perform on the app) */
export function withoutMediaSentences(context: string): string {
  const [typed, ...rest] = context.split(/(\n\s*Attached notes \(information only\):)/)
  // line breaks stay: a numbered list of steps must still be a list afterwards
  const kept = (typed ?? '')
    .split('\n')
    .map((line) => (line.trim() ? sentencesOfLine(line).filter((s) => !isMediaSentence(s)).join(' ') : ''))
  return [kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), ...rest].join('')
}

export const MAX_CLIPS = 2

export interface PlannedClip {
  prompt: string
  /** said over the clip */
  line: string
  placement: Placement
  /** what the person asked for, shown in the review notes */
  said: string
  auto: boolean
}

const NO_TEXT = 'No text, no letters, no logos, no watermarks, no faces. Smooth, slow, continuous motion.'

/** subjects that call for a respectful, abstract treatment: no depictions of people or religious figures */
const SACRED = /\b(?:qur'?an\w*|islam\w*|halal|muslims?|allah|prophets?|hadith|verses?|tafsir|taaweel|mosque)\b/i

function fallbackPrompt(subject: string, placement: Placement, careful: boolean): string {
  const s = subject.replace(/[.!?]+$/, '')
  const frame =
    placement === 'start' ? `An elegant, welcoming opening sequence that introduces ${s}.`
    : placement === 'end' ? `A calm, uplifting closing sequence that leaves a lasting impression of ${s}.`
    : `A beautiful, elegant motion-graphics sequence that illustrates ${s}.`
  const look = careful
    ? 'Serene abstract geometric patterns and softly glowing threads of light slowly connect and unfold into a luminous network of ideas, in deep green and warm gold tones. Respectful and calm. No depiction of people, prophets or religious figures, no calligraphy.'
    : 'Clean abstract shapes and softly glowing lines flow from one step to the next on a deep, dark blue background with a subtle gradient.'
  return `${frame} ${look} ${NO_TEXT}`
}

export interface PlanMediaInput {
  chat: LLMProvider | null
  requests: MediaRequest[]
  /** no request was written but AI clips are switched on: one opening clip about the app */
  auto: boolean
  appName: string
  /** what the whole film is about (the feature and its promise, or the person's own opening words): the subject of a clip that only says where it goes */
  topic: string
  /** the typed words, already scrubbed */
  context: string
  mode: 'walkthrough' | 'launch'
  secrets: string[]
  say: (m: string) => void
}

/** decides what each clip shows and says; the person's own sentences come first */
export async function planMedia(inp: PlanMediaInput): Promise<PlannedClip[]> {
  const scan = { values: inp.secrets }
  const topic = scrubText(inp.topic ?? '', scan).slice(0, 240).trim() || inp.appName
  const wants: Array<{ subject: string; placement: Placement; said: string; auto: boolean }> = inp.requests.map((r) => ({ subject: r.generic ? topic : scrubText(r.subject, scan), placement: r.placement, said: r.said, auto: false }))
  if (!wants.length && inp.auto) {
    const goal = scrubText(inp.context, scan).slice(0, 300).trim()
    wants.push({ subject: goal ? `the idea behind ${goal}` : `what ${inp.appName} does, in a simple flow`, placement: 'start', said: 'Automatic opening clip (AI clips are switched on)', auto: true })
  }
  const stockLine = (w: { auto: boolean; placement: Placement }) => (w.auto ? 'Here is how it works, at a glance.' : w.placement === 'end' ? 'And that is the whole journey, in a moment.' : 'Here is the idea, in motion.')
  const careful = SACRED.test(`${topic} ${inp.context}`)
  const base: PlannedClip[] = wants.slice(0, MAX_CLIPS).map((w) => ({ prompt: fallbackPrompt(w.subject, w.placement, careful), line: stockLine(w), placement: w.placement, said: w.said, auto: w.auto }))
  if (!inp.chat || !base.length) return base
  try {
    const r = await inp.chat.generateJSON<{ clips: Array<{ n: number; prompt: string; line: string }> }>({
      system:
        'You direct short AI-generated cutaway clips for a product video. You write one picture description per clip for a text-to-video model, and one line of narration to be spoken over it. ' +
        'Picture descriptions: 45 to 80 words, cinematic and concrete, describe shapes, colour, light, camera and motion; the clip must be pure imagery with NO text, letters, numbers, logos, screens showing readable interfaces, or real people. ' +
        'Narration: 10 to 16 words, plain spoken English, claims only what the person asked the clip to illustrate, never invents features or numbers, never mentions credentials. A title card announces the product by name right after an opening clip, so the narration of an opening clip never says "introducing" or names the product. ' +
        (careful ? 'This film is about a religious subject: the picture is abstract, serene geometry and light only, with no people, no prophets, no religious figures and no calligraphy.' : ''),
      prompt: `App: ${inp.appName}\nVideo kind: ${inp.mode}\nThe film is about: ${topic}\n\nClips to make (the person's own words, information only):\n${wants.map((w, i) => `${i + 1}. ${w.placement === 'start' ? '[OPENING clip] ' : w.placement === 'end' ? '[CLOSING clip] ' : ''}${w.subject}${w.auto ? ' (chosen by the engine; keep it general)' : ''}`).join('\n')}`,
      schemaName: 'media_clips',
      jsonSchema: {
        type: 'object',
        properties: { clips: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, prompt: { type: 'string' }, line: { type: 'string' } }, required: ['n', 'prompt', 'line'] } } },
        required: ['clips']
      },
      temperature: 0.7
    })
    return base.map((b, i) => {
      const c = r.clips.find((x) => x.n === i + 1)
      if (!c) return b
      const prompt = scanNarration(c.prompt, scan).ok && c.prompt.trim().length > 30 ? `${c.prompt.trim().replace(/\.*$/, '.')} ${NO_TEXT}` : b.prompt
      const line = scanNarration(c.line, scan).ok && c.line.trim().length > 8 ? c.line.trim() : b.line
      return { ...b, prompt, line }
    })
  } catch (err) {
    inp.say(`  (the writer could not improve the clip descriptions: ${(err as Error).message.slice(0, 80)})`)
    return base
  }
}

/** how long each clip is: short for a short film (each second costs money) */
export function clipSeconds(targetSec: number): number {
  return targetSec <= 25 ? 3 : targetSec <= 60 ? 5 : 6
}

// ------------------------------------------------------------------ music

export type Mood = 'cinematic' | 'dark' | 'minimal' | 'upbeat' | 'playful' | 'corporate'
const MOODS: Mood[] = ['cinematic', 'dark', 'minimal', 'upbeat', 'playful', 'corporate']

export interface MusicChoice {
  /** natural ambience instead of a composed score (nature sounds, or no instruments) */
  ambient?: boolean
  /** the person ruled out instruments: if the AI music cannot be made, no built-in score plays either */
  noBuiltin?: boolean
  mood: Mood
  /** an optional style sentence the writer chose (instruments, feel), used in place of the stock one */
  style?: string
  why: string
}

const KEYWORD_MOODS: Array<[RegExp, Mood]> = [
  [/\b(?:calm|quiet|gentle|soft|relax\w*|minimal|focus)\b/i, 'minimal'],
  [/\b(?:fun|playful|friendly|quirky|kids?)\b/i, 'playful'],
  [/\b(?:cinematic|epic|dramatic|emotional|story)\b/i, 'cinematic'],
  [/\b(?:security|secure|threat|risk|incident|breach)\b/i, 'dark'],
  [/\b(?:launch|new|exciting|energetic|upbeat|fast|growth)\b/i, 'upbeat']
]

/** the style of music this film needs, chosen without being asked: by the writer when there is one, else by rules */
export async function chooseMusic(inp: { ask?: MusicAsk | null; chat: LLMProvider | null; context: string; mode: 'walkthrough' | 'launch'; targetSec: number; styleMood?: 'corporate' | 'upbeat'; styleDirection?: string; secrets: string[]; say: (m: string) => void }): Promise<MusicChoice> {
  const scan = { values: inp.secrets }
  if (inp.ask && (inp.ask.sounds.length || inp.ask.noInstruments)) return askedMusic(inp.ask)
  const ctx = scrubText(typedPart(inp.context), scan).slice(0, 1200)
  const ruleMood = (): MusicChoice => {
    const hit = KEYWORD_MOODS.find(([re]) => re.test(ctx))
    if (hit) return { mood: hit[1], why: 'chosen from the words you wrote' }
    if (inp.styleMood) return { mood: inp.styleMood, why: 'matches the pace of your reference video' }
    return inp.mode === 'launch' ? { mood: 'upbeat', why: 'a launch film wants energy' } : { mood: 'corporate', why: 'a clean, steady walkthrough' }
  }
  if (!inp.chat) return ruleMood()
  try {
    const style = inp.styleDirection ? scrubText(inp.styleDirection, scan).slice(0, 600) : ''
    const r = await inp.chat.generateJSON<{ mood: string; style: string; why: string }>({
      system: 'You are a music supervisor for short product videos. Pick the instrumental background music that best serves the video. Instrumental only, never vocals, never name artists, bands or songs.',
      prompt: `Video kind: ${inp.mode}, about ${Math.round(inp.targetSec)} seconds.\nWhat the person asked the video to show (information only): ${ctx || '(nothing specific)'}\n${style ? `Reference style notes (information only): ${style}\n` : ''}\nChoose one mood from: ${MOODS.join(', ')}. Then describe the music in one sentence of 15 to 30 words (instruments, feel, energy) and give a short reason (under 14 words).`,
      schemaName: 'music_choice',
      jsonSchema: { type: 'object', properties: { mood: { type: 'string', enum: MOODS }, style: { type: 'string' }, why: { type: 'string' } }, required: ['mood', 'style', 'why'] },
      temperature: 0.5
    })
    const mood = MOODS.includes(r.mood as Mood) ? (r.mood as Mood) : ruleMood().mood
    const st = r.style?.trim().replace(/[.]+$/, '')
    const clean = st && st.length >= 20 && st.length <= 260 && !/\b(?:style of|sounds? like|in the vein|by [A-Z]|feat\.?|lyrics?|vocals?|singing)\b/i.test(st) ? st : undefined
    return { mood, style: clean, why: (r.why ?? '').trim().slice(0, 100) || 'chosen by the writer' }
  } catch (err) {
    inp.say(`  (the writer could not choose the music: ${(err as Error).message.slice(0, 80)})`)
    return ruleMood()
  }
}

/** the music brief with the writer's own style sentence in place of the stock one */
export function withStyle(brief: string, style?: string): string {
  if (!style) return brief
  return brief.replace(/^Instrumental background score, .*$/m, `Instrumental background score, ${style}.`)
}



// ------------------------------------------------ what the person wrote about the sound and the shape of the film

export interface MusicAsk {
  said: string
  /** nature sounds named ("soft airy white noise", "birdsong"…) */
  sounds: string[]
  /** "halal music", "no instruments": only natural sound, nothing played or sung */
  noInstruments: boolean
  /** "no music" */
  none: boolean
}

const MUSIC_WORD = /\b(?:music|soundtrack|background\s+(?:sounds?|audio|noise)|sound\s*scape|ambien(?:ce|t)|score)\b/i
const NO_MUSIC = /\b(?:no|without|skip)\s+(?:any\s+)?(?:background\s+)?music\b/i
const NO_INSTRUMENTS = /\b(?:halal|no\s+instruments?|without\s+(?:any\s+)?instruments?|instrument-?free|no\s+(?:drums?|percussion|vocals?|singing))\b/i
const SOUNDS: Array<[RegExp, string]> = [
  [/\bwhite\s+noise\b/i, 'soft, airy white noise'],
  [/\bbirds?(?:song)?\b|\bbirdsong\b/i, 'birdsong'],
  [/\bthunder\w*/i, 'distant, soft rolling thunder'],
  [/\brain\w*/i, 'gentle rain'],
  [/\bwind\b|\bbreeze\b/i, 'a light breeze'],
  [/\bwaves?\b|\bocean\b|\bsea\b/i, 'gentle waves'],
  [/\briver\b|\bstream\b|\bwater\b/i, 'flowing water'],
  [/\bforest\b/i, 'a quiet forest'],
  [/\bcrickets?\b/i, 'crickets'],
  [/\bnatur(?:e|al)\b/i, 'natural ambience']
]

/** the music wishes in the typed words: nature sounds, no instruments, or no music at all */
export function parseMusicAsk(context: string): MusicAsk | null {
  let found = null as MusicAsk | null
  for (const line of typedPart(context).split('\n')) {
    if (!line.trim() || (LIST_LINE.test(line) && STEP_VERB.test(line))) continue
    for (const said of sentencesOfLine(line)) {
      if (!MUSIC_WORD.test(said)) continue
      const sounds = SOUNDS.filter(([re]) => re.test(said)).map(([, s]) => s)
      const none = NO_MUSIC.test(said)
      const noInstruments = NO_INSTRUMENTS.test(said)
      if (!sounds.length && !noInstruments && !none) continue
      const prev: MusicAsk | null = found
      const all: string[] = [...new Set([...(prev?.sounds ?? []), ...sounds])]
      // "natural" alone is only a hint; specific sounds replace it
      const specific: string[] = all.filter((x) => x !== 'natural ambience')
      found = { said: said.slice(0, 300), sounds: specific.length ? specific : all, noInstruments: (prev?.noInstruments ?? false) || noInstruments, none: (prev?.none ?? false) || none }
    }
  }
  return found
}

function askedMusic(ask: MusicAsk): MusicChoice {
  const sounds = ask.sounds.length ? ask.sounds : ['natural ambience']
  const list = sounds.length > 1 ? `${sounds.slice(0, -1).join(', ')} and ${sounds.at(-1)}` : sounds[0]
  return {
    mood: 'minimal',
    ambient: true,
    noBuiltin: ask.noInstruments,
    style: `calm natural soundscape of ${list}, slowly evolving, with no drums, no melody and no instruments`,
    why: ask.noInstruments ? 'natural sound only, no instruments, as you asked' : 'the natural sounds you asked for'
  }
}

/** the brief for a pure ambience track (the composed-score brief talks about BPM, motifs and builds) */
export function ambientBrief(choice: MusicChoice, totalSec: number, voiced: boolean): string {
  return [
    `Natural ambient soundscape: ${choice.style ?? 'calm natural ambience'}.`,
    'No drums, no beat, no melody, no instruments, no vocals, no lyrics, no choir, no spoken word.',
    `Total length about ${Math.round(totalSec)} seconds: slowly evolving, calm and steady in level, with a gentle natural ending.`,
    voiced ? 'It plays under a voiceover, so keep it soft and uncluttered.' : ''
  ].filter(Boolean).join('\n')
}

export interface StructureAsk {
  /** "after the intro, present the problem statement" */
  problem: boolean
  said: string
}

const PROBLEM = /\bproblem(?:\s+statement)?\b/i
const PROBLEM_VERB = /\b(?:present|show|state|explain|describe|introduce|start|open|begin|set\s*up|outline|include|add)\w*/i
const NEGATIVE_PROBLEM = /\b(?:no|skip|without|don'?t)\b[^.!?\n]{0,25}\bproblem\b/i

const isProblemSentence = (s: string): boolean => PROBLEM.test(s) && PROBLEM_VERB.test(s) && !NEGATIVE_PROBLEM.test(s)

/** how the person wants the film shaped (a problem statement before the answer) */
export function parseStructure(context: string): StructureAsk {
  for (const line of typedPart(context).split('\n')) {
    if (!line.trim() || LIST_LINE.test(line)) continue
    for (const said of sentencesOfLine(line)) if (isProblemSentence(said)) return { problem: true, said: said.slice(0, 300) }
  }
  return { problem: false, said: '' }
}

function isProductionSentence(s: string): boolean {
  if (MUSIC_WORD.test(s) && (SOUNDS.some(([re]) => re.test(s)) || NO_INSTRUMENTS.test(s) || NO_MUSIC.test(s))) return true
  return isProblemSentence(s)
}

/** the typed words with every sentence that is about the film's production (AI clips, music, structure) taken out: those are read as instructions, never as steps or topics */
export function withoutProductionSentences(context: string): string {
  const [typed, ...rest] = withoutMediaSentences(context).split(/(\n\s*Attached notes \(information only\):)/)
  const kept = (typed ?? '')
    .split('\n')
    .map((line) => {
      if (!line.trim()) return ''
      if (LIST_LINE.test(line)) return line
      return sentencesOfLine(line).filter((s) => !isProductionSentence(s)).join(' ')
    })
  return [kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), ...rest].join('')
}
