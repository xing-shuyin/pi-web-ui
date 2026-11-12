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
  标签栏的每页图标跟站点走：主进程监听 `page-favicon-updated`，只收 http(s) 与小尺寸 `data:image`（`pickTabFavicon`，超长 data URL 与 `javascript:`/`file:` 一律丢掉），主框架导航开始时先清空；外壳渲染成 `<img class="pb-tab-favicon">`，加载失败或没有图标回退地球图标，内部页仍是 `π`。
- **agent 模式**：Agent 全尺寸全高占据整个视口（y: 0 开始），不显示任何浏览器标签与地址栏，保持与无结合时一致的纯净桌面体验与窗口控制/拖拽，并在顶栏提供浏览器切换按钮；
- **split 模式**：左右独立并列。左侧为完整的 Agent 视图（从顶到底 y: 0），右侧为独立的浏览器（右侧上方为局部的浏览器外壳，下方为网页视图），效果类似在桌面并列开了 Agent 窗口与浏览器窗口。

启动模式 = `BrowserSettings.defaultMode`（`agent` 默认 / `browser` / `split`）。两个入口写同一份设置：浏览器设置 → 启动模式，以及应用设置弹窗 →「桌面应用」页（仅桌面壳可见，经 `pi-desktop:browser-get/set-startup-mode` 走宿主 IPC）。运行期切换只改当前会话，不写回设置；旧版本存过的 `mode`（上次使用的模式）在首次读取时迁移为 `defaultMode`，老用户升级后启动行为不变。agent / split 启动时 Agent 首帧就绪前不显示 Agent 视图，由 shell 渲染 `pb-boot` 占位（含失败原因与「切换到浏览器模式」出口），就绪后再交给 Agent 视图并聚焦。

切换模式复用同一个视图并更新可见性、边界和焦点，不重载页面。隐藏页保留有效尺寸，不缩成 1×1。标签关闭时关闭对应 WebContents；应用关闭时清理标签、下载、Agent 和挂起通道。

原生视图不能被普通 DOM 的 z-index 覆盖，所以外壳面板（书签 / 历史 / 下载 / 设置 / 扩展）**不再用 DOM 浮层 + 隐藏内容区**：一块面板 = 一个 `panel.html` 视图（`WebContentsView`），比页面视图晚加入 `contentView` 即盖在它上面，宿主按面板自己回报的尺寸把它摆成工具栏下沿、贴窗口右侧的一块矩形（`desktop/browser-policy.ts` 的 `panelLayerBounds`）。矩形之外的网页与 Agent 分栏照常可见、可点——这正是修「一点开插件列表，页面和聊天全变黑」的地方。

- 开/收走 `panel` 动作（`{ open, panel }`）；同一个面板再点一次就是收起（工具栏按钮本身是开关，不需要前端记状态）。尺寸由面板页回报（`{ size }`），面板自己量、宿主夹进可用区域；量不出来有兜底时长（`PANEL_LAYER_SHOW_DELAY`）。
- 面板在自己的视图里，`window` 事件跨不过去：书签 / 设置 / 扩展的改动走 `panel` 的 `{ event }`，宿主转发成 `pi-browser:panel-event`（`browser/preload.cts` 的 `onPanelEvent`），外壳与新标签页各自刷新。
- 面板里的动作要「先办事再收面板」（导航、开扩展页）：视图销毁会带走后面那次 IPC。
- 内部标签页（新标签页等）自己的浮层仍用本页 DOM：`dialog.show()` 而不是 `showModal()`——不要 `::backdrop` 遮罩、不把整窗变 inert，点面板外或 Esc 收起（`browser/renderer/panels.ts` 的 `handleOutsidePointer`/`handlePanelEscape`）。
- `overlay` 动作现在只服务外壳的搜索浮层：那是盖满整块内容区的 DOM 浮层，内容视图得让位，和面板是两回事。

Agent 可通过 `piDesktop.browser` 与宿主同步模式与标签状态。

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
- 扩展安装与「加载已解压扩展」同信任级：只接受用户手动选择的目录或 `.crx` 文件。`.crx` 由主进程剥掉 `Cr24` 签名头后解包（条目数/体积上限，禁止越界路径与链接，`manifest.json` 必须存在），**不校验签名**；解包目标 `userData/extensions/crx-<内容哈希>`，同一文件重装不换路径。装过的目录记入 `userData/extensions/installed.json`（`{ path, enabled }[]`，旧版纯字符串数组仍可读），重启时只恢复 `enabled` 的那些（Electron 的 `loadExtension` 本身不持久）。
- 扩展面板由浏览器工具栏的扩展图标（`shell.ts` 的拼图按钮，徽标=已启用数量）打开，和 Chrome 的扩展菜单同一个入口语义：**一行一个扩展，点整行就开它自己的页面**（`default_popup`，没有就退到选项页），启停开关在行首，重载/选项/移除在行尾 `⋯`（与右键同一张原生菜单）。面板是小浮层（`pb-dialog-compact`，360px 宽、高矮跟着列表走），不是整屏大窗。`extensions.list` 把「会话里真正加载的」（`session.extensions.getAllExtensions()`）与「`installed.json` 记住的」合并，停用项的名字/版本回磁盘读 manifest 补，已加载项带上 `popup`（manifest 的 `action`/`browser_action`/`page_action` 的 `default_popup`，规则单源在 `browser/runtime/extension-state.ts`）。`extensions.toggle` 停用= `removeExtension`，启用=重新 `loadExtension`；`extensions.reload` 先卸再装同一目录（改完扩展代码不用重启应用）；`extensions.remove` 只卸载 + 从清单里忘掉，**不删磁盘目录**（用户选的解压目录不该被浏览器删）。设置面板只留一个「管理扩展」入口，不再重复列出扩展。
- 工具栏上的扩展图标由 `electron-chrome-extensions` 的 `<browser-action-list>` 渲染（见下节「扩展能力边界」），点击开的就是 Chrome 语义的 `default_popup` / `onClicked`。扩展**面板**行是同一个语义：点整行走 `extensions.openPopup { path, anchor }`，用**同一 session 的独立无边框小窗**加载 `chrome-extension://<id>/<default_popup>`，定位在**鼠标点下去的位置**（面板行记 `pointerdown` 的视口坐标→屏幕坐标；键盘或点在行外时回退到行右下角；按屏幕工作区收边）、窗口是**直角**的（`roundedCorners: false`，macOS 默认圆角会把扩展页四角切掉一块）、失焦即关——同一扩展的页面只保留一个窗口；开之前先收起面板（浮层不盖在刚打开的网页上，网页随之还回来），但收面板不能把焦点抢回外壳——动作弹窗此刻正握着焦点，抢一下它就 blur 自关（mac 上实测「弹窗一闪而逝」）：`closePanelLayer()` 见到聚焦的动作弹窗就不还焦点，弹窗亮出后 300ms 内的失焦也不算关闭（`ACTION_POPUP_BLUR_GRACE_MS`），停用行则提示先启用。弹窗窗口**按扩展页自己要的尺寸开**（Chrome 的 popup 就是内容多大开多大，不是固定 400×560，否则窄页面上两侧会空出一大条）：开窗前在页面里量尺寸，两个口径取小者：内容盒（`body.scrollWidth/scrollHeight`，固定宽度的弹窗——Dark Reader 那种 285px popup——在这里最准）与后代盒子外接框（`body` 被视口撑满时真正的尺寸在子元素上；和视口一样宽/高的盒子只算被撑开的容器，比视口还高的算有效信号；滚动条只在内容高度超过 Chrome 上限、真的会出竖滚动时才占宽度）。取小者是必须的：绝对定位的 tooltip、动画移出视口的折叠区会把外接框撑到远超内容，只信外接框就会量出 550px 宽、右边留一条黑边；随后夹到 Chrome 的 800×600 上限内，量两趟（宽度一变文字会重新折行），量不到就退回兜底尺寸；纯函数与量尺寸脚本在 `browser/runtime/extension-popup.ts`（单测 `tests/unit/extension-popup.test.ts`）。两条路径同一个口径：Chromium 的首选尺寸模式（`preferred-size-changed`）对 `chrome-extension://` 页面实测不发事件，所以工具栏动作图标那条（库的 `PopupView`）也被接管——宿主监听 `browser-action-popup-created`，先给窗口一个正常视口、用同一套量法量出内容尺寸，再调库自己的 `updatePosition()`（锚点与对齐在库手里）并 `show()`；不接管的话窗口会卡在 25×25 且一直藏着（点图标没反应）。选项页走 `extensions.openOptions { path, anchor }`（`options_ui.page` 优先，其次旧式 `options_page`）：开了普通可调大小的窗口、失焦不关——Chrome 的「标签页 / 嵌在 chrome://extensions 里」两种展示在这里统一成一个正常窗口，`open_in_tab` 不参与建模。浏览器导航策略不变——只有「已加载扩展自己声明的页面」能开，`extensionPageUrl` 会校验 id 形状并拒绝 `..`/绝对路径/带协议的路径，不接受任意 `chrome-extension://` 地址；扩展页里的外部链接走系统浏览器（`setWindowOpenHandler` deny + `shell.openExternal`）。原生回归见 `tests/browser-desktop-smoke.mjs`（预置已解压扩展 → 启动恢复 → 弹窗 + 选项页 → 停用/启用/重载/移除）。
- 扩展行的 `⋯` 与右键是**同一张原生菜单**（`extensions.menu { items, anchor }`）：菜单项的文案、勾选态、可用态由渲染层拼（跟界面语言走），主进程只负责 `Menu.popup` 并把选中项 id 回传，关掉菜单返回 `null`；未加载的扩展不出现「弹窗 / 选项」。不再另写一行用法提示——菜单按钮本身就是入口。
- 拖入 `.crx` 也走同一条安装路径：内部页由 preload 的 `webUtils.getPathForFile` 取路径后调 `extensions.installCrx { path }`；拖到网页上的话由 `BrowserManager` 的导航守卫拦住 file:// 导航并交给 `onFileDrop`，主进程装完用系统弹窗回报。

### 扩展能力边界（Electron ≠ Chrome）

Electron 44 的扩展上下文只认 **15 个命名空间**（`action alarms declarativeNetRequest dom extension i18n idle management offscreen proxy runtime scripting storage tabs webRequest`），`tabs` 还缺 `create/remove/captureVisibleTab`，`storage.sync` 没有后端。扩展生态假设全套 API 都在，所以这里分两层：

**第一层：`electron-chrome-extensions`（`desktop/browser-host.ts`）——语义层，不拥有窗口。**
它在扩展 session 上补出 `windows / contextMenus / notifications / cookies / webNavigation / permissions / commands / downloads / topSites / privacy`，并把 tabs/windows 的写操作回调到**我们自己的模型**：`createTab → BrowserManager.createTab`、`selectTab → activateTab`、`removeTab → closeTab`、`createWindow → 独立 BrowserWindow`（popup 类型给无边框小窗，建完 `addTab` 让 `chrome.tabs.query` 看得见）、`removeWindow → destroy`（拒绝关主窗口）、`requestPermissions → 弹原生确认`。标签生命周期由 `BrowserManagerOptions.extensionHooks` 在 `createTab/activateTab` 处上报，右键菜单走 `webContents.on("context-menu") → getContextMenuItems()` 拼原生 `Menu`（编辑项 → 扩展项 → 后退/前进/重载）。

工具栏动作：库的 `<browser-action-list>` 由 `desktop/preload.cts` 里的 `injectBrowserAction()` 注入（只对 `shell.html` 生效，preload 用 esbuild 打成单文件——沙箱 preload 不能做模块解析），`shell.ts` 动态创建元素，`partition` 取 `browser/contracts.ts` 的 `BROWSER_EXTENSION_PARTITION`，主进程用 `setSessionPartitionResolver` 把它映射回 `session.fromPath()` 的浏览器 session；图标走 `ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)` 提供的 `crx://`。点图标就是 Chrome 的语义：开 `action.default_popup` 或触发 `chrome.action.onClicked`，badge/title/icon 全由库维护。

**第二层：`browser/runtime/extension-compat.ts`——只补第一层也没盖的缺口。**

- `chrome.tabs.captureVisibleTab / duplicate / move / highlight / discard`（库没实现）；
- `chrome.storage.sync` 落到 `local`（库已映射一次，这里是无库时的兜底）；
- 入口三处都盖：MV3 `background.service_worker` 包一层 `__pi-sw.js`（classic `importScripts`、`type: module` 用 `import`）、MV2 `background.scripts` 前插一行、`content_scripts` 逐个插（`world: "MAIN"` 不插），声明的 popup/options 页在 `<head>` 插 `<script src="/__pi-compat.js">`。
- **不再假装成功**：调不通的成员回调 `undefined` 并打一条 `[pi] chrome.<api> is not implemented` 警告，而不是返回 `[]/true` 骗扩展。

约束与边界：

- 库的 preload 最后会 `Object.freeze(chrome)`：**顶层新增命名空间已经不可能**（例如 `fontSettings`），兼容层只能往已有命名空间里补成员。
- 只写 crx 解包目录（`userData/extensions/crx-<hash>`），用户自己「加载已解压扩展」选的目录一个字节都不改；幂等，原 manifest 备份 `manifest.original.json`，版本标记 `__pi-compat.json`（`COMPAT_VERSION`，3 起配合语义层），开机自愈升级。
- **`declarativeNetRequest` 静态规则由我们真正执行**（`browser/runtime/dnr.ts`）：Electron 自己的 DNR 只存不拦（实测确认），宿主读已加载扩展 manifest 里 `declarative_net_request.rule_resources` 的 JSON，编成 `session.webRequest.onBeforeRequest` 的判定——这是 Electron 里唯一真能拦请求的通道。支持 `block`/`allow`、`urlFilter`/`regexFilter`、`resourceTypes`/`excludedResourceTypes`、`domains`/`requestDomains`/`initiatorDomains` 及排除项、优先级（高者胜，同优先级 allow 胜 block）；host 权限门禁按 Chrome 语义（`example.com` 不覆盖子域，子域要写 `*.example.com`）。字面量预筛 + 正则体积/回引限制控制开销与 ReDoS；内置页面（`file:`）与扩展页永不拦截。扩展加载/停用/移除/重载后合并成一次刷新。
- 仍然做不到的：动态/会话 DNR 规则（存在扩展的 LevelDB 里，主进程读不到）、`redirect` / `modifyHeaders` / `allowAllRequests` 动作、`sidePanel` / `tabGroups` / `identity`、以及 `fontSettings` 这类库不提供又被 freeze 挡住的命名空间；MV2 的 `webRequest` blocking 仍可用但已被 Electron 44 标 deprecated。
- `chrome.tabs.captureVisibleTab` 有真实现：宿主把一小段桥脚本（`browser/runtime/extension-bridge.ts`）挂到浏览器 session 的 frame / service-worker，扩展上下文里才有 `__piExtensionBridge`（普通网页 `location.protocol !== "chrome-extension:"`，什么都不暴露）；主进程再校验 sender 属于同一 session 且来源是 `chrome-extension://`，截当前激活标签的 `capturePage()`，支持 `format: jpeg` + `quality`。
- 兼容层还补了库的两个小缺口：`windows.getAll({ populate: true })` 用真实 `tabs.query` 填每个窗口的 `tabs`（库的 dist 里没有 populate 实现）；`chrome.storage.sync` 落到 local。剩余仍是空实现的只有 `tabs.duplicate / move / highlight / discard`。

判断依据是主进程 stderr 里的 Chromium 日志（`ExtensionLoadWarning` / `Extension Error` 块）。原生回归见 `tests/browser-desktop-smoke.mjs`：工具栏渲染动作按钮 → 点击开 `chrome-extension://<id>/popup.html`、`extensions.list` 恢复、面板弹窗/选项页、停用/启用/重载/移除、`crx compat shim` 用例（手搓 crx → 解包 → 包装 manifest → SW 用 `chrome.windows` 不崩 → 选项页拿到库命名空间与兼容层补的 `tabs` 成员 → 内容脚本仍注入）。纯函数与幂等性见 `tests/unit/extension-compat.test.ts`。

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

## 凭据保险库（密码 + TOTP）

工具栏钥匙图标 → `vault` 面板（`BROWSER_PANELS` 的一员，走同一套 `panel.html` 浮层视图）。密码与 TOTP 在用户眼里是同一件事（"这个网站的凭据"），所以合并成一块面板、两个分段标签，共用一套交互。外壳可以用 `panel { open, panel: "vault", tab: "totp" }` 指定先开哪个标签（钥匙图标固定开 TOTP，设置里的「打开凭据保险库」开密码）。

### 共同交互（设计 C：图标工具条）

- **动作只在顶部一行**：面板不给条目挂按钮，动作统一收进标题栏的动作槽（`panels.ts` 的 `.pb-dialog-actions`）。按钮纯图标（无障碍名走 `aria-label`），名字靠 `data-tip` 的 CSS 悬浮气泡（`title` 留空，避免原生提示叠加）；最右两个图标用 `data-tip-end` 贴右对齐，免得被浮层圆角裁掉。工具条随标签切换：密码是 `添加 ｜ 填入 / 显示密码 / 编辑 / 删除`，TOTP 是 `扫码 / 导入图片 / 添加 ｜ 填入 / 导出此条 / 导出全部 / 改名 / 上移 / 下移 / 删除`。
- **先选中再操作**：点条目或键盘 ↑↓ 选中，工具条作用于选中那条；没选中时动作图标 `disabled`（灰度、`::after` 气泡不弹），首尾两端的上/下移也置灰。命中当前标签页的条目打开即选中并置顶，所以「打开面板 → 点填入」两下就完事。`Enter` 填到页面；TOTP 标签的 `Shift+Enter` 复制验证码、密码标签的是显示/收起密码。
- 设置面板里的「密码库」段只留一句说明和一个入口（`vaultSection`），真正的增删改都在这里，避免两处各维护一套列表。
- 面板浮层视图（`panel.html`，`body.pb-panel-layer`）是第三套根：`[hidden]` 的全局豁免名单里必须带上它，否则 `.pb-form{display:flex}` 之类的规则会把 `hidden=true` 的表单照样画出来（「添加」表单默认展开的 bug 就出在这里）。

### 密码

- **列表不下发明文**：`passwords.list` 返回投影 `{ id, name, url, username, createdAt, hasPassword }`（主进程 `browser-host.ts` 里去掉 `password`），和 TOTP 的「secret 不出主进程」同一条口径。要明文只有两条口子：`passwords.reveal { id }`（用户点「显示密码」时取一次，界面 10 秒后自动盖回）和 `passwords.fill`（主进程内部取出来直接填页面，明文不经过渲染层）。
- **写回只走细粒度动作**：`passwords.upsert { id?, name, url, username, password? }`（`id` 存在即更新，`password` 留空表示沿用旧密码）与 `passwords.remove { id }`。渲染层拿不到整份明文，所以不能让它 `save` 全量列表——旧的 `passwords.save` 只保留给冒烟测试/迁移用。
- **填密码校验同源**：`passwords.fill` → `fillCredential()`，要求当前标签页与条目 `url` 的 **origin 完全相等**，且页面上只有一个可见密码框；填完只发 `input`/`change`，由用户自己点提交。
- 加密仍然走 `BrowserStorage` 的 `enc:<safeStorage>`，`passwords.available`（= `isEncryptionAvailable()`）为假时面板显示保险库锁定。

### TOTP

- **扫码 = 截当前标签页，不读 DOM**（`totp.scan` → `WebContents.capturePage()` → `browser/runtime/qr.ts`）：页面里的二维码可能是 `<img>`、`<canvas>`、内联 SVG、CSS 背景或 canvas 动态绘制，逐种抓法都要对付 CORS 与跨域画布污染；截图对它们一视同仁，也不需要摄像头权限。代价是**二维码必须可见于视口**，否则报错让用户滚动。解码用 `jsqr`（纯 JS，唯一新增运行时依赖），`NativeImage.toBitmap()` 给的是 **BGRA**，`bgraToRgba()` 换序后再喂。图片导入（`totp.importImage`）走 `nativeImage.createFromDataURL()`，同一条解码路径。
- **只收 `otpauth://totp`**：`parseOtpauth()`（`browser/runtime/totp.ts`）拒绝普通网址二维码与 `hotp`，报错而不是把乱码当密钥；算法/位数/周期都带白名单（SHA1/SHA256/SHA512、6–8 位、1–3600s）。
- **secret 永不出主进程**：渲染层只拿 `PublicTotpEntry`（`publicTotp()` 投影，无 secret），要码就发 `totp.code { id }` 让主进程算（`totpCode()`，RFC 6238）。唯一会把 secret 带出来的是用户显式点击的 `totp.export`（otpauth URI）。
- **加密**：`BrowserStorage.listTotp/saveTotp` 把 secret 存成 `enc:<safeStorage>`，落在 `userData/browser/totp.json`；`totp.available` 先行探测。
- **按站点自动匹配**：条目带 `origin`（扫码时那个页面的 origin，只认 http/https 且只做精确相等——`https://github.com` 不覆盖 `https://gist.github.com`）。当前标签命中时工具栏图标带一个小圆点，面板把该条目置顶；命中判断在渲染层做（`shell.ts` 的 `refreshTotpMatch`，数据来自 `totp.list`），改动后靠 `pb-vault-changed` 面板事件回灌。
- **填码不自动提交**：`totp.fill` → `browser/runtime/credentials.ts` 的 `fillTotpCode`，站位顺序是 `autocomplete="one-time-code"` → 一组 `maxlength=1` 的分格输入框 → 名称/占位符像验证码的单框 → 当前聚焦的框；填完只发 `input`/`change`。
- 排序（`totp.reorder`）、改名/改绑定（`totp.update`）、删除（`totp.remove`）都在工具条上，写回同一份加密文件；列表顺序就是 `order` 字段，未列出的条目在重排后保留在尾部，不丢数据。
- 纯逻辑（Base32/HOTP/TOTP 的 RFC 6238 向量、otpauth 各种变体、投影、排序、origin 匹配、二维码位图解码）全在 `tests/unit/totp.test.ts`，不依赖 Electron。

## 自定义新标签页与主题覆盖（用户改 / Agent 设计）

内置页（shell / panel / newtab / office / workspace）是构建产物，只读且打包后不可写；用户与 Agent 的自定义内容一律落在 **Electron `userData/browser/custom/`**：`newtab.html`（新标签页，自包含 HTML）与 `theme.css`（主题覆盖）。单源在 `browser/runtime/customize.ts`（`BrowserCustomization`：路径、大小上限、原子写、状态、回落规则）。

- **一个 kind 一个文件**：新标签页就是一份完整 HTML（inline `<style>`/`<script>` 随便写，不引入模板语法或多文件工程）；主题就是一份 CSS。写空正文 = 恢复默认（不会留一个空白页把人困住）；超过 512KB 直接报错而不是截断（挡住「把 20MB base64 图片塞进新标签页」）。
- **谁打开它**：`BrowserManager` 把 `newtab` / 空地址 / 旧的自定义地址统一换成 `customization.newTabUrl()`（`targetUrl()`），所以 Ctrl+T、工具栏 `+`、恢复上次标签、面板里的「预览」走的是同一条路。没有自定义文件时回落 `dist/browser/renderer/newtab.html`。自定义页在标签状态里仍算 `internal`：`browser_page` 不把它当可操作页面，页面脚本不注入，DNR 与导航护栏按内部页处理。
- **与内置页同权**：`isBrowserAssetUrl()`（`desktop/browser-policy.ts`）多收一个由宿主拼出来的路径（`custom/newtab.html`），因此自定义页能拿到 `piBrowserShell` 桥（`settings.get` / `bookmarks.list` / `tabs.create` / `navigate` …）。这是有意的取舍：它终究是本地文件，且只有这样 AI 设计的页面才能有真能用的搜索框和书签胶囊。代价是**写进这份 HTML 的内容等于拿到本地文件与凭据桥的能力**，所以工具提示词明确禁止把远程脚本或不可信标记塞进去。
- **改完立刻生效**：写/删新标签页 → 所有停在新标签页上的标签重载（内置 ↔ 自定义互相拨）；写/删主题 → 已打开的内部页标签先撤旧 key 再 `insertCSS`，**不整页刷新**（Office / 工作区里的未保存编辑不能因为换配色被刷掉）。外壳与面板不是标签，由 `DesktopBrowserHost.applyChromeTheme()` 在各自 `dom-ready` 与写入后注入。
- **两条入口，一套实现**：设置面板「新标签页 / 主题」（`browser/renderer/panels.ts` 的 `designEditor`：正文框 + 保存 / 预览 / 恢复默认，显示文件绝对路径）与 Agent 工具 `browser_design`（`server/browser-design-tool.ts`）都只说 `design.status|get|save|reset`，落到 `desktop/browser-host.ts` 的 `call()` 与 `BrowserManager` 同一组方法上。
- **预览必须有可见页面**：Electron 对隐藏 / 未挂载的 `WebContentsView` 调 `capturePage()` 会返回空图或挂住（实测），所以 `design.preview` 会开或激活一块新标签页、必要时把窗口切到 browser 模式，再截图（≤1280px、JPEG）；抓不到就如实报「需要可见页面」，不做假成功。
- **自动化线上不加新字段**：工具仍走既有 `page_request`，`op` 为 `design.status|get|save|reset|preview`（`browser/automation/design.ts` 的 `BrowserDesignHost`），在 `createBrowserExecutor` 里先于「选目标标签」分支处理——浏览器只剩内部页时也照常可用。
- **写坏了怎么退**：主题是一份任意 CSS，理论上能把外壳藏没。恢复路径只有一条且必须真实可用——删掉 `userData/browser/custom/theme.css`（或 `newtab.html`）后重启，或让 Agent 跑 `design.reset`；设置面板里也直接显示这两个文件的绝对路径，方便外部编辑器处理。
- 回归：`tests/unit/browser-customize.test.ts`（存储 / 大小 / 原子写 / URL 识别）、`browser-design-tool.test.ts`（工具契约、kind 与 `browser/contracts.ts` 同构、`get` 截断）、`browser-design-ops.test.ts`（executor 分支）。

## 构建与验证

`npm run build:desktop` 编译 desktop/browser TypeScript，再由 `scripts/build-browser.mjs` 独立构建浏览器页面到 dist/browser/renderer。现有 Agent Vite 入口不变。Electron 打包包含 dist/desktop、dist/browser、dist/server 和 web/dist。

相关单测：browser-runtime、browser-storage、browser-credentials、browser-automation、browser-desktop、browser-crx，以及 browser-control、plugin-host、browser-page-tool、desktop-startup 的既有测试。页面脚本的匹配/注入/去重/落盘回归在 `tests/unit/browser-scripts.test.ts`。桌面冒烟见 `tests/browser-desktop-smoke.mjs`，使用独立临时数据和测试服务，不触碰用户实例。
