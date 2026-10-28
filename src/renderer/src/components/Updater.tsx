import { useEffect, useState } from 'react'
import { api, type UpdateInfo } from '../api'
import { fmtBytes } from './ui'

/**
 * Updates from GitHub. `banner` mode checks quietly at launch and only shows
 * itself when a newer version exists; `card` mode (Settings) always shows the
 * current version with a "Check for updates" button.
 */

type Phase = 'idle' | 'checking' | 'downloading' | 'ready' | 'installing'

export default function Updater({ mode }: { mode: 'banner' | 'card' }) {
  const [version, setVersion] = useState('')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  const check = async (quiet: boolean) => {
    setPhase('checking')
    setError(null)
    const r = await api.update.check()
    setPhase('idle')
    if (r.ok) {
      setInfo(r.info)
      setChecked(true)
    } else if (!quiet) setError(r.error)
  }

  useEffect(() => {
    api.update.version().then(setVersion)
    const off = api.update.onProgress(setProgress)
    if (mode === 'banner') {
      const t = setTimeout(() => void check(true), 4000)
      return () => {
        clearTimeout(t)
        off()
      }
    }
    return off
  }, [])

  const download = async () => {
    setError(null)
    setProgress({ done: 0, total: info?.size ?? 0 })
    setPhase('downloading')
    const r = await api.update.download()
    if (r.ok) setPhase('ready')
    else {
      setPhase('idle')
      setError(r.error)
    }
  }

  const install = async () => {
    setPhase('installing')
    const r = await api.update.install()
    if (!r.ok) {
      setPhase('ready')
      setError(r.error)
    }
  }

  const pct = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0
  const available = info?.available

  const action = !available ? null : !info.canInstall ? (
    <button onClick={() => api.update.openRelease(info.releaseUrl)} className="btn-primary rounded-xl bg-grape px-4 py-2 text-sm font-black text-white">
      Open download page
    </button>
  ) : phase === 'downloading' ? (
    <div className="w-56">
      <div className="h-3 overflow-hidden rounded-full bg-ink/10">
        <div className="h-full rounded-full bg-grape transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs font-bold text-ink/60">
        Downloading… {pct}% ({fmtBytes(progress.done)} of {fmtBytes(progress.total)})
      </div>
    </div>
  ) : phase === 'ready' || phase === 'installing' ? (
    <button disabled={phase === 'installing'} onClick={install} className="rounded-xl bg-mint px-4 py-2 text-sm font-black text-white shadow-[0_3px_0_#0f9d6b] active:translate-y-0.5 disabled:opacity-60">
      {phase === 'installing' ? 'Restarting…' : '🔄 Restart & update'}
    </button>
  ) : (
    <button onClick={download} className="rounded-xl bg-grape px-4 py-2 text-sm font-black text-white shadow-[0_3px_0_#5b21b6] active:translate-y-0.5">
      ⬇️ Update to v{info.latest} ({fmtBytes(info.size)})
    </button>
  )

  if (mode === 'banner') {
    if (!available || dismissed) return null
    return (
      <div className="pop-in flex shrink-0 flex-wrap items-center justify-between gap-3 border-b-2 border-grape/20 bg-grape-soft px-5 py-2.5">
        <div className="text-sm">
          <b>🎉 {info.name} is out!</b> <span className="text-ink/60">You have v{info.current}.</span>
          {error && <span className="ml-2 font-bold text-coral">{error}</span>}
        </div>
        <div className="flex items-center gap-3">
          {action}
          {phase === 'idle' && (
            <button onClick={() => setDismissed(true)} className="text-xs font-bold text-ink/50 hover:text-ink">
              Later
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border-2 border-ink/10 bg-white px-4 py-3">
        <div className="text-sm">
          <div className="font-black">VideoGen Studio v{version}</div>
          <div className="text-ink/60">
            {phase === 'checking'
              ? 'Looking for updates…'
              : available
                ? `New version available: v${info.latest}`
                : checked
                  ? '✓ You have the latest version.'
                  : 'Updates come from the official GitHub releases.'}
          </div>
        </div>
        {available ? (
          action
        ) : (
          <button disabled={phase === 'checking'} onClick={() => check(false)} className="rounded-xl bg-ink/5 px-4 py-2 text-sm font-black hover:bg-ink/10 disabled:opacity-50">
            Check for updates
          </button>
        )}
      </div>
      {error && <div className="rounded-xl bg-coral-soft px-4 py-2 text-sm font-bold">{error}</div>}
      {available && info.notes && (
        <details className="rounded-xl bg-ink/5 px-4 py-2 text-sm" open>
          <summary className="cursor-pointer font-black">What’s new in v{info.latest}</summary>
          <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap font-sans text-[13px] text-ink/75">{info.notes}</pre>
        </details>
      )}
      {available && phase === 'ready' && <div className="text-xs text-ink/60">Downloaded and checked. The app will close, update itself and reopen — your videos and keys stay untouched.</div>}
    </div>
  )
}
