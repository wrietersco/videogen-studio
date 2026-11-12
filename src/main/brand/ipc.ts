import { BrowserWindow, dialog, ipcMain } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import type { BrandKitPatch, BrandKitView } from '@shared/brand'
import { MAX_LOGO_BYTES } from './logo'
import type { BrandStore } from './store'

/** Brand kit IPC. Logos travel to the renderer as small inline previews only. */

type Result = { ok: true; kit: BrandKitView } | { ok: false; error: string }

export function registerBrandIpc(store: BrandStore): void {
  const fail = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : String(e) })
  const done = (kit: ReturnType<BrandStore['get']>): Result => (kit ? { ok: true, kit: store.view(kit) } : { ok: false, error: 'This brand kit no longer exists.' })

  /** the picked or dropped file, read after a size check */
  const logoBytes = async (e: Electron.IpcMainInvokeEvent, path?: string): Promise<Buffer | null> => {
    let file = typeof path === 'string' && path ? path : ''
    if (!file) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const pick = await dialog.showOpenDialog(win!, {
        title: 'Choose your logo',
        properties: ['openFile'],
        filters: [{ name: 'Logo', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'gif'] }]
      })
      if (pick.canceled || !pick.filePaths[0]) return null
      file = pick.filePaths[0]
    }
    try {
      if (statSync(file).size > MAX_LOGO_BYTES) throw new Error('This file is larger than 15 MB. Export a smaller logo.')
      return readFileSync(file)
    } catch (e) {
      // a missing or locked file should read like a sentence, not like a Node error
      if (e instanceof Error && /15 MB/.test(e.message)) throw e
      throw new Error('This file could not be opened. Pick it again, or choose another file.')
    }
  }

  ipcMain.handle('brand:list', () => ({ kits: store.list().map((k) => store.view(k)), lastUsedId: store.lastUsed()?.id ?? '' }))
  ipcMain.handle('brand:create', (_e, name: string): Result => {
    try {
      return done(store.create(name))
    } catch (e) {
      return fail(e)
    }
  })
  ipcMain.handle('brand:update', (_e, id: string, patch: BrandKitPatch): Result => done(store.update(String(id), patch ?? {})))
  ipcMain.handle('brand:remove', (_e, id: string) => store.remove(String(id)))
  ipcMain.handle('brand:setLastUsed', (_e, id: string) => {
    store.setLastUsed(String(id ?? ''))
    return true
  })
  ipcMain.handle('brand:setLogo', async (e, id: string, path?: string, slot?: 'onDark' | 'onLight'): Promise<Result | { ok: false; error: ''; cancelled: true }> => {
    try {
      const data = await logoBytes(e, path)
      if (!data) return { ok: false, error: '', cancelled: true }
      return done(slot === 'onDark' || slot === 'onLight' ? await store.setVariant(String(id), slot, data) : await store.setLogo(String(id), data))
    } catch (err) {
      return fail(err)
    }
  })
  ipcMain.handle('brand:removeLogo', (_e, id: string): Result => done(store.removeLogo(String(id))))
}
