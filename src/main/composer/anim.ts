import type { DesignContext } from './layout'

/**
 * Animation DSL — scene renderers emit declarative steps; the composition's
 * embedded interpreter converts them into one paused, seekable GSAP timeline.
 * Seekability is the determinism contract: HyperFrames scrubs `tl.seek(frame)`
 * and screenshots, so no wall-clock animation may exist.
 */

export interface TweenStep {
  kind: 'tween'
  /** absolute time in seconds */
  t: number
  sel: string
  from: Record<string, unknown>
  to: Record<string, unknown>
  dur: number
  ease: string
  /** stagger children of sel */
  stagger?: number
}

export interface SetStep {
  kind: 'set'
  t: number
  sel: string
  set: Record<string, unknown>
}

export interface CountStep {
  kind: 'count'
  t: number
  sel: string
  from: number
  to: number
  dur: number
  /** format: "percent" | "plain" | "times" */
  format?: 'percent' | 'plain' | 'times' | 'thousands'
  suffix?: string
}

export interface CallStep {
  kind: 'call'
  t: number
  /** name in window.__calls registry (used for 3D hooks) */
  call: string
}

export type AnimStep = TweenStep | SetStep | CountStep | CallStep

export function isTween(s: AnimStep): s is TweenStep {
  return s.kind === 'tween'
}
export function isSet(s: AnimStep): s is SetStep {
  return s.kind === 'set'
}
export function isCount(s: AnimStep): s is CountStep {
  return s.kind === 'count'
}

// ---------- shared motion vocabulary (easing + preset builders) ----------

export const EASE = {
  slam: 'back.out(1.6)',
  pop: 'back.out(2)',
  rise: 'power3.out',
  glide: 'power4.out',
  wipe: 'power4.inOut',
  whipIn: 'power4.out',
  whipOut: 'power4.in',
  softIn: 'power2.inOut',
  punch: 'expo.out',
  breathe: 'sine.inOut'
} as const

/** initial hidden state helper — every scene layer starts invisible */
export function hidden(sel: string, t = 0): SetStep {
  return { kind: 'set', t, sel, set: { autoAlpha: 0 } }
}

/** Big display text slam — the signature social move. */
export function slamIn(sel: string, t: number, ctx: DesignContext, opts?: { dur?: number }): TweenStep {
  return {
    kind: 'tween',
    t,
    sel,
    from: { autoAlpha: 0, scale: 1.6 + 0.25 * ctx.motion, filter: 'blur(14px)', y: 30 * ctx.scale },
    to: { autoAlpha: 1, scale: 1, filter: 'blur(0px)', y: 0 },
    dur: opts?.dur ?? 0.55 / ctx.motion,
    ease: EASE.slam
  }
}

/** Calm rise — explainer default. */
export function riseIn(sel: string, t: number, ctx: DesignContext, opts?: { dur?: number; y?: number }): TweenStep {
  return {
    kind: 'tween',
    t,
    sel,
    from: { autoAlpha: 0, y: (opts?.y ?? 70) * ctx.scale },
    to: { autoAlpha: 1, y: 0 },
    dur: opts?.dur ?? 0.7 / ctx.motion,
    ease: EASE.rise
  }
}

/** Left-to-right mask wipe reveal. */
export function maskReveal(sel: string, t: number, ctx: DesignContext, opts?: { dur?: number }): TweenStep {
  return {
    kind: 'tween',
    t,
    sel,
    from: { autoAlpha: 1, clipPath: 'inset(0% 100% 0% 0%)' },
    to: { autoAlpha: 1, clipPath: 'inset(0% 0% 0% 0%)' },
    dur: opts?.dur ?? 0.8 / ctx.motion,
    ease: EASE.wipe
  }
}

/** Letterspacing + fade — motion3d signature. */
export function trackingIn(sel: string, t: number, ctx: DesignContext, opts?: { dur?: number }): TweenStep {
  return {
    kind: 'tween',
    t,
    sel,
    from: { autoAlpha: 0, letterSpacing: '0.45em', filter: 'blur(8px)' },
    to: { autoAlpha: 1, letterSpacing: '0.02em', filter: 'blur(0px)' },
    dur: opts?.dur ?? 1.1 / ctx.motion,
    ease: EASE.glide
  }
}

/** Staggered bullets pop. */
export function popStagger(sel: string, t: number, ctx: DesignContext, count: number, opts?: { gap?: number }): TweenStep[] {
  const gap = opts?.gap ?? 0.16 / ctx.motion
  const out: TweenStep[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      kind: 'tween',
      t: t + i * gap,
      sel: `${sel} li:nth-child(${i + 1})`,
      from: { autoAlpha: 0, x: -46 * ctx.scale, rotate: -1.5 },
      to: { autoAlpha: 1, x: 0, rotate: 0 },
      dur: 0.5,
      ease: EASE.pop
    })
  }
  return out
}

/** Scene exit fade/scale for cut boundaries. */
export function exitFade(sel: string, tEnd: number, ctx: DesignContext, opts?: { dur?: number }): TweenStep {
  const dur = opts?.dur ?? 0.28
  return {
    kind: 'tween',
    t: Math.max(0, tEnd - dur),
    sel,
    from: { autoAlpha: 1, scale: 1 },
    to: { autoAlpha: 0, scale: 0.96 },
    dur,
    ease: EASE.softIn
  }
}

/** Whip transition: current scene slides out with skew, next slides in. */
export function whipTransition(outSel: string, inSel: string, tBoundary: number, ctx: DesignContext, dir: 1 | -1 = 1): AnimStep[] {
  const d = 0.32 / Math.max(1, ctx.motion)
  return [
    {
      kind: 'tween',
      t: tBoundary - d,
      sel: outSel,
      from: { xPercent: 0, skewX: 0, autoAlpha: 1 },
      to: { xPercent: -110 * dir, skewX: 12 * dir, autoAlpha: 1 },
      dur: d,
      ease: EASE.whipOut
    },
    {
      kind: 'tween',
      t: tBoundary,
      sel: inSel,
      from: { xPercent: 110 * dir, skewX: -12 * dir, autoAlpha: 1 },
      to: { xPercent: 0, skewX: 0 },
      dur: d,
      ease: EASE.whipIn
    }
  ]
}

/** Glitch transition: 3 quick offset flickers. */
export function glitchTransition(outSel: string, inSel: string, tBoundary: number, ctx: DesignContext): AnimStep[] {
  const flick = 0.07
  const steps: AnimStep[] = []
  for (let i = 0; i < 3; i++) {
    steps.push({
      kind: 'tween',
      t: tBoundary - 3 * flick + i * flick,
      sel: outSel,
      from: { x: 0, autoAlpha: 1 },
      to: { x: (i % 2 === 0 ? -1 : 1) * 26 * ctx.scale, autoAlpha: i === 2 ? 0 : 1 },
      dur: flick,
      ease: 'steps(2)'
    })
  }
  steps.push({
    kind: 'tween',
    t: tBoundary,
    sel: inSel,
    from: { x: 22 * ctx.scale, autoAlpha: 0, filter: 'blur(6px)' },
    to: { x: 0, autoAlpha: 1, filter: 'blur(0px)' },
    dur: 0.24,
    ease: EASE.punch
  })
  return steps
}

/** Zoom transition. */
export function zoomTransition(outSel: string, inSel: string, tBoundary: number, ctx: DesignContext): AnimStep[] {
  const d = 0.4 / Math.max(1, ctx.motion * 0.8)
  return [
    {
      kind: 'tween',
      t: tBoundary - d,
      sel: outSel,
      from: { scale: 1, autoAlpha: 1 },
      to: { scale: 1.35, autoAlpha: 0 },
      dur: d,
      ease: EASE.whipOut
    },
    {
      kind: 'tween',
      t: tBoundary,
      sel: inSel,
      from: { scale: 0.82, autoAlpha: 0 },
      to: { scale: 1, autoAlpha: 1 },
      dur: d,
      ease: EASE.glide
    }
  ]
}

/** Slide transition. */
export function slideTransition(outSel: string, inSel: string, tBoundary: number, ctx: DesignContext, dir: 1 | -1 = -1): AnimStep[] {
  const d = 0.45 / Math.max(1, ctx.motion * 0.8)
  return [
    {
      kind: 'tween',
      t: tBoundary - d,
      sel: outSel,
      from: { xPercent: 0, autoAlpha: 1 },
      to: { xPercent: -45 * dir, autoAlpha: 0 },
      dur: d,
      ease: EASE.glide
    },
    {
      kind: 'tween',
      t: tBoundary - d * 0.25,
      sel: inSel,
      from: { xPercent: 100 * dir, autoAlpha: 0 },
      to: { xPercent: 0, autoAlpha: 1 },
      dur: d,
      ease: EASE.rise
    }
  ]
}

export interface TransitionKind {
  build(outSel: string, inSel: string, tBoundary: number, ctx: DesignContext): AnimStep[]
}

export const TRANSITIONS: Record<string, TransitionKind> = {
  cut: { build: () => [] },
  fade: {
    build: (o, i, t, ctx) => [
      exitFade(o, t, ctx),
      { kind: 'tween', t, sel: i, from: { autoAlpha: 0 }, to: { autoAlpha: 1 }, dur: 0.35, ease: EASE.softIn }
    ]
  },
  whip: { build: (o, i, t, ctx) => whipTransition(o, i, t, ctx, 1) },
  slide: { build: (o, i, t, ctx) => slideTransition(o, i, t, ctx) },
  zoom: { build: (o, i, t, ctx) => zoomTransition(o, i, t, ctx) },
  glitch: { build: (o, i, t, ctx) => glitchTransition(o, i, t, ctx) },
  wipe: {
    build: (o, i, t, ctx) => [
      exitFade(o, t, ctx, { dur: 0.2 }),
      maskReveal(i, t, ctx, { dur: 0.5 })
    ]
  }
}
