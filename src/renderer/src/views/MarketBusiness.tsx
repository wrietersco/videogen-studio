import { useEffect, useRef, useState } from 'react'
import { api, type BusinessProfile, type MarketEvent, type MarketJob, type MarketRunRecord, type MarketStage, type VideoCard } from '../api'
import { Section } from '../components/ui'

/**
 * Market your business: type the website address, and the engine reads the
 * site, takes the brand and writes problem–solution video ideas. The ideas are
 * editable; one button turns any of them into a film with the same engine
 * that records apps (without the recording part).
 */

interface Live {
  businessId: string
  job: MarketJob
  runId?: string
  cardId?: string
  stage?: MarketStage
  message?: string
  logs: string[]
  error?: string
  run?: MarketRunRecord
}

const ANALYZE_STAGES: Array<{ id: MarketStage; label: string }> = [
  { id: 'fetch', label: 'Opening the website' },
  { id: 'read', label: 'Reading the pages' },
  { id: 'brand', label: 'Taking the brand' },
  { id: 'ideas', label: 'Writing the video ideas' }
]
const FILM_STAGES: Array<{ id: MarketStage; label: string }> = [
  { id: 'script', label: 'Writing the story' },
  { id: 'voice', label: 'Recording the voice-over' },
  { id: 'media', label: 'Choosing the elements' },
  { id: 'assemble', label: 'Building the film' }
]

/** the edits of one card, kept locally until they are saved on the way out of the field */
type Draft = { title?: string; problem?: string; solution?: string; cta?: string }

export default function MarketBusiness({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([])
  const [runs, setRuns] = useState<MarketRunRecord[]>([])
  const [ai, setAi] = useState<{ available: boolean; reason?: string }>({ available: true })
  const [sel, setSel] = useState<string>('')
  const [domain, setDomain] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [siteMd, setSiteMd] = useState<string | null>(null)
  const formRef = useRef({ sel, domain })
  formRef.current = { sel, domain }

  const refresh = () =>
    api.market
      .state()
      .then((s) => {
        setBusinesses(s.businesses)
        setRuns(s.runs)
        setAi(s.ai)
        const cur = formRef.current.sel
        if (cur && s.businesses.some((b) => b.id === cur)) return
        setSel(s.businesses[0]?.id ?? '')
        setDomain(s.businesses[0]?.domain ?? '')
      })
      .catch(() => undefined)

  useEffect(() => {
    void refresh()
    return api.market.onEvent((raw) => {
      const e = raw as MarketEvent
      if (e.kind === 'started') setLive({ businessId: e.businessId, job: e.job, runId: e.runId, cardId: e.cardId, logs: [] })
      else if (e.kind === 'stage') setLive((l) => (l && l.businessId === e.businessId && l.job === e.job ? { ...l, stage: e.stage, message: e.message } : l))
      else if (e.kind === 'log') setLive((l) => (l && l.businessId === e.businessId && l.job === e.job ? { ...l, logs: [...l.logs, e.message].slice(-40) } : l))
      else if (e.kind === 'done') {
        if (e.job === 'analyze') setLive(null)
        else setLive((l) => (l ? { ...l, run: e.run } : l))
        void refresh()
      } else {
        setLive((l) => (l ? { ...l, error: e.kind === 'failed' ? e.error : undefined } : l))
        void refresh()
      }
    })
  }, [])

  const profile = businesses.find((b) => b.id === sel) ?? null
  const running = !!live
  const busyHere = running && live.businessId === sel
  const filmRun = live?.job === 'film' ? runs.find((r) => r.id === live.runId) ?? (live.run ? [live.run] : [])[0] : null

  const save = async () => {
    setError(null)
    const r = await api.market.save(domain.trim())
    if (!r.ok) {
      setError(r.error)
      return null
    }
    setSel(r.businessId)
    setSiteMd(null)
    await refresh()
    return r.businessId
  }

  /** commit one card's edits, then (optionally) start its film */
  const commit = async (card: VideoCard, what: 'save' | 'make') => {
    const d = drafts[card.id] ?? {}
    const patch: Draft = {}
    for (const k of ['title', 'problem', 'solution', 'cta'] as const) if (d[k] !== undefined && d[k] !== card[k]) patch[k] = d[k]
    if (Object.keys(patch).length) {
      const r = await api.market.updateCard(sel, card.id, patch)
      if (!r.ok) {
        setError(r.error)
        return false
      }
      setBusinesses((bs) => bs.map((b) => (b.id === sel ? r.profile : b)))
      setDrafts((ds) => {
        const next = { ...ds }
        delete next[card.id]
        return next
      })
    }
    if (what === 'make') {
      const r = await api.market.start(sel, card.id)
      if (!r.ok) setError(r.error)
    }
    return true
  }

  const field = (card: VideoCard, k: keyof Draft, value: string) => setDrafts((ds) => ({ ...ds, [card.id]: { ...ds[card.id], [k]: value } }))
  const valueOf = (card: VideoCard, k: keyof Draft): string => drafts[card.id]?.[k] ?? card[k]

  return (
    <div className="page-bg h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 pb-20 pt-8">
        <h1 className="text-3xl font-black tracking-tight">
          <span className="float inline-block">📣</span> Market my business
        </h1>
        <p className="mt-1 max-w-3xl text-[15px] text-ink/60">
          Type your website address. We read your pages, take your brand, and write problem–solution video ideas you can edit. One button turns any idea into a short film — the engine picks the elements (animated scenes, AI pictures, AI clips, voice, music) itself.
        </p>

        {/* saved businesses */}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {businesses.map((b) => (
            <button
              key={b.id}
              disabled={running}
              onClick={() => { setSel(b.id); setDomain(b.domain); setLive(null); setError(null); setSiteMd(null) }}
              className={`rounded-full border-2 px-3 py-1 text-xs font-bold ${sel === b.id ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/70 hover:border-grape/50'}`}
            >
              {b.name || b.domain}
            </button>
          ))}
          <button disabled={running} onClick={() => { setSel(''); setDomain(''); setLive(null); setError(null); setSiteMd(null) }} className="btn-ghost !px-3 !py-1 !text-xs">
            ➕ New business
          </button>
        </div>

        <div className="mt-5 space-y-5">
          <Section icon="🌐" title="Your business" hint="The website address of the business. Saving it reads the site once; you can re-read it any time.">
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label="Website address" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" className="field flex-1 px-4 py-2.5 text-sm" />
              <button disabled={running || !domain.trim()} onClick={() => void save()} className="btn-primary !py-2.5">
                {profile?.about ? '🔁 Re-read the site' : '💾 Save and read the site'}
              </button>
            </div>
            {!ai.available && (
              <div className="mt-2 text-xs font-semibold text-ink/50">
                — {ai.reason} The free engine still reads the site and writes starting-point cards.{' '}
                <button className="underline" onClick={onOpenSettings}>
                  Open settings
                </button>
              </div>
            )}
          </Section>

          {error && <div className="rounded-xl bg-coral-soft px-4 py-3 text-sm font-semibold text-ink/80">{error}</div>}

          {busyHere && <JobPanel live={live!} stages={live!.job === 'analyze' ? ANALYZE_STAGES : FILM_STAGES} />}

          {profile && profile.about && (
            <>
              <Section icon="🏢" title={profile.name} hint={profile.domain}>
                <div className="space-y-3">
                  {profile.tagline && <div className="text-lg font-black">{profile.tagline}</div>}
                  <p className="text-sm text-ink/70">{profile.about}</p>
                  {profile.services.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {profile.services.map((s, i) => (
                        <span key={i} title={s.summary + (s.benefits.length ? `\n${s.benefits.join('\n')}` : '')} className="rounded-full border-2 border-ink/10 bg-white px-3 py-1 text-xs font-bold text-ink/70">
                          {s.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3">
                    {profile.brand.colors.slice(0, 6).map((c, i) => (
                      <span key={i} className="inline-block h-5 w-5 rounded-full border border-ink/10" style={{ background: c }} title={c} />
                    ))}
                    <span className="text-xs text-ink/45">colours taken from the site</span>
                  </div>
                  {profile.notes.length > 0 && <div className="text-xs text-ink/50">{profile.notes.join(' ')}</div>}
                  <details onToggle={(e) => e.currentTarget.open && api.market.siteMd(profile.id).then((r) => setSiteMd(r.ok ? r.md : (r.error ?? 'The site read could not be opened'))).catch(() => undefined)}>
                    <summary className="cursor-pointer text-xs font-bold text-ink/60">📄 What we read</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded-xl bg-ink/5 p-3 text-[11px] leading-relaxed">{siteMd ?? 'reading…'}</pre>
                  </details>
                </div>
              </Section>

              <Section icon="🎬" title="Video ideas" hint="Editable starting points. Changes are kept as you leave a field; Create video makes the film.">
                <div className="grid gap-4 md:grid-cols-2">
                  {profile.cards.map((card, i) => (
                    <div key={card.id} className={`card p-4 ${filmRun && live?.cardId === card.id ? 'ring-2 ring-grape' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-grape-soft text-xs font-black text-ink/70">{i + 1}</span>
                        <input aria-label="Video title" value={valueOf(card, 'title')} onChange={(e) => field(card, 'title', e.target.value)} onBlur={() => void commit(card, 'save')} maxLength={80} className="field !border-transparent !px-1 !py-0.5 w-full text-sm font-bold hover:!border-ink/10 focus:!border-grape" />
                        <button
                          title="Remove this idea"
                          disabled={running}
                          onClick={async () => {
                            if (!window.confirm('Remove this video idea?')) return
                            const r = await api.market.removeCard(sel, card.id)
                            if (!r.ok) setError(r.error)
                            else setBusinesses((bs) => bs.map((b) => (b.id === sel ? r.profile : b)))
                          }}
                          className="rounded px-1.5 text-ink/40 hover:bg-coral-soft hover:text-coral"
                        >
                          ✕
                        </button>
                      </div>
                      <div className="mt-3 space-y-2">
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wide text-ink/40">The problem</div>
                          <textarea aria-label="The problem" value={valueOf(card, 'problem')} onChange={(e) => field(card, 'problem', e.target.value)} onBlur={() => void commit(card, 'save')} rows={3} className="field mt-1 w-full px-3 py-1.5 text-sm" />
                        </div>
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-wide text-ink/40">The solution</div>
                          <textarea aria-label="The solution" value={valueOf(card, 'solution')} onChange={(e) => field(card, 'solution', e.target.value)} onBlur={() => void commit(card, 'save')} rows={3} className="field mt-1 w-full px-3 py-1.5 text-sm" />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-bold uppercase tracking-wide text-ink/40">Call to action</span>
                          <input aria-label="Call to action" value={valueOf(card, 'cta')} onChange={(e) => field(card, 'cta', e.target.value)} onBlur={() => void commit(card, 'save')} maxLength={60} className="field flex-1 px-3 py-1 text-sm" />
                        </div>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-2">
                        {card.video ? (
                          <div className="flex items-center gap-2">
                            <button onClick={() => void api.market.play(card.runId!)} className="btn-ghost !px-3 !py-1 !text-xs">▶ Play</button>
                            <button onClick={() => void api.market.reveal(card.runId!)} className="btn-ghost !px-3 !py-1 !text-xs">📂 Show</button>
                          </div>
                        ) : (
                          <span />
                        )}
                        <button disabled={running} onClick={() => void commit(card, 'make')} className="btn-primary !px-4 !py-1.5 !text-sm">
                          🎥 {card.video ? 'Make it again' : 'Create video'}
                        </button>
                      </div>
                      {live?.cardId === card.id && live.job === 'film' && live.error && <div className="mt-2 rounded-lg bg-coral-soft px-3 py-2 text-xs font-semibold text-ink/80">{live.error}</div>}
                      {live?.cardId === card.id && live.job === 'film' && live.run?.notes.length ? <div className="mt-2 text-xs text-ink/50">{live.run.notes.join(' · ')}</div> : null}
                    </div>
                  ))}
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    disabled={running}
                    onClick={async () => {
                      const r = await api.market.addCard(sel)
                      if (!r.ok) setError(r.error)
                      else setBusinesses((bs) => bs.map((b) => (b.id === sel ? r.profile : b)))
                    }}
                    className="btn-ghost !px-4 !py-1.5 !text-sm"
                  >
                    ➕ Add an idea
                  </button>
                  <button
                    disabled={running || !ai.available}
                    onClick={async () => {
                      const r = await api.market.moreIdeas(sel)
                      if (!r.ok) setError(r.error)
                      else setBusinesses((bs) => bs.map((b) => (b.id === sel ? r.profile : b)))
                    }}
                    className="btn-ghost !px-4 !py-1.5 !text-sm"
                    title={ai.available ? undefined : ai.reason}
                  >
                    ♻️ More ideas {ai.available ? '' : '(needs the AI writer)'}
                  </button>
                </div>
              </Section>
            </>
          )}

          {profile && runs.filter((r) => r.businessId === profile.id).length > 0 && (
            <Section icon="🎞️" title="Earlier films" hint="Every film made for this business.">
              <div className="card divide-y divide-ink/5">
                {runs
                  .filter((r) => r.businessId === profile.id)
                  .map((r) => (
                    <div key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                      <span>{r.status === 'done' ? '✅' : r.status === 'running' ? '⏳' : '❌'}</span>
                      <span className="font-semibold">{profile.cards.find((c) => c.id === r.cardId)?.title ?? 'A video idea'}</span>
                      <span className="text-xs text-ink/45">{new Date(r.startedAt).toLocaleString()}</span>
                      {r.durationSec ? <span className="text-xs text-ink/45">{Math.round(r.durationSec)}s</span> : null}
                      {r.status === 'done' && (
                        <span className="ml-auto flex items-center gap-1">
                          <button onClick={() => void api.market.play(r.id)} className="btn-ghost !px-3 !py-1 !text-xs">▶ Play</button>
                          <button onClick={() => void api.market.reveal(r.id)} className="btn-ghost !px-3 !py-1 !text-xs">📂 Show</button>
                          <button
                            onClick={async () => {
                              if (!window.confirm('Delete this film and its working files?')) return
                              const del = await api.market.removeRun(r.id)
                              if (!del.ok) setError(del.error ?? 'It could not be deleted')
                              else void refresh()
                            }}
                            className="btn-ghost !px-3 !py-1 !text-xs !text-coral"
                          >
                            🗑️
                          </button>
                        </span>
                      )}
                      {r.error && <span className="w-full text-xs text-coral">{r.error}</span>}
                    </div>
                  ))}
              </div>
            </Section>
          )}

          {profile && (
            <div className="flex justify-end">
              <button
                disabled={running}
                onClick={async () => {
                  if (!window.confirm(`Forget ${profile.name || profile.domain}? Its profile, the site read and every film made for it are removed from this computer.`)) return
                  const r = await api.market.remove(profile.id)
                  if (!r.ok) setError(r.error)
                  else {
                    setSel('')
                    setDomain('')
                    void refresh()
                  }
                }}
                className="btn-ghost !text-coral !px-4 !py-1.5 !text-sm"
              >
                🗑️ Forget this business
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function JobPanel({ live, stages }: { live: Live; stages: Array<{ id: MarketStage; label: string }> }) {
  const idx = live.stage ? stages.findIndex((s) => s.id === live.stage) : -1
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <div className="text-sm font-black">{live.job === 'analyze' ? 'Reading your website…' : 'Making your film…'}</div>
        <button onClick={() => void api.market.cancel()} className="btn-ghost !px-3 !py-1 !text-xs">⏹ Stop</button>
      </div>
      <ol className="mt-3 space-y-1 text-sm">
        {stages.map((s, i) => (
          <li key={s.id} className={i < idx ? 'text-ink/45' : i === idx ? 'font-bold' : 'text-ink/35'}>
            {i < idx ? '✔' : i === idx ? '⏳' : '○'} {s.label}
            {i === idx && live.message ? <span className="ml-1 font-normal text-ink/50">— {live.message}</span> : null}
          </li>
        ))}
      </ol>
      {live.logs.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-bold text-ink/50">What it is doing</summary>
          <pre className="mt-2 max-h-40 overflow-auto text-[11px] leading-relaxed text-ink/60">{live.logs.join('\n')}</pre>
        </details>
      )}
    </div>
  )
}
