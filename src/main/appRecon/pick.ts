/// <reference lib="dom" />
// page.evaluate() callbacks run inside the browser, so they use DOM types
import type { Page } from 'puppeteer-core'
import { deepEval } from './deep'

/**
 * Choosing one entry from a dropdown the way a person says it: "select Surah An-Nur"
 * in the "Text to Study" dropdown. The page's entries read "24 · An-Nur (64 v · Medinan)",
 * so the name is matched against what is in the list, not against exact text.
 */

const compact = (s: string): string => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')
const LEADING_GENERIC = /^(?:the\s+)?(?:surah|sura|chapter|option|item|value|entry)\s+/i

/** the name an entry goes by: without its number in front and the details in brackets behind */
const headOf = (entry: string): string => entry.replace(/^\W*\d+\W*/, '').split('(')[0]

/** the short name of an entry for a caption: "24 · An-Nur (64 v · Medinan)" → "An-Nur" */
export const shortName = (entry: string): string => headOf(entry).replace(/\s+/g, ' ').trim() || entry.trim()

/** the entry the name means, or -1. A number alone ("24") means the entry that starts with it. */
export function matchOption(entries: string[], wanted: string): number {
  const want = compact(wanted.replace(LEADING_GENERIC, ''))
  if (!want) return -1
  let best = -1
  let bestScore = 0
  entries.forEach((entry, i) => {
    const all = compact(entry)
    const head = compact(headOf(entry))
    let score = 0
    if (/^\d+$/.test(want)) score = new RegExp(`^\\W*${want}(?!\\d)`).test(entry) ? 90 : 0
    else if (head === want || all === want) score = 100
    else if (head.startsWith(want)) score = 80
    else if (all.includes(want)) score = 60
    else {
      const tokens = wanted.replace(LEADING_GENERIC, '').normalize('NFKD').toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
      if (tokens.length > 1 && tokens.every((t) => all.includes(t))) score = 40
    }
    // of equally good entries the shorter one is the one named
    if (score && (score > bestScore || (score === bestScore && entry.length < (entries[best]?.length ?? Infinity)))) {
      best = i
      bestScore = score
    }
  })
  return best
}

export interface Choices {
  /** a real <select>: its entries can be read and one set directly */
  native: boolean
  entries: string[]
}

/** the entries of the dropdown at `selector`, when it is a real <select> */
export async function readChoices(page: Page, selector: string): Promise<Choices> {
  const r = await deepEval(page, selector, (el) => (el.tagName === 'SELECT' ? { native: true, entries: Array.from((el as HTMLSelectElement).options).map((o) => (o.text || o.label || '').replace(/\s+/g, ' ').trim()) } : { native: false, entries: [] as string[] }))
  return r ?? { native: false, entries: [] }
}

/** sets entry `index` of a real <select> and tells the page, as a person choosing it would */
export async function chooseNative(page: Page, selector: string, index: number): Promise<void> {
  await deepEval(
    page,
    selector,
    (el, i) => {
      const s = el as HTMLSelectElement
      s.selectedIndex = i
      s.dispatchEvent(new Event('input', { bubbles: true }))
      s.dispatchEvent(new Event('change', { bubbles: true }))
    },
    index
  )
}
