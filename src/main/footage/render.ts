import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FADE_SEC, planDuration, shapeSize, type EditPlan, type FootageClip, type PlanSegment } from '../../shared/footage'
import type { VideoSpec } from '../../shared/spec'
import { writeWav } from '../audio/pcm'
import { scoreMusic } from '../audio/score'
import { subjectFocus } from './focus'
import { probeFile } from './scan'
import { buildAss, captionCues, clampToLength, filterPath } from './captions'
import { ffmpegReason, runFfmpeg } from './ffmpeg'

/**
 * Cuts the plan into one video with a single ffmpeg graph: trim → fit to the
 * chosen shape → join (cuts and crossfades) → balance each clip's loudness.
 * Music, ducking under speech and the final loudness pass come after, on
 * lossless audio, so sound is encoded exactly once.
 */

const FPS = 30
/** loudness every clip's own sound is balanced to before mixing (leaves headroom for music) */
const STEM_LUFS = -20

const num = (n: number) => String(Math.round(n * 1000) / 1000)

/** atempo only accepts 0.5–2 per instance */
function atempoChain(speed: number): string {
  if (Math.abs(speed - 1) < 0.001) return ''
  const parts: number[] = []
  let s = speed
  while (s > 2) { parts.push(2); s /= 2 }
  while (s < 0.5) { parts.push(0.5); s /= 0.5 }
  parts.push(s)
  return parts.map((p) => `atempo=${num(p)}`).join(',') + ','
}

export function shouldBlur(plan: EditPlan, clip: FootageClip, target: { width: number; height: number }): boolean {
  if (plan.reframe === 'crop') return false
  if (plan.reframe === 'blur') return true
  // auto: crop when the shapes are close, otherwise keep the whole picture over a blurred copy of itself
  const src = clip.width / Math.max(1, clip.height)
  const dst = target.width / target.height
  return Math.abs(Math.log(src / dst)) > Math.log(1.3)
}

export function segmentSeconds(s: PlanSegment): number {
  return (s.endSec - s.startSec) / s.speed
}

export function stemGainDb(clip: FootageClip): number {
  if (clip.lufs === undefined || clip.lufs < -60) return 0
  return Math.max(-12, Math.min(12, STEM_LUFS - clip.lufs))
}

export interface SegmentGraph {
  /** input arguments (-ss/-t/-i per segment) */
  inputs: string[]
  filter: string
  totalSec: number
}

/** the whole cut as one filter graph with outputs [outv] and [outa] */
export function buildSegmentGraph(plan: EditPlan, clips: Map<string, FootageClip>, subtitleFile?: string): SegmentGraph {
  const { width: W, height: H } = shapeSize(plan.shape)
  const inputs: string[] = []
  const lines: string[] = []
  const lens: number[] = []
  plan.segments.forEach((seg, i) => {
    const clip = clips.get(seg.clipId)
    if (!clip) throw new Error(`The clip for part ${i + 1} is no longer in the project`)
    inputs.push('-ss', num(seg.startSec), '-t', num(seg.endSec - seg.startSec), '-i', clip.path)
    const out = segmentSeconds(seg)
    lens.push(out)
    const setpts = `setpts=(PTS-STARTPTS)/${num(seg.speed)},fps=${FPS}`
    const tail = `trim=duration=${num(out)},setpts=PTS-STARTPTS,setsar=1,format=yuv420p,settb=AVTB`
    if (shouldBlur(plan, clip, { width: W, height: H })) {
      lines.push(
        `[${i}:v:0]${setpts},split=2[bg${i}][fg${i}]`,
        `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:3[bb${i}]`,
        `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[fs${i}]`,
        `[bb${i}][fs${i}]overlay=(W-w)/2:(H-h)/2,${tail}[v${i}]`
      )
    } else {
      // keep the part of the picture where the subject is, rather than always the middle
      const f = seg.focus
      const at = f ? `:x='min(max(${num(f.x)}*iw-ow/2,0),iw-ow)':y='min(max(${num(f.y)}*ih-oh/2,0),ih-oh)'` : ''
      lines.push(`[${i}:v:0]${setpts},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${at},${tail}[v${i}]`)
    }
    if (seg.keepAudio && clip.hasAudio) {
      const gain = stemGainDb(clip)
      const edge = Math.min(0.02, out / 4)
      lines.push(
        `[${i}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${atempoChain(seg.speed)}volume=${num(gain)}dB,` +
          `apad=whole_dur=${num(out)},atrim=duration=${num(out)},asetpts=PTS-STARTPTS,afade=t=in:d=${num(edge)},afade=t=out:st=${num(Math.max(0, out - edge))}:d=${num(edge)}[a${i}]`
      )
    } else {
      lines.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${num(out)},asetpts=PTS-STARTPTS[a${i}]`)
    }
  })
  let cv = 'v0'
  let ca = 'a0'
  let length = lens[0]
  for (let i = 1; i < plan.segments.length; i++) {
    const out = lens[i]
    const fade = plan.segments[i].transition === 'fade'
    const t = fade ? Math.min(FADE_SEC, out * 0.5, length * 0.5) : 0
    if (fade && t >= 0.1) {
      lines.push(
        `[${cv}][v${i}]xfade=transition=fade:duration=${num(t)}:offset=${num(length - t)},fps=${FPS},settb=AVTB,format=yuv420p[xv${i}]`,
        `[${ca}][a${i}]acrossfade=d=${num(t)}[xa${i}]`
      )
      length += out - t
    } else {
      lines.push(`[${cv}][${ca}][v${i}][a${i}]concat=n=2:v=1:a=1[xv${i}][xa${i}]`)
      length += out
    }
    cv = `xv${i}`
    ca = `xa${i}`
  }
  const edgeV = plan.fadeInOut ? `,fade=t=in:st=0:d=0.3,fade=t=out:st=${num(Math.max(0, length - 0.45))}:d=0.45` : ''
  const edgeA = plan.fadeInOut ? `,afade=t=in:st=0:d=0.3,afade=t=out:st=${num(Math.max(0, length - 0.45))}:d=0.45` : ''
  // text goes on before the fade, so it fades with the picture
  const subs = subtitleFile ? `,subtitles=filename='${filterPath(subtitleFile)}'` : ''
  lines.push(`[${cv}]null${subs}${edgeV}[outv]`, `[${ca}]anull${edgeA}[outa]`)
  return { inputs, filter: lines.join(';\n'), totalSec: length }
}

export interface RenderJob {
  plan: EditPlan
  clips: FootageClip[]
  workDir: string
  outFile: string
  /** makes an AI scene and returns the mp4 path (only needed when the plan has AI segments) */
  makeClip?: (prompt: string, aspect: '9:16' | '16:9', sec: number) => Promise<string>
  isCancelled: () => boolean
  onProgress: (pct: number, phase: string) => void
}

export interface RenderOutcome {
  file: string
  durationSec: number
  notes: string[]
}

export class RenderCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export async function renderPlan(job: RenderJob): Promise<RenderOutcome> {
  let plan = job.plan
  const byId = new Map(job.clips.map((c) => [c.id, c]))
  const missing = plan.segments.find((s) => !s.ai && (!byId.get(s.clipId) || byId.get(s.clipId)!.status !== 'ok' || !existsSync(byId.get(s.clipId)!.path)))
  if (missing) throw new Error('One of the video files in this edit has been moved or deleted. Rescan the folders and plan again.')
  const notes: string[] = []
  const target = shapeSize(plan.shape)
  if (plan.segments.some((s) => s.ai)) {
    if (!job.makeClip) throw new Error('Making AI scenes needs a Gemini key: add one in Settings, or remove the AI scenes from the edit.')
    const aspect = target.height > target.width ? '9:16' : '16:9'
    const done: PlanSegment[] = []
    for (const [i, seg] of plan.segments.entries()) {
      if (!seg.ai) {
        done.push(seg)
        continue
      }
      if (job.isCancelled()) throw new RenderCancelled()
      job.onProgress(Math.min(20, 2 + i), `Making an AI scene (${done.filter((x) => x.ai).length + 1})`)
      const file = await job.makeClip(seg.ai.prompt, aspect, Math.max(3, Math.min(10, Math.round(seg.endSec - seg.startSec))))
      const probe = await probeFile(file)
      if (!probe) throw new Error('The AI scene could not be read. Try again.')
      const id = seg.clipId
      byId.set(id, { id, path: file, name: 'AI scene', folder: '', sizeBytes: 0, mtimeMs: 0, durationSec: probe.durationSec, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: false, shots: [], watched: true, listened: true, status: 'ok' })
      done.push({ ...seg, startSec: 0, endSec: Math.min(Math.max(1, seg.endSec - seg.startSec), probe.durationSec), keepAudio: false })
    }
    plan = { ...plan, segments: done }
  }
  // work out where to crop each picture that has to change shape
  if (plan.reframe !== 'blur') {
    const segs: PlanSegment[] = []
    for (const seg of plan.segments) {
      const c = byId.get(seg.clipId)!
      const differs = Math.abs(Math.log(c.width / Math.max(1, c.height) / (target.width / target.height))) > 0.05
      if (!seg.focus && differs && !shouldBlur(plan, c, target)) segs.push({ ...seg, focus: await subjectFocus(c.path, seg.startSec, seg.endSec) })
      else segs.push(seg)
      if (job.isCancelled()) throw new RenderCancelled()
    }
    plan = { ...plan, segments: segs }
  }
  const work = job.workDir
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  try {
    let graph = buildSegmentGraph(plan, byId)
    const cues = plan.captions === 'off' ? [] : clampToLength(captionCues(plan, byId), graph.totalSec)
    const titles = clampToLength(plan.titles, graph.totalSec)
    if (plan.captions !== 'off' && !cues.length) notes.push('There was no transcribed speech in the kept parts, so no captions were added. Let the AI listen to your videos first.')
    if (cues.length || titles.length) {
      const ass = join(work, 'text.ass')
      writeFileSync(ass, buildAss(plan, cues, titles))
      graph = buildSegmentGraph(plan, byId, ass)
    }
    const scriptFile = join(work, 'graph.txt')
    writeFileSync(scriptFile, graph.filter)
    const videoOnly = join(work, 'video.mp4')
    const stem = join(work, 'stem.wav')
    job.onProgress(1, 'Cutting the clips together')
    const cut = await runFfmpeg(
      ['-v', 'error', '-y', ...graph.inputs, '-filter_complex_script', scriptFile,
        '-map', '[outv]', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', videoOnly,
        '-map', '[outa]', '-c:a', 'pcm_s16le', '-ar', '48000', stem],
      { totalSec: graph.totalSec, onProgress: (p) => job.onProgress(Math.round(p * 0.8), 'Cutting the clips together'), isCancelled: job.isCancelled }
    )
    if (job.isCancelled()) throw new RenderCancelled()
    if (cut.code !== 0 || !existsSync(videoOnly) || !existsSync(stem)) throw new Error(`Cutting the video failed: ${ffmpegReason(cut.stderr)}`)

    // ---- music ----
    job.onProgress(81, 'Adding music and balancing sound')
    const total = graph.totalSec
    const musicFile = await prepareMusic(plan, total, work, notes)
    const hasSpeech = plan.segments.some((s) => s.keepAudio && byId.get(s.clipId)?.hasAudio && byId.get(s.clipId)!.lufs !== undefined)
    const mixed = join(work, 'mix.wav')
    if (musicFile) {
      const bed = hasSpeech ? -26 : -16
      const musicChain = `[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=duration=${num(total)},asetpts=PTS-STARTPTS,loudnorm=I=${bed}:TP=-2:LRA=11,afade=t=in:d=0.8,afade=t=out:st=${num(Math.max(0, total - 2.2))}:d=2.2`
      const filter = hasSpeech
        ? `[0:a]aresample=48000,aformat=channel_layouts=stereo,asplit=2[dlg][sc];${musicChain}[mus];[mus][sc]sidechaincompress=threshold=0.02:ratio=9:attack=20:release=450:makeup=1[duck];[dlg][duck]amix=inputs=2:duration=first:normalize=0[mix]`
        : `${musicChain}[mix]`
      const mix = await runFfmpeg(['-v', 'error', '-y', '-i', stem, '-stream_loop', '-1', '-i', musicFile, '-filter_complex', filter, '-map', '[mix]', '-t', num(total), '-c:a', 'pcm_s16le', '-ar', '48000', mixed], { isCancelled: job.isCancelled })
      if (job.isCancelled()) throw new RenderCancelled()
      if (mix.code !== 0 || !existsSync(mixed)) throw new Error(`Mixing the music failed: ${ffmpegReason(mix.stderr)}`)
    }
    const audioIn = musicFile ? mixed : stem

    // ---- loudness ----
    job.onProgress(90, 'Setting the final volume')
    const aac = join(work, 'final.m4a')
    await finalAudio(audioIn, aac, plan.loudness)
    if (job.isCancelled()) throw new RenderCancelled()
    if (!existsSync(aac)) throw new Error('Could not finish the sound track')
    job.onProgress(96, 'Saving your video')
    const mux = await runFfmpeg(['-v', 'error', '-y', '-i', videoOnly, '-i', aac, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', '-shortest', job.outFile], { isCancelled: job.isCancelled })
    if (job.isCancelled()) throw new RenderCancelled()
    if (mux.code !== 0 || !existsSync(job.outFile)) throw new Error(`Saving the video failed: ${ffmpegReason(mux.stderr)}`)
    job.onProgress(100, 'Done')
    return { file: job.outFile, durationSec: planDuration(plan), notes }
  } catch (err) {
    rmSync(job.outFile, { force: true })
    throw err
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

async function prepareMusic(plan: EditPlan, total: number, work: string, notes: string[]): Promise<string | null> {
  if (plan.music.mode === 'none') return null
  if (plan.music.mode === 'file') {
    if (plan.music.file && existsSync(plan.music.file)) return plan.music.file
    notes.push('Your music file could not be found, so the video has no music.')
    return null
  }
  const starts: number[] = []
  let at = 0
  for (const s of plan.segments) {
    starts.push(at)
    at += segmentSeconds(s)
  }
  const stub = { title: plan.title, musicMood: plan.music.mood, design: undefined } as unknown as VideoSpec
  const bus = scoreMusic(stub, starts.length > 1 ? starts : [0, total], total)
  if (!bus) return null
  const file = join(work, 'score.wav')
  writeWav(file, bus)
  return file
}

/** two-pass loudness normalisation to the platform standard, then AAC */
async function finalAudio(input: string, output: string, mode: EditPlan['loudness']): Promise<void> {
  const aac = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2']
  if (mode === 'off') {
    await runFfmpeg(['-v', 'error', '-y', '-i', input, '-af', 'alimiter=limit=0.95', ...aac, output])
    return
  }
  const target = mode === 'quiet' ? -16 : -14
  const spec = `I=${target}:TP=-1.5:LRA=11`
  const pass1 = await runFfmpeg(['-i', input, '-af', `loudnorm=${spec}:print_format=json`, '-f', 'null', '-'])
  let filter = `loudnorm=${spec}`
  try {
    const log = pass1.stderr
    const m = JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1)) as Record<string, string>
    // silence measures as -inf: a linear gain is meaningless, fall back to plain loudnorm
    if (Number.isFinite(parseFloat(m.input_i))) filter += `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
  } catch {
    /* measurement unavailable: single-pass dynamic normalisation */
  }
  await runFfmpeg(['-v', 'error', '-y', '-i', input, '-af', filter, ...aac, output])
}
