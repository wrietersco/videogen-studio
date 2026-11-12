import { useState } from 'react'
import { MAX_REFS, MAX_STYLE_REFS, ROLE_LABEL, referenceSummary } from '@shared/references'
import { mentionOf } from '@shared/directives'
import { api, type InspectedRefView, type RefRole } from '../api'

/**
 * Pictures attached to one video. Each gets a role the person confirms:
 * a look to copy, a product to show, or a screenshot to show. The card at
 * the bottom says exactly what the app will do with them.
 */

export interface RefChip extends InspectedRefView {
  role: RefRole
  note: string
}

const ROLES: RefRole[] = ['style', 'subject', 'content']

export function chipsFrom(items: InspectedRefView[]): RefChip[] {
  return items.map((i) => ({ ...i, role: i.suggestedRole, note: '' }))
}

export function ReferencePicker({ refs, onChange, programmatic, onMention }: { refs: RefChip[]; onChange: (next: RefChip[]) => void; programmatic: boolean; onMention?: (mention: string) => void }) {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problems, setProblems] = useState<string[]>([])

  const add = async (paths?: string[]) => {
    if (busy) return
    setBusy(true)
    try {
      const results = await api.references.inspect(paths)
      const good = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok).map((r) => r.item)
      const room = Math.max(0, MAX_REFS - refs.length)
      const fresh = chipsFrom(good.filter((g) => !refs.some((r) => r.path === g.path))).slice(0, room)
      const msgs = results.filter((r) => !r.ok).map((r) => `${(r as { name: string }).name}: ${(r as { error: string }).error}`)
      if (good.length > room) msgs.push(`A video can use up to ${MAX_REFS} pictures; the rest were not added.`)
      setProblems(msgs)
      if (fresh.length) onChange([...refs, ...fresh])
    } catch {
      setProblems(['The pictures could not be opened. Try again.'])
    } finally {
      setBusy(false)
    }
  }

  const styleCount = refs.filter((r) => r.role === 'style').length
  const patch = (path: string, p: Partial<RefChip>) => onChange(refs.map((r) => (r.path === path ? { ...r, ...p } : r)))
  const lines = referenceSummary(refs, { programmatic })

  return (
    <section className="card mt-4 p-5">
      <div className="flex items-center justify-between">
        <div className="text-base font-black">🖼️ Pictures for this video</div>
        <button onClick={() => add()} disabled={busy || refs.length >= MAX_REFS} className="btn-ghost text-xs">
          {busy ? 'Reading…' : '＋ Add pictures'}
        </button>
      </div>
      <p className="mt-1 text-xs text-ink/55">Show a look you like, your product, or a screenshot of your app. Optional.</p>

      {refs.length === 0 ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const paths = [...e.dataTransfer.files].map((f) => api.assets.pathForFile(f)).filter(Boolean)
            if (paths.length) void add(paths)
          }}
          className={`mt-3 rounded-2xl border-2 border-dashed px-6 py-5 text-center text-sm transition-colors ${over ? 'border-grape bg-grape-soft text-ink' : 'border-ink/15 text-ink/55'}`}
        >
          Drop pictures here
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {refs.map((r) => (
            <div key={r.path} className="flex gap-3 rounded-xl bg-ink/[0.04] p-3">
              <img src={r.thumb} alt="" className="h-20 w-20 shrink-0 rounded-lg border-2 border-ink/10 bg-white object-contain" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <div className="truncate text-sm font-bold" title={r.path}>
                    {r.name}
                  </div>
                  <div className="flex shrink-0 gap-3">
                    {onMention && (
                      <button onClick={() => onMention(mentionOf(r.name))} className="text-xs font-bold text-grape hover:underline" title="Write this picture's name into your idea, so you can say things like “like @name”">
                        @ mention
                      </button>
                    )}
                    <button onClick={() => onChange(refs.filter((x) => x.path !== r.path))} className="text-xs font-bold text-ink/40 hover:text-berry" aria-label={`Remove ${r.name}`}>
                      Remove
                    </button>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {ROLES.map((role) => {
                    const blocked = role === 'style' && r.role !== 'style' && styleCount >= MAX_STYLE_REFS
                    return (
                      <button
                        key={role}
                        disabled={blocked}
                        title={blocked ? `Up to ${MAX_STYLE_REFS} pictures can set the look` : ROLE_LABEL[role].does}
                        onClick={() => patch(r.path, { role })}
                        className={`rounded-full border-2 px-2.5 py-0.5 text-xs font-bold transition-all ${r.role === role ? 'border-grape bg-grape text-white' : 'border-ink/10 bg-white text-ink/65 hover:border-grape/50'} disabled:cursor-not-allowed disabled:opacity-40`}
                      >
                        {ROLE_LABEL[role].short}
                      </button>
                    )
                  })}
                </div>
                {r.role !== 'style' && (
                  <input
                    value={r.note}
                    maxLength={80}
                    onChange={(e) => patch(r.path, { note: e.target.value })}
                    placeholder={r.role === 'subject' ? 'What is it? e.g. our smart bottle' : 'What does it show? e.g. the trail map screen'}
                    className="mt-2 w-full rounded-lg border-2 border-ink/10 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-grape"
                  />
                )}
              </div>
            </div>
          ))}
          {refs.length < MAX_REFS && (
            <button onClick={() => add()} className="text-xs font-bold text-grape hover:underline">
              ＋ Add more
            </button>
          )}
        </div>
      )}

      {problems.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs font-bold text-berry">
          {problems.map((p) => (
            <li key={p}>• {p}</li>
          ))}
        </ul>
      )}

      {lines.length > 0 && (
        <div className="mt-3 rounded-xl bg-ink/[0.04] p-3 text-sm">
          <div className="font-black">This video will</div>
          <ul className="mt-0.5 text-ink/70">
            {lines.map((l) => (
              <li key={l}>• {l}</li>
            ))}
          </ul>
          {!programmatic && refs.some((r) => r.role === 'style' || !r.note.trim()) && <p className="mt-1.5 text-xs text-ink/50">Style pictures, and any picture without a note, are sent to the AI for one read, counted in this video's cost. Pictures with a note stay on this computer.</p>}
        </div>
      )}
    </section>
  )
}
