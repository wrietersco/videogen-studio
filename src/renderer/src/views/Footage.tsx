import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type EditPlan, type EditRecord, type FootageEvent, type FootageProject, type FootageSummary, type PlanRequest, type PlanResult, type UnderstandEstimate } from '../api'
import { ShapePicker } from '../components/PromptTools'
import { fmtUsd } from '@shared/pricing'
import { AI_CLIP_MAX, AI_CLIP_MAX_SEC, AI_CLIP_MIN_SEC, AI_CLIP_USD_PER_SEC, aiClipsIn, aiCostUsd, fmtClock, planDuration, segmentStarts, MUSIC_MOODS, type MusicChoice, type PlanSegment, type PlanTitle } from '@shared/footage'
import { shapeOf, type ShapeId } from '@shared/shapes'
import type { PlatformId } from '@shared/spec'

/** the apps people know; each one implies a shape */
const APPS: Array<{ id: PlatformId; label: string; emoji: string }> = [
  { id: 'tiktok', label: 'TikTok', emoji: '🎵' },
  { id: 'instagram-reels', label: 'Reels / Stories', emoji: '📸' },
  { id: 'youtube-shorts', label: 'YT Shorts', emoji: '▶️' },
  { id: 'youtube', label: 'YouTube', emoji: '📺' },
  { id: 'instagram-feed', label: 'Insta post', emoji: '🖼️' },
  { id: 'facebook-feed', label: 'Facebook', emoji: '👍' },
  { id: 'square', label: 'X · LinkedIn · WhatsApp', emoji: '💬' }
]

const LENGTHS: Array<{ sec: number; label: string }> = [
  { sec: 0, label: '🪄 Editor decides' },
  { sec: 15, label: '⚡ 15s' },
  { sec: 30, label: '⏱️ 30s' },
  { sec: 60, label: '🎬 60s' },
  { sec: 90, label: '📽️ 90s' }
]

const IDEAS = ['The best moments, fast and fun, with upbeat music', 'A calm story of the whole day in order', 'A 30-second highlight reel for social media', 'Only the parts where someone is talking, cleaned up']

type Job = 'scan' | 'understand' | 'plan' | 'render' | null
type MusicMode = 'editor' | 'none' | 'file'

export default function Footage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [projects, setProjects] = useState<FootageSummary[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const refresh = useCallback(() => api.footage.list().then(setProjects).catch(() => setProjects([])), [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  if (openId) return <ProjectView key={openId} id={openId} onBack={() => { setOpenId(null); void refresh() }} onOpenSettings={onOpenSettings} />
  return <ProjectList projects={projects} onOpen={setOpenId} onChanged={refresh} />
}

// ------------------------------------------------------------------ list + create

function ProjectList({ projects, onOpen, onChanged }: { projects: FootageSummary[] | null; onOpen: (id: string) => void; onChanged: () => void }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [folders, setFolders] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const pick = async () => {
    const picked = await api.footage.pickFolders()
    if (picked.length) setFolders((f) => [...new Set([...f, ...picked])])
  }
  const create = async () => {
    setError(null)
    const res = await api.footage.create(name.trim() || folderName(folders[0]) || 'My footage', folders)
    if (!res.ok) return setError(res.error)
    await api.footage.scan(res.project.id)
    onChanged()
    onOpen(res.project.id)
  }

  return (
    <div className="page-bg h-full overflow-y-auto">
      <div className="px-8 pb-16 pt-8">
        <h1 className="text-3xl font-black tracking-tight">
          <span className="float inline-block">🎬</span> Edit my footage
        </h1>
        <p className="mt-1 max-w-3xl text-[15px] text-ink/60">
          Point us at the folders with your own videos. The AI editor watches them, then cuts, joins, adds music and balances the sound into a brand-new video. Your original files are never changed.
        </p>

        {!creating ? (
          <button onClick={() => setCreating(true)} className="btn-primary mt-5 !px-6 !py-3">
            ➕ New footage project
          </button>
        ) : (
          <section className="card slide-up mt-5 p-5">
            <div className="text-base font-black">New footage project</div>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Name, e.g. Beach holiday" className="field mt-3 w-full max-w-md px-4 py-2.5 text-sm" />
            <div className="mt-4 text-sm font-bold">Folders with your videos</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {folders.map((f) => (
                <span key={f} className="inline-flex items-center gap-1.5 rounded-full border-2 border-sky/40 bg-sky-soft px-3 py-1 text-xs font-semibold" title={f}>
                  📁 {folderName(f)}
                  <button onClick={() => setFolders((all) => all.filter((x) => x !== f))} className="text-ink/40 hover:text-coral" aria-label={`Remove ${folderName(f)}`}>
                    ✕
                  </button>
                </span>
              ))}
              <button onClick={pick} className="btn-ghost !px-4 !py-1.5 !text-sm">
                📂 {folders.length ? 'Add another folder' : 'Choose folders…'}
              </button>
            </div>
            <div className="mt-1 text-[11px] text-ink/50">Sub-folders are included. We only read your videos — nothing is moved, changed or deleted.</div>
            {error && <div className="mt-3 rounded-xl bg-coral-soft px-3 py-2 text-xs font-semibold text-coral">⚠️ {error}</div>}
            <div className="mt-4 flex gap-2">
              <button onClick={create} disabled={!folders.length} className="btn-primary !px-5 !py-2 !text-sm">
                ✅ Create and scan
              </button>
              <button onClick={() => { setCreating(false); setFolders([]); setError(null) }} className="btn-ghost !py-2 !text-sm">
                Cancel
              </button>
            </div>
          </section>
        )}

        <div className="mt-8 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects?.map((p) => (
            <div key={p.id} className="card flex flex-col p-4">
              <div className="truncate text-base font-black">{p.name}</div>
              <div className="mt-1 text-xs text-ink/55">
                {p.clipCount} video{p.clipCount === 1 ? '' : 's'} · {fmtClock(p.totalSec)} of footage · {p.editCount} edit{p.editCount === 1 ? '' : 's'}
              </div>
              <div className="mt-1 truncate text-[11px] text-ink/40" title={p.folders.join('\n')}>
                📁 {p.folders.map(folderName).join(', ')}
              </div>
              <div className="mt-3 flex gap-2">
                <button onClick={() => onOpen(p.id)} className="btn-primary !px-4 !py-1.5 !text-sm">
                  Open
                </button>
                <button
                  onClick={async () => {
                    if (!window.confirm(`Delete the footage project “${p.name}”?\n\nThis removes its notes and the videos you made with it. Your original video files are not touched.`)) return
                    await api.footage.remove(p.id)
                    onChanged()
                  }}
                  className="btn-ghost !py-1.5 !text-sm"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {projects && !projects.length && !creating && <div className="rounded-2xl border-2 border-dashed border-ink/15 p-8 text-center text-sm text-ink/50 md:col-span-2 xl:col-span-3">No footage projects yet. Create one to get started.</div>}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ one project

function ProjectView({ id, onBack, onOpenSettings }: { id: string; onBack: () => void; onOpenSettings: () => void }) {
  const [project, setProject] = useState<FootageProject | null>(null)
  const [posters, setPosters] = useState<Record<string, string>>({})
  const [estimate, setEstimate] = useState<UnderstandEstimate | null>(null)
  const [job, setJob] = useState<Job>(null)
  const [progress, setProgress] = useState<{ done: number; total: number; note?: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)

  // the brief
  const [prompt, setPrompt] = useState('')
  const [platform, setPlatform] = useState<PlatformId>('tiktok')
  const [seconds, setSeconds] = useState(0)
  const [musicMode, setMusicMode] = useState<MusicMode>('editor')
  const [musicFile, setMusicFile] = useState<string | null>(null)
  const [loudness, setLoudness] = useState<EditPlan['loudness']>('social')
  const [captions, setCaptions] = useState<EditPlan['captions']>('off')
  const [wantTitles, setWantTitles] = useState(true)
  const [tighten, setTighten] = useState(false)
  const [shortsN, setShortsN] = useState(1)
  const [aiScenes, setAiScenes] = useState(false)
  const [caps, setCaps] = useState<{ ai: boolean }>({ ai: false })

  // the plans being reviewed (several when shorts were asked for) and the render
  const [planned, setPlanned] = useState<{ n: number; shorts: Array<{ plan: EditPlan; thumbs: string[] }>; source: PlanResult['source']; prompt: string } | null>(null)
  /** what each review currently holds, so "make all" uses the person's changes */
  const edited = useRef<EditPlan[]>([])
  /** plans still waiting their turn after "make all" */
  const queue = useRef<{ plans: EditPlan[]; prompt: string }>({ plans: [], prompt: '' })
  const [renderPct, setRenderPct] = useState<{ pct: number; phase: string } | null>(null)
  const [madeList, setMadeList] = useState<EditRecord[]>([])
  const planRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const p = await api.footage.get(id)
    setProject(p)
    if (p) {
      setPosters(await api.footage.posters(id))
      setEstimate(await api.footage.estimate(id))
    }
  }, [id])

  useEffect(() => {
    void load()
    api.footage.capabilities().then(setCaps)
    // opened while a scan or render is already running (e.g. straight after creating the project)
    api.footage.status().then((st) => {
      if (st?.projectId === id) {
        setJob(st.kind)
        if (st.kind === 'render') setRenderPct({ pct: 0, phase: 'Working' })
      }
    })
  }, [load, id])

  /** start a render; right after another one ends the app may need a moment before it accepts the next */
  const startRender = (plan: EditPlan, why: string, tries = 0) => {
    void api.footage.render(id, plan, why).then((res) => {
      if (res.ok) return
      if (tries < 6) setTimeout(() => startRender(plan, why, tries + 1), 700)
      else {
        queue.current.plans = []
        setError(res.error ?? 'Could not start')
      }
    })
  }

  useEffect(
    () =>
      api.footage.onEvent((e: FootageEvent) => {
        if (e.projectId !== id) return
        if (e.kind === 'scan' || e.kind === 'understand') {
          const name = e.kind
          if (e.status === 'started') {
            setJob(name)
            setProgress({ done: 0, total: 0 })
          } else if (e.status === 'progress') setProgress({ done: e.done ?? 0, total: e.total ?? 0, note: e.kind === 'scan' ? e.clipName : e.note })
          else {
            setJob(null)
            setProgress(null)
            if (e.status === 'failed') setError(e.error ?? 'Something went wrong')
            else if (e.note) setNotice(e.note)
            void load()
          }
        } else {
          if (e.status === 'started') {
            setJob('render')
            setRenderPct({ pct: 0, phase: 'Starting' })
          } else if (e.status === 'progress') setRenderPct({ pct: e.pct ?? 0, phase: e.phase ?? '' })
          else {
            setJob(null)
            setRenderPct(null)
            if (e.status === 'failed') setError(e.error ?? 'The video could not be made')
            if (e.status === 'cancelled') setNotice('Stopped. Nothing was saved.')
            if (e.status === 'done' && e.edit) setMadeList((l) => [...l, e.edit!])
            // "make all": start the next one, or stop the line if this one did not finish
            const next = e.status === 'done' ? queue.current.plans.shift() : undefined
            if (e.status !== 'done') queue.current.plans = []
            if (next) startRender(next, queue.current.prompt)
            void load()
          }
        }
      }),
    [id, load]
  )

  if (!project) return <div className="page-bg flex h-full items-center justify-center text-sm text-ink/50">Loading…</div>

  const ok = project.clips.filter((c) => c.status === 'ok')
  const skipped = project.clips.filter((c) => c.status === 'unreadable')
  const missing = project.clips.filter((c) => c.status === 'missing')
  const unwatched = ok.filter((c) => !c.watched).length
  const busy = job !== null
  const shape: ShapeId = shapeOf(platform)
  const understandable = estimate && (estimate.shots > 0 || estimate.speechMinutes > 0)

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null)
    setNotice(null)
    const res = await fn()
    if (!res.ok) setError(res.error ?? 'Could not start')
  }

  const makePlan = async () => {
    setError(null)
    setNotice(null)
    setMadeList([])
    queue.current.plans = []
    setJob('plan')
    const music: PlanRequest['music'] = musicMode === 'editor' ? 'auto-mood' : musicMode === 'none' ? { mode: 'none', mood: 'upbeat' } : { mode: 'file', mood: 'upbeat', file: musicFile ?? undefined }
    const res = await api.footage.plan(id, { prompt: prompt.trim(), shape, durationSec: seconds || undefined, music, loudness, captions, titles: wantTitles, tighten, shorts: shortsN, aiClips: aiScenes && caps.ai })
    setJob(null)
    if (!res.ok) return setError(res.error)
    setPlanned((old) => ({ n: (old?.n ?? 0) + 1, shorts: res.result.shorts ?? [{ plan: res.result.plan, thumbs: res.result.thumbs }], source: res.result.source, prompt: prompt.trim() }))
    edited.current = (res.result.shorts ?? [{ plan: res.result.plan }]).map((x) => x.plan)
    setTimeout(() => planRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }

  const pickMusic = async () => {
    const f = await api.footage.pickMusic()
    if (f) {
      setMusicFile(f)
      setMusicMode('file')
    }
  }

  return (
    <div className="page-bg h-full overflow-y-auto">
      <div className="px-8 pb-24 pt-6">
        <button onClick={onBack} disabled={busy} className="text-xs font-bold text-grape hover:underline disabled:opacity-40">
          ← All footage projects
        </button>
        <h1 className="mt-1 text-3xl font-black tracking-tight">🎬 {project.name}</h1>

        {/* 1 · footage */}
        <section className="card mt-5 p-5">
          <StepTitle n={1} color="bg-sky" title="Your footage" />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {project.folders.map((f) => (
              <span key={f} className="inline-flex items-center gap-1.5 rounded-full border-2 border-sky/40 bg-sky-soft px-3 py-1 text-xs font-semibold" title={f}>
                📁 {folderName(f)}
                <button
                  disabled={busy}
                  onClick={async () => {
                    if (!window.confirm(`Stop using “${folderName(f)}” in this project?\n\nYour video files stay exactly where they are.`)) return
                    await api.footage.removeFolder(id, f)
                    await load()
                  }}
                  className="text-ink/40 hover:text-coral disabled:opacity-30"
                  aria-label={`Remove ${folderName(f)}`}
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              disabled={busy}
              onClick={async () => {
                const picked = await api.footage.pickFolders()
                if (!picked.length) return
                const res = await api.footage.addFolders(id, picked)
                if (!res.ok) return setError(res.error)
                await run(() => api.footage.scan(id))
              }}
              className="btn-ghost !px-3 !py-1 !text-xs"
            >
              ➕ Add folder
            </button>
            <button disabled={busy} onClick={() => run(() => api.footage.scan(id))} className="btn-ghost !px-3 !py-1 !text-xs" title="Look for new, changed or removed videos">
              🔄 Rescan
            </button>
          </div>

          {job === 'scan' && (
            <div className="mt-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-ink/5">
                <div className="progress-stripes h-full rounded-full transition-all" style={{ width: `${progress?.total ? Math.max(5, (progress.done / progress.total) * 100) : 8}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-xs text-ink/55">
                <span className="truncate">🔍 Looking at {progress?.note ?? 'your videos'}…</span>
                <span>{progress?.total ? `${progress.done}/${progress.total}` : ''}</span>
              </div>
            </div>
          )}

          <div className="mt-3 text-sm text-ink/65">
            <strong>{ok.length}</strong> video{ok.length === 1 ? '' : 's'} · {fmtClock(ok.reduce((a, c) => a + c.durationSec, 0))} of footage
            {skipped.length > 0 && <span className="ml-2 text-coral" title={skipped.map((c) => c.name).join('\n')}>· {skipped.length} could not be read</span>}
            {missing.length > 0 && <span className="ml-2 text-coral" title={missing.map((c) => c.name).join('\n')}>· {missing.length} no longer found</span>}
          </div>

          {ok.length > 0 && (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
                {(showAll ? ok : ok.slice(0, 16)).map((c) => (
                  <div key={c.id} className="overflow-hidden rounded-xl border-2 border-ink/10 bg-paper" title={`${c.name}\n${c.width}×${c.height} · ${fmtClock(c.durationSec)}${c.watched ? '\nThe AI has watched this' : ''}`}>
                    <div className="relative aspect-video bg-ink/5">
                      {posters[c.id] && <img src={posters[c.id]} alt="" className="h-full w-full object-cover" />}
                      <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1 text-[10px] font-bold text-white">{fmtClock(c.durationSec)}</span>
                      <span className="absolute left-1 top-1 flex gap-0.5 text-[10px]">
                        {c.watched && <span className="rounded bg-white/90 px-1">👁️</span>}
                        {c.hasAudio && c.listened && c.transcript?.length ? <span className="rounded bg-white/90 px-1">👂</span> : null}
                        {!c.hasAudio && <span className="rounded bg-white/90 px-1">🔇</span>}
                      </span>
                    </div>
                    <div className="truncate px-1.5 py-1 text-[10px] font-semibold text-ink/70">{c.name}</div>
                  </div>
                ))}
              </div>
              {ok.length > 16 && (
                <button onClick={() => setShowAll((v) => !v)} className="mt-2 text-xs font-bold text-grape hover:underline">
                  {showAll ? '▴ Show fewer' : `▾ Show all ${ok.length} videos`}
                </button>
              )}
            </>
          )}

          {ok.length > 0 && estimate && !understandable && job !== 'understand' && <div className="mt-3 text-xs font-semibold text-mint">✅ The AI has watched and listened to all your videos.</div>}

          {ok.length > 0 && (understandable || job === 'understand') && (
            <div className="mt-4 rounded-2xl border-2 border-grape/25 bg-grape-soft/50 p-4">
              <div className="text-sm font-black">✨ Let the AI watch and listen</div>
              <p className="mt-1 text-xs leading-relaxed text-ink/65">
                The editor looks at a frame from every shot and listens to what is said, so it can pick the right moments for your brief. Without this it can only spread shots evenly.
              </p>
              {job === 'understand' && progress ? (
                <div className="mt-3">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-white">
                    <div className="progress-stripes h-full rounded-full transition-all" style={{ width: `${progress.total ? Math.max(5, (progress.done / progress.total) * 100) : 8}%` }} />
                  </div>
                  <div className="mt-1 flex justify-between text-xs text-ink/55">
                    <span className="truncate">👀 {progress.note ?? 'Working'}…</span>
                    <span>{progress.total ? `${progress.done}/${progress.total} videos` : ''}</span>
                  </div>
                  <button onClick={() => api.footage.cancel()} className="mt-2 text-xs font-bold text-coral hover:underline">
                    ✋ Stop (finished videos are kept)
                  </button>
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button onClick={() => run(() => api.footage.understand(id))} disabled={busy || !understandable} className="btn-primary !px-5 !py-2 !text-sm">
                    👀 Watch &amp; listen{estimate ? ` · about ${estimate.usd === 0 ? 'nothing' : fmtUsd(estimate.usd)}` : ''}
                  </button>
                  {estimate && <span className="text-xs text-ink/50">{estimate.shots} shots{estimate.speechMinutes > 0 ? ` · ${estimate.speechMinutes} min of sound` : ''}, billed to your own key</span>}
                </div>
              )}
              <div className="mt-2 text-[11px] text-ink/45">
                {unwatched === 0 ? '✅ The AI has watched all your videos.' : `${unwatched} of ${ok.length} videos still to watch.`}{' '}
                <button onClick={onOpenSettings} className="font-bold text-grape hover:underline">
                  AI settings
                </button>
              </div>
            </div>
          )}
        </section>

        {error && <div className="mt-4 rounded-2xl border-2 border-coral/30 bg-coral-soft p-4 text-sm font-semibold text-coral">⚠️ {error}</div>}
        {notice && <div className="slide-up mt-4 rounded-2xl border-2 border-sky/30 bg-sky-soft p-4 text-sm font-semibold text-ink/80">💡 {notice}</div>}

        {/* 2 · brief */}
        <section className="card mt-4 p-5">
          <StepTitle n={2} color="bg-grape" title="What video should we make?" />
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim() && !busy && ok.length) void makePlan()
            }}
            placeholder="e.g. A 30-second highlight reel of the best beach moments, fun and fast, with upbeat music"
            className="field mt-3 h-24 w-full resize-y p-4 text-[15px] leading-relaxed"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-ink/50">Ideas:</span>
            {IDEAS.map((i) => (
              <button key={i} onClick={() => setPrompt(i)} className="rounded-full border-2 border-sunny/60 bg-sunny-soft px-3 py-1 text-xs font-semibold text-ink/80 transition-all hover:-translate-y-0.5 hover:border-sunny active:scale-95">
                {i}
              </button>
            ))}
          </div>

          <div className="mt-5 text-sm font-black">📐 What shape should it be?</div>
          <div className="mb-2 text-xs text-ink/55">Footage of a different shape is fitted for you (cropped, or shown whole over a blurred copy).</div>
          <ShapePicker platform={platform} apps={APPS} onPlatform={(p) => setPlatform(p)} />

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-bold">How long?</span>
            {LENGTHS.map((l) => (
              <Chip key={l.sec} on={seconds === l.sec} onClick={() => setSeconds(l.sec)}>
                {l.label}
              </Chip>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-bold">Music</span>
            <Chip on={musicMode === 'editor'} onClick={() => setMusicMode('editor')}>
              🪄 Editor decides
            </Chip>
            <Chip on={musicMode === 'none'} onClick={() => setMusicMode('none')}>
              🔇 No music
            </Chip>
            <Chip on={musicMode === 'file'} onClick={pickMusic}>
              🎵 {musicFile ? `My track: ${musicFile.split(/[\\/]/).pop()}` : 'My own track…'}
            </Chip>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-bold">Volume</span>
            <Chip on={loudness === 'social'} onClick={() => setLoudness('social')}>
              🔊 Balanced for social apps
            </Chip>
            <Chip on={loudness === 'quiet'} onClick={() => setLoudness('quiet')}>
              🔉 A bit quieter
            </Chip>
            <Chip on={loudness === 'off'} onClick={() => setLoudness('off')}>
              🎚️ Leave as recorded
            </Chip>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-bold">How many videos?</span>
            <Chip on={shortsN === 1} onClick={() => setShortsN(1)}>
              🎬 One video
            </Chip>
            <Chip on={shortsN === 3} onClick={() => setShortsN(3)}>
              ✂️ 3 shorts
            </Chip>
            <Chip on={shortsN === 5} onClick={() => setShortsN(5)}>
              ✂️ 5 shorts
            </Chip>
            <span className="text-xs text-ink/50">{shortsN > 1 ? 'The best separate moments, each one a video that stands on its own. “How long” above is for each.' : 'Pick several to turn one long recording into many shorts.'}</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-bold">AI scenes</span>
            <Chip on={aiScenes && caps.ai && shortsN === 1} onClick={() => caps.ai && shortsN === 1 && setAiScenes((v) => !v)}>
              ✨ {aiScenes && caps.ai && shortsN === 1 ? 'Add where footage is missing' : 'Footage only'}
            </Chip>
            <span className="text-xs text-ink/50">
              {!caps.ai ? 'Needs a Gemini key in Settings.' : shortsN > 1 ? 'Available when making one video.' : `Made by AI, about $${(AI_CLIP_USD_PER_SEC * 5).toFixed(2)} for a 5-second scene. You see the cost before anything is made.`}
            </span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-bold">Subtitles</span>
            <Chip on={captions === 'off'} onClick={() => setCaptions('off')}>
              🚫 None
            </Chip>
            <Chip on={captions === 'clean'} onClick={() => setCaptions('clean')}>
              💬 Clean
            </Chip>
            <Chip on={captions === 'bold'} onClick={() => setCaptions('bold')}>
              🔥 Bold
            </Chip>
            <Chip on={captions === 'box'} onClick={() => setCaptions('box')}>
              ⬛ On a box
            </Chip>
            <span className="text-xs text-ink/50">Written from what people say, so let the AI listen first.</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-sm font-bold">Extras</span>
            <Chip on={wantTitles} onClick={() => setWantTitles((v) => !v)}>
              🏷️ {wantTitles ? 'Titles on screen' : 'No titles'}
            </Chip>
            <Chip on={tighten} onClick={() => setTighten((v) => !v)}>
              ✂️ {tighten ? 'Cut silent pauses' : 'Keep pauses'}
            </Chip>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button onClick={makePlan} disabled={!prompt.trim() || busy || !ok.length || (musicMode === 'file' && !musicFile)} className="btn-primary !px-6 !py-3">
              {job === 'plan' ? '⏳ The editor is choosing shots…' : '🪄 Plan my edit'}
            </button>
            <span className="text-xs text-ink/50">{!ok.length ? 'Add a folder with videos first.' : 'You can review and change the plan before anything is rendered.'}</span>
          </div>
        </section>

        {/* 3 · plan */}
        {planned && (
          <div ref={planRef}>
            {planned.shorts.map((sh, i) => (
              <PlanReview
                key={`${planned.n}-${i}`}
                project={project}
                initial={{ plan: sh.plan, thumbs: sh.thumbs, source: planned.source }}
                heading={planned.shorts.length > 1 ? `Short ${i + 1} of ${planned.shorts.length}` : undefined}
                canAi={caps.ai && planned.shorts.length === 1}
                busy={busy}
                onChange={(plan) => {
                  edited.current[i] = plan
                }}
                onReplan={makePlan}
                onMake={(plan) => {
                  setMadeList([])
                  void run(() => api.footage.render(id, plan, planned.prompt))
                }}
              />
            ))}
            {planned.shorts.length > 1 && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  disabled={busy}
                  onClick={() => {
                    const all = planned.shorts.map((sh, i) => edited.current[i] ?? sh.plan).filter((p) => p.segments.length)
                    if (!all.length) return
                    setMadeList([])
                    queue.current = { plans: all.slice(1), prompt: planned.prompt }
                    startRender(all[0], planned.prompt)
                  }}
                  className="btn-primary !px-6 !py-3"
                >
                  🎬 Make all {planned.shorts.length} shorts
                </button>
                <span className="text-xs text-ink/50">They are made one after another.</span>
              </div>
            )}
          </div>
        )}

        {job === 'render' && renderPct && (
          <section className="card slide-up mt-4 p-5">
            <div className="text-sm font-black">🎞️ Making your video</div>
            <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-ink/5">
              <div className="progress-stripes h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(4, renderPct.pct)}%` }} />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-ink/55">
              <span>
                {renderPct.phase} — {renderPct.pct}%
              </span>
              <button onClick={() => api.footage.cancel()} className="font-bold text-coral hover:underline">
                ✋ Stop
              </button>
            </div>
          </section>
        )}

        {madeList.length > 0 && (
          <section className="pop-in mt-4 rounded-3xl border-2 border-mint/40 bg-mint-soft p-5">
            <div className="flex items-center gap-3">
              <div className="text-4xl">🎉</div>
              <div className="min-w-0">
                <div className="text-lg font-black">{madeList.length > 1 ? `${madeList.length} videos are ready!` : 'Your video is ready!'}</div>
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {madeList.map((made) => (
                <div key={made.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/70 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{made.title}</div>
                    <div className="truncate text-xs text-ink/55">
                      {fmtClock(made.durationSec)} · {made.shape}
                    </div>
                  </div>
                  <button onClick={() => api.footage.play(made.file)} className="btn-primary !px-4 !py-1.5 !text-sm">
                    ▶ Watch it
                  </button>
                  <button onClick={() => api.footage.reveal(made.file)} className="btn-ghost !py-1.5">
                    📁 Show the file
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* earlier edits */}
        {project.edits.length > 0 && (
          <section className="card mt-4 p-5">
            <div className="text-base font-black">🎞️ Videos made from this footage</div>
            <div className="mt-3 divide-y divide-ink/5">
              {project.edits.map((e) => (
                <div key={e.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-bold">{e.title}</div>
                    <div className="truncate text-xs text-ink/50" title={e.prompt}>
                      {fmtClock(e.durationSec)} · {e.shape} · {new Date(e.createdAt).toLocaleString()} · {e.prompt}
                    </div>
                  </div>
                  <button onClick={() => api.footage.play(e.file)} className="btn-ghost !px-3 !py-1 !text-xs">
                    ▶ Watch
                  </button>
                  <button onClick={() => api.footage.reveal(e.file)} className="btn-ghost !px-3 !py-1 !text-xs">
                    📁 Show
                  </button>
                  <button
                    onClick={async () => {
                      if (!window.confirm(`Delete the video “${e.title}”? Your original footage is not affected.`)) return
                      await api.footage.removeEdit(id, e.id)
                      await load()
                    }}
                    className="btn-ghost !px-3 !py-1 !text-xs"
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ plan review

function PlanReview({
  project,
  initial,
  heading,
  canAi,
  busy,
  onChange,
  onReplan,
  onMake
}: {
  project: FootageProject
  initial: { plan: EditPlan; thumbs: string[]; source: PlanResult['source'] }
  heading?: string
  canAi: boolean
  busy: boolean
  onChange: (plan: EditPlan) => void
  onReplan: () => void
  onMake: (plan: EditPlan) => void
}) {
  const [plan, setPlan] = useState(initial.plan)
  const [thumbs, setThumbs] = useState(initial.thumbs)
  useEffect(() => onChange(plan), [plan]) // eslint-disable-line react-hooks/exhaustive-deps
  const clips = new Map(project.clips.map((c) => [c.id, c]))
  const total = planDuration(plan)
  const patch = (i: number, change: Partial<EditPlan['segments'][number]>) => setPlan((p) => ({ ...p, segments: p.segments.map((s, j) => (j === i ? { ...s, ...change } : s)) }))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= plan.segments.length) return
    const swap = <T,>(a: T[]) => { const b = [...a]; [b[i], b[j]] = [b[j], b[i]]; return b }
    setPlan((p) => ({ ...p, segments: swap(p.segments) }))
    setThumbs((t) => swap(t))
  }
  const remove = (i: number) => {
    setPlan((p) => ({ ...p, segments: p.segments.filter((_, j) => j !== i) }))
    setThumbs((t) => t.filter((_, j) => j !== i))
  }
  const [tightening, setTightening] = useState<string | null>(null)
  const aiCount = aiClipsIn(plan)
  const aiCost = aiCostUsd(plan)
  const addAi = () => {
    if (aiCount >= AI_CLIP_MAX) return
    setPlan((p) => ({ ...p, segments: [...p.segments, { clipId: `ai-${aiClipsIn(p) + 1}`, startSec: 0, endSec: 5, speed: 1, keepAudio: false, transition: 'cut', why: 'Made by AI', ai: { prompt: '' } }] }))
    setThumbs((t) => [...t, ''])
  }
  const split = (i: number) => {
    const s = plan.segments[i]
    const mid = Math.round(((s.startSec + s.endSec) / 2) * 10) / 10
    if (mid - s.startSec < 0.5 || s.endSec - mid < 0.5) return
    setPlan((p) => ({ ...p, segments: [...p.segments.slice(0, i), { ...s, endSec: mid }, { ...s, startSec: mid, transition: 'cut' }, ...p.segments.slice(i + 1)] }))
    setThumbs((t) => [...t.slice(0, i + 1), t[i] ?? '', ...t.slice(i + 1)])
  }
  const tightenNow = async () => {
    setTightening(LISTENING)
    const res = await api.footage.tighten(project.id, cleanPlan(plan))
    if (!res.ok) return setTightening(`⚠️ ${res.error}`)
    setPlan(res.result.plan)
    setThumbs(res.result.thumbs)
    setTightening(res.result.removedSec >= 0.1 ? `Cut ${res.result.removedSec}s of silence.` : 'No long pauses found.')
  }
  const setTitle = (i: number, change: Partial<PlanTitle>) => setPlan((p) => ({ ...p, titles: p.titles.map((t, j) => (j === i ? { ...t, ...change } : t)) }))
  const addTitle = () =>
    setPlan((p) => {
      const at = Math.min(Math.max(0, total - 2.5), p.titles.reduce((m, t) => Math.max(m, t.endSec), 0))
      return { ...p, titles: [...p.titles, { text: 'Your title', startSec: Math.round(at * 10) / 10, endSec: Math.round(Math.min(total, at + 2.5) * 10) / 10, position: 'center' }] }
    })
  const starts = segmentStarts(plan)
  const lines = plan.segments.reduce((n, s) => n + (s.keepAudio ? (clips.get(s.clipId)?.transcript?.length ?? 0) : 0), 0)
  const setMusic = (m: Partial<MusicChoice>) => setPlan((p) => ({ ...p, music: { ...p.music, ...m } }))

  return (
    <section className="card slide-up mt-4 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <StepTitle n={3} color="bg-berry" title={heading ? `Review: ${heading}` : 'Review the edit'} />
        <div className="text-xs text-ink/55">
          {initial.source === 'ai' ? '🤖 Chosen by the AI editor' : '📐 Spread evenly across your footage'} · change anything, then make it
        </div>
      </div>
      <input
        value={plan.title}
        onChange={(e) => setPlan((p) => ({ ...p, title: e.target.value.slice(0, 80) }))}
        className="field mt-3 w-full max-w-md px-3 py-2 text-sm font-bold"
        aria-label="Title of the edit"
      />
      {plan.notes.map((n, i) => (
        <div key={i} className="mt-2 rounded-xl bg-sunny-soft px-3 py-2 text-xs font-semibold text-ink/70">
          💡 {n}
        </div>
      ))}

      <div className="mt-4">
        <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-ink/45">Timeline</div>
        <div className="flex h-12 w-full gap-px overflow-hidden rounded-lg bg-ink/10" aria-label="Timeline of the edit">
          {plan.segments.map((s, i) => (
            <div
              key={i}
              style={{ flexGrow: Math.max(0.2, (s.endSec - s.startSec) / s.speed), flexBasis: 0, backgroundImage: thumbs[i] ? `url(${thumbs[i]})` : undefined }}
              className={`relative min-w-[6px] bg-cover bg-center ${s.ai ? 'bg-grape/40' : s.keepAudio ? '' : 'opacity-70'}`}
              title={`${i + 1}. ${clips.get(s.clipId)?.name ?? ''} · ${fmtClock(starts[i] ?? 0)}`}
            >
              <span className="absolute left-0.5 top-0.5 rounded bg-black/55 px-1 text-[9px] font-black text-white">{i + 1}</span>
              {s.transition === 'fade' && i > 0 && <span className="absolute inset-y-0 left-0 w-2 bg-gradient-to-r from-white/80 to-transparent" />}
            </div>
          ))}
        </div>
        {total > 0 && (
          <div className="relative mt-1 h-4 w-full rounded bg-ink/5">
            {plan.titles.map((t, i) => (
              <div key={i} className="absolute top-0 h-4 overflow-hidden rounded bg-sunny px-1 text-[9px] font-bold leading-4 text-ink/80" style={{ left: `${(t.startSec / total) * 100}%`, width: `${Math.max(2, ((t.endSec - t.startSec) / total) * 100)}%` }} title={t.text}>
                {t.text}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="mt-4 space-y-2">
        {plan.segments.map((s, i) => {
          const clip = clips.get(s.clipId)
          const max = clip?.durationSec ?? s.endSec
          if (s.ai) {
            return (
              <div key={`${s.clipId}-${i}`} className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-grape/30 bg-grape-soft/40 p-2">
                <span className="w-5 text-center text-xs font-black text-ink/40">{i + 1}</span>
                <div className="flex h-14 w-24 shrink-0 items-center justify-center rounded-lg bg-grape/15 text-xs font-black text-grape">✨ AI scene</div>
                <textarea
                  value={s.ai.prompt}
                  onChange={(e) => patch(i, { ai: { prompt: e.target.value.slice(0, 600) } })}
                  placeholder="Describe the scene: what we see and how the camera moves"
                  className="field min-w-[200px] flex-1 resize-y px-2 py-1 text-xs"
                  rows={2}
                  aria-label="What the AI scene shows"
                />
                <select value={Math.round(s.endSec - s.startSec)} onChange={(e) => patch(i, { endSec: Number(e.target.value) })} className="field px-1.5 py-1 text-xs" aria-label="Length of the AI scene">
                  {Array.from({ length: AI_CLIP_MAX_SEC - AI_CLIP_MIN_SEC + 1 }, (_, k) => AI_CLIP_MIN_SEC + k).map((v) => (
                    <option key={v} value={v}>
                      {v} seconds · ${(v * AI_CLIP_USD_PER_SEC).toFixed(2)}
                    </option>
                  ))}
                </select>
                {i > 0 && (
                  <button onClick={() => patch(i, { transition: s.transition === 'fade' ? 'cut' : 'fade' })} className={`rounded-full border-2 px-2 py-0.5 text-[11px] font-bold ${s.transition === 'fade' ? 'border-sky bg-sky-soft' : 'border-ink/15 bg-white text-ink/50'}`}>
                    {s.transition === 'fade' ? '🌫️ Fade' : '✂️ Cut'}
                  </button>
                )}
                <div className="flex gap-0.5">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1.5 text-ink/50 hover:bg-ink/5 disabled:opacity-25" aria-label="Move up">
                    ↑
                  </button>
                  <button onClick={() => move(i, 1)} disabled={i === plan.segments.length - 1} className="rounded px-1.5 text-ink/50 hover:bg-ink/5 disabled:opacity-25" aria-label="Move down">
                    ↓
                  </button>
                  <button onClick={() => remove(i)} className="rounded px-1.5 text-ink/40 hover:bg-coral-soft hover:text-coral" aria-label="Remove this part">
                    ✕
                  </button>
                </div>
              </div>
            )
          }
          return (
            <div key={`${s.clipId}-${i}`} className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-ink/10 bg-paper p-2">
              <span className="w-5 text-center text-xs font-black text-ink/40">{i + 1}</span>
              <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-ink/5">{thumbs[i] && <img src={thumbs[i]} alt="" className="h-full w-full object-cover" />}</div>
              <div className="min-w-[160px] flex-1">
                <div className="truncate text-xs font-bold" title={clip?.path}>
                  {clip?.name ?? 'Missing clip'}
                </div>
                <div className="truncate text-[11px] text-ink/50" title={s.why}>
                  {s.why || ' '}
                </div>
              </div>
              <label className="text-[11px] font-semibold text-ink/55">
                From
                <input type="number" step={0.1} min={0} max={max} value={s.startSec} onChange={(e) => patch(i, { startSec: clampNum(e.target.value, 0, s.endSec - 0.5) })} className="field ml-1 w-16 px-1.5 py-1 text-xs" />
              </label>
              <label className="text-[11px] font-semibold text-ink/55">
                to
                <input type="number" step={0.1} min={0} max={max} value={s.endSec} onChange={(e) => patch(i, { endSec: clampNum(e.target.value, s.startSec + 0.5, max) })} className="field ml-1 w-16 px-1.5 py-1 text-xs" />
              </label>
              <select value={s.speed} onChange={(e) => patch(i, { speed: Number(e.target.value) })} className="field px-1.5 py-1 text-xs" aria-label="Speed">
                {[0.5, 0.75, 1, 1.5, 2].map((v) => (
                  <option key={v} value={v}>
                    {v === 1 ? 'Normal speed' : `${v}× speed`}
                  </option>
                ))}
              </select>
              <button
                onClick={() => patch(i, { keepAudio: !s.keepAudio })}
                disabled={!clip?.hasAudio}
                className={`rounded-full border-2 px-2 py-0.5 text-[11px] font-bold ${s.keepAudio ? 'border-mint bg-mint-soft' : 'border-ink/15 bg-white text-ink/50'} disabled:opacity-40`}
                title={clip?.hasAudio ? 'Keep or mute this clip’s own sound' : 'This clip has no sound'}
              >
                {s.keepAudio ? '🔊 Sound' : '🔇 Muted'}
              </button>
              {i > 0 && (
                <button onClick={() => patch(i, { transition: s.transition === 'fade' ? 'cut' : 'fade' })} className={`rounded-full border-2 px-2 py-0.5 text-[11px] font-bold ${s.transition === 'fade' ? 'border-sky bg-sky-soft' : 'border-ink/15 bg-white text-ink/50'}`} title="How this part joins the one before">
                  {s.transition === 'fade' ? '🌫️ Fade' : '✂️ Cut'}
                </button>
              )}
              <span className="text-[11px] font-bold text-ink/50">{fmtClock((s.endSec - s.startSec) / s.speed)}</span>
              <div className="flex gap-0.5">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded px-1.5 text-ink/50 hover:bg-ink/5 disabled:opacity-25" aria-label="Move up">
                  ↑
                </button>
                <button onClick={() => move(i, 1)} disabled={i === plan.segments.length - 1} className="rounded px-1.5 text-ink/50 hover:bg-ink/5 disabled:opacity-25" aria-label="Move down">
                  ↓
                </button>
                <button onClick={() => split(i)} disabled={s.endSec - s.startSec < 1.2} className="rounded px-1.5 text-ink/50 hover:bg-ink/5 disabled:opacity-25" aria-label="Split this part in two" title="Split in two">
                  ✂
                </button>
                <button onClick={() => remove(i)} className="rounded px-1.5 text-ink/40 hover:bg-coral-soft hover:text-coral" aria-label="Remove this part">
                  ✕
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl bg-grape-soft/50 px-4 py-3 text-sm">
        <span className="font-black">⏱️ {fmtClock(total)} total</span>
        <label className="flex items-center gap-1.5 text-xs font-semibold">
          🎵 Music
          <select value={plan.music.mode} onChange={(e) => setMusic({ mode: e.target.value as MusicChoice['mode'] })} className="field px-1.5 py-1 text-xs">
            <option value="auto">Original score</option>
            <option value="none">None</option>
            {plan.music.file && <option value="file">My track</option>}
          </select>
          {plan.music.mode === 'auto' && (
            <select value={plan.music.mood} onChange={(e) => setMusic({ mood: e.target.value as MusicChoice['mood'] })} className="field px-1.5 py-1 text-xs" aria-label="Music mood">
              {MUSIC_MOODS.map((m) => (
                <option key={m} value={m}>
                  {m[0].toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold">
          🔊 Volume
          <select value={plan.loudness} onChange={(e) => setPlan((p) => ({ ...p, loudness: e.target.value as EditPlan['loudness'] }))} className="field px-1.5 py-1 text-xs">
            <option value="social">Balanced for social apps</option>
            <option value="quiet">A bit quieter</option>
            <option value="off">Leave as recorded</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold">
          📐 Fit
          <select value={plan.reframe} onChange={(e) => setPlan((p) => ({ ...p, reframe: e.target.value as EditPlan['reframe'] }))} className="field px-1.5 py-1 text-xs">
            <option value="auto">Automatic</option>
            <option value="crop">Fill the frame (crop)</option>
            <option value="blur">Show everything (blurred sides)</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs font-semibold">
          <input type="checkbox" checked={plan.fadeInOut} onChange={(e) => setPlan((p) => ({ ...p, fadeInOut: e.target.checked }))} className="accent-[#7c3aed]" />
          Fade in &amp; out
        </label>
      </div>

      <div className="mt-3 space-y-3 rounded-xl bg-sunny-soft/60 px-4 py-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs font-semibold">
            💬 Subtitles
            <select value={plan.captions} onChange={(e) => setPlan((p) => ({ ...p, captions: e.target.value as EditPlan['captions'] }))} className="field px-1.5 py-1 text-xs">
              <option value="off">None</option>
              <option value="clean">Clean</option>
              <option value="bold">Bold</option>
              <option value="box">On a box</option>
            </select>
          </label>
          {plan.captions !== 'off' && lines === 0 && <span className="text-[11px] font-semibold text-coral">No speech was transcribed in these parts, so there is nothing to caption. Let the AI listen to your videos first.</span>}
          <button onClick={tightenNow} disabled={busy || tightening === LISTENING} className="btn-ghost !px-3 !py-1 !text-xs">
            ✂️ Cut silent pauses
          </button>
          {tightening && <span className="text-[11px] font-semibold text-ink/60">{tightening}</span>}
        </div>
        <div>
          <div className="flex items-center gap-2 text-xs font-bold">
            🏷️ Titles on screen
            <button onClick={addTitle} className="rounded-full border-2 border-sunny bg-white px-2 py-0.5 text-[11px] font-bold hover:bg-sunny-soft">
              + Add a title
            </button>
          </div>
          {plan.titles.map((t, i) => (
            <div key={i} className="mt-1.5 flex flex-wrap items-center gap-2">
              <input value={t.text} maxLength={90} onChange={(e) => setTitle(i, { text: e.target.value })} className="field min-w-[180px] flex-1 px-2 py-1 text-xs font-bold" aria-label="Title text" />
              <label className="text-[11px] font-semibold text-ink/55">
                from
                <input type="number" step={0.1} min={0} max={total} value={t.startSec} onChange={(e) => setTitle(i, { startSec: clampNum(e.target.value, 0, Math.max(0, t.endSec - 0.5)) })} className="field ml-1 w-16 px-1.5 py-1 text-xs" />
              </label>
              <label className="text-[11px] font-semibold text-ink/55">
                to
                <input type="number" step={0.1} min={0} max={total} value={t.endSec} onChange={(e) => setTitle(i, { endSec: clampNum(e.target.value, t.startSec + 0.5, Math.max(t.startSec + 0.5, total)) })} className="field ml-1 w-16 px-1.5 py-1 text-xs" />
              </label>
              <select value={t.position} onChange={(e) => setTitle(i, { position: e.target.value as PlanTitle['position'] })} className="field px-1.5 py-1 text-xs" aria-label="Where on screen">
                <option value="top">Top</option>
                <option value="center">Middle</option>
                <option value="bottom">Bottom</option>
              </select>
              <button onClick={() => setPlan((p) => ({ ...p, titles: p.titles.filter((_, j) => j !== i) }))} className="rounded px-1.5 text-ink/40 hover:bg-coral-soft hover:text-coral" aria-label="Remove this title">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button onClick={() => onMake(cleanPlan(plan))} disabled={busy || !plan.segments.length || plan.segments.some((x) => x.ai && x.ai.prompt.trim().length < 3)} className="btn-primary !px-6 !py-3">
          🎬 Make this video{aiCount > 0 ? ` · AI scenes about $${aiCost.toFixed(2)}` : ''}
        </button>
        {canAi && aiCount < AI_CLIP_MAX && (
          <button onClick={addAi} disabled={busy} className="btn-ghost !py-3">
            ✨ Add an AI scene
          </button>
        )}
        <button onClick={onReplan} disabled={busy} className="btn-ghost !py-3">
          🔁 Plan again
        </button>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ bits

function StepTitle({ n, color, title }: { n: number; color: string; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`step-dot ${color}`}>{n}</span>
      <span className="text-base font-black">{title}</span>
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-full border-2 px-3.5 py-1 text-sm font-bold transition-all active:scale-95 ${on ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/70 hover:border-grape/50'}`}>
      {children}
    </button>
  )
}

/** AI scenes need unique ids in order (parts may have been moved or removed) */
const cleanPlan = (plan: EditPlan): EditPlan => {
  let n = 0
  return { ...plan, segments: plan.segments.map((s): PlanSegment => (s.ai ? { ...s, clipId: `ai-${++n}`, ai: { prompt: s.ai.prompt.trim() } } : s)) }
}
const LISTENING = 'Listening for silent pauses…'
const folderName = (p?: string) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p : '')
const clampNum = (v: string, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round((parseFloat(v) || 0) * 10) / 10))
