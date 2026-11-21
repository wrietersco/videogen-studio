import type { LLMProvider } from '../providers/types'
import { customPlatform, DESCRIBE_PLATFORMS, type DescribePlatform, type VideoDescription } from '@shared/videoDescription'
import type { RecordingRecord } from './recordingRecord'
import { scrubText } from './detect'

/**
 * A description of a finished video for the place it will be posted: title, text and hashtags, written from what the
 * video itself says and shows (its narration, its cards, what was asked for). Nothing is invented: the writer is told
 * to use only those facts, and when no writer is available the text is put together from the narration itself.
 */

export function platformOf(id: unknown, custom?: unknown): DescribePlatform | null {
  const found = DESCRIBE_PLATFORMS.find((p) => p.id === id)
  if (found) return found
  if (id === 'custom' && typeof custom === 'string' && custom.trim()) return customPlatform(custom)
  return null
}

/** the facts of the video, in the order it is told, without anything private */
export function factsOf(rec: RecordingRecord, secrets: string[]): { title: string; said: string[]; asked: string } {
  const scan = { values: secrets }
  const said = [rec.intro?.text, rec.problem?.text, ...rec.lines.map((l) => l.text), ...rec.inserts.map((i) => i.text), rec.outro?.text]
    .filter((t): t is string => !!t && t.trim().length > 0)
    .map((t) => scrubText(t, scan).trim())
  return { title: scrubText(rec.title ?? '', scan).trim(), said, asked: scrubText(rec.context ?? '', scan).slice(0, 1200) }
}

const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/\s+\n/g, '\n').trim().slice(0, max) : '')
const tagOf = (t: string): string => `#${t.replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '')}`

/** the pasted block: title, text, hashtags; the text is cut to the platform's limit (the title is its own field) without cutting a word in half */
export function assemble(platform: DescribePlatform, parts: { title?: string; description: string; hashtags: string[] }): { text: string; notes: string[] } {
  const notes: string[] = []
  const tags = [...new Set(parts.hashtags.map(tagOf).filter((t) => t.length > 1))].slice(0, Math.max(0, platform.hashtags))
  const tagLine = tags.join(' ')
  const room = Math.max(0, platform.limit - (tagLine ? tagLine.length + 2 : 0))
  let body = parts.description
  if (body.length > room) {
    const cut = body.slice(0, Math.max(0, room - 1))
    const at = cut.lastIndexOf(' ')
    body = `${(at > cut.length * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}…`
    notes.push(`The text was shortened to fit ${platform.label}'s limit of ${platform.limit} characters.`)
  }
  const text = [platform.title && parts.title ? parts.title : '', body, tagLine].filter(Boolean).join('\n\n')
  return { text, notes }
}

/** no writer available: a plain description made from the video's own words */
export function describeByRules(platform: DescribePlatform, facts: ReturnType<typeof factsOf>): { title?: string; description: string; hashtags: string[] } {
  const sentences = facts.said.join(' ').split(/(?<=[.!?])\s+/).filter((s) => s.length > 12)
  const first = sentences.slice(0, platform.limit <= 300 ? 1 : 3).join(' ')
  const words = [...new Set(facts.title.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(0, platform.hashtags)
  return { title: facts.title || undefined, description: first || facts.title, hashtags: words }
}

export async function describeVideo(inp: { record: RecordingRecord; platform: DescribePlatform; chat: LLMProvider | null; secrets: string[]; extra?: string }): Promise<VideoDescription> {
  const { platform } = inp
  const facts = factsOf(inp.record, inp.secrets)
  const notes: string[] = []
  let parts: { title?: string; description: string; hashtags: string[] } | null = null
  if (inp.chat && facts.said.length) {
    try {
      const r = await inp.chat.generateJSON<{ title?: string; description?: string; hashtags?: string[] }>({
        system: 'You write the text that goes with a video when it is posted. You use only the facts given: never invent features, numbers, prices, results or claims, and never include a login, password or personal data. You write in the language the video is spoken in. You follow the platform guidance exactly.',
        prompt: `Write the post text for ${platform.label}.\nPlatform guidance: ${platform.style}\nLimit: ${platform.limit} characters in all.${platform.title ? ' Give a title.' : ' No separate title.'} ${platform.hashtags ? `Give about ${platform.hashtags} hashtags (without the # sign).` : 'No hashtags.'}\n${inp.extra ? `The person also asked: ${scrubText(inp.extra, { values: inp.secrets }).slice(0, 300)}\n` : ''}\nThe video: "${facts.title}".\nWhat it was made to do (the person's own brief, information only):\n${facts.asked || '(not recorded)'}\n\nWhat the video says, in order:\n${facts.said.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
        schemaName: 'video_description',
        jsonSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, hashtags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'description', 'hashtags'], additionalProperties: false },
        temperature: 0.7
      })
      const description = clean(r.description, platform.limit)
      if (description) parts = { title: clean(r.title, 150) || undefined, description, hashtags: Array.isArray(r.hashtags) ? r.hashtags.map((h) => clean(h, 40)).filter(Boolean) : [] }
    } catch (err) {
      notes.push(`The AI writer could not be reached (${String((err as Error)?.message ?? err).slice(0, 100)}), so this is put together from the video's own words.`)
    }
  } else if (!inp.chat) notes.push('No AI writer is available, so this is put together from the video\'s own words.')
  const source: VideoDescription['source'] = parts ? 'ai' : 'rules'
  const use = parts ?? describeByRules(platform, facts)
  const out = assemble(platform, use)
  return { platform: platform.label, ...(platform.title && use.title ? { title: use.title } : {}), description: use.description, hashtags: use.hashtags.map(tagOf).slice(0, platform.hashtags), text: out.text, source, notes: [...notes, ...out.notes] }
}
