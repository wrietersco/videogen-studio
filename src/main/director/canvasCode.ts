import electronModule from 'electron'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import sharp from 'sharp'
import { appRoot } from '../paths'
import type { LLMProvider } from '../providers/types'
import type { VideoSpec } from '@shared/spec'

const electron = electronModule as unknown as Partial<typeof import('electron')>

/** Decide whether code-driven motion adds meaning beyond a static vector illustration. */
export async function needsCanvasCode(provider: LLMProvider, spec: VideoSpec, sceneId: string, prompt: string): Promise<boolean> {
  try {
    const result = await provider.generateJSON<{ useCode: boolean; reason: string }>({
      system: 'Decide whether this scene needs an original time-varying coded animation or simulation that cannot be communicated as an ordinary static illustration. A 2D canvas program can draw shapes, text, particles and procedural visuals, optionally over the scene’s already selected photo. It can use the provided moving footage as assets.background, but cannot load external resources. Prefer footage and photos for real-world processes. Return false for a static chart or simple illustration.',
      prompt: JSON.stringify({ brief: prompt, scene: spec.scenes.find(s => s.id === sceneId), narration: spec.narration.find(n => n.sceneId === sceneId)?.text }),
      schemaName: 'CodeSceneDecision', jsonSchema: { type: 'object', properties: { useCode: { type: 'boolean' }, reason: { type: 'string' } }, required: ['useCode', 'reason'], additionalProperties: false }, temperature: 0.2, maxTokens: 400
    })
    return result.useCode === true
  } catch { return false }
}

/** The configured writing model authors the draw function; time is supplied by the renderer. */
export async function authorCanvasCode(provider: LLMProvider, spec: VideoSpec, prompt: string, sceneId: string, feedback?: string, previousCode?: string, backgroundJpeg?: Buffer, previousFrame?: Buffer, backgroundIsVideo = false, continuityFrame?: Buffer): Promise<string> {
  const scene = spec.scenes.find(s => s.id === sceneId)
  if (!scene) throw new Error('Unknown scene')
  const hasBackground = Boolean(backgroundJpeg)
  const backgroundDescription = backgroundIsVideo ? 'moving footage frame' : 'photograph'
  const references = [backgroundJpeg ? { label: `selected background ${backgroundDescription}`, buffer: backgroundJpeg } : null, previousFrame ? { label: 'previous candidate frame to revise', buffer: previousFrame } : null, continuityFrame ? { label: 'approved previous scene for visual continuity', buffer: continuityFrame } : null].filter((x): x is { label: string; buffer: Buffer } => x !== null)
  const images = references.length ? references.map(x => ({ mimeType: 'image/jpeg', base64: x.buffer.toString('base64') })) : undefined
  let motionPlan: unknown
  try {
    motionPlan = await provider.generateJSON({
      system: 'Plan the visual action for a short coded animation. Describe what moves and what changes at the beginning, middle and end, in a way a phone viewer can clearly see. The motion must explain this scene rather than merely decorate it. If a photo background is provided, keep its key subject visible and describe where the graphics can fit without blocking it. If an approved previous scene is supplied, retain the same emblem, character, product identity and visual style where the brief calls for continuity. Address the reviewer feedback. Return concise, concrete instructions.',
      prompt: JSON.stringify({ brief: prompt, scene, narration: spec.narration.find(n => n.sceneId === sceneId)?.text, hasBackground, imageOrder: references.map(x => x.label), feedback }),
      schemaName: 'CustomMotionPlan', jsonSchema: { type: 'object', properties: { beginning: { type: 'string' }, middle: { type: 'string' }, end: { type: 'string' }, photoUse: { type: 'string' } }, required: ['beginning', 'middle', 'end', 'photoUse'], additionalProperties: false }, images, temperature: 0.3, maxTokens: 500
    })
  } catch { /* write from the brief and reviewer notes if planning is unavailable */ }
  const request = {
    system: 'Write the BODY of a JavaScript function draw(ctx,t,w,h,assets) for a bespoke professional animated video scene. ctx is a CanvasRenderingContext2D; t is seconds since this scene starts; w and h are canvas dimensions. If assets.background exists it is the preloaded photo or current frame of the moving footage chosen for this scene. Always draw it as the full-frame background when backgroundIsVideo is true, preserving its movement and keeping its subject unobstructed; place custom motion on top. Draw the entire frame every call. Make the requested action visibly change at the beginning, middle and end: do not substitute a static diagram or tiny decorative particles for meaningful motion. Everything must be a deterministic function of t: no random, timers, animation frame, network, storage, DOM access or loading assets. Do not use external packages or load images or video. Use canvas 2D shapes, gradients, paths and text. Use scene-specific visual storytelling, not a generic title slide. When a previous approved scene is supplied, preserve the identity and appearance of its recurring emblem, character or product while advancing the action. Keep important content inside the frame. Return only JavaScript statements, no function wrapper or markdown.',
    prompt: JSON.stringify({ brief: prompt, scene, narration: spec.narration.find(n => n.sceneId === sceneId)?.text, palette: spec.palette, hasBackground, backgroundIsVideo, imageOrder: references.map(x => x.label), motionPlan, feedback, previousCode }),
    images, maxTokens: 7000, temperature: 0.6
  }
  let result: string
  try { result = await provider.generateText(request) } catch (err) {
    if (!images) throw err
    result = await provider.generateText({ ...request, images: undefined })
  }
  const code = result.replace(/^```(?:javascript|js)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  if (!code || code.length > 50000) throw new Error('Invalid custom code size')
  return code
}

function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms)
    promise.then(value => { clearTimeout(timer); resolvePromise(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

/**
 * Render untrusted model code in a sandboxed opaque-origin iframe, with Node
 * disabled and a dedicated in-memory Electron session denying all requests.
 * The host only accepts PNG frames. A watchdog crashes a stuck renderer.
 */
export async function renderCanvasCode(opts: { code: string; width: number; height: number; durationSec: number; output: string; backgroundJpeg?: Buffer; backgroundVideo?: string; cancelled?: () => boolean }): Promise<void> {
  const { BrowserWindow, session } = electron
  if (typeof BrowserWindow !== 'function' || !session) throw new Error('Custom code rendering requires the desktop app')
  const { code, width, height, durationSec, output } = opts
  if (!code || code.length > 50000 || !Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 20 || width < 1 || height < 1 || width > 1920 || height > 1920) throw new Error('Custom code render exceeds supported bounds')
  if (opts.backgroundJpeg && opts.backgroundJpeg.length > 10000000) throw new Error('Background image exceeds custom scene limit')
  const temp = mkdtempSync(join(tmpdir(), 'vg-code-frames-'))
  const hostPath = join(temp, 'host.html')
  const hostUrl = pathToFileURL(hostPath).href
  const partition = session.fromPartition(`custom-code-${randomUUID()}`)
  partition.webRequest.onBeforeRequest({ urls: ['*://*/*', 'file://*/*'] }, (details, callback) => callback({ cancel: details.url !== hostUrl }))
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  partition.setPermissionCheckHandler(() => false)
  const win = new BrowserWindow({ show: false, width: 32, height: 32, webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', event => event.preventDefault())
  const childCode = Buffer.from(code, 'utf8').toString('base64')
  const background = opts.backgroundJpeg?.toString('base64') ?? ''
  const child = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; img-src data:; style-src 'unsafe-inline'; connect-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'"><canvas id="canvas" width="${width}" height="${height}"></canvas><script>
const bytes=Uint8Array.from(atob('${childCode}'),c=>c.charCodeAt(0));
const source=new TextDecoder().decode(bytes); let draw, error='';
try { draw=new Function('ctx','t','w','h','assets',source) } catch(e) { error=String(e) }
const canvas=document.getElementById('canvas'),ctx=canvas.getContext('2d');
let background=null; const data='${background}';
addEventListener('message',async e=>{ if(e.source!==parent || !e.data || e.data.kind!=='draw') return; try { if(error) throw Error(error); let frameBackground=background; if(e.data.background){frameBackground=new Image();await new Promise((resolve,reject)=>{frameBackground.onload=resolve;frameBackground.onerror=()=>reject(Error('Video frame could not be loaded'));frameBackground.src='data:image/jpeg;base64,'+e.data.background})} canvas.width=canvas.width;draw(ctx,e.data.time,canvas.width,canvas.height,{background:frameBackground});parent.postMessage({kind:'frame',id:e.data.id,png:canvas.toDataURL('image/png')},'*') } catch(err){ parent.postMessage({kind:'frame',id:e.data.id,error:String(err)},'*') } });
if(data){background=new Image();background.onload=()=>parent.postMessage({kind:'ready'},'*');background.onerror=()=>{error='Background image could not be loaded';parent.postMessage({kind:'ready'},'*')};background.src='data:image/jpeg;base64,'+data}else parent.postMessage({kind:'ready'},'*');</script>`
  const childAttr = child.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const host = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; img-src data:; frame-src 'self'"><iframe id="worker" sandbox="allow-scripts" srcdoc="${childAttr}"></iframe><script>
const frame=document.getElementById('worker');let ready=false,seq=0,pending=new Map();
addEventListener('message',e=>{if(e.source!==frame.contentWindow||!e.data)return;if(e.data.kind==='ready'){ready=true;return}if(e.data.kind==='frame'){const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.png)}});
window.isReady=()=>ready;window.render=(time,background)=>new Promise((resolve,reject)=>{let id=++seq;pending.set(id,{resolve,reject});frame.contentWindow.postMessage({kind:'draw',id,time,background},'*')});</script>`
  let completed = false
  try {
    writeFileSync(hostPath, host)
    try { await timeout(win.loadFile(hostPath), 15000, 'Sandbox startup') } catch (err) { throw new Error(`Could not start the custom-code sandbox: ${String((err as Error)?.message ?? err).split(' loading ')[0].slice(0, 160)}`) }
    const ready = await timeout(win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<100;i++){if(window.isReady())return true;await new Promise(r=>setTimeout(r,50))}return false})()`), 8000, 'Sandbox readiness')
    if (!ready) throw new Error('Custom-code sandbox did not start')
    const fps = 15
    if (opts.backgroundVideo) {
      const ffmpeg = resolve(appRoot, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
      await new Promise<void>((resolvePromise, reject) => {
        const childProcess = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-stream_loop', '-1', '-i', opts.backgroundVideo!, '-t', String(durationSec), '-vf', `fps=${fps},scale=1080:1080:force_original_aspect_ratio=decrease`, '-q:v', '3', join(temp, 'background-%05d.jpg')], { windowsHide: true })
        let error = ''; const timer = setTimeout(() => childProcess.kill(), 120000)
        childProcess.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString().slice(0, 1000) })
        childProcess.on('error', err => { clearTimeout(timer); reject(err) })
        childProcess.on('close', code => { clearTimeout(timer); code === 0 ? resolvePromise() : reject(new Error(`Video background decoding failed: ${error.slice(-500)}`)) })
      })
    }
    const backgroundFrames = opts.backgroundVideo ? readdirSync(temp).filter(name => /^background-\d+\.jpg$/.test(name)).sort() : []
    if (opts.backgroundVideo && !backgroundFrames.length) throw new Error('Video background did not produce any frames')
    const renderAt = (time: number) => {
      const n = Math.min(Math.max(0, Math.floor(time * fps)), backgroundFrames.length - 1)
      const bg = opts.backgroundVideo ? readFileSync(join(temp, backgroundFrames[n])).toString('base64') : ''
      return `window.render(${time.toFixed(6)},${JSON.stringify(bg)})`
    }
    const frames = Math.max(1, Math.ceil(durationSec * fps))
    const deadline = Date.now() + 180000
    for (const t of [0, durationSec * 0.5]) {
      const script = renderAt(t)
      const first = await timeout(win.webContents.executeJavaScript(script), 5000, 'Custom frame')
      const second = await timeout(win.webContents.executeJavaScript(script), 5000, 'Custom frame')
      if (typeof first !== 'string' || first !== second) throw new Error('Custom scene is not deterministic at the same timeline time')
    }
    const samples: Buffer[] = []
    for (const fraction of [0.2, 0.55, 0.9]) {
      const frame = await timeout(win.webContents.executeJavaScript(renderAt(durationSec * fraction)), 5000, 'Custom frame')
      if (typeof frame !== 'string' || !frame.startsWith('data:image/png;base64,') || frame.length > 30000000) throw new Error('Invalid custom frame')
      samples.push(await sharp(Buffer.from(frame.slice('data:image/png;base64,'.length), 'base64')).resize(96, 96, { fit: 'fill' }).removeAlpha().raw().toBuffer())
    }
    const difference = (a: Buffer, b: Buffer) => { let total = 0; for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]); return total / a.length }
    if (Math.max(difference(samples[0], samples[1]), difference(samples[1], samples[2])) < 0.3) throw new Error('The custom animation shows too little visible change; make the requested process move clearly through the scene')
    for (let i = 0; i < frames; i++) {
      if (opts.cancelled?.()) throw new Error('Custom scene cancelled')
      if (Date.now() > deadline) throw new Error('Custom scene render exceeded time limit')
      const image = await timeout(win.webContents.executeJavaScript(renderAt(i / fps)), 5000, 'Custom frame')
      if (typeof image !== 'string' || !image.startsWith('data:image/png;base64,') || image.length > 30000000) throw new Error('Invalid custom frame')
      const buffer = Buffer.from(image.slice('data:image/png;base64,'.length), 'base64')
      if (buffer.length < 100 || buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Invalid custom PNG')
      writeFileSync(join(temp, `${String(i).padStart(5, '0')}.png`), buffer)
    }
    mkdirSync(resolve(output, '..'), { recursive: true })
    const ffmpeg = resolve(appRoot, 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    await new Promise<void>((resolvePromise, reject) => {
      const childProcess = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(temp, '%05d.png'), '-t', String(durationSec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], { windowsHide: true })
      let error = ''
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; childProcess.kill() }, 120000)
      childProcess.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString().slice(0, 1000) })
      childProcess.on('error', err => { clearTimeout(timer); reject(err) })
      childProcess.on('close', code => { clearTimeout(timer); timedOut ? reject(new Error('Custom scene encode timed out')) : code === 0 ? resolvePromise() : reject(new Error(`Custom scene encode failed: ${error.slice(-500)}`)) })
    })
    completed = true
  } finally {
    if (!win.isDestroyed()) { if (!completed) { try { win.webContents.forcefullyCrashRenderer() } catch {} } win.destroy() }
    rmSync(temp, { recursive: true, force: true })
  }
}
