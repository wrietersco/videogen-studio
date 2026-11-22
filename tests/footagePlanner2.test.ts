import { describe, expect, it } from 'vitest'
import { EditPlan, type FootageBrief, type FootageClip, type PlanRequest } from '../src/shared/footage'
import { OVERLAY_REQUIRED_PARAMS, buildCatalog, coverageNotes, planEdit, planShorts, sanitize, sanitizeOverlays } from '../src/main/footage/planner'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

const clip = (over: Partial<FootageClip> & { id: string }): FootageClip => ({
  path: `C:/v/${over.id}.mp4`, name: `${over.id}.mp4`, folder: 'C:/v', sizeBytes: 1, mtimeMs: 1, durationSec: 100, width: 1920, height: 1080, fps: 30, hasAudio: true, lufs: -23,
  shots: [], watched: true, listened: true, status: 'ok', ...over
})
const model = (reply: () => unknown, asked: GenerateJSONRequest[] = []): LLMProvider => ({
  id: 'openai', label: 'fake', isConfigured: async () => true, listModels: async () => [], generateText: async () => '',
  generateJSON: async <T,>(r: GenerateJSONRequest) => { asked.push(r); return reply() as T }
})

const refs = new Map([['c1', clip({ id: 'one' })]])
const base = { title: 'x', music: 'auto' as const, musicMood: 'upbeat', titles: [], notes: [] }
const req: PlanRequest = { prompt: 'x', shape: '9:16', music: 'auto-mood' }
const brief: FootageBrief = { focus: ['grandma'], avoid: ['the harbour'], references: 'Grandma June, beekeeper since 1962.', referenceFiles: ['notes.md'] }

describe('planner v2: per-segment fixes', () => {
  it('clamps fixes to -1..1 and drops values that are basically zero', () => {
    const plan = sanitize({ ...base, segments: [{ clip: 'c1', start: 0, end: 4, fixes: { exposure: 4, contrast: 0.01, warmth: -3, stabilize: true } }] }, refs, req)
    expect(plan.segments[0].fixes).toEqual({ exposure: 1, warmth: -1, stabilize: true })
  })

  it('drops fixes entirely when nothing survives the clamp', () => {
    const plan = sanitize({ ...base, segments: [{ clip: 'c1', start: 0, end: 4, fixes: { contrast: 0.001, stabilize: false } }] }, refs, req)
    expect(plan.segments[0].fixes).toBeUndefined()
  })

  it('never puts fixes (or stabilize) on AI-made scenes', () => {
    const plan = sanitize({ ...base, segments: [{ aiPrompt: 'waves at dawn', aiSec: 4, fixes: { stabilize: true, exposure: 0.5 } }] }, refs, { ...req, aiClips: true })
    expect(plan.segments[0]).toMatchObject({ clipId: 'ai-1' })
    expect(plan.segments[0].fixes).toBeUndefined()
  })
})

describe('planner v2: overlays', () => {
  const segs = [{ clip: 'c1', start: 0, end: 10 }]

  it('keeps only known effects with their required params, clamped inside the video', () => {
    const plan = sanitize(
      {
        ...base,
        segments: segs,
        overlays: [
          { effect: 'lowerThird', at: 0.5, dur: 3, params: { name: 'Ada Lovelace', role: 'engineer' }, why: 'first speech' },
          { effect: 'sparkles', at: 1, dur: 2, params: { x: 1 } },
          { effect: 'statChip', at: 2, dur: 2, params: { stat: '40%' } },
          { effect: 'quoteBand', at: -5, dur: 20, params: { text: 'you have to see it' } },
          { effect: 'chapterTitle', at: 9.5, dur: 3, params: { text: 'later' } }
        ]
      },
      refs,
      { ...req, overlays: true }
    )
    expect(plan.overlays.map((o) => o.effect)).toEqual(['quoteBand', 'lowerThird'])
    expect(plan.overlays[0]).toMatchObject({ id: 'ov-1', startSec: 0, endSec: 10 })
    expect(plan.overlays[1]).toMatchObject({ id: 'ov-2', startSec: 0.5, endSec: 3.5, why: 'first speech' })
    expect(plan.overlays[1].params).toEqual({ name: 'Ada Lovelace', role: 'engineer' })
  })

  it('keeps at most six overlays, and none when the request did not allow them', () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ effect: 'emotionAccent', at: i * 0.5, dur: 1.5, params: { emotion: 'joy' } }))
    const plan = sanitize({ ...base, segments: segs, overlays: eight }, refs, { ...req, overlays: true })
    expect(plan.overlays).toHaveLength(6)
    expect(plan.overlays.map((o) => o.id)).toEqual(['ov-1', 'ov-2', 'ov-3', 'ov-4', 'ov-5', 'ov-6'])
    expect(sanitize({ ...base, segments: segs, overlays: eight }, refs, req).overlays).toEqual([])
  })

  it('keeps only string and number params, strings cut at 160 chars', () => {
    const one = sanitizeOverlays([{ effect: 'refCard', at: 0, dur: 2, params: { title: 'Fact', text: 'x'.repeat(400), junk: { deep: true }, nul: null } }], 10, true)
    expect(one).toHaveLength(1)
    expect(one[0].params).toEqual({ title: 'Fact', text: 'x'.repeat(160) })
    expect(OVERLAY_REQUIRED_PARAMS).toMatchObject({ lowerThird: ['name'], refCard: ['title', 'text'], chapterTitle: ['text'], quoteBand: ['text'], statChip: ['stat', 'label'], emotionAccent: ['emotion'] })
  })
})

describe('planner v2: lyra music', () => {
  const segs = [{ clip: 'c1', start: 0, end: 10 }]
  const withLyra = { ...base, music: 'lyra' as const, musicMood: 'cinematic', musicStyleBrief: '  Soft piano, slow, hopeful.  ' }

  it('maps lyra to a real choice only when AI music was allowed', () => {
    const off = sanitize({ ...withLyra, segments: segs }, refs, req)
    expect(off.music).toMatchObject({ mode: 'auto', mood: 'cinematic' })
    expect(off.music.styleBrief).toBeUndefined()
    const on = sanitize({ ...withLyra, segments: segs }, refs, req, { aiMusic: true })
    expect(on.music).toEqual({ mode: 'lyra', mood: 'cinematic', styleBrief: 'Soft piano, slow, hopeful.' })
  })

  it('tells the model what is allowed, and threads the brief into the prompt', async () => {
    const asked: GenerateJSONRequest[] = []
    const c = [clip({ id: 'one' })]
    const good = await planEdit(model(() => ({ segments: [{ clip: 'c1', start: 0, end: 4 }] }), asked), c, { ...req, overlays: true }, { brief, aiMusic: true })
    await planEdit(model(() => ({ segments: [{ clip: 'c1', start: 0, end: 4 }] }), asked), c, req)
    const a = JSON.parse(asked[0].prompt)
    expect(a.focusOn).toEqual(['grandma'])
    expect(a.avoid).toEqual(['the harbour'])
    expect(a.references).toContain('Grandma June')
    expect(a.references).toContain('notes.md')
    expect(a.overlays).toBe('allowed')
    expect(a.aiMusic).toBe('allowed (costs about $0.08)')
    const b = JSON.parse(asked[1].prompt)
    expect(b.overlays).toBe('not allowed')
    expect(b.aiMusic).toBe('not allowed')
    expect(b.focusOn).toBe('none')
    // honesty pass: the footage never shows grandma, and the plan says so
    expect(good.plan.notes.some((n) => n.includes('could not find') && n.includes('grandma'))).toBe(true)
  })
})

describe('planner v2: coverage notes', () => {
  const people = clip({
    id: 'fam',
    durationSec: 20,
    cast: [{ id: 'p1', appearance: 'grandma in a red coat', sightings: 3 }],
    shots: [
      { startSec: 0, endSec: 10, score: 8, description: 'a dog runs across the lawn', tags: ['garden'], objects: ['stick'] },
      { startSec: 10, endSec: 20, score: 7, description: 'quiet tea at the table', talkingVisible: true, castIds: ['p1'], objects: ['teapot'] }
    ]
  })
  const withFocus = (focus: string[]): FootageBrief => ({ focus, avoid: [], references: '', referenceFiles: [] })

  it('says plainly when a focus entry never appears in the kept shots', () => {
    const tea = EditPlan.parse({ segments: [{ clipId: 'fam', startSec: 10, endSec: 20 }] })
    // grandma is visible in the kept shot; the dog only appears in the dropped one; the repeat is deduped
    expect(coverageNotes(tea, withFocus(['grandma', 'the dog', 'grandma']), [people])).toEqual(['I could not find “the dog” in this footage.'])
    const whole = EditPlan.parse({ segments: [{ clipId: 'fam', startSec: 0, endSec: 20 }] })
    expect(coverageNotes(whole, withFocus(['the dog', 'garden', 'stick']), [people])).toEqual([])
  })

  it('matches focus entries by token as well as by substring, and skips when there is nothing to check', () => {
    const tea = EditPlan.parse({ segments: [{ clipId: 'fam', startSec: 10, endSec: 20 }] })
    expect(coverageNotes(tea, withFocus(['coat red']), [people])).toEqual([])
    expect(coverageNotes(tea, undefined, [people])).toEqual([])
    expect(coverageNotes(tea, withFocus([]), [people])).toEqual([])
  })
})

describe('planner v2: catalog', () => {
  const rich = clip({
    id: 'rich',
    durationSec: 60,
    topic: 'a day at the cabin',
    cast: [{ id: 'p1', appearance: 'man in a red jacket', sightings: 4 }],
    longPauses: [{ startSec: 20, endSec: 26 }],
    offscreenSpeech: [{ startSec: 30, endSec: 34 }],
    shots: [
      { startSec: 0, endSec: 10, score: 7, description: 'arriving', defects: ['shaky', 'tooDark'], people: 2, talkingVisible: true, emotion: ['joy'], objects: ['boat'], topic: 'arriving by boat', castIds: ['p1'] },
      { startSec: 10, endSec: 20, score: 6, description: 'calm water' }
    ],
    transcript: [{ startSec: 1, endSec: 4, text: 'hello' }]
  })

  it('describes defects, cast, talking and topics, and carries the brief', () => {
    const cat = buildCatalog([rich], 110_000, brief)
    const row = cat.clips[0] as Record<string, unknown>
    expect(row.topic).toBe('a day at the cabin')
    expect(row.cast).toEqual([['p1', 'man in a red jacket']])
    expect(row.pauses).toEqual([[20, 26]])
    expect(row.offSpeech).toEqual([[30, 34]])
    const shots = row.shots as unknown[][]
    expect(shots[0][4]).toEqual({ d: ['shaky', 'tooDark'], n: 2, talk: 1, e: ['joy'], o: ['boat'], topic: 'arriving by boat', cast: ['p1'] })
    expect(shots[1]).toEqual([10, 20, 6, 'calm water'])
    expect(cat.briefBlock).toMatchObject({ focus: ['grandma'], avoid: ['the harbour'] })
    expect(cat.briefBlock!.references).toContain('Grandma June')
    expect(cat.briefBlock!.referenceFiles).toEqual(['notes.md'])
    // without a brief there is no brief block, but the rich rows remain
    const plain = buildCatalog([rich])
    expect(plain.briefBlock).toBeUndefined()
    expect((plain.clips[0] as Record<string, unknown>).cast).toEqual([['p1', 'man in a red jacket']])
  })

  it('digests long references down to the first 2000 chars', () => {
    const wordy: FootageBrief = { focus: [], avoid: [], references: 'y'.repeat(3000), referenceFiles: [] }
    expect(buildCatalog([rich], 110_000, wordy).briefBlock!.references).toHaveLength(2000)
  })

  it('strips the optional extras before dropping whole shots when the budget is tight', () => {
    const many = Array.from({ length: 300 }, (_, i) =>
      clip({
        id: `m${i}`,
        topic: 'topic',
        cast: [{ id: 'p1', appearance: 'someone', sightings: 1 }],
        longPauses: [{ startSec: 1, endSec: 2 }],
        offscreenSpeech: [{ startSec: 3, endSec: 4 }],
        shots: Array.from({ length: 10 }, (_, k) => ({
          startSec: k * 5, endSec: k * 5 + 5, score: 5 + (k % 4), description: 'a moderately long description of the shot',
          defects: ['shaky' as const], objects: ['o1'], emotion: ['joy'], castIds: ['p1'], people: 2, talkingVisible: true, topic: 't'
        }))
      })
    )
    const small = buildCatalog(many, 30_000)
    const text = JSON.stringify(small.clips)
    expect(small.trimmedNote).toBeTruthy()
    expect(text).not.toContain('"d"')
    expect(text).not.toContain('"cast"')
    expect(text).not.toContain('"topic"')
    expect(text.length).toBeLessThan(60_000)
  })
})

describe('planner v2: shorts', () => {
  it('threads the brief into shorts planning and keeps shorts overlay-free', async () => {
    const asked: GenerateJSONRequest[] = []
    const talk = clip({ id: 'talk', durationSec: 600, shots: Array.from({ length: 12 }, (_, i) => ({ startSec: i * 50, endSec: i * 50 + 50, score: 7, description: `part ${i}` })) })
    const reply = { shorts: [{ title: 'A', segments: [{ clip: 'c1', start: 0, end: 20, keepAudio: true }], musicMood: 'upbeat' }], notes: [] }
    const out = await planShorts(model(() => reply, asked), [talk], { ...req, shorts: 2, durationSec: 20, overlays: true }, { brief })
    const sent = JSON.parse(asked[0].prompt)
    expect(sent.focusOn).toEqual(['grandma'])
    expect(sent.avoid).toEqual(['the harbour'])
    expect(sent.shortsWanted).toBe(2)
    expect(out.source).toBe('ai')
    expect(out.plans.every((p) => p.overlays.length === 0)).toBe(true)
    expect(out.plans.every((p) => p.segments.every((s) => s.fixes === undefined))).toBe(true)
  })
})
