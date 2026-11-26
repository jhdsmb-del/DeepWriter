import { contextBridge, ipcRenderer } from 'electron'
import type { FloatingRunState } from '../shared/floating'

const floatingApi = {
  getState: (): Promise<FloatingRunState> => ipcRenderer.invoke('float:getState'),
  openMain: (): Promise<boolean> => ipcRenderer.invoke('float:openMain'),
  stop: (): Promise<boolean> => ipcRenderer.invoke('float:stop'),
  hide: (): Promise<boolean> => ipcRenderer.invoke('float:hide'),
  onState: (cb: (state: FloatingRunState) => void): (() => void) => {
    const listener = (_event: unknown, state: FloatingRunState): void => cb(state)
    ipcRenderer.on('float:state', listener)
    return () => ipcRenderer.removeListener('float:state', listener)
  }
}

contextBridge.exposeInMainWorld('dwFloat', floatingApi)

export type FloatingApi = typeof floatingApi
