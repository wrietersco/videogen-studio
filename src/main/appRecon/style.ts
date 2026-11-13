import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import sharp from 'sharp'
import { logoPalette } from '../brand/logo'
import { readVideoFile } from '../references/video'

/**
 * The look reference pictures and a reference video give a recording: the
 * colours of the backdrop around the browser window and of the cards, and
 * (from a video) the energy of the music. Everything is measured on this
 * computer; nothing is sent anywhere.
 */

export interface Look {
  /** backdrop gradient, light end first, as #rrggbb */
  backdrop: [string, string]
  /** accent for the cards, #rrggbb */
  accent: string
}

export interface StyleReading {
  look?: Look
  musicMood?: 'corporate' | 'upbeat'
  notes: string[]
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
export const MAX_STYLE_IMAGES = 3

function rgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [79, 140, 255]
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const hi = Math.max(r, g, b)
  const lo = Math.min(r, g, b)
  const l = (hi + lo) / 2
  if (hi === lo) return [0, 0, l]
  const d = hi - lo
  const s = l > 0.5 ? d / (2 - hi - lo) : d / (hi + lo)
  const h = hi === r ? (g - b) / d + (g < b ? 6 : 0) : hi === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h * 60, s, l]
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function fromHsl(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const x = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${x(f(0))}${x(f(8))}${x(f(4))}`
}

/**
 * From a palette (most common first) make a backdrop that stays dark enough
 * for the window to read, and an accent that is vivid enough to see on it.
 */
export function lookFromPalette(palette: string[]): Look | null {
  const colours = palette.filter((c) => /^#?[0-9a-f]{6}$/i.test(c)).map((c) => toHsl(rgb(c)))
  if (!colours.length) return null
  // the most colourful one leads (a grey brings nothing to steer by)
  const lead = [...colours].sort((a, b) => b[1] * (1 - Math.abs(b[2] - 0.5)) - a[1] * (1 - Math.abs(a[2] - 0.5)))[0]
  const [h, s] = lead
  const sat = Math.max(0.35, Math.min(0.75, s))
  // yellows look bright at the same lightness as blues, so the lightness is lowered until the colour is really dark
  const dark = (l: number, max: number, sat: number) => {
    let hex = fromHsl(h, sat, l)
    for (let k = 0; k < 20 && luminance(hex) > max; k++) hex = fromHsl(h, sat, (l *= 0.88))
    return hex
  }
  return {
    backdrop: [dark(0.26, 0.2, sat), dark(0.08, 0.07, Math.min(0.6, sat))],
    accent: fromHsl(h, Math.max(0.6, Math.min(0.9, s)), 0.58)
  }
}

async function paletteOfImage(path: string): Promise<string[]> {
  const { data, info } = await sharp(path).resize({ width: 160, height: 160, fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return logoPalette({ data, width: info.width, height: info.height }, 3)
}

export async function readStyle(images: string[], video?: string): Promise<StyleReading> {
  const notes: string[] = []
  const palette: string[] = []
  for (const file of images.slice(0, MAX_STYLE_IMAGES)) {
    try {
      if (!IMAGE_EXT.has(extname(file).toLowerCase()) || !existsSync(file) || !statSync(file).isFile()) throw new Error('not a picture')
      for (const c of await paletteOfImage(file)) if (!palette.includes(c)) palette.push(c)
    } catch {
      notes.push(`A reference picture could not be read, so it was skipped: ${file.split(/[\/]/).pop()}`)
    }
  }
  let musicMood: StyleReading['musicMood']
  if (video) {
    try {
      const brief = await readVideoFile(video)
      for (const c of brief.palette) if (!palette.includes(c)) palette.push(c)
      musicMood = brief.musicEnergy === 'high' ? 'upbeat' : 'corporate'
      notes.push(`The reference video cuts at a ${brief.pacing} pace, so the music is ${musicMood === 'upbeat' ? 'upbeat' : 'calm'}.`)
    } catch (err) {
      notes.push(`The reference video could not be read: ${(err as Error).message}`)
    }
  }
  const look = lookFromPalette(palette) ?? undefined
  if (look) notes.push('Backdrop and card colours follow the reference.')
  return { look, musicMood, notes }
}
