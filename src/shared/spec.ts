import { z } from 'zod'

/**
 * VideoSpec — the central, editable data structure of the whole app.
 * The Planner produces it (1 LLM call), the Composer turns it into a
 * HyperFrames composition deterministically, and every editor operates on it.
 * Deterministic render + editable spec = same spec always yields same video.
 */

export const PlatformId = z.enum([
  'tiktok',
  'youtube',
  'youtube-shorts',
  'instagram-reels',
  'instagram-feed',
  'facebook-feed'
])
export type PlatformId = z.infer<typeof PlatformId>

export const StyleFamily = z.enum([
  'social', // kinetic typography, meme pacing, whip transitions
  'explainer', // slides, charts, feature callouts, problem→solution
  'motion3d', // Three.js scenes, camera paths, particles, logo stings
  'cinematic', // (later) shader looks, Ken Burns, letterbox
  'documentary', // (later)
  'flat2d' // (later)
])
export type StyleFamily = z.infer<typeof StyleFamily>

export const Pacing = z.enum(['calm', 'standard', 'energetic', 'frantic'])
export type Pacing = z.infer<typeof Pacing>

export const Palette = z.object({
  bg: z.string(),
  surface: z.string(),
  fg: z.string(),
  muted: z.string(),
  accent: z.string(),
  accent2: z.string()
})
export type Palette = z.infer<typeof Palette>

export const Typography = z.object({
  display: z.string().default('Archivo Black, sans-serif'),
  body: z.string().default('Inter, sans-serif'),
  capsDisplay: z.boolean().default(true)
})
export type Typography = z.infer<typeof Typography>

/** A photoreal still the pipeline may need from an image model (escalation only). */
export const AssetNeed = z.object({
  slotId: z.string(),
  kind: z.enum(['image']),
  prompt: z.string(),
  aspect: z.enum(['9:16', '16:9', '1:1', '4:5']).default('16:9')
})
export type AssetNeed = z.infer<typeof AssetNeed>

const SceneBase = z.object({
  id: z.string(),
  durationSec: z.number().positive(),
  transitionIn: z.enum(['cut', 'fade', 'whip', 'slide', 'zoom', 'glitch', 'wipe']).default('cut'),
  transitionOut: z.enum(['cut', 'fade', 'whip', 'slide', 'zoom', 'glitch', 'wipe']).default('cut')
})

export const Scene = z.discriminatedUnion('kind', [
  SceneBase.extend({
    kind: z.literal('title'),
    headline: z.string(),
    subline: z.string().optional(),
    kicker: z.string().optional() // small text above headline
  }),
  SceneBase.extend({
    kind: z.literal('statement'),
    headline: z.string(),
    subline: z.string().optional()
  }),
  SceneBase.extend({
    kind: z.literal('bullets'),
    headline: z.string(),
    bullets: z.array(z.string()).min(1).max(5)
  }),
  SceneBase.extend({
    kind: z.literal('comparison'),
    headline: z.string().optional(),
    left: z.object({ label: z.string(), points: z.array(z.string()) }),
    right: z.object({ label: z.string(), points: z.array(z.string()) })
  }),
  SceneBase.extend({
    kind: z.literal('stat'),
    value: z.string(), // "87%" | "3.2M" | "4×"
    label: z.string(),
    context: z.string().optional()
  }),
  SceneBase.extend({
    kind: z.literal('quote'),
    text: z.string(),
    attribution: z.string().optional()
  }),
  SceneBase.extend({
    kind: z.literal('cta'),
    headline: z.string(),
    subline: z.string().optional(),
    action: z.string().optional() // "Follow for more"
  }),
  SceneBase.extend({
    kind: z.literal('showcase3d'),
    headline: z.string().optional(),
    objectStyle: z
      .enum(['torusknot', 'icosphere', 'crystal', 'productBox', 'logoText', 'sphereGrid'])
      .default('torusknot'),
    material: z.enum(['chrome', 'glass', 'matte', 'neon', 'iridescent']).default('chrome'),
    motion: z.enum(['spin', 'float', 'dollyOrbit', 'explodeAssemble']).default('dollyOrbit'),
    logoText: z.string().optional()
  }),
  SceneBase.extend({
    kind: z.literal('particles'),
    headline: z.string(),
    subline: z.string().optional(),
    density: z.enum(['sparse', 'medium', 'dense']).default('medium')
  }),
  SceneBase.extend({
    kind: z.literal('kenburns'),
    headline: z.string().optional(),
    subline: z.string().optional(),
    assetSlotId: z.string(), // ties to AssetNeed for image escalation
    motion: z.enum(['zoomIn', 'zoomOut', 'panLeft', 'panRight']).default('zoomIn')
  })
])
export type Scene = z.infer<typeof Scene>

export const VideoSpec = z.object({
  schemaVersion: z.literal(1).default(1),
  title: z.string(),
  platform: PlatformId,
  style: StyleFamily,
  pacing: Pacing,
  durationSec: z.number().positive(),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]).default(30),
  palette: Palette,
  typography: Typography,
  scenes: z.array(Scene).min(1),
  narration: z
    .array(
      z.object({
        sceneId: z.string(),
        text: z.string()
      })
    )
    .default([]),
  assetNeeds: z.array(AssetNeed).default([]),
  musicMood: z
    .enum(['upbeat', 'cinematic', 'minimal', 'playful', 'dark', 'corporate', 'none'])
    .default('upbeat'),
  captionStyle: z
    .object({
      enabled: z.boolean().default(true),
      position: z.enum(['top', 'center', 'bottom']).default('bottom'),
      uppercase: z.boolean().default(true)
    })
    .default({ enabled: true, position: 'bottom', uppercase: true })
})
export type VideoSpec = z.infer<typeof VideoSpec>
