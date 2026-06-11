# CODEMAP.md - 改文项目代码地图

## 根目录

| 路径 | 作用 |
| --- | --- |
| `main.js` | Electron 主进程,创建窗口、菜单、外链打开、自动更新检查。 |
| `package.json` | 项目脚本、依赖、electron-builder 打包和 GitHub Release 发布配置。 |
| `package-lock.json` | 依赖锁定文件。 |
| `.gitignore` | 忽略 `node_modules/`、`release/`、`renderer.zip` 等。 |
| `renderer/index.html` | UI、样式、登录、接口、路由编排、流式输出、历史、导入导出等核心逻辑。 |
| `renderer/kb-data.js` | 本地知识库 `window.KB`。 |
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
