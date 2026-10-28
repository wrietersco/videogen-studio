import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { appRoot } from '../paths'

/**
 * PCM plumbing for the audio stage: every sound is a Float32 buffer at one
 * sample rate; FFmpeg (bundled ffmpeg-static) only decodes takes and does the
 * final loudness pass. Everything in between is plain deterministic math.
 */

export const SR = 48_000

export interface Stereo {
  l: Float32Array
  r: Float32Array
}

export function stereo(seconds: number): Stereo {
  const n = Math.max(1, Math.ceil(seconds * SR))
  return { l: new Float32Array(n), r: new Float32Array(n) }
}

export function ffmpegBin(): string {
  const bin = resolve(appRoot, 'node_modules/ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  return existsSync(bin) ? bin : 'ffmpeg'
}

/** decode any audio file to mono float PCM at SR */
export function decodeMono(file: string): Float32Array {
  const res = spawnSync(ffmpegBin(), ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30
  })
  if (res.status !== 0) throw new Error(`ffmpeg decode failed: ${res.stderr?.toString().slice(0, 300)}`)
  const buf = res.stdout as Buffer
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}

/** add a mono source into a stereo bus at `atSec` with gain and pan (-1..1) */
export function mixIn(bus: Stereo, src: Float32Array, atSec: number, gain = 1, pan = 0): void {
  const off = Math.round(atSec * SR)
  const gl = gain * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2
  const gr = gain * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2
  const n = Math.min(src.length, bus.l.length - off)
  for (let i = Math.max(0, -off); i < n; i++) {
    bus.l[off + i] += src[i] * gl
    bus.r[off + i] += src[i] * gr
  }
}

/** 16-bit stereo WAV */
export function writeWav(file: string, bus: Stereo): void {
  const n = bus.l.length
  const out = Buffer.alloc(44 + n * 4)
  out.write('RIFF', 0)
  out.writeUInt32LE(36 + n * 4, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(2, 22)
  out.writeUInt32LE(SR, 24)
  out.writeUInt32LE(SR * 4, 28)
  out.writeUInt16LE(4, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(n * 4, 40)
  const q = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(q(bus.l[i]), 44 + i * 4)
    out.writeInt16LE(q(bus.r[i]), 46 + i * 4)
  }
  writeFileSync(file, out)
}

/**
 * Two-pass EBU R128 loudness normalization (linear gain, true-peak capped):
 * social platforms play back at about −14 LUFS, so that's what we deliver.
 */
export function loudnorm(input: string, output: string, targetLufs = -14): void {
  const spec = `I=${targetLufs}:TP=-1.5:LRA=11`
  const pass1 = spawnSync(ffmpegBin(), ['-hide_banner', '-i', input, '-af', `loudnorm=${spec}:print_format=json`, '-f', 'null', '-'], {
    maxBuffer: 1 << 26
  })
  const log = pass1.stderr?.toString() ?? ''
  const json = log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1)
  let filter = `loudnorm=${spec}`
  try {
    const m = JSON.parse(json) as Record<string, string>
    filter += `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
  } catch {
    /* measurement unavailable — single-pass dynamic normalization */
  }
  const pass2 = spawnSync(
    ffmpegBin(),
    ['-hide_banner', '-v', 'error', '-y', '-i', input, '-af', filter, '-ar', String(SR), '-c:a', 'aac', '-b:a', '192k', output],
    { maxBuffer: 1 << 26 }
  )
  if (pass2.status !== 0) throw new Error(`loudnorm failed: ${pass2.stderr?.toString().slice(0, 300)}`)
}

/** deterministic PRNG (mulberry32) — same seed, same music */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
