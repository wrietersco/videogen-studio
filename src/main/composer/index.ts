import type { VideoSpec, Scene } from '@shared/spec'
import { PLATFORM_PRESETS } from '@shared/presets'
import { designContext, type DesignContext, typeScale, fitAttrs } from './layout'
import type { AnimStep } from './anim'
import { KITS, type StyleKit } from './kits'
import { validateSelectors } from './selectors'
import { renderScene } from './scenes'
import { TRANSITIONS } from './anim'

/**
 * compose() — VideoSpec + platform preset → complete HyperFrames project.
 * Pure function: same inputs → byte-identical index.html → identical MP4.
 */

export interface ComposeResult {
  html: string
  /** relative asset paths to copy into the project (vendor js, fonts) */
  assets: Array<{ from: string; to: string }>
  needsThree: boolean
}

export interface AudioLayer {
  clips: Array<{ file: string; startSec: number; durationSec: number; volume: number; trackIndex: number }>
  captions: Array<{ startSec: number; endSec: number; text: string }>
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function compose(spec: VideoSpec, vendorDir: string, fontsDir: string, audio?: AudioLayer): ComposeResult {
  const preset = PLATFORM_PRESETS[spec.platform]
  const ctx = designContext(spec, preset)
  const kit = KITS[spec.style]

  // ---- scene windows ----
  let cursor = 0
  const windows = spec.scenes.map((s) => {
    const w = { start: cursor, end: cursor + s.durationSec }
    cursor = w.end
    return w
  })
  const totalSec = Math.round(cursor * 100) / 100

  // ---- render scenes ----
  const steps: AnimStep[] = []
  const sceneHTML: string[] = []
  const threeScripts: string[] = []
  const sceneStart: Record<string, number> = {}
  let needsThree = false

  spec.scenes.forEach((scene: Scene, i) => {
    const { start, end } = windows[i]
    const rendered = renderScene(scene, i, start, end, ctx, kit)
    sceneHTML.push(rendered.html)
    steps.push(...rendered.steps)
    sceneStart[`scene-${i + 1}`] = start
    if (rendered.threeScript) {
      threeScripts.push(rendered.threeScript)
      needsThree = true
    }

    // frame 0 thumbnail handled inside renderScene (hero enters via set, not tween)

    // section visibility staging: everything hidden at t0 except scene 1
    steps.push({ kind: 'set', t: 0, sel: `#scene-${i + 1}`, set: { autoAlpha: i === 0 ? 1 : 0 } })
    if (i > 0) {
      // the outgoing scene MUST hide at the boundary — canvases are transparent,
      // so a lingering previous scene ghosts its text/3D under the new one
      steps.push({ kind: 'set', t: start, sel: `#scene-${i}`, set: { autoAlpha: 0 } })
    }
    // cut entrances bring the section up at its start (non-cut transitions handle it themselves)
    if (i > 0 && scene.transitionIn === 'cut') {
      steps.push({ kind: 'set', t: start, sel: `#scene-${i + 1}`, set: { autoAlpha: 1 } })
    }
    // section-level transition from the previous scene
    if (i > 0 && scene.transitionIn !== 'cut') {
      const builder = TRANSITIONS[scene.transitionIn] ?? TRANSITIONS.fade
      steps.push(...builder.build(`#scene-${i}`, `#scene-${i + 1}`, start, ctx))
    }
  })

  // explainer progress bar spans the whole video
  if (spec.style === 'explainer') {
    steps.push({
      kind: 'tween',
      t: 0,
      sel: '.atmo-progress-fill',
      from: { scaleX: 0 },
      to: { scaleX: 1 },
      dur: totalSec,
      ease: 'none'
    })
  }

  // whole-film atmosphere motion (no dead stretches)
  steps.push(...kit.atmoIdle(totalSec, ctx))

  // self-heal: drop any step targeting elements that don't exist in the
  // assembled markup (guarantees no "GSAP target not found" at render time)
  const markup = sceneHTML.join('\n') + kit.atmosphere(ctx)
  const invalid = new Set(validateSelectors(markup, steps).map((i) => i.selector))
  const safeSteps = invalid.size > 0 ? steps.filter((s) => !invalid.has((s as { sel?: string }).sel)) : steps

  // ---- assets ----
  const assets: ComposeResult['assets'] = [
    { from: `${vendorDir}/gsap.min.js`, to: 'assets/vendor/gsap.min.js' }
  ]
  if (needsThree) {
    assets.push({ from: `${vendorDir}/three.module.js`, to: 'assets/vendor/three.module.js' })
    // three ≥0.170 splits its build: module.js imports ./three.core.js
    assets.push({ from: `${vendorDir}/three.core.js`, to: 'assets/vendor/three.core.js' })
  }
  for (const f of fontsNeeded(spec)) {
    assets.push({ from: `${fontsDir}/${f}`, to: `assets/fonts/${f}` })
  }

  const html = buildDocument(spec, ctx, kit, sceneHTML, safeSteps, threeScripts, sceneStart, totalSec, audio)
  return { html, assets, needsThree }
}

function fontsNeeded(spec: VideoSpec): string[] {
  const files = new Set<string>()
  const add = (family: string) => {
    const key = family.split(',')[0].trim().toLowerCase()
    const map: Record<string, string> = {
      'archivo black': 'ArchivoBlack-Regular.woff2',
      inter: 'Inter-Regular.woff2',
      'space grotesk': 'SpaceGrotesk-Bold.woff2',
      'playfair display': 'PlayfairDisplay-Bold.woff2',
      nunito: 'Nunito-ExtraBold.woff2'
    }
    if (map[key]) files.add(map[key])
  }
  add(spec.typography.display)
  add(spec.typography.body)
  return [...files]
}

function fontFaceCSS(spec: VideoSpec): string {
  const defs: Array<[string, string]> = [
    ['Archivo Black', 'ArchivoBlack-Regular.woff2'],
    ['Inter', 'Inter-Regular.woff2'],
    ['Space Grotesk', 'SpaceGrotesk-Bold.woff2'],
    ['Playfair Display', 'PlayfairDisplay-Bold.woff2'],
    ['Nunito', 'Nunito-ExtraBold.woff2']
  ]
  return defs
    .map(
      ([family, file]) => `@font-face {
  font-family: '${family}';
  src: url('assets/fonts/${file}') format('woff2');
  font-weight: 100 900;
  font-display: block;
}`
    )
    .join('\n')
}

function baseCSS(ctx: DesignContext, captionUppercase: boolean): string {
  const { palette: p, typography: t } = ctx
  const ts = typeScale(ctx)
  const caps = t.capsDisplay ? 'text-transform: uppercase;' : ''
  return `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: ${ctx.width}px; height: ${ctx.height}px;
      overflow: hidden; background: ${p.bg};
      -webkit-font-smoothing: antialiased;
    }
    #root { position: relative; width: 100%; height: 100%; }
    .atmo, .atmo > * { position: absolute; inset: 0; pointer-events: none; }
    .scene { position: absolute; inset: 0; visibility: hidden; }
    .bleed { position: absolute; inset: 0; }
    .safe {
      position: absolute;
      left: ${ctx.safe.x}px; top: ${ctx.safe.y}px;
      width: ${ctx.safe.w}px; height: ${ctx.safe.h}px;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      text-align: center; gap: ${Math.round(28 * ctx.scale)}px;
    }
    /* never let flex squeeze text — the autofit pass owns sizing */
    .safe > * { flex-shrink: 0; }
    .safe.overlay-top { justify-content: flex-start; padding-top: ${Math.round(ctx.safe.h * 0.04)}px; }
    .safe.overlay-bottom { justify-content: flex-end; padding-bottom: ${ctx.captionBand.bottomPx + Math.round(170 * ctx.scale)}px; }
    .display, .headline {
      font-family: ${fam(t.display)};
      font-weight: 900;
      ${caps}
      color: ${p.fg};
      line-height: 0.98;
      letter-spacing: -0.02em;
      max-width: 100%;
      text-shadow: 0 ${Math.round(3 * ctx.scale)}px ${Math.round(26 * ctx.scale)}px rgba(0,0,0,0.35);
    }
    /* display lines never re-wrap in the browser: the autofit pass scales them to fit */
    .line { display: block; white-space: nowrap; }
    .headline.overlay, .display.overlay, .subline.overlay {
      position: relative; z-index: 2;
    }
    .headline.overlay { font-size: ${Math.round(ts.headline * 0.8)}px; }
    .display.overlay { font-size: ${Math.round(ts.display * 0.85)}px; }
    .subline.overlay { font-size: ${Math.round(ts.subline * 0.95)}px; }
    .headline.overlay, .display.overlay, .logo-overlay, .kb-text {
      text-shadow: 0 ${Math.round(4 * ctx.scale)}px ${Math.round(34 * ctx.scale)}px rgba(0,0,0,0.55);
    }
    .headline.sm { font-size: ${Math.round(ts.headline * 0.72)}px; }
    .hl {
      display: inline-block;
      background: ${p.accent};
      color: ${readableOn(p.accent)};
      padding: 0.02em 0.14em;
      border-radius: 0.08em;
      transform: rotate(-1.2deg);
    }
    .kicker {
      font-family: ${fam(t.body)};
      font-size: ${ts.kicker}px;
      font-weight: 700;
      letter-spacing: 0.32em;
      text-transform: uppercase;
      color: ${p.accent2};
      text-shadow: 0 ${Math.round(2 * ctx.scale)}px ${Math.round(16 * ctx.scale)}px rgba(0,0,0,0.4);
    }
    .subline {
      font-family: ${fam(t.body)};
      font-size: ${ts.subline}px;
      font-weight: 500;
      color: ${mix(p.fg, p.bg, 0.82)};
      line-height: 1.25;
      max-width: 92%;
      overflow-wrap: break-word;
    }
    .underline {
      width: ${Math.round(180 * ctx.scale)}px; height: ${Math.round(10 * ctx.scale)}px;
      background: ${p.accent}; border-radius: 99px;
      transform-origin: left center; transform: scaleX(0);
    }
    .mark {
      position: absolute; top: 4%; left: 6%;
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.display * 1.6)}px;
      color: ${p.accent}; opacity: 0.25; line-height: 1;
    }
    .corners { position: absolute; inset: ${Math.round(-14 * ctx.scale)}px; pointer-events: none; }    .corners i {
      position: absolute; width: ${Math.round(46 * ctx.scale)}px; height: ${Math.round(46 * ctx.scale)}px;
      border: ${Math.max(2, Math.round(4 * ctx.scale))}px solid ${p.accent}; opacity: 0.85;
    }
    .corners i:nth-child(1) { top: 0; left: 0; border-right: none; border-bottom: none; }
    .corners i:nth-child(2) { top: 0; right: 0; border-left: none; border-bottom: none; }
    .corners i:nth-child(3) { bottom: 0; left: 0; border-right: none; border-top: none; }
    .corners i:nth-child(4) { bottom: 0; right: 0; border-left: none; border-top: none; }
    /* editorial dressing — depth layers behind the content */
    .ghost {
      position: absolute; right: ${Math.round(24 * ctx.scale)}px; top: ${Math.round(ctx.safe.h * 0.03)}px;
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.display * 2.6)}px; line-height: 1;
      letter-spacing: -0.04em;
      color: ${p.accent};
      opacity: 0;
      pointer-events: none;
      text-shadow: none;
    }
    .ring, .ring2 {
      position: absolute; top: 50%; left: 50%;
      border-radius: 50%; pointer-events: none;
    }
    .ring {
      width: ${Math.round(Math.min(ctx.safe.w, ctx.safe.h) * 0.82)}px;
      height: ${Math.round(Math.min(ctx.safe.w, ctx.safe.h) * 0.82)}px;
      border: ${Math.max(2, Math.round(2.5 * ctx.scale))}px solid ${p.accent2};
      opacity: 0;
    }
    .ring2 {
      width: ${Math.round(Math.min(ctx.safe.w, ctx.safe.h) * 1.08)}px;
      height: ${Math.round(Math.min(ctx.safe.w, ctx.safe.h) * 1.08)}px;
      border: ${Math.max(2, Math.round(2 * ctx.scale))}px dashed ${p.accent};
      opacity: 0;
    }
    .bullets { list-style: none; text-align: left; width: 100%; }
    .bullets li {
      display: flex; align-items: baseline; gap: ${Math.round(22 * ctx.scale)}px;
      margin-bottom: ${Math.round(18 * ctx.scale)}px;
      padding: ${Math.round(16 * ctx.scale)}px ${Math.round(22 * ctx.scale)}px;
      border-left: ${Math.max(3, Math.round(6 * ctx.scale))}px solid ${p.accent2};
      border-radius: ${Math.round(14 * ctx.scale)}px;
      background: linear-gradient(90deg, ${mix(p.fg, p.bg, 0.07)}, transparent 78%);
    }
    .bullets .idx {
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.bullet * 0.8)}px;
      color: ${p.accent}; opacity: 0.95; min-width: 1.5em;
    }
    .bullets .bl {
      font-family: ${fam(t.body)};
      font-size: ${ts.bullet}px; font-weight: 600; color: ${p.fg};
      line-height: 1.15; overflow-wrap: break-word;
    }
    .comp-wrap {
      display: flex; align-items: stretch; gap: ${Math.round(36 * ctx.scale)}px;
      width: 100%; justify-content: center;
    }
    .comp-col {
      flex: 1; border-radius: ${Math.round(28 * ctx.scale)}px;
      padding: ${Math.round(36 * ctx.scale)}px;
      background: ${p.surface};
      border: 2px solid ${mix(p.fg, p.bg, 0.14)};
      text-align: left;
    }
    .comp-col.right { border-color: ${p.accent}; background: ${mix(p.accent, p.bg, 0.12)}; }
    .comp-label {
      font-family: ${fam(t.display)}; font-size: ${Math.round(ts.subline)}px;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: ${p.muted}; margin-bottom: ${Math.round(18 * ctx.scale)}px;
    }
    .comp-col.right .comp-label { color: ${p.accent}; }
    .comp-col ul { list-style: none; }
    .comp-col li {
      font-family: ${fam(t.body)}; font-size: ${Math.round(ts.body)}px;
      color: ${p.fg}; margin-bottom: ${Math.round(12 * ctx.scale)}px; line-height: 1.2;
    }
    .comp-vs {
      align-self: center;
      font-family: ${fam(t.display)}; font-size: ${Math.round(ts.headline * 0.5)}px;
      color: ${readableOn(p.accent)};
      background: ${p.accent}; border-radius: 50%;
      width: ${Math.round(110 * ctx.scale)}px; height: ${Math.round(110 * ctx.scale)}px;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .stat-glow {
      position: absolute; top: 50%; left: 50%;
      width: ${Math.round(ctx.safe.w * 0.9)}px; height: ${Math.round(ctx.safe.w * 0.9)}px;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, ${p.accent}30 0%, transparent 62%);
      filter: blur(${Math.round(10 * ctx.scale)}px);
      pointer-events: none; opacity: 0;
    }
    .stat-value {
      font-family: ${fam(t.display)};
      font-size: ${ts.statValue}px; color: ${p.fg};
      line-height: 1; letter-spacing: -0.03em;
      background: linear-gradient(180deg, ${p.fg} 18%, ${mix(p.accent2, p.fg, 0.75)} 92%);
      -webkit-background-clip: text; background-clip: text;
      -webkit-text-fill-color: transparent;
      filter: drop-shadow(0 ${Math.round(10 * ctx.scale)}px ${Math.round(34 * ctx.scale)}px ${p.accent}40);
    }
    .stat-num { }
    .stat-label {
      font-family: ${fam(t.body)}; font-size: ${ts.statLabel}px;
      font-weight: 700; color: ${p.fg}; text-transform: uppercase; letter-spacing: 0.08em;
      overflow-wrap: break-word;
    }
    .stat-context { font-family: ${fam(t.body)}; font-size: ${Math.round(ts.body * 0.7)}px; color: ${p.muted}; max-width: 90%; line-height: 1.3; overflow-wrap: break-word; }
    .quote {
      font-family: ${fam(t.display)};
      font-size: ${ts.quote}px; color: ${p.fg};
      line-height: 1.12; font-style: italic;
      overflow-wrap: break-word;
    }
    .cta-pill {
      display: flex; align-items: center; gap: ${Math.round(18 * ctx.scale)}px;
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.cta * 0.42)}px;
      background: ${p.accent}; color: ${readableOn(p.accent)};
      padding: ${Math.round(22 * ctx.scale)}px ${Math.round(52 * ctx.scale)}px;
      border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em;
      box-shadow: 0 ${Math.round(14 * ctx.scale)}px ${Math.round(48 * ctx.scale)}px ${p.accent}66;
    }
    .cta-arrow { display: inline-block; }
    .canvas-host { position: absolute; inset: 0; }
    .canvas-host canvas { position: absolute; inset: 0; }
    .stage-glow {
      position: absolute; left: 50%; top: 64%;
      width: ${Math.round(ctx.width * 1.1)}px; height: ${Math.round(ctx.width * 1.1)}px;
      transform: translate(-50%, -50%);
      background: radial-gradient(circle, ${p.accent}26 0%, transparent 58%);
      filter: blur(${Math.round(18 * ctx.scale)}px); pointer-events: none;
    }
    .logo-overlay {
      position: relative; z-index: 2;
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.display * 0.9)}px; color: ${p.fg};
      letter-spacing: 0.06em; text-transform: uppercase;
      text-shadow: 0 0 ${Math.round(40 * ctx.scale)}px ${p.accent};
      overflow-wrap: break-word;
    }
    .kb-media {
      position: absolute; inset: 0;
      background: linear-gradient(135deg, ${p.surface}, ${p.bg} 60%, ${mix(p.accent, p.bg, 0.25)});
      background-size: cover; background-position: center;
    }
    .kb-scrim {
      position: absolute; inset: 0;
      background: linear-gradient(180deg, ${mix(p.bg, '#000000', 0.4)}66 0%, transparent 30%, transparent 52%, ${p.bg}E6 100%);
    }
    .caption-layer {
      position: absolute; left: ${ctx.safe.x}px; right: ${ctx.safe.x}px; z-index: 50;
      display: flex; justify-content: center; pointer-events: none;
    }
    /* the band sits clear of platform UI (TikTok rail etc.), never glued to the edge */
    .caption-bottom { bottom: ${ctx.captionBand.bottomPx}px; }
    .caption-center { top: 50%; transform: translateY(-50%); }
    .caption-top { top: ${Math.round(ctx.safe.y + ctx.safe.h * 0.02)}px; }
    .caption-bar {
      max-width: ${ctx.captionBand.maxWidthPx}px;
      font-family: ${fam(t.body)};
      font-size: ${ts.caption}px;
      font-weight: 800;
      line-height: 1.22;
      text-align: center;
      color: #ffffff;
      background: rgba(8, 8, 16, 0.62);
      backdrop-filter: blur(6px);
      padding: ${Math.round(12 * ctx.scale)}px ${Math.round(26 * ctx.scale)}px;
      border-radius: ${Math.round(14 * ctx.scale)}px;
      box-shadow: 0 ${Math.round(4 * ctx.scale)}px ${Math.round(22 * ctx.scale)}px rgba(0,0,0,0.35);
      overflow-wrap: break-word;
      ${captionUppercase ? 'text-transform: uppercase;' : ''}
      opacity: 0;
    }`
}

function fam(f: string): string {
  const primary = f.split(',')[0].trim()
  const generic = f.toLowerCase().includes('serif') && !f.toLowerCase().includes('sans') ? 'serif' : 'sans-serif'
  return `'${primary}', ${generic}`
}

function readableOn(hex: string): string {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  return luma > 150 ? '#0A0A12' : '#FFFFFF'
}

function mix(a: string, b: string, wa: number): string {
  const pa = a.replace('#', '')
  const pb = b.replace('#', '')
  const ch = (sa: string, sb: string) =>
    Math.round(parseInt(sa, 16) * wa + parseInt(sb, 16) * (1 - wa))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(pa.slice(0, 2), pb.slice(0, 2))}${ch(pa.slice(2, 4), pb.slice(2, 4))}${ch(pa.slice(4, 6), pb.slice(4, 6))}`
}

const INTERPRETER = `
  window.__timelines = window.__timelines || {};
  window.__sceneStart = __SCENE_START__;

  // ---------------- autofit: nothing may leave the safe area, ever ----------------
  // Runs once at load (fonts ready) BEFORE the timeline registers, so capture
  // can never race it. Measurement depends only on fonts + CSS + fixed viewport
  // → identical result on every render (determinism contract intact).
  function vgFitEl(el) {
    const maxW = parseFloat(el.dataset.maxw || '0');
    const maxH = parseFloat(el.dataset.maxh || '0');
    if (!maxW || !maxH) return;
    const mode = el.dataset.fit;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    for (let pass = 0; pass < 4; pass++) {
      let w = 1, h = 1;
      if (mode === 'lines') {
        const spans = el.querySelectorAll(':scope > .line');
        if (spans.length) {
          spans.forEach(function (s) { w = Math.max(w, s.getBoundingClientRect().width); });
        } else {
          w = el.scrollWidth;
        }
        h = el.offsetHeight;
      } else {
        w = el.scrollWidth; h = el.scrollHeight;
      }
      if (w <= maxW && h <= maxH) break;
      const k = Math.min(maxW / Math.max(w, 1), maxH / Math.max(h, 1)) * 0.985;
      fs = Math.max(16, Math.floor(fs * k));
      el.style.fontSize = fs + 'px';
    }
  }
  function vgFitGroups() {
    // a scene's combined text must fit its .safe column: measure children +
    // gaps exactly, then scale every fitted child proportionally if needed
    document.querySelectorAll('.safe').forEach(function (box) {
      const kids = Array.prototype.slice.call(box.children);
      const fitted = kids.filter(function (c) { return c.hasAttribute && c.hasAttribute('data-fit'); });
      if (!fitted.length) return;
      for (let pass = 0; pass < 3; pass++) {
        const gap = parseFloat(getComputedStyle(box).gap) || 0;
        let contentH = 0;
        let flowCount = 0;
        kids.forEach(function (c) {
          if (getComputedStyle(c).position === 'absolute') return; // dressing layers live outside the flow
          contentH += c.offsetHeight;
          flowCount += 1;
        });
        contentH += Math.max(0, flowCount - 1) * gap;
        if (contentH <= box.clientHeight + 2) break;
        const k = Math.max(0.5, (box.clientHeight / contentH) * 0.985);
        fitted.forEach(function (el) {
          const fs = parseFloat(getComputedStyle(el).fontSize);
          el.style.fontSize = Math.max(14, Math.floor(fs * k)) + 'px';
        });
      }
    });
  }
  function vgAutofit() {
    document.querySelectorAll('[data-fit]').forEach(vgFitEl);
    vgFitGroups();
  }

  // ---------------- timeline ----------------
  function vgBuildTimeline() {
    const tl = gsap.timeline({ paused: true });
    const counts = [];
    for (const s of __STEPS__) {
      if (s.kind === 'tween') {
        const vars = Object.assign({}, s.to, { duration: s.dur, ease: s.ease });
        if (s.stagger) vars.stagger = s.stagger;
        tl.fromTo(s.sel, s.from, vars, s.t);
      } else if (s.kind === 'set') {
        tl.set(s.sel, s.set, s.t);
      } else if (s.kind === 'count') {
        counts.push(s);
      }
    }
    // count-ups are seek-driven (gsap tween callbacks don't fire under seek)
    window.addEventListener('hf-seek', (e) => {
      const t = e.detail.time;
      for (const c of counts) {
        const el = document.querySelector(c.sel);
        if (!el) continue;
        const local = Math.min(Math.max(t - c.t, 0), c.dur);
        const eased = 1 - Math.pow(1 - local / c.dur, 2);
        const v = c.from + (c.to - c.from) * eased;
        el.textContent = Number.isInteger(c.to) ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1);
      }
    });
    tl.seek(0);
    window.__timelines['main'] = tl;
  }

  function vgBoot() { vgAutofit(); vgBuildTimeline(); }
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(vgBoot);
  } else {
    vgBoot();
  }
`

/** bump when presentation changes enough to re-compose old projects */
export const COMPOSER_VERSION = 4

function buildDocument(
  spec: VideoSpec,
  ctx: DesignContext,
  kit: StyleKit,
  sceneHTML: string[],
  steps: AnimStep[],
  threeScripts: string[],
  sceneStart: Record<string, number>,
  totalSec: number,
  audio?: AudioLayer
): string {
  const ts = typeScale(ctx)
  const capFit = fitAttrs(ctx.captionBand.maxWidthPx, Math.round(ts.caption * 1.22 * 2 + 24 * ctx.scale), 'box')
  const captionLayer =
    audio && audio.captions.length > 0
      ? `<div class="caption-layer caption-${spec.captionStyle.position}"><div class="caption-bar" id="caption-text" ${capFit}></div></div>`
      : ''
  const audioClips = (audio?.clips ?? [])
    .map(
      (c, i) =>
        `<audio id="audio-clip-${i + 1}" class="clip" src="${esc(c.file)}" data-start="${c.startSec}" data-duration="${c.durationSec.toFixed(
          2
        )}" data-track-index="${c.trackIndex}" data-volume="${c.volume}"></audio>`
    )
    .join('\n')
  const captionRegistry =
    audio && audio.captions.length > 0 ? JSON.stringify(audio.captions) : '[]'

  // on-screen text per scene window — captions repeating it are suppressed
  let cursor = 0
  const sceneTexts = spec.scenes.map((s) => {
    const w = { start: cursor, end: cursor + s.durationSec, text: '' }
    cursor = w.end
    const parts: string[] = []
    for (const k of ['kicker', 'headline', 'subline', 'text', 'label', 'logoText', 'action'] as const) {
      if (k in s) {
        const v = (s as unknown as Record<string, unknown>)[k]
        if (typeof v === 'string' && v) parts.push(v)
      }
    }
    if ('bullets' in s && Array.isArray((s as { bullets?: string[] }).bullets)) {
      parts.push(...((s as { bullets: string[] }).bullets))
    }
    w.text = parts.join(' ')
    return w
  })

  const style = [fontFaceCSS(spec), baseCSS(ctx, spec.captionStyle.uppercase), kit.atmosphereCSS(ctx)].join('\n')

  const interpreter = INTERPRETER.replace('__SCENE_START__', JSON.stringify(sceneStart)).replace(
    '__STEPS__',
    JSON.stringify(steps)
  )

  return `<!doctype html>
<!-- vg-compose:v${COMPOSER_VERSION} -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${ctx.width}, height=${ctx.height}" />
    <title>${esc(spec.title)}</title>
    <style>
${style}
    </style>
  </head>
  <body>
    <div
      id="root"
      class="clip"
      data-composition-id="main"
      data-start="0"
      data-duration="${totalSec}"
      data-width="${ctx.width}"
      data-height="${ctx.height}"
      data-fps="${spec.fps}"
    >
      <div class="atmo">${kit.atmosphere(ctx)}</div>
${sceneHTML.join('\n')}
${captionLayer}
${audioClips}
    </div>
    <script src="assets/vendor/gsap.min.js"></script>
    <script>
${interpreter}
    </script>
    <script>
      // seek-driven captions (never wall-clock); redundant ones are suppressed
      const CAPTIONS = ${captionRegistry};
      const CAP_SCENES = ${JSON.stringify(sceneTexts)};
      const capEl = document.getElementById('caption-text');
      function capWords(s) {
        return s.toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').split(/\\s+/).filter(function (w) { return w.length > 2; });
      }
      function capRedundant(cueText, sceneText) {
        const ref = new Set(capWords(sceneText));
        const words = capWords(cueText);
        if (!ref.size || !words.length) return false;
        let hit = 0;
        for (const w of words) if (ref.has(w)) hit += 1;
        return hit / words.length >= 0.6;
      }
      window.addEventListener('hf-seek', (e) => {
        if (!capEl) return;
        const t = e.detail.time;
        const cue = CAPTIONS.find((c) => t >= c.startSec && t < c.endSec);
        if (!cue) {
          capEl.textContent = '';
          capEl.style.opacity = '0';
          return;
        }
        const scene = CAP_SCENES.find((s) => t >= s.start && t < s.end);
        const dup = scene && capRedundant(cue.text, scene.text);
        capEl.textContent = cue.text;
        capEl.style.opacity = dup ? '0' : '1';
      });
    </script>
${threeScripts.join('\n')}
  </body>
</html>
`
}
