import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findChrome, findHeadlessShell } from '../src/main/appRecon/browser'
import { readSite, servicesByRule, unifiedMd } from '../src/main/marketing/crawl'
import { normalizeDomain } from '../src/shared/marketing'
import { startBizSite, type BizSite } from './fixtures/bizSite'

/** the site reader: a domain becomes safe, the home page and the services pages become markdown, and the brand is taken */

describe('the domain a person typed', () => {
  it('becomes one site address, whatever shape it arrived in', () => {
    expect(normalizeDomain('example.com')).toEqual({ ok: true, url: 'https://example.com/', host: 'example.com' })
    expect(normalizeDomain('https://www.example.com/pricing?x=1')).toEqual({ ok: true, url: 'https://example.com/', host: 'example.com' })
    expect(normalizeDomain('  EXAMPLE.COM ')).toEqual({ ok: true, url: 'https://example.com/', host: 'example.com' })
  })

  it('refuses what a website never is', () => {
    expect(normalizeDomain('').ok).toBe(false)
    expect(normalizeDomain('not a website').ok).toBe(false)
    expect(normalizeDomain('localhost:3000').ok).toBe(false)
    expect(normalizeDomain('http://127.0.0.1/').ok).toBe(false)
    expect(normalizeDomain('http://192.168.1.4/').ok).toBe(false)
    expect(normalizeDomain('file:///C:/x').ok).toBe(false)
    // a test may read a local server; a person's read may not
    expect(normalizeDomain('localhost:3000', true).ok).toBe(true)
  })

  it('picks the services pages by rule and skips the noise', () => {
    const links = [
      { href: 'https://x.test/services', text: 'Our services' },
      { href: 'https://x.test/garden-care', text: 'Garden care plans' },
      { href: 'https://x.test/blog/autumn', text: 'Blog' },
      { href: 'https://x.test/contact', text: 'Contact' },
      { href: 'https://x.test/', text: 'Home' },
      { href: 'https://other.test/services', text: 'Theirs' }
    ]
    const picked = servicesByRule(links, 4)
    expect(picked).toContain('https://x.test/services')
    expect(picked).toContain('https://x.test/garden-care')
    expect(picked.join(' ')).not.toMatch(/blog|contact|other\.test/)
  })
})

describe('the unified markdown of a read', () => {
  it('carries the home page and every services page under its own heading', () => {
    const md = unifiedMd({
      home: { url: 'https://x.test/', title: 'X — done right', md: '# Done right\n\nWe do things.' },
      pages: [{ url: 'https://x.test/services', title: 'Services — X', md: '## Services\n\nOne and two.' }],
      brand: { colors: [], notes: [] },
      taglineCandidates: [],
      notes: []
    })
    expect(md).toMatch(/^# X/m)
    expect(md).toMatch(/## Homepage/)
    expect(md).toMatch(/## Services — X/)
    expect(md).toContain('(https://x.test/services)')
    expect(md).toContain('We do things.')
  })
})

const canRead = !!findChrome() || !!findHeadlessShell()
describe.skipIf(!canRead)('reading a whole business site (headless browser)', () => {
  let site: BizSite
  let root: string
  beforeAll(async () => {
    site = await startBizSite()
    root = mkdtempSync(join(tmpdir(), 'vg-biz-'))
  }, 30000)
  afterAll(async () => {
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  it('reads the home page and the services pages as markdown, takes the brand, and skips the blog', async () => {
    const got = await readSite(site.url, { dir: root, allowPrivate: true, maxPages: 3, log: () => undefined })
    // home + the services pages the navigation names; the blog and contact are left out
    expect(got.home.md).toMatch(/gardens that take care of themselves/i)
    expect(got.home.md).not.toMatch(/Follow us/) // the footer is not content
    const urls = got.pages.map((p) => p.url)
    expect(urls).toContain(`${site.url}/garden-design`)
    expect(urls).toContain(`${site.url}/garden-care`)
    expect(urls.join(' ')).not.toMatch(/blog|contact/)
    // each page's content came through as markdown with its headings
    expect(got.pages[0].md).toMatch(/^## |^# /m)
    // the tagline candidates are the site's own meta text
    expect(got.taglineCandidates.join(' ')).toMatch(/Garden design and care/i)
    // the brand: the site's theme colour, and its accent safe on a dark card
    expect(got.brand.colors.map((c) => c.toLowerCase())).toContain('#1a5c1a')
    expect(got.brand.accent).toBeTruthy()
    // the unified file has a section per page
    const md = unifiedMd(got)
    expect(md.match(/^## /gm)?.length).toBeGreaterThanOrEqual(got.pages.length + 1)
  }, 180000)

  it('the writer only ever picks addresses the site actually has', async () => {
    const asked: string[] = []
    const chat = {
      generateJSON: async (req: { prompt: string; schemaName?: string }) => {
        asked.push(req.prompt)
        if (req.schemaName === 'service_pages') return { pages: ['https://evil.test/services', `${site.url}/garden-care`] }
        throw new Error('unexpected call')
      }
    } as never
    const got = await readSite(site.url, { dir: root, allowPrivate: true, maxPages: 4, chat, log: () => undefined })
    expect(asked.join(' ')).not.toMatch(/evil\.test/)
    expect(got.pages.map((p) => p.url)).not.toContain('https://evil.test/services')
    expect(got.pages.map((p) => p.url)).toContain(`${site.url}/garden-care`)
  }, 180000)

  it('reads at most the pages asked for', async () => {
    const got = await readSite(site.url, { dir: root, allowPrivate: true, maxPages: 1, log: () => undefined })
    expect(got.pages).toHaveLength(1)
  }, 120000)
})
