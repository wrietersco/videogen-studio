import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND_FONTS, HEX, WATERMARK_POSITIONS, specBrandOf, type BrandFont, type BrandKit, type BrandKitPatch, type BrandKitView } from '@shared/brand'
import { SpecBrand } from '@shared/spec'
import { prepareLogo, prepareVariant } from './logo'

/**
 * Brand kits on disk: <root>/kits.json + <root>/<kitId>/{logo,on-dark,on-light}.png.
 * Kept outside the asset library on purpose — logos are never part of share
 * packs and never sent anywhere.
 */

interface Saved {
  kits: BrandKit[]
  /** the kit used for the last video ('' = the person chose "no brand") */
  lastUsedId: string
}

const MAX_KITS = 30
const clean = (s: unknown, max: number): string => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)
const hexOrNull = (v: unknown): string | null => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toUpperCase() : null)
const fontOrNull = (v: unknown): BrandFont | null => (BRAND_FONTS.includes(v as BrandFont) ? (v as BrandFont) : null)

export class BrandStore {
  private saved: Saved | null = null

  constructor(readonly root: string) {}

  private get file(): string {
    return join(this.root, 'kits.json')
  }

  private load(): Saved {
    if (this.saved) return this.saved
    let saved: Saved = { kits: [], lastUsedId: '' }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>
      saved = { kits: Array.isArray(raw.kits) ? raw.kits.filter((k) => k && typeof k.id === 'string') : [], lastUsedId: typeof raw.lastUsedId === 'string' ? raw.lastUsedId : '' }
    } catch {
      /* first run or unreadable file — start empty */
    }
    this.saved = saved
    return saved
  }

  private write(): void {
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.load(), null, 2))
  }

  private dir(id: string): string {
    return join(this.root, id)
  }

  list(): BrandKit[] {
    return this.load().kits
  }

  get(id: string): BrandKit | null {
    return this.load().kits.find((k) => k.id === id) ?? null
  }

  /** the kit a new video starts with: the last one used, if it still exists */
  lastUsed(): BrandKit | null {
    return this.get(this.load().lastUsedId)
  }

  setLastUsed(id: string): void {
    const s = this.load()
    const next = id && this.get(id) ? id : ''
    if (s.lastUsedId === next) return
    s.lastUsedId = next
    this.write()
  }

  create(name: string): BrandKit {
    const s = this.load()
    if (s.kits.length >= MAX_KITS) throw new Error(`You can keep up to ${MAX_KITS} brand kits. Delete one first.`)
    const now = new Date().toISOString()
    const kit: BrandKit = {
      id: `kit-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`,
      name: clean(name, 60) || 'My brand',
      tagline: '',
      colors: { primary: null, secondary: null },
      fonts: { display: null, body: null },
      logo: null,
      watermark: 'top-right',
      endCard: true,
      createdAt: now,
      updatedAt: now
    }
    s.kits.push(kit)
    if (s.kits.length === 1) s.lastUsedId = kit.id
    this.write()
    return kit
  }

  update(id: string, patch: BrandKitPatch): BrandKit | null {
    const kit = this.get(id)
    if (!kit) return null
    if (patch.name !== undefined) kit.name = clean(patch.name, 60) || kit.name
    if (patch.tagline !== undefined) kit.tagline = clean(patch.tagline, 60)
    if (patch.colors) kit.colors = { primary: hexOrNull(patch.colors.primary), secondary: hexOrNull(patch.colors.secondary) }
    if (patch.fonts) kit.fonts = { display: fontOrNull(patch.fonts.display), body: fontOrNull(patch.fonts.body) }
    if (patch.watermark !== undefined && WATERMARK_POSITIONS.includes(patch.watermark)) kit.watermark = patch.watermark
    if (patch.endCard !== undefined) kit.endCard = Boolean(patch.endCard)
    kit.updatedAt = new Date().toISOString()
    this.write()
    return kit
  }

  remove(id: string): boolean {
    const s = this.load()
    const i = s.kits.findIndex((k) => k.id === id)
    if (i < 0) return false
    s.kits.splice(i, 1)
    if (s.lastUsedId === id) s.lastUsedId = ''
    rmSync(this.dir(id), { recursive: true, force: true })
    this.write()
    return true
  }

  /** check and store a new logo; a kit with no colors yet takes them from the logo */
  async setLogo(id: string, data: Buffer): Promise<BrandKit> {
    const kit = this.get(id)
    if (!kit) throw new Error('This brand kit no longer exists.')
    const p = await prepareLogo(data)
    const dir = this.dir(id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'logo.png'), p.master)
    writeFileSync(join(dir, 'on-dark.png'), p.onDark)
    writeFileSync(join(dir, 'on-light.png'), p.onLight)
    kit.logo = { master: 'logo.png', onDark: 'on-dark.png', onLight: 'on-light.png', width: p.width, height: p.height, palette: p.palette, notes: p.notes }
    if (!kit.colors.primary && p.palette[0]) kit.colors = { primary: p.palette[0], secondary: p.palette[1] ?? null }
    kit.updatedAt = new Date().toISOString()
    this.write()
    return kit
  }

  /** the person's own file for one version, replacing the automatic one */
  async setVariant(id: string, slot: 'onDark' | 'onLight', data: Buffer): Promise<BrandKit> {
    const kit = this.get(id)
    if (!kit?.logo) throw new Error('Add the main logo first.')
    const v = await prepareVariant(data)
    writeFileSync(join(this.dir(id), kit.logo[slot]), v.png)
    kit.logo.notes = kit.logo.notes.filter((n) => !n.includes(slot === 'onDark' ? 'dark videos' : 'light videos'))
    kit.updatedAt = new Date().toISOString()
    this.write()
    return kit
  }

  removeLogo(id: string): BrandKit | null {
    const kit = this.get(id)
    if (!kit) return null
    rmSync(this.dir(id), { recursive: true, force: true })
    kit.logo = null
    kit.updatedAt = new Date().toISOString()
    this.write()
    return kit
  }

  logoPath(id: string, slot: 'master' | 'onDark' | 'onLight'): string | null {
    const kit = this.get(id)
    if (!kit?.logo) return null
    const p = join(this.dir(id), kit.logo[slot])
    return existsSync(p) ? p : null
  }

  view(kit: BrandKit): BrandKitView {
    const dark = this.logoPath(kit.id, 'onDark')
    const light = this.logoPath(kit.id, 'onLight')
    const url = (p: string) => `data:image/png;base64,${readFileSync(p).toString('base64')}`
    return { ...kit, preview: dark && light ? { onDark: url(dark), onLight: url(light) } : null }
  }

  /**
   * Put a kit on a video: copy its logo files into the project and return
   * the brand block for the spec. The project then carries everything it
   * needs, so later edits to the kit never change a finished video.
   */
  attach(id: string, projectDir: string, override?: { watermark?: BrandKit['watermark']; endCard?: boolean }): SpecBrand | null {
    const base = this.get(id)
    if (!base) return null
    // the person's words in the prompt may change where the logo goes for this video only
    const kit: BrandKit = { ...base, watermark: override?.watermark ?? base.watermark, endCard: override?.endCard ?? base.endCard }
    let files: { onDark: string; onLight: string } | null = null
    const dark = this.logoPath(id, 'onDark')
    const light = this.logoPath(id, 'onLight')
    if (dark && light) {
      const dest = join(projectDir, 'assets', 'brand')
      mkdirSync(dest, { recursive: true })
      copyFileSync(dark, join(dest, 'logo-on-dark.png'))
      copyFileSync(light, join(dest, 'logo-on-light.png'))
      files = { onDark: 'assets/brand/logo-on-dark.png', onLight: 'assets/brand/logo-on-light.png' }
    }
    const brand = SpecBrand.parse(specBrandOf(kit, files))
    writeFileSync(join(projectDir, 'brand.json'), JSON.stringify(brand, null, 2))
    return brand
  }
}

/** the brand a project was started with (survives a re-plan on resume) */
export function readProjectBrand(projectDir: string): SpecBrand | null {
  try {
    return SpecBrand.parse(JSON.parse(readFileSync(join(projectDir, 'brand.json'), 'utf8')))
  } catch {
    return null
  }
}
