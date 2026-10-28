import { useEffect, useState } from 'react'
import { fmtUsd, PRICES_AS_OF } from '@shared/pricing'
import { api, type ProjectUsage, type UsageEntry } from '../api'

/**
 * The real bill for a video — every metered API call, priced from the
 * release's price book, grouped by what it was for. Live during a job
 * (`live`), or read from the project's usage.json (`projectId`).
 */

const KIND_ICON: Record<string, string> = { text: '🧠', image: '🖼️', voice: '🎙️', music: '🎵', sfx: '💥', video: '🎬', transcribe: '📝' }

function fmtUnits(e: UsageEntry): string {
  const u = e.usage
  const parts: string[] = []
  if (u.inputTokens || u.outputTokens) parts.push(`${Math.round((u.inputTokens ?? 0) / 100) / 10}k in · ${Math.round((u.outputTokens ?? 0) / 100) / 10}k out`)
  if (u.images) parts.push(`${u.images} image${u.images > 1 ? 's' : ''}`)
  if (u.chars) parts.push(`${u.chars} chars`)
  if (u.seconds && !u.images) parts.push(`${u.seconds.toFixed(1)}s`)
  return parts.join(' · ')
}

interface Line {
  key: string
  stage: string
  kind: string
  model: string
  calls: number
  usd: number
  saved: number
  units: string
  unpriced: boolean
}

function group(entries: UsageEntry[]): Line[] {
  const m = new Map<string, Line>()
  for (const e of entries) {
    const key = `${e.stage}|${e.model}|${e.saved ? 's' : ''}`
    const l = m.get(key) ?? { key, stage: e.stage, kind: e.kind, model: e.model, calls: 0, usd: 0, saved: 0, units: '', unpriced: false }
    l.calls += 1
    if (e.saved) l.saved += e.usd
    else l.usd += e.usd
    l.unpriced ||= !e.priced
    l.units = fmtUnits({ ...e, usage: sumUsage(entries.filter((x) => `${x.stage}|${x.model}|${x.saved ? 's' : ''}` === key)) })
    m.set(key, l)
  }
  return [...m.values()]
}

function sumUsage(es: UsageEntry[]): UsageEntry['usage'] {
  const out: Record<string, number> = {}
  for (const e of es) for (const [k, v] of Object.entries(e.usage)) out[k] = (out[k] ?? 0) + (v ?? 0)
  return out
}

export function CostReceipt({ projectId, live, compact }: { projectId?: string | null; live?: boolean; compact?: boolean }) {
  const [entries, setEntries] = useState<UsageEntry[]>([])
  const [history, setHistory] = useState<ProjectUsage | null>(null)

  useEffect(() => {
    if (!live) return
    setEntries([])
    return api.onUsage((p) => setEntries((prev) => [...prev, p.entry]))
  }, [live])

  useEffect(() => {
    if (!projectId || live) return
    const load = () => api.getProjectUsage(projectId).then(setHistory).catch(() => setHistory(null))
    load()
    // the receipt is filed when the job closes, just after its last pipeline event
    return api.onUsageRun((p) => {
      if (p.projectId === projectId) load()
    })
  }, [projectId, live])

  const all = live ? entries : (history?.runs.flatMap((r) => r.entries) ?? [])
  const total = all.filter((e) => !e.saved).reduce((a, e) => a + e.usd, 0)
  const saved = all.filter((e) => e.saved).reduce((a, e) => a + e.usd, 0)
  const lines = group(all)
  const runs = history?.runs.length ?? 0

  if (all.length === 0) {
    if (compact) return null
    return (
      <div className="rounded-2xl border-2 border-ink/10 bg-white p-4 text-xs text-ink/60">
        🧾 No paid API calls recorded for this video {live ? 'yet' : '— made with the free engine or before cost tracking existed'}.
      </div>
    )
  }

  if (compact) {
    return (
      <span className="rounded-full bg-sunny-soft px-2.5 py-1 text-[11px] font-bold text-ink" title="spent so far on this job">
        🧾 {fmtUsd(total)}
        {saved > 0 && <span className="ml-1.5 text-mint">· saved {fmtUsd(saved)}</span>}
      </span>
    )
  }

  return (
    <div className="rounded-2xl border-2 border-sunny/50 bg-sunny-soft p-4">
      <div className="flex items-baseline justify-between">
        <div className="text-sm font-bold text-ink">🧾 What this video cost</div>
        <div className="text-2xl font-black text-ink">{fmtUsd(total)}</div>
      </div>
      {saved > 0 && (
        <div className="mt-1 text-xs font-semibold text-mint">
          ♻️ Reused library assets saved you {fmtUsd(saved)}
        </div>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-xs font-bold text-grape">See the breakdown</summary>
      <div className="mt-2 space-y-1">
        {lines.map((l) => (
          <div key={l.key} className="flex items-center gap-2 text-[11px]">
            <span className="w-5 text-center">{KIND_ICON[l.kind] ?? '•'}</span>
            <span className="w-28 shrink-0 truncate font-semibold capitalize text-ink/80">{l.stage}</span>
            <span className="min-w-0 flex-1 truncate text-ink/60">
              {l.model} · {l.calls}× · {l.units}
            </span>
            <span className={`shrink-0 font-bold ${l.saved ? 'text-mint' : 'text-ink/80'}`}>
              {l.saved ? `−${fmtUsd(l.saved)}` : l.unpriced ? 'unpriced' : fmtUsd(l.usd)}
            </span>
          </div>
        ))}
      </div>
      </details>
      <div className="mt-2 text-[10px] text-ink/50">
        Paid to the AI companies through your own keys · prices as of {PRICES_AS_OF}
        {runs > 1 ? ` · ${runs} jobs (generate + reworks)` : ''}
      </div>
    </div>
  )
}
