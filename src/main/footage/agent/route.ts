import type { DecisionAnswer, DecisionRequest } from '@shared/agentBrief'

/**
 * MODEL ROUTING for the footage PARI loop — pure policy, no provider calls.
 *
 * Routing is capability-first: a task that needs eyes (shot-describe) runs on
 * the nearest vision-capable model, whichever provider has one — switching
 * providers is expected when the configured one cannot do the job (a text-only
 * model set as the watcher, say). planRouting() works out which model each
 * task runs on: everything but the planner takes the cheapest capable
 * candidate; the planner starts cheapest and moves one price rank up (any
 * provider, never an invented id) when the job is big or the cheap model
 * already failed once. When the extra cost would pass the person's cap, a
 * DecisionRequest goes to them (autopilot stays on the cheap model).
 * applyRoutingDecision() folds their answer back in, and
 * fallbackAfterFailure() picks the next nearest-capability model at run time
 * when a provider refuses a job mid-run.
 */

export type FootageTask = 'shot-describe' | 'topic' | 'planner' | 'instruction' | 'review'

export interface CandidateModel {
  id: string
  provider: string
  priceRank: 0 | 1 | 2 | 3
  supportsVision: boolean
}

export interface RouteChoice {
  modelId?: string
  /** the provider the model lives on — routing may cross providers to find a capable model */
  providerId?: string
  reason: string
  extraCostUsd: number
  escalated: boolean
}

const CHEAP_TASKS: readonly FootageTask[] = ['topic', 'instruction', 'review']
const ALL_TASKS: readonly FootageTask[] = ['shot-describe', 'topic', 'planner', 'instruction', 'review']


/**
 * The nearest model with the needed capability, whichever provider offers it.
 * "Nearest" = cheapest of the capable ones, preferring the provider the routing
 * already sits on when prices tie. Undefined when nobody can do the job.
 */
export function nearestCapable(candidates: CandidateModel[], needsVision: boolean, preferProvider?: string): CandidateModel | undefined {
  const capable = candidates.filter((c) => !needsVision || c.supportsVision)
  if (!capable.length) return undefined
  return [...capable].sort(
    (a, b) => a.priceRank - b.priceRank || Number(a.provider !== preferProvider) - Number(b.provider !== preferProvider)
  )[0]
}

/**
 * The next model to try after one refused a job mid-run ("cannot review
 * images", a text-only watcher set by mistake): the nearest capable model that
 * is NOT the failed one — the same provider's other model when it has one,
 * otherwise the nearest capable model on another provider.
 */
export function fallbackAfterFailure(
  candidates: CandidateModel[],
  failed: { provider: string; modelId?: string },
  needsVision: boolean
): CandidateModel | undefined {
  return nearestCapable(
    candidates.filter((c) => !(c.provider === failed.provider && c.id === failed.modelId)),
    needsVision,
    failed.provider
  )
}

export function planRouting(input: {
  catalogChars: number
  shorts: number
  plannerFailedOnce: boolean
  candidates: CandidateModel[]
  escalateCapUsd: number
}): { choices: Record<FootageTask, RouteChoice>; decision: DecisionRequest | null } {
  const choices = {} as Record<FootageTask, RouteChoice>
  const cheapest = input.candidates.length ? [...input.candidates].sort((a, b) => a.priceRank - b.priceRank)[0] : undefined
  const watcher = nearestCapable(input.candidates, true)

  if (!cheapest) {
    for (const t of ALL_TASKS) choices[t] = { reason: 'no model was available', extraCostUsd: 0, escalated: false }
    return { choices, decision: null }
  }

  const choiceOf = (c: CandidateModel, reason: string): RouteChoice => ({
    modelId: c.id,
    providerId: c.provider,
    reason,
    extraCostUsd: 0,
    escalated: false
  })

  // the watching task runs on the nearest model that can see, even when that means another provider
  choices['shot-describe'] = watcher
    ? choiceOf(
        watcher,
        watcher.provider === cheapest.provider
          ? `${watcher.id} — the cheapest model that can see pictures`
          : `${watcher.provider}:${watcher.id} — the nearest model that can see pictures (${cheapest.provider} has none)`
      )
    : { reason: 'no vision-capable model was available', extraCostUsd: 0, escalated: false }
  for (const t of CHEAP_TASKS) choices[t] = choiceOf(cheapest, `the cheapest model (${cheapest.id})`)

  // why the planner might need the stronger model
  const triggers: string[] = []
  if (input.catalogChars > 80_000) triggers.push(`the footage catalog is ${Math.round(input.catalogChars / 1000)}k characters`)
  if (input.shorts > 3) triggers.push(`${input.shorts} shorts were asked for`)
  if (input.plannerFailedOnce) triggers.push('the cheaper model already failed once at planning')

  // one price rank up, any provider (the cheapest's own preferred on a tie); none → stay cheapest
  const stronger = triggers.length
    ? input.candidates
        .filter((c) => c.priceRank > cheapest.priceRank)
        .sort((a, b) => a.priceRank - b.priceRank || Number(a.provider !== cheapest.provider) - Number(b.provider !== cheapest.provider))[0]
    : undefined

  let planner: RouteChoice
  if (stronger) {
    const rankDelta = stronger.priceRank - cheapest.priceRank
    const extraCostUsd = Math.max(0.05, rankDelta * 0.15 * (input.catalogChars / 50_000))
    planner = {
      modelId: stronger.id,
      providerId: stronger.provider,
      reason: `${stronger.provider}:${stronger.id} — ${triggers.join('; ')} (about $${extraCostUsd.toFixed(2)} more)`,
      extraCostUsd,
      escalated: true
    }
  } else {
    planner = choiceOf(
      cheapest,
      triggers.length
        ? `the cheapest model (${cheapest.id}); nothing stronger was available to escalate to`
        : `the cheapest model (${cheapest.id})`
    )
  }
  choices.planner = planner

  const total = ALL_TASKS.reduce((a, t) => a + choices[t].extraCostUsd, 0)
  if (!(total > input.escalateCapUsd)) return { choices, decision: null }

  const decision: DecisionRequest = {
    id: 'models',
    topic: 'plan',
    question: `Use the stronger model for planning? (about $${total.toFixed(2)} more)`,
    context: `Planning is the one job that needs the stronger model: ${triggers.join('; ')}. That model costs about $${total.toFixed(
      2
    )} more than the cheaper one (${cheapest.id}); the limit set for this run is $${input.escalateCapUsd.toFixed(2)}.`,
    options: [
      {
        id: 'escalate',
        label: 'Use the stronger model',
        detail: planner.modelId && planner.providerId
          ? `${planner.providerId}:${planner.modelId} plans the edit — ${triggers.join('; ')} — about $${total.toFixed(2)} more.`
          : 'The stronger model plans the edit.'
      },
      {
        id: 'stay',
        label: 'Stay on the cheaper model',
        detail: `${cheapest.id} keeps planning at no extra cost. It may need another try on a catalog this size.`,
        recommended: true
      }
    ],
    autopick: 'stay'
  }
  return { choices, decision }
}

/**
 * Folds the person's answer to the 'models' question back into the routing.
 * 'stay' puts the planner back on the cheapest model (the one every other task
 * runs on); any other answer leaves the routing as it was.
 */
export function applyRoutingDecision(choices: Record<FootageTask, RouteChoice>, answer: DecisionAnswer): Record<FootageTask, RouteChoice> {
  if (answer.id !== 'models' || answer.option !== 'stay') return choices
  const cheap = choices.instruction // every cheap task runs on the cheapest model
  return {
    ...choices,
    planner: {
      modelId: cheap.modelId,
      providerId: cheap.providerId,
      reason: cheap.modelId ? `stayed on the cheaper model (${cheap.modelId}): your choice` : 'no model was available',
      extraCostUsd: 0,
      escalated: false
    }
  }
}
