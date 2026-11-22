import { describe, expect, it } from 'vitest'
import type { DecisionRequest } from '../src/shared/agentBrief'
import type { EditPlan, EditRecord, FootagePariEvent, FootagePariHooks, PlanRequest } from '../src/shared/footage'
import { runFootagePari } from '../src/main/footage/agent/loop'
import { interpretInstruction } from '../src/main/footage/agent/instruct'
import { MAX_ATTEMPTS, buildChecks, nextMove } from '../src/main/footage/agent/review'
import type { LLMProvider } from '../src/main/providers/types'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 12s once planDuration runs: 4s + 3s (ai) + 5s, no fades */
const basePlan: EditPlan = {
  title: 'Beach day',
  shape: '9:16',
  reframe: 'auto',
  segments: [
    { clipId: 'clip-1', startSec: 0, endSec: 4, speed: 1, keepAudio: true, transition: 'cut', why: 'arriving' },
    { clipId: 'ai-1', startSec: 0, endSec: 3, speed: 1, keepAudio: true, transition: 'cut', why: 'waves', ai: { prompt: 'waves crashing on rocks at sunset' } },
    { clipId: 'clip-2', startSec: 10, endSec: 15, speed: 1, keepAudio: true, transition: 'cut', why: 'walking home' }
  ],
  music: { mode: 'auto', mood: 'upbeat' },
  loudness: 'social',
  fadeInOut: true,
  captions: 'off',
  titles: [],
  overlays: [{ id: 'ov1', effect: 'lowerThird', startSec: 0, endSec: 2, params: { name: 'Maya' }, why: 'who is speaking' }],
  notes: []
}

const editRecord: EditRecord = { id: 'edit-1', title: 'Beach day', createdAt: '2026-11-22T10:00:00.000Z', prompt: 'a 12 second beach short', shape: '9:16', durationSec: 12, file: 'D:/out/beach.mp4' }

const req: PlanRequest = { prompt: 'a 12 second beach short', shape: '9:16', music: 'auto-mood' }

function makeHooks(over: Partial<FootagePariHooks> = {}) {
  const events: FootagePariEvent[] = []
  const queue: string[] = []
  const hooks: FootagePariHooks = {
    mode: 'ask',
    emit: (e) => { events.push(e) },
    decide: async () => null,
    takeInstructions: () => queue.splice(0),
    interpret: async (text, plan) => ({ reply: `noted: ${text}`, plan }),
    ensureUnderstood: async () => ({ ok: true }),
    plan: async () => ({ plan: clone(basePlan), source: 'ai', thumbs: [] }),
    render: async () => clone(editRecord),
    isCancelled: () => false,
    ...over
  }
  return { hooks, events, queue }
}

describe('runFootagePari', () => {
  it('runs plan → checks → report and finishes with the edit', async () => {
    const { hooks, events } = makeHooks()
    const out = await runFootagePari({ projectId: 'p1', req, hooks })
    expect(out.stopped).toBe(false)
    expect(out.report.edit).toEqual(editRecord)
    expect(out.report.title).toBe('Beach day')
    expect(out.report.instructions).toEqual([])
    expect(out.report.modelSwitches).toEqual([])
    expect(events.map((e) => e.kind)).toEqual(['pari-plan', ...Array(6).fill('pari-check'), 'pari-report'])
    expect(events.every((e) => e.projectId === 'p1')).toBe(true)
    const byId = new Map(out.report.checks.map((c) => [c.id, c.status]))
    expect(byId.get('length')).toBe('done')
    expect(byId.get('segments')).toBe('done')
    expect(byId.get('overlays')).toBe('done')
    expect(byId.get('music')).toBe('done')
    expect(byId.get('fixes')).toBe('skipped')
    expect(byId.get('captions')).toBe('skipped')
    const reportEvent = events.at(-1)!
    expect(reportEvent.kind).toBe('pari-report')
    expect(reportEvent.kind === 'pari-report' && reportEvent.report).toEqual(out.report)
  })

  it('takes a midway instruction, answers with a note, and renders the changed plan', async () => {
    const { hooks, events, queue } = makeHooks({ interpret: async (_t, p) => ({ reply: 'made it shorter', plan: { ...p, title: 'Beach day (short)' } }) })
    queue.push('make it shorter')
    const rendered: string[] = []
    hooks.render = async (p) => { rendered.push(p.title); return clone(editRecord) }
    const out = await runFootagePari({ projectId: 'p1', req, hooks })
    expect(events.map((e) => e.kind)).toEqual(['pari-plan', 'pari-note', ...Array(6).fill('pari-check'), 'pari-report'])
    const note = events[1]
    expect(note.kind === 'pari-note' && note.text).toBe('💬 made it shorter')
    expect(out.report.instructions).toEqual([{ text: 'make it shorter', reply: 'made it shorter' }])
    expect(rendered).toEqual(['Beach day (short)'])
    expect(out.report.title).toBe('Beach day (short)')
  })

  it('stops the run when the person answers a question with null', async () => {
    let renderCalls = 0
    const { hooks } = makeHooks({
      render: async () => { renderCalls++; throw new Error('D:/footage/a.mp4 was moved or deleted') },
      decide: async () => null
    })
    const out = await runFootagePari({ projectId: 'p1', req, hooks })
    expect(out.stopped).toBe(true)
    expect(out.report.edit).toBeUndefined()
    expect(renderCalls).toBe(1) // never tried again after the null
    expect(out.report.shortfalls.join(' ')).toMatch(/Stopped/)
  })

  it("drops the AI scenes after they fail and finishes on the next try, with a substituted check", async () => {
    let renderCalls = 0
    const seen: EditPlan[] = []
    const { hooks, events } = makeHooks({
      render: async (p) => {
        seen.push(p)
        renderCalls++
        if (renderCalls < 3) throw new Error('AI scene 2 could not be generated')
        return clone(editRecord)
      }
    })
    const out = await runFootagePari({ projectId: 'p1', req, hooks })
    expect(out.stopped).toBe(false)
    expect(renderCalls).toBe(3)
    expect(seen[0].segments.some((s) => s.ai)).toBe(true)
    expect(seen[1].segments.every((s) => !s.ai)).toBe(true)
    const attemptChecks = out.report.checks.filter((c) => /^render-attempt-/.test(c.id))
    expect(attemptChecks.map((c) => c.status)).toEqual(['substituted', 'substituted'])
    expect(attemptChecks.every((c) => c.label === 'Making the video')).toBe(true)
    expect(out.report.shortfalls.join(' ')).toMatch(/AI-made scenes/)
    expect(events.filter((e) => e.kind === 'pari-decide')).toHaveLength(0) // substituted without asking
  })

  it("asks about a missing video file and stops on the person's answer", async () => {
    const asked: DecisionRequest[] = []
    const { hooks, events } = makeHooks({
      render: async () => { throw new Error('D:/footage/a.mp4 was moved or deleted') },
      decide: async (rs) => { asked.push(...rs); return rs.map((r) => ({ id: r.id, option: 'stop', auto: false })) }
    })
    const out = await runFootagePari({ projectId: 'p1', req, hooks })
    expect(out.stopped).toBe(true)
    expect(asked).toHaveLength(1)
    expect(asked[0].id).toBe('rescan')
    expect(asked[0].autopick).toBe('stop')
    expect(asked[0].options.map((o) => o.id)).toEqual(['retry', 'stop'])
    expect(events.some((e) => e.kind === 'pari-decide')).toBe(true)
    expect(out.report.checks.map((c) => c.id)).toContain('render-attempt-1')
    expect(out.report.checks.find((c) => c.id === 'render-attempt-1')!.status).toBe('missed')
  })

  it('stops before planning when the run was cancelled', async () => {
    let planned = 0
    const { hooks, events } = makeHooks({
      isCancelled: () => true,
      plan: async () => { planned++; return { plan: clone(basePlan), source: 'basic', thumbs: [] } }
    })
    const out = await runFootagePari({ projectId: 'p1', req, hooks })
    expect(out.stopped).toBe(true)
    expect(planned).toBe(0)
    expect(events).toEqual([])
    expect(out.report.shortfalls).toEqual(['Stopped.'])
    expect(out.report.checks).toEqual([])
  })

  it('reports the reason and stops when the footage could not be understood', async () => {
    const { hooks, events } = makeHooks({ ensureUnderstood: async () => ({ ok: false, reason: 'no videos have been indexed yet' }) })
    const out = await runFootagePari({ projectId: 'p1', req, hooks })
    expect(out.stopped).toBe(true)
    expect(out.report.shortfalls).toEqual(['no videos have been indexed yet'])
    expect(events.map((e) => e.kind)).toEqual(['pari-note'])
    expect(events[0].kind === 'pari-note' && events[0].text).toBe('no videos have been indexed yet')
  })
})

describe('interpretInstruction', () => {
  const stubProvider = (raw: unknown): LLMProvider => ({
    id: 'mock', label: 'Mock', isConfigured: async () => true, listModels: async () => [],
    generateJSON: async () => raw as never, generateText: async () => ''
  })

  it("applies the model's answer defensively onto a copy of the plan", async () => {
    const provider = stubProvider({ reply: 'Done — the music is off and the first part is cut.', dropSegments: [0, 99], musicMode: 'none', shorten: 20 })
    const { reply, plan } = await interpretInstruction(provider, 'no music, drop the first bit, shorter', clone(basePlan))
    expect(reply).toMatch(/music is off/)
    expect(plan.music.mode).toBe('none')
    expect(plan.segments.map((s) => s.clipId)).toEqual(['ai-1', 'clip-2']) // 0 dropped, 99 ignored
    expect(plan.segments[1].endSec - plan.segments[1].startSec).toBeCloseTo(4, 3) // 5s x 0.8
    expect(plan.segments[0].endSec - plan.segments[0].startSec).toBe(3) // the ai part is not shortened
  })

  it('falls back to the keyword rules when the provider fails', async () => {
    const { reply, plan } = await interpretInstruction(stubProvider(undefined), 'no music please', clone(basePlan))
    expect(plan.music.mode).toBe('none')
    expect(reply).toMatch(/music is off/)
  })

  it('shortens by 15% on "faster" or "shorter", keeping at least 0.6s per part', async () => {
    const { plan } = await interpretInstruction(null, 'make it a bit faster', clone(basePlan))
    expect(plan.segments[0].endSec - plan.segments[0].startSec).toBeCloseTo(3.4, 3) // 4s x 0.85
    expect(plan.segments[0].startSec).toBe(0)
  })

  it('asks for a rephrase when nothing is recognized, leaving the plan alone', async () => {
    const plan = clone(basePlan)
    const { reply, plan: after } = await interpretInstruction(null, 'make it pop', plan)
    expect(after).toBe(plan)
    expect(reply).toMatch(/another way/)
  })
})

describe('buildChecks and nextMove', () => {
  it("marks a wrong-length video partial and carries the renderer's notes", () => {
    const checks = buildChecks({
      plan: clone(basePlan),
      edit: { ...clone(editRecord), durationSec: 8 },
      renderNotes: ['the overlay was left out: not enough contrast', 'the music fell back to the built-in score']
    })
    const byId = new Map(checks.map((c) => [c.id, c]))
    expect(byId.get('length')!.status).toBe('partial')
    expect(byId.get('length')!.evidence.join(' ')).toMatch(/12s/)
    expect(byId.get('length')!.evidence.join(' ')).toMatch(/8s/)
    expect(byId.get('overlays')!.status).toBe('partial')
    expect(byId.get('overlays')!.note).toMatch(/overlay was left out/)
    expect(byId.get('music')!.status).toBe('partial')
    expect(byId.get('music')!.note).toMatch(/built-in/)
  })

  it('counts planned shot fixes and skips captions when off', () => {
    const plan = clone(basePlan)
    plan.segments[0].fixes = { exposure: 0.4, stabilize: true }
    const checks = buildChecks({ plan, edit: clone(editRecord), renderNotes: [] })
    const byId = new Map(checks.map((c) => [c.id, c]))
    expect(byId.get('fixes')!.status).toBe('done')
    expect(byId.get('fixes')!.evidence[0]).toMatch(/1 shot fix/)
    expect(byId.get('captions')!.status).toBe('skipped')
  })

  it('retries until MAX_ATTEMPTS, then asks when required and substitutes otherwise', () => {
    expect(MAX_ATTEMPTS).toBe(2)
    expect(nextMove(false, 1, true)).toBe('accept')
    expect(nextMove(true, 1, true)).toBe('retry')
    expect(nextMove(true, 2, true)).toBe('ask')
    expect(nextMove(true, 2, false)).toBe('substitute')
  })
})
