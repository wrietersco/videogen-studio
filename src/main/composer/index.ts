import type { VideoSpec, Scene } from '@shared/spec'
import { PLATFORM_PRESETS } from '@shared/presets'
import { designContext, type DesignContext, typeScale } from './layout'
import type { AnimStep } from './anim'
import { KITS, type StyleKit } from './kits'
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

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function compose(spec: VideoSpec, vendorDir: string, fontsDir: string): ComposeResult {
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

  const html = buildDocument(spec, ctx, kit, sceneHTML, steps, threeScripts, sceneStart, totalSec)
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
  font-weight: normal;
  font-display: block;
}`
    )
    .join('\n')
}

function baseCSS(ctx: DesignContext): string {
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
    .display, .headline {
      font-family: ${fam(t.display)};
      font-weight: 900;
      ${caps}
      color: ${p.fg};
      line-height: 0.98;
      letter-spacing: -0.02em;
      max-width: 100%;
    }
    .headline.overlay, .display.overlay, .subline.overlay {
      position: relative; z-index: 2;
    }
    .headline.overlay { font-size: ${Math.round(ts.headline * 0.62)}px; }
    .display.overlay { font-size: ${Math.round(ts.display * 0.72)}px; }
    .subline.overlay { font-size: ${Math.round(ts.subline * 0.9)}px; }
    .headline.sm { font-size: ${Math.round(ts.headline * 0.72)}px; }
    .line { display: block; }
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
    }
    .subline {
      font-family: ${fam(t.body)};
      font-size: ${ts.subline}px;
      font-weight: 500;
      color: ${mix(p.fg, p.bg, 0.82)};
      line-height: 1.25;
      max-width: 92%;
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
    .bullets { list-style: none; text-align: left; width: 100%; }
    .bullets li {
      display: flex; align-items: baseline; gap: ${Math.round(24 * ctx.scale)}px;
      margin-bottom: ${Math.round(26 * ctx.scale)}px;
    }
    .bullets .idx {
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.bullet * 0.8)}px;
      color: ${p.accent2}; opacity: 0.9; min-width: 1.6em;
    }
    .bullets .bl {
      font-family: ${fam(t.body)};
      font-size: ${ts.bullet}px; font-weight: 600; color: ${p.fg};
      line-height: 1.15;
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
    .stat-value {
      font-family: ${fam(t.display)};
      font-size: ${ts.statValue}px; color: ${p.fg};
      line-height: 1; letter-spacing: -0.03em;
    }
    .stat-num { color: ${p.accent2}; }
    .stat-label {
      font-family: ${fam(t.body)}; font-size: ${ts.statLabel}px;
      font-weight: 700; color: ${p.fg}; text-transform: uppercase; letter-spacing: 0.08em;
    }
    .stat-context { font-family: ${fam(t.body)}; font-size: ${Math.round(ts.body * 0.7)}px; color: ${p.muted}; max-width: 90%; line-height: 1.3; }
    .quote {
      font-family: ${fam(t.display)};
      font-size: ${ts.quote}px; color: ${p.fg};
      line-height: 1.12; font-style: italic;
    }
    .cta-pill {
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.cta * 0.42)}px;
      background: ${p.accent}; color: ${readableOn(p.accent)};
      padding: ${Math.round(22 * ctx.scale)}px ${Math.round(52 * ctx.scale)}px;
      border-radius: 999px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .canvas-host { position: absolute; inset: 0; }
    .canvas-host canvas { position: absolute; inset: 0; }
    .logo-overlay {
      position: relative; z-index: 2;
      font-family: ${fam(t.display)};
      font-size: ${Math.round(ts.display * 0.9)}px; color: ${p.fg};
      letter-spacing: 0.06em; text-transform: uppercase;
      text-shadow: 0 0 ${Math.round(40 * ctx.scale)}px ${p.accent};
    }
    .kb-media {
      position: absolute; inset: 0;
      background: linear-gradient(135deg, ${p.surface}, ${p.bg} 60%, ${mix(p.accent, p.bg, 0.25)});
      background-size: cover; background-position: center;
    }
    .kb-scrim {
      position: absolute; inset: 0;
      background: linear-gradient(180deg, transparent 40%, ${p.bg}E6 100%);
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
`

function buildDocument(
  spec: VideoSpec,
  ctx: DesignContext,
  kit: StyleKit,
  sceneHTML: string[],
  steps: AnimStep[],
  threeScripts: string[],
  sceneStart: Record<string, number>,
  totalSec: number
): string {
  const style = [fontFaceCSS(spec), baseCSS(ctx), kit.atmosphereCSS(ctx)].join('\n')

  const interpreter = INTERPRETER.replace('__SCENE_START__', JSON.stringify(sceneStart)).replace(
    '__STEPS__',
    JSON.stringify(steps)
  )

  return `<!doctype html>
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
    </div>
    <script src="assets/vendor/gsap.min.js"></script>
    <script>
${interpreter}
    </script>
${threeScripts.join('\n')}
  </body>
</html>
`
}
