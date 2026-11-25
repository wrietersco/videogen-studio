import type { Atom, FindSpec } from '@shared/appRecon'
import { findDatePhrase, readDate } from './dates'

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

export type { Atom } from '@shared/appRecon'

export interface ScriptItem {
  n: number
  /** the number the person wrote in front of the step (their list can skip numbers: 3, 5, 6) */
  written?: number
  /** the person's own words for this step, number removed */
  said: string
  /** this step is the engine's own sign-in */
  login: boolean
  atoms: Atom[]
  /** what the narration for this step must make clear ("explain ...") */
  explain?: string
  /** words in the step that are not an action (context for the narration: why, what to make clear) */
  notes: string[]
  /** parts of the step that look like an instruction but were not understood: each is reported as skipped, never dropped silently */
  unread: string[]
  /** the step is a goal ("show how a customer books a colour appointment"), not a list of clicks: it needs a plan made from the page */
  goal?: string
  /** a step that is only something to say ("explain ...", "provide a conclusion"): nothing is done on the page */
  narration?: boolean
  /** the person asked for the keyboard only: clicks became Tab-until-focused and Enter/Space */
  keyboard?: boolean
}

export interface StepScript {
  items: ScriptItem[]
  /** the rest of what was written (the goal, in the person's words; tone and voice sentences are in `tone`) */
  goal: string
  /** where the steps came from: a numbered or bulleted list, the sentences of a prose brief, or the actions the AI plan listed */
  source: 'list' | 'prose' | 'plan'
  /** sentences of the brief that ask for no action (voice, tone, context): never a step and never "unplaced" */
  tone: string[]
  /** the rules for the whole run ("if a cookie banner shows ...") found in the steps, in the order written */
  whenever: Array<Extract<Atom, { action: 'whenever' }>>
}

// a name can be quoted with straight or curly quotes or with backticks (`The even-odd circle`)
const Q = '["“”\'‘’`]'
const NQ = '[^"“”\'‘’`]'
/** a quoted name: `backticks` (anything inside, a quote too), "double" or curly quotes, or 'single' quotes that open at a word start and close at a word end ("kids' cut" is no quote) */
const QUOTE_SRC = String.raw`\x60([^\x60]{1,200})\x60|["“]([^"“”]{1,200})["”]|(?<![\p{L}\p{N}])['‘]([^'’‘]{1,100}?)(?<=\S)['’](?![\p{L}\p{N}])`
const QUOTED = new RegExp(QUOTE_SRC, 'u')
const QUOTED_G = new RegExp(QUOTE_SRC, 'gu')
const uq = (m: RegExpExecArray | RegExpMatchArray): string => (m[1] ?? m[2] ?? m[3] ?? '').trim()
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
/** a list line: "3.", "step 3:", "6)", "- ", also with quote or arrow marks in front (">>6.", "→ 7.") */
export const BULLET = /^\s*(?:[>»›→#]+\s*)*(?:(?:step\s*)?(\d{1,3})\s*[.):\-]|[-*•▪●])\s+(.*\S)\s*$/i
const HOVER = /^(?:(?:and|then|now|next|please)\s+)*(?:hover(?:\s+(?:over|on|above))?|mouse\s*-?over|move\s+(?:the\s+)?(?:mouse|pointer|cursor)\s+(?:over|to|onto)|point\s+(?:at|to)|rest\s+(?:the\s+)?(?:mouse|pointer|cursor)\s+(?:on|over))\s+(.*)$/i
/** scroll to a named part of the page */
const SCROLL_TO = /\bscroll(?:\s*-?\s*(?:down|up))?\s+(?:to|until|towards?|till)\s+(?:you\s+(?:see|reach|find)\s+)?(?:the\s+)?(.+)$/i
const PAGE_EDGE = /^(?:the\s+)?(?:very\s+)?(?:bottom|end|top|beginning|start|footer|header)(?:\s+of\s+the\s+page)?$/i
const COLOUR = '(?:(?:light|dark|bright|pale|deep)\\s+)?(?:blue|green|orange|red|yellow|purple|violet|pink|teal|cyan|brown|grey|gray|black|white|indigo|magenta|gold|golden|turquoise|navy|lime|maroon)'
const MARK_NOUN = '(?:lines?|curves?|bars?|points?|dots?|slices?|segments?|arcs?|rings?|areas?|markers?|wedges?|sectors?|paths?|series|traces?|columns?|squares?|diamonds?)'
const CHART_WORD = '(?:chart|graph|plot|circle|diagram|figure|visuali[sz]ation|map|timeline)s?'
/** "click blue, green and orange lines on the charts", "hover over a line on the chart" */
const MARK_RE = new RegExp(
  `\\b(click(?:\\s+on)?|tap(?:\\s+on)?|press|select|hover(?:\\s+(?:over|on))?|mouse\\s*-?over)\\s+(?:on\\s+)?(?:(?:a|an|the|any|one|some|each|every)\\s+)?(?:(${COLOUR}(?:\\s*(?:,|and|&|or)\\s*(?:and\\s+|or\\s+)?${COLOUR})*)\\s+)?(${MARK_NOUN})\\b(?:\\s+(?:on|in|of|from|inside|within)\\s+(?:the\\s+)?((?:[\\w–-]+\\s+){0,5}?${CHART_WORD}))?`,
  'i'
)
const COLOUR_ALIAS: Record<string, string> = { grey: 'gray', violet: 'purple', golden: 'yellow', gold: 'yellow', turquoise: 'teal', indigo: 'purple', navy: 'blue', maroon: 'red', lime: 'green', magenta: 'pink' }
/** the colour names in some words, in the order said ("blue, green and orange" → blue, green, orange) */
export const coloursIn = (text: string): string[] => {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(new RegExp(COLOUR, 'g'))) {
    const w = m[0].trim().split(/\s+/).pop() ?? ''
    const c = COLOUR_ALIAS[w] ?? w
    if (c && !out.includes(c)) out.push(c)
  }
  return out
}
const LOGIN = /^(?:(?:and|then|first|please)\s+)*(?:log\s?-?\s?(?:in|into|on)|sign\s?-?\s?(?:in|into|on)|authenticate|login)\b/i
const EXPLAIN = /\b(?:(?:to|and|then)\s+)?(explain|describe|tell(?:\s+(?:me|us|the viewer))?|talk\s+about|mention|highlight|discuss|point\s+out|summari[sz]e|cover|narrate|walk\s+(?:me\s+)?through|read\s+out|read\s+aloud)\b/i
const SCROLL = /\b(?:scroll\s*-?\s*(down|up)|scrolldown|scrollup|scroll(?:\s+(?:to\s+(?:the\s+)?(?:bottom|end)|through|all\s+the\s+way))?)\b/i
const TYPE_VERB = /\b(?:type(?:\s+in)?|enter|input|search\s+for|write|put(?:\s+in)?|fill(?:\s+in|\s+out)?)\b/i

/** verbs that name a control to press; the ones in JOIN are also (part of) the control's own label: "confirm the booking" presses "Confirm booking" */
const TOGGLE_V = ['un-?tick', 'tick', 'un-?check', 'check', 'toggle', 'turn\\s+on', 'turn\\s+off', 'switch\\s+on', 'switch\\s+off', 'enable', 'disable', 'mark']
const JOIN_V = ['confirm', 'finish', 'submit', 'place', 'save', 'send', 'apply', 'download', 'copy', 'run', 'clear', 'reset', 'book', 'buy', 'order', 'pay', 'add', 'remove', 'continue', 'proceed', 'cancel', 'increase', 'decrease', 'log\\s?out', 'sign\\s?out', 'refresh', 'reload', 'upload', 'share', 'start', 'stop', 'play', 'pause', 'accept', 'reject', 'decline', 'delete', 'undo', 'redo', 'skip', 'checkout']
const PLAIN_V = ['click(?:\\s+on|\\s+into)?', 'press', 'tap(?:\\s+on)?', 'hit', 'select', 'choose', 'pick', 'open(?:\\s+up)?', 'expand', 'collapse', 'go\\s+forward\\s+to', 'go\\s+to', 'navigate\\s+to', 'switch\\s+to', 'move\\s+to', 'visit', 'head\\s+to', 'use', 'explore', 'check\\s+out', 'flip\\s+to', 'go\\s+back', 'close', 'dismiss', 'hide', 'sort', 'bring\\s+up', 'flip\\s+through']
const ALL_V = [...PLAIN_V, ...TOGGLE_V, ...JOIN_V].sort((a, b) => b.length - a.length)
const LEAD_WORDS = '(?:(?:and|then|now|next|please|also|finally|first|lastly|so|but)[,\\s]+)*'
const CLICK_VERB = new RegExp(`^${LEAD_WORDS}(${ALL_V.join('|')})(?:\\s+(.*))?$`, 'i')
const LEAD_RE = new RegExp(`^${LEAD_WORDS}`, 'i')
/** "in Key terms click …", "in the request body change …": the place, then the action */
const INLINE = new RegExp(String.raw`^(?:from|in|on|at|inside|within)\s+(?:the\s+)?(.+?)\s+((?:${ALL_V.join('|')}|type|enter|search|scroll|hover|double[- ]click|drag|rename|wait|set|change|put|fill|write|slide|use|focus|replace)\b.*)$`, 'i')
const joinsLabel = (verb: string): boolean => new RegExp(`^(?:${JOIN_V.join('|')})$`, 'i').test(verb.replace(/\s+/g, ' ').trim()) || /^log\s?out$|^sign\s?out$/i.test(verb)
/** words that open a sentence a person means as an instruction to do something (anything that starts like this and was not understood is reported, not dropped) */
const ACTION_WORDS = new Set(
  ['click', 'press', 'tap', 'hit', 'select', 'choose', 'pick', 'open', 'expand', 'collapse', 'go', 'navigate', 'switch', 'move', 'visit', 'head', 'use', 'explore', 'check', 'tick', 'untick', 'uncheck', 'toggle', 'turn', 'enable', 'disable', 'mark', 'sort', 'add', 'remove', 'close', 'dismiss', 'accept', 'reject', 'decline', 'increase', 'decrease', 'confirm', 'finish', 'submit', 'place', 'save', 'send', 'apply', 'download', 'copy', 'run', 'clear', 'reset', 'book', 'buy', 'order', 'pay', 'continue', 'proceed', 'cancel', 'type', 'enter', 'input', 'search', 'write', 'put', 'fill', 'set', 'change', 'update', 'rename', 'replace', 'edit', 'drag', 'drop', 'slide', 'scroll', 'hover', 'wait', 'flip', 'tab', 'reschedule', 'log', 'sign', 'refresh', 'reload', 'upload', 'share', 'start', 'stop', 'play', 'pause', 'delete', 'undo', 'redo', 'skip', 'checkout', 'bring', 'hide', 'double', 'right', 'swipe', 'zoom', 'drag', 'paste', 'focus', 'unfocus', 'filter', 'tick', 'look', 'find', 'show', 'display', 'open', 'read', 'try', 'make']
)
/** words that start something said about the step, not something to do */
const NOT_A_VERB = new Set(
  ['so', 'because', 'which', 'that', 'this', 'these', 'those', 'to', 'with', 'for', 'while', 'as', 'if', 'it', 'its', 'they', 'them', 'we', 'you', 'your', 'i', 'the', 'a', 'an', 'my', 'our', 'when', 'where', 'what', 'how', 'why', 'also', 'just', 'only', 'not', 'no', 'all', 'any', 'each', 'every', 'both', 'then', 'and', 'or', 'but', 'there', 'here', 'is', 'are', 'was', 'were', 'be', 'been', 'has', 'have', 'had', 'will', 'would', 'can', 'could', 'should', 'may', 'might', 'of', 'in', 'on', 'at', 'by', 'from', 'into', 'onto', 'up', 'down', 'out', 'off', 'over', 'about', 'keep', 'make', 'stay', 'remember', 'note', 'avoid', "don't", 'do', 'never', 'always', 'please', 'nothing', 'something', 'everything', 'one', 'two', 'three', 'more', 'less', 'very', 'really', 'quite', 'maybe', 'perhaps', 'ok', 'okay', 'size', 'colour', 'color', 'tab', 'option', 'item', 'price', 'plan', 'step', 'page', 'menu', 'section', 'card', 'row', 'column', 'name', 'email', 'phone', 'address', 'time', 'date']
)
/** a lowercase word that opens a clause like a command ("flibber the zorp"): not understood, so it is reported instead of dropped */
const looksImperative = (head: string): boolean => /^[a-z]{3,}$/.test(head) && !head.endsWith('ing') && !NOT_A_VERB.has(head)

/** a sentence about what the film should be like, or what the video is for: voice, tone, context. It asks for no action */
const TONE_WORDS = /\b(?:warm|friendly|welcoming|calm|upbeat|energetic|enthusiastic|casual|simple|simply|short|quick|fast|slow|no\s+jargon|jargon|techy|technical|non-?technical|fancy|loud|quiet|music|voice|voiceover|narrat\w+|tone|sound|sounds|style|vibe|feel|mood|professional|fun|playful|formal|brand|audience|customers?\s+are|viewers?|beginners?)\b/i

const KEY_NAMES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', spacebar: 'Space', 'space bar': 'Space', backspace: 'Backspace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End',
  'page up': 'PageUp', pageup: 'PageUp', 'page down': 'PageDown', pagedown: 'PageDown', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
  'up arrow': 'ArrowUp', 'down arrow': 'ArrowDown', 'left arrow': 'ArrowLeft', 'right arrow': 'ArrowRight', 'arrow up': 'ArrowUp', 'arrow down': 'ArrowDown', 'arrow left': 'ArrowLeft', 'arrow right': 'ArrowRight',
  slash: '/', 'forward slash': '/', backslash: '\\', 'question mark': '?', comma: ',', period: '.'
}
const MODS: Record<string, string> = { ctrl: 'Control', control: 'Control', cmd: 'Meta', command: 'Meta', meta: 'Meta', alt: 'Alt', option: 'Alt', shift: 'Shift' }
const CHORD = /\b((?:ctrl|control|cmd|command|alt|option|shift)(?:\s*\+\s*(?:ctrl|control|cmd|command|alt|option|shift))*\s*\+\s*(?:[a-z0-9/]|f\d{1,2}|enter|esc|escape|tab|space|[,.;'=\\-]))(?![\w])/i
/** "Ctrl+K" → "Control+K" (the key names the browser driver knows) */
const chordOf = (s: string): string =>
  s
    .split(/\s*\+\s*/)
    .map((p) => {
      const l = p.toLowerCase()
      return MODS[l] ?? KEY_NAMES[l] ?? (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1))
    })
    .join('+')
const FOCUS_UNTIL = /\buntil\s+(?:the\s+)?(.+?)\s+(?:button\s+|link\s+|field\s+|box\s+|tab\s+|checkbox\s+|icon\s+)?(?:is|has|gets?|are|becomes?)\s+(?:focus(?:ed)?|selected|highlighted|active)\b/i
const KEYBOARD_ONLY = /\b(?:using|with|use|via)\s+(?:only\s+)?(?:the\s+|my\s+)?keyboard(?:\s+only)?\b|\bkeyboard[-\s]only\b|\bonly\s+(?:the\s+)?keyboard\b/i
const ARROWS = /\b(?:using|with|use|via)\s+(?:only\s+)?(?:the\s+)?(?:keyboard\s+)?arrow\s+keys?\b/i

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1, final: -1 }
const ordinalOf = (w: string): number | undefined => {
  const l = w.toLowerCase()
  if (ORDINALS[l] !== undefined) return ORDINALS[l]
  const m = /^(\d{1,2})(?:st|nd|rd|th)$/.exec(l)
  return m ? Number(m[1]) : undefined
}
const ORD_WORD = '(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final|\\d{1,2}(?:st|nd|rd|th))'
const CRITERIA: Record<string, 'highest' | 'lowest' | 'cheapest' | 'most-expensive'> = { cheapest: 'cheapest', 'most expensive': 'most-expensive', priciest: 'most-expensive', highest: 'highest', biggest: 'highest', largest: 'highest', tallest: 'highest', top: 'highest', maximum: 'highest', peak: 'highest', lowest: 'lowest', smallest: 'lowest', shortest: 'lowest', minimum: 'lowest' }
const CRIT_WORD = '(?:cheapest|most\\s+expensive|priciest|highest|lowest|biggest|largest|smallest|tallest|shortest|top|maximum|minimum)'
const REPEAT = /\s*,?\s*\b(once|twice|thrice|two\s+times|three\s+times|four\s+times|five\s+times|\d{1,2}\s+times)\s*$/i
const REPEAT_N: Record<string, number> = { once: 1, twice: 2, thrice: 3, 'two times': 2, 'three times': 3, 'four times': 4, 'five times': 5 }
const ICON_WITH = /\b(?:with|using|via|by\s+(?:clicking|pressing)|through)\s+(?:the\s+|its\s+)?(?:little\s+|small\s+)?[\w'’-]+(?:\s+[\w'’-]+)?\s+(?:icon|button|arrow|arrows)\s*$/i
const GENERIC_CONTAINER = /^(?:it|that|this|them|window|popup|pop-?up|dialog|modal|banner|message|box|overlay|one)$/i
/** "…to show the details", "…so the zoom shows it": why the action is done, not part of the control's name */
const PURPOSE_RE = /\s+(?:(?:in\s+order\s+to|so\s+that|to)\s+(?:show|see|display|reveal|learn|understand|illustrate|demonstrate|find\s+out)\b|so\s+(?:we|i|you|they|the|it|that|everyone|viewers?|customers?)\b).*$/i

const REL = /(?:just\s+|right\s+|directly\s+|immediately\s+)*(above|over|on\s+top\s+of|below|under|beneath|(?:to\s+the\s+)?left\s+of|(?:to\s+the\s+)?right\s+of|next\s+to|beside|near)\s+(?:the\s+)?(.+?)\s*$/i
const REL_MAP: Record<string, NonNullable<FindSpec['relation']>['rel']> = { above: 'above', over: 'above', 'on top of': 'above', below: 'below', under: 'below', beneath: 'below', 'left of': 'leftOf', 'right of': 'rightOf', 'next to': 'near', beside: 'near', near: 'near' }
const NOUN_TAIL = /\s+(icon|button|tab|link|item|option|menu\s+item|entry|toggle|control|symbol)$/i
const ARTICLE = /^(?:the|a|an|my|our|its|that|this)\s+/i

const clean = (s: string): string => s.replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').trim()
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// ---------------------------------------------------------------- names of controls, cleaned

/** "daniel as the stylist" → "daniel"; "the mens cut is fine" → "mens cut"; "the blue one" → "blue"; "the orange colour" → "orange" */
export function cleanName(raw: string): string {
  let s = clean(raw)
  for (let i = 0; i < 3; i++) s = s.replace(ARTICLE, '')
  s = s.replace(/\s+(?:is|are|will\s+do|works?|would\s+be|looks?)\s+(?:fine|ok|okay|good|great|perfect|best|right|enough|alright)\b.*$/i, '')
  s = s.replace(/\s+as\s+(?:the|a|an|my|our|your|their|his|her)\s+[\w' -]+$/i, '')
  s = s.replace(/\s+(?:again|please|too|also|as\s+well|for\s+me|instead)$/i, '')
  s = s.replace(/\s+(?:colou?r|size)$/i, '')
  s = s.replace(/^(?:colou?r|size)\s+/i, '')
  s = s.replace(/\s+one$/i, '')
  s = s.replace(/\s+series$/i, '')
  s = s.replace(/\s+(?:icon|button|tab|link|item|option|menu\s+item|entry|toggle|control|symbol|checkbox|check\s?box|box|field|switch|dropdown|drop-down|filter)$/i, (m) => (/filter/i.test(m) ? ' filter' : ''))
  s = s.replace(/^(?:the\s+)?(?:one|option|item)\s+(?:called|named|labell?ed)\s+/i, '')
  return clean(s.replace(ARTICLE, ''))
}

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

type Place = { region?: FindSpec['region']; within: string[] }

/** where a step says its target is, also by the name of the part ("in Key terms", "in the request body") when it is none of the usual words */
function namedPlace(phrase: string): Place {
  const p = placeOf(phrase)
  if (p.region || p.within.length) return p
  const name = cleanName(phrase.replace(/\s+(?:section|area|part|panel|pane|widget|frame|form|page)$/i, '')).toLowerCase()
  return name && name.split(/\s+/).length <= 4 ? { within: [name] } : p
}

function clickAtom(raw: string, place: Place): Atom | null {
  let rest = raw
  let relation: FindSpec['relation']
  // "(just right above the pause icon)" or a trailing "just above the pause icon"
  // (a bracket inside quotes is part of the name: "Volcano (2D)" is not "Volcano" with a note)
  const masked = rest.replace(QUOTED_G, (m) => ' '.repeat(m.length))
  const parenAt = /\(([^)]*)\)/.exec(masked)
  const paren = parenAt ? ([rest.slice(parenAt.index, parenAt.index + parenAt[0].length), parenAt[1]] as [string, string]) : null
  if (paren) {
    const m = REL.exec(paren[1])
    if (m) relation = { rel: REL_MAP[m[1].toLowerCase().replace(/^to the\s+/, '').replace(/\s+/g, ' ')] ?? 'near', to: clean(m[2].replace(NOUN_TAIL, '')) }
    rest = rest.replace(paren[0], ' ')
  }
  const tail = relation ? null : REL.exec(rest.replace(/["“”‘’]/g, '"'))
  if (tail && !QUOTED.test(rest.slice(tail.index))) {
    relation = { rel: REL_MAP[tail[1].toLowerCase().replace(/^to the\s+/, '').replace(/\s+/g, ' ')] ?? 'near', to: clean(tail[2].replace(NOUN_TAIL, '')) }
    rest = rest.slice(0, tail.index)
  }
  const q = QUOTED.exec(rest)
  // "SHAPES -> 05 The even-odd circle": the section names the way there, the last stop is what is clicked
  if (!q && PATH_SEP.test(rest)) rest = rest.split(PATH_SEP).pop() ?? rest
  const before = q ? rest.slice(0, q.index) : rest
  const after = q ? rest.slice(q.index + q[0].length) : ''
  let label = q ? uq(q) : clean(clean(before).replace(ARTICLE, '').replace(NOUN_TAIL, '').replace(/\b(?:the\s+)?(?:suggestion|option|result|entry)\b/i, ''))
  const role = roleOf(`${before} ${after}`) ?? (relation && !q ? 'icon' : undefined)
  if (!q) label = cleanName(label)
  const within = [...place.within]
  let region = place.region
  // "the arabic word in the verse": what is clicked, and the part of the page it is in
  if (!q) {
    const loc = /^(.+?)\s+(?:in|inside|within|on)\s+(?:the\s+)?([\w'’-]+(?:\s+[\w'’-]+){0,2}?)(?:\s+at\s+the\s+(top|bottom))?$/i.exec(label)
    if (loc && !/\b(?:sign|log)$/i.test(loc[1])) {
      label = clean(loc[1])
      const where = loc[2].toLowerCase().replace(/\s+(?:area|section|panel|pane|tab|text|frame|widget|window)$/, '')
      if (where && !GENERIC_CONTAINER.test(where)) within.push(where)
      if (loc[3]) region = loc[3].toLowerCase() as FindSpec['region']
    }
    const atEdge = /^(.+?)\s+at\s+the\s+(top|bottom)(?:\s+of\s+the\s+page)?$/i.exec(label)
    if (atEdge) { label = clean(atEdge[1]); region = atEdge[2].toLowerCase() as FindSpec['region'] }
  }
  if (!label) return null
  // a quoted name can carry a trailing "tab"/"icon" outside the quotes: it is the control's kind, not part of its name
  if (role === 'suggestion' && !within.includes('suggestion')) within.push('suggestion')
  return { action: 'click', label, find: { target: label, kind: 'click', ...(region ? { region } : {}), ...(within.length ? { within } : {}), ...(relation ? { relation } : {}), ...(role ? { role } : {}) } }
}

const GERUND_BASE = new Set(['add', 'pick', 'choose', 'click', 'select', 'press', 'open', 'close', 'go', 'log', 'sign', 'enter', 'type', 'fill', 'tick', 'turn', 'switch', 'confirm', 'book', 'buy', 'save', 'submit', 'check', 'scroll', 'use', 'move', 'place', 'finish', 'continue', 'drag', 'expand', 'hover', 'search', 'write', 'put', 'set', 'change'])
/** "adding" → "add", "choosing" → "choose", "putting" → "put" (only for the verbs this reads) */
function gerundBase(w: string): string | null {
  const l = w.toLowerCase()
  if (!l.endsWith('ing')) return null
  const stem = l.slice(0, -3)
  for (const c of [stem, `${stem}e`, stem.replace(/(.)\1$/, '$1')]) if (GERUND_BASE.has(c)) return c
  return null
}

// ---------------------------------------------------------------- one line → small actions

type Whenever = Extract<Atom, { action: 'whenever' }>
const COND_SUBJECT = /\b(?:pop-?ups?|banners?|cookies?|modals?|dialogs?|overlays?|surveys?|notifications?|offers?|prompts?|notices?|consent|newsletter|alerts?|toasts?)\b/i
const COND_RE = /^(?:(?:and|then|also|now|please)[,\s]+)*(?:if|when|whenever|in\s+case|should)\s+(?:an?\s+|the\s+|any\s+)?(.+?)\s+(?:shows?(?:\s+up)?|appears?|pops?\s+up|(?:is|are)\s+(?:showing|visible|there|present|open|displayed|shown|up)|comes?\s+up|opens?|exists?|covers?\s+the\s+\w+|blocks?\s+the\s+\w+)\b[^,]*?\s*(?:,|\bthen\b|-)\s*(.+)$/i
const ALWAYS_RE = /^(?:(?:and|then|also|now|please)[,\s]+)*(?:always|whenever|every\s+time|any\s+time|at\s+any\s+point|throughout)\b.*\b(?:pop-?ups?|banners?|cookies?|modals?|dialogs?|overlays?|surveys?)\b/i

function wheneverFrom(sentence: string): Whenever | null {
  let subject = ''
  let act = ''
  const m = COND_RE.exec(sentence)
  if (m && COND_SUBJECT.test(m[1])) { subject = m[1]; act = m[2] }
  else if (ALWAYS_RE.test(sentence)) { subject = sentence; act = sentence }
  else return null
  const condition: Whenever['condition'] = /cookie|consent/i.test(subject) ? 'cookie' : /banner|notice|bar\b/i.test(subject) ? 'banner' : 'popup'
  const then: Whenever['then'] = /\bonly\s+(?:the\s+)?(?:necessary|essential|required)|\bessentials?\b|\bnecessary\b|\breject|\bdecline|\bopt\s+out/i.test(act) ? 'accept-essential' : /\b(?:accept|agree|allow|consent)\b/i.test(act) && !/close|dismiss/i.test(act) ? 'accept' : 'close'
  const label = `if a ${condition === 'cookie' ? 'cookie banner' : condition} shows up, ${then === 'close' ? 'close it' : then === 'accept' ? 'accept it' : 'accept only the necessary ones'}`
  return { action: 'whenever', label, condition, then }
}

const SLIDER_NUM = /[£$€]?\s*(\d+(?:[.,]\d+)?)/g

/** the whole text a step says is a goal rather than clicks */
const GOAL_RE = /^(?:(?:and|then|now|next|please)\s+)*(?:(?:show|demonstrate|walk\s+(?:me\s+|us\s+)?through|illustrate)\b.*\b(?:how|what\s+happens|when|would|difference|handles?|handling|workflow|process|examples?)\b|explain\b.*\bwhat\s+happens\s+(?:when|if)\b|(?:find|figure\s+out|work\s+out|look\s+for|discover|compare)\b)/i
const EXAMPLES_RE = /\b(?:live\s+)?examples?\b|\bdemonstrate\b/i
const NARRATE_RE = /^(?:(?:and|then|now|next|please|also|finally|lastly)[,\s]+)*(?:provide|give|conclude|summari[sz]e|wrap\s+up|recap|thank|say|tell|state|read|mention|describe|talk|point|note|highlight|show\s+(?:the|what|me|us|that|it|its|them)|display\s+the|see\s+(?:the|what)|watch|look\s+at|notice|observe|end\s+(?:with|by)|finish\s+(?:with|by)|close\s+(?:with|by)|let(?:'s)?\s+see|so\b)/i

interface Reading {
  atoms: Atom[]
  /** the words were part of the action before them ("drop it above the first card", "pick it"): nothing more to do, nothing dropped */
  absorbed?: boolean
  /** the step is only something to say */
  narration?: boolean
}

function parseLine(n: number, said: string): ScriptItem {
  const item: ScriptItem = { n, said, login: false, atoms: [], notes: [], unread: [] }
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
    .replace(QUOTED_G, (m) => `\u0001${shield.push(m) - 1}\u0001`)
    .replace(FILLER, '')
  const unshield = (s: string): string => s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => shield[Number(i)])

  // choosing entries in a dropdown ("go to the `Text to Study` dropdown and select Surah An-Nur, then switch to Ya-Sin"): said
  // in the middle of an explanation just as often as in a plain step, so the whole line is read for it
  const dd = dropdownIn(noUrls)
  const picks = dd ? picksIn(noUrls) : []
  const ddPlace = ((): Place => {
    const s = noUrls.split(/(?<=[.!?])\s+/).find((x) => DROPDOWN_ANY.test(x) || (dd?.label && x.toLowerCase().includes(dd.label.toLowerCase())))
    if (!s) return { within: [] }
    const p = placeOf(s)
    return { ...p, within: p.within.filter((w) => w !== 'suggestion') } // "dropdown" is what it is, not where it sits
  })()

  // "explain ..." takes the rest of its sentence: it is what to make clear, not something to click. A later sentence is read
  // again (it can ask for another click: "use and explain the tab X. click the word in the verse")
  const marks: Atom[] = []
  const explains: string[] = []
  const clauses: string[] = []
  for (const sentence0 of guarded.split(/(?<=[.!?])\s+(?=\S)/)) {
    let sentence = sentence0
    // a rule for the whole run: "if a cookie banner shows, accept only the necessary ones"
    const rule = wheneverFrom(unshield(sentence))
    if (rule) { item.atoms.push(rule); continue }
    // "before adding it to the cart, first pick the blue one": the clause that comes first is done first; a gerund names a step done elsewhere
    const bef = /^(?:(?:and|then|now)\s+)*before\s+(.+?),\s*(?:you\s+)?(?:first\s+|just\s+)?(.+)$/i.exec(sentence)
    if (bef) {
      const g = /^(\w+ing)\b/.exec(bef[1])
      if (g && gerundBase(g[1])) { item.notes.push(`before ${clean(unshield(bef[1]))}`); sentence = bef[2] }
      else sentence = `${bef[2]}, then ${bef[1]}`
    }
    const butFirst = /^(.+?),?\s+but\s+first\s+(.+)$/i.exec(sentence)
    if (butFirst) sentence = `${butFirst[2]}, then ${butFirst[1]}`
    const afterG = /^(.+?)\s+after\s+((\w+ing)\b.+)$/i.exec(sentence)
    if (afterG && gerundBase(afterG[3])) sentence = `${afterG[2].replace(/^\w+ing\b/, (w) => gerundBase(w) ?? w)}, then ${afterG[1]}`
    // "writing a valid body with the email X and the plan Y" is one thing to type, not three clauses
    sentence = sentence.replace(/\b(?:writ(?:e|ing)|typ(?:e|ing)|enter(?:ing)?)\s+(?:a\s+|the\s+)?(?:valid\s+)?(?:body|request|json|payload)\s+with\s+[^,;]+/i, (m0) => `\u0001${shield.push(m0) - 1}\u0001`)
    const ex = EXPLAIN.exec(sentence)
    let doing = sentence
    if (ex) {
      doing = sentence.slice(0, ex.index)
      const restG = sentence.slice(ex.index + ex[0].length)
      const what = clean(unshield(restG))
      explains.push(what || clean(unshield(sentence.slice(ex.index))))
      // "use and explain the tab X": the verb in front is about the thing named after "explain"
      const bare = /(?:^|[\s,;])(use|open|click(?:\s+on)?|select|choose|explore|try|visit|check\s+out|tap)\s*$/i.exec(doing)
      if (bare && what) {
        doing = `${doing} ${restG.split(/\s+(?:and|so|then)\s+|[;]/i)[0]}`
        // "use and explain the tab `Notes`, then the tab `Sources`": each named thing is used
        for (const more of restG.split(/,?\s+then\s+/i).slice(1)) if (QUOTED.test(unshield(more))) doing += `, ${bare[1]} ${more.split(/\s+(?:and|so)\s+/i)[0]}`
      }
    }
    // a chart point by value: "click the blue line at its highest point, the June to August peak"
    doing = doing.replace(
      new RegExp(`\\b(click(?:\\s+on)?|tap(?:\\s+on)?|press|select|hover(?:\\s+(?:over|on))?)\\s+(?:on\\s+)?(?:the\\s+)?(${COLOUR})\\s+(${MARK_NOUN})\\s+at\\s+(?:its|the)\\s+(highest|lowest|top|bottom|maximum|minimum|peak)\\s+(?:point|value|spot)(?:\\s*,?\\s*(?:the\\s+)?([^,.]*?(?:peak|dip|low|high|top|bottom)))?(?=\\s*(?:,|\\band\\b|\\bthen\\b|$))`, 'i'),
      (_m: string, verb: string, col: string, noun: string, crit: string, range?: string) => {
        const colours = coloursIn(col)
        const nn = noun.toLowerCase().replace(/s$/, '')
        const label = clean(`${colours.join(' ')} ${nn} ${/low|bottom|minimum/i.test(crit) ? 'lowest' : 'highest'} point`)
        marks.push({ action: 'pick', label, verb: /hover/i.test(verb) ? 'hover' : 'click', criterion: /low|bottom|minimum/i.test(crit) ? 'lowest' : 'highest', ...(range ? { within: clean(unshield(range)).replace(/^the\s+/i, '') } : {}), find: { target: label, kind: /hover/i.test(verb) ? 'hover' : 'click', colours, noun: nn } })
        return `\u0002${marks.length - 1}\u0002`
      }
    )
    // chart marks named by colour or kind ("click blue, green and orange lines on the charts") stay whole: their commas are a list
    doing = doing.replace(MARK_RE, (m0: string, verb: string, cols: string | undefined, noun: string, chart: string | undefined) => {
      const v = /hover|mouse/i.test(verb) ? 'hover' : 'click'
      const colours = cols ? coloursIn(cols) : []
      const label = clean(`${colours.join(', ')} ${noun}${chart ? ` on the ${chart}` : ''}`)
      marks.push({ action: 'mark', verb: v, label, colours, noun: noun.toLowerCase().replace(/s$/, ''), find: { target: label, kind: v === 'hover' ? 'hover' : 'click', ...(colours.length ? { colours } : {}), noun: noun.toLowerCase().replace(/s$/, ''), ...(chart ? { chart: clean(chart) } : {}) } })
      return `\u0002${marks.length - 1}\u0002`
    })
    // a slider is said with numbers that a comma or "and" would cut ("£40 to £80", "between 40 and 80")
    clauses.push(...splitClauses(doing))
  }
  if (explains.length) item.explain = explains.join(' ')

  // ---- the clauses, one by one
  let place: Place = { within: [] }
  let first = true
  let kb = false
  let lastClick: Extract<Atom, { action: 'click' }> | undefined
  let lastToggle = false
  let lastNamed = ''
  const push = (...a: Atom[]): void => {
    for (const x of a) {
      item.atoms.push(x)
      if (x.action === 'click') lastClick = x
    }
  }
  const emitClick = (atom: Atom, toggle = false): void => {
    if (kb && atom.action === 'click') {
      // the keyboard only: go to it with Tab, press it with Space (a box) or Enter (a button)
      push({ action: 'key', label: `Tab until ${atom.label} is focused`, keys: 'Tab', repeatUntil: atom.label }, { action: 'key', label: `${toggle ? 'toggle' : 'press'} ${atom.label}`, keys: toggle ? 'Space' : 'Enter' })
      return
    }
    push(atom)
  }
  for (const raw of clauses) {
    const markAt = /\u0002(\d+)\u0002/.exec(raw)
    if (markAt) {
      first = false
      push(marks[Number(markAt[1])])
      continue
    }
    let clause = unshield(raw)
    // keep numbers of a slider with the slider ("so it covers roughly £40 to £80" is not a purpose here)
    const isSlider = /\bslider\b/i.test(clause)
    // why it is done ("to show the details") is for the narration, not part of the control's name
    if (!isSlider) {
      const why = PURPOSE_RE.exec(clause)
      if (why && !SCROLL_TO.test(clause.slice(0, why.index))) {
        item.notes.push(clean(clause.slice(why.index)))
        clause = clause.slice(0, why.index)
      }
    }
    if (first && LOGIN.test(clause)) { item.login = true; first = false; continue }
    first = false
    // "go to ``": the address was taken out above, what is left of the words is nothing
    if (urls.length && /^(?:(?:go|navigate|head)\s*(?:to)?|open(?:\s+up)?|visit|load|browse\s+to)?$/i.test(clause.replace(/[`'"“”‘’\s:]+/g, ' ').trim())) continue
    // what is said about the dropdown and the entries is done as the choices below, not clicked
    if (picks.length && (DROPDOWN_ANY.test(clause) || picksIn(clause).length)) continue
    // how the step is done: "now using only the keyboard", "keyboard only"
    if (KEYBOARD_ONLY.test(clause) && !ARROWS.test(clause)) {
      kb = true
      item.keyboard = true
      clause = clean(clause.replace(KEYBOARD_ONLY, ' '))
      if (!clause || /^(?:now|and|then|please|,)*$/i.test(clause)) continue
    }
    const lead = /^(?:from|in|on|at|inside|within|under|using)\s+(?:the\s+)?(.+)$/i.exec(clause)
    // "from the left menu click ontology" (no comma): the place and the action in one clause
    const inline = INLINE.exec(clause)
    const verbHere = !!inline || TYPE_VERB.test(clause) || CLICK_VERB.test(clause.replace(LEAD_RE, '')) || SCROLL.test(clause) || HOVER.test(clause)
    if (lead && !verbHere) { place = namedPlace(lead[1]); continue }
    let text = inline ? inline[2] : clause
    let here = place
    if (inline) {
      const np = namedPlace(inline[1])
      // the usual places (left menu, search, pane...) hold for the clauses after; a part named by its own name holds for this clause
      if (placeOf(inline[1]).region || placeOf(inline[1]).within.length) place = np
      here = np
      if (np.within.length) lastNamed = np.within[np.within.length - 1]
    }
    text = clean(text).replace(LEAD_RE, '')
    // "…keyboard only to turn on X": the "to" only joins the verb
    text = text.replace(new RegExp(`^to\\s+(?=(?:${ALL_V.join('|')}|type|enter|press|hit)\\b)`, 'i'), '')
    // "finish by confirming the booking", "and closing the confirmation": the verb is the one after "by" / the gerund
    text = text.replace(/^(?:finish|end|start|begin)\s+(?:by|with)\s+/i, '')
    const ger = /^(\w+ing)\b/i.exec(text)
    if (ger && gerundBase(ger[1])) text = text.replace(/^\w+ing\b/i, gerundBase(ger[1]) as string)
    // "twice", "three times": the part is done that often
    let times = 1
    const rep = REPEAT.exec(text)
    if (rep) {
      times = Math.min(REPEAT_N[rep[1].toLowerCase().replace(/\s+/g, ' ')] ?? (Number(/\d+/.exec(rep[1])?.[0]) || 1), 10)
      text = text.slice(0, rep.index)
    }
    const before = item.atoms.length
    const read = readClause(text, here)
    if (read) {
      const toggling: boolean = /^(?:tick|un-?tick|check|un-?check|toggle|turn|switch|enable|disable|mark)\b/i.test(text) || (lastToggle && read.atoms.length === 1 && !CLICK_VERB.test(text))
      lastToggle = toggling
      for (let i = 0; i < times; i++) for (const a of read.atoms) emitClick(a, toggling)
      if (read.narration) item.narration = true
      if (item.atoms.length === before && !read.atoms.length && !read.narration && !read.absorbed) item.notes.push(clause)
      continue
    }
    if (item.atoms.length === before) {
      const head = (/^[\w'’-]+/.exec(text)?.[0] ?? '').toLowerCase()
      if (GOAL_RE.test(text) || EXAMPLES_RE.test(text)) item.goal = clean(`${item.goal ?? ''} ${clause}`)
      else if (NARRATE_RE.test(text)) { item.narration = true; item.notes.push(clause) }
      else if (ACTION_WORDS.has(head) || looksImperative(head)) item.unread.push(clause)
      else item.notes.push(clause)
    }
  }
  for (const option of picks) {
    const label = dd?.label ?? ''
    item.atoms.push({ action: 'select', label: label || 'dropdown', option, find: { target: label, kind: 'select', ...(ddPlace.region ? { region: ddPlace.region } : {}), ...(ddPlace.within.length ? { within: ddPlace.within } : {}) } })
  }
  // a step in which nothing was read at all is listed as not understood
  if (!item.atoms.length && !item.login && !item.explain && !item.narration && !item.unread.length && !(EXAMPLES_RE.test(said) || GOAL_RE.test(said))) item.unread.push(said)
  if (!item.goal && !item.atoms.length && (item.explain || item.narration) && (EXAMPLES_RE.test(said) || GOAL_RE.test(said.replace(/^[\s\d.):-]+/, '')))) item.goal = said
  // a goal beside clicks that were understood is a wish for the narration ("show an example of each"), not a step to plan
  if (item.goal && item.atoms.length) { item.notes.push(item.goal); item.goal = undefined }
  return item

  // ============================================================ one clause
  function readClause(text: string, place: Place): Reading | null {
    let m: RegExpExecArray | null
    const toAtoms = (...atoms: Atom[]): Reading => ({ atoms })

    // ---- "bring it back", "again": the control used just before, pressed once more
    if (/^(?:bring|put|turn|switch|click|press|show|toggle)\s+(?:it|them|that|this)\s+(?:back|again|on\s+again|on|off)\b/i.test(text) || /^(?:do|click|press)\s+it\s+again$/i.test(text)) {
      return lastClick ? toAtoms({ ...lastClick, find: { ...lastClick.find } }) : null
    }

    // ---- a door that closes what is in the way
    if ((m = /^(?:close|dismiss|hide)\s+(?:the\s+|that\s+|this\s+|it\b)?(.*)$/i.exec(text)) && !/^(?:the\s+)?(?:series|row|column|table|chart|filter|filters)\b/i.test(m[1]) && !QUOTED.test(text) && !/^(?:hide)/i.test(text)) {
      const what = cleanName(m[1].replace(/\b(?:again|please|without\s+.*)$/i, ''))
      const within = what && !GENERIC_CONTAINER.test(what) ? [what.replace(/\s+(?:window|popup|pop-up|dialog|modal)$/i, '')].filter(Boolean) : (!what || /^(?:it|that|this|them)$/i.test(what)) && lastNamed ? [lastNamed] : []
      return toAtoms({ action: 'click', label: 'close', find: { target: 'close', kind: 'click', ...(within.length ? { within } : {}), ...(place.region ? { region: place.region } : {}) } })
    }

    // ---- "move it to In progress" (a menu entry that says "Move to In progress")
    if ((m = /^move\s+(?:it|them|this|that)\s+to\s+(?:the\s+)?(.+)$/i.exec(text))) {
      const label = `move to ${cleanName(uqWhole(m[1]))}`
      return toAtoms({ action: 'click', label, find: { target: label, kind: 'click' } })
    }
    // ---- "switch the language tabs cURL"
    if ((m = /^switch\s+(?:through\s+|between\s+)?(?:the\s+)?(?:(.+?)\s+)?tabs?\s+(.+)$/i.exec(text))) {
      const label = cleanName(uqWhole(m[2]))
      return toAtoms({ action: 'click', label, find: { target: label, kind: 'click', role: 'tab', ...(m[1] ? { within: [cleanName(m[1]).toLowerCase()] } : {}) } })
    }
    // ---- "use the command palette to jump to Insights"
    if ((m = /^(?:use|open)\s+(?:the\s+)?(?:command\s+palette|command\s+menu|palette|quick\s+(?:search|switcher)|spotlight)\s+to\s+(?:jump|go|navigate|switch|open|find|search(?:\s+for)?)(?:\s+to)?\s+(?:the\s+)?(.+)$/i.exec(text))) {
      const target = cleanName(uqWhole(m[1]))
      const prevKey = item.atoms[item.atoms.length - 1]?.action === 'key'
      return toAtoms({ action: 'type', label: 'search', text: target, find: { target: 'search', kind: 'type' }, ...(prevKey ? { focused: true } : {}) } as Atom, { action: 'key', label: 'press Enter', keys: 'Enter' })
    }
    // ---- "switch the filter off again", "turn Dark mode on"
    if ((m = /^(?:turn|switch)\s+(?:the\s+)?(.+?)\s+(on|off)(?:\s+again)?$/i.exec(text))) {
      const label = cleanName(uqWhole(m[1]))
      return toAtoms({ action: 'click', label, find: { target: label, kind: 'click', ...(place.within.length ? { within: place.within } : {}) } })
    }

    // ---- keys
    const key = keyReading(text)
    if (key) return toAtoms(...key)

    // ---- wait for something to show up / scroll until it does
    if ((m = /\b(?:keep\s+)?scroll(?:ing)?\b(.*?)\buntil\s+(?:you\s+(?:see|reach|find)\s+)?(?:the\s+)?(.+?)\s*(?:appears?|is\s+visible|shows?(?:\s+up)?|is\s+(?:on\s+screen|shown|in\s+view|there)|comes?\s+into\s+view|loads?|is\s+loaded)\s*$/i.exec(text))) {
      const target = cleanName(uqWhole(m[2]))
      const via = m[1]
      const dir: 'down' | 'up' | 'left' | 'right' = /\bright\b/i.test(via) ? 'right' : /\bleft\b/i.test(via) ? 'left' : /\bup\b/i.test(via) ? 'up' : 'down'
      const row = QUOTED.exec(via)
      const area = row ? uq(row) : (/\bthe\s+(.+?)\s+(?:row|list|feed|carousel|section|panel|strip|slider)\b/i.exec(via)?.[1] ?? '')
      return toAtoms({ action: 'scrollUntil', label: `scroll ${dir} until "${target}" appears`, text: target, dir, find: { target, kind: 'scroll', ...(area ? { within: [clean(area).toLowerCase()] } : {}), ...(place.region ? { region: place.region } : {}) } } as Atom)
    }
    if ((m = /^(?:wait|hold\s+on|pause)\s+(?:until|for|till)\s+(?:the\s+)?(.+?)(?:\s+(?:to\s+)?(?:appear|load|show(?:\s+up)?|finish\s+loading|be\s+visible|come\s+(?:back|up)|render|display|update|be\s+ready|is\s+(?:there|ready|visible|loaded)))?$/i.exec(text))) {
      const target = cleanName(uqWhole(m[1]))
      return target ? toAtoms({ action: 'scrollUntil', label: `wait for "${target}"`, text: target, find: { target, kind: 'scroll' } } as Atom) : null
    }
    if (/^(?:wait|hold\s+on|pause)\b.*\b(?:seconds?|moments?|bit|while|second)\b/i.test(text)) return { atoms: [], absorbed: true }

    // ---- scroll to a named part
    const st = SCROLL_TO.exec(text)
    if (st) {
      const target = clean(unshield(st[1]).replace(Q, '').replace(/\s+(?:section|area|part|heading|block)$/i, '').replace(/\s+at\s+the\s+(?:bottom|top|end)(?:\s+of\s+the\s+page)?$/i, ''))
      if (target && !PAGE_EDGE.test(target)) {
        const dir = /\bup\b/i.test(text.slice(0, st.index + 14)) ? 'up' : 'down'
        return toAtoms({ action: 'scrollto', dir, label: cleanName(target), find: { target: cleanName(target), kind: 'scroll' } })
      }
    }
    // "go back up to the monthly consumption trend chart"
    if ((m = /^go\s+back\s+(up|down)\s+to\s+(?:the\s+)?(.+)$/i.exec(text)) || (m = /^go\s+(up|down)\s+to\s+(?:the\s+)?(.+)$/i.exec(text))) {
      const target = cleanName(m[2].replace(/\s+(?:section|area|part)$/i, ''))
      return toAtoms({ action: 'scrollto', dir: m[1].toLowerCase() as 'up' | 'down', label: target, find: { target, kind: 'scroll' } })
    }
    const hv = HOVER.exec(text)
    if (hv) {
      const q2 = QUOTED.exec(hv[1])
      const asked = q2 ? uq(q2) : clean(clean(hv[1]).replace(ARTICLE, '').replace(NOUN_TAIL, ''))
      const loc = !q2 ? /^(.+?)\s+(?:in|inside|within|on|over)\s+(?:the\s+)?([\w'’-]+(?:\s+[\w'’-]+){0,2})$/i.exec(asked) : null
      const obj = loc ? cleanName(loc[1]) : q2 ? asked : cleanName(asked)
      const within = [...place.within, ...(loc ? [loc[2].toLowerCase()] : [])]
      if (obj) return toAtoms({ action: 'hover', label: obj, find: { target: obj, kind: 'hover', ...(place.region ? { region: place.region } : {}), ...(within.length ? { within } : {}) } })
    }
    // "scroll the Customers also bought row to the right with its arrow": the arrow is pressed
    if ((m = /\bscroll\s+(?:the\s+)?(.+?)\s+(?:row|list|carousel|strip|section)?\s*to\s+the\s+(right|left)\s+(?:with|using|via|by\s+(?:pressing|clicking))\s+(?:its|the|their)\s+(?:little\s+)?arrows?/i.exec(text))) {
      const left = m[2].toLowerCase() === 'left'
      return toAtoms({ action: 'click', label: left ? 'previous' : 'next', find: { target: left ? 'previous' : 'next', kind: 'click', role: 'icon', within: [cleanName(uqWhole(m[1])).toLowerCase()] } })
    }
    const sc = SCROLL.exec(text)
    if (sc && !QUOTED.test(text)) {
      const dir = /up/i.test(sc[1] ?? sc[0]) || /\bto\s+the\s+(?:very\s+)?(?:top|start|beginning)\b/i.test(text) ? 'up' : 'down'
      return toAtoms({ action: 'scroll', dir, find: { target: 'scroll', kind: 'scroll', ...(place.region ? { region: place.region } : {}), ...(place.within.length ? { within: place.within } : {}) } })
    }

    // ---- sliders
    if (/\bslider\b/i.test(text)) {
      const lab = /(?:the\s+)?([\w'’ -]+?)\s+slider/i.exec(text.replace(/^(?:move|set|drag|slide|adjust|change|use)\s+/i, ''))
      const label = cleanName((lab?.[1] ?? 'slider').replace(/^(?:the)\s+/i, ''))
      const nums = [...text.matchAll(SLIDER_NUM)].map((x) => Number(x[1].replace(',', '.'))).filter((x) => !Number.isNaN(x))
      const range = nums.length >= 2 && /\b(?:to|and|-|–|—|between|from|through)\b/i.test(text)
      const atom: Atom = { action: 'slider', label, ...(range ? { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) } : nums.length ? { value: nums[0] } : {}), find: { target: label, kind: 'click' } }
      return toAtoms(atom)
    }

    // ---- dates
    const dp = findDatePhrase(text)
    if (dp && /^(?:choose|pick|select|go\s+(?:forward\s+|ahead\s+)?to|click|book|set|enter|move|reschedule|navigate|schedule|move\s+to|use|for|on|and)\b/i.test(text) && !QUOTED.test(text) && !/\b(?:slider|tab|filter)\b/i.test(text)) {
      const r = readDate(dp.phrase)
      if (r) {
        const cal = /\bcalendar|date\s*picker\b/i.test(text) ? ['calendar'] : []
        const atoms: Atom[] = []
        // "reschedule the overdue task to next week from its badge": the badge is pressed first
        const badge = /\bfrom\s+(?:its|the)\s+([\w' -]+?)\s*$/i.exec(text)
        if (/^reschedule\b/i.test(text) && badge) {
          const held = /^reschedule\s+(?:the\s+|that\s+|this\s+)?([\w'-]+)\s+(?:task|card|item|ticket|booking|one)\b/i.exec(text)
          const badgeLabel = cleanName(`${held && !/^(?:the|that|this|it)$/i.test(held[1]) ? `${held[1]} ` : ''}${badge[1]}`)
          atoms.push({ action: 'click', label: badgeLabel, find: { target: badgeLabel, kind: 'click' } })
        }
        atoms.push({ action: 'date', label: dp.phrase, date: r.date, phrase: r.phrase, ...(r.rule ? { rule: r.rule } : {}), find: { target: dp.phrase, kind: 'click', ...(cal.length ? { within: cal } : {}) } })
        if (r.rule) item.notes.push(`Date rule used: ${dp.phrase}: ${r.rule}`)
        return toAtoms(...atoms)
      }
    }
    if (/^(?:pick|choose|select|click)\s+(?:it|that|this)$/i.test(text) && item.atoms[item.atoms.length - 1]?.action === 'date') return { atoms: [], absorbed: true }

    // ---- double-click and inline edit
    if ((m = /^(?:double[- ]?click|dbl[- ]?click|double[- ]?tap)\s+(?:on\s+)?(.+)$/i.exec(text))) {
      const label = uqWhole(m[1])
      return toAtoms({ action: 'dblclick', label: cleanName(label), find: { target: cleanName(label), kind: 'click', ...(place.within.length ? { within: place.within } : {}) } })
    }
    if ((m = /^rename\s+(.+?)\s+(?:to|as|into)\s+(.+)$/i.exec(text))) {
      const obj = cleanName(uqWhole(m[1]).replace(/^(?:the\s+)?(?:card|task|item|title|heading|column|row|entry)\s+/i, ''))
      const val = uqWhole(m[2].replace(/\s+(?:right\s+)?(?:on\s+the\s+\w+|in\s+place|inline|directly|by\s+editing.*)$/i, ''))
      const target = obj && !GENERIC_CONTAINER.test(obj) ? obj : ''
      const atoms: Atom[] = []
      if (target) atoms.push({ action: 'dblclick', label: target, find: { target, kind: 'click' } })
      atoms.push({ action: 'type', label: target || 'the edited text', text: val, replace: true, find: { target: target || 'edit', kind: 'type' } })
      return toAtoms(...atoms)
    }

    // ---- drag and drop
    if ((m = /^drop\s+(?:it|them|that|this)\s+(above|over|before|below|under|beneath|after|on\s+top\s+of|at\s+the\s+(top|bottom))\b\s*(?:of\s+)?(?:the\s+)?(.*?)(?:\s+(?:there|in\s+it|in\s+that\s+column))?$/i.exec(text))) {
      const last = item.atoms[item.atoms.length - 1]
      if (last?.action === 'drag') {
        const w = m[1].toLowerCase()
        last.position = m[2] ? (m[2].toLowerCase() as 'top' | 'bottom') : /above|over|before|on\s+top/.test(w) ? 'before' : 'after'
        if (m[3] && !m[2]) last.ref = clean(m[3])
        return { atoms: [], absorbed: true }
      }
    }
    if ((m = /^(?:drag(?:\s+and\s+drop)?|move)\s+(.+?)\s+(?:into|to|onto|on\s+to|over\s+to)\s+(.+)$/i.exec(text)) && (/^drag/i.test(text) || QUOTED.test(m[1]) || /\bcard|task|item\b/i.test(m[1]))) {
      const from = cleanName(uqWhole(m[1]).replace(/^(?:the\s+)?(?:card|task|item|ticket)\s+/i, ''))
      let dest = clean(m[2])
      let position: 'top' | 'bottom' | 'before' | 'after' | undefined
      let ref: string | undefined
      const edge = /^(?:the\s+)?(top|bottom)\s+of\s+(?:the\s+)?(.+)$/i.exec(dest)
      if (edge) { position = edge[1].toLowerCase() as 'top' | 'bottom'; dest = edge[2] }
      const rel = /^(.+?)\s+(?:and\s+)?(?:drop\s+(?:it|them)\s+)?(above|before|below|after|under)\s+(?:the\s+)?(.+?)(?:\s+there)?$/i.exec(dest)
      if (rel) { dest = rel[1]; position = /above|before/i.test(rel[2]) ? 'before' : 'after'; ref = clean(rel[3]) }
      const to = cleanName(uqWhole(dest).replace(/\s+(?:column|list|lane|bucket|section|board|area)$/i, ''))
      return toAtoms({ action: 'drag', label: `drag "${from}" to "${to}"`, from, to, ...(position ? { position } : {}), ...(ref ? { ref } : {}), find: { target: from, kind: 'click' } })
    }

    // ---- typing
    const typed = typingReading(text, place)
    if (typed) return typed

    // ---- sorting
    if ((m = /^sort\b(.*)$/i.exec(text))) {
      const order = /(?:from\s+)?(high(?:est)?\s+to\s+low(?:est)?|low(?:est)?\s+to\s+high(?:est)?|ascending|descending|a\s*(?:-|to)\s*z|z\s*(?:-|to)\s*a|newest(?:\s+first)?|oldest(?:\s+first)?|cheapest(?:\s+first)?|most\s+expensive(?:\s+first)?|biggest\s+first)/i.exec(m[1])
      const by = /\bby\s+(?:the\s+)?([\w' -]+?)(?:\s+column)?(?:\s+(?:from|so|in|with|,)|\s*$)/i.exec(m[1])
      if (order) {
        const option = clean(`${by ? `${cleanName(by[1])} ` : ''}${order[1].replace(/\s+first$/i, '')}`)
        return toAtoms({ action: 'select', label: 'sort', option, find: { target: 'sort', kind: 'select' } })
      }
      if (by) return toAtoms({ action: 'click', label: cleanName(by[1]), find: { target: cleanName(by[1]), kind: 'click', ...(/column|table/i.test(m[1]) ? { within: ['table'] } : {}) } })
    }

    // ---- reaching something by position, order or value
    const pick = pickReading(text, place)
    if (pick) return toAtoms(pick)

    // ---- buttons, links, tabs, boxes
    const cv = CLICK_VERB.exec(text)
    if (cv) {
      const verb = cv[1].replace(/\s+/g, ' ').toLowerCase()
      let obj = clean(cv[2] ?? '')
      // "the Notes tab using the keyboard arrow keys": by arrows (handled in keyReading when it sees them)
      obj = obj.replace(/\s+(?:with|using|via)\s+the\s+(?:little\s+)?(?:mouse|cursor|pointer)\s*$/i, '')
      // "add it to the cart", "add to wishlist"
      if (/^(?:add|remove|put)$/.test(verb) && (m = /^(?:(?:it|them|this|that|one|the\s+\w+(?:\s+\w+){0,3}?)\s+)?(?:to|from|in|into)\s+(?:the\s+|my\s+|your\s+)?(cart|basket|bag|wishlist|wish\s?list|favou?rites|trolley|list)$/i.exec(obj))) {
        const dest = m[1].toLowerCase().replace(/\s+/g, ' ')
        const label = `${verb === 'remove' ? 'remove from' : 'add to'} ${dest}`
        return toAtoms({ action: 'click', label, find: { target: label, kind: 'click', ...(place.within.length ? { within: place.within } : {}) } })
      }
      // "increase the quantity to 2", "add one more jacket"
      if ((/^(?:increase|decrease)$/.test(verb) && /\b(?:quantity|amount|count|number|qty)\b/i.test(obj)) || (verb === 'add' && /^one\s+more\b/i.test(obj))) {
        const dec = verb === 'decrease'
        const where = /\b(?:in|inside|on)\s+(?:the\s+)?([\w' -]+?)$/i.exec(obj)
        const within = [...place.within, ...(where ? [where[1].toLowerCase()] : [])]
        const label = `${dec ? 'decrease' : 'increase'} quantity`
        return toAtoms({ action: 'click', label, find: { target: label, kind: 'click', ...(within.length ? { within } : {}) } })
      }
      // "switch the filter off again", "turn Dark mode on"
      if ((m = /^(?:the\s+)?(.+?)\s+(on|off)(?:\s+again)?$/i.exec(obj)) && /^(?:turn|switch)$/.test(verb)) obj = m[1]
      // "mark X as a favourite with the heart icon": the icon is pressed, in the thing named
      // "flip through the photos with the arrows"
      const arrows = /^(.*?)\s*\b(?:with|using|via)\s+(?:the\s+|its\s+)?(?:little\s+)?arrows?\s*$/i.exec(obj)
      if (arrows) {
        const holder = cleanName(arrows[1].replace(/^through\s+/i, '')).toLowerCase()
        return toAtoms({ action: 'click', label: 'next', find: { target: 'next', kind: 'click', role: 'icon', ...(holder ? { within: [holder] } : {}) } })
      }
      const ic = /^(.*?)\s*\b(?:with|using|via|by\s+(?:clicking|pressing)|through)\s+(?:the\s+|its\s+)?(?:little\s+|small\s+)?([\w'’-]+(?:\s+[\w'’-]+)?)\s+(icon|button|arrow|arrows)\s*$/i.exec(obj)
      if (ic && !QUOTED.test(ic[2])) {
        const iconName = cleanName(ic[2])
        const holder = clean(ic[1].replace(/\s+as\s+(?:a|an|the|my)\s+.*$/i, '').replace(/\s+(?:to|in|into)\s+(?:the\s+|my\s+)?(?:wishlist|favou?rites|cart|basket)$/i, ''))
        if (ORD_RE_ANY.test(holder)) {
          return toAtoms({ action: 'pick', label: `${iconName} ${ic[3].toLowerCase().replace(/s$/, '')}`, within: cleanName(holder).replace(/^(?:the\s+)/i, ''), verb: 'click', find: { target: iconName, kind: 'click', role: 'icon' } })
        }
        const target = clean(`${cleanName(holder)} ${iconName}`.replace(/^\s*(?:open|show)\s+/i, ''))
        return toAtoms({ action: 'click', label: iconName, find: { target: target || iconName, kind: 'click', role: 'icon', ...(place.within.length ? { within: place.within } : {}) } })
      }
      // "using the legend", "from the sidebar" on the end
      let within = [...place.within]
      const useWhere = /^(.*?)\s+(?:using|via|from|through)\s+the\s+(legend|menu|sidebar|toolbar|header|footer|filters?|nav(?:igation)?)$/i.exec(obj)
      if (useWhere) { obj = clean(useWhere[1]); within = [...within, useWhere[2].toLowerCase()] }
      // "the heart on ...", "size XL": a kind of choice named in front
      const sizeOf = /^(?:the\s+)?size\s+(.+)$/i.exec(obj)
      if (sizeOf) { obj = sizeOf[1]; within = [...within, 'size'] }
      const colourOf = /^(?:the\s+)?([a-z]+)\s+colou?r$/i.exec(obj)
      if (colourOf) obj = colourOf[1]
      if (!obj && !/^(?:continue|proceed|log\s?out|sign\s?out|run|save|submit|close|dismiss|confirm|finish|cancel|reset|refresh|reload|start|stop|play|pause|skip|checkout|go\s+back|accept|reject|decline|undo|redo|send|apply|clear|download|upload|share|book|buy|order|pay|delete)$/.test(verb)) return null
      // a verb that is part of the control's own name: "confirm the booking" presses "Confirm booking"
      const asLabel = joinsLabel(verb) && !/^(?:it|them|this|that)$/i.test(obj)
      const pronoun = /^(?:it|them|this|that)$/i.test(obj)
      const vlabel = verb.replace(/^go\s+back$/, 'back').replace(/\s+/g, ' ')
      if (pronoun && !joinsLabel(verb) && !/^(?:close|dismiss|go\s+back)$/.test(verb)) return null
      if (!obj || pronoun) {
        return toAtoms({ action: 'click', label: vlabel, find: { target: vlabel, kind: 'click', ...(place.region ? { region: place.region } : {}), ...(within.length ? { within } : {}) } })
      }
      const atom = clickAtom(asLabel && !QUOTED.test(obj) ? `${vlabel} ${cleanName(obj)}` : obj, { region: place.region, within })
      if (atom) return toAtoms(atom)
      return null
    }

    // ---- "to Sources" (after a key move), "next friday" etc. are read with what came before
    if ((m = /^to\s+(?:the\s+)?(.+)$/i.exec(text))) {
      const last = item.atoms[item.atoms.length - 1]
      if (last?.action === 'key' && /Arrow/.test(last.keys)) {
        const target = cleanName(uqWhole(m[1]))
        return toAtoms({ action: 'key', label: `${last.keys} until ${target} is focused`, keys: last.keys.split(' ')[0], repeatUntil: target })
      }
      if (last?.action === 'click') {
        const atom = clickAtom(m[1], place)
        if (atom) return toAtoms(atom)
      }
    }

    // ---- a choice said as a statement: "the mens cut is fine", "any time in the morning is ok"
    if (/\b(?:is|are|will\s+do|works?|would\s+be)\s+(?:fine|ok|okay|good|great|perfect|best|right|enough|alright)\b/i.test(text) || /^any\s+\w+\s+in\s+the\s+(?:morning|afternoon|evening)/i.test(text)) {
      const stripped = text.replace(/\s+(?:is|are|will\s+do|works?|would\s+be)\s+(?:fine|ok|okay|good|great|perfect|best|right|enough|alright)\b.*$/i, '')
      const anyIn = /^any\s+(.+?)\s+in\s+the\s+(morning|afternoon|evening)\b/i.exec(stripped)
      if (anyIn) return toAtoms({ action: 'pick', label: cleanName(anyIn[1]), ordinal: 1, within: anyIn[2].toLowerCase(), verb: 'click', find: { target: cleanName(anyIn[1]), kind: 'click', within: [anyIn[2].toLowerCase()] } })
      const atom = clickAtom(stripped, place)
      if (atom) return toAtoms(atom)
    }

    // ---- a name with no verb that follows a choice ("choose the haircut and then the kids' cut", "turn on A and B", "Mei as the stylist")
    const prev = item.atoms[item.atoms.length - 1]
    if ((prev?.action === 'click' || prev?.action === 'pick' || prev?.action === 'key') && !times1(text) && looksLikeName(text)) {
      const atom = clickAtom(text, place)
      if (atom && atom.action === 'click') return toAtoms(prev.action === 'key' && !kb ? atom : atom)
    }
    // a quoted name with no verb: the person pointed at it
    const q = QUOTED.exec(text)
    if (q && !TYPE_VERB.test(text)) {
      const atom = clickAtom(text, place)
      if (atom) return toAtoms(atom)
    }
    return null
  }

  function times1(_t: string): boolean {
    return false
  }
  function looksLikeName(t: string): boolean {
    const words = t.replace(/\s+as\s+(?:the|a|an|my)\s+.*$/i, '').split(/\s+/).filter(Boolean)
    if (!words.length || words.length > 5) return false
    if (/^(?:so|because|which|that|this|then|to|if|when|but|or|who|where|how|what|why)\b/i.test(t)) return false
    if (EXPLAIN.test(t) || NARRATE_RE.test(t) || TONE_WORDS.test(t)) return false
    // "flibber the zorp": a lowercase word that looks like a verb, then its object, is an instruction nobody could read, not another name
    if (words.length >= 2 && /^[a-z]/.test(words[0]) && looksImperative(words[0].toLowerCase()) && !/^(?:the|a|an|my|our|your|his|her|its)$/i.test(words[0]) && !/\bas\s+(?:the|a|an|my)\b/i.test(t)) return false
    if (ACTION_WORDS.has(words[0].toLowerCase()) && !/^(?:the|a|an)$/i.test(words[0])) return false
    return true
  }

  /** "press Ctrl+K", "hit Escape", "press tab until the continue button is focused", "use the arrow keys" */
  function keyReading(text: string): Atom[] | null {
    let m: RegExpExecArray | null
    const until = FOCUS_UNTIL.exec(text)
    const head = /^(?:press(?:ing)?|hit|tap|strike|push|use|type|keep\s+pressing)\s+(?:the\s+)?([\w +/-]*?)(?:\s+key)?(?:\s+again)?(?:\s+(?:to|so|and)\b.*)?$/i
    // "press Tab until the continue button is focused", "Tab until ... is focused"
    if (until) {
      const kw = /^(?:(?:press|hit|tap|keep\s+pressing)\s+(?:the\s+)?)?(tab|shift\s*\+\s*tab|down|up|left|right|(?:up|down|left|right)\s+arrow|arrow\s+(?:up|down|left|right))\b/i.exec(text)
      if (kw) {
        const k = kw[1].toLowerCase().replace(/\s+/g, ' ')
        const keys = /shift/.test(k) ? 'Shift+Tab' : (KEY_NAMES[k] ?? 'Tab')
        const target = cleanName(until[1])
        return [{ action: 'key', label: `${keys} until "${target}" is focused`, keys, repeatUntil: target }]
      }
    }
    const chord = CHORD.exec(text)
    if (chord && /\b(?:press|hit|tap|use|type|open|with)\b|^ctrl|^cmd|^alt|^shift/i.test(text)) {
      const keys = chordOf(chord[1])
      const again = /\bagain\b/i.test(text)
      return [{ action: 'key', label: `press ${chord[1]}${again ? ' again' : ''}`, keys }]
    }
    // "move to the Notes tab using the keyboard arrow keys", "pick Rate limits using the arrow keys"
    if (ARROWS.test(text)) {
      const body = text.replace(ARROWS, ' ')
      const mv = /^(?:move|go|switch|navigate|jump|pick|choose|select|click|tab|step)\s+(?:to|through|across|between)?\s*(?:the\s+)?(.*)$/i.exec(clean(body))
      const tail = clean(mv ? mv[1] : body)
      const across = /^(?:across|through|between)\b/i.test(clean(body).replace(/^(?:move|go|switch|navigate|step)\s+/i, '')) || /\b(?:across|through|between)\b/i.test(body)
      const horizontal = /\btabs?\b/i.test(text) || /\bleft|right\b/i.test(text)
      const arrow = horizontal ? 'ArrowRight' : 'ArrowDown'
      if (across || !tail || /^(?:the\s+)?(?:\w+\s+){0,2}(?:tabs|list|options|items|suggestions)$/i.test(tail) && across) {
        const over = cleanName(tail.replace(/^(?:(?:to\s+)?(?:move|go|switch|navigate|step)\s+)?(?:across|through|between)\s+(?:the\s+)?/i, '')) || 'items'
        return [{ action: 'key', label: `use the arrow keys across the ${over}`, keys: `${arrow} ${arrow} ${arrow}` }]
      }
      const target = cleanName(uqWhole(tail))
      return [{ action: 'key', label: `${arrow} until "${target}" is focused`, keys: arrow, repeatUntil: target }]
    }
    if ((m = head.exec(text))) {
      const name = clean(m[1]).toLowerCase().replace(/^the\s+/, '')
      if (KEY_NAMES[name]) return [{ action: 'key', label: `press ${m[1]}`, keys: KEY_NAMES[name] }]
      if (/^(?:the\s+)?arrow\s+keys?$/.test(name)) return [{ action: 'key', label: 'press the arrow keys', keys: 'ArrowDown ArrowDown ArrowDown' }]
    }
    // a bare key name after "and": "…and enter", "then escape"
    const last = item.atoms[item.atoms.length - 1]
    if (last?.action === 'key' || last?.action === 'type') {
      const name = text.toLowerCase().replace(/^the\s+/, '').replace(/\s+key$/, '')
      if (['enter', 'return', 'escape', 'esc', 'tab'].includes(name)) return [{ action: 'key', label: `press ${name}`, keys: KEY_NAMES[name] }]
    }
    return null
  }

  /** typing: quoted text, a value said plainly, "set X to Y", "search for X", fields said in a list */
  function typingReading(text: string, place: Place): Reading | null {
    let m: RegExpExecArray | null
    const prev = item.atoms[item.atoms.length - 1]
    // "select everything and replace it with `{...}`" / "replace it with ..."
    if ((m = /^replace\s+(?:it|everything|all|the\s+(?:text|content|code|body)|that|this)\s+with\s+(.+)$/i.exec(text)) || (m = /^overwrite\s+(?:it\s+)?with\s+(.+)$/i.exec(text))) {
      // the "select everything" before it is what `replace` does
      if (prev?.action === 'key' && prev.keys === 'Control+A') item.atoms.pop()
      const before = item.atoms[item.atoms.length - 1]
      const label = lastClick?.label ?? (before && 'label' in before && before.action !== 'key' ? (before as { label: string }).label : 'text box')
      return { atoms: [{ action: 'type', label, text: uqWhole(m[1]), replace: true, find: { target: label, kind: 'type', ...(place.region ? { region: place.region } : {}) } }] }
    }
    if (/^select\s+(?:everything|all)$/i.test(text) && !/\b(?:then|and)\b/i.test(text)) return { atoms: [{ action: 'key', label: 'select all', keys: 'Control+A' }] }
    // "change `plan` to `team`", "set the Plan to team", "change X to Y"
    if ((m = /^(?:set|change|update|edit|switch)\s+(?:the\s+)?(.+?)\s+(?:to|with|into|=)\s+(.+)$/i.exec(text)) && !/^(?:to\b)/i.test(m[1]) && !/^(?:switch)$/.test(text)) {
      const label = cleanName(uqWhole(m[1]))
      const value = uqWhole(m[2])
      if (label && value && !/^(?:the\s+)?(?:next|previous|first|last)\b/i.test(label) && !/\bslider\b/i.test(label)) {
        const where = place.within.filter((w) => w !== 'search')
        return { atoms: [{ action: 'type', label, text: value, replace: true, find: { target: label, kind: 'type', ...(place.region ? { region: place.region } : {}), ...(where.length ? { within: where } : {}) } }] }
      }
    }
    // "fill in the name field with Mei"
    if ((m = /^(?:fill(?:\s+in|\s+out)?|type|enter|put|write)\s+(?:in\s+)?(?:the\s+|your\s+|my\s+)?(.+?)\s+(?:field|box|input)?\s*(?:with|as)\s+(.+)$/i.exec(text)) && !/\u0001/.test(text)) {
      return { atoms: [{ action: 'type', label: cleanName(m[1]), text: uqWhole(m[2]), find: { target: cleanName(m[1]), kind: 'type' } }] }
    }
    const tv = TYPE_VERB.exec(text)
    const bareSearch = /^search\s+(?!for\b|bar\b|box\b|field\b|section\b|area\b|input\b|results?\b|page\b)(.+)$/i.exec(text)
    const q = QUOTED.exec(text)
    if (tv && q && q.index > tv.index) {
      const after = text.slice(q.index + q[0].length)
      const into = /^\s*(?:in|into|in\s+to|on|inside|within|to|at)\s+(?:the\s+)?(.+)$/i.exec(after)
      const p = into ? placeOf(into[1]) : place
      const between = clean(text.slice(tv.index + tv[0].length, q.index))
      const colon = between.includes(':') ? between.slice(between.lastIndexOf(':') + 1) : between
      const preLabel = cleanName(colon.replace(/^(?:in|into|the|a|an|your|my|some|text|something)\s+/i, '').replace(/\b(?:in|into|the|a|an|your|my)$/i, ''))
      const boxWords = into ? clean(into[1]) : ''
      const searchy = place.within.includes('search') || /search/i.test(text.slice(0, tv.index + tv[0].length))
      const label = cleanName(boxWords.replace(/\b(?:box|field|input)\b$/i, '')) || (/^(?:name|email|address|phone|card|expiry|cvc|cvv|date|password|username|message|comment|company|city|zip|postcode|code|number)\b/i.test(preLabel) || (preLabel && !/^(?:in|into|the|a|an|your|my)$/i.test(preLabel) && !searchy) ? preLabel : '') || (prev?.action === 'key' ? 'search' : 'search')
      return {
        atoms: [{ action: 'type', label, text: uq(q), find: { target: label, kind: 'type', ...(p.region ? { region: p.region } : place.region ? { region: place.region } : {}), ...(p.within.length || place.within.length ? { within: [...new Set([...p.within, ...place.within])] } : {}) }, ...(prev?.action === 'key' ? { focused: true } : {}) } as Atom]
      }
    }
    // "email `grace@example.com`", "CVC `123`" after a typing clause: the next field of the same list
    if ((m = new RegExp(`^(?:and\\s+)?([\\w'’ -]{1,30}?)\\s*[:=]?\\s*\\u0001\\d+\\u0001$`).exec(text.replace(QUOTED_G, (x) => `\u0001${shield.push(x) - 1}\u0001`))) && prev?.action === 'type') {
      const label = cleanName(m[1])
      const qq = QUOTED.exec(text)
      if (label && qq) return { atoms: [{ action: 'type', label, text: uq(qq), find: { target: label, kind: 'type' } }] }
    }
    // "`123` in the CVC box" after a typing clause
    if ((m = /^(?:and\s+)?(.+?)\s+(?:in|into|on)\s+(?:the\s+)?(.+?)\s*(?:box|field|input)?$/i.exec(text)) && QUOTED.test(m[1]) && prev?.action === 'type' && !tv) {
      const qq = QUOTED.exec(m[1])
      const label = cleanName(m[2].replace(/\b(?:box|field|input)$/i, ''))
      if (qq && label) return { atoms: [{ action: 'type', label, text: uq(qq), find: { target: label, kind: 'type' } }] }
    }
    // a value said plainly: "put in phone number 07700 900123", "enter your email grace@example.com"
    if (tv && (m = /(\+?\d[\d ()-]{5,}\d|[\w.+-]+@[\w-]+\.[\w.-]+)\s*$/.exec(text)) && m.index > tv.index) {
      const label = cleanName(text.slice(tv.index + tv[0].length, m.index).replace(/^(?:in|into)\s+/i, '').replace(/\b(?:the|your|my|a|an)\b\s*/gi, ''))
      return { atoms: [{ action: 'type', label: label || 'search', text: clean(m[1]), find: { target: label || 'search', kind: 'type' } }] }
    }
    // "search for rate limits", "search webhook"
    if (tv && /search\s+for/i.test(tv[0]) && !q) {
      const t = clean(text.slice(tv.index + tv[0].length)).replace(ARTICLE, '')
      if (t) return { atoms: [{ action: 'type', label: 'search', text: t, find: { target: 'search', kind: 'type' } }] }
    }
    if (bareSearch) {
      const t = uqWhole(bareSearch[1]).replace(ARTICLE, '')
      if (t) return { atoms: [{ action: 'type', label: 'search', text: t, find: { target: 'search', kind: 'type' } }] }
    }
    // "writing a valid body with the email X and the plan Y"
    if ((m = /\b(?:writ(?:e|ing)|enter(?:ing)?|typ(?:e|ing)|fill(?:ing)?(?:\s+in)?)\s+(?:a\s+|the\s+)?(?:valid\s+)?(body|request|json|payload)\s+with\s+(.+)$/i.exec(text))) {
      const pairs: Record<string, string> = {}
      for (const x of m[2].matchAll(/(?:the\s+)?([a-z][\w-]*)\s+([^\s,]+)(?=\s+and\s+|\s*,|\s*$)/gi)) pairs[x[1].toLowerCase()] = x[2].replace(/^["'`]|["'`]$/g, '')
      if (Object.keys(pairs).length) return { atoms: [{ action: 'type', label: `request ${m[1].toLowerCase() === 'body' ? 'body' : m[1].toLowerCase()}`, text: JSON.stringify(pairs), replace: true, find: { target: 'request body', kind: 'type' } }] }
    }
    return null
  }

  /** "the second card in the third column", "the cheapest jacket", "the row with the highest total", "the button under the chart" */
  function pickReading(text: string, place: Place): Atom | null {
    let m: RegExpExecArray | null
    const cv = CLICK_VERB.exec(text)
    const hvm = HOVER.exec(text)
    const verbWord = (cv?.[1] ?? '').toLowerCase()
    let obj = hvm ? clean(hvm[1]) : cv ? clean(cv[2] ?? '') : ''
    if (!obj || QUOTED.test(obj) || ICON_WITH.test(obj)) return null
    // "open the menu of the second card in the third column" → the menu of that card
    const menuOf = /^(?:the\s+)?(menu|actions?|options|more|three\s+dots|kebab|ellipsis)\s+(?:of|on|for)\s+(?:the\s+)?(.+)$/i.exec(obj)
    const verb: 'click' | 'hover' = hvm ? 'hover' : 'click'
    const mk = (p: Omit<Extract<Atom, { action: 'pick' }>, 'action' | 'find' | 'verb'> & { target?: string; rel?: FindSpec['relation']; role?: FindSpec['role']; colours?: string[] }): Atom => {
      const { target, rel, role, colours, ...rest } = p
      const t = target ?? rest.label
      const within = [...place.within, ...(rest.within ? [rest.within.toLowerCase()] : [])]
      return { action: 'pick', verb, ...rest, find: { target: t, kind: verb === 'hover' ? 'hover' : 'click', ...(within.length ? { within } : {}), ...(rel ? { relation: rel } : {}), ...(role ? { role } : {}), ...(colours ? { colours } : {}), ...(place.region ? { region: place.region } : {}) } }
    }
    if (menuOf) {
      const holder = pickParts(menuOf[2])
      if (holder) return mk({ label: `${holder.noun} menu`, ...(holder.ordinal !== undefined ? { ordinal: holder.ordinal } : {}), ...(holder.column !== undefined ? { column: holder.column } : {}), ...(holder.within ? { within: holder.within } : {}), role: 'icon' })
    }
    // "the row with the highest total"
    if ((m = new RegExp(`^(?:the\\s+)?([\\w' -]+?)\\s+(?:with|that\\s+has|having|which\\s+has)\\s+(?:the\\s+)?(${CRIT_WORD})\\s+([\\w' -]+?)\\s*$`, 'i').exec(obj))) {
      return mk({ label: cleanName(m[1]), criterion: CRITERIA[m[2].toLowerCase().replace(/\s+/g, ' ')], field: cleanName(m[3]) })
    }
    // "the cheapest jacket", "the tallest bar"
    if ((m = new RegExp(`^(?:the\\s+)?(${CRIT_WORD})\\s+(.+?)(?:\\s+(?:in|on|from|of|inside)\\s+(?:the\\s+)?(.+))?$`, 'i').exec(obj))) {
      return mk({ label: cleanName(m[2]), criterion: CRITERIA[m[1].toLowerCase().replace(/\s+/g, ' ')], ...(m[3] ? { within: clean(m[3]) } : {}) })
    }
    // "the button under the chart that goes to the next region"
    if ((m = /^(?:the\s+)?(button|link|icon|arrow|tab|card|field|box|input|menu|item|control)\s+(under|below|above|beneath|beside|next\s+to|near|to\s+the\s+(?:left|right)\s+of)\s+(?:the\s+)?(.+?)(?:\s+(?:that|which)\s+(?:goes?|leads?|opens?|moves?|jumps?|takes?(?:\s+you)?)\s+(?:to\s+)?(?:the\s+)?(.+))?$/i.exec(obj))) {
      const rel = REL_MAP[m[2].toLowerCase().replace(/^to the\s+/, '').replace(/\s+/g, ' ')] ?? 'near'
      const label = m[4] ? cleanName(m[4]) : m[1].toLowerCase()
      return mk({ label, rel: { rel, to: cleanName(m[3]) } })
    }
    // "the second card in the third column", "the first product in the list", "the second afternoon time"
    const parts = pickParts(obj)
    if (parts) {
      return mk({ label: parts.noun, ...(parts.ordinal !== undefined ? { ordinal: parts.ordinal } : {}), ...(parts.column !== undefined ? { column: parts.column } : {}), ...(parts.within ? { within: parts.within } : {}) })
    }
    void verbWord
    return null
  }

  function pickParts(obj: string): { noun: string; ordinal?: number; column?: number | string; within?: string } | null {
    const m = new RegExp(`^(?:the\\s+)?(${ORD_WORD})\\s+(?:one\\s+of\\s+the\\s+)?(.+?)(?:\\s+(?:in|on|of|from|under|within|inside)\\s+(?:the\\s+)?(.+))?$`, 'i').exec(clean(obj))
    if (!m) return null
    const ordinal = ordinalOf(m[1])
    let noun = cleanName(m[2])
    let within = m[3] ? cleanName(m[3]) : undefined
    let column: number | string | undefined
    const col = within ? new RegExp(`^(${ORD_WORD})\\s+column$`, 'i').exec(within) : null
    if (col) { column = ordinalOf(col[1]); within = undefined }
    const colNamed = within ? /^(.+?)\s+column$/i.exec(within) : null
    if (colNamed) { column = cleanName(colNamed[1]); within = undefined }
    const tod = /^(morning|afternoon|evening|night)\s+(.+)$/i.exec(noun)
    if (tod) { within = tod[1].toLowerCase(); noun = cleanName(tod[2]) }
    return { noun, ...(ordinal !== undefined ? { ordinal } : {}), ...(column !== undefined ? { column } : {}), ...(within ? { within } : {}) }
  }

  /** a word or phrase, with its quotes taken off */
  function uqWhole(s: string): string {
    const q = QUOTED.exec(s)
    return q ? uq(q) : clean(s)
  }
}
const ORD_RE_ANY = new RegExp(`\\b${ORD_WORD}\\b|\\bin\\s+the\\s+list\\b`, 'i')

/** "a, b and c" → clauses; a number range ("£40 to £80", "between 40 and 80") is not cut at its "and" */
function splitClauses(doing: string): string[] {
  const hold: string[] = []
  const guard = doing.replace(/(?:between\s+)?[£$€]?\d[\d.,]*\s*(?:and|to|-|–|—)\s*[£$€]?\d[\d.,]*/gi, (m) => `\u0003${hold.push(m) - 1}\u0003`)
  const parts = guard
    .split(/,\s*(?:and\s+|then\s+)?|\s+and\s+|\s+then\s+|\bthen\b|;\s*/i)
    .map((c) => clean(c.replace(/\u0003(\d+)\u0003/g, (_, i: string) => hold[Number(i)])))
    .filter(Boolean)
  const out: string[] = []
  for (const c of parts) {
    const prev = out[out.length - 1]
    // ", twice" belongs to the clause before it; "Yes, helpful" is one button
    if (prev && /^(?:once|twice|thrice|two\s+times|three\s+times|four\s+times|five\s+times|\d{1,2}\s+times)$/i.test(c)) out[out.length - 1] = `${prev} ${c}`
    else if (prev && /\b(?:yes|no|ok|okay)$/i.test(prev) && /^(?:helpful|not\s+helpful|thanks?|thank\s+you|please|not\s+now|maybe\s+later|later|sure|great|got\s+it|continue)\b/i.test(c)) out[out.length - 1] = `${prev}, ${c}`
    else out.push(c)
  }
  return out
}

const wheneverOf = (items: ScriptItem[]): Whenever[] => items.flatMap((i) => i.atoms.filter((a): a is Whenever => a.action === 'whenever'))

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
    if (m) {
      const it = parseLine(++n, clean(m[2]))
      if (m[1]) it.written = Number(m[1])
      items.push(it)
    }
    else if (line.trim()) {
      // a wrapped line belongs to the step above it
      if (items.length && /^\s{2,}\S/.test(line)) {
        const last = items[items.length - 1]
        const merged = parseLine(last.n, `${last.said} ${clean(line)}`)
        merged.written = last.written
        items[items.length - 1] = merged
      } else rest.push(line.trim())
    }
  }
  // a list where nothing was understood and nothing is a goal is not a script (the brief is read some other way)
  if (!items.some((i) => i.atoms.length || i.explain || i.goal || i.login)) return null
  return { items, goal: rest.join(' '), source: 'list', tone: [], whenever: wheneverOf(items) }
}

// ---------------------------------------------------------------- prose

/** words that start a step in a story told in prose: "first sign in, then press book now. after that pick a haircut" */
const CHAIN = /\s*(?:[,;]\s*)?\b(?:and\s+then|and\s+after\s+that|after\s+that|afterwards|then|next(?=\s*,)|finally|lastly|once\s+(?:that(?:'s|\s+is)\s+done|you(?:'ve|\s+have)\s+done\s+that))\b[,\s]*/i

/**
 * A brief written as plain sentences ("first sign in with the test account, then press book now. pick a haircut ...") is read as
 * a script too, when at least two of its sentences are steps. A sentence that asks for no action (voice, tone, who the viewers
 * are, "keep it simple") is not a step and not an unplaced instruction: it goes to `tone`.
 */
export function parseProseScript(context: string): StepScript | null {
  const typed = (context.split(/\n\s*Attached notes \(information only\):/)[0] ?? '').replace(/\r/g, '')
  // a list is a list
  if (typed.split('\n').filter((l) => BULLET.test(l)).length >= 2) return null
  // a paragraph or a line is a boundary, and so is a full stop
  const sentences = typed
    .replace(/^\s*#+\s.*$/gm, ' ') // headings
    .split(/\n+/)
    .flatMap((para) => para.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Za-z0-9`"“'‘])/))
    .map(clean)
    .filter(Boolean)
  if (!sentences.length) return null
  const items: ScriptItem[] = []
  const tone: string[] = []
  const context2: string[] = []
  let n = 0
  for (const sentence of sentences) {
    // one sentence can hold a chain of steps ("first X, then Y")
    const pieces = splitChain(sentence)
    let any = false
    const made: ScriptItem[] = []
    for (const piece of pieces) {
      const it = parseLine(n + made.length + 1, piece)
      const concrete = it.atoms.length > 0 || it.login
      if (concrete && !stepIsTone(piece)) { made.push(it); any = true }
    }
    if (any) {
      for (const it of made) { it.n = ++n; items.push(it) }
    } else if (TONE_WORDS.test(sentence) && !/\b(?:click|press|open|book|sign|log|pick|choose|type|enter|select|tick)\b/i.test(sentence)) tone.push(sentence)
    else context2.push(sentence)
  }
  const steps = items.filter((i) => i.atoms.length)
  // at least two sentences that do something (a lone "click reports" in a story is read by the brief reader as before)
  if (steps.length + (items.some((i) => i.login) ? 0 : 0) < 2 && !(items.some((i) => i.login) && steps.length >= 1)) return null
  return { items, goal: context2.join(' '), source: 'prose', tone, whenever: wheneverOf(items) }
}

function splitChain(sentence: string): string[] {
  const out: string[] = []
  const lead = /^(?:(?:so|ok|okay|and|well|now|please|just|hi|hello|hey)[,!\s]+)*(?:first(?:ly)?|to\s+start|to\s+begin)[,\s]+/i
  let s = sentence.replace(lead, '')
  // quoted names keep their words
  const hold: string[] = []
  s = s.replace(QUOTED_G, (m) => `\u0001${hold.push(m) - 1}\u0001`)
  for (const part of s.split(CHAIN)) {
    const p = clean(part.replace(/\u0001(\d+)\u0001/g, (_, i: string) => hold[Number(i)]))
    if (p) out.push(p)
  }
  return out
}

/** a piece of prose that only says how the film should feel */
const stepIsTone = (s: string): boolean => /^(?:make|keep|sound|use\s+a|have)\b/i.test(clean(s)) && TONE_WORDS.test(s)

/** a step list made from the actions an AI plan wrote down for a "script" page (each one a line in the person's words) */
export function scriptFromActions(actions: string[], goal = ''): StepScript | null {
  const lines = actions.map((a) => clean(a)).filter(Boolean)
  if (!lines.length) return null
  const items: ScriptItem[] = []
  let n = 0
  for (const line of lines) {
    const it = parseLine(++n, line.replace(/^\s*(?:(?:step\s*)?\d{1,3}\s*[.):-]|[-*•])\s+/i, ''))
    it.written = n
    items.push(it)
  }
  if (!items.some((i) => i.atoms.length || i.login || i.goal || i.explain)) return null
  return { items, goal, source: 'plan', tone: [], whenever: wheneverOf(items) }
}

/** the step in plain words for the narrator when no AI writes it: the person's own words, tidied */
export function plainStep(item: ScriptItem): string {
  const s = item.said.replace(/\s+/g, ' ').replace(/[.]+$/, '')
  return `${cap(s)}.`
}

/** a sentence of a brief that asks for no action: voice, tone, context. Never a step, never "unplaced" */
export function isToneSentence(sentence: string): boolean {
  const s = clean(sentence)
  if (!s) return false
  if (/^(?:hi|hello|hey|thanks?|thank\s+you|cheers)\b/i.test(s) && s.split(/\s+/).length <= 3) return true
  if (/^(?:hi|hello|hey)[,!\s]+(?:i|we|this)\b/i.test(s) || /\b(?:i|we)\s+(?:run|own|have|work|am|manage|are)\s+(?:a|an|the|my|our|at|in|for)\b/i.test(s) && !/\b(?:click|press|open|book|sign|log|pick|choose|type|enter|select|tick|scroll|drag|hover)\b/i.test(s)) return true
  if (stepIsTone(s)) return true
  // any word that asks for something to be done on the page makes it an instruction, whatever else it says
  const doing = new Set(['make', 'try', 'look', 'read', 'find', 'show', 'display', 'open', 'right'])
  for (const w of s.toLowerCase().split(/[^\p{L}\p{N}'-]+/u)) if (ACTION_WORDS.has(w) && !doing.has(w) && w !== 'run' && w !== 'set') return false
  if (/\b(?:show|display|find|open|explain|demonstrate|walk)\b/i.test(s)) return false
  const it = parseLine(1, s)
  if (it.atoms.length || it.login || it.goal || it.explain) return false
  return TONE_WORDS.test(s)
}
