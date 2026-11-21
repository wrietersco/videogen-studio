import { describe, expect, it } from 'vitest'
import type { LLMProvider } from '../src/main/providers/types'
import type { RecordingRecord } from '../src/main/appRecon/recordingRecord'
import { assemble, describeByRules, describeVideo, factsOf, platformOf } from '../src/main/appRecon/description'
import { DESCRIBE_PLATFORMS } from '../src/shared/videoDescription'

const rec = {
  version: 1, mode: 'walkthrough', size: { width: 1280, height: 720 }, offsetSec: 0, title: 'Taaweel: the even-odd circle', tone: '', voiced: true,
  context: 'Show the even-odd circle. Log in as hunter2 first.',
  lines: [{ beat: 1, chapter: 'Circle', text: 'The even-odd circle shows every verse as a point on a ring. Even verses sit on one side.' }, { beat: 2, chapter: 'An-Nur', text: 'Switch to Surah An-Nur to see its own structure.' }],
  outro: { headline: 'Taaweel', text: 'Try Taaweel today.' }, inserts: [], music: { source: 'none', mood: 'calm' }, raw: 'final/raw.mp4'
} as unknown as RecordingRecord
const chat = (out: unknown): LLMProvider => ({ generateJSON: async () => out } as unknown as LLMProvider)

describe('platforms', () => {
  it('knows the usual places and any typed name', () => {
    expect(platformOf('tiktok')?.label).toBe('TikTok')
    expect(platformOf('custom', 'Bilibili')?.label).toBe('Bilibili')
    expect(platformOf('custom', '  ')).toBeNull()
    expect(platformOf('nope')).toBeNull()
    expect(new Set(DESCRIBE_PLATFORMS.map((p) => p.id)).size).toBe(DESCRIBE_PLATFORMS.length)
  })
})

describe('describing a finished video', () => {
  it('never hands a secret to the writer', () => {
    expect(JSON.stringify(factsOf(rec, ['hunter2']))).not.toContain('hunter2')
  })
  it('cuts the text to the platform limit without a half word, keeping the hashtags', () => {
    const x = platformOf('x')!
    const out = assemble(x, { description: 'word '.repeat(100), hashtags: ['Taaweel', 'Quran', 'Data'] })
    expect(out.text.length).toBeLessThanOrEqual(x.limit)
    expect(out.text).toMatch(/…\n\n#Taaweel #Quran$/)
    expect(out.notes.join(' ')).toMatch(/shortened/)
  })
  it('writes with the AI writer, keeps a title only where the platform has one, and limits hashtags', async () => {
    const reply = { title: 'The even-odd circle', description: 'See every verse on a ring.', hashtags: ['#Quran', 'Taaweel', 'a', 'b', 'c', 'd'] }
    const yt = await describeVideo({ record: rec, platform: platformOf('youtube')!, chat: chat(reply), secrets: [] })
    expect(yt.source).toBe('ai')
    expect(yt.text).toMatch(/^The even-odd circle\n\nSee every verse on a ring\.\n\n#Quran #Taaweel/)
    const tt = await describeVideo({ record: rec, platform: platformOf('tiktok')!, chat: chat(reply), secrets: [] })
    expect(tt.title).toBeUndefined()
    expect(tt.text.startsWith('See every verse')).toBe(true)
    const wa = await describeVideo({ record: rec, platform: platformOf('whatsapp')!, chat: chat(reply), secrets: [] })
    expect(wa.hashtags).toEqual([])
  })
  it('falls back to the video\'s own words, and says so, when there is no writer or it fails', async () => {
    const none = await describeVideo({ record: rec, platform: platformOf('facebook')!, chat: null, secrets: [] })
    expect(none.source).toBe('rules')
    expect(none.description).toMatch(/even-odd circle/)
    expect(none.notes.join(' ')).toMatch(/No AI writer/)
    const broken = await describeVideo({ record: rec, platform: platformOf('linkedin')!, chat: { generateJSON: async () => { throw new Error('offline') } } as unknown as LLMProvider, secrets: [] })
    expect(broken.source).toBe('rules')
    expect(broken.notes.join(' ')).toMatch(/could not be reached/)
    expect(describeByRules(platformOf('x')!, factsOf(rec, [])).description.length).toBeGreaterThan(10)
  })
})
