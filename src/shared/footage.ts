import { z } from 'zod'
import { PLATFORM_PRESETS } from './presets'
import { VIDEO_SHAPES, type ShapeId } from './shapes'

/**
 * Footage projects — the person's own videos, indexed so an AI editor can cut
 * them into something new. The originals are never touched: indexing only
 * reads them, and every edit is a new file in the project's own folder.
 */

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.3gp'] as const

export interface FootageShot {
  startSec: number
  endSec: number
  /** what is visible, from the vision model (absent until the AI has watched) */
  description?: string
  tags?: string[]
  /** 1–10: how usable and interesting the shot is */
  score?: number
  /** keyframe JPEG, relative to the project folder */
  frame?: string
}

export interface TranscriptLine {
  startSec: number
  endSec: number
  text: string
}

export interface FootageClip {
  id: string
  path: string
  name: string
  /** the project folder this file was found under */
  folder: string
  sizeBytes: number
  mtimeMs: number
  durationSec: number
  /** displayed size (rotation applied) */
  width: number
  height: number
  fps: number
  hasAudio: boolean
  /** integrated loudness of the clip's own sound, used to balance clips against each other */
  lufs?: number
  shots: FootageShot[]
  transcript?: TranscriptLine[]
  /** true once the AI has looked at the shots */
  watched: boolean
  /** true once speech was transcribed (or there was none to transcribe) */
  listened: boolean
  status: 'ok' | 'missing' | 'unreadable'
  error?: string
}

export interface EditRecord {
  id: string
  title: string
  createdAt: string
  prompt: string
  shape: ShapeId
  durationSec: number
  /** absolute path of the rendered video */
  file: string
}

export interface FootageProject {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  folders: string[]
  clips: FootageClip[]
  edits: EditRecord[]
}

export interface FootageSummary {
  id: string
  name: string
  updatedAt: string
  folders: string[]
  clipCount: number
  editCount: number
  totalSec: number
}

export type FootageEvent =
  | { kind: 'scan'; projectId: string; status: 'started' | 'progress' | 'done' | 'failed'; done?: number; total?: number; clipName?: string; error?: string; note?: string }
  | { kind: 'understand'; projectId: string; status: 'started' | 'progress' | 'done' | 'failed'; done?: number; total?: number; note?: string; error?: string }
  | { kind: 'render'; projectId: string; status: 'started' | 'progress' | 'done' | 'failed' | 'cancelled'; pct?: number; phase?: string; edit?: EditRecord; error?: string }

// ---------------------------------------------------------------- edit plan

export const MUSIC_MOODS = ['upbeat', 'cinematic', 'minimal', 'playful', 'dark', 'corporate'] as const

export const PlanSegment = z.object({
  clipId: z.string(),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  /** playback speed: 0.5 = slow motion, 2 = double time */
  speed: z.number().min(0.25).max(4).default(1),
  /** keep the clip's own sound (speech, ambience); false = muted b-roll */
  keepAudio: z.boolean().default(true),
  /** how this shot joins the one before it */
  transition: z.enum(['cut', 'fade']).default('cut'),
  why: z.string().default(''),
  /** a scene the AI makes instead of using footage; clipId is then 'ai-<n>' and endSec is the length asked for */
  ai: z.object({ prompt: z.string().min(3).max(600) }).optional(),
  /** where the subject is (0-1 across, 0-1 down), used when the picture has to be cropped; absent = worked out at render */
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional()
})
export type PlanSegment = z.infer<typeof PlanSegment>

export const MusicChoice = z.object({
  /** none · auto = an original score in the chosen mood · file = the person's own track */
  mode: z.enum(['none', 'auto', 'file']).default('auto'),
  mood: z.enum(MUSIC_MOODS).default('upbeat'),
  file: z.string().optional()
})
export type MusicChoice = z.infer<typeof MusicChoice>

export const CAPTION_STYLES = ['off', 'clean', 'bold', 'box'] as const

/** text shown over the picture for a while, timed on the finished video */
export const PlanTitle = z.object({
  text: z.string().min(1).max(90),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  position: z.enum(['top', 'center', 'bottom']).default('center')
})
export type PlanTitle = z.infer<typeof PlanTitle>

export const EditPlan = z.object({
  title: z.string().default('My edit'),
  shape: z.enum(['9:16', '16:9', '4:5', '1:1']).default('9:16'),
  /** how to fit footage of a different shape: auto picks crop or blurred sides */
  reframe: z.enum(['auto', 'crop', 'blur']).default('auto'),
  segments: z.array(PlanSegment).min(1),
  music: MusicChoice.default({ mode: 'auto', mood: 'upbeat' }),
  /** social = −14 LUFS (TikTok, Reels, Shorts, YouTube) · quiet = −16 · off = leave levels alone */
  loudness: z.enum(['social', 'quiet', 'off']).default('social'),
  fadeInOut: z.boolean().default(true),
  /** subtitles generated from what is said in the kept parts of the footage */
  captions: z.enum(CAPTION_STYLES).default('off'),
  titles: z.array(PlanTitle).max(12).default([]),
  /** plain-language remarks for the person (what was skipped, what could not be done) */
  notes: z.array(z.string()).default([])
})
export type EditPlan = z.infer<typeof EditPlan>

export interface PlanRequest {
  prompt: string
  shape: ShapeId
  /** 0 or absent = the editor decides */
  durationSec?: number
  music: MusicChoice | 'auto-mood'
  loudness?: EditPlan['loudness']
  captions?: EditPlan['captions']
  /** let the editor add AI-made scenes where the footage has nothing for the brief (costs money) */
  aiClips?: boolean
  /** cut this many separate shorts from the footage instead of one video (1 = one video) */
  shorts?: number
  /** add on-screen titles (the editor writes them); false = none */
  titles?: boolean
  /** cut out silent pauses in the parts where people speak */
  tighten?: boolean
}

/** limits for scenes the AI makes (each costs real money) */
export const AI_CLIP_MAX = 4
export const AI_CLIP_MIN_SEC = 3
export const AI_CLIP_MAX_SEC = 8
/** typical price of a generated second of video, for the estimate shown before rendering */
export const AI_CLIP_USD_PER_SEC = 0.1
export const MAX_SHORTS = 6

export const aiClipsIn = (plan: Pick<EditPlan, 'segments'>): number => plan.segments.filter((s) => s.ai).length
export const aiCostUsd = (plan: Pick<EditPlan, 'segments'>): number => plan.segments.filter((s) => s.ai).reduce((a, s) => a + (s.endSec - s.startSec) * AI_CLIP_USD_PER_SEC, 0)

export interface PlanResult {
  plan: EditPlan
  /** 'ai' = chosen by the writing model from what it saw and heard · 'basic' = even spread across the footage */
  source: 'ai' | 'basic'
  /** one small picture per segment (data URLs), same order */
  thumbs: string[]
  /** present when several shorts were asked for: one plan each (plan/thumbs above are the first) */
  shorts?: Array<{ plan: EditPlan; thumbs: string[] }>
}

export interface UnderstandEstimate {
  shots: number
  clips: number
  speechMinutes: number
  usd: number
}

// ---------------------------------------------------------------- helpers

export function shapeSize(shape: ShapeId): { width: number; height: number } {
  const platform = VIDEO_SHAPES.find((s) => s.id === shape)?.defaultPlatform ?? 'tiktok'
  const p = PLATFORM_PRESETS[platform]
  return { width: p.width, height: p.height }
}

/** seconds on screen once speed and overlapping fades are applied */
export function planDuration(plan: Pick<EditPlan, 'segments'>): number {
  let total = 0
  plan.segments.forEach((s, i) => {
    total += (s.endSec - s.startSec) / s.speed
    if (i > 0 && s.transition === 'fade') total -= FADE_SEC
  })
  return Math.max(0, total)
}

export const FADE_SEC = 0.5

/** where each segment starts on the finished video (crossfades overlap the previous part) */
export function segmentStarts(plan: Pick<EditPlan, 'segments'>): number[] {
  const starts: number[] = []
  let length = 0
  plan.segments.forEach((s, i) => {
    const out = (s.endSec - s.startSec) / s.speed
    if (i === 0) {
      starts.push(0)
      length = out
      return
    }
    const t = s.transition === 'fade' ? Math.min(FADE_SEC, out * 0.5, length * 0.5) : 0
    if (t >= 0.1) {
      starts.push(length - t)
      length += out - t
    } else {
      starts.push(length)
      length += out
    }
  })
  return starts
}

export function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
