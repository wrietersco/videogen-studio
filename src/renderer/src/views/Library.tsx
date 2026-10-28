import { useEffect, useState } from 'react'
import { api, type PipelineEvent, type ProjectMeta } from '../api'
import { EmptyState } from '../components/ui'

export default function Library({ onOpenEditor }: { onOpenEditor: (id?: string) => void }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [rerendering, setRerendering] = useState<{ id: string; pct: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const refresh = async () => {
    setProjects(await api.listProjects())
  }

  useEffect(() => {
    refresh()
    // live progress for re-renders triggered from this view
    const unsub = api.onEvent((e: PipelineEvent) => {
      if (e.stage === 'render' && e.status === 'progress' && rerendering) {
        setRerendering({ id: rerendering.id, pct: e.pct })
      }
      if (e.stage === 'render' && e.status === 'done') {
        setRerendering(null)
        setToast('✔ Re-render complete')
        refresh()
      }
      if (e.stage === 'pipeline' && e.status === 'cancelled') {
        setRerendering(null)
        refresh()
      }
      if (e.stage === 'pipeline' && e.status === 'failed') {
        setRerendering(null)
        setToast(`Render failed: ${e.error.slice(0, 120)}`)
        refresh()
      }
    })
    return () => unsub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rerendering?.id])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const remove = async (id: string) => {
    const res = await api.deleteProject(id)
    if (!res.ok) setToast(res.error ?? 'Could not delete project')
    setConfirmDelete(null)
    refresh()
  }

  const rerender = async (id: string) => {
    const res = await api.rerenderProject(id)
    if (!res.ok) {
      setToast(res.error ?? 'Could not start re-render')
      return
    }
    setRerendering({ id, pct: 0 })
  }

  const resume = async (id: string) => {
    const res = await api.resumeProject(id)
    if (!res.ok) {
      setToast(res.error ?? 'Could not resume')
      return
    }
    setRerendering({ id, pct: 0 })
    setToast('Resuming from last saved stage…')
  }

  /** projects that never finished → resumable (crash / quit / stop) */
  const isInterrupted = (p: ProjectMeta) =>
    p.status === 'planning' || p.status === 'composed' || p.status === 'rendering' || p.status === 'cancelled'

  const statusColor: Record<ProjectMeta['status'], string> = {
    planning: 'bg-amber-400',
    composed: 'bg-sky-400',
    rendering: 'pulse-dot bg-[#00E5FF]',
    done: 'bg-emerald-400',
    error: 'bg-red-400',
    cancelled: 'bg-white/30'
  }

  return (
    <div className="relative h-full overflow-y-auto p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight">🎞️ My videos</h1>
          <p className="text-sm text-white/45">
            Everything you've made. Play it, re-render it, open it in the Editor to rework a scene, or see what it cost.
          </p>
        </div>
        <button onClick={refresh} className="btn-ghost">
          🔄 Refresh
        </button>
      </div>

      {toast && (
        <div className="slide-up fixed right-6 top-14 z-50 rounded-xl border border-white/15 bg-[#171725] px-4 py-3 text-xs font-semibold text-white/85 shadow-2xl">
          {toast}
        </div>
      )}

      {projects.length === 0 && (
        <EmptyState emoji="🎬" title="No videos yet">
          Head to ✨ Create, type an idea, and your first video lands here.
        </EmptyState>
      )}

      <div className="grid grid-cols-3 gap-4">
        {projects.map((p) => {
          const busyHere = rerendering?.id === p.id
          return (
            <div
              key={p.id}
              className={`rounded-2xl border p-5 transition-all ${
                selected === p.id ? 'border-[#7C5CFF]/60 bg-[#7C5CFF]/10' : 'border-white/10 bg-white/[0.03]'
              }`}
            >
              <button
                onClick={() => {
                  setSelected(p.id)
                  onOpenEditor(p.id)
                }}
                className="block w-full text-left"
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

              {busyHere && (
                <div className="mt-3">
                  <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div
                      className="h-full bg-gradient-to-r from-[#7C5CFF] to-[#00E5FF] transition-all"
                      style={{ width: `${Math.max(4, rerendering.pct)}%` }}
                    />
                  </div>
                  <div className="mt-1 text-[10px] text-white/40">re-rendering — {rerendering.pct}%</div>
                </div>
              )}

              {/* actions */}
              <div className="mt-4 flex flex-wrap gap-1.5">
                {p.renders[0] && (
                  <button
                    onClick={() => api.playProject(p.id, p.renders[0].file)}
                    title="Play the rendered video"
                    className="rounded-lg bg-emerald-500/20 px-2.5 py-1.5 text-[11px] font-bold text-emerald-300 hover:bg-emerald-500/35"
                  >
                    ▶ Play
                  </button>
                )}
                {isInterrupted(p) && (
                  <button
                    onClick={() => resume(p.id)}
                    disabled={Boolean(rerendering)}
                    title="Continue from the last saved stage (spec, composition and QA results are reused — no repeat LLM cost)"
                    className="rounded-lg bg-emerald-500/20 px-2.5 py-1.5 text-[11px] font-bold text-emerald-300 hover:bg-emerald-500/35 disabled:opacity-40"
                  >
                    ▶ Resume
                  </button>
                )}
                <button
                  onClick={() => rerender(p.id)}
                  disabled={Boolean(rerendering)}
                  title="Re-render this project with current quality settings"
                  className="rounded-lg bg-[#7C5CFF]/20 px-2.5 py-1.5 text-[11px] font-bold text-[#b9a5ff] hover:bg-[#7C5CFF]/35 disabled:opacity-40"
                >
                  ⟳ Re-render
                </button>
                <button
                  onClick={() => api.revealProject(p.id)}
                  title="Show the project folder in Explorer"
                  className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] font-bold text-white/70 hover:bg-white/15"
                >
                  📂 Folder
                </button>
                {p.renders[0] && (
                  <button
                    onClick={() => api.revealProject(p.id, p.renders[0].file)}
                    title="Show the rendered MP4 in Explorer"
                    className="rounded-lg bg-white/5 px-2.5 py-1.5 text-[11px] font-bold text-white/70 hover:bg-white/15"
                  >
                    🎬 MP4
                  </button>
                )}
                {confirmDelete === p.id ? (
                  <span className="ml-auto flex gap-1">
                    <button
                      onClick={() => remove(p.id)}
                      className="rounded-lg bg-red-500/80 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-red-500"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="rounded-lg bg-white/10 px-2.5 py-1.5 text-[11px] font-bold text-white/70 hover:bg-white/20"
                    >
                      ✕
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDelete(p.id)}
                    title="Delete this project permanently"
                    className="ml-auto rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] font-bold text-red-300/80 hover:bg-red-500/25"
                  >
                    🗑
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
