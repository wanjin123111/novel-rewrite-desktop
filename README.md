# 改文 · 桌面客户端（Electron）

把原来那张网页（小说去AI味 / 改文工具）包成了一个真正的桌面软件。
界面、登录、模型选择、风格预设、流式改文——和网页版一模一样，只是现在能装到电脑上、有自己的窗口和图标。

---

## 这个文件夹里有什么

```
novel-rewrite-desktop/
├── main.js              ← 桌面外壳（开窗、加载网页）。一般不用改
├── package.json         ← 项目配置 + 打包设置
├── renderer/
│   └── index.html       ← 你的界面和全部逻辑都在这里。要改功能就改它
└── README.md            ← 就是你正在看的这份
```

**重点：以后想改界面、改提示词、加风格，只改 `renderer/index.html` 这一个文件就行。** 其他文件是壳子，基本不用碰。

---

## 第一步：装 Node.js（只装一次）

电脑上要先有 Node.js（Electron 靠它跑）。

1. 打开 https://nodejs.org/
2. 下载左边那个 **LTS**（长期支持版），一路下一步装完
3. 装完验证一下：打开命令行（Windows 按 `Win+R` 输 `cmd` 回车；Mac 打开"终端"），输入：
   ```
   node -v
   ```
   能显示一串版本号（比如 `v20.x.x`）就说明装好了。

---

## 第二步：在这个文件夹里装依赖（只装一次）

1. 把这个 `novel-rewrite-desktop` 文件夹放到一个好找的地方（比如桌面）
2. 命令行进入这个文件夹：
   - **最简单的办法**：在文件夹空白处右键，找"在终端中打开"/"Open in Terminal"
   - 或者在命令行里输 `cd ` 然后把文件夹拖进窗口，回车
3. 输入这条命令，等它跑完（第一次会下载 Electron，大概一两百兆，看网速，耐心等）：
   ```
   npm install
   ```
   跑完文件夹里会多出一个 `node_modules` 文件夹，正常现象。

---

## 第三步：先跑起来看看（开发预览）

输入：
```
npm start
```
软件窗口就弹出来了。这个模式适合一边改 `index.html` 一边看效果——改完代码，在窗口里按 `Ctrl+R`（Mac 是 `Cmd+R`）刷新就能看到最新改动。

> 调试小技巧：菜单栏（按 `Alt` 键调出）→ 视图 → 开发者工具，能看到报错，方便排查接口问题。

---

## 第四步：打包成可安装的软件

确认软件能正常用之后，就可以打包成别人能直接装的安装包了。

**打 Windows 安装包（.exe）**，在 Windows 电脑上运行：
```
npm run dist:win
```

**打 Mac 安装包（.dmg）**，在 Mac 上运行：
```
npm run dist:mac
```

打完之后，安装包在新生成的 `release` 文件夹里。

> ⚠️ 注意：**Windows 的 .exe 要在 Windows 电脑上打，Mac 的 .dmg 要在 Mac 上打。** 一台电脑通常只能打它自己系统的包，这是 Electron 的限制，不是 bug。

---

## 关于接口连接（重要）

这个桌面软件直接调用你后端的接口：
- 登录：`POST /api/c/auth/login`
- 用户信息：`GET /api/c/auth/me`
- 模型列表：`GET /api/c/scripts/reasoning/models`
- 改文（流式）：`POST /api/c/scripts/reasoning-stream`

桌面端为了能跨域连上你的后端，`main.js` 里关掉了浏览器的同源策略（`webSecurity: false`）。这是桌面应用的正常做法，不影响安全——它只连你登录时填的那个服务器。

登录页里的服务器地址、用户名会被记住（存在本地），下次打开自动填好。

---

## 想加个软件图标（可选）

默认用的是 Electron 自带图标。想换成自己的：

1. 准备图标文件：Windows 要 `.ico`、Mac 要 `.icns`（网上有免费的"png 转 ico/icns"工具）
2. 在项目里新建 `build` 文件夹，把图标放进去命名为 `icon.ico` 和 `icon.icns`
3. electron-builder 会自动识别 `build/icon.*`，重新打包即可

---

## 常见问题

**Q：`npm install` 卡住或报错？**
多半是网络问题（Electron 要从国外下载）。可以先设个国内镜像再装：
```
npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
npm install
```

**Q：登录提示连不上 / 接口报错？**
先用 `npm start` 跑开发模式，打开开发者工具（菜单→视图→开发者工具）看红色报错。一般是服务器地址填错，或后端没开。

**Q：改了 index.html 没反应？**
开发模式下窗口里按 `Ctrl+R`（Mac `Cmd+R`）刷新；打包版需要重新 `npm run dist:win` / `dist:mac`。
