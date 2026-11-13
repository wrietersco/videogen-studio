import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type AppInput, type ReviewBeat, type RunEvent, type RunRecord, type SavedApp } from '../api'
import { Section, fmtDur } from '../components/ui'
import { DEFAULT_CHECKS, DEPTH_LABELS, type AppChecks, type Depth } from '@shared/appRecording'

/**
 * Record an app — one page: tell it where the app is and what the video should
 * show, press one button, and watch it explore, plan, record and produce.
 * Nothing is restricted unless you tick it or type a rule.
 */

type SignIn = 'saved' | 'self' | 'none'
interface Form {
  id?: string
  name: string
  url: string
  context: string
  document: { name: string; text: string } | null
  signIn: SignIn
  username: string
  password: string
  hasPassword: boolean
  guardrailText: string
  checks: AppChecks
  depth: Depth
  revealUsername: boolean
  mode: 'walkthrough' | 'launch'
  feature: string
  tagline: string
  closing: string
  cta: string
  targetSec: number
  useAi: boolean
  reviewFirst: boolean
  brandId: string
  styleImages: string[]
  styleVideo: string
}

const blank = (): Form => ({
  name: '', url: '', context: '', document: null, signIn: 'saved', username: '', password: '', hasPassword: false, guardrailText: '', checks: { ...DEFAULT_CHECKS }, depth: 'standard',
  revealUsername: false, mode: 'walkthrough', feature: '', tagline: 'Simple. Fast. Safe.', closing: 'Try it today', cta: 'Available now', targetSec: 44, useAi: true, reviewFirst: false, brandId: '', styleImages: [], styleVideo: ''
})

const fromApp = (a: SavedApp): Form => ({
  id: a.id, name: a.name, url: a.url, context: a.context, document: a.document ?? null, signIn: a.signIn, username: a.username ?? '', password: '', hasPassword: a.hasPassword, guardrailText: a.guardrailText,
  checks: a.checks, depth: a.depth, revealUsername: a.revealUsername, mode: a.mode, feature: a.launch?.feature ?? '', tagline: a.launch?.tagline ?? 'Simple. Fast. Safe.', closing: a.launch?.closing ?? 'Try it today',
  cta: a.launch?.cta ?? 'Available now', targetSec: a.targetSec, useAi: a.useAi, reviewFirst: a.reviewFirst, brandId: a.brandId ?? '', styleImages: a.styleImages ?? [], styleVideo: a.styleVideo ?? ''
})

const toInput = (f: Form): AppInput => ({
  id: f.id, name: f.name, url: f.url, context: f.context, document: f.document, signIn: f.signIn, username: f.username || undefined, password: f.password || undefined, guardrailText: f.guardrailText,
  checks: f.checks, depth: f.depth, revealUsername: f.revealUsername, mode: f.mode,
  launch: f.mode === 'launch' ? { feature: f.feature, tagline: f.tagline, closing: f.closing, cta: f.cta } : undefined, targetSec: f.targetSec, useAi: f.useAi, reviewFirst: f.reviewFirst, brandId: f.brandId || undefined, styleImages: f.styleImages, styleVideo: f.styleVideo || undefined
})

const STAGES: Array<{ id: string; label: string }> = [
  { id: 'explore', label: 'Exploring the app' },
  { id: 'plan', label: 'Choosing what to show' },
  { id: 'script', label: 'Writing and voicing' },
  { id: 'record', label: 'Recording' },
  { id: 'produce', label: 'Making the video' }
]

interface Live {
  runId: string
  stage: string
  message: string
  logs: string[]
  handoff: string | null
  review: { beats: ReviewBeat[]; advisory: string[]; notes: string[] } | null
  result: RunRecord | null
}

export default function RecordApp({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [apps, setApps] = useState<SavedApp[]>([])
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [ai, setAi] = useState<{ available: boolean; reason?: string }>({ available: false })
  const [form, setForm] = useState<Form>(blank)
  const [live, setLive] = useState<Live | null>(null)
  const [kits, setKits] = useState<Array<{ id: string; name: string }>>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const formRef = useRef(form)
  formRef.current = form

  const refresh = useCallback(async () => {
    const s = await api.appRec.state()
    setApps(s.apps)
    setRuns(s.runs)
    setAi(s.ai)
    if (s.current) setLive((l) => l ?? { runId: s.current!.runId, stage: 'explore', message: 'Running…', logs: [], handoff: null, review: null, result: null })
    return s
  }, [])

  useEffect(() => {
    void refresh()
    void api.brand.list().then((b) => setKits(b.kits.map((k) => ({ id: k.id, name: k.name })))).catch(() => undefined)
    return api.appRec.onEvent((e: RunEvent) => {
      if (e.kind === 'started') setLive({ runId: e.runId, stage: 'explore', message: 'Starting…', logs: [], handoff: null, review: null, result: null })
      else if (e.kind === 'stage') setLive((l) => (l && l.runId === e.runId ? { ...l, stage: e.stage, message: e.message } : l))
      else if (e.kind === 'log') setLive((l) => (l && l.runId === e.runId ? { ...l, logs: [...l.logs.slice(-40), e.message.trim()] } : l))
      else if (e.kind === 'handoff') setLive((l) => (l && l.runId === e.runId ? { ...l, handoff: e.message } : l))
      else if (e.kind === 'review') setLive((l) => (l && l.runId === e.runId ? { ...l, review: { beats: e.beats, advisory: e.advisory, notes: e.notes } } : l))
      else if (e.kind === 'done' || e.kind === 'failed' || e.kind === 'cancelled') {
        setLive((l) => (l && l.runId === e.runId ? { ...l, handoff: null, review: null, result: e.run } : l))
        void refresh()
      }
    })
  }, [refresh])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))
  const setCheck = (k: keyof AppChecks, v: boolean) => setForm((f) => ({ ...f, checks: { ...f.checks, [k]: v } }))
  const running = !!live && !live.result
  const noRestrictions = !form.checks.readOnly && !form.checks.noDelete && !form.checks.noSpend && !form.checks.noSettings

  const save = async (): Promise<SavedApp | null> => {
    setError(null)
    setSaving(true)
    try {
      const r = await api.appRec.save(toInput(formRef.current))
      if (!r.ok) {
        setError(r.error)
        return null
      }
      setForm(fromApp(r.app))
      await refresh()
      return r.app
    } finally {
      setSaving(false)
    }
  }

  const [reuse, setReuse] = useState(false)
  const pickStyle = async (kind: 'images' | 'video') => {
    const r = await api.appRec.pickStyle(kind)
    if (!r.ok) return
    if (kind === 'images') set('styleImages', [...new Set([...form.styleImages, ...r.paths])].slice(0, 3))
    else set('styleVideo', r.paths[0] ?? '')
  }

  const make = async () => {
    const app = await save()
    if (!app) return
    setLive(null)
    const r = await api.appRec.start(app.id, { reuse: reuse && !!app.hasPlan })
    if (!r.ok) setError(r.error)
  }

  const attach = async () => {
    const r = await api.appRec.attach()
    if (r.ok) set('document', r.document)
    else if (!r.cancelled) setError(r.error)
  }

  const myRuns = runs.filter((r) => r.appId === form.id)

  return (
    <div className="page-bg h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-20 pt-8">
        <h1 className="text-3xl font-black tracking-tight">
          <span className="float inline-block">🖥️</span> Record an app
        </h1>
        <p className="mt-1 max-w-3xl text-[15px] text-ink/60">
          Give us the address of a web app and what the video should show. We explore the app, choose the best moments, hide passwords and private details, and make the video. Nothing is held back unless you tick a restriction below.
        </p>

        {/* saved apps */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {apps.map((a) => (
            <button
              key={a.id}
              disabled={running}
              onClick={() => { setForm(fromApp(a)); setLive(null); setError(null) }}
              className={`rounded-full border-2 px-3 py-1 text-xs font-bold ${form.id === a.id ? 'border-coral bg-coral text-white' : 'border-ink/10 bg-white text-ink/70 hover:border-coral/50'}`}
            >
              {a.name}
            </button>
          ))}
          <button disabled={running} onClick={() => { setForm(blank()); setLive(null); setError(null) }} className="btn-ghost !px-3 !py-1 !text-xs">
            ➕ New app
          </button>
        </div>

        <div className="mt-5 space-y-5">
          <Section icon="🌐" title="Your app" hint="The web address where it starts, usually its sign-in page.">
            <div className="grid gap-3 md:grid-cols-2">
              <input aria-label="App name" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={80} placeholder="Name, e.g. Acme dashboard" className="field px-4 py-2.5 text-sm" />
              <input aria-label="App address" value={form.url} onChange={(e) => set('url', e.target.value)} placeholder="https://app.example.com/login" className="field px-4 py-2.5 text-sm" />
            </div>
          </Section>

          <Section icon="📝" title="What should the video show?" hint="Type it in your own words, and attach notes if you have them. Notes are read as information only.">
            <textarea
              aria-label="What the video should show"
              value={form.context}
              onChange={(e) => set('context', e.target.value)}
              rows={3}
              maxLength={20000}
              placeholder='e.g. Create a video on "secured application", focused around the login flow'
              className="field w-full px-4 py-2.5 text-sm"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button onClick={attach} className="btn-ghost !px-3 !py-1 !text-xs">📎 Attach a document</button>
              {form.document && (
                <span className="inline-flex items-center gap-1.5 rounded-full border-2 border-sky/40 bg-sky-soft px-3 py-1 text-xs font-semibold">
                  {form.document.name}
                  <button onClick={() => set('document', null)} aria-label="Remove document" className="text-ink/40 hover:text-coral">✕</button>
                </span>
              )}
            </div>
          </Section>

          <Section icon="🔑" title="Signing in" hint="Your password is kept on this computer, sealed with your Windows account, and is never sent to an AI.">
            <div className="flex flex-wrap gap-2">
              {([['saved', 'Use a saved login'], ['self', "I'll sign in myself"], ['none', 'No sign-in needed']] as const).map(([id, label]) => (
                <button key={id} onClick={() => set('signIn', id)} className={`rounded-full border-2 px-3 py-1 text-xs font-bold ${form.signIn === id ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/65 hover:border-grape/50'}`}>
                  {label}
                </button>
              ))}
            </div>
            {form.signIn === 'saved' && (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <input aria-label="Username" value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="Username" autoComplete="off" className="field px-4 py-2.5 text-sm" />
                <input aria-label="Password" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} placeholder={form.hasPassword ? '•••••••• (saved — type to change)' : 'Password'} autoComplete="new-password" className="field px-4 py-2.5 text-sm" />
                <label className="flex items-center gap-2 text-xs text-ink/70 md:col-span-2">
                  <input type="checkbox" checked={form.revealUsername} onChange={(e) => set('revealUsername', e.target.checked)} /> Show the username in the video (only for a public demo account)
                </label>
              </div>
            )}
            {form.signIn === 'self' && <div className="mt-3 text-xs text-ink/60">A browser window opens and waits while you sign in, including any one-time code. We never see what you type.</div>}
            <div className="mt-2 text-[11px] text-ink/45">Tip: a dedicated test account is safest, since the app really signs in twice (once to explore, once to record).</div>
          </Section>

          <Section icon="🧭" title="How much to explore" hint="Exploring is not the same as recording: the video shows only the best 4 to 8 moments.">
            <div className="flex flex-wrap gap-2">
              {(Object.keys(DEPTH_LABELS) as Depth[]).map((d) => (
                <button key={d} onClick={() => set('depth', d)} title={DEPTH_LABELS[d].hint} className={`rounded-full border-2 px-3 py-1 text-xs font-bold ${form.depth === d ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/65 hover:border-grape/50'}`}>
                  {DEPTH_LABELS[d].label}
                </button>
              ))}
            </div>
            <div className="mt-2 text-xs text-ink/55">{DEPTH_LABELS[form.depth].hint}</div>
          </Section>

          <Section icon="🎬" title="Kind of video">
            <div className="flex flex-wrap gap-2">
              {([['walkthrough', 'Walkthrough'], ['launch', 'Launch film']] as const).map(([id, label]) => (
                <button key={id} onClick={() => set('mode', id)} className={`rounded-full border-2 px-3 py-1 text-xs font-bold ${form.mode === id ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/65 hover:border-grape/50'}`}>
                  {label}
                </button>
              ))}
              <select aria-label="Length" value={form.targetSec} onChange={(e) => set('targetSec', Number(e.target.value))} className="field !py-1 px-3 text-xs">
                {[30, 44, 60, 90].map((s) => <option key={s} value={s}>about {s}s</option>)}
              </select>
            </div>
            {form.mode === 'launch' && (
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <input aria-label="Feature name" value={form.feature} onChange={(e) => set('feature', e.target.value)} placeholder="Feature name, e.g. Secure sign-in" className="field px-4 py-2.5 text-sm" />
                <input aria-label="Tagline" value={form.tagline} onChange={(e) => set('tagline', e.target.value)} placeholder="Tagline" className="field px-4 py-2.5 text-sm" />
                <input aria-label="Closing line" value={form.closing} onChange={(e) => set('closing', e.target.value)} placeholder="Closing line" className="field px-4 py-2.5 text-sm" />
                <input aria-label="Call to action" value={form.cta} onChange={(e) => set('cta', e.target.value)} placeholder="Label, e.g. Available now" className="field px-4 py-2.5 text-sm" />
                <label className="flex items-center gap-2 text-xs text-ink/70 md:col-span-2">
                  Brand kit for the title and closing cards
                  <select aria-label="Brand kit" value={form.brandId} onChange={(e) => set('brandId', e.target.value)} className="field !py-1 px-3 text-xs">
                    <option value="">No brand</option>
                    {kits.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
                  </select>
                  <span className="text-ink/45">{kits.length ? 'Its logo and colour appear on the cards.' : 'Make a kit in Create → Brand to use a logo here.'}</span>
                </label>
              </div>
            )}
          </Section>

          <Section icon="🎨" title="Look (optional)" hint="Reference pictures steer the colours of the backdrop and cards; a reference video steers the pace of the music. They are read on this computer and never uploaded.">
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => pickStyle('images')} disabled={form.styleImages.length >= 3} className="btn-ghost !px-3 !py-1 !text-xs">🖼️ Add pictures</button>
              <button onClick={() => pickStyle('video')} className="btn-ghost !px-3 !py-1 !text-xs">🎞️ Pick a video</button>
              {form.styleImages.map((f) => (
                <span key={f} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink/70">
                  {f.split(/[\\/]/).pop()} <button aria-label={`Remove ${f}`} onClick={() => set('styleImages', form.styleImages.filter((x) => x !== f))} className="ml-1 text-ink/40">×</button>
                </span>
              ))}
              {form.styleVideo && (
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-ink/70">
                  🎞️ {form.styleVideo.split(/[\\/]/).pop()} <button aria-label="Remove the video" onClick={() => set('styleVideo', '')} className="ml-1 text-ink/40">×</button>
                </span>
              )}
            </div>
          </Section>

          <Section icon="🛡️" title="Restrictions (optional)" hint="Nothing is restricted unless you tick it or type a rule. Rules we cannot check automatically are shown back to you.">
            {noRestrictions && (
              <div className="mb-3 rounded-xl bg-sunny-soft px-3 py-2 text-xs font-semibold text-ink/80">
                ⚠️ This run will perform real actions in the app: it clicks and fills things in like a person would. Tick a restriction to hold it back, or use a test account.
              </div>
            )}
            <div className="grid gap-2 md:grid-cols-2">
              {([
                ['stayOnSites', "Stay on this app's sites", 'Leave the app only for the sign-in and API hosts it needs.'],
                ['readOnly', "Look only, don't change anything", 'Reads are allowed; anything that saves or changes data is blocked.'],
                ['noDelete', 'Never delete or remove anything', 'Delete, remove and cancel controls are never used.'],
                ['noSpend', 'Never spend money or send anything', 'Pay, buy, order, send and publish controls are never used.'],
                ['noSettings', "Don't change settings or passwords", 'Settings, passwords and accounts stay as they are.'],
                ['privacyMode', 'Hide personal data in tables and lists', 'Blurs table cells, fields, charts and emails or phone numbers on screen.']
              ] as Array<[keyof AppChecks, string, string]>).map(([k, label, hint]) => (
                <label key={k} className="flex items-start gap-2 rounded-xl border-2 border-ink/5 bg-white px-3 py-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={form.checks[k]} onChange={(e) => setCheck(k, e.target.checked)} />
                  <span>
                    <span className="font-bold">{label}</span>
                    <span className="block text-[11px] text-ink/50">{hint}</span>
                  </span>
                </label>
              ))}
            </div>
            <textarea aria-label="Other rules" value={form.guardrailText} onChange={(e) => set('guardrailText', e.target.value)} rows={2} maxLength={4000} placeholder='Anything else, e.g. "Only record the customer01 customer in the ABC module"' className="field mt-3 w-full px-4 py-2.5 text-sm" />
          </Section>

          <Section icon="⚙️" title="Options">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.useAi && ai.available} disabled={!ai.available} onChange={(e) => set('useAi', e.target.checked)} />
              Use the AI writer and voice <span className="text-xs text-ink/50">{ai.available ? '(counts as an AI video on your plan)' : `— ${ai.reason ?? 'not available'} The free engine writes the script instead.`}</span>
            </label>
            {!ai.available && <button onClick={onOpenSettings} className="mt-1 text-xs font-bold text-grape underline">Open settings</button>}
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.reviewFirst} onChange={(e) => set('reviewFirst', e.target.checked)} /> Let me review the steps before recording
            </label>
            {apps.find((a) => a.id === form.id)?.hasPlan && (
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={reuse} onChange={(e) => setReuse(e.target.checked)} /> Reuse the steps from the last video{' '}
                <span className="text-xs text-ink/50">(faster; only steps that no longer work are repaired, and the others are left alone)</span>
              </label>
            )}
          </Section>
        </div>

        {error && <div className="mt-4 rounded-xl bg-coral-soft px-3 py-2 text-sm font-semibold text-coral">⚠️ {error}</div>}

        <div className="mt-5 flex flex-wrap gap-3">
          <button onClick={make} disabled={running || saving || !form.url.trim()} className="btn-primary !px-7 !py-3">
            🎥 Make my video
          </button>
          <button onClick={save} disabled={running || saving || !form.url.trim()} className="btn-ghost !py-3">
            💾 Save app
          </button>
          {form.id && (
            <button
              disabled={running}
              onClick={async () => {
                if (!window.confirm(`Forget “${form.name}”?\n\nThis removes its saved login and every recording made from it.`)) return
                await api.appRec.remove(form.id!)
                setForm(blank())
                setLive(null)
                await refresh()
              }}
              className="btn-ghost !py-3 !text-coral"
            >
              🗑️ Forget this app
            </button>
          )}
        </div>

        {live && <RunPanel live={live} onClose={() => setLive(null)} onReviewAnswered={() => setLive((l) => (l ? { ...l, review: null } : l))} onHandoffDone={() => setLive((l) => (l ? { ...l, handoff: null } : l))} />}

        {myRuns.length > 0 && (
          <div className="mt-8">
            <div className="text-sm font-black">Earlier recordings</div>
            <div className="mt-2 space-y-2">
              {myRuns.slice(0, 8).map((r) => (
                <div key={r.id} className="card flex items-center gap-3 px-4 py-2 text-sm">
                  <span>{r.status === 'done' ? '✅' : r.status === 'cancelled' ? '⏹️' : r.status === 'running' ? '⏳' : '⚠️'}</span>
                  <span className="flex-1 truncate">
                    {new Date(r.startedAt).toLocaleString()} · {r.status === 'done' ? `${fmtDur(r.durationSec)} · ${r.pages ?? 0} pages explored` : (r.error ?? r.status)}
                  </span>
                  {r.video && <button onClick={() => api.appRec.play(r.id)} className="btn-ghost !px-3 !py-1 !text-xs">▶ Play</button>}
                  {r.video && <button onClick={() => api.appRec.reveal(r.id)} className="btn-ghost !px-3 !py-1 !text-xs">📂 Show</button>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** asks the engine to hand over the browser at the next page; it opens a window with the same session */
function TakeOver() {
  const [asked, setAsked] = useState(false)
  return (
    <button
      disabled={asked}
      title="Opens a browser window with the same session so you can open a page or sort something out yourself, then press Done"
      onClick={() => { setAsked(true); void api.appRec.takeover() }}
      className="btn-ghost !px-3 !py-1 !text-xs"
    >
      {asked ? '✋ Taking over after this page…' : '✋ Take over'}
    </button>
  )
}

function RunPanel({ live, onClose, onReviewAnswered, onHandoffDone }: { live: Live; onClose: () => void; onReviewAnswered: () => void; onHandoffDone: () => void }) {
  const idx = STAGES.findIndex((s) => s.id === live.stage)
  const done = live.result
  return (
    <section className="card slide-up mt-6 p-5" aria-label="Recording progress">
      <div className="flex items-center gap-3">
        <div className="text-base font-black">{done ? (done.status === 'done' ? '✅ Your video is ready' : done.status === 'cancelled' ? '⏹️ Stopped' : '⚠️ It did not finish') : '🤖 The app is driving a browser'}</div>
        <div className="flex-1" />
        {!done && live.stage === 'explore' && !live.handoff && <TakeOver />}
        {!done && <button onClick={() => api.appRec.cancel()} className="btn-ghost !px-3 !py-1 !text-xs">⏹ Stop</button>}
        {done && <button onClick={onClose} className="btn-ghost !px-3 !py-1 !text-xs">Close</button>}
      </div>

      {!done && (
        <ol className="mt-3 space-y-1.5">
          {STAGES.map((s, i) => (
            <li key={s.id} className={`flex items-center gap-2 text-sm ${i < idx ? 'text-ink/50' : i === idx ? 'font-bold' : 'text-ink/35'}`}>
              <span>{i < idx ? '✔' : i === idx ? '⏳' : '○'}</span>
              {s.label}
              {i === idx && <span className="text-xs font-normal text-ink/55">— {live.message}</span>}
            </li>
          ))}
        </ol>
      )}

      {live.handoff && (
        <div className="mt-4 rounded-xl bg-sunny-soft px-4 py-3">
          <div className="text-sm font-bold">👋 We need you</div>
          <div className="mt-1 text-sm">{live.handoff}</div>
          <button onClick={() => { void api.appRec.handoffDone(); onHandoffDone() }} className="btn-primary mt-3 !px-5 !py-2 !text-sm">✅ Done</button>
        </div>
      )}

      {live.review && <ReviewPanel beats={live.review.beats} advisory={live.review.advisory} notes={live.review.notes} onAnswered={onReviewAnswered} />}

      {!done && live.logs.length > 0 && (
        <details className="mt-3 text-xs text-ink/55">
          <summary className="cursor-pointer font-bold">What it is doing</summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{live.logs.join('\n')}</pre>
        </details>
      )}

      {done && done.status === 'done' && (
        <div className="mt-3">
          <div className="text-sm">
            {fmtDur(done.durationSec)} · explored {done.pages} page(s) with {done.actions} action(s)
            {done.stoppedBy && done.stoppedBy !== 'done' ? ` · stopped by the ${done.stoppedBy} limit` : ''}
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={() => api.appRec.play(done.id)} className="btn-primary !px-5 !py-2 !text-sm">▶ Play</button>
            <button onClick={() => api.appRec.reveal(done.id)} className="btn-ghost !py-2 !text-sm">📂 Show in folder</button>
          </div>
          {done.notes.length > 0 && <div className="mt-3 text-xs text-ink/55">{done.notes.join(' · ')}</div>}
          {!!done.advisory?.length && <div className="mt-2 text-xs text-ink/55">Not enforced automatically: {done.advisory.join(' | ')}</div>}
          {!!done.blockedHosts?.length && <div className="mt-2 text-xs text-ink/55">The app also tried to reach: {done.blockedHosts.map((h) => `${h.host} (${h.count}×)`).join(', ')}. Untick “Stay on this app's sites” to allow other hosts.</div>}
          <div className="mt-3 text-xs text-ink/50">Watch the video before you share it: we hide what we can recognize as private, and nothing else.</div>
        </div>
      )}
      {done && done.status === 'failed' && <div className="mt-3 rounded-xl bg-coral-soft px-3 py-2 text-sm font-semibold text-coral">{done.error}</div>}
    </section>
  )
}

function ReviewPanel({ beats, advisory, notes, onAnswered }: { beats: ReviewBeat[]; advisory: string[]; notes: string[]; onAnswered: () => void }) {
  const [text, setText] = useState<Record<number, string>>(() => Object.fromEntries(beats.map((b) => [b.beat, b.text])))
  const [removed, setRemoved] = useState<number[]>([])
  return (
    <div className="mt-4 rounded-xl border-2 border-grape/30 bg-grape-soft/40 px-4 py-3">
      <div className="text-sm font-bold">📋 Review the steps</div>
      <div className="mt-1 text-xs text-ink/60">These are the moments the video will show, and the words said over each. Reword a line or drop a page, then approve.</div>
      {advisory.length > 0 && <div className="mt-2 rounded-lg bg-sunny-soft px-3 py-2 text-xs">These rules cannot be checked automatically, so please confirm each step stays in scope: {advisory.join(' | ')}</div>}
      <div className="mt-3 space-y-2">
        {beats.map((b) => (
          <div key={b.beat} className={`rounded-lg bg-white px-3 py-2 ${removed.includes(b.beat) ? 'opacity-40' : ''}`}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-black">{b.chapter}</span>
              <span className="text-[10px] uppercase text-ink/40">{b.kind}</span>
              <div className="flex-1" />
              {b.removable && <button onClick={() => setRemoved((r) => (r.includes(b.beat) ? r.filter((x) => x !== b.beat) : [...r, b.beat]))} className="text-xs font-bold text-coral">{removed.includes(b.beat) ? 'Keep' : 'Drop'}</button>}
            </div>
            <textarea aria-label={`Narration for ${b.chapter}`} disabled={removed.includes(b.beat)} value={text[b.beat]} onChange={(e) => setText((t) => ({ ...t, [b.beat]: e.target.value }))} rows={2} className="field mt-1 w-full px-3 py-1.5 text-sm" />
          </div>
        ))}
      </div>
      {notes.length > 0 && <div className="mt-2 text-[11px] text-ink/50">{notes.join(' · ')}</div>}
      <div className="mt-3 flex gap-2">
        <button
          onClick={async () => {
            await api.appRec.review({ removeBeats: removed, lines: Object.fromEntries(beats.filter((b) => text[b.beat] !== b.text).map((b) => [b.beat, text[b.beat]])) })
            onAnswered()
          }}
          className="btn-primary !px-5 !py-2 !text-sm"
        >
          ✅ Approve and record
        </button>
        <button onClick={async () => { await api.appRec.review(null); onAnswered() }} className="btn-ghost !py-2 !text-sm">Cancel</button>
      </div>
    </div>
  )
}
