import { join } from 'node:path'
import type { VideoSpec } from '@shared/spec'
import type { LLMProvider } from '../providers/types'
import { Planner } from './planner'
import { CompositionFixer } from './fixer'
import { buildAudio } from './audio'
import { narrate } from '../audio/voice'
import { compose, COMPOSER_VERSION, type AudioLayer } from '../composer'
import { captureSceneThumbs } from '../livePreview'
import { ProjectStore, type StageName, type StageState } from '../store/projectStore'
import { RenderService, type CheckReport, type RenderProgress } from '../rendererService/hyperframes'
import { vendorDir, fontsDir, musicDir } from '../paths'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { PLATFORM_PRESETS } from '@shared/presets'
import { SceneDirector } from '../director/director'
import { makePlate, relocatePlate } from '../director/plates'
import { reviewScenes } from '../director/critic'


function readComposition(dir: string): string {
  const p = join(dir, 'index.html')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function writeComposition(dir: string, html: string): void {
  writeFileSync(join(dir, 'index.html'), html)
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
  onEvent?: (e: PipelineEvent) => void
}

type CraftMode = 'directed' | 'classic'

export type PipelineEvent =
  | { stage: 'plan'; status: 'started' }
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
  private activeJobId: string | null = null

  constructor(
    private readonly store: ProjectStore,
    /** resolved per-run so settings changes take effect without restart */
    private readonly providerFor: () => LLMProvider,
    /** image model for painted plates (null → directed scenes use dot-grid backgrounds) */
    private readonly imageProviderFor: () => LLMProvider | null = () => null
  ) {}

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
    if (spec.design && opts.craft !== 'classic') {
      const meta0 = this.store.readMeta(projectId)
      spec = await this.runDirect(projectId, spec, meta0?.prompt ?? spec.title, emit, {
        ids: new Set([sceneId]),
        notes: new Map([[sceneId, `The user asked: "${feedback}"`]])
      })
    }

    // ---------- recompose (narration + captions for the revised text) ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const audio = await this.runCompose(projectId, spec, emit)
    const qa = await this.runQaLoop(projectId, spec, audio, emit)

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

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const emit = (e: PipelineEvent) => opts.onEvent?.(e)
    this.cancelled = false
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
      s.events = [{ at: new Date().toISOString(), text: `started: "${opts.prompt.slice(0, 60)}"` }]
    })
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

    // ---------- direct: film design, per-scene crafts, painted plates ----------
    if (this.cancelled) return this.abort(projectId, emit)
    if (opts.craft !== 'classic') spec = await this.runDirect(projectId, spec, opts.prompt, emit)

    // ---------- compose ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const audio = await this.runCompose(projectId, spec, emit)

    // ---------- QA fix-loop ----------
    if (this.cancelled) return this.abort(projectId, emit)
    let qa = await this.runQaLoop(projectId, spec, audio, emit)

    // ---------- vision critic: watch the real frames, send weak scenes back ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const critiqued = await this.runCritic(projectId, spec, opts.prompt, audio, emit)
    if (critiqued) {
      spec = critiqued.spec
      qa = critiqued.qa ?? qa
    }

    // ---------- live storyboard captures ----------
    if (this.cancelled) return this.abort(projectId, emit)
    await this.captureThumbs(projectId, spec, emit)

    // ---------- render ----------
    if (this.cancelled) return this.abort(projectId, emit)
    return this.runRender(projectId, spec, opts.platform, opts, emit, qa)
  }

  // ---------------- shared stage implementations (used by generate + resume) ----------------

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
    only?: { ids: Set<string>; notes?: Map<string, string> }
  ): Promise<VideoSpec> {
    const provider = this.providerFor()
    const imageProvider = this.imageProviderFor()
    this.track(projectId, 'direct', 'running')
    emit({ stage: 'direct', status: 'started', total: only ? only.ids.size : spec.scenes.length })
    const director = new SceneDirector({
      provider,
      platesAvailable: imageProvider !== null,
      userPrompt,
      onScene: (i, c) =>
        emit({ stage: 'direct', status: 'scene', sceneIndex: i, headline: c.headline, widgets: c.widgets.map((w) => w.type), background: c.background })
    })
    const design = spec.design ?? (await director.directFilm(spec))
    if (!spec.design) emit({ stage: 'direct', status: 'film', look: design.look, series: design.series })
    const previous = new Map(spec.crafts.map((c) => [c.sceneId, c]))
    let next: VideoSpec = { ...spec, design }
    next = { ...next, crafts: await director.directScenes(next, design, only?.notes, only?.ids) }
    // an unchanged plate brief keeps its finished files (no second image bill)
    next.crafts = next.crafts.map((c) => {
      const old = previous.get(c.sceneId)?.plate
      if (c.plate && old?.file && old.prompt === c.plate.prompt)
        return {
          ...c,
          // same subject → same anchor; a new subject label is re-located on the same painting
          plate: { ...c.plate, file: old.file, depthFile: old.depthFile, anchor: old.subjectLabel === c.plate.subjectLabel ? old.anchor : undefined }
        }
      return c
    })
    this.store.saveSpec(projectId, next)
    const plates = next.crafts.filter((c) => c.background === 'plate').length
    this.track(projectId, 'direct', 'done', `${design.look} · ${next.crafts.length} scenes directed · ${plates} plate(s)`)
    emit({ stage: 'direct', status: 'done' })
    if (this.cancelled) return next
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
    const todo = spec.crafts.filter((c) => c.background === 'plate' && c.plate && !c.plate.file)
    if (todo.length === 0 || !spec.design) return spec
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
    if (!imageProvider) {
      todo.forEach((c) => toGrid(c.sceneId))
      return { ...spec, crafts: spec.crafts.map((c) => crafts.get(c.sceneId) ?? c) }
    }
    this.track(projectId, 'plates', 'running')
    emit({ stage: 'plates', status: 'started', total: todo.length })
    const preset = PLATFORM_PRESETS[spec.platform]
    const indexOf = new Map(spec.scenes.map((s, i) => [s.id, i]))
    let made = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < todo.length && !this.cancelled) {
        const job = todo[cursor++]
        const sceneIndex = indexOf.get(job.sceneId) ?? 0
        const plate = job.plate
        if (!plate) continue
        try {
          const r = await makePlate({
            imageProvider,
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
    this.track(projectId, 'plates', 'done', `${made}/${todo.length} painted`)
    emit({ stage: 'plates', status: 'done', made })
    return { ...spec, crafts: spec.crafts.map((c) => crafts.get(c.sceneId) ?? c) }
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
    if (!spec.design || spec.crafts.length === 0 || provider.id === 'mock') return null
    this.track(projectId, 'critic', 'running')
    emit({ stage: 'critic', status: 'started' })
    const reviews = await reviewScenes({
      provider,
      renders: this.renders,
      projectDir: this.store.dir(projectId),
      spec,
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
        notes: new Map(toFix.map((r) => [r.sceneId, r.notes.join(' · ')]))
      })
      this.store.saveComposition(projectId, compose(next, vendorDir, fontsDir, audio))
      qa = await this.runQaLoop(projectId, next, audio, emit)
    }
    this.store.saveSpec(projectId, next)
    const avg = reviews.length ? reviews.reduce((a, r) => a + r.score, 0) / reviews.length : 0
    this.track(projectId, 'critic', 'done', reviews.length ? `avg ${avg.toFixed(1)}/10 · ${toFix.length} revised` : 'no frames reviewed')
    emit({ stage: 'critic', status: 'done', revised: toFix.length })
    return { spec: next, qa }
  }

  private async runCompose(projectId: string, spec: VideoSpec, emit: (e: PipelineEvent) => void) {
    this.track(projectId, 'compose', 'running')
    emit({ stage: 'compose', status: 'started' })
    // voice-first: narration is synthesized (or reused) and measured, and scene
    // durations are fitted to it — in place, so every caller's spec follows
    try {
      const voiced = [this.providerFor(), this.imageProviderFor()].find((p) => p?.tts) ?? null
      const before = spec.durationSec
      await narrate(spec, voiced, this.store.dir(projectId))
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
    const audio = await buildAudio(spec, sceneWindows, this.store.dir(projectId), musicDir).catch((e: Error) => {
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
    if (opts.craft !== 'classic' && (!spec.design || spec.crafts.length < spec.scenes.length)) {
      spec = await this.runDirect(projectId, spec, meta.prompt, emit)
      directed = true
    } else if (spec.crafts.some((c) => c.background === 'plate' && !c.plate?.file)) {
      spec = await this.runPlates(projectId, spec, emit, this.providerFor())
      this.store.saveSpec(projectId, spec)
      directed = true
    }

    // ---------- compose ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const composition = join(this.store.dir(projectId), 'index.html')
    let audio: Awaited<ReturnType<Orchestrator['runCompose']>> = { clips: [], captions: [], hasNarration: false }
    if (!existsSync(composition) || directed) {
      audio = await this.runCompose(projectId, spec, emit)
    } else {
      this.store.appendEvent(projectId, 'compose: resumed (composition intact)')
      emit({ stage: 'compose', status: 'done' })
    }

    // ---------- QA ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const state = this.store.readState(projectId)
    let qa: CheckReport
    if (state.stages.qa.status === 'done' && existsSync(composition) && !directed) {
      qa = { ok: true, errors: [], warnings: [] }
      this.store.appendEvent(projectId, 'qa: resumed (already passed)')
      emit({ stage: 'qa', status: 'done', clean: true, warnings: 0 })
    } else {
      qa = await this.runQaLoop(projectId, spec, audio, emit)
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
