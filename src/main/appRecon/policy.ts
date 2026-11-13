import type { Guardrails } from '@shared/appRecon'

/**
 * The restrictions engine.
 *
 * By default a run is NOT restricted: it explores the app the way a person
 * would (the person accepted the app's terms, and asks for what they asked
 * for). Restrictions are opt-in, either ticked on the form or typed as rules,
 * and the ones a person chooses are enforced here, outside any model, on facts:
 * which host a request goes to, what kind of request it is, what a control says.
 * A page, a planner or an attached document cannot talk this code out of a rule.
 *
 * A few basics stay on in every mode because they protect the person's own
 * session and account, not because they limit exploration: logging out only
 * as a declared step (otherwise a crawl ends its own session).
 */

// ---------------------------------------------------------------- word groups

/** controls that remove something */
export const DELETE_WORDS = [
  'delete', 'remove', 'erase', 'destroy', 'trash', 'discard', 'wipe', 'clear all', 'deactivate', 'close account', 'terminate', 'revoke', 'unsubscribe', 'cancel'
] as const

/** controls that spend money or send something out */
export const SPEND_WORDS = [
  'pay', 'purchase', 'buy', 'checkout', 'place order', 'order now', 'transfer', 'withdraw', 'send money', 'send', 'publish', 'post', 'subscribe', 'upgrade', 'donate', 'book now', 'reserve'
] as const

/** controls that change settings, credentials or the state of something */
export const SETTINGS_WORDS = [
  'change password', 'reset', 'save changes', 'save settings', 'apply changes', 'update', 'change email', 'change plan', 'approve', 'reject', 'confirm'
] as const

/** kept for callers that want the whole list */
export const DEFAULT_BLOCKED_WORDS = [...DELETE_WORDS, ...SPEND_WORDS, ...SETTINGS_WORDS] as const

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
/** things a page loads to look right; fetching them from another host cannot carry anything out */
const PASSIVE = new Set(['image', 'font', 'stylesheet', 'media', 'script'])
const LOGIN_LABEL = /\b(log\s?-?in|sign\s?-?in|submit|continue|next)\b/i
const LOGOUT_LABEL = /\b(log\s?-?out|sign\s?-?out|log\s?-?off|sign\s?-?off)\b/i
/** a link whose address ends the session */
const LOGOUT_HREF = /(^|[^a-z])(log\s?-?out|sign\s?-?out|log\s?-?off|sign\s?-?off)([^a-z]|$)/i
/** the last part of an address that reads, even though it is sent with POST */
const READ_SEGMENT = new Set(['search', 'query', 'list', 'find', 'filter', 'lookup', 'autocomplete', 'suggest', 'typeahead', 'count', 'fetch', 'get', 'read', 'load', 'paginate', 'datatable'])

const wordRe = (w: string): RegExp => new RegExp(`(^|[^a-z])${w.replace(/\s+/g, '\\s+')}([^a-z]|$)`, 'i')
const matchAny = (words: readonly string[], text: string): string | undefined => words.find((w) => wordRe(w).test(text))

// ---------------------------------------------------------------- types

export interface Verdict {
  allow: boolean
  reason: string
}

export interface RequestInfo {
  method: string
  url: string
  /** puppeteer's resource type: document, xhr, fetch, image, script … */
  resourceType: string
  /** the body of the request, when there is one (used to tell a GraphQL query from a mutation) */
  postData?: string
}

export interface ClickInfo {
  /** what the control says (visible text, value, aria-label, title) */
  label: string
  intent?: 'navigate' | 'login-submit' | 'logout' | 'inspect'
  kind?: 'button' | 'link'
  href?: string
  /** id, class and test-id text: the only clue an icon-only control gives */
  hint?: string
}

/** the restrictions, with defaults filled in: nothing is restricted except leaving the app's own sites */
export interface Restrictions {
  stayOnSites: boolean
  readOnly: boolean
  noDelete: boolean
  noSpend: boolean
  noSettings: boolean
  privacyMode: boolean
}

export const NO_RESTRICTIONS: Restrictions = { stayOnSites: true, readOnly: false, noDelete: false, noSpend: false, noSettings: false, privacyMode: false }

export function restrictionsOf(g: Guardrails): Restrictions {
  return {
    stayOnSites: g.stayOnSites ?? true,
    readOnly: g.readOnly,
    noDelete: g.noDelete ?? false,
    noSpend: g.noSpend ?? false,
    noSettings: g.noSettings ?? false,
    privacyMode: g.privacyMode ?? false
  }
}

/** what a GraphQL request body does: a query only reads, a mutation changes data */
export function classifyGraphql(body: string | undefined): 'read' | 'write' | 'unknown' {
  if (!body) return 'unknown'
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return 'unknown'
  }
  const ops = Array.isArray(parsed) ? parsed : [parsed]
  let seen = false
  for (const op of ops) {
    if (!op || typeof op !== 'object') return 'unknown'
    const o = op as { query?: unknown; operationName?: unknown }
    if (typeof o.query === 'string') {
      const text = o.query.replace(/#[^\n]*/g, '').trim()
      const head = /^(query|mutation|subscription|\{)/i.exec(text)?.[1]?.toLowerCase()
      if (head === 'mutation') return 'write'
      if (head === 'query' || head === 'subscription' || head === '{') seen = true
      else return 'unknown'
    } else if (typeof o.operationName === 'string') {
      // a persisted query: only the name is known
      if (/^(get|list|fetch|find|search|query|load|read|count)/i.test(o.operationName)) seen = true
      else return 'unknown'
    } else return 'unknown'
  }
  return seen ? 'read' : 'unknown'
}

// ---------------------------------------------------------------- the gate

export class PolicyGate {
  private loginUntil = 0
  private readonly hosts: string[]
  private readonly readEndpoints = new Set<string>()
  private readonly blocked = new Map<string, number>()
  readonly restrictions: Restrictions
  /** every decision, so a run can be audited afterwards */
  readonly audit: Array<{ at: number; kind: 'request' | 'click'; allow: boolean; what: string; reason: string }> = []

  constructor(
    readonly guardrails: Guardrails,
    private readonly now: () => number = Date.now
  ) {
    this.hosts = [...guardrails.allowedHosts]
    this.restrictions = restrictionsOf(guardrails)
  }

  /** a sign-in or API host the app turned out to need (learned while exploring) */
  allowHost(host: string): void {
    const h = host.toLowerCase()
    if (!this.hosts.includes(h)) this.hosts.push(h)
  }

  /** hosts the app tried to reach that are not allowed, with how often: shown in the review so the person can add them */
  blockedHosts(): Array<{ host: string; count: number }> {
    return [...this.blocked].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count)
  }

  /** a write-style endpoint seen answering a read (for example a search box that uses POST) */
  learnReadEndpoint(method: string, url: string): void {
    try {
      this.readEndpoints.add(`${method.toUpperCase()} ${new URL(url).pathname}`)
    } catch {
      /* not a URL */
    }
  }

  hostAllowed(url: string): boolean {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return false
    }
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return true
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (!this.restrictions.stayOnSites) return true
    const host = u.hostname.toLowerCase()
    return this.hosts.some((a) => host === a.toLowerCase() || host.endsWith('.' + a.toLowerCase()))
  }

  /** a declared sign-in (or sign-out) may send one data-changing request in the next few seconds */
  openSessionWindow(ms = 8000): void {
    this.loginUntil = this.now() + ms
  }

  checkRequest(r: RequestInfo): Verdict {
    const v = this.decideRequest(r)
    this.audit.push({ at: this.now(), kind: 'request', allow: v.allow, what: `${r.method} ${r.url.slice(0, 120)}`, reason: v.reason })
    return v
  }

  private decideRequest(r: RequestInfo): Verdict {
    const method = r.method.toUpperCase()
    if (!this.hostAllowed(r.url)) {
      // scripts, styles, fonts and pictures from other hosts only make a page work; they cannot carry anything out
      if (PASSIVE.has(r.resourceType) && method === 'GET') return { allow: true, reason: 'page resource from another host' }
      try {
        const host = new URL(r.url).hostname.toLowerCase()
        this.blocked.set(host, (this.blocked.get(host) ?? 0) + 1)
      } catch {
        /* not a URL */
      }
      return { allow: false, reason: 'host is not on the allowed list' }
    }
    if (!MUTATING.has(method) || !this.restrictions.readOnly) return { allow: true, reason: MUTATING.has(method) ? 'read-only is off' : 'read request to an allowed host' }

    // read-only: a data-changing request is blocked unless it is really a read, or the declared sign-in
    if (this.now() <= this.loginUntil) return { allow: true, reason: 'sign-in or sign-out in progress' }
    let path = ''
    try {
      path = new URL(r.url).pathname
    } catch {
      /* keep empty */
    }
    if (/graphql/i.test(path) || /^\s*[\[{]/.test(r.postData ?? '')) {
      const g = classifyGraphql(r.postData)
      if (g === 'read') return { allow: true, reason: 'GraphQL query (reads only)' }
      if (g === 'write') return { allow: false, reason: 'read-only: this GraphQL request changes data' }
    }
    if (this.readEndpoints.has(`${method} ${path}`)) return { allow: true, reason: 'this endpoint was seen answering reads' }
    const last = path.split('/').filter(Boolean).pop() ?? ''
    if (READ_SEGMENT.has(last.split(/[-_.]/)[0].toLowerCase())) return { allow: true, reason: 'looks like a search or lookup' }
    return { allow: false, reason: 'read-only: this request would change data' }
  }

  checkClick(c: ClickInfo): Verdict {
    const v = this.decideClick(c)
    this.audit.push({ at: this.now(), kind: 'click', allow: v.allow, what: c.label || c.hint || '(no name)', reason: v.reason })
    return v
  }

  /** the same verdict without writing to the audit trail (for choosing what to try, not for doing it) */
  peekClick(c: ClickInfo): Verdict {
    return this.decideClick(c)
  }

  private decideClick(c: ClickInfo): Verdict {
    const label = c.label.trim().toLowerCase()
    if (c.intent === 'login-submit') {
      return LOGIN_LABEL.test(label) || label === '' ? { allow: true, reason: 'declared sign-in' } : { allow: false, reason: 'a sign-in step must press a sign-in control' }
    }
    if (c.intent === 'logout') {
      return LOGOUT_LABEL.test(label) ? { allow: true, reason: 'declared sign-out' } : { allow: false, reason: 'a sign-out step must press a sign-out control' }
    }

    // always on: a crawl must not end its own session
    if (LOGOUT_LABEL.test(label) || (c.href && LOGOUT_HREF.test(safePath(c.href)))) {
      return { allow: false, reason: 'signing out ends the session; it is only done as a declared sign-out step' }
    }

    const r = this.restrictions
    const text = `${label} ${(c.hint ?? '').toLowerCase()}`
    const hrefText = c.href ? safePath(c.href).toLowerCase() : ''
    const groups: Array<[boolean, readonly string[], string]> = [
      [r.readOnly || r.noDelete, DELETE_WORDS, 'removes something'],
      [r.readOnly || r.noSpend, SPEND_WORDS, 'spends or sends something'],
      [r.readOnly || r.noSettings, SETTINGS_WORDS, 'changes settings or state']
    ]
    for (const [on, words, why] of groups) {
      if (!on) continue
      const hit = matchAny(words, text) ?? (c.kind === 'link' ? matchAny(words.filter((w) => !w.includes(' ')), hrefText.replace(/[^a-z]+/g, ' ')) : undefined)
      if (hit) return { allow: false, reason: `"${hit}" ${why}` }
    }

    // typed "do not press X"
    const typed = this.guardrails.blockedWords.find((w) => wordRe(w).test(text))
    if (typed) return { allow: false, reason: `"${typed}" was ruled out` }

    // an icon-only control could be anything; only plain navigation is trusted while something is restricted
    const restricted = r.readOnly || r.noDelete || r.noSpend || r.noSettings
    const plainNavigation = c.kind === 'link' && !!c.href && this.hostAllowed(c.href)
    if (restricted && label === '' && !plainNavigation) {
      return { allow: false, reason: 'a control with no readable name could be a delete or save icon' }
    }
    return { allow: true, reason: restricted ? 'allowed under the chosen restrictions' : 'nothing restricted' }
  }
}

function safePath(href: string): string {
  try {
    const u = new URL(href)
    return u.pathname + u.search
  } catch {
    return href
  }
}

// ---------------------------------------------------------------- reading what the person typed and ticked

export interface RestrictionChecks {
  stayOnSites?: boolean
  readOnly?: boolean
  noDelete?: boolean
  noSpend?: boolean
  noSettings?: boolean
  privacyMode?: boolean
}

/**
 * Turn the ticked checkboxes and the typed text into rules. With nothing ticked
 * and nothing typed the run is unrestricted (it still stays on the app's own
 * sites, unless that box is unticked). Anything we cannot turn into a rule
 * (e.g. "only customer01 in the ABC module") is kept as advice for the planner
 * and shown back to the person as *not enforced*, never silently implied.
 */
export function interpretGuardrails(text: string, startUrl: string, checks: RestrictionChecks = {}): { guardrails: Guardrails; enforced: string[]; advisory: string[] } {
  const host = new URL(startUrl).hostname
  const r: Restrictions = { ...NO_RESTRICTIONS, ...Object.fromEntries(Object.entries(checks).filter(([, v]) => v !== undefined)) } as Restrictions
  const advisory: string[] = []
  const blocked: string[] = []
  const lines = text.trim().split(/\n|(?<=[.;])\s+/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    const no = /\b(do not|don't|dont|never|must not|mustn't|no)\b/i.test(line)
    const lookOnly = /\b(read.?only|look only|view only|just look|only look)\b/i.test(line)
    let understood = false
    if (lookOnly) { r.readOnly = true; understood = true }
    if (no) {
      if (/\b(delete|remove|erase|destroy)\b/i.test(line)) { r.noDelete = true; understood = true }
      if (/\b(update|modify|change|edit|write|create|save|add|submit|alter)\b/i.test(line)) { r.readOnly = true; understood = true }
      if (/\b(spend|pay|buy|purchase|order|send|publish|post|transfer|withdraw)\b/i.test(line)) { r.noSpend = true; understood = true }
      if (/\b(settings|password|account)\b/i.test(line)) { r.noSettings = true; understood = true }
    }
    for (const m of line.matchAll(/\b(?:do not|don't|never)\s+(?:click|press|use)\s+["“']?([\w ]{2,24})["”']?/gi)) {
      blocked.push(m[1].trim().toLowerCase())
      understood = true
    }
    if (!understood || /\bonly\b/i.test(line)) {
      advisory.push(/\bonly\b/i.test(line) ? `${line} — the recorder cannot check this automatically; review the steps before recording.` : line)
    }
  }
  const enforced: string[] = []
  if (r.stayOnSites) enforced.push(`Only pages on ${host} (and sign-in or API hosts it needs) are opened.`)
  if (r.readOnly) enforced.push('Nothing that changes data is sent (the sign-in itself is the one exception).')
  if (r.noDelete) enforced.push('Nothing is deleted or removed.')
  if (r.noSpend) enforced.push('Nothing is bought, paid for, sent or published.')
  if (r.noSettings) enforced.push('Settings, passwords and accounts are not changed.')
  if (r.privacyMode) enforced.push('Personal data in tables and lists is hidden.')
  if (blocked.length) enforced.push(`Never presses: ${blocked.join(', ')}.`)
  return {
    guardrails: { allowedHosts: [host], readOnly: r.readOnly, stayOnSites: r.stayOnSites, noDelete: r.noDelete, noSpend: r.noSpend, noSettings: r.noSettings, privacyMode: r.privacyMode, blockedWords: [...new Set(blocked)], advisory },
    enforced: [...new Set(enforced)],
    advisory
  }
}
