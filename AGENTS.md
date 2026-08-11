# AGENTS.md — pi-web-ui 项目指南

> 本文件是给 AI 编码助手（pi / Claude Code / Cursor 等）看的项目说明书：
> 结构、架构约定、开发流程、GitHub 上传与 npm 发布流程。
> 修改本文件后，在 pi 中运行 `/reload` 生效。

## 1. 项目是什么

pi-web-ui 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：
浏览器里对话、查看文件树、附加文件、内置终端（xterm.js + node-pty）、模型管理、
声音提醒、中英文切换。一条命令可跑（`pi-web-ui`），可 Docker / systemd / launchd /
Windows 计划任务部署。

- 仓库（公开）：`git@github.com:xing-shuyin/pi-web-ui.git`
- npm 包：`pi-web-ui`（发布者 npm 账号 `xingshuyin`）
- Node 要求：**>= 22.19.0**（pi SDK 的 dist 使用了 `import … with { type: "json" }` 语法）
- 版本：`package.json` 与 `package-lock.json` 两处同步维护

## 2. 技术栈

| 层 | 技术 |
| --- | --- |
| 后端 | Node + Express（静态 + `/api/health`）+ `ws`（`/ws` WebSocket 协议） |
| 前端 | React 18 + Vite 6 + react-markdown + highlight.js + xterm.js |
| 智能体 | `@earendil-works/pi-coding-agent` SDK（进程内，读 `~/.pi/agent` 配置） |
| 终端 | node-pty（服务端 PTY）+ `@xterm/xterm`（浏览器渲染，经 terminal bridge 转发） |
| 样式 | 单文件 `web/src/styles.css`（CSS 变量主题，深色） |

## 3. 目录结构

```
pi-web-ui/
├── server/                     # 后端（Node ESM，编译到 dist/server/）
│   ├── index.ts                # 入口：express 静态 + /ws 端点、消息分发、心跳、优雅停机
│   ├── protocol.ts             # ★ 唯一事实源：wire 协议类型（client↔server 消息）
│   ├── agent-service.ts        # 核心：ClientSession（每客户端一个会话组，可并行多个对话）+ AgentService
│   │                           #   · 多对话并发：convs Map<convId, Conversation>，每个对话独立
│   │                           #     AgentSessionRuntime（new_chat 不再杀旧对话，switch_conversation
│   │                           #     只换 activeId；模型共享一个 ModelRuntime；消息序列化缓存按对话隔离；
│   │                           #     set_cwd 切到目标项目自己的对话，不重建；「运行的对话」列表按项目、
│   │                           #     运行中被挤到后台才入列，打开后不继续再切走才移出）
│   │                           #   · WebUIContext：把扩展的 widget/status/dialog 桥接到浏览器
│   │                           #   · 附件构建（inline/reference/lines 三种模式）
│   │                           #   · readFile 预览（512KB 上限、二进制检测、路径越界拦截）
│   │                           #   · 文件列表按平台拆分（readDirForUI）：win32 稳定+全量优先——ACL
│   │                           #     保护目录降级为空列表+警告（不炸面板）、目录符号链接/junction 跟随、
│   │                           #     上限 2000 并上报 truncated；posix（mac/linux）保持原逻辑（上限 500）。
│   │                           #     IGNORED_ENTRIES 也分平台：win 只藏 node_modules/.git/.pi-web/垃圾文件，
│   │                           #     dist/.next/venv 等全部可见
│   │                           #   · 模型管理 / auth.json / models.json / 会话列表 / cwd 切换
│   │                           #   · 每客户端持久化 lastCwd + 最近项目（<dataDir>/client-state.json，
│   │                           #     重启后恢复上次工作目录；projects 消息推送最近项目列表）
│   │                           #   · 编辑重问（edit_message）：按消息 id 解析 entryId → runtime.fork
│   │                           #     新建分支会话（保留该问题之前的历史，原对话不动）→ 重新 prompt
│   │                           #   · 自更新（check_update/update_app）：读自身 package.json 版本，
│   │                           #     对比 npm registry，npm i -g 升级后自动重启（launchd KeepAlive /
│   │                           #     systemd Restart 退出即拉起；前台派生子进程等旧进程释放端口后接管；
│   │                           #     Docker 容器内提示外部重启）
│   ├── serialize.ts            # SDK 消息 → UiMessage 序列化（截断、稳定 id、对象缓存）
│   └── terminals.ts            # TerminalManager（PTY 生命周期）+ .pi/commands.json 读写
├── web/                        # 前端（React + Vite，编译到 web/dist/）
│   ├── vite.config.ts          # dev 端口 5173，/ws 代理到后端
│   ├── src/
│   │   ├── App.tsx             # 顶层布局：TopBar / LeftPanel / MessageList / ChatInput /
│   │   │                       #   RightPanel / FooterBar / Dialog / 各 Modal / FilePreview
│   │   ├── use-chat.ts         # ★ useChat()：WebSocket 连接管理、reducer 状态机、
│   │   │                       #   终端输出 bridge（未挂载终端的输出先缓冲）
│   │   ├── types.ts            # ★ wire 协议镜像（与 server/protocol.ts 手工同步，仅类型）
│   │   ├── i18n.tsx            # ★ 中英文案（zh 默认），新增 key 必须两处都加
│   │   ├── styles.css          # ★ 全部样式（按组件分区，带注释分隔线）
│   │   ├── sounds.ts           # WebAudio 提示音
│   │   ├── download.ts         # 下载：downloadFile（fetch→blob→objectURL，绕开 Chrome
│   │   │                       #   Safe Browsing 对 HTTP 下载的拦截，错误可读；Chromium 安全上下文
│   │   │                       #   下优先 showSaveFilePicker（Windows 下 blob 下载仍会被静默拦截时
│   │   │                       #   的解法），Windows 自动清洗非法保存名）
│   │   └── components/         # 见下
│   └── dist/                   # 构建产物（gitignore，但打进 npm 包）
├── bin/pi-web-ui.mjs           # CLI：前台启动（就绪后自动打开浏览器，--no-browser 关闭）/ --port --cwd --data-dir / server install|uninstall|start|stop|restart|status
│                               #   （macOS→launchd，Linux→systemd，Windows→schtasks 计划任务、隐藏窗口）
├── deploy/                     # 部署示例：launchd plist / systemd unit / Windows 任务 XML
├── Dockerfile / docker-compose.yml
├── freeze-test.mjs 等           # 仓库根的手写 Playwright E2E 脚本（chromium headless）
└── tsconfig.server.json / web/tsconfig.json
```

`web/src/components/` 速览：

| 组件 | 职责 |
| --- | --- |
| `FilePreview.tsx` | 文件预览弹窗：行号、点选/拖拽/Shift 选区、添加到对话（lines 附件） |
| `LeftPanel.tsx` | 左栏：最近项目（点击切换 cwd）+ 运行的对话（≥1 个时显示，活跃高亮、流式绿点，按当前项目过滤；固定在历史列表上方独立滚动）+ 历史对话（标题不随列表滚动） |
| `RightPanel.tsx` | 文件树浏览（list_files，目录过大时显示截断提示），文件名点击→预览，📎/🔗/👁 附件按钮；服务端对**当前列出目录**做 fs.watch，改动推 `file_changed`（新协议消息）→ 立即静默重列，失败/不支持的文件系统回落 10s 轮询 |
| `ChatInput.tsx` | 输入框 + 附件 chips（inline/reference/lines 三色）；回复中显示「补充」按钮（streaming 期间的消息以 **steer** 排队 —— 当前回合工具结算后立即注入、跳过剩余工具、agent 马上响应；即 pi CLI Enter 打断语义）+「停止」；**斜杠命令**：输入 `/` 弹出命令选择器（内置/扩展/模板/技能四类标签，↑↓ + Enter/Tab 补全，Esc 关闭），`/help` 打开命令清单弹窗、`/copy` 复制上一条助手回复（纯客户端）；内置命令（/new /model /compact /cwd /thinking /resume）由服务端 `AgentService.prompt()` 拦截执行，扩展/技能/模板命令透传给 SDK prompt（SDK 原生展开），未知 `/xxx` 作为普通文本发送 |
| `Message.tsx` / `MessageList.tsx` | 消息渲染：附件卡片（`stripFileWrapper` 剥 `<file>` 包装）、流式光标、tool 结果关联；超过 30 条后旧消息折叠为摘要行（`CollapsedMessage`，惰性渲染，点击展开，常量 `KEEP_RECENT`/`COLLAPSE_MIN` 在 MessageList 顶部）；**问题导航双通道**：右侧浮动 `.qn-rail`（hover 浮出问题文本 chip，问题多时 `.many` 变体换成可滚动 `.qn-list` 面板，移出立即隐藏无延迟）+ 每个问题消息头部右端的常驻 `.qn-tag`（横条+序号，点击跳转，当前屏幕问题高亮） |
| `ToolCallBlock.tsx` / `ThinkingBlock.tsx` / `BashBlock` | 工具调用卡片、思考块、bash 输出 |
| `TerminalPanel.tsx` / `TermXterm.tsx` | 终端视图 + xterm 实例桥接 |
| `TopBar.tsx` / `FooterBar.tsx` | 顶栏（模型/思考强度/声音/新对话/视图切换）、底栏（上下文/成本/工作目录） |
| `Dialog.tsx` | 扩展 `ui.select/confirm/input` → 浏览器弹窗 |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx` | models.json 管理 / 首次配置引导 |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `SoundSettings.tsx` | 通用件 |

## 4. 核心架构（改代码前必读）

### 快照驱动

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推全量 `snapshot`（`UiState`），
  浏览器只按快照渲染。重连只需重发 `get_state`。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息数组签名比对，消息没变就不重建数组，
  前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，
  SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点“低/中”看起来“改不了”）。

### 协议双端手工同步

`server/protocol.ts`（事实源）和 `web/src/types.ts`（镜像）**没有共享代码，必须手工同步**。
新增/修改任何消息：先改 `protocol.ts`，再把同样的类型镜像到 `types.ts`，最后在
`server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch
各加一个分支。

### 附件三种模式（`ClientMessage.prompt.attachments[].mode`）

| mode | 含义 | 服务端处理 |
| --- | --- | --- |
| `inline` | 内联全文 | ≤ `PI_WEB_INLINE_FILE_MAX`（默认 12KB）内联，超出自动降级为 reference |
| `reference` | 仅路径 | 发 `<file path="..." size="..."/>`，模型按需用 read 工具读 |
| `lines` | 选中行 | 发 `<file path="..." lines="2-3">```选中行```</file>`，只读该范围（读取上限 2MB，超限降级 reference） |

**图片问答（无工作区路径）**：粘贴（Ctrl+V）/ 拖入输入框 / 🖼 上传的图片带
`attachments[].imageData`（base64）+ `mimeType` + `name` 发送——服务端直接作为 image content
附加，不走文件路径（`path` 忽略）。浏览器端（`web/src/image-paste.ts`）先把图片等比缩到
≤1568px、按需转 PNG/JPEG，保证 payload 在服务端 2MB 上限内（`MAX_PASTED_IMAGE_BYTES`）。
当前模型不支持识图（`model.vision`）时前端提示警告。

**文件对话（无工作区路径）**：拖入输入框 / 📎 上传的任意文件带 `attachments[].fileData`
（base64）发送——服务端写入全局目录 `~/.pi-web/uploads/<clientId>/`（**不放项目内**，
`MAX_UPLOAD_BYTES` 20MB 上限），小文本（≤ `PI_WEB_INLINE_FILE_MAX` 且嗅探为文本）直接内联，
其余以**绝对路径** reference 附加（read 工具支持绝对路径）。前端分流（`isRasterImage`）：
**只有栅格图片**（png/jpeg/gif/webp/bmp/avif…）走 imageData 管线；**SVG 等矢量格式排除**——
createImageBitmap 解码 SVG 会失败，SVG 作为普通文件附加让模型读源码更有用，其余文件走 fileData。

附件作为独立 custom message（`sendCustomMessage` + `deliverAs: "nextTurn"` asides）发送，
渲染成可折叠卡片。客户端 `stripFileWrapper` 的正则要兼容 `lines="..."` 属性。
**消息序列化缓存按 `role:timestamp` 为 key——同一 prompt 的多个 aside 同毫秒创建会碰撞，
必须靠内容指纹（`contentFingerprint`）区分，否则只有第一个渲染（已修，勿回退）。**

### 文件预览协议

- 客户端发 `{ type: "read_file", path }` → 服务端回 `{ type: "file_content", path, name, text, truncated, binary, lines, size }`。
- 只读文件前 **512KB**（`MAX_PREVIEW_BYTES`）；**内容嗅探决定文本还是二进制**：
  无 NUL、控制字符占比 < 2% 即按文本预览（`looksLikeText`）——未知/无扩展名文件
  （jsonl、.log.1 等）也能打开；二进制返回 `binary: true`，`text` 为前 4KB 的
  **十六进制视图**（`hexDump`，前端 `.fp-hex` 渲染，可下载完整文件）。
  路径经 `resolve + relative` 校验，`..` 越界直接拒。
- **媒体预览走 HTTP**：image/video 经 `/api/file?clientId=…&path=…` 流式返回（`sendFile` 支持 Range），
  路径按**该客户端的会话 cwd**（打开的项目）解析，而非服务启动目录——两者可能不一致；
  `clientId` 缺失或会话不存在时回退到服务启动 `CWD`。路径校验统一走 `workspacePath()`（agent-service 导出）。
- 行号语义：**尾随换行不产生空行**（`countLines` 已修正），前后端 split 逻辑必须一致。
- **下载按钮**（`web/src/download.ts`）：不用 `<a download href>`（Chrome Safe Browsing
  会拦截非 HTTPS 源的无信誉文件类型如 .zip/.exe，报「无法下载/联系你的组织」），而是
  fetch → blob 保存；>200MB 回退原生导航流式下载；失败 toast 显示服务端
  错误正文（`downloadFailed` i18n key）。**Windows 特例**：blob 锚点下载在 Windows 上仍可能被
  Safe Browsing 静默拦截（无 JS 错误，表现为「点了没反应」）——Chromium 安全上下文
  （localhost/HTTPS）下优先用 `showSaveFilePicker` 直接写入用户选中的文件（绕过下载管线）；
  Windows 上保存名经 `sanitizeFileName` 清洗（`<>:"\|?*`、尾随点/空格、CON/COM1 等保留
  设备名）；取消保存对话框不算错误（`cancelled`，不弹 toast）。`download-test.mjs` 覆盖回归
  （已禁用 picker 以测 blob 路径）。

### 终端

- 每客户端一个 `TerminalManager`；输出经 `terminal_output` 推给浏览器，
  未挂载终端先缓冲（200KB 上限），挂载时冲刷。socket 断开 → 服务端杀掉全部 PTY。
- macOS 下若服务由 launchd 拉起（`process.ppid === 1`，LaunchAgent/孤儿进程），TCC 会把
  相机/麦克风权限归因到 node 本身（无 App Bundle、无 Info.plist）而静默拒绝——ffmpeg 取流会
  卡死在取帧。`terminals.ts` 检测该场景，在客户端首次创建终端时输出提示（改 url/文件源，
  或在自己已授权的终端里前台运行）。

### 其他桥接

- **工具结束实时状态（`tool_status`）**：服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，
  注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时
  立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——
  浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。
  bash 工具的 details 不带 exitCode（成功时返回 truncation 信息，失败时错误文本含 `Command exited with code N`），
  服务端从错误文本正则提取；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。
  前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。
### 多对话并发（每项目「运行的对话」）

- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：
  `new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；
  `switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。
  **对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；
  没有则新建一个并恢复该项目最近的持久会话）。离开项目的对话原地保留、后台继续跑，
  标题/cwd 永远不会串项目（旧版「切项目后高亮对话名字还是上个项目」的根因就是重建）。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd）→ `listed=true`；
  - 留在列表：后台跑完不移出（用户可能还没看结果）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，
    `removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。从未入列的空对话在切走时同样释放。
- 上限 `MAX_OPEN_CONVERSATIONS = 8` **按项目计**，超出时 new_chat 发 warning notice。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——
  顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：
  两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）只推**当前项目已入列**的对话 + `activeId`
  （activeId 可能未入列，如刚 new_chat 还没跑过）；`switch_conversation`（ClientMessage）只在同项目内切换。
- 行为不变的部分：`switch_session`（恢复持久会话）替换**当前**对话的 runtime（成功后视作已继续）；
  `edit_message` 在**当前**对话内 fork；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮、流式绿点），MessageList 以 conversationId 为 key 强制切换重挂载。

- 扩展的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 消息；
  对话框经 `dialog_response` 回传，Esc 视为取消。
- `snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。

## 5. 开发工作流

```bash
npm run dev          # 并行：node --watch --import tsx 后端(:8787，dev:server 脚本) + vite 前端(:5173，代理 /ws)。
#                     注意：不要用 `tsx watch` 起后端——它在 Windows 下、stdio 为管道（concurrently 的 spawn 方式）时会静默挂死（tsx 上游 bug），改用 Node 原生 --watch。
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run build        # build:web (vite) + build:server (tsc)
npm start            # 跑编译产物 dist/server/index.js（生产）
npm run test:freeze  # 冻结/重连回归测试（Playwright，需要 chromium headless）
```

### 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **i18n**：所有用户可见字符串走 `useT()`；改 `i18n.tsx` 必须同时加 `zh` 和 `en` 两个 key
  （`en` 的类型是 `Record<keyof typeof zh, string>`，漏一个会编译报错，这是特性不是 bug）。
- **通知文案**：服务端 notice 直接写中文，不需要 i18n。
- **样式**：全部在 `styles.css`，按 `/* ---- 组件名 ---- */` 分区；颜色用 CSS 变量
  （`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--amber`、`--green`、`--red`）。
- 文件列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `agent-service.ts` 顶部维护。
- 新增协议消息 → 见第 4 节「协议双端手工同步」。
- **斜杠命令目录**：服务端 `pushSlashCommands()` 收集当前活动会话的扩展命令
  （`session.extensionRunner.getRegisteredCommands()`）+ 模板（`promptTemplates`）+
  技能（`resourceLoader.getSkills()` → `skill:<name>`）加上 9 个内置命令，经
  `slash_commands` 消息推送（attach / set_cwd / new_chat / switch_conversation /
  switch_session / get_commands 时刷新）；内置命令在 `prompt()` 里拦截
  （`execNativeCommand`，含 /model 模糊匹配、/thinking 中英别名、`/reload` 调
  `session.reload()` 重新发现扩展/技能/模板后重推目录），其余透传 SDK（SDK 会
  展开扩展/技能/模板命令）。注意 SDK 的 `getSkills()` 返回的是会话创建时的内存
  快照——删除/新增 skill 文件后必须 `/reload`（或 /new / 切项目重建 runtime）才
  生效。改动时保持 `NATIVE_COMMANDS` 与 `execNativeCommand()` 同步。回归：
  `slash-commands-test.mjs`。

### 验证清单（改完自检）

1. `npm run typecheck` 零错误
2. 涉及 UI → `npm run dev` 手动过一遍交互
3. 涉及 ws 协议 → 仓库根有现成 Playwright 脚本可参照（`*-test.mjs`）：
   `terminal-smoke-test.mjs` / `freeze-test.mjs` 等，改 PORT 后用
   `node xxx-test.mjs` 跑（需要 `/Users/c/Library/Caches/ms-playwright/.../chrome-headless-shell`）

## 6. 发布流程（GitHub + npm）

> npm 发布者账号是 `xingshuyin`（`npm whoami` 验证）。`dist/`、`web/dist/` 被
> gitignore 不进 git，但 `package.json` 的 `files` 白名单会把它们打进 npm 包；
> `prepublishOnly` 会在发布前自动 `npm run build`。

### 步骤

```bash
# 1) 升版本（patch/minor 视改动；npm 上已存在该版本会 404 拒绝）
#    两处都要改，保持一致：
#      package.json 的 "version" 和 package-lock.json 的 "version"（第 3 行 + packages[""]）

# 2) 自检 + 构建
npm run typecheck
npm run build

# 3) 提交（Conventional Commits：feat/fix/perf/chore(scope): 描述，说明 why）
git add -A
git commit -m "feat(files): <一句话描述>"

# 4) 推送 GitHub（仓库公开：xing-shuyin/pi-web-ui，分支 main）
git push origin main

# 5) 发布 npm（会自动跑 prepublishOnly 构建）
npm publish

# 6) 验证
npm view pi-web-ui version        # 应显示新版本（registry 有缓存延迟属正常）
curl -s https://registry.npmjs.org/pi-web-ui/latest | jq .version
```

### 注意事项

- 版本号**必须**高于 npm registry 上已有的（当前 `0.2.x`）。
- 提交信息不要带 `Co-authored-by`（P1 规则，仓库 hook 会拦）。
- `.pi/commands.json` 是**每个项目各自**的个人命令（当前 cwd 的 `.pi/ 下），已被 gitignore，永远不会进公开仓库；
  切换 cwd 时命令列表自动刷新为该项目的命令。
- 大改动发布前先问用户是否要 `npm publish`（会真实消耗账号权限、触发构建）。
- **升级后自动重启**：`npm i -g` 只更新磁盘文件，已运行进程内存里还是旧代码——前端是每次
  请求实时读盘的（会先变新），但 WS 消息处理是进程内旧逻辑，新旧混跑会表现为「界面是新的、
  某功能一直加载中」。因此界面内「立即更新」成功后会自动重启（launchd KeepAlive / systemd
  Restart 退出即拉起，前台派生子进程接管；Docker 容器内需 `docker compose restart`），
  无需手动操作。

## 7. 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `PORT` | `8787` | HTTP 端口 |
| `PI_WEB_CWD` | `process.cwd()` | 智能体工作区（读/写/终端都以此为根） |
| `PI_WEB_DATA_DIR` | `~/.pi-web` | 每客户端持久化 UI 状态（client-state.json，最近项目/工作目录）；对话会话放 SDK 默认目录 `<agentDir>/sessions/--<cwd>--/`（与 pi CLI/TUI 共享同一对话列表） |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB) | inline 附件的内联阈值，超过自动降级为路径引用 |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json / models.json / skills） |

## 8. 部署（速查）

```bash
pi-web-ui --port 9000 --cwd /path          # 前台
pi-web-ui server install [--port --cwd --data-dir --name]   # 开机自启：
                                           #   macOS→launchd（无需 sudo）
                                           #   Linux→systemd（自动 sudo）
                                           #   Windows→计划任务（登录自启，隐藏窗口无黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一键启动」图标（启动服务并打开浏览器）：
                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服务未运行则在本
                                           #     隐藏窗口前台启动并记录 PID，server stop/uninstall 可止停）
                                           #   macOS→桌面 .command 双击启动器（已装 launchd 则 kickstart，否则终端前台）
                                           #   Linux→桌面 .desktop 图标 + ~/.local/share/pi-web-ui 启动脚本（systemctl 优先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（端口映射 + 挂载数据目录）
```
> uninstall 会自动移除桌面图标；未装服务时桌面快捷方式启动的实例在 status/stop 中单独报告（PS1 前台+记录 PID）。

## 9. 常见坑

- **改了 `protocol.ts` / `types.ts` 后两端不同步** → 前端收到未知消息类型被 switch 静默丢弃，表现为"没反应"。先跑 `npm run typecheck`。
- **快照 60ms 节流**：调试时 `get_state` 可立即推一次（`cs.flushSnapshot()`）。
- **`hello` 前/会话未就绪时的命令**：`server/index.ts` 的 `pending` 队列会缓存并在 attach 后重放。
- **socket 半开**：服务端 10s 心跳，客户端 30s 无消息主动断开重连（指数退避 1s→10s）。
- **预览与附件行号**：`countLines` 不算尾随换行；前端 `split("\n")` 后也要 pop 掉末尾空串。
- **Playwright 脚本**：headless shell 路径写死在本机，CI/换机需要改 `HEADLESS` 常量。

---
*结构/流程变更时同步更新本文件（含新增组件、协议消息、发布步骤）。*
