import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCaptions, readSec } from '../appRecon/produce'
import { duck } from '../audio/mix'
import { ffmpegBin, loudnorm, mixIn, SR, stereo, writeWav, type Stereo } from '../audio/pcm'
import { scoreMusic } from '../audio/score'
import { filterPath } from '../footage/captions'
import type { VideoSpec } from '@shared/spec'

/**
 * Assembles a film that has no screen recording: a row of pieces — animated
 * scenes, AI pictures, AI clips — cross-faded into one another, with the
 * voice, the music and the captions of the app-recordings engine. This is
 * produce() with the demo taken out: the same clock, the same mix.
 */

export interface FilmPiece {
  /** where the picture comes from: a rendered scene, a still that slowly zooms, or an AI clip */
  kind: 'scene' | 'still' | 'clip'
  file: string
  /** what is said over this piece (also the captions) */
  text: string
  /** short label shown as a chip; empty = no chip */
  chapter?: string
  /** the spoken words, trimmed of silence (empty = the piece is captions-free) */
  pcm: Float32Array
  /** how long the piece must last */
  sec: number
  /** the source video's own length, when it is shorter than `sec` (the last frame is held to fill the rest) */
  srcSec?: number
  /** the clip's own length, when it is a clip (same hold as `srcSec`, named for clarity) */
  clipSec?: number
  /** fade to black at the very end of the film */
  fadeOut?: boolean
}

export interface AssembleInput {
  dir: string
  pieces: FilmPiece[]
  title: string
  musicMood?: VideoSpec['musicMood']
  aiMusic?: (info: { cuts: number[]; total: number }) => Promise<Stereo | null>
  keep?: boolean
  log?: (message: string) => void
}

export interface AssembleResult {
  file: string
  durationSec: number
  captionsFile: string
  musicSource: 'ai' | 'builtin' | 'none'
  musicError?: string
}

const X = 0.6
const norm = 'fps=30,format=yuv420p,setsar=1'
const num = (n: number) => (Math.round(n * 10000) / 10000).toString()

function ffmpeg(args: string[], what: string): void {
  const r = spawnSync(ffmpegBin(), [...args, '-hide_banner', '-v', 'error', '-y'], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || '').slice(-400)}`)
}

export async function assemble(inp: AssembleInput): Promise<AssembleResult> {
  mkdirSync(inp.dir, { recursive: true })
  if (!inp.pieces.length) throw new Error('The film has no pieces')

  // ---- the clock: each piece starts as the previous one dissolves away
  const spoken = (p: FilmPiece) => (p.pcm.length ? p.pcm.length / SR : readSec(p.text))
  const durs = inp.pieces.map((p) => Math.max(p.kind === 'clip' ? 3 : 4.2, p.sec))
  const starts: number[] = []
  inp.pieces.forEach((_, i) => starts.push(i === 0 ? 0 : starts[i - 1] + durs[i - 1] - X))
  const total = starts.at(-1)! + durs.at(-1)!

  // ---- sound: the voice of each piece, then music ducked under it
  const voice = new Float32Array(Math.ceil(total * SR))
  const lay = (pcm: Float32Array, at: number) => {
    const off = Math.round(at * SR)
    for (let i = 0; i < pcm.length && off + i < voice.length; i++) voice[off + i] += pcm[i]
  }
  inp.pieces.forEach((p, i) => {
    if (p.pcm.length) lay(p.pcm, starts[i] + (i === 0 ? 0.5 : X + 0.15))
  })

  const spec = { title: inp.title, musicMood: inp.musicMood ?? 'corporate', design: { look: 'social' } } as unknown as VideoSpec
  const cuts = [...new Set([0, ...starts].map((c) => Math.round(c * 100) / 100))].sort((a, b) => a - b)
  let music: Stereo | null = null
  let musicSource: 'ai' | 'builtin' | 'none' = 'builtin'
  let musicError: string | undefined
  if (inp.aiMusic) {
    try {
      const m = await inp.aiMusic({ cuts, total })
      if (m && m.l.length > SR) {
        // the track is fitted to the film: cut at the end with a short fade, or left to finish early
        music = stereo(total)
        const n = Math.min(music.l.length, m.l.length)
        const fade = Math.min(n, Math.round(1.5 * SR))
        for (let i = 0; i < n; i++) {
          const g = m.l.length > music.l.length && i > n - fade ? (n - i) / fade : 1
          music.l[i] = m.l[i] * g
          music.r[i] = m.r[i] * g
        }
        musicSource = 'ai'
      }
    } catch (err) {
      musicError = String((err as Error)?.message ?? err).slice(0, 160)
      inp.log?.(`The AI music could not be used (${musicError}).`)
    }
  }
  if (!music) music = scoreMusic(spec, cuts, total)
  if (!music) musicSource = 'none'
  if (music) duck(music, voice)
  const bus = stereo(total)
  mixIn(bus, voice, 0, 0.9)
  if (music) for (let i = 0; i < bus.l.length && i < music.l.length; i++) { bus.l[i] += music.l[i] * 0.55; bus.r[i] += music.r[i] * 0.55 }
  const wav = join(inp.dir, 'mix-raw.wav')
  const mix = join(inp.dir, 'mix.m4a')
  writeWav(wav, bus)
  loudnorm(wav, mix)

  // ---- captions: the spoken words of every piece, in reading-sized chunks
  const beats = inp.pieces.map((p, i) => ({ start: starts[i], end: starts[i] + durs[i], voiceStart: starts[i] + (i === 0 ? 0.5 : X + 0.15), voiceSec: spoken(p), text: p.text, chapter: p.chapter ?? '', index: p.chapter ? i + 1 : 0 }))
  const ass = buildCaptions(beats, 1920, 1080)
  const captionsFile = join(inp.dir, 'captions.ass')
  writeFileSync(captionsFile, ass)

  // ---- picture: every piece normalised to the same frame, then dissolved into the next
  const inputs: string[] = []
  const graph: string[] = []
  const labels: string[] = []
  inp.pieces.forEach((p, i) => {
    const label = `p${i}`
    if (p.kind === 'still') {
      // one picture, pushed slowly into: the zoom grows frame by frame over the whole piece
      const frames = Math.max(1, Math.round(durs[i] * 30))
      inputs.push('-loop', '1', '-framerate', '30', '-i', p.file)
      graph.push(`[${i}:v]scale=2400:1350:force_original_aspect_ratio=increase,crop=2400:1350,zoompan=z='1+0.10*on/${frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=1920x1080:fps=30,${norm},trim=duration=${num(durs[i])},setpts=PTS-STARTPTS[${label}]`)
    } else if (p.kind === 'clip') {
      const hold = Math.max(0, durs[i] - (p.clipSec ?? durs[i])) + 0.2
      inputs.push('-i', p.file)
      graph.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,${norm},tpad=stop_mode=clone:stop_duration=${num(hold)},trim=duration=${num(durs[i])},setpts=PTS-STARTPTS[${label}]`)
    } else {
      const hold = Math.max(0, durs[i] - (p.srcSec ?? durs[i])) + 0.3
      inputs.push('-i', p.file)
      graph.push(`[${i}:v]scale=1920:1080,${norm},tpad=stop_mode=clone:stop_duration=${num(hold)},trim=duration=${num(durs[i])},setpts=PTS-STARTPTS${p.fadeOut ? `,fade=t=out:st=${num(durs[i] - 0.8)}:d=0.8` : ''}[${label}]`)
    }
    labels.push(label)
  })
  let last = labels[0]
  for (let i = 1; i < labels.length; i++) {
    graph.push(`[${last}][${labels[i]}]xfade=transition=fade:duration=${X}:offset=${num(starts[i])}[x${i}]`)
    last = `x${i}`
  }
  graph.push(`[${last}]subtitles='${filterPath(captionsFile)}',format=yuv420p[v]`)
  const script = join(inp.dir, 'graph.txt')
  writeFileSync(script, graph.join(';'))
  inputs.push('-i', mix)
  const audioIdx = inp.pieces.length
  const file = join(inp.dir, 'marketing.mp4')
  ffmpeg(
    [...inputs, '-filter_complex_script', script, '-map', '[v]', '-map', `${audioIdx}:a`, '-t', num(total), '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', file],
    'final video'
  )
  if (!inp.keep && existsSync(wav)) rmSync(wav, { force: true })
  return { file, durationSec: total, captionsFile, musicSource, musicError }
}
