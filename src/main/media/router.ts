import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import type { VideoSpec } from '@shared/spec'
import { tokenize, type AssetMeta } from '@shared/assets'
import { priceUsage, type UsageNumbers } from '@shared/pricing'
import { orientationOf, type AssetLibrary } from '../assets/library'
import type { LLMProvider, ProviderId, SpeechProvider, VoiceCache } from '../providers/types'
import { ElevenLabsClient, ELEVEN_VOICES } from '../providers/elevenlabs'
import { VOICES } from '../audio/voice'
import { beatGrid } from '../audio/score'
import { meter } from '../usage/meter'
import type { KeyId, Settings } from '../settings'
import { downloadStock, searchStock } from './stock'

/**
 * Media router — the one place that decides where each asset comes from:
 *   1. the asset library (exact or close match, when reuse is 'smart')
 *   2. free stock (when chosen in Settings → Media)
 *   3. a paid generation with the chosen provider/model
 * Every new asset is filed in the library with its metadata so the next
 * video can reuse it, and every reuse is logged as money saved.
 */

export interface MediaDeps {
  library: AssetLibrary
  settings: () => Settings
  key: (id: KeyId) => string
  provider: (id: ProviderId) => LLMProvider
  /** the active chat provider's painter, else any keyed one (legacy 'auto') */
  autoImageProvider: () => LLMProvider | null
}

export interface PaintRequest {
  /** the director's plate brief (what to show) */
  brief: string
  /** the full prompt sent to the image model (brief + art direction + composition) */
  fullPrompt: string
  subjectLabel?: string
  look?: string
  width: number
  height: number
  projectId: string
}

export interface PaintResult {
  buffer: Buffer
  assetId: string
  source: AssetMeta['source']
  reused: boolean
}

const IMAGE_DEFAULT: Record<string, string> = { openai: 'gpt-image-2.5-sunburst', gemini: 'gemini-3.1-flash-image' }
const GEMINI_VOICES = ['Charon', 'Kore', 'Puck', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'] as const

function split(v: string): [string, string | undefined] {
  const i = v.indexOf(':')
  return i < 0 ? [v, undefined] : [v.slice(0, i), v.slice(i + 1)]
}

export class MediaRouter {
  private readonly eleven: ElevenLabsClient

  constructor(private readonly d: MediaDeps) {
    this.eleven = new ElevenLabsClient(() => d.key('elevenlabs'))
  }

  get library(): AssetLibrary {
    return this.d.library
  }

  private get reuse(): boolean {
    return this.d.settings().reuse !== 'fresh'
  }

  // ---------------- images ----------------

  /** the painter Settings → Media points at, with its model (null → stock or nothing) */
  private painter(): { provider: LLMProvider; model?: string } | null {
    const [p, model] = split(this.d.settings().media.image || 'auto')
    if (p === 'auto') {
      const auto = this.d.autoImageProvider()
      return auto ? { provider: auto } : null
    }
    if ((p === 'openai' || p === 'gemini') && this.d.key(p)) return { provider: this.d.provider(p), model }
    return null
  }

  private useStock(): boolean {
    const v = this.d.settings().media.image || 'auto'
    // auto falls back to Pexels/Pixabay photos when no painter is keyed (Openverse alone is too hit-and-miss for plates)
    return v === 'stock' || (v === 'auto' && !this.painter() && Boolean(this.d.key('pexels') || this.d.key('pixabay')))
  }

  /** can directed scenes get plates at all? (also counts a library full of reusable images) */
  imageAvailable(): boolean {
    if ((this.d.settings().media.image || 'auto') === 'none') return false
    return this.painter() !== null || this.useStock()
  }

  /** what one fresh image would cost with the current painter (for "saved" lines) */
  private imageCostEstimate(): { provider: string; model: string; usd: number; usage: UsageNumbers } {
    const p = this.painter()
    if (!p) return { provider: 'stock', model: 'stock', usd: 0, usage: {} }
    const model = p.model ?? (p.provider.id === 'openai' || p.provider.id === 'gemini' ? IMAGE_DEFAULT[p.provider.id] : 'unknown')
    const usage = p.provider.id === 'openai' ? { inputTokens: 200, outputTokens: 6240, images: 1 } : { images: 1 }
    return { provider: p.provider.id, model, usd: priceUsage(model, usage).usd, usage }
  }

  /** library match for a plate: exact prompt first, then a close brief, then the user's own tagged uploads */
  findPlate(req: Omit<PaintRequest, 'projectId'>): AssetMeta | null {
    const lib = this.d.library
    const key = plateKey(req.fullPrompt, req.width, req.height)
    const exact = lib.findByKey('image', key)
    if (exact) return exact
    const orientation = orientationOf(req.width, req.height)
    const query = `${req.subjectLabel ?? ''} ${req.brief}`
    const close = lib.search(query, { kind: 'image', orientation, sources: ['generated', 'stock', 'builtin'], limit: 1 })[0]
    if (close && close.score >= 0.75) return close.asset
    // uploads: every word of the subject is one of the user's tags/title words
    const subject = tokenize(req.subjectLabel ?? '')
    if (subject.length) {
      for (const hit of lib.search(req.subjectLabel ?? '', { kind: 'image', sources: ['uploaded'], limit: 5 })) {
        const words = new Set([...tokenize(hit.asset.title), ...hit.asset.tags.flatMap(tokenize)])
        if (subject.every((w) => words.has(w))) return hit.asset
      }
    }
    return null
  }

  async paint(req: PaintRequest, opts: { fresh?: boolean } = {}): Promise<PaintResult> {
    const lib = this.d.library
    if (this.reuse && !opts.fresh) {
      const hit = this.findPlate(req)
      const path = hit ? lib.path(hit.id) : null
      if (hit && path) {
        lib.markUsed(hit.id, req.projectId)
        const est = this.imageCostEstimate()
        if (est.usd > 0)
          meter.record({ kind: 'image', provider: est.provider, model: est.model, usage: est.usage, saved: true, note: `reused ${hit.id}` })
        return { buffer: readFileSync(path), assetId: hit.id, source: hit.source, reused: true }
      }
    }
    const tags = [...tokenize(req.subjectLabel ?? ''), ...(req.look ? [req.look] : []), 'plate']
    if (this.useStock() && !(opts.fresh && this.painter())) {
      const query = req.subjectLabel?.trim() || tokenize(req.brief).slice(0, 4).join(' ')
      const { results } = await searchStock('image', query, { orientation: orientationOf(req.width, req.height), pexelsKey: this.d.key('pexels'), pixabayKey: this.d.key('pixabay') })
      if (!results.length) throw new Error(`no free stock photo found for "${query}"`)
      const asset = await downloadStock(lib, results[0], tags)
      lib.markUsed(asset.id, req.projectId)
      const path = lib.path(asset.id)
      if (!path) throw new Error('stock download vanished')
      return { buffer: readFileSync(path), assetId: asset.id, source: 'stock', reused: false }
    }
    const p = this.painter()
    if (!p?.provider.generateImage) throw new Error('no image model configured')
    const before = meter.current()?.entries.length ?? 0
    const buffer = await p.provider.generateImage({ prompt: req.fullPrompt, width: req.width, height: req.height, model: p.model })
    const spent = meter.current()?.entries.slice(before).find((e) => e.kind === 'image')
    const asset = lib.add(buffer, sniffImageExt(buffer), {
      kind: 'image',
      source: 'generated',
      title: (req.subjectLabel || req.brief).slice(0, 80),
      tags,
      prompt: req.brief,
      provider: p.provider.id,
      model: spent?.model ?? p.model ?? IMAGE_DEFAULT[p.provider.id],
      costUsd: spent?.usd,
      key: plateKey(req.fullPrompt, req.width, req.height),
      ...(await imageSize(buffer)),
      license: { name: 'Generated with your API key', requiresAttribution: false }
    })
    lib.markUsed(asset.id, req.projectId)
    return { buffer, assetId: asset.id, source: 'generated', reused: false }
  }

  // ---------------- voice ----------------

  speech(): SpeechProvider | null {
    const [p, model] = split(this.d.settings().media.voice || 'auto')
    if (p === 'none') return null
    const pick = p === 'auto' ? (this.d.key('openai') ? 'openai' : this.d.key('elevenlabs') ? 'elevenlabs' : this.d.key('gemini') ? 'gemini' : null) : p
    if (!pick || !this.d.key(pick as KeyId)) return null
    if (pick === 'elevenlabs') {
      const m = model ?? 'eleven_flash_v2_5'
      return {
        id: 'elevenlabs',
        label: 'ElevenLabs',
        model: m,
        voices: Object.keys(ELEVEN_VOICES),
        defaultVoice: (look) => (look === 'documentary' ? 'George' : 'Sarah'),
        tts: (req) => this.eleven.tts({ ...req, model: m })
      }
    }
    if (pick === 'openai' || pick === 'gemini') {
      const llm = this.d.provider(pick)
      if (!llm.tts) return null
      const m = model ?? (pick === 'openai' ? 'gpt-4o-mini-tts' : 'gemini-2.5-flash-preview-tts')
      return {
        id: pick,
        label: llm.label,
        model: m,
        voices: pick === 'openai' ? VOICES : GEMINI_VOICES,
        defaultVoice: (look) => (pick === 'openai' ? (look === 'documentary' ? 'onyx' : 'nova') : look === 'documentary' ? 'Charon' : 'Puck'),
        tts: (req) => llm.tts!({ ...req, model: m })
      }
    }
    return null
  }

  /** voice takes are shared across projects by their (voice, tone, text) hash */
  voiceCache(projectId: string, speech: SpeechProvider): VoiceCache {
    const lib = this.d.library
    return {
      lookup: (key) => {
        if (!this.reuse) return null
        const hit = lib.findByKey('voice', key)
        const path = hit ? lib.path(hit.id) : null
        if (!hit || !path) return null
        lib.markUsed(hit.id, projectId)
        const chars = String(hit.extra?.text ?? '').length
        meter.record({ kind: 'voice', provider: speech.id, model: speech.model, usage: { chars, seconds: hit.durationSec ?? chars / 15 }, saved: true, note: `reused ${hit.id}` })
        let words
        try {
          words = hit.extra?.words ? JSON.parse(String(hit.extra.words)) : undefined
        } catch {
          words = undefined
        }
        return { audio: readFileSync(path), ext: extname(path), words }
      },
      store: (key, audio, ext, info) => {
        const a = lib.add(audio, ext, {
          kind: 'voice',
          source: 'generated',
          title: info.text.slice(0, 80),
          tags: [info.voice.toLowerCase(), info.provider, ...tokenize(info.text).slice(0, 8)],
          prompt: info.text,
          provider: info.provider,
          model: info.model,
          key,
          durationSec: info.words?.at(-1)?.endSec,
          extra: { voice: info.voice, text: info.text, words: JSON.stringify(info.words ?? []) },
          license: { name: 'Generated with your API key', requiresAttribution: false }
        })
        lib.markUsed(a.id, projectId)
      }
    }
  }

  // ---------------- music ----------------

  /**
   * A music file for this video, or null for the built-in beat-synced score.
   * 'library' picks the best mood match; ElevenLabs composes (and files) a
   * new track unless a fitting one was already made.
   */
  async music(spec: VideoSpec, totalSec: number, projectId: string): Promise<string | null> {
    if (spec.musicMood === 'none') return null
    const [p] = split(this.d.settings().media.music || 'builtin:procedural')
    const lib = this.d.library
    const mood = spec.musicMood
    const pickFrom = (sources: AssetMeta['source'][], minDur = 0) => {
      const hit = lib.search('', { kind: 'music', tags: [mood], sources, minDurationSec: minDur, limit: 1 })[0]
      return hit ? hit.asset : null
    }
    if (p === 'library') {
      const a = pickFrom(['uploaded', 'generated', 'stock', 'builtin'])
      if (!a) return null
      lib.markUsed(a.id, projectId)
      return lib.path(a.id)
    }
    if (p === 'elevenlabs' && this.eleven.configured()) {
      if (this.reuse) {
        const a = pickFrom(['generated'], totalSec * 0.9)
        if (a) {
          lib.markUsed(a.id, projectId)
          meter.record({ kind: 'music', provider: 'elevenlabs', model: 'music_v1', usage: { seconds: totalSec }, saved: true, note: `reused ${a.id}` })
          return lib.path(a.id)
        }
      }
      const { bpm } = beatGrid(spec)
      const prompt = `${mood} instrumental background score for a ${spec.design?.look ?? spec.style} video about "${spec.title}". No vocals. Steady ${Math.round(bpm)} BPM, gentle intro, clean ending.`
      const a = await this.composeToLibrary(prompt, totalSec + 1, [mood, spec.design?.look ?? spec.style], `${mood} score — ${spec.title}`)
      lib.markUsed(a.id, projectId)
      return lib.path(a.id)
    }
    return null
  }

  /** compose a track with ElevenLabs Music and file it */
  async composeToLibrary(prompt: string, seconds: number, tags: string[] = [], title?: string): Promise<AssetMeta> {
    if (!this.eleven.configured()) throw new Error('Add an ElevenLabs key in Settings to compose music')
    const buf = await this.eleven.music(prompt, seconds)
    const mood = ['upbeat', 'cinematic', 'minimal', 'playful', 'dark', 'corporate'].find((m) => prompt.toLowerCase().includes(m))
    return this.d.library.add(buf, '.mp3', {
      kind: 'music',
      source: 'generated',
      title: (title ?? prompt).slice(0, 80),
      tags: [...tags, ...(mood ? [mood] : []), 'score', ...tokenize(prompt).slice(0, 6)],
      prompt,
      provider: 'elevenlabs',
      model: 'music_v1',
      durationSec: seconds,
      costUsd: priceUsage('music_v1', { seconds }).usd,
      license: { name: 'Generated with your API key', requiresAttribution: false }
    })
  }

  /** speak a line with the chosen narrator and file it */
  async speakToLibrary(text: string): Promise<AssetMeta> {
    const speech = this.speech()
    if (!speech) throw new Error('Add an OpenAI, Gemini or ElevenLabs key to make voices')
    const voice = speech.defaultVoice()
    const res = await speech.tts({ text, voice })
    return this.d.library.add(res.audio, res.mimeType === 'audio/wav' ? '.wav' : '.mp3', {
      kind: 'voice',
      source: 'generated',
      title: text.slice(0, 80),
      tags: [voice.toLowerCase(), speech.id, ...tokenize(text).slice(0, 8)],
      prompt: text,
      provider: speech.id,
      model: speech.model,
      durationSec: res.words?.at(-1)?.endSec,
      extra: { voice, text, words: JSON.stringify(res.words ?? []) },
      license: { name: 'Generated with your API key', requiresAttribution: false }
    })
  }
}

export function plateKey(fullPrompt: string, w: number, h: number): string {
  return createHash('sha1').update(`${orientationOf(w, h)}|${fullPrompt}`).digest('hex').slice(0, 16)
}

function sniffImageExt(b: Buffer): string {
  if (b[0] === 0x89 && b[1] === 0x50) return '.png'
  if (b[0] === 0xff && b[1] === 0xd8) return '.jpg'
  if (b.subarray(8, 12).toString() === 'WEBP') return '.webp'
  return '.png'
}

async function imageSize(b: Buffer): Promise<{ width?: number; height?: number }> {
  try {
    const sharp = (await import('sharp')).default
    const m = await sharp(b).metadata()
    return { width: m.width, height: m.height }
  } catch {
    return {}
  }
}
