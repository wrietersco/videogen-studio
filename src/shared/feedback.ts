/**
 * What the person thought of a finished video, saved with everything the
 * video was made of (prompt, brand, settings). Nothing reads it yet — it is
 * the memory the app will one day use to treat a similar prompt the way the
 * person liked. One entry per video, for every mode.
 */

export type FeedbackRating = 'up' | 'down'
/** create = My videos, app = Record an app, market = Market my business, footage = Edit footage, asset = a picture/clip/sound in the Library */
export type FeedbackMode = 'create' | 'app' | 'market' | 'footage' | 'asset'

/** one aspect list; the wording flips by rating so up and down stay comparable */
export const FEEDBACK_REASONS: ReadonlyArray<{ id: string; up: string; down: string }> = [
  { id: 'visuals', up: 'Looks great', down: 'Weak visuals' },
  { id: 'story', up: 'Story & script work', down: 'Weak story or script' },
  { id: 'pacing', up: 'Pacing & length feel right', down: 'Pacing or length wrong' },
  { id: 'brand', up: 'On-brand', down: 'Off-brand' },
  { id: 'audio', up: 'Voice & music fit', down: "Voice & music don't fit" }
]

export const FEEDBACK_REASON_IDS = FEEDBACK_REASONS.map((r) => r.id)
export const FEEDBACK_COMMENT_MAX = 2000

/** everything known about the video at the moment feedback was given */
export interface FeedbackContext {
  /** where the finished video was written, if it still was */
  videoPath?: string
  /** the prompt / brief / app context the video started from */
  prompt: string
  platform?: string
  style?: string
  durationSec?: number
  targetSec?: number
  /** the brand the video carried (SpecBrand snapshot, or kit/business facts) */
  brand?: Record<string, unknown>
  /** the generation settings and decisions, verbatim per mode */
  decisions: Record<string, unknown>
  /** anything else worth remembering (revision chain, agent notes…) */
  extras?: Record<string, unknown>
}

export interface FeedbackEntry {
  version: 1
  /** the video this is about: project id (create), run id (app), mrun id (market) */
  videoId: string
  mode: FeedbackMode
  rating: FeedbackRating
  /** ids from FEEDBACK_REASONS, any number */
  reasons: string[]
  /** the person's own words, trimmed */
  comment: string
  createdAt: string
  updatedAt: string
  context: FeedbackContext
}

export interface FeedbackInput {
  rating: FeedbackRating
  reasons: string[]
  comment: string
}
