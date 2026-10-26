import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, readdirSync } from 'node:fs'
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
  status: 'planning' | 'composed' | 'rendering' | 'done' | 'error'
  lastError?: string
  renders: Array<{ file: string; platform: string; createdAt: string }>
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
