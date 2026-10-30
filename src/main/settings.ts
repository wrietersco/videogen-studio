import type { ProviderId } from './providers/types'

/** every secret the app can hold: chat providers plus media/stock services */
export type KeyId = ProviderId | 'elevenlabs' | 'pexels' | 'pixabay'

/**
 * Which engine makes each kind of media. Values are "provider:model" or a
 * mode word: image 'auto' (the chat provider's painter, else any keyed one)
 * · 'stock' (free photos) · 'none' (diagram backgrounds); music 'library'
 * picks the best match from the asset library.
 */
export interface MediaSettings {
  image: string
  voice: string
  music: string
  video: string
}

/** App settings shape (main process). Keys live encrypted on disk. */
export interface Settings {
  provider: ProviderId
  /** per-provider model ids; keys are provider ids plus sub-keys like 'openai-image' */
  models: Record<string, string>
  keys: Partial<Record<KeyId, string>>
  quality: 'draft' | 'standard' | 'delivery'
  allowGpu: boolean
  /** 'directed' = scene director + plates + widgets (default) · 'classic' = template scenes */
  craft: 'directed' | 'classic'
  media: MediaSettings
  /** 'smart' reuses matching library assets before paying for new ones · 'fresh' always makes new */
  reuse: 'smart' | 'fresh'
  /** default sharing for newly generated assets — nothing is uploaded unless this is 'shareable' */
  sharing: 'local' | 'shareable'
  /** full autonomous agent: tunes look, clips and reuse per video — never the LLM provider/model, never to a costlier engine */
  autopilot: boolean
}

export const DEFAULT_MEDIA: MediaSettings = {
  image: 'auto',
  voice: 'auto',
  music: 'builtin:procedural',
  video: 'stock'
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'mock',
  models: {},
  keys: {},
  quality: 'standard',
  allowGpu: false,
  craft: 'directed',
  media: { ...DEFAULT_MEDIA },
  reuse: 'smart',
  sharing: 'local',
  autopilot: true
}
