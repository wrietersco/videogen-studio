import { app, BrowserWindow, ipcMain, safeStorage, shell, Tray, Menu, nativeImage } from 'electron'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'

// ESM output: derive the directory from import.meta.url
const moduleDir = dirname(fileURLToPath(import.meta.url))
import { VideoSpec } from '@shared/spec'
import { Orchestrator, GenerationCancelled, isIsometricOnlyBrief, type GenerateOptions } from './pipeline/orchestrator'
import { ProjectStore } from './store/projectStore'
import { providerRegistry } from './providers/registry'
import type { LLMProvider, ProviderId } from './providers/types'
import { DEFAULT_MEDIA, DEFAULT_SETTINGS, type KeyId, type Settings } from './settings'
import { PROVIDER_CAPABILITIES, type ProviderRole } from '@shared/providerRoles'
import { AssetLibrary } from './assets/library'
import { registerAssetIpc, registerAssetScheme } from './assets/ipc'
import { BrandStore } from './brand/store'
import { registerBrandIpc } from './brand/ipc'
import { registerReferenceIpc } from './references/ipc'
import { MediaRouter } from './media/router'
import { applyAutopilot, decide, decideCreative, honorShape } from './autopilot'
import { enhancePrompt, type EnhanceRequest } from './promptEnhancer'
import { PromptTemplateStore, type TemplateInput } from './store/promptTemplates'
import { ensureBrowser } from './rendererService/hyperframes'
import { projectsDir, appRoot, libraryDir, builtinPackDir, footageDir, brandDir, appReconDir } from './paths'
import { AppReconStore } from './appRecon/store'
import type { GeminiProvider } from './providers/gemini'
import { luminanceOf } from '@shared/brand'
import { registerAppReconIpc } from './appRecon/ipc'
import { FootageStore } from './footage/store'
import { FootageService } from './footage/service'
import { registerFootageIpc } from './footage/ipc'
import { meter, readProjectUsage, type UsageRun } from './usage/meter'
import { checkForUpdate, downloadUpdate, installUpdate } from './updater'
import type { PlanId } from '@shared/plans'
import { clampSeats, REQUEST_LIMITS, UPGRADE_PLANS, type MyRequest } from '@shared/requests'
import { AccountError, AccountSession, newProjectKey, type AccountStatus } from './license/session'
import { accessMode, effectiveSettings, programmaticSettings, type AccessMode } from './license/access'
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
const brands = new BrandStore(brandDir)
/** decrypted keys, cached (safeStorage round-trips are not free) */
const keyCache = new Map<KeyId, string>()
const storedKey = (id: KeyId): string => {
  if (!keyCache.has(id)) keyCache.set(id, decryptKey(settings.keys[id]))
  return keyCache.get(id) ?? ''
}
/** keys for one-shot surfaces (assets, footage): the plan's relay, or the user's own keys */
const keyOf = (id: KeyId): string => {
  // on a plan, AI providers are reached through the licence server; with no AI, not at all
  if (id === 'openai' || id === 'gemini' || id === 'elevenlabs' || id === 'anthropic' || id === 'deepseek') {
    if (mode === 'plan') return id === 'anthropic' || id === 'deepseek' ? '' : 'managed'
    if (mode === 'programmatic') return ''
  }
  return storedKey(id)
}
const media = new MediaRouter({
  library,
  settings: () => effective,
  key: keyOf,
  provider: (id) => providerRegistry.get(id),
  providerForRole: (role) => providerRegistry.forRole(role),
  roleAllows: (id, role) => providerRegistry.roleEnabled(id, role),
  autoImageProvider: () => providerRegistry.imageProvider(),
  onDecision: (projectId, message) => { if (store.readMeta(projectId)) store.appendEvent(projectId, `media · ${message}`) }
})
const footageStore = new FootageStore(footageDir)
const appReconStore = new AppReconStore(appReconDir, { enc: (s) => encryptKey(s), dec: (s) => decryptKey(s) })
const footage = new FootageService({
  store: footageStore,
  provider: () => providerRegistry.forRole('text') ?? providerRegistry.active(),
  visionProvider: () => providerRegistry.forRole('image-process') ?? providerRegistry.active(),
  whisperKey: () => (providerRegistry.roleEnabled('openai', 'audio-process') ? keyOf('openai') : ''),
  chatModel: () => effective.models[effective.provider] || ({ openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash', deepseek: 'deepseek-flash' } as Record<string, string>)[effective.provider],
  emit: (e) => emit('footage:event', e),
  aiReady: () => (mode === 'plan' ? (planEnt()?.clipsPerVideo ?? 0) > 0 : keyOf('gemini').length > 0),
  makeClip: async (prompt, aspect, sec) => {
    const asset = await media.clipToLibrary(prompt, aspect === '9:16' ? 'portrait' : 'landscape', { durationSec: sec })
    const file = library.path(asset.id)
    if (!file) throw new Error('The AI scene was made but could not be found in the library')
    return file
  }
})

// ---------------- settings (encrypted key storage) ----------------

const settingsPath = join(app.getPath('userData'), 'settings.json')
const templates = new PromptTemplateStore(join(app.getPath('userData'), 'prompt-templates.json'))
let settings: Settings = { ...DEFAULT_SETTINGS }
/** the user's settings as the current access allows them (plan-clamped, or no AI) — see license/access.ts */
let effective: Settings = { ...DEFAULT_SETTINGS }
let mode: AccessMode = 'programmatic'

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
 * Programmatic jobs and own-key jobs are never counted: a programmatic run is
 * built without the plan's AI (see makeRun), so there is nothing to start.
 */
async function withAccess<T>(o: { projectKey: string; programmatic: boolean; title: string; durationSec?: number; started?: boolean }, fn: () => Promise<T>): Promise<T> {
  if (o.programmatic || mode !== 'plan') return fn()
  if (!o.started) await account.startVideo(o.projectKey, o.title, o.durationSec)
  return withProject(o.projectKey, fn)
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

/** how many videos may be made at once — each render owns a Chromium */
const MAX_PARALLEL_JOBS = 3

interface GenJob {
  id: string
  kind: UsageRun['kind']
  title: string
  /** known up front for edits; a generate learns it once its project exists */
  projectId: string | null
  orch: Orchestrator
  startedAt: string
}

/** the generation jobs in flight; footage keeps its own single-job flag below */
const jobs = new Map<string, GenJob>()
let footageBusy = false

const busyNow = () => jobs.size > 0 || footageBusy
const jobProject = (job: GenJob): string | null => job.projectId ?? job.orch.activeProjectId
const jobsView = () => [...jobs.values()].map((j) => ({ id: j.id, projectId: jobProject(j), title: j.title, kind: j.kind, startedAt: j.startedAt }))

function emitJobs(): void {
  emit('gen:jobs', jobsView())
}

/** refuse a job when the machine or the project is already at work */
function jobGate(projectId: string | null): { ok: false; error: string } | null {
  if (footageBusy) return { ok: false, error: 'Another job is running. Wait for it to finish, then try again.' }
  if (jobs.size >= MAX_PARALLEL_JOBS) return { ok: false, error: `${MAX_PARALLEL_JOBS} videos are already being made — stop one or wait for it to finish.` }
  if (projectId && [...jobs.values()].some((j) => jobProject(j) === projectId)) return { ok: false, error: 'This video is already being worked on — stop it first.' }
  return null
}

function emit(channel: string, payload: unknown): void {
  win?.webContents.send(channel, payload)
}

/** everything one job runs with: its own settings, media router and orchestrator */
interface JobRun {
  settings: Settings
  orch: Orchestrator
  media: MediaRouter
  /** programmatic on own keys: the user's full engine runs, never counted */
  artistic: boolean
  text: () => LLMProvider
}

/**
 * Build a job's isolated run context. Nothing global is mutated — the plan's
 * relay and the registry stay as `applyAccess` left them, and this job's key
 * function decides which of those keys it may actually use:
 *   programmatic        the free engine (no AI keys) — never counted
 *   programmatic+own    the user's full engine on their own keys — never counted
 *   plan / own-keys     the account's engines as configured
 */
function makeRun(asProgrammatic: boolean): JobRun {
  const programmatic = asProgrammatic || mode === 'programmatic'
  // programmatic on own keys ("Programmatic+"): the user's full engine, never
  // counted; programmatic anywhere else: the free engine (mock writer, no AI keys)
  const artistic = programmatic && mode === 'own-keys'
  const free = programmatic && !artistic
  const mock = providerRegistry.get('mock')
  const text = free ? () => mock : () => providerRegistry.forRole('text') ?? providerRegistry.active()
  const code = free ? () => mock : () => providerRegistry.forRole('code') ?? (programmatic ? mock : providerRegistry.active())
  const vision = free ? () => mock : () => providerRegistry.forRole('image-process') ?? (programmatic ? mock : providerRegistry.active())
  const image = free ? () => null : () => providerRegistry.imageProvider()
  const run: JobRun = {
    artistic,
    settings: programmatic ? programmaticSettings(settings, artistic) : effective,
    text,
    media: null as unknown as MediaRouter,
    orch: null as unknown as Orchestrator
  }
  const jobKey = (id: KeyId): string => {
    const ai = id === 'openai' || id === 'gemini' || id === 'elevenlabs' || id === 'anthropic' || id === 'deepseek'
    if (ai && free) return ''
    if (ai && mode === 'plan') return id === 'anthropic' || id === 'deepseek' ? '' : 'managed'
    return storedKey(id)
  }
  run.media = new MediaRouter({
    library,
    settings: () => run.settings,
    key: jobKey,
    provider: (id) => providerRegistry.get(id),
    providerForRole: (role) => (free ? null : providerRegistry.forRole(role)),
    roleAllows: (id, role) => providerRegistry.roleEnabled(id, role),
    autoImageProvider: image,
    onDecision: (projectId, message) => { if (store.readMeta(projectId)) store.appendEvent(projectId, `media · ${message}`) }
  })
  run.orch = new Orchestrator(store, text, image, run.media, code, vision)
  return run
}

/**
 * Start one parallel job: opens a scoped usage run, stamps every pipeline
 * event with the project, and files the receipt into the project's usage.json
 * when the job ends. The body runs un-awaited; callers get { ok: true }.
 */
function startJob(kind: UsageRun['kind'], o: { title: string; projectId: string | null; programmatic: boolean }, body: (run: JobRun, onEvent: (ev: unknown) => void) => Promise<unknown>): { ok: true } | { ok: false; error: string } {
  const gate = jobGate(o.projectId)
  if (gate) return gate
  const run = makeRun(o.programmatic)
  const job: GenJob = { id: newProjectKey(), kind, title: o.title, projectId: o.projectId, orch: run.orch, startedAt: new Date().toISOString() }
  jobs.set(job.id, job)
  const usage = meter.open(kind)
  const onEvent = (ev: unknown): void => {
    const e = ev as { stage?: string; status?: string }
    // the meter hears the stage from inside this job's scope
    if (e.stage && (e.status === 'started' || e.status === 'fixing')) meter.setStage(e.stage === 'compose' ? 'voice & compose' : e.stage)
    emit('gen:event', { ...(ev as object), projectId: jobProject(job), jobId: job.id })
  }
  emitJobs()
  meter
    .scope(usage, () => {
      if (o.projectId) meter.bindProject(store.dir(o.projectId))
      return body(run, onEvent)
    })
    .catch((err) => {
      if (!(err instanceof GenerationCancelled)) {
        emit('gen:event', { stage: 'pipeline', status: 'failed', error: String(err), projectId: jobProject(job), jobId: job.id })
      }
    })
    .finally(() => {
      const id = jobProject(job)
      try {
        const closed = meter.close(usage, id ? store.dir(id) : null)
        if (id) emit('usage:run', { projectId: id, run: closed })
      } catch (err) {
        console.warn('[usage] could not finish receipt', err)
      } finally {
        jobs.delete(job.id)
        emitJobs()
      }
    })
  return { ok: true }
}

/** revise / resume / edit / re-render an existing project under its own access, as one parallel job */
function editJob(kind: UsageRun['kind'], projectId: string, body: (run: JobRun, onEvent: (ev: unknown) => void) => Promise<unknown>, opts: { rerender?: boolean } = {}): { ok: true } | { ok: false; error: string } {
  const lic = projectLicense(projectId)
  const title = store.readMeta(projectId)?.title ?? projectId
  const programmatic = opts.rerender === true || lic.mode === 'programmatic' || mode === 'programmatic'
  return startJob(kind, { title, projectId, programmatic }, (run, onEvent) =>
    withAccess({ projectKey: opts.rerender === true ? 'rerender' : lic.projectKey, programmatic, title }, async () => {
      if (opts.rerender !== true) saveProjectLicense(projectId, lic)
      return body(run, onEvent)
    })
  )
}

type GenRequest = Omit<GenerateOptions, 'brand'> & { shapeLocked?: boolean; programmatic?: boolean; /** brand kit for this video ('' or absent = none) */ brandKitId?: string; /** where the logo goes for this video only (from the person's prompt) */ brandOverride?: { watermark?: 'off' | 'top-left' | 'top-right'; endCard?: boolean } }

/**
 * Make a new video as one parallel job. The Create screen and the headless
 * runner both come through here; `tap` sees the job's stamped events.
 */
async function startGenerate(opts: GenRequest, tap?: (ev: Record<string, unknown>) => void): Promise<{ ok: true } | { ok: false; error: string; code?: string }> {
  const programmatic = opts.programmatic === true || mode === 'programmatic'
  if (mode !== 'programmatic' && isIsometricOnlyBrief(opts.prompt)) {
    const vision = providerRegistry.forRole('image-process') ?? providerRegistry.active()
    if (vision.supportsVision?.() === false) return { ok: false, error: 'The selected image-review model cannot inspect images. Choose an image-capable model for that role in Settings; your choices were not changed.' }
  }
  const projectKey = newProjectKey()
  const title = opts.prompt.slice(0, 120)
  const gate = jobGate(null)
  if (gate) return gate
  if (!programmatic && mode === 'plan') {
    // refuse before the job starts, so the Create screen can say why
    try {
      await account.startVideo(projectKey, title, opts.durationHintSec)
    } catch (err) {
      return accountError(err)
    }
  }
  return startJob('generate', { title, projectId: null, programmatic }, (run, emitEvent) =>
    withAccess({ projectKey, programmatic, title, durationSec: opts.durationHintSec, started: true }, async () => {
      const remember = () => {
        const id = run.orch.activeProjectId
        if (id && !existsSync(join(store.dir(id), 'license.json'))) saveProjectLicense(id, { projectKey, mode: programmatic ? 'programmatic' : 'ai' })
      }
      const onEvent = (ev: unknown) => {
        remember()
        emitEvent(ev)
        tap?.({ ...(ev as Record<string, unknown>), projectId: run.orch.activeProjectId })
      }
      try {
        const decided = settings.autopilot ? await decideCreative(opts.prompt, run.text()) : null
        const shaped = decided && opts.shapeLocked ? honorShape(decided, opts.platform) : decided
        // an exact scene grid is the person's own length: the creative pass may not change it
        const creative = shaped && opts.sceneCount && opts.sceneSec ? { ...shaped, durationHintSec: opts.sceneCount * opts.sceneSec } : shaped
        if (creative) onEvent({ stage: 'plan', status: 'creative', ...creative })
        const base = run.settings
        const pilot = settings.autopilot ? decide({ prompt: opts.prompt, durationHintSec: creative?.durationHintSec ?? opts.durationHintSec, settings: base, imageAvailable: run.media.imageAvailable() }) : null
        if (pilot) run.settings = applyAutopilot(base, pilot)
        return await run.orch.generate({
          ...opts,
          ...(creative ? { platform: creative.platform, styleHint: creative.styleHint, durationHintSec: creative.durationHintSec } : {}),
          quality: settings.quality,
          gpu: settings.allowGpu,
          craft: settings.craft,
          brand: opts.brandKitId ? (dir) => brands.attach(String(opts.brandKitId), dir, opts.brandOverride) : undefined,
          lookHint: creative?.look ?? pilot?.look,
          autopilotNotes: [...(creative ? [`format: ${creative.platform} · ${creative.styleHint} · ${creative.durationHintSec}s · ${creative.look} — ${creative.reason}`] : []), ...(pilot?.reasons.filter((reason) => !creative || !reason.startsWith('look:')) ?? [])],
          onEvent
        })
      } catch (err) {
        tap?.({ stage: 'pipeline', status: err instanceof GenerationCancelled ? 'cancelled' : 'failed', error: String(err), projectId: run.orch.activeProjectId })
        throw err
      } finally {
        remember()
      }
    })
  )
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
    if (busyNow()) return { ok: false as const, error: 'A video is being made — update once it finishes' }
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
    if (busyNow()) return { ok: false as const, code: 'busy', error: 'A video is being made — sign out once it finishes' }
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
  const requestCall = async (fn: () => Promise<MyRequest[]>) => {
    try {
      return { ok: true as const, requests: await fn() }
    } catch (err) {
      return accountError(err)
    }
  }
  ipcMain.handle('account:myRequests', () => requestCall(() => account.myRequests()))
  ipcMain.handle('account:requestUpgrade', (_e, plan: string, seats: number) => {
    if (!UPGRADE_PLANS.includes(plan as PlanId)) return { ok: false as const, code: 'bad_plan', error: 'Pick Plus, Pro or Ultra.' }
    return requestCall(() => account.requestUpgrade(plan as PlanId, clampSeats(Number(seats))))
  })
  ipcMain.handle('account:sendMessage', (_e, subject: string, body: string) => requestCall(() => account.sendMessage(String(subject ?? '').slice(0, REQUEST_LIMITS.subject), String(body ?? '').slice(0, REQUEST_LIMITS.body))))
  ipcMain.handle('account:cancelRequest', (_e, id: string) => requestCall(() => account.cancelRequest(String(id ?? ''))))
  ipcMain.handle('account:dismissRequest', (_e, id: string) => requestCall(() => account.dismissRequest(String(id ?? ''))))
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
    if (patch.roleMode === 'order' || patch.roleMode === 'exclusive') settings.roleMode = patch.roleMode
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

  ipcMain.handle('gen:generate', (_e, opts: GenRequest) => startGenerate(opts))
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
  ipcMain.handle('gen:cancel', (_e, projectId?: string) => {
    const list = [...jobs.values()]
    // one project's job, else the newest job (single-job callers)
    const job = (projectId ? list.find((j) => jobProject(j) === projectId || j.id === projectId) : undefined) ?? (projectId ? undefined : list[list.length - 1])
    if (job) {
      job.orch.cancel()
      return true
    }
    return false
  })
  ipcMain.handle('gen:busy', () => busyNow())
  ipcMain.handle('gen:jobs', () => jobsView())

  ipcMain.handle('gen:rerender', (_e, projectId: string) =>
    editJob('rerender', projectId, (run, onEvent) => run.orch.rerender(projectId, { quality: settings.quality, gpu: settings.allowGpu, onEvent }), { rerender: true })
  )

  ipcMain.handle('gen:revise', (_e, projectId: string, sceneId: string, feedback: string) => {
    if (!feedback || !feedback.trim()) return { ok: false, error: 'Feedback is empty' }
    return editJob('revise', projectId, (run, onEvent) =>
      run.orch.reviseScene(projectId, sceneId, feedback.trim(), {
        quality: settings.quality,
        gpu: settings.allowGpu,
        craft: settings.craft,
        onEvent
      })
    )
  })

  ipcMain.handle('gen:applyEdit', (_e, projectId: string, edited: unknown) => {
    try {
      VideoSpec.parse(edited)
    } catch (e) {
      return { ok: false, error: `Those changes don't make a valid video: ${String((e as Error).message).slice(0, 160)}` }
    }
    return editJob('revise', projectId, (run, onEvent) => run.orch.applyEdit(projectId, edited, { quality: settings.quality, gpu: settings.allowGpu, onEvent }))
  })

  ipcMain.handle('project:history', (_e, id: string) => store.listHistory(id))
  ipcMain.handle('project:historyGet', (_e, id: string, at: number) => store.readHistory(id, at))

  ipcMain.handle('gen:resume', (_e, projectId: string) =>
    editJob('resume', projectId, (run, onEvent) => run.orch.resume(projectId, { quality: settings.quality, gpu: settings.allowGpu, craft: settings.craft, onEvent }))
  )

  ipcMain.handle('project:usage', (_e, id: string) => readProjectUsage(store.dir(id)))

  ipcMain.handle('project:state', (_e, id: string) => store.readState(id))

  ipcMain.handle('project:delete', (_e, id: string) => {
    if ([...jobs.values()].some((j) => jobProject(j) === id)) {
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

// ---------------- headless generation (electron . --headless-gen=<json>) ----------------

const HEADLESS_FLAG = '--headless-gen='
const headlessFile = process.argv.find((a) => a.startsWith(HEADLESS_FLAG))?.slice(HEADLESS_FLAG.length)

interface HeadlessJob {
  /** pick an unfinished project up where it stopped instead of starting a new video (prompt is then ignored) */
  resume?: string
  prompt: string
  platform?: GenerateOptions['platform']
  style?: GenerateOptions['styleHint']
  programmatic?: boolean
  sceneCount?: number
  sceneSec?: number
}

/**
 * Make videos without a window, straight through the app's own wiring (keys,
 * roles, media engines) — the parallel-job path, several jobs at once.
 * For testing: `npx electron . --headless-gen=request.json`; results land in
 * headless-result.json next to the working directory.
 */
async function runHeadless(file: string): Promise<void> {
  loadSettings()
  account.reload()
  await account.sync().catch((err) => console.warn('[headless] account sync failed —', err instanceof Error ? err.message : err))
  const req = JSON.parse(readFileSync(file, 'utf8')) as { jobs: HeadlessJob[]; media?: Partial<Settings['media']>; dryRun?: boolean }
  // in memory only (nothing here saves settings): a request may pin media engines to bound the cost of a test
  if (req.media) settings.media = { ...settings.media, ...req.media }
  // the test videos run on the user's own engine, never counted
  if (planEnt()?.allowOwnKeys ?? false) settings.useOwnKeys = true
  applyAccess()
  console.log(`[headless] userData=${app.getPath('userData')} signedIn=${account.signedIn} entitlements=${Boolean(planEnt())} allowOwnKeys=${planEnt()?.allowOwnKeys} useOwnKeys=${settings.useOwnKeys} storedKeys=${Object.keys(settings.keys).join(',')}`)
  console.log(`[headless] mode=${mode} writer=${effective.provider} image=${effective.media.image} voice=${effective.media.voice} music=${effective.media.music} video=${effective.media.video}`)
  console.log(`[headless] roles: text=${providerRegistry.forRole('text')?.id ?? '-'} code=${providerRegistry.forRole('code')?.id ?? '-'} vision=${providerRegistry.forRole('image-process')?.id ?? '-'} painter=${providerRegistry.imageProvider()?.id ?? '-'}`)
  if (req.dryRun) return
  // a test of the user's own engine must never quietly fall back to the free one
  if (mode !== 'own-keys') throw new Error(`own-keys mode is not active (mode=${mode}) — the videos would be made on the free engine`)
  const started = Date.now()
  const results = await Promise.all(
    req.jobs.map(
      (j) =>
        new Promise<{ ok: boolean; output?: string; projectId?: string | null; error?: string }>((resolve) => {
          let settled = false
          const finish = (r: { ok: boolean; output?: string; projectId?: string | null; error?: string }) => {
            if (!settled) {
              settled = true
              resolve(r)
            }
          }
          const tap = (ev: unknown, projectId?: string) => {
            const e = ev as { stage: string; status?: string; output?: string; error?: string; projectId?: string | null }
            if (e.stage === 'done') finish({ ok: true, output: e.output, projectId: projectId ?? e.projectId })
            if (e.stage === 'pipeline' && (e.status === 'failed' || e.status === 'cancelled')) finish({ ok: false, error: e.error ?? e.status, projectId: projectId ?? e.projectId })
          }
          if (j.resume) {
            const id = j.resume
            const start = editJob('resume', id, (run, onEvent) =>
              run.orch
                .resume(id, { quality: settings.quality, gpu: settings.allowGpu, craft: settings.craft, onEvent: (ev) => { onEvent(ev); tap(ev, id) } })
                .catch((err) => {
                  finish({ ok: false, error: String(err), projectId: id })
                  throw err
                })
            )
            if (!start.ok) finish({ ok: false, error: start.error })
            return
          }
          void startGenerate(
            {
              prompt: j.prompt,
              platform: j.platform ?? 'tiktok',
              styleHint: j.style,
              shapeLocked: true,
              durationHintSec: j.sceneCount && j.sceneSec ? j.sceneCount * j.sceneSec : undefined,
              sceneCount: j.sceneCount,
              sceneSec: j.sceneSec,
              programmatic: j.programmatic !== false
            },
            (ev) => tap(ev)
          ).then((start) => {
            if (!start.ok) finish({ ok: false, error: start.error })
          })
        })
    )
  )
  for (const [i, r] of results.entries()) console.log(`[headless] job ${i + 1}: ${r.ok ? `OK → ${r.output}` : `FAILED — ${r.error}`}`)
  writeFileSync(join(process.cwd(), 'headless-result.json'), JSON.stringify({ tookMs: Date.now() - started, results }, null, 2))
}

if (headlessFile) {
  app.whenReady().then(async () => {
    try {
      await runHeadless(headlessFile)
    } catch (err) {
      console.error('[headless]', err)
      writeFileSync(join(process.cwd(), 'headless-result.json'), JSON.stringify({ error: String(err) }, null, 2))
      process.exitCode = 1
    } finally {
      app.exit(0)
    }
  })
} else {
  app.whenReady().then(() => {
    // fresh installs download the renderer's Chrome once; start before the first job
    void ensureBrowser()
    loadSettings()
    account.reload()
    applyAccess()
    // refresh the plan in the background; offline keeps the last one for display
    void account.sync().catch((err) => console.warn('[account] sync failed', err instanceof Error ? err.message : err))
    registerIpc()
    registerAssetIpc({ library, router: media, key: keyOf, isBusy: busyNow })
    registerBrandIpc(brands)
    registerReferenceIpc()
    registerFootageIpc({
      store: footageStore,
      service: footage,
      isBusy: busyNow,
      setBusy: (b) => { footageBusy = b },
      emit,
      window: () => win,
      aiJob: (projectKey, title, fn) => {
        if (mode === 'programmatic') return Promise.reject(new Error(account.signedIn ? (planEnt()?.aiBlockedReason || 'AI is not available on this account.') : 'Sign in to use AI on your footage.'))
        return withAccess({ projectKey, programmatic: false, title }, fn)
      }
    })
    appReconStore.markInterrupted()
    registerAppReconIpc({
      store: appReconStore,
      gemini: () => (providerRegistry.hasKey('gemini') ? (providerRegistry.get('gemini') as unknown as GeminiProvider) : null),
      emit,
      window: () => win,
      isBusy: busyNow,
      setBusy: (b) => { footageBusy = b },
      brand: (id) => {
        const kit = brands.get(id)
        if (!kit) return null
        const primary = kit.colors.primary
        // a very dark brand colour would vanish on the dark card, so it is left out (the card keeps its own accent)
        const accent = primary && luminanceOf(primary) >= 0.08 ? primary.replace('#', '') : undefined
        return { accent, logo: brands.logoPath(id, 'onDark') ?? undefined }
      },
      // the free engine always works; the AI writer and voice follow the plan, like every other AI feature
      ai: () =>
        mode === 'programmatic'
          ? { available: false, reason: account.signedIn ? (planEnt()?.aiBlockedReason || 'AI is not available on this account.') : 'Sign in, or add your own keys, to use the AI writer and voice.' }
          : { available: true },
      providers: () => {
        const chat = providerRegistry.forRole('text')
        let speech: ReturnType<typeof media.speech> | null = null
        try {
          speech = mode === 'programmatic' ? null : media.speech()
        } catch {
          speech = null
        }
        return { chat: chat && chat.id !== 'mock' ? chat : null, speech }
      },
      aiJob: (projectKey, title, fn) => {
        if (mode === 'programmatic') return Promise.reject(new Error('AI is not available on this account.'))
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
}

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // a headless run has no main window: the hidden helper windows (storyboard
  // captures, coded-scene renders) open and close while jobs are still going,
  // and must not take the app down with them — runHeadless exits when done
  if (headlessFile) return
  if (process.platform !== 'darwin') app.quit()
})
