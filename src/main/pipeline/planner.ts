import { z } from 'zod'
import { VideoSpec, PlatformId, StyleFamily, type VideoSpec as VideoSpecT } from '@shared/spec'
import { PLATFORM_PRESETS } from '@shared/presets'
import type { GenerateJSONRequest, LLMProvider } from '../providers/types'

/**
 * Planner — stage 1 of the pipeline. ONE schema-constrained LLM call:
 * freestyle prompt (+ optional images) → validated VideoSpec.
 *
 * The JSON Schema is derived from the zod spec itself, so the contract can
 * never drift between planner, composer, and editors.
 */

const PLANNER_SYSTEM = `You are the planning engine of a programmatic video generator.
You receive a freestyle user prompt (any video type, any topic, any vibe) and MUST respond
with a single JSON object conforming exactly to the provided VideoSpec schema.

Creative guidance:
- Think like a director: strong hook first, one idea per scene, satisfying close.
- Respect the platform preset given in the prompt (duration range, aspect, pacing bias).
- Pick palette/typography that serve the topic and mood; be intentional, never random.
- Scene kinds must match the chosen style family (3D scenes for motion3d, punchy text for social, structured flow for explainer).
- Narration lines must be speakable and synchronized with their scene's duration (roughly 2.5 words per second).
- Durations across scenes must sum to durationSec.
- Output ONLY the JSON object. No markdown, no commentary.`

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
}

let cachedSpecSchema: Record<string, unknown> | null = null
export function videoSpecJsonSchema(): Record<string, unknown> {
  cachedSpecSchema ??= zodToJsonSchema(VideoSpec)
  return cachedSpecSchema
}

export interface PlanInput {
  userPrompt: string
  platform: VideoSpecT['platform']
  styleHint?: VideoSpecT['style']
  durationHintSec?: number
  imageSummaries?: string[]
  model?: string
}

export class Planner {
  constructor(private readonly provider: LLMProvider) {}

  async plan(input: PlanInput): Promise<VideoSpecT> {
    const preset = PLATFORM_PRESETS[input.platform]
    const payload = {
      userPrompt: input.userPrompt,
      platform: input.platform,
      platformNotes: `${preset.label} (${preset.aspectLabel}, ${preset.width}×${preset.height}, ${preset.durationRange[0]}–${preset.durationRange[1]}s). ${preset.notes}`,
      styleHint: input.styleHint,
      durationHintSec: input.durationHintSec,
      imageSummaries: input.imageSummaries
    }

    const req: GenerateJSONRequest = {
      system: PLANNER_SYSTEM,
      prompt: JSON.stringify(payload),
      schemaName: 'VideoSpec',
      jsonSchema: videoSpecJsonSchema(),
      temperature: 0.8
    }

    const raw = await this.provider.generateJSON<unknown>(req)
    const spec = this.validate(raw)
    return this.clampToPlatform(spec)
  }

  /** Validation failure here is what triggers the fixer loop upstream. */
  private validate(raw: unknown): VideoSpecT {
    const result = VideoSpec.safeParse(raw)
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      throw new Error(`Planner produced an invalid VideoSpec — ${issues}`)
    }
    return result.data
  }

  /** Deterministic post-processing: platform clamps the LLM can get slightly wrong. */
  private clampToPlatform(spec: VideoSpecT): VideoSpecT {
    const preset = PLATFORM_PRESETS[spec.platform]
    const patched: VideoSpecT = {
      ...spec,
      fps: spec.fps ?? preset.fps,
      durationSec: Math.min(
        preset.durationRange[1],
        Math.max(preset.durationRange[0], spec.durationSec)
      ),
      captionStyle: {
        ...spec.captionStyle,
        position: spec.captionStyle.position ?? preset.captionPosition
      }
    }
    // rescale scene durations to the clamped total
    const sceneSum = patched.scenes.reduce((a, s) => a + s.durationSec, 0)
    if (Math.abs(sceneSum - patched.durationSec) > 0.05 && sceneSum > 0) {
      const k = patched.durationSec / sceneSum
      patched.scenes = patched.scenes.map((s) => ({
        ...s,
        durationSec: Math.max(1.0, Math.round(s.durationSec * k * 10) / 10)
      }))
    }
    patched.scenes = enforceReadabilityFloors(patched.scenes)
    patched.durationSec =
      Math.round(patched.scenes.reduce((a, s) => a + s.durationSec, 0) * 10) / 10
    return patched
  }
}

/**
 * Word-count duration floors — text needs ~0.3s per word on screen
 * (plus settle time) to be readable; QA's line_unread rule uses the same math.
 * Scenes above floor donate time; the total is preserved.
 */
function enforceReadabilityFloors(scenes: VideoSpecT['scenes']): VideoSpecT['scenes'] {
  const wordsOf = (s: (typeof scenes)[number]): number => {
    const parts: string[] = []
    if ('headline' in s && s.headline) parts.push(s.headline)
    if ('subline' in s && s.subline) parts.push(s.subline)
    if ('bullets' in s) parts.push(...s.bullets)
    if ('text' in s && s.text) parts.push(s.text)
    if ('context' in s && s.context) parts.push(s.context)
    if ('label' in s && s.label) parts.push(s.label)
    if ('action' in s && s.action) parts.push(s.action)
    return parts.join(' ').split(/\s+/).filter(Boolean).length
  }
  const floorOf = (s: (typeof scenes)[number]): number =>
    Math.min(4.6, 1.0 + 0.26 * wordsOf(s))

  const out = scenes.map((s) => ({
    ...s,
    durationSec: Math.max(s.durationSec, Math.round(floorOf(s) * 10) / 10)
  }))
  let excess = out.reduce((a, s) => a + s.durationSec, 0) - scenes.reduce((a, s) => a + s.durationSec, 0)
  if (excess <= 0) return out
  // trim the donation from the scenes with the most slack above floor
  const sorted = [...out.keys()].sort(
    (a, b) => out[b].durationSec - floorOf(out[b]) - (out[a].durationSec - floorOf(out[a]))
  )
  for (const i of sorted) {
    if (excess <= 0) break
    const slack = out[i].durationSec - floorOf(out[i])
    if (slack <= 0.3) continue
    const give = Math.min(slack - 0.3, excess)
    out[i].durationSec = Math.round((out[i].durationSec - give) * 10) / 10
    excess -= give
  }
  return out
}

/** Zod enums re-exported for editor dropdowns. */
export const PLATFORM_OPTIONS = PlatformId.options
export const STYLE_OPTIONS = StyleFamily.options
