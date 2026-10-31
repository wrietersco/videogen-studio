import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { FilmDesign, VideoSpec } from '@shared/spec'
import { tokenize, type AssetMeta } from '@shared/assets'
import { priceUsage, type UsageNumbers } from '@shared/pricing'
import { orientationOf, type AssetLibrary } from '../assets/library'
import { joinClips, lastFrame, probe, videoPoster } from '../assets/probe'
import type { LLMProvider, ProviderId, SpeechProvider, VoiceCache } from '../providers/types'
import { ElevenLabsClient, ELEVEN_VOICES } from '../providers/elevenlabs'
import { GeminiVideoClient, GEMINI_VIDEO_MODEL } from '../providers/geminiVideo'
import { VOICES } from '../audio/voice'
import { beatGrid } from '../audio/score'
import { musicBrief } from '../audio/cue'
import { meter } from '../usage/meter'
import type { KeyId, Settings } from '../settings'
import { platePrompt } from '../director/plates'
import { downloadStock, searchStock, stockQuery } from './stock'

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
  /** Explicit test-only budget, shared by all clips in this router instance. */
  testVideoLimits?: { maxClips: number; maxDurationSec: 3 | 4 }
  onDecision?: (projectId: string, message: string) => void
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

/** Capture real clip dimensions and duration so subsequent library searches can reuse it. */
function videoMetadata(buffer: Buffer): { durationSec?: number; width?: number; height?: number } {
  const dir = mkdtempSync(join(tmpdir(), 'vg-clip-meta-'))
  try {
    const file = join(dir, 'clip.mp4')
    writeFileSync(file, buffer)
    return probe(file)
  } catch {
    return {}
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export class MediaRouter {
  private readonly eleven: ElevenLabsClient
  private readonly omni: GeminiVideoClient
  private generatedClips = 0

  constructor(private readonly d: MediaDeps) {
    this.eleven = new ElevenLabsClient(() => d.key('elevenlabs'))
    this.omni = new GeminiVideoClient(() => d.key('gemini'))
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
    const settings = this.d.settings()
    const [p, model] = split(settings.media.image || 'auto')
    // A stock-first autonomous run may use the image model explicitly selected
    // for the active provider if reviewed stock cannot satisfy the brief.
    if (p === 'stock' && settings.autopilot) {
      const active = settings.provider
      const selectedModel = settings.models[`${active}-image`]
      if ((active === 'openai' || active === 'gemini') && selectedModel && this.d.key(active)) {
        const provider = this.d.provider(active)
        if (provider.generateImage) return { provider, model: selectedModel }
      }
    }
    if (p === 'auto') {
      const auto = this.d.autoImageProvider()
      return auto ? { provider: auto } : null
    }
    if ((p === 'openai' || p === 'gemini') && this.d.key(p)) return { provider: this.d.provider(p), model }
    return null
  }

  private useStock(): boolean {
    const v = this.d.settings().media.image || 'auto'
    if (this.d.settings().autopilot && v !== 'none') return true
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

  /** library match for a plate: exact prompt first, then a close brief, then a subject-matched stock photo, then the user's own tagged uploads */
  findPlate(req: Omit<PaintRequest, 'projectId'>): AssetMeta | null {
    const lib = this.d.library
    const key = plateKey(req.fullPrompt, req.width, req.height)
    const exact = lib.findByKey('image', key)
    if (exact) return exact
    const orientation = orientationOf(req.width, req.height)
    const subject = tokenize(req.subjectLabel ?? '')
    const query = `${req.subjectLabel ?? ''} ${req.brief}`
    const close = lib.search(query, { kind: 'image', orientation, sources: ['generated', 'stock', 'builtin'], limit: 1 })[0]
    if (close && close.score >= 0.75) return close.asset
    // stock photos can't honor the brief's art direction, so match them on the
    // subject alone: every subject word in the photo's title/tags (prefetched
    // downloads carry the subject as tags for exactly this lookup)
    if (subject.length) {
      for (const hit of lib.search(req.subjectLabel ?? '', { kind: 'image', orientation, sources: ['stock'], tags: ['plate'], limit: 5 })) {
        const words = new Set([...tokenize(hit.asset.title), ...hit.asset.tags.flatMap(tokenize)])
        if (subject.every((w) => words.has(w))) return hit.asset
      }
    }
    // uploads: every word of the subject is one of the user's tags/title words
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
      // a stocked photo only stands in for a plate when stock is what's asked for —
      // never let yesterday's free download shadow the painter the user chose
      if (hit && path && (hit.source !== 'stock' || this.useStock())) {
        if (this.d.settings().autopilot && hit.source === 'stock') {
          const score = await this.scoreImage(readFileSync(path), req.fullPrompt)
          if (score === null || score < 7) {
            // Continue to new candidates instead of reusing an unverified match.
          } else {
            lib.markUsed(hit.id, req.projectId)
            return { buffer: readFileSync(path), assetId: hit.id, source: hit.source, reused: true }
          }
        } else {
        lib.markUsed(hit.id, req.projectId)
        const est = this.imageCostEstimate()
        if (est.usd > 0)
          meter.record({ kind: 'image', provider: est.provider, model: est.model, usage: est.usage, saved: true, note: `reused ${hit.id}` })
        return { buffer: readFileSync(path), assetId: hit.id, source: hit.source, reused: true }
        }
      }
    }
    const tags = [...tokenize(req.subjectLabel ?? ''), ...(req.look ? [req.look] : []), 'plate']
    if (this.d.settings().autopilot && !opts.fresh && this.useStock()) {
      const query = stockQuery(req.subjectLabel, req.brief)
      const { results } = await searchStock('image', query, { orientation: orientationOf(req.width, req.height), pexelsKey: this.d.key('pexels'), pixabayKey: this.d.key('pixabay') })
      for (const result of results.slice(0, 3)) {
        try {
          const asset = await downloadStock(lib, result, tags)
          const path = lib.path(asset.id)
          if (!path) continue
          const buffer = readFileSync(path)
          const score = await this.scoreImage(buffer, req.fullPrompt)
          this.d.onDecision?.(req.projectId, `image stock candidate: ${score === null ? 'review unavailable' : `${score}/10`}`)
          if (score !== null && score >= 7) {
            lib.markUsed(asset.id, req.projectId)
            return { buffer, assetId: asset.id, source: 'stock', reused: false }
          }
        } catch { /* try the next candidate */ }
      }
      if (!this.painter()) throw new Error(`No suitable evaluated stock image for "${query}" and no image model is configured`)
    } else if (this.useStock() && !(opts.fresh && this.painter())) {
      const query = stockQuery(req.subjectLabel, req.brief)
      const { results } = await searchStock('image', query, { orientation: orientationOf(req.width, req.height), pexelsKey: this.d.key('pexels'), pixabayKey: this.d.key('pixabay') })
      if (!results.length) throw new Error(`no free stock photo found for "${query}"`)
      // stamped with the plate's reuse key: the same brief next time is a library hit, not a re-download
      const asset = await downloadStock(lib, results[0], tags, { key: plateKey(req.fullPrompt, req.width, req.height) })
      lib.markUsed(asset.id, req.projectId)
      const path = lib.path(asset.id)
      if (!path) throw new Error('stock download vanished')
      return { buffer: readFileSync(path), assetId: asset.id, source: 'stock', reused: false }
    }
    const p = this.painter()
    if (!p?.provider.generateImage) throw new Error('no image model configured')
    const before = meter.current()?.entries.length ?? 0
    let buffer = await p.provider.generateImage({ prompt: req.fullPrompt, width: req.width, height: req.height, model: p.model })
    if (this.d.settings().autopilot) {
      const firstScore = await this.scoreImage(buffer, req.fullPrompt)
      if (firstScore !== null) {
        try {
          const second = await p.provider.generateImage({ prompt: req.fullPrompt, width: req.width, height: req.height, model: p.model })
          const secondScore = await this.scoreImage(second, req.fullPrompt)
          this.d.onDecision?.(req.projectId, `generated images: first ${firstScore}/10, second ${secondScore === null ? 'unavailable' : `${secondScore}/10`}; ${secondScore !== null && secondScore > firstScore ? 'second' : 'first'} selected`)
          if (secondScore !== null && secondScore > firstScore) buffer = second
        } catch { /* retain the first working candidate */ }
      }
    }
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

  private async scoreImage(buffer: Buffer, brief: string): Promise<number | null> {
    const vision = this.d.provider(this.d.settings().provider)
    if (vision.id === 'mock') return null
    try {
      const sharp = (await import('sharp')).default
      const preview = await sharp(buffer).resize({ width: 720, height: 720, fit: 'inside' }).jpeg().toBuffer()
      const r = await vision.generateJSON<{ score: number }>({
        system: 'Judge how well the image satisfies the scene brief, including subject, action, composition and mood. Score 0 to 10. A generic or wrong subject must score below 7.',
        prompt: brief, schemaName: 'MediaSuitability',
        jsonSchema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false },
        images: [{ mimeType: 'image/jpeg', base64: preview.toString('base64') }], temperature: 0.2, maxTokens: 100
      })
      return Number.isFinite(r.score) ? Math.max(0, Math.min(10, r.score)) : null
    } catch { return null }
  }

  private async scoreVideo(buffer: Buffer, brief: string): Promise<number | null> {
    const dir = mkdtempSync(join(tmpdir(), 'vg-video-review-'))
    try {
      const file = join(dir, 'clip.mp4')
      writeFileSync(file, buffer)
      const duration = probe(file).durationSec
      if (!duration || duration <= 0) return null
      const vision = this.d.provider(this.d.settings().provider)
      if (vision.id === 'mock') return null
      const frames = [0.2, 0.5, 0.8].map((fraction) => videoPoster(file, duration * fraction)).filter((frame): frame is Buffer => Boolean(frame))
      if (frames.length < 2) return null
      const result = await vision.generateJSON<{ score: number }>({
        system: 'Judge these ordered frames from one video against the scene brief. Score 0 to 10 for subject, continuity, visual quality and suitability. A wrong subject scores below 7. Do not infer motion you cannot see.',
        prompt: brief, schemaName: 'VideoSuitability', jsonSchema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'], additionalProperties: false },
        images: frames.map((frame) => ({ mimeType: 'image/jpeg', base64: frame.toString('base64') })), temperature: 0.2, maxTokens: 100
      })
      return Number.isFinite(result.score) ? Math.max(0, Math.min(10, result.score)) : null
    } catch { return null } finally { rmSync(dir, { recursive: true, force: true }) }
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
    const [p, model] = split(this.d.settings().media.music || 'builtin:procedural')
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
    if (p === 'gemini' && this.d.key('gemini')) {
      // Lyria scores *this* edit: the brief carries the cut times, so the
      // track is cached by brief (same edit → same track) rather than by mood
      let acc = 0
      const cuts = spec.scenes.map((s) => ((acc += s.durationSec), acc - s.durationSec))
      const brief = musicBrief(spec, cuts, totalSec)
      if (!brief) return null
      const cue = `cue-${createHash('sha1').update(brief).digest('hex').slice(0, 12)}`
      const hit = lib.search('', { kind: 'music', tags: [cue], sources: ['generated'], limit: 1 })[0]
      if (hit) {
        lib.markUsed(hit.asset.id, projectId)
        meter.record({ kind: 'music', provider: 'gemini', model: model ?? 'lyria-3.5', usage: { items: 1 }, saved: true, note: `reused ${hit.asset.id}` })
        return lib.path(hit.asset.id)
      }
      const gemini = this.d.provider('gemini') as LLMProvider & { music?: (p: string, m?: string) => Promise<{ audio: Buffer }> }
      if (!gemini.music) return null
      const lyria = model ?? 'lyria-3.5'
      const { audio } = await gemini.music(brief, lyria)
      const a = this.d.library.add(audio, '.mp3', {
        kind: 'music',
        source: 'generated',
        title: `${mood} score — ${spec.title}`.slice(0, 80),
        tags: [cue, mood, spec.design?.look ?? spec.style, 'score', 'lyria'],
        prompt: brief,
        provider: 'gemini',
        model: lyria,
        durationSec: totalSec,
        costUsd: priceUsage(lyria, { items: 1 }).usd,
        license: { name: 'Generated with your API key (SynthID watermarked)', requiresAttribution: false }
      })
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

  // ---------------- video clips ----------------

  /** can directed scenes get moving clips? (Gemini Omni with a key, or stock clips with a Pexels/Pixabay key) */
  clipsAvailable(): boolean {
    const [p] = split(this.d.settings().media.video || 'stock')
    if (p === 'gemini') return this.omni.configured()
    if (p === 'stock') return Boolean(this.d.key('pexels') || this.d.key('pixabay') || (this.reuse && this.d.library.all().some((asset) => asset.kind === 'video')))
    return false
  }

  /**
   * A moving clip for a motion plate, library first: an identical earlier
   * clip → a close library clip → Gemini Omni animating the painted still
   * (keeps the film's art direction) → a free stock clip. Null = keep the still.
   */
  async motionClip(req: {
    prompt: string
    subjectLabel?: string
    camera?: string
    imageStyle?: string
    still?: Buffer
    width: number
    height: number
    durationSec: number
    projectId: string
    /** Search the existing library only; never download or generate. */
    libraryOnly?: boolean
  }): Promise<{ buffer: Buffer; assetId: string; source: AssetMeta['source'] } | null> {
    const lib = this.d.library
    const orientation = orientationOf(req.width, req.height)
    const aspect = orientation === 'landscape' ? '16:9' : '9:16'
    const [p] = split(this.d.settings().media.video || 'stock')
    const model = this.clipModel()
    const prompt = [
      req.prompt.trim().replace(/\.*$/, '.'),
      `Slow cinematic ${req.camera === 'pull' ? 'pull-back' : req.camera === 'drift' ? 'drift' : 'push-in'}; natural, continuous motion of the subject and its surroundings.`,
      req.imageStyle ? `Look: ${req.imageStyle.trim().replace(/\.*$/, '.')}` : '',
      'No text, no captions, no dialogue, no music, no cuts.'
    ]
      .filter(Boolean)
      .join(' ')
    const key = createHash('sha1').update(`${model}|${aspect}|${prompt}`).digest('hex').slice(0, 16)
    const use = (a: AssetMeta) => {
      const path = lib.path(a.id)
      if (!path) return null
      lib.markUsed(a.id, req.projectId)
      return { buffer: readFileSync(path), assetId: a.id, source: a.source }
    }
    if (this.reuse) {
      const exact = lib.findByKey('video', key)
      const exactPath = exact ? lib.path(exact.id) : null
      if (exact && exactPath && (!this.d.settings().autopilot || exact.source !== 'stock' || (await this.scoreVideo(readFileSync(exactPath), prompt) ?? 0) >= 7)) {
        if (exact.source === 'generated') meter.record({ kind: 'video', provider: 'gemini', model, usage: { outputTokens: (exact.durationSec ?? 8) * 5792 }, saved: true, note: `reused ${exact.id}` })
        return use(exact)
      }
      // prefetched stock clips carry the subject as tags — matching on the full
      // motion prompt would dilute the score below the reuse bar
      const ready = lib
        .search(req.subjectLabel ?? '', { kind: 'video', orientation, sources: ['stock'], tags: ['motion'], minDurationSec: req.durationSec * 0.6, limit: 5 })
        .find((h) => h.score >= 0.75)
      const readyPath = ready ? lib.path(ready.asset.id) : null
      if (ready && readyPath && (!this.d.settings().autopilot || (await this.scoreVideo(readFileSync(readyPath), prompt) ?? 0) >= 7)) return use(ready.asset)
      // Search by the scene subject and visually check promising matches. Older
      // clips may lack metadata, so probe them before judging suitability.
      const legacy = lib.search(req.subjectLabel?.trim() || req.prompt, { kind: 'video', limit: 8 })
      for (const hit of legacy) {
        if (hit.score < (this.d.settings().autopilot ? 0.5 : 0.75)) continue
        const path = lib.path(hit.asset.id)
        if (!path) continue
        const metadata = hit.asset.durationSec && hit.asset.width && hit.asset.height ? hit.asset : probe(path)
        const foundOrientation = orientationOf(metadata.width, metadata.height)
        if (!metadata.durationSec || metadata.durationSec < req.durationSec * 0.6 || (orientation && foundOrientation && orientation !== foundOrientation)) continue
        const buffer = readFileSync(path)
        if (this.d.settings().autopilot && (await this.scoreVideo(buffer, prompt) ?? 0) < 7) continue
        if (hit.asset.source === 'generated' && hit.asset.provider === 'gemini') meter.record({ kind: 'video', provider: 'gemini', model: hit.asset.model || model, usage: { outputTokens: metadata.durationSec * 5792 }, saved: true, note: `reused ${hit.asset.id}` })
        return use(hit.asset)
      }
      const close = lib.search(`${req.subjectLabel ?? ''} ${req.prompt}`, { kind: 'video', orientation, minDurationSec: req.durationSec * 0.6, limit: 5 })[0]
      const closePath = close ? lib.path(close.asset.id) : null
      if (close && closePath && close.score >= 0.75 && (!this.d.settings().autopilot || (close.asset.source !== 'stock' && !close.asset.tags.includes('candidate-alternate')) || (await this.scoreVideo(readFileSync(closePath), prompt) ?? 0) >= 7)) return use(close.asset)
    }
    if (req.libraryOnly) return null
    if (this.d.settings().autopilot && (p === 'stock' || p === 'gemini') && (this.d.key('pexels') || this.d.key('pixabay'))) {
      const query = stockQuery(req.subjectLabel, req.prompt)
      const minSec = req.durationSec * 0.8
      const { results } = await searchStock('video', query, { orientation, minDurationSec: minSec, pexelsKey: this.d.key('pexels'), pixabayKey: this.d.key('pixabay') })
      for (const candidate of results.filter((r) => (r.durationSec ?? 0) >= minSec).slice(0, 3)) {
        try {
          const asset = await downloadStock(lib, candidate, [...tokenize(query), 'motion'])
          const file = lib.path(asset.id)
          const score = file ? await this.scoreVideo(readFileSync(file), prompt) : null
          this.d.onDecision?.(req.projectId, `video stock candidate: ${score === null ? 'review unavailable' : `${score}/10`}`)
          if (file && (score ?? 0) >= 7) return use(asset)
        } catch { /* try the next candidate */ }
      }
      if (p === 'stock') return null
    }
    if (p === 'gemini' && this.omni.configured()) {
      const still = req.still ? { mimeType: 'image/jpeg', base64: req.still.toString('base64') } : undefined
      const generate = async () => {
        const limit = this.d.testVideoLimits
        if (limit && (!Number.isInteger(limit.maxClips) || limit.maxClips < 0 || this.generatedClips >= Math.min(limit.maxClips, 3))) throw new Error('AI video test clip limit reached')
        this.generatedClips++
        return this.omni.clip({ prompt, aspect, model, image: still, ...(limit ? { durationSec: limit.maxDurationSec } : {}) })
      }
      let chosen = await generate()
      let alternate: typeof chosen | undefined
      if (this.d.settings().autopilot) {
        const firstScore = await this.scoreVideo(chosen.video, prompt)
        if (firstScore !== null) {
          try {
            const second = await generate()
            const secondScore = await this.scoreVideo(second.video, prompt)
            this.d.onDecision?.(req.projectId, `generated videos: first ${firstScore}/10, second ${secondScore === null ? 'unavailable' : `${secondScore}/10`}; ${secondScore !== null && secondScore > firstScore ? 'second' : 'first'} selected`)
            if (secondScore !== null && secondScore > firstScore) { alternate = chosen; chosen = second } else alternate = second
          } catch { /* retain the first working candidate */ }
        }
      }
      const { video, usd } = chosen
      if (alternate) lib.add(alternate.video, '.mp4', {
        kind: 'video', source: 'generated', title: `${(req.subjectLabel || req.prompt).slice(0, 65)} — alternate`,
        tags: [...tokenize(req.subjectLabel ?? ''), 'clip', 'motion', 'candidate-alternate'], prompt,
        provider: 'gemini', model, costUsd: alternate.usd,
        ...videoMetadata(alternate.video),
        license: { name: 'Generated with your API key (SynthID watermarked)', requiresAttribution: false }
      })
      const a = lib.add(video, '.mp4', {
        kind: 'video',
        source: 'generated',
        title: (req.subjectLabel || req.prompt).slice(0, 80),
        tags: [...tokenize(req.subjectLabel ?? ''), ...tokenize(req.prompt).slice(0, 8), 'clip', 'omni', 'motion'],
        prompt,
        provider: 'gemini',
        model,
        key,
        costUsd: usd,
        ...videoMetadata(video),
        license: { name: 'Generated with your API key (SynthID watermarked)', requiresAttribution: false }
      })
      return use(a)
    }
    if (p === 'stock' && (this.d.key('pexels') || this.d.key('pixabay'))) {
      const query = stockQuery(req.subjectLabel, req.prompt)
      const minSec = req.durationSec * 0.8
      const { results } = await searchStock('video', query, { orientation, minDurationSec: minSec, pexelsKey: this.d.key('pexels'), pixabayKey: this.d.key('pixabay') })
      const pick = results.find((r) => (r.durationSec ?? 0) >= minSec)
      if (!pick) return null
      // stamped with the motion-prompt key: the same scene next time is an exact library hit
      return use(await downloadStock(lib, pick, [...tokenize(query), 'motion'], { key }))
    }
    return null
  }

  /** the clip model Settings → Media points at (Gemini Omni Flash is the only generator today) */
  private clipModel(): string {
    const [p, model] = split(this.d.settings().media.video || 'stock')
    return p === 'gemini' && model ? model : GEMINI_VIDEO_MODEL
  }

  // ---------------- stock prefetch (on-the-go downloads) ----------------

  /**
   * While the directors are still talking to the model, fetch the best free
   * stock match for every scene that still needs a still (plus a matching
   * clip for motion scenes when clips come from stock) straight into the
   * library: ranked first pick, tagged with the subject, stamped with the
   * plate's reuse key — so the plate workers find them instantly instead of
   * each searching and downloading on its own. Best-effort: a failure or a
   * slow network just means the worker falls back to a live search.
   */
  async prefetchForSpec(req: {
    spec: VideoSpec
    design: FilmDesign
    width: number
    height: number
    projectId: string
    onNote?: (msg: string) => void
  }): Promise<{ images: number; clips: number }> {
    const lib = this.d.library
    // Autonomous candidates must be inspected before reuse; unreviewed prefetches bypass that gate.
    if (this.d.settings().autopilot) return { images: 0, clips: 0 }
    if (!this.reuse) return { images: 0, clips: 0 } // 'fresh' ignores the library — prefetch would be wasted bytes
    const wantImages = this.useStock()
    const wantClips =
      split(this.d.settings().media.video || 'stock')[0] === 'stock' && Boolean(this.d.key('pexels') || this.d.key('pixabay'))
    if (!wantImages && !wantClips) return { images: 0, clips: 0 }
    const stockOpts = { orientation: orientationOf(req.width, req.height), pexelsKey: this.d.key('pexels'), pixabayKey: this.d.key('pixabay') }
    const craftOf = new Map(req.spec.crafts.map((c) => [c.sceneId, c]))
    const imagesPending = new Set<string>()
    const clipsPending = new Set<string>()
    const jobs: Array<() => Promise<'image' | 'video' | null>> = []
    for (const scene of req.spec.scenes) {
      const c = craftOf.get(scene.id)
      const plate = c?.plate
      if (!c || c.background !== 'plate' || !plate || plate.file) continue
      if (wantImages && imagesPending.size < 6) {
        const fullPrompt = platePrompt(plate, req.design, req.width, req.height)
        const key = plateKey(fullPrompt, req.width, req.height)
        // the library can already serve this scene (previous video, earlier run) — nothing to fetch
        const have =
          lib.findByKey('image', key) ??
          this.findPlate({ brief: plate.prompt, fullPrompt, subjectLabel: plate.subjectLabel, look: req.design.look, width: req.width, height: req.height })
        if (!have) {
          imagesPending.add(key)
          jobs.push(async () => {
            if (lib.findByKey('image', key)) return null // a sibling job just filed it
            const { results } = await searchStock('image', stockQuery(plate.subjectLabel, plate.prompt), stockOpts)
            if (!results[0]) return null
            await downloadStock(lib, results[0], [...tokenize(plate.subjectLabel), 'plate'], { key })
            return 'image'
          })
        }
      }
      if (wantClips && plate.motion && clipsPending.size < 3) {
        clipsPending.add(plate.subjectLabel || plate.prompt)
        jobs.push(async () => {
          const minSec = scene.durationSec * 0.8
          const { results } = await searchStock('video', stockQuery(plate.subjectLabel, plate.prompt), { ...stockOpts, minDurationSec: minSec })
          const pick = results.find((r) => (r.durationSec ?? 0) >= minSec)
          if (!pick) return null
          await downloadStock(lib, pick, [...tokenize(plate.subjectLabel), 'motion'])
          return 'video'
        })
      }
    }
    const deadline = Date.now() + 20_000
    let cursor = 0
    let images = 0
    let clips = 0
    const worker = async () => {
      while (cursor < jobs.length && Date.now() < deadline) {
        try {
          const kind = await jobs[cursor++]()
          if (kind === 'image') images += 1
          if (kind === 'video') clips += 1
        } catch {
          /* prefetch is best-effort — the plate worker will search live instead */
        }
      }
    }
    await Promise.all([worker(), worker()])
    if ((images || clips) && req.onNote) req.onNote(`stock prefetch: ${images} photo(s)${clips ? ` + ${clips} clip(s)` : ''} ready in the library`)
    return { images, clips }
  }


  /** generate a clip with Gemini (reusing an identical earlier one) and file it */
  async clipToLibrary(
    prompt: string,
    orientation: 'portrait' | 'landscape' | 'square' = 'landscape',
    opts: { fresh?: boolean; projectId?: string; /** JPEG of the frame this shot starts from */ image?: Buffer; /** 3-10 whole seconds; absent = the model's default length */ durationSec?: number } = {}
  ): Promise<AssetMeta> {
    if (!this.omni.configured()) throw new Error('Add a Gemini key in Settings to make video clips')
    const lib = this.d.library
    const aspect = orientation === 'portrait' ? '9:16' : '16:9'
    const model = this.clipModel()
    const from = opts.image ? createHash('sha1').update(opts.image).digest('hex').slice(0, 8) : ''
    const key = createHash('sha1').update(`${model}|${aspect}|${prompt}|${from}${opts.durationSec ? `|${opts.durationSec}s` : ''}`).digest('hex').slice(0, 16)
    const hit = this.reuse && !opts.fresh ? lib.findByKey('video', key) : null
    if (hit) {
      if (opts.projectId) lib.markUsed(hit.id, opts.projectId)
      meter.record({ kind: 'video', provider: 'gemini', model, usage: { outputTokens: (hit.durationSec ?? 8) * 5792 }, saved: true, note: `reused ${hit.id}` })
      return hit
    }
    const { video, usd } = await this.omni.clip({ prompt, aspect, model, ...(opts.durationSec ? { durationSec: opts.durationSec } : {}), image: opts.image && { mimeType: 'image/jpeg', base64: opts.image.toString('base64') } })
    const a = lib.add(video, '.mp4', {
      kind: 'video',
      source: 'generated',
      title: prompt.slice(0, 80),
      tags: [...tokenize(prompt).slice(0, 10), 'clip', 'omni'],
      prompt,
      provider: 'gemini',
      model,
      key,
      costUsd: usd,
      license: { name: 'Generated with your API key (SynthID watermarked)', requiresAttribution: false }
    })
    if (opts.projectId) lib.markUsed(a.id, opts.projectId)
    return a
  }

  /**
   * a multi-shot sequence: each shot starts from the last frame of the one before
   * (so the camera flows through), then all shots are joined into one clip.
   * Every shot is also filed on its own.
   */
  async sequenceToLibrary(shots: string[], orientation: 'portrait' | 'landscape' | 'square' = 'landscape', onShot?: (n: number, total: number) => void): Promise<AssetMeta> {
    const lib = this.d.library
    const dir = mkdtempSync(join(tmpdir(), 'videogen-seq-'))
    try {
      const files: string[] = []
      let frame: Buffer | undefined
      let cost = 0
      for (let i = 0; i < shots.length; i++) {
        onShot?.(i + 1, shots.length)
        const clip = await this.clipToLibrary(shots[i], orientation, { fresh: true, image: frame })
        cost += clip.costUsd ?? 0
        const file = lib.path(clip.id)
        if (!file) throw new Error(`shot ${i + 1} went missing from the library`)
        files.push(file)
        frame = lastFrame(file) ?? undefined
      }
      const out = join(dir, 'sequence.mp4')
      joinClips(files, out)
      const info = probe(out)
      const title = `Sequence · ${shots[0].slice(0, 60)}`
      return lib.add(readFileSync(out), '.mp4', {
        kind: 'video',
        source: 'generated',
        title,
        tags: [...tokenize(shots.join(' ')).slice(0, 10), 'clip', 'omni', 'sequence'],
        prompt: shots.map((s, i) => `Shot ${i + 1}: ${s}`).join('\n'),
        provider: 'gemini',
        model: this.clipModel(),
        durationSec: info.durationSec,
        costUsd: cost,
        license: { name: 'Generated with your API key (SynthID watermarked)', requiresAttribution: false }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
