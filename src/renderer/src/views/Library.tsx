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

  /** status in plain words, with a colour people can read at a glance */
  const statusInfo = (p: ProjectMeta): { text: string; cls: string } => {
    if (rerendering?.id === p.id) return { text: '⏳ Working…', cls: 'bg-sky-soft text-sky' }
    if (p.status === 'done') return { text: '✅ Ready', cls: 'bg-mint-soft text-mint' }
    if (p.status === 'error') return { text: '😕 Didn’t finish', cls: 'bg-coral-soft text-coral' }
    return { text: '⏸️ Not finished', cls: 'bg-sunny-soft text-ink/80' }
  }

  return (
    <div className="page-bg relative h-full overflow-y-auto">
      <div className="p-8">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight">🎞️ My videos</h1>
            <p className="mt-1 text-[15px] text-ink/60">Everything you've made. Press ▶ to watch, or ✏️ to change a scene.</p>
          </div>
          <button onClick={refresh} className="btn-ghost" title="Check for new videos">
            🔄 Refresh
          </button>
        </div>

        {toast && (
          <div className="pop-in fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-2xl border-2 border-ink/10 bg-white px-4 py-3 text-sm font-semibold text-ink shadow-2xl">
            {toast}
          </div>
        )}

        {projects.length === 0 && (
          <EmptyState emoji="🎬" title="No videos yet">
            Go to ✨ Create, type an idea, and your first video will show up here.
          </EmptyState>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-5">
          {projects.map((p, idx) => {
            const busyHere = rerendering?.id === p.id
            const st = statusInfo(p)
            const play = p.renders[0] ? () => api.playProject(p.id, p.renders[0].file) : undefined
            return (
              <div
                key={p.id}
                className={`card pop-in overflow-hidden transition-transform hover:-translate-y-0.5 ${selected === p.id ? '!border-grape' : ''}`}
                style={{ animationDelay: `${Math.min(idx, 8) * 50}ms` }}
              >
                <Poster id={p.id} title={p.title} onPlay={play} />
                <div className="p-4">
                  {/* the user's own words identify the video; the film's title comes second */}
                  <div className="line-clamp-2 min-h-[2.6em] text-[15px] font-bold leading-snug" title={p.prompt}>
                    {p.prompt}
                  </div>
                  <div className="mt-1 truncate text-xs text-ink/55" title={p.title}>
                    🎬 {p.title}
                  </div>
                  <div className="mt-2.5 flex items-center gap-2 text-[11px] text-ink/55">
                    <span className={`rounded-full px-2 py-0.5 font-bold ${st.cls}`}>{st.text}</span>
                    <span className="ml-auto">{new Date(p.createdAt).toLocaleDateString()}</span>
                  </div>
                  {p.lastError && (
                    <div className="mt-2 truncate text-[11px] text-coral" title={p.lastError}>
                      {p.lastError}
                    </div>
                  )}

                  {busyHere && (
                    <div className="mt-3">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-ink/5">
                        <div className="progress-stripes h-full rounded-full transition-all" style={{ width: `${Math.max(6, rerendering.pct)}%` }} />
                      </div>
                      <div className="mt-1 text-[11px] text-ink/60">Working on it — {rerendering.pct}%</div>
                    </div>
                  )}

                  {/* actions: one obvious main button, the rest small */}
                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                    {play ? (
                      <button onClick={play} title="Play the finished video" className="btn-primary">
                        ▶ Watch
                      </button>
                    ) : isInterrupted(p) || p.status === 'error' ? (
                      <button
                        onClick={() => resume(p.id)}
                        disabled={Boolean(rerendering)}
                        title="Pick up where it stopped — finished parts are reused, so it costs nothing extra"
                        className="btn-primary"
                      >
                        ▶ Finish it
                      </button>
                    ) : null}
                    <button
                      onClick={() => {
                        setSelected(p.id)
                        onOpenEditor(p.id)
                      }}
                      title="Change a scene, or see what this video cost"
                      className="btn-ghost !px-2.5"
                    >
                      ✏️ Edit
                    </button>
                    <button
                      onClick={() => api.revealProject(p.id, p.renders[0]?.file)}
                      title={p.renders[0] ? 'Show the video file in Explorer' : 'Show the project folder in Explorer'}
                      className="btn-ghost !px-2.5"
                    >
                      📁
                    </button>
                    <button
                      onClick={() => rerender(p.id)}
                      disabled={Boolean(rerendering)}
                      title="Make the video file again with your current quality settings"
                      className="btn-ghost !px-2.5 disabled:opacity-40"
                    >
                      🔁
                    </button>
                    {confirmDelete === p.id ? (
                      <span className="ml-auto flex items-center gap-1">
                        <button onClick={() => remove(p.id)} className="rounded-xl bg-coral px-2.5 py-1.5 text-xs font-bold text-white">
                          Delete forever
                        </button>
                        <button onClick={() => setConfirmDelete(null)} className="rounded-xl px-2 py-1.5 text-xs font-bold text-ink/60 hover:bg-ink/5">
                          Keep
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(p.id)}
                        title="Delete this video"
                        className="ml-auto rounded-xl px-2 py-1.5 text-sm text-ink/40 transition-colors hover:bg-coral-soft hover:text-coral"
                      >
                        🗑
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

const POSTER_GRADIENTS = ['from-grape to-berry', 'from-sky to-grape', 'from-berry to-sunny', 'from-mint to-sky', 'from-sunny to-coral']

/** cover: the first storyboard frame when the project has one, else a cheerful gradient with the title */
function Poster({ id, title, onPlay }: { id: string; title: string; onPlay?: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api
      .getProject(id)
      .then((v) => live && setThumb(v.thumbs?.[0] ?? null))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [id])
  const grad = POSTER_GRADIENTS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % POSTER_GRADIENTS.length]
  return (
    <button
      onClick={onPlay}
      disabled={!onPlay}
      className={`group relative block aspect-video w-full overflow-hidden bg-gradient-to-br ${grad}`}
      title={onPlay ? 'Watch' : title}
    >
      {thumb ? (
        <img src={thumb} alt="" className="thumb-in h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center p-4 text-center text-lg font-black leading-tight text-white drop-shadow">{title}</div>
      )}
      {onPlay && (
        <span className="absolute inset-0 flex items-center justify-center transition-colors group-hover:bg-ink/25">
          <span className="flex h-12 w-12 scale-90 items-center justify-center rounded-full bg-white text-lg text-grape opacity-0 shadow-lg transition-all group-hover:scale-100 group-hover:opacity-100">
            ▶
          </span>
        </span>
      )}
    </button>
  )
}
