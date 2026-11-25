import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Code } from './kit'

/**
 * The intro-background library: every background the AI designed and that
 * passed its own review is kept on disk with detailed notes, so a later film
 * on a similar topic can start from it. A stored background is only ever a
 * STARTING POINT the model adapts to the new film (new concept, words,
 * colours); it is never dropped in unchanged (see isUnchangedCopy).
 *
 *   <root>/index.json              small index of every entry's meta
 *   <root>/<id>/index.html         a self-contained page that plays the background in a browser
 *   <root>/<id>/source.json        the html / css / js the model wrote
 *   <root>/<id>/meta.json          topic, keywords, mood, palette, concept, model, score, aspect ratios, date
 *   <root>/<id>/preview.jpg        one frame (when there is one)
 */

export type Aspect = 'wide' | 'tall' | 'square'

export const aspectOf = (size: { width: number; height: number }): Aspect => (size.height > size.width * 1.1 ? 'tall' : size.width > size.height * 1.1 ? 'wide' : 'square')

export interface BackgroundMeta {
  id: string
  createdAt: string
  /** what the film that this was designed for was about */
  topic: string
  keywords: string[]
  mood: string
  /** hex colours, with '#' */
  palette: string[]
  /** the idea and the motion, in the model's words */
  concept: string
  model: string
  score: number
  aspects: Aspect[]
  size: { width: number; height: number }
  durationSec: number
  kind: 'title' | 'outro'
  usesThree: boolean
  /** the stored background this one was adapted from, if any */
  adaptedFrom?: string
  /** how many films have started from this one */
  adaptedCount?: number
}

export interface StoredBackground {
  meta: BackgroundMeta
  code: Code
}

const STOP = new Set(
  'a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your video film show shows make made makes new use using app apps via one two'.split(' ')
)

/** lower-case word stems of a text, stop-words and short words dropped (letters of any script) */
export function tokens(text: string): string[] {
  const out: string[] = []
  for (const w of (text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue
    const plural = w.replace(/([^s])s$/, '$1')
    out.push(plural.length > 6 ? plural.replace(/(?:ing|ed)$/, '') : plural)
  }
  return out
}

/** the most frequent distinct stems of a text */
export function keywordsOf(text: string, max = 14): string[] {
  const n = new Map<string, number>()
  for (const t of tokens(text)) n.set(t, (n.get(t) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, max).map(([w]) => w)
}

export interface LookupQuery {
  /** the film's topic text */
  text: string
  /** extra keywords (the model's own) */
  keywords?: string[]
  mood?: string
  aspect?: Aspect
}

export interface Match {
  meta: BackgroundMeta
  score: number
}

const normal = (c: Code): string => `${c.html}\n${c.css}\n${c.js}`.replace(/\s+/g, ' ').trim()

/** true when a draft is the stored background, unchanged or all but unchanged: a template drop-in, which is not allowed */
export function isUnchangedCopy(draft: Code, stored: Code): boolean {
  const a = normal(draft)
  const b = normal(stored)
  if (a === b) return true
  const lines = (c: Code): string[] => `${c.html}\n${c.css}\n${c.js}`.split(/[\n;{}]/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 6)
  const la = lines(draft)
  const lb = new Set(lines(stored))
  if (la.length < 8) return false
  const same = la.filter((l) => lb.has(l)).length
  return same / la.length >= 0.9
}

export class IntroBackgroundLibrary {
  constructor(readonly root: string) {}

  private indexFile(): string {
    return join(this.root, 'index.json')
  }

  /** every entry's meta, newest first; an unreadable index is rebuilt from the folders */
  list(): BackgroundMeta[] {
    try {
      const j = JSON.parse(readFileSync(this.indexFile(), 'utf8')) as { entries?: BackgroundMeta[] }
      if (Array.isArray(j.entries)) return j.entries.filter((e) => e && typeof e.id === 'string')
    } catch {
      // fall through to the rebuild
    }
    return this.rebuild()
  }

  private rebuild(): BackgroundMeta[] {
    const out: BackgroundMeta[] = []
    if (!existsSync(this.root)) return out
    for (const d of readdirSync(this.root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      try {
        out.push(JSON.parse(readFileSync(join(this.root, d.name, 'meta.json'), 'utf8')) as BackgroundMeta)
      } catch {
        // not an entry
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private writeIndex(entries: BackgroundMeta[]): void {
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.indexFile(), JSON.stringify({ version: 1, entries }, null, 2))
  }

  get(id: string): StoredBackground | null {
    if (!/^[\w-]{3,80}$/.test(id)) return null
    try {
      const dir = join(this.root, id)
      return { meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as BackgroundMeta, code: JSON.parse(readFileSync(join(dir, 'source.json'), 'utf8')) as Code }
    } catch {
      return null
    }
  }

  /**
   * keep a background. `page` is the playable page, `preview` a frame to copy.
   * The id is made from the topic words and the code, so the same code is not stored twice.
   */
  save(meta: Omit<BackgroundMeta, 'id' | 'createdAt'> & { id?: string; createdAt?: string }, code: Code, page: string, preview?: string): BackgroundMeta {
    const hash = createHash('sha1').update(normal(code)).digest('hex').slice(0, 8)
    const slug = (meta.keywords.slice(0, 3).join('-') || 'background').replace(/[^\p{L}\p{N}-]+/gu, '').slice(0, 40) || 'background'
    const id = meta.id ?? `${slug}-${hash}`
    const full: BackgroundMeta = { ...meta, id, createdAt: meta.createdAt ?? new Date().toISOString() }
    const dir = join(this.root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), page)
    writeFileSync(join(dir, 'source.json'), JSON.stringify(code, null, 2))
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(full, null, 2))
    if (preview && existsSync(preview)) copyFileSync(preview, join(dir, 'preview.jpg'))
    this.writeIndex([full, ...this.list().filter((e) => e.id !== id)])
    return full
  }

  /** note that a film started from this entry */
  markAdapted(id: string): void {
    const all = this.list()
    const e = all.find((x) => x.id === id)
    if (!e) return
    e.adaptedCount = (e.adaptedCount ?? 0) + 1
    this.writeIndex(all)
    try {
      writeFileSync(join(this.root, id, 'meta.json'), JSON.stringify(e, null, 2))
    } catch {
      // the index is what matters
    }
  }

  remove(id: string): void {
    if (!/^[\w-]{3,80}$/.test(id)) return
    rmSync(join(this.root, id), { recursive: true, force: true })
    this.writeIndex(this.list().filter((e) => e.id !== id))
  }

  /** the stored backgrounds closest to this topic, best first. Only close ones: a weak match is no match. */
  lookup(q: LookupQuery, opts: { limit?: number; minScore?: number; kind?: 'title' | 'outro' } = {}): Match[] {
    const want = new Set([...tokens(q.text), ...(q.keywords ?? []).flatMap((k) => tokens(k))])
    if (!want.size) return []
    const min = opts.minScore ?? 0.2
    const out: Match[] = []
    for (const meta of this.list()) {
      if (opts.kind && meta.kind !== opts.kind) continue
      const have = new Set([...meta.keywords.flatMap((k) => tokens(k)), ...tokens(meta.topic)])
      if (!have.size) continue
      let both = 0
      for (const w of want) if (have.has(w)) both++
      let score = both / Math.sqrt(want.size * have.size)
      if (score <= 0) continue
      if (q.mood && meta.mood && meta.mood.toLowerCase() === q.mood.toLowerCase()) score += 0.06
      if (q.aspect && meta.aspects.includes(q.aspect)) score += 0.04
      if (score >= min) out.push({ meta, score })
    }
    return out.sort((a, b) => b.score - a.score || b.meta.score - a.meta.score).slice(0, opts.limit ?? 2)
  }
}
