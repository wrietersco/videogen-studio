import type { BgStyle, SceneCraft, VideoSpec } from './spec'

/**
 * Visual rhythm for scenes that have no picture behind them. A film uses a
 * small family of backgrounds that suits its mood, never repeats one twice in
 * a row, and always gives the same answer for the same film.
 */

const FAMILIES: Record<string, BgStyle[]> = {
  calm: ['contours', 'rings', 'spotlight', 'waves'],
  energetic: ['rays', 'grid', 'blueprint', 'rings'],
  precise: ['blueprint', 'grid', 'rings', 'contours'],
  dramatic: ['spotlight', 'rays', 'waves', 'contours']
}

export function familyFor(spec: Pick<VideoSpec, 'musicMood' | 'pacing' | 'style'>): BgStyle[] {
  if (spec.musicMood === 'cinematic' || spec.musicMood === 'minimal' || spec.pacing === 'calm') return FAMILIES.calm
  if (spec.musicMood === 'corporate' || spec.style === 'explainer') return FAMILIES.precise
  if (spec.musicMood === 'dark') return FAMILIES.dramatic
  return FAMILIES.energetic
}

/** a small stable number from text (no randomness: same film, same look) */
export function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  return h >>> 0
}

export function varyBackgrounds(spec: VideoSpec): SceneCraft[] {
  const family = familyFor(spec)
  const start = seedOf(spec.title) % family.length
  let previous: BgStyle | null = null
  let n = 0
  return spec.crafts.map((c) => {
    // only scenes with nothing behind them wear procedural art; plates and photos stay as they are
    if (c.background !== 'grid' || c.media?.fit === 'cover') return { ...c, bgStyle: 'grid' as const }
    let style = family[(start + n * 3 + (n % 2)) % family.length]
    if (style === previous) style = family[(family.indexOf(style) + 1) % family.length]
    previous = style
    n += 1
    return { ...c, bgStyle: style }
  })
}
