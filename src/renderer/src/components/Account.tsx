import { useEffect, useState } from 'react'
import { DEFAULT_POLICY, PLAN_IDS, type PlanId } from '@shared/plans'
import { api, type AccountResult, type AccountState } from '../api'

/**
 * Sign-in, onboarding and the plan. The server decides what an account may
 * do; these screens only show its answer and send the person's choices.
 */

export function useAccount(): [AccountState | null, (s: AccountState) => void] {
  const [status, setStatus] = useState<AccountState | null>(null)
  useEffect(() => {
    void api.account.status().then(setStatus)
    return api.account.onChange(setStatus)
  }, [])
  return [status, setStatus]
}

const PLAN_STYLE: Record<PlanId, { icon: string; ring: string; chip: string }> = {
  free: { icon: '🌱', ring: 'border-ink/10', chip: 'bg-ink/5 text-ink/70' },
  plus: { icon: '⭐', ring: 'border-sky/50', chip: 'bg-sky text-white' },
  pro: { icon: '🚀', ring: 'border-grape/60', chip: 'bg-grape text-white' },
  ultra: { icon: '👑', ring: 'border-berry/60', chip: 'bg-berry text-white' }
}

const MODEL_NAME: Record<string, string> = { 'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6.1-sol': 'GPT-6.1 Sol' }
const modelName = (id: string) => MODEL_NAME[id] ?? id

type Prices = Record<PlanId, { label: string; priceUsdMonthly: number; aiVideosPerMonth: number | null; chatModel: string; clipsPerVideo: number }>

function fallbackPrices(): Prices {
  return Object.fromEntries(PLAN_IDS.map((id) => {
    const p = DEFAULT_POLICY.plans[id]
    return [id, { label: p.label, priceUsdMonthly: p.priceUsdMonthly, aiVideosPerMonth: p.aiVideosPerMonth, chatModel: p.chatModel, clipsPerVideo: p.clipsPerVideo }]
  })) as Prices
}

function planLines(id: PlanId, p: Prices[PlanId]): string[] {
  const media = id === 'free' ? 'Basic AI pictures and voice' : id === 'plus' ? 'Better pictures, voices and music' : 'The best pictures, voices and music'
  return [
    'Unlimited programmatic videos',
    `${p.aiVideosPerMonth ?? 'Unlimited'} AI videos a month on ${modelName(p.chatModel)}`,
    media,
    p.clipsPerVideo ? `${p.clipsPerVideo} animated clip${p.clipsPerVideo > 1 ? 's' : ''} per video` : 'Painted stills, no animated clips'
  ]
}

export function PlanCards({ prices, current, onPick }: { prices: Prices; current?: PlanId; onPick?: (id: PlanId) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {PLAN_IDS.map((id) => {
        const p = prices[id]
        const on = current === id
        return (
          <div key={id} className={`flex flex-col rounded-2xl border-2 bg-white p-4 ${on ? 'border-mint shadow-[0_3px_0_#0b8a64]' : PLAN_STYLE[id].ring}`}>
            <div className="flex items-center justify-between">
              <span className="text-base font-black">
                {PLAN_STYLE[id].icon} {p.label}
              </span>
              {on && <span className="rounded-full bg-mint px-2 py-0.5 text-[10px] font-black text-white">YOUR PLAN</span>}
            </div>
            <div className="mt-1 text-2xl font-black">
              {p.priceUsdMonthly ? `$${p.priceUsdMonthly}` : 'Free'}
              {p.priceUsdMonthly ? <span className="text-xs font-bold text-ink/50"> / month</span> : null}
            </div>
            <ul className="mt-2 flex-1 space-y-1 text-[12px] text-ink/75">
              {planLines(id, p).map((l) => (
                <li key={l}>✓ {l}</li>
              ))}
            </ul>
            {onPick && !on && id !== 'free' && (
              <button onClick={() => onPick(id)} className={`mt-3 rounded-xl px-3 py-1.5 text-xs font-black ${PLAN_STYLE[id].chip}`}>
                Get {p.label}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------- onboarding (signed out) ----------------

export function AccountGate({ status, onDone, onSkip }: { status: AccountState; onDone: (s: AccountState) => void; onSkip: () => void }) {
  const [mode, setMode] = useState<'signup' | 'signin'>('signup')
  const [email, setEmail] = useState(status.email)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [devices, setDevices] = useState<NonNullable<Extract<AccountResult, { ok: false }>['devices']>>([])

  const handle = (r: AccountResult) => {
    if (r.ok) return onDone(r.status)
    setError(r.error)
    if (r.code === 'device_limit' && r.devices) setDevices(r.devices)
  }
  const submit = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      handle(mode === 'signup' ? await api.account.signUp(email, password) : await api.account.signIn(email, password))
    } finally {
      setBusy(false)
    }
  }
  const removeDevice = async (id: string) => {
    const r = await api.account.removeDevice(id)
    if (!r.ok) return setError(r.error)
    setDevices([])
    setError('')
    handle(await api.account.refresh())
  }

  return (
    <div className="page-bg flex h-full overflow-y-auto">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-8 p-10 lg:grid-cols-[1fr_380px]">
        <div>
          <h1 className="text-3xl font-black tracking-tight">🎬 Welcome to VideoGen Studio</h1>
          <p className="mt-2 max-w-xl text-[15px] text-ink/65">
            Make platform-ready videos from a sentence. <b>Programmatic videos are free and unlimited</b> on every plan. AI videos are planned, painted and voiced by AI — every account gets a few free each month.
          </p>
          <div className="mt-6">
            <PlanCards prices={fallbackPrices()} />
          </div>
          <p className="mt-3 text-[12px] text-ink/50">Paid plans come with a licence key. Create your free account first, then enter the key in Settings → Your plan.</p>
        </div>

        <div className="card self-start p-6">
          <div className="flex gap-1 rounded-xl bg-ink/5 p-1 text-sm font-bold">
            {(['signup', 'signin'] as const).map((m) => (
              <button key={m} onClick={() => (setMode(m), setError(''))} className={`flex-1 rounded-lg py-1.5 ${mode === m ? 'bg-white shadow-sm' : 'text-ink/55'}`}>
                {m === 'signup' ? 'Create free account' : 'Sign in'}
              </button>
            ))}
          </div>
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <label className="block text-xs font-bold text-ink/60">
              Email
              <input className="field mt-1 w-full px-3 py-2 text-sm" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className="block text-xs font-bold text-ink/60">
              Password {mode === 'signup' && <span className="font-normal">(8 characters or more)</span>}
              <input className="field mt-1 w-full px-3 py-2 text-sm" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === 'signup' ? 8 : undefined} required />
            </label>
            <button type="submit" disabled={busy} className="btn-primary w-full justify-center py-2">
              {busy ? 'One moment…' : mode === 'signup' ? 'Create my free account' : 'Sign in'}
            </button>
          </form>
          {mode === 'signin' && (
            <button
              className="mt-2 text-xs font-bold text-grape hover:underline"
              onClick={async () => {
                if (!email.trim()) return setError('Enter your email first.')
                const r = await api.account.resetPassword(email)
                if (r.ok) setNote('We sent a password reset link to your email.')
                else setError(r.error)
              }}
            >
              Forgot password?
            </button>
          )}
          {error && <div className="mt-3 rounded-xl bg-coral-soft px-3 py-2 text-xs font-semibold text-coral">⚠️ {error}</div>}
          {note && <div className="mt-3 rounded-xl bg-mint-soft px-3 py-2 text-xs font-semibold text-mint">{note}</div>}
          {devices.length > 0 && (
            <div className="mt-3 space-y-2">
              <div className="text-xs font-bold text-ink/60">Free a computer to sign in here:</div>
              {devices.map((d) => (
                <div key={d.id} className="flex items-center justify-between rounded-xl border-2 border-ink/10 px-3 py-2 text-xs">
                  <span>
                    <b>{d.name || 'Computer'}</b> <span className="text-ink/50">· last used {d.lastSeenAt?.slice(0, 10)}</span>
                  </span>
                  <button className="font-bold text-coral hover:underline" onClick={() => removeDevice(d.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-5 border-t-2 border-ink/5 pt-4 text-center">
            <button onClick={onSkip} className="text-xs font-bold text-ink/50 hover:text-ink hover:underline">
              Skip for now — make programmatic videos only
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------- the plan (Settings) ----------------

export function PlanPanel({ status, onChange }: { status: AccountState; onChange: (s: AccountState) => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const view = status.view
  const ent = view?.entitlements

  const run = async (fn: () => Promise<AccountResult>, ok?: string) => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const r = await fn()
      if (r.ok) {
        onChange(r.status)
        if (ok) setNote(ok)
      } else setError(r.error)
    } finally {
      setBusy(false)
    }
  }

  if (!status.signedIn) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>You are not signed in, so only programmatic videos are on. Sign in for free AI videos every month.</span>
        <button className="btn-primary" onClick={() => window.dispatchEvent(new Event('videogen:sign-in'))}>
          Sign in or create an account
        </button>
      </div>
    )
  }

  const used = ent?.usage.aiVideosUsed ?? 0
  const total = ent?.aiVideosPerMonth
  const pct = total ? Math.min(100, (used / total) * 100) : 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-64 flex-1">
          <div className="text-xs font-bold text-ink/55">{status.email}</div>
          <div className="mt-1 text-2xl font-black">
            {ent ? `${PLAN_STYLE[ent.plan].icon} ${ent.label}` : 'Loading your plan…'}
            {ent?.trial.active && <span className="ml-2 rounded-full bg-sunny px-2 py-0.5 align-middle text-[11px] font-black">TRIAL · {ent.trial.daysLeft} days left</span>}
          </div>
          {ent && (
            <div className="mt-2 max-w-md">
              <div className="flex justify-between text-xs font-bold">
                <span>
                  {used} of {total ?? '∞'} AI videos used this month
                </span>
                <span className="text-ink/50">resets {ent.usage.resetsAt.slice(0, 10)}</span>
              </div>
              {total !== null && (
                <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-ink/10">
                  <div className={`h-full rounded-full ${pct >= 100 ? 'bg-coral' : 'bg-mint'}`} style={{ width: `${pct}%` }} />
                </div>
              )}
              <div className="mt-2 text-[12px] text-ink/60">
                Writes and directs with <b>{modelName(ent.chatModel)}</b> · {ent.clipsPerVideo ? `${ent.clipsPerVideo} animated clip${ent.clipsPerVideo > 1 ? 's' : ''} per video` : 'no animated clips'} · up to {ent.maxVideoSeconds}s · programmatic videos unlimited
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" disabled={busy} onClick={() => run(() => api.account.refresh(), '✓ Up to date')}>
            Refresh
          </button>
          <button className="btn-ghost" disabled={busy} onClick={() => run(() => api.account.signOut())}>
            Sign out
          </button>
        </div>
      </div>

      {status.offline && <div className="rounded-xl bg-sunny-soft px-3 py-2 text-xs font-semibold">You are offline. This is your plan as of the last check; AI videos need a connection.</div>}
      {ent?.access.reason && <div className="rounded-xl bg-sunny-soft px-3 py-2 text-xs font-semibold">⚠️ {ent.access.reason}</div>}
      {!status.emailVerified && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-sunny/60 bg-sunny-soft p-3 text-xs">
          <span>
            📧 <b>Verify your email</b> to unlock AI videos. We sent a link to {status.email}.
          </span>
          <button className="btn-primary" disabled={busy} onClick={() => run(() => api.account.refresh(), '✓ Checked')}>
            I've verified it
          </button>
          <button
            className="btn-ghost"
            onClick={async () => {
              const r = await api.account.resendVerification()
              if (r.ok) setNote('Sent again. Check your inbox and spam folder.')
              else setError(r.error)
            }}
          >
            Send the link again
          </button>
        </div>
      )}
      {ent && !ent.aiAllowed && status.emailVerified && <div className="rounded-xl bg-coral-soft px-3 py-2 text-xs font-semibold text-coral">{ent.aiBlockedReason}</div>}

      <div className="rounded-2xl border-2 border-ink/10 bg-white p-4">
        <div className="text-sm font-black">🔑 Licence key</div>
        {view?.license ? (
          <div className="mt-1 flex flex-wrap items-center gap-3 text-xs">
            <span>
              {view.license.customerName ? `${view.license.customerName} · ` : ''}
              {view.license.keyHint} · {view.license.seats} seat{view.license.seats === 1 ? '' : 's'}
              {view.license.paidThrough ? ` · paid through ${view.license.paidThrough.slice(0, 10)}` : ''}
            </span>
            <button className="font-bold text-coral hover:underline" disabled={busy} onClick={() => confirm('Leave this licence and go back to Free? Its seat becomes free for someone else.') && run(() => api.account.leave(), 'You are on Free now.')}>
              Leave licence
            </button>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            <input className="field min-w-0 flex-1 px-3 py-2 font-mono text-xs" placeholder="vg_live_…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && run(() => api.account.activate(key), '🎉 Licence activated')} />
            <button className="btn-primary" disabled={busy || !key.trim()} onClick={() => run(() => api.account.activate(key), '🎉 Licence activated')}>
              Activate
            </button>
          </div>
        )}
      </div>

      {error && <div className="rounded-xl bg-coral-soft px-3 py-2 text-xs font-semibold text-coral">⚠️ {error}</div>}
      {note && <div className="rounded-xl bg-mint-soft px-3 py-2 text-xs font-semibold text-mint">{note}</div>}

      {ent && <PlanCards prices={ent.prices} current={ent.soldPlan} onPick={(id) => void api.account.contactSales(ent.prices[id].label)} />}

      {view?.devices && view.devices.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs font-bold text-ink/60">Computers signed in to this account ({view.devices.length})</summary>
          <div className="mt-2 space-y-1">
            {view.devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between rounded-xl bg-ink/5 px-3 py-1.5 text-xs">
                <span>
                  <b>{d.name || 'Computer'}</b> · {d.platform} · v{d.appVersion} · last used {d.lastSeenAt?.slice(0, 10)}
                </span>
                <button className="font-bold text-coral hover:underline" onClick={() => run(() => api.account.removeDevice(d.id))}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

/** title-bar chip: the plan and how many AI videos are left */
export function PlanBadge({ status, onClick }: { status: AccountState | null; onClick: () => void }) {
  if (!status) return null
  const ent = status.view?.entitlements
  const text = !status.signedIn ? 'Sign in' : !ent ? '…' : ent.usage.aiVideosLeft === null ? `${ent.label} · unlimited AI` : `${ent.label} · ${ent.usage.aiVideosLeft} AI left`
  return (
    <button onClick={onClick} title="Your plan" className={`mr-2 rounded-full px-3 py-1 text-xs font-black ${ent ? PLAN_STYLE[ent.plan].chip : 'bg-grape text-white'}`}>
      {ent ? PLAN_STYLE[ent.plan].icon : '👤'} {text}
    </button>
  )
}
