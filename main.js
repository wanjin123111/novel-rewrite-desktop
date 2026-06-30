/* =================================================================
 *  改文 · 桌面客户端  ——  Electron 主进程
 *
 *  支持自定义请求头（Cookie/Authorization）传递给 ffmpeg
 * ================================================================= */

const {
  app,
  BrowserWindow,
  BrowserView,
  Menu,
  dialog,
  shell,
  ipcMain,
  clipboard,
  session,
  net,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Blob } = require('buffer');

let bundledFfmpegPath = '';
try {
  bundledFfmpegPath = require('ffmpeg-static') || '';
} catch {}

let xlsx = null;
try {
  xlsx = require('xlsx');
} catch {}

let mainWindow = null;
let videoSnifferWindow = null;
let videoSnifferView = null;
let infoScraperWindow = null;
let infoScraperHiddenWindow = null;
let infoScraperHiddenView = null;
let infoScraperLoginWindow = null;
let infoScraperLoginStatusCache = {
  ok: true,
  loggedIn: false,
  hasTikTokCookies: false,
  cookieCount: 0,
  checkedAt: '',
  message: '未检测 TikTok 登录态',
};
let infoScraperPollTimer = null;
let infoScraperPolling = false;
let updateReady = false;

const VIDEO_SNIFFER_PARTITION = 'persist:gaiwen-video-sniffer';
const VIDEO_ANALYSIS_MODEL_ID = 73;
const INFO_SCRAPER_POLL_HOURS = [9, 21];
const LOCAL_VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv']);
const MEDIA_EXTS = new Set([
  'mp4', 'm4v', 'm3u8', 'm3u', 'mpd', 'm4s', 'ts', 'webm', 'flv', 'mov',
  'mkv', 'avi', 'wmv', 'asf', 'mpeg', 'mpg', 'mp3', 'm4a', 'aac', 'ogg',
  'ogv', 'opus', 'wav', 'weba',
]);
const MEDIA_MIME = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/mpegurl',
  'application/dash+xml',
  'application/ogg',
  'application/m4s',
]);
const MIME_EXT = {
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'application/mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
};

function youtubePlaybackInfo(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    if (!/(^|\.)googlevideo\.com$/i.test(u.hostname) || !/\/videoplayback\b/i.test(u.pathname)) {
      return null;
    }
    const mime = decodeURIComponent(u.searchParams.get('mime') || '').split(';')[0].trim().toLowerCase();
    const clen = Number(u.searchParams.get('clen')) || 0;
    return {
      ok: true,
      mime,
      ext: MIME_EXT[mime] || (mime.startsWith('video/') ? 'mp4' : mime.startsWith('audio/') ? 'm4a' : 'mp4'),
      size: clen,
    };
  } catch {
    return null;
  }
}

const snifferItems = new Map();
const snifferRequestHeaders = new Map();
const mergeJobs = new Map();
let pendingSnifferDownloadName = '';
let snifferSessionReady = false;

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
  if (!app.isPackaged) return;
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      console.warn('[auto-update] check failed:', err && (err.stack || err.message || err));
    });
  }, 3000);
}

function normalizeHeaderMap(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const v = Array.isArray(value) ? value.join('; ') : String(value || '');
    out[key.toLowerCase()] = v;
  }
  return out;
}

function extFromText(text) {
  const clean = String(text || '').split(/[?#]/)[0].toLowerCase();
  const m = clean.match(/\.([a-z0-9]{2,6})$/);
  return m ? m[1] : '';
}

function fileNameFromDisposition(disposition) {
  const text = String(disposition || '');
  const encoded = text.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) {
    try { return decodeURIComponent(encoded[1].replace(/"/g, '').trim()); }
    catch { return encoded[1].replace(/"/g, '').trim(); }
  }
  const plain = text.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1].trim() : '';
}

function safeFileName(name, fallback) {
  const picked = String(name || fallback || 'media').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return picked || 'media';
}

function safeNamePart(name, fallback, maxLen = 64) {
  return safeFileName(name, fallback).replace(/\s+/g, ' ').slice(0, maxLen).trim() || fallback;
}

function dateStamp(ms) {
  const d = new Date(Number(ms) || Date.now());
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function historyBackupRoot() {
  return path.join(app.getPath('documents'), '改文历史备份');
}

function findHistoryEntryDir(root, id) {
  if (!id || !fs.existsSync(root)) return '';
  const suffix = '_' + safeNamePart(id, 'history', 80);
  const found = fs.readdirSync(root, { withFileTypes: true })
    .find(x => x.isDirectory() && x.name.endsWith(suffix));
  return found ? path.join(root, found.name) : '';
}

function historyEntryDir(entry) {
  const root = historyBackupRoot();
  fs.mkdirSync(root, { recursive: true });
  const id = safeNamePart(String(entry && entry.id || Date.now()), 'history', 80);
  const existing = findHistoryEntryDir(root, id);
  if (existing) return existing;
  const title = safeNamePart(entry && entry.title || '无标题历史', '无标题历史', 56);
  const stamp = dateStamp(entry && (entry.ts || entry.id || entry.updatedTs));
  const dir = path.join(root, `${stamp}_${title}_${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTextFile(file, text) {
  fs.writeFileSync(file, String(text || ''), 'utf8');
}

function backupHistoryEntryToDisk(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const dir = historyEntryDir(entry);
  const title = entry.title || '无标题历史';
  const info = [
    '改文历史备份',
    '',
    '标题: ' + title,
    '创建时间: ' + new Date(Number(entry.ts || entry.id || Date.now())).toLocaleString(),
    '更新时间: ' + new Date(Number(entry.updatedTs || Date.now())).toLocaleString(),
    '轮次: ' + (entry.rounds || 1),
    '消耗积分: ' + (entry.points || 0),
    '',
    '说明:',
    '如果要把这一条历史回填进软件继续编辑: 打开软件的【历史】 -> 【导入/回填历史】 -> 选择本文件夹里的 history.json。',
    '如果要恢复全部历史: 返回上一级“改文历史备份”目录，选择 全部历史索引.json。',
    '原文.txt / 改后.txt 可直接查看内容。',
    '继续上下文.txt 保存继续编辑所需的上下文，界面历史异常时可作为排查和手工恢复依据。',
  ].join('\n');

  writeTextFile(path.join(dir, '说明.txt'), info);
  writeTextFile(path.join(dir, '原文.txt'), entry.original || '');
  writeTextFile(path.join(dir, '改后.txt'), entry.revised || entry.scriptSnapshot || '');
  writeTextFile(path.join(dir, '继续上下文.txt'), entry.routerContent || entry.userConversation || entry.lastRouterOutput || '');
  writeTextFile(path.join(dir, 'history.json'), JSON.stringify(entry, null, 2));
  return dir;
}

function backupHistorySnapshotToDisk(items) {
  const root = historyBackupRoot();
  fs.mkdirSync(root, { recursive: true });
  const arr = Array.isArray(items) ? items.filter(x => x && typeof x === 'object') : [];
  arr.forEach(backupHistoryEntryToDisk);
  writeTextFile(path.join(root, '全部历史索引.json'), JSON.stringify({
    app: 'gaiwen',
    type: 'history-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: arr.length,
    items: arr,
  }, null, 2));
  writeTextFile(path.join(root, '怎么恢复历史.txt'), [
    '改文历史恢复说明',
    '',
    '恢复全部历史:',
    '1. 打开软件，点【历史】。',
    '2. 点【导入/回填历史】。',
    '3. 选择本目录里的 全部历史索引.json。',
    '',
    '恢复某一条历史:',
    '1. 进入对应的历史文件夹。',
    '2. 选择里面的 history.json。',
    '3. 软件会自动把这条历史回填到编辑界面。',
  ].join('\n'));
  return { root, count: arr.length };
}

function guessFileName(url, disposition, ext) {
  const byHeader = fileNameFromDisposition(disposition);
  if (byHeader) return safeFileName(byHeader);
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    if (last) return safeFileName(last);
  } catch {}
  return safeFileName(ext ? `media.${ext}` : 'media');
}

function detectMediaResource(details) {
  const responseHeaders = normalizeHeaderMap(details.responseHeaders);
  const yt = youtubePlaybackInfo(details.url);
  const headerMime = (responseHeaders['content-type'] || '').split(';')[0].trim().toLowerCase();
  const mime = headerMime || (yt && yt.mime) || '';
  const disposition = responseHeaders['content-disposition'] || '';
  const nameFromHeader = fileNameFromDisposition(disposition);
  const ext = extFromText(details.url) || extFromText(nameFromHeader) || MIME_EXT[mime] || (yt && yt.ext) || '';
  const resourceType = String(details.resourceType || '').toLowerCase();
  const isMedia =
    !!yt ||
    resourceType === 'media' ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    MEDIA_MIME.has(mime) ||
    MEDIA_EXTS.has(ext);

  if (!isMedia) return null;

  const requestHeaders = normalizeHeaderMap(snifferRequestHeaders.get(details.id) || {});
  const id = crypto.createHash('sha1').update(details.url).digest('hex');

  return {
    id,
    url: details.url,
    method: details.method || 'GET',
    statusCode: details.statusCode || 0,
    resourceType,
    mime,
    ext: ext || (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'media'),
    size: Number(responseHeaders['content-length']) || (yt && yt.size) || 0,
    filename: guessFileName(details.url, disposition, ext),
    referer: requestHeaders.referer || '',
    userAgent: requestHeaders['user-agent'] || '',
    capturedAt: Date.now(),
  };
}

function publishSnifferItem(item) {
  if (videoSnifferView && !videoSnifferView.webContents.isDestroyed()) {
    item.pageUrl = videoSnifferView.webContents.getURL();
    item.pageTitle = videoSnifferView.webContents.getTitle();
  }
  const existing = snifferItems.get(item.id);
  const merged = existing ? { ...existing, ...item, capturedAt: existing.capturedAt } : item;
  snifferItems.set(item.id, merged);
  if (videoSnifferWindow && !videoSnifferWindow.isDestroyed()) {
    videoSnifferWindow.webContents.send('video-sniffer:item', merged);
  }
}

function setupVideoSnifferSession() {
  if (snifferSessionReady) return;
  snifferSessionReady = true;

  const ses = session.fromPartition(VIDEO_SNIFFER_PARTITION);
  const filter = { urls: ['http://*/*', 'https://*/*'] };

  ses.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    snifferRequestHeaders.set(details.id, details.requestHeaders || {});
    callback({ requestHeaders: details.requestHeaders || {} });
  });

  ses.webRequest.onHeadersReceived(filter, (details, callback) => {
    const item = detectMediaResource(details);
    if (item) publishSnifferItem(item);
    callback({ responseHeaders: details.responseHeaders || {} });
  });

  ses.webRequest.onCompleted(filter, (details) => {
    snifferRequestHeaders.delete(details.id);
  });

  ses.webRequest.onErrorOccurred(filter, (details) => {
    snifferRequestHeaders.delete(details.id);
  });

  ses.on('will-download', (event, item) => {
    const filename = safeFileName(pendingSnifferDownloadName || item.getFilename(), item.getFilename());
    pendingSnifferDownloadName = '';
    const target = dialog.showSaveDialogSync(videoSnifferWindow || mainWindow, {
      title: '保存媒体文件',
      defaultPath: path.join(app.getPath('downloads'), filename),
      buttonLabel: '保存',
    });
    if (!target) {
      item.cancel();
      return;
    }
    item.setSavePath(target);
    if (videoSnifferWindow && !videoSnifferWindow.isDestroyed()) {
      videoSnifferWindow.webContents.send('video-sniffer:download', { state: 'started', filename });
    }
    item.once('done', (_event, state) => {
      if (videoSnifferWindow && !videoSnifferWindow.isDestroyed()) {
        videoSnifferWindow.webContents.send('video-sniffer:download', { state, filename, path: target });
      }
    });
  });
}

function videosPath() {
  try { return app.getPath('videos'); }
  catch { return app.getPath('downloads'); }
}

function snifferConfigPath() {
  return path.join(app.getPath('userData'), 'video-sniffer-config.json');
}

function readSnifferConfig() {
  try {
    const file = snifferConfigPath();
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeSnifferConfig(config) {
  const file = snifferConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(config || {}, null, 2), 'utf8');
}

function ensureMp4Name(name) {
  const clean = safeFileName(String(name || 'episode').replace(/\.(m3u8|m3u|mpd|ts|m4s|mp4)$/i, ''), 'episode');
  return clean.toLowerCase().endsWith('.mp4') ? clean : clean + '.mp4';
}

function mergeHeaders(payload) {
  const headers = [];
  if (payload && payload.referer) headers.push('Referer: ' + payload.referer);
  if (payload && payload.userAgent) headers.push('User-Agent: ' + payload.userAgent);
  if (payload && payload.headers && typeof payload.headers === 'object') {
    for (const [key, value] of Object.entries(payload.headers)) {
      if (key && value) headers.push(key + ': ' + value);
    }
  }
  return headers.length ? headers.join('\r\n') + '\r\n' : '';
}

function writeConcatList(urls) {
  const dir = path.join(app.getPath('temp'), 'gaiwen-video-sniffer');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'segments-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt');
  const body = urls.map(url => "file '" + String(url || '').replace(/'/g, "\\'") + "'").join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function extFromUrlPath(rawUrl) {
  try {
    return path.extname(new URL(rawUrl).pathname).replace('.', '').toLowerCase();
  } catch {
    return extFromText(rawUrl);
  }
}

function buildFfmpegArgs(payload, outputPath) {
  const args = ['-hide_banner', '-y', '-nostdin'];
  const headers = mergeHeaders(payload);
  if (headers) args.push('-headers', headers);
  const networkInputArgs = () => [
    '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-analyzeduration', '100M',
    '-probesize', '100M',
    '-fflags', '+genpts',
  ];

  let cleanupPath = '';
  if (payload.mode === 'dual') {
    const videoUrl = String(payload.videoUrl || payload.url || '').trim();
    const audioUrl = String(payload.audioUrl || '').trim();
    if (!videoUrl && !audioUrl) throw new Error('没有可合成的 YouTube 音视频链接');
    if (videoUrl) args.push(...networkInputArgs(), '-i', videoUrl);
    if (audioUrl) {
      if (headers) args.push('-headers', headers);
      args.push(...networkInputArgs(), '-i', audioUrl);
    }
  } else if (payload.mode === 'segments') {
    if (payload.incomplete) {
      throw new Error('当前只抓到部分分片，不能保证一秒不丢。请先点“获取全集”或等待整集 m3u8 出现后再合成。');
    }
    const urls = Array.isArray(payload.urls) ? payload.urls.filter(Boolean) : [];
    if (!urls.length) throw new Error('没有可合成的分片链接');
    cleanupPath = writeConcatList(urls);
    args.push(
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-f', 'concat',
      '-safe', '0',
      '-i', cleanupPath
    );
  } else {
    if (!payload.url) throw new Error('没有可合成的 m3u8/mpd 链接');
    const inputExt = String(payload.ext || extFromUrlPath(payload.url) || extFromText(payload.filename) || '').toLowerCase();
    const isHls = inputExt === 'm3u8' || inputExt === 'm3u';
    args.push(...networkInputArgs());
    if (isHls) {
      args.push('-allowed_extensions', 'ALL');
    }
    args.push(
      '-i', payload.url
    );
  }

  if (payload.mode === 'dual') {
    const hasVideo = !!String(payload.videoUrl || payload.url || '').trim();
    const hasAudio = !!String(payload.audioUrl || '').trim();
    if (hasVideo) args.push('-map', '0:v:0?');
    if (hasAudio) args.push('-map', hasVideo ? '1:a:0?' : '0:a:0?');
    else args.push('-map', '0:a:0?');
  } else {
    args.push('-map', '0:v:0?', '-map', '0:a:0?');
  }
  args.push(
    '-ignore_unknown',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-max_muxing_queue_size', '4096',
    '-movflags', '+faststart',
    outputPath
  );
  return { args, cleanupPath };
}

function ffmpegExecutable() {
  if (bundledFfmpegPath) {
    return app.isPackaged
      ? bundledFfmpegPath.replace('app.asar', 'app.asar.unpacked')
      : bundledFfmpegPath;
  }
  return 'ffmpeg';
}

function parseMediaDurationSeconds(text) {
  const match = String(text || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function probeMediaDuration(filePath) {
  return new Promise((resolve) => {
    const target = String(filePath || '');
    if (!target || !fs.existsSync(target)) {
      resolve({ ok: false, error: '文件不存在' });
      return;
    }
    let tail = '';
    const child = spawn(ffmpegExecutable(), ['-hide_banner', '-i', target], { windowsHide: true });
    child.stderr.on('data', chunk => {
      tail = (tail + chunk.toString('utf8')).slice(-20000);
    });
    child.on('error', err => {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    child.on('close', () => {
      const duration = parseMediaDurationSeconds(tail);
      if (!duration) {
        resolve({ ok: false, error: '没有读到视频时长', raw: tail.slice(-1200) });
        return;
      }
      resolve({ ok: true, duration, path: target });
    });
  });
}

function uniqueDirPath(parentDir, dirName) {
  let target = path.join(parentDir, dirName);
  if (!fs.existsSync(target)) return target;
  for (let i = 2; i < 1000; i++) {
    target = path.join(parentDir, dirName + '-' + i);
    if (!fs.existsSync(target)) return target;
  }
  return path.join(parentDir, dirName + '-' + Date.now());
}

function removeDirIfEmpty(dir) {
  try {
    if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  } catch {}
}

async function splitLocalVideoFile(payload) {
  const sourcePath = String((payload && payload.filePath) || '');
  if (!sourcePath || !fs.existsSync(sourcePath)) return { ok: false, error: '视频文件不存在' };
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile()) return { ok: false, error: '请选择一个视频文件' };
  const ext = path.extname(sourcePath).toLowerCase();
  if (!LOCAL_VIDEO_EXTS.has(ext)) return { ok: false, error: '不支持的视频格式：' + ext };

  const rawSeconds = Number((payload && payload.segmentSeconds) || 0);
  const segmentSeconds = Math.max(30, Math.min(12 * 3600, Math.round(rawSeconds || 0)));
  if (!segmentSeconds) return { ok: false, error: '切分时长无效' };

  const parentDir = String((payload && payload.outputDir) || path.dirname(sourcePath));
  const baseName = safeFileName(path.basename(sourcePath, ext), '视频');
  const outputDir = uniqueDirPath(parentDir, baseName + '-切分');
  fs.mkdirSync(outputDir, { recursive: true });

  const outputExt = ext || '.mp4';
  const pattern = path.join(outputDir, baseName + '-part-%03d' + outputExt);
  const args = [
    '-hide_banner',
    '-y',
    '-i', sourcePath,
    '-map', '0',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-f', 'segment',
    '-segment_time', String(segmentSeconds),
    '-reset_timestamps', '1',
    pattern,
  ];

  return new Promise((resolve) => {
    let tail = '';
    let child;
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    try {
      child = spawn(ffmpegExecutable(), args, { windowsHide: true });
    } catch (err) {
      removeDirIfEmpty(outputDir);
      done({ ok: false, error: err && err.message ? err.message : String(err) });
      return;
    }
    child.stderr.on('data', chunk => {
      tail = (tail + chunk.toString('utf8')).slice(-6000);
    });
    child.on('error', err => {
      const missing = err && err.code === 'ENOENT';
      removeDirIfEmpty(outputDir);
      done({
        ok: false,
        error: missing ? '找不到 ffmpeg，无法切分视频' : (err && err.message ? err.message : String(err)),
      });
    });
    child.on('close', code => {
      if (code !== 0) {
        removeDirIfEmpty(outputDir);
        done({ ok: false, outputDir, error: 'ffmpeg 切分失败，退出码 ' + code + (tail ? '\n' + tail.slice(-1600) : '') });
        return;
      }
      const files = fs.readdirSync(outputDir)
        .filter(name => path.extname(name).toLowerCase() === outputExt)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
        .map(name => path.join(outputDir, name));
      if (!files.length) {
        removeDirIfEmpty(outputDir);
        done({ ok: false, outputDir, error: '切分完成但没有生成片段文件' });
        return;
      }
      done({
        ok: true,
        inputPath: sourcePath,
        outputDir,
        files,
        count: files.length,
        segmentSeconds,
      });
    });
  });
}

function sendMergeEvent(targetWebContents, payload) {
  if (targetWebContents && !targetWebContents.isDestroyed()) {
    targetWebContents.send('video-sniffer:merge', payload);
  }
}

function cancelMergeJobs() {
  let count = 0;
  for (const [jobId, job] of mergeJobs.entries()) {
    if (!job || !job.child || job.child.killed) continue;
    job.cancelled = true;
    count++;
    try {
      job.child.kill();
    } catch (err) {
      sendMergeEvent(job.sender, {
        jobId,
        state: 'error',
        message: '停止合成失败：' + (err && err.message ? err.message : String(err)),
      });
    }
  }
  return count;
}

function deletePartialOutput(outputPath) {
  try {
    const target = String(outputPath || '');
    if (target && fs.existsSync(target) && fs.statSync(target).isFile()) {
      fs.unlinkSync(target);
    }
  } catch {}
}

function pathInside(child, parent) {
  const childPath = path.resolve(String(child || ''));
  const parentPath = path.resolve(String(parent || ''));
  if (!childPath || !parentPath || childPath === parentPath) return false;
  const rel = path.relative(parentPath, childPath);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function removeEmptySnifferDir(payload) {
  const dir = typeof payload === 'string' ? payload : String((payload && payload.dir) || '');
  const rootFromPayload = typeof payload === 'object' && payload ? String(payload.rootDir || '') : '';
  const root = rootFromPayload || String((readSnifferConfig() || {}).downloadDir || '');
  if (!dir) return { ok: false, error: '目录为空' };
  if (!root) return { ok: false, error: '缺少总目录，拒绝删除' };
  const target = path.resolve(dir);
  const rootPath = path.resolve(root);
  if (!pathInside(target, rootPath)) return { ok: false, error: '目标不在总目录内，拒绝删除' };
  if (!fs.existsSync(target)) return { ok: true, missing: true };
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return { ok: false, error: '目标不是目录' };
  const entries = fs.readdirSync(target);
  const removableOnly = entries.length && entries.every(name => name === '来源链接.txt');
  if (entries.length && !removableOnly) return { ok: true, removed: false, kept: true, count: entries.length };
  if (removableOnly) {
    for (const name of entries) {
      try { fs.unlinkSync(path.join(target, name)); } catch {}
    }
  }
  fs.rmdirSync(target);
  return { ok: true, removed: true, path: target };
}

function sourceInfoLines(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const savedEpisodes = Array.isArray(source.savedEpisodes)
    ? source.savedEpisodes.map(n => Number(n) || 0).filter(Boolean).sort((a, b) => a - b)
    : [];
  const lines = [
    '剧名：' + String(source.title || '未命名剧'),
    '原始链接：' + String(source.originalUrl || source.url || ''),
    '抓取起始链接：' + String(source.startUrl || ''),
    '当前页面链接：' + String(source.currentUrl || ''),
    '保存目录：' + String(source.dir || ''),
    '保存时间：' + new Date().toLocaleString(),
  ];
  if (Number(source.savedTotal) > 0) lines.push('已保存集数：' + Number(source.savedTotal));
  if (savedEpisodes.length) lines.push('已保存集号：' + savedEpisodes.join('、'));
  if (source.importFile) lines.push('导入文件：' + String(source.importFile));
  if (source.sheetName) lines.push('表格/来源：' + String(source.sheetName));
  if (source.row || source.column) lines.push('表格位置：第 ' + String(source.row || '?') + ' 行，第 ' + String(source.column || '?') + ' 列');
  if (source.note) lines.push('备注：' + String(source.note));
  lines.push('');
  lines.push('说明：这个文件用于核对该文件夹对应哪一部剧、哪条链接，以及是否缺集。');
  return lines.join('\r\n');
}

function saveSnifferSourceInfo(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const dir = String(source.dir || '');
  if (!dir) return { ok: false, error: '缺少保存目录' };
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, '来源链接.txt');
  fs.writeFileSync(target, sourceInfoLines(source), 'utf8');
  return { ok: true, path: target };
}

function startMp4Merge(event, payload) {
  const sender = event.sender;
  const defaultName = ensureMp4Name(payload && (payload.filename || payload.title || payload.label));
  let outputPath = payload && payload.outputPath ? String(payload.outputPath) : '';
  if (outputPath) {
    if (!/\.mp4$/i.test(outputPath)) outputPath += '.mp4';
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } else {
    outputPath = dialog.showSaveDialogSync(videoSnifferWindow || mainWindow, {
      title: '保存合成 MP4',
      defaultPath: path.join(videosPath(), defaultName),
      buttonLabel: '开始合成',
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
    });
  }
  if (!outputPath) return { ok: false, canceled: true };

  let built;
  try {
    built = buildFfmpegArgs(payload || {}, outputPath);
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const child = spawn(ffmpegExecutable(), built.args, { windowsHide: true });
  mergeJobs.set(jobId, { child, sender, cleanupPath: built.cleanupPath, cancelled: false });
  let tail = '';

  sendMergeEvent(sender, { jobId, state: 'started', path: outputPath, message: '开始合成 MP4' });

  child.stderr.on('data', chunk => {
    const text = chunk.toString('utf8');
    tail = (tail + text).slice(-4000);
    const time = text.match(/time=(\S+)/);
    const speed = text.match(/speed=\s*(\S+)/);
    if (time || speed) {
      sendMergeEvent(sender, {
        jobId,
        state: 'progress',
        message: '合成中 ' + [time && ('time=' + time[1]), speed && ('speed=' + speed[1])].filter(Boolean).join(' · '),
      });
    }
  });

  child.on('error', err => {
    if (built.cleanupPath) fs.promises.unlink(built.cleanupPath).catch(() => {});
    deletePartialOutput(outputPath);
    mergeJobs.delete(jobId);
    const missing = err && err.code === 'ENOENT';
    sendMergeEvent(sender, {
      jobId,
      state: 'error',
      message: missing ? '找不到 ffmpeg。请先安装 ffmpeg，或让我做一个内置 ffmpeg 的安装包。' : (err.message || String(err)),
    });
  });

  child.on('close', code => {
    if (built.cleanupPath) fs.promises.unlink(built.cleanupPath).catch(() => {});
    const job = mergeJobs.get(jobId);
    mergeJobs.delete(jobId);
    if (job && job.cancelled) {
      deletePartialOutput(outputPath);
      sendMergeEvent(sender, { jobId, state: 'cancelled', path: outputPath, message: '已停止当前 MP4 合成' });
      return;
    }
    if (code === 0) {
      sendMergeEvent(sender, { jobId, state: 'completed', path: outputPath, message: 'MP4 合成完成' });
    } else {
      deletePartialOutput(outputPath);
      sendMergeEvent(sender, {
        jobId,
        state: 'error',
        message: 'ffmpeg 合成失败，退出码 ' + code + (tail ? '\n' + tail.slice(-1200) : ''),
      });
    }
  });

  return { ok: true, jobId, path: outputPath };
}

function sendSnifferBrowserState(extra = {}) {
  if (!videoSnifferWindow || videoSnifferWindow.isDestroyed() || !videoSnifferView) return;
  const wc = videoSnifferView.webContents;
  videoSnifferWindow.webContents.send('video-sniffer:browser-state', {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.canGoBack(),
    canGoForward: wc.canGoForward(),
    isLoading: wc.isLoading(),
    ...extra,
  });
}

function createVideoSnifferView() {
  videoSnifferView = new BrowserView({
    webPreferences: {
      partition: VIDEO_SNIFFER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  videoSnifferWindow.setBrowserView(videoSnifferView);
  videoSnifferView.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) videoSnifferView.webContents.loadURL(url);
    return { action: 'deny' };
  });
  videoSnifferView.webContents.on('did-start-loading', () => sendSnifferBrowserState({ isLoading: true }));
  videoSnifferView.webContents.on('did-stop-loading', () => sendSnifferBrowserState({ isLoading: false }));
  videoSnifferView.webContents.on('did-navigate', (_event, url) => sendSnifferBrowserState({ url }));
  videoSnifferView.webContents.on('did-navigate-in-page', (_event, url) => sendSnifferBrowserState({ url }));
  videoSnifferView.webContents.on('page-title-updated', (_event, title) => sendSnifferBrowserState({ title }));
  videoSnifferView.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    sendSnifferBrowserState({ url: validatedURL, error: `${errorCode}: ${errorDescription}` });
  });
}


function getInfoScraperSession() {
  setupVideoSnifferSession();
  return session.fromPartition(VIDEO_SNIFFER_PARTITION);
}

async function getInfoScraperLoginStatus() {
  try {
    const ses = getInfoScraperSession();
    const cookies = await ses.cookies.get({}).catch(() => []);
    const tiktokCookies = cookies.filter(cookie => /(^|\.)tiktok\.com$/i.test(String(cookie.domain || '').replace(/^\./, '')) || /tiktok\.com/i.test(String(cookie.domain || '')));
    const loginCookieNames = new Set([
      'sessionid',
      'sessionid_ss',
      'sid_guard',
      'sid_tt',
      'uid_tt',
      'uid_tt_ss',
      'sid_ucp_v1',
      'ssid_ucp_v1',
    ]);
    const loggedIn = tiktokCookies.some(cookie => loginCookieNames.has(String(cookie.name || '').toLowerCase()));
    const hasTikTokCookies = tiktokCookies.length > 0;
    const checkedAt = new Date().toISOString();
    return {
      ok: true,
      loggedIn,
      hasTikTokCookies,
      cookieCount: tiktokCookies.length,
      checkedAt,
      message: loggedIn
        ? '已检测到 TikTok 登录态，信息抓取会复用这个账号会话。'
        : hasTikTokCookies
          ? '已检测到 TikTok 会话 Cookie，但未确认登录；如作品不全，请点“登录 TikTok”手动登录。'
          : '未检测到 TikTok 登录态；如账号作品显示不全，请点“登录 TikTok”手动登录。',
    };
  } catch (err) {
    return {
      ok: false,
      loggedIn: false,
      hasTikTokCookies: false,
      cookieCount: 0,
      checkedAt: new Date().toISOString(),
      message: err && err.message ? err.message : String(err),
    };
  }
}

async function refreshInfoScraperLoginStatusCache(options = {}) {
  infoScraperLoginStatusCache = await getInfoScraperLoginStatus();
  if (options.notify) {
    sendInfoScraperEvent({
      type: infoScraperLoginStatusCache.loggedIn ? 'login' : 'login-warning',
      message: infoScraperLoginStatusCache.message,
    });
  }
  return infoScraperLoginStatusCache;
}

function createInfoScraperLoginWindow(rawUrl) {
  const targetUrl = normalizeNavigationUrl(rawUrl || 'https://www.tiktok.com/login');
  setupVideoSnifferSession();
  if (infoScraperLoginWindow && !infoScraperLoginWindow.isDestroyed()) {
    infoScraperLoginWindow.focus();
    if (targetUrl) infoScraperLoginWindow.webContents.loadURL(targetUrl).catch(() => {});
    return infoScraperLoginWindow;
  }

  infoScraperLoginWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: '改文 · TikTok 登录',
    autoHideMenuBar: true,
    backgroundColor: '#f4efe4',
    webPreferences: {
      partition: VIDEO_SNIFFER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  try { infoScraperLoginWindow.setMenuBarVisibility(false); } catch {}
  try {
    infoScraperLoginWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  } catch {}
  infoScraperLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) infoScraperLoginWindow.webContents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  const updateStatusQuietly = () => {
    refreshInfoScraperLoginStatusCache().catch(() => {});
  };
  infoScraperLoginWindow.webContents.on('did-finish-load', updateStatusQuietly);
  infoScraperLoginWindow.webContents.on('did-navigate', updateStatusQuietly);
  infoScraperLoginWindow.webContents.on('did-navigate-in-page', updateStatusQuietly);
  infoScraperLoginWindow.on('closed', () => {
    infoScraperLoginWindow = null;
    refreshInfoScraperLoginStatusCache({ notify: true }).catch(() => {});
  });
  infoScraperLoginWindow.loadURL(targetUrl).catch(() => {});
  return infoScraperLoginWindow;
}

function createInfoScraperHiddenBrowser() {
  setupVideoSnifferSession();
  if (infoScraperHiddenWindow && !infoScraperHiddenWindow.isDestroyed()) {
    return infoScraperHiddenWindow.webContents;
  }

  // Some video grids only finish lazy-loading in a real Chromium window.
  // Keep this window off-screen and almost transparent, but focusable so PageDown
  // and wheel events can drive TikTok/Douyin lazy lists without opening 视频抓取.
  infoScraperHiddenWindow = new BrowserWindow({
    width: 1365,
    height: 1000,
    x: -12000,
    y: -12000,
    show: true,
    skipTaskbar: true,
    focusable: true,
    opacity: 0.02,
    paintWhenInitiallyHidden: true,
    title: '改文 · 信息抓取后台浏览器',
    webPreferences: {
      partition: VIDEO_SNIFFER_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  infoScraperHiddenView = null;
  try { infoScraperHiddenWindow.setMenuBarVisibility(false); } catch {}
  try {
    infoScraperHiddenWindow.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
  } catch {}
  infoScraperHiddenWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) infoScraperHiddenWindow.webContents.loadURL(url);
    return { action: 'deny' };
  });
  infoScraperHiddenWindow.on('closed', () => {
    infoScraperHiddenWindow = null;
    infoScraperHiddenView = null;
  });
  return infoScraperHiddenWindow.webContents;
}

function getInfoScraperBrowserWebContents() {
  if (videoSnifferView && !videoSnifferView.webContents.isDestroyed()) return videoSnifferView.webContents;
  return createInfoScraperHiddenBrowser();
}

function createInfoScraperWindow() {
  if (infoScraperWindow && !infoScraperWindow.isDestroyed()) {
    infoScraperWindow.focus();
    return;
  }

  infoScraperWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    title: '改文 · 信息抓取',
    autoHideMenuBar: true,
    backgroundColor: '#f4efe4',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload-info-scraper.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  infoScraperWindow.loadFile(path.join(__dirname, 'renderer', 'info-scraper.html'));
  infoScraperWindow.on('closed', () => { infoScraperWindow = null; });
}

function createVideoSnifferWindow() {
  setupVideoSnifferSession();

  if (videoSnifferWindow && !videoSnifferWindow.isDestroyed()) {
    videoSnifferWindow.focus();
    return;
  }

  videoSnifferWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 660,
    title: '改文 · 视频抓取',
    autoHideMenuBar: true,
    backgroundColor: '#f4efe4',
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload-video-sniffer.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  createVideoSnifferView();
  videoSnifferWindow.loadFile(path.join(__dirname, 'renderer', 'video-sniffer.html'));

  videoSnifferWindow.on('closed', () => {
    videoSnifferView = null;
    videoSnifferWindow = null;
  });
}

function normalizeNavigationUrl(input) {
  const text = String(input || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  return 'https://' + text;
}

function unescapeForScan(text) {
  return String(text || '')
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&#x2[fF];/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&amp;/g, '&');
}

function extractPageMediaFromHtml(html) {
  const text = unescapeForScan(html);
  const urls = new Set();
  const re = /https?:\/\/[^\s"\\<>]+?\.m3u8(?:[^\s"\\<>]*)/gi;
  let m;
  while ((m = re.exec(text))) {
    let url = m[0].replace(/[\\,;]+$/, '');
    if (url) urls.add(url);
  }
  let total = 0;
  const tm = text.match(/totalEpisodes["'\s:\\]+(\d{1,4})/i);
  if (tm) total = Number(tm[1]) || 0;
  let title = '';
  const titleM = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (titleM) title = titleM[1].replace(/\s+/g, ' ').trim();
  return { urls: Array.from(urls), total, title };
}

function fetchPageHtml(targetUrl) {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { if (request) request.abort(); } catch {}
      finish(reject, new Error('页面源码读取超时'));
    }, 12000);
    try {
      request = net.request({
        url: targetUrl,
        session: session.fromPartition(VIDEO_SNIFFER_PARTITION),
        redirect: 'follow',
      });
    } catch (err) {
      finish(reject, err);
      return;
    }
    request.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    request.setHeader('Referer', targetUrl);
    request.setHeader('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');

    const chunks = [];
    let received = 0;
    const MAX_BYTES = 16 * 1024 * 1024;

    request.on('response', (response) => {
      if (Number(response.statusCode) >= 400) {
        finish(reject, new Error('HTTP ' + response.statusCode));
        return;
      }
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received <= MAX_BYTES) chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
      response.on('error', err => finish(reject, err));
    });
    request.on('error', err => finish(reject, err));
    request.end();
  });
}

const TIKHUB_BASE_URL = 'https://api.tikhub.io';
const TIKHUB_ENDPOINTS = {
  tiktok: {
    video: [
      '/api/v1/tiktok/web/fetch_one_video_v2',
      '/api/v1/tiktok/web/fetch_one_video',
    ],
    user: [
      '/api/v1/tiktok/web/get_sec_user_id',
      '/api/v1/tiktok/web/fetch_user_post',
      '/api/v1/tiktok/web/fetch_user_posts',
      '/api/v1/tiktok/web/fetch_user_videos',
      '/api/v1/tiktok/web/fetch_user_info',
      '/api/v1/tiktok/web/fetch_user_profile_v2',
      '/api/v1/tiktok/app/v3/get_user_id_and_sec_user_id_by_username',
      '/api/v1/tiktok/app/v3/fetch_user_post_videos_v3',
      '/api/v1/tiktok/app/v3/fetch_user_post_videos_v2',
      '/api/v1/tiktok/app/v3/fetch_user_post_videos',
      '/api/v1/tiktok/app/v3/handler_user_profile',
      '/api/v1/tiktok/web/fetch_user_profile',
    ],
  },
  douyin: {
    video: [
      '/api/v1/douyin/web/fetch_one_video',
      '/api/v1/douyin/app/v3/fetch_one_video',
    ],
    user: [
      '/api/v1/douyin/web/fetch_user_profile',
      '/api/v1/douyin/web/fetch_user_info',
      '/api/v1/douyin/web/fetch_user_post',
      '/api/v1/douyin/web/fetch_user_videos',
    ],
  },
};

function detectTikhubPlatform(shareUrl) {
  try {
    const host = new URL(String(shareUrl || '')).hostname.toLowerCase();
    if (/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$|(^|\.)snssdk\.com$/i.test(host)) return 'douyin';
    if (/(^|\.)tiktok\.com$|(^|\.)vm\.tiktok\.com$|(^|\.)vt\.tiktok\.com$/i.test(host)) return 'tiktok';
  } catch {}
  return 'tiktok';
}

function detectTikhubResourceType(shareUrl) {
  try {
    const url = new URL(String(shareUrl || ''));
    const host = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/g, '');
    if (/(^|\.)tiktok\.com$/i.test(host)) {
      if (/^\/@[^/]+\/(video|photo)\//i.test(path) || /^\/t\//i.test(path)) return 'video';
      if (/^\/@[^/]+$/i.test(path)) return 'user';
    }
    if (/(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(host)) {
      if (/\/(video|note)\//i.test(path) || /\/share\/video\//i.test(path)) return 'video';
      if (/\/user\//i.test(path) || /\/share\/user\//i.test(path)) return 'user';
    }
  } catch {}
  return 'video';
}

function extractTikhubUsername(shareUrl) {
  try {
    const url = new URL(String(shareUrl || ''));
    const match = url.pathname.match(/^\/@([^/]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {}
  return '';
}

function findTikhubValueDeep(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return '';
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null && obj[key] !== '') {
      return obj[key];
    }
  }
  const values = Array.isArray(obj) ? obj : Object.values(obj);
  for (const value of values) {
    const found = findTikhubValueDeep(value, keys, depth + 1);
    if (found !== '') return found;
  }
  return '';
}

function tikhubResponseMessage(data, text) {
  const direct = findTikhubValueDeep(data, ['message', 'msg', 'detail', 'error', 'status_msg', 'statusMsg']);
  if (direct !== '') return String(direct).slice(0, 500);
  if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 500);
  return '';
}

function tikhubEndpointList(payload) {
  const endpoint = String((payload && payload.endpoint) || '').trim();
  if (endpoint) return [endpoint.startsWith('/') ? endpoint : '/' + endpoint];
  const platform = String((payload && payload.platform) || 'auto').toLowerCase();
  const detectedPlatform = platform === 'douyin' || platform === 'tiktok'
    ? platform
    : detectTikhubPlatform(payload && payload.shareUrl);
  const typeFromPayload = String((payload && payload.resourceType) || 'auto').toLowerCase();
  const resourceType = typeFromPayload === 'user' || typeFromPayload === 'video'
    ? typeFromPayload
    : detectTikhubResourceType(payload && payload.shareUrl);
  const group = TIKHUB_ENDPOINTS[detectedPlatform] || TIKHUB_ENDPOINTS.tiktok;
  return (group[resourceType] || group.video || []).slice();
}

function buildTikhubRequestUrl(endpoint, context) {
  const url = new URL(endpoint, TIKHUB_BASE_URL);
  const lower = endpoint.toLowerCase();
  const shareUrl = context.shareUrl;
  const username = context.username;
  const secUid = context.secUid;
  const resourceType = context.resourceType;

  if (lower.includes('/tiktok/web/get_sec_user_id')) {
    url.searchParams.set('url', shareUrl);
    return { url, intermediate: true };
  }

  if (lower.includes('/tiktok/web/fetch_user_post')) {
    if (!secUid) return { skip: true, reason: 'missing secUid' };
    url.searchParams.set('secUid', secUid);
    url.searchParams.set('cursor', '0');
    url.searchParams.set('count', String(Math.max(1, Math.min(100, Number(context.count) || 20))));
    url.searchParams.set('coverFormat', '2');
    url.searchParams.set('post_item_list_request_type', '0');
    return { url };
  }

  if (lower.includes('/tiktok/app/v3/get_user_id_and_sec_user_id_by_username')) {
    if (!username) return { skip: true, reason: 'missing username' };
    url.searchParams.set('username', username);
    return { url, intermediate: true };
  }

  if (lower.includes('/tiktok/app/v3/fetch_user_post_videos')) {
    if (secUid) url.searchParams.set('sec_user_id', secUid);
    if (username) url.searchParams.set('unique_id', username);
    url.searchParams.set('max_cursor', '0');
    url.searchParams.set('count', String(Math.max(1, Math.min(100, Number(context.count) || 20))));
    url.searchParams.set('sort_type', '0');
    return { url };
  }

  if (lower.includes('/tiktok/app/v3/handler_user_profile')) {
    if (secUid) url.searchParams.set('sec_user_id', secUid);
    if (username) url.searchParams.set('unique_id', username);
    return { url };
  }

  if (lower.includes('/tiktok/web/fetch_user_profile')) {
    if (username) url.searchParams.set('uniqueId', username);
    if (secUid) url.searchParams.set('secUid', secUid);
    return { url };
  }

  if (resourceType === 'user') {
    url.searchParams.set('share_url', shareUrl);
    url.searchParams.set('url', shareUrl);
    if (username) {
      url.searchParams.set('uniqueId', username);
      url.searchParams.set('unique_id', username);
      url.searchParams.set('username', username);
    }
    if (secUid) url.searchParams.set('secUid', secUid);
    return { url };
  }

  url.searchParams.set('share_url', shareUrl);
  return { url };
}

function netRequestJson(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { if (request) request.abort(); } catch {}
      finish(reject, new Error('TikHub request timeout'));
    }, Number(options.timeoutMs) || 20000);
    try {
      request = net.request({
        method: options.method || 'GET',
        url: targetUrl,
        redirect: 'follow',
      });
    } catch (err) {
      finish(reject, err);
      return;
    }
    for (const [key, value] of Object.entries(options.headers || {})) {
      try { request.setHeader(key, value); } catch {}
    }
    const chunks = [];
    request.on('response', (response) => {
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch {}
        finish(resolve, { statusCode: Number(response.statusCode) || 0, text, data });
      });
      response.on('error', err => finish(reject, err));
    });
    request.on('error', err => finish(reject, err));
    request.end();
  });
}

async function fetchTikhubVideoInfo(payload) {
  const apiKey = String((payload && payload.apiKey) || '').trim();
  const shareUrl = normalizeNavigationUrl(payload && payload.shareUrl);
  if (!apiKey) return { ok: false, error: 'TikHub API Key is required' };
  if (!shareUrl || !/^https?:\/\//i.test(shareUrl)) return { ok: false, error: 'Share URL is required' };

  const attempts = [];
  const detectedPlatform = String((payload && payload.platform) || 'auto').toLowerCase() === 'auto'
    ? detectTikhubPlatform(shareUrl)
    : String((payload && payload.platform) || 'tiktok').toLowerCase();
  const detectedResourceType = String((payload && payload.resourceType) || 'auto').toLowerCase() === 'auto'
    ? detectTikhubResourceType(shareUrl)
    : String((payload && payload.resourceType) || 'video').toLowerCase();
  const username = extractTikhubUsername(shareUrl);
  const requireVideos = !!(payload && payload.requireVideos);
  let secUid = '';
  for (const endpoint of tikhubEndpointList({ ...payload, shareUrl })) {
    const built = buildTikhubRequestUrl(endpoint, {
      shareUrl,
      username,
      secUid,
      resourceType: detectedResourceType,
      count: payload && payload.count,
    });
    if (built.skip) {
      attempts.push({ endpoint, skipped: built.reason || 'skipped' });
      continue;
    }
    try {
      const response = await netRequestJson(built.url.toString(), {
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + apiKey,
        },
      });
      const responseMessage = tikhubResponseMessage(response.data, response.text);
      const attempt = { endpoint, statusCode: response.statusCode };
      if (responseMessage) attempt.message = responseMessage;
      attempts.push(attempt);
      if (response.statusCode >= 200 && response.statusCode < 300) {
        const nextSecUid = findTikhubValueDeep(response.data, ['secUid', 'sec_uid', 'sec_user_id', 'sec_user_id_str']);
        if (nextSecUid && !secUid) secUid = String(nextSecUid);
        if (built.intermediate) {
          if (!secUid && payload && payload.endpoint) {
            return {
              ok: false,
              endpoint,
              statusCode: response.statusCode,
              error: 'TikHub 已返回结果，但没有解析到 secUid，无法继续拉用户作品列表',
              data: response.data,
              attempts,
            };
          }
          continue;
        }
        if (requireVideos && detectedResourceType === 'user') {
          const videoCount = collectTikhubVideoItems(response.data).length;
          if (!videoCount) {
            attempt.message = (attempt.message ? attempt.message + '；' : '') + '接口未返回作品列表，继续尝试作品接口';
            continue;
          }
        }
        return {
          ok: true,
          endpoint,
          shareUrl,
          platform: detectedPlatform,
          resourceType: detectedResourceType,
          secUid,
          statusCode: response.statusCode,
          data: response.data,
          rawText: response.data ? '' : response.text,
          attempts,
        };
      }
      if (payload && payload.endpoint) {
        return {
          ok: false,
          endpoint,
          statusCode: response.statusCode,
          error: responseMessage || ('HTTP ' + response.statusCode),
          data: response.data,
          attempts,
        };
      }
    } catch (err) {
      attempts.push({ endpoint, error: err && err.message ? err.message : String(err) });
      if (payload && payload.endpoint) {
        return { ok: false, endpoint, error: err && err.message ? err.message : String(err), attempts };
      }
    }
  }
  const realAttempts = attempts.filter(item => item && item.statusCode);
  const allForbidden = realAttempts.length > 0 && realAttempts.every(item => item.statusCode === 403);
  const error = detectedResourceType === 'user'
    ? (allForbidden
      ? 'TikHub 用户主页相关接口全部返回 403。接口路径和参数已按 TikHub OpenAPI 配置，这通常表示当前 API Key 没有 TikTok 用户/作品列表接口权限，或账号套餐/余额/RPS 限制拒绝了该接口。请查看 attempts 里的 message，或到 TikHub 后台确认 TikTok 用户接口权限。'
      : '当前链接像是 TikTok/抖音用户主页，已改走用户主页接口，但 TikHub 没返回可用数据。可能该账号未开通对应接口，或平台接口名变更；可以在自定义 endpoint 填 TikHub 后台给的用户/作品列表接口。')
    : 'TikHub endpoints did not return usable data';
  return { ok: false, error, shareUrl, platform: detectedPlatform, resourceType: detectedResourceType, attempts };
}

function tikhubDirectValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return '';
}

function tikhubPickValue(obj, keys) {
  const direct = tikhubDirectValue(obj, keys);
  if (direct !== '') return direct;
  return findTikhubValueDeep(obj, keys);
}

function tikhubNumber(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let text = String(value).trim().replace(/,/g, '');
  if (!text) return 0;
  let multiplier = 1;
  if (/万/.test(text)) multiplier = 10000;
  else if (/亿/.test(text)) multiplier = 100000000;
  else if (/k$/i.test(text)) multiplier = 1000;
  else if (/m$/i.test(text)) multiplier = 1000000;
  else if (/b$/i.test(text)) multiplier = 1000000000;
  text = text.replace(/[万亿kKmMbB]/g, '');
  const num = Number(text);
  return Number.isFinite(num) ? Math.round(num * multiplier) : 0;
}

function tikhubString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function tikhubTimestamp(value) {
  const n = tikhubNumber(value);
  if (!n) return 0;
  if (n > 100000000000) return Math.round(n / 1000);
  return n;
}

function tikhubStableHash(text) {
  const raw = String(text || '');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function tikhubLooksLikeVideoItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const id = tikhubDirectValue(item, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId']);
  const title = tikhubPickValue(item, ['desc', 'description', 'title', 'text', 'caption']);
  const play = tikhubPickValue(item, ['play_count', 'playCount', 'view_count', 'viewCount', 'views', 'play']);
  const created = tikhubPickValue(item, ['create_time', 'createTime', 'create_at', 'created_at', 'publish_time']);
  const stats = tikhubPickValue(item, ['digg_count', 'like_count', 'comment_count', 'share_count']);
  return !!(id && (title || play || created || stats));
}

function collectTikhubVideoItems(root) {
  const items = [];
  const seenObjects = new Set();
  const seenKeys = new Set();
  const visit = (value, depth) => {
    if (!value || depth > 10) return;
    if (typeof value !== 'object') return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);
    if (tikhubLooksLikeVideoItem(value)) {
      const id = tikhubString(tikhubDirectValue(value, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId'])
        || tikhubPickValue(value, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId']));
      const title = tikhubString(tikhubPickValue(value, ['desc', 'description', 'title', 'text', 'caption']));
      const key = id || (title + ':' + tikhubString(tikhubPickValue(value, ['create_time', 'createTime', 'created_at'])));
      const stable = key || tikhubStableHash(JSON.stringify(value).slice(0, 600));
      if (!seenKeys.has(stable)) {
        seenKeys.add(stable);
        items.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (tikhubLooksLikeVideoItem(item)) {
          const id = tikhubString(tikhubDirectValue(item, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId'])
            || tikhubPickValue(item, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId']));
          const title = tikhubString(tikhubPickValue(item, ['desc', 'description', 'title', 'text', 'caption']));
          const key = id || (title + ':' + tikhubString(tikhubPickValue(item, ['create_time', 'createTime', 'created_at'])));
          const stable = key || tikhubStableHash(JSON.stringify(item).slice(0, 600));
          if (!seenKeys.has(stable)) {
            seenKeys.add(stable);
            items.push(item);
          }
        } else {
          visit(item, depth + 1);
        }
      }
      return;
    }
    for (const val of Object.values(value)) visit(val, depth + 1);
  };
  visit(root && root.data ? root.data : root, 0);
  return items;
}

function normalizeTikhubVideo(item, account, previousMap) {
  const id = tikhubString(tikhubDirectValue(item, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId'])
    || tikhubPickValue(item, ['aweme_id', 'awemeId', 'item_id', 'itemId', 'video_id', 'videoId']));
  const title = tikhubString(tikhubPickValue(item, ['desc', 'description', 'title', 'text', 'caption'])).slice(0, 500);
  const accountName = tikhubString(tikhubPickValue(item, ['unique_id', 'uniqueId', 'nickname', 'author_unique_id', 'authorName']))
    || account.username
    || account.label;
  const playCount = tikhubNumber(tikhubPickValue(item, ['play_count', 'playCount', 'view_count', 'viewCount', 'views', 'play']));
  const likeCount = tikhubNumber(tikhubPickValue(item, ['digg_count', 'like_count', 'likeCount', 'likes']));
  const commentCount = tikhubNumber(tikhubPickValue(item, ['comment_count', 'commentCount', 'comments']));
  const shareCount = tikhubNumber(tikhubPickValue(item, ['share_count', 'shareCount', 'shares']));
  const collectCount = tikhubNumber(tikhubPickValue(item, ['collect_count', 'collectCount', 'favorite_count', 'favoriteCount']));
  const createTime = tikhubTimestamp(tikhubPickValue(item, ['create_time', 'createTime', 'create_at', 'created_at', 'publish_time']));
  const durationMs = tikhubNumber(tikhubPickValue(item, ['duration', 'duration_ms', 'durationMs']));
  const directUrl = tikhubString(tikhubPickValue(item, ['share_url', 'shareUrl', 'web_url', 'webUrl', 'url']));
  const username = account.username || accountName;
  const videoUrl = /^https?:\/\//i.test(directUrl)
    ? directUrl
    : (id && username ? `https://www.tiktok.com/@${encodeURIComponent(username.replace(/^@/, ''))}/video/${id}` : account.url);
  const key = id ? `${account.platform || 'tiktok'}:${id}` : `${account.url}:${tikhubStableHash(videoUrl + title)}`;
  const previous = (previousMap && previousMap[key]) || {};
  const playGrowth = Math.max(0, playCount - (Number(previous.playCount) || 0));
  const likeGrowth = Math.max(0, likeCount - (Number(previous.likeCount) || 0));
  const commentGrowth = Math.max(0, commentCount - (Number(previous.commentCount) || 0));
  const shareGrowth = Math.max(0, shareCount - (Number(previous.shareCount) || 0));
  const engagement = likeCount + commentCount * 4 + shareCount * 6 + collectCount * 2;
  const engagementRate = playCount > 0 ? engagement / playCount : 0;
  const ageHours = createTime ? Math.max(0, (Date.now() / 1000 - createTime) / 3600) : 9999;
  const recencyBoost = ageHours <= 24 ? 90 : ageHours <= 72 ? 45 : ageHours <= 168 ? 20 : 0;
  const growthScore = Math.log10(playGrowth + likeGrowth * 4 + commentGrowth * 8 + shareGrowth * 10 + 10) * 90;
  const baseScore = Math.log10(playCount + 10) * 120 + Math.log10(engagement + 10) * 70 + Math.min(engagementRate * 12000, 180);
  const score = Math.round(baseScore + growthScore + recencyBoost);
  const hotLevel = score >= 980 || playGrowth >= 500000 ? '爆款候选' : score >= 760 || playGrowth >= 100000 ? '增长关注' : '观察';
  return {
    key,
    id,
    account: accountName || account.label || account.url,
    accountUrl: account.url,
    title,
    videoUrl,
    playCount,
    likeCount,
    commentCount,
    shareCount,
    collectCount,
    playGrowth,
    likeGrowth,
    commentGrowth,
    shareGrowth,
    engagementRate,
    createTime,
    createTimeText: createTime ? new Date(createTime * 1000).toLocaleString('zh-CN', { hour12: false }) : '',
    durationSec: durationMs > 1000 ? Math.round(durationMs / 1000) : durationMs,
    score,
    hotLevel,
  };
}



function normalizeTikhubUsernameValue(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function getTikhubUsernameFromUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    const match = decodeURIComponent(url.pathname || '').match(/^\/@([^/]+)/i);
    return match ? normalizeTikhubUsernameValue(match[1]) : '';
  } catch {
    return '';
  }
}

function tikhubCountFromText(text) {
  const raw = String(text || '').replace(/,/g, ' ');
  const matches = raw.match(/\d+(?:\.\d+)?\s*(?:K|M|B|k|m|b|万|亿)?/g) || [];
  let best = 0;
  for (const item of matches) {
    const value = tikhubNumber(item);
    if (value > best) best = value;
  }
  return best;
}

function waitForVideoSnifferLoad(wc, timeoutMs = 12000) {
  return new Promise(resolve => {
    if (!wc || wc.isDestroyed()) return resolve(false);
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', onStop);
      wc.removeListener('did-fail-load', onFail);
      resolve(value);
    };
    const onStop = () => finish(true);
    const onFail = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    wc.once('did-stop-loading', onStop);
    wc.once('did-fail-load', onFail);
  });
}

function normalizeTikhubPageVideo(item, account, previousMap) {
  const id = tikhubString(item && item.id);
  const title = tikhubString(item && item.title).slice(0, 500) || '当前页面作品';
  const accountName = tikhubString(item && item.account) || account.label || account.url;
  const videoUrl = tikhubString(item && item.videoUrl) || account.url;
  const playCount = tikhubNumber(item && item.playCount);
  const likeCount = tikhubNumber(item && item.likeCount);
  const commentCount = tikhubNumber(item && item.commentCount);
  const shareCount = tikhubNumber(item && item.shareCount);
  const key = id ? (account.platform || 'tiktok') + ':' + id : account.url + ':' + tikhubStableHash(videoUrl + title);
  const previous = (previousMap && previousMap[key]) || {};
  const playGrowth = Math.max(0, playCount - (Number(previous.playCount) || 0));
  const likeGrowth = Math.max(0, likeCount - (Number(previous.likeCount) || 0));
  const commentGrowth = Math.max(0, commentCount - (Number(previous.commentCount) || 0));
  const shareGrowth = Math.max(0, shareCount - (Number(previous.shareCount) || 0));
  const engagement = likeCount + commentCount * 4 + shareCount * 6;
  const engagementRate = playCount > 0 ? engagement / playCount : 0;
  const growthScore = Math.log10(playGrowth + likeGrowth * 4 + commentGrowth * 8 + shareGrowth * 10 + 10) * 90;
  const baseScore = Math.log10(playCount + 10) * 120 + Math.log10(engagement + 10) * 70 + Math.min(engagementRate * 12000, 180);
  const score = Math.round(baseScore + growthScore);
  const hotLevel = score >= 980 || playGrowth >= 500000 ? '爆款候选' : score >= 760 || playGrowth >= 100000 ? '增长关注' : '观察';
  return {
    key,
    id,
    account: accountName,
    accountUrl: account.url,
    title,
    videoUrl,
    playCount,
    likeCount,
    commentCount,
    shareCount,
    collectCount: 0,
    playGrowth,
    likeGrowth,
    commentGrowth,
    shareGrowth,
    engagementRate,
    createTime: 0,
    createTimeText: '',
    durationSec: 0,
    score,
    hotLevel,
    source: item && item.source ? item.source : 'current-page',
  };
}

async function extractVisibleTikhubPageVideos(options = {}) {
  const accountUrl = normalizeNavigationUrl(options.accountUrl || '');
  const maxVideos = Math.max(1, Math.min(100, Number(options.maxVideos) || 20));
  let wc = options.webContents && !options.webContents.isDestroyed() ? options.webContents : null;
  if (!wc) {
    if (options.silent === true) {
      wc = createInfoScraperHiddenBrowser();
    } else if (videoSnifferView && !videoSnifferView.webContents.isDestroyed()) {
      wc = videoSnifferView.webContents;
    } else if (options.silent !== false) {
      wc = createInfoScraperHiddenBrowser();
    } else {
      return { ok: false, error: '浏览器未初始化，无法读取当前页面作品' };
    }
  }
  if (!wc || wc.isDestroyed()) return { ok: false, error: '浏览器未初始化，无法读取当前页面作品' };
  const targetUsername = getTikhubUsernameFromUrl(accountUrl);
  const currentUsername = getTikhubUsernameFromUrl(wc.getURL());
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  if (accountUrl && /^https?:\/\//i.test(accountUrl) && (!targetUsername || targetUsername !== currentUsername)) {
    try {
      const loadPromise = waitForVideoSnifferLoad(wc, 15000);
      await wc.loadURL(accountUrl);
      await loadPromise;
      try { wc.focus(); } catch {}
      await sleep(6500);
    } catch (err) {
      return { ok: false, error: '打开账号主页失败：' + (err && err.message ? err.message : String(err)) };
    }
  } else {
    await sleep(800);
  }

  const wantedUsername = targetUsername || getTikhubUsernameFromUrl(wc.getURL());
  const script = [
    '(() => {',
    'const wantedUsername = ' + JSON.stringify(wantedUsername) + ';',
    'const maxVideos = ' + JSON.stringify(maxVideos) + ';',
    'const clean = value => String(value || "").replace(/\\s+/g, " ").trim();',
    'const usernameFromUrl = href => { try { const path = decodeURIComponent(new URL(href, location.href).pathname || ""); const match = path.match(/^\\/@([^/]+)\\/(?:video|photo)\\//i) || path.match(/^\\/@([^/]+)/i); return match ? String(match[1] || "").replace(/^@+/, "").toLowerCase() : ""; } catch (e) { return ""; } };',
    'const idFromUrl = href => { try { const path = new URL(href, location.href).pathname || ""; const match = path.match(/\\/(?:video|photo)\\/(\\d+)/i); return match ? match[1] : ""; } catch (e) { return ""; } };',
    'const countFromText = text => { const raw = String(text || "").replace(/,/g, " "); const matches = raw.match(/\\d+(?:\\.\\d+)?\\s*(?:K|M|B|k|m|b|万|亿)?/g) || []; let best = 0; for (const item of matches) { let valueText = String(item || "").trim(); let multiplier = 1; if (/万/.test(valueText)) multiplier = 10000; else if (/亿/.test(valueText)) multiplier = 100000000; else if (/k$/i.test(valueText)) multiplier = 1000; else if (/m$/i.test(valueText)) multiplier = 1000000; else if (/b$/i.test(valueText)) multiplier = 1000000000; valueText = valueText.replace(/[万亿kKmMbB]/g, "").trim(); const number = Number(valueText); if (Number.isFinite(number)) best = Math.max(best, Math.round(number * multiplier)); } return best; };',
    'const pageUsername = usernameFromUrl(location.href);',
    'const anchors = Array.from(document.querySelectorAll("a[href]"));',
    'const seen = new Set();',
    'const videos = [];',
    'for (const anchor of anchors) {',
    'let href = "";',
    'try { href = new URL(anchor.getAttribute("href") || "", location.href).toString(); } catch (e) { continue; }',
    'if (!/\\/@[^/]+\\/(?:video|photo)\\//i.test(new URL(href).pathname || "")) continue;',
    'const username = usernameFromUrl(href) || pageUsername;',
    'if (wantedUsername && username && username !== wantedUsername) continue;',
    'const stableUrl = href.replace(/[?#].*$/, "");',
    'if (seen.has(stableUrl)) continue;',
    'seen.add(stableUrl);',
    'let node = anchor;',
    'let bestText = "";',
    'for (let i = 0; node && i < 6; i += 1, node = node.parentElement) { const text = clean(node.innerText || node.textContent || ""); if (text.length > bestText.length && text.length < 1500) bestText = text; }',
    'const img = anchor.querySelector("img") || (anchor.closest("div") && anchor.closest("div").querySelector("img"));',
    'const title = clean(anchor.getAttribute("aria-label") || anchor.title || (img && img.alt) || bestText).slice(0, 300);',
    'const countText = [anchor.getAttribute("aria-label"), anchor.title, img && img.alt, bestText].filter(Boolean).join(" ");',
    'videos.push({ id: idFromUrl(href), title, videoUrl: stableUrl, account: username ? "@" + username : "", playCount: countFromText(countText), likeCount: 0, commentCount: 0, shareCount: 0, source: "current-page" });',
    'if (videos.length >= maxVideos) break;',
    '}',
    'if (!videos.length) {',
    'const html = document.documentElement.innerHTML || "";',
    'const re = /(?:https?:\\/\\/(?:www\\.)?tiktok\\.com)?\\/@([A-Za-z0-9._-]+)\\/(video|photo)\\/(\\d+)/g;',
    'let match;',
    'while ((match = re.exec(html)) && videos.length < maxVideos) {',
    'const username = String(match[1] || "").toLowerCase();',
    'if (wantedUsername && username && username !== wantedUsername) continue;',
    'const id = String(match[3] || "");',
    'const stableUrl = "https://www.tiktok.com/@" + username + "/" + String(match[2] || "video") + "/" + id;',
    'if (seen.has(stableUrl)) continue;',
    'seen.add(stableUrl);',
    'videos.push({ id, title: "TikTok 作品 " + id, videoUrl: stableUrl, account: username ? "@" + username : "", playCount: 0, likeCount: 0, commentCount: 0, shareCount: 0, source: "html-scan" });',
    '}',
    '}',
    'return { ok: true, url: location.href, title: document.title, readyState: document.readyState, anchorCount: anchors.length, linkCount: document.links.length, bodyText: clean(document.body && document.body.innerText || "").slice(0, 240), pageUsername, videos };',
    '})()'
  ].join('\n');

  const dataScript = [
    '(() => {',
    'const wantedUsername = ' + JSON.stringify(wantedUsername) + ';',
    'const maxVideos = ' + JSON.stringify(maxVideos) + ';',
    'const clean = value => String(value || "").replace(/\\s+/g, " ").trim();',
    'const asNumber = value => { if (value == null) return 0; const raw = String(value).replace(/,/g, " ").trim(); const m = raw.match(/\\d+(?:\\.\\d+)?\\s*(?:K|M|B|k|m|b|万|亿)?/); if (!m) return 0; let text = m[0]; let mul = 1; if (/万/.test(text)) mul = 10000; else if (/亿/.test(text)) mul = 100000000; else if (/k$/i.test(text)) mul = 1000; else if (/m$/i.test(text)) mul = 1000000; else if (/b$/i.test(text)) mul = 1000000000; text = text.replace(/[万亿kKmMbB]/g, "").trim(); const n = Number(text); return Number.isFinite(n) ? Math.round(n * mul) : 0; };',
    'const usernameFromUrl = href => { try { const path = decodeURIComponent(new URL(href, location.href).pathname || ""); const match = path.match(/^\\/@([^/]+)\\/(?:video|photo)\\//i) || path.match(/^\\/@([^/]+)/i); return match ? String(match[1] || "").replace(/^@+/, "").toLowerCase() : ""; } catch (e) { return ""; } };',
    'const pageUsername = usernameFromUrl(location.href);',
    'const pick = (obj, keys) => { if (!obj || typeof obj !== "object") return ""; for (const key of keys) { if (obj[key] != null && obj[key] !== "") return obj[key]; } return ""; };',
    'const pickDeepNumber = obj => asNumber(pick(obj, ["playCount","play_count","viewCount","view_count","play","views","diggCount","digg_count"]));',
    'const seen = new Set();',
    'const videos = [];',
    'const add = item => {',
    '  if (!item || typeof item !== "object") return;',
    '  const id = clean(pick(item, ["id","aweme_id","awemeId","item_id","itemId","video_id","videoId"]));',
    '  const desc = clean(pick(item, ["desc","description","title","text","caption"]));',
    '  let author = pick(item, ["author","authorInfo","user","owner"]);',
    '  let username = clean(pick(item, ["uniqueId","unique_id","author_unique_id","nickname","authorName"]));',
    '  if (author && typeof author === "object") username = clean(pick(author, ["uniqueId","unique_id","nickname","shortId","id"])) || username;',
    '  username = username.replace(/^@+/, "").toLowerCase() || pageUsername;',
    '  if (wantedUsername && username && username !== wantedUsername) return;',
    '  let url = clean(pick(item, ["shareUrl","share_url","webVideoUrl","web_url","url"]));',
    '  if (!/^https?:\\/\\//i.test(url) && id && username) url = "https://www.tiktok.com/@" + username + "/video/" + id;',
    '  if (!id && !url) return;',
    '  const key = (id || url).replace(/[?#].*$/, "");',
    '  if (seen.has(key)) return;',
    '  seen.add(key);',
    '  const stats = pick(item, ["stats","statistics","statsV2","statisticsV2"]) || item;',
    '  videos.push({ id, title: desc || (id ? "TikTok 作品 " + id : "TikTok 作品"), videoUrl: url || location.href, account: username ? "@" + username : "", playCount: pickDeepNumber(stats), likeCount: asNumber(pick(stats, ["diggCount","digg_count","likeCount","like_count"])), commentCount: asNumber(pick(stats, ["commentCount","comment_count"])), shareCount: asNumber(pick(stats, ["shareCount","share_count"])), source: "page-data" });',
    '};',
    'const visit = (value, depth) => {',
    '  if (!value || depth > 9 || videos.length >= maxVideos) return;',
    '  if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return; }',
    '  if (typeof value !== "object") return;',
    '  const hasVideoId = pick(value, ["aweme_id","awemeId","item_id","itemId","video_id","videoId","id"]);',
    '  const hasVideoText = pick(value, ["desc","description","title","text","caption"]);',
    '  const hasStats = pick(value, ["stats","statistics","statsV2","statisticsV2","playCount","play_count","viewCount","view_count"]);',
    '  if (hasVideoId && (hasVideoText || hasStats || pick(value, ["shareUrl","share_url","webVideoUrl","url"]))) add(value);',
    '  for (const key of Object.keys(value).slice(0, 120)) visit(value[key], depth + 1);',
    '};',
    'const candidates = [window.__UNIVERSAL_DATA_FOR_REHYDRATION__, window.SIGI_STATE, window.__INITIAL_STATE__].filter(Boolean);',
    'for (const item of candidates) visit(item, 0);',
    'for (const script of Array.from(document.scripts || [])) {',
    '  if (videos.length >= maxVideos) break;',
    '  const text = script.textContent || "";',
    '  if (!/(aweme|itemStruct|playCount|video|VideoObject)/i.test(text)) continue;',
    '  const trimmed = text.trim();',
    '  if (trimmed[0] === "{" || trimmed[0] === "[") { try { visit(JSON.parse(trimmed), 0); } catch (e) {} }',
    '}',
    'return { ok: true, url: location.href, title: document.title, videos };',
    '})()'
  ].join('\n');

  const mergeBrowserResults = (base, extra) => {
    const next = base && typeof base === 'object' ? { ...base } : { ok: true };
    const seen = new Set();
    const merged = [];
    for (const source of [base, extra]) {
      for (const item of ((source && Array.isArray(source.videos)) ? source.videos : [])) {
        const key = String((item && (item.id || item.videoUrl || item.title)) || '').replace(/[?#].*$/, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
        if (merged.length >= maxVideos) break;
      }
      if (merged.length >= maxVideos) break;
    }
    next.videos = merged;
    next.loadedVideoCount = merged.length;
    return next;
  };

  const readPageResult = async () => {
    const base = await wc.executeJavaScript(script, true).catch(err => ({ ok: false, error: err && err.message ? err.message : String(err), videos: [] }));
    const extra = await wc.executeJavaScript(dataScript, true).catch(() => ({ ok: true, videos: [] }));
    return mergeBrowserResults(base, extra);
  };

  try {
    let result = await readPageResult();
    let bestResult = result;
    let bestCount = result && Array.isArray(result.videos) ? result.videos.length : 0;
    let staleRounds = 0;
    let scrollRounds = 0;
    const maxScrollRounds = Math.max(24, Math.min(80, maxVideos * 2));
    const activateAndScrollScript = [
      '(async () => {',
      'const sleep = ms => new Promise(r => setTimeout(r, ms));',
      'const clean = value => String(value || "").replace(/\\s+/g, " ").trim();',
      'try { const tab = Array.from(document.querySelectorAll("button,a,div,span")).find(el => /^(Videos|视频|作品)$/i.test(clean(el.innerText || el.textContent || ""))); if (tab && tab.click) tab.click(); } catch (e) {}',
      'const candidates = [document.scrollingElement, document.documentElement, document.body];',
      'try { candidates.push(...Array.from(document.querySelectorAll("*")).filter(el => { const style = getComputedStyle(el); return /(auto|scroll)/.test(style.overflowY || "") && el.scrollHeight > el.clientHeight + 300; }).slice(0, 12)); } catch (e) {}',
      'const step = Math.max(900, Math.floor((window.innerHeight || 900) * 0.92));',
      'for (const el of candidates) { try { if (!el) continue; el.scrollTop = Math.min(el.scrollHeight, (el.scrollTop || 0) + step); } catch (e) {} }',
      'try { window.scrollBy(0, step); } catch (e) {}',
      'await sleep(420);',
      'for (const el of candidates) { try { if (!el) continue; el.dispatchEvent(new Event("scroll", { bubbles: true })); } catch (e) {} }',
      'return { y: window.scrollY || 0, height: document.body && document.body.scrollHeight || 0 };',
      '})()'
    ].join('\n');
    for (let attempt = 0; accountUrl && bestCount < maxVideos && attempt < maxScrollRounds && staleRounds < 12; attempt += 1) {
      try { wc.focus(); } catch {}
      try {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' });
        wc.sendInputEvent({ type: 'mouseWheel', x: 760, y: 820, deltaY: -1200, wheelTicksY: -10 });
      } catch {}
      try {
        await wc.executeJavaScript(activateAndScrollScript, true);
      } catch {}
      scrollRounds += 1;
      await sleep(Math.min(3600, 1500 + attempt * 140));
      result = await readPageResult();
      const count = result && Array.isArray(result.videos) ? result.videos.length : 0;
      if (count > bestCount) {
        bestResult = result;
        bestCount = count;
        staleRounds = 0;
      } else {
        staleRounds += 1;
      }
    }
    result = bestResult || result;
    if (result && result.ok && Array.isArray(result.videos) && result.videos.length) {
      result.requestedMaxVideos = maxVideos;
      result.loadedVideoCount = result.videos.length;
      result.scrollRounds = scrollRounds;
      result.exhausted = result.videos.length < maxVideos;
      return result;
    }
    const debug = result && result.ok ? result : {};
    const detail = [
      debug.url && ('URL=' + debug.url),
      debug.title && ('标题=' + debug.title),
      debug.readyState && ('状态=' + debug.readyState),
      Number.isFinite(Number(debug.anchorCount)) && ('链接数=' + debug.anchorCount),
      debug.bodyText && ('页面文字=' + String(debug.bodyText).slice(0, 120)),
    ].filter(Boolean).join('；');
    return { ok: false, error: '后台浏览器已打开，但没有从页面提取到作品卡片' + (detail ? '（' + detail + '）' : '') };
  } catch (err) {
    return { ok: false, error: '读取后台浏览器页面作品失败：' + (err && err.message ? err.message : String(err)) };
  }
}

function dramaRadarSnapshotPath() {
  return path.join(app.getPath('userData'), 'drama-radar-snapshots.json');
}

function readDramaRadarSnapshot() {
  try {
    const file = dramaRadarSnapshotPath();
    if (!fs.existsSync(file)) return { videos: {} };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : { videos: {} };
  } catch {
    return { videos: {} };
  }
}

function writeDramaRadarSnapshot(videos) {
  try {
    const file = dramaRadarSnapshotPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const map = {};
    for (const item of videos || []) {
      map[item.key] = {
        key: item.key,
        id: item.id,
        account: item.account,
        title: item.title,
        videoUrl: item.videoUrl,
        playCount: item.playCount,
        likeCount: item.likeCount,
        commentCount: item.commentCount,
        shareCount: item.shareCount,
        createTime: item.createTime,
        score: item.score,
        updatedAt: Date.now(),
      };
    }
    fs.writeFileSync(file, JSON.stringify({ updatedAt: new Date().toISOString(), videos: map }, null, 2));
  } catch {}
}

function parseDramaRadarAccountUrls(input) {
  const raw = Array.isArray(input) ? input.join('\n') : String(input || '');
  const matches = raw.match(/https?:\/\/[^\s"'<>，。；、]+/gi) || [];
  const seen = new Set();
  const urls = [];
  for (const url of matches) {
    const clean = cleanupImportedUrl(url);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    urls.push(clean);
  }
  return urls.slice(0, 100);
}

async function fetchTikhubDramaRadar(payload) {
  const apiKey = String((payload && payload.apiKey) || '').trim();
  if (!apiKey) return { ok: false, error: '请先填写 TikHub API Key' };
  const accountUrls = parseDramaRadarAccountUrls(payload && (payload.accountUrls || payload.accounts));
  if (!accountUrls.length) return { ok: false, error: '请先填写要监控的 TikTok/抖音账号或视频链接' };
  const maxVideos = Math.max(1, Math.min(100, Number(payload && payload.maxVideos) || 20));
  const previous = readDramaRadarSnapshot();
  const previousMap = (previous && previous.videos) || {};
  const accounts = [];
  const videos = [];
  const warnings = [];

  for (const url of accountUrls) {
    const platform = detectTikhubPlatform(url);
    const resourceType = detectTikhubResourceType(url);
    const username = extractTikhubUsername(url);
    const account = {
      url,
      platform,
      username,
      label: username ? '@' + username : url,
      resourceType,
      ok: false,
      videoCount: 0,
      attempts: [],
    };

    let normalized = [];
    let partialNote = '';
    try {
      const res = await fetchTikhubVideoInfo({
        apiKey,
        shareUrl: url,
        platform,
        resourceType: resourceType === 'video' ? 'video' : 'user',
        count: maxVideos,
        requireVideos: resourceType !== 'video',
      });
      account.ok = !!(res && res.ok);
      account.endpoint = res && res.endpoint;
      account.attempts = (res && res.attempts) || [];

      if (account.ok) {
        const extracted = collectTikhubVideoItems(res.data);
        normalized = extracted.map(item => normalizeTikhubVideo(item, account, previousMap))
          .filter(item => item.id || item.title || item.playCount)
          .sort((a, b) => (b.createTime || 0) - (a.createTime || 0) || b.playCount - a.playCount)
          .slice(0, maxVideos);
      } else {
        account.error = (res && res.error) || 'TikHub 没返回可用数据';
      }

      if (!normalized.length && platform === 'tiktok') {
        const pageFallback = await extractVisibleTikhubPageVideos({ accountUrl: url, maxVideos });
        if (pageFallback && pageFallback.ok && Array.isArray(pageFallback.videos) && pageFallback.videos.length) {
          normalized = pageFallback.videos.map(item => normalizeTikhubPageVideo(item, account, previousMap))
            .filter(item => item.videoUrl || item.id || item.title)
            .sort((a, b) => b.playCount - a.playCount || String(a.videoUrl).localeCompare(String(b.videoUrl)))
            .slice(0, maxVideos);
          if (pageFallback.exhausted && normalized.length < maxVideos) {
            partialNote = '页面实际加载 ' + normalized.length + '/' + maxVideos + ' 条，已深度滚动 ' + (pageFallback.scrollRounds || 0) + ' 轮；如果账号确实有更多作品，通常是 TikTok 懒加载、登录提示或地区限制没有继续放出。';
          }
          account.ok = true;
          account.endpoint = account.endpoint || 'current-page-visible-posts';
          account.source = 'current-page';
          warnings.push(account.label + '：TikHub 未返回作品列表，已从当前账号页面提取 ' + normalized.length + ' 条可见作品');
        } else {
          account.pageFallbackError = pageFallback && pageFallback.error;
        }
      }

      account.videoCount = normalized.length;
      if (normalized.length) {
        videos.push(...normalized);
      } else if (account.error) {
        warnings.push(account.label + '：' + account.error);
      } else {
        const detail = account.pageFallbackError ? '；页面读取失败：' + account.pageFallbackError : '';
        warnings.push(account.label + '：没有抽取到公开视频列表' + detail);
      }
    } catch (err) {
      account.error = err && err.message ? err.message : String(err);
      warnings.push(account.label + '：' + account.error);
    }
    accounts.push(account);
  }

  const sorted = videos.sort((a, b) => b.score - a.score || b.playGrowth - a.playGrowth || b.playCount - a.playCount)
    .slice(0, Math.max(50, Math.min(500, accountUrls.length * maxVideos)));
  writeDramaRadarSnapshot(sorted);
  return {
    ok: true,
    snapshotAt: new Date().toISOString(),
    accountCount: accounts.length,
    videoCount: sorted.length,
    accounts,
    videos: sorted,
    warnings,
  };
}


function infoScraperStatePath() {
  return path.join(app.getPath('userData'), 'info-scraper-state.json');
}

function defaultInfoScraperState() {
  return {
    maxVideos: 50,
    accounts: [],
    snapshots: {},
    events: [],
    completedSlots: {},
    lastPollAt: '',
    lastPollReason: '',
    extractorPreference: 'auto',
  };
}

function infoScraperLegacyApiText(text) {
  return /\bTikHub\b|tikhub|TikHub endpoints|API Key is required|用户主页相关接口|自定义 endpoint/i.test(String(text || ''));
}

function normalizeInfoScraperState(raw) {
  const base = defaultInfoScraperState();
  const state = raw && typeof raw === 'object' ? { ...base, ...raw } : base;
  state.accounts = Array.isArray(state.accounts) ? state.accounts : [];
  state.accounts = state.accounts.map(account => {
    if (!account || typeof account !== 'object') return account;
    const next = { ...account };
    if (infoScraperLegacyApiText(next.lastError)) next.lastError = '';
    if (infoScraperLegacyApiText(next.lastPartialNote)) next.lastPartialNote = '';
    return next;
  });
  state.snapshots = state.snapshots && typeof state.snapshots === 'object' ? state.snapshots : {};
  state.events = Array.isArray(state.events)
    ? state.events.filter(event => !infoScraperLegacyApiText((event && event.message) || '')).slice(-300)
    : [];
  state.completedSlots = state.completedSlots && typeof state.completedSlots === 'object' ? state.completedSlots : {};
  state.maxVideos = Math.max(1, Math.min(100, Number(state.maxVideos) || 50));
  return state;
}

function readInfoScraperState() {
  try {
    const file = infoScraperStatePath();
    if (!fs.existsSync(file)) return defaultInfoScraperState();
    return normalizeInfoScraperState(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return defaultInfoScraperState();
  }
}

function writeInfoScraperState(state) {
  const next = normalizeInfoScraperState(state);
  const file = infoScraperStatePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

function infoScraperSlotKey(date = new Date()) {
  const hour = Number(date.getHours()) || 0;
  let slotHour = INFO_SCRAPER_POLL_HOURS[0];
  for (const item of INFO_SCRAPER_POLL_HOURS) {
    if (hour >= item) slotHour = item;
  }
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d + '-' + String(slotHour).padStart(2, '0');
}

function nextInfoScraperPollText(date = new Date()) {
  const now = new Date(date.getTime());
  for (const hour of INFO_SCRAPER_POLL_HOURS) {
    const target = new Date(now);
    target.setHours(hour, 0, 0, 0);
    if (target > now) return target.toLocaleString('zh-CN', { hour12: false });
  }
  const target = new Date(now);
  target.setDate(target.getDate() + 1);
  target.setHours(INFO_SCRAPER_POLL_HOURS[0], 0, 0, 0);
  return target.toLocaleString('zh-CN', { hour12: false });
}

function infoScraperAccountId(url) {
  return crypto.createHash('sha1').update(String(url || '').trim().toLowerCase()).digest('hex').slice(0, 14);
}

function normalizeInfoScraperAccount(url, existing = {}) {
  const cleanUrl = normalizeNavigationUrl(cleanupImportedUrl(url));
  const platform = detectTikhubPlatform(cleanUrl);
  const resourceType = detectTikhubResourceType(cleanUrl) === 'user' ? 'user' : 'video';
  const username = extractTikhubUsername(cleanUrl);
  const now = new Date().toISOString();
  return {
    id: existing.id || infoScraperAccountId(cleanUrl),
    url: cleanUrl,
    platform,
    resourceType,
    username,
    label: existing.label || (username ? '@' + username : cleanUrl),
    enabled: existing.enabled !== false,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    lastPolledAt: existing.lastPolledAt || '',
    lastError: existing.lastError || '',
    lastVideoCount: Number(existing.lastVideoCount) || 0,
    lastNewCount: Number(existing.lastNewCount) || 0,
    lastGrowthCount: Number(existing.lastGrowthCount) || 0,
  };
}

function infoScraperPublicState(state = readInfoScraperState()) {
  const safe = normalizeInfoScraperState(state);
  const videos = [];
  for (const account of safe.accounts) {
    const snapshot = safe.snapshots[account.id];
    if (snapshot && Array.isArray(snapshot.videos)) {
      for (const video of snapshot.videos) videos.push({ ...video, accountId: account.id });
    }
  }
  videos.sort((a, b) => (b.score || 0) - (a.score || 0) || (b.playGrowth || 0) - (a.playGrowth || 0) || (b.playCount || 0) - (a.playCount || 0));
  const visibleVideos = videos.slice(0, 500);
  return {
    ok: true,
    hasApiKey: false,
    apiKey: '',
    loginStatus: infoScraperLoginStatusCache,
    maxVideos: safe.maxVideos,
    accounts: safe.accounts,
    events: safe.events.slice(-160).reverse(),
    videos: visibleVideos,
    bilingualRows: visibleVideos.map((video, index) => infoScraperBilingualRecord(video, index)),
    headers: SHORT_DRAMA_BILINGUAL_HEADERS,
    snapshots: safe.snapshots,
    lastPollAt: safe.lastPollAt || '',
    lastPollReason: safe.lastPollReason || '',
    nextPollAt: nextInfoScraperPollText(),
    pollHours: INFO_SCRAPER_POLL_HOURS,
    polling: infoScraperPolling,
    extractor: {
      primary: 'yt-dlp',
      fallback: 'browser',
      note: '不再走 TikHub：先用 yt-dlp 用户页提取器，失败时复用内置浏览器登录态读取可见作品。',
    },
  };
}


const SHORT_DRAMA_BILINGUAL_HEADERS = [
  'Rank / 排名',
  'Drama ID / 短剧ID',
  'English Title / 英文剧名',
  'Chinese Title / 中文剧名',
  'Episodes / 集数',
  'Views / 观看数',
  'Duration Seconds / 总时长(秒)',
  'Duration Minutes / 总时长(分钟)',
  'Limited Free / 是否限免',
  'English Themes / 英文题材',
  'Chinese Themes / 中文题材',
  'English Description / 英文简介',
  'Chinese Description / 中文简介',
];

function infoScraperTextHasChinese(text) {
  return /[\u3400-\u9fff]/.test(String(text || ''));
}

function infoScraperCleanDramaTitle(text) {
  let value = String(text || '').replace(/\s+/g, ' ').trim();
  value = value.replace(/\b(original sound|使用 .*? 的 原声|使用 .*? 的原声)\b/ig, '').trim();
  value = value.replace(/#[\p{L}\p{N}_-]+/gu, '').replace(/\s+/g, ' ').trim();
  value = value.replace(/^[·•\-\s]+|[·•\-\s]+$/g, '').trim();
  return value.slice(0, 180);
}

function infoScraperExtractThemes(text, chinese) {
  const tags = String(text || '').match(/#[\p{L}\p{N}_-]+/gu) || [];
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const clean = tag.replace(/^#+/, '').trim();
    if (!clean) continue;
    if (chinese !== infoScraperTextHasChinese(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= 8) break;
  }
  return out.join('; ');
}

function infoScraperLimitedFreeText(video) {
  const text = [video && video.title, video && video.videoUrl, video && video.accountUrl].join(' ');
  if (/\bfree\b|watch all for free|免费观看|免费|限免/i.test(text)) return '是 / Yes';
  return '';
}

function infoScraperDramaId(video) {
  const id = tikhubString(video && video.id) || tikhubString(video && video.key).replace(/^[^:]+:/, '');
  return id ? 'ID ' + id : '';
}

function infoScraperBilingualRecord(video, index) {
  const rawTitle = String(video && video.title || '').trim();
  const cleanTitle = infoScraperCleanDramaTitle(rawTitle) || rawTitle.slice(0, 180);
  const isChineseTitle = infoScraperTextHasChinese(cleanTitle);
  const durationSec = Number(video && video.durationSec) || 0;
  return {
    rank: index + 1,
    dramaId: infoScraperDramaId(video),
    englishTitle: isChineseTitle ? '' : cleanTitle,
    chineseTitle: isChineseTitle ? cleanTitle : '',
    episodes: '',
    views: Number(video && video.playCount) || 0,
    durationSeconds: durationSec || '',
    durationMinutes: durationSec ? Number((durationSec / 60).toFixed(1)) : '',
    limitedFree: infoScraperLimitedFreeText(video),
    englishThemes: infoScraperExtractThemes(rawTitle, false),
    chineseThemes: infoScraperExtractThemes(rawTitle, true),
    englishDescription: isChineseTitle ? '' : rawTitle,
    chineseDescription: isChineseTitle ? rawTitle : '',
    videoUrl: String(video && video.videoUrl || ''),
  };
}

function infoScraperBilingualRows(state = readInfoScraperState()) {
  const publicState = infoScraperPublicState(state);
  return (publicState.bilingualRows || []).map(row => [
    row.rank,
    row.dramaId,
    row.englishTitle,
    row.chineseTitle,
    row.episodes,
    row.views,
    row.durationSeconds,
    row.durationMinutes,
    row.limitedFree,
    row.englishThemes,
    row.chineseThemes,
    row.englishDescription,
    row.chineseDescription,
  ]);
}
function exportInfoScraperBilingualList() {
  if (!xlsx) return { ok: false, error: '缺少 xlsx 导出库，请重新安装依赖后再试' };
  const rows = infoScraperBilingualRows();
  if (!rows.length) return { ok: false, error: '还没有可导出的抓取数据，请先立即抓取账号' };
  const aoa = [SHORT_DRAMA_BILINGUAL_HEADERS, ...rows];
  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  worksheet['!cols'] = [
    { wch: 12 }, { wch: 24 }, { wch: 42 }, { wch: 28 }, { wch: 12 },
    { wch: 14 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 28 },
    { wch: 28 }, { wch: 80 }, { wch: 80 },
  ];
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Bilingual List');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const target = dialog.showSaveDialogSync(infoScraperWindow || mainWindow, {
    title: '导出对标短剧表格',
    defaultPath: path.join(app.getPath('documents'), 'shortdramatime_drama_list_bilingual_' + stamp + '.xlsx'),
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
  });
  if (!target) return { ok: false, cancelled: true, error: '已取消导出' };
  xlsx.writeFile(workbook, target);
  const state = readInfoScraperState();
  appendInfoScraperEvent(state, { type: 'export', message: '已导出对标短剧表格：' + rows.length + ' 条' });
  writeInfoScraperState(state);
  return { ok: true, path: target, count: rows.length };
}

function sendInfoScraperEvent(payload) {
  const event = { time: new Date().toISOString(), ...(payload || {}) };
  if (infoScraperWindow && !infoScraperWindow.isDestroyed()) {
    infoScraperWindow.webContents.send('info-scraper:event', event);
  }
  if (videoSnifferWindow && !videoSnifferWindow.isDestroyed()) {
    videoSnifferWindow.webContents.send('info-scraper:event', event);
  }
}

function appendInfoScraperEvent(state, event) {
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({ time: new Date().toISOString(), ...(event || {}) });
  if (state.events.length > 300) state.events = state.events.slice(-300);
}

function previousVideoMapForInfoScraper(state, accountId) {
  const snapshot = state.snapshots && state.snapshots[accountId];
  const map = {};
  if (snapshot && Array.isArray(snapshot.videos)) {
    for (const video of snapshot.videos) {
      if (video && video.key) map[video.key] = video;
    }
  }
  return map;
}

const INFO_SCRAPER_SOURCE_LABELS = {
  ytdlp: 'yt-dlp',
  browser: '内置浏览器兜底',
};

let infoScraperYtDlpWorkingCommand = null;

function infoScraperNormalizeCount(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const raw = String(value || '').trim().replace(/,/g, '');
  if (!raw) return 0;
  const chinese = raw.match(/([\d.]+)\s*(亿|万)/);
  if (chinese) return Math.round(Number(chinese[1]) * (chinese[2] === '亿' ? 100000000 : 10000)) || 0;
  const compact = raw.match(/([\d.]+)\s*([kmb])/i);
  if (compact) {
    const unit = compact[2].toLowerCase();
    const base = Number(compact[1]) || 0;
    return Math.round(base * (unit === 'k' ? 1000 : unit === 'm' ? 1000000 : 1000000000));
  }
  const num = Number(raw.replace(/[^\d.]/g, ''));
  return Number.isFinite(num) ? Math.round(num) : 0;
}

function infoScraperText(value) {
  return String(value == null ? '' : value).trim();
}

function infoScraperIdFromUrl(url) {
  const text = infoScraperText(url);
  if (!text) return '';
  try {
    const u = new URL(text);
    const m = u.pathname.match(/\/video\/(\d+)/i) || u.pathname.match(/(?:aweme_id|item_id)[=/](\d+)/i);
    if (m) return m[1];
    const q = u.searchParams.get('item_id') || u.searchParams.get('aweme_id') || u.searchParams.get('id');
    if (q) return q;
  } catch {}
  const fallback = text.match(/(?:video|item|aweme)[^\d]*(\d{8,})/i);
  return fallback ? fallback[1] : '';
}

function infoScraperAccountLabelFromUrl(url) {
  const text = infoScraperText(url);
  try {
    const u = new URL(text);
    const at = u.pathname.match(/@([^/?#]+)/);
    if (at) return '@' + decodeURIComponent(at[1]);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch {
    return text.slice(0, 80);
  }
}

function infoScraperYtDlpCandidates() {
  const roots = [];
  if (process.resourcesPath) {
    roots.push(process.resourcesPath);
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked'));
  }
  roots.push(__dirname);
  try { roots.push(path.dirname(app.getPath('exe'))); } catch {}
  try { roots.push(app.getPath('userData')); } catch {}
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    if (!root || seen.has(root)) continue;
    seen.add(root);
    for (const rel of ['bin/yt-dlp.exe', 'yt-dlp.exe', 'bin/yt-dlp', 'yt-dlp']) {
      const full = path.join(root, rel);
      if (fs.existsSync(full)) out.push({ label: '内置 yt-dlp', command: [full], path: full });
    }
  }
  out.push({ label: 'PATH yt-dlp', command: ['yt-dlp'] });
  out.push({ label: 'Python yt_dlp', command: ['python', '-m', 'yt_dlp'] });
  out.push({ label: 'Python launcher yt_dlp', command: ['py', '-m', 'yt_dlp'] });
  return out;
}

function runInfoScraperCommand(spec, args, options = {}) {
  return new Promise(resolve => {
    const command = spec.command[0];
    const finalArgs = spec.command.slice(1).concat(args || []);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 120000);
    const maxBuffer = Math.max(1024 * 1024, Number(options.maxBuffer) || 160 * 1024 * 1024);
    let child;
    let stdout = '';
    let stderr = '';
    let killed = false;
    try {
      child = spawn(command, finalArgs, { windowsHide: true, cwd: __dirname });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout, stderr, error: err && err.message ? err.message : String(err), label: spec.label });
      return;
    }
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', data => {
      stdout += data.toString('utf8');
      if (stdout.length > maxBuffer) {
        killed = true;
        try { child.kill('SIGKILL'); } catch {}
      }
    });
    child.stderr.on('data', data => {
      stderr += data.toString('utf8');
      if (stderr.length > maxBuffer) stderr = stderr.slice(-maxBuffer);
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr, error: err && err.message ? err.message : String(err), label: spec.label });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        ok: !killed && code === 0,
        code,
        stdout,
        stderr,
        error: killed ? '命令超时或输出过大' : '',
        label: spec.label,
        command,
      });
    });
  });
}

async function resolveInfoScraperYtDlpCommand() {
  if (infoScraperYtDlpWorkingCommand) return infoScraperYtDlpWorkingCommand;
  for (const spec of infoScraperYtDlpCandidates()) {
    const probe = await runInfoScraperCommand(spec, ['--version'], { timeoutMs: 8000, maxBuffer: 512 * 1024 });
    if (probe.ok) {
      infoScraperYtDlpWorkingCommand = { ...spec, version: infoScraperText(probe.stdout || probe.stderr).split(/\s+/)[0] };
      return infoScraperYtDlpWorkingCommand;
    }
  }
  return null;
}

async function getInfoScraperExtractorStatus() {
  const command = await resolveInfoScraperYtDlpCommand();
  return {
    ok: true,
    primary: command ? 'yt-dlp 可用：' + (command.version || command.label || '') : 'yt-dlp 未检测到，将只用内置浏览器兜底',
    ytdlpAvailable: !!command,
    ytdlpVersion: command && command.version || '',
    ytdlpLabel: command && command.label || '',
    browserFallback: true,
    strategy: '先用 yt-dlp 的 TikTok 用户页提取器；失败时复用内置浏览器登录态读取当前可见作品。',
  };
}

async function writeInfoScraperCookieJar() {
  try {
    const ses = session.fromPartition(VIDEO_SNIFFER_PARTITION);
    const cookies = await ses.cookies.get({});
    const keep = cookies.filter(cookie => /(^|\.)tiktok\.com$/i.test(String(cookie.domain || '').replace(/^\./, '')) || /\.tiktok\.com$/i.test(String(cookie.domain || '')));
    if (!keep.length) return '';
    const lines = ['# Netscape HTTP Cookie File'];
    for (const cookie of keep) {
      const domain = String(cookie.domain || '').startsWith('.') ? String(cookie.domain) : '.' + String(cookie.domain || 'tiktok.com');
      const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
      const cookiePath = cookie.path || '/';
      const secure = cookie.secure ? 'TRUE' : 'FALSE';
      const expiry = Math.max(0, Math.round(Number(cookie.expirationDate) || Math.floor(Date.now() / 1000) + 86400));
      lines.push([domain, includeSubdomains, cookiePath, secure, expiry, cookie.name || '', cookie.value || ''].join('\t'));
    }
    const target = path.join(app.getPath('temp'), 'gaiwen-tiktok-cookies-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.txt');
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
    return target;
  } catch {
    return '';
  }
}

function parseYtDlpPayload(text) {
  const raw = infoScraperText(text);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const item = infoScraperText(line);
    if (!item || !item.startsWith('{')) continue;
    try { entries.push(JSON.parse(item)); } catch {}
  }
  return entries.length ? { entries } : null;
}

function collectYtDlpEntries(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.entries)) return payload.entries.filter(Boolean);
  return [payload];
}

function normalizeYtDlpVideo(raw, account, previousMap = {}) {
  const webpageUrl = infoScraperText(raw.webpage_url || raw.original_url || raw.url || raw.id);
  let videoUrl = webpageUrl;
  const accountUrl = account && account.url || '';
  const username = account && account.username || '';
  const id = infoScraperText(raw.id || infoScraperIdFromUrl(webpageUrl));
  if ((!/^https?:\/\//i.test(videoUrl)) && id && username && /tiktok\.com/i.test(accountUrl)) {
    videoUrl = 'https://www.tiktok.com/@' + username.replace(/^@/, '') + '/video/' + id;
  }
  if (!/^https?:\/\//i.test(videoUrl) && raw.url && /^https?:\/\//i.test(String(raw.url))) {
    videoUrl = String(raw.url);
  }
  const key = 'ytdlp:' + (id || videoUrl || crypto.createHash('sha1').update(JSON.stringify(raw).slice(0, 1200)).digest('hex').slice(0, 16));
  const previous = previousMap[key] || {};
  const playCount = infoScraperNormalizeCount(raw.view_count ?? raw.play_count ?? raw.statistics?.play_count ?? raw.stats?.playCount);
  const likeCount = infoScraperNormalizeCount(raw.like_count ?? raw.likeCount ?? raw.statistics?.digg_count ?? raw.stats?.diggCount);
  const commentCount = infoScraperNormalizeCount(raw.comment_count ?? raw.commentCount ?? raw.statistics?.comment_count ?? raw.stats?.commentCount);
  const shareCount = infoScraperNormalizeCount(raw.repost_count ?? raw.share_count ?? raw.shareCount ?? raw.statistics?.share_count ?? raw.stats?.shareCount);
  const durationSec = Math.round(Number(raw.duration ?? raw.duration_sec ?? raw.durationSeconds) || 0);
  const timestamp = Number(raw.timestamp || raw.release_timestamp || raw.create_time || 0);
  const title = infoScraperText(raw.title || raw.fulltitle || raw.description || raw.alt_title || account?.label || 'TikTok 作品');
  return {
    key,
    id,
    title,
    videoUrl,
    accountUrl,
    accountLabel: account && account.label || '',
    platform: account && account.platform || 'tiktok',
    uploader: infoScraperText(raw.uploader || raw.channel || raw.uploader_id || username || account?.label),
    playCount,
    likeCount,
    commentCount,
    shareCount,
    playGrowth: Math.max(0, playCount - (Number(previous.playCount) || 0)),
    likeGrowth: Math.max(0, likeCount - (Number(previous.likeCount) || 0)),
    commentGrowth: Math.max(0, commentCount - (Number(previous.commentCount) || 0)),
    shareGrowth: Math.max(0, shareCount - (Number(previous.shareCount) || 0)),
    durationSec,
    createdAt: timestamp ? new Date(timestamp * 1000).toISOString() : '',
    scrapedAt: new Date().toISOString(),
    source: 'yt-dlp',
    score: playCount + likeCount * 12 + commentCount * 25 + shareCount * 35,
  };
}

async function extractInfoScraperYtDlpVideos(account, maxVideos, previousMap = {}) {
  const command = await resolveInfoScraperYtDlpCommand();
  if (!command) return { ok: false, error: '未找到 yt-dlp：请确认安装包内有 bin/yt-dlp.exe，或系统 PATH/Python 中可运行 yt-dlp' };
  const cookieJar = await writeInfoScraperCookieJar();
  const common = [
    '--dump-single-json',
    '--no-warnings',
    '--ignore-errors',
    '--skip-download',
    '--playlist-end', String(Math.max(1, Math.min(300, Number(maxVideos) || 50))),
    '--extractor-retries', '3',
    '--socket-timeout', '30',
    '--force-ipv4',
  ];
  if (cookieJar) common.push('--cookies', cookieJar);
  common.push(account.url);
  let result = await runInfoScraperCommand(command, common, { timeoutMs: 240000, maxBuffer: 180 * 1024 * 1024 });
  if (!result.ok || !parseYtDlpPayload(result.stdout)) {
    const flat = [
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--ignore-errors',
      '--playlist-end', String(Math.max(1, Math.min(300, Number(maxVideos) || 50))),
    ];
    if (cookieJar) flat.push('--cookies', cookieJar);
    flat.push(account.url);
    result = await runInfoScraperCommand(command, flat, { timeoutMs: 180000, maxBuffer: 180 * 1024 * 1024 });
  }
  if (cookieJar) {
    try { fs.unlinkSync(cookieJar); } catch {}
  }
  const payload = parseYtDlpPayload(result.stdout);
  const entries = collectYtDlpEntries(payload);
  const normalized = entries
    .map(item => normalizeYtDlpVideo(item, account, previousMap))
    .filter(item => item.videoUrl || item.id || item.title)
    .slice(0, maxVideos);
  if (!normalized.length) {
    return {
      ok: false,
      error: result.error || infoScraperText(result.stderr).slice(0, 500) || 'yt-dlp 没有返回作品列表',
      stderr: result.stderr,
      command: command.label,
    };
  }
  return {
    ok: true,
    source: 'yt-dlp',
    command: command.label,
    version: command.version || '',
    videos: normalized,
  };
}

function normalizeBrowserFallbackVideo(raw, account, previousMap = {}) {
  const videoUrl = infoScraperText(raw.videoUrl || raw.url || raw.href);
  const id = infoScraperText(raw.id || infoScraperIdFromUrl(videoUrl));
  const key = 'browser:' + (id || videoUrl || crypto.createHash('sha1').update(JSON.stringify(raw).slice(0, 1200)).digest('hex').slice(0, 16));
  const previous = previousMap[key] || {};
  const playCount = infoScraperNormalizeCount(raw.playCount ?? raw.views ?? raw.viewText);
  const likeCount = infoScraperNormalizeCount(raw.likeCount ?? raw.likes);
  const commentCount = infoScraperNormalizeCount(raw.commentCount ?? raw.comments);
  const shareCount = infoScraperNormalizeCount(raw.shareCount ?? raw.shares);
  const title = infoScraperText(raw.title || raw.desc || raw.description || account.label || 'TikTok 作品');
  const durationSec = Math.round(Number(raw.durationSec || raw.duration || 0) || 0);
  return {
    key,
    id,
    title,
    videoUrl,
    accountUrl: account.url,
    accountLabel: account.label,
    platform: account.platform || 'tiktok',
    uploader: account.username || account.label,
    playCount,
    likeCount,
    commentCount,
    shareCount,
    playGrowth: Math.max(0, playCount - (Number(previous.playCount) || 0)),
    likeGrowth: Math.max(0, likeCount - (Number(previous.likeCount) || 0)),
    commentGrowth: Math.max(0, commentCount - (Number(previous.commentCount) || 0)),
    shareGrowth: Math.max(0, shareCount - (Number(previous.shareCount) || 0)),
    durationSec,
    createdAt: '',
    scrapedAt: new Date().toISOString(),
    source: 'browser',
    score: playCount + likeCount * 12 + commentCount * 25 + shareCount * 35,
  };
}

async function extractInfoScraperBrowserVideos(account, maxVideos, previousMap = {}) {
  const pageFallback = await extractVisibleTikhubPageVideos({ accountUrl: account.url, maxVideos, silent: true });
  if (!pageFallback || !pageFallback.ok || !Array.isArray(pageFallback.videos) || !pageFallback.videos.length) {
    return { ok: false, error: (pageFallback && pageFallback.error) || '内置浏览器没有读到当前可见作品列表' };
  }
  const videos = pageFallback.videos
    .map(item => normalizeBrowserFallbackVideo(item, account, previousMap))
    .filter(item => item.videoUrl || item.id || item.title)
    .slice(0, maxVideos);
  return {
    ok: !!videos.length,
    source: 'browser',
    videos,
    exhausted: pageFallback.exhausted,
    scrollRounds: pageFallback.scrollRounds || 0,
    error: videos.length ? '' : '内置浏览器没有整理出可用作品',
  };
}

async function refreshInfoScraperAccounts(options = {}) {
  if (infoScraperPolling) return { ok: false, error: '信息抓取正在轮询中，请稍后再试' };
  let state = readInfoScraperState();
  const ids = Array.isArray(options.accountIds) ? new Set(options.accountIds.map(String)) : null;
  const targets = state.accounts.filter(account => account && account.enabled !== false && (!ids || ids.has(String(account.id))));
  if (!targets.length) return { ok: false, error: '没有可轮询的账号，请先保存账号' };
  const maxVideos = Math.max(1, Math.min(300, Number(options.maxVideos || state.maxVideos) || 50));
  const reason = String(options.reason || 'manual');
  infoScraperPolling = true;
  sendInfoScraperEvent({ type: 'start', message: '开始信息抓取：' + targets.length + ' 个账号；主引擎 yt-dlp，失败走内置浏览器兜底' });

  try {
    let totalVideos = 0;
    let totalNew = 0;
    let totalGrowth = 0;
    for (const target of targets) {
      state = readInfoScraperState();
      const accountIndex = state.accounts.findIndex(item => item.id === target.id);
      if (accountIndex < 0) continue;
      const account = state.accounts[accountIndex];
      const previousMap = previousVideoMapForInfoScraper(state, account.id);
      sendInfoScraperEvent({ type: 'account', accountId: account.id, message: account.label + '：开始抓取 ' + maxVideos + ' 条作品' });
      try {
        let extract = await extractInfoScraperYtDlpVideos(account, maxVideos, previousMap);
        let partialNote = '';
        if (!extract.ok || !extract.videos.length) {
          const ytdlpError = extract.error || 'yt-dlp 没有返回可用作品';
          sendInfoScraperEvent({ type: 'fallback', accountId: account.id, message: account.label + '：yt-dlp 未拿到数据，改用内置浏览器兜底；' + ytdlpError });
          extract = await extractInfoScraperBrowserVideos(account, maxVideos, previousMap);
          if (extract.ok && extract.exhausted && extract.videos.length < maxVideos) {
            partialNote = '浏览器页面实际加载 ' + extract.videos.length + '/' + maxVideos + ' 条，已深度滚动 ' + (extract.scrollRounds || 0) + ' 轮；如果账号确实有更多作品，通常是 TikTok 懒加载、登录提示或地区限制没有继续放出。';
          }
        }

        const normalized = (extract.videos || [])
          .filter(item => item.videoUrl || item.id || item.title)
          .sort((a, b) => (b.playCount || 0) - (a.playCount || 0) || String(a.videoUrl).localeCompare(String(b.videoUrl)))
          .slice(0, maxVideos);
        const previousKeys = new Set(Object.keys(previousMap));
        const newCount = normalized.filter(item => item.key && !previousKeys.has(item.key)).length;
        const growthCount = normalized.filter(item => Number(item.playGrowth) > 0 || Number(item.likeGrowth) > 0 || Number(item.commentGrowth) > 0 || Number(item.shareGrowth) > 0).length;
        account.lastPolledAt = new Date().toISOString();
        account.lastVideoCount = normalized.length;
        account.lastNewCount = newCount;
        account.lastGrowthCount = growthCount;
        account.lastError = normalized.length ? '' : ((extract && extract.error) || '没有抓到当前账号作品');
        account.lastPartialNote = partialNote;
        account.lastExtractor = extract.source || '';
        account.updatedAt = account.lastPolledAt;
        state.snapshots[account.id] = { updatedAt: account.lastPolledAt, source: extract.source || 'unknown', videos: normalized };
        appendInfoScraperEvent(state, {
          type: normalized.length ? 'success' : 'warning',
          accountId: account.id,
          message: account.label + '：作品 ' + normalized.length + ' 条，新作品 ' + newCount + ' 条，有增长 ' + growthCount + ' 条；来源 ' + (INFO_SCRAPER_SOURCE_LABELS[extract.source] || extract.source || '未知') + (partialNote ? '；' + partialNote : '') + (account.lastError ? '；' + account.lastError : ''),
        });
        totalVideos += normalized.length;
        totalNew += newCount;
        totalGrowth += growthCount;
        state.accounts[accountIndex] = account;
        state.lastPollAt = new Date().toISOString();
        state.lastPollReason = reason;
        writeInfoScraperState(state);
        sendInfoScraperEvent({ type: 'account-done', accountId: account.id, message: account.label + '：完成，' + normalized.length + ' 条作品' });
      } catch (err) {
        account.lastPolledAt = new Date().toISOString();
        account.lastError = err && err.message ? err.message : String(err);
        state.accounts[accountIndex] = account;
        appendInfoScraperEvent(state, { type: 'error', accountId: account.id, message: account.label + '：' + account.lastError });
        writeInfoScraperState(state);
        sendInfoScraperEvent({ type: 'account-error', accountId: account.id, message: account.label + '：' + account.lastError });
      }
    }
    state = readInfoScraperState();
    appendInfoScraperEvent(state, { type: 'done', message: '信息抓取完成：作品 ' + totalVideos + ' 条，新作品 ' + totalNew + ' 条，有增长 ' + totalGrowth + ' 条' });
    state.lastPollAt = new Date().toISOString();
    state.lastPollReason = reason;
    if (options.slotKey) state.completedSlots[options.slotKey] = state.lastPollAt;
    writeInfoScraperState(state);
    sendInfoScraperEvent({ type: 'done', message: '信息抓取完成：作品 ' + totalVideos + ' 条' });
    return infoScraperPublicState(state);
  } finally {
    infoScraperPolling = false;
    sendInfoScraperEvent({ type: 'idle', message: '信息抓取空闲' });
  }
}
async function runDueInfoScraperPoll() {
  if (infoScraperPolling) return;
  const state = readInfoScraperState();
  if (!state.accounts.some(account => account.enabled !== false)) return;
  const now = new Date();
  const hour = now.getHours();
  const dueHour = INFO_SCRAPER_POLL_HOURS.filter(item => hour >= item).pop();
  if (dueHour == null) return;
  const slot = infoScraperSlotKey(now);
  if (state.completedSlots && state.completedSlots[slot]) return;
  try {
    await refreshInfoScraperAccounts({ reason: 'auto', slotKey: slot });
  } catch (err) {
    const next = readInfoScraperState();
    appendInfoScraperEvent(next, { type: 'error', message: '自动轮询失败：' + (err && err.message ? err.message : String(err)) });
    writeInfoScraperState(next);
  }
}

function scheduleInfoScraperPolling() {
  if (infoScraperPollTimer) clearInterval(infoScraperPollTimer);
  setTimeout(() => runDueInfoScraperPoll().catch(() => {}), 8000);
  infoScraperPollTimer = setInterval(() => {
    runDueInfoScraperPoll().catch(() => {});
  }, 30 * 60 * 1000);
}


const IMPORT_URL_RE = /https?:\/\/(?:(?!https?:\/\/)[^\s"'<>])+/gi;

function cleanupImportedUrl(url) {
  return String(url || '')
    .trim()
    .replace(/[，。；、]+$/g, '')
    .replace(/[,.]+$/g, '');
}

function extractUrlsFromText(text) {
  const raw = String(text || '');
  const urls = raw.match(IMPORT_URL_RE) || [];
  return urls.map(cleanupImportedUrl).filter(Boolean);
}

function canonicalImportedUrlKey(url) {
  const clean = cleanupImportedUrl(url);
  if (!clean) return '';
  try {
    const u = new URL(clean);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    const episodeKeys = new Set(['episode', 'ep', 'eps', 'e', 'chapter', 'chapter_id']);
    const dropKeys = new Set(['from', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']);
    for (const key of Array.from(u.searchParams.keys())) {
      const lower = String(key || '').toLowerCase();
      const value = u.searchParams.get(key) || '';
      if (episodeKeys.has(lower) && /^\d{1,4}$/.test(value)) u.searchParams.delete(key);
      if (dropKeys.has(lower)) u.searchParams.delete(key);
    }
    u.pathname = u.pathname
      .replace(/(\/(?:vodplay|play)\/[^\/?#]+?-\d{1,4}-)\d{1,4}(\.html)$/i, '$1EP$2')
      .replace(/([\/_-])(?:episode|ep)([\/_-]?)\d{1,4}(?=$|[\/_-])/i, '$1ep$2EP')
      .replace(/-ep-\d{1,4}(?=$|[\/?#_-])/i, '-ep-EP');
    if (!/^#\/player\?/i.test(u.hash || '')) u.hash = '';
    return u.toString().replace(/[?#]$/, '');
  } catch {
    return clean
      .replace(/([?&])(?:episode|ep|eps|e|chapter|chapter_id)=\d{1,4}\b/ig, '$1')
      .replace(/(\/(?:vodplay|play)\/[^\/?#]+?-\d{1,4}-)\d{1,4}(\.html)/i, '$1EP$2')
      .replace(/([\/_-])(?:episode|ep)([\/_-]?)\d{1,4}(?=$|[\/?#_-])/i, '$1ep$2EP')
      .replace(/-ep-\d{1,4}(?=$|[\/?#_-])/i, '-ep-EP');
  }
}

function normalizeImportedCell(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function isNoLinkCellText(text) {
  return /^(?:无|沒有|没有|暂无|無|no|none|n\/a|na|-|—|\/)$/i.test(normalizeImportedCell(text));
}

function looksLikeHeaderCell(text) {
  return /剧目|剧名|名称|标题|片名|name|title|link|url|链接|网址/i.test(String(text || ''));
}

function findHeaderRow(rows) {
  const limit = Math.min(rows.length, 12);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const text = row.map(normalizeImportedCell).join(' ');
    if (looksLikeHeaderCell(text) && /link|url|链接|网址/i.test(text)) return i;
  }
  return -1;
}

function findTitleColumn(headers) {
  const patterns = [/剧目名称/, /剧名/, /剧目/, /片名/, /标题/, /^名称$/, /name/i, /title/i];
  for (const pattern of patterns) {
    const idx = headers.findIndex(cell => pattern.test(normalizeImportedCell(cell)));
    if (idx >= 0) return idx;
  }
  return -1;
}

function rowTitleForImport(row, headers, urlCol) {
  const titleCol = findTitleColumn(headers || []);
  if (titleCol >= 0) {
    const value = normalizeImportedCell(row[titleCol]);
    if (value && !extractUrlsFromText(value).length) return value;
  }

  const second = normalizeImportedCell(row[1]);
  if (second && !/^\d+$/.test(second) && !extractUrlsFromText(second).length) return second;

  const beforeUrl = row
    .slice(0, Math.max(0, urlCol))
    .map(normalizeImportedCell)
    .filter(Boolean)
    .filter(value => !/^\d+$/.test(value))
    .filter(value => !extractUrlsFromText(value).length)
    .sort((a, b) => b.length - a.length)[0];
  if (beforeUrl) return beforeUrl;

  const anyText = row
    .map(normalizeImportedCell)
    .filter(Boolean)
    .filter(value => !/^\d+$/.test(value))
    .filter(value => !extractUrlsFromText(value).length)
    .sort((a, b) => b.length - a.length)[0];
  return anyText || '';
}

function collectImportedRows(rows, sourceName, options = {}) {
  const items = [];
  const seen = new Set();
  const headerIndex = findHeaderRow(rows);
  const headers = headerIndex >= 0 ? (rows[headerIndex] || []) : [];
  const isHiddenCell = typeof options.isHiddenCell === 'function' ? options.isHiddenCell : () => false;

  rows.forEach((rawRow, rowIndex) => {
    if (rowIndex === headerIndex) return;
    const row = Array.isArray(rawRow) ? rawRow : [];
    row.forEach((cell, colIndex) => {
      if (isHiddenCell(rowIndex, colIndex)) return;
      const urls = extractUrlsFromText(cell);
      urls.forEach(url => {
        const key = canonicalImportedUrlKey(url) || url;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({
          title: rowTitleForImport(row, headers, colIndex),
          url,
          source: sourceName || '',
          row: rowIndex + 1,
          column: colIndex + 1,
        });
      });
    });
  });

  return items;
}

function spreadsheetHiddenCellChecker(sheet) {
  const hiddenRows = new Set();
  const hiddenCols = new Set();
  const rows = Array.isArray(sheet && sheet['!rows']) ? sheet['!rows'] : [];
  const cols = Array.isArray(sheet && sheet['!cols']) ? sheet['!cols'] : [];
  rows.forEach((row, index) => {
    if (row && row.hidden) hiddenRows.add(index);
  });
  cols.forEach((col, index) => {
    if (col && col.hidden) hiddenCols.add(index);
  });
  return (rowIndex, colIndex) => hiddenRows.has(rowIndex) || hiddenCols.has(colIndex);
}

function parseSpreadsheetLinks(filePath) {
  if (!xlsx) throw new Error('缺少 xlsx 解析库，请重新安装依赖后再试');
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const items = [];
  workbook.SheetNames.forEach(sheetName => {
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    const isHiddenCell = spreadsheetHiddenCellChecker(sheet);
    items.push(...collectImportedRows(rows, sheetName, { isHiddenCell }));
    const headerIndex = findHeaderRow(rows);
    const headers = headerIndex >= 0 ? (rows[headerIndex] || []) : [];
    Object.keys(sheet).forEach(address => {
      if (!/^[A-Z]+[0-9]+$/i.test(address)) return;
      const cell = sheet[address];
      const target = cell && cell.l && cell.l.Target ? cleanupImportedUrl(cell.l.Target) : '';
      if (!/^https?:\/\//i.test(target)) return;
      const pos = xlsx.utils.decode_cell(address);
      if (isHiddenCell(pos.r, pos.c)) return;
      const row = rows[pos.r] || [];
      const visibleText = normalizeImportedCell(row[pos.c] != null ? row[pos.c] : (cell && cell.w != null ? cell.w : cell && cell.v));
      if (isNoLinkCellText(visibleText)) return;
      items.push({
        title: rowTitleForImport(row, headers, pos.c),
        url: target,
        source: sheetName,
        row: pos.r + 1,
        column: pos.c + 1,
      });
    });
  });
  return items;
}

function splitLooseCsvLine(line) {
  return String(line || '')
    .split(/\t|,|，/)
    .map(normalizeImportedCell);
}

function parseTextLinks(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = text
    .split(/\r?\n/)
    .map(line => splitLooseCsvLine(line))
    .filter(row => row.some(Boolean));
  return collectImportedRows(rows, path.basename(filePath));
}

function parseImportedLinkFile(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  const rawItems = ['.xlsx', '.xls', '.xlsm'].includes(ext)
    ? parseSpreadsheetLinks(filePath)
    : parseTextLinks(filePath);
  const seen = new Set();
  const items = rawItems.filter(item => {
    const key = canonicalImportedUrlKey(item && item.url) || (item && item.url) || '';
    if (!item || !item.url || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    items,
    count: items.length,
    filePath,
    fileName: path.basename(filePath),
  };
}

const videoAnalysisAborts = new Set();

function episodeNoFromLocalVideoName(fileName) {
  const text = String(fileName || '');
  const patterns = [
    /s\d{1,3}e0*(\d{1,4})/i,
    /第\s*0*(\d{1,4})\s*集/i,
    /(?:^|[^\d])ep(?:isode)?[_\-\s]*0*(\d{1,4})(?:[^\d]|$)/i,
    /(?:^|[^\d])0*(\d{1,4})(?:[^\d]|$)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const n = Number(match[1]);
    if (n > 0 && n < 10000) return n;
  }
  return 0;
}

function localVideoFileInfo(target) {
  const stat = fs.statSync(target);
  const analysisPath = videoAnalysisOutputPathNoCreate(target);
  let analysisDone = false;
  try {
    analysisDone = fs.existsSync(analysisPath) && fs.statSync(analysisPath).size > 0;
  } catch {
    analysisDone = false;
  }
  return {
    path: target,
    name: path.basename(target),
    dir: path.dirname(target),
    episodeNo: episodeNoFromLocalVideoName(path.basename(target)),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    analysisPath,
    analysisDone,
  };
}

function sortLocalVideoFiles(files) {
  files.sort((a, b) =>
    a.dir.localeCompare(b.dir, 'zh-Hans-CN') ||
    (a.episodeNo || 999999) - (b.episodeNo || 999999) ||
    a.name.localeCompare(b.name, 'zh-Hans-CN')
  );
  return files;
}

function episodeLimitFromDirName(rootDir) {
  const parts = String(rootDir || '').split(/[\\\/]+/).filter(Boolean).reverse();
  for (const part of parts.slice(0, 3)) {
    const m = String(part || '').match(/[（(【\[]?\s*(\d{1,4})\s*集\s*[）)】\]]?/);
    if (m) {
      const n = Number(m[1]) || 0;
      if (n >= 2 && n <= 1000) return n;
    }
  }
  return 0;
}

function episodeLimitFromOutliers(items) {
  const eps = Array.from(new Set((Array.isArray(items) ? items : [])
    .map(item => Number(item && item.episodeNo) || 0)
    .filter(n => n > 0)))
    .sort((a, b) => a - b);
  if (eps.length < 6) return 0;
  for (let i = 0; i < eps.length - 1; i++) {
    const left = eps[i];
    const right = eps[i + 1];
    const gap = right - left;
    if (left >= 5 && gap > Math.max(50, left * 2)) return left;
  }
  return 0;
}

function filterEpisodeOutliers(items, rootDir) {
  const list = Array.isArray(items) ? items : [];
  const limit = episodeLimitFromDirName(rootDir) || episodeLimitFromOutliers(list);
  if (!limit) return list;
  return list.filter(item => {
    const ep = Number(item && item.episodeNo) || 0;
    return !ep || ep <= limit;
  });
}

function commonParentDir(filePaths) {
  const paths = (Array.isArray(filePaths) ? filePaths : []).filter(Boolean).map(p => path.resolve(p));
  if (!paths.length) return '';
  let dir = fs.statSync(paths[0]).isDirectory() ? paths[0] : path.dirname(paths[0]);
  while (dir && dir !== path.dirname(dir)) {
    const ok = paths.every(p => {
      const rel = path.relative(dir, p);
      return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (ok) return dir;
    dir = path.dirname(dir);
  }
  return dir || path.dirname(paths[0]);
}

function collectLocalVideoFiles(rootDir) {
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) throw new Error('视频目录不存在');
  const files = [];

  function walk(target) {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        walk(path.join(target, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    const ext = path.extname(target).toLowerCase();
    if (!LOCAL_VIDEO_EXTS.has(ext)) return;
    files.push(localVideoFileInfo(target));
  }

  walk(root);
  return sortLocalVideoFiles(filterEpisodeOutliers(files, root));
}

function parseSseBlockForMain(block) {
  const lines = String(block || '').split(/\r?\n/);
  let event = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return { event, data: null };
  const raw = dataLines.join('\n');
  const trimmed = raw.trim();
  if (trimmed === '[DONE]') return { event: 'done', data: {} };
  try {
    return { event, data: JSON.parse(trimmed) };
  } catch {
    return { event, data: { content: raw } };
  }
}

function deltaTextFromSseData(data) {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data.content === 'string') return data.content;
  if (typeof data.text === 'string') return data.text;
  if (typeof data.response === 'string') return data.response;
  if (typeof data.delta === 'string') return data.delta;
  if (data.choices && data.choices[0]) {
    const ch = data.choices[0];
    if (ch.delta && typeof ch.delta.content === 'string') return ch.delta.content;
    if (typeof ch.text === 'string') return ch.text;
    if (ch.message && typeof ch.message.content === 'string') return ch.message.content;
  }
  if (data.delta && typeof data.delta.text === 'string') return data.delta.text;
  return '';
}

const ANALYSIS_CACHE_DIR_NAME = '.video-analysis-cache';

function hidePathOnWindows(targetPath) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('attrib', ['+h', targetPath], { windowsHide: true, detached: true, stdio: 'ignore' });
    if (child && child.unref) child.unref();
  } catch {}
}

function ensureVideoAnalysisCacheDir(rootDir) {
  const dir = path.join(rootDir, ANALYSIS_CACHE_DIR_NAME);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  hidePathOnWindows(dir);
  return dir;
}

function videoAnalysisResultFileName(filePath) {
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  return safeFileName(base + '-视频解析', '视频解析') + '.txt';
}

function videoAnalysisOutputPathNoCreate(filePath) {
  const dir = path.dirname(filePath);
  return path.join(dir, ANALYSIS_CACHE_DIR_NAME, videoAnalysisResultFileName(filePath));
}

function videoAnalysisOutputPath(filePath) {
  const dir = path.dirname(filePath);
  return path.join(ensureVideoAnalysisCacheDir(dir), videoAnalysisResultFileName(filePath));
}

function isVideoAnalysisResultName(name) {
  return /视频解析\.txt$/i.test(String(name || ''));
}

function isAnalysisCacheDirName(name) {
  return String(name || '').toLowerCase() === ANALYSIS_CACHE_DIR_NAME.toLowerCase();
}

function isAnalysisCacheDirPath(target) {
  return isAnalysisCacheDirName(path.basename(path.resolve(String(target || ''))));
}

function isInsideAnalysisCache(target) {
  const parts = path.resolve(String(target || '')).split(/[\\\/]+/);
  return parts.some(isAnalysisCacheDirName);
}

function analysisResultScopeDir(target) {
  const dir = path.dirname(target);
  return isAnalysisCacheDirPath(dir) ? path.dirname(dir) : dir;
}

function uniqueFilePath(dir, fileName) {
  let target = path.join(dir, fileName);
  if (!fs.existsSync(target)) return target;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  for (let i = 2; i < 1000; i++) {
    target = path.join(dir, base + '-' + i + ext);
    if (!fs.existsSync(target)) return target;
  }
  return path.join(dir, base + '-' + Date.now() + ext);
}

function migrateVisibleAnalysisResults(rootDir) {
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) return 0;
  if (isAnalysisCacheDirPath(root)) return 0;
  const cacheDir = ensureVideoAnalysisCacheDir(root);
  const cacheResolved = path.resolve(cacheDir);
  let moved = 0;

  function moveIntoCache(filePath) {
    const target = uniqueFilePath(cacheDir, path.basename(filePath));
    try {
      fs.renameSync(filePath, target);
    } catch {
      fs.copyFileSync(filePath, target);
      fs.unlinkSync(filePath);
    }
    moved++;
  }

  function walk(target) {
    let stat;
    try { stat = fs.statSync(target); } catch { return; }
    if (stat.isDirectory()) {
      if (path.resolve(target) === cacheResolved) return;
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        walk(path.join(target, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    if (!isVideoAnalysisResultName(path.basename(target))) return;
    moveIntoCache(target);
  }

  walk(root);
  hidePathOnWindows(cacheDir);
  return moved;
}

// ============================================================
// 视频解析结果导出 —— 零依赖多格式生成器
// 支持：txt / md / html / csv / json / xlsx(真Excel) / docx(真Word)
// xlsx、docx 本质是 OOXML(zip)，下面手写一个最小 ZIP(store) 生成器。
// ============================================================
function exportXmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}
function exportHtmlEscape(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
let _exportCrcTable = null;
function exportCrc32(buf) {
  if (!_exportCrcTable) {
    _exportCrcTable = new Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _exportCrcTable[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ _exportCrcTable[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function exportZipStore(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = exportCrc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}
function exportBuildTxt(items, opts) {
  const title = (opts && opts.title) || '视频解析合集';
  const lines = [title, '导出时间：' + new Date().toLocaleString(), ''];
  for (const it of items) {
    lines.push('========== ' + (it.title || '') + ' ==========');
    lines.push(it.content || '(空)');
    lines.push('');
  }
  return lines.join('\n');
}
function exportBuildMarkdown(items, opts) {
  const title = (opts && opts.title) || '视频解析合集';
  const out = ['# ' + title, '', '> 导出时间：' + new Date().toLocaleString(), ''];
  for (const it of items) {
    out.push('## ' + (it.title || ''), '', it.content || '_(空)_', '');
  }
  return out.join('\n');
}
function exportBuildHtml(items, opts) {
  const title = (opts && opts.title) || '视频解析合集';
  const sections = items.map(it =>
    '<section><h2>' + exportHtmlEscape(it.title || '') + '</h2><pre>' + exportHtmlEscape(it.content || '') + '</pre></section>'
  ).join('\n');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>' + exportHtmlEscape(title) + '</title><style>' +
    'body{font:15px/1.7 "Microsoft YaHei",system-ui,sans-serif;max-width:820px;margin:32px auto;padding:0 16px;color:#222}' +
    'h1{border-bottom:2px solid #a93434;padding-bottom:8px}h2{color:#a93434;margin-top:28px}' +
    'pre{white-space:pre-wrap;word-break:break-word;background:#faf8f3;border:1px solid #eee;border-radius:6px;padding:12px;font:inherit}' +
    '.meta{color:#888;font-size:13px}</style></head><body><h1>' + exportHtmlEscape(title) + '</h1>' +
    '<p class="meta">导出时间：' + exportHtmlEscape(new Date().toLocaleString()) + ' · 共 ' + items.length + ' 集</p>' +
    sections + '</body></html>';
}
function exportCsvCell(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
function exportBuildCsv(items) {
  const rows = ['\uFEFF' + ['集数', '文件名', '解析内容'].map(exportCsvCell).join(',')];
  for (const it of items) rows.push([it.episodeNo || '', it.sourceName || '', it.content || ''].map(exportCsvCell).join(','));
  return rows.join('\r\n');
}
function exportBuildJson(items, opts) {
  return JSON.stringify({
    title: (opts && opts.title) || '视频解析合集',
    exportedAt: new Date().toISOString(),
    count: items.length,
    episodes: items.map(it => ({ episodeNo: it.episodeNo || null, sourceName: it.sourceName || '', content: it.content || '' })),
  }, null, 2);
}
function exportColA1(idx) {
  let s = ''; idx += 1;
  while (idx > 0) { const m = (idx - 1) % 26; s = String.fromCharCode(65 + m) + s; idx = Math.floor((idx - 1) / 26); }
  return s;
}
function exportXlsxCell(ref, text) {
  return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + exportXmlEscape(text) + '</t></is></c>';
}
function exportBuildXlsx(items, opts) {
  const headers = ['集数', '文件名', '解析内容'];
  const rowsXml = [];
  let r = 1;
  rowsXml.push('<row r="' + r + '">' + headers.map((h, i) => exportXlsxCell(exportColA1(i) + r, h)).join('') + '</row>');
  for (const it of items) {
    r++;
    const cells = [String(it.episodeNo || ''), String(it.sourceName || ''), String(it.content || '')];
    rowsXml.push('<row r="' + r + '">' + cells.map((c, i) => exportXlsxCell(exportColA1(i) + r, c)).join('') + '</row>');
  }
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<cols><col min="1" max="1" width="8"/><col min="2" max="2" width="36"/><col min="3" max="3" width="90"/></cols>' +
    '<sheetData>' + rowsXml.join('') + '</sheetData></worksheet>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="视频解析" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  return exportZipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}
function exportDocxParagraph(text, bold, size) {
  const rpr = (bold || size) ? '<w:rPr>' + (bold ? '<w:b/>' : '') + (size ? '<w:sz w:val="' + size + '"/>' : '') + '</w:rPr>' : '';
  const ppr = (size) ? '<w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>' : '';
  return '<w:p>' + ppr + '<w:r>' + rpr + '<w:t xml:space="preserve">' + exportXmlEscape(text) + '</w:t></w:r></w:p>';
}
function exportBuildDocx(items, opts) {
  const title = (opts && opts.title) || '视频解析合集';
  const body = [];
  body.push(exportDocxParagraph(title, true, 40));
  body.push(exportDocxParagraph('导出时间：' + new Date().toLocaleString() + ' · 共 ' + items.length + ' 集', false, 0));
  for (const it of items) {
    body.push(exportDocxParagraph(it.title || '', true, 30));
    const content = String(it.content || '');
    const lines = content.length ? content.split(/\r?\n/) : ['(空)'];
    for (const ln of lines) body.push(exportDocxParagraph(ln, false, 0));
  }
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>';
  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  return exportZipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rootRels },
    { name: 'word/document.xml', data: document },
  ]);
}
function buildAnalysisExport(format, items, opts) {
  const f = String(format || 'txt').toLowerCase();
  switch (f) {
    case 'md':   return { ext: 'md',   buffer: Buffer.from(exportBuildMarkdown(items, opts), 'utf8') };
    case 'html': return { ext: 'html', buffer: Buffer.from(exportBuildHtml(items, opts), 'utf8') };
    case 'csv':  return { ext: 'csv',  buffer: Buffer.from(exportBuildCsv(items), 'utf8') };
    case 'json': return { ext: 'json', buffer: Buffer.from(exportBuildJson(items, opts), 'utf8') };
    case 'xlsx': return { ext: 'xlsx', buffer: exportBuildXlsx(items, opts) };
    case 'docx': return { ext: 'docx', buffer: exportBuildDocx(items, opts) };
    case 'txt':
    default:     return { ext: 'txt',  buffer: Buffer.from(exportBuildTxt(items, opts), 'utf8') };
  }
}

function analysisBaseName(name) {
  return String(name || '').replace(/-?视频解析\.txt$/i, '');
}

function splitPartNoFromAnalysisName(name) {
  const base = analysisBaseName(name);
  const match = base.match(/(?:^|[-_\s])part[-_\s]*0*(\d{1,4})(?:[^\d]|$)/i);
  if (!match) return -1;
  return Number(match[1]);
}

function splitSourceBaseFromAnalysisName(name) {
  return analysisBaseName(name)
    .replace(/[-_\s]*part[-_\s]*0*\d{1,4}$/i, '')
    .replace(/[-_\s]+$/g, '')
    .trim();
}

function analysisDisplayBase(base, scopeDir) {
  const fromBase = String(base || '').trim();
  if (fromBase) return fromBase;
  const dirName = path.basename(String(scopeDir || '')).replace(/-切分(?:-\d+)?$/i, '').trim();
  return dirName || '视频解析';
}

function readAnalysisRecord(target, rootResolved, fromCache) {
  const name = path.basename(target);
  if (!isVideoAnalysisResultName(name)) return null;
  let content = '';
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (e) {
    content = '(读取失败：' + (e && e.message ? e.message : e) + ')';
  }
  const base = analysisBaseName(name);
  const splitPartNo = splitPartNoFromAnalysisName(name);
  const splitBase = splitPartNo >= 0 ? splitSourceBaseFromAnalysisName(name) : '';
  const scopeDir = analysisResultScopeDir(target);
  const scopeKey = path.relative(rootResolved, path.resolve(scopeDir)) || '.';
  const displayBase = analysisDisplayBase(splitBase || base, scopeDir);
  const episodeNo = episodeNoFromLocalVideoName(displayBase) || episodeNoFromLocalVideoName(path.basename(scopeDir)) || episodeNoFromLocalVideoName(name);
  return {
    target,
    fromCache: !!fromCache,
    name,
    base,
    splitPartNo,
    splitBase: displayBase,
    scopeDir,
    scopeKey,
    episodeNo,
    title: episodeNo ? ('第' + episodeNo + '集') : displayBase,
    sourceName: name,
    content,
  };
}

function normalizeAnalysisRecords(records, rootDir) {
  const splitGroups = new Map();
  const byKey = new Map();
  const list = Array.isArray(records) ? records.filter(Boolean) : [];

  for (const record of list) {
    if (record.splitPartNo >= 0) {
      const key = 'split:' + record.scopeKey + '|' + record.splitBase;
      if (!splitGroups.has(key)) {
        splitGroups.set(key, {
          scopeKey: record.scopeKey,
          splitBase: record.splitBase,
          episodeNo: record.episodeNo,
          title: record.title,
          parts: [],
        });
      }
      splitGroups.get(key).parts.push(record);
      continue;
    }

    const key = record.episodeNo
      ? ('scope:' + record.scopeKey + '|ep:' + record.episodeNo)
      : ('file:' + record.scopeKey + '|' + record.name);
    if (record.fromCache || !byKey.has(key)) {
      byKey.set(key, {
        episodeNo: record.episodeNo,
        title: record.title,
        sourceName: record.sourceName,
        content: record.content,
      });
    }
  }

  for (const group of splitGroups.values()) {
    group.parts.sort((a, b) =>
      (a.splitPartNo - b.splitPartNo) ||
      a.sourceName.localeCompare(b.sourceName, 'zh-Hans-CN'));
    const total = group.parts.length;
    const content = group.parts.map((part, index) => {
      const label = '【切分片段 ' + String(index + 1).padStart(2, '0') + '/' + total + ' · ' + part.sourceName + '】';
      return label + '\n' + (part.content || '(空)');
    }).join('\n\n');
    const key = group.episodeNo
      ? ('scope:' + group.scopeKey + '|ep:' + group.episodeNo)
      : ('split:' + group.scopeKey + '|' + group.splitBase);
    byKey.set(key, {
      episodeNo: group.episodeNo,
      title: group.title || group.splitBase,
      sourceName: group.splitBase + '-视频解析合集.txt',
      content,
    });
  }

  const found = filterEpisodeOutliers(Array.from(byKey.values()), rootDir);
  found.sort((a, b) =>
    (a.episodeNo || 999999) - (b.episodeNo || 999999) ||
    a.sourceName.localeCompare(b.sourceName, 'zh-Hans-CN'));
  return found;
}

// 扫描目录里所有「…视频解析.txt」结果，按集数排序
function collectAnalysisResults(rootDir) {
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) throw new Error('目录不存在：' + root);
  const rootResolved = path.resolve(root);
  const records = [];

  function addResult(target, fromCache) {
    const record = readAnalysisRecord(target, rootResolved, fromCache);
    if (record) records.push(record);
  }

  function walk(target) {
    let stat;
    try { stat = fs.statSync(target); } catch { return; }
    if (stat.isDirectory()) {
      const isRoot = path.resolve(target) === rootResolved;
      const dirName = path.basename(target);
      if (!isRoot && dirName.startsWith('.') && !isAnalysisCacheDirName(dirName)) return;
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('.') && !isAnalysisCacheDirName(entry.name)) continue;
        walk(path.join(target, entry.name));
      }
      return;
    }
    if (!stat.isFile()) return;
    addResult(target, isInsideAnalysisCache(target));
  }

  walk(root);
  return normalizeAnalysisRecords(records, root);
}

// 只整合用户指定目录当前层级里的「…视频解析.txt」，不递归子目录。
function collectAnalysisResultsInCurrentDir(rootDir) {
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) throw new Error('目录不存在：' + root);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error('请选择一个目录进行整合');
  const rootResolved = path.resolve(root);
  const byName = new Map();

  function addAnalysisFile(target, name, prefer) {
    const record = readAnalysisRecord(target, rootResolved, prefer);
    if (record && (prefer || !byName.has(name))) byName.set(name, record);
  }

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    addAnalysisFile(path.join(root, entry.name), entry.name);
  }

  const cacheDir = path.join(root, ANALYSIS_CACHE_DIR_NAME);
  if (fs.existsSync(cacheDir) && fs.statSync(cacheDir).isDirectory()) {
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      addAnalysisFile(path.join(cacheDir, entry.name), entry.name, true);
    }
  }
  return normalizeAnalysisRecords(Array.from(byName.values()), root);
}

function collectAnalysisResultsForFiles(filePaths) {
  const files = sortLocalVideoFiles((Array.isArray(filePaths) ? filePaths : [])
    .map(filePath => String(filePath || ''))
    .filter(filePath => filePath && fs.existsSync(filePath))
    .filter(filePath => {
      try {
        return fs.statSync(filePath).isFile() && LOCAL_VIDEO_EXTS.has(path.extname(filePath).toLowerCase());
      } catch {
        return false;
      }
    })
    .map(localVideoFileInfo));
  const rootDir = commonParentDir(files.map(file => file.path));
  const rootResolved = path.resolve(rootDir || process.cwd());
  const records = [];
  for (const file of files) {
    const resultPath = videoAnalysisOutputPath(file.path);
    if (!fs.existsSync(resultPath)) continue;
    const record = readAnalysisRecord(resultPath, rootResolved, true);
    if (record) records.push(record);
  }
  return normalizeAnalysisRecords(records, rootDir);
}

function hasDirectLocalVideoFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some(entry => {
      if (!entry.isFile()) return false;
      return LOCAL_VIDEO_EXTS.has(path.extname(entry.name).toLowerCase());
    });
  } catch {
    return false;
  }
}

function hasDirectAnalysisResults(dir) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && isVideoAnalysisResultName(entry.name)) return true;
    }
    const cacheDir = path.join(dir, ANALYSIS_CACHE_DIR_NAME);
    if (fs.existsSync(cacheDir) && fs.statSync(cacheDir).isDirectory()) {
      return fs.readdirSync(cacheDir, { withFileTypes: true })
        .some(entry => entry.isFile() && isVideoAnalysisResultName(entry.name));
    }
  } catch {}
  return false;
}

function hasAnalysisResultsRecursive(dir) {
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isFile()) {
        if (isVideoAnalysisResultName(entry.name)) return true;
        continue;
      }
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && !isAnalysisCacheDirName(entry.name)) continue;
      stack.push(target);
    }
  }
  return false;
}

function isEpisodeLikeExportDirName(name) {
  const text = String(name || '');
  return /s\d{1,3}e\d{1,4}/i.test(text) ||
    /(?:^|[^\d])ep(?:isode)?[_\-\s]*0*\d{1,4}(?:[^\d]|$)/i.test(text) ||
    /第\s*0*\d{1,4}\s*集/i.test(text) ||
    /(?:^|[-_\s])part[-_\s]*0*\d{1,4}(?:[^\d]|$)/i.test(text) ||
    /切分/i.test(text);
}

function childAnalysisExportDirs(rootDir) {
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) return [];
  let stat;
  try { stat = fs.statSync(root); } catch { return []; }
  if (!stat.isDirectory()) return [];
  const rootHasOwnResults = hasDirectAnalysisResults(root) || hasDirectLocalVideoFiles(root);
  if (rootHasOwnResults) return [];

  const dirs = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (isAnalysisCacheDirName(entry.name)) continue;
    if (isEpisodeLikeExportDirName(entry.name)) continue;
    const target = path.join(root, entry.name);
    if (hasAnalysisResultsRecursive(target)) dirs.push(target);
  }
  dirs.sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-Hans-CN'));
  return dirs;
}

function videoMimeType(filePath) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.mkv') return 'video/x-matroska';
  if (ext === '.m4v') return 'video/x-m4v';
  return 'video/mp4';
}

// 真实的“视频转 URL”接口（与 Web 端 mj.api.meidawenhua.com 完全一致；注意都【没有】/api/c 前缀）：
//   主路线 = 七牛云直传（两步），Web 端 edit.vue 上传剪辑后的 MP4 用的就是这条：
//     ① GET  /api/upload/token?filename=&type=compose → { code:0, data:{ token, key, uploadUrl, domain } }
//     ② POST <uploadUrl>（七牛地址，这一步【不带】Authorization）  FormData: token, key, file
//     ③ 最终可访问 URL = domain + '/' + key
//   回退路线 = 后端通用代理上传 /api/upload（multipart: file + type='reference'），仅适合小文件。
// 旧版 /api/c/*upload 那一批是猜的，后端根本没有，所以全 404。
const VIDEO_URL_TOKEN_ENDPOINT = '/api/upload/token';
const VIDEO_URL_PROXY_ENDPOINT = '/api/upload';

function joinPublicUrl(domain, key) {
  let d = String(domain || '').trim().replace(/\/+$/, '');
  if (!d) return '';
  if (!/^https?:\/\//i.test(d)) d = 'https://' + d;
  return d + '/' + String(key || '').replace(/^\/+/, '');
}

// Node 20+ 有全局 File；老环境退回 Blob + 第三参数文件名（undici 的 FormData 支持）
function makeFilePart(buffer, mimeType, fileName) {
  if (typeof File === 'function') {
    try { return new File([buffer], fileName, { type: mimeType }); } catch {}
  }
  return new Blob([buffer], { type: mimeType });
}

function looksLikeVideoWasNotProvided(text) {
  const sample = String(text || '').slice(0, 1600);
  if (!sample) return false;
  const cannotRead = /(无法|不能|没法).{0,16}(读取|访问|查看|打开|解析).{0,18}(视频|本地|文件)/.test(sample);
  const asksForVideo = /(请|需要).{0,18}(提供|上传|传入).{0,18}(视频|链接|文字版|分镜)/.test(sample);
  const fakeExample = /(示例解析|结构化示例|示例标题|典型短剧剧情虚构)/.test(sample);
  return cannotRead || asksForVideo || fakeExample;
}

function sendVideoAnalysisEvent(targetWebContents, payload) {
  if (targetWebContents && !targetWebContents.isDestroyed()) {
    targetWebContents.send('video-sniffer:analysis', payload);
  }
}

function normalizeBackendUrl(server, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^\/\//.test(text)) return 'https:' + text;
  if (text.startsWith('/')) {
    try { return new URL(text, server).toString(); } catch {}
  }
  return '';
}

function extractVideoUrlFromUploadResult(server, value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') {
    return normalizeBackendUrl(server, value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractVideoUrlFromUploadResult(server, item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';

  const preferredKeys = [
    'videoUrl', 'video_url', 'fileUrl', 'file_url', 'mediaUrl', 'media_url',
    'downloadUrl', 'download_url', 'publicUrl', 'public_url', 'url', 'src',
    'href', 'path',
  ];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = extractVideoUrlFromUploadResult(server, value[key], depth + 1);
      if (found) return found;
    }
  }
  for (const item of Object.values(value)) {
    const found = extractVideoUrlFromUploadResult(server, item, depth + 1);
    if (found) return found;
  }
  return '';
}

// 主路线：七牛云直传（两步）
async function uploadVideoViaQiniu({ server, token, fileName, mimeType, buffer, signal, onAttempt }) {
  // ① 取七牛直传凭证
  if (onAttempt) onAttempt('获取七牛云直传凭证：' + VIDEO_URL_TOKEN_ENDPOINT);
  const tokenUrl = server + VIDEO_URL_TOKEN_ENDPOINT
    + '?filename=' + encodeURIComponent(fileName)
    + '&type=compose';
  const tokenRes = await fetch(tokenUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: 'Bearer ' + token,
    },
    signal,
  });
  const tokenRaw = await tokenRes.text();
  if (!tokenRes.ok) {
    throw new Error(VIDEO_URL_TOKEN_ENDPOINT + '：HTTP ' + tokenRes.status + ' ' + tokenRaw.slice(0, 160));
  }
  let tokenBody = tokenRaw;
  try { tokenBody = JSON.parse(tokenRaw); } catch {}
  if (tokenBody && typeof tokenBody === 'object' && tokenBody.code != null && Number(tokenBody.code) !== 0) {
    throw new Error(tokenBody.message || tokenBody.msg || '获取直传凭证失败');
  }
  const data = (tokenBody && typeof tokenBody === 'object' && tokenBody.data && typeof tokenBody.data === 'object')
    ? tokenBody.data
    : (tokenBody || {});
  const upToken   = data.token;
  const key       = data.key;
  const uploadUrl = data.uploadUrl || data.upload_url;
  const domain    = data.domain;
  if (!upToken || !key || !uploadUrl || !domain) {
    throw new Error('直传凭证返回缺少 token/key/uploadUrl/domain 字段：' + JSON.stringify(data).slice(0, 200));
  }

  // ② 直传到七牛（关键：这一步不要带 Authorization，鉴权靠 token 字段）
  if (onAttempt) onAttempt('上传视频到云存储（七牛）…');
  const form = new FormData();
  form.append('token', upToken);
  form.append('key', key);
  form.append('file', makeFilePart(buffer, mimeType, fileName), fileName);
  const qiniuRes = await fetch(uploadUrl, { method: 'POST', body: form, signal });
  if (!qiniuRes.ok) {
    const qRaw = await qiniuRes.text().catch(() => '');
    throw new Error('七牛上传失败：HTTP ' + qiniuRes.status + ' ' + qRaw.slice(0, 160));
  }

  // ③ 拼最终可访问 URL
  const finalUrl = joinPublicUrl(domain, key);
  if (!finalUrl) throw new Error('上传成功但无法拼出可访问 URL');
  return finalUrl;
}

// 回退路线：后端通用代理上传（仅适合小文件，大视频可能被 nginx 体积限制 413 挡掉）
async function uploadVideoViaProxy({ server, token, fileName, mimeType, buffer, signal, onAttempt }) {
  if (onAttempt) onAttempt('后端代理上传：' + VIDEO_URL_PROXY_ENDPOINT);
  const form = new FormData();
  form.append('file', makeFilePart(buffer, mimeType, fileName), fileName);
  form.append('type', 'reference');
  const res = await fetch(server + VIDEO_URL_PROXY_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: 'Bearer ' + token,
    },
    body: form,
    signal,
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(VIDEO_URL_PROXY_ENDPOINT + '：HTTP ' + res.status + ' ' + raw.slice(0, 160));
  }
  let body = raw;
  try { body = JSON.parse(raw); } catch {}
  if (body && typeof body === 'object' && body.code != null && Number(body.code) !== 0) {
    throw new Error(body.message || body.msg || '上传失败');
  }
  const url = extractVideoUrlFromUploadResult(server, body);
  if (!url) throw new Error('上传成功但返回里没有可访问 URL');
  return url;
}

// 对外：把本地视频转成可访问 URL。先走七牛直传，失败再回退后端代理。
async function uploadVideoAndGetUrl({ server, token, fileName, mimeType, buffer, signal, onAttempt }) {
  const errors = [];
  try {
    const url = await uploadVideoViaQiniu({ server, token, fileName, mimeType, buffer, signal, onAttempt });
    return { ok: true, url, via: 'qiniu' };
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    errors.push('七牛直传：' + (err && err.message ? err.message : String(err)));
  }
  try {
    const url = await uploadVideoViaProxy({ server, token, fileName, mimeType, buffer, signal, onAttempt });
    return { ok: true, url, via: 'proxy' };
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    errors.push('后端代理：' + (err && err.message ? err.message : String(err)));
  }
  return { ok: false, error: errors.join('；') };
}

async function readReasoningStreamResponse(res, onDelta) {
  let output = '';
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let leftover = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = leftover + decoder.decode(value, { stream: true });
      const blocks = text.split(/\r?\n\r?\n/);
      leftover = blocks.pop() || '';
      for (const block of blocks) {
        const ev = parseSseBlockForMain(block);
        if (ev.event === 'error') {
          throw new Error((ev.data && (ev.data.message || ev.data.msg)) || '解析接口返回错误');
        }
        if (ev.event === 'done') continue;
        const piece = deltaTextFromSseData(ev.data);
        if (!piece) continue;
        output += piece;
        if (onDelta) onDelta(piece);
      }
    }
    if (leftover.trim()) {
      const ev = parseSseBlockForMain(leftover);
      const piece = deltaTextFromSseData(ev.data);
      if (piece) {
        output += piece;
        if (onDelta) onDelta(piece);
      }
    }
    return output;
  }
  return res.text();
}

async function postReasoningJson({ server, token, body, signal, onDelta }) {
  const res = await fetch(server + '/api/c/scripts/reasoning-stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const text = await res.text();
      if (text) {
        try {
          const json = JSON.parse(text);
          msg = json.message || json.msg || msg;
        } catch {
          msg = text.slice(0, 500);
        }
      }
    } catch {}
    throw new Error(msg);
  }
  return readReasoningStreamResponse(res, onDelta);
}

async function postReasoningMultipart({ server, token, modelId, content, fileName, episodeNo, mimeType, buffer, signal, onDelta }) {
  const form = new FormData();
  form.append('modelId', modelId);
  if (content) form.append('content', content);
  if (fileName) form.append('filename', fileName);
  if (episodeNo) form.append('episodeNo', String(episodeNo));
  // 后端「视频解析」模型要的文件字段名是 fileData（接收 image/* 或 video/*）
  form.append('fileData', makeFilePart(buffer, mimeType, fileName), fileName);

  const res = await fetch(server + '/api/c/scripts/reasoning-stream', {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      Authorization: 'Bearer ' + token,
    },
    body: form,
    signal,
  });
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try {
      const text = await res.text();
      if (text) msg = text.slice(0, 500);
    } catch {}
    throw new Error(msg);
  }
  return readReasoningStreamResponse(res, onDelta);
}

/* ============================================================
 * 临时本地直连：绕过自建后端，桌面端直接调 EvoLink 的 Gemini 原生接口。
 * 仅当本地配置了 EvoLink Key 时启用（见 analyzeVideoFileWithBackend 顶部说明）。
 * 视频用 inline_data(base64) 传；为压到 ~20MB 内联上限以下，先用内置 ffmpeg 压一遍。
 * 后端改好后把本地 key 删掉即可自动切回后端路径。
 * ============================================================ */
const EVOLINK_BASE = 'https://api.evolink.ai';                 // 多模态走 api.evolink.ai
const EVOLINK_DEFAULT_MODEL = 'gemini-3-pro-preview';          // 可被 localStorage 'evolink_model' 覆盖
const EVOLINK_INLINE_MAX_BYTES = 18 * 1024 * 1024;            // 压缩后体积上限（base64 后约 24MB）

// 用内置 ffmpeg 把整集压成小体积 mp4（降分辨率到长边≤512、2fps、保留单声道音轨），便于内联
function compressVideoForInline(inputPath, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const os = require('os');
    const outPath = path.join(os.tmpdir(), 'nr-video-analyze-' + Date.now().toString(36) + '.mp4');
    const args = [
      '-y',
      '-i', inputPath,
      '-vf', "scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'",
      '-r', '2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
      '-movflags', '+faststart',
      outPath,
    ];
    let child;
    try {
      child = spawn(ffmpegExecutable(), args, { windowsHide: true });
    } catch (err) { reject(err); return; }
    let tail = '';
    const onAbort = () => { try { child.kill(); } catch {} };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      tail = (tail + text).slice(-4000);
      const t = text.match(/time=(\S+)/);
      if (t && onProgress) onProgress('压缩视频中 ' + t[1]);
    });
    child.on('error', err => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const missing = err && err.code === 'ENOENT';
      reject(new Error(missing ? '找不到 ffmpeg（压缩视频需要），请使用内置 ffmpeg 的安装包' : (err.message || String(err))));
    });
    child.on('close', code => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) { reject(new Error('已取消')); return; }
      if (code !== 0) { reject(new Error('ffmpeg 压缩失败，退出码 ' + code + (tail ? '\n' + tail.slice(-800) : ''))); return; }
      try { resolve({ path: outPath, size: fs.statSync(outPath).size }); }
      catch (e) { reject(new Error('压缩输出不存在：' + (e.message || String(e)))); }
    });
  });
}

// 解析 Gemini 非流式 generateContent 的返回，取出正文文本
function extractTextFromGeminiResponse(body) {
  if (!body || typeof body !== 'object') return '';
  if (body.error) {
    const m = body.error.message || body.error.msg || JSON.stringify(body.error);
    throw new Error('EvoLink/Gemini 返回错误：' + m);
  }
  const cands = Array.isArray(body.candidates) ? body.candidates : [];
  let text = '';
  for (const c of cands) {
    const parts = c && c.content && Array.isArray(c.content.parts) ? c.content.parts : [];
    for (const p of parts) { if (p && typeof p.text === 'string') text += p.text; }
  }
  text = text.replace(/^\s*connected\s*/i, '');   // 去掉中转网关偶发的 "connected" 前缀
  if (!text) {
    const block = body.promptFeedback && body.promptFeedback.blockReason;
    if (block) throw new Error('请求被安全策略拦截：' + block);
    const fr = cands[0] && cands[0].finishReason;
    if (fr && fr !== 'STOP') throw new Error('模型未正常完成，finishReason=' + fr);
  }
  return text;
}

// 汇总 Gemini 用量，用来判断视频到底进没进模型（出现 VIDEO/AUDIO 数=进了；只有 TEXT=被网关丢了）
function summarizeGeminiUsage(body) {
  const u = body && body.usageMetadata;
  if (!u || typeof u !== 'object') return '无用量信息';
  const total = (u.totalTokenCount != null) ? u.totalTokenCount : '?';
  const prompt = (u.promptTokenCount != null) ? u.promptTokenCount : '?';
  const details = Array.isArray(u.promptTokensDetails) ? u.promptTokensDetails : [];
  const byMod = details
    .map(d => (d && d.modality ? d.modality : '?') + '=' + (d && d.tokenCount != null ? d.tokenCount : '?'))
    .join(', ');
  return 'prompt=' + prompt + (byMod ? '（' + byMod + '）' : '') + ' total=' + total;
}

// 调 EvoLink 原生接口（非流式）。字段一律用驼峰（inlineData/mimeType/systemInstruction）——
// 中转网关常只认驼峰，用下划线那个视频部件可能被悄悄丢掉，导致模型其实没拿到视频在空编。
async function callEvolinkGemini({ apiKey, model, systemPrompt, userText, mimeType, base64, signal }) {
  const url = EVOLINK_BASE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const parts = [{ inlineData: { mimeType: mimeType || 'video/mp4', data: base64 } }];
  parts.push({ text: (userText && userText.trim()) ? userText : '请解析这段视频。' });
  const reqBody = { contents: [{ role: 'user', parts }] };
  if (systemPrompt && systemPrompt.trim()) {
    reqBody.systemInstruction = { parts: [{ text: systemPrompt }] };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(reqBody),
    signal,
  });
  const raw = await res.text();
  let body = raw;
  try { body = JSON.parse(raw); } catch {}
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    if (body && typeof body === 'object' && body.error) msg = body.error.message || msg;
    else if (raw) msg = raw.slice(0, 400);
    throw new Error('EvoLink 调用失败：' + msg);
  }
  return { text: extractTextFromGeminiResponse(body), usage: summarizeGeminiUsage(body) };
}

// 直连分支主流程：压缩 → base64 → 调 EvoLink → 落盘
async function analyzeVideoViaEvolinkDirect({ sender, jobId, controller, filePath, outputPath, episodeNo, apiKey, model, systemPrompt, userText }) {
  let compressed = null;
  try {
    sendVideoAnalysisEvent(sender, {
      jobId, state: 'started', filePath, fileName: path.basename(filePath), episodeNo, outputPath,
      message: '直连 EvoLink（' + model + '）解析',
    });

    sendVideoAnalysisEvent(sender, { jobId, state: 'attempt', filePath, episodeNo, message: '用 ffmpeg 压缩视频中…' });
    compressed = await compressVideoForInline(filePath, controller.signal, (m) => {
      sendVideoAnalysisEvent(sender, { jobId, state: 'attempt', filePath, episodeNo, message: m });
    });
    if (compressed.size > EVOLINK_INLINE_MAX_BYTES) {
      throw new Error('压缩后仍有 ' + (compressed.size / 1048576).toFixed(1) + 'MB，超过内联上限，请用更短的片段');
    }

    const buf = await fs.promises.readFile(compressed.path);
    const base64 = buf.toString('base64');

    sendVideoAnalysisEvent(sender, {
      jobId, state: 'uploaded', filePath, episodeNo,
      videoUrl: '(内联 ' + (compressed.size / 1048576).toFixed(1) + 'MB)',
      message: '视频已压缩内联（' + (compressed.size / 1048576).toFixed(1) + 'MB），调用 Gemini 解析中…',
    });

    const result = await callEvolinkGemini({
      apiKey, model, systemPrompt, userText, mimeType: 'video/mp4', base64, signal: controller.signal,
    });
    const output = result.text;
    sendVideoAnalysisEvent(sender, { jobId, state: 'attempt', filePath, episodeNo, message: '模型用量 ' + result.usage });

    if (!output || !output.trim()) throw new Error('Gemini 返回为空');
    if (looksLikeVideoWasNotProvided(output)) {
      throw new Error('模型仍提示无法读取视频（请检查 key 是否有效、所选模型是否支持视频）');
    }

    fs.writeFileSync(outputPath, output, 'utf8');
    sendVideoAnalysisEvent(sender, {
      jobId, state: 'completed', filePath, fileName: path.basename(filePath), episodeNo, outputPath, output,
      message: '视频解析完成（直连 EvoLink）',
    });
    return { ok: true, outputPath, output, jobId, via: 'evolink-direct' };
  } catch (err) {
    const message = (err && err.name === 'AbortError') ? '视频解析已停止' : (err && err.message ? err.message : String(err));
    sendVideoAnalysisEvent(sender, { jobId, state: 'error', filePath, episodeNo, outputPath, message });
    return { ok: false, error: message, outputPath, jobId };
  } finally {
    if (compressed && compressed.path) fs.promises.unlink(compressed.path).catch(() => {});
    videoAnalysisAborts.delete(controller);
  }
}

async function analyzeVideoFileWithBackend(event, payload) {
  if (typeof fetch !== 'function' || typeof FormData !== 'function') {
    return { ok: false, error: '当前运行环境不支持 fetch/FormData，无法上传视频解析' };
  }
  const sender = event.sender;
  const server = String(payload.server || 'https://mj.api.meidawenhua.com').replace(/\/+$/, '');
  const token = String(payload.token || '');
  const modelId = String(payload.modelId || VIDEO_ANALYSIS_MODEL_ID);
  const filePath = String(payload.filePath || '');
  const episodeNo = Number(payload.episodeNo) || episodeNoFromLocalVideoName(path.basename(filePath));

  // —— 临时直连开关：本地配了 EvoLink Key 就直连 Gemini（绕过后端），否则走后端 ——
  // 在「视频抓取」窗口按 Ctrl+Shift+I 打开开发者工具，在 Console 里执行（隐蔽，仅存本地）：
  //   localStorage.setItem('evolink_key','sk-你的EvoLinkKey')
  //   localStorage.setItem('evolink_video_prompt','你的视频解析系统提示词')
  //   localStorage.setItem('evolink_model','gemini-3-pro-preview')   // 可选，默认就是它
  // 后端改好后切回：localStorage.removeItem('evolink_key')
  const evolinkKey = String(payload.evolinkKey || '').trim();
  const evolinkPrompt = String(payload.evolinkPrompt || '');
  const evolinkModel = String(payload.evolinkModel || '').trim() || EVOLINK_DEFAULT_MODEL;

  if (!token && !evolinkKey) return { ok: false, error: '未登录或登录已过期，请先在改文主界面登录（或在本地配置 EvoLink Key 直连）' };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '视频文件不存在' };
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return { ok: false, error: '请选择具体的视频文件' };

  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const controller = new AbortController();
  videoAnalysisAborts.add(controller);
  const outputPath = videoAnalysisOutputPath(filePath);
  let output = '';

  // 直连 EvoLink 分支（临时本地测试用；配了 key 就走这条，不碰后端）
  if (evolinkKey) {
    return await analyzeVideoViaEvolinkDirect({
      sender, jobId, controller, filePath, outputPath, episodeNo,
      apiKey: evolinkKey, model: evolinkModel, systemPrompt: evolinkPrompt,
      userText: String(payload.content || ''),
    });
  }

  // 后端 fileData 直传分支：压缩视频 → 以 fileData 字段直传后端模型解析（后端已支持读取视频文件）
  let compressedPath = '';
  try {
    sendVideoAnalysisEvent(sender, {
      jobId,
      state: 'started',
      filePath,
      fileName: path.basename(filePath),
      episodeNo,
      outputPath,
      message: '准备上传视频给后端模型解析',
    });

    // 先用内置 ffmpeg 压成小体积 mp4（长边≤512、2fps），够模型做分镜推理，又让 fileData 上传又快又稳；
    // 压缩失败（例如环境里没有 ffmpeg）就退回直传原始视频，保证解析不至于直接挂掉。
    let buffer;
    let uploadName;
    let uploadMime;
    try {
      sendVideoAnalysisEvent(sender, { jobId, state: 'attempt', filePath, episodeNo, message: '用 ffmpeg 压缩视频中…' });
      const compressed = await compressVideoForInline(filePath, controller.signal, (m) => {
        sendVideoAnalysisEvent(sender, { jobId, state: 'attempt', filePath, episodeNo, message: m });
      });
      compressedPath = compressed.path;
      buffer = await fs.promises.readFile(compressedPath);
      uploadName = path.basename(filePath).replace(/\.[^.]+$/, '') + '.mp4';
      uploadMime = 'video/mp4';
      sendVideoAnalysisEvent(sender, {
        jobId,
        state: 'uploaded',
        filePath,
        episodeNo,
        videoUrl: '(fileData 直传 ' + (compressed.size / 1048576).toFixed(1) + 'MB)',
        message: '视频已压缩（' + (compressed.size / 1048576).toFixed(1) + 'MB），以 fileData 直传后端模型 ' + modelId + ' 解析中…',
      });
    } catch (compressErr) {
      const cm = String(compressErr && compressErr.message ? compressErr.message : compressErr);
      if ((compressErr && compressErr.name === 'AbortError') || /已取消|abort/i.test(cm)) throw compressErr;
      sendVideoAnalysisEvent(sender, { jobId, state: 'attempt', filePath, episodeNo, message: '压缩失败，改为直传原始视频：' + cm });
      buffer = await fs.promises.readFile(filePath);
      uploadName = path.basename(filePath);
      uploadMime = videoMimeType(filePath);
      sendVideoAnalysisEvent(sender, {
        jobId,
        state: 'uploaded',
        filePath,
        episodeNo,
        videoUrl: '(fileData 直传原始 ' + (buffer.length / 1048576).toFixed(1) + 'MB)',
        message: '以 fileData 直传后端模型 ' + modelId + ' 解析中…',
      });
    }

    const content = String(payload.content || `请解析这个视频文件：${path.basename(filePath)}`);

    output = await postReasoningMultipart({
      server,
      token,
      modelId,
      content,
      fileName: uploadName,
      episodeNo,
      mimeType: uploadMime,
      buffer,
      signal: controller.signal,
      onDelta: piece => {
        sendVideoAnalysisEvent(sender, { jobId, state: 'delta', filePath, episodeNo, text: piece });
      },
    });

    if (looksLikeVideoWasNotProvided(output)) {
      throw new Error('模型仍提示无法读取视频（后端可能没把 fileData 转给模型，或该模型不支持视频解析）');
    }

    if (!output) {
      throw new Error('视频解析没有返回内容');
    }

    fs.writeFileSync(outputPath, output || '', 'utf8');
    sendVideoAnalysisEvent(sender, {
      jobId,
      state: 'completed',
      filePath,
      fileName: path.basename(filePath),
      episodeNo,
      outputPath,
      output,
      message: '视频解析完成',
    });
    return { ok: true, outputPath, output, jobId };
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? '视频解析已停止'
      : (err && err.message ? err.message : String(err));
    sendVideoAnalysisEvent(sender, { jobId, state: 'error', filePath, episodeNo, outputPath, message });
    return { ok: false, error: message, outputPath, jobId };
  } finally {
    if (compressedPath) fs.promises.unlink(compressedPath).catch(() => {});
    videoAnalysisAborts.delete(controller);
  }
}


function setupVideoSnifferIpc() {
  ipcMain.handle('video-sniffer:open', () => {
    createVideoSnifferWindow();
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:close', () => {
    try { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); } } catch {}
    try { if (videoSnifferWindow && !videoSnifferWindow.isDestroyed()) videoSnifferWindow.close(); } catch {}
    return { ok: true };
  });

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

  ipcMain.handle('video-sniffer:navigate', (_event, url) => {
    if (!videoSnifferView) return { ok: false, error: '浏览器未初始化' };
    const target = normalizeNavigationUrl(url);
    if (!target) return { ok: false, error: '请输入网址' };
    videoSnifferView.webContents.loadURL(target);
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:select-directory', async () => {
    const result = await dialog.showOpenDialog(videoSnifferWindow || mainWindow, {
      title: '选择全集保存目录',
      defaultPath: videosPath(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('video-sniffer:select-analysis-directory', async () => {
    const result = await dialog.showOpenDialog(videoSnifferWindow || mainWindow, {
      title: '选择视频解析目录',
      defaultPath: videosPath(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('video-sniffer:select-analysis-files', async () => {
    const result = await dialog.showOpenDialog(videoSnifferWindow || mainWindow, {
      title: '选择要解析的视频（可多选）',
      defaultPath: videosPath(),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    try {
      const files = sortLocalVideoFiles(result.filePaths
        .filter(filePath => LOCAL_VIDEO_EXTS.has(path.extname(filePath).toLowerCase()))
        .map(localVideoFileInfo));
      if (!files.length) return { ok: false, error: '没有选中可解析的视频文件' };
      return { ok: true, files, rootDir: commonParentDir(files.map(file => file.path)), count: files.length };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:get-config', () => {
    return { ok: true, config: readSnifferConfig() };
  });

  ipcMain.handle('video-sniffer:get-auth', async () => {
    let token = '';
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        token = await mainWindow.webContents.executeJavaScript("localStorage.getItem('nr_token') || ''", true);
      }
    } catch {}
    return {
      ok: true,
      server: 'https://mj.api.meidawenhua.com',
      token: token || '',
    };
  });

  ipcMain.handle('video-sniffer:tikhub-fetch-info', async (_event, payload) => {
    try {
      return await fetchTikhubVideoInfo(payload || {});
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:tikhub-drama-radar', async (_event, payload) => {
    try {
      return await fetchTikhubDramaRadar(payload || {});
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:open', () => {
    createInfoScraperWindow();
    return { ok: true };
  });

  ipcMain.handle('info-scraper:get-state', () => infoScraperPublicState());

  ipcMain.handle('info-scraper:get-extractor-status', async () => {
    try {
      return await getInfoScraperExtractorStatus();
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:get-login-status', async () => {
    try {
      return await refreshInfoScraperLoginStatusCache();
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:open-login-browser', async (_event, url) => {
    try {
      createInfoScraperLoginWindow(url || 'https://www.tiktok.com/login');
      const status = await refreshInfoScraperLoginStatusCache({ notify: true });
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:save-settings', (_event, payload) => {
    try {
      const state = readInfoScraperState();
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'maxVideos')) state.maxVideos = Math.max(1, Math.min(100, Number(payload.maxVideos) || 50));
      writeInfoScraperState(state);
      return infoScraperPublicState(state);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:add-accounts', (_event, payload) => {
    try {
      const state = readInfoScraperState();
      const urls = parseDramaRadarAccountUrls(payload && (payload.urls || payload.text || payload.accountUrls));
      if (!urls.length) return { ok: false, error: '没有识别到账号链接' };
      const byId = new Map(state.accounts.map(account => [account.id, account]));
      let added = 0;
      for (const url of urls) {
        const clean = normalizeNavigationUrl(cleanupImportedUrl(url));
        const id = infoScraperAccountId(clean);
        const existed = byId.get(id);
        byId.set(id, normalizeInfoScraperAccount(clean, existed || {}));
        if (!existed) added += 1;
      }
      state.accounts = Array.from(byId.values()).sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-CN'));
      appendInfoScraperEvent(state, { type: 'settings', message: '保存账号：新增 ' + added + ' 个，总计 ' + state.accounts.length + ' 个' });
      writeInfoScraperState(state);
      return infoScraperPublicState(state);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:remove-account', (_event, accountId) => {
    try {
      const state = readInfoScraperState();
      state.accounts = state.accounts.filter(account => account.id !== String(accountId || ''));
      if (state.snapshots) delete state.snapshots[String(accountId || '')];
      appendInfoScraperEvent(state, { type: 'settings', message: '已删除账号' });
      writeInfoScraperState(state);
      return infoScraperPublicState(state);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:toggle-account', (_event, payload) => {
    try {
      const state = readInfoScraperState();
      const id = String((payload && payload.accountId) || '');
      const account = state.accounts.find(item => item.id === id);
      if (!account) return { ok: false, error: '账号不存在' };
      account.enabled = payload && Object.prototype.hasOwnProperty.call(payload, 'enabled') ? !!payload.enabled : !account.enabled;
      account.updatedAt = new Date().toISOString();
      writeInfoScraperState(state);
      return infoScraperPublicState(state);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:refresh', async (_event, payload) => {
    try {
      return await refreshInfoScraperAccounts(payload || {});
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:export-bilingual-list', () => {
    try {
      return exportInfoScraperBilingualList();
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('info-scraper:open-url', (_event, url) => {
    if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:set-download-dir', (_event, dir) => {
    const config = readSnifferConfig();
    config.downloadDir = String(dir || '');
    writeSnifferConfig(config);
    return { ok: true, path: config.downloadDir };
  });

  ipcMain.handle('video-sniffer:select-link-file', async () => {
    const result = await dialog.showOpenDialog(videoSnifferWindow || mainWindow, {
      title: '导入剧集链接文件',
      defaultPath: app.getPath('documents'),
      properties: ['openFile'],
      filters: [
        { name: '链接文件', extensions: ['xlsx', 'xls', 'xlsm', 'csv', 'txt'] },
        { name: 'Excel', extensions: ['xlsx', 'xls', 'xlsm'] },
        { name: '文本', extensions: ['csv', 'txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    try {
      return { ok: true, ...parseImportedLinkFile(result.filePaths[0]) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:list-video-files', (_event, rootDir) => {
    try {
      return { ok: true, files: collectLocalVideoFiles(rootDir), rootDir: String(rootDir || '') };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:split-video-file', async (_event, payload) => {
    try {
      return await splitLocalVideoFile(payload || {});
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:export-analyses', async (_event, payload) => {
    try {
      const rootDir = String((payload && payload.rootDir) || '');
      const format = String((payload && payload.format) || 'docx').toLowerCase();
      const title = safeFileName(String((payload && payload.title) || path.basename(rootDir) || '视频解析合集'), '视频解析合集').slice(0, 80) || '视频解析合集';
      const selectedFilePaths = Array.isArray(payload && payload.filePaths)
        ? payload.filePaths.map(filePath => String(filePath || '')).filter(Boolean)
        : [];
      const mergeCurrentDirOnly = !!(payload && payload.mergeCurrentDirOnly);
      const splitByFolder = !!(payload && payload.splitByFolder);
      if (!rootDir || !fs.existsSync(rootDir)) return { ok: false, error: '没有可导出的目录，请先选择保存目录或先解析视频' };
      if (splitByFolder && payload && payload.silent && !selectedFilePaths.length && !mergeCurrentDirOnly) {
        const childDirs = childAnalysisExportDirs(rootDir);
        if (childDirs.length) {
          const outputs = [];
          let totalCount = 0;
          for (const childDir of childDirs) {
            const childTitle = safeFileName(path.basename(childDir) || '视频解析合集', '视频解析合集').slice(0, 80) || '视频解析合集';
            const childItems = collectAnalysisResults(childDir);
            if (!childItems.length) continue;
            const childBuilt = buildAnalysisExport(format, childItems, { title: childTitle });
            const childDefName = safeFileName(childTitle + '-视频解析合集', '视频解析合集') + '.' + childBuilt.ext;
            const childTarget = path.join(childDir, childDefName);
            fs.writeFileSync(childTarget, childBuilt.buffer);
            totalCount += childItems.length;
            outputs.push({
              dir: childDir,
              outputPath: childTarget,
              count: childItems.length,
              format: childBuilt.ext,
            });
          }
          if (outputs.length) {
            return {
              ok: true,
              outputPath: outputs[0].outputPath,
              outputPaths: outputs.map(item => item.outputPath),
              outputs,
              count: totalCount,
              groupCount: outputs.length,
              format: outputs[0].format,
              splitByFolder: true,
            };
          }
        }
      }
      const items = mergeCurrentDirOnly
        ? collectAnalysisResultsInCurrentDir(rootDir)
        : (selectedFilePaths.length ? collectAnalysisResultsForFiles(selectedFilePaths) : collectAnalysisResults(rootDir));
      if (!items.length) return { ok: false, error: '在该目录下没找到任何「视频解析.txt」，请先点「解析视频」生成结果' };

      const built = buildAnalysisExport(format, items, { title });
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = '' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '_' + pad(now.getHours()) + pad(now.getMinutes());
      const defName = safeFileName(title + '-视频解析合集', '视频解析合集') + '.' + built.ext;
      const manualDefName = '视频解析合集_' + stamp + '.' + built.ext;
      const filterMap = {
        txt: ['文本文件', 'txt'], md: ['Markdown', 'md'], html: ['网页', 'html'], csv: ['CSV (Excel 可打开)', 'csv'],
        json: ['JSON', 'json'], xlsx: ['Excel 工作簿', 'xlsx'], docx: ['Word 文档', 'docx'],
      };
      const fm = filterMap[built.ext] || ['文件', built.ext];
      let target = '';
      if (payload && payload.silent) {
        target = path.join(rootDir, defName);
      } else {
        target = dialog.showSaveDialogSync(videoSnifferWindow || mainWindow, {
          title: '导出视频解析合集',
          defaultPath: path.join(rootDir || app.getPath('downloads'), manualDefName),
          filters: [{ name: fm[0], extensions: [fm[1]] }, { name: '所有文件', extensions: ['*'] }],
        });
      }
      if (!target) return { ok: false, canceled: true };
      fs.writeFileSync(target, built.buffer);
      return { ok: true, outputPath: target, count: items.length, format: built.ext };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:analyze-video-file', async (event, payload) => {
    return analyzeVideoFileWithBackend(event, payload || {});
  });

  ipcMain.handle('video-sniffer:cancel-video-analysis', () => {
    if (videoAnalysisAborts.size) {
      for (const controller of Array.from(videoAnalysisAborts)) {
        try { controller.abort(); } catch {}
      }
      return { ok: true, cancelled: true, count: videoAnalysisAborts.size };
    }
    return { ok: true, cancelled: false };
  });

  ipcMain.handle('video-sniffer:open-episode', async (_event, episodeNo) => {
    if (!videoSnifferView) return { ok: false, error: '浏览器未初始化' };
    const targetEpisode = Math.max(1, Math.round(Number(episodeNo) || 0));
    if (!targetEpisode) return { ok: false, error: '集数无效' };
    const wc = videoSnifferView.webContents;
    try {
      const result = await wc.executeJavaScript(`(async () => {
        const targetEpisode = ${targetEpisode};
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const visible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05;
        };
        const textOf = el => [el.innerText, el.textContent, el.getAttribute && el.getAttribute('aria-label'), el.title, el.href, el.dataset && JSON.stringify(el.dataset)].filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
        const bodyText = () => (document.body && document.body.innerText || '').replace(/\\s+/g, ' ');
        const parseCurrent = () => {
          const raw = bodyText();
          const patterns = [
            /集\\s*(\\d{1,4})\\s*\\/\\s*(\\d{1,4})/i,
            /第\\s*(\\d{1,4})\\s*集\\s*[\\/／]\\s*(\\d{1,4})\\s*集?/i,
            /episode\\s*(\\d{1,4})\\s*(?:\\/|of)\\s*(\\d{1,4})/i,
          ];
          for (const pattern of patterns) {
            const m = raw.match(pattern);
            if (m) return { current: Number(m[1]) || 0, total: Number(m[2]) || 0 };
          }
          return { current: 0, total: 0 };
        };
        const clickEl = el => {
          if (!el || !visible(el)) return false;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          const x = r.left + Math.min(Math.max(r.width / 2, 3), Math.max(r.width - 3, 3));
          const y = r.top + Math.min(Math.max(r.height / 2, 3), Math.max(r.height - 3, 3));
          for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
          }
          return true;
        };
        const clickable = () => Array.from(document.querySelectorAll('a,button,[role="button"],[onclick],li,div,span'))
          .filter(visible)
          .filter(el => {
            const text = textOf(el);
            if (!text) return false;
            const style = getComputedStyle(el);
            return el.tagName === 'A' || el.tagName === 'BUTTON' || el.onclick || el.getAttribute('role') === 'button' || style.cursor === 'pointer' || /集|episode|next|prev|上一|下一|选集|目录|\\d+/.test(text);
          });
        const exactEpisode = () => {
          const n = String(targetEpisode);
          const exact = new RegExp('^(?:第\\\\s*)?' + n + '(?:\\\\s*集)?$', 'i');
          const word = new RegExp('(?:第\\\\s*' + n + '\\\\s*集|episode\\\\s*' + n + '\\\\b|[?&]episode=' + n + '\\\\b|/episode[/_-]?' + n + '\\\\b)', 'i');
          return clickable().find(el => {
            const text = textOf(el);
            return exact.test(text) || word.test(text);
          });
        };
        let current = parseCurrent();
        if (current.current === targetEpisode) return { ok: true, method: 'already', ...current };

        let el = exactEpisode();
        if (!el) {
          const opener = clickable().find(x => /集\\s*\\d+\\s*\\/\\s*\\d+|选集|剧集|目录|episodes?/i.test(textOf(x)));
          if (opener && clickEl(opener)) {
            await sleep(650);
            el = exactEpisode();
          }
        }
        if (el && clickEl(el)) {
          await sleep(1200);
          current = parseCurrent();
          return { ok: true, method: 'episode-list', ...current };
        }

        const moveByButton = async (direction, steps) => {
          const patterns = direction > 0
            ? [/下一集|下集|next episode|next|›|»|▶\\|/i]
            : [/上一集|上集|previous episode|previous|prev|‹|«|\\|◀/i];
          for (let i = 0; i < steps; i++) {
            const btn = clickable().find(x => patterns.some(p => p.test(textOf(x))));
            if (!btn || !clickEl(btn)) return false;
            await sleep(1500);
          }
          return true;
        };
        current = parseCurrent();
        if (current.current && current.current !== targetEpisode) {
          const steps = Math.abs(targetEpisode - current.current);
          const moved = await moveByButton(targetEpisode > current.current ? 1 : -1, steps);
          await sleep(700);
          const after = parseCurrent();
          if (moved && (!after.current || after.current === targetEpisode)) return { ok: true, method: 'next-prev', ...after };
        }

        return { ok: false, error: '没有找到网页里的第 ' + targetEpisode + ' 集按钮或上一/下一集控件', ...parseCurrent() };
      })()`, true);
      if (result && result.ok) sendSnifferBrowserState();
      return result || { ok: false, error: '网页没有返回切集结果' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:extract-page-media', async (_event, url) => {
    let target = normalizeNavigationUrl(url);
    if (!target && videoSnifferView && !videoSnifferView.webContents.isDestroyed()) {
      target = videoSnifferView.webContents.getURL();
    }
    if (!target || !/^https?:\/\//i.test(target)) {
      return { ok: false, error: '没有可用的页面地址' };
    }
    try {
      const html = await fetchPageHtml(target);
      const { urls, total, title } = extractPageMediaFromHtml(html);
      return { ok: true, urls, total, title, pageUrl: target };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:page-info', async () => {
    if (!videoSnifferView) return { ok: false, error: '浏览器未初始化' };
    const wc = videoSnifferView.webContents;
    try {
      const info = await wc.executeJavaScript(`(() => {
        const text = (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 60000);
        const title = document.title || '';
        const url = location.href || '';
        return { text, title, url };
      })()`, true);
      return {
        ok: true,
        url: info && info.url || wc.getURL(),
        title: info && info.title || wc.getTitle(),
        text: info && info.text || '',
      };
    } catch (err) {
      return {
        ok: true,
        url: wc.getURL(),
        title: wc.getTitle(),
        text: '',
        warning: err && err.message ? err.message : String(err),
      };
    }
  });

  ipcMain.handle('video-sniffer:player-action', async (_event, action) => {
    if (!videoSnifferView) return { ok: false, error: '浏览器未初始化' };
    const wc = videoSnifferView.webContents;
    const code = String.raw`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitPlay = p => p && p.then ? Promise.race([p.catch(() => {}), sleep(800)]) : Promise.resolve();
  const vis = el => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0.05; };
  const txt = el => [el.innerText, el.getAttribute && el.getAttribute('aria-label'), el.title].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const click = el => {
    if (!el || !vis(el)) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    for (const t of ['pointerover', 'pointerdown', 'mousedown', 'mouseup', 'click']) {
      try { el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, clientX: x, clientY: y })); } catch (e) {}
    }
    return true;
  };
  const all = sel => Array.from(document.querySelectorAll(sel)).filter(vis);
  const detect = () => {
    try {
      const opaqueHashPlayer = /#\/player/i.test(location.hash || '') && /(?:[?&])k=/.test(location.hash || '');
      const q = opaqueHashPlayer ? '' : new URL(location.href).searchParams.get('episode');
      if (q && /^\d+$/.test(q)) return Number(q);
    } catch (e) {}
    const bt = (document.body && document.body.innerText) || '';
    const m = bt.match(/第\s*(\d{1,4})\s*集|episode\s*(\d{1,4})/i);
    if (m) return Number(m[1] || m[2]) || 0;
    const act = document.querySelector('[aria-selected="true"],[class*="active"],[class*="current"],[class*="playing"],[class*="selected"]');
    if (act) { const mm = txt(act).match(/\d{1,4}/); if (mm) return Number(mm[0]); }
    return 0;
  };
  const isBlockingLayer = el => {
    if (!el || el === document.documentElement) return false;
    let r, s;
    try { r = el.getBoundingClientRect(); s = getComputedStyle(el); } catch (e) { return false; }
    const vw = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const vh = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    const screenArea = vw * vh;
    const z = parseInt(s.zIndex || '0', 10) || 0;
    const fixed = /fixed|sticky/.test(s.position || '');
    const centered = r.width > vw * 0.22 && r.height > vh * 0.18 && r.left < vw * 0.75 && r.right > vw * 0.25 && r.top < vh * 0.75 && r.bottom > vh * 0.25;
    const cover = area > screenArea * 0.2 && (fixed || z >= 10);
    const words = txt(el).toLowerCase();
    const loginLike = /login|sign in|sign up|email|continue with|subscribe|payment|vip|my drama|\u767b\u5f55|\u90ae\u4ef6|\u4ed8\u6b3e|\u5145\u503c|\u7eed\u8ba2/.test(words);
    return cover || (centered && (z >= 5 || loginLike));
  };
  const hasBlockingAncestor = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (isBlockingLayer(n)) return n;
    }
    return null;
  };
  const dismissPopups = async () => {
    return { ok: true, closed: 0, clicked: [] };
  };
  const action = ${JSON.stringify(String(action || ""))};

  if (action === 'detect') return { ok: true, current: detect() };

  if (action === 'dismiss-popups') return await dismissPopups();

  if (action === 'info') {
    const v = document.querySelector('video');
    if (!v) return { ok: false, current: detect(), error: 'no video element' };
    const duration = Number.isFinite(v.duration) ? v.duration : 0;
    const currentTime = Number.isFinite(v.currentTime) ? v.currentTime : 0;
    return {
      ok: true,
      current: detect(),
      duration,
      currentTime,
      paused: !!v.paused,
      ended: !!v.ended,
      readyState: Number(v.readyState || 0),
      src: v.currentSrc || v.src || ''
    };
  }

  if (action === 'open-panel') {
    await dismissPopups();
    const opener = all('a,button,[role=button],div,span,li').find(el => /选集|剧集|目录|全集|集数|episodes?|playlist|播放列表/i.test(txt(el)));
    if (opener) click(opener);
    await sleep(400);
    return { ok: true, current: detect() };
  }

  if (action === 'play') {
    await dismissPopups();
    let played = false;
    const v = document.querySelector('video');
    if (v) { try { v.muted = true; const p = v.play(); await waitPlay(p); played = !v.paused; } catch (e) {} }
    if (!played) {
      const btn = all('.vjs-big-play-button,[class*="play"],button[aria-label*="play" i],button[title*="play" i],video').find(Boolean);
      if (btn) click(btn);
      await sleep(300);
      const v2 = document.querySelector('video');
      if (v2) { try { v2.muted = true; await waitPlay(v2.play()); } catch (e) {} played = !!(v2 && !v2.paused); }
    }
    return { ok: true, current: detect(), playing: played };
  }

  if (action === 'next') {
    await dismissPopups();
    const before = detect();
    let el = all('a,button,[role=button],div,span,li').find(e => /下一集|下集|next\s*episode|播放下一集/i.test(txt(e)))
          || all('[aria-label*="next" i],[title*="next" i],[class*="next"]').find(Boolean);
    let clicked = el ? click(el) : false;
    if (!clicked && before) {
      const target = String(before + 1);
      el = all('a,button,[role=button],li,div,span').find(e => txt(e).trim() === target);
      if (el) clicked = click(el);
    }
    if (!clicked) {
      el = all('[class*="down"],[aria-label*="down" i]').find(Boolean);
      if (el) clicked = click(el);
    }
    if (!clicked) {
      const v = document.querySelector('video') || document.body;
      try { v.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 400 })); clicked = true; } catch (e) {}
    }
    await sleep(300);
    return { ok: clicked, before: before, current: detect() };
  }

  return { ok: false, error: 'unknown action' };
})()`;
    try {
      const result = await wc.executeJavaScript(code, true);
      sendSnifferBrowserState();
      return result || { ok: false, error: '无返回' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:episode-list', async () => {
    if (!videoSnifferView) return { ok: false, error: '浏览器未初始化' };
    const wc = videoSnifferView.webContents;
    const code = String.raw`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const reExact = /^(?:第\s*)?(?:episode|ep|e)?\s*(\d{1,4})\s*集?$/i;
  const reLoose = /(?:episode|ep)\s*(\d{1,4})|第\s*(\d{1,4})\s*集/i;
  const isOpaqueHashPlayer = () => /#\/player/i.test(location.hash || '') && /(?:[?&])k=/.test(location.hash || '');
  const isUsefulHref = href => {
    if (!href || /^(?:javascript:|about:|#)/i.test(String(href))) return false;
    if (isOpaqueHashPlayer()) {
      const a = String(href).replace(/#$/, '');
      const b = String(location.href || '').replace(/#$/, '');
      if (a === b) return false;
    }
    return true;
  };

  // ReelShort：每集链接结尾带不可预测的 slug（如 -qfnc24nqw3），靠改 episode-N 数字切不动。
  // 它的官方“全集页” /full-episodes/<slug>-<剧id> 是服务端渲染、把全部集都列为真实 <a href>。
  // 同源 fetch 该页并解析，直接拿到每集正确链接（带 slug）。只对 reelshort.com 生效，不影响其他站点。
  if (/(?:^|\.)reelshort\.com$/i.test(location.hostname)) {
    let full = '';
    let mm = location.pathname.match(/\/episodes\/episode-\d{1,4}-(.+?-[0-9a-f]{24})(?:-[a-z0-9]+)?\/?$/i);
    if (mm) full = location.origin + '/full-episodes/' + mm[1];
    if (!full) { mm = location.pathname.match(/\/(?:movie|full-episodes)\/(.+?-[0-9a-f]{24})\/?$/i); if (mm) full = location.origin + '/full-episodes/' + mm[1]; }
    if (full) {
      try {
        const html = await fetch(full, { credentials: 'include' }).then(r => r.ok ? r.text() : '');
        if (html) {
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const fmap = new Map();
          for (const a of doc.querySelectorAll('a[href]')) {
            let href = a.getAttribute('href') || '';
            try { href = new URL(href, full).href; } catch (e) { continue; }
            const em = href.match(/\/episodes\/episode-(\d{1,4})-[^\/?#]+/i);
            if (!em) continue;
            const n = Number(em[1]);
            if (!n || n > 9999 || fmap.has(n)) continue;
            fmap.set(n, { episode: n, url: href, text: 'Episode ' + n, clickOnly: false });
          }
          if (fmap.size) {
            const farr = Array.from(fmap.values()).sort((a, b) => a.episode - b.episode);
            return { ok: true, episodes: farr, total: farr.length, source: 'reelshort-full-episodes' };
          }
        }
      } catch (e) {}
    }
  }

  // 通用兜底：直接按 <a href> 里的 episode-N 模式收集（适配把每集做成真实链接、但链接文字不是纯数字的站点）
  const collectHref = (map) => {
    for (const a of document.querySelectorAll('a[href]')) {
      let href = '';
      try { href = a.href; } catch (e) { continue; }
      if (!isUsefulHref(href)) continue;
      let path = '';
      try { path = new URL(href).pathname; } catch (e) { continue; }
      const m = path.match(/(?:^|[\/_-])(?:episode|ep)[\/_-]?(\d{1,4})(?=$|[\/_-])/i);
      if (!m) continue;
      const n = Number(m[1]);
      if (!n || n > 9999) continue;
      const prev = map.get(n);
      if (prev && prev.url && !prev.clickOnly) continue;
      const t = ((a.innerText || a.textContent || '') + '').replace(/\s+/g, ' ').trim();
      map.set(n, { episode: n, url: href, text: t.slice(0, 24) || ('第' + n + '集'), clickOnly: false });
    }
  };

  const collect = (map) => {
    const nodes = document.querySelectorAll('a,button,[role="button"],li,div,span,p');
    for (const el of nodes) {
      const t = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
      if (!t || t.length > 24) continue;
      let n = 0;
      const m = t.match(reExact);
      if (m) n = Number(m[1]);
      if (!n) { const m2 = t.match(reLoose); if (m2) n = Number(m2[1] || m2[2]); }
      if (!n || n > 9999 || map.has(n)) continue;
      let href = '';
      const a = el.closest && el.closest('a');
      if (a && isUsefulHref(a.href)) href = a.href;
      if (!href && !isOpaqueHashPlayer()) { try { const u = new URL(location.href); u.searchParams.set('episode', String(n)); href = u.toString(); } catch (e) {} }
      map.set(n, { episode: n, url: href, text: t, clickOnly: !href });
    }
  };

  const map = new Map();
  await sleep(800);
  collect(map);
  collectHref(map);
  const scrollers = [];
  if (document.scrollingElement) scrollers.push(document.scrollingElement);
  for (const el of document.querySelectorAll('*')) {
    let s;
    try { s = getComputedStyle(el); } catch (e) { continue; }
    if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 40) scrollers.push(el);
  }
  let lastSize = map.size;
  for (let pass = 0; pass < 15; pass++) {
    for (const sc of scrollers) { try { sc.scrollTop = sc.scrollHeight; } catch (e) {} }
    await sleep(350);
    collect(map);
    collectHref(map);
    if (map.size === lastSize && pass > 3) break;
    lastSize = map.size;
  }

  const arr = Array.from(map.values()).sort((a, b) => a.episode - b.episode);
  return { ok: true, episodes: arr, total: arr.length };
})()`;
    try {
      const result = await wc.executeJavaScript(code, true);
      return result || { ok: false, error: '无返回' };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:browser-command', (_event, command) => {
    if (!videoSnifferView) return { ok: false };
    const wc = videoSnifferView.webContents;
    if (command === 'back' && wc.canGoBack()) wc.goBack();
    else if (command === 'forward' && wc.canGoForward()) wc.goForward();
    else if (command === 'reload') wc.reload();
    else if (command === 'stop') wc.stop();
    sendSnifferBrowserState();
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:set-view-bounds', (_event, bounds) => {
    if (!videoSnifferView) return { ok: false };
    const x = Math.max(0, Math.round(Number(bounds.x) || 0));
    const y = Math.max(0, Math.round(Number(bounds.y) || 0));
    const width = Math.max(120, Math.round(Number(bounds.width) || 120));
    const height = Math.max(120, Math.round(Number(bounds.height) || 120));
    videoSnifferView.setBounds({ x, y, width, height });
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:items', () => Array.from(snifferItems.values()));

  ipcMain.handle('video-sniffer:clear', () => {
    snifferItems.clear();
    snifferRequestHeaders.clear();
    if (videoSnifferWindow && !videoSnifferWindow.isDestroyed()) {
      videoSnifferWindow.webContents.send('video-sniffer:reset');
    }
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:copy', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:open-url', (_event, url) => {
    if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:download-url', (_event, payload) => {
    const url = payload && payload.url;
    if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'URL 无效' };
    pendingSnifferDownloadName = safeFileName(payload.filename || '');
    if (!videoSnifferView) return { ok: false, error: '浏览器未初始化' };
    videoSnifferView.webContents.downloadURL(url);
    return { ok: true };
  });

  ipcMain.handle('video-sniffer:merge-mp4', (event, payload) => {
    return startMp4Merge(event, payload || {});
  });

  ipcMain.handle('video-sniffer:media-info', async (_event, filePath) => {
    return probeMediaDuration(filePath);
  });

  ipcMain.handle('video-sniffer:delete-file', async (_event, filePath) => {
    try {
      const target = String(filePath || '');
      if (!target || !fs.existsSync(target)) return { ok: true, missing: true };
      const stat = fs.statSync(target);
      if (!stat.isFile()) return { ok: false, error: '只能删除文件' };
      fs.unlinkSync(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:remove-empty-dir', async (_event, payload) => {
    try {
      return removeEmptySnifferDir(payload);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:save-source-info', async (_event, payload) => {
    try {
      return saveSnifferSourceInfo(payload || {});
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  ipcMain.handle('video-sniffer:cancel-merges', () => {
    return { ok: true, count: cancelMergeJobs() };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#f4efe4',
    title: '改文 · 小说去AI味',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'renderer', 'preload-main.js'),
      webSecurity: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

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
  setupVideoSnifferIpc();
  setupAutoUpdater();
  createWindow();
  scheduleInfoScraperPolling();
  checkForUpdatesSoon();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
