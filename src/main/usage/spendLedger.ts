import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { ProjectUsage } from './meter'

/**
 * Spend ledger — when a video is deleted for good, everything about it goes
 * except what it cost. Only totals are kept (no ids, titles, prompts or files),
 * so the app's running cost still adds up after a deletion.
 */

export interface SpendLedger {
  /** videos erased from this PC */
  videos: number
  totalUsd: number
  savedUsd: number
  /** spend by kind of work (text, image, voice, music, video…) */
  byKind: Record<string, number>
}

const EMPTY = (): SpendLedger => ({ videos: 0, totalUsd: 0, savedUsd: 0, byKind: {} })

export class SpendLedgerStore {
  constructor(private readonly file: string) {}

  read(): SpendLedger {
    if (!existsSync(this.file)) return EMPTY()
    try {
      return { ...EMPTY(), ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SpendLedger>) }
    } catch {
      return EMPTY()
    }
  }

  /** fold a deleted video's receipts into the totals */
  add(usage: ProjectUsage): SpendLedger {
    const l = this.read()
    l.videos += 1
    for (const run of usage.runs ?? []) {
      for (const e of run.entries ?? []) {
        if (e.saved) l.savedUsd += e.usd
        else {
          l.totalUsd += e.usd
          l.byKind[e.kind] = (l.byKind[e.kind] ?? 0) + e.usd
        }
      }
    }
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(l, null, 2))
    renameSync(tmp, this.file)
    return l
  }
}
