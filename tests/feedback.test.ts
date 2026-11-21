import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { FeedbackStore } from '../src/main/feedback/store'
import { captureFeedbackContext, type CaptureRoots } from '../src/main/feedback/capture'
import { FEEDBACK_REASON_IDS, type FeedbackContext } from '../src/shared/feedback'

const root = mkdtempSync(join(tmpdir(), 'vg-feedback-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const noContext: FeedbackContext = { prompt: '', decisions: {} }

describe('feedback store', () => {
  it('saves an opinion and reads it back', () => {
    const store = new FeedbackStore(join(root, 'a', 'feedback.json'))
    const entry = store.upsert('proj-1', 'create', 'up', ['visuals', 'story', 'made-up'], 'Loved it', { ...noContext, prompt: 'a film about tea', style: 'social' })
    expect(entry.reasons).toEqual(['visuals', 'story']) // unknown reasons are dropped
    expect(store.get('proj-1')?.comment).toBe('Loved it')
    expect(store.get('proj-1')?.context.prompt).toBe('a film about tea')
    expect(store.get('nope')).toBeNull()
  })

  it('re-saving the same video replaces the opinion, keeping when it was first given', () => {
    const file = join(root, 'b', 'feedback.json')
    const store = new FeedbackStore(file)
    const first = store.upsert('run-ab12', 'app', 'up', [], '', noContext)
    const second = store.upsert('run-ab12', 'app', 'down', ['pacing'], 'too slow', noContext)
    expect(store.list()).toHaveLength(1)
    expect(second.rating).toBe('down')
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt >= first.updatedAt).toBe(true)
    // survives a restart: a fresh store reads the same single entry
    expect(new FeedbackStore(file).list()).toHaveLength(1)
    // written atomically — no tmp file left behind
    expect(readFileSync(file, 'utf8')).toContain('too slow')
  })

  it('starts empty when the file is unreadable, and removes an entry on demand', () => {
    const file = join(root, 'c.json')
    writeFileSync(file, '{not json')
    const store = new FeedbackStore(file)
    expect(store.list()).toEqual([])
    store.upsert('mrun-cd34', 'market', 'up', FEEDBACK_REASON_IDS, '', noContext)
    expect(store.remove('mrun-cd34')).toBe(true)
    expect(store.remove('mrun-cd34')).toBe(false)
    expect(store.list()).toEqual([])
  })
})

describe('feedback capture', () => {
  const roots: CaptureRoots = { projects: join(root, 'projects'), appRecon: join(root, 'app-recordings'), marketing: join(root, 'business-profiles'), footage: join(root, 'footage'), library: join(root, 'library') }
  const put = (file: string, data: unknown): void => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify(data))
  }

  it('captures what a Create video was made of', () => {
    put(join(roots.projects, 'tea-1', 'project.json'), { id: 'tea-1', prompt: 'a film about tea', platform: 'tiktok', status: 'done', renders: [{ file: 'renders/out.mp4', platform: 'tiktok', createdAt: '2026-01-01T00:00:00Z' }] })
    put(join(roots.projects, 'tea-1', 'spec.json'), { title: 'Tea', platform: 'tiktok', style: 'social', pacing: 'brisk', durationSec: 30, fps: 30, musicMood: 'playful', palette: 'warm', typography: 'bold', scenes: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], narration: [{ sceneId: 's1', text: 'First, water.' }, { sceneId: 's2', text: 'Then leaves.' }] })
    put(join(roots.projects, 'tea-1', 'brand.json'), { kitId: 'kit-1', name: 'Tea Co', watermark: 'off', endCard: false })
    const ctx = captureFeedbackContext('create', 'tea-1', roots)
    expect(ctx.prompt).toBe('a film about tea')
    expect(ctx.platform).toBe('tiktok')
    expect(ctx.style).toBe('social')
    expect(ctx.durationSec).toBe(30)
    expect(ctx.videoPath).toBe('renders/out.mp4')
    expect(ctx.brand).toMatchObject({ kitId: 'kit-1', name: 'Tea Co' })
    expect(ctx.decisions.sceneCount).toBe(3)
    expect(ctx.decisions.narration).toEqual(['First, water.', 'Then leaves.'])
    expect(ctx.decisions.musicMood).toBe('playful')
  })

  it('captures what an app recording was made of', () => {
    put(join(roots.appRecon, 'apps.json'), [{ id: 'app-1', name: 'Acme', url: 'https://acme.test', context: 'show the new dashboard', signIn: 'none', depth: 'thorough', mode: 'walkthrough', targetSec: 44, platform: 'youtube', useAi: true, brandId: 'kit-2', checks: { stayOnSites: true } }])
    put(join(roots.appRecon, 'runs', 'run-ef56', 'run.json'), { id: 'run-ef56', appId: 'app-1', status: 'done', video: 'final/walkthrough.mp4', durationSec: 41, pages: 3, actions: 7, notes: ['blurred one email'] })
    put(join(roots.appRecon, 'runs', 'run-ef56', 'beats.json'), [{ beat: 1, kind: 'line', chapter: 'Home', text: 'Welcome to Acme' }])
    const ctx = captureFeedbackContext('app', 'run-ef56', roots)
    expect(ctx.prompt).toBe('show the new dashboard')
    expect(ctx.videoPath).toBe('final/walkthrough.mp4')
    expect(ctx.targetSec).toBe(44)
    expect(ctx.durationSec).toBe(41)
    expect(ctx.brand).toEqual({ kitId: 'kit-2' })
    const app = ctx.decisions.app as Record<string, unknown>
    expect(app.name).toBe('Acme')
    expect(app.depth).toBe('thorough')
    expect((ctx.decisions.run as Record<string, unknown>).pages).toBe(3)
    expect(ctx.decisions.beats).toEqual([{ kind: 'line', chapter: 'Home', text: 'Welcome to Acme' }])
  })

  it('captures what a market film was made of, including its card and brand', () => {
    put(join(roots.marketing, 'businesses.json'), [{ id: 'biz-1', domain: 'acme.test', name: 'Acme Bakery', tagline: 'Bread, daily', agentMode: 'ask', brand: { colors: ['#aabbcc', '#112233'], accent: 'aabbcc' }, cards: [{ id: 'card-1', title: 'Fresh sourdough', problem: 'Store bread is stale', solution: 'Baked every morning', cta: 'Order today', targetSec: 30, platform: 'reels', brief: 'Keep it warm and slow' }] }])
    put(join(roots.marketing, 'runs', 'mrun-78', 'run.json'), { id: 'mrun-78', businessId: 'biz-1', cardId: 'card-1', status: 'done', video: 'marketing.mp4', durationSec: 29, revision: { request: 'no music', changed: ['music'], kept: ['voice'], cannot: [] } })
    put(join(roots.marketing, 'runs', 'mrun-78', 'market-plan.json'), { plan: { goal: 'Sell sourdough', audience: 'locals', points: [{ say: 'Baked at dawn' }, { say: 'Delivered by nine' }], targetSec: 30, platform: 'reels', music: 'none' } })
    const ctx = captureFeedbackContext('market', 'mrun-78', roots)
    expect(ctx.prompt).toBe('Keep it warm and slow') // the person's own brief
    expect(ctx.platform).toBe('reels')
    expect(ctx.durationSec).toBe(29)
    expect(ctx.brand).toMatchObject({ name: 'Acme Bakery', domain: 'acme.test', colors: ['#aabbcc', '#112233'] })
    const card = ctx.decisions.card as Record<string, unknown>
    expect(card.title).toBe('Fresh sourdough')
    expect((ctx.decisions.plan as Record<string, unknown>).points).toEqual(['Baked at dawn', 'Delivered by nine'])
    expect(ctx.extras?.revision).toMatchObject({ request: 'no music' })
  })

  it('never throws: an unknown video leaves a partial context, and odd ids are refused', () => {
    expect(captureFeedbackContext('create', 'never-made', roots).prompt).toBe('')
    expect(captureFeedbackContext('market', '../../etc', roots).prompt).toBe('')
    const odd = captureFeedbackContext('app', '..', roots)
    expect(odd.prompt).toBe('')
    expect((odd.decisions.app as Record<string, unknown>).name).toBeUndefined()
    expect(odd.decisions.beats).toEqual([])
  })

  it('captures an Edit footage video by its edit id, and a generated library asset by its id', () => {
    put(join(roots.footage, 'trip-1', 'project.json'), { id: 'trip-1', name: 'Trip', clips: [{ id: 'c1' }, { id: 'c2' }], edits: [{ id: 'ed12ab34', title: 'Best bits', createdAt: '2026-02-02T00:00:00Z', prompt: 'a fast recap', shape: 'tiktok', durationSec: 21, file: 'edits/best.mp4' }] })
    const f = captureFeedbackContext('footage', 'ed12ab34', roots)
    expect(f.prompt).toBe('a fast recap')
    expect(f.durationSec).toBe(21)
    expect(f.videoPath).toBe('edits/best.mp4')
    expect(f.decisions).toMatchObject({ title: 'Best bits', project: { id: 'trip-1', clips: 2 } })
    put(join(roots.library, 'image', 'image-abc-123.json'), { id: 'image-abc-123', kind: 'image', source: 'generated', title: 'Teapot', file: 'image-abc-123.png', prompt: 'a red teapot', provider: 'gemini', model: 'flash', tags: ['tea'], usedIn: ['p1'], costUsd: 0.04 })
    const a = captureFeedbackContext('asset', 'image-abc-123', roots)
    expect(a.prompt).toBe('a red teapot')
    expect(a.decisions).toMatchObject({ kind: 'image', provider: 'gemini', model: 'flash' })
    expect(a.extras).toMatchObject({ costUsd: 0.04, usedIn: 1 })
    expect(captureFeedbackContext('asset', 'nope', roots).prompt).toBe('')
    expect(captureFeedbackContext('footage', 'nope', roots).prompt).toBe('')
  })
})
