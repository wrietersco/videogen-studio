import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { applyBrand, brandSummary, contrast, readable } from '../src/shared/brand'
import { VideoSpec } from '../src/shared/spec'
import { LogoError, prepareLogo, sanitizeSvg, sniff } from '../src/main/brand/logo'
import { BrandStore, readProjectBrand } from '../src/main/brand/store'
import { compose } from '../src/main/composer'
import { BRAND_END_SEC, brandTailSec } from '../src/main/composer/brand'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = resolve(appRoot, 'vendor')
const fontsDir = resolve(appRoot, 'vendor', 'fonts')

/** a wordmark like most real logos: near-black lettering plus one colored block */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" viewBox="0 0 600 200">
  <rect x="20" y="40" width="120" height="120" rx="24" fill="#E4572E"/>
  <rect x="180" y="60" width="380" height="80" fill="#111111"/>
</svg>`

async function pixel(png: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const i = (y * info.width + x) * 4
  return [data[i], data[i + 1], data[i + 2], data[i + 3]]
}

describe('logo intake', () => {
  it('reads the real file type from the bytes, not the name', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: '#ff0000' } }).png().toBuffer()
    const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).jpeg().toBuffer()
    expect(sniff(png)).toBe('png')
    expect(sniff(jpg)).toBe('jpeg')
    expect(sniff(Buffer.from(LOGO_SVG))).toBe('svg')
    expect(sniff(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg')
    expect(sniff(Buffer.from('MZ\x90\x00 this is a program'))).toBeNull()
    expect(sniff(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull()
    await expect(prepareLogo(Buffer.from('not an image at all'))).rejects.toBeInstanceOf(LogoError)
  })

  it('strips scripts, handlers and outside links from an SVG', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" onload="evil()"><script>evil()</script><foreignObject><iframe src="https://x.test"/></foreignObject>
      <image href="https://x.test/track.png"/><image xlink:href="file:///C:/secret.png"/><use href="#ok"/>
      <style>@import url(https://x.test/a.css); .a{fill:url(https://x.test/p)}</style><a href="javascript:evil()"><rect id="ok" width="10" height="10"/></a></svg>`
    const clean = sanitizeSvg(dirty)
    expect(clean).not.toMatch(/script|onload|foreignObject|iframe|x\.test|file:|javascript:|@import/i)
    expect(clean).toContain('href="#ok"')
    expect(() => sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>')).toThrow(LogoError)
  })

  it('trims padding, finds the brand color and makes a version for dark videos', async () => {
    const p = await prepareLogo(Buffer.from(LOGO_SVG))
    expect(p.format).toBe('svg')
    // the 20px/40px empty margins are gone
    expect(p.width / p.height).toBeGreaterThan(4)
    expect(p.palette[0]).toMatch(/^#E[0-9A-F]5[0-9A-F][23][0-9A-F]$/)
    const x = Math.round(p.width * 0.7)
    const y = Math.round(p.height * 0.5)
    // black lettering turns white on dark, stays dark on light
    expect((await pixel(p.onDark, x, y)).slice(0, 3)).toEqual([255, 255, 255])
    expect((await pixel(p.onLight, x, y))[0]).toBeLessThan(40)
    // the colored block keeps its color in both
    const block = await pixel(p.onDark, Math.round(p.height * 0.5), y)
    expect(block[0]).toBeGreaterThan(200)
    expect(block[2]).toBeLessThan(90)
    expect(p.notes.join(' ')).toMatch(/dark videos/)
  })

  it('clears a flat white background from an opaque image and warns about small logos', async () => {
    const jpg = await sharp({ create: { width: 240, height: 120, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp({ create: { width: 120, height: 40, channels: 3, background: '#1040c0' } }).png().toBuffer(), left: 60, top: 40 }])
      .jpeg({ quality: 95 })
      .toBuffer()
    const p = await prepareLogo(jpg)
    expect(p.width).toBeLessThan(130)
    expect(p.height).toBeLessThan(50)
    expect(p.notes.join(' ')).toMatch(/plain background/)
    expect(p.notes.join(' ')).toMatch(/small/)
    const blank = await sharp({ create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    await expect(prepareLogo(blank)).rejects.toThrow(/transparent/)
  })
})

describe('brand colors', () => {
  it('leaves a readable color alone and fixes one that is not', () => {
    expect(readable('#FFB547', '#090D18')).toBe('#FFB547')
    const navy = readable('#0A1A4A', '#090D18')
    expect(navy).not.toBe('#0A1A4A')
    expect(contrast(navy, '#090D18')).toBeGreaterThanOrEqual(3)
    expect(contrast(readable('#FFF3B0', '#FFFFFF'), '#FFFFFF')).toBeGreaterThanOrEqual(3)
  })
})

describe('brand kits', () => {
  it('stores a kit, attaches it to a project and puts it on the video', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vg-brand-'))
    const project = mkdtempSync(join(tmpdir(), 'vg-brand-proj-'))
    const store = new BrandStore(join(root, 'brand'))
    const kit = store.create('Acme')
    expect(store.lastUsed()?.id).toBe(kit.id)
    await store.setLogo(kit.id, Buffer.from(LOGO_SVG))
    // colors come from the logo when none were chosen
    expect(store.get(kit.id)?.colors.primary).toMatch(/^#E/)
    store.update(kit.id, { tagline: 'acme.example', colors: { primary: '#0A1A4A', secondary: 'nonsense' as never }, fonts: { display: 'Nunito', body: 'Comic Sans' as never } })
    const saved = store.get(kit.id)!
    expect(saved.colors).toEqual({ primary: '#0A1A4A', secondary: null })
    expect(saved.fonts).toEqual({ display: 'Nunito', body: null })
    expect(brandSummary(saved).join(' | ')).toMatch(/top right.*end card.*acme\.example/i)
    // a fresh store reads the same thing back from disk
    expect(new BrandStore(join(root, 'brand')).get(kit.id)?.logo?.width).toBe(saved.logo?.width)

    const brand = store.attach(kit.id, project)!
    expect(existsSync(join(project, brand.logo!.onDark))).toBe(true)
    expect(readProjectBrand(project)).toEqual(brand)

    const plain = await new Planner(new MockProvider()).plan({ userPrompt: 'product explainer for a habit tracking app', platform: 'youtube', styleHint: 'explainer' })
    const before = compose(plain, vendorDir, fontsDir)
    expect(before.html).not.toContain('brand-mark')
    expect(brandTailSec(plain)).toBe(0)

    const spec = applyBrand(VideoSpec.parse({ ...plain, brand }))
    // the navy is nudged until it reads on this film's background
    expect(spec.palette.accent).not.toBe(plain.palette.accent)
    expect(contrast(spec.palette.accent, spec.palette.bg)).toBeGreaterThanOrEqual(3)
    expect(spec.typography.display).toMatch(/^Nunito/)
    expect(applyBrand(spec)).toEqual(spec)

    const out = compose(spec, vendorDir, fontsDir)
    const content = plain.scenes.reduce((t, s) => t + s.durationSec, 0)
    expect(out.html).toContain('id="brand-mark"')
    expect(out.html).toContain('id="brand-end-logo"')
    expect(out.html).toContain('acme.example')
    expect(out.html).toMatch(/assets\/brand\/logo-on-(dark|light)\.png/)
    expect(out.html).toContain(`data-duration="${Math.round((content + BRAND_END_SEC) * 100) / 100}"`)
    // the end card's animation survived the selector self-check
    expect(out.html).toContain('"sel":"#brand-end-logo"')

    // corner logo off + no end card = nothing added
    const quiet = compose({ ...spec, brand: { ...brand, watermark: 'off', endCard: false } }, vendorDir, fontsDir)
    expect(quiet.html).not.toContain('brand-mark')
    expect(quiet.html).toContain(`data-duration="${Math.round(content * 100) / 100}"`)
    // a logo path outside the project's brand folder is refused by the schema
    expect(() => VideoSpec.parse({ ...plain, brand: { ...brand, logo: { ...brand.logo!, onDark: '../../secret.png' } } })).toThrow()

    expect(store.remove(kit.id)).toBe(true)
    expect(store.lastUsed()).toBeNull()
    expect(JSON.parse(readFileSync(join(root, 'brand', 'kits.json'), 'utf8')).kits).toHaveLength(0)
  })
})

describe('closing logo card and the last scene', () => {
  it('hides the last scene once the card has faded in, so their text never overlaps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vg-brand-tail-'))
    const project = mkdtempSync(join(tmpdir(), 'vg-brand-tailp-'))
    const store = new BrandStore(join(root, 'brand'))
    const kit = store.create('Tail')
    await store.setLogo(kit.id, Buffer.from(LOGO_SVG))
    const brand = store.attach(kit.id, project)!
    const plain = await new Planner(new MockProvider()).plan({ userPrompt: 'product explainer for a habit tracking app', platform: 'youtube', styleHint: 'explainer' })
    const out = compose(VideoSpec.parse({ ...plain, brand }), vendorDir, fontsDir)
    const content = plain.scenes.reduce((t, s) => t + s.durationSec, 0)
    const last = `#scene-${plain.scenes.length}`
    const hide = [...out.html.matchAll(/\{"kind":"set","t":([\d.]+),"sel":"([^"]+)","set":\{"autoAlpha":0\}\}/g)].find((m) => m[2] === last && Number(m[1]) > content)
    expect(hide).toBeTruthy()
    expect(Number(hide![1])).toBeCloseTo(content + 0.32, 1)
  })
})
