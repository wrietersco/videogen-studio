import { describe, expect, it } from 'vitest'
import { natureAmbience, soundsFromWords, type AmbienceSound } from '../src/main/audio/ambience'
import { SR } from '../src/main/audio/pcm'

function stats(x: Float32Array): { rms: number; peak: number; mean: number; nan: boolean } {
  let s = 0
  let p = 0
  let m = 0
  let nan = false
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    if (!Number.isFinite(v)) nan = true
    s += v * v
    m += v
    if (Math.abs(v) > p) p = Math.abs(v)
  }
  return { rms: Math.sqrt(s / x.length), peak: p, mean: m / x.length, nan }
}

/** share of energy in the first difference (a crude high-frequency measure) */
function hfRatio(x: Float32Array): number {
  let d = 0
  let e = 0
  for (let i = 1; i < x.length; i++) {
    const t = x[i] - x[i - 1]
    d += t * t
    e += x[i] * x[i]
  }
  return d / (e || 1e-12)
}

/** share of energy below ~150 Hz via a one-pole low-pass */
function lfRatio(x: Float32Array): number {
  const a = 1 - Math.exp((-2 * Math.PI * 150) / SR)
  let lp = 0
  let l = 0
  let e = 0
  for (let i = 0; i < x.length; i++) {
    lp += a * (x[i] - lp)
    l += lp * lp
    e += x[i] * x[i]
  }
  return l / (e || 1e-12)
}

const ALL: AmbienceSound[] = ['white-noise', 'wind', 'rain', 'birds', 'thunder', 'waves', 'stream', 'forest', 'crickets']

describe('natureAmbience', () => {
  it('has the exact length', () => {
    const a = natureAmbience({ sounds: ['wind'], totalSec: 3.3 })
    expect(a.l.length).toBe(Math.ceil(3.3 * SR))
    expect(a.r.length).toBe(a.l.length)
  })

  it('is deterministic per seed and differs across seeds', () => {
    const a = natureAmbience({ sounds: ['wind', 'birds'], totalSec: 3, seed: 7 })
    const b = natureAmbience({ sounds: ['wind', 'birds'], totalSec: 3, seed: 7 })
    const c = natureAmbience({ sounds: ['wind', 'birds'], totalSec: 3, seed: 8 })
    expect(Buffer.from(a.l.buffer).equals(Buffer.from(b.l.buffer))).toBe(true)
    expect(Buffer.from(a.r.buffer).equals(Buffer.from(b.r.buffer))).toBe(true)
    expect(Buffer.from(a.l.buffer).equals(Buffer.from(c.l.buffer))).toBe(false)
  })

  it('stays calm, finite, DC-free and stereo for every sound', () => {
    for (const s of ALL) {
      const a = natureAmbience({ sounds: [s], totalSec: 40, seed: 3 })
      for (const ch of [a.l, a.r]) {
        const st = stats(ch)
        expect(st.nan, s).toBe(false)
        expect(st.peak, s).toBeLessThan(0.5)
        expect(st.rms, s).toBeGreaterThan(0.025)
        expect(st.rms, s).toBeLessThan(0.085)
        expect(Math.abs(st.mean), s).toBeLessThan(0.002)
      }
      let diff = 0
      for (let i = 0; i < a.l.length; i += 97) diff += Math.abs(a.l[i] - a.r[i])
      expect(diff, s).toBeGreaterThan(0)
    }
  })

  it('fades in and out', () => {
    const a = natureAmbience({ sounds: ['wind', 'birds', 'rain'], totalSec: 20, seed: 5 })
    const mid = stats(a.l.subarray(8 * SR, 12 * SR)).rms
    expect(stats(a.l.subarray(0, Math.floor(0.02 * SR))).rms).toBeLessThan(mid * 0.05)
    expect(stats(a.r.subarray(a.r.length - Math.floor(0.02 * SR))).rms).toBeLessThan(mid * 0.05)
    expect(Math.abs(a.l[0])).toBeLessThan(1e-3)
    expect(Math.abs(a.l[a.l.length - 1])).toBeLessThan(1e-3)
  })

  it('birds add energy above 2 kHz compared with wind alone', () => {
    const wind = natureAmbience({ sounds: ['wind'], totalSec: 30, seed: 2 })
    const both = natureAmbience({ sounds: ['wind', 'birds'], totalSec: 30, seed: 2 })
    expect(hfRatio(both.l)).toBeGreaterThan(hfRatio(wind.l) * 1.5)
  })

  it('thunder adds low-frequency energy', () => {
    const birds = natureAmbience({ sounds: ['birds'], totalSec: 40, seed: 4 })
    const thunder = natureAmbience({ sounds: ['thunder'], totalSec: 40, seed: 4 })
    expect(lfRatio(thunder.l)).toBeGreaterThan(lfRatio(birds.l) * 2)
  })

  it('generates 120 s quickly', () => {
    const t0 = Date.now()
    const a = natureAmbience({ sounds: ['wind', 'birds'], totalSec: 120, seed: 1 })
    expect(Date.now() - t0).toBeLessThan(6000)
    expect(a.l.length).toBe(120 * SR)
  })
})

describe('soundsFromWords', () => {
  it('maps phrases to sounds', () => {
    expect(soundsFromWords(['soft, airy white noise'])).toEqual(['white-noise'])
    expect(soundsFromWords(['birdsong'])).toEqual(['birds'])
    expect(soundsFromWords(['distant, soft rolling thunder'])).toEqual(['thunder'])
    expect(soundsFromWords(['gentle rain'])).toEqual(['rain'])
    expect(soundsFromWords(['a light breeze'])).toEqual(['wind'])
    expect(soundsFromWords(['gentle waves'])).toEqual(['waves'])
    expect(soundsFromWords(['flowing water'])).toEqual(['stream'])
    expect(soundsFromWords(['a quiet forest'])).toEqual(['forest'])
    expect(soundsFromWords(['crickets'])).toEqual(['crickets'])
  })
  it('combines and dedupes', () => {
    expect(soundsFromWords(['white noise', 'birds', 'thunder', 'birds'])).toEqual(['white-noise', 'birds', 'thunder'])
  })
  it('falls back to wind and birds', () => {
    expect(soundsFromWords(['natural ambience'])).toEqual(['wind', 'birds'])
    expect(soundsFromWords([])).toEqual(['wind', 'birds'])
    expect(soundsFromWords(['???'])).toEqual(['wind', 'birds'])
  })
})
