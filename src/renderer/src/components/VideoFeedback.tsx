import { useEffect, useState } from 'react'
import { FEEDBACK_REASONS, type FeedbackEntry, type FeedbackMode, type FeedbackRating } from '@shared/feedback'
import { api } from '../api'

/**
 * The little box under a finished video: was it good? The opinion, and what
 * the video was made of, is saved with it — the app's memory of what the
 * person likes. Shown the same way in every mode.
 */

const pill = (active: boolean): string =>
  `rounded-full border-2 px-3 py-1 text-xs font-bold transition-colors ${active ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/65 hover:border-grape/50'}`

export function VideoFeedback({ mode, videoId, noun = 'video' }: { mode: FeedbackMode; videoId: string; noun?: string }) {
  const [rating, setRating] = useState<FeedbackRating | null>(null)
  const [reasons, setReasons] = useState<string[]>([])
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<FeedbackEntry | null>(null)
  const [editing, setEditing] = useState(true)

  useEffect(() => {
    let alive = true
    api.feedback.get(videoId).then((entry) => {
      if (!alive || !entry) return
      setSaved(entry)
      setRating(entry.rating)
      setReasons(entry.reasons)
      setComment(entry.comment)
      setEditing(false)
    })
    return () => {
      alive = false
    }
  }, [videoId])

  const toggle = (id: string): void => setReasons((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]))

  const save = async (): Promise<void> => {
    if (!rating || busy) return
    setBusy(true)
    setError('')
    const res = await api.feedback.save(mode, videoId, rating, reasons, comment.trim())
    setBusy(false)
    if (res.ok) {
      setSaved(res.entry)
      setEditing(false)
    } else setError(res.error)
  }

  if (saved && !editing) {
    return (
      <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border-2 border-ink/10 bg-white/60 px-3 py-2">
        <span className="text-xs text-ink/55">
          {saved.rating === 'up' ? '👍' : '👎'} Your feedback is saved — thanks!
        </span>
        <button onClick={() => setEditing(true)} className="text-[11px] font-bold uppercase tracking-wide text-grape hover:underline">
          Edit
        </button>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-xl border-2 border-ink/10 bg-white/60 px-3 py-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-ink/40">How did this {noun} turn out?</div>
      <div className="mt-1.5 flex items-center gap-2">
        <button
          aria-label="Thumbs up"
          aria-pressed={rating === 'up'}
          onClick={() => setRating('up')}
          className={pill(rating === 'up')}
        >
          👍 Good
        </button>
        <button
          aria-label="Thumbs down"
          aria-pressed={rating === 'down'}
          onClick={() => setRating('down')}
          className={pill(rating === 'down')}
        >
          👎 Not right
        </button>
      </div>
      {rating && (
        <div className="mt-2 grid grid-cols-2 gap-1.5">
          {FEEDBACK_REASONS.map((r) => (
            <label key={r.id} className={`flex items-center gap-2 rounded-xl border-2 px-2.5 py-1.5 text-xs ${reasons.includes(r.id) ? 'border-grape/40 bg-grape/5' : 'border-ink/5 bg-white'}`}>
              <input type="checkbox" checked={reasons.includes(r.id)} onChange={() => toggle(r.id)} className="accent-grape" />
              <span className="font-semibold text-ink/75">{rating === 'up' ? r.up : r.down}</span>
            </label>
          ))}
        </div>
      )}
      <textarea
        aria-label={`Anything else about this ${noun}`}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder={rating === 'down' ? 'What was wrong? Your words help next time.' : rating === 'up' ? 'What worked? (optional)' : 'Anything else? (optional)'}
        className="field mt-2 w-full px-3 py-1.5 text-sm"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink/45">{error || `Saved with everything this ${noun} was made of, to guide future ones.`}</span>
        <button disabled={!rating || busy} onClick={save} className="btn-primary !px-3 !py-1 !text-xs">
          {busy ? 'Saving…' : 'Save feedback'}
        </button>
      </div>
    </div>
  )
}
