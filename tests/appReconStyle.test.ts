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

describe('YouTube references', () => {
  const reply = { pacing: 'energetic', musicEnergy: 'high', palette: ['#FF3366', '#112233'], lookAndFeel: 'Bold and glossy.', motionGraphics: 'Snappy kinetic text.', music: 'Driving electronic.', narration: 'Confident and brisk.', other: '' }
  const gemini = (seen: string[]) => ({ readVideoUrl: async (req: { url: string; prompt: string }) => (seen.push(req.url + '|' + req.prompt), reply as never) })

  it('reads up to three links and builds a direction for the writer, with the person\'s note', async () => {
    const seen: string[] = []
    const links = ['https://youtu.be/abcdefghijk', 'https://www.youtube.com/watch?v=bbbbbbbbbbb', 'https://www.youtube.com/shorts/ccccccccccc', 'https://youtu.be/ddddddddddd']
    const r = await readStyle([], undefined, { links, guidance: 'I love the snappy text', gemini: gemini(seen) })
    expect(seen).toHaveLength(3)
    expect(seen[0]).toContain('https://www.youtube.com/watch?v=abcdefghijk')
    expect(seen[0]).toContain('I love the snappy text')
    expect(r.musicMood).toBe('upbeat')
    expect(r.look).toBeTruthy()
    expect(r.direction).toContain('narration: Confident and brisk.')
    expect(r.direction).toContain('I love the snappy text')
  })

  it('skips links, and says so, when the AI is not available; bad links are ignored', async () => {
    const r = await readStyle([], undefined, { links: ['https://youtu.be/abcdefghijk'], gemini: null })
    expect(r.direction).toBeUndefined()
    expect(r.notes.join(' ')).toContain('YouTube references were skipped')
    const none = await readStyle([], undefined, { links: ['https://example.com/x'], gemini: gemini([]) })
    expect(none.direction).toBeUndefined()
  })

  it('a link that fails to read never stops the run', async () => {
    const r = await readStyle([], undefined, { links: ['https://youtu.be/abcdefghijk'], gemini: { readVideoUrl: async () => { throw new Error('403 private') } } })
    expect(r.notes.join(' ')).toContain('could not be read')
  })
})

describe('what the person must set up for YouTube links', () => {
  it('is ready only with the AI available and Gemini connected, and otherwise names the action', async () => {
    const { youtubeReadiness } = await import('../src/main/appRecon/style')
    expect(youtubeReadiness({ available: true }, true)).toEqual({ ready: true })
    expect(youtubeReadiness({ available: true }, false).action).toContain('Google Gemini')
    expect(youtubeReadiness({ available: false, reason: 'Sign in first.' }, true).action).toContain('Sign in first.')
  })
})
