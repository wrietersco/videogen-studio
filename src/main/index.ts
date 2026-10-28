import { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'

// ESM output: derive the directory from import.meta.url
const moduleDir = dirname(fileURLToPath(import.meta.url))
import { Orchestrator, GenerationCancelled, type GenerateOptions } from './pipeline/orchestrator'
import { ProjectStore } from './store/projectStore'
import { providerRegistry } from './providers/registry'
import type { ProviderId } from './providers/types'
import { DEFAULT_SETTINGS, type Settings } from './settings'
import { projectsDir, appRoot } from './paths'

/**
 * Electron main process — owns the pipeline, project store, provider keys
 * (safeStorage-encrypted on disk), and the render job queue.
 */

const store = new ProjectStore(projectsDir)
const orchestrator = new Orchestrator(
  store,
  () => providerRegistry.active(),
  () => providerRegistry.imageProvider()
)

// ---------------- settings (encrypted key storage) ----------------

const settingsPath = join(app.getPath('userData'), 'settings.json')
let settings: Settings = { ...DEFAULT_SETTINGS }

function loadSettings(): void {
  if (!existsSync(settingsPath)) return
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<Settings>
    settings = { ...settings, ...raw }
  } catch {
    /* corrupt settings — keep defaults */
  }
}

function saveSettings(): void {
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

function encryptKey(plain: string): string {
  if (!plain) return ''
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  }
  return `plain:${plain}` // fallback: no OS keychain (Linux without kwallet etc.)
}

function decryptKey(stored: string | undefined): string {
  if (!stored) return ''
  if (stored.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'))
  if (stored.startsWith('plain:')) return stored.slice(6)
  return ''
}

// ---------------- window ----------------

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let balloonShown = false

function showMainWindow(): void {
  if (!win) return
  win.show()
  win.focus()
}

/** tray icon: the app lives on while the window is hidden, so renders survive a "close" */
function createTray(): void {
  const icon = nativeImage.createFromPath(join(appRoot, 'resources', 'tray.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('VideoGen Studio — running in the background')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open VideoGen Studio', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('double-click', showMainWindow)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    backgroundColor: '#0B0B12',
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(moduleDir, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(moduleDir, '../renderer/index.html'))
  }
  // closing the window hides to tray — the pipeline (renders, generation) keeps going
  win.on('close', (e) => {
    if (quitting) return
    e.preventDefault()
    win?.hide()
    if (tray && !balloonShown) {
      balloonShown = true
      tray.displayBalloon({
        iconType: 'info',
        title: 'VideoGen Studio is still running',
        content: 'Videos keep rendering in the background. Click the tray icon to reopen.'
      })
    }
  })
}

// ---------------- job management ----------------

let busy = false

function emit(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload)
}

// ---------------- ipc ----------------

function registerIpc(): void {
  // custom titlebar window controls (frame is hidden)
  ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
  ipcMain.on('win:maximize', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

  ipcMain.handle('settings:get', () => ({
    ...settings,
    keys: {} // never send raw keys back to the UI; presence flags only
  }))
  ipcMain.handle('settings:hasKey', (_e, provider: ProviderId) => Boolean(settings.keys[provider]))
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    if (patch.provider) settings.provider = patch.provider
    if (patch.models) settings.models = { ...settings.models, ...patch.models }
    if (patch.quality) settings.quality = patch.quality
    if (typeof patch.allowGpu === 'boolean') settings.allowGpu = patch.allowGpu
    if (patch.craft === 'directed' || patch.craft === 'classic') settings.craft = patch.craft
    saveSettings()
    providerRegistry.reconfigure(settings)
    return true
  })
  ipcMain.handle('settings:setKey', (_e, provider: ProviderId, key: string) => {
    settings.keys[provider] = encryptKey(key.trim())
    saveSettings()
    providerRegistry.reconfigure(settings, { [provider]: decryptKey(settings.keys[provider]) })
    return true
  })
  ipcMain.handle('settings:clearKey', (_e, provider: ProviderId) => {
    delete settings.keys[provider]
    saveSettings()
    providerRegistry.reconfigure(settings)
    return true
  })

  ipcMain.handle('providers:list', async () => {
    return providerRegistry.describe()
  })
  ipcMain.handle('providers:models', async (_e, provider: ProviderId) => {
    return providerRegistry.get(provider).listModels()
  })
  ipcMain.handle('providers:image-models', async () => {
    const p = providerRegistry.get('openai')
    return p.listImageModels ? p.listImageModels() : []
  })

  ipcMain.handle('projects:list', () => store.list())
  ipcMain.handle('project:get', (_e, id: string) => {
    const meta = store.readMeta(id)
    const spec = store.readSpec(id)
    const html = existsSync(join(store.dir(id), 'index.html'))
      ? readFileSync(join(store.dir(id), 'index.html'), 'utf8')
      : null
    // live-storyboard captures (JPEG) as data URLs for the scene cards
    const thumbsDir = join(store.dir(id), 'thumbs')
    const thumbs = existsSync(thumbsDir)
      ? readdirSync(thumbsDir)
          .filter((f) => f.endsWith('.jpg'))
          .sort()
          .map((f) => `data:image/jpeg;base64,${readFileSync(join(thumbsDir, f)).toString('base64')}`)
      : []
    return { meta, spec, html, dir: store.dir(id), thumbs }
  })

  ipcMain.handle('gen:generate', async (_e, opts: GenerateOptions) => {
    if (busy) return { ok: false, error: 'A generation job is already running' }
    busy = true
    const onEvent = (ev: unknown) => emit('gen:event', ev)
    // run async; UI streams events
    orchestrator
      .generate({ ...opts, quality: settings.quality, gpu: settings.allowGpu, craft: settings.craft, onEvent })
      .catch((err) => {
        if (!(err instanceof GenerationCancelled)) {
          emit('gen:event', { stage: 'pipeline', status: 'failed', error: String(err) })
        }
      })
      .finally(() => {
        busy = false
      })
    return { ok: true }
  })
  ipcMain.handle('gen:cancel', () => {
    orchestrator.cancel()
    return true
  })
  ipcMain.handle('gen:busy', () => busy)

  ipcMain.handle('gen:rerender', async (_e, projectId: string) => {
    if (busy) return { ok: false, error: 'Another job is running' }
    busy = true
    orchestrator
      .rerender(projectId, { quality: settings.quality, gpu: settings.allowGpu, onEvent: (ev) => emit('gen:event', ev) })
      .catch((err) => {
        if (!(err instanceof GenerationCancelled)) {
          emit('gen:event', { stage: 'pipeline', status: 'failed', error: String(err) })
        }
      })
      .finally(() => {
        busy = false
      })
    return { ok: true }
  })

  ipcMain.handle('gen:revise', async (_e, projectId: string, sceneId: string, feedback: string) => {
    if (busy) return { ok: false, error: 'Another job is running' }
    if (!feedback || !feedback.trim()) return { ok: false, error: 'Feedback is empty' }
    busy = true
    orchestrator
      .reviseScene(projectId, sceneId, feedback.trim(), {
        quality: settings.quality,
        gpu: settings.allowGpu,
        craft: settings.craft,
        onEvent: (ev) => emit('gen:event', ev)
      })
      .catch((err) => {
        if (!(err instanceof GenerationCancelled)) {
          emit('gen:event', { stage: 'pipeline', status: 'failed', error: String(err) })
        }
      })
      .finally(() => {
        busy = false
      })
    return { ok: true }
  })

  ipcMain.handle('gen:resume', async (_e, projectId: string) => {
    if (busy) return { ok: false, error: 'Another job is running' }
    busy = true
    orchestrator
      .resume(projectId, { quality: settings.quality, gpu: settings.allowGpu, craft: settings.craft, onEvent: (ev) => emit('gen:event', ev) })
      .catch((err) => {
        if (!(err instanceof GenerationCancelled)) {
          emit('gen:event', { stage: 'pipeline', status: 'failed', error: String(err) })
        }
      })
      .finally(() => {
        busy = false
      })
    return { ok: true }
  })

  ipcMain.handle('project:state', (_e, id: string) => store.readState(id))

  ipcMain.handle('project:delete', (_e, id: string) => {    if (orchestrator.activeProjectId === id) {
      return { ok: false, error: 'This project is currently generating — stop it first' }
    }
    return { ok: store.delete(id) }
  })

  ipcMain.handle('project:reveal', (_e, id: string, filePath?: string) => {
    // absolute path (stored render) or project-relative; default: the project folder
    const target =
      filePath && existsSync(filePath)
        ? filePath
        : filePath && existsSync(join(store.dir(id), filePath))
          ? join(store.dir(id), filePath)
          : store.dir(id)
    if (!existsSync(target)) return false
    shell.showItemInFolder(target)
    return true
  })

  // open a rendered video in the system player (full playback: scrub, sound, fullscreen)
  ipcMain.handle('project:play', (_e, id: string, filePath?: string) => {
    const target =
      filePath && existsSync(filePath)
        ? filePath
        : filePath && existsSync(join(store.dir(id), filePath))
          ? join(store.dir(id), filePath)
          : null
    if (!target) return false
    void shell.openPath(target)
    return true
  })
}

app.whenReady().then(() => {
  loadSettings()
  providerRegistry.reconfigure(settings, {
    openai: decryptKey(settings.keys.openai),
    anthropic: decryptKey(settings.keys.anthropic),
    gemini: decryptKey(settings.keys.gemini)
  })
  registerIpc()
  createWindow()
  createTray()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
