import type { PlatformPreset } from '@shared/presets'
import { PACING_TUNING } from '@shared/presets'
import type { Pacing, Palette, Typography, VideoSpec } from '@shared/spec'

/**
 * Layout engine — turns platform preset + spec design tokens into concrete
 * geometry and type scale. All scene renderers draw from this, so every
 * video is composition-safe per platform (nothing important behind the
 * TikTok reply button, etc).
 */

export interface DesignContext {
  width: number
  height: number
  safe: { x: number; y: number; w: number; h: number }
  /** caption band sits ABOVE the platform UI zone (TikTok buttons etc.) */
  captionBand: { bottomPx: number; maxWidthPx: number }
  scale: number // 1.0 at 1080p short-edge
  palette: Palette
  typography: Typography
  pacing: Pacing
  motion: number // 0..~1.4 intensity multiplier from pacing
  isVertical: boolean
}

export function designContext(spec: VideoSpec, preset: PlatformPreset): DesignContext {
  const scale = Math.min(preset.width, preset.height) / 1080
  const s = preset.safeZone
  const isVertical = preset.height >= preset.width
  return {
    width: preset.width,
    height: preset.height,
    safe: {
      x: s.left,
      y: s.top,
      w: preset.width - s.left - s.right,
      h: preset.height - s.top - s.bottom
    },
    // clear of the platform chrome (like/comment/share rail on verticals,
    // end-screen reserve on YouTube) and never glued to the frame edge
    captionBand: {
      bottomPx: Math.round(preset.height * (isVertical ? 0.17 : preset.width > preset.height ? 0.1 : 0.14)),
      maxWidthPx: Math.round((preset.width - s.left - s.right) * 0.88)
    },
    scale,
    palette: spec.palette,
    typography: spec.typography,
    pacing: spec.pacing,
    motion: PACING_TUNING[spec.pacing].motion,
    isVertical
  }
}

/** Fluid type scale, clamped so even extreme headlines stay inside safe area. */
export function typeScale(ctx: DesignContext) {
  const s = ctx.scale
  return {
    kicker: Math.round(34 * s),
    display: Math.round(120 * s),
    headline: Math.round(88 * s),
    subline: Math.round(52 * s),
    body: Math.round(44 * s),
    bullet: Math.round(54 * s),
    statValue: Math.round(260 * s),
    statLabel: Math.round(46 * s),
    quote: Math.round(76 * s),
    caption: Math.round(56 * s),
    cta: Math.round(96 * s)
  }
}

export function fontFamily(t: Typography): string {
  return `'${t.display.split(',')[0].trim()}', ${t.display.includes('serif') && !t.display.includes('sans') ? 'serif' : 'sans-serif'}`
}

export function bodyFamily(t: Typography): string {
  return `'${t.body.split(',')[0].trim()}', sans-serif`
}

/**
 * Wrap a headline into lines that fit the safe width (greedy, spaces only).
 * Lines are rendered nowrap in the browser; the in-page autofit pass then
 * scales the font until every line fits — so this estimate only sets the
 * starting size, never the final layout.
 */
export function fitLines(text: string, maxLines: number, maxWidthPx: number, fontSizePx: number): string[] {
  const charW = fontSizePx * 0.56 // average for caps display faces
  const perLine = Math.max(6, Math.floor(maxWidthPx / charW))
  const words = text.split(/\s+/)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const attempt = cur ? `${cur} ${w}` : w
    if (attempt.length > perLine && cur) {
      lines.push(cur)
      cur = w
    } else {
      cur = attempt
    }
  }
  if (cur) lines.push(cur)
  if (lines.length <= maxLines) return lines
  // too many lines: fold the tail into the last allowed line; autofit re-scales
  const head = lines.slice(0, maxLines - 1)
  head.push(lines.slice(maxLines - 1).join(' '))
  return head
}

/** browser autofit contract baked into markup: exact px budgets per element */
export function fitAttrs(maxW: number, maxH: number, mode: 'lines' | 'box'): string {
  return `data-fit="${mode}" data-maxw="${Math.round(maxW)}" data-maxh="${Math.round(maxH)}"`
}

function normWords(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  )
}

/** 0..1 — how much of `b`'s meaningful words already appear in `a` */
export function textOverlap(a: string, b: string): number {
  const wa = normWords(a)
  const wb = [...normWords(b)]
  if (wa.size === 0 || wb.length === 0) return 0
  let hit = 0
  for (const w of wb) if (wa.has(w)) hit += 1
  return hit / wb.length
}

/**
 * Presentation hygiene: the planner (any model, any quality) may emit a
 * kicker/subline that repeats the headline — showing both reads as a glitch.
 * Later fields duplicating earlier ones are dropped deterministically.
 */
export function dedupeFields<T extends { headline?: string }>(parts: T): T {
  const seen: string[] = []
  const headline = ('headline' in parts && parts.headline) || ''
  if (headline) seen.push(headline)
  const out = { ...parts }
  for (const key of ['kicker', 'subline'] as const) {
    if (!(key in out)) continue
    const v = (out as Record<string, unknown>)[key]
    if (typeof v !== 'string' || !v) continue
    if (seen.some((s) => textOverlap(s, v) >= 0.6)) {
      ;(out as Record<string, unknown>)[key] = ''
    } else {
      seen.push(v)
    }
  }
  return out
}
