import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { VIDEO_EXTENSIONS, type FootageClip, type FootageShot } from '../../shared/footage'
import { runFfmpeg, ffmpegReason } from './ffmpeg'

/** Reads the person's footage (never writes next to it): lists files, probes them, finds the shots. */

const SKIP_DIRS = new Set(['node_modules', '$recycle.bin', 'system volume information', '.git'])
const MAX_FILES = 5000
const MAX_DEPTH = 8
/** longer clips are split into fixed windows instead of running scene detection over the whole file */
const SCENE_DETECT_MAX_SEC = 300
const MIN_SHOT_SEC = 1.5
const MAX_SHOT_SEC = 15

export function clipIdFor(path: string): string {
  return createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 12)
}

/** every video file under the folders, depth-first and sorted, so the same folder always lists the same way */
export function listVideoFiles(folders: string[]): Array<{ path: string; folder: string }> {
  const found: Array<{ path: string; folder: string }> = []
  const seen = new Set<string>()
  const exts = new Set<string>(VIDEO_EXTENSIONS)
  const walk = (dir: string, root: string, depth: number): void => {
    if (found.length >= MAX_FILES || depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    } catch {
      return // unreadable folder: skip it, keep going
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return
      if (e.name.startsWith('.') || e.name.startsWith('~$')) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name.toLowerCase())) walk(full, root, depth + 1)
      } else if (e.isFile() && exts.has(extname(e.name).toLowerCase())) {
        const key = full.toLowerCase()
        if (!seen.has(key)) {
          seen.add(key)
          found.push({ path: full, folder: root })
        }
      }
    }
  }
  for (const root of folders) walk(root, root, 0)
  return found
}

export interface Probe {
  durationSec: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

/** parses ffmpeg's own banner: duration, size with rotation applied, fps, audio */
export function parseProbe(text: string): Probe | null {
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(text)
  const v = /Video: .*?(\d{2,5})x(\d{2,5})/.exec(text)
  if (!d || !v) return null
  let width = parseInt(v[1], 10)
  let height = parseInt(v[2], 10)
  const rot = /rotation of (-?[\d.]+) degrees/.exec(text)
  if (rot && Math.abs(Math.round(parseFloat(rot[1]) / 90)) % 2 === 1) [width, height] = [height, width]
  const fps = /(\d+(?:\.\d+)?) fps/.exec(text)
  return {
    durationSec: +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]),
    width,
    height,
    fps: fps ? Math.round(parseFloat(fps[1]) * 100) / 100 : 30,
    hasAudio: /Stream #\d+:\d+.*Audio:/.test(text)
  }
}

export async function probeFile(path: string): Promise<Probe | null> {
  const res = await runFfmpeg(['-i', path])
  return parseProbe(res.stderr)
}

/** integrated loudness of a clip's sound in LUFS (null when silent or unmeasurable) */
export async function measureLufs(path: string): Promise<number | null> {
  const res = await runFfmpeg(['-i', path, '-vn', '-af', 'loudnorm=print_format=json', '-f', 'null', '-'])
  const json = res.stderr.slice(res.stderr.lastIndexOf('{'), res.stderr.lastIndexOf('}') + 1)
  try {
    const v = parseFloat((JSON.parse(json) as { input_i: string }).input_i)
    return Number.isFinite(v) && v > -70 ? Math.round(v * 10) / 10 : null
  } catch {
    return null
  }
}

/** timestamps where the picture cuts to something else */
export async function detectCuts(path: string, durationSec: number): Promise<number[]> {
  if (durationSec > SCENE_DETECT_MAX_SEC) return []
  const res = await runFfmpeg(['-i', path, '-an', '-vf', "fps=4,scale=320:-2,select='gt(scene,0.32)',showinfo", '-f', 'null', '-'])
  const cuts: number[] = []
  for (const m of res.stderr.matchAll(/pts_time:([\d.]+)/g)) cuts.push(parseFloat(m[1]))
  return cuts
}

/** shots between the cuts: very short ones merge into a neighbour, very long ones are split evenly */
export function buildShots(durationSec: number, cuts: number[]): Array<{ startSec: number; endSec: number }> {
  const points = [0, ...cuts.filter((c) => c > 0.2 && c < durationSec - 0.2), durationSec].sort((a, b) => a - b)
  let spans: Array<{ startSec: number; endSec: number }> = []
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i + 1] - points[i] > 0.01) spans.push({ startSec: points[i], endSec: points[i + 1] })
  }
  const merged: typeof spans = []
  for (const s of spans) {
    const prev = merged.at(-1)
    if (prev && s.endSec - s.startSec < MIN_SHOT_SEC) prev.endSec = s.endSec
    else merged.push({ ...s })
  }
  if (merged.length > 1 && merged[0].endSec - merged[0].startSec < MIN_SHOT_SEC) {
    merged[1].startSec = merged[0].startSec
    merged.shift()
  }
  spans = []
  for (const s of merged) {
    const len = s.endSec - s.startSec
    const parts = Math.max(1, Math.ceil(len / MAX_SHOT_SEC))
    for (let p = 0; p < parts; p++) spans.push({ startSec: s.startSec + (len * p) / parts, endSec: s.startSec + (len * (p + 1)) / parts })
  }
  return spans.map((s) => ({ startSec: round2(s.startSec), endSec: round2(s.endSec) }))
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** a small JPEG of the picture at a moment, as a file */
export async function extractFrame(path: string, atSec: number, out: string, width = 512): Promise<boolean> {
  const res = await runFfmpeg(['-v', 'error', '-y', '-ss', String(Math.max(0, atSec)), '-i', path, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '5', out])
  return res.code === 0 && existsSync(out)
}

/** a small JPEG of the picture at a moment, in memory */
export async function frameBuffer(path: string, atSec: number, width = 256): Promise<Buffer | null> {
  const res = await runFfmpeg(['-v', 'error', '-ss', String(Math.max(0, atSec)), '-i', path, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '6', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'], { collectStdout: true })
  return res.code === 0 && res.stdout.length ? res.stdout : null
}

/**
 * Probe one file and cut it into shots with a keyframe each. Failure yields an
 * 'unreadable' record (kept so the person sees which file was skipped and why).
 */
export async function scanClip(file: { path: string; folder: string }, projectDir: string): Promise<FootageClip> {
  const st = statSync(file.path)
  const id = clipIdFor(file.path)
  const base: FootageClip = {
    id,
    path: file.path,
    name: basename(file.path),
    folder: file.folder,
    sizeBytes: st.size,
    mtimeMs: Math.round(st.mtimeMs),
    durationSec: 0,
    width: 0,
    height: 0,
    fps: 30,
    hasAudio: false,
    shots: [],
    watched: false,
    listened: false,
    status: 'unreadable'
  }
  const probe = await probeFile(file.path)
  if (!probe || probe.durationSec < 0.3) return { ...base, error: 'This file could not be read as a video.' }
  const framesDir = join(projectDir, 'frames')
  mkdirSync(framesDir, { recursive: true })
  const [lufs, cuts] = await Promise.all([probe.hasAudio ? measureLufs(file.path) : Promise.resolve(null), detectCuts(file.path, probe.durationSec)])
  const spans = buildShots(probe.durationSec, cuts)
  const shots: FootageShot[] = []
  for (let i = 0; i < spans.length; i++) {
    const mid = (spans[i].startSec + spans[i].endSec) / 2
    const out = join(framesDir, `${id}-${i}.jpg`)
    const ok = await extractFrame(file.path, Math.min(mid, probe.durationSec - 0.1), out)
    shots.push({ ...spans[i], ...(ok ? { frame: relative(projectDir, out).replace(/\\/g, '/') } : {}) })
  }
  const speechless = !probe.hasAudio || lufs === null
  return {
    ...base,
    ...probe,
    ...(lufs !== null ? { lufs } : {}),
    shots,
    // nothing to listen to: no need to ever transcribe
    listened: speechless,
    status: 'ok'
  }
}

export { ffmpegReason }
