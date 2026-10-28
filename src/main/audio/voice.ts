import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LLMProvider } from '../providers/types'
import type { VideoSpec, VoiceTake } from '@shared/spec'
import { decodeMono, SR } from './pcm'
import { beatGrid } from './score'

/**
 * Voice-first timing. Narration is synthesized before composing, measured
 * exactly, and every scene is stretched or shrunk to hold its line plus a
 * breath — then rounded up to the music's beat so every cut lands on a beat.
 * Takes are cached by (voice, tone, text): recomposes never re-pay for audio.
 */

const TONES = {
  documentary:
    'Documentary narrator. Calm, assured and warm, low register, measured unhurried pace with natural pauses at commas. ' +
    'Quiet gravitas; give numbers and names a little weight. Never sing-song, never salesy.',
  social:
    'Confident short-form explainer. Brisk, energetic pace, crisp consonants, a hint of a smile. ' +
    'Punch the key word and every number. Conversational, never shouty or salesy.'
} as const

/** voices the speech endpoint accepts (it rejects anything else outright) */
export const VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const

export function defaultVoice(spec: VideoSpec): { id: string; tone: string } {
  return spec.design?.look === 'documentary' ? { id: 'onyx', tone: TONES.documentary } : { id: 'nova', tone: TONES.social }
}

/** narration text per scene (several lines for one scene are joined) */
function linesByScene(spec: VideoSpec): Map<string, string> {
  const m = new Map<string, string>()
  for (const l of spec.narration) {
    const t = l.text.trim()
    if (t) m.set(l.sceneId, m.has(l.sceneId) ? `${m.get(l.sceneId)} ${t}` : t)
  }
  return m
}

/**
 * Synthesize (or reuse) every scene's take, then fit scene durations to the
 * voice. Mutates and returns `spec`. No TTS-capable provider → unchanged.
 */
export async function narrate(spec: VideoSpec, provider: LLMProvider | null, projectDir: string): Promise<VideoSpec> {
  const lines = linesByScene(spec)
  if (!provider?.tts || lines.size === 0) return spec
  const voice = spec.voice && (VOICES as readonly string[]).includes(spec.voice.id) ? spec.voice : defaultVoice(spec)
  spec.voice = voice
  const dir = join(projectDir, 'assets', 'audio')
  mkdirSync(dir, { recursive: true })

  const cached = new Map(spec.voiceover.map((t) => [t.key, t]))
  const takes = await Promise.all(
    spec.scenes.map(async (scene, i): Promise<VoiceTake | null> => {
      const text = lines.get(scene.id)
      if (!text) return null
      const key = createHash('sha1').update(`${voice.id}|${voice.tone}|${text}`).digest('hex').slice(0, 12)
      const file = `assets/audio/vo-${key}.mp3`
      const leadSec = i === 0 ? 0.3 : 0.25
      const hit = cached.get(key)
      if (hit && existsSync(join(projectDir, hit.file))) return { ...hit, sceneId: scene.id, leadSec }
      const res = await provider.tts!({ text, voice: voice.id, instructions: voice.tone })
      writeFileSync(join(projectDir, file), res.audio)
      const durationSec = decodeMono(join(projectDir, file)).length / SR
      return { sceneId: scene.id, key, file, durationSec, leadSec, words: alignWords(text, res.words ?? [], durationSec) }
    })
  )
  spec.voiceover = takes.filter((t): t is VoiceTake => t !== null)
  fitScenes(spec)
  return spec
}

/** scene length = lead + take + tail, rounded up to whole beats */
export function fitScenes(spec: VideoSpec): void {
  const { beatSec, beatsPerCut } = beatGrid(spec)
  const unit = beatSec * beatsPerCut
  const take = new Map(spec.voiceover.map((t) => [t.sceneId, t]))
  for (const scene of spec.scenes) {
    const t = take.get(scene.id)
    const want = t ? t.leadSec + t.durationSec + 0.45 : scene.durationSec
    scene.durationSec = Math.max(2, Math.ceil((want - 0.05) / unit)) * unit
    scene.durationSec = Math.round(scene.durationSec * 1000) / 1000
  }
  spec.durationSec = Math.round(spec.scenes.reduce((a, s) => a + s.durationSec, 0) * 100) / 100
}

const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/**
 * Map the transcriber's word timings back onto the script's own words, so
 * captions keep the writer's spelling and punctuation. Unmatched words get
 * times interpolated from their neighbours.
 */
export function alignWords(
  text: string,
  heard: Array<{ word: string; startSec: number; endSec: number }>,
  durationSec: number
): VoiceTake['words'] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: Array<{ word: string; startSec: number; endSec: number } | null> = words.map(() => null)
  let j = 0
  for (let i = 0; i < words.length && j < heard.length; i++) {
    const w = norm(words[i])
    for (let k = j; k < Math.min(heard.length, j + 4); k++) {
      if (norm(heard[k].word) === w) {
        out[i] = { word: words[i], startSec: heard[k].startSec, endSec: heard[k].endSec }
        j = k + 1
        break
      }
    }
  }
  // interpolate gaps (whole line unmatched → spread evenly over the take)
  const known = out.map((o, i) => (o ? i : -1)).filter((i) => i >= 0)
  return words.map((word, i) => {
    if (out[i]) return out[i]!
    const prev = [...known].reverse().find((k) => k < i)
    const next = known.find((k) => k > i)
    const a = prev !== undefined ? out[prev]!.endSec : 0.05
    const b = next !== undefined ? out[next]!.startSec : durationSec - 0.1
    const from = prev ?? -1
    const to = next ?? words.length
    const f = (i - from) / (to - from)
    const t = a + (b - a) * f
    return { word, startSec: t, endSec: Math.min(b, t + (b - a) / (to - from)) }
  })
}
