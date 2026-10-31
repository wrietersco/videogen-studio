import type { EditPlan, FootageClip, PlanSegment } from '../../shared/footage'
import { runFfmpeg } from './ffmpeg'

/**
 * Silence removal: inside the parts where people speak, long quiet gaps are cut
 * out so the talk keeps moving. Works on the audio itself, not the transcript,
 * so breaths and dead air are caught even where speech was never transcribed.
 */

const NOISE_DB = -34
/** pauses shorter than this stay: they are normal breathing room */
const MIN_PAUSE_SEC = 0.55
/** each side of a cut keeps this much quiet, so words do not sound clipped */
const PAD_SEC = 0.18
const MIN_PIECE_SEC = 0.5

export interface Gap {
  start: number
  end: number
}

export function parseSilences(stderr: string, durationSec: number): Gap[] {
  const gaps: Gap[] = []
  let open: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line)
    if (s) open = Math.max(0, parseFloat(s[1]))
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line)
    if (e && open !== null) {
      gaps.push({ start: open, end: Math.min(durationSec, parseFloat(e[1])) })
      open = null
    }
  }
  if (open !== null) gaps.push({ start: open, end: durationSec })
  return gaps
}

export async function detectSilences(path: string, startSec: number, endSec: number): Promise<Gap[]> {
  const len = endSec - startSec
  const run = await runFfmpeg(['-ss', String(startSec), '-t', String(len), '-i', path, '-vn', '-af', `silencedetect=noise=${NOISE_DB}dB:d=${MIN_PAUSE_SEC}`, '-f', 'null', '-'])
  return run.code === 0 ? parseSilences(run.stderr, len) : []
}

/** the segment minus its long pauses, as one or more segments in the same order */
export function splitAtGaps(seg: PlanSegment, gaps: Gap[]): PlanSegment[] {
  const pieces: PlanSegment[] = []
  let from = 0
  const len = seg.endSec - seg.startSec
  const push = (a: number, b: number) => {
    if (b - a >= MIN_PIECE_SEC) pieces.push({ ...seg, startSec: round2(seg.startSec + a), endSec: round2(seg.startSec + b), transition: pieces.length ? 'cut' : seg.transition })
  }
  for (const g of gaps) {
    // keep a little of the quiet on both sides of the cut
    const cutA = g.start + PAD_SEC
    const cutB = g.end - PAD_SEC
    if (cutB - cutA < 0.2) continue
    push(from, Math.min(len, cutA))
    from = Math.max(from, cutB)
  }
  push(from, len)
  return pieces.length ? pieces : [seg]
}

export interface TightenResult {
  plan: EditPlan
  removedSec: number
}

/** applies silence removal to every part that keeps its own sound */
export async function tightenPlan(plan: EditPlan, clips: FootageClip[], isCancelled: () => boolean = () => false): Promise<TightenResult> {
  const byId = new Map(clips.map((c) => [c.id, c]))
  const out: PlanSegment[] = []
  let removed = 0
  for (const seg of plan.segments) {
    const clip = byId.get(seg.clipId)
    if (isCancelled() || !seg.keepAudio || !clip?.hasAudio || clip.status !== 'ok') {
      out.push(seg)
      continue
    }
    const gaps = await detectSilences(clip.path, seg.startSec, seg.endSec)
    const pieces = splitAtGaps(seg, gaps)
    removed += (seg.endSec - seg.startSec - pieces.reduce((a, p) => a + (p.endSec - p.startSec), 0)) / seg.speed
    out.push(...pieces)
  }
  return { plan: { ...plan, segments: out }, removedSec: Math.max(0, removed) }
}

const round2 = (n: number) => Math.round(n * 100) / 100
