# 目录树参考（directory-reference）

> 来源：2026-09 精简前的 `AGENTS.md` §3 全文（备份见 `AGENTS.md.bak`）＋ 之后新增文件的补齐。
> 约定：`★` = 单源/入口，先读；行内注释里的数字（工具个数、slot 个数等）以源码为准；
> 新增文件先在树里占位，注释以后补（以各文件头注释为准）。
> 新增顶层文件 / `server/*.ts` / `web/src/*` / 组件时，同步更新本文档。

## 顶层

```
pi-web-ui/
├── server/                     # 后端（Node ESM，编译到 dist/server/）
├── web/                        # 前端（React + Vite，编译到 web/dist/）
├── bin/pi-web-ui.mjs           # CLI：前台启动 / server install|uninstall|start|stop|restart|status
├── desktop/                    # Electron 桌面壳（sidecar：随机空闲口起 dist/server + BrowserWindow）
│   ├── main.ts                 # 主进程：ready → 选空闲口 → spawn server(ELECTRON_RUN_AS_NODE) → loadURL
│   ├── electron-builder.yml    # 打包配置（win nsis / mac dmg / linux AppImage；npmRebuild:false）
│   └── README.md               # 桌面版说明：跑起来 / 约定 / 发布 / 签名（SignPath）
├── deploy/                     # 部署示例：launchd plist / systemd unit / Windows 任务 XML
├── themes/                     # 内置主题（完整样式表：:root 变量 + 任意选择器/布局覆盖皆可，styles.css 只是共享基线）
├── make-light-theme.mjs        # 主题生成器（从 styles.css 的 :root 变量清单生成纯调色板）
├── tests/                      # 全部测试脚本（自包含：独立端口 ≥8900 + 临时 data-dir）
│   ├── run-smoke.mjs           # 零 token 协议冒烟聚合跑器（ALL 列表；插件后台作业/目录同步 plugin-jobs-test、多根工作区
│   │                           #   workspace-roots-test 都在里面）
│   ├── unit/                   # vitest 纯函数单测（插件 UI 扩展点：plugin-ui-manifest / ui-slots / context-menu /
│   │                           #   plugin-grants / plugin-project / plugin-installer / plugin-catalog-sync；多根工作区：workspace-roots）
│   │                           #   插件设置（声明式 schema / select 候选值）：plugin-settings / plugin-setting-options
│   ├── *-test.mjs              # 手写 Playwright E2E / WS 协议测试
│   │                           #   ⚠ 需 Chrome 的浏览器 E2E **不入 run-smoke**，手动 `node tests/<name>.mjs` 跑（缺 Chrome 自动 SKIP）：
│   │                           #     context-menu-ui-test（右键菜单槽位）/ ui-layout-ui-test（布局页 ↔ 界面一致性）/ plugin-settings-page-test（插件设置页）/ plugin-settings-select-ui-test（插件设置下拉）/ plugin-topbar-ui-test（顶栏条目 + 面板内后台卸载）/ elsewhere-click-takeover-ui-test（「另一处」行左键两段确认过户）
│   └── scratch/                # 一次性调试脚本（gitignore，不入库）
├── scripts/check-protocol-sync.mjs  # 守护 types.ts shim 单源机制 + protocol.ts 纯类型约束
├── .github/workflows/ci.yml    # CI：协议同步 → typecheck → build → vitest → 冒烟
├── .github/workflows/release-notes.yml   # tag 推送 → 按 CHANGELOG 建/更新 GitHub Release
├── .github/workflows/desktop-release.yml  # tag 推送 → windows-latest 出 NSIS 安装包并附到 Release（签名以后加这里）
├── extensions/                 # pi 扩展：webui.ts（/webui 命令启动本机服务并打开浏览器）
├── plugins/                    # 官方插件（webmail / db-client / vscode-editor / sftp / demo-mailbox / mermaid / run-trace / legado-web / wechat-ilink / image-toolkit / notes / live-preview / voice-input / desktop-use / pm2-manager，各自的 README.md 见其目录；page-picker/extension 是**浏览器扩展**，不是 pi-web-ui 插件）
│   └── catalog.json            # ★ 插件市场内置列表（随包发布；社区加插件 = 在此加一条 + PR）
├── dev/                        # 本地开发辅助（notice/search 预览等，不入 npm 包）
├── Dockerfile / docker-compose.yml
├── docs/                       # 详细文档（architecture-core / architecture-attachments / architecture-terminal /
│                               #   architecture-plugins / architecture-system-prompt / goal-conversation-design /
│                               #   tool-context-budget / agent-rules（编码红线细则）/
│                               #   device-center / device-collaboration / architecture-canvas / architecture-sandbox /
│                               #   development / release / deployment / dsh-engine / antigravity-proxy / env-vars ＋ 本文件）
└── tsconfig.server.json / tsconfig.extensions.json / tsconfig.tests.json / web/tsconfig.json
```

## server/

```
server/
├── index.ts                # 入口：express 静态 + /ws 端点、消息分发、心跳、优雅停机
├── protocol.ts             # ★ 唯一事实源：wire 协议类型（client↔server 消息）
├── protocol-version.ts     # wire 协议版本（新旧端互斥时顶掉旧 tab）
├── agent-service.ts        # 核心：ClientSession（每客户端一个会话组，可并行多个对话）+ AgentService
├── serialize.ts            # SDK 消息 → UiMessage 序列化
├── message-window.ts       # 历史消息服务端按需加载：尾部窗口（条数 + 字符预算）+ load_earlier_messages 往前翻页；挂在每连接 send 漏斗上，四引擎通吃
├── text-sniff.ts           # 文件预览纯函数（previewKind/looksLikeText/decodeText/sniffImageMime/hexDump/countLines）
├── queue-utils.ts          # 排队消息纯函数（removeFirstOccurrence：只移除第一条匹配，重复文本不连带删除）
├── process-utils.ts        # 进程工具：snapshotListeningPorts/killPidTree/lookupProcessName
├── client-state.ts         # ClientStateStore：<dataDir>/client-state.json 持久化
├── uploads.ts              # 文件对话上传 + 保留期清理
├── bg-servers.ts           # 后台任务跟踪（bash 前后端口快照 diff + 存活刷新 + 闲置超阈值自动清理/📌钉住）
├── settings-service.ts     # 设置面板状态机
├── preset-share.ts         # ★ 设置预设的导入/导出/分享/社区目录（交换格式 pi-web-ui-preset v1：白名单净化、SSRF 收口、gh issue 回落预填网页、index.json 目录 5 分钟缓存；编排走 PresetSharePort，见 docs/preset-sharing.md）
├── preset-fields.ts        # 预设可携带的字段清单 + 分组（零依赖，前后端共用；编译期守卫对齐 ClientSettings 全集）
├── goal-service.ts         # 目标/审查循环/调研向导
├── i18n.ts                 # 服务端语言协商 + 翻译表注册（resolveServerLang/pick/bilingual/getServerBlock）
├── locales.ts              # 可下载语言包（核心只含 zh/en，其余语言走语言包 serverStrings 节）
├── tool-manager.ts         # ★ Agent 工具统一开关：AGENT_TOOL_CATALOG ＋ tool_manage 出入口（setAgentToolEnabled/applyAgentToolsGating），持久化只有 disabledAgentTools
├── tool-approval.ts        # 人机协同拦截与改写执行（HITL：Edit & Run），门禁在 ClientSession.askApproval
├── approval-rules.ts       # ★ 审批规则库与匹配引擎（ApprovalRulesStore：<dataDir>/approval-rules.json，多工具/多字段/多模式规则；ask/deny/allow 三种动作；纯函数评估）
├── compact-context-tool.ts # ★ 主动压缩上下文工具（compact_context）：AI 主动根据当前任务精简上下文，自主控制保留范围并在回合后生效
├── compaction-markers.ts   # 压缩 transcript 标记 + 修复（issue #235）
├── context-budget.ts       # 多级分层上下文预算裁剪（触发 LLM 全文摘要之前的梯度裁剪）
├── soft-cap.ts             # 自定义上下文压缩软上限（Soft Cap，issue #229/#773；纯函数 normalize/effective/softCapToReserve/softCapReserveFor：后者算出注入 SDK 的 reserve=cw-cap，回合内工具间隙即压）
├── dangling-tools.ts       # 悬空 toolCall 检测与修复（issue #280）
├── edit-soft-tool.ts       # 独立宽松编辑工具 edit_soft（行核心匹配，忽略缩进差异；开关走统一工具 tab）
├── read-tool.ts            # 覆盖内置 read：路径是目录时列目录条目（复用 SDK ls 的口径，其余原样转发内置；行为开关 readDirEnabled 在设置「工具」页，不入 AGENT_TOOL_CATALOG）
├── present-files-tool.ts   # ★ AI 展示文件（present_files）：只读探测 stat/未知扩展嗅探/文本摘录 → 结构化 items 走 toolResult 的 details → 前端预览卡片；不自动打开任何窗口
├── skill-tool.ts           # 让 AI 按名取技能全文（名录 + skill 工具）
├── claim-files-tool.ts     # 文件认领（claim_files）：并行冲突的事前打招呼
├── claim-store.ts          # 文件认领表（claim store）+ 触碰 sidecar
├── conversation-read-tool.ts # 让 AI（含子代理）读取别的对话（list 看运行+历史，read 分页读）
├── conversation-touches.ts # 会话「触碰文件集」提取（纯函数，零 node 依赖）
├── delegate-task.ts        # 结构化派单工具 delegate_task（委派协议的代码级硬化）
├── eval-tool.ts            # 受控的持久代码求值沙箱工具（eval，opt-in）
├── hashline-engine.ts      # 基于内容哈希锚定与语法块解析的高可靠 Patch 引擎
├── patch-tool.ts           # 导出给 AI 的结构化补丁工具（Hashline Patch Tool）
├── lsp-tool.ts             # 导出给 AI 的原生 LSP 语言服务器工具
├── plan-manager.ts         # 结构化任务计划看板与步骤状态机（Plan Mode / Step State Machine）
├── schedule-agent-tool.ts  # 把内置调度器暴露给 Agent（issue #193）
├── scheduler-tasks.ts      # 内置定时任务调度（issue #184）：任务 CRUD + cron/间隔触发 + 无头执行
├── tool-info.ts            # 工具定义说明（工具卡右键 → 显示工具详细信息）：按名现取 SDK / DSH 运行时的工具定义 → `tool_info`（定义是大对象，不进快照；DSH 拿不到时回 `unsupported`）
├── tool-prompt-overrides.ts # 逐工具文案覆盖（设置→工具区「编辑文案」）：归一化 + 给会话 _toolRegistry 打 description/snippet/guidelines 补丁（出厂定义永不动，可复原）
├── load-tools-tool.ts      # 工具延迟加载入口（load_tools）：目录（名字 + 一行摘要）在系统提示词里，模型按需把参数 schema 拉进本对话
├── tool-prompts.ts         # bash 工具模型可见文案（description/snippet/guidelines/参数 schema）的唯一事实源（三条执行路径共用）
├── subagents.ts            # 第一方子代理：统一的 subagent 工具（spawn/get_result/steer/list/stop/templates/wait_all/handoff）+ 运行态快照
├── subagent-templates.ts   # 子代理模板库（全局 <dataDir>/subagent-templates.json；白名单语义；可选模型/思考强度，空=跟随主对话；enabled=false 对 AI 不可见）
├── subagent-templates-hant.ts # 内置子代理模板的繁中（台湾用语）文案；zh-TW/zh-HK/zh-Hant 共用，仅作展示/取用视图，不回写库
├── wait-subscription-scan.ts # 挂起 wake 订阅扫描（保留带 pending 子代理 wake 的对话）
├── slash-commands.ts       # 斜杠命令（NATIVE_COMMANDS 内置命令拦截执行 + 目录推送）
├── prompt-composer.ts      # 主会话系统提示词自由组合模板（{{token}} 在每次 run 前展开）
├── model-admin.ts          # 模型/服务商配置管理（含内置服务商多密钥：provider-keys.json + add/activate/remove_provider_key，模型目录复用系统默认，不复制；网关 /models 自报的 reasoning_levels / supported_reasoning_levels[].effort 会推导成模型级 thinkingLevelMap 并贯穿保存/合并/下发，见 issue #771）
├── model-enrich.ts         # 用公开模型目录给自定义供应商的模型行补参数
├── provider-oauth-flow.ts  # 见文件头注释
├── resolve-global-sdk.ts   # 优先用全局/祖先那份 pi SDK 的解析钩子（issue #260）
├── sdk-origin.ts           # 本进程实际加载的是哪份 pi SDK 及被遮蔽的副本（issue #260）
├── update-check.ts         # 全源更新检查（本体 / pi core / DIRECT 扩展）
├── managed.ts              # 外部托管实例（自更新：顶栏更新徽标 + 面板）
├── attachments.ts          # 附件构建（路径/行范围引用 + imageData/fileData + 视觉桥；内容不注入）
├── attachment-store.ts     # 基于 SHA-256 内容寻址（CAS）的附件存储
├── file-archives.ts        # 见文件头注释
├── file-transfer-routes.ts # 见文件头注释
├── office-parse.ts         # Office 文档纯文本提取（docx / xlsx，供预览与附件走 file_content 用）
├── composer-drafts.ts      # 未发送输入框草稿单中心文件（<dataDir>/composer-drafts.json，issue #166）
├── webui-context.ts        # 扩展 UI 桥（WebUIContext：widgets/statuses/dialog → 浏览器）
├── themes.ts               # 主题管理（listThemes/resolveThemeFile）
├── tabs.ts                 # 实例能力页签选择（Chat / Terminal / Git / Search / …）
├── plugins.ts              # 可选界面组件插件（扫描 <dataDir>/plugins/<id>/；renderer 插件字段 view:false + renderers）
├── plugin-api-catalog.ts   # 机器可读的注册面目录（slot 的 key/kind/occupants/example）
├── plugin-catalog.ts       # 插件市场列表（builtin plugins/catalog.json + 用户自定义 <dataDir>/plugin-catalog.json）+ 目录同步纯函数（normalizeSyncPayload/writeCustomCatalog，issue #148）
├── plugin-catalog-sync.ts  # 市场目录同步编排（拉取/校验/原子写/可选安装/重载+重推，issue #148）
├── plugin-conversation-view.ts # ★ 插件会话快照选会话策略（#542：按 clientId 取本标签页正看的对话 / 缺省跳过子代理回落 + 模型变更去重键，纯函数）
├── plugin-dom.ts           # 特权 DOM 访问授权表（<dataDir>/plugin-dom.json）
├── plugin-facilities.ts    # 插件宿主设施：插件私有 KV 存储 + 加密 secrets
├── plugin-grants.ts        # 插件目录授权表（<dataDir>/plugin-grants.json）：工作区外目录的「记住」授权（父目录覆盖子目录），设置面板可撤销
├── plugin-install-spec.ts  # 「安装前先读 spec」（引导式安装）
├── plugin-installer.ts     # ★ 插件后台作业：安装/更新/卸载跑 CLI 子进程（不占用户终端、不打断设置面板），输出按行回传 + 单作业锁 + 看门狗（issue #152）
├── plugin-llm.ts           # 插件直调模型（host.llm.complete 的底层：一次性孤立无工具会话）
├── plugin-manifest-validate.ts # manifest 本体校验（schema 失败即拒）
├── plugin-permissions.ts   # 插件能力动态授权表（host.requestPermission 的底层）
├── plugin-project.ts       # ★ 插件项目组装执行层（host.project.create：clone/写文件/git init；路径越界三道校验，授权由上层判，本模块不动授权）
├── plugin-schedule.ts      # 插件定时任务的 cron 解析与持久化（host.schedule 的底层）
├── plugin-tool-guard.ts    # 插件工具拦截扩展点（pre + post，只覆盖已接管的 bash/read）
├── plugin-updater.ts       # 插件更新辅助（备份/回滚 + 远端 sha 对比）
├── mcp-bridge.ts           # MCP 工具桥（外部 stdio MCP 服务器的工具接入 pi 会话）
├── mcp-hot-reload.ts       # mcp.json 热加载（改完即生效，不重启）
├── icon-svg.ts             # 插件内联 SVG 图标（manifest `iconSvg`）校验与规范化
├── host-metrics.ts         # 见文件头注释
├── http-proxy.ts           # 代理设置透传（~/.pi/agent/settings.json + 环境变量）
├── auth-cookie.ts          # pi_web_token cookie 编解码（decodeCookieToken；脏值原样返回）
├── vision-bridge.ts        # 视觉桥：纯文本主模型看图转写
├── files-service.ts        # 文件服务（readDirForUI/readFile/searchFiles/watcher）
├── workspace-snapshot.ts   # 工作区版本影子快照（Workspace Snapshot / Dual-State Rollback）
├── scm.ts                  # SCM 只读 git 查询（execFile git status/branches/history/filediff/commit）
├── scm-commitmsg.ts        # AI commit-message 生成（prompt 拼装 + 回复清洗；git 采集在 scm.ts）
├── patch-node-pty.ts       # node-pty × Node --watch 兼容自愈补丁
├── patch-remote-catalog.ts # pi.dev 模型目录整表替换补丁（幂等改写 SDK remote-catalog-provider：刷新后内置服务商列表=官方目录整表，不保留内置旧模型/不报“新增 N 个”）
├── ensure-bash.ts          # Windows 轻量 bash 兜底（busybox-w32）
├── control-socket.ts       # 本地控制 socket（status / quiesce / unquiesce）
├── launch-origin.ts        # ★ 启动来源探测：本实例是否被 launchd/systemd/Windows watchdog 托管（更新面板「重启服务」的前置条件）
├── terminals.ts            # TerminalManager（PTY 管理 + 增量输出/按键工具）
├── marker-service.ts       # 标记服务（内置版 pi-marker-tools）
├── dsh/                    # DSH 引擎（详见 docs/dsh-engine.md）：dsh-agent-service / dsh-client / dsh-serialize /
│                           #   dsh-sessions / dsh-usage（底栏统计纯映射）/ preset-clones（file: 克隆）/ probe-*.mjs /
│                           #   runtime/{launcher.mjs, goal-rpc.mjs（问卷 answerer + 技能钩子挂 agent scope）, custom-prompt.mjs, cordis.yml, override.patch.yml, runtime-root.mjs}
└── markers/                # 标记子系统（配 marker-service.ts）：index / marker / registry / store / builtins
```

## web/src/

带注释的是常用/有机制的模块；其余按文件名自解释，读源码（`use-*.ts` 均为 React Hook，`*.css` 只有 model-management.css 一个例外）：

```
web/src/
├── App.tsx             # 顶层布局
├── main.tsx            # 入口：首帧前应用主题防闪烁 + initAuthToken
├── use-chat.ts         # ★ useChat()：WebSocket 连接管理、reducer 状态机、终端 bridge
├── app-globals.ts      # ★ 全局运行态 store（engine/managed/tabs/版本号 + 全局发送器 appSend）
├── types.ts            # ★ wire 协议 re-export shim（export type * from "../../server/protocol"）
├── protocol-version.ts # 协议版本常量
├── i18n.tsx            # ★ 多语文案（核心 zh/en；新 key 两处都加；value 只许字符串字面量，见 docs/agent-rules.md「三、UI 布局与样式规范」）
├── pick-locale.ts      # 语言选择辅助
├── styles.css          # ★ 全部样式（按组件分区，带注释分隔线）；也是默认深色主题本体
├── model-management.css # 模型管理页专用样式（唯一的第二个 css）
├── theme.ts            # 主题切换（/api/themes 列表 + localStorage 持久化 + applyTheme）
├── wallpaper.ts        # 壁纸（主题伴随资源）
├── sounds.ts           # WebAudio 提示音
├── notify.ts           # 桌面/OS 通知（PWA）：是否吞掉通知的判定（Windows 最小化检测）+ 诊断
├── download.ts         # 下载（fetch→blob，绕开 Chrome Safe Browsing）
├── base-url.ts         # appUrl()：服务端 URL 包应用根前缀（子路径部署必需）
├── auth-token.ts       # PI_WEB_TOKEN 口令注入
├── ui-slots.ts         # ★ 宿主 UI 扩展点引擎：BUILTIN_UI_ITEMS + buildUiSlots（宿主默认→插件贡献→插件 arrange→用户偏好 四层合并）+ splitOverflow/restoreUiItem
├── slot-toolbar.tsx    # 各组件 *HostNodes + renderMergedToolbar
├── topbar-fit.ts       # ★ 顶栏「放不下的自动进 ⋯」纯函数（fitTopbar）：按实测宽度从尾部丢，宽度 0 的条目不占位也不进菜单，测不到宽度全保留，有单测
├── context-menu-state.ts # ★ 通用右键菜单状态（contextmenu.* 槽位的 open/close + 定位/禁用/键盘导航纯函数，有单测）
├── use-floating-panel.ts # ★ 浮层统一 Hook（scroll/resize 只重算锚点；mousedown/Escape 才关）
├── composer-bridge.ts  # ★ 输入框注入桥：宿主（扩展/插件）把内容塞进输入框草稿的模块级 sink 注册点，有单测
├── composer-draft.ts   # 草稿合并/去重 + advanceComposerSession（附件跟会话走）纯函数，有单测
├── use-composer-session.ts # 输入框会话绑定 Hook
├── caret-visual-line.ts # ★ 输入框光标的首/末视觉行判定（镜像 div 量 offsetTop），供 ↑/↓ 翻输入历史用，有单测 + 真浏览器回归
├── prompt-history.ts   # 输入历史（↑/↓）存储
├── message-delta.ts    # message_delta 增量 patch 纯函数，有单测
├── lazy-window.ts      # 消息列表惰性窗口化纯函数，有单测
├── search-folded.ts    # 折叠区搜索辅助
├── present-items.ts    # ★ present_files 卡片纯函数（参数解析/与 details 合并/能力判定/自动打开闸门），有单测
├── present-settings.ts # 卡片偏好：自动打开预览弹窗（localStorage，默认关）+ 已开过的 toolCallId 去重表
├── file-preview-bridge.ts # 工具卡片 → 文件预览弹窗的模块级 sink（App 注册 opener）
├── file-transfer.ts    # 文件传输前端逻辑（配 FileTransferDialog + file-transfer-routes）
├── tool-info-state.ts  # 工具定义弹窗的模块级 store（打开/关闭/应答 → 视图，纯函数 + 单测）
├── tool-prompt-state.ts # 逐工具文案编辑器的默认值 store（get_tool_prompt 应答 → 视图，纯函数）
├── tool-schema.ts      # 参数 JSON Schema → 表格行（参数名/类型/必填/说明，纯函数 + 单测）
├── tool-args.ts        # 工具卡头参数提示纯函数（路径/超时安全提取，脏参数不抛错），有单测
├── skill-block.ts      # parseSkillBlock：<skill> 块解析，有单测
├── image-paste.ts      # 粘贴图片等比缩放 ≤1568px + PNG/JPEG 转码
├── message-image.ts    # 消息内图片渲染辅助
├── export-image-state.ts # 图片导出状态
├── uuid.ts             # randomUuid（crypto 兜底），有单测
├── pending-question.ts # 待答问卷恢复（UiState.pendingQuestion → 恢复对话框）
├── optimistic-queue.ts # 流式排队/插队消息与撤回的本地乐观更新与权威快照对账纯函数（有单测）
├── question-attachments.ts # 问卷附件 chips
├── plugin-host.ts      # 插件宿主桥（window.__piWebUiHost，宿主 API 时序）
├── plugin-loader.ts    # 插件 client bundle 加载（含 view:false 懒加载 / preload 预加载）
├── plugin-fence.ts     # fenced-code 渲染插件匹配
├── plugin-file-handlers.ts # 插件文件处理器
├── plugin-logs.ts      # 插件日志视图数据
├── plugin-phase.ts     # 插件生命周期阶段
├── plugin-setting-options.ts # 插件设置 select 候选值
├── plugin-icon.tsx     # 插件图标渲染
├── at-mention.ts       # @ 提及补全
├── slash-filter.ts     # 斜杠命令过滤
├── quick-phrases.ts    # 快捷短语
├── conv-groups.ts      # 对话分组（左栏）
├── copy-text.ts        # 复制文本辅助
├── use-copy-feedback.ts # 复制反馈 Hook
├── scroll-classify.ts（在 components/，见下）
├── banner-notice.ts    # 顶栏公告条数据
├── browser-control.ts  # 浏览器操作桥逻辑（配 BrowserControl 组件 + page-picker 扩展）
├── cache-stats.ts      # 缓存统计（底栏）
├── chat-width-settings.ts # 聊天列宽设置
├── code-lines.ts       # 代码行号辅助
├── desktop.ts / desktop-updater.ts # 桌面壳前端侧（更新检查/重启）
├── model-usage.ts      # 模型用量统计
├── panel-sash.ts       # 面板分隔条（拖拽调宽）
├── provider-oauth-state.ts # 服务商 OAuth 前端状态（配 ProviderOAuthControls）
├── rollback-state.ts   # 回滚（workspace-snapshot）前端状态
├── scm-commit-history.ts / scm-history-filter.ts / scm-quote.ts / scm-sidebar.ts # SCM 面板辅助模块
├── scrollbar-gutter.ts # 滚动条槽位
├── shortcut-stack.ts   # 快捷键栈
├── stream-markdown.ts  # 流式 Markdown 渲染
├── swipe-drawer.ts / use-swipe-drawer.ts # 手机端抽屉横滑手势（纯判定 + DOM 粘合）
├── term-touch.ts       # 终端触屏支持
├── thinking-levels.ts  # 思考强度档位
├── tip-position.ts     # 提示定位
├── title-settings.ts   # 标题设置
├── token-input.ts      # Token 输入框
├── touch-device.ts     # 触屏设备判定（IS_TOUCH）
├── update-command.ts   # 更新命令拼装
├── use-click-outside.ts # 点击外部关闭（浮层通用）
└── components/         # 见下
```

## web/src/components/

| 组件                                                                                      | 职责                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FilePreview.tsx`                                                                         | 文件预览弹窗：行号、点选/拖拽/Shift 选区、添加到对话；Markdown 预览可切换原文；可编辑保存                                                                                            |
| `PluginFilePreview.tsx`                                                                   | 插件提供的文件预览器宿主                                                                                                                                                             |
| `PresentedFiles.tsx`                                                                      | `present_files` 工具卡片正文：图片/视频/音频内联显示/播放，文本开头摘录 + 「预览」按钮；每行「预览/本地打开/在文件夹中显示/下载/复制路径」；`focus` 条目按偏好自动弹预览窗（三道闸） |
| `ToolInfoDialog.tsx`                                                                      | 「工具详细信息」弹窗（工具卡右键）：展示工具**定义**（说明/参数 schema 表格+原始 JSON），点开现取不进快照；portal 到 body（消息流祖先有 overflow/transform）                         |
| `ToolPromptEditor.tsx`                                                                    | 逐工具文案编辑器（设置→工具区「编辑文案」）：description/snippet/guidelines 三字段，留空=默认；保存走 `set_settings.toolPromptOverrides`                                             |
| `ToolApprovalDialog.tsx`                                                                  | 审批弹窗（ask 规则命中时的人机协同拦截 + 改写执行）                                                                                                                                  |
| `LeftPanel.tsx`                                                                           | 左栏：最近项目、运行的对话、历史对话（含删除）                                                                                                                                       |
| `RightPanel.tsx`                                                                          | 文件树浏览（list_files），文件名点击→预览，🔗 引用路径（仅路径，无内容注入）/👁 预览/⬇ 下载等按钮；服务端原生递归 watcher                                                             |
| `ChatInput.tsx`                                                                           | 输入框 + 附件 chips（引用/行范围/图片/上传/网页/对话多彩）；全窗口拖放目标；followUp 排队/steer 插队；斜杠命令选择器                                                                 |
| `Message.tsx` / `MessageList.tsx`                                                         | 消息渲染（附件卡片、流式光标、tool 结果关联）；编辑重问保留原附件；技能卡片折叠；惰性窗口化；问题导航双通道；流式 StreamMarkdown                                                     |
| `StreamMarkdown.tsx`                                                                      | 流式 Markdown 渲染组件（配 stream-markdown.ts）                                                                                                                                      |
| `ToolCallBlock.tsx` / `ThinkingBlock.tsx` / `BashBlock`                                   | 工具调用卡片（卡头关键参数提示 `.toolcall-path`/`.toolcall-timeout`，脏参数静默不显示）、思考块、bash 输出                                                                           |
| `TerminalPanel.tsx` / `TermXterm.tsx`                                                     | 终端视图 + xterm 实例桥接                                                                                                                                                            |
| `SCMPanel.tsx`                                                                            | 源代码管理（Git）视图：status/branch/diff；提交/推送/拉取/切换分支；左栏宽度可拖分隔条调、双击复位、宽度存 localStorage（#139）                                                      |
| `BrowserControl.tsx`                                                                      | 顶栏「浏览器操作」入口 + 状态面板；已授权页面一键「引用到对话」（单页面时按钮直接变页面标题）                                                                                        |
| `TopBar.tsx` / `FooterBar.tsx`                                                            | 顶栏（模型/思考强度/后台任务/声音/新对话/视图切换）、底栏（上下文/成本/工作目录）；单一扁平流，slot 顺序直排 + `hostNodes`                                                           |
| `Dialog.tsx`                                                                              | 扩展 `ui.select/confirm/input` → 浏览器弹窗（正文/选项走 `Markdown(rawHtml)` 富渲染）                                                                                                |
| `Modal.tsx`                                                                               | 通用弹窗壳                                                                                                                                                                           |
| `QuestionDialog.tsx`                                                                      | 模型提问对话框（`question_pending`，DSH 经 goal-rpc / pi 经 `ask_user_question` 共用）：单选/多选/自定义文本 + 选项 `preview` 富文本；挂 `UiState.pendingQuestion`，刷新后恢复       |
| `DshPresetBar.tsx`                                                                        | DSH Agent 预设条（模式切换 + 首轮锁定）                                                                                                                                              |
| `DshPermissionBar.tsx`                                                                    | DSH 权限提示条                                                                                                                                                                       |
| `ModelConfigModal.tsx` / `PiSetupModal.tsx`                                               | models.json 管理 / 首次配置引导                                                                                                                                                      |
| `ProviderOAuthControls.tsx`                                                               | 服务商 OAuth 授权控件                                                                                                                                                                |
| `SettingsModal.tsx`                                                                       | 设置面板（侧边栏分页：提示词/工具/消息显示/技能/插件/界面插件/目标审查/视觉桥/预设/子代理模板；DSH 另有问卷页、无工具页）                                                            |
| `PluginSettingsForm.tsx`                                                                  | 插件声明式设置表单（schema 驱动）                                                                                                                                                    |
| `PromptTemplates.tsx`                                                                     | 提示词模板管理                                                                                                                                                                       |
| `GoalBar.tsx`                                                                             | 输入框上方目标条：设目标/清除/AI 提炼/轮数下拉                                                                                                                                       |
| `PlanBoard.tsx`                                                                           | 结构化任务计划看板（配 plan-manager.ts）                                                                                                                                             |
| `BgTasksModal.tsx`                                                                        | 后台任务弹窗：AI 启动的监听端口进程列表                                                                                                                                              |
| `SchedulerPanel.tsx`                                                                      | 定时任务面板（配 scheduler-tasks.ts）                                                                                                                                                |
| `ModelThinking.tsx`                                                                       | 模型 + 思考强度下拉（按服务商筛选 + 顶部搜索）                                                                                                                                       |
| `GlobalSearchModal.tsx`                                                                   | 全局搜索弹窗（Ctrl+K）：搜历史对话/最近项目/工作区文件名                                                                                                                             |
| `ProjectPicker.tsx`                                                                       | 项目选择器                                                                                                                                                                           |
| `LocaleModal.tsx`                                                                         | 语言切换弹窗                                                                                                                                                                         |
| `PluginView.tsx`                                                                          | 插件视图宿主：薄 React 壳 + 动态 import client bundle                                                                                                                                |
| `PluginViewFallback.tsx`                                                                  | 插件视图加载失败兜底                                                                                                                                                                 |
| `PluginFenceBlock.tsx`                                                                    | fenced-code 渲染插件块（配 plugin-fence.ts）                                                                                                                                         |
| `PluginMenu.tsx`                                                                          | 插件菜单面板（浮层，走 useFloatingPanel）                                                                                                                                            |
| `PluginModal.tsx`                                                                         | 插件弹窗宿主（host.openModal）                                                                                                                                                       |
| `SlotTabs.tsx`                                                                            | slot 驱动的 tab 容器（`rightpanel.tabs` 与设置面板共用）：除当前选中项一律不挂载，切走即 cleanup；选中态存 localStorage                                                              |
| `SlotErrorBoundary.tsx`                                                                   | slot 内容错误边界                                                                                                                                                                    |
| `ContextMenu.tsx`                                                                         | 通用右键菜单渲染层（`contextmenu.*` 槽位）：portal + fixed + 先渲染再实测尺寸钳制；只渲染，点条目交回宿主 `onAction`                                                                 |
| `PluginPage.tsx`                                                                          | 插件自定义设置页宿主（`settings.pages` 槽位）：随选中项挂载/卸载；容器子节点只由插件写                                                                                               |
| `CollapsedMessage.tsx` / `LazyMount.tsx`                                                  | 消息折叠摘要行 / 消息级惰性挂载包装                                                                                                                                                  |
| `SearchBar.tsx`                                                                           | 会话内搜索栏（Ctrl+F，CSS Custom Highlight API 高亮）                                                                                                                                |
| `HoverDetail.tsx`                                                                         | 悬浮详情（? 提示内容体，配 HintTip 定位）                                                                                                                                            |
| `RollbackDialog.tsx`                                                                      | 工作区回滚确认（配 workspace-snapshot.ts）                                                                                                                                           |
| `SaveImageDialog.tsx`                                                                     | 图片保存对话框                                                                                                                                                                       |
| `FileTransferDialog.tsx`                                                                  | 文件传输对话框（配 file-transfer.ts）                                                                                                                                                |
| `BannerContainer.tsx`                                                                     | 公告条容器（配 banner-notice.ts）                                                                                                                                                    |
| `NotifyToggle.tsx`                                                                        | 声音/通知开关（含隐藏的通知诊断面板 `SHOW_NOTIFY_TEST_PANEL`）                                                                                                                       |
| `Markdown.tsx` / `Dropdown.tsx` / `copy-button.tsx` / `HintTip.tsx` / `SoundSettings.tsx` | 通用件（HintTip：`?` 悬浮提示 portal 顶层渲染）                                                                                                                                      |
| `mermaid.ts` / `scroll-classify.ts`                                                       | 非组件辅助（mermaid 渲染 / 滚动分类，与组件同目录存放）                                                                                                                              |
