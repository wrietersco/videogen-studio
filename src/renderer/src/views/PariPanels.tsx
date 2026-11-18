import { useState } from 'react'
import { api } from '../api'
import type { CapabilityReport, CheckStatus, DecisionAnswer, DecisionRequest, FilmPlan, JobKind, PariReport, Segment, SegmentCheck } from '@shared/agentBrief'

/** The PARI agent's screens for Record an app: what it understood, what it asks, how each part went, what it could not do. */

const JOB_LABEL: Record<JobKind, string> = { writer: 'Script writer', voice: 'Voice', music: 'Music', video: 'AI video clips', image: 'AI pictures', vision: 'Checking the footage' }

export const STATUS: Record<CheckStatus, { label: string; cls: string }> = {
  done: { label: '✔ Done', cls: 'bg-mint-soft text-ink' },
  partial: { label: '◐ Partly done', cls: 'bg-sunny-soft text-ink' },
  missed: { label: '✕ Missed', cls: 'bg-coral-soft text-coral' },
  substituted: { label: '↻ Replaced', cls: 'bg-sky-soft text-ink' },
  skipped: { label: '— Skipped', cls: 'bg-ink/5 text-ink/60' }
}

function describe(s: Segment): { icon: string; title: string; sub?: string } {
  switch (s.kind) {
    case 'ai-clip':
      return { icon: '🎞️', title: `AI clip: ${s.subject}`, sub: [s.seconds ? `${s.seconds}s` : '', s.style ?? ''].filter(Boolean).join(' · ') || undefined }
    case 'page':
      return { icon: '🌐', title: s.url ?? s.target ?? 'A page of the app', sub: s.url && s.target ? s.target : undefined }
    case 'narration':
      return { icon: '🎙️', title: `Narration: ${s.claims[0] ?? s.said}`, sub: s.claims.length > 1 ? `+ ${s.claims.length - 1} more point${s.claims.length > 2 ? 's' : ''}` : undefined }
    case 'card':
      return { icon: '🪧', title: `${s.card[0].toUpperCase()}${s.card.slice(1)} card`, sub: s.text }
  }
}

function musicLine(p: FilmPlan): string {
  const m = p.music
  if (m.none) return 'No music'
  return m.description || [m.genre, m.quiet ? 'quiet' : ''].filter(Boolean).join(', ') || 'Music chosen for you'
}

export function PlanPanel({ plan, capabilities, checks }: { plan: FilmPlan; capabilities: CapabilityReport | null; checks: Record<string, SegmentCheck> }) {
  return (
    <div className="mt-4 rounded-xl border-2 border-sky/30 bg-sky-soft/40 px-4 py-3" aria-label="What I understood">
      <div className="text-sm font-bold">🧠 What I understood</div>
      <div className="mt-1 text-sm">{plan.goal}</div>
      <ol className="mt-3 space-y-1.5">
        {plan.segments.map((s, i) => {
          const d = describe(s)
          const c = checks[s.id]
          const st = c ? STATUS[c.status] : null
          return (
            <li key={s.id} className="rounded-lg bg-white px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-xs font-black text-ink/40">{i + 1}</span>
                <span>{d.icon}</span>
                <span className="min-w-0 flex-1 truncate font-semibold" title={d.title}>{d.title}</span>
                {!s.required && <span className="text-[10px] uppercase text-ink/40">nice to have</span>}
                {st && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.label}</span>}
              </div>
              {d.sub && <div className="ml-7 text-xs text-ink/55">{d.sub}</div>}
              {c?.note && <div className="ml-7 mt-0.5 text-xs text-ink/65">{c.note}</div>}
            </li>
          )
        })}
      </ol>
      <div className="mt-2 text-xs text-ink/65">🎵 Music: {musicLine(plan)}</div>
      {plan.unplaced.length > 0 && (
        <div className="mt-3 rounded-lg bg-sunny-soft px-3 py-2 text-xs">
          <div className="font-bold">⚠️ I could not place these:</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{plan.unplaced.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </div>
      )}
      {capabilities && <ModelsList caps={capabilities} />}
    </div>
  )
}

export function ModelsList({ caps }: { caps: CapabilityReport }) {
  return (
    <details className="mt-3 text-xs">
      <summary className="cursor-pointer font-bold">Models for this video</summary>
      <ul className="mt-1.5 space-y-1">
        {caps.jobs.map((j) => {
          const pick = j.options.find((o) => o.id === j.configured) ?? j.options.find((o) => o.available)
          return (
            <li key={j.job} className="rounded-lg bg-white px-3 py-1.5">
              <span className="font-bold">{JOB_LABEL[j.job]}</span>: {pick ? pick.label : 'nothing available'}
              {pick && <span className="text-ink/55"> · {pick.cost}</span>}
              {pick && !pick.available && <span className="text-coral"> · not available{pick.reason ? `: ${pick.reason}` : ''}</span>}
              {j.options.filter((o) => o !== pick && !o.available).map((o) => (
                <div key={o.id} className="text-[11px] text-ink/45">{o.label}: {o.reason ?? 'not available'}</div>
              ))}
            </li>
          )
        })}
      </ul>
      {caps.limits.length > 0 && <div className="mt-1 text-[11px] text-ink/50">{caps.limits.join(' · ')}</div>}
    </details>
  )
}

export function DecisionPanel({ requests, onAnswered, send: sendAnswers }: { requests: DecisionRequest[]; onAnswered: () => void; /** where the answers go (default: Record an app's channel) */ send?: (answers: DecisionAnswer[] | null) => Promise<unknown> }) {
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(requests.map((r) => [r.id, r.options.find((o) => o.recommended)?.id ?? r.autopick])))
  const [busy, setBusy] = useState(false)
  const send = async (answers: DecisionAnswer[] | null) => {
    setBusy(true)
    try {
      await (sendAnswers ?? api.appRec.decide)(answers)
    } catch {
      /* the main-process handler may not exist yet */
    }
    onAnswered()
  }
  return (
    <div className="mt-4 rounded-xl border-2 border-grape/30 bg-grape-soft/40 px-4 py-3" role="dialog" aria-label="A few choices">
      <div className="text-sm font-bold">🤔 {requests.length === 1 ? 'One quick choice' : `${requests.length} quick choices`}</div>
      <div className="mt-3 space-y-3">
        {requests.map((r) => {
          const ordered = [...r.options].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended))
          return (
            <div key={r.id} className="rounded-xl bg-white px-4 py-3">
              <div className="text-sm font-black">{r.question}</div>
              <div className="mt-0.5 text-xs text-ink/60">{r.context}</div>
              <div className="mt-2 grid gap-2">
                {ordered.map((o) => {
                  const on = picked[r.id] === o.id
                  return (
                    <button
                      key={o.id}
                      onClick={() => setPicked((p) => ({ ...p, [r.id]: o.id }))}
                      aria-pressed={on}
                      className={`rounded-xl border-2 px-4 py-2.5 text-left transition-colors ${on ? 'border-grape bg-grape-soft' : 'border-ink/10 bg-white hover:border-grape/50'}`}
                    >
                      <div className="flex items-center gap-2 text-sm font-bold">
                        <span>{on ? '●' : '○'}</span>
                        {o.label}
                        {o.recommended && <span className="rounded-full bg-grape px-2 py-0.5 text-[10px] font-bold uppercase text-white">Recommended</span>}
                      </div>
                      <div className="ml-6 text-xs text-ink/60">{o.detail}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-3 flex gap-2">
        <button disabled={busy} onClick={() => send(requests.map((r) => ({ id: r.id, option: picked[r.id], auto: false })))} className="btn-primary !px-5 !py-2 !text-sm">
          ✅ Go with these
        </button>
        <button disabled={busy} onClick={() => send(null)} className="btn-ghost !py-2 !text-sm">Stop</button>
      </div>
    </div>
  )
}

/** the log line shown in autopilot, where no dialog appears */
export function autopilotLines(requests: DecisionRequest[]): string[] {
  return requests.map((r) => {
    const o = r.options.find((x) => x.id === r.autopick)
    return `Autopilot chose "${o?.label ?? r.autopick}" for: ${r.question}`
  })
}

export function ReportPanel({ report }: { report: Pick<PariReport, 'shortfalls'> }) {
  const sf = report.shortfalls
  return (
    <div className={`mt-4 rounded-xl border-2 px-4 py-3 ${sf.length ? 'border-sunny/60 bg-sunny-soft' : 'border-mint/40 bg-mint-soft/40'}`}>
      {sf.length ? (
        <>
          <div className="text-sm font-black">What I could not do, and why</div>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">{sf.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </>
      ) : (
        <div className="text-sm font-black">✅ Everything you asked for is in the video</div>
      )}
    </div>
  )
}
