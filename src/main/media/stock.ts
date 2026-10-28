import sharp from 'sharp'
import type { AssetKind, AssetLicense, AssetMeta } from '@shared/assets'
import { tokenize } from '@shared/assets'
import type { AssetLibrary } from '../assets/library'

/**
 * Free-licence stock connectors — official APIs only, no scraping:
 *   Openverse (keyless; CC0 / CC BY images and audio, commercial-use filter)
 *   Pexels    (free key; photos + video clips under the Pexels License)
 *   Pixabay   (free key; photos + video clips under the Pixabay Content License)
 * Downloads land in the asset library with their licence and credit line.
 */

export interface StockResult {
  provider: 'openverse' | 'pexels' | 'pixabay'
  id: string
  kind: AssetKind
  title: string
  thumb: string
  downloadUrl: string
  pageUrl: string
  width?: number
  height?: number
  durationSec?: number
  license: AssetLicense
}

const UA = 'VideoGenStudio/0.3 (+https://github.com/wrietersco/videogen-studio)'

async function getJSON<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const host = new URL(url).host
  let res: Response
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(12_000) })
  } catch {
    throw new Error(`${host} didn't answer — try again in a bit`)
  }
  if (!res.ok) throw new Error(`${host} said ${res.status}`)
  return (await res.json()) as T
}

type Orientation = 'portrait' | 'landscape' | 'square'

// ---------------- Openverse ----------------

interface OvItem {
  id: string
  title?: string
  url: string
  thumbnail?: string
  creator?: string
  license: string
  license_version?: string
  license_url?: string
  foreign_landing_url?: string
  attribution?: string
  width?: number
  height?: number
  duration?: number
}

function ovLicense(r: OvItem): AssetLicense {
  const name = r.license === 'cc0' ? 'CC0' : r.license === 'pdm' ? 'Public Domain' : `CC ${r.license.toUpperCase()} ${r.license_version ?? ''}`.trim()
  return {
    name,
    url: r.license_url,
    author: r.creator,
    attribution: r.attribution,
    requiresAttribution: !['cc0', 'pdm'].includes(r.license)
  }
}

async function openverse(kind: 'image' | 'audio', query: string, orientation?: Orientation): Promise<StockResult[]> {
  const p = new URLSearchParams({ q: query, license_type: 'commercial', page_size: '20', mature: 'false' })
  if (kind === 'image' && orientation) p.set('aspect_ratio', orientation === 'landscape' ? 'wide' : orientation === 'portrait' ? 'tall' : 'square')
  if (kind === 'image') p.set('size', 'large')
  const json = await getJSON<{ results: OvItem[] }>(`https://api.openverse.org/v1/${kind === 'image' ? 'images' : 'audio'}/?${p}`)
  return json.results.map((r) => ({
    provider: 'openverse' as const,
    id: `ov-${r.id}`,
    kind: kind === 'image' ? ('image' as const) : ('music' as const),
    title: r.title || query,
    thumb: r.thumbnail ?? r.url,
    downloadUrl: r.url,
    pageUrl: r.foreign_landing_url ?? r.url,
    width: r.width,
    height: r.height,
    durationSec: r.duration ? r.duration / 1000 : undefined,
    license: ovLicense(r)
  }))
}

// ---------------- Pexels ----------------

const PEXELS_LICENSE = (author: string): AssetLicense => ({
  name: 'Pexels License',
  url: 'https://www.pexels.com/license/',
  author,
  attribution: `Photo by ${author} on Pexels`,
  requiresAttribution: false
})

async function pexelsPhotos(key: string, query: string, orientation?: Orientation): Promise<StockResult[]> {
  const p = new URLSearchParams({ query, per_page: '20' })
  if (orientation) p.set('orientation', orientation)
  const json = await getJSON<{
    photos: Array<{ id: number; width: number; height: number; url: string; alt?: string; photographer: string; src: Record<string, string> }>
  }>(`https://api.pexels.com/v1/search?${p}`, { Authorization: key })
  return json.photos.map((r) => ({
    provider: 'pexels' as const,
    id: `px-${r.id}`,
    kind: 'image' as const,
    title: r.alt || query,
    thumb: r.src.medium ?? r.src.small,
    downloadUrl: r.src.large2x ?? r.src.original,
    pageUrl: r.url,
    width: r.width,
    height: r.height,
    license: PEXELS_LICENSE(r.photographer)
  }))
}

async function pexelsVideos(key: string, query: string, orientation?: Orientation): Promise<StockResult[]> {
  const p = new URLSearchParams({ query, per_page: '15' })
  if (orientation) p.set('orientation', orientation)
  const json = await getJSON<{
    videos: Array<{
      id: number
      width: number
      height: number
      duration: number
      url: string
      image: string
      user: { name: string }
      video_files: Array<{ link: string; width: number; height: number; file_type: string }>
    }>
  }>(`https://api.pexels.com/videos/search?${p}`, { Authorization: key })
  return json.videos.map((v) => {
    // the 1080p-ish mp4, not the 4K monster
    const files = v.video_files.filter((f) => f.file_type === 'video/mp4').sort((a, b) => Math.abs(a.height - 1080) - Math.abs(b.height - 1080))
    return {
      provider: 'pexels' as const,
      id: `pxv-${v.id}`,
      kind: 'video' as const,
      title: query,
      thumb: v.image,
      downloadUrl: files[0]?.link ?? '',
      pageUrl: v.url,
      width: files[0]?.width ?? v.width,
      height: files[0]?.height ?? v.height,
      durationSec: v.duration,
      license: { ...PEXELS_LICENSE(v.user.name), attribution: `Video by ${v.user.name} on Pexels` }
    }
  })
}

// ---------------- Pixabay ----------------

const PIXABAY_LICENSE = (author: string): AssetLicense => ({
  name: 'Pixabay Content License',
  url: 'https://pixabay.com/service/license-summary/',
  author,
  attribution: `by ${author} on Pixabay`,
  requiresAttribution: false
})

async function pixabay(kind: 'image' | 'video', key: string, query: string, orientation?: Orientation): Promise<StockResult[]> {
  const p = new URLSearchParams({ key, q: query.slice(0, 100), per_page: '20', safesearch: 'true' })
  if (kind === 'image') {
    p.set('image_type', 'photo')
    if (orientation && orientation !== 'square') p.set('orientation', orientation === 'landscape' ? 'horizontal' : 'vertical')
    const json = await getJSON<{
      hits: Array<{ id: number; pageURL: string; tags: string; webformatURL: string; largeImageURL: string; imageWidth: number; imageHeight: number; user: string }>
    }>(`https://pixabay.com/api/?${p}`)
    return json.hits.map((h) => ({
      provider: 'pixabay' as const,
      id: `pb-${h.id}`,
      kind: 'image' as const,
      title: h.tags || query,
      thumb: h.webformatURL,
      downloadUrl: h.largeImageURL,
      pageUrl: h.pageURL,
      width: h.imageWidth,
      height: h.imageHeight,
      license: PIXABAY_LICENSE(h.user)
    }))
  }
  const json = await getJSON<{
    hits: Array<{ id: number; pageURL: string; tags: string; duration: number; user: string; videos: Record<string, { url: string; width: number; height: number; thumbnail?: string }> }>
  }>(`https://pixabay.com/api/videos/?${p}`)
  return json.hits
    .map((h) => {
      const v = h.videos.large?.url ? h.videos.large : h.videos.medium
      return {
        provider: 'pixabay' as const,
        id: `pbv-${h.id}`,
        kind: 'video' as const,
        title: h.tags || query,
        thumb: v?.thumbnail ?? h.videos.small?.thumbnail ?? '',
        downloadUrl: v?.url ?? '',
        pageUrl: h.pageURL,
        width: v?.width,
        height: v?.height,
        durationSec: h.duration,
        license: PIXABAY_LICENSE(h.user)
      }
    })
    .filter((r) => !orientation || !r.width || !r.height || (orientation === 'landscape' ? r.width > r.height : orientation === 'portrait' ? r.height > r.width : true))
}

/** search every connector that can serve this kind; one failing source never sinks the others */
export async function searchStock(
  kind: AssetKind,
  query: string,
  opts: { orientation?: Orientation; pexelsKey?: string; pixabayKey?: string } = {}
): Promise<{ results: StockResult[]; errors: string[] }> {
  const jobs: Array<Promise<StockResult[]>> = []
  if (kind === 'image') {
    if (opts.pexelsKey) jobs.push(pexelsPhotos(opts.pexelsKey, query, opts.orientation))
    if (opts.pixabayKey) jobs.push(pixabay('image', opts.pixabayKey, query, opts.orientation))
    jobs.push(openverse('image', query, opts.orientation))
  } else if (kind === 'video') {
    if (opts.pexelsKey) jobs.push(pexelsVideos(opts.pexelsKey, query, opts.orientation))
    if (opts.pixabayKey) jobs.push(pixabay('video', opts.pixabayKey, query, opts.orientation))
  } else if (kind === 'music' || kind === 'sfx') {
    jobs.push(openverse('audio', query))
  }
  const settled = await Promise.allSettled(jobs)
  const results: StockResult[] = []
  const errors: string[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value.filter((r) => r.downloadUrl))
    else errors.push(String((s.reason as Error)?.message ?? s.reason))
  }
  if (kind === 'video' && !opts.pexelsKey && !opts.pixabayKey) errors.push('Add a free Pexels or Pixabay key in Settings to search video clips')
  if (kind === 'image' && !opts.pexelsKey && !opts.pixabayKey && results.length === 0) errors.push('Tip: a free Pexels or Pixabay key gives far better photos')
  // interleave providers so the best of each shows first
  return { results, errors }
}

const MAX_BYTES = 120 * 1024 * 1024

/** download a stock result into the library (images are re-encoded, which also proves they are images) */
export async function downloadStock(library: AssetLibrary, r: StockResult, extraTags: string[] = []): Promise<AssetMeta> {
  const res = await fetch(r.downloadUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_BYTES) throw new Error('file is too large (over 120 MB)')
  let buf: Buffer = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_BYTES) throw new Error('file is too large (over 120 MB)')
  let ext = '.bin'
  let width = r.width
  let height = r.height
  if (r.kind === 'image') {
    const img = sharp(buf).rotate().resize({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true })
    buf = await img.jpeg({ quality: 90 }).toBuffer()
    const m = await sharp(buf).metadata()
    width = m.width
    height = m.height
    ext = '.jpg'
  } else if (r.kind === 'video') {
    ext = '.mp4'
  } else {
    const type = res.headers.get('content-type') ?? ''
    ext = /mpeg|mp3/.test(type) ? '.mp3' : /ogg/.test(type) ? '.ogg' : /wav/.test(type) ? '.wav' : /flac/.test(type) ? '.flac' : '.mp3'
  }
  return library.add(buf, ext, {
    kind: r.kind,
    source: 'stock',
    title: r.title.slice(0, 120),
    tags: [...new Set([...tokenize(r.title), ...extraTags])].slice(0, 24),
    width,
    height,
    durationSec: r.durationSec,
    license: r.license,
    extra: { stockProvider: r.provider, stockId: r.id, page: r.pageUrl }
  })
}
