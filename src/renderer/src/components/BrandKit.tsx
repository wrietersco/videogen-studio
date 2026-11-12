import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BRAND_FONTS, HEX, brandAccents, brandSummary, type BrandFont, type WatermarkPosition } from '@shared/brand'
import type { BrandOverride } from '@shared/directives'
import { api, type BrandKitPatch, type BrandKitView, type BrandResult } from '../api'
import { Chip } from './ui'

/**
 * Brand kits: a logo, colors and fonts saved once and used on every video.
 * `BrandKitSettings` is the editor (Settings); `BrandPicker` is the small
 * card on Create that says which kit this video uses and what it will do.
 */

const FILM_BG = '#090D18'
const PHOTO_BG = 'linear-gradient(135deg, #2f6f8f 0%, #d9a45b 45%, #7a3b52 100%)'

function useKits(): { kits: BrandKitView[]; lastUsedId: string; loaded: boolean; reload: () => Promise<void>; put: (kit: BrandKitView) => void } {
  const [state, setState] = useState<{ kits: BrandKitView[]; lastUsedId: string; loaded: boolean }>({ kits: [], lastUsedId: '', loaded: false })
  const reload = useCallback(async () => {
    try {
      const r = await api.brand.list()
      setState({ ...r, loaded: true })
    } catch {
      setState((s) => ({ ...s, loaded: true }))
    }
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])
  const put = useCallback((kit: BrandKitView) => setState((s) => ({ ...s, kits: s.kits.some((k) => k.id === kit.id) ? s.kits.map((k) => (k.id === kit.id ? kit : k)) : [...s.kits, kit] })), [])
  return { ...state, reload, put }
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-xs font-black uppercase tracking-wide text-ink/50">{children}</div>
}

function ColorField({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => setDraft(value ?? ''), [value])
  const commit = (v: string) => {
    const t = v.trim()
    if (!t) onChange(null)
    else if (HEX.test(t)) onChange(t.toUpperCase())
    else setDraft(value ?? '')
  }
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={label} value={value ?? '#7C3AED'} onChange={(e) => onChange(e.target.value.toUpperCase())} title={value ? label : `${label}: not set yet, click to pick one`} className={`h-9 w-11 cursor-pointer rounded-lg border-2 border-ink/10 bg-white p-0.5 ${value ? '' : 'opacity-30 grayscale'}`} />
        <input
          value={draft}
          placeholder="Not set"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
          className="w-28 rounded-lg border-2 border-ink/10 bg-white px-2 py-1.5 font-mono text-sm outline-none focus:border-grape"
        />
        {value && (
          <button onClick={() => onChange(null)} className="text-xs font-bold text-ink/45 hover:text-berry">
            Clear
          </button>
        )}
      </div>
    </div>
  )
}

function LogoTile({ src, bg, label, ratio }: { src: string; bg: string; label: string; ratio: number }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex h-24 items-center justify-center rounded-xl border-2 border-ink/10 p-4" style={{ background: bg }}>
        <img src={src} alt="" className="max-h-full max-w-full object-contain" style={{ aspectRatio: String(ratio) }} />
      </div>
      <div className="mt-1 text-center text-[11px] font-bold text-ink/50">{label}</div>
    </div>
  )
}

/** a rough picture of one frame and the end card — drawn here, so it costs nothing */
function SampleFrame({ kit }: { kit: BrandKitView }) {
  const colors = kit.colors.primary ? brandAccents({ primary: kit.colors.primary, secondary: kit.colors.secondary ?? undefined }, FILM_BG) : { accent: '#FFB547', accent2: '#3EE6FF' }
  const display = kit.fonts.display ? `'${kit.fonts.display}', sans-serif` : 'inherit'
  const logo = kit.preview?.onDark
  const frame = 'relative aspect-video min-w-0 flex-1 overflow-hidden rounded-xl'
  return (
    <div className="flex gap-3">
      <div className={frame} style={{ background: FILM_BG }}>
        {logo && kit.watermark !== 'off' && <img src={logo} alt="" className="absolute top-[9%] h-[9%] object-contain" style={kit.watermark === 'top-left' ? { left: '6%' } : { right: '6%' }} />}
        <div className="absolute inset-x-[8%] top-[34%] text-left">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: colors.accent2 }}>
            Your series
          </div>
          <div className="mt-1 text-lg font-black leading-tight text-white" style={{ fontFamily: display }}>
            A headline in <span style={{ color: colors.accent }}>your color</span>
          </div>
          <div className="mt-2 h-1 w-12 rounded-full" style={{ background: colors.accent }} />
        </div>
      </div>
      <div className={`${frame} flex flex-col items-center justify-center gap-2`} style={{ background: FILM_BG }}>
        {logo && kit.endCard ? (
          <>
            <img src={logo} alt="" className="max-h-[34%] max-w-[58%] object-contain" />
            <div className="h-1 w-8 rounded-full" style={{ background: colors.accent }} />
            {kit.tagline && <div className="px-3 text-center text-[11px] font-semibold text-white/90">{kit.tagline}</div>}
          </>
        ) : (
          <div className="px-4 text-center text-[11px] text-white/45">{logo ? 'End card is off' : 'Add a logo to get an end card'}</div>
        )}
      </div>
    </div>
  )
}

export function BrandKitSettings() {
  const { kits, lastUsedId, loaded, reload, put } = useKits()
  const [openId, setOpenId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const kit = kits.find((k) => k.id === openId) ?? kits.find((k) => k.id === lastUsedId) ?? kits[0] ?? null

  const take = (r: BrandResult): boolean => {
    if (r.ok) {
      put(r.kit)
      setError(null)
      return true
    }
    if (!r.cancelled) setError(r.error)
    return false
  }
  const save = async (patch: BrandKitPatch) => kit && take(await api.brand.update(kit.id, patch))
  const add = async () => {
    const r = await api.brand.create(kits.length ? `Brand ${kits.length + 1}` : 'My brand')
    if (take(r) && r.ok) setOpenId(r.kit.id)
  }
  const upload = async (path?: string, slot?: 'onDark' | 'onLight') => {
    if (!kit || busy) return
    setBusy(true)
    take(await api.brand.setLogo(kit.id, path, slot))
    setBusy(false)
  }
  const remove = async () => {
    if (!kit) return
    await api.brand.remove(kit.id)
    setConfirmDelete(false)
    setOpenId(null)
    await reload()
  }

  if (!loaded) return <div className="text-sm text-ink/55">Loading your brand kits…</div>
  if (!kit)
    return (
      <div>
        <p className="text-sm leading-relaxed text-ink/70">Add your logo and colors once. Every video you make can then carry them: the logo in a corner, a logo card at the end, and your colors on the highlights.</p>
        <button onClick={add} className="btn-primary mt-4">
          ＋ Create my brand kit
        </button>
        {error && <div className="mt-3 text-sm font-bold text-berry">{error}</div>}
      </div>
    )

  const ratio = kit.logo ? kit.logo.width / Math.max(1, kit.logo.height) : 1
  const fontSelect = (slot: 'display' | 'body', label: string) => (
    <div>
      <Label>{label}</Label>
      <select
        value={kit.fonts[slot] ?? ''}
        onChange={(e) => save({ fonts: { ...kit.fonts, [slot]: (e.target.value || null) as BrandFont | null } })}
        className="w-full rounded-lg border-2 border-ink/10 bg-white px-2 py-2 text-sm font-bold outline-none focus:border-grape"
      >
        <option value="">Let each video choose</option>
        {BRAND_FONTS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {kits.map((k) => (
          <Chip key={k.id} active={k.id === kit.id} onClick={() => { setOpenId(k.id); setConfirmDelete(false); setError(null) }}>
            {k.name}
          </Chip>
        ))}
        <button onClick={add} className="rounded-full border-2 border-dashed border-ink/20 px-3 py-1 text-xs font-bold text-ink/55 hover:border-grape hover:text-grape">
          ＋ New brand
        </button>
      </div>

      {error && <div className="mt-3 rounded-xl border-2 border-berry/40 bg-berry/5 px-3 py-2 text-sm font-bold text-berry">{error}</div>}

      <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5">
        <div>
          <Label>Brand name</Label>
          <input key={kit.id + 'n'} defaultValue={kit.name} maxLength={60} onBlur={(e) => e.target.value.trim() !== kit.name && save({ name: e.target.value })} className="w-full rounded-lg border-2 border-ink/10 bg-white px-3 py-2 text-sm font-bold outline-none focus:border-grape" />
        </div>
        <div>
          <Label>Line under the logo on the end card</Label>
          <input key={kit.id + 't'} defaultValue={kit.tagline} maxLength={60} placeholder="yourwebsite.com" onBlur={(e) => e.target.value.trim() !== kit.tagline && save({ tagline: e.target.value })} className="w-full rounded-lg border-2 border-ink/10 bg-white px-3 py-2 text-sm outline-none focus:border-grape" />
        </div>
      </div>

      {/* logo */}
      <div className="mt-6">
        <Label>Logo</Label>
        {kit.logo && kit.preview ? (
          <>
            <div className="flex gap-3">
              <LogoTile src={kit.preview.onLight} bg="#FFFFFF" label="On light" ratio={ratio} />
              <LogoTile src={kit.preview.onDark} bg={FILM_BG} label="On dark" ratio={ratio} />
              <LogoTile src={kit.preview.onDark} bg={PHOTO_BG} label="On a photo" ratio={ratio} />
            </div>
            {kit.logo.notes.length > 0 && (
              <ul className="mt-3 space-y-1 text-[13px] text-ink/65">
                {kit.logo.notes.map((n) => (
                  <li key={n}>• {n}</li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-bold">
              <button disabled={busy} onClick={() => upload()} className="btn-ghost">
                {busy ? 'Checking…' : 'Replace logo'}
              </button>
              <button disabled={busy} onClick={() => upload(undefined, 'onDark')} className="text-grape hover:underline">
                Use my own version for dark videos
              </button>
              <button disabled={busy} onClick={() => upload(undefined, 'onLight')} className="text-grape hover:underline">
                Use my own version for light videos
              </button>
              <button disabled={busy} onClick={async () => take(await api.brand.removeLogo(kit.id))} className="text-ink/45 hover:text-berry">
                Remove logo
              </button>
            </div>
          </>
        ) : (
          <div
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setOver(false)
              const f = e.dataTransfer.files[0]
              if (f) void upload(api.assets.pathForFile(f))
            }}
            className={`flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-8 text-center transition-colors ${over ? 'border-grape bg-grape-soft' : 'border-ink/15 bg-ink/[0.02]'}`}
          >
            <div className="text-sm text-ink/65">Drop your logo here. A transparent PNG or an SVG works best.</div>
            <button disabled={busy} onClick={() => upload()} className="btn-primary">
              {busy ? 'Checking…' : 'Choose a logo file'}
            </button>
          </div>
        )}
        <p className="mt-2 text-xs text-ink/50">Your logo stays on this computer. The app places it itself, so no AI model sees it or redraws it.</p>
      </div>

      {/* colors */}
      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3">
        <ColorField label="Main color" value={kit.colors.primary} onChange={(v) => save({ colors: { primary: v, secondary: v ? kit.colors.secondary : null } })} />
        <ColorField label="Second color (optional)" value={kit.colors.secondary} onChange={(v) => kit.colors.primary && save({ colors: { ...kit.colors, secondary: v } })} />
        {kit.logo && kit.logo.palette.length > 0 && (
          <div className="col-span-2 flex flex-wrap items-center gap-2 text-xs text-ink/60">
            Found in your logo:
            {kit.logo.palette.map((c, i) => (
              <button key={c} title={`Use ${c} as the ${i === 0 ? 'main' : 'second'} color`} onClick={() => save({ colors: i === 0 || !kit.colors.primary ? { primary: c, secondary: kit.colors.secondary } : { ...kit.colors, secondary: c } })} className="flex items-center gap-1.5 rounded-full border-2 border-ink/10 bg-white px-2 py-0.5 font-mono font-bold hover:border-grape">
                <span className="h-3.5 w-3.5 rounded-full border border-ink/10" style={{ background: c }} />
                {c}
              </button>
            ))}
          </div>
        )}
        <p className="col-span-2 text-xs text-ink/50">Colors are used for highlights and accents. If a color would be hard to read on a video's background, the app lightens or darkens it just enough.</p>
      </div>

      {/* fonts + placement */}
      <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5">
        {fontSelect('display', 'Headline font')}
        {fontSelect('body', 'Text font')}
        <div>
          <Label>Logo in the corner</Label>
          <div className="flex gap-2">
            {(['top-right', 'top-left', 'off'] as WatermarkPosition[]).map((p) => (
              <Chip key={p} active={kit.watermark === p} onClick={() => save({ watermark: p })}>
                {p === 'top-right' ? 'Top right' : p === 'top-left' ? 'Top left' : 'Off'}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <Label>Logo card at the end</Label>
          <label className="flex cursor-pointer items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={kit.endCard} onChange={(e) => save({ endCard: e.target.checked })} className="h-4 w-4 accent-grape" />
            Add about 2 seconds with my logo
          </label>
        </div>
      </div>
      <p className="mt-2 text-xs text-ink/50">Headline and text fonts apply to classic template videos. Directed videos keep their own type for now.</p>

      {/* sample */}
      <div className="mt-6">
        <Label>How it will look (rough preview, free)</Label>
        <SampleFrame kit={kit} />
      </div>

      <div className="mt-5 flex items-center gap-3 text-xs font-bold">
        {confirmDelete ? (
          <>
            <span className="text-ink/70">Delete "{kit.name}" and its logo? Videos you already made keep theirs.</span>
            <button onClick={remove} className="text-berry hover:underline">
              Yes, delete
            </button>
            <button onClick={() => setConfirmDelete(false)} className="text-ink/50 hover:underline">
              Keep it
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmDelete(true)} className="text-ink/40 hover:text-berry">
            Delete this brand kit
          </button>
        )}
      </div>
    </div>
  )
}

/** Create screen: which brand this video uses, and exactly what the app will do with it */
export function BrandPicker({ value, onChange, onManage, override, onOverride, onKitInfo }: { value: string; onChange: (id: string) => void; onManage: () => void; override?: BrandOverride; onOverride?: (o: BrandOverride | undefined) => void; onKitInfo?: (info: { hasLogo: boolean } | null) => void }) {
  const { kits, lastUsedId, loaded, reload } = useKits()
  const [touched, setTouched] = useState(false)
  // a new video starts with the kit used last time
  useEffect(() => {
    if (loaded && !touched && lastUsedId && lastUsedId !== value) onChange(lastUsedId)
  }, [loaded, touched, lastUsedId, value, onChange])
  // a kit deleted in Settings can no longer be chosen
  useEffect(() => {
    if (loaded && value && !kits.some((k) => k.id === value)) onChange('')
  }, [loaded, kits, value, onChange])
  useEffect(() => {
    const again = () => void reload()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [reload])

  const pick = (id: string) => {
    setTouched(true)
    onChange(id)
    void api.brand.setLastUsed(id)
  }
  const kit = kits.find((k) => k.id === value) ?? null
  const lines = kit ? brandSummary(kit, override) : []
  const hasLogo = Boolean(kit?.logo)
  useEffect(() => {
    onKitInfo?.(kit ? { hasLogo } : null)
  }, [kit?.id, hasLogo, onKitInfo]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="card mt-4 p-5">
      <div className="flex items-center justify-between">
        <div className="text-base font-black">🎨 Your brand</div>
        <button onClick={onManage} className="text-xs font-bold text-grape hover:underline">
          {kits.length ? 'Edit brand kits' : 'Set up a brand kit'}
        </button>
      </div>
      {!loaded ? null : kits.length === 0 ? (
        <p className="mt-2 text-sm leading-relaxed text-ink/65">Add your logo and colors once in Settings, and every video can carry them.</p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {kits.map((k) => (
              <Chip key={k.id} active={k.id === value} onClick={() => pick(k.id)}>
                {k.name}
              </Chip>
            ))}
            <Chip active={!value} onClick={() => pick('')}>
              No brand
            </Chip>
          </div>
          {kit && (
            <div className="mt-3 flex items-start gap-3 rounded-xl bg-ink/[0.04] p-3">
              {kit.preview && (
                <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-lg p-1.5" style={{ background: FILM_BG }}>
                  <img src={kit.preview.onDark} alt="" className="max-h-full max-w-full object-contain" />
                </div>
              )}
              <div className="min-w-0 text-sm">
                <div className="flex items-center gap-2 font-black">
                  This video will use
                  {override && (
                    <button onClick={() => onOverride?.(undefined)} className="rounded-full bg-grape-soft px-2 py-0.5 text-[11px] font-bold text-grape hover:underline" title="Go back to this kit's own logo settings">
                      logo changed by your prompt · undo
                    </button>
                  )}
                </div>
                {lines.length ? (
                  <ul className="mt-0.5 text-ink/70">
                    {lines.map((l) => (
                      <li key={l}>• {l}</li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-0.5 text-ink/60">Nothing yet. This kit has no logo or colors.</div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
