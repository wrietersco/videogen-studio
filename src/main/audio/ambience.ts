import { SR, type Stereo } from './pcm'

/**
 * Procedural nature ambience: no samples, no instruments, no dependencies.
 * Everything is filtered noise plus sparse synthesized events (bird chirps,
 * droplets, thunder, crickets). Deterministic for a given seed, calm enough to
 * sit under a voiceover (peak < 0.45, RMS about 0.05).
 */

export type AmbienceSound =
  | 'white-noise'
  | 'wind'
  | 'rain'
  | 'birds'
  | 'thunder'
  | 'waves'
  | 'stream'
  | 'forest'
  | 'crickets'

const ORDER: AmbienceSound[] = ['white-noise', 'wind', 'rain', 'birds', 'thunder', 'waves', 'stream', 'forest', 'crickets']

const RULES: Array<[AmbienceSound, RegExp]> = [
  ['white-noise', /white[\s-]?noise|pink[\s-]?noise|brown[\s-]?noise|\bstatic\b|\bhiss|\bnoise\b/],
  ['wind', /\bwind|breez|\bgust|\bairflow/],
  ['rain', /\brain|drizzle|\bshower|downpour|\bstorm/],
  ['birds', /\bbird|chirp|tweet|\bsongbird|dawn chorus|\blark|nightingale|sparrow/],
  ['thunder', /thunder|\bstorm|rumbl/],
  ['waves', /\bwave|\bocean|\bsea\b|\bsurf\b|\bbeach|\bshore|seaside/],
  ['stream', /\bstream|\bwater|\bbrook|\briver|\bcreek|trickl|flowing|\bfountain/],
  ['forest', /forest|\bwoods?\b|jungle|woodland|\bnature\b/],
  ['crickets', /cricket|insect|cicada|cicadas|\bnight(time)? sounds?/]
]

/** Map free-text phrases ("gentle rain", "birdsong") to ambience layers. */
export function soundsFromWords(words: string[]): AmbienceSound[] {
  const text = (words ?? []).map((w) => String(w ?? '').toLowerCase()).join(' | ')
  const found = new Set<AmbienceSound>()
  for (const [sound, re] of RULES) if (re.test(text)) found.add(sound)
  const out = ORDER.filter((s) => found.has(s))
  return out.length ? out : ['wind', 'birds']
}

// ---------- small helpers ----------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

const onePole = (fc: number): number => 1 - Math.exp((-2 * Math.PI * fc) / SR)

/** smooth random control in [0,1]: random points at `hz`, cosine-interpolated */
function wander(rng: () => number, hz: number, callHz = SR / 32): () => number {
  const step = hz / callHz
  let phase = 0
  let a = rng()
  let b = rng()
  return () => {
    phase += step
    if (phase >= 1) {
      phase -= 1
      a = b
      b = rng()
    }
    const k = 0.5 - 0.5 * Math.cos(Math.PI * phase)
    return a + (b - a) * k
  }
}

function makePink(rng: () => number): () => number {
  let b0 = 0
  let b1 = 0
  let b2 = 0
  return () => {
    const w = rng() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.099046
    b1 = 0.963 * b1 + w * 0.2965164
    b2 = 0.57 * b2 + w * 1.0526913
    return (b0 + b1 + b2 + w * 0.1848) * 0.25
  }
}

type Buf = { l: Float32Array; r: Float32Array }
const newBuf = (n: number): Buf => ({ l: new Float32Array(n), r: new Float32Array(n) })

function rmsOf(b: Buf): number {
  let s = 0
  for (let i = 0; i < b.l.length; i++) s += b.l[i] * b.l[i] + b.r[i] * b.r[i]
  return Math.sqrt(s / (2 * b.l.length)) || 1e-9
}

function peakOf(b: Buf): number {
  let p = 0
  for (let i = 0; i < b.l.length; i++) {
    const a = Math.abs(b.l[i])
    const c = Math.abs(b.r[i])
    if (a > p) p = a
    if (c > p) p = c
  }
  return p || 1e-9
}

function addScaled(dst: Buf, src: Buf, g: number): void {
  for (let i = 0; i < dst.l.length; i++) {
    dst.l[i] += src.l[i] * g
    dst.r[i] += src.r[i] * g
  }
}

function panGains(pan: number): [number, number] {
  const a = ((pan + 1) * Math.PI) / 4
  return [Math.cos(a), Math.sin(a)]
}

/** continuous layers are normalised to this RMS before mixing */
const BED = 0.1

// ---------- continuous layers ----------

function layerWhite(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const ch = [out.l, out.r]
  const a = onePole(5500)
  for (const dst of ch) {
    const pink = makePink(rng)
    const mod = wander(rng, 0.2)
    let lp = 0
    let m = 1
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) m = 0.85 + 0.3 * mod()
      const w = rng() * 2 - 1
      lp += a * ((pink() * 1.6 + w * 0.35) - lp)
      dst[i] = lp * m
    }
  }
  return out
}

/** cheap soft room tone: one low-passed noise per channel */
function layerAir(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const a = onePole(3000)
  for (const dst of [out.l, out.r]) {
    let lp = 0
    for (let i = 0; i < n; i++) {
      lp += a * (rng() * 2 - 1 - lp)
      dst[i] = lp
    }
  }
  return out
}

function layerWind(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  for (const dst of [out.l, out.r]) {
    const pink = makePink(rng)
    const gust = wander(rng, 0.13)
    const flutter = wander(rng, 0.7)
    let s1 = 0
    let s2 = 0
    let a = onePole(400)
    let amp = 0.5
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) {
        const g = gust()
        a = onePole(220 + 900 * g * g)
        amp = 0.25 + 0.75 * Math.pow(g, 1.4) + 0.12 * flutter()
      }
      const x = pink() * 2 + (rng() * 2 - 1) * 0.3
      s1 += a * (x - s1)
      s2 += a * (s1 - s2)
      dst[i] = s2 * amp
    }
  }
  return out
}

function layerRainBed(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const aHp = onePole(1200)
  const aLp = onePole(8500)
  for (const dst of [out.l, out.r]) {
    const mod = wander(rng, 0.25)
    let lp1 = 0
    let lp2 = 0
    let m = 1
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) m = 0.8 + 0.4 * mod()
      const w = rng() * 2 - 1
      lp1 += aHp * (w - lp1)
      lp2 += aLp * (w - lp1 - lp2)
      dst[i] = lp2 * m
    }
  }
  return out
}

function layerWaves(n: number, rng: () => number): Buf {
  // swell envelope: slow waves 6-10 s long
  const env = new Float32Array(n)
  let t0 = -rng() * 6
  while (t0 * SR < n) {
    const len = 6 + 4 * rng()
    const i0 = Math.max(0, Math.floor(t0 * SR))
    const i1 = Math.min(n, Math.floor((t0 + len) * SR))
    for (let i = i0; i < i1; i++) {
      const u = (i / SR - t0) / len
      const s = Math.sin(Math.PI * Math.pow(u, 0.75))
      const v = s * s
      if (v > env[i]) env[i] = v
    }
    t0 += len * (0.85 + 0.15 * rng())
  }
  const out = newBuf(n)
  const delay = Math.floor(0.35 * SR)
  const aLow = onePole(800)
  const aHp = onePole(2200)
  const aHi = onePole(9000)
  ;[out.l, out.r].forEach((dst, c) => {
    const pink = makePink(rng)
    let low = 0
    let hp = 0
    let hi = 0
    let wash = 0
    for (let i = 0; i < n; i++) {
      const j = c === 0 ? i : Math.max(0, i - delay)
      const e = 0.12 + 0.88 * env[j]
      wash += 0.0004 * (env[j] - wash) // hiss swells slightly after the body
      const w = rng() * 2 - 1
      low += aLow * (pink() * 2.2 - low)
      hp += aHp * (w - hp)
      hi += aHi * (w - hp - hi)
      dst[i] = low * e + hi * 0.8 * (0.05 + 0.95 * wash) * e
    }
  })
  return out
}

function layerStream(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const aHp = onePole(1500)
  const aLp = onePole(9500)
  const aGurgle = onePole(900)
  for (const dst of [out.l, out.r]) {
    const trickle = wander(rng, 11)
    const slow = wander(rng, 3)
    const pink = makePink(rng)
    let hp = 0
    let lp = 0
    let g = 0
    let tm = 1
    let sm = 1
    for (let i = 0; i < n; i++) {
      if ((i & 31) === 0) {
        tm = 0.55 + 0.45 * trickle()
        sm = 0.7 * slow()
      }
      const w = rng() * 2 - 1
      hp += aHp * (w - hp)
      lp += aLp * (w - hp - lp)
      g += aGurgle * (pink() * 2 - g)
      dst[i] = lp * tm + g * sm
    }
  }
  return out
}

// ---------- event layers ----------

function layerRainDrops(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const total = n / SR
  let t = rng() * 0.05
  while (t < total) {
    const i0 = Math.floor(t * SR)
    const f = 1800 + 3800 * rng()
    const amp = 0.25 + 0.75 * rng() * rng()
    const tau = (2 + 3 * rng()) / 1000
    const len = Math.min(n - i0, Math.floor(tau * 6 * SR))
    const [gl, gr] = panGains(rng() * 2 - 1)
    const w = (2 * Math.PI * f) / SR
    for (let k = 0; k < len; k++) {
      const att = Math.min(1, k / (0.0004 * SR))
      const v = Math.sin(w * k) * Math.exp(-k / (tau * SR)) * att * amp
      out.l[i0 + k] += v * gl
      out.r[i0 + k] += v * gr
    }
    t += -Math.log(1 - rng()) / 28
  }
  return out
}

function layerStreamBlips(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const total = n / SR
  let t = 0
  while (t < total) {
    const i0 = Math.floor(t * SR)
    const f0 = 600 + 900 * rng()
    const f1 = f0 * (1.4 + 0.9 * rng())
    const dur = 0.015 + 0.03 * rng()
    const len = Math.min(n - i0, Math.floor(dur * SR))
    const amp = 0.3 + 0.7 * rng()
    const [gl, gr] = panGains(rng() * 1.6 - 0.8)
    let ph = 0
    for (let k = 0; k < len; k++) {
      const u = k / len
      ph += (2 * Math.PI * (f0 + (f1 - f0) * u)) / SR
      const e = Math.sin(Math.PI * u)
      const v = Math.sin(ph) * e * e * amp
      out.l[i0 + k] += v * gl
      out.r[i0 + k] += v * gr
    }
    t += -Math.log(1 - rng()) / 14
  }
  return out
}

interface Note {
  start: number // seconds
  dur: number
  f0: number
  f1: number
  fmHz: number
  fmDepth: number
  amp: number
  pan: number
}

function addNote(out: Buf, nt: Note): void {
  const i0 = Math.floor(nt.start * SR)
  const len = Math.min(out.l.length - i0, Math.floor(nt.dur * SR))
  if (len <= 0 || i0 < 0) return
  const [gl, gr] = panGains(nt.pan)
  let ph = 0
  const wm = (2 * Math.PI * nt.fmHz) / SR
  for (let k = 0; k < len; k++) {
    const u = k / len
    let f = nt.f0 + (nt.f1 - nt.f0) * u + nt.fmDepth * Math.sin(wm * k)
    if (f < 1800) f = 1800
    else if (f > 6500) f = 6500
    ph += (2 * Math.PI * f) / SR
    const e = Math.sin(Math.PI * u)
    const env = e * e
    const v = (Math.sin(ph) + 0.18 * Math.sin(2 * ph)) * env * nt.amp
    out.l[i0 + k] += v * gl
    out.r[i0 + k] += v * gr
  }
}

function layerBirds(n: number, rng: () => number, density: number): Buf {
  const out = newBuf(n)
  const total = n / SR
  const species = [
    { kind: 'whistle', base: 2300 + 900 * rng() },
    { kind: 'trill', base: 3600 + 1400 * rng() },
    { kind: 'tweet', base: 4200 + 1600 * rng() },
    { kind: 'warble', base: 2600 + 1400 * rng() }
  ]
  for (const sp of species) {
    const homePan = rng() * 1.8 - 0.9
    let t = 0.4 + rng() * 5
    while (t < total) {
      const pan = Math.max(-1, Math.min(1, homePan + (rng() - 0.5) * 0.4))
      const amp = 0.55 + 0.45 * rng()
      let dur = 0
      if (sp.kind === 'whistle') {
        const cnt = 1 + Math.floor(rng() * 3)
        const dir = rng() < 0.5 ? -1 : 1
        const f = sp.base * (0.9 + 0.2 * rng())
        for (let c = 0; c < cnt; c++) {
          const d = 0.15 + 0.15 * rng()
          addNote(out, { start: t + dur, dur: d, f0: f, f1: f * (1 + 0.25 * dir), fmHz: 0, fmDepth: 0, amp, pan })
          dur += d + 0.12
        }
      } else if (sp.kind === 'trill') {
        const cnt = 5 + Math.floor(rng() * 8)
        const f = sp.base * (0.92 + 0.16 * rng())
        for (let c = 0; c < cnt; c++) {
          addNote(out, { start: t + dur, dur: 0.035, f0: f * 0.95, f1: f * 1.05, fmHz: 0, fmDepth: 0, amp: amp * 0.8, pan })
          dur += 0.06
        }
      } else if (sp.kind === 'tweet') {
        const cnt = 2 + Math.floor(rng() * 3)
        const f = sp.base * (0.9 + 0.2 * rng())
        for (let c = 0; c < cnt; c++) {
          const d = 0.05 + 0.04 * rng()
          addNote(out, { start: t + dur, dur: d, f0: f * 0.8, f1: f * 1.15, fmHz: 0, fmDepth: 0, amp: amp * 0.9, pan })
          dur += d + 0.07
        }
      } else {
        const d = 0.3 + 0.3 * rng()
        const f = sp.base * (0.9 + 0.2 * rng())
        addNote(out, { start: t, dur: d, f0: f, f1: f * (0.9 + 0.25 * rng()), fmHz: 25 + 20 * rng(), fmDepth: 500, amp, pan })
        dur = d
      }
      t += dur + (1.2 + 4.8 * rng()) / density
    }
  }
  return out
}

function layerCrickets(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const total = n / SR
  for (let c = 0; c < 4; c++) {
    const f = 4300 + c * 230 + rng() * 120
    const period = 0.42 + 0.2 * rng()
    const pulses = 3 + (c & 1)
    const [gl, gr] = panGains(rng() * 1.8 - 0.9)
    const gate = wander(rng, 0.06, 1 / period)
    const w = (2 * Math.PI * f) / SR
    let t = rng() * period
    while (t < total) {
      const gv = gate()
      // the wander is advanced per group, not per sample: fine as a slow gate
      if (gv > 0.25) {
        for (let p = 0; p < pulses; p++) {
          const i0 = Math.floor((t + p * 0.03) * SR)
          const len = Math.min(n - i0, Math.floor(0.013 * SR))
          for (let k = 0; k < len; k++) {
            const e = Math.sin((Math.PI * k) / len)
            const v = Math.sin(w * k) * e * e * gv
            out.l[i0 + k] += v * gl
            out.r[i0 + k] += v * gr
          }
        }
      }
      t += period * (0.95 + 0.1 * rng()) * 1.0
    }
  }
  return out
}

function layerThunder(n: number, rng: () => number): Buf {
  const out = newBuf(n)
  const total = n / SR
  let t = 5 + 7 * rng()
  while (t < total) {
    const len = Math.min(n - Math.floor(t * SR), Math.floor((6.5 + 2.5 * rng()) * SR))
    const i0 = Math.floor(t * SR)
    const echoAt = 1.2 + 1.6 * rng()
    const tail = Math.floor(SR * 1.2)
    ;[out.l, out.r].forEach((dst) => {
      const pink = makePink(rng)
      const roll = wander(rng, 2.5)
      let s1 = 0
      let s2 = 0
      let a = onePole(200)
      let env = 0
      for (let k = 0; k < len; k++) {
        if ((k & 31) === 0) {
          const tt = k / SR
          a = onePole(55 + 170 * Math.exp(-tt / 2.6))
          const att = Math.sin(Math.min(1, tt / 0.45) * Math.PI * 0.5)
          const echo = 0.55 * Math.exp(-Math.pow((tt - echoAt) / 0.5, 2))
          env = att * att * (Math.exp(-tt / 2.4) + echo) * (0.6 + 0.8 * roll())
          const toEnd = len - k
          if (toEnd < tail) env *= Math.sin((Math.PI * 0.5 * toEnd) / tail)
        }
        const x = pink() * 3 + (rng() * 2 - 1) * 0.5
        s1 += a * (x - s1)
        s2 += a * (s1 - s2)
        dst[i0 + k] += s2 * env
      }
    })
    t += 15 + 10 * rng() + len / SR * 0 // 15-25 s between rumbles
  }
  return out
}

// ---------- main ----------

export function natureAmbience(opts: { sounds: AmbienceSound[]; totalSec: number; seed?: number }): Stereo {
  const n = Math.max(1, Math.ceil(opts.totalSec * SR))
  const seed = (opts.seed ?? 1) >>> 0
  const want = new Set<AmbienceSound>(opts.sounds.length ? opts.sounds : ['wind', 'birds'])
  const layerRng = (name: string): (() => number) => mulberry32((seed ^ hashStr(name)) >>> 0 || 1)

  const mix = newBuf(n)
  const bed = (name: string, make: (rng: () => number) => Buf, weight: number): void => {
    const b = make(layerRng(name))
    addScaled(mix, b, (BED * weight) / rmsOf(b))
  }
  const event = (name: string, make: (rng: () => number) => Buf, peak: number): void => {
    const b = make(layerRng(name))
    addScaled(mix, b, peak / peakOf(b))
  }

  let continuous = 0
  if (want.has('white-noise')) { bed('white', (r) => layerWhite(n, r), 0.8); continuous++ }
  if (want.has('wind') || want.has('forest')) {
    bed('wind', (r) => layerWind(n, r), want.has('wind') ? 1 : 0.6)
    continuous++
  }
  if (want.has('rain')) {
    bed('rain', (r) => layerRainBed(n, r), 0.95)
    event('raindrops', (r) => layerRainDrops(n, r), 0.12)
    continuous++
  }
  if (want.has('waves')) { bed('waves', (r) => layerWaves(n, r), 1); continuous++ }
  if (want.has('stream')) {
    bed('stream', (r) => layerStream(n, r), 0.85)
    event('blips', (r) => layerStreamBlips(n, r), 0.1)
    continuous++
  }
  if (want.has('birds') || want.has('forest')) {
    event('birds', (r) => layerBirds(n, r, want.has('birds') ? 1 : 0.5), want.has('birds') ? 0.34 : 0.26)
  }
  if (want.has('crickets')) event('crickets', (r) => layerCrickets(n, r), 0.1)
  if (want.has('thunder')) event('thunder', (r) => layerThunder(n, r), 0.42)

  // quiet room tone when nothing continuous is selected, so sparse sounds never sit in dead silence
  if (continuous === 0 && !want.has('forest')) {
    bed('air', (r) => layerAir(n, r), 0.3)
  }

  // DC block (about 19 Hz high-pass)
  for (const ch of [mix.l, mix.r]) {
    let xp = 0
    let yp = 0
    for (let i = 0; i < n; i++) {
      const x = ch[i]
      const y = x - xp + 0.9975 * yp
      xp = x
      yp = y
      ch[i] = y
    }
  }

  // fades: 1.5 s in, 2.5 s out (shrunk for very short clips), smooth sin^2
  const total = n / SR
  const fin = Math.min(1.5, total * 0.3)
  const fout = Math.min(2.5, total * 0.4)
  const nIn = Math.floor(fin * SR)
  const nOut = Math.floor(fout * SR)
  for (const ch of [mix.l, mix.r]) {
    for (let i = 0; i < nIn && i < n; i++) {
      const s = Math.sin((Math.PI * 0.5 * i) / nIn)
      ch[i] *= s * s
    }
    for (let k = 0; k < nOut && k < n; k++) {
      const s = Math.sin((Math.PI * 0.5 * k) / nOut)
      ch[n - 1 - k] *= s * s
    }
  }

  // level: RMS about 0.05, peak kept well under 0.5
  let sq = 0
  let peak = 1e-9
  for (const ch of [mix.l, mix.r]) {
    for (let i = 0; i < n; i++) {
      const v = ch[i]
      sq += v * v
      if (v > peak) peak = v
      else if (-v > peak) peak = -v
    }
  }
  const rms = Math.sqrt(sq / (2 * n)) || 1e-9
  let g = 0.05 / rms
  if (peak * g > 0.42) g = Math.max(0.42 / peak, 0.036 / rms)
  const KNEE = 0.34
  for (const ch of [mix.l, mix.r]) {
    for (let i = 0; i < n; i++) {
      let v = ch[i] * g
      const a = Math.abs(v)
      if (a > KNEE) v = Math.sign(v) * (KNEE + 0.1 * Math.tanh((a - KNEE) / 0.1))
      ch[i] = v
    }
  }
  return { l: mix.l, r: mix.r }
}
