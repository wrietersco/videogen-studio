import type { ProviderId } from './providers/types'
import { DEFAULT_ROLES, type ProviderRole, type RoleRouting } from '@shared/providerRoles'

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
  /** which provider may do what (Settings → Who does what); the brain provider is always the fallback */
  roles: Partial<Record<ProviderId, ProviderRole[]>>
  /** how jobs are shared when several providers could do one: ordered candidates, or one owner per role */
  roleMode: RoleRouting
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
  /** use the provider keys above instead of the plan's AI — only honoured when the licence allows own keys */
  useOwnKeys: boolean
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
  roles: Object.fromEntries(Object.entries(DEFAULT_ROLES).map(([p, r]) => [p, [...r]])) as typeof DEFAULT_ROLES,
  roleMode: 'order',
  keys: {},
  quality: 'standard',
  allowGpu: false,
  craft: 'directed',
  media: { ...DEFAULT_MEDIA },
  reuse: 'smart',
  sharing: 'local',
  autopilot: true,
  useOwnKeys: false
}
