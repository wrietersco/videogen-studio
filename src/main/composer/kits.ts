import type { DesignContext } from './layout'
import type { AnimStep } from './anim'
import { EASE, riseIn, slamIn, trackingIn, maskReveal } from './anim'
import type { StyleFamily } from '@shared/spec'

/**
 * Style kits — curated design intelligence per style family.
 * A kit shapes HOW scenes look and move (motion physics, atmosphere,
 * entrance personality) without constraining WHAT the video says.
 * This is the "design system, not templates" layer.
 */

export interface StyleKit {
  id: StyleFamily
  /** background atmosphere HTML (behind all scenes) */
  atmosphere(ctx: DesignContext): string
  atmosphereCSS(ctx: DesignContext): string
  /** signature entrance for the scene's primary element */
  enter(sel: string, t: number, ctx: DesignContext): AnimStep[]
  /** final CSS state of the entrance — used to make frame 0 (the thumbnail) non-empty */
  enterFinal(): Record<string, unknown>
  /** whole-film atmosphere motion; keeps every stretch of the video visually alive */
  atmoIdle(totalSec: number, ctx: DesignContext): AnimStep[]
  /** subtle idle motion while scene is on screen (seekable loops via -1 repeats are NOT seekable-safe; use explicit repeats) */
  idle(sel: string, t: number, dur: number, ctx: DesignContext): AnimStep[]
}

// --------------------------------- SOCIAL ---------------------------------

export const socialKit: StyleKit = {
  id: 'social',
  atmosphere(ctx) {
    return `
      <div class="atmo-gradient"></div>
      <div class="atmo-shape atmo-shape-1"></div>
      <div class="atmo-shape atmo-shape-2"></div>
      <div class="atmo-shape atmo-shape-3"></div>
      <div class="atmo-vignette"></div>
      <div class="atmo-grain"></div>`.trim()
  },
  atmosphereCSS(ctx) {
    const { accent, accent2, bg } = ctx.palette
    return `
      .atmo-gradient {
        position: absolute; inset: 0;
        background:
          radial-gradient(120% 90% at 85% 10%, ${accent}33 0%, transparent 55%),
          radial-gradient(100% 80% at 10% 90%, ${accent2}2A 0%, transparent 50%),
          linear-gradient(160deg, ${bg} 0%, ${bg} 60%, ${ctx.palette.surface} 100%);
      }
      .atmo-vignette {
        position: absolute; inset: 0;
        background: radial-gradient(125% 125% at 50% 46%, transparent 58%, rgba(0,0,0,0.42) 100%);
      }
      .atmo-shape {
        position: absolute; border-radius: 50%; filter: blur(2px); opacity: 0.16;
      }
      .atmo-shape-1 { width: ${Math.round(420 * ctx.scale)}px; height: ${Math.round(420 * ctx.scale)}px; background: ${accent2}; top: -6%; right: -12%; }
      .atmo-shape-2 { width: ${Math.round(260 * ctx.scale)}px; height: ${Math.round(260 * ctx.scale)}px; background: ${accent}; bottom: 12%; left: -10%; }
      .atmo-shape-3 { width: ${Math.round(120 * ctx.scale)}px; height: ${Math.round(120 * ctx.scale)}px; background: ${ctx.palette.fg}; top: 38%; left: 62%; opacity: 0.08; }
      .atmo-grain {
        position: absolute; inset: 0; opacity: 0.05; pointer-events: none;
        background-image: repeating-conic-gradient(${ctx.palette.fg} 0% 0.0002%, transparent 0.0004% 0.02%);
        background-size: 3px 3px;
        mix-blend-mode: overlay;
      }`
  },
  enter(sel, t, ctx) {
    return [slamIn(sel, t, ctx)]
  },
  enterFinal() {
    return { autoAlpha: 1, scale: 1, filter: 'blur(0px)', y: 0 }
  },
  atmoIdle(totalSec, ctx) {
    // shapes drift continuously — the film never has a dead stretch
    const cycles = Math.max(1, Math.round(totalSec / 5))
    const seg = totalSec / cycles
    const drift = (sel: string, dx: number, dy: number): AnimStep[] => [
      { kind: 'tween', t: 0, sel, from: { x: 0, y: 0 }, to: { x: dx * ctx.scale, y: dy * ctx.scale }, dur: seg, ease: EASE.breathe },
      { kind: 'tween', t: seg, sel, from: { x: dx * ctx.scale, y: dy * ctx.scale }, to: { x: 0, y: 0 }, dur: seg, ease: EASE.breathe }
    ]
    const out: AnimStep[] = []
    for (let c = 0; c < cycles; c += 2) {
      for (const s of drift('.atmo-shape-1', 60, 40)) out.push({ ...s, t: s.t + c * seg })
      for (const s of drift('.atmo-shape-2', -50, -34)) out.push({ ...s, t: s.t + c * seg })
      for (const s of drift('.atmo-shape-3', -70, 55)) out.push({ ...s, t: s.t + c * seg })
    }
    return out
  },
  idle(sel, t, dur, ctx) {
    // slow breathing scale — explicit repeats (seekable), not infinite
    const cycles = Math.max(1, Math.floor(dur / 2.4))
    return [
      {
        kind: 'tween',
        t,
        sel,
        from: { scale: 1 },
        to: { scale: 1.015 * ctx.motion },
        dur: 2.4,
        ease: EASE.breathe,
        stagger: 0
      },
      {
        kind: 'tween',
        t: t + 2.4,
        sel,
        from: { scale: 1.015 * ctx.motion },
        to: { scale: 1 },
        dur: 2.4 * (cycles - 1),
        ease: EASE.breathe,
        stagger: 0
      }
    ]
  }
}

// -------------------------------- EXPLAINER --------------------------------

export const explainerKit: StyleKit = {
  id: 'explainer',
  atmosphere(ctx) {
    return `
      <div class="atmo-bg"></div>
      <div class="atmo-blob atmo-blob-1"></div>
      <div class="atmo-blob atmo-blob-2"></div>
      <div class="atmo-grid"></div>
      <div class="atmo-vignette"></div>
      <div class="atmo-progress"><div class="atmo-progress-fill"></div></div>`.trim()
  },
  atmosphereCSS(ctx) {
    const { bg, surface, fg, accent, accent2, muted } = ctx.palette
    return `
      .atmo-bg { position: absolute; inset: 0; background: linear-gradient(180deg, ${surface} 0%, ${bg} 100%); }
      .atmo-blob { position: absolute; border-radius: 50%; filter: blur(${Math.round(70 * ctx.scale)}px); opacity: 0.14; }
      .atmo-blob-1 { width: ${Math.round(520 * ctx.scale)}px; height: ${Math.round(520 * ctx.scale)}px; background: ${accent}; top: -14%; right: -10%; }
      .atmo-blob-2 { width: ${Math.round(430 * ctx.scale)}px; height: ${Math.round(430 * ctx.scale)}px; background: ${accent2}; bottom: -12%; left: -8%; }
      .atmo-vignette {
        position: absolute; inset: 0;
        background: radial-gradient(125% 125% at 50% 46%, transparent 60%, rgba(0,0,0,0.34) 100%);
      }
      .atmo-grid {
        position: absolute; inset: 0; opacity: 0.5;
        background-image: radial-gradient(${muted}22 ${Math.max(1, Math.round(1.5 * ctx.scale))}px, transparent ${Math.max(1, Math.round(1.5 * ctx.scale))}px);
        background-size: ${Math.round(64 * ctx.scale)}px ${Math.round(64 * ctx.scale)}px;
      }
      .atmo-progress {
        position: absolute; top: 0; left: 0; right: 0; height: ${Math.max(3, Math.round(6 * ctx.scale))}px;
        background: ${fg}14;
      }
      .atmo-progress-fill {
        position: absolute; inset: 0; transform-origin: left center; transform: scaleX(0);
        background: linear-gradient(90deg, ${accent}, ${ctx.palette.accent2});
      }`
  },
  enter(sel, t, ctx) {
    return [riseIn(sel, t, ctx)]
  },
  enterFinal() {
    return { autoAlpha: 1, y: 0 }
  },
  atmoIdle() {
    // progress bar already sweeps the full film — enough ambient motion
    return []
  },
  idle(sel, t, dur, ctx) {
    return [
      {
        kind: 'tween',
        t,
        sel,
        from: { scale: 1 },
        to: { scale: 1.008 },
        dur: Math.min(dur, 3),
        ease: EASE.breathe
      }
    ]
  }
}

// -------------------------------- MOTION 3D --------------------------------

export const motion3dKit: StyleKit = {
  id: 'motion3d',
  atmosphere(ctx) {
    return `
      <div class="atmo-deep"></div>
      <div class="atmo-vignette"></div>
      <div class="atmo-glow"></div>`.trim()
  },
  atmosphereCSS(ctx) {
    const { bg, accent, accent2 } = ctx.palette
    return `
      .atmo-deep {
        position: absolute; inset: 0;
        background: radial-gradient(140% 120% at 50% 42%, ${ctx.palette.surface} 0%, ${bg} 58%, #000 130%);
      }
      .atmo-vignette {
        position: absolute; inset: 0;
        background: radial-gradient(120% 120% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%);
      }
      .atmo-glow {
        position: absolute; inset: -10%; filter: blur(${Math.round(90 * ctx.scale)}px); opacity: 0.35;
        background:
          radial-gradient(22% 30% at 30% 30%, ${accent} 0%, transparent 70%),
          radial-gradient(26% 32% at 72% 66%, ${accent2} 0%, transparent 70%);
      }`
  },
  enter(sel, t, ctx) {
    return [trackingIn(sel, t, ctx)]
  },
  enterFinal() {
    return { autoAlpha: 1, letterSpacing: '0.02em', filter: 'blur(0px)' }
  },
  atmoIdle(totalSec, ctx) {
    // glow slowly breathes across the whole film
    const half = 3.2
    const cycles = Math.max(1, Math.round(totalSec / (half * 2)))
    return [
      { kind: 'tween', t: 0, sel: '.atmo-glow', from: { opacity: 0.3 }, to: { opacity: 0.42 }, dur: half, ease: EASE.breathe },
      { kind: 'tween', t: half, sel: '.atmo-glow', from: { opacity: 0.42 }, to: { opacity: 0.3 }, dur: half * cycles, ease: EASE.breathe }
    ]
  },
  idle(sel, t, dur, ctx) {
    // slow drift + glow pulse; explicit cycle count keeps seeks exact
    const halfCycle = 2.6
    const cycles = Math.max(1, Math.floor(dur / (halfCycle * 2)))
    return [
      {
        kind: 'tween',
        t,
        sel,
        from: { y: 0, filter: 'brightness(1)' },
        to: { y: -14 * ctx.scale, filter: 'brightness(1.12)' },
        dur: halfCycle,
        ease: EASE.breathe
      },
      {
        kind: 'tween',
        t: t + halfCycle,
        sel,
        from: { y: -14 * ctx.scale, filter: 'brightness(1.12)' },
        to: { y: 0, filter: 'brightness(1)' },
        dur: halfCycle * cycles,
        ease: EASE.breathe
      }
    ]
  }
}

export const KITS: Record<StyleFamily, StyleKit> = {
  social: socialKit,
  explainer: explainerKit,
  motion3d: motion3dKit,
  // pre-MVP families map to nearest MVP kit until dedicated kits land
  cinematic: motion3dKit,
  documentary: explainerKit,
  flat2d: socialKit
}

export { riseIn, slamIn, trackingIn, maskReveal }
