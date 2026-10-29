import { dialog, ipcMain, net, protocol, shell, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { tokenize, type AssetKind, type AssetMeta } from '@shared/assets'
import { kindForFile, KIND_EXTS, type AssetLibrary } from './library'
import { probe, videoPoster } from './probe'
import { downloadStock, searchStock, type StockResult } from '../media/stock'
import type { MediaRouter } from '../media/router'
import { meter } from '../usage/meter'
import type { KeyId } from '../settings'

/**
 * Asset library IPC + the vgasset:// protocol the renderer uses to show
 * thumbnails and play previews without touching the filesystem itself:
 *   vgasset://file/<id>   the asset's bytes
 *   vgasset://thumb/<id>  a cached 360px JPEG (images, video posters)
 */

export const ASSET_SCHEME = 'vgasset'

/** must run before app 'ready' */
export function registerAssetScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

type Orientation = 'portrait' | 'landscape' | 'square'

export function registerAssetIpc(deps: { library: AssetLibrary; router: MediaRouter; key: (id: KeyId) => string; isBusy: () => boolean }): void {
  const { library, router } = deps
  const thumbDir = join(library.userRoot, '.thumbs')

  protocol.handle(ASSET_SCHEME, async (req) => {
    const u = new URL(req.url)
    const id = decodeURIComponent(u.pathname.replace(/^\//, ''))
    const a = library.get(id)
    const path = library.path(id)
    if (!a || !path) return new Response('not found', { status: 404 })
    if (u.host === 'thumb') {
      const cached = join(thumbDir, `${id}.jpg`)
      if (!existsSync(cached)) {
        const buf =
          a.kind === 'image'
            ? await sharp(path).resize({ width: 360, height: 360, fit: 'inside' }).jpeg({ quality: 78 }).toBuffer()
            : a.kind === 'video'
              ? videoPoster(path)
              : null
        if (!buf) return new Response('no thumb', { status: 404 })
        mkdirSync(thumbDir, { recursive: true })
        writeFileSync(cached, buf)
      }
      return net.fetch(pathToFileURL(cached).toString())
    }
    return net.fetch(pathToFileURL(path).toString(), { headers: req.headers })
  })

  ipcMain.handle('assets:list', (_e, q: { kind?: AssetKind; source?: AssetMeta['source']; query?: string } = {}) => {
    if (q.query?.trim()) {
      return library.search(q.query, { kind: q.kind, sources: q.source ? [q.source] : undefined, limit: 400 }).map((h) => h.asset)
    }
    return library.all().filter((a) => (!q.kind || a.kind === q.kind) && (!q.source || a.source === q.source))
  })
  ipcMain.handle('assets:stats', () => library.stats())
  ipcMain.handle('assets:update', (_e, id: string, patch: Partial<Pick<AssetMeta, 'title' | 'tags' | 'sharing' | 'favorite'>>) =>
    library.update(id, { title: patch.title, tags: patch.tags, sharing: patch.sharing, favorite: patch.favorite })
  )
  ipcMain.handle('assets:remove', (_e, id: string) => library.remove(id))
  ipcMain.handle('assets:reveal', (_e, id: string) => {
    const p = library.path(id)
    if (p) shell.showItemInFolder(p)
    return Boolean(p)
  })

  /** add the user's own files — a picker when no paths are given (drag & drop passes paths) */
  ipcMain.handle('assets:upload', async (e, paths?: string[], tags: string[] = []) => {
    let files = paths ?? []
    if (!files.length) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const exts = [...new Set(Object.values(KIND_EXTS).flat())].map((x) => x.slice(1))
      const pick = await dialog.showOpenDialog(win!, {
        title: 'Add your own images, clips or music',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Media', extensions: exts }]
      })
      if (pick.canceled) return { added: [], skipped: [] }
      files = pick.filePaths
    }
    const added: AssetMeta[] = []
    const skipped: string[] = []
    for (const f of files) {
      const kind = kindForFile(f)
      if (!kind || !existsSync(f)) {
        skipped.push(basename(f))
        continue
      }
      try {
        const info = kind === 'image' ? await sharp(f).metadata() : probe(f)
        const name = basename(f, extname(f)).replace(/[_-]+/g, ' ')
        added.push(
          library.add(f, extname(f), {
            kind,
            source: 'uploaded',
            title: name.slice(0, 80),
            tags: [...tokenize(name), ...tags],
            width: info.width,
            height: info.height,
            durationSec: 'durationSec' in info ? info.durationSec : undefined,
            license: { name: 'Yours', requiresAttribution: false },
            sharing: 'local'
          })
        )
      } catch {
        skipped.push(basename(f))
      }
    }
    return { added, skipped }
  })

  ipcMain.handle('stock:search', async (_e, kind: AssetKind, query: string, orientation?: Orientation) => {
    if (!query?.trim()) return { results: [], errors: [] }
    return searchStock(kind, query.trim(), { orientation, pexelsKey: deps.key('pexels'), pixabayKey: deps.key('pixabay') })
  })
  ipcMain.handle('stock:download', async (_e, r: StockResult, tags: string[] = []) => {
    // only results shaped by our own connectors, over https
    if (!['openverse', 'wikimedia', 'pexels', 'pixabay'].includes(r?.provider) || !/^https:\/\//.test(r?.downloadUrl ?? '')) throw new Error('not a stock result')
    return downloadStock(library, r, tags)
  })

  /** make a single asset on demand from the library screen (metered like any job) */
  ipcMain.handle('assets:generate', async (_e, req: { kind: 'image' | 'video' | 'voice' | 'music'; prompt: string; orientation?: Orientation; shots?: string[] }) => {
    if (deps.isBusy()) throw new Error('A video is generating — try again when it finishes')
    const shots = (req.shots ?? []).map((s) => s.trim()).filter(Boolean)
    if (req.kind === 'video' && shots.length > 1) {
      if (shots.length > 8) throw new Error('A sequence can have up to 8 shots')
      meter.begin('library')
      try {
        return await router.sequenceToLibrary(shots, req.orientation, (n, total) => meter.setStage(`library video · shot ${n} of ${total}`))
      } finally {
        meter.end(null)
      }
    }
    const prompt = req.prompt?.trim()
    if (!prompt) throw new Error('Describe what to make first')
    meter.begin('library')
    meter.setStage(`library ${req.kind}`)
    try {
      if (req.kind === 'image') {
        const [w, h] = req.orientation === 'landscape' ? [1536, 1024] : req.orientation === 'square' ? [1024, 1024] : [1024, 1536]
        const r = await router.paint({ brief: prompt, fullPrompt: prompt, subjectLabel: prompt.slice(0, 60), width: w, height: h, projectId: 'library' }, { fresh: true })
        return library.get(r.assetId)
      }
      if (req.kind === 'video') return await router.clipToLibrary(prompt, req.orientation, { fresh: true })
      if (req.kind === 'voice') return await router.speakToLibrary(prompt)
      return await router.composeToLibrary(prompt, 30)
    } finally {
      meter.end(null)
    }
  })

  // ---------------- share packs: move assets between PCs, no cloud needed ----------------
  ipcMain.handle('assets:exportPack', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const pick = await dialog.showOpenDialog(win!, { title: 'Choose a folder for the share pack', properties: ['openDirectory', 'createDirectory'] })
    if (pick.canceled) return { exported: 0 }
    const out = join(pick.filePaths[0], `videogen-pack-${new Date().toISOString().slice(0, 10)}`)
    let exported = 0
    for (const a of library.all()) {
      if (a.sharing !== 'shareable' || a.source === 'builtin') continue
      const src = library.path(a.id)
      if (!src) continue
      const dir = join(out, a.kind)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, a.file), readFileSync(src))
      writeFileSync(join(dir, `${a.id}.json`), JSON.stringify({ ...a, usedIn: [] }, null, 2))
      exported += 1
    }
    if (exported) void shell.openPath(out)
    return { exported, folder: out }
  })
  ipcMain.handle('assets:importPack', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const pick = await dialog.showOpenDialog(win!, { title: 'Choose a VideoGen share pack folder', properties: ['openDirectory'] })
    if (pick.canceled) return { imported: 0 }
    return { imported: importPack(library, pick.filePaths[0]) }
  })
}

/** copy every asset + sidecar from a pack folder into the library (dedupes by content hash) */
export function importPack(library: AssetLibrary, folder: string): number {
  let n = 0
  for (const kind of ['image', 'video', 'voice', 'music', 'sfx'] as AssetKind[]) {
    const dir = join(folder, kind)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) as AssetMeta
        const file = join(dir, basename(meta.file))
        if (!existsSync(file) || meta.kind !== kind) continue
        const before = library.all().length
        library.add(file, extname(file), {
          kind,
          source: meta.source === 'builtin' ? 'stock' : meta.source,
          title: String(meta.title ?? '').slice(0, 120),
          tags: Array.isArray(meta.tags) ? meta.tags.map(String).slice(0, 32) : [],
          width: meta.width,
          height: meta.height,
          durationSec: meta.durationSec,
          prompt: meta.prompt,
          provider: meta.provider,
          model: meta.model,
          costUsd: meta.costUsd,
          key: meta.key,
          extra: meta.extra,
          license: meta.license ?? { name: 'Unknown — check before publishing' },
          sharing: 'local'
        })
        if (library.all().length > before) n += 1
      } catch {
        /* skip bad entries */
      }
    }
  }
  return n
}
