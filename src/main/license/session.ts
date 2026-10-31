import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { hostname, release } from 'node:os'
import type { EntitlementView } from '@shared/plans'
import type { ManagedProvider, Route } from './route'

/**
 * The account this computer is signed in to, and what its plan allows.
 *
 * Sign-in is Firebase email + password (the same Firebase project as the
 * licence server). The app keeps only the refresh token, encrypted with the
 * OS keychain; ID tokens live in memory and are renewed before they expire.
 * Nothing here decides what the account may do — the server does, on every
 * call — so the cached plan is for showing, never for enforcing.
 */

export const LICENSE_SERVER = (process.env.VIDEOGEN_LICENSE_SERVER ?? 'https://videogen-license-server-539536929675.us-central1.run.app').replace(/\/+$/, '')
/** Firebase web API key for brain-3bc3a — public by design (it names the project, it grants nothing) */
const FIREBASE_API_KEY = process.env.VIDEOGEN_FIREBASE_API_KEY ?? 'AIzaSyB-529nCnW_1XmiZroX6OweIfFIijw9aL0'
/** local development against `npm run dev` in server/: tokens are minted here instead of by Firebase */
const DEV_AUTH = process.env.VIDEOGEN_DEV_AUTH === '1' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(LICENSE_SERVER)

export interface AccountStatus {
  signedIn: boolean
  email: string
  emailVerified: boolean
  /** the server's answer at the last sync (plan, numbers, this month's use) */
  view: AccountView | null
  /** the last sync failed (offline / server down); `view` is the cached one */
  offline: boolean
  server: string
}

export interface AccountView {
  account: { uid: string; email: string; emailVerified: boolean; status: string; displayName: string }
  license: { id: string; keyHint: string; plan: string; seats: number; customerName: string; status: string; paidThrough: string | null } | null
  entitlements: EntitlementView
  devices?: Array<{ id: string; name: string; platform: string; appVersion: string; lastSeenAt: string }>
}

export class AccountError extends Error {
  constructor(readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

interface Saved {
  email: string
  uid: string
  refreshToken: string
  deviceId: string
  view: AccountView | null
}

export interface SessionDeps {
  dir: string
  appVersion: string
  encrypt: (plain: string) => string
  decrypt: (stored: string) => string
  /** told whenever the plan or sign-in changes, so settings and providers can follow */
  onChange: (status: AccountStatus) => void
}

const FIREBASE_ERRORS: Record<string, string> = {
  EMAIL_EXISTS: 'An account with this email already exists. Sign in instead.',
  EMAIL_NOT_FOUND: 'Email or password is wrong.',
  INVALID_PASSWORD: 'Email or password is wrong.',
  INVALID_LOGIN_CREDENTIALS: 'Email or password is wrong.',
  USER_DISABLED: 'This account has been disabled.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a few minutes and try again.',
  INVALID_EMAIL: 'That email address does not look right.',
  MISSING_PASSWORD: 'Enter a password.',
  WEAK_PASSWORD: 'Use a password of at least 8 characters.'
}

export class AccountSession {
  private saved: Saved
  private idToken = ''
  private idTokenExpires = 0
  private emailVerified = false
  private offline = false
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly file: string

  constructor(private readonly d: SessionDeps) {
    this.file = join(d.dir, 'account.json')
    this.saved = this.load()
  }

  // ---------------- persistence ----------------

  private load(): Saved {
    const fresh: Saved = { email: '', uid: '', refreshToken: '', deviceId: `pc-${randomBytes(12).toString('hex')}`, view: null }
    if (!existsSync(this.file)) return fresh
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>
      return {
        ...fresh,
        ...raw,
        deviceId: typeof raw.deviceId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(raw.deviceId) ? raw.deviceId : fresh.deviceId,
        refreshToken: raw.refreshToken ? this.d.decrypt(raw.refreshToken) : ''
      }
    } catch {
      return fresh
    }
  }

  private persist(): void {
    mkdirSync(this.d.dir, { recursive: true })
    writeFileSync(this.file, JSON.stringify({ ...this.saved, refreshToken: this.saved.refreshToken ? this.d.encrypt(this.saved.refreshToken) : '' }, null, 2))
  }

  // ---------------- status ----------------

  status(): AccountStatus {
    return {
      signedIn: Boolean(this.saved.refreshToken),
      email: this.saved.email,
      emailVerified: this.emailVerified || Boolean(this.saved.view?.account.emailVerified),
      view: this.saved.view,
      offline: this.offline,
      server: LICENSE_SERVER
    }
  }

  get signedIn(): boolean {
    return Boolean(this.saved.refreshToken)
  }

  get deviceId(): string {
    return this.saved.deviceId
  }

  /** the relay route while signed in; null when signed out (then no plan AI runs) */
  managedRoute(provider: ManagedProvider): Route | null {
    if (!this.signedIn) return null
    return { base: `${LICENSE_SERVER}/v1/ai/${provider}`, headers: { Authorization: `Bearer ${this.idToken}`, 'X-VG-Device': this.saved.deviceId } }
  }

  private changed(): void {
    this.d.onChange(this.status())
  }

  // ---------------- firebase auth ----------------

  private async firebase<T>(url: string, body: Record<string, unknown> | URLSearchParams): Promise<T> {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
      })
    } catch {
      throw new AccountError('offline', 'Could not reach the sign-in service. Check your internet connection.')
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T
    if (!res.ok) {
      const code = String(json.error?.message ?? '').split(/[ :]/)[0]
      throw new AccountError(code || 'auth_failed', FIREBASE_ERRORS[code] ?? 'Sign-in failed. Try again.')
    }
    return json
  }

  private takeTokens(t: { idToken: string; refreshToken: string; expiresIn: string | number; localId?: string; email?: string }): void {
    this.idToken = t.idToken
    this.idTokenExpires = Date.now() + Number(t.expiresIn) * 1000
    this.saved.refreshToken = t.refreshToken
    if (t.localId) this.saved.uid = t.localId
    if (t.email) this.saved.email = t.email.toLowerCase()
    this.emailVerified = tokenClaims(t.idToken).email_verified === true
  }

  private devToken(email: string): void {
    const uid = `dev${createHash('sha256').update(email).digest('hex').slice(0, 16)}`
    this.takeTokens({ idToken: `dev:${uid}:${email}:verified`, refreshToken: `dev-refresh:${email}`, expiresIn: 3600 * 24, localId: uid, email })
    this.emailVerified = true
  }

  async signUp(email: string, password: string): Promise<AccountStatus> {
    email = email.trim().toLowerCase()
    if (password.length < 8) throw new AccountError('WEAK_PASSWORD', FIREBASE_ERRORS.WEAK_PASSWORD)
    if (DEV_AUTH) this.devToken(email)
    else {
      this.takeTokens(await this.firebase(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, { email, password, returnSecureToken: true }))
      await this.sendVerification().catch(() => undefined)
    }
    return this.afterSignIn()
  }

  async signIn(email: string, password: string): Promise<AccountStatus> {
    email = email.trim().toLowerCase()
    if (DEV_AUTH) this.devToken(email)
    else this.takeTokens(await this.firebase(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, { email, password, returnSecureToken: true }))
    return this.afterSignIn()
  }

  async sendVerification(): Promise<void> {
    if (DEV_AUTH) return
    await this.freshToken()
    await this.firebase(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`, { requestType: 'VERIFY_EMAIL', idToken: this.idToken })
  }

  async resetPassword(email: string): Promise<void> {
    if (DEV_AUTH) return
    await this.firebase(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE_API_KEY}`, { requestType: 'PASSWORD_RESET', email: email.trim().toLowerCase() })
  }

  private async afterSignIn(): Promise<AccountStatus> {
    this.persist()
    this.scheduleRefresh()
    // a computer over the device limit stays signed in but unregistered: the error carries the
    // account's computers so the person can free one and sync again
    await this.sync()
    return this.status()
  }

  /** renew the ID token when it is within 5 minutes of expiring (or `force`, e.g. after verifying email) */
  async freshToken(force = false): Promise<string> {
    if (!this.saved.refreshToken) throw new AccountError('sign_in_required', 'Please sign in.')
    if (!force && this.idToken && Date.now() < this.idTokenExpires - 5 * 60_000) return this.idToken
    if (DEV_AUTH) {
      this.devToken(this.saved.email)
      return this.idToken
    }
    const json = await this.firebase<{ id_token: string; refresh_token: string; expires_in: string; user_id: string }>(
      `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.saved.refreshToken })
    ).catch((e: AccountError) => {
      if (e.code !== 'offline') this.forget()
      throw e
    })
    this.takeTokens({ idToken: json.id_token, refreshToken: json.refresh_token, expiresIn: json.expires_in, localId: json.user_id })
    this.persist()
    return this.idToken
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    // renders can run for an hour; keep the relay's token valid in the background
    this.refreshTimer = setInterval(() => void this.freshToken().catch(() => undefined), 10 * 60_000)
    this.refreshTimer.unref?.()
  }

  private forget(): void {
    this.saved = { email: '', uid: '', refreshToken: '', deviceId: this.saved.deviceId, view: null }
    this.idToken = ''
    this.idTokenExpires = 0
    this.emailVerified = false
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.persist()
    this.changed()
  }

  async signOut(): Promise<AccountStatus> {
    // free this computer's slot so the account can be used elsewhere
    await this.api('/v1/account/devices/remove', { deviceId: this.saved.deviceId }).catch(() => undefined)
    this.forget()
    return this.status()
  }

  // ---------------- licence server ----------------

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const token = await this.freshToken()
    let res: Response
    try {
      res = await fetch(`${LICENSE_SERVER}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'X-VG-Device': this.saved.deviceId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000)
      })
    } catch {
      this.offline = true
      throw new AccountError('offline', 'Could not reach VideoGen. Check your internet connection.')
    }
    this.offline = false
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } } & T
    if (!res.ok) {
      const { code = 'server_error', message = `VideoGen answered ${res.status}.`, ...extra } = json.error ?? {}
      if (code === 'account_blocked') this.forget()
      throw new AccountError(code, message, extra)
    }
    return json
  }

  private keepView(view: AccountView): AccountStatus {
    this.saved.view = { ...view, devices: view.devices ?? this.saved.view?.devices }
    this.emailVerified = view.account.emailVerified
    this.persist()
    this.changed()
    return this.status()
  }

  /** register this computer and fetch the plan; at app start, sign-in, and on demand */
  async sync(forceToken = false): Promise<AccountStatus> {
    if (!this.signedIn) return this.status()
    await this.freshToken(forceToken)
    try {
      return this.keepView(
        await this.api<AccountView>('/v1/account/sync', { device: { id: this.saved.deviceId, name: hostname().slice(0, 80), platform: `${process.platform} ${release()}`.slice(0, 40), appVersion: this.d.appVersion } })
      )
    } catch (e) {
      if (e instanceof AccountError && e.code === 'offline') {
        this.changed()
        return this.status()
      }
      throw e
    }
  }

  async activate(licenseKey: string): Promise<AccountStatus> {
    return this.keepView(await this.api<AccountView>('/v1/account/activate', { licenseKey: licenseKey.trim() }))
  }

  async leaveLicense(): Promise<AccountStatus> {
    return this.keepView(await this.api<AccountView>('/v1/account/leave', {}))
  }

  async removeDevice(deviceId: string): Promise<AccountStatus> {
    const r = await this.api<{ devices: AccountView['devices'] }>('/v1/account/devices/remove', { deviceId })
    if (this.saved.view) this.saved.view.devices = r.devices
    this.persist()
    this.changed()
    return this.status()
  }

  /** count (or reopen) one AI video before any paid call of it is made */
  async startVideo(projectKey: string, title: string, durationSec?: number): Promise<{ counted: boolean; clipsAllowed: number; models: EntitlementView['models'] }> {
    const r = await this.api<{ counted: boolean; clipsAllowed: number; models: EntitlementView['models']; entitlements: EntitlementView }>('/v1/videos/start', { projectKey, title, durationSec })
    if (this.saved.view) {
      this.saved.view.entitlements = r.entitlements
      this.persist()
      this.changed()
    }
    return r
  }
}

function tokenClaims(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** a key the app tags one AI video's calls with; stable for the project's life */
export function newProjectKey(): string {
  return `vg-${randomBytes(10).toString('hex')}`
}

