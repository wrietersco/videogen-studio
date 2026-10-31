import type { PlatformId } from './spec'
import { PLATFORM_PRESETS } from './presets'

/**
 * Video shapes — aspect ratios in words people know. Many people do not know
 * "9:16" but do know "TikTok", so each shape lists the apps it suits and maps
 * back to a platform preset (the pipeline's single source of canvas size).
 */

export type ShapeId = '9:16' | '16:9' | '4:5' | '1:1'

export interface VideoShape {
  id: ShapeId
  label: string
  hint: string
  /** where this shape is used, in everyday names */
  apps: string[]
  /** preset used when someone picks the shape rather than an app */
  defaultPlatform: PlatformId
  /** the tiny frame drawn in the picker */
  frame: { w: number; h: number }
}

export const VIDEO_SHAPES: VideoShape[] = [
  { id: '9:16', label: 'Tall', hint: 'Fills a phone screen', apps: ['TikTok', 'Instagram Reels', 'YouTube Shorts', 'Stories', 'Snapchat'], defaultPlatform: 'tiktok', frame: { w: 18, h: 32 } },
  { id: '16:9', label: 'Wide', hint: 'Laptops, TVs, websites', apps: ['YouTube', 'Websites', 'Presentations', 'TV'], defaultPlatform: 'youtube', frame: { w: 32, h: 18 } },
  { id: '4:5', label: 'Portrait post', hint: 'Big in the feed', apps: ['Instagram post', 'Facebook feed', 'LinkedIn feed'], defaultPlatform: 'instagram-feed', frame: { w: 24, h: 30 } },
  { id: '1:1', label: 'Square', hint: 'Works almost anywhere', apps: ['Instagram grid', 'X / Twitter', 'LinkedIn', 'WhatsApp'], defaultPlatform: 'square', frame: { w: 26, h: 26 } }
]

export function shapeOf(platform: PlatformId): ShapeId {
  return PLATFORM_PRESETS[platform].aspectLabel as ShapeId
}

export function shapeById(id: ShapeId): VideoShape {
  return VIDEO_SHAPES.find((s) => s.id === id) ?? VIDEO_SHAPES[0]
}

/** keep the chosen app when it already has the shape, otherwise use the shape's own preset */
export function platformForShape(shape: ShapeId, current?: PlatformId): PlatformId {
  return current && shapeOf(current) === shape ? current : shapeById(shape).defaultPlatform
}
