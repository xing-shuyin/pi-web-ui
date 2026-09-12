# AGENTS.md — pi-web-ui 项目指南

> 本文件是给 AI 编码助手（pi / Claude Code / Cursor 等）看的高层项目说明书。
> 详细文档按主题分拆在 `docs/` 目录下。
> 修改本文件后，在 pi 中运行 `/reload` 生效。

## 1. 项目是什么

pi-web-ui 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：
浏览器里对话、查看文件树、附加文件、内置终端（xterm.js + node-pty）、模型管理、
声音提醒、中英文切换。一条命令可跑（`pi-web-ui`），可 Docker / systemd / launchd /
Windows 计划任务部署。
另有 **Electron 桌面壳**（`desktop/`）：随机空闲口起同一个 server + BrowserWindow，网页版零改动；
Windows 安装包随 GitHub Release 发布（CI 出包，当前未签名，见 `desktop/README.md`）。

- 仓库（公开）：`git@github.com:xing-shuyin/pi-web-ui.git`
- npm 包：`pi-web-ui`（发布者 npm 账号 `xingshuyin`）
- Node 要求：**>= 22.19.0**（pi SDK 的 dist 使用了 `import … with { type: "json" }` 语法）
- 版本：`package.json` 与 `package-lock.json` 两处同步维护

## 2. 技术栈

| 层     | 技术                                                                          |
| ------ | ----------------------------------------------------------------------------- |
| 后端   | Node + Express（静态 + `/api/health`）+ `ws`（`/ws` WebSocket 协议）          |
| 前端   | React 18 + Vite 6 + react-markdown + highlight.js + xterm.js                  |
| 智能体 | `@earendil-works/pi-coding-agent` SDK（进程内，读 `~/.pi/agent` 配置）        |
| 终端   | node-pty（服务端 PTY）+ `@xterm/xterm`（浏览器渲染，经 terminal bridge 转发） |
| 样式   | 单文件 `web/src/styles.css`（CSS 变量主题，深色）                             |

## 3. 目录结构

```
pi-web-ui/
├── server/                     # 后端（Node ESM，编译到 dist/server/）
│   ├── index.ts                # 入口：express 静态 + /ws 端点、消息分发、心跳、优雅停机
│   ├── protocol.ts             # ★ 唯一事实源：wire 协议类型（client↔server 消息）
│   ├── agent-service.ts        # 核心：ClientSession（每客户端一个会话组，可并行多个对话）+ AgentService
│   ├── serialize.ts            # SDK 消息 → UiMessage 序列化
│   ├── text-sniff.ts           # 文件预览纯函数（previewKind/looksLikeText/decodeText/sniffImageMime/hexDump/countLines）
│   ├── queue-utils.ts          # 排队消息纯函数（removeFirstOccurrence：只移除第一条匹配，重复文本不连带删除）
│   ├── process-utils.ts        # 进程工具：snapshotListeningPorts/killPidTree/lookupProcessName
│   ├── client-state.ts         # ClientStateStore：<dataDir>/client-state.json 持久化
│   ├── uploads.ts              # 文件对话上传 + 保留期清理
│   ├── bg-servers.ts           # 后台任务跟踪（bash 前后端口快照 diff + 存活刷新）
│   ├── settings-service.ts     # 设置面板状态机
│   ├── goal-service.ts         # 目标/审查循环/调研向导
│   ├── i18n.ts                 # 服务端语言协商 + 翻译表注册（resolveServerLang/pick/bilingual/getServerBlock；v2 见下）
│   ├── tool-manager.ts         # ★ Agent 工具统一开关：TOOL_CATALOG（终端 7＋子代理 7＋其他 4）＋ tool_manage 出入口（setAgentToolEnabled/applyAgentToolsGating），持久化只有 disabledAgentTools，遗留三开关双向同步
│   ├── edit-soft-tool.ts       # 独立宽松编辑工具 edit_soft（行核心匹配，忽略缩进差异；开关走统一工具 tab）
│   ├── subagents.ts            # 第一方子代理：subagent_* 工具（spawn/get_result/steer/list/stop/templates）+ 运行态快照
│   ├── subagent-templates.ts   # 子代理模板库（全局 <dataDir>/subagent-templates.json；白名单语义；enabled=false 对 AI 不可见）
│   ├── slash-commands.ts       # 斜杠命令（NATIVE_COMMANDS 内置命令拦截执行 + 目录推送）
│   ├── model-admin.ts          # 模型/服务商配置管理（含内置服务商多密钥：provider-keys.json + add/activate/remove_provider_key，模型目录复用系统默认，不复制）
│   ├── attachments.ts          # 附件构建（inline/reference/lines/imageData/fileData + 视觉桥）
│   ├── webui-context.ts        # 扩展 UI 桥（WebUIContext：widgets/statuses/dialog → 浏览器）
│   ├── themes.ts               # 主题管理（listThemes/resolveThemeFile）
│   ├── plugins.ts              # 可选界面组件插件（扫描 <dataDir>/plugins/<id>/；renderer 插件字段 view:false + renderers）
│   ├── plugin-catalog.ts       # 插件市场列表（builtin plugins/catalog.json + 用户自定义 <dataDir>/plugin-catalog.json）
│   ├── vision-bridge.ts        # 视觉桥：纯文本主模型看图转写
│   ├── files-service.ts        # 文件服务（readDirForUI/readFile/searchFiles/watcher）
│   ├── scm.ts                  # SCM 只读 git 查询（execFile git status/branches/history/filediff/commit）
│   ├── patch-node-pty.ts       # node-pty × Node --watch 兼容自愈补丁
│   ├── patch-remote-catalog.ts # pi.dev 模型目录整表替换补丁（幂等改写 SDK remote-catalog-provider：刷新后内置服务商列表=官方目录整表，不保留内置旧模型/不报“新增 N 个”）
│   ├── ensure-bash.ts          # Windows 轻量 bash 兜底（busybox-w32）
│   ├── control-socket.ts       # 本地控制 socket（status / quiesce / unquiesce）
│   ├── launch-origin.ts        # ★ 启动来源探测：本实例是否被 launchd/systemd/Windows watchdog 托管（更新面板「重启服务」的前置条件）
│   └── terminals.ts            # TerminalManager（PTY 管理 + 增量输出/按键工具）
├── web/                        # 前端（React + Vite，编译到 web/dist/）
│   ├── vite.config.ts          # dev 端口 5173，/ws 代理到后端
│   ├── src/
│   │   ├── App.tsx             # 顶层布局
│   │   ├── use-chat.ts         # ★ useChat()：WebSocket 连接管理、reducer 状态机、终端 bridge
│   │   ├── app-globals.ts      # ★ 全局运行态 store（engine/managed/tabs/版本号 + 全局发送器 appSend）
│   │   ├── types.ts            # ★ wire 协议 re-export shim（`export type * from "../../server/protocol"`）
│   │   ├── i18n.tsx            # ★ 多语文案（zh/en/it，zh 默认），新增 key 必须三处都加
│   │   ├── styles.css          # ★ 全部样式（按组件分区，带注释分隔线）；也是默认深色主题本体
│   │   ├── theme.ts            # 主题切换（/api/themes 列表 + localStorage 持久化 + applyTheme）
│   │   ├── sounds.ts           # WebAudio 提示音
│   │   ├── notify.ts           # 桌面/OS 通知（PWA）：是否吞掉通知的判定（Windows 最小化检测）+ 诊断",
│   │   ├── download.ts         # 下载（fetch→blob，绕开 Chrome Safe Browsing）
│   │   ├── composer-bridge.ts  # ★ 输入框注入桥：宿主（扩展/插件）把内容塞进输入框草稿的模块级 sink 注册点，有单测（配 composer-draft.ts 的合并/去重纯函数）
│   │   ├── caret-visual-line.ts # ★ 输入框光标的首/末**视觉行**判定（镜像 div 量 offsetTop，自动折行算行；无布局时回落逻辑行），供 ↑/↓ 翻输入历史用，有单测 + 真浏览器回归（tests/composer-history-test.mjs）
│   │   ├── message-delta.ts    # message_delta 增量 patch 纯函数，有单测
│   │   ├── lazy-window.ts      # 消息列表惰性窗口化纯函数，有单测
│   │   ├── search-text.ts      # 会话内搜索索引纯函数，有单测
│   │   ├── skill-block.ts      # parseSkillBlock：<skill> 块解析，有单测
│   │   ├── tool-args.ts        # 工具卡头参数提示纯函数（路径/超时安全提取，脏参数不抛错），有单测
│   │   ├── auth-token.ts       # PI_WEB_TOKEN 口令注入，有单测
│   │   ├── image-paste.ts      # 粘贴图片等比缩放 ≤1568px + PNG/JPEG 转码
│   │   ├── uuid.ts             # randomUuid（crypto 兜底），有单测
│   │   ├── protocol-version.ts # 协议版本常量
│   │   ├── main.tsx            # 入口：首帧前应用主题防闪烁 + initAuthToken
│   │   └── components/         # 见下
│   └── dist/                   # 构建产物（gitignore，但打进 npm 包）
├── bin/pi-web-ui.mjs           # CLI：前台启动 / server install|uninstall|start|stop|restart|status
├── desktop/                    # Electron 桌面壳（sidecar：随机空闲口起 dist/server + BrowserWindow）
│   ├── main.ts                 # 主进程：ready → 选空闲口 → spawn server(ELECTRON_RUN_AS_NODE) → loadURL
│   ├── electron-builder.yml    # 打包配置（win nsis / mac dmg / linux AppImage；npmRebuild:false）
│   └── README.md               # 桌面版说明：跑起来 / 约定 / 发布 / 签名（SignPath）
├── deploy/                     # 部署示例：launchd plist / systemd unit / Windows 任务 XML
├── themes/                     # 内置主题（纯 :root 调色板覆盖，不含布局）
├── make-light-theme.mjs        # 主题生成器（从 styles.css 的 :root 变量清单生成纯调色板）
├── tests/                      # 全部测试脚本（自包含：独立端口 ≥8900 + 临时 data-dir）
│   ├── run-smoke.mjs           # 零 token 协议冒烟聚合跑器
│   ├── unit/                   # vitest 纯函数单测
│   ├── *-test.mjs              # 手写 Playwright E2E / WS 协议测试
│   └── scratch/                # 一次性调试脚本（gitignore，不入库）
├── scripts/check-protocol-sync.mjs  # 守护 types.ts shim 单源机制 + protocol.ts 纯类型约束
├── .github/workflows/ci.yml    # CI：协议同步 → typecheck → build → vitest → 冒烟
├── .github/workflows/release-notes.yml   # tag 推送 → 按 CHANGELOG 建/更新 GitHub Release
├── .github/workflows/desktop-release.yml  # tag 推送 → windows-latest 出 NSIS 安装包并附到 Release（签名以后加这里）
├── extensions/                 # pi 扩展：webui.ts（/webui 命令启动本机服务并打开浏览器）
├── plugins/                    # 官方插件（webmail / db-client / vscode-editor / demo-mailbox / mermaid / run-trace / legado-web / image-toolkit，各自的 README.md 见其目录；page-picker/extension 是**浏览器扩展**，不是 pi-web-ui 插件）
│   └── catalog.json            # ★ 插件市场内置列表（随包发布；社区加插件 = 在此加一条 + PR）
├── dev/                        # 本地开发辅助（notice/search 预览等，不入 npm 包）
├── Dockerfile / docker-compose.yml
├── docs/                       # 详细文档（本文件的分拆）
│   ├── architecture-core.md    # 核心架构：快照驱动、协议单源、安全边界、主题切换、多对话并发
│   ├── architecture-attachments.md  # 附件、图片、视觉桥、文件上传/预览/下载
│   ├── architecture-terminal.md    # 终端架构：PTY 管理、SCM 查询、活力检测、终端接管 bash
│   ├── architecture-plugins.md     # 插件系统：形态、协议、宿主扩展点、MCP 桥
│   ├── architecture-system-prompt.md  # 系统提示词组成：base/追加段/项目上下文/技能段 组装链路与 override 钩子
│   ├── development.md          # 开发工作流、CI、编码约定、测试规范
│   ├── release.md              # 发布流程（GitHub + npm）
│   ├── deployment.md           # 部署（CLI / Docker）
│   └── env-vars.md             # 环境变量参考
├── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

`web/src/components/` 速览：

| 组件                                                                                      | 职责                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FilePreview.tsx`                                                                         | 文件预览弹窗：行号、点选/拖拽/Shift 选区、添加到对话；Markdown 预览可切换原文；可编辑保存                                                                                                                                                                                                                                                                                               |
| `LeftPanel.tsx`                                                                           | 左栏：最近项目、运行的对话、历史对话（含删除）                                                                                                                                                                                                                                                                                                                                          |
| `RightPanel.tsx`                                                                          | 文件树浏览（list_files），文件名点击→预览，📎/🔗/👁 附件按钮；服务端原生递归 watcher                                                                                                                                                                                                                                                                                                     |
| `ChatInput.tsx`                                                                           | 输入框 + 附件 chips（inline/reference/lines 三色）；全窗口拖放目标；followUp 排队/steer 插队；斜杠命令选择器                                                                                                                                                                                                                                                                            |
| `Message.tsx` / `MessageList.tsx`                                                         | 消息渲染（附件卡片、流式光标、tool 结果关联）；编辑重问保留原附件；技能卡片折叠；惰性窗口化；问题导航双通道；流式 StreamMarkdown                                                                                                                                                                                                                                                        |
| `ToolCallBlock.tsx` / `ThinkingBlock.tsx` / `BashBlock`                                   | 工具调用卡片（卡头状态图标右侧显示关键参数提示：文件路径 `.toolcall-path` / 超时 `.toolcall-timeout`，任何工具都试取，脏参数静默不显示）、思考块、bash 输出                                                                                                                                                                                                                             |
| `TerminalPanel.tsx` / `TermXterm.tsx`                                                     | 终端视图 + xterm 实例桥接                                                                                                                                                                                                                                                                                                                                                               |
| `SCMPanel.tsx`                                                                            | 源代码管理（Git）视图：status/branch/diff；提交/推送/拉取/切换分支                                                                                                                                                                                                                                                                                                                      |
| `TopBar.tsx` / `FooterBar.tsx`                                                            | 顶栏（模型/思考强度/后台任务/声音/新对话/视图切换）、底栏（上下文/成本/工作目录）                                                                                                                                                                                                                                                                                                       |
| `Dialog.tsx`                                                                              | 扩展 `ui.select/confirm/input` → 浏览器弹窗（正文/选项走 `Markdown(rawHtml)` 富渲染）                                                                                                                                                                                                                                                                                                   |
| `DshQuestionDialog.tsx`                                                                   | 模型提问对话框（`question_pending`，DSH 引擎经 goal-rpc userQuestions、标准 pi 引擎经 pi-web-ui 注册的 `ask_user_question` customTool 共用）：单选/多选/自定义文本 + 选中带 `preview` 的选项时「选项预览」富文本；question/detail/description/preview 走 `Markdown(rawHtml)`。待答问卷同时挂在快照（`UiState.pendingQuestion`）上，刷新/重连后由 `web/src/pending-question.ts` 恢复面板 |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx`                                               | models.json 管理 / 首次配置引导                                                                                                                                                                                                                                                                                                                                                         |
| `SettingsModal.tsx`                                                                       | 设置面板（侧边栏分页：提示词/工具（含终端＋标记管理）/消息显示/技能/插件/界面插件/目标审查/视觉桥/预设/子代理模板；DSH 另有问卷页、无工具页）                                                                                                                                                                                                                                           |
| `GoalBar.tsx`                                                                             | 输入框上方目标条：设目标/清除/AI 提炼/轮数下拉                                                                                                                                                                                                                                                                                                                                          |
| `BgTasksModal.tsx`                                                                        | 后台任务弹窗：AI 启动的监听端口进程列表                                                                                                                                                                                                                                                                                                                                                 |
| `ModelThinking.tsx`                                                                       | 模型 + 思考强度下拉（模型下拉左侧按服务商筛选 + 顶部搜索过滤框）                                                                                                                                                                                                                                                                                                                        |
| `GlobalSearchModal.tsx`                                                                   | 全局搜索弹窗（Ctrl+K）：搜历史对话/最近项目/工作区文件名                                                                                                                                                                                                                                                                                                                                |
| `PluginView.tsx`                                                                          | 插件视图宿主：薄 React 壳 + 动态 import client bundle                                                                                                                                                                                                                                                                                                                                   |
| `CollapsedMessage.tsx` / `LazyMount.tsx`                                                  | 消息折叠摘要行 / 消息级惰性挂载包装                                                                                                                                                                                                                                                                                                                                                     |
| `SearchBar.tsx`                                                                           | 会话内搜索栏（Ctrl+F，CSS Custom Highlight API 高亮）                                                                                                                                                                                                                                                                                                                                   |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `HintTip.tsx` / `SoundSettings.tsx` | 通用件（HintTip：`?` 悬浮提示 portal 顶层渲染）                                                                                                                                                                                                                                                                                                                                         |

## 4. 核心架构（摘要）

> 详细文档见 `docs/architecture-*.md`

| 主题                 | 文档                                                   | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **快照驱动**         | `docs/architecture-core.md`                            | 服务端是唯一事实源，60ms 节流推快照；增量快照（snapshot_delta）；message_delta 实时增量通道不经 snapshot 通道；WS permessage-deflate 压缩；多标签页序列化共享；协议版本协商                                                                                                                                                                                                                                                                                                                                                                                                       |
| **协议单源**         | `docs/architecture-core.md`                            | `server/protocol.ts` 是唯一事实源；`web/src/types.ts` 是 `export type *` shim；新增消息只改 protocol.ts，两端 switch 各加分支                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **全局运行态**       | `docs/architecture-core.md`                            | `web/src/app-globals.ts`：身份/能力（engine/managed/tabs/版本号）+ 连接态与 cwd 这类「整棵树都要」的信息放模块级 store，窄 props 组件用 `useAppField(key)` 单字段订阅、不再要 prop（吃整个 ChatState 的 App/TopBar/FooterBar 仍直读 `chat.*`）；全局发送器 `appSend` 也在这里（组件不收 `send` prop，面板的 `panelSend` 包装除外）；快照流里的数据严禁进去（store 通知绕过 memo）                                                                                                                                                                                                 |
| **安全边界**         | `docs/architecture-core.md`                            | 默认只绑 loopback；WS Origin/Host 同权威校验；quiesce 准入控制；控制 socket；provider headers 不下发浏览器                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **主题切换**         | `docs/architecture-core.md`                            | styles.css 是唯一布局文件，主题 = 纯 `:root` 变量覆盖（非整文件副本）；内置主题由 make-light-theme.mjs 从 styles.css 变量清单生成；改布局永不碰主题；终端跟随主题                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **多对话并发**       | `docs/architecture-core.md`                            | 每对话独立 AgentSessionRuntime；对话按项目归属；set_cwd 切到目标项目对话；8 个上限/项目（子代理不计入）；共享同一个 ModelRuntime                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **附件**             | `docs/architecture-attachments.md`                     | 三种模式（inline/reference/lines）；图片问答（base64 + 缩放）；文件上传（fileData 落盘）；视觉桥（纯文本模型看图转写）                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **文件预览**         | `docs/architecture-attachments.md`                     | 512KB 上限 + 内容嗅探（文本/二进制 + GBK 回退）；媒体预览走 HTTP Range；下载绕开 Chrome Safe Browsing                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **终端**             | `docs/architecture-terminal.md`                        | 每 Conversation 一个 TerminalManager；spawn 统一准入；按键编码纯函数；输出微批合并；node-pty × --watch 兼容自愈                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **SCM**              | `docs/architecture-terminal.md`                        | 只读 git 查询走 execFile 直跑（不经过 shell）；git-dir watcher；写操作走可见终端 tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **终端接管 bash**    | `docs/architecture-terminal.md`                        | 覆盖 SDK bash；设置开关 `terminalBash` 分流（关=原生 SDK 纯进程 bash，开=可见终端）；开时 `persist` 决定一次性/持久（false=跑完进程结束、输出保留；true=持久 ai-bash，shell 状态跨调用保留）；`head`/`tail` 截返回行；哨兵行技术；静默解阻（持久）；ai-bash/ai-bash-<n> 前端「AI bash」折叠分组且不计入终端数量上限                                                                                                                                                                                                                                                               |
| **插件**             | `docs/architecture-plugins.md`                         | <dataDir>/plugins/<id>/ 目录（manifest.json + index.mjs + client/entry.mjs）；attach 时热重扫；fenced-code 渲染插件（renderers + view:false，命中 ```lang 才懒加载，见 plugin-fence.ts）；官方插件走 `pi-web-ui install`（含子目录 source）分发，不进 npm 包；插件市场（plugins/catalog.json 内置列表 + 用户自定义，设置面板一键 `install --name <id>`，见 plugin-catalog.ts）；插件→宿主动作桥 `window.__piWebUiHost`（setView / startChat：新建对话+自动发消息，时序见 web/src/plugin-host.ts；compose：塞进输入框草稿等用户自己发，见 web/src/composer-bridge.ts）；MCP 工具桥 |
| **子代理模板**       | `server/subagents.ts` + `server/subagent-templates.ts` | 设置面板配置角色系统提示词（append/replace）+ 技能/扩展白名单；AI 经 subagent_templates 查询、subagent_spawn(template=) 选用也可不传按默认；停用模板对 AI 不可见；全局共享                                                                                                                                                                                                                                                                                                                                                                                                        |
| **工具结束实时状态** | `docs/architecture-core.md`                            | tool_status 先于快照落盘，浏览器卡片立即从「执行中」→「已结束」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **工具挂死看门狗**   | `docs/architecture-core.md`                            | 20 分钟超时自动 abort 会话；只停止运行不碰后台服务；**`ask_user_question` 豁免**（等人类回答不限时，问卷挂着也不算失联）                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **待答问卷进快照**   | `docs/architecture-core.md`                            | `UiState.pendingQuestion` + `web/src/pending-question.ts`：刷新/重连后恢复问卷对话框（即时通道只推给提问那一刻在线的连接）                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **后台任务列表**     | `docs/architecture-core.md`                            | bash 前后端口快照 diff；按客户端持久；单停/全部关闭                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **扩展 UI 桥**       | `docs/architecture-core.md`                            | setWidget/setStatus/notify/select/confirm/input → 浏览器消息；dialog_response 回传                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 5. 开发工作流

> 详细文档见 `docs/development.md`

```bash
npm run dev          # 并行：node --watch 后端(:8788) + vite 前端(:5173)
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run format       # prettier 全仓库格式化（提交前必跑；只检查用 format:check）
npm run lint         # oxlint（未使用变量/危险模式；提交前必跑；自动修用 lint:fix）
npm run build        # build:web (vite) + build:server (tsc)
npm start            # 跑编译产物 dist/server/index.js（生产）
npm test             # vitest 纯函数单测
npm run test:smoke   # 零 token 协议冒烟聚合跑器
npm run desktop:dev  # Electron 桌面壳指到本地 sidecar（:随机口，需先 npm run build）
npm run build:extension  # 打包 page-picker 浏览器扩展（esbuild → plugins/page-picker/extension/dist/）
npm run pack:extension   # 打浏览器扩展 zip → release/（打 tag 时 CI 自动出包并挂 Release）
npm run desktop:dist # 本地打桌面安装包 → release/（gitignore；CI 也跑同一条）
```

**关键约定**：缩进用 Tab；i18n 走 `useT()`（核心只含 `zh`/`en`，其余语言是 `locales/*.json` 可下载语言包、不进 npm，缺 key 自动回落英文；新 key 加 zh+en 即可，`tests/unit/locales.test.ts` 锁 key 对齐；8 个语言包也要同步加 key 且顺序与 zh 一致）；服务端多语言（issue #91）：`server/i18n.ts` 中英内联 + 翻译表（v2）。`resolveServerLang` 只做归一（zh-CN→zh、pt-BR→pt，空→en）；`pick(lang,zh,en,key?)` 第 4 参数是全局唯一翻译 key（`<模块>.<slug>`，如 `subagents.list.empty`），zh 走内联中文、其他语言查表、缺表/缺 key 回落英文；多行块用 `getServerBlock`（表里存 `\n` 拼接的一行）；tool definition 用 `bilingual(en,zh)` 静态双语（无 key，模型看英文无碍）；模板内容/用户覆盖保持 zh/en 字段（配置品，不进表）。第三语言的表放在语言包的 `serverStrings` 节（与 `strings` 同文件、一次下载全带走，`validatePack` 校验；缺 key 自动回英文所以部分翻译可安全上线）；服务端启动 + 包安装/删除时经 `loadServerStrings`/`unloadServerStrings` 注册。浏览器经 `hello.locale`/`set_locale` 上报 UI 语言（`client-state.json` 的 `locale` 持久化，切换经 settings reload 通道自动应用）；maker 统一收可选 `lang?: () => ServerLang`，推 UI 的 notice 走 `text`+`textEn` 双字段（前端按 locale 自选）；样式全部在 `styles.css`；新增协议消息只改 `protocol.ts` 再两端 switch 加分支；**前端新增服务端 URL（`/ws`、`/api/*`、`/plugins/*`、`/themes/*`）一律用 `web/src/base-url.ts` 的 `appUrl()` 包一层**（nginx 子路径反代依赖应用根前缀，裸写根路径会在子路径部署下 404）。

**测试规范**：端口隔离（≥8900）；data-dir 隔离（`mkdtempSync`）；精确清理自己进程；不允许 `pkill -f` 杀全局。

## 6. 发布流程

> 详细文档见 `docs/release.md`

```bash
# 升版本 → 写 CHANGELOG（含 npm run changelog:i18n 自动记文案增量）→ 自检构建 → commit → push → 打 tag（Action 自动建 Release + 出桌面安装包）→ npm publish
npm run typecheck && npm run build
npm run changelog:i18n   # 文案有增减时必跑：自动刷新 CHANGELOG Unreleased 的 ### i18n
# 预览 Release 说明（只看不发）：node scripts/release-notes.mjs X.Y.Z --base v<上个版本>
git add -A && git commit -m "feat(xxx): 描述"
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z   # tag 带 v 前缀，数字与 npm 版本一致；推送后 Action 自动创建/更新 GitHub Release（含现场生成的 ### i18n），无需手跑 gh release create
npm publish
```

注意事项：版本号必须高于 npm registry；提交信息不要带 `Co-authored-by`；升级后需手动重启服务 `pi-web-ui server restart`；发布前检查示例文件不泄密。

## 7. 环境变量

> 完整列表见 `docs/env-vars.md`

| 变量                     | 默认            | 一句话作用                                                     |
| ------------------------ | --------------- | -------------------------------------------------------------- |
| `PI_WEB_PORT`            | `8787`          | HTTP 端口                                                      |
| `PI_WEB_HOST`            | `127.0.0.1`     | 监听地址（默认只绑 loopback）                                  |
| `PI_WEB_CWD`             | `process.cwd()` | 智能体工作区                                                   |
| `PI_WEB_DATA_DIR`        | `~/.pi-web`     | 数据目录（client-state / uploads / plugins）                   |
| `PI_WEB_TOKEN`           | 空              | 可选共享口令鉴权                                               |
| `PI_WEB_TOOL_TIMEOUT_MS` | 20 分钟         | 工具挂死看门狗超时（`ask_user_question` 问卷豁免，不受此限制） |

## 8. 部署

> 详细文档见 `docs/deployment.md`

- **CLI 前台**：`pi-web-ui --port 9000 --cwd /path`
- **开机自启**：`pi-web-ui server install`（macOS→launchd / Linux→systemd / Windows→登录 Run 键，无需管理员）
- **Docker**：`docker compose up -d`

## 9. 常见坑

- **服务活着时跑 `npm run build` 会黑屏**：vite 先清空 `web/dist` 再写新文件，构建窗口内打开页面，`index.html` 与 hash 产物对不上；旧版里缺失的产物会穿透 `express.static` 落进 SPA catch-all 回 200 的 HTML，浏览器当 JS 执行失败，且 SW 会把它按 200 缓进 STATIC_CACHE（之后服务恢复了也好不了，必须 Unregister SW）。正确姿势：先停服务 → build → 启动 → 黑页标签 Unregister SW 后重载。服务端已加 `/assets/*` 等缺失 404（不再回 HTML）、SW 只缓存 content-type 对得上的资源。

- **改了 `protocol.ts` 后忘了在两端 dispatch/onmessage switch 加分支** → 前端收到未知消息类型被 switch 静默丢弃，表现为"没反应"。先跑 `npm run typecheck`。
- **nginx 子路径部署（页面在 /pi/ 下）插件/WS/API 加载失败** → 大概率是新增的请求路径没走 `appUrl()`（见关键约定），请求落在网站根绕过了 `location /pi/` 的剥离转发；排查时先看浏览器 Network 的请求带没带 `/pi` 前缀。
- **快照 60ms 节流**：调试时 `get_state` 可立即推一次（`cs.flushSnapshot()`）。
- **snapshot 发送背压**：`send()` 在序列化之前检查 `ws.bufferedAmount`，超过阈值时丢弃 snapshot（全量幂等且稍后必有更新）；丢弃时安排 250ms 重试 timer。
- **`hello` 前/会话未就绪时的命令**：`server/index.ts` 的 `pending` 队列会缓存并在 attach 后重放。
- **clientId 每标签页独立**（issue #10）：前端 `getClientId()` 存 sessionStorage（非 localStorage），同源多标签页是多个独立客户端。回归：`multi-tab-test.mjs`。
- **socket 半开**：服务端 10s 心跳，客户端 30s 无消息主动断开重连（指数退避 1s→10s）。
- **预览与附件行号**：`countLines` 不算尾随换行；前端 `split("\n")` 后也要 pop 掉末尾空串。
- **Windows 老中文文件乱码**：预览/内联附件/行附件统一走 `decodeText`（严格 UTF-8 失败 → GBK → latin1）。
- **Windows 窗口最小化后收不到桌面通知**（Win11 + Edge/Chrome 实测，2026-09）：最小化后 `document.hasFocus()` 仍为 `true`、`visibilityState` 仍为 `"visible"`，连 `blur`/`visibilitychange` 都不发 —— 只有原生窗口矩形会变（`screenX/screenY` 变成 -21334（Edge）/-32000（Chrome）、`outerWidth/Height` 塌成标题栏 108×20 / 160×28）。判定全在 `web/src/notify.ts`（`isCollapsedWindow` + `shouldSuppressNotify`，纯函数 + 单测）；Windows 上还额外要求「最近 2 分钟内有页面交互」才肯吞掉通知（焦点/可见性本来就在骗人，宁可多提醒也不静默）。**另一个坑：通知不能带 `tag`** —— Windows 把同 tag 的新通知当成「替掉旧条目」而且静默（没横幅、没提示音），只要通知中心里还留着一条 pi-web-ui 通知，后面每条都会被无声替换（`showNotification` 仍然 resolve，页面上看不出问题；`renotify: true` 实测救不回来）。排查入口：顶栏声音下拉 → 通知块底部的「发送测试通知」按钮（`NotifyToggle.tsx` 的 `SHOW_NOTIFY_TEST_PANEL` 常量，默认关闭，排障时改成 `true`），它显示实际通道（sw/page）、浏览器是否真的持有这条通知（`getNotifications()` 计数）与判定依据（焦点/可见性/最小化/空闲）。
- **模型列表刷新 = 官方目录整表替换（非并集）**：内置服务商（opencode-go 等）的模型目录来自 pi.dev（`https://pi.dev/api/models/providers/<id>`），`server/patch-remote-catalog.ts` 在启动时幂等改写 SDK 的 `remote-catalog-provider.js`，使 `getModels` 在远程数据存在时**整表返回官方目录**（无内置旧模型残留、无“新增 N 个”合并）；`listModels()` 先 `mr.refresh({ allowNetwork: true })` 与官方接口校验（SDK 4h 窗口内走 304）。注意：改 `node_modules` 的补丁在 `npm install`/SDK 升级后会失效，服务重启时自动重打；SDK 源码结构变化时自动跳过（回落 SDK 默认并集语义，不崩溃）。验证：`tests/scratch/verify-patch.mjs`。
- **PI_WEB_TOKEN 改口令后旧 cookie 卡死**（issue #71）：有效 token 请求会刷新 `pi_web_token` cookie 为当前值，401 且带失效 cookie 时自动 Expire——用户改了口令后**一次正确的 `?token=` 进入即永久恢复，无需清缓存**；别再实现「仅在无 cookie 时才下发」的旧逻辑（那是卡死根因）。回归：`tests/token-auth-test.mjs`。
- **Playwright 脚本**：Chrome 路径由 `tests/lib/chrome.mjs` 逐平台探测（`PI_WEB_CHROME` 可覆盖），不再写死本机路径；脚本里取仓库根一律用 `fileURLToPath(new URL("..", import.meta.url))`——`URL.pathname` 在 Windows 上得到 `/E:/...`，`spawn` 会直接 ENOENT；服务端进程清理在 win32 走 `tests/lib/port-utils.mjs` 的 `freePort`（负数 PID 的进程组在 Windows 上不存在）。

---

_结构/流程变更时同步更新本文件及相关 `docs/` 文档。修改后运行 `/reload` 生效。_
