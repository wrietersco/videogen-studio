/**
 * Dates a person says in words ("next friday", "three weeks from today", "the 14th", "tomorrow"), worked out from today.
 * Where the words can mean two days, one rule is used and said (`rule`), so the run notes can tell the person which.
 * Deterministic, no AI.
 */

export interface DateRead {
  /** the day, as YYYY-MM-DD */
  date: string
  /** the person's words, as written */
  phrase: string
  /** which rule was used when the words are ambiguous (empty when they are not) */
  rule?: string
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const WD_SHORT: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 }
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30 }

const NUM = `(?:\\d{1,3}|${Object.keys(NUM_WORDS).join('|')})`
const WD = `(?:${WEEKDAYS.join('|')})`
const MON = `(?:${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})`
const ORDINAL = '\\d{1,2}(?:st|nd|rd|th)'

/** a date phrase inside some words; the longest alternatives first */
export const DATE_PHRASE = new RegExp(
  [
    `\\b${NUM}\\s+(?:days?|weeks?|months?)\\s+(?:from\\s+(?:today|now)|ahead|later|away|out)\\b`,
    `\\bin\\s+${NUM}\\s+(?:days?|weeks?|months?)(?:['’]?\\s*time)?\\b`,
    `\\b(?:this\\s+|next\\s+|on\\s+)?${WD}\\b(?:\\s+(?:morning|afternoon|evening))?`,
    `\\b(?:the\\s+)?${ORDINAL}(?:\\s+of\\s+${MON}(?:\\s+\\d{4})?)?\\b(?!\\s+(?!and\\b|then\\b|of\\b)[a-z])`,
    `\\b${MON}\\s+${ORDINAL}?\\d{0,2}(?:\\s*,?\\s*\\d{4})?\\b`,
    `\\b\\d{1,2}\\s+${MON}(?:\\s+\\d{4})?\\b`,
    `\\b\\d{4}-\\d{2}-\\d{2}\\b`,
    `\\b\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?\\b`,
    `\\bnext\\s+(?:week|month|year)\\b`,
    `\\b(?:the\\s+)?(?:day\\s+after\\s+tomorrow|tomorrow|today|tonight|yesterday)\\b`
  ].join('|'),
  'i'
)

const pad = (n: number): string => String(n).padStart(2, '0')
const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number): Date => {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
  return r
}
const addMonths = (d: Date, n: number): Date => {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1)
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()
  r.setDate(Math.min(d.getDate(), last))
  return r
}
const num = (w: string): number => (/^\d+$/.test(w) ? Number(w) : (NUM_WORDS[w.toLowerCase()] ?? 0))
const wdIndex = (w: string): number => {
  const l = w.toLowerCase()
  const i = WEEKDAYS.indexOf(l)
  return i >= 0 ? i : (WD_SHORT[l] ?? -1)
}
const monIndex = (m: string): number => MONTHS.findIndex((x) => x === m.toLowerCase() || x.slice(0, 3) === m.toLowerCase().slice(0, 3))
const dayName = (i: number): string => WEEKDAYS[i].charAt(0).toUpperCase() + WEEKDAYS[i].slice(1)

/** the day a phrase means, counted from `today` (null: it is not a date phrase) */
export function readDate(words: string, today: Date = new Date()): DateRead | null {
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const p = words.replace(/\s+/g, ' ').trim()
  const s = p.toLowerCase()
  let m: RegExpExecArray | null
  if (/^(?:the\s+)?(?:today|tonight)$/.test(s)) return { date: iso(t0), phrase: p }
  if (/^(?:the\s+)?tomorrow$/.test(s)) return { date: iso(addDays(t0, 1)), phrase: p }
  if (/^(?:the\s+)?day\s+after\s+tomorrow$/.test(s)) return { date: iso(addDays(t0, 2)), phrase: p }
  if (/^(?:the\s+)?yesterday$/.test(s)) return { date: iso(addDays(t0, -1)), phrase: p }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { date: s, phrase: p }
  // "three weeks from today", "in 2 days", "a week from now"
  if ((m = new RegExp(`^(?:in\\s+)?(${NUM})\\s+(day|week|month)s?(?:\\s+(?:from\\s+(?:today|now)|ahead|later|away|out)|['’]?\\s*time)?$`).exec(s))) {
    const n = num(m[1])
    if (!n) return null
    const d = m[2] === 'day' ? addDays(t0, n) : m[2] === 'week' ? addDays(t0, 7 * n) : addMonths(t0, n)
    return { date: iso(d), phrase: p }
  }
  if (s === 'next week') return { date: iso(addDays(t0, 7)), phrase: p, rule: `"next week" = the same weekday one week from today (${dayName(addDays(t0, 7).getDay())})` }
  if (s === 'next month') return { date: iso(addMonths(t0, 1)), phrase: p, rule: '"next month" = the same day of the month, one month from today' }
  if (s === 'next year') return { date: iso(new Date(t0.getFullYear() + 1, t0.getMonth(), t0.getDate())), phrase: p, rule: '"next year" = the same day one year from today' }
  // weekdays
  if ((m = new RegExp(`^(this\\s+|next\\s+|on\\s+)?(${WD})(?:\\s+(?:morning|afternoon|evening))?$`).exec(s))) {
    const target = wdIndex(m[2])
    const lead = (m[1] ?? '').trim()
    if (lead === 'next') {
      // the weeks run Monday to Sunday: "next Friday" is the Friday of the week after this one
      const mondayThis = addDays(t0, -((t0.getDay() + 6) % 7))
      const d = addDays(mondayThis, 7 + ((target + 6) % 7))
      const soon = addDays(t0, (target - t0.getDay() + 7) % 7 || 7)
      return { date: iso(d), phrase: p, rule: `"next ${dayName(target)}" = the ${dayName(target)} of next week (weeks start on Monday)${iso(soon) !== iso(d) ? `, not the nearer ${dayName(target)} ${iso(soon)}` : ''}` }
    }
    const d = addDays(t0, (target - t0.getDay() + 7) % 7)
    return { date: iso(d), phrase: p, ...(lead === 'this' || lead === 'on' || !lead ? { rule: `"${p}" = the first ${dayName(target)} from today on (today counts)` } : {}) }
  }
  // "the 14th", "14th of December"
  if ((m = new RegExp(`^(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)(?:\\s+of\\s+(${MON})(?:\\s+(\\d{4}))?)?$`).exec(s))) {
    const day = Number(m[1])
    if (m[2]) {
      const mi = monIndex(m[2])
      let y = m[3] ? Number(m[3]) : t0.getFullYear()
      let d = new Date(y, mi, day)
      if (!m[3] && d < t0) { y++; d = new Date(y, mi, day) }
      return { date: iso(d), phrase: p }
    }
    let d = new Date(t0.getFullYear(), t0.getMonth(), day)
    if (d < t0) d = new Date(t0.getFullYear(), t0.getMonth() + 1, day)
    return { date: iso(d), phrase: p, rule: `"the ${day}th" with no month = the next ${day}th from today (this month if it is still ahead, else next month)` }
  }
  // "14 December", "December 14", "Dec 14th 2026"
  if ((m = new RegExp(`^(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})|(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?)(?:\\s*,?\\s*(\\d{4}))?$`).exec(s))) {
    const day = Number(m[1] ?? m[4])
    const mi = monIndex(m[2] ?? m[3])
    let y = m[5] ? Number(m[5]) : t0.getFullYear()
    let d = new Date(y, mi, day)
    if (!m[5] && d < t0) { y++; d = new Date(y, mi, day) }
    return { date: iso(d), phrase: p }
  }
  // 14/12/2026 (day first, as the apps this is used on are British; said)
  if ((m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s))) {
    const a = Number(m[1])
    const b = Number(m[2])
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : t0.getFullYear()
    const dayFirst = a <= 31 && b <= 12
    const d = dayFirst ? new Date(y, b - 1, a) : new Date(y, a - 1, b)
    return { date: iso(d), phrase: p, rule: `"${p}" read as day/month` }
  }
  return null
}

/** where a date phrase is inside some words (null: none) */
export function findDatePhrase(text: string): { phrase: string; index: number; end: number } | null {
  const re = new RegExp(DATE_PHRASE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const phrase = m[0].trim()
    // a bare ordinal or weekday inside a sentence about something else ("the 2nd stylist", "monday.com") is not a date: it needs a reading
    if (readDate(phrase)) return { phrase, index: m.index + (m[0].length - m[0].trimStart().length), end: m.index + m[0].length }
  }
  return null
}
