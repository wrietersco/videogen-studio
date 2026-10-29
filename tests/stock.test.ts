import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rankStock, searchStock, stockQuery, stockRelevance, wikimediaImages, type StockResult } from '../src/main/media/stock'
import { AssetLibrary } from '../src/main/assets/library'
import { MediaRouter, plateKey } from '../src/main/media/router'
import { platePrompt } from '../src/main/director/plates'
import { DEFAULT_SETTINGS } from '../src/main/settings'
import type { FilmDesign, VideoSpec } from '../src/shared/spec'

afterEach(() => vi.unstubAllGlobals())

const png = (w: number, h: number, r = 40) => sharp({ create: { width: w, height: h, channels: 3, background: { r, g: 80, b: 120 } } }).png().toBuffer()

const result = (over: Partial<StockResult>): StockResult => ({
  provider: 'pexels',
  id: 'px-1',
  kind: 'image',
  title: 'a photo',
  thumb: 'https://x/t.jpg',
  downloadUrl: 'https://x/f.jpg',
  pageUrl: 'https://x/page',
  license: { name: 'Pexels License', requiresAttribution: false },
  ...over
})

describe('stock query building', () => {
  it('prefers the subject label and drops camera direction', () => {
    expect(stockQuery('Lava pouring into the sea', 'Slow cinematic push-in on glowing lava, no text')).toBe('lava pouring into the sea')
    expect(stockQuery(undefined, 'Slow cinematic close-up of a Vesuvius eruption at dawn')).toBe('vesuvius eruption dawn')
    expect(stockQuery(undefined, 'drift')).toBe('drift')
  })
})

describe('stock relevance ranking', () => {
  it('puts the closest word match first regardless of provider order', () => {
    const ranked = rankStock(
      [
        result({ id: 'a', title: 'sunset over the ocean' }),
        result({ id: 'b', title: 'volcano erupting lava at night' }),
        result({ id: 'c', title: 'lava' })
      ],
      'volcano lava'
    )
    expect(ranked.map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('pushes too-short clips and wrong orientations to the back', () => {
    const toks = ['lava']
    const short = stockRelevance(result({ kind: 'video', title: 'lava', durationSec: 2 }), toks, { minDurationSec: 4 })
    const long = stockRelevance(result({ kind: 'video', title: 'lava', durationSec: 9 }), toks, { minDurationSec: 4 })
    expect(long).toBeGreaterThan(short)
    const tall = stockRelevance(result({ title: 'lava', width: 1080, height: 1920 }), toks, { orientation: 'landscape' })
    const wide = stockRelevance(result({ title: 'lava', width: 1920, height: 1080 }), toks, { orientation: 'landscape' })
    expect(wide).toBeGreaterThan(tall)
  })
})

describe('wikimedia commons connector', () => {
  it('parses titles, licences and skips non-bitmap files', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            query: {
              pages: {
                '10': {
                  pageid: 10,
                  title: 'File:Vesuvius_from_Pompeii.jpg',
                  imageinfo: [
                    {
                      url: 'https://upload.wikimedia.org/wikipedia/commons/a/Vesuvius_from_Pompeii.jpg',
                      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Vesuvius_from_Pompeii.jpg',
                      thumburl: 'https://upload.wikimedia.org/thumb/420px-Vesuvius.jpg',
                      width: 4000,
                      height: 3000,
                      extmetadata: {
                        LicenseShortName: { value: 'CC BY-SA 4.0' },
                        Artist: { value: '<a href="//x">Carlo Brogi</a>' }
                      }
                    }
                  ]
                },
                '11': {
                  pageid: 11,
                  title: 'File:Duck.svg',
                  imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/Duck.svg', width: 100, height: 100 }]
                }
              }
            }
          }),
          { status: 200 }
        )
      )
    )
    const out = await wikimediaImages('vesuvius')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      provider: 'wikimedia',
      id: 'wm-10',
      title: 'Vesuvius from Pompeii',
      downloadUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/Vesuvius_from_Pompeii.jpg',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:Vesuvius_from_Pompeii.jpg'
    })
    expect(out[0].license).toMatchObject({ name: 'CC BY-SA 4.0', author: 'Carlo Brogi', requiresAttribution: true })
  })
})

describe('search dedupes and ranks across providers', () => {
  it('drops the same file returned twice and ranks best first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('api.pexels.com'))
          return new Response(
            JSON.stringify({
              photos: [
                { id: 1, width: 2000, height: 1200, url: 'https://pexels.com/1', alt: 'city skyline', photographer: 'A', src: { medium: 'https://i/1m', large2x: 'https://i/1l' } },
                { id: 2, width: 2000, height: 1200, url: 'https://pexels.com/2', alt: 'night city traffic', photographer: 'B', src: { medium: 'https://i/2m', large2x: 'https://i/2l' } }
              ]
            }),
            { status: 200 }
          )
        if (String(url).includes('commons.wikimedia.org'))
          return new Response(
            JSON.stringify({
              query: { pages: { '9': { pageid: 9, title: 'File:Night_city_traffic.jpg', imageinfo: [{ url: 'https://i/2l', width: 2000, height: 1200, descriptionurl: 'https://commons/9' }] } } }
            }),
            { status: 200 }
          )
        return new Response(JSON.stringify({ results: [] }), { status: 200 }) // openverse
      })
    )
    const { results, errors } = await searchStock('image', 'night city', { pexelsKey: 'k' })
    expect(errors).toEqual([])
    expect(results.map((r) => r.downloadUrl)).toEqual(['https://i/2l', 'https://i/1l']) // deduped, best match first
  })
})

describe('stock prefetch — downloads into the library for on-the-go use', () => {
  it('fetches the ranked best photo and clip per scene, then paint/motionClip reuse them', async () => {
    const lib = new AssetLibrary(mkdtempSync(join(tmpdir(), 'vg-prefetch-')), null)
    let imageDownloads = 0
    let videoDownloads = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url)
        if (u.includes('api.pexels.com/v1/search'))
          return new Response(
            JSON.stringify({
              photos: [
                { id: 1, width: 4000, height: 2500, url: 'https://pexels.com/1', alt: 'lava pouring into the sea at night', photographer: 'A', src: { medium: 'https://dl/img-1', large2x: 'https://dl/img-1' } },
                { id: 2, width: 4000, height: 2500, url: 'https://pexels.com/2', alt: 'a red bicycle', photographer: 'B', src: { medium: 'https://dl/img-2', large2x: 'https://dl/img-2' } }
              ]
            }),
            { status: 200 }
          )
        if (u.includes('api.pexels.com/videos/search'))
          return new Response(
            JSON.stringify({
              videos: [
                { id: 7, width: 1080, height: 1920, duration: 12, url: 'https://pexels.com/v7', image: 'https://i/v7.jpg', user: { name: 'C' }, video_files: [{ link: 'https://dl/vid-7', width: 1080, height: 1920, file_type: 'video/mp4' }] },
                { id: 8, width: 1080, height: 1920, duration: 3, url: 'https://pexels.com/v8', image: 'https://i/v8.jpg', user: { name: 'C' }, video_files: [{ link: 'https://dl/vid-8', width: 1080, height: 1920, file_type: 'video/mp4' }] }
              ]
            }),
            { status: 200 }
          )
        if (u.includes('dl/img-')) {
          imageDownloads += 1
          return new Response(await png(1600, 1000, imageDownloads), { status: 200 })
        }
        if (u.includes('dl/vid-')) {
          videoDownloads += 1
          return new Response(Buffer.from('FAKE-CLIP'), { status: 200 })
        }
        return new Response(JSON.stringify({ results: [] }), { status: 200 })
      })
    )
    const settings = () => ({ ...DEFAULT_SETTINGS, media: { ...DEFAULT_SETTINGS.media, image: 'stock', video: 'stock' } })
    const router = new MediaRouter({
      library: lib,
      settings,
      key: (id) => (id === 'pexels' ? 'k-pexels' : ''),
      provider: () => {
        throw new Error('no painter wanted')
      },
      autoImageProvider: () => null
    })
    const design = { look: 'documentary', series: 'LAVA', imageStyle: '', accent: '#FF4A2E', accent2: '#3EE6FF' } as FilmDesign
    const spec = {
      platform: 'tiktok',
      scenes: [
        { id: 's1', durationSec: 6 },
        { id: 's2', durationSec: 6 }
      ],
      crafts: [
        { sceneId: 's1', background: 'plate', widgets: [], plate: { prompt: 'lava pouring into the sea at night', camera: 'push', subject: 'center', subjectLabel: 'lava', motion: true } },
        { sceneId: 's2', background: 'plate', widgets: [], plate: { prompt: 'a quiet village under volcanic ash', camera: 'pull', subject: 'center', subjectLabel: 'ash village', motion: false } }
      ]
    } as unknown as VideoSpec
    const w = 1080
    const h = 1920
    const fetched = await router.prefetchForSpec({ spec, design, width: w, height: h, projectId: 'p1' })
    expect(fetched).toEqual({ images: 2, clips: 1 }) // only the long enough clip qualifies
    expect(imageDownloads).toBe(2)
    expect(videoDownloads).toBe(1)
    // both photos landed tagged with their subject + stamped with the plate reuse key
    const lavaKey = plateKey(platePrompt(spec.crafts[0].plate!, design, w, h), w, h)
    expect(lib.findByKey('image', lavaKey)?.tags).toEqual(expect.arrayContaining(['lava', 'plate']))
    // paint now finds the prefetched photo in the library — no second download
    const paint = await router.paint({ brief: spec.crafts[0].plate!.prompt, fullPrompt: platePrompt(spec.crafts[0].plate!, design, w, h), subjectLabel: 'lava', look: 'documentary', width: w, height: h, projectId: 'p1' })
    expect(paint).toMatchObject({ source: 'stock', reused: true, assetId: lib.findByKey('image', lavaKey)!.id })
    expect(imageDownloads).toBe(2)
    // motionClip picks the prefetched clip without a new download
    const clip = await router.motionClip({ prompt: 'lava pouring into the sea at night', subjectLabel: 'lava', camera: 'push', width: w, height: h, durationSec: 6, projectId: 'p1' })
    expect(clip?.source).toBe('stock')
    expect(clip?.buffer.toString()).toBe('FAKE-CLIP')
    expect(videoDownloads).toBe(1)
    // a second identical scene reuses the same clip asset (subject-tagged motion lookup)
    const clip2 = await router.motionClip({ prompt: 'another lava take', subjectLabel: 'lava', camera: 'drift', width: w, height: h, durationSec: 5, projectId: 'p1' })
    expect(clip2?.assetId).toBe(clip!.assetId)
  }, 60_000)

  it('skips prefetch entirely in fresh-reuse mode', async () => {
    const lib = new AssetLibrary(mkdtempSync(join(tmpdir(), 'vg-prefetch-')), null)
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1
        return new Response(JSON.stringify({ photos: [] }), { status: 200 })
      })
    )
    const router = new MediaRouter({
      library: lib,
      settings: () => ({ ...DEFAULT_SETTINGS, reuse: 'fresh', media: { ...DEFAULT_SETTINGS.media, image: 'stock' } }),
      key: (id) => (id === 'pexels' ? 'k' : ''),
      provider: () => {
        throw new Error('no painter wanted')
      },
      autoImageProvider: () => null
    })
    const design = { look: 'documentary', series: 'X', imageStyle: '', accent: '#000000', accent2: '#ffffff' } as FilmDesign
    const spec = { scenes: [{ id: 's1', durationSec: 5 }], crafts: [{ sceneId: 's1', background: 'plate', widgets: [], plate: { prompt: 'lava', camera: 'push', subject: 'center', subjectLabel: 'lava', motion: false } }] } as unknown as VideoSpec
    expect(await router.prefetchForSpec({ spec, design, width: 1080, height: 1920, projectId: 'p1' })).toEqual({ images: 0, clips: 0 })
    expect(calls).toBe(0)
  })
})
