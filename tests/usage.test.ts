import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { priceUsage, fmtUsd } from '../src/shared/pricing'
import { meter, readProjectUsage } from '../src/main/usage/meter'

describe('price book', () => {
  it('prices tokens, images and characters', () => {
    expect(priceUsage('claude-sonnet-5-5', { inputTokens: 1e6, outputTokens: 1e5 }).usd).toBeCloseTo(3)
    expect(priceUsage('gemini-3.1-flash-image', { images: 2 }).usd).toBeCloseTo(0.134)
    expect(priceUsage('eleven_v3', { chars: 2000 }).usd).toBeCloseTo(0.16)
    expect(priceUsage('mystery-model', { inputTokens: 5 })).toEqual({ usd: 0, priced: false })
  })
  it('formats tiny amounts readably', () => {
    expect(fmtUsd(0.00123)).toBe('$0.0012')
    expect(fmtUsd(0.42)).toBe('$0.420')
    expect(fmtUsd(3.5)).toBe('$3.50')
  })
})

describe('usage meter', () => {
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
