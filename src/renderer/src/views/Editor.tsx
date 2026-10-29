import { useEffect, useState } from 'react'
import { api, type ProjectView, type VideoSpec } from '../api'
import { CostReceipt } from '../components/CostReceipt'
import { ErrorCard } from '../components/friendly'
import { SceneEditor } from '../components/SceneEditor'

/**
 * Editor — project details: generated VideoSpec structure and composition source
 * (full structured/conversational editing lands in P5 on this surface).
 */
export default function Editor({ initialProjectId, onBack }: { initialProjectId?: string | null; onBack: () => void }) {
  const [projects, setProjects] = useState<Array<{ id: string; title: string; prompt: string }>>([])
  const [activeId, setActiveId] = useState<string | null>(initialProjectId ?? null)
  const [project, setProject] = useState<ProjectView | null>(null)
  const [view, setView] = useState<'edit' | 'spec' | 'code'>('edit')
  // per-scene feedback → regenerate that scene
  const [editScene, setEditScene] = useState<string | null>(null)
  const [feedbackText, setFeedbackText] = useState('')
  const [revising, setRevising] = useState<{ sceneId: string; pct: number } | null>(null)
  const [reviseError, setReviseError] = useState<string | null>(null)

  useEffect(() => {
    api.listProjects().then((all) => {
      setProjects(all.map((p) => ({ id: p.id, title: p.title, prompt: p.prompt })))
      if (all.length > 0) setActiveId((cur) => cur ?? all[0].id)
    })
  }, [])

  useEffect(() => {
    if (activeId) api.getProject(activeId).then(setProject)
  }, [activeId])

  // live progress for a running scene revision
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.stage === 'revise' && e.status === 'failed') {
        setReviseError(e.error.slice(0, 200))
        setRevising(null)
      }
      if (e.stage === 'thumbs' && e.status === 'progress') {
        // fresh frame for the revised scene — swap it in immediately
        setProject((p) =>
          p ? { ...p, thumbs: p.thumbs.map((t, i) => (i === e.index ? e.dataUrl : t)) } : p
        )
      }
      if (e.stage === 'render' && e.status === 'progress') {
        setRevising((r) => (r ? { ...r, pct: e.pct } : r))
      }
      if (e.stage === 'revise' && e.status === 'done') {
        setRevising(null)
        if (activeId) api.getProject(activeId).then(setProject) // refreshed spec text
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId])

  const submitRevision = async (sceneId: string) => {
    if (!activeId || !feedbackText.trim() || revising) return
    setReviseError(null)
    const res = await api.reviseScene(activeId, sceneId, feedbackText.trim())
    if (!res.ok) {
      setReviseError(res.error ?? 'Could not start the revision')
      return
    }
    setRevising({ sceneId, pct: 0 })
    setEditScene(null)
    setFeedbackText('')
  }

  const applyEdit = async (edited: VideoSpec) => {
    if (!activeId || revising) return
    setReviseError(null)
    const res = await api.applyEdit(activeId, edited)
    if (!res.ok) {
      setReviseError(res.error ?? 'Could not start')
      return
    }
    setRevising({ sceneId: '*', pct: 0 })
  }

  const spec: VideoSpec | null = project?.spec ?? null

  return (
    <div className="page-bg grid h-full grid-cols-[260px_1fr]">
      {/* project list */}
      <div className="flex min-h-0 flex-col border-r-2 border-ink/5 bg-white/70">
        <button
          onClick={onBack}
          className="btn-ghost mx-3 mt-3 text-left"
        >
          ← Back to My videos
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="px-2 py-2 text-sm font-black">🎞️ Your videos</div>
          {projects.length === 0 && <div className="px-2 text-xs text-ink/45">Nothing yet.</div>}
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveId(p.id)}
              title={p.prompt}
              className={`mb-1 w-full rounded-xl px-3 py-2 text-left text-sm font-semibold transition-colors ${
                activeId === p.id ? 'bg-grape text-white shadow-[0_2px_0_#5b21b6]' : 'text-ink/80 hover:bg-grape-soft'
              }`}
            >
              <span className="line-clamp-2 leading-snug">{p.prompt}</span>
              <span className={`mt-0.5 block truncate text-[11px] font-medium ${activeId === p.id ? 'text-white/70' : 'text-ink/45'}`}>🎬 {p.title}</span>
            </button>
          ))}
        </div>
      </div>

      {/* detail */}
      <div className="flex min-h-0 flex-col">
        {!spec && (
          <div className="flex h-full items-center justify-center text-sm text-ink/45">
            👈 Pick a video on the left to see and change its scenes.
          </div>
        )}
        {spec && (
          <>
            <div className="flex items-center justify-between border-b-2 border-ink/5 bg-white/60 px-6 py-3.5">
              <div className="min-w-0">
                <div className="truncate text-sm text-ink/55" title={project?.meta?.prompt}>
                  {project?.meta?.prompt}
                </div>
                <div className="truncate text-xl font-black">{spec.title}</div>
              </div>
              <div className="flex items-center gap-1">
                {project?.meta?.renders[0] && (
                  <button
                    onClick={() => api.playProject(project.meta!.id, project.meta!.renders[0].file)}
                    title="Play the rendered video"
                    className="btn-primary mr-2"
                  >
                    ▶ Watch
                  </button>
                )}
                <button
                  onClick={() => setView('edit')}
                  className={`rounded-xl px-3 py-1.5 text-sm font-bold ${view === 'edit' ? 'bg-grape-soft text-grape' : 'text-ink/60 hover:bg-grape-soft'}`}
                >
                  ✂️ Edit
                </button>
                <button
                  onClick={() => setView('spec')}
                  className={`rounded-xl px-3 py-1.5 text-sm font-bold ${view === 'spec' ? 'bg-grape-soft text-grape' : 'text-ink/60 hover:bg-grape-soft'}`}
                >
                  🤖 Ask AI
                </button>
                <button
                  onClick={() => setView('code')}
                  className={`rounded-xl px-3 py-1.5 text-xs font-bold ${view === 'code' ? 'bg-ink/10 text-ink' : 'text-ink/40 hover:bg-ink/5'}`}
                  title="The raw HTML the video is rendered from (for tinkerers)"
                >
                  &lt;/&gt; Code
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              {view === 'edit' && (
                <div className="space-y-4">
                  {revising?.sceneId === '*' && (
                    <div className="card !border-sky/60 !bg-sky-soft p-4">
                      <div className="h-2 w-full overflow-hidden rounded-full bg-white">
                        <div className="progress-stripes h-full rounded-full transition-all" style={{ width: `${Math.max(4, revising.pct)}%` }} />
                      </div>
                      <div className="mt-1.5 text-sm font-bold text-sky">
                        {revising.pct > 0 ? `Making your new video — ${revising.pct}%` : 'Re-doing the voice, captions and music…'}
                      </div>
                    </div>
                  )}
                  {reviseError && <ErrorCard error={reviseError} />}
                  <SceneEditor projectId={activeId ?? ''} spec={spec} thumbs={project?.thumbs ?? []} busy={Boolean(revising)} onApply={applyEdit} />
                </div>
              )}
              {view === 'spec' && (
                <div className="space-y-3">
                  {project?.meta?.prompt && (
                    <div className="card p-4">
                      <div className="text-xs font-bold text-ink/50">💡 Your idea</div>
                      <p className="mt-1.5 text-sm leading-relaxed text-ink/80">{project.meta.prompt}</p>
                    </div>
                  )}
                  <div className="flex gap-2 text-[11px]">
                    <span className="rounded-full bg-grape-soft px-2.5 py-1 font-bold text-grape">📱 {spec.platform}</span>
                    <span className="rounded-full bg-sky-soft px-2.5 py-1 font-bold text-sky">🎨 {spec.style}</span>
                    <span className="rounded-full bg-berry-soft px-2.5 py-1 font-bold text-berry">🏃 {spec.pacing}</span>
                    <span className="rounded-full bg-sunny-soft px-2.5 py-1 font-bold text-ink/80">⏱️ {Math.round(spec.durationSec)}s</span>
                  </div>
                  {activeId && <CostReceipt projectId={activeId} key={`${activeId}-${revising ? 'r' : 'i'}`} />}
                  {reviseError && (
                    <ErrorCard error={reviseError} />
                  )}
                  {spec.scenes.map((s, i) => {
                    const isRevising = revising?.sceneId === s.id
                    const isEditing = editScene === s.id
                    return (
                      <div
                        key={s.id}
                        className={`card p-4 transition-colors ${isRevising ? '!border-sky/60 !bg-sky-soft' : ''}`}
                      >
                        <div className="flex items-center gap-3">
                          <span className="step-dot bg-grape">{i + 1}</span>
                          <span className="text-sm font-black">Scene {i + 1}</span>
                          <span className="ml-auto text-xs text-ink/50">{Math.round(s.durationSec * 10) / 10}s</span>
                          <button
                            onClick={() => {
                              setEditScene(isEditing ? null : s.id)
                              setFeedbackText('')
                            }}
                            disabled={Boolean(revising)}
                            title="Tell the AI what to change in this scene — it rewrites, recomposes and re-renders"
                            className="btn-ghost !py-1 disabled:opacity-40"
                          >
                            ✏️ Change this scene
                          </button>
                        </div>
                        {project?.thumbs[i] && (
                          <img
                            src={project.thumbs[i]}
                            alt={`scene ${i + 1}`}
                            className={`mt-3 max-h-64 w-full rounded-xl border-2 border-ink/10 object-cover ${
                              isRevising ? 'opacity-60' : ''
                            }`}
                          />
                        )}
                        <div className="mt-2 text-sm font-bold text-ink/80">
                          {'headline' in s ? s.headline : ''}
                          {'value' in s ? `${s.value} — ${s.label}` : ''}
                          {'text' in s ? s.text : ''}
                          {s.kind === 'bullets' ? s.headline : ''}
                        </div>
                        {'subline' in s && s.subline && <div className="mt-1 text-xs text-ink/60">{s.subline}</div>}
                        {'bullets' in s && (
                          <ul className="mt-1 list-disc pl-5 text-xs text-ink/60">
                            {s.bullets.map((b, j) => (
                              <li key={j}>{b}</li>
                            ))}
                          </ul>
                        )}
                        {isRevising && (
                          <div className="mt-3">
                            <div className="h-2 w-full overflow-hidden rounded-full bg-white">
                              <div
                                className="progress-stripes h-full rounded-full transition-all"
                                style={{ width: `${Math.max(4, revising.pct)}%` }}
                              />
                            </div>
                            <div className="mt-1 text-[11px] text-sky">
                              {revising.pct > 0
                                ? `Updating your video — ${revising.pct}%`
                                : 'Rewriting this scene…'}
                            </div>
                          </div>
                        )}
                        {isEditing && (
                          <div className="mt-3 rounded-2xl bg-grape-soft p-3">
                            <div className="mb-2 text-sm font-bold">
                              What should change in this scene?
                            </div>
                            <textarea
                              value={feedbackText}
                              onChange={(e) => setFeedbackText(e.target.value)}
                              placeholder={'e.g. "make the headline punchier and show the planet cracking open"\ne.g. "too much text — one short line only"\ne.g. "use a golden color instead of blue"'}
                              className="field h-20 w-full resize-none p-2.5 text-sm"
                            />
                            <div className="mt-2 flex items-center gap-2">
                              <button
                                onClick={() => submitRevision(s.id)}
                                disabled={!feedbackText.trim()}
                                className="btn-primary"
                              >
                                ✨ Redo this scene
                              </button>
                              <button
                                onClick={() => {
                                  setEditScene(null)
                                  setFeedbackText('')
                                }}
                                className="btn-ghost"
                              >
                                Cancel
                              </button>
                              <span className="text-[10px] text-ink/45">
                                Only this scene changes; the rest of your video stays the same.
                              </span>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
              {view === 'code' && (
                <pre className="max-h-full overflow-auto rounded-xl border border-ink/10 bg-paper p-4 text-[11px] leading-relaxed text-ink/80">
                  {project?.html ?? '// composition not generated yet'}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
