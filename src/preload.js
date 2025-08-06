// src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  openDbFile: (filePath) => ipcRenderer.invoke('open-db-file', filePath),
  createDbFile: () => ipcRenderer.invoke('create-db-file'),
  loadAllData: () => ipcRenderer.invoke('load-all-data'),
  updateAlias: (dsId, newAlias) => ipcRenderer.invoke('update-alias', { dsId, newAlias }),
  saveWorkflow: (workflowData) => ipcRenderer.invoke('save-workflow', workflowData),
  getRecentWorkspaces: () => ipcRenderer.invoke('get-recent-workspaces')
});