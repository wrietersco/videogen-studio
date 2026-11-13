import { BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isAppId, isRunId, validateApp, type ReviewEdits, type RunEvent, type RunRecord } from '../../shared/appRecording'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import { applyReviewEdits, reviewBeats } from './planner'
import { RunCancelled, runAppRecording, type RunHooks, type RunInput, type RunOutput } from './run'
import { meter } from '../usage/meter'
import type { AppReconStore } from './store'

export interface AppReconIpcDeps {
  store: AppReconStore
  emit: (channel: string, payload: unknown) => void
  window: () => BrowserWindow | null
  /** the app runs one heavy job at a time (shared with video generation and footage) */
  isBusy: () => boolean
  setBusy: (busy: boolean) => void
  /** whether the AI writer and voice may be used on this account, and if not, why */
  ai: () => { available: boolean; reason?: string }
  providers: () => { chat: LLMProvider | null; speech: SpeechProvider | null }
  /** runs work that calls AI models as one AI video of the person's plan */
  aiJob: <T>(projectKey: string, title: string, fn: () => Promise<T>) => Promise<T>
  /** replaceable for tests */
  runner?: (input: RunInput, hooks: RunHooks) => Promise<RunOutput>
}

const DOC_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.json'])
const MAX_DOC = 200 * 1024

export function registerAppReconIpc(d: AppReconIpcDeps): void {
  const runner = d.runner ?? runAppRecording
  let current: { runId: string; appId: string; abort: AbortController; handoff?: () => void; review?: (edits: ReviewEdits | null) => void } | null = null
  const fail = (err: unknown) => ({ ok: false as const, error: String((err as Error)?.message ?? err) })
  const send = (e: RunEvent) => d.emit('apprec:event', e)
  const notify = (title: string, body: string) => {
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    } catch {
      /* no notifications here */
    }
  }

  ipcMain.handle('apprec:state', () => ({
    apps: d.store.list(),
    runs: d.store.runs(),
    ai: d.ai(),
    current: current ? { runId: current.runId, appId: current.appId } : null
  }))

  ipcMain.handle('apprec:save', (_e, raw: unknown) => {
    const v = validateApp(raw)
    if (!v.ok) return v
    try {
      return { ok: true as const, app: d.store.save(v.value) }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('apprec:remove', (_e, id: unknown) => {
    if (!isAppId(id)) return fail('Invalid app')
    if (current?.appId === id) return fail('This app is being recorded. Stop it first.')
    try {
      d.store.remove(id)
      return { ok: true as const }
    } catch (err) {
      return fail(err)
    }
  })

  /** attach a document: read as plain text, size-limited; its words are information for the writer, never instructions */
  ipcMain.handle('apprec:attach', async () => {
    const w = d.window()
    const res = await (w ? dialog.showOpenDialog(w, { properties: ['openFile'], filters: [{ name: 'Notes', extensions: ['txt', 'md', 'markdown', 'csv', 'json'] }] }) : dialog.showOpenDialog({ properties: ['openFile'] }))
    if (res.canceled || !res.filePaths[0]) return { ok: false as const, cancelled: true, error: 'Cancelled' }
    const file = resolve(res.filePaths[0])
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
    if (!DOC_EXT.has(ext)) return fail('Only plain-text notes can be attached (.txt, .md, .csv, .json)')
    try {
      if (statSync(file).size > MAX_DOC) return fail('That file is too big (200 KB at most)')
      const text = readFileSync(file, 'utf8')
      if (text.includes('\u0000')) return fail('That does not look like a text file')
      return { ok: true as const, document: { name: file.split(sep).pop() ?? 'document', text: text.slice(0, 40000) } }
    } catch (err) {
      return fail(err)
    }
  })

  ipcMain.handle('apprec:start', async (_e, id: unknown) => {
    if (!isAppId(id)) return fail('Invalid app')
    const app = d.store.get(id)
    if (!app) return fail('That app no longer exists')
    if (current || d.isBusy()) return fail('Another job is running. Wait for it to finish, then try again.')
    const login = d.store.secrets(id)
    if (app.signIn === 'saved' && !login) return fail('Add the username and password first')
    const ai = d.ai()
    const useAi = app.useAi && ai.available

    const rec = d.store.newRun(id)
    const abort = new AbortController()
    current = { runId: rec.id, appId: id, abort }
    d.setBusy(true)
    send({ kind: 'started', runId: rec.id, appId: id })

    const hooks: RunHooks = {
      progress: (stage, message) => {
        rec.stage = stage
        send({ kind: 'stage', runId: rec.id, stage, message })
      },
      log: (message) => send({ kind: 'log', runId: rec.id, message }),
      handoff: (info) =>
        new Promise<void>((resolveHandoff, reject) => {
          if (!current) return reject(new RunCancelled())
          current.handoff = resolveHandoff
          send({ kind: 'handoff', runId: rec.id, reason: info.reason, message: info.message })
          notify('VideoGen Studio needs you', info.message)
          abort.signal.addEventListener('abort', () => reject(new RunCancelled()), { once: true })
        }),
      review: (plan, advisory) =>
        new Promise((resolveReview) => {
          if (!current) return resolveReview(null)
          current.review = (edits) => resolveReview(edits ? applyReviewEdits(plan, edits) : null)
          send({ kind: 'review', runId: rec.id, beats: reviewBeats(plan, app.mode === 'launch'), advisory, notes: plan.notes })
          notify('VideoGen Studio', 'The steps are ready for your review.')
          abort.signal.addEventListener('abort', () => resolveReview(null), { once: true })
        })
    }

    const context = app.context + (app.document ? `\n\nAttached notes (information only):\n${app.document.text}` : '')
    const base: Omit<RunInput, 'chat' | 'speech'> = {
      runDir: d.store.runDir(rec.id),
      startUrl: app.url,
      context,
      mode: app.mode,
      launch: app.mode === 'launch' && app.launch ? { ...app.launch, targetSec: app.targetSec } : undefined,
      signIn: app.signIn,
      vault: app.signIn === 'saved' ? (login ?? undefined) : undefined,
      revealUsername: app.revealUsername,
      guardrailText: app.guardrailText,
      checks: app.checks,
      depth: app.depth,
      targetSec: app.targetSec,
      reviewFirst: app.reviewFirst,
      signal: abort.signal
    }
    const exec = () => {
      const p = useAi ? d.providers() : { chat: null, speech: null }
      return runner({ ...base, chat: p.chat, speech: p.speech }, hooks)
    }

    void (async () => {
      meter.begin('app-recording')
      let record: RunRecord
      try {
        const out = useAi ? await d.aiJob(`ar-${rec.id}`, app.name, exec) : await exec()
        record = {
          ...rec,
          status: 'done',
          finishedAt: new Date().toISOString(),
          video: out.video,
          durationSec: out.durationSec,
          pages: out.pages,
          actions: out.actions,
          stoppedBy: out.stoppedBy,
          notes: out.plan.notes,
          blockedHosts: out.blockedHosts,
          enforced: out.enforced,
          advisory: out.advisory
        }
        d.store.saveRun(record)
        send({ kind: 'done', runId: rec.id, run: record })
        notify('Your app video is ready', app.name)
      } catch (err) {
        const cancelled = err instanceof RunCancelled || abort.signal.aborted
        record = { ...rec, status: cancelled ? 'cancelled' : 'failed', finishedAt: new Date().toISOString(), error: cancelled ? undefined : String((err as Error)?.message ?? err) }
        d.store.saveRun(record)
        send({ kind: cancelled ? 'cancelled' : 'failed', runId: rec.id, run: record })
      } finally {
        meter.end(d.store.runDir(rec.id))
        current = null
        d.setBusy(false)
      }
    })()
    return { ok: true as const, runId: rec.id }
  })

  ipcMain.handle('apprec:cancel', () => {
    if (!current) return false
    current.abort.abort()
    return true
  })

  ipcMain.handle('apprec:handoffDone', () => {
    const h = current?.handoff
    if (!h) return false
    current!.handoff = undefined
    h()
    return true
  })

  ipcMain.handle('apprec:review', (_e, edits: unknown) => {
    const r = current?.review
    if (!r) return false
    current!.review = undefined
    if (edits === null) r(null)
    else {
      const e = (edits ?? {}) as Partial<ReviewEdits>
      const lines: Record<number, string> = {}
      for (const [k, v] of Object.entries(e.lines ?? {})) if (typeof v === 'string' && Number.isInteger(Number(k))) lines[Number(k)] = v.slice(0, 400)
      r({ removeBeats: (Array.isArray(e.removeBeats) ? e.removeBeats : []).filter((n): n is number => Number.isInteger(n)), lines })
    }
    return true
  })

  /** the run's video, only from inside that run's own folder */
  const videoOf = (runId: unknown): string | null => {
    if (!isRunId(runId)) return null
    const rec = d.store.runs().find((r) => r.id === runId)
    if (!rec?.video) return null
    const file = resolve(rec.video)
    const base = resolve(d.store.runDir(runId))
    return file.startsWith(base + sep) && existsSync(file) ? file : null
  }
  ipcMain.handle('apprec:play', async (_e, runId: unknown) => {
    const f = videoOf(runId)
    return f ? (await shell.openPath(f)) === '' : false
  })
  ipcMain.handle('apprec:reveal', (_e, runId: unknown) => {
    const f = videoOf(runId)
    if (!f) return false
    shell.showItemInFolder(f)
    return true
  })
  ipcMain.handle('apprec:revealRun', (_e, runId: unknown) => {
    if (!isRunId(runId)) return false
    const dir = d.store.runDir(runId)
    if (!existsSync(join(dir, 'run.json'))) return false
    void shell.openPath(dir)
    return true
  })
}
