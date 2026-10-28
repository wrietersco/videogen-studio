import type { Stereo } from './pcm'
import { SR } from './pcm'

/**
 * Sidechain ducking driven by the narration itself: the music dips under
 * every phrase and swells back in the gaps. We know the future (the voice is
 * already rendered), so the dip starts slightly *before* each word.
 */
export function duck(music: Stereo, voice: Float32Array, depthDb = -12, lookaheadSec = 0.12): void {
  const n = music.l.length
  const hop = 256
  const frames = Math.ceil(n / hop)
  const active = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) {
    let e = 0
    const a = f * hop
    const b = Math.min(voice.length, a + hop)
    for (let i = a; i < b; i++) e += voice[i] * voice[i]
    active[f] = b > a && Math.sqrt(e / (b - a)) > 0.012 ? 1 : 0
  }
  const floor = Math.pow(10, depthDb / 20)
  const look = Math.round((lookaheadSec * SR) / hop)
  // hold short gaps between words so the bed doesn't pump
  const hold = Math.round((0.35 * SR) / hop)
  const target = new Float32Array(frames)
  let lastActive = -1e9
  for (let f = 0; f < frames; f++) {
    if (active[Math.min(frames - 1, f + look)]) lastActive = f
    target[f] = f - lastActive <= hold ? floor : 1
  }
  const attack = 1 - Math.exp(-hop / (0.08 * SR))
  const release = 1 - Math.exp(-hop / (0.45 * SR))
  let g = 1
  let prev = 1
  for (let f = 0; f < frames; f++) {
    g += (target[f] - g) * (target[f] < g ? attack : release)
    const a = f * hop
    const b = Math.min(n, a + hop)
    for (let i = a; i < b; i++) {
      const k = prev + ((g - prev) * (i - a)) / hop
      music.l[i] *= k
      music.r[i] *= k
    }
    prev = g
  }
}
