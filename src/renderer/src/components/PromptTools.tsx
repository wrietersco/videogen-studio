import { useState } from 'react'
import { VIDEO_SHAPES, shapeOf, type ShapeId, type VideoShape } from '@shared/shapes'
import { assemblePrompt } from '@shared/promptTemplates'
import type { EnhancedPrompt, PlatformId, PromptTemplate } from '../api'

/** a tiny frame in the shape's real proportions, so people see the format before the numbers */
export function ShapeFrame({ shape, on, scale = 1 }: { shape: VideoShape; on: boolean; scale?: number }) {
  return (
    <div className="flex h-9 items-center justify-center" style={{ height: 34 * scale }}>
      <div
        className={`rounded-[5px] border-2 ${on ? 'border-grape bg-white' : 'border-ink/25 bg-paper'}`}
        style={{ width: shape.frame.w * scale, height: shape.frame.h * scale }}
      />
    </div>
  )
}

/**
 * Shape picker — big tiles by shape (with the apps each suits), plus app
 * chips for people who only know where they will post. Either one sets the
 * platform; the shape is derived from it.
 */
export function ShapePicker({
  platform,
  onPlatform,
  apps,
  agentOption
}: {
  platform: PlatformId
  onPlatform: (p: PlatformId, shape: ShapeId) => void
  apps: Array<{ id: PlatformId; label: string; emoji: string }>
  /** autopilot: an extra "let the agent pick" tile; on = the agent decides */
  agentOption?: { on: boolean; onPick: () => void }
}) {
  const current = agentOption?.on ? null : shapeOf(platform)
  return (
    <div>
      <div className={`grid gap-2 ${agentOption ? 'grid-cols-5' : 'grid-cols-4'}`}>
        {agentOption && (
          <button onClick={agentOption.onPick} className={`tile flex flex-col items-center px-2 py-3 text-center ${agentOption.on ? 'tile-on' : ''}`}>
            <div className="flex h-9 items-center text-2xl">🪄</div>
            <div className="mt-1.5 text-sm font-bold">Agent picks</div>
            <div className="text-[11px] leading-snug text-ink/50">Best shape for your idea</div>
          </button>
        )}
        {VIDEO_SHAPES.map((s) => {
          const on = current === s.id
          return (
            <button
              key={s.id}
              onClick={() => onPlatform(on ? platform : s.defaultPlatform, s.id)}
              className={`tile flex flex-col items-center px-2 py-3 text-center ${on ? 'tile-on' : ''}`}
              title={`${s.label} ${s.id} — ${s.apps.join(', ')}`}
            >
              <ShapeFrame shape={s} on={on} />
              <div className="mt-1.5 text-sm font-bold">
                {s.label} <span className="font-semibold text-ink/45">{s.id}</span>
              </div>
              <div className="text-[11px] leading-snug text-ink/55">{s.apps.slice(0, 3).join(' · ')}</div>
            </button>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-bold text-ink/50">Not sure? Pick the app:</span>
        {apps.map((a) => {
          const on = !agentOption?.on && platform === a.id
          return (
            <button
              key={a.id}
              onClick={() => onPlatform(a.id, shapeOf(a.id))}
              className={`rounded-full border-2 px-3 py-1 text-xs font-bold transition-all active:scale-95 ${on ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/70 hover:border-grape/50'}`}
            >
              {a.emoji} {a.label} <span className={on ? 'text-white/70' : 'text-ink/40'}>{shapeOf(a.id)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** saved prompt structures; clicking one makes the next enhance follow it */
export function TemplateBar({
  templates,
  active,
  onPick,
  onRemove
}: {
  templates: PromptTemplate[]
  active: PromptTemplate | null
  onPick: (t: PromptTemplate | null) => void
  onRemove: (t: PromptTemplate) => void
}) {
  if (!templates.length) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-bold text-ink/50">📋 Templates:</span>
      {templates.map((t) => {
        const on = active?.id === t.id
        return (
          <span key={t.id} className={`group inline-flex items-center rounded-full border-2 text-xs font-semibold transition-all ${on ? 'border-grape bg-grape-soft text-grape' : 'border-ink/10 bg-white text-ink/75 hover:border-grape/50'}`}>
            <button onClick={() => onPick(on ? null : t)} className="py-1 pl-3 pr-2" title={t.sections.map((s) => s.label).join(' · ')}>
              {t.emoji} {t.name}
            </button>
            {!t.builtin && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete the template “${t.name}”? Videos already made are not affected.`)) onRemove(t)
                }}
                className="mr-1.5 rounded-full px-1 text-ink/35 hover:bg-coral-soft hover:text-coral"
                title="Delete this template"
                aria-label={`Delete template ${t.name}`}
              >
                ✕
              </button>
            )}
          </span>
        )
      })}
    </div>
  )
}

/**
 * Review step for an enhanced prompt: every section is editable, and the
 * structure can be kept as a template for the next idea.
 */
export function EnhanceReview({
  result,
  formatLabel,
  busy,
  onUse,
  onRetry,
  onDismiss,
  onSaveTemplate
}: {
  result: EnhancedPrompt
  /** the current format picks, e.g. "TikTok · 30s · Bold & hype" (null = nothing to save) */
  formatLabel: string | null
  busy: boolean
  onUse: (prompt: string) => void
  onRetry: () => void
  onDismiss: () => void
  onSaveTemplate: (name: string, sections: Array<{ label: string; hint: string }>, withFormat: boolean) => Promise<string | null>
}) {
  const [sections, setSections] = useState(result.sections)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [withFormat, setWithFormat] = useState(true)
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const edit = (i: number, content: string) => setSections((all) => all.map((s, j) => (j === i ? { ...s, content } : s)))
  const text = assemblePrompt(sections)

  const save = async () => {
    const err = await onSaveTemplate(name.trim(), sections.map(({ label, hint }) => ({ label, hint })), withFormat && !!formatLabel)
    setSaveMsg(err ? { ok: false, text: err } : { ok: true, text: `Saved “${name.trim()}”. Find it under 📋 Templates.` })
    if (!err) setSaving(false)
  }

  return (
    <div className="slide-up mt-4 rounded-2xl border-2 border-grape/30 bg-grape-soft/50 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-base font-black">✨ Your improved prompt</div>
        <div className="text-xs text-ink/55">Check it and change anything — then use it.</div>
      </div>
      {result.note && <div className="mt-2 rounded-xl bg-sunny-soft px-3 py-2 text-xs font-semibold text-ink/70">💡 {result.note}</div>}
      <div className="mt-3 space-y-2">
        {sections.map((s, i) => (
          <label key={s.label} className="block rounded-xl bg-white p-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-black uppercase tracking-wide text-grape">{s.label}</span>
              <span className="truncate text-[11px] text-ink/40">{s.hint}</span>
            </div>
            <textarea
              value={s.content}
              onChange={(e) => edit(i, e.target.value)}
              placeholder={s.content ? undefined : `Optional — ${s.hint.toLowerCase()}`}
              rows={Math.min(8, Math.max(1, s.content.split('\n').length + Math.floor(s.content.length / 110)))}
              className="mt-1 w-full resize-y bg-transparent text-sm leading-relaxed text-ink/85 outline-none placeholder:text-ink/30"
            />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button onClick={() => onUse(text)} disabled={!text.trim()} className="btn-primary !px-5 !py-2 !text-sm">
          ✅ Use this prompt
        </button>
        <button onClick={onRetry} disabled={busy} className="btn-ghost !py-2 !text-sm">
          {busy ? '⏳ Rewriting…' : '🔁 Try again'}
        </button>
        <button onClick={onDismiss} className="btn-ghost !py-2 !text-sm">
          Keep what I wrote
        </button>
        <button onClick={() => { setSaving((v) => !v); setSaveMsg(null) }} className="ml-auto text-xs font-bold text-grape hover:underline">
          💾 Save this structure as a template
        </button>
      </div>
      {saving && (
        <div className="slide-up mt-3 rounded-xl bg-white p-3">
          <div className="text-sm font-bold">Save the sections (not this idea) to reuse with your next video</div>
          <div className="mt-1 text-[11px] text-ink/50">{sections.map((s) => s.label).join(' · ')}</div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) save() }}
              maxLength={60}
              placeholder="Template name, e.g. Weekly product tip"
              className="field min-w-[240px] flex-1 px-3 py-2 text-sm"
              autoFocus
            />
            <button onClick={save} disabled={!name.trim()} className="btn-primary !px-4 !py-2 !text-sm">
              Save template
            </button>
          </div>
          {formatLabel && (
            <label className="mt-2 flex items-center gap-2 text-xs text-ink/65">
              <input type="checkbox" checked={withFormat} onChange={(e) => setWithFormat(e.target.checked)} className="accent-[#7c3aed]" />
              Also remember the format: {formatLabel}
            </label>
          )}
        </div>
      )}
      {saveMsg && <div className={`mt-2 text-xs font-semibold ${saveMsg.ok ? 'text-mint' : 'text-coral'}`}>{saveMsg.ok ? '✅' : '⚠️'} {saveMsg.text}</div>}
    </div>
  )
}
