import { useState } from 'react'
import { api } from './api'
import Studio from './views/Studio'
import Library from './views/Library'
import Settings from './views/Settings'
import Editor from './views/Editor'
import Assets from './views/Assets'

type Tab = 'studio' | 'library' | 'assets' | 'editor' | 'settings'

const TABS: Array<{ id: Tab; label: string; icon: string; tip: string }> = [
  { id: 'studio', label: 'Create', icon: '✨', tip: 'Describe a video and watch it get made' },
  { id: 'library', label: 'My videos', icon: '🎞️', tip: 'Everything you have made' },
  { id: 'assets', label: 'Assets', icon: '🧺', tip: 'Pictures, clips, voices and music the app reuses' },
  { id: 'editor', label: 'Editor', icon: '✏️', tip: 'Rework scenes and see what a video cost' },
  { id: 'settings', label: 'Settings', icon: '⚙️', tip: 'Engines, keys, media models, privacy' }
]

export default function App() {
  const [tab, setTab] = useState<Tab>('studio')
  const [editorProjectId, setEditorProjectId] = useState<string | null>(null)

  const openEditor = (id?: string) => {
    setEditorProjectId(id ?? null)
    setTab('editor')
  }

  return (
    <div className="flex h-full flex-col">
      {/* title bar */}
      <div className="titlebar-drag flex h-10 shrink-0 items-center justify-between border-b border-white/5 bg-[#0e0e18] pl-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-black tracking-widest text-[#7C5CFF]">VIDEOGEN</span>
          <span className="text-xs font-medium tracking-wider text-white/40">STUDIO</span>
        </div>
        <div className="titlebar-nothing flex h-full items-stretch">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.tip}
              className={`my-1 self-center rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                tab === t.id ? 'bg-[#7C5CFF]/20 text-[#b9a5ff]' : 'text-white/50 hover:bg-white/5 hover:text-white/80'
              }`}
            >
              <span className="mr-1.5">{t.icon}</span>
              {t.label}
            </button>
          ))}
          {/* window controls — Windows style, full-height hit targets */}
          <div className="ml-3 flex items-stretch">
            <button
              onClick={() => api.windowControls.minimize()}
              title="Minimize"
              className="flex w-11 items-center justify-center text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
            </button>
            <button
              onClick={() => api.windowControls.toggleMaximize()}
              title="Maximize / Restore"
              className="flex w-11 items-center justify-center text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
            <button
              onClick={() => api.windowControls.close()}
              title="Close"
              className="flex w-11 items-center justify-center text-white/60 transition-colors hover:bg-[#e81123] hover:text-white"
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* content */}
      <div className="min-h-0 flex-1">
        {tab === 'studio' && <Studio onOpenEditor={() => openEditor()} />}
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
