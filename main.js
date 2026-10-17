// Главный процесс: окно, хранение данных на диске, строка меню, горячая клавиша.
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const QUICK_ADD_SHORTCUT = 'Alt+CommandOrControl+N';
const BACKUPS_KEPT = 30;

// Папка данных с латинским именем: ~/Library/Application Support/TimeManagement
app.setPath('userData', path.join(app.getPath('appData'), 'TimeManagement'));

let win = null;
let tray = null;
let quitting = false;

const dataDir = () => app.getPath('userData');
const dataFile = () => path.join(dataDir(), 'data.json');
const backupDir = () => path.join(dataDir(), 'backups');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function latestBackup() {
  if (!fs.existsSync(backupDir())) return null;
  const files = fs.readdirSync(backupDir()).filter((f) => f.endsWith('.json')).sort();
  return files.length ? path.join(backupDir(), files[files.length - 1]) : null;
}

function loadData() {
  if (!fs.existsSync(dataFile())) return null;
  try {
    return readJSON(dataFile());
  } catch (e) {
    // Файл повреждён: откладываем его в сторону и берём последнюю резервную копию.
    fs.renameSync(dataFile(), dataFile() + '.corrupt-' + Date.now());
    const backup = latestBackup();
    return backup ? readJSON(backup) : null;
  }
}

function dailyBackup() {
  fs.mkdirSync(backupDir(), { recursive: true });
  const name = 'data-' + new Date().toISOString().slice(0, 10) + '.json';
  const target = path.join(backupDir(), name);
  if (!fs.existsSync(target)) fs.copyFileSync(dataFile(), target);
  const files = fs.readdirSync(backupDir()).filter((f) => f.endsWith('.json')).sort();
  files.slice(0, Math.max(0, files.length - BACKUPS_KEPT)).forEach((f) => fs.unlinkSync(path.join(backupDir(), f)));
}

function saveData(data) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const tmp = dataFile() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, dataFile());
  dailyBackup();
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, ...args) {
  if (win) win.webContents.send(channel, ...args);
}

function quickAdd() {
  showWindow();
  send('quick-add');
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    title: 'Тайм-менеджмент',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f6f5f2',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Крестик прячет окно, а не закрывает: таймер в строке меню продолжает работать.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Тайм-менеджмент');
  updateTrayMenu(false);
}

function updateTrayMenu(timerRunning) {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть', click: showWindow },
      { label: 'Быстрая задача…', accelerator: QUICK_ADD_SHORTCUT, click: quickAdd },
      { label: 'Остановить таймер', enabled: timerRunning, click: () => send('timer-stop') },
      { type: 'separator' },
      { label: 'Выйти', role: 'quit' },
    ])
  );
}

function createMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'Файл',
      submenu: [
        { label: 'Быстрая задача…', accelerator: 'CommandOrControl+N', click: quickAdd },
        { type: 'separator' },
        { label: 'Экспорт данных…', click: () => send('menu', 'export') },
        { label: 'Импорт данных…', click: () => send('menu', 'import') },
        { label: 'Открыть папку с данными', click: () => shell.openPath(dataDir()) },
        { type: 'separator' },
        { role: 'close', label: 'Скрыть окно' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Вид',
      submenu: [
        { label: 'Сегодня', accelerator: 'CommandOrControl+1', click: () => send('menu', 'view:today') },
        { label: 'Задачи', accelerator: 'CommandOrControl+2', click: () => send('menu', 'view:tasks') },
        { label: 'Проекты', accelerator: 'CommandOrControl+3', click: () => send('menu', 'view:projects') },
        { label: 'Неделя', accelerator: 'CommandOrControl+4', click: () => send('menu', 'view:week') },
        { label: 'Итоги', accelerator: 'CommandOrControl+5', click: () => send('menu', 'view:review') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('data:load', () => loadData());
ipcMain.handle('data:save', (_e, data) => {
  saveData(data);
  return true;
});
ipcMain.handle('data:export', async (_e, data) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: 'time-management-' + new Date().toISOString().slice(0, 10) + '.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 1));
  return true;
});
ipcMain.handle('data:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  return readJSON(filePaths[0]);
});
ipcMain.on('tray:update', (_e, title, timerRunning) => {
  if (!tray) return;
  tray.setTitle(title || '');
  updateTrayMenu(!!timerRunning);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(() => {
    createMenu();
    createWindow();
    createTray();
    globalShortcut.register(QUICK_ADD_SHORTCUT, quickAdd);
  });
  app.on('activate', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
