import { useEffect, useRef, useState } from 'react'
import { api, type PipelineEvent, type PlatformId, type StyleFamily } from '../api'
import { ActivityFeed } from '../components/ActivityFeed'
import { CostReceipt } from '../components/CostReceipt'
import { ErrorCard } from '../components/friendly'
import { estimateVideoCost, fmtUsd } from '@shared/pricing'
import type { SettingsView } from '../api'

/** shape = aspect ratio drawn as a tiny frame so people see the format, not "9:16" */
const PLATFORMS: Array<{ id: PlatformId; label: string; emoji: string; hint: string; shape: 'tall' | 'square' | 'wide' }> = [
  { id: 'tiktok', label: 'TikTok', emoji: '🎵', hint: 'Tall · punchy', shape: 'tall' },
  { id: 'youtube-shorts', label: 'YT Shorts', emoji: '▶️', hint: 'Tall · snappy', shape: 'tall' },
  { id: 'instagram-reels', label: 'Reels', emoji: '📸', hint: 'Tall · polished', shape: 'tall' },
  { id: 'instagram-feed', label: 'Insta post', emoji: '🖼️', hint: 'Square · calm', shape: 'square' },
  { id: 'youtube', label: 'YouTube', emoji: '📺', hint: 'Wide · explainer', shape: 'wide' },
  { id: 'facebook-feed', label: 'Facebook', emoji: '👍', hint: 'Square · captions', shape: 'square' }
]

type StyleChoice = 'auto' | StyleFamily

const STYLES: Array<{ id: StyleChoice; label: string; emoji: string; hint: string; tint: string }> = [
  { id: 'auto', label: 'Surprise me', emoji: '🪄', hint: 'AI picks the best look', tint: 'bg-grape-soft' },
  { id: 'social', label: 'Bold & hype', emoji: '💥', hint: 'Big words, fast cuts', tint: 'bg-berry-soft' },
  { id: 'explainer', label: 'Clear explainer', emoji: '🧑‍🏫', hint: 'Calm, easy to follow', tint: 'bg-sky-soft' },
  { id: 'motion3d', label: 'Cinematic 3D', emoji: '🧊', hint: 'Shiny 3D, slow camera', tint: 'bg-mint-soft' }
]

const LENGTHS: Array<{ sec: number; label: string }> = [
  { sec: 15, label: '⚡ 15s' },
  { sec: 30, label: '⏱️ 30s' },
  { sec: 60, label: '🎬 60s' }
]

const EXAMPLES: Array<{ emoji: string; prompt: string; platform: PlatformId; style?: StyleFamily }> = [
  { emoji: '☕', prompt: 'Explain how coffee is made, calm and cinematic', platform: 'youtube', style: 'explainer' },
  { emoji: '🕹️', prompt: 'Hype edit about why retro gaming is back', platform: 'tiktok', style: 'social' },
  { emoji: '🚀', prompt: 'Cinematic 3D logo reveal with particles for a sci-fi game', platform: 'instagram-reels', style: 'motion3d' },
  { emoji: '✅', prompt: 'Product intro for a habit tracker app — 30 seconds', platform: 'instagram-reels', style: 'explainer' }
]

/** the friendly progress steps people see while the crew works */
const STEPS: Array<{ emoji: string; label: string; stages: Array<PipelineEvent['stage']> }> = [
  { emoji: '🧠', label: 'Writing the story', stages: ['plan'] },
  { emoji: '🎨', label: 'Designing scenes', stages: ['direct', 'plates', 'critic', 'revise'] },
  { emoji: '🧩', label: 'Putting it together', stages: ['compose', 'qa', 'thumbs'] },
  { emoji: '🎞️', label: 'Rendering video', stages: ['render'] },
  { emoji: '🎉', label: 'Ready!', stages: ['done'] }
]

function stepFor(events: PipelineEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const idx = STEPS.findIndex((s) => s.stages.includes(events[i].stage))
    if (idx >= 0) return idx
  }
  return 0
}

type SceneCard = { kind: string; label: string; durationSec: number; thumb?: string; plate?: string; score?: number }

export default function Studio({ onOpenEditor, onOpenSettings }: { onOpenEditor: () => void; onOpenSettings: () => void }) {
  const [prompt, setPrompt] = useState('')
  const [platform, setPlatform] = useState<PlatformId>('tiktok')
  const [style, setStyle] = useState<StyleChoice>('auto')
  const [duration, setDuration] = useState(30)
  const [showMore, setShowMore] = useState(false)
  const [showCrew, setShowCrew] = useState(false)
  const [events, setEvents] = useState<PipelineEvent[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [done, setDone] = useState<{ projectId: string; output: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [board, setBoard] = useState<{ title: string | null; scenes: SceneCard[]; captured: number } | null>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const [cfg, setCfg] = useState<SettingsView | null>(null)
  useEffect(() => {
    api.getSettings().then(setCfg).catch(() => {})
  }, [])
  const estimate = cfg ? estimateFor(cfg, duration) : null

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
        setNotice('Stopped. Nothing is lost — you can finish it later from 🎞️ My videos.')
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

  const step = done ? STEPS.length - 1 : stepFor(events)
  const started = running || events.length > 0
  const wide = platform === 'youtube'

  return (
    <div className="page-bg flex h-full">
      {/* main surface */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-8 pb-16 pt-8">
          <h1 className="text-3xl font-black tracking-tight">
            <span className="float inline-block">✨</span> What should we make today?
          </h1>
          <p className="mt-1 text-[15px] text-ink/60">Describe your video in your own words. We write it, design it, voice it and render it for you.</p>

          {/* 1 · idea */}
          <section className="card mt-6 p-5">
            <StepTitle n={1} color="bg-grape" title="Your idea" />
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate()
              }}
              placeholder="e.g. A fun 30-second video explaining why the sky is blue, for kids"
              className="field mt-3 h-28 w-full resize-none p-4 text-[15px] leading-relaxed"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-ink/50">No idea? Try one:</span>
              {EXAMPLES.map((ex) => (
                <button
                  key={ex.prompt}
                  onClick={() => {
                    setPrompt(ex.prompt)
                    setPlatform(ex.platform)
                    if (ex.style) setStyle(ex.style)
                  }}
                  className="rounded-full border-2 border-sunny/60 bg-sunny-soft px-3 py-1 text-xs font-semibold text-ink/80 transition-all hover:-translate-y-0.5 hover:border-sunny active:scale-95"
                  title={ex.prompt}
                >
                  {ex.emoji} {ex.prompt.length > 34 ? ex.prompt.slice(0, 32) + '…' : ex.prompt}
                </button>
              ))}
            </div>
          </section>

          {/* 2 · platform */}
          <section className="card mt-4 p-5">
            <StepTitle n={2} color="bg-berry" title="Where will you post it?" />
            <div className="mt-3 grid grid-cols-6 gap-2">
              {PLATFORMS.map((p) => (
                <button key={p.id} onClick={() => setPlatform(p.id)} className={`tile flex flex-col items-center px-2 py-3 ${platform === p.id ? 'tile-on' : ''}`}>
                  <ShapeIcon shape={p.shape} emoji={p.emoji} on={platform === p.id} />
                  <div className="mt-2 text-sm font-bold">{p.label}</div>
                  <div className="text-[11px] text-ink/50">{p.hint}</div>
                </button>
              ))}
            </div>
          </section>

          {/* 3 · vibe + length */}
          <section className="card mt-4 p-5">
            <StepTitle n={3} color="bg-sky" title="Pick a vibe" />
            <div className="mt-3 grid grid-cols-4 gap-2">
              {STYLES.map((s) => (
                <button key={s.id} onClick={() => setStyle(s.id)} className={`tile p-3 text-left ${style === s.id ? 'tile-on' : ''}`}>
                  <div className={`flex h-9 w-9 items-center justify-center rounded-xl text-xl ${s.tint}`}>{s.emoji}</div>
                  <div className="mt-2 text-sm font-bold">{s.label}</div>
                  <div className="text-[11px] leading-snug text-ink/50">{s.hint}</div>
                </button>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-sm font-bold">How long?</span>
              {LENGTHS.map((l) => (
                <button
                  key={l.sec}
                  onClick={() => setDuration(l.sec)}
                  className={`rounded-full border-2 px-3.5 py-1 text-sm font-bold transition-all active:scale-95 ${
                    duration === l.sec ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/70 hover:border-grape/50'
                  }`}
                >
                  {l.label}
                </button>
              ))}
              <button onClick={() => setShowMore((v) => !v)} className="ml-auto text-xs font-bold text-grape hover:underline">
                {showMore ? '▴ Fewer options' : '▾ More options'}
              </button>
            </div>
            {showMore && (
              <div className="slide-up mt-3 rounded-xl bg-paper p-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-bold">Exact length</span>
                  <span className="font-black text-grape">{duration} seconds</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={90}
                  step={5}
                  value={duration}
                  onChange={(e) => setDuration(Number(e.target.value))}
                  className="mt-2 w-full accent-[#7c3aed]"
                />
                <div className="text-[11px] text-ink/50">Some platforms have a maximum length — we'll trim to fit automatically.</div>
              </div>
            )}
          </section>

          {/* progress */}
          {started && !error && (
            <section className="card slide-up mt-6 p-5">
              <div className="flex items-center gap-2">
                {STEPS.map((s, i) => {
                  const state = i < step || done ? 'done' : i === step ? 'now' : 'todo'
                  return (
                    <div key={s.label} className="flex flex-1 flex-col items-center text-center">
                      <div
                        className={`flex h-11 w-11 items-center justify-center rounded-2xl text-xl transition-all ${
                          state === 'done' ? 'bg-mint-soft' : state === 'now' ? 'wiggle bg-sunny-soft ring-4 ring-sunny/40' : 'bg-ink/5 opacity-40'
                        }`}
                      >
                        {state === 'done' && i !== STEPS.length - 1 ? '✅' : s.emoji}
                      </div>
                      <div className={`mt-1.5 text-[11px] font-bold ${state === 'todo' ? 'text-ink/35' : 'text-ink/80'}`}>{s.label}</div>
                    </div>
                  )
                })}
              </div>
              {running && (
                <>
                  <div className="mt-4 h-3 w-full overflow-hidden rounded-full bg-ink/5">
                    <div className="progress-stripes h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(6, progress || ((step + 0.5) / STEPS.length) * 80)}%` }} />
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-xs text-ink/55">
                    <span>{progress > 0 ? `Rendering — ${progress}% done` : 'This usually takes a few minutes. You can keep using the app.'}</span>
                    <CostReceipt live compact />
                  </div>
                </>
              )}

              {/* live storyboard */}
              {board && board.scenes.length > 0 && (
                <div className="mt-5">
                  <div className="mb-2 flex items-baseline justify-between gap-3">
                    <div className="text-sm font-bold">🎞️ Your scenes {running && <span className="font-normal text-ink/50">— being made…</span>}</div>
                    {board.title && <div className="truncate text-sm font-black text-grape">“{board.title}”</div>}
                  </div>
                  <div className="grid gap-2.5" style={{ gridTemplateColumns: `repeat(${Math.min(board.scenes.length, wide ? 4 : 7)}, minmax(0, 1fr))` }}>
                    {board.scenes.map((s, i) => {
                      const active = running && progress > 0 && i === Math.min(board.scenes.length - 1, Math.floor((progress / 100) * board.scenes.length))
                      return (
                        <div
                          key={i}
                          className={`pop-in relative overflow-hidden rounded-xl border-2 bg-paper transition-colors ${active ? 'border-berry shadow-[0_0_0_4px_rgba(255,79,154,0.2)]' : 'border-ink/10'}`}
                          style={{ aspectRatio: wide ? '16/9' : '9/16', animationDelay: `${i * 110}ms` }}
                        >
                          {s.thumb || s.plate ? (
                            <img src={s.thumb ?? s.plate} alt={`scene ${i + 1}`} className={`thumb-in h-full w-full object-cover ${s.thumb ? '' : 'opacity-70'}`} />
                          ) : (
                            <div className={`flex h-full flex-col items-center justify-center gap-1 p-2 ${running ? 'board-sweep' : ''}`}>
                              <div className="text-center text-[10px] font-semibold leading-tight text-ink/60 line-clamp-3">{s.label}</div>
                              {running ? <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-grape" /> : <span className="text-[9px] text-ink/40">{s.durationSec}s</span>}
                            </div>
                          )}
                          <span className="absolute left-1.5 top-1.5 rounded-full bg-white/90 px-1.5 text-[10px] font-black text-ink shadow">{i + 1}</span>
                          {typeof s.score === 'number' && (
                            <span
                              className={`absolute right-1.5 top-1.5 rounded-full px-1.5 text-[10px] font-black text-white shadow ${s.score >= 7 ? 'bg-mint' : 'bg-sunny !text-ink'}`}
                              title="How good our reviewer thinks this scene looks"
                            >
                              {s.score >= 7 ? '👍' : '🔧'} {s.score}/10
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <button onClick={() => setShowCrew((v) => !v)} className="mt-4 text-xs font-bold text-grape hover:underline">
                {showCrew ? '▴ Hide what the AI crew is doing' : '▾ See what the AI crew is doing'}
              </button>
            </section>
          )}

          {error && (
            <div className="mt-6">
              <ErrorCard error={error} onOpenSettings={onOpenSettings} onRetry={prompt.trim() ? generate : undefined} />
            </div>
          )}
          {notice && <div className="slide-up mt-4 rounded-2xl border-2 border-sky/30 bg-sky-soft p-4 text-sm font-semibold text-ink/80">✋ {notice}</div>}
          {done && (
            <section className="pop-in mt-4 rounded-3xl border-2 border-mint/40 bg-mint-soft p-5">
              <div className="flex items-center gap-3">
                <div className="text-4xl">🎉</div>
                <div className="min-w-0">
                  <div className="text-lg font-black">Your video is ready!</div>
                  <div className="truncate text-xs text-ink/55" title={done.output}>
                    Saved as {done.output.split(/[\\/]/).pop()}
                  </div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={() => api.playProject(done.projectId, done.output)} className="btn-primary !px-5 !py-2.5 !text-sm">
                  ▶ Watch it
                </button>
                <button onClick={() => api.revealProject(done.projectId, done.output)} className="btn-ghost !py-2.5">
                  📁 Show the file
                </button>
                <button onClick={onOpenEditor} className="btn-ghost !py-2.5">
                  ✏️ Change a scene
                </button>
              </div>
              <div className="mt-4">
                <CostReceipt projectId={done.projectId} key={done.projectId} />
              </div>
            </section>
          )}
          {/* go! — sticks to the bottom so the main action is always in reach */}
          <div className="sticky bottom-0 z-10 mt-6 pb-4">
          {running ? (
            <button
              onClick={stop}
              className="w-full rounded-2xl border-2 border-coral/40 bg-coral-soft py-4 text-lg font-black text-coral transition-all hover:bg-coral hover:text-white"
            >
              ✋ Stop making this video
            </button>
          ) : (
            <button
              onClick={generate}
              disabled={!prompt.trim()}
              className="btn-primary w-full !rounded-2xl !py-4 !text-lg"
              title={prompt.trim() ? 'Ctrl+Enter works too' : 'Type your idea first'}
            >
              🎬 Make my video
            </button>
          )}
          {!running && (
            <div className="mx-auto mt-2 w-fit rounded-full bg-white/90 px-3 py-1 text-center text-xs text-ink/60 shadow-sm">
              {!prompt.trim()
                ? '👆 Type your idea above to get started'
                : estimate
                  ? estimate.usd === 0
                    ? '🆓 Free with your current settings'
                    : `🧾 About ${fmtUsd(estimate.usd)}, billed to your own key · reusing your library makes it cheaper`
                  : null}
            </div>
          )}
          </div>
        </div>
      </div>

      {/* behind the scenes — only when asked for */}
      {showCrew && started && (
        <aside className="slide-in-right m-3 ml-0 flex w-[340px] shrink-0 flex-col overflow-hidden rounded-3xl border-2 border-ink/10 bg-white">
          <ActivityFeed events={events} running={running} onClose={() => setShowCrew(false)} />
        </aside>
      )}
    </div>
  )
}

function StepTitle({ n, color, title }: { n: number; color: string; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`step-dot ${color}`}>{n}</span>
      <span className="text-base font-black">{title}</span>
    </div>
  )
}

function ShapeIcon({ shape, emoji, on }: { shape: 'tall' | 'square' | 'wide'; emoji: string; on: boolean }) {
  const size = shape === 'tall' ? 'h-11 w-7' : shape === 'square' ? 'h-9 w-8' : 'h-7 w-11'
  return (
    <div className="flex h-11 items-center">
      <div className={`flex items-center justify-center rounded-md border-2 text-sm ${size} ${on ? 'border-grape bg-white' : 'border-ink/20 bg-paper'}`}>{emoji}</div>
    </div>
  )
}

const DEFAULT_CHAT: Record<string, string> = { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash' }
const DEFAULT_IMAGE: Record<string, string> = { openai: 'gpt-image-2.5-sunburst', gemini: 'gemini-3.1-flash-image' }
const DEFAULT_VOICE: Record<string, string> = { openai: 'gpt-4o-mini-tts', gemini: 'gemini-2.5-flash-preview-tts', elevenlabs: 'eleven_flash_v2_5' }

/** rough cost for one video with the current picks ('auto' media resolves to the brain's provider) */
function estimateFor(s: SettingsView, durationSec: number): { usd: number; label: string } {
  if (s.provider === 'mock') return { usd: 0, label: 'the free engine' }
  const chatModel = s.models[s.provider] || DEFAULT_CHAT[s.provider]
  const pick = (v: string, defaults: Record<string, string>) => {
    if (!v || v === 'none' || v === 'stock' || v.startsWith('builtin') || v === 'library') return undefined
    if (v === 'auto') return defaults[s.provider]
    const [p, m] = v.split(':')
    return m || defaults[p]
  }
  const imageModel = pick(s.media?.image ?? 'auto', DEFAULT_IMAGE)
  const voiceModel = pick(s.media?.voice ?? 'auto', DEFAULT_VOICE)
  const videoModel = (s.media?.video ?? '').startsWith('gemini:') ? s.media.video.split(':')[1] : undefined
  const usd = estimateVideoCost({ chatModel, imageModel, voiceModel, videoModel, durationSec, directed: s.craft !== 'classic' })
  return { usd, label: [chatModel, imageModel, voiceModel, videoModel].filter(Boolean).join(' + ') }
}
