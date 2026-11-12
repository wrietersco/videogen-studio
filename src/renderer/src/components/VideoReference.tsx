import { useState } from 'react'
import { videoSummary } from '@shared/references'
import { api, type VideoBrief, type VideoReadView } from '../api'

/**
 * A reference video: a YouTube link (read by the AI, never downloaded) or a
 * video file (measured on this computer). The person sees what was learned
 * and can change any of it before it is used.
 */

export interface VideoChip {
  brief: VideoBrief
  thumb: string
  name: string
}

const PACINGS: Array<[VideoBrief['pacing'], string]> = [['calm', 'Calm'], ['standard', 'Steady'], ['energetic', 'Energetic'], ['frantic', 'Frantic']]
const HOOKS: Array<[VideoBrief['hook'], string]> = [['question', 'A question'], ['statement', 'A bold statement'], ['stat', 'A number'], ['story', 'A story'], ['visual', 'A striking visual']]
const CAPTIONS: Array<[VideoBrief['captions'], string]> = [['big', 'Big captions'], ['small', 'Subtitles'], ['none', 'No captions']]
const ENERGY: Array<[VideoBrief['musicEnergy'], string]> = [['low', 'Gentle music'], ['medium', 'Medium music'], ['high', 'Driving music']]

function Pick<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <label className="block text-xs font-bold uppercase tracking-wide text-ink/50">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} className="mt-1 w-full rounded-lg border-2 border-ink/10 bg-white px-2 py-1.5 text-sm font-bold normal-case tracking-normal text-ink outline-none focus:border-grape">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

export function VideoReference({ value, onChange, durationSec }: { value: VideoChip | null; onChange: (v: VideoChip | null) => void; durationSec: number }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'link' | 'file' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)

  const take = (r: VideoReadView) => {
    if (r.ok) {
      onChange({ brief: r.brief, thumb: r.thumb, name: r.name })
      setError(null)
      setUrl('')
    } else if (!r.cancelled) setError(r.error)
  }
  const run = async (kind: 'link' | 'file', req: Parameters<typeof api.references.readVideo>[0]) => {
    if (busy) return
    setBusy(kind)
    setError(null)
    try {
      take(await api.references.readVideo(req))
    } catch {
      setError('The video could not be read just now. Try again.')
    } finally {
      setBusy(null)
    }
  }
  const edit = (patch: Partial<VideoBrief>) => value && onChange({ ...value, brief: { ...value.brief, ...patch } })

  return (
    <section
      className={`card mt-4 p-5 transition-colors ${over ? 'ring-2 ring-grape' : ''}`}
      onDragOver={(e) => {
        if (!value && [...e.dataTransfer.types].includes('Files')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (value) return
        const f = e.dataTransfer.files[0]
        if (f) {
          e.preventDefault()
          void run('file', { kind: 'file', path: api.assets.pathForFile(f) })
        }
      }}
    >
      <div className="flex items-center justify-between">
        <div className="text-base font-black">🎞️ A video to learn from</div>
        {value && (
          <button onClick={() => onChange(null)} className="text-xs font-bold text-ink/40 hover:text-berry">
            Remove
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-ink/55">Show how fast it moves and how it is built. We learn its rhythm and look, never its script, footage or music. Optional.</p>

      {!value ? (
        <>
          <div className="mt-3 flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && url.trim() && void run('link', { kind: 'youtube', url })}
              placeholder="Paste a YouTube link"
              className="min-w-0 flex-1 rounded-lg border-2 border-ink/10 bg-white px-3 py-2 text-sm outline-none focus:border-grape"
            />
            <button onClick={() => void run('link', { kind: 'youtube', url })} disabled={!!busy || !url.trim()} className="btn-ghost text-xs">
              {busy === 'link' ? 'Reading…' : 'Read link'}
            </button>
            <button onClick={() => void run('file', { kind: 'file' })} disabled={!!busy} className="btn-ghost text-xs">
              {busy === 'file' ? 'Measuring…' : 'Use a video file'}
            </button>
          </div>
          <p className="mt-2 text-xs text-ink/50">A link is read by the AI straight from YouTube (nothing is downloaded), usually for a few cents. A video file is measured on this computer: free, nothing is sent. You can also drop a file here.</p>
        </>
      ) : (
        <div className="mt-3">
          <div className="flex gap-3">
            {value.thumb && <img src={value.thumb} alt="" className="h-20 w-32 shrink-0 rounded-lg border-2 border-ink/10 bg-ink/5 object-cover" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-black" title={value.name}>
                {value.name}
              </div>
              <div className="mt-0.5 text-xs text-ink/55">
                {value.brief.source === 'youtube' ? 'Read by the AI from the link' : 'Measured on this computer'}
                {value.brief.cutsPerMinute > 0 ? ` · about ${Math.round(value.brief.cutsPerMinute)} cuts a minute` : ''}
              </div>
              {value.brief.structure.length > 0 && <div className="mt-1 text-xs text-ink/65">Moves through: {value.brief.structure.join(' → ')}</div>}
              {value.brief.palette.length > 0 && (
                <div className="mt-1.5 flex gap-1.5">
                  {value.brief.palette.map((c) => (
                    <span key={c} title={c} className="h-4 w-4 rounded-full border border-ink/10" style={{ background: c }} />
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="mt-3 rounded-xl bg-ink/[0.04] p-3">
            <div className="text-sm font-black">What I learned (change anything)</div>
            <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Pick label="Pace" value={value.brief.pacing} options={PACINGS} onChange={(pacing) => edit({ pacing })} />
              <Pick label="Opening" value={value.brief.hook} options={HOOKS} onChange={(hook) => edit({ hook })} />
              <Pick label="Captions" value={value.brief.captions} options={CAPTIONS} onChange={(captions) => edit({ captions })} />
              <Pick label="Music" value={value.brief.musicEnergy} options={ENERGY} onChange={(musicEnergy) => edit({ musicEnergy })} />
            </div>
            {value.brief.notes && <p className="mt-2 text-xs text-ink/60">{value.brief.notes}</p>}
          </div>
          <div className="mt-3 rounded-xl bg-ink/[0.04] p-3 text-sm">
            <div className="font-black">This video will</div>
            <ul className="mt-0.5 text-ink/70">
              {videoSummary(value.brief, durationSec).map((l) => (
                <li key={l}>• {l}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {error && <div className="mt-3 text-xs font-bold text-berry">{error}</div>}
    </section>
  )
}
