import type { AppField, AppPage } from '@shared/appRecon'

/**
 * The steps a person typed, read out of their own words.
 *
 * "log into the app -> go to -> ontology graph -> type in "psychology" in the
 * filter, and explain ..." is not a topic to tour around: it is a list of
 * things to do. This finds the two kinds of step the engine can carry out by
 * itself (open a named page, type a quoted text into a named box). Signing in
 * is the engine's own job, and everything else ("explain how ...") is left for
 * the narration. It is deterministic and needs no AI.
 */

export type Directive =
  | { kind: 'open'; target: string; said: string }
  | { kind: 'type'; text: string; into: string; said: string }

const QUOTED = /["“”'‘’]([^"“”'‘’]{1,80})["“”'‘’]/
const TYPE_VERB = /\b(?:type(?:\s+in)?|enter|input|search(?:\s+for)?|filter(?:\s+(?:by|for|on))?|look\s+up|write|put)\b/i
const OPEN_VERB = /^(?:and\s+|then\s+|next\s+|now\s+|please\s+)*(?:go\s+(?:in)?to|open(?:\s+up)?|navigate\s+to|visit|head\s+to|click(?:\s+on)?|select|choose|press|tap(?:\s+on)?|switch\s+to)\s+(.*)$/i
const SIGN_IN = /\b(log\s?-?(?:in|into|on)|sign\s?-?(?:in|into|on)|authenticate)\b/i
/** a clause that starts like this is something to say, not something to do */
const TALK = /^(?:and\s+|then\s+)*(?:explain|show|tell|describe|talk|mention|highlight|say|point|note|there|this|that|it|how|why|what|also|make|create|i\s|we\s)/i
const NOISE = /^(?:the|a|an|my|our|its)\s+/i
const SUFFIX = /\s+(?:page|tab|screen|section|menu|view|module|button|link|box|field|input|bar|area)$/i

const tidy = (s: string): string => {
  let t = s.replace(/["“”'‘’]/g, '').replace(/\s+/g, ' ').trim().replace(/[.:;,!]+$/, '').trim()
  for (let i = 0; i < 3; i++) t = t.replace(NOISE, '').replace(SUFFIX, '').trim()
  return t
}

export function parseDirectives(context: string): Directive[] {
  // notes attached as a document are information only, never steps
  const typed = context.split(/\n\s*Attached notes \(information only\):/)[0] ?? ''
  const out: Directive[] = []
  const arrows = /->|→|=>|⇒|➜|>>/.test(typed)
  for (const segment of typed.split(/->|→|=>|⇒|➜|>>|\n|;|\.(?=\s|$)|\bthen\b/i)) {
    const clauses = segment.split(/,\s*(?:and\s+)?|\s+and\s+(?=(?:type|enter|search|filter|go|open|click|select|press|explain|show|tell|describe)\b)/i)
    clauses.forEach((raw, i) => {
      const clause = raw.replace(/\s+/g, ' ').trim()
      if (!clause) return
      const q = QUOTED.exec(clause)
      if (q && TYPE_VERB.test(clause.slice(0, q.index))) {
        const rest = clause.slice(q.index + q[0].length)
        const into = /^\s*(?:in|into|in\s+to|on|inside|within|to|at)\s+(.+)$/i.exec(rest)
        // "filter by "x"" names its own box
        const verb = /\b(search|filter)\b/i.exec(clause.slice(0, q.index))?.[1] ?? ''
        out.push({ kind: 'type', text: q[1].trim(), into: tidy(into?.[1] ?? '') || verb.toLowerCase(), said: clause })
        return
      }
      if (SIGN_IN.test(clause)) return
      const open = OPEN_VERB.exec(clause)
      if (open) {
        const target = tidy(open[1])
        if (target && target.split(' ').length <= 6) out.push({ kind: 'open', target, said: clause })
        return
      }
      // "a -> b -> c": a short piece between arrows names a place to go
      if (arrows && i === 0 && !TALK.test(clause) && clause.split(' ').length <= 5 && !/^go\s+to$/i.test(clause)) {
        const target = tidy(clause)
        if (target) out.push({ kind: 'open', target, said: clause })
      }
    })
  }
  return out
}

const GENERIC_BOX = new Set(['filter', 'search', 'box', 'field', 'input', 'bar', 'text', 'query', 'find', 'the', 'here'])
const tokens = (s: string): string[] => s.toLowerCase().normalize('NFKD').match(/[a-z0-9]{3,}/g) ?? []

/** the page is the one the person named: every word of the name is in its title, headings, address, or the link that led to it */
export function pageMatches(p: Pick<AppPage, 'url' | 'title' | 'headings'>, fromLabel: string | undefined, target: string): boolean {
  const want = tokens(target)
  if (!want.length) return false
  let path = p.url
  try {
    path = new URL(p.url).pathname
  } catch {
    /* keep as given */
  }
  const hay = [p.title, ...p.headings.slice(0, 3), path, fromLabel ?? ''].join(' ').toLowerCase()
  return want.every((w) => hay.includes(w))
}

/** a link or button with that name */
export function labelMatches(label: string, target: string): boolean {
  const want = tokens(target)
  const hay = label.toLowerCase()
  return want.length > 0 && label.length <= 60 && want.every((w) => hay.includes(w))
}

/**
 * The box the person meant. `exact` is a box whose own name says so; without
 * one, on the page the person named, a search-like box or the only free-text
 * box is taken (`loose`).
 */
export function fieldFor(fields: AppField[], into: string, loose: boolean): AppField | null {
  const usable = fields.filter((f) => !f.sensitive && !['password', 'otp', 'card', 'ssn'].includes(f.kind) && !/^(select|select-one|select-multiple|file|date|number|range|color)$/.test(f.inputType))
  const want = tokens(into)
  if (want.length) {
    const named = usable.filter((f) => want.every((w) => `${f.label} ${f.name} ${f.selector}`.toLowerCase().includes(w)))
    if (named.length) return named[0]
  }
  if (!loose) return null
  // a box named by a real word ("zodiac") that is not on the page is not replaced by some other box
  if (want.some((w) => !GENERIC_BOX.has(w))) return null
  const searchy = usable.filter((f) => f.kind === 'search' || f.inputType === 'search' || /search|filter|find|query|keyword/i.test(`${f.label} ${f.name} ${f.selector}`))
  if (searchy.length) return searchy[0]
  return usable.length === 1 ? usable[0] : null
}
