import type { BgStyle } from '@shared/spec'
import type { DesignContext } from './layout'

/**
 * Procedural background art for scenes with nothing behind them. Everything
 * is static vector (no filters, no motion), so it costs almost nothing to
 * render, and every shape is a pure function of the seed: the same film
 * always draws the same art.
 */

export interface BgTheme {
  accent: string
  accent2: string
  ink: string
}

const f = (n: number): string => n.toFixed(1)
/** art is texture, but it must be seen on a phone: lift every opacity */
const o = (x: number): string => Math.min(0.7, x * 2.2).toFixed(2)

export function bgArt(style: BgStyle, ctx: DesignContext, th: BgTheme, seed: number): string {
  if (style === 'grid') return ''
  const W = ctx.width
  const H = ctx.height
  const s = ctx.scale
  const rnd = (i: number): number => {
    const x = Math.sin((seed + 1) * 12.9898 + i * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  const sw = Math.max(1.5, 2 * s)
  const wrap = (inner: string, defs = ''): string => `<svg class="cr-bgart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">${defs ? `<defs>${defs}</defs>` : ''}${inner}</svg>`
  const m = Math.min(W, H)

  switch (style) {
    case 'contours': {
      // topographic lines: nested wobbling loops around one hill
      const cx = W * (0.3 + rnd(1) * 0.4)
      const cy = H * (0.3 + rnd(2) * 0.4)
      const phase = rnd(3) * Math.PI * 2
      let out = ''
      for (let k = 1; k <= 12; k++) {
        const base = m * (0.06 + k * 0.07)
        let d = ''
        const N = 96
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * Math.PI * 2
          const r = base * (1 + 0.16 * Math.sin(3 * a + phase + k * 0.33) + 0.09 * Math.sin(5 * a + phase * 1.7 - k * 0.21) + 0.05 * Math.sin(8 * a + k))
          d += `${i ? 'L' : 'M'}${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a) * 0.92)}`
        }
        const major = k % 4 === 0
        out += `<path d="${d}Z" fill="none" stroke="${major ? th.accent : th.accent2}" stroke-opacity="${o(major ? 0.24 : 0.1)}" stroke-width="${f(major ? sw * 1.5 : sw)}"/>`
      }
      return wrap(out)
    }
    case 'rings': {
      const cx = W * (0.5 + (rnd(1) - 0.5) * 0.5)
      const cy = H * (0.32 + rnd(2) * 0.2)
      let out = ''
      for (let k = 1; k <= 9; k++) {
        const r = m * (0.09 + k * 0.11)
        const dashed = k % 3 === 0
        out += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="none" stroke="${dashed ? th.accent : th.accent2}" stroke-opacity="${o(dashed ? 0.2 : 0.09)}" stroke-width="${f(sw)}"${dashed ? ` stroke-dasharray="${f(8 * s)} ${f(16 * s)}"` : ''}/>`
      }
      // tick marks on the middle ring, like a dial
      const rr = m * 0.53
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2
        const len = (i % 6 === 0 ? 22 : 9) * s
        out += `<line x1="${f(cx + (rr - len) * Math.cos(a))}" y1="${f(cy + (rr - len) * Math.sin(a))}" x2="${f(cx + rr * Math.cos(a))}" y2="${f(cy + rr * Math.sin(a))}" stroke="${th.ink}" stroke-opacity="${o(i % 6 === 0 ? 0.2 : 0.1)}" stroke-width="${f(sw)}"/>`
      }
      return wrap(out)
    }
    case 'rays': {
      // a sunburst rising from behind the top edge
      const cx = W * (0.4 + rnd(1) * 0.2)
      const cy = -H * 0.1
      const far = Math.hypot(W, H) * 1.3
      const N = 40
      let out = ''
      for (let i = 0; i < N; i++) {
        if (i % 2) continue
        const a0 = Math.PI * (0.06 + (i / N) * 0.88)
        const a1 = Math.PI * (0.06 + ((i + 1) / N) * 0.88)
        out += `<polygon points="${f(cx)},${f(cy)} ${f(cx + far * Math.cos(a0))},${f(cy + far * Math.sin(a0))} ${f(cx + far * Math.cos(a1))},${f(cy + far * Math.sin(a1))}" fill="url(#bgray)"/>`
      }
      const defs = `<radialGradient id="bgray" gradientUnits="userSpaceOnUse" cx="${f(cx)}" cy="${f(cy)}" r="${f(far * 0.75)}"><stop offset="0" stop-color="${th.accent}" stop-opacity="${o(0.2)}"/><stop offset="0.6" stop-color="${th.accent}" stop-opacity="${o(0.06)}"/><stop offset="1" stop-color="${th.accent}" stop-opacity="0"/></radialGradient>`
      return wrap(out, defs)
    }
    case 'blueprint': {
      const fine = 40 * s
      const major = fine * 5
      let out = ''
      for (let x = 0; x <= W; x += fine) out += `<line x1="${f(x)}" y1="0" x2="${f(x)}" y2="${H}" stroke="${th.accent2}" stroke-opacity="${o(Math.round(x / fine) % 5 === 0 ? 0.16 : 0.06)}" stroke-width="${f(Math.round(x / fine) % 5 === 0 ? sw : sw * 0.6)}"/>`
      for (let y = 0; y <= H; y += fine) out += `<line x1="0" y1="${f(y)}" x2="${W}" y2="${f(y)}" stroke="${th.accent2}" stroke-opacity="${o(Math.round(y / fine) % 5 === 0 ? 0.16 : 0.06)}" stroke-width="${f(Math.round(y / fine) % 5 === 0 ? sw : sw * 0.6)}"/>`
      // crosshairs on a few major intersections, one drafting circle
      const mx = Math.round((W * (0.3 + rnd(1) * 0.4)) / major) * major
      const my = Math.round((H * (0.3 + rnd(2) * 0.3)) / major) * major
      const arm = 26 * s
      out += `<line x1="${f(mx - arm)}" y1="${f(my)}" x2="${f(mx + arm)}" y2="${f(my)}" stroke="${th.accent}" stroke-opacity="${o(0.5)}" stroke-width="${f(sw * 1.4)}"/><line x1="${f(mx)}" y1="${f(my - arm)}" x2="${f(mx)}" y2="${f(my + arm)}" stroke="${th.accent}" stroke-opacity="${o(0.5)}" stroke-width="${f(sw * 1.4)}"/>`
      out += `<circle cx="${f(mx)}" cy="${f(my)}" r="${f(major * 1.2)}" fill="none" stroke="${th.accent}" stroke-opacity="${o(0.22)}" stroke-width="${f(sw)}" stroke-dasharray="${f(14 * s)} ${f(10 * s)}"/>`
      // a dimension line along the bottom
      const dy = H - 120 * s
      out += `<line x1="${f(80 * s)}" y1="${f(dy)}" x2="${f(W - 80 * s)}" y2="${f(dy)}" stroke="${th.ink}" stroke-opacity="${o(0.22)}" stroke-width="${f(sw)}"/><line x1="${f(80 * s)}" y1="${f(dy - 12 * s)}" x2="${f(80 * s)}" y2="${f(dy + 12 * s)}" stroke="${th.ink}" stroke-opacity="${o(0.3)}" stroke-width="${f(sw)}"/><line x1="${f(W - 80 * s)}" y1="${f(dy - 12 * s)}" x2="${f(W - 80 * s)}" y2="${f(dy + 12 * s)}" stroke="${th.ink}" stroke-opacity="${o(0.3)}" stroke-width="${f(sw)}"/>`
      return wrap(out)
    }
    case 'waves': {
      let out = ''
      const rows = 9
      for (let k = 0; k < rows; k++) {
        const base = H * (0.42 + k * 0.065)
        const amp = (14 + k * 5) * s * (0.8 + rnd(k) * 0.5)
        const len = W / (1.2 + rnd(k + 20) * 1.1)
        const ph = rnd(k + 40) * Math.PI * 2
        let d = ''
        for (let x = -20; x <= W + 20; x += 24 * s) d += `${d ? 'L' : 'M'}${f(x)} ${f(base + amp * Math.sin((x / len) * Math.PI * 2 + ph))}`
        out += `<path d="${d}" fill="none" stroke="${k % 3 === 0 ? th.accent : th.accent2}" stroke-opacity="${o(0.07 + k * 0.025)}" stroke-width="${f(sw * (1 + k * 0.12))}" stroke-linecap="round"/>`
      }
      return wrap(out)
    }
    case 'spotlight': {
      const x = W * (0.3 + rnd(1) * 0.4)
      const defs = `<radialGradient id="bgspot" cx="${f(x)}" cy="${f(H * 0.42)}" r="${f(m * 0.75)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${th.accent}" stop-opacity="${o(0.22)}"/><stop offset="0.55" stop-color="${th.accent2}" stop-opacity="${o(0.07)}"/><stop offset="1" stop-color="${th.accent2}" stop-opacity="0"/></radialGradient><linearGradient id="bgbeam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${th.ink}" stop-opacity="${o(0.12)}"/><stop offset="1" stop-color="${th.ink}" stop-opacity="0"/></linearGradient>`
      const top = H * -0.05
      const beam = (cx: number, w: number): string => `<polygon points="${f(cx - w * 0.05)},${f(top)} ${f(cx + w * 0.05)},${f(top)} ${f(cx + w)},${f(H)} ${f(cx - w)},${f(H)}" fill="url(#bgbeam)"/>`
      return wrap(`<rect width="${W}" height="${H}" fill="url(#bgspot)"/>${beam(x - W * 0.12, W * 0.28)}${beam(x + W * 0.16, W * 0.2)}`, defs)
    }
    default:
      return ''
  }
}
