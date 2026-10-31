import type { PlatformId, Pacing } from './spec'

/**
 * Platform presets — targeted sense for each social platform.
 * Composition canvas is authored once at preset resolution; the render
 * service re-renders the same spec per platform.
 */

export interface PlatformPreset {
  id: PlatformId
  label: string
  width: number
  height: number
  aspectLabel: string
  /** Platform-natural duration range in seconds */
  durationRange: [number, number]
  defaultDuration: number
  fps: 24 | 30 | 60
  /** Safe-zone insets (px at preset resolution) where platform UI overlays live */
  safeZone: { top: number; bottom: number; left: number; right: number }
  captionPosition: 'top' | 'center' | 'bottom'
  pacingBias: Pacing
  notes: string
}

export const PLATFORM_PRESETS: Record<PlatformId, PlatformPreset> = {
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    width: 1080,
    height: 1920,
    aspectLabel: '9:16',
    durationRange: [8, 60],
    defaultDuration: 30,
    fps: 30,
    safeZone: { top: 220, bottom: 480, left: 60, right: 160 },
    captionPosition: 'center',
    pacingBias: 'frantic',
    notes: 'Hook must land in first 1.5s. Fast cuts, big captions, high energy.'
  },
  'youtube-shorts': {
    id: 'youtube-shorts',
    label: 'YouTube Shorts',
    width: 1080,
    height: 1920,
    aspectLabel: '9:16',
    durationRange: [8, 60],
    defaultDuration: 30,
    fps: 30,
    safeZone: { top: 180, bottom: 420, left: 60, right: 140 },
    captionPosition: 'center',
    pacingBias: 'energetic',
    notes: 'Like TikTok but slightly gentler; title visible in feed thumbnail.'
  },
  'instagram-reels': {
    id: 'instagram-reels',
    label: 'Instagram Reels',
    width: 1080,
    height: 1920,
    aspectLabel: '9:16',
    durationRange: [8, 90],
    defaultDuration: 30,
    fps: 30,
    safeZone: { top: 200, bottom: 440, left: 60, right: 140 },
    captionPosition: 'center',
    pacingBias: 'energetic',
    notes: 'Polished look; loop-friendly endings perform better.'
  },
  'instagram-feed': {
    id: 'instagram-feed',
    label: 'Instagram Feed',
    width: 1080,
    height: 1350,
    aspectLabel: '4:5',
    durationRange: [10, 60],
    defaultDuration: 30,
    fps: 30,
    safeZone: { top: 120, bottom: 200, left: 60, right: 60 },
    captionPosition: 'bottom',
    pacingBias: 'standard',
    notes: '4:5 portrait maximizes feed real estate; sound often off — strong captions.'
  },
  youtube: {
    id: 'youtube',
    label: 'YouTube',
    width: 1920,
    height: 1080,
    aspectLabel: '16:9',
    durationRange: [20, 300],
    defaultDuration: 60,
    fps: 30,
    safeZone: { top: 90, bottom: 120, left: 90, right: 380 },
    captionPosition: 'bottom',
    pacingBias: 'standard',
    notes: 'Landscape; end screen reserve bottom-right; retention-driven pacing.'
  },
  'facebook-feed': {
    id: 'facebook-feed',
    label: 'Facebook Feed',
    width: 1080,
    height: 1350,
    aspectLabel: '4:5',
    durationRange: [10, 90],
    defaultDuration: 30,
    fps: 30,
    safeZone: { top: 120, bottom: 220, left: 60, right: 60 },
    captionPosition: 'bottom',
    pacingBias: 'calm',
    notes: 'Sound-off viewing dominates; subtitles mandatory, calmer pacing.'
  },
  square: {
    id: 'square',
    label: 'Square post',
    width: 1080,
    height: 1080,
    aspectLabel: '1:1',
    durationRange: [10, 90],
    defaultDuration: 30,
    fps: 30,
    safeZone: { top: 90, bottom: 150, left: 60, right: 60 },
    captionPosition: 'bottom',
    pacingBias: 'standard',
    notes: 'Square feed post (Instagram grid, X, LinkedIn, WhatsApp); sound often off — strong captions, centred composition.'
  }
}

export function listPlatformPresets(): PlatformPreset[] {
  return Object.values(PLATFORM_PRESETS)
}

/** Pacing drives scene duration scale and motion intensity in the composer. */
export const PACING_TUNING: Record<Pacing, { durationScale: number; motion: number }> = {
  calm: { durationScale: 1.35, motion: 0.55 },
  standard: { durationScale: 1.0, motion: 0.8 },
  energetic: { durationScale: 0.85, motion: 1.1 },
  frantic: { durationScale: 0.72, motion: 1.4 }
}
