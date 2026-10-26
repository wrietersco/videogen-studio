import type { DesignContext } from './layout'
import { fitLines, typeScale } from './layout'
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
function sceneShellFullBleed(id: string, kind: string, bleed: string, safeInner: string): string {
  return `<section class="scene" id="${id}" data-kind="${kind}"><div class="bleed">${bleed}</div><div class="safe">${safeInner}</div></section>`
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

function headlineHTML(id: string, lines: string[], hl: { pre: string; word: string; post: string } | null, fs: number, cls: string): string {
  const lineSpans = lines.map((l) => {
    if (hl && l.includes(hl.word)) {
      const marked = l.replace(hl.word, `<span class="hl" id="${id}-hlspan">${esc(hl.word)}</span>`)
      return `<span class="line">${marked}</span>`
    }
    return `<span class="line">${esc(l)}</span>`
  })
  return `<h2 class="${cls}" id="${id}" style="font-size:${fs}px">${lineSpans.join('')}</h2>`
}

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
      const lines = fitLines(scene.headline, 3, ctx.safe.w * 0.92, ts.display)
      const fs = Math.round(Math.min(ts.display, (ctx.safe.w * 0.92) / (Math.max(...lines.map((l) => l.length)) * 0.52)))
      const hl = highlightWord(scene.headline)
      const inner = `
        ${scene.kicker ? `<div class="kicker" id="${id}-kicker">${esc(scene.kicker)}</div>` : ''}
        ${headlineHTML(`${id}-hl`, lines, hl, fs, 'display')}
        ${scene.subline ? `<p class="subline" id="${id}-sub">${esc(scene.subline)}</p>` : ''}
        <div class="underline" id="${id}-bar"></div>`
      html = sceneShell(id, scene.kind, inner)
      steps.push(...enter(`#${id}-hl`))
      if (scene.kicker) {
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
      if (scene.subline) {
        steps.push(riseIn(`#${id}-sub`, startSec + 0.5, ctx))
      }
      break
    }

    case 'statement': {
      const lines = fitLines(scene.headline, 3, ctx.safe.w * 0.9, ts.headline)
      const fs = Math.round(Math.min(ts.headline, (ctx.safe.w * 0.9) / (Math.max(...lines.map((l) => l.length)) * 0.52)))
      const hl = highlightWord(scene.headline)
      const inner = `
        <div class="mark" id="${id}-mark">“</div>
        ${headlineHTML(`${id}-hl`, lines, hl, fs, 'headline')}
        ${scene.subline ? `<p class="subline" id="${id}-sub">${esc(scene.subline)}</p>` : ''}`
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
      if (scene.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.45, ctx))
      break
    }

    case 'bullets': {
      const items = scene.bullets
        .map(
          (b, i) =>
            `<li id="${id}-b${i}"><span class="idx">${String(i + 1).padStart(2, '0')}</span><span class="bl">${esc(b)}</span></li>`
        )
        .join('\n')
      const inner = `
        <h3 class="headline sm" id="${id}-hl">${esc(scene.headline)}</h3>
        <ul class="bullets">${items}</ul>`
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
        <div class="stat-value" id="${id}-val">${valueHTML}</div>
        <div class="stat-label" id="${id}-label">${esc(scene.label)}</div>
        ${scene.context ? `<div class="stat-context" id="${id}-ctx">${esc(scene.context)}</div>` : ''}`
      html = sceneShell(id, scene.kind, inner)
      steps.push({
        kind: 'tween',
        t: startSec + 0.05,
        sel: `#${id}-val`,
        from: { autoAlpha: 0, scale: 0.6, filter: 'blur(10px)' },
        to: { autoAlpha: 1, scale: 1, filter: 'blur(0px)' },
        dur: 0.6,
        ease: EASE.punch
      })
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
        <blockquote class="quote" id="${id}-q">${lines.map((l) => `<span class="line">${esc(l)}</span>`).join('')}</blockquote>
        ${scene.attribution ? `<div class="stat-label" id="${id}-attr">— ${esc(scene.attribution)}</div>` : ''}`
      html = sceneShell(id, scene.kind, inner)
      steps.push({
        kind: 'tween',
        t: startSec + 0.05,
        sel: `#${id}-q`,
        from: { autoAlpha: 0, clipPath: 'inset(0% 0% 100% 0%)', y: 20 * ctx.scale },
        to: { autoAlpha: 1, clipPath: 'inset(0% 0% 0% 0%)', y: 0 },
        dur: 0.8,
        ease: EASE.glide
      })
      if (scene.attribution) steps.push(riseIn(`#${id}-attr`, startSec + 0.7, ctx))
      break
    }

    case 'cta': {
      const hl = highlightWord(scene.headline)
      const lines = fitLines(scene.headline, 2, ctx.safe.w * 0.9, ts.cta)
      const fs = Math.round(Math.min(ts.cta, (ctx.safe.w * 0.9) / (Math.max(...lines.map((l) => l.length)) * 0.52)))
      const inner = `
        ${headlineHTML(`${id}-hl`, lines, hl, fs, 'display')}
        ${scene.subline ? `<p class="subline" id="${id}-sub">${esc(scene.subline)}</p>` : ''}
        ${scene.action ? `<div class="cta-pill" id="${id}-pill">${esc(scene.action)}</div>` : ''}`
      html = sceneShell(id, scene.kind, inner)
      steps.push(...enter(`#${id}-hl`))
      if (scene.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.4, ctx))
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
      }
      break
    }

    case 'showcase3d': {
      const overlay = `
        ${scene.headline ? `<h3 class="headline overlay" id="${id}-hl">${esc(scene.headline)}</h3>` : ''}
        ${scene.logoText ? `<div class="logo-overlay" id="${id}-logo">${esc(scene.logoText)}</div>` : ''}`
      html = sceneShellFullBleed(id, scene.kind, `<div class="canvas-host" id="${id}-canvas-host"></div>`, overlay)
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
      steps.push(...enter(scene.logoText ? `#${id}-logo` : `#${id}-hl`))
      break
    }

    case 'particles': {
      const safeInner = `
        <h2 class="display overlay" id="${id}-hl">${esc(scene.headline)}</h2>
        ${scene.subline ? `<p class="subline overlay" id="${id}-sub">${esc(scene.subline)}</p>` : ''}`
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
      if (scene.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.4, ctx))
      break
    }

    case 'kenburns': {
      const safeInner = `
        ${scene.headline ? `<h3 class="headline overlay" id="${id}-hl">${esc(scene.headline)}</h3>` : ''}
        ${scene.subline ? `<p class="subline overlay" id="${id}-sub">${esc(scene.subline)}</p>` : ''}`
      html = sceneShellFullBleed(
        id,
        scene.kind,
        `<div class="kb-media" id="${id}-media" data-asset-slot="${esc(scene.assetSlotId)}"></div><div class="kb-scrim"></div>`,
        safeInner
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
      if (scene.headline) steps.push(slamIn(`#${id}-hl`, startSec + 0.3, ctx))
      if (scene.subline) steps.push(riseIn(`#${id}-sub`, startSec + 0.6, ctx))
      break
    }
  }

  // scene exit at boundary (cut keeps the next scene's entrance in charge)
  if (scene.transitionOut === 'fade') {
    steps.push(exitFade(sel, endSec, ctx))
  }
  return { html, steps, primarySel: primaryTarget || undefined, threeScript }
}
