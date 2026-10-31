import { z } from 'zod'
import { AI_CLIP_MAX, AI_CLIP_MAX_SEC, AI_CLIP_MIN_SEC, EditPlan, MAX_SHORTS, MUSIC_MOODS, planDuration, type FootageClip, type MusicChoice, type PlanRequest, type PlanSegment, type PlanTitle } from '../../shared/footage'
import type { LLMProvider } from '../providers/types'

/**
 * The AI editor's brain: reads what the footage shows and says, and returns an
 * edit decision list (which part of which clip, in what order, with what music).
 * Everything the model returns is clamped to real footage afterwards, so a bad
 * answer can shorten or drop a shot but can never point outside a clip.
 */

const MAX_CATALOG_CHARS = 110_000
const MAX_TOTAL_SEC = 600
const MIN_SEGMENT_SEC = 0.6
/** a cut inside a spoken sentence is moved to its edge when that is this close */
const SNAP_SEC = 4

const ModelPlan = z.object({
  title: z.string().default('My edit'),
  segments: z.array(
    z.object({
      clip: z.string().optional(),
      start: z.number().optional(),
      end: z.number().optional(),
      /** an AI-made scene instead of footage: what it shows, and how long (3-8 s) */
      aiPrompt: z.string().optional(),
      aiSec: z.number().optional(),
      speed: z.number().optional(),
      keepAudio: z.boolean().optional(),
      fade: z.boolean().optional(),
      why: z.string().optional()
    })
  ),
  music: z.enum(['none', 'auto']).default('auto'),
  musicMood: z.string().default('upbeat'),
  titles: z
    .array(z.object({ text: z.string(), start: z.number(), end: z.number(), position: z.string().optional() }))
    .default([]),
  notes: z.array(z.string()).default([])
})
type ModelPlan = z.infer<typeof ModelPlan>

const SYSTEM = `You are the editor of an automated video studio. The person gives you the raw footage they filmed (already indexed: each clip is cut into shots with a short description and a 1-10 quality score, plus a transcript of any speech) and a brief. Decide the edit.

Rules:
- Use ONLY the clips and times you are given. A segment is {clip, start, end} in seconds inside that clip. Never go beyond a clip's length.
- Build a story, not a slideshow: a strong opening, a logical order, a clear ending. Follow the brief first; use chronological order only when the brief suggests a timeline.
- Prefer high-scoring shots. Avoid black, blurry or accidental shots (low scores) unless nothing else covers the brief.
- Keep segments between 1.5 and 8 seconds unless a whole speech line needs longer. Fast, energetic briefs use shorter segments, calm ones longer.
- Never start or end a segment in the middle of a spoken sentence when keepAudio is true: use the transcript times as cut points.
- keepAudio: true where the clip's own sound matters (speech, a key moment's ambience); false for b-roll that should sit under music. If music is wanted and a shot has no speech, prefer keepAudio false.
- speed: 1 by default; use 0.5 to 0.75 for slow motion on a dramatic moment or up to 2 for boring stretches, only when it helps.
- fade: true to crossfade from the previous segment (use rarely: between different places or moods); false for a straight cut.
- Match the requested total length closely (within about 10%). If a length is not given, choose what suits the brief and the footage.
- aiClips: when the request says AI scenes are allowed, you may replace a missing scene with {aiPrompt, aiSec} (no clip/start/end): aiSec 3 to 8, aiPrompt a vivid one-sentence description of the picture and camera movement, matching the look of the footage, with no readable text and no real people's names. Use them only where the footage truly cannot show what the brief needs, at most the number allowed; each costs money. Otherwise never use aiPrompt.
- Do not repeat the same part of a clip. Do not invent footage. If the brief asks for something the footage cannot provide, do the best you can and say so in notes.
- music: 'none' for a brief that wants natural sound only, otherwise 'auto'; musicMood is one of ${MUSIC_MOODS.join(', ')}.
- notes: up to 3 short plain-language remarks for the person about choices or things that were not possible. No technical terms.
- title: a short title for the edit.
- titles: on-screen text over the finished video, timed in seconds of the FINISHED edit (not of the clips). Only when "titles" in the request is "wanted": an opening title in the first 3 seconds (max 6 words), and optionally up to 3 short labels (names, places, key points) that the footage clearly supports. Each 2-4 seconds long, never overlapping, position top, center or bottom. Never invent facts. Use [] when titles are not wanted.
Return only the JSON object.`

function jsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ModelPlan, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
}

interface Catalog {
  refs: Map<string, FootageClip>
  clips: unknown[]
  trimmedNote?: string
}

const orient = (c: FootageClip) => (c.width > c.height * 1.1 ? 'landscape' : c.height > c.width * 1.1 ? 'portrait' : 'square')
const r1 = (n: number) => Math.round(n * 10) / 10

/** a compact, token-cheap description of the footage; shrinks step by step until it fits the budget */
export function buildCatalog(clips: FootageClip[], budgetChars = MAX_CATALOG_CHARS): Catalog {
  const usable = clips.filter((c) => c.status === 'ok')
  const refs = new Map<string, FootageClip>()
  usable.forEach((c, i) => refs.set(`c${i + 1}`, c))
  const make = (opts: { speechChars: number; minScore: number; maxClips: number }) => {
    const out: unknown[] = []
    let n = 0
    for (const [ref, c] of refs) {
      if (n++ >= opts.maxClips) break
      out.push({
        ref,
        name: c.name,
        len: r1(c.durationSec),
        shape: orient(c),
        sound: c.hasAudio && c.lufs !== undefined,
        shots: c.shots
          .filter((s) => (s.score ?? 5) >= opts.minScore)
          .map((s) => [r1(s.startSec), r1(s.endSec), s.score ?? null, s.description ?? ''] as const),
        speech: (c.transcript ?? []).map((l) => [r1(l.startSec), r1(l.endSec), l.text.slice(0, opts.speechChars)] as const)
      })
    }
    return out
  }
  const steps = [
    { speechChars: 220, minScore: 0, maxClips: 1e9 },
    { speechChars: 90, minScore: 0, maxClips: 1e9 },
    { speechChars: 60, minScore: 4, maxClips: 1e9 },
    { speechChars: 40, minScore: 5, maxClips: 60 },
    { speechChars: 30, minScore: 6, maxClips: 30 }
  ]
  for (const [i, step] of steps.entries()) {
    const list = make(step)
    if (JSON.stringify(list).length <= budgetChars || i === steps.length - 1) {
      return { refs, clips: list, ...(i > 0 ? { trimmedNote: 'There is a lot of footage, so the editor looked mainly at the best shots.' } : {}) }
    }
  }
  return { refs, clips: [] }
}

export interface PlanOutcome {
  plan: EditPlan
  source: 'ai' | 'basic'
}

export async function planEdit(provider: LLMProvider, clips: FootageClip[], req: PlanRequest): Promise<PlanOutcome> {
  const usable = clips.filter((c) => c.status === 'ok')
  if (!usable.length) throw new Error('Add a folder with videos first, then ask for an edit.')
  if (provider.id === 'mock') return { plan: heuristicPlan(usable, req, 'The free offline editor spread the shots evenly. Connect an AI provider in Settings to have the editor pick the best moments.'), source: 'basic' }
  const catalog = buildCatalog(usable)
  const payload = {
    brief: req.prompt,
    shape: req.shape,
    targetLengthSec: req.durationSec && req.durationSec > 0 ? req.durationSec : 'your choice',
    titles: req.titles === false ? 'none' : 'wanted',
    aiClips: req.aiClips ? `allowed, at most ${Math.min(AI_CLIP_MAX, 2)}` : 'not allowed',
    music: req.music === 'auto-mood' ? 'your choice' : req.music.mode === 'none' ? 'none: the person wants natural sound only' : req.music.mode === 'file' ? 'the person will use their own track' : `an original score, mood ${req.music.mood}`,
    clips: catalog.clips
  }
  let correction: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await provider.generateJSON<unknown>({
        system: SYSTEM,
        prompt: JSON.stringify(correction ? { ...payload, correction } : payload),
        schemaName: 'EditDecisionList',
        jsonSchema: jsonSchema(),
        temperature: attempt === 0 ? 0.5 : 0.2,
        maxTokens: 6000
      })
      const parsed = ModelPlan.parse(raw)
      const plan = sanitize(parsed, catalog.refs, req)
      if (plan.segments.length) {
        if (catalog.trimmedNote) plan.notes.push(catalog.trimmedNote)
        return { plan, source: 'ai' }
      }
      correction = 'Your last answer used no valid clip or time range. Use only the clip refs and times given.'
    } catch (err) {
      correction = `Your last answer was invalid: ${String((err as Error)?.message ?? err).slice(0, 400)}. Return a corrected JSON object.`
    }
  }
  return { plan: heuristicPlan(usable, req, 'The AI editor could not produce a usable plan this time, so the shots were spread evenly. Try again, or rephrase your brief.'), source: 'basic' }
}

function musicFor(req: PlanRequest, model?: { music: 'none' | 'auto'; musicMood: string }): MusicChoice {
  if (req.music !== 'auto-mood') return req.music
  if (!model) return { mode: 'auto', mood: 'upbeat' }
  const mood = (MUSIC_MOODS as readonly string[]).includes(model.musicMood) ? (model.musicMood as MusicChoice['mood']) : 'upbeat'
  return { mode: model.music === 'none' ? 'none' : 'auto', mood }
}

/** model output → a plan that is guaranteed to point at real footage and fit the length */
export function sanitize(model: ModelPlan, refs: Map<string, FootageClip>, req: PlanRequest): EditPlan {
  const notes = model.notes.map((n) => n.trim()).filter(Boolean).slice(0, 4)
  let segments: PlanSegment[] = []
  let aiCount = 0
  for (const s of model.segments) {
    if (s.aiPrompt) {
      const prompt = s.aiPrompt.replace(/\s+/g, ' ').trim().slice(0, 600)
      if (!req.aiClips || prompt.length < 3 || aiCount >= Math.min(AI_CLIP_MAX, 2)) continue
      aiCount++
      const sec = Math.round(Math.max(AI_CLIP_MIN_SEC, Math.min(AI_CLIP_MAX_SEC, Number.isFinite(s.aiSec) ? (s.aiSec as number) : 5)))
      segments.push({ clipId: `ai-${aiCount}`, startSec: 0, endSec: sec, speed: 1, keepAudio: false, transition: s.fade ? 'fade' : 'cut', why: (s.why ?? 'Made by AI: the footage has nothing for this').trim().slice(0, 160), ai: { prompt } })
      continue
    }
    const clip = refs.get(String(s.clip))
    if (!clip) continue
    const start = Math.max(0, Math.min(clip.durationSec, Number(s.start)))
    const end = Math.max(0, Math.min(clip.durationSec, Number(s.end)))
    if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < MIN_SEGMENT_SEC) continue
    const keepAudio = clip.hasAudio && clip.lufs !== undefined ? s.keepAudio ?? true : false
    const seg: PlanSegment = {
      clipId: clip.id,
      startSec: round2(start),
      endSec: round2(end),
      speed: Math.max(0.25, Math.min(4, Number.isFinite(s.speed) ? (s.speed as number) : 1)),
      keepAudio,
      transition: s.fade ? 'fade' : 'cut',
      why: (s.why ?? '').trim().slice(0, 160)
    }
    segments.push(keepAudio ? snapToSpeech(seg, clip) : seg)
  }
  segments = segments.filter((s) => s.endSec - s.startSec >= MIN_SEGMENT_SEC)
  segments = renumberAi(segments)
  if (segments[0]) segments[0] = { ...segments[0], transition: 'cut' }
  segments = fitLength(segments, req.durationSec && req.durationSec > 0 ? req.durationSec : MAX_TOTAL_SEC)
  const total = planDuration({ segments })
  if (req.durationSec && req.durationSec > 0 && total < req.durationSec * 0.7 && segments.length) {
    notes.push(`The footage only covered about ${Math.round(total)} of the ${req.durationSec} seconds you asked for.`)
  }
  return EditPlan.parse({
    title: model.title.trim().slice(0, 80) || 'My edit',
    shape: req.shape,
    segments,
    music: musicFor(req, model),
    loudness: req.loudness ?? 'social',
    captions: req.captions ?? 'off',
    titles: req.titles === false ? [] : sanitizeTitles(model.titles ?? [], total),
    notes
  })
}

/** model titles → a few short, non-overlapping on-screen texts inside the video */
export function sanitizeTitles(raw: ModelPlan['titles'], totalSec: number): PlanTitle[] {
  const out: PlanTitle[] = []
  for (const t of [...raw].sort((a, b) => a.start - b.start)) {
    const text = String(t.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
    const start = Math.max(0, Number(t.start))
    const end = Math.min(totalSec, Number(t.end))
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || end - start < 1 || start >= totalSec - 1) continue
    if (out.length && start < out[out.length - 1].endSec) continue
    const position = t.position === 'top' || t.position === 'bottom' ? t.position : 'center'
    out.push({ text, startSec: round2(start), endSec: round2(Math.min(end, start + 5)), position })
    if (out.length >= 4) break
  }
  return out
}

/** keep a spoken sentence whole: nudge a cut that lands inside a transcript line to its edge */
function snapToSpeech(seg: PlanSegment, clip: FootageClip): PlanSegment {
  let { startSec, endSec } = seg
  for (const l of clip.transcript ?? []) {
    // a cut inside a sentence moves to the sentence edge nearest in time: out to the edge when that is a short way, otherwise in past the sentence
    if (l.startSec < startSec && startSec < l.endSec) {
      const forward = Math.min(l.endSec, endSec)
      startSec = startSec - l.startSec <= SNAP_SEC || endSec - forward < 1.5 ? l.startSec : forward
    }
    if (l.startSec < endSec && endSec < l.endSec) {
      const back = Math.max(l.startSec, startSec)
      endSec = l.endSec - endSec <= SNAP_SEC || back - startSec < 1.5 ? Math.min(l.endSec, clip.durationSec) : back
    }
  }
  return { ...seg, startSec: round2(Math.max(0, startSec)), endSec: round2(Math.min(clip.durationSec, endSec)) }
}

/** shorten the longest shots first, then drop from the end, until the edit fits the length */
export function fitLength(segments: PlanSegment[], targetSec: number): PlanSegment[] {
  const limit = targetSec * 1.05 + 0.25
  const out = segments.map((s) => ({ ...s }))
  const len = (s: PlanSegment) => (s.endSec - s.startSec) / s.speed
  for (let guard = 0; guard < 500 && planDuration({ segments: out }) > limit; guard++) {
    const excess = planDuration({ segments: out }) - targetSec
    let longest = -1
    out.forEach((s, i) => {
      if (len(s) > 1.8 && (longest < 0 || len(s) > len(out[longest]))) longest = i
    })
    if (longest < 0) {
      out.pop()
      continue
    }
    const s = out[longest]
    const cut = Math.min(excess, len(s) - 1.5) * s.speed
    s.endSec = round2(Math.max(s.startSec + MIN_SEGMENT_SEC, s.endSec - cut))
  }
  return out
}

/** no AI: an even, chronological spread of the best-looking shots */
export function heuristicPlan(clips: FootageClip[], req: PlanRequest, note: string): EditPlan {
  const usable = clips.filter((c) => c.status === 'ok')
  const totalFootage = usable.reduce((a, c) => a + c.durationSec, 0)
  const target = req.durationSec && req.durationSec > 0 ? Math.min(req.durationSec, totalFootage) : Math.min(30, totalFootage)
  const n = Math.max(1, Math.min(30, Math.round(target / 3.5)))
  const per = target / n
  type Cand = { clip: FootageClip; ci: number; start: number; end: number; score: number }
  const cands: Cand[] = []
  usable.forEach((clip, ci) => {
    clip.shots.forEach((s) => cands.push({ clip, ci, start: s.startSec, end: s.endSec, score: s.score ?? 5 }))
  })
  // best first, but never let one clip dominate: at most ceil(n / clips) + 1 each
  const cap = Math.ceil(n / usable.length) + 1
  const taken = new Map<string, number>()
  const picked: Cand[] = []
  for (const c of [...cands].sort((a, b) => b.score - a.score || a.ci - b.ci || a.start - b.start)) {
    if (picked.length >= n) break
    if ((taken.get(c.clip.id) ?? 0) >= cap) continue
    taken.set(c.clip.id, (taken.get(c.clip.id) ?? 0) + 1)
    picked.push(c)
  }
  picked.sort((a, b) => a.ci - b.ci || a.start - b.start)
  const segments: PlanSegment[] = picked.map((c) => {
    const room = c.end - c.start
    const dur = Math.min(per, room)
    const start = c.start + (room - dur) / 2
    const withSound = c.clip.hasAudio && c.clip.lufs !== undefined
    return { clipId: c.clip.id, startSec: round2(start), endSec: round2(start + dur), speed: 1, keepAudio: withSound, transition: 'cut', why: '' }
  })
  return EditPlan.parse({
    title: 'My edit',
    shape: req.shape,
    segments: fitLength(segments, target),
    music: musicFor(req),
    loudness: req.loudness ?? 'social',
    captions: req.captions ?? 'off',
    notes: [note]
  })
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** AI scenes keep ids ai-1, ai-2… in the order they appear (after other segments were dropped or fitted away) */
function renumberAi(segments: PlanSegment[]): PlanSegment[] {
  let n = 0
  return segments.map((s) => (s.ai ? { ...s, clipId: `ai-${++n}` } : s))
}

// ---------------------------------------------------------------- several shorts

const ShortsModel = z.object({
  shorts: z.array(
    z.object({
      title: z.string().default('Short'),
      segments: z.array(z.object({ clip: z.string(), start: z.number(), end: z.number(), speed: z.number().optional(), keepAudio: z.boolean().optional(), why: z.string().optional() })),
      musicMood: z.string().default('upbeat')
    })
  ),
  notes: z.array(z.string()).default([])
})

const SHORTS_SYSTEM = `You are the editor of an automated video studio. The person gives you a long recording (already indexed: shots with descriptions and quality scores, plus a transcript) and asks for several separate short videos cut from it. Decide each short.

Rules:
- Use ONLY the clips and times you are given. A segment is {clip, start, end} in seconds inside that clip.
- Each short must stand on its own: one idea, a hook in the first 3 seconds (a surprising line, a question, the most striking shot), a clean ending. A person who sees only that short must understand it.
- Shorts must NOT reuse the same part of the footage: no two shorts may overlap in time on the same clip.
- Prefer the best moments: strong speech, high-scoring shots. Skip filler, false starts and dead air.
- Never start or end a segment in the middle of a spoken sentence: use the transcript times as cut points. For talking footage prefer a few long segments (5-25 seconds) over many tiny ones.
- Aim for the requested length per short (within about 15%).
- keepAudio true for talking, false for b-roll. speed 1 unless slow motion helps.
- title: a short, catchy title for each short. musicMood is one of ${MUSIC_MOODS.join(', ')}.
- notes: up to 3 short plain-language remarks. If the footage only supports fewer good shorts than asked, return fewer.
Return only the JSON object.`

export interface ShortsOutcome {
  plans: EditPlan[]
  source: 'ai' | 'basic'
}

/** several separate shorts from the same footage; overlapping parts are removed so no moment is used twice */
export async function planShorts(provider: LLMProvider, clips: FootageClip[], req: PlanRequest): Promise<ShortsOutcome> {
  const usable = clips.filter((c) => c.status === 'ok')
  if (!usable.length) throw new Error('Add a folder with videos first, then ask for an edit.')
  const count = Math.max(2, Math.min(MAX_SHORTS, Math.round(req.shorts ?? 3)))
  const each = req.durationSec && req.durationSec > 0 ? req.durationSec : 45
  const noAi = { ...req, aiClips: false, durationSec: each }
  if (provider.id === 'mock') return { plans: heuristicShorts(usable, noAi, count, 'The free offline editor split the footage into equal parts. Connect an AI provider in Settings to have the editor pick the best moments.'), source: 'basic' }
  const catalog = buildCatalog(usable)
  const payload = { brief: req.prompt, shortsWanted: count, lengthOfEachSec: each, shape: req.shape, clips: catalog.clips }
  let correction: string | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await provider.generateJSON<unknown>({
        system: SHORTS_SYSTEM,
        prompt: JSON.stringify(correction ? { ...payload, correction } : payload),
        schemaName: 'ShortsDecisionList',
        jsonSchema: z.toJSONSchema(ShortsModel, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
        temperature: attempt === 0 ? 0.5 : 0.2,
        maxTokens: 9000
      })
      const parsed = ShortsModel.parse(raw)
      const used: Array<{ clip: string; a: number; b: number }> = []
      const plans: EditPlan[] = []
      for (const sh of parsed.shorts.slice(0, count)) {
        // drop any part that overlaps something an earlier short already uses
        const free = sh.segments.filter((s) => {
          const clip = catalog.refs.get(String(s.clip))
          if (!clip) return false
          const hit = used.some((u) => u.clip === clip.id && s.start < u.b && s.end > u.a)
          if (!hit) used.push({ clip: clip.id, a: s.start, b: s.end })
          return !hit
        })
        const plan = sanitize({ title: sh.title, segments: free, music: 'auto', musicMood: sh.musicMood, titles: [], notes: [] }, catalog.refs, noAi)
        if (plan.segments.length) plans.push({ ...plan, notes: [] })
      }
      if (plans.length) {
        const notes = parsed.notes.map((n) => n.trim()).filter(Boolean).slice(0, 3)
        if (plans.length < count) notes.push(`Only ${plans.length} good short${plans.length > 1 ? 's' : ''} could be found in this footage.`)
        plans[0] = { ...plans[0], notes }
        return { plans, source: 'ai' }
      }
      correction = 'Your last answer used no valid clip or time range. Use only the clip refs and times given.'
    } catch (err) {
      correction = `Your last answer was invalid: ${String((err as Error)?.message ?? err).slice(0, 400)}. Return a corrected JSON object.`
    }
  }
  return { plans: heuristicShorts(usable, noAi, count, 'The AI editor could not produce usable shorts this time, so the footage was split into equal parts. Try again, or rephrase your brief.'), source: 'basic' }
}

/** no AI: the footage in order, cut into equal runs of shots, one short per run */
export function heuristicShorts(clips: FootageClip[], req: PlanRequest, count: number, note: string): EditPlan[] {
  const usable = clips.filter((c) => c.status === 'ok')
  const each = req.durationSec && req.durationSec > 0 ? req.durationSec : 45
  type Cand = { clip: FootageClip; start: number; end: number }
  const cands: Cand[] = []
  for (const clip of usable) for (const s of clip.shots.length ? clip.shots : [{ startSec: 0, endSec: clip.durationSec }]) if (s.endSec - s.startSec >= MIN_SEGMENT_SEC) cands.push({ clip, start: s.startSec, end: s.endSec })
  const total = cands.reduce((a, c) => a + (c.end - c.start), 0)
  const n = Math.max(1, Math.min(count, Math.floor(total / Math.max(5, Math.min(each, 10)))))
  const plans: EditPlan[] = []
  let at = 0
  const perRun = total / n
  for (let k = 0; k < n; k++) {
    const run: Cand[] = []
    let len = 0
    while (at < cands.length && (len < perRun - 0.01 || k === n - 1)) {
      run.push(cands[at])
      len += cands[at].end - cands[at].start
      at++
    }
    let left = each
    const segments: PlanSegment[] = []
    for (const c of run) {
      if (left < MIN_SEGMENT_SEC) break
      const dur = Math.min(c.end - c.start, left, 8)
      const withSound = c.clip.hasAudio && c.clip.lufs !== undefined
      segments.push({ clipId: c.clip.id, startSec: round2(c.start), endSec: round2(c.start + dur), speed: 1, keepAudio: withSound, transition: 'cut', why: '' })
      left -= dur
    }
    if (segments.length) plans.push(EditPlan.parse({ title: `Short ${plans.length + 1}`, shape: req.shape, segments, music: musicFor(req), loudness: req.loudness ?? 'social', captions: req.captions ?? 'off', notes: plans.length === 0 ? [note] : [] }))
  }
  return plans
}
