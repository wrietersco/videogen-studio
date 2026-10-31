import { createHash } from 'node:crypto'
import { priceUsage, type UsageNumbers } from '../../src/shared/pricing'
import type { PlanMediaKind } from '../../src/shared/plans'

/**
 * The provider surface the server will relay, and nothing else. A licence must
 * not become a key to every model a provider sells, so each route is matched
 * against an allow-list, the model is read out of the request, and the call is
 * priced from what the provider reports (or a stated estimate when it reports
 * nothing). Mirrors how the desktop app's own adapters meter each call.
 */

export type ProviderName = 'openai' | 'gemini' | 'elevenlabs'
export const PROVIDERS: readonly ProviderName[] = ['openai', 'gemini', 'elevenlabs']

export const UPSTREAM_BASE: Record<ProviderName, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  elevenlabs: 'https://api.elevenlabs.io/v1'
}

/** the real credential header for each provider */
export function authHeader(provider: ProviderName, key: string): Record<string, string> {
  if (provider === 'openai') return { Authorization: `Bearer ${key}` }
  if (provider === 'gemini') return { 'x-goog-api-key': key }
  return { 'xi-api-key': key }
}

export interface RouteMatch {
  provider: ProviderName
  method: 'GET' | 'POST'
  /** path after the provider base, query included */
  path: string
  /** model the call runs; '' for follow-up reads of an earlier call (polling, downloads) */
  model: string
  kind: PlanMediaKind | 'utility'
  /** an animated clip (counts against the video's clips) */
  isClip: boolean
  /** a read of something an earlier call of this video produced (interaction / file id) */
  ref?: string
  /** relay the response as a stream (large binary downloads) */
  stream: boolean
}

export class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

const MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/i
const ID = /^[A-Za-z0-9_-]{1,128}$/

function bodyModel(body: unknown, field = 'model'): string {
  const m = body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined
  if (typeof m !== 'string' || !MODEL.test(m)) throw new RouteError(400, 'model_required', 'The request does not name a model.')
  return m
}

/** Gemini generateContent serves chat, pictures and speech; the model id says which */
export function geminiKind(model: string): PlanMediaKind {
  if (/-tts$|-tts-/.test(model)) return 'voice'
  if (/image|banana/.test(model)) return 'image'
  return 'chat'
}

/** match a relayed request against the allow-list; throws RouteError when it is not on it */
export function matchRoute(provider: string, method: string, rawPath: string, body: unknown, multipartModel?: string): RouteMatch {
  if (!PROVIDERS.includes(provider as ProviderName)) throw new RouteError(404, 'unknown_provider', 'Unknown AI provider.')
  const p = provider as ProviderName
  const [pathOnly, query = ''] = rawPath.split('?', 2)
  const path = pathOnly.replace(/^\/+/, '')
  const keepQuery = (allowed: string[]): string => {
    const q = new URLSearchParams(query)
    const out = new URLSearchParams()
    for (const k of allowed) if (q.has(k)) out.set(k, q.get(k)!)
    const s = out.toString()
    return s ? `${path}?${s}` : path
  }
  const base = { provider: p, isClip: false, stream: false }

  if (p === 'openai' && method === 'POST') {
    if (path === 'chat/completions') {
      if ((body as { stream?: unknown })?.stream) throw new RouteError(400, 'stream_unsupported', 'Streaming is not supported.')
      return { ...base, method: 'POST', path, model: bodyModel(body), kind: 'chat' }
    }
    if (path === 'images/generations') return { ...base, method: 'POST', path, model: bodyModel(body), kind: 'image' }
    if (path === 'audio/speech') return { ...base, method: 'POST', path, model: bodyModel(body), kind: 'voice', stream: true }
    if (path === 'audio/transcriptions') {
      if (!multipartModel || !MODEL.test(multipartModel)) throw new RouteError(400, 'model_required', 'The request does not name a model.')
      return { ...base, method: 'POST', path, model: multipartModel, kind: 'utility' }
    }
  }

  if (p === 'gemini') {
    const gen = /^models\/([a-z0-9][a-z0-9._-]{0,63}):generateContent$/i.exec(path)
    if (gen && method === 'POST') return { ...base, method: 'POST', path, model: gen[1], kind: geminiKind(gen[1]) }
    if (path === 'interactions' && method === 'POST') {
      const model = bodyModel(body)
      if (/omni|veo/.test(model)) return { ...base, method: 'POST', path, model, kind: 'video', isClip: true }
      if (/lyria/.test(model)) return { ...base, method: 'POST', path, model, kind: 'music' }
      throw new RouteError(403, 'model_not_relayed', `${model} is not available through VideoGen.`)
    }
    const it = /^interactions\/([^/]+)$/.exec(path)
    if (it && method === 'GET' && ID.test(it[1])) return { ...base, method: 'GET', path, model: '', kind: 'video', ref: `interactions/${it[1]}` }
    const file = /^files\/([^/:]+)(:download)?$/.exec(path)
    if (file && method === 'GET' && ID.test(file[1])) {
      return { ...base, method: 'GET', path: file[2] ? keepQuery(['alt']) : path, model: '', kind: 'video', ref: `files/${file[1]}`, stream: Boolean(file[2]) }
    }
  }

  if (p === 'elevenlabs' && method === 'POST') {
    const tts = /^text-to-speech\/([A-Za-z0-9]{1,64})\/with-timestamps$/.exec(path)
    if (tts) return { ...base, method: 'POST', path: keepQuery(['output_format']), model: bodyModel(body, 'model_id'), kind: 'voice' }
    if (path === 'music') return { ...base, method: 'POST', path: keepQuery(['output_format']), model: bodyModel(body, 'model_id'), kind: 'music', stream: true }
  }

  throw new RouteError(404, 'route_not_relayed', 'That AI call is not available through VideoGen.')
}

/** ids a response hands back that later GETs of the same video may read */
export function refsFromResponse(json: unknown): string[] {
  const out = new Set<string>()
  const text = JSON.stringify(json ?? null)
  const id = (json as { id?: unknown })?.id
  if (typeof id === 'string' && ID.test(id)) out.add(`interactions/${id}`)
  for (const m of text.matchAll(/files\/([A-Za-z0-9_-]{1,128})/g)) out.add(`files/${m[1]}`)
  return [...out].slice(0, 20)
}

const OMNI_TOKENS_PER_SEC = 5792

/**
 * What one finished call cost. Uses the provider's own usage report where it
 * gives one, the same estimates the desktop meter uses where it does not.
 */
export function meterCall(route: RouteMatch, reqBody: unknown, resJson: unknown, extra: { audioBytes?: number } = {}): { usage: UsageNumbers; usd: number; estimated: boolean } {
  const b = (reqBody ?? {}) as Record<string, unknown>
  const r = (resJson ?? {}) as Record<string, any>
  let usage: UsageNumbers = {}
  let estimated = false
  if (!route.model) return { usage, usd: 0, estimated }

  if (route.provider === 'openai') {
    if (route.path === 'chat/completions') {
      usage = { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 }
    } else if (route.path === 'images/generations') {
      estimated = !r.usage
      usage = { inputTokens: r.usage?.input_tokens ?? Math.ceil(String(b.prompt ?? '').length / 4), outputTokens: r.usage?.output_tokens ?? 6240, images: 1 }
    } else if (route.path === 'audio/speech') {
      // speech reports no usage: ~4 chars/token in, ~21 audio tokens/s out, ~15 chars/s spoken
      estimated = true
      const chars = String(b.input ?? '').length + String(b.instructions ?? '').length
      const sec = extra.audioBytes ? extra.audioBytes / 16000 : chars / 15
      usage = { inputTokens: Math.ceil(chars / 4), outputTokens: Math.round(sec * 20.8), seconds: sec }
    } else if (route.path === 'audio/transcriptions') {
      estimated = typeof r.duration !== 'number'
      usage = { seconds: typeof r.duration === 'number' ? r.duration : 60 }
    }
  } else if (route.provider === 'gemini') {
    if (route.path.endsWith(':generateContent')) {
      const u = r.usageMetadata ?? {}
      if (route.kind === 'image') usage = { images: 1, inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0 }
      else usage = { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) }
    } else if (route.path === 'interactions') {
      if (route.isClip) {
        const out = r.usage?.total_output_tokens
        estimated = typeof out !== 'number'
        usage = { inputTokens: r.usage?.total_input_tokens ?? 0, outputTokens: out ?? OMNI_TOKENS_PER_SEC * 8 }
      } else {
        usage = { items: 1 }
      }
    }
  } else if (route.provider === 'elevenlabs') {
    if (route.kind === 'voice') usage = { chars: String(b.text ?? '').length }
    else usage = { seconds: Math.min(300, Math.max(10, Number(b.music_length_ms ?? 30_000) / 1000)) }
  }
  const { usd, priced } = priceUsage(route.model, usage)
  // an unpriced model must not run free: charge it like the priciest chat call we know
  return { usage, usd: priced ? usd : 0.5, estimated: estimated || !priced }
}

/** a cheap pre-flight figure, so a nearly-spent budget refuses before paying, not after */
export function estimateCall(route: RouteMatch): number {
  if (!route.model) return 0
  if (route.isClip) return priceUsage(route.model, { outputTokens: OMNI_TOKENS_PER_SEC * 8 }).usd
  if (route.kind === 'image') return 0.05
  if (route.kind === 'music') return 0.08
  return 0.005
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
