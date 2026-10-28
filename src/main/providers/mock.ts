import { createHash } from 'crypto'
import type {
  GenerateJSONRequest,
  GenerateTextRequest,
  LLMProvider,
  ModelInfo,
  ProviderId
} from './types'
import { ProviderError } from './types'
import { PLATFORM_PRESETS, PACING_TUNING } from '@shared/presets'
import type { Pacing, Palette, Scene, StyleFamily, VideoSpec } from '@shared/spec'

/**
 * MockProvider — plays the role of OpenAI/Claude/Gemini during development.
 * Rule-based but genuinely generative: the same prompt yields the same spec
 * (seeded determinism — a feature for render-determinism tests), different
 * prompts yield meaningfully different videos.
 *
 * When real keys arrive, this file stops being used in the app path but
 * remains the reference implementation for adapter tests.
 */

const MOCK_MODELS: ModelInfo[] = [
  { id: 'mock/planner-pro', label: 'Mock Planner Pro', provider: 'mock', supportsJSON: true, supportsVision: true },
  { id: 'mock/writer-fast', label: 'Mock Writer Fast', provider: 'mock', supportsJSON: true, supportsVision: false },
  { id: 'mock/vision-xl', label: 'Mock Vision XL', provider: 'mock', supportsJSON: true, supportsVision: true }
]

// ---------- curated design intelligence (what a good LLM "knows") ----------

const PALETTES: Record<string, Palette> = {
  neonTech: { bg: '#0A0A12', surface: '#141425', fg: '#F4F4FF', muted: '#8A8AA8', accent: '#7C5CFF', accent2: '#00E5FF' },
  sunsetPop: { bg: '#1A0E2E', surface: '#2A1450', fg: '#FFF7F0', muted: '#B49BD6', accent: '#FF4D8D', accent2: '#FFB347' },
  cleanLight: { bg: '#FAFAF7', surface: '#FFFFFF', fg: '#14141B', muted: '#6B6B76', accent: '#2563EB', accent2: '#F59E0B' },
  forest: { bg: '#0C1A12', surface: '#15281C', fg: '#F0FFF4', muted: '#7FA98C', accent: '#34D399', accent2: '#A3E635' },
  noir: { bg: '#0B0B0C', surface: '#17171A', fg: '#EDEDEE', muted: '#77777E', accent: '#E5E5E0', accent2: '#C4A35A' },
  candy: { bg: '#FFF0F6', surface: '#FFFFFF', fg: '#2B1024', muted: '#9E6B8A', accent: '#FF2E88', accent2: '#7C5CFF' },
  ocean: { bg: '#04121F', surface: '#0A2338', fg: '#EAF6FF', muted: '#6E93AD', accent: '#22D3EE', accent2: '#3B82F6' }
}

const FONTS = {
  impact: { display: 'Archivo Black, sans-serif', body: 'Inter, sans-serif', capsDisplay: true },
  editorial: { display: 'Playfair Display, serif', body: 'Source Sans 3, sans-serif', capsDisplay: false },
  tech: { display: 'Space Grotesk, sans-serif', body: 'Inter, sans-serif', capsDisplay: true },
  friendly: { display: 'Nunito, sans-serif', body: 'Nunito Sans, sans-serif', capsDisplay: false }
}

interface Mood {
  palette: Palette
  fonts: keyof typeof FONTS
  music: VideoSpec['musicMood']
}

function detectMood(prompt: string, style: StyleFamily): Mood {
  const p = prompt.toLowerCase()
  if (/(crypto|ai|tech|saas|software|dev|code|startup|api|data|cyber)/.test(p)) return { palette: PALETTES.neonTech, fonts: 'tech', music: 'upbeat' }
  if (/(fun|playful|kids|candy|party|birthday|meme|silly)/.test(p)) return { palette: PALETTES.candy, fonts: 'friendly', music: 'playful' }
  if (/(luxury|premium|film|cinematic|noir|drama)/.test(p)) return { palette: PALETTES.noir, fonts: 'editorial', music: 'cinematic' }
  if (/(nature|green|eco|health|fitness|plant|food)/.test(p)) return { palette: PALETTES.forest, fonts: 'friendly', music: 'upbeat' }
  if (/(ocean|water|travel|space|sky|weather)/.test(p)) return { palette: PALETTES.ocean, fonts: 'tech', music: 'cinematic' }
  if (/(business|finance|corporate|b2b|enterprise|consult)/.test(p)) return { palette: PALETTES.cleanLight, fonts: 'tech', music: 'corporate' }
  if (style === 'motion3d') return { palette: PALETTES.neonTech, fonts: 'tech', music: 'cinematic' }
  if (style === 'social') return { palette: PALETTES.sunsetPop, fonts: 'impact', music: 'upbeat' }
  return { palette: PALETTES.cleanLight, fonts: 'tech', music: 'corporate' }
}

function detectStyle(prompt: string): StyleFamily {
  const p = prompt.toLowerCase()
  if (/(3d|three\.?js|logo (reveal|sting)|particle|neon (shape|object)|orbit|camera fly)/.test(p)) return 'motion3d'
  if (/(tiktok|viral|meme|gen-?z|kinetic|snappy|punchy|hook|hype|gaming|montage|edit|reel)/.test(p)) return 'social'
  if (/(explain|explainer|how (it|to)|product|demo|saas|feature|tutorial|introduce)/.test(p)) return 'explainer'
  if (/(cinematic|film|movie|trailer|noir|epic)/.test(p)) return 'motion3d' // cinematic kit lands post-MVP; 3D kit is nearest
  return 'explainer'
}

function detectPacing(prompt: string, style: StyleFamily, platform: VideoSpec['platform']): Pacing {
  const p = prompt.toLowerCase()
  if (/(slow|calm|meditat|gentle|documentary)/.test(p)) return 'calm'
  if (/(fast|snappy|quick|punchy|frantic|high.energy|hype)/.test(p)) return platform === 'tiktok' ? 'frantic' : 'energetic'
  return PLATFORM_PRESETS[platform].pacingBias ?? (style === 'social' ? 'energetic' : 'standard')
}

function extractTopic(prompt: string): string {
  const cleaned = prompt
    .replace(/^(please\s+)?(make|create|generate|produce|build)\s+(me\s+)?(a|an|the)?\s*/i, '')
    .replace(/\b(video|clip|reel|short|tiktok|youtube)\b/gi, ' ')
    .replace(/\babout\b/i, '|')
    .trim()
  const aboutSplit = cleaned.split('|')
  const topic = (aboutSplit[1] ?? aboutSplit[0] ?? prompt)
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    .trim()
  return topic.length > 0 ? topic : prompt.trim()
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Seeded PRNG so the same prompt deterministically yields the same spec. */
function makeRng(seed: string): () => number {
  const hash = createHash('sha256').update(seed).digest()
  let state = hash.readUInt32BE(0) || 1
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

// ---------- narrative arc builders (the "LLM's" creative core) ----------

type SceneDraft = { kind: Scene['kind']; content: Record<string, unknown>; weight: number }

function buildArc(topic: string, style: StyleFamily, totalSec: number, rng: () => number): SceneDraft[] {
  const T = titleCase(topic)
  const hooks = [
    `Stop scrolling.`,
    `You're doing ${topic} wrong.`,
    `Nobody talks about this:`,
    `${T}, explained fast.`,
    `This changes everything about ${topic}.`
  ]
  const hook = hooks[Math.floor(rng() * hooks.length)]

  if (style === 'social') {
    const arc: SceneDraft[] = [
      { kind: 'title', weight: 1.1, content: { headline: hook, kicker: T.toUpperCase() } },
      { kind: 'statement', weight: 1.4, content: { headline: `Here's the thing about ${topic}:`, subline: 'It is simpler than you think.' } },
      { kind: 'bullets', weight: 2.2, content: { headline: '3 things to know', bullets: [`Why ${topic} matters`, `The one mistake everyone makes`, `What to do instead`] } },
      { kind: 'stat', weight: 1.2, content: { value: '10×', label: 'better results', context: `when you apply this to ${topic}` } },
      { kind: 'cta', weight: 1.0, content: { headline: `Now you know ${topic}.`, action: 'Follow for more' } }
    ]
    return arc
  }
  if (style === 'motion3d') {
    const T3 = T.split(/\s+/).slice(0, 3).join(' ') // 3D scenes need short headlines
    const arc: SceneDraft[] = [
      { kind: 'particles', weight: 1.2, content: { headline: T3, subline: 'A visual journey', density: 'medium' } },
      { kind: 'showcase3d', weight: 1.8, content: { objectStyle: 'torusknot', material: 'chrome', motion: 'dollyOrbit', headline: `The shape of ${T3}` } },
      { kind: 'statement', weight: 1.4, content: { headline: `${T3} isn't what you think.`, subline: 'Look closer.' } },
      { kind: 'showcase3d', weight: 1.8, content: { objectStyle: 'crystal', material: 'glass', motion: 'explodeAssemble', headline: 'Complex. Beautiful.' } },
      { kind: 'cta', weight: 1.0, content: { headline: T3, action: 'Explore the full film' } }
    ]
    return arc
  }
  // explainer (default)
  const arc: SceneDraft[] = [
    { kind: 'title', weight: 1.2, content: { headline: `${T}`, subline: 'In 60 seconds', kicker: 'EXPLAINER' } },
    { kind: 'statement', weight: 1.3, content: { headline: 'The problem:', subline: `${titleCase(topic)} is confusing because nobody explains it simply.` } },
    { kind: 'bullets', weight: 2.4, content: { headline: `How ${topic} works`, bullets: ['The core idea', 'Why it matters', 'How to use it'] } },
    { kind: 'comparison', weight: 2.0, content: { headline: 'Old way vs new way', left: { label: 'Before', points: ['Confusing', 'Slow', 'Expensive'] }, right: { label: 'After', points: ['Clear', 'Fast', 'Affordable'] } } },
    { kind: 'stat', weight: 1.2, content: { value: '87%', label: 'of people prefer simple', context: `Source: common sense` } },
    { kind: 'cta', weight: 1.0, content: { headline: `That's ${topic}.`, subline: 'Now you can explain it too.', action: 'Share this' } }
  ]
  return arc
}

// ---------------------------- the provider ----------------------------

export class MockProvider implements LLMProvider {
  readonly id: ProviderId = 'mock'
  readonly label = 'Mock (no API needed)'

  async isConfigured(): Promise<boolean> {
    return true
  }

  async listModels(): Promise<ModelInfo[]> {
    return MOCK_MODELS
  }

  async generateJSON<T>(req: GenerateJSONRequest): Promise<T> {
    if (req.schemaName !== 'VideoSpec') {
      throw new ProviderError(`mock: unsupported schema ${req.schemaName}`, 'mock', 'invalid-request')
    }
    return this.planSpec(req) as T
  }

  async generateText(req: GenerateTextRequest): Promise<string> {
    return `[mock] ${req.prompt.slice(0, 80)}…`
  }

  async generateImage(): Promise<Buffer> {
    // 1×1 neutral PNG placeholder until real image escalation lands (P3)
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
    return png
  }

  async tts(): Promise<never> {
    throw new ProviderError('mock tts not implemented (P4)', 'mock', 'invalid-request')
  }

  /** The mock "LLM call" that plays the Planner. */
  private planSpec(req: GenerateJSONRequest): VideoSpec {
    const payload = extractPlanPayload(req.prompt)
    const platform = payload.platform
    const preset = PLATFORM_PRESETS[platform]
    const style = payload.styleHint ?? detectStyle(payload.userPrompt)
    const pacing = detectPacing(payload.userPrompt, style, platform)
    const mood = detectMood(payload.userPrompt, style)
    const topic = extractTopic(payload.userPrompt)

    const requested = payload.durationHintSec ?? preset.defaultDuration
    const totalSec = Math.min(preset.durationRange[1], Math.max(preset.durationRange[0], requested))

    const rng = makeRng(payload.userPrompt + platform + style)
    const arc = buildArc(topic, style, totalSec, rng)

    const scale = PACING_TUNING[pacing].durationScale
    const weightSum = arc.reduce((a, s) => a + s.weight, 0)
    let remaining = totalSec
    const scenes: Scene[] = arc.map((draft, i) => {
      const isLast = i === arc.length - 1
      let dur = (draft.weight / weightSum) * totalSec * scale
      if (isLast) dur = remaining // absorb rounding
      dur = Math.max(1.4, Math.round(dur * 10) / 10)
      remaining -= dur
      const base = {
        id: `scene-${i + 1}`,
        durationSec: dur,
        transitionIn: pickTransition(style, i, rng),
        transitionOut: 'cut' as const
      }
      return { ...base, kind: draft.kind, ...draft.content } as unknown as Scene
    })

    const spec: VideoSpec = {
      schemaVersion: 1,
      title: `${titleCase(topic)} — ${preset.label}`,
      platform,
      style,
      pacing,
      durationSec: Math.round(scenes.reduce((a, s) => a + s.durationSec, 0) * 10) / 10,
      fps: preset.fps,
      palette: mood.palette,
      typography: FONTS[mood.fonts],
      scenes,
      narration: scenes.map((s) => ({ sceneId: s.id, text: narrationFor(s, topic) })),
      assetNeeds: [],
      crafts: [],
      musicMood: mood.music,
      captionStyle: {
        enabled: true,
        position: preset.captionPosition,
        uppercase: style === 'social'
      }
    }
    return spec
  }
}

type TransitionIn = Scene['transitionIn']

function pickTransition(style: StyleFamily, i: number, rng: () => number): TransitionIn {
  if (i === 0) return 'fade'
  if (style === 'social') {
    const opts = ['whip', 'zoom', 'glitch', 'slide'] as const
    return opts[Math.floor(rng() * opts.length)]
  }
  if (style === 'motion3d') {
    const opts = ['zoom', 'fade', 'wipe'] as const
    return opts[Math.floor(rng() * opts.length)]
  }
  return 'slide'
}

function narrationFor(scene: Scene, topic: string): string {
  const t = topic.toLowerCase()
  switch (scene.kind) {
    case 'title': return scene.subline ? `${scene.headline}. ${scene.subline}` : scene.headline
    case 'statement': return `${scene.headline} ${scene.subline ?? ''}`.trim()
    case 'bullets': return scene.bullets.join('. ')
    case 'comparison': return `${scene.left.label}: ${scene.left.points.join(', ')}. ${scene.right.label}: ${scene.right.points.join(', ')}.`
    case 'stat': return `${scene.value} — ${scene.label}`
    case 'quote': return scene.text
    case 'cta': return `${scene.headline} ${scene.action ?? ''}`.trim()
    case 'showcase3d': return scene.headline ?? `Experience ${t}.`
    case 'particles': return `${scene.headline}. ${scene.subline ?? ''}`.trim()
    case 'kenburns': return scene.headline ?? ''
  }
}

function extractPlanPayload(prompt: string): { userPrompt: string; platform: VideoSpec['platform']; styleHint?: StyleFamily; durationHintSec?: number } {
  try {
    const parsed = JSON.parse(prompt)
    if (parsed && typeof parsed.userPrompt === 'string') return parsed
  } catch {
    // fall through: treat as raw freestyle prompt
  }
  return { userPrompt: prompt, platform: 'tiktok' }
}

export const mockProvider = new MockProvider()
