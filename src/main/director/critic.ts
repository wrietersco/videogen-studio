import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import type { SceneCraft, VideoSpec } from '@shared/spec'
import type { LLMProvider } from '../providers/types'
import type { RenderService } from '../rendererService/hyperframes'

/**
 * Vision critic — looks at the real rendered frames of every directed scene
 * (one late frame per scene, after its animations land) and grades it like a
 * motion-design lead: legibility, hierarchy, whether the metaphor reads,
 * whether text fights the picture. Low scores go back to the scene director
 * with the notes (one revision round, bounded).
 */

export interface SceneReview {
  sceneId: string
  index: number
  score: number
  notes: string[]
  revise: boolean
  needsManualRevision?: boolean
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: '1-10; 8+ = ship it' },
    notes: { type: 'array', items: { type: 'string' }, description: 'concrete, fixable problems (max 4), empty if none' },
    revise: { type: 'boolean' }
  },
  required: ['score', 'notes', 'revise']
}

const CRITIC_SYSTEM = `You are the motion-design lead reviewing one frame of a short-form explainer video before it ships.
The brief describes the whole film; judge the intended beat of this scene in context, and do not require every scene to contain every film-wide action.
Judge: Is every word legible and fully inside the frame? Does text collide with other text, widgets or the busy part of the picture?
Does the scene show the actual subject or process described in the narration? Would a viewer learn from the visual without reading all the text? Penalize generic diagrams, repeated widgets, empty space and slide-like treatments when concrete imagery or footage would communicate better.
Is the hierarchy clear, and does the visual actually explain the beat? A visual-led scene intentionally has no headline, deck or HUD; do not demand them if the image communicates the beat. The series title is shared across the whole film and any number in it can identify the film, not the current scene; do not infer a scene-number mismatch from it. Captions are timed short phrases: this is one frame, so do not assume a missing part of the narration is absent from the full video. Respect deliberate quiet space around the subject.
Is anything empty, broken, cut off or ugly? Are numbers plausible and consistent with the script?
Score 1-10. Set revise=true for fixable problems including missing or irrelevant imagery, weak scene direction, text, widgets or layout.
Notes must be specific and actionable ("headline wraps into 4 lines — cut to 6 words", "gauge value 78 contradicts caption's 60%").`

export async function reviewScenes(opts: {
  provider: LLMProvider
  renders: RenderService
  projectDir: string
  spec: VideoSpec
  userPrompt?: string
  onReview?: (r: SceneReview) => void
}): Promise<SceneReview[]> {
  const { provider, renders, projectDir, spec } = opts
  if (provider.id === 'mock') return []
  let acc = 0
  const times = spec.scenes.map((s) => {
    const t = acc + s.durationSec - Math.min(0.55, s.durationSec * 0.5)
    acc += s.durationSec
    return Math.round(t * 100) / 100
  })
  const outDir = join(projectDir, '.review')
  rmSync(outDir, { recursive: true, force: true })
  const frames = await renders.snapshot(projectDir, times, outDir)
  if (frames.length !== spec.scenes.length) return []

  const craftOf = new Map(spec.crafts.map((c) => [c.sceneId, c]))
  const reviews = await Promise.all(
    spec.scenes.map(async (scene, index): Promise<SceneReview | null> => {
      const craft = craftOf.get(scene.id)
      const native3D = spec.style === 'motion3d' && (scene.kind === 'showcase3d' || scene.kind === 'particles')
      const custom = Boolean(spec.customScenes?.some(c => c.sceneId === scene.id) || spec.customVideos?.some(c => c.sceneId === scene.id))
      if (!craft && !native3D) return null
      try {
        const jpeg = await sharp(readFileSync(frames[index])).resize({ width: 720 }).jpeg({ quality: 82 }).toBuffer()
        const narration = spec.narration.find((n) => n.sceneId === scene.id)?.text ?? ''
        const r = await provider.generateJSON<{ score: number; notes: string[]; revise: boolean }>({
          system: CRITIC_SYSTEM,
          prompt: JSON.stringify({ filmBrief: opts.userPrompt ?? spec.title, scene: `${index + 1} of ${spec.scenes.length}`, filmScenes: spec.scenes, narration, craft: custom ? { kind: 'custom-code', details: scene } : native3D ? { kind: scene.kind, details: scene } : craft ? summarize(craft) : null }),
          schemaName: 'SceneReview',
          jsonSchema: REVIEW_SCHEMA,
          images: [{ mimeType: 'image/jpeg', base64: jpeg.toString('base64') }],
          temperature: 0.2,
          maxTokens: 700
        })
        const score = Math.max(1, Math.min(10, Number(r.score) || 0))
        const notes = (Array.isArray(r.notes) ? r.notes : []).map(String).slice(0, 4)
        // a 7 with concrete notes still has fixable problems; 8+ ships as is
        const needsFix = score < 8 && notes.length > 0 && (Boolean(r.revise) || score <= 7)
        const review = { sceneId: scene.id, index, score, notes, revise: !native3D && !custom && needsFix, ...((native3D || custom) && needsFix ? { needsManualRevision: true } : {}) }
        opts.onReview?.(review)
        return review
      } catch {
        return null
      }
    })
  )
  return reviews.filter((r): r is SceneReview => r !== null)
}

function summarize(c: SceneCraft): Record<string, unknown> {
  return { headlineTreatment: c.headlineTreatment, headline: c.headline, accentWord: c.accentWord, deck: c.deck, background: c.background, widgets: c.widgets, caption: c.caption, hud: c.hud }
}
