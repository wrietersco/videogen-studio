import electronModule from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { z } from 'zod'
import { appRoot } from '../../paths'
import { OVERLAY_EFFECTS, type OverlayEffect, type OverlayPlan } from '../../../shared/footage'

/**
 * Overlay effects — HTML/CSS/JS templates rendered to transparent PNG frame
 * sequences by the same sandboxed offscreen-BrowserWindow pattern the canvas
 * scenes use (director/canvasCode.ts). The templates are trusted app code but
 * still run inside a sandboxed iframe with a dedicated session that denies
 * every request except the host file itself, so a bad template can never reach
 * the network, the disk or Node.
 */

const electron = electronModule as unknown as Partial<typeof import('electron')>

/** where the self-contained effect templates live, in every app layout */
export function overlayTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'templates'), // source tree: tests and the tsx CLI
    resolve(appRoot, 'resources', 'overlays', 'templates'), // packaged app resources
    resolve(appRoot, 'src', 'main', 'footage', 'overlays', 'templates') // electron-vite dev server
  ]
  for (const dir of candidates) if (existsSync(dir)) return dir
  return candidates[0]
}

function templateFor(effect: OverlayEffect): string {
  const file = join(overlayTemplatesDir(), `${effect}.html`)
  try {
    return readFileSync(file, 'utf8')
  } catch {
    throw new Error(`the ${effect} template file could not be read`)
  }
}

// ---------------------------------------------------------------- params

const content = z.string().trim().min(1).max(160)
const optionalContent = z.string().trim().max(160).optional()
const hexColor = z
  .string()
  .trim()
  .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'a hex colour like #2bd4c4')

/** what each effect accepts (required/optional), strings trimmed to ≤160 chars, numbers finite */
export const OVERLAY_PARAMS: Record<OverlayEffect, z.ZodObject> = {
  lowerThird: z.object({ name: content, role: optionalContent }),
  refCard: z.object({ title: content, text: content }),
  chapterTitle: z.object({ text: content }),
  quoteBand: z.object({ text: content }),
  statChip: z.object({ stat: z.union([content, z.number().finite()]), label: content }),
  emotionAccent: z.object({ emotion: content, color: hexColor.optional() })
}

/** parse + normalize one overlay's params; throws a friendly Error on a missing required field */
export function validateOverlay(plan: OverlayPlan): OverlayPlan {
  const schema = OVERLAY_PARAMS[plan.effect]
  if (!schema) throw new Error(`"${plan.effect}" is not a known overlay effect`)
  const raw = (plan.params ?? {}) as Record<string, unknown>
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ...plan, params: parsed.data as Record<string, string | number> }
  const issue = parsed.error.issues[0]
  const field = issue && issue.path.length ? String(issue.path[0]) : 'content'
  const article = /^[aeiou]/i.test(field) ? 'an' : 'a'
  // a required string that is absent or empty after trimming counts as missing
  const missing = issue?.code === 'invalid_type' || raw[field] === undefined || (issue?.code === 'too_small' && typeof raw[field] === 'string')
  throw new Error(missing ? `it needs ${article} ${field}` : `its ${field} is not valid (${issue?.message ?? 'not accepted'})`)
}

/** true only when this process can open an Electron BrowserWindow (the desktop app, not tests/CLI) */
export function canRenderOverlays(): boolean {
  return typeof electron.BrowserWindow === 'function' && typeof electron.session === 'function'
}

// ---------------------------------------------------------------- sandbox rendering

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/** JSON that cannot break out of the <script> we inject it into */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function buildChildDoc(template: string, inject: string, glue: string): string {
  // params/meta must exist before the template's own script runs: put them first in <head>
  let doc = /<head[^>]*>/i.test(template) ? template.replace(/<head[^>]*>/i, (m) => m + inject) : inject + template
  doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>/i, () => glue + '</body>') : doc + glue
  return doc
}

export interface OverlayFrameOpts {
  effect: OverlayEffect
  params: Record<string, string | number>
  width: number
  height: number
  durationSec: number
  outDir: string
  cancelled?: () => boolean
}

/** overlay inputs also have to be one of the known effects */
const isEffect = (value: string): value is OverlayEffect => (OVERLAY_EFFECTS as readonly string[]).includes(value)

/**
 * Renders one overlay effect to outDir/00000.png… at 30 fps. The template runs
 * in a sandboxed iframe inside a hidden offscreen window; the host only accepts
 * PNG data-URL frames, and every frame is checked for the PNG magic.
 */
export async function renderOverlayFrames(opts: OverlayFrameOpts): Promise<void> {
  const { BrowserWindow, session } = electron
  if (typeof BrowserWindow !== 'function' || !session) throw new Error('Overlays can only be made in the desktop app')
  const { effect, params, width, height, outDir } = opts
  if (!isEffect(effect)) throw new Error(`"${String(effect)}" is not a known overlay effect`)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 1920 || height > 1920) {
    throw new Error(`the ${effect} overlay is too large to render`)
  }
  if (!Number.isFinite(opts.durationSec) || opts.durationSec <= 0) throw new Error(`the ${effect} overlay has no time on screen`)
  const duration = Math.min(opts.durationSec, 12)
  const template = templateFor(effect)

  const inject =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">` +
    `<script>window.__params=${jsonForScript(params)};window.__meta=${jsonForScript({ width, height, durationSec: duration })};</script>`
  const glue = `<script>(function(){
  addEventListener('message', function (e) {
    if (e.source !== parent || !e.data || e.data.kind !== 'render') return
    try {
      if (typeof window.renderAt !== 'function') throw new Error('the overlay did not define renderAt')
      window.renderAt(e.data.t)
      var canvas = document.querySelector('canvas')
      if (!canvas) throw new Error('the overlay has no canvas')
      parent.postMessage({ kind: 'frame', id: e.data.id, png: canvas.toDataURL('image/png') }, '*')
    } catch (err) {
      parent.postMessage({ kind: 'frame', id: e.data.id, error: String(err && err.message ? err.message : err) }, '*')
    }
  })
  function ready() { parent.postMessage({ kind: 'ready' }, '*') }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', ready)
  else ready()
})()</script>`
  const child = buildChildDoc(template, inject, glue)
  const childAttr = child.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const host = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'"><iframe id="worker" sandbox="allow-scripts" srcdoc="${childAttr}"></iframe><script>
const frame=document.getElementById('worker');let ready=false,seq=0;const pending=new Map();
addEventListener('message',e=>{if(e.source!==frame.contentWindow||!e.data)return;if(e.data.kind==='ready'){ready=true;return}if(e.data.kind==='frame'){const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.png)}});
window.isReady=()=>ready;window.render=t=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});frame.contentWindow.postMessage({kind:'render',t,id},'*')});</script>`

  const temp = mkdtempSync(join(tmpdir(), 'vg-overlay-'))
  const hostPath = join(temp, 'host.html')
  const hostUrl = pathToFileURL(hostPath).href
  const partition = session.fromPartition(`footage-overlay-${randomUUID()}`)
  partition.webRequest.onBeforeRequest({ urls: ['*://*/*', 'file://*/*'] }, (details, callback) => callback({ cancel: details.url !== hostUrl }))
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  const win = new BrowserWindow({
    show: false,
    width: 32,
    height: 32,
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  let completed = false
  try {
    writeFileSync(hostPath, host)
    try {
      await timeout(win.loadFile(hostPath), 15000, 'Overlay sandbox startup')
    } catch (err) {
      throw new Error(`Could not start the overlay sandbox: ${String((err as Error)?.message ?? err).split(' loading ')[0].slice(0, 160)}`)
    }
    const ready = await timeout(
      win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100;i++){if(window.isReady())return true;await new Promise(r=>setTimeout(r,50))}return false})()`),
      8000,
      'Overlay sandbox readiness'
    )
    if (!ready) throw new Error(`the ${effect} overlay did not start`)
    mkdirSync(outDir, { recursive: true })
    const fps = 30
    const frames = Math.max(1, Math.ceil(duration * fps))
    for (let i = 0; i < frames; i++) {
      if (opts.cancelled?.()) throw new Error(`the ${effect} overlay was cancelled`)
      const image = await timeout(win.webContents.executeJavaScript(`window.render(${(i / fps).toFixed(6)})`), 5000, 'Overlay frame')
      if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,') || image.length > 30000000) throw new Error(`the ${effect} overlay produced an invalid frame`)
      const buffer = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64')
      if (buffer.length < 100 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error(`the ${effect} overlay produced an invalid image`)
      writeFileSync(join(outDir, `${String(i).padStart(5, '0')}.png`), buffer)
    }
    completed = true
  } finally {
    if (!win.isDestroyed()) {
      if (!completed) {
        try {
          win.webContents.forcefullyCrashRenderer()
        } catch {
          /* already gone */
        }
      }
      win.destroy()
    }
    rmSync(temp, { recursive: true, force: true })
  }
}
