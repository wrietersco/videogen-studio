/** Typed access to the preload bridge + shared types re-declared for the renderer. */

import type { PipelineEvent } from '../../main/pipeline/orchestrator'
import type { ProjectMeta } from '../../main/store/projectStore'
import type { ProviderId, ModelInfo } from '../../main/providers/types'
import type { PlatformId, StyleFamily, VideoSpec } from '@shared/spec'

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
}

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
      listProjects: () => Promise<ProjectMeta[]>
      getProject: (id: string) => Promise<ProjectView>
      deleteProject: (id: string) => Promise<{ ok: boolean; error?: string }>
      revealProject: (id: string, filePath?: string) => Promise<boolean>
      rerenderProject: (id: string) => Promise<{ ok: boolean; error?: string }>
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
      hasKey: (provider: ProviderId) => Promise<boolean>
      setKey: (provider: ProviderId, key: string) => Promise<boolean>
      clearKey: (provider: ProviderId) => Promise<boolean>
    }
  }
}

export const api = window.api
