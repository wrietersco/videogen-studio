import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planDuration, type EditPlan, type EditRecord, type FootageClip, type FootageEvent, type FootageProject, type PlanRequest, type PlanResult, type UnderstandEstimate } from '../../shared/footage'
import type { LLMProvider } from '../providers/types'
import { planEdit } from './planner'
import { renderPlan, RenderCancelled } from './render'
import { clipIdFor, frameBuffer, listVideoFiles, scanClip } from './scan'
import { FootageStore, slug } from './store'
import { estimateUnderstanding, listenToClip, watchClip } from './understand'

export interface FootageDeps {
  store: FootageStore
  provider: () => LLMProvider
  /** OpenAI key for Whisper; empty = speech is not transcribed */
  whisperKey: () => string
  chatModel: () => string | undefined
  emit: (e: FootageEvent) => void
}

export class FootageCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

type ScanEvent = Omit<Extract<FootageEvent, { kind: 'scan' }>, 'kind' | 'projectId'>
type UnderstandEvent = Omit<Extract<FootageEvent, { kind: 'understand' }>, 'kind' | 'projectId'>

/** Orchestrates scanning, understanding, planning and rendering for footage projects. One job at a time. */
export class FootageService {
  private cancelled = false

  constructor(private readonly d: FootageDeps) {}

  cancel(): void {
    this.cancelled = true
  }

  private project(id: string): FootageProject {
    const p = this.d.store.read(id)
    if (!p) throw new Error('That footage project no longer exists')
    return p
  }

  /** free: find the videos, read their length and sound, cut them into shots, grab keyframes */
  async scan(projectId: string): Promise<void> {
    this.cancelled = false
    const emit = (e: ScanEvent) => this.d.emit({ kind: 'scan', projectId, ...e })
    emit({ status: 'started' })
    try {
      const project = this.project(projectId)
      const projectDir = this.d.store.dir(projectId)
      const files = listVideoFiles(project.folders.filter((f) => existsSync(f)))
      const existing = new Map(project.clips.map((c) => [c.path.toLowerCase(), c]))
      const keep = new Map<string, FootageClip>()
      const todo: Array<{ path: string; folder: string }> = []
      for (const f of files) {
        const old = existing.get(f.path.toLowerCase())
        let same = false
        try {
          const st = statSync(f.path)
          same = !!old && old.status === 'ok' && old.sizeBytes === st.size && old.mtimeMs === Math.round(st.mtimeMs)
        } catch {
          same = false
        }
        if (same && old) keep.set(old.id, { ...old, folder: f.folder })
        else todo.push(f)
      }
      const scanned: FootageClip[] = []
      let done = 0
      for (const f of todo) {
        if (this.cancelled) throw new FootageCancelled()
        emit({ status: 'progress', done, total: todo.length, clipName: f.path.split(/[\\/]/).pop() })
        try {
          scanned.push(await scanClip(f, projectDir))
        } catch (err) {
          scanned.push({ ...emptyClip(f), error: String((err as Error)?.message ?? err) })
        }
        done++
        if (done % 5 === 0) this.persist(projectId, project, keep, scanned, files)
      }
      this.persist(projectId, project, keep, scanned, files)
      const bad = scanned.filter((c) => c.status !== 'ok').length
      emit({ status: 'done', done: todo.length, total: todo.length, ...(bad ? { note: `${bad} file${bad > 1 ? 's' : ''} could not be read and will be skipped.` } : {}) })
    } catch (err) {
      if (err instanceof FootageCancelled) {
        emit({ status: 'done', note: 'Stopped. What was scanned so far is saved.' })
        return
      }
      emit({ status: 'failed', error: String((err as Error)?.message ?? err) })
    }
  }

  private persist(projectId: string, project: FootageProject, keep: Map<string, FootageClip>, scanned: FootageClip[], files: Array<{ path: string }>): void {
    const present = new Set(files.map((f) => f.path.toLowerCase()))
    const merged = new Map<string, FootageClip>(keep)
    for (const c of scanned) merged.set(c.id, c)
    // files that vanished stay in the list as "missing" so edits that use them can say why they fail
    for (const old of project.clips) if (!merged.has(old.id) && !present.has(old.path.toLowerCase())) merged.set(old.id, { ...old, status: 'missing' })
    const order = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    this.d.store.update(projectId, (p) => {
      p.clips = order
    })
  }

  estimate(projectId: string): UnderstandEstimate {
    const p = this.project(projectId)
    return estimateUnderstanding(p.clips, this.d.chatModel(), Boolean(this.d.whisperKey()))
  }

  /** paid: the AI looks at a frame of every shot and listens to the speech */
  async understand(projectId: string): Promise<void> {
    this.cancelled = false
    const emit = (e: UnderstandEvent) => this.d.emit({ kind: 'understand', projectId, ...e })
    emit({ status: 'started' })
    try {
      const provider = this.d.provider()
      if (provider.id === 'mock') throw new Error('Connect an AI provider in Settings first: the free offline engine cannot watch videos.')
      const key = this.d.whisperKey()
      const projectDir = this.d.store.dir(projectId)
      const todo = this.project(projectId).clips.filter((c) => c.status === 'ok' && (!c.watched || (key && !c.listened)))
      let failures = 0
      for (let i = 0; i < todo.length; i++) {
        if (this.cancelled) throw new FootageCancelled()
        emit({ status: 'progress', done: i, total: todo.length, note: todo[i].name })
        const clip = structuredClone(todo[i])
        try {
          if (!clip.watched) await watchClip(provider, clip, projectDir, () => this.cancelled)
          if (key && !clip.listened) await listenToClip(key, clip, projectDir, () => this.cancelled)
          failures = 0
        } catch (err) {
          failures++
          if (failures >= 3) {
            this.save(projectId, clip)
            throw new Error(`Stopped after repeated errors: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
          }
        }
        this.save(projectId, clip)
      }
      if (this.cancelled) throw new FootageCancelled()
      emit({
        status: 'done',
        done: todo.length,
        total: todo.length,
        ...(key ? {} : { note: 'Speech was not transcribed: add an OpenAI key in Settings to let the editor understand what is said.' })
      })
    } catch (err) {
      if (err instanceof FootageCancelled) {
        emit({ status: 'done', note: 'Stopped. Clips finished so far are saved.' })
        return
      }
      emit({ status: 'failed', error: String((err as Error)?.message ?? err) })
    }
  }

  private save(projectId: string, clip: FootageClip): void {
    this.d.store.update(projectId, (p) => {
      const i = p.clips.findIndex((c) => c.id === clip.id)
      if (i >= 0) p.clips[i] = clip
    })
  }

  async plan(projectId: string, req: PlanRequest): Promise<PlanResult> {
    const p = this.project(projectId)
    const outcome = await planEdit(this.d.provider(), p.clips, req)
    return { plan: outcome.plan, source: outcome.source, thumbs: await this.thumbs(p.clips, outcome.plan) }
  }

  /** a small picture from the middle of each planned segment */
  async thumbs(clips: FootageClip[], plan: EditPlan): Promise<string[]> {
    const byId = new Map(clips.map((c) => [c.id, c]))
    const out: string[] = new Array(plan.segments.length).fill('')
    let next = 0
    const worker = async () => {
      while (next < plan.segments.length) {
        const i = next++
        const s = plan.segments[i]
        const clip = byId.get(s.clipId)
        if (!clip || i >= 60) continue
        const buf = await frameBuffer(clip.path, (s.startSec + s.endSec) / 2, 240)
        if (buf) out[i] = `data:image/jpeg;base64,${buf.toString('base64')}`
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return out
  }

  posters(projectId: string): Record<string, string> {
    const p = this.project(projectId)
    const dir = this.d.store.dir(projectId)
    const out: Record<string, string> = {}
    for (const c of p.clips) {
      const f = c.shots.find((s) => s.frame)?.frame
      if (f && existsSync(join(dir, f))) out[c.id] = `data:image/jpeg;base64,${readFileSync(join(dir, f)).toString('base64')}`
    }
    return out
  }

  async render(projectId: string, plan: EditPlan, prompt: string, onProgress: (pct: number, phase: string) => void): Promise<EditRecord> {
    this.cancelled = false
    const p = this.project(projectId)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const file = join(this.d.store.editsDir(projectId), `${slug(plan.title).slice(0, 40) || 'edit'}-${plan.shape.replace(':', 'x')}-${stamp}.mp4`)
    try {
      const out = await renderPlan({
        plan,
        clips: p.clips,
        workDir: join(this.d.store.dir(projectId), 'work'),
        outFile: file,
        isCancelled: () => this.cancelled,
        onProgress
      })
      const edit: EditRecord = { id: randomUUID().slice(0, 8), title: plan.title, createdAt: new Date().toISOString(), prompt, shape: plan.shape, durationSec: out.durationSec || planDuration(plan), file: out.file }
      this.d.store.addEdit(projectId, edit)
      return edit
    } catch (err) {
      if (err instanceof RenderCancelled) throw new FootageCancelled()
      throw err
    }
  }
}

function emptyClip(f: { path: string; folder: string }): FootageClip {
  const st = statSync(f.path)
  return { id: clipIdFor(f.path), path: f.path, name: f.path.split(/[\\/]/).pop() ?? f.path, folder: f.folder, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), durationSec: 0, width: 0, height: 0, fps: 30, hasAudio: false, shots: [], watched: false, listened: false, status: 'unreadable' }
}
