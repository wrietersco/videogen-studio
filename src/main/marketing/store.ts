import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isBusinessId, isCardId, isMarketRunId, type BusinessProfile, type MarketRunRecord } from '../../shared/marketing'

/**
 * Business profiles and their film runs, on this computer.
 *
 *   <root>/businesses.json           the profiles (site, brand, cards)
 *   <root>/<id>/site.md              the whole site read as one file
 *   <root>/<id>/brand/               the logo taken from the site
 *   <root>/runs/<id>/run.json        one film: what was chosen and made
 *
 * "Forget this business" removes all of it.
 */

const rid = (prefix: string, n: number) => `${prefix}-${randomBytes(n).toString('hex').slice(0, n * 2)}`

export class MarketingStore {
  constructor(readonly rootDir: string) {
    mkdirSync(rootDir, { recursive: true })
  }

  private get file() {
    return join(this.rootDir, 'businesses.json')
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  list(): BusinessProfile[] {
    return this.readJson<BusinessProfile[]>(this.file, [])
      .map((p) => ({ ...p, services: p.services ?? [], cards: p.cards ?? [], notes: p.notes ?? [] }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): BusinessProfile | null {
    if (!isBusinessId(id)) return null
    return this.list().find((p) => p.id === id) ?? null
  }

  /** the same domain is one business: saving it again refreshes the profile */
  save(profile: BusinessProfile): BusinessProfile {
    const all = this.list()
    const existing = all.find((p) => p.id === profile.id) ?? all.find((p) => p.domain === profile.domain)
    const next: BusinessProfile = { ...profile, id: existing?.id ?? profile.id, createdAt: existing?.createdAt ?? profile.createdAt, updatedAt: new Date().toISOString() }
    mkdirSync(this.dirOf(next.id), { recursive: true })
    writeFileSync(this.file, JSON.stringify([...all.filter((p) => p.id !== next.id), next], null, 2))
    return next
  }

  /** forget the business: its profile, its site read and every film made for it */
  remove(id: string): void {
    if (!isBusinessId(id)) throw new Error('Invalid business')
    writeFileSync(this.file, JSON.stringify(this.list().filter((p) => p.id !== id), null, 2))
    for (const r of this.runs(id)) rmSync(this.runDir(r.id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    rmSync(this.dirOf(id), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }

  dirOf(id: string): string {
    if (!isBusinessId(id)) throw new Error('Invalid business')
    const base = resolve(this.rootDir)
    const d = resolve(base, id)
    if (!d.startsWith(base + sep)) throw new Error('Invalid business')
    return d
  }

  card(businessId: string, cardId: string): { profile: BusinessProfile; index: number } | null {
    const profile = this.get(businessId)
    if (!profile || !isCardId(cardId)) return null
    const index = profile.cards.findIndex((c) => c.id === cardId)
    return index < 0 ? null : { profile, index }
  }

  runDir(runId: string): string {
    if (!isMarketRunId(runId)) throw new Error('Invalid run')
    const base = resolve(this.rootDir, 'runs')
    const d = resolve(base, runId)
    if (!d.startsWith(base + sep)) throw new Error('Invalid run')
    return d
  }

  newRun(businessId: string, cardId: string): MarketRunRecord {
    const rec: MarketRunRecord = { id: rid('mrun', 8), businessId, cardId, startedAt: new Date().toISOString(), status: 'running', notes: [] }
    mkdirSync(this.runDir(rec.id), { recursive: true })
    this.saveRun(rec)
    return rec
  }

  saveRun(rec: MarketRunRecord): void {
    writeFileSync(join(this.runDir(rec.id), 'run.json'), JSON.stringify(rec, null, 2))
  }

  runs(businessId?: string): MarketRunRecord[] {
    const base = join(this.rootDir, 'runs')
    if (!existsSync(base)) return []
    const out: MarketRunRecord[] = []
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const rec = this.readJson<MarketRunRecord | null>(join(base, e.name, 'run.json'), null)
      if (rec && (!businessId || rec.businessId === businessId)) out.push(rec)
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** a run that was still marked running when the app closed did not finish */
  markInterrupted(): void {
    for (const r of this.runs().filter((x) => x.status === 'running')) {
      this.saveRun({ ...r, status: 'failed', error: 'The app was closed during this run.', finishedAt: new Date().toISOString() })
    }
  }
}
