import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { priceUsage, fmtUsd, MEDIA_MODELS } from '../src/shared/pricing'
import { meter, readProjectUsage } from '../src/main/usage/meter'

describe('price book', () => {
  it('prices tokens, images and characters', () => {
    expect(priceUsage('claude-sonnet-5-5', { inputTokens: 1e6, outputTokens: 1e5 }).usd).toBeCloseTo(3)
    expect(priceUsage('gemini-3.1-flash-image', { images: 2 }).usd).toBeCloseTo(0.134)
    expect(priceUsage('eleven_v3', { chars: 2000 }).usd).toBeCloseTo(0.16)
    expect(priceUsage('mystery-model', { inputTokens: 5 })).toEqual({ usd: 0, priced: false })
  })
  it('prices the Nov 2026 model additions', () => {
    expect(priceUsage('eleven_v4', { chars: 2000 }).usd).toBeCloseTo(0.16)
    expect(priceUsage('eleven_v4_turbo', { chars: 2000 }).usd).toBeCloseTo(0.08)
    expect(priceUsage('music_v2_5', { seconds: 120 }).usd).toBeCloseTo(0.3)
    expect(priceUsage('gemini-3.8-flash-lite-tts', { inputTokens: 1e6, outputTokens: 1e6 }).usd).toBeCloseTo(6.5)
    expect(priceUsage('gemini-omni-1.2-flash', { outputTokens: 5792 * 10 }).usd).toBeCloseTo(0.695, 2)
    expect(MEDIA_MODELS.filter((m) => m.kind !== 'image' && m.provider !== 'stock' && m.provider !== 'builtin').every((m) => priceUsage(m.id, { items: 1, seconds: 1, chars: 1, inputTokens: 1, outputTokens: 1 }).priced)).toBe(true)
  })
  it('formats tiny amounts readably', () => {
    expect(fmtUsd(0.00123)).toBe('$0.0012')
    expect(fmtUsd(0.42)).toBe('$0.420')
    expect(fmtUsd(3.5)).toBe('$3.50')
  })
})

describe('usage meter', () => {
  it('retains each concurrent project receipt when the process exits abruptly', () => {
    const aDir = mkdtempSync(join(tmpdir(), 'vg-crash-a-')), bDir = mkdtempSync(join(tmpdir(), 'vg-crash-b-'))
    const result = spawnSync(process.execPath, ['--import', 'tsx', join(process.cwd(), 'tests', 'fixtures', 'usageCrash.ts'), aDir, bDir], { cwd: process.cwd(), encoding: 'utf8', timeout: 30000 })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(19)
    const a = readProjectUsage(aDir), b = readProjectUsage(bDir)
    expect(a.runs).toHaveLength(1)
    expect(a.runs[0].entries).toHaveLength(2)
    expect(a.runs[0].endedAt).toBeUndefined()
    expect(a.totalUsd).toBeCloseTo(0.734)
    expect(b.runs).toHaveLength(1)
    expect(b.runs[0].entries).toHaveLength(1)
    expect(b.runs[0].endedAt).toBeUndefined()
    expect(b.totalUsd).toBeCloseTo(0.6)
  })
  it('checkpoints parallel jobs without mixing projects or duplicating completed runs', async () => {
    const aDir = mkdtempSync(join(tmpdir(), 'vg-usage-a-')), bDir = mkdtempSync(join(tmpdir(), 'vg-usage-b-'))
    const a = meter.open('generate'), b = meter.open('generate')
    let unblock!: () => void
    const gate = new Promise<void>(resolve => { unblock = resolve })
    const first = meter.scope(a, async () => {
      meter.record({ kind: 'text', provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 1e6, outputTokens: 1e6 } })
      meter.bindProject(aDir) // includes an earlier creative-settings call
      await gate
      meter.record({ kind: 'image', provider: 'gemini', model: 'gemini-3-pro-image', usage: { images: 1 } })
    })
    const second = meter.scope(b, async () => {
      meter.bindProject(bDir)
      meter.record({ kind: 'text', provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 1e6, outputTokens: 1e6 } })
      expect(readProjectUsage(aDir).totalUsd).toBeCloseTo(0.6)
      expect(readProjectUsage(bDir).totalUsd).toBeCloseTo(0.6)
      unblock()
    })
    await Promise.all([first, second])
    const interrupted = readProjectUsage(aDir)
    expect(interrupted.runs).toHaveLength(1)
    expect(interrupted.runs[0].endedAt).toBeUndefined()
    expect(interrupted.runs[0].entries).toHaveLength(2)
    expect(interrupted.totalUsd).toBeCloseTo(0.734)
    expect(readProjectUsage(bDir).runs[0].entries).toHaveLength(1)
    expect(() => meter.close(a, bDir)).toThrow('another project')
    meter.close(a, aDir)
    meter.close(b, bDir)
    expect(readProjectUsage(aDir).runs).toHaveLength(1)
    expect(readProjectUsage(aDir).runs[0].endedAt).toBeDefined()
    expect(readProjectUsage(bDir).totalUsd).toBeCloseTo(0.6)
  })
  it('files a run with totals and savings into usage.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vg-usage-'))
    meter.begin('generate')
    meter.setStage('plan')
    meter.record({ kind: 'text', provider: 'openai', model: 'gpt-6-luna', usage: { inputTokens: 1e6, outputTokens: 1e6 } })
    meter.record({ kind: 'image', provider: 'gemini', model: 'gemini-3-pro-image', usage: { images: 1 }, saved: true })
    const run = meter.end(dir)
    expect(run?.totalUsd).toBeCloseTo(0.6)
    expect(run?.savedUsd).toBeCloseTo(0.134)
    expect(run?.entries[0].stage).toBe('plan')
    expect(existsSync(join(dir, 'usage.json'))).toBe(true)
    expect(readProjectUsage(dir).totalUsd).toBeCloseTo(0.6)
  })
})
