import { contextBridge, ipcRenderer } from 'electron'

/**
 * Preload — typed, promise-based bridge. The renderer never touches Node;
 * every capability is an explicit channel here.
 */

const api = {
  generate: (opts: unknown) => ipcRenderer.invoke('gen:generate', opts),
  cancel: () => ipcRenderer.invoke('gen:cancel'),
  busy: () => ipcRenderer.invoke('gen:busy'),
  onEvent: (cb: (event: unknown) => void) => {
    const listener = (_e: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on('gen:event', listener)
    return () => ipcRenderer.removeListener('gen:event', listener)
  },
  listProjects: () => ipcRenderer.invoke('projects:list'),
  getProject: (id: string) => ipcRenderer.invoke('project:get', id),
  listProviders: () => ipcRenderer.invoke('providers:list'),
  listModels: (provider: string) => ipcRenderer.invoke('providers:models', provider),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
  hasKey: (provider: string) => ipcRenderer.invoke('settings:hasKey', provider),
  setKey: (provider: string, key: string) => ipcRenderer.invoke('settings:setKey', provider, key),
  clearKey: (provider: string) => ipcRenderer.invoke('settings:clearKey', provider)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
