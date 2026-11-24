import { describe, expect, it } from 'vitest'
import { judgeLogin, looksLikeRefusal } from '../src/main/appRecon/loginCheck'

const base = { urlBefore: 'https://a.com/login?next=%2Ftool', urlNow: 'https://a.com/login?next=%2Ftool', passwordVisible: true, interstitial: false, errorText: '', accountControl: false }

describe('judgeLogin', () => {
  it('waits while still on the form with no message', () => expect(judgeLogin(base)).toBe('waiting'))
  it('succeeds when the password field is gone', () => expect(judgeLogin({ ...base, passwordVisible: false })).toBe('success'))
  it('succeeds when the address moved away', () => expect(judgeLogin({ ...base, urlNow: 'https://a.com/tool' })).toBe('success'))
  it('succeeds when a log-out control appears', () => expect(judgeLogin({ ...base, accountControl: true })).toBe('success'))
  it('keeps waiting during a browser check', () => expect(judgeLogin({ ...base, interstitial: true, passwordVisible: false })).toBe('waiting'))
  it('fails on a refusal message', () => expect(judgeLogin({ ...base, errorText: 'Invalid credentials' })).toBe('failed'))
  it('ignores unrelated alert text', () => expect(judgeLogin({ ...base, errorText: 'Welcome back' })).toBe('waiting'))
  it('recognises refusals', () => expect(looksLikeRefusal('Incorrect password, try again')).toBe(true))
})
