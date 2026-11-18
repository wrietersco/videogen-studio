import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { ffmpegBin } from '../src/main/audio/pcm'
import { findChrome, findHeadlessShell } from '../src/main/appRecon/browser'
import type { MediaTools } from '../src/main/appRecon/run'
import type { LLMProvider } from '../src/main/providers/types'
import { readSite } from '../src/main/marketing/crawl'
import { brandOf, stockFacts } from '../src/main/marketing/profile'
import { linkPictures, spotScore, type PictureSpot } from '../src/main/marketing/pictures'
import { renderProductScene } from '../src/main/marketing/productScene'
import { productPicker, runMarketingFilm } from '../src/main/marketing/film'
import type { BusinessProfile, VideoCard } from '../src/shared/marketing'
import { startProductSite, type ProductSite } from './fixtures/productSite'

/**
 * Films built around the business's own products: the site's product
 * pictures are kept (and the logo, icons and sprites are not), the product
 * scene animates the real photo, and the AI pictures are asked to show that
 * photo (and once, the logo on the packaging) when the model can look at it.
 */

const ff = (args: string[]) => {
  const r = spawnSync(ffmpegBin(), ['-y', '-v', 'error', ...args])
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-400))
}
const root = mkdtempSync(join(tmpdir(), 'vg-prod-'))
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }))

const spot = (o: Partial<PictureSpot>): PictureSpot => ({ src: 'https://x.test/a.jpg', alt: '', near: '', w: 0, h: 0, rw: 400, rh: 300, chrome: false, logoish: false, producty: false, ...o })

describe('which pictures are worth keeping (rules)', () => {
  it('leaves out logos, icons, drawings, banners and header pictures; prefers named product photos', () => {
    expect(spotScore(spot({ logoish: true }))).toBeLessThan(0)
    expect(spotScore(spot({ src: 'https://x.test/l.png' }), 'https://x.test/l.png')).toBeLessThan(0)
    expect(spotScore(spot({ src: 'https://x.test/a.svg' }))).toBeLessThan(0)
    expect(spotScore(spot({ w: 64, h: 64 }))).toBeLessThan(0)
    expect(spotScore(spot({ rw: 900, rh: 40 }))).toBeLessThan(0)
    expect(spotScore(spot({ chrome: true }))).toBeLessThan(0)
    expect(spotScore(spot({ alt: 'Cookie box', near: 'Cookie boxes', producty: true }))).toBeGreaterThan(spotScore(spot({})))
  })

  it('links each picture to the service it shows, by its words first and its page second', () => {
    const services = [
      { name: 'Cookie boxes', url: 'https://x.test/cookie-boxes', summary: '', benefits: [] },
      { name: 'Brownie trays', url: 'https://x.test/brownie-trays', summary: '', benefits: [] }
    ]
    const pic = (file: string, page: string, alt = '', near = '') => ({ file, url: `https://x.test/${file}`, page, alt, near, width: 900, height: 700 })
    const got = linkPictures(
      services,
      [pic('a.jpg', 'https://x.test/', 'Cookie box of twelve'), pic('b.jpg', 'https://x.test/brownie-trays'), pic('c.jpg', 'https://x.test/', '', 'Office party'), pic('d.jpg', 'https://x.test/brownie-trays', 'A cookie box')],
      'https://x.test/'
    )
    expect(got.services[0].images).toEqual(['a.jpg', 'd.jpg'])
    expect(got.services[1].images).toEqual(['b.jpg'])
    expect(got.general).toEqual(['c.jpg'])
  })
})

const canBrowse = !!findChrome() || !!findHeadlessShell()

describe.skipIf(!canBrowse)('taking the product pictures from a site (headless browser)', () => {
  let site: ProductSite
  beforeAll(async () => {
    site = await startProductSite()
  }, 30000)
  afterAll(async () => site?.close(), 30000)

  it('keeps the product photos once each, linked to their services, and leaves out the logo, icon, sprite and placeholder', async () => {
    const dir = join(root, 'read')
    const read = await readSite(site.url, { dir, allowPrivate: true, maxPages: 3, log: () => undefined })
    const urls = (read.pictures ?? []).map((p) => p.url.replace(site.url, ''))
    expect(urls.some((u) => u.startsWith('/img/box'))).toBe(true)
    expect(urls).toContain('/img/tray.jpg')
    expect(urls).toContain('/img/party.jpg')
    expect(urls).toContain('/img/og.jpg')
    expect(urls.join(' ')).not.toMatch(/logo|cart-icon|sprite|flat/)
    // the same cookie box at three addresses and two sizes is kept once
    expect(urls.filter((u) => u.startsWith('/img/box')).length).toBe(1)
    for (const p of read.pictures ?? []) {
      expect(existsSync(p.file)).toBe(true)
      expect(p.file.startsWith(join(dir, 'pictures'))).toBe(true)
    }
    const facts = stockFacts(read)
    const boxes = facts.services.find((s) => /cookie box/i.test(s.name))
    const trays = facts.services.find((s) => /brownie/i.test(s.name))
    expect(boxes?.images?.length).toBe(1)
    expect(trays?.images?.length).toBe(1)
    const brand = brandOf(read, facts.services)
    expect(brand.productImages?.length).toBe(2)
    // the read without pictures still works (and keeps none)
    const bare = await readSite(site.url, { dir: join(root, 'bare'), allowPrivate: true, maxPages: 1, pictures: false, log: () => undefined })
    expect(bare.pictures ?? []).toHaveLength(0)
  }, 180000)
})

/** a stand-in product photo and logo */
async function standIns(dir: string): Promise<{ photo: string; photo2: string; logo: string }> {
  mkdirSync(dir, { recursive: true })
  const svg = (hue: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="hsl(${hue},45%,80%)"/><circle cx="420" cy="460" r="230" fill="#c58a4a"/><rect x="640" y="260" width="420" height="380" rx="24" fill="#7a1f3d"/></svg>`
  const photo = join(dir, 'photo.jpg')
  const photo2 = join(dir, 'photo2.jpg')
  const logo = join(dir, 'logo.png')
  await sharp(Buffer.from(svg(30))).jpeg().toFile(photo)
  await sharp(Buffer.from(svg(200))).jpeg().toFile(photo2)
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="90"><rect x="10" y="10" width="280" height="70" rx="12" fill="#fff"/></svg>')).png().toFile(logo)
  return { photo, photo2, logo }
}

describe.skipIf(!canBrowse)('the product scene', () => {
  it('animates the real photo on the brand backdrop, wide and tall', async () => {
    const s = await standIns(join(root, 'scene'))
    for (const [n, size] of [['wide', { width: 1280, height: 720 }], ['tall', { width: 720, height: 1280 }]] as const) {
      const out = await renderProductScene(
        { images: [s.photo, s.photo2], name: 'Cookie boxes', line: 'Baked the same morning', pill: 'Bestseller', accent: 'e0a050', backdrop: ['#2a1410', '#120806'], logo: s.logo, durationSec: 2, size },
        join(root, `product-${n}.mp4`),
        { at: [0, 1.6], dir: join(root, `frames-${n}`) }
      )
      expect(existsSync(out.file)).toBe(true)
      expect(out.durationSec).toBeGreaterThanOrEqual(1.9)
      expect(out.stills).toHaveLength(2)
      // at the start the card is not in yet; once it has come in, the middle of the card is the photo's warm colours, not the dark backdrop
      const at = async (f: string, x: number, y: number) => {
        const { data, info } = await sharp(f).raw().toBuffer({ resolveWithObject: true })
        const i = (Math.round(y * info.height) * info.width + Math.round(x * info.width)) * info.channels
        return data[i] + data[i + 1] + data[i + 2]
      }
      const cx = n === 'wide' ? 0.32 : 0.5
      const cy = n === 'wide' ? 0.5 : 0.37
      expect(await at(out.stills[1], cx, cy)).toBeGreaterThan(await at(out.stills[0], cx, cy) + 120)
    }
  }, 180000)
})

describe.skipIf(!canBrowse)('a film around the business\'s own products (stand-in models)', () => {
  let s: { photo: string; photo2: string; logo: string }
  let profile: BusinessProfile
  const card: VideoCard = {
    id: 'card-prod01',
    title: 'The office treat that disappears first',
    problem: 'Office treats are an afterthought: stale biscuits nobody wants.',
    solution: 'Crumb & Co delivers fresh cookie boxes that everyone reaches for.',
    cta: 'Order a box',
    serviceIdx: 0,
    targetSec: 20
  }
  beforeAll(async () => {
    s = await standIns(join(root, 'film-assets'))
    profile = {
      id: 'biz-prod0001', domain: 'crumb.test', name: 'Crumb & Co', tagline: 'Cookies worth sharing', about: 'Small-batch cookies and brownies for offices and gifts in Lahore.',
      services: [
        { name: 'Cookie boxes', url: 'https://crumb.test/cookie-boxes', summary: 'Boxes of fresh cookies.', benefits: ['Packed the morning they are baked'], images: [s.photo] },
        { name: 'Brownie trays', url: 'https://crumb.test/brownie-trays', summary: 'Fudge brownie trays.', benefits: ['Sixteen squares a tray'] }
      ],
      brand: { colors: ['#7a1f3d'], accent: 'e0a050', backdrop: ['#2a1410', '#120806'], logoFile: s.logo, productImages: [s.photo2] },
      cards: [], siteMd: 'site.md', notes: [], createdAt: '2026-11-18T10:00:00Z', updatedAt: '2026-11-18T10:00:00Z'
    }
  })

  it('shares the photos out: a beat that names a service shows its photos, none shown more than twice', () => {
    const pick = productPicker(profile, card)
    expect(pick.any).toBe(true)
    const a = pick.forBeat('Our cookie boxes arrive fresh')
    expect(a?.name).toBe('Cookie boxes')
    expect(a?.images[0]).toBe(s.photo)
    pick.forBeat('Everyone reaches in')
    const third = pick.forBeat('Cookie boxes again')
    expect(third?.images ?? []).not.toContain(s.photo)
    // a profile read before pictures were kept has none
    expect(productPicker({ ...profile, services: profile.services.map(({ images: _i, ...sv }) => sv), brand: { colors: [] } }, card).any).toBe(false)
  })

  it('the free engine shows the real product in animated product scenes', async () => {
    const out = await runMarketingFilm({ runDir: join(root, 'free'), card, profile, chat: null, speech: null, tools: null, aiMusic: false, maxClips: 0, progress: () => undefined, log: () => undefined })
    expect(existsSync(out.file)).toBe(true)
    expect(out.elements).toContain('Product scenes (your own photos)')
    expect(existsSync(join(root, 'free', 'scene-product-1.mp4'))).toBe(true)
    // the honest report still covers every part
    expect(out.made.map((m) => m.id)).toContain('close')
    expect(out.made.filter((m) => m.made === 'scene').length).toBeGreaterThanOrEqual(3)
  }, 300000)

  it('AI pictures are given the product photo, and one the logo for branded packaging, when the model can look at pictures', async () => {
    const calls: Array<{ prompt: string; refs: string[] }> = []
    const reviews: Array<{ allowBrand?: boolean }> = []
    const tools: MediaTools = {
      stillTakesRefs: true,
      still: async (prompt, o) => {
        calls.push({ prompt, refs: o?.refs ?? [] })
        const file = join(root, `still-${calls.length}.jpg`)
        await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#a0603a' } }).jpeg().toFile(file)
        return { file, refsUsed: o?.refs?.length ?? 0 }
      },
      reviewStill: async (_f, o) => {
        reviews.push(o ?? {})
        return { ok: true }
      },
      clip: async (_p, seconds) => {
        const file = join(root, `clip-${Date.now()}.mp4`)
        ff(['-f', 'lavfi', '-i', `color=c=0x446688:size=1920x1080:rate=30:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
        return { file, durationSec: seconds }
      },
      music: async () => readFileSync(join(root, 'nope.mp3'))
    }
    const chat = {
      generateJSON: async (req: { schemaName?: string; system?: string }) => {
        if (req.schemaName === 'marketing_script')
          return {
            problemHeadline: 'Stale office treats',
            problemLine: 'Every office party ends with a tray of stale biscuits nobody touches, and the afternoon drags on.',
            beats: [
              { headline: 'Fresh cookie boxes', line: 'Crumb and Co cookie boxes are packed the same morning they are baked, still soft.', chapter: 'The fix' },
              { headline: 'Gone in minutes', line: 'Open the box at the meeting and watch every hand reach in before the slides start.', chapter: 'What you get' }
            ],
            close: 'Crumb and Co. Order a box today.'
          }
        if (req.schemaName === 'marketing_moments') {
          expect(req.system).toMatch(/OWN product/)
          return { beats: [] }
        }
        throw new Error(`unexpected ${req.schemaName}`)
      }
    } as unknown as LLMProvider
    const out = await runMarketingFilm({ runDir: join(root, 'ai'), card, profile, chat, speech: null, tools, aiMusic: false, maxClips: 0, progress: () => undefined, log: () => undefined })
    expect(existsSync(out.file)).toBe(true)
    const withPhoto = calls.filter((c) => c.refs.includes(s.photo) || c.refs.includes(s.photo2))
    expect(withPhoto.length).toBeGreaterThan(0)
    // exactly one branded shot carries the logo, and its check allows that logo
    const branded = calls.filter((c) => c.refs.includes(s.logo))
    expect(branded).toHaveLength(1)
    expect(branded[0].prompt).toMatch(/logo/)
    expect(reviews.filter((r) => r.allowBrand)).toHaveLength(1)
    // the stock shots are about the product in use, from its reference photo
    expect(calls.some((c) => /reference photo/.test(c.prompt))).toBe(true)
    expect(out.notes.join(' ')).toMatch(/made from your own product photo/)
    // the product opens a beat's montage
    expect(existsSync(join(root, 'ai', 'scene-product-1.mp4'))).toBe(true)
  }, 900000)

  it('says so when the picture model cannot look at the product photos', async () => {
    const calls: string[][] = []
    const tools: MediaTools = {
      still: async (_p, o) => {
        calls.push(o?.refs ?? [])
        const file = join(root, `wstill-${calls.length}.jpg`)
        await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#6a8a3a' } }).jpeg().toFile(file)
        return { file }
      },
      clip: async () => { throw new Error('no clips') },
      music: async () => Buffer.alloc(0)
    }
    const out = await runMarketingFilm({ runDir: join(root, 'words'), card, profile, chat: null, speech: null, tools, aiMusic: false, maxClips: 0, progress: () => undefined, log: () => undefined })
    expect(calls.every((r) => r.length === 0)).toBe(true)
    expect(out.notes.join(' ')).toMatch(/cannot look at your product photos/)
  }, 300000)
})
