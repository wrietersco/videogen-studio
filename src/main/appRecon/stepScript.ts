import type { FindSpec } from '@shared/appRecon'

/**
 * A list of steps the person wrote, read as a script to perform exactly.
 *
 *   1. log into the app
 *   2. from left menu, click ontology
 *   3. from search section on top, click "Explore the graph"
 *   4. in search bar, type in "psychology"
 *   5. from the search bar, click the suggestion "psychology"
 *   6. Click the fit to view icon (just right above the pause icon)
 *   7. from right side pane, explore the "Node" tab and scrolldown to explain what ...
 *
 * Each numbered (or bulleted) line is one step. A line can hold several small
 * actions ("click the Node tab and scroll down"), and what follows "explain" is
 * what the narration must make clear, not something to click. Where a step says
 * where something is ("from the left menu", "on top", "just above the pause
 * icon") that becomes part of how the control is found. Nothing the person wrote
 * is dropped: words that are not an action are kept as notes for the narration.
 * Deterministic, no AI.
 */

export type Atom =
  /** go to an address the step names, whole (the #fragment can pick the view the page opens on) */
  | { action: 'open'; label: string; url: string }
  | { action: 'click'; label: string; find: FindSpec }
  /** choose one entry in a dropdown ("select Surah An-Nur" in the "Text to Study" dropdown) */
  | { action: 'select'; label: string; option: string; find: FindSpec }
  | { action: 'type'; label: string; text: string; find: FindSpec }
  | { action: 'scroll'; dir: 'down' | 'up'; find: FindSpec }

export interface ScriptItem {
  n: number
  /** the person's own words for this step, number removed */
  said: string
  /** this step is the engine's own sign-in */
  login: boolean
  atoms: Atom[]
  /** what the narration for this step must make clear ("explain ...") */
  explain?: string
  /** words in the step that are not an action */
  notes: string[]
}

export interface StepScript {
  items: ScriptItem[]
  /** the rest of what was written (the goal, in the person's words) */
  goal: string
}

// a name can be quoted with straight or curly quotes or with backticks (`The even-odd circle`)
const Q = '["“”\'‘’`]'
const NQ = '[^"“”\'‘’`]'
const QUOTED = new RegExp(`${Q}(${NQ}{1,100})${Q}`)
/** an address in a step, with the words that introduce it ("open: https://…", "go to https://…"); its trailing punctuation is not part of it */
const OPEN_URL = /(?:\b(?:open(?:\s+up)?|go\s+to|navigate\s+to|visit|head\s+to|load|browse\s+to|the\s+(?:url|page|address|link))\b[\s:]*)*(https?:\/\/[^\s`'"<>)\]]+)/gi
/** "make sure to", "ensure to": filler in front of the real verb */
const FILLER = /\b(?:ensure|make\s+sure|be\s+sure|remember)\s+(?:to\s+|that\s+you\s+)?/gi
/** a menu path: "SHAPES -> 05 The even-odd circle" names the last stop */
const PATH_SEP = /\s*(?:->|→|=>|⇒|➜|›|»)\s*/
/** "the `Text to Study` dropdown", "dropdown called `X`", "from the surah dropdown": which dropdown a step means */
const DROPDOWN_QUOTED = new RegExp(`${Q}(${NQ}{1,60})${Q}\\s+(?:drop-?down|select(?:\\s+box)?|menu|list|picker|combo-?box)\\b`, 'i')
const DROPDOWN_CALLED = new RegExp(`\\b(?:drop-?down|picker|select(?:\\s+box)?)\\s+(?:called|named|labell?ed|titled)?\\s*${Q}(${NQ}{1,60})${Q}`, 'i')
const DROPDOWN_PLAIN = /\b(?:from|in|on|using|open)\s+(?:the\s+)?([A-Za-z][\w'’ -]{0,40}?)\s+drop-?down\b/i
const DROPDOWN_ANY = /\bdrop-?down\b|\bpicker\b/i
/** "select Surah An-Nur,", "switch to surah Ya-Sin, then": the name of the entry that is chosen */
const PICK = /\b(?:select|choose|pick|switch\s+to|change\s+to)\s+(?:the\s+)?(?:(?:surah|sura|chapter|option|item|value|entry)\s+)?[`"“'‘]?([^,.;:!?\n`"”]+?)[`"”'’]?(?=\s*(?:[,.;:!?]|$)|\s+(?:from|in|on|and|then|to\s+see|so|which|for|with)\b)/gi
/** "switch to any surah" names no entry */
const NOT_AN_ENTRY = /^(?:any|another|a|an|some|different|other|each|every|one|it|them|that|this|the\s+next|next|previous)(?:\s|$)/i // not "An-Nur"

/** which dropdown the words mean, when they talk about one */
function dropdownIn(text: string): { label: string } | null {
  const m = DROPDOWN_QUOTED.exec(text) ?? DROPDOWN_CALLED.exec(text)
  if (m) return { label: clean(m[1]) }
  const p = DROPDOWN_PLAIN.exec(text)
  if (p) return { label: clean(p[1].replace(ARTICLE, '')) }
  return DROPDOWN_ANY.test(text) ? { label: '' } : null
}

/** the entries named in "select X" / "switch to Y", in the order said */
function picksIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PICK)) {
    const name = clean(m[1])
    if (name && name.length <= 60 && !NOT_AN_ENTRY.test(name)) out.push(name)
  }
  return out
}
const BULLET = /^\s*(?:(?:step\s*)?\d{1,2}\s*[.):\-]|[-*•▪●])\s+(.*\S)\s*$/i
const LOGIN = /^(?:(?:and|then|first|please)\s+)*(?:log\s?-?\s?(?:in|into|on)|sign\s?-?\s?(?:in|into|on)|authenticate|login)\b/i
const EXPLAIN = /\b(?:(?:to|and|then)\s+)?(explain|describe|tell(?:\s+(?:me|us|the viewer))?|talk\s+about|mention|highlight|discuss|point\s+out|summari[sz]e|cover|narrate|walk\s+(?:me\s+)?through)\b/i
const SCROLL = /\b(?:scroll\s*-?\s*(down|up)|scrolldown|scrollup|scroll(?:\s+(?:to\s+(?:the\s+)?(?:bottom|end)|through|all\s+the\s+way))?)\b/i
const TYPE_VERB = /\b(?:type(?:\s+in)?|enter|input|search\s+for|write|put|fill\s+in)\b/i
const CLICK_VERB = /^(?:(?:and|then|now|next|please)\s+)*(?:click(?:\s+on)?|press|tap(?:\s+on)?|select|choose|open(?:\s+up)?|go\s+to|navigate\s+to|hit|pick|expand|explore|switch\s+to|visit|head\s+to|use|toggle|check\s+out)\s+(.*)$/i
const REL = /(?:just\s+|right\s+|directly\s+|immediately\s+)*(above|over|on\s+top\s+of|below|under|beneath|(?:to\s+the\s+)?left\s+of|(?:to\s+the\s+)?right\s+of|next\s+to|beside|near)\s+(?:the\s+)?(.+?)\s*$/i
const REL_MAP: Record<string, NonNullable<FindSpec['relation']>['rel']> = { above: 'above', over: 'above', 'on top of': 'above', below: 'below', under: 'below', beneath: 'below', 'left of': 'leftOf', 'right of': 'rightOf', 'next to': 'near', beside: 'near', near: 'near' }
const NOUN_TAIL = /\s+(icon|button|tab|link|item|option|menu\s+item|entry|toggle|control|symbol)$/i
const ARTICLE = /^(?:the|a|an|my|our|its|that|this)\s+/i

const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').trim()
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** where a step says its target is: "from left menu", "from the search section on top", "in search bar" */
function placeOf(phrase: string): { region?: FindSpec['region']; within: string[] } {
  const p = phrase.toLowerCase()
  const region = /\bleft\b/.test(p) ? 'left' : /\bright\b/.test(p) ? 'right' : /\b(?:top|upper|header)\b/.test(p) ? 'top' : /\b(?:bottom|footer|lower)\b/.test(p) ? 'bottom' : undefined
  const within: string[] = []
  if (/\b(?:menu|nav|navigation|sidebar|side\s?bar|drawer)\b/.test(p)) within.push('menu')
  if (/\bsearch|filter\b/.test(p)) within.push('search')
  if (/\b(?:pane|panel|inspector|details?)\b/.test(p)) within.push('pane')
  if (/\b(?:header|toolbar|top\s?bar|nav\s?bar)\b/.test(p)) within.push('header')
  if (/\b(?:dropdown|suggestions?|autocomplete)\b/.test(p)) within.push('suggestion')
  return { region, within }
}

/** "icon", "tab"... said after the name */
const roleOf = (words: string): FindSpec['role'] | undefined => (/\btab\b/i.test(words) ? 'tab' : /\bicon|symbol\b/i.test(words) ? 'icon' : /\bsuggestion/i.test(words) ? 'suggestion' : undefined)

function clickAtom(raw: string, place: { region?: FindSpec['region']; within: string[] }): Atom | null {
  let rest = raw
  let relation: FindSpec['relation']
  // "(just right above the pause icon)" or a trailing "just above the pause icon"
  const paren = /\(([^)]*)\)/.exec(rest)
  if (paren) {
    const m = REL.exec(paren[1])
    if (m) relation = { rel: REL_MAP[m[1].toLowerCase().replace(/^to the\s+/, '').replace(/\s+/g, ' ')] ?? 'near', to: clean(m[2].replace(NOUN_TAIL, '')) }
    rest = rest.replace(paren[0], ' ')
  }
  const tail = relation ? null : REL.exec(rest.replace(Q, '"'))
  if (tail && !QUOTED.test(rest.slice(tail.index))) {
    relation = { rel: REL_MAP[tail[1].toLowerCase().replace(/^to the\s+/, '').replace(/\s+/g, ' ')] ?? 'near', to: clean(tail[2].replace(NOUN_TAIL, '')) }
    rest = rest.slice(0, tail.index)
  }
  const q = QUOTED.exec(rest)
  // "SHAPES -> 05 The even-odd circle": the section names the way there, the last stop is what is clicked
  if (!q && PATH_SEP.test(rest)) rest = rest.split(PATH_SEP).pop() ?? rest
  const before = q ? rest.slice(0, q.index) : rest
  const after = q ? rest.slice(q.index + q[0].length) : ''
  let label = q ? q[1].trim() : clean(clean(before).replace(ARTICLE, '').replace(NOUN_TAIL, '').replace(/\b(?:the\s+)?(?:suggestion|option|result|entry)\b/i, ''))
  const role = roleOf(`${before} ${after}`) ?? (relation && !q ? 'icon' : undefined)
  if (!q) label = label.replace(ARTICLE, '')
  if (!label) return null
  // a quoted name can carry a trailing "tab"/"icon" outside the quotes: it is the control's kind, not part of its name
  const within = [...place.within]
  if (role === 'suggestion' && !within.includes('suggestion')) within.push('suggestion')
  return { action: 'click', label, find: { target: label, kind: 'click', ...(place.region ? { region: place.region } : {}), ...(within.length ? { within } : {}), ...(relation ? { relation } : {}), ...(role ? { role } : {}) } }
}

function parseLine(n: number, said: string): ScriptItem {
  const item: ScriptItem = { n, said, login: false, atoms: [], notes: [] }
  // quotes are kept whole while the line is split into small actions
  const shield: string[] = []
  // an address is taken out whole first (the dots and the # in it are not sentence breaks), and becomes a step of its own
  const urls: string[] = []
  const noUrls = said.replace(OPEN_URL, (_m, u: string) => {
    const clean1 = u.replace(/[.,;:!?]+$/, '')
    urls.push(clean1)
    return ' '
  })
  for (const u of urls) item.atoms.push({ action: 'open', label: 'Open page', url: u })
  const guarded = noUrls
    .replace(new RegExp(`${Q}${NQ}{1,100}${Q}`, 'g'), (m) => `\u0001${shield.push(m) - 1}\u0001`)
    .replace(FILLER, '')
  const unshield = (s: string): string => s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => shield[Number(i)])

  // choosing entries in a dropdown ("go to the `Text to Study` dropdown and select Surah An-Nur, then switch to Ya-Sin"): said
  // in the middle of an explanation just as often as in a plain step, so the whole line is read for it
  const dd = dropdownIn(noUrls)
  const picks = dd ? picksIn(noUrls) : []
  const ddPlace = ((): { region?: FindSpec['region']; within: string[] } => {
    const s = noUrls.split(/(?<=[.!?])\s+/).find((x) => DROPDOWN_ANY.test(x) || (dd?.label && x.toLowerCase().includes(dd.label.toLowerCase())))
    if (!s) return { within: [] }
    const p = placeOf(s)
    return { ...p, within: p.within.filter((w) => w !== 'suggestion') } // "dropdown" is what it is, not where it sits
  })()

  // "explain ..." takes the rest of the line: it is what to make clear, not something to click
  const ex = EXPLAIN.exec(guarded)
  let doing = guarded
  if (ex) {
    doing = guarded.slice(0, ex.index)
    const what = clean(unshield(guarded.slice(ex.index + ex[0].length)))
    item.explain = what || clean(unshield(guarded.slice(ex.index)))
  }
  // a leading place: "from left menu," / "in search bar,"
  let place: { region?: FindSpec['region']; within: string[] } = { within: [] }
  let first = true
  const clauses = doing.split(/(?<=[.!?])\s+|,\s*(?:and\s+|then\s+)?|\s+and\s+|\s+then\s+|\bthen\b/i).map(clean).filter(Boolean)
  for (const raw of clauses) {
    const clause = unshield(raw)
    if (first && LOGIN.test(clause)) { item.login = true; first = false; continue }
    first = false
    // what is said about the dropdown and the entries is done as the choices below, not clicked
    if (picks.length && (DROPDOWN_ANY.test(clause) || picksIn(clause).length)) continue
    const lead = /^(?:from|in|on|at|inside|within|under|using)\s+(?:the\s+)?(.+)$/i.exec(clause)
    // "from the left menu click ontology" (no comma): the place and the action in one clause
    const inline = /^(?:from|in|on|at|inside|within)\s+(?:the\s+)?(.+?)\s+((?:click|press|tap|select|choose|open|type|enter|search|scroll|explore)\b.*)$/i.exec(clause)
    const verbHere = !!inline || TYPE_VERB.test(clause) || CLICK_VERB.test(clause) || SCROLL.test(clause)
    if (lead && !verbHere) { place = placeOf(lead[1]); continue }
    const text = inline ? inline[2] : clause
    if (inline) place = placeOf(inline[1])
    const sc = SCROLL.exec(text)
    if (sc && !QUOTED.test(text)) {
      const dir = /up/i.test(sc[1] ?? sc[0]) ? 'up' : 'down'
      item.atoms.push({ action: 'scroll', dir, find: { target: 'scroll', kind: 'scroll', ...(place.region ? { region: place.region } : {}), ...(place.within.length ? { within: place.within } : {}) } })
      continue
    }
    const tv = TYPE_VERB.exec(text)
    const q = QUOTED.exec(text)
    if (tv && q && q.index > tv.index) {
      const after = text.slice(q.index + q[0].length)
      const into = /^\s*(?:in|into|in\s+to|on|inside|within|to|at)\s+(?:the\s+)?(.+)$/i.exec(after)
      const p = into ? placeOf(into[1]) : place
      const boxWords = into ? clean(into[1]) : ''
      const label = boxWords || (place.within.includes('search') || /search/.test(text.slice(0, tv.index)) ? 'search' : 'search')
      item.atoms.push({ action: 'type', label: label.replace(ARTICLE, ''), text: q[1].trim(), find: { target: label.replace(ARTICLE, ''), kind: 'type', ...(p.region ? { region: p.region } : place.region ? { region: place.region } : {}), ...(p.within.length || place.within.length ? { within: [...new Set([...p.within, ...place.within])] } : {}) } })
      continue
    }
    const cv = CLICK_VERB.exec(text)
    if (cv) {
      const atom = clickAtom(cv[1], place)
      if (atom) { item.atoms.push(atom); continue }
    }
    // a quoted name with no verb: the person pointed at it
    if (q && !tv) {
      const atom = clickAtom(text, place)
      if (atom) { item.atoms.push(atom); continue }
    }
    item.notes.push(clause)
  }
  for (const option of picks) {
    const label = dd?.label ?? ''
    item.atoms.push({ action: 'select', label: label || 'dropdown', option, find: { target: label, kind: 'select', ...(ddPlace.region ? { region: ddPlace.region } : {}), ...(ddPlace.within.length ? { within: ddPlace.within } : {}) } })
  }
  return item
}

/** the person's list of steps, or null when what they wrote is not a list of at least two steps */
export function parseStepScript(context: string): StepScript | null {
  let typed = (context.split(/\n\s*Attached notes \(information only\):/)[0] ?? '').replace(/\r/g, '')
  // a video made again with changes: when those changes bring their own list of steps, that list is the script (they win
  // wherever they differ), not a second run of the steps after the first
  const marker = /\n\s*Changes to make to the earlier video of this app[^\n]*\n/.exec(typed)
  if (marker) {
    const changes = typed.slice(marker.index + marker[0].length)
    if (changes.split('\n').filter((l) => BULLET.test(l)).length >= 2) typed = typed.slice(0, marker.index).split('\n').filter((l) => !BULLET.test(l) && !/^\s{2,}\S/.test(l)).join('\n') + '\n' + changes
  }
  const lines = typed.split('\n')
  const listed = lines.filter((l) => BULLET.test(l))
  if (listed.length < 2) return null
  const items: ScriptItem[] = []
  const rest: string[] = []
  let n = 0
  for (const line of lines) {
    const m = BULLET.exec(line)
    if (m) items.push(parseLine(++n, clean(m[1])))
    else if (line.trim()) {
      // a wrapped line belongs to the step above it
      if (items.length && /^\s{2,}\S/.test(line)) {
        const last = items[items.length - 1]
        const merged = parseLine(last.n, `${last.said} ${clean(line)}`)
        items[items.length - 1] = merged
      } else rest.push(line.trim())
    }
  }
  if (!items.some((i) => i.atoms.length || i.explain)) return null
  return { items, goal: rest.join(' ') }
}

/** the step in plain words for the narrator when no AI writes it: the person's own words, tidied */
export function plainStep(item: ScriptItem): string {
  const s = item.said.replace(/\s+/g, ' ').replace(/[.]+$/, '')
  return `${cap(s)}.`
}
