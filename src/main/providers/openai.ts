import type {
  GenerateJSONRequest,
  GenerateTextRequest,
  ImageGenRequest,
  LLMProvider,
  ModelInfo,
  ProviderId,
  TTSRequest,
  TTSResult
} from './types'
import { ProviderError } from './types'

/**
 * OpenAI adapter — Chat Completions with structured outputs (json_schema),
 * vision via data URLs, GPT-Image-2.x for asset escalation, TTS + Whisper
 * word timestamps for narration.
 *
 * The model id is injectable (registry), defaulting to a current flagship;
 * listModels() keeps the app current with future releases automatically.
 */

const API = 'https://api.openai.com/v1'

type KeyFn = () => string

/**
 * Curated catalogs — the latest OpenAI models (launches within ~6 months),
 * sorted least → most expensive, with rates shown in the UI dropdown.
 * Rates verified against OpenAI's official pricing and model docs
 * (developers.openai.com/api/docs/pricing) on Oct 26, 2026.
 */
const CHAT_MODELS: ModelInfo[] = [
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$0.10 in / $0.50 out per 1M tok'
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$0.20 in / $1.20 out per 1M tok'
  },
  {
    id: 'gpt-6.1-terra',
    label: 'GPT-6.1 Terra',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$1 in / $5 out per 1M tok'
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$2 in / $10 out per 1M tok'
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$2 in / $10 out per 1M tok · newer tuning'
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$2 in / $12 out per 1M tok'
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$4 in / $20 out per 1M tok'
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    provider: 'openai',
    supportsJSON: true,
    supportsVision: true,
    kind: 'chat',
    priceNote: '$10 in / $50 out per 1M tok · premium tier'
  }
]

const IMAGE_MODELS: ModelInfo[] = [
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2',
    provider: 'openai',
    supportsJSON: false,
    supportsVision: false,
    kind: 'image',
    priceNote: '$8 in / $30 out per 1M img tok'
  },
  {
    id: 'gpt-image-2.5-flare',
    label: 'GPT Image 2.5 Flare',
    provider: 'openai',
    supportsJSON: false,
    supportsVision: false,
    kind: 'image',
    priceNote: '$8 in / $30 out per 1M img tok · fast variant'
  },
  {
    id: 'gpt-image-2.5-sunburst',
    label: 'GPT Image 2.5 Sunburst',
    provider: 'openai',
    supportsJSON: false,
    supportsVision: false,
    kind: 'image',
    priceNote: '$8 in / $30 out per 1M img tok · highest fidelity'
  }
]

const DEFAULT_CHAT_MODEL = 'gpt-6-luna'
const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-sunburst'

/** Renamed ids keep older saved selections working. */
const CHAT_MODEL_ALIASES: Record<string, string> = {
  'gpt-6-terra': 'gpt-6.1-terra'
}

function resolveChatModel(raw: string | undefined): string {
  const m = raw || DEFAULT_CHAT_MODEL
  return CHAT_MODEL_ALIASES[m] ?? m
}

/** GPT-5/6 families are reasoning models: no custom temperature, bigger output budget. */
function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5|gpt-6)/.test(model)
}

export class OpenAIProvider implements LLMProvider {
  readonly id: ProviderId = 'openai'
  readonly label = 'OpenAI'

  constructor(
    private readonly key: KeyFn,
    private readonly modelOverride?: () => string | undefined,
    private readonly imageModelOverride?: () => string | undefined
  ) {}

  async isConfigured(): Promise<boolean> {
    return this.key().length > 0
  }

  /** Curated catalog — hardcoded, no /v1/models round-trip. */
  async listModels(): Promise<ModelInfo[]> {
    return CHAT_MODELS
  }

  async listImageModels(): Promise<ModelInfo[]> {
    return IMAGE_MODELS
  }

  async generateJSON<T>(req: GenerateJSONRequest): Promise<T> {
    const model = resolveChatModel(this.modelOverride?.())
    const reasoning = isReasoningModel(model)
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }]
    for (const img of req.images ?? []) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })
    }
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: req.schemaName, schema: req.jsonSchema, strict: false }
      },
      // reasoning models burn reasoning tokens from this budget — raise it
      max_completion_tokens: reasoning ? Math.max(req.maxTokens ?? 8000, 16000) : req.maxTokens ?? 8000
    }
    if (!reasoning) body.temperature = req.temperature ?? 0.8
    try {
      const json = await this.request<{ choices: Array<{ message: { content: string } }> }>('POST', '/chat/completions', body)
      const text = json.choices[0]?.message?.content ?? ''
      return this.parseJSON<T>(text)
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'invalid-request' && /temperature/i.test(e.message)) {
        // future model rejects sampling params — retry without them
        delete body.temperature
        const json = await this.request<{ choices: Array<{ message: { content: string } }> }>('POST', '/chat/completions', body)
        const text = json.choices[0]?.message?.content ?? ''
        return this.parseJSON<T>(text)
      }
      throw e
    }
  }

  async generateText(req: GenerateTextRequest): Promise<string> {
    const model = resolveChatModel(this.modelOverride?.())
    const reasoning = isReasoningModel(model)
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }]
    for (const img of req.images ?? []) {
      content.push({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` } })
    }
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content }
      ],
      max_completion_tokens: reasoning ? Math.max(req.maxTokens ?? 4000, 16000) : req.maxTokens ?? 4000
    }
    if (!reasoning) body.temperature = req.temperature ?? 0.8
    try {
      const json = await this.request<{ choices: Array<{ message: { content: string } }> }>('POST', '/chat/completions', body)
      return json.choices[0]?.message?.content ?? ''
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'invalid-request' && /temperature/i.test(e.message)) {
        delete body.temperature
        const json = await this.request<{ choices: Array<{ message: { content: string } }> }>('POST', '/chat/completions', body)
        return json.choices[0]?.message?.content ?? ''
      }
      throw e
    }
  }

  async generateImage(req: ImageGenRequest): Promise<Buffer> {
    const json = await this.request<{ data: Array<{ b64_json?: string }> }>('POST', '/images/generations', {
      model: this.imageModelOverride?.() ?? DEFAULT_IMAGE_MODEL,
      prompt: req.styleHint ? `${req.prompt}. Style: ${req.styleHint}` : req.prompt,
      size: nearestImageSize(req.width, req.height),
      n: 1
    })
    const b64 = json.data[0]?.b64_json
    if (!b64) throw new ProviderError('image generation returned no data', this.id, 'server')
    return Buffer.from(b64, 'base64')
  }

  /** TTS via /audio/speech, then Whisper word timestamps for caption sync. */
  async tts(req: TTSRequest): Promise<TTSResult> {
    const speech = await this.requestRaw('POST', '/audio/speech', {
      model: 'gpt-4o-mini-tts',
      voice: req.voice ?? 'nova',
      input: req.text,
      ...(req.instructions ? { instructions: req.instructions } : {}),
      response_format: 'mp3'
    })
    const audio = Buffer.from(await speech.arrayBuffer())
    const words = await this.transcribeWords(audio)
    return { audio, mimeType: 'audio/mpeg', words }
  }

  private async transcribeWords(audio: Buffer): Promise<TTSResult['words']> {
    try {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'narration.mp3')
      form.append('model', 'whisper-1')
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'word')
      const res = await fetch(`${API}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key()}` },
        body: form
      })
      if (!res.ok) return []
      const json = (await res.json()) as { words?: Array<{ word: string; start: number; end: number }> }
      return (json.words ?? []).map((w) => ({ word: w.word, startSec: w.start, endSec: w.end }))
    } catch {
      return [] // captions degrade to scene-level sync
    }
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
    const res = await this.requestRaw(method, path, body)
    return (await res.json()) as T
  }

  private async requestRaw(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
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
    return res
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

function nearestImageSize(w: number, h: number): string {
  const landscape = w >= h
  if (landscape) return w / h > 1.5 ? '1536x1024' : '1024x1024'
  return h / w > 1.5 ? '1024x1536' : '1024x1024'
}
