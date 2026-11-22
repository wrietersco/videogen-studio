import { describe, expect, it } from 'vitest'
import { applyRoutingDecision, fallbackAfterFailure, nearestCapable, planRouting, type CandidateModel } from '../src/main/footage/agent/route'

const CANDS: CandidateModel[] = [
  { id: 'gemini:flash', provider: 'gemini', priceRank: 0, supportsVision: true },
  { id: 'gemini:pro', provider: 'gemini', priceRank: 1, supportsVision: true },
  { id: 'openai:gpt-mini', provider: 'openai', priceRank: 0, supportsVision: true },
  { id: 'openai:gpt', provider: 'openai', priceRank: 1, supportsVision: false }
]

const TASKS = ['shot-describe', 'topic', 'planner', 'instruction', 'review'] as const

const base = { catalogChars: 20_000, shorts: 1, plannerFailedOnce: false, candidates: CANDS, escalateCapUsd: 0.5 }

describe('planRouting', () => {
  it('runs every task on the cheapest model and asks nothing', () => {
    const { choices, decision } = planRouting(base)
    expect(decision).toBeNull()
    for (const t of TASKS) {
      expect(choices[t].modelId).toBe('gemini:flash')
      expect(choices[t].escalated).toBe(false)
      expect(choices[t].extraCostUsd).toBe(0)
    }
  })

  it('escalates the planner one rank up on the same provider when the catalog is big', () => {
    const { choices, decision } = planRouting({ ...base, catalogChars: 96_000, escalateCapUsd: 5 })
    expect(choices.planner.modelId).toBe('gemini:pro')
    expect(choices.planner.escalated).toBe(true)
    // max(0.05, 1 rank x $0.15 x 96k/50k) = $0.288
    expect(choices.planner.extraCostUsd).toBeCloseTo(0.288, 3)
    expect(choices.instruction.modelId).toBe('gemini:flash')
    expect(choices['shot-describe'].modelId).toBe('gemini:flash')
    expect(choices.review.modelId).toBe('gemini:flash')
    expect(decision).toBeNull() // under the cap: no question
  })

  it('escalates for several shorts, or after the planner failed once', () => {
    expect(planRouting({ ...base, shorts: 4 }).choices.planner.modelId).toBe('gemini:pro')
    expect(planRouting({ ...base, shorts: 3 }).choices.planner.modelId).toBe('gemini:flash')
    expect(planRouting({ ...base, plannerFailedOnce: true }).choices.planner.modelId).toBe('gemini:pro')
  })

  it('escalates across providers when the cheapest provider has no stronger model of its own', () => {
    const { choices, decision } = planRouting({ ...base, catalogChars: 96_000, candidates: [CANDS[0], CANDS[3]] })
    expect(choices.planner.modelId).toBe('openai:gpt') // the only rank-1 model, on another provider
    expect(choices.planner.providerId).toBe('openai')
    expect(choices.planner.escalated).toBe(true)
    expect(choices.planner.reason).toMatch(/openai:gpt/)
    expect(decision).toBeNull() // under the cap
  })

  it('routes the watching to the nearest vision-capable model, on whatever provider has one', () => {
    const blind = [
      { id: 'deepseek:v4', provider: 'deepseek', priceRank: 0, supportsVision: false },
      { id: 'deepseek:v4-pro', provider: 'deepseek', priceRank: 1, supportsVision: false },
      { id: 'gemini:flash', provider: 'gemini', priceRank: 0, supportsVision: true },
      { id: 'openai:gpt', provider: 'openai', priceRank: 3, supportsVision: true }
    ]
    const { choices } = planRouting({ ...base, candidates: blind })
    expect(choices['shot-describe'].modelId).toBe('gemini:flash')
    expect(choices['shot-describe'].providerId).toBe('gemini')
    expect(choices['shot-describe'].reason).toMatch(/nearest model that can see/i)
    // text tasks still run on the overall cheapest
    expect(choices.instruction.modelId).toBe('deepseek:v4')
  })

  it('says so honestly when no provider has a model that can see', () => {
    const { choices } = planRouting({ ...base, candidates: [CANDS[3]] })
    expect(choices['shot-describe'].modelId).toBeUndefined()
    expect(choices['shot-describe'].reason).toMatch(/no vision-capable model/i)
    expect(choices.instruction.modelId).toBe('openai:gpt') // text tasks carry on
  })

  it('costs at least $0.05 however small the catalog', () => {
    const { choices } = planRouting({ ...base, catalogChars: 10_000, plannerFailedOnce: true })
    expect(choices.planner.modelId).toBe('gemini:pro')
    expect(choices.planner.extraCostUsd).toBeCloseTo(0.05, 3)
  })

  it('over the cap: asks, offers both options, autopicks stay', () => {
    const { decision } = planRouting({ ...base, catalogChars: 96_000, escalateCapUsd: 0.2 })
    expect(decision).not.toBeNull()
    expect(decision!.id).toBe('models')
    expect(decision!.topic).toBe('plan')
    expect(decision!.autopick).toBe('stay')
    expect(decision!.options.map((o) => o.id)).toEqual(['escalate', 'stay'])
    expect(decision!.question).toMatch(/stronger model/)
    expect(decision!.question).toMatch(/\$0\.29/)
    expect(decision!.context).toMatch(/96k characters/)
    expect(decision!.options.find((o) => o.id === 'stay')!.recommended).toBe(true)
    expect(decision!.options.find((o) => o.id === 'escalate')!.detail).toMatch(/gemini:pro/)
  })

  it('empty candidates: no model anywhere, and no decision', () => {
    const { choices, decision } = planRouting({ ...base, candidates: [] })
    expect(decision).toBeNull()
    for (const t of TASKS) {
      expect(choices[t].modelId).toBeUndefined()
      expect(choices[t].extraCostUsd).toBe(0)
      expect(choices[t].reason).toMatch(/no model/)
    }
  })
})

describe('applyRoutingDecision', () => {
  it("option 'stay' puts the planner back on the cheapest model, noting the person's choice", () => {
    const { choices } = planRouting({ ...base, catalogChars: 96_000, escalateCapUsd: 5 })
    expect(choices.planner.modelId).toBe('gemini:pro')
    const after = applyRoutingDecision(choices, { id: 'models', option: 'stay', auto: false })
    expect(after.planner.modelId).toBe('gemini:flash')
    expect(after.planner.escalated).toBe(false)
    expect(after.planner.extraCostUsd).toBe(0)
    expect(after.planner.reason).toMatch(/your choice/)
    expect(after.instruction.modelId).toBe('gemini:flash') // the cheap tasks are untouched
    expect(choices.planner.modelId).toBe('gemini:pro') // the input is not mutated
  })

  it("option 'escalate' leaves the routing as it was", () => {
    const { choices } = planRouting({ ...base, catalogChars: 96_000, escalateCapUsd: 5 })
    const after = applyRoutingDecision(choices, { id: 'models', option: 'escalate', auto: false })
    expect(after.planner.modelId).toBe('gemini:pro')
    expect(after.planner.escalated).toBe(true)
    expect(after.planner.extraCostUsd).toBeCloseTo(0.288, 3)
  })
})

describe('nearestCapable + fallbackAfterFailure (cross-provider handover)', () => {
  const blind = [
    { id: 'deepseek:v4-pro', provider: 'deepseek', priceRank: 1, supportsVision: false },
    { id: 'gemini:flash', provider: 'gemini', priceRank: 0, supportsVision: true },
    { id: 'openai:gpt', provider: 'openai', priceRank: 3, supportsVision: true }
  ]

  it('nearestCapable: cheapest of the capable, preferring the provider we already sit on at a tie', () => {
    expect(nearestCapable(blind, true, 'deepseek')?.id).toBe('gemini:flash')
    const tie = [
      { id: 'a', provider: 'other', priceRank: 0, supportsVision: true },
      { id: 'b', provider: 'here', priceRank: 0, supportsVision: true }
    ]
    expect(nearestCapable(tie, true, 'here')?.id).toBe('b')
    expect(nearestCapable(blind, false)?.id).toBe('gemini:flash') // no capability needed: plain cheapest
  })

  it('nearestCapable: undefined when nobody has the capability', () => {
    expect(nearestCapable([blind[0]], true)).toBeUndefined()
  })

  it('fallbackAfterFailure: hops to another provider when the watcher cannot see', () => {
    const next = fallbackAfterFailure(blind, { provider: 'deepseek', modelId: 'deepseek:v4-pro' }, true)
    expect(next?.provider).toBe('gemini')
    expect(next?.id).toBe('gemini:flash')
    // the failed model itself is never returned
    expect(fallbackAfterFailure([blind[0]], { provider: 'deepseek', modelId: 'deepseek:v4-pro' }, true)).toBeUndefined()
    // still price-first: the same provider's pricier capable model loses to another provider's cheaper one
    const mixed = [...blind, { id: 'deepseek:vision', provider: 'deepseek', priceRank: 2, supportsVision: true }]
    expect(fallbackAfterFailure(mixed, { provider: 'deepseek', modelId: 'deepseek:v4-pro' }, true)?.id).toBe('gemini:flash')
    // but when prices tie, the failed provider's own other capable model is the nearer one
    const tie = [
      { id: 'x-flash', provider: 'other', priceRank: 0, supportsVision: true },
      { id: 'd-vision', provider: 'deepseek', priceRank: 0, supportsVision: true }
    ]
    expect(fallbackAfterFailure(tie, { provider: 'deepseek', modelId: 'deepseek:v4-pro' }, true)?.id).toBe('d-vision')
  })
})
