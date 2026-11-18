import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readSec } from '../appRecon/produce'
import { buildMarketingAss, renderBadge, type IconName, type Sticker } from './overlays'
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
  kind: 'scene' | 'still' | 'clip' | 'montage'
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
  /** a slow push-in over the whole piece, so a still card never looks stuck */
  push?: boolean
  /** a montage: several different shots under this piece's line of voice (replaces `file`) */
  shots?: PieceShot[]
}

export interface PieceShot {
  kind: 'scene' | 'still' | 'clip'
  file: string
  /** a clip's or scene's own length in seconds */
  sec?: number
  /** a clip played slower (1.5 = half as fast again) or faster (0.75); default 1 */
  slow?: number
}

export interface Overlays {
  /** the brand accent, hex */
  accent: string
  /** the opening line, shown big for the first moments */
  hook?: string
  /** a sticker (and optionally an icon badge) for the point of a piece */
  stickers?: Array<{ piece: number; text: string; icon?: IconName }>
  /** the progress bar along the top (default on) */
  progress?: boolean
  /** a soft vignette (default on) */
  vignette?: boolean
  /** the spoken words' colour in the captions, hex (default: the accent, brightened) */
  captionColor?: string
  /** caption size against the usual (default 1) */
  captionScale?: number
}

export interface AssembleInput {
  dir: string
  pieces: FilmPiece[]
  title: string
  musicMood?: VideoSpec['musicMood']
  aiMusic?: (info: { cuts: number[]; total: number }) => Promise<Stereo | null>
  /** the person wants no music: neither the AI track nor the built-in score */
  noMusic?: boolean
  overlays?: Overlays
  keep?: boolean
  log?: (message: string) => void
  /** the film's frame (default 1920×1080) */
  size?: { width: number; height: number }
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
  if (inp.aiMusic && !inp.noMusic) {
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
  if (!music && !inp.noMusic) music = scoreMusic(spec, cuts, total)
  if (!music) musicSource = 'none'
  if (music) duck(music, voice)
  const bus = stereo(total)
  mixIn(bus, voice, 0, 0.9)
  if (music) for (let i = 0; i < bus.l.length && i < music.l.length; i++) { bus.l[i] += music.l[i] * 0.55; bus.r[i] += music.r[i] * 0.55 }
  const wav = join(inp.dir, 'mix-raw.wav')
  const mix = join(inp.dir, 'mix.m4a')
  writeWav(wav, bus)
  loudnorm(wav, mix)

  // ---- captions, hook, stickers: written as subtitle events and drawn over the picture
  const W = inp.size?.width ?? 1920
  const H = inp.size?.height ?? 1080
  const accent = `#${(inp.overlays?.accent ?? 'f5a524').replace('#', '')}`
  const voiceAt = (i: number) => starts[i] + (i === 0 ? 0.5 : X + 0.15)
  const stickers: Sticker[] = []
  const badges: Array<{ file: string; start: number; end: number }> = []
  for (const s of inp.overlays?.stickers ?? []) {
    if (s.piece <= 0 || s.piece >= inp.pieces.length) continue
    const start = starts[s.piece] + X + 0.1
    const end = Math.min(start + 2.6, starts[s.piece] + durs[s.piece] - 0.25)
    if (end - start < 0.8) continue
    stickers.push({ start, end, text: s.text })
    if (s.icon) badges.push({ file: await renderBadge(s.icon, accent, join(inp.dir, `badge-${s.piece}-${s.icon}.png`), 320), start, end })
  }
  const ass = buildMarketingAss({
    W, H, accent,
    beats: inp.pieces.map((p, i) => ({ voiceStart: voiceAt(i), voiceSec: spoken(p), text: p.text })),
    hook: inp.overlays?.hook,
    stickers,
    captionColor: inp.overlays?.captionColor,
    captionScale: inp.overlays?.captionScale
  })
  const captionsFile = join(inp.dir, 'captions.ass')
  writeFileSync(captionsFile, ass)

  // ---- picture: every piece normalised to the same frame, then dissolved into the next
  const inputs: string[] = []
  const graph: string[] = []
  let nIn = 0
  const addInput = (...args: string[]): number => {
    inputs.push(...args)
    return nIn++
  }
  const sc = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
  /** one picture, moved slowly: pushed in, pulled out, or panned across — never the same twice in a row */
  const still = (file: string, d: number, variant: number, label: string): void => {
    const i = addInput('-loop', '1', '-framerate', '30', '-i', file)
    const F = Math.max(1, Math.round(d * 30))
    const W2 = Math.round(W * 1.25)
    const H2 = Math.round(H * 1.25)
    const moves = [
      { z: `1+0.12*on/${F}`, x: 'iw/2-iw/zoom/2', y: 'ih/2-ih/zoom/2' },
      { z: `1.12-0.12*on/${F}`, x: 'iw/2-iw/zoom/2', y: 'ih/2-ih/zoom/2' },
      { z: '1.14', x: `(iw-iw/zoom)*on/${F}`, y: 'ih/2-ih/zoom/2' },
      { z: '1.14', x: `(iw-iw/zoom)*(1-on/${F})`, y: 'ih/2-ih/zoom/2' }
    ]
    const m = moves[variant % moves.length]
    graph.push(`[${i}:v]scale=${W2}:${H2}:force_original_aspect_ratio=increase,crop=${W2}:${H2},zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${W}x${H}:fps=30,${norm},trim=duration=${num(d)},setpts=PTS-STARTPTS,settb=1/30[${label}]`)
  }
  /** a clip: when the voice outlasts it, it plays forward and back instead of freezing on its last frame */
  const clip = (file: string, d: number, own0: number, label: string, slow = 1): void => {
    const i = addInput('-i', file)
    const k = Math.min(3, Math.max(0.4, slow))
    // a slowed clip lasts longer on the clock: its own length grows with it
    const own = own0 * k
    const pace = k === 1 ? '' : `setpts=${num(k)}*(PTS-STARTPTS),`
    const len = Math.min(own, d)
    if (d - len > 0.4 && len > 1) {
      const rest = Math.max(0, d - 2 * len)
      graph.push(`[${i}:v]${pace}${sc},${norm},trim=duration=${num(len)},setpts=PTS-STARTPTS,split[c${label}a][c${label}b];[c${label}b]reverse[c${label}r];[c${label}a][c${label}r]concat=n=2:v=1:a=0${rest > 0 ? `,tpad=stop_mode=clone:stop_duration=${num(rest + 0.2)}` : ''},trim=duration=${num(d)},setpts=PTS-STARTPTS,settb=1/30[${label}]`)
    } else {
      graph.push(`[${i}:v]${pace}${sc},${norm},tpad=stop_mode=clone:stop_duration=${num(Math.max(0, d - len) + 0.2)},trim=duration=${num(d)},setpts=PTS-STARTPTS,settb=1/30[${label}]`)
    }
  }
  /** a rendered scene, its last frame held when it is shorter than its slot */
  const scene = (file: string, d: number, own: number, label: string, fadeOut = false, push = false): void => {
    const i = addInput('-i', file)
    const F = Math.max(1, Math.round(d * 30))
    const move = push ? `,scale=${Math.round(W * 1.12)}:${Math.round(H * 1.12)},zoompan=z='1+0.07*on/${F}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=${W}x${H}:fps=30,${norm}` : ''
    graph.push(`[${i}:v]scale=${W}:${H},${norm},tpad=stop_mode=clone:stop_duration=${num(Math.max(0, d - own) + 0.3)},trim=duration=${num(d)},setpts=PTS-STARTPTS${move}${fadeOut ? `,fade=t=out:st=${num(d - 0.8)}:d=0.8` : ''},settb=1/30[${label}]`)
  }
  const IN = 0.4
  const CUTS = ['fade', 'slideleft', 'zoomin', 'smoothleft', 'fade', 'circleopen']
  let variant = 0
  const labels: string[] = []
  inp.pieces.forEach((p, i) => {
    const label = `p${i}`
    if (p.shots?.length) {
      // several different shots under one line of voice, dissolving or cutting into each other
      const n = p.shots.length
      const need = durs[i] + (n - 1) * IN
      const heroes = p.shots.filter((s) => s.kind === 'clip')
      const others = n - heroes.length
      const heroSec = (s: PieceShot) => Math.min(s.sec !== undefined ? s.sec * Math.min(3, Math.max(0.4, s.slow ?? 1)) : need, others ? need * 0.6 : need)
      const left = need - heroes.reduce((a, s) => a + heroSec(s), 0)
      const secs = p.shots.map((s) => (s.kind === 'clip' ? heroSec(s) : Math.max(1.6, left / Math.max(1, others))))
      const scale = need / secs.reduce((a, x) => a + x, 0)
      const ds = secs.map((x) => x * scale)
      p.shots.forEach((s, j) => {
        const l = `s${i}_${j}`
        if (s.kind === 'still') still(s.file, ds[j], variant++, l)
        else if (s.kind === 'clip') clip(s.file, ds[j], s.sec ?? ds[j], l, s.slow)
        else scene(s.file, ds[j], s.sec ?? ds[j], l)
      })
      let cur = `s${i}_0`
      let off = 0
      for (let j = 1; j < n; j++) {
        off += ds[j - 1] - IN
        graph.push(`[${cur}][s${i}_${j}]xfade=transition=${CUTS[(i + j) % CUTS.length]}:duration=${IN}:offset=${num(off)}[m${i}_${j}]`)
        cur = `m${i}_${j}`
      }
      graph.push(`[${cur}]trim=duration=${num(durs[i])},setpts=PTS-STARTPTS${p.fadeOut ? `,fade=t=out:st=${num(durs[i] - 0.8)}:d=0.8` : ''},settb=1/30[${label}]`)
    } else if (p.kind === 'still') {
      still(p.file, durs[i], variant++, label)
    } else if (p.kind === 'clip') {
      clip(p.file, durs[i], p.clipSec ?? durs[i], label)
    } else {
      scene(p.file, durs[i], p.srcSec ?? durs[i], label, p.fadeOut, p.push)
    }
    labels.push(label)
  })
  let last = labels[0]
  for (let i = 1; i < labels.length; i++) {
    graph.push(`[${last}][${labels[i]}]xfade=transition=fade:duration=${X}:offset=${num(starts[i])}[x${i}]`)
    last = `x${i}`
  }
  // ---- effects: a soft vignette, a progress bar along the top, the icon badges popping in, then the subtitles
  let tail = `${last}`
  if (inp.overlays?.vignette !== false) {
    graph.push(`[${tail}]vignette=PI/6[vg]`)
    tail = 'vg'
  }
  if (inp.overlays?.progress !== false) {
    const bar = addInput('-f', 'lavfi', '-i', `color=c=${accent.replace('#', '0x')}:s=${W}x${Math.max(8, Math.round(H * 0.006))}:r=30:d=${num(total)}`)
    graph.push(`[${bar}:v]format=rgba[bar]`)
    graph.push(`[${tail}][bar]overlay=x='-w+w*t/${num(total)}':y=0:eval=frame[pb]`)
    tail = 'pb'
  }
  const BS = Math.round(W * (H > W ? 0.2 : 0.11))
  badges.forEach((b, k) => {
    const ic = addInput('-loop', '1', '-framerate', '30', '-t', num(total), '-i', b.file)
    // the badge grows in with a small overshoot and shrinks away at the end
    const grow = `min(1,(t-${num(b.start)})/0.2)+0.12*max(0,sin((t-${num(b.start)})/0.2*PI))`
    const shrink = `min(1,(${num(b.end)}-t)/0.18)`
    graph.push(`[${ic}:v]format=rgba,setpts=PTS+${num(b.start)}/TB,scale=w='max(2,${BS}*(${grow})*${shrink})':h=-2:eval=frame[ic${k}]`)
    graph.push(`[${tail}][ic${k}]overlay=x='(W-w)/2':y='${Math.round(H * (H > W ? 0.205 : 0.22))}-h/2':eval=frame:enable='between(t,${num(b.start)},${num(b.end)})'[bd${k}]`)
    tail = `bd${k}`
  })
  graph.push(`[${tail}]subtitles='${filterPath(captionsFile)}',format=yuv420p[v]`)
  const script = join(inp.dir, 'graph.txt')
  writeFileSync(script, graph.join(';'))
  const audioIdx = addInput('-i', mix)
  const file = join(inp.dir, 'marketing.mp4')
  ffmpeg(
    [...inputs, '-filter_complex_script', script, '-map', '[v]', '-map', `${audioIdx}:a`, '-t', num(total), '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', file],
    'final video'
  )
  if (!inp.keep && existsSync(wav)) rmSync(wav, { force: true })
  return { file, durationSec: total, captionsFile, musicSource, musicError }
}
