const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('openClawPanel', {
  onStatus: (callback) => ipcRenderer.on('status', (_event, message) => callback(message)),
  onError: (callback) => ipcRenderer.on('startup-error', (_event, message) => callback(message)),
});
