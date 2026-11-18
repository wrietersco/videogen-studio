import { useState } from 'react'
import type { CapabilityReport, SegmentCheck } from '@shared/agentBrief'
import type { MarketPlan, Show } from '@shared/marketBrief'
import { ModelsList, STATUS } from './PariPanels'

/** What the agent understood from the card and the brief, and how each part went. */

const SHOW: Record<Show, string> = { clip: '🎞️ AI video clip', image: '🖼️ AI picture', scene: '🪧 Animated card', any: '✨ Engine chooses' }

function Row({ n, icon, title, sub, check, optional }: { n?: number; icon: string; title: string; sub?: string; check?: SegmentCheck; optional?: boolean }) {
  const st = check ? STATUS[check.status] : null
  return (
    <li className="rounded-lg bg-white px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="w-3 text-xs font-black text-ink/40">{n ?? ''}</span>
        <span>{icon}</span>
        <span className="min-w-0 flex-1 truncate font-semibold" title={title}>{title}</span>
        {optional && <span className="text-[10px] uppercase text-ink/40">nice to have</span>}
        {st && <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.label}</span>}
      </div>
      {sub && <div className="ml-8 text-xs text-ink/55">{sub}</div>}
      {check?.note && <div className="ml-8 mt-0.5 text-xs text-ink/65">{check.note}</div>}
    </li>
  )
}

export function MarketPlanPanel({ plan, capabilities, checks }: { plan: MarketPlan; capabilities: CapabilityReport | null; checks: Record<string, SegmentCheck> }) {
  const m = plan.music
  const musicTitle = m.none ? 'No music' : m.description || [m.genre, m.vocals !== 'none' ? `vocals: ${m.vocals}` : ''].filter(Boolean).join(', ') || 'Music chosen for you'
  return (
    <div className="mt-4 rounded-xl border-2 border-sky/30 bg-sky-soft/40 px-4 py-3" aria-label="What I understood">
      <div className="text-sm font-bold">🧠 What I understood</div>
      <div className="mt-1 text-sm">{plan.goal}</div>
      <div className="mt-0.5 text-[11px] text-ink/50">{plan.source === 'ai' ? 'Read by the AI writer' : plan.source === 'rules' ? 'Read by the free engine' : 'From the card, no brief given'}</div>
      <ol className="mt-3 space-y-1.5">
        <Row icon="😣" title={`The problem: ${plan.problem.say}`} sub={plan.problem.show === 'clip' ? '🎞️ AI video clip' : undefined} check={checks.problem} />
        {plan.points.map((p, i) => (
          <Row key={p.id} n={i + 1} icon="💡" title={p.say} sub={p.show !== 'any' ? `${SHOW[p.show]}${p.visual ? ` · ${p.visual}` : ''}${p.seconds ? ` · ${p.seconds}s` : ''}` : undefined} check={checks[p.id]} optional={!p.required} />
        ))}
        <Row icon="👉" title={`Ends on: ${plan.close.cta}`} check={checks.close} />
        <Row icon="🎵" title={musicTitle} check={checks.music} />
        {plan.voice.language || plan.voice.tone ? <Row icon="🎙️" title={`Voice: ${[plan.voice.language, plan.voice.tone].filter(Boolean).join(', ')}`} check={checks.voice} /> : null}
        {plan.avoid.length > 0 && <Row icon="🚫" title={`Not mentioned: ${plan.avoid.join(', ')}`} check={checks.avoid} />}
        {plan.targetSec ? <Row icon="⏱️" title={`About ${plan.targetSec} seconds`} check={checks.length} /> : null}
      </ol>
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

/** under a finished film: say what should change, and make it again (the earlier film is kept) */
export function ReviseBox({ disabled, onRevise }: { disabled: boolean; onRevise: (request: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <div className="mt-3 rounded-xl border-2 border-ink/10 bg-white/60 px-3 py-2">
      <div className="text-[11px] font-bold uppercase tracking-wide text-ink/40">What should change?</div>
      <textarea
        aria-label="What should change?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder={'Anything, in your own words. For example: make the hook funnier. Use a different picture in the second scene. No music. Say we deliver on Sundays. 15 seconds.'}
        className="field mt-1 w-full px-3 py-1.5 text-sm"
      />
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="text-[11px] text-ink/45">Only what you change is made again. Your earlier film is kept.</span>
        <button
          disabled={disabled || busy || !text.trim()}
          onClick={async () => {
            setBusy(true)
            const ok = await onRevise(text.trim())
            setBusy(false)
            if (ok) setText('')
          }}
          className="btn-primary !px-3 !py-1 !text-xs"
        >
          ✏️ Make it again with these changes
        </button>
      </div>
    </div>
  )
}

/** after a change: what was changed, what was kept, what could not be done */
export function RevisionSummary({ revision }: { revision: { request: string; changed: string[]; kept: string[]; cannot: string[] } }) {
  const list = (icon: string, title: string, items: string[]) =>
    items.length ? (
      <div className="mt-1">
        <div className="text-xs font-bold">{icon} {title}</div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-ink/70">{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
    ) : null
  return (
    <div className="mt-2 rounded-lg bg-mint-soft/50 px-3 py-2" aria-label="What was changed">
      <div className="text-xs text-ink/55">You asked: “{revision.request}”</div>
      {list('✏️', 'Changed', revision.changed)}
      {list('♻️', 'Kept from the earlier film', revision.kept)}
      {list('⚠️', 'Could not do', revision.cannot)}
    </div>
  )
}
