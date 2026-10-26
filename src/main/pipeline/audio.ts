import { writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { LLMProvider } from '../providers/types'
import type { VideoSpec } from '@shared/spec'

/**
 * Audio stage — narration (TTS with word timestamps) + music bed.
 * Fully optional: with no TTS-capable provider the video renders silent
 * (the QA check tolerates it) and captions degrade to scene-level.
 *
 * Audio clips are placed as HyperFrames <audio> clips at their scene's
 * start time with per-clip volume; the producer mixes tracks at encode.
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
  provider: LLMProvider,
  projectDir: string,
  musicDir: string
): Promise<AudioResult> {
  const clips: AudioClip[] = []
  const captions: CaptionCue[] = []
  const audioDir = join(projectDir, 'assets', 'audio')
  mkdirSync(audioDir, { recursive: true })

  // ---------- narration ----------
  let wordTimings: Array<{ word: string; startSec: number }> = []
  if (typeof provider.tts === 'function' && spec.narration.length > 0) {
    try {
      let narrationOffset = 0
      for (const [i, line] of spec.narration.entries()) {
        if (!line.text.trim()) continue
        const win = sceneWindows.find((w) => w.id === line.sceneId)
        if (!win) continue
        const tts = await provider.tts({ text: line.text })
        const file = `assets/audio/narration-${i + 1}.mp3`
        writeFileSync(join(projectDir, file), tts.audio)
        const durSec = estimateAudioDuration(tts.audio, win.end - win.start)
        clips.push({ file, startSec: win.start, durationSec: durSec, volume: 1.0, trackIndex: 1 })
        for (const w of tts.words ?? []) {
          wordTimings.push({ word: w.word, startSec: win.start + w.startSec })
        }
        narrationOffset += durSec
      }
    } catch {
      // no TTS available (mock) — continue silent
    }
  }

  // ---------- captions ----------
  if (spec.captionStyle.enabled) {
    if (wordTimings.length >= 2) {
      captions.push(...karaokeCues(wordTimings))
    } else {
      // scene-level fallback: show the scene's narration line as one cue
      for (const line of spec.narration) {
        const win = sceneWindows.find((w) => w.id === line.sceneId)
        if (!win || !line.text.trim()) continue
        captions.push({ startSec: win.start, endSec: win.end, text: line.text })
      }
    }
  }

  // ---------- music bed ----------
  const track = pickMusic(spec.musicMood, musicDir)
  if (track) {
    const dest = join(audioDir, 'music.mp3')
    if (!existsSync(dest)) {
      const { copyFileSync } = await import('node:fs')
      copyFileSync(track.path, dest)
    }
    const total = sceneWindows.at(-1)?.end ?? spec.durationSec
    clips.push({ file: 'assets/audio/music.mp3', startSec: 0, durationSec: total, volume: 0.35, trackIndex: 0 })
  }

  return { clips, captions, hasNarration: clips.some((c) => c.trackIndex === 1) }
}

/** naive duration estimate; the producer probes the real file at encode */
function estimateAudioDuration(buf: Buffer, maxSec: number): number {
  // MP3 at 128kbps ≈ 16KB/s
  const est = buf.length / 16_000
  return Math.min(Math.max(est, 0.5), maxSec)
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

function pickMusic(mood: VideoSpec['musicMood'], musicDir: string): { path: string } | null {
  if (mood === 'none') return null
  if (!existsSync(musicDir)) return null
  const key = MUSIC_DIR_KEYS.includes(mood as (typeof MUSIC_DIR_KEYS)[number]) ? mood : 'upbeat'
  const tryDir = (sub: string): { path: string } | null => {
    const dir = join(musicDir, sub)
    if (!existsSync(dir)) return null
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.mp3'))
    } catch {
      return null // not a directory (e.g. README.md)
    }
    return files.length ? { path: join(dir, files[0]) } : null
  }
  return tryDir(key) ?? tryDir('upbeat')
}
