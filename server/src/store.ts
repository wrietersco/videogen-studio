import type { Account, Grant, License, MonthUsage, PlanId } from '../../src/shared/plans'

/**
 * Everything the server keeps. Two implementations: Firestore in production
 * (firestoreStore.ts) and an in-memory one for tests and local development.
 * The operations that must not race — counting a video, charging a call,
 * taking a seat — are single methods here so each store can make them atomic.
 */

export interface UserRecord extends Account {
  displayName?: string
  createdAt: string
  lastSeenAt?: string
}

export interface DeviceRecord {
  id: string
  name: string
  platform: string
  appVersion: string
  firstSeenAt: string
  lastSeenAt: string
}

export interface LicenseRecord extends License {
  /** sha256 of the key; the key itself is shown once and never stored */
  keyHash: string
  /** first and last characters, so people can tell keys apart */
  keyHint: string
  customerName: string
  contactEmail: string
  notes: string
  revenueUsdMonthly: number
  createdAt: string
  createdBy: string
  updatedAt?: string
}

export interface GrantRecord extends Grant {
  subject: string
  uid: string
  title: string
  /** interaction / file ids this video's calls produced; only these may be read back */
  refs: string[]
}

export interface AuditEntry {
  at: string
  actor: string
  action: string
  target: string | null
  details: Record<string, unknown>
}

export interface AdminRecord {
  uid: string
  email: string
  role: 'superadmin'
}

export class StoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export interface StartVideoOutcome {
  grant: GrantRecord
  usage: MonthUsage
  counted: boolean
}

export interface Store {
  getPolicy(): Promise<unknown | null>
  savePolicy(policy: unknown): Promise<void>

  getAdmin(uid: string): Promise<AdminRecord | null>

  getUser(uid: string): Promise<UserRecord | null>
  /** create-or-merge; `create` fields are written only when the user is new */
  upsertUser(uid: string, patch: Partial<UserRecord>, create: Partial<UserRecord>): Promise<UserRecord>
  listUsers(opts: { limit: number; licenseId?: string }): Promise<UserRecord[]>
  findUserByEmail(email: string): Promise<UserRecord | null>

  listDevices(uid: string): Promise<DeviceRecord[]>
  /** registers or refreshes a device, refusing a new one past `limit` */
  touchDevice(uid: string, device: Omit<DeviceRecord, 'firstSeenAt' | 'lastSeenAt'>, limit: number, now: string): Promise<DeviceRecord>
  removeDevice(uid: string, deviceId: string): Promise<void>

  getLicense(id: string): Promise<LicenseRecord | null>
  findLicenseByKeyHash(keyHash: string): Promise<LicenseRecord | null>
  listLicenses(): Promise<LicenseRecord[]>
  createLicense(record: LicenseRecord): Promise<void>
  updateLicense(id: string, patch: Partial<LicenseRecord>): Promise<LicenseRecord>
  /** link a user to a licence if a seat is free (atomic with the seat count) */
  joinLicense(uid: string, licenseId: string): Promise<void>
  leaveLicense(uid: string): Promise<void>

  getUsage(subject: string, month: string): Promise<MonthUsage>
  getGrant(subject: string, projectKey: string): Promise<GrantRecord | null>
  /**
   * Atomically: read usage + grant, let `decide` rule, then write the grant and
   * (when it counts) add the project to this month's videos.
   */
  startVideo(
    subject: string,
    projectKey: string,
    month: string,
    decide: (usage: MonthUsage, grant: GrantRecord | null) => { grant: GrantRecord; counts: boolean }
  ): Promise<StartVideoOutcome>
  /** add one call's cost to the month (and the video's grant, or today's helper budget) */
  charge(subject: string, month: string, c: { projectKey: string | null; day: string; usd: number; isClip: boolean; model: string; refs: string[] }): Promise<void>

  audit(entry: AuditEntry): Promise<void>
  listAudit(limit: number): Promise<AuditEntry[]>
}

export const subjectOf = (uid: string, licenseId: string | null | undefined): string => (licenseId ? `lic_${licenseId}` : `usr_${uid}`)

export const emptyUsage = (month: string): MonthUsage => ({ month, videoKeys: [], costUsd: 0, utilityByDay: {} })

export type { PlanId }
