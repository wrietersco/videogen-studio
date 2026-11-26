import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'

/**
 * "Sign in once": a normal Chrome or Edge window on the app's own recording profile,
 * with nothing attached to it (no automation flag, no debugging port, no banner).
 * Google, Microsoft and other single sign-on pages refuse a browser that is being
 * remote-controlled, so the person signs in here, by hand, once; the recording then
 * opens the same profile and finds the session (cookies, IndexedDB and local storage,
 * which is where Firebase keeps its sign-in) already there.
 */

/** the switches of the plain window: a profile of its own, no first-run pages, nothing else */
export function signInWindowArgs(profileDir: string, url: string): string[] {
  return [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--new-window', url]
}

export interface SignInWindow {
  child: ChildProcess
  /** resolves when the person closes the window */
  closed: Promise<void>
}

export function openSignInWindow(executablePath: string, profileDir: string, url: string): SignInWindow {
  mkdirSync(profileDir, { recursive: true })
  const child = spawn(executablePath, signInWindowArgs(profileDir, url), { stdio: 'ignore', windowsHide: false })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
  return { child, closed }
}
