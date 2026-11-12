import sharp from 'sharp'
import { hexOf, luminance } from '@shared/brand'

/**
 * Logo intake — turns whatever a person uploads into three clean, trimmed,
 * transparent PNGs (as uploaded, a version for dark backgrounds, a version
 * for light ones) and reads its colors. Everything runs on this computer;
 * no AI model sees the logo and none ever redraws it.
 */

export type LogoFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'svg'

export const MAX_LOGO_BYTES = 15 * 1024 * 1024
/** longest edge of the stored logo — plenty for a 4K end card */
const MAX_EDGE = 1600
const DARK_BG: [number, number, number] = [9, 13, 24]
const LIGHT_BG: [number, number, number] = [255, 255, 255]
const INK_ON_DARK: [number, number, number] = [255, 255, 255]
const INK_ON_LIGHT: [number, number, number] = [17, 19, 24]

export class LogoError extends Error {}

/** the file's real type, read from its bytes (the extension is never trusted) */
export function sniff(buf: Buffer): LogoFormat | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif'
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096)).replace(/^﻿/, '')
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg'
  return null
}

/**
 * Strip everything from an SVG that can run code or reach outside the file.
 * The cleaned file is only ever rasterized here — the video never embeds it.
 */
export function sanitizeSvg(text: string): string {
  let s = text.replace(/^﻿/, '')
  if (/<!ENTITY/i.test(s)) throw new LogoError('This SVG uses entity definitions, which are not allowed. Export it again as a plain SVG or a PNG.')
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '')
  for (const tag of ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'animate', 'animateMotion', 'animateTransform', 'set']) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), '').replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '')
  }
  // event handlers
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  // links may only point inside the file (#id) or carry an embedded image
  s = s.replace(/\s(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/gi, (m, _q, a, b) => {
    const v = String(a ?? b ?? '').trim()
    return v.startsWith('#') || /^data:image\/(png|jpeg|webp|gif);base64,/i.test(v) ? m : ''
  })
  // no outside files from styles either
  s = s.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, 'none')
  s = s.replace(/javascript:/gi, '')
  if (!/<svg[\s>]/i.test(s)) throw new LogoError('This file is not a readable SVG.')
  return s
}

export interface PreparedLogo {
  format: LogoFormat
  master: Buffer
  onDark: Buffer
  onLight: Buffer
  width: number
  height: number
  palette: string[]
  notes: string[]
}

interface Raw {
  data: Buffer
  width: number
  height: number
}

const contrastOf = (la: number, lb: number): number => (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)

/** a flat, opaque background (a white JPEG, say) is cleared from the edges inward */
function clearFlatBackground(raw: Raw): boolean {
  const { data, width: w, height: h } = raw
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return false
  const at = (x: number, y: number) => (y * w + x) * 4
  const probes = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1), at(w >> 1, 0), at(w >> 1, h - 1), at(0, h >> 1), at(w - 1, h >> 1)]
  const [r0, g0, b0] = [data[probes[0]], data[probes[0] + 1], data[probes[0] + 2]]
  const near = (i: number, tol: number) => Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) <= tol
  if (!probes.every((p) => near(p, 24))) return false
  // flood from the border so same-colored shapes inside the logo survive
  const seen = new Uint8Array(w * h)
  const stack: number[] = []
  const push = (x: number, y: number) => {
    const p = y * w + x
    if (seen[p] || !near(p * 4, 42)) return
    seen[p] = 1
    stack.push(p)
  }
  for (let x = 0; x < w; x++) {
    push(x, 0)
    push(x, h - 1)
  }
  for (let y = 0; y < h; y++) {
    push(0, y)
    push(w - 1, y)
  }
  while (stack.length) {
    const p = stack.pop()!
    data[p * 4 + 3] = 0
    const x = p % w
    const y = (p - x) / w
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }
  return true
}

function bounds(raw: Raw): { left: number; top: number; width: number; height: number } | null {
  const { data, width: w, height: h } = raw
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 }
}

/**
 * A version that reads on `bg`: parts of the logo that would vanish against
 * it (black lettering on a dark video) are repainted in `ink`; parts that
 * already read keep their color. Returns how much of the logo changed.
 */
function variantFor(raw: Raw, bg: [number, number, number], ink: [number, number, number]): { data: Buffer; changed: number } {
  const out = Buffer.from(raw.data)
  const lb = luminance(...bg)
  let solid = 0
  let changed = 0
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3]
    if (a < 10) continue
    solid += a
    if (contrastOf(luminance(out[i], out[i + 1], out[i + 2]), lb) < 2.2) {
      out[i] = ink[0]
      out[i + 1] = ink[1]
      out[i + 2] = ink[2]
      changed += a
    }
  }
  return { data: out, changed: solid ? changed / solid : 0 }
}

/** the logo's own colors, most common first — greys, black and white are skipped */
export function logoPalette(raw: Raw, max = 3): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  let total = 0
  for (let i = 0; i < raw.data.length; i += 4) {
    const a = raw.data[i + 3]
    if (a < 200) continue
    const r = raw.data[i]
    const g = raw.data[i + 1]
    const b = raw.data[i + 2]
    const hi = Math.max(r, g, b)
    const lo = Math.min(r, g, b)
    total += 1
    if (hi < 40 || hi - lo < 36) continue
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)
    const k = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    k.n += 1
    k.r += r
    k.g += g
    k.b += b
    buckets.set(key, k)
  }
  const out: Array<[number, number, number]> = []
  for (const k of [...buckets.values()].sort((x, y) => y.n - x.n)) {
    if (k.n < total * 0.03) break
    const c: [number, number, number] = [k.r / k.n, k.g / k.n, k.b / k.n]
    if (out.some((o) => Math.abs(o[0] - c[0]) + Math.abs(o[1] - c[1]) + Math.abs(o[2] - c[2]) < 90)) continue
    out.push(c)
    if (out.length >= max) break
  }
  return out.map((c) => hexOf(...c))
}

const toPng = (raw: Raw): Promise<Buffer> => sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer()

async function decode(buf: Buffer, format: LogoFormat): Promise<Raw> {
  const src =
    format === 'svg'
      ? sharp(Buffer.from(sanitizeSvg(buf.toString('utf8')), 'utf8'), { density: 300, limitInputPixels: 64e6 })
      : sharp(buf, { limitInputPixels: 64e6, animated: false }).rotate()
  const { data, info } = await src
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: format !== 'svg' })
    .ensureAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (info.channels !== 4) throw new LogoError('This image could not be read as a logo.')
  return { data, width: info.width, height: info.height }
}

/** check, clean and prepare an uploaded logo */
export async function prepareLogo(buf: Buffer): Promise<PreparedLogo> {
  if (!buf.length) throw new LogoError('This file is empty.')
  if (buf.length > MAX_LOGO_BYTES) throw new LogoError('This file is larger than 15 MB. Export a smaller logo.')
  const format = sniff(buf)
  if (!format) throw new LogoError('Use a PNG, SVG, JPG, WebP or GIF logo. This file is something else.')
  const notes: string[] = []
  let raw: Raw
  try {
    raw = await decode(buf, format)
  } catch (e) {
    if (e instanceof LogoError) throw e
    throw new LogoError('This image could not be read. Try exporting the logo again as a PNG.')
  }
  if (clearFlatBackground(raw)) notes.push('Removed the plain background. A transparent PNG or an SVG gives cleaner edges.')
  const box = bounds(raw)
  if (!box) throw new LogoError('This logo is completely transparent, so there is nothing to show.')
  if (box.width !== raw.width || box.height !== raw.height) {
    const cut = await sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: 4 } }).extract(box).raw().toBuffer({ resolveWithObject: true })
    raw = { data: cut.data, width: cut.info.width, height: cut.info.height }
  }
  if (Math.max(raw.width, raw.height) < 300) notes.push(`This logo is small (${raw.width}×${raw.height}). It may look soft on the end card; 600 pixels or wider is better.`)
  const aspect = raw.width / raw.height
  if (aspect > 8 || aspect < 0.25) notes.push('This logo is very long and thin, so it will appear small in the corner.')

  const dark = variantFor(raw, DARK_BG, INK_ON_DARK)
  const light = variantFor(raw, LIGHT_BG, INK_ON_LIGHT)
  if (dark.changed > 0.02) notes.push(dark.changed > 0.98 ? 'Made a white version for dark videos.' : 'Made a version for dark videos: the dark parts are white, the colors are kept.')
  if (light.changed > 0.02) notes.push(light.changed > 0.98 ? 'Made a dark version for light videos.' : 'Made a version for light videos: the pale parts are dark, the colors are kept.')

  return {
    format,
    master: await toPng(raw),
    onDark: await toPng({ ...raw, data: dark.data }),
    onLight: await toPng({ ...raw, data: light.data }),
    width: raw.width,
    height: raw.height,
    palette: logoPalette(raw),
    notes
  }
}

/** a person's own replacement for one version (kept as is, only cleaned and trimmed) */
export async function prepareVariant(buf: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const p = await prepareLogo(buf)
  return { png: p.master, width: p.width, height: p.height }
}
