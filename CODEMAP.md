# CODEMAP.md - 改文项目代码地图

## 根目录

| 路径 | 作用 |
| --- | --- |
| `main.js` | Electron 主进程,创建窗口、菜单、外链打开、自动更新检查、**视频抓取(嗅探/合成)**、历史磁盘备份。 |
| `package.json` | 项目脚本、依赖、electron-builder 打包和 GitHub Release 发布配置。 |
| `package-lock.json` | 依赖锁定文件。 |
| `.gitignore` | 忽略 `node_modules/`、`release/`、`renderer.zip` 等。 |
| `renderer/index.html` | UI、样式、登录、接口、路由编排、流式输出、历史、导入导出等核心逻辑。 |
| `renderer/kb-data.js` | 本地知识库 `window.KB`。 |
| `renderer/preload-main.js` | 主窗口 preload,暴露 `gaiwenDesktop`(打开视频抓取窗、历史磁盘备份)。 |
| `renderer/video-sniffer.html` | 视频抓取窗 UI + 逻辑:内置浏览器、资源嗅探、整集整理、获取/下载全集。 |
| `renderer/preload-video-sniffer.js` | 视频抓取窗 preload,暴露 `videoSniffer` 全部 IPC。 |
| `release/` | 打包产物,不提交源码仓库。 |

## `main.js` 关键区域

- `createWindow()`
  - 创建主窗口。
  - 加载 `renderer/index.html`。
  - 当前关闭了 `webSecurity` 以支持桌面端跨域请求。

- `setupAutoUpdater()`
  - 配置 `electron-updater`。
  - 下载完成后弹窗提示“立即重启更新”。

- `checkForUpdatesSoon()`
  - 仅在 `app.isPackaged` 时检查更新。
  - 开发模式 `npm start` 不检查更新。

- `buildMenu()`
  - 复制、粘贴、刷新、开发者工具等菜单。

## 视频抓取(video-sniffer)关键区域

文档此前未记录此功能。它是独立的第二个窗口,跟改写主流程无关。

### `main.js` 侧

- `setupVideoSnifferSession()` / `createVideoSnifferWindow()` / `createVideoSnifferView()`
  - 独立分区 `persist:gaiwen-video-sniffer` 的内置浏览器。
  - `webRequest` 钩子嗅探媒体响应(`detectMediaResource`),推送给抓取窗。

- `setupVideoSnifferIpc()`
  - 全部 `video-sniffer:*` IPC handler。

- `startMp4Merge()` / `buildFfmpegArgs()`
  - 调内置 `ffmpeg-static` 把 m3u8/分片 `-c copy` 封装成 mp4。
  - 支持 `payload.outputPath`(批量下载时跳过保存对话框)。

- **`extract-page-media` 快速路径(扒页面抠全集)**
  - `fetchPageHtml(url)`: 用 `net.request` 拉整页原始 HTML(带嗅探分区 Cookie、跟随重定向)。
  - `extractPageMediaFromHtml(html)`: `unescapeForScan` 还原转义后,正则抠出全部 m3u8 + `totalEpisodes` + `<title>`。
  - 适合 my-drama 这类把全集地址明文写在页面、CDN 公开无 token 的开放站,**不用播放/翻页/猜模板**。
  - 集号解析不在主进程做,交渲染层 `extractResourceEpisodeNo` 统一处理。

### `renderer/video-sniffer.html` 侧

- `extractFromPageHtml()`
  - 调 `api.extractPageMedia`,按集号去重,识别出 ≥2 个不同集号(或页面自报 totalEpisodes)才认定全集页,塞进 `resources`(synthetic 项)。

- `scanEpisodeRange()`(「获取全集」按钮)
  - 三级回落:① `extractFromPageHtml` 扒页面秒出 → ② `deriveEpisodeTemplate` 文件名规律外推 → ③ `autoAdvanceScan` 逐集巡航播放抓取。

- `downloadEpisodeRange()` / `downloadListedEpisodes()` / `mergeEpisodeToDir()`
  - 「下载全集」:把列表里已整理的整集逐集调 `mergeMp4` 合成到目录。synthetic 项也走这条,无需特判。

## `renderer/index.html` 关键区域

### 基础状态

- `LS`
  - localStorage 封装。
  - 保存 token、用户、服务器地址、模型、风格、提示词 override。

- `session`
  - 当前改写会话状态。
  - 关键字段:
    - `baseContent`
    - `routerContent`
    - `userConversation`
    - `lastRouterOutput`
    - `phase`
    - `scriptSnapshot`
    - `editLog`
    - `totalPointsCost`

### 登录与接口

- `apiUrl(path)`
  - 拼接后端地址。

- `apiFetch(path, opts)`
  - 标准 JSON 请求。

- `doLogin()` / `logout()` / `enterApp()` / `refreshMe()`
  - 登录、退出、进入主界面、刷新用户信息。

- `resolveRouterId()` / `loadModels()`
  - 根据模型标识解析真实数字 ID。
  - 路由模型标识: `script-reasoning-step13888`。

### 知识库加载

- `LEGACY_ID_MAP`
  - 旧数字模型 ID 到知识库 key 的兼容映射。

- `KB_KEY_ALIASES`
  - 模型写错 key 时的别名归一。
  - 例如 `genre=guide` -> `genre-guide`。

- `normalizeKbKey(key)`
  - 知识库 key 规范化。

- `extractLoadKb(text)`
  - 从 router 输出中提取 `<load_kb>`。
  - 支持旧 `<load_model>` 映射。

### 路由编排

- `startRewrite()`
  - 新建 `session`,清空输出区,启动编排。

- `continueRewrite(replyText)`
  - 用户继续对话/修改/确认下一步。
  - 会调用 `normalizeContinueReply()` 和 `expandSlashCommandForRouter()`。

- `normalizeContinueReply(replyText)`
  - 用户留空点继续,或输入“继续/确认/OK”时,自动采用上一轮建议命令。

- `inferSuggestedSlashCommand()`
  - 从上一轮 router 输出中提取建议命令,如 `/episode 1`。

- `expandSlashCommandForRouter(reply)`
  - 将 `/episode 1 每集850-900字` 这类输入展开为强约束 router 指令。
  - 支持 `/episode`、`/characters`、`/plan`。

- `buildRouterRequestContent()`
  - 返回当前要喂给 router 的内容。

- `runOrchestration({ statusOnStart })`
  - 主编排循环。
  - 调 router,解析 `<load_kb>`,注入知识库,继续调用 router,直到产出或停下。

### 流式输出

- `streamOneCall(opts)`
  - 包装单次流式请求。
  - 当前不做隐藏自动重试,避免多次计费。

- `_streamOneCallOnce(...)`
  - 真正请求 `/api/c/scripts/reasoning-stream`。
  - 解析 SSE。
  - 打字机输出。

- `typeTextIntoElement(el, text, onCount)`
  - 对捕获后的最终稿/方案做逐字显示。

### 两阶段剧本与编辑态

- `SCRIPT_BEGIN` / `SCRIPT_END`
  - 旧自动模式标记,当前仍有兼容捕获逻辑。

- `feedScriptCapture(text)`
  - 捕获完整剧本快照。

- `enterEditDone(out, routerOutput)`
  - 进入编辑态,保存快照,显示回复框。

- `buildEditRequest(script, log)`
  - 编辑态请求体: 当前剧本 + 编辑对话。

- `editAwaitReply(out, routerOutput)`
  - 编辑态反问/等待用户回应。

### 历史记录

- `HISTORY_LS_KEY = 'nr_history'`
  - localStorage 历史记录 key。

- `_saveCurrentSessionToHistory()`
  - 保存历史。
  - 必须保留可继续修改所需字段:
    - `phase`
    - `scriptSnapshot`
    - `editLog`
    - `lastRouterOutput`

- `restoreHistoryEntry(id)`
  - 恢复历史。
  - 必须重建 `session`,不能再 `session = null`。
  - 恢复后显示回复框,可继续修改。

- `exportHistoryJson()` / `importHistoryJsonFromFile(file)`
  - 历史备份导入导出。

### 导入导出

- `handleImportFile(file)`
  - 支持文本/docx 导入。

- `exportRevised(fmt)`
  - 导出改后内容。

- `_buildDocx(text)`
  - 前端构建 docx。

## 常用命令

```bash
npm start
npm run dist:win
```

## GitHub Release 资产

打包后看 `release/latest.yml`,确认它指向当前版本的安装包。
