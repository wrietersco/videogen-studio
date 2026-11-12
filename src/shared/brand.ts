import type { Palette, SpecBrand, VideoSpec } from './spec'

/**
 * Brand kits — a person's own look (logo, colors, fonts), picked once per
 * video. Everything here is pure: the same kit and spec always give the same
 * branded spec, so the composer stays deterministic.
 */

/** fonts the app ships; a kit may only pick from these (own font files come later) */
export const BRAND_FONTS = ['Archivo Black', 'Space Grotesk', 'Playfair Display', 'Nunito', 'Inter'] as const
export type BrandFont = (typeof BRAND_FONTS)[number]

export const WATERMARK_POSITIONS = ['off', 'top-left', 'top-right'] as const
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number]

export interface BrandLogo {
  /** prepared files inside the kit's folder (transparent PNGs, trimmed) */
  master: string
  onDark: string
  onLight: string
  width: number
  height: number
  /** colors found in the logo, most common first (hex) */
  palette: string[]
  /** plain-language notes from the upload checks */
  notes: string[]
}

export interface BrandKit {
  id: string
  name: string
  /** short line under the logo on the end card, e.g. a website */
  tagline: string
  colors: { primary: string | null; secondary: string | null }
  fonts: { display: BrandFont | null; body: BrandFont | null }
  logo: BrandLogo | null
  watermark: WatermarkPosition
  endCard: boolean
  createdAt: string
  updatedAt: string
}

/** what the renderer shows: the kit plus small previews of both logo versions */
export interface BrandKitView extends BrandKit {
  preview: { onDark: string; onLight: string } | null
}

export type BrandKitPatch = Partial<Pick<BrandKit, 'name' | 'tagline' | 'colors' | 'fonts' | 'watermark' | 'endCard'>>

// ---------------------------------------------------------------- colors

export const HEX = /^#[0-9a-f]{6}$/i

export function rgbOf(hex: string): [number, number, number] {
  const c = hex.replace('#', '')
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)]
}

export function hexOf(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`.toUpperCase()
}

/** WCAG relative luminance, 0 (black) … 1 (white) */
export function luminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

export function luminanceOf(hex: string): number {
  return luminance(...rgbOf(hex))
}

/** WCAG contrast ratio, 1 … 21 */
export function contrast(a: string, b: string): number {
  const la = luminanceOf(a)
  const lb = luminanceOf(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function mixHex(a: string, b: string, wa: number): string {
  const pa = rgbOf(a)
  const pb = rgbOf(b)
  return hexOf(pa[0] * wa + pb[0] * (1 - wa), pa[1] * wa + pb[1] * (1 - wa), pa[2] * wa + pb[2] * (1 - wa))
}

/**
 * A brand color is never used raw: it is nudged toward white (on dark
 * backgrounds) or black (on light ones) until it reads against `bg`.
 * A color that already reads is returned untouched.
 */
export function readable(color: string, bg: string, min = 3): string {
  if (!HEX.test(color) || !HEX.test(bg)) return color
  if (contrast(color, bg) >= min) return color.toUpperCase()
  const toward = luminanceOf(bg) < 0.4 ? '#FFFFFF' : '#000000'
  for (let k = 1; k <= 20; k++) {
    const c = mixHex(color, toward, 1 - k * 0.05)
    if (contrast(c, bg) >= min) return c
  }
  return toward
}

/** the kit's two accents, made readable on a background */
export function brandAccents(colors: { primary: string; secondary?: string }, bg: string): { accent: string; accent2: string } {
  const accent = readable(colors.primary, bg)
  const second = colors.secondary && HEX.test(colors.secondary) ? colors.secondary : mixHex(colors.primary, luminanceOf(bg) < 0.4 ? '#FFFFFF' : '#000000', 0.55)
  return { accent, accent2: readable(second, bg) }
}

export function brandPalette(base: Palette, colors: { primary: string; secondary?: string }): Palette {
  if (!HEX.test(colors.primary) || !HEX.test(base.bg)) return base
  return { ...base, ...brandAccents(colors, base.bg) }
}

/** directed films sit on their own dark backdrop (see composer/crafted.ts craftTheme) */
const DIRECTED_BG = '#090D18'

/**
 * Put the spec's brand block into effect: accents and fonts. Safe to call
 * any number of times; a spec without a brand is returned as is.
 */
export function applyBrand(spec: VideoSpec): VideoSpec {
  const b = spec.brand
  if (!b) return spec
  let next = spec
  if (b.colors && HEX.test(b.colors.primary)) {
    next = { ...next, palette: brandPalette(next.palette, b.colors) }
    if (next.design) next = { ...next, design: { ...next.design, ...brandAccents(b.colors, DIRECTED_BG) } }
  }
  if (b.fonts?.display || b.fonts?.body) {
    next = {
      ...next,
      typography: {
        ...next.typography,
        ...(b.fonts.display ? { display: `${b.fonts.display}, sans-serif` } : {}),
        ...(b.fonts.body ? { body: `${b.fonts.body}, sans-serif` } : {})
      }
    }
  }
  return next
}

/** the brand block a kit puts on a video (logo paths are filled in when files are copied) */
export function specBrandOf(kit: BrandKit, logoFiles: { onDark: string; onLight: string } | null): SpecBrand {
  const display = kit.fonts.display ?? undefined
  const body = kit.fonts.body ?? undefined
  return {
    kitId: kit.id,
    name: kit.name,
    tagline: kit.tagline,
    colors: kit.colors.primary && HEX.test(kit.colors.primary) ? { primary: kit.colors.primary, secondary: kit.colors.secondary && HEX.test(kit.colors.secondary) ? kit.colors.secondary : undefined } : undefined,
    fonts: display || body ? { display, body } : undefined,
    logo: kit.logo && logoFiles ? { ...logoFiles, aspect: kit.logo.width / Math.max(1, kit.logo.height) } : undefined,
    watermark: kit.logo ? kit.watermark : 'off',
    endCard: Boolean(kit.logo) && kit.endCard
  }
}

/** one line per thing the app will do with this kit — shown before generating */
export function brandSummary(base: BrandKit, override?: { watermark?: WatermarkPosition; endCard?: boolean }): string[] {
  const kit: BrandKit = { ...base, watermark: override?.watermark ?? base.watermark, endCard: override?.endCard ?? base.endCard }
  const out: string[] = []
  if (kit.logo && kit.watermark !== 'off') out.push(`Logo in the ${kit.watermark === 'top-left' ? 'top left' : 'top right'} corner`)
  if (kit.logo && kit.endCard) out.push(`Logo end card${kit.tagline ? ` with "${kit.tagline}"` : ''}`)
  if (kit.colors.primary) out.push(`Brand colors ${[kit.colors.primary, kit.colors.secondary].filter(Boolean).join(' + ')}`)
  if (kit.fonts.display || kit.fonts.body) out.push(`Fonts: ${[kit.fonts.display, kit.fonts.body].filter(Boolean).join(' / ')}`)
  return out
}
