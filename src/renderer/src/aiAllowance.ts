/** Null represents unlimited access; missing entitlement data is not yet usable. */
export function aiVideosLeft(usage?: { aiVideosLeft: number | null } | null): number | null {
  return usage?.aiVideosLeft === null ? null : usage?.aiVideosLeft ?? 0
}
