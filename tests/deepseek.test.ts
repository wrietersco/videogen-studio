import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepseekProvider } from '../src/main/providers/deepseek'
import { ProviderError } from '../src/main/providers/types'
import { priceUsage } from '../src/shared/pricing'
import { meter } from '../src/main/usage/meter'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('DeepSeek adapter', () => {
  it('prices deepseek-chat at about $0.27 in / $1.10 out per 1M tok', () => {
    expect(priceUsage('deepseek-chat', { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(1.37, 2)
    expect(priceUsage('deepseek-reasoner', { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(2.74, 2)
  })

  it('sends chat completions with a bearer key and meters reported usage', async () => {
    const calls: Array<{ url: string; headers?: Record<string, string>; body?: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json({ choices: [{ message: { content: 'hello there' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })
    })
    meter.begin('library')
    const out = await new DeepseekProvider(() => 'sk-test').generateText({ system: 'be brief', prompt: 'say hi' })
    const run = meter.end(null)
    expect(out).toBe('hello there')
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
    expect(calls[0].body).toMatchObject({ model: 'deepseek-chat', max_tokens: 4000 })
    expect(calls[0].body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(calls[0].body).not.toHaveProperty('response_format')
    expect(run?.entries[0]).toMatchObject({ kind: 'text', provider: 'deepseek', model: 'deepseek-chat', usage: { inputTokens: 10, outputTokens: 5 } })
  })

  it('asks for json_object mode and parses fenced replies for generateJSON', async () => {
    let body: Record<string, unknown> | undefined
    let system = ''
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body))
      system = body.messages[0].content
      return json({ choices: [{ message: { content: '```json\n{"score": 9}\n```' } }] })
    })
    const r = await new DeepseekProvider(() => 'k').generateJSON<{ score: number }>({
      system: 'judge',
      prompt: 'the image',
      schemaName: 'MediaSuitability',
      jsonSchema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] }
    })
    expect(r.score).toBe(9)
    expect(body?.response_format).toEqual({ type: 'json_object' })
    expect(system).toContain('"score"')
  })

  it('sends images as image_url parts and omits temperature for the reasoner', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return json({ choices: [{ message: { content: 'ok' } }] })
    })
    await new DeepseekProvider(() => 'k').generateText({
      system: 's',
      prompt: 'look',
      images: [{ mimeType: 'image/jpeg', base64: 'AAAA' }],
      temperature: 0.5
    })
    await new DeepseekProvider(() => 'k', () => 'deepseek-reasoner').generateText({ system: 's', prompt: 'think', temperature: 0.5 })
    expect(bodies[0].messages[1].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
    ])
    expect(bodies[0].temperature).toBe(0.5)
    expect(bodies[1].model).toBe('deepseek-reasoner')
    expect(bodies[1].temperature).toBeUndefined()
  })

  it('maps a 401 to an auth ProviderError', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const p = new DeepseekProvider(() => 'bad-key')
    const err = await p.generateText({ system: 's', prompt: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).kind).toBe('auth')
    expect((err as ProviderError).provider).toBe('deepseek')
  })

  it('needs a key and lists its catalog', async () => {
    const p = new DeepseekProvider(() => '')
    await expect(p.isConfigured()).resolves.toBe(false)
    const models = await new DeepseekProvider(() => 'k').listModels()
    expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner'])
    expect(models.every((m) => m.provider === 'deepseek')).toBe(true)
  })
})
