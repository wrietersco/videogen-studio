import { z } from 'zod'
import { VideoSpec, Scene, PlatformId, StyleFamily, type VideoSpec as VideoSpecT } from '@shared/spec'
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
- For a process, plan visually distinct steps that can each be shown; do not cram several physical actions into one scene and assume a single still will show them. Condense narration or omit nonessential setup to fit the requested length.
- Respect the platform preset given in the prompt (duration range, aspect, pacing bias).
- Pick palette/typography that serve the topic and mood; be intentional, never random.
- Scene kinds must match the chosen style family (3D scenes for motion3d, punchy text for social, structured flow for explainer).
- Visual rhythm: vary scene kinds — never use the same kind more than twice in a row; alternate hero moments with informational ones.
- Narration must fit naturally with breathing room and scene transitions. Aim for no more than 1.6 words per second of the requested total duration, and write fewer, concise lines instead of increasing the requested runtime.
- Durations across scenes must sum to durationSec.
- Output ONLY the JSON object. No markdown, no commentary.`

function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
}

let cachedSpecSchema: Record<string, unknown> | null = null
export function videoSpecJsonSchema(): Record<string, unknown> {
  // design + crafts belong to the scene director, never the planner
  cachedSpecSchema ??= zodToJsonSchema(VideoSpec.omit({ design: true, crafts: true, voice: true, voiceover: true, customScenes: true, customVideos: true }))
  return cachedSpecSchema
}

let cachedSceneSchema: Record<string, unknown> | null = null
export function sceneJsonSchema(): Record<string, unknown> {
  cachedSceneSchema ??= zodToJsonSchema(Scene)
  return cachedSceneSchema
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

    let raw = await this.provider.generateJSON<unknown>(req)
    const enforceChoices = (value: VideoSpecT): VideoSpecT => ({ ...value, platform: input.platform, ...(input.styleHint ? { style: input.styleHint } : {}) })
    let first: VideoSpecT | undefined
    let validationError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try { first = this.clampToPlatform(enforceChoices(this.validate(raw))); break }
      catch (err) {
        validationError = err
        if (attempt === 2) break
        raw = await this.provider.generateJSON<unknown>({ ...req, prompt: JSON.stringify({ ...payload, correction: `The previous plan was invalid: ${String((err as Error)?.message ?? err).slice(0, 1200)}. Return a corrected complete plan matching the schema and preserve the requested content.` }), temperature: 0.2 })
      }
    }
    if (!first) throw validationError

    // Do not silently accept an overlong plan: ask the same
    // selected model to simplify the story rather than making text unreadable.
    if (input.durationHintSec && Number.isFinite(input.durationHintSec)) {
      const target = Math.max(preset.durationRange[0], Math.min(preset.durationRange[1], input.durationHintSec))
      if (first.durationSec > target + 0.25 && this.provider.id !== 'mock') {
        try {
          const retry = await this.provider.generateJSON<unknown>({ ...req, prompt: JSON.stringify({ ...payload, correction: `The prior plan became ${first.durationSec}s, exceeding the ${target}s request. Replan for at most ${target} seconds with at most ${Math.max(2, Math.floor(target / 3))} concise scenes. Condense the narration to at most ${Math.floor(target * 1.8)} words total. Show the essential visual steps; omit anything that does not fit. Keep the scene durations and text readable.` }), temperature: 0.3 })
          const revised = this.clampToPlatform(enforceChoices(this.validate(retry)))
          if (Math.abs(revised.durationSec - target) < Math.abs(first.durationSec - target)) return revised
        } catch { /* keep the valid original plan */ }
      }
    }
    return first
  }

  /** Validation failure here is what triggers the fixer loop upstream. */
  private validate(raw: unknown): VideoSpecT {
    // These fields are created only by later engine stages. Never accept
    // planner-supplied code, file paths, paid-media references or voice takes.
    const candidate = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...raw, design: undefined, crafts: undefined, voice: undefined, voiceover: undefined, customScenes: undefined, customVideos: undefined }
      : raw
    // Music is optional presentation metadata: an invented mood must not
    // prevent an otherwise valid film from being created.
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const plan = candidate as Record<string, unknown>
      if (plan.musicMood !== undefined && !['upbeat', 'cinematic', 'minimal', 'playful', 'dark', 'corporate', 'none'].includes(String(plan.musicMood))) {
        const mood = String(plan.musicMood).toLowerCase()
        plan.musicMood = /none|silent|no music/.test(mood) ? 'none' : /cinema|epic|emotional|nostalg/.test(mood) ? 'cinematic' : /happy|energetic|upbeat/.test(mood) ? 'upbeat' : /playful|fun/.test(mood) ? 'playful' : /dark|ominous/.test(mood) ? 'dark' : /corporate|business/.test(mood) ? 'corporate' : 'minimal'
      }
    }
    const result = VideoSpec.safeParse(candidate)
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 8)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      throw new Error(`Planner produced an invalid VideoSpec — ${issues}`)
    }
    return result.data
  }

  /**
   * Per-scene feedback loop: ONE focused LLM call that rewrites a single scene
   * of an existing spec. Cheap even for small models — the film context and
   * scene schema keep it on the rails, and everything downstream (compose, QA,
   * thumbs, render) is deterministic.
   */
  async reviseScene(input: { spec: VideoSpecT; sceneId: string; feedback: string }): Promise<VideoSpecT> {
    const { spec, sceneId, feedback } = input
    const idx = spec.scenes.findIndex((s) => s.id === sceneId)
    if (idx < 0) throw new Error(`scene ${sceneId} not found`)
    const current = spec.scenes[idx]

    const neighbors = spec.scenes.map((s, i) => ({
      position: i === idx ? 'THIS scene (the one to rewrite)' : i < idx ? 'earlier scene (context only)' : 'later scene (context only)',
      kind: s.kind,
      summary: 'headline' in s && s.headline ? s.headline : 'value' in s ? `${s.value} ${s.label}` : 'text' in s ? s.text : s.kind
    }))

    const payload = {
      filmTitle: spec.title,
      overallStyle: `${spec.style} · pacing ${spec.pacing} · palette ${spec.palette.bg}/${spec.palette.accent}/${spec.palette.accent2}`,
      platform: spec.platform,
      scenePosition: `scene ${idx + 1} of ${spec.scenes.length}`,
      neighbors,
      currentScene: current,
      userFeedback: feedback,
      rules: [
        'Rewrite ONLY this one scene. Return a single scene JSON object matching the Scene schema exactly.',
        'Same "id" as the current scene. Keep or change "kind" — every kind is renderable.',
        'Honor the user feedback above all; keep what the feedback does not ask to change.',
        'Text must stay concise and screen-readable (headlines ≤ 8 words, bullets ≤ 8 per scene, bullets ≤ 8 words each).',
        `durationSec between 2 and ${Math.max(6, Math.round(current.durationSec * 2))} seconds.`,
        'Output ONLY the JSON object. No markdown, no commentary.'
      ]
    }

    const REVISE_SYSTEM = `You are the revision engine of a programmatic video generator.
You receive the full context of an existing video (its scenes, style, platform) plus the JSON
of ONE scene and the user's feedback about it. Rewrite that single scene as directed.
Be a good director: concrete visuals, strong on-screen text, honest pacing.`
    const req: GenerateJSONRequest = {
      system: REVISE_SYSTEM,
      prompt: JSON.stringify(payload),
      schemaName: 'Scene',
      jsonSchema: sceneJsonSchema(),
      temperature: 0.8
    }

    const raw = await this.provider.generateJSON<unknown>(req)
    const parsed = Scene.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 6)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')
      throw new Error(`Revised scene failed validation — ${issues}`)
    }
    // deterministic guards: pin the id, clamp the duration, respect the readability floor
    const minDur = 2
    const maxDur = Math.max(6, Math.round(current.durationSec * 2 * 10) / 10)
    let revised = { ...parsed.data, id: sceneId } as VideoSpecT['scenes'][number]
    revised.durationSec = Math.min(maxDur, Math.max(minDur, Math.round(revised.durationSec * 10) / 10))
    const textWords = [
      'headline' in revised && revised.headline ? revised.headline : '',
      'subline' in revised && revised.subline ? revised.subline : '',
      'bullets' in revised ? revised.bullets.join(' ') : '',
      'text' in revised && revised.text ? revised.text : ''
    ]
      .join(' ')
      .split(/\s+/)
      .filter(Boolean).length
    revised.durationSec = Math.max(revised.durationSec, Math.round(Math.min(4.6, 1.0 + 0.26 * textWords) * 10) / 10)

    const scenes = spec.scenes.map((s, i) => (i === idx ? revised : s))
    return {
      ...spec,
      scenes,
      durationSec: Math.round(scenes.reduce((a, s) => a + s.durationSec, 0) * 10) / 10
    }
  }

  /** Deterministic post-processing: platform clamps the LLM can get slightly wrong. */
  private clampToPlatform(spec: VideoSpecT): VideoSpecT {
    const preset = PLATFORM_PRESETS[spec.platform]
    const patched: VideoSpecT = {
      ...spec,
      typography: {
        ...spec.typography,
        display: bundledFont(spec.typography.display, 'display'),
        body: bundledFont(spec.typography.body, 'body')
      },
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

/** families the composer ships as local font files */
const BUNDLED_FONTS = ['Archivo Black', 'Inter', 'Space Grotesk', 'Playfair Display', 'Nunito']

/**
 * Small models sometimes write a description ("condensed bold sans-serif")
 * where a family name belongs; an unknown family would fall back to a generic
 * face at render time. Map anything unbundled onto the closest bundled family.
 */
export function bundledFont(value: string, role: 'display' | 'body'): string {
  const primary = (value ?? '').split(',')[0].trim().replace(/['"]/g, '')
  const hit = BUNDLED_FONTS.find((f) => f.toLowerCase() === primary.toLowerCase())
  if (hit) return value
  const v = (value ?? '').toLowerCase()
  const family =
    /serif/.test(v) && !/sans/.test(v)
      ? 'Playfair Display'
      : /round|friendly|playful/.test(v)
        ? 'Nunito'
        : /geometric|grotesk|tech|mono/.test(v)
          ? 'Space Grotesk'
          : role === 'display' && /bold|black|heavy|condensed|impact|display/.test(v)
            ? 'Archivo Black'
            : 'Inter'
  return `${family}, ${family === 'Playfair Display' ? 'serif' : 'sans-serif'}`
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
