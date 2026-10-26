import { useEffect, useState } from 'react'
import { api, type ProviderId, type ProviderStatus, type SettingsView } from '../api'

type ModelList = Array<{ id: string; label: string }>
type ModelLists = Partial<Record<ProviderId, ModelList>>

export default function Settings() {
  const [providers, setProviders] = useState<ProviderStatus[]>([])
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Partial<Record<ProviderId, string>>>({})
  const [modelLists, setModelLists] = useState<ModelLists>({})

  const refresh = async () => {
    setProviders(await api.listProviders())
    setSettings(await api.getSettings())
  }
  useEffect(() => {
    refresh()
  }, [])

  const selectProvider = async (id: ProviderId) => {
    await api.setSettings({ provider: id })
    await refresh()
  }

  const openModelList = async (id: ProviderId) => {
    if (modelLists[id]) return
    try {
      const models = await api.listModels(id)
      setModelLists((m) => ({ ...m, [id]: models }))
    } catch {
      setModelLists((m) => ({ ...m, [id]: [] }))
    }
  }

  const setModel = async (id: ProviderId, model: string) => {
    await api.setSettings({ models: { [id]: model } })
    await refresh()
  }

  const saveKey = async (id: ProviderId) => {
    const key = keyDrafts[id]
    if (!key?.trim()) return
    await api.setKey(id, key)
    setKeyDrafts((k) => ({ ...k, [id]: '' }))
    await refresh()
  }

  return (
    <div className="h-full overflow-y-auto p-8">
      <h1 className="text-2xl font-black tracking-tight">Settings</h1>
      <p className="mb-8 text-sm text-white/45">
        Keys are encrypted with your OS credential store and never leave this machine.
      </p>

      {/* active engine */}
      <div className="mb-8 max-w-3xl rounded-2xl border border-[#00E5FF]/25 bg-[#00E5FF]/[0.05] p-5">
        <div className="text-sm font-bold text-[#7fdff5]">Active engine</div>
        <p className="mt-1 text-xs leading-relaxed text-white/50">
          The <b>Mock</b> engine plans videos with built-in heuristics — the whole app works without any API keys, ideal
          for trying the pipeline. Switch to OpenAI / Claude / Gemini for full creative generation.
        </p>
      </div>

      {/* provider cards */}
      <div className="grid max-w-4xl grid-cols-2 gap-4">
        {providers.map((p) => (
          <div
            key={p.id}
            className={`rounded-2xl border p-5 transition-all ${
              settings?.provider === p.id ? 'border-[#7C5CFF]/60 bg-[#7C5CFF]/[0.07]' : 'border-white/10 bg-white/[0.03]'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-black">{p.label}</div>
              <div className="flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${p.configured ? 'bg-emerald-400' : 'bg-white/25'}`} />
                <span className="text-[11px] text-white/40">{p.configured ? 'ready' : 'no key'}</span>
              </div>
            </div>

            {p.id !== 'mock' && (
              <>
                <div className="mt-3 flex gap-2">
                  <input
                    type="password"
                    value={keyDrafts[p.id] ?? ''}
                    onChange={(e) => setKeyDrafts((k) => ({ ...k, [p.id]: e.target.value }))}
                    placeholder="paste API key…"
                    className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/30 px-3 py-1.5 text-xs outline-none focus:border-[#7C5CFF]/60"
                  />
                  <button
                    onClick={() => saveKey(p.id)}
                    className="rounded-lg bg-[#7C5CFF]/80 px-3 py-1.5 text-xs font-bold hover:bg-[#7C5CFF]"
                  >
                    Save
                  </button>
                </div>
                <button onClick={() => openModelList(p.id)} className="mt-3 text-[11px] text-[#00E5FF]/80 hover:underline">
                  {modelLists[p.id] ? `models (${modelLists[p.id]!.length})` : 'show available models'}
                </button>
                {modelLists[p.id] && (
                  <select
                    value={settings?.models[p.id] ?? ''}
                    onChange={(e) => setModel(p.id, e.target.value)}
                    className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs"
                  >
                    <option value="">default (latest flagship)</option>
                    {modelLists[p.id]!.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}

            <button
              onClick={() => selectProvider(p.id)}
              disabled={settings?.provider === p.id || (p.id !== 'mock' && !p.configured)}
              className="mt-4 w-full rounded-lg border border-white/15 py-1.5 text-xs font-bold transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {settings?.provider === p.id ? '✓ Active' : 'Use this engine'}
            </button>
          </div>
        ))}
      </div>

      {/* render quality */}
      {settings && (
        <div className="mt-8 max-w-4xl rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="text-sm font-bold">Render quality</div>
          <div className="mt-3 flex gap-2">
            {(['draft', 'standard', 'delivery'] as const).map((q) => (
              <button
                key={q}
                onClick={async () => {
                  await api.setSettings({ quality: q })
                  refresh()
                }}
                className={`rounded-lg border px-4 py-2 text-xs font-bold capitalize ${
                  settings.quality === q ? 'border-[#00E5FF] bg-[#00E5FF]/10' : 'border-white/10 hover:bg-white/5'
                }`}
              >
                {q}
              </button>
            ))}
          </div>
          <label className="mt-5 flex cursor-pointer items-center gap-3 text-xs text-white/70">
            <input
              type="checkbox"
              checked={settings.allowGpu}
              onChange={async (e) => {
                await api.setSettings({ allowGpu: e.target.checked })
                refresh()
              }}
              className="h-4 w-4 accent-[#7C5CFF]"
            />
            <span>
              GPU fast mode <span className="text-white/40">(faster, but re-renders may differ by a few pixels — software rendering stays the deterministic default)</span>
            </span>
          </label>
        </div>
      )}
    </div>
  )
}
