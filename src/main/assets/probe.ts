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

/** a small JPEG poster frame for a video */
export function videoPoster(file: string, atSec = 1): Buffer | null {
  const res = spawnSync(
    ffmpegBin(),
    ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-vf', 'scale=360:-2', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'],
    { maxBuffer: 1 << 24 }
  )
  return res.status === 0 && res.stdout?.length ? (res.stdout as Buffer) : null
}
