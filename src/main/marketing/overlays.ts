import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import sharp from 'sharp'

/**
 * What sits on top of a marketing film: the opening hook, bold captions that
 * fill in word by word as they are spoken, a sticker with the point being
 * made, and a round icon badge. All of it is written as subtitle events
 * (libass draws it: no extra render pass) plus small icon pictures drawn from
 * vector shapes. Pure and deterministic, so it can be tested without a render.
 */

const clock = (sec: number): string => {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}`
}
const safe = (s: string): string => s.replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\s+/g, ' ').trim()
/** ASS colours are &HAABBGGRR */
export function assColour(hex: string, alpha = 0): string {
  const h = hex.replace('#', '').padEnd(6, '0').slice(0, 6)
  const bb = h.slice(4, 6)
  const gg = h.slice(2, 4)
  const rr = h.slice(0, 2)
  return `&H${alpha.toString(16).toUpperCase().padStart(2, '0')}${bb}${gg}${rr}`.toUpperCase()
}

// ------------------------------------------------------------------ icons

export type IconName = 'flame' | 'truck' | 'chat' | 'clock' | 'gift' | 'sparkle' | 'heart' | 'check' | 'bag' | 'star' | 'home' | 'office' | 'leaf'

/** 24×24 shapes, filled in one colour */
const PATHS: Record<IconName, string> = {
  flame: 'M12 2c1 3.5-1.5 5-3 7.5C7.6 11.8 7 13.4 7 15a5 5 0 0 0 10 0c0-2-1-3.4-2-4.7.1 1.4-.4 2.4-1.2 3 .5-3.4-.8-6.800-1.800-11.300zm0 18.500a2.500 2.500 0 0 1-2.500-2.500c0-1.200.8-2 1.500-3 .3 1 1 1.500 1.700 1.800.6.7 1.800 1.100 1.800 2.200a2.500 2.500 0 0 1-2.500 1.500z',
  truck: 'M3 6h11v9H3zM14 9h4l3 3v3h-7zM7 19.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 19.500a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  chat: 'M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9l-5 4V5a1 1 0 0 1 0-1zm4 5v2h8V9zm0 4v2h5v-2z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm1 4v5.200l3.800 2.200-1 1.700L11 13V7z',
  gift: 'M3 8h18v4H3zM4 12h16v9H4zM11 8h2v13h-2zM12 8c-2-3-6-3-5-1 .7 1.600 3 1 5 1zm0 0c2-3 6-3 5-1-.7 1.600-3 1-5 1z',
  sparkle: 'M12 2l2.200 7.800L22 12l-7.800 2.200L12 22l-2.200-7.800L2 12l7.800-2.200z',
  heart: 'M12 21s-8-5.200-8-11a4.500 4.500 0 0 1 8-2.800A4.500 4.500 0 0 1 20 10c0 5.800-8 11-8 11z',
  check: 'M9.500 16.200L5.300 12l-1.800 1.800 6 6L21 7.400 19.200 5.600z',
  bag: 'M5 8h14l1 13H4zM9 8V6.500a3 3 0 0 1 6 0V8h-2V6.500a1 1 0 0 0-2 0V8z',
  star: 'M12 2l2.900 6.300 6.800.8-5 4.700 1.300 6.800L12 17.200 6 20.600l1.300-6.800-5-4.700 6.800-.8z',
  home: 'M12 3l10 9h-3v9h-5v-6h-4v6H5v-9H2z',
  office: 'M4 21V4h9v5h7v12h-6v-4h-2v4zM6 6v2h2V6zm0 4v2h2v-2zm0 4v2h2v-2zm9 1v2h2v-2zm0-4v2h2v-2z',
  leaf: 'M20 4C10 4 4 9 4 16c0 1.500.4 2.800 1 4 1-4 4-8 9-10-5 3-7.500 7-8 11 1 .4 2 .6 3 .6 6 0 9-5 11-17.600z'
}

const ICON_WORDS: Array<[IconName, RegExp]> = [
  ['truck', /deliver|ship|dispatch|arriv|door|courier|doorstep/i],
  ['clock', /hour|minute|fast|quick|time|ahead|same.?day|instant|wait|24|schedule|speed/i],
  ['chat', /whatsapp|chat|message|order|call|text|book|contact|dm\b|reply/i],
  ['gift', /gift|party|occasion|celebrat|birthday|wedding|event|present|treat/i],
  ['flame', /warm|hot|fresh|oven|bake|baked|molten|melt|toast|roast/i],
  ['home', /home|family|kitchen|house/i],
  ['office', /office|work|team|colleague|meeting|desk|business/i],
  ['heart', /love|care|handmade|handcraft|crafted|made with|favou?rite|heart/i],
  ['star', /best|quality|premium|top|rated|award|finest|signature/i],
  ['leaf', /natural|organic|real|pure|clean|ingredient|healthy/i],
  ['bag', /buy|shop|cart|purchase|pick.?up|take.?away|basket/i],
  ['sparkle', /new|magic|special|luxur|elevat|indulg/i]
]
/** the icon that best goes with a phrase */
export function iconFor(text: string): IconName {
  return ICON_WORDS.find(([, re]) => re.test(text))?.[0] ?? 'check'
}

/** the SVG of a round badge: a coloured disc, a soft ring and the white shape */
export function badgeSvg(name: IconName, accent: string, size = 256): string {
  const a = accent.startsWith('#') ? accent : `#${accent}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 48 48"><circle cx="24" cy="24" r="22" fill="${a}"/><circle cx="24" cy="24" r="22" fill="none" stroke="#ffffff" stroke-opacity=".85" stroke-width="2"/><g transform="translate(9 9) scale(1.25)"><path d="${PATHS[name]}" fill="#ffffff" fill-rule="evenodd"/></g></svg>`
}

export async function renderBadge(name: IconName, accent: string, file: string, size = 256): Promise<string> {
  mkdirSync(dirname(file), { recursive: true })
  await sharp(Buffer.from(badgeSvg(name, accent, size))).png().toFile(file)
  return file
}

// ------------------------------------------------------------------ subtitles

export interface CaptionBeat {
  /** when the voice starts and how long it speaks, on the film's clock */
  voiceStart: number
  voiceSec: number
  text: string
}
export interface Sticker {
  start: number
  end: number
  text: string
}
export interface AssOptions {
  W: number
  H: number
  /** the brand accent, hex */
  accent: string
  beats: CaptionBeat[]
  /** the opening line shown big for the first moments */
  hook?: string
  hookAt?: number
  stickers?: Sticker[]
}

const portraitOf = (W: number, H: number): boolean => H > W

/** the words of a line cut into captions of a few words, breaking at punctuation */
export function chunkWords(text: string, max: number): string[][] {
  const words = text.split(/\s+/).filter(Boolean)
  const out: string[][] = []
  let cur: string[] = []
  for (const w of words) {
    cur.push(w)
    if (cur.length >= max || /[.!?;:]$/.test(w) || (cur.length >= 2 && /,$/.test(w))) {
      out.push(cur)
      cur = []
    }
  }
  if (cur.length) out.push(cur)
  // never leave a single stray word hanging on its own at the end
  if (out.length > 1 && out.at(-1)!.length === 1 && out.at(-2)!.length < max) out[out.length - 2].push(...out.pop()!)
  return out
}

/** seconds each word of a chunk is on screen: longer words and the pause after punctuation take longer */
export function wordWeights(words: string[]): number[] {
  return words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2 + (/[.!?]$/.test(w) ? 3 : /[,;:]$/.test(w) ? 1.5 : 0))
}

/** the hook cut into short lines of at most 3 words */
export function hookLines(hook: string): string[] {
  const words = safe(hook).toUpperCase().split(' ').filter(Boolean).slice(0, 9)
  const lines: string[] = []
  for (let i = 0; i < words.length; i += 3) lines.push(words.slice(i, i + 3).join(' '))
  return lines
}

/** dark text on a light accent, white text on a dark one */
const textOn = (hex: string): string => {
  const h = hex.replace('#', '').padEnd(6, '0')
  const l = (0.299 * parseInt(h.slice(0, 2), 16) + 0.587 * parseInt(h.slice(2, 4), 16) + 0.114 * parseInt(h.slice(4, 6), 16)) / 255
  return l > 0.62 ? '&H00201A14' : '&H00FFFFFF'
}

/** a colour light enough to read on a dark picture: a dark brand colour is mixed toward white */
export function brighten(hex: string): string {
  const h = hex.replace('#', '').padEnd(6, '0').slice(0, 6)
  let c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  const lum = (v: number[]) => (0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2]) / 255
  for (let k = 0; k < 12 && lum(c) < 0.62; k++) c = c.map((v) => Math.round(v + (255 - v) * 0.22))
  return c.map((v) => v.toString(16).padStart(2, '0')).join('')
}

export function buildMarketingAss(o: AssOptions): string {
  const { W, H } = o
  const tall = portraitOf(W, H)
  const capSize = Math.round(tall ? W * 0.082 : H * 0.075)
  const hookSize = Math.round(tall ? W * 0.115 : H * 0.115)
  const stickSize = Math.round(tall ? W * 0.05 : H * 0.05)
  // the bottom fifth of a tall film is covered by the app's own buttons, so the captions sit higher there
  const capBottom = Math.round(tall ? H * 0.27 : H * 0.12)
  const maxWords = tall ? 3 : 4
  const events: string[] = []

  // ---- captions: filled in word by word as they are spoken
  for (const b of o.beats) {
    const chunks = chunkWords(b.text, maxWords)
    const weights = chunks.map((c) => wordWeights(c).reduce((a, x) => a + x, 0) + 2)
    const total = weights.reduce((a, x) => a + x, 0) || 1
    let at = b.voiceStart
    chunks.forEach((c, ci) => {
      const dur = (b.voiceSec * weights[ci]) / total
      const ww = wordWeights(c)
      const wsum = ww.reduce((a, x) => a + x, 0) || 1
      const text = c.map((w, wi) => `{\\kf${Math.max(1, Math.round(((dur * 0.96 * ww[wi]) / wsum) * 100))}}${safe(w).toUpperCase()}`).join(' ')
      events.push(`Dialogue: 0,${clock(at)},${clock(at + dur)},Cap,,0,0,0,,{\\fad(40,40)\\fscx82\\fscy82\\t(0,130,\\fscx100\\fscy100)}${text}`)
      at += dur
    })
  }

  // ---- the hook: big, in the first seconds, popping in
  if (o.hook?.trim()) {
    const lines = hookLines(o.hook)
    const at = o.hookAt ?? 0.3
    const text = lines.map((l) => safe(l)).join('\\N')
    events.push(`Dialogue: 3,${clock(at)},${clock(at + 2.6)},Hook,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${Math.round(H * (tall ? 0.3 : 0.4))})\\fad(0,300)\\fscx0\\fscy0\\t(0,170,\\fscx118\\fscy118)\\t(170,300,\\fscx100\\fscy100)}${text}`)
  }

  // ---- stickers: the point of each scene, tilted slightly, bouncing in
  for (const s of o.stickers ?? []) {
    const rot = ((Math.round(s.start * 10) % 2) * 2 - 1) * 2.5
    events.push(`Dialogue: 2,${clock(s.start)},${clock(s.end)},Sticker,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${Math.round(H * (tall ? 0.13 : 0.12))})\\frz${rot}\\fad(0,220)\\fscx0\\fscy0\\t(0,150,\\fscx112\\fscy112)\\t(150,260,\\fscx100\\fscy100)}${safe(s.text).toUpperCase()}`)
  }

  const accent = assColour(o.accent)
  // spoken words need to read on a dark picture even when the brand colour is dark
  const spoken = assColour(brighten(o.accent))
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // spoken words take the accent; the ones still to come are white
    `Style: Cap,Arial Black,${capSize},${spoken},&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,${Math.round(capSize * 0.09)},2,2,${Math.round(W * 0.06)},${Math.round(W * 0.06)},${capBottom},1`,
    `Style: Hook,Arial Black,${hookSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,${Math.round(hookSize * 0.1)},3,5,${Math.round(W * 0.06)},${Math.round(W * 0.06)},0,1`,
    `Style: Sticker,Arial Black,${stickSize},${textOn(o.accent)},${textOn(o.accent)},${accent},&H00000000,-1,0,0,0,100,100,1,0,3,${Math.round(stickSize * 0.55)},0,5,0,0,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...events, ''
  ].join('\n')
}
