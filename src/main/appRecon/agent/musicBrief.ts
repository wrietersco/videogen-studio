/**
 * The music brief for a text-to-music model, written from what the PERSON asked
 * (the plan's MusicSpec), not from a mood template. The old brief always said
 * "Instrumental only: no vocals", which made "Arabic vocals and duff only" impossible.
 *
 * Pure: the same spec always gives the same brief.
 *   - vocals are allowed exactly when the spec allows them
 *   - what the person excluded is stated as a rule, in their words
 *   - their description, genre, instrument list and natural sounds are kept verbatim
 */
import type { MusicSpec } from '@shared/agentBrief'

const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`

const list = (xs: string[]): string => xs.map((x) => x.trim()).filter(Boolean).join(', ')

/** a one-line reading of what the vocals should be */
function vocalsLine(v: MusicSpec['vocals']): string {
  switch (v) {
    case 'none': return 'Instrumental only: no vocals, no lyrics, no choir, no spoken word.'
    case 'wordless': return 'Vocals are wanted but WORDLESS: voices as an instrument (chant, ooh/aah, ululation), with no sung lyrics and no spoken words.'
    case 'lyrics': return 'Sung vocals with lyrics are wanted.'
    case 'any': return 'Vocals are welcome (sung or wordless).'
  }
}

/** the brief ('' when the person wants no music) */
export function musicPrompt(spec: MusicSpec, totalSec: number, voiced: boolean): string {
  if (spec.none) return ''
  const total = Math.max(10, Math.round(totalSec))
  const lines: string[] = []
  const sings = spec.vocals !== 'none'
  lines.push(`${sings ? 'Background music with vocals' : 'Instrumental background music'} for a short film, about ${total} seconds long.`)
  if (spec.description.trim()) lines.push(`What the person asked for, in their words: ${spec.description.trim().replace(/[.\s]+$/, '')}.`)
  if (spec.genre?.trim()) lines.push(`Style: ${spec.genre.trim()}, authentic to that tradition.`)
  lines.push(vocalsLine(spec.vocals))
  if (spec.instruments.length) lines.push(`Use only these instruments and sounds: ${list(spec.instruments)}. Nothing else.`)
  if (spec.exclude.length) {
    lines.push(`Do not include: ${list(spec.exclude)}.`)
    // "no song" means no verse-and-chorus structure, which is not the same as no voices
    if (spec.exclude.some((e) => /\bsongs?\b/i.test(e))) lines.push('No song structure: no verses, no chorus, no hook. A continuous bed, not a song.')
  }
  if (spec.ambience.length) lines.push(`Natural sounds to include: ${list(spec.ambience)}.`)
  if (spec.quiet) lines.push('Keep it soft and low in the mix, never loud.')
  if (voiced) lines.push('A narrator speaks over most of it: stay steady, leave room for the voice, no big swells or drops while they talk.')
  lines.push(`Structure: [0:00 - ${mmss(Math.min(8, total / 4))}] gentle start, [${mmss(Math.min(8, total / 4))} - ${mmss(total * 0.85)}] steady body, [${mmss(total * 0.85)} - ${mmss(total)}] resolve and fade out cleanly at ${mmss(total)}.`)
  lines.push('Do not imitate any named artist, band or existing song.')
  return lines.join('\n')
}
