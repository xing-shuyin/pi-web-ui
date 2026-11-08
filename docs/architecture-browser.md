# 内置浏览器与桌面 Agent

桌面应用将浏览器与现有 pi-web-ui Agent 组合在一个窗口，支持 browser、agent、split 三种模式。启动模式由设置项 `defaultMode` 决定，新用户默认 agent（本地 Agent sidecar 并行启动，就绪前由 shell 显示启动占位）；Agent 失败时可在占位上一键切到浏览器。npm/纯 Web 服务入口继续使用现有路径。

## 模块与边界

- `browser/contracts.ts`：浏览器公共状态和宿主接口；页面请求类型从 `server/protocol.ts` 派生。
- `browser/runtime/manager.ts`：唯一标签状态源，管理 WebContentsView、导航、恢复、持久 session、下载和释放。
- `browser/storage/index.ts`：书签树、历史、设置、加密凭据和旧数据导入。
- `browser/renderer/`：独立浏览器外壳、新标签页、书签/历史/设置/下载面板、文档与媒体页面，使用既有主题基线。
- `browser/automation/executor.ts`：页面操作执行器，不依赖聊天 UI。
- `browser/preload.cts`：安全能力握手；只给已确认角色暴露对应接口。
- `desktop/browser-host.ts`：浏览器与 Agent 的组合布局、IPC 角色验证、站点权限和用户选择文件的授权。
- `desktop/browser-policy.ts`：可信地址及布局纯函数。
- `desktop/main.ts`：单一应用启动、sidecar、更新与打包入口。

浏览器模块不导入 Agent 运行时，后端也不导入 Electron。后续浏览器地址栏、标签、导航、存储和性能优化可在 browser 内独立进行。Agent 通过宿主提供的专用原生视图加入布局。

## 窗口、模式与生命周期

BrowserWindow 的 webContents 加载本地 shell.html，标签与专用 Agent 使用 WebContentsView。

- **browser 模式**：全宽完整浏览器，顶部 88px 浏览器外壳（标签栏与地址栏），下方为网页视图；右上角提供模式切换回 Agent / 分栏；
- **agent 模式**：Agent 全尺寸全高占据整个视口（y: 0 开始），不显示任何浏览器标签与地址栏，保持与无结合时一致的纯净桌面体验与窗口控制/拖拽，并在顶栏提供浏览器切换按钮；
- **split 模式**：左右独立并列。左侧为完整的 Agent 视图（从顶到底 y: 0），右侧为独立的浏览器（右侧上方为局部的浏览器外壳，下方为网页视图），效果类似在桌面并列开了 Agent 窗口与浏览器窗口。

启动模式 = `BrowserSettings.defaultMode`（`agent` 默认 / `browser` / `split`）。两个入口写同一份设置：浏览器设置 → 启动模式，以及应用设置弹窗 →「桌面应用」页（仅桌面壳可见，经 `pi-desktop:browser-get/set-startup-mode` 走宿主 IPC）。运行期切换只改当前会话，不写回设置；旧版本存过的 `mode`（上次使用的模式）在首次读取时迁移为 `defaultMode`，老用户升级后启动行为不变。agent / split 启动时 Agent 首帧就绪前不显示 Agent 视图，由 shell 渲染 `pb-boot` 占位（含失败原因与「切换到浏览器模式」出口），就绪后再交给 Agent 视图并聚焦。

切换模式复用同一个视图并更新可见性、边界和焦点，不重载页面。隐藏页保留有效尺寸，不缩成 1×1。标签关闭时关闭对应 WebContents；应用关闭时清理标签、下载、Agent 和挂起通道。

原生视图不能被普通 DOM 的 z-index 覆盖。外壳打开设置等浮层时通过 overlay 通知宿主临时隐藏内容区；内部标签自己的浮层不隐藏其所在视图。Agent 可通过 `piDesktop.browser` 与宿主同步模式与标签状态。

窗口拖拽区（`-webkit-app-region`）不能挂在会消失的布局产物上：Agent 顶栏原先只靠 `.tb-spacer` 供拖拽，而窄分栏进手机视图后媒体查询把 spacer 收成 `display: contents`（无盒子＝无拖拽区），整个头部就再也拖不动窗口。现在 `body.is-desktop .topbar-flow` 自身声明 `drag`，交互条目逐条 `no-drag`，与 spacer 是否存在无关；回归守卫见 `tests/unit/desktop-agent-input-regions.test.ts`。

## 本地与远端 Web Agent

本地地址由实际 sidecar 启动结果提供，不固定 8787。桌面默认服务端口依照 `desktop/startup.ts`。可以在浏览器设置中连接并记住 HTTP/HTTPS 远端 Agent 地址。

使用内置浏览器打开该受信任地址时：

```text
Agent 服务 → 页面已有 WebSocket → page_request
→ __piWebUiHost.pageCall → __piBrowser.pageCall
→ 主进程授权检查 → browser automation → 目标标签
→ page_response 原路返回
```

`__piWebUiHost` 仍由 Web 应用维护。Web 前端优先检测 `__piBrowser`，无原生能力时继续原有 page-picker 路径。无需隐藏 Electron UA、额外用户插件或固定 7801 匿名 HTTP API。普通系统浏览器中网页的行为保持原有扩展接入方式。

此模式要求承载 Agent 网页的连接在线；它不自动提供无人值守或跨设备执行。也不自动读取系统 Chrome 的标签及登录态。

## 权限与数据

每次 IPC 都检查 mainFrame、当前 URL 和角色，不仅在 preload 初始化时检查：

- 外壳和精确列入名单的本地内部页可调用浏览器 UI、存储和文件选择能力。
- 本地/已配置 Agent origin 的受信任页面可调用页面执行接口；普通网站不能操作其他标签。
- 网站不获得浏览器书签、凭据或任意文件系统接口。
- 网站权限由 session handler 处理，敏感权限明确授权并按 origin 保存。
- eval 默认关闭，可在设置中显式启用。显式目标失效不得回退操作其他标签，同源多标签应使用稳定 tabId。
- 「用户当前打开的是哪个标签」属于协议事实，不是客户端猜测（原生侧唯一事实源是 `BrowserManager.getActiveTabId()`）：`browser_page` 的 `pages`/`status` 给当前标签打 `active: true` 并返回 `activeTabId`（只暴露可操作页面，内部页与调用方自己的视图不算）；多标签并存时仍要求显式 `target`，报错文案直接点名用户当前打开的那个标签。page-picker 同理：已授权页面里只有最后一个聚焦窗口的 active 标签会标 `active`，并给出 `activeOrigin`；未授权页面即便在前台也不上报（扩展不发 `tabs` 权限，只对已授 host 权限的 origin 查 `active: true, lastFocusedWindow: true`）。
- 本地文件必须由系统选择器授权，读取上限 32 MiB，文本文档可保存；二进制 Office 文档只读预览，禁止把文本写回原二进制文件。
- **口令框的值不出页面**：两条通道同一口径 —— `read what=query` 不返回 `value`、`text` 置空，`read what=html` 克隆后清掉 `value` 属性，`type` 回显也不带值。原生侧事实源 `browser/automation/page-operation.ts` 的 `isPassword`；page-picker 侧 `plugins/page-picker/extension/src/content/bridge-page.ts` 的 `isPassword`/`outerHtmlMasked`。改任何一侧都要同步：口令框能照常 `type` 填写，只是不再回显。回归见 `tests/unit/page-picker-password-mask.test.ts` 与 `tests/page-picker-bridge-test.mjs`。
- 扩展安装与「加载已解压扩展」同信任级：只接受用户手动选择的目录或 `.crx` 文件。`.crx` 由主进程剥掉 `Cr24` 签名头后解包（条目数/体积上限，禁止越界路径与链接，`manifest.json` 必须存在），**不校验签名**；解包目标 `userData/extensions/crx-<内容哈希>`，同一文件重装不换路径。装过的目录记入 `userData/extensions/installed.json`，重启时自动重新加载（Electron 的 `loadExtension` 本身不持久）。
- 拖入 `.crx` 也走同一条安装路径：内部页由 preload 的 `webUtils.getPathForFile` 取路径后调 `extensions.installCrx { path }`；拖到网页上的话由 `BrowserManager` 的导航守卫拦住 file:// 导航并交给 `onFileDrop`，主进程装完用系统弹窗回报。

浏览器文件与 session 位于 Electron userData/browser；Agent 原有数据目录继续使用原配置。凭据使用 Electron safeStorage，安全加密后端不可用时拒绝保存。保险箱可由用户明确选择填写当前网站，主进程与页面内都检查精确 origin，不自动提交表单。旧 AI Browser 数据可由用户选择旧目录导入，存在的目标文件不会覆盖；导入错误单列报告。

## 页面脚本注入（Agent → 网页）

Agent 可以给网页注入脚本：`browser_script` 工具（`server/browser-script-tool.ts`）→ `page_request`（`op: "script.list|status|create|update|remove|enable|disable|run"`）→ `desktop/browser-host.ts` 校验调用方 → `browser/automation/scripts.ts` → `BrowserManager`。线协议不新增字段（`op` 仍是字符串），主进程侧才真正注入。

- **一条记录、两种生命周期**：`PageScript`（`browser/runtime/scripts.ts`）的 `persistent` 决定它是写进 `userData/browser/scripts.json`（重启仍生效）还是只存在内存（关掉浏览器即消失）。临时脚本在页面刷新后会重新注入，这正是「临时」该有的语义；一次性改动 = 建临时脚本 → `run` → `remove`（顺带跑 cleanup）即可。
- **默认指向用户当前标签**：脚本默认目标与 `browser_page` 的 active 语义同一事实源（`BrowserManager.getActiveTabId()`）——省略 `matches` 时新脚本只作用于 target（缺省为当前标签）的站点，`script.run` 不给 target 时只打当前标签，`script.status` 会带 `activeTabId` 与每个标签的 `active`。显式传 `[]` 或 `*` 才是全站。
- **脚本不做能力限制**：不设代码体积、条数、匹配数上限，也不限制代码内容。脚本在目标网页里跑，天然拿不到宿主桥（`__piBrowser` / `__piWebUiHost` 只存在于 Agent 页面），主进程也从不执行脚本代码。
- **注入时机**：`dom-ready` 用 `executeJavaScript`（不受页面 CSP 限制）；`document-start` 用 CDP `Page.addScriptToEvaluateOnNewDocument`（只有它能抢在新文档首行），debugger 已被占用时降级为 dom-ready 并记 `lastError`；`world: "isolated"` 走 `executeJavaScriptInIsolatedWorld` / CDP `worldName`，拿不到页面 JS 句柄。CSS 走 `insertCSS`/`removeInsertedCSS`，比 JS 更干净地可撤销。
- **每个文档只跑一次**：`BrowserManager` 在 `did-start-navigation`（非 same-document）重置该标签的运行态，页面里还有一层 per-document `WeakMap` 令牌去重，重复的 `dom-ready` 或双通道注入都不会让同一脚本在一个文档里执行两次。
- **可撤销**：脚本顶层 `return function () {...}` 即是清理钩子，重跑/停用/删除前先调用它；页面里的注册表 `window.__piPageScripts` 可直接在 DevTools 里查。
- **可观测**：`script.status` 按标签返回 `{ injected, skipped: [{scriptId, reason}], errors }`（`scripts-disabled` / `internal-page` / `not-matched:<url>`），注入代码带 `//# sourceURL=pi-script://<id>/<name>.js`，DevTools 里可单独断点。
- **边界**：内部页（shell/newtab/workspace/office）从不注入；`allowScripts` 总开关关闭后全部跳过；普通网站无法通过任何入口管理脚本（`scripts.*` 只对外壳内部页开放）。设置面板「页面脚本」列出全部脚本（临时/永久徽标、来源、`document-start`/`isolated` 非默认徽标），可停用、查看代码、删除。

## 构建与验证

`npm run build:desktop` 编译 desktop/browser TypeScript，再由 `scripts/build-browser.mjs` 独立构建浏览器页面到 dist/browser/renderer。现有 Agent Vite 入口不变。Electron 打包包含 dist/desktop、dist/browser、dist/server 和 web/dist。

相关单测：browser-runtime、browser-storage、browser-credentials、browser-automation、browser-desktop、browser-crx，以及 browser-control、plugin-host、browser-page-tool、desktop-startup 的既有测试。页面脚本的匹配/注入/去重/落盘回归在 `tests/unit/browser-scripts.test.ts`。桌面冒烟见 `tests/browser-desktop-smoke.mjs`，使用独立临时数据和测试服务，不触碰用户实例。
