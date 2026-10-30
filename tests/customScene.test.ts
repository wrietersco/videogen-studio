import { describe, it, expect } from 'vitest'
import { validateSceneSvg, chooseCustomScenes, authorCustomScene } from '../src/main/director/customScene'
import { authorCanvasCode } from '../src/main/director/canvasCode'
import { MockProvider } from '../src/main/providers/mock'
import { Planner } from '../src/main/pipeline/planner'
import { compose } from '../src/main/composer'
import { resolve } from 'node:path'
import type { LLMProvider } from '../src/main/providers/types'
import { Orchestrator, isBlankReviewFrame } from '../src/main/pipeline/orchestrator'
import { ProjectStore } from '../src/main/store/projectStore'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#123456"/><g id="motion1"><circle cx="50" cy="50" r="20" fill="#fff"/></g></svg>'

describe('custom scene authoring', () => {
  it('detects a failed near-black capture before comparing scenes', async () => {
    const blank = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#101216' } }).png().toBuffer()
    const visible = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#d9a45b' } }).png().toBuffer()
    expect(await isBlankReviewFrame(blank)).toBe(true)
    expect(await isBlankReviewFrame(visible)).toBe(false)
  })
  it('accepts vector code and rejects executable and external content', () => {
    expect(validateSceneSvg(svg)).toContain('<circle')
    for (const bad of [
      '<svg viewBox="0 0 1 1"><script>alert(1)</script></svg>',
      '<svg viewBox="0 0 1 1"><rect onload="alert(1)"/></svg>',
      '<svg viewBox="0 0 1 1"><image href="https://example.com/a"/></svg>',
      '<svg viewBox="0 0 1 1"><rect fill="url(https://example.com/a)"/></svg>'
    ]) expect(() => validateSceneSvg(bad)).toThrow()
  })
  it('restricts selected scenes to actual IDs and embeds authored source in a seekable scene', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'show a custom atomic diagram', platform: 'tiktok' })
    const provider = { id: 'openai', generateJSON: async () => ({ sceneIds: [spec.scenes[0].id, 'invented', spec.scenes[0].id], reason: 'diagram' }), generateText: async () => svg } as unknown as LLMProvider
    expect(await chooseCustomScenes(provider, spec, 'custom diagram')).toEqual([spec.scenes[0].id])
    const code = await authorCustomScene(provider, spec, 'custom diagram', spec.scenes[0].id)
    spec.customScenes = [{ sceneId: spec.scenes[0].id, svg: code }]
    const html = compose(spec, resolve('vendor'), resolve('vendor/fonts')).html
    expect(html).toContain('data-kind="custom-vector"')
    expect(html).toContain('id="custom1-motion1"')
    expect(html).toContain('scene-1-custom')
  })
  it('composes only project-local rendered custom code videos', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'animated orbit', platform: 'tiktok' })
    spec.customVideos = [{ sceneId: spec.scenes[0].id, file: 'assets/custom/orbit.mp4', source: 'ctx.fillRect(0,0,w,h)' }]
    const html = compose(spec, resolve('vendor'), resolve('vendor/fonts')).html
    expect(html).toContain('data-kind="custom-code"')
    expect(html).toContain('src="assets/custom/orbit.mp4"')
    spec.customVideos[0].file = '../../outside.mp4'
    expect(compose(spec, resolve('vendor'), resolve('vendor/fonts')).html).not.toContain('../../outside.mp4')
  })
  it('shows the selected model the photo and prior candidate during a code revision', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'annotate a grinder', platform: 'tiktok' })
    const seen: Array<{ images?: unknown[]; prompt: string }> = []
    const provider = { id: 'openai', generateJSON: async (req: { images?: unknown[]; prompt: string }) => { seen.push(req); return { beginning: 'a', middle: 'b', end: 'c', photoUse: 'retain' } }, generateText: async (req: { images?: unknown[]; prompt: string }) => { seen.push(req); return 'ctx.fillRect(0,0,w,h)' } } as unknown as LLMProvider
    const code = await authorCanvasCode(provider, spec, 'annotate a grinder', spec.scenes[0].id, 'move the arrow', 'old code', Buffer.from('photo'), Buffer.from('frame'))
    expect(code).toContain('fillRect')
    expect(seen).toHaveLength(2)
    for (const req of seen) {
      expect(req.images).toHaveLength(2)
      expect(req.prompt).toContain('selected background photograph')
      expect(req.prompt).toContain('previous candidate frame to revise')
    }
  })
  it('supplies the prior approved scene as a visual reference to code and vector authors', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'a logo reveal', platform: 'tiktok' })
    const requests: Array<{ images?: unknown[]; prompt: string; system: string }> = []
    const provider = { id: 'openai', generateJSON: async (req: { images?: unknown[]; prompt: string; system: string }) => { requests.push(req); return { beginning: 'a', middle: 'b', end: 'c', photoUse: 'retain' } }, generateText: async (req: { images?: unknown[]; prompt: string; system: string }) => { requests.push(req); return req.system.includes('SVG') ? svg : 'ctx.fillRect(0,0,w,h)' } } as unknown as LLMProvider
    const prior = Buffer.from('previous approved frame')
    await authorCanvasCode(provider, spec, 'a logo reveal', spec.scenes[0].id, undefined, undefined, undefined, undefined, false, prior)
    await authorCustomScene(provider, spec, 'a logo reveal', spec.scenes[0].id, undefined, undefined, prior)
    expect(requests).toHaveLength(3)
    for (const req of requests) expect(req.images).toHaveLength(1)
    expect(requests[1].prompt).toContain('approved previous scene for visual continuity')
    expect(requests[2].system).toContain('preceding approved scene')
  })

  it('tells the selected model that a video background must remain moving', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'annotate brewing footage', platform: 'tiktok' })
    let request: { prompt: string; system: string } | undefined
    const provider = { id: 'openai', generateJSON: async () => ({ beginning: 'a', middle: 'b', end: 'c', photoUse: 'retain' }), generateText: async (req: { prompt: string; system: string }) => { request = req; return 'ctx.drawImage(assets.background,0,0,w,h)' } } as unknown as LLMProvider
    await authorCanvasCode(provider, spec, 'annotate brewing footage', spec.scenes[0].id, undefined, undefined, Buffer.from('frame'), undefined, true)
    expect(request?.prompt).toContain('moving footage frame')
    expect(request?.prompt).toContain('\"backgroundIsVideo\":true')
    expect(request?.system).toContain('preserving its movement')
  })
  it('revises a rejected candidate and keeps the approved one', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'custom diagram', platform: 'tiktok' })
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'custom-scene-')))
    const project = store.create('custom diagram', 'test')
    store.saveComposition(project.id, compose(spec, resolve('vendor'), resolve('vendor/fonts')))
    const image = join(project.dir, 'frame.png')
    writeFileSync(image, await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer())
    let reviews = 0
    const reviewImageCounts: number[] = []
    const feedbacks: string[] = []
    const provider = {
      id: 'openai',
      generateJSON: async (req: { schemaName: string; images?: unknown[] }) => req.schemaName === 'CustomSceneSelection'
        ? { sceneIds: [spec.scenes[0].id], reason: 'custom' }
        : req.schemaName === 'CodeSceneDecision' ? { useCode: false, reason: 'vector' }
        : (reviewImageCounts.push(req.images?.length ?? 0), { useCandidate: true, score: ++reviews === 2 ? 8 : 9, blockingIssue: reviews !== 2, reason: 'show the flow more clearly' }),
      generateText: async (req: { prompt: string }) => { feedbacks.push(req.prompt); return svg }
    } as unknown as LLMProvider
    const orchestrator = new Orchestrator(store, () => provider)
    const captures: number[][] = []
    ;(orchestrator as any).renders = { snapshot: async (_dir: string, times: number[]) => { captures.push(times); return times.map(() => image) }, check: async () => ({ ok: true, errors: [], warnings: [] }) }
    const result = await (orchestrator as any).runCustomScenes(project.id, spec, 'custom diagram', { clips: [], captions: [] })
    expect(captures[1]).toEqual(captures[0])
    expect(captures[0][2]).toBeLessThanOrEqual(spec.scenes[0].durationSec - 0.54)
    expect(reviews).toBe(2)
    expect(reviewImageCounts).toEqual([6, 6])
    expect(feedbacks[1]).toContain('show the flow more clearly')
    expect(result.customScenes[0].sceneId).toBe(spec.scenes[0].id)
    expect(readFileSync(join(project.dir, 'index.html'), 'utf8')).toContain('data-kind="custom-vector"')
  })
  it('passes the accepted first scene to the next scene author for continuity', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'coherent logo reveal', platform: 'tiktok' })
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'custom-continuity-'))), project = store.create('logo', 'test')
    store.saveComposition(project.id, compose(spec, resolve('vendor'), resolve('vendor/fonts')))
    const image = join(project.dir, 'frame.png')
    writeFileSync(image, await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer())
    const counts: number[] = [], reviewCounts: number[] = []
    const provider = { id: 'openai', generateJSON: async (req: { schemaName: string; images?: unknown[] }) => req.schemaName === 'CustomSceneSelection' ? { sceneIds: [spec.scenes[0].id, spec.scenes[1].id], reason: 'logo' } : req.schemaName === 'CodeSceneDecision' ? { useCode: false, reason: 'vector' } : (reviewCounts.push(req.images?.length ?? 0), { useCandidate: true, score: 9, originalScore: 4, blockingIssue: false, reason: 'clearer' }), generateText: async (req: { images?: unknown[] }) => { counts.push(req.images?.length ?? 0); return svg } } as unknown as LLMProvider
    const orchestrator = new Orchestrator(store, () => provider)
    ;(orchestrator as any).renders = { snapshot: async (_dir: string, times: number[]) => times.map(() => image), check: async () => ({ ok: true, errors: [], warnings: [] }) }
    const result = await (orchestrator as any).runCustomScenes(project.id, spec, 'coherent logo reveal', { clips: [], captions: [] })
    expect(result.customScenes).toHaveLength(2)
    expect(counts).toEqual([0, 1])
    expect(reviewCounts).toEqual([6, 7])
  })

  it('keeps the best safe improvement when no candidate reaches the ideal score', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'custom diagram', platform: 'tiktok' })
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'custom-best-'))), project = store.create('custom diagram', 'test')
    store.saveComposition(project.id, compose(spec, resolve('vendor'), resolve('vendor/fonts')))
    const image = join(project.dir, 'frame.png')
    writeFileSync(image, await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer())
    let reviews = 0, writes = 0
    const provider = { id: 'openai', generateJSON: async (req: { schemaName: string }) => req.schemaName === 'CustomSceneSelection' ? { sceneIds: [spec.scenes[0].id], reason: 'diagram' } : req.schemaName === 'CodeSceneDecision' ? { useCode: false, reason: 'vector' } : { useCandidate: false, score: [6, 7, 6][reviews++], originalScore: 4, blockingIssue: false, reason: 'still needs polish' }, generateText: async () => svg.replace('#123456', ['#111111', '#abcdef', '#333333'][writes++]) } as unknown as LLMProvider
    const orchestrator = new Orchestrator(store, () => provider)
    ;(orchestrator as any).renders = { snapshot: async (_dir: string, times: number[]) => times.map(() => image), check: async () => ({ ok: true, errors: [], warnings: [] }) }
    const result = await (orchestrator as any).runCustomScenes(project.id, spec, 'custom diagram', { clips: [], captions: [] })
    expect(reviews).toBe(3)
    expect(result.customScenes[0].svg).toContain('#abcdef')
    expect(readFileSync(join(project.dir, 'index.html'), 'utf8')).toContain('#abcdef')
  })

  it('restores the exact existing composition if every candidate is rejected', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'custom diagram', platform: 'tiktok' })
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'custom-rollback-')))
    const project = store.create('custom diagram', 'test')
    store.saveComposition(project.id, compose(spec, resolve('vendor'), resolve('vendor/fonts')))
    const path = join(project.dir, 'index.html')
    const original = readFileSync(path, 'utf8') + '\n<!-- previous repair -->'
    writeFileSync(path, original)
    const image = join(project.dir, 'frame.png')
    writeFileSync(image, await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer())
    const provider = { id: 'openai', generateJSON: async (req: { schemaName: string }) => req.schemaName === 'CustomSceneSelection' ? { sceneIds: [spec.scenes[0].id], reason: 'diagram' } : { useCandidate: false, score: 4, reason: 'missing information' }, generateText: async () => svg } as unknown as LLMProvider
    const orchestrator = new Orchestrator(store, () => provider)
    ;(orchestrator as any).renders = { snapshot: async (_dir: string, times: number[]) => times.map(() => image), check: async () => ({ ok: true, errors: [], warnings: [] }) }
    const result = await (orchestrator as any).runCustomScenes(project.id, spec, 'custom diagram', { clips: [], captions: [] })
    expect(result.customScenes).toBeUndefined()
    expect(readFileSync(path, 'utf8')).toBe(original)
  })
})
