import { ipcMain } from 'electron'
import { FEEDBACK_COMMENT_MAX } from '../../shared/feedback'
import { isFeedbackMode, isFeedbackRating, type FeedbackStore } from './store'
import { captureFeedbackContext } from './capture'

/**
 * The bridge of the feedback box under a finished video: the screen sends
 * only the opinion (and which video it is about); the main process gathers
 * everything the video was made of itself, so the saved memory is always the
 * whole truth. Nothing in the engines reads it back.
 */

export function registerFeedbackIpc(store: FeedbackStore): void {
  ipcMain.handle('feedback:save', (_e, mode: unknown, videoId: unknown, rating: unknown, reasons: unknown, comment: unknown) => {
    if (!isFeedbackMode(mode)) return { ok: false as const, error: 'Unknown video type.' }
    if (typeof videoId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(videoId)) return { ok: false as const, error: 'Unknown video.' }
    if (!isFeedbackRating(rating)) return { ok: false as const, error: 'Choose thumbs up or thumbs down first.' }
    try {
      const context = captureFeedbackContext(mode, videoId)
      const entry = store.upsert(videoId, mode, rating, reasons, typeof comment === 'string' ? comment.slice(0, FEEDBACK_COMMENT_MAX) : '', context)
      return { ok: true as const, entry }
    } catch {
      return { ok: false as const, error: 'The opinion could not be saved. Try again.' }
    }
  })

  ipcMain.handle('feedback:get', (_e, videoId: unknown) => (typeof videoId === 'string' ? store.get(videoId) : null))
}
