import type { VideoSpec } from '@shared/spec'
import { luminanceOf, HEX } from '@shared/brand'
import type { AnimStep } from './anim'
import type { DesignContext } from './layout'

/**
 * Brand layer — the logo, placed by the app itself. Two deterministic
 * overlays: a small corner mark through the film and a closing logo card.
 * No model draws or sees the logo, so it can never be warped or misspelled.
 */

/** the closing logo card adds this much to the film */
export const BRAND_END_SEC = 2.4

const FILE = /^assets\/brand\/[A-Za-z0-9._-]+\.png$/
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function logoOf(spec: VideoSpec): NonNullable<NonNullable<VideoSpec['brand']>['logo']> | null {
  const logo = spec.brand?.logo
  return logo && FILE.test(logo.onDark) && FILE.test(logo.onLight) && logo.aspect > 0 ? logo : null
}

/** seconds the brand adds after the last scene (0 = no end card) */
export function brandTailSec(spec: VideoSpec): number {
  return spec.brand?.endCard && logoOf(spec) ? BRAND_END_SEC : 0
}

export interface BrandLayer {
  html: string
  css: string
  steps: AnimStep[]
  tailSec: number
}

/**
 * @param bg the film's backdrop color (decides the light or dark logo version)
 * @param ink text color on that backdrop
 * @param contentSec where the last scene ends
 */
export function renderBrand(spec: VideoSpec, ctx: DesignContext, look: { bg: string; ink: string; accent: string; font: string; directed: boolean }, contentSec: number): BrandLayer | null {
  const brand = spec.brand
  const logo = logoOf(spec)
  if (!brand || !logo) return null
  const s = ctx.scale
  const px = (n: number) => Math.round(n * s)
  const darkFilm = !HEX.test(look.bg) || luminanceOf(look.bg) < 0.4
  const src = darkFilm ? logo.onDark : logo.onLight
  const tailSec = brandTailSec(spec)
  const html: string[] = []
  const css: string[] = []
  const steps: AnimStep[] = []

  // ---------- corner mark ----------
  if (brand.watermark !== 'off') {
    // sized by height; wide logos are capped by width, compact ones get a little more height
    let h = px(logo.aspect < 1.6 ? 66 : 46)
    let w = Math.round(h * logo.aspect)
    const maxW = Math.round(ctx.width * 0.24)
    if (w > maxW) {
      w = maxW
      h = Math.max(1, Math.round(w / logo.aspect))
    }
    // the same top band directed scenes use for their label line, above the platform's own buttons
    const top = Math.min(ctx.safe.y, Math.round(ctx.height * 0.1))
    const bandY = Math.max(px(48), top - px(86))
    const margin = Math.max(ctx.safe.x, px(72))
    const y = Math.max(px(24), bandY + px(40) - h)
    const side = brand.watermark === 'top-left' ? `left:${margin}px` : `right:${margin}px`
    html.push(`<img class="brand-mark" id="brand-mark" src="${esc(src)}" alt="" style="${side};top:${y}px;width:${w}px;height:${h}px" />`)
    css.push(`.brand-mark { position: absolute; z-index: 55; opacity: 0.94; pointer-events: none; }`)
    // the logo takes the corner: the scene's own label on that side steps aside
    css.push(`.cr-hud ${brand.watermark === 'top-left' ? '.l' : '.r'} { display: none !important; }`)
    if (tailSec) steps.push({ kind: 'set', t: contentSec, sel: '#brand-mark', set: { autoAlpha: 0 } })
  }

  // ---------- closing logo card ----------
  if (tailSec) {
    let w = Math.round(ctx.safe.w * 0.62)
    let h = Math.round(w / logo.aspect)
    const maxH = Math.round(ctx.height * 0.2)
    if (h > maxH) {
      h = maxH
      w = Math.round(h * logo.aspect)
    }
    const tagline = brand.tagline.trim()
    html.push(
      `<section class="brand-end" id="brand-end"><div class="brand-end-col">` +
        `<img id="brand-end-logo" src="${esc(src)}" alt="" style="width:${w}px;height:${h}px" />` +
        `<i class="brand-end-rule" id="brand-end-rule"></i>` +
        (tagline ? `<p class="brand-end-tag" id="brand-end-tag">${esc(tagline)}</p>` : '') +
        `</div></section>`
    )
    css.push(`
    .brand-end { position: absolute; inset: 0; z-index: 58; background: ${look.bg}; visibility: hidden; }
    .brand-end-col { position: absolute; inset: 0; padding: 0 ${Math.round((ctx.width - ctx.safe.w) / 2)}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${px(34)}px; }
    .brand-end-rule { display: block; width: ${px(120)}px; height: ${Math.max(2, px(5))}px; border-radius: 99px; background: ${look.accent}; transform: scaleX(0); }
    .brand-end-tag { margin: 0; font-family: ${look.font}; font-weight: 600; font-size: ${px(40)}px; letter-spacing: 0.02em; color: ${look.ink}; text-align: center; max-width: 100%; overflow-wrap: break-word; }`)
    const t = contentSec
    steps.push({ kind: 'set', t: 0, sel: '#brand-end', set: { autoAlpha: 0 } })
    steps.push({ kind: 'tween', t, sel: '#brand-end', from: { autoAlpha: 0 }, to: { autoAlpha: 1 }, dur: 0.3, ease: 'power1.out' })
    steps.push({ kind: 'tween', t: t + 0.12, sel: '#brand-end-logo', from: { autoAlpha: 0, scale: 0.9 }, to: { autoAlpha: 1, scale: 1 }, dur: 0.6, ease: 'power3.out' })
    steps.push({ kind: 'tween', t: t + 0.5, sel: '#brand-end-rule', from: { scaleX: 0 }, to: { scaleX: 1 }, dur: 0.45, ease: 'power2.out' })
    if (tagline) steps.push({ kind: 'tween', t: t + 0.65, sel: '#brand-end-tag', from: { autoAlpha: 0, y: px(14) }, to: { autoAlpha: 1, y: 0 }, dur: 0.45, ease: 'power2.out' })
  }

  if (!html.length) return null
  return { html: html.join('\n'), css: css.join('\n'), steps, tailSec }
}
