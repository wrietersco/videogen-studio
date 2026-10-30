import { z } from 'zod'
import { FilmDesign, Plate, SceneCraft, Widget, type VideoSpec } from '@shared/spec'
import { PLATFORM_PRESETS } from '@shared/presets'
import { tokenize } from '@shared/assets'
import type { LLMProvider } from '../providers/types'

/**
 * Scene director — the agents that turn a planned film into directed scenes.
 *
 *   film director   1 call  → design system (look, series label, art direction, accents)
 *   scene directors N calls → one SceneCraft per scene, in parallel: the visual
 *                              metaphor, which widget carries it, plate brief, HUD, caption
 *
 * Each call is a small, schema-constrained form fill — the kind of task even
 * the cheapest models do reliably. Every answer is validated, repaired
 * (over-long strings are trimmed, not rejected) and guarded deterministically.
 * The mock provider gets hand-tuned heuristics so offline runs stay directed.
 */

/** what the scene director fills in (the engine owns ids, plate files and reviews) */
export const SceneCraftDraft = SceneCraft.omit({ sceneId: true, review: true }).extend({
  plate: Plate.omit({ file: true, depthFile: true, anchor: true, clipFile: true }).optional()
})
export type SceneCraftDraft = z.infer<typeof SceneCraftDraft>

const toSchema = (s: z.ZodType) => z.toJSONSchema(s, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
let filmSchema: Record<string, unknown> | null = null
let sceneSchema: Record<string, unknown> | null = null

const WIDGET_GUIDE = `Widget catalog (pick the ONE that makes this beat's idea visible; 0–2 per scene):
- ringGauge {label, value 0-100, after?, afterLabel?}: a level filling a ring; "after" shows it dropping/rising (before→after).
- counter {label, from, to, unit, prefix}: one big number counting up (years, km, people, dollars).
- bars {label, unit, items[2-5] {label, value}}: compare quantities.
- toggle {from, to, label}: a switch flipping between two states (sugar→fat, off→on, tired→alert).
- timeline {items[2-5] {label, text}}: ordered steps or moments (labels like "0:00", "1883", "STEP 1").
- quoteCard {text, attribution}: a real quotation on a paper card.
- statPair {a {label, value}, b {label, value}}: two contrasting figures side by side.
- slots {label, total 3-8, filled, blocked, fillLabel, blockLabel}: things docking into receptors/seats, some blocked or replaced (mechanisms, capacity, competition).
- distanceBar {label, max, unit}: a bar racing to a distance/size with a counter.
- waveform {label}: a signal line with a spike (sound, heartbeat, seismic, traffic burst).
- annotation {label}: ONLY on plate scenes — a ring + leader + label pinned to the subject in the picture.`

const FILM_SYSTEM = `You are the film director of a premium short-form video studio (motion design for TikTok, Reels, Shorts, YouTube).
Given a planned film, choose ONE design system for the whole video.
- look "infographic" or "documentary" sets the graphic treatment, not the media type. Both can and should combine relevant footage, photographs, illustrations and diagrams.
- Start from what the audience needs to see. For a physical process, show its actual subjects and steps: for coffee, cherries, processing, roasting, grinding and brewing. Use diagrams when they add understanding, not as a substitute for showing real things.
- series: a short HUD label like "BRAIN CHEMISTRY · 02" or "CASE 04 · THE SOUND" (≤ 32 chars).
- imageStyle: consistent art direction for photographic or illustrative images across the film, appropriate to the subject and user brief.
- accent / accent2: hex colors that pop on near-black (documentary: one hot accent such as ember red; infographic: amber + cyan style pairs).
Output ONLY the JSON object.`

const SCENE_SYSTEM = `You are a scene director for premium explainer motion design. You design ONE scene of a film.
Your job: make this beat instantly understood through specific visual storytelling. Choose relevant footage or photographs for visible subjects and processes, and graphics only where they add explanatory value. An explainer is not a slide deck: vary shot scale, pace and visual treatment; avoid repeated generic widgets and walls of text. Compare this beat with the supplied storyboard and choose a distinct subject, action and framing from neighboring scenes; avoid depicting the same process twice.
Rules:
- headline: ≤ 9 words, punchy, on-screen; accentWord = the 1–2 words that carry the meaning (must appear in the headline).
- headlineTreatment: choose headline for a major idea, compact for a supporting label, or visual when the image and narration communicate the beat without a headline. Vary these deliberately across the film; a strong photograph or clip should sometimes fill the screen without a repeated large title.
- deck: optional italic line (≤ 12 words) that adds context, never repeats the headline.
- caption: the spoken line for this scene (≤ 22 words), lit word by word; keyWord = one word of it to highlight.
- hud.left/right: short editorial labels (e.g. "CASE 04 · THE SOUND" / "FIG. 3"); hud.chips: 0–2 data chips (dates, readings, sources).
- Numbers must come from the script or be well-established facts; if the script has no numbers, choose a non-numeric widget (toggle, timeline, quoteCard, slots) or none.
- Never use the same widget type as the previous scene.
- background "plate" (when available): show the actual subject or action of the beat, not a vague metaphor. Write plate.prompt as a specific shot brief (subject, action, setting, light, framing), without embedded text. Set a short searchable subjectLabel. Use an annotation only when it genuinely helps; no widget is required.
- plate.motion (only when clipsAvailable): use for processes and actions whose movement helps understanding, such as pouring, roasting, grinding or brewing, as well as dramatic action. The engine manages clip allocation.
- camera: push (default, reveals), pull (aftermath, scale), truckLeft/truckRight (journeys), craneUp (rising stakes), drift (calm).
${WIDGET_GUIDE}
Output ONLY the JSON object.`

function sceneText(s: VideoSpec['scenes'][number]): string {
  const parts: string[] = []
  for (const k of ['kicker', 'headline', 'subline', 'text', 'value', 'label', 'context', 'attribution', 'action', 'logoText'] as const) {
    const v = (s as Record<string, unknown>)[k]
    if (typeof v === 'string' && v) parts.push(v)
  }
  if ('bullets' in s) parts.push(...s.bullets)
  if (s.kind === 'comparison') parts.push(`${s.left.label}: ${s.left.points.join(', ')} vs ${s.right.label}: ${s.right.points.join(', ')}`)
  return parts.join(' — ')
}

/** trim over-long strings / arrays at the paths zod complains about, then re-validate */
function repair<T>(schema: z.ZodType<T>, raw: unknown): { ok: true; data: T } | { ok: false; issues: string } {
  let value: unknown = raw
  for (let pass = 0; pass < 3; pass++) {
    const r = schema.safeParse(value)
    if (r.success) return { ok: true, data: r.data }
    let fixed = false
    for (const issue of r.error.issues) {
      if (issue.code !== 'too_big') continue
      const max = Number((issue as { maximum?: number | bigint }).maximum)
      let parent: unknown = value
      for (const key of issue.path.slice(0, -1)) parent = (parent as Record<PropertyKey, unknown>)?.[key as PropertyKey]
      const last = issue.path[issue.path.length - 1] as PropertyKey
      const cur = (parent as Record<PropertyKey, unknown>)?.[last]
      if (typeof cur === 'string') {
        ;(parent as Record<PropertyKey, unknown>)[last] = cur.slice(0, max).replace(/\s+\S*$/, '').trim() || cur.slice(0, max)
        fixed = true
      } else if (Array.isArray(cur)) {
        ;(parent as Record<PropertyKey, unknown>)[last] = cur.slice(0, max)
        fixed = true
      } else if (typeof cur === 'number') {
        ;(parent as Record<PropertyKey, unknown>)[last] = max
        fixed = true
      }
    }
    if (!fixed) {
      return { ok: false, issues: r.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
    }
  }
  const last = schema.safeParse(value)
  return last.success ? { ok: true, data: last.data } : { ok: false, issues: last.error.issues.slice(0, 6).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
}

/** compact widgets that read cleanly in the low band over a painting */
const COMPACT = new Set<Widget['type']>(['counter', 'distanceBar', 'waveform', 'statPair'])

/** deterministic guards: what the engine can actually render well */
export function guardCraft(draft: SceneCraftDraft, sceneId: string, opts: { platesAvailable: boolean; clipsAvailable?: boolean; narration: string }): SceneCraft {
  const usePlate = draft.background === 'plate' && opts.platesAvailable && !!draft.plate?.prompt
  if (usePlate && draft.plate) draft = { ...draft, plate: { ...draft.plate, motion: Boolean(opts.clipsAvailable && draft.plate.motion) } }
  let widgets = draft.widgets.filter((w) => w.type !== 'annotation' || usePlate)
  if (usePlate) {
    const anno = widgets.find((w) => w.type === 'annotation')
    const compact = widgets.find((w) => COMPACT.has(w.type))
    widgets = [anno, compact].filter(Boolean) as Widget[]
  }
  // slots: blocked ≤ filled ≤ total; ring gauge values in range
  widgets = widgets.map((w) => {
    if (w.type === 'slots') {
      const filled = Math.min(w.filled, w.total)
      return { ...w, filled, blocked: Math.min(w.blocked, filled) }
    }
    return w
  })
  const accentWord = draft.accentWord && draft.headline.toLowerCase().includes(draft.accentWord.toLowerCase()) ? draft.accentWord : ''
  return SceneCraft.parse({
    ...draft,
    sceneId,
    background: usePlate ? 'plate' : 'grid',
    plate: usePlate ? draft.plate : undefined,
    accentWord,
    widgets,
    caption: draft.caption || opts.narration.slice(0, 140)
  })
}

export interface DirectorOptions {
  provider: LLMProvider
  platesAvailable: boolean
  /** moving clips can be made for plate scenes (the engine still caps how many) */
  clipsAvailable?: boolean
  /** the autopilot's pick of look; the film director follows it when images allow */
  lookHint?: 'documentary' | 'infographic'
  userPrompt: string
  concurrency?: number
  onScene?: (index: number, craft: SceneCraft) => void
}

export class SceneDirector {
  constructor(private readonly opts: DirectorOptions) {}

  private get mock(): boolean {
    return this.opts.provider.id === 'mock'
  }

  async directFilm(spec: VideoSpec): Promise<FilmDesign> {
    if (this.mock) return heuristicDesign(spec)
    filmSchema ??= toSchema(FilmDesign)
    const preset = PLATFORM_PRESETS[spec.platform]
    const payload = {
      userPrompt: this.opts.userPrompt,
      title: spec.title,
      platform: `${preset.label} ${preset.aspectLabel}`,
      plannedStyle: spec.style,
      scenes: spec.scenes.map((s, i) => `${i + 1}. [${s.kind}] ${sceneText(s)}`),
      narration: spec.narration.map((n) => n.text).join(' '),
      platesAvailable: this.opts.platesAvailable,
      note: this.opts.platesAvailable ? '' : 'No image model is configured: choose "infographic" unless the film truly needs documentary chrome (it will run on dark backgrounds).',
      ...(this.opts.lookHint && (this.opts.lookHint === 'infographic' || this.opts.platesAvailable)
        ? { requiredLook: this.opts.lookHint, requiredLookNote: `The studio has already decided: use look "${this.opts.lookHint}".` }
        : {})
    }
    try {
      const raw = await this.opts.provider.generateJSON<unknown>({ system: FILM_SYSTEM, prompt: JSON.stringify(payload), schemaName: 'FilmDesign', jsonSchema: filmSchema, temperature: 0.7, maxTokens: 1500 })
      const r = repair(FilmDesign, raw)
      if (r.ok) {
        const hint = this.opts.lookHint && (this.opts.lookHint === 'infographic' || this.opts.platesAvailable) ? this.opts.lookHint : undefined
        const look = hint ?? r.data.look
        const imageStyle = r.data.imageStyle || 'cinematic painterly still, natural light, 35mm lens, muted palette with one warm accent'
        return { ...r.data, look, imageStyle }
      }
    } catch {
      /* fall through */
    }
    return heuristicDesign(spec)
  }

  /** all scenes in parallel (bounded); each failure falls back to the heuristic craft for that scene */
  async directScenes(spec: VideoSpec, design: FilmDesign, notes?: Map<string, string>, only?: Set<string>): Promise<SceneCraft[]> {
    const native3D = (i: number) => spec.style === 'motion3d' && (spec.scenes[i].kind === 'showcase3d' || spec.scenes[i].kind === 'particles')
    const nativeIds = new Set(spec.scenes.filter((_, i) => native3D(i)).map((s) => s.id))
    const out: SceneCraft[] = [...spec.crafts.filter((c) => only && !only.has(c.sceneId) && !nativeIds.has(c.sceneId))]
    const indices = spec.scenes.map((_, i) => i).filter((i) => !native3D(i) && (!only || only.has(spec.scenes[i].id)))
    const limit = this.opts.concurrency ?? 3
    const results = new Map<number, SceneCraft>()
    let cursor = 0
    const worker = async () => {
      while (cursor < indices.length) {
        const i = indices[cursor++]
        const craft = await this.directScene(spec, design, i, notes?.get(spec.scenes[i].id))
        results.set(i, craft)
        this.opts.onScene?.(i, craft)
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, indices.length) }, worker))
    for (const i of indices) out.push(results.get(i) as SceneCraft)
    const order = new Map(spec.scenes.map((s, i) => [s.id, i]))
    out.sort((a, b) => (order.get(a.sceneId) ?? 0) - (order.get(b.sceneId) ?? 0))
    // Review the visual rhythm as a film. Scene calls run in parallel and
    // cannot otherwise see one another's treatment choices.
    if (!this.mock && !only && out.filter(c => c.background === 'plate').length > 1) {
      try {
        const plan = await this.opts.provider.generateJSON<{ treatments: Array<{ sceneId: string; treatment: 'headline' | 'compact' | 'visual' }> }>({
          system: 'As the film editor, choose the text treatment for each scene across this complete video. Use headline for a major idea, compact for a short supporting label, visual to let the photograph or footage and narration tell the beat without a headline. Avoid the same treatment in every scene; when a sequence has multiple suitable photo/footage scenes, make at least one image-led visual scene. Keep a headline when it is essential to understanding, and do not hide text for purely graphic scenes. Return the actual scene IDs and one treatment each.',
          prompt: JSON.stringify({ brief: this.opts.userPrompt, storyboard: spec.scenes, scenes: out.map(c => ({ sceneId: c.sceneId, headline: c.headline, caption: c.caption, background: c.background, shot: c.plate?.prompt })) }),
          schemaName: 'VisualTreatmentPlan', jsonSchema: { type: 'object', properties: { treatments: { type: 'array', items: { type: 'object', properties: { sceneId: { type: 'string' }, treatment: { type: 'string', enum: ['headline', 'compact', 'visual'] } }, required: ['sceneId', 'treatment'], additionalProperties: false } } }, required: ['treatments'], additionalProperties: false }, temperature: 0.3, maxTokens: 700
        })
        const picks = new Map((Array.isArray(plan.treatments) ? plan.treatments : []).filter(p => ['headline', 'compact', 'visual'].includes(p.treatment)).map(p => [p.sceneId, p.treatment]))
        return out.map(c => ({ ...c, headlineTreatment: picks.get(c.sceneId) ?? c.headlineTreatment }))
      } catch { /* keep the scene directors' choices */ }
    }
    return out
  }

  async directScene(spec: VideoSpec, design: FilmDesign, index: number, critique?: string): Promise<SceneCraft> {
    const scene = spec.scenes[index]
    const narration = spec.narration.find((n) => n.sceneId === scene.id)?.text ?? ''
    const guardOpts = { platesAvailable: this.opts.platesAvailable, clipsAvailable: this.opts.clipsAvailable, narration }
    if (this.mock) return guardCraft(heuristicCraft(spec, design, index), scene.id, guardOpts)
    sceneSchema ??= toSchema(SceneCraftDraft)
    const preset = PLATFORM_PRESETS[spec.platform]
    const prev = spec.crafts.find((c) => c.sceneId === spec.scenes[index - 1]?.id)
    const payload = {
      film: { title: spec.title, look: design.look, series: design.series, imageStyle: design.imageStyle, platform: `${preset.label} ${preset.aspectLabel}` },
      storyboard: spec.scenes.map((s, i) => `${i === index ? '>>' : '  '} ${i + 1}. [${s.kind}, ${s.durationSec}s] ${sceneText(s)}`),
      thisScene: { position: `${index + 1} of ${spec.scenes.length}`, durationSec: scene.durationSec, plannedContent: sceneText(scene), narration },
      previousSceneWidgets: prev?.widgets.map((w) => w.type) ?? [],
      platesAvailable: guardOpts.platesAvailable,
      clipsAvailable: Boolean(guardOpts.platesAvailable && guardOpts.clipsAvailable),
      ...(critique ? { criticNotes: critique, instruction: 'A reviewer watched the rendered scene. Fix every note while keeping what works.' } : {})
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await this.opts.provider.generateJSON<unknown>({
          system: SCENE_SYSTEM,
          prompt: JSON.stringify(payload),
          schemaName: 'SceneCraft',
          jsonSchema: sceneSchema,
          temperature: attempt === 0 ? 0.8 : 0.4,
          maxTokens: 2500
        })
        const r = repair(SceneCraftDraft, raw)
        if (r.ok) return guardCraft(r.data, scene.id, guardOpts)
        ;(payload as Record<string, unknown>).previousAttemptErrors = r.issues
      } catch {
        /* retry, then heuristic */
      }
    }
    return guardCraft(heuristicCraft(spec, design, index), scene.id, guardOpts)
  }
}

/** how many moving clips one film may carry (≈ $0.80 each with Gemini Omni) */
export function clipBudget(totalSec: number): number {
  return Math.min(3, Math.max(1, Math.round(totalSec / 20)))
}

/**
 * The engine's call on which motion requests become clips: the opening scene
 * first (it is the hook), then the scenes the directors flagged, in film order,
 * up to the budget. Everything else keeps its painted still. A scene that
 * already holds a finished clip is never demoted — the clip is paid for, and
 * showing it again costs nothing.
 */
export function pickClipScenes(crafts: SceneCraft[], totalSec: number): SceneCraft[] {
  const want = crafts.filter((c) => c.background === 'plate' && c.plate?.motion)
  const keep = new Set(want.slice(0, clipBudget(totalSec)).map((c) => c.sceneId))
  return crafts.map((c) =>
    c.plate?.motion && !keep.has(c.sceneId) && !c.plate.clipFile ? { ...c, plate: { ...c.plate, motion: false, clipFile: undefined } } : c
  )
}

/** same subject, reworded — a repaint would bill the same picture twice */
export function sameShot(a: string, b: string): boolean {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (!ta.size || !tb.size) return false
  let hit = 0
  for (const w of ta) if (tb.has(w)) hit++
  return hit / Math.min(ta.size, tb.size) >= 0.6
}

export interface PreserveResult {
  crafts: SceneCraft[]
  /** finished plates kept although the brief was reworded (would have re-billed) */
  keptReworded: number
  /** finished plates dropped — a genuinely different shot, repainted by choice */
  droppedPlates: number
  /** finished clips dropped with them */
  droppedClips: number
}

/**
 * Finished plates survive re-direction — paid work is never thrown away on a
 * technicality. An identical brief always keeps its files; on the critic's
 * quality pass ('subject') a reworded brief for the same subject keeps them
 * too (the painting is fine, the director just phrased it differently), and a
 * finished clip stays in the film whatever the new motion pick says — it is
 * already paid for. 'exact' (scene revision from user feedback) repaints on
 * any brief change, so what the user asked for is what they get.
 */
export function preserveFinishedPlates(
  crafts: SceneCraft[],
  previous: Map<string, SceneCraft>,
  mode: 'exact' | 'subject' = 'exact'
): PreserveResult {
  let keptReworded = 0
  let droppedPlates = 0
  let droppedClips = 0
  const out = crafts.map((c): SceneCraft => {
    const old = previous.get(c.sceneId)?.plate
    if (!old?.file) return c
    if (!c.plate || c.background !== 'plate') {
      // the re-directed scene dropped its plate entirely — count the loss, the director's call stands
      droppedPlates += 1
      if (old.clipFile) droppedClips += 1
      return c
    }
    const keep = c.plate.prompt === old.prompt || (mode === 'subject' && sameShot(old.prompt, c.plate.prompt))
    if (!keep) {
      droppedPlates += 1
      if (old.clipFile) droppedClips += 1
      return c
    }
    if (c.plate.prompt !== old.prompt) keptReworded += 1
    return {
      ...c,
      // same subject → same anchor; a new subject label is re-located on the same painting
      plate: {
        ...c.plate,
        file: old.file,
        depthFile: old.depthFile,
        anchor: old.subjectLabel === c.plate.subjectLabel ? old.anchor : undefined,
        // a finished clip is already paid for — it stays in the film
        motion: c.plate.motion || Boolean(old.clipFile),
        clipFile: old.clipFile
      }
    }
  })
  return { crafts: out, keptReworded, droppedPlates, droppedClips }
}

// ---------------------------------------------------------------- heuristics (mock + fallback)

export function heuristicDesign(spec: VideoSpec): FilmDesign {
  const topic = spec.title.split(/[—–:-]/)[0].trim()
  const series = `${topic.toUpperCase().slice(0, 24)} · 01`
  return { look: 'infographic', series, imageStyle: '', accent: '#FFB547', accent2: '#3EE6FF' }
}

function longestWord(text: string): string {
  return text.split(/\s+/).reduce((a, w) => (w.replace(/\W/g, '').length > a.replace(/\W/g, '').length ? w : a), '')
}

function parseNumber(v: string): { n: number; unit: string; prefix: string } | null {
  const m = v.replace(/,/g, '').match(/^([^\d-]*)(-?\d+(?:\.\d+)?)\s*(.*)$/)
  if (!m) return null
  return { prefix: m[1].trim().slice(0, 4), n: parseFloat(m[2]), unit: m[3].trim().slice(0, 10) }
}

export function heuristicCraft(spec: VideoSpec, design: FilmDesign, index: number): SceneCraftDraft {
  const s = spec.scenes[index]
  const narration = spec.narration.find((n) => n.sceneId === s.id)?.text ?? ''
  const base = {
    background: 'grid' as const,
    deck: '',
    hud: { left: design.series, right: `Fig. ${index + 1}`, chips: [] as string[] },
    caption: narration.split(/\s+/).slice(0, 22).join(' '),
    keyWord: longestWord(narration).replace(/[^\p{L}\p{N}'’-]/gu, '').slice(0, 24)
  }
  const head = (t: string) => t.split(/\s+/).slice(0, 9).join(' ')
  switch (s.kind) {
    case 'stat': {
      const p = parseNumber(s.value)
      const widget: Widget =
        p && /%/.test(s.value) && p.n >= 0 && p.n <= 100
          ? { type: 'ringGauge', label: s.label.slice(0, 24), value: p.n }
          : p
            ? { type: 'counter', label: s.label.slice(0, 28), from: 0, to: p.n, unit: p.unit.replace('%', ''), prefix: p.prefix }
            : { type: 'statPair', a: { label: s.label.slice(0, 14), value: s.value.slice(0, 10) }, b: { label: 'Context', value: '—' } }
      return { ...base, headline: head(s.context || s.label), accentWord: longestWord(s.label), widgets: [widget] }
    }
    case 'bullets':
      return {
        ...base,
        headline: head(s.headline),
        accentWord: longestWord(s.headline),
        widgets: [{ type: 'timeline', items: s.bullets.slice(0, 5).map((b, i) => ({ label: `Step ${String(i + 1).padStart(2, '0')}`, text: b.slice(0, 36) })) }]
      }
    case 'comparison':
      return {
        ...base,
        headline: head(s.headline ?? `${s.left.label} vs ${s.right.label}`),
        accentWord: s.right.label.split(/\s+/)[0] ?? '',
        deck: `${s.left.points[0] ?? ''}`.slice(0, 90),
        widgets: [{ type: 'toggle', from: s.left.label.slice(0, 14), to: s.right.label.slice(0, 14), label: '' }]
      }
    case 'quote':
      return { ...base, headline: head(s.attribution ? `In the words of ${s.attribution}` : 'Worth remembering'), accentWord: '', widgets: [{ type: 'quoteCard', text: s.text.slice(0, 180), attribution: (s.attribution ?? '').slice(0, 48) }] }
    default: {
      const headline = 'headline' in s && s.headline ? s.headline : spec.title
      const sub = 'subline' in s && s.subline ? s.subline : ''
      return { ...base, headline: head(headline), accentWord: longestWord(headline), deck: sub.slice(0, 90), widgets: [] }
    }
  }
}
