import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type VideoSpec } from '../api'
import {
  changeCount,
  craftOf,
  duplicateScene,
  estimateDuration,
  headlineOf,
  moveScene,
  narrationOf,
  removeScene,
  setAccentWord,
  setCamera,
  setDuration,
  setHeadline,
  setNarration,
  setPictureOn,
  setPicturePrompt,
  setTransition,
  speechEstimateSec
} from '../editing'

/**
 * The timeline editor: drag scenes into a new order, change what's said and
 * shown, swap a picture, then apply once — the video is re-made (voice,
 * captions and music re-fitted) and the old version stays in history.
 * Edits are made on a draft; undo/redo walk a stack of drafts.
 */

type Props = {
  projectId: string
  spec: VideoSpec
  thumbs: string[]
  busy: boolean
  onApply: (spec: VideoSpec) => void
}

const TRANSITIONS: Array<[VideoSpec['scenes'][number]['transitionIn'], string]> = [
  ['cut', 'Straight cut'],
  ['fade', 'Fade'],
  ['slide', 'Slide'],
  ['zoom', 'Zoom'],
  ['whip', 'Whip pan'],
  ['wipe', 'Wipe'],
  ['glitch', 'Glitch']
]
const CAMERAS = [
  ['push', 'Slowly closer'],
  ['pull', 'Slowly back'],
  ['truckLeft', 'Slide left'],
  ['truckRight', 'Slide right'],
  ['craneUp', 'Rise up'],
  ['drift', 'Gentle drift']
] as const

const secs = (n: number) => `${Math.round(n * 10) / 10}s`

export function SceneEditor({ projectId, spec, thumbs, busy, onApply }: Props) {
  const [draft, setDraft] = useState(spec)
  const [past, setPast] = useState<VideoSpec[]>([])
  const [future, setFuture] = useState<VideoSpec[]>([])
  const [sel, setSel] = useState(spec.scenes[0]?.id ?? '')
  const [drag, setDrag] = useState<{ from: number; over: number } | null>(null)
  const [versions, setVersions] = useState<Array<{ at: number; title: string; scenes: number; durationSec: number }>>([])

  // a freshly saved video (after Apply, or another project) starts a clean draft
  useEffect(() => {
    setDraft(spec)
    setPast([])
    setFuture([])
    setSel((cur) => (spec.scenes.some((s) => s.id === cur) ? cur : (spec.scenes[0]?.id ?? '')))
  }, [spec, projectId])
  useEffect(() => {
    api.projectHistory(projectId).then(setVersions).catch(() => setVersions([]))
  }, [projectId, spec])

  const edit = useCallback(
    (next: VideoSpec) => {
      if (next === draft) return
      setPast((p) => [...p.slice(-49), draft])
      setFuture([])
      setDraft(next)
    },
    [draft]
  )
  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p
      setFuture((f) => [draft, ...f])
      setDraft(p[p.length - 1])
      return p.slice(0, -1)
    })
  }, [draft])
  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f
      setPast((p) => [...p, draft])
      setDraft(f[0])
      return f.slice(1)
    })
  }, [draft])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' && e.key.toLowerCase() !== 'y') return
      const t = e.target as HTMLElement
      if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type === 'text')) return // let the text box undo its own typing
      e.preventDefault()
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  const changes = useMemo(() => changeCount(spec, draft), [spec, draft])
  const length = useMemo(() => estimateDuration(draft), [draft])
  const thumbOf = (id: string) => {
    const i = spec.scenes.findIndex((s) => s.id === id)
    return i >= 0 ? thumbs[i] : undefined
  }
  const idx = Math.max(0, draft.scenes.findIndex((s) => s.id === sel))
  const scene = draft.scenes[idx]
  const craft = scene ? craftOf(draft, scene.id) : undefined
  const line = scene ? narrationOf(draft, scene.id) : ''
  const voiced = scene ? draft.voiceover.some((t) => t.sceneId === scene.id) : false

  const restore = async (at: number) => {
    const old = await api.historySpec(projectId, at)
    if (old) edit(old)
  }

  if (!scene) return null

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="card flex flex-wrap items-center gap-2 p-3">
        <button onClick={undo} disabled={past.length === 0} className="btn-ghost !py-1.5 disabled:opacity-40" title="Undo (Ctrl+Z)">
          ↶ Undo
        </button>
        <button onClick={redo} disabled={future.length === 0} className="btn-ghost !py-1.5 disabled:opacity-40" title="Redo (Ctrl+Y)">
          ↷ Redo
        </button>
        {versions.length > 0 && (
          <select
            className="field !w-auto !py-1.5 text-sm"
            value=""
            onChange={(e) => e.target.value && restore(Number(e.target.value))}
            title="Bring back an earlier version of this video's script"
          >
            <option value="">🕘 Earlier versions…</option>
            {versions.map((v) => (
              <option key={v.at} value={v.at}>
                {new Date(v.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {v.scenes} scenes · {Math.round(v.durationSec)}s
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm font-bold text-ink/60">
            ⏱️ about {secs(length)} · {draft.scenes.length} scenes
          </span>
          <button onClick={() => onApply(draft)} disabled={changes === 0 || busy} className="btn-primary" title="Make a new video with your changes">
            {busy ? 'Making your video…' : changes === 0 ? 'No changes yet' : `✨ Make new video (${changes} ${changes === 1 ? 'change' : 'changes'})`}
          </button>
        </div>
      </div>

      {/* timeline */}
      <div className="card p-3">
        <div className="mb-2 text-xs font-bold text-ink/50">🎞️ Drag a scene to move it. Click one to edit it.</div>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {draft.scenes.map((s, i) => {
            const on = s.id === scene.id
            const img = thumbOf(s.id)
            const over = drag?.over === i && drag.from !== i
            return (
              <button
                key={s.id}
                draggable
                onDragStart={() => setDrag({ from: i, over: i })}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (drag && drag.over !== i) setDrag({ ...drag, over: i })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (drag) edit(moveScene(draft, drag.from, i))
                  setDrag(null)
                }}
                onDragEnd={() => setDrag(null)}
                onClick={() => setSel(s.id)}
                style={{ width: Math.max(96, Math.min(220, s.durationSec * 26)) }}
                className={`relative shrink-0 cursor-grab rounded-2xl border-2 p-1.5 text-left transition-all ${
                  on ? 'border-grape bg-grape-soft shadow-[0_3px_0_#5b21b6]' : 'border-ink/10 bg-white hover:border-grape/50'
                } ${over ? 'translate-x-1 border-sunny' : ''} ${drag?.from === i ? 'opacity-40' : ''}`}
              >
                <div className="flex h-24 items-center justify-center overflow-hidden rounded-xl bg-ink/5">
                  {img ? <img src={img} alt="" className="h-full w-full object-cover" draggable={false} /> : <span className="text-2xl">🎬</span>}
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="step-dot !h-5 !w-5 !text-[10px] bg-grape">{i + 1}</span>
                  <span className="truncate text-[11px] font-bold text-ink/70">{headlineOf(draft, s) || s.kind}</span>
                </div>
                <div className="text-[10px] text-ink/45">{secs(s.durationSec)}</div>
              </button>
            )
          })}
        </div>
      </div>

      {/* the selected scene */}
      <div className="grid gap-4 lg:grid-cols-[minmax(220px,300px)_1fr]">
        <div className="card p-3">
          <div className="relative overflow-hidden rounded-xl border-2 border-ink/10 bg-ink/5">
            {thumbOf(scene.id) ? (
              <img src={thumbOf(scene.id)} alt={`scene ${idx + 1}`} className="max-h-[420px] w-full object-cover" />
            ) : (
              <div className="flex h-48 items-center justify-center text-3xl">🎬</div>
            )}
            {/* type right on the picture */}
            <input
              value={headlineOf(draft, scene)}
              onChange={(e) => edit(setHeadline(draft, scene.id, e.target.value))}
              maxLength={90}
              aria-label="Words on screen"
              placeholder="Words on screen"
              className="absolute inset-x-2 bottom-2 rounded-xl border-2 border-white/70 bg-ink/70 px-3 py-2 text-center text-sm font-black text-white outline-none placeholder:text-white/50 focus:border-sunny"
            />
          </div>
          <div className="mt-2 text-center text-[11px] text-ink/45">✏️ Type on the picture to change the words on screen</div>
          <div className="mt-3 flex flex-wrap justify-center gap-1.5">
            <button onClick={() => edit(moveScene(draft, idx, idx - 1))} disabled={idx === 0} className="btn-ghost !px-2.5 !py-1 disabled:opacity-40" title="Move earlier">
              ◀ Earlier
            </button>
            <button onClick={() => edit(moveScene(draft, idx, idx + 1))} disabled={idx === draft.scenes.length - 1} className="btn-ghost !px-2.5 !py-1 disabled:opacity-40" title="Move later">
              Later ▶
            </button>
            <button onClick={() => { const n = duplicateScene(draft, scene.id); edit(n); setSel(n.scenes[idx + 1].id) }} className="btn-ghost !px-2.5 !py-1" title="Copy this scene">
              ⧉ Copy
            </button>
            <button
              onClick={() => { const next = draft.scenes[idx + 1]?.id ?? draft.scenes[idx - 1]?.id; edit(removeScene(draft, scene.id)); if (next) setSel(next) }}
              disabled={draft.scenes.length <= 1}
              className="btn-ghost !px-2.5 !py-1 disabled:opacity-40"
              title="Remove this scene"
            >
              🗑 Remove
            </button>
          </div>
        </div>

        <div className="card space-y-4 p-4">
          <div className="text-lg font-black">Scene {idx + 1}</div>

          <label className="block">
            <span className="text-xs font-bold text-ink/60">🎙️ What the voice says</span>
            <textarea
              value={line}
              onChange={(e) => edit(setNarration(draft, scene.id, e.target.value))}
              placeholder="Nothing is said in this scene. Type a line to add a voice."
              className="field mt-1 h-24 w-full resize-none p-2.5 text-sm"
            />
            <span className="mt-1 block text-[11px] text-ink/45">
              {line
                ? `About ${secs(speechEstimateSec(line))} spoken. The scene stretches to fit the voice, and the captions follow word by word.`
                : 'This scene is silent. Its length is set below.'}
            </span>
          </label>

          {craft && headlineOf(draft, scene) && (
            <label className="block">
              <span className="text-xs font-bold text-ink/60">🌟 Highlighted word</span>
              <select
                value={craft.accentWord}
                onChange={(e) => edit(setAccentWord(draft, scene.id, e.target.value))}
                className="field mt-1 w-full text-sm"
              >
                <option value="">None</option>
                {[...new Set(headlineOf(draft, scene).split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, '')).filter(Boolean))].map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
          )}

          {craft?.plate && (
            <div className="rounded-2xl bg-sky-soft p-3">
              <label className="flex items-center gap-2 text-sm font-bold">
                <input type="checkbox" checked={craft.background === 'plate'} onChange={(e) => edit(setPictureOn(draft, scene.id, e.target.checked))} />
                🖼️ Show a picture behind this scene
              </label>
              {craft.background === 'plate' && (
                <>
                  <textarea
                    value={craft.plate.prompt}
                    onChange={(e) => edit(setPicturePrompt(draft, scene.id, e.target.value))}
                    placeholder="Describe the picture you want"
                    className="field mt-2 h-20 w-full resize-none p-2.5 text-sm"
                  />
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-ink/50">
                    {craft.plate.file ? 'Keeping the current picture.' : '🎨 A new picture will be painted when you make the new video (uses your image key).'}
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs font-bold text-ink/60">
                    🎥 Camera
                    <select value={craft.plate.camera} onChange={(e) => edit(setCamera(draft, scene.id, e.target.value as (typeof CAMERAS)[number][0]))} className="field !w-auto !py-1 text-sm">
                      {CAMERAS.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-bold text-ink/60">✨ How it starts</span>
              <select
                value={scene.transitionIn}
                onChange={(e) => edit(setTransition(draft, scene.id, e.target.value as VideoSpec['scenes'][number]['transitionIn']))}
                className="field mt-1 w-full text-sm"
              >
                {TRANSITIONS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-bold text-ink/60">⏱️ How long</span>
              {line ? (
                <div className="mt-1 rounded-xl bg-grape-soft px-3 py-2 text-sm font-bold text-grape">
                  {voiced ? secs(scene.durationSec) : `≈ ${secs(Math.max(2, speechEstimateSec(line) + 0.7))}`} · follows the voice
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="range"
                    min={1}
                    max={15}
                    step={0.5}
                    value={scene.durationSec}
                    onChange={(e) => edit(setDuration(draft, scene.id, Number(e.target.value)))}
                    className="flex-1 accent-grape"
                  />
                  <span className="w-10 text-right text-sm font-bold">{secs(scene.durationSec)}</span>
                </div>
              )}
            </label>
          </div>
        </div>
      </div>
    </div>
  )
}
