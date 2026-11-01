import { useEffect, useRef, useState } from 'react'
import { DEFAULT_POLICY, PLAN_IDS, type PlanId, type PlanPolicy } from '@shared/plans'
import { api, type AccountResult, type AccountState } from '../api'

/**
 * The welcome screen people see before signing in: what the app makes, the
 * four plans, what every plan includes, and a one-click way in. Prices and
 * numbers come live from the licence server (the superadmin edits them), with
 * the shipped defaults as a fallback when offline.
 */

type Plans = Record<PlanId, PlanPolicy>

const MODEL_NAME: Record<string, string> = { 'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-terra': 'GPT-6.1 Terra', 'gpt-6.1-sol': 'GPT-6.1 Sol' }
export const modelName = (id: string) => MODEL_NAME[id] ?? id

export const PLAN_LOOK: Record<PlanId, { icon: string; tag: string; blurb: string; accent: string; soft: string; button: string; ring: string }> = {
  free: { icon: '🌱', tag: 'Try everything', blurb: 'Explore the studio and make your first AI videos.', accent: 'text-mint', soft: 'bg-mint-soft', button: 'bg-ink text-white shadow-[0_3px_0_#15092f]', ring: 'ring-ink/10' },
  plus: { icon: '⭐', tag: 'For regular creators', blurb: 'A steady flow of AI videos with richer pictures and music.', accent: 'text-sky', soft: 'bg-sky-soft', button: 'bg-sky text-white shadow-[0_3px_0_#0b7cc0]', ring: 'ring-sky/40' },
  pro: { icon: '🚀', tag: 'For serious creators', blurb: 'Smarter directing and the best pictures, voices and clips.', accent: 'text-grape', soft: 'bg-grape-soft', button: 'bg-gradient-to-r from-grape to-berry text-white shadow-[0_3px_0_#5b21b6]', ring: 'ring-grape' },
  ultra: { icon: '👑', tag: 'For studios & teams', blurb: 'Our strongest director and the most AI videos.', accent: 'text-berry', soft: 'bg-berry-soft', button: 'bg-berry text-white shadow-[0_3px_0_#c2185b]', ring: 'ring-berry/40' }
}

const MEDIA_LINE: Record<PlanId, string> = {
  free: 'Essential AI pictures & voice',
  plus: 'Better pictures, voices & AI music',
  pro: 'Best pictures, voices & music',
  ultra: 'Best pictures, voices & music'
}

function planPoints(id: PlanId, p: PlanPolicy): Array<{ on: boolean; text: string }> {
  return [
    { on: true, text: 'Unlimited programmatic videos' },
    { on: true, text: `Directed by ${modelName(p.chatModel)}` },
    { on: true, text: MEDIA_LINE[id] },
    { on: p.clipsPerVideo > 0, text: p.clipsPerVideo ? `${p.clipsPerVideo} animated clip${p.clipsPerVideo > 1 ? 's' : ''} per video` : 'Animated clips' },
    { on: true, text: `AI videos up to ${p.maxVideoSeconds >= 120 ? `${Math.round(p.maxVideoSeconds / 60)} min` : `${p.maxVideoSeconds}s`}` }
  ]
}

/** the four plan cards; `current` marks the account's plan, `onPick` adds a button per card */
export function PricingCards({ plans, current, onPick, pickLabel }: { plans: Plans; current?: PlanId; onPick?: (id: PlanId) => void; pickLabel?: (id: PlanId) => string }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {PLAN_IDS.map((id) => {
        const p = plans[id]
        const look = PLAN_LOOK[id]
        const featured = id === 'pro'
        const mine = current === id
        return (
          <div
            key={id}
            className={`relative flex flex-col rounded-3xl bg-white p-5 ring-2 transition-transform duration-200 hover:-translate-y-1 ${mine ? 'ring-mint' : look.ring} ${featured ? 'shadow-[0_24px_50px_-24px_rgba(124,58,237,0.55)]' : 'shadow-[0_12px_30px_-22px_rgba(43,29,78,0.4)]'}`}
          >
            {(featured || mine) && (
              <span className={`absolute -top-3 left-5 rounded-full px-3 py-0.5 text-[11px] font-black uppercase tracking-wide text-white ${mine ? 'bg-mint' : 'bg-gradient-to-r from-grape to-berry'}`}>
                {mine ? 'Your plan' : 'Most popular'}
              </span>
            )}
            <div className="flex items-center gap-2">
              <span className={`flex h-9 w-9 items-center justify-center rounded-xl text-lg ${look.soft}`}>{look.icon}</span>
              <div>
                <div className="text-base font-black leading-tight">{p.label}</div>
                <div className={`text-[11px] font-bold ${look.accent}`}>{look.tag}</div>
              </div>
            </div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="text-4xl font-black tracking-tight">{p.priceUsdMonthly ? `$${p.priceUsdMonthly}` : '$0'}</span>
              <span className="text-xs font-bold text-ink/45">/ month</span>
            </div>
            <p className="mt-1 min-h-[34px] text-[12px] leading-snug text-ink/60">{look.blurb}</p>
            <div className={`mt-4 rounded-2xl px-3 py-2.5 ${look.soft}`}>
              <div className="text-2xl font-black leading-none">{p.aiVideosPerMonth ?? '∞'}</div>
              <div className="mt-0.5 text-[11px] font-bold text-ink/65">AI videos every month</div>
            </div>
            <ul className="mt-4 flex-1 space-y-2 text-[12.5px]">
              {planPoints(id, p).map((pt) => (
                <li key={pt.text} className={`flex gap-2 ${pt.on ? '' : 'text-ink/35 line-through decoration-ink/20'}`}>
                  <span className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-black ${pt.on ? `${look.soft} ${look.accent}` : 'bg-ink/5 text-ink/30'}`}>{pt.on ? '✓' : '–'}</span>
                  {pt.text}
                </li>
              ))}
            </ul>
            {onPick && !mine && (
              <button onClick={() => onPick(id)} className={`mt-5 rounded-2xl py-2.5 text-sm font-black transition-transform active:translate-y-0.5 ${look.button}`}>
                {pickLabel ? pickLabel(id) : id === 'free' ? 'Start free' : `Get ${p.label}`}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

const FEATURES: Array<{ icon: string; title: string; text: string; tone: string }> = [
  { icon: '✍️', title: 'Prompt in, video out', text: 'Describe an idea in a sentence. The studio writes the script, plans every scene and renders a finished MP4.', tone: 'bg-grape-soft' },
  { icon: '🎬', title: 'Directed, not templated', text: 'A film director and a director per scene pick the right visual for each beat: counters, timelines, quotes, maps.', tone: 'bg-berry-soft' },
  { icon: '🖼️', title: 'Painted backdrops with depth', text: 'AI-painted pictures get a real 2.5D camera move, so stills feel like footage.', tone: 'bg-sunny-soft' },
  { icon: '🎞️', title: 'Animated clips', text: 'The engine picks the few moments where real motion matters and turns them into moving clips.', tone: 'bg-sky-soft' },
  { icon: '🎙️', title: 'Narration & captions', text: 'Natural voices with word-synced captions, mixed under a soundtrack scored to your cuts.', tone: 'bg-mint-soft' },
  { icon: '📱', title: 'Every platform shape', text: 'TikTok, Reels, Shorts, YouTube and Facebook: the right size, length and pacing for each.', tone: 'bg-coral-soft' },
  { icon: '✂️', title: 'Edit your own footage', text: 'Point it at your recordings. It finds the best moments and cuts several shorts with music.', tone: 'bg-grape-soft' },
  { icon: '🛠️', title: 'Change any scene', text: 'Tell a scene what to change, reorder the timeline, repaint a picture. Edits never use another AI video.', tone: 'bg-berry-soft' },
  { icon: '♻️', title: 'A library that saves you', text: 'Pictures, voices and music are kept and reused across videos, so nothing is paid for twice.', tone: 'bg-sunny-soft' }
]

function Compare({ plans }: { plans: Plans }) {
  const rows: Array<[string, (p: PlanPolicy, id: PlanId) => string]> = [
    ['Programmatic videos', () => 'Unlimited'],
    ['AI videos a month', (p) => (p.aiVideosPerMonth === null ? 'Unlimited' : String(p.aiVideosPerMonth))],
    ['Writes & directs with', (p) => modelName(p.chatModel)],
    ['Pictures, voices & music', (_p, id) => MEDIA_LINE[id]],
    ['Animated clips per video', (p) => (p.clipsPerVideo ? String(p.clipsPerVideo) : '—')],
    ['Longest AI video', (p) => (p.maxVideoSeconds >= 120 ? `${Math.round(p.maxVideoSeconds / 60)} min` : `${p.maxVideoSeconds}s`)],
    ['Edit footage, timeline, library', () => '✓'],
    ['Price', (p) => (p.priceUsdMonthly ? `$${p.priceUsdMonthly}/mo` : 'Free')]
  ]
  return (
    <div className="overflow-hidden rounded-3xl bg-white ring-2 ring-ink/5">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="bg-ink/[0.03]">
            <th className="px-5 py-3 text-xs font-bold text-ink/50">Compare plans</th>
            {PLAN_IDS.map((id) => (
              <th key={id} className={`px-4 py-3 text-sm font-black ${id === 'pro' ? 'text-grape' : ''}`}>
                {PLAN_LOOK[id].icon} {plans[id].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, cell]) => (
            <tr key={label} className="border-t border-ink/5">
              <td className="px-5 py-2.5 font-semibold text-ink/70">{label}</td>
              {PLAN_IDS.map((id) => (
                <td key={id} className={`px-4 py-2.5 ${id === 'pro' ? 'bg-grape-soft/40 font-bold' : ''}`}>
                  {cell(plans[id], id)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-5 w-5" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}

type Devices = NonNullable<Extract<AccountResult, { ok: false }>['devices']>

function AuthCard({ status, onDone, onSkip }: { status: AccountState; onDone: (s: AccountState) => void; onSkip: () => void }) {
  const [mode, setMode] = useState<'signup' | 'signin'>('signup')
  const [showEmail, setShowEmail] = useState(false)
  const [email, setEmail] = useState(status.email)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'' | 'google' | 'email'>('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [devices, setDevices] = useState<Devices>([])

  const handle = (r: AccountResult) => {
    if (r.ok) return onDone(r.status)
    setError(r.error)
    if (r.code === 'device_limit' && r.devices) setDevices(r.devices)
  }
  const google = async () => {
    setBusy('google')
    setError('')
    setNote('')
    try {
      handle(await api.account.google())
    } finally {
      setBusy('')
    }
  }
  const submit = async () => {
    setBusy('email')
    setError('')
    setNote('')
    try {
      handle(mode === 'signup' ? await api.account.signUp(email, password) : await api.account.signIn(email, password))
    } finally {
      setBusy('')
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
    <div className="rounded-[28px] bg-white p-6 shadow-[0_30px_70px_-30px_rgba(124,58,237,0.55)] ring-2 ring-ink/5">
      <div className="text-lg font-black">Start free in one click</div>
      <p className="mt-1 text-[13px] text-ink/60">No card. No licence key. 3 AI videos every month, unlimited programmatic videos.</p>

      {busy === 'google' ? (
        <div className="mt-5 rounded-2xl bg-grape-soft p-4 text-center text-[13px]">
          <div className="pulse-dot mx-auto mb-2 h-2.5 w-2.5 rounded-full bg-grape" />
          <b>Finish signing in with Google in your browser.</b>
          <div className="mt-1 text-ink/60">We'll bring you straight back here.</div>
          <button className="mt-3 text-xs font-bold text-grape hover:underline" onClick={() => void api.account.cancelGoogle()}>
            Cancel
          </button>
        </div>
      ) : (
        <button onClick={google} disabled={Boolean(busy)} className="mt-5 flex w-full items-center justify-center gap-3 rounded-2xl border-2 border-ink/10 bg-white py-3 text-sm font-black shadow-[0_3px_0_rgba(43,29,78,0.08)] transition-all hover:-translate-y-0.5 hover:border-grape/50 active:translate-y-0.5 disabled:opacity-50">
          <GoogleIcon /> Continue with Google
        </button>
      )}

      <div className="my-4 flex items-center gap-3 text-[11px] font-bold uppercase tracking-wider text-ink/35">
        <span className="h-px flex-1 bg-ink/10" /> or <span className="h-px flex-1 bg-ink/10" />
      </div>

      {!showEmail ? (
        <button onClick={() => setShowEmail(true)} className="w-full rounded-2xl bg-ink/5 py-2.5 text-sm font-bold text-ink/70 hover:bg-ink/10">
          ✉️ Use email and password
        </button>
      ) : (
        <div className="slide-up">
          <div className="flex gap-1 rounded-xl bg-ink/5 p-1 text-[13px] font-bold">
            {(['signup', 'signin'] as const).map((m) => (
              <button key={m} onClick={() => (setMode(m), setError(''))} className={`flex-1 rounded-lg py-1.5 ${mode === m ? 'bg-white shadow-sm' : 'text-ink/55'}`}>
                {m === 'signup' ? 'New account' : 'I have an account'}
              </button>
            ))}
          </div>
          <form
            className="mt-3 space-y-2.5"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <input className="field w-full px-3 py-2.5 text-sm" type="email" placeholder="you@example.com" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="field w-full px-3 py-2.5 text-sm" type="password" placeholder={mode === 'signup' ? 'Password (8+ characters)' : 'Password'} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} minLength={mode === 'signup' ? 8 : undefined} required />
            <button type="submit" disabled={Boolean(busy)} className="btn-primary w-full !py-2.5 !text-sm">
              {busy === 'email' ? 'One moment…' : mode === 'signup' ? 'Create my free account' : 'Sign in'}
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
        </div>
      )}

      {error && <div className="pop-in mt-3 rounded-xl bg-coral-soft px-3 py-2 text-xs font-semibold text-coral">⚠️ {error}</div>}
      {note && <div className="mt-3 rounded-xl bg-mint-soft px-3 py-2 text-xs font-semibold text-mint">{note}</div>}
      {devices.length > 0 && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-bold text-ink/60">This account is on its computer limit. Free one to sign in here:</div>
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

      <button onClick={onSkip} className="mt-5 w-full text-center text-xs font-bold text-ink/45 hover:text-ink hover:underline">
        Skip for now — programmatic videos only
      </button>
    </div>
  )
}

export function AccountGate({ status, onDone, onSkip }: { status: AccountState; onDone: (s: AccountState) => void; onSkip: () => void }) {
  const [plans, setPlans] = useState<Plans>(DEFAULT_POLICY.plans)
  const [trialDays, setTrialDays] = useState(DEFAULT_POLICY.trial.days)
  const top = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void api.account.plans().then((live) => {
      if (live?.plans) setPlans(live.plans)
      if (live?.trial) setTrialDays(live.trial.days)
    })
  }, [])
  const toTop = () => top.current?.scrollTo({ top: 0, behavior: 'smooth' })

  return (
    <div ref={top} className="page-bg h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 pb-16 pt-10">
        {/* hero */}
        <section className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_400px]">
          <div className="slide-up">
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-bold text-ink/70 shadow-sm ring-1 ring-ink/5">
              <span className="h-2 w-2 rounded-full bg-mint" /> Free plan · no card · no licence key
            </span>
            <h1 className="mt-5 text-5xl font-black leading-[1.05] tracking-tight">
              Type an idea.
              <br />
              <span className="bg-gradient-to-r from-grape via-berry to-sunny bg-clip-text text-transparent">Get a video that's ready to post.</span>
            </h1>
            <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-ink/65">
              VideoGen Studio writes, directs, paints, voices and renders short videos for TikTok, Reels, Shorts and YouTube. Make <b className="text-ink">programmatic videos free, forever</b>, and AI videos on any plan.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {['🎵 TikTok', '📸 Reels', '▶️ Shorts', '📺 YouTube', '👍 Facebook'].map((t) => (
                <span key={t} className="rounded-full bg-white/80 px-3 py-1 text-xs font-bold text-ink/70 ring-1 ring-ink/5">
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-8 grid max-w-xl grid-cols-3 gap-3">
              {[
                ['1', 'Describe it', 'One sentence is enough'],
                ['2', 'Watch it get made', 'Scenes appear as they render'],
                ['3', 'Post it', 'A platform-ready MP4']
              ].map(([n, t, s]) => (
                <div key={n} className="rounded-2xl bg-white/70 p-3 ring-1 ring-ink/5">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gradient-to-br from-grape to-berry text-[11px] font-black text-white">{n}</div>
                  <div className="mt-2 text-[13px] font-black">{t}</div>
                  <div className="text-[11px] text-ink/55">{s}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="pop-in">
            <AuthCard status={status} onDone={onDone} onSkip={onSkip} />
          </div>
        </section>

        {/* pricing */}
        <section className="mt-20">
          <div className="text-center">
            <div className="text-xs font-black uppercase tracking-[0.2em] text-grape">Plans</div>
            <h2 className="mt-2 text-3xl font-black tracking-tight">Simple plans. Programmatic videos free on all of them.</h2>
            <p className="mt-2 text-[14px] text-ink/60">
              An AI video counts once a month — editing it later is included.{trialDays > 0 ? ` New accounts try Plus free for ${trialDays} days.` : ''}
            </p>
          </div>
          <div className="mt-10">
            <PricingCards
              plans={plans}
              onPick={(id) => (id === 'free' ? toTop() : void api.account.contactSales(plans[id].label))}
              pickLabel={(id) => (id === 'free' ? 'Start free' : `Get ${plans[id].label}`)}
            />
          </div>
          <p className="mt-4 text-center text-[12px] text-ink/50">Paid plans come with a licence key. Create your free account, then enter the key in Settings → Your plan.</p>
        </section>

        {/* features */}
        <section className="mt-20">
          <div className="text-center">
            <div className="text-xs font-black uppercase tracking-[0.2em] text-berry">What's inside</div>
            <h2 className="mt-2 text-3xl font-black tracking-tight">A whole video team, on your computer</h2>
          </div>
          <div className="mt-10 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="rounded-3xl bg-white p-5 ring-2 ring-ink/5 transition-transform duration-200 hover:-translate-y-1">
                <div className={`flex h-11 w-11 items-center justify-center rounded-2xl text-xl ${f.tone}`}>{f.icon}</div>
                <div className="mt-3 text-[15px] font-black">{f.title}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-ink/60">{f.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* compare */}
        <section className="mt-20">
          <Compare plans={plans} />
        </section>

        {/* closing */}
        <section className="mt-16 rounded-[32px] bg-gradient-to-r from-grape via-berry to-sunny p-[2px]">
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-[30px] bg-white px-8 py-7">
            <div>
              <div className="text-2xl font-black tracking-tight">Your first video is a minute away.</div>
              <div className="text-[14px] text-ink/60">Free account, no card, no licence key.</div>
            </div>
            <button onClick={toTop} className="btn-primary !rounded-2xl !px-6 !py-3 !text-base">
              Start free ✨
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
