import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LLMProvider, SpeechProvider } from '../../providers/types'
import type { DecisionAnswer, DecisionRequest, JobAssignment, MusicSpec } from '@shared/agentBrief'
import type { MarketPlan, MarketPoint, MarketReport, MarketRevision } from '@shared/marketBrief'
import type { BusinessProfile, MarketStage, VideoCard } from '@shared/marketing'
import { isPlatformId } from '@shared/shapes'
import type { PlatformId } from '@shared/spec'
import type { MediaTools } from '../../appRecon/run'
import { readMusicSentence } from '../../appRecon/agent/brief'
import { readSec } from '../../appRecon/produce'
import { avoidHit, fitBeats, runMarketingFilm, type FilmResult } from '../film'
import { readFilmRecord, type FilmBeat, type FilmRecord, type FilmReuse, type FilmScript, type FilmStyle } from '../filmRecord'
import type { PieceShot } from '../assemble'
import { MarketStopped, buildReport, reviewFilm, type MarketPariHooks } from './loop'

/**
 * Make a finished film again with the changes the person typed ("make the hook
 * funnier", "no music", "use a different picture in the second scene", "Urdu
 * voice", "15 seconds").
 *
 *   readPreviousRun()     the earlier film: its plan, model choices, report and what it is made of (market-film.json)
 *   interpretRevision()   the request as a structured edit: the AI writer first (one generateJSON call), rules as the fallback
 *   applyEdit()           the edit applied to the plan and the script; which parts keep their pictures, voice and music
 *   reviseFilm()          asks before spending on new AI media, makes the film (re-making only what changed), reviews it
 *                         and reports what was changed, kept and could not be done
 *
 * Nothing asked is silently dropped: what cannot be done goes into `cannot` and the report.
 */

const clean = (s: unknown, max: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const sentence = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`)
const cap = (s: string): string => s.replace(/^./, (c) => c.toUpperCase())

// ------------------------------------------------------------------ the earlier film

export interface PreviousRun {
  runId: string
  dir: string
  plan: MarketPlan
  assignment: JobAssignment
  decisions: DecisionAnswer[]
  report: MarketReport | null
  /** what the film is made of; null for a film made before revisions were saved */
  film: FilmRecord | null
}

export function readPreviousRun(runId: string, dir: string): PreviousRun | null {
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'market-plan.json'), 'utf8')) as { plan?: MarketPlan; assignment?: JobAssignment; decisions?: DecisionAnswer[] }
    if (!saved.plan?.problem || !Array.isArray(saved.plan.points)) return null
    let report: MarketReport | null = null
    try {
      report = JSON.parse(readFileSync(join(dir, 'market-report.json'), 'utf8')) as MarketReport
    } catch {
      report = null
    }
    return { runId, dir, plan: saved.plan, assignment: saved.assignment ?? {}, decisions: saved.decisions ?? [], report, film: readFilmRecord(dir) }
  } catch {
    return null
  }
}

/** the parts of the film as the person sees them, in order: the opening problem, each point, the ending */
export interface PartView {
  id: string
  /** "scene 1 (the opening)", "scene 2"… */
  label: string
  headline: string
  line: string
  kind: 'clip' | 'image' | 'scene'
  visual?: string
}

export function partsOf(prev: PreviousRun): PartView[] {
  const rec = prev.film
  if (rec) return rec.parts.map((p, i) => ({ id: p.id, label: `scene ${i + 1}${i === 0 ? ' (the opening)' : ''}`, headline: p.headline, line: p.line, kind: p.kind, ...(p.visual ? { visual: p.visual } : {}) }))
  return [
    { id: 'problem', label: 'scene 1 (the opening)', headline: '', line: prev.plan.problem.say, kind: 'scene' },
    ...prev.plan.points.map((pt, i) => ({ id: pt.id, label: `scene ${i + 2}`, headline: '', line: pt.say, kind: 'scene' as const }))
  ]
}

// ------------------------------------------------------------------ the edit

export interface MarketEdit {
  hook?: string
  /** take the big opening line off */
  hookOff?: boolean
  problemHeadline?: string
  problemLine?: string
  close?: string
  cta?: string
  /** new words for a part ('problem', 'p1'…) */
  lines: Array<{ part: string; line?: string; headline?: string }>
  /** new points, said in the person's words */
  add: Array<{ say: string; after?: string }>
  /** point ids to take out */
  remove: string[]
  /** the points' new order (ids) */
  order?: string[]
  /** things never to mention */
  avoid: string[]
  voice?: { tone?: string; language?: string; none?: boolean }
  music?: { none?: boolean; spec?: MusicSpec; remake?: boolean }
  targetSec?: number
  platform?: PlatformId
  /** parts whose pictures or clip are made again, with what they should show */
  remake: Array<{ part: string; visual?: string; show?: 'clip' | 'image' }>
  /** a part's clip played slower (>1) or faster (<1) */
  pace: Array<{ part: string; slow: number }>
  style: FilmStyle
  /** what was asked but cannot be done, in plain words */
  cannot: string[]
  source: 'ai' | 'rules'
}

const emptyEdit = (source: 'ai' | 'rules'): MarketEdit => ({ lines: [], add: [], remove: [], avoid: [], remake: [], pace: [], style: {}, cannot: [], source })

/** true when the edit asks for nothing */
export function editIsEmpty(e: MarketEdit): boolean {
  return !e.hook && !e.hookOff && !e.problemHeadline && !e.problemLine && !e.close && !e.cta && !e.lines.length && !e.add.length && !e.remove.length && !e.order && !e.avoid.length && !e.voice && !e.music && !e.targetSec && !e.platform && !e.remake.length && !e.pace.length && !Object.keys(e.style).length
}

const COLOURS: Record<string, string> = { yellow: '#ffd400', white: '#ffffff', red: '#ff3b30', green: '#34c759', blue: '#3b82f6', orange: '#ff9500', pink: '#ff4fa3', purple: '#a855f7', gold: '#f5c542', black: '#111111', cyan: '#22d3ee', teal: '#14b8a6', lime: '#a3e635' }
/** a colour from a name or hex ("yellow", "#FFD400", "ffd400") */
export function colourOf(v: unknown): string | undefined {
  const s = String(v ?? '').trim().toLowerCase()
  if (COLOURS[s]) return COLOURS[s]
  const m = /^#?([0-9a-f]{6})$/.exec(s)
  return m ? `#${m[1]}` : undefined
}
/** a colour pushed toward white */
export function lighter(hex: string, k = 0.5): string {
  const h = hex.replace('#', '').padEnd(6, '0').slice(0, 6)
  return '#' + [0, 2, 4].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) + (255 - parseInt(h.slice(i, i + 2), 16)) * k).toString(16).padStart(2, '0')).join('')
}

const PLATFORM_WORDS: Array<[RegExp, PlatformId]> = [
  [/\btik ?tok\b/i, 'tiktok'],
  [/\b(?:reels?|instagram stor(?:y|ies)|stories)\b/i, 'instagram-reels'],
  [/\b(?:youtube )?shorts\b/i, 'youtube-shorts'],
  [/\b(?:instagram|insta) (?:post|feed)\b/i, 'instagram-feed'],
  [/\bfacebook\b/i, 'facebook-feed'],
  [/\b(?:linkedin|whatsapp|square)\b/i, 'square'],
  [/\byoutube\b/i, 'youtube'],
  [/\b(?:vertical|tall|portrait)\b/i, 'instagram-reels'],
  [/\b(?:wide|landscape|horizontal)\b/i, 'youtube']
]

const LANGS = ['urdu', 'arabic', 'english', 'french', 'spanish', 'hindi', 'german', 'portuguese', 'turkish', 'italian', 'punjabi', 'bengali', 'chinese', 'mandarin', 'japanese', 'korean', 'russian', 'dutch', 'malay', 'indonesian', 'persian', 'farsi', 'swahili', 'tagalog', 'polish', 'greek']
const LANG_RE = new RegExp(`\\b(${LANGS.join('|')})\\b`, 'i')
const TONE_RE = /\b(warmer|warm|calmer|calm|energetic|more energy|excited|friendlier|friendly|serious|playful|upbeat|softer|soft|slower|faster|deeper|cheerful|professional|confident|gentle|happier|happy|louder)\b/i
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, '1st': 1, '2nd': 2, '3rd': 3, '4th': 4, '5th': 5, '6th': 6 }
const PICTURE_WORD = /\b(picture|pictures|image|images|photo|photos|shot|shots|visual|visuals|clip|clips|video|footage|scene|scenes)\b/i
const STOP = new Set(['make', 'change', 'clip', 'video', 'scene', 'part', 'picture', 'image', 'photo', 'shot', 'slower', 'faster', 'different', 'another', 'please', 'with', 'that', 'this', 'there', 'should', 'would', 'more', 'less', 'instead', 'replace', 'redo', 'remake', 'new', 'better', 'other', 'the', 'and', 'use', 'show', 'showing', 'speed', 'down', 'film', 'footage'])
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2)
const stem = (w: string): string => (w.length > 4 ? w.replace(/(?:ies|es|s)$/, '') : w)

/** which part of the film a phrase points at: "the second scene", "scene 3", "the opening", "the cookie clip" */
export function partRef(text: string, parts: PartView[], prev: PreviousRun): string | undefined {
  const t = text.toLowerCase()
  if (/\b(opening|beginning|start|intro|problem)\b/.test(t) && !/\bto the (?:start|beginning)\b/.test(t)) return parts[0]?.id
  const pointNo = /\b(?:point|beat)\s*#?(\d)\b/.exec(t) ?? new RegExp(`\\b(${Object.keys(ORDINALS).join('|')})\\s+(?:point|beat)\\b`).exec(t)
  if (pointNo) {
    const n = Number(pointNo[1]) || ORDINALS[pointNo[1]]
    const pt = prev.plan.points[n - 1]
    if (pt) return pt.id
  }
  const num = /\b(?:scene|part|shot|picture|image|clip|section)\s*#?(\d{1,2})\b/.exec(t)
  const ord = new RegExp(`\\b(${Object.keys(ORDINALS).join('|')}|last)\\s+(?:scene|part|shot|picture|image|photo|clip|section|line)\\b`).exec(t)
  if (num) return parts[Number(num[1]) - 1]?.id
  if (ord) return ord[1] === 'last' ? parts.at(-1)?.id : parts[ORDINALS[ord[1]] - 1]?.id
  // a thing it shows: the part whose words share the most meaningful words with the phrase
  const want = words(t).filter((w) => !STOP.has(w)).map(stem)
  if (!want.length) return undefined
  let best: { id: string; score: number } | undefined
  for (const p of parts) {
    const have = new Set(words(`${p.headline} ${p.line} ${p.visual ?? ''}`).map(stem))
    const score = want.filter((w) => have.has(w)).length
    if (score > 0 && (!best || score > best.score)) best = { id: p.id, score }
  }
  return best?.id
}

/** the request cut into instructions: sentences, lines, semicolons and "then" */
function clausesOf(request: string): string[] {
  return request
    .split(/(?<=[.!?])\s+|\n+|;\s*|,\s*(?:and\s+)?then\s+|\s+and then\s+/i)
    .flatMap((c) => c.split(/,\s+(?=(?:make|use|change|add|remove|no|say|put|end|set|give|take|drop|show|swap|move|turn|keep)\b)/i))
    .map((c) => c.trim().replace(/[.!]+$/, ''))
    .filter((c) => c.length > 1)
}

const QUOTED = /["“'‘]([^"”'’]{2,160})["”'’]/

/**
 * The request read by rules alone: the common asks, with the words the person
 * gave. Creative asks with no words given ("make the hook funnier") need the
 * AI writer and are listed as not done.
 */
export function readRevisionByRules(request: string, prev: PreviousRun): MarketEdit {
  const e = emptyEdit('rules')
  const parts = partsOf(prev)
  const needsWriter = (c: string) => e.cannot.push(`"${c}" needs the AI writer to write new words, and it is not available, so that part is unchanged.`)
  for (const c of clausesOf(request)) {
    const low = c.toLowerCase()
    let used = false
    const quoted = QUOTED.exec(c)?.[1]?.trim()

    // the length
    const secs = /\b(\d{1,3})\s*(?:s|sec|secs|seconds?)\b/i.exec(c)
    const mins = /\b(?:(\d)|a|one)\s*(?:min|minute)s?\b/i.exec(c)
    if (secs || mins || /\b(shorter|longer|half the length|twice as long)\b/i.test(low)) {
      if (secs) e.targetSec = Math.min(180, Math.max(6, Number(secs[1])))
      else if (mins) e.targetSec = Math.min(180, 60 * (Number(mins[1]) || 1))
      else {
        const was = prev.plan.targetSec ?? prev.film?.targetSec ?? 30
        e.targetSec = /shorter|half/.test(low) ? Math.max(8, Math.round(was * (/half/.test(low) ? 0.5 : 0.7))) : Math.min(120, Math.round(was * (/twice/.test(low) ? 2 : 1.4)))
      }
      used = true
    }

    // where it is posted (the shape)
    if (/\b(for|on|to|make it|post|format|vertical|tall|portrait|wide|landscape|horizontal|square)\b/i.test(low)) {
      const hit = PLATFORM_WORDS.find(([re]) => re.test(c))
      if (hit) {
        e.platform = hit[1]
        used = true
      }
    }

    // the voice
    if (/\b(no|without|remove|drop|mute)\s+(?:the\s+)?(?:voice|voice-?over|narration|narrator)\b/i.test(c)) {
      e.voice = { ...e.voice, none: true }
      used = true
    } else if (/\b(add|with|bring back|put back)\s+(?:a\s+|the\s+)?(?:voice|voice-?over|narration|narrator)\b/i.test(c)) {
      e.voice = { ...e.voice, none: false }
      used = true
    }
    const lang = LANG_RE.exec(c)
    if (lang && (/\b(voice|speak|spoken|language|narrat|say it|in)\b/i.test(low) || c.trim().split(/\s+/).length <= 3)) {
      e.voice = { ...e.voice, language: cap(lang[1].toLowerCase()) }
      used = true
    }
    const tone = TONE_RE.exec(c)
    if (tone && /\b(voice|narrat|tone|speak|sound)\b/i.test(low) && !/\bmusic\b/i.test(low)) {
      e.voice = { ...e.voice, tone: tone[1].toLowerCase() }
      used = true
    }

    // the music
    if (/\bmusic|song|track|soundtrack|score\b/i.test(low) && !used) {
      if (/\b(no|without|remove|drop|mute|turn off|lose)\s+(?:the\s+|any\s+|background\s+)?(?:music|song|track|soundtrack)\b/i.test(c)) e.music = { none: true }
      else if (/\b(different|new|other|another|change|swap|replace)\b/i.test(low) && !/\b(music|song|track)\s+(?:with|that|like|:)/i.test(low) && words(c).filter((w) => !/^(different|new|other|another|change|the|music|song|track|swap|replace|use|soundtrack)$/.test(w)).length === 0) e.music = { remake: true }
      else if (/\b(add|bring back|put back|with)\s+(?:some\s+|the\s+)?music\b/i.test(c) && words(c).length <= 4) e.music = { none: false }
      else {
        const spec = readMusicSentence(c)
        if (spec) e.music = spec.none ? { none: true } : { spec, remake: true, none: false }
      }
      if (e.music) used = true
    }

    // the captions and stickers
    if (/\b(caption|captions|subtitle|subtitles|words on screen|text on screen)\b/i.test(low)) {
      const named = Object.keys(COLOURS).find((k) => new RegExp(`\\b${k}\\b`, 'i').test(c))
      const hex = /#([0-9a-f]{6})\b/i.exec(c)
      if (hex) e.style.captionColor = `#${hex[1].toLowerCase()}`
      else if (named) e.style.captionColor = COLOURS[named]
      else if (/\b(brighter|lighter|more visible|stand out|pop)\b/i.test(low)) e.style.captionColor = 'brighter'
      if (/\b(much|a lot|way)\s+(bigger|larger)\b/i.test(low)) e.style.captionScale = 1.45
      else if (/\b(bigger|larger|huge|easier to read)\b/i.test(low)) e.style.captionScale = 1.25
      else if (/\b(smaller|tinier|less big)\b/i.test(low)) e.style.captionScale = 0.8
      if (e.style.captionColor || e.style.captionScale) used = true
    }
    if (/\bstickers?|badges?|icons?\b/i.test(low)) {
      if (/\b(no|without|remove|drop|hide|turn off|lose)\b/i.test(low)) e.style.stickers = false
      else if (/\b(add|bring back|put back|show|with)\b/i.test(low)) e.style.stickers = true
      if (e.style.stickers !== undefined) used = true
    }

    if (used) continue

    // the hook
    if (/\bhook\b|\bopening line\b|\bfirst words\b|\bheadline at the start\b/i.test(low)) {
      if (/\b(no|remove|drop|without|take off|hide)\b/i.test(low) && !quoted) e.hookOff = true
      else {
        const to = quoted ?? /\b(?:to|:|say|says|read|reads)\s+(.{3,80})$/i.exec(c)?.[1]?.trim()
        if (to && !/^(be|sound|feel|more|less)\b/i.test(to)) e.hook = clean(to.replace(/^["“']|["”']$/g, ''), 70)
        else needsWriter(c)
      }
      continue
    }

    // the ending / call to action
    if (/\b(ending|end with|end on|ends with|call to action|cta|last words|closing|close with|finish with|the end)\b/i.test(low)) {
      const to = quoted ?? /\b(?:to|with|on|:|say|says)\s+(.{2,60})$/i.exec(c)?.[1]?.trim()
      if (to && !/^(be|sound|feel|more|less)\b/i.test(to)) e.cta = clean(to.replace(/^["“']|["”']$/g, '').replace(/[.!]+$/, ''), 60)
      else needsWriter(c)
      continue
    }

    // say / do not say
    const notSay = /\b(?:don'?t|do not|never|stop)\s+(?:mention|say|talk about|show)\s+(?:the\s+|our\s+|any\s+)?(.{2,60})$/i.exec(c) ?? /\bno (?:mention of|talk of)\s+(.{2,60})$/i.exec(c)
    if (notSay) {
      e.avoid.push(clean(notSay[1], 60))
      continue
    }
    const take = /^(?:please\s+)?(?:remove|drop|cut|delete|take out|lose)\s+(?:the\s+)?(.{2,80})$/i.exec(c)
    if (take && !PICTURE_WORD.test(take[1])) {
      const id = partRef(take[1], parts, prev)
      if (id && id !== 'problem') e.remove.push(id)
      else e.avoid.push(clean(take[1].replace(/^(?:part|point|bit|line)s?\s+(?:about|on|of)\s+/i, ''), 60))
      continue
    }
    // things the engine cannot put in a film (an animated logo, effects, a person) are listed, never voiced as a line
    if (/^(?:please\s+)?(?:also\s+)?(?:add|put|include|make|show)\b/i.test(c) && /\b(logo|animation|animated|animate|dance|dancing|effects?|fireworks|font|transition|filter|face|person|avatar|emoji|watermark|qr)\b/i.test(low)) {
      e.cannot.push(`"${c}" is not something this film engine can make yet, so it is not in the film.`)
      continue
    }
    const sayIt = /^(?:please\s+)?(?:also\s+)?(?:say|mention|add|tell (?:them|people|viewers)|let (?:them|people) know|include)\s+(?:that\s+)?(.{4,200})$/i.exec(c)
    if (sayIt) {
      e.add.push({ say: sentence(cap(clean(sayIt[1].replace(/^["“']|["”']$/g, ''), 200))) })
      continue
    }

    // a part's words
    const lineTo = /\b(?:line|words?|text)\b.*?\b(?:to|say|says|:)\s+(.{3,200})$/i.exec(c)
    if (lineTo && !PICTURE_WORD.test(lineTo[1])) {
      const id = partRef(c.slice(0, lineTo.index + lineTo[0].length - lineTo[1].length), parts, prev)
      if (id) {
        e.lines.push({ part: id, line: sentence(clean((quoted ?? lineTo[1]).replace(/^["“']|["”']$/g, ''), 220)) })
        continue
      }
    }

    // pace of a clip
    if (/\b(slower|slow (?:it |this |that )?down|slow motion|faster|speed (?:it |this )?up|quicker)\b/i.test(low) && /\b(clip|video|footage|scene|shot|part|it)\b/i.test(low)) {
      const slow = /\b(faster|speed|quicker)\b/i.test(low) ? 0.75 : 1.5
      const id = partRef(c, parts, prev)
      const clips = parts.filter((p) => p.kind === 'clip')
      const targets = id ? [id] : clips.map((p) => p.id)
      if (!targets.length) e.cannot.push(`"${c}": this film has no video clip to ${slow > 1 ? 'slow down' : 'speed up'}.`)
      for (const t of targets) e.pace.push({ part: t, slow })
      continue
    }

    // new pictures for a part
    if (PICTURE_WORD.test(low) && /\b(different|new|another|change|redo|re-?make|replace|better|swap|show|use|instead|fresh)\b/i.test(low)) {
      const id = partRef(c, parts, prev)
      if (!id) {
        e.cannot.push(`"${c}": I could not tell which part of the film you mean. Name it, for example "the second scene".`)
        continue
      }
      const visual = /\b(?:showing|of|with|to show|that shows|so it shows)\s+(?:a\s+|an\s+|the\s+|some\s+)?(.{3,160})$/i.exec(c)?.[1]
      const show = /\b(?:as|use|with|make it)\s+an?\s+(?:ai\s+)?(?:video|clip)\b|\bvideo clip instead\b/i.test(low) ? 'clip' : /\b(?:as|use|with|make it)\s+an?\s+(?:ai\s+)?(?:picture|photo|image)s?\b/i.test(low) ? 'image' : undefined
      const v = visual && !/^(?:the|this|that)?\s*(?:scene|part|clip|shot)\b/i.test(visual) && !partRefIsWhole(visual) ? clean(visual, 160) : undefined
      e.remake.push({ part: id, ...(v ? { visual: v } : {}), ...(show ? { show } : {}) })
      continue
    }

    // a creative ask with no words given
    if (/\b(funnier|catchier|punchier|better|stronger|bolder|shorter|simpler|clearer|more \w+|less \w+|friendlier|warmer|exciting|rewrite|reword)\b/i.test(low)) {
      needsWriter(c)
      continue
    }
    e.cannot.push(`I did not understand "${c}", so it is not in the film. Try saying it another way.`)
  }
  return e
}
/** "the second scene" alone names a part, not what to show */
const partRefIsWhole = (s: string): boolean => /^(?:the\s+)?(?:\w+\s+)?(?:scene|part|shot|section)(?:\s+\d+)?$/i.test(s.trim())

/** the film as the writer is shown it */
function filmSummary(prev: PreviousRun, parts: PartView[]): string {
  const rec = prev.film
  const plan = prev.plan
  return [
    `Hook (big opening words): ${rec?.script.hook ?? '(none)'}`,
    `Problem headline: ${rec?.script.problemHeadline ?? ''}`,
    'Parts, in order:',
    ...parts.map((p) => `- id "${p.id}" — ${p.label}, shown as ${p.kind === 'clip' ? 'an AI video clip' : p.kind === 'image' ? 'AI pictures' : 'an animated card'}. Headline: "${p.headline}". Spoken: "${p.line}"${p.visual ? `. Shows: ${p.visual}` : ''}`),
    `Closing line: ${rec?.script.close ?? plan.close.say}`,
    `Call to action: ${plan.close.cta}`,
    `Never mention: ${plan.avoid.join(', ') || '(nothing)'}`,
    `Voice: ${plan.voice.none ? 'none' : `${plan.voice.tone ?? 'warm, confident'}${plan.voice.language ? `, in ${plan.voice.language}` : ''}`}`,
    `Music: ${plan.music.none ? 'none' : plan.music.description || 'chosen by the engine'}`,
    `Length: about ${plan.targetSec ?? rec?.targetSec ?? 30}s. Platform: ${plan.platform ?? 'youtube'}`,
    `Captions colour: ${rec?.style.captionColor ?? 'brand colour'}; stickers ${rec?.style.stickers === false ? 'off' : 'on'}`
  ].join('\n')
}

/** an edit from the writer, made safe: unknown parts dropped, numbers clamped, colours read */
export function normaliseEdit(raw: unknown, prev: PreviousRun): MarketEdit | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const e = emptyEdit('ai')
  const ids = new Set(partsOf(prev).map((p) => p.id))
  const points = new Set(prev.plan.points.map((p) => p.id))
  const str = (v: unknown, max: number) => clean(v, max) || undefined
  e.hook = str(r.hook, 70)
  e.hookOff = r.hookOff === true || undefined
  e.problemHeadline = str(r.problemHeadline, 30)
  e.problemLine = str(r.problemLine, 320)
  e.close = str(r.close, 180)
  e.cta = str(r.cta, 60)
  for (const l of Array.isArray(r.lines) ? r.lines : []) {
    const x = l as Record<string, unknown>
    const part = clean(x?.part, 20)
    if (!ids.has(part)) continue
    const line = str(x.line, 240)
    const headline = str(x.headline, 60)
    if (line || headline) e.lines.push({ part, ...(line ? { line } : {}), ...(headline ? { headline } : {}) })
  }
  for (const a of Array.isArray(r.add) ? r.add : []) {
    const x = a as Record<string, unknown>
    const say = str(x?.say, 220)
    if (say) e.add.push({ say, ...(points.has(clean(x.after, 20)) ? { after: clean(x.after, 20) } : {}) })
  }
  e.remove = (Array.isArray(r.remove) ? r.remove : []).map((x) => clean(x, 20)).filter((x) => points.has(x))
  const order = (Array.isArray(r.order) ? r.order : []).map((x) => clean(x, 20)).filter((x) => points.has(x))
  if (order.length >= 2 && order.join() !== prev.plan.points.map((p) => p.id).filter((id) => order.includes(id)).join()) e.order = order
  e.avoid = (Array.isArray(r.avoid) ? r.avoid : []).map((x) => clean(x, 60)).filter(Boolean)
  const v = (r.voice ?? {}) as Record<string, unknown>
  const voice: MarketEdit['voice'] = {}
  if (str(v.tone, 60)) voice.tone = str(v.tone, 60)
  if (str(v.language, 30)) voice.language = cap(str(v.language, 30)!)
  if (typeof v.none === 'boolean') voice.none = v.none
  if (Object.keys(voice).length) e.voice = voice
  const m = (r.music ?? {}) as Record<string, unknown>
  if (m.none === true) e.music = { none: true }
  else if (str(m.description, 300)) {
    const spec = readMusicSentence(`Music: ${str(m.description, 300)}`) ?? { none: false, description: str(m.description, 300)!, vocals: 'none' as const, instruments: [], exclude: [], ambience: [], quiet: false }
    e.music = { spec: { ...spec, none: false, description: str(m.description, 300)! }, remake: true, none: false }
  } else if (m.remake === true) e.music = { remake: true }
  else if (m.none === false && prev.plan.music.none) e.music = { none: false }
  const sec = Number(r.targetSec)
  if (Number.isFinite(sec) && sec > 0) e.targetSec = Math.round(Math.min(180, Math.max(6, sec)))
  if (isPlatformId(r.platform) && r.platform !== prev.plan.platform) e.platform = r.platform
  for (const x of Array.isArray(r.remake) ? r.remake : []) {
    const y = x as Record<string, unknown>
    const part = clean(y?.part, 20)
    if (!ids.has(part) || part === 'close') continue
    const visual = str(y.visual, 200)
    const show = y.show === 'clip' || y.show === 'image' ? y.show : undefined
    e.remake.push({ part, ...(visual ? { visual } : {}), ...(show ? { show } : {}) })
  }
  for (const x of Array.isArray(r.pace) ? r.pace : []) {
    const y = x as Record<string, unknown>
    const part = clean(y?.part, 20)
    const slow = Number(y?.slow)
    if (ids.has(part) && Number.isFinite(slow) && slow > 0) e.pace.push({ part, slow: Math.min(3, Math.max(0.4, slow)) })
  }
  const s = (r.style ?? {}) as Record<string, unknown>
  const col = s.captionColor === 'brighter' ? 'brighter' : colourOf(s.captionColor)
  if (col) e.style.captionColor = col
  const scale = Number(s.captionScale)
  if (Number.isFinite(scale) && scale > 0 && scale !== 1) e.style.captionScale = Math.min(1.6, Math.max(0.6, scale))
  if (typeof s.stickers === 'boolean') e.style.stickers = s.stickers
  e.cannot = (Array.isArray(r.cannot) ? r.cannot : []).map((x) => clean(x, 240)).filter(Boolean)
  return e
}

/** the request read into an edit: the AI writer first, the rules when it is missing or fails */
export async function interpretRevision(request: string, prev: PreviousRun, deps: { chat: LLMProvider | null; say?: (m: string) => void }): Promise<MarketEdit> {
  const typed = clean(request, 2000)
  if (deps.chat) {
    try {
      const parts = partsOf(prev)
      const raw = await deps.chat.generateJSON<unknown>({
        system:
          'You turn a person\'s request to change a finished short marketing film into a precise edit. The person may ask for anything. ' +
          'Write any new words yourself, ready to be spoken or shown (a funnier hook, a shorter line, a new ending), in plain warm words, no hype, no invented facts or numbers, never naming the business in the hook or the problem. ' +
          'Change ONLY what the person asked; leave every other field out. Use the part ids given. ' +
          'Text: hook (3 to 7 words), problemHeadline (2 to 4 words), problemLine, close (8 to 14 words naming the business once, ending on the call to action), cta (the short call to action), lines (new spoken line and/or headline for a part). ' +
          'Plan: add (new points to say, in the person\'s words), remove (point ids), order (all point ids in the new order), avoid (things never to mention), voice (tone, language, none), music (none, description of the new music, remake for just different music), targetSec, platform (one of tiktok, instagram-reels, youtube-shorts, youtube, instagram-feed, facebook-feed, square). ' +
          'Pictures: remake (part ids whose pictures or clip must be made again, with visual = what they should show, and show = clip or image if the person asked for that kind), pace (part id with slow: 1.5 for slower, 0.75 for faster; only parts shown as a clip). ' +
          'Style: captionColor (hex, or "brighter"), captionScale (1.25 bigger, 0.8 smaller), stickers (true/false), hookOff (true to remove the opening words). ' +
          'cannot: anything asked that none of these can do (for example changing the logo, adding a person\'s face, uploading a file, a different website), each as one short plain sentence saying what and why.',
        prompt: `The film now:\n${filmSummary(prev, parts)}\n\nWhat the person wants changed, word for word:\n"""${typed}"""`,
        schemaName: 'market_revision',
        jsonSchema: {
          type: 'object',
          properties: {
            hook: { type: 'string' },
            hookOff: { type: 'boolean' },
            problemHeadline: { type: 'string' },
            problemLine: { type: 'string' },
            close: { type: 'string' },
            cta: { type: 'string' },
            lines: { type: 'array', items: { type: 'object', properties: { part: { type: 'string' }, line: { type: 'string' }, headline: { type: 'string' } }, required: ['part'] } },
            add: { type: 'array', items: { type: 'object', properties: { say: { type: 'string' }, after: { type: 'string' } }, required: ['say'] } },
            remove: { type: 'array', items: { type: 'string' } },
            order: { type: 'array', items: { type: 'string' } },
            avoid: { type: 'array', items: { type: 'string' } },
            voice: { type: 'object', properties: { tone: { type: 'string' }, language: { type: 'string' }, none: { type: 'boolean' } } },
            music: { type: 'object', properties: { none: { type: 'boolean' }, description: { type: 'string' }, remake: { type: 'boolean' } } },
            targetSec: { type: 'number' },
            platform: { type: 'string' },
            remake: { type: 'array', items: { type: 'object', properties: { part: { type: 'string' }, visual: { type: 'string' }, show: { type: 'string' } }, required: ['part'] } },
            pace: { type: 'array', items: { type: 'object', properties: { part: { type: 'string' }, slow: { type: 'number' } }, required: ['part', 'slow'] } },
            style: { type: 'object', properties: { captionColor: { type: 'string' }, captionScale: { type: 'number' }, stickers: { type: 'boolean' } } },
            cannot: { type: 'array', items: { type: 'string' } }
          },
          required: []
        },
        temperature: 0.5,
        maxTokens: 1500
      })
      const e = normaliseEdit(raw, prev)
      if (e && (!editIsEmpty(e) || e.cannot.length)) return e
      deps.say?.('The AI writer found nothing to change; reading the request by rules.')
    } catch (err) {
      deps.say?.(`The AI writer could not read the request (${(err as Error).message.slice(0, 80)}); reading it by rules.`)
    }
  }
  return readRevisionByRules(typed, prev)
}

// ------------------------------------------------------------------ applying it

/** the short headline a line gets when none is given */
function headlineOf(line: string): string {
  const w = line.replace(/^[^\p{L}\p{N}]+/u, '').split(/\s+/).filter((x) => x.length > 2 && !/^(the|and|with|for|our|your|that|this|from)$/i.test(x))
  return w.slice(0, 4).join(' ').replace(/[.,;:!?]+$/, '')
}
const lineSec = (t: string): number => Math.max(4.2, readSec(t) + 1.5)
const estimate = (s: FilmScript): number => lineSec(s.problemLine) + s.beats.reduce((a, b) => a + lineSec(b.line), 0) + lineSec(s.close) + 0.8

export interface AppliedEdit {
  /** the plan the film follows (parts that stay animated cards are pinned as cards so no new pictures are made for them) */
  filmPlan: MarketPlan
  /** the plan as the person sees it and the review checks it */
  plan: MarketPlan
  assignment: JobAssignment
  reuse: FilmReuse
  /** what changes, in plain words */
  changed: string[]
  cannot: string[]
  /** the new AI media this needs, for the question before spending */
  spend: { voiceLines: number; pictures: number; clips: number; music: boolean; rewrite: boolean }
}

export function applyEdit(prev: PreviousRun, edit: MarketEdit, ctx: { profile: BusinessProfile; hasChat: boolean; tools: MediaTools | null; voiced: boolean }): AppliedEdit {
  const plan: MarketPlan = structuredClone(prev.plan)
  const rec = prev.film
  const assignment: JobAssignment = { ...prev.assignment }
  const changed: string[] = []
  const cannot = [...edit.cannot]
  const script: FilmScript | null = rec ? structuredClone(rec.script) : null
  let rewrite = !script
  if (!rec) changed.push('This film was made before changes could be saved with it, so every part is made again.')
  const label = (id: string): string => {
    if (id === 'problem') return 'the opening'
    const i = plan.points.findIndex((p) => p.id === id)
    return i >= 0 ? `point ${i + 1}` : id
  }
  const beatOf = (id: string): FilmBeat | undefined => script?.beats.find((b) => b.pointId === id)
  const remade = new Set<string>()

  // ---- the words
  if (edit.hookOff) {
    changed.push('The big opening words are taken off.')
  } else if (edit.hook && script) {
    script.hook = edit.hook
    changed.push(`The hook now says "${edit.hook}".`)
  }
  if (edit.problemHeadline && script) {
    script.problemHeadline = edit.problemHeadline
    changed.push(`The opening headline now says "${edit.problemHeadline}".`)
  }
  if (edit.problemLine) {
    if (script) script.problemLine = edit.problemLine
    plan.problem = { ...plan.problem, say: edit.problemLine, said: edit.problemLine }
    changed.push(`The opening line now says "${edit.problemLine}".`)
  }
  for (const l of edit.lines) {
    if (l.part === 'problem') {
      if (l.line) {
        if (script) script.problemLine = l.line
        plan.problem = { ...plan.problem, say: l.line, said: l.line }
      }
      if (l.headline && script) script.problemHeadline = l.headline
      changed.push(`The opening now says "${l.line ?? l.headline}".`)
      continue
    }
    const pt = plan.points.find((p) => p.id === l.part)
    if (!pt) continue
    if (l.line) {
      pt.say = l.line
      pt.said = l.line
    }
    const b = beatOf(l.part)
    if (b) {
      if (l.line) b.line = l.line
      b.headline = l.headline ?? (l.line ? headlineOf(l.line) || b.headline : b.headline)
    }
    changed.push(`${cap(label(l.part))} now says "${l.line ?? l.headline}".`)
  }
  if (edit.cta) {
    const was = plan.close.cta
    plan.close = { ...plan.close, cta: edit.cta, said: edit.cta }
    const name = ctx.profile.name
    const close = edit.close ?? (script && was && script.close.toLowerCase().includes(was.toLowerCase()) ? script.close.replace(new RegExp(was.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), edit.cta) : `${name}. ${sentence(edit.cta)}`)
    plan.close.say = close
    if (script) script.close = close
    changed.push(`The film now ends on "${edit.cta}".`)
  } else if (edit.close) {
    plan.close = { ...plan.close, say: edit.close }
    if (script) script.close = edit.close
    changed.push(`The closing line now says "${edit.close}".`)
  }

  // ---- the points
  for (const id of edit.remove) {
    const i = plan.points.findIndex((p) => p.id === id)
    if (i < 0) continue
    if (plan.points.length <= 1) {
      cannot.push(`${cap(label(id))} is the film's only point, so it stays.`)
      continue
    }
    changed.push(`Taken out: ${label(id)} ("${clean(plan.points[i].say, 60)}").`)
    plan.points.splice(i, 1)
    if (script) script.beats = script.beats.filter((b) => b.pointId !== id)
  }
  let nextId = Math.max(0, ...prev.plan.points.map((p) => Number(p.id.replace(/\D/g, '')) || 0), ...plan.points.map((p) => Number(p.id.replace(/\D/g, '')) || 0)) + 1
  for (const a of edit.add) {
    const id = `p${nextId++}`
    const pt: MarketPoint = { id, say: sentence(a.say), said: a.say, show: 'any', required: true }
    const at = a.after ? plan.points.findIndex((p) => p.id === a.after) + 1 : plan.points.length
    plan.points.splice(at > 0 ? at : plan.points.length, 0, pt)
    if (script) {
      const beat: FilmBeat = { headline: headlineOf(pt.say) || 'What you get', line: pt.say, chapter: 'What you get', pointId: id }
      const bAt = a.after ? script.beats.findIndex((b) => b.pointId === a.after) + 1 : script.beats.length
      script.beats.splice(bAt > 0 ? bAt : script.beats.length, 0, beat)
    }
    changed.push(`Added: "${pt.say}".`)
  }
  if (edit.order) {
    const rank = (id: string) => {
      const i = edit.order!.indexOf(id)
      return i < 0 ? 999 : i
    }
    plan.points.sort((a, b) => rank(a.id) - rank(b.id))
    if (script) script.beats.sort((a, b) => rank(a.pointId ?? '') - rank(b.pointId ?? ''))
    changed.push('The points are in a new order.')
  }
  if (edit.avoid.length) {
    plan.avoid = [...new Set([...plan.avoid, ...edit.avoid])]
    changed.push(`Never mentioned: ${edit.avoid.map((a) => `"${a}"`).join(', ')}.`)
    if (script) {
      // a point that says it goes; the opening, ending or hook that says it is written again
      for (const b of [...script.beats]) {
        if (!avoidHit(`${b.headline} ${b.line}`, edit.avoid)) continue
        if (script.beats.length > 1 && b.pointId) {
          script.beats = script.beats.filter((x) => x !== b)
          plan.points = plan.points.filter((p) => p.id !== b.pointId)
          changed.push(`Taken out the part that mentioned it: "${clean(b.line, 60)}".`)
        } else if (ctx.hasChat) rewrite = true
        else cannot.push(`"${clean(b.line, 60)}" mentions what you asked not to mention, and without the AI writer it cannot be reworded.`)
      }
      if (avoidHit(`${script.hook ?? ''} ${script.problemHeadline} ${script.problemLine} ${script.close}`, edit.avoid)) {
        if (ctx.hasChat) rewrite = true
        else cannot.push('The opening or the ending mentions what you asked not to mention, and without the AI writer it cannot be reworded.')
      }
    }
  }

  // ---- the voice
  if (edit.voice) {
    if (edit.voice.none === true && !plan.voice.none) {
      plan.voice = { ...plan.voice, none: true }
      changed.push('No voice-over: captions only.')
    } else if (edit.voice.none === false && plan.voice.none) {
      plan.voice = { ...plan.voice, none: false }
      if (assignment.voice === 'none') delete assignment.voice
      changed.push('The voice-over is back.')
    }
    if (edit.voice.tone && edit.voice.tone !== plan.voice.tone) {
      plan.voice = { ...plan.voice, tone: edit.voice.tone }
      changed.push(`The voice sounds ${edit.voice.tone}.`)
    }
    if (edit.voice.language && edit.voice.language.toLowerCase() !== (plan.voice.language ?? 'english').toLowerCase()) {
      if (ctx.hasChat) {
        plan.voice = { ...plan.voice, language: edit.voice.language }
        rewrite = true
        changed.push(`The words are written again and spoken in ${edit.voice.language}.`)
      } else cannot.push(`Speaking in ${edit.voice.language} needs the AI writer to translate the words, and it is not available, so the language is unchanged.`)
    }
  }

  // ---- the length
  if (edit.targetSec && edit.targetSec !== (prev.plan.targetSec ?? rec?.targetSec)) {
    const was = prev.plan.targetSec ?? rec?.targetSec ?? 30
    plan.targetSec = edit.targetSec
    if (plan.source === 'card') plan.source = 'rules'
    changed.push(`About ${edit.targetSec} seconds long (it was about ${Math.round(rec?.durationSec ?? was)}s).`)
    if (script) {
      if (edit.targetSec < (rec?.durationSec ?? was)) {
        // drop nice-to-have points first, so the lines already said can be used again
        const fitted = fitBeats(script, plan, edit.targetSec)
        if (fitted.dropped.length) {
          script.beats = fitted.script.beats
          changed.push(`To fit, ${fitted.dropped.length === 1 ? 'one point is' : `${fitted.dropped.length} points are`} left out.`)
        }
        if (estimate(script) > edit.targetSec * 1.25) {
          if (ctx.hasChat) rewrite = true
          else cannot.push(`Without the AI writer the lines cannot be shortened, so the film may run longer than ${edit.targetSec}s.`)
        }
      } else if (ctx.hasChat) rewrite = true
      else cannot.push(`Without the AI writer there are no new words to fill ${edit.targetSec}s, so the film stays about its old length.`)
    }
  }
  if (edit.platform && edit.platform !== plan.platform) {
    plan.platform = edit.platform
    changed.push(`Shaped for ${edit.platform.replace(/-/g, ' ')}; the pictures already made are re-framed to fit.`)
  }

  // ---- the music
  const musicWas = JSON.stringify(prev.plan.music)
  let newMusic = false
  if (edit.music) {
    if (edit.music.none === true) {
      plan.music = { ...plan.music, none: true }
      changed.push('No music.')
    } else {
      if (edit.music.spec) {
        plan.music = { ...edit.music.spec, none: false }
        changed.push(`New music: ${clean(edit.music.spec.description, 100) || 'made for the film'}.`)
      } else if (edit.music.none === false && plan.music.none) {
        plan.music = { ...plan.music, none: false }
        changed.push('The music is back.')
      } else if (edit.music.remake) changed.push('Different music.')
      if (assignment.music === 'none' || (edit.music.spec && /^builtin/.test(assignment.music ?? ''))) delete assignment.music
      newMusic = !!edit.music.remake || !!edit.music.spec || (edit.music.none === false && prev.plan.music.none)
    }
  }

  // ---- the pictures
  const parts = rec?.parts ?? []
  for (const r of edit.remake) {
    remade.add(r.part)
    if (r.part === 'problem') {
      plan.problem = { ...plan.problem, ...(r.visual ? { visual: r.visual } : {}), ...(r.show === 'clip' ? { show: 'clip' as const } : {}) }
    } else {
      const pt = plan.points.find((p) => p.id === r.part)
      if (!pt) continue
      if (r.visual) pt.visual = r.visual
      if (r.show) pt.show = r.show
      const b = beatOf(r.part)
      if (b && r.visual) b.visual = r.visual
    }
    if ((r.show === 'clip' || parts.find((p) => p.id === r.part)?.kind === 'clip') && (assignment.video === 'none' || assignment.video === 'skip')) delete assignment.video
    const what = r.visual ? ` showing ${r.visual}` : ''
    if (!ctx.tools) cannot.push(`New AI pictures for ${label(r.part)} are not available on this account, so it is drawn as an animated card${what ? ' instead' : ''}.`)
    changed.push(`New ${r.show === 'clip' ? 'video clip' : r.show === 'image' ? 'pictures' : 'pictures'} for ${label(r.part)}${what}.`)
  }
  const shots: Record<string, PieceShot[]> = {}
  for (const p of parts) {
    if (remade.has(p.id) || !p.shots.length) continue
    if (p.id !== 'problem' && !plan.points.some((x) => x.id === p.id)) continue
    const pace = edit.pace.find((x) => x.part === p.id)
    shots[p.id] = pace ? p.shots.map((s) => (s.kind === 'clip' ? { ...s, slow: pace.slow } : s)) : p.shots
  }
  for (const pc of edit.pace) {
    const part = parts.find((p) => p.id === pc.part)
    if (!part?.shots.some((s) => s.kind === 'clip')) {
      cannot.push(`${cap(label(pc.part))} has no video clip to ${pc.slow > 1 ? 'slow down' : 'speed up'}.`)
      continue
    }
    if (remade.has(pc.part)) continue
    changed.push(`The clip in ${label(pc.part)} plays ${pc.slow > 1 ? 'slower' : 'faster'}.`)
  }

  // ---- the look of the words
  const style: FilmStyle = { ...(rec?.style ?? {}) }
  if (edit.hookOff) style.hook = false
  else if (edit.hook) style.hook = true
  if (edit.style.captionColor) {
    const base = style.captionColor ?? `#${(ctx.profile.brand.accent ?? 'f5a524').replace('#', '')}`
    style.captionColor = edit.style.captionColor === 'brighter' ? lighter(base, 0.55) : edit.style.captionColor
    changed.push(`Caption colour ${style.captionColor}.`)
  }
  if (edit.style.captionScale) {
    style.captionScale = Math.min(1.6, Math.max(0.6, (style.captionScale ?? 1) * edit.style.captionScale))
    changed.push(`Captions ${edit.style.captionScale > 1 ? 'bigger' : 'smaller'}.`)
  }
  if (edit.style.stickers !== undefined && edit.style.stickers !== (style.stickers !== false)) {
    style.stickers = edit.style.stickers
    changed.push(edit.style.stickers ? 'Stickers are back.' : 'No stickers.')
  }

  // ---- what is used again
  const reuse: FilmReuse = { shots, style, ...(rec?.voices.length ? { voices: rec.voices } : {}) }
  if (script && !rewrite) reuse.script = script
  const musicSame = JSON.stringify(plan.music) === musicWas && !newMusic
  if (rec && musicSame && !plan.music.none) {
    if (rec.music.file && existsSync(rec.music.file) && (plan.targetSec ?? 0) <= Math.max(rec.durationSec, rec.targetSec) + 2) {
      reuse.music = rec.music.file
      if (rec.music.model) reuse.musicModel = rec.music.model
    }
    if (rec.music.mood) reuse.musicMood = rec.music.mood
  }

  // parts that were animated cards and are not made again stay cards: no new pictures are made for them
  const filmPlan: MarketPlan = structuredClone(plan)
  if (rec) {
    for (const pt of filmPlan.points) {
      const before = parts.find((p) => p.id === pt.id)
      if (before && before.kind === 'scene' && !remade.has(pt.id)) pt.show = 'scene'
    }
    if (!remade.has('problem') && parts[0]?.kind === 'scene') filmPlan.problem = { ...filmPlan.problem, show: 'scene' }
  }

  // ---- what it costs: lines not said before, parts with no pictures to reuse, new music
  const said = new Set((rec?.voices ?? []).map((v) => v.text.trim()))
  const toneSame = plan.voice.tone === prev.plan.voice.tone && plan.voice.language === prev.plan.voice.language
  const lines = script && !rewrite ? [script.problemLine, ...script.beats.map((b) => b.line), script.close] : []
  const voiceLines = !ctx.voiced || plan.voice.none ? 0 : rewrite ? plan.points.length + 2 : lines.filter((l) => !toneSame || !said.has(l.trim())).length
  let pictures = 0
  let clips = 0
  if (ctx.tools) {
    const ids = ['problem', ...plan.points.map((p) => p.id)]
    for (const id of ids) {
      if (shots[id]) continue
      const before = parts.find((p) => p.id === id)
      const show = id === 'problem' ? filmPlan.problem.show : filmPlan.points.find((p) => p.id === id)?.show
      if (show === 'scene' || (id === 'problem' && show !== 'clip')) continue
      if (show === 'clip' || (before?.kind === 'clip' && remade.has(id))) {
        clips++
        pictures += 1
      } else if (ctx.tools.still) pictures += 3
    }
  }
  const music = !!ctx.tools?.music && !plan.music.none && !reuse.music && (newMusic || (rec?.music.source === 'ai'))
  if (!changed.length && !cannot.length) changed.push('Nothing to change was found, so the film is made again as it was.')
  return { filmPlan, plan, assignment, reuse, changed, cannot, spend: { voiceLines, pictures, clips, music, rewrite } }
}

// ------------------------------------------------------------------ the whole revision

export interface ReviseInput {
  prev: PreviousRun
  request: string
  runDir: string
  profile: BusinessProfile
  card: VideoCard
  chat: LLMProvider | null
  speech: SpeechProvider | null
  tools: MediaTools | null
  maxClips: number
  hooks: MarketPariHooks
  filmmaker?: typeof runMarketingFilm
  signal?: AbortSignal
  progress: (stage: MarketStage, message: string) => void
  log?: (m: string) => void
}

export interface ReviseOutcome {
  out: FilmResult
  report: MarketReport
  revision: MarketRevision
}

/** the spending question: "this needs N new pictures, a clip and new music — make them?" */
export function spendRequest(spend: AppliedEdit['spend']): DecisionRequest | null {
  const bits: string[] = []
  if (spend.clips) bits.push(`${spend.clips} new AI video clip${spend.clips === 1 ? '' : 's'}`)
  if (spend.pictures) bits.push(`about ${spend.pictures} new AI picture${spend.pictures === 1 ? '' : 's'}`)
  if (spend.music) bits.push('new AI music')
  if (spend.voiceLines) bits.push(`${spend.voiceLines} new voice line${spend.voiceLines === 1 ? '' : 's'}`)
  if (spend.rewrite) bits.push('the words written again by the AI writer')
  if (!bits.length) return null
  const media = spend.clips + spend.pictures > 0 || spend.music
  return {
    id: 'revise-spend',
    topic: 'plan',
    question: 'Your changes need some new AI work. Make it?',
    context: `This needs ${bits.join(', ')}. Everything else is used again from the earlier film.`,
    options: [
      { id: 'make', label: 'Yes, make the new parts', detail: 'Uses your plan for the new parts only.', recommended: true },
      ...(media ? [{ id: 'free', label: 'Use free animated cards and the built-in music for the new parts', detail: 'No new AI pictures, clips or music; the voice still says any new words.' }] : []),
      { id: 'stop', label: 'Stop, I will change my request', detail: 'Nothing new is made.' }
    ],
    autopick: 'make'
  }
}

export async function reviseFilm(inp: ReviseInput): Promise<ReviseOutcome> {
  const say = (m: string) => inp.log?.(m)
  const { prev, hooks } = inp
  inp.progress('plan', 'Reading what you want changed')
  const edit = await interpretRevision(inp.request, prev, { chat: inp.chat, say })
  say(`Change request read ${edit.source === 'ai' ? 'by the AI writer' : 'by rules'}.`)
  const applied = applyEdit(prev, edit, { profile: inp.profile, hasChat: !!inp.chat, tools: inp.tools, voiced: !!inp.speech })
  for (const c of applied.changed) say(`Change: ${c}`)
  for (const c of applied.cannot) say(`Cannot: ${c}`)
  hooks.emit({ kind: 'pari-plan', plan: applied.plan, capabilities: hooks.capabilities })

  // ask before anything new is paid for (autopilot takes "make" and shows it)
  const answers: DecisionAnswer[] = []
  let tools = inp.tools
  let aiMusic = !!inp.tools?.music
  const req = spendRequest(applied.spend)
  if (req && (inp.tools || inp.speech || inp.chat)) {
    hooks.emit({ kind: 'pari-decide', requests: [req], auto: hooks.mode === 'autopilot' })
    const got = hooks.mode === 'autopilot' ? [{ id: req.id, option: req.autopick, auto: true }] : await hooks.decide([req])
    if (!got) throw new MarketStopped('You stopped the change before anything was made.')
    answers.push(...got)
    const pick = got.find((a) => a.id === req.id)?.option ?? req.autopick
    if (pick === 'stop') throw new MarketStopped('You chose to change your request, so nothing new was made.')
    if (pick === 'free') {
      tools = null
      aiMusic = false
      applied.cannot.push('You chose free animated cards and the built-in music for the new parts, so no new AI pictures, clips or music were made.')
    }
  }
  writeFileSync(join(inp.runDir, 'market-plan.json'), JSON.stringify({ plan: applied.plan, assignment: applied.assignment, decisions: answers, revision: { request: inp.request, parentRunId: prev.runId, edit } }, null, 2))

  const out = await (inp.filmmaker ?? runMarketingFilm)({
    runDir: inp.runDir,
    card: inp.card,
    profile: inp.profile,
    chat: inp.chat,
    speech: inp.speech,
    tools,
    aiMusic,
    maxClips: inp.maxClips,
    plan: applied.filmPlan,
    assignment: applied.assignment,
    reuse: applied.reuse,
    signal: inp.signal,
    progress: inp.progress,
    log: inp.log
  })

  // what was used again, in plain words
  const kept: string[] = []
  const r = out.reused
  if (r) {
    const total = out.made.length
    if (r.voices) kept.push(`${r.voices} of ${total} voice line${total === 1 ? '' : 's'}, unchanged, were not said again.`)
    if (r.parts.length) kept.push(`The pictures of ${r.parts.map((id) => (id === 'problem' ? 'the opening' : `point ${applied.plan.points.findIndex((p) => p.id === id) + 1}`)).join(', ')} were used again.`)
    if (r.music) kept.push('The same music was used again.')
  }
  if (applied.reuse.script) kept.push('The words you did not ask to change are the same.')
  const revision: MarketRevision = { request: clean(inp.request, 2000), parentRunId: prev.runId, changed: applied.changed, kept, cannot: applied.cannot, source: edit.source }

  const review = reviewFilm(applied.plan, { made: out.made ?? [], dropped: out.dropped ?? [], durationSec: out.durationSec, musicSource: out.musicSource ?? 'none', voiced: !!out.voiced, written: !!out.written })
  for (const c of review.checks) hooks.emit({ kind: 'pari-check', check: c })
  const report = buildReport(applied.plan, { assignment: applied.assignment, answers }, review, out.durationSec)
  report.shortfalls.unshift(...applied.cannot)
  report.revision = revision
  hooks.emit({ kind: 'pari-report', report })
  writeFileSync(join(inp.runDir, 'market-report.json'), JSON.stringify(report, null, 2))
  return { out, report, revision }
}

