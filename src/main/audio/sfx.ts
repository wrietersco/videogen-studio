import { SR, rng, mixIn, type Stereo } from './pcm'

/**
 * Synthesized sound design — no sample packs, no licenses. Each effect is a
 * mono buffer whose "hit" point is known, so it can be placed exactly on a cut.
 */

/** filtered-noise swoosh; returns the buffer and where its peak sits */
export function whoosh(seed: number, dur = 0.7): { buf: Float32Array; peakSec: number } {
  const r = rng(seed)
  const n = Math.round(dur * SR)
  const buf = new Float32Array(n)
  const peak = 0.72
  // state-variable band-pass swept up then down with the swell
  let low = 0
  let band = 0
  for (let i = 0; i < n; i++) {
    const x = i / n
    const env = x < peak ? Math.pow(x / peak, 2.2) : Math.pow(1 - (x - peak) / (1 - peak), 1.4)
    const fc = 350 + 2600 * Math.pow(env, 1.3)
    const f = 2 * Math.sin((Math.PI * fc) / SR)
    const w = r() * 2 - 1
    low += f * band
    const high = w - low - 0.9 * band
    band += f * high
    buf[i] = band * env * 0.9
  }
  return { buf, peakSec: peak * dur }
}

/** cinematic low hit: pitch-dropping sine body + a short noise transient */
export function impact(seed: number): Float32Array {
  const r = rng(seed)
  const n = Math.round(1.6 * SR)
  const buf = new Float32Array(n)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const f = 38 + 60 * Math.exp(-t / 0.08)
    ph += (2 * Math.PI * f) / SR
    const body = Math.tanh(2.2 * Math.sin(ph)) * Math.exp(-t / 0.5)
    const click = (r() * 2 - 1) * Math.exp(-t / 0.012) * 0.6
    buf[i] = (body + click) * 0.8
  }
  return buf
}

/** rising tension into a reveal; the buffer ends exactly on the target */
export function riser(seed: number, dur = 1.6): Float32Array {
  const r = rng(seed)
  const n = Math.round(dur * SR)
  const buf = new Float32Array(n)
  let ph = 0
  let lp = 0
  for (let i = 0; i < n; i++) {
    const x = i / n
    const f = 180 * Math.pow(4, x)
    ph += (2 * Math.PI * f) / SR
    const k = 0.02 + 0.5 * x * x
    lp += k * ((r() * 2 - 1) - lp)
    const env = Math.pow(x, 2.4) * Math.min(1, (1 - x) * 40)
    buf[i] = (Math.sin(ph) * 0.35 + lp * 0.9) * env
  }
  return buf
}

/**
 * Lay the edit's sound design onto a bus: an impact under the hook, a
 * whoosh peaking on every cut, a riser into the final scene.
 */
export function designSfx(bus: Stereo, cuts: number[], totalSec: number, seed: number, level = 1): void {
  mixIn(bus, impact(seed), 0.02, 0.32 * level)
  cuts.slice(1).forEach((t, i) => {
    const w = whoosh(seed + i + 1)
    mixIn(bus, w.buf, t - w.peakSec, 0.2 * level, i % 2 ? 0.35 : -0.35)
  })
  const final = cuts.length > 2 ? cuts[cuts.length - 1] : null
  if (final !== null && final < totalSec - 1) {
    const rs = riser(seed + 99)
    mixIn(bus, rs, final - rs.length / SR, 0.16 * level)
    mixIn(bus, impact(seed + 7), final, 0.24 * level)
  }
}
