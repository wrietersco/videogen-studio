import type { VideoSpec } from '@shared/spec'
import { beatGrid } from './score'

/**
 * Music brief for text-to-music models (Lyria): the edit becomes a timed
 * score — sparse under the hook, building through the body, resolving on the
 * final cut — written in the model's own "[m:ss - m:ss] section" prompt form.
 * Pure: the same edit always yields the same brief (and the same cache key).
 */

const STYLE: Record<Exclude<VideoSpec['musicMood'], 'none'>, string> = {
  cinematic: 'modern cinematic documentary underscore: warm felt piano, low sustained strings, soft analog pads, a subtle pulse; restrained and emotional',
  dark: 'dark, tense documentary underscore: low drones, muted piano, distant percussion, slow ticking pulse; ominous but controlled',
  minimal: 'minimal, airy underscore: soft plucked keys, gentle pads, light texture; calm and focused',
  upbeat: 'upbeat modern electronic pop instrumental: punchy drums, bright plucks, warm bass; confident and positive',
  playful: 'playful light instrumental: marimba, pizzicato strings, claps, bouncy bass; fun and quirky',
  corporate: 'clean modern corporate instrumental: piano, light guitar, soft kick, gentle synth; optimistic and polished'
}

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

export function musicBrief(spec: VideoSpec, cuts: number[], totalSec: number): string | null {
  if (spec.musicMood === 'none') return null
  const mood = spec.design?.look === 'documentary' && ['upbeat', 'playful', 'corporate'].includes(spec.musicMood) ? 'cinematic' : spec.musicMood
  const { bpm } = beatGrid(spec)
  const total = Math.round(totalSec)
  const hookEnd = cuts[1] ?? totalSec * 0.25
  const finalCut = cuts.length > 2 ? cuts[cuts.length - 1] : totalSec * 0.8
  const voiced = spec.voiceover.length > 0 || spec.narration.length > 0
  return [
    `Instrumental background score, ${STYLE[mood]}.`,
    `Instrumental only: no vocals, no lyrics, no choir, no spoken word.`,
    `${Math.round(bpm)} BPM. Total length exactly ${total} seconds, with a real composed ending — not a fade.`,
    voiced ? 'It plays under a voiceover, so keep the midrange uncluttered and avoid busy melodies.' : '',
    '',
    `[0:00 - ${mmss(hookEnd)}] Intro: sparse and atmospheric, one soft motif, lots of space.`,
    `[${mmss(hookEnd)} - ${mmss(finalCut)}] Build: the pulse enters and the arrangement grows steadily, one layer at a time.`,
    `[${mmss(finalCut)} - ${mmss(totalSec)}] Resolution: arrive on the home chord exactly at ${mmss(finalCut)} with a soft low hit, then a short satisfying ending at ${mmss(totalSec)}.`
  ]
    .filter((l, i, a) => l || a[i - 1])
    .join('\n')
}
