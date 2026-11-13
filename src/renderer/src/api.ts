/** Typed access to the preload bridge + shared types re-declared for the renderer. */

import type { PipelineEvent } from '../../main/pipeline/orchestrator'
import type { ProjectMeta } from '../../main/store/projectStore'
import type { ProviderId, ModelInfo } from '../../main/providers/types'
import type { PlatformId, StyleFamily, VideoSpec } from '@shared/spec'
import type { UsageEntry, UsageRun, ProjectUsage } from '../../main/usage/meter'
import type { AssetKind, AssetMeta, AssetSource } from '@shared/assets'
import type { StockResult } from '../../main/media/stock'
import type { KeyId, MediaSettings } from '../../main/settings'
import type { ProviderRole, RoleRouting } from '@shared/providerRoles'

import type { UpdateInfo } from '../../main/updater'
import type { EditPlan, EditRecord, FootageEvent, FootageProject, FootageSummary, PlanRequest, PlanResult, UnderstandEstimate } from '@shared/footage'
import type { EnhancedPrompt, PromptSection, PromptTemplate } from '@shared/promptTemplates'
import type { AccountStatus } from '../../main/license/session'
import type { AccessMode } from '../../main/license/access'
import type { EntitlementView, PlanId, Policy } from '@shared/plans'
import type { BrandKitPatch, BrandKitView } from '@shared/brand'
import type { AppInput, ReviewBeat, ReviewEdits, RunEvent, RunRecord, SavedApp } from '@shared/appRecording'
export type { AppInput, ReviewBeat, ReviewEdits, RunEvent, RunRecord, SavedApp }
import type { RefRole, VideoBrief } from '@shared/spec'

export type { RefRole, VideoBrief }
export type VideoReadView = { ok: true; brief: VideoBrief; thumb: string; name: string } | { ok: false; error: string; cancelled?: boolean }
/** a picture picked for this video: path + the thumbnail and guesses shown on its chip */
export interface InspectedRefView {
  path: string
  name: string
  width: number
  height: number
  alpha: boolean
  suggestedRole: RefRole
  thumb: string
}
export type InspectResultView = { ok: true; item: InspectedRefView } | { ok: false; name: string; error: string }

export type { BrandKitPatch, BrandKitView }
export type BrandResult = { ok: true; kit: BrandKitView } | { ok: false; error: string; cancelled?: boolean }

export type { EntitlementView, PlanId, AccessMode }
export type AccountState = AccountStatus & { mode: AccessMode }
export type AccountResult =
  | { ok: true; status: AccountState }
  | { ok: false; code: string; error: string; devices?: Array<{ id: string; name: string; platform: string; appVersion: string; lastSeenAt: string }> }

import type { MyRequest } from '@shared/requests'
export type { MyRequest }
export type RequestsResult = { ok: true; requests: MyRequest[] } | { ok: false; code: string; error: string }

export type { EditPlan, EditRecord, FootageEvent, FootageProject, FootageSummary, PlanRequest, PlanResult, UnderstandEstimate }
export type { UpdateInfo, EnhancedPrompt, PromptSection, PromptTemplate }
export type { UsageEntry, UsageRun, ProjectUsage, AssetKind, AssetMeta, AssetSource, StockResult, KeyId, MediaSettings }
export type { PipelineEvent, ProjectMeta, ProviderId, ModelInfo, PlatformId, StyleFamily, VideoSpec }
export type { ProviderRole, RoleRouting } from '@shared/providerRoles'
export { ALL_ROLES, PROVIDER_CAPABILITIES, ROLE_LABELS, enforceExclusive, roleOwners, ROLE_PRIORITY } from '@shared/providerRoles'

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
  /** which provider may do what (Settings → Who does what) */
  roles: Partial<Record<ProviderId, ProviderRole[]>>
  /** ordered candidates or one owner per role */
  roleMode: RoleRouting
  quality: 'draft' | 'standard' | 'delivery'
  allowGpu: boolean
  craft: 'directed' | 'classic'
  media: MediaSettings
  reuse: 'smart' | 'fresh'
  sharing: 'local' | 'shareable'
  autopilot: boolean
  /** use own provider keys instead of the plan (only when the licence allows it) */
  useOwnKeys: boolean
}

export type Orientation = 'portrait' | 'landscape' | 'square'

export interface GenerateOptionsView {
  prompt: string
  platform: VideoSpec['platform']
  styleHint?: VideoSpec['style']
  durationHintSec?: number
  /** an exact scene grid the person asked for: this many scenes, each this long */
  sceneCount?: number
  sceneSec?: number
  /** the person picked the shape; autopilot may change the app, never the shape */
  shapeLocked?: boolean
  /** make it without AI (free, unlimited, not counted) */
  programmatic?: boolean
  /** brand kit for this video ('' = none) */
  brandKitId?: string
  /** pictures attached to this video, each with the role the person confirmed */
  references?: Array<{ path: string; role: RefRole; note?: string }>
  /** what a reference video taught the app, as confirmed on the Create screen */
  video?: VideoBrief
  /** where the logo goes for this video only (confirmed from the prompt) */
  brandOverride?: { watermark?: 'off' | 'top-left' | 'top-right'; endCard?: boolean }
}

export interface EnhanceRequestView {
  idea: string
  platform?: PlatformId
  styleHint?: StyleFamily
  durationSec?: number
  sections?: PromptSection[]
}

export interface TemplateInputView {
  name: string
  emoji?: string
  sections: PromptSection[]
  platform?: PlatformId
  style?: StyleFamily
  durationSec?: number
}

export interface ProjectView {
  meta: ProjectMeta | null
  spec: VideoSpec | null
  html: string | null
  dir: string | null
  /** live-storyboard captures (data URLs), one per scene when available */
  thumbs: string[]
}

/** one in-flight generation job (gen:jobs) */
export interface JobInfo {
  id: string
  projectId: string | null
  title: string
  kind: 'generate' | 'revise' | 'rerender' | 'resume' | 'library' | 'footage' | 'app-recording'
  startedAt: string
}

/** pipeline events gain the job they belong to */
export type JobEvent = PipelineEvent & { projectId?: string | null; jobId?: string }

declare global {
  interface Window {
    api: {
      windowControls: {
        minimize: () => void
        toggleMaximize: () => void
        close: () => void
      }
      generate: (opts: GenerateOptionsView) => Promise<{ ok: boolean; error?: string; code?: string }>
      /** stop one project's job, or the newest one when no project is given */
      cancel: (projectId?: string) => Promise<boolean>
      enhancePrompt: (req: EnhanceRequestView) => Promise<{ ok: true; result: EnhancedPrompt } | { ok: false; error: string }>
      templates: {
        list: () => Promise<PromptTemplate[]>
        save: (t: TemplateInputView) => Promise<{ ok: true; template: PromptTemplate } | { ok: false; error: string }>
        remove: (id: string) => Promise<boolean>
      }
      busy: () => Promise<boolean>
      jobs: () => Promise<JobInfo[]>
      onEvent: (cb: (event: JobEvent) => void) => () => void
      onJobs: (cb: (jobs: JobInfo[]) => void) => () => void
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
      effectiveSettings: () => Promise<SettingsView & { mode: AccessMode }>
      account: {
        status: () => Promise<AccountState>
        signUp: (email: string, password: string) => Promise<AccountResult>
        signIn: (email: string, password: string) => Promise<AccountResult>
        signOut: () => Promise<AccountResult>
        /** opens Google sign-in in the system browser; resolves when the person finishes there */
        google: () => Promise<AccountResult>
        cancelGoogle: () => Promise<void>
        /** live plans from the server, null when offline */
        plans: () => Promise<{ plans: Policy['plans']; trial: Policy['trial'] } | null>
        refresh: () => Promise<AccountResult>
        activate: (key: string) => Promise<AccountResult>
        leave: () => Promise<AccountResult>
        removeDevice: (id: string) => Promise<AccountResult>
        resendVerification: () => Promise<{ ok: true } | { ok: false; code: string; error: string }>
        resetPassword: (email: string) => Promise<{ ok: true } | { ok: false; code: string; error: string }>
        /** this account's open requests and unseen outcomes */
        myRequests: () => Promise<RequestsResult>
        /** one click: ask for a plan; replaces any earlier open upgrade request */
        requestUpgrade: (plan: PlanId, seats: number) => Promise<RequestsResult>
        sendMessage: (subject: string, body: string) => Promise<RequestsResult>
        cancelRequest: (id: string) => Promise<RequestsResult>
        dismissRequest: (id: string) => Promise<RequestsResult>
        onChange: (cb: (status: AccountState) => void) => () => void
      }
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
      footage: {
        status: () => Promise<{ projectId: string; kind: 'scan' | 'understand' | 'render' } | null>
        capabilities: () => Promise<{ ai: boolean }>
        list: () => Promise<FootageSummary[]>
        get: (id: string) => Promise<FootageProject | null>
        posters: (id: string) => Promise<Record<string, string>>
        pickFolders: () => Promise<string[]>
        pickMusic: () => Promise<string | null>
        create: (name: string, folders: string[]) => Promise<{ ok: true; project: FootageProject } | { ok: false; error: string }>
        addFolders: (id: string, folders: string[]) => Promise<{ ok: true; project: FootageProject } | { ok: false; error: string }>
        removeFolder: (id: string, folder: string) => Promise<{ ok: true; project: FootageProject } | { ok: false; error: string }>
        rename: (id: string, name: string) => Promise<{ ok: true; project: FootageProject } | { ok: false; error: string }>
        scan: (id: string) => Promise<{ ok: boolean; error?: string }>
        understand: (id: string) => Promise<{ ok: boolean; error?: string }>
        estimate: (id: string) => Promise<UnderstandEstimate>
        plan: (id: string, req: PlanRequest) => Promise<{ ok: true; result: PlanResult } | { ok: false; error: string }>
        tighten: (id: string, plan: EditPlan) => Promise<{ ok: true; result: { plan: EditPlan; removedSec: number; thumbs: string[] } } | { ok: false; error: string }>
        render: (id: string, plan: EditPlan, prompt: string) => Promise<{ ok: boolean; error?: string }>
        cancel: () => Promise<boolean>
        removeEdit: (id: string, editId: string) => Promise<boolean>
        remove: (id: string) => Promise<{ ok: boolean; error?: string }>
        play: (file: string) => Promise<boolean>
        reveal: (file: string) => Promise<boolean>
        onEvent: (cb: (event: FootageEvent) => void) => () => void
      }
      appRec: {
        state: () => Promise<{ apps: SavedApp[]; runs: RunRecord[]; ai: { available: boolean; reason?: string }; current: { runId: string; appId: string } | null }>
        save: (app: AppInput) => Promise<{ ok: true; app: SavedApp } | { ok: false; error: string }>
        remove: (id: string) => Promise<{ ok: boolean; error?: string }>
        attach: () => Promise<{ ok: true; document: { name: string; text: string } } | { ok: false; error: string; cancelled?: boolean }>
        start: (id: string, opts?: { reuse?: boolean }) => Promise<{ ok: true; runId: string } | { ok: false; error: string }>
        pickStyle: (kind: 'images' | 'video') => Promise<{ ok: true; paths: string[] } | { ok: false; cancelled: true }>
        takeover: () => Promise<boolean>
        cancel: () => Promise<boolean>
        handoffDone: () => Promise<boolean>
        review: (edits: ReviewEdits | null) => Promise<boolean>
        play: (runId: string) => Promise<boolean>
        reveal: (runId: string) => Promise<boolean>
        revealRun: (runId: string) => Promise<boolean>
        onEvent: (cb: (event: RunEvent) => void) => () => void
      }
      references: {
        /** no paths opens a picker; dropped files pass their paths */
        inspect: (paths?: string[]) => Promise<InspectResultView[]>
        /** a YouTube link is read by the AI; a video file (path, or a picker) is measured here */
        readVideo: (req: { kind: 'youtube'; url: string } | { kind: 'file'; path?: string }) => Promise<VideoReadView>
      }
      brand: {
        list: () => Promise<{ kits: BrandKitView[]; lastUsedId: string }>
        create: (name: string) => Promise<BrandResult>
        update: (id: string, patch: BrandKitPatch) => Promise<BrandResult>
        remove: (id: string) => Promise<boolean>
        /** remember the kit new videos start with ('' = no brand) */
        setLastUsed: (id: string) => Promise<boolean>
        /** no path opens a file picker; a slot replaces just that version */
        setLogo: (id: string, path?: string, slot?: 'onDark' | 'onLight') => Promise<BrandResult>
        removeLogo: (id: string) => Promise<BrandResult>
      }
      stock: {
        search: (kind: AssetKind, query: string, orientation?: Orientation) => Promise<{ results: StockResult[]; errors: string[] }>
        download: (r: StockResult, tags?: string[]) => Promise<AssetMeta>
      }
    }
  }
}

export const api = window.api
