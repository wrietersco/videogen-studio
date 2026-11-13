import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { priceUsage, type MediaKind, type UsageNumbers } from '@shared/pricing'

/**
 * Usage meter — every paid API call (and every library reuse that avoided
 * one) lands here, priced from the shipped price book. Generation jobs run
 * in parallel, each inside its own scope (AsyncLocalStorage, like the licence
 * router's project tagging): the IPC layer opens a run, pipeline events name
 * the current stage, and the run is appended to the project's usage.json
 * when the job ends. `begin/end` remain for single-job surfaces (footage).
 */

export interface UsageEntry {
  at: string
  stage: string
  kind: MediaKind
  provider: string
  model: string
  usage: UsageNumbers
  usd: number
  priced: boolean
  /** a library asset was reused instead — usd is what it would have cost */
  saved?: boolean
  note?: string
}

export interface UsageRun {
  /** Stable run identity makes checkpoints idempotent. */
  id?: string
  kind: 'generate' | 'revise' | 'rerender' | 'resume' | 'library' | 'footage'
  startedAt: string
  endedAt?: string
  entries: UsageEntry[]
  totalUsd: number
  savedUsd: number
}

export interface ProjectUsage {
  runs: UsageRun[]
  totalUsd: number
  savedUsd: number
}

/** an open run plus the stage its next entries belong to (the stage never reaches usage.json) */
export interface OpenRun {
  run: UsageRun
  stage: string
  projectDir?: string
  checkpointedEntries?: number
}

const fresh = (kind: UsageRun['kind']): OpenRun => ({
  run: { id: randomUUID(), kind, startedAt: new Date().toISOString(), entries: [], totalUsd: 0, savedUsd: 0 },
  stage: 'setup'
})

class UsageMeter {
  /** the run of the job whose async context we are inside (parallel jobs) */
  private readonly scoped = new AsyncLocalStorage<OpenRun>()
  /** the single run `begin/end` surfaces use (footage, one-shot library jobs) */
  private single: OpenRun | null = null
  private listeners = new Set<(e: UsageEntry, run: UsageRun) => void>()

  private active(): OpenRun | null {
    return this.scoped.getStore() ?? this.single
  }

  begin(kind: UsageRun['kind']): void {
    this.single = fresh(kind)
  }

  /** open a run for one parallel job; everything recorded inside scope() lands in it */
  open(kind: UsageRun['kind']): OpenRun {
    return fresh(kind)
  }

  /** run `fn` with every meter.record made inside it (however deep) filed under `open` */
  scope<T>(open: OpenRun, fn: () => Promise<T>): Promise<T> {
    return this.scoped.run(open, fn)
  }

  /** Bind only this async job's ledger after its project exists. */
  bindProject(projectDir: string): void {
    const open = this.active()
    if (!open) return
    if (open.projectDir && open.projectDir !== projectDir) throw new Error('Usage run is already bound to another project')
    open.projectDir = projectDir
    this.checkpoint(open)
  }

  private checkpoint(open: OpenRun): void {
    if (!open.projectDir || !open.run.entries.length || open.checkpointedEntries === open.run.entries.length) return
    try {
      this.save(open.run, open.projectDir)
      open.checkpointedEntries = open.run.entries.length
    } catch (err) {
      // A receipt write failure must not cancel a generation; a later call or
      // normal close will try again without losing the in-memory entries.
      console.warn('[usage] checkpoint failed', err)
    }
  }

  setStage(stage: string): void {
    const open = this.active()
    if (open) open.stage = stage
  }

  onEntry(cb: (e: UsageEntry, run: UsageRun) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** record one call; safe to call with no open run (library generations open their own) */
  record(e: { kind: MediaKind; provider: string; model: string; usage: UsageNumbers; saved?: boolean; note?: string; stage?: string }): UsageEntry {
    const { usd, priced } = priceUsage(e.model, e.usage)
    const open = this.active()
    const entry: UsageEntry = {
      at: new Date().toISOString(),
      stage: e.stage ?? open?.stage ?? 'setup',
      kind: e.kind,
      provider: e.provider,
      model: e.model,
      usage: e.usage,
      usd,
      priced,
      ...(e.saved ? { saved: true } : {}),
      ...(e.note ? { note: e.note } : {})
    }
    if (open) {
      open.run.entries.push(entry)
      if (e.saved) open.run.savedUsd += usd
      else open.run.totalUsd += usd
      this.checkpoint(open)
      for (const l of this.listeners) l(entry, open.run)
    }
    return entry
  }

  current(): UsageRun | null {
    return this.active()?.run ?? null
  }

  /** close a scoped run and append it to <projectDir>/usage.json (no-op without a project) */
  close(open: OpenRun, projectDir: string | null): UsageRun {
    if (open.projectDir && projectDir && open.projectDir !== projectDir) throw new Error('Usage run cannot close against another project')
    return this.file(open.run, open.projectDir ?? projectDir)
  }

  /** close the run and append it to <projectDir>/usage.json (no-op without a project) */
  end(projectDir: string | null): UsageRun | null {
    const open = this.single
    this.single = null
    return open ? this.close(open, projectDir) : null
  }

  private file(run: UsageRun, projectDir: string | null): UsageRun {
    run.endedAt = new Date().toISOString()
    if (projectDir && run.entries.length > 0) {
      this.save(run, projectDir)
    }
    return run
  }

  private save(run: UsageRun, projectDir: string): void {
    const u = readProjectUsage(projectDir)
    const index = run.id ? u.runs.findIndex(r => r.id === run.id) : -1
    if (index < 0) u.runs.push(run)
    else u.runs[index] = run
    u.totalUsd = u.runs.reduce((a, r) => a + r.totalUsd, 0)
    u.savedUsd = u.runs.reduce((a, r) => a + r.savedUsd, 0)
    const target = join(projectDir, 'usage.json'), temp = join(projectDir, `.usage-${randomUUID()}.tmp`)
    try { writeFileSync(temp, JSON.stringify(u, null, 2)); renameSync(temp, target) }
    finally { if (existsSync(temp)) try { unlinkSync(temp) } catch { /* best effort */ } }
  }
}

export function readProjectUsage(projectDir: string): ProjectUsage {
  const p = join(projectDir, 'usage.json')
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as ProjectUsage
    } catch {
      /* corrupt → start fresh */
    }
  }
  return { runs: [], totalUsd: 0, savedUsd: 0 }
}

export const meter = new UsageMeter()
