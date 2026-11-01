import type { Firestore, Transaction } from 'firebase-admin/firestore'
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
import type { MonthUsage } from '../../src/shared/plans'
import { sha256 } from './upstream'

/**
 * Firestore store (production). Collections are prefixed vg_ so VideoGen can
 * share the brain-3bc3a project with Snap Projects without touching its data.
 * Only this server (Admin SDK) reads or writes them; the console and the app
 * go through the API, so firestore.rules need no VideoGen entries at all —
 * the default deny already covers every client.
 *
 *   vg_config/policy
 *   vg_admins/{uid}
 *   vg_admin_emails/{email}  superadmins by (verified) email
 *   vg_users/{uid}            + devices/{deviceId}
 *   vg_licenses/{id}          keyHash, never the key
 *   vg_usage/{subject}_{YYYY-MM}
 *   vg_grants/{sha256(subject|projectKey)}
 *   vg_audit/{auto}
 */
export class FirestoreStore implements Store {
  constructor(private readonly db: Firestore) {}

  private col = (name: string) => this.db.collection(`vg_${name}`)
  private usageRef = (subject: string, month: string) => this.col('usage').doc(`${subject}_${month}`)
  private grantRef = (subject: string, projectKey: string) => this.col('grants').doc(sha256(`${subject}|${projectKey}`))

  async getPolicy() {
    return (await this.col('config').doc('policy').get()).data()?.policy ?? null
  }
  async savePolicy(policy: unknown) {
    await this.col('config').doc('policy').set({ policy, updatedAt: new Date().toISOString() })
  }

  async getAdmin(uid: string) {
    const d = await this.col('admins').doc(uid).get()
    return d.exists ? ({ uid, ...(d.data() as Omit<AdminRecord, 'uid'>) } as AdminRecord) : null
  }

  async getAdminByEmail(email: string) {
    const d = await this.col('admin_emails').doc(email.toLowerCase()).get()
    return d.exists ? ({ uid: '', email: email.toLowerCase(), ...(d.data() as Omit<AdminRecord, 'uid' | 'email'>) } as AdminRecord) : null
  }

  async getUser(uid: string) {
    const d = await this.col('users').doc(uid).get()
    return d.exists ? ({ ...(d.data() as UserRecord), uid } as UserRecord) : null
  }
  async upsertUser(uid: string, patch: Partial<UserRecord>, create: Partial<UserRecord>) {
    const ref = this.col('users').doc(uid)
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      const next = { ...(snap.exists ? (snap.data() as UserRecord) : { ...create }), ...patch, uid } as UserRecord
      tx.set(ref, next)
      return next
    })
  }
  async listUsers(opts: { limit: number; licenseId?: string }) {
    let q = this.col('users') as FirebaseFirestore.Query
    if (opts.licenseId) q = q.where('licenseId', '==', opts.licenseId)
    const snap = await q.limit(opts.limit).get()
    return snap.docs.map((d) => ({ ...(d.data() as UserRecord), uid: d.id })).sort((a, b) => (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? ''))
  }
  async findUserByEmail(email: string) {
    const snap = await this.col('users').where('email', '==', email.toLowerCase()).limit(1).get()
    return snap.empty ? null : ({ ...(snap.docs[0].data() as UserRecord), uid: snap.docs[0].id } as UserRecord)
  }

  private devices = (uid: string) => this.col('users').doc(uid).collection('devices')
  async listDevices(uid: string) {
    return (await this.devices(uid).get()).docs.map((d) => ({ ...(d.data() as DeviceRecord), id: d.id }))
  }
  async touchDevice(uid: string, d: Omit<DeviceRecord, 'firstSeenAt' | 'lastSeenAt'>, limit: number, now: string) {
    const ref = this.devices(uid).doc(d.id)
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.get(ref)
      if (!existing.exists) {
        const all = await tx.get(this.devices(uid))
        if (all.size >= limit) throw new StoreError(403, 'device_limit', `This account is already used on ${all.size} computer${all.size === 1 ? '' : 's'}. Remove one to sign in here.`)
      }
      const next: DeviceRecord = { ...d, firstSeenAt: (existing.data() as DeviceRecord | undefined)?.firstSeenAt ?? now, lastSeenAt: now }
      tx.set(ref, next)
      return next
    })
  }
  async removeDevice(uid: string, deviceId: string) {
    await this.devices(uid).doc(deviceId).delete()
  }

  async getLicense(id: string) {
    const d = await this.col('licenses').doc(id).get()
    return d.exists ? ({ ...(d.data() as LicenseRecord), id } as LicenseRecord) : null
  }
  async findLicenseByKeyHash(keyHash: string) {
    const snap = await this.col('licenses').where('keyHash', '==', keyHash).limit(1).get()
    return snap.empty ? null : ({ ...(snap.docs[0].data() as LicenseRecord), id: snap.docs[0].id } as LicenseRecord)
  }
  async listLicenses() {
    return (await this.col('licenses').get()).docs.map((d) => ({ ...(d.data() as LicenseRecord), id: d.id })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async createLicense(record: LicenseRecord) {
    await this.col('licenses').doc(record.id).create(record)
  }
  async updateLicense(id: string, patch: Partial<LicenseRecord>) {
    const ref = this.col('licenses').doc(id)
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) throw new StoreError(404, 'license_not_found', 'No such licence.')
      const next = { ...(snap.data() as LicenseRecord), ...patch, id }
      tx.set(ref, next)
      return next
    })
  }
  async joinLicense(uid: string, licenseId: string) {
    const licRef = this.col('licenses').doc(licenseId)
    const userRef = this.col('users').doc(uid)
    await this.db.runTransaction(async (tx) => {
      const [lic, user] = await Promise.all([tx.get(licRef), tx.get(userRef)])
      if (!lic.exists || !user.exists) throw new StoreError(404, 'license_not_found', 'No such licence.')
      if ((user.data() as UserRecord).licenseId === licenseId) return
      const members = await tx.get(this.col('users').where('licenseId', '==', licenseId))
      const seats = Math.max(1, (lic.data() as LicenseRecord).seats)
      if (members.size >= seats) throw new StoreError(403, 'seats_full', 'Every seat on this licence is taken. Ask its owner to free one.')
      tx.update(userRef, { licenseId })
      // a write on the licence serialises two people racing for the last seat
      tx.update(licRef, { membershipRevision: ((lic.data() as { membershipRevision?: number }).membershipRevision ?? 0) + 1 })
    })
  }
  async leaveLicense(uid: string) {
    await this.col('users').doc(uid).update({ licenseId: null })
  }

  private readUsage(data: FirebaseFirestore.DocumentData | undefined, month: string): MonthUsage {
    return data ? { ...emptyUsage(month), ...(data as MonthUsage), month } : emptyUsage(month)
  }
  async getUsage(subject: string, month: string) {
    return this.readUsage((await this.usageRef(subject, month).get()).data(), month)
  }
  async getGrant(subject: string, projectKey: string) {
    const d = await this.grantRef(subject, projectKey).get()
    return d.exists ? (d.data() as GrantRecord) : null
  }
  async startVideo(subject: string, projectKey: string, month: string, decide: (u: MonthUsage, g: GrantRecord | null) => { grant: GrantRecord; counts: boolean }) {
    const uRef = this.usageRef(subject, month)
    const gRef = this.grantRef(subject, projectKey)
    return this.db.runTransaction(async (tx: Transaction) => {
      const [u, g] = await Promise.all([tx.get(uRef), tx.get(gRef)])
      const usage = this.readUsage(u.data(), month)
      const out = decide(usage, g.exists ? (g.data() as GrantRecord) : null)
      if (out.counts && !usage.videoKeys.includes(projectKey)) usage.videoKeys = [...usage.videoKeys, projectKey]
      tx.set(uRef, usage)
      tx.set(gRef, out.grant)
      return { grant: out.grant, usage, counted: out.counts }
    })
  }
  async charge(subject: string, month: string, c: { projectKey: string | null; day: string; usd: number; isClip: boolean; model: string; refs: string[] }) {
    const uRef = this.usageRef(subject, month)
    const gRef = c.projectKey ? this.grantRef(subject, c.projectKey) : null
    await this.db.runTransaction(async (tx) => {
      const u = await tx.get(uRef)
      const g = gRef ? await tx.get(gRef) : null
      const usage = this.readUsage(u.data(), month)
      usage.costUsd += c.usd
      if (!c.projectKey) usage.utilityByDay = { ...usage.utilityByDay, [c.day]: (usage.utilityByDay[c.day] ?? 0) + c.usd }
      tx.set(uRef, usage)
      if (gRef && g?.exists) {
        const grant = g.data() as GrantRecord
        tx.update(gRef, {
          costUsd: grant.costUsd + c.usd,
          clips: grant.clips + (c.isClip ? 1 : 0),
          refs: [...new Set([...(grant.refs ?? []), ...c.refs])].slice(-200)
        })
      }
    })
  }

  async audit(entry: AuditEntry) {
    await this.col('audit').add(entry)
  }
  async listAudit(limit: number) {
    return (await this.col('audit').orderBy('at', 'desc').limit(limit).get()).docs.map((d) => d.data() as AuditEntry)
  }
}
