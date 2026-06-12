const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gaiwenDesktop', {
  backupHistoryEntry: (entry) => ipcRenderer.invoke('history:backup-entry', entry),
  backupHistorySnapshot: (items) => ipcRenderer.invoke('history:backup-snapshot', items),
  openHistoryFolder: (items) => ipcRenderer.invoke('history:open-folder', items),
});
