import type {
  GenerateJSONRequest,
  GenerateTextRequest,
  LLMProvider,
  ModelInfo,
  ProviderId
} from './types'
import { ProviderError } from './types'

/**
 * Gemini adapter — generateContent with responseSchema (structured output),
 * inline_data vision. No image-gen/TTS in this adapter.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta'

type KeyFn = () => string

export class GeminiProvider implements LLMProvider {
  readonly id: ProviderId = 'gemini'
  readonly label = 'Google (Gemini)'

  constructor(private readonly key: KeyFn, private readonly modelOverride?: () => string | undefined) {}

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
    const model = this.modelOverride?.() ?? 'gemini-2.5-flash'
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
    const json = await this.request<{ candidates: Array<{ content: { parts: Array<{ text?: string }> } }> }>(
      'POST',
      `/models/${model}:generateContent`,
      body
    )
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
    try {
      return JSON.parse(text) as T
    } catch (e) {
      throw new ProviderError(`unparseable JSON: ${(e as Error).message}`, this.id, 'schema-violation')
    }
  }

  async generateText(req: GenerateTextRequest): Promise<string> {
    const model = this.modelOverride?.() ?? 'gemini-2.5-flash'
    const { contents, system } = this.buildContents(req.system, req.prompt, req.images)
    const json = await this.request<{ candidates: Array<{ content: { parts: Array<{ text?: string }> } }> }>(
      'POST',
      `/models/${model}:generateContent`,
      {
        contents,
        systemInstruction: { parts: [{ text: system }] },
        generationConfig: { temperature: req.temperature ?? 0.8, maxOutputTokens: req.maxTokens ?? 4096 }
      }
    )
    return json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
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
