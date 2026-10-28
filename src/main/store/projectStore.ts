import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync, rmSync, renameSync } from 'node:fs'
import { resolve, join, dirname as pathDirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { VideoSpec } from '@shared/spec'
import type { ComposeResult } from '../composer'

/**
 * Project store — every generated video is a folder on disk:
 *   projects/<id>/{project.json, spec.json, index.html, assets/, renders/}
 * Everything needed to re-render or edit lives here (resumable, editable).
 */

export interface ProjectMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  prompt: string
  platform?: string
  status: 'planning' | 'composed' | 'rendering' | 'done' | 'error' | 'cancelled'
  lastError?: string
  renders: Array<{ file: string; platform: string; createdAt: string }>
}

// ---------------- pipeline state (crash-safe resume) ----------------

export type StageName = 'plan' | 'direct' | 'plates' | 'compose' | 'qa' | 'critic' | 'thumbs' | 'render'

export interface StageState {
  status: 'pending' | 'running' | 'done' | 'failed'
  startedAt?: string
  finishedAt?: string
  detail?: string
}

export interface ProjectState {
  version: 1
  stages: Record<StageName, StageState>
  /** rolling activity log, newest last (capped) */
  events: Array<{ at: string; text: string }>
  updatedAt: string
}

const EMPTY_STATE: ProjectState = {
  version: 1,
  stages: {
    plan: { status: 'pending' },
    direct: { status: 'pending' },
    plates: { status: 'pending' },
    compose: { status: 'pending' },
    qa: { status: 'pending' },
    critic: { status: 'pending' },
    thumbs: { status: 'pending' },
    render: { status: 'pending' }
  },
  events: [],
  updatedAt: now()
}

export class ProjectStore {
  constructor(readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true })
  }

  create(prompt: string, title: string): { id: string; dir: string } {
    const id = `${slug(title).slice(0, 32) || 'video'}-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`
    const dir = this.dir(id)
    mkdirSync(join(dir, 'assets', 'vendor'), { recursive: true })
    mkdirSync(join(dir, 'assets', 'fonts'), { recursive: true })
    mkdirSync(join(dir, 'renders'), { recursive: true })
    this.writeMeta(id, {
      id,
      title,
      createdAt: now(),
      updatedAt: now(),
      prompt,
      status: 'planning',
      renders: []
    })
    return { id, dir }
  }

  dir(id: string): string {
    return resolve(this.rootDir, id)
  }

  /** Remove a project folder. Ids are system-generated, but guard anyway. */
  delete(id: string): boolean {
    if (!/^[a-z0-9-]+$/i.test(id)) return false
    const dir = this.dir(id)
    if (!existsSync(dir)) return false
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    return !existsSync(dir)
  }

  // ---------------- pipeline state (crash-safe resume) ----------------

  private statePath(id: string): string {
    return join(this.dir(id), 'state.json')
  }

  readState(id: string): ProjectState {
    const p = this.statePath(id)
    if (!existsSync(p)) return structuredClone(EMPTY_STATE)
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as ProjectState
      // merge over defaults so new stages appear after app updates
      return { ...structuredClone(EMPTY_STATE), ...raw, stages: { ...EMPTY_STATE.stages, ...raw.stages } }
    } catch {
      return structuredClone(EMPTY_STATE) // corrupted state — start clean
    }
  }

  /** Atomic write (tmp + rename) so a crash mid-write can't corrupt state. */
  writeState(id: string, mutate: (s: ProjectState) => void): void {
    const state = this.readState(id)
    mutate(state)
    state.updatedAt = now()
    const p = this.statePath(id)
    const tmp = `${p}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, p)
  }

  setStage(id: string, stage: StageName, patch: Partial<StageState>): void {
    this.writeState(id, (s) => {
      s.stages[stage] = { ...s.stages[stage], ...patch }
    })
  }

  appendEvent(id: string, text: string): void {
    this.writeState(id, (s) => {
      s.events.push({ at: now(), text })
      if (s.events.length > 60) s.events = s.events.slice(-60)
    })
  }

  list(): ProjectMeta[] {
    if (!existsSync(this.rootDir)) return []
    return readdirSafe(this.rootDir)
      .map((id) => this.readMeta(id))
      .filter((m): m is ProjectMeta => m !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  readMeta(id: string): ProjectMeta | null {
    const p = join(this.dir(id), 'project.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as ProjectMeta
  }

  writeMeta(id: string, meta: ProjectMeta): void {
    meta.updatedAt = now()
    writeFileSync(join(this.dir(id), 'project.json'), JSON.stringify(meta, null, 2))
  }

  setStatus(id: string, status: ProjectMeta['status'], error?: string): void {
    const meta = this.readMeta(id)
    if (!meta) return
    meta.status = status
    meta.lastError = error
    this.writeMeta(id, meta)
  }

  saveSpec(id: string, spec: VideoSpec): void {
    writeFileSync(join(this.dir(id), 'spec.json'), JSON.stringify(spec, null, 2))
  }

  /** keep a copy of the spec before a hand edit, so the editor can go back (newest last, 20 kept) */
  pushHistory(id: string, spec: VideoSpec): void {
    const dir = join(this.dir(id), 'history')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${Date.now()}.json`), JSON.stringify(spec))
    const all = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    for (const f of all.slice(0, Math.max(0, all.length - 20))) rmSync(join(dir, f), { force: true })
  }

  /** previous versions (newest first) */
  listHistory(id: string): Array<{ at: number; title: string; scenes: number; durationSec: number }> {
    const dir = join(this.dir(id), 'history')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse()
      .flatMap((f) => {
        try {
          const sp = JSON.parse(readFileSync(join(dir, f), 'utf8')) as VideoSpec
          return [{ at: Number(f.replace('.json', '')), title: sp.title, scenes: sp.scenes.length, durationSec: sp.durationSec }]
        } catch {
          return []
        }
      })
  }

  readHistory(id: string, at: number): VideoSpec | null {
    const p = join(this.dir(id), 'history', `${Math.round(at)}.json`)
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as VideoSpec) : null
  }

  readSpec(id: string): VideoSpec | null {
    const p = join(this.dir(id), 'spec.json')
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf8')) as VideoSpec
  }

  saveComposition(id: string, result: ComposeResult): void {
    const dir = this.dir(id)
    writeFileSync(join(dir, 'index.html'), result.html)
    for (const a of result.assets) {
      const dest = join(dir, a.to)
      mkdirSync(pathDirname(dest), { recursive: true })
      cpSync(a.from, dest)
    }
    this.setStatus(id, 'composed')
  }

  addRender(id: string, file: string, platform: string): void {
    const meta = this.readMeta(id)
    if (!meta) return
    meta.renders.push({ file, platform, createdAt: now() })
    this.writeMeta(id, meta)
  }
}

function now(): string {
  return new Date().toISOString()
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** stable content hash — used by the determinism gate in tests */
export function contentHash(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}
