import { useEffect, useState } from 'react'
import { api } from './api'
import Studio from './views/Studio'
import Library from './views/Library'
import Settings from './views/Settings'
import Editor from './views/Editor'
import Assets from './views/Assets'
import Footage from './views/Footage'
import RecordApp from './views/RecordApp'
import MarketBusiness from './views/MarketBusiness'
import Updater from './components/Updater'
import { PlanBadge, useAccount } from './components/Account'
import { AccountGate } from './components/Welcome'

type Tab = 'studio' | 'footage' | 'apps' | 'market' | 'library' | 'assets' | 'editor' | 'settings'

/** Editor isn't a top-level tab any more — it opens from a video ("Change a scene") and lights up My videos. */
const TABS: Array<{ id: Tab; label: string; icon: string; tip: string; on: string }> = [
  { id: 'studio', label: 'Create', icon: '✨', tip: 'Describe a video and watch it get made', on: 'bg-grape text-white shadow-[0_3px_0_#5b21b6]' },
  { id: 'footage', label: 'Edit footage', icon: '🎬', tip: 'Cut, join and add music to videos you already have', on: 'bg-mint text-white shadow-[0_3px_0_#0b8a64]' },
  { id: 'apps', label: 'Record an app', icon: '🖥️', tip: 'Give us a web app and we record a polished video of it, with private details hidden', on: 'bg-coral text-white shadow-[0_3px_0_#c23f3f]' },
  { id: 'market', label: 'Market my business', icon: '📣', tip: 'Give us your website and we write and make problem–solution videos for it', on: 'bg-fuchsia-700 text-white shadow-[0_3px_0_#86198f]' },
  { id: 'library', label: 'My videos', icon: '🎞️', tip: 'Everything you have made', on: 'bg-berry text-white shadow-[0_3px_0_#c2185b]' },
  { id: 'assets', label: 'Library', icon: '🧺', tip: 'Pictures, clips, voices and music your videos reuse', on: 'bg-sky text-white shadow-[0_3px_0_#0b7cc0]' },
  { id: 'settings', label: 'Settings', icon: '⚙️', tip: 'Your AI keys, models and costs', on: 'bg-sunny text-ink shadow-[0_3px_0_#d49a00]' }
]

export default function App() {
  const [tab, setTab] = useState<Tab>('studio')
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('vg.navCollapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleNav = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem('vg.navCollapsed', c ? '0' : '1')
      } catch {
        /* not remembered */
      }
      return !c
    })
  const [editorProjectId, setEditorProjectId] = useState<string | null>(null)
  const [account, setAccount] = useAccount()
  const [skipped, setSkipped] = useState(() => {
    try {
      return localStorage.getItem('vg.skipSignIn') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    const show = () => setSkipped(false)
    window.addEventListener('videogen:sign-in', show)
    return () => window.removeEventListener('videogen:sign-in', show)
  }, [])
  const skip = () => {
    setSkipped(true)
    try {
      localStorage.setItem('vg.skipSignIn', '1')
    } catch {
      /* the choice just isn't remembered */
    }
  }
  const gate = account && !account.signedIn && !skipped

  const openEditor = (id?: string) => {
    setEditorProjectId(id ?? null)
    setTab('editor')
  }

  const activeTab = tab === 'editor' ? 'library' : tab

  return (
    <div className="flex h-full">
      {/* left menu */}
      <aside className={`flex ${collapsed ? 'w-[68px]' : 'w-56'} shrink-0 flex-col border-r-2 border-ink/5 bg-white transition-[width]`}>
        <div className={`titlebar-drag flex h-14 shrink-0 items-center gap-2 ${collapsed ? 'justify-center px-2' : 'px-4'}`}>
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-grape via-berry to-sunny text-base shadow-sm">🎬</span>
          {!collapsed && (
            <span className="text-[15px] font-black leading-tight tracking-tight">
              VideoGen <span className="text-berry">Studio</span>
            </span>
          )}
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-3">
          {TABS.filter((t) => t.id !== 'settings').map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.tip}
              className={`flex items-center ${collapsed ? 'justify-center px-0' : 'px-3.5'} rounded-xl py-2.5 text-left text-sm font-bold transition-all active:scale-95 ${
                activeTab === t.id ? t.on : 'text-ink/60 hover:bg-ink/5 hover:text-ink'
              }`}
            >
              <span className={`w-5 text-center ${collapsed ? '' : 'mr-2.5'}`}>{t.icon}</span>
              {!collapsed && t.label}
            </button>
          ))}
          <div className="mt-auto flex flex-col gap-2 pt-3">
            {collapsed ? (
              <button
                onClick={() => (account?.signedIn ? setTab('settings') : setSkipped(false))}
                title={account?.signedIn ? 'Your plan' : 'Sign in'}
                className="flex items-center justify-center rounded-xl bg-gradient-to-r from-grape to-berry py-2.5 text-base text-white"
              >
                👑
              </button>
            ) : (
              <PlanBadge status={account} onClick={() => (account?.signedIn ? setTab('settings') : setSkipped(false))} />
            )}
            {TABS.filter((t) => t.id === 'settings').map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                title={t.tip}
                className={`flex items-center ${collapsed ? 'justify-center px-0' : 'px-3.5'} rounded-xl py-2.5 text-left text-sm font-bold transition-all active:scale-95 ${
                  activeTab === t.id ? t.on : 'text-ink/60 hover:bg-ink/5 hover:text-ink'
                }`}
              >
                <span className={`w-5 text-center ${collapsed ? '' : 'mr-2.5'}`}>{t.icon}</span>
                {!collapsed && t.label}
              </button>
            ))}
            <button
              onClick={toggleNav}
              title={collapsed ? 'Expand menu' : 'Collapse menu'}
              className="flex items-center justify-center rounded-xl py-2 text-sm font-bold text-ink/40 transition-colors hover:bg-ink/5 hover:text-ink"
            >
              {collapsed ? '»' : '« Collapse'}
            </button>
          </div>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
      {/* window bar: drag area + controls */}
      <div className="titlebar-drag flex h-9 shrink-0 items-stretch justify-end">
        <div className="titlebar-nothing flex items-stretch">
          {/* window controls — Windows style, full-height hit targets */}
          <div className="flex items-stretch">
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
        {gate && <AccountGate status={account} onDone={(s) => (setAccount(s), setTab('studio'))} onSkip={skip} />}
        {!gate && tab === 'studio' && <Studio onOpenEditor={() => openEditor()} onOpenSettings={() => setTab('settings')} />}
        {!gate && tab === 'footage' && <Footage onOpenSettings={() => setTab('settings')} />}
        {!gate && tab === 'apps' && <RecordApp onOpenSettings={() => setTab('settings')} />}
        {!gate && tab === 'market' && <MarketBusiness onOpenSettings={() => setTab('settings')} />}
        {!gate && tab === 'library' && <Library onOpenEditor={openEditor} />}
        {!gate && tab === 'editor' && (
          <Editor
            key={editorProjectId ?? 'default'}
            initialProjectId={editorProjectId}
            onBack={() => setTab('library')}
          />
        )}
        {!gate && tab === 'assets' && <Assets />}
        {!gate && tab === 'settings' && <Settings />}
      </div>
      </div>
    </div>
  )
}
