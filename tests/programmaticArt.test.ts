import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { Orchestrator } from '../src/main/pipeline/orchestrator'
import { ProjectStore } from '../src/main/store/projectStore'
import { Planner, enforceSceneGrid } from '../src/main/pipeline/planner'
import { MockProvider } from '../src/main/providers/mock'
import { compose } from '../src/main/composer'
import { programmaticSettings, PROGRAMMATIC_MEDIA } from '../src/main/license/access'
import { DEFAULT_SETTINGS } from '../src/main/settings'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#123456"/><g id="motion1"><circle cx="50" cy="50" r="20" fill="#fff"/></g></svg>'

/** a code model that answers the questions the custom-scene stage asks */
function coder(asked: string[], answers: Record<string, unknown> = {}): LLMProvider {
  return {
    id: 'deepseek',
    label: 'fake coder',
    isConfigured: async () => true,
    listModels: async () => [],
    generateText: async () => svg,
    generateJSON: async <T,>(r: GenerateJSONRequest) => {
      asked.push(r.schemaName)
      if (!(r.schemaName in answers)) throw new Error(`unexpected ${r.schemaName}`)
      return answers[r.schemaName] as T
    }
  }
}

describe('programmatic settings', () => {
  it('is the plain free engine without own keys', () => {
    const own = { ...DEFAULT_SETTINGS, provider: 'deepseek' as const, media: { image: 'gemini:gemini-3.1-flash-image', voice: 'auto', music: 'builtin:procedural', video: 'stock' } }
    const free = programmaticSettings(own, false)
    expect(free.provider).toBe('mock')
    expect(free.media).toEqual(PROGRAMMATIC_MEDIA)
  })

  it('runs the user’s own engine unchanged when artistic (own keys)', () => {
    const own = { ...DEFAULT_SETTINGS, provider: 'deepseek' as const, media: { image: 'gemini:gemini-3.1-flash-image', voice: 'auto', music: 'builtin:procedural', video: 'stock' } }
    expect(programmaticSettings(own, true)).toBe(own)
  })
})

describe('code-authored scenes on a programmatic run', () => {
  it('lets the code model choose the scenes when the writer is the free engine', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'how gears work', platform: 'tiktok' })
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'art-choose-')))
    const project = store.create('how gears work', 'test')
    const asked: string[] = []
    const orch = new Orchestrator(store, () => new MockProvider(), () => null, null, () => coder(asked, { CustomSceneSelection: { sceneIds: [], reason: 'none' } })) as any
    const out = await orch.runCustomScenes(project.id, spec, 'how gears work', { clips: [], captions: [] }, () => {})
    expect(asked).toEqual(['CustomSceneSelection'])
    expect(out).toBe(spec)
  })

  it('leaves the choice with the writer on an AI run, and skips the stage with no code model', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'how gears work', platform: 'tiktok' })
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'art-writer-')))
    const project = store.create('how gears work', 'test')
    const writerAsked: string[] = []
    const coderAsked: string[] = []
    const writer = { ...coder(writerAsked, { CustomSceneSelection: { sceneIds: [], reason: 'none' } }), id: 'openai' as const }
    const ai = new Orchestrator(store, () => writer, () => null, null, () => coder(coderAsked)) as any
    await ai.runCustomScenes(project.id, spec, 'how gears work', { clips: [], captions: [] }, () => {})
    expect(writerAsked).toEqual(['CustomSceneSelection'])
    expect(coderAsked).toEqual([])
    const free = new Orchestrator(store, () => new MockProvider()) as any
    expect(await free.runCustomScenes(project.id, spec, 'how gears work', { clips: [], captions: [] }, () => {})).toBe(spec)
  })

  it('accepts a candidate that passed the render checks when no visual reviewer is on the run', async () => {
    const spec = await new Planner(new MockProvider()).plan({ userPrompt: 'how gears work', platform: 'tiktok' })
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'art-accept-')))
    const project = store.create('how gears work', 'test')
    store.saveSpec(project.id, spec)
    store.saveComposition(project.id, compose(spec, resolve('vendor'), resolve('vendor/fonts')))
    const asked: string[] = []
    const orch = new Orchestrator(store, () => new MockProvider(), () => null, null, () => coder(asked, { CodeSceneDecision: { useCode: false, reason: 'a diagram is enough' } }), () => new MockProvider()) as any
    let shot = 0
    orch.renders = {
      check: async () => ({ ok: true, errors: [], warnings: [], raw: '' }),
      snapshot: async (_dir: string, times: number[], out: string) => {
        mkdirSync(out, { recursive: true })
        return Promise.all(
          times.map(async (_t, i) => {
            const file = join(out, `frame-${shot++}.png`)
            await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 90 + i * 50, g: 120, b: 160 } } }).png().toFile(file)
            return file
          })
        )
      }
    }
    const sceneId = spec.scenes[0].id
    const events: Array<{ stage: string; status: string; accepted?: boolean }> = []
    const out = await orch.runCustomScenes(project.id, spec, 'how gears work', { clips: [], captions: [] }, (e: never) => events.push(e), new Map([[sceneId, 'draw it as a diagram']]))
    expect(out.customScenes?.map((c: { sceneId: string }) => c.sceneId)).toEqual([sceneId])
    expect(events.find((e) => e.stage === 'custom' && e.status === 'scene')?.accepted).toBe(true)
    expect(store.readState(project.id)?.events.some((e: { text: string }) => e.text.includes('no visual reviewer on this run'))).toBe(true)
  })
})

describe('exact scene grid', () => {
  it('holds a plan to N scenes of S seconds and keeps narration with its scene', async () => {
    const plan = await new Planner(new MockProvider()).plan({ userPrompt: 'how gears work', platform: 'youtube', styleHint: 'explainer' })
    const closing = plan.narration.find((n) => n.sceneId === plan.scenes[plan.scenes.length - 1].id)?.text
    const grid = enforceSceneGrid(plan, 5, 8)
    expect(grid.scenes.map((s) => s.durationSec)).toEqual([8, 8, 8, 8, 8])
    expect(grid.scenes.map((s) => s.id)).toEqual(['scene-1', 'scene-2', 'scene-3', 'scene-4', 'scene-5'])
    expect(grid.durationSec).toBe(40)
    expect(grid.scenes[0].kind).toBe(plan.scenes[0].kind)
    expect(grid.scenes[4].kind).toBe(plan.scenes[plan.scenes.length - 1].kind)
    expect(grid.narration.find((n) => n.sceneId === 'scene-5')?.text).toBe(closing)
  })

  it('fills a short plan, plans straight to the grid, and leaves an unasked plan alone', async () => {
    const planner = new Planner(new MockProvider())
    const plan = await planner.plan({ userPrompt: 'how gears work', platform: 'youtube', styleHint: 'social' })
    expect(enforceSceneGrid(plan, 8, 5).scenes).toHaveLength(8)
    expect(enforceSceneGrid(plan)).toBe(plan)
    const direct = await planner.plan({ userPrompt: 'how gears work', platform: 'youtube', sceneCount: 5, sceneSec: 8 })
    expect(direct.scenes.map((s) => s.durationSec)).toEqual([8, 8, 8, 8, 8])
    expect(direct.durationSec).toBe(40)
  })
})
