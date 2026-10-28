import type { Scene, SceneCraft, VideoSpec } from '@shared/spec'

/**
 * Pure edit operations for the timeline editor. Every function returns a new
 * spec and never mutates its input, so the editor's undo stack is just a list
 * of specs. Narration, crafts and voice takes are keyed by scene id, so moving
 * or removing a scene only has to move or drop those entries.
 */

const clone = <T>(v: T): T => structuredClone(v)

export const craftOf = (spec: VideoSpec, sceneId: string): SceneCraft | undefined => spec.crafts.find((c) => c.sceneId === sceneId)

export const narrationOf = (spec: VideoSpec, sceneId: string): string =>
  spec.narration
    .filter((n) => n.sceneId === sceneId)
    .map((n) => n.text)
    .join(' ')

/** a rough read-aloud length (about 2.6 words a second) — the real value is measured at apply time */
export const speechEstimateSec = (text: string): number => Math.round((text.trim().split(/\s+/).filter(Boolean).length / 2.6) * 10) / 10

/** the line shown on screen for a scene: the director's headline, else the template's main text */
export function headlineOf(spec: VideoSpec, scene: Scene): string {
  const craft = craftOf(spec, scene.id)
  if (craft) return craft.headline
  if ('headline' in scene && scene.headline) return scene.headline
  if (scene.kind === 'stat') return `${scene.value} — ${scene.label}`
  if (scene.kind === 'quote') return scene.text
  return ''
}

export function setHeadline(spec: VideoSpec, sceneId: string, text: string): VideoSpec {
  const next = clone(spec)
  const craft = next.crafts.find((c) => c.sceneId === sceneId)
  if (craft) {
    craft.headline = text
    if (craft.accentWord && !text.toLowerCase().includes(craft.accentWord.toLowerCase())) craft.accentWord = ''
    return next
  }
  const scene = next.scenes.find((s) => s.id === sceneId)
  if (!scene) return spec
  if (scene.kind === 'stat') scene.label = text
  else if (scene.kind === 'quote') scene.text = text
  else if ('headline' in scene) (scene as { headline?: string }).headline = text
  return next
}

export function setNarration(spec: VideoSpec, sceneId: string, text: string): VideoSpec {
  const next = clone(spec)
  next.narration = next.narration.filter((n) => n.sceneId !== sceneId)
  if (text.trim()) {
    // keep the line next to its scene so the file stays readable
    const order = next.scenes.map((s) => s.id)
    const at = next.narration.findIndex((n) => order.indexOf(n.sceneId) > order.indexOf(sceneId))
    next.narration.splice(at < 0 ? next.narration.length : at, 0, { sceneId, text: text.trim() })
  }
  // a changed line must be re-voiced: drop its old take (its audio stays cached for an undo)
  next.voiceover = next.voiceover.filter((t) => t.sceneId !== sceneId)
  return next
}

export function setAccentWord(spec: VideoSpec, sceneId: string, word: string): VideoSpec {
  const next = clone(spec)
  const craft = next.crafts.find((c) => c.sceneId === sceneId)
  if (craft) craft.accentWord = word
  return next
}

/** change the picture brief — clearing the painted file makes apply repaint it */
export function setPicturePrompt(spec: VideoSpec, sceneId: string, prompt: string): VideoSpec {
  const next = clone(spec)
  const craft = next.crafts.find((c) => c.sceneId === sceneId)
  if (!craft?.plate) return spec
  craft.plate = { ...craft.plate, prompt, file: undefined, depthFile: undefined, anchor: undefined }
  Reflect.deleteProperty(craft.plate, 'clipFile') // a motion plate's clip is made from the new still
  return next
}

export function setCamera(spec: VideoSpec, sceneId: string, camera: NonNullable<SceneCraft['plate']>['camera']): VideoSpec {
  const next = clone(spec)
  const craft = next.crafts.find((c) => c.sceneId === sceneId)
  if (craft?.plate) craft.plate.camera = camera
  return next
}

/** picture on/off: off keeps the brief so it can be switched back (and repainted) */
export function setPictureOn(spec: VideoSpec, sceneId: string, on: boolean): VideoSpec {
  const next = clone(spec)
  const craft = next.crafts.find((c) => c.sceneId === sceneId)
  if (!craft) return spec
  craft.background = on && craft.plate ? 'plate' : 'grid'
  return next
}

export function setTransition(spec: VideoSpec, sceneId: string, t: Scene['transitionIn']): VideoSpec {
  const next = clone(spec)
  const scene = next.scenes.find((s) => s.id === sceneId)
  if (scene) scene.transitionIn = t
  return next
}

const total = (scenes: Scene[]) => Math.round(scenes.reduce((a, s) => a + s.durationSec, 0) * 100) / 100

/** only meaningful for scenes with no narration — voiced scenes are timed to their voice */
export function setDuration(spec: VideoSpec, sceneId: string, sec: number): VideoSpec {
  const next = clone(spec)
  const scene = next.scenes.find((s) => s.id === sceneId)
  if (!scene) return spec
  scene.durationSec = Math.max(1, Math.min(30, Math.round(sec * 10) / 10))
  next.durationSec = total(next.scenes)
  return next
}

export function moveScene(spec: VideoSpec, from: number, to: number): VideoSpec {
  if (from === to || from < 0 || to < 0 || from >= spec.scenes.length || to >= spec.scenes.length) return spec
  const next = clone(spec)
  const [s] = next.scenes.splice(from, 1)
  next.scenes.splice(to, 0, s)
  return next
}

export function removeScene(spec: VideoSpec, sceneId: string): VideoSpec {
  if (spec.scenes.length <= 1) return spec
  const next = clone(spec)
  next.scenes = next.scenes.filter((s) => s.id !== sceneId)
  next.narration = next.narration.filter((n) => n.sceneId !== sceneId)
  next.crafts = next.crafts.filter((c) => c.sceneId !== sceneId)
  next.voiceover = next.voiceover.filter((t) => t.sceneId !== sceneId)
  next.durationSec = total(next.scenes)
  return next
}

/** copy a scene right after itself (new id, same words and picture) */
export function duplicateScene(spec: VideoSpec, sceneId: string): VideoSpec {
  const at = spec.scenes.findIndex((s) => s.id === sceneId)
  if (at < 0) return spec
  const next = clone(spec)
  let n = 2
  while (next.scenes.some((s) => s.id === `${sceneId}-copy${n}`)) n += 1
  const id = `${sceneId}-copy${n}`
  next.scenes.splice(at + 1, 0, { ...clone(next.scenes[at]), id })
  const craft = next.crafts.find((c) => c.sceneId === sceneId)
  if (craft) next.crafts.push({ ...clone(craft), sceneId: id })
  const line = narrationOf(next, sceneId)
  if (line) next.narration.push({ sceneId: id, text: line })
  next.durationSec = total(next.scenes)
  return next
}

/** how many separate things differ — shown on the Apply button */
export function changeCount(a: VideoSpec, b: VideoSpec): number {
  let n = 0
  const ids = (s: VideoSpec) => s.scenes.map((x) => x.id)
  if (ids(a).join() !== ids(b).join()) n += 1
  for (const s of b.scenes) {
    const old = a.scenes.find((x) => x.id === s.id)
    if (!old) {
      n += 1
      continue
    }
    if (JSON.stringify(old) !== JSON.stringify(s)) n += 1
    if (narrationOf(a, s.id) !== narrationOf(b, s.id)) n += 1
    if (JSON.stringify(a.crafts.find((c) => c.sceneId === s.id)) !== JSON.stringify(b.crafts.find((c) => c.sceneId === s.id))) n += 1
  }
  return n + a.scenes.filter((x) => !b.scenes.some((s) => s.id === x.id)).length
}

/** estimated finished length: voiced scenes follow their line, others keep their set length */
export function estimateDuration(spec: VideoSpec): number {
  let sum = 0
  for (const s of spec.scenes) {
    const line = narrationOf(spec, s.id)
    const take = spec.voiceover.find((t) => t.sceneId === s.id)
    sum += take ? s.durationSec : line ? Math.max(2, speechEstimateSec(line) + 0.7) : s.durationSec
  }
  return Math.round(sum * 10) / 10
}
