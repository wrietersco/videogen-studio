import { z } from 'zod'
import { FilmDesign, Plate, SceneCraft, Widget, type VideoSpec } from '@shared/spec'
import { PLATFORM_PRESETS } from '@shared/presets'
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
  plate: Plate.omit({ file: true, depthFile: true, anchor: true }).optional()
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
- look "infographic": dark UI diagrams, dot-grid, glowing widgets — for science, how-it-works, health, money, tech, data, tips, products.
- look "documentary": painted cinematic stills with an editorial HUD (FIG. labels, annotations) — for history, stories, places, nature, events, mysteries, biographies.
- series: a short HUD label like "BRAIN CHEMISTRY · 02" or "CASE 04 · THE SOUND" (≤ 32 chars).
- imageStyle (documentary only): one consistent art direction for every still — medium, era, palette, lighting, lens, mood. Painterly or photographic, never cartoon unless asked.
- accent / accent2: hex colors that pop on near-black (documentary: one hot accent such as ember red; infographic: amber + cyan style pairs).
Output ONLY the JSON object.`

const SCENE_SYSTEM = `You are a scene director for premium explainer motion design. You design ONE scene of a film.
Your job: find the single visual metaphor that makes this beat instantly understood, and express it with the widget catalog.
Rules:
- headline: ≤ 9 words, punchy, on-screen; accentWord = the 1–2 words that carry the meaning (must appear in the headline).
- deck: optional italic line (≤ 12 words) that adds context, never repeats the headline.
- caption: the spoken line for this scene (≤ 22 words), lit word by word; keyWord = one word of it to highlight.
- hud.left/right: short editorial labels (e.g. "CASE 04 · THE SOUND" / "FIG. 3"); hud.chips: 0–2 data chips (dates, readings, sources).
- Numbers must come from the script or be well-established facts; if the script has no numbers, choose a non-numeric widget (toggle, timeline, quoteCard, slots) or none.
- Never use the same widget type as the previous scene.
- background "plate" (only when plates are available): write plate.prompt as a vivid, concrete image brief (subject, setting, era, light, weather, camera) — no text in the image. Set plate.subject to where the subject sits and plate.subjectLabel to its short name. Plate scenes use widgets: [annotation] plus at most ONE compact widget (counter, distanceBar, waveform, statPair). plate.subjectLabel names exactly the spot the annotation must mark (e.g. "the gash below the waterline", not just "ship").
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
export function guardCraft(draft: SceneCraftDraft, sceneId: string, opts: { platesAvailable: boolean; narration: string }): SceneCraft {
  const usePlate = draft.background === 'plate' && opts.platesAvailable && !!draft.plate?.prompt
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
      note: this.opts.platesAvailable ? '' : 'No image model is configured: choose "infographic" unless the film truly needs documentary chrome (it will run on dark backgrounds).'
    }
    try {
      const raw = await this.opts.provider.generateJSON<unknown>({ system: FILM_SYSTEM, prompt: JSON.stringify(payload), schemaName: 'FilmDesign', jsonSchema: filmSchema, temperature: 0.7, maxTokens: 1500 })
      const r = repair(FilmDesign, raw)
      if (r.ok) return { ...r.data, imageStyle: r.data.look === 'documentary' ? r.data.imageStyle : '' }
    } catch {
      /* fall through */
    }
    return heuristicDesign(spec)
  }

  /** all scenes in parallel (bounded); each failure falls back to the heuristic craft for that scene */
  async directScenes(spec: VideoSpec, design: FilmDesign, notes?: Map<string, string>, only?: Set<string>): Promise<SceneCraft[]> {
    const out: SceneCraft[] = [...spec.crafts.filter((c) => only && !only.has(c.sceneId))]
    const indices = spec.scenes.map((_, i) => i).filter((i) => !only || only.has(spec.scenes[i].id))
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
    return out.sort((a, b) => (order.get(a.sceneId) ?? 0) - (order.get(b.sceneId) ?? 0))
  }

  async directScene(spec: VideoSpec, design: FilmDesign, index: number, critique?: string): Promise<SceneCraft> {
    const scene = spec.scenes[index]
    const narration = spec.narration.find((n) => n.sceneId === scene.id)?.text ?? ''
    const guardOpts = { platesAvailable: this.opts.platesAvailable && design.look === 'documentary', narration }
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
