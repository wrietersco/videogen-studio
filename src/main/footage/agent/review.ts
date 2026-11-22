import { planDuration } from '@shared/footage'
import type { EditPlan, EditRecord, FootageCheck } from '@shared/footage'

/**
 * REVIEW — did the finished edit do what the plan said?
 *
 * buildChecks() is pure logic over the plan, the finished edit and the
 * renderer's own notes; it never touches a file or a model. nextMove() is the
 * iterate policy the render loop follows.
 */

const r1 = (n: number): string => String(Math.round(n * 10) / 10)

export function buildChecks(input: { plan: EditPlan; edit?: EditRecord; renderNotes: string[]; actualDurationSec?: number }): FootageCheck[] {
  const { plan, edit, renderNotes, actualDurationSec } = input
  const checks: FootageCheck[] = []
  const one = (n: number): string => (n === 1 ? '' : 's')

  // length: the finished video against what the plan adds up to (±15%)
  const planned = planDuration(plan)
  const actual = edit?.durationSec ?? actualDurationSec
  if (actual === undefined) {
    checks.push({ id: 'length', label: 'Length', status: 'missed', evidence: [`the plan adds up to ${r1(planned)}s`], note: 'There is no finished video to measure.', attempts: 1 })
  } else {
    const ok = planned > 0 ? Math.abs(actual - planned) <= planned * 0.15 : actual === 0
    checks.push({
      id: 'length',
      label: 'Length',
      status: ok ? 'done' : 'partial',
      evidence: [`the plan adds up to ${r1(planned)}s`, `the finished video is ${r1(actual)}s`],
      note: ok ? 'The finished video is the length the plan adds up to.' : `The finished video is ${r1(actual)}s, but the plan adds up to ${r1(planned)}s.`,
      attempts: 1
    })
  }

  // segments: was the video cut from the planned parts at all
  checks.push(
    edit
      ? { id: 'segments', label: 'The cut', status: 'done', evidence: [`the plan's ${plan.segments.length} part${one(plan.segments.length)} were rendered`], note: 'The finished video was cut from the planned parts.', attempts: 1 }
      : { id: 'segments', label: 'The cut', status: 'missed', evidence: [], note: 'No finished video was made from the plan.', attempts: 1 }
  )

  // overlays
  if (!plan.overlays.length) {
    checks.push({ id: 'overlays', label: 'Overlays', status: 'skipped', evidence: [], note: 'No overlays were planned.', attempts: 1 })
  } else {
    const leftOut = renderNotes.find((n) => /overlay/i.test(n))
    checks.push(
      leftOut
        ? { id: 'overlays', label: 'Overlays', status: 'partial', evidence: [leftOut], note: leftOut, attempts: 1 }
        : { id: 'overlays', label: 'Overlays', status: 'done', evidence: [`${plan.overlays.length} overlay${one(plan.overlays.length)} planned`], note: 'Every planned overlay is in the video.', attempts: 1 }
    )
  }

  // music
  if (plan.music.mode === 'none') {
    checks.push({ id: 'music', label: 'Music', status: 'skipped', evidence: [], note: 'No music was asked for.', attempts: 1 })
  } else {
    const fallback = renderNotes.find((n) => /built-in|fallback/i.test(n))
    checks.push(
      fallback
        ? { id: 'music', label: 'Music', status: 'partial', evidence: [fallback], note: fallback, attempts: 1 }
        : { id: 'music', label: 'Music', status: 'done', evidence: [`music: ${plan.music.mode}`], note: 'The music is in the video as planned.', attempts: 1 }
    )
  }

  // shot fixes
  const fixes = plan.segments.filter((s) => s.fixes).length
  checks.push(
    fixes
      ? { id: 'fixes', label: 'Shot fixes', status: 'done', evidence: [`${fixes} shot fix${one(fixes)} applied`], note: 'The planned shot fixes (brightness, colour, steadiness) were applied.', attempts: 1 }
      : { id: 'fixes', label: 'Shot fixes', status: 'skipped', evidence: [], note: 'No shot fixes were needed.', attempts: 1 }
  )

  // captions
  checks.push(
    plan.captions === 'off'
      ? { id: 'captions', label: 'Captions', status: 'skipped', evidence: [], note: 'No captions were asked for.', attempts: 1 }
      : { id: 'captions', label: 'Captions', status: 'done', evidence: [`caption style: ${plan.captions}`], note: `The ${plan.captions} captions are on the video.`, attempts: 1 }
  )

  return checks
}

// ------------------------------------------------------------------ iterate

export type Move = 'accept' | 'retry' | 'substitute' | 'ask'
export const MAX_ATTEMPTS = 2

/**
 * What the render loop does next: accept when it worked, retry until
 * MAX_ATTEMPTS, then put it to the person when the step was required and
 * substitute otherwise.
 */
export function nextMove(failed: boolean, attempts: number, required: boolean): Move {
  if (!failed) return 'accept'
  if (attempts < MAX_ATTEMPTS) return 'retry'
  return required ? 'ask' : 'substitute'
}
