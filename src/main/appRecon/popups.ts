import type { Page } from 'puppeteer-core'
import { enforcePolicy } from './browser'
import type { PolicyGate } from './policy'

/**
 * Sign-in pop-ups. "Continue with Google" (and any other single sign-on) opens the
 * provider in a second window, which answers the app's page by message and closes
 * itself. That window follows the same rules as the page that opened it (it is
 * policed and hidden like it), is never closed from here, and the recording waits for it to
 * finish before it goes on, so the next step happens on the app's own page again.
 */
export interface PopupWatch {
  /** pop-ups open right now */
  open(): Page[]
  /** resolves once every pop-up has closed (or after `maxMs`, when one is left open on purpose) */
  settled(maxMs?: number): Promise<void>
  /** every address a pop-up has been on, in order */
  seen(): string[]
}

const watches = new WeakMap<Page, PopupWatch>()

/** the pop-up watch of a page, when one was set up (the click that opened a pop-up waits on it) */
export function popupWatchOf(page: Page): PopupWatch | undefined {
  return watches.get(page)
}

export function followPopups(page: Page, gate: PolicyGate, onOpen?: (popup: Page) => Promise<void>, log?: (msg: string) => void): PopupWatch {
  const open = new Set<Page>()
  const urls: string[] = []
  const pending = new Set<Promise<void>>()
  const watch = (popup: Page): void => {
    open.add(popup)
    const ready = (async () => {
      try {
        await enforcePolicy(popup, gate)
        await onOpen?.(popup)
        if (popup.url() && popup.url() !== 'about:blank') urls.push(popup.url())
        popup.on('framenavigated', (f) => {
          if (f === popup.mainFrame() && f.url() && f.url() !== 'about:blank') urls.push(f.url())
        })
        // pop-ups opened by the pop-up (a provider's own windows) are followed the same way
        popup.on('popup', (p) => { if (p) watch(p) })
        log?.(`A sign-in window opened (${popup.url().slice(0, 80) || 'loading'}); waiting for it to finish.`)
      } catch {
        /* a window that closed while it was being set up needs nothing */
      }
    })()
    pending.add(ready)
    void ready.finally(() => pending.delete(ready))
    popup.once('close', () => open.delete(popup))
  }
  page.on('popup', (p) => { if (p) watch(p) })
  const watcher: PopupWatch = {
    open: () => [...open],
    seen: () => [...urls],
    async settled(maxMs = 20000) {
      // the window may open a moment after the click that asked for it
      await new Promise((r) => setTimeout(r, 150))
      await Promise.all([...pending])
      const until = Date.now() + maxMs
      while (open.size && Date.now() < until) await new Promise((r) => setTimeout(r, 150))
    }
  }
  watches.set(page, watcher)
  return watcher
}
