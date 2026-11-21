import { useState } from 'react'
import { DESCRIBE_PLATFORMS, type VideoDescription as Described } from '@shared/videoDescription'
import { api } from '../api'

/** under a finished video: pick where it will be posted and get the title, text and hashtags written for that place */
export function VideoDescription({ runId }: { runId: string }) {
  const [platform, setPlatform] = useState<string>('youtube')
  const [custom, setCustom] = useState('')
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [out, setOut] = useState<Described | null>(null)
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)

  const generate = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const res = await api.appRec.describe(runId, platform, custom, extra)
      if (res.ok) {
        setOut(res.description)
        setText(res.description.text)
      } else setError(res.error)
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setError('Could not copy. Select the text and copy it yourself.')
    }
  }

  const chosen = DESCRIBE_PLATFORMS.find((p) => p.id === platform)
  return (
    <div className="mt-3 rounded-xl border-2 border-ink/10 px-4 py-3">
      <div className="text-sm font-black">✍️ Description for posting</div>
      <div className="mt-1 text-xs text-ink/55">Choose where it will be posted. The title, text and hashtags are written from what the video says, for that place.</div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Platform">
        {DESCRIBE_PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={platform === p.id}
            onClick={() => setPlatform(p.id)}
            className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition ${platform === p.id ? 'border-grape bg-grape-soft text-grape' : 'border-ink/10 text-ink/70 hover:border-grape/50'}`}
          >
            {p.emoji} {p.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={platform === 'custom'}
          onClick={() => setPlatform('custom')}
          className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition ${platform === 'custom' ? 'border-grape bg-grape-soft text-grape' : 'border-ink/10 text-ink/70 hover:border-grape/50'}`}
        >
          ✨ Another…
        </button>
      </div>
      {platform === 'custom' && (
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Name the platform, for example Bilibili or Telegram channel" className="mt-2 w-full rounded-lg border-2 border-ink/10 px-3 py-1.5 text-sm" maxLength={40} />
      )}
      <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Anything to add? For example: mention the free trial, keep it formal, write it in Urdu (optional)" className="mt-2 w-full rounded-lg border-2 border-ink/10 px-3 py-1.5 text-sm" maxLength={300} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={() => void generate()} disabled={busy || (platform === 'custom' && !custom.trim())} className="btn-primary !px-4 !py-1.5 !text-xs">
          {busy ? 'Writing…' : out ? 'Write it again' : 'Write the description'}
        </button>
        {chosen && <span className="text-[11px] text-ink/45">Fits {chosen.label}'s limit of {chosen.limit.toLocaleString()} characters</span>}
      </div>
      {error && <div className="mt-2 rounded-lg bg-coral-soft px-3 py-2 text-xs font-semibold text-coral">{error}</div>}
      {out && (
        <div className="mt-3">
          <textarea value={text} onChange={(e) => { setText(e.target.value); setCopied(false) }} rows={Math.min(14, Math.max(4, text.split('\n').length + 1))} className="w-full rounded-lg border-2 border-ink/10 px-3 py-2 text-sm" aria-label={`Description for ${out.platform}`} dir="auto" />
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <button onClick={() => void copy()} className="btn-ghost !px-3 !py-1 !text-xs">{copied ? '✓ Copied' : '📋 Copy'}</button>
            <span className="text-[11px] text-ink/45">{text.length.toLocaleString()} characters · {out.source === 'ai' ? 'written by the AI writer' : 'made from the video’s own words'}</span>
          </div>
          {out.notes.length > 0 && <div className="mt-1 text-[11px] text-ink/55">{out.notes.join(' ')}</div>}
        </div>
      )}
    </div>
  )
}
