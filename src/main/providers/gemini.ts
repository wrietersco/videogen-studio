import type {
  GenerateJSONRequest,
  GenerateTextRequest,
  ImageGenRequest,
  LLMProvider,
  ModelInfo,
  ProviderId
} from './types'
import { ProviderError } from './types'
import { meter } from '../usage/meter'

/**
 * Gemini adapter — generateContent with responseSchema (structured output),
 * inline_data vision, image generation via the Gemini image model. No TTS.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta'

type KeyFn = () => string

const DEFAULT_MODEL = 'gemini-3.8-flash'
// gemini-2.5-flash-image was shut down 2026-10-02
const DEFAULT_IMAGE_MODEL = 'gemini-3.1-flash-image'

type UsageMeta = { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } }

export class GeminiProvider implements LLMProvider {
  readonly id: ProviderId = 'gemini'
  readonly label = 'Google (Gemini)'

  constructor(
    private readonly key: KeyFn,
    private readonly modelOverride?: () => string | undefined,
    private readonly imageModelOverride?: () => string | undefined
  ) {}

  async isConfigured(): Promise<boolean> {
    return this.key().length > 0
  }

  async listModels(): Promise<ModelInfo[]> {
    const json = await this.request<{ models: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }> }>(
      'GET',
      '/models'
    )
    return json.models
      .filter(
        (m) =>
          /gemini/.test(m.name) &&
          !/embedding|aqa|tts|image|native-audio|live|thinking-exp/.test(m.name) &&
          (m.supportedGenerationMethods?.includes('generateContent') ?? true)
      )
      .map((m) => ({
        id: m.name.replace(/^models\//, ''),
        label: m.displayName ?? m.name,
        provider: this.id,
        supportsJSON: true,
        supportsVision: !/gemini-1\.0/.test(m.name)
      }))
  }

  async generateJSON<T>(req: GenerateJSONRequest): Promise<T> {
    const model = this.modelOverride?.() ?? DEFAULT_MODEL
    const { contents, system } = this.buildContents(req.system, req.prompt, req.images)
    const body = {
      contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toOpenApiish(req.jsonSchema),
        temperature: req.temperature ?? 0.8,
        maxOutputTokens: req.maxTokens ?? 8192
      }
    }
    const json = await this.request<{ candidates: Array<{ content: { parts: Array<{ text?: string }> } }> } & UsageMeta>(
      'POST',
      `/models/${model}:generateContent`,
      body
    )
    this.meterText(model, json)
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    try {
      return JSON.parse(text) as T
    } catch (e) {
      throw new ProviderError(`unparseable JSON: ${(e as Error).message}`, this.id, 'schema-violation')
    }
  }

  async generateText(req: GenerateTextRequest): Promise<string> {
    const model = this.modelOverride?.() ?? DEFAULT_MODEL
    const { contents, system } = this.buildContents(req.system, req.prompt, req.images)
    const json = await this.request<{ candidates: Array<{ content: { parts: Array<{ text?: string }> } }> } & UsageMeta>(
      'POST',
      `/models/${model}:generateContent`,
      {
        contents,
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: { temperature: req.temperature ?? 0.8, maxOutputTokens: req.maxTokens ?? 4096 }
      }
    )
    this.meterText(model, json)
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  }

  /** native image output (aspect ratio is requested; the plate engine crops to the exact canvas) */
  async generateImage(req: ImageGenRequest): Promise<Buffer> {
    const model = req.model ?? this.imageModelOverride?.() ?? DEFAULT_IMAGE_MODEL
    const r = req.width / req.height
    const aspectRatio = r > 1.5 ? '16:9' : r > 1.1 ? '4:3' : r > 0.9 ? '1:1' : r > 0.7 ? '4:5' : '9:16'
    const json = await this.request<{ candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string }; inline_data?: { data?: string } }> } }> }>(
      'POST',
      `/models/${model}:generateContent`,
      {
        contents: [{ role: 'user', parts: [{ text: req.styleHint ? `${req.prompt} Style: ${req.styleHint}` : req.prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } }
      }
    )
    meter.record({ kind: 'image', provider: 'gemini', model, usage: { images: 1 } })
    const parts = json.candidates?.[0]?.content?.parts ?? []
    const b64 = parts.map((p) => p.inlineData?.data ?? p.inline_data?.data).find(Boolean)
    if (!b64) throw new ProviderError('image generation returned no image', this.id, 'server')
    return Buffer.from(b64, 'base64')
  }

  private meterText(model: string, json: UsageMeta): void {
    const u = json.usageMetadata
    meter.record({
      kind: 'text',
      provider: 'gemini',
      model,
      usage: { inputTokens: u?.promptTokenCount ?? 0, outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0) }
    })
  }

  private buildContents(system: string, prompt: string, images?: Array<{ mimeType: string; base64: string }>) {
    const parts: Array<Record<string, unknown>> = []
    for (const img of images ?? []) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64 } })
    }
    parts.push({ text: prompt })
    return { contents: [{ role: 'user', parts }], system }
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method,
        headers: {
          'x-goog-api-key': this.key(),
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

/** Gemini's responseSchema is a subset of OpenAPI — strip JSON-Schema-only keys. */
function toOpenApiish(schema: Record<string, unknown>): Record<string, unknown> {
  const clean = (obj: unknown): unknown => {
    if (Array.isArray(obj)) return obj.map(clean)
    if (obj && typeof obj === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (['additionalProperties', '$schema', 'default'].includes(k)) continue
        out[k] = clean(v)
      }
      return out
    }
    return obj
  }
  return clean(schema) as Record<string, unknown>
}
