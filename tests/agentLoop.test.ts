import { describe, expect, it } from 'vitest'
import type { CapabilityReport, DecisionRequest, FilmPlan, PariEvent } from '../src/shared/agentBrief'
import { readBriefByRules } from '../src/main/appRecon/agent/brief'
import { planSegment } from '../src/main/appRecon/agent/act'
import { agentFilmsPages, attachClaims, partsBudget, buildReport, clipRequests, narrationBrief, planStage, PariStopped, reviewStage, wantsProblemCard, type PariHooks } from '../src/main/appRecon/agent/loop'

const BRIEF = `create a product launch video on Taaweel starting off from clear problem statement and presenting Taaweel as a solution.  Use arabic music with vocals and duff only, no song, just arabic vocals and duff.
steps:
begin problem statement as infographic ai video and then present Taaweel's biggest feature of scientific research as a solution.
show sections of homepage: https://taaweel.snapkodex.com/
then go through the steps of research here: https://taaweel.snapkodex.com/dashboard/runs/2,
then briefly show: \`https://taaweel.snapkodex.com/dashboard/runs/2/meta\` pipeline page,
then show different features of the actual report generated \`https://taaweel.snapkodex.com/dashboard/runs/2/report\` and explain it writes an entire research paper on your question.
then tell, user can refine the research by chatting and generating perspectives,
also tell that you can upload documents to assist your research and also research on the uploaded documents.`

const input = { context: BRIEF, startUrl: 'https://taaweel.snapkodex.com/', mode: 'launch' as const }

const caps: CapabilityReport = {
  access: 'plan',
  jobs: [
    { job: 'music', configured: 'builtin:procedural', options: [
      { id: 'builtin:procedural', label: 'Built-in composer', cost: 'free', available: true, strengths: [], limits: ['instrumental only'] },
      { id: 'gemini:lyria-3.5', label: 'Google Lyria 3.5', cost: '≈ $0.08 / track', available: true, strengths: ['can sing'], limits: [] }
    ] },
    { job: 'video', configured: 'stock', options: [{ id: 'gemini:omni', label: 'Gemini clips', cost: '≈ $0.10 / s', available: true, strengths: [], limits: [] }] }
  ],
  limits: []
}

function hooks(mode: 'ask' | 'autopilot', answer: (r: DecisionRequest[]) => ReturnType<PariHooks['decide']>) {
  const events: Array<Omit<PariEvent, 'runId'>> = []
  const h: PariHooks = { mode, capabilities: caps, decide: answer, emit: (e) => events.push(e) }
  return { h, events }
}

describe('PARI loop', () => {
  const plan: FilmPlan = readBriefByRules(input)

  it('films the four pages itself and keeps the clips, problem and claims', () => {
    expect(agentFilmsPages(plan)).toBe(true)
    const clips = clipRequests(plan)
    expect(clips[0]).toMatchObject({ placement: 'start', part: 'problem' })
    expect(wantsProblemCard(plan, true)).toBe(false)
    expect(wantsProblemCard(plan, false)).toBe(true)
    expect(narrationBrief(plan)).toMatch(/research paper/i)
    expect(narrationBrief(plan)).toMatch(/upload/i)
    expect(narrationBrief(plan)).not.toMatch(/duff/i)
  })

  it('autopilot decides without waiting and says what it chose', async () => {
    const { h, events } = hooks('autopilot', async () => { throw new Error('must not ask') })
    const out = await planStage(input, { chat: null, secrets: [], say: () => undefined }, h)
    expect(events.map((e) => e.kind)).toEqual(['pari-plan', 'pari-decide'])
    expect(out.assignment.music).toBe('gemini:lyria-3.5')
  })

  it('ask mode waits for the person, and null stops the run', async () => {
    const { h } = hooks('ask', async () => null)
    await expect(planStage(input, { chat: null, secrets: [], say: () => undefined }, h)).rejects.toBeInstanceOf(PariStopped)
  })

  it('pins "tell that" claims onto the page beat before them', () => {
    const pageIds = plan.segments.filter((s) => s.kind === 'page').map((s) => s.id)
    const acted = new Map(pageIds.map((id, i) => [id, { act: { steps: [{ id: `p${i + 1}-1`, beat: i, kind: 'goto' }], beats: [{ beat: i, kind: 'page', chapter: 'x', facts: [], fallback: '' }], planned: [], notes: [] }, reached: {} as never, substituted: false, attempts: 1 }]))
    const beats = [...acted.values()].flatMap((a) => a.act.beats) as never[]
    attachClaims(plan, { beats, acted: acted as never })
    const own = acted.get(pageIds.at(-1)!)!.act as { beats: Array<{ facts: string[]; long?: boolean }>; steps: Array<{ kind: string }> }
    // each point is its own short beat on that page, with a hold step, never one long beat
    expect(own.beats.length).toBe(3)
    expect(own.beats.some((b) => b.long)).toBe(false)
    expect(own.beats[1].facts.join(' ')).toMatch(/perspectives/i)
    expect(own.beats[2].facts.join(' ')).toMatch(/upload/i)
    expect(own.steps.filter((s) => s.kind === 'wait').length).toBe(2)
  })

  it('reports every check that is not done, in plain words', () => {
    const r = buildReport(plan, null, [{ segment: plan.segments[1].id, status: 'missed', evidence: [], note: 'the page is behind a sign-in wall', attempts: 2 }])
    expect(r.shortfalls[0]).toMatch(/Not done/)
    expect(r.shortfalls[0]).toMatch(/sign-in wall/)
  })

  it('keeps the film to its length: steps get the bigger share, at least two parts each', () => {
    const b = partsBudget(plan, 44)
    const pages = plan.segments.filter((s) => s.kind === 'page')
    const steps = pages.find((p) => p.kind === 'page' && p.how === 'steps')!
    const tour = pages.find((p) => p.kind === 'page' && p.how === 'tour')!
    expect(b.get(steps.id)!).toBeGreaterThan(b.get(tour.id)!)
    expect([...b.values()].reduce((a, x) => a + x, 0)).toBeLessThanOrEqual(12)
    expect(Math.min(...b.values())).toBeGreaterThanOrEqual(2)
  })

  it('shows the first, last and evenly spread stages when there are too many', () => {
    const seg = plan.segments.find((s) => s.kind === 'page' && s.how === 'steps') as never
    const sections = Array.from({ length: 10 }, (_, i) => ({ label: `Stage ${i + 1}`, selector: `#s${i}`, kind: 'stage' as const }))
    const page = { url: 'https://taaweel.snapkodex.com/dashboard/runs/2', title: 'Run', headings: ['Run #2'], controls: [], fields: [], notices: [], sections } as never
    const act = planSegment(seg, page, { startBeat: 1, idPrefix: 'p2-', maxParts: 4 })
    expect(act.planned.map((p) => p.label)).toEqual(['Stage 1', 'Stage 4', 'Stage 7', 'Stage 10'])
    expect(act.notes.join(' ')).toMatch(/4 of the 10 stages/)
  })
})

describe('reviewing a film made from typed steps', () => {
  const page = { id: 's1', kind: 'page', said: '1. open: https://x.test/a#circle\n2. select Surah An-Nur', required: true, how: 'script', emphasis: 'normal', url: 'https://x.test/a' } as const
  const plan = { goal: '', kind: 'walkthrough', segments: [page, { id: 's2', kind: 'narration', said: 'provide a conclusion statement and add CTA', required: true, claims: ['provide a conclusion statement', 'add call to action'], over: 'find' }], music: { none: false, description: '', vocals: 'any', instruments: [], exclude: [], ambience: [], quiet: false }, voice: {}, look: { style: null, noAbstract: false }, unplaced: [], source: 'ai' } as unknown as FilmPlan
  const lines = ['The circle shows the verses.', 'Switching to An-Nur.', 'Taaweel is ready for your own research. Try it today.']

  it('counts a page the exact-steps run filmed as done, not as not attempted', () => {
    const checks = reviewStage({ plan, acted: null, take: null, clipsMade: new Map(), lines, problemDrawn: false, scripted: { said: ['open: https://x.test/a#circle', 'select Surah An-Nur'], actions: 5, choices: 1 } })
    expect(checks[0].status).toBe('done')
    expect(checks[0].evidence.join(' ')).toMatch(/dropdown choice/)
    expect(buildReport(plan, null, checks).shortfalls).toEqual([])
  })

  it('still says so when the steps were not run at all', () => {
    const checks = reviewStage({ plan, acted: null, take: null, clipsMade: new Map(), lines, problemDrawn: false })
    expect(checks[0].status).toBe('skipped')
  })

  it('meets "a conclusion" and "a call to action" with the closing words of the film', () => {
    const checks = reviewStage({ plan, acted: null, take: null, clipsMade: new Map(), lines, problemDrawn: false, scripted: { said: [], actions: 0, choices: 0 } })
    expect(checks[1].status).toBe('done')
    const none = reviewStage({ plan, acted: null, take: null, clipsMade: new Map(), lines: ['The circle shows the verses.'], problemDrawn: false })
    expect(none[1].status).not.toBe('done')
  })
})
