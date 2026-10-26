import type {
  GenerateJSONRequest,
  GenerateTextRequest,
  LLMProvider,
  ModelInfo,
  ProviderId
} from './types'
import { ProviderError } from './types'

/**
 * Anthropic adapter — Messages API. Structured output via a forced tool call
 * (input_schema), vision via base64 image blocks. No image-gen / TTS.
 */

const API = 'https://api.anthropic.com/v1'
const VERSION = '2023-06-01'

type KeyFn = () => string

export class AnthropicProvider implements LLMProvider {
  readonly id: ProviderId = 'anthropic'
  readonly label = 'Anthropic (Claude)'

  constructor(private readonly key: KeyFn, private readonly modelOverride?: () => string | undefined) {}

  async isConfigured(): Promise<boolean> {
    return this.key().length > 0
  }

  async listModels(): Promise<ModelInfo[]> {
    const json = await this.request<{ data: Array<{ id: string; display_name: string }> }>('GET', '/models?limit=100')
    return json.data.map((m) => ({
      id: m.id,
      label: m.display_name,
      provider: this.id,
      supportsJSON: true,
      supportsVision: !/haiku-3|claude-3-(opus|sonnet)-2024/.test(m.id)
    }))
  }

  async generateJSON<T>(req: GenerateJSONRequest): Promise<T> {
    const model = this.modelOverride?.() ?? 'claude-sonnet-4-5'
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
    const json = await this.request<{
      content: Array<{ type: string; input?: unknown; text?: string }>
    }>('POST', '/messages', body)
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
    const model = this.modelOverride?.() ?? 'claude-sonnet-4-5'
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }]
    for (const img of req.images ?? []) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.base64 }
      })
    }
    const json = await this.request<{ content: Array<{ type: string; text?: string }> }>('POST', '/messages', {
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
