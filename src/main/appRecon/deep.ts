/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { ElementHandle, Frame, JSHandle, Page } from 'puppeteer-core'
import type { Rect } from '@shared/appRecon'

/**
 * Addresses of controls that live anywhere on a page: in the page itself, inside an open shadow root, or inside an
 * iframe. An address is a chain of ordinary CSS paths joined by ` >>> `; each hop after the first starts inside the
 * previous element (its shadow root, or, for an <iframe>, its document). A plain CSS path is a one-hop address, so every
 * address the app saved before still works.
 */

export const DEEP = ' >>> '

/** in the page: the address of an element inside its own document or shadow root (a shadow host's address is put in front) */
export function deepPathInPage(el: Element): string {
  const one = (root: Document | ShadowRoot, sel: string) => {
    try { return root.querySelectorAll(sel).length === 1 } catch { return false }
  }
  const hops: string[] = []
  let cur: Element | null = el
  for (let guard = 0; cur && guard < 12; guard++) {
    const root = cur.getRootNode() as Document | ShadowRoot
    const parts: string[] = []
    for (let n: Element | null = cur; n && n.nodeType === 1; n = n.parentElement) {
      if (n === document.documentElement) break
      if (n.id && one(root, '#' + CSS.escape(n.id))) { parts.unshift('#' + CSS.escape(n.id)); break }
      const sibs = Array.from(n.parentElement?.children ?? [])
      parts.unshift(n.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-child(' + (sibs.indexOf(n) + 1) + ')' : ''))
    }
    hops.unshift(parts.join(' > '))
    cur = root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null
  }
  return hops.join(' >>> ')
}

/** the element an address points at (null when it is not there, or a hop cannot be entered) */
export async function deepHandle(page: Page, selector: string): Promise<ElementHandle<Element> | null> {
  const hops = selector.split(DEEP)
  let frame: Frame = page.mainFrame()
  let root: JSHandle | null = null
  let el: ElementHandle<Element> | null = null
  try {
    for (let i = 0; i < hops.length; i++) {
      if (i > 0 && el) {
        const tag = await el.evaluate((e) => e.tagName)
        if (tag === 'IFRAME' || tag === 'FRAME') {
          const f = await el.contentFrame()
          if (!f) return null
          frame = f
          root = null
        } else {
          const sr = await el.evaluateHandle((e) => (e as HTMLElement).shadowRoot)
          if (!(await (sr as JSHandle<ShadowRoot | null>).evaluate((r: ShadowRoot | null) => !!r))) return null
          root = sr
        }
      }
      const h: JSHandle = root
        ? await root.evaluateHandle((r, s) => (r as ShadowRoot).querySelector(s as string), hops[i])
        : await frame.evaluateHandle((s) => document.querySelector(s), hops[i])
      el = h.asElement() as ElementHandle<Element> | null
      if (!el) return null
    }
  } catch {
    return null
  }
  return el
}

/** where an address is on screen (CSS px in the page's view, iframes' offsets included); scrolled to the middle of the view first when asked */
export async function deepRect(page: Page, selector: string, o: { scroll?: boolean } = {}): Promise<Rect | null> {
  const h = await deepHandle(page, selector)
  if (!h) return null
  try {
    if (o.scroll) await h.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'nearest' }))
    const b = await h.boundingBox()
    return b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null
  } catch {
    return null
  } finally {
    await h.dispose().catch(() => undefined)
  }
}

/** runs a function on the element an address points at */
export async function deepEval<A extends unknown[], T>(page: Page, selector: string, fn: (el: Element, ...a: A) => T, ...args: A): Promise<T | null> {
  const h = await deepHandle(page, selector)
  if (!h) return null
  try {
    return (await h.evaluate(fn as never, ...(args as unknown as never[]))) as T
  } catch {
    return null
  } finally {
    await h.dispose().catch(() => undefined)
  }
}

/** the address of an element held by a handle (a frame's own address is added in front when it is in an iframe) */
export async function deepSelectorOf(page: Page, h: ElementHandle<Element>): Promise<string> {
  const own = await h.evaluate(deepPathInPage)
  const frame = h.frame
  if (!frame || frame === page.mainFrame()) return own
  const chain: string[] = []
  for (let f: Frame | null = frame; f && f !== page.mainFrame(); f = f.parentFrame()) {
    const fe = await f.frameElement().catch(() => null)
    if (!fe) break
    chain.unshift(await fe.evaluate(deepPathInPage))
    await fe.dispose().catch(() => undefined)
  }
  return [...chain, own].join(DEEP)
}

/** every frame of the page, the page's own first */
export function framesOf(page: Page): Frame[] {
  const main = page.mainFrame()
  return [main, ...page.frames().filter((f) => f !== main && !f.detached)]
}

/** where a frame's own top-left corner is in the page's view (0,0 for the page itself); puppeteer's box of the iframe element is already in the page's view */
export async function frameOffset(page: Page, frame: Frame): Promise<{ x: number; y: number }> {
  if (frame === page.mainFrame()) return { x: 0, y: 0 }
  const fe = await frame.frameElement().catch(() => null)
  if (!fe) return { x: 0, y: 0 }
  const b = await fe.boundingBox().catch(() => null)
  await fe.dispose().catch(() => undefined)
  return b ? { x: b.x, y: b.y } : { x: 0, y: 0 }
}

/** the addresses of the <iframe> elements that lead to a frame, outermost first (empty for the page itself) */
export async function framePrefix(page: Page, frame: Frame): Promise<string[]> {
  const chain: string[] = []
  for (let f: Frame | null = frame; f && f !== page.mainFrame(); f = f.parentFrame()) {
    const fe = await f.frameElement().catch(() => null)
    if (!fe) break
    chain.unshift(await fe.evaluate(deepPathInPage))
    await fe.dispose().catch(() => undefined)
  }
  return chain
}
