import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { FootageClip, TranscriptLine, UnderstandEstimate } from '../../shared/footage'
import { priceUsage } from '../../shared/pricing'
import type { LLMProvider } from '../providers/types'
import { meter } from '../usage/meter'
import { runFfmpeg } from './ffmpeg'

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
  const vision = chatModel ? priceUsage(chatModel, { inputTokens: shots * 800, outputTokens: shots * 70 }).usd : 0
  const speech = speechMinutes * 0.006
  return {
    shots,
    clips: todo.filter((c) => !c.watched || (canTranscribe && !c.listened)).length,
    speechMinutes: Math.round(speechMinutes * 10) / 10,
    usd: Math.round((vision + speech) * 1000) / 1000
  }
}

const SHOT_SYSTEM = `You help a video editor learn what is in raw footage. You are shown one still frame per shot, in order.
For each frame answer, in plain words:
- description: at most 14 words saying who or what is visible and what is happening. Concrete and literal, no guessing about things not visible.
- tags: 2 to 5 lowercase keywords (subjects, place, activity, mood).
- score: 1 to 10 for how usable and appealing the shot is as an edit (10 = sharp, well framed, clearly interesting; 1 = blurry, black, accidental or empty).
Return one entry per frame, using the frame's number.`

const SHOT_SCHEMA = {
  type: 'object',
  properties: {
    shots: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'number' }, description: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, score: { type: 'number' } },
        required: ['n', 'description', 'tags', 'score'],
        additionalProperties: false
      }
    }
  },
  required: ['shots'],
  additionalProperties: false
}

/** vision pass for one clip; mutates the clip's shots and marks it watched when every shot was described */
export async function watchClip(provider: LLMProvider, clip: FootageClip, projectDir: string, isCancelled: () => boolean): Promise<void> {
  const items = clip.shots.map((shot, i) => ({ shot, i })).filter((x) => x.shot.frame && !x.shot.description && existsSync(join(projectDir, x.shot.frame)))
  for (let at = 0; at < items.length && !isCancelled(); at += BATCH) {
    const batch = items.slice(at, at + BATCH)
    const images = batch.map((x) => ({ mimeType: 'image/jpeg', base64: readFileSync(join(projectDir, x.shot.frame!)).toString('base64') }))
    try {
      const out = await provider.generateJSON<{ shots: Array<{ n: number; description: string; tags: string[]; score: number }> }>({
        system: SHOT_SYSTEM,
        prompt: JSON.stringify({ clip: clip.name, frames: batch.map((_, k) => ({ n: k + 1, shotStartSec: batch[k].shot.startSec, shotEndSec: batch[k].shot.endSec })) }),
        schemaName: 'ShotDescriptions',
        jsonSchema: SHOT_SCHEMA,
        images,
        temperature: 0.2,
        maxTokens: 1200
      })
      for (const r of out.shots ?? []) {
        const target = batch[Math.round(r.n) - 1]?.shot
        if (!target || typeof r.description !== 'string' || !r.description.trim()) continue
        target.description = r.description.trim().slice(0, 160)
        target.tags = (Array.isArray(r.tags) ? r.tags : []).map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
        target.score = Number.isFinite(r.score) ? Math.max(1, Math.min(10, Math.round(r.score))) : undefined
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
      const resp = await fetch(WHISPER_URL, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form })
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

const round2 = (n: number) => Math.round(n * 100) / 100
