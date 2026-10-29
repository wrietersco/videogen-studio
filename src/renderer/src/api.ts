/** Typed access to the preload bridge + shared types re-declared for the renderer. */

import type { PipelineEvent } from '../../main/pipeline/orchestrator'
import type { ProjectMeta } from '../../main/store/projectStore'
import type { ProviderId, ModelInfo } from '../../main/providers/types'
import type { PlatformId, StyleFamily, VideoSpec } from '@shared/spec'
import type { UsageEntry, UsageRun, ProjectUsage } from '../../main/usage/meter'
import type { AssetKind, AssetMeta, AssetSource } from '@shared/assets'
import type { StockResult } from '../../main/media/stock'
import type { KeyId, MediaSettings } from '../../main/settings'

import type { UpdateInfo } from '../../main/updater'

export type { UpdateInfo }
export type { UsageEntry, UsageRun, ProjectUsage, AssetKind, AssetMeta, AssetSource, StockResult, KeyId, MediaSettings }
export type { PipelineEvent, ProjectMeta, ProviderId, ModelInfo, PlatformId, StyleFamily, VideoSpec }

export interface ProviderStatus {
  id: ProviderId
  label: string
  configured: boolean
  active: boolean
}

export interface SettingsView {
  provider: ProviderId
  /** per-provider model ids; keys are provider ids plus sub-keys like 'openai-image' */
  models: Record<string, string>
  quality: 'draft' | 'standard' | 'delivery'
  allowGpu: boolean
  craft: 'directed' | 'classic'
  media: MediaSettings
  reuse: 'smart' | 'fresh'
  sharing: 'local' | 'shareable'
}

export type Orientation = 'portrait' | 'landscape' | 'square'

export interface GenerateOptionsView {
  prompt: string
  platform: VideoSpec['platform']
  styleHint?: VideoSpec['style']
  durationHintSec?: number
}

export interface ProjectView {
  meta: ProjectMeta | null
  spec: VideoSpec | null
  html: string | null
  dir: string | null
  /** live-storyboard captures (data URLs), one per scene when available */
  thumbs: string[]
}

declare global {
  interface Window {
    api: {
      windowControls: {
        minimize: () => void
        toggleMaximize: () => void
        close: () => void
      }
      generate: (opts: GenerateOptionsView) => Promise<{ ok: boolean; error?: string }>
      cancel: () => Promise<boolean>
      busy: () => Promise<boolean>
      onEvent: (cb: (event: PipelineEvent) => void) => () => void
      onUsage: (cb: (p: { entry: UsageEntry; totalUsd: number; savedUsd: number }) => void) => () => void
      onUsageRun: (cb: (p: { projectId: string; run: UsageRun }) => void) => () => void
      getProjectUsage: (id: string) => Promise<ProjectUsage>
      listProjects: () => Promise<ProjectMeta[]>
      getProject: (id: string) => Promise<ProjectView>
      deleteProject: (id: string) => Promise<{ ok: boolean; error?: string }>
      revealProject: (id: string, filePath?: string) => Promise<boolean>
      playProject: (id: string, filePath?: string) => Promise<boolean>
      applyEdit: (projectId: string, spec: VideoSpec) => Promise<{ ok: boolean; error?: string }>
      projectHistory: (id: string) => Promise<Array<{ at: number; title: string; scenes: number; durationSec: number }>>
      historySpec: (id: string, at: number) => Promise<VideoSpec | null>
      rerenderProject: (id: string) => Promise<{ ok: boolean; error?: string }>
      reviseScene: (projectId: string, sceneId: string, feedback: string) => Promise<{ ok: boolean; error?: string }>
      resumeProject: (id: string) => Promise<{ ok: boolean; error?: string }>
      getProjectState: (id: string) => Promise<{
        version: number
        stages: Record<string, { status: string; detail?: string }>
        events: Array<{ at: string; text: string }>
        updatedAt: string
      }>
      listProviders: () => Promise<ProviderStatus[]>
      listModels: (provider: ProviderId) => Promise<ModelInfo[]>
      listImageModels: () => Promise<ModelInfo[]>
      getSettings: () => Promise<SettingsView>
      setSettings: (patch: Partial<SettingsView>) => Promise<boolean>
      hasKey: (provider: KeyId) => Promise<boolean>
      setKey: (provider: KeyId, key: string) => Promise<boolean>
      clearKey: (provider: KeyId) => Promise<boolean>
      keyStatus: () => Promise<Record<KeyId, boolean>>
      update: {
        version: () => Promise<string>
        check: () => Promise<{ ok: true; info: UpdateInfo } | { ok: false; error: string }>
        download: () => Promise<{ ok: true } | { ok: false; error: string }>
        install: () => Promise<{ ok: true } | { ok: false; error: string }>
        openRelease: (url: string) => Promise<void>
        onProgress: (cb: (p: { done: number; total: number }) => void) => () => void
      }
      assets: {
        list: (q?: { kind?: AssetKind; source?: AssetSource; query?: string }) => Promise<AssetMeta[]>
        stats: () => Promise<Record<AssetSource, number> & { total: number; bytes: number }>
        update: (id: string, patch: Partial<Pick<AssetMeta, 'title' | 'tags' | 'sharing' | 'favorite'>>) => Promise<AssetMeta | null>
        remove: (id: string) => Promise<boolean>
        reveal: (id: string) => Promise<boolean>
        upload: (paths?: string[], tags?: string[]) => Promise<{ added: AssetMeta[]; skipped: string[] }>
        generate: (req: { kind: 'image' | 'video' | 'voice' | 'music'; prompt: string; orientation?: Orientation; shots?: string[] }) => Promise<AssetMeta | null>
        exportPack: () => Promise<{ exported: number; folder?: string }>
        importPack: () => Promise<{ imported: number }>
        pathForFile: (f: File) => string
      }
      stock: {
        search: (kind: AssetKind, query: string, orientation?: Orientation) => Promise<{ results: StockResult[]; errors: string[] }>
        download: (r: StockResult, tags?: string[]) => Promise<AssetMeta>
      }
    }
  }
}

export const api = window.api
