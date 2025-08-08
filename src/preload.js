// src/preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Functions the frontend can "call"
  openDbFile: (filePath) => ipcRenderer.invoke('open-db-file', filePath),
  createDbFile: () => ipcRenderer.invoke('create-db-file'),
  loadAllData: () => ipcRenderer.invoke('load-all-data'),
  updateAlias: (dsId, newAlias) => ipcRenderer.invoke('update-alias', { dsId, newAlias }),
  saveWorkflow: (workflowData) => ipcRenderer.invoke('save-workflow', workflowData),
  getRecentWorkspaces: () => ipcRenderer.invoke('get-recent-workspaces'),
  deleteWorkflow: (workflowId) => ipcRenderer.invoke('delete-workflow', workflowId),
  calculateCriticality: () => ipcRenderer.invoke('calculate-criticality'),
  getServerCredentials: () => ipcRenderer.invoke('get-server-credentials'),
  saveServerCredentials: (credentials) => ipcRenderer.invoke('save-server-credentials', credentials),
  fetchServerWorkflows: (credentials) => ipcRenderer.invoke('fetch-server-workflows', credentials),
  syncWithServer: (data) => ipcRenderer.invoke('sync-with-server', data),

  // Listeners the frontend can use for messages "pushed" from the backend
  onUpdateRecents: (callback) => ipcRenderer.on('update-recents', (event, ...args) => callback(...args)),
  onOpenRecentFile: (callback) => ipcRenderer.on('open-recent-file', (event, ...args) => callback(...args)),
  onSyncProgress: (callback) => ipcRenderer.on('sync-progress', (event, ...args) => callback(...args)),
});