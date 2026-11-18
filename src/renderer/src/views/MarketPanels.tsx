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
