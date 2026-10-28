import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiVideoClient } from '../src/main/providers/geminiVideo'
import { priceUsage } from '../src/shared/pricing'
import { meter } from '../src/main/usage/meter'

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('Gemini Omni Flash clips', () => {
  it('prices 8s of 720p at about $0.80', () => {
    expect(priceUsage('gemini-omni-1.1-flash', { outputTokens: 5792 * 8 }).usd).toBeCloseTo(0.81, 2)
  })

  it('decodes an inline clip and meters the real usage', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return json({
        status: 'completed',
        steps: [{ type: 'model_output', content: [{ type: 'video', mime_type: 'video/mp4', data: Buffer.from('MP4DATA').toString('base64') }] }],
        usage: { total_input_tokens: 20, total_output_tokens: 5792 * 6 }
      })
    })
    meter.begin('library')
    const r = await new GeminiVideoClient(() => 'k').clip({ prompt: 'a fox in snow', aspect: '9:16' })
    const run = meter.end(null)
    expect(r.video.toString()).toBe('MP4DATA')
    expect(calls[0].url).toMatch(/\/v1beta\/interactions$/)
    expect(calls[0].body).toMatchObject({ model: 'gemini-omni-1.1-flash', input: 'a fox in snow', response_format: { type: 'video', aspect_ratio: '9:16' } })
    expect(run?.entries[0]).toMatchObject({ kind: 'video', model: 'gemini-omni-1.1-flash' })
    expect(run?.totalUsd).toBeCloseTo(0.608, 2)
  })

  it('polls a running interaction and downloads a uri clip', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url)
      if (url.endsWith('/interactions')) return json({ id: 'v1_x', status: 'in_progress' })
      if (url.endsWith('/interactions/v1_x'))
        return json({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media' }] }] })
      if (url.endsWith('/files/abc123')) return json({ state: 'ACTIVE' })
      return new Response('CLIP', { status: 200 })
    })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const p = new GeminiVideoClient(() => 'k').clip({ prompt: 'waves' })
    await vi.runAllTimersAsync()
    const r = await p
    vi.useRealTimers()
    expect(r.video.toString()).toBe('CLIP')
    expect(seen.at(-1)).toContain('/files/abc123:download?alt=media')
  })

  it('needs a key', async () => {
    await expect(new GeminiVideoClient(() => '').clip({ prompt: 'x' })).rejects.toThrow(/Gemini key/)
  })
})
