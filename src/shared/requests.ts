import type { PlanId } from './plans'

/**
 * Requests people send to the superadmins: a plan upgrade (one click in the
 * app) or a short message. Shared by the licence server, the app and tests.
 */

export type RequestKind = 'upgrade' | 'message'
export type RequestStatus = 'open' | 'approved' | 'rejected' | 'handled' | 'cancelled'

export const UPGRADE_PLANS: readonly PlanId[] = ['plus', 'pro', 'ultra']
export const REQUEST_LIMITS = { seatsMax: 1000, subject: 120, body: 4000, reason: 300 } as const

export interface RequestRecord {
  id: string
  kind: RequestKind
  uid: string
  email: string
  name: string
  status: RequestStatus
  /** upgrade */
  plan?: PlanId
  seats?: number
  /** message */
  subject?: string
  body?: string
  createdAt: string
  updatedAt: string
  /** superadmin who decided, and the reason shown to the requester on a rejection */
  decidedBy?: string
  decidedAt?: string
  reason?: string
  /** the licence an approval created or changed */
  licenseId?: string
  /** the requester has seen the outcome */
  dismissed?: boolean
}

/** what the requester's own app sees (no uid, no admin names) */
export interface MyRequest {
  id: string
  kind: RequestKind
  status: RequestStatus
  plan?: PlanId
  seats?: number
  subject?: string
  reason?: string
  createdAt: string
  decidedAt?: string
}

export const requestLabel = (r: Pick<RequestRecord, 'kind' | 'plan' | 'seats' | 'subject'>): string =>
  r.kind === 'upgrade' ? `${r.plan ? r.plan[0].toUpperCase() + r.plan.slice(1) : 'Plan'} upgrade, ${r.seats ?? 1} seat${(r.seats ?? 1) === 1 ? '' : 's'}` : `Message: ${r.subject || '(no subject)'}`

/** the account's one open upgrade request, if any */
export const openUpgrade = (list: MyRequest[]): MyRequest | undefined => list.find((r) => r.kind === 'upgrade' && r.status === 'open')

/** decided upgrades the person has not dismissed yet (approved or rejected) */
export const upgradeOutcome = (list: MyRequest[]): MyRequest | undefined => list.find((r) => r.kind === 'upgrade' && (r.status === 'approved' || r.status === 'rejected'))

/** seat stepper: whole numbers from 1 up to the server's cap */
export const clampSeats = (n: number): number => (Number.isFinite(n) ? Math.min(REQUEST_LIMITS.seatsMax, Math.max(1, Math.floor(n))) : 1)
