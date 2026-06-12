/* =================================================================
 *  改文 · 桌面客户端  ——  Electron 主进程
 *
 *  这个文件负责"开窗"：创建一个桌面窗口，把 renderer/index.html
 *  那张网页装进去显示。你平时改界面只需要改那张网页，这个文件基本
 *  不用动。
 * ================================================================= */

const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let updateReady = false;

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    console.warn('[auto-update] error:', err && (err.stack || err.message || err));
  });

  autoUpdater.on('update-downloaded', async () => {
    if (updateReady) return;
    updateReady = true;

    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['立即重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '发现新版本',
      message: '新版本已下载完成',
      detail: '重启后会自动安装更新。也可以稍后关闭软件时自动安装。',
    });

    if (choice.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });
}

function checkForUpdatesSoon() {
  // 开发模式不检查更新,避免 npm start 时因为没有打包信息而报错。
  if (!app.isPackaged) return;
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[auto-update] check failed:', err && (err.stack || err.message || err));
    });
  }, 3000);
}

function safeFileName(name, fallback) {
  return String(name || fallback || '未命名')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90) || fallback || '未命名';
}

function safeNamePart(name, fallback, maxLen = 64) {
  const clean = safeFileName(name, fallback);
  return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
}

function dateStamp(ms) {
  const d = new Date(Number(ms) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    '-',
    pad(d.getHours()),
    pad(d.getMinutes()),
    pad(d.getSeconds()),
  ].join('');
}

function historyBackupRoot() {
  return path.join(app.getPath('documents'), '改文历史备份');
}

function findHistoryEntryDir(root, id) {
  if (!id || !fs.existsSync(root)) return null;
  const prefix = `${id}-`;
  const found = fs.readdirSync(root, { withFileTypes: true })
    .find((item) => item.isDirectory() && item.name.startsWith(prefix));
  return found ? path.join(root, found.name) : null;
}

function historyEntryDir(entry) {
  const root = historyBackupRoot();
  fs.mkdirSync(root, { recursive: true });
  const id = String(entry && entry.id ? entry.id : Date.now());
  const existing = findHistoryEntryDir(root, id);
  if (existing) return existing;
  const title = safeNamePart(entry && entry.title, '无标题');
  return path.join(root, `${id}-${dateStamp(entry && (entry.updatedTs || entry.ts || entry.id))}-${title}`);
}

function writeTextFile(file, text) {
  fs.writeFileSync(file, String(text || ''), 'utf8');
}

function backupHistoryEntryToDisk(entry) {
  if (!entry || !entry.id) throw new Error('缺少历史记录 ID');
  const dir = historyEntryDir(entry);
  fs.mkdirSync(dir, { recursive: true });

  const meta = [
    `标题: ${entry.title || '无标题'}`,
    `创建时间: ${new Date(entry.ts || entry.id || Date.now()).toLocaleString()}`,
    `更新时间: ${new Date(entry.updatedTs || entry.ts || entry.id || Date.now()).toLocaleString()}`,
    `轮次: ${entry.rounds || 1}`,
    `积分: ${entry.points || 0}`,
    `阶段: ${entry.phase || ''}`,
  ].join('\n');

  writeTextFile(path.join(dir, '说明.txt'), meta);
  writeTextFile(path.join(dir, '原文.txt'), entry.original || '');
  writeTextFile(path.join(dir, '改后.txt'), entry.revised || '');
  writeTextFile(path.join(dir, '继续上下文.txt'), [
    'lastRouterOutput:',
    entry.lastRouterOutput || '',
    '',
    'routerContent:',
    entry.routerContent || '',
    '',
    'userConversation:',
    entry.userConversation || '',
  ].join('\n'));
  writeTextFile(path.join(dir, 'history.json'), JSON.stringify(entry, null, 2));
  return dir;
}

function backupHistorySnapshotToDisk(items) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  const root = historyBackupRoot();
  fs.mkdirSync(root, { recursive: true });
  let count = 0;
  for (const entry of arr) {
    try {
      backupHistoryEntryToDisk(entry);
      count += 1;
    } catch (err) {
      console.warn('[history-backup] entry failed:', err && (err.stack || err.message || err));
    }
  }
  writeTextFile(path.join(root, '全部历史索引.json'), JSON.stringify(arr, null, 2));
  return { root, count };
}

function setupHistoryIpc() {
  ipcMain.handle('history:backup-entry', (_event, entry) => {
    try {
      const dir = backupHistoryEntryToDisk(entry);
      return { ok: true, path: dir };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('history:backup-snapshot', (_event, items) => {
    try {
      return { ok: true, ...backupHistorySnapshotToDisk(items) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('history:open-folder', async (_event, items) => {
    try {
      if (Array.isArray(items)) backupHistorySnapshotToDisk(items);
      const root = historyBackupRoot();
      fs.mkdirSync(root, { recursive: true });
      const error = await shell.openPath(root);
      return error ? { ok: false, error, path: root } : { ok: true, path: root };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#f4efe4',           // 和网页底色一致，开窗不闪白
    title: '改文 · 小说去AI味',
    autoHideMenuBar: true,                // 菜单栏默认隐藏，按 Alt 才出来，更像正经软件
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload-main.js'),

      // ↓↓↓ 关键设置 ↓↓↓
      // 关掉浏览器的同源策略（CORS）。因为这个桌面应用要直接调用你
      // 自己的后端接口（跨域请求），桌面端没有网页那种安全顾虑，
      // 关掉它接口才连得上。这是 Electron 桌面应用的常见做法。
      webSecurity: false,

      // 渲染层是纯网页（fetch / localStorage / DOM），不碰 Node，
      // 所以保持下面这两个安全默认值即可。
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // 装载界面（就是你那张 HTML）
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 网页里如果点到外部链接，用系统默认浏览器打开，而不是在 app 里乱跳
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------- 菜单 ----------
 * 保留复制/粘贴/全选、刷新、开发者工具这些常用项。
 * macOS 上剪贴板快捷键必须靠菜单注册，所以这个菜单是跨平台都要的。
 */
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 改文' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 改文' },
      ],
    }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    ...(isMac ? [] : [{
      label: '帮助',
      submenu: [
        { role: 'quit', label: '退出' },
      ],
    }]),
  ];

  return Menu.buildFromTemplate(template);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(buildMenu());
  setupAutoUpdater();
  setupHistoryIpc();
  createWindow();
  checkForUpdatesSoon();

  // macOS：点 Dock 图标且没有窗口时，重新开一个
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 关掉所有窗口就退出（macOS 习惯上留在 Dock，所以排除）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
