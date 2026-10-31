import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EditRecord, FootageClip, FootageProject, FootageSummary } from '../../shared/footage'

/**
 * footage/<id>/{project.json, frames/, edits/}. Only this folder is ever
 * written or deleted — the person's own video folders are read-only to us.
 */
export class FootageStore {
  constructor(readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true })
  }

  dir(id: string): string {
    const d = resolve(this.rootDir, id)
    // ids come from the renderer: never let one point outside the store
    if (!d.startsWith(resolve(this.rootDir) + sep) || id.includes('..')) throw new Error('Invalid project id')
    return d
  }

  exists(id: string): boolean {
    try {
      return existsSync(join(this.dir(id), 'project.json'))
    } catch {
      return false
    }
  }

  create(name: string, folders: string[]): FootageProject {
    const id = `${slug(name).slice(0, 28) || 'footage'}-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`
    const now = new Date().toISOString()
    const project: FootageProject = { id, name: name.trim().slice(0, 80) || 'My footage', createdAt: now, updatedAt: now, folders: dedupe(folders), clips: [], edits: [] }
    mkdirSync(join(this.dir(id), 'frames'), { recursive: true })
    mkdirSync(join(this.dir(id), 'edits'), { recursive: true })
    this.write(project)
    return project
  }

  read(id: string): FootageProject | null {
    if (!this.exists(id)) return null
    try {
      const p = JSON.parse(readFileSync(join(this.dir(id), 'project.json'), 'utf8')) as FootageProject
      return { ...p, folders: p.folders ?? [], clips: p.clips ?? [], edits: p.edits ?? [] }
    } catch {
      return null
    }
  }

  /** atomic: a crash mid-write cannot leave a half-written project */
  write(project: FootageProject): void {
    const file = join(this.dir(project.id), 'project.json')
    project.updatedAt = new Date().toISOString()
    writeFileSync(file + '.tmp', JSON.stringify(project))
    renameSync(file + '.tmp', file)
  }

  update(id: string, change: (p: FootageProject) => void): FootageProject {
    const p = this.read(id)
    if (!p) throw new Error('That footage project no longer exists')
    change(p)
    this.write(p)
    return p
  }

  list(): FootageSummary[] {
    if (!existsSync(this.rootDir)) return []
    const out: FootageSummary[] = []
    for (const e of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = this.read(e.name)
      if (!p) continue
      out.push({
        id: p.id,
        name: p.name,
        updatedAt: p.updatedAt,
        folders: p.folders,
        clipCount: p.clips.filter((c) => c.status === 'ok').length,
        editCount: p.edits.length,
        totalSec: p.clips.filter((c) => c.status === 'ok').reduce((a, c) => a + c.durationSec, 0)
      })
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** removes the project's own folder (indexes, keyframes and rendered edits); never touches source footage */
  delete(id: string): boolean {
    if (!this.exists(id)) return false
    rmSync(this.dir(id), { recursive: true, force: true })
    return true
  }

  addEdit(id: string, edit: EditRecord): void {
    this.update(id, (p) => {
      p.edits.unshift(edit)
    })
  }

  removeEdit(id: string, editId: string): void {
    const p = this.read(id)
    const edit = p?.edits.find((e) => e.id === editId)
    if (!p || !edit) return
    const target = resolve(edit.file)
    // delete the render only if it really lives in this project's edits folder
    if (target.startsWith(resolve(this.dir(id), 'edits') + sep)) rmSync(target, { force: true })
    this.update(id, (q) => {
      q.edits = q.edits.filter((e) => e.id !== editId)
    })
  }

  editsDir(id: string): string {
    const d = join(this.dir(id), 'edits')
    mkdirSync(d, { recursive: true })
    return d
  }

  setClips(id: string, clips: FootageClip[]): void {
    this.update(id, (p) => {
      p.clips = clips
    })
  }
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function dedupe(folders: string[]): string[] {
  const seen = new Set<string>()
  return folders.filter((f) => {
    const k = resolve(f).toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
