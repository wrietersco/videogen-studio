import sharp from 'sharp'
import { frameBuffer } from './scan'
import type { ShotDefect } from '../../shared/footage'

/**
 * Free, local per-shot measurements — the camera-side checks an editor's
 * assistant would do before spending a vision call: is the shot in focus, is
 * the frame wobbling, is the exposure usable. ffmpeg/sharp failures yield no
 * measurements (null) and never throw; callers just send no hints.
 */

const SAMPLES = 5
const WIDTH = 96
/**
 * Normalisation constants, tuned on 96px-wide grayscale frames:
 * - SHARP_FULL: a mean squared gradient of 400 (|gradient| ≈ 20 luma/px) counts
 *   as fully sharp — crisp edges on a downscaled frame reach it, mush does not.
 * - SHAKE_FULL_FRAC: the gradient-energy centroid drifting ≥6% of the frame
 *   width between samples counts as fully shaky; a locked-off shot stays near 0.
 * - DARK_LEVEL/BRIGHT_LEVEL: luma levels (0–255) below/above which a pixel
 *   counts as black-clipped or white-clipped.
 */
const SHARP_FULL = 400
const SHAKE_FULL_FRAC = 0.06
const DARK_LEVEL = 10
const BRIGHT_LEVEL = 246

export interface ShotExposure {
  /** mean luma, 0–1 */
  mean: number
  /** fraction of pixels at black (luma < 10/255) */
  darkFrac: number
  /** fraction of pixels at white (luma > 246/255) */
  brightFrac: number
}

export interface ShotMeasurements {
  /** 0–1, mean squared gradient magnitude (1 = crisp) */
  sharpness: number
  /** 0–1, frame-to-frame drift of the gradient-energy centroid (1 = heavily shaky) */
  shake: number
  exposure: ShotExposure
}

/** samples 5 small grayscale frames across the shot and measures them; null when the video could not be read */
export async function inspectShot(path: string, startSec: number, endSec: number): Promise<ShotMeasurements | null> {
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
    if (!frames.length || w < 4 || h < 4) return null
    return measureFrames(frames, w, h)
  } catch {
    return null
  }
}

/** pure core of inspectShot, on raw grayscale frames (so it can be tested without ffmpeg) */
export function measureFrames(frames: Uint8Array[], w: number, h: number): ShotMeasurements {
  let gradSq = 0
  let gradN = 0
  let lumaSum = 0
  let lumaN = 0
  let dark = 0
  let bright = 0
  const centroids: Array<{ x: number; y: number }> = []
  for (const f of frames) {
    // gradient magnitude (squared) per pixel: focus evidence, and what the camera is looking at
    const energy = new Float64Array(w * h)
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const gx = f[i + 1] - f[i - 1]
        const gy = f[i + w] - f[i - w]
        const g = gx * gx + gy * gy
        gradSq += g
        gradN++
        energy[i] = g
      }
    }
    let total = 0
    let cx = 0
    let cy = 0
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const e = energy[y * w + x]
        if (e <= 0) continue
        total += e
        cx += e * (x + 0.5)
        cy += e * (y + 0.5)
      }
    }
    // where the detail sits; a flat frame has no evidence, stay centred
    centroids.push(total > 0 ? { x: cx / total, y: cy / total } : { x: w / 2, y: h / 2 })
    for (let i = 0; i < f.length; i++) {
      lumaSum += f[i]
      if (f[i] < DARK_LEVEL) dark++
      if (f[i] > BRIGHT_LEVEL) bright++
      lumaN++
    }
  }
  let move = 0
  let moveN = 0
  for (let k = 1; k < centroids.length; k++) {
    const dx = centroids[k].x - centroids[k - 1].x
    const dy = centroids[k].y - centroids[k - 1].y
    move += Math.sqrt(dx * dx + dy * dy)
    moveN++
  }
  const meanGradSq = gradN ? gradSq / gradN : 0
  return {
    sharpness: clamp01(meanGradSq / SHARP_FULL),
    shake: moveN ? clamp01(move / moveN / (SHAKE_FULL_FRAC * w)) : 0,
    exposure: {
      mean: clamp01(lumaN ? lumaSum / lumaN / 255 : 0),
      darkFrac: lumaN ? round4(dark / lumaN) : 0,
      brightFrac: lumaN ? round4(bright / lumaN) : 0
    }
  }
}

/**
 * The defects the measurements themselves suggest. backlit and tilted need
 * eyes (a vision model) and are never hinted here.
 */
export function hintDefects(m: ShotMeasurements): ShotDefect[] {
  const out: ShotDefect[] = []
  const e = m?.exposure ?? { mean: NaN, darkFrac: NaN, brightFrac: NaN }
  const sharpness = m?.sharpness
  const shake = m?.shake
  if (Number.isFinite(sharpness) && sharpness < 0.3) out.push('misfocused')
  if (Number.isFinite(shake) && shake > 0.6) out.push('shaky')
  if (Number.isFinite(e.mean) && e.mean < 0.2 && Number.isFinite(e.brightFrac) && e.brightFrac < 0.01) out.push('tooDark')
  if ((Number.isFinite(e.mean) && e.mean > 0.82) || (Number.isFinite(e.brightFrac) && e.brightFrac > 0.3)) out.push('tooBright')
  return out
}

const clamp01 = (n: number) => round3(Math.max(0, Math.min(1, n)))
const round3 = (n: number) => Math.round(n * 1000) / 1000
const round4 = (n: number) => Math.round(n * 10000) / 10000
