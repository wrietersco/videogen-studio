import { useEffect, useState } from 'react'
import { MEDIA_MODELS, PRICES_AS_OF, RATES, modelTags, type MediaModel } from '@shared/pricing'
import { api, type KeyId, type MediaSettings, type ModelInfo, type ProviderId, type ProviderStatus, type SettingsView } from '../api'
import { Chip, Meter, Section } from '../components/ui'
import Updater from '../components/Updater'

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
  { kind: 'video', icon: '🎬', title: 'Video clips', hint: 'The engine picks the few scenes where real motion matters (waves, lava, crowds) and turns them into moving clips — up to 3 per video.' }
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
  if (kind === 'video')
    return [...list, { value: 'none', label: 'Stills only', typical: 'free', cost: 1, speed: 3, quality: 2, tags: ['💰 cheapest'], note: 'painted pictures with a 3D camera move, never clips' }]
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
  const [confirmPilot, setConfirmPilot] = useState(false)

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
    <div className="page-bg h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-5 p-8">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-3xl font-black tracking-tight">⚙️ Settings</h1>
            <p className="mt-1 text-[15px] text-ink/60">Connect your AI accounts and choose who makes what. You pay the providers directly, and every video shows you what it cost.</p>
          </div>
          {saved && <span className="pop-in rounded-full bg-mint-soft px-3 py-1 text-xs font-bold text-mint">{saved}</span>}
        </div>

        {keys && !keys.openai && !keys.anthropic && !keys.gemini && (
          <div className="pop-in flex items-start gap-3 rounded-2xl border-2 border-sunny/60 bg-sunny-soft p-4">
            <span className="text-2xl">👋</span>
            <div className="text-sm text-ink/80">
              <div className="font-black text-ink">New here? Start with one key.</div>
              The free engine works without any keys, so you can try the app right away. For premium videos, paste an <b>OpenAI</b> or <b>Google Gemini</b> key below. Either one covers writing, pictures and voices.
            </div>
          </div>
        )}

        <Section icon="🤖" title="Full autonomous agent" hint="Let the app tune the options for each video, so you only write the idea." tone="violet">
          <label className="flex cursor-pointer items-center gap-3 text-sm font-bold">
            <input
              type="checkbox"
              checked={settings.autopilot || confirmPilot}
              onChange={(e) => (e.target.checked ? setConfirmPilot(true) : (setConfirmPilot(false), patch({ autopilot: false })))}
              className="h-4 w-4 accent-grape"
            />
            Full autonomous agent
          </label>
          <div className="mt-2 text-[11px] text-ink/60">
            For each video it picks the look (pictures or diagrams), whether moving clips are worth it, and reuses your library to save money.
            <b> It never changes your AI provider or models, never picks a costlier engine than the one you chose, and never touches your keys.</b> Every decision is written to the video's activity log.
          </div>
          {confirmPilot && !settings.autopilot && (
            <div className="pop-in mt-3 flex items-center gap-3 rounded-2xl border-2 border-sunny/60 bg-sunny-soft p-3 text-xs text-ink/80">
              <span>Hand these options to the agent?</span>
              <button className="btn-primary" onClick={() => (patch({ autopilot: true }), setConfirmPilot(false))}>Yes, take control</button>
              <button className="btn-ghost" onClick={() => setConfirmPilot(false)}>Cancel</button>
            </div>
          )}
        </Section>

        <Section icon="🔄" title="App updates" hint="Get the newest version straight from GitHub — one click, and your videos and keys stay put." tone="cyan">
          <Updater mode="card" />
        </Section>

        {/* keys */}
        <Section icon="🔑" title="Your AI accounts" hint="Paste a key to connect an account. Keys are encrypted on this PC and only ever sent to that company." tone="amber">
          <div className="space-y-2">
            {KEYS.map((k) => (
              <div key={k.id} className={`flex flex-wrap items-center gap-3 rounded-2xl border-2 px-4 py-3 transition-colors ${keys?.[k.id] ? 'border-mint/40 bg-mint-soft/50' : 'border-ink/10 bg-white'}`}>
                <span className="text-lg">{k.icon}</span>
                <div className="w-56">
                  <div className="text-sm font-black">{k.label}</div>
                  <div className="text-[11px] text-ink/60">For {k.what}</div>
                  {!keys?.[k.id] && <div className="text-[10px] text-ink/45">Get one: {k.where}</div>}
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${keys?.[k.id] ? 'bg-mint text-white' : 'bg-ink/5 text-ink/50'}`}>
                  {keys?.[k.id] ? '✓ Connected' : 'Not connected'}
                </span>
                <input
                  type="password"
                  value={keyDrafts[k.id] ?? ''}
                  onChange={(e) => setKeyDrafts((d) => ({ ...d, [k.id]: e.target.value }))}
                  onKeyDown={(e) => e.key === 'Enter' && saveKey(k.id)}
                  placeholder={keys?.[k.id] ? 'Paste a new key to replace it' : 'Paste your key here'}
                  className="field min-w-0 flex-1 px-3 py-2 text-sm"
                />
                <button onClick={() => saveKey(k.id)} disabled={!keyDrafts[k.id]?.trim()} className="btn-primary">
                  Save
                </button>
                {keys?.[k.id] && (
                  <button
                    onClick={async () => {
                      await api.clearKey(k.id)
                      refresh()
                      flash('key removed')
                    }}
                    title="Disconnect — forget this key"
                    className="rounded-lg px-1.5 text-xs text-ink/45 hover:bg-coral-soft hover:text-coral"
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
        </Section>

        {/* brain */}
        <Section icon="🧠" title="Who writes & directs your videos" hint="This AI writes the script, plans each scene and checks the result." tone="violet">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {providers.map((p) => {
              const active = settings.provider === p.id
              const usable = p.id === 'mock' || p.configured
              return (
                <button
                  key={p.id}
                  disabled={!usable}
                  onClick={() => patch({ provider: p.id }, `🧠 ${p.label} is now in charge`)}
                  className={`tile flex flex-col justify-start p-4 text-left disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 ${active ? 'tile-on' : ''}`}
                >
                  <div className="flex items-center justify-between text-sm font-black">
                    {p.id === 'mock' ? '🆓 Free engine' : p.label}
                    {active && <span>✅</span>}
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-ink/60">{usable ? BRAIN_HINT[p.id] : '🔒 Connect this account above first'}</div>
                </button>
              )
            })}
          </div>
          {settings.provider !== 'mock' && (
            <details className="group mt-4">
              <summary className="cursor-pointer select-none text-sm font-bold text-grape">
                <span className="text-ink/70">Model: </span>
                {(models[settings.provider] ?? []).find((m) => m.id === (settings.models[settings.provider] || defaultModel[settings.provider]))?.label ??
                  settings.models[settings.provider] ??
                  defaultModel[settings.provider]}
                <span className="ml-2 text-xs font-semibold group-open:hidden">▾ change (the default is a great pick)</span>
              </summary>
              <div className="mb-1.5 mt-3 text-[11px] font-bold text-ink/55">Cheapest first → most expensive last</div>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                {(models[settings.provider] ?? []).map((m) => {
                  const sel = (settings.models[settings.provider] || defaultModel[settings.provider]) === m.id
                  return (
                    <button
                      key={m.id}
                      onClick={() => patch({ models: { [settings.provider]: m.id } }, `✓ ${m.label}`)}
                      className={`tile px-3 py-2 text-left ${sel ? 'tile-on' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs font-bold">
                        {m.label}
                        <span className="text-[10px] font-semibold text-ink/60">{chatTags(m.id).join(' ')}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] text-ink/60">{m.priceNote}</div>
                    </button>
                  )
                })}
              </div>
            </details>
          )}
        </Section>

        {/* media models */}
        <Section
          icon="🎨"
          title="Pictures, voices, music & clips"
          hint={
            <>
              Choose who makes each part. Not sure? Keep <b>Auto</b>. Each card shows the price, the speed and the quality. Prices as of {PRICES_AS_OF}.
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
                    <span className="text-lg">{mk.icon}</span>
                    <span className="text-base font-black">{mk.title}</span>
                    <span className="text-xs text-ink/55">{mk.hint}</span>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
                    {optionsFor(mk.kind).map((o) => {
                      const sel = current === o.value || (o.value !== 'auto' && current.startsWith(`${o.value}:`))
                      const missing = o.needs && keys && !keys[o.needs]
                      return (
                        <button
                          key={o.value}
                          onClick={() => patch({ media: { ...settings.media, [mk.kind]: o.value } }, `${mk.icon} ${o.label}`)}
                          className={`tile relative flex flex-col justify-start p-3 text-left ${sel ? 'tile-on' : ''} ${missing ? 'opacity-55' : ''}`}
                        >
                          <div className="flex items-start justify-between gap-1">
                            <div className="text-xs font-black leading-tight">{o.label}</div>
                            {sel && <span className="text-xs">✅</span>}
                          </div>
                          <div className="mt-1.5 flex items-center gap-1.5">
                            <span className="rounded-full bg-sunny-soft px-2 py-0.5 text-[11px] font-black text-ink" title="Price">
                              {o.typical}
                            </span>
                            <span className="text-sm font-black tracking-tight text-mint" title="Cost: more $ = pricier">
                              {'$'.repeat(Math.max(1, o.cost))}
                              <span className="text-ink/15">{'$'.repeat(Math.max(0, 4 - Math.max(1, o.cost)))}</span>
                            </span>
                          </div>
                          <div className="mt-2 flex flex-col gap-1">
                            <Meter value={o.speed} icon="⚡" label="Speed" color="bg-sky" />
                            <Meter value={o.quality} icon="🏆" label="Quality" color="bg-berry" />
                          </div>
                          {o.tags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {o.tags.map((t) => (
                                <span key={t} className="rounded-full bg-ink/5 px-2 py-0.5 text-[11px] font-bold text-ink/75">
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                          {o.note && <div className="mt-1.5 text-[11px] leading-snug text-ink/55">{o.note}</div>}
                          {missing && <div className="mt-1.5 rounded-lg bg-coral-soft px-1.5 py-0.5 text-[10px] font-bold text-coral">🔒 Connect your {KEYS.find((k) => k.id === o.needs)?.label ?? o.needs} account first</div>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        {/* advanced — tucked away, the defaults are good */}
        <details className="card group p-6">
          <summary className="flex cursor-pointer select-none items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-ink/5 text-xl">🛠️</span>
            <div>
              <div className="text-lg font-black leading-tight">Advanced options</div>
              <div className="text-[13px] text-ink/60">Reuse, privacy, scene style and render quality. The defaults work well, so you can skip this.</div>
            </div>
            <span className="ml-auto text-sm font-bold text-grape group-open:hidden">▾ Show</span>
          </summary>
          <div className="mt-5 space-y-6">
        {/* reuse & privacy */}
        <Section flat icon="♻️" title="Reuse & privacy" hint="Your library makes every next video faster and cheaper." tone="amber">
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
              <div className="mt-1.5 text-[10px] leading-snug text-ink/45">
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
        <Section flat icon="🎬" title="Scene style & quality">
          <div className="text-xs font-bold">Scene style</div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Chip active={(settings.craft ?? 'directed') === 'directed'} onClick={() => patch({ craft: 'directed' })}>
              🎥 Directed (premium)
            </Chip>
            <Chip active={settings.craft === 'classic'} onClick={() => patch({ craft: 'classic' })}>
              🧩 Classic templates
            </Chip>
          </div>
          <div className="mt-1 text-[11px] text-ink/60">
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
          <label className="mt-4 flex cursor-pointer items-center gap-3 text-xs text-ink/80">
            <input type="checkbox" checked={settings.allowGpu} onChange={(e) => patch({ allowGpu: e.target.checked })} className="h-4 w-4 accent-grape" />
            <span>
              ⚡ GPU fast mode <span className="text-ink/60">(faster, but re-renders may differ by a few pixels)</span>
            </span>
          </label>
        </Section>
          </div>
        </details>
      </div>
    </div>
  )
}
