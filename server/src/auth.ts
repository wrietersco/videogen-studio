import { randomBytes } from 'node:crypto'
import { sha256 } from './upstream'

/**
 * Who is calling. Every route except /health and /v1/plans needs a Firebase
 * ID token; the token proves the account, never what it may do — that comes
 * from the server's own records (users, licences, admins), so nothing the
 * desktop app says about itself is load-bearing.
 */

export interface Caller {
  uid: string
  email: string
  emailVerified: boolean
}

export interface TokenVerifier {
  /** throws when the token is missing, forged, expired or (with checkRevoked) revoked */
  verify(token: string, opts?: { checkRevoked?: boolean }): Promise<Caller>
}

export class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

export function bearer(header: string | undefined): string {
  if (!header || !/^Bearer\s+\S+$/i.test(header)) throw new AuthError(401, 'sign_in_required', 'Please sign in.')
  return header.replace(/^Bearer\s+/i, '').trim()
}

/** Firebase Admin verification (production). Imported lazily so tests never load firebase-admin. */
export async function firebaseVerifier(): Promise<TokenVerifier> {
  const { getAuth } = await import('firebase-admin/auth')
  const auth = getAuth()
  return {
    async verify(token, opts) {
      try {
        const t = await auth.verifyIdToken(token, Boolean(opts?.checkRevoked))
        return { uid: t.uid, email: (t.email ?? '').toLowerCase(), emailVerified: Boolean(t.email_verified) }
      } catch {
        throw new AuthError(401, 'session_expired', 'Your session has expired. Please sign in again.')
      }
    }
  }
}

/**
 * Local development only: tokens look like `dev:<uid>:<email>[:verified]`.
 * index.ts refuses to start with this verifier unless the store is in-memory
 * and the server listens on loopback, so it can never guard real data.
 */
export const devVerifier: TokenVerifier = {
  async verify(token) {
    const m = /^dev:([A-Za-z0-9_-]{1,64}):([^:\s]+@[^:\s]+)(:verified)?$/.exec(token)
    if (!m) throw new AuthError(401, 'session_expired', 'Your session has expired. Please sign in again.')
    return { uid: m[1], email: m[2].toLowerCase(), emailVerified: Boolean(m[3]) }
  }
}

// ---------------- licence keys ----------------

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
export const LICENSE_KEY_RE = /^vg_live_[A-Za-z0-9]{32}$/

/** 32 characters from a 56-letter alphabet ≈ 186 bits; unbiased (rejection sampling) */
export function newLicenseKey(): string {
  let out = ''
  while (out.length < 32) {
    for (const b of randomBytes(64)) {
      if (b < 224 && out.length < 32) out += ALPHABET[b % 56]
    }
  }
  return `vg_live_${out}`
}

export const hashKey = (key: string): string => sha256(`vg-license:${key}`)
export const keyHint = (key: string): string => `${key.slice(0, 12)}…${key.slice(-4)}`
export const newId = (prefix: string): string => `${prefix}_${randomBytes(9).toString('base64url')}`
