import { join } from 'node:path'
import type { VideoSpec } from '@shared/spec'
import type { LLMProvider } from '../providers/types'
import { Planner } from './planner'
import { CompositionFixer } from './fixer'
import { buildAudio } from './audio'
import { compose } from '../composer'
import { ProjectStore } from '../store/projectStore'
import { RenderService, type CheckReport, type RenderProgress } from '../rendererService/hyperframes'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

function readComposition(dir: string): string {
  const p = join(dir, 'index.html')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}

function writeComposition(dir: string, html: string): void {
  writeFileSync(join(dir, 'index.html'), html)
}

/**
 * Orchestrator — the pipeline: plan → compose → QA fix-loop → render.
 * Emits stage events (surfaced in the UI activity feed and CLI logs).
 * The QA loop is the "resilient agent": check → classify → fix → re-check,
 * bounded retries, deterministic fixes first.
 */

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const vendorDir = resolve(appRoot, 'vendor')
const fontsDir = resolve(appRoot, 'vendor', 'fonts')
const musicDir = resolve(appRoot, 'music')

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
  | { stage: 'done'; projectId: string; output: string }

export interface GenerateResult {
  projectId: string
  spec: VideoSpec
  output: string
  qa: CheckReport
}

const MAX_QA_ATTEMPTS = 3

export class Orchestrator {
  private readonly renders = new RenderService()

  constructor(
    private readonly store: ProjectStore,
    /** resolved per-run so settings changes take effect without restart */
    private readonly providerFor: () => LLMProvider
  ) {}

  async generate(opts: GenerateOptions): Promise<GenerateResult> {
    const emit = (e: PipelineEvent) => opts.onEvent?.(e)
    const planner = new Planner(this.providerFor())

    // ---------- plan ----------
    emit({ stage: 'plan', status: 'started' })
    const provisional = this.store.create(opts.prompt, opts.prompt.slice(0, 48))
    const projectId = provisional.id
    this.store.setStatus(projectId, 'planning')
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
    emit({
      stage: 'plan',
      status: 'done',
      title: spec.title,
      scenes: spec.scenes.length,
      durationSec: spec.durationSec
    })

    // ---------- compose ----------
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
    emit({ stage: 'compose', status: 'done' })

    // ---------- QA fix-loop ----------
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
        const current = this.store.readMeta(projectId)
        void current
        const html = readComposition(this.store.dir(projectId))
        const patched = await new CompositionFixer(this.providerFor()).fix(html, qa.errors)
        if (!patched) break // nothing more to try
        writeComposition(this.store.dir(projectId), patched)
      }
      qa = await this.renders.check(this.store.dir(projectId))
    }
    if (qa.ok) {
      emit({ stage: 'qa', status: 'done', clean: qa.errors.length === 0, warnings: qa.warnings.length })
    } else {
      // continue to render anyway (warnings don't block), but record failure state
      emit({ stage: 'qa', status: 'failed', issues: qa.errors.map((e) => e.message) })
    }

    // ---------- render ----------
    emit({ stage: 'render', status: 'started' })
    this.store.setStatus(projectId, 'rendering')
    const output = join(this.store.dir(projectId), 'renders', `${slugish(spec.title)}-${opts.platform}.mp4`)
    const onProgress = (p: RenderProgress) => emit({ stage: 'render', status: 'progress', pct: p.pct })
    const result = await this.renders.render(
      this.store.dir(projectId),
      output,
      { fps: spec.fps, quality: opts.quality ?? 'standard', gpu: opts.gpu, onProgress }
    )
    if (result.ok && result.output) {
      this.store.addRender(projectId, result.output, opts.platform)
      this.store.setStatus(projectId, 'done')
      emit({ stage: 'render', status: 'done', output: result.output, wallSec: result.durationSec ?? 0 })
      emit({ stage: 'done', projectId, output: result.output })
      return { projectId, spec, output: result.output, qa }
    }
    this.store.setStatus(projectId, 'error', result.error)
    emit({ stage: 'render', status: 'failed', error: result.error ?? 'unknown' })
    throw new Error(`Render failed: ${result.error}`)
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
