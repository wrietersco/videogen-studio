import electronModule from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** BrowserWindow only exists inside the Electron runtime; CLI/tsx runs get a string export. */
const BrowserWindow = (electronModule as unknown as Partial<typeof import('electron')>).BrowserWindow

/**
 * Live storyboard captures — after compose, load the actual composition in a
 * hidden offscreen window, seek the paused GSAP timeline to each scene's
 * midpoint (dispatching hf-seek so 3D/count-ups render), screenshot the real
 * pixels, and stream JPEG previews to the UI while the render stage runs.
 * Previews only — the render pipeline itself is untouched.
 */

export interface ThumbWindow {
  id: string
  /** absolute seek time (seconds from film start) */
  t: number
}

export interface ThumbResult {
  index: number
  sceneId: string
  dataUrl: string
}

export interface CaptureOptions {
  width: number
  height: number
  isCancelled?: () => boolean
  onThumb: (r: ThumbResult) => void | Promise<void>
  /** overall budget — capture must never stall the pipeline */
  deadlineMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function captureSceneThumbs(
  projectDir: string,
  windows: ThumbWindow[],
  opts: CaptureOptions
): Promise<number> {
  // previews only work inside the Electron app; CLI/test runs skip gracefully
  if (typeof BrowserWindow !== 'function') {
    throw new Error('scene previews require the app runtime')
  }
  const thumbsDir = join(projectDir, 'thumbs')
  mkdirSync(thumbsDir, { recursive: true })
  const deadline = Date.now() + (opts.deadlineMs ?? 120_000)

  const win = new BrowserWindow({
    show: false,
    x: -3200,
    y: 0,
    width: opts.width,
    height: opts.height,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  try {
    await win.loadFile(join(projectDir, 'index.html'))
    // the composition registers window.__timelines.main after fonts load + autofit
    const ready = await win.webContents.executeJavaScript(
      `(async () => {
        for (let i = 0; i < 60; i++) {
          if (window.__timelines && window.__timelines['main']) return true
          await new Promise((r) => setTimeout(r, 250))
        }
        return false
      })()`
    )
    if (!ready) throw new Error('composition timeline never registered')

    let captured = 0
    for (let i = 0; i < windows.length; i++) {
      if (opts.isCancelled?.()) break
      if (Date.now() > deadline) break
      const w = windows[i]
      await win.webContents.executeJavaScript(
        `(() => {
          const tl = window.__timelines['main']
          tl.seek(${w.t}, true)
          window.dispatchEvent(new CustomEvent('hf-seek', { detail: { time: ${w.t} } }))
        })()`
      )
      await sleep(750) // let 3D scenes settle their first rendered frame
      const img = await win.webContents.capturePage()
      const scaled = img.getSize().width > 480 ? img.resize({ width: 480 }) : img
      const jpeg = scaled.toJPEG(80)
      if (jpeg.length === 0) continue
      writeFileSync(join(thumbsDir, `scene-${i + 1}.jpg`), jpeg)
      await opts.onThumb({ index: i, sceneId: w.id, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` })
      captured += 1
    }
    return captured
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
