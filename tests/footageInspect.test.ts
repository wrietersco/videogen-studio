import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FootageClip, FootageShot, TranscriptLine } from '../src/shared/footage'
import { clusterCast, deriveClipInsights, offscreenSpeechOf, summarizeTopic, watchClip } from '../src/main/footage/understand'
import { hintDefects, measureFrames, type ShotMeasurements } from '../src/main/footage/inspect'
import type { GenerateJSONRequest, LLMProvider } from '../src/main/providers/types'

// pure and stubbed tests only: no ffmpeg fixtures, no Electron

let root: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'footage-inspect-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const measure = (sharpness = 0.8, shake = 0.2, mean = 0.5, darkFrac = 0, brightFrac = 0): ShotMeasurements => ({
  sharpness,
  shake,
  exposure: { mean, darkFrac, brightFrac }
})

const line = (startSec: number, endSec: number, text: string): TranscriptLine => ({ startSec, endSec, text })

const clip = (over: Partial<FootageClip> & { id: string }): FootageClip => ({
  path: `C:/v/${over.id}.mp4`, name: `${over.id}.mp4`, folder: 'C:/v', sizeBytes: 1, mtimeMs: 1, durationSec: 10, width: 1920, height: 1080, fps: 30, hasAudio: true, lufs: -23,
  shots: [], watched: true, listened: true, status: 'ok', ...over
})

const shot = (over: Partial<FootageShot> = {}): FootageShot => ({ startSec: 0, endSec: 2, ...over }) as FootageShot

const model = (reply: () => unknown, asked: GenerateJSONRequest[] = []): LLMProvider => ({
  id: 'openai', label: 'fake', isConfigured: async () => true, listModels: async () => [], generateText: async () => '',
  generateJSON: async <T,>(r: GenerateJSONRequest) => { asked.push(r); return reply() as T }
})

describe('local defect hints', () => {
  it('flags each measured defect exactly at its threshold', () => {
    expect(hintDefects(measure())).toEqual([])
    expect(hintDefects(measure(0.29))).toEqual(['misfocused'])
    expect(hintDefects(measure(0.3))).toEqual([])
    expect(hintDefects(measure(0.8, 0.61))).toEqual(['shaky'])
    expect(hintDefects(measure(0.8, 0.6))).toEqual([])
    expect(hintDefects(measure(0.8, 0.2, 0.19, 0.3, 0.005))).toEqual(['tooDark'])
    // a bright patch means the scene is not simply dark
    expect(hintDefects(measure(0.8, 0.2, 0.19, 0.3, 0.01))).toEqual([])
    expect(hintDefects(measure(0.8, 0.2, 0.2, 0.3, 0))).toEqual([])
    expect(hintDefects(measure(0.8, 0.2, 0.83))).toEqual(['tooBright'])
    expect(hintDefects(measure(0.8, 0.2, 0.82))).toEqual([])
    expect(hintDefects(measure(0.8, 0.2, 0.5, 0.3, 0.31))).toEqual(['tooBright'])
    expect(hintDefects(measure(0.8, 0.2, 0.5, 0.3, 0.3))).toEqual([])
  })

  it('combines defects and never hints backlit or tilted (vision-only)', () => {
    expect(hintDefects(measure(0.1, 0.95, 0.05))).toEqual(['misfocused', 'shaky', 'tooDark'])
    expect(hintDefects(measure(0.1, 0.95, 0.98, 0, 0.99))).toEqual(['misfocused', 'shaky', 'tooBright'])
    expect(hintDefects(measure()).some((d) => d === 'backlit' || d === 'tilted')).toBe(false)
  })

  it('measures sharpness, shake and exposure from raw frames', () => {
    const w = 96
    const h = 54
    const flat = new Uint8Array(w * h).fill(100)
    const m = measureFrames([flat, flat], w, h)
    expect(m).toMatchObject({ sharpness: 0, shake: 0 })
    expect(m.exposure.mean).toBeCloseTo(100 / 255, 3)
    // a hard edge moved 3px between samples moves the energy centroid exactly 3px
    const edge = (at: number) => new Uint8Array(w * h).map((_, i) => (i % w >= at ? 255 : 0))
    const e = measureFrames([edge(30), edge(33)], w, h)
    expect(e.sharpness).toBe(1)
    expect(e.shake).toBeCloseTo(3 / (0.06 * w), 2)
  })
})

describe('clustering cast members from appearances', () => {
  it('clusters one person phrased differently, and keeps distinct people apart', () => {
    const person = [
      shot({ startSec: 0, appearance: 'man in a red jacket with a grey beard' }),
      shot({ startSec: 2, appearance: 'the red-jacketed man, grey beard' }),
      shot({ startSec: 4, appearance: 'grey beard, red jacket' })
    ]
    const others = [shot({ startSec: 6, appearance: 'woman in a yellow dress' }), shot({ startSec: 8, appearance: 'a dog, no people' })]
    const { cast, shots } = clusterCast([...person, ...others])
    // ids follow first-sighting order: the bearded man was seen first
    expect(cast.map((c) => [c.id, c.sightings])).toEqual([['p1', 3], ['p2', 1], ['p3', 1]])
    expect(cast[0].appearance).toBe('man in a red jacket with a grey beard')
    expect(shots.slice(0, 3).every((s) => s.castIds)).toBe(true)
    expect(shots.slice(0, 3).every((s) => s.castIds![0] === 'p1')).toBe(true)
    expect(shots[3].castIds).toEqual(['p2'])
    expect(shots[4].castIds).toEqual(['p3'])
  })

  it('leaves shots without an appearance out of the cast and never mutates the input', () => {
    const input = [shot({ startSec: 0, appearance: 'man in a red jacket' }), shot({ startSec: 2 })]
    const { cast, shots } = clusterCast(input)
    expect(cast).toHaveLength(1)
    expect('castIds' in shots[1]).toBe(false)
    expect('castIds' in input[0]).toBe(false)
    expect('castIds' in input[1]).toBe(false)
    expect(shots[0]).not.toBe(input[0])
  })
})

describe('off-screen speech', () => {
  const shotsOf = (...shots: FootageShot[]) => shots

  it('hears a voice behind the camera when nobody visible is talking', () => {
    const voiceOver = clip({ id: 'vo', shots: shotsOf(shot({ startSec: 0, endSec: 10, people: 0 })), transcript: [line(1, 4, 'we started early that morning')] })
    expect(offscreenSpeechOf(voiceOver)).toEqual([{ startSec: 1, endSec: 4 }])
    // people visible, someone talking on camera: not off-screen
    const talking = clip({ id: 'talk', shots: shotsOf(shot({ startSec: 0, endSec: 10, people: 2, talkingVisible: true })), transcript: [line(1, 4, 'look at this')] })
    expect(offscreenSpeechOf(talking)).toEqual([])
    // people visible but NOT talking: the speaker is behind the camera again
    const silent = clip({ id: 'silent', shots: shotsOf(shot({ startSec: 0, endSec: 10, people: 2, talkingVisible: false })), transcript: [line(1, 4, 'look at this')] })
    expect(offscreenSpeechOf(silent)).toEqual([{ startSec: 1, endSec: 4 }])
    // unwatched shots (no people/talkingVisible) never count as off-screen
    const unknown = clip({ id: 'unwatched', shots: shotsOf(shot({ startSec: 0, endSec: 10 })), transcript: [line(1, 4, 'maybe')] })
    expect(offscreenSpeechOf(unknown)).toEqual([])
  })

  it('uses the 60% rule for lines that straddle on- and off-camera shots', () => {
    const c = clip({
      id: 'mix',
      shots: shotsOf(shot({ startSec: 0, endSec: 5, people: 0 }), shot({ startSec: 5, endSec: 10, people: 2, talkingVisible: true })),
      transcript: [line(3, 7, 'fifty percent off camera'), line(2, 6, 'seventy five percent off camera')]
    })
    expect(offscreenSpeechOf(c)).toEqual([{ startSec: 2, endSec: 6 }])
  })

  it('merges adjacent lines and caps the list at 40 spans', () => {
    const merging = clip({ id: 'm', shots: shotsOf(shot({ startSec: 0, endSec: 10, people: 0 })), transcript: [line(1, 2, 'a'), line(2, 3, 'b')] })
    expect(offscreenSpeechOf(merging)).toEqual([{ startSec: 1, endSec: 3 }])
    const many = clip({
      id: 'many',
      shots: shotsOf(shot({ startSec: 0, endSec: 200, people: 0 })),
      transcript: Array.from({ length: 45 }, (_, i) => line(i * 2, i * 2 + 0.5, `line ${i}`))
    })
    expect(offscreenSpeechOf(many)).toHaveLength(40)
  })
})

describe('watching shots with the richer answers', () => {
  const keyframes = (dir: string, n: number) => {
    mkdirSync(dir, { recursive: true })
    for (let i = 1; i <= n; i++) writeFileSync(join(dir, `f${i}.jpg`), 'not really a jpeg')
    return Array.from({ length: n }, (_, i) => `f${i + 1}.jpg`)
  }

  it('clamps the model answers onto shots, forwards the model, and sends the measured hints', async () => {
    const dir = join(root, 'watch')
    const frames = keyframes(dir, 2)
    // the clip's video does not exist: the local inspection fails quietly and sends no hints
    const c = clip({
      id: 'w',
      path: join(dir, 'missing.mp4'),
      watched: false,
      shots: [
        { startSec: 0, endSec: 2, frame: frames[0] },
        { startSec: 2, endSec: 4, frame: frames[1] }
      ]
    })
    const asked: GenerateJSONRequest[] = []
    await watchClip(
      model(() => ({
        shots: [
          {
            n: 1, description: '  a woman smiles at the camera  ', tags: ['Family', ''], score: 99,
            people: 55, talkingVisible: 'yes', emotion: ['joy', 'JOY ', 'love', 'anger', 'nonsense'],
            objects: ['Birthday CAKE', ' ', 'table', 'balloon', 'party hat', 'extra', 'more'],
            topic: 'a birthday party at home with cake and candles and everyone singing songs together happily',
            defects: ['tooDark', 'made-up', 'shaky', 'tilted'],
            appearance: 'a woman with short blonde hair and glasses and a bright red scarf and boots and mittens'
          },
          { n: 2, description: 'an empty street', tags: ['street'], score: 3 }
        ]
      }), asked),
      c, dir, () => false, 'gpt-6-luna-mini'
    )
    const s = c.shots[0] as FootageShot & { appearance?: string }
    expect(s).toMatchObject({ description: 'a woman smiles at the camera', tags: ['family'], score: 10, people: 20, emotion: ['joy', 'love'] })
    expect(s.talkingVisible).toBeUndefined() // not a boolean: left alone
    expect(s.objects).toEqual(['birthday cake', 'table', 'balloon', 'party hat', 'extra'])
    expect(s.topic!.length).toBeLessThanOrEqual(60)
    expect(s.topic!.startsWith('a birthday party')).toBe(true)
    expect(s.defects).toEqual(['tooDark', 'shaky', 'tilted'])
    expect(s.appearance!.split(' ')).toHaveLength(12)
    expect(c.shots[1]).toMatchObject({ description: 'an empty street', tags: ['street'], score: 3 })
    expect('people' in c.shots[1]).toBe(false)
    expect(c.watched).toBe(true)
    // one call, both frames, measured hints (empty here) alongside each, model forwarded
    expect(asked).toHaveLength(1)
    expect(asked[0].model).toBe('gpt-6-luna-mini')
    expect(asked[0].images).toHaveLength(2)
    const sent = JSON.parse(asked[0].prompt)
    expect(sent.frames.map((f: { n: number }) => f.n)).toEqual([1, 2])
    expect(sent.frames[0].measuredDefects).toEqual([])
    // without a model override, none is sent
    const asked2: GenerateJSONRequest[] = []
    const c2 = clip({ id: 'w2', path: join(dir, 'missing.mp4'), watched: false, shots: [{ startSec: 0, endSec: 2, frame: frames[0] }] })
    await watchClip(model(() => ({ shots: [{ n: 1, description: 'a cat', tags: ['cat'], score: 5 }] }), asked2), c2, dir, () => false)
    expect(asked2[0].model).toBeUndefined()
    expect(c2.watched).toBe(true)
  })
})

describe('clip-level insights', () => {
  it('derives off-screen speech and dead air without ever throwing', async () => {
    const mute = clip({ id: 'mute', hasAudio: false, lufs: undefined, shots: [shot({ startSec: 0, endSec: 10, people: 0 })], transcript: [line(1, 4, 'hello')] })
    await deriveClipInsights(mute)
    expect(mute.offscreenSpeech).toEqual([{ startSec: 1, endSec: 4 }])
    expect(mute.longPauses).toBeUndefined() // nothing to listen to
    // unreadable audio: the silencedetect pass fails, the clip still gets its speech spans
    const broken = clip({ id: 'broken', path: join(root, 'no-such-file.mp4'), shots: [shot({ startSec: 0, endSec: 10, people: 0 })], transcript: [line(1, 4, 'hello')] })
    await expect(deriveClipInsights(broken)).resolves.toBeUndefined()
    expect(broken.longPauses).toEqual([])
    expect(broken.offscreenSpeech).toEqual([{ startSec: 1, endSec: 4 }])
  })
})

describe('naming clips from their transcripts', () => {
  const long = (n: number) => 'word '.repeat(n).trim()

  it('names every watched-and-listened clip in one call, ignoring junk refs', async () => {
    const a = clip({ id: 'a', watched: true, listened: true, transcript: [line(0, 3, long(40))] })
    const b = clip({ id: 'b', watched: true, listened: true })
    const c = clip({ id: 'c', watched: false, listened: false, transcript: [line(0, 2, 'not ready')] })
    const asked: GenerateJSONRequest[] = []
    await summarizeTopic(
      model(() => ({ topics: [{ ref: 'c1', topic: '  a walk along the river  ' }, { ref: 'c9', topic: 'bogus' }, { ref: 'c2', topic: 'x'.repeat(200) }] }), asked),
      [a, b, c], () => false, 'gpt-6-luna-mini'
    )
    expect(a.topic).toBe('a walk along the river')
    expect(b.topic).toHaveLength(80)
    expect(c.topic).toBeUndefined()
    expect(asked).toHaveLength(1)
    expect(asked[0].model).toBe('gpt-6-luna-mini')
    const sent = JSON.parse(asked[0].prompt)
    expect(sent.clips.map((x: { ref: string }) => x.ref)).toEqual(['c1', 'c2'])
    expect(sent.clips[0].transcript[0].text).toHaveLength(80) // lines trimmed to 80 chars
  })

  it('keeps the payload small and survives provider failures', async () => {
    const big = clip({ id: 'big', watched: true, listened: true, transcript: Array.from({ length: 500 }, (_, i) => line(i, i + 1, long(30))) })
    const asked: GenerateJSONRequest[] = []
    await summarizeTopic(model(() => ({ topics: [{ ref: 'c1', topic: 't' }] }), asked), [big], () => false)
    expect(asked[0].prompt.length).toBeLessThanOrEqual(20_000)
    expect(big.topic).toBe('t')
    const doomed = clip({ id: 'doom', watched: true, listened: true, transcript: [line(0, 1, 'hello')] })
    await expect(summarizeTopic(model(() => { throw new Error('down') }), [doomed], () => false)).resolves.toBeUndefined()
    expect(doomed.topic).toBeUndefined()
  })
})
