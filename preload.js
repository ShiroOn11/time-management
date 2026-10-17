// Мост между окном и главным процессом: только то, что нужно приложению.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  exportData: (data) => ipcRenderer.invoke('data:export', data),
  importData: () => ipcRenderer.invoke('data:import'),
  updateTray: (title, timerRunning) => ipcRenderer.send('tray:update', title, timerRunning),
  on: (channel, fn) => {
    if (['quick-add', 'timer-stop', 'menu'].includes(channel)) {
      ipcRenderer.on(channel, (_e, ...args) => fn(...args));
    }
  },
});
