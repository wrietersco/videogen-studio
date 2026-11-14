import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { Rect, Take } from '@shared/appRecon'
import type { VideoSpec } from '@shared/spec'
import { duck } from '../audio/mix'
import { ffmpegBin, loudnorm, mixIn, SR, stereo, writeWav, type Stereo } from '../audio/pcm'
import { scoreMusic } from '../audio/score'
import { filterPath } from '../footage/captions'
import { displayAddress } from './detect'

/**
 * Turns a recorded take into the finished walkthrough:
 *   frames → steady 30 fps picture → camera moves (zoom to what the viewer
 *   should look at) → captions and step labels → voice + music → one MP4.
 */

export interface BeatPlan {
  beat: number
  /** short label shown as a step marker */
  chapter: string
  /** what is said */
  text: string
  /** speech, trimmed of silence (empty when there is no narrator: the beat is then timed by reading speed) */
  pcm: Float32Array
}

/** how long a line takes to read aloud at a calm pace */
export const readSec = (text: string): number => Math.max(2, text.split(/\s+/).filter(Boolean).length / 2.5)

interface View { z: number; cx: number; cy: number }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const num = (n: number) => (Math.round(n * 10000) / 10000).toString()

/** which part of the picture to bring forward for a rectangle on the page */
export function viewFor(rect: Rect | undefined, vp: { width: number; height: number }, maxZoom = 1.5): View {
  if (!rect) return { z: 1, cx: 0.5, cy: 0.5 }
  const z = clamp(Math.min(vp.width / (rect.w * 1.9), vp.height / (rect.h * 2.6)), 1, maxZoom)
  const cx = clamp((rect.x + rect.w / 2) / vp.width, 0.5 / z, 1 - 0.5 / z)
  const cy = clamp((rect.y + rect.h / 2) / vp.height, 0.5 / z, 1 - 0.5 / z)
  return { z, cx, cy }
}

/** smooth camera keyframes from the beats' focus areas (times are on the video's clock) */
export function cameraKeys(take: Take, offsetSec: number, totalSec: number): Array<{ t: number } & View> {
  const keys: Array<{ t: number } & View> = [{ t: 0, z: 1, cx: 0.5, cy: 0.5 }]
  let cur: View = { z: 1, cx: 0.5, cy: 0.5 }
  for (const b of take.beats) {
    const start = Math.max(0, b.startSec - offsetSec)
    const end = Math.max(start + 0.5, b.endSec - offsetSec)
    const next = viewFor(b.focus, take.viewport)
    const move = Math.min(1.1, (end - start) * 0.45)
    keys.push({ t: start + 0.15, ...cur }, { t: start + 0.15 + move, ...next })
    cur = next
  }
  keys.push({ t: totalSec, ...cur })
  // strictly increasing times
  const out: typeof keys = []
  for (const k of keys) if (!out.length || k.t > out.at(-1)!.t + 0.001) out.push(k)
  return out
}

/** an ffmpeg expression in `on` (output frame number at 30 fps) that eases between keyframes */
function track(keys: Array<{ t: number; v: number }>): string {
  let expr = num(keys.at(-1)!.v)
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i]
    const b = keys[i + 1]
    const u = `((on/30-${num(a.t)})/${num(b.t - a.t)})`
    expr = `if(lt(on/30,${num(b.t)}),${num(a.v)}+(${num(b.v - a.v)})*${u}*${u}*(3-2*${u}),${expr})`
  }
  return expr
}

const clock = (sec: number): string => {
  const cs = Math.max(0, Math.round(sec * 100))
  return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

const assSafe = (s: string) => s.replace(/[{}]/g, '').replace(/\\/g, '/').trim()

/** captions spread across the spoken part, 2–6 words at a time, plus a step marker for each beat */
export function buildCaptions(beats: Array<{ start: number; end: number; voiceStart: number; voiceSec: number; text: string; chapter: string; index: number }>, W = 1920, H = 1080, extras: Array<{ start: number; end: number; voiceStart: number; voiceSec: number; text: string }> = []): string {
  const events: string[] = []
  for (const b of [...beats, ...extras.map((e) => ({ ...e, chapter: '', index: 0 }))]) {
    const words = b.text.split(/\s+/).filter(Boolean)
    const chunks: string[] = []
    let cur: string[] = []
    for (const w of words) {
      cur.push(w)
      if (cur.length >= 5 || /[.!?;:]$/.test(w) || (cur.length >= 3 && /,$/.test(w))) { chunks.push(cur.join(' ')); cur = [] }
    }
    if (cur.length) chunks.push(cur.join(' '))
    const weights = chunks.map((c) => c.length + 6)
    const total = weights.reduce((a, c) => a + c, 0)
    let at = b.voiceStart
    chunks.forEach((c, i) => {
      const dur = (b.voiceSec * weights[i]) / total
      events.push(`Dialogue: 0,${clock(at)},${clock(at + dur)},Cap,,0,0,0,,${assSafe(c)}`)
      at += dur
    })
    if (b.index > 0) events.push(`Dialogue: 1,${clock(b.start + 0.2)},${clock(b.end - 0.1)},Chip,,0,0,0,,{\\an6\\pos(${WIN.x + WIN.w - 22},${WIN.y + 23})\\fad(250,200)}  ${b.index}  ${assSafe(b.chapter)}  `)
  }
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Cap,Arial,54,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,4,1,2,140,140,64,1',
    'Style: Chip,Arial,26,&H00FFFFFF,&H000000FF,&H00B4642D,&H00B4642D,-1,0,0,0,100,100,1,0,3,8,0,6,0,0,0,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, ''
  ].join('\n')
}


/** the browser window the page is shown in (canvas 1920×1080) */
const WIN = { x: 110, y: 40, w: 1700, bar: 46, h: 1002 }
const PAGE = { x: WIN.x, y: WIN.y + WIN.bar, w: WIN.w, h: WIN.h - WIN.bar }
const DEFAULT_BACKDROP: [string, string] = ['#22325a', '#0a0f1e']
const FONT = ['C:/Windows/Fonts/segoeui.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(existsSync)

/** backdrop, window and address bar as one still picture, and the mask that rounds the page's lower corners */
async function drawFrame(dir: string, secure: boolean, backdrop: [string, string] = DEFAULT_BACKDROP): Promise<{ bg: string; mask: string }> {
  const bg = join(dir, 'frame-bg.png')
  const mask = join(dir, 'frame-mask.png')
  // drawn inside the address pill (30 px tall); a padlock for https, a warning ring otherwise
  const lock = secure
    ? `<path d="M14.5 14v-3a5.5 5.5 0 0 1 11 0v3" fill="none" stroke="#2e7d32" stroke-width="2.4"/><rect x="11.5" y="13.5" width="17" height="12" rx="3" fill="#2e7d32"/>`
    : `<circle cx="20" cy="15" r="9" fill="none" stroke="#b26a00" stroke-width="2.4"/><rect x="18.8" y="9.5" width="2.4" height="7" fill="#b26a00"/><circle cx="20" cy="20" r="1.5" fill="#b26a00"/>`
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${backdrop[0]}"/><stop offset="1" stop-color="${backdrop[1]}"/></linearGradient>
    <filter id="s" x="-10%" y="-10%" width="120%" height="130%"><feGaussianBlur stdDeviation="24"/></filter>
  </defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
  <rect x="${WIN.x + 18}" y="${WIN.y + 34}" width="${WIN.w}" height="${WIN.h}" rx="16" fill="#000" opacity=".6" filter="url(#s)"/>
  <rect x="${WIN.x}" y="${WIN.y}" width="${WIN.w}" height="${WIN.h}" rx="16" fill="#e9edf2"/>
  <circle cx="${WIN.x + 30}" cy="${WIN.y + 23}" r="7" fill="#ff5f57"/><circle cx="${WIN.x + 54}" cy="${WIN.y + 23}" r="7" fill="#febc2e"/><circle cx="${WIN.x + 78}" cy="${WIN.y + 23}" r="7" fill="#28c840"/>
  <rect x="${WIN.x + 116}" y="${WIN.y + 8}" width="800" height="30" rx="15" fill="#ffffff"/>
  <g transform="translate(${WIN.x + 116} ${WIN.y + 8})">${lock}</g>
</svg>`
  await sharp(Buffer.from(svg)).png().toFile(bg)
  const r = 16
  const m = `<svg width="${PAGE.w}" height="${PAGE.h}" xmlns="http://www.w3.org/2000/svg"><rect width="${PAGE.w}" height="${PAGE.h}" fill="#000"/><path d="M0 0H${PAGE.w}V${PAGE.h - r}A${r} ${r} 0 0 1 ${PAGE.w - r} ${PAGE.h}H${r}A${r} ${r} 0 0 1 0 ${PAGE.h - r}Z" fill="#fff"/></svg>`
  await sharp(Buffer.from(m)).greyscale().png().toFile(mask)
  return { bg, mask }
}

/** the address shown for each stretch of the video */
export function addressTimeline(take: Take, offsetSec: number, totalSec: number): Array<{ from: number; to: number; text: string }> {
  const navs = take.navigations.filter((n) => /^https?:/.test(n.url))
  const out: Array<{ from: number; to: number; text: string }> = []
  navs.forEach((n, i) => {
    const text = displayAddress(n.url)
    const from = i === 0 ? 0 : Math.max(0, n.t - offsetSec)
    const to = i + 1 < navs.length ? Math.max(0, navs[i + 1].t - offsetSec) : totalSec
    if (to > from && out.at(-1)?.text !== text) out.push({ from, to, text })
    else if (out.length && out.at(-1)!.text === text) out.at(-1)!.to = to
  })
  return out
}
/** text for ffmpeg's drawtext: escape the characters its filter syntax treats as special */
const dt = (s: string) => s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '’').replace(/%/g, '\\%')

const FONT_BOLD = ['C:/Windows/Fonts/segoeuib.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(existsSync) ?? FONT

/** a title card shown before or after the demo (launch films) */
export interface CardPlan {
  /** small label above the headline, e.g. NEW */
  pill?: string
  headline: string
  sub?: string
  /** what is said over the card */
  text: string
  pcm: Float32Array
  /** accent colour of the card, hex without # */
  accent?: string
  /** the brand's logo (a transparent PNG for dark backgrounds), shown above the label */
  logo?: string
}

/** the card's still picture: the same backdrop as the browser scene, a soft glow, and the label pill */
async function drawCard(dir: string, name: string, card: CardPlan, glowX: number, backdrop: [string, string] = DEFAULT_BACKDROP): Promise<string> {
  const file = join(dir, `${name}.png`)
  const accent = '#' + (card.accent ?? '4f8cff')
  const pillW = card.pill ? Math.max(150, card.pill.length * 21 + 70) : 0
  const pill = card.pill ? `<rect x="${(1920 - pillW) / 2}" y="318" width="${pillW}" height="56" rx="28" fill="${accent}"/>` : ''
  const svg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${backdrop[0]}"/><stop offset="1" stop-color="${backdrop[1]}"/></linearGradient>
    <radialGradient id="r" cx="${glowX}" cy="0.5" r="0.55"><stop offset="0" stop-color="${accent}" stop-opacity=".34"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#g)"/><rect width="1920" height="1080" fill="url(#r)"/>${pill}
</svg>`
  const base = sharp(Buffer.from(svg))
  if (card.logo && existsSync(card.logo)) {
    const logo = await sharp(card.logo).resize({ width: 380, height: 110, fit: 'inside' }).png().toBuffer({ resolveWithObject: true })
    base.composite([{ input: logo.data, left: Math.round((1920 - logo.info.width) / 2), top: 190 + Math.round((110 - logo.info.height) / 2) }])
  }
  await base.png().toFile(file)
  return file
}

/** drawtext chain for a card: each line rises into place and fades in, one after another */
function cardText(card: CardPlan): string {
  if (!FONT) return ''
  const font = (f: string | undefined) => `fontfile='${filterPath(f ?? FONT!)}'`
  const rise = (d: number, base: number) => `alpha='min(1,max(0,(t-${d})/0.5))':y='${base}+36*pow(1-min(1,max(0,(t-${d})/0.65)),3)'`
  const parts: string[] = []
  if (card.pill) parts.push(`drawtext=${font(FONT_BOLD)}:text='${dt(card.pill.toUpperCase())}':x=(w-text_w)/2:fontsize=27:fontcolor=white:${rise(0.1, 331)}`)
  parts.push(`drawtext=${font(FONT_BOLD)}:text='${dt(card.headline)}':x=(w-text_w)/2:fontsize=132:fontcolor=white:${rise(0.3, 440)}`)
  if (card.sub) parts.push(`drawtext=${font(FONT)}:text='${dt(card.sub)}':x=(w-text_w)/2:fontsize=48:fontcolor=0xb9c6e4:${rise(0.65, 640)}`)
  return parts.join(',')
}

function ffmpeg(args: string[], what: string): void {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-y', ...args], { maxBuffer: 1 << 28 })
  if (r.status !== 0) throw new Error(`${what} failed: ${r.stderr?.toString().slice(0, 600)}`)
}

/** an AI-made clip that cuts into the film, with the line said over it */
export interface InsertPlan {
  /** before the first page, straight after a beat, or after the last one */
  at: { kind: 'start' } | { kind: 'end' } | { kind: 'afterBeat'; beat: number }
  file: string
  /** length of the clip file, in seconds */
  clipSec: number
  text: string
  pcm: Float32Array
  /** small label drawn on the clip */
  tag?: string
}

export interface ProduceInput {
  dir: string
  framesList: string
  /** seconds from recording start to the first frame (frames are the video's clock) */
  offsetSec: number
  take: Take
  beats: BeatPlan[]
  title: string
  musicMood?: VideoSpec['musicMood']
  /** launch films: a title card before the demo and a closing card after it */
  intro?: CardPlan
  /** "the problem" card, between the opening and the demo */
  problem?: CardPlan
  /** no composed score plays when the AI music is not used (the person ruled out instruments or music) */
  noBuiltinMusic?: boolean
  outro?: CardPlan
  /** the film is stretched (by holding the closing card) to this length when the parts are shorter */
  targetSec?: number
  /** keep the intermediate files */
  keep?: boolean
  /** colours taken from the person's reference pictures */
  look?: { backdrop: [string, string]; accent: string }
  /** AI-made clips that cut in between the pages */
  inserts?: InsertPlan[]
  /** a track made by AI for this film (decoded); null or a failure keeps the built-in score */
  aiMusic?: (info: { cuts: number[]; total: number }) => Promise<Stereo | null>
  log?: (message: string) => void
}

export interface ProduceResult {
  file: string
  durationSec: number
  captionsFile: string
  musicSource: 'ai' | 'builtin'
}

export async function produce(inp: ProduceInput): Promise<ProduceResult> {
  mkdirSync(inp.dir, { recursive: true })
  const raw = join(inp.dir, 'raw.mp4')
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', inp.framesList, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'veryfast', raw], 'raw video')

  const demo = inp.take.durationSec
  const keys = cameraKeys(inp.take, inp.offsetSec, demo)
  const Z = track(keys.map((k) => ({ t: k.t, v: k.z })))
  const CX = track(keys.map((k) => ({ t: k.t, v: k.cx })))
  const CY = track(keys.map((k) => ({ t: k.t, v: k.cy })))

  // ---- the film's clock: [intro card] ⟶ demo (cut where an AI clip goes) ⟶ [closing card], each crossfaded into the next
  const X = 0.6
  const spoken = (c: { pcm: Float32Array; text: string }) => (c.pcm.length ? c.pcm.length / SR : readSec(c.text))
  const introSec = inp.intro ? Math.max(4.2, spoken(inp.intro) + 0.5 + 0.9) : 0

  // ---- timing of the demo's beats on the demo's own clock
  const timed = inp.take.beats.map((b, i) => {
    const plan = inp.beats.find((p) => p.beat === b.beat)
    const start = Math.max(0, b.startSec - inp.offsetSec)
    const end = Math.min(demo, Math.max(start + 0.5, b.endSec - inp.offsetSec))
    return { b, plan, start, end, voiceStart: start + 0.45, voiceSec: plan ? (plan.pcm.length ? plan.pcm.length / SR : readSec(plan.text)) : 0, index: i + 1 }
  })

  // ---- where each AI clip cuts in: a time on the demo's clock, always at the start of a beat
  const MIN_PART = 0.4
  const cutAt = (p: InsertPlan): number => {
    if (p.at.kind === 'start') return 0
    if (p.at.kind === 'end') return demo
    const beat = p.at.beat
    const i = timed.findIndex((t) => t.b.beat === beat)
    return i < 0 ? demo : (timed[i + 1]?.start ?? demo)
  }
  const wanted = (inp.inserts ?? []).map((p, k) => ({ p, k, t: cutAt(p) })).sort((a, b) => a.t - b.t || a.k - b.k)
  type Item = { kind: 'intro' } | { kind: 'problem' } | { kind: 'demo'; a: number; b: number; afterInsert: boolean } | { kind: 'ins'; p: InsertPlan } | { kind: 'outro' }
  const items: Item[] = []
  // an AI opening comes before the title card, an AI closing after the closing card: the order the person asked for
  const opening = wanted.filter((w) => w.p.at.kind === 'start')
  const closing = wanted.filter((w) => w.p.at.kind === 'end')
  for (const w of opening) items.push({ kind: 'ins', p: w.p })
  if (inp.intro) items.push({ kind: 'intro' })
  if (inp.problem) items.push({ kind: 'problem' })
  let cur = 0
  let afterInsert = !inp.intro && !inp.problem && opening.length > 0
  const tail: InsertPlan[] = []
  for (const w of wanted) {
    if (w.p.at.kind !== 'afterBeat') continue
    if (w.t >= demo - MIN_PART) { tail.push(w.p); continue }
    if (w.t > cur + MIN_PART) {
      items.push({ kind: 'demo', a: cur, b: w.t, afterInsert })
      cur = w.t
    }
    items.push({ kind: 'ins', p: w.p })
    afterInsert = true
  }
  items.push({ kind: 'demo', a: cur, b: demo, afterInsert })
  for (const p of tail) items.push({ kind: 'ins', p })
  if (inp.outro) items.push({ kind: 'outro' })
  for (const w of closing) items.push({ kind: 'ins', p: w.p })

  const lengthOf = (it: Item): number => {
    if (it.kind === 'intro') return introSec
    if (it.kind === 'problem') return Math.max(4.2, spoken(inp.problem!) + 0.5 + 0.9)
    if (it.kind === 'demo') return it.b - it.a
    if (it.kind === 'ins') return Math.max(it.p.clipSec, spoken(it.p) + 0.5 + 0.9)
    return 0
  }
  const starts: number[] = []
  const durs: number[] = []
  items.forEach((it, i) => {
    const st = i === 0 ? 0 : starts[i - 1] + durs[i - 1] - X
    starts.push(st)
    durs.push(it.kind === 'outro' ? Math.max(spoken(inp.outro!) + 0.5 + 1.8, inp.targetSec && i === items.length - 1 ? inp.targetSec - st : 0) : lengthOf(it))
  })
  const total = starts.at(-1)! + durs.at(-1)!
  const demoParts = items.map((it, i) => ({ it, st: starts[i] })).filter((x): x is { it: Extract<Item, { kind: 'demo' }>; st: number } => x.it.kind === 'demo')
  /** a moment of the demo (its own clock) on the film's clock */
  const film = (t: number): number => {
    const part = [...demoParts].reverse().find((x) => x.it.a <= t + 1e-6) ?? demoParts[0]
    return part.st + (t - part.it.a)
  }
  /** a beat that comes straight out of a clip waits for the cross-fade to finish before it is spoken */
  const lead = (t: number): number => (demoParts.some((x) => x.it.afterInsert && Math.abs(x.it.a - t) < 1e-6 && x.it.a > 0) ? X + 0.1 : 0)
  const filmBeats = timed.map((t) => ({ ...t, fStart: film(t.start), fVoice: film(t.start) + 0.45 + lead(t.start) }))

  // ---- sound: voice, then music ducked under it
  const voice = new Float32Array(Math.ceil(total * SR))
  const lay = (pcm: Float32Array, at: number) => {
    const off = Math.round(at * SR)
    for (let i = 0; i < pcm.length && off + i < voice.length; i++) voice[off + i] += pcm[i]
  }
  items.forEach((it, i) => {
    if (it.kind === 'intro') lay(inp.intro!.pcm, starts[i] + 0.5)
    if (it.kind === 'problem') lay(inp.problem!.pcm, starts[i] + 0.5)
    if (it.kind === 'ins') lay(it.p.pcm, starts[i] + 0.5)
    if (it.kind === 'outro') lay(inp.outro!.pcm, starts[i] + 0.5)
  })
  for (const t of filmBeats) if (t.plan) lay(t.plan.pcm, t.fVoice)
  const spec = { title: inp.title, musicMood: inp.musicMood ?? 'corporate', design: { look: 'social' } } as unknown as VideoSpec
  const cuts = [...new Set([0, ...starts, ...filmBeats.map((t) => t.fStart)].map((c) => Math.round(c * 100) / 100))].sort((a, b) => a - b)
  let music: Stereo | null = null
  let musicSource: 'ai' | 'builtin' = 'builtin'
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
      inp.log?.(`The AI music could not be used (${(err as Error).message.slice(0, 100)}), so the built-in score plays instead.`)
    }
  }
  if (!music && !inp.noBuiltinMusic) music = scoreMusic(spec, cuts, total)
  if (music) duck(music, voice)
  const bus = stereo(total)
  mixIn(bus, voice, 0, 0.9)
  if (music) for (let i = 0; i < bus.l.length; i++) { bus.l[i] += music.l[i] * 0.55; bus.r[i] += music.r[i] * 0.55 }
  const wav = join(inp.dir, 'mix-raw.wav')
  const mix = join(inp.dir, 'mix.m4a')
  writeWav(wav, bus)
  loudnorm(wav, mix)

  // ---- picture: camera + captions
  const insertCaptions = items.flatMap((it, i) => (it.kind === 'ins' && it.p.text ? [{ start: starts[i], end: starts[i] + durs[i], voiceStart: starts[i] + 0.5, voiceSec: spoken(it.p), text: it.p.text }] : []))
  const ass = buildCaptions(filmBeats.map((t) => ({ start: t.fStart, end: t.fStart + (t.end - t.start), voiceStart: t.fVoice, voiceSec: t.voiceSec, text: t.plan?.text ?? '', chapter: t.plan?.chapter ?? '', index: t.index })), 1920, 1080, insertCaptions)
  const captionsFile = join(inp.dir, 'captions.ass')
  writeFileSync(captionsFile, ass)
  const x = `min(max((${CX})*iw-iw/zoom/2,0),iw-iw/zoom)`
  const y = `min(max((${CY})*ih-ih/zoom/2,0),ih-ih/zoom)`
  const secure = inp.take.navigations.some((n) => n.url.startsWith('https:'))
  const { bg, mask } = await drawFrame(inp.dir, secure, inp.look?.backdrop)
  const addr = addressTimeline(inp.take, inp.offsetSec, demo)
    .map((a) => (FONT ? `,drawtext=fontfile='${filterPath(FONT)}':text='${dt(a.text)}':x=${WIN.x + 116 + 44}:y=${WIN.y + 12}:fontsize=21:fontcolor=0x3c4043:enable='between(t,${num(a.from)},${num(a.to)})'` : ''))
    .join('')
  const norm = 'fps=30,format=yuv420p,setsar=1'
  const graph = [
    `[0:v]zoompan=z='${Z}':x='${x}':y='${y}':d=1:s=${PAGE.w}x${PAGE.h}:fps=30,format=yuv420p[pg]`,
    `[2:v]format=gray[mk]`,
    `[pg][mk]alphamerge[pa]`,
    `[1:v][pa]overlay=${PAGE.x}:${PAGE.y}:shortest=1:format=auto${addr},${norm},trim=duration=${num(demo)},setpts=PTS-STARTPTS[demo]`
  ]
  const inputs = ['-i', raw, '-loop', '1', '-framerate', '30', '-i', bg, '-loop', '1', '-framerate', '30', '-i', mask, '-i', mix]
  let n = 4
  // the demo is cut into parts wherever a clip goes in
  if (demoParts.length > 1) {
    graph.push(`[demo]split=${demoParts.length}${demoParts.map((_, k) => `[m${k}]`).join('')}`)
    demoParts.forEach((x2, k) => graph.push(`[m${k}]trim=start=${num(x2.it.a)}:end=${num(x2.it.b)},setpts=PTS-STARTPTS,${norm}[dp${k}]`))
  }
  const labels: string[] = []
  let partNo = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'intro') {
      inputs.push('-loop', '1', '-framerate', '30', '-i', await drawCard(inp.dir, 'card-intro', inp.intro!, 0.3, inp.look?.backdrop))
      const t = cardText(inp.intro!)
      graph.push(`[${n}:v]${norm}${t ? ',' + t : ''},trim=duration=${num(durs[i])},setpts=PTS-STARTPTS[intro]`)
      labels.push('intro')
      n++
    } else if (it.kind === 'problem') {
      inputs.push('-loop', '1', '-framerate', '30', '-i', await drawCard(inp.dir, 'card-problem', inp.problem!, 0.5, inp.look?.backdrop))
      const t = cardText(inp.problem!)
      graph.push(`[${n}:v]${norm}${t ? ',' + t : ''},trim=duration=${num(durs[i])},setpts=PTS-STARTPTS[problem]`)
      labels.push('problem')
      n++
    } else if (it.kind === 'demo') {
      labels.push(demoParts.length > 1 ? `dp${partNo++}` : 'demo')
    } else if (it.kind === 'ins') {
      inputs.push('-i', it.p.file)
      const tag = FONT_BOLD && it.p.tag ? `,drawtext=fontfile='${filterPath(FONT_BOLD)}':text='${dt(it.p.tag)}':x=44:y=38:fontsize=24:fontcolor=white@0.92:box=1:boxcolor=black@0.4:boxborderw=11:enable='between(t,0.5,${num(Math.max(1, durs[i] - 0.5))})'` : ''
      const hold = Math.max(0, durs[i] - it.p.clipSec) + 0.2
      graph.push(`[${n}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,${norm},tpad=stop_mode=clone:stop_duration=${num(hold)},trim=duration=${num(durs[i])},setpts=PTS-STARTPTS${tag}[in${i}]`)
      labels.push(`in${i}`)
      n++
    } else {
      inputs.push('-loop', '1', '-framerate', '30', '-i', await drawCard(inp.dir, 'card-outro', inp.outro!, 0.7, inp.look?.backdrop))
      const t = cardText(inp.outro!)
      graph.push(`[${n}:v]${norm}${t ? ',' + t : ''},fade=t=out:st=${num(durs[i] - 0.8)}:d=0.8,trim=duration=${num(durs[i])},setpts=PTS-STARTPTS[outro]`)
      labels.push('outro')
      n++
    }
  }
  let last = labels[0]
  for (let i = 1; i < labels.length; i++) {
    graph.push(`[${last}][${labels[i]}]xfade=transition=fade:duration=${X}:offset=${num(starts[i])}[x${i}]`)
    last = `x${i}`
  }
  graph.push(`[${last}]subtitles='${filterPath(captionsFile)}',format=yuv420p[v]`)
  const script = join(inp.dir, 'graph.txt')
  writeFileSync(script, graph.join(';'))
  const file = join(inp.dir, inp.intro ? 'launch.mp4' : 'walkthrough.mp4')
  ffmpeg(
    [...inputs, '-filter_complex_script', script, '-map', '[v]', '-map', '3:a', '-t', num(total), '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-c:a', 'copy', '-movflags', '+faststart', file],
    'final video'
  )
  if (!inp.keep) rmSync(wav, { force: true })
  return { file, durationSec: total, captionsFile, musicSource }
}
