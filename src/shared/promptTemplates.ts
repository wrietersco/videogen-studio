import type { PlatformId, StyleFamily } from './spec'

/**
 * Prompt templates — the section structure of a well-formed video brief.
 * The prompt enhancer writes briefs in this labelled shape (the planner,
 * creative agent and scene director all read it well), and people can save
 * the structure of a brief they liked to reuse with their next idea.
 */

export interface PromptSection {
  label: string
  /** what belongs in this section, shown as guidance when filling it in */
  hint: string
}

export interface PromptTemplate {
  id: string
  name: string
  emoji: string
  sections: PromptSection[]
  /** format choices saved with the template; absent = keep the current picks */
  platform?: PlatformId
  style?: StyleFamily
  durationSec?: number
  builtin?: boolean
  createdAt: string
}

export interface EnhancedSection {
  label: string
  content: string
  hint: string
}

export interface EnhancedPrompt {
  title: string
  sections: EnhancedSection[]
  /** the assembled brief, ready to send to the pipeline */
  prompt: string
  /** 'ai' = rewritten by the chosen language model · 'basic' = offline tidy-up */
  source: 'ai' | 'basic'
  note?: string
}

/** the house structure, used when no template is chosen */
export const DEFAULT_SECTIONS: PromptSection[] = [
  { label: 'Video', hint: 'One sentence: what this video is about' },
  { label: 'Goal', hint: 'What the viewer should feel, learn or do' },
  { label: 'Audience', hint: 'Who is watching and what they already know' },
  { label: 'Hook', hint: 'The first two seconds that stop the scroll' },
  { label: 'Story beats', hint: 'Numbered moments, one idea per scene, in order' },
  { label: 'Visual style', hint: 'Look, colours, motion, and what to show on screen' },
  { label: 'Tone & narration', hint: 'Voice, mood, pace; any exact lines to say' },
  { label: 'Ending', hint: 'Closing moment or call to action' },
  { label: 'Must include', hint: 'Names, facts, products or words that must appear' },
  { label: 'Avoid', hint: 'Anything that must not appear' }
]

const at = '2026-10-31T00:00:00.000Z'

export const BUILTIN_TEMPLATES: PromptTemplate[] = [
  {
    id: 'builtin-explainer',
    name: 'Explainer',
    emoji: '🧑‍🏫',
    builtin: true,
    createdAt: at,
    style: 'explainer',
    sections: [
      { label: 'Video', hint: 'The question or topic this video explains' },
      { label: 'Audience', hint: 'Who is learning and their starting level' },
      { label: 'Hook', hint: 'A surprising fact or question to open with' },
      { label: 'Story beats', hint: 'Numbered steps from simple to complete, one per scene' },
      { label: 'Visual style', hint: 'Diagrams, labels, photos or animation for each step' },
      { label: 'Tone & narration', hint: 'Friendly, clear, calm; plain words' },
      { label: 'Ending', hint: 'One-line recap of the key takeaway' }
    ]
  },
  {
    id: 'builtin-product',
    name: 'Product promo',
    emoji: '🛍️',
    builtin: true,
    createdAt: at,
    style: 'social',
    sections: [
      { label: 'Video', hint: 'The product and what it does, in one line' },
      { label: 'Audience', hint: 'Who buys it and the problem they have' },
      { label: 'Hook', hint: 'The pain point or wow moment in the first two seconds' },
      { label: 'Story beats', hint: 'Problem → product → 2–3 key benefits → proof' },
      { label: 'Visual style', hint: 'Brand colours, product shots, energy level' },
      { label: 'Must include', hint: 'Product name, price, offer, website' },
      { label: 'Ending', hint: 'Call to action: buy, download, follow' }
    ]
  },
  {
    id: 'builtin-story',
    name: 'Mini documentary',
    emoji: '🎞️',
    builtin: true,
    createdAt: at,
    style: 'explainer',
    sections: [
      { label: 'Video', hint: 'The story, person, place or event' },
      { label: 'Hook', hint: 'A dramatic moment or mystery to open with' },
      { label: 'Story beats', hint: 'Numbered chapters: setting → turning point → outcome' },
      { label: 'Visual style', hint: 'Era, locations, cinematic stills or footage, colour grade' },
      { label: 'Tone & narration', hint: 'Narrator voice and mood: serious, warm, suspenseful' },
      { label: 'Ending', hint: 'The lasting meaning or a question to leave viewers with' }
    ]
  }
]

/** "Label: content" blocks, the form every stage of the pipeline reads */
export function assemblePrompt(sections: Array<{ label: string; content: string }>): string {
  return sections
    .map((s) => ({ label: s.label.trim(), content: s.content.trim() }))
    .filter((s) => s.label && s.content)
    .map((s) => (s.content.includes('\n') ? `${s.label}:\n${s.content}` : `${s.label}: ${s.content}`))
    .join('\n')
}

/** a blank brief to fill in by hand from a template */
export function templateSkeleton(t: Pick<PromptTemplate, 'sections'>): string {
  return t.sections.map((s) => `${s.label}: `).join('\n')
}
