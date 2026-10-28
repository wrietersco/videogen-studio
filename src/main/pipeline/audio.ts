import { mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { VideoSpec } from '@shared/spec'
import { decodeMono, decodeStereo, hashSeed, loudnorm, mixIn, stereo, writeWav, SR } from '../audio/pcm'
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
  musicDir: string,
  /** a library/generated track chosen by the media router (else the user's folder, else an original score) */
  musicFile?: string | null
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
  const music = (musicFile ? loopTrack(musicFile, total, cuts) : null) ?? userTrack(spec.musicMood, musicDir, total, cuts) ?? scoreMusic(spec, cuts, total)
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
function userTrack(mood: VideoSpec['musicMood'], musicDir: string, totalSec: number, cuts: number[]) {
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
  return path ? loopTrack(path, totalSec, cuts) : null
}

/**
 * Any track fitted to the video, in stereo. A track scored to this length
 * keeps its own intro and composed ending (only a short safety fade). A much
 * longer one keeps both too: its opening plays up to a cut, then crossfades
 * (under the cut's whoosh) into the bars that lead to its real ending, so the
 * video lands on the song's final chord instead of a fade. A shorter one loops.
 */
function loopTrack(path: string, totalSec: number, cuts: number[] = []) {
  if (!existsSync(path)) return null
  const src = decodeStereo(path)
  const end = musicEnd(src)
  if (end === 0) return null
  const out = stereo(totalSec)
  const n = out.l.length
  const srcSec = end / SR
  let peak = 1e-9
  for (let i = 0; i < end; i++) peak = Math.max(peak, Math.abs(src.l[i]), Math.abs(src.r[i]))

  // splice point: the latest cut that leaves 5–10 s for the ending
  const splice = srcSec > totalSec + 2 ? [...cuts].reverse().find((c) => totalSec - c >= 5 && totalSec - c <= 10) ?? totalSec * 0.65 : null
  const xf = Math.round(0.4 * SR)
  const at = splice === null ? 0 : Math.round(splice * SR)
  const tailFrom = splice === null ? 0 : end - (n - at)
  const spliced = splice !== null && tailFrom > at
  const fade = spliced || (srcSec >= totalSec && srcSec - totalSec < 2) ? 0.25 : Math.min(1.5, totalSec * 0.15)

  for (let i = 0; i < n; i++) {
    const t = i / SR
    const g = (0.5 / peak) * Math.min(1, t / 0.02) * Math.max(0, Math.min(1, (totalSec - t) / fade))
    let l: number
    let r: number
    if (spliced && i >= at - xf / 2) {
      // equal-power crossfade centred on the cut
      const k = Math.min(1, (i - (at - xf / 2)) / xf)
      const a = Math.cos((k * Math.PI) / 2)
      const b = Math.sin((k * Math.PI) / 2)
      const j = tailFrom + (i - at)
      const hl = a > 0 && i < end ? src.l[i] * a : 0
      const hr = a > 0 && i < end ? src.r[i] * a : 0
      l = hl + (j >= 0 ? src.l[j] * b : 0)
      r = hr + (j >= 0 ? src.r[j] * b : 0)
    } else {
      l = src.l[i % end]
      r = src.r[i % end]
    }
    out.l[i] = l * g
    out.r[i] = r * g
  }
  return out
}

/**
 * Where the music actually ends: generated songs often trail silence (and the
 * odd stray blip) after their final chord rings out, so the end is the start
 * of the first 1.5 s silence after the track's first third.
 */
function musicEnd(src: { l: Float32Array; r: Float32Array }): number {
  const len = src.l.length
  const frame = Math.round(0.05 * SR)
  const gate = 10 ** (-50 / 20)
  let quiet = 0
  let lastLoud = 0
  for (let f = 0; f * frame < len; f++) {
    let e = 0
    const a = f * frame
    const b = Math.min(len, a + frame)
    for (let i = a; i < b; i++) e += src.l[i] * src.l[i] + src.r[i] * src.r[i]
    const loud = Math.sqrt(e / (2 * (b - a))) > gate
    if (loud) {
      lastLoud = b
      quiet = 0
    } else if (++quiet * 0.05 >= 1.5 && a > len / 3) return lastLoud
  }
  return lastLoud
}
