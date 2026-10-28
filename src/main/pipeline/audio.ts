import { mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { VideoSpec } from '@shared/spec'
import { decodeMono, hashSeed, loudnorm, mixIn, stereo, writeWav, SR } from '../audio/pcm'
import { scoreMusic } from '../audio/score'
import { designSfx } from '../audio/sfx'
import { duck } from '../audio/mix'

/**
 * Audio stage — one finished soundtrack per video:
 *   narration takes (voice-first, already fitted by audio/voice.ts)
 *   + music bed (the user's own track, else an original score)
 *   ducked under the voice, + synthesized sound design on the cuts,
 *   normalized to −14 LUFS and placed as a single HyperFrames <audio> clip.
 * Fully optional: any failure renders silent, and captions degrade to
 * scene-level cues.
 */

export interface AudioClip {
  file: string
  startSec: number
  durationSec: number
  volume: number
  trackIndex: number
}

export interface CaptionCue {
  startSec: number
  endSec: number
  text: string
}

export interface AudioResult {
  clips: AudioClip[]
  captions: CaptionCue[]
  hasNarration: boolean
}

const MUSIC_DIR_KEYS = ['upbeat', 'cinematic', 'minimal', 'playful', 'dark', 'corporate'] as const

export async function buildAudio(
  spec: VideoSpec,
  sceneWindows: Array<{ id: string; start: number; end: number }>,
  projectDir: string,
  musicDir: string
): Promise<AudioResult> {
  const audioDir = join(projectDir, 'assets', 'audio')
  mkdirSync(audioDir, { recursive: true })
  const total = sceneWindows.at(-1)?.end ?? spec.durationSec
  const startOf = new Map(sceneWindows.map((w) => [w.id, w.start]))
  const cuts = sceneWindows.map((w) => w.start)
  const seed = hashSeed(spec.title)

  // ---------- narration bus + word timings ----------
  const voice = new Float32Array(Math.ceil(total * SR))
  const words: Array<{ word: string; startSec: number; endSec: number }> = []
  for (const take of spec.voiceover) {
    const at = startOf.get(take.sceneId)
    if (at === undefined || !existsSync(join(projectDir, take.file))) continue
    const pcm = decodeMono(join(projectDir, take.file))
    const off = Math.round((at + take.leadSec) * SR)
    for (let i = 0; i < pcm.length && off + i < voice.length; i++) voice[off + i] += pcm[i]
    for (const w of take.words) words.push({ word: w.word, startSec: at + take.leadSec + w.startSec, endSec: at + take.leadSec + w.endSec })
  }
  const hasNarration = words.length > 0 || spec.voiceover.length > 0

  // ---------- captions (classic template scenes; directed scenes light their own) ----------
  const captions: CaptionCue[] = []
  if (spec.captionStyle.enabled) {
    if (words.length >= 2) captions.push(...karaokeCues(words))
    else
      for (const line of spec.narration) {
        const win = sceneWindows.find((w) => w.id === line.sceneId)
        if (win && line.text.trim()) captions.push({ startSec: win.start, endSec: win.end, text: line.text })
      }
  }

  // ---------- music: the user's own track, else an original score ----------
  const music = userTrack(spec.musicMood, musicDir, total) ?? scoreMusic(spec, cuts, total)
  if (music && hasNarration) duck(music, voice)

  // ---------- master ----------
  const bus = stereo(total)
  mixIn(bus, voice, 0, 0.9)
  if (music) {
    const g = hasNarration ? 0.6 : 0.9
    for (let i = 0; i < bus.l.length; i++) {
      bus.l[i] += music.l[i] * g
      bus.r[i] += music.r[i] * g
    }
  }
  designSfx(bus, cuts, total, seed, hasNarration ? 1 : 1.2)
  if (!hasNarration && !music) return { clips: [], captions, hasNarration: false }

  const raw = join(audioDir, 'mix-raw.wav')
  writeWav(raw, bus)
  const file = 'assets/audio/mix.m4a'
  loudnorm(raw, join(projectDir, file))
  rmSync(raw, { force: true })
  return { clips: [{ file, startSec: 0, durationSec: total, volume: 1, trackIndex: 0 }], captions, hasNarration }
}

/** group words into readable 2–4 word caption chunks */
function karaokeCues(words: Array<{ word: string; startSec: number }>): CaptionCue[] {
  const cues: CaptionCue[] = []
  let chunk: Array<{ word: string; startSec: number }> = []
  const flush = (endSec: number) => {
    if (chunk.length === 0) return
    cues.push({ startSec: chunk[0].startSec, endSec, text: chunk.map((w) => w.word).join(' ') })
    chunk = []
  }
  for (let i = 0; i < words.length; i++) {
    chunk.push(words[i])
    const isBreak =
      chunk.length >= 3 ||
      /[.!?,:;]$/.test(words[i].word) ||
      (i + 1 < words.length && words[i + 1].startSec - words[i].startSec > 0.8)
    if (isBreak) flush(i + 1 < words.length ? words[i + 1].startSec : words[i].startSec + 0.6)
  }
  flush((words.at(-1)?.startSec ?? 0) + 0.8)
  return cues
}

/** a track from the user's music folder, looped to length (mono, centred) */
function userTrack(mood: VideoSpec['musicMood'], musicDir: string, totalSec: number) {
  if (mood === 'none' || !existsSync(musicDir)) return null
  const key = MUSIC_DIR_KEYS.includes(mood as (typeof MUSIC_DIR_KEYS)[number]) ? mood : 'upbeat'
  const find = (sub: string): string | null => {
    const dir = join(musicDir, sub)
    try {
      const f = readdirSync(dir).filter((x) => /\.(mp3|wav|m4a|ogg|flac)$/i.test(x)).sort()[0]
      return f ? join(dir, f) : null
    } catch {
      return null // missing, or not a directory (e.g. README.md)
    }
  }
  const path = find(key)
  if (!path) return null
  const src = decodeMono(path)
  if (src.length === 0) return null
  const out = stereo(totalSec)
  const fade = Math.min(1.5, totalSec * 0.15)
  let peak = 1e-9
  for (const v of src) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i < out.l.length; i++) {
    const t = i / SR
    const v = (src[i % src.length] / peak) * 0.5 * Math.min(1, t / 0.4) * Math.min(1, (totalSec - t) / fade)
    out.l[i] = v
    out.r[i] = v
  }
  return out
}
