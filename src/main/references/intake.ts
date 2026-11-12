import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { MAX_REFS, MAX_STYLE_REFS, suggestRole } from '@shared/references'
import type { RefImage, RefRole } from '@shared/spec'
import { sniff } from '../brand/logo'

/**
 * Reference picture intake. A picture is checked by its content, turned
 * upright, shrunk to a sensible size and stored in the project, so the video
 * never depends on a file that may move or change later.
 */

export const MAX_REF_BYTES = 25 * 1024 * 1024
/** longest edge kept: plenty for full-bleed on a 4K frame, light enough to decode every frame */
const MAX_EDGE = 2048
const ACCEPT = new Set(['png', 'jpeg', 'webp', 'gif'])

export interface RefInput {
  path: string
  role: RefRole
  note?: string
}

export interface InspectedRef {
  path: string
  name: string
  width: number
  height: number
  alpha: boolean
  suggestedRole: RefRole
  /** small preview for the chip (data URL) */
  thumb: string
}

export class RefError extends Error {}

function readChecked(path: string): { buf: Buffer; format: string } {
  if (!path || !existsSync(path)) throw new RefError('This file could not be found.')
  if (statSync(path).size > MAX_REF_BYTES) throw new RefError('This file is larger than 25 MB.')
  const buf = readFileSync(path)
  const format = sniff(buf)
  if (!format || !ACCEPT.has(format)) throw new RefError(format === 'svg' ? 'Use a photo or screenshot (PNG, JPG, WebP). SVG files belong in the logo section.' : 'Use a PNG, JPG, WebP or GIF picture. This file is something else.')
  return { buf, format }
}

/** does a real share of the picture show through? (a cut-out, not just an alpha channel) */
async function hasCutout(buf: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buf, { limitInputPixels: 128e6 }).resize({ width: 96, height: 96, fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let clear = 0
  for (let i = 3; i < data.length; i += 4) if (data[i] < 240) clear += 1
  return clear / (info.width * info.height) > 0.04
}

/** a first look for the attach chips: size, a guessed role and a thumbnail */
export async function inspectRef(path: string): Promise<InspectedRef> {
  const { buf } = readChecked(path)
  try {
    const meta = await sharp(buf, { limitInputPixels: 128e6 }).rotate().metadata()
    const swap = (meta.orientation ?? 1) >= 5
    const width = (swap ? meta.height : meta.width) ?? 0
    const height = (swap ? meta.width : meta.height) ?? 0
    if (!width || !height) throw new Error('empty')
    const alpha = await hasCutout(buf)
    const name = basename(path)
    const thumb = await sharp(buf, { limitInputPixels: 128e6 }).rotate().resize({ width: 160, height: 160, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()
    return { path, name, width, height, alpha, suggestedRole: suggestRole({ name, width, height, alpha }), thumb: `data:image/jpeg;base64,${thumb.toString('base64')}` }
  } catch {
    throw new RefError('This picture could not be read. Try exporting it again as a PNG or JPG.')
  }
}

export interface IntakeResult {
  refs: RefImage[]
  /** pictures that were left out, with the reason in plain words */
  skipped: string[]
}

/** check and store the chosen pictures in `<project>/assets/refs` */
export async function intakeRefs(inputs: RefInput[], projectDir: string): Promise<IntakeResult> {
  const refs: RefImage[] = []
  const skipped: string[] = []
  const dir = join(projectDir, 'assets', 'refs')
  let styles = 0
  for (const input of inputs ?? []) {
    const name = basename(String(input?.path ?? '')) || 'picture'
    try {
      if (refs.length >= MAX_REFS) throw new RefError(`A video can use up to ${MAX_REFS} pictures.`)
      const role: RefRole = input.role === 'subject' || input.role === 'content' ? input.role : 'style'
      if (role === 'style' && styles >= MAX_STYLE_REFS) throw new RefError(`Up to ${MAX_STYLE_REFS} style pictures are read.`)
      const { buf } = readChecked(String(input.path))
      const alpha = await hasCutout(buf)
      const n = refs.length + 1
      const id = `ref-${n}`
      const base = sharp(buf, { limitInputPixels: 128e6, animated: false }).rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      const out = alpha ? await base.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true }) : await base.flatten({ background: '#ffffff' }).jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true })
      mkdirSync(dir, { recursive: true })
      const file = `assets/refs/${id}.${alpha ? 'png' : 'jpg'}`
      writeFileSync(join(projectDir, file), out.data)
      refs.push({ id, role, file, width: out.info.width, height: out.info.height, alpha, name: name.slice(0, 80), note: String(input.note ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 80), about: '' })
      if (role === 'style') styles += 1
    } catch (e) {
      skipped.push(`${name}: ${e instanceof RefError ? e.message : 'could not be read as a picture.'}`)
    }
  }
  return { refs, skipped }
}
