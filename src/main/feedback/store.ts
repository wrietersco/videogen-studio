import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  FEEDBACK_COMMENT_MAX,
  FEEDBACK_REASON_IDS,
  type FeedbackContext,
  type FeedbackEntry,
  type FeedbackMode,
  type FeedbackRating
} from '../../shared/feedback'

/**
 * What the person thought of finished videos, all modes together, on this
 * computer: <userData>/feedback.json. One entry per video, upserted by its id.
 * Nothing reads it back yet — it is the memory a future version will use to
 * treat a similar prompt the way the person liked, so it is written to
 * outlive the video it describes.
 */

interface Saved {
  version: 1
  entries: FeedbackEntry[]
}

const RATINGS: FeedbackRating[] = ['up', 'down']
const MODES: FeedbackMode[] = ['create', 'app', 'market', 'footage', 'asset']
const clean = (s: unknown, max: number): string => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)

export function isFeedbackRating(v: unknown): v is FeedbackRating {
  return RATINGS.includes(v as FeedbackRating)
}
export function isFeedbackMode(v: unknown): v is FeedbackMode {
  return MODES.includes(v as FeedbackMode)
}

export class FeedbackStore {
  private saved: Saved | null = null

  constructor(readonly file: string) {}

  private load(): Saved {
    if (this.saved) return this.saved
    let entries: FeedbackEntry[] = []
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>
      entries = Array.isArray(raw.entries) ? raw.entries.filter((e) => e && typeof e.videoId === 'string' && isFeedbackRating(e.rating) && isFeedbackMode(e.mode)) : []
    } catch {
      /* first run or unreadable file — start empty */
    }
    this.saved = { version: 1, entries }
    return this.saved
  }

  /** atomic (tmp + rename), like the usage meter, so a crash never leaves a half-written memory */
  private write(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = join(dirname(this.file), `.feedback-${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(this.load(), null, 2))
    try {
      renameSync(tmp, this.file)
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    }
  }

  list(): FeedbackEntry[] {
    return this.load().entries
  }

  get(videoId: string): FeedbackEntry | null {
    return this.load().entries.find((e) => e.videoId === videoId) ?? null
  }

  /** save the person's opinion, replacing any earlier one for the same video */
  upsert(videoId: string, mode: FeedbackMode, rating: FeedbackRating, reasons: unknown, comment: unknown, context: FeedbackContext): FeedbackEntry {
    const s = this.load()
    const now = new Date().toISOString()
    const existing = s.entries.find((e) => e.videoId === videoId)
    const entry: FeedbackEntry = {
      version: 1,
      videoId,
      mode,
      rating,
      reasons: Array.isArray(reasons) ? FEEDBACK_REASON_IDS.filter((id) => reasons.includes(id)) : [],
      comment: clean(comment, FEEDBACK_COMMENT_MAX),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      context
    }
    if (existing) s.entries.splice(s.entries.indexOf(existing), 1, entry)
    else s.entries.push(entry)
    this.write()
    return entry
  }

  remove(videoId: string): boolean {
    const s = this.load()
    const i = s.entries.findIndex((e) => e.videoId === videoId)
    if (i < 0) return false
    s.entries.splice(i, 1)
    this.write()
    return true
  }
}
