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
  /** Actual clip length, used to return to the still before footage ends. */
  clipDurationSec: z.number().positive().optional(),
  /** filled by the plate engine (project-relative paths + located anchor in 0..1 image space) */
  file: z.string().optional(),
  depthFile: z.string().optional(),
  anchor: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional()
})
export type Plate = z.infer<typeof Plate>

// ---------------- reference images (phase 2) ----------------

export const RefRole = z.enum(['style', 'subject', 'content'])
export type RefRole = z.infer<typeof RefRole>

/** a picture the person attached to this video; the file lives in the project's assets/refs folder */
export const RefImage = z.object({
  id: z.string().regex(/^ref-\d{1,2}$/),
  role: RefRole,
  file: z.string().regex(/^assets\/refs\/ref-\d{1,2}\.(jpg|png)$/),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** a cut-out with a transparent background (a product shot, say) */
  alpha: z.boolean().default(false),
  /** the file's original name, for display */
  name: z.string().max(80).default(''),
  /** the person's own words: what this is */
  note: z.string().max(80).default(''),
  /** one short line from the vision model (or empty): what the picture shows */
  about: z.string().max(160).default('')
})
export type RefImage = z.infer<typeof RefImage>

/** the look read from the style images: feeds the film director and the painted plates */
export const StyleBrief = z.object({
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(5).default([]),
  mood: z.string().max(120).default(''),
  composition: z.string().max(160).default(''),
  lighting: z.string().max(100).default(''),
  /** art direction sentence appended to every painted plate */
  imageStyle: z.string().max(300).default(''),
  /** where it came from: the vision model, or just the colors found on this computer */
  source: z.enum(['vision', 'local']).default('local')
})
export type StyleBrief = z.infer<typeof StyleBrief>

/**
 * What the person's reference video taught the app, kept abstract on purpose:
 * rhythm, structure and mood. Never its script, footage or music. The person
 * sees and edits this before it is used.
 */
export const VideoBrief = z.object({
  source: z.enum(['youtube', 'file']),
  url: z.string().max(200).default(''),
  title: z.string().max(120).default(''),
  durationSec: z.number().min(0).default(0),
  /** how fast it cuts: measured on a file, estimated by the AI for a link */
  cutsPerMinute: z.number().min(0).max(240).default(0),
  pacing: z.enum(['calm', 'standard', 'energetic', 'frantic']),
  hook: z.enum(['question', 'statement', 'stat', 'story', 'visual']).default('statement'),
  /** the beats it moves through, in a few words each: ["hook", "problem", "demo", "call to action"] */
  structure: z.array(z.string().max(60)).max(8).default([]),
  captions: z.enum(['big', 'small', 'none']).default('small'),
  musicEnergy: z.enum(['low', 'medium', 'high']).default('medium'),
  palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).max(5).default([]),
  notes: z.string().max(300).default('')
})
export type VideoBrief = z.infer<typeof VideoBrief>

/** a reference picture placed in one scene as the picture itself, never redrawn by a model */
export const CraftMedia = z.object({
  refId: z.string(),
  file: z.string().regex(/^assets\/refs\/ref-\d{1,2}\.(jpg|png)$/),
  /** cover = full-bleed photo · frame = screenshot in a window frame · float = cut-out over the grid */
  fit: z.enum(['cover', 'frame', 'float']),
  width: z.number().int().positive(),
  height: z.number().int().positive()
})
export type CraftMedia = z.infer<typeof CraftMedia>

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

/** procedural background art for scenes with no picture behind them (static vector, cheap to render) */
export const BgStyle = z.enum(['grid', 'contours', 'rings', 'rays', 'blueprint', 'waves', 'spotlight'])
export type BgStyle = z.infer<typeof BgStyle>

export const SceneCraft = z.object({
  sceneId: z.string(),
  background: z.enum(['grid', 'plate']).default('grid'),
  /** which procedural background a grid scene wears (assigned by the app, not the director) */
  bgStyle: BgStyle.default('grid'),
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
  /** a reference picture shown as itself in this scene (placed by the app, never chosen by a model) */
  media: CraftMedia.optional(),
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

const Hex = z.string().regex(/^#[0-9a-f]{6}$/i)
const BrandFile = z.string().regex(/^assets\/brand\/[A-Za-z0-9._-]+\.png$/)

/** the brand kit chosen for this video: placed by the composer, never drawn by a model */
export const SpecBrand = z.object({
  kitId: z.string().max(60),
  name: z.string().max(60),
  tagline: z.string().max(60).default(''),
  colors: z.object({ primary: Hex, secondary: Hex.optional() }).optional(),
  fonts: z.object({ display: z.string().max(40).optional(), body: z.string().max(40).optional() }).optional(),
  /** project-relative transparent PNGs: one for dark backgrounds, one for light */
  logo: z.object({ onDark: BrandFile, onLight: BrandFile, aspect: z.number().positive() }).optional(),
  watermark: z.enum(['off', 'top-left', 'top-right']).default('top-right'),
  endCard: z.boolean().default(true)
})
export type SpecBrand = z.infer<typeof SpecBrand>

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
  /** an exact scene grid the person asked for (set by the engine, never the planner): every scene holds this length */
  sceneGrid: z.object({ count: z.number().int().positive(), sec: z.number().positive() }).optional(),
  /** narration voice + delivery direction (absent = chosen from the film look) */
  voice: z.object({ id: z.string(), tone: z.string().max(400) }).optional(),
  /** voice-first timing: measured narration takes; scene durations are fitted to them */
  voiceover: z.array(VoiceTake).default([]),
  /** directed mode: film design system + per-scene crafts (absent = classic template scenes) */
  design: FilmDesign.optional(),
  /** brand kit in effect (absent = unbranded) */
  brand: SpecBrand.optional(),
  /** reference pictures attached to this video, and the look read from the style ones */
  refs: z.array(RefImage).default([]),
  styleBrief: StyleBrief.optional(),
  /** the rhythm and structure learned from a reference video (confirmed by the person) */
  videoBrief: VideoBrief.optional(),
  crafts: z.array(SceneCraft).default([]),
  /** Model-authored vector scenes; markup is validated before use. */
  customScenes: z.array(z.object({ sceneId: z.string(), svg: z.string().max(100000) })).optional(),
  /** A locally rendered, sandboxed custom-code scene and its retained source. */
  customVideos: z.array(z.object({ sceneId: z.string(), file: z.string(), source: z.string().max(50000) })).optional()
})
export type VideoSpec = z.infer<typeof VideoSpec>
