import sharp from 'sharp'
import { frameBuffer } from './scan'

/**
 * Smart crop: when a picture has to be cut to a different shape, keep the part
 * with the most going on (edges and movement) instead of always the middle.
 * One fixed position per part, so the picture never wobbles.
 */

export interface Focus {
  x: number
  y: number
}

const SAMPLES = 5
const WIDTH = 96

/** where the interesting part of a few small grayscale frames is (0-1 across, 0-1 down) */
export function focusFromFrames(frames: Uint8Array[], w: number, h: number): Focus {
  if (!frames.length || w < 4 || h < 4) return { x: 0.5, y: 0.5 }
  const energy = new Float64Array(w * h)
  frames.forEach((f, k) => {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        energy[i] += Math.abs(f[i + 1] - f[i - 1]) + Math.abs(f[i + w] - f[i - w])
        // movement counts double: it is usually what the camera follows
        if (k > 0) energy[i] += 2 * Math.abs(f[i] - frames[k - 1][i])
      }
    }
  })
  let total = 0
  let cx = 0
  let cy = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // squared, so a clear subject outweighs a lightly textured background
      const e = energy[y * w + x] ** 2
      total += e
      cx += e * (x + 0.5)
      cy += e * (y + 0.5)
    }
  }
  if (total <= 0) return { x: 0.5, y: 0.5 }
  // stay near the middle unless the evidence is clear
  const pull = (v: number) => 0.5 + (v - 0.5) * 0.85
  return { x: round2(pull(cx / total / w)), y: round2(pull(cy / total / h)) }
}

export async function subjectFocus(path: string, startSec: number, endSec: number): Promise<Focus> {
  try {
    const frames: Uint8Array[] = []
    let w = 0
    let h = 0
    for (let i = 0; i < SAMPLES; i++) {
      const buf = await frameBuffer(path, startSec + ((endSec - startSec) * (i + 0.5)) / SAMPLES, WIDTH)
      if (!buf) continue
      const raw = await sharp(buf).resize(WIDTH).greyscale().raw().toBuffer({ resolveWithObject: true })
      // all frames must share a size
      if (frames.length && (raw.info.width !== w || raw.info.height !== h)) continue
      w = raw.info.width
      h = raw.info.height
      frames.push(new Uint8Array(raw.data))
    }
    return focusFromFrames(frames, w, h)
  } catch {
    return { x: 0.5, y: 0.5 }
  }
}

const round2 = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 100) / 100
