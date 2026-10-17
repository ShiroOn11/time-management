// Главный процесс: окно, хранение данных на диске, строка меню, горячая клавиша.
const { app, BrowserWindow, ipcMain, dialog, globalShortcut, Tray, Menu, nativeImage, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

const QUICK_ADD_SHORTCUT = 'Alt+CommandOrControl+N';
const BACKUPS_KEPT = 30;
const REPO = 'ShiroOn11/time-management';

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
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
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
        { label: 'Проверить обновления…', click: () => send('menu', 'update') },
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
        { label: 'Как пользоваться', accelerator: 'CommandOrControl+/', click: () => send('menu', 'view:guide') },
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
// ---------- автообновление ----------
// Новая версия берётся из GitHub Releases: скачиваем .dmg, подменяем приложение и перезапускаем.
// Данные лежат отдельно (Application Support), поэтому при обновлении не теряются.

function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function checkUpdate() {
  const current = app.getVersion();
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'time-management-app' },
    });
    if (res.status === 404) return { ok: false, current, reason: 'private' };
    if (!res.ok) return { ok: false, current, reason: 'http ' + res.status };
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => a.name.endsWith('.dmg'));
    const m = asset && asset.name.match(/(\d+\.\d+\.\d+)/);
    if (!m) return { ok: false, current, reason: 'noasset' };
    return { ok: true, current, latest: m[1], available: newer(m[1], current), url: asset.browser_download_url, size: asset.size };
  } catch (e) {
    return { ok: false, current, reason: 'offline' };
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function installUpdate(url) {
  const bundle = path.resolve(app.getPath('exe'), '..', '..', '..');
  if (!bundle.endsWith('.app') || bundle.startsWith('/Volumes/')) {
    throw new Error('Приложение запущено не из «Программ». Перетащите его в «Программы» и откройте оттуда.');
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-update-'));
  const dmg = path.join(dir, 'update.dmg');
  const res = await net.fetch(url, { headers: { 'User-Agent': 'time-management-app' } });
  if (!res.ok) throw new Error('Не удалось скачать обновление (' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dmg);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.write(Buffer.from(value));
    got += value.length;
    if (total) send('update:progress', Math.round((got / total) * 100));
  }
  await new Promise((r) => out.end(r));
  const mnt = path.join(dir, 'mnt');
  await run('hdiutil', ['attach', '-nobrowse', '-noverify', '-noautoopen', '-mountpoint', mnt, dmg]);
  const src = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
  if (!src) throw new Error('В обновлении нет приложения');
  // Скрипт ждёт выхода приложения, заменяет его новой версией и запускает снова.
  const script = path.join(dir, 'install.sh');
  fs.writeFileSync(script, [
    '#!/bin/bash',
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done`,
    `rm -rf "${bundle}.new"`,
    `if ditto "${path.join(mnt, src)}" "${bundle}.new"; then`,
    `  rm -rf "${bundle}" && mv "${bundle}.new" "${bundle}"`,
    'fi',
    `xattr -cr "${bundle}"`,
    `hdiutil detach "${mnt}" -quiet`,
    `open "${bundle}"`,
    `rm -rf "${dir}"`,
  ].join('\n'));
  fs.chmodSync(script, 0o755);
  spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
  quitting = true;
  app.quit();
}

ipcMain.handle('update:check', () => checkUpdate());
ipcMain.handle('update:install', async (_e, url) => {
  try {
    await installUpdate(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('app:version', () => app.getVersion());

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
    // Самопроверка автообновления в CI: найти новую версию и сразу установить.
    if (process.env.TM_UPDATE_SELFTEST) {
      checkUpdate().then((u) => {
        console.log('selftest check', JSON.stringify(u));
        if (!u.available) return app.exit(2);
        installUpdate(u.url).catch((e) => {
          console.log('selftest error', e.message);
          app.exit(1);
        });
      });
    }
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
