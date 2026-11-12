/**
 * Brief understanding for the free (programmatic) engine.
 *
 * No AI: rules that pull the parts a story needs out of the person's own
 * words: who or what it is about, what it is, who it is for, the things it
 * does, any real numbers, the mood, and what was asked for on screen. The
 * engine never invents facts, so everything it writes comes from here.
 */

export type BriefKind = 'product' | 'howto' | 'list' | 'versus' | 'why' | 'explainer' | 'idea'
export type Tone = 'calm' | 'hype' | 'premium' | 'friendly' | 'serious' | 'neutral'

export interface Brief {
  raw: string
  /** a name: "Northpeak" (empty when the brief has none) */
  subject: string
  /** what it is: "smart water bottle" */
  what: string
  /** the whole topic phrase, for briefs that are about an idea: "why retro gaming is back" */
  topic: string
  kind: BriefKind
  audience: string
  /** things it does or has, in the person's words: ["tracks your hydration", "trail map app"] */
  features: string[]
  /** numbers the person gave, with what they count: [{ value: '5', label: 'tips' }] */
  numbers: Array<{ value: string; label: string }>
  tone: Tone
  /** two sides of a comparison */
  versus: [string, string] | null
  /** lines the person wrote as their own script (bullets, numbered lines, "Scene 1:") */
  script: string[]
  wants: { endOnBrand: boolean; show: string[] }
  /** what the brief gave us: drives how rich the story can be */
  richness: number
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/^[\s,;:.\-–—]+|[\s,;:.\-–—]+$/g, '').trim()
const stripArticle = (s: string): string => clean(s.replace(/^(?:an?|the|our|your|my)\s+/i, ''))
const words = (s: string): string[] => clean(s).split(/\s+/).filter(Boolean)

const TONES: Array<[RegExp, Tone]> = [
  [/\b(calm|gentle|peaceful|serene|slow|meditat\w*|soothing|cinematic|golden[- ]hour)\b/i, 'calm'],
  [/\b(hype|energetic|punchy|snappy|fast|viral|frantic|high[- ]energy|bold|epic)\b/i, 'hype'],
  [/\b(luxury|premium|elegant|refined|sophisticated|high[- ]end|noir)\b/i, 'premium'],
  [/\b(fun|playful|friendly|cheerful|kids?|quirky|warm)\b/i, 'friendly'],
  [/\b(serious|corporate|professional|formal|enterprise|clinical)\b/i, 'serious']
]

const FORMAT_WORDS = /\b(?:\d{1,3}\s*[- ]?(?:seconds?|secs?|s|minutes?|mins?)|vertical|horizontal|landscape|portrait|square|short|video|clip|reel|tiktok|youtube|shorts|instagram|promo|promotional|advert|ad|intro|introduction|explainer|film|edit|trailer|teaser|animation|animated|motion graphics?)\b/gi

const BEAT_LINE = /^\s*(?:[-•*–]|\d{1,2}[.)]|scene\s*\d{1,2}\s*[:.\-–]|beat\s*\d{1,2}\s*[:.\-–])\s*(.+)$/i

const TONE_WORD = /\b(?:calm|gentle|peaceful|serene|slow|soothing|cinematic|golden[- ]hour|hype|energetic|punchy|snappy|fast|viral|bold|epic|luxury|premium|elegant|refined|noir|fun|playful|friendly|cheerful|quirky|warm|serious|corporate|professional|formal)\b/i

function toneOf(text: string): Tone {
  for (const [re, t] of TONES) if (re.test(text)) return t
  return 'neutral'
}

/** is this sentence only mood and format words ("Calm, golden-hour mood.")? */
function isMoodSentence(s: string): boolean {
  const ws = words(s.toLowerCase().replace(/[^a-z\- ]/g, ' '))
  if (!ws.length || ws.length > 7) return false
  return /\b(mood|vibe|feel|feeling|look|style|tone|aesthetic|palette)\b/i.test(s) || (TONES.some(([re]) => re.test(s)) && !/\b(show|end|start|open|make)\b/i.test(s) && ws.length <= 4)
}

export function parseBrief(raw: string): Brief {
  const src = String(raw ?? '').trim()

  // ---- the person's own script: bullets or numbered lines, one per scene ----
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  let beats = lines.map((l) => BEAT_LINE.exec(l)?.[1]).filter((x): x is string => Boolean(x)).map(clean).filter(Boolean)
  // a script pasted on one line: "Scene 1: ... Scene 2: ..."
  const inline = beats.length < 3 && /\bscene\s*\d{1,2}\s*[:.\-–]/i.test(src) ? src.split(/\bscene\s*\d{1,2}\s*[:.\-–]\s*/i).map(clean).filter(Boolean) : []
  if (inline.length >= 3) beats = inline
  const script = beats.length >= 3 ? beats.slice(0, 12) : []
  const prose = script.length ? (inline.length >= 3 ? '' : lines.filter((l) => !BEAT_LINE.test(l)).join(' ')) : lines.join(' ')

  const text = clean(prose || (script.length ? '' : src))
  const sentences = text.split(/(?<=[.!?])\s+/).map(clean).filter(Boolean)
  const wants = { endOnBrand: /\b(end|finish|close|finale|outro)\b[^.]*\b(brand|logo|name)\b|\blogo\b[^.]*\b(end|last)\b/i.test(src), show: [] as string[] }
  const body: string[] = []
  let tone: Tone = 'neutral'
  for (const s of sentences) {
    const show = /^(?:also\s+)?(?:show|include|feature|display|use|open with|start with|begin with)\s+(.+)$/i.exec(s)
    if (show) {
      for (const part of show[1].split(/,|\band\b/)) {
        const p = stripArticle(part.replace(/\b(?:then\s+)?(?:end|finish|close)\b.*$/i, ''))
        if (p && words(p).length <= 6) wants.show.push(p)
      }
      continue
    }
    if (/^(?:and\s+)?(?:end|finish|close)\b/i.test(s)) continue
    if (isMoodSentence(s)) {
      tone = toneOf(s) === 'neutral' ? tone : toneOf(s)
      continue
    }
    body.push(s)
  }
  const main = body[0] ?? text
  if (tone === 'neutral') tone = toneOf(src)
  /** the name that keeps coming back across a person's own script lines */
  const scriptSubject = (): string => {
    const seen = new Map<string, number>()
    for (const b of script) for (const m of b.matchAll(/\b([A-Z][a-zA-Z&'’-]{2,})\b/g)) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1)
    const ignore = new Set(['Meet', 'The', 'And', 'But', 'With', 'Your', 'Our', 'This', 'That', 'No', 'Now', 'Introducing', 'Scene', 'Beat'])
    return [...seen.entries()].filter(([w, n]) => n >= 2 && !ignore.has(w)).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
  }

  // ---- what is this about? strip the format words, keep what follows "for / about" ----
  let rest = main
    .replace(/^(?:please\s+)?(?:can you\s+)?(?:make|create|generate|produce|build|write|give)\s+(?:me\s+)?/i, '')
    .replace(/^(?:an?|the)\s+/i, '')
  const intro = /^(?:(?:\w+[\s-]+){0,6}?)(?:intro|introduction|explainer|video|promo|ad|advert|reel|film|edit|trailer|teaser|clip|short)\s+(?:for|about|of|on|showing|explaining)\s+(.+)$/i.exec(rest)
  if (intro) rest = intro[1]
  else rest = rest.replace(/^(?:\w+[\s-]+){0,3}?(?:about|on)\s+/i, (m) => (/\b(?:explain|show|tell)/i.test(m) ? m : ''))
  rest = clean(rest.replace(FORMAT_WORDS, ' ').replace(/\s{2,}/g, ' ').replace(/\s+([,;:])/g, '$1'))
  // a trailing mood ("..., calm and cinematic") is tone, not content
  rest = clean(rest.replace(new RegExp(`[,;:]?\\s*(?:${TONE_WORD.source}(?:\\s*(?:,|and|&)\\s*)?)+\\s*$`, 'i'), ''))
  rest = clean(rest.replace(/^(?:explain|describe|teach|show|tell(?: me)? about|talk about)\s+(?=how|why|what)/i, ''))

  // ---- comparison ----
  let versus: Brief['versus'] = null
  const vsText = rest.replace(/^(?:a\s+)?(?:comparing|compare|comparison of)\s+/i, '')
  const vs = /^(.{2,40}?)\s+(?:vs\.?|versus|compared (?:to|with))\s+(.{2,40}?)(?:\s+for\s+.+)?(?:[.,;:]|$)/i.exec(vsText)
  if (vs) versus = [stripArticle(vs[1]), stripArticle(vs[2])]

  // "Northpeak: a smart water bottle ..." / "Northpeak, a smart ..." / "Northpeak - ..."
  let subject = ''
  let desc = rest
  const head = /^(["“]?)([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,2})\1\s*(?::|—|–| - |,)\s*(.+)$/.exec(rest)
  if (head) {
    subject = head[2]
    desc = head[3]
  } else {
    const named = /\b(?:called|named|branded)\s+["“]?([A-Z][\w&'’.-]*(?:\s+[A-Z][\w&'’.-]*){0,2})["”]?/.exec(rest)
    if (named) subject = named[1]
    else {
      const proper = /(?:^|[\s(])((?:[A-Z][\w&'’.-]+)(?:\s+[A-Z][\w&'’.-]+){0,2})(?=[\s,.:;)]|$)/.exec(rest.replace(/^[A-Z][a-z]+\s+(?=(?:how|why|what|a|an|the)\b)/, ''))
      if (proper && !/^(?:Explain|Show|Make|Product|Why|How|What|Top|Best|The|A|An)$/.test(proper[1])) subject = proper[1]
    }
  }
  subject = script.length && !main ? scriptSubject() : clean(subject)

  // ---- audience: a trailing "for <people>" ----
  let audience = ''
  const aud = /\bfor\s+((?:[a-z][\w'’-]*\s+){0,3}[a-z][\w'’-]*)\s*$/i.exec(desc)
  if (aud && !/^(?:a|an|the|this|that|it|me|you|us|now)$/i.test(aud[1]) && !/^(?:\w+\s+)?(?:seconds?|minutes?)$/i.test(aud[1])) {
    audience = clean(aud[1].replace(/^(?:all|the)\s+/i, ''))
    desc = clean(desc.slice(0, aud.index))
  }

  // ---- what it is, and the things it does ----
  const pieces = desc.split(/\s*(?:,|;|\bpaired with\b|\bplus\b|\balong with\b|\bas well as\b|\band\b(?=\s+(?:[a-z]+s\b|an?\b|the\b))|\bwith\b|\bthat\b|\bwhich\b|\bwho\b|\bso you can\b)\s*/i).map(clean).filter(Boolean)
  // "Why sleep matters: 8 hours, 3 cycles" -> the topic on the left, facts on the right
  const colon = /^([^:]{3,60}):\s*(.+)$/.exec(desc)
  const factual = !head && Boolean(colon)
  const what = stripArticle(factual ? colon![1] : (pieces[0] ?? ''))
  const features = (factual ? colon![2].split(/\s*(?:,|;)\s*/).map(clean) : pieces.slice(1))
    .map((p) => stripArticle(p))
    .filter((p) => p && words(p).length <= 7 && !/^(?:it|is|are|was)$/i.test(p))
    .slice(0, 5)

  // ---- numbers with something they count (never a duration) ----
  const numbers: Brief['numbers'] = []
  for (const m of src.matchAll(/(\$?\d[\d,.]*\s?(?:%|k\b|m\b|x\b|×)?)\s*([a-z][a-z-]{2,}(?:\s+[a-z][a-z-]{2,})?)?/gi)) {
    const value = clean(m[1])
    const label = clean(m[2] ?? '')
    if (/^(?:seconds?|secs?|minutes?|mins?|vertical|horizontal|second|s)$/i.test(label.split(' ')[0] ?? '')) continue
    if (!/[%$kmx×]/i.test(value) && !label) continue
    if (/^\d{1,3}$/.test(value) && /^(?:second|sec|minute|min)/i.test(label)) continue
    numbers.push({ value, label })
    if (numbers.length >= 3) break
  }

  const topic = clean(rest)
  let kind: BriefKind = 'idea'
  if (script.length) kind = 'idea'
  else if (versus) kind = 'versus'
  else if (/\b\d{1,2}\s+(?:[a-z-]+\s+){0,2}(?:tips?|ways?|reasons?|things?|ideas?|facts?|mistakes?|hacks?|tricks?|signs?|steps?)\b/i.test(src)) kind = 'list'
  else if (/\b(?:how to|tutorial|step[- ]by[- ]step|guide)\b/i.test(src)) kind = 'howto'
  else if (/^\s*(?:explain|how)\b|\bhow\b[^.?]*\b(?:works?|is made|are made|happens?|does)\b/i.test(main)) kind = 'explainer'
  else if (/\bwhy\b/i.test(main)) kind = 'why'
  else if ((subject || what) && (features.length || /\b(?:app|software|platform|tool|product|device|bottle|gadget|service|brand|launch|new)\b/i.test(src))) kind = 'product'

  const richness = (subject ? 1 : 0) + (what ? 1 : 0) + Math.min(3, features.length) + (audience ? 1 : 0) + Math.min(2, numbers.length) + (script.length ? 3 : 0)
  return { raw: src, subject, what, topic, kind, audience, features, numbers, tone, versus, script, wants, richness }
}
