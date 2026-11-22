import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { EMOTIONS, SHOT_DEFECTS, type FootageCastMember, type FootageClip, type FootageShot, type ShotDefect, type Span, type TranscriptLine, type UnderstandEstimate } from '../../shared/footage'
import { priceUsage } from '../../shared/pricing'
import type { LLMProvider } from '../providers/types'
import { meter } from '../usage/meter'
import { route } from '../license/route'
import { runFfmpeg } from './ffmpeg'
import { hintDefects, inspectShot } from './inspect'
import { detectSilences } from './silence'

/**
 * The AI "watches" each shot (a vision model describes one keyframe) and
 * "listens" (Whisper transcribes the speech). Both are optional and priced,
 * so the person starts them on purpose and sees an estimate first.
 */

const BATCH = 6
const CHUNK_SEC = 900
const WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions'

export function estimateUnderstanding(clips: FootageClip[], chatModel: string | undefined, canTranscribe: boolean): UnderstandEstimate {
  const todo = clips.filter((c) => c.status === 'ok')
  const shots = todo.filter((c) => !c.watched).reduce((a, c) => a + c.shots.length, 0)
  const speechMinutes = canTranscribe ? todo.filter((c) => !c.listened).reduce((a, c) => a + c.durationSec / 60, 0) : 0
  // the richer per-shot answers (people, emotion, objects, defects…) cost more: token estimate ×2.2
  const vision = chatModel ? priceUsage(chatModel, { inputTokens: Math.round(shots * 800 * 2.2), outputTokens: Math.round(shots * 70 * 2.2) }).usd : 0
  const speech = speechMinutes * 0.006
  return {
    shots,
    clips: todo.filter((c) => !c.watched || (canTranscribe && !c.listened)).length,
    speechMinutes: Math.round(speechMinutes * 10) / 10,
    usd: Math.round((vision + speech) * 1000) / 1000
  }
}

const SHOT_SYSTEM = `You help a video editor learn what is in raw footage. You are shown one still frame per shot, in order.
Each frame comes with defects measured locally from the video (focus, shake, exposure): confirm the ones you can see in the frame, add any the measurements missed, and drop the rest.
For each frame answer, in plain words:
- description: at most 14 words saying who or what is visible and what is happening. Concrete and literal, no guessing about things not visible.
- tags: 2 to 5 lowercase keywords (subjects, place, activity, mood).
- score: 1 to 10 for how usable and appealing the shot is as an edit (10 = sharp, well framed, clearly interesting; 1 = blurry, black, accidental or empty).
- people: how many people are visible (0 when nobody is).
- talkingVisible: true when someone visible is talking (mouth moving, facing the camera or a partner).
- emotion: up to 2 emotional states of the scene, chosen only from: anger, love, empathy, compassion, joy, sadness, fear, surprise, calm, tension.
- objects: 2 to 5 main things in the shot besides people, lowercase ("surfboard", "cake", "whiteboard").
- topic: at most 8 words on what the shot is about ("arriving at the beach").
- defects: from this list only: misfocused, shaky, tooDark, tooBright, backlit, tilted; empty when the picture is fine.
- appearance: at most 12 words describing the main visible person's look ("man, red jacket, grey beard"), so they can be recognised in other shots; leave out when nobody is visible.
Return one entry per frame, using the frame's number.`

const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'number' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          score: { type: 'number' },
          people: { type: 'number' },
          talkingVisible: { type: 'boolean' },
          emotion: { type: 'array', items: { type: 'string' } },
          objects: { type: 'array', items: { type: 'string' } },
          topic: { type: 'string' },
          defects: { type: 'array', items: { type: 'string' } },
          appearance: { type: 'string' }
        },
        required: ['n', 'description', 'tags', 'score'],
        additionalProperties: false
      }
    }
  },
  required: ['shots'],
  additionalProperties: false
}

/** one model answer for one frame; every field but n/description/tags/score is optional */
interface ShotReply {
  n: number
  description: string
  tags: string[]
  score: number
  people?: number
  talkingVisible?: boolean
  emotion?: string[]
  objects?: string[]
  topic?: string
  defects?: string[]
  /** the main visible person's look; stored on the shot (not part of the shared type) until clusterCast folds it into a cast member */
  appearance?: string
}

/** FootageShot plus the transient appearance string the vision pass leaves for clusterCast */
type ShotWithAppearance = FootageShot & { appearance?: string }

const EMOTION_SET = new Set<string>(EMOTIONS)
const DEFECT_SET = new Set<string>(SHOT_DEFECTS)

/** writes the model's richer answers onto a shot, clamped the same defensive way as description/tags/score */
function applyShotInsights(target: FootageShot, r: ShotReply): void {
  const t = target as ShotWithAppearance
  if (typeof r.people === 'number' && Number.isFinite(r.people)) target.people = Math.max(0, Math.min(20, Math.round(r.people)))
  if (typeof r.talkingVisible === 'boolean') target.talkingVisible = r.talkingVisible
  if (Array.isArray(r.emotion)) {
    target.emotion = [...new Set(r.emotion.map((e) => String(e).toLowerCase().trim()).filter((e) => EMOTION_SET.has(e)))].slice(0, 2)
  }
  if (Array.isArray(r.objects)) {
    target.objects = r.objects
      .map((o) => String(o).toLowerCase().trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .map((o) => o.slice(0, 24))
      .slice(0, 5)
  }
  if (typeof r.topic === 'string' && r.topic.trim()) target.topic = r.topic.trim().slice(0, 60)
  if (Array.isArray(r.defects)) {
    // the model confirms or corrects the measured hints; backlit/tilted can only come from here
    target.defects = [...new Set(r.defects.map((d) => String(d).trim()).filter((d): d is ShotDefect => DEFECT_SET.has(d)))]
  }
  if (typeof r.appearance === 'string' && r.appearance.trim()) {
    t.appearance = r.appearance.trim().split(/\s+/).slice(0, 12).join(' ').slice(0, 140)
  }
}

/** vision pass for one clip; mutates the clip's shots and marks it watched when every shot was described */
export async function watchClip(provider: LLMProvider, clip: FootageClip, projectDir: string, isCancelled: () => boolean, model?: string): Promise<void> {
  const items = clip.shots.map((shot, i) => ({ shot, i })).filter((x) => x.shot.frame && !x.shot.description && existsSync(join(projectDir, x.shot.frame)))
  for (let at = 0; at < items.length && !isCancelled(); at += BATCH) {
    const batch = items.slice(at, at + BATCH)
    const images = batch.map((x) => ({ mimeType: 'image/jpeg', base64: readFileSync(join(projectDir, x.shot.frame!)).toString('base64') }))
    // free local measurements first, so the model confirms real defects instead of guessing
    const hints = await Promise.all(
      batch.map(async (x) => {
        const m = await inspectShot(clip.path, x.shot.startSec, x.shot.endSec)
        return m ? hintDefects(m) : []
      })
    )
    try {
      const out = await provider.generateJSON<{ shots: ShotReply[] }>({
        system: SHOT_SYSTEM,
        prompt: JSON.stringify({
          clip: clip.name,
          frames: batch.map((_, k) => ({ n: k + 1, shotStartSec: batch[k].shot.startSec, shotEndSec: batch[k].shot.endSec, measuredDefects: hints[k] }))
        }),
        schemaName: 'ShotDescriptions',
        jsonSchema: SHOT_SCHEMA,
        images,
        temperature: 0.2,
        maxTokens: 1200,
        ...(model ? { model } : {})
      })
      for (const r of out.shots ?? []) {
        const target = batch[Math.round(r.n) - 1]?.shot
        if (!target || typeof r.description !== 'string' || !r.description.trim()) continue
        target.description = r.description.trim().slice(0, 160)
        target.tags = (Array.isArray(r.tags) ? r.tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
        target.score = Number.isFinite(r.score) ? Math.max(1, Math.min(10, Math.round(r.score))) : undefined
        applyShotInsights(target, r)
      }
    } catch (err) {
      // a bad batch must not lose the rest of the clip; the clip stays "not watched" and can be retried
      if (isCancelled()) return
      throw err
    }
  }
  if (!isCancelled()) clip.watched = clip.shots.every((s) => !s.frame || Boolean(s.description))
}

/** speech-to-text for one clip with Whisper, in 15-minute chunks (keeps every upload small) */
export async function listenToClip(apiKey: string, clip: FootageClip, projectDir: string, isCancelled: () => boolean): Promise<void> {
  if (!clip.hasAudio || clip.lufs === undefined) {
    clip.listened = true
    return
  }
  const tmp = join(projectDir, 'tmp-audio')
  mkdirSync(tmp, { recursive: true })
  const lines: TranscriptLine[] = []
  try {
    for (let start = 0; start < clip.durationSec && !isCancelled(); start += CHUNK_SEC) {
      const out = join(tmp, `${clip.id}-${start}.mp3`)
      const len = Math.min(CHUNK_SEC, clip.durationSec - start)
      const res = await runFfmpeg(['-v', 'error', '-y', '-ss', String(start), '-t', String(len), '-i', clip.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', out])
      if (res.code !== 0 || !existsSync(out)) throw new Error('Could not extract the sound of this clip')
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(readFileSync(out))], { type: 'audio/mpeg' }), 'speech.mp3')
      form.append('model', 'whisper-1')
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'segment')
      const r = route('openai', { base: WHISPER_URL.replace(/\/audio\/transcriptions$/, ''), headers: { Authorization: `Bearer ${apiKey}` } })
      const resp = await fetch(`${r.base}/audio/transcriptions`, { method: 'POST', headers: r.headers, body: form })
      if (!resp.ok) throw new Error(`Speech recognition failed (${resp.status}). Check your OpenAI key in Settings.`)
      const json = (await resp.json()) as { duration?: number; segments?: Array<{ start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }> }
      meter.record({ kind: 'transcribe', provider: 'openai', model: 'whisper-1', usage: { seconds: json.duration ?? len }, stage: 'listen' })
      for (const s of json.segments ?? []) {
        const text = s.text.trim()
        // Whisper invents text over silence and music: drop segments it is unsure contain speech
        if (!text || (s.no_speech_prob ?? 0) > 0.6 || (s.avg_logprob ?? 0) < -1.2) continue
        lines.push({ startSec: round2(start + s.start), endSec: round2(start + s.end), text })
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  if (isCancelled()) return
  clip.transcript = lines
  clip.listened = true
}

// ---------------------------------------------------------------- cast, off-screen speech, clip insights

/** words that say nothing about who someone is */
const APPEARANCE_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'by', 'with', 'of', 'for', 'to', 'his', 'her', 'its', 'their', 'my', 'our', 'is', 'are', 'was', 'were', 'has', 'have', 'having', 'wearing', 'wears', 'very'])

/** the lowercase content words of an appearance string ("man in a red jacket" → man, red, jacket) */
function contentWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !APPEARANCE_STOP.has(w))
  return new Set(words)
}

/** |A∩B| / |A∪B| of two word sets; 0 when both are empty */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / (a.size + b.size - shared)
}

/**
 * Groups the appearance strings the vision pass left on shots into cast
 * members: two sightings are the same person when their content words overlap
 * with Jaccard > 0.5 (compared against the first sighting of the cluster).
 * Returns new shot objects carrying castIds; the input array is never touched.
 */
export function clusterCast(shots: FootageShot[]): { cast: FootageCastMember[]; shots: FootageShot[] } {
  const clusters: Array<{ words: Set<string>; member: FootageCastMember }> = []
  const out = shots.map((shot) => {
    const appearance = (shot as ShotWithAppearance).appearance?.trim()
    const words = appearance ? contentWords(appearance) : new Set<string>()
    let hit = words.size ? clusters.find((c) => jaccard(words, c.words) > 0.5) : undefined
    if (words.size && !hit) {
      hit = { words, member: { id: `p${clusters.length + 1}`, appearance: appearance!, sightings: 0 } }
      clusters.push(hit)
    }
    if (!hit) return { ...shot }
    hit.member.sightings++
    return { ...shot, castIds: [hit.member.id] }
  })
  return { cast: clusters.map((c) => ({ ...c.member })), shots: out }
}

/** a shot hides the speaker when the model saw no people, or people but nobody talking (partial answers never count) */
const noVisibleTalker = (s: FootageShot): boolean => s.people === 0 || s.talkingVisible === false

/**
 * Transcript lines that were spoken while nobody visible was talking — a
 * voice behind the camera. A line counts when at least 60% of its span falls
 * in such shots; adjacent lines merge into one span.
 */
export function offscreenSpeechOf(clip: FootageClip): Span[] {
  const spans: Span[] = []
  for (const line of clip.transcript ?? []) {
    const len = line.endSec - line.startSec
    if (len <= 0) continue
    let off = 0
    for (const s of clip.shots) {
      const a = Math.max(line.startSec, s.startSec)
      const b = Math.min(line.endSec, s.endSec)
      if (b > a && noVisibleTalker(s)) off += b - a
    }
    if (off / len < 0.6) continue
    const prev = spans.at(-1)
    if (prev && line.startSec <= prev.endSec + 0.05) prev.endSec = Math.max(prev.endSec, line.endSec)
    else spans.push({ startSec: line.startSec, endSec: line.endSec })
  }
  return spans.slice(0, 40).map((s) => ({ startSec: round2(s.startSec), endSec: round2(s.endSec) }))
}

/** a quiet stretch has to last this long before it feels dead on screen */
const MIN_DEAD_SEC = 1.2

/** fills in what only needs local work: dead-air pauses and off-screen speech; never throws */
export async function deriveClipInsights(clip: FootageClip): Promise<void> {
  if (clip.hasAudio && clip.lufs !== undefined) {
    try {
      const gaps = await detectSilences(clip.path, 0, clip.durationSec)
      clip.longPauses = gaps
        .filter((g) => g.end - g.start >= MIN_DEAD_SEC)
        .slice(0, 40)
        .map((g) => ({ startSec: round2(g.start), endSec: round2(g.end) }))
    } catch {
      clip.longPauses = []
    }
  }
  clip.offscreenSpeech = offscreenSpeechOf(clip)
}

const TOPIC_SYSTEM = `You read the transcripts of someone's raw home footage and name what each clip is about. Plain words, at most 80 characters, e.g. "building the treehouse with the kids". Return one entry per clip ref, using the same ref.`

const TOPIC_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, topic: { type: 'string' } },
        required: ['ref', 'topic'],
        additionalProperties: false
      }
    }
  },
  required: ['topics'],
  additionalProperties: false
}

/** transcript lines stay short and the whole payload bounded, so this fits one cheap call */
const TOPIC_LINE_CHARS = 80
const TOPIC_MAX_CHARS = 20_000

/** one cheap call to name every watched-and-listened clip from its transcript; a failure leaves all topics unset */
export async function summarizeTopic(provider: LLMProvider, clips: FootageClip[], isCancelled: () => boolean, model?: string): Promise<void> {
  const todo = clips.filter((c) => c.watched && c.listened)
  if (!todo.length || isCancelled()) return
  const entries = todo.map((c, i) => ({
    ref: `c${i + 1}`,
    name: c.name,
    lines: (c.transcript ?? []).map((l) => ({ s: l.startSec, e: l.endSec, text: l.text.slice(0, TOPIC_LINE_CHARS) }))
  }))
  // each line costs its text plus fixed JSON overhead; drop whole lines from the end until the payload fits
  const lineCost = (l: { text: string }) => l.text.length + 90
  let used = entries.reduce((a, c) => a + c.name.length + 40, 0)
  for (const c of entries) for (const l of c.lines) used += lineCost(l)
  for (let i = entries.length - 1; i >= 0 && used > TOPIC_MAX_CHARS; i--) {
    while (entries[i].lines.length && used > TOPIC_MAX_CHARS) used -= lineCost(entries[i].lines.pop()!)
  }
  try {
    const out = await provider.generateJSON<{ topics: Array<{ ref: string; topic: string }> }>({
      system: TOPIC_SYSTEM,
      prompt: JSON.stringify({ clips: entries.map((c) => ({ ref: c.ref, name: c.name, transcript: c.lines })) }),
      schemaName: 'ClipTopics',
      jsonSchema: TOPIC_SCHEMA,
      temperature: 0.3,
      maxTokens: 900,
      ...(model ? { model } : {})
    })
    for (const t of out.topics ?? []) {
      const i = entries.findIndex((c) => c.ref === t.ref)
      if (i < 0 || typeof t.topic !== 'string' || !t.topic.trim()) continue
      todo[i].topic = t.topic.trim().slice(0, 80)
    }
  } catch {
    // a failed summary must never stop the pipeline: the clips simply stay unnamed
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100
