import type { FieldKind } from '@shared/appRecon'

/**
 * Which fields are sensitive, decided from what the page itself says about
 * them (type, name, label, autocomplete hint). No model involved — this must
 * give the same answer every run, and be explainable to a customer.
 */

export interface FieldHints {
  type?: string
  name?: string
  id?: string
  label?: string
  placeholder?: string
  autocomplete?: string
}

export function classifyField(h: FieldHints): FieldKind {
  const type = (h.type ?? 'text').toLowerCase()
  const hay = [h.name, h.id, h.label, h.placeholder].filter(Boolean).join(' ').toLowerCase()
  const auto = (h.autocomplete ?? '').toLowerCase()
  if (type === 'password' || /pass(word|wd)\b|\bpwd\b/.test(hay)) return 'password'
  if (auto.includes('one-time-code') || /\botp\b|one.?time|2fa|mfa|verification code|security code|authenticator|passcode/.test(hay)) return 'otp'
  if (auto.startsWith('cc-') || /card.?number|\bcvv\b|\bcvc\b|credit.?card|expir/.test(hay)) return 'card'
  if (/\bssn\b|social.?security|national.?id|passport|tax.?id/.test(hay)) return 'ssn'
  if (type === 'email' || auto === 'email' || /e-?mail/.test(hay)) return 'email'
  if (type === 'tel' || auto.startsWith('tel') || /phone|mobile|\btel\b/.test(hay)) return 'phone'
  if (/first.?name|last.?name|full.?name|surname|given.?name/.test(hay) || auto.includes('name') && !auto.includes('user')) return 'person-name'
  if (/address|street|zip|post(al)?.?code|\bcity\b/.test(hay)) return 'address'
  if (auto === 'username' || /user.?name|user.?id|login|account/.test(hay)) return 'username'
  if (type === 'search' || /search/.test(hay)) return 'search'
  if (['text', ''].includes(type)) return 'text'
  return 'other'
}

export interface RedactionOptions {
  /** show login names in the video (a public demo account, or the customer said it is fine) */
  revealIdentifiers?: boolean
}

/** secrets and personal data are always blurred; a login name only when the customer did not say otherwise */
export function isSensitive(kind: FieldKind, opts: RedactionOptions = {}): boolean {
  switch (kind) {
    case 'password':
    case 'otp':
    case 'card':
    case 'ssn':
    case 'email':
    case 'phone':
    case 'person-name':
    case 'address':
      return true
    case 'username':
      return !opts.revealIdentifiers
    default:
      return false
  }
}

/** rules that blur matching elements even if the scout has never seen the page */
export const GENERIC_SENSITIVE_SELECTORS = [
  'input[type="password"]',
  'input[autocomplete*="one-time-code"]',
  'input[autocomplete^="cc-"]',
  'input[name*="otp" i]',
  'input[name*="cvv" i]',
  'input[name*="ssn" i]'
]
