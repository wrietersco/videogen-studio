import { PLATFORM_PRESETS } from '../shared/presets'
import type { PlatformId, StyleFamily } from '../shared/spec'
import { DEFAULT_SECTIONS, assemblePrompt, type EnhancedPrompt, type EnhancedSection, type PromptSection } from '../shared/promptTemplates'
import type { LLMProvider } from './providers/types'
import { isIsometricOnlyBrief } from './pipeline/orchestrator'

/**
 * Prompt enhancer — turns a rough idea into the labelled brief the pipeline
 * reads best. The planner splits it into scenes, the creative agent reads the
 * format, and the director picks visuals per beat, so the brief spells out a
 * hook, concrete showable beats, visuals and tone. One chat call on the
 * user's own model; an offline tidy-up when no model is available.
 */

export interface EnhanceRequest {
  idea: string
  platform?: PlatformId
  styleHint?: StyleFamily
  durationSec?: number
  /** structure to follow (a saved template); default = the house structure */
  sections?: PromptSection[]
}

const SYSTEM = `You turn a person's rough video idea into a production brief for an automated video generator.
How the generator reads the brief: a planner splits it into scenes (one idea per scene) and writes narration at about 1.6 words per second; a creative agent reads the platform, length and style; a scene director then picks visuals for each scene — photos or painted stills, stock or generated footage, diagrams, charts, kinetic text, 3D objects, or code-drawn isometric animation.
Write the brief so each of those stages has what it needs:
- Keep every fact, name, number, quote, brand, platform, length and constraint the person gave. Keep exact wording for names and quotes.
- Never invent statistics, prices, dates, testimonials or claims. When a fact would help, describe the kind of fact to show instead.
- Story beats: a numbered list, one concrete on-screen moment per beat (a subject doing something that can be shown), in viewing order, sized to the requested length.
- The app sends the format, length and style to the generator separately: do not restate them, platform notes or the number of beats inside the sections, and never state a length the person did not give. Keep a platform or length the person wrote themselves.
- Visual style: propose a concrete look that suits the idea and audience (colours, kind of imagery, motion), never "no style chosen".
- Must include and Avoid: only specifics from the idea or essential to it, not generic production advice; leave them empty otherwise.
- Do not add visual modes the person did not ask for. Only mention isometric animation if the person asked for it; if they asked for a whole isometric film, say "the whole film is isometric animation" in Visual style. Respect requests for no photos, no footage or no narration.
- Write in the person's language, plainly, with no markdown, emoji or headings inside the content.
- For each section also write a hint: short, reusable guidance for what that section should contain for ANY idea, with no topic-specific details.
- Title: a short working title for the video.
Use the section labels you are given, exactly and in order. Leave a section's content empty only when nothing sensible applies (for example Must include or Avoid).`

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, content: { type: 'string' }, hint: { type: 'string' } },
        required: ['label', 'content', 'hint'],
        additionalProperties: false
      }
    }
  },
  required: ['title', 'sections'],
  additionalProperties: false
}

/** about one scene every 5–8 seconds, the planner's natural rhythm */
export function beatCount(durationSec: number): number {
  return Math.max(3, Math.min(10, Math.round(durationSec / 6)))
}

export async function enhancePrompt(provider: LLMProvider, req: EnhanceRequest): Promise<EnhancedPrompt> {
  const idea = req.idea.trim()
  if (!idea) throw new Error('Type your idea first, then enhance it.')
  const sections = req.sections?.length ? req.sections : DEFAULT_SECTIONS
  if (provider.id === 'mock') return basicEnhance(req, sections, 'Basic tidy-up. Connect an AI provider in Settings for a full rewrite.')
  const preset = req.platform ? PLATFORM_PRESETS[req.platform] : undefined
  const duration = req.durationSec ?? preset?.defaultDuration
  try {
    const out = await provider.generateJSON<{ title: string; sections: EnhancedSection[] }>({
      system: SYSTEM,
      prompt: JSON.stringify({
        idea,
        format: preset ? `${preset.label} ${preset.aspectLabel}` : 'chosen later by the creative agent',
        style: req.styleHint ?? 'chosen later',
        durationSec: req.durationSec ?? 'chosen later; do not state one',
        storyBeats: duration ? beatCount(duration) : 'about 5',
        sections: sections.map((s) => ({ label: s.label, guidance: s.hint }))
      }),
      schemaName: 'EnhancedBrief',
      jsonSchema: SCHEMA,
      temperature: 0.5,
      maxTokens: 2000
    })
    return finish(idea, String(out.title ?? ''), alignSections(sections, out.sections ?? []), 'ai')
  } catch (err) {
    return basicEnhance(req, sections, `The AI rewrite was unavailable (${String((err as Error)?.message ?? err).slice(0, 120)}), so this is a basic tidy-up.`)
  }
}

/** keep the requested structure even when the model renames, drops or adds sections */
export function alignSections(wanted: PromptSection[], got: EnhancedSection[]): EnhancedSection[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')
  return wanted.map((w, i) => {
    const match = got.find((g) => norm(g.label ?? '') === norm(w.label)) ?? (got.length === wanted.length ? got[i] : undefined)
    return { label: w.label, content: String(match?.content ?? '').trim(), hint: String(match?.hint ?? '').trim() || w.hint }
  })
}

function finish(idea: string, title: string, sections: EnhancedSection[], source: EnhancedPrompt['source'], note?: string): EnhancedPrompt {
  // the word "isometric" switches the whole film to code-only visuals: never
  // let a rewrite turn that on, or silently drop it, against the person's idea
  const wantsIso = isIsometricOnlyBrief(idea)
  let out = sections.map((s) => ({ ...s, content: wantsIso ? s.content : s.content.replace(/\bisometric(ally)?\b/gi, 'illustrated') }))
  let prompt = assemblePrompt(out)
  if (wantsIso && !isIsometricOnlyBrief(prompt)) {
    const i = Math.max(0, out.findIndex((s) => /visual/i.test(s.label)))
    out = out.map((s, j) => (j === i ? { ...s, content: `${s.content ? `${s.content} ` : ''}The whole film is isometric animation.`.trim() } : s))
    prompt = assemblePrompt(out)
  }
  if (!out.some((s) => s.content)) return basicEnhance({ idea }, out, note)
  return { title: title.trim().slice(0, 80) || idea.slice(0, 48), sections: out, prompt, source, ...(note ? { note } : {}) }
}

const STYLE_WORDS: Partial<Record<StyleFamily, { goal: string; visual: string; tone: string }>> = {
  social: { goal: 'Grab attention fast and make people want to share it', visual: 'Bold kinetic text, quick cuts, bright accent colours', tone: 'High energy, punchy short lines' },
  explainer: { goal: 'Help viewers clearly understand the topic', visual: 'Clean diagrams, labels and supporting pictures for each step', tone: 'Friendly, clear and calm, in plain words' },
  motion3d: { goal: 'Leave a premium, cinematic impression', visual: 'Shiny 3D objects, slow camera moves, particles and glow', tone: 'Confident and minimal' },
  cinematic: { goal: 'Tell a moving visual story', visual: 'Cinematic stills and footage with a consistent colour grade', tone: 'Warm, measured narration' },
  documentary: { goal: 'Tell a true story with weight', visual: 'Documentary stills, maps and archival-style footage', tone: 'Serious, measured narrator' }
}

/** offline: structure what the person wrote, without inventing anything */
export function basicEnhance(req: EnhanceRequest, sections: PromptSection[], note?: string): EnhancedPrompt {
  const idea = req.idea.trim().replace(/\s+/g, ' ')
  const words = req.styleHint ? STYLE_WORDS[req.styleHint] : undefined
  const duration = req.durationSec ?? (req.platform ? PLATFORM_PRESETS[req.platform].defaultDuration : undefined)
  const fill = (label: string, i: number): string => {
    const l = label.toLowerCase()
    if (i === 0 || /^(video|topic|idea|subject)/.test(l)) return idea
    if (/goal|purpose/.test(l)) return words?.goal ?? ''
    if (/hook|opening/.test(l)) return 'Open with the most surprising or exciting part of the idea in the first two seconds'
    if (/beat|scene|chapter|steps?/.test(l)) return `${duration ? `${beatCount(duration)} ` : ''}short scenes, one idea each, building to the ending`
    if (/visual|look/.test(l)) return words?.visual ?? ''
    if (/tone|narrat|voice/.test(l)) return words?.tone ?? ''
    if (/ending|cta|call to action|close/.test(l)) return 'Close with one clear takeaway'
    return ''
  }
  const filled = sections.map((s, i) => ({ label: s.label, hint: s.hint, content: fill(s.label, i) }))
  return { title: idea.slice(0, 48), sections: filled, prompt: assemblePrompt(filled), source: 'basic', ...(note ? { note } : {}) }
}
