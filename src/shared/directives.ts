import type { RefRole } from './spec'
import type { WatermarkPosition } from './brand'

/**
 * Directives: instructions the person wrote in their prompt about their logo
 * and their pictures ("logo at the end", "like @dusk-mood"). They are read
 * here, shown back as chips, and only take effect when the person applies
 * them: the controls stay the source of truth.
 */

export interface BrandOverride {
  watermark?: WatermarkPosition
  endCard?: boolean
}

export interface PictureView {
  path: string
  name: string
  role: RefRole
}

export type Directive =
  | { id: string; kind: 'logo'; label: string; override: BrandOverride }
  | { id: string; kind: 'role'; label: string; path: string; role: RefRole }
  | { id: string; kind: 'blocked'; label: string; why: string }

/** how a picture is mentioned in a prompt: "@dusk-mood" for dusk-mood.jpg */
export function mentionOf(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'picture'
}

const OFF = /\b(?:no|without|remove|hide|skip|leave out|drop)\s+(?:the\s+|any\s+|my\s+|our\s+)?logo\b/i
const END = /\blogo\b[^.,;!?]{0,30}\b(?:at|on|in)\s+the\s+(?:very\s+)?(?:end|finish|close|outro|last)\b|\b(?:end|finish|close)\s+(?:on|with)\s+(?:the\s+|my\s+|our\s+)?(?:logo|brand)\b|\blogo\s+(?:end\s*card|outro)\b|\bbrand\s+at\s+the\s+end\b/i
const START = /\blogo\b[^.,;!?]{0,30}\b(?:at|in|on)\s+the\s+(?:very\s+)?(?:start|beginning|intro|opening|first)\b|\b(?:open|start|begin)\s+(?:with|on)\s+(?:the\s+|my\s+|our\s+)?logo\b/i
const CORNER = /\blogo\b[^.,;!?]{0,30}\b(top[- ]?left|top[- ]?right|upper[- ]?left|upper[- ]?right|left|right)\b/i
const ONLY = /\b(?:only|just)\b/i

const STYLE_CUE = /\b(?:like|style of|look of|feel of|mood of|inspired by|same look as|match(?:ing)?|similar to)\s*$/i
const SUBJECT_CUE = /\b(?:product|hero|item|device|bottle|object)\b/i
const CONTENT_CUE = /\b(?:screenshot|screen|ui|interface|dashboard|app screen|page)\b/i

/** the clause around a mention: from the last break before it to the next break after it */
function clauseAround(text: string, at: number, len: number): { before: string; after: string } {
  const start = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf(',', at - 1), text.lastIndexOf(';', at - 1), text.lastIndexOf('\n', at - 1)) + 1
  const afterText = text.slice(at + len)
  const stop = afterText.search(/[.,;\n]/)
  return { before: text.slice(start, at), after: stop < 0 ? afterText : afterText.slice(0, stop) }
}

export function parseDirectives(prompt: string, pictures: PictureView[], kit: { hasLogo: boolean } | null): Directive[] {
  const text = String(prompt ?? '')
  const out: Directive[] = []
  const push = (d: Directive) => {
    if (!out.some((o) => o.id === d.id)) out.push(d)
  }

  // ---- the logo ----
  if (OFF.test(text)) {
    push({ id: 'logo-off', kind: 'logo', label: 'Leave the logo out', override: { watermark: 'off', endCard: false } })
  } else {
    const end = END.exec(text)
    if (end) {
      const only = ONLY.test(text.slice(Math.max(0, end.index - 20), end.index + end[0].length + 20))
      push({ id: only ? 'logo-end-only' : 'logo-end', kind: 'logo', label: only ? 'Logo on the closing card only' : 'Logo on a closing card', override: only ? { watermark: 'off', endCard: true } : { endCard: true } })
    }
    const corner = CORNER.exec(text)
    if (corner && !END.test(corner[0]) && !START.test(corner[0])) {
      const left = /left/i.test(corner[1])
      push({ id: left ? 'logo-left' : 'logo-right', kind: 'logo', label: `Logo in the ${left ? 'top left' : 'top right'} corner`, override: { watermark: left ? 'top-left' : 'top-right' } })
    }
    if (START.test(text)) push({ id: 'logo-start', kind: 'blocked', label: 'Logo at the start', why: 'An opening logo card is not available yet. The corner logo and the closing card are used.' })
  }
  if (out.some((d) => d.kind === 'logo') && kit && !kit.hasLogo) {
    return [{ id: 'no-logo', kind: 'blocked', label: 'Logo', why: 'The chosen brand kit has no logo yet. Add one in Settings → Brand kit.' }, ...out.filter((d) => d.kind !== 'logo')]
  }
  if (out.some((d) => d.kind === 'logo') && !kit) {
    return [{ id: 'no-kit', kind: 'blocked', label: 'Logo', why: 'Pick a brand kit above to use a logo.' }, ...out.filter((d) => d.kind !== 'logo')]
  }

  // ---- pictures mentioned with @ ----
  for (const m of text.matchAll(/(?<![\w.])@([a-z0-9][a-z0-9_-]*)/gi)) {
    const token = m[1].toLowerCase()
    const pic = /^\d{1,2}$/.test(token) ? pictures[Number(token) - 1] : pictures.find((p) => mentionOf(p.name) === token) ?? pictures.find((p) => mentionOf(p.name).startsWith(token) && token.length >= 3)
    if (!pic) {
      push({ id: `missing-${token}`, kind: 'blocked', label: `@${token}`, why: 'No attached picture has that name. Add the picture above, or use the @ button on its card.' })
      continue
    }
    const { before, after } = clauseAround(text, m.index ?? 0, m[0].length)
    let role: RefRole | null = null
    if (STYLE_CUE.test(before.trimEnd() + ' ')) role = 'style'
    else if (CONTENT_CUE.test(after) || CONTENT_CUE.test(before)) role = 'content'
    else if (SUBJECT_CUE.test(after) || SUBJECT_CUE.test(before)) role = 'subject'
    if (role && role !== pic.role) push({ id: `role-${pic.path}-${role}`, kind: 'role', label: `${pic.name} → ${role === 'style' ? 'look to copy' : role === 'subject' ? 'product to show' : 'screenshot to show'}`, path: pic.path, role })
  }
  return out
}
