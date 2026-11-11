import type { ProviderId } from '../main/providers/types'

/**
 * Provider roles — what each AI provider may be used for in the app.
 * Settings carry a roles list per provider (Settings → Who does what);
 * routing resolves every capability to the providers enabled for it,
 * brain provider first, then OpenAI → Anthropic → Gemini → DeepSeek.
 */

export type ProviderRole =
  | 'text' // writing: plan, direct, critic, fixer, prompt tools
  | 'code' // code generation: canvas code, custom SVG scenes
  | 'image-gen' // image generation (painted plates, assets)
  | 'image-process' // image processing (vision on stills)
  | 'video-gen' // video generation (AI clips)
  | 'video-process' // video processing (vision on frames)
  | 'audio-gen' // audio generation (voices, music)
  | 'audio-process' // audio processing (transcription)

export const ROLE_LABELS: Record<ProviderRole, string> = {
  text: 'Text generation',
  code: 'Code generation',
  'image-gen': 'Image generation',
  'image-process': 'Image processing',
  'video-gen': 'Video generation',
  'video-process': 'Video processing',
  'audio-gen': 'Audio generation',
  'audio-process': 'Audio processing'
}

/** the order roles are offered in the UI */
export const ALL_ROLES: ProviderRole[] = ['text', 'code', 'image-gen', 'image-process', 'video-gen', 'video-process', 'audio-gen', 'audio-process']

/**
 * What each provider can do at all — roles outside this set are disabled
 * for the provider in Settings and ignored by routing.
 */
export const PROVIDER_CAPABILITIES: Record<ProviderId, ProviderRole[]> = {
  openai: ['text', 'code', 'image-gen', 'image-process', 'video-process', 'audio-gen', 'audio-process'],
  anthropic: ['text', 'code', 'image-process', 'video-process'],
  gemini: ['text', 'code', 'image-gen', 'image-process', 'video-gen', 'video-process', 'audio-gen'],
  deepseek: ['text', 'code', 'image-process'],
  mock: ['text']
}

/** the default roles list: every provider enabled for everything it can do */
export const DEFAULT_ROLES: Record<ProviderId, ProviderRole[]> = Object.fromEntries(
  (Object.keys(PROVIDER_CAPABILITIES) as ProviderId[]).map((id) => [id, [...PROVIDER_CAPABILITIES[id]]])
) as Record<ProviderId, ProviderRole[]>
