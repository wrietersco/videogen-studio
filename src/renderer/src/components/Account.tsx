import { useEffect, useState } from 'react'
import { DEFAULT_POLICY, type PlanId, type PlanPolicy } from '@shared/plans'
import { directorLabel, modelName, PricingCards } from './Welcome'
import { api, type AccountResult, type AccountState } from '../api'

/**
 * Sign-in, onboarding and the plan. The server decides what an account may
 * do; these screens only show its answer and send the person's choices.
 */

/**
 * Who sees what's under the hood (model names, provider costs, API keys):
 * superadmins, and licences the superadmin allowed to run on their own keys
 * (they pay their provider, so they see the bill). Everyone else sees plans,
 * videos and counts, never models or dollars.
 */
export function seesInternals(status: AccountState | null): boolean {
  return Boolean(status?.view?.account.superadmin) || status?.mode === 'own-keys'
}

export function useInsider(): boolean {
  const [status] = useAccount()
  return seesInternals(status)
}

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

// ---------------- the plan (Settings) ----------------

export function PlanPanel({ status, onChange }: { status: AccountState; onChange: (s: AccountState) => void }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const view = status.view
  const ent = view?.entitlements
  const [plans, setPlans] = useState<Record<PlanId, PlanPolicy>>(DEFAULT_POLICY.plans)
  useEffect(() => {
    void api.account.plans().then((live) => live?.plans && setPlans(live.plans))
  }, [])

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
                {ent.superadmin ? <>Superadmin · every model, no limits · writes and directs with <b>{modelName(ent.chatModel)}</b> · </> : <><b>{directorLabel(ent.chatModel)}</b> · </>}{ent.clipsPerVideo ? `${ent.clipsPerVideo} animated clip${ent.clipsPerVideo > 1 ? 's' : ''} per video` : 'no animated clips'} · up to {ent.maxVideoSeconds}s · programmatic videos unlimited
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

      {ent && <PricingCards plans={plans} current={ent.superadmin ? undefined : ent.soldPlan} onPick={(id) => void api.account.contactSales(plans[id].label)} pickLabel={(id) => (id === 'free' ? 'Switch to Free' : `Get ${plans[id].label}`)} />}

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
