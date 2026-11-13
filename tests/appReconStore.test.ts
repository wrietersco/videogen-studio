import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyReviewEdits, planBeats, reviewBeats } from '../src/main/appRecon/planner'
import { AppReconStore } from '../src/main/appRecon/store'
import { DEFAULT_CHECKS, validateApp, type AppInput } from '../src/shared/appRecording'

const seal = { enc: (s: string) => `enc:${Buffer.from(s).toString('base64')}`, dec: (s: string) => Buffer.from(s.slice(4), 'base64').toString() }

const input = (over: Partial<AppInput> = {}): AppInput => {
  const v = validateApp({ name: 'Demo', url: 'https://app.example.com/login', signIn: 'saved', username: 'alice', password: 'Hunter-22-secret', ...over })
  if (!v.ok) throw new Error(v.error)
  return v.value
}

describe('what a screen may send', () => {
  it('accepts an address with or without the scheme, and fills in safe defaults', () => {
    const v = validateApp({ url: 'app.example.com', signIn: 'none' })
    expect(v.ok && v.value).toMatchObject({ url: 'https://app.example.com/', signIn: 'none', depth: 'standard', targetSec: 44, useAi: true, reviewFirst: false, mode: 'walkthrough', checks: DEFAULT_CHECKS })
  })
  it('refuses anything that is not a web address', () => {
    expect(validateApp({ url: 'file:///etc/passwd' }).ok).toBe(false)
    expect(validateApp({ url: 'javascript:alert(1)' }).ok).toBe(false)
    expect(validateApp({ url: '' }).ok).toBe(false)
  })
  it('needs a username for a saved login, but not for "I will sign in myself"', () => {
    expect(validateApp({ url: 'https://a.example.com', signIn: 'saved' }).ok).toBe(false)
    expect(validateApp({ url: 'https://a.example.com', signIn: 'self' }).ok).toBe(true)
  })
  it('keeps restrictions off unless they are exactly true, and stays on the app\'s sites unless told not to', () => {
    const v = validateApp({ url: 'https://a.example.com', signIn: 'none', checks: { readOnly: 'yes', noDelete: true, stayOnSites: false } })
    expect(v.ok && v.value.checks).toEqual({ ...DEFAULT_CHECKS, noDelete: true, stayOnSites: false })
  })
  it('clamps the length and trims what it is given', () => {
    const v = validateApp({ url: 'https://a.example.com', signIn: 'none', targetSec: 9999, name: '  x  ' })
    expect(v.ok && [v.value.targetSec, v.value.name]).toEqual([120, 'x'])
  })
})

describe('saved apps', () => {
  let dir: string
  let store: AppReconStore
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vg-store-'))
    store = new AppReconStore(dir, seal)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the password sealed and never in the app list', () => {
    const app = store.save(input())
    expect(app.hasPassword).toBe(true)
    expect(JSON.stringify(store.list())).not.toContain('Hunter-22-secret')
    expect(readFileSync(join(dir, 'apps.json'), 'utf8')).not.toContain('Hunter-22-secret')
    expect(readFileSync(join(dir, 'secrets.json'), 'utf8')).not.toContain('Hunter-22-secret')
    expect(store.secrets(app.id)).toEqual({ username: 'alice', password: 'Hunter-22-secret' })
  })

  it('keeps the stored password when an edit does not send one, and replaces it when it does', () => {
    const app = store.save(input())
    store.save(input({ id: app.id, name: 'Renamed', password: undefined, username: undefined }))
    expect(store.get(app.id)?.name).toBe('Renamed')
    expect(store.secrets(app.id)?.password).toBe('Hunter-22-secret')
    store.save(input({ id: app.id, password: 'new-pass-9' }))
    expect(store.secrets(app.id)?.password).toBe('new-pass-9')
  })

  it('saving the same app again updates it instead of making a copy', () => {
    const a = store.save(input())
    const b = store.save(input({ context: 'changed' }))
    expect(b.id).toBe(a.id)
    expect(store.list()).toHaveLength(1)
    expect(store.get(a.id)?.context).toBe('changed')
  })

  it('refuses to save a stored login without a password', () => {
    expect(() => store.save(input({ password: undefined }))).toThrow(/password/)
  })

  it('remembers runs and marks one that was still running as interrupted', () => {
    const app = store.save(input())
    const run = store.newRun(app.id)
    expect(store.runs(app.id)).toHaveLength(1)
    store.markInterrupted()
    expect(store.runs(app.id)[0]).toMatchObject({ status: 'failed' })
    store.saveRun({ ...run, status: 'done', finishedAt: new Date().toISOString() })
    expect(store.get(app.id)?.lastRunAt).toBeTruthy()
  })

  it('forgets everything about an app', () => {
    const app = store.save(input())
    const run = store.newRun(app.id)
    store.remove(app.id)
    expect(store.get(app.id)).toBeNull()
    expect(store.secrets(app.id)).toBeNull()
    expect(existsSync(store.runDir(run.id))).toBe(false)
  })

  it('refuses ids that could point outside its folder', () => {
    expect(() => store.runDir('run-../../etc')).toThrow()
    expect(() => store.remove('../x')).toThrow()
    expect(() => store.newRun('nope')).toThrow()
  })
})

describe('review edits', () => {
  const page = (url: string, title: string) => ({ url, title, headings: [title], fields: [], controls: [], notices: [] })
  const pages = [page('https://a.example.com/', 'Home'), page('https://a.example.com/billing', 'Billing'), page('https://a.example.com/team', 'Team')]
  const visits = pages.map((p, index) => ({ index, page: p, via: index ? ('link' as const) : ('start' as const), interactions: [] }))
  const map = { version: 1 as const, startUrl: 'https://a.example.com/', host: 'a.example.com', scoutedAt: 'x', pages, login: { detected: false, otpLikely: false }, sensitiveSelectors: [] }
  const plan = planBeats({ map, exploration: { visits, actions: 0, stoppedBy: 'done', elapsedMs: 0 }, context: '', startUrl: 'https://a.example.com/', targetSec: 44, hasVault: false, secrets: [] })

  it('drops a page and rewords a line, leaving the rest', () => {
    const second = plan.beats[1].beat
    const edited = applyReviewEdits(plan, { removeBeats: [second], lines: { [plan.beats[0].beat]: 'Welcome to the home page.' } })
    expect(edited.beats).toHaveLength(plan.beats.length - 1)
    expect(edited.beats[0].fallback).toBe('Welcome to the home page.')
    expect(edited.playbook.steps.some((s) => s.beat === second)).toBe(false)
  })

  it('never drops a sign-in beat', () => {
    const signIn = { ...plan, beats: [{ ...plan.beats[0], kind: 'login-pass' as const }, ...plan.beats.slice(1)] }
    const edited = applyReviewEdits(signIn, { removeBeats: [signIn.beats[0].beat], lines: {} })
    expect(edited.beats).toHaveLength(signIn.beats.length)
    expect(reviewBeats(signIn, false)[0].removable).toBe(false)
  })
})
