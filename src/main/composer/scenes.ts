import type { DesignContext } from './layout'
import { fitLines, fitAttrs, dedupeFields, typeScale } from './layout'
import type { AnimStep } from './anim'
import type { StyleKit } from './kits'
import { EASE, exitFade, popStagger, riseIn, slamIn } from './anim'
import type { Scene } from '@shared/spec'
import { buildThreeShowcase, buildThreeParticles } from './three'

/**
 * Scene renderers — one per VideoSpec scene kind. Each returns the scene's
 * HTML layer plus declarative animation steps. Pure functions of their inputs
 * (same spec → same composition → same MP4).
 */

export interface RenderedScene {
  html: string
  steps: AnimStep[]
  /** the scene's hero element (headline/logo) — compose() pins it visible at frame 0 */
  primarySel?: string
  /** module script (three.js) that registers an hf-seek listener */
  threeScript?: string
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function sceneShell(id: string, kind: string, inner: string): string {
  return `<section class="scene" id="${id}" data-kind="${kind}"><div class="safe">${inner}</div></section>`
}

/** full-bleed layer (canvas / media) + separately wrapped safe-area text */
function sceneShellFullBleed(
  id: string,
  kind: string,
  bleed: string,
  safeInner: string,
  layout?: 'overlay-top' | 'overlay-bottom'
): string {
  return `<section class="scene" id="${id}" data-kind="${kind}"><div class="bleed">${bleed}</div><div class="safe${layout ? ' ' + layout : ''}">${safeInner}</div></section>`
}

/** the longest word becomes the sticker highlight (deterministic pick) */
function highlightWord(text: string): { pre: string; word: string; post: string } | null {
  const words = text.split(/\s+/)
  let best = -1
  let bestLen = 3
  words.forEach((w, i) => {
    const clean = w.replace(/[^\w]/g, '')
    if (clean.length > bestLen) {
      bestLen = clean.length
      best = i
    }
  })
  if (best < 0) return null
  const w = words[best]
  const m = w.match(/^(\W*)(\w.*\w|\w+)(\W*)$/)
  if (!m) return null
  return {
    pre: [...words.slice(0, best), m[1]].filter(Boolean).join(' '),
    word: m[2],
    post: [m[3], ...words.slice(best + 1)].filter(Boolean).join(' ')
  }
}

function headlineHTML(
  id: string,
  lines: string[],
  hl: { pre: string; word: string; post: string } | null,
  fs: number,
  cls: string,
  fit?: string
): string {
  const lineSpans = lines.map((l) => {
    if (hl && l.includes(hl.word)) {
      const marked = l.replace(hl.word, `<span class="hl" id="${id}-hlspan">${esc(hl.word)}</span>`)
      return `<span class="line">${marked}</span>`
    }
    return `<span class="line">${esc(l)}</span>`
  })
  return `<h2 class="${cls}" id="${id}" style="font-size:${fs}px"${fit ? ` ${fit}` : ''}>${lineSpans.join('')}</h2>`
}

/** decorative corner brackets — the "produced frame" signature on hero scenes */
const CORNERS = `<div class="corners" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`

export function renderScene(
  scene: Scene,
  index: number,
  startSec: number,
  endSec: number,
  ctx: DesignContext,
  kit: StyleKit
): RenderedScene {
  const id = `scene-${index + 1}`
  const sel = `#${id}`
  const ts = typeScale(ctx)
  const dur = endSec - startSec

  const steps: AnimStep[] = []
  let html = ''
  let threeScript: string | undefined

  let primaryTarget = ''
  const enter = (primarySel: string): AnimStep[] => {
    primaryTarget = primarySel
    // scene 1's hero is the social thumbnail: fully visible at frame 0, no entrance
    if (index === 0) {
      return [{ kind: 'set', t: 0, sel: primarySel, set: kit.enterFinal() }]
    }
    return kit.enter(primarySel, startSec + 0.05, ctx)
  }

  switch (scene.kind) {
    case 'title': {
      const clean = dedupeFields({ headline: scene.headline, kicker: scene.kicker, subline: scene.subline })
      const lines = fitLines(scene.headline, 3, ctx.safe.w * 0.94, ts.display)
      const fs = Math.round(Math.min(ts.display, (ctx.safe.w * 0.94) / (Math.max(...lines.map((l) => l.length)) * 0.56)))
      const hl = highlightWord(scene.headline)
      const inner = `
        ${clean.kicker ? `<div class="kicker" id="${id}-kicker">${esc(clean.kicker)}</div>` : ''}
        ${headlineHTML(`${id}-hl`, lines, hl, fs, 'display', fitAttrs(ctx.safe.w * 0.94, ctx.safe.h * 0.46, 'lines'))}
        ${clean.subline ? `<p class="subline" id="${id}-sub" ${fitAttrs(ctx.safe.w * 0.86, ctx.safe.h * 0.16, 'box')}>${esc(clean.subline)}</p>` : ''}
        <div class="underline" id="${id}-bar"></div>
        ${CORNERS}`
      html = sceneShell(id, scene.kind, inner)
      steps.push(...enter(`#${id}-hl`))
      if (clean.kicker) {
        steps.push({
          kind: 'tween',
          t: startSec,
          sel: `#${id}-kicker`,
          from: { autoAlpha: 0, y: -24 * ctx.scale },
          to: { autoAlpha: 1, y: 0 },
          dur: 0.4,
          ease: EASE.rise
        })
      }
      steps.push({
        kind: 'tween',
        t: startSec + 0.35,
        sel: `#${id}-bar`,
        from: { scaleX: 0, autoAlpha: 1 },
        to: { scaleX: 1 },
        dur: 0.5,
        ease: EASE.wipe
      })
      steps.push({
        kind: 'tween',
        t: startSec + 0.2,
        sel: `#${id} .corners`,
        from: { autoAlpha: 0, scale: 1.12 },
        to: { autoAlpha: 1, scale: 1 },
        dur: 0.6,
        ease: EASE.glide
      })
      if (clean.subline) {
        steps.push(riseIn(`#${id}-sub`, startSec + 0.5, ctx))
      }
      break
    }

    case 'statement': {
      const clean = dedupeFields({ headline: scene.headline, subline: scene.subline })
      const lines = fitLines(scene.headline, 3, ctx.safe.w * 0.92, ts.headline)
      const fs = Math.round(Math.min(ts.headline, (ctx.safe.w * 0.92) / (Math.max(...lines.map((l) => l.length)) * 0.56)))
      const hl = highlightWord(scene.headline)
      const inner = `
        <div class="mark" id="${id}-mark">“</div>
        ${headlineHTML(`${id}-hl`, lines, hl, fs, 'headline', fitAttrs(ctx.safe.w * 0.92, ctx.safe.h * 0.4, 'lines'))}
        ${clean.subline ? `<p class="subline" id="${id}-sub" ${fitAttrs(ctx.safe.w * 0.84, ctx.safe.h * 0.15, 'box')}>${esc(clean.subline)}</p>` : ''}`
      html = sceneShell(id, scene.kind, inner)
      steps.push(...enter(`#${id}-hl`))
      steps.push({
        kind: 'tween',
        t: startSec,
        sel: `#${id}-mark`,
        from: { autoAlpha: 0, scale: 2.2 },
        to: { autoAlpha: 1, scale: 1 },
        dur: 0.5,
        ease: EASE.pop
      })
      if (clean.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.45, ctx))
      break
    }

    case 'bullets': {
      const clean = dedupeFields({ headline: scene.headline })
      const items = scene.bullets
        .map(
          (b, i) =>
            `<li id="${id}-b${i}"><span class="idx">${String(i + 1).padStart(2, '0')}</span><span class="bl" ${fitAttrs(ctx.safe.w * 0.62, ctx.safe.h * 0.1, 'box')}>${esc(b)}</span></li>`
        )
        .join('\n')
      const inner = `
        <h3 class="headline sm" id="${id}-hl" ${fitAttrs(ctx.safe.w * 0.92, ctx.safe.h * 0.16, 'lines')}>${esc(clean.headline)}</h3>
        <ul class="bullets" ${fitAttrs(ctx.safe.w * 0.94, ctx.safe.h * 0.6, 'box')}>${items}</ul>`
      html = sceneShell(id, scene.kind, inner)
      steps.push(...enter(`#${id}-hl`))
      steps.push(...popStagger(`${sel} ul`, startSec + 0.4, ctx, scene.bullets.length))
      break
    }

    case 'comparison': {
      const col = (side: 'left' | 'right', data: { label: string; points: string[] }) => `
        <div class="comp-col ${side}" id="${id}-${side}">
          <div class="comp-label">${esc(data.label)}</div>
          <ul>${data.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        </div>`
      const inner = `
        ${scene.headline ? `<h3 class="headline sm" id="${id}-hl">${esc(scene.headline)}</h3>` : ''}
        <div class="comp-wrap">
          ${col('left', scene.left)}
          <div class="comp-vs" id="${id}-vs">VS</div>
          ${col('right', scene.right)}
        </div>`
      html = sceneShell(id, scene.kind, inner)
      steps.push(...enter(`#${id}-hl`))
      steps.push(
        {
          kind: 'tween',
          t: startSec + 0.25,
          sel: `#${id}-left`,
          from: { autoAlpha: 0, xPercent: -12 },
          to: { autoAlpha: 1, xPercent: 0 },
          dur: 0.5,
          ease: EASE.glide
        },
        {
          kind: 'tween',
          t: startSec + 0.45,
          sel: `#${id}-right`,
          from: { autoAlpha: 0, xPercent: 12 },
          to: { autoAlpha: 1, xPercent: 0 },
          dur: 0.5,
          ease: EASE.glide
        },
        {
          kind: 'tween',
          t: startSec + 0.7,
          sel: `#${id}-vs`,
          from: { autoAlpha: 0, scale: 2.4, rotate: -12 },
          to: { autoAlpha: 1, scale: 1, rotate: 0 },
          dur: 0.4,
          ease: EASE.slam
        }
      )
      break
    }

    case 'stat': {
      const numeric = parseFloat(scene.value.replace(/[^\d.]/g, ''))
      const hasNumeric = !Number.isNaN(numeric)
      const valueHTML = hasNumeric
        ? `<span class="stat-num" id="${id}-num">${esc(String(numeric))}</span>${esc(scene.value.replace(/[\d.,]/g, ''))}`
        : esc(scene.value)
      const inner = `
        <div class="stat-glow" aria-hidden="true"></div>
        <div class="stat-value" id="${id}-val" ${fitAttrs(ctx.safe.w * 0.9, ctx.safe.h * 0.34, 'lines')}>${valueHTML}</div>
        <div class="stat-label" id="${id}-label" ${fitAttrs(ctx.safe.w * 0.9, ctx.safe.h * 0.1, 'box')}>${esc(scene.label)}</div>
        ${scene.context ? `<div class="stat-context" id="${id}-ctx" ${fitAttrs(ctx.safe.w * 0.82, ctx.safe.h * 0.14, 'box')}>${esc(scene.context)}</div>` : ''}`
      html = sceneShell(id, scene.kind, inner)
      steps.push(
        {
          kind: 'tween',
          t: startSec + 0.05,
          sel: `#${id}-val`,
          from: { autoAlpha: 0, scale: 0.6, filter: 'blur(10px)' },
          to: { autoAlpha: 1, scale: 1, filter: 'blur(0px)' },
          dur: 0.6,
          ease: EASE.punch
        },
        {
          kind: 'tween',
          t: startSec + 0.2,
          sel: `#${id} .stat-glow`,
          from: { autoAlpha: 0, scale: 0.5 },
          to: { autoAlpha: 1, scale: 1 },
          dur: 0.9,
          ease: EASE.breathe
        }
      )
      if (hasNumeric) {
        steps.push({
          kind: 'count',
          t: startSec + 0.15,
          sel: `#${id}-num`,
          from: 0,
          to: numeric,
          dur: Math.min(dur * 0.5, 1.4),
          format: 'plain'
        })
      }
      steps.push(riseIn(`#${id}-label`, startSec + 0.5, ctx))
      if (scene.context) steps.push(riseIn(`#${id}-ctx`, startSec + 0.7, ctx))
      break
    }

    case 'quote': {
      const lines = fitLines(scene.text, 4, ctx.safe.w * 0.88, ts.quote)
      const inner = `
        <div class="mark" id="${id}-mark">“</div>
        <blockquote class="quote" id="${id}-q" ${fitAttrs(ctx.safe.w * 0.88, ctx.safe.h * 0.5, 'box')}>${lines.map((l) => `<span class="line">${esc(l)}</span>`).join('')}</blockquote>
        ${scene.attribution ? `<div class="stat-label" id="${id}-attr">— ${esc(scene.attribution)}</div>` : ''}`
      html = sceneShell(id, scene.kind, inner)
      steps.push(
        {
          kind: 'tween',
          t: startSec + 0.05,
          sel: `#${id}-q`,
          from: { autoAlpha: 0, clipPath: 'inset(0% 0% 100% 0%)', y: 20 * ctx.scale },
          to: { autoAlpha: 1, clipPath: 'inset(0% 0% 0% 0%)', y: 0 },
          dur: 0.8,
          ease: EASE.glide
        },
        {
          kind: 'tween',
          t: startSec,
          sel: `#${id}-mark`,
          from: { autoAlpha: 0, scale: 2.2 },
          to: { autoAlpha: 1, scale: 1 },
          dur: 0.5,
          ease: EASE.pop
        }
      )
      if (scene.attribution) steps.push(riseIn(`#${id}-attr`, startSec + 0.7, ctx))
      break
    }

    case 'cta': {
      const clean = dedupeFields({ headline: scene.headline, subline: scene.subline })
      const hl = highlightWord(scene.headline)
      const lines = fitLines(scene.headline, 2, ctx.safe.w * 0.92, ts.cta)
      const fs = Math.round(Math.min(ts.cta, (ctx.safe.w * 0.92) / (Math.max(...lines.map((l) => l.length)) * 0.56)))
      const inner = `
        ${headlineHTML(`${id}-hl`, lines, hl, fs, 'display', fitAttrs(ctx.safe.w * 0.92, ctx.safe.h * 0.34, 'lines'))}
        ${clean.subline ? `<p class="subline" id="${id}-sub" ${fitAttrs(ctx.safe.w * 0.84, ctx.safe.h * 0.15, 'box')}>${esc(clean.subline)}</p>` : ''}
        ${scene.action ? `<div class="cta-pill" id="${id}-pill">${esc(scene.action)}<span class="cta-arrow" id="${id}-arrow">→</span></div>` : ''}
        ${CORNERS}`
      html = sceneShell(id, scene.kind, inner)
      steps.push(...enter(`#${id}-hl`))
      if (clean.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.4, ctx))
      steps.push({
        kind: 'tween',
        t: startSec + 0.2,
        sel: `#${id} .corners`,
        from: { autoAlpha: 0, scale: 1.12 },
        to: { autoAlpha: 1, scale: 1 },
        dur: 0.6,
        ease: EASE.glide
      })
      if (scene.action) {
        steps.push({
          kind: 'tween',
          t: startSec + 0.6,
          sel: `#${id}-pill`,
          from: { autoAlpha: 0, scale: 0.5, y: 30 * ctx.scale },
          to: { autoAlpha: 1, scale: 1, y: 0 },
          dur: 0.5,
          ease: EASE.pop
        })
        // three explicit arrow pulses (seek-safe, no infinite repeats)
        for (let p = 0; p < 3; p++) {
          steps.push({
            kind: 'tween',
            t: startSec + 1.2 + p * 1.1,
            sel: `#${id}-arrow`,
            from: { x: 0 },
            to: { x: 14 * ctx.scale },
            dur: 0.35,
            ease: EASE.whipOut
          })
          steps.push({
            kind: 'tween',
            t: startSec + 1.55 + p * 1.1,
            sel: `#${id}-arrow`,
            from: { x: 14 * ctx.scale },
            to: { x: 0 },
            dur: 0.35,
            ease: EASE.rise
          })
        }
      }
      break
    }

    case 'showcase3d': {
      // hero text pinned to the top third; the 3D object renders below it
      const hl = scene.headline ? highlightWord(scene.headline) : null
      const lines = scene.headline ? fitLines(scene.headline, 2, ctx.safe.w * 0.92, Math.round(ts.headline * 0.8)) : []
      const fs = Math.round(
        Math.min(
          ts.headline * 0.8,
          (ctx.safe.w * 0.92) / (Math.max(1, ...lines.map((l) => l.length)) * 0.56)
        )
      )
      const overlay = `
        ${scene.headline ? headlineHTML(`${id}-hl`, lines, hl, fs, 'headline overlay', fitAttrs(ctx.safe.w * 0.92, ctx.safe.h * 0.24, 'lines')) : ''}
        ${scene.logoText ? `<div class="logo-overlay" id="${id}-logo" ${fitAttrs(ctx.safe.w * 0.9, ctx.safe.h * 0.12, 'box')}>${esc(scene.logoText)}</div>` : ''}`
      html = sceneShellFullBleed(
        id,
        scene.kind,
        `<div class="canvas-host" id="${id}-canvas-host"></div><div class="stage-glow" aria-hidden="true"></div>`,
        overlay,
        'overlay-top'
      )
      threeScript = buildThreeShowcase(
        `#${id}-canvas-host`,
        scene.objectStyle,
        scene.material,
        scene.motion,
        dur,
        id,
        (index + 1) * 1013,
        ctx.palette.accent,
        ctx.palette.accent2
      )
      steps.push(...(scene.logoText || scene.headline ? enter(scene.logoText ? `#${id}-logo` : `#${id}-hl`) : []))
      break
    }

    case 'particles': {
      const clean = dedupeFields({ headline: scene.headline, subline: scene.subline })
      const safeInner = `
        <h2 class="display overlay" id="${id}-hl" ${fitAttrs(ctx.safe.w * 0.92, ctx.safe.h * 0.4, 'lines')}>${esc(clean.headline)}</h2>
        ${clean.subline ? `<p class="subline overlay" id="${id}-sub" ${fitAttrs(ctx.safe.w * 0.84, ctx.safe.h * 0.15, 'box')}>${esc(clean.subline)}</p>` : ''}`
      html = sceneShellFullBleed(id, scene.kind, `<div class="canvas-host" id="${id}-canvas-host"></div>`, safeInner)
      threeScript = buildThreeParticles(
        `#${id}-canvas-host`,
        scene.density,
        dur,
        id,
        (index + 1) * 104729,
        ctx.palette.accent,
        ctx.palette.accent2
      )
      steps.push(...enter(`#${id}-hl`))
      if (clean.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.4, ctx))
      break
    }

    case 'kenburns': {
      const clean = dedupeFields({ headline: scene.headline, subline: scene.subline })
      const safeInner = `
        ${clean.headline ? `<h3 class="headline overlay kb-text" id="${id}-hl" ${fitAttrs(ctx.safe.w * 0.9, ctx.safe.h * 0.2, 'lines')}>${esc(clean.headline)}</h3>` : ''}
        ${clean.subline ? `<p class="subline overlay" id="${id}-sub" ${fitAttrs(ctx.safe.w * 0.82, ctx.safe.h * 0.12, 'box')}>${esc(clean.subline)}</p>` : ''}`
      html = sceneShellFullBleed(
        id,
        scene.kind,
        `<div class="kb-media" id="${id}-media" data-asset-slot="${esc(scene.assetSlotId)}"></div><div class="kb-scrim"></div>`,
        safeInner,
        'overlay-bottom'
      )
      const panX = scene.motion === 'panLeft' ? -8 : scene.motion === 'panRight' ? 8 : 0
      const zoomFrom = scene.motion === 'zoomOut' ? 1.18 : 1.02
      const zoomTo = scene.motion === 'zoomOut' ? 1.02 : 1.18
      steps.push({
        kind: 'tween',
        t: startSec,
        sel: `#${id}-media`,
        from: { autoAlpha: 0, scale: zoomFrom, xPercent: 0 },
        to: { autoAlpha: 1, scale: zoomTo, xPercent: panX },
        dur,
        ease: 'none'
      })
      if (clean.headline) steps.push(slamIn(`#${id}-hl`, startSec + 0.3, ctx))
      if (clean.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.6, ctx))
      break
    }
  }

  // scene exit at boundary (cut keeps the next scene's entrance in charge)
  if (scene.transitionOut === 'fade') {
    steps.push(exitFade(sel, endSec, ctx))
  }
  return { html, steps, primarySel: primaryTarget || undefined, threeScript }
}
