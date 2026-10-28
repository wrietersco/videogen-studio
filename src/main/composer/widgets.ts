import type { Widget } from '@shared/spec'
import type { AnimStep } from './anim'

/**
 * Widget library — premium, parametric diagram pieces for directed scenes.
 * The scene director only picks a widget and fills its data (small models
 * do this well); every pixel of craft lives here.
 *
 * Each widget is authored at a fixed design size (dw × dh px) and scaled
 * into its layout box by the crafted-scene composer, so one design serves
 * 9:16, 4:5 and 16:9. All motion is declarative AnimSteps → seekable GSAP.
 */

export interface WidgetTheme {
  ink: string
  mute: string
  hair: string
  accent: string
  accent2: string
  display: string
  mono: string
  serif: string
  /** documentary look = condensed caps display face */
  doc: boolean
}

export interface BuiltWidget {
  html: string
  steps: AnimStep[]
  dw: number
  dh: number
  /** compact widgets sit in the low band; large ones own the middle of the frame */
  compact: boolean
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** deterministic PRNG seeded from a string (same widget → same waveform) */
export function seeded(key: string): () => number {
  let a = 2166136261
  for (let i = 0; i < key.length; i++) a = Math.imul(a ^ key.charCodeAt(i), 16777619)
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function fmt(v: number, max: number): string {
  if (!Number.isInteger(v)) return v.toFixed(1)
  return max >= 1000 ? v.toLocaleString('en-US') : String(v)
}

function countFormat(to: number): 'thousands' | 'plain' {
  return Math.abs(to) >= 1000 && Number.isInteger(to) ? 'thousands' : 'plain'
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}

const p2 = (n: number): string => n.toFixed(1)

/** shared design-space CSS for widgets (class names are scoped by .cw-*) */
export function widgetCSS(th: WidgetTheme): string {
  return `
    .cr-wbox { position: absolute; transform-origin: 0 0; }
    .cr-wbox svg { position: absolute; left: 0; top: 0; overflow: visible; }
    .cw-mono { font-family: ${th.mono}; font-weight: 500; text-transform: uppercase; letter-spacing: 0.16em; color: ${th.mute}; white-space: nowrap; }
    .cw-num { font-family: ${th.doc ? th.display : "'Inter', sans-serif"}; font-weight: 800; color: ${th.ink}; letter-spacing: ${th.doc ? '0' : '-0.045em'}; line-height: 1; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cw-num small { font-size: 0.42em; letter-spacing: -0.01em; margin-left: 0.06em; opacity: 0.85; }
    .cw-abs { position: absolute; }
    .cw-center { position: absolute; left: 0; right: 0; text-align: center; }
    .cw-card { position: absolute; border-radius: 22px; border: 1.5px solid ${th.hair}; background: rgba(255,255,255,0.035); }
    .cw-chip { display: inline-flex; align-items: center; gap: 12px; }
    .cw-chip i { width: 14px; height: 14px; border-radius: 50%; display: inline-block; }
    .cw-txt { font-family: 'Inter', sans-serif; font-weight: 600; color: ${th.ink}; letter-spacing: -0.01em; }`
}

export function buildWidget(w: Widget, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget | null {
  switch (w.type) {
    case 'ringGauge':
      return ringGauge(w, id, th, t0, avail)
    case 'counter':
      return counter(w, id, th, t0, avail)
    case 'bars':
      return bars(w, id, th, t0)
    case 'toggle':
      return toggle(w, id, th, t0, avail)
    case 'timeline':
      return timeline(w, id, th, t0, avail)
    case 'quoteCard':
      return quoteCard(w, id, th, t0)
    case 'statPair':
      return statPair(w, id, th, t0)
    case 'slots':
      return slots(w, id, th, t0, avail)
    case 'distanceBar':
      return distanceBar(w, id, th, t0, avail)
    case 'waveform':
      return waveform(w, id, th, t0, avail)
    case 'annotation':
      return null // drawn on the plate overlay by the scene composer
  }
}

// ---------------------------------------------------------------- ring gauge

function ringGauge(w: Extract<Widget, { type: 'ringGauge' }>, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget {
  const C1 = 2 * Math.PI * 430
  const C2 = 2 * Math.PI * 402
  const ticks: string[] = []
  for (let i = 0; i < 60; i++) {
    const [x1, y1] = polar(500, 500, 452, i * 6)
    const [x2, y2] = polar(500, 500, i % 5 === 0 ? 474 : 462, i * 6)
    ticks.push(`<line x1="${p2(x1)}" y1="${p2(y1)}" x2="${p2(x2)}" y2="${p2(y2)}" />`)
  }
  const hasAfter = typeof w.after === 'number'
  const html = `
    <svg width="1000" height="1000" viewBox="0 0 1000 1000">
      <defs><filter id="${id}-gl" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <radialGradient id="${id}-disc" cx="50%" cy="50%" r="50%"><stop offset="0.55" stop-color="#141A30" stop-opacity="0.9"/><stop offset="1" stop-color="#1F2645" stop-opacity="0.9"/></radialGradient></defs>
      <g id="${id}-ticks" stroke="${th.hair}" stroke-width="2">${ticks.join('')}</g>
      <circle cx="500" cy="500" r="430" fill="none" stroke="${th.hair}" stroke-width="14" opacity="0.6" />
      <circle id="${id}-disc" cx="500" cy="500" r="330" fill="url(#${id}-disc)" stroke="${th.hair}" stroke-width="2.5" />
      <circle id="${id}-arc" cx="500" cy="500" r="430" fill="none" stroke="${th.accent}" stroke-width="14" stroke-linecap="round" transform="rotate(-90 500 500)" stroke-dasharray="${p2(C1)}" stroke-dashoffset="${p2(C1)}" filter="url(#${id}-gl)" />
      ${hasAfter ? `<circle id="${id}-arc2" cx="500" cy="500" r="402" fill="none" stroke="${th.accent2}" stroke-width="6" stroke-linecap="round" transform="rotate(-90 500 500)" stroke-dasharray="${p2(C2)}" stroke-dashoffset="${p2(C2)}" opacity="0" />` : ''}
    </svg>
    <div class="cw-center cw-mono" style="top:360px;font-size:24px">${esc(w.label)}</div>
    <div class="cw-center cw-num" id="${id}-numwrap" style="top:410px;font-size:190px;color:${th.accent}"><span id="${id}-num">0</span><small>%</small></div>
    ${hasAfter && w.afterLabel ? `<div class="cw-center cw-mono" id="${id}-after" style="top:620px;font-size:22px;color:${th.accent2}">${esc(w.afterLabel)}</div>` : ''}`
  const steps: AnimStep[] = [
    { kind: 'tween', t: t0, sel: `#${id}-disc`, from: { scale: 0.7, autoAlpha: 0, svgOrigin: '500 500' }, to: { scale: 1, autoAlpha: 1, svgOrigin: '500 500' }, dur: 0.8, ease: 'expo.out' },
    { kind: 'tween', t: t0 + 0.1, sel: `#${id}-ticks`, from: { autoAlpha: 0 }, to: { autoAlpha: 1 }, dur: 0.6, ease: 'power1.out' },
    { kind: 'tween', t: t0 + 0.3, sel: `#${id}-arc`, from: { strokeDashoffset: C1 }, to: { strokeDashoffset: C1 * (1 - w.value / 100) }, dur: 1.5, ease: 'power3.out' },
    { kind: 'count', t: t0 + 0.3, sel: `#${id}-num`, from: 0, to: Math.round(w.value), dur: 1.5 }
  ]
  if (hasAfter) {
    const ta = t0 + Math.max(2.0, avail * 0.5)
    const after = w.after as number
    steps.push(
      { kind: 'count', t: ta, sel: `#${id}-num`, from: Math.round(w.value), to: Math.round(after), dur: 1.2 },
      { kind: 'tween', t: ta, sel: `#${id}-arc2`, from: { strokeDashoffset: C2, opacity: 0 }, to: { strokeDashoffset: C2 * (1 - after / 100), opacity: 1 }, dur: 1.2, ease: 'power2.out' },
      { kind: 'tween', t: ta + 0.1, sel: `#${id}-arc`, from: { opacity: 1 }, to: { opacity: 0.4, immediateRender: false }, dur: 0.6, ease: 'power1.out' },
      { kind: 'set', t: ta + 0.05, sel: `#${id}-numwrap`, set: { color: th.accent2 } }
    )
    if (w.afterLabel) steps.push({ kind: 'tween', t: ta + 0.6, sel: `#${id}-after`, from: { autoAlpha: 0, y: 14 }, to: { autoAlpha: 1, y: 0 }, dur: 0.5, ease: 'power2.out' })
  }
  return { html, steps, dw: 1000, dh: 1000, compact: false }
}

// ---------------------------------------------------------------- counter

function counter(w: Extract<Widget, { type: 'counter' }>, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget {
  const shown = `${w.prefix}${fmt(w.to, Math.abs(w.to))}${w.unit}`
  const fs = Math.round(Math.min(230, (1000 * 0.92) / Math.max(1, shown.length * (th.doc ? 0.46 : 0.6))))
  const html = `
    <div class="cw-center cw-mono" id="${id}-lab" style="top:0;font-size:26px">${esc(w.label)}</div>
    <div class="cw-center cw-num" style="top:70px;font-size:${fs}px">${esc(w.prefix)}<span id="${id}-num">${fmt(w.from, Math.abs(w.to))}</span>${w.unit ? `<small style="color:${th.accent}">${esc(w.unit)}</small>` : ''}</div>
    <div class="cw-abs" id="${id}-bar" style="left:330px;width:340px;top:${90 + fs}px;height:8px;border-radius:8px;background:${th.accent};transform-origin:left center;box-shadow:0 0 18px ${th.accent}88"></div>`
  return {
    html,
    steps: [
      { kind: 'tween', t: t0, sel: `#${id}-lab`, from: { autoAlpha: 0, y: 12 }, to: { autoAlpha: 1, y: 0 }, dur: 0.5, ease: 'power2.out' },
      { kind: 'count', t: t0 + 0.2, sel: `#${id}-num`, from: w.from, to: w.to, dur: Math.min(2.2, Math.max(1.2, avail * 0.45)), format: countFormat(w.to) },
      { kind: 'tween', t: t0 + 0.3, sel: `#${id}-bar`, from: { scaleX: 0 }, to: { scaleX: 1 }, dur: 1.2, ease: 'power3.out' }
    ],
    dw: 1000,
    dh: 120 + fs,
    compact: true
  }
}

// ---------------------------------------------------------------- bars

function bars(w: Extract<Widget, { type: 'bars' }>, id: string, th: WidgetTheme, t0: number): BuiltWidget {
  const max = Math.max(...w.items.map((i) => Math.abs(i.value)), 1)
  const top = 80
  const rows = w.items
    .map((it, i) => {
      const y = top + i * 130
      const frac = Math.max(0.02, Math.abs(it.value) / max)
      const color = i === 0 ? th.accent : i === 1 ? th.accent2 : th.ink
      return `
      <div class="cw-abs cw-mono" style="left:0;top:${y + 22}px;width:250px;font-size:24px;overflow:hidden;text-overflow:ellipsis">${esc(it.label)}</div>
      <div class="cw-abs" style="left:270px;top:${y + 30}px;width:560px;height:28px;border-radius:14px;background:${th.hair}"></div>
      <div class="cw-abs ${id}-fill" style="left:270px;top:${y + 30}px;width:${Math.round(560 * frac)}px;height:28px;border-radius:14px;background:${color};transform-origin:left center;box-shadow:0 0 18px ${color}66"></div>
      <div class="cw-abs cw-num" style="left:850px;top:${y + 10}px;font-size:54px;width:150px;text-align:right"><span id="${id}-v${i}">0</span>${w.unit ? `<small>${esc(w.unit)}</small>` : ''}</div>`
    })
    .join('')
  const steps: AnimStep[] = [
    { kind: 'tween', t: t0, sel: `#${id}-lab`, from: { autoAlpha: 0, y: 12 }, to: { autoAlpha: 1, y: 0 }, dur: 0.5, ease: 'power2.out' },
    { kind: 'tween', t: t0 + 0.2, sel: `#${id} .${id}-fill`, from: { scaleX: 0 }, to: { scaleX: 1 }, dur: 1.1, ease: 'power3.out', stagger: 0.18 }
  ]
  w.items.forEach((it, i) => steps.push({ kind: 'count', t: t0 + 0.2 + i * 0.18, sel: `#${id}-v${i}`, from: 0, to: it.value, dur: 1.1, format: countFormat(it.value) }))
  return {
    html: `<div class="cw-abs cw-mono" id="${id}-lab" style="left:0;top:0;font-size:26px">${esc(w.label)}</div>${rows}`,
    steps,
    dw: 1000,
    dh: top + w.items.length * 130,
    compact: w.items.length <= 2
  }
}

// ---------------------------------------------------------------- toggle

function toggle(w: Extract<Widget, { type: 'toggle' }>, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget {
  const tf = t0 + Math.max(1.0, avail * 0.38)
  const html = `
    ${w.label ? `<div class="cw-center cw-mono" id="${id}-lab" style="top:0;font-size:26px">${esc(w.label)}</div>` : ''}
    <div class="cw-abs" id="${id}-track" style="left:230px;top:80px;width:540px;height:220px;border-radius:110px;background:rgba(255,255,255,0.06);border:2px solid ${th.hair}"></div>
    <div class="cw-abs" id="${id}-fill" style="left:230px;top:80px;width:540px;height:220px;border-radius:110px;background:linear-gradient(90deg, ${th.accent}, ${th.accent2});opacity:0;box-shadow:0 0 50px ${th.accent}66"></div>
    <div class="cw-abs" id="${id}-knob" style="left:250px;top:100px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle at 35% 30%, #ffffff, #d9dce6 60%, #a9aec0);box-shadow:0 10px 30px rgba(0,0,0,0.45)"></div>
    <div class="cw-abs cw-txt" id="${id}-from" style="left:0;width:440px;top:340px;text-align:center;font-size:46px;font-weight:700">${esc(w.from)}</div>
    <div class="cw-abs cw-txt" id="${id}-to" style="left:560px;width:440px;top:340px;text-align:center;font-size:46px;font-weight:700;color:${th.accent};opacity:0.3">${esc(w.to)}</div>`
  const steps: AnimStep[] = [
    { kind: 'tween', t: t0, sel: `#${id}-track`, from: { autoAlpha: 0, scale: 0.9 }, to: { autoAlpha: 1, scale: 1 }, dur: 0.5, ease: 'back.out(2)' },
    { kind: 'tween', t: t0 + 0.1, sel: `#${id}-knob`, from: { autoAlpha: 0, scale: 0.6 }, to: { autoAlpha: 1, scale: 1 }, dur: 0.5, ease: 'back.out(2.5)' },
    { kind: 'tween', t: t0 + 0.2, sel: `#${id}-from`, from: { autoAlpha: 0, y: 14 }, to: { autoAlpha: 1, y: 0 }, dur: 0.4, ease: 'power2.out' },
    { kind: 'tween', t: tf, sel: `#${id}-knob`, from: { x: 0 }, to: { x: 320, immediateRender: false }, dur: 0.55, ease: 'back.inOut(1.6)' },
    { kind: 'tween', t: tf, sel: `#${id}-fill`, from: { opacity: 0 }, to: { opacity: 1 }, dur: 0.45, ease: 'power2.out' },
    { kind: 'tween', t: tf + 0.15, sel: `#${id}-from`, from: { opacity: 1 }, to: { opacity: 0.3, immediateRender: false }, dur: 0.4, ease: 'power1.out' },
    { kind: 'tween', t: tf + 0.15, sel: `#${id}-to`, from: { opacity: 0.3, scale: 0.92 }, to: { opacity: 1, scale: 1 }, dur: 0.45, ease: 'back.out(2)' }
  ]
  if (w.label) steps.push({ kind: 'tween', t: t0, sel: `#${id}-lab`, from: { autoAlpha: 0 }, to: { autoAlpha: 1 }, dur: 0.4, ease: 'power1.out' })
  return { html, steps, dw: 1000, dh: 420, compact: true }
}

// ---------------------------------------------------------------- timeline

function timeline(w: Extract<Widget, { type: 'timeline' }>, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget {
  const step = 170
  const h = w.items.length * step
  const items = w.items
    .map(
      (it, i) => `
      <div class="cw-abs ${id}-it" style="left:0;top:${i * step}px;width:1000px;height:${step}px">
        <div class="cw-abs" style="left:44px;top:14px;width:32px;height:32px;border-radius:50%;background:${th.accent};box-shadow:0 0 22px ${th.accent}"></div>
        <div class="cw-abs cw-mono" style="left:120px;top:12px;font-size:26px;color:${th.accent}">${esc(it.label)}</div>
        <div class="cw-abs cw-txt" style="left:120px;top:56px;width:870px;font-size:46px;line-height:1.12;overflow:hidden;max-height:${step - 60}px">${esc(it.text)}</div>
      </div>`
    )
    .join('')
  const per = Math.min(0.55, Math.max(0.25, (avail - 1) / w.items.length))
  return {
    html: `<div class="cw-abs" id="${id}-spine" style="left:58px;top:30px;width:4px;height:${h - step + 10}px;background:${th.hair};transform-origin:top center"></div>${items}`,
    steps: [
      { kind: 'tween', t: t0, sel: `#${id}-spine`, from: { scaleY: 0 }, to: { scaleY: 1 }, dur: per * w.items.length, ease: 'none' },
      { kind: 'tween', t: t0, sel: `#${id} .${id}-it`, from: { autoAlpha: 0, x: -30 }, to: { autoAlpha: 1, x: 0 }, dur: 0.5, ease: 'power3.out', stagger: per }
    ],
    dw: 1000,
    dh: h,
    compact: false
  }
}

// ---------------------------------------------------------------- quote card

function quoteCard(w: Extract<Widget, { type: 'quoteCard' }>, id: string, th: WidgetTheme, t0: number): BuiltWidget {
  const fs = w.text.length > 130 ? 44 : w.text.length > 80 ? 52 : 60
  const html = `
    <div class="cw-abs" id="${id}-card" style="left:20px;top:20px;width:960px;height:520px;border-radius:20px;background:#F3EEE3;box-shadow:0 30px 80px rgba(0,0,0,0.5);padding:56px 60px;display:flex;flex-direction:column;justify-content:space-between">
      <div style="font-family:${th.serif};font-style:italic;font-size:${fs}px;line-height:1.18;color:#1B1A17;overflow:hidden">“${esc(w.text)}”</div>
      ${w.attribution ? `<div style="font-family:${th.mono};font-size:22px;letter-spacing:0.08em;color:#5d574c;text-align:right">— ${esc(w.attribution)}</div>` : ''}
    </div>`
  return {
    html,
    steps: [{ kind: 'tween', t: t0, sel: `#${id}-card`, from: { autoAlpha: 0, y: 60, rotation: -2.5 }, to: { autoAlpha: 1, y: 0, rotation: -1 }, dur: 0.8, ease: 'expo.out' }],
    dw: 1000,
    dh: 560,
    compact: false
  }
}

// ---------------------------------------------------------------- stat pair

function statPair(w: Extract<Widget, { type: 'statPair' }>, id: string, th: WidgetTheme, t0: number): BuiltWidget {
  const card = (k: 'a' | 'b', x: number, color: string) => {
    const d = w[k]
    const fs = Math.min(140, Math.round(400 / Math.max(1, d.value.length * 0.58)))
    return `<div class="cw-card ${id}-c" style="left:${x}px;top:0;width:470px;height:380px">
      <div class="cw-abs cw-mono cw-chip" style="left:36px;top:36px;font-size:24px"><i style="background:${color};box-shadow:0 0 12px ${color}"></i>${esc(d.label)}</div>
      <div class="cw-abs cw-num" style="left:36px;bottom:40px;font-size:${fs}px;color:${color}">${esc(d.value)}</div>
    </div>`
  }
  return {
    html: card('a', 0, th.accent) + card('b', 530, th.accent2),
    steps: [{ kind: 'tween', t: t0, sel: `#${id} .${id}-c`, from: { autoAlpha: 0, y: 40 }, to: { autoAlpha: 1, y: 0 }, dur: 0.6, ease: 'power3.out', stagger: 0.18 }],
    dw: 1000,
    dh: 380,
    compact: true
  }
}

// ---------------------------------------------------------------- slots (receptor metaphor)

function slots(w: Extract<Widget, { type: 'slots' }>, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget {
  const total = w.total
  const filled = Math.min(w.filled, total)
  const blocked = Math.min(w.blocked, filled)
  const angles = Array.from({ length: total }, (_, k) => -90 + (k * 360) / total)
  // spread blockers evenly across the filled sockets
  const blockSet = new Set<number>()
  for (let j = 0; j < blocked; j++) blockSet.add(Math.floor((j * filled) / blocked))
  const before = Math.round((filled / total) * 100)
  const after = Math.round(((filled - blocked) / total) * 100)

  const sockets = angles
    .map((a) => {
      const s1 = polar(500, 500, 296, a - 8)
      const s2 = polar(500, 500, 338, a - 8)
      const s3 = polar(500, 500, 338, a + 8)
      const s4 = polar(500, 500, 296, a + 8)
      return `<path class="${id}-sock" d="M${p2(s2[0])} ${p2(s2[1])} L${p2(s1[0])} ${p2(s1[1])} A296 296 0 0 1 ${p2(s4[0])} ${p2(s4[1])} L${p2(s3[0])} ${p2(s3[1])}" />`
    })
    .join('')
  const orbs = angles
    .slice(0, filled)
    .map((_, k) => `<g id="${id}-o${k}"><circle r="38" fill="url(#${id}-og)" filter="url(#${id}-gl)" /></g>`)
    .join('')
  const pills = [...blockSet]
    .map((k) => `<g id="${id}-p${k}"><rect x="-44" y="-21" width="88" height="42" rx="21" fill="url(#${id}-pg)" filter="url(#${id}-gl)" /><rect x="-2" y="-21" width="4" height="42" fill="rgba(9,13,24,0.35)" /></g>`)
    .join('')
  const legend =
    w.fillLabel || w.blockLabel
      ? `<div class="cw-center cw-mono" id="${id}-leg" style="top:-70px;font-size:22px;display:flex;justify-content:center;gap:40px">
          ${w.fillLabel ? `<span class="cw-chip"><i style="background:${th.accent};box-shadow:0 0 12px ${th.accent}"></i>${esc(w.fillLabel)}</span>` : ''}
          ${w.blockLabel && blocked ? `<span class="cw-chip"><i style="background:${th.accent2};box-shadow:0 0 12px ${th.accent2}"></i>${esc(w.blockLabel)}</span>` : ''}
        </div>`
      : ''
  const html = `
    ${legend}
    <svg width="1000" height="1000" viewBox="0 0 1000 1000">
      <defs>
        <radialGradient id="${id}-og" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="0.45" stop-color="${th.accent}"/><stop offset="1" stop-color="${th.accent}" stop-opacity="0.55"/></radialGradient>
        <linearGradient id="${id}-pg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.85"/><stop offset="0.5" stop-color="${th.accent2}"/><stop offset="1" stop-color="${th.accent2}" stop-opacity="0.6"/></linearGradient>
        <radialGradient id="${id}-cg" cx="50%" cy="50%" r="50%"><stop offset="0.55" stop-color="#141A30"/><stop offset="1" stop-color="#1F2645"/></radialGradient>
        <filter id="${id}-gl" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <circle id="${id}-cell" cx="500" cy="500" r="300" fill="url(#${id}-cg)" stroke="${th.hair}" stroke-width="2.5" />
      <g id="${id}-socks" fill="none" stroke="${th.mute}" stroke-width="4" stroke-linecap="round">${sockets}</g>
      <g>${orbs}</g><g>${pills}</g>
    </svg>
    <div class="cw-center cw-mono" style="top:395px;font-size:20px">${esc(w.label)}</div>
    <div class="cw-center cw-num" id="${id}-numwrap" style="top:432px;font-size:150px;color:${th.accent}"><span id="${id}-num">0</span><small>%</small></div>`

  const steps: AnimStep[] = [
    { kind: 'tween', t: t0, sel: `#${id}-cell`, from: { scale: 0.6, autoAlpha: 0, svgOrigin: '500 500' }, to: { scale: 1, autoAlpha: 1, svgOrigin: '500 500' }, dur: 0.9, ease: 'expo.out' },
    { kind: 'tween', t: t0 + 0.3, sel: `#${id}-socks`, from: { autoAlpha: 0, scale: 0.6, svgOrigin: '500 500' }, to: { autoAlpha: 1, scale: 1, svgOrigin: '500 500' }, dur: 0.6, ease: 'back.out(2)' }
  ]
  if (legend) steps.push({ kind: 'tween', t: t0, sel: `#${id}-leg`, from: { autoAlpha: 0, y: -10 }, to: { autoAlpha: 1, y: 0 }, dur: 0.5, ease: 'power2.out' })
  const tDock = t0 + 0.8
  angles.slice(0, filled).forEach((a, k) => {
    const from = polar(500, 500, 760, a + 24)
    const dock = polar(500, 500, 342, a)
    steps.push({ kind: 'tween', t: tDock + k * 0.1, sel: `#${id}-o${k}`, from: { x: from[0], y: from[1], scale: 0.4, autoAlpha: 0 }, to: { x: dock[0], y: dock[1], scale: 1, autoAlpha: 1 }, dur: 0.9, ease: 'power3.out' })
  })
  steps.push({ kind: 'count', t: tDock + 0.2, sel: `#${id}-num`, from: 0, to: before, dur: 1.4 })
  if (blocked > 0) {
    const tBlock = t0 + Math.max(2.4, avail * 0.45)
    ;[...blockSet].forEach((k, j) => {
      const a = angles[k]
      const from = polar(500, 500, 820, a - 30)
      const dock = polar(500, 500, 342, a)
      const out = polar(500, 500, 540, a + 10)
      const t = tBlock + j * 0.16
      steps.push(
        { kind: 'tween', t, sel: `#${id}-p${k}`, from: { x: from[0], y: from[1], rotation: a + 40, autoAlpha: 0 }, to: { x: dock[0], y: dock[1], rotation: a + 90, autoAlpha: 1 }, dur: 0.7, ease: 'power3.out' },
        { kind: 'tween', t: t + 0.45, sel: `#${id}-o${k}`, from: { x: dock[0], y: dock[1], autoAlpha: 1, scale: 1 }, to: { x: out[0], y: out[1], autoAlpha: 0.22, scale: 0.75, immediateRender: false }, dur: 0.9, ease: 'power2.out' }
      )
    })
    steps.push(
      { kind: 'count', t: tBlock + 0.3, sel: `#${id}-num`, from: before, to: after, dur: 1.3 },
      { kind: 'set', t: tBlock + 0.35, sel: `#${id}-numwrap`, set: { color: th.accent2 } }
    )
  }
  return { html, steps, dw: 1000, dh: 1000, compact: false }
}

// ---------------------------------------------------------------- distance bar

function distanceBar(w: Extract<Widget, { type: 'distanceBar' }>, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget {
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const v = Math.round(w.max * f)
      const x = Math.round(f * 996)
      const align = f === 0 ? 'none' : f === 1 ? 'translateX(-100%)' : 'translateX(-50%)'
      return `<i class="cw-abs" style="left:${x}px;top:118px;width:2px;height:14px;background:${th.hair}"></i><span class="cw-abs cw-mono" style="left:${x}px;top:142px;font-size:18px;transform:${align}">${fmt(v, w.max)}</span>`
    })
    .join('')
  const html = `
    <div class="cw-abs cw-mono" style="left:0;top:22px;font-size:24px">${esc(w.label)}</div>
    <div class="cw-abs cw-num" style="right:0;top:0;font-size:76px"><span id="${id}-num">0</span>${w.unit ? `<small style="font-family:${th.mono};font-size:22px;letter-spacing:0.14em;color:${th.accent};margin-left:12px">${esc(w.unit.toUpperCase())}</small>` : ''}</div>
    <div class="cw-abs" style="left:0;right:0;top:104px;height:2px;background:${th.hair}"></div>
    <div class="cw-abs" id="${id}-fill" style="left:0;width:1000px;top:102px;height:6px;background:${th.accent};transform-origin:left center;box-shadow:0 0 18px ${th.accent}"></div>
    ${ticks}`
  const d = Math.min(2.6, Math.max(1.2, avail * 0.5))
  return {
    html,
    steps: [
      { kind: 'tween', t: t0, sel: `#${id}`, from: { autoAlpha: 0, y: 24 }, to: { autoAlpha: 1, y: 0 }, dur: 0.6, ease: 'power2.out' },
      { kind: 'tween', t: t0 + 0.3, sel: `#${id}-fill`, from: { scaleX: 0 }, to: { scaleX: 1 }, dur: d, ease: 'power3.out' },
      { kind: 'count', t: t0 + 0.3, sel: `#${id}-num`, from: 0, to: w.max, dur: d, format: countFormat(w.max) }
    ],
    dw: 1000,
    dh: 180,
    compact: true
  }
}

// ---------------------------------------------------------------- waveform

function waveform(w: Extract<Widget, { type: 'waveform' }>, id: string, th: WidgetTheme, t0: number, avail: number): BuiltWidget {
  const rnd = seeded(id)
  const pts: Array<[number, number]> = []
  for (let x = 0; x <= 1000; x += 6) {
    const near = Math.exp(-Math.pow((x - 520) / 64, 2))
    pts.push([x, 120 + (rnd() - 0.5) * 2 * (5 + near * 100)])
  }
  const path = (list: Array<[number, number]>) => 'M' + list.map((p) => `${p2(p[0])} ${p2(p[1])}`).join(' L')
  const hot = pts.filter((p) => p[0] > 420 && p[0] < 620)
  const html = `
    ${w.label ? `<div class="cw-abs cw-mono" style="left:0;top:0;font-size:22px">${esc(w.label)}</div>` : ''}
    <svg width="1000" height="240" viewBox="0 0 1000 240">
      <defs><filter id="${id}-gl" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      <path id="${id}-line" d="${path(pts)}" fill="none" stroke="${th.ink}" stroke-width="2.5" stroke-linejoin="round" stroke-dasharray="5000" stroke-dashoffset="5000" />
      <path id="${id}-hot" d="${path(hot)}" fill="none" stroke="${th.accent}" stroke-width="3.5" stroke-linejoin="round" filter="url(#${id}-gl)" opacity="0" />
    </svg>`
  const d = Math.min(3.2, Math.max(1.4, avail * 0.7))
  return {
    html,
    steps: [
      { kind: 'tween', t: t0, sel: `#${id}-line`, from: { strokeDashoffset: 5000 }, to: { strokeDashoffset: 0 }, dur: d, ease: 'none' },
      { kind: 'tween', t: t0 + d * 0.55, sel: `#${id}-hot`, from: { opacity: 0 }, to: { opacity: 1 }, dur: 0.3, ease: 'power1.out' }
    ],
    dw: 1000,
    dh: 240,
    compact: true
  }
}
