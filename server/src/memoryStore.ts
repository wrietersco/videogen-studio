import {
  emptyUsage,
  StoreError,
  type AdminRecord,
  type AuditEntry,
  type DeviceRecord,
  type GrantRecord,
  type LicenseRecord,
  type Store,
  type UserRecord
} from './store'
import type { RequestRecord, RequestStatus } from '../../src/shared/requests'
import type { MonthUsage } from '../../src/shared/plans'
import { sha256 } from './upstream'

/** In-memory store for tests and local development. Single-threaded JS makes every method atomic. */
export class MemoryStore implements Store {
  policy: unknown | null = null
  admins = new Map<string, AdminRecord>()
  users = new Map<string, UserRecord>()
  devices = new Map<string, Map<string, DeviceRecord>>()
  licenses = new Map<string, LicenseRecord>()
  usage = new Map<string, MonthUsage>()
  grants = new Map<string, GrantRecord>()
  auditLog: AuditEntry[] = []
  requests = new Map<string, RequestRecord>()

  private copy<T>(v: T): T {
    return v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
  }

  async getPolicy() {
    return this.copy(this.policy)
  }
  async savePolicy(policy: unknown) {
    this.policy = this.copy(policy)
  }
  async getAdmin(uid: string) {
    return this.copy(this.admins.get(uid) ?? null)
  }
  adminEmails = new Map<string, AdminRecord>()
  async getAdminByEmail(email: string) {
    return this.copy(this.adminEmails.get(email.toLowerCase()) ?? null)
  }

  async getUser(uid: string) {
    return this.copy(this.users.get(uid) ?? null)
  }
  async upsertUser(uid: string, patch: Partial<UserRecord>, create: Partial<UserRecord>) {
    const existing = this.users.get(uid)
    const next = { ...(existing ?? { uid, ...create }), ...patch, uid } as UserRecord
    this.users.set(uid, next)
    return this.copy(next)
  }
  async listUsers(opts: { limit: number; licenseId?: string }) {
    return this.copy(
      [...this.users.values()]
        .filter((u) => !opts.licenseId || u.licenseId === opts.licenseId)
        .sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
        .slice(0, opts.limit)
    )
  }
  async findUserByEmail(email: string) {
    return this.copy([...this.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase()) ?? null)
  }

  async listDevices(uid: string) {
    return this.copy([...(this.devices.get(uid)?.values() ?? [])])
  }
  async touchDevice(uid: string, d: Omit<DeviceRecord, 'firstSeenAt' | 'lastSeenAt'>, limit: number, now: string) {
    const map = this.devices.get(uid) ?? new Map<string, DeviceRecord>()
    const existing = map.get(d.id)
    if (!existing && map.size >= limit) throw new StoreError(403, 'device_limit', `This account is already used on ${map.size} computer${map.size === 1 ? '' : 's'}. Remove one to sign in here.`)
    const next = { ...d, firstSeenAt: existing?.firstSeenAt ?? now, lastSeenAt: now }
    map.set(d.id, next)
    this.devices.set(uid, map)
    return this.copy(next)
  }
  async removeDevice(uid: string, deviceId: string) {
    this.devices.get(uid)?.delete(deviceId)
  }

  async getLicense(id: string) {
    return this.copy(this.licenses.get(id) ?? null)
  }
  async findLicenseByKeyHash(keyHash: string) {
    return this.copy([...this.licenses.values()].find((l) => l.keyHash === keyHash) ?? null)
  }
  async listLicenses() {
    return this.copy([...this.licenses.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  }
  async createLicense(record: LicenseRecord) {
    if (this.licenses.has(record.id)) throw new StoreError(409, 'exists', 'Licence already exists.')
    this.licenses.set(record.id, this.copy(record))
  }
  async updateLicense(id: string, patch: Partial<LicenseRecord>) {
    const existing = this.licenses.get(id)
    if (!existing) throw new StoreError(404, 'license_not_found', 'No such licence.')
    const next = { ...existing, ...patch, id }
    this.licenses.set(id, next)
    return this.copy(next)
  }
  async joinLicense(uid: string, licenseId: string) {
    const license = this.licenses.get(licenseId)
    const user = this.users.get(uid)
    if (!license || !user) throw new StoreError(404, 'license_not_found', 'No such licence.')
    if (user.licenseId === licenseId) return
    const members = [...this.users.values()].filter((u) => u.licenseId === licenseId).length
    if (members >= Math.max(1, license.seats)) throw new StoreError(403, 'seats_full', 'Every seat on this licence is taken. Ask its owner to free one.')
    user.licenseId = licenseId
  }
  async leaveLicense(uid: string) {
    const user = this.users.get(uid)
    if (user) user.licenseId = null
  }

  private usageId = (subject: string, month: string) => `${subject}_${month}`
  private grantId = (subject: string, projectKey: string) => sha256(`${subject}|${projectKey}`)

  async getUsage(subject: string, month: string) {
    return this.copy(this.usage.get(this.usageId(subject, month)) ?? emptyUsage(month))
  }
  async getGrant(subject: string, projectKey: string) {
    return this.copy(this.grants.get(this.grantId(subject, projectKey)) ?? null)
  }
  async startVideo(subject: string, projectKey: string, month: string, decide: (u: MonthUsage, g: GrantRecord | null) => { grant: GrantRecord; counts: boolean }) {
    const usage = await this.getUsage(subject, month)
    const grant = await this.getGrant(subject, projectKey)
    const out = decide(usage, grant)
    if (out.counts && !usage.videoKeys.includes(projectKey)) usage.videoKeys.push(projectKey)
    this.usage.set(this.usageId(subject, month), this.copy(usage))
    this.grants.set(this.grantId(subject, projectKey), this.copy(out.grant))
    return { grant: this.copy(out.grant), usage, counted: out.counts }
  }
  async charge(subject: string, month: string, c: { projectKey: string | null; day: string; usd: number; isClip: boolean; model: string; refs: string[] }) {
    const usage = await this.getUsage(subject, month)
    usage.costUsd += c.usd
    if (!c.projectKey) usage.utilityByDay[c.day] = (usage.utilityByDay[c.day] ?? 0) + c.usd
    this.usage.set(this.usageId(subject, month), usage)
    if (c.projectKey) {
      const g = this.grants.get(this.grantId(subject, c.projectKey))
      if (g) {
        g.costUsd += c.usd
        if (c.isClip) g.clips += 1
        g.refs = [...new Set([...g.refs, ...c.refs])].slice(-200)
      }
    }
  }

  async createRequest(r: RequestRecord) {
    if (this.requests.has(r.id)) throw new StoreError(409, 'exists', 'Request already exists.')
    this.requests.set(r.id, this.copy(r))
  }
  async getRequest(id: string) {
    return this.copy(this.requests.get(id) ?? null)
  }
  async listRequests(opts: { status?: RequestStatus; uid?: string; limit: number }) {
    return this.copy(
      [...this.requests.values()]
        .filter((r) => (!opts.status || r.status === opts.status) && (!opts.uid || r.uid === opts.uid))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, opts.limit)
    )
  }
  async updateRequest(id: string, patch: Partial<RequestRecord>) {
    const existing = this.requests.get(id)
    if (!existing) throw new StoreError(404, 'request_not_found', 'No such request.')
    const next = { ...existing, ...patch, id }
    this.requests.set(id, next)
    return this.copy(next)
  }

  async audit(entry: AuditEntry) {
    this.auditLog.push(this.copy(entry))
  }
  async listAudit(limit: number) {
    return this.copy(this.auditLog.slice(-limit).reverse())
  }
}
