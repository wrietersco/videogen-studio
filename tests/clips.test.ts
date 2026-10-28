import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssetLibrary } from '../src/main/assets/library'
import { MediaRouter } from '../src/main/media/router'
import { DEFAULT_SETTINGS } from '../src/main/settings'
import { meter } from '../src/main/usage/meter'
import { clipBudget, guardCraft, heuristicCraft, pickClipScenes } from '../src/main/director/director'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'
import { compose } from '../src/main/composer'
import { estimateVideoCost } from '../src/shared/pricing'
import type { SceneCraft } from '../src/shared/spec'

afterEach(() => vi.unstubAllGlobals())

const craft = (id: string, motion: boolean): SceneCraft =>
  guardCraft(
    { background: 'plate', headline: 'x', accentWord: '', deck: '', hud: { left: '', right: '', chips: [] }, widgets: [], caption: 'c', keyWord: '', plate: { prompt: `scene ${id}`, camera: 'push', subject: 'center', subjectLabel: id, motion } },
    id,
    { platesAvailable: true, clipsAvailable: true, narration: '' }
  )

describe('engine-chosen clip scenes', () => {
  it('budgets moving clips per film, in film order', () => {
    expect(clipBudget(10)).toBe(1)
    expect(clipBudget(40)).toBe(2)
    expect(clipBudget(300)).toBe(3)
    const out = pickClipScenes([craft('a', true), craft('b', false), craft('c', true), craft('d', true)], 40)
    expect(out.map((c) => c.plate?.motion)).toEqual([true, false, true, false])
  })

  it('never asks for motion when no clip source is set up', () => {
    const c = guardCraft(
      { background: 'plate', headline: 'x', accentWord: '', deck: '', hud: { left: '', right: '', chips: [] }, widgets: [], caption: 'c', keyWord: '', plate: { prompt: 'lava', camera: 'push', subject: 'center', subjectLabel: 'lava', motion: true } },
      's1',
      { platesAvailable: true, clipsAvailable: false, narration: '' }
    )
    expect(c.plate?.motion).toBe(false)
  })

  it('composes a clip plate as a muted framework <video>, not a WebGL plate', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'the night Pompeii disappeared', platform: 'tiktok' })
    spec.design = { look: 'documentary', series: 'POMPEII', imageStyle: '', accent: '#FF4A2E', accent2: '#3EE6FF' }
    spec.crafts = spec.scenes.map((s, i) => guardCraft(heuristicCraft(spec, spec.design!, i), s.id, { platesAvailable: false, narration: '' }))
    spec.crafts[0] = { ...spec.crafts[0], background: 'plate', widgets: [{ type: 'annotation', label: 'Vesuvius' }], plate: { prompt: 'Vesuvius', camera: 'push', subject: 'center', subjectLabel: 'Vesuvius', motion: true, clipFile: 'assets/plates/s.mp4' } }
    const { html } = compose(spec, resolve('vendor'), resolve('vendor', 'fonts'))
    const tag = /<video[^>]*scene-1-clip[^>]*>/.exec(html)?.[0] ?? ''
    expect(tag).toContain('class="clip cr-plate cr-clip"')
    expect(tag).toContain('muted')
    expect(tag).toContain('data-start="0.000"')
    expect(html).not.toContain('scene-1-plate"')
    expect(html).not.toContain('scene-1-ring')
  })

  it('adds the clip ceiling to the pre-flight estimate only when Gemini clips are on', () => {
    const base = { chatModel: 'gemini-3.8-flash', durationSec: 40, directed: true }
    const diff = estimateVideoCost({ ...base, videoModel: 'gemini-omni-1.1-flash' }) - estimateVideoCost(base)
    expect(diff).toBeCloseTo(2 * 0.81, 1)
  })
})

describe('motion clips via the media router', () => {
  it('animates the still with Gemini Omni, files it, and reuses it next time', async () => {
    const lib = new AssetLibrary(mkdtempSync(join(tmpdir(), 'vg-clip-')), null)
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(
        JSON.stringify({
          status: 'completed',
          steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: Buffer.from('FAKE-MP4').toString('base64') }] }],
          usage: { total_output_tokens: 5792 * 8 }
        }),
        { status: 200 }
      )
    })
    const router = new MediaRouter({
      library: lib,
      settings: () => ({ ...DEFAULT_SETTINGS, media: { ...DEFAULT_SETTINGS.media, video: 'gemini:gemini-omni-1.1-flash' } }),
      key: (id) => (id === 'gemini' ? 'g-test' : ''),
      provider: () => new MockProvider(),
      autoImageProvider: () => null
    })
    expect(router.clipsAvailable()).toBe(true)
    const req = { prompt: 'lava pouring into the sea at night', subjectLabel: 'lava', camera: 'push', still: Buffer.from('JPEG'), width: 1080, height: 1920, durationSec: 5, projectId: 'p1' }
    meter.begin('generate')
    const first = await router.motionClip(req)
    const second = await router.motionClip({ ...req, projectId: 'p2' })
    const run = meter.end(null)
    expect(first?.buffer.toString()).toBe('FAKE-MP4')
    expect(second?.assetId).toBe(first?.assetId)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ response_format: { aspect_ratio: '9:16' }, generation_config: { video_config: { task: 'image_to_video' } } })
    expect(run?.entries.filter((e) => e.saved)).toHaveLength(1)
    expect(lib.get(first!.assetId)?.usedIn).toEqual(expect.arrayContaining(['p1', 'p2']))
  })

  it('offers no clips for "Stills only"', () => {
    const router = new MediaRouter({
      library: new AssetLibrary(mkdtempSync(join(tmpdir(), 'vg-clip-')), null),
      settings: () => ({ ...DEFAULT_SETTINGS, media: { ...DEFAULT_SETTINGS.media, video: 'none' } }),
      key: () => 'k',
      provider: () => new MockProvider(),
      autoImageProvider: () => null
    })
    expect(router.clipsAvailable()).toBe(false)
  })
})

describe('orchestrator plate stage', () => {
  it('paints the still, then animates the engine-picked motion scene into a clip', async () => {
    const { Orchestrator } = await import('../src/main/pipeline/orchestrator')
    const { ProjectStore } = await import('../src/main/store/projectStore')
    const sharp = (await import('sharp')).default
    const { existsSync } = await import('node:fs')
    const root = mkdtempSync(join(tmpdir(), 'vg-orch-'))
    const lib = new AssetLibrary(join(root, 'lib'), null)
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', data: Buffer.from('MP4').toString('base64') }] }] }), { status: 200 })
    )
    const painter = {
      ...new MockProvider(),
      id: 'openai' as const,
      generateImage: async (r: { width: number; height: number }) => sharp({ create: { width: r.width, height: r.height, channels: 3, background: '#335' } }).jpeg().toBuffer()
    }
    const media = new MediaRouter({
      library: lib,
      settings: () => ({ ...DEFAULT_SETTINGS, media: { ...DEFAULT_SETTINGS.media, image: 'openai', video: 'gemini:gemini-omni-1.1-flash' } }),
      key: (id) => (id === 'openai' || id === 'gemini' ? 'k' : ''),
      provider: () => painter as never,
      autoImageProvider: () => null
    })
    const store = new ProjectStore(join(root, 'projects'))
    const orch = new Orchestrator(store, () => new MockProvider(), () => null, media)
    const { id } = store.create('lava', 'Lava')
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'how lava reaches the sea', platform: 'tiktok' })
    spec.design = { look: 'documentary', series: 'LAVA', imageStyle: '', accent: '#FF4A2E', accent2: '#3EE6FF' }
    spec.crafts = spec.scenes.map((s, i) => craft(s.id, i < 2))
    spec.crafts = pickClipScenes(spec.crafts, 10)
    const out = await (orch as unknown as { runPlates: (...a: unknown[]) => Promise<typeof spec> }).runPlates(id, spec, () => {}, new MockProvider())
    const first = out.crafts[0].plate!
    expect(first.file).toBeTruthy()
    expect(first.clipFile).toBe(`assets/plates/${spec.scenes[0].id}.mp4`)
    expect(existsSync(join(store.dir(id), first.clipFile!))).toBe(true)
    // over budget → still only
    expect(out.crafts[1].plate?.motion).toBe(false)
    expect(out.crafts[1].plate?.clipFile).toBeUndefined()
  }, 120_000)
})
