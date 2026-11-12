import type { GenerateJSONRequest, GenerateTextRequest, LLMProvider, ModelInfo, ProviderId } from './types'
import { ProviderError } from './types'
import { meter } from '../usage/meter'

/**
 * DeepSeek adapter — OpenAI-compatible Chat Completions for writing and code.
 * JSON comes back via response_format json_object (DeepSeek has no
 * json_schema support): the schema is inlined into the system prompt and the
 * reply is parsed leniently. Flash rides with vision (OpenAI-style image_url
 * parts) for the image-processing role. No image/audio generation — those
 * roles are disabled for DeepSeek in the capability matrix.
 *
 * Both current models think by default; a model that rejects sampling params
 * is retried without them. The model id is injectable (registry), defaulting
 * to the current flagship.
 */

/** the docs' OpenAI-format endpoint (no /v1 — that was the older compat path) */
const API = 'https://api.deepseek.com'

type KeyFn = () => string

/**
 * Curated catalog — the current DeepSeek models, cheapest first. Rates are
 * the peak rates (off-peak is half; weekends and CN holidays are off-peak),
 * from api-docs.deepseek.com/quick_start/pricing. Verified Nov 12, 2026.
 */
const CHAT_MODELS: ModelInfo[] = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash (V4.1)',
    provider: 'deepseek',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$0.15–0.30 in / $0.60–1.20 out per 1M tok · vision'
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    supportsJSON: true,
    supportsVision: false,
    kind: 'chat',
    priceNote: '$0.66–1.32 in / $1.98–3.96 out per 1M tok · 1M context'
  }
]

const DEFAULT_CHAT_MODEL = 'deepseek-flash'
/** tokens kept free for the model's thinking, on top of the answer budget a caller asks for */
const THINKING_HEADROOM = 12000
/** the model that can see; V4 Pro cannot, so a judgement that carries images rides on this one */
const VISION_MODEL = 'deepseek-flash'
const visionOf = (model: string): string => (CHAT_MODELS.find((m) => m.id === model)?.supportsVision === false ? VISION_MODEL : model)

/** Renamed ids keep older saved selections working (the old chat/reasoner split is one thinking-mode model now). */
const CHAT_MODEL_ALIASES: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash'
}

function resolveChatModel(raw: string | undefined): string {
  const m = raw || DEFAULT_CHAT_MODEL
  return CHAT_MODEL_ALIASES[m] ?? m
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
    // structured calls with images are visual judgements (review, locate, score): they need a model that sees.
    // Writing calls keep the chosen model — their callers retry without images when it cannot see.
    const chosen = resolveChatModel(this.modelOverride?.())
    const model = req.images?.length ? visionOf(chosen) : chosen
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
    const model = resolveChatModel(this.modelOverride?.())
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
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: o.prompt }]
    for (const img of o.images ?? []) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })
    }
    // Both models think before they answer, and the thinking is spent from the
    // same max_tokens as the answer. A caller's budget is sized for the answer
    // alone, so without headroom the thinking uses it all and the answer comes
    // back empty (finish_reason "length").
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: o.system },
        { role: 'user', content }
      ],
      max_tokens: o.maxTokens + THINKING_HEADROOM,
      // the default effort ("high") spends minutes per pipeline step — a coded
      // scene took ten; these are bounded authoring and judging steps
      reasoning_effort: 'low',
      ...(o.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {})
    }
    type Reply = {
      choices: Array<{ finish_reason?: string; message: { content?: string; reasoning_content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    const call = async (): Promise<Reply> => {
      const json = await this.request<Reply>('POST', '/chat/completions', body)
      meter.record({
        kind: 'text',
        provider: 'deepseek',
        model,
        usage: { inputTokens: json.usage?.prompt_tokens ?? 0, outputTokens: json.usage?.completion_tokens ?? 0 }
      })
      return json
    }
    let json: Reply
    try {
      json = await call()
    } catch (e) {
      if (!(e instanceof ProviderError && e.kind === 'invalid-request' && /temperature/i.test(e.message))) throw e
      // a thinking model rejected sampling params — retry without them
      delete body.temperature
      json = await call()
    }
    let text = json.choices[0]?.message?.content ?? ''
    if (!text.trim() && json.choices[0]?.finish_reason === 'length') {
      // the thinking still used the whole budget: once more with room to finish
      body.max_tokens = o.maxTokens + THINKING_HEADROOM * 3
      json = await call()
      text = json.choices[0]?.message?.content ?? ''
    }
    // an empty answer is a failure the caller must see, never a silent blank
    if (!text.trim()) throw new ProviderError(`empty answer from ${model} (finish_reason: ${json.choices[0]?.finish_reason ?? 'unknown'})`, this.id, 'server')
    return text
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
