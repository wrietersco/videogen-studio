import { spawnSync } from 'node:child_process'
import { ffmpegBin } from '../audio/pcm'

/** duration and frame size of any media file (ffmpeg's own banner, no ffprobe needed) */
export function probe(file: string): { durationSec?: number; width?: number; height?: number } {
  const res = spawnSync(ffmpegBin(), ['-hide_banner', '-i', file], { encoding: 'utf8' })
  const text = res.stderr ?? ''
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(text)
  const v = /Video: .*?(\d{2,5})x(\d{2,5})/.exec(text)
  return {
    durationSec: d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : undefined,
    width: v ? parseInt(v[1], 10) : undefined,
    height: v ? parseInt(v[2], 10) : undefined
  }
}

/** the final frame of a video as a full-size JPEG — the starting picture for the next shot in a sequence */
export function lastFrame(file: string): Buffer | null {
  const res = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-sseof', '-0.2', '-i', file, '-update', '1', '-frames:v', '1', '-q:v', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
    { maxBuffer: 1 << 26 }
  )
  return res.status === 0 && res.stdout?.length ? (res.stdout as Buffer) : null
}

/** stitch clips into one mp4, in order (re-encoded so differing clips join cleanly) */
export function joinClips(files: string[], out: string): void {
  const withAudio = files.every((f) => /Audio:/.test(spawnSync(ffmpegBin(), ['-hide_banner', '-i', f], { encoding: 'utf8' }).stderr ?? ''))
  const inputs = files.flatMap((f) => ['-i', f])
  const pads = files.map((_, i) => `[${i}:v]${withAudio ? `[${i}:a]` : ''}`).join('')
  const graph = `${pads}concat=n=${files.length}:v=1:a=${withAudio ? 1 : 0}[v]${withAudio ? '[a]' : ''}`
  const res = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-y', ...inputs, '-filter_complex', graph, '-map', '[v]', ...(withAudio ? ['-map', '[a]', '-c:a', 'aac'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', out],
    { encoding: 'utf8' }
  )
  if (res.status !== 0) throw new Error(`joining the shots failed: ${res.stderr?.slice(0, 300)}`)
}

/** a small JPEG poster frame for a video */
export function videoPoster(file: string, atSec = 1): Buffer | null {
  const res = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
    { maxBuffer: 1 << 24 }
  )
  return res.status === 0 && res.stdout?.length ? (res.stdout as Buffer) : null
}
