import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import type { Take } from '@shared/appRecon'
import type { PlatformId } from '@shared/spec'
import { decodeMono, SR } from '../audio/pcm'
import { speechBounds } from '../audio/voice'
import type { LaunchInfo } from './narrate'
import type { BeatFacts } from './planner'
import type { InsertPlan } from './produce'

/**
 * What a finished recording is made of, saved beside it (never a password, never a
 * private value: the words were already checked before they were voiced).
 *
 * With this and the kept screen recording (final/raw.mp4), a video can be made again
 * with the words, voice, cards, music or footage changed, without opening the app.
 */

export const RECORDING_RECORD = 'recording-record.json'

export interface RecordedLine {
  beat: number
  chapter: string
  text: string
  /** the voice file for this line, relative to the run folder */
  voice?: string
}

export interface RecordedCard {
  pill?: string
  headline: string
  sub?: string
  text: string
  accent?: string
  /** a logo file, relative to the run folder when it was copied there */
  logo?: string
  voice?: string
}

export interface RecordedInsert {
  at: InsertPlan['at']
  /** the clip, relative to the run folder */
  file: string
  clipSec: number
  text: string
  tag?: string
  voice?: string
}

export interface RecordedMusic {
  source: 'ai' | 'builtin' | 'ambience' | 'none'
  mood: string
  /** the style sentence of AI music (or a pure ambience track) */
  style?: string
  /** the AI track that was used, relative to the run folder */
  file?: string
  /** natural sounds made on this PC */
  sounds?: string[]
  /** the model that made the AI track */
  model?: string
  /** relative loudness (1 = normal) */
  level?: number
}

export interface RecordingRecord {
  version: 1
  mode: 'walkthrough' | 'launch'
  launch?: LaunchInfo
  platform?: PlatformId
  size: { width: number; height: number }
  /** seconds from the recording's start to its first picture (the beats' times are measured from the start) */
  offsetSec: number
  title: string
  targetSec?: number
  /** what the person asked for, with private data removed: information for a writer */
  context: string
  styleDirection?: string
  /** how the narrator was told to sound */
  tone: string
  /** the language it is spoken in (absent = English) */
  language?: string
  /** a narrator spoke it (false = captions timed by reading speed) */
  voiced: boolean
  lines: RecordedLine[]
  intro?: RecordedCard
  problem?: RecordedCard
  outro?: RecordedCard
  inserts: RecordedInsert[]
  music: RecordedMusic
  motif?: 'graph' | 'flow' | 'cards'
  look?: { backdrop: [string, string]; accent: string }
  /** the screen recording, relative to the run folder */
  raw: string
}

export function writeRecordingRecord(runDir: string, rec: RecordingRecord): void {
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, RECORDING_RECORD), JSON.stringify(rec, null, 2))
}

export function readRecordingRecord(runDir: string): RecordingRecord | null {
  try {
    const r = JSON.parse(readFileSync(join(runDir, RECORDING_RECORD), 'utf8')) as RecordingRecord
    return r && r.version === 1 && Array.isArray(r.lines) && typeof r.raw === 'string' && existsSync(join(runDir, r.raw)) ? r : null
  } catch {
    return null
  }
}

/** an earlier recording as it was left: its record, its take (when each beat happened) and what each beat showed */
export interface PreviousRecording {
  runId: string
  dir: string
  record: RecordingRecord
  take: Take
  beats: BeatFacts[]
}

export function readPreviousRecording(runId: string, dir: string): PreviousRecording | null {
  const record = readRecordingRecord(dir)
  if (!record) return null
  try {
    const take = JSON.parse(readFileSync(join(dir, 'take.json'), 'utf8')) as Take
    if (!take || !Array.isArray(take.beats) || !Array.isArray(take.navigations)) return null
    let beats: BeatFacts[] = []
    try {
      beats = JSON.parse(readFileSync(join(dir, 'beats.json'), 'utf8')) as BeatFacts[]
    } catch {
      /* the facts only help a writer; a video can be edited without them */
    }
    return { runId, dir, record, take, beats: Array.isArray(beats) ? beats : [] }
  } catch {
    return null
  }
}

/** the voice file a part was saved to, relative to the run folder (the engine names them `<name>.wav` or `.mp3`) */
export function findVoice(runDir: string, name: string): string | undefined {
  for (const ext of ['.mp3', '.wav']) if (existsSync(join(runDir, name + ext))) return name + ext
  return undefined
}

/** a saved voice line, trimmed of silence like a new one; null when the file is gone */
export function loadVoice(runDir: string, rel: string | undefined): Float32Array | null {
  if (!rel) return null
  const file = join(runDir, rel)
  if (!existsSync(file)) return null
  try {
    const raw = decodeMono(file)
    const b = speechBounds(raw)
    return raw.slice(Math.max(0, Math.round((b.start - 0.04) * SR)), Math.round(b.end * SR))
  } catch {
    return null
  }
}

/** copy a file into another run folder (same relative name) so the new video does not depend on the old one staying; returns the relative name, or undefined when it cannot be copied */
export function carryFile(fromDir: string, toDir: string, rel: string | undefined): string | undefined {
  if (!rel) return undefined
  const src = join(fromDir, rel)
  if (!existsSync(src)) return undefined
  const dst = join(toDir, rel)
  try {
    mkdirSync(dirname(dst), { recursive: true })
    if (src !== dst) copyFileSync(src, dst)
    return rel
  } catch {
    return undefined
  }
}

/** a file that may live anywhere (an AI clip in the library, a logo): copied into the run folder under `final/` and named by its own name; the relative name, or undefined */
export function adoptFile(file: string | undefined, toDir: string, sub = 'final'): string | undefined {
  if (!file || !existsSync(file)) return undefined
  const rel = join(sub, basename(file)).split('\\').join('/')
  const dst = join(toDir, rel)
  try {
    mkdirSync(dirname(dst), { recursive: true })
    if (file !== dst) copyFileSync(file, dst)
    return rel
  } catch {
    return undefined
  }
}

export const extOf = (f: string): string => extname(f).toLowerCase()
