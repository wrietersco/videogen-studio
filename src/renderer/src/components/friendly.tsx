/**
 * Turns raw engine / provider errors into plain words a non-technical person can act on.
 * `fix` says exactly where to go; `settings` means an "Open Settings" button helps.
 */
export type FriendlyError = { title: string; fix: string; settings: boolean; raw: string }

const PROVIDERS: Array<[RegExp, string]> = [
  [/openai|gpt/i, 'OpenAI'],
  [/anthropic|claude/i, 'Anthropic (Claude)'],
  [/gemini|google/i, 'Google Gemini'],
  [/eleven/i, 'ElevenLabs'],
  [/pexels/i, 'Pexels'],
  [/pixabay/i, 'Pixabay']
]

export function friendlyError(raw: string): FriendlyError {
  if (/isometric (?:animation|film|scene)|reviewed isometric animation/i.test(raw))
    return { title: 'The isometric animation could not be completed', fix: 'The app could not produce or verify every animated scene. In My videos, choose Finish it to reuse completed scenes; remaining work may incur provider charges. Your selected models and providers stay the same.', settings: false, raw }
  if (/Planner produced an invalid VideoSpec/i.test(raw))
    return { title: 'The video plan could not be completed', fix: 'The planner returned an invalid plan after retrying. Try again; your selected models and providers do not need to be changed.', settings: false, raw }
  const who = PROVIDERS.find(([re]) => re.test(raw))?.[1]
  const keyPlace = `Settings → 🔑 Your keys${who ? ` → ${who}` : ''}`
  if (/add (an?|your)? ?.*key|no api key|missing.*key|api key.*(not set|missing|required)|key is not set/i.test(raw))
    return { title: `🔑 ${who ? `A ${who} key is` : 'An API key is'} needed`, fix: `Paste your key in ${keyPlace}, then try again. Or pick “Free engine” in Settings to try the app at no cost.`, settings: true, raw }
  if (/\b401\b|\b403\b|invalid.*key|incorrect api key|rejected the key|unauthori[sz]ed|permission denied/i.test(raw))
    return { title: `🔑 ${who ?? 'The provider'} didn't accept your key`, fix: `It may be mistyped or switched off. Paste a fresh key in ${keyPlace}.`, settings: true, raw }
  if (/\b429\b|quota|rate.?limit|insufficient.*(funds|credit|balance)|billing/i.test(raw))
    return { title: `💳 ${who ?? 'The provider'} says you're out of credit or going too fast`, fix: `Check your balance on the ${who ?? 'provider'} website, wait a minute, then try again.`, settings: false, raw }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|fetch failed|socket hang up/i.test(raw))
    return { title: '📡 Couldn’t reach the internet', fix: 'Check your connection and try again.', settings: false, raw }
  if (/ENOSPC|no space/i.test(raw))
    return { title: '💾 Your disk is full', fix: 'Free up some space (videos need a few hundred MB while rendering), then try again.', settings: false, raw }
  return { title: '😕 Something went wrong', fix: 'Try again — if it keeps happening, switch engines in Settings.', settings: false, raw }
}

export function ErrorCard({ error, onOpenSettings, onRetry }: { error: string; onOpenSettings?: () => void; onRetry?: () => void }) {
  const f = friendlyError(error)
  return (
    <div className="slide-up rounded-2xl border-2 border-coral/30 bg-coral-soft p-4">
      <div className="text-sm font-black text-ink">{f.title}</div>
      <div className="mt-1 text-sm text-ink/75">{f.fix}</div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {f.settings && onOpenSettings && (
          <button onClick={onOpenSettings} className="btn-primary">
            ⚙️ Open Settings
          </button>
        )}
        {onRetry && (
          <button onClick={onRetry} className="btn-ghost">
            🔁 Try again
          </button>
        )}
      </div>
      <details className="mt-2 text-xs text-ink/50">
        <summary className="cursor-pointer select-none">Technical details</summary>
        <div className="mt-1 break-all font-mono">{f.raw}</div>
      </details>
    </div>
  )
}
