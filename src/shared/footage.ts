import { z } from 'zod'
import { PLATFORM_PRESETS } from './presets'
import { VIDEO_SHAPES, type ShapeId } from './shapes'
import type { AgentMode, CheckStatus, DecisionAnswer, DecisionRequest } from './agentBrief'

/**
 * Footage projects — the person's own videos, indexed so an AI editor can cut
 * them into something new. The originals are never touched: indexing only
 * reads them, and every edit is a new file in the project's own folder.
 */

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mts', '.m2ts', '.mpg', '.mpeg', '.wmv', '.3gp'] as const

/** what a professional editor would flag about a shot before using it */
export const SHOT_DEFECTS = ['misfocused', 'shaky', 'tooDark', 'tooBright', 'backlit', 'tilted'] as const
export type ShotDefect = (typeof SHOT_DEFECTS)[number]

/** the emotional states the watcher labels shots with (free-text from the model, clamped to this set) */
export const EMOTIONS = ['anger', 'love', 'empathy', 'compassion', 'joy', 'sadness', 'fear', 'surprise', 'calm', 'tension'] as const
export type Emotion = (typeof EMOTIONS)[number]

/** a plain time range inside a clip */
export interface Span {
  startSec: number
  endSec: number
}

/** a person the AI recognised across several shots of a clip (clustered by appearance, not by name) */
export interface FootageCastMember {
  id: string
  /** what they look like, in the vision model's words ("man in a red jacket, grey beard") */
  appearance: string
  sightings: number
}

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
  /** professional-editor problems with this shot (measured locally, confirmed by the vision model) */
  defects?: ShotDefect[]
  /** how many people are visible (0 = nobody) */
  people?: number
  /** true when someone visible is talking (mouth moving, facing camera or a partner) */
  talkingVisible?: boolean
  /** emotional states seen in the shot, from EMOTIONS */
  emotion?: string[]
  /** the main things in the shot besides people ("surfboard", "cake", "whiteboard") */
  objects?: string[]
  /** what this shot is about, in a few words ("arriving at the beach") */
  topic?: string
  /** cast members visible in this shot, by id */
  castIds?: string[]
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
  /** what the clip is about overall, from the transcript (absent until listened) */
  topic?: string
  /** people recognised across this clip's shots */
  cast?: FootageCastMember[]
  /** speech heard while nobody visible is talking (a voice behind the camera) */
  offscreenSpeech?: Span[]
  /** quiet stretches long enough to feel dead on screen */
  longPauses?: Span[]
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
  /** what the person told the editor to focus on, avoid, and quote on screen */
  brief?: FootageBrief
  /** ask = the agent puts its questions to the person; autopilot = it decides and reports */
  agentMode?: AgentMode
}

/** the person's standing instructions for one footage project */
export interface FootageBrief {
  /** people or objects the edit should be built around ("grandma", "the surfboard") */
  focus: string[]
  /** people, objects or scenes to keep out of the edit (distractions) */
  avoid: string[]
  /** pasted markdown the editor may quote on screen: facts, names, designations, sources */
  references: string
  /** files kept beside the project (markdown notes, pictures for reference cards), relative to the project folder */
  referenceFiles: string[]
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
  | FootagePariEvent

// ---------------------------------------------------------------- the PARI editing agent

/** one thing the agent checked about the edit it made */
export interface FootageCheck {
  /** stable id ("length", "overlays", "edit-3"…) */
  id: string
  /** what was checked, in plain words */
  label: string
  status: CheckStatus
  /** what was looked at ("the finished video is 29.6s of the 30s asked for") */
  evidence: string[]
  /** plain-language note for the person */
  note: string
  attempts: number
}

/** the honest end-of-run report, kept beside the project as pari-report.json */
export interface FootagePariReport {
  title: string
  prompt: string
  createdAt: string
  checks: FootageCheck[]
  /** instructions the edit does not carry out, and why */
  shortfalls: string[]
  /** every model switch the routing made, with its reason ("planner: flash → pro, the catalog was 96k chars") */
  modelSwitches: string[]
  /** midway instructions the person sent, and what the agent answered */
  instructions: Array<{ text: string; reply: string }>
  edit?: EditRecord
}

export type FootagePariEvent =
  | { kind: 'pari-plan'; projectId: string; plan: EditPlan; source: 'ai' | 'basic'; prompt: string }
  | { kind: 'pari-decide'; projectId: string; requests: DecisionRequest[]; /** true = autopilot already answered: show the choices in the log, do not ask */ auto?: boolean }
  | { kind: 'pari-check'; projectId: string; check: FootageCheck }
  | { kind: 'pari-report'; projectId: string; report: FootagePariReport }
  | { kind: 'pari-note'; projectId: string; text: string }

/** ipc channel the UI answers decisions on: invoke('footage:decide', answers: DecisionAnswer[] | null)  (null = stop the run) */
export const FOOTAGE_DECIDE_CHANNEL = 'footage:decide'

/** what the PARI loop needs from the app; every part is injectable so the loop stays pure and testable */
export interface FootagePariHooks {
  mode: AgentMode
  emit: (e: FootagePariEvent) => void
  /** put questions to the person; null = the person chose to stop */
  decide: (requests: DecisionRequest[]) => Promise<DecisionAnswer[] | null>
  /** free-text instructions the person sent mid-run, drained at stage boundaries */
  takeInstructions: () => string[]
  /** turn one instruction into plan changes and a plain-language reply */
  interpret: (text: string, plan: EditPlan) => Promise<{ reply: string; plan: EditPlan }>
  /** make sure the footage is indexed and understood; { ok: false, reason } when it cannot be */
  ensureUnderstood: () => Promise<{ ok: boolean; reason?: string }>
  /** plan the edit from the brief */
  plan: () => Promise<PlanResult>
  /** render the finished plan */
  render: (plan: EditPlan) => Promise<EditRecord>
  isCancelled: () => boolean
}

export interface FootagePariOutcome {
  report: FootagePariReport
  /** true when the person (or a failed required step) stopped the run before the end */
  stopped: boolean
}

// ---------------------------------------------------------------- edit plan

export const MUSIC_MOODS = ['upbeat', 'cinematic', 'minimal', 'playful', 'dark', 'corporate'] as const

/** the built-in score mood that fits the emotions the editor detected (Lyra instead gets a style sentence) */
export function moodForEmotions(emotions: readonly string[]): MusicChoice['mood'] {
  const map: Record<string, MusicChoice['mood']> = {
    anger: 'dark', love: 'cinematic', empathy: 'cinematic', compassion: 'cinematic', joy: 'upbeat',
    sadness: 'dark', fear: 'dark', surprise: 'playful', calm: 'minimal', tension: 'dark'
  }
  const votes = new Map<MusicChoice['mood'], number>()
  for (const e of emotions) {
    const m = map[e]
    if (!m) continue
    votes.set(m, (votes.get(m) ?? 0) + 1)
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'cinematic'
}

/** small corrective adjustments the editor may apply to a shot (all optional, all bounded) */
export const SegmentFixes = z.object({
  /** -1 = clearly darker … +1 = clearly brighter */
  exposure: z.number().min(-1).max(1).optional(),
  contrast: z.number().min(-1).max(1).optional(),
  warmth: z.number().min(-1).max(1).optional(),
  stabilize: z.boolean().optional()
})
export type SegmentFixes = z.infer<typeof SegmentFixes>

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
  focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
  /** corrective adjustments for this shot's measured problems */
  fixes: SegmentFixes.optional()
})
export type PlanSegment = z.infer<typeof PlanSegment>

export const MusicChoice = z.object({
  /** none · auto = the built-in score in the chosen mood · file = the person's own track · lyra = an AI-composed track (costs about $0.08) */
  mode: z.enum(['none', 'auto', 'file', 'lyra']).default('auto'),
  mood: z.enum(MUSIC_MOODS).default('upbeat'),
  file: z.string().optional(),
  /** for lyra: the style sentence composed from the detected emotions */
  styleBrief: z.string().max(300).optional()
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

/** the overlay effects the editor can choose for an edit (rendered as HTML/CSS/JS frames with transparency) */
export const OVERLAY_EFFECTS = ['lowerThird', 'refCard', 'chapterTitle', 'quoteBand', 'statChip', 'emotionAccent'] as const
export type OverlayEffect = (typeof OVERLAY_EFFECTS)[number]

/** one chosen overlay, timed on the finished video like a title */
export const OverlayPlan = z.object({
  id: z.string().default(''),
  effect: z.enum(OVERLAY_EFFECTS),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  /** effect-specific content (name, designation, quote, stat, reference text, emotion, colour hints) */
  params: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  why: z.string().default('')
})
export type OverlayPlan = z.infer<typeof OverlayPlan>

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
  /** overlay effects the editor chose (name tags, reference cards, chapter titles, emotion accents) */
  overlays: z.array(OverlayPlan).max(6).default([]),
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
  /** let the editor add overlay effects (name tags, reference cards, emotion accents) */
  overlays?: boolean
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
