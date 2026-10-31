import { spawn } from 'node:child_process'
import { ffmpegBin } from '../audio/pcm'

export interface FfmpegRun {
  /** estimated output length, so `-progress` can be turned into a percentage */
  totalSec?: number
  onProgress?: (pct: number) => void
  isCancelled?: () => boolean
  /** keep stdout (e.g. for image2pipe) */
  collectStdout?: boolean
}

export interface FfmpegResult {
  code: number
  stderr: string
  stdout: Buffer
}

/** Runs the bundled ffmpeg without blocking the app; resolves with its output instead of throwing. */
export function runFfmpeg(args: string[], opts: FfmpegRun = {}): Promise<FfmpegResult> {
  return new Promise((resolve) => {
    const progress = opts.onProgress && opts.totalSec ? ['-progress', 'pipe:1', '-nostats'] : []
    const child = spawn(ffmpegBin(), ['-hide_banner', ...progress, ...args], { windowsHide: true })
    let stderr = ''
    const out: Buffer[] = []
    let lineBuf = ''
    let cancelledTimer: NodeJS.Timeout | undefined
    if (opts.isCancelled) {
      cancelledTimer = setInterval(() => {
        if (opts.isCancelled?.()) child.kill()
      }, 300)
    }
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-24_000)
    })
    child.stdout.on('data', (d: Buffer) => {
      if (opts.collectStdout) {
        out.push(d)
        return
      }
      lineBuf += d.toString()
      const lines = lineBuf.split(/\r?\n/)
      lineBuf = lines.pop() ?? ''
      for (const line of lines) {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line)
        if (m && opts.totalSec && opts.onProgress) {
          // both keys are microseconds despite the name
          opts.onProgress(Math.max(0, Math.min(99, Math.round((Number(m[1]) / 1e6 / opts.totalSec) * 100))))
        }
      }
    })
    child.on('error', (err) => {
      if (cancelledTimer) clearInterval(cancelledTimer)
      resolve({ code: -1, stderr: String(err), stdout: Buffer.alloc(0) })
    })
    child.on('close', (code) => {
      if (cancelledTimer) clearInterval(cancelledTimer)
      resolve({ code: code ?? -1, stderr, stdout: Buffer.concat(out) })
    })
  })
}

/** the last useful line of an ffmpeg error, for showing to people */
export function ffmpegReason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^(ffmpeg version|built with|configuration:|lib\w+\s)/.test(l))
  return (lines.at(-1) ?? 'ffmpeg failed').slice(0, 240)
}
