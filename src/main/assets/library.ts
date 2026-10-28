import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tokenize, type AssetKind, type AssetMeta } from '@shared/assets'

/**
 * Asset library — every reusable media file the app knows about, each with a
 * JSON sidecar (AssetMeta). Two roots:
 *   builtin (read-only, shipped in resources/asset-pack)
 *   user    (generated, uploaded and downloaded assets, under Documents)
 * Layout: <root>/<kind>/<id><ext> + <root>/<kind>/<id>.json
 */

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac'
}

export const KIND_EXTS: Record<AssetKind, string[]> = {
  image: ['.jpg', '.jpeg', '.png', '.webp', '.gif'],
  video: ['.mp4', '.webm', '.mov'],
  voice: ['.mp3', '.m4a', '.wav', '.ogg', '.flac'],
  music: ['.mp3', '.m4a', '.wav', '.ogg', '.flac'],
  sfx: ['.mp3', '.m4a', '.wav', '.ogg', '.flac']
}

export function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function kindForFile(file: string): AssetKind | null {
  const ext = extname(file).toLowerCase()
  if (KIND_EXTS.image.includes(ext)) return 'image'
  if (KIND_EXTS.video.includes(ext)) return 'video'
  if (KIND_EXTS.music.includes(ext)) return 'music'
  return null
}

export interface SearchOptions {
  kind?: AssetKind
  /** required orientation for visual assets */
  orientation?: 'portrait' | 'landscape' | 'square'
  minDurationSec?: number
  sources?: AssetMeta['source'][]
  tags?: string[]
  limit?: number
}

export interface SearchHit {
  asset: AssetMeta
  /** 0…1 — share of the query's words the asset covers */
  score: number
}

export function orientationOf(w?: number, h?: number): 'portrait' | 'landscape' | 'square' | undefined {
  if (!w || !h) return undefined
  const r = w / h
  return r > 1.15 ? 'landscape' : r < 0.87 ? 'portrait' : 'square'
}

type NewAsset = Omit<AssetMeta, 'id' | 'file' | 'mime' | 'bytes' | 'sha256' | 'createdAt' | 'usedIn' | 'sharing'> &
  Partial<Pick<AssetMeta, 'sharing' | 'createdAt'>>

export class AssetLibrary {
  private readonly index = new Map<string, AssetMeta>()
  private readonly dirOf = new Map<string, string>()
  private loaded = false

  constructor(
    readonly userRoot: string,
    readonly builtinRoot: string | null,
    /** default sharing for new assets (Settings → privacy) */
    private readonly defaultSharing: () => AssetMeta['sharing'] = () => 'local'
  ) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    for (const root of [this.builtinRoot, this.userRoot]) {
      if (!root || !existsSync(root)) continue
      for (const kind of readdirSync(root, { withFileTypes: true })) {
        if (!kind.isDirectory()) continue
        const dir = join(root, kind.name)
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.json')) continue
          try {
            const meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) as AssetMeta
            if (!meta.id || !existsSync(join(dir, meta.file))) continue
            if (root === this.builtinRoot) meta.source = 'builtin'
            this.index.set(meta.id, meta)
            this.dirOf.set(meta.id, dir)
          } catch {
            /* unreadable sidecar — skip */
          }
        }
      }
    }
  }

  /** drop the in-memory index (tests, imports) */
  reload(): void {
    this.index.clear()
    this.dirOf.clear()
    this.loaded = false
  }

  all(): AssetMeta[] {
    this.load()
    return [...this.index.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(id: string): AssetMeta | null {
    this.load()
    return this.index.get(id) ?? null
  }

  path(id: string): string | null {
    this.load()
    const m = this.index.get(id)
    const d = this.dirOf.get(id)
    return m && d ? join(d, m.file) : null
  }

  findByKey(kind: AssetKind, key: string): AssetMeta | null {
    this.load()
    for (const a of this.index.values()) if (a.kind === kind && a.key === key) return a
    return null
  }

  findBySha(sha: string): AssetMeta | null {
    this.load()
    for (const a of this.index.values()) if (a.sha256 === sha) return a
    return null
  }

  /** add a file (buffer or path). Identical bytes return the existing asset. */
  add(data: Buffer | string, ext: string, meta: NewAsset): AssetMeta {
    this.load()
    const buf = typeof data === 'string' ? readFileSync(data) : data
    const sha256 = createHash('sha256').update(buf).digest('hex')
    const dup = this.findBySha(sha256)
    if (dup) return dup
    const id = `${meta.kind}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const dir = join(this.userRoot, meta.kind)
    mkdirSync(dir, { recursive: true })
    const e = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`
    const file = `${id}${e}`
    writeFileSync(join(dir, file), buf)
    const full: AssetMeta = {
      ...meta,
      id,
      file,
      mime: mimeFor(file),
      bytes: buf.length,
      sha256,
      tags: [...new Set(meta.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))],
      sharing: meta.sharing ?? (meta.source === 'generated' ? this.defaultSharing() : 'local'),
      createdAt: meta.createdAt ?? new Date().toISOString(),
      usedIn: []
    }
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(full, null, 2))
    this.index.set(id, full)
    this.dirOf.set(id, dir)
    return full
  }

  update(id: string, patch: Partial<Pick<AssetMeta, 'title' | 'tags' | 'sharing' | 'favorite' | 'license'>>): AssetMeta | null {
    const a = this.get(id)
    const dir = this.dirOf.get(id)
    if (!a || !dir || a.source === 'builtin') return a
    Object.assign(a, patch)
    if (patch.tags) a.tags = [...new Set(patch.tags.map((t) => t.toLowerCase().trim()).filter(Boolean))]
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(a, null, 2))
    return a
  }

  remove(id: string): boolean {
    const a = this.get(id)
    const dir = this.dirOf.get(id)
    if (!a || !dir || a.source === 'builtin') return false
    rmSync(join(dir, a.file), { force: true })
    rmSync(join(dir, `${id}.json`), { force: true })
    this.index.delete(id)
    this.dirOf.delete(id)
    return true
  }

  markUsed(id: string, projectId: string): void {
    const a = this.get(id)
    const dir = this.dirOf.get(id)
    if (!a || !dir || a.usedIn.includes(projectId)) return
    a.usedIn.push(projectId)
    if (a.source !== 'builtin') writeFileSync(join(dir, `${id}.json`), JSON.stringify(a, null, 2))
  }

  /** copy an asset's file to dest (creating folders) and return dest */
  copyTo(id: string, dest: string): string {
    const src = this.path(id)
    if (!src) throw new Error(`asset ${id} missing`)
    mkdirSync(join(dest, '..'), { recursive: true })
    copyFileSync(src, dest)
    return dest
  }

  /**
   * Keyword search over title, tags and prompt. Score = weighted share of
   * the query's words the asset covers (tags/title count fully, prompt 0.8).
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    this.load()
    const q = [...new Set(tokenize(query))]
    const wantTags = (opts.tags ?? []).map((t) => t.toLowerCase())
    const hits: SearchHit[] = []
    for (const a of this.index.values()) {
      if (opts.kind && a.kind !== opts.kind) continue
      if (opts.sources && !opts.sources.includes(a.source)) continue
      if (opts.orientation) {
        const o = orientationOf(a.width, a.height)
        if (o && o !== opts.orientation) continue
      }
      if (opts.minDurationSec && (a.durationSec ?? 0) < opts.minDurationSec) continue
      if (wantTags.length && !wantTags.every((t) => a.tags.includes(t))) continue
      let score = 1
      if (q.length) {
        const strong = new Set([...tokenize(a.title), ...a.tags.flatMap(tokenize)])
        const weak = new Set(tokenize(a.prompt ?? ''))
        let got = 0
        for (const w of q) got += strong.has(w) ? 1 : weak.has(w) ? 0.8 : 0
        score = got / q.length
      }
      if (score > 0) hits.push({ asset: a, score: score + (a.favorite ? 0.02 : 0) })
    }
    hits.sort((x, y) => y.score - x.score || y.asset.usedIn.length - x.asset.usedIn.length)
    return hits.slice(0, opts.limit ?? 60)
  }

  stats(): Record<AssetMeta['source'], number> & { total: number; bytes: number } {
    const s = { builtin: 0, generated: 0, uploaded: 0, stock: 0, total: 0, bytes: 0 }
    for (const a of this.all()) {
      s[a.source] += 1
      s.total += 1
      s.bytes += a.bytes
    }
    return s
  }
}
