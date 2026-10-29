import { useEffect, useMemo, useRef, useState } from 'react'
import { KIND_LABEL, SOURCE_BADGE, type AssetKind, type AssetMeta, type AssetSource } from '@shared/assets'
import { fmtUsd } from '@shared/pricing'
import { api, type Orientation, type StockResult } from '../api'
import { Chip, EmptyState, SourceBadge, Toast, fmtBytes, fmtDur } from '../components/ui'
import { friendlyError } from '../components/friendly'

/**
 * Asset library — everything the app can reuse: built-in pack, AI-made
 * assets, the user's uploads and free stock downloads. Each source has its
 * own badge; new videos look here first before paying for anything.
 */

const KINDS: Array<AssetKind | 'all'> = ['all', 'image', 'video', 'voice', 'music', 'sfx']
const SOURCES: AssetSource[] = ['builtin', 'generated', 'uploaded', 'stock']
const fileUrl = (id: string) => `vgasset://file/${encodeURIComponent(id)}`
const thumbUrl = (id: string) => `vgasset://thumb/${encodeURIComponent(id)}`

type Panel = null | 'stock' | 'make'

export default function Assets() {
  const [assets, setAssets] = useState<AssetMeta[]>([])
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.assets.stats>> | null>(null)
  const [kind, setKind] = useState<AssetKind | 'all'>('all')
  const [source, setSource] = useState<AssetSource | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<AssetMeta | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [toast, setToast] = useState<{ text: string; tone?: 'ok' | 'err' } | null>(null)
  const [dragging, setDragging] = useState(false)

  const refresh = async () => {
    const list = await api.assets.list({ kind: kind === 'all' ? undefined : kind, source: source ?? undefined, query })
    setAssets(list)
    setStats(await api.assets.stats())
  }
  useEffect(() => {
    const t = setTimeout(refresh, query ? 180 : 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, source, query])

  const say = (text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone })
    setTimeout(() => setToast(null), 3800)
  }

  const upload = async (paths?: string[]) => {
    const r = await api.assets.upload(paths)
    if (r.added.length) say(`⬆️ Added ${r.added.length} file${r.added.length > 1 ? 's' : ''} to your library${r.skipped.length ? ` · skipped ${r.skipped.length}` : ''}`)
    else if (r.skipped.length) say(`Couldn't add ${r.skipped.join(', ')} — images, clips and audio only`, 'err')
    refresh()
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => api.assets.pathForFile(f)).filter(Boolean)
    if (paths.length) upload(paths)
  }

  return (
    <div
      className="page-bg relative flex h-full flex-col"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={onDrop}
    >
      {/* header */}
      <div className="border-b-2 border-ink/5 bg-white/60 px-8 pb-4 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-black tracking-tight">🧺 Library</h1>
            <p className="mt-1 text-[15px] text-ink/60">
              Pictures, clips, voices and music your videos reuse. The more you collect, the faster and cheaper new videos get.
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => upload()} className="btn-ghost">
              ⬆️ Upload
            </button>
            <button onClick={() => setPanel('stock')} className="btn-ghost">
              🌐 Free stock
            </button>
            <button onClick={() => setPanel('make')} className="btn-primary">
              ✨ Make with AI
            </button>
          </div>
        </div>

        {/* source counters double as filters */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {SOURCES.map((s) => (
            <button
              key={s}
              onClick={() => setSource(source === s ? null : s)}
              className={`tile px-3 py-2 text-left ${source === s ? 'tile-on' : ''}`}
              title={`Show only ${SOURCE_BADGE[s].label.toLowerCase()} items`}
            >
              <div className="text-lg font-black">
                {SOURCE_BADGE[s].icon} {stats?.[s] ?? 0}
              </div>
              <div className="text-[10px] font-bold uppercase tracking-wider text-ink/60">{SOURCE_BADGE[s].label}</div>
            </button>
          ))}
          <div className="ml-auto text-[11px] text-ink/45">{stats ? `${stats.total} assets · ${fmtBytes(stats.bytes)}` : ''}</div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {KINDS.map((k) => (
            <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
              {k === 'all' ? '🌈 Everything' : `${KIND_LABEL[k].icon} ${KIND_LABEL[k].label}`}
            </Chip>
          ))}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="🔎 search tags, titles, prompts…"
            className="field ml-auto w-72 !rounded-full px-4 py-1.5 text-sm"
          />
        </div>
      </div>

      {/* grid */}
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {assets.length === 0 ? (
          <EmptyState emoji={query ? '🕵️' : '🫙'} title={query ? 'Nothing matches that (yet)' : 'This shelf is empty'}>
            {query ? 'Try fewer words — or grab something from free stock or make it with AI.' : 'Drop files anywhere on this screen, search free stock, or make something with AI.'}
          </EmptyState>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4">
            {assets.map((a, i) => (
              <AssetCard key={a.id} a={a} delay={Math.min(i, 20) * 25} onOpen={() => setSelected(a)} />
            ))}
          </div>
        )}
      </div>

      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-40 flex items-center justify-center rounded-3xl border-2 border-dashed border-sky bg-sky/10">
          <div className="pop-in text-center">
            <div className="text-5xl">📥</div>
            <div className="mt-2 text-lg font-black">Drop to add to your library</div>
            <div className="text-sm text-ink/80">images · video clips · music & audio</div>
          </div>
        </div>
      )}

      {selected && (
        <AssetDrawer
          a={selected}
          onClose={() => setSelected(null)}
          onChanged={(next) => {
            setSelected(next)
            refresh()
          }}
          onDeleted={() => {
            setSelected(null)
            say('🗑️ Removed from your library')
            refresh()
          }}
        />
      )}
      {panel === 'stock' && (
        <StockPanel
          initialKind={kind === 'all' || kind === 'voice' ? 'image' : kind}
          onClose={() => setPanel(null)}
          onAdded={(a) => {
            say(`🌐 Saved “${a.title.slice(0, 40)}” with its licence`)
            refresh()
          }}
        />
      )}
      {panel === 'make' && (
        <MakePanel
          onClose={() => setPanel(null)}
          onMade={(a) => {
            say(`✨ Made “${a.title.slice(0, 40)}”${a.costUsd ? ` for ${fmtUsd(a.costUsd)}` : ''}`)
            refresh()
          }}
          onError={(m) => {
            const f = friendlyError(m)
            say(`${f.title} — ${f.fix}`, 'err')
          }}
        />
      )}
      {toast && <Toast text={toast.text} tone={toast.tone} onClose={() => setToast(null)} />}
    </div>
  )
}

function AssetCard({ a, onOpen, delay }: { a: AssetMeta; onOpen: () => void; delay: number }) {
  const visual = a.kind === 'image' || a.kind === 'video'
  return (
    <button
      onClick={onOpen}
      className="pop-in group overflow-hidden rounded-2xl border-2 border-ink/10 bg-white text-left transition-all hover:-translate-y-1 hover:border-grape/50 hover:shadow-[0_10px_30px_rgba(124,58,237,0.18)]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="relative aspect-[4/3] overflow-hidden bg-ink/5">
        {visual ? (
          <img src={thumbUrl(a.id)} alt="" loading="lazy" className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-grape-soft to-berry-soft">
            <div className="text-4xl transition-transform group-hover:scale-110">{KIND_LABEL[a.kind].icon}</div>
            <div className="text-[10px] font-bold text-ink/60">{fmtDur(a.durationSec)}</div>
          </div>
        )}
        {a.kind === 'video' && <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1 text-[9px] font-bold text-white">▶ {fmtDur(a.durationSec)}</span>}
        <span className="absolute left-1.5 top-1.5">
          <SourceBadge source={a.source} small />
        </span>
        {a.favorite && <span className="absolute right-1.5 top-1.5 text-sm">⭐</span>}
      </div>
      <div className="p-2.5">
        <div className="truncate text-xs font-bold text-ink/80">{a.title}</div>
        <div className="mt-1 flex items-center justify-between text-[10px] text-ink/45">
          <span className="truncate">{a.tags.slice(0, 3).join(' · ')}</span>
          {a.usedIn.length > 0 && <span title="videos that used it">♻️ {a.usedIn.length}</span>}
        </div>
      </div>
    </button>
  )
}

function AssetDrawer({ a, onClose, onChanged, onDeleted }: { a: AssetMeta; onClose: () => void; onChanged: (a: AssetMeta) => void; onDeleted: () => void }) {
  const [title, setTitle] = useState(a.title)
  const [tags, setTags] = useState(a.tags.join(', '))
  const editable = a.source !== 'builtin'
  useEffect(() => {
    setTitle(a.title)
    setTags(a.tags.join(', '))
  }, [a])

  const save = async (patch: Parameters<typeof api.assets.update>[1]) => {
    const next = await api.assets.update(a.id, patch)
    if (next) onChanged(next)
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/30 backdrop-blur-sm" onClick={onClose}>
      <div className="slide-in-right h-full w-[420px] overflow-y-auto rounded-l-3xl border-l-2 border-ink/10 bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <SourceBadge source={a.source} />
          <button onClick={onClose} className="text-ink/60 hover:text-ink">
            ✕
          </button>
        </div>
        <div className="mt-4 overflow-hidden rounded-2xl border border-ink/10 bg-ink/5">
          {a.kind === 'image' && <img src={fileUrl(a.id)} alt="" className="w-full" />}
          {a.kind === 'video' && <video src={fileUrl(a.id)} controls className="w-full" />}
          {(a.kind === 'music' || a.kind === 'voice' || a.kind === 'sfx') && (
            <div className="p-4">
              <div className="mb-3 text-center text-5xl">{KIND_LABEL[a.kind].icon}</div>
              <audio src={fileUrl(a.id)} controls className="w-full" />
            </div>
          )}
        </div>

        {editable ? (
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== a.title && save({ title })}
            className="mt-4 w-full rounded-lg border border-transparent bg-transparent px-1 text-lg font-black outline-none hover:border-grape/50 focus:border-grape/60"
          />
        ) : (
          <div className="mt-4 text-lg font-black">{a.title}</div>
        )}

        <div className="mt-3 text-[10px] font-bold uppercase tracking-wider text-ink/45">Tags (help new videos find it)</div>
        {editable ? (
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={() => save({ tags: tags.split(',') })}
            placeholder="product, bottle, blue…"
            className="field mt-1 w-full px-3 py-1.5 text-sm"
          />
        ) : (
          <div className="mt-1 text-xs text-ink/80">{a.tags.join(', ')}</div>
        )}

        <dl className="mt-4 grid grid-cols-[110px_1fr] gap-y-1.5 text-xs">
          <dt className="text-ink/60">Type</dt>
          <dd>
            {KIND_LABEL[a.kind].icon} {a.kind}
            {a.width ? ` · ${a.width}×${a.height}` : ''}
            {a.durationSec ? ` · ${fmtDur(a.durationSec)}` : ''}
          </dd>
          <dt className="text-ink/60">Size</dt>
          <dd>{fmtBytes(a.bytes)}</dd>
          {a.provider && (
            <>
              <dt className="text-ink/60">Made with</dt>
              <dd>
                {a.provider} · {a.model}
              </dd>
            </>
          )}
          {typeof a.costUsd === 'number' && (
            <>
              <dt className="text-ink/60">Cost</dt>
              <dd>{fmtUsd(a.costUsd)}</dd>
            </>
          )}
          <dt className="text-ink/60">Used in</dt>
          <dd>{a.usedIn.length ? `${a.usedIn.length} video${a.usedIn.length > 1 ? 's' : ''} ♻️` : 'not yet'}</dd>
          <dt className="text-ink/60">Licence</dt>
          <dd>
            {a.license.name}
            {a.license.author ? ` · ${a.license.author}` : ''}
          </dd>
        </dl>
        {a.license.requiresAttribution && a.license.attribution && (
          <div className="mt-2 rounded-lg border border-sunny/50 bg-sunny-soft p-2 text-[11px] text-ink">
            ✍️ Credit needed: {a.license.attribution}
          </div>
        )}
        {a.prompt && (
          <div className="mt-3 rounded-lg bg-white p-2.5 text-[11px] leading-relaxed text-ink/60">
            <div className="mb-1 font-bold text-ink/60">Prompt</div>
            {a.prompt}
          </div>
        )}

        {editable && (
          <div className="mt-4 rounded-xl border border-ink/10 p-3">
            <div className="text-xs font-bold">Who can see it?</div>
            <div className="mt-2 flex gap-2">
              <Chip active={a.sharing === 'local'} onClick={() => save({ sharing: 'local' })}>
                🔒 Only this PC
              </Chip>
              <Chip active={a.sharing === 'shareable'} onClick={() => save({ sharing: 'shareable' })}>
                🌍 OK to share
              </Chip>
            </div>
            <div className="mt-1.5 text-[10px] text-ink/45">Shareable assets go into share packs you export. Nothing is uploaded automatically.</div>
          </div>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={() => save({ favorite: !a.favorite })} className="btn-ghost">
            {a.favorite ? '⭐ Favourite' : '☆ Favourite'}
          </button>
          <button onClick={() => api.assets.reveal(a.id)} className="btn-ghost">
            📂 Show file
          </button>
          {editable && (
            <button
              onClick={async () => {
                if (confirm(`Remove “${a.title}” from your library? Videos already made keep their copy.`)) {
                  await api.assets.remove(a.id)
                  onDeleted()
                }
              }}
              className="btn-ghost !text-coral hover:!bg-coral-soft"
            >
              🗑️ Remove
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function StockPanel({ initialKind, onClose, onAdded }: { initialKind: AssetKind; onClose: () => void; onAdded: (a: AssetMeta) => void }) {
  const [kind, setKind] = useState<AssetKind>(initialKind)
  const [q, setQ] = useState('')
  const [orientation, setOrientation] = useState<Orientation | ''>('')
  const [results, setResults] = useState<StockResult[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState<Set<string>>(new Set())
  const [saved, setSaved] = useState<Set<string>>(new Set())
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const search = async () => {
    if (!q.trim()) return
    setBusy(true)
    try {
      const r = await api.stock.search(kind, q, orientation || undefined)
      setResults(r.results)
      setErrors(r.errors)
    } catch (e) {
      setErrors([String((e as Error).message)])
    } finally {
      setBusy(false)
    }
  }

  const grab = async (r: StockResult) => {
    setSaving((s) => new Set(s).add(r.id))
    try {
      const a = await api.stock.download(r, q.split(/\s+/).filter(Boolean))
      setSaved((s) => new Set(s).add(r.id))
      onAdded(a)
    } catch (e) {
      setErrors([`Couldn't download: ${(e as Error).message}`])
    } finally {
      setSaving((s) => {
        const n = new Set(s)
        n.delete(r.id)
        return n
      })
    }
  }

  return (
    <Modal title="🌐 Free stock" subtitle="Openverse, Wikimedia Commons (no key needed), Pexels and Pixabay — best matches first, licence and credit saved with every download." onClose={onClose}>
      <div className="flex flex-wrap items-center gap-2">
        {(['image', 'video', 'music'] as AssetKind[]).map((k) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
            {KIND_LABEL[k].icon} {KIND_LABEL[k].label}
          </Chip>
        ))}
        {kind !== 'music' &&
          (['', 'landscape', 'portrait', 'square'] as const).map((o) => (
            <Chip key={o} active={orientation === o} onClick={() => setOrientation(o)}>
              {o === '' ? 'any shape' : o === 'landscape' ? '▭ wide' : o === 'portrait' ? '▯ tall' : '□ square'}
            </Chip>
          ))}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          search()
        }}
      >
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. mountain sunrise, coffee beans, city at night"
          className="field min-w-0 flex-1 px-4 py-2 text-sm"
        />
        <button className="btn-primary" disabled={busy}>
          {busy ? '⏳' : '🔎'} Search
        </button>
      </form>
      {errors.map((e) => (
        <div key={e} className="mt-2 text-xs text-ink">
          ⚠️ {e}
        </div>
      ))}
      <div className="mt-4 grid max-h-[55vh] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 overflow-y-auto pr-1">
        {results.map((r) => (
          <div key={r.id} className="overflow-hidden rounded-xl border border-ink/10 bg-white">
            {r.kind === 'music' ? (
              <div className="p-2">
                <div className="truncate text-xs font-bold">{r.title}</div>
                <audio src={r.downloadUrl} controls preload="none" className="mt-1 w-full" />
              </div>
            ) : (
              <img src={r.thumb} alt="" loading="lazy" className="aspect-[4/3] w-full object-cover" />
            )}
            <div className="flex items-center justify-between gap-1 p-2">
              <span className="truncate text-[10px] text-ink/60" title={r.license.attribution ?? r.license.name}>
                {r.license.name}
              </span>
              <button
                onClick={() => grab(r)}
                disabled={saving.has(r.id) || saved.has(r.id)}
                className="shrink-0 rounded-lg bg-mint-soft px-2 py-1 text-[10px] font-bold text-mint hover:bg-mint-soft disabled:opacity-60"
              >
                {saved.has(r.id) ? '✓ saved' : saving.has(r.id) ? '…' : '＋ Save'}
              </button>
            </div>
          </div>
        ))}
        {!busy && results.length === 0 && q && <div className="col-span-full py-8 text-center text-sm text-ink/45">Press Search to look around 👀</div>}
      </div>
    </Modal>
  )
}

/** “Shot 1 (…): text  Shot 2 (…): text” → one prompt per shot; fewer than two markers means a plain single prompt */
function splitShots(text: string): string[] {
  const marker = /^[\s\-*•○]*\**\s*shot\s*\d+[^\n:]*:?\**[ \t]*/gim
  if ((text.match(marker) ?? []).length < 2) return []
  return text
    .split(marker)
    .slice(1)
    .map((s) => s.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 8)
}

function MakePanel({ onClose, onMade, onError }: { onClose: () => void; onMade: (a: AssetMeta) => void; onError: (m: string) => void }) {
  const [kind, setKind] = useState<'image' | 'video' | 'voice' | 'music'>('image')
  const [prompt, setPrompt] = useState('')
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<AssetMeta | null>(null)
  const hint = useMemo(
    () =>
      ({
        image: 'A detailed picture — e.g. “a cosy reading nook at golden hour, film photo”',
        video: 'A short shot with motion — e.g. “slow drone push over misty pine forest at dawn” (Gemini Omni, ≈ $0.80, takes a minute or two). Paste “Shot 1: … Shot 2: …” to chain several shots into one clip.',
        voice: 'The exact line to speak — uses your narrator from Settings → Media',
        music: 'Mood + vibe — e.g. “upbeat lo-fi beat for a cooking video” (needs ElevenLabs)'
      })[kind],
    [kind]
  )
  const shots = useMemo(() => (kind === 'video' ? splitShots(prompt) : []), [kind, prompt])
  const go = async () => {
    setBusy(true)
    setMade(null)
    try {
      const a = await api.assets.generate({ kind, prompt, orientation, shots: kind === 'video' ? shots : undefined })
      if (a) {
        setMade(a)
        onMade(a)
      }
    } catch (e) {
      onError(`😬 ${String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal title="✨ Make with AI" subtitle="Uses your own API keys and the models picked in Settings → Media. The cost shows on the asset." onClose={onClose}>
      <div className="flex gap-2">
        {(['image', 'video', 'voice', 'music'] as const).map((k) => (
          <Chip key={k} active={kind === k} onClick={() => setKind(k)}>
            {KIND_LABEL[k].icon} {k === 'image' ? 'Picture' : k === 'video' ? 'Video clip' : k === 'voice' ? 'Voice line' : 'Music track'}
          </Chip>
        ))}
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={3}
        placeholder={hint}
        className="field mt-3 w-full resize-none px-4 py-3 text-sm"
      />
      {(kind === 'image' || kind === 'video') && (
        <div className="mt-2 flex gap-2">
          {(kind === 'video' ? (['portrait', 'landscape'] as const) : (['portrait', 'landscape', 'square'] as const)).map((o) => (
            <Chip key={o} active={orientation === o} onClick={() => setOrientation(o)}>
              {o === 'landscape' ? '▭ wide' : o === 'portrait' ? '▯ tall' : '□ square'}
            </Chip>
          ))}
        </div>
      )}
      {shots.length > 1 && (
        <div className="mt-2 rounded-xl border border-ink/10 bg-ink/5 p-3 text-xs text-ink/70">
          🎞️ Found {shots.length} shots — each one starts from the last frame of the one before, then they’re joined into one clip. About {fmtUsd(shots.length * 0.8)} and {shots.length * 2}+ minutes.
        </div>
      )}
      <button onClick={go} disabled={busy || !prompt.trim()} className="btn-primary mt-4 w-full !py-3">
        {busy ? <span className="pulse-dot">✨ Making it…</span> : shots.length > 1 ? `✨ Make ${shots.length}-shot sequence` : '✨ Make it'}
      </button>
      {made && (
        <div className="pop-in mt-4 flex items-center gap-3 rounded-xl border border-mint/40 bg-mint-soft p-3">
          {made.kind === 'image' ? (
            <img src={thumbUrl(made.id)} alt="" className="h-16 w-16 rounded-lg object-cover" />
          ) : made.kind === 'video' ? (
            <video src={fileUrl(made.id)} controls className="h-24 rounded-lg" />
          ) : <audio src={fileUrl(made.id)} controls className="h-8 flex-1" />}
          <div className="text-xs text-mint">Saved to your library {made.costUsd ? `· ${fmtUsd(made.costUsd)}` : ''}</div>
        </div>
      )}
    </Modal>
  )
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/30 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="pop-in w-full max-w-3xl rounded-3xl border-2 border-ink/10 bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-black">{title}</div>
            {subtitle && <div className="mt-0.5 text-xs text-ink/60">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-ink/60 hover:text-ink">
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  )
}
