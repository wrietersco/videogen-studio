import { meter } from '../usage/meter'

/**
 * Gemini Omni Flash video clips — the Gemini API's only video model since
 * the Veo previews were shut down on 2026-10-22. Uses the Interactions API:
 *   POST /v1beta/interactions { model, input, response_format: { type: 'video', … } }
 * The clip comes back inline (base64) or, with delivery 'uri', as a Files API
 * link we download. Billed as output tokens: 5,792 tokens per second of 720p
 * (≈ $0.10/s), so when the response carries no usage we estimate from that.
 */

const API = 'https://generativelanguage.googleapis.com/v1beta'
export const GEMINI_VIDEO_MODEL = 'gemini-omni-1.1-flash'
export const OMNI_TOKENS_PER_SEC = 5792
/** typical clip length when the response doesn't say (used for estimates only) */
const TYPICAL_SEC = 8

export interface ClipRequest {
  prompt: string
  aspect?: '16:9' | '9:16'
  /** optional first frame / reference picture (image_to_video) */
  image?: { mimeType: string; base64: string }
  model?: string
}

type Content = { type: string; mime_type?: string; data?: string; uri?: string }
type Interaction = {
  id?: string
  status?: string
  steps?: Array<{ type: string; content?: Content[] }>
  outputs?: Content[]
  usage?: { total_input_tokens?: number; total_output_tokens?: number }
  error?: { message?: string }
}

export class GeminiVideoClient {
  constructor(private readonly key: () => string) {}

  configured(): boolean {
    return this.key().length > 0
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.key(), 'Content-Type': 'application/json' }
  }

  private async call<T>(method: 'GET' | 'POST', url: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    let res: Response
    try {
      res = await fetch(url, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'Gemini took too long to make the clip — try again' : (e as Error).message
      throw new Error(msg)
    }
    if (!res.ok) {
      let detail = `${res.status}`
      try {
        detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? detail
      } catch {
        /* keep status */
      }
      if (res.status === 401 || res.status === 403) throw new Error(`Gemini rejected the key: ${detail}`)
      if (res.status === 429) throw new Error(`Gemini rate limit / quota: ${detail} (video needs the paid tier)`)
      throw new Error(`Gemini video failed: ${detail}`)
    }
    return (await res.json()) as T
  }

  /** make one clip; returns mp4 bytes plus what was billed */
  async clip(req: ClipRequest): Promise<{ video: Buffer; model: string; usd?: number; outputTokens: number }> {
    if (!this.configured()) throw new Error('Add a Gemini key in Settings to make video clips')
    const model = req.model ?? GEMINI_VIDEO_MODEL
    const input = req.image
      ? [
          { type: 'image', data: req.image.base64, mime_type: req.image.mimeType },
          { type: 'text', text: req.prompt }
        ]
      : req.prompt
    const body: Record<string, unknown> = {
      model,
      input,
      response_format: { type: 'video', aspect_ratio: req.aspect ?? '16:9', resolution: '720p', delivery: 'uri' }
    }
    if (req.image) body.generation_config = { video_config: { task: 'image_to_video' } }

    // generation usually finishes inside the request; poll if the API hands back a running interaction
    let it = await this.call<Interaction>('POST', `${API}/interactions`, body, 8 * 60_000)
    const deadline = Date.now() + 10 * 60_000
    while (it.status && it.status === 'in_progress' && it.id && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000))
      it = await this.call<Interaction>('GET', `${API}/interactions/${it.id}`)
    }
    if (it.status && it.status !== 'completed') throw new Error(it.error?.message ?? `Gemini video ${it.status}`)

    const item = findVideo(it)
    if (!item) throw new Error('Gemini returned no video (the prompt may have been blocked)')
    const video = item.data ? Buffer.from(item.data, 'base64') : await this.download(item.uri!)

    const outputTokens = it.usage?.total_output_tokens ?? OMNI_TOKENS_PER_SEC * TYPICAL_SEC
    const entry = meter.record({
      kind: 'video',
      provider: 'gemini',
      model,
      usage: { inputTokens: it.usage?.total_input_tokens ?? 0, outputTokens, seconds: Math.round(outputTokens / OMNI_TOKENS_PER_SEC) },
      note: it.usage?.total_output_tokens ? undefined : 'estimated from clip length'
    })
    return { video, model, usd: entry?.usd, outputTokens }
  }

  /** Files API link → bytes (waits for the file to turn ACTIVE) */
  private async download(uri: string): Promise<Buffer> {
    const id = /files\/([^/:?]+)/.exec(uri)?.[1]
    if (id) {
      for (let i = 0; i < 60; i++) {
        const f = await this.call<{ state?: string }>('GET', `${API}/files/${id}`)
        if (!f.state || f.state === 'ACTIVE') break
        if (f.state === 'FAILED') throw new Error('Gemini could not finish the video file')
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
    const url = id ? `${API}/files/${id}:download?alt=media` : uri
    const res = await fetch(url, { headers: { 'x-goog-api-key': this.key() }, redirect: 'follow', signal: AbortSignal.timeout(180_000) })
    if (!res.ok) throw new Error(`video download failed (${res.status})`)
    return Buffer.from(await res.arrayBuffer())
  }
}

function findVideo(it: Interaction): Content | undefined {
  const pool = [...(it.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []), ...(it.outputs ?? [])]
  return pool.find((c) => c.type === 'video' && (c.data || c.uri))
}
