import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { AssetLibrary } from '../src/main/assets/library'
import { MediaRouter } from '../src/main/media/router'
import { DEFAULT_SETTINGS, type Settings } from '../src/main/settings'
import { meter } from '../src/main/usage/meter'
import type { LLMProvider } from '../src/main/providers/types'

const png = (w: number, h: number, r = 40) => sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 80, b: 120 } } }).png().toBuffer()

function fakePainter(calls: { n: number }): LLMProvider {
  return {
    id: 'openai',
    label: 'fake',
    isConfigured: async () => true,
    listModels: async () => [],
    generateJSON: async () => ({}) as never,
    generateText: async () => '',
    generateImage: async (req) => {
      calls.n += 1
      return png(req.width, req.height, 10 + calls.n)
    }
  }
}

describe('asset library', () => {
  it('stores sidecars, dedupes identical bytes and searches by words', async () => {
    const lib = new AssetLibrary(mkdtempSync(join(tmpdir(), 'vg-lib-')), null)
    const img = await png(800, 1200)
    const a = lib.add(img, '.png', {
      kind: 'image',
      source: 'uploaded',
      title: 'red vintage bicycle',
      tags: ['bike', 'retro'],
      width: 800,
      height: 1200,
      license: { name: 'Yours' }
    })
    expect(lib.add(img, '.png', { kind: 'image', source: 'uploaded', title: 'dup', tags: [], license: { name: 'Yours' } }).id).toBe(a.id)
    lib.reload()
    expect(lib.get(a.id)?.title).toBe('red vintage bicycle')
    expect(lib.search('vintage bicycle', { kind: 'image' })[0].score).toBeCloseTo(1)
    expect(lib.search('bicycle', { kind: 'image', orientation: 'landscape' })).toHaveLength(0)
    expect(lib.update(a.id, { tags: ['Bike', 'bike', 'City'] })?.tags).toEqual(['bike', 'city'])
    expect(lib.remove(a.id)).toBe(true)
    expect(lib.all()).toHaveLength(0)
  })
})

describe('media router', () => {
  it('pays once for a plate and reuses it (logged as saved) on the next video', async () => {
    const lib = new AssetLibrary(mkdtempSync(join(tmpdir(), 'vg-lib-')), null)
    const calls = { n: 0 }
    const settings: Settings = { ...DEFAULT_SETTINGS, media: { ...DEFAULT_SETTINGS.media, image: 'openai:gpt-image-2' } }
    const router = new MediaRouter({
      library: lib,
      settings: () => settings,
      key: (id) => (id === 'openai' ? 'sk-test' : ''),
      provider: () => fakePainter(calls),
      autoImageProvider: () => null
    })
    const req = { brief: 'a lighthouse on a cliff at dusk', fullPrompt: 'a lighthouse on a cliff at dusk. Wide frame.', subjectLabel: 'lighthouse', width: 1920, height: 1080 }
    meter.begin('generate')
    const first = await router.paint({ ...req, projectId: 'p1' })
    const second = await router.paint({ ...req, projectId: 'p2' })
    const run = meter.end(null)
    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.assetId).toBe(first.assetId)
    expect(calls.n).toBe(1)
    expect(lib.get(first.assetId)?.usedIn).toEqual(['p1', 'p2'])
    expect(run?.savedUsd).toBeGreaterThan(0)

    // 'fresh' never reuses
    settings.reuse = 'fresh'
    const third = await router.paint({ ...req, projectId: 'p3' })
    expect(third.reused).toBe(false)
    expect(calls.n).toBe(2)
  })

  it("uses the user's own tagged upload for a matching subject", async () => {
    const lib = new AssetLibrary(mkdtempSync(join(tmpdir(), 'vg-lib-')), null)
    const mine = lib.add(await png(1000, 1000, 200), '.png', {
      kind: 'image',
      source: 'uploaded',
      title: 'my product',
      tags: ['acme', 'bottle'],
      width: 1000,
      height: 1000,
      license: { name: 'Yours' }
    })
    const calls = { n: 0 }
    const router = new MediaRouter({
      library: lib,
      settings: () => ({ ...DEFAULT_SETTINGS, media: { ...DEFAULT_SETTINGS.media, image: 'openai' } }),
      key: () => 'sk-test',
      provider: () => fakePainter(calls),
      autoImageProvider: () => null
    })
    const r = await router.paint({ brief: 'hero shot of the drink on a marble counter', fullPrompt: 'x', subjectLabel: 'Acme bottle', width: 1080, height: 1920, projectId: 'p' })
    expect(r.assetId).toBe(mine.id)
    expect(calls.n).toBe(0)
  })
})
