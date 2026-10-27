import { useEffect, useState } from 'react'
import { api, type ProjectView, type VideoSpec } from '../api'

/**
 * Editor — project details: generated VideoSpec structure and composition source
 * (full structured/conversational editing lands in P5 on this surface).
 */
export default function Editor({ initialProjectId, onBack }: { initialProjectId?: string | null; onBack: () => void }) {
  const [projects, setProjects] = useState<Array<{ id: string; title: string }>>([])
  const [activeId, setActiveId] = useState<string | null>(initialProjectId ?? null)
  const [project, setProject] = useState<ProjectView | null>(null)
  const [view, setView] = useState<'spec' | 'code'>('spec')

  useEffect(() => {
    api.listProjects().then((all) => {
      setProjects(all.map((p) => ({ id: p.id, title: p.title })))
      if (all.length > 0) setActiveId((cur) => cur ?? all[0].id)
    })
  }, [])

  useEffect(() => {
    if (activeId) api.getProject(activeId).then(setProject)
  }, [activeId])

  const spec: VideoSpec | null = project?.spec ?? null

  return (
    <div className="grid h-full grid-cols-[260px_1fr]">
      {/* project list */}
      <div className="flex min-h-0 flex-col border-r border-white/5 bg-[#0d0d17]">
        <button
          onClick={onBack}
          className="mx-3 mt-3 rounded-lg border border-white/10 px-3 py-1.5 text-left text-xs font-bold text-white/70 hover:bg-white/5"
        >
          ← Back to Library
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="px-2 py-2 text-[11px] font-bold uppercase tracking-widest text-white/40">Projects</div>
          {projects.length === 0 && <div className="px-2 text-xs text-white/30">Nothing yet.</div>}
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveId(p.id)}
              className={`mb-1 w-full truncate rounded-lg px-3 py-2 text-left text-xs font-semibold ${
                activeId === p.id ? 'bg-[#7C5CFF]/20 text-[#b9a5ff]' : 'text-white/60 hover:bg-white/5'
              }`}
            >
              {p.title}
            </button>
          ))}
        </div>
      </div>

      {/* detail */}
      <div className="flex min-h-0 flex-col">
        {!spec && (
          <div className="flex h-full items-center justify-center text-sm text-white/30">
            Select a project — full timeline editing arrives with the editor milestone.
          </div>
        )}
        {spec && (
          <>
            <div className="flex items-center justify-between border-b border-white/5 px-6 py-3.5">
              <div className="text-sm font-black">{spec.title}</div>
              <div className="flex items-center gap-1">
                {project?.meta?.renders[0] && (
                  <button
                    onClick={() => api.playProject(project.meta!.id, project.meta!.renders[0].file)}
                    title="Play the rendered video"
                    className="mr-2 rounded-md bg-emerald-500/20 px-3 py-1 text-xs font-bold text-emerald-300 hover:bg-emerald-500/35"
                  >
                    ▶ Play
                  </button>
                )}
                <button
                  onClick={() => setView('spec')}
                  className={`rounded-md px-3 py-1 text-xs font-bold ${view === 'spec' ? 'bg-white/10' : 'text-white/50 hover:bg-white/5'}`}
                >
                  Storyboard
                </button>
                <button
                  onClick={() => setView('code')}
                  className={`rounded-md px-3 py-1 text-xs font-bold ${view === 'code' ? 'bg-white/10' : 'text-white/50 hover:bg-white/5'}`}
                >
                  Composition source
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-6">
              {view === 'spec' && (
                <div className="space-y-3">
                  <div className="flex gap-2 text-[11px]">
                    <span className="rounded bg-[#7C5CFF]/20 px-2 py-1 font-bold uppercase text-[#b9a5ff]">{spec.platform}</span>
                    <span className="rounded bg-[#00E5FF]/15 px-2 py-1 font-bold uppercase text-[#7fdff5]">{spec.style}</span>
                    <span className="rounded bg-white/10 px-2 py-1 font-bold uppercase text-white/60">{spec.pacing}</span>
                    <span className="rounded bg-white/10 px-2 py-1 font-bold uppercase text-white/60">{spec.durationSec}s @ {spec.fps}fps</span>
                  </div>
                  {spec.scenes.map((s, i) => (
                    <div key={s.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                      <div className="flex items-center gap-3">
                        <span className="text-[11px] font-black text-white/35">#{i + 1}</span>
                        <span className="rounded bg-white/10 px-2 py-0.5 text-[11px] font-bold uppercase text-white/70">
                          {s.kind}
                        </span>
                        <span className="ml-auto text-[11px] text-white/40">{s.durationSec}s · in: {s.transitionIn}</span>
                      </div>
                      <div className="mt-2 text-sm font-bold text-white/85">
                        {'headline' in s ? s.headline : ''}
                        {'value' in s ? `${s.value} — ${s.label}` : ''}
                        {'text' in s ? s.text : ''}
                        {s.kind === 'bullets' ? s.headline : ''}
                      </div>
                      {'subline' in s && s.subline && <div className="mt-1 text-xs text-white/45">{s.subline}</div>}
                      {'bullets' in s && (
                        <ul className="mt-1 list-disc pl-5 text-xs text-white/55">
                          {s.bullets.map((b, j) => (
                            <li key={j}>{b}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {view === 'code' && (
                <pre className="max-h-full overflow-auto rounded-xl border border-white/10 bg-black/40 p-4 text-[11px] leading-relaxed text-white/70">
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
