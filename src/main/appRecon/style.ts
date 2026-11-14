import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import sharp from 'sharp'
import { logoPalette } from '../brand/logo'
import { readVideoFile, readYouTubeStyle } from '../references/video'
import { MAX_STYLE_LINKS, parseYouTubeUrl } from '../../shared/youtube'
import type { GeminiProvider } from '../providers/gemini'

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
  /** what to copy from YouTube references: look and feel, motion graphics, music and narration, for the script writer (information only) */
  direction?: string
}

export interface StyleOptions {
  /** public YouTube links, read by the AI (never downloaded) */
  links?: string[]
  /** what the person likes most, or wants the engine to focus on */
  guidance?: string
  /** the AI that reads links; absent when it cannot be used */
  gemini?: Pick<GeminiProvider, 'readVideoUrl'> | null
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

/** whether YouTube links can be read right now, and if not, the one thing the person has to do about it */
export function youtubeReadiness(ai: { available: boolean; reason?: string }, hasGemini: boolean): { ready: boolean; action?: string } {
  if (!ai.available) return { ready: false, action: `${ai.reason ?? 'The AI is not available on this account.'} YouTube links are read by the AI, so they are skipped until it is.` }
  if (!hasGemini) return { ready: false, action: 'Connect a Google Gemini account in Settings → Keys (or sign in to a plan that includes AI). Gemini is what watches YouTube links; until then they are skipped and only pictures and video files are used.' }
  return { ready: true }
}

export async function readStyle(images: string[], video?: string, opts: StyleOptions = {}): Promise<StyleReading> {
  const notes: string[] = []
  const palette: string[] = []
  const energies: Array<'low' | 'medium' | 'high'> = []
  const direction: string[] = []
  const links = (opts.links ?? []).map((l) => parseYouTubeUrl(l)).filter((r): r is NonNullable<typeof r> => !!r).slice(0, MAX_STYLE_LINKS)
  if (links.length && !opts.gemini) notes.push('The YouTube references were skipped: reading a link needs the AI (a Google Gemini account connected, and the AI writer turned on).')
  else {
    for (const [i, ref] of links.entries()) {
      try {
        const s = await readYouTubeStyle(opts.gemini!, ref, opts.guidance ?? '')
        for (const c of s.palette) if (!palette.includes(c)) palette.push(c)
        energies.push(s.musicEnergy)
        const label = links.length > 1 ? `Reference ${i + 1}` : 'Reference'
        const parts = [s.lookAndFeel && `look and feel: ${s.lookAndFeel}`, s.motionGraphics && `motion graphics: ${s.motionGraphics}`, s.music && `music: ${s.music}`, s.narration && `narration: ${s.narration}`, s.other && `also: ${s.other}`].filter(Boolean)
        if (parts.length) direction.push(`${label} (${s.pacing} pace) — ${parts.join('; ')}`)
        notes.push(`${label} read (${s.pacing} pace${s.motionGraphics ? `, ${s.motionGraphics.slice(0, 80)}` : ''}).`)
      } catch (err) {
        notes.push(`A YouTube reference could not be read (it must be public, not private, age-restricted or live): ${String((err as Error)?.message ?? err).slice(0, 80)}`)
      }
    }
  }
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
      energies.push(brief.musicEnergy)
      notes.push(`The reference video cuts at a ${brief.pacing} pace.`)
    } catch (err) {
      notes.push(`The reference video could not be read: ${(err as Error).message}`)
    }
  }
  // the music follows the references: upbeat when most of them are driving, calm otherwise
  if (energies.length) {
    musicMood = energies.filter((e) => e === 'high').length * 2 >= energies.length ? 'upbeat' : 'corporate'
    notes.push(`The music is ${musicMood === 'upbeat' ? 'upbeat' : 'calm'}, to match the references.`)
  }
  const look = lookFromPalette(palette) ?? undefined
  if (look) notes.push('Backdrop and card colours follow the reference.')
  const guidance = (opts.guidance ?? '').replace(/\s+/g, ' ').trim().slice(0, 600)
  const text = direction.length ? `${direction.join('\n')}${guidance ? `\nThe person likes most / wants the focus on: ${guidance}` : ''}` : undefined
  return { look, musicMood, notes, direction: text }
}
