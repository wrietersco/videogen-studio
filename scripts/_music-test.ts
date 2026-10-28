import { scoreMusic, beatGrid } from '../src/main/audio/score'
import { designSfx } from '../src/main/audio/sfx'
import { writeWav, loudnorm, stereo } from '../src/main/audio/pcm'
const out = process.argv[2]
for (const mood of ['cinematic', 'upbeat'] as const) {
  const spec: any = { title: 'Titanic test', musicMood: mood, design: { look: mood === 'cinematic' ? 'documentary' : 'infographic' } }
  const g = beatGrid(spec)
  const unit = g.beatSec * g.beatsPerCut
  const cuts = [0, 3 * unit, 6 * unit, 8 * unit, 11 * unit]
  const total = 14 * unit
  const t0 = Date.now()
  const m = scoreMusic(spec, cuts, total)!
  const bus = stereo(total)
  for (let i = 0; i < bus.l.length; i++) { bus.l[i] = m.l[i] * 0.6; bus.r[i] = m.r[i] * 0.6 }
  designSfx(bus, cuts, total, 42)
  writeWav(`${out}/${mood}.wav`, bus)
  loudnorm(`${out}/${mood}.wav`, `${out}/${mood}.m4a`)
  console.log(mood, `${total.toFixed(1)}s`, `${Date.now() - t0}ms`, 'cuts', cuts.map((c) => c.toFixed(2)).join(','))
}
