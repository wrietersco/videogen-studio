import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { lookFromPalette, readStyle } from '../src/main/appRecon/style'

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}

describe('the look taken from reference pictures', () => {
  it('makes a dark backdrop that keeps the window readable, and a bright accent', () => {
    for (const colour of ['#E8590C', '#2B8A3E', '#7048E8', '#FFD43B', '#1C7ED6']) {
      const look = lookFromPalette([colour])!
      expect(lum(look.backdrop[0])).toBeLessThan(0.24)
      expect(lum(look.backdrop[1])).toBeLessThan(0.08)
      expect(lum(look.accent)).toBeGreaterThan(0.2)
      expect(look.accent).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
  it('follows the most colourful colour, not the first grey-ish one', () => {
    const grey = lookFromPalette(['#808080', '#E8590C'])!
    const orange = lookFromPalette(['#E8590C'])!
    expect(grey.accent).toBe(orange.accent)
  })
  it('has no opinion about an empty or broken palette', () => {
    expect(lookFromPalette([])).toBeNull()
    expect(lookFromPalette(['nope'])).toBeNull()
  })
})

describe('reading reference files', () => {
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vg-style-'))
    await sharp({ create: { width: 200, height: 200, channels: 3, background: '#d9480f' } }).png().toFile(join(dir, 'red.png'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads the colours of a picture on this computer', async () => {
    const r = await readStyle([join(dir, 'red.png')])
    expect(r.look).toBeTruthy()
    expect(r.notes.join(' ')).toContain('follow the reference')
    expect(r.musicMood).toBeUndefined()
  })
  it('skips a missing or non-picture file and says so, never failing', async () => {
    const r = await readStyle([join(dir, 'missing.png'), join(dir, 'x.txt')])
    expect(r.look).toBeUndefined()
    expect(r.notes.length).toBe(2)
  })
  it('says so when the reference video cannot be read', async () => {
    const r = await readStyle([], join(dir, 'nope.mp4'))
    expect(r.notes.join(' ')).toContain('reference video could not be read')
  })
})
