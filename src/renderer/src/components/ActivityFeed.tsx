import type { PipelineEvent } from '../api'

const STAGE_META: Record<PipelineEvent['stage'], { label: string; icon: string }> = {
  plan: { label: 'Planner', icon: '🧠' },
  compose: { label: 'Composer', icon: '🎼' },
  qa: { label: 'QA Agents', icon: '🛡' },
  render: { label: 'Renderer', icon: '🎬' },
  done: { label: 'Pipeline', icon: '✅' }
}

interface Row {
  key: string
  icon: string
  label: string
  detail: string
  state: 'run' | 'ok' | 'warn' | 'fail' | 'info'
}

function toRows(events: PipelineEvent[]): Row[] {
  const rows: Row[] = []
  events.forEach((e, i) => {
    const meta = STAGE_META[e.stage]
    const key = `${i}-${e.stage}-${'status' in e ? e.status : 'final'}`
    if (e.stage === 'plan') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: 'reading the brief…', state: 'run' })
      if (e.status === 'done')
        rows.push({
          key,
          ...meta,
          detail: `“${e.title}” — ${e.scenes} scenes · ${e.durationSec}s`,
          state: 'ok'
        })
    }
    if (e.stage === 'compose') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: 'writing the composition…', state: 'run' })
      if (e.status === 'done') rows.push({ key, ...meta, detail: 'HyperFrames project ready', state: 'ok' })
    }
    if (e.stage === 'qa') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: 'lint · layout · motion · contrast…', state: 'run' })
      if (e.status === 'fixing')
        rows.push({
          key,
          ...meta,
          detail: `fix attempt ${e.attempt}: ${e.issues[0] ?? 'issues found'}`,
          state: 'warn'
        })
      if (e.status === 'done')
        rows.push({ key, ...meta, detail: `clean · ${e.warnings} warning(s)`, state: 'ok' })
      if (e.status === 'failed')
        rows.push({ key, ...meta, detail: e.issues.slice(0, 2).join(' · '), state: 'fail' })
    }
    if (e.stage === 'render') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: 'encoding frames…', state: 'run' })
      if (e.status === 'progress') {
        // replace last progress row instead of appending
        const last = rows[rows.length - 1]
        if (last && last.label === meta.label && last.state === 'run') last.detail = `encoding — ${e.pct}%`
        else rows.push({ key, ...meta, detail: `encoding — ${e.pct}%`, state: 'run' })
      }
      if (e.status === 'done')
        rows.push({ key, ...meta, detail: `done in ${e.wallSec.toFixed(1)}s`, state: 'ok' })
      if (e.status === 'failed') rows.push({ key, ...meta, detail: e.error, state: 'fail' })
    }
    if (e.stage === 'done') {
      rows.push({ key, ...meta, detail: e.output.split(/[\\/]/).pop() ?? e.output, state: 'ok' })
    }
  })
  return rows
}

export function ActivityFeed({ events, running }: { events: PipelineEvent[]; running: boolean }) {
  const rows = toRows(events)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/5 px-5 py-3.5">
        <span className={`h-2 w-2 rounded-full ${running ? 'pulse-dot bg-[#00E5FF]' : 'bg-white/25'}`} />
        <span className="text-xs font-bold uppercase tracking-widest text-white/60">Agent Activity</span>
        {running && <span className="ml-auto text-[11px] text-white/35">working…</span>}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs leading-relaxed text-white/30">
            The planner, composer, QA fixers and renderer
            <br />
            report their progress here in real time.
          </div>
        )}
        {rows.map((r, i) => (
          <div
            key={r.key}
            className={`slide-up flex items-start gap-3 rounded-lg px-3 py-2 ${
              i === rows.length - 1 ? 'bg-white/[0.05]' : ''
            }`}
          >
            <span className="mt-0.5 text-sm">{r.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-white/75">{r.label}</div>
              <div className="truncate text-xs text-white/45">{r.detail}</div>
            </div>
            <span
              className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                r.state === 'ok'
                  ? 'bg-emerald-400'
                  : r.state === 'warn'
                    ? 'bg-amber-400'
                    : r.state === 'fail'
                      ? 'bg-red-400'
                      : 'pulse-dot bg-[#00E5FF]'
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
