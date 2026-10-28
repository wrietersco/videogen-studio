import type { ReactNode } from 'react'
import { SOURCE_BADGE, type AssetSource } from '@shared/assets'

/** Small shared building blocks so every screen feels like the same friendly app. */

export function SourceBadge({ source, small }: { source: AssetSource; small?: boolean }) {
  const b = SOURCE_BADGE[source]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-white/95 font-bold text-ink/80 shadow-sm ${small ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]'}`}
      style={{ boxShadow: `inset 0 0 0 1.5px ${b.color}` }}
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
      className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition-all active:scale-95 ${
        active ? 'border-grape bg-grape text-white shadow-[0_2px_0_#5b21b6]' : 'border-ink/10 bg-white text-ink/65 hover:border-grape/50 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

/** a titled white card; `flat` drops the card chrome for sections nested inside another card */
export function Section({ icon, title, hint, children, tone = 'plain', flat }: { icon: string; title: string; hint?: ReactNode; children: ReactNode; tone?: 'plain' | 'violet' | 'cyan' | 'amber'; flat?: boolean }) {
  const tones = {
    plain: 'bg-ink/5',
    violet: 'bg-grape-soft',
    cyan: 'bg-sky-soft',
    amber: 'bg-sunny-soft'
  }
  return (
    <section className={flat ? 'border-t-2 border-ink/5 pt-5' : 'card slide-up p-6'}>
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl text-xl ${tones[tone]}`}>{icon}</span>
        <div className="min-w-0">
          <div className="text-lg font-black leading-tight">{title}</div>
          {hint && <div className="mt-0.5 text-[13px] leading-snug text-ink/60">{hint}</div>}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

/** labelled bar meter, e.g. "⚡ Speed ▰▰▱" — big enough to read at a glance */
export function Meter({ value, max = 3, icon, label, color = 'bg-grape' }: { value: number; max?: number; icon: string; label: string; color?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-ink/75" title={`${label}: ${value} out of ${max}`}>
      <span className="w-4 text-center text-sm leading-none">{icon}</span>
      <span className="w-12">{label}</span>
      <span className="flex gap-0.5">
        {Array.from({ length: max }, (_, i) => (
          <span key={i} className={`h-2.5 w-4 rounded-full ${i < value ? color : 'bg-ink/10'}`} />
        ))}
      </span>
    </span>
  )
}

export function EmptyState({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="wiggle text-5xl">{emoji}</div>
      <div className="mt-3 text-lg font-black">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-ink/60">{children}</div>}
    </div>
  )
}

export function Toast({ text, tone = 'ok', onClose }: { text: string; tone?: 'ok' | 'err'; onClose: () => void }) {
  return (
    <div
      className={`pop-in fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-2xl border-2 px-4 py-3 text-sm font-semibold shadow-2xl ${
        tone === 'ok' ? 'border-mint/40 bg-mint-soft text-ink' : 'border-coral/40 bg-coral-soft text-ink'
      }`}
    >
      {text}
      <button onClick={onClose} className="text-ink/60 hover:text-ink">
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
