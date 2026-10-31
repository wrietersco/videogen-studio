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
  cancel: () => ipcRenderer.invoke('gen:cancel'),
  enhancePrompt: (req: unknown) => ipcRenderer.invoke('prompt:enhance', req),
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (t: unknown) => ipcRenderer.invoke('templates:save', t),
    remove: (id: string) => ipcRenderer.invoke('templates:remove', id)
  },
  busy: () => ipcRenderer.invoke('gen:busy'),
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('gen:event', listener)
    return () => ipcRenderer.removeListener('gen:event', listener)
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
  stock: {
    search: (kind: string, query: string, orientation?: string) => ipcRenderer.invoke('stock:search', kind, query, orientation),
    download: (r: unknown, tags?: string[]) => ipcRenderer.invoke('stock:download', r, tags)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
