import { EditPlan } from '@shared/footage'
import type { DecisionAnswer, DecisionRequest } from '@shared/agentBrief'
import type { EditRecord, FootageCheck, FootagePariHooks, FootagePariOutcome, FootagePariReport, PlanRequest } from '@shared/footage'
import { MAX_ATTEMPTS, buildChecks, nextMove } from './review'

/**
 * PARI — Plan, Act, Review, Iterate — for footage projects ("make me a 30s
 * short about the beach trip").
 *
 *   PLAN      make sure the footage is understood, then plan the edit (the
 *             first short only when several were asked for)
 *   ACT       render the plan; on failure retry, substitute (drop the AI-made
 *             scenes) or put it to the person
 *   REVIEW    check the finished edit against the plan
 *   REPORT    the honest end-of-run report
 *
 * Every stage starts by stopping when cancelled and taking whatever the person
 * typed mid-run. The loop itself is pure: disk, ffmpeg and models all live
 * behind FootagePariHooks.
 */

export class FootageStopped extends Error {}

export async function runFootagePari(input: { projectId: string; req: PlanRequest; hooks: FootagePariHooks }): Promise<FootagePariOutcome> {
  const { projectId, req, hooks } = input

  const instructions: Array<{ text: string; reply: string }> = []
  const checks: FootageCheck[] = [] // one per failed render attempt, then the review's
  const shortfalls: string[] = []
  /** instructions that arrived before any plan existed to change */
  const pending: string[] = []
  let plan: EditPlan | undefined
  let edit: EditRecord | undefined

  const buildReport = (): FootagePariReport => ({
    title: plan?.title ?? (req.prompt.trim().slice(0, 90) || 'Your edit'),
    prompt: req.prompt,
    createdAt: new Date().toISOString(),
    checks: checks,
    shortfalls: [...(plan?.notes ?? []), ...shortfalls],
    modelSwitches: [],
    instructions,
    ...(edit ? { edit } : {})
  })

  /** answers for these requests: the person's in 'ask' mode, the autopicks on autopilot (always shown) */
  async function settle(requests: DecisionRequest[]): Promise<DecisionAnswer[]> {
    hooks.emit({ kind: 'pari-decide', projectId, requests, auto: hooks.mode === 'autopilot' })
    if (hooks.mode === 'autopilot') return requests.map((r) => ({ id: r.id, option: r.autopick, auto: true }))
    const answers = await hooks.decide(requests)
    if (!answers) throw new FootageStopped('You stopped the run.')
    return answers
  }

  /** one instruction: interpreted, answered with a note, its plan kept */
  async function drainTexts(texts: string[], current: EditPlan): Promise<EditPlan> {
    let p = current
    for (const text of texts) {
      const r = await hooks.interpret(text, p)
      instructions.push({ text, reply: r.reply })
      hooks.emit({ kind: 'pari-note', projectId, text: `💬 ${r.reply}` })
      p = r.plan
    }
    return p
  }

  /** every stage boundary: stop when cancelled, then take the person's mid-run instructions */
  async function beginStage(current: EditPlan): Promise<EditPlan> {
    if (hooks.isCancelled()) throw new FootageStopped('You stopped the run.')
    const texts = hooks.takeInstructions()
    return texts.length ? await drainTexts(texts, current) : current
  }

  /** the run's first boundary: no plan exists yet, so instructions wait for one */
  async function beginRun(): Promise<void> {
    if (hooks.isCancelled()) throw new FootageStopped('You stopped the run.')
    pending.push(...hooks.takeInstructions())
  }

  /** a file the plan points at is gone: only the person knows whether to check the folder or stop */
  async function askMissingFile(m: string, attempts: number): Promise<boolean> {
    const request: DecisionRequest = {
      id: 'rescan',
      topic: 'misalignment',
      question: 'A video file in this edit is missing. Stop, or make the edit without it?',
      context: `A file the plan points at can no longer be opened: ${m.slice(0, 200)}`,
      options: [
        { id: 'retry', label: 'Try once more', detail: 'Making the video is tried again after you check the folder (or re-scan it).' },
        { id: 'stop', label: 'Stop', detail: 'Nothing is rendered. Re-scan the folder, then ask again.' }
      ],
      autopick: 'stop'
    }
    for (;;) {
      const [a] = await settle([request])
      if (!a || a.option !== 'retry') return false
      if (attempts <= MAX_ATTEMPTS + 1) return true
      // the try budget is spent and the person still said retry: put it to them once more
    }
  }

  try {
    // ---------------------------------------------------------------- PLAN
    await beginRun()
    const understood = await hooks.ensureUnderstood()
    if (!understood.ok) {
      const reason = understood.reason?.trim() || 'the footage could not be read'
      hooks.emit({ kind: 'pari-note', projectId, text: reason.slice(0, 300) })
      shortfalls.push(reason)
      return { report: buildReport(), stopped: true }
    }
    const result = await hooks.plan()
    plan = result.plan
    if (result.shorts && result.shorts.length > 1) shortfalls.push(`This run made short 1 of ${result.shorts.length}; ask again for the others`)
    hooks.emit({ kind: 'pari-plan', projectId, plan, source: result.source, prompt: req.prompt })
    if (pending.length) plan = await drainTexts(pending.splice(0), plan) // instructions that waited for a plan

    // ---------------------------------------------------------------- ACT
    plan = await beginStage(plan)
    let attempts = 0
    for (;;) {
      attempts++
      try {
        edit = await hooks.render(plan)
        break
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        if (hooks.isCancelled()) throw new FootageStopped('You stopped the run.')
        checks.push({ id: `render-attempt-${attempts}`, label: 'Making the video', status: 'missed', evidence: [m.slice(0, 160)], note: '', attempts })

        // a file the plan points at was moved or deleted
        if (/moved or deleted/i.test(m)) {
          const retry = await askMissingFile(m, attempts)
          if (!retry) throw new FootageStopped('A video file in this edit is missing, and you chose to stop.')
          continue
        }

        // AI-made scenes failed: the edit can still be cut from the real footage
        const hadAi = plan.segments.some((s) => s.ai)
        if ((/AI scene/i.test(m) || hadAi) && attempts <= MAX_ATTEMPTS + 1) {
          const kept = plan.segments.filter((s) => !s.ai)
          if (kept.length >= 1) {
            plan = EditPlan.parse({ ...plan, segments: kept })
            checks.at(-1)!.status = 'substituted'
            if (hadAi) shortfalls.push('The AI-made scenes were dropped after they could not be made; the edit is cut from the real footage only.')
            continue
          }
          // nothing but AI scenes in the plan: nothing can be rendered
          shortfalls.push('Nothing was left to make: every scene in the plan was an AI-made scene.')
          const [a] = await settle([
            {
              id: 'ai-scenes-failed',
              topic: 'misalignment',
              question: 'Every scene in this edit is an AI-made scene, and they could not be made. Stop?',
              context: `The plan "${plan.title}" has ${plan.segments.length} scenes, all AI-made. The error was: ${m.slice(0, 200)}`,
              options: [
                { id: 'stop', label: 'Stop', detail: 'Nothing is rendered. The report says why the scenes failed.' },
                { id: 'go-on', label: 'Go on without them', detail: 'There is no real footage in the plan, so the run still ends — the report records that you chose this.' }
              ],
              autopick: 'stop'
            }
          ])
          throw new FootageStopped(a?.option === 'go-on' ? 'Every scene was an AI-made scene and they could not be made.' : 'You chose to stop: the AI-made scenes could not be made.')
        }

        // anything else: retry once, then put it to the person
        if (nextMove(true, attempts, true) === 'retry') continue
        const [a] = await settle([
          {
            id: 'render-failed',
            topic: 'misalignment',
            question: `The video could not be made (${m.slice(0, 120)}). Try once more or stop?`,
            context: `The plan "${plan.title}" was made, but making the video failed ${attempts} time${attempts === 1 ? '' : 's'}.`,
            options: [
              { id: 'retry', label: 'Try once more', detail: 'Making the video is attempted again; every failed try is in the report.' },
              { id: 'stop', label: 'Stop', detail: 'Nothing more is spent. The report says what failed.' }
            ],
            autopick: 'stop'
          }
        ])
        if (!a || a.option === 'stop') {
          shortfalls.push(m)
          throw new FootageStopped('The video could not be made.')
        }
        continue
      }
    }
    if (!edit) throw new Error('the render loop always sets an edit or throws')

    // ---------------------------------------------------------------- REVIEW
    plan = await beginStage(plan)
    const reviewChecks = buildChecks({ plan, edit, renderNotes: [] })
    checks.push(...reviewChecks)
    for (const check of reviewChecks) hooks.emit({ kind: 'pari-check', projectId, check })

    // ---------------------------------------------------------------- REPORT
    await beginStage(plan)
    const report = buildReport()
    hooks.emit({ kind: 'pari-report', projectId, report })
    return { report, stopped: false }
  } catch (err) {
    if (!(err instanceof FootageStopped)) throw err
    shortfalls.push('Stopped.')
    return { report: buildReport(), stopped: true }
  }
}
