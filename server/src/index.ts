import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { devVerifier, firebaseVerifier, type TokenVerifier } from './auth'
import { smtpMailer, type Mailer } from './mailer'
import { MemoryStore } from './memoryStore'
import type { Store } from './store'
import type { ProviderName } from './upstream'

/**
 * Boot. Production (Cloud Run): Firestore + Firebase token checks + provider
 * keys from Secret Manager. Local development: `VG_STORE=memory VG_DEV_AUTH=1`
 * gives an in-memory store and `dev:<uid>:<email>:verified` tokens — refused
 * unless both are set and the server is bound to loopback, so a misconfigured
 * deploy fails to start instead of opening the door.
 */

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8080)
const memory = process.env.VG_STORE === 'memory'
const devAuth = process.env.VG_DEV_AUTH === '1'
const host = process.env.VG_HOST ?? (memory ? '127.0.0.1' : '0.0.0.0')

if (devAuth && (!memory || !['127.0.0.1', '::1', 'localhost'].includes(host))) {
  console.error('VG_DEV_AUTH needs VG_STORE=memory and a loopback host. Refusing to start.')
  process.exit(1)
}

const PROJECT = process.env.FIRESTORE_PROJECT_ID ?? 'brain-3bc3a'
const SECRET_NAMES: Record<ProviderName, string> = {
  openai: process.env.OPENAI_API_KEY_SECRET ?? `projects/${PROJECT}/secrets/openai-live-key/versions/latest`,
  gemini: process.env.GEMINI_API_KEY_SECRET ?? `projects/${PROJECT}/secrets/gemini-live-key/versions/latest`,
  elevenlabs: process.env.ELEVENLABS_API_KEY_SECRET ?? `projects/${PROJECT}/secrets/elevenlabs-live-key/versions/latest`
}
const ENV_KEYS: Record<ProviderName, string | undefined> = {
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  elevenlabs: process.env.ELEVENLABS_API_KEY
}

/** provider keys, fetched once per instance; a missing secret switches that provider off rather than failing boot */
const keyCache = new Map<ProviderName, Promise<string | null>>()
function secret(provider: ProviderName): Promise<string | null> {
  if (!keyCache.has(provider)) {
    keyCache.set(
      provider,
      (async () => {
        if (ENV_KEYS[provider]) return ENV_KEYS[provider]!
        if (memory) return null
        try {
          const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
          const [v] = await new SecretManagerServiceClient().accessSecretVersion({ name: SECRET_NAMES[provider] })
          const key = v.payload?.data?.toString().trim()
          return key || null
        } catch (e) {
          console.warn(`[server] no ${provider} key (${SECRET_NAMES[provider]}): ${(e as Error).message}`)
          keyCache.delete(provider) // retry on a later call
          return null
        }
      })()
    )
  }
  return keyCache.get(provider)!
}

/**
 * Mail: SMTP over TLS to the owner's mailbox. The password lives only in a
 * Secret Manager secret and is read at send time; no secret (or local memory
 * mode) means mail is skipped and requests are still saved.
 */
let smtpPassword: Promise<string | null> | null = null
function mailPassword(): Promise<string | null> {
  if (memory) return Promise.resolve(null)
  smtpPassword ??= (async () => {
    try {
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
      const name = process.env.SMTP_PASSWORD_SECRET ?? `projects/${PROJECT}/secrets/snapkodex-smtp-password/versions/latest`
      const [v] = await new SecretManagerServiceClient().accessSecretVersion({ name })
      return v.payload?.data?.toString().trim() || null
    } catch (e) {
      console.warn('[server] no mail password, mail is off:', (e as Error).message)
      smtpPassword = null // look again on a later send
      return null
    }
  })()
  return smtpPassword
}
const SMTP_USER = process.env.SMTP_USER ?? 'hello@snapkodex.com'
const mailer: Mailer = smtpMailer({ host: process.env.SMTP_HOST ?? 'smtp.hostinger.com', port: Number(process.env.SMTP_PORT ?? 465), user: SMTP_USER, from: SMTP_USER, password: mailPassword })

async function main(): Promise<void> {
  let store: Store
  let verifier: TokenVerifier
  if (memory) {
    const m = new MemoryStore()
    // local console sign-in: dev:admin:admin@example.com:verified
    m.admins.set('admin', { uid: 'admin', email: 'admin@example.com', role: 'superadmin' })
    // the desktop app's dev sign-in as admin@example.com is a superadmin too
    m.adminEmails.set('admin@example.com', { uid: '', email: 'admin@example.com', role: 'superadmin' })
    store = m
    verifier = devVerifier
    console.warn('[server] in-memory store — data is lost on restart')
  } else {
    const { initializeApp, getApps } = await import('firebase-admin/app')
    const { getFirestore } = await import('firebase-admin/firestore')
    if (!getApps().length) initializeApp({ projectId: PROJECT })
    const { FirestoreStore } = await import('./firestoreStore')
    store = new FirestoreStore(getFirestore())
    verifier = await firebaseVerifier()
  }

  const handler = createApp({
    store,
    verifier,
    secret,
    mailer,
    notifyTo: process.env.NOTIFY_TO ?? SMTP_USER,
    consoleUrl: process.env.CONSOLE_URL,
    consoleDir: process.env.VG_CONSOLE_DIR ?? join(here, '..', 'console'),
    consoleConfig: {
      apiKey: process.env.FIREBASE_WEB_API_KEY ?? '',
      authDomain: `${PROJECT}.firebaseapp.com`,
      projectId: PROJECT,
      devAuth: devAuth ? '1' : ''
    }
  })
  createServer((req, res) => void handler(req, res)).listen(PORT, host, () => console.log(`[server] listening on ${host}:${PORT}`))
}

void main()
