import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * Preload — typed, promise-based bridge. The renderer never touches Node;
 * every capability is an explicit channel here.
 */

const api = {
  windowControls: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close')
  },
  generate: (opts: unknown) => ipcRenderer.invoke('gen:generate', opts),
  cancel: (projectId?: string) => ipcRenderer.invoke('gen:cancel', projectId),
  enhancePrompt: (req: unknown) => ipcRenderer.invoke('prompt:enhance', req),
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (t: unknown) => ipcRenderer.invoke('templates:save', t),
    remove: (id: string) => ipcRenderer.invoke('templates:remove', id)
  },
  busy: () => ipcRenderer.invoke('gen:busy'),
  jobs: () => ipcRenderer.invoke('gen:jobs'),
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('gen:event', listener)
    return () => ipcRenderer.removeListener('gen:event', listener)
  },
  onJobs: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('gen:jobs', listener)
    return () => ipcRenderer.removeListener('gen:jobs', listener)
  },
  onUsage: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('usage:entry', listener)
    return () => ipcRenderer.removeListener('usage:entry', listener)
  },
  onUsageRun: (cb: (payload: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('usage:run', listener)
    return () => ipcRenderer.removeListener('usage:run', listener)
  },
  getProjectUsage: (id: string) => ipcRenderer.invoke('project:usage', id),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (id: string) => ipcRenderer.invoke('project:get', id),
  deleteProject: (id: string) => ipcRenderer.invoke('project:delete', id),
  revealProject: (id: string, filePath?: string) => ipcRenderer.invoke('project:reveal', id, filePath),
  playProject: (id: string, filePath?: string) => ipcRenderer.invoke('project:play', id, filePath),
  applyEdit: (projectId: string, spec: unknown) => ipcRenderer.invoke('gen:applyEdit', projectId, spec),
  projectHistory: (id: string) => ipcRenderer.invoke('project:history', id),
  historySpec: (id: string, at: number) => ipcRenderer.invoke('project:historyGet', id, at),
  rerenderProject: (id: string) => ipcRenderer.invoke('gen:rerender', id),
  reviseScene: (projectId: string, sceneId: string, feedback: string) =>
    ipcRenderer.invoke('gen:revise', projectId, sceneId, feedback),
  resumeProject: (id: string) => ipcRenderer.invoke('gen:resume', id),
  getProjectState: (id: string) => ipcRenderer.invoke('project:state', id),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  listModels: (provider: string) => ipcRenderer.invoke('providers:models', provider),
  listImageModels: () => ipcRenderer.invoke('providers:image-models'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  hasKey: (provider: string) => ipcRenderer.invoke('settings:hasKey', provider),
  setKey: (provider: string, key: string) => ipcRenderer.invoke('settings:setKey', provider, key),
  clearKey: (provider: string) => ipcRenderer.invoke('settings:clearKey', provider),
  keyStatus: () => ipcRenderer.invoke('settings:keyStatus'),
  effectiveSettings: () => ipcRenderer.invoke('settings:effective'),
  account: {
    status: () => ipcRenderer.invoke('account:status'),
    signUp: (email: string, password: string) => ipcRenderer.invoke('account:signUp', email, password),
    signIn: (email: string, password: string) => ipcRenderer.invoke('account:signIn', email, password),
    signOut: () => ipcRenderer.invoke('account:signOut'),
    google: () => ipcRenderer.invoke('account:google'),
    plans: () => ipcRenderer.invoke('account:plans'),
    cancelGoogle: () => ipcRenderer.invoke('account:cancelGoogle'),
    refresh: () => ipcRenderer.invoke('account:refresh'),
    activate: (key: string) => ipcRenderer.invoke('account:activate', key),
    leave: () => ipcRenderer.invoke('account:leave'),
    removeDevice: (id: string) => ipcRenderer.invoke('account:removeDevice', id),
    resendVerification: () => ipcRenderer.invoke('account:resendVerification'),
    resetPassword: (email: string) => ipcRenderer.invoke('account:resetPassword', email),
    myRequests: () => ipcRenderer.invoke('account:myRequests'),
    requestUpgrade: (plan: string, seats: number) => ipcRenderer.invoke('account:requestUpgrade', plan, seats),
    sendMessage: (subject: string, body: string) => ipcRenderer.invoke('account:sendMessage', subject, body),
    cancelRequest: (id: string) => ipcRenderer.invoke('account:cancelRequest', id),
    dismissRequest: (id: string) => ipcRenderer.invoke('account:dismissRequest', id),
    onChange: (cb: (status: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('account:changed', listener)
      return () => ipcRenderer.removeListener('account:changed', listener)
    }
  },
  update: {
    version: () => ipcRenderer.invoke('update:version'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    openRelease: (url: string) => ipcRenderer.invoke('update:openRelease', url),
    onProgress: (cb: (p: { done: number; total: number }) => void) => {
      const listener = (_e: unknown, payload: { done: number; total: number }) => cb(payload)
      ipcRenderer.on('update:progress', listener)
      return () => ipcRenderer.removeListener('update:progress', listener)
    }
  },
  assets: {
    list: (q?: unknown) => ipcRenderer.invoke('assets:list', q),
    stats: () => ipcRenderer.invoke('assets:stats'),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('assets:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('assets:remove', id),
    reveal: (id: string) => ipcRenderer.invoke('assets:reveal', id),
    upload: (paths?: string[], tags?: string[]) => ipcRenderer.invoke('assets:upload', paths, tags),
    generate: (req: unknown) => ipcRenderer.invoke('assets:generate', req),
    exportPack: () => ipcRenderer.invoke('assets:exportPack'),
    importPack: () => ipcRenderer.invoke('assets:importPack'),
    /** real path of a dropped File (Electron removed File.path) */
    pathForFile: (f: File) => webUtils.getPathForFile(f)
  },
  footage: {
    status: () => ipcRenderer.invoke('footage:status'),
    capabilities: () => ipcRenderer.invoke('footage:capabilities'),
    list: () => ipcRenderer.invoke('footage:list'),
    get: (id: string) => ipcRenderer.invoke('footage:get', id),
    posters: (id: string) => ipcRenderer.invoke('footage:posters', id),
    pickFolders: () => ipcRenderer.invoke('footage:pickFolders'),
    pickMusic: () => ipcRenderer.invoke('footage:pickMusic'),
    create: (name: string, folders: string[]) => ipcRenderer.invoke('footage:create', name, folders),
    addFolders: (id: string, folders: string[]) => ipcRenderer.invoke('footage:addFolders', id, folders),
    removeFolder: (id: string, folder: string) => ipcRenderer.invoke('footage:removeFolder', id, folder),
    rename: (id: string, name: string) => ipcRenderer.invoke('footage:rename', id, name),
    scan: (id: string) => ipcRenderer.invoke('footage:scan', id),
    understand: (id: string) => ipcRenderer.invoke('footage:understand', id),
    estimate: (id: string) => ipcRenderer.invoke('footage:estimate', id),
    plan: (id: string, req: unknown) => ipcRenderer.invoke('footage:plan', id, req),
    tighten: (id: string, plan: unknown) => ipcRenderer.invoke('footage:tighten', id, plan),
    render: (id: string, plan: unknown, prompt: string) => ipcRenderer.invoke('footage:render', id, plan, prompt),
    cancel: () => ipcRenderer.invoke('footage:cancel'),
    removeEdit: (id: string, editId: string) => ipcRenderer.invoke('footage:removeEdit', id, editId),
    remove: (id: string) => ipcRenderer.invoke('footage:delete', id),
    play: (file: string) => ipcRenderer.invoke('footage:play', file),
    reveal: (file: string) => ipcRenderer.invoke('footage:reveal', file),
    onEvent: (cb: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('footage:event', listener)
      return () => ipcRenderer.removeListener('footage:event', listener)
    }
  },
  appRec: {
    state: () => ipcRenderer.invoke('apprec:state'),
    save: (app: unknown) => ipcRenderer.invoke('apprec:save', app),
    remove: (id: string) => ipcRenderer.invoke('apprec:remove', id),
    attach: () => ipcRenderer.invoke('apprec:attach'),
    start: (id: string, opts?: { reuse?: boolean }) => ipcRenderer.invoke('apprec:start', id, opts),
    pickStyle: (kind: 'images' | 'video') => ipcRenderer.invoke('apprec:pickStyle', kind),
    takeover: () => ipcRenderer.invoke('apprec:takeover'),
    cancel: () => ipcRenderer.invoke('apprec:cancel'),
    handoffDone: () => ipcRenderer.invoke('apprec:handoffDone'),
    review: (edits: unknown) => ipcRenderer.invoke('apprec:review', edits),
    play: (runId: string) => ipcRenderer.invoke('apprec:play', runId),
    reveal: (runId: string) => ipcRenderer.invoke('apprec:reveal', runId),
    revealRun: (runId: string) => ipcRenderer.invoke('apprec:revealRun', runId),
    onEvent: (cb: (event: unknown) => void) => {
      const listener = (_e: unknown, payload: unknown) => cb(payload)
      ipcRenderer.on('apprec:event', listener)
      return () => ipcRenderer.removeListener('apprec:event', listener)
    }
  },
  references: {
    inspect: (paths?: string[]) => ipcRenderer.invoke('refs:inspect', paths),
    readVideo: (req: unknown) => ipcRenderer.invoke('refs:readVideo', req)
  },
  brand: {
    list: () => ipcRenderer.invoke('brand:list'),
    create: (name: string) => ipcRenderer.invoke('brand:create', name),
    update: (id: string, patch: unknown) => ipcRenderer.invoke('brand:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('brand:remove', id),
    setLastUsed: (id: string) => ipcRenderer.invoke('brand:setLastUsed', id),
    setLogo: (id: string, path?: string, slot?: string) => ipcRenderer.invoke('brand:setLogo', id, path, slot),
    removeLogo: (id: string) => ipcRenderer.invoke('brand:removeLogo', id)
  },
  stock: {
    search: (kind: string, query: string, orientation?: string) => ipcRenderer.invoke('stock:search', kind, query, orientation),
    download: (r: unknown, tags?: string[]) => ipcRenderer.invoke('stock:download', r, tags)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
