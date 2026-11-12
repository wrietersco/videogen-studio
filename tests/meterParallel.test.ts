import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { meter, readProjectUsage } from '../src/main/usage/meter'

const call = (model: string) => meter.record({ kind: 'text', provider: 'test', model, usage: { inputTokens: 1_000_000 } })
const tick = () => new Promise<void>((r) => setTimeout(r, 5))

describe('usage meter with parallel jobs', () => {
  it('keeps two interleaved jobs in separate ledgers, each with its own stage', async () => {
    const a = meter.open('generate')
    const b = meter.open('generate')
    await Promise.all([
      meter.scope(a, async () => {
        meter.setStage('plan')
        call('deepseek-flash')
        await tick()
        await tick()
        call('deepseek-flash')
      }),
      meter.scope(b, async () => {
        await tick()
        meter.setStage('render')
        call('gpt-6-luna')
      })
    ])
    expect(a.run.entries.map((e) => e.model)).toEqual(['deepseek-flash', 'deepseek-flash'])
    expect(a.run.entries.every((e) => e.stage === 'plan')).toBe(true)
    expect(b.run.entries.map((e) => e.model)).toEqual(['gpt-6-luna'])
    expect(b.run.entries[0].stage).toBe('render')
    expect(a.run.totalUsd).toBeCloseTo(0.6, 5)
    expect(b.run.totalUsd).toBeCloseTo(0.1, 5)
  })

  it('files each closed run into its own project', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'meter-a-'))
    const dirB = mkdtempSync(join(tmpdir(), 'meter-b-'))
    const a = meter.open('generate')
    const b = meter.open('revise')
    await Promise.all([meter.scope(a, async () => void call('deepseek-flash')), meter.scope(b, async () => void call('gpt-6-luna'))])
    meter.close(a, dirA)
    meter.close(b, dirB)
    expect(readProjectUsage(dirA).runs.map((r) => r.kind)).toEqual(['generate'])
    expect(readProjectUsage(dirB).runs.map((r) => r.kind)).toEqual(['revise'])
    expect(readProjectUsage(dirA).totalUsd).toBeCloseTo(0.3, 5)
  })

  it('still serves single-job surfaces through begin/end, and a scope wins inside it', async () => {
    meter.begin('footage')
    call('gpt-6-luna')
    const scoped = meter.open('generate')
    await meter.scope(scoped, async () => void call('deepseek-flash'))
    call('gpt-6-luna')
    const single = meter.end(null)
    expect(single?.entries.map((e) => e.model)).toEqual(['gpt-6-luna', 'gpt-6-luna'])
    expect(scoped.run.entries.map((e) => e.model)).toEqual(['deepseek-flash'])
    expect(meter.current()).toBeNull()
  })
})
