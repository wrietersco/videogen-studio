/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'puppeteer-core'
import { brandAccents, HEX } from '@shared/brand'
import { LogoError, MAX_LOGO_BYTES, prepareLogo, sniff, type PreparedLogo } from '../brand/logo'
import { lookFromPalette, type Look } from './style'

/**
 * The look of the website being recorded, taken from the website itself.
 *
 * The logo: the site's own file is tried first, up to three times (the best
 * guesses in order: a logo picture in the header, an inline drawing, a CSS
 * background, then the site icon). When none of the three can be fetched and
 * read, a picture of the logo as it appears on the page is taken instead.
 * The colours come from the logo, the page's theme colour, its colour
 * variables and its main button. All of it is measured on this computer; no
 * model sees the logo.
 */

export const LOGO_TRIES = 3

export interface LogoCandidate {
  kind: 'img' | 'svg' | 'icon' | 'text'
  /** where the file is (images, icons) */
  url?: string
  /** an inline drawing, as markup */
  svg?: string
  rect: { x: number; y: number; w: number; h: number }
  score: number
  /** what made this look like a logo */
  why: string
}

export interface PageSignals {
  candidates: LogoCandidate[]
  /** colours the page declares, as #rrggbb, most telling first */
  colors: string[]
  /** the first header-like box, for a picture when no logo was found */
  header: { x: number; y: number; w: number; h: number } | null
  title: string
}

const PROBE = String.raw`(() => {
  scrollTo(0, 0);
  const shown = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const SOCIAL = /facebook|twitter|instagram|linkedin|youtube|github|tiktok|whatsapp|pinterest|telegram|google-?play|app-?store|badge|avatar|profile|flag|payment|visa|mastercard/i;
  const LOGOISH = /logo|brand|wordmark|site-title|navbar-brand/i;
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return ''; } };
  const cls = (el) => typeof el.className === 'string' ? el.className : ((el.className && el.className.baseVal) || '');
  const attrs = (el) => [el.id, cls(el), el.getAttribute('alt') || '', el.getAttribute('src') || '', el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('data-testid') || ''].join(' ');
  const home = (el) => { const a = el.closest('a[href]'); if (!a) return false; try { const u = new URL(a.href); return u.origin === location.origin && (u.pathname === '/' || u.pathname === ''); } catch { return false; } };
  const inHead = (el) => !!el.closest('header,nav,[role=banner],[class*=header],[class*=navbar],[id*=header],[class*=topbar]');
  const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
  const score = (el, r, a) => {
    let s = 0;
    if (LOGOISH.test(a)) s += 5;
    if (inHead(el)) s += 3;
    if (home(el)) s += 3;
    if (r.y < 200) s += 2;
    if (r.x < innerWidth * 0.5) s += 1;
    if (r.width < 20 || r.height < 10) s -= 6;
    if (r.width > 700 || r.height > 300) s -= 4;
    if (SOCIAL.test(a)) s -= 8;
    return s;
  };
  const out = [];
  for (const el of document.querySelectorAll('img')) {
    if (!shown(el)) continue;
    const src = el.currentSrc || el.src;
    if (!src) continue;
    const r = el.getBoundingClientRect(); const a = attrs(el);
    out.push({ kind: 'img', url: abs(src), rect: box(el), score: score(el, r, a), why: LOGOISH.test(a) ? 'a picture marked as the logo' : inHead(el) ? 'a picture in the header' : 'a picture' });
  }
  for (const el of document.querySelectorAll('svg')) {
    if (!shown(el) || el.closest('svg') !== el || el.querySelector('use')) continue;
    const r = el.getBoundingClientRect(); const a = attrs(el) + ' ' + attrs(el.parentElement || el);
    if (!(LOGOISH.test(a) || (inHead(el) && home(el)))) continue;
    if (r.width > 700 || r.height > 300) continue;
    let markup = new XMLSerializer().serializeToString(el);
    if (!/viewBox=/.test(markup)) markup = markup.replace('<svg', '<svg viewBox="0 0 ' + Math.round(r.width) + ' ' + Math.round(r.height) + '"');
    if (!/ width=/.test(markup.slice(0, 200))) markup = markup.replace('<svg', '<svg width="' + Math.round(r.width) + '" height="' + Math.round(r.height) + '"');
    out.push({ kind: 'svg', svg: markup.slice(0, 400000), rect: box(el), score: score(el, r, a) + 1, why: 'a drawing in the header' });
  }
  for (const el of document.querySelectorAll('[class*=logo],[id*=logo],[class*=brand],[id*=brand]')) {
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect(); const a = attrs(el);
    const bg = getComputedStyle(el).backgroundImage;
    const m = /url\(["']?([^"')]+)["']?\)/.exec(bg || '');
    if (m && !/^(?:linear|radial)/.test(bg)) { out.push({ kind: 'img', url: abs(m[1]), rect: box(el), score: score(el, r, a), why: 'a background picture marked as the logo' }); continue; }
    const txt = (el.innerText || '').replace(/\s+/g, ' ').trim();
    if (txt && txt.length <= 40 && r.width < 500 && r.height < 160 && r.y < 200 && !el.querySelector('img,svg')) out.push({ kind: 'text', rect: box(el), score: score(el, r, a) - 1, why: 'the name written in the header' });
  }
  for (const el of document.querySelectorAll('link[rel~=icon],link[rel=apple-touch-icon],link[rel=apple-touch-icon-precomposed]')) {
    const href = el.getAttribute('href'); if (!href) continue;
    const sizes = parseInt((el.getAttribute('sizes') || '0').split('x')[0], 10) || 0;
    out.push({ kind: 'icon', url: abs(href), rect: { x: 0, y: 0, w: sizes, h: sizes }, score: -2 + Math.min(2, sizes / 128), why: 'the site icon' });
  }
  const toHex = (v) => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.clearRect(0, 0, 1, 1); x.fillStyle = '#010203'; x.fillStyle = v; x.fillRect(0, 0, 1, 1);
      const d = x.getImageData(0, 0, 1, 1).data;
      if (d[3] < 230) return '';
      return '#' + [d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, '0')).join('');
    } catch { return ''; }
  };
  const colors = [];
  const theme = document.querySelector('meta[name=theme-color]');
  if (theme && theme.content) colors.push(toHex(theme.content));
  const rs = getComputedStyle(document.documentElement);
  for (const n of ['--primary', '--primary-color', '--brand', '--brand-color', '--accent', '--accent-color', '--color-primary', '--color-brand', '--color-accent', '--main-color', '--theme-color']) {
    const v = rs.getPropertyValue(n).trim(); if (v) colors.push(toHex(v));
  }
  const btn = [...document.querySelectorAll('button,a,[role=button]')].find((el) => shown(el) && /primary|cta|btn-main|signup|get-started/i.test(attrs(el)));
  if (btn) colors.push(toHex(getComputedStyle(btn).backgroundColor));
  const head = document.querySelector('header,[role=banner],nav');
  if (head) colors.push(toHex(getComputedStyle(head).backgroundColor));
  const hb = head && shown(head) ? box(head) : null;
  return { candidates: out, colors: colors.filter(Boolean), header: hb, title: document.title };
})()`

export async function readSignals(page: Page): Promise<PageSignals> {
  const raw = (await page.evaluate(PROBE)) as PageSignals
  return { ...raw, candidates: [...raw.candidates].sort((a, b) => b.score - a.score) }
}

// ---------------------------------------------------------------- colours

const hsl = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const hi = Math.max(r, g, b)
  const lo = Math.min(r, g, b)
  const l = (hi + lo) / 2
  if (hi === lo) return [0, 0, l]
  const d = hi - lo
  return [0, l > 0.5 ? d / (2 - hi - lo) : d / (hi + lo), l]
}

/** a colour that says something about the brand: not white, black or a grey */
export const isBrandColour = (hex: string): boolean => {
  if (!HEX.test(hex)) return false
  const [, s, l] = hsl(hex)
  return s >= 0.22 && l >= 0.12 && l <= 0.88
}

/** the colours of a site, the logo's own first, with nothing grey in them */
export function paletteFor(logoColours: string[], pageColours: string[]): string[] {
  const out: string[] = []
  for (const c of [...logoColours, ...pageColours]) {
    const hex = c.toLowerCase()
    if (isBrandColour(hex) && !out.includes(hex)) out.push(hex)
  }
  return out.slice(0, 6)
}

// ---------------------------------------------------------------- getting the file

const PRIVATE_HOST = /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:)/i

/**
 * Fetch one logo file the way the page itself would (a plain GET, no cookies).
 * A file on a private address is only fetched when the site itself is there
 * (a company's own test server), never because a page pointed at one.
 */
export async function fetchLogoFile(url: string, siteHost: string, timeoutMs = 10000): Promise<Buffer> {
  if (url.startsWith('data:')) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url)
    if (!m) throw new Error('unreadable data address')
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
    if (buf.length > MAX_LOGO_BYTES) throw new Error('file too large')
    return buf
  }
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not a web address')
  if (PRIVATE_HOST.test(u.hostname) && u.hostname !== siteHost) throw new Error('a private address that is not the site itself')
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { accept: 'image/*,*/*;q=0.5' } })
  if (!res.ok) throw new Error(`the site answered ${res.status}`)
  const len = Number(res.headers.get('content-length') ?? 0)
  if (len > MAX_LOGO_BYTES) throw new Error('file too large')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_LOGO_BYTES) throw new Error('file too large')
  return buf
}

/** a logo worth using: readable, and not a speck */
function usable(p: PreparedLogo, c: LogoCandidate): string | null {
  const edge = Math.min(p.width, p.height)
  if (c.kind === 'icon' && Math.max(p.width, p.height) < 64) return 'the site icon is too small to use'
  if (p.format !== 'svg' && Math.max(p.width, p.height) < 32) return 'the picture is too small to use'
  if (edge < 8) return 'the picture is only a line'
  return null
}

// ---------------------------------------------------------------- the whole capture

export interface SiteBrand {
  /** the logo for dark cards, when one was found or photographed */
  logo?: string
  how?: 'file' | 'screenshot'
  /** where the file came from (the address, or what was photographed) */
  from?: string
  colors: string[]
  /** the accent for the cards: hex without #, readable on a dark card */
  accent?: string
  look?: Look
  notes: string[]
}

export interface SiteBrandOptions {
  dir: string
  siteHost: string
  log?: (m: string) => void
  /** test hook: fetch a logo file */
  fetchFile?: (url: string) => Promise<Buffer>
}

async function pictureOf(page: Page, rect: { x: number; y: number; w: number; h: number }): Promise<Buffer | null> {
  const vp = page.viewport() ?? { width: 1280, height: 720 }
  const pad = 6
  const x = Math.max(0, Math.floor(rect.x - pad))
  const y = Math.max(0, Math.floor(rect.y - pad))
  const w = Math.min(vp.width - x, Math.ceil(rect.w + pad * 2))
  const h = Math.min(vp.height - y, Math.ceil(rect.h + pad * 2))
  if (w < 12 || h < 8) return null
  const shot = await page.screenshot({ type: 'png', clip: { x, y, width: w, height: h } })
  return Buffer.from(shot)
}

export async function captureSiteBrand(page: Page, opts: SiteBrandOptions): Promise<SiteBrand> {
  const say = (m: string) => opts.log?.(`  brand: ${m}`)
  const notes: string[] = []
  const get = opts.fetchFile ?? ((u: string) => fetchLogoFile(u, opts.siteHost))
  let signals: PageSignals
  try {
    signals = await readSignals(page)
  } catch (err) {
    notes.push(`Branding from the website: the page could not be read (${(err as Error).message.slice(0, 80)}), so the video uses its normal look.`)
    return { colors: [], notes }
  }

  let prepared: PreparedLogo | undefined
  let how: SiteBrand['how']
  let from: string | undefined
  let tries = 0
  const seen = new Set<string>()
  const fails: string[] = []
  for (const c of signals.candidates) {
    if (prepared || tries >= LOGO_TRIES) break
    if (c.kind === 'text' || (c.score < -3 && c.kind !== 'icon')) continue
    const key = c.url ?? c.svg?.slice(0, 200) ?? ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    tries++
    try {
      const buf = c.kind === 'svg' ? Buffer.from(c.svg ?? '', 'utf8') : await get(c.url!)
      if (!sniff(buf)) throw new LogoError('it is not a picture')
      const p = await prepareLogo(buf)
      const bad = usable(p, c)
      if (bad) throw new LogoError(bad)
      prepared = p
      how = 'file'
      from = c.kind === 'svg' ? 'a drawing in the page' : c.url
      say(`try ${tries}: the site's own file (${c.why})`)
    } catch (err) {
      const why = err instanceof LogoError || err instanceof Error ? err.message.slice(0, 80) : 'failed'
      fails.push(`${c.kind === 'svg' ? 'inline drawing' : (c.url ?? '').split('/').pop()?.slice(0, 40) || c.kind}: ${why}`)
      say(`try ${tries} failed: ${why}`)
    }
  }

  if (!prepared) {
    // the file was not easy to get: a picture of the logo as the page shows it
    const target = signals.candidates.find((c) => c.kind !== 'icon' && c.score > 0 && c.rect.w >= 16 && c.rect.h >= 8 && c.rect.y < 400)
    const box = target?.rect ?? (signals.header ? { x: signals.header.x, y: signals.header.y, w: Math.min(signals.header.w, 320), h: Math.min(signals.header.h, 110) } : null)
    if (box) {
      try {
        const shot = await pictureOf(page, box)
        if (shot) {
          prepared = await prepareLogo(shot)
          how = 'screenshot'
          from = target ? `the ${target.why} on the page` : 'the top of the page'
          say(`took a picture of the logo (${from})`)
        }
      } catch (err) {
        say(`the picture of the logo could not be used: ${(err as Error).message.slice(0, 80)}`)
      }
    }
  }

  let logo: string | undefined
  if (prepared) {
    mkdirSync(join(opts.dir, 'brand'), { recursive: true })
    logo = join(opts.dir, 'brand', 'site-logo-ondark.png')
    writeFileSync(logo, prepared.onDark)
    writeFileSync(join(opts.dir, 'brand', 'site-logo-onlight.png'), prepared.onLight)
    notes.push(
      how === 'file'
        ? `Branding from the website: the site's own logo file was used${tries > 1 ? ` (found on try ${tries} of ${LOGO_TRIES})` : ''}.`
        : `Branding from the website: the logo file could not be fetched${tries ? ` in ${tries} ${tries === 1 ? 'try' : 'tries'}` : ' (none was on the page)'}, so a picture of the logo was taken from the page.`
    )
  } else {
    notes.push(`Branding from the website: no logo could be found${fails.length ? ` (${fails.join('; ')})` : ''}, so only its colours are used.`)
  }

  const colors = paletteFor(prepared?.palette ?? [], signals.colors)
  let accent: string | undefined
  let look: Look | undefined
  if (colors.length) {
    look = lookFromPalette(colors) ?? undefined
    accent = brandAccents({ primary: colors[0].toUpperCase() }, '#090D18').accent.replace('#', '')
    notes.push(`Colours from the website: ${colors.slice(0, 3).join(', ')}.`)
  } else notes.push('The website shows no brand colour (it is black, white and grey), so the cards keep their normal colour.')

  const result: SiteBrand = { logo, how, from, colors, accent, look, notes }
  try {
    mkdirSync(join(opts.dir, 'brand'), { recursive: true })
    writeFileSync(join(opts.dir, 'brand', 'site-brand.json'), JSON.stringify({ ...result, logo: logo ? 'brand/site-logo-ondark.png' : undefined, tries, failures: fails, title: signals.title }, null, 2))
  } catch {
    /* the record is only for looking at later */
  }
  return result
}
