import { describe, expect, it } from 'vitest'
import { checkSecretFill, CREDENTIAL_KINDS, displayAddress, findPrivate, sanitizeAddress, scanNarration, scrubMap, scrubText } from '../src/main/appRecon/detect'
import type { AppMap } from '../src/shared/appRecon'

describe('finding private things in text', () => {
  it('finds emails, phone numbers, card numbers, ssns and tokens', () => {
    const kinds = (t: string) => findPrivate(t).map((f) => f.kind)
    expect(kinds('write to jordan.smith@example.com today')).toEqual(['email'])
    expect(kinds('call +1 (415) 555-0134 now')).toEqual(['phone'])
    expect(kinds('card 4242 4242 4242 4242')).toEqual(['card'])
    expect(kinds('ssn 123-45-6789')).toEqual(['ssn'])
    expect(kinds('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGHijkl')).toEqual(['token'])
    expect(kinds('key sk-live_abcdefghijklmnop1234')).toEqual(['token'])
  })

  it('does not mistake dates, prices or short numbers for private data', () => {
    expect(findPrivate('Invoice 2026-11-13 total $1,234.50 for order 4821')).toEqual([])
    expect(findPrivate('a card-like number that fails the check: 1234 5678 9012 3456').map((f) => f.kind)).not.toContain('card')
  })

  it('looks only for the kinds asked about', () => {
    expect(findPrivate('jordan@example.com', { kinds: CREDENTIAL_KINDS })).toEqual([])
    expect(findPrivate('jordan@example.com', { kinds: ['email'] })).toHaveLength(1)
  })

  it('finds known secret values, ignoring case', () => {
    expect(findPrivate('the password is SuperSecretPassword!', { values: ['supersecretpassword!'] }).map((f) => f.kind)).toEqual(['secret'])
    expect(findPrivate('hi', { values: ['ab'] })).toEqual([]) // too short to be meaningful
  })

  it('scrubs what it finds', () => {
    expect(scrubText('Welcome back, jordan@example.com! Call 415 555 0134.')).toBe('Welcome back, [email]! Call [phone].')
    expect(scrubText('pw hunter22', { values: ['hunter22'] })).toBe('pw [hidden]')
  })
})

describe('scrubbing the app map', () => {
  const map = {
    version: 1,
    startUrl: 'https://app.example.com/login',
    host: 'app.example.com',
    scoutedAt: 'now',
    login: { detected: true, otpLikely: false },
    sensitiveSelectors: [],
    pages: [
      {
        url: 'https://app.example.com/customers/48213?token=abc123',
        title: 'Jordan Smith (jordan@example.com)',
        screenshot: 'p1.jpg',
        headings: ['Welcome back, jordan@example.com'],
        notices: ['Call 415 555 0134 to confirm'],
        fields: [{ selector: '#e', label: 'Email jordan@example.com', inputType: 'text', name: 'e', kind: 'email', sensitive: true, rect: { x: 0, y: 0, w: 1, h: 1 } }],
        controls: [{ selector: 'a', label: 'Mail jordan@example.com', kind: 'link', href: 'https://app.example.com/users/jordan@example.com', rect: { x: 0, y: 0, w: 1, h: 1 } }]
      }
    ]
  } as unknown as AppMap

  it('removes private text and ids before a model or a file sees the map', () => {
    const s = JSON.stringify(scrubMap(map))
    expect(s).not.toContain('jordan@example.com')
    expect(s).not.toContain('415 555 0134')
    expect(s).not.toContain('48213')
    expect(s).not.toContain('abc123')
    expect(s).toContain('[email]')
    expect(s).toContain('/customers/…')
  })
})

describe('the address shown in the video', () => {
  it('hides ids, emails and tokens in the path and drops the query', () => {
    expect(sanitizeAddress('https://app.example.com/customers/48213/orders')).toBe('https://app.example.com/customers/…/orders')
    expect(sanitizeAddress('https://app.example.com/u/jordan@example.com')).toBe('https://app.example.com/u/…')
    expect(sanitizeAddress('https://app.example.com/r/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('https://app.example.com/r/…')
    expect(sanitizeAddress('https://app.example.com/reset?token=abc&email=a@b.co')).toBe('https://app.example.com/reset')
    expect(sanitizeAddress('https://app.example.com/reset?token=abc&email=a@b.co', true)).toBe('https://app.example.com/reset?token=…&email=…')
  })

  it('shows host and a clean path, without the scheme', () => {
    expect(displayAddress('https://app.example.com/')).toBe('app.example.com')
    expect(displayAddress('https://app.example.com/customers/48213')).toBe('app.example.com/customers/…')
    expect(displayAddress('https://the-internet.herokuapp.com/secure')).toBe('the-internet.herokuapp.com/secure')
  })
})

describe('checking narration before it is voiced', () => {
  it('accepts plain, honest lines', () => {
    expect(scanNarration('Type your username, and the app knows whose account to open.').ok).toBe(true)
  })

  it('refuses a line that repeats a secret or contains private data', () => {
    expect(scanNarration('Now type SuperSecretPassword! into the box.', { values: ['SuperSecretPassword!'] }).ok).toBe(false)
    expect(scanNarration('Sign in as jordan@example.com.').problems[0]).toContain('email')
  })

  it('refuses promises the video cannot show', () => {
    for (const t of ['Your account is fully protected.', 'It leaves no trace behind.', 'Totally unbreakable security.', 'We guarantee safety.']) {
      expect(scanNarration(t).ok, t).toBe(false)
    }
  })
})

describe('where the vault may type', () => {
  const on = { pageAllowed: true }
  it('puts the password only in a password field', () => {
    expect(checkSecretFill({ secret: 'password', fieldKind: 'password', ...on }).allow).toBe(true)
    expect(checkSecretFill({ secret: 'password', fieldKind: 'text', ...on }).allow).toBe(false)
    expect(checkSecretFill({ secret: 'password', fieldKind: 'search', ...on }).allow).toBe(false)
  })

  it('puts the username only in a sign-in style field', () => {
    for (const k of ['username', 'email', 'text'] as const) expect(checkSecretFill({ secret: 'username', fieldKind: k, ...on }).allow, k).toBe(true)
    expect(checkSecretFill({ secret: 'username', fieldKind: 'card', ...on }).allow).toBe(false)
  })

  it('never types on a page outside the allowed sites, or a secret it does not know', () => {
    expect(checkSecretFill({ secret: 'password', fieldKind: 'password', pageAllowed: false }).allow).toBe(false)
    expect(checkSecretFill({ secret: 'apikey', fieldKind: 'text', ...on }).allow).toBe(false)
  })
})
