import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { Buddy, StreamEvent } from '../shared/protocol';

const buddy: Buddy = {
  expand: open => ipcRenderer.invoke('buddy:expand', open),
  drag: phase => ipcRenderer.send('buddy:drag', phase),
  hide: () => ipcRenderer.send('buddy:hide'),
  quit: () => ipcRenderer.send('buddy:quit'),
  settings: provider => ipcRenderer.invoke('buddy:settings', provider),
  save: settings => ipcRenderer.invoke('buddy:save', settings),
  attach: file => {
    const path = webUtils.getPathForFile(file);
    if (!path) return Promise.reject(new Error('Choose a file saved on this computer.'));
    return ipcRenderer.invoke('buddy:attach', path);
  },
  remove: name => ipcRenderer.invoke('buddy:remove', name),
  chat: (id, messages, search) => ipcRenderer.invoke('buddy:chat', id, messages, search),
  cancel: () => ipcRenderer.send('buddy:cancel'),
  history: () => ipcRenderer.invoke('buddy:history'),
  saveHistory: history => ipcRenderer.invoke('buddy:saveHistory', history),
  clearHistory: () => ipcRenderer.invoke('buddy:clearHistory'),
  clipboard: () => ipcRenderer.invoke('buddy:clipboard'),
  onChunk: callback => {
    const listener = (_event: Electron.IpcRendererEvent, chunk: StreamEvent) => callback(chunk);
    ipcRenderer.on('buddy:chunk', listener);
    return () => ipcRenderer.removeListener('buddy:chunk', listener);
  },
  onOpen: callback => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean) => callback(open);
    ipcRenderer.on('buddy:open', listener);
    return () => ipcRenderer.removeListener('buddy:open', listener);
  },
  onSelection: callback => {
    const listener = (_event: Electron.IpcRendererEvent, text: string) => callback(text);
    ipcRenderer.on('buddy:selection', listener);
    return () => ipcRenderer.removeListener('buddy:selection', listener);
  },
};
contextBridge.exposeInMainWorld('buddy', buddy);
