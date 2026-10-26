import { useEffect, useState } from 'react'
import { api, type ProjectMeta } from '../api'

export default function Library({ onOpenEditor }: { onOpenEditor: () => void }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  const refresh = async () => {
    setProjects(await api.listProjects())
  }
  useEffect(() => {
    refresh()
  }, [])

  const statusColor: Record<ProjectMeta['status'], string> = {
    planning: 'bg-amber-400',
    composed: 'bg-sky-400',
    rendering: 'pulse-dot bg-[#00E5FF]',
    done: 'bg-emerald-400',
    error: 'bg-red-400'
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight">Library</h1>
          <p className="text-sm text-white/45">Every generated video is a resumable project on disk.</p>
        </div>
        <button onClick={refresh} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-bold hover:bg-white/5">
          Refresh
        </button>
      </div>

      {projects.length === 0 && (
        <div className="mt-24 text-center text-sm text-white/30">
          No projects yet — generate your first video in the Studio.
        </div>
      )}

      <div className="grid grid-cols-[fill] grid-cols-3 gap-4">
        {projects.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setSelected(p.id)
              onOpenEditor()
            }}
            className={`rounded-2xl border p-5 text-left transition-all ${
              selected === p.id ? 'border-[#7C5CFF]/60 bg-[#7C5CFF]/10' : 'border-white/10 bg-white/[0.03] hover:border-white/25'
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{p.title}</div>
                <div className="mt-0.5 truncate text-[11px] text-white/40">{p.prompt}</div>
              </div>
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${statusColor[p.status]}`} />
            </div>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-white/40">
              <span className="rounded bg-white/10 px-1.5 py-0.5 font-bold uppercase">{p.status}</span>
              <span>{p.renders.length} render(s)</span>
              <span className="ml-auto">{new Date(p.createdAt).toLocaleDateString()}</span>
            </div>
            {p.lastError && <div className="mt-2 truncate text-[11px] text-red-300/70">{p.lastError}</div>}
          </button>
        ))}
      </div>
    </div>
  )
}
