import { useState } from 'react'
import { api } from './api'
import Studio from './views/Studio'
import Library from './views/Library'
import Settings from './views/Settings'
import Editor from './views/Editor'
import Assets from './views/Assets'
import Footage from './views/Footage'
import Updater from './components/Updater'

type Tab = 'studio' | 'footage' | 'library' | 'assets' | 'editor' | 'settings'

/** Editor isn't a top-level tab any more — it opens from a video ("Change a scene") and lights up My videos. */
const TABS: Array<{ id: Tab; label: string; icon: string; tip: string; on: string }> = [
  { id: 'studio', label: 'Create', icon: '✨', tip: 'Describe a video and watch it get made', on: 'bg-grape text-white shadow-[0_3px_0_#5b21b6]' },
  { id: 'footage', label: 'Edit footage', icon: '🎬', tip: 'Cut, join and add music to videos you already have', on: 'bg-mint text-white shadow-[0_3px_0_#0b8a64]' },
  { id: 'library', label: 'My videos', icon: '🎞️', tip: 'Everything you have made', on: 'bg-berry text-white shadow-[0_3px_0_#c2185b]' },
  { id: 'assets', label: 'Library', icon: '🧺', tip: 'Pictures, clips, voices and music your videos reuse', on: 'bg-sky text-white shadow-[0_3px_0_#0b7cc0]' },
  { id: 'settings', label: 'Settings', icon: '⚙️', tip: 'Your AI keys, models and costs', on: 'bg-sunny text-ink shadow-[0_3px_0_#d49a00]' }
]

export default function App() {
  const [tab, setTab] = useState<Tab>('studio')
  const [editorProjectId, setEditorProjectId] = useState<string | null>(null)

  const openEditor = (id?: string) => {
    setEditorProjectId(id ?? null)
    setTab('editor')
  }

  const activeTab = tab === 'editor' ? 'library' : tab

  return (
    <div className="flex h-full flex-col">
      {/* title bar */}
      <div className="titlebar-drag flex h-14 shrink-0 items-center justify-between border-b-2 border-ink/5 bg-white pl-4">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-grape via-berry to-sunny text-base shadow-sm">🎬</span>
          <span className="text-[15px] font-black tracking-tight">
            VideoGen <span className="text-berry">Studio</span>
          </span>
        </div>
        <div className="titlebar-nothing flex h-full items-stretch">
          <div className="flex items-center gap-1.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={t.tip}
                className={`rounded-xl px-3.5 py-1.5 text-sm font-bold transition-all active:scale-95 ${
                  activeTab === t.id ? t.on : 'text-ink/60 hover:bg-ink/5 hover:text-ink'
                }`}
              >
                <span className="mr-1.5">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
          {/* window controls — Windows style, full-height hit targets */}
          <div className="ml-4 flex items-stretch">
            <button
              onClick={() => api.windowControls.minimize()}
              title="Minimize"
              className="flex w-11 items-center justify-center text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink"
            >
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button
              onClick={() => api.windowControls.toggleMaximize()}
              title="Maximize / Restore"
              className="flex w-11 items-center justify-center text-ink/50 transition-colors hover:bg-ink/5 hover:text-ink"
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button
              onClick={() => api.windowControls.close()}
              title="Close"
              className="flex w-11 items-center justify-center text-ink/50 transition-colors hover:bg-[#e81123] hover:text-white"
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <Updater mode="banner" />

      {/* content */}
      <div className="min-h-0 flex-1">
        {tab === 'studio' && <Studio onOpenEditor={() => openEditor()} onOpenSettings={() => setTab('settings')} />}
        {tab === 'footage' && <Footage onOpenSettings={() => setTab('settings')} />}
        {tab === 'library' && <Library onOpenEditor={openEditor} />}
        {tab === 'editor' && (
          <Editor
            key={editorProjectId ?? 'default'}
            initialProjectId={editorProjectId}
            onBack={() => setTab('library')}
          />
        )}
        {tab === 'assets' && <Assets />}
        {tab === 'settings' && <Settings />}
      </div>
    </div>
  )
}
