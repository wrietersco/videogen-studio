import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fetchLogoFile } from '../appRecon/siteBrand'
import type { ServiceInfo } from '@shared/marketing'

/**
 * The business's own product and service pictures, taken from the pages
 * that were read: product photos with their alt text and the heading they
 * sit under, the page's share picture (og:image) and gallery pictures.
 * Icons, tiny pictures, sprites, banners and the logo are left out. The
 * useful ones are saved into the business folder so the films can show the
 * real product instead of a stock-looking picture.
 */

/** one picture as the page shows it, before anything is fetched */
export interface PictureSpot {
  /** the best address for the picture (the largest one the page offers) */
  src: string
  alt: string
  /** the heading or caption the picture sits under */
  near: string
  /** the file's own size, when the page has loaded it (0 = unknown) */
  w: number
  h: number
  /** the size it is shown at on the page */
  rw: number
  rh: number
  /** in the header, the navigation or the footer */
  chrome: boolean
  /** marked as a logo, an icon, an avatar or a badge */
  logoish: boolean
  /** the page's own share picture */
  og?: boolean
  /** inside something that looks like a product, a gallery or a figure */
  producty: boolean
}

/** a picture kept for the films */
export interface SavedPicture {
  file: string
  /** where it came from */
  url: string
  /** the page it was found on */
  page: string
  alt: string
  near: string
  width: number
  height: number
}

/** most pictures kept per business */
export const MAX_PICTURES = 12
/** a picture smaller than this on its short side is an icon or a thumbnail */
const MIN_EDGE = 240
/** the longest side a kept picture is saved at */
const SAVE_EDGE = 1600

/**
 * Runs inside the page: every picture worth a look, with the words around it.
 * The page is scrolled first so pictures that load late are there.
 */
export const PICTURE_PROBE = String.raw`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const h0 = document.documentElement.scrollHeight;
  for (let y = 0, n = 0; y < Math.min(h0, 9000) && n < 10; y += Math.max(400, innerHeight * 0.9), n++) { scrollTo(0, y); await sleep(90); }
  scrollTo(0, 0); await sleep(120);
  const LOGO = /logo|brand|icon|avatar|badge|sprite|favicon|emoji|flag|payment|visa|mastercard|paypal|facebook|twitter|instagram|linkedin|youtube|tiktok|whatsapp|pinterest|google-?play|app-?store|placeholder|spinner|loader|pixel|tracking/i;
  const PRODUCT = /product|item|card|gallery|portfolio|menu|shop|collection|grid|slide|carousel|figure|feature|service|offer|thumb|woocommerce|swiper/i;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const cls = (el) => typeof el.className === 'string' ? el.className : ((el.className && el.className.baseVal) || '');
  const biggest = (set) => {
    if (!set) return '';
    let best = '', bw = 0;
    for (const part of set.split(',')) {
      const [u, d] = part.trim().split(/\s+/);
      const w = d ? parseFloat(d) * (d.endsWith('x') ? 1000 : 1) : 1;
      if (u && w >= bw) { best = u; bw = w; }
    }
    return best;
  };
  const textOf = (el) => (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const nearOf = (img) => {
    const fig = img.closest('figure');
    if (fig) { const c = fig.querySelector('figcaption'); if (c && textOf(c)) return textOf(c); }
    let el = img;
    for (let up = 0; up < 5 && el && el !== document.body; up++, el = el.parentElement) {
      const h = el.querySelector && el.querySelector('h1,h2,h3,h4,h5,h6,[class*=title],[class*=name]');
      if (h && h !== img && textOf(h)) return textOf(h);
    }
    let prev = img.closest('section,article,div');
    for (let n = 0; prev && n < 3; n++) {
      let p = prev.previousElementSibling;
      while (p && !/^H[1-6]$/.test(p.tagName)) p = p.previousElementSibling;
      if (p) return textOf(p);
      prev = prev.parentElement;
    }
    return '';
  };
  const out = [];
  const seen = new Set();
  for (const img of document.querySelectorAll('img')) {
    const cs = getComputedStyle(img);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || biggest(img.getAttribute('data-srcset') || '');
    let src = biggest(img.getAttribute('srcset') || '') || img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) src = lazy || src;
    src = abs(src);
    if (!src || src.startsWith('data:image/gif') || seen.has(src)) continue;
    seen.add(src);
    const r = img.getBoundingClientRect();
    const attrs = [img.id, cls(img), img.getAttribute('alt') || '', src, cls(img.parentElement || img)].join(' ');
    let box = img, producty = false;
    for (let up = 0; up < 6 && box; up++, box = box.parentElement) { if (PRODUCT.test(cls(box)) || box.tagName === 'FIGURE' || box.tagName === 'ARTICLE') { producty = true; break; } }
    out.push({
      src, alt: (img.getAttribute('alt') || '').replace(/\s+/g, ' ').trim().slice(0, 120), near: nearOf(img),
      w: img.naturalWidth || 0, h: img.naturalHeight || 0, rw: Math.round(r.width), rh: Math.round(r.height),
      chrome: !!img.closest('header,nav,footer,[role=banner],[role=navigation],[class*=header],[class*=navbar],[class*=footer],[id*=header],[id*=footer]'),
      logoish: LOGO.test(attrs), producty
    });
    if (out.length >= 80) break;
  }
  const og = document.querySelector('meta[property="og:image"],meta[name="og:image"],meta[name="twitter:image"]');
  if (og && og.content) { const u = abs(og.content); if (u && !seen.has(u)) out.push({ src: u, alt: '', near: (document.querySelector('meta[property="og:title"]') || {}).content || document.title || '', w: 0, h: 0, rw: 0, rh: 0, chrome: false, logoish: LOGO.test(u), producty: true, og: true }); }
  return out;
})()`

/** how promising a spot looks before it is fetched; below zero = never fetched */
export function spotScore(s: PictureSpot, logoUrl?: string): number {
  if (s.logoish || (logoUrl && s.src === logoUrl)) return -1
  if (/\.svg(\?|$)/i.test(s.src) || /\.ico(\?|$)/i.test(s.src)) return -1
  // known small or banner-shaped: an icon, a spacer, a sprite strip
  if (s.w && s.h && (Math.min(s.w, s.h) < MIN_EDGE || Math.max(s.w, s.h) / Math.min(s.w, s.h) > 3)) return -1
  if (!s.og && s.rw && s.rh && (Math.min(s.rw, s.rh) < 90 || Math.max(s.rw, s.rh) / Math.min(s.rw, s.rh) > 3.2)) return -1
  if (s.chrome && !s.producty) return -1
  let score = 1
  if (s.alt.length > 3) score += 2
  if (s.near) score += 1
  if (s.producty) score += 2
  if (s.og) score += 1
  score += Math.min(3, ((s.rw || s.w) * (s.rh || s.h)) / 200000)
  return score
}

/** an 8×8 brightness fingerprint, so the same photo at two sizes is kept once */
async function fingerprint(buf: Buffer): Promise<bigint> {
  const sharp = (await import('sharp')).default
  const px = await sharp(buf).flatten({ background: '#fff' }).grayscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer()
  const mean = px.reduce((a, b) => a + b, 0) / px.length
  let bits = 0n
  for (let i = 0; i < 64; i++) if (px[i] > mean) bits |= 1n << BigInt(i)
  return bits
}
const distance = (a: bigint, b: bigint): number => {
  let x = a ^ b
  let n = 0
  while (x) { n += Number(x & 1n); x >>= 1n }
  return n
}

export interface SaveOptions {
  dir: string
  siteHost: string
  /** the logo's own address, never kept as a product */
  logoUrl?: string
  max?: number
  log?: (m: string) => void
  /** test hook: fetch a picture */
  fetchFile?: (url: string) => Promise<Buffer>
}

/**
 * Fetches the best spots and keeps the useful ones: real photos, big enough,
 * not stretched into a banner, each kept once. Saved as JPEG (or PNG when the
 * picture is a cut-out with a clear background) at most 1600 px on a side.
 */
export async function savePictures(spots: Array<PictureSpot & { page: string }>, opts: SaveOptions): Promise<SavedPicture[]> {
  const sharp = (await import('sharp')).default
  const max = opts.max ?? MAX_PICTURES
  const get = opts.fetchFile ?? ((u: string) => fetchLogoFile(u, opts.siteHost))
  const ranked = spots
    .map((s) => ({ s, score: spotScore(s, opts.logoUrl) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  const seenUrl = new Set<string>()
  const prints: bigint[] = []
  const out: SavedPicture[] = []
  const folder = join(opts.dir, 'pictures')
  let tries = 0
  for (const { s } of ranked) {
    if (out.length >= max || tries >= max * 3) break
    // the same picture at two sizes often differs only in its query (?w=300)
    const key = s.src.replace(/[?#].*$/, '').replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, '')
    if (seenUrl.has(key)) continue
    seenUrl.add(key)
    tries++
    try {
      const buf = await get(s.src)
      const img = sharp(buf, { animated: false })
      const meta = await img.metadata()
      const w = meta.width ?? 0
      const h = meta.height ?? 0
      if (meta.format === 'svg' || Math.min(w, h) < MIN_EDGE || Math.max(w, h) / Math.max(1, Math.min(w, h)) > 3) continue
      // a flat picture (one colour, a placeholder) says nothing about the product
      const stats = await sharp(buf).stats()
      if (stats.channels.slice(0, 3).every((c) => c.stdev < 6)) continue
      const print = await fingerprint(buf)
      if (prints.some((p) => distance(p, print) <= 5)) continue
      prints.push(print)
      mkdirSync(folder, { recursive: true })
      const cutout = !!meta.hasAlpha && (await clearCorners(buf))
      const file = join(folder, `picture-${String(out.length + 1).padStart(2, '0')}.${cutout ? 'png' : 'jpg'}`)
      const sized = sharp(buf).rotate().resize({ width: SAVE_EDGE, height: SAVE_EDGE, fit: 'inside', withoutEnlargement: true })
      const data = cutout ? await sized.png().toBuffer({ resolveWithObject: true }) : await sized.flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer({ resolveWithObject: true })
      writeFileSync(file, data.data)
      out.push({ file, url: s.src, page: s.page, alt: s.alt, near: s.near, width: data.info.width, height: data.info.height })
    } catch (err) {
      opts.log?.(`  picture skipped (${String((err as Error)?.message ?? err).slice(0, 60)})`)
    }
  }
  return out
}

/** a cut-out: the four corners of the picture are see-through */
export async function clearCorners(buf: Buffer): Promise<boolean> {
  try {
    const sharp = (await import('sharp')).default
    const { data, info } = await sharp(buf).ensureAlpha().resize(32, 32, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
    const a = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3]
    return [a(0, 0), a(31, 0), a(0, 31), a(31, 31)].every((v) => v < 24)
  } catch {
    return false
  }
}

const stem = (w: string): string => (w.length > 5 ? w.replace(/(?:ing|ed|es|s)$/, '') : w)
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !/^(the|and|with|for|our|your|from|this|that|best|new)$/.test(w)).map(stem)
const samePage = (a: string, b: string): boolean => a.replace(/[?#].*$/, '').replace(/\/$/, '') === b.replace(/[?#].*$/, '').replace(/\/$/, '')

/** how well a picture's own words name a service (0 = not at all) */
export function nameMatch(service: { name: string }, pic: { alt: string; near: string; url: string }): number {
  const want = words(service.name)
  if (!want.length) return 0
  const got = new Set(words(`${pic.alt} ${pic.near} ${decodeURIComponent(pic.url.split('/').pop() ?? '').replace(/[-_.]/g, ' ')}`))
  return want.filter((w) => got.has(w)).length / want.length
}

/**
 * Which pictures belong to which service: a picture whose words name the
 * service belongs to it; a picture on the service's own page belongs to it
 * unless its words name another service. The rest are the business's
 * general product pictures. At most 4 per service.
 */
export function linkPictures(services: ServiceInfo[], pics: SavedPicture[], homeUrl?: string): { services: ServiceInfo[]; general: string[] } {
  const byService: string[][] = services.map(() => [])
  const general: string[] = []
  for (const pic of pics) {
    let best = -1
    let bestScore = 0
    services.forEach((sv, i) => {
      const m = nameMatch(sv, pic)
      if (m >= 0.5 && m > bestScore) { best = i; bestScore = m }
    })
    if (best < 0) {
      const own = services.findIndex((sv) => sv.url && samePage(sv.url, pic.page) && !(homeUrl && samePage(homeUrl, pic.page)))
      if (own >= 0) best = own
    }
    if (best >= 0 && byService[best].length < 4) byService[best].push(pic.file)
    else general.push(pic.file)
  }
  return {
    services: services.map((sv, i) => (byService[i].length ? { ...sv, images: byService[i] } : sv)),
    general
  }
}
