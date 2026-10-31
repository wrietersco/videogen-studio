import { segmentStarts, shapeSize, type EditPlan, type FootageClip, type PlanTitle } from '../../shared/footage'

/**
 * Subtitles and titles. Cues are timed on the finished video (speed changes and
 * crossfade overlaps included) and written as an ASS file that ffmpeg burns in.
 */

export interface Cue {
  startSec: number
  endSec: number
  text: string
}

const MAX_WORDS = 5
const MAX_CHARS = 34
const MIN_CUE_SEC = 0.35

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** the spoken lines inside each kept part, split into short readable chunks */
export function captionCues(plan: Pick<EditPlan, 'segments'>, clips: Map<string, FootageClip>): Cue[] {
  const starts = segmentStarts(plan)
  const cues: Cue[] = []
  plan.segments.forEach((seg, i) => {
    const clip = clips.get(seg.clipId)
    if (!seg.keepAudio || !clip?.hasAudio || !clip.transcript?.length) return
    for (const line of clip.transcript) {
      const from = Math.max(line.startSec, seg.startSec)
      const to = Math.min(line.endSec, seg.endSec)
      if (to - from < 0.15) continue
      const words = line.text.trim().split(/\s+/).filter(Boolean)
      if (!words.length) continue
      const span = Math.max(0.01, line.endSec - line.startSec)
      // keep only the words that fall inside the kept part (speech is spread evenly over its line)
      const a = Math.floor(((from - line.startSec) / span) * words.length + 1e-6)
      const b = Math.ceil(((to - line.startSec) / span) * words.length - 1e-6)
      const part = words.slice(Math.max(0, a), Math.min(words.length, Math.max(a + 1, b)))
      if (!part.length) continue
      const chunks: string[][] = []
      let cur: string[] = []
      for (const w of part) {
        if (cur.length && (cur.length >= MAX_WORDS || (cur.join(' ') + ' ' + w).length > MAX_CHARS)) {
          chunks.push(cur)
          cur = []
        }
        cur.push(w)
      }
      if (cur.length) chunks.push(cur)
      const total = part.length
      let used = 0
      for (const chunk of chunks) {
        const s = from + ((to - from) * used) / total
        used += chunk.length
        const e = from + ((to - from) * used) / total
        cues.push({
          startSec: round3(starts[i] + (s - seg.startSec) / seg.speed),
          endSec: round3(starts[i] + (e - seg.startSec) / seg.speed),
          text: chunk.join(' ')
        })
      }
    }
  })
  cues.sort((x, y) => x.startSec - y.startSec)
  // never overlap, never flash by too quickly to read
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]
    if (cues[i].endSec - cues[i].startSec < MIN_CUE_SEC) cues[i].endSec = cues[i].startSec + MIN_CUE_SEC
    if (next && cues[i].endSec > next.startSec) cues[i].endSec = next.startSec
  }
  return cues.filter((c) => c.endSec - c.startSec > 0.05)
}

/** drop items that start past the end of the video, trim the ones that straddle it */
export function clampToLength<T extends { startSec: number; endSec: number }>(items: T[], totalSec: number): T[] {
  return items.filter((x) => x.startSec < totalSec - 0.05).map((x) => ({ ...x, endSec: Math.min(x.endSec, totalSec) }))
}

const clock = (sec: number): string => {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/** plain text → safe ASS text (override braces and line breaks would otherwise be read as commands) */
export function assText(text: string): string {
  return text.replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\r?\n+/g, '\\N').trim()
}

const COLOR = { white: '&H00FFFFFF', black: '&H00000000', amber: '&H0000D2FF', shade: '&HA0000000', deep: '&H66000000' }

export function buildAss(plan: Pick<EditPlan, 'shape' | 'captions'>, cues: Cue[], titles: PlanTitle[]): string {
  const { width: W, height: H } = shapeSize(plan.shape)
  const base = Math.min(W, H)
  const portrait = H > W * 1.2
  const capSize = Math.round(base * (plan.captions === 'bold' ? 0.082 : 0.062))
  const titleSize = Math.round(base * 0.1)
  const sideMargin = Math.round(W * 0.08)
  // keep text above the app buttons of vertical feeds
  const capMargin = Math.round(H * (portrait ? 0.17 : 0.09))
  const outline = Math.max(2, Math.round(base * 0.006))
  const styles: string[] = []
  const style = (name: string, font: string, size: number, primary: string, outlineColor: string, back: string, bold: number, border: number, outlinePx: number, shadow: number, align: number, marginV: number) =>
    styles.push(`Style: ${name},${font},${size},${primary},&H000000FF,${outlineColor},${back},${bold},0,0,0,100,100,0,0,${border},${Math.round(outlinePx)},${shadow},${align},${sideMargin},${sideMargin},${marginV},1`)
  if (plan.captions === 'clean') style('Cap', 'Arial', capSize, COLOR.white, COLOR.black, COLOR.shade, -1, 1, outline, 1, 2, capMargin)
  if (plan.captions === 'bold') style('Cap', 'Arial Black', capSize, COLOR.amber, COLOR.black, COLOR.shade, 0, 1, outline * 1.6, 2, 2, capMargin)
  if (plan.captions === 'box') style('Cap', 'Arial', capSize, COLOR.white, COLOR.deep, COLOR.deep, -1, 3, base * 0.012, 0, 2, capMargin)
  style('TitleTop', 'Arial Black', titleSize, COLOR.white, COLOR.black, COLOR.shade, 0, 1, outline * 1.4, 2, 8, Math.round(H * 0.1))
  style('TitleCenter', 'Arial Black', titleSize, COLOR.white, COLOR.black, COLOR.shade, 0, 1, outline * 1.4, 2, 5, 0)
  style('TitleBottom', 'Arial Black', titleSize, COLOR.white, COLOR.black, COLOR.shade, 0, 1, outline * 1.4, 2, 2, Math.round(H * (portrait ? 0.3 : 0.16)))
  const events: string[] = []
  if (plan.captions !== 'off') {
    for (const c of cues) {
      const text = plan.captions === 'bold' ? c.text.toUpperCase() : c.text
      events.push(`Dialogue: 0,${clock(c.startSec)},${clock(c.endSec)},Cap,,0,0,0,,{\\fad(80,80)}${assText(text)}`)
    }
  }
  for (const t of titles) {
    const name = t.position === 'top' ? 'TitleTop' : t.position === 'bottom' ? 'TitleBottom' : 'TitleCenter'
    events.push(`Dialogue: 1,${clock(t.startSec)},${clock(t.endSec)},${name},,0,0,0,,{\\fad(300,300)}${assText(t.text)}`)
  }
  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events,
    ''
  ].join('\n')
}

/** ffmpeg filter text for a file path: the drive colon must be escaped */
export function filterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:')
}
