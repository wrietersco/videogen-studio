import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ffmpegBin } from '../src/main/audio/pcm'
import { canShowWindow, findChrome } from '../src/main/appRecon/browser'
import { clipLength, keyframePrompt, openingPicture, runAppRecording, type MediaTools, type RunHooks, type RunInput } from '../src/main/appRecon/run'
import { DEMO_PASS, DEMO_USER, startAppSite, type AppSite } from './fixtures/appSite'

const clipStub = async (): Promise<{ file: string }> => ({ file: 'x.mp4' })

describe('the opening picture for an AI clip (no browser)', () => {
  it('asks for the first frame of the shot and lengthens a lone clip in a long film', () => {
    expect(keyframePrompt('a sunrise')).toBe('First frame of this shot, a still photograph: a sunrise')
    expect(clipLength(3, 1, 44)).toBe(5)
    expect(clipLength(3, 1, 20)).toBe(3)
    expect(clipLength(3, 2, 44)).toBe(3)
  })

  it('does nothing without a still tool', async () => {
    const notes: string[] = []
    expect(await openingPicture({ clip: clipStub, music: async () => Buffer.alloc(0) }, 'p', 0, notes)).toEqual({})
    expect(notes).toEqual([])
  })

  it('uses a checked still and says so', async () => {
    const notes: string[] = []
    const t: MediaTools = { clip: clipStub, music: async () => Buffer.alloc(0), still: async () => ({ file: 'a.jpg' }), reviewStill: async () => ({ ok: true }) }
    expect(await openingPicture(t, 'p', 0, notes)).toEqual({ imageFile: 'a.jpg' })
    expect(notes.join(' ')).toMatch(/started from a keyframe/)
  })

  it('retries once, then skips the clip when the picture fails twice', async () => {
    const notes: string[] = []
    let made = 0
    const t: MediaTools = { clip: clipStub, music: async () => Buffer.alloc(0), still: async () => ({ file: `s${++made}.jpg` }), reviewStill: async () => ({ ok: false }) }
    expect(await openingPicture(t, 'p', 0, notes)).toEqual({ skip: true })
    expect(made).toBe(2)
    expect(notes.join(' ')).toMatch(/did not pass the check, so no clip was paid for/)
  })

  it('keeps the second picture when the first fails and the retry passes', async () => {
    const notes: string[] = []
    let made = 0
    const t: MediaTools = { clip: clipStub, music: async () => Buffer.alloc(0), still: async () => ({ file: `s${++made}.jpg` }), reviewStill: async (f) => ({ ok: f === 's2.jpg' }) }
    expect(await openingPicture(t, 'p', 1, notes)).toEqual({ imageFile: 's2.jpg' })
    expect(notes.join(' ')).toMatch(/made again/)
  })

  it('falls back to text-only when the still fails, with a note', async () => {
    const notes: string[] = []
    const t: MediaTools = { clip: clipStub, music: async () => Buffer.alloc(0), still: async () => { throw new Error('quota') } }
    expect(await openingPicture(t, 'p', 0, notes)).toEqual({})
    expect(notes.join(' ')).toMatch(/starts from text only/)
  })

  it('uses the still unchecked when no review exists', async () => {
    const t: MediaTools = { clip: clipStub, music: async () => Buffer.alloc(0), still: async () => ({ file: 'u.jpg' }) }
    expect(await openingPicture(t, 'p', 0, [])).toEqual({ imageFile: 'u.jpg' })
  })
})

function ff(args: string[]): void {
  const r = spawnSync(ffmpegBin(), ['-hide_banner', '-v', 'error', '-y', ...args])
  if (r.status !== 0) throw new Error(r.stderr?.toString())
}
const hooks = (): RunHooks => ({ progress: () => undefined, handoff: async () => { throw new Error('no hand-off expected') } })

describe.skipIf(!findChrome() || !canShowWindow())('a film whose AI clip starts from a keyframe (stand-in models)', () => {
  let site: AppSite
  let root: string
  beforeAll(async () => {
    site = await startAppSite()
    root = mkdtempSync(join(tmpdir(), 'vg-keyframe-'))
  }, 120000)
  afterAll(async () => {
    await site?.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }, 60000)

  it('makes and checks the still before the clip, and hands it to the clip', async () => {
    const order: string[] = []
    let imageSeen: string | undefined
    const tools: MediaTools = {
      still: async (prompt) => {
        order.push(`still:${prompt.startsWith('First frame of this shot')}`)
        const file = join(root, `still-${order.length}.jpg`)
        ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=1:duration=1', '-frames:v', '1', file])
        return { file, costUsd: 0.04 }
      },
      reviewStill: async () => {
        order.push('review')
        return { ok: order.filter((o) => o === 'review').length > 1 } // first fails, the retry passes
      },
      clip: async (_p, seconds, opts) => {
        order.push('clip')
        imageSeen = opts?.imageFile
        const file = join(root, 'clip.mp4')
        ff(['-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=24:duration=${seconds}`, '-pix_fmt', 'yuv420p', file])
        return { file, durationSec: seconds }
      },
      music: async () => { writeFileSync(join(root, 'n'), 'x'); return Buffer.alloc(0) }
    }
    const input: RunInput = {
      runDir: join(root, 'film'), startUrl: `${site.url}/login`, context: 'Show the dashboard. I need an AI video to illustrate the workflow as a beautiful motion diagram.',
      mode: 'walkthrough', signIn: 'saved', vault: { username: DEMO_USER, password: DEMO_PASS }, guardrailText: '', checks: {}, depth: 'quick', targetSec: 20, chat: null, speech: null,
      media: { tools, clips: false, music: false }
    }
    const out = await runAppRecording(input, hooks())
    expect(out.aiClips).toBe(1)
    expect(order).toEqual(['still:true', 'review', 'still:true', 'review', 'clip'])
    expect(imageSeen).toBe(join(root, 'still-3.jpg'))
    expect(out.mediaNotes?.join(' ')).toMatch(/started from a keyframe picture/)
    expect(out.mediaNotes?.join(' ')).toMatch(/made again/)
  }, 300000)
})
