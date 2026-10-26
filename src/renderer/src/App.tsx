import { useState } from 'react'
import Studio from './views/Studio'
import Library from './views/Library'
import Settings from './views/Settings'
import Editor from './views/Editor'

type Tab = 'studio' | 'library' | 'editor' | 'settings'

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'studio', label: 'Studio', icon: '✦' },
  { id: 'library', label: 'Library', icon: '▦' },
  { id: 'editor', label: 'Editor', icon: '✎' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
]

export default function App() {
  const [tab, setTab] = useState<Tab>('studio')

  return (
    <div className="flex h-full flex-col">
      {/* title bar */}
      <div className="titlebar-drag flex h-10 shrink-0 items-center justify-between border-b border-white/5 bg-[#0e0e18] px-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-black tracking-widest text-[#7C5CFF]">VIDEOGEN</span>
          <span className="text-xs font-medium tracking-wider text-white/40">STUDIO</span>
        </div>
        <div className="titlebar-nothing flex items-center gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
                tab === t.id ? 'bg-[#7C5CFF]/20 text-[#b9a5ff]' : 'text-white/50 hover:bg-white/5 hover:text-white/80'
              }`}
            >
              <span className="mr-1.5 opacity-70">{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* content */}
      <div className="min-h-0 flex-1">
        {tab === 'studio' && <Studio onOpenEditor={() => setTab('editor')} />}
        {tab === 'library' && <Library onOpenEditor={() => setTab('editor')} />}
        {tab === 'editor' && <Editor />}
        {tab === 'settings' && <Settings />}
      </div>
    </div>
  )
}
