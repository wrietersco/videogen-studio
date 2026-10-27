import { join } from 'node:path'
import type { VideoSpec } from '@shared/spec'
import type { LLMProvider } from '../providers/types'
import { Planner } from './planner'
import { CompositionFixer } from './fixer'
import { buildAudio } from './audio'
import { compose, COMPOSER_VERSION, type AudioLayer } from '../composer'
import { ProjectStore, type StageName, type StageState } from '../store/projectStore'
import { RenderService, type CheckReport, type RenderProgress } from '../rendererService/hyperframes'
import { vendorDir, fontsDir, musicDir } from '../paths'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'


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
  onEvent?: (e: PipelineEvent) => void
}

export type PipelineEvent =
  | { stage: 'plan'; status: 'started' }
  | { stage: 'plan'; status: 'done'; title: string; scenes: number; durationSec: number }
  | { stage: 'compose'; status: 'started' }
  | { stage: 'compose'; status: 'done' }
  | { stage: 'qa'; status: 'started' }
  | { stage: 'qa'; status: 'fixing'; attempt: number; issues: string[] }
  | { stage: 'qa'; status: 'done'; clean: boolean; warnings: number }
  | { stage: 'qa'; status: 'failed'; issues: string[] }
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

export class Orchestrator {
  private readonly renders = new RenderService()
  private cancelled = false
  private activeJobId: string | null = null

  constructor(
    private readonly store: ProjectStore,
    /** resolved per-run so settings changes take effect without restart */
    private readonly providerFor: () => LLMProvider
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
      s.stages = { plan: { status: 'running', startedAt: new Date().toISOString() }, compose: { status: 'pending' }, qa: { status: 'pending' }, render: { status: 'pending' } }
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
      durationSec: spec.durationSec
    })

    // ---------- compose ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const audio = await this.runCompose(projectId, spec, emit)

    // ---------- QA fix-loop ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const qa = await this.runQaLoop(projectId, spec, audio, emit)

    // ---------- render ----------
    if (this.cancelled) return this.abort(projectId, emit)
    return this.runRender(projectId, spec, opts.platform, opts, emit, qa)
  }

  // ---------------- shared stage implementations (used by generate + resume) ----------------

  private async runCompose(projectId: string, spec: VideoSpec, emit: (e: PipelineEvent) => void) {
    this.track(projectId, 'compose', 'running')
    emit({ stage: 'compose', status: 'started' })
    // scene windows are recomputed here to place audio clips at scene starts
    let acc = 0
    const sceneWindows = spec.scenes.map((s) => {
      const w = { id: s.id, start: acc, end: acc + s.durationSec }
      acc += s.durationSec
      return w
    })
    // audio is enhancement-only: any failure degrades to a silent video
    const audio = await buildAudio(spec, sceneWindows, this.providerFor(), this.store.dir(projectId), musicDir).catch(
      () => ({ clips: [], captions: [], hasNarration: false })
    )
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
    opts: { quality?: 'draft' | 'standard' | 'delivery'; gpu?: boolean },
    emit: (e: PipelineEvent) => void,
    qa: CheckReport
  ): Promise<GenerateResult> {
    this.track(projectId, 'render', 'running')
    emit({ stage: 'render', status: 'started' })
    this.store.setStatus(projectId, 'rendering')
    const output = join(this.store.dir(projectId), 'renders', `${slugish(spec.title)}-${platform}.mp4`)
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
    opts: { quality?: 'draft' | 'standard' | 'delivery'; gpu?: boolean; onEvent?: (e: PipelineEvent) => void }
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
      emit({ stage: 'plan', status: 'done', title: spec.title, scenes: spec.scenes.length, durationSec: spec.durationSec })
    } else {
      // spec survived — skip the LLM entirely
      emit({ stage: 'plan', status: 'done', title: spec.title, scenes: spec.scenes.length, durationSec: spec.durationSec })
      this.store.appendEvent(projectId, 'plan: resumed from saved spec (no LLM call)')
    }

    // ---------- compose ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const composition = join(this.store.dir(projectId), 'index.html')
    let audio: Awaited<ReturnType<Orchestrator['runCompose']>> = { clips: [], captions: [], hasNarration: false }
    if (!existsSync(composition)) {
      audio = await this.runCompose(projectId, spec, emit)
    } else {
      this.store.appendEvent(projectId, 'compose: resumed (composition intact)')
      emit({ stage: 'compose', status: 'done' })
    }

    // ---------- QA ----------
    if (this.cancelled) return this.abort(projectId, emit)
    const state = this.store.readState(projectId)
    let qa: CheckReport
    if (state.stages.qa.status === 'done' && existsSync(composition)) {
      qa = { ok: true, errors: [], warnings: [] }
      this.store.appendEvent(projectId, 'qa: resumed (already passed)')
      emit({ stage: 'qa', status: 'done', clean: true, warnings: 0 })
    } else {
      qa = await this.runQaLoop(projectId, spec, audio, emit)
    }

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
