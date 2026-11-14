import { afterEach, describe, expect, it, vi } from 'vitest'
import { GeminiProvider } from '../src/main/providers/gemini'

/** a 0.5 s silent 24 kHz mono PCM clip, base64 */
const PCM = Buffer.alloc(24000).toString('base64')
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const calls: Array<{ url: string; body: any }> = []

function stub(handler: (url: string, body: any) => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: string }) => {
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ url: String(url), body })
    return handler(String(url), body)
  }))
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0 })

const provider = () => new GeminiProvider(() => 'test-key')
const TONE = 'Confident, upbeat product-launch announcer. Warm and energetic.'
const TEXT = "Taaweel's ontology lets you visualize Quran concepts."

describe('Gemini speech: the direction is never part of the spoken text', () => {
  it('3.8 voices get the transcript alone and the tone as speech_metadata', async () => {
    stub(() => ok({ steps: [{ type: 'model_output', content: [{ type: 'audio', data: PCM, mime_type: 'audio/l16;rate=24000' }] }], usage: { total_input_tokens: 20, total_output_tokens: 40 } }))
    const r = await provider().tts({ text: TEXT, voice: 'Kore', instructions: TONE, model: 'gemini-3.8-flash-tts' })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toMatch(/\/interactions$/)
    const block = calls[0].body.input[0].content[0]
    expect(block.text).toBe(TEXT)
    expect(JSON.stringify(calls[0].body)).not.toMatch(/Read this/i)
    expect(block.annotations[0]).toMatchObject({ type: 'speech_metadata' })
    expect(block.annotations[0].style).toContain('upbeat')
    expect(calls[0].body.generation_config.speech_config[0].voice).toBe('Kore')
    expect(r.mimeType).toBe('audio/wav')
    expect(r.audio.subarray(0, 4).toString('latin1')).toBe('RIFF')
  })

  it('falls back to the transcript alone (never the direction in the text) when the new call is refused', async () => {
    stub((url) => (url.endsWith('/interactions') ? new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }) : ok({ candidates: [{ content: { parts: [{ inlineData: { data: PCM } }] } }] })))
    const r = await provider().tts({ text: TEXT, instructions: TONE, model: 'gemini-3.8-flash-lite-tts' })
    expect(calls).toHaveLength(2)
    expect(calls[1].url).toMatch(/generateContent$/)
    expect(calls[1].body.contents[0].parts[0].text).toBe(TEXT)
    expect(r.audio.length).toBeGreaterThan(44)
  })

  it('a rejected key is reported, not hidden by the fallback', async () => {
    stub(() => new Response(JSON.stringify({ error: { message: 'API key not valid' } }), { status: 401 }))
    await expect(provider().tts({ text: TEXT, instructions: TONE, model: 'gemini-3.8-flash-tts' })).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('2.5 voices still read the direction from the prompt', async () => {
    stub(() => ok({ candidates: [{ content: { parts: [{ inlineData: { data: PCM } }] } }] }))
    await provider().tts({ text: TEXT, instructions: TONE })
    expect(calls[0].url).toMatch(/gemini-2\.5-flash-preview-tts:generateContent$/)
    expect(calls[0].body.contents[0].parts[0].text).toMatch(/Read this: Taaweel/)
  })
})
