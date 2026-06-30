const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('infoScraper', {
  getState: () => ipcRenderer.invoke('info-scraper:get-state'),
  saveSettings: (payload) => ipcRenderer.invoke('info-scraper:save-settings', payload),
  addAccounts: (payload) => ipcRenderer.invoke('info-scraper:add-accounts', payload),
  removeAccount: (accountId) => ipcRenderer.invoke('info-scraper:remove-account', accountId),
  toggleAccount: (payload) => ipcRenderer.invoke('info-scraper:toggle-account', payload),
  refresh: (payload) => ipcRenderer.invoke('info-scraper:refresh', payload),
  exportBilingualList: () => ipcRenderer.invoke('info-scraper:export-bilingual-list'),
  openLoginBrowser: (url) => ipcRenderer.invoke('info-scraper:open-login-browser', url),
  getLoginStatus: () => ipcRenderer.invoke('info-scraper:get-login-status'),
  getExtractorStatus: () => ipcRenderer.invoke('info-scraper:get-extractor-status'),
  openUrl: (url) => ipcRenderer.invoke('info-scraper:open-url', url),
  onEvent: (callback) => on('info-scraper:event', callback),
});
