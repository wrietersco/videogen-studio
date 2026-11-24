/** Judging whether a sign-in worked, from signals that survive slow redirects and "checking your browser" pages. */

export interface LoginSignals {
  urlBefore: string
  urlNow: string
  /** the password field is on the page and visible */
  passwordVisible: boolean
  /** a "checking your browser" page is showing: not the app, so keep waiting */
  interstitial: boolean
  /** text of a visible error/alert box, if any */
  errorText: string
  /** a sign-out / account control is on the page */
  accountControl: boolean
}

export type LoginVerdict = 'success' | 'failed' | 'waiting'

const BAD = /invalid|incorrect|wrong|failed|not (?:found|match|recogni[sz]ed|correct)|try again|denied|unauthori[sz]ed|no account|locked|too many/i

/** error text that really says the credentials were refused */
export function looksLikeRefusal(text: string): boolean {
  return BAD.test(text.trim())
}

const strip = (u: string) => {
  try {
    const x = new URL(u)
    return `${x.origin}${x.pathname.replace(/\/+$/, '')}`
  } catch {
    return u
  }
}

/** 'success' as soon as any good sign shows; 'failed' only on real evidence (an error message); otherwise 'waiting' */
export function judgeLogin(s: LoginSignals): LoginVerdict {
  if (s.interstitial) return 'waiting'
  if (s.errorText && looksLikeRefusal(s.errorText) && s.passwordVisible) return 'failed'
  if (!s.passwordVisible) return 'success'
  if (s.accountControl) return 'success'
  if (strip(s.urlNow) !== strip(s.urlBefore)) return 'success'
  return 'waiting'
}
