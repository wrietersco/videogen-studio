import { useEffect, useState } from 'react'
import { MEDIA_MODELS, PRICES_AS_OF, RATES, modelTags, type MediaModel } from '@shared/pricing'
import { api, type KeyId, type MediaSettings, type ModelInfo, type ProviderId, type ProviderStatus, type SettingsView } from '../api'
import { Chip, Meter, Section } from '../components/ui'

/**
 * Settings — five friendly sections: the brain (chat model), keys, media
 * models per type (with cost / speed / quality at a glance), reuse & privacy,
 * and render craft. Prices come from the release's price book.
 */

const KEYS: Array<{ id: KeyId; label: string; icon: string; what: string; where: string }> = [
  { id: 'openai', label: 'OpenAI', icon: '🟢', what: 'writing, pictures, voices', where: 'platform.openai.com → API keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', icon: '🟠', what: 'writing & directing', where: 'console.anthropic.com → API keys' },
  { id: 'gemini', label: 'Google Gemini', icon: '🔵', what: 'writing, pictures, voices', where: 'aistudio.google.com → Get API key' },
  { id: 'elevenlabs', label: 'ElevenLabs', icon: '🎙️', what: 'premium voices & music', where: 'elevenlabs.io → Developers → API keys' },
  { id: 'pexels', label: 'Pexels', icon: '📷', what: 'free stock photos & clips', where: 'pexels.com/api — free' },
  { id: 'pixabay', label: 'Pixabay', icon: '🌄', what: 'free stock photos & clips', where: 'pixabay.com/api/docs — free' }
]

const BRAIN_HINT: Record<ProviderId, string> = {
  mock: 'Free, offline, rule-based — great for trying the app. No API key needed.',
  openai: 'GPT models plan and direct your video.',
  anthropic: 'Claude plans and directs your video.',
  gemini: 'Gemini plans and directs your video.'
}

/** tags for a chat model from its rate: cheap / premium */
function chatTags(id: string): string[] {
  const r = RATES[id]
  if (!r?.outTok) return []
  if (r.outTok <= 1.5) return ['💰 cheapest']
  if (r.outTok >= 30) return ['💸 premium']
  if (r.outTok >= 12) return ['💵 pricier']
  return ['⚖️ balanced']
}

const MEDIA_KINDS: Array<{ kind: keyof MediaSettings; icon: string; title: string; hint: string }> = [
  { kind: 'image', icon: '🖼️', title: 'Pictures', hint: 'Painted backgrounds for directed scenes. Reused from your library first.' },
  { kind: 'voice', icon: '🎙️', title: 'Narrator voice', hint: 'Speaks the script. Takes are reused across videos when the line matches.' },
  { kind: 'music', icon: '🎵', title: 'Music', hint: 'The soundtrack under your video.' },
  { kind: 'video', icon: '🎬', title: 'Video clips', hint: 'B-roll clips for your library. Free stock only for now — OpenAI shut down its Sora video API in Sept 2026.' }
]

type Option = { value: string; label: string; typical: string; cost: number; speed: number; quality: number; tags: string[]; note?: string; needs?: KeyId }

function optionsFor(kind: keyof MediaSettings): Option[] {
  const fromCatalog = (m: MediaModel): Option => ({
    value: m.provider === 'stock' ? 'stock' : `${m.provider}:${m.id}`,
    label: m.label,
    typical: m.typical,
    cost: m.cost,
    speed: m.speed,
    quality: m.quality,
    tags: modelTags(m),
    note: m.note,
    needs: m.provider === 'openai' || m.provider === 'gemini' || m.provider === 'elevenlabs' ? m.provider : undefined
  })
  const list = MEDIA_MODELS.filter((m) => m.kind === kind).map(fromCatalog)
  if (kind === 'image')
    return [
      { value: 'auto', label: 'Auto', typical: 'follows your brain', cost: 2, speed: 3, quality: 3, tags: ['🪄 easiest'], note: 'the painter of your chosen engine, else any key you have' },
      ...list,
      { value: 'none', label: 'No pictures', typical: 'free', cost: 1, speed: 3, quality: 1, tags: ['💰 cheapest'], note: 'clean diagram backgrounds' }
    ]
  if (kind === 'voice')
    return [
      { value: 'auto', label: 'Auto', typical: 'first key you have', cost: 1, speed: 3, quality: 2, tags: ['🪄 easiest'] },
      ...list,
      { value: 'none', label: 'Silent (captions only)', typical: 'free', cost: 1, speed: 3, quality: 1, tags: [] }
    ]
  if (kind === 'music')
    return [
      ...list,
      { value: 'library', label: 'From my library', typical: 'free', cost: 1, speed: 3, quality: 2, tags: ['♻️ reuse', '💰 cheapest'], note: 'best mood match from built-in, uploads & stock' }
    ]
  return list
}

export default function Settings() {
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [keys, setKeys] = useState<Record<KeyId, boolean> | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Partial<Record<KeyId, string>>>({})
  const [models, setModels] = useState<Partial<Record<ProviderId, ModelInfo[]>>>({})
  const [saved, setSaved] = useState<string | null>(null)

  const refresh = async () => {
    setProviders(await api.listProviders())
    setSettings(await api.getSettings())
    setKeys(await api.keyStatus())
  }
  useEffect(() => {
    refresh()
    for (const p of ['openai', 'anthropic', 'gemini'] as ProviderId[]) {
      api
        .listModels(p)
        .then((m) => setModels((x) => ({ ...x, [p]: m })))
        .catch(() => {})
    }
  }, [])

  const flash = (t: string) => {
    setSaved(t)
    setTimeout(() => setSaved(null), 1800)
  }
  const patch = async (p: Partial<SettingsView>, msg = '✓ saved') => {
    await api.setSettings(p)
    await refresh()
    flash(msg)
  }
  const saveKey = async (id: KeyId) => {
    const k = keyDrafts[id]
    if (!k?.trim()) return
    await api.setKey(id, k)
    setKeyDrafts((d) => ({ ...d, [id]: '' }))
    await refresh()
    flash('🔐 key saved & encrypted')
  }

  if (!settings) return null
  const defaultModel: Record<string, string> = { openai: 'gpt-6-luna', anthropic: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash' }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 p-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight">⚙️ Settings</h1>
            <p className="text-sm text-white/45">Pick your engines once. Everything is billed to your own keys, and you see the real cost of every video.</p>
          </div>
          {saved && <span className="pop-in rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-bold text-emerald-200">{saved}</span>}
        </div>

        {/* brain */}
        <Section icon="🧠" title="The brain" hint="Writes the script, designs every scene and reviews the frames." tone="violet">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {providers.map((p) => {
              const active = settings.provider === p.id
              const usable = p.id === 'mock' || p.configured
              return (
                <button
                  key={p.id}
                  disabled={!usable}
                  onClick={() => patch({ provider: p.id }, `🧠 ${p.label} is now in charge`)}
                  className={`rounded-2xl border p-4 text-left transition-all hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 ${
                    active ? 'border-[#7C5CFF] bg-[#7C5CFF]/15 shadow-[0_0_24px_rgba(124,92,255,0.25)]' : 'border-white/10 bg-black/20'
                  }`}
                >
                  <div className="flex items-center justify-between text-sm font-black">
                    {p.id === 'mock' ? 'Free engine' : p.label}
                    {active && <span>✅</span>}
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-white/45">{usable ? BRAIN_HINT[p.id] : 'Add a key below to unlock'}</div>
                </button>
              )
            })}
          </div>
          {settings.provider !== 'mock' && (
            <div className="mt-4">
              <div className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-white/40">Model · cheapest → priciest</div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                {(models[settings.provider] ?? []).map((m) => {
                  const sel = (settings.models[settings.provider] || defaultModel[settings.provider]) === m.id
                  return (
                    <button
                      key={m.id}
                      onClick={() => patch({ models: { [settings.provider]: m.id } }, `✓ ${m.label}`)}
                      className={`rounded-xl border px-3 py-2 text-left transition-all ${sel ? 'border-[#00E5FF] bg-[#00E5FF]/10' : 'border-white/10 hover:bg-white/5'}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-bold">
                        {m.label}
                        <span className="text-[10px] font-semibold text-white/50">{chatTags(m.id).join(' ')}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-white/40">{m.priceNote}</div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </Section>

        {/* keys */}
        <Section icon="🔑" title="Your keys" hint="Encrypted with Windows' credential store. They never leave this PC except to call that provider.">
          <div className="space-y-2">
            {KEYS.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                <span className="text-lg">{k.icon}</span>
                <div className="w-48">
                  <div className="text-xs font-black">{k.label}</div>
                  <div className="text-[10px] text-white/40">{k.what}</div>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${keys?.[k.id] ? 'bg-emerald-400/15 text-emerald-300' : 'bg-white/5 text-white/35'}`}>
                  {keys?.[k.id] ? '● connected' : '○ not set'}
                </span>
                <input
                  type="password"
                  value={keyDrafts[k.id] ?? ''}
                  onChange={(e) => setKeyDrafts((d) => ({ ...d, [k.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey(k.id)}
                  placeholder={keys?.[k.id] ? 'paste a new key to replace' : `paste key — ${k.where}`}
                  className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs outline-none focus:border-[#7C5CFF]/60"
                />
                <button onClick={() => saveKey(k.id)} className="btn-ghost !py-1.5">
                  Save
                </button>
                {keys?.[k.id] && (
                  <button
                    onClick={async () => {
                      await api.clearKey(k.id)
                      refresh()
                      flash('key removed')
                    }}
                    title="Forget this key"
                    className="text-xs text-white/30 hover:text-red-300"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>

        {/* media models */}
        <Section
          icon="🎨"
          title="Media models"
          hint={
            <>
              Choose who makes each kind of media. <Meter value={1} max={1} icon="💰" label="cost" /> cost · <Meter value={1} max={1} icon="⚡" label="speed" /> speed ·{' '}
              <Meter value={1} max={1} icon="🏆" label="quality" /> quality. Prices as of {PRICES_AS_OF}.
            </>
          }
          tone="cyan"
        >
          <div className="space-y-5">
            {MEDIA_KINDS.map((mk) => {
              const current = settings.media?.[mk.kind] ?? ''
              return (
                <div key={mk.kind}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-base">{mk.icon}</span>
                    <span className="text-sm font-black">{mk.title}</span>
                    <span className="text-[11px] text-white/40">{mk.hint}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
                    {optionsFor(mk.kind).map((o) => {
                      const sel = current === o.value || (o.value !== 'auto' && current.startsWith(`${o.value}:`))
                      const missing = o.needs && keys && !keys[o.needs]
                      return (
                        <button
                          key={o.value}
                          onClick={() => patch({ media: { ...settings.media, [mk.kind]: o.value } }, `${mk.icon} ${o.label}`)}
                          className={`relative rounded-xl border p-3 text-left transition-all hover:-translate-y-0.5 ${
                            sel ? 'border-[#00E5FF] bg-[#00E5FF]/10 shadow-[0_0_18px_rgba(0,229,255,0.18)]' : 'border-white/10 bg-black/20 hover:bg-white/5'
                          } ${missing ? 'opacity-55' : ''}`}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <div className="text-xs font-black leading-tight">{o.label}</div>
                            {sel && <span className="text-xs">✅</span>}
                          </div>
                          <div className="mt-1 text-[11px] font-bold text-amber-200/80">{o.typical}</div>
                          <div className="mt-1.5 flex gap-2">
                            <Meter value={5 - o.cost} max={4} icon="💰" label="cheapness" />
                          </div>
                          <div className="mt-0.5 flex gap-2">
                            <Meter value={o.speed} icon="⚡" label="speed" />
                            <Meter value={o.quality} icon="🏆" label="quality" />
                          </div>
                          {o.tags.length > 0 && <div className="mt-1.5 text-[10px] text-white/50">{o.tags.join(' · ')}</div>}
                          {o.note && <div className="mt-1 text-[10px] leading-snug text-white/35">{o.note}</div>}
                          {missing && <div className="mt-1 text-[10px] font-bold text-amber-300">needs a {o.needs} key</div>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        {/* reuse & privacy */}
        <Section icon="♻️" title="Reuse & privacy" hint="Your library makes every next video faster and cheaper." tone="amber">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-bold">When a matching asset already exists…</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Chip active={settings.reuse !== 'fresh'} onClick={() => patch({ reuse: 'smart' }, '♻️ smart reuse on')}>
                  ♻️ Reuse it (saves money)
                </Chip>
                <Chip active={settings.reuse === 'fresh'} onClick={() => patch({ reuse: 'fresh' }, '✨ always fresh')}>
                  ✨ Always make new
                </Chip>
              </div>
            </div>
            <div>
              <div className="text-xs font-bold">New AI-made assets are…</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Chip active={settings.sharing !== 'shareable'} onClick={() => patch({ sharing: 'local' }, '🔒 kept on this PC')}>
                  🔒 Kept on this PC
                </Chip>
                <Chip active={settings.sharing === 'shareable'} onClick={() => patch({ sharing: 'shareable' }, '🌍 marked shareable')}>
                  🌍 Marked shareable
                </Chip>
              </div>
              <div className="mt-1.5 text-[10px] leading-snug text-white/35">
                Nothing uploads by itself. Shareable assets go into share packs you export (and the community library, when it opens). Your uploads always start private.
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={async () => {
                const r = await api.assets.exportPack()
                flash(r.exported ? `📦 exported ${r.exported} assets` : 'nothing marked shareable yet')
              }}
              className="btn-ghost"
            >
              📦 Export share pack
            </button>
            <button
              onClick={async () => {
                const r = await api.assets.importPack()
                flash(`📥 imported ${r.imported} assets`)
              }}
              className="btn-ghost"
            >
              📥 Import share pack
            </button>
          </div>
        </Section>

        {/* craft & render */}
        <Section icon="🎬" title="Craft & render">
          <div className="text-xs font-bold">Scene style</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip active={(settings.craft ?? 'directed') === 'directed'} onClick={() => patch({ craft: 'directed' })}>
              🎥 Directed (premium)
            </Chip>
            <Chip active={settings.craft === 'classic'} onClick={() => patch({ craft: 'classic' })}>
              🧩 Classic templates
            </Chip>
          </div>
          <div className="mt-1 text-[11px] text-white/40">
            Directed: a film director picks the look, a scene director designs every scene, pictures move in 2.5D, and a critic reviews the frames.
          </div>
          <div className="mt-4 text-xs font-bold">Render quality</div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(
              [
                ['draft', '🏃 Draft'],
                ['standard', '👌 Standard'],
                ['delivery', '💎 Delivery']
              ] as const
            ).map(([q, label]) => (
              <Chip key={q} active={settings.quality === q} onClick={() => patch({ quality: q })}>
                {label}
              </Chip>
            ))}
          </div>
          <label className="mt-4 flex cursor-pointer items-center gap-3 text-xs text-white/70">
            <input type="checkbox" checked={settings.allowGpu} onChange={(e) => patch({ allowGpu: e.target.checked })} className="h-4 w-4 accent-[#7C5CFF]" />
            <span>
              ⚡ GPU fast mode <span className="text-white/40">(faster, but re-renders may differ by a few pixels)</span>
            </span>
          </label>
        </Section>
      </div>
    </div>
  )
}
