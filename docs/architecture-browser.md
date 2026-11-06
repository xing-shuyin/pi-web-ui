# 内置浏览器与桌面 Agent

桌面应用将浏览器与现有 pi-web-ui Agent 组合在一个窗口，支持 browser、agent、split 三种模式。浏览器先显示，本地 Agent sidecar 并行启动；Agent 失败时仍可浏览网页。npm/纯 Web 服务入口继续使用现有路径。

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

BrowserWindow 的 webContents 加载本地 shell.html，标签与专用 Agent 使用 WebContentsView。浏览器外壳高 88px，内容区在其下方。

browser 显示当前网站，agent 显示 Agent，split 左 Agent 右网站。切换模式复用同一个视图并更新可见性、边界和焦点，不重载页面。隐藏页保留有效尺寸，不缩成 1×1。标签关闭时关闭对应 WebContents；应用关闭时清理标签、下载、Agent 和挂起通道。

原生视图不能被普通 DOM 的 z-index 覆盖。外壳打开设置等浮层时通过 overlay 通知宿主临时隐藏内容区；内部标签自己的浮层不隐藏其所在视图。Agent 嵌入标记使现有前端省略重复窗口按钮和桌面拖动装饰。

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
- 本地文件必须由系统选择器授权，读取上限 32 MiB，文本文档可保存；二进制 Office 文档只读预览，禁止把文本写回原二进制文件。

浏览器文件与 session 位于 Electron userData/browser；Agent 原有数据目录继续使用原配置。凭据使用 Electron safeStorage，安全加密后端不可用时拒绝保存。保险箱可由用户明确选择填写当前网站，主进程与页面内都检查精确 origin，不自动提交表单。旧 AI Browser 数据可由用户选择旧目录导入，存在的目标文件不会覆盖；导入错误单列报告。

## 构建与验证

`npm run build:desktop` 编译 desktop/browser TypeScript，再由 `scripts/build-browser.mjs` 独立构建浏览器页面到 dist/browser/renderer。现有 Agent Vite 入口不变。Electron 打包包含 dist/desktop、dist/browser、dist/server 和 web/dist。

相关单测：browser-runtime、browser-storage、browser-credentials、browser-automation、browser-desktop，以及 browser-control、plugin-host、browser-page-tool、desktop-startup 的既有测试。桌面冒烟见 `tests/browser-desktop-smoke.mjs`，使用独立临时数据和测试服务，不触碰用户实例。
