import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FilmDesign, SceneCraft, VideoSpec, CameraMove } from '@shared/spec'
import type { DesignContext } from './layout'
import { fitAttrs } from './layout'
import type { AnimStep } from './anim'
import { buildWidget, widgetCSS, type WidgetTheme } from './widgets'

/**
 * Directed scenes — the premium presentation path. A scene is
 *   background (dot-grid or a painted plate with a 2.5D depth camera)
 *   + HUD chrome + kinetic headline/deck + 0–2 widgets + word-lit caption,
 * all laid out from the platform's safe area so one craft serves every aspect.
 * Pure functions of (spec, craft, ctx): same inputs → identical markup.
 */

export interface PlateJob {
  sceneId: string
  file: string
  depthFile: string
  start: number
  dur: number
  camera: CameraMove
  /** zoom/parallax pivot in 0..1 image space (the located subject) */
  cx: number
  cy: number
  seed: number
}

export interface CraftedScene {
  html: string
  steps: AnimStep[]
  plate?: PlateJob
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const HEX = /^#[0-9a-f]{6}$/i

export interface CraftTheme extends WidgetTheme {
  bg: string
}

export function craftTheme(design: FilmDesign): CraftTheme {
  const doc = design.look === 'documentary'
  return {
    doc,
    bg: doc ? '#07090C' : '#090D18',
    ink: doc ? '#F2EEE6' : '#EEF1FA',
    mute: doc ? 'rgba(242,238,230,0.62)' : 'rgba(238,241,250,0.52)',
    hair: doc ? 'rgba(242,238,230,0.28)' : 'rgba(238,241,250,0.14)',
    accent: HEX.test(design.accent) ? design.accent : doc ? '#FF4A2E' : '#FFB547',
    accent2: HEX.test(design.accent2) ? design.accent2 : '#3EE6FF',
    display: doc ? "'Barlow Condensed', 'Inter', sans-serif" : "'Inter', sans-serif",
    mono: "'JetBrains Mono', monospace",
    serif: "'Instrument Serif', serif"
  }
}

/** the open fonts directed scenes use: vendored file name → npm package source */
export const CRAFT_FONTS: Array<{ family: string; file: string; pkg: string; weight: string; style: string }> = [
  { family: 'Inter', file: 'Inter-Var.woff2', pkg: '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2', weight: '100 900', style: 'normal' },
  { family: 'Barlow Condensed', file: 'BarlowCondensed-ExtraBold.woff2', pkg: '@fontsource/barlow-condensed/files/barlow-condensed-latin-800-normal.woff2', weight: '800', style: 'normal' },
  { family: 'Instrument Serif', file: 'InstrumentSerif-Italic.woff2', pkg: '@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2', weight: '400', style: 'italic' },
  { family: 'JetBrains Mono', file: 'JetBrainsMono-Medium.woff2', pkg: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', weight: '500', style: 'normal' },
  { family: 'JetBrains Mono', file: 'JetBrainsMono-Bold.woff2', pkg: '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff2', weight: '700', style: 'normal' }
]

/** font sources: vendored copy when present, else straight from node_modules */
export function craftFontAssets(fontsDir: string): Array<{ from: string; to: string }> {
  const nodeModules = resolve(fontsDir, '..', '..', 'node_modules')
  return CRAFT_FONTS.map((f) => {
    const vendored = resolve(fontsDir, f.file)
    return { from: existsSync(vendored) ? vendored : resolve(nodeModules, f.pkg), to: `assets/fonts/${f.file}` }
  })
}

export function craftFontCSS(): string {
  return CRAFT_FONTS.map(
    (f) => `@font-face { font-family: '${f.family}'; src: url('assets/fonts/${f.file}') format('woff2'); font-weight: ${f.weight}; font-style: ${f.style}; font-display: block; }`
  ).join('\n')
}

export function craftedCSS(ctx: DesignContext, th: CraftTheme): string {
  const s = ctx.scale
  const px = (n: number) => `${Math.round(n * s)}px`
  return `
    .scene.crafted { background: ${th.bg}; overflow: hidden; }
    .cr-grid { position: absolute; inset: -40px; background-image: radial-gradient(${th.doc ? 'rgba(242,238,230,0.07)' : 'rgba(238,241,250,0.13)'} ${px(1.6)}, transparent ${px(1.9)}); background-size: ${px(40)} ${px(40)}; }
    .cr-glow { position: absolute; left: 50%; top: 52%; width: ${Math.round(ctx.width * 1.3)}px; height: ${Math.round(ctx.width * 1.3)}px; transform: translate(-50%, -50%); background: radial-gradient(circle, ${th.accent2}2E 0%, ${th.accent}0F 35%, transparent 62%); }
    .cr-vig { position: absolute; inset: 0; background: radial-gradient(ellipse 75% 60% at 50% 50%, transparent 55%, rgba(3,5,10,0.85) 100%); }
    .cr-plate { position: absolute; left: 0; top: 0; width: ${ctx.width}px; height: ${ctx.height}px; }
    .cr-scrim-top { position: absolute; left: 0; right: 0; top: 0; height: ${Math.round(ctx.height * (ctx.isVertical ? 0.46 : 0.5))}px; background: linear-gradient(180deg, rgba(4,6,9,0.82) 0%, rgba(4,6,9,0.38) 62%, transparent 100%); }
    .cr-scrim-bot { position: absolute; left: 0; right: 0; bottom: 0; height: ${Math.round(ctx.height * 0.34)}px; background: linear-gradient(0deg, rgba(4,6,9,0.88) 0%, rgba(4,6,9,0.42) 60%, transparent 100%); }
    .cr-scrim-side { position: absolute; left: 0; top: 0; bottom: 0; width: ${Math.round(ctx.width * 0.58)}px; background: linear-gradient(90deg, rgba(4,6,9,0.84) 0%, rgba(4,6,9,0.45) 65%, transparent 100%); }
    .cr-frame { position: absolute; inset: ${px(36)}; border: 1.5px solid ${th.hair}; border-radius: ${px(28)}; pointer-events: none; }
    .cr-tick { position: absolute; width: ${px(34)}; height: ${px(34)}; border: 0 solid ${th.doc ? 'rgba(242,238,230,0.5)' : th.hair}; }
    .cr-tick.tl { left: ${px(40)}; top: ${px(40)}; border-left-width: 2px; border-top-width: 2px; }
    .cr-tick.tr { right: ${px(40)}; top: ${px(40)}; border-right-width: 2px; border-top-width: 2px; }
    .cr-tick.bl { left: ${px(40)}; bottom: ${px(40)}; border-left-width: 2px; border-bottom-width: 2px; }
    .cr-tick.br { right: ${px(40)}; bottom: ${px(40)}; border-right-width: 2px; border-bottom-width: 2px; }
    .cr-mono { font-family: ${th.mono}; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase; white-space: nowrap; }
    .cr-hud { position: absolute; height: ${px(52)}; }
    .cr-hud .l, .cr-hud .r { position: absolute; top: 0; font-size: ${px(22)}; color: ${th.mute}; overflow: hidden; text-overflow: ellipsis; max-width: 70%; }
    .cr-hud .l { left: 0; } .cr-hud .r { right: 0; color: ${th.ink}; }
    .cr-hud .l b { color: ${th.accent}; font-weight: 700; }
    .cr-hud .rule { position: absolute; left: 0; right: 0; top: ${px(46)}; height: 2px; background: ${th.hair}; transform-origin: left center; }
    .cr-hl { position: absolute; margin: 0; color: ${th.ink}; font-family: ${th.display}; text-shadow: 0 ${px(6)} ${px(40)} rgba(0,0,0,0.45); }
    .cr-hl.doc { font-weight: 800; text-transform: uppercase; line-height: 0.9; letter-spacing: -0.005em; text-align: left; }
    .cr-hl.info { font-weight: 700; line-height: 1.06; letter-spacing: -0.025em; text-align: center; }
    /* lines size to their content so the autofit pass measures real widths */
    .cr-hl .line { display: block; width: max-content; max-width: none; white-space: nowrap; }
    .cr-hl.center .line { margin-left: auto; margin-right: auto; }
    .cr-hl.doc .line { overflow: hidden; padding-bottom: 0.05em; }
    .cr-hl .w { display: inline-block; }
    .cr-hl.doc .acc { color: ${th.accent}; }
    .cr-hl.info .acc { font-family: ${th.serif}; font-style: italic; font-weight: 400; font-size: 1.16em; color: ${th.accent}; letter-spacing: -0.01em; }
    .cr-deck { position: absolute; margin: 0; font-family: ${th.serif}; font-style: italic; color: ${th.ink}; opacity: 0.88; line-height: 1.12; text-shadow: 0 2px 20px rgba(0,0,0,0.6); overflow-wrap: break-word; }
    .cr-chips { position: absolute; display: flex; gap: ${px(18)}; align-items: center; }
    .cr-chip { font-size: ${px(22)}; color: ${th.ink}; background: rgba(6,8,11,0.72); border: 1.5px solid ${th.hair}; padding: ${px(10)} ${px(16)}; border-radius: ${th.doc ? '0' : px(14)}; }
    .cr-chip.hot { border-color: ${th.accent}; }
    .cr-cap { position: absolute; margin: 0; font-family: 'Inter', sans-serif; font-weight: 650; line-height: 1.25; letter-spacing: -0.01em; color: ${th.ink}; overflow-wrap: break-word; text-shadow: 0 2px 18px rgba(0,0,0,0.55); }
    .cr-cap .cw { opacity: 0.28; }
    .cr-cap .cw.key { color: ${th.accent}; }
    .cr-over { position: absolute; left: 0; top: 0; overflow: visible; }
    .cr-wbox.on-plate::before { content: ''; position: absolute; inset: -36px -44px; border-radius: ${th.doc ? '4px' : '24px'}; background: rgba(5,7,10,0.84); border: 1.5px solid ${th.hair}; }
    .cr-anno { position: absolute; font-size: ${px(22)}; color: ${th.ink}; background: rgba(6,8,11,0.74); border: 1.5px solid ${th.accent}; padding: ${px(10)} ${px(16)}; white-space: nowrap; }
    .cr-anno b { color: ${th.accent}; }
    .grain-layer { position: absolute; inset: 0; z-index: 60; pointer-events: none; opacity: ${th.doc ? 0.07 : 0.06}; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='256' height='256'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='7' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1.4 -0.2'/%3E%3C/filter%3E%3Crect width='256' height='256' filter='url(%23n)'/%3E%3C/svg%3E"); background-size: 256px 256px; }
    ${widgetCSS(th)}`
}

// ---------------------------------------------------------------- layout

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Regions {
  hud: Box
  headline: Box
  deck: Box
  mid: Box
  low: Box
  chips: Box
  caption: Box
  /** text column alignment */
  align: 'left' | 'center'
}

function regions(ctx: DesignContext, th: CraftTheme): Regions {
  const { scale: s } = ctx
  // directed scenes use the frame more fully than template scenes: platform
  // insets are capped (TikTok's 480px bottom reserve covers the description,
  // not the visual), side rails stay respected
  const top = Math.min(ctx.safe.y, Math.round(ctx.height * 0.1))
  const bottom = Math.min(ctx.height - ctx.safe.y - ctx.safe.h, Math.round(ctx.height * 0.16))
  const safe = { x: ctx.safe.x, y: top, w: ctx.safe.w, h: ctx.height - top - bottom }
  const hudY = Math.max(Math.round(48 * s), safe.y - Math.round(86 * s))
  const hud = { x: Math.max(safe.x, Math.round(72 * s)), y: hudY, w: 0, h: Math.round(52 * s) }
  hud.w = ctx.width - hud.x * 2
  const landscape = ctx.width > ctx.height * 1.15
  const f = (a: number, b: number): [number, number] => [safe.y + safe.h * a, safe.h * (b - a)]
  if (landscape) {
    const colW = safe.w * 0.46
    const [hy, hh] = f(0.08, 0.44)
    const [dy, dh] = f(0.45, 0.58)
    const [cy, ch] = f(0.62, 0.7)
    const [ky, kh] = f(0.76, 0.98)
    const rx = safe.x + safe.w * 0.52
    return {
      hud,
      headline: { x: safe.x, y: hy, w: colW, h: hh },
      deck: { x: safe.x, y: dy, w: colW, h: dh },
      chips: { x: safe.x, y: cy, w: colW, h: ch },
      caption: { x: safe.x, y: ky, w: colW, h: kh },
      mid: { x: rx, y: safe.y + safe.h * 0.04, w: safe.w * 0.48, h: safe.h * 0.62 },
      low: { x: rx, y: safe.y + safe.h * 0.7, w: safe.w * 0.48, h: safe.h * 0.28 },
      align: 'left'
    }
  }
  const [hy, hh] = f(0.02, th.doc ? 0.27 : 0.2)
  const [dy, dh] = f(th.doc ? 0.28 : 0.21, th.doc ? 0.34 : 0.26)
  const [my, mh] = f(th.doc ? 0.37 : 0.28, 0.69)
  const [ly, lh] = f(0.7, 0.835)
  const [cy, ch] = f(0.845, 0.89)
  const [ky, kh] = f(0.9, 1.0)
  return {
    hud,
    headline: { x: safe.x, y: hy, w: safe.w, h: hh },
    deck: { x: safe.x, y: dy, w: safe.w * 0.92, h: dh },
    mid: { x: safe.x, y: my, w: safe.w, h: mh },
    low: { x: safe.x, y: ly, w: safe.w, h: lh },
    chips: { x: safe.x, y: cy, w: safe.w, h: ch },
    caption: { x: safe.x, y: ky, w: safe.w, h: kh },
    align: th.doc ? 'left' : 'center'
  }
}

const boxStyle = (b: Box): string =>
  `left:${Math.round(b.x)}px;top:${Math.round(b.y)}px;width:${Math.round(b.w)}px;height:${Math.round(b.h)}px`

// ---------------------------------------------------------------- scene

/**
 * Balanced line breaks: fewest lines that fit the estimated width, then the
 * split that minimises the longest line (DP over word boundaries). The page's
 * autofit pass still scales the result, so this only shapes the rag.
 */
export function balancedLines(text: string, maxLines: number, widthPx: number, charPx: number): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= 1) return words
  const perLine = Math.max(6, Math.floor(widthPx / charPx))
  const len = (i: number, j: number) => words.slice(i, j).join(' ').length
  const n = Math.min(maxLines, words.length, Math.max(1, Math.ceil(text.length / perLine)))
  // best[k][i] = minimal max-line-length splitting words[i..] into k lines
  const memo = new Map<string, { cost: number; cut: number }>()
  const solve = (k: number, i: number): { cost: number; cut: number } => {
    const key = `${k}:${i}`
    const hit = memo.get(key)
    if (hit) return hit
    let res = { cost: Infinity, cut: words.length }
    if (k === 1) res = { cost: len(i, words.length), cut: words.length }
    else
      for (let j = i + 1; j <= words.length - (k - 1); j++) {
        const c = Math.max(len(i, j), solve(k - 1, j).cost)
        if (c < res.cost) res = { cost: c, cut: j }
      }
    memo.set(key, res)
    return res
  }
  const out: string[] = []
  let i = 0
  for (let k = n; k >= 1; k--) {
    const { cut } = solve(k, i)
    out.push(words.slice(i, cut).join(' '))
    i = cut
  }
  return out
}

function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

export function renderCraftedScene(
  spec: VideoSpec,
  craft: SceneCraft,
  index: number,
  startSec: number,
  endSec: number,
  ctx: DesignContext,
  th: CraftTheme
): CraftedScene {
  const id = `scene-${index + 1}`
  const dur = endSec - startSec
  const s = ctx.scale
  const R = regions(ctx, th)
  const steps: AnimStep[] = []
  const parts: string[] = []
  const design = spec.design as FilmDesign

  // ---------- background ----------
  const plate = craft.background === 'plate' && craft.plate?.file && craft.plate.depthFile ? craft.plate : undefined
  let plateJob: PlateJob | undefined
  if (plate) {
    const anchor = plate.anchor ?? { x: plate.subject === 'left' ? 0.3 : plate.subject === 'right' ? 0.7 : 0.5, y: 0.6 }
    parts.push(`<canvas class="cr-plate" id="${id}-plate" width="${ctx.width}" height="${ctx.height}"></canvas>`)
    parts.push(R.align === 'left' && ctx.width > ctx.height * 1.15 ? `<div class="cr-scrim-side"></div>` : `<div class="cr-scrim-top"></div>`)
    parts.push(`<div class="cr-scrim-bot"></div>`)
    plateJob = {
      sceneId: id,
      file: plate.file as string,
      depthFile: plate.depthFile as string,
      start: startSec,
      dur,
      camera: plate.camera,
      cx: anchor.x,
      cy: anchor.y,
      seed: index + 1
    }
  } else {
    parts.push(`<div class="cr-grid" id="${id}-grid"></div><div class="cr-glow" id="${id}-glow"></div><div class="cr-vig"></div>`)
    // backgrounds stay still: a drifting full-frame gradient is a full repaint
    // every frame under software raster (~25% of render time) — the widgets move
    steps.push({ kind: 'tween', t: startSec, sel: `#${id}-glow`, from: { autoAlpha: 0 }, to: { autoAlpha: 1 }, dur: 0.8, ease: 'power1.out' })
  }

  // ---------- chrome ----------
  if (th.doc) {
    parts.push(`<div class="cr-tick tl"></div><div class="cr-tick tr"></div><div class="cr-tick bl"></div><div class="cr-tick br"></div>`)
  } else {
    parts.push(`<div class="cr-frame" id="${id}-frame"></div>`)
  }
  const hudLeft = craft.hud.left || design.series
  const hudRight = craft.hud.right || `Fig. ${index + 1}`
  const leftHTML = esc(hudLeft).replace(/\s·\s/, ' <b>·</b> ')
  parts.push(
    `<div class="cr-hud cr-mono" id="${id}-hud" style="left:${R.hud.x}px;top:${R.hud.y}px;width:${R.hud.w}px"><span class="l">${leftHTML}</span><span class="r">${esc(hudRight)}</span><i class="rule" id="${id}-rule"></i></div>`
  )
  steps.push(
    { kind: 'tween', t: startSec + 0.05, sel: `#${id}-rule`, from: { scaleX: 0 }, to: { scaleX: 1 }, dur: 0.8, ease: 'power3.inOut' },
    { kind: 'tween', t: startSec + 0.15, sel: `#${id}-hud .l`, from: { autoAlpha: 0, y: 10 * s }, to: { autoAlpha: 1, y: 0 }, dur: 0.45, ease: 'power2.out' },
    { kind: 'tween', t: startSec + 0.25, sel: `#${id}-hud .r`, from: { autoAlpha: 0, y: 10 * s }, to: { autoAlpha: 1, y: 0 }, dur: 0.45, ease: 'power2.out' }
  )

  // ---------- headline ----------
  // hero mode: no widget on a grid scene → the headline owns the centre of the frame
  const hero = !plate && craft.widgets.every((w) => w.type === 'annotation')
  if (hero) {
    R.headline = { x: R.mid.x, y: R.mid.y + R.mid.h * 0.08, w: R.mid.w, h: R.mid.h * 0.62 }
    R.deck = { x: R.mid.x + R.mid.w * 0.04, y: R.mid.y + R.mid.h * 0.74, w: R.mid.w * 0.92, h: R.mid.h * 0.22 }
    R.align = 'center'
    const d = Math.round(Math.min(ctx.width, ctx.height) * 0.78)
    const cx = Math.round(R.mid.x + R.mid.w / 2)
    const cy = Math.round(R.mid.y + R.mid.h * 0.42)
    parts.push(`<svg class="cr-over" width="${ctx.width}" height="${ctx.height}" viewBox="0 0 ${ctx.width} ${ctx.height}" aria-hidden="true">
      <circle id="${id}-orb1" cx="${cx}" cy="${cy}" r="${Math.round(d / 2)}" fill="none" stroke="${th.accent2}" stroke-width="${(2.5 * s).toFixed(1)}" opacity="0.22" />
      <circle id="${id}-orb2" cx="${cx}" cy="${cy}" r="${Math.round(d * 0.62)}" fill="none" stroke="${th.accent}" stroke-width="${(2 * s).toFixed(1)}" stroke-dasharray="${(6 * s).toFixed(1)} ${(14 * s).toFixed(1)}" opacity="0.3" />
    </svg>`)
    steps.push(
      { kind: 'tween', t: startSec, sel: `#${id}-orb1`, from: { scale: 0.86, autoAlpha: 0, svgOrigin: `${cx} ${cy}` }, to: { scale: 1, autoAlpha: 0.22, svgOrigin: `${cx} ${cy}` }, dur: 1.0, ease: 'expo.out' },
      { kind: 'tween', t: startSec, sel: `#${id}-orb2`, from: { rotation: 0, autoAlpha: 0, svgOrigin: `${cx} ${cy}` }, to: { rotation: 40, autoAlpha: 0.3, svgOrigin: `${cx} ${cy}` }, dur, ease: 'none' }
    )
  }
  const accent = new Set(craft.accentWord.split(/\s+/).map(norm).filter(Boolean))
  const fs = Math.round((th.doc ? 156 : 78) * s * (ctx.width > ctx.height * 1.15 ? 0.9 : 1) * (hero ? (th.doc ? 1.1 : 1.45) : 1))
  const lines = balancedLines(craft.headline, 3, R.headline.w, fs * (th.doc ? 0.46 : 0.52))
  const lineHTML = lines
    .map((l) => {
      const ws = l.split(/\s+/).map((w) => {
        const isAcc = accent.has(norm(w))
        return th.doc || !isAcc ? `<span class="w${isAcc ? ' acc' : ''}">${esc(w)}</span>` : `<span class="w"><em class="acc">${esc(w)}</em></span>`
      })
      return `<span class="line">${ws.join(' ')}</span>`
    })
    .join('')
  parts.push(
    `<h1 class="cr-hl ${th.doc ? 'doc' : 'info'}${R.align === 'center' ? ' center' : ''}" id="${id}-hl" style="left:${Math.round(R.headline.x)}px;top:${Math.round(R.headline.y)}px;width:${Math.round(R.headline.w)}px;font-size:${fs}px;${R.align === 'center' ? 'text-align:center' : 'text-align:left'}" ${fitAttrs(R.headline.w, R.headline.h, 'lines')}>${lineHTML}</h1>`
  )
  steps.push(
    th.doc
      ? { kind: 'tween', t: startSec + 0.3, sel: `#${id}-hl .w`, from: { yPercent: 110 }, to: { yPercent: 0 }, dur: 0.75, ease: 'power4.out', stagger: 0.08 }
      : { kind: 'tween', t: startSec + 0.3, sel: `#${id}-hl .w`, from: { autoAlpha: 0, y: 34 * s, filter: 'blur(10px)' }, to: { autoAlpha: 1, y: 0, filter: 'blur(0px)' }, dur: 0.6, ease: 'power3.out', stagger: 0.08 }
  )

  if (craft.deck) {
    const dfs = Math.round(52 * s)
    parts.push(
      `<p class="cr-deck" id="${id}-deck" style="${boxStyle({ ...R.deck, h: R.deck.h })};font-size:${dfs}px;${R.align === 'center' ? 'text-align:center;margin-left:4%' : ''}" ${fitAttrs(R.deck.w, R.deck.h, 'box')}>${esc(craft.deck)}</p>`
    )
    steps.push({ kind: 'tween', t: startSec + 1.1, sel: `#${id}-deck`, from: { autoAlpha: 0, y: 18 * s }, to: { autoAlpha: 0.88, y: 0 }, dur: 0.7, ease: 'power2.out' })
  }

  // ---------- widgets ----------
  const t0 = startSec + 0.9
  const avail = Math.max(1.2, dur - 1.4)
  const built = craft.widgets
    .map((w, k) => ({ w, b: buildWidget(w, `${id}-w${k}`, th, t0 + k * 0.5, avail - k * 0.5), k }))
    .filter((x) => x.b !== null) as Array<{ w: SceneCraft['widgets'][number]; b: NonNullable<ReturnType<typeof buildWidget>>; k: number }>
  // placement: plates keep the middle for the picture → widgets go low; on grids
  // a lone widget owns mid+low, two widgets split mid (large) / low (compact)
  const placed: Array<{ b: (typeof built)[number]['b']; box: Box; wid: string }> = []
  if (plate && plateJob) {
    // a subject sitting in the low band keeps its annotation clear: the widget
    // takes the half of the band away from it
    const ax = plateJob.cx * ctx.width
    const ay = plateJob.cy * ctx.height
    const pad = 110 * s
    const clash = ay > R.low.y - pad && ay < R.low.y + R.low.h + pad
    const box = clash
      ? { ...R.low, w: R.low.w * 0.5, x: ax < R.low.x + R.low.w / 2 ? R.low.x + R.low.w * 0.5 : R.low.x }
      : R.low
    built.slice(0, 1).forEach((x) => placed.push({ b: x.b, box, wid: `${id}-w${x.k}` }))
  } else if (built.length === 1) {
    const only = built[0]
    const box = only.b.compact ? R.mid : { ...R.mid, h: R.low.y + R.low.h - R.mid.y }
    placed.push({ b: only.b, box, wid: `${id}-w${only.k}` })
  } else if (built.length >= 2) {
    const sorted = [...built].sort((a, b) => Number(a.b.compact) - Number(b.b.compact))
    placed.push({ b: sorted[0].b, box: R.mid, wid: `${id}-w${sorted[0].k}` })
    placed.push({ b: sorted[1].b, box: R.low, wid: `${id}-w${sorted[1].k}` })
  }
  for (const p of placed) {
    // headroom for legends drawn above the design box
    const pad = Math.round(16 * s)
    const avW = p.box.w - pad * 2
    const avH = p.box.h - pad * 2
    const u = Math.min(avW / p.b.dw, avH / p.b.dh, 1.25 * s)
    const left = p.box.x + pad + (avW - p.b.dw * u) / 2
    const top = p.box.y + pad + (avH - p.b.dh * u) / 2
    parts.push(
      `<div class="cr-wbox${plate ? ' on-plate' : ''}" id="${p.wid}" style="left:${Math.round(left)}px;top:${Math.round(top)}px;width:${p.b.dw}px;height:${p.b.dh}px;transform:scale(${u.toFixed(4)})">${p.b.html}</div>`
    )
    steps.push(...p.b.steps)
  }

  // ---------- annotation on the plate ----------
  const anno = craft.widgets.find((w) => w.type === 'annotation')
  if (plate && plateJob && anno && anno.type === 'annotation') {
    const ax = plateJob.cx * ctx.width
    const ay = plateJob.cy * ctx.height
    const r = 74 * s
    const C = 2 * Math.PI * r
    const right = ax < ctx.width * 0.55
    const lx = right ? ax + 90 * s : ax - 90 * s
    const ly = ay - 150 * s
    parts.push(`<svg class="cr-over" width="${ctx.width}" height="${ctx.height}" viewBox="0 0 ${ctx.width} ${ctx.height}">
      <defs><filter id="${id}-ag" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <g id="${id}-pg1" style="visibility:hidden"><circle id="${id}-pulse1" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${th.accent}" stroke-width="2.5" opacity="0" /></g>
      <g id="${id}-pg2" style="visibility:hidden"><circle id="${id}-pulse2" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${th.accent}" stroke-width="2.5" opacity="0" /></g>
      <circle id="${id}-ring" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${th.accent}" stroke-width="${(4 * s).toFixed(1)}" filter="url(#${id}-ag)" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}" transform="rotate(-90 ${ax.toFixed(1)} ${ay.toFixed(1)})" />
      <circle id="${id}-dot" cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="${(7 * s).toFixed(1)}" fill="${th.accent}" filter="url(#${id}-ag)" />
      <polyline id="${id}-lead" points="${(ax + (right ? 0.7 : -0.7) * r).toFixed(1)},${(ay - 0.7 * r).toFixed(1)} ${lx.toFixed(1)},${(ly + 26 * s).toFixed(1)}" fill="none" stroke="${th.accent}" stroke-width="${(2.5 * s).toFixed(1)}" stroke-dasharray="400" stroke-dashoffset="400" />
    </svg>`)
    const chipPos = right ? `left:${Math.round(lx)}px` : `right:${Math.round(ctx.width - lx)}px`
    parts.push(`<div class="cr-anno cr-mono" id="${id}-anno" style="${chipPos};top:${Math.round(ly)}px"><b>●</b> ${esc(anno.label)}</div>`)
    const ta = startSec + Math.min(1.6, dur * 0.3)
    steps.push(
      { kind: 'tween', t: ta, sel: `#${id}-ring`, from: { strokeDashoffset: C }, to: { strokeDashoffset: 0 }, dur: 0.8, ease: 'power2.inOut' },
      { kind: 'tween', t: ta, sel: `#${id}-dot`, from: { scale: 0, svgOrigin: `${ax.toFixed(1)} ${ay.toFixed(1)}` }, to: { scale: 1, svgOrigin: `${ax.toFixed(1)} ${ay.toFixed(1)}` }, dur: 0.4, ease: 'back.out(3)' },
      { kind: 'tween', t: ta + 0.5, sel: `#${id}-lead`, from: { strokeDashoffset: 400 }, to: { strokeDashoffset: 0 }, dur: 0.45, ease: 'power2.out' },
      { kind: 'tween', t: ta + 0.8, sel: `#${id}-anno`, from: { autoAlpha: 0, x: (right ? -14 : 14) * s }, to: { autoAlpha: 1, x: 0 }, dur: 0.45, ease: 'power2.out' }
    )
    ;[1, 2].forEach((k) => {
      const tp = ta + 0.9 + (k - 1) * 0.9
      if (tp + 0.5 < endSec)
        steps.push(
          { kind: 'set', t: tp, sel: `#${id}-pg${k}`, set: { visibility: 'visible' } },
          { kind: 'tween', t: tp, sel: `#${id}-pulse${k}`, from: { attr: { r: r }, opacity: 0.85 }, to: { attr: { r: r * 3.6 }, opacity: 0, immediateRender: false }, dur: Math.min(2.4, endSec - tp), ease: 'power1.out' }
        )
    })
  }

  // ---------- chips ----------
  if (craft.hud.chips.length) {
    const justify = R.align === 'center' ? 'center' : 'flex-start'
    parts.push(
      `<div class="cr-chips cr-mono" id="${id}-chips" style="${boxStyle(R.chips)};justify-content:${justify}">${craft.hud.chips
        .map((c, k) => `<span class="cr-chip${k === craft.hud.chips.length - 1 && craft.hud.chips.length > 1 ? ' hot' : ''}">${esc(c)}</span>`)
        .join('')}</div>`
    )
    steps.push({ kind: 'tween', t: startSec + 0.8, sel: `#${id}-chips .cr-chip`, from: { autoAlpha: 0, y: 14 * s }, to: { autoAlpha: 1, y: 0 }, dur: 0.45, ease: 'power2.out', stagger: 0.14 })
  }

  // ---------- kinetic caption ----------
  if (craft.caption) {
    const key = norm(craft.keyWord)
    const words = craft.caption.split(/\s+/).filter(Boolean)
    const cfs = Math.round(40 * s)
    parts.push(
      `<p class="cr-cap" id="${id}-cap" style="${boxStyle(R.caption)};font-size:${cfs}px;text-align:${R.align}" ${fitAttrs(R.caption.w, R.caption.h, 'box')}>${words
        .map((w, k) => `<span class="cw${key && norm(w) === key ? ' key' : ''}" id="${id}-c${k}">${esc(w)}</span>`)
        .join(' ')}</p>`
    )
    const a = startSec + 0.5
    const b = Math.max(a + 0.4, endSec - 0.5)
    words.forEach((_, k) => {
      steps.push({ kind: 'tween', t: a + ((b - a) * k) / words.length, sel: `#${id}-c${k}`, from: { opacity: 0.28 }, to: { opacity: 1 }, dur: 0.14, ease: 'power1.out' })
    })
  }

  const html = `<section class="scene crafted" id="${id}" data-kind="crafted">${parts.join('\n')}</section>`
  return { html, steps, plate: plateJob }
}

// ---------------------------------------------------------------- plate engine (in-page)

/**
 * One shared WebGL context renders every plate: depth-displaced camera move
 * (iterative parallax over the depth map, dolly term for real perspective),
 * film grade, vignette and frame-seeded grain — then blits into the scene's
 * own 2D canvas and draws seeded drifting dust. Seek-driven only; images are
 * awaited via window.__vgWait before the timeline registers (no blank frames).
 */
export function plateEngineScript(plates: PlateJob[], width: number, height: number, accent: string): string {
  if (plates.length === 0) return ''
  const CAMS: Record<CameraMove, { z0: number; z1: number; sx: number; sy: number; dolly: number }> = {
    push: { z0: 1.07, z1: 1.15, sx: 0.03, sy: 0.008, dolly: 0.09 },
    pull: { z0: 1.15, z1: 1.07, sx: -0.03, sy: -0.008, dolly: -0.06 },
    truckLeft: { z0: 1.1, z1: 1.11, sx: -0.05, sy: 0, dolly: 0.02 },
    truckRight: { z0: 1.1, z1: 1.11, sx: 0.05, sy: 0, dolly: 0.02 },
    craneUp: { z0: 1.1, z1: 1.12, sx: 0, sy: -0.045, dolly: 0.03 },
    drift: { z0: 1.08, z1: 1.11, sx: 0.02, sy: 0.012, dolly: 0.04 }
  }
  const jobs = plates.map((p) => ({ ...p, cam: CAMS[p.camera] ?? CAMS.push }))
  return `<script>
(function () {
  var W = ${width}, H = ${height}, ACCENT = ${JSON.stringify(accent)};
  var JOBS = ${JSON.stringify(jobs)};
  window.__vgWait = window.__vgWait || [];
  var glc = document.createElement('canvas'); glc.width = W; glc.height = H;
  var gl = glc.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false });
  if (!gl) return;
  var VS = 'attribute vec2 p; varying vec2 v; void main(){ v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
  var FS = [
    'precision highp float;',
    'varying vec2 v;',
    'uniform sampler2D img, dep;',
    'uniform float t, zoom, dolly, time; uniform vec2 c, shift, res;',
    'float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }',
    'void main(){',
    '  vec2 uv = vec2(v.x, 1.0 - v.y);',
    '  vec2 base = c + (uv - c) / zoom;',
    '  float focus = texture2D(dep, c).r;',
    '  vec2 q = base;',
    '  for (int i = 0; i < 5; i++) {',
    '    float d = texture2D(dep, q).r;',
    '    q = base + shift * t * (d - focus) - (base - c) * (d - focus) * dolly * t;',
    '  }',
    '  q = clamp(q, 0.001, 0.999);',
    '  vec3 col = texture2D(img, q).rgb;',
    '  float l = dot(col, vec3(0.299, 0.587, 0.114));',
    '  col = mix(col, col * vec3(0.90, 1.0, 1.08), smoothstep(0.55, 0.0, l) * 0.5);',
    '  col = mix(vec3(l), col, 0.93);',
    '  vec2 vv = (v - 0.5) * vec2(0.95, 0.75);',
    '  col *= 1.0 - dot(vv, vv) * 1.2;',
    '  col += (h(floor(v * res) + floor(time * 24.0) * vec2(1.7, 3.1)) - 0.5) * 0.045;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\\n');
  function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; }
  var prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog); gl.useProgram(prog);
  var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  var loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'img'), 0);
  gl.uniform1i(gl.getUniformLocation(prog, 'dep'), 1);
  gl.uniform2f(gl.getUniformLocation(prog, 'res'), W, H);
  var U = {}; ['t', 'zoom', 'dolly', 'time', 'c', 'shift'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
  function texOf(im) {
    var tx = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tx;
  }
  function load(src) {
    return new Promise(function (res) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { res(null); }; i.src = src; });
  }
  function rng(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; var t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  JOBS.forEach(function (j) {
    var R = rng(j.seed * 7919 + 13); j.dust = [];
    for (var i = 0; i < 160; i++) j.dust.push({ x: R() * W, y: R() * H, z: 0.3 + R() * 0.7, ph: R() * 6.28, hot: R() < 0.07 });
  });
  var ready = Promise.all(JOBS.map(function (j) {
    return Promise.all([load(j.file), load(j.depthFile)]).then(function (r) {
      j.canvas = document.getElementById(j.sceneId + '-plate');
      if (r[0] && r[1] && j.canvas) { j.tImg = texOf(r[0]); j.tDep = texOf(r[1]); j.ctx = j.canvas.getContext('2d'); }
    });
  }));
  window.__vgWait.push(ready);
  function ease(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }
  function draw(j, time) {
    var p = Math.min(Math.max((time - j.start) / j.dur, 0), 1);
    var e = ease(p) * 0.85 + p * 0.15;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, j.tImg);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, j.tDep);
    gl.uniform1f(U.t, e);
    gl.uniform1f(U.zoom, j.cam.z0 + (j.cam.z1 - j.cam.z0) * e);
    gl.uniform1f(U.dolly, j.cam.dolly);
    gl.uniform1f(U.time, time);
    gl.uniform2f(U.c, j.cx, j.cy);
    gl.uniform2f(U.shift, j.cam.sx, j.cam.sy);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    var c = j.ctx; c.drawImage(glc, 0, 0);
    var lt = time - j.start, k = W / 1080;
    for (var i = 0; i < j.dust.length; i++) {
      var f = j.dust[i];
      var y = (f.y + lt * 60 * f.z * k) % (H + 60) - 30;
      var x = (f.x - lt * 30 * f.z * k + Math.sin(lt * 0.9 + f.ph) * 14 * k + W) % W;
      var r = (1.1 + f.z * 2.4) * k;
      c.globalAlpha = f.hot ? 0.8 : 0.14 + f.z * 0.3;
      c.fillStyle = f.hot ? ACCENT : '#d9d4cc';
      c.beginPath(); c.ellipse(x, y, r, r * 0.7, f.ph, 0, 6.283); c.fill();
    }
    c.globalAlpha = 1;
  }
  function seek(time) {
    for (var i = 0; i < JOBS.length; i++) {
      var j = JOBS[i];
      if (!j.ctx) continue;
      if (time < j.start - 0.8 || time > j.start + j.dur + 0.8) continue;
      draw(j, time);
    }
  }
  window.addEventListener('hf-seek', function (e) { seek(e.detail.time); });
  ready.then(function () { seek(0); });
})();
</script>`
}
