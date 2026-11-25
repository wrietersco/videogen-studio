import type { Page } from 'puppeteer-core'
import type { Atom, AtomResult, FindSpec, NewAtom } from '@shared/appRecon'
import type { PolicyGate } from './policy'
import type { Found } from './resolve'
import type { Located } from './script'

/**
 * Performs the atoms the older code in script.ts does not know: keys, drag, double-click, sliders, dates, scroll-until,
 * "whenever" rules and ordinal/criterion picks. The contract (what each atom means and what a result must say) is in
 * @shared/appRecon; every executor reports what it really did and never fails silently.
 *
 * THIS FILE IS A STUB: every kind is reported as skipped until its executor is written (fix-executor owns this file).
 */

export interface AtomExecCtx {
  page: Page
  gate: PolicyGate
  log: (m: string) => void
  /** the second look: looser names, a model's help */
  relaxed: boolean
  /** the person's words for the whole step */
  said: string
  vision?: unknown
  /** the selector of the control used just before (for "scroll near it") */
  last?: string
  /** the usual way to find a control by its name (name, then looser, then behind a folded panel, then by a model looking) */
  locate: (atom: { find: FindSpec; label: string }) => Promise<Located>
}

export type { Found }

export const NEW_ACTIONS = ['key', 'drag', 'dblclick', 'slider', 'date', 'scrollUntil', 'whenever', 'pick'] as const

export const isNewAtom = (a: Atom): a is NewAtom => (NEW_ACTIONS as readonly string[]).includes(a.action)

export async function execNewAtom(atom: NewAtom, _ctx: AtomExecCtx): Promise<AtomResult> {
  return { steps: [], seen: [], did: 0, changed: false, verified: false, skipped: [{ what: `${atom.action === 'whenever' ? 'the rule' : 'the step'} "${atom.label}"`, why: 'skipped: not supported yet' }] }
}
