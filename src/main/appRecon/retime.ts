import { spawnSync } from 'node:child_process'
import { copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Take } from '@shared/appRecon'
import { ffmpegBin } from '../audio/pcm'

/**
 * Editing the kept screen recording: take whole parts (beats) out of it, and hold
 * the last picture of a part a little longer so longer narration fits.
 *
 * Everything the video needs to know about the recording (when each beat starts and
 * ends, when the address changed) is a time. So an edit is two things: a new file
 * made from the old one, and the same times written again for the new file.
 * The first is ffmpeg's job; the second is plain arithmetic, kept here as pure
 * functions so it can be checked without any video.
 */

/** a stretch of the old recording that stays (seconds on its own clock), and how long its last picture is held afterwards */
export interface Piece {
  a: number
  b: number
  hold: number
}

export interface RetimePlan {
  pieces: Piece[]
  /** the beats still in the recording, in order */
  kept: number[]
  /** length of the new recording */
  total: number
  /** true when nothing was cut and nothing held: the old file can be used as it is */
  unchanged: boolean
}

const EPS = 1e-6

/**
 * Which stretches of the recording stay. A beat owns the time from its own start to the next beat's start
 * (the first owns the lead-in, the last the tail), so cutting a beat leaves no gap and no half-second of it.
 * `hold` (beat → seconds) freezes the picture at the end of that beat's own action.
 */
export function planPieces(take: Take, offsetSec: number, cut: ReadonlySet<number>, hold: ReadonlyMap<number, number> = new Map()): RetimePlan {
  const dur = Math.max(0, take.durationSec)
  const beats = [...take.beats].sort((x, y) => x.startSec - y.startSec)
  if (!beats.length) return { pieces: [{ a: 0, b: dur, hold: 0 }], kept: [], total: dur, unchanged: true }
  // times are kept to the millisecond, so a cut lands exactly where a beat starts (8.2 - 0.2 is 7.999999999999999)
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)) * 1000) / 1000
  let prev = 0
  const starts = beats.map((b) => (prev = Math.max(prev, clamp(b.startSec - offsetSec, 0, dur))))
  const pieces: Piece[] = []
  const kept: number[] = []
  beats.forEach((bt, i) => {
    if (cut.has(bt.beat)) return
    kept.push(bt.beat)
    const a = i === 0 ? 0 : starts[i]
    const b = i + 1 < beats.length ? starts[i + 1] : dur
    const e = clamp(bt.endSec - offsetSec, a, b)
    const h = Math.max(0, hold.get(bt.beat) ?? 0)
    if (h > 0.02 && e > a + 0.05 && e < b - 0.02) pieces.push({ a, b: e, hold: h }, { a: e, b, hold: 0 })
    else pieces.push({ a, b, hold: h })
  })
  const merged: Piece[] = []
  for (const p of pieces) {
    if (p.b - p.a < 0.02 && p.hold <= 0.02) continue
    const last = merged.at(-1)
    if (last && last.hold <= 0.02 && Math.abs(last.b - p.a) < EPS) last.b = p.b
    else merged.push({ ...p })
  }
  const total = merged.reduce((acc, p) => acc + (p.b - p.a) + p.hold, 0)
  const unchanged = merged.length === 1 && merged[0].a < EPS && Math.abs(merged[0].b - dur) < 0.02 && merged[0].hold <= 0.02
  return { pieces: merged, kept, total, unchanged }
}

/** the old recording's time → the new one's (a time exactly where a picture is held lands after the hold) */
export function mapper(plan: RetimePlan): (t: number) => number {
  const starts: number[] = []
  let acc = 0
  for (const p of plan.pieces) {
    starts.push(acc)
    acc += p.b - p.a + p.hold
  }
  return (t: number): number => {
    for (let i = 0; i < plan.pieces.length; i++) {
      const p = plan.pieces[i]
      if (t >= p.a - EPS && t <= p.b + EPS) return starts[i] + (Math.min(t, p.b) - p.a) + (t >= p.b - EPS ? p.hold : 0)
    }
    // inside a stretch that was cut: it is the start of whatever follows
    const next = plan.pieces.findIndex((p) => p.a > t)
    return next < 0 ? acc : starts[next]
  }
}

/** the same take for the new recording: beats cut out are gone, every time is moved, and the address bar still shows the right page where a cut jumps */
export function remapTake(take: Take, offsetSec: number, plan: RetimePlan): Take {
  const map = mapper(plan)
  const starts: number[] = []
  let acc = 0
  for (const p of plan.pieces) {
    starts.push(acc)
    acc += p.b - p.a + p.hold
  }
  const keep = new Set(plan.kept)
  const beats = take.beats.filter((b) => keep.has(b.beat)).map((b) => ({ ...b, startSec: map(b.startSec - offsetSec) + offsetSec, endSec: map(b.endSec - offsetSec) + offsetSec }))
  const navs = [...take.navigations].sort((x, y) => x.t - y.t)
  const urlAt = (raw: number): string | undefined => {
    let url: string | undefined = navs[0]?.url
    for (const n of navs) if (n.t - offsetSec <= raw + EPS) url = n.url
    return url
  }
  const out: Array<{ t: number; url: string }> = []
  plan.pieces.forEach((p, k) => {
    const gapBefore = k === 0 || plan.pieces[k - 1].b < p.a - EPS
    const url = urlAt(p.a)
    if (gapBefore && url) out.push({ t: starts[k] + offsetSec, url })
  })
  for (const n of navs) {
    const r = n.t - offsetSec
    if (plan.pieces.some((p) => r > p.a + EPS && r <= p.b + EPS)) out.push({ t: map(r) + offsetSec, url: n.url })
  }
  out.sort((x, y) => x.t - y.t)
  const navigations = out.filter((n, i) => !(i > 0 && out[i - 1].t === n.t && out[i - 1].url === n.url))
  const log = take.log.filter((l) => plan.pieces.some((p) => l.t - offsetSec >= p.a - EPS && l.t - offsetSec <= p.b + EPS)).map((l) => ({ ...l, t: map(l.t - offsetSec) + offsetSec }))
  return { ...take, durationSec: plan.total, beats, navigations, log }
}

const num = (n: number) => (Math.round(n * 1000) / 1000).toString()

/** the filter graph that cuts the pieces out of the recording and joins them (a held picture is its last frame repeated) */
export function retimeGraph(plan: RetimePlan): string {
  const n = plan.pieces.length
  const lines: string[] = []
  lines.push(n > 1 ? `[0:v]split=${n}${plan.pieces.map((_, i) => `[s${i}]`).join('')}` : '[0:v]null[s0]')
  plan.pieces.forEach((p, i) => {
    const pad = p.hold > 0.02 ? `,tpad=stop_mode=clone:stop_duration=${num(p.hold)}` : ''
    lines.push(`[s${i}]trim=start=${num(p.a)}:end=${num(p.b)},setpts=PTS-STARTPTS${pad},fps=30,format=yuv420p[v${i}]`)
  })
  lines.push(`${plan.pieces.map((_, i) => `[v${i}]`).join('')}concat=n=${n}:v=1:a=0[out]`)
  return lines.join(';')
}

/** make the new recording file; with nothing to change the old one is simply copied */
export function retimeFootage(input: string, output: string, plan: RetimePlan): void {
  if (!plan.pieces.length) throw new Error('Every part of the recording was cut, so there is nothing left to make a video from.')
  if (plan.unchanged) {
    if (input !== output) copyFileSync(input, output)
    return
  }
  const script = join(dirname(output), 'retime-graph.txt')
  writeFileSync(script, retimeGraph(plan))
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-y', '-i', input, '-filter_complex_script', script, '-map', '[out]', '-c:v', 'libx264', '-crf', '14', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', output], { maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`Editing the recording failed: ${r.stderr?.toString().slice(0, 500)}`)
}
