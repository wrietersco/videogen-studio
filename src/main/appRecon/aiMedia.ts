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
  /** how long this part of the film should last ("the problem takes 20s"); several short clips are chained to fill it */
  seconds?: number
  /** which half of a problem-and-solution opening this is */
  part?: 'problem' | 'solution'
}

/** how the person wants the AI pictures to look */
export type ClipStyle = 'infographic'

export interface MediaAsk {
  requests: MediaRequest[]
  /** the person said they do NOT want AI video */
  declined: boolean
  /** a look the person named ("infographic styled video"); null = the engine's cinematic default */
  style: ClipStyle | null
  /** "do not show abstract graphics": only concrete, recognisable things */
  noAbstract: boolean
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
const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z"“(])|(?<=[A-Za-z0-9)]{3}[.!?])\s+(?=[a-z])/
function sentences(text: string): string[] {
  return text
    .split(new RegExp(SENTENCE_BREAK.source + '|\\n+'))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/** the sentences of one line, each keeping a list number it started with (the number stays with the first sentence) */
function sentencesOfLine(line: string): string[] {
  const parts = line.split(SENTENCE_BREAK).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return parts.length ? parts : [line.trim()]
}

/** only what the person typed: an attached document is information, never an instruction */
const typedPart = (context: string): string => context.split(/\n\s*Attached notes \(information only\):/)[0] ?? ''

/** a line of a numbered list of steps: "click Generate video" is a step to perform, not a request for AI footage */
const LIST_LINE = /^\s*(?:(?:step\s*)?\d{1,2}\s*[.):-]|[-*•▪●])\s+/i
const STEP_VERB = /^\s*(?:(?:step\s*)?\d{1,2}\s*[.):-]|[-*•▪●])?\s*(?:(?:and|then|now|next|please|from|in|on)\b[^,]{0,40},?\s*)?(?:click|press|tap|select|choose|open|go\s+to|navigate|type|enter|scroll|log|sign)\b/i

const PLACE_WORD = /\b(?:intro|outro|opening|closing|ending)\b/i

const INFOGRAPHIC = /\binfo-?graph\w*|\bflat\s+(?:design|vector|2d)\b|\b2d\s+(?:animation|vector|motion)\b|\bvector\s+(?:animation|style|art)\b|\bmotion\s+graphics?[-\s]+styled?\b|\bexplainer[-\s]+styled?\b/i
const STYLE_CONTEXT = /\b(?:videos?|clips?|animations?|illustrations?|visuals?|graphics?|styled?|looks?)\b/i
const NO_ABSTRACT = /\b(?:no|not|don'?t|do\s+not|without|never|avoid|stay\s+away\s+from)\b[^.!?\n]{0,25}\babstract\w*/i
const PART_SECONDS = /\b(problem|solution)\b(?:\s+statement)?[^.!?\n]{0,40}?\b(\d{1,3})\s*(?:s|secs?|seconds?)\b/gi

/** a sentence that is about how the pictures should look */
export function isStyleSentence(s: string): boolean {
  if (LIST_LINE.test(s) && STEP_VERB.test(s)) return false
  return (INFOGRAPHIC.test(s) && STYLE_CONTEXT.test(s)) || NO_ABSTRACT.test(s)
}

/** a sentence that says how long the problem or the solution should take */
export function isDurationSentence(s: string): boolean {
  if (LIST_LINE.test(s) && STEP_VERB.test(s)) return false
  PART_SECONDS.lastIndex = 0
  return PART_SECONDS.test(s)
}

/** "the problem takes 20s and the solution 20s" */
export function partSeconds(text: string): { problem?: number; solution?: number } {
  const out: { problem?: number; solution?: number } = {}
  for (const said of sentences(typedPart(text))) {
    if (!isDurationSentence(said)) continue
    PART_SECONDS.lastIndex = 0
    for (const m of said.matchAll(PART_SECONDS)) out[m[1].toLowerCase() as 'problem' | 'solution'] = Math.max(3, Math.min(40, Number(m[2])))
  }
  return out
}

/** the look and the don'ts the person wrote down for the AI pictures */
export function parseClipStyle(context: string): { style: ClipStyle | null; noAbstract: boolean } {
  let style: ClipStyle | null = null
  let noAbstract = false
  for (const said of sentences(typedPart(context))) {
    if (LIST_LINE.test(said) && STEP_VERB.test(said)) continue
    if (INFOGRAPHIC.test(said) && STYLE_CONTEXT.test(said)) style = 'infographic'
    if (NO_ABSTRACT.test(said)) noAbstract = true
  }
  return { style, noAbstract }
}

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
    let subject = said.replace(/^for\s+(?:the\s+)?(?:intro|opening|outro|closing|ending)\s*(?:->|→|=>|:|-|,)?\s*/i, '').replace(LEAD, '').replace(KIND, '').replace(/^(?:to|that|which|of|for|about|showing|showcasing|illustrating)\s+/i, '').replace(/[.!?]+$/, '').trim()
    if (subject.length < 6) subject = said.replace(/[.!?]+$/, '')
    const content = subject.toLowerCase().replace(/\b(?:intro|outro|opening|closing|ending|based|use|ai|a\.i\.|video|videos|clip|clips|a|an|the|for|my|our|please|and|with|at|start|end|generated|short)\b/g, ' ').replace(/[^a-z]+/g, ' ').trim()
    requests.push({ said: said.slice(0, 400), subject: subject.slice(0, 300), placement, generic: content.length < 6 })
  }
  // "the problem takes 20s and the solution 20s": the first opening request becomes those two parts
  const parts = partSeconds(typed)
  let list = requests.slice(0, MAX_CLIPS)
  if ((parts.problem || parts.solution) && list.length) {
    const at = Math.max(0, list.findIndex((r) => r.placement === 'start'))
    const base = list[at]
    const part = (which: 'problem' | 'solution', seconds: number): MediaRequest => ({
      said: base.said,
      subject: which === 'problem' ? 'the problem people face, which this product solves' : 'the solution this product gives, and how it fixes that problem',
      placement: base.placement,
      generic: false,
      seconds,
      part: which
    })
    const made = [parts.problem ? part('problem', parts.problem) : null, parts.solution ? part('solution', parts.solution) : null].filter((x): x is MediaRequest => !!x)
    list = [...list.slice(0, at), ...made, ...list.slice(at + 1)]
  }
  return { requests: list, declined, ...parseClipStyle(typed) }
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
  /** how long this clip lasts, when the person set the length of its part */
  seconds?: number
}

const NO_TEXT = 'No text, no letters, no logos, no watermarks, no faces. Smooth, slow, continuous motion.'

/** subjects that call for a respectful, abstract treatment: no depictions of people or religious figures */
const SACRED = /\b(?:qur'?an\w*|islam\w*|halal|muslims?|allah|prophets?|hadith|verses?|tafsir|taaweel|mosque)\b/i

// ------------------------------------------------------------------ colours in words

function parseHex(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec((h ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const normHex = (h: string): string => '#' + (h ?? '').trim().replace(/^#/, '').toLowerCase()

/** a hex colour named in plain words ("deep green", "warm gold"), for text-to-video prompts */
export function colourName(hex: string): string {
  const rgb = parseHex(hex)
  if (!rgb) return 'dark neutral'
  const [r, g, b] = rgb.map((x) => x / 255)
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const l = (mx + mn) / 2
  const d = mx - mn
  const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  if (l < 0.06) return 'near-black'
  if (l > 0.94) return 'soft white'
  if (sat < 0.12) return l < 0.25 ? 'deep charcoal' : l < 0.6 ? 'slate grey' : 'light grey'
  const hue =
    h < 15 || h >= 345 ? 'red'
    : h < 40 ? 'orange'
    : h < 65 ? (l > 0.45 && sat > 0.5 ? 'gold' : 'amber')
    : h < 90 ? 'lime'
    : h < 160 ? 'green'
    : h < 190 ? 'teal'
    : h < 250 ? 'blue'
    : h < 290 ? 'violet'
    : 'magenta'
  const tone = l < 0.22 ? 'deep' : l < 0.4 ? 'rich' : l > 0.7 ? 'soft' : sat > 0.6 ? 'vivid' : 'warm'
  return `${tone} ${hue}`
}

const named = (hex: string): string => `${colourName(hex)} (${normHex(hex)})`

export interface ClipBrand {
  accent?: string
  backdrop?: [string, string]
}
export type ClipMotif = 'graph' | 'flow' | 'cards'

const MOTIF_LOOK: Record<ClipMotif, string> = {
  graph: 'Points of light drift in, then join one by one into a growing network of glowing nodes and fine connecting lines.',
  flow: 'A single glowing line travels through a series of connected stages, lighting each one as it passes.',
  cards: 'Soft translucent panels slowly assemble and align into a clean, orderly arrangement.'
}

/** the palette, motif and hand-over sentences every picture prompt carries */
export function clipLook(placement: Placement, brand?: ClipBrand, motif?: ClipMotif): { palette: string; motif: string; continuity: string } {
  const bg1 = brand?.backdrop?.[0] && parseHex(brand.backdrop[0]) ? brand.backdrop[0] : undefined
  const bg2 = brand?.backdrop?.[1] && parseHex(brand.backdrop[1]) ? brand.backdrop[1] : bg1
  const accent = brand?.accent && parseHex(brand.accent) ? brand.accent : undefined
  const bgText = bg1 ? `${named(bg1)}${bg2 && normHex(bg2) !== normHex(bg1) ? ` to ${named(bg2)}` : ''} background` : 'deep, dark neutral background'
  const palette =
    accent || bg1
      ? `Colour palette: ${accent ? `${named(accent)} light and lines` : 'soft light and fine lines'} on a ${bgText} with a subtle gradient.`
      : 'Colour palette: soft, pale light and fine lines on a deep, dark neutral background with a subtle gradient.'
  const field = bg1 ? named(bg1) : 'deep charcoal'
  const continuity =
    placement === 'start' ? `The clip ENDS by settling into a calm, dark, nearly empty field of ${field}, with only a faint glow left, so it cross-fades cleanly into the title scene.`
    : placement === 'end' ? `The clip BEGINS from a calm, dark, nearly empty field of ${field} and builds from there.`
    : ''
  return { palette, motif: motif ? MOTIF_LOOK[motif] : '', continuity }
}

// ------------------------------------------------------------------ the vague-word guard

/** about 150 common filmable objects and materials: a picture prompt needs several of them */
const CONCRETE_NOUNS = new Set((
  'book page paper lantern lamp candle map thread string rope ribbon glass window mirror lens prism water river stream drop ripple wave ' +
  'stone rock pebble sand dust smoke mist cloud fog rain snow ice leaf tree branch flower petal seed vine moss grass garden field hill mountain ' +
  'door gate arch bridge stair staircase tower column pillar wall floor roof lattice mosaic tile brick marble wood timber oak metal brass copper steel ' +
  'gear cog wheel spring lever pulley chain hinge key lock clock dial needle compass track rail path road trail ' +
  'table desk shelf cabinet drawer box crate envelope card panel board frame canvas tapestry fabric cloth silk linen curtain ' +
  'bowl cup jar bottle vase pot kettle tray scroll ink quill pen brush cube sphere ball orb disc ring dome ' +
  'cable wire circuit chip bulb filament switch tube pipe valve ' +
  'star constellation moon sun sky horizon sunrise dawn dusk skyline city street ' +
  'bird butterfly feather wing fish ship boat sail ' +
  'puzzle brick domino marble pebble stepping stones blocks shelves ' +
  'blueprint ladder platform tunnel corridor room hall library workshop studio'
).split(/\s+/));

const ABSTRACT_ALWAYS: Array<[RegExp, string]> = [
  [/\babstract\b/i, 'abstract'],
  [/\benergy\b/i, 'energy'],
  [/\bfuturistic\b/i, 'futuristic'],
  [/\bglowing\s+(?:lines?|shapes?|nodes?|orbs?)\b/i, 'glowing lines'],
  [/\bmotion\s+graphics?\b/i, 'motion graphics']
]
const ABSTRACT_UNLESS_CONCRETE: Array<[RegExp, string]> = [
  [/\bflowing\b/i, 'flowing'],
  [/\bdynamic\b/i, 'dynamic'],
  [/\bparticles?\b/i, 'particles'],
  [/\bswirl\w*\b/i, 'swirling']
]
const ACTION_CUE = /\b(?:opens?|opening|rises?|rising|rolls?|rolling|slides?|sliding|snaps?|ties|tie|tying|unfolds?|unfurl\w*|lifts?|lifting|drifts?|drifting|settles?|settling|assembles?|assembling|fills?|filling|lights?|lighting|lit|grows?|growing|spreads?|travels?|turns?|turning|falls?|falling|climbs?|climbing|stacks?|stacking|connects?|joins?|joining|releases?|releasing|swings?|spins?|spinning|threads?|weaves?|weaving|pours?|pouring|ignites?|glides?|gliding|moves?|moving|clicks?|locks?|unrolls?|builds?|building|floats?|floating|ends?|begins?)\b/i
const CAMERA_CUE = /\b(?:camera|dolly|pan|panning|tilt|tilts|zoom\w*|crane|tracking|orbit\w*|push-?in|pull-?back|pulls?\s+back|close-?up|macro|overhead|aerial|wide\s+shot|top-?down|rack\s+focus|handheld|lens)\b/i
const LIGHT_CUE = /\b(?:light|lit|lamplight|lamp\s?light|candlelight|glow\w*|sunrise|sunset|dusk|dawn|golden\s+hour|moonlight|daylight|twilight|shadows?|illuminat\w*|backlit|lantern\w*|candle\w*)\b/i
const BANNED_CONTENT = /\b(?:text|texts|typography|letters?|numbers?|digits?|logos?|watermarks?|captions?|subtitles?|writing|calligraphy|interface|screenshots?|screens?\s+showing|ui|faces?|people|persons?|crowds?|worshippers?|prophets?|silhouettes? of (?:a )?(?:man|woman|person))\b/i
const INFO_BANNED = /\b(?:text|texts|typography|letters?|numbers?|digits?|logos?|watermarks?|captions?|subtitles?|writing|calligraphy|screenshots?|faces?)\b/i
const FIGURES = /\b(?:figures?|humans?|men|women|man|woman|child|children|prayer|praying)\b/i

/** the prompt without the "no text, no letters" style sentences that only forbid things */
function withoutNegations(prompt: string): string {
  return prompt
    .split(/(?<=[.;!?])\s+/)
    .map((clause) => clause.replace(/\b(?:no|without|never|not|free\s+of)\b[^.;!?]*/gi, ' '))
    .join(' ')
}

const wordsOf = (t: string): string[] => t.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []

function concreteNouns(prompt: string): string[] {
  const found = new Set<string>()
  for (const w of wordsOf(prompt)) {
    for (const cand of [w, w.replace(/ies$/, 'y'), w.replace(/es$/, ''), w.replace(/s$/, '')]) {
      if (CONCRETE_NOUNS.has(cand)) { found.add(cand); break }
    }
  }
  return [...found]
}

/** what is wrong with a picture description for a text-to-video model; an empty list means it is good to send */
export function promptIssues(prompt: string, opts?: { sacred?: boolean; style?: ClipStyle | null }): string[] {
  const issues: string[] = []
  const text = (prompt ?? '').trim()
  const n = wordsOf(text).length
  if (n < 40) issues.push(`too short (${n} words; 60 to 110 wanted)`)
  if (n > 140) issues.push(`too long (${n} words; 60 to 110 wanted)`)
  if (opts?.style === 'infographic') {
    // a flat infographic is judged on its own terms: icons and charts, no photographs, no readable words
    const flat = withoutNegations(text)
    const bannedFlat = INFO_BANNED.exec(flat)
    if (bannedFlat) issues.push(`banned content: "${bannedFlat[0]}" (no text, letters, numbers, logos or faces)`)
    const look = /\b(?:photograph\w*|cinematic|realistic|film\s+grain|dolly|lens|lantern\w*|candle\w*|lamplight)\b/i.exec(flat)
    if (look) issues.push(`wrong look: "${look[0]}" (the person asked for a flat 2D infographic, not a photographed scene)`)
    if (opts.sacred) {
      const fig = FIGURES.exec(flat)
      if (fig) issues.push(`banned content: "${fig[0]}" (religious subject: no people or figures)`)
    }
    return issues
  }
  const nouns = concreteNouns(text)
  for (const [re, name] of ABSTRACT_ALWAYS) if (re.test(text)) issues.push(`abstract language: "${name}"; name a physical object instead`)
  if (nouns.length < 3) for (const [re, name] of ABSTRACT_UNLESS_CONCRETE) if (re.test(text)) issues.push(`vague word without concrete objects: "${name}"`)
  if (nouns.length < 3) issues.push(`too few concrete objects (${nouns.length}; at least 3 named physical things wanted, such as books, lanterns, threads, glass, stone)`)
  const first = wordsOf(text).slice(0, 30).join(' ')
  if (nouns.length && !concreteNouns(first).length) issues.push('missing subject: open with the main physical object')
  if (!ACTION_CUE.test(text)) issues.push('missing action: say what visibly happens from the first frame to the last')
  if (!CAMERA_CUE.test(text)) issues.push('missing camera move')
  if (!LIGHT_CUE.test(text)) issues.push('missing light or time of day')
  const positive = withoutNegations(text)
  const banned = BANNED_CONTENT.exec(positive)
  if (banned) issues.push(`banned content: "${banned[0]}" (no text, letters, numbers, logos, interfaces, faces or people)`)
  if (opts?.sacred) {
    const fig = FIGURES.exec(positive)
    if (fig) issues.push(`banned content: "${fig[0]}" (religious subject: no people or figures)`)
  }
  return issues
}

const isBanned = (issues: string[]): boolean => issues.some((i) => i.startsWith('banned content'))

/**
 * One repair call when the picture description has problems. Never loops: if
 * the writer's second try still carries banned content, or the first has banned
 * content and there is no writer, `usedStock` is true and the caller uses its
 * stock prompt. Otherwise the best of the two is returned.
 */
export async function fixPrompt(inp: {
  chat: LLMProvider | null
  prompt: string
  /** the call counts as repaired from this many extra tries (always at most one) */
  sacred?: boolean
  /** the look the person asked for */
  style?: ClipStyle | null
  context?: string
  secrets?: string[]
  say?: (m: string) => void
}): Promise<{ prompt: string; usedStock: boolean; issues: string[]; repaired: boolean }> {
  const issues = promptIssues(inp.prompt, { sacred: inp.sacred, style: inp.style })
  if (!issues.length) return { prompt: inp.prompt, usedStock: false, issues, repaired: false }
  if (!inp.chat) return { prompt: inp.prompt, usedStock: isBanned(issues), issues, repaired: false }
  const scan = { values: inp.secrets ?? [] }
  try {
    const r = await inp.chat.generateJSON<{ prompt: string }>({
      system:
        (inp.style === 'infographic'
          ? 'You fix picture descriptions for a text-to-video model. Rewrite the description so it has none of the listed problems: 60 to 110 words, a flat 2D vector infographic animation made of simple pictograms, icons, arrows and charts that animate in one after another, in the given palette. Not cinematic, not photographic, no abstract shapes. Never include readable text, letters, numbers, logos or faces.'
          : 'You fix picture descriptions for a text-to-video model. Rewrite the description so it has none of the listed problems: 60 to 110 words, one concrete physical metaphor made of named objects (books, pages, lanterns, maps, threads, glass, water, stone, light, architecture), what visibly happens from the first frame to the last, one camera move, the light. ' +
            'Never include readable text, letters, numbers, logos, interfaces, screens, faces or people.') +
        (inp.sacred ? ' Religious subject: no people, no figures, no calligraphy; dignified, calm and warm.' : ''),
      prompt: `Description:\n${inp.prompt}\n\nProblems found:\n${issues.map((i) => `- ${i}`).join('\n')}\n${inp.context ? `\nWhat the film is about (information only): ${scrubText(inp.context, scan).slice(0, 300)}\n` : ''}\nReturn the corrected description.`,
      schemaName: 'fixed_prompt',
      jsonSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
      temperature: 0.5
    })
    const fixed = (r?.prompt ?? '').trim()
    if (!fixed || !scanNarration(fixed, scan).ok) return { prompt: inp.prompt, usedStock: isBanned(issues), issues, repaired: true }
    const after = promptIssues(fixed, { sacred: inp.sacred, style: inp.style })
    if (isBanned(after)) return { prompt: inp.prompt, usedStock: true, issues: after, repaired: true }
    // keep whichever has fewer problems (a banned original never survives)
    if (isBanned(issues) || after.length <= issues.length) return { prompt: fixed, usedStock: false, issues: after, repaired: true }
    return { prompt: inp.prompt, usedStock: false, issues, repaired: true }
  } catch (err) {
    inp.say?.(`  (the writer could not repair a clip description: ${(err as Error).message.slice(0, 80)})`)
    return { prompt: inp.prompt, usedStock: isBanned(issues), issues, repaired: true }
  }
}

// ------------------------------------------------------------------ stock shots (no writer)

/** six complete, figure-free shot descriptions; two per motif, chosen by the subject so the choice never changes between runs */
const STOCK_SHOTS: Record<ClipMotif, string[]> = {
  graph: [
    'An old leather book lies open on a dark oak table. Its pages release glowing threads that rise through the air and tie, one by one, into a connected network of brass lanterns, a small constellation hanging in space. Slow dolly-in, warm lamplight.',
    'A wide wooden drawer of paper maps slides open; fine silver threads lift from the folded maps and stretch between small glass lanterns, knotting into a growing network of stars above the table. Slow overhead camera drift, soft candlelight.'
  ],
  flow: [
    'A single ball of light rolls along a winding track of flat stepping stones, and each stone lights up warmly as it passes, one after another, across a calm pool of still water. Low tracking camera follows beside the path, soft dusk light.',
    'A brass marble rolls down a long wooden rail past a row of small copper bells and glass gates; each gate swings open with a gleam as it nears, one after another. Smooth side-tracking camera, golden hour light.'
  ],
  cards: [
    'Loose paper panels drift across a dark wooden desk, then slide and snap together edge to edge into a neat, orderly board, each panel catching the light as it clicks into place. Slow top-down camera pull-back, soft window light.',
    'Square glass tiles float above a stone floor, turn, and lock one by one into a tidy mosaic grid, each tile glowing softly as it settles. Slow overhead crane move, gentle daylight from a tall window.'
  ]
}

const stockSeed = (s: string): number => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)

const SACRED_TONE = 'Dignified, calm and warm. No depiction of people, prophets or religious figures, no calligraphy.'

const NO_TEXT_FLAT = 'No text, no letters, no numbers, no logos, no watermarks, no faces. Smooth, clean, continuous 2D motion.'

const NO_ABSTRACT_RULE =
  'The person said: NO abstract graphics. Every element is a concrete, recognisable thing (an icon of a document, a clock, a shield, a chart, a folder), never swirls, glowing lines, particles, energy or shapes that stand for nothing. '

/** what the picture writer is told when the person asked for infographic-style video */
const INFOGRAPHIC_RULES =
  'STYLE (the person asked for it, follow it exactly): a clean, flat 2D INFOGRAPHIC animation: simple pictograms and icons, charts, arrows, timelines, flows and step cards that animate in one after another, in the brand palette. NOT cinematic, NOT photographic, no real-world camera work, no lanterns, books or candles. ' +
  'Every icon stands for something real in the story (documents, a clock, a magnifying glass, a tangled pile of files, a checklist, a shield, a bar chart, a folder). ' +
  'FORBIDDEN, always: readable words, letters, numbers or logos (use icons and shapes only, charts with bars and lines but no figures), watermarks, photographs, faces. '

/** flat infographic shots for when there is no writer: two per part, chosen by the shot number */
const INFOGRAPHIC_SHOTS: Record<'problem' | 'solution' | 'general', string[]> = {
  problem: [
    'A flat 2D vector infographic animation on a clean canvas. A tangled stack of paper-document icons slides in from the left, a clock icon starts ticking beside it, and a magnifying-glass icon searches back and forth over the pile. Thin dashed arrows loop between the icons, then a red warning-triangle icon pops in, showing wasted time and confusion. Simple pictograms only, smooth animated motion graphics, locked frame, even flat light.',
    'A flat 2D vector infographic animation on a clean canvas. A row of folder icons fills up with document icons until a stack of them tips over; a stopwatch icon spins and a downward line chart slides in beside it, then a question-mark badge and a warning-triangle icon pop onto the stack. Simple pictograms only, smooth animated motion graphics, locked frame, even flat light.'
  ],
  solution: [
    'A flat 2D vector infographic animation on a clean canvas. A neat row of icons slides into place one after another: a checklist, a gear, a shield and a rising bar chart. Straight arrows connect them into one tidy left-to-right flow, the loose documents fold into a single folder icon, and a green check-mark badge pops on at the end. Simple pictograms only, smooth animated motion graphics, locked frame, even flat light.',
    'A flat 2D vector infographic animation on a clean canvas. A single search-bar icon slides in at the top, a magnifying glass sweeps across it and three clean result cards stack neatly below, each with a small pictogram. A line chart climbs steadily to the right and a green check-mark badge pops onto the last card. Simple pictograms only, smooth animated motion graphics, locked frame, even flat light.'
  ],
  general: [
    'A flat 2D vector infographic animation on a clean canvas. Three connected step cards slide in one after another, each with a simple pictogram: a browser window, a gear and a bar chart. Arrows draw between the cards, small progress bars fill, and a check-mark badge pops onto the last card. Smooth animated motion graphics, locked frame, even flat light.',
    'A flat 2D vector infographic animation on a clean canvas. A timeline line draws from left to right with four round markers; as each marker lights up, a pictogram pops above it: a document, a magnifying glass, a shield and a trophy. Smooth animated motion graphics, locked frame, even flat light.'
  ]
}

/** the shot description used when there is no writer (or the writer failed): deterministic from motif, placement and subject */
function fallbackPrompt(subject: string, placement: Placement, careful: boolean, brand?: ClipBrand, motif?: ClipMotif, opts: { style?: ClipStyle | null; edge?: boolean; part?: 'problem' | 'solution'; shot?: number } = {}): string {
  const s = subject.replace(/[.!?]+$/, '')
  if (opts.style === 'infographic') {
    const set = INFOGRAPHIC_SHOTS[opts.part ?? 'general']
    const shot = set[(opts.shot ?? 0) % set.length]
    const k = clipLook(placement, brand, motif)
    return [opts.part ? '' : `An infographic about ${s}.`, shot, careful ? SACRED_TONE : '', k.palette, opts.edge === false ? '' : k.continuity, NO_TEXT_FLAT].filter(Boolean).join(' ')
  }
  const frame =
    placement === 'start' ? `An elegant, welcoming opening sequence that introduces ${s}.`
    : placement === 'end' ? `A calm, uplifting closing sequence that leaves a lasting impression of ${s}.`
    : `A cinematic shot that illustrates ${s}.`
  const m: ClipMotif = motif ?? (['graph', 'flow', 'cards'] as const)[(stockSeed(s) >>> 3) % 3]
  const shots = STOCK_SHOTS[m]
  const shot = shots[(stockSeed(s) + (placement === 'start' ? 0 : placement === 'end' ? 1 : 0)) % shots.length]
  const k = clipLook(placement, brand, motif)
  return [frame, shot, careful ? SACRED_TONE : '', k.palette, k.continuity, NO_TEXT].filter(Boolean).join(' ')
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
  /** the brand's colours, put into every picture prompt in words and hex (accent and backdrop as hex, # optional) */
  brand?: { accent?: string; backdrop?: [string, string] }
  /** what the imagery echoes: points joining into a network, a line through stages, or panels assembling */
  motif?: 'graph' | 'flow' | 'cards'
  /** spoken lines already written as part of the film's story; a clip with a line here is not asked of the writer */
  lines?: { start?: string; middle?: string; end?: string }
  /** plain statements of what the app does and what the video shows (page titles, feature descriptions, the steps reduced to actions); the writer builds its metaphor from them */
  facts?: string[]
  /** a few words on the kind of product or idea (for example "a knowledge graph of Quran topics"), to help the writer choose the metaphor */
  subjectHint?: string
  /** the look the person asked for ("infographic styled video") */
  style?: ClipStyle | null
  /** the person said no abstract graphics */
  noAbstract?: boolean
  say: (m: string) => void
}

const WRITER_RULES =
  'Picture descriptions are storyboards for a text-to-video model. Concrete physical objects, materials and motion are REQUIRED: for example books, pages, lanterns, maps, threads, glass, water, light, architecture, mechanisms that work by themselves. ' +
  'Choose ONE specific, filmable metaphor for the idea out of named objects (never "energy", "flow", "particles" or "glowing lines" on their own), and make it illustrate what the app actually does, using the facts you are given. ' +
  'FORBIDDEN, always: any readable text, letters, numbers, UI screenshots, interfaces, logos, watermarks, and faces or recognisable people. '

const SACRED_RULES =
  'This film is about a religious subject: no people, no figures, no calligraphy or script, no religious sites\' interiors with worshippers. Dignified, calm, warm. Concrete objects such as an open book of blank pages, lamps, a geometric lattice, light through a window, a growing constellation are good. '

/** the longest single clip: a part that should last longer is chained from several clips */
export const SEGMENT_MAX_SEC = 8
/** most clips one film may have (each second costs money) */
export const MAX_SEGMENTS = 8

interface Want {
  subject: string
  placement: Placement
  said: string
  auto: boolean
  part?: 'problem' | 'solution'
  /** how long this clip lasts (absent = the engine's default for the film) */
  seconds?: number
  /** which clip of a chained part this is (0-based) and how many there are */
  shot?: number
  shots?: number
}

/** one request is one clip, or several chained clips when it is asked to last longer than a single clip can */
export function expandRequests(requests: MediaRequest[], topic: string, scrub: (t: string) => string): Want[] {
  const out: Want[] = []
  let plain = 0
  for (const r of requests) {
    const subject = r.part ? `${r.subject}${topic ? ` (the film is about: ${topic})` : ''}` : r.generic ? topic : scrub(r.subject)
    if (!r.seconds) {
      if (plain++ >= MAX_CLIPS) continue
      out.push({ subject, placement: r.placement, said: r.said, auto: false, ...(r.part ? { part: r.part } : {}) })
      continue
    }
    const shots = Math.max(1, Math.ceil(r.seconds / SEGMENT_MAX_SEC))
    const each = Math.max(3, Math.min(10, Math.round(r.seconds / shots)))
    for (let i = 0; i < shots; i++) {
      out.push({
        subject: shots > 1 ? `${subject} - shot ${i + 1} of ${shots}${i ? ', continuing the same sequence with the same icons and look' : ''}` : subject,
        placement: r.placement,
        said: r.said,
        auto: false,
        seconds: each,
        shot: i,
        shots,
        ...(r.part ? { part: r.part } : {})
      })
    }
  }
  return out.slice(0, MAX_SEGMENTS)
}

/** decides what each clip shows and says; the person's own sentences come first */
export async function planMedia(inp: PlanMediaInput): Promise<PlannedClip[]> {
  const scan = { values: inp.secrets }
  const topic = scrubText(inp.topic ?? '', scan).slice(0, 240).trim() || inp.appName
  const style = inp.style ?? null
  const wants: Want[] = expandRequests(inp.requests, topic, (t) => scrubText(t, scan))
  if (!wants.length && inp.auto) {
    const goal = scrubText(inp.context, scan).slice(0, 300).trim()
    wants.push({ subject: goal ? `the idea behind ${goal}` : `what ${inp.appName} does, in a simple flow`, placement: 'start', said: 'Automatic opening clip (AI clips are switched on)', auto: true })
  }
  const stockLine = (w: Want) =>
    w.shot ? ''
    : w.part === 'problem' ? 'Here is the problem so many people run into.'
    : w.part === 'solution' ? 'And here is how it gets solved.'
    : w.auto ? 'Here is how it works, at a glance.'
    : w.placement === 'end' ? 'And that is the whole journey, in a moment.'
    : 'Here is the idea, in motion.'
  const given = (pl: Placement): string | undefined => {
    const t = inp.lines?.[pl]?.trim()
    return t && t.length >= 8 && scanNarration(t, scan).ok ? t : undefined
  }
  const careful = SACRED.test(`${topic} ${inp.context}`)
  const picked = wants
  // where a clip meets the title scene (the last opening clip, the first closing one) it settles into / builds from a calm empty field; the others carry straight on
  const places = picked.map((w) => w.placement)
  const edge = (i: number): boolean => (picked[i].placement === 'start' ? i === places.lastIndexOf('start') : picked[i].placement === 'end' ? i === places.indexOf('end') : true)
  // the written opening line goes to the first clip of its place only
  const givenFor = (i: number): string | undefined => (places.indexOf(picked[i].placement) === i ? given(picked[i].placement) : undefined)
  const base: PlannedClip[] = picked.map((w, i) => ({
    prompt: fallbackPrompt(w.subject, w.placement, careful, inp.brand, inp.motif, { style, edge: edge(i), part: w.part, shot: w.shot ?? 0 }),
    line: givenFor(i) ?? stockLine(w),
    placement: w.placement,
    said: w.said,
    auto: w.auto,
    ...(w.seconds ? { seconds: w.seconds } : {})
  }))
  if (!inp.chat || !base.length) return base
  try {
    const palette = clipLook('middle', inp.brand, inp.motif).palette
    const facts = scrubText((inp.facts ?? []).map((f) => `- ${f.replace(/\s+/g, ' ').trim()}`).filter((f) => f.length > 2).join('\n'), scan).slice(0, 900).trim()
    const hint = scrubText(inp.subjectHint ?? '', scan).slice(0, 200).trim()
    const example = style === 'infographic' ? INFOGRAPHIC_SHOTS.general[0] : STOCK_SHOTS[inp.motif ?? 'graph'][0]
    const noAbstract = inp.noAbstract || style === 'infographic' ? NO_ABSTRACT_RULE : ''
    const r = await inp.chat.generateJSON<{ clips: Array<{ n: number; metaphor?: string; action?: string; camera?: string; light?: string; prompt: string; line?: string }> }>({
      system:
        'You direct short AI-generated cutaway clips for a product video. For each clip you write a small storyboard for a text-to-video model, and (unless it is already written) one line of narration to be spoken over it. ' +
        (style === 'infographic' ? INFOGRAPHIC_RULES : WRITER_RULES) +
        noAbstract +
        (style === 'infographic'
          ? 'Per clip return: "metaphor" (the one set of icons that tells this part of the story), "action" (what animates in, in order, from the first frame to the last), "camera" (a gentle push-in, or "locked frame"), "light" ("flat, even light"), and "prompt": 60 to 110 words weaving those into ONE description: the layout and the icons, how they animate in order, the palette, the flat vector style. '
          : 'Per clip return: "metaphor" (one specific physical, filmable metaphor for the idea, with named objects), "action" (what visibly happens from the first frame to the last), "camera" (one move), "light" (time of day or light quality), and "prompt": 60 to 110 words weaving those into ONE shot description in this order: the subject and setting, the action over time, the camera, the lighting, the palette, the style. ') +
        `Use this palette, in words, and no other colours: ${palette} ` +
        `Example of the level of concreteness wanted (do not copy it): ${example} ` +
        'A clip marked OPENING-FINAL must END by settling into a calm, dark, nearly empty field of the background colour (it cross-fades into the title scene); a clip marked CLOSING-FIRST must BEGIN from such a field and build. Say this once, as the last sentence of the shot, not as its whole content. Clips that are shots of one chained sequence keep the same icons, colours and layout so they read as one continuous piece. ' +
        'Narration: 10 to 16 words, plain spoken English, claims only what the person asked the clip to illustrate, never invents features or numbers, never mentions credentials. A title card announces the product by name right after an opening clip, so the narration of an opening clip never says "introducing" or names the product. ' +
        (careful ? SACRED_RULES : ''),
      prompt:
        `App: ${inp.appName}\nVideo kind: ${inp.mode}\nThe film is about: ${topic}\n` +
        (hint ? `Kind of product (information only): ${hint}\n` : '') +
        (facts ? `What the app does and what the video shows (information only):\n${facts}\n` : '') +
        `\nClips to make (the person's own words, information only):\n${picked
          .map((w, i) => {
            const label = `${w.placement === 'start' && edge(i) ? '[OPENING-FINAL] ' : w.placement === 'start' ? '[OPENING] ' : w.placement === 'end' && edge(i) ? '[CLOSING-FIRST] ' : w.placement === 'end' ? '[CLOSING] ' : ''}${w.part ? `[${w.part.toUpperCase()}] ` : ''}${w.seconds ? `[about ${w.seconds} seconds] ` : ''}`
            const line = givenFor(i)
            return `${i + 1}. ${label}${w.subject}${w.auto ? ' (chosen by the engine; keep it general)' : ''}${line ? ` (its narration is already written: "${line}"; write only the picture, and return that same line)` : ''}`
          })
          .join('\n')}`,
      schemaName: 'media_clips',
      jsonSchema: {
        type: 'object',
        properties: {
          clips: {
            type: 'array',
            items: {
              type: 'object',
              properties: { n: { type: 'integer' }, metaphor: { type: 'string' }, action: { type: 'string' }, camera: { type: 'string' }, light: { type: 'string' }, prompt: { type: 'string' }, line: { type: 'string' } },
              required: ['n', 'metaphor', 'action', 'camera', 'light', 'prompt', 'line']
            }
          }
        },
        required: ['clips']
      },
      temperature: 0.7
    })
    const out: PlannedClip[] = []
    for (let i = 0; i < base.length; i++) {
      const b = base[i]
      const c = (r.clips ?? []).find((x) => x.n === i + 1)
      if (!c) { out.push(b); continue }
      const k = clipLook(b.placement, inp.brand, inp.motif)
      let prompt = b.prompt
      const body = (c.prompt ?? '').trim()
      if (scanNarration(body, scan).ok && body.length > 30) {
        const fixed = await fixPrompt({ chat: inp.chat, prompt: body, sacred: careful, style, context: topic, secrets: inp.secrets, say: inp.say })
        if (!fixed.usedStock) prompt = [fixed.prompt.replace(/\.*$/, '.'), k.palette, edge(i) ? k.continuity : '', style === 'infographic' ? NO_TEXT_FLAT : NO_TEXT].filter(Boolean).join(' ')
      }
      const cl = (c.line ?? '').trim()
      const line = givenFor(i) ?? (scanNarration(cl, scan).ok && cl.length > 8 ? cl : b.line)
      out.push({ ...b, prompt, line })
    }
    return out
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
  /** "low volume": the track sits well under the voice */
  quiet: boolean
}

const LOW_VOLUME = /\b(?:low[-\s]?volum\w*|low[-\s]?level|quiet(?:ly|er)?|soft(?:ly|er)?|subtle|faint(?:ly)?|barely\s+audible|in\s+the\s+background|very\s+low)\b/i

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
      const quiet = LOW_VOLUME.test(said)
      if (!sounds.length && !noInstruments && !none) continue
      const prev: MusicAsk | null = found
      const all: string[] = [...new Set([...(prev?.sounds ?? []), ...sounds])]
      // "natural" alone is only a hint; specific sounds replace it
      const specific: string[] = all.filter((x) => x !== 'natural ambience')
      found = { said: said.slice(0, 300), sounds: specific.length ? specific : all, noInstruments: (prev?.noInstruments ?? false) || noInstruments, none: (prev?.none ?? false) || none, quiet: (prev?.quiet ?? false) || quiet }
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
  if (isStyleSentence(s) || isDurationSentence(s)) return true
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
