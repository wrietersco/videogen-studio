import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepseekProvider } from '../src/main/providers/deepseek'
import { ProviderError } from '../src/main/providers/types'
import { priceUsage } from '../src/shared/pricing'
import { meter } from '../src/main/usage/meter'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('DeepSeek adapter', () => {
  it('prices the V4 models at their peak rates', () => {
    expect(priceUsage('deepseek-flash', { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(1.5, 2)
    expect(priceUsage('deepseek-v4-pro', { inputTokens: 1_000_000, outputTokens: 1_000_000 }).usd).toBeCloseTo(5.28, 2)
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
    expect(calls[0].url).toBe('https://api.deepseek.com/chat/completions')
    expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
    expect(calls[0].body).toMatchObject({ model: 'deepseek-flash', max_tokens: 4000 })
    expect(calls[0].body).not.toHaveProperty('temperature')
    expect(calls[0].body).not.toHaveProperty('response_format')
    expect(run?.entries[0]).toMatchObject({ kind: 'text', provider: 'deepseek', model: 'deepseek-flash', usage: { inputTokens: 10, outputTokens: 5 } })
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

  it('sends images as image_url parts (Flash vision)', async () => {
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
    expect(bodies[0].messages[1].content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
    ])
    expect(bodies[0].temperature).toBe(0.5)
  })

  it('retries without temperature when the model rejects sampling params', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length === 1) return json({ error: { message: 'temperature is not supported by this model' } }, 400)
      return json({ choices: [{ message: { content: 'done' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
    })
    const out = await new DeepseekProvider(() => 'k').generateText({ system: 's', prompt: 'x', temperature: 0.7 })
    expect(out).toBe('done')
    expect(bodies[0].temperature).toBe(0.7)
    expect(bodies[1].temperature).toBeUndefined()
  })

  it('maps legacy model ids to the current flash model', async () => {
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return json({ choices: [{ message: { content: 'ok' } }] })
    })
    await new DeepseekProvider(() => 'k', () => 'deepseek-reasoner').generateText({ system: 's', prompt: 'x' })
    await new DeepseekProvider(() => 'k', () => 'deepseek-chat').generateText({ system: 's', prompt: 'x' })
    expect(bodies[0].model).toBe('deepseek-flash')
    expect(bodies[1].model).toBe('deepseek-flash')
  })

  it('maps a 401 to an auth ProviderError', async () => {
    vi.stubGlobal('fetch', async () => json({ error: { message: 'Invalid API key' } }, 401))
    const p = new DeepseekProvider(() => 'bad-key')
    const err = await p.generateText({ system: 's', prompt: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect((err as ProviderError).kind).toBe('auth')
    expect((err as ProviderError).provider).toBe('deepseek')
  })

  it('needs a key and lists its catalog, cheapest first', async () => {
    const p = new DeepseekProvider(() => '')
    await expect(p.isConfigured()).resolves.toBe(false)
    const models = await new DeepseekProvider(() => 'k').listModels()
    expect(models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(models.find((m) => m.id === 'deepseek-flash')?.supportsVision).toBe(true)
    expect(models.find((m) => m.id === 'deepseek-v4-pro')?.supportsVision).toBe(false)
    expect(models.every((m) => m.provider === 'deepseek')).toBe(true)
  })
})
