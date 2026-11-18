import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'puppeteer-core'
import { launch } from '../appRecon/browser'
import { openPage } from '../appRecon/explore'
import { captureSiteBrand, type SiteBrand } from '../appRecon/siteBrand'
import { scrubText } from '../appRecon/detect'
import { normalizeDomain } from '@shared/marketing'
import type { LLMProvider } from '../providers/types'
import { PICTURE_PROBE, savePictures, type PictureSpot, type SavedPicture } from './pictures'

/**
 * Reads a business's public website with the same Chromium the app uses for
 * recordings: the home page and the pages that describe its services, each as
 * clean markdown, plus the site's own look (logo, colours). Nothing is signed
 * in to, nothing is clicked; the pages are only read.
 */

export interface PageMd {
  url: string
  title: string
  /** the page's content as markdown (private data already scrubbed) */
  md: string
}

export interface SiteRead {
  home: PageMd
  pages: PageMd[]
  brand: SiteBrand
  /** candidate taglines: the meta description, the first headline, the title */
  taglineCandidates: string[]
  notes: string[]
  /** the business's own product and service pictures, saved in the business folder (absent on older reads) */
  pictures?: SavedPicture[]
}

export interface ReadOptions {
  dir: string
  /** the writer that helps tell service pages from blog posts and legal pages; null = rules only */
  chat?: LLMProvider | null
  /** pages beyond the home page (kept small: the person asked for a read, not a crawl) */
  maxPages?: number
  log?: (m: string) => void
  /** tests read a local server; a person's read always goes to the public site */
  allowPrivate?: boolean
  /** test hook: a page to read with (a local server), instead of launching Chromium */
  page?: (url: string) => Promise<Page>
  /** false = do not keep the site's product pictures (default: keep them) */
  pictures?: boolean
}

/** how many characters of one page are kept: plenty for a profile, small enough for any model */
const PAGE_CHARS = 12000
const MAX_LINKS = 60

/** words that name a services page, in the address or in the link's own words */
const SERVICE_WORDS = /service|solution|offering|what.?we.?do|capabilit|pricing|packages|plans\b|industries|treatments|classes|programs/i
/** pages that are real but say nothing about what the business does */
const SKIP_WORDS = /blog|news|article|post\b|careers?|jobs?|about\b|team|contact|legal|privacy|terms|cookie|login|signin|sign-in|account|cart|checkout|shop\b|store\b|gallery|portfolio|case-stud|testimonial|faq|support|help|wp-|\.pdf$/i

/**
 * The DOM of a rendered page as markdown. Walked inside the page itself, so
 * what you get is what the visitor sees: headings keep their level, lists
 * keep their bullets, nav menus, scripts and cookie banners are left out.
 */
const MD_WALK = `(() => {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','IFRAME','CANVAS','FORM','SELECT','OPTION','BUTTON','NAV','FOOTER','HEADER','ASIDE','DIALOG'])
  const out = []
  const text = (s) => (s || '').replace(/[\\t\\r ]+/g, ' ').trim()
  const walk = (el, depth) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) { const t = text(n.nodeValue); if (t) out.push(t); continue }
      if (n.nodeType !== 1) continue
      const tag = n.tagName
      if (SKIP.has(tag) || n.getAttribute('aria-hidden') === 'true') continue
      const style = window.getComputedStyle(n)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      if (tag === 'H1' || tag === 'H2' || tag === 'H3') { out.push('\\n' + '#'.repeat(+tag[1]) + ' ' + text(n.innerText) + '\\n'); continue }
      if (tag === 'H4' || tag === 'H5' || tag === 'H6') { out.push('\\n#### ' + text(n.innerText) + '\\n'); continue }
      if (tag === 'LI') { out.push('\\n' + '  '.repeat(depth) + '- ' + text(n.innerText)); continue }
      if (tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'FIGCAPTION') { const t = text(n.innerText); if (t) out.push('\\n' + t + '\\n'); continue }
      if (tag === 'BR') { out.push('\\n'); continue }
      if (tag === 'TR') { const cells = [...n.children].map((c) => text(c.innerText)).filter(Boolean); if (cells.length) out.push('\\n| ' + cells.join(' | ') + ' |'); continue }
      walk(n, tag === 'UL' || tag === 'OL' ? depth + 1 : depth)
    }
  }
  const main = document.querySelector('main') || document.querySelector('[role=main]') || document.body
  walk(main, 0)
  return out.join('').replace(/\\n{3,}/g, '\\n\\n').trim()
})()`

/** one page read: its content as markdown, plus every same-origin link with its own words */
async function readPage(page: Page): Promise<PageMd & { links: Array<{ href: string; text: string }> }> {
  const got = (await page.evaluate(`((() => {
    const md = ${MD_WALK}
    const here = new URL(location.href)
    const links = []
    const seen = new Set()
    for (const a of document.querySelectorAll('a[href]')) {
      let u
      try { u = new URL(a.href, location.href) } catch { continue }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
      if (u.hostname.replace(/^www\\./, '') !== here.hostname.replace(/^www\\./, '')) continue
      u.hash = ''
      u.search = ''
      const key = u.pathname.replace(/\\/$/, '')
      if (!key || key === '/' || seen.has(key)) continue
      seen.add(key)
      links.push({ href: u.toString(), text: (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60) })
    }
    return { url: location.href, title: document.title || '', md, links: links.slice(0, ${MAX_LINKS}) }
  })())`) as { url: string; title: string; md: string; links: Array<{ href: string; text: string }> })
  return { ...got, md: scrubText(String(got.md || '')).slice(0, PAGE_CHARS) }
}

/** candidate taglines straight from the page's own meta text */
const TAGLINES = `(() => ({
  title: document.title || '',
  description: (document.querySelector('meta[name="description"]') || {}).content || '',
  og: (document.querySelector('meta[property="og:description"]') || {}).content || '',
  h1: (document.querySelector('h1') || {}).innerText || ''
}))()`

function safeOrigin(u: string): string {
  try { return new URL(u).origin } catch { return '' }
}

/** pages that describe what the business sells, by rule: the words of the address or of the link itself */
export function servicesByRule(links: Array<{ href: string; text: string }>, max: number, origin?: string): string[] {
  const out: string[] = []
  const base = origin ?? (links[0] ? safeOrigin(links[0].href) : '')
  for (const l of links) {
    if (out.length >= max) break
    if (base && safeOrigin(l.href) !== base) continue
    if (SKIP_WORDS.test(l.href)) continue
    if (SERVICE_WORDS.test(l.href) || SERVICE_WORDS.test(l.text)) out.push(l.href)
  }
  return [...new Set(out)]
}

/** the writer's pick of service pages, from the links the home page actually has (never a new address) */
async function servicesByModel(chat: LLMProvider, links: Array<{ href: string; text: string }>, max: number, say: (m: string) => void): Promise<string[]> {
  try {
    const r = await chat.generateJSON<{ pages: string[] }>({
      system: 'You read the links of a business website to find the pages that describe what the business sells or does (services, solutions, offerings, pricing, programs). Never blog posts, news, careers, legal, login or case-study pages. Answer with addresses copied exactly from the list.',
      prompt: `Website links (address and the link's own words):\n${links.map((l) => `- ${l.href} — ${l.text || '(no text)'}`).join('\n')}\n\nList at most ${max} pages that describe services. Copy the addresses exactly as given.`,
      schemaName: 'service_pages',
      jsonSchema: { type: 'object', properties: { pages: { type: 'array', items: { type: 'string' } } }, required: ['pages'] },
      temperature: 0.2,
      maxTokens: 400
    })
    const given = new Set(links.map((l) => l.href))
    return [...new Set((r.pages ?? []).filter((p) => given.has(p)))].slice(0, max)
  } catch (err) {
    say(`the writer could not help pick the services pages (${(err as Error).message.slice(0, 80)}); the rules chose alone`)
    return []
  }
}

/** one site, read with whatever page is given: home, services pages, taglines, look */
async function readAll(page: Page, url: string, host: string, opts: ReadOptions): Promise<SiteRead> {
  const say = (m: string) => opts.log?.(m)
  const notes: string[] = []
  const maxPages = opts.maxPages ?? 6
  mkdirSync(opts.dir, { recursive: true })

  say(`opening ${url}`)
  await openPage(page, url, 30000)
  const home = await readPage(page)
  const spots: Array<PictureSpot & { page: string }> = []
  const lookForPictures = async (at: string): Promise<void> => {
    if (opts.pictures === false) return
    try {
      const got = (await page.evaluate(PICTURE_PROBE)) as PictureSpot[]
      for (const s of got ?? []) spots.push({ ...s, page: at })
    } catch (err) {
      say(`  pictures on ${at} could not be listed (${(err as Error).message.slice(0, 60)})`)
    }
  }
  await lookForPictures(home.url)
  const taglines = (await page.evaluate(TAGLINES)) as { title: string; description: string; og: string; h1: string }
  const brand = await captureSiteBrand(page, { dir: opts.dir, siteHost: host, log: opts.log })
  if (!home.md) notes.push('The home page had no readable text (it may need JavaScript the reader could not run), so the profile is built from its title alone.')

  const picks = servicesByRule(home.links, maxPages, safeOrigin(home.url))
  if (opts.chat && home.links.length) {
    const byModel = await servicesByModel(opts.chat, home.links, maxPages, say)
    picks.push(...byModel.filter((p) => !picks.includes(p)))
  }
  // services often live one page deeper: the services index names them, so its links are trusted too
  const seen = new Set<string>([home.url, ...picks])
  const queue = [...new Set(picks)].slice(0, maxPages)
  const pages: PageMd[] = []
  while (queue.length && pages.length < maxPages) {
    const u = queue.shift()!
    try {
      await openPage(page, u, 20000)
      const p = await readPage(page)
      pages.push({ url: p.url, title: p.title, md: p.md })
      await lookForPictures(p.url)
      for (const l of p.links) {
        if (queue.length + pages.length >= maxPages) break
        if (!seen.has(l.href) && !SKIP_WORDS.test(l.href)) {
          seen.add(l.href)
          queue.push(l.href)
        }
      }
    } catch (err) {
      notes.push(`The page ${u} could not be read (${(err as Error).message.slice(0, 80)}).`)
    }
  }
  say(`services pages: ${pages.length ? pages.map((p) => p.url).join(', ') : 'none found'}`)

  let pictures: SavedPicture[] = []
  if (spots.length) {
    pictures = await savePictures(spots, { dir: opts.dir, siteHost: host, logoUrl: brand.how === 'file' ? brand.from : undefined, log: opts.log })
    say(`product pictures kept: ${pictures.length} of ${spots.length} on the pages`)
  }

  const candidate = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 160)
  const taglineCandidates = [candidate(taglines.description), candidate(taglines.og), candidate(taglines.h1), candidate(taglines.title.split(/[|–—]/)[0])].filter((s, i, a) => s.length >= 8 && a.indexOf(s) === i)
  return { home: { url: home.url, title: home.title, md: home.md }, pages, brand, taglineCandidates, notes, pictures }
}

export async function readSite(domain: string, opts: ReadOptions): Promise<SiteRead> {
  const v = normalizeDomain(domain, opts.allowPrivate)
  if (!v.ok) throw new Error(v.error)
  if (opts.page) return readAll(await opts.page(v.url), v.url, v.host, opts)
  let browser: Awaited<ReturnType<typeof launch>> | null = null
  try {
    browser = await launch({ userDataDir: join(opts.dir, 'profile'), headless: true })
    const ctx = await browser.createBrowserContext()
    return await readAll(await ctx.newPage(), v.url, v.host, opts)
  } finally {
    await browser?.close().catch(() => undefined)
  }
}

/** the whole read as one structured markdown file, kept beside the profile */
export function unifiedMd(read: SiteRead): string {
  const name = read.home.title.split(/[|–—]/)[0].trim() || read.home.url
  const parts: string[] = [`# ${name}`, '', `Website: ${read.home.url}`, '', '## Homepage', '', `(${read.home.url})`, '', read.home.md || '(no readable text)', '']
  for (const p of read.pages) parts.push(`## ${p.title || p.url}`, '', `(${p.url})`, '', p.md || '(no readable text)', '')
  return parts.join('\n').slice(0, 60000)
}
