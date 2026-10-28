import { useEffect, useRef, useState } from 'react'
import { api, type PipelineEvent, type PlatformId, type StyleFamily } from '../api'
import { ActivityFeed } from '../components/ActivityFeed'

const PLATFORMS: Array<{ id: PlatformId; label: string; hint: string }> = [
  { id: 'tiktok', label: 'TikTok', hint: '9:16 · punchy' },
  { id: 'youtube-shorts', label: 'Shorts', hint: '9:16 · snappy' },
  { id: 'instagram-reels', label: 'Reels', hint: '9:16 · polished' },
  { id: 'instagram-feed', label: 'IG Feed', hint: '4:5 · calm' },
  { id: 'youtube', label: 'YouTube', hint: '16:9 · explainer' },
  { id: 'facebook-feed', label: 'Facebook', hint: '4:5 · captions' }
]

type StyleChoice = 'auto' | StyleFamily

const STYLES: Array<{ id: StyleChoice; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'AI picks' },
  { id: 'social', label: 'Kinetic / Social', hint: 'hooks, memes, hype' },
  { id: 'explainer', label: 'Explainer', hint: 'slides, clarity' },
  { id: 'motion3d', label: '3D / Motion', hint: 'three.js, cinematic' }
]

const EXAMPLES: Array<{ prompt: string; platform: PlatformId; style?: StyleFamily; result: string }> = [
  { prompt: 'Explain how coffee is made, calm and cinematic', platform: 'youtube', style: 'explainer', result: '16:9 explainer · chart & bullets' },
  { prompt: 'Hype edit about why retro gaming is back', platform: 'tiktok', style: 'social', result: '9:16 kinetic type · whip cuts' },
  { prompt: 'Cinematic 3D logo reveal with particles for a sci-fi game', platform: 'instagram-reels', style: 'motion3d', result: '9:16 chrome object · camera orbit' },
  { prompt: 'Product intro for a habit tracker app — 30 seconds', platform: 'instagram-reels', style: 'explainer', result: '9:16 problem→solution arc' }
]

type SceneCard = { kind: string; label: string; durationSec: number; thumb?: string; plate?: string; score?: number }

export default function Studio({ onOpenEditor }: { onOpenEditor: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [platform, setPlatform] = useState<PlatformId>('tiktok')
  const [style, setStyle] = useState<StyleChoice>('auto')
  const [duration, setDuration] = useState(30)
  const [events, setEvents] = useState<PipelineEvent[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState<{ projectId: string; output: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [board, setBoard] = useState<{ title: string | null; scenes: SceneCard[]; captured: number } | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    unsubRef.current = api.onEvent((e) => {
      setEvents((prev) => [...prev.slice(-120), e])
      if (e.stage === 'plan' && e.status === 'done') {
        setBoard({ title: e.title, scenes: e.sceneCards.map((c) => ({ ...c })), captured: 0 })
      }
      // the director renames each card as it designs the scene; plates preview before frames exist
      if (e.stage === 'direct' && e.status === 'scene') {
        setBoard((b) =>
          b
            ? {
                ...b,
                scenes: b.scenes.map((s, i) =>
                  i === e.sceneIndex ? { ...s, label: e.headline, kind: e.widgets.length ? e.widgets.join(' + ') : e.background === 'plate' ? 'plate' : 'hero' } : s
                )
              }
            : b
        )
      }
      if (e.stage === 'plates' && e.status === 'scene') {
        setBoard((b) => (b ? { ...b, scenes: b.scenes.map((s, i) => (i === e.sceneIndex ? { ...s, plate: e.dataUrl } : s)) } : b))
      }
      if (e.stage === 'critic' && e.status === 'scene') {
        setBoard((b) => (b ? { ...b, scenes: b.scenes.map((s, i) => (i === e.sceneIndex ? { ...s, score: e.score } : s)) } : b))
      }
      if (e.stage === 'thumbs' && e.status === 'progress') {
        setBoard((b) =>
          b
            ? {
                ...b,
                captured: b.captured + 1,
                scenes: b.scenes.map((s, i) => (i === e.index ? { ...s, thumb: e.dataUrl } : s))
              }
            : b
        )
      }
      if (e.stage === 'render') {
        if (e.status === 'progress') setProgress(e.pct)
        if (e.status === 'done') {
          setProgress(100)
          setRunning(false)
        }
        if (e.status === 'failed') {
          setError(e.error)
          setRunning(false)
        }
      }
      if (e.stage === 'pipeline' && e.status === 'failed') {
        setError(e.error)
        setRunning(false)
      }
      if (e.stage === 'pipeline' && e.status === 'cancelled') {
        setNotice('Generation stopped — the project is kept so you can re-render it from the Library.')
        setRunning(false)
      }
      if (e.stage === 'done') {
        setDone({ projectId: e.projectId, output: e.output })
        setRunning(false)
      }
    })
    return () => unsubRef.current?.()
  }, [])

  const generate = async () => {
    if (!prompt.trim() || running) return
    setEvents([])
    setProgress(0)
    setDone(null)
    setError(null)
    setNotice(null)
    setBoard(null)
    setRunning(true)
    const res = await api.generate({
      prompt: prompt.trim(),
      platform,
      styleHint: style === 'auto' ? undefined : style,
      durationHintSec: duration
    })
    if (!res.ok) {
      setError(res.error ?? 'failed to start')
      setRunning(false)
    }
  }

  const stop = async () => {
    await api.cancel()
  }

  return (
    <div className="grid h-full grid-cols-[1fr_380px] gap-0">
      {/* left: prompt surface */}
      <div className="min-h-0 overflow-y-auto p-8">
        <h1 className="mb-1 text-2xl font-black tracking-tight">Describe the video you want</h1>
        <p className="mb-6 text-sm text-white/45">
          Any topic, any style, freestyle — the planner, composer and QA agents handle the rest.
        </p>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate()
          }}
          placeholder={'e.g. "A snappy TikTok explaining why the sky is blue for 8-year-olds"\ne.g. "Cinematic teaser for our eco-friendly water bottle launch"\ne.g. "Explainer on how neural networks learn, with a calm pace"'}
          className="h-36 w-full resize-none rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-[15px] leading-relaxed outline-none transition-colors placeholder:text-white/25 focus:border-[#7C5CFF]/60 focus:bg-white/[0.06]"
        />

        {/* platform row */}
        <div className="mt-6">
          <div className="mb-2 text-xs font-bold uppercase tracking-wider text-white/40">Platform</div>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPlatform(p.id)}
                className={`rounded-xl border px-3.5 py-2 text-left transition-all ${
                  platform === p.id
                    ? 'border-[#7C5CFF] bg-[#7C5CFF]/15'
                    : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                }`}
              >
                <div className="text-sm font-bold">{p.label}</div>
                <div className="text-[11px] text-white/40">{p.hint}</div>
              </button>
            ))}
          </div>
        </div>

        {/* style + duration row */}
        <div className="mt-6 grid grid-cols-[1fr_auto] gap-6">
          <div>
            <div className="mb-2 text-xs font-bold uppercase tracking-wider text-white/40">Style</div>
            <div className="flex flex-wrap gap-2">
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStyle(s.id)}
                  className={`rounded-xl border px-3.5 py-2 text-left transition-all ${
                    style === s.id
                      ? 'border-[#00E5FF] bg-[#00E5FF]/10'
                      : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                  }`}
                >
                  <div className="text-sm font-bold">{s.label}</div>
                  <div className="text-[11px] text-white/40">{s.hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="w-52">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-white/40">Duration</span>
              <span className="text-sm font-bold text-[#b9a5ff]">{duration}s</span>
            </div>
            <input
              type="range"
              min={10}
              max={90}
              step={5}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className="w-full accent-[#7C5CFF]"
            />
            <div className="mt-1 text-[11px] text-white/35">clamped per platform limits</div>
          </div>
        </div>

        {/* generate / stop */}
        {running ? (
          <button
            onClick={stop}
            className="mt-8 w-full rounded-2xl border border-red-500/50 bg-red-500/15 py-4 text-base font-black uppercase tracking-widest text-red-200 transition-all hover:bg-red-500/25"
          >
            ■ Stop generation
          </button>
        ) : (
          <button
            onClick={generate}
            disabled={!prompt.trim()}
            className="mt-8 w-full rounded-2xl bg-gradient-to-r from-[#7C5CFF] to-[#00E5FF] py-4 text-base font-black uppercase tracking-widest text-[#0b0b12] transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-30"
          >
            Generate video
          </button>
        )}
        {running && (
          <div className="mt-4">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#7C5CFF] to-[#00E5FF] transition-all"
                style={{ width: `${Math.max(4, progress)}%` }}
              />
            </div>
            <div className="mt-1.5 text-xs text-white/40">
              {progress > 0
                ? `rendering — ${progress}%`
                : board
                  ? 'directing, painting, composing & reviewing…'
                  : 'planning…'}
            </div>
          </div>
        )}

        {/* live storyboard — the film being crafted, scene by scene */}
        {board && board.scenes.length > 0 && (
          <div className="mt-8">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <div className="text-xs font-bold uppercase tracking-wider text-white/40">
                {running ? 'Live storyboard — crafting…' : 'Storyboard'}
              </div>
              {board.title && <div className="truncate text-sm font-black text-white/85">{board.title}</div>}
            </div>
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(${Math.min(board.scenes.length, 7)}, minmax(0, 1fr))` }}
            >
              {board.scenes.map((s, i) => {
                const active = running && progress > 0 && i === Math.min(board.scenes.length - 1, Math.floor((progress / 100) * board.scenes.length))
                return (
                  <div
                    key={i}
                    className={`pop-in relative overflow-hidden rounded-xl border transition-colors ${
                      active ? 'border-[#00E5FF] shadow-[0_0_18px_rgba(0,229,255,0.35)]' : 'border-white/10'
                    }`}
                    style={{ aspectRatio: platform === 'youtube' ? '16/9' : '9/16', animationDelay: `${i * 110}ms` }}
                  >
                    {s.thumb || s.plate ? (
                      <img
                        src={s.thumb ?? s.plate}
                        alt={`scene ${i + 1}`}
                        className={`thumb-in h-full w-full object-cover ${s.thumb ? '' : 'opacity-70'}`}
                      />
                    ) : (
                      <div className={`flex h-full flex-col justify-between p-2 ${running ? 'board-sweep' : ''}`}>
                        <span className="w-fit rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white/60">
                          {s.kind}
                        </span>
                        <div className="text-center text-[10px] font-semibold leading-tight text-white/55 line-clamp-3">
                          {s.label}
                        </div>
                        <div className="flex items-center justify-center gap-1">
                          {running ? (
                            <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-[#00E5FF]" />
                          ) : (
                            <span className="text-[9px] text-white/30">{s.durationSec}s</span>
                          )}
                        </div>
                      </div>
                    )}
                    <span className="absolute left-1.5 top-1.5 rounded bg-black/60 px-1 text-[9px] font-black text-white/70">
                      {i + 1}
                    </span>
                    {typeof s.score === 'number' && (
                      <span
                        className={`absolute right-1.5 top-1.5 rounded px-1 text-[9px] font-black ${
                          s.score >= 7 ? 'bg-emerald-500/80 text-black' : 'bg-amber-400/90 text-black'
                        }`}
                        title="vision critic score"
                      >
                        {s.score}/10
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
            {running && progress === 0 && (
              <div className="mt-1.5 text-xs text-white/35">
                {board.captured > 0
                  ? `capturing scene frames — ${board.captured}/${board.scenes.length}`
                  : 'the planner is writing your storyboard…'}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="slide-up mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}
        {notice && (
          <div className="slide-up mt-4 rounded-xl border border-sky-500/30 bg-sky-500/10 p-4 text-sm text-sky-200">
            {notice}
          </div>
        )}
        {done && (
          <div className="slide-up mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
            <div className="text-sm font-bold text-emerald-200">✔ Video ready</div>
            <div className="mt-1 break-all text-xs text-white/50">{done.output}</div>
            <div className="mt-3 flex gap-2">
              <button
                onClick={onOpenEditor}
                className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-bold hover:bg-white/20"
              >
                Open in Editor
              </button>
            </div>
          </div>
        )}

        {/* examples gallery */}
        <div className="mt-10">
          <div className="mb-3 text-xs font-bold uppercase tracking-wider text-white/40">
            What kind of prompt leads to what
          </div>
          <div className="grid grid-cols-2 gap-3">
            {EXAMPLES.map((ex, i) => (
              <button
                key={i}
                onClick={() => {
                  setPrompt(ex.prompt)
                  setPlatform(ex.platform)
                  if (ex.style) setStyle(ex.style)
                }}
                className="group rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition-all hover:border-[#7C5CFF]/50 hover:bg-white/[0.05]"
              >
                <div className="text-sm font-semibold leading-snug text-white/85">“{ex.prompt}”</div>
                <div className="mt-2 text-[11px] uppercase tracking-wider text-[#00E5FF]/70">{ex.result}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* right: agent activity */}
      <div className="flex min-h-0 flex-col border-l border-white/5 bg-[#0d0d17]">
        <ActivityFeed events={events} running={running} />
      </div>
    </div>
  )
}
