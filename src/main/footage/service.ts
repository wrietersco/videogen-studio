import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { planDuration, type EditPlan, type EditRecord, type FootageClip, type FootageEvent, type FootagePariEvent, type FootagePariReport, type FootageProject, type PlanRequest, type PlanResult, type UnderstandEstimate } from '../../shared/footage'
import type { AgentMode, DecisionAnswer, DecisionRequest } from '../../shared/agentBrief'
import { priceUsage } from '../../shared/pricing'
import type { LLMProvider } from '../providers/types'
import { clampToLength } from './captions'
import { planEdit, planShorts } from './planner'
import { renderPlan, RenderCancelled } from './render'
import { clipIdFor, frameBuffer, listVideoFiles, scanClip } from './scan'
import { tightenPlan } from './silence'
import { FootageStore, slug } from './store'
import { clusterCast, deriveClipInsights, estimateUnderstanding, listenToClip, summarizeTopic, watchClip } from './understand'
import { runFootagePari } from './agent/loop'
import { interpretInstruction } from './agent/instruct'
import { planRouting, applyRoutingDecision, type CandidateModel } from './agent/route'

export interface FootageDeps {
  store: FootageStore
  provider: () => LLMProvider
  /** the provider that watches clip frames (image processing); defaults to the writing provider */
  visionProvider?: () => LLMProvider
  /** OpenAI key for Whisper; empty = speech is not transcribed */
  whisperKey: () => string
  chatModel: () => string | undefined
  emit: (e: FootageEvent) => void
  /** makes an AI scene (Gemini) and returns the mp4 path; absent = no AI scenes */
  makeClip?: (prompt: string, aspect: '9:16' | '16:9', sec: number) => Promise<string>
  /** is an AI video key set up right now */
  aiReady?: () => boolean
  /** composes one AI music track (Lyra/ElevenLabs) and returns its audio file; null = fall back to the built-in score */
  aiMusic?: (styleBrief: string, mood: string, totalSec: number) => Promise<string | null>
  /** is an AI music key set up right now */
  aiMusicReady?: () => boolean
  /** every provider with a key right now (any provider may be routed to when it has the nearest capable model) */
  providers?: () => LLMProvider[]
}

/** the most the model routing may add to a run without asking */
const ROUTE_ESCALATE_CAP_USD = 1

export class FootageCancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

type ScanEvent = Omit<Extract<FootageEvent, { kind: 'scan' }>, 'kind' | 'projectId'>
type UnderstandEvent = Omit<Extract<FootageEvent, { kind: 'understand' }>, 'kind' | 'projectId'>

/** Orchestrates scanning, understanding, planning and rendering for footage projects. One job at a time. */
export class FootageService {
  private cancelled = false

  constructor(private readonly d: FootageDeps) {}

  cancel(): void {
    this.cancelled = true
  }

  private project(id: string): FootageProject {
    const p = this.d.store.read(id)
    if (!p) throw new Error('That footage project no longer exists')
    return p
  }

  /** free: find the videos, read their length and sound, cut them into shots, grab keyframes */
  async scan(projectId: string): Promise<void> {
    this.cancelled = false
    const emit = (e: ScanEvent) => this.d.emit({ kind: 'scan', projectId, ...e })
    emit({ status: 'started' })
    try {
      const project = this.project(projectId)
      const projectDir = this.d.store.dir(projectId)
      const files = listVideoFiles(project.folders.filter((f) => existsSync(f)))
      const existing = new Map(project.clips.map((c) => [c.path.toLowerCase(), c]))
      const keep = new Map<string, FootageClip>()
      const todo: Array<{ path: string; folder: string }> = []
      for (const f of files) {
        const old = existing.get(f.path.toLowerCase())
        let same = false
        try {
          const st = statSync(f.path)
          same = !!old && old.status === 'ok' && old.sizeBytes === st.size && old.mtimeMs === Math.round(st.mtimeMs)
        } catch {
          same = false
        }
        if (same && old) keep.set(old.id, { ...old, folder: f.folder })
        else todo.push(f)
      }
      const scanned: FootageClip[] = []
      let done = 0
      for (const f of todo) {
        if (this.cancelled) throw new FootageCancelled()
        emit({ status: 'progress', done, total: todo.length, clipName: f.path.split(/[\\/]/).pop() })
        try {
          scanned.push(await scanClip(f, projectDir))
        } catch (err) {
          scanned.push({ ...emptyClip(f), error: String((err as Error)?.message ?? err) })
        }
        done++
        if (done % 5 === 0) this.persist(projectId, project, keep, scanned, files)
      }
      this.persist(projectId, project, keep, scanned, files)
      const bad = scanned.filter((c) => c.status !== 'ok').length
      emit({ status: 'done', done: todo.length, total: todo.length, ...(bad ? { note: `${bad} file${bad > 1 ? 's' : ''} could not be read and will be skipped.` } : {}) })
    } catch (err) {
      if (err instanceof FootageCancelled) {
        emit({ status: 'done', note: 'Stopped. What was scanned so far is saved.' })
        return
      }
      emit({ status: 'failed', error: String((err as Error)?.message ?? err) })
    }
  }

  private persist(projectId: string, project: FootageProject, keep: Map<string, FootageClip>, scanned: FootageClip[], files: Array<{ path: string }>): void {
    const present = new Set(files.map((f) => f.path.toLowerCase()))
    const merged = new Map<string, FootageClip>(keep)
    for (const c of scanned) merged.set(c.id, c)
    // files that vanished stay in the list as "missing" so edits that use them can say why they fail
    for (const old of project.clips) if (!merged.has(old.id) && !present.has(old.path.toLowerCase())) merged.set(old.id, { ...old, status: 'missing' })
    const order = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    this.d.store.update(projectId, (p) => {
      p.clips = order
    })
  }

  estimate(projectId: string): UnderstandEstimate {
    const p = this.project(projectId)
    return estimateUnderstanding(p.clips, this.d.chatModel(), Boolean(this.d.whisperKey()))
  }

  /** paid: the AI looks at a frame of every shot and listens to the speech */
  async understand(projectId: string): Promise<void> {
    this.cancelled = false
    const emit = (e: UnderstandEvent) => this.d.emit({ kind: 'understand', projectId, ...e })
    emit({ status: 'started' })
    try {
      // who watches: the configured vision provider first, then the nearest capable model on any other provider
      const ladder = await this.visionLadder()
      if (!ladder.length) throw new Error('Connect an AI provider in Settings first: the free offline engine cannot watch videos.')
      const key = this.d.whisperKey()
      const projectDir = this.d.store.dir(projectId)
      const todo = this.project(projectId).clips.filter((c) => c.status === 'ok' && (!c.watched || (key && !c.listened)))
      let failures = 0
      for (let i = 0; i < todo.length; i++) {
        if (this.cancelled) throw new FootageCancelled()
        emit({ status: 'progress', done: i, total: todo.length, note: todo[i].name })
        const clip = structuredClone(todo[i])
        try {
          if (!clip.watched) {
            // try the watcher in order; a model that cannot see pictures hands over to the nearest capable one
            let watched = false
            for (let at = 0; at < ladder.length; at++) {
              try {
                await watchClip(ladder[at].provider, clip, projectDir, () => this.cancelled, ladder[at].model)
                if (at > 0) ladder.splice(0, at) // the fallback won: it watches the rest of the footage
                watched = true
                break
              } catch (err) {
                if (this.cancelled) throw new FootageCancelled()
                const msg = String((err as Error)?.message ?? err)
                const next = ladder[at + 1]
                if (next && /cannot review images|image-capable|cannot see|does not support images/i.test(msg)) {
                  emit({ status: 'progress', done: i, total: todo.length, note: `Switching the watching to ${next.provider.id}${next.model ? ` (${next.model})` : ''}…` })
                  continue
                }
                throw err
              }
            }
            if (!watched) throw new Error('No model could watch this footage.')
          }
          if (key && !clip.listened) await listenToClip(key, clip, projectDir, () => this.cancelled)
          // group what the watcher saw: who recurs across shots, where the dead air and voice-over are
          if (clip.watched) {
            const grouped = clusterCast(clip.shots)
            clip.shots = grouped.shots
            clip.cast = grouped.cast
            await deriveClipInsights(clip)
          }
          failures = 0
        } catch (err) {
          failures++
          if (failures >= 3) {
            this.save(projectId, clip)
            throw new Error(`Stopped after repeated errors: ${String((err as Error)?.message ?? err).slice(0, 200)}`)
          }
        }
        this.save(projectId, clip)
      }
      if (this.cancelled) throw new FootageCancelled()
      // one cheap call names what each finished clip is about, from everything that was said
      const speaking = this.project(projectId).clips.filter((c) => c.status === 'ok' && c.watched && c.listened && !c.topic)
      if (speaking.length && !this.cancelled) {
        await summarizeTopic(this.d.provider(), speaking, () => this.cancelled)
        for (const c of speaking) if (c.topic) this.save(projectId, c)
      }
      emit({
        status: 'done',
        done: todo.length,
        total: todo.length,
        ...(key ? {} : { note: 'Speech was not transcribed: add an OpenAI key in Settings to let the editor understand what is said.' })
      })
    } catch (err) {
      if (err instanceof FootageCancelled) {
        emit({ status: 'done', note: 'Stopped. Clips finished so far are saved.' })
        return
      }
      emit({ status: 'failed', error: String((err as Error)?.message ?? err) })
    }
  }

  private save(projectId: string, clip: FootageClip): void {
    this.d.store.update(projectId, (p) => {
      const i = p.clips.findIndex((c) => c.id === clip.id)
      if (i >= 0) p.clips[i] = clip
    })
  }

  async plan(projectId: string, req: PlanRequest, opts?: { model?: string; providerId?: string }): Promise<PlanResult> {
    const p = this.project(projectId)
    const provider = this.providerFor(opts?.providerId)
    const planOpts = {
      brief: p.brief,
      aiMusic: Boolean(this.d.aiMusic && (this.d.aiMusicReady?.() ?? true)),
      ...(opts?.model ? { model: opts.model } : {})
    }
    if (req.shorts && req.shorts > 1) {
      const many = await planShorts(provider, p.clips, req, planOpts)
      const shorts: NonNullable<PlanResult['shorts']> = []
      for (const plan of many.plans) {
        const t = req.tighten ? (await this.tighten(projectId, plan)).plan : plan
        shorts.push({ plan: t, thumbs: await this.thumbs(p.clips, t) })
      }
      return { plan: shorts[0].plan, source: many.source, thumbs: shorts[0].thumbs, shorts }
    }
    const outcome = await planEdit(provider, p.clips, { ...req, aiClips: Boolean(req.aiClips && this.aiOn()) }, planOpts)
    const tight = req.tighten ? await this.tighten(projectId, outcome.plan) : null
    const plan = tight?.plan ?? outcome.plan
    return { plan, source: outcome.source, thumbs: await this.thumbs(p.clips, plan) }
  }

  /** cut the long silent pauses out of the parts where people speak */
  async tighten(projectId: string, plan: EditPlan): Promise<{ plan: EditPlan; removedSec: number; thumbs: string[] }> {
    this.cancelled = false
    const p = this.project(projectId)
    const out = await tightenPlan(plan, p.clips, () => this.cancelled)
    // titles were timed on the longer cut: keep the ones that still fit
    const total = planDuration(out.plan)
    out.plan.titles = clampToLength(out.plan.titles, total)
    return { plan: out.plan, removedSec: Math.round(out.removedSec * 10) / 10, thumbs: await this.thumbs(p.clips, out.plan) }
  }

  /** a small picture from the middle of each planned segment */
  async thumbs(clips: FootageClip[], plan: EditPlan): Promise<string[]> {
    const byId = new Map(clips.map((c) => [c.id, c]))
    const out: string[] = new Array(plan.segments.length).fill('')
    let next = 0
    const worker = async () => {
      while (next < plan.segments.length) {
        const i = next++
        const s = plan.segments[i]
        const clip = byId.get(s.clipId)
        if (!clip || i >= 60) continue
        const buf = await frameBuffer(clip.path, (s.startSec + s.endSec) / 2, 240)
        if (buf) out[i] = `data:image/jpeg;base64,${buf.toString('base64')}`
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return out
  }

  // ---------------------------------------------------------------- the PARI agent

  /** a provider by id (null → the configured writing provider) */
  private providerFor(id?: string): LLMProvider {
    if (id) {
      const found = this.d.providers?.().find((p) => p.id === id)
      if (found) return found
    }
    return this.d.provider()
  }

  /** what this account could run each editing task on, ranked by price, from every provider with a key */
  private async routingCandidates(): Promise<CandidateModel[]> {
    const providers = this.d.providers?.().length ? this.d.providers!() : [this.d.provider()]
    const out: CandidateModel[] = []
    for (const provider of providers) {
      if (provider.id === 'mock') continue
      try {
        const models = await provider.listModels()
        for (const m of models) {
          if (m.kind === 'image') continue
          const usd = priceUsage(m.id, { inputTokens: 1000, outputTokens: 1000 }).usd
          out.push({ id: m.id, provider: provider.id, priceRank: usd <= 0 ? 0 : usd < 0.01 ? 1 : usd < 0.05 ? 2 : 3, supportsVision: m.supportsVision })
        }
      } catch {
        /* a provider that will not list its models is simply not routed to */
      }
    }
    return out
  }

  /**
   * Who can watch footage, in order: the configured vision provider first,
   * then the nearest capable model of every other provider — so a watcher
   * that cannot see pictures hands over instead of failing the run.
   */
  private async visionLadder(): Promise<Array<{ provider: LLMProvider; model?: string }>> {
    const first = this.d.visionProvider?.() ?? this.d.provider()
    const out: Array<{ provider: LLMProvider; model?: string }> = []
    if (first.id !== 'mock') out.push({ provider: first })
    const candidates = (await this.routingCandidates()).filter((c) => c.supportsVision && c.provider !== first.id)
    for (const c of candidates) {
      const provider = this.providerFor(c.provider)
      if (provider.id !== 'mock' && !out.some((o) => o.provider.id === provider.id && o.model === c.id)) out.push({ provider, model: c.id })
    }
    return out
  }

  /** watch & listen when parts are still unwatched; { ok: false } when that is not possible */
  private async ensureUnderstood(projectId: string): Promise<{ ok: boolean; reason?: string }> {
    const key = this.d.whisperKey()
    const left = () => this.project(projectId).clips.filter((c) => c.status === 'ok' && (!c.watched || (key && !c.listened)))
    if (!left().length) return { ok: true }
    const provider = this.d.visionProvider?.() ?? this.d.provider()
    if (provider.id === 'mock') return { ok: false, reason: 'Connect an AI provider in Settings first: the free offline engine cannot watch videos.' }
    await this.understand(projectId)
    const still = left()
    return still.length
      ? { ok: false, reason: `${still.length} of your videos could not be watched, so the editor would be guessing. Use “Watch & listen” first, then run the agent.` }
      : { ok: true }
  }

  /**
   * The agent run: understand → plan → (questions midway) → render → review →
   * honest report. The decide/instruction channels come from the IPC layer; the
   * model routing may escalate the planner within the cost cap, asking when it
   * would cost more.
   */
  async runAgent(
    projectId: string,
    req: PlanRequest,
    ctl: { decide: (requests: DecisionRequest[]) => Promise<DecisionAnswer[] | null>; takeInstructions: () => string[] }
  ): Promise<FootagePariReport> {
    this.cancelled = false
    const project = this.project(projectId)
    const mode: AgentMode = project.agentMode === 'autopilot' ? 'autopilot' : 'ask'
    const emitPari = (e: FootagePariEvent) => this.d.emit(e)

    // cost/quality routing: which model runs each task (an approximation of the catalog the planner will build)
    const ok = project.clips.filter((c) => c.status === 'ok')
    const catalogChars = ok.reduce((a, c) => a + (c.transcript ?? []).reduce((x, l) => x + l.text.length, 0) + c.shots.length * 160 + 200, 0)
    const candidates = await this.routingCandidates()
    let routing = planRouting({ catalogChars, shorts: req.shorts ?? 1, plannerFailedOnce: false, candidates, escalateCapUsd: ROUTE_ESCALATE_CAP_USD })
    let plannerModel = routing.choices.planner.modelId
    let plannerProviderId = routing.choices.planner.providerId
    if (routing.decision) {
      emitPari({ kind: 'pari-decide', projectId, requests: [routing.decision], ...(mode === 'autopilot' ? { auto: true } : {}) })
      const answers = mode === 'autopilot' ? [{ id: routing.decision.id, option: routing.decision.autopick, auto: true }] : await ctl.decide([routing.decision])
      if (!answers?.length) throw new FootageCancelled()
      routing = { choices: applyRoutingDecision(routing.choices, answers[0]), decision: null }
      plannerModel = routing.choices.planner.modelId
      plannerProviderId = routing.choices.planner.providerId
    }
    const cheapest = candidates[0]
    const plannerLabel = plannerModel ? `${plannerProviderId ?? this.d.provider().id}:${plannerModel}` : 'the default model'
    const modelSwitches = routing.choices['shot-describe'].modelId && routing.choices['shot-describe'].providerId !== (cheapest?.provider ?? routing.choices['shot-describe'].providerId)
      ? [`watcher: ${routing.choices['shot-describe'].providerId}:${routing.choices['shot-describe'].modelId} — the nearest model that can see pictures`]
      : []
    if (plannerModel && plannerModel !== cheapest?.id) modelSwitches.push(`planner: ${cheapest ? `${cheapest.provider}:${cheapest.id}` : 'the default'} → ${plannerLabel} (${routing.choices.planner.reason})`)

    const outcome = await runFootagePari({
      projectId,
      req,
      hooks: {
        mode,
        emit: emitPari,
        decide: ctl.decide,
        takeInstructions: ctl.takeInstructions,
        interpret: (text, plan) => interpretInstruction(this.providerFor(routing.choices.instruction.providerId), text, plan, routing.choices.instruction.modelId),
        ensureUnderstood: () => this.ensureUnderstood(projectId),
        plan: () => this.plan(projectId, req, plannerModel ? { model: plannerModel, providerId: plannerProviderId } : undefined),
        render: async (plan) => {
          this.d.emit({ kind: 'render', projectId, status: 'started' })
          try {
            const edit = await this.render(projectId, plan, req.prompt, (pct, phase) => this.d.emit({ kind: 'render', projectId, status: 'progress', pct, phase }))
            this.d.emit({ kind: 'render', projectId, status: 'done', edit })
            return edit
          } catch (err) {
            this.d.emit({ kind: 'render', projectId, status: err instanceof FootageCancelled ? 'cancelled' : 'failed', error: String((err as Error)?.message ?? err) })
            throw err
          }
        },
        isCancelled: () => this.cancelled
      }
    })
    const report: FootagePariReport = { ...outcome.report, modelSwitches: [...modelSwitches, ...outcome.report.modelSwitches] }
    try {
      writeFileSync(join(this.d.store.dir(projectId), 'pari-report.json'), JSON.stringify(report, null, 2))
    } catch {
      /* the report still reached the person as an event */
    }
    return report
  }

  /** the last agent report kept beside the project, if any */
  pariReport(projectId: string): FootagePariReport | null {
    try {
      const file = join(this.d.store.dir(projectId), 'pari-report.json')
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as FootagePariReport) : null
    } catch {
      return null
    }
  }

  /** what this install can do beyond editing footage */
  capabilities(): { ai: boolean } {
    return { ai: this.aiOn() }
  }

  private aiOn(): boolean {
    return Boolean(this.d.makeClip && (this.d.aiReady?.() ?? true))
  }

  posters(projectId: string): Record<string, string> {
    const p = this.project(projectId)
    const dir = this.d.store.dir(projectId)
    const out: Record<string, string> = {}
    for (const c of p.clips) {
      const f = c.shots.find((s) => s.frame)?.frame
      if (f && existsSync(join(dir, f))) out[c.id] = `data:image/jpeg;base64,${readFileSync(join(dir, f)).toString('base64')}`
    }
    return out
  }

  async render(projectId: string, plan: EditPlan, prompt: string, onProgress: (pct: number, phase: string) => void): Promise<EditRecord> {
    this.cancelled = false
    const p = this.project(projectId)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const file = join(this.d.store.editsDir(projectId), `${slug(plan.title).slice(0, 40) || 'edit'}-${plan.shape.replace(':', 'x')}-${stamp}.mp4`)
    try {
      const out = await renderPlan({
        plan,
        clips: p.clips,
        workDir: join(this.d.store.dir(projectId), 'work'),
        outFile: file,
        makeClip: this.d.makeClip,
        aiMusic: this.d.aiMusic,
        isCancelled: () => this.cancelled,
        onProgress
      })
      const edit: EditRecord = { id: randomUUID().slice(0, 8), title: plan.title, createdAt: new Date().toISOString(), prompt, shape: plan.shape, durationSec: out.durationSec || planDuration(plan), file: out.file }
      this.d.store.addEdit(projectId, edit)
      return edit
    } catch (err) {
      if (err instanceof RenderCancelled) throw new FootageCancelled()
      throw err
    }
  }
}

function emptyClip(f: { path: string; folder: string }): FootageClip {
  const st = statSync(f.path)
  return { id: clipIdFor(f.path), path: f.path, name: f.path.split(/[\\/]/).pop() ?? f.path, folder: f.folder, sizeBytes: st.size, mtimeMs: Math.round(st.mtimeMs), durationSec: 0, width: 0, height: 0, fps: 30, hasAudio: false, shots: [], watched: false, listened: false, status: 'unreadable' }
}
