# KNOWN_ISSUES.md - 改文项目已知问题与修复原则

## 1. 命令后附加需求未识别

### 现象

用户输入:

```txt
/episode 1 每集内容850-900字
```

模型没有输出第 1 集,而是回复流程结束/等待新指令。

### 原因

前端最初只识别严格格式 `/episode 1`,命令后多出自然语言就掉到普通聊天。

### 修复原则

- `/episode N` 必须允许后面跟附加要求。
- 附加要求要作为高优先级写入 router 指令。
- 如果附加要求包含字数范围,必须明确要求按范围输出。

相关函数:

- `expandSlashCommandForRouter(reply)`

## 2. 用户不想手打推荐命令

### 现象

路由提示“输入 `/episode 1`”,用户还要照抄命令,体验差。

### 修复原则

- 用户留空点“继续”,等同于采用上一轮建议命令。
- 用户输入“继续/确认/OK/可以”,也等同于采用建议命令。
- 用户输入“确认 每集850-900字”,应转换成“建议命令 + 附加要求”。

相关函数:

- `normalizeContinueReply(replyText)`
- `inferSuggestedSlashCommand()`

## 3. 知识库 key 写错导致中断

### 现象

router 输出:

```txt
<load_kb>genre=guide</load_kb>
```

前端报错: `genre=guide` 不在 `window.KB`。

### 原因

真实 key 是 `genre-guide`,模型偶尔把 `-` 写成 `=` 或 `_`。

### 修复原则

- 增加 key alias 归一。
- 常见错误写法要自动转成真实 key。

相关函数:

- `KB_KEY_ALIASES`
- `normalizeKbKey(key)`
- `extractLoadKb(text)`

## 4. 历史记录不能继续改

### 现象

从历史记录恢复后,只能看,不能继续修改。

### 原因

旧恢复逻辑只恢复原文和改后文本,并设置 `session = null`。

### 修复原则

- 保存历史时保留:
  - `phase`
  - `scriptSnapshot`
  - `editLog`
  - `lastRouterOutput`
- 恢复历史时重建编辑态 `session`。
- 旧历史没有快照时,用 `revised` 兜底作为当前剧本。
- 恢复后显示回复框。

相关函数:

- `_saveCurrentSessionToHistory()`
- `restoreHistoryEntry(id)`

## 5. 输出像整段蹦出来

### 现象

右侧输出不是逐字流式,而是一大段突然出现。

### 原因

- 后端一次返回大块内容时,前端追赶速度过快。
- 捕获完整剧本后曾经直接 `textContent = cap.script`。

### 修复原则

- 大块内容也要按可见打字机速度展示。
- 捕获后的最终稿也要通过 `typeTextIntoElement()` 输出。

相关函数:

- `_streamOneCallOnce(...)`
- `typeTextIntoElement(el, text, onCount)`

## 6. 报错也消耗积分

### 现象

用户反馈“没输出内容,但积分花了”。

### 原因

前端曾对流式卡住做隐藏自动重试。后端如果按请求计费,多次重试会增加消耗。

### 修复原则

- 不做隐藏自动重试。
- 失败就停下,让用户明确选择是否继续。

相关函数:

- `streamOneCall(opts)`

## 7. 发布更新必须三件套齐全

### 现象

只上传 `.exe` 时,客户端无法正确自动更新。

### 修复原则

GitHub Release 必须包含:

- `latest.yml`
- `novel-rewrite-desktop-setup-x.y.z.exe`
- `novel-rewrite-desktop-setup-x.y.z.exe.blockmap`

`latest.yml` 中的文件名必须和 Release 资产名一致。

## 8. 未经批准不得发布

### 规则

未经用户明确批准,不要:

- 推送 GitHub
- 打 tag
- 创建 Release
- 上传安装包
- 发布自动更新

可以先本地修改、打包验证、展示 diff,等用户确认再发。

## 9. 视频抓取:开放站抓不到/抓得慢

### 现象

像 my-drama.com 这类站,不先在内置浏览器里把视频播一段,「获取全集」要么抓不到、要么逐集巡航很慢。

### 原因

旧「获取全集」只有两条路:① 已嗅探到带集号 m3u8 后按文件名规律外推(要先播放);② 逐集导航播放抓取(慢且脆)。而这类开放站其实把**整部剧全部 m3u8 + `totalEpisodes` 明文写在页面 HTML 里**(Next.js RSC 数据块),CDN 公开无 token——根本不用播放。

### 修复原则

- 「获取全集」最优先尝试**扒页面 HTML 抠全集**(`extractFromPageHtml` → 主进程 `extract-page-media`),抠到秒出全集。
- 抠不到(识别出的不同集号 < 2)就**无缝回落**到旧的模板外推 / 逐集巡航,不破坏 DramaShorts 等受保护站。
- 地址路径可能含字面量 `'`、`(`、`)`(如 `.../CEO's%20...%20(V1)/...`),抠地址的正则**只能**以双引号/空白/反斜杠/尖括号为界,不能排除这些字符,否则 URL 会被截断。
- 集号解析统一用渲染层 `extractResourceEpisodeNo`,不要在主进程另写一套。
- 仅对**免费/公开或用户已合法登录**的内容使用;带 token/签名鉴权、付费墙后的内容不在此路径覆盖范围。

相关函数:

- `extractFromPageHtml()`、`scanEpisodeRange()`(renderer)
- `extract-page-media` handler、`fetchPageHtml`、`extractPageMediaFromHtml`(main.js)
