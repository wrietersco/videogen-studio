import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { priceUsage, type MediaKind, type UsageNumbers } from '@shared/pricing'

/**
 * Usage meter — every paid API call (and every library reuse that avoided
 * one) lands here, priced from the shipped price book. Jobs run one at a
 * time, so a single module-level ledger is enough: the IPC layer opens a run,
 * pipeline events name the current stage, and the run is appended to the
 * project's usage.json when the job ends.
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

class UsageMeter {
  private run: UsageRun | null = null
  private stage = 'setup'
  private listeners = new Set<(e: UsageEntry, run: UsageRun) => void>()

  begin(kind: UsageRun['kind']): void {
    this.run = { kind, startedAt: new Date().toISOString(), entries: [], totalUsd: 0, savedUsd: 0 }
    this.stage = 'setup'
  }

  setStage(stage: string): void {
    this.stage = stage
  }

  onEntry(cb: (e: UsageEntry, run: UsageRun) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** record one call; safe to call with no open run (library generations open their own) */
  record(e: { kind: MediaKind; provider: string; model: string; usage: UsageNumbers; saved?: boolean; note?: string; stage?: string }): UsageEntry {
    const { usd, priced } = priceUsage(e.model, e.usage)
    const entry: UsageEntry = {
      at: new Date().toISOString(),
      stage: e.stage ?? this.stage,
      kind: e.kind,
      provider: e.provider,
      model: e.model,
      usage: e.usage,
      usd,
      priced,
      ...(e.saved ? { saved: true } : {}),
      ...(e.note ? { note: e.note } : {})
    }
    if (this.run) {
      this.run.entries.push(entry)
      if (e.saved) this.run.savedUsd += usd
      else this.run.totalUsd += usd
      for (const l of this.listeners) l(entry, this.run)
    }
    return entry
  }

  current(): UsageRun | null {
    return this.run
  }

  /** close the run and append it to <projectDir>/usage.json (no-op without a project) */
  end(projectDir: string | null): UsageRun | null {
    const run = this.run
    this.run = null
    if (!run) return null
    run.endedAt = new Date().toISOString()
    if (projectDir && run.entries.length > 0) {
      const u = readProjectUsage(projectDir)
      u.runs.push(run)
      u.totalUsd = u.runs.reduce((a, r) => a + r.totalUsd, 0)
      u.savedUsd = u.runs.reduce((a, r) => a + r.savedUsd, 0)
      writeFileSync(join(projectDir, 'usage.json'), JSON.stringify(u, null, 2))
    }
    return run
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
