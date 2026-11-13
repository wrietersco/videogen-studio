import { useEffect, useState } from 'react'
import { DEFAULT_POLICY, type PlanId, type PlanPolicy } from '@shared/plans'
import { directorLabel, modelName, PricingCards } from './Welcome'
import { clampSeats, openUpgrade, upgradeOutcome } from '@shared/requests'
import { api, type AccountResult, type AccountState, type MyRequest, type RequestsResult } from '../api'

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

  const [requests, setRequests] = useState<MyRequest[]>([])
  const [seats, setSeats] = useState(1)
  const pending = openUpgrade(requests)
  const outcome = upgradeOutcome(requests)
  useEffect(() => {
    if (!status.signedIn) return
    void api.account.myRequests().then((r) => {
      if (r.ok) setRequests(r.requests)
    })
  }, [status.signedIn])
  /** an approved request changes the plan itself: pull the new view when the outcome shows up */
  useEffect(() => {
    if (outcome?.status === 'approved') void api.account.refresh().then((r) => r.ok && onChange(r.status))
  }, [outcome?.id, outcome?.status]) // eslint-disable-line react-hooks/exhaustive-deps
  const runRequests = async (fn: () => Promise<RequestsResult>, ok?: string) => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const r = await fn()
      if (r.ok) {
        setRequests(r.requests)
        if (ok) setNote(ok)
      } else setError(r.error)
    } finally {
      setBusy(false)
    }
  }

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

      {outcome && (
        <div className={`flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold ${outcome.status === 'approved' ? 'bg-mint-soft text-mint' : 'bg-sunny-soft text-ink'}`}>
          <span>
            {outcome.status === 'approved'
              ? `🎉 Your ${plans[outcome.plan ?? 'plus'].label} upgrade was approved.`
              : `Your ${plans[outcome.plan ?? 'plus'].label} request was not approved${outcome.reason ? `: ${outcome.reason}` : '.'}`}
          </span>
          <button className="btn-ghost" onClick={() => void runRequests(() => api.account.dismissRequest(outcome.id))}>
            OK
          </button>
        </div>
      )}

      {ent && (
        <PricingCards
          plans={plans}
          current={ent.superadmin ? undefined : ent.soldPlan}
          footer={(id) => {
            if (id === 'free') return null
            const waiting = pending?.plan === id ? pending : undefined
            if (waiting) {
              return (
                <div className="mt-5 space-y-1.5 text-center">
                  <div className="rounded-2xl bg-mint-soft py-2.5 text-sm font-black text-mint">Requested · waiting for approval</div>
                  <button className="text-xs font-bold text-ink/55 hover:underline" disabled={busy} onClick={() => void runRequests(() => api.account.cancelRequest(waiting.id))}>
                    Cancel request
                  </button>
                </div>
              )
            }
            return (
              <div className="mt-5 space-y-2">
                <div className="flex items-center justify-between rounded-xl bg-ink/5 px-3 py-1 text-xs font-bold">
                  <span>Seats</span>
                  <span className="flex items-center gap-2">
                    <button aria-label="Fewer seats" className="h-6 w-6 rounded-full bg-white font-black shadow-sm disabled:opacity-40" disabled={seats <= 1} onClick={() => setSeats(clampSeats(seats - 1))}>
                      -
                    </button>
                    <span className="w-5 text-center text-sm font-black">{seats}</span>
                    <button aria-label="More seats" className="h-6 w-6 rounded-full bg-white font-black shadow-sm" onClick={() => setSeats(clampSeats(seats + 1))}>
                      +
                    </button>
                  </span>
                </div>
                <button className="btn-primary w-full" disabled={busy} onClick={() => void runRequests(() => api.account.requestUpgrade(id, seats), `Request sent: ${plans[id].label}, ${seats} seat${seats === 1 ? '' : 's'}. We will email you.`)}>
                  Get {plans[id].label}
                </button>
              </div>
            )
          }}
        />
      )}

      <ContactUs />

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

// ---------------- contact us ----------------

/** a short message to the VideoGen team; it lands in their console and inbox */
export function ContactUs() {
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const send = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.account.sendMessage(subject.trim(), body.trim())
      if (r.ok) {
        setMsg({ ok: true, text: '✓ Sent. We will reply by email.' })
        setSubject('')
        setBody('')
        setOpen(false)
      } else setMsg({ ok: false, text: r.error })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border-2 border-ink/10 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-black">✉️ Contact us</div>
        {!open && (
          <button className="btn-ghost" onClick={() => setOpen(true)}>
            Write to us
          </button>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <input className="field w-full px-3 py-2 text-sm" placeholder="Subject (optional)" maxLength={120} value={subject} onChange={(e) => setSubject(e.target.value)} />
          <textarea className="field min-h-28 w-full px-3 py-2 text-sm" placeholder="How can we help?" maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={busy || !body.trim()} onClick={() => void send()}>
              Send
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {msg && <div className={`mt-2 text-xs font-semibold ${msg.ok ? 'text-mint' : 'text-coral'}`}>{msg.ok ? msg.text : `⚠️ ${msg.text}`}</div>}
    </div>
  )
}
