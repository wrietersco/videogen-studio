/**
 * Builds resources/asset-pack — the starter library shipped with every
 * install. Everything is made by the app's own engines (procedural score,
 * synthesized sound design, rendered backdrops), so the whole pack is ours to
 * license: free to use in any video, no attribution.
 *
 *   npx tsx scripts/build-asset-pack.ts
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import type { AssetMeta } from '../src/shared/assets'
import { scoreMusic, beatGrid } from '../src/main/audio/score'
import { whoosh, impact, riser } from '../src/main/audio/sfx'
import { writeWav, loudnorm, stereo, mixIn, SR } from '../src/main/audio/pcm'

const out = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'asset-pack')
rmSync(out, { recursive: true, force: true })
const LICENSE = { name: 'VideoGen built-in (free to use)', requiresAttribution: false }
const created = '2026-10-28T00:00:00.000Z'

function file(kind: AssetMeta['kind'], id: string, ext: string, buf: Buffer, meta: Partial<AssetMeta>): void {
  const dir = join(out, kind)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}${ext}`), buf)
  const full: AssetMeta = {
    id,
    kind,
    source: 'builtin',
    title: id,
    tags: [],
    file: `${id}${ext}`,
    mime: ext === '.m4a' ? 'audio/mp4' : 'image/jpeg',
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    license: LICENSE,
    sharing: 'local',
    createdAt: created,
    usedIn: [],
    ...meta
  }
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(full, null, 2))
}

function encode(bus: ReturnType<typeof stereo>, name: string): Buffer {
  const tmp = join(out, `${name}.wav`)
  const m4a = join(out, `${name}.m4a`)
  writeWav(tmp, bus)
  loudnorm(tmp, m4a, -16)
  const buf = readFileSync(m4a)
  rmSync(tmp)
  rmSync(m4a)
  return buf
}

mkdirSync(out, { recursive: true })

// ---------------- music beds ----------------
const MOODS = [
  ['cinematic', 'documentary', 'Slow-building cinematic bed'],
  ['upbeat', 'infographic', 'Bright upbeat groove'],
  ['minimal', 'infographic', 'Minimal pulse for explainers'],
  ['playful', 'infographic', 'Playful bouncy bed'],
  ['dark', 'documentary', 'Dark tension drone'],
  ['corporate', 'infographic', 'Clean corporate bed']
] as const
for (const [mood, look, title] of MOODS) {
  const spec = { title: `builtin ${mood}`, musicMood: mood, design: { look } } as never
  const g = beatGrid(spec)
  const unit = g.beatSec * g.beatsPerCut
  const total = Math.ceil(45 / unit) * unit
  const cuts = Array.from({ length: Math.round(total / unit) }, (_, i) => i * unit * 2).filter((c) => c < total)
  const m = scoreMusic(spec, cuts, total)
  if (!m) continue
  const bus = stereo(total)
  for (let i = 0; i < bus.l.length; i++) {
    bus.l[i] = m.l[i] * 0.8
    bus.r[i] = m.r[i] * 0.8
  }
  file('music', `builtin-music-${mood}`, '.m4a', encode(bus, mood), {
    title,
    tags: [mood, look, 'bed', 'loop', 'instrumental'],
    durationSec: Math.round(total * 100) / 100,
    extra: { bpm: Math.round(g.bpm) }
  })
}

// ---------------- sound effects ----------------
const SFX: Array<[string, string, string[], () => Float32Array]> = [
  ['whoosh-soft', 'Soft whoosh', ['whoosh', 'transition', 'swish'], () => whoosh(7, 0.6).buf],
  ['whoosh-long', 'Long whoosh', ['whoosh', 'transition', 'swoosh'], () => whoosh(19, 1.1).buf],
  ['impact-deep', 'Deep impact', ['impact', 'hit', 'boom'], () => impact(3)],
  ['impact-tight', 'Tight impact', ['impact', 'hit', 'punch'], () => impact(41)],
  ['riser-short', 'Short riser', ['riser', 'build', 'tension'], () => riser(5, 1.2)],
  ['riser-long', 'Long riser', ['riser', 'build', 'tension'], () => riser(13, 2.4)]
]
for (const [id, title, tags, make] of SFX) {
  const mono = make()
  const sec = mono.length / SR + 0.2
  const bus = stereo(sec)
  mixIn(bus, mono, 0, 0.9)
  file('sfx', `builtin-sfx-${id}`, '.m4a', encode(bus, id), { title, tags: [...tags, 'sfx'], durationSec: Math.round(sec * 100) / 100 })
}

async function backdrops(): Promise<void> {
// ---------------- backdrops ----------------
const BACKDROPS: Array<[string, string, string[], string, string]> = [
  ['midnight', 'Midnight gradient', ['dark', 'blue', 'night'], '#0b1026', '#3b2a6b'],
  ['ember', 'Ember gradient', ['warm', 'orange', 'fire'], '#1a0905', '#d9480f'],
  ['ocean', 'Ocean gradient', ['blue', 'teal', 'water', 'sea'], '#03121f', '#0e7490'],
  ['forest', 'Forest gradient', ['green', 'nature'], '#06140b', '#2f6b3a'],
  ['paper', 'Warm paper', ['paper', 'light', 'cream', 'documentary'], '#efe6d2', '#c9b994'],
  ['neon', 'Neon dusk', ['neon', 'purple', 'pink', 'synthwave'], '#12021f', '#c026d3']
]
for (const [id, title, tags, a, b] of BACKDROPS) {
  for (const [w, h, o] of [
    [1080, 1920, 'portrait'],
    [1920, 1080, 'landscape']
  ] as const) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs>
        <radialGradient id="g" cx="70%" cy="30%" r="95%"><stop offset="0" stop-color="${b}"/><stop offset="1" stop-color="${a}"/></radialGradient>
        <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.06 0"/></filter>
      </defs>
      <rect width="100%" height="100%" fill="url(#g)"/><rect width="100%" height="100%" filter="url(#n)"/>
    </svg>`
    const buf = await sharp(Buffer.from(svg)).jpeg({ quality: 86 }).toBuffer()
    file('image', `builtin-bg-${id}-${o}`, '.jpg', buf, {
      title: `${title} (${o})`,
      tags: [...tags, 'gradient', 'background', 'backdrop', 'texture'],
      width: w,
      height: h
    })
  }
}
}
void backdrops().then(() => console.log('asset pack written to', out))
