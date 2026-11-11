import { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'

// ESM output: derive the directory from import.meta.url
const moduleDir = dirname(fileURLToPath(import.meta.url))
import { VideoSpec } from '@shared/spec'
import { Orchestrator, GenerationCancelled, type GenerateOptions } from './pipeline/orchestrator'
import { ProjectStore } from './store/projectStore'
import { providerRegistry } from './providers/registry'
import type { ProviderId } from './providers/types'
import { DEFAULT_MEDIA, DEFAULT_SETTINGS, type KeyId, type Settings } from './settings'
import { PROVIDER_CAPABILITIES, type ProviderRole } from '@shared/providerRoles'
import { AssetLibrary } from './assets/library'
import { registerAssetIpc, registerAssetScheme } from './assets/ipc'
import { MediaRouter } from './media/router'
import { applyAutopilot, decide, decideCreative, honorShape } from './autopilot'
import { enhancePrompt, type EnhanceRequest } from './promptEnhancer'
import { PromptTemplateStore, type TemplateInput } from './store/promptTemplates'
import { ensureBrowser } from './rendererService/hyperframes'
import { projectsDir, appRoot, libraryDir, builtinPackDir, footageDir } from './paths'
import { FootageStore } from './footage/store'
import { FootageService } from './footage/service'
import { registerFootageIpc } from './footage/ipc'
import { meter, readProjectUsage, type UsageRun } from './usage/meter'
import { checkForUpdate, downloadUpdate, installUpdate } from './updater'
import { AccountError, AccountSession, newProjectKey, type AccountStatus } from './license/session'
import { accessMode, effectiveSettings, type AccessMode } from './license/access'
import { setManagedRouter, withProject } from './license/route'
import { setClipCap } from './director/director'

/**
 * Electron main process — owns the pipeline, project store, provider keys
 * (safeStorage-encrypted on disk), and the render job queue.
 */

// custom protocols must be declared before 'ready'
registerAssetScheme()

const store = new ProjectStore(projectsDir)
const library = new AssetLibrary(libraryDir, builtinPackDir, () => settings.sharing)
/** decrypted keys, cached (safeStorage round-trips are not free) */
const keyCache = new Map<KeyId, string>()
const keyOf = (id: KeyId): string => {
  // on a plan, AI providers are reached through the licence server; with no AI, not at all
  if (id === 'openai' || id === 'gemini' || id === 'elevenlabs' || id === 'anthropic' || id === 'deepseek') {
    if (aiOff) return ''
    if (mode === 'plan') return id === 'anthropic' || id === 'deepseek' ? '' : 'managed'
    if (mode === 'programmatic') return ''
  }
  if (!keyCache.has(id)) keyCache.set(id, decryptKey(settings.keys[id]))
  return keyCache.get(id) ?? ''
}
const media = new MediaRouter({
  library,
  settings: () => runSettings ?? effective,
  key: keyOf,
  provider: (id) => providerRegistry.get(id),
  providerForRole: (role) => providerRegistry.forRole(role),
  roleAllows: (id, role) => providerRegistry.roleEnabled(id, role),
  autoImageProvider: () => providerRegistry.imageProvider(),
  onDecision: (projectId, message) => { if (store.readMeta(projectId)) store.appendEvent(projectId, `media · ${message}`) }
})
const footageStore = new FootageStore(footageDir)
const footage = new FootageService({
  store: footageStore,
  provider: () => providerRegistry.forRole('text') ?? providerRegistry.active(),
  visionProvider: () => providerRegistry.forRole('image-process') ?? providerRegistry.active(),
  whisperKey: () => (providerRegistry.roleEnabled('openai', 'audio-process') ? keyOf('openai') : ''),
  chatModel: () => effective.models[effective.provider] || ({ openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash', deepseek: 'deepseek-chat' } as Record<string, string>)[effective.provider],
  emit: (e) => emit('footage:event', e),
  aiReady: () => (mode === 'plan' ? (planEnt()?.clipsPerVideo ?? 0) > 0 : keyOf('gemini').length > 0),
  makeClip: async (prompt, aspect, sec) => {
    const asset = await media.clipToLibrary(prompt, aspect === '9:16' ? 'portrait' : 'landscape', { durationSec: sec })
    const file = library.path(asset.id)
    if (!file) throw new Error('The AI scene was made but could not be found in the library')
    return file
  }
})
const orchestrator = new Orchestrator(
  store,
  () => providerRegistry.forRole('text') ?? providerRegistry.active(),
  () => providerRegistry.imageProvider(),
  media,
  () => providerRegistry.forRole('code') ?? providerRegistry.active(),
  () => providerRegistry.forRole('image-process') ?? providerRegistry.active()
)

// ---------------- settings (encrypted key storage) ----------------

const settingsPath = join(app.getPath('userData'), 'settings.json')
const templates = new PromptTemplateStore(join(app.getPath('userData'), 'prompt-templates.json'))
let settings: Settings = { ...DEFAULT_SETTINGS }
/** autopilot's per-video settings; null outside a generate run (then the user's own settings apply) */
let runSettings: Settings | null = null
/** the user's settings as the current access allows them (plan-clamped, or no AI) — see license/access.ts */
let effective: Settings = { ...DEFAULT_SETTINGS }
let mode: AccessMode = 'programmatic'
/** a programmatic run is in progress: every AI path is switched off */
let aiOff = false

// ---------------- account, plan and access ----------------

const account = new AccountSession({
  dir: app.getPath('userData'),
  appVersion: app.getVersion(),
  encrypt: (plain) => encryptKey(plain),
  decrypt: (stored) => decryptKey(stored),
  openExternal: (url) => void shell.openExternal(url),
  onChange: (status) => {
    applyAccess()
    emit('account:changed', accountPayload(status))
  }
})
const planEnt = () => account.status().view?.entitlements ?? null

/** recompute what runs: provider, model, keys, relay and clip cap all follow the account's plan */
function applyAccess(): void {
  if (aiOff) return // a programmatic run re-applies when it ends
  const ent = planEnt()
  mode = accessMode({ signedIn: account.signedIn, ent, wantsOwnKeys: settings.useOwnKeys })
  effective = effectiveSettings(settings, mode, ent)
  keyCache.clear()
  providerRegistry.reconfigure(effective)
  providerRegistry.setKeys(
    mode === 'plan'
      ? { openai: 'managed', gemini: 'managed' }
      : mode === 'own-keys'
        ? {
            openai: decryptKey(settings.keys.openai),
            anthropic: decryptKey(settings.keys.anthropic),
            gemini: decryptKey(settings.keys.gemini),
            deepseek: decryptKey(settings.keys.deepseek)
          }
        : {}
  )
  setManagedRouter(mode === 'plan' ? (p) => account.managedRoute(p) : null)
  setClipCap(mode === 'plan' && ent ? ent.clipsPerVideo : 3)
}

function accountPayload(status: AccountStatus = account.status()) {
  return { ...status, mode }
}

const accountError = (err: unknown) =>
  err instanceof AccountError ? { ok: false as const, code: err.code, error: err.message, ...err.extra } : { ok: false as const, code: 'error', error: String((err as Error)?.message ?? err) }

interface ProjectLicense {
  projectKey: string
  mode: 'ai' | 'programmatic'
}

/** the key a project's AI calls are counted under (saved with the project so edits reopen the same video) */
function projectLicense(projectId: string): ProjectLicense {
  try {
    const saved = JSON.parse(readFileSync(join(store.dir(projectId), 'license.json'), 'utf8')) as ProjectLicense
    if (/^[A-Za-z0-9_-]{4,80}$/.test(saved.projectKey) && (saved.mode === 'ai' || saved.mode === 'programmatic')) return saved
  } catch {
    /* made before licences existed: editing it with AI counts it once as an AI video */
  }
  return { projectKey: `p-${projectId}`.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80), mode: 'ai' }
}
function saveProjectLicense(projectId: string, info: ProjectLicense): void {
  if (existsSync(store.dir(projectId))) writeFileSync(join(store.dir(projectId), 'license.json'), JSON.stringify(info))
}

/**
 * Run a job that may call AI models. On a plan the video is started (counted,
 * or reopened) on the server first, so a used-up allowance is refused before
 * anything is paid for, and every call inside is tagged with the video.
 * Programmatic projects, and accounts without AI, run with AI switched off.
 */
async function withAccess<T>(o: { projectKey: string; programmatic: boolean; title: string; durationSec?: number; started?: boolean }, fn: () => Promise<T>): Promise<T> {
  if (o.programmatic || mode === 'programmatic') {
    aiOff = true
    const before = runSettings
    runSettings = effectiveSettings(runSettings ?? settings, 'programmatic', null)
    keyCache.clear()
    providerRegistry.reconfigure(runSettings)
    providerRegistry.setKeys({})
    setManagedRouter(null)
    try {
      return await fn()
    } finally {
      runSettings = before
      aiOff = false
      applyAccess()
    }
  }
  if (mode === 'own-keys') return fn()
  if (!o.started) await account.startVideo(o.projectKey, o.title, o.durationSec)
  return withProject(o.projectKey, fn)
}

/** revise / resume / edit an existing project under its own access */
function projectJob(projectId: string, fn: () => Promise<unknown>): () => Promise<unknown> {
  const lic = projectLicense(projectId)
  const title = store.readMeta(projectId)?.title ?? projectId
  return () =>
    withAccess({ projectKey: lic.projectKey, programmatic: lic.mode === 'programmatic', title }, async () => {
      saveProjectLicense(projectId, lic)
      return fn()
    })
}

function loadSettings(): void {
  if (!existsSync(settingsPath)) return
  try {
    const raw = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<Settings>
    settings = { ...settings, ...raw, media: { ...DEFAULT_MEDIA, ...(raw.media ?? {}) } }
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

/** pipeline events also tell the usage meter which stage is spending */
function pipelineEvent(ev: unknown): void {
  const e = ev as { stage?: string; status?: string }
  if (e.stage && (e.status === 'started' || e.status === 'fixing')) meter.setStage(e.stage === 'compose' ? 'voice & compose' : e.stage)
  emit('gen:event', ev)
}

/**
 * One job at a time: opens a usage run, streams priced entries to the UI,
 * and files the receipt into the project's usage.json when the job ends.
 */
function runJob(kind: UsageRun['kind'], projectId: string | null, job: () => Promise<unknown>): { ok: true } {
  busy = true
  meter.begin(kind)
  job()
    .catch((err) => {
      if (!(err instanceof GenerationCancelled)) {
        emit('gen:event', { stage: 'pipeline', status: 'failed', error: String(err) })
      }
    })
    .finally(() => {
      const id = projectId ?? orchestrator.activeProjectId
      const run = meter.end(id ? store.dir(id) : null)
      if (run && id) emit('usage:run', { projectId: id, run })
      busy = false
    })
  return { ok: true }
}

meter.onEntry((entry, run) => emit('usage:entry', { entry, totalUsd: run.totalUsd, savedUsd: run.savedUsd }))

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

  // ---- in-app updates (GitHub releases) ----
  ipcMain.handle('update:version', () => app.getVersion())
  ipcMain.handle('update:check', async () => {
    try {
      return { ok: true as const, info: await checkForUpdate() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('update:download', async () => {
    try {
      await downloadUpdate((done, total) => emit('update:progress', { done, total }))
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('update:install', () => {
    if (busy) return { ok: false as const, error: 'A video is being made — update once it finishes' }
    try {
      installUpdate()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('update:openRelease', (_e, url: string) => {
    if (/^https:\/\/github\.com\/wrietersco\/videogen-studio\//.test(url)) void shell.openExternal(url)
  })

  ipcMain.handle('settings:get', () => ({
    ...settings,
    keys: {} // never send raw keys back to the UI; presence flags only
  }))
  /** what actually runs after the plan's limits (the Settings screen shows locked choices from this) */
  ipcMain.handle('settings:effective', () => ({ ...effective, keys: {}, mode }))

  // ---- account, licence and plan ----
  ipcMain.handle('account:status', () => accountPayload())
  const accountCall = async (fn: () => Promise<AccountStatus>) => {
    try {
      return { ok: true as const, status: accountPayload(await fn()) }
    } catch (err) {
      return accountError(err)
    }
  }
  ipcMain.handle('account:signUp', (_e, email: string, password: string) => accountCall(() => account.signUp(String(email ?? ''), String(password ?? ''))))
  ipcMain.handle('account:signIn', (_e, email: string, password: string) => accountCall(() => account.signIn(String(email ?? ''), String(password ?? ''))))
  ipcMain.handle('account:plans', () => account.plans())
  ipcMain.handle('account:google', () => accountCall(() => account.signInWithGoogle()))
  ipcMain.handle('account:cancelGoogle', () => account.cancelGoogle())
  ipcMain.handle('account:signOut', () => {
    if (busy) return { ok: false as const, code: 'busy', error: 'A video is being made — sign out once it finishes' }
    return accountCall(() => account.signOut())
  })
  ipcMain.handle('account:refresh', () => accountCall(() => account.sync(true)))
  ipcMain.handle('account:activate', (_e, key: string) => accountCall(() => account.activate(String(key ?? ''))))
  ipcMain.handle('account:leave', () => accountCall(() => account.leaveLicense()))
  ipcMain.handle('account:removeDevice', (_e, id: string) => accountCall(() => account.removeDevice(String(id ?? ''))))
  ipcMain.handle('account:resendVerification', async () => {
    try {
      await account.sendVerification()
      return { ok: true as const }
    } catch (err) {
      return accountError(err)
    }
  })
  ipcMain.handle('account:resetPassword', async (_e, email: string) => {
    try {
      await account.resetPassword(String(email ?? ''))
      return { ok: true as const }
    } catch (err) {
      return accountError(err)
    }
  })
  ipcMain.handle('account:contactSales', (_e, plan: string) => {
    const subject = encodeURIComponent(`VideoGen Studio — ${String(plan ?? '').replace(/[^A-Za-z ]/g, '').slice(0, 20) || 'plan'} licence`)
    void shell.openExternal(`mailto:visitwritersco@gmail.com?subject=${subject}`)
  })
  ipcMain.handle('settings:hasKey', (_e, provider: KeyId) => Boolean(settings.keys[provider]))
  ipcMain.handle('settings:keyStatus', () =>
    Object.fromEntries((['openai', 'anthropic', 'gemini', 'deepseek', 'elevenlabs', 'pexels', 'pixabay'] as KeyId[]).map((k) => [k, Boolean(settings.keys[k])]))
  )
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    if (patch.provider) settings.provider = patch.provider
    if (patch.models) settings.models = { ...settings.models, ...patch.models }
    if (patch.roles) {
      // keep only known providers and only roles their capability matrix allows
      settings.roles = Object.fromEntries(
        Object.entries(patch.roles).flatMap(([p, list]) => {
          const id = p as ProviderId
          const allowed = PROVIDER_CAPABILITIES[id]
          if (!allowed || !Array.isArray(list)) return []
          const roles = [...new Set(list)].filter((r): r is ProviderRole => allowed.includes(r))
          return roles.length ? [[id, roles] as [ProviderId, ProviderRole[]]] : []
        })
      )
    }
    if (patch.quality) settings.quality = patch.quality
    if (typeof patch.allowGpu === 'boolean') settings.allowGpu = patch.allowGpu
    if (patch.craft === 'directed' || patch.craft === 'classic') settings.craft = patch.craft
    if (patch.media) settings.media = { ...settings.media, ...patch.media }
    if (patch.reuse === 'smart' || patch.reuse === 'fresh') settings.reuse = patch.reuse
    if (patch.sharing === 'local' || patch.sharing === 'shareable') settings.sharing = patch.sharing
    if (typeof patch.autopilot === 'boolean') settings.autopilot = patch.autopilot
    if (typeof patch.useOwnKeys === 'boolean') settings.useOwnKeys = patch.useOwnKeys
    saveSettings()
    applyAccess()
    return true
  })
  ipcMain.handle('settings:setKey', (_e, provider: KeyId, key: string) => {
    settings.keys[provider] = encryptKey(key.trim())
    keyCache.delete(provider)
    saveSettings()
    applyAccess()
    return true
  })
  ipcMain.handle('settings:clearKey', (_e, provider: KeyId) => {
    delete settings.keys[provider]
    keyCache.delete(provider)
    saveSettings()
    applyAccess()
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
    // no live captures yet (e.g. a video made from the command line): show each scene's painted picture
    const shown = thumbs.length
      ? thumbs
      : (spec?.scenes ?? []).map((sc) => {
          const f = spec?.crafts.find((c) => c.sceneId === sc.id)?.plate?.file
          const path = f ? join(store.dir(id), f) : ''
          return path && existsSync(path) ? `data:image/${path.endsWith('.png') ? 'png' : 'jpeg'};base64,${readFileSync(path).toString('base64')}` : ''
        })
    return { meta, spec, html, dir: store.dir(id), thumbs: shown }
  })

  ipcMain.handle('gen:generate', async (_e, opts: GenerateOptions & { shapeLocked?: boolean; programmatic?: boolean }) => {
    if (busy) return { ok: false, error: 'A generation job is already running' }
    const programmatic = opts.programmatic === true || mode === 'programmatic'
    const projectKey = newProjectKey()
    const title = opts.prompt.slice(0, 120)
    if (!programmatic && mode === 'plan') {
      // refuse before the job starts, so the Create screen can say why
      try {
        await account.startVideo(projectKey, title, opts.durationHintSec)
      } catch (err) {
        return accountError(err)
      }
    }
    return runJob('generate', null, () => withAccess({ projectKey, programmatic, title, durationSec: opts.durationHintSec, started: true }, async () => {
      const remember = () => {
        const id = orchestrator.activeProjectId
        if (id && !existsSync(join(store.dir(id), 'license.json'))) saveProjectLicense(id, { projectKey, mode: programmatic ? 'programmatic' : 'ai' })
      }
      const onEvent = (ev: unknown) => {
        remember()
        pipelineEvent(ev)
      }
      try {
        const decided = settings.autopilot ? await decideCreative(opts.prompt, providerRegistry.active()) : null
        const creative = decided && opts.shapeLocked ? honorShape(decided, opts.platform) : decided
        if (creative) pipelineEvent({ stage: 'plan', status: 'creative', ...creative })
        const base = runSettings ?? effective
        const pilot = settings.autopilot ? decide({ prompt: opts.prompt, durationHintSec: creative?.durationHintSec ?? opts.durationHintSec, settings: base, imageAvailable: media.imageAvailable() }) : null
        if (pilot) runSettings = applyAutopilot(base, pilot)
        return await orchestrator.generate({
          ...opts,
          ...(creative ? { platform: creative.platform, styleHint: creative.styleHint, durationHintSec: creative.durationHintSec } : {}),
          quality: settings.quality,
          gpu: settings.allowGpu,
          craft: settings.craft,
          lookHint: creative?.look ?? pilot?.look,
          autopilotNotes: [...(creative ? [`format: ${creative.platform} · ${creative.styleHint} · ${creative.durationHintSec}s · ${creative.look} — ${creative.reason}`] : []), ...(pilot?.reasons.filter((reason) => !creative || !reason.startsWith('look:')) ?? [])],
          onEvent
        })
      } finally {
        remember()
        runSettings = null
      }
    }))
  })
  ipcMain.handle('prompt:enhance', async (_e, req: EnhanceRequest) => {
    try {
      return { ok: true, result: await enhancePrompt(providerRegistry.active(), req) }
    } catch (err) {
      return { ok: false, error: String((err as Error)?.message ?? err) }
    }
  })
  ipcMain.handle('templates:list', () => templates.list())
  ipcMain.handle('templates:save', (_e, t: TemplateInput) => {
    try {
      return { ok: true, template: templates.save(t) }
    } catch (err) {
      console.warn('[templates] save rejected', err)
      return { ok: false, error: 'Give the template a name (up to 60 characters) and at least one section.' }
    }
  })
  ipcMain.handle('templates:remove', (_e, id: string) => templates.remove(id))
  ipcMain.handle('gen:cancel', () => {
    orchestrator.cancel()
    return true
  })
  ipcMain.handle('gen:busy', () => busy)

  ipcMain.handle('gen:rerender', async (_e, projectId: string) => {
    if (busy) return { ok: false, error: 'Another job is running' }
    // a re-render only draws frames again: no AI, nothing counted
    return runJob('rerender', projectId, () => withAccess({ projectKey: 'rerender', programmatic: true, title: '' }, () =>
      orchestrator.rerender(projectId, { quality: settings.quality, gpu: settings.allowGpu, onEvent: pipelineEvent })
    ))
  })

  ipcMain.handle('gen:revise', async (_e, projectId: string, sceneId: string, feedback: string) => {
    if (busy) return { ok: false, error: 'Another job is running' }
    if (!feedback || !feedback.trim()) return { ok: false, error: 'Feedback is empty' }
    return runJob('revise', projectId, projectJob(projectId, () =>
      orchestrator.reviseScene(projectId, sceneId, feedback.trim(), {
        quality: settings.quality,
        gpu: settings.allowGpu,
        craft: settings.craft,
        onEvent: pipelineEvent
      })
    ))
  })

  ipcMain.handle('gen:applyEdit', async (_e, projectId: string, edited: unknown) => {
    if (busy) return { ok: false, error: 'Another job is running' }
    try {
      VideoSpec.parse(edited)
    } catch (e) {
      return { ok: false, error: `Those changes don't make a valid video: ${String((e as Error).message).slice(0, 160)}` }
    }
    return runJob('revise', projectId, projectJob(projectId, () =>
      orchestrator.applyEdit(projectId, edited, { quality: settings.quality, gpu: settings.allowGpu, onEvent: pipelineEvent })
    ))
  })
  ipcMain.handle('project:history', (_e, id: string) => store.listHistory(id))
  ipcMain.handle('project:historyGet', (_e, id: string, at: number) => store.readHistory(id, at))

  ipcMain.handle('gen:resume', async (_e, projectId: string) => {
    if (busy) return { ok: false, error: 'Another job is running' }
    return runJob('resume', projectId, projectJob(projectId, () =>
      orchestrator.resume(projectId, { quality: settings.quality, gpu: settings.allowGpu, craft: settings.craft, onEvent: pipelineEvent })
    ))
  })

  ipcMain.handle('project:usage', (_e, id: string) => readProjectUsage(store.dir(id)))

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
  // fresh installs download the renderer's Chrome once; start before the first job
  void ensureBrowser()
  loadSettings()
  applyAccess()
  // refresh the plan in the background; offline keeps the last one for display
  void account.sync().catch((err) => console.warn('[account] sync failed', err instanceof Error ? err.message : err))
  registerIpc()
  registerAssetIpc({ library, router: media, key: keyOf, isBusy: () => busy })
  registerFootageIpc({
    store: footageStore,
    service: footage,
    isBusy: () => busy,
    setBusy: (b) => { busy = b },
    emit,
    window: () => win,
    aiJob: (projectKey, title, fn) => {
      if (mode === 'programmatic') return Promise.reject(new Error(account.signedIn ? (planEnt()?.aiBlockedReason || 'AI is not available on this account.') : 'Sign in to use AI on your footage.'))
      return withAccess({ projectKey, programmatic: false, title }, fn)
    }
  })
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
