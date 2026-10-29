import sharp from 'sharp'
import type { AssetKind, AssetLicense, AssetMeta } from '@shared/assets'
import { tokenize } from '@shared/assets'
import { orientationOf, type AssetLibrary } from '../assets/library'

/**
 * Free-licence stock connectors — official APIs only, no scraping:
 *   Openverse          (keyless; CC0 / CC BY images and audio, commercial-use filter)
 *   Wikimedia Commons  (keyless; CC / public-domain photos, huge documentary archive)
 *   Pexels             (free key; photos + video clips under the Pexels License)
 *   Pixabay            (free key; photos + video clips under the Pixabay Content License)
 * Results are ranked for relevance to the query (word coverage, orientation,
 * resolution, clip length) so the best match is first, and downloads land in
 * the asset library with their licence and credit line.
 */

export type StockProvider = 'openverse' | 'wikimedia' | 'pexels' | 'pixabay'

export interface StockResult {
  provider: StockProvider
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

// ---------------- queries + relevance ----------------

/** camera-direction words that hurt stock search more than they help */
const CAMERA_WORDS = new Set(
  'cinematic closeup close wide establishing broll b-roll footage clip video shot shots filming filmed slow motion pushing pulling drifting zooming panning handheld dramatic moody text-free textless'.split(
    ' '
  )
)

/**
 * A tight search phrase for stock APIs: the subject label when there is one
 * (the director's distilled subject), else the first content words of the
 * brief — with camera direction stripped, which stock libraries ignore anyway.
 */
export function stockQuery(subject?: string, brief?: string): string {
  const src = subject?.trim() || brief || ''
  const words = src
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !CAMERA_WORDS.has(w))
  return words.slice(0, 6).join(' ') || src.trim()
}

export interface RankOptions {
  orientation?: Orientation
  /** video clips shorter than this are pushed to the back (they can't fill the scene) */
  minDurationSec?: number
}

/** relevance of one result to the query, 0…~1.3 — higher is a better match */
export function stockRelevance(r: StockResult, queryTokens: string[], opts: RankOptions = {}): number {
  const words = new Set(tokenize(r.title))
  let covered = 0
  for (const w of queryTokens) if (words.has(w)) covered++
  let score = queryTokens.length ? covered / queryTokens.length : 0.5
  if (queryTokens.length > 1 && covered === queryTokens.length) score += 0.15 // every word present — near-exact
  const o = orientationOf(r.width, r.height)
  if (opts.orientation && o) score += o === opts.orientation ? 0.08 : -0.25
  const longEdge = Math.max(r.width ?? 0, r.height ?? 0)
  if (longEdge) score += longEdge >= 1600 ? 0.06 : longEdge < 640 ? -0.15 : 0
  if (r.kind === 'video' && opts.minDurationSec) score += (r.durationSec ?? 0) >= opts.minDurationSec ? 0.1 : -0.6
  return score
}

/** best match first; ties keep the provider order the connectors answered in */
export function rankStock(results: StockResult[], query: string, opts: RankOptions = {}): StockResult[] {
  const toks = [...new Set(tokenize(query))]
  return results
    .map((r, i) => ({ r, i, s: stockRelevance(r, toks, opts) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r)
}

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

// ---------------- Wikimedia Commons ----------------

interface WmPage {
  pageid?: number
  title?: string
  imageinfo?: Array<{
    url: string
    descriptionurl?: string
    thumburl?: string
    width: number
    height: number
    extmetadata?: Record<string, { value?: string }>
  }>
}

const stripHtml = (s?: string): string => (s ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim()

/** keyless photo search over Commons — the biggest freely-licensed archive there is */
export async function wikimediaImages(query: string, orientation?: Orientation): Promise<StockResult[]> {
  const p = new URLSearchParams({
    action: 'query',
    format: 'json',
    origin: '*',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: '20',
    prop: 'imageinfo',
    iiprop: 'url|size|extmetadata',
    iiurlwidth: '420'
  })
  const json = await getJSON<{ query?: { pages?: Record<string, WmPage> } }>(`https://commons.wikimedia.org/w/api.php?${p}`)
  return Object.values(json.query?.pages ?? {})
    .map((pg): StockResult | null => {
      const info = pg.imageinfo?.[0]
      if (!info || !/\.(jpe?g|png)$/i.test(info.url)) return null // skip tiffs/svgs — too heavy or unusable
      const title = (pg.title ?? query).replace(/^File:/i, '').replace(/\.(jpe?g|png|tiff?)$/i, '').replace(/[_-]+/g, ' ').trim()
      const meta = info.extmetadata ?? {}
      const rawLicense = stripHtml(meta.LicenseShortName?.value) || 'See file page'
      const free = /cc0|public domain/i.test(rawLicense)
      const author = stripHtml(meta.Artist?.value)
      return {
        provider: 'wikimedia',
        id: `wm-${pg.pageid ?? createHashSlug(info.url)}`,
        kind: 'image',
        title: title || query,
        thumb: info.thumburl ?? info.url,
        downloadUrl: info.url,
        pageUrl: info.descriptionurl ?? info.url,
        width: info.width,
        height: info.height,
        license: {
          name: free ? (/cc0/i.test(rawLicense) ? 'CC0' : 'Public Domain') : rawLicense,
          url: meta.LicenseUrl?.value || undefined,
          author: author || undefined,
          attribution: author ? `${title} — ${author} (Wikimedia Commons)` : undefined,
          requiresAttribution: !free
        }
      }
    })
    .filter((r): r is StockResult => r !== null)
}

function createHashSlug(url: string): string {
  let h = 0
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
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
  const p = new URLSearchParams({ query, per_page: '20' })
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
  opts: { orientation?: Orientation; minDurationSec?: number; pexelsKey?: string; pixabayKey?: string } = {}
): Promise<{ results: StockResult[]; errors: string[] }> {
  const jobs: Array<Promise<StockResult[]>> = []
  if (kind === 'image') {
    if (opts.pexelsKey) jobs.push(pexelsPhotos(opts.pexelsKey, query, opts.orientation))
    if (opts.pixabayKey) jobs.push(pixabay('image', opts.pixabayKey, query, opts.orientation))
    jobs.push(wikimediaImages(query, opts.orientation), openverse('image', query, opts.orientation))
  } else if (kind === 'video') {
    if (opts.pexelsKey) jobs.push(pexelsVideos(opts.pexelsKey, query, opts.orientation))
    if (opts.pixabayKey) jobs.push(pixabay('video', opts.pixabayKey, query, opts.orientation))
  } else if (kind === 'music' || kind === 'sfx') {
    jobs.push(openverse('audio', query))
  }
  const settled = await Promise.allSettled(jobs)
  const found: StockResult[] = []
  const errors: string[] = []
  for (const s of settled) {
    if (s.status === 'fulfilled') found.push(...s.value.filter((r) => r.downloadUrl))
    else errors.push(String((s.reason as Error)?.message ?? s.reason))
  }
  // sources overlap on CC photos — same file twice helps nobody
  const seen = new Set<string>()
  const unique = found.filter((r) => (seen.has(r.downloadUrl) ? false : (seen.add(r.downloadUrl), true)))
  // best match first everywhere: the router takes results[0], the library screen shows them top-down
  const results = rankStock(unique, query, { orientation: opts.orientation, minDurationSec: opts.minDurationSec })
  if (kind === 'video' && !opts.pexelsKey && !opts.pixabayKey) errors.push('Add a free Pexels or Pixabay key in Settings to search video clips')
  if (kind === 'image' && !opts.pexelsKey && !opts.pixabayKey && results.length === 0) errors.push('Tip: a free Pexels or Pixabay key gives far better photos')
  return { results, errors }
}

const MAX_BYTES = 120 * 1024 * 1024

/** download a stock result into the library (images are re-encoded, which also proves they are images) */
export async function downloadStock(
  library: AssetLibrary,
  r: StockResult,
  extraTags: string[] = [],
  opts: { /** exact-reuse key so the next identical brief finds it without the network */ key?: string } = {}
): Promise<AssetMeta> {
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
    key: opts.key,
    extra: { stockProvider: r.provider, stockId: r.id, page: r.pageUrl }
  })
}
