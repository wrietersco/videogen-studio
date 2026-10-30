import type { PipelineEvent } from '../api'

const STAGE_META: Record<PipelineEvent['stage'], { label: string; icon: string }> = {
  plan: { label: 'Story writer', icon: '🧠' },
  direct: { label: 'Scene designer', icon: '🎬' },
  plates: { label: 'Background painter', icon: '🖼' },
  critic: { label: 'Quality checker', icon: '👁' },
  compose: { label: 'Assembler', icon: '🎼' },
  qa: { label: 'Fixer', icon: '🛡' },
  custom: { label: 'Custom scene artist', icon: '🖌️' },
  thumbs: { label: 'Storyboard', icon: '📸' },
  revise: { label: 'Scene redo', icon: '🔁' },
  render: { label: 'Renderer', icon: '🎬' },
  pipeline: { label: 'Heads up', icon: '⚠️' },
  done: { label: 'All done', icon: '✅' }
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
    if (e.stage === 'custom') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: `building and testing ${e.total} custom scene(s)…`, state: 'run' })
      if (e.status === 'attempt') rows.push({ key, ...meta, detail: `scene ${e.sceneIndex + 1}: ${e.phase === 'authoring' ? 'building' : 'reviewing'} attempt ${e.attempt}`, state: 'run' })
      if (e.status === 'scene') rows.push({ key, ...meta, detail: `scene ${e.sceneIndex + 1}: ${e.accepted ? 'custom scene selected' : 'original retained'}${e.detail ? ` — ${e.detail.slice(0, 120)}` : ''}`, state: e.accepted ? 'ok' : 'warn' })
      if (e.status === 'done') rows.push({ key, ...meta, detail: 'custom scene review complete', state: 'ok' })
    }
    if (e.stage === 'plan') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: 'reading the brief…', state: 'run' })
      if (e.status === 'creative') rows.push({ key, ...meta, detail: `Format: ${e.platform} · ${e.durationHintSec}s · ${e.styleHint}. ${e.reason}`, state: 'info' })
      if (e.status === 'done')
        rows.push({
          key,
          ...meta,
          detail: `“${e.title}” — ${e.scenes} scenes · ${e.durationSec}s`,
          state: 'ok'
        })
    }
    if (e.stage === 'direct') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: `directing ${e.total} scene(s)…`, state: 'run' })
      if (e.status === 'film') rows.push({ key, ...meta, detail: `look: ${e.look} · “${e.series}”`, state: 'info' })
      if (e.status === 'scene')
        rows.push({
          key,
          ...meta,
          detail: `scene ${e.sceneIndex + 1}: “${e.headline.slice(0, 48)}” · ${e.background === 'plate' ? 'painted plate' : 'grid'}${e.widgets.length ? ' · ' + e.widgets.join(' + ') : ''}`,
          state: 'ok'
        })
      if (e.status === 'done') rows.push({ key, ...meta, detail: 'every scene directed', state: 'ok' })
    }
    if (e.stage === 'plates') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: `painting ${e.total} still(s) + depth maps…`, state: 'run' })
      if (e.status === 'scene') rows.push({ key, ...meta, detail: `scene ${e.sceneIndex + 1} painted · depth mapped`, state: 'ok' })
      if (e.status === 'failed') rows.push({ key, ...meta, detail: `scene ${e.sceneIndex + 1}: ${e.error} — using grid`, state: 'warn' })
      if (e.status === 'done') rows.push({ key, ...meta, detail: `${e.made} plate(s) ready`, state: 'ok' })
    }
    if (e.stage === 'critic') {
      if (e.status === 'started') rows.push({ key, ...meta, detail: 'watching the rendered frames…', state: 'run' })
      if (e.status === 'scene')
        rows.push({
          key,
          ...meta,
          detail: `scene ${e.sceneIndex + 1}: ${e.score}/10${e.notes[0] ? ' — ' + e.notes[0].slice(0, 70) : ''}`,
          state: e.score >= 7 ? 'ok' : 'warn'
        })
      if (e.status === 'done') rows.push({ key, ...meta, detail: e.revised ? `${e.revised} scene(s) sent back and rebuilt` : 'all scenes approved', state: 'ok' })
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
    if (e.stage === 'revise') {
      if (e.status === 'started')
        rows.push({ key, ...meta, detail: `scene ${e.sceneIndex + 1}: “${e.feedback.slice(0, 60)}”`, state: 'run' })
      if (e.status === 'scene-updated')
        rows.push({ key, ...meta, detail: `new scene ${e.sceneIndex + 1}: “${e.label.slice(0, 60)}”`, state: 'ok' })
      if (e.status === 'failed') rows.push({ key, ...meta, detail: e.error, state: 'fail' })
      if (e.status === 'done') rows.push({ key, ...meta, detail: `scene ${e.sceneIndex + 1} rebuilt + re-rendered`, state: 'ok' })
    }
    if (e.stage === 'thumbs') {
      if (e.status === 'started')
        rows.push({ key, ...meta, detail: `photographing ${e.total} scenes…`, state: 'run' })
      if (e.status === 'progress') {
        const last = rows[rows.length - 1]
        if (last && last.label === meta.label && last.state === 'run')
          last.detail = `scene ${e.index + 1} captured`
        else rows.push({ key, ...meta, detail: `scene ${e.index + 1} captured`, state: 'run' })
      }
      if (e.status === 'done') rows.push({ key, ...meta, detail: `${e.captured} frame(s) captured`, state: 'ok' })
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
    if (e.stage === 'pipeline' && e.status === 'failed') {
      rows.push({ key, ...meta, detail: e.error, state: 'fail' })
    }
    if (e.stage === 'pipeline' && e.status === 'cancelled') {
      rows.push({ key, ...meta, detail: 'stopped by user — project kept', state: 'warn' })
    }
    if (e.stage === 'done') {
      rows.push({ key, ...meta, detail: e.output.split(/[\\/]/).pop() ?? e.output, state: 'ok' })
    }
  })
  return rows
}

export function ActivityFeed({ events, running, onClose }: { events: PipelineEvent[]; running: boolean; onClose?: () => void }) {
  const rows = toRows(events)
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b-2 border-ink/5 px-5 py-3.5">
        <span className={`h-2.5 w-2.5 rounded-full ${running ? 'pulse-dot bg-berry' : 'bg-ink/20'}`} />
        <span className="text-sm font-black">🎬 Behind the scenes</span>
        {running && <span className="text-[11px] text-ink/45">working…</span>}
        {onClose && (
          <button onClick={onClose} className="ml-auto rounded-full px-2 text-ink/40 hover:bg-ink/5 hover:text-ink" title="Hide">
            ✕
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs leading-relaxed text-ink/45">
            Each AI helper — writer, designer, checker, renderer —
            <br />
            reports what it's doing here.
          </div>
        )}
        {rows.map((r, i) => (
          <div key={r.key} className={`slide-up flex items-start gap-3 rounded-xl px-3 py-2 ${i === rows.length - 1 ? 'bg-grape-soft' : ''}`}>
            <span className="mt-0.5 text-sm">{r.icon}</span>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-ink/85">{r.label}</div>
              <div className="truncate text-xs text-ink/55" title={r.detail}>
                {r.detail}
              </div>
            </div>
            <span
              className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                r.state === 'ok' ? 'bg-mint' : r.state === 'warn' ? 'bg-sunny' : r.state === 'fail' ? 'bg-coral' : 'pulse-dot bg-berry'
              }`}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
