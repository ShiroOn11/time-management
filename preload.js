// Мост между окном и главным процессом: только то, что нужно приложению.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  exportData: (data) => ipcRenderer.invoke('data:export', data),
  importData: () => ipcRenderer.invoke('data:import'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: (url) => ipcRenderer.invoke('update:install', url),
  version: () => ipcRenderer.invoke('app:version'),
  openItem: (value) => ipcRenderer.invoke('item:open', value),
  revealItem: (value) => ipcRenderer.invoke('item:reveal', value),
  // Путь к файлу, перетащенному из Finder.
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path || ''),
  attachDir: () => ipcRenderer.invoke('attach:dir'),
  attachCopy: (src) => ipcRenderer.invoke('attach:copy', src),
  attachSave: (bytes, ext, name) => ipcRenderer.invoke('attach:save', bytes, ext, name),
  attachPick: () => ipcRenderer.invoke('attach:pick'),
  attachOpen: (file) => ipcRenderer.invoke('attach:open', file),
  attachDelete: (file) => ipcRenderer.invoke('attach:delete', file),
  updateTray: (title, timerRunning) => ipcRenderer.send('tray:update', title, timerRunning),
  on: (channel, fn) => {
    if (['quick-add', 'timer-stop', 'menu', 'update:progress'].includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => fn(...args));
    }
  },
});
