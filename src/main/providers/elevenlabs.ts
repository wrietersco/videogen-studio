import { meter } from '../usage/meter'
import { ProviderError, type TTSRequest, type TTSResult } from './types'

/**
 * ElevenLabs adapter — speech with character timestamps (folded into word
 * timings for captions) and music composition. Billed per character / minute.
 */

const API = 'https://api.elevenlabs.io/v1'

/** premade voices available on every account */
export const ELEVEN_VOICES: Record<string, string> = {
  George: 'JBFqnCBsd6RMkjVDRZzb',
  Rachel: '21m00Tcm4TlvDq8ikWAM',
  Adam: 'pNInz6obpgDQGcFmaJgB',
  Sarah: 'EXAVITQu4vr4xnSDxMaL'
}

export class ElevenLabsClient {
  constructor(private readonly key: () => string) {}

  configured(): boolean {
    return this.key().length > 0
  }

  async tts(req: TTSRequest & { model: string }): Promise<TTSResult> {
    const voiceId = ELEVEN_VOICES[req.voice ?? 'George'] ?? req.voice ?? ELEVEN_VOICES.George
    const json = (await (
      await this.post(`/text-to-speech/${voiceId}/with-timestamps?output_format=mp3_44100_128`, {
        text: req.text,
        model_id: req.model
      })
    ).json()) as {
      audio_base64: string
      alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }
    }
    meter.record({ kind: 'voice', provider: 'elevenlabs', model: req.model, usage: { chars: req.text.length } })
    return { audio: Buffer.from(json.audio_base64, 'base64'), mimeType: 'audio/mpeg', words: wordsFromChars(json.alignment) }
  }

  async music(prompt: string, seconds: number): Promise<Buffer> {
    const ms = Math.round(Math.min(300, Math.max(10, seconds)) * 1000)
    const res = await this.post('/music?output_format=mp3_44100_128', { prompt, music_length_ms: ms, model_id: 'music_v1' })
    meter.record({ kind: 'music', provider: 'elevenlabs', model: 'music_v1', usage: { seconds: ms / 1000 } })
    return Buffer.from(await res.arrayBuffer())
  }

  private async post(path: string, body: unknown): Promise<Response> {
    let res: Response
    try {
      res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'xi-api-key': this.key(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (e) {
      throw new ProviderError((e as Error).message, 'mock', 'network')
    }
    if (!res.ok) {
      let detail = `${res.status}`
      try {
        const j = (await res.json()) as { detail?: { message?: string } | string }
        detail = typeof j.detail === 'string' ? j.detail : (j.detail?.message ?? detail)
      } catch {
        /* keep status */
      }
      throw new Error(`[elevenlabs] ${detail}`)
    }
    return res
  }
}

function wordsFromChars(a?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] }): TTSResult['words'] {
  if (!a) return []
  const out: NonNullable<TTSResult['words']> = []
  let cur = ''
  let start = 0
  let end = 0
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (cur) out.push({ word: cur, startSec: start, endSec: end })
      cur = ''
      return
    }
    if (!cur) start = a.character_start_times_seconds[i]
    cur += ch
    end = a.character_end_times_seconds[i]
  })
  if (cur) out.push({ word: cur, startSec: start, endSec: end })
  return out
}
