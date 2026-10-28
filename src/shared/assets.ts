/**
 * Asset library metadata — one JSON sidecar per media file. Written when an
 * asset is generated, uploaded, downloaded or shipped, and read back whenever
 * a new video looks for something it can reuse instead of paying for it.
 */

export type AssetKind = 'image' | 'video' | 'voice' | 'music' | 'sfx'

/** where an asset came from — shown as a coloured badge everywhere */
export type AssetSource = 'builtin' | 'generated' | 'uploaded' | 'stock'

export interface AssetLicense {
  /** e.g. "CC0", "CC BY 4.0", "Pexels License", "Yours", "Generated (your API key)" */
  name: string
  url?: string
  author?: string
  /** credit line to show in the video description when the licence asks for one */
  attribution?: string
  requiresAttribution?: boolean
}

export interface AssetMeta {
  id: string
  kind: AssetKind
  source: AssetSource
  title: string
  tags: string[]
  /** file name next to this sidecar */
  file: string
  mime: string
  bytes: number
  sha256: string
  width?: number
  height?: number
  durationSec?: number
  /** generation details (source = generated) */
  prompt?: string
  provider?: string
  model?: string
  costUsd?: number
  /** exact-reuse key (e.g. voice take hash, plate prompt hash) */
  key?: string
  /** free-form extras: voice id, music mood, stock page url… */
  extra?: Record<string, string | number | boolean>
  license: AssetLicense
  /** local = never leaves this PC; shareable = may be included in community uploads (opt-in) */
  sharing: 'local' | 'shareable'
  createdAt: string
  /** project ids that used this asset */
  usedIn: string[]
  favorite?: boolean
}

export const SOURCE_BADGE: Record<AssetSource, { icon: string; label: string; color: string }> = {
  builtin: { icon: '📦', label: 'Built-in', color: '#7fdff5' },
  generated: { icon: '✨', label: 'AI-made', color: '#b9a5ff' },
  uploaded: { icon: '⬆️', label: 'Yours', color: '#fcd34d' },
  stock: { icon: '🌐', label: 'Free stock', color: '#6ee7b7' }
}

export const KIND_LABEL: Record<AssetKind, { icon: string; label: string }> = {
  image: { icon: '🖼️', label: 'Images' },
  video: { icon: '🎬', label: 'Clips' },
  voice: { icon: '🎙️', label: 'Voices' },
  music: { icon: '🎵', label: 'Music' },
  sfx: { icon: '💥', label: 'Sound FX' }
}

const STOP = new Set(
  'a an the of and or to in on at for with by from into over under is are was were be this that these those it its as no not very more most keep place frame style shot scene image photo picture'.split(' ')
)

/** lowercase content words, lightly stemmed — the library's search vocabulary */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue
    out.push(raw.replace(/(ing|ed|es|s)$/u, '') || raw)
  }
  return out
}
