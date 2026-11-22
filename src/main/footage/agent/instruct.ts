import { z } from 'zod'
import { EditPlan, MUSIC_MOODS } from '@shared/footage'
import type { LLMProvider } from '../../providers/types'

/**
 * MIDWAY INSTRUCTIONS — the person types while the edit is being made
 * ("no music", "make it shorter"), and the plan changes.
 *
 * interpretInstruction() makes ONE generateJSON call to read the instruction
 * into a small structured change, applies it defensively onto a COPY of the
 * plan (everything clamped, EditPlan.parse at the end), and falls back to
 * plain keyword rules when the model fails, its answer does not parse, or it
 * carries no recognizable intent. The reply is always set.
 */

const InstructionModel = z.object({
  /** one short plain sentence to the person */
  reply: z.string().min(1).max(160),
  title: z.string().min(1).max(90).optional(),
  /** indexes (0-based) of plan parts to cut */
  dropSegments: z.array(z.number().int().min(0)).optional(),
  musicMode: z.enum(['none', 'auto', 'lyra']).optional(),
  musicMood: z.enum(MUSIC_MOODS).optional(),
  overlays: z.enum(['keep', 'drop']).optional(),
  captions: z.enum(['off', 'clean', 'bold', 'box']).optional(),
  reframe: z.enum(['auto', 'crop', 'blur']).optional(),
  /** percent (0–40) to shrink every real-footage part by */
  shorten: z.number().min(0).max(40).optional()
})
type Instruction = z.infer<typeof InstructionModel>

const SYSTEM = `You help edit a video that is being made from the person's own footage. They have sent ONE short instruction about the edit plan in front of you.
Turn it into a small structured change; fields you leave out stay as they are.
- reply: one short plain sentence (160 chars at most) saying what you did, or asking for the one missing detail.
- title: a new title for the edit, when they asked for one.
- dropSegments: indexes (0-based) of the plan's parts to cut.
- musicMode / musicMood: change the music ('none', 'auto', 'lyra') and its mood.
- overlays: 'drop' removes the on-screen overlay effects.
- captions: the caption style ('off', 'clean', 'bold', 'box').
- reframe: how footage of the wrong shape is fitted ('auto', 'crop', 'blur').
- shorten: percent (0-40) to shrink every real-footage part by.
Never invent clip ids or numbers that are not in the plan. Output JSON only.`

/** what the model needs to see of the plan (bounded) */
function planForModel(plan: EditPlan): Record<string, unknown> {
  return {
    title: plan.title,
    shape: plan.shape,
    music: { mode: plan.music.mode, mood: plan.music.mood },
    captions: plan.captions,
    reframe: plan.reframe,
    overlays: plan.overlays.length,
    titles: plan.titles.map((t) => t.text),
    parts: plan.segments.slice(0, 40).map((s, i) => ({ i, clip: s.clipId, from: s.startSec, to: s.endSec, aiMade: !!s.ai }))
  }
}

function hasIntent(p: Instruction): boolean {
  return !!(
    p.title?.trim() ||
    p.dropSegments?.length ||
    p.musicMode ||
    p.musicMood ||
    p.overlays ||
    p.captions ||
    p.reframe ||
    (p.shorten !== undefined && p.shorten > 0)
  )
}

const cleanReply = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 160) || 'Done.'

/** shrink every non-ai part by `percent`, keeping at least 0.6s each and dropping empties */
function shortenPlan(plan: EditPlan, percent: number): EditPlan {
  const k = 1 - Math.min(40, Math.max(0, percent)) / 100
  return EditPlan.parse({
    ...plan,
    segments: plan.segments
      .map((s) => {
        const dur = s.endSec - s.startSec
        if (s.ai || dur <= 0) return { ...s }
        return { ...s, endSec: s.startSec + Math.min(dur, Math.max(0.6, dur * k)) }
      })
      .filter((s) => s.endSec - s.startSec > 0)
  })
}

/** the model's answer, applied defensively onto a copy of the plan */
function applyInstruction(plan: EditPlan, p: Instruction): EditPlan {
  let next: EditPlan = {
    ...plan,
    segments: plan.segments.map((s) => ({ ...s })),
    music: { ...plan.music },
    titles: plan.titles.slice(),
    overlays: plan.overlays.slice(),
    notes: plan.notes.slice()
  }
  if (p.title?.trim()) next.title = p.title.trim().slice(0, 90)
  if (p.dropSegments?.length) {
    const drop = new Set(p.dropSegments.filter((i) => Number.isInteger(i) && i >= 0 && i < next.segments.length))
    next.segments = next.segments.filter((_, i) => !drop.has(i))
  }
  if (p.musicMode || p.musicMood) next.music = { ...next.music, ...(p.musicMode ? { mode: p.musicMode } : {}), ...(p.musicMood ? { mood: p.musicMood } : {}) }
  if (p.overlays === 'drop') next.overlays = []
  if (p.captions) next.captions = p.captions
  if (p.reframe) next.reframe = p.reframe
  if (p.shorten !== undefined && p.shorten > 0) next = shortenPlan(next, p.shorten)
  return EditPlan.parse(next)
}

// ------------------------------------------------------------------ the rules fallback

const RULES: Array<{ test: RegExp; note: string; apply: (p: EditPlan) => EditPlan }> = [
  { test: /no music/i, note: 'the music is off', apply: (p) => ({ ...p, music: { ...p.music, mode: 'none' } }) },
  { test: /\b(?:faster|shorter)\b/i, note: 'every part is 15% shorter', apply: (p) => shortenPlan(p, 15) },
  { test: /no titles|no text/i, note: 'the on-screen text is gone', apply: (p) => ({ ...p, titles: [], captions: 'off' }) },
  { test: /no overlays?\b/i, note: 'the overlays are gone', apply: (p) => ({ ...p, overlays: [] }) }
]

function rulesReply(text: string, plan: EditPlan): { reply: string; plan: EditPlan } {
  const notes: string[] = []
  let next = plan
  for (const rule of RULES) {
    if (!rule.test.test(text)) continue
    next = rule.apply(next)
    notes.push(rule.note)
  }
  if (notes.length) return { reply: cleanReply(`Done — ${notes.join('; ')}.`), plan: next }
  return { reply: cleanReply('I could not follow that. Say it another way — for example "no music", "make it shorter", "no titles" or "no overlays".'), plan }
}

// ------------------------------------------------------------------ the one entry point

export async function interpretInstruction(provider: LLMProvider | null, text: string, plan: EditPlan, model?: string): Promise<{ reply: string; plan: EditPlan }> {
  const t = text.trim().slice(0, 400)
  try {
    if (provider) {
      const raw = await provider.generateJSON<unknown>({
        system: SYSTEM,
        prompt: JSON.stringify({ instruction: t, plan: planForModel(plan) }),
        schemaName: 'FootageInstruction',
        jsonSchema: z.toJSONSchema(InstructionModel, { target: 'draft-7', io: 'input' }) as Record<string, unknown>,
        temperature: 0.2,
        maxTokens: 1200,
        model
      })
      const parsed = InstructionModel.parse(raw)
      if (hasIntent(parsed)) return { reply: cleanReply(parsed.reply), plan: applyInstruction(plan, parsed) }
      // no recognizable intent: let the rules read the person's own words
    }
  } catch {
    // the model failed or its answer did not parse: the rules decide
  }
  return rulesReply(t, plan)
}
