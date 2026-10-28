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
Judge: Is every word legible and fully inside the frame? Does text collide with other text, widgets or the busy part of the picture?
Is the hierarchy clear (headline first, then the widget, then the caption)? Does the visual metaphor actually explain the beat?
Is anything empty, broken, cut off or ugly? Are numbers plausible and consistent with the script?
Score 1-10. Set revise=true only for problems a different headline, widget choice, widget data or layout choice would fix.
Notes must be specific and actionable ("headline wraps into 4 lines — cut to 6 words", "gauge value 78 contradicts caption's 60%").`

export async function reviewScenes(opts: {
  provider: LLMProvider
  renders: RenderService
  projectDir: string
  spec: VideoSpec
  onReview?: (r: SceneReview) => void
}): Promise<SceneReview[]> {
  const { provider, renders, projectDir, spec } = opts
  if (provider.id === 'mock') return []
  let acc = 0
  const times = spec.scenes.map((s) => {
    const t = acc + Math.max(s.durationSec * 0.82, s.durationSec - 0.6)
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
      if (!craft) return null
      try {
        const jpeg = await sharp(readFileSync(frames[index])).resize({ width: 720 }).jpeg({ quality: 82 }).toBuffer()
        const narration = spec.narration.find((n) => n.sceneId === scene.id)?.text ?? ''
        const r = await provider.generateJSON<{ score: number; notes: string[]; revise: boolean }>({
          system: CRITIC_SYSTEM,
          prompt: JSON.stringify({ scene: `${index + 1} of ${spec.scenes.length}`, narration, craft: summarize(craft) }),
          schemaName: 'SceneReview',
          jsonSchema: REVIEW_SCHEMA,
          images: [{ mimeType: 'image/jpeg', base64: jpeg.toString('base64') }],
          temperature: 0.2,
          maxTokens: 700
        })
        const score = Math.max(1, Math.min(10, Number(r.score) || 0))
        const notes = (Array.isArray(r.notes) ? r.notes : []).map(String).slice(0, 4)
        // a 7 with concrete notes still has fixable problems; 8+ ships as is
        const review = { sceneId: scene.id, index, score, notes, revise: score < 8 && notes.length > 0 && (Boolean(r.revise) || score <= 7) }
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
  return { headline: c.headline, accentWord: c.accentWord, deck: c.deck, background: c.background, widgets: c.widgets, caption: c.caption, hud: c.hud }
}
