import type {
  GenerateJSONRequest,
  GenerateTextRequest,
  LLMProvider,
  ModelInfo,
  ProviderId
} from './types'
import { ProviderError } from './types'
import { meter } from '../usage/meter'

/**
 * Anthropic adapter — Messages API. Structured output via a forced tool call
 * (input_schema), vision via base64 image blocks. No image-gen / TTS.
 */

const API = 'https://api.anthropic.com/v1'
const VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-5-5'

/** Curated catalog (rates from the shipped price book), cheapest → priciest. */
const CHAT_MODELS: ModelInfo[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', supportsJSON: true, supportsVision: true, priceNote: '$0.10 in / $0.50 out per 1M tok' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', supportsJSON: true, supportsVision: true, priceNote: '$2 in / $10 out per 1M tok' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', supportsJSON: true, supportsVision: true, priceNote: '$4 in / $20 out per 1M tok' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', provider: 'anthropic', supportsJSON: true, supportsVision: true, priceNote: '$10 in / $50 out per 1M tok · premium tier' }
]

type KeyFn = () => string

export class AnthropicProvider implements LLMProvider {
  readonly id: ProviderId = 'anthropic'
  readonly label = 'Anthropic (Claude)'

  constructor(private readonly key: KeyFn, private readonly modelOverride?: () => string | undefined) {}

  async isConfigured(): Promise<boolean> {
    return this.key().length > 0
  }

  async listModels(): Promise<ModelInfo[]> {
    return CHAT_MODELS
  }

  async generateJSON<T>(req: GenerateJSONRequest): Promise<T> {
    const model = this.modelOverride?.() ?? DEFAULT_MODEL
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }]
    for (const img of req.images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
      })
    }
    const body = {
      model,
      max_tokens: req.maxTokens ?? 8000,
      temperature: req.temperature ?? 0.8,
      system: req.system,
      messages: [{ role: 'user', content }],
      tools: [
        {
          name: req.schemaName,
          description: `Return the ${req.schemaName} payload`,
          input_schema: req.jsonSchema
        }
      ],
      tool_choice: { type: 'tool', name: req.schemaName }
    }
    const json = await this.messages<{ content: Array<{ type: string; input?: unknown; text?: string }> }>(model, body)
    const toolUse = json.content.find((c) => c.type === 'tool_use')
    if (toolUse?.input) return toolUse.input as T
    // fallback: model answered in text anyway
    const text = json.content.find((c) => c.type === 'text')?.text ?? ''
    try {
      return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')) as T
    } catch {
      throw new ProviderError('no structured tool_use in response', this.id, 'schema-violation')
    }
  }

  async generateText(req: GenerateTextRequest): Promise<string> {
    const model = this.modelOverride?.() ?? DEFAULT_MODEL
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }]
    for (const img of req.images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
      })
    }
    const json = await this.messages<{ content: Array<{ type: string; text?: string }> }>(model, {
      model,
      max_tokens: req.maxTokens ?? 4000,
      temperature: req.temperature ?? 0.8,
      system: req.system,
      messages: [{ role: 'user', content }]
    })
    return json.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
  }

  /** one Messages call, metered by its reported usage (cache reads billed at ~0.1×) */
  private async messages<T>(model: string, body: unknown): Promise<T> {
    const json = await this.request<T & { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }>(
      'POST',
      '/messages',
      body
    )
    const u = json.usage
    meter.record({
      kind: 'text',
      provider: 'anthropic',
      model,
      usage: {
        inputTokens: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) * 1.25 + (u?.cache_read_input_tokens ?? 0) * 0.1,
        outputTokens: u?.output_tokens ?? 0
      }
    })
    return json
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          'x-api-key': this.key(),
          'anthropic-version': VERSION,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (e) {
      throw new ProviderError((e as Error).message, this.id, 'network')
    }
    if (!res.ok) {
      let detail = `${res.status}`
      try {
        const j = (await res.json()) as { error?: { message?: string } }
        detail = j.error?.message ?? detail
      } catch {
        /* keep status */
      }
      const kind =
        res.status === 401 || res.status === 403
          ? 'auth'
          : res.status === 429
            ? 'rate-limit'
            : res.status >= 500
              ? 'server'
              : 'invalid-request'
      throw new ProviderError(detail, this.id, kind)
    }
    return (await res.json()) as T
  }
}
