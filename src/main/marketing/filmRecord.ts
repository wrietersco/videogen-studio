import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeMono, SR } from '../audio/pcm'
import { speechBounds } from '../audio/voice'
import type { PieceShot } from './assemble'

/**
 * What a finished film is made of, saved next to it (`market-film.json`) so the
 * film can be made again with a few changes: the script, which voice file says
 * which line, which pictures and clips belong to which part, the music and the
 * look of the captions. A revision hands the parts it keeps back to the engine
 * (`FilmReuse`); only what changed is made again.
 */

export const FILM_RECORD = 'market-film.json'

export interface FilmBeat {
  headline: string
  line: string
  chapter: string
  pointId?: string
  visual?: string
}

export interface FilmScript {
  problemHeadline: string
  problemLine: string
  beats: FilmBeat[]
  close: string
  hook?: string
}

/** how the words on top of the film look */
export interface FilmStyle {
  /** the colour of the spoken words in the captions, hex ("#ffd400") */
  captionColor?: string
  /** caption size against the usual (1 = usual, 1.25 = a quarter bigger) */
  captionScale?: number
  /** the point stickers and icon badges (default on) */
  stickers?: boolean
  /** the big opening line (default on) */
  hook?: boolean
}

export interface FilmPartRecord {
  /** 'problem', 'p1'… */
  id: string
  headline: string
  line: string
  /** what it was shown as */
  kind: 'clip' | 'image' | 'scene'
  /** the AI pictures and clips of this part, in order (empty for an animated card) */
  shots: PieceShot[]
  visual?: string
}

export interface FilmVoiceRecord {
  /** the line said */
  text: string
  /** the voice's instructions (tone and language) it was said with */
  tone: string
  /** the voice file */
  file: string
}

export interface FilmRecord {
  version: 1
  script: FilmScript
  parts: FilmPartRecord[]
  voices: FilmVoiceRecord[]
  music: { source: 'ai' | 'builtin' | 'none'; file?: string; model?: string; mood?: string }
  frame: { width: number; height: number }
  style: FilmStyle
  targetSec: number
  durationSec: number
}

/** what an earlier film gives a new one */
export interface FilmReuse {
  /** the words, already written: the writer is not asked again */
  script?: FilmScript
  /** voice files of lines said before; a line with the same words and tone is not said again */
  voices?: FilmVoiceRecord[]
  /** per part id, the pictures and clips to use again instead of making new ones */
  shots?: Record<string, PieceShot[]>
  /** the AI music track to use again */
  music?: string
  musicModel?: string
  /** the built-in score's mood, so it is not chosen again */
  musicMood?: string
  style?: FilmStyle
}

export function writeFilmRecord(runDir: string, rec: FilmRecord): void {
  writeFileSync(join(runDir, FILM_RECORD), JSON.stringify(rec, null, 2))
}

export function readFilmRecord(runDir: string): FilmRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(runDir, FILM_RECORD), 'utf8')) as FilmRecord
    return r && r.version === 1 && r.script && Array.isArray(r.parts) ? r : null
  } catch {
    return null
  }
}

/** the voice file a line was saved to (the engine names them `<name>.wav` or `.mp3`) */
export function voiceFileOf(runDir: string, name: string): string | null {
  for (const ext of ['.wav', '.mp3']) if (existsSync(join(runDir, name + ext))) return join(runDir, name + ext)
  return null
}

/** a line said before with the same words and tone: its voice copied into this run and trimmed like a new one; null = say it again */
export function reusedVoice(reuse: FilmReuse | undefined, runDir: string, name: string, text: string, tone: string): Float32Array | null {
  const hit = reuse?.voices?.find((v) => v.text.trim() === text.trim() && v.tone === tone && existsSync(v.file))
  if (!hit) return null
  try {
    const file = join(runDir, name + (hit.file.endsWith('.mp3') ? '.mp3' : '.wav'))
    if (file !== hit.file) copyFileSync(hit.file, file)
    const raw = decodeMono(file)
    const b = speechBounds(raw)
    return raw.slice(Math.max(0, Math.round((b.start - 0.04) * SR)), Math.round(b.end * SR))
  } catch {
    return null
  }
}

/** shots that can still be used (their files are still there) */
export function usableShots(shots: PieceShot[] | undefined): PieceShot[] | null {
  if (!shots?.length) return null
  return shots.every((s) => s.file && existsSync(s.file)) ? shots : null
}
