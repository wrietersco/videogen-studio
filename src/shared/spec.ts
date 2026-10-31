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
  'facebook-feed',
  'square'
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

// ---------------- directed scenes (scene director + plate engine) ----------------

/**
 * Film-level design system chosen by the film director: one look for the
 * whole video so every scene reads as the same channel.
 */
export const FilmDesign = z.object({
  /** 'infographic' = dark UI diagrams · 'documentary' = painted plates + editorial HUD */
  look: z.enum(['infographic', 'documentary']),
  /** series label in the HUD, e.g. "BRAIN CHEMISTRY" */
  series: z.string().max(40),
  /** shared art direction appended to every plate prompt (consistency across scenes) */
  imageStyle: z.string().max(400).default(''),
  /** accent for highlights / annotations (hex) */
  accent: z.string().default('#FFB547'),
  /** secondary accent (hex) */
  accent2: z.string().default('#3EE6FF')
})
export type FilmDesign = z.infer<typeof FilmDesign>

export const CameraMove = z.enum(['push', 'pull', 'truckLeft', 'truckRight', 'craneUp', 'drift'])
export type CameraMove = z.infer<typeof CameraMove>

/** a painted still behind the scene, animated as a 2.5D camera move over its depth map */
export const Plate = z.object({
  prompt: z.string().max(900),
  camera: CameraMove.default('push'),
  /** where the subject should sit — steers the image prompt and the annotation anchor */
  subject: z.enum(['left', 'center', 'right']).default('center'),
  /** short name of the subject, used to locate it in the finished image */
  subjectLabel: z.string().max(40).default(''),
  /** the beat needs real movement (waves, lava, crowds, machines) — the engine may animate it into a video clip */
  motion: z.boolean().default(false),
  /** filled by the engine when the still became a moving clip (project-relative mp4) */
  clipFile: z.string().optional(),
  /** filled by the plate engine (project-relative paths + located anchor in 0..1 image space) */
  file: z.string().optional(),
  depthFile: z.string().optional(),
  anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional()
})
export type Plate = z.infer<typeof Plate>

const num = z.number()
/** Premium parametric widgets — the director only picks one and fills its data. */
export const Widget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ringGauge'), label: z.string().max(24), value: num.min(0).max(100), after: num.min(0).max(100).optional(), afterLabel: z.string().max(16).optional() }),
  z.object({ type: z.literal('counter'), label: z.string().max(28), from: num.default(0), to: num, unit: z.string().max(10).default(''), prefix: z.string().max(4).default('') }),
  z.object({ type: z.literal('bars'), label: z.string().max(28), unit: z.string().max(8).default(''), items: z.array(z.object({ label: z.string().max(16), value: num })).min(2).max(5) }),
  z.object({ type: z.literal('toggle'), from: z.string().max(14), to: z.string().max(14), label: z.string().max(24).default('') }),
  z.object({ type: z.literal('timeline'), items: z.array(z.object({ label: z.string().max(14), text: z.string().max(36) })).min(2).max(5) }),
  z.object({ type: z.literal('quoteCard'), text: z.string().max(180), attribution: z.string().max(48).default('') }),
  z.object({ type: z.literal('statPair'), a: z.object({ label: z.string().max(14), value: z.string().max(10) }), b: z.object({ label: z.string().max(14), value: z.string().max(10) }) }),
  z.object({ type: z.literal('slots'), label: z.string().max(24), total: num.int().min(3).max(8), filled: num.int().min(0).max(8), blocked: num.int().min(0).max(8).default(0), fillLabel: z.string().max(14).default(''), blockLabel: z.string().max(14).default('') }),
  z.object({ type: z.literal('distanceBar'), label: z.string().max(24), max: num.positive(), unit: z.string().max(8).default('') }),
  z.object({ type: z.literal('waveform'), label: z.string().max(24).default('') }),
  z.object({ type: z.literal('annotation'), label: z.string().max(28) })
])
export type Widget = z.infer<typeof Widget>

export const SceneCraft = z.object({
  sceneId: z.string(),
  background: z.enum(['grid', 'plate']).default('grid'),
  plate: Plate.optional(),
  /** on-screen headline (≤ 9 words) and the one word painted in the accent */
  headline: z.string().max(90),
  /** Let the director give imagery room when a headline is unnecessary. */
  headlineTreatment: z.enum(['headline', 'compact', 'visual']).optional(),
  accentWord: z.string().max(24).default(''),
  /** small italic line under the headline */
  deck: z.string().max(90).default(''),
  /** HUD chrome: left/right labels of the top rule, up to two chips at the bottom */
  hud: z
    .object({ left: z.string().max(32).default(''), right: z.string().max(16).default(''), chips: z.array(z.string().max(28)).max(2).default([]) })
    .default({ left: '', right: '', chips: [] }),
  /** 0–2 widgets: the visual metaphor of the beat */
  widgets: z.array(Widget).max(2).default([]),
  /** kinetic caption, lit word by word; keyWord is painted in the accent */
  caption: z.string().max(140).default(''),
  keyWord: z.string().max(24).default(''),
  /** critic verdict (filled by the vision critic, informational) */
  review: z.object({ score: z.number(), notes: z.array(z.string()) }).optional()
})
export type SceneCraft = z.infer<typeof SceneCraft>

/** one scene's narration, synthesized and measured (times relative to the take's own start) */
export const VoiceTake = z.object({
  sceneId: z.string(),
  /** cache key: voice + tone + text — an unchanged line is never re-synthesized */
  key: z.string(),
  file: z.string(),
  durationSec: z.number().positive(),
  /** leading silence inside the file — absorbed into the scene's lead */
  speechStartSec: z.number().min(0).default(0),
  /** the take starts this long after its scene starts */
  leadSec: z.number().min(0),
  words: z.array(z.object({ word: z.string(), startSec: z.number(), endSec: z.number() })).default([])
})
export type VoiceTake = z.infer<typeof VoiceTake>

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
    .default({ enabled: true, position: 'bottom', uppercase: true }),
  /** narration voice + delivery direction (absent = chosen from the film look) */
  voice: z.object({ id: z.string(), tone: z.string().max(400) }).optional(),
  /** voice-first timing: measured narration takes; scene durations are fitted to them */
  voiceover: z.array(VoiceTake).default([]),
  /** directed mode: film design system + per-scene crafts (absent = classic template scenes) */
  design: FilmDesign.optional(),
  crafts: z.array(SceneCraft).default([]),
  /** Model-authored vector scenes; markup is validated before use. */
  customScenes: z.array(z.object({ sceneId: z.string(), svg: z.string().max(100000) })).optional(),
  /** A locally rendered, sandboxed custom-code scene and its retained source. */
  customVideos: z.array(z.object({ sceneId: z.string(), file: z.string(), source: z.string().max(50000) })).optional()
})
export type VideoSpec = z.infer<typeof VideoSpec>
