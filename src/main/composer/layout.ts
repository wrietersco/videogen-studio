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
  return {
    width: preset.width,
    height: preset.height,
    safe: {
      x: s.left,
      y: s.top,
      w: preset.width - s.left - s.right,
      h: preset.height - s.top - s.bottom
    },
    scale,
    palette: spec.palette,
    typography: spec.typography,
    pacing: spec.pacing,
    motion: PACING_TUNING[spec.pacing].motion,
    isVertical: preset.height >= preset.width
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
 * Wrap a headline into lines that fit the safe width (greedy).
 * Rough char-width estimate; the QA layout check catches any overflow this misses.
 */
export function fitLines(text: string, maxLines: number, maxWidthPx: number, fontSizePx: number): string[] {
  const charW = fontSizePx * 0.52 // generous average for caps display faces
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
  // too many lines: fold the tail into the last allowed line; QA flags true overflow
  const head = lines.slice(0, maxLines - 1)
  head.push(lines.slice(maxLines - 1).join(' '))
  return head
}
