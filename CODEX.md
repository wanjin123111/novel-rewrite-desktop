# CODEX.md - 改文项目维护规则

## 项目定位

这是一个 Electron 桌面应用,产品名为“改文”,用于小说/短剧改写、剧本规划、分集创作和继续修改。项目当前采用轻量单页结构,核心逻辑集中在 `renderer/index.html`,知识库数据集中在 `renderer/kb-data.js`。

## 必读顺序

维护本项目时,先按顺序阅读:

1. `CODEX.md`: 全局维护规则和高风险边界。
2. `CODEMAP.md`: 代码地图,定位具体功能在哪。
3. `KNOWN_ISSUES.md`: 已踩坑清单,避免重复犯错。
4. 相关源码文件。

## 技术栈

- Electron 主进程: `main.js`
- 前端页面/业务逻辑: `renderer/index.html`
- 本地知识库: `renderer/kb-data.js`
- 打包工具: `electron-builder`
- 自动更新: `electron-updater`
- 发布渠道: GitHub Releases,仓库 `wanjin123111/novel-rewrite-desktop`

## 维护原则

- 保持改动小而准,优先修问题本身,不要顺手大重构。
- 修改前先定位相关函数,尤其是 `session` 状态、路由编排、历史恢复、流式输出这几块。
- 不要破坏 `package.json` 里的 `build.publish`、`artifactName` 和自动更新配置。
- 不要把 `node_modules/`、`release/` 或安装包提交到源码仓库。
- 不要隐藏自动重试会产生计费请求的接口调用。
- 涉及用户输入、路由命令、历史恢复的改动,必须同时检查 `continueRewrite`、`expandSlashCommandForRouter`、`restoreHistoryEntry`。

## 发布纪律

未经用户明确批准,不要执行以下操作:

- `git push`
- `git tag`
- 创建 GitHub Release
- 上传 `latest.yml`、`.exe`、`.blockmap`
- 发布自动更新版本

本地允许做的事:

- 阅读文件
- 修改文件
- 本地打包验证
- 查看 `git diff` / `git status`

发布前必须说明:

1. 改了哪些文件。
2. 修复了什么问题。
3. 是否已打包。
4. 是否准备推送 GitHub。
5. 等用户确认后再发布。

## 自动更新注意

GitHub Release 必须同时包含:

- `latest.yml`
- `novel-rewrite-desktop-setup-x.y.z.exe`
- `novel-rewrite-desktop-setup-x.y.z.exe.blockmap`

版本号必须递增,否则旧客户端不会收到更新。

## 重点风险

- `renderer/index.html` 是单文件大逻辑,不要随意移动函数顺序。
- 历史记录恢复必须重建可继续编辑的 `session`。
- 路由建议命令必须允许用户留空点继续,也要识别命令后的附加需求。
- 知识库 key 要兼容模型误写,例如 `genre=guide` 应归一成 `genre-guide`。
- 流式输出不能整段闪现,也不能用过快追赶速度造成“蹦出来”。
