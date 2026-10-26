import type { ProviderId } from './providers/types'

/** App settings shape (main process). Keys live encrypted on disk. */
export interface Settings {
  provider: ProviderId
  models: Partial<Record<ProviderId, string>>
  keys: Partial<Record<ProviderId, string>>
  quality: 'draft' | 'standard' | 'delivery'
  allowGpu: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  provider: 'mock',
  models: {},
  keys: {},
  quality: 'standard',
  allowGpu: false
}
