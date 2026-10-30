import { join } from 'node:path'
import { VideoSpec } from '@shared/spec'
import type { PlatformId, StyleFamily } from '@shared/spec'
import type { LLMProvider, SpeechProvider } from '../providers/types'
import type { MediaRouter } from '../media/router'
import { Planner } from './planner'
import { CompositionFixer } from './fixer'
import { buildAudio } from './audio'
import { narrate, VOICES } from '../audio/voice'
import { compose, COMPOSER_VERSION, type AudioLayer } from '../composer'
import { captureSceneThumbs } from '../livePreview'
import { ProjectStore, type StageName, type StageState } from '../store/projectStore'
import { RenderService, type CheckReport, type RenderProgress } from '../rendererService/hyperframes'
import { vendorDir, fontsDir, musicDir } from '../paths'
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { PLATFORM_PRESETS } from '@shared/presets'
import { SceneDirector, pickClipScenes, preserveFinishedPlates } from '../director/director'
import { makePlate, relocatePlate } from '../director/plates'
import { reviewScenes } from '../director/critic'
import { authorCustomScene, chooseCustomScenes } from '../director/customScene'
import { authorCanvasCode, needsCanvasCode, renderCanvasCode } from '../director/canvasCode'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'


/** Explicit whole-film isometric briefs use a code-only visual pipeline. */
export function isIsometricOnlyBrief(prompt: string): boolean {
  return /\bisometric\b/i.test(prompt) && !/\b(?:no|avoid|without|not)\s+(?:any\s+)?isometric\b/i.test(prompt) && !/\b(?:some|one|single|one of|a few)\s+(?:scenes?|shots?)\s+(?:in|with|as)\s+(?:an?\s+)?isometric\b/i.test(prompt) && !/\b(?:mix|combine|intercut|alternate|blend)\b.{0,80}\b(?:footage|photos?|photographs?|live.action)\b/i.test(prompt)
}

/** Recompose an interrupted project without refitting already-recorded narration. */
export function canReuseNarrationTiming(spec: VideoSpec, projectDir: string): boolean {
  if (!spec.narration.some(n => n.text.trim())) return true
  return spec.narration.filter(n => n.text.trim()).every(n => spec.voiceover.some(t => t.sceneId === n.sceneId && /^assets\/audio\/[A-Za-z0-9._-]+$/.test(t.file) && existsSync(join(projectDir, t.file))))
}

function readComposition(dir: string): string {
  const p = join(dir, 'index.html')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function writeComposition(dir: string, html: string): void {
  writeFileSync(join(dir, 'index.html'), html)
}

/** A failed capture can be an almost-black frame even when the CLI succeeds. */
export async function isBlankReviewFrame(image: Buffer): Promise<boolean> {
  const stats = await sharp(image).resize(128, 128, { fit: 'fill' }).removeAlpha().stats()
  const channels = stats.channels.slice(0, 3)
  return channels.every(c => c.mean < 28 && c.stdev < 5)
}

/** salvage the audio layer (clips + caption cues) embedded in an old composition */
export function extractAudioLayer(html: string): AudioLayer {
  if (!html) return { clips: [], captions: [] }
  const clips: AudioLayer['clips'] = []
  for (const m of html.matchAll(
    /<audio class="clip" src="([^"]+)" data-start="([\d.]+)" data-duration="([\d.]+)" data-track-index="(\d+)" data-volume="([\d.]+)"><\/audio>/g
  )) {
    clips.push({ file: m[1], startSec: parseFloat(m[2]), durationSec: parseFloat(m[3]), trackIndex: parseInt(m[4], 10), volume: parseFloat(m[5]) })
  }
  let captions: AudioLayer['captions'] = []
  const capMatch = html.match(/const CAPTIONS = (\[.*?\]);/s)
  if (capMatch) {
    try {
      const parsed = JSON.parse(capMatch[1]) as AudioLayer['captions']
      if (Array.isArray(parsed)) captions = parsed
    } catch {
      /* captions lost — silent captions, not a failure */
    }
  }
  return { clips, captions }
}

/**
 * Orchestrator — the pipeline: plan → compose → QA fix-loop → render.
 * Emits stage events (surfaced in the UI activity feed and CLI logs).
 * The QA loop is the "resilient agent": check → classify → fix → re-check,
 * bounded retries, deterministic fixes first.
 */

export interface GenerateOptions {
  prompt: string
  platform: VideoSpec['platform']
  styleHint?: VideoSpec['style']
  durationHintSec?: number
  quality?: 'draft' | 'standard' | 'delivery'
  /** opt-in fast mode: GPU rasterization is faster but not pixel-deterministic */
  gpu?: boolean
  /** 'directed' (default): scene director + plates + widgets · 'classic': template scenes */
  craft?: 'directed' | 'classic'
  /** autopilot's pick of look for the film director (documentary only takes effect with an image engine) */
  lookHint?: 'documentary' | 'infographic'
  /** autopilot's reasons, written to the project's activity log */
  autopilotNotes?: string[]
  onEvent?: (e: PipelineEvent) => void
}

type CraftMode = 'directed' | 'classic'

export type PipelineEvent =
  | { stage: 'plan'; status: 'started' }
  | { stage: 'plan'; status: 'creative'; platform: PlatformId; styleHint: StyleFamily; durationHintSec: number; look: 'documentary' | 'infographic'; reason: string }
  | {
      stage: 'plan'
      status: 'done'
      title: string
      scenes: number
      durationSec: number
      sceneCards: Array<{ kind: string; label: string; durationSec: number }>
    }
  | { stage: 'direct'; status: 'started'; total: number }
  | { stage: 'direct'; status: 'film'; look: string; series: string }
  | { stage: 'direct'; status: 'scene'; sceneIndex: number; headline: string; widgets: string[]; background: string }
  | { stage: 'direct'; status: 'done' }
  | { stage: 'plates'; status: 'started'; total: number }
  | { stage: 'plates'; status: 'scene'; sceneIndex: number; dataUrl: string }
  | { stage: 'plates'; status: 'failed'; sceneIndex: number; error: string }
  | { stage: 'plates'; status: 'done'; made: number }
  | { stage: 'critic'; status: 'started' }
  | { stage: 'critic'; status: 'scene'; sceneIndex: number; score: number; notes: string[] }
  | { stage: 'critic'; status: 'done'; revised: number }
  | { stage: 'compose'; status: 'started' }
  | { stage: 'compose'; status: 'done' }
  | { stage: 'qa'; status: 'started' }
  | { stage: 'qa'; status: 'fixing'; attempt: number; issues: string[] }
  | { stage: 'qa'; status: 'done'; clean: boolean; warnings: number }
  | { stage: 'qa'; status: 'failed'; issues: string[] }
  | { stage: 'custom'; status: 'started'; total: number }
  | { stage: 'custom'; status: 'attempt'; sceneIndex: number; attempt: number; phase: 'authoring' | 'reviewing' }
  | { stage: 'custom'; status: 'scene'; sceneIndex: number; accepted: boolean; detail: string }
  | { stage: 'custom'; status: 'done' }
  | { stage: 'thumbs'; status: 'started'; total: number }
  | { stage: 'thumbs'; status: 'progress'; index: number; sceneId: string; dataUrl: string }
  | { stage: 'thumbs'; status: 'done'; captured: number }
  | { stage: 'revise'; status: 'started'; sceneId: string; sceneIndex: number; feedback: string }
  | { stage: 'revise'; status: 'scene-updated'; sceneId: string; sceneIndex: number; label: string }
  | { stage: 'revise'; status: 'failed'; sceneId: string; error: string }
  | { stage: 'revise'; status: 'done'; sceneId: string; sceneIndex: number }
  | { stage: 'render'; status: 'started' }
  | { stage: 'render'; status: 'progress'; pct: number }
  | { stage: 'render'; status: 'done'; output: string; wallSec: number }
  | { stage: 'render'; status: 'failed'; error: string }
  | { stage: 'pipeline'; status: 'failed'; error: string }
  | { stage: 'pipeline'; status: 'cancelled' }
  | { stage: 'done'; projectId: string; output: string }

export interface GenerateResult {
  projectId: string
  spec: VideoSpec
  output: string
  qa: CheckReport
}

/** Thrown when the user stops a generation — the UI shows it as info, not error. */
export class GenerationCancelled extends Error {
  constructor() {
    super('Generation cancelled by user')
    this.name = 'GenerationCancelled'
  }
}

const MAX_QA_ATTEMPTS = 3

/** one-line summary of a scene for the live storyboard card */
function sceneLabel(s: VideoSpec['scenes'][number]): string {
  if ('headline' in s && s.headline) return s.headline
  if (s.kind === 'stat') return `${s.value} ${s.label}`
  if (s.kind === 'quote') return s.text
  return s.kind
}

/** parse the composition's declared canvas size (data-width/data-height on #root) */
function compositionSize(projectDir: string): { width: number; height: number } {
  const html = readComposition(projectDir)
  const w = /data-width="(\d+)"/.exec(html)
  const h = /data-height="(\d+)"/.exec(html)
  return { width: w ? parseInt(w[1], 10) : 1080, height: h ? parseInt(h[1], 10) : 1920 }
}

export class Orchestrator {
  private readonly renders = new RenderService()
  private cancelled = false
  private lookHint: GenerateOptions['lookHint']
  private activeJobId: string | null = null
  /** on-the-go stock downloads fired at the end of direction (see MediaRouter.prefetchForSpec) */
  private prefetch: Promise<{ images: number; clips: number } | null> | null = null
  /** paid plates/clips this run revised away before the final cut (money-guard report) */
  private readonly wastedPaid = { plates: 0, clips: 0 }

  constructor(
    private readonly store: ProjectStore,
    /** resolved per-run so settings changes take effect without restart */
    private readonly providerFor: () => LLMProvider,
    /** image model for painted plates (null → directed scenes use dot-grid backgrounds) */
    private readonly imageProviderFor: () => LLMProvider | null = () => null,
    /** library-first media routing (desktop app); absent → direct provider calls (CLI, tests) */
    private readonly media: MediaRouter | null = null
  ) {}

  /** narrator: the media router's choice, else any provider that speaks (legacy OpenAI voices) */
  private speech(): SpeechProvider | null {
    if (this.media) return this.media.speech()
    const p = [this.providerFor(), this.imageProviderFor()].find((x) => x?.tts) ?? null
    if (!p?.tts) return null
    return {
      id: p.id,
      label: p.label,
      model: 'gpt-4o-mini-tts',
      voices: VOICES,
      defaultVoice: (look) => (look === 'documentary' ? 'onyx' : 'nova'),
      tts: (req) => p.tts!(req)
    }
  }

  /** Persist stage progress to state.json — the resume contract. */
  private track(projectId: string, stage: StageName, status: StageState['status'], detail?: string): void {
    const patch: Partial<StageState> = { status, detail }
    if (status === 'running') patch.startedAt = new Date().toISOString()
    if (status === 'done' || status === 'failed') patch.finishedAt = new Date().toISOString()
    this.store.setStage(projectId, stage, patch)
    if (detail) this.store.appendEvent(projectId, `${stage}: ${detail}`)
  }

  /** The project currently generating, if any (used to guard deletes). */
  get activeProjectId(): string | null {
    return this.activeJobId
  }

  /** Cooperative cancel: hard-kills the active render; stage checks stop the rest. */
  cancel(): void {
    this.cancelled = true
    if (this.activeJobId) this.renders.cancel(this.activeJobId)
  }

  /**
   * Live storyboard: seek the composed film to each scene midpoint in a hidden
   * window and stream the real frames to the UI. A luxury — never fails the
   * pipeline, and cancellation checks keep it snappy when the user stops.
   */
  private async captureThumbs(projectId: string, spec: VideoSpec, emit: (e: PipelineEvent) => void): Promise<void> {
    try {
      this.track(projectId, 'thumbs', 'running')
      emit({ stage: 'thumbs', status: 'started', total: spec.scenes.length })
      const dir = this.store.dir(projectId)
      let acc = 0
      const windows = spec.scenes.map((s) => {
        const w = { id: s.id, t: Math.round((acc + s.durationSec / 2) * 100) / 100 }
        acc += s.durationSec
        return w
      })
      const { width, height } = compositionSize(dir)
      let captured = 0
      captured = await captureSceneThumbs(dir, windows, {
        width,
        height,
        isCancelled: () => this.cancelled,
        onThumb: (r) => emit({ stage: 'thumbs', status: 'progress', index: r.index, sceneId: r.sceneId, dataUrl: r.dataUrl })
      })
      this.track(projectId, 'thumbs', 'done', `${captured}/${spec.scenes.length} frames`)
      emit({ stage: 'thumbs', status: 'done', captured })
    } catch (err) {
      this.store.appendEvent(projectId, `thumbs skipped: ${String((err as Error)?.message ?? err).slice(0, 90)}`)
      emit({ stage: 'thumbs', status: 'done', captured: 0 })
    }
  }

  /** Re-render an existing project from its stored composition (uses current quality/GPU settings). */
  async rerender(
    projectId: string,
    opts: { quality?: 'draft' | 'standard' | 'delivery'; gpu?: boolean; onEvent?: (e: PipelineEvent) => void }
  ): Promise<string> {
    const spec = this.store.readSpec(projectId)
    if (!spec) throw new Error(`project ${projectId} has no spec`)
    this.cancelled = false
    this.activeJobId = projectId
    const dir = this.store.dir(projectId)
    // self-heal: rebuild the composition when it's missing OR predates the
    // current composer — re-renders always get the latest presentation,
    // keeping the audio layer (clips + captions) already embedded in the page
    const composition = join(dir, 'index.html')
    const existing = existsSync(composition) ? readFileSync(composition, 'utf8') : ''
    if (!existing || !existing.includes(`vg-compose:v${COMPOSER_VERSION}`)) {
      const audio = extractAudioLayer(existing)
      this.store.saveComposition(projectId, compose(spec, vendorDir, fontsDir, audio))
      this.store.appendEvent(projectId, existing ? `composition upgraded to v${COMPOSER_VERSION}` : 'composition rebuilt')
    }
    this.store.appendEvent(projectId, 'manual re-render')
    // refresh the live storyboard captures with the upgraded composition
    if (!this.cancelled) await this.captureThumbs(projectId, spec, (e) => opts.onEvent?.(e))
    this.track(projectId, 'render', 'running')
    opts.onEvent?.({ stage: 'render', status: 'started' })
    const output = join(dir, 'renders', `${slugish(spec.title)}-${spec.platform}-r${Date.now().toString(36)}.mp4`)
    const result = await this.renders.render(
      dir,
      output,
      {
        fps: spec.fps,
        quality: opts.quality ?? 'standard',
        gpu: opts.gpu,
        onProgress: (p) => opts.onEvent?.({ stage: 'render', status: 'progress', pct: p.pct })
      },
      projectId
    )
    if (this.cancelled) {
      this.store.setStatus(projectId, 'cancelled')
      opts.onEvent?.({ stage: 'pipeline', status: 'cancelled' })
      throw new GenerationCancelled()
    }
    if (!result.ok || !result.output) {
      this.store.setStatus(projectId, 'error', result.error)
      opts.onEvent?.({ stage: 'render', status: 'failed', error: result.error ?? 'unknown' })
      throw new Error(`Render failed: ${result.error}`)
    }
    this.store.addRender(projectId, result.output, spec.platform)
    this.store.setStatus(projectId, 'done')
    this.track(projectId, 'render', 'done', `${(result.durationSec ?? 0).toFixed(1)}s wall`)
    opts.onEvent?.({ stage: 'render', status: 'done', output: result.output, wallSec: result.durationSec ?? 0 })
    return result.output
  }

  /**
   * Per-scene feedback loop: ONE focused LLM call rewrites the scene, then the
   * standard deterministic stages take over — recompose (narration + captions
   * rebuilt), QA, fresh storyboard captures, full re-render.
   */
  async reviseScene(
    projectId: string,
    sceneId: string,
    feedback: string,
    opts: { quality?: 'draft' | 'standard' | 'delivery'; gpu?: boolean; craft?: CraftMode; onEvent?: (e: PipelineEvent) => void } = {}
  ): Promise<void> {
    const emit = (e: PipelineEvent) => opts.onEvent?.(e)
    const spec0 = this.store.readSpec(projectId)
    if (!spec0) throw new Error(`project ${projectId} has no spec`)
    const sceneIndex = spec0.scenes.findIndex((s) => s.id === sceneId)
    if (sceneIndex < 0) throw new Error(`scene ${sceneId} not found`)
    this.cancelled = false
    this.activeJobId = projectId

    // the revision itself needs a real provider — the mock planner only plans whole films
    if (this.providerFor().id === 'mock') {
      throw new Error('Scene revision needs a configured AI provider (the mock planner can only plan whole films)')
    }

    emit({ stage: 'revise', status: 'started', sceneId, sceneIndex, feedback })
    this.store.setStatus(projectId, 'planning')
    this.track(projectId, 'plan', 'running')
    let spec: VideoSpec
    try {
      spec = await new Planner(this.providerFor()).reviseScene({ spec: spec0, sceneId, feedback })
    } catch (err) {
      const msg = String((err as Error)?.message ?? err)
      this.store.setStatus(projectId, 'error', msg)
      this.track(projectId, 'plan', 'failed', msg)
      emit({ stage: 'revise', status: 'failed', sceneId, error: msg })
      throw err
    }
    this.store.saveSpec(projectId, spec)
    this.track(projectId, 'plan', 'done', `scene ${sceneIndex + 1} revised: ${sceneLabel(spec.scenes[sceneIndex])}`)
    emit({
      stage: 'revise',
      status: 'scene-updated',
      sceneId,
      sceneIndex,
      label: sceneLabel(spec.scenes[sceneIndex])
    })
    // keeps any open Studio storyboard text in sync with the revised scene
    emit({
      stage: 'plan',
      status: 'done',
      title: spec.title,
      scenes: spec.scenes.length,
      durationSec: spec.durationSec,
      sceneCards: spec.scenes.map((s) => ({ kind: s.kind, label: sceneLabel(s), durationSec: s.durationSec }))
    })

    // ---------- re-direct the revised scene (the feedback steers the director too) ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const originalPrompt = this.store.readMeta(projectId)?.prompt ?? spec.title
    const isometricOnly = isIsometricOnlyBrief(originalPrompt)
    if (!isometricOnly && spec.design && opts.craft !== 'classic') {
      const meta0 = this.store.readMeta(projectId)
      spec = await this.runDirect(projectId, spec, meta0?.prompt ?? spec.title, emit, {
        ids: new Set([sceneId]),
        notes: new Map([[sceneId, `The user asked: "${feedback}"`]])
      })
    }

    // ---------- recompose (narration + captions for the revised text) ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const audio = await this.runCompose(projectId, spec, emit)
    let qa = isometricOnly ? { ok: true, errors: [], warnings: [] } : await this.runQaLoop(projectId, spec, audio, emit)
    const wasCustom = spec.customScenes?.some(c => c.sceneId === sceneId) || spec.customVideos?.some(c => c.sceneId === sceneId)
    if ((isometricOnly || wasCustom) && !this.cancelled) {
      spec = await this.runCustomScenes(projectId, spec, `${originalPrompt}\nUser revision: ${feedback}`, audio, emit, new Map([[sceneId, feedback]]), isometricOnly)
      if (isometricOnly && !this.cancelled) {
        qa = await this.runQaLoop(projectId, spec, audio, emit)
        if (!qa.ok) throw new Error(`Isometric film failed final render checks: ${qa.errors.map(e => e.message).join('; ') || 'no diagnostics returned'}`)
      }
    }

    // ---------- fresh storyboard captures ----------
    if (this.cancelled) return this.abort(projectId, emit)
    await this.captureThumbs(projectId, spec, emit)

    // ---------- re-render the film ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const meta = this.store.readMeta(projectId)
    await this.runRender(
      projectId,
      spec,
      (meta?.platform as VideoSpec['platform']) ?? spec.platform,
      { quality: opts.quality, gpu: opts.gpu, suffix: `rev${Date.now().toString(36)}` },
      emit,
      qa
    )
    emit({ stage: 'revise', status: 'done', sceneId, sceneIndex })
  }

  /**
   * Apply the editor's changes: the edited spec replaces the saved one (the old
   * one is kept in history/ for undo), pictures whose prompt changed are
   * repainted, then narration → audio → composition → render run as usual.
   */
  async applyEdit(
    projectId: string,
    edited: unknown,
    opts: { quality?: 'draft' | 'standard' | 'delivery'; gpu?: boolean; onEvent?: (e: PipelineEvent) => void } = {}
  ): Promise<void> {
    const emit = (e: PipelineEvent) => opts.onEvent?.(e)
    const before = this.store.readSpec(projectId)
    if (!before) throw new Error(`project ${projectId} has no spec`)
    let spec = VideoSpec.parse(edited)
    const ids = new Set(spec.scenes.map((s) => s.id))
    spec.narration = spec.narration.filter((n) => ids.has(n.sceneId))
    spec.crafts = spec.crafts.filter((c) => ids.has(c.sceneId))
    spec.voiceover = spec.voiceover.filter((t) => ids.has(t.sceneId))
    const unchanged = (id: string) => JSON.stringify(before.scenes.find(s => s.id === id)) === JSON.stringify(spec.scenes.find(s => s.id === id)) && JSON.stringify(before.narration.find(n => n.sceneId === id)) === JSON.stringify(spec.narration.find(n => n.sceneId === id))
    spec.customScenes = spec.customScenes?.filter(c => ids.has(c.sceneId) && unchanged(c.sceneId))
    spec.customVideos = spec.customVideos?.filter(c => ids.has(c.sceneId) && unchanged(c.sceneId))
    this.cancelled = false
    this.activeJobId = projectId
    this.store.pushHistory(projectId, before)
    this.store.saveSpec(projectId, spec)
    this.store.appendEvent(projectId, `edited by hand: ${spec.scenes.length} scenes`)
    emit({ stage: 'revise', status: 'started', sceneId: '', sceneIndex: 0, feedback: 'manual edit' })

    const originalPrompt = this.store.readMeta(projectId)?.prompt ?? spec.title
    const isometricOnly = isIsometricOnlyBrief(originalPrompt)
    if (isometricOnly) { spec.crafts = []; spec.customScenes = [] }
    // repaint pictures the user changed (their file was cleared by the editor)
    if (!isometricOnly && spec.design && spec.crafts.some((c) => c.background === 'plate' && c.plate && !c.plate.file)) {
      spec = await this.runPlates(projectId, spec, emit, this.providerFor())
      this.store.saveSpec(projectId, spec)
    }
    if (this.cancelled) return this.abort(projectId, emit)
    const audio = await this.runCompose(projectId, spec, emit)
    if (isometricOnly && !this.cancelled) spec = await this.runCustomScenes(projectId, spec, originalPrompt, audio, emit, undefined, true)
    const qa = await this.runQaLoop(projectId, spec, audio, emit)
    if (isometricOnly && !qa.ok) throw new Error(`Isometric film failed final render checks: ${qa.errors.map(e => e.message).join('; ') || 'no diagnostics returned'}`)
    if (this.cancelled) return this.abort(projectId, emit)
    await this.captureThumbs(projectId, spec, emit)
    if (this.cancelled) return this.abort(projectId, emit)
    const meta = this.store.readMeta(projectId)
    await this.runRender(
      projectId,
      spec,
      (meta?.platform as VideoSpec['platform']) ?? spec.platform,
      { quality: opts.quality, gpu: opts.gpu, suffix: `edit${Date.now().toString(36)}` },
      emit,
      qa
    )
    emit({ stage: 'revise', status: 'done', sceneId: '', sceneIndex: 0 })
  }

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const emit = (e: PipelineEvent) => opts.onEvent?.(e)
    this.cancelled = false
    this.wastedPaid.plates = 0
    this.wastedPaid.clips = 0
    const planner = new Planner(this.providerFor())

    // ---------- plan ----------
    emit({ stage: 'plan', status: 'started' })
    const provisional = this.store.create(opts.prompt, opts.prompt.slice(0, 48))
    const projectId = provisional.id
    this.activeJobId = projectId
    this.store.setStatus(projectId, 'planning')
    const createdMeta = this.store.readMeta(projectId)
    if (createdMeta) {
      createdMeta.platform = opts.platform
      this.store.writeMeta(projectId, createdMeta)
    }
    this.store.writeState(projectId, (s) => {
      s.stages = {
        plan: { status: 'running', startedAt: new Date().toISOString() },
        direct: { status: 'pending' },
        plates: { status: 'pending' },
        compose: { status: 'pending' },
        qa: { status: 'pending' },
        critic: { status: 'pending' },
        thumbs: { status: 'pending' },
        render: { status: 'pending' }
      }
      s.events = [
        { at: new Date().toISOString(), text: `started: "${opts.prompt.slice(0, 60)}"` },
        ...(opts.autopilotNotes ?? []).map((text) => ({ at: new Date().toISOString(), text: `autopilot · ${text}` }))
      ]
    })
    this.lookHint = opts.lookHint
    let spec: VideoSpec
    try {
      spec = await planner.plan({
        userPrompt: opts.prompt,
        platform: opts.platform,
        styleHint: opts.styleHint,
        durationHintSec: opts.durationHintSec
      })
    } catch (err) {
      this.store.setStatus(projectId, 'error', String(err))
      throw err
    }
    // rename project folder title now that we have a real title
    const meta = this.store.readMeta(projectId)
    if (meta) {
      meta.title = spec.title
      this.store.writeMeta(projectId, meta)
    }
    this.store.saveSpec(projectId, spec)
    this.track(projectId, 'plan', 'done', `${spec.scenes.length} scenes · ${spec.durationSec}s`)
    emit({
      stage: 'plan',
      status: 'done',
      title: spec.title,
      scenes: spec.scenes.length,
      durationSec: spec.durationSec,
      sceneCards: spec.scenes.map((s) => ({ kind: s.kind, label: sceneLabel(s), durationSec: s.durationSec }))
    })

    const isometricOnly = isIsometricOnlyBrief(opts.prompt)
    if (isometricOnly) this.store.appendEvent(projectId, 'Isometric motion graphics: code-only visuals; image and video generation disabled')

    // ---------- direct: film design, per-scene crafts, painted plates ----------
    if (this.cancelled) return this.abort(projectId, emit)
    if (!isometricOnly && opts.craft !== 'classic') spec = await this.runDirect(projectId, spec, opts.prompt, emit)

    // ---------- compose ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const range = PLATFORM_PRESETS[spec.platform].durationRange
    const target = opts.durationHintSec && Number.isFinite(opts.durationHintSec) ? Math.min(range[1], Math.max(range[0], opts.durationHintSec)) : undefined
    const audio = await this.runCompose(projectId, spec, emit, target)

    // ---------- QA fix-loop ----------
    if (this.cancelled) return this.abort(projectId, emit)
    let qa: CheckReport = isometricOnly ? { ok: true, errors: [], warnings: [] } : await this.runQaLoop(projectId, spec, audio, emit)

    // Bespoke vector scenes are trialled against the existing composition;
    // failures leave the original scene and its paid media intact.
    if (!this.cancelled && (isometricOnly || opts.craft !== 'classic')) {
      try {
        spec = await this.runCustomScenes(projectId, spec, opts.prompt, audio, emit, undefined, isometricOnly)
        if (isometricOnly && !this.cancelled) {
          qa = await this.runQaLoop(projectId, spec, audio, emit)
          if (!qa.ok) throw new Error(`Isometric film failed final render checks: ${qa.errors.map(e => e.message).join('; ') || 'no diagnostics returned'}`)
        }
      } catch (err) {
        if (isometricOnly) this.store.setStatus(projectId, 'error', String(err))
        throw err
      }
    }

    // ---------- vision critic: watch the real frames, send weak scenes back ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const critiqued = isometricOnly ? null : await this.runCritic(projectId, spec, opts.prompt, audio, emit)
    if (critiqued) {
      spec = critiqued.spec
      qa = critiqued.qa ?? qa
    }

    // ---------- live storyboard captures ----------
    if (this.cancelled) return this.abort(projectId, emit)
    await this.captureThumbs(projectId, spec, emit)

    // ---------- render ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const result = await this.runRender(projectId, spec, opts.platform, opts, emit, qa)
    // money guard: say it plainly when paid work didn't make the final cut
    if (this.wastedPaid.plates || this.wastedPaid.clips) {
      const parts = [this.wastedPaid.plates ? `${this.wastedPaid.plates} plate(s)` : '', this.wastedPaid.clips ? `${this.wastedPaid.clips} clip(s)` : ''].filter(Boolean).join(' + ')
      this.store.appendEvent(projectId, `money guard: ${parts} generated earlier were revised out of the final cut — they're in your library and future videos reuse them for free`)
    }
    return result
  }

  // ---------------- shared stage implementations (used by generate + resume) ----------------

  private async runCustomScenes(
    projectId: string,
    spec: VideoSpec,
    prompt: string,
    audio: Awaited<ReturnType<Orchestrator['runCompose']>>,
    emit: (e: PipelineEvent) => void = () => {},
    targeted?: Map<string, string>,
    isometricOnly = false
  ): Promise<VideoSpec> {
    const provider = this.providerFor()
    if (provider.id === 'mock') {
      if (isometricOnly) throw new Error('Isometric animation requires a configured writing model')
      return spec
    }
    const ids = isometricOnly && targeted ? [...targeted.keys()] : isometricOnly ? spec.scenes.filter(s => !spec.customVideos?.some(c => c.sceneId === s.id && /^assets\/custom\/[A-Za-z0-9._-]+\.mp4$/.test(c.file) && existsSync(join(this.store.dir(projectId), c.file)))).map(s => s.id) : targeted ? [...targeted.keys()] : await chooseCustomScenes(provider, spec, prompt)
    if (!ids.length) return spec
    emit({ stage: 'custom', status: 'started', total: ids.length })
    const dir = this.store.dir(projectId)
    let current = spec
    let continuityFrame: Buffer | undefined
    let continuityIndex = -1
    for (const sceneId of ids) {
      if (this.cancelled) break
      const index = current.scenes.findIndex(s => s.id === sceneId)
      if (index < 0) continue
      const scene = current.scenes[index]
      const originalHtml = readComposition(dir)
      const start = current.scenes.slice(0, index).reduce((sum, s) => sum + s.durationSec, 0)
      if (index > 0 && continuityIndex !== index - 1) {
        continuityFrame = undefined
        try {
          const prior = current.scenes[index - 1]
          const priorTime = start - Math.min(0.55, prior.durationSec * 0.5)
          const priorDir = join(dir, '.custom-continuity')
          rmSync(priorDir, { recursive: true, force: true })
          const priorFrames = await this.renders.snapshot(dir, [priorTime], priorDir)
          if (priorFrames[0] && existsSync(priorFrames[0])) {
            const raw = readFileSync(priorFrames[0])
            if (!(await isBlankReviewFrame(raw))) continuityFrame = await sharp(raw).resize({ width: 720 }).jpeg({ quality: 80 }).toBuffer()
          }
        } catch { /* proceed without a visual reference if capture fails */ }
      } else if (index === 0) continuityFrame = undefined
      // Do not sample inside the outgoing transition: that can show the next
      // scene and falsely attribute its content to this candidate.
      const lastFraction = Math.max(0.4, 1 - 0.55 / scene.durationSec)
      const times = [0.18, 0.4, lastFraction].map(fraction => start + scene.durationSec * fraction)
      const beforeDir = join(dir, '.custom-before')
      let beforeImages: Buffer[]
      try {
        let usable: Buffer[] | undefined
        for (let capture = 0; capture < 3 && !this.cancelled; capture++) {
          rmSync(beforeDir, { recursive: true, force: true })
          const before = await this.renders.snapshot(dir, times, beforeDir)
          if (before.length !== 3 || before.some(f => !existsSync(f))) continue
          const raw = before.map(f => readFileSync(f))
          if ((await Promise.all(raw.map(isBlankReviewFrame))).some(Boolean)) continue
          usable = await Promise.all(raw.map(frame => sharp(frame).resize({ width: 720 }).jpeg({ quality: 80 }).toBuffer()))
          break
        }
        if (!usable) throw new Error('Original scene capture was blank or unavailable')
        beforeImages = usable
      } catch (err) {
        if (isometricOnly) throw new Error(`Could not review isometric scene ${index + 1}: ${String((err as Error)?.message ?? err)}`)
        this.store.appendEvent(projectId, `custom scene ${index + 1}: skipped comparison (${String((err as Error)?.message ?? err).slice(0, 120)})`)
        continue
      }
      let feedback: string | undefined = targeted?.get(sceneId)
      let previousSvg: string | undefined = current.customScenes?.find(c => c.sceneId === sceneId)?.svg
      let previousCode: string | undefined = current.customVideos?.find(c => c.sceneId === sceneId)?.source
      let previousFrame: Buffer | undefined = (previousCode || targeted?.has(sceneId)) ? beforeImages[1] : undefined
      const clipFile = current.crafts.find(c => c.sceneId === sceneId)?.plate?.clipFile
      const backgroundVideo = clipFile && /^assets\/plates\/[A-Za-z0-9._-]+\.mp4$/.test(clipFile) ? join(dir, clipFile) : undefined
      if (clipFile && (!backgroundVideo || !existsSync(backgroundVideo))) {
        this.store.appendEvent(projectId, `custom scene ${index + 1}: kept moving footage because the source could not be loaded safely`)
        continue
      }
      const useCode = isometricOnly || Boolean(backgroundVideo) || previousCode !== undefined || await needsCanvasCode(provider, current, sceneId, prompt)
      let accepted = false
      let best: { spec: VideoSpec; score: number; file?: string; reason: string; attempt: number; frame: Buffer } | undefined
      const maxAttempts = isometricOnly ? 5 : 3
      for (let attempt = 1; attempt <= maxAttempts && !this.cancelled; attempt++) {
        let trialFile: string | undefined
        emit({ stage: 'custom', status: 'attempt', sceneIndex: index, attempt, phase: 'authoring' })
        try {
          let candidate: VideoSpec
          if (useCode) {
            const plateFile = current.crafts.find(c => c.sceneId === sceneId)?.plate?.file
            let backgroundJpeg: Buffer | undefined
            if (plateFile && /^assets\/plates\/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp)$/i.test(plateFile)) {
              const platePath = join(dir, plateFile)
              if (existsSync(platePath)) backgroundJpeg = await sharp(readFileSync(platePath)).resize({ width: 1080, height: 1920, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer()
            }
            if (backgroundVideo) backgroundJpeg = beforeImages[1]
            const code = await authorCanvasCode(provider, current, isometricOnly ? `${prompt}\nAll scenes must be fully animated original 2D isometric motion graphics, with consistent perspective and visual identity. Draw all visuals using canvas shapes. Do not use photos, footage or generated imagery.` : prompt, sceneId, feedback, previousCode, backgroundJpeg, previousFrame, Boolean(backgroundVideo), continuityFrame, isometricOnly && index > 0 ? current.customVideos?.find(c => c.sceneId === current.scenes[index - 1].id)?.source : undefined)
            previousCode = code
            const file = `assets/custom/${randomUUID()}.mp4`
            trialFile = join(dir, file)
            const preset = PLATFORM_PRESETS[current.platform]
            await renderCanvasCode({ code, width: preset.width, height: preset.height, durationSec: scene.durationSec, output: trialFile, backgroundJpeg: backgroundVideo ? undefined : backgroundJpeg, backgroundVideo, cancelled: () => this.cancelled })
            candidate = { ...current, customScenes: (current.customScenes ?? []).filter(c => c.sceneId !== sceneId), customVideos: [...(current.customVideos ?? []).filter(c => c.sceneId !== sceneId), { sceneId, file, source: code }] }
          } else {
            const svg = await authorCustomScene(provider, current, prompt, sceneId, feedback, previousSvg, continuityFrame)
            previousSvg = svg
            candidate = { ...current, customVideos: (current.customVideos ?? []).filter(c => c.sceneId !== sceneId), customScenes: [...(current.customScenes ?? []).filter(c => c.sceneId !== sceneId), { sceneId, svg }] }
          }
          this.store.saveComposition(projectId, compose(candidate, vendorDir, fontsDir, audio))
          const check = await this.renders.check(dir)
          // Unfinished placeholder scenes are replaced later in this mode;
          // their text contrast must not prevent reviewing the current scene.
          const unfinished = new Set(current.scenes.map((s, i) => ({ s, i })).filter(({ s }) => s.id !== sceneId && !candidate.customVideos?.some(c => c.sceneId === s.id)).map(({ i }) => i + 1))
          const remainingErrors = isometricOnly ? check.errors.filter(e => {
            const match = e.category === 'contrast' && e.selector?.match(/^#scene-(\d+)-/)
            return !match || !unfinished.has(Number(match[1]))
          }) : check.errors
          if (!check.ok && (!isometricOnly || remainingErrors.length || !check.errors.length)) throw new Error(`Render check: ${(remainingErrors.map(e => e.message).join('; ') || check.raw || 'check failed without diagnostics').slice(0, 500)}`)
          const candidateDir = join(dir, `.custom-candidate-${attempt}`)
          rmSync(candidateDir, { recursive: true, force: true })
          const frames = await this.renders.snapshot(dir, times, candidateDir)
          if (frames.length !== 3 || frames.some(f => !existsSync(f))) throw new Error('Could not render all candidate frames')
          const afterImages = await Promise.all(frames.map(f => sharp(readFileSync(f)).resize({ width: 720 }).jpeg({ quality: 80 }).toBuffer()))
          previousFrame = afterImages[1]
          emit({ stage: 'custom', status: 'attempt', sceneIndex: index, attempt, phase: 'reviewing' })
          const verdict = await provider.generateJSON<{ useCandidate: boolean; score: number; originalScore: number; blockingIssue: boolean; reason: string }>({
            system: `${isometricOnly ? 'This is a code-only 2D isometric film: the candidate must clearly show animated isometric objects and processes, match the scene and maintain continuity. Ignore the generic original when evaluating the candidate; useCandidate should be true when the candidate is professional and meets the brief, even if the original looks better. ' : ''}You are the video editor. Images 1, 2 and 3 are the existing scene at early, middle and late times; images 4, 5 and 6 are the new custom illustration or coded animation at those same times. If image 7 is provided, it is the preceding approved scene and is the authoritative visual reference for any recurring emblem, character or product. The original scene in images 1-3 may be the inconsistent scene being repaired: do not treat its conflicting design as the established identity. Judge both original and candidate against image 7, and reject a candidate that changes that identity contrary to the brief. Preserve relevant moving footage and its subject; reject the candidate if footage or its motion is lost. The brief describes the whole film; assess the intended beat of this scene in the context of the surrounding scene plan rather than demanding that every scene contain every film-wide action. Compare them against the brief and narration. Rate both the original and candidate out of 10 using the same criteria; put the original rating in originalScore. Reserve 8 or above for professional, accurate and legible motion that communicates the scene. Set blockingIssue true for any inconsistent recurring identity when continuity is required, factual or scientific error, wrong subject, missing required content, clipped or overlapping labels, or illegible text, even when the candidate looks better than the original. ${isometricOnly ? 'Accept if it scores at least 8 and has no blocking issue, irrespective of the generic original.' : 'Accept only if it scores at least 8, has no blocking issue, and is clearly better than the original. Do not prefer a generic diagram over relevant photos or footage.'} Give concrete improvement notes.`,
            prompt: JSON.stringify({ brief: prompt, scene, filmScenes: current.scenes, narration: current.narration.find(n => n.sceneId === sceneId)?.text, hasContinuityReference: Boolean(continuityFrame) }),
            schemaName: 'CustomSceneReview', jsonSchema: { type: 'object', properties: { useCandidate: { type: 'boolean' }, score: { type: 'number' }, originalScore: { type: 'number' }, blockingIssue: { type: 'boolean' }, reason: { type: 'string' } }, required: ['useCandidate', 'score', 'originalScore', 'blockingIssue', 'reason'], additionalProperties: false },
            images: [...beforeImages, ...afterImages, ...(continuityFrame ? [continuityFrame] : [])].map(image => ({ mimeType: 'image/jpeg', base64: image.toString('base64') })), temperature: 0.1, maxTokens: 500
          })
          feedback = String(verdict.reason ?? 'Improve the visual and match the scene more closely').slice(0, 600)
          if (verdict.useCandidate === true && verdict.blockingIssue === false && Number(verdict.score) >= 8) {
            if (best?.file && best.file !== trialFile) { try { unlinkSync(best.file) } catch {} }
            best = undefined
            current = candidate
            this.store.saveSpec(projectId, current)
            this.store.appendEvent(projectId, `custom scene ${index + 1}: candidate ${attempt} accepted after render and visual comparison — ${feedback}`)
            continuityFrame = afterImages[2]
            accepted = true
            break
          }
          const score = Number(verdict.score), originalScore = Number(verdict.originalScore)
          if (verdict.blockingIssue === false && Number.isFinite(score) && Number.isFinite(originalScore) && score >= 1 && score <= 10 && originalScore >= 1 && originalScore <= 10 && score > originalScore && (!best || score > best.score)) {
            if (best?.file && best.file !== trialFile) { try { unlinkSync(best.file) } catch {} }
            best = { spec: candidate, score, file: trialFile, reason: feedback, attempt, frame: afterImages[2] }
          }
        } catch (err) {
          feedback = String((err as Error)?.message ?? err).slice(0, 600)
        }
        try { if (trialFile && trialFile !== best?.file && existsSync(trialFile)) unlinkSync(trialFile) } catch { /* a retained trial is harmless */ }
        this.store.appendEvent(projectId, `custom scene ${index + 1}: candidate ${attempt} rejected — ${feedback}`)
      }
      if (!accepted && best && !this.cancelled && !isometricOnly) {
        current = best.spec
        this.store.saveComposition(projectId, compose(current, vendorDir, fontsDir, audio))
        this.store.saveSpec(projectId, current)
        feedback = best.reason
        continuityFrame = best.frame
        this.store.appendEvent(projectId, `custom scene ${index + 1}: selected candidate ${best.attempt}, the best safe improvement after retries`)
        accepted = true
      }
      if (!accepted && isometricOnly && !this.cancelled) {
        if (best?.file) { try { unlinkSync(best.file) } catch {} }
        writeComposition(dir, originalHtml)
        throw new Error(`Could not produce a reviewed isometric animation for scene ${index + 1}: ${feedback ?? 'no usable candidate'}`)
      }
      if (!accepted) {
        if (best?.file) { try { unlinkSync(best.file) } catch {} }
        this.store.appendEvent(projectId, `custom scene ${index + 1}: retained existing scene after testing — ${feedback ?? 'no usable candidate'}`)
        writeComposition(dir, originalHtml)
        continuityFrame = beforeImages[2]
      }
      continuityIndex = index
      emit({ stage: 'custom', status: 'scene', sceneIndex: index, accepted, detail: feedback ?? '' })
    }
    emit({ stage: 'custom', status: 'done' })
    return current
  }

  /**
   * Scene director stage: film design system (once), then one craft per scene
   * in parallel, then painted plates for documentary scenes. `only` re-directs
   * a subset (scene revision / critic notes) and keeps every other craft.
   */
  private async runDirect(
    projectId: string,
    spec: VideoSpec,
    userPrompt: string,
    emit: (e: PipelineEvent) => void,
    only?: { ids: Set<string>; notes?: Map<string, string>; /** 'subject' keeps paid plates whose brief was only reworded (critic pass); 'exact' repaints on any change (user feedback) */ keep?: 'exact' | 'subject' }
  ): Promise<VideoSpec> {
    const provider = this.providerFor()
    const imageProvider = this.imageProviderFor()
    this.track(projectId, 'direct', 'running')
    emit({ stage: 'direct', status: 'started', total: only ? only.ids.size : spec.scenes.length })
    const director = new SceneDirector({
      provider,
      // a clip can stand in for a still, so moving clips alone make plate scenes possible
      platesAvailable: this.media ? this.media.imageAvailable() || this.media.clipsAvailable() : imageProvider !== null,
      clipsAvailable: this.media?.clipsAvailable() ?? false,
      lookHint: this.lookHint,
      userPrompt,
      onScene: (i, c) =>
        emit({ stage: 'direct', status: 'scene', sceneIndex: i, headline: c.headline, widgets: c.widgets.map((w) => w.type), background: c.background })
    })
    const design = spec.design ?? (await director.directFilm(spec))
    if (!spec.design) emit({ stage: 'direct', status: 'film', look: design.look, series: design.series })
    const previous = new Map(spec.crafts.map((c) => [c.sceneId, c]))
    let next: VideoSpec = { ...spec, design }
    next = { ...next, crafts: await director.directScenes(next, design, only?.notes, only?.ids) }
    // the engine's call: which motion requests become moving clips (budgeted per film)
    next.crafts = pickClipScenes(next.crafts, next.scenes.reduce((t, s) => t + s.durationSec, 0))
    // money guard: finished plates survive re-direction — an unchanged (or, on
    // the critic's pass, merely reworded) brief keeps its painted files, and a
    // finished clip stays whatever the new motion pick says. No second bill.
    const kept = preserveFinishedPlates(next.crafts, previous, only?.keep ?? 'exact')
    next.crafts = kept.crafts
    if (kept.keptReworded) this.store.appendEvent(projectId, `plates: kept ${kept.keptReworded} finished plate(s) through re-direction — no re-bill`)
    this.wastedPaid.plates += kept.droppedPlates
    this.wastedPaid.clips += kept.droppedClips
    this.store.saveSpec(projectId, next)
    const plates = next.crafts.filter((c) => c.background === 'plate').length
    const clips = next.crafts.filter((c) => c.plate?.motion).length
    this.track(projectId, 'direct', 'done', `${design.look} · ${next.crafts.length} scenes directed · ${plates} plate(s)${clips ? ` · ${clips} moving` : ''}`)
    emit({ stage: 'direct', status: 'done' })
    if (this.cancelled) return next
    // on-the-go stock: rank + download the best free matches into the library
    // while the plate stage spins up; it waits briefly, then searches live
    const canvas = PLATFORM_PRESETS[next.platform]
    this.prefetch = this.media
      ? this.media
          .prefetchForSpec({
            spec: next,
            design,
            width: canvas.width,
            height: canvas.height,
            projectId,
            onNote: (msg) => this.store.appendEvent(projectId, msg)
          })
          .catch(() => null)
      : null
    next = await this.runPlates(projectId, next, emit, provider)
    this.store.saveSpec(projectId, next)
    return next
  }

  /** paint every plate the crafts still need (2 in flight); failures fall back to the grid look */
  private async runPlates(projectId: string, spec: VideoSpec, emit: (e: PipelineEvent) => void, vision: LLMProvider): Promise<VideoSpec> {
    const preset0 = PLATFORM_PRESETS[spec.platform]
    for (const c of spec.crafts) {
      if (c.plate?.file && !c.plate.anchor) {
        c.plate.anchor = await relocatePlate({ vision: vision.id === 'mock' ? null : vision, plate: c.plate, projectDir: this.store.dir(projectId), width: preset0.width, height: preset0.height }).catch(() => undefined)
      }
    }
    const stillsAvailable = this.media ? this.media.imageAvailable() : Boolean(this.imageProviderFor())
    const wantsClip = (c: VideoSpec['crafts'][number]) => Boolean(c.background === 'plate' && c.plate?.motion && !c.plate.clipFile && this.media?.clipsAvailable())
    // a motion plate without a still can still become a clip (text-to-video) when no image model is set
    const todo = spec.crafts.filter((c) => c.background === 'plate' && c.plate && !c.plate.file && (stillsAvailable || !wantsClip(c)))
    if ((todo.length === 0 && !spec.crafts.some(wantsClip)) || !spec.design) return spec
    const design = spec.design
    const imageProvider = this.imageProviderFor()
    const crafts = new Map(spec.crafts.map((c) => [c.sceneId, structuredClone(c)]))
    const toGrid = (id: string) => {
      const c = crafts.get(id)
      if (!c) return
      c.background = 'grid'
      c.plate = undefined
      c.widgets = c.widgets.filter((w) => w.type !== 'annotation')
    }
    if (!stillsAvailable) {
      todo.forEach((c) => toGrid(c.sceneId))
      if (!spec.crafts.some(wantsClip)) return { ...spec, crafts: spec.crafts.map((c) => crafts.get(c.sceneId) ?? c) }
      todo.length = 0
    }
    this.track(projectId, 'plates', 'running')
    emit({ stage: 'plates', status: 'started', total: todo.length })
    const preset = PLATFORM_PRESETS[spec.platform]
    const indexOf = new Map(spec.scenes.map((s, i) => [s.id, i]))
    // the prefetch fired at the end of direction — give its downloads a moment to land
    const pre = this.prefetch
    this.prefetch = null
    if (pre) await Promise.race([pre, new Promise<null>((r) => setTimeout(() => r(null), 45_000))])
    let made = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < todo.length && !this.cancelled) {
        const job = todo[cursor++]
        const sceneIndex = indexOf.get(job.sceneId) ?? 0
        const plate = job.plate
        if (!plate) continue
        try {
          const media = this.media
          const r = await makePlate({
            obtain: media
              ? async (fullPrompt) =>
                  (
                    await media.paint({
                      brief: plate.prompt,
                      fullPrompt,
                      subjectLabel: plate.subjectLabel,
                      look: design.look,
                      width: preset.width,
                      height: preset.height,
                      projectId
                    })
                  ).buffer
              : async (fullPrompt) => {
                  if (!imageProvider?.generateImage) throw new Error('no image model configured')
                  return imageProvider.generateImage({ prompt: fullPrompt, width: preset.width, height: preset.height })
                },
            vision: vision.id === 'mock' ? null : vision,
            plate,
            design,
            sceneId: job.sceneId,
            projectDir: this.store.dir(projectId),
            width: preset.width,
            height: preset.height
          })
          const c = crafts.get(job.sceneId)
          if (c) c.plate = { ...plate, file: r.file, depthFile: r.depthFile, anchor: r.anchor }
          made += 1
          emit({ stage: 'plates', status: 'scene', sceneIndex, dataUrl: r.previewDataUrl })
        } catch (err) {
          toGrid(job.sceneId)
          emit({ stage: 'plates', status: 'failed', sceneIndex, error: String((err as Error)?.message ?? err).slice(0, 160) })
        }
      }
    }
    await Promise.all([worker(), worker()])
    const moving = await this.runClips(projectId, spec, crafts, toGrid)
    this.track(projectId, 'plates', 'done', `${made}/${todo.length} painted${moving ? ` · ${moving} moving` : ''}`)
    emit({ stage: 'plates', status: 'done', made })
    return { ...spec, crafts: spec.crafts.map((c) => crafts.get(c.sceneId) ?? c) }
  }

  /**
   * Motion plates → moving clips (one at a time: each is a minute-long, paid
   * generation). The painted still seeds the clip so the art direction holds;
   * any failure keeps the still, and a clip-only scene with no still falls
   * back to the grid look.
   */
  private async runClips(
    projectId: string,
    spec: VideoSpec,
    crafts: Map<string, VideoSpec['crafts'][number]>,
    toGrid: (sceneId: string) => void
  ): Promise<number> {
    const media = this.media
    if (!media || !spec.design || !media.clipsAvailable()) return 0
    const preset = PLATFORM_PRESETS[spec.platform]
    const dir = this.store.dir(projectId)
    let made = 0
    let missed = 0
    const attempted = new Set<string>()
    for (const scene of spec.scenes) {
      if (this.cancelled) break
      const c = crafts.get(scene.id)
      const plate = c?.plate
      if (!c || c.background !== 'plate' || !plate?.motion || plate.clipFile) continue
      attempted.add(scene.id)
      try {
        const still = plate.file && existsSync(join(dir, plate.file)) ? readFileSync(join(dir, plate.file)) : undefined
        const r = await media.motionClip({
          prompt: plate.prompt,
          subjectLabel: plate.subjectLabel,
          camera: plate.camera,
          imageStyle: spec.design.imageStyle,
          still,
          width: preset.width,
          height: preset.height,
          durationSec: scene.durationSec,
          projectId
        })
        if (!r) throw new Error('no clip source')
        mkdirSync(join(dir, 'assets', 'plates'), { recursive: true })
        writeFileSync(join(dir, 'assets', 'plates', `${scene.id}.mp4`), r.buffer)
        c.plate = { ...plate, clipFile: `assets/plates/${scene.id}.mp4` }
        made += 1
      } catch (err) {
        this.store.appendEvent(projectId, `clip for ${scene.id} skipped: ${String((err as Error)?.message ?? err).slice(0, 160)}`)
        missed++
        if (plate.file) c.plate = { ...plate, motion: false }
        else toGrid(scene.id)
      }
    }
    // A failed motion request should not waste a suitable clip elsewhere in
    // the library. Try other beats without making extra downloads or paid calls.
    if (missed && !this.cancelled) for (const scene of spec.scenes) {
      if (!missed || this.cancelled) break
      const c = crafts.get(scene.id), plate = c?.plate
      if (!c || c.background !== 'plate' || !plate || plate.clipFile || attempted.has(scene.id)) continue
      try {
        const hit = await media.motionClip({ prompt: plate.prompt, subjectLabel: plate.subjectLabel, camera: plate.camera, imageStyle: spec.design.imageStyle, width: preset.width, height: preset.height, durationSec: scene.durationSec, projectId, libraryOnly: true })
        if (!hit) continue
        mkdirSync(join(dir, 'assets', 'plates'), { recursive: true })
        writeFileSync(join(dir, 'assets', 'plates', `${scene.id}.mp4`), hit.buffer)
        c.plate = { ...plate, motion: true, clipFile: `assets/plates/${scene.id}.mp4` }
        this.store.appendEvent(projectId, `clip for ${scene.id}: reused a suitable library clip after another beat had no match`)
        made++; missed--
      } catch { /* retain the existing still and try the next beat */ }
    }
    return made
  }

  /**
   * Vision critic round: grade the real frames; scenes below the bar go back
   * to the scene director with the notes, then recompose + QA (audio kept).
   */
  private async runCritic(
    projectId: string,
    spec: VideoSpec,
    userPrompt: string,
    audio: Awaited<ReturnType<Orchestrator['runCompose']>>,
    emit: (e: PipelineEvent) => void
  ): Promise<{ spec: VideoSpec; qa?: CheckReport } | null> {
    const provider = this.providerFor()
    if (!spec.design || provider.id === 'mock') return null
    this.track(projectId, 'critic', 'running')
    emit({ stage: 'critic', status: 'started' })
    const reviews = await reviewScenes({
      provider,
      renders: this.renders,
      projectDir: this.store.dir(projectId),
      spec,
      userPrompt,
      onReview: (r) => emit({ stage: 'critic', status: 'scene', sceneIndex: r.index, score: r.score, notes: r.notes })
    })
    const byId = new Map(reviews.map((r) => [r.sceneId, r]))
    let next: VideoSpec = {
      ...spec,
      crafts: spec.crafts.map((c) => {
        const r = byId.get(c.sceneId)
        return r ? { ...c, review: { score: r.score, notes: r.notes } } : c
      })
    }
    const toFix = reviews.filter((r) => r.revise)
    let qa: CheckReport | undefined
    if (toFix.length > 0 && !this.cancelled) {
      next = await this.runDirect(projectId, next, userPrompt, emit, {
        ids: new Set(toFix.map((r) => r.sceneId)),
        notes: new Map(toFix.map((r) => [r.sceneId, r.notes.join(' · ')])),
        // the critic judges frames, not wording: keep paid plates whose brief was only reworded
        keep: 'subject'
      })
      this.store.saveComposition(projectId, compose(next, vendorDir, fontsDir, audio))
      qa = await this.runQaLoop(projectId, next, audio, emit)
    }
    // Native 3D and existing custom scenes cannot be repaired by the plate
    // director. Try a bespoke alternative and retain the original unless it wins.
    const bespokeFixes = reviews.filter(r => r.needsManualRevision)
    let bespokeRevised = 0
    if (bespokeFixes.length && !this.cancelled) {
      const previous = next
      next = await this.runCustomScenes(projectId, next, userPrompt, audio, emit, new Map(bespokeFixes.map(r => [r.sceneId, r.notes.join(' | ')])))
      const signature = (value: VideoSpec, id: string) => JSON.stringify([value.customScenes?.find(c => c.sceneId === id), value.customVideos?.find(c => c.sceneId === id)])
      bespokeRevised = bespokeFixes.filter(r => signature(previous, r.sceneId) !== signature(next, r.sceneId)).length
    }
    this.store.saveSpec(projectId, next)
    const avg = reviews.length ? reviews.reduce((a, r) => a + r.score, 0) / reviews.length : 0
    const revised = toFix.length + bespokeRevised
    this.track(projectId, 'critic', 'done', reviews.length ? `avg ${avg.toFixed(1)}/10 | ${revised} revised` : 'no frames reviewed')
    emit({ stage: 'critic', status: 'done', revised })
    return { spec: next, qa }
  }

  private async runCompose(projectId: string, spec: VideoSpec, emit: (e: PipelineEvent) => void, targetSec?: number, preserveTiming = false) {
    this.track(projectId, 'compose', 'running')
    emit({ stage: 'compose', status: 'started' })
    // voice-first: narration is synthesized (or reused) and measured, and scene
    // durations are fitted to it — in place, so every caller's spec follows
    try {
      const speech = this.speech()
      const before = spec.durationSec
      if (!preserveTiming || !canReuseNarrationTiming(spec, this.store.dir(projectId))) {
        await narrate(spec, speech, this.store.dir(projectId), speech && this.media ? this.media.voiceCache(projectId, speech) : undefined, targetSec)
      } else {
        this.store.appendEvent(projectId, 'voice: reused saved narration and scene timings')
      }
      this.store.saveSpec(projectId, spec)
      if (spec.voiceover.length) {
        this.store.appendEvent(projectId, `voice: ${spec.voiceover.length} takes (${spec.voice?.id}) · ${before}s → ${spec.durationSec}s`)
      }
    } catch (e) {
      this.store.appendEvent(projectId, `voice: skipped (${(e as Error).message.slice(0, 120)})`)
    }
    // scene windows are recomputed here to place audio clips at scene starts
    let acc = 0
    const sceneWindows = spec.scenes.map((s) => {
      const w = { id: s.id, start: acc, end: acc + s.durationSec }
      acc += s.durationSec
      return w
    })
    // audio is enhancement-only: any failure degrades to a silent video
    const musicFile = this.media
      ? await this.media.music(spec, acc, projectId).catch((e: Error) => {
          this.store.appendEvent(projectId, `music: built-in score (${e.message.slice(0, 120)})`)
          return null
        })
      : null
    const audio = await buildAudio(spec, sceneWindows, this.store.dir(projectId), musicDir, musicFile).catch((e: Error) => {
      this.store.appendEvent(projectId, `audio: silent (${e.message.slice(0, 120)})`)
      return { clips: [], captions: [], hasNarration: false }
    })
    const composed = compose(spec, vendorDir, fontsDir, audio)
    this.store.saveComposition(projectId, composed)
    this.track(projectId, 'compose', 'done', 'composition written')
    emit({ stage: 'compose', status: 'done' })
    return audio
  }

  private async runQaLoop(
    projectId: string,
    spec: VideoSpec,
    audio: Awaited<ReturnType<Orchestrator['runCompose']>>,
    emit: (e: PipelineEvent) => void
  ): Promise<CheckReport> {
    this.track(projectId, 'qa', 'running')
    emit({ stage: 'qa', status: 'started' })
    let qa = await this.renders.check(this.store.dir(projectId))
    let attempt = 0
    while (!qa.ok && attempt < MAX_QA_ATTEMPTS) {
      attempt += 1
      const issues = qa.errors.map((e) => e.message)
      emit({ stage: 'qa', status: 'fixing', attempt, issues })

      // rung 1: deterministic spec-level fixes (no LLM)
      const fixedSpec = applyDeterministicFixes(spec, qa)
      if (fixedSpec !== spec) {
        spec = fixedSpec
        this.store.saveSpec(projectId, spec)
        const recomposed = compose(spec, vendorDir, fontsDir, audio)
        this.store.saveComposition(projectId, recomposed)
      } else {
        // rung 2: LLM-assisted composition patch (mock provider declines)
        const html = readComposition(this.store.dir(projectId))
        const patched = await new CompositionFixer(this.providerFor()).fix(html, qa.errors)
        if (!patched) break // nothing more to try
        writeComposition(this.store.dir(projectId), patched)
      }
      qa = await this.renders.check(this.store.dir(projectId))
    }
    if (qa.ok) {
      this.track(projectId, 'qa', 'done', qa.warnings.length ? `${qa.warnings.length} warnings` : 'clean')
      emit({ stage: 'qa', status: 'done', clean: qa.errors.length === 0, warnings: qa.warnings.length })
    } else {
      // continue to render anyway (warnings don't block), but record failure state
      this.track(projectId, 'qa', 'failed', qa.errors[0]?.message)
      emit({ stage: 'qa', status: 'failed', issues: qa.errors.map((e) => e.message) })
    }
    return qa
  }

  private async runRender(
    projectId: string,
    spec: VideoSpec,
    platform: VideoSpec['platform'],
    opts: { quality?: 'draft' | 'standard' | 'delivery'; gpu?: boolean; suffix?: string },
    emit: (e: PipelineEvent) => void,
    qa: CheckReport
  ): Promise<GenerateResult> {
    this.track(projectId, 'render', 'running')
    emit({ stage: 'render', status: 'started' })
    this.store.setStatus(projectId, 'rendering')
    const output = join(this.store.dir(projectId), 'renders', `${slugish(spec.title)}-${platform}${opts.suffix ? `-${opts.suffix}` : ''}.mp4`)
    const onProgress = (p: RenderProgress) => emit({ stage: 'render', status: 'progress', pct: p.pct })
    const result = await this.renders.render(
      this.store.dir(projectId),
      output,
      { fps: spec.fps, quality: opts.quality ?? 'standard', gpu: opts.gpu, onProgress },
      projectId
    )
    if (this.cancelled) return this.abort(projectId, emit)
    if (result.ok && result.output) {
      this.store.addRender(projectId, result.output, platform)
      this.store.setStatus(projectId, 'done')
      this.track(projectId, 'render', 'done', `${(result.durationSec ?? 0).toFixed(1)}s wall`)
      emit({ stage: 'render', status: 'done', output: result.output, wallSec: result.durationSec ?? 0 })
      emit({ stage: 'done', projectId, output: result.output })
      return { projectId, spec, output: result.output, qa }
    }
    this.store.setStatus(projectId, 'error', result.error)
    emit({ stage: 'render', status: 'failed', error: result.error ?? 'unknown' })
    throw new Error(`Render failed: ${result.error}`)
  }

  /**
   * Resume an interrupted project: replans only when the spec is missing,
   * recomposes only when the composition is missing, re-runs QA only when it
   * never completed — then renders. Survives crashes, force-quits, restarts.
   */
  async resume(
    projectId: string,
    opts: { quality?: 'draft' | 'standard' | 'delivery'; gpu?: boolean; craft?: CraftMode; onEvent?: (e: PipelineEvent) => void }
  ): Promise<string> {
    const emit = opts.onEvent ?? (() => {})
    const meta = this.store.readMeta(projectId)
    if (!meta) throw new Error(`unknown project ${projectId}`)
    this.cancelled = false
    this.activeJobId = projectId

    let spec = this.store.readSpec(projectId)
    this.store.appendEvent(projectId, 'resuming pipeline')

    // ---------- plan ----------
    if (!spec) {
      if (!meta.platform) throw new Error('cannot replan: project has no saved platform')
      emit({ stage: 'plan', status: 'started' })
      this.track(projectId, 'plan', 'running')
      const planner = new Planner(this.providerFor())
      spec = await planner.plan({
        userPrompt: meta.prompt,
        platform: meta.platform as VideoSpec['platform']
      })
      const fresh = this.store.readMeta(projectId)
      if (fresh) {
        fresh.title = spec.title
        this.store.writeMeta(projectId, fresh)
      }
      this.store.saveSpec(projectId, spec)
      this.track(projectId, 'plan', 'done', `${spec.scenes.length} scenes · ${spec.durationSec}s`)
      emit({
        stage: 'plan',
        status: 'done',
        title: spec.title,
        scenes: spec.scenes.length,
        durationSec: spec.durationSec,
        sceneCards: spec.scenes.map((s) => ({ kind: s.kind, label: sceneLabel(s), durationSec: s.durationSec }))
      })
    } else {
      // spec survived — skip the LLM entirely
      emit({
        stage: 'plan',
        status: 'done',
        title: spec.title,
        scenes: spec.scenes.length,
        durationSec: spec.durationSec,
        sceneCards: spec.scenes.map((s) => ({ kind: s.kind, label: sceneLabel(s), durationSec: s.durationSec }))
      })
      this.store.appendEvent(projectId, 'plan: resumed from saved spec (no LLM call)')
    }

    // ---------- direct (only when it never finished) ----------
    if (this.cancelled) return this.abort(projectId, emit)
    let directed = false
    const isometricOnly = isIsometricOnlyBrief(meta.prompt)
    if (isometricOnly && (spec.crafts.length || spec.customScenes?.length)) {
      spec = { ...spec, crafts: [], customScenes: [], customVideos: [] }
      this.store.saveSpec(projectId, spec)
    }
    if (!isometricOnly && opts.craft !== 'classic' && (!spec.design || spec.crafts.length < spec.scenes.length)) {
      spec = await this.runDirect(projectId, spec, meta.prompt, emit)
      directed = true
    } else if (!isometricOnly && spec.crafts.some((c) => c.background === 'plate' && !c.plate?.file)) {
      spec = await this.runPlates(projectId, spec, emit, this.providerFor())
      this.store.saveSpec(projectId, spec)
      directed = true
    }

    // ---------- compose ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const composition = join(this.store.dir(projectId), 'index.html')
    let audio: Awaited<ReturnType<Orchestrator['runCompose']>> = { clips: [], captions: [], hasNarration: false }
    if (!existsSync(composition) || directed || isometricOnly) {
      audio = await this.runCompose(projectId, spec, emit, isometricOnly ? spec.durationSec : undefined, isometricOnly)
    } else {
      this.store.appendEvent(projectId, 'compose: resumed (composition intact)')
      emit({ stage: 'compose', status: 'done' })
    }

    // ---------- QA ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const state = this.store.readState(projectId)
    let qa: CheckReport
    if (isometricOnly) {
      qa = { ok: true, errors: [], warnings: [] }
    } else if (state.stages.qa.status === 'done' && existsSync(composition) && !directed) {
      qa = { ok: true, errors: [], warnings: [] }
      this.store.appendEvent(projectId, 'qa: resumed (already passed)')
      emit({ stage: 'qa', status: 'done', clean: true, warnings: 0 })
    } else {
      qa = await this.runQaLoop(projectId, spec, audio, emit)
    }

    if (isometricOnly) {
      try {
        spec = await this.runCustomScenes(projectId, spec, meta.prompt, audio, emit, undefined, true)
        if (!this.cancelled) {
          qa = await this.runQaLoop(projectId, spec, audio, emit)
          if (!qa.ok) throw new Error(`Isometric film failed final render checks: ${qa.errors.map(e => e.message).join('; ') || 'no diagnostics returned'}`)
        }
      } catch (err) {
        this.store.setStatus(projectId, 'error', String(err))
        throw err
      }
    }

    // ---------- live storyboard captures ----------
    if (this.cancelled) return this.abort(projectId, emit)
    await this.captureThumbs(projectId, spec, emit)

    // ---------- render ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const result = await this.runRender(
      projectId,
      spec,
      (meta.platform as VideoSpec['platform']) ?? spec.platform,
      opts,
      emit,
      qa
    )
    return result.output
  }

  /** Shared cancellation path: mark the project, tell the UI, stop the pipeline. */
  private abort(projectId: string, emit: (e: PipelineEvent) => void): never {
    this.store.setStatus(projectId, 'cancelled')
    emit({ stage: 'pipeline', status: 'cancelled' })
    throw new GenerationCancelled()
  }
}

/**
 * Deterministic auto-fixes — no LLM involved. Maps check errors to spec-level
 * adjustments the composer respects on the next pass. Returns the same spec
 * object when no fix applies (signals the loop to stop).
 */
export function applyDeterministicFixes(spec: VideoSpec, qa: CheckReport): VideoSpec {
  const messages = qa.errors.map((e) => `${e.message} ${e.selector ?? ''}`).join('\n')
  let changed = false
  const next: VideoSpec = structuredClone(spec)

  // text overflow → shorten headline text budget by splitting long scenes' text
  if (/overflow|out of bounds|outside/i.test(messages)) {
    for (const scene of next.scenes) {
      if ('headline' in scene && scene.headline && scene.headline.length > 24) {
        ;(scene as { headline: string }).headline = shorten(scene.headline)
        changed = true
      }
    }
  }

  // contrast → bump foreground toward pure white / background toward black
  if (/contrast/i.test(messages)) {
    next.palette = { ...next.palette, fg: '#FFFFFF', bg: darken(next.palette.bg) }
    changed = true
  }

  // motion validation: nothing moved → guarantee at least one animated element
  if (/nothing on screen moved|no.*motion/i.test(messages)) {
    if (next.scenes[0] && 'transitionIn' in next.scenes[0]) {
      next.scenes[0].transitionIn = 'fade'
      changed = true
    }
  }

  return changed ? next : spec
}

function shorten(s: string): string {
  const words = s.split(/\s+/)
  if (words.length > 5) return words.slice(0, 5).join(' ')
  return s.slice(0, Math.max(12, Math.floor(s.length * 0.7)))
}

function darken(hex: string): string {
  const c = hex.replace('#', '')
  const ch = (sa: string) =>
    Math.max(0, Math.round(parseInt(sa, 16) * 0.75)).toString(16).padStart(2, '0')
  return `#${ch(c.slice(0, 2))}${ch(c.slice(2, 4))}${ch(c.slice(4, 6))}`
}

function slugish(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'video'
  )
}
