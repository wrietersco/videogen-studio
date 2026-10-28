import type { ReactNode } from 'react'
import { SOURCE_BADGE, type AssetSource } from '@shared/assets'

/** Small shared building blocks so every screen feels like the same friendly app. */

export function SourceBadge({ source, small }: { source: AssetSource; small?: boolean }) {
  const b = SOURCE_BADGE[source]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-bold ${small ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'}`}
      style={{ background: `${b.color}22`, color: b.color }}
      title={`Source: ${b.label}`}
    >
      <span>{b.icon}</span>
      {b.label}
    </span>
  )
}

export function Chip({ active, onClick, children, title }: { active?: boolean; onClick?: () => void; children: ReactNode; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-full border px-3 py-1 text-xs font-bold transition-all active:scale-95 ${
        active ? 'border-[#7C5CFF] bg-[#7C5CFF]/20 text-white' : 'border-white/10 text-white/55 hover:border-white/25 hover:text-white/85'
      }`}
    >
      {children}
    </button>
  )
}

export function Section({ icon, title, hint, children, tone = 'plain' }: { icon: string; title: string; hint?: ReactNode; children: ReactNode; tone?: 'plain' | 'violet' | 'cyan' | 'amber' }) {
  const tones = {
    plain: 'border-white/10 bg-white/[0.03]',
    violet: 'border-[#7C5CFF]/30 bg-[#7C5CFF]/[0.06]',
    cyan: 'border-[#00E5FF]/25 bg-[#00E5FF]/[0.05]',
    amber: 'border-amber-300/25 bg-amber-300/[0.04]'
  }
  return (
    <section className={`slide-up rounded-2xl border p-5 ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-sm font-black">
        <span className="text-lg">{icon}</span>
        {title}
      </div>
      {hint && <div className="mt-1 text-xs leading-relaxed text-white/50">{hint}</div>}
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function Meter({ value, max = 3, icon, label }: { value: number; max?: number; icon: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-white/45" title={`${label}: ${value}/${max}`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < value ? 'opacity-100' : 'opacity-20'}>
          {icon}
        </span>
      ))}
    </span>
  )
}

export function EmptyState({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="wiggle text-5xl">{emoji}</div>
      <div className="mt-3 text-base font-black text-white/80">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-white/45">{children}</div>}
    </div>
  )
}

export function Toast({ text, tone = 'ok', onClose }: { text: string; tone?: 'ok' | 'err'; onClose: () => void }) {
  return (
    <div
      className={`pop-in fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold shadow-2xl ${
        tone === 'ok' ? 'border-emerald-400/30 bg-[#0f2a22] text-emerald-100' : 'border-red-400/30 bg-[#2a1012] text-red-100'
      }`}
    >
      {text}
      <button onClick={onClose} className="text-white/40 hover:text-white">
        ✕
      </button>
    </div>
  )
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function fmtDur(s?: number): string {
  if (!s) return ''
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`
}
