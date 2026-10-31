import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Where a provider call goes. With the user's own keys (only where their
 * licence allows it) calls go straight to the provider; on a plan they go to
 * the licence server, which runs them with its own keys after checking the
 * plan. Each adapter asks route() for its base URL and auth headers, so the
 * switch lives in one place.
 */

export type ManagedProvider = 'openai' | 'gemini' | 'elevenlabs'

export interface Route {
  base: string
  headers: Record<string, string>
}

/** the AI video a call belongs to; calls outside one fall under the small helper budget */
const job = new AsyncLocalStorage<{ projectKey: string }>()

export function withProject<T>(projectKey: string, fn: () => Promise<T>): Promise<T> {
  return job.run({ projectKey }, fn)
}

export function currentProjectKey(): string | null {
  return job.getStore()?.projectKey ?? null
}

let managed: ((provider: ManagedProvider) => Route | null) | null = null

/** set by the licence session: returns the server route while the account runs on its plan */
export function setManagedRouter(fn: ((provider: ManagedProvider) => Route | null) | null): void {
  managed = fn
}

export function route(provider: ManagedProvider, direct: Route): Route {
  const r = managed?.(provider)
  if (!r) return direct
  const projectKey = currentProjectKey()
  return { base: r.base, headers: { ...r.headers, ...(projectKey ? { 'X-VG-Project': projectKey } : {}) } }
}
