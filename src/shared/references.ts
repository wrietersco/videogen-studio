import { tokenize } from './assets'
import { brandAccents, HEX, luminanceOf, rgbOf } from './brand'
import type { CraftMedia, FilmDesign, Palette, RefImage, RefRole, SceneCraft, StyleBrief, VideoBrief, VideoSpec } from './spec'

/**
 * Reference pictures — pure rules. Which role a picture probably has, how a
 * style brief changes the colors, and which scene shows which picture. The
 * same inputs always give the same video.
 */

export const MAX_REFS = 6
export const MAX_STYLE_REFS = 3

export const ROLE_LABEL: Record<RefRole, { short: string; long: string; does: string }> = {
  style: { short: 'Look to copy', long: 'Style', does: 'The look (colors, mood, lighting) guides the whole video. The picture itself is not shown.' },
  subject: { short: 'Product to show', long: 'Subject', does: 'Shown as itself in one scene. It is never redrawn.' },
  content: { short: 'Screenshot to show', long: 'Content', does: 'Shown as itself, in a window frame, in one scene.' }
}

/** a first guess at the role; the person confirms it on a chip */
export function suggestRole(f: { name: string; width: number; height: number; alpha: boolean }): RefRole {
  if (f.alpha) return 'subject'
  if (/screen\s*shot|screen\s*cap|capture|dashboard|\bui\b|\bapp\b|interface|window/i.test(f.name)) return 'content'
  return 'style'
}

// ---------------------------------------------------------------- style → colors

/** the most vivid colors first: a mood board's backgrounds and greys make poor accents */
export function vividFirst(palette: string[]): string[] {
  const score = (hex: string): number => {
    const [r, g, b] = rgbOf(hex)
    const hi = Math.max(r, g, b)
    const lo = Math.min(r, g, b)
    const sat = hi === 0 ? 0 : (hi - lo) / hi
    const l = luminanceOf(hex)
    return sat * (0.4 + Math.min(1, l * 3)) * (l > 0.92 ? 0.3 : 1)
  }
  return palette.filter((c) => HEX.test(c)).sort((a, b) => score(b) - score(a))
}

/** two accents from a style brief, made readable on `bg`; null when the brief has no usable color */
export function accentsFromBrief(brief: StyleBrief | undefined, bg: string): { accent: string; accent2: string } | null {
  const v = vividFirst(brief?.palette ?? [])
  if (!v.length) return null
  return brandAccents({ primary: v[0], secondary: v[1] }, bg)
}

const DIRECTED_BG = '#090D18'

/** the film director's design, steered by the style brief (art direction + accents) */
export function designWithStyle(design: FilmDesign, brief: StyleBrief | undefined): FilmDesign {
  if (!brief) return design
  const accents = accentsFromBrief(brief, DIRECTED_BG)
  const direction = [brief.imageStyle, brief.lighting && !brief.imageStyle.toLowerCase().includes(brief.lighting.toLowerCase()) ? `${brief.lighting}.` : ''].filter(Boolean).join(' ').trim()
  return {
    ...design,
    imageStyle: direction ? direction.slice(0, 400) : design.imageStyle,
    ...(accents ?? {})
  }
}

/** classic (template) films take the accents too */
export function paletteWithStyle(palette: Palette, brief: StyleBrief | undefined): Palette {
  const accents = accentsFromBrief(brief, palette.bg)
  return accents ? { ...palette, ...accents } : palette
}

// ---------------------------------------------------------------- reference video

/** how many scenes a reference's rhythm suggests for this length (null = no opinion) */
export function videoSceneBudget(brief: Pick<VideoBrief, 'cutsPerMinute'> | undefined, totalSec: number): number | null {
  if (!brief || !(brief.cutsPerMinute > 0)) return null
  return Math.max(3, Math.min(10, Math.round(((brief.cutsPerMinute * totalSec) / 60) / 1.5)))
}

/** put a confirmed video brief on the spec: pace, captions, music energy and accents (never script, footage or music) */
export function applyVideoBrief(spec: VideoSpec, brief: VideoBrief): VideoSpec {
  const accents: StyleBrief = { palette: brief.palette, mood: '', composition: '', lighting: '', imageStyle: '', source: 'local' }
  const musicMood = brief.musicEnergy === 'low' ? 'minimal' : brief.musicEnergy === 'high' && !['upbeat', 'playful'].includes(spec.musicMood) ? 'upbeat' : spec.musicMood
  return {
    ...spec,
    videoBrief: brief,
    pacing: brief.pacing,
    musicMood,
    palette: paletteWithStyle(spec.palette, accents),
    captionStyle: brief.captions === 'none' ? { ...spec.captionStyle, enabled: false } : { ...spec.captionStyle, enabled: true, uppercase: brief.captions === 'big' }
  }
}

/** the lines shown before generating: what the app learned and what it will do with it */
export function videoSummary(brief: VideoBrief, totalSec: number): string[] {
  const scenes = videoSceneBudget(brief, totalSec)
  const out = [`${brief.pacing[0].toUpperCase()}${brief.pacing.slice(1)} pace${scenes ? `, about ${scenes} scenes for ${totalSec} seconds` : ''}`]
  if (brief.captions !== 'small') out.push(brief.captions === 'big' ? 'Big on-screen captions' : 'No captions')
  if (brief.palette.length) out.push(`Colors from the video: ${brief.palette.slice(0, 3).join(' ')}`)
  out.push('It guides the rhythm and look only: the script, footage and music are never copied')
  return out
}

// ---------------------------------------------------------------- placement

const FILE = /^assets\/refs\/ref-\d{1,2}\.(jpg|png)$/

function fitFor(ref: RefImage): CraftMedia['fit'] {
  return ref.role === 'content' ? 'frame' : ref.alpha ? 'float' : 'cover'
}

/** words describing a picture: the person's note, the model's one-liner, then the file name */
function refWords(ref: RefImage): Set<string> {
  return new Set(tokenize(`${ref.note} ${ref.note} ${ref.about} ${ref.name.replace(/\.[a-z0-9]+$/i, '')}`))
}

function sceneWords(spec: VideoSpec, craft: SceneCraft): Set<string> {
  const scene = spec.scenes.find((s) => s.id === craft.sceneId)
  const narration = spec.narration.find((n) => n.sceneId === craft.sceneId)?.text ?? ''
  const own = scene ? Object.values(scene).filter((v): v is string => typeof v === 'string').join(' ') : ''
  return new Set(tokenize(`${craft.headline} ${craft.deck} ${craft.caption} ${narration} ${own}`))
}

/**
 * Give every subject and content picture a scene. A picture goes where the
 * words match (its note or description against a scene's headline and
 * narration); otherwise the first product opens the film and the rest are
 * spread evenly. Scenes keep their headline, deck and caption, but lose
 * their widgets: the picture owns the middle of the frame.
 *
 * Safe to run again after any scene is re-directed.
 */
export function placeReferences(spec: VideoSpec): SceneCraft[] {
  const items = [...spec.refs.filter((r) => r.role === 'subject'), ...spec.refs.filter((r) => r.role === 'content')].filter((r) => FILE.test(r.file))
  const base = spec.crafts.map((c) => (c.media ? { ...c, media: undefined } : c))
  if (!items.length) return base
  const taken = new Set([...(spec.customScenes ?? []).map((c) => c.sceneId), ...(spec.customVideos ?? []).map((c) => c.sceneId)])
  const eligible = base.filter((c) => !taken.has(c.sceneId))
  const n = eligible.length
  if (!n) return base
  const words = eligible.map((c) => sceneWords(spec, c))
  const used = new Set<number>()
  const pick = new Map<string, number>()

  // 1) words that match
  const scored: Array<{ ref: RefImage; scene: number; score: number }> = []
  for (const ref of items) {
    const rw = refWords(ref)
    if (!rw.size) continue
    words.forEach((sw, i) => {
      let hit = 0
      for (const w of rw) if (sw.has(w)) hit += 1
      if (hit > 0) scored.push({ ref, scene: i, score: hit })
    })
  }
  scored.sort((a, b) => b.score - a.score || a.scene - b.scene)
  for (const s of scored) {
    if (pick.has(s.ref.id) || used.has(s.scene)) continue
    pick.set(s.ref.id, s.scene)
    used.add(s.scene)
  }

  // 2) the rest: the first product opens the film, everything else is spread
  const free = (i: number): number => {
    for (let d = 0; d < n; d++) for (const j of [i + d, i - d]) if (j >= 0 && j < n && !used.has(j)) return j
    return -1
  }
  const rest = items.filter((r) => !pick.has(r.id))
  rest.forEach((ref, j) => {
    const openFilm = j === 0 && ref.role === 'subject' && !used.has(0)
    const target = openFilm ? 0 : Math.floor(((j + 0.5) * n) / rest.length)
    const at = free(target)
    if (at < 0) return
    pick.set(ref.id, at)
    used.add(at)
  })

  const mediaBySceneId = new Map<string, CraftMedia>()
  for (const ref of items) {
    const at = pick.get(ref.id)
    if (at === undefined) continue
    mediaBySceneId.set(eligible[at].sceneId, { refId: ref.id, file: ref.file, fit: fitFor(ref), width: ref.width, height: ref.height })
  }
  return base.map((c) => {
    const media = mediaBySceneId.get(c.sceneId)
    return media ? { ...c, media, background: 'grid' as const, plate: undefined, widgets: [], headlineTreatment: undefined } : c
  })
}

/** one line per thing the app will do with these pictures — shown before generating */
export function referenceSummary(refs: Array<{ role: RefRole }>, opts: { programmatic: boolean }): string[] {
  const n = (r: RefRole) => refs.filter((x) => x.role === r).length
  const out: string[] = []
  const s = n('style')
  if (s) out.push(opts.programmatic ? `Colors read from ${s === 1 ? 'your style picture' : `${s} style pictures`} on this computer (nothing is sent)` : `The AI reads the look of ${s === 1 ? 'your style picture' : `${s} style pictures`}: colors, mood, lighting`)
  if (n('subject')) out.push(`${n('subject')} product ${n('subject') === 1 ? 'picture' : 'pictures'} shown as ${n('subject') === 1 ? 'itself' : 'themselves'}, never redrawn`)
  if (n('content')) out.push(`${n('content')} screenshot${n('content') === 1 ? '' : 's'} shown as ${n('content') === 1 ? 'itself' : 'themselves'} in a window frame`)
  return out
}
