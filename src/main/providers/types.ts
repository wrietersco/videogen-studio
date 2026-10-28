import type { VideoSpec } from '@shared/spec'

/**
 * LLMProvider — the single seam between the app and any AI model.
 * Real adapters (OpenAI / Anthropic / Gemini) implement this; MockProvider
 * implements it with rule-based generation for development without keys.
 *
 * Model IDs are resolved at runtime (listModels) so new models from any
 * provider work without app updates.
 */

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'mock'

export interface ModelInfo {
  id: string
  label: string
  provider: ProviderId
  supportsJSON: boolean
  supportsVision: boolean
  /** 'chat' (default) or 'image' generation */
  kind?: 'chat' | 'image'
  /** human-readable rate, e.g. "$0.10 in / $0.50 out per 1M tok" */
  priceNote?: string
}

export interface GenerateJSONRequest {
  system: string
  prompt: string
  /** JSON Schema for the expected output; adapters pass it to structured-output APIs */
  schemaName: string
  jsonSchema: Record<string, unknown>
  images?: Array<{ mimeType: string; base64: string }>
  temperature?: number
  maxTokens?: number
}

export interface GenerateTextRequest {
  system: string
  prompt: string
  images?: Array<{ mimeType: string; base64: string }>
  temperature?: number
  maxTokens?: number
}

export interface TTSRequest {
  text: string
  voice?: string
  /** delivery direction (tone, pace, emphasis) for steerable voices */
  instructions?: string
  /** overrides the provider's default speech model */
  model?: string
  /** provider-specific voice/model overrides */
  options?: Record<string, unknown>
}

export interface TTSResult {
  audio: Buffer
  mimeType: string
  /** word-level timestamps when the provider exposes them */
  words?: Array<{ word: string; startSec: number; endSec: number }>
}

export interface ImageGenRequest {
  prompt: string
  /** overrides the provider's configured image model (Settings → Media models) */
  model?: string
  width: number
  height: number
  styleHint?: string
}

export interface LLMProvider {
  readonly id: ProviderId
  readonly label: string
  isConfigured(): Promise<boolean>
  listModels(): Promise<ModelInfo[]>
  /** curated image-generation catalog when the provider offers one */
  listImageModels?(): Promise<ModelInfo[]>
  generateJSON<T>(req: GenerateJSONRequest): Promise<T>
  generateText(req: GenerateTextRequest): Promise<string>
  generateImage?(req: ImageGenRequest): Promise<Buffer>
  tts?(req: TTSRequest): Promise<TTSResult>
}

/** Raised by adapters on any provider failure — the fixer loop classifies these. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly kind:
      | 'auth'
      | 'rate-limit'
      | 'invalid-request'
      | 'server'
      | 'network'
      | 'schema-violation' = 'server',
    readonly retryable = kind === 'rate-limit' || kind === 'server' || kind === 'network'
  ) {
    super(`[${provider}] ${message}`)
    this.name = 'ProviderError'
  }
}

/** The one JSON payload the planner is asked for, by any provider. */
export interface PlanRequestPayload {
  userPrompt: string
  platform: VideoSpec['platform']
  platformNotes: string
  styleHint?: VideoSpec['style']
  durationHintSec?: number
  imageSummaries?: string[]
}

export const VIDEO_SPEC_SCHEMA_NAME = 'VideoSpec'
