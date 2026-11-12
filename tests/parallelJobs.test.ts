import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator, GenerationCancelled } from '../src/main/pipeline/orchestrator'
import { ProjectStore } from '../src/main/store/projectStore'
import { MockProvider } from '../src/main/providers/mock'

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** an orchestrator whose heavy stages are quick stand-ins, so two can interleave in a test */
function quickJob(store: ProjectStore, composeMs: number) {
  const orch = new Orchestrator(store, () => new MockProvider())
  const internal = orch as any
  internal.runCompose = vi.fn(async () => {
    await wait(composeMs)
    return { clips: [], captions: [], hasNarration: false }
  })
  internal.runQaLoop = vi.fn(async () => ({ ok: true, errors: [], warnings: [] }))
  internal.captureThumbs = vi.fn(async () => {})
  internal.runRender = vi.fn(async (projectId: string, _spec: unknown, _platform: unknown, _opts: unknown, emit: (e: unknown) => void) => {
    const result = { projectId, output: `${projectId}.mp4` }
    emit({ stage: 'done', ...result })
    return result
  })
  return orch
}

describe('parallel generation jobs', () => {
  it('runs two jobs at once on one store without mixing their projects or events', async () => {
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'parallel-')))
    const a = quickJob(store, 40)
    const b = quickJob(store, 15)
    const eventsA: Array<{ stage: string; projectId?: string }> = []
    const eventsB: Array<{ stage: string; projectId?: string }> = []
    const [ra, rb] = await Promise.all([
      a.generate({ prompt: 'why the sky is blue', platform: 'tiktok', craft: 'classic', quality: 'draft', onEvent: (e) => eventsA.push(e as never) }),
      b.generate({ prompt: 'how coffee is roasted', platform: 'youtube', craft: 'classic', quality: 'draft', onEvent: (e) => eventsB.push(e as never) })
    ])
    expect(ra.projectId).not.toBe(rb.projectId)
    expect(a.activeProjectId).toBe(ra.projectId)
    expect(b.activeProjectId).toBe(rb.projectId)
    expect(eventsA.find((e) => e.stage === 'done')?.projectId).toBe(ra.projectId)
    expect(eventsB.find((e) => e.stage === 'done')?.projectId).toBe(rb.projectId)
    expect(store.readSpec(ra.projectId)?.platform).toBe('tiktok')
    expect(store.readSpec(rb.projectId)?.platform).toBe('youtube')
  })

  it('stops one job without touching the other', async () => {
    const store = new ProjectStore(mkdtempSync(join(tmpdir(), 'parallel-stop-')))
    const a = quickJob(store, 60)
    const b = quickJob(store, 60)
    const runA = a.generate({ prompt: 'the water cycle', platform: 'tiktok', craft: 'classic', quality: 'draft' })
    const runB = b.generate({ prompt: 'the rock cycle', platform: 'tiktok', craft: 'classic', quality: 'draft' })
    await wait(20)
    a.cancel()
    await expect(runA).rejects.toBeInstanceOf(GenerationCancelled)
    const rb = await runB
    expect(store.readSpec(rb.projectId)).not.toBeNull()
  })
})
