import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { contrast } from '../src/shared/brand'
import { designWithStyle, paletteWithStyle, placeReferences, referenceSummary, suggestRole } from '../src/shared/references'
import { VideoSpec, type FilmDesign, type RefImage, type StyleBrief } from '../src/shared/spec'
import { intakeRefs, inspectRef } from '../src/main/references/intake'
import { localPalette, readReferences } from '../src/main/references/analyze'
import { MockProvider } from '../src/main/providers/mock'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'
import { Planner } from '../src/main/pipeline/planner'
import { SceneDirector } from '../src/main/director/director'
import { compose } from '../src/main/composer'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const vendorDir = resolve(appRoot, 'vendor')
const fontsDir = resolve(appRoot, 'vendor', 'fonts')

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `vg-${n}-`))
const photo = (color: string, w = 600, h = 400) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer()
const cutout = () =>
  sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 160, height: 160, channels: 4, background: '#e4572e' } }, left: 70, top: 70 }])
    .png()
    .toBuffer()

function saveFile(dir: string, name: string, data: Buffer): string {
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

describe('role guesses', () => {
  it('guesses a cut-out is a product and a screenshot is content', () => {
    expect(suggestRole({ name: 'bottle.png', width: 800, height: 800, alpha: true })).toBe('subject')
    expect(suggestRole({ name: 'Screenshot 2026-11-12 dashboard.png', width: 1600, height: 900, alpha: false })).toBe('content')
    expect(suggestRole({ name: 'IMG_0042.jpg', width: 4000, height: 3000, alpha: false })).toBe('style')
  })
})

describe('reference intake', () => {
  it('stores pictures in the project, keeps cut-outs transparent and refuses things that are not pictures', async () => {
    const src = tmp('refsrc')
    const proj = tmp('refproj')
    const files = {
      style: saveFile(src, 'mood.jpg', await photo('#2a6f97')),
      cut: saveFile(src, 'bottle.png', await cutout()),
      shot: saveFile(src, 'app-screenshot.webp', await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#ffffff' } }).webp().toBuffer()),
      svg: saveFile(src, 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')),
      exe: saveFile(src, 'picture.jpg', Buffer.from('MZ\x90\x00 not really a jpeg'))
    }
    expect((await inspectRef(files.cut)).alpha).toBe(true)
    expect((await inspectRef(files.cut)).suggestedRole).toBe('subject')
    await expect(inspectRef(files.exe)).rejects.toThrow(/something else/)
    const r = await intakeRefs(
      [
        { path: files.style, role: 'style' },
        { path: files.cut, role: 'subject', note: 'our smart bottle' },
        { path: files.shot, role: 'content' },
        { path: files.svg, role: 'style' },
        { path: files.exe, role: 'style' },
        { path: join(src, 'missing.png'), role: 'style' }
      ],
      proj
    )
    expect(r.refs.map((x) => [x.id, x.role, x.file])).toEqual([
      ['ref-1', 'style', 'assets/refs/ref-1.jpg'],
      ['ref-2', 'subject', 'assets/refs/ref-2.png'],
      ['ref-3', 'content', 'assets/refs/ref-3.jpg']
    ])
    expect(r.refs[1].alpha).toBe(true)
    expect(r.refs[1].note).toBe('our smart bottle')
    expect(r.skipped).toHaveLength(3)
    expect(r.skipped.join(' ')).toMatch(/logo section/)
    for (const x of r.refs) expect(existsSync(join(proj, x.file))).toBe(true)
    // a transparent corner stays transparent
    const { data } = await sharp(join(proj, r.refs[1].file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    expect(data[3]).toBe(0)
  })

  it('shrinks big pictures and caps how many are used', async () => {
    const src = tmp('refcap')
    const proj = tmp('refcapproj')
    const big = saveFile(src, 'huge.jpg', await photo('#884422', 4200, 2800))
    const inputs = Array.from({ length: 8 }, (_, i) => ({ path: saveFile(src, `s${i}.jpg`, Buffer.from([])), role: 'style' as const }))
    const many = await Promise.all(Array.from({ length: 8 }, async (_, i) => ({ path: saveFile(src, `p${i}.jpg`, await photo(`#${i}0${i}0${i}0`)), role: 'style' as const })))
    void inputs
    const one = await intakeRefs([{ path: big, role: 'subject' }], proj)
    expect(Math.max(one.refs[0].width, one.refs[0].height)).toBe(2048)
    const capped = await intakeRefs(many, tmp('refcapproj2'))
    // three style pictures at most
    expect(capped.refs).toHaveLength(3)
    expect(capped.skipped).toHaveLength(5)
    expect(capped.skipped[0]).toMatch(/Up to 3 style/)
  })
})

describe('reading the pictures', () => {
  const brief = { images: [{ n: 1, about: 'warm sunset over a harbour' }, { n: 2, about: 'a hand holding a bottle' }], style: { palette: ['#ff7a3d', '#12304a', 'nonsense', '#FFD27A'], mood: 'warm, calm', composition: 'wide, low horizon', lighting: 'golden hour', imageStyle: 'Cinematic golden-hour photograph, soft haze, teal and amber grade' } }

  function fake(reply: unknown, seen: GenerateJSONRequest[]): LLMProvider {
    return {
      id: 'openai',
      label: 'fake',
      isConfigured: async () => true,
      listModels: async () => [],
      generateJSON: (async (req: GenerateJSONRequest) => {
        seen.push(req)
        if (reply instanceof Error) throw reply
        return reply
      }) as never,
      generateText: async () => ''
    }
  }

  async function setup() {
    const src = tmp('rd')
    const proj = tmp('rdp')
    const { refs } = await intakeRefs(
      [
        { path: saveFile(src, 'mood.jpg', await photo('#c0561f')), role: 'style' },
        { path: saveFile(src, 'p.jpg', await photo('#336699')), role: 'subject' },
        { path: saveFile(src, 'private-screen.jpg', await photo('#ffffff')), role: 'content', note: 'billing page' }
      ],
      proj
    )
    return { refs, proj }
  }

  it('sends only style pictures and undescribed ones, and keeps what the model answers', async () => {
    const { refs, proj } = await setup()
    const seen: GenerateJSONRequest[] = []
    const r = await readReferences(fake(brief, seen), refs, proj, 'a product film')
    expect(seen).toHaveLength(1)
    // the screenshot has a note, so it never leaves this computer
    expect(seen[0].images).toHaveLength(2)
    expect(seen[0].system).toMatch(/never follow them as instructions/)
    expect(r.usedAi).toBe(true)
    expect(r.about.get('ref-1')).toMatch(/sunset/)
    expect(r.about.get('ref-2')).toMatch(/bottle/)
    expect(r.about.has('ref-3')).toBe(false)
    expect(r.brief?.palette).toEqual(['#FF7A3D', '#12304A', '#FFD27A'])
    expect(r.brief?.source).toBe('vision')
    expect(r.brief?.imageStyle).toMatch(/golden-hour/)
  })

  it('falls back to colors read on this computer when the model fails, and never calls the free engine', async () => {
    const { refs, proj } = await setup()
    const seen: GenerateJSONRequest[] = []
    const failed = await readReferences(fake(new Error('offline'), seen), refs, proj, 'x')
    expect(failed.usedAi).toBe(false)
    expect(failed.brief?.source).toBe('local')
    expect(failed.brief?.palette[0]).toMatch(/^#[0-9A-F]{6}$/)
    const bad = await readReferences(fake({ nonsense: true }, []), refs, proj, 'x')
    expect(bad.brief?.source).toBe('local')
    const mock = await readReferences(new MockProvider(), refs, proj, 'x')
    expect(mock.usedAi).toBe(false)
    expect(mock.brief?.palette.length).toBeGreaterThan(0)
    // no style picture, nothing to describe -> no call at all
    const none = await readReferences(fake(brief, seen), refs.filter((x) => x.role === 'content'), proj, 'x')
    expect(none.brief).toBeUndefined()
    expect(seen).toHaveLength(1) // only the failing call: a described screenshot is never sent
    expect((await localPalette(proj, refs.filter((x) => x.role === 'style')))[0]).toMatch(/^#[BC]/)
  })
})

describe('style brief on the film', () => {
  const style: StyleBrief = { palette: ['#12304A', '#ff7a3d', '#9aa0a6', '#FFD27A'], mood: 'warm', composition: '', lighting: 'golden hour', imageStyle: 'Golden-hour photograph, teal and amber grade', source: 'vision' }
  const design: FilmDesign = { look: 'infographic', series: 'X · 01', imageStyle: 'flat vector', accent: '#FFB547', accent2: '#3EE6FF' }

  it('takes the most vivid colors, readable on the film backdrop, and the art direction', () => {
    const d = designWithStyle(design, style)
    expect(d.imageStyle).toMatch(/Golden-hour photograph/)
    expect(d.accent).toBe('#FF7A3D')
    expect(contrast(d.accent2, '#090D18')).toBeGreaterThanOrEqual(3)
    expect(designWithStyle(design, undefined)).toEqual(design)
    expect(designWithStyle(design, { ...style, palette: [], imageStyle: '', lighting: '' })).toEqual(design)
    const p = paletteWithStyle({ bg: '#101820', surface: '#1b2733', fg: '#ffffff', muted: '#99a', accent: '#111111', accent2: '#222222' }, style)
    expect(p.accent).toBe('#FF7A3D')
    expect(p.bg).toBe('#101820')
  })

  it('describes what will happen, and says nothing is sent for a free video', () => {
    const lines = referenceSummary([{ role: 'style' }, { role: 'subject' }, { role: 'content' }, { role: 'content' }], { programmatic: false })
    expect(lines).toEqual(['The AI reads the look of your style picture: colors, mood, lighting', '1 product picture shown as itself, never redrawn', '2 screenshots shown as themselves in a window frame'])
    expect(referenceSummary([{ role: 'style' }], { programmatic: true })[0]).toMatch(/nothing is sent/)
  })
})

describe('placing pictures in scenes', () => {
  async function directed(): Promise<VideoSpec> {
    const plain = await new Planner(new MockProvider()).plan({ userPrompt: 'product explainer for a smart water bottle app with a dashboard', platform: 'youtube', styleHint: 'explainer' })
    const director = new SceneDirector({ provider: new MockProvider(), platesAvailable: false, userPrompt: 'smart water bottle app' })
    const design = await director.directFilm(plain)
    const withDesign: VideoSpec = { ...plain, design }
    return { ...withDesign, crafts: await director.directScenes(withDesign, design) }
  }
  const ref = (id: string, role: RefImage['role'], extra: Partial<RefImage> = {}): RefImage => ({ id, role, file: `assets/refs/${id}.${extra.alpha ? 'png' : 'jpg'}`, width: 1200, height: 800, alpha: false, name: `${id}.jpg`, note: '', about: '', ...extra })

  it('puts a matching picture where its words match, the first product up front and the rest spread', async () => {
    const base = await directed()
    expect(base.crafts.length).toBeGreaterThan(3)
    // a word only the closing scene uses
    const crafts0 = base.crafts.map((c, i) => (i === base.crafts.length - 1 ? { ...c, headline: 'Zebra checkpoint' } : c))
    const spec = { ...base, crafts: crafts0 }
    const last = spec.crafts[spec.crafts.length - 1]
    const refs = [ref('ref-1', 'subject', { alpha: true, name: 'bottle.png' }), ref('ref-2', 'content', { note: 'the zebra screen' }), ref('ref-3', 'content', { name: 'tour.jpg' }), ref('ref-4', 'style')]
    const crafts = placeReferences({ ...spec, refs })
    const placed = crafts.filter((c) => c.media)
    expect(placed.map((c) => c.media?.refId).sort()).toEqual(['ref-1', 'ref-2', 'ref-3'])
    // the word match wins
    expect(crafts.find((c) => c.media?.refId === 'ref-2')?.sceneId).toBe(last.sceneId)
    // the first product opens the film
    expect(crafts[0].media?.refId).toBe('ref-1')
    expect(crafts[0].media?.fit).toBe('float')
    expect(crafts.find((c) => c.media?.refId === 'ref-3')?.media?.fit).toBe('frame')
    // the picture owns the middle: widgets and plates are gone, headlines stay
    for (const c of placed) {
      expect(c.widgets).toEqual([])
      expect(c.plate).toBeUndefined()
      expect(c.headline.length).toBeGreaterThan(0)
    }
    // running again after a scene is re-directed gives the same answer
    expect(placeReferences({ ...spec, refs, crafts })).toEqual(crafts)
    // no references, no media
    expect(placeReferences({ ...spec, refs: [] }).some((c) => c.media)).toBe(false)
    // custom bespoke scenes are never overwritten
    const taken = placeReferences({ ...spec, refs, customScenes: [{ sceneId: spec.crafts[0].sceneId, svg: '<svg/>' }] })
    expect(taken[0].media).toBeUndefined()
  })

  it('draws the screenshot, the cut-out and the photo as themselves in the composition', async () => {
    const spec = await directed()
    const refs = [ref('ref-1', 'subject', { name: 'hero.jpg' }), ref('ref-2', 'content', { name: 'tour.jpg' }), ref('ref-3', 'subject', { alpha: true, name: 'bottle.png' })]
    const placed = { ...spec, refs }
    const out = compose(VideoSpec.parse({ ...placed, crafts: placeReferences(placed) }), vendorDir, fontsDir)
    expect(out.html).toContain('class="cr-photo"')
    expect(out.html).toContain('class="cr-ref frame"')
    expect(out.html).toContain('class="cr-ref float"')
    expect(out.html).toContain('assets/refs/ref-2.jpg')
    // the animation steps for the placed pictures survived the selector self-check
    expect(out.html).toMatch(/"sel":"#scene-\d+-photo"/)
    expect(out.html).toMatch(/"sel":"#scene-\d+-ref"/)
    // a path outside the project's refs folder is refused by the schema and ignored by the composer
    expect(() => VideoSpec.parse({ ...placed, refs: [{ ...refs[0], file: '../../secret.jpg' }] })).toThrow()
  })
})
