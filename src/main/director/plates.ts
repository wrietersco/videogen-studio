import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import type { FilmDesign, Plate } from '@shared/spec'
import type { LLMProvider } from '../providers/types'

/**
 * Plate engine (main process) — turns a director's plate brief into the two
 * files the in-page renderer animates:
 *   1. image model → painted still, cover-cropped to the exact canvas
 *   2. Depth Anything V2 (local, CPU, open weights) → smoothed depth map
 *   3. vision locator → where the subject actually landed (annotation anchor)
 * Every step degrades gracefully: no depth model → gradient depth; no vision →
 * the anchor the prompt asked for.
 */

export interface PlateResult {
  file: string
  depthFile: string
  anchor: { x: number; y: number }
  /** small JPEG preview for the live storyboard */
  previewDataUrl: string
}

const NO_TEXT = 'No text, no letters, no numbers, no logos, no watermark, no border, no frame, no UI.'

export function platePrompt(plate: Pick<Plate, 'prompt' | 'subject'>, design: FilmDesign, width: number, height: number): string {
  const landscape = width > height * 1.15
  const side = landscape ? 'right' : plate.subject
  const composition = landscape
    ? `Wide ${width}x${height} frame. Keep the left 45% of the frame calm, dark and uncluttered for text. Place the main subject in the right third.`
    : `Vertical ${width}x${height} frame. Keep the top 35% calm, dark and empty (sky, shadow or haze) for title text. Place the main subject in the middle band${side === 'center' ? ', centered' : `, slightly ${side} of center`}. Keep the bottom 18% simple and dark.`
  return [plate.prompt.trim().replace(/\.*$/, '.'), design.imageStyle ? `Art direction: ${design.imageStyle.trim().replace(/\.*$/, '.')}` : '', composition, 'Strong depth separation between foreground, subject and background.', NO_TEXT]
    .filter(Boolean)
    .join(' ')
}

// ---------------- depth (Depth Anything V2 via transformers.js, lazily loaded) ----------------

type DepthFn = (input: unknown) => Promise<{ depth: { data: Uint8Array | Uint8ClampedArray; width: number; height: number; channels: number } }>
let depthPipe: Promise<{ est: DepthFn; RawImage: new (d: Uint8ClampedArray, w: number, h: number, c: number) => unknown } | null> | null = null

function loadDepth() {
  depthPipe ??= (async () => {
    try {
      const tf = await import('@huggingface/transformers')
      tf.env.cacheDir = join(homedir(), '.videogen-studio', 'models')
      const est = (await tf.pipeline('depth-estimation', 'onnx-community/depth-anything-v2-small', { dtype: 'q8' })) as unknown as DepthFn
      return { est, RawImage: tf.RawImage as unknown as new (d: Uint8ClampedArray, w: number, h: number, c: number) => unknown }
    } catch {
      return null // offline / unsupported runtime → gradient depth
    }
  })()
  return depthPipe
}

async function estimateDepth(color: Buffer, width: number, height: number): Promise<Buffer> {
  const outW = Math.round(width / 2)
  const outH = Math.round(height / 2)
  const model = await loadDepth()
  if (model) {
    try {
      const small = await sharp(color).resize(518, Math.round((518 * height) / width)).raw().toBuffer({ resolveWithObject: true })
      const img = new model.RawImage(new Uint8ClampedArray(small.data), small.info.width, small.info.height, small.info.channels)
      const r = await model.est(img)
      const d = r.depth
      return await sharp(Buffer.from(d.data), { raw: { width: d.width, height: d.height, channels: d.channels as 1 } })
        .resize(outW, outH)
        .blur(2.2)
        .normalise()
        .png()
        .toBuffer()
    } catch {
      /* fall through to the gradient */
    }
  }
  // fallback: ground plane (bottom = near) — still a convincing dolly
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="0.55" stop-color="#202020"/><stop offset="1" stop-color="#e0e0e0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`
  return sharp(Buffer.from(svg)).png().toBuffer()
}

// ---------------- locator (vision) ----------------

const LOCATE_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    x: { type: 'number', description: 'horizontal center of the subject, 0 = left edge, 1 = right edge' },
    y: { type: 'number', description: 'vertical center of the subject, 0 = top edge, 1 = bottom edge' }
  },
  required: ['found', 'x', 'y']
}

async function locateSubject(vision: LLMProvider | null, color: Buffer, label: string): Promise<{ x: number; y: number } | null> {
  if (!vision || vision.id === 'mock' || !label) return null
  try {
    const jpeg = await sharp(color).resize({ width: 512 }).jpeg({ quality: 80 }).toBuffer()
    const r = await vision.generateJSON<{ found: boolean; x: number; y: number }>({
      system: 'You locate objects in images precisely. Answer with normalized coordinates only.',
      prompt: `Find "${label}" in this image. Return the center point of its most visually important part (for a volcano: the crater; for a person: the face or upper body; for a building: its center) as fractions of the image size.`,
      schemaName: 'Locate',
      jsonSchema: LOCATE_SCHEMA,
      images: [{ mimeType: 'image/jpeg', base64: jpeg.toString('base64') }],
      temperature: 0,
      maxTokens: 300
    })
    if (!r?.found || !(r.x >= 0.03 && r.x <= 0.97 && r.y >= 0.05 && r.y <= 0.95)) return null
    return { x: r.x, y: r.y }
  } catch {
    return null
  }
}

function defaultAnchor(subject: Plate['subject'], width: number, height: number): { x: number; y: number } {
  if (width > height * 1.15) return { x: 0.72, y: 0.55 }
  return { x: subject === 'left' ? 0.3 : subject === 'right' ? 0.7 : 0.5, y: 0.6 }
}

/** re-aim an existing plate's annotation (new subject label, same painting) */
export async function relocatePlate(opts: { vision: LLMProvider | null; plate: Plate; projectDir: string; width: number; height: number }): Promise<{ x: number; y: number }> {
  const { plate, width, height } = opts
  if (!plate.file) return defaultAnchor(plate.subject, width, height)
  const color = await sharp(join(opts.projectDir, plate.file)).toBuffer()
  return (await locateSubject(opts.vision, color, plate.subjectLabel)) ?? defaultAnchor(plate.subject, width, height)
}

export async function makePlate(opts: {
  /** paints (or fetches/reuses) the still for a full prompt */
  obtain: (fullPrompt: string) => Promise<Buffer>
  vision: LLMProvider | null
  plate: Plate
  design: FilmDesign
  sceneId: string
  projectDir: string
  width: number
  height: number
}): Promise<PlateResult> {
  const { plate, design, sceneId, projectDir, width, height } = opts
  const raw = await opts.obtain(platePrompt(plate, design, width, height))
  const color = await sharp(raw).resize(width, height, { fit: 'cover', kernel: 'lanczos3' }).sharpen({ sigma: 0.6 }).jpeg({ quality: 90 }).toBuffer()
  const depth = await estimateDepth(color, width, height)
  const dir = join(projectDir, 'assets', 'plates')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sceneId}.jpg`), color)
  writeFileSync(join(dir, `${sceneId}-depth.png`), depth)
  const anchor = (await locateSubject(opts.vision, color, plate.subjectLabel)) ?? defaultAnchor(plate.subject, width, height)
  const preview = await sharp(color).resize({ width: 320 }).jpeg({ quality: 72 }).toBuffer()
  return {
    file: `assets/plates/${sceneId}.jpg`,
    depthFile: `assets/plates/${sceneId}-depth.png`,
    anchor,
    previewDataUrl: `data:image/jpeg;base64,${preview.toString('base64')}`
  }
}
