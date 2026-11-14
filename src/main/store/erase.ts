import { existsSync, rmSync } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import type { ProjectStore } from './projectStore'
import type { AssetLibrary } from '../assets/library'
import { readProjectUsage, type ProjectUsage } from '../usage/meter'
import type { SpendLedgerStore } from '../usage/spendLedger'

/**
 * Erase a video and every trace of it from this PC: its folder (spec, scenes,
 * renders, thumbnails, receipts), renders saved elsewhere, and the library
 * files that were made only for it. Library assets other videos also use stay,
 * minus this video's name. Only its cost survives, as totals in the ledger.
 */

export interface EraseResult {
  ok: boolean
  error?: string
  /** library files removed with the video */
  assets?: number
  /** renders that were saved outside the project folder and removed too */
  files?: number
}

/** drop library assets that exist only because of these usage tags, and un-tag the shared ones */
export function releaseLibrary(library: AssetLibrary, tags: string[]): number {
  let removed = 0
  for (const a of library.all()) {
    if (!a.usedIn.some((t) => tags.includes(t))) continue
    const rest = a.usedIn.filter((t) => !tags.includes(t))
    if (rest.length === 0 && a.source === 'generated' && a.favorite !== true) {
      if (library.remove(a.id)) removed += 1
    } else if (rest.length !== a.usedIn.length) {
      library.setUsedIn(a.id, rest)
    }
  }
  return removed
}

export function eraseProject(d: { store: ProjectStore; library: AssetLibrary; ledger: SpendLedgerStore }, id: string): EraseResult {
  if (!/^[a-z0-9-]+$/i.test(id)) return { ok: false, error: 'Invalid video' }
  const dir = d.store.dir(id)
  if (!existsSync(dir)) return { ok: false, error: 'This video is already gone' }
  const usage: ProjectUsage = readProjectUsage(dir)
  const meta = d.store.readMeta(id)
  // renders saved outside the project folder (absolute paths) belong to the video too
  const outside = (meta?.renders ?? [])
    .map((r) => (r.file && isAbsolute(r.file) ? resolve(r.file) : ''))
    .filter((f) => f && !f.startsWith(dir + sep) && ['.mp4', '.mov', '.webm'].includes(extname(f).toLowerCase()) && existsSync(f))
  if (!d.store.delete(id)) return { ok: false, error: 'Some files are still in use. Close any player showing this video and try again.' }
  let files = 0
  for (const f of outside) {
    try { rmSync(f, { force: true }); files += 1 } catch { /* best effort; the folder is already gone */ }
  }
  const assets = releaseLibrary(d.library, [id, `p-${id}`])
  d.ledger.add(usage)
  return { ok: true, assets, files }
}
