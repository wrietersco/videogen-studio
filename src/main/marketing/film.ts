import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderScene, pickMotif, type Motif } from '../appRecon/scenes'
import { voiceLine, neutralProblemTitle, problemLineOk } from '../appRecon/narrate'
import { chooseMusic, clipLook, fixPrompt, promptIssues, clipSeconds, withStyle, type MusicChoice } from '../appRecon/aiMedia'
import type { MediaTools } from '../appRecon/run'
import { scanNarration } from '../appRecon/detect'
import { readSec } from '../appRecon/produce'
import { musicBrief } from '../audio/cue'
import { musicPrompt } from '../appRecon/agent/musicBrief'
import { decodeStereo, SR } from '../audio/pcm'
import type { VideoSpec } from '@shared/spec'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import type { BusinessProfile, MarketStage, VideoCard } from '@shared/marketing'
import type { JobAssignment } from '@shared/agentBrief'
import type { MadePart, MarketPlan, Show } from '@shared/marketBrief'
import { assemble, type FilmPiece, type PieceShot } from './assemble'
import { iconFor, type IconName } from './overlays'
import { planFromCard } from './agent/brief'
import { directIntro } from './agent/intro'
import { designFilmBackgrounds } from '../introBg/film'
import { IntroBackgroundLibrary } from '../introBg/library'
import { introBackgroundsDir } from '../paths'
import { renderProductScene, type ProductEntrance } from './productScene'
import { filmFrame } from '@shared/shapes'
import { reusedVoice, usableShots, voiceFileOf, writeFilmRecord, type FilmReuse, type FilmVoiceRecord } from './filmRecord'

/**
 * One card's film, made with the record-an-app engine minus the recording:
 * a problem scene (or AI clip), a run of value beats (each an AI clip, an AI
 * picture or an animated point), and a closing card — voice, music and
 * captions throughout.
 *
 * The film follows a MarketPlan: what the person's brief asked each part to
 * say and how to show it. With no plan, the card alone is the plan and the
 * engine chooses the elements itself. Nothing is asked once the button is
 * pressed; what was asked for and what was made is returned so it can be
 * checked and reported.
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
  /** where AI-designed scene backgrounds are kept for later films (default: the app's intro-backgrounds folder; null = not kept) */
  introLibrary?: IntroBackgroundLibrary | null
  speech: SpeechProvider | null
  /** the AI clip, picture and music models; null = the free engine (scenes, captions, built-in score) */
  tools: MediaTools | null
  /** AI music was asked for (the plan allows it or the person ticked it) */
  aiMusic: boolean
  /** the most AI clips the account may put in one film */
  maxClips: number
  /** what the person's brief asked for (absent = the card alone) */
  plan?: MarketPlan
  /** the model chosen for each job after the person's answers ('none' = that job is off) */
  assignment?: JobAssignment
  signal?: AbortSignal
  progress: (stage: MarketStage, message: string) => void
  log?: (m: string) => void
  /** a revision: the parts of an earlier film to use again (its script, voice lines, pictures, music and caption look) */
  reuse?: FilmReuse
}

export interface FilmResult {
  file: string
  durationSec: number
  /** what the engine chose, shown under the card */
  notes: string[]
  elements: string[]
  /** what each part of the film asked for and what it got, for the review */
  made: MadePart[]
  /** the plan's points left out to keep the film near the length asked */
  dropped: string[]
  musicSource: 'ai' | 'builtin' | 'none'
  musicModel?: string
  /** a voice spoke the lines */
  voiced: boolean
  /** the AI writer wrote the script (not the plan's own words) */
  written: boolean
  /** a revision: what came from the earlier film */
  reused?: { voices: number; parts: string[]; music: boolean }
}

interface Beat {
  /** words on the point scene, 3 to 6 words */
  headline: string
  /** what is said */
  line: string
  /** chip label, 2 to 4 words */
  chapter: string
  /** the plan point this beat carries */
  pointId?: string
  /** what the shot should look like, when the person described it */
  visual?: string
}

interface Script {
  /** the trouble, in 2 to 4 words on the problem card */
  problemHeadline: string
  /** the trouble, spoken */
  problemLine: string
  beats: Beat[]
  /** the last words: the business and the next step */
  close: string
  /** the opening line shown big in the first seconds (3 to 7 words) */
  hook?: string
}

type Kind = 'scene' | 'still' | 'clip'

const NO_TEXT = 'No text, no letters, no logos, no watermarks, no faces. Smooth, slow, continuous motion.'
/** the one branded shot: the business's own logo, from its reference picture, on its own packaging, and nothing else written */
const BRAND_ONLY = "The only lettering anywhere is the business's own logo, copied exactly from the logo reference picture, printed on the product's box, bag, sticker or label. No other text, no watermarks, no close-up faces."

/** what a beat shows of the business's own products: the product's name, its own photos and one benefit line */
export interface BeatProduct {
  name: string
  images: string[]
  benefit?: string
}

const nameWords = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !/^(the|and|with|for|our|your|from)$/.test(w))

/**
 * Which of the business's own pictures each beat shows. A beat that names a
 * service shows that service's photos; otherwise the card's own service; then
 * the business's general product photos. Photos are shared out so the same
 * one is shown at most twice in a film.
 */
export function productPicker(p: BusinessProfile, card: VideoCard): { any: boolean; forBeat: (text: string) => BeatProduct | null } {
  const real = (list?: string[]): string[] => (list ?? []).filter((f) => existsSync(f))
  const services = p.services.map((sv) => ({ sv, images: real(sv.images) }))
  const general = real(p.brand.productImages)
  const uses = new Map<string, number>()
  const any = general.length > 0 || services.some((x) => x.images.length > 0)
  const take = (list: string[], n: number): string[] => {
    const ok = [...new Set(list)].filter((f) => (uses.get(f) ?? 0) < 2).sort((a, b) => (uses.get(a) ?? 0) - (uses.get(b) ?? 0))
    const got = ok.slice(0, n)
    for (const f of got) uses.set(f, (uses.get(f) ?? 0) + 1)
    return got
  }
  const forBeat = (text: string): BeatProduct | null => {
    if (!any) return null
    const t = new Set(nameWords(text))
    const named = services.find((x) => {
      const w = nameWords(x.sv.name)
      return x.images.length > 0 && w.length > 0 && w.filter((y) => t.has(y)).length / w.length >= 0.5
    })
    const own = card.serviceIdx !== undefined ? services[card.serviceIdx] : undefined
    for (const pick of [named, own && own.images.length ? own : undefined]) {
      if (!pick) continue
      const images = take([...pick.images, ...general], 3)
      if (images.length) return { name: pick.sv.name, images, benefit: pick.sv.benefits[0] }
    }
    const images = take([...general, ...services.flatMap((x) => x.images)], 3)
    if (!images.length) return null
    const sv = own?.sv ?? services.find((x) => x.images.includes(images[0]))?.sv
    return { name: sv?.name ?? p.name, images, benefit: sv?.benefits[0] }
  }
  return { any, forBeat }
}
const clean = (s: string, max: number): string => s.replace(/\s+/g, ' ').trim().slice(0, max)

const stemOf = (w: string): string => (w.length > 5 ? w.replace(/(?:ing|ed|es|s)$/, '') : w)
const tokensOf = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3).map(stemOf)
/** how much of `want` (its meaningful words) appears in `got` */
export function coverage(want: string, got: string): number {
  const w = tokensOf(want)
  if (!w.length) return 1
  const g = new Set(tokensOf(got))
  return w.filter((x) => g.has(x)).length / w.length
}
/** the first thing the person said not to mention that this text mentions, if any */
export function avoidHit(text: string, avoid: string[]): string | undefined {
  const t = text.toLowerCase()
  return avoid.find((a) => {
    const w = a.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim()
    if (w.length < 3) return false
    return t.includes(w) || (tokensOf(w).length > 0 && tokensOf(w).every((x) => tokensOf(t).includes(x)))
  })
}

const sentenceCase = (s: string): string => (s.endsWith('.') || s.endsWith('!') || s.endsWith('?') ? s : `${s}.`)

/** the script the rules alone can write, straight from the plan */
function stockScript(card: VideoCard, p: BusinessProfile, plan: MarketPlan, max: number): Script {
  const beats: Beat[] = plan.points.slice(0, max).map((pt, i) => ({ headline: clean(headlineOf(pt.say), 40) || (i === 0 ? 'The fix' : 'What you get'), line: clean(sentenceCase(pt.say), 220), chapter: i === 0 ? 'The fix' : 'What you get', pointId: pt.id, ...(pt.visual ? { visual: pt.visual } : {}) }))
  while (beats.length < 2) beats.push({ headline: beats.length === 0 ? 'The fix' : 'What you get', line: beats.length === 0 ? clean(card.solution, 220) : `With ${p.name}, ${p.tagline.toLowerCase()}.`, chapter: beats.length === 0 ? 'The fix' : 'What you get' })
  return {
    problemHeadline: neutralProblemTitle(`${plan.problem.say} ${card.title}`),
    problemLine: plan.source === 'card' ? clean(plan.problem.say, 300) : shortenTo(clean(plan.problem.say, 300), wordBudget(plan.targetSec ?? card.targetSec, beats.length, true).problemMax),
    beats,
    close: clean(plan.close.say || `${p.name}. ${plan.close.cta}.`, 160),
    hook: neutralProblemTitle(`${plan.problem.say} ${card.title}`)
  }
}

/**
 * A trouble headline any business can use: short, never the business's name,
 * never the answer in other words. The record-an-app check also wants
 * software trouble words ("hard to find", "too slow"), which threw away a
 * bakery's "Dry, bland cookies" and put "Too much, too scattered" in its film.
 */
export function marketTitleOk(title: string, solution: string, business: string): boolean {
  const t = title.trim()
  if (t.length < 4 || t.length > 30) return false
  if (business.trim().length >= 3 && t.toLowerCase().includes(business.trim().toLowerCase())) return false
  const sig = (x: string) => x.toLowerCase().split(/[^a-z0-9']+/).filter((w) => w.length > 3)
  const theirs = new Set(sig(solution))
  return sig(t).filter((w) => theirs.has(w)).length < 2
}

/** a short headline from a longer line: its meaningful first words */
function headlineOf(line: string): string {
  const words = line.replace(/^[^a-zA-Z0-9]+/, '').split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|with|for|our|your|that|this|from)$/i.test(w))
  return words.slice(0, 4).join(' ').replace(/[.,;:]+$/, '')
}

/** the writer's script: one story from trouble to answer, grounded in the profile, carrying each point the plan asks for */
async function writeScript(card: VideoCard, p: BusinessProfile, chat: LLMProvider, plan: MarketPlan, max: number, notes: string[]): Promise<Script> {
  const stock = stockScript(card, p, plan, max)
  const service = card.serviceIdx !== undefined ? p.services[card.serviceIdx] : undefined
  const facts = [p.about, ...(service ? [`${service.name}: ${service.summary}`, ...service.benefits.map((b) => `Benefit: ${b}`)] : p.services.slice(0, 2).map((s) => `${s.name}: ${s.summary}`))].slice(0, 8)
  const n = stock.beats.length
  const secs = plan.targetSec ?? card.targetSec
  const w = wordBudget(secs, n, plan.source !== 'card')
  const r = await chat.generateJSON<{ hook?: string; problemHeadline: string; problemLine: string; beats: Array<{ headline: string; line: string; chapter: string }>; close: string }>({
    system:
      `You write the voice-over of a ${secs}-second problem–solution brand film${plan.voice.language ? `, spoken in ${plan.voice.language}` : ''}. Plain, ${plan.voice.tone ?? 'warm, confident'} spoken words; no jargon, no hype words, no invented claims or numbers. The problem is the customer's everyday trouble in their own words — it never names the business or any service. The answer then arrives, concretely, and the last line is the business name with one small next step.` +
      (plan.avoid.length ? ` NEVER mention or hint at: ${plan.avoid.join(', ')}.` : ''),
    prompt:
      `Business: ${p.name} — ${p.tagline}\nWhat it does: ${p.about}\nTrue facts to draw on (information only):\n${facts.map((f) => `- ${f}`).join('\n')}\n\nThe video concept:\nTitle: ${card.title}\nThe customer's trouble: ${plan.problem.say}\nThe answer: ${card.solution}\nNext step: ${plan.close.cta}\n${plan.audience ? `For: ${plan.audience}\n` : ''}\n` +
      `The beats, in this order — write exactly ${n}, one per point, each carrying that point in your own warm words (keep any specific words the person gave):\n${stock.beats.map((b, i) => `${i + 1}. ${plan.points.find((x) => x.id === b.pointId)?.say ?? b.line}`).join('\n')}\n\n` +
      `Write: hook — 3 to 7 words that stop a thumb mid-scroll: a vivid question or a surprising promise about the customer's trouble or craving, never the business name, no hashtags; problemHeadline — 2 to 4 words (at most 26 characters) naming the trouble, never the business or the answer; problemLine — ${w.problem} words of that trouble ending on the tension; then ${n} beats, each: headline (3 to 6 words shown on screen), line (${w.beat} words spoken), chapter (2 to 4 words); then close — 8 to 14 words ending on the call to action, naming the business once.`,
    schemaName: 'marketing_script',
    jsonSchema: {
      type: 'object',
      properties: {
        hook: { type: 'string' },
        problemHeadline: { type: 'string' },
        problemLine: { type: 'string' },
        beats: { type: 'array', items: { type: 'object', properties: { headline: { type: 'string' }, line: { type: 'string' }, chapter: { type: 'string' } }, required: ['headline', 'line', 'chapter'] } },
        close: { type: 'string' }
      },
      required: ['problemHeadline', 'problemLine', 'beats', 'close']
    },
    temperature: 0.6,
    maxTokens: 1200
  })
  const check = { values: [] as string[] }
  const hit = (t: string) => avoidHit(t, plan.avoid)
  let headline = clean(r.problemHeadline, 30).replace(/[.!?:]+$/, '')
  if (!headline || hit(headline) || !scanNarration(headline, check).ok || !marketTitleOk(headline, card.solution, p.name)) headline = stock.problemHeadline
  let problemLine = clean(r.problemLine, 320)
  if (hit(problemLine) || !problemLineOk(problemLine, card.solution, p.name) || !scanNarration(problemLine, check).ok) problemLine = stock.problemLine
  // a beat the writer got wrong is replaced by the plan's own words BEFORE any voice is paid for
  const beats: Beat[] = stock.beats.map((own, i) => {
    const w = r.beats?.[i]
    const pt = plan.points.find((x) => x.id === own.pointId)
    const b: Beat = { headline: clean(w?.headline ?? '', 60), line: clean(w?.line ?? '', 240), chapter: clean(w?.chapter ?? '', 30), pointId: own.pointId, ...(own.visual ? { visual: own.visual } : {}) }
    if (!b.headline || !b.line || !scanNarration(b.line, check).ok) return own
    const bad = hit(`${b.headline} ${b.line}`)
    if (bad) { notes.push(`A line mentioned "${bad}", which you asked not to mention, so the plain wording is used.`); return own }
    if (pt?.said && coverage(pt.say, b.line) < 0.4) { notes.push(`A line drifted from "${clean(pt.say, 60)}", so your own wording is used for it.`); return own }
    return { ...b, chapter: b.chapter || own.chapter }
  })
  let close = clean(r.close, 180)
  if (!close || hit(close) || !scanNarration(close, check).ok) close = stock.close
  let hook = clean(r.hook ?? '', 70).replace(/[#@]/g, '')
  if (!hook || hit(hook) || !scanNarration(hook, check).ok || hook.split(' ').length > 9) hook = stock.hook ?? ''
  return { hook, problemHeadline: headline, problemLine: plan.source === 'card' ? problemLine : shortenTo(problemLine, w.problemMax), beats, close }
}

/** how many words each spoken part may have so the film lands near the length asked (a card with no brief keeps the usual ranges) */
export function wordBudget(targetSec: number, beats: number, fitted: boolean): { problem: string; beat: string; problemMax: number } {
  if (!fitted) return { problem: '20 to 32', beat: '14 to 22', problemMax: 400 }
  // about 2.5 spoken words a second; the closing line and the pauses between parts take about 7 seconds
  const total = Math.max(30, (targetSec - 7) * 2.5)
  const problemMax = Math.round(Math.min(32, Math.max(10, total * 0.3)))
  const beat = Math.round(Math.min(22, Math.max(8, (total - problemMax) / Math.max(1, beats))))
  return { problem: `${Math.max(8, problemMax - 4)} to ${problemMax}`, beat: `${Math.max(6, beat - 3)} to ${beat}`, problemMax }
}

/** the first sentences of a line that fit in `max` words (the whole line when it already fits) */
export function shortenTo(line: string, max: number): string {
  if (line.split(/\s+/).length <= max * 1.3) return line
  let out = ''
  for (const s of line.split(/(?<=[.!?])\s+/)) {
    if (out && (out + ' ' + s).split(/\s+/).length > max * 1.2) break
    out = out ? `${out} ${s}` : s
  }
  return out || line
}

/** roughly how long a spoken line lasts on the film's clock */
const lineSec = (t: string): number => Math.max(4.2, readSec(t) + 1.5)

/** drop the plan's nice-to-have points, last first, until the film is near the length asked */
export function fitBeats(script: Script, plan: MarketPlan, targetSec: number): { script: Script; dropped: string[] } {
  const beats = [...script.beats]
  const dropped: string[] = []
  const est = () => lineSec(script.problemLine) + beats.reduce((s, b) => s + lineSec(b.line), 0) + lineSec(script.close) + 0.8
  while (beats.length > 2 && est() > targetSec * 1.25) {
    let at = -1
    for (let i = beats.length - 1; i >= 0; i--) if (!plan.points.find((x) => x.id === beats[i].pointId)?.required) { at = i; break }
    if (at < 0) break
    dropped.push(beats[at].pointId ?? beats[at].headline)
    beats.splice(at, 1)
  }
  return { script: { ...script, beats }, dropped }
}

/** which element tells each part: what the person asked for first, then the engine's own choice for the rest */
export function chooseElements(
  beats: Beat[],
  plan: MarketPlan,
  opts: { tools: MediaTools | null; maxClips: number; noClips: boolean }
): { problem: 'clip' | 'scene'; kinds: Kind[]; why: Map<string, string> } {
  const why = new Map<string, string>()
  const canClip = !!opts.tools?.clip && !opts.noClips && opts.maxClips > 0
  let clips = 0
  const clipReason = (): string => (!opts.tools?.clip ? 'AI video clips are not available on this account' : opts.noClips ? 'you chose drawn scenes instead of AI clips' : 'your plan allows no more AI clips in one film')
  const wantOf = (b: Beat): Show => plan.points.find((x) => x.id === b.pointId)?.show ?? 'any'
  // 1. the problem, if the person asked for it as a clip
  let problem: 'clip' | 'scene' = 'scene'
  if (plan.problem.show === 'clip') {
    if (canClip && clips < opts.maxClips) { problem = 'clip'; clips++ } else why.set('problem', clipReason())
  }
  // 2. what the person asked for outright
  const kinds: Array<Kind | null> = beats.map((b) => {
    const w = wantOf(b)
    if (w === 'clip') {
      if (canClip && clips < opts.maxClips) { clips++; return 'clip' }
      why.set(b.pointId ?? b.headline, clipReason())
      return opts.tools?.still ? 'still' : 'scene'
    }
    if (w === 'image') {
      if (opts.tools?.still) return 'still'
      why.set(b.pointId ?? b.headline, 'AI pictures are not available on this account')
      return 'scene'
    }
    if (w === 'scene') return 'scene'
    return null
  })
  // 3. the engine's own choice for the rest
  if (opts.tools) {
    const CLIP_WORDS = /process|workflow|pipeline|build|create|craft|design|deliver|manage|connect|integrate|automat|install|repair|clean|train|coach|produce|ship|grow|plan|organize|organise|run\b/i
    // with pictures available a beat is told in photographs, never an abstract motif card
    const room = (k: Kind): boolean => (k === 'clip' ? canClip && clips < opts.maxClips : k === 'still' ? !!opts.tools?.still : true)
    beats.forEach((b, i) => {
      if (kinds[i] !== null) return
      const t = `${b.headline} ${b.line}`
      const prev = kinds[i - 1] ?? undefined
      let kind: Kind
      if (room('clip') && CLIP_WORDS.test(t) && prev !== 'clip') kind = 'clip'
      else kind = room('still') ? 'still' : 'scene'
      if (kind === 'clip') clips++
      kinds[i] = kind
    })
  }
  return { problem, kinds: kinds.map((k) => k ?? 'scene'), why }
}

/** a picture prompt built without a writer: the beat told as one slow physical shot */
function stockClipPrompt(beat: Beat, brand: { accent?: string; backdrop?: [string, string] }, motif: Motif): string {
  const look = clipLook('middle', brand, motif)
  const what = beat.visual ? beat.visual.replace(/\.$/, '') : `${beat.line.replace(/\.$/, '')}, shown as a real physical scene with concrete objects and materials`
  return [`One slow, continuous shot: ${what}.`, 'Slow, smooth camera move forward. Soft, even light.', look.palette, look.motif, NO_TEXT].filter(Boolean).join(' ')
}

/** the writer's storyboards for the clips: concrete, filmable, brand-coloured */
async function writeClipPrompts(beats: Beat[], kinds: Kind[], card: VideoCard, p: BusinessProfile, chat: LLMProvider, brand: { accent?: string; backdrop?: [string, string] }, motif: Motif, style: string | null, say: (m: string) => void): Promise<Map<number, string>> {
  const idx = beats.map((_, i) => i).filter((i) => kinds[i] === 'clip')
  const out = new Map<number, string>()
  for (const i of idx) out.set(i, stockClipPrompt(beats[i], brand, motif))
  if (!idx.length) return out
  try {
    const look = clipLook('middle', brand, motif)
    const r = await chat.generateJSON<{ shots: Array<{ n: number; prompt: string }> }>({
      system:
        'You direct short AI-generated cutaway clips for a brand film. Each shot is a storyboard for a text-to-video model: ONE specific physical, filmable metaphor with named objects (never "energy", "flow" or "glowing lines" alone) that illustrates the sentence it accompanies. FORBIDDEN, always: readable text, letters, numbers, interfaces, logos, watermarks, faces or recognisable people. ' +
        (style === 'infographic' ? 'The look is an animated INFOGRAPHIC: clean flat shapes, icons and simple diagrams in motion, with no readable words. ' : '') +
        `Use this palette and no other: ${look.palette} ` +
        'Return "prompt": 60 to 100 words, in this order: subject and setting, the action over time, one camera move, the lighting, the palette, the style.',
      prompt:
        `Business: ${p.name} — ${p.tagline}\nClips to make (each illustrates its sentence):\n${idx.map((i) => `${i + 1}. ${beats[i].line}${beats[i].visual ? ` (the person described the shot: ${beats[i].visual})` : ''}`).join('\n')}\n` +
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

const MAX_STILLS = 8

/** the settings a bakery, a clinic or a shop is seen in when no writer is there to choose: a home, an office, a celebration */
const STOCK_SETTINGS = ['in a warm, cosy home on a wooden table by a window', 'on a tidy desk in a bright modern office, colleagues\' hands reaching in', 'at a lively small celebration table with friends gathered around, soft party lights', 'outdoors in soft morning light, on a bench in a calm street']

/** what people do with the product, shot to shot, when no writer is there to choose */
const STOCK_USES = ['being shared from hand to hand', 'being unwrapped as a gift', 'served on a plate, a hand reaching for it', 'held up close in two hands']

/** a photograph prompt built without a writer: the beat's idea (or the real product in use) in a setting that changes from shot to shot */
function stockMoment(beat: Beat, k: number, brand: { accent?: string; backdrop?: [string, string] }, motif: Motif, product?: { name: string; ref: boolean }): string {
  const look = clipLook('middle', brand, motif)
  const idea = (beat.visual ?? beat.line).replace(/\.$/, '')
  if (product && !beat.visual) {
    const what = product.ref ? `the exact ${product.name} shown in the reference photo (same shape, colours and packaging)` : product.name
    return [`A warm, natural photograph of ${what} ${STOCK_USES[k % STOCK_USES.length]}, ${STOCK_SETTINGS[k % STOCK_SETTINGS.length]}.`, `It shows: ${idea}.`, "People's hands or people seen from behind, close and real, soft natural light, shallow depth of field.", look.palette, NO_TEXT].filter(Boolean).join(' ')
  }
  return [`A warm, natural photograph illustrating: ${idea}, ${STOCK_SETTINGS[k % STOCK_SETTINGS.length]}.`, 'Close, appetising, real materials, soft natural light, shallow depth of field.', look.palette, NO_TEXT].filter(Boolean).join(' ')
}

/** the writer's shot list: for each beat, several different photographable moments in different everyday settings */
async function writeMoments(beats: Beat[], counts: number[], card: VideoCard, p: BusinessProfile, chat: LLMProvider, brand: { accent?: string; backdrop?: [string, string] }, motif: Motif, style: string | null, say: (m: string) => void, products: Array<{ name: string; ref: boolean } | undefined> = []): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>()
  const idx = beats.map((_, i) => i).filter((i) => counts[i] > 0)
  for (const i of idx) out.set(i, Array.from({ length: counts[i] }, (_, k) => stockMoment(beats[i], k, brand, motif, products[i])))
  const sells = p.services.slice(0, 6).map((sv) => `${sv.name}: ${sv.summary}`).join('\n')
  if (!idx.length) return out
  try {
    const look = clipLook('middle', brand, motif)
    const r = await chat.generateJSON<{ beats: Array<{ n: number; moments: string[] }> }>({
      system:
        'You direct the photographs of a short brand film. For each line of voice-over you give several DIFFERENT moments, each a single photograph a camera could really take: a concrete subject, a setting and a light. ' +
        "Every moment is about the business's OWN product or service IN USE, never a generic stock scene: the product being gifted, shared, unboxed, eaten, served, worn or carried, or the service being done for a customer. Where it fits, a person or their hands use it (people seen from behind, in profile or out of focus). " +
        'When a line says its product is shown in a reference photo, describe THAT product exactly (its shape, colours and packaging) so the picture shows the real thing. ' +
        'Vary the SETTING from shot to shot (a home, an office party, a celebration, a street, a kitchen, outdoors) so the film feels alive. ' +
        (style === 'infographic' ? 'The look is clean flat infographic illustration, not photography. ' : 'Warm, natural, appetising, real materials. ') +
        'FORBIDDEN, always: readable text, letters, numbers, logos, watermarks, screens showing text, close-up faces. Hands, objects and wide scenes are fine. ' +
        `Use this palette and no other: ${look.palette} ` +
        'Each moment is 25 to 45 words.',
      prompt:
        `Business: ${p.name} — ${p.tagline}\nWhat it does: ${p.about}\nWhat it sells (information only):\n${sells || '(as above)'}\nWhat this film sells: ${card.solution}\n\nFor each numbered line, give exactly the number of moments shown:\n${idx.map((i) => `${i + 1}. (${counts[i]} moments) ${beats[i].line}${products[i] ? ` — the product: ${products[i]!.name}${products[i]!.ref ? ' (shown in a reference photo)' : ''}` : ''}${beats[i].visual ? ` — the person described: ${beats[i].visual}` : ''}`).join('\n')}`,
      schemaName: 'marketing_moments',
      jsonSchema: {
        type: 'object',
        properties: { beats: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' }, moments: { type: 'array', items: { type: 'string' } } }, required: ['n', 'moments'] } } },
        required: ['beats']
      },
      temperature: 0.8,
      maxTokens: 1500
    })
    for (const i of idx) {
      const got = (r.beats ?? []).find((x) => x.n === i + 1)?.moments ?? []
      const list = out.get(i)!
      got.slice(0, counts[i]).forEach((m, k) => {
        const body = clean(m, 400)
        if (body && !promptIssues(body).length) list[k] = [`${body.replace(/\.*$/, '.')} Photographic.`, look.palette, NO_TEXT].join(' ')
      })
    }
  } catch (err) {
    say(`  (the writer could not plan the shots: ${(err as Error).message.slice(0, 80)}; plain shots are used)`)
  }
  return out
}

/** a still made and checked before it is used; null = fall back to an animated point */
async function checkedStill(tools: MediaTools, prompt: string, notes: string[], signal?: AbortSignal, portrait = false, opts: { refs?: string[]; allowBrand?: boolean } = {}): Promise<{ file: string | null; attempts: number; why?: string; refsUsed?: number }> {
  if (!tools.still) return { file: null, attempts: 0, why: 'AI pictures are not available' }
  let attempts = 0
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw new FilmCancelled()
      attempts++
      const refs = tools.stillTakesRefs && opts.refs?.length ? opts.refs : undefined
      const still = await tools.still(`A still photograph for a brand film. ${prompt}`, { portrait, ...(refs ? { refs } : {}) })
      const verdict = tools.reviewStill ? await tools.reviewStill(still.file, opts.allowBrand ? { allowBrand: true } : undefined).catch(() => null) : null
      if (!verdict || verdict.ok) return { file: still.file, attempts, refsUsed: still.refsUsed ?? 0 }
    }
    notes.push('A picture for one beat did not pass the check, so an animated point is used instead.')
    return { file: null, attempts, why: 'the picture did not pass the quality check' }
  } catch (err) {
    if (err instanceof FilmCancelled || signal?.aborted) throw err
    const why = String((err as Error)?.message ?? err).slice(0, 100)
    notes.push(`A picture for one beat could not be made (${why}), so an animated point is used instead.`)
    return { file: null, attempts, why }
  }
}

export async function runMarketingFilm(inp: FilmInput): Promise<FilmResult> {
  const say = (m: string) => inp.log?.(m)
  const check = () => {
    if (inp.signal?.aborted) throw new FilmCancelled()
  }
  const { card, profile: p } = inp
  const plan: MarketPlan =
    inp.plan ??
    planFromCard({ brief: '', business: { name: p.name, tagline: p.tagline, about: p.about, services: p.services }, card: { title: card.title, problem: card.problem, solution: card.solution, cta: card.cta, serviceIdx: card.serviceIdx, targetSec: card.targetSec, platform: card.platform } })
  const speech = inp.assignment?.voice === 'none' || plan.voice.none ? null : inp.speech
  const noClips = inp.assignment?.video === 'none' || inp.assignment?.video === 'skip'
  const targetSec = plan.targetSec ?? card.targetSec
  // the frame: where it will be posted (the brief wins over the card; wide when none is chosen)
  const frame = filmFrame(plan.platform ?? card.platform)
  const portrait = frame.height > frame.width
  mkdirSync(inp.runDir, { recursive: true })
  const brand = { accent: p.brand.accent, backdrop: p.brand.backdrop }
  const motif = pickMotif(`${card.solution} ${p.about}`)
  const notes: string[] = []
  const elements: string[] = []
  const made: MadePart[] = []

  // ------------------------------------------------------------ the script
  inp.progress('script', 'Writing the story')
  const maxBeats = Math.max(2, plan.points.length)
  let script = inp.reuse?.script ? structuredClone(inp.reuse.script) : stockScript(card, p, plan, maxBeats)
  let written = !!inp.reuse?.script
  if (inp.chat && !inp.reuse?.script) {
    try {
      script = await writeScript(card, p, inp.chat, plan, maxBeats, notes)
      written = true
    } catch (err) {
      say(`the writer could not write the script (${(err as Error).message.slice(0, 80)}); the plan's own words are used`)
    }
  }
  // a card with no brief keeps all its points (as before); a brief's length and must-haves are fitted
  const fitted = plan.source === 'card' || inp.reuse?.script ? { script, dropped: [] as string[] } : fitBeats(script, plan, targetSec)
  script = fitted.script
  if (fitted.dropped.length) notes.push(`To keep the film near ${targetSec}s, ${fitted.dropped.length} nice-to-have point${fitted.dropped.length === 1 ? ' was' : 's were'} left out.`)
  say(`script: "${script.problemHeadline}" + ${script.beats.length} beats + close`)
  check()

  // ------------------------------------------------------------ the voice
  inp.progress('voice', 'Recording the voice-over')
  const tone = `${plan.voice.tone ? plan.voice.tone.replace(/^./, (c) => c.toUpperCase()) : 'Confident, warm'} brand-film narrator. Clear and engaging, at an unhurried pace${plan.voice.tone ? '' : ', with a smile in the voice'}.${plan.voice.language ? ` Speak in ${plan.voice.language}.` : ''}`
  const spokenSec = (pcm: Float32Array, text: string) => (pcm.length ? pcm.length / SR : readSec(text))
  // a line said before in the same words and tone is used again (a revision); every other line is said now
  const voices: FilmVoiceRecord[] = []
  let voicesReused = 0
  const say1 = async (name: string, text: string): Promise<Float32Array> => {
    const kept = speech ? reusedVoice(inp.reuse, inp.runDir, name, text, tone) : null
    if (kept) voicesReused++
    const pcm = kept ?? (await voiceLine(speech, inp.runDir, name, text, tone))
    const file = speech ? voiceFileOf(inp.runDir, name) : null
    if (file) voices.push({ text, tone, file })
    return pcm
  }
  const problemPcm = await say1('voice-problem', script.problemLine)
  const beatPcms: Float32Array[] = []
  for (let i = 0; i < script.beats.length; i++) beatPcms.push(await say1(`voice-beat-${i + 1}`, script.beats[i].line))
  const closePcm = await say1('voice-close', script.close)
  if (speech) elements.push('AI voice-over')
  check()

  // ------------------------------------------------------------ the pictures
  inp.progress('media', 'Choosing the elements')
  const chosen = chooseElements(script.beats, plan, { tools: inp.tools, maxClips: inp.maxClips, noClips })
  const problemBeat: Beat = { headline: script.problemHeadline, line: script.problemLine, chapter: '', ...(plan.problem.visual ? { visual: plan.problem.visual } : {}) }
  const allBeats = [problemBeat, ...script.beats]
  const allKinds: Kind[] = [chosen.problem, ...chosen.kinds]
  // a revision: parts whose pictures are used again are not storyboarded or made again
  const partId = (i: number): string => (i === 0 ? 'problem' : script.beats[i - 1].pointId ?? `p${i}`)
  const kept = allBeats.map((_, i) => usableShots(inp.reuse?.shots?.[partId(i)]))
  kept.forEach((k, i) => { if (k) allKinds[i] = 'scene' })
  say(`elements: problem ${chosen.problem}; beats ${chosen.kinds.join(', ') || '(none)'}`)
  const clipPrompts = inp.chat && inp.tools && allKinds.includes('clip') ? await writeClipPrompts(allBeats, allKinds, card, p, inp.chat, brand, motif, plan.look.style, say) : new Map<number, string>()
  const clipSec = clipSeconds(targetSec)
  const logo = p.brand.logoFile && existsSync(p.brand.logoFile) ? p.brand.logoFile : undefined
  // the backgrounds of the animated points and of the closing scene are designed by the AI for this business (never the drawn motif,
  // which is only the last resort and is reported in the notes)
  inp.progress('media', 'Designing the scene backgrounds')
  const designed = await designFilmBackgrounds({
    chat: inp.chat,
    library: inp.introLibrary === undefined ? new IntroBackgroundLibrary(introBackgroundsDir) : inp.introLibrary,
    dir: join(inp.runDir, 'intro-background'),
    size: frame,
    topic: `${p.name}: ${card.solution}`,
    product: p.name,
    about: `${p.tagline ?? ''} ${p.about}`.trim(),
    narration: [script.problemLine, ...script.beats.map((b) => b.line), script.close].join(' '),
    title: { pill: script.beats[0]?.chapter, headline: script.beats[0]?.headline ?? p.name },
    outro: { pill: clean(plan.close.cta.toUpperCase(), 24), headline: p.name, sub: p.tagline },
    hasLogo: !!logo,
    logo,
    accent: p.brand.accent,
    backdrop: p.brand.backdrop,
    colors: p.brand.colors,
    style: plan.look.style,
    mood: plan.voice.tone,
    drawnName: motif,
    signal: inp.signal,
    say
  })
  check()
  notes.push(...designed.notes)
  const idOf = (i: number): string => (i === 0 ? 'problem' : script.beats[i - 1].pointId ?? `p${i}`)
  const wantedOf = (i: number): Show => (i === 0 ? plan.problem.show : plan.points.find((x) => x.id === script.beats[i - 1].pointId)?.show ?? 'any')

  // the business's own products: which of its photos each beat shows (never the trouble), and whether the picture model can look at them
  const picker = productPicker(p, card)
  const beatProducts: Array<BeatProduct | null> = allBeats.map((b, i) => (i === 0 ? null : picker.forBeat(`${b.headline} ${b.line}`)))
  const withRefs = !!inp.tools?.still && !!inp.tools.stillTakesRefs
  if (picker.any && inp.tools?.still && !withRefs) notes.push('Your picture model cannot look at your product photos, so the AI pictures are drawn from words alone; your own photos are shown in the product scenes.')
  const productHint = beatProducts.map((bp) => (bp ? { name: bp.name, ref: withRefs } : undefined))
  /** the pictures a still should show: the beat's product photo, and the logo for the one branded shot */
  const refsOf = (i: number, branded = false): string[] => (withRefs ? [...(beatProducts[i]?.images.slice(0, 1) ?? []), ...(branded && logo ? [logo] : [])] : [])
  const ENTRANCES: ProductEntrance[] = ['rise', 'turn', 'slide']
  let productScenes = 0
  /** the real product photo, animated: a whole beat (with its name and a line) or one shot of a beat's montage (no words) */
  const productScene = async (i: number, bp: BeatProduct, sec: number, words: boolean): Promise<{ file: string; durationSec: number } | null> => {
    try {
      const b = allBeats[i]
      const r = await renderProductScene(
        { images: bp.images, name: words ? bp.name : '', line: words ? b.headline : undefined, pill: words ? b.chapter : undefined, accent: p.brand.accent, backdrop: p.brand.backdrop, logo, durationSec: sec, size: frame, entrance: ENTRANCES[productScenes % ENTRANCES.length], cutout: /\.png$/i.test(bp.images[0]), text: words ? 'side' : 'none' },
        join(inp.runDir, `scene-product-${i}.mp4`)
      )
      productScenes++
      if (!elements.includes('Product scenes (your own photos)')) elements.push('Product scenes (your own photos)')
      return r
    } catch (err) {
      say(`  the product scene for beat ${i} could not be made (${String((err as Error)?.message ?? err).slice(0, 80)})`)
      return null
    }
  }

  /** an AI clip for one part; a failed asked-for clip is tried once more with the plain storyboard */
  const makeClip = async (i: number, pcm: Float32Array): Promise<{ piece: FilmPiece | null; attempts: number; why?: string }> => {
    const b = allBeats[i]
    const tools = inp.tools!
    const asked = wantedOf(i) === 'clip'
    const tries = [clipPrompts.get(i) ?? stockClipPrompt(b, brand, motif)]
    if (asked && tries[0] !== stockClipPrompt(b, brand, motif)) tries.push(stockClipPrompt(b, brand, motif))
    else if (asked) tries.push(tries[0])
    let why = ''
    let attempts = 0
    for (const prompt of tries) {
      attempts++
      try {
        // the clip's first frame is made and checked before any video is paid for
        let imageFile: string | undefined
        if (tools.still && attempts === 1) {
          // the first frame shows the real product when the picture model can look at its photo; the clip then moves from it
          const refs = refsOf(i)
          const still = await tools.still(`First frame of this shot, a still photograph${refs.length ? `, showing the exact ${beatProducts[i]!.name} from the reference photo` : ''}: ${prompt}`, { portrait, ...(refs.length ? { refs } : {}) })
          const verdict = tools.reviewStill ? await tools.reviewStill(still.file).catch(() => null) : null
          if (!verdict || verdict.ok) imageFile = still.file
        }
        const clip = await tools.clip(prompt, clipSec, { imageFile, portrait })
        return { piece: { kind: 'clip', file: clip.file, text: b.line, chapter: b.chapter, pcm, sec: Math.max(clipSec, spokenSec(pcm, b.line) + 1.0), clipSec: clip.durationSec ?? clipSec }, attempts }
      } catch (err) {
        if (err instanceof FilmCancelled || inp.signal?.aborted) throw err
        why = String((err as Error)?.message ?? err).slice(0, 100)
        say(`  clip ${i + 1} failed: ${why.slice(0, 80)}${attempts < tries.length ? '; trying once more' : '; falling back to a scene'}`)
      }
    }
    return { piece: null, attempts, why }
  }

  // the pictures of a beat: a hero AI clip when one was chosen, then different still photographs (home, office, a celebration…)
  // with a slow move on each, so nothing sits frozen while the voice goes on
  const canStill = !!inp.tools?.still
  const secOf = (i: number): number => {
    const spoken = spokenSec(i === 0 ? problemPcm : beatPcms[i - 1], allBeats[i].line)
    return Math.max(4.2, spoken + (i === 0 ? 1.9 : 1.5))
  }
  // how many stills each beat wants, spent in film order up to a budget
  const wantStills: number[] = allBeats.map(() => 0)
  if (canStill) {
    let budget = MAX_STILLS
    allBeats.forEach((_, i) => {
      const sec = secOf(i)
      const n = allKinds[i] === 'still' && i > 0 ? Math.max(2, Math.min(4, Math.round(sec / 3.4))) : allKinds[i] === 'clip' ? (sec > clipSec + 1.4 ? Math.min(2, Math.ceil((sec - clipSec) / 3.4)) : 0) : 0
      wantStills[i] = Math.min(n, budget)
      budget -= wantStills[i]
    })
  }
  const moments = inp.chat && inp.tools && wantStills.some((n) => n > 0) ? await writeMoments(allBeats, wantStills, card, p, inp.chat, brand, motif, plan.look.style, say, productHint) : new Map<number, string[]>()
  const stillPrompt = (i: number, k: number): string => moments.get(i)?.[k] ?? stockMoment(allBeats[i], k, brand, motif, productHint[i])
  // one picture in the film brands the scene: the product's own box, bag or sticker carrying the logo (only when the model can copy the logo from it)
  const brandedBeat = withRefs && logo ? allBeats.findIndex((_, i) => i > 0 && beatProducts[i] && wantStills[i] >= 2) : -1
  const brandedPrompt = (i: number, k: number): string => {
    const base = stillPrompt(i, k)
    const bp = beatProducts[i]!
    const body = base.includes(NO_TEXT) ? base.replace(NO_TEXT, BRAND_ONLY) : `${base} ${BRAND_ONLY}`
    return `${body} The ${bp.name} is shown in its own packaging carrying the business's logo from the second reference picture, as part of the scene (a box, a bag, a sticker), never as a watermark.`
  }
  let refsMade = 0
  let brandedMade = false

  const pieces: FilmPiece[] = []
  const stickers: Array<{ piece: number; text: string; icon: IconName }> = []
  for (let i = 0; i < allBeats.length; i++) {
    const b = allBeats[i]
    const pcm = i === 0 ? problemPcm : beatPcms[i - 1]
    const id = idOf(i)
    const wanted = wantedOf(i)
    const sec = secOf(i)
    check()
    const keep = kept[i]
    if (keep) {
      const clipped = keep.some((s) => s.kind === 'clip')
      pieces.push({ kind: 'montage', file: '', shots: keep, text: b.line, chapter: i === 0 ? '' : b.chapter, pcm, sec: Math.max(sec, clipped ? clipSec : 0) })
      made.push({ id, wanted, made: clipped ? 'clip' : 'image', line: b.line, attempts: 1, reused: true })
      if (i > 0) stickers.push({ piece: pieces.length - 1, text: b.headline, icon: iconFor(`${b.headline} ${b.line}`) })
      continue
    }
    let fellBack = chosen.why.get(id) ?? chosen.why.get(b.pointId ?? '')
    let attempts = 0
    const shots: PieceShot[] = []
    let hero = false
    if (allKinds[i] === 'clip' && inp.tools) {
      const r = await makeClip(i, pcm)
      attempts = r.attempts
      if (r.piece) {
        shots.push({ kind: 'clip', file: r.piece.file, sec: r.piece.clipSec })
        hero = true
        elements.push('AI video clip')
        notes.push(`AI clip: ${clean(i === 0 ? 'the problem' : b.headline, 60)}`)
      } else {
        fellBack = `the AI clip could not be made (${r.why})`
        notes.push(`An AI clip for "${clean(i === 0 ? 'the problem' : b.headline, 40)}" could not be made (${r.why}), so ${i === 0 ? 'the problem card' : 'pictures'} are used.`)
      }
    }
    // a clip that could not be made is still told in pictures when the account can make them
    const nStills = allKinds[i] === 'clip' && !hero && canStill && i > 0 ? Math.min(3, Math.max(2, Math.round(sec / 3.4))) : wantStills[i]
    if (inp.tools && nStills > 0) {
      const made1 = await Promise.all(
        Array.from({ length: nStills }, (_, k) => {
          const branded = i === brandedBeat && k === nStills - 1
          return checkedStill(inp.tools!, branded ? brandedPrompt(i, k) : stillPrompt(i, k), notes, inp.signal, portrait, { refs: refsOf(i, branded), allowBrand: branded })
        })
      )
      for (const [k, s] of made1.entries()) {
        attempts += s.attempts
        if (s.refsUsed && s.file) {
          refsMade++
          if (i === brandedBeat && k === nStills - 1) brandedMade = true
        }
        if (s.file) {
          shots.push({ kind: 'still', file: s.file })
          elements.push('AI image')
        } else if (!fellBack) fellBack = `an AI picture could not be used (${s.why})`
      }
    }
    // a beat about a product opens on the real product photo, animated, before the pictures of it in use (at most 3 in a film)
    const bp = beatProducts[i]
    if (shots.length && bp && productScenes < 3) {
      const shot = await productScene(i, bp, 3, false)
      if (shot) shots.unshift({ kind: 'scene', file: shot.file, sec: shot.durationSec })
    }
    // with no pictures, a beat about a product is told by the product scene: the business's own photo animated, with its name
    // and the beat's headline (the free engine's main picture)
    const wholeSec = Math.min(8, Math.max(4.2, sec - 0.2))
    const whole = !shots.length && i > 0 && bp ? await productScene(i, bp, wholeSec, true) : null
    const onScene = !!whole
    if (shots.length) {
      pieces.push({ kind: 'montage', file: '', shots, text: b.line, chapter: i === 0 ? '' : b.chapter, pcm, sec: Math.max(sec, hero ? clipSec : 0) })
      made.push({ id, wanted, made: hero ? 'clip' : 'image', line: b.line, ...(wanted === 'clip' && !hero && fellBack ? { fellBack } : {}), attempts: Math.max(1, attempts) })
    } else if (whole) {
      pieces.push({ kind: 'scene', file: whole.file, text: b.line, chapter: b.chapter, pcm, sec: Math.max(wholeSec, sec), srcSec: whole.durationSec })
      made.push({ id, wanted, made: 'scene', line: b.line, ...(fellBack ? { fellBack } : {}), attempts: Math.max(1, attempts) })
    } else if (i === 0) {
      // the trouble opens the film, on the problem scene (rendered with the closing card below)
      pieces.push({ kind: 'scene', file: '', text: b.line, pcm, sec, chapter: '' })
      made.push({ id, wanted, made: 'scene', line: b.line, ...(fellBack ? { fellBack } : {}), attempts: Math.max(1, attempts) })
    } else {
      // the animated point: the beat as its own moving card
      const want = Math.min(8, Math.max(4.2, sec - 0.2))
      const scene = await renderScene({ kind: 'point', motif, pill: b.chapter, headline: b.headline, accent: p.brand.accent, backdrop: p.brand.backdrop, logo, durationSec: want, size: frame, background: designed.title }, join(inp.runDir, `scene-beat-${i}.mp4`))
      pieces.push({ kind: 'scene', file: scene.file, text: b.line, chapter: b.chapter, pcm, sec: Math.max(want, sec), srcSec: scene.durationSec })
      made.push({ id, wanted, made: 'scene', line: b.line, ...(fellBack ? { fellBack } : {}), attempts: Math.max(1, attempts) })
    }
    // a product scene already carries the headline on screen, so it gets no sticker
    if (i > 0 && !onScene) stickers.push({ piece: pieces.length - 1, text: b.headline, icon: iconFor(`${b.headline} ${b.line}`) })
  }
  if (refsMade) notes.push(`${refsMade} AI picture${refsMade === 1 ? ' was' : 's were'} made from your own product photo${brandedMade ? ', one with your logo on the packaging' : ''}.`)
  check()

  // ------------------------------------------------------------ the music
  let choice: MusicChoice | null = null
  const modelPick = inp.assignment?.music
  const noMusic = plan.music.none || modelPick === 'none'
  const aiModel = modelPick && !/^(none|builtin(:.*)?)$/.test(modelPick) ? modelPick : undefined
  // the person described the music (a style, vocals, instruments, sounds): their words, not a mood template, make the brief
  const described = !plan.music.none && (!!plan.music.description.trim() || !!plan.music.genre || plan.music.vocals !== 'none' || plan.music.instruments.length > 0 || plan.music.ambience.length > 0)
  if (inp.chat && !noMusic && !described && !inp.reuse?.musicMood) {
    try {
      choice = await chooseMusic({ chat: inp.chat, context: `${card.title}. ${card.solution}`, mode: 'launch', targetSec, secrets: [], say })
    } catch {
      choice = null
    }
  }

  // ------------------------------------------------------------ the closing card and the assembly
  inp.progress('assemble', 'Building the film')
  const closeText = script.close
  const outroSpoken = spokenSec(closePcm, closeText)
  const outroSec = Math.max(3.6, outroSpoken + 1.4)
  // the very opening is designed and coded by the AI for this business (never a template): the drawn card is only the
  // last resort when there is no writer or every round of the intro director failed
  let aiIntro = false
  if (pieces[0].kind === 'scene' && pieces[0].file === '') {
    const problemSec = Math.max(4.2, spokenSec(problemPcm, script.problemLine) + 1.9)
    const introSec = Math.min(8, problemSec)
    let opening: { file: string; durationSec: number } | null = null
    if (inp.chat) {
      inp.progress('assemble', 'Designing the opening')
      try {
        const tools = inp.tools
        const r = await directIntro({
          chat: inp.chat,
          brief: { hook: script.hook || script.problemHeadline, headline: script.problemHeadline, line: script.problemLine, business: p.name, about: `${p.tagline ?? ''} ${p.about}`.trim(), accent: p.brand.accent, backdrop: p.brand.backdrop, colors: p.brand.colors, style: plan.look.style, tone: plan.voice.tone },
          size: frame,
          durationSec: introSec,
          dir: join(inp.runDir, 'intro'),
          logo,
          signal: inp.signal,
          say,
          still: tools?.still
            ? async (prompt) => {
                const s = await tools.still!(`A still photograph, no readable text, no logos: ${prompt}`, { portrait })
                const verdict = tools.reviewStill ? await tools.reviewStill(s.file).catch(() => null) : null
                return !verdict || verdict.ok ? s.file : null
              }
            : undefined
        })
        if (r.file) {
          opening = { file: r.file, durationSec: r.durationSec }
          aiIntro = true
          elements.push('AI-coded opening (HTML/CSS/JS motion)')
          if (r.picture) elements.push('AI image')
          notes.push(`The opening was designed and coded by the AI${r.concept ? `: ${clean(r.concept, 140)}` : ''} (${r.rounds} round${r.rounds === 1 ? '' : 's'}${r.picture ? ', over an AI picture' : ''}).`)
        } else {
          notes.push(`The AI could not design the opening (${clean(r.why ?? 'unknown', 120)}), so the drawn opening card is used.`)
        }
      } catch (err) {
        if (err instanceof FilmCancelled || inp.signal?.aborted) throw new FilmCancelled()
        notes.push(`The AI opening could not be made (${clean(String((err as Error)?.message ?? err), 120)}), so the drawn opening card is used.`)
      }
    } else {
      notes.push('No AI writer is set up, so the drawn opening card is used.')
    }
    if (!opening) opening = await renderScene({ kind: 'problem', motif, headline: script.problemHeadline, accent: p.brand.accent, backdrop: p.brand.backdrop, logo, durationSec: introSec, size: frame, background: designed.title }, join(inp.runDir, 'scene-problem.mp4'))
    pieces[0] = { ...pieces[0], file: opening.file, sec: problemSec, srcSec: opening.durationSec }
  }
  const outroScene = await renderScene({ kind: 'outro', motif, pill: clean(plan.close.cta.toUpperCase(), 24), headline: p.name, sub: p.tagline, accent: p.brand.accent, backdrop: p.brand.backdrop, logo, durationSec: Math.min(8, outroSec), size: frame, background: designed.outro ?? designed.title }, join(inp.runDir, 'scene-outro.mp4'))
  pieces.push({ kind: 'scene', file: outroScene.file, text: closeText, pcm: closePcm, sec: outroSec, srcSec: outroScene.durationSec, chapter: '', fadeOut: true, push: true })
  made.push({ id: 'close', wanted: 'close', made: 'scene', line: closeText, attempts: 1 })
  elements.push(designed.title ? 'AI-designed scene backgrounds (HTML/canvas/SVG)' : 'Animated scenes (HTML/canvas)')

  const keptMusic = !noMusic && inp.reuse?.music && existsSync(inp.reuse.music) ? inp.reuse.music : undefined
  const wantAiMusic = !noMusic && (!!keptMusic || (inp.aiMusic && !!inp.tools?.music && modelPick !== 'builtin:procedural'))
  const style = inp.reuse?.style ?? {}
  const out = await assemble({
    dir: inp.runDir,
    size: frame,
    pieces,
    title: card.title,
    musicMood: choice?.mood ?? (inp.reuse?.musicMood as MusicChoice['mood'] | undefined),
    noMusic,
    overlays: { accent: p.brand.accent ?? 'f5a524', hook: style.hook === false || aiIntro ? undefined : script.hook, stickers: style.stickers === false ? [] : stickers, captionColor: style.captionColor, captionScale: style.captionScale },
    aiMusic: wantAiMusic
      ? async ({ cuts, total }) => {
          if (keptMusic) {
            const file = join(inp.runDir, 'music.mp3')
            if (file !== keptMusic) copyFileSync(keptMusic, file)
            return decodeStereo(file)
          }
          const spec = { title: card.title, musicMood: choice?.mood ?? 'corporate', design: { look: 'social' }, voiceover: ['x'], narration: [] } as unknown as VideoSpec
          const brief = described
            ? musicPrompt(plan.music, total, !!speech)
            : withStyle(musicBrief(spec, cuts, total) ?? `Instrumental background music for a short brand film, ${choice?.mood ?? 'corporate'} and warm, ending gently, no vocals.`, choice?.style)
          const audio = await inp.tools!.music(brief, aiModel)
          const file = join(inp.runDir, 'music.mp3')
          writeFileSync(file, audio)
          return decodeStereo(file)
        }
      : undefined,
    log: inp.log
  })
  if (out.musicSource === 'ai') elements.push('AI music')
  else if (out.musicSource === 'builtin') elements.push('Built-in score')
  if (p.brand.colors.length) notes.push(`Brand colours from ${p.domain}: ${p.brand.colors.slice(0, 3).join(', ')}`)
  if (choice) notes.push(`Music: ${choice.mood} — ${choice.why}`)
  const musicModel = out.musicSource === 'ai' ? (keptMusic ? inp.reuse?.musicModel : aiModel) : undefined
  // what the film is made of, so it can be made again with a few changes
  writeFilmRecord(inp.runDir, {
    version: 1,
    script,
    parts: allBeats.map((b, i) => ({ id: partId(i), headline: b.headline, line: b.line, kind: made[i]?.made ?? 'scene', shots: (pieces[i]?.shots ?? []).filter((s) => s.kind !== 'scene'), ...(b.visual ? { visual: b.visual } : {}) })),
    voices,
    music: { source: out.musicSource, ...(out.musicSource === 'ai' && existsSync(join(inp.runDir, 'music.mp3')) ? { file: join(inp.runDir, 'music.mp3') } : {}), ...(musicModel ? { model: musicModel } : {}), ...(choice?.mood ?? inp.reuse?.musicMood ? { mood: choice?.mood ?? inp.reuse?.musicMood } : {}) },
    frame,
    style,
    targetSec,
    durationSec: out.durationSec
  })
  return {
    file: out.file,
    durationSec: out.durationSec,
    notes,
    elements,
    made,
    dropped: fitted.dropped,
    musicSource: out.musicSource,
    ...(musicModel ? { musicModel } : {}),
    voiced: !!speech,
    written,
    ...(inp.reuse ? { reused: { voices: voicesReused, parts: kept.map((k, i) => (k ? partId(i) : '')).filter(Boolean), music: !!keptMusic && out.musicSource === 'ai' } } : {})
  }
}
