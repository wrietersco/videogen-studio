import type { AppMap } from '@shared/appRecon'
import type { FieldKind } from '@shared/appRecon'

/**
 * Finding private things in text, without a model.
 *
 * Used to (1) scrub the app map before it is shown to a writer model or kept,
 * (2) clean the address bar shown in the video, (3) check narration before it
 * is voiced, and (4) decide where the vault may type a secret.
 *
 * "credential" kinds (token, card, ssn) are always private. "personal" kinds
 * (email, phone, digits) are private only when the person turned privacy mode
 * on, because a demo app's visible emails are often the point of the video.
 */

export type PrivateKind = 'token' | 'card' | 'ssn' | 'email' | 'phone' | 'digits' | 'secret'
export interface Found {
  kind: PrivateKind
  text: string
}

export const CREDENTIAL_KINDS: PrivateKind[] = ['token', 'card', 'ssn', 'secret']
export const PERSONAL_KINDS: PrivateKind[] = ['email', 'phone', 'digits']
export const ALL_KINDS: PrivateKind[] = [...CREDENTIAL_KINDS, ...PERSONAL_KINDS]

const RX = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  token: /\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}|[A-Fa-f0-9]{32,}|[A-Za-z0-9+/]{40,}={0,2})\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  card: /\b(?:\d[ -]?){13,19}\b/g,
  phone: /(?<![\w])\+?\(?\d[\d\s().-]{7,}\d(?![\w])/g,
  digits: /\b\d{9,}\b/g
}

function luhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

const isDate = (s: string): boolean => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s.trim()) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s.trim())

/** every private-looking thing in the text, for the kinds asked about (and any known secret values) */
export function findPrivate(text: string, opts: { kinds?: PrivateKind[]; values?: string[] } = {}): Found[] {
  const kinds = new Set(opts.kinds ?? ALL_KINDS)
  const out: Found[] = []
  const taken: Array<[number, number]> = []
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x)
  const add = (kind: PrivateKind, m: RegExpMatchArray) => {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (overlaps(start, end)) return
    taken.push([start, end])
    out.push({ kind, text: m[0] })
  }

  for (const v of opts.values ?? []) {
    if (v.length < 3) continue
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    for (const m of text.matchAll(re)) add('secret', m)
  }
  if (kinds.has('token')) for (const m of text.matchAll(RX.token)) add('token', m)
  if (kinds.has('ssn')) for (const m of text.matchAll(RX.ssn)) add('ssn', m)
  if (kinds.has('card')) for (const m of text.matchAll(RX.card)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) add('card', m)
  }
  if (kinds.has('email')) for (const m of text.matchAll(RX.email)) add('email', m)
  if (kinds.has('phone')) for (const m of text.matchAll(RX.phone)) {
    const digits = m[0].replace(/\D/g, '')
    if (digits.length >= 9 && digits.length <= 15 && !isDate(m[0])) add('phone', m)
  }
  if (kinds.has('digits')) for (const m of text.matchAll(RX.digits)) add('digits', m)
  return out
}

/**
 * The same detector as `findPrivate`, as source text for a function that runs
 * inside the page: `(text) => [{kind, start, end}]`. It uses the very same
 * patterns, so what the page blurs is what this file would have found.
 */
export function pageDetectorSource(kinds: PrivateKind[]): string {
  const rx: Record<string, string> = {}
  for (const [k, v] of Object.entries(RX)) rx[k] = v.source
  return String.raw`(() => {
  const RX = ${JSON.stringify(rx)};
  const kinds = ${JSON.stringify(kinds)};
  const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };
  const isDate = (s) => /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(s.trim()) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(s.trim());
  return (text) => {
    const out = [], taken = [];
    const free = (a, b) => !taken.some((t) => a < t[1] && b > t[0]);
    const add = (kind, m) => { const a = m.index, b = a + m[0].length; if (!free(a, b)) return; taken.push([a, b]); out.push({ kind, start: a, end: b }); };
    const each = (k, f) => { if (!kinds.includes(k)) return; for (const m of text.matchAll(new RegExp(RX[k], 'g'))) f(m); };
    each('token', (m) => add('token', m));
    each('ssn', (m) => add('ssn', m));
    each('card', (m) => { const d = m[0].replace(/\D/g, ''); if (d.length >= 13 && d.length <= 19 && luhn(d)) add('card', m); });
    each('email', (m) => add('email', m));
    each('phone', (m) => { const d = m[0].replace(/\D/g, ''); if (d.length >= 9 && d.length <= 15 && !isDate(m[0])) add('phone', m); });
    each('digits', (m) => add('digits', m));
    return out;
  };
})()`
}

/** the text with every private-looking thing replaced by a plain marker such as [email] */
export function scrubText(text: string, opts: { kinds?: PrivateKind[]; values?: string[] } = {}): string {
  const found = findPrivate(text, opts)
  let out = text
  for (const f of found.sort((a, b) => b.text.length - a.text.length)) out = out.split(f.text).join(f.kind === 'secret' ? '[hidden]' : `[${f.kind}]`)
  return out
}

/**
 * A copy of the app map that is safe to show a writer model or keep on disk:
 * page titles, headings, notices and control names scrubbed. Selectors, field
 * kinds and addresses are kept (they are what the planner needs), but
 * addresses lose ids and emails.
 */
export function scrubMap(map: AppMap, opts: { kinds?: PrivateKind[]; values?: string[] } = {}): AppMap {
  const s = (t: string) => scrubText(t, opts)
  return {
    ...map,
    pages: map.pages.map((p) => ({
      ...p,
      url: sanitizeAddress(p.url, true),
      title: s(p.title),
      headings: p.headings.map(s),
      notices: p.notices.map(s),
      controls: p.controls.map((c) => ({ ...c, label: s(c.label), href: c.href ? sanitizeAddress(c.href, true) : undefined })),
      fields: p.fields.map((f) => ({ ...f, label: s(f.label) }))
    }))
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** a path part that is an identifier or something private rather than a word */
function idLike(seg: string): boolean {
  let s = seg
  try {
    s = decodeURIComponent(seg)
  } catch {
    /* keep raw */
  }
  return /^\d{3,}$/.test(s) || UUID.test(s) || /^[0-9a-f]{16,}$/i.test(s) || s.includes('@') || /^[A-Za-z0-9_-]{24,}$/.test(s) || TOKEN_ONE.test(s)
}
const TOKEN_ONE = new RegExp(RX.token.source)

/** a path with every identifier-like part replaced by an ellipsis */
function cleanPath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (seg && idLike(seg) ? '…' : seg))
    .join('/')
}

/**
 * The address as the video shows it: host and path, with ids, emails and
 * tokens replaced by an ellipsis. The query string and fragment are dropped
 * (they are where tokens usually are) unless `full` is asked for, in which
 * case only their values are removed.
 */
export function sanitizeAddress(url: string, full = false): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const path = cleanPath(u.pathname)
  const base = u.protocol === 'http:' || u.protocol === 'https:' ? `${u.protocol}//${u.host}${path}` : url
  if (!full) return base
  const keys = [...new Set([...u.searchParams.keys()])]
  return keys.length ? `${base}?${keys.map((k) => `${k}=…`).join('&')}` : base
}

/** what the video shows in its address bar: no scheme, ids removed */
export function displayAddress(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const path = cleanPath(u.pathname)
  return (u.hostname + (path === '/' ? '' : path)).slice(0, 64)
}

// ---------------------------------------------------------------- narration

const ABSOLUTE_CLAIMS = /\b(fully (?:protected|secure)|completely (?:secure|safe|protected)|100\s?% (?:secure|safe)|unbreakable|hack-?proof|impossible to (?:hack|breach)|no trace|leav(?:e|ing) no trace|guarantee[ds]?|military-?grade|bulletproof|foolproof)\b/i

export interface NarrationCheck {
  ok: boolean
  problems: string[]
}

/** every line is checked before it is voiced: no secret, no private data, no promise the video cannot show */
export function scanNarration(text: string, opts: { values?: string[]; kinds?: PrivateKind[] } = {}): NarrationCheck {
  const problems: string[] = []
  for (const f of findPrivate(text, { values: opts.values, kinds: opts.kinds ?? ALL_KINDS })) {
    problems.push(f.kind === 'secret' ? 'repeats a secret value' : `contains something that looks like a ${f.kind}`)
  }
  const claim = ABSOLUTE_CLAIMS.exec(text)
  if (claim) problems.push(`makes an absolute claim ("${claim[0]}")`)
  return { ok: problems.length === 0, problems }
}

// ---------------------------------------------------------------- where the vault may type

export interface SecretFill {
  /** the secret's name in the vault: "username", "password" … */
  secret: string
  fieldKind: FieldKind
  /** the page the field is on */
  pageAllowed: boolean
}

/** a stored secret goes only into the field it is for, on the app's own pages */
export function checkSecretFill(f: SecretFill): { allow: boolean; reason: string } {
  if (!f.pageAllowed) return { allow: false, reason: 'the field is on a page outside the allowed sites' }
  if (f.secret === 'password') return f.fieldKind === 'password' ? { allow: true, reason: 'password into a password field' } : { allow: false, reason: 'the password may only be typed into a password field' }
  if (f.secret === 'username') {
    return ['username', 'email', 'text'].includes(f.fieldKind) ? { allow: true, reason: 'username into a sign-in field' } : { allow: false, reason: `a username may not be typed into a ${f.fieldKind} field` }
  }
  return { allow: false, reason: `"${f.secret}" is not a known secret name` }
}
