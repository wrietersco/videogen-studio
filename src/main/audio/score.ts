import type { VideoSpec } from '@shared/spec'
import { SR, stereo, rng, hashSeed, type Stereo } from './pcm'

/**
 * Score engine — writes an original music bed for every video, so there is no
 * licensing question and the music can follow the edit: chords sit on a beat
 * grid that every scene cut lands on (voice.ts rounds scenes to it), the
 * arrangement opens up after the hook and resolves on the final scene.
 *
 * Layers: wavetable pad (detuned, filtered, stereo) · harmonic sub ·
 * felt-piano plucks/arps · light percussion · plate-style reverb.
 * Pure and seeded — same spec, same music, sample for sample.
 */

type Mood = Exclude<VideoSpec['musicMood'], 'none'>

interface MoodRecipe {
  bpm: number
  minor: boolean
  beatsPerCut: number
  /** beats per chord */
  chordBeats: number
  /** pluck notes per beat in the build section (0 = none) */
  arp: number
  kick: 'none' | 'heartbeat' | 'four' | 'half'
  hats: boolean
  /** pad brightness: lowpass cutoff in Hz */
  cutoff: number
  padGain: number
}

const RECIPES: Record<Mood, MoodRecipe> = {
  cinematic: { bpm: 84, minor: true, beatsPerCut: 1, chordBeats: 8, arp: 2, kick: 'heartbeat', hats: false, cutoff: 1500, padGain: 1 },
  dark: { bpm: 72, minor: true, beatsPerCut: 1, chordBeats: 8, arp: 1, kick: 'heartbeat', hats: false, cutoff: 900, padGain: 1.1 },
  minimal: { bpm: 96, minor: false, beatsPerCut: 1, chordBeats: 8, arp: 2, kick: 'none', hats: false, cutoff: 2200, padGain: 0.7 },
  upbeat: { bpm: 112, minor: false, beatsPerCut: 1, chordBeats: 4, arp: 2, kick: 'four', hats: true, cutoff: 2600, padGain: 0.65 },
  playful: { bpm: 118, minor: false, beatsPerCut: 1, chordBeats: 4, arp: 2, kick: 'half', hats: true, cutoff: 3000, padGain: 0.55 },
  corporate: { bpm: 104, minor: false, beatsPerCut: 1, chordBeats: 4, arp: 1, kick: 'half', hats: true, cutoff: 2400, padGain: 0.7 }
}

function moodOf(spec: VideoSpec): Mood | null {
  if (spec.musicMood === 'none') return null
  // a documentary film never gets a bouncy bed, whatever the planner guessed
  if (spec.design?.look === 'documentary' && ['upbeat', 'playful', 'corporate'].includes(spec.musicMood)) return 'cinematic'
  return spec.musicMood
}

export function beatGrid(spec: VideoSpec): { bpm: number; beatSec: number; beatsPerCut: number } {
  const r = RECIPES[moodOf(spec) ?? 'cinematic']
  return { bpm: r.bpm, beatSec: 60 / r.bpm, beatsPerCut: r.beatsPerCut }
}

// ------------------------------------------------------------------ harmony

const MINOR_PROGS = [
  [[0, 'm'], [8, 'M'], [3, 'M'], [10, 'M']], // i VI III VII
  [[0, 'm'], [5, 'm'], [8, 'M'], [7, 'M']], // i iv VI V
  [[0, 'm'], [8, 'M'], [5, 'm'], [7, 'M']] // i VI iv V
] as const
const MAJOR_PROGS = [
  [[0, 'M'], [7, 'M'], [9, 'm'], [5, 'M']], // I V vi IV
  [[0, 'M'], [5, 'M'], [9, 'm'], [7, 'M']], // I IV vi V
  [[0, 'M'], [9, 'm'], [5, 'M'], [7, 'M']] // I vi IV V
] as const

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)

interface Chord {
  root: number
  tones: number[]
}

function chordTones(rootMidi: number, q: 'm' | 'M', color: boolean): number[] {
  const third = q === 'm' ? 3 : 4
  const iv = [0, third, 7, ...(color ? [14] : [])]
  // voice into the 55..72 band so pads sit under the voice, not on it
  return iv.map((i) => {
    let n = rootMidi + i
    while (n < 55) n += 12
    while (n > 72) n -= 12
    return n
  })
}

// ------------------------------------------------------------------ oscillators

const TABLE = 4096
const SAW = (() => {
  const t = new Float32Array(TABLE + 1)
  for (let k = 1; k <= 28; k++) {
    // gentle roll-off above the 8th partial keeps the pad warm
    const a = (1 / k) * (k > 8 ? Math.pow(8 / k, 1.2) : 1)
    for (let i = 0; i <= TABLE; i++) t[i] += a * Math.sin((2 * Math.PI * k * i) / TABLE)
  }
  let peak = 0
  for (const v of t) peak = Math.max(peak, Math.abs(v))
  for (let i = 0; i <= TABLE; i++) t[i] /= peak
  return t
})()

function biquadLP(buf: Float32Array, cutoffAt: (i: number) => number, q = 0.7): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0
  for (let i = 0; i < buf.length; i++) {
    if (i % 128 === 0) {
      const w = (2 * Math.PI * Math.min(cutoffAt(i), SR * 0.45)) / SR
      const alpha = Math.sin(w) / (2 * q)
      const c = Math.cos(w)
      const a0 = 1 + alpha
      b0 = (1 - c) / 2 / a0
      b1 = (1 - c) / a0
      b2 = b0
      a1 = (-2 * c) / a0
      a2 = (1 - alpha) / a0
    }
    const x = buf[i]
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x
    y2 = y1
    y1 = y
    buf[i] = y
  }
}

// ------------------------------------------------------------------ reverb

/** Freeverb-style plate: 8 damped combs + 4 allpasses per side */
function reverb(bus: Stereo, wet: number, size = 0.84, damp = 0.3): Stereo {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((n) => Math.round((n * SR) / 44100))
  const aps = [556, 441, 341, 225].map((n) => Math.round((n * SR) / 44100))
  const run = (input: Float32Array, spread: number): Float32Array => {
    const out = new Float32Array(input.length)
    for (const len of combs) {
      const d = new Float32Array(len + spread)
      let idx = 0
      let store = 0
      for (let i = 0; i < input.length; i++) {
        const y = d[idx]
        store = y * (1 - damp) + store * damp
        d[idx] = input[i] * 0.015 + store * size
        idx = (idx + 1) % d.length
        out[i] += y
      }
    }
    for (const len of aps) {
      const d = new Float32Array(len + spread)
      let idx = 0
      for (let i = 0; i < out.length; i++) {
        const b = d[idx]
        d[idx] = out[i] + b * 0.5
        out[i] = b - out[i]
        idx = (idx + 1) % d.length
      }
    }
    return out
  }
  const l = run(bus.l, 0)
  const r = run(bus.r, 23)
  return { l: l.map((v) => v * wet), r: r.map((v) => v * wet) }
}

// ------------------------------------------------------------------ voices

function pluck(out: Stereo, t0: number, midi: number, vel: number, pan: number, decay: number): void {
  const f = mtof(midi)
  const n = Math.min(Math.round(decay * 4 * SR), out.l.length - Math.round(t0 * SR))
  const off = Math.round(t0 * SR)
  if (n <= 0 || off < 0) return
  const gl = Math.cos(((pan + 1) * Math.PI) / 4)
  const gr = Math.sin(((pan + 1) * Math.PI) / 4)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let v = 0
    // felt piano: soft attack, upper partials die fast, slight stretch tuning
    for (let k = 1; k <= 6; k++) {
      const fk = f * k * (1 + 0.0004 * k * k)
      if (fk > SR * 0.45) break
      v += (Math.sin(2 * Math.PI * fk * t) / Math.pow(k, 1.6)) * Math.exp((-t * k) / decay)
    }
    const env = Math.min(1, t / 0.006) * vel
    out.l[off + i] += v * env * gl
    out.r[off + i] += v * env * gr
  }
}

function kick(out: Stereo, t0: number, vel: number): void {
  const off = Math.round(t0 * SR)
  const n = Math.min(Math.round(0.45 * SR), out.l.length - off)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const f = 46 + 70 * Math.exp(-t / 0.035)
    ph += (2 * Math.PI * f) / SR
    // tanh adds the harmonics that make a kick audible on phone speakers
    const v = Math.tanh(1.8 * Math.sin(ph)) * Math.exp(-t / 0.16) * vel
    out.l[off + i] += v
    out.r[off + i] += v
  }
}

function hat(out: Stereo, t0: number, vel: number, r: () => number, pan: number): void {
  const off = Math.round(t0 * SR)
  const n = Math.min(Math.round(0.08 * SR), out.l.length - off)
  let prev = 0
  for (let i = 0; i < n; i++) {
    const w = r() * 2 - 1
    const hp = w - prev // crude high-pass: first difference
    prev = w
    const v = hp * Math.exp(-i / SR / 0.018) * vel * 0.5
    out.l[off + i] += v * (1 - pan) * 0.5
    out.r[off + i] += v * (1 + pan) * 0.5
  }
}

// ------------------------------------------------------------------ score

/**
 * @param cuts scene start times (cuts[0] = 0); the last entry is the final scene
 */
export function scoreMusic(spec: VideoSpec, cuts: number[], totalSec: number): Stereo | null {
  const mood = moodOf(spec)
  if (!mood) return null
  const R = RECIPES[mood]
  const r = rng(hashSeed(spec.title + mood))
  const beat = 60 / R.bpm
  const progs = R.minor ? MINOR_PROGS : MAJOR_PROGS
  const prog = progs[Math.floor(r() * progs.length)]
  const key = (R.minor ? [45, 47, 50, 52] : [48, 50, 53, 55])[Math.floor(r() * 4)]
  const finalCut = cuts.length > 1 ? cuts[cuts.length - 1] : totalSec
  const hookEnd = cuts[1] ?? totalSec * 0.3
  const tail = 1.8
  const len = totalSec + tail

  // chord timeline; the final scene always resolves to the tonic
  const chordLen = beat * R.chordBeats
  const segs: Array<{ t0: number; t1: number; chord: Chord }> = []
  for (let t = 0, i = 0; t < len; t += chordLen, i++) {
    const [deg, q] = t + 1e-6 >= finalCut ? [0, R.minor ? 'm' : 'M'] : prog[i % prog.length]
    const root = key + deg
    segs.push({ t0: t, t1: Math.min(len, t + chordLen), chord: { root, tones: chordTones(root, q as 'm' | 'M', mood === 'cinematic' || mood === 'minimal') } })
  }
  if (finalCut < len) {
    // re-split so the tonic lands exactly on the final cut
    const cutSegs = segs.filter((s) => s.t0 < finalCut)
    const last = cutSegs.at(-1)
    if (last) last.t1 = finalCut
    const q = R.minor ? 'm' : 'M'
    cutSegs.push({ t0: finalCut, t1: len, chord: { root: key, tones: chordTones(key, q, true) } })
    segs.length = 0
    segs.push(...cutSegs)
  }

  // section intensity 0..1: hook sparse → build → resolve
  const intensity = (t: number) => (t < hookEnd ? 0.35 : t < finalCut ? 0.75 : 1)

  // ---------- pad ----------
  const pad = stereo(len)
  for (const s of segs) {
    const attack = Math.min(1.2, (s.t1 - s.t0) * 0.4)
    const release = 1.4
    const n0 = Math.round(s.t0 * SR)
    const n1 = Math.min(pad.l.length, Math.round((s.t1 + release) * SR))
    s.chord.tones.forEach((m, vi) => {
      ;[-7, 0, 7].forEach((cents, di) => {
        const f = mtof(m) * Math.pow(2, cents / 1200)
        const inc = (f * TABLE) / SR
        let ph = r() * TABLE
        const pan = (di - 1) * 0.6 + (vi % 2 ? 0.1 : -0.1)
        const gl = Math.cos(((pan + 1) * Math.PI) / 4)
        const gr = Math.sin(((pan + 1) * Math.PI) / 4)
        for (let i = n0; i < n1; i++) {
          const t = (i - n0) / SR
          const held = s.t1 - s.t0
          const env = t < attack ? t / attack : t < held ? 1 : Math.max(0, 1 - (t - held) / release)
          const k = ph | 0
          const v = SAW[k] + (SAW[k + 1] - SAW[k]) * (ph - k)
          ph += inc
          if (ph >= TABLE) ph -= TABLE
          const g = env * env * 0.05
          pad.l[i] += v * g * gl
          pad.r[i] += v * g * gr
        }
      })
    })
  }
  const cutoffAt = (i: number) => {
    const t = i / SR
    // slow breathing LFO, and the filter opens as the story builds
    return R.cutoff * (0.55 + 0.45 * intensity(t)) * (1 + 0.18 * Math.sin((2 * Math.PI * t) / (beat * 16)))
  }
  biquadLP(pad.l, cutoffAt)
  biquadLP(pad.r, cutoffAt)

  // ---------- sub ----------
  const sub = stereo(len)
  for (const s of segs) {
    const f = mtof(((s.chord.root - 24) % 12) + 36)
    const n0 = Math.round(s.t0 * SR)
    const n1 = Math.min(sub.l.length, Math.round(s.t1 * SR))
    for (let i = n0; i < n1; i++) {
      const t = (i - n0) / SR
      const held = (n1 - n0) / SR
      const env = Math.min(1, t / 0.4) * Math.min(1, (held - t) / 0.3)
      const ph = 2 * Math.PI * f * (i / SR)
      const v = (Math.tanh(1.4 * Math.sin(ph)) + 0.25 * Math.sin(2 * ph)) * env * 0.07 * (0.6 + 0.4 * intensity(i / SR))
      sub.l[i] += v
      sub.r[i] += v
    }
  }

  // ---------- plucks / arps ----------
  const keys = stereo(len)
  const beats = Math.floor(totalSec / beat)
  for (let b = 0; b < beats; b++) {
    const t = b * beat
    const seg = segs.find((s) => t >= s.t0 && t < s.t1) ?? segs[0]
    const tones = [...seg.chord.tones].sort((a, b2) => a - b2).map((m) => m + 12)
    const lvl = intensity(t)
    const perBeat = lvl < 0.5 ? (b % 2 === 0 ? 1 : 0) : R.arp
    for (let k = 0; k < perBeat; k++) {
      const step = b * R.arp + k
      // up-down arpeggio, accents on the downbeat
      const cycle = [0, 1, 2, tones.length - 1, 2, 1]
      const m = tones[cycle[step % cycle.length] % tones.length]
      const vel = (k === 0 ? 0.32 : 0.2) * (0.85 + 0.3 * r()) * (0.7 + 0.3 * lvl)
      pluck(keys, t + (k * beat) / perBeat + (r() - 0.5) * 0.008, m, vel, (r() - 0.5) * 0.7, 0.9)
    }
  }
  // the final cut gets a low octave bell on the tonic
  if (finalCut < totalSec) pluck(keys, finalCut, key + 24, 0.45, 0, 2.2)

  // ---------- percussion ----------
  const drums = stereo(len)
  for (let b = 0; b < beats; b++) {
    const t = b * beat
    if (t < hookEnd - 1e-6 && R.kick !== 'heartbeat') continue
    const bar = b % 4
    const lvl = intensity(t)
    if (R.kick === 'four') kick(drums, t, 0.55)
    if (R.kick === 'half' && bar % 2 === 0) kick(drums, t, 0.5)
    if (R.kick === 'heartbeat' && bar === 0 && t >= hookEnd - 1e-6) {
      kick(drums, t, 0.28 * lvl)
      kick(drums, t + beat * 0.38, 0.18 * lvl)
    }
    if (R.hats) {
      hat(drums, t + beat / 2, 0.22, r, 0.3)
      if (lvl >= 1) hat(drums, t, 0.12, r, -0.3)
    }
  }

  // ---------- bus: sum, reverb, master envelope ----------
  const dry = stereo(len)
  for (let i = 0; i < dry.l.length; i++) {
    dry.l[i] = pad.l[i] * R.padGain + keys.l[i]
    dry.r[i] = pad.r[i] * R.padGain + keys.r[i]
  }
  const wet = reverb(dry, 0.9)
  const out = stereo(totalSec)
  // one-pole low-cut at ~45 Hz: rumble only eats headroom on phone speakers
  const hpA = Math.exp((-2 * Math.PI * 45) / SR)
  let peak = 1e-9
  let xl = 0, yl = 0, xr = 0, yr = 0
  for (let i = 0; i < out.l.length; i++) {
    const l = dry.l[i] * 0.75 + wet.l[i] + sub.l[i] + drums.l[i] * 0.8
    const r2 = dry.r[i] * 0.75 + wet.r[i] + sub.r[i] + drums.r[i] * 0.8
    yl = hpA * (yl + l - xl)
    xl = l
    yr = hpA * (yr + r2 - xr)
    xr = r2
    out.l[i] = yl
    out.r[i] = yr
    peak = Math.max(peak, Math.abs(yl), Math.abs(yr))
  }
  // fade in over the first beat, fade out over the last 1.5 s
  const fadeIn = beat
  const fadeOut = Math.min(1.5, totalSec * 0.15)
  for (let i = 0; i < out.l.length; i++) {
    const t = i / SR
    const g = (0.5 / peak) * Math.min(1, t / fadeIn) * Math.min(1, (totalSec - t) / fadeOut)
    out.l[i] *= g
    out.r[i] *= g
  }
  return out
}
