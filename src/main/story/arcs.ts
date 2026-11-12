import type { Scene } from '@shared/spec'
import type { Brief, Tone } from './brief'

/**
 * Story arcs for the free engine. A structure is chosen from what the brief
 * is (a product, a how-it-works, a list, a comparison, the person's own
 * script) and the copy is written from the person's own words. Nothing here
 * invents a fact, a number or a claim.
 */

export interface StoryScene {
  kind: Scene['kind']
  content: Record<string, unknown>
  weight: number
  /** what the voice says (natural sentence) */
  say: string
  /** higher stays when time is short (default 5) */
  prio?: number
}

type Rng = () => number

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length) % list.length]
const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)
export const titleCase = (s: string): string => s.replace(/\b([a-z])([a-z'’]*)/gi, (m, a: string, b: string) => (/^(?:a|an|and|as|at|but|by|for|in|of|on|or|the|to|vs)$/i.test(m) ? m.toLowerCase() : a.toUpperCase() + b))
const firstUpper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const trimWords = (s: string, n: number): string => s.split(/\s+/).slice(0, n).join(' ')
const article = (s: string): string => (/^(?:[aeiou]|hour|honest)/i.test(s) ? 'an' : 'a')
const withArticle = (s: string): string => (/^(?:the|a|an|your|our|my)\s/i.test(s) ? s : `${article(s)} ${s}`)
const endStop = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`)
/** "of testers woke up calmer" next to 94% reads "Testers woke up calmer" */
const statLabel = (s: string): string => cap(s.replace(/[.!]+$/, '').replace(/^(?:of|in|for|from)\s+/i, '').trim())
const isVerbPhrase =(f: string): boolean => /^(?:[a-z]+s|[a-z]+es)\s/i.test(f) && !/^(?:plus|has|is|was|its)\s/i.test(f) && !/\b(?:app|kit|set|pack|bundle)$/i.test(f.split(/\s+/)[0] ?? '')

const ACTIONS: Record<Tone, readonly string[]> = {
  calm: ['Take a closer look', 'Find out more', 'Begin here'],
  hype: ['Get it now', "Don't miss out", 'Jump in'],
  premium: ['Discover more', 'Experience it', 'Learn more'],
  friendly: ['Come say hi', 'Try it today', 'Join in'],
  serious: ['Learn more', 'Get started', 'See the details'],
  neutral: ['Learn more', 'Get started', 'Try it today']
}

const KICKERS = ['Meet', 'Introducing', 'Say hello to'] as const

/** how many scenes the time allows */
export function sceneBudget(totalSec: number, tone: Tone): number {
  const per = tone === 'hype' ? 3.2 : tone === 'calm' ? 4.4 : 4.1
  return Math.max(3, Math.min(10, Math.round(totalSec / per)))
}

/** drop the least important scenes first (later ones before earlier ones on a tie) */
function trim(scenes: StoryScene[], budget: number, keep: (s: StoryScene, i: number) => boolean): StoryScene[] {
  const out = [...scenes]
  while (out.length > budget) {
    const order = [...out.keys()].filter((i) => !keep(out[i], i)).sort((a, b) => (out[a].prio ?? 5) - (out[b].prio ?? 5) || b - a)
    if (!order.length) break
    out.splice(order[0], 1)
  }
  return out
}

// ---------------------------------------------------------------- product

function productArc(b: Brief, rng: Rng, budget: number, totalSec: number): StoryScene[] {
  const hasName = Boolean(b.subject)
  const name = b.subject || titleCase(trimWords(b.what, 4))
  const kicker = pick(rng, KICKERS)
  const out: StoryScene[] = []

  out.push({
    kind: 'title',
    weight: 1.2,
    content: { headline: trimWords(name, 4), subline: hasName && b.what ? cap(trimWords(b.what, 6)) : b.audience ? `Made for ${b.audience}` : undefined, kicker: kicker.toUpperCase() },
    say: hasName && b.what ? `${kicker} ${name}, ${withArticle(b.what)}.` : `${kicker} ${name}.`
  })
  if (b.audience) {
    out.push({
      kind: 'statement',
      weight: 1,
      prio: 3,
      content: { headline: `Made for ${trimWords(b.audience, 5)}.` },
      say: `Made for ${b.audience}.`
    })
  }
  for (const f of b.features.slice(0, 3)) {
    const verb = isVerbPhrase(f)
    const headline = verb ? `${hasName ? name : 'It'} ${trimWords(f, 6)}.` : `Plus ${withArticle(trimWords(f, 5))}.`
    out.push({ kind: 'statement', weight: 1.4, prio: 6, content: { headline }, say: verb ? `${hasName ? name : 'It'} ${f}.` : `Plus ${withArticle(f)}.` })
  }
  // a thin brief still gets a real shape: a question and an invitation, never a claim
  if (out.length < 3 && b.what) {
    const q = pick(rng, [`What if ${withArticle(b.what)} just worked?`, `Ever wished ${withArticle(b.what)} were simpler?`])
    out.push({ kind: 'statement', weight: 1.4, prio: 4, content: { headline: q }, say: q })
  }
  if (out.length < 4) {
    const look = pick(rng, ['See it in action.', 'Take a closer look.'])
    out.push({ kind: 'statement', weight: 1.2, prio: 4, content: { headline: look }, say: look })
  }
  const n = b.numbers[0]
  if (n && out.length < budget) {
    out.push({ kind: 'stat', weight: 1.4, prio: 4, content: { value: n.value, label: cap(n.label || (hasName ? name : b.what)).slice(0, 40) }, say: `${n.value} ${n.label}.`.trim() })
  }
  if (b.features.length >= 2 && totalSec >= 28) {
    out.push({ kind: 'bullets', weight: 2, prio: 2, content: { headline: 'What you get', bullets: b.features.slice(0, 4).map((f) => cap(trimWords(f, 5))) }, say: `What you get: ${b.features.slice(0, 4).join(', ')}.` })
  }
  const action = pick(rng, ACTIONS[b.tone])
  out.push({
    kind: 'cta',
    weight: 1.1,
    content: { headline: hasName ? `${name}.` : cap(trimWords(b.what, 5)), subline: b.audience ? `For ${b.audience}.` : undefined, action },
    say: hasName ? `${name}. ${action}.` : `${cap(b.what)}. ${action}.`
  })
  return trim(out, budget, (s, i) => i === 0 || s.kind === 'cta')
}

// ---------------------------------------------------------------- explainer / why / idea

function split(topic: string): { head: string; sub: string; question: string } {
  const t = topic.trim().replace(/[?.!]+$/, '')
  let m = /^how\s+(.+?)\s+(?:is|are)\s+(made|built|done|produced|grown|used|born)$/i.exec(t)
  if (m) return { head: titleCase(trimWords(m[1], 4)), sub: `How it's ${m[2].toLowerCase()}`, question: `Ever wondered how ${m[1]} ${/s$/i.test(m[1]) ? 'are' : 'is'} ${m[2].toLowerCase()}?` }
  m = /^how\s+(.+?)\s+(works?|happens?|runs?)$/i.exec(t)
  if (m) return { head: titleCase(trimWords(m[1], 4)), sub: `How it ${m[2].toLowerCase()}`, question: `Ever wondered how ${m[1]} ${m[2].toLowerCase()}?` }
  m = /^why\s+(.+)$/i.exec(t)
  if (m) return { head: `Why ${titleCase(trimWords(m[1], 5))}`, sub: 'Let’s look closer', question: `Why ${m[1]}? Let’s look closer.` }
  m = /^what\s+(?:is|are)\s+(.+)$/i.exec(t)
  if (m) return { head: titleCase(trimWords(m[1], 4)), sub: 'What it is', question: `What is ${m[1]}?` }
  return { head: titleCase(trimWords(t, 5)), sub: '', question: `Let’s talk about ${t}.` }
}

function ideaArc(b: Brief, rng: Rng, budget: number): StoryScene[] {
  const topic = b.what || b.topic
  const s = split(topic)
  const out: StoryScene[] = []
  const hype = b.tone === 'hype'
  out.push({ kind: 'title', weight: 1.2, content: { headline: s.head, subline: s.sub || undefined, kicker: b.kind === 'why' ? 'THE STORY' : b.kind === 'explainer' ? 'EXPLAINED' : undefined }, say: s.sub ? `${s.head}. ${s.sub}.` : `${s.head}.` })
  out.push({ kind: 'statement', weight: 1.3, content: { headline: s.question.length > 70 ? trimWords(s.question, 9) : s.question }, say: s.question })
  // the person's own points, when they gave any
  const facts = b.features
  facts.slice(0, 4).forEach((f, i) => {
    const num = /^\s*(\$?\d[\d,.]*\s?(?:%|k|m|x|×)?)\s*(.*)$/i.exec(f)
    if (num && num[1] && /[\d]/.test(num[1])) {
      out.push({ kind: 'stat', weight: 1.4, content: { value: num[1].trim(), label: statLabel(num[2] || topic).slice(0, 44) }, say: endStop(f) })
    } else {
      out.push({ kind: 'statement', weight: 1.3, content: { headline: cap(trimWords(f, 9)) }, say: endStop(cap(f)) })
    }
    void i
  })
  if (!facts.length) {
    const frames = hype
      ? ['No hype. Just the story.', 'Here is why it hit.']
      : ['It starts simple.', 'Then every piece fits together.']
    for (const f of frames.slice(0, 2)) out.push({ kind: 'statement', weight: 1.2, content: { headline: f }, say: f })
  }
  const action = pick(rng, ACTIONS[b.tone])
  out.push({ kind: 'cta', weight: 1.1, content: { headline: s.head, subline: s.sub || undefined, action }, say: `${s.head}. ${action}.` })
  return trim(out, budget, (sc, i) => i === 0 || sc.kind === 'cta' || i === 1)
}

// ---------------------------------------------------------------- list / versus / script

function listArc(b: Brief, rng: Rng, budget: number): StoryScene[] {
  const count = Number(b.numbers[0]?.value) || b.features.length
  const topic = b.what.replace(/^(?:top|best)\s+/i, '')
  const out: StoryScene[] = [{ kind: 'title', weight: 1.2, content: { headline: titleCase(trimWords(b.what, 5)), subline: b.audience ? `For ${b.audience}` : undefined, kicker: 'THE LIST' }, say: `${titleCase(trimWords(b.what, 5))}${b.audience ? `, for ${b.audience}` : ''}.` }]
  b.features.slice(0, Math.max(0, budget - 2)).forEach((f, i) => {
    const [head, ...tail] = f.split(/\s*[:–—-]\s+/)
    out.push({ kind: 'statement', weight: 1.5, content: { headline: `${String(i + 1).padStart(2, '0')}. ${cap(trimWords(head, 7))}`, subline: tail.length ? cap(trimWords(tail.join(' '), 12)) : undefined }, say: endStop(`Number ${i + 1}. ${cap(f)}`) })
  })
  if (!b.features.length) out.push({ kind: 'statement', weight: 1.3, content: { headline: count ? `${count} ideas. One at a time.` : 'One idea at a time.' }, say: count ? `${count} ideas, one at a time.` : 'One idea at a time.' })
  void topic
  const action = pick(rng, ACTIONS[b.tone])
  out.push({ kind: 'cta', weight: 1, content: { headline: count ? `Which of the ${count} will you try?` : 'Which will you try?', action }, say: `Which will you try? ${action}.` })
  return out
}

function versusArc(b: Brief, rng: Rng): StoryScene[] {
  const [l, r] = b.versus as [string, string]
  const L = titleCase(trimWords(l, 3))
  const R = titleCase(trimWords(r, 3))
  const pts = (i: number) => b.features.filter((_, k) => k % 2 === i).map((f) => cap(trimWords(f, 6)))
  return [
    { kind: 'title', weight: 1.2, content: { headline: `${L} vs ${R}`, subline: b.audience ? `For ${b.audience}` : undefined, kicker: 'HEAD TO HEAD' }, say: `${L} versus ${R}${b.audience ? `, for ${b.audience}` : ''}.` },
    { kind: 'comparison', weight: 2.4, content: { headline: 'Side by side', left: { label: L, points: pts(0) }, right: { label: R, points: pts(1) } }, say: `${L}, or ${R}? Here they are, side by side.` },
    { kind: 'statement', weight: 1.2, content: { headline: 'The right pick depends on you.' }, say: 'The right pick depends on you.' },
    { kind: 'cta', weight: 1, content: { headline: `${L} or ${R}?`, action: pick(rng, ACTIONS[b.tone]) }, say: `${L} or ${R}? You decide.` }
  ]
}

/** the person's own lines, each directed as a scene */
function scriptArc(b: Brief, rng: Rng): StoryScene[] {
  const beats = b.script
  return beats.map((line, i) => {
    const last = i === beats.length - 1
    const say = endStop(line)
    const stat = /^\s*(\$?\d[\d,.]*\s?(?:%|k|m|x|×)?)\s+(.{3,44})$/i.exec(line)
    const colon = /^([^:]{3,40}):\s*(.{3,90})$/.exec(line)
    const vs = /^(.{2,30})\s+(?:vs\.?|versus)\s+(.{2,30})$/i.exec(line)
    if (i === 0 && line.split(/\s+/).length <= 9) return { kind: 'title', weight: 1.2, content: { headline: cap(trimWords(line.replace(/[.!]+$/, ''), 9)), kicker: b.subject ? b.subject.toUpperCase() : undefined }, say } as StoryScene
    if (last && line.split(/\s+/).length <= 10) return { kind: 'cta', weight: 1.1, content: { headline: cap(trimWords(line.replace(/[.!]+$/, ''), 9)), action: pick(rng, ACTIONS[b.tone]) }, say } as StoryScene
    if (vs) return { kind: 'comparison', weight: 2, content: { headline: 'Side by side', left: { label: titleCase(vs[1]), points: [] }, right: { label: titleCase(vs[2]), points: [] } }, say } as StoryScene
    if (stat && /[%$]|\d{2,}/.test(stat[1])) return { kind: 'stat', weight: 1.4, content: { value: stat[1].trim(), label: statLabel(stat[2]) }, say } as StoryScene
    if (colon) return { kind: 'statement', weight: 1.4, content: { headline: cap(trimWords(colon[1], 8)), subline: cap(trimWords(colon[2], 16)) }, say } as StoryScene
    return { kind: 'statement', weight: 1.3, content: { headline: cap(trimWords(line.replace(/[.!]+$/, ''), 10)) }, say } as StoryScene
  })
}

export function buildStory(b: Brief, totalSec: number, rng: Rng, budgetOverride?: number): StoryScene[] {
  const budget = budgetOverride ?? sceneBudget(totalSec, b.tone)
  if (b.script.length >= 3) return scriptArc(b, rng)
  if (b.kind === 'versus' && b.versus) return versusArc(b, rng)
  if (b.kind === 'list') return listArc(b, rng, budget)
  if (b.kind === 'product' && (b.subject || b.what)) return productArc(b, rng, budget, totalSec)
  if (b.what || b.topic) return ideaArc(b, rng, budget)
  return []
}

export function storyTitle(b: Brief): string {
  if (b.subject) return b.subject
  if (b.versus) return `${titleCase(trimWords(b.versus[0], 3))} vs ${titleCase(trimWords(b.versus[1], 3))}`
  return titleCase(trimWords(b.what || b.topic || 'Your video', 6))
}

export { firstUpper }
