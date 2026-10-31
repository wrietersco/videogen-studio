import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { EditPlan, type FootageEvent, type FootageProject, type PlanRequest } from '../../shared/footage'
import { meter } from '../usage/meter'
import { FootageCancelled, type FootageService } from './service'
import { dedupe, type FootageStore } from './store'

export interface FootageIpcDeps {
  store: FootageStore
  service: FootageService
  /** the app runs one heavy job at a time (shared with video generation) */
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  emit: (channel: string, payload: unknown) => void
  window: () => BrowserWindow | null
}

const AUDIO_FILTER = { name: 'Music', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }

/** Footage-project channels. Renderer input is validated here: ids, plans and paths never reach the engine raw. */
export function registerFootageIpc(d: FootageIpcDeps): void {
  /** which project's job is running, so a screen opened mid-job can show it */
  let current: { projectId: string; kind: 'scan' | 'understand' | 'render' } | null = null
  const fail = (err: unknown) => ({ ok: false as const, error: String((err as Error)?.message ?? err) })

  /** one job at a time, with a usage run so paid calls are metered and saved with the project */
  async function job<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    if (d.isBusy()) throw new Error('Another job is running. Wait for it to finish, then try again.')
    if (!d.store.exists(projectId)) throw new Error('That footage project no longer exists')
    d.setBusy(true)
    meter.begin('footage')
    try {
      return await fn()
    } finally {
      meter.end(d.store.dir(projectId))
      d.setBusy(false)
    }
  }

  /** run without making the caller wait: progress comes back as footage events */
  function background(projectId: string, kind: 'scan' | 'understand' | 'render', fn: () => Promise<void>) {
    if (d.isBusy()) return { ok: false as const, error: 'Another job is running. Wait for it to finish, then try again.' }
    current = { projectId, kind }
    void job(projectId, fn).catch((err) => {
      const error = String((err as Error)?.message ?? err)
      d.emit('footage:event', (kind === 'render' ? { kind, projectId, status: 'failed', error } : { kind, projectId, status: 'failed', error }) satisfies FootageEvent)
    }).finally(() => {
      current = null
    })
    return { ok: true as const }
  }

  const directories = (paths: unknown): string[] =>
    (Array.isArray(paths) ? paths : [])
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => resolve(p))
      .filter((p) => {
        try {
          return statSync(p).isDirectory()
        } catch {
          return false
        }
      })

  ipcMain.handle('footage:status', () => current)
  ipcMain.handle('footage:list', () => d.store.list())
  ipcMain.handle('footage:get', (_e, id: string): FootageProject | null => d.store.read(String(id)))
  ipcMain.handle('footage:posters', (_e, id: string) => {
    try {
      return d.service.posters(String(id))
    } catch {
      return {}
    }
  })

  ipcMain.handle('footage:pickFolders', async () => {
    const win = d.window()
    const pick = await dialog.showOpenDialog(win!, { title: 'Choose the folders with your videos', properties: ['openDirectory', 'multiSelections'] })
    return pick.canceled ? [] : pick.filePaths
  })

  ipcMain.handle('footage:pickMusic', async () => {
    const win = d.window()
    const pick = await dialog.showOpenDialog(win!, { title: 'Choose a music track', properties: ['openFile'], filters: [AUDIO_FILTER] })
    return pick.canceled ? null : pick.filePaths[0]
  })

  ipcMain.handle('footage:create', (_e, name: string, folders: string[]) => {
    try {
      const dirs = directories(folders)
      if (!dirs.length) return { ok: false, error: 'Choose at least one folder that exists.' }
      return { ok: true, project: d.store.create(String(name || 'My footage'), dirs) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('footage:addFolders', (_e, id: string, folders: string[]) => {
    try {
      const dirs = directories(folders)
      if (!dirs.length) return { ok: false, error: 'Choose a folder that exists.' }
      return { ok: true, project: d.store.update(String(id), (p) => { p.folders = dedupe([...p.folders, ...dirs]) }) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('footage:removeFolder', (_e, id: string, folder: string) => {
    try {
      const target = resolve(String(folder)).toLowerCase()
      // forget the folder and its clips; the files themselves are never touched
      return {
        ok: true,
        project: d.store.update(String(id), (p) => {
          p.folders = p.folders.filter((f) => resolve(f).toLowerCase() !== target)
          p.clips = p.clips.filter((c) => resolve(c.folder).toLowerCase() !== target)
        })
      }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('footage:rename', (_e, id: string, name: string) => {
    try {
      return { ok: true, project: d.store.update(String(id), (p) => { p.name = String(name).trim().slice(0, 80) || p.name }) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('footage:scan', (_e, id: string) => background(String(id), 'scan', () => d.service.scan(String(id))))
  ipcMain.handle('footage:understand', (_e, id: string) => background(String(id), 'understand', () => d.service.understand(String(id))))
  ipcMain.handle('footage:estimate', (_e, id: string) => {
    try {
      return d.service.estimate(String(id))
    } catch {
      return { shots: 0, clips: 0, speechMinutes: 0, usd: 0 }
    }
  })

  ipcMain.handle('footage:plan', async (_e, id: string, req: PlanRequest) => {
    try {
      if (!req || typeof req.prompt !== 'string' || !req.prompt.trim()) return { ok: false, error: 'Describe the video you want first.' }
      const result = await job(String(id), () => d.service.plan(String(id), { ...req, prompt: req.prompt.trim().slice(0, 4000) }))
      return { ok: true, result }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('footage:render', (_e, id: string, rawPlan: unknown, prompt: string) => {
    const parsed = EditPlan.safeParse(rawPlan)
    if (!parsed.success) return { ok: false, error: 'Those changes do not make a valid edit. Plan it again.' }
    const plan = parsed.data
    return background(String(id), 'render', async () => {
      const projectId = String(id)
      d.emit('footage:event', { kind: 'render', projectId, status: 'started' } satisfies FootageEvent)
      try {
        const edit = await d.service.render(projectId, plan, String(prompt ?? ''), (pct, phase) => d.emit('footage:event', { kind: 'render', projectId, status: 'progress', pct, phase } satisfies FootageEvent))
        d.emit('footage:event', { kind: 'render', projectId, status: 'done', edit } satisfies FootageEvent)
      } catch (err) {
        if (err instanceof FootageCancelled) d.emit('footage:event', { kind: 'render', projectId, status: 'cancelled' } satisfies FootageEvent)
        else d.emit('footage:event', { kind: 'render', projectId, status: 'failed', error: String((err as Error)?.message ?? err) } satisfies FootageEvent)
      }
    })
  })

  ipcMain.handle('footage:cancel', () => {
    d.service.cancel()
    return true
  })

  ipcMain.handle('footage:removeEdit', (_e, id: string, editId: string) => {
    try {
      d.store.removeEdit(String(id), String(editId))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('footage:delete', (_e, id: string) => {
    if (d.isBusy()) return { ok: false, error: 'A job is running: stop it first.' }
    try {
      return { ok: d.store.delete(String(id)) }
    } catch (err) {
      return fail(err)
    }
  })

  /** only files inside the footage store (rendered edits) can be opened from the renderer */
  const inStore = (file: unknown): string | null => {
    if (typeof file !== 'string') return null
    const p = resolve(file)
    return p.startsWith(resolve(d.store.rootDir) + sep) && existsSync(p) ? p : null
  }
  ipcMain.handle('footage:play', (_e, file: string) => {
    const p = inStore(file)
    if (!p) return false
    void shell.openPath(p)
    return true
  })
  ipcMain.handle('footage:reveal', (_e, file: string) => {
    const p = inStore(file)
    if (!p) return false
    shell.showItemInFolder(p)
    return true
  })
}
