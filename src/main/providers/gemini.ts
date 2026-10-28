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

  /** Curated catalog (rates from the shipped price book), cheapest → priciest. */
  async listModels(): Promise<ModelInfo[]> {
    const m = (id: string, label: string, priceNote: string): ModelInfo => ({ id, label, provider: this.id, supportsJSON: true, supportsVision: true, priceNote })
    return [
      m('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', '$0.10 in / $0.40 out per 1M tok'),
      m('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', '$0.25 in / $1.50 out per 1M tok'),
      m('gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', '$0.30 in / $2.50 out per 1M tok'),
      m('gemini-3.8-flash', 'Gemini 3.8 Flash', '$0.75 in / $3.75 out per 1M tok · intro price to Dec 31'),
      m('gemini-4-argon', 'Gemini 4 Argon', '$2 in / $10 out per 1M tok · intro price to Nov 30'),
      m('gemini-3.1-pro-preview', 'Gemini 3.1 Pro (preview)', '$2 in / $12 out per 1M tok')
    ]
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

  /** Gemini TTS: 24 kHz 16-bit mono PCM, wrapped as WAV; style rides in the prompt */
  async tts(req: TTSRequest): Promise<TTSResult> {
    const model = req.model ?? 'gemini-2.5-flash-preview-tts'
    const text = req.instructions ? `${req.instructions.split('.')[0]}. Read this: ${req.text}` : req.text
    const json = await this.request<{ candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> } & UsageMeta>(
      'POST',
      `/models/${model}:generateContent`,
      {
        contents: [{ role: 'user', parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice ?? 'Charon' } } }
        }
      }
    )
    const u = json.usageMetadata
    meter.record({ kind: 'voice', provider: 'gemini', model, usage: { inputTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0 } })
    const b64 = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data
    if (!b64) throw new ProviderError('speech returned no audio', this.id, 'server')
    return { audio: pcmToWav(Buffer.from(b64, 'base64'), 24000), mimeType: 'audio/wav', words: [] }
  }

  /**
   * Lyria (Interactions API): one request → one finished 44.1 kHz stereo track.
   * Length, structure, tempo and "instrumental" all ride in the prompt.
   */
  async music(prompt: string, model = 'lyria-3.5'): Promise<{ audio: Buffer; text: string }> {
    const json = await this.request<{
      steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; text?: string }> }>
    }>('POST', '/interactions', { model, input: prompt })
    meter.record({ kind: 'music', provider: 'gemini', model, usage: { items: 1 } })
    const blocks = (json.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? [])
    const b64 = blocks.filter((c) => c.type === 'audio' && c.data).at(-1)?.data
    if (!b64) throw new ProviderError('music generation returned no audio', this.id, 'server')
    return { audio: Buffer.from(b64, 'base64'), text: blocks.map((c) => c.text ?? '').join('\n').trim() }
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

function pcmToWav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + pcm.length, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}
