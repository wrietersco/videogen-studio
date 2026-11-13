import type { Guardrails } from '@shared/appRecon'

/**
 * The policy gate — the part that keeps the agent inside the lines.
 *
 * Guardrails typed by a user are only *requests* to a model; models can be
 * talked out of them by a page's own text. This gate runs outside any model
 * and decides on facts: which host a request goes to, which HTTP method it
 * uses, what a control says. Anything it blocks is blocked no matter what the
 * planner, the page or an attached document claims.
 */

/** controls that change or spend something — never clicked unless the step is a declared sign-in/out */
export const DEFAULT_BLOCKED_WORDS = [
  'delete', 'remove', 'erase', 'destroy', 'cancel', 'unsubscribe', 'deactivate', 'close account', 'terminate', 'revoke',
  'pay', 'purchase', 'buy', 'checkout', 'place order', 'transfer', 'withdraw', 'send money',
  'send', 'publish', 'post', 'approve', 'reject', 'reset', 'change password', 'save changes', 'update', 'confirm'
] as const

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const PASSIVE = new Set(['image', 'font', 'stylesheet', 'media'])
const LOGIN_LABEL = /\b(log\s?-?in|sign\s?-?in|submit|continue|next)\b/i
const LOGOUT_LABEL = /\b(log\s?-?out|sign\s?-?out)\b/i

export interface Verdict {
  allow: boolean
  reason: string
}

export interface RequestInfo {
  method: string
  url: string
  /** puppeteer's resource type: document, xhr, fetch, image, script … */
  resourceType: string
}

export class PolicyGate {
  private loginUntil = 0
  /** every decision, so a run can be audited afterwards */
  readonly audit: Array<{ at: number; kind: 'request' | 'click'; allow: boolean; what: string; reason: string }> = []

  constructor(
    readonly guardrails: Guardrails,
    private readonly now: () => number = Date.now
  ) {}

  hostAllowed(url: string): boolean {
    let host: string
    try {
      const u = new URL(url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'about:' && u.protocol !== 'data:' && u.protocol !== 'blob:') return false
      if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return true
      host = u.hostname.toLowerCase()
    } catch {
      return false
    }
    return this.guardrails.allowedHosts.some((h) => {
      const a = h.toLowerCase()
      return host === a || host.endsWith('.' + a)
    })
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
    if (!this.hostAllowed(r.url)) {
      // pictures and fonts from elsewhere only make a page look right; they cannot carry anything out
      if (PASSIVE.has(r.resourceType) && r.method === 'GET') return { allow: true, reason: 'passive resource from another host' }
      return { allow: false, reason: 'host is not on the allowed list' }
    }
    if (MUTATING.has(r.method.toUpperCase())) {
      if (this.now() <= this.loginUntil) return { allow: true, reason: 'sign-in or sign-out in progress' }
      if (!this.guardrails.readOnly) return { allow: true, reason: 'read-only mode is off' }
      return { allow: false, reason: 'read-only: this request would change data' }
    }
    return { allow: true, reason: 'read request to an allowed host' }
  }

  checkClick(c: { label: string; intent?: string }): Verdict {
    const v = this.decideClick(c)
    this.audit.push({ at: this.now(), kind: 'click', allow: v.allow, what: c.label, reason: v.reason })
    return v
  }

  private decideClick(c: { label: string; intent?: string }): Verdict {
    const label = c.label.trim().toLowerCase()
    if (c.intent === 'login-submit') {
      return LOGIN_LABEL.test(label) || label === '' ? { allow: true, reason: 'declared sign-in' } : { allow: false, reason: 'a sign-in step must press a sign-in control' }
    }
    if (c.intent === 'logout') {
      return LOGOUT_LABEL.test(label) ? { allow: true, reason: 'declared sign-out' } : { allow: false, reason: 'a sign-out step must press a sign-out control' }
    }
    const words = [...DEFAULT_BLOCKED_WORDS, ...this.guardrails.blockedWords]
    const hit = words.find((w) => new RegExp(`(^|[^a-z])${w.replace(/\s+/g, '\\s+')}([^a-z]|$)`, 'i').test(label))
    return hit ? { allow: false, reason: `"${hit}" changes or spends something` } : { allow: true, reason: 'looks safe' }
  }
}

/**
 * Turn what the user typed into rules. The safe reading always wins: with no
 * instruction at all the run is read-only. Anything we cannot turn into a rule
 * (e.g. "only customer01 in the ABC module") is kept as advice for the planner
 * and shown back to the user as *not enforced* — never silently implied.
 */
export function interpretGuardrails(text: string, startUrl: string): { guardrails: Guardrails; enforced: string[]; advisory: string[] } {
  const host = new URL(startUrl).hostname
  const enforced = [`Only pages on ${host} are opened.`]
  const advisory: string[] = []
  const blocked: string[] = []
  let readOnly = true
  const t = text.trim()
  const lines = t.split(/\n|(?<=[.;])\s+/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    if (/\b(do not|don't|never|must not)\b.*\b(delete|remove|update|modify|change|edit|write|submit|create)\b/i.test(line)) {
      enforced.push('Nothing that changes data is sent (the sign-in itself is the one exception).')
    } else {
      const only = /\bonly\b/i.test(line)
      advisory.push(only ? `${line} — the recorder cannot check this automatically; review the playbook before recording.` : line)
    }
    for (const m of line.matchAll(/\bdo not (?:click|press|use)\s+["“']?([\w ]{2,24})["”']?/gi)) blocked.push(m[1].trim().toLowerCase())
  }
  if (!t) enforced.push('Nothing that changes data is sent (the sign-in itself is the one exception).')
  if (blocked.length) enforced.push(`Never presses: ${blocked.join(', ')}.`)
  readOnly = true // there is no way to ask for less safety here; a writing run needs a deliberate, separate switch
  return {
    guardrails: { allowedHosts: [host], readOnly, blockedWords: blocked, advisory },
    enforced: [...new Set(enforced)],
    advisory
  }
}
