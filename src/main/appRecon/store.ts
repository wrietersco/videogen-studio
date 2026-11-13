import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { isAppId, isRunId, type AppInput, type RunRecord, type SavedApp } from '../../shared/appRecording'
import type { Plan } from './planner'

/**
 * Saved apps and their runs, on this computer.
 *
 *   <root>/apps.json            the apps (never a password)
 *   <root>/secrets.json         usernames and passwords, sealed with the operating system's key
 *   <root>/runs/<id>/run.json   one run: what was decided, found and made
 *
 * "Forget this app" removes all of it.
 */

export interface Sealer {
  enc: (plain: string) => string
  dec: (sealed: string) => string
}

const rid = (prefix: string, n: number) => `${prefix}-${randomBytes(n).toString('hex').slice(0, n * 2)}`

export class AppReconStore {
  constructor(
    readonly rootDir: string,
    private readonly seal: Sealer
  ) {
    mkdirSync(join(rootDir, 'runs'), { recursive: true })
  }

  private get appsFile() {
    return join(this.rootDir, 'apps.json')
  }
  private get secretsFile() {
    return join(this.rootDir, 'secrets.json')
  }

  private readJson<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch {
      return fallback
    }
  }

  list(): SavedApp[] {
    return this.readJson<SavedApp[]>(this.appsFile, [])
      .map((a) => ({ ...a, styleImages: a.styleImages ?? [], hasPlan: existsSync(this.planFile(a.id)) }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private planFile(id: string): string {
    if (!isAppId(id)) throw new Error('Invalid app id')
    return join(this.rootDir, 'plans', `${id}.json`)
  }

  /** the steps of the last finished video (already free of private data) */
  plan(id: string): Plan | null {
    return this.readJson<Plan | null>(this.planFile(id), null)
  }

  savePlan(id: string, plan: Plan): void {
    mkdirSync(join(this.rootDir, 'plans'), { recursive: true })
    writeFileSync(this.planFile(id), JSON.stringify(plan, null, 2))
  }

  get(id: string): SavedApp | null {
    return this.list().find((a) => a.id === id) ?? null
  }

  save(input: AppInput): SavedApp {
    const apps = this.readJson<SavedApp[]>(this.appsFile, [])
    const now = new Date().toISOString()
    // saving the same app again (same name and address) updates it instead of making a copy
    const existing = input.id ? apps.find((a) => a.id === input.id) : apps.find((a) => a.url === input.url && a.name === input.name)
    if (input.id && !existing) throw new Error('That app no longer exists')
    const secrets = this.readJson<Record<string, { u: string; p: string }>>(this.secretsFile, {})
    const id = existing?.id ?? rid('app', 6)
    const { password, ...rest } = input
    if (input.signIn === 'saved') {
      const cur = secrets[id]
      const user = input.username ?? (cur ? this.seal.dec(cur.u) : '')
      if (!user) throw new Error('Enter the username to sign in with')
      const pass = password !== undefined ? password : cur ? this.seal.dec(cur.p) : ''
      if (!pass) throw new Error('Enter the password to sign in with')
      secrets[id] = { u: this.seal.enc(user), p: this.seal.enc(pass) }
    }
    const app: SavedApp = {
      ...rest,
      id,
      username: input.signIn === 'saved' ? (input.username ?? (secrets[id] ? this.seal.dec(secrets[id].u) : undefined)) : undefined,
      hasPassword: !!secrets[id],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: existing?.lastRunAt
    }
    writeFileSync(this.appsFile, JSON.stringify([...apps.filter((a) => a.id !== id), app], null, 2))
    writeFileSync(this.secretsFile, JSON.stringify(secrets, null, 2))
    return { ...app, hasPlan: existsSync(this.planFile(id)) }
  }

  /** the stored login, decrypted: for the engine only, never sent to the screen */
  secrets(id: string): { username: string; password: string } | null {
    const s = this.readJson<Record<string, { u: string; p: string }>>(this.secretsFile, {})[id]
    if (!s) return null
    try {
      return { username: this.seal.dec(s.u), password: this.seal.dec(s.p) }
    } catch {
      return null
    }
  }

  /** forget the app: its settings, its login and every run */
  remove(id: string): void {
    if (!isAppId(id)) throw new Error('Invalid app id')
    writeFileSync(this.appsFile, JSON.stringify(this.readJson<SavedApp[]>(this.appsFile, []).filter((a) => a.id !== id), null, 2))
    const secrets = this.readJson<Record<string, unknown>>(this.secretsFile, {})
    delete secrets[id]
    writeFileSync(this.secretsFile, JSON.stringify(secrets, null, 2))
    rmSync(this.planFile(id), { force: true })
    for (const r of this.runs(id)) rmSync(this.runDir(r.id), { recursive: true, force: true })
  }

  runDir(runId: string): string {
    if (!isRunId(runId)) throw new Error('Invalid run id')
    const base = resolve(this.rootDir, 'runs')
    const d = resolve(base, runId)
    if (!d.startsWith(base + sep)) throw new Error('Invalid run id')
    return d
  }

  newRun(appId: string): RunRecord {
    if (!isAppId(appId)) throw new Error('Invalid app id')
    const rec: RunRecord = { id: rid('run', 8), appId, startedAt: new Date().toISOString(), status: 'running', notes: [] }
    mkdirSync(this.runDir(rec.id), { recursive: true })
    this.saveRun(rec)
    return rec
  }

  saveRun(rec: RunRecord): void {
    writeFileSync(join(this.runDir(rec.id), 'run.json'), JSON.stringify(rec, null, 2))
    if (rec.finishedAt) {
      const apps = this.readJson<SavedApp[]>(this.appsFile, [])
      const a = apps.find((x) => x.id === rec.appId)
      if (a) {
        a.lastRunAt = rec.finishedAt
        writeFileSync(this.appsFile, JSON.stringify(apps, null, 2))
      }
    }
  }

  runs(appId?: string): RunRecord[] {
    const base = join(this.rootDir, 'runs')
    if (!existsSync(base)) return []
    const out: RunRecord[] = []
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const rec = this.readJson<RunRecord | null>(join(base, e.name, 'run.json'), null)
      if (rec && (!appId || rec.appId === appId)) out.push(rec)
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
