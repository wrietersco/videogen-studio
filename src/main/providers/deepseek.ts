import type { GenerateJSONRequest, GenerateTextRequest, LLMProvider, ModelInfo, ProviderId } from './types'
import { ProviderError } from './types'
import { meter } from '../usage/meter'

/**
 * DeepSeek adapter — OpenAI-compatible Chat Completions for writing and code.
 * JSON comes back via response_format json_object (DeepSeek has no
 * json_schema support): the schema is inlined into the system prompt and the
 * reply is parsed leniently. Images ride as OpenAI-style image_url parts for
 * the image-processing role. No image/audio generation — those roles are
 * disabled for DeepSeek in the capability matrix.
 *
 * The model id is injectable (registry), defaulting to the current flagship.
 */

const API = 'https://api.deepseek.com/v1'

type KeyFn = () => string

/**
 * Curated catalog, least → most expensive. Rates from DeepSeek's official
 * pricing (api-docs.deepseek.com/quick_start/pricing).
 */
const CHAT_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-chat',
    label: 'DeepSeek Chat',
    provider: 'deepseek',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$0.27 in / $1.10 out per 1M tok'
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek Reasoner',
    provider: 'deepseek',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$0.55 in / $2.19 out per 1M tok · reasoning'
  }
]

const DEFAULT_CHAT_MODEL = 'deepseek-chat'

/** the reasoner thinks before answering: no sampling params on that family */
function isReasoningModel(model: string): boolean {
  return model === 'deepseek-reasoner'
}

export class DeepseekProvider implements LLMProvider {
  readonly id: ProviderId = 'deepseek'
  readonly label = 'DeepSeek'

  constructor(
    private readonly key: KeyFn,
    private readonly modelOverride?: () => string | undefined
  ) {}

  async isConfigured(): Promise<boolean> {
    return this.key().length > 0
  }

  /** Curated catalog — hardcoded, no /models round-trip. */
  async listModels(): Promise<ModelInfo[]> {
    return CHAT_MODELS
  }

  async generateJSON<T>(req: GenerateJSONRequest): Promise<T> {
    const model = this.modelOverride?.() || DEFAULT_CHAT_MODEL
    const text = await this.chat(model, {
      system: `${req.system}\n\nRespond with ONLY a JSON value matching this schema (no prose, no code fences):\n${JSON.stringify(req.jsonSchema)}`,
      prompt: req.prompt,
      images: req.images,
      jsonMode: true,
      maxTokens: req.maxTokens ?? 8000,
      temperature: req.temperature
    })
    return this.parseJSON<T>(text)
  }

  async generateText(req: GenerateTextRequest): Promise<string> {
    const model = this.modelOverride?.() || DEFAULT_CHAT_MODEL
    return this.chat(model, {
      system: req.system,
      prompt: req.prompt,
      images: req.images,
      maxTokens: req.maxTokens ?? 4000,
      temperature: req.temperature
    })
  }

  /** one chat-completions call, metered by the usage it reports */
  private async chat(
    model: string,
    o: { system: string; prompt: string; images?: Array<{ mimeType: string; base64: string }>; jsonMode?: boolean; maxTokens: number; temperature?: number }
  ): Promise<string> {
    const reasoning = isReasoningModel(model)
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: o.prompt }]
    for (const img of o.images ?? []) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })
    }
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content }
      ],
      max_tokens: o.maxTokens,
      ...(o.jsonMode ? { response_format: { type: 'json_object' } } : {})
    }
    // the reasoner ignores sampling params — don't send them
    if (!reasoning && o.temperature !== undefined) body.temperature = o.temperature
    const json = await this.request<{
      choices: Array<{ message: { content?: string; reasoning_content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }>('POST', '/chat/completions', body)
    meter.record({
      kind: 'text',
      provider: 'deepseek',
      model,
      usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 }
    })
    return json.choices[0]?.message?.content ?? ''
  }

  private parseJSON<T>(text: string): T {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const start = cleaned.search(/[[{]/)
    if (start < 0) throw new ProviderError('no JSON in response', this.id, 'schema-violation')
    try {
      return JSON.parse(cleaned.slice(start)) as T
    } catch (e) {
      throw new ProviderError(`unparseable JSON: ${(e as Error).message}`, this.id, 'schema-violation')
    }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.key()}`,
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch (e) {
      throw new ProviderError((e as Error).message, this.id, 'network')
    }
    if (!res.ok) throw await this.mapError(res)
    return (await res.json()) as T
  }

  private async mapError(res: Response): Promise<ProviderError> {
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
    return new ProviderError(detail, this.id, kind)
  }
}
