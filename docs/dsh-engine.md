[English](./dsh-engine.en.md) · **简体中文** · [繁體中文](./dsh-engine.zh-TW.md)

# pi-web-ui × DeepSeek Harness（dsh）双引擎改造 —— 工作交接文档

> 本文档是**跨对话交接**用：记录已定决策、已完成工作、进行中/受阻状态、剩余计划与所有环境事实。
> 新对话开始时：**先读本文件**，再读 `E:/pi-web-ui/server/dsh/` 下的代码与注释，按"下一步做什么"继续。
> 当前时间：2026-09-01 凌晨（对话推进到 dsh 引擎核心对话全链路验证通过）。

---

## 0. 目标（用户拍板的三项决策）

1. **引擎可切换**：`PI_WEB_ENGINE=pi|dsh` 环境变量启动时切换（默认 pi），重启生效；前端显示引擎徽标；`/api/health` 返回 `engine` 字段。
2. **界面功能完全一样**：dsh 引擎要按现行 pi-web-ui wire 协议（protocol.ts）全量对齐 —— 目标/审查、SCM、后台任务、设置面板、模型配置、插件、终端、消息增量（message_delta/快照/snapshot_delta/tool_status）全都工作。
3. **架构 = 服务端引擎分发**：保留现有 pi 路径零改动；新增 `server/dsh/`（从 ds-web-ui 移植适配 + 升级到现行协议）；`server/index.ts` 按引擎选择实现类。同一 wire 协议，前端改动极小。

---

## 1. 环境事实（实测，勿重查）

| 项                      | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作区                  | `E:/pi-web-ui`（pi-web-ui 仓库，当前项目）                                                                                                                                                                                                                                                                                                                                                                                                                |
| 参考实现                | `E:/ds-web-ui`（xing-shuyin 的 DSH 版 pi-web-ui 移植，**仅参考**，用的是旧版分散包 `0.1.0-rc.6`）                                                                                                                                                                                                                                                                                                                                                         |
| Node                    | v24.20.0（fnm 管理）                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| DeepSeek key            | `~/.pi/agent/auth.json` 的 `deepseek.key`（**2026-09-01 用户重新提供 sk-f0e6…d99，len 35**），**dsh 运行时能复用**（ds-web-ui 就这么干）。⚠️ clear-provider-key-test 会清掉它 —— 跑前备份，跑后恢复（dsh 已尊重 PI_CODING_AGENT_DIR，正常测试不会再碰真实 auth.json）                                                                                                                                                                                     |
| 全局 dsh 运行时         | 推荐安装最新版（如 `npm i -g @deepseek-ai/dsh` 或 `@deepseek-ai/dsh@0.2.1-rc.2`）。其**嵌套树** `dsh/node_modules/@deepseek-ai/`（300+ 个包）即完整运行时树（dsh-base/dsh-app-boot/全部工具/loader peers 都在）。⚠️ **dsh-base 不在顶层 `npm root -g/@deepseek-ai/`（只有 dsh 一个包），运行时树解析必须查嵌套位置**（runtime-root.mjs 已处理）                                                                                                           |
| pi-web-ui 本地 dsh 依赖 | 已在 package.json 更新为最新：`@deepseek-ai/dsh-sdk-jsonrpc-server@^0.2.1-rc.2`、`@deepseek-ai/dsh-sdk-protocol@^0.2.1-rc.2`。`goal-rpc.mjs` 会自动优先链接当前运行时树同源依赖，实现同树自洽。                                                                                                                                                                                                                                                           |
| **版本族与兼容策略**    | 最新基线对齐：`dsh@0.2.1-rc.2`、`dsh-sdk-jsonrpc-server@0.2.1-rc.2`、`dsh-sdk-protocol@0.2.1-rc.2`。版本族按 major.minor（如 `0.2`）划分。✨ **默认宽松运行策略（不限制版本默认最新）**：启动器默认以环境或全局中检测到的最新可用运行时尝试启动（优先同族最高版本）；若遇到不同版本族仅打印提示信息而不做提前退出，尽可能向前兼容；仅在真正 boot 失败且版本不符时才给出版本排查建议；若需要强制拦截跨版本混用，可显式配置 `PI_WEB_DSH_STRICT_VERSION=1`。 |

---

## 2. DSH 研究结论（关键，决定实现策略）

### 2.1 JSON-RPC 协议面（官方最新 0.1.5-rc.3，仍是精简面）

- **RPC 方法仅 3 个**：`initialize`（cwd/provider/model/maxTokens）、`session/prompt`（sessionId + contentBlocks → 返回 `{messageId}`，**按需隐式建会话**）、`shutdown`。
- **通知**：`session.event`（sessionId + event，全量持久事件）、`session.status`（running/idle）、`subagent.started` / `subagent.finished`。
- **官方明确限制**：无 per-session close、无 prompt 取消、无 per-prompt 结果 → **中止 = 强杀运行时进程**，**换模型 = 重启运行时**，**会话管理/列表/回放 = 直读 JSONL**。
- 每进程一个 provider/model；`initialize` 无 provider adapter 时自动挂 dsh-llm-deepseek fallback。

### 2.2 运行时组合（已实证可 boot）

- 用 `@deepseek-ai/dsh-app-boot` 的 `boot(binName, configPath, patches, prepare, bareModuleBaseUrl)`：config = 空 `[]`，patches = [dsh-base bundle patch, override patch]。
- **dsh-base bundle** = 官方所有 profile 的共享底座（78 行：llm/session/agent/agent-loop/settings-file/credentials-local/jsonl 持久化/全部工具/goal/plan-mode/skill/subagent/workflow/search/审批）。
- **bareModuleBaseUrl**（裸包名解析的唯一 base）→ 运行时树；**混树挂项目依赖的 jsonrpc 插件必须走绝对路径**。
- patch 语法铁律：**重复 base 的 id 用 `- id: … name: … config: …` 定向替换（last-write-wins）；新行用 `- insert: [...]`**。
- ⚠️ **patch 列表必须是扁平结构**：boot 的 patches 参数是"patch entry 列表"（`[{insert:...}, {id:...,...}]`），传嵌套数组会被 applyEntryPatches 当无 id 的 entry 静默跳过（本次踩过的坑，见 §6.10）。
- ⚠️ **loader 只对 entry 的 config 做 !!js 插值，name 字段不支持 !!js**（disabled 支持）→ jsonrpc 插件绝对路径由 launcher 用 JS 写回 patch entry 的 name（§6.9）。
- ⚠️ **permission-presets 整行 config 全量替换**：approval=never + workspace-write 组合必须显式补一个 preset（workspace-write-never）并设 defaultPreset，否则报 "composed sandbox and approval defaults match no preset"。
- 无头运行注意：base 的 approval 策略 `ask` 会卡死工具调用 → override 改 `policy: 'never'`（web UI 的 Stop 按钮是用户控制手段）。
- `installFailLoud(BIN_NAME, process, release)` 第二个参数是 process 对象不是 pid。
- loader 的 AggregateError 明细在 `err.aggregateErrors ?? err.errors`（逐层 cause 递归打印才看得到）。

### 2.3 事件面 ground truth（实测 dump，序列化依据）

`session.event` 通知 params = `{ sessionId, event: { type, seq, time, data } }`：

- **user/message** data: `{ content[], source: {kind}, role, id }`。⚠️ 系统注入消息的 source.kind = `agent-instructions` / `plugin` / `skill-catalog` / `goal`（workspace 指令/运行时上下文快照/技能目录/目标轮次，或含 `<system-reminder>`/`<goal_round>`）——必须过滤，否则 UI 显示垃圾气泡。
- **assistant/message** data: `{ turn, step, message: { role, content[], id, time } }`（完整消息；content 里 reasoning/text/tool-call 块）。
- **tool/result** data: `{ turn, step, message: { role:"user", content:[{type:"tool-result", toolCallId, content[], isError}] } }`。
- **assistant/chunk** data.chunk: `block-start {index, blockType: reasoning|text|tool-call}`、`reasoning-delta {index, text}`、`text-delta {index, text}`、`tool-call-delta {index, id, name, argumentsDelta}`、`block-end {index, block}`、`usage {usage:{inputTokens,outputTokens,cacheReadTokens}}`、`finish {reason}`。
- **新版运行时换事件面**（老 0.1.1-rc.2 的持久 `assistant/chunk` 已取消）：逐 chunk 输出改发 agent scope 的
  `agent/assistant-stream`（`{agent, frame}`，frame = `start` / `chunk{index,time,chunk}` / `end`，chunk 形状与上面同构）；
  一次模型调用的 usage 只在结算时随持久 `assistant/message.usage`（`{inputTokens,outputTokens,cacheReadTokens?,cacheWriteTokens?}`）落一次。
  该直播事件 host 侧收不到 → launcher 挂的 wrapper（`runtime/goal-rpc.mjs`）在构造器里用 `{ global: true }` 订阅，转成
  `assistant.stream` 通知（`{sessionId, frame}`）；服务端 `handleAssistantStream` 与老 `assistant/chunk` 共用 `applyStreamChunk`，
  用 `conv.liveChunks` 标记互斥。底栏口径（上下文占用 / 缓存命中 / 回复速率）的纯映射 = `server/dsh/dsh-usage.ts`。
- **turn/end** data.reason：`{kind: "completed"|"max-tokens"|"error", error?: {message, code}}`。⚠️ 恢复会话时 kind="error" + message 含 "id collision"（见 §2.4）。
- **session/title** data: `{title}`。
- **agent/inbox/spliced** data: `{target, start, inserted: [messages], removedCount}`（prompt 注入；可据此清理 followUp 队列）。

### 2.4 ⚠️ 关键限制（2026-09-15 预设改造已解决大半）：会话恢复走 resume

- **同进程内多轮对话**：正常（live session 复用，turn completed）。
- **跨进程/重启后恢复**：SDK 的 agents.create 在磁盘已有同 id 时抛 session already exists（store 在 boot 时从磁盘水合）。wrapper 的 createSession 捕获后自动转 agents.resume（官方恢复路径，自动缝合被中断的 turn；setup 照跑，预设按日志记录优先挂载）—— prompt/goal/select 三条创建路径都经这里，重启后续聊不再撞墙。
- **保留的 fork 逻辑**：switch_session 只读回放（fromDisk 标记）→ prompt 自动 fork 新会话（历史作上下文注入）；turn/end 的 id collision 自动 forkAndReprompt 仍在（abort 重启后原会话不可续聊场景的兜底）。
- ds-web-ui 同样撞上此限制（Resuming a persisted session is not supported... disk log → id collision），其对策也是新建会话继续（我们多走了官方 resume，能续则续）。

### 2.5 扩展性结论（答复用户"还有 npx dsh web 的扩展性吗"）

- **agent 侧扩展性全保留**：运行时就是同一棵官方 Cordis 插件树（MCP client、subagent、goal、plan、skill、workflow、搜索全在）。
- **dsh web 的 UI 生态** 与 pi-web-ui 前端是两套界面，不互斥。
- **用户插件扩展缝（已实现，见 §4.2）**：launcher 加载 `<dataDir>/dsh-patches/*.yml` 用户 patch 层。
- pi-web-ui 自己的"插件 AI 工具"（registerAgentTool）无注入点，v1 声明不支持，二期做"工具桥" Cordis 插件。

### 2.6 ⭐ DSH 原生 goal 机制（用户拍板：goal 直接适配 DSH，不自造审查会话）

运行时树自带完整 goal 栈（base bundle 默认启用）：`dsh-goal`（状态域）+ `dsh-goal-round-driver`（轮次驱动）+ `dsh-tool-goal`（模型工具）+ `dsh-command-goal`（/goal 命令）。

- **状态域 dsh-goal**：事件源化 same-session 目标状态，`ctx.goals` 服务动词 get/create/edit/pause/resume/complete/block/clear；每次 mutation 追加 durable `goal/change` 事件（全量快照）。生命周期：active → complete | blocked | paused；激活（armed）**不持久化**，进程重启/会话 resume/fork 后 disarm，需 resume 重 arm。
- **轮次驱动 dsh-goal-round-driver**：agent idle + active armed goal + 剩余轮次 → 自动排队一条 `<goal_round>` user 消息（source.kind=goal，带 round 号）→ 模型继续干活 → 直到模型调 update_goal complete/blocked 或轮次用尽。**不需要我们驱动**。
- **模型工具 dsh-tool-goal**：get_goal/create_goal/update_goal（edit/pause/resume/complete/blocked）；goal policy 要求证据充分才 complete；blocked 需同一条件连续 3 轮（blockedAfterConsecutiveRounds: 3）。
- **⚠️ 无独立审查者（官方明确）**："evaluator-backed certification is deferred"——完成/受阻由模型自判定，不是独立审查会话。与 pi 引擎审查哲学不同，这是 DSH 的设计意图（goal 轮次 = 自动迭代，非审查-修改循环）。
- **触发方式（关键）**：JSON-RPC 面只有 initialize/session/prompt/shutdown，`/goal` 命令走 ctx.commands（prompt 直进 inbox 拦截不到）；唯一可靠触发 = **自写 wrapper 插件给 jsonrpc 加 goal RPC**（见下）。
- **goal/change 事件**：经官方 jsonrpc 的 `ctx.on("session/event")` 全量转发自然到达（含 operation/goal{phase,roundsStarted,maxGoalRounds,blockedReason}/roundsStarted）。
- **轮次消息过滤**：`<goal_round>` 是 source.kind=goal 的 user/message，必须过滤不进 UI（同时用它更新轮数显示，round 在 source.round）。
- **view 是扁平结构**：`{id,revision,objective,phase,maxGoalRounds,roundsStarted,blockedReason?,activation}`，无 goal 嵌套字段；无目标时 get 返回 undefined。
- **wrapper 插件实现**（server/dsh/runtime/goal-rpc.mjs）：import 官方 `HarnessSdkJsonRpcServer`（官方包 export 它）子类化 + handleRequest 加 goal/set|get|clear|resume|edit 分支，inject 加 "goals"，shutdown/transport 语义照抄官方 apply。launcher patch 的 sdk-jsonrpc name 指向 wrapper（官方入口经 env PI_WEB_DSH_JSONRPC_ENTRY 传进去）。
- **UI 映射**：phase active→reviewing=true/"目标进行中（第 N 轮）…"；complete→verdict=pass/"✅ 目标已达成"；blocked→verdict=fail+feedback=blockedReason；clear→清空。goal 状态 per-conversation（DshConversation.goal + dsGoal），随会话切换推 goal_status。

### 2.7 ⭐ 二期：视觉桥 + 用户提问桥 + 交互式调研向导（均实证通过）

**视觉桥**（真图片，替代 v1 文本占位）：

- DSH 附件机制：`dsh-attachment`（ctx.attachments 服务，base 已挂 attachment-local 存储后端）+ `ImageAttachmentRef`（durable，含 sha256 哈希）+ `EncodedImageAttachment`（base64 wire 格式）。image 块 = `{type:'image', attachment: ref}`。
- **仅 `deepseek-v4-flash-vision-exp` 模型支持图片**（adapter 默认目录 inputModalities: [text,image]）；flash/pro 是 text-only 路由 → 图片被省略（模型会说"只接受文本"）。DSH_MODELS 现在带 per-model vision 标记，前端据此启用/禁用图片粘贴。
- RPC：`attachment/save`（base64 → ref，调 ctx.attachments.saveImage，字节/媒体类型校验）+ `attachment/read`（ref → base64，回放补图）。模型请求侧由 dsh-llm-deepseek adapter 自动把 ref 转 file-id/inline parts。
- 接入：buildContentBlocks 的 imageData/工作区图片文件 → save → image 块；乐观消息带 dataUrl 图块；user/message 事件回放时 hydrateImageBlocks 异步读回补 dataUrl。
- 实测：vision-exp 模型准确描述项目截图（"pi-web-ui 设置面板"+ 读出 UI 文字）。

**用户提问桥**（= pi 引擎 WebUIContext 等价物）：

- DSH 机制：`dsh-user-questions`（ctx.userQuestions.ask() 阻塞等答案，registerProvider 注册 UI 侧）+ `dsh-tool-ask-user`（ask_user_question 工具，**base bundle 未挂，需 override.patch.yml 手动 insert**）。
- 桥实现（goal-rpc.mjs）：apply 里 `ctx.userQuestions.registerProvider({ ask })` → 发 `question.pending` 通知 → 等 `question/answer` RPC（带 answers/cancelled）→ 恢复工具结果。单客户端隔离（每客户端一 runtime）。取消 → reject → 工具报错 → 模型继续。
- 协议：客户端 `question_answer`；服务端 `question_pending`（questions 含 options{label,description,preview?}/multiSelect）。
- 前端：QuestionDialog.tsx（每题单选/多选 + 自由文本补充 + 提交/取消，复用 .dialog-inline 样式）。`question/detail/description/preview` 走 `Markdown(rawHtml)` 富渲染（模型可自选 markdown 或 HTML）；选中带 `preview` 的选项时展示「选项预览」框，对齐 rpiv-ask-user-question。`preview` 为可选新增，DSH 模型未发时前端回退纯文本。
- 实测：模型 ask_user_question → 浏览器收到"喜欢什么颜色 红/蓝/绿" → 答"蓝+偏深蓝" → 模型回应"你选择的是蓝（偏深蓝）"。

**交互式调研向导**（startGoalWizard 重写，替代一键设置）：

- 主会话 prompt 向导指令（wizardPrompt：用 ask_user_question 逐题提问收敛，最后只输出 GOAL: 行，禁止直接 create_goal）；conv.turnWaiter 等本轮 turn/end（提问-回答-收敛在同一轮）；解析 GOAL: 行 → setGoal。clearGoal 中断在跑的向导。
- 实测：模型连问 4 轮（交付形式/存储/功能范围/技术约束，带选项）→ 收敛 "GOAL: 在 pi-web-ui 项目新增独立待办网页应用（React+Vite，中文，localStorage 持久化）…" → 自动设目标 → round-driver 自动进第 1 轮。

### 2.8 ⭐ 三期：工具桥（插件 AI 工具注入点，⚠ 真 key E2E 实证）

把 pi-web-ui 插件经 `host.registerAgentTool` 注册的 AI 工具桥成 DSH 原生工具，让 DSH 模型能调用它们（服务端跑插件实现）。注入点 = `ctx.tools.register(defineTool({...}))`（dsh-tools 导出 defineTool，dsh-tool-goal 同款用法）。

**协议（goal-rpc.mjs wrapper，已在 transport 上并入）：**

- `tools/sync`（server→runtime）：注册/替换一批插件工具。每个用 `defineTool({name, description, parameters, output:{schema:{type:'string'}, render}, execute:trampoline})`。trampoline execute 发 `tools.call.request` 通知（带 id/name/args/sessionId）→ await；收到 `tools/call-result` RPC 后 resolve，工具结果字符串传回模型。
- `tools/list`（server→runtime）：返回 `ctx.tools.schemas()`（零 key 校验/调试用）。
- `tools/invoke`（⚠ 仅 `PI_WEB_DSH_DEBUG=1`）：绕过模型直接触发一个已注册桥接工具的完整往返，供零 key probe 验证 trampoline → 通知 → call-result 恢复。
- `tools/call-result`（server→runtime）：服务端跑完插件实现后回传 `{id, result, isError}`，恢复桥接调用（isError→reject→模型看到工具错误）。

**服务端（dsh-client.ts + dsh-agent-service.ts）：**

- `DshRuntime.onStarted`：每次成功 initialize（含初次/换模型/watchdog 重启）后，宿主 `syncPluginTools()` 把 `pluginToolsProvider()` 的插件工具注册进运行时（重 spawn 后 ctx.tools 是全新的，必须重注册）。
- `handleToolCallRequest`：收 `tools.call.request` → 按 name 在 `pluginToolsProvider()` 找工具 → 调 `tool.execute(id, args, signal)`（服务端跑插件）→ `normalizeToolResult` 归一化（`{content}` / string / object）→ `tools/call-result` 回传。
- `applyPluginAgentTools`：插件工具列表变化 → 各客户端运行时重同步。

**schema 转换**：pi 插件用标准 JSON Schema（`{type,properties,required[]}`），DSH 要 per-property 映射（`required` 挂在每条属性上）——`piParamsToDshSpec` 纯函数转换（DSH 仅支持严格子集：`type` 数组如 `["string","null"]` 映射为 `oneOf`、`anyOf` 转为 `oneOf`、`object` 补齐显式 `additionalProperties: true`、递归规整嵌套字段与去除 unsupported DSL keys，单工具注册失败异常隔离不阻断全量 sync）。

**v1 简化**：模型只见 name/description/parameters；promptSnippet/promptGuidelines/label 不上模型；onUpdate 流式部分结果不转发；无 tools_delta（DSH 不流式工具输出）；`tools/invoke` 仅调试。

**实测（真 key E2E）**：最小插件注册 `test_echo` → 模型收到指令调用它（参数 message=marker）→ 插件在服务端返回 `ECHO:<marker>` → `tools/call-result` 回传 → 工具结果与模型回复都出现在对话里。零 key probe（`dev/dsh-probes/probe-tools.mjs`）验证注册/列表/schema 转换/`tools/invoke` 往返，`tests/dsh-tools-test.mjs` 真 key 门控。

### 2.9 ⭐ MCP 工具桥（#16，真 key E2E 实证）

**直接复用 pi 的 McpBridge + #15 工具桥**，无需另起炉灶。MCP 工具本就是 `PluginAgentTool`（`adaptMcpTool`），且 `index.ts` 已把 `mcpBridge.getTools()` 并入 `pluginToolsProvider` → #15 的 `tools/sync` 会自动桥接它们。

链路：`<dataDir>/mcp.json`（`{servers:{<名>:{command,args,cwd,env}}}`）→ `McpBridge.load()` 启动 stdio MCP 服务器（NDJSON JSON-RPC）→ 握手 `initialize`/`notifications/initialized` → `tools/list` 发现工具 → `adaptMcpTool` 适配（sanitize 工具名 + inputSchema 作 parameters + execute→`McpClient.call`）→ `pluginToolsProvider()` 返回 → `syncPluginTools` 注册进 DSH → 模型调用 → `handleToolCallRequest` 跑 `execute` → `McpClient.call` 转发 MCP 服务器 → 结果 `tools/call-result` 回传模型。

**取舍**：DSH 运行时树自带 MCP client（cordis 插件），但那需要另配 mcp 定义与生命周期管理；pi 的 McpBridge 已是成熟、带日志/超时/多服务器容错的实现，且已随 `pluginToolsProvider` 自动接入。**MCP 工具与插件工具在 DSH 侧完全同形（都是桥接工具），无特判**。

**实证**：`tests/dsh-mcp-test.mjs`（真 key 门控）——fake stdio MCP 服务器暴露 `mcp_echo` → 模型调用 → `MCP_ECHO:marker` 回传模型与对话（2/2 PASS）。

### 2.10 ⭐ 技能启停 UI（#18，零 key probe 实证）

把 DSH 原生技能（`dsh-skill` SkillRegistry）暴露给前端设置面板，并让 `disabledSkills` 真正生效（运行时过滤模型可见的技能目录）。

**RPC（goal-rpc.mjs，ctx.skills 直连）**：

- `skills/list` → `ctx.skills.list()`（名称/描述/invocation）；`skills/get` → `ctx.skills.get(name)`；`skills/set-disabled` → 存服务器实例 `disabledSkills` 集合。
- `skills/register`（⚠ 仅 `PI_WEB_DSH_DEBUG=1`）→ 注册运行时技能，供零 key probe 验证 list。

**服务端**：`settings_state.skills` 从 `runtime.listSkills()` 拉取并映射成 `UiSkillInfo`（`enabled = !disabledSkills.has(name)`），缓存到 `skillsCache` 供 pushSettings 同步；`set_settings.disabledSkills` 变化时 `pushDisabledSkillsToRuntime()` 同步 + `refreshSkillsFromRuntime()` 刷新。`runtime.onStarted` 也并行刷新。

**运行时禁用（关键）**：DSH 技能目录由 `dsh-tool-skill` 的 `agent/pre-step` 钩子注入（`ctx.skills.snapshot()` → renderCatalogMessage，消息带 `source.kind='skill-catalog'` 与结构化 `source.entries`）；技能本身不支持 per-skill 排除。因此 goal-rpc 挂一个**晚** `agent/pre-step` 钩子（注册在 base 之后 → 后跑），按 `server.disabledSkills` 过滤 `source.entries` 并重建 `<available_skills>` 块（`filterSkillCatalogMessage` 纯函数，自包含 escapeText/rebuildCatalogText——**不 import dsh-skill**，因其非项目直依赖，Node 原生解析会失败）。

**取舍**：禁用走运行时目录过滤（晚钩子），而非「patch 层重配置/重启」——无需重启即生效；全部禁用时给「本会话无可启用技能」占位。模型可见性过滤由纯函数 + RPC 往返验证（端到端需种技能文件 + 模型列举，Dev 环境未纳入）。

**实证**：`dev/dsh-probes/probe-skills.mjs`（零 key）——`filterSkillCatalogMessage` 单测（部分禁用/全禁用/无操作）+ `skills/register`→`list`→`get`→`set-disabled` 往返。`settings_state.skills` 在 `refreshSkillsFromRuntime` 时填充（无技能文件时为空数组，不崩）。

### 2.11 ⭐ 浏览器 UI E2E（#23，零 key Playwright）

`tests/dsh-ui-test.mjs`（Playwright + `CHROME_PATH`，自动探测本机 Chrome）：

1. **引擎徽标**——`ready(engine=dsh)` 后 FooterBar 渲染 `.engine-badge.engine-dsh` 显示 "DSH"。
2. **目标条**——Dsh 引擎下 GoalBar 正常渲染。
3. **设置面板「界面插件」**——「DSH 用户补丁」区块展示 `<dataDir>/dsh-patches/*.yml` 文件（测试放无害 persona 覆盖补丁，验证扫描与展示）。
4. **技能页签**——显示 DSH 说明文案（`dshSkillsNote`）。

**范围取舍**：流式渲染 / 图片粘贴（vision-exp）/ 提问对话框的浏览器级渲染需真 key + 模型时序，易 flaky，由协议级 dsh 测试（`dsh-goal/question/vision`）覆盖 + 引擎无关共享组件（StreamMarkdown/QuestionDialog/image-paste）保证；本 E2E 专注 DSH 专属 UI chromium（徽标/补丁/目标条/技能说明），零 key、可进 CI。

### 2.12 ⭐ Agent 预设（dsh-web 四模式复刻，2026-09-15）

官方 dsh-web 的会话组合机制：host 只留注册表/沙箱/持久化，agent 工具全部下沉到预设 composition（standard/ptc/minimal/cordis + 用户自建），每会话创建一个挂载。pi-web-ui 此前是单全局组合（全部会话共享工具+人设），本节复刻官方语义。

- **运行时**：override.patch.yml 补 personaPrefix 修键 + code-runtime/ptcRuntime + subagent-model-selection-settings + cordis-host-runner + pi-webui-custom-prompt（独立 host section，标准/ptc/cordis 下发、minimal 压住）+ tool-ask-user（host 行保留）；agent-plane disable 全表 + roster 由服务端动态生成 dsh-preset-plane.patch.yml（原子生效，缺失回落 legacy）。
- **file: 克隆**（server/dsh/preset-clones.ts）：launcher boot 下 shipped 预设裸包名不可解析（baseUrl=config 目录），故拷贝 composition 并把裸名改写成运行时树入口文件的 file: URL（按 exports→main→lib/index.js 解析，子路径同理），roster 以 clone 目录为唯一 system 根。每次启动重生成（跟随运行时树升级），单测 tests/unit/preset-clones.test.ts。
- **wrapper**（goal-rpc.mjs）：createSession 覆写（meta.agentPreset 进 header + setup 里 mount/问卷 waterfall/技能过滤钩子/失败转 host 直连）+ 同 id 转 agents.resume + projection-prior（日志记录 > 创建参数 > 默认）；preset/list|assign|select + DEBUG 的 preset/tools、debug/assemble；minimal 下桥接工具与问卷调用期拒绝（双语错）；提问桥 P0 修法（registerProvider 已被上游删除，改 agent scope waterfall）。
- **Node 侧**：conv.agentPreset/presetLocked/assignedGen（runtimeGen 世代重登）+ 默认预设持久化（client-state）+ 回放定预设（selected 事件/header，sessionLogPreset）+ fork 继承；协议 UiAgentPreset/dsh_presets/select/default/new_chat{preset}/快照 agentPreset/会话摘要字段（纯加法，PROTOCOL_VERSION 不升）。
- **前端**：DshPresetBar（当前徽标 + 空白切换下拉 + 以此预设开新对话）+ 左栏 preset-badge + 设置预设页（默认下拉 + 名录卡片）；legacy（名录空）时整套隐藏。
- **已知限制**：自建预设写裸包名无法挂载（baseUrl 所限，名录报 broken）；host 桥接工具（插件/问卷）在 minimal 的工具目录里可见但调用被拒；问卷 waterfall 与技能过滤钩子的真 turn 递送尚未实证（无可用模型 key：deepseek 直连 key 无余额、opencode-go 网关要 x-opencode-session 头）；minimal 在当前运行时树是单持久 shell（用户 dsh-web 文案的双工具是新版，两边以运行时树为准）。
- **验证**：tests/dsh-smoke-test.mjs 新增 2.5 节（名录四预设无 broken + 快照/new_chat/切换/默认/非法拒绝）；tests/unit/dsh-sessions.test.ts；零 token 实 boot 验证（工具目录 standard27/minimal2/ptc27+run_code/cordis34、assemble section、NO_PROVIDER 通路）。

### 2.13 ⭐ 权限预设三档（官方 /permission 弹窗复刻，2026-09-15）

官方 dsh-web 的权限行：permissions projection（options + currentValue，custom 仅展示）+ /permission 命令热切换（写会话日志）+ 新会话默认（settings permission.defaultPreset）。pi-web-ui 此前是 workspace-write-never 写死（approval=never），本节复刻三档可切换。

- **wrapper**（goal-rpc.mjs）：inject 加 `permissionPresets`（⚠️ service 注册名，不是插件 id `permission`；写错则 boot 报 pending waiting for service）+ `approval`；permission/get|set RPC（set 照抄官方命令：`permission.apply(session, name, policy => approval.setPolicy(agent, policy))`，未知预设走 {ok:false} 信封；handleRequest switch 必须注册方法名，否则 unknown method）。
- **Node 侧**：conv.permissionPreset（快照 permission 字段）+ 选项表缓存 + per-client 默认持久化（client-state defaultPermissionPreset）+ 回放定权限（permission/preset 事件最后一条，sessionLogPermission）；attach/切会话/运行时启动/首轮 prompt 前拉取，首轮前把 per-client 默认热应用（一致时 apply 无事件零噪音）。
- **三档映射**：前端只提供 read-only / workspace-write-never（标“工作区内修改”）/ danger-full-access；官方 workspace-write（approval ask）无头下无应答者注定 fail closed，是死路，不提供。完全权限走内联两步确认（官方 confirm 同款语义）。
- **协议**：ClientMessage dsh_permission_set/default + ServerMessage dsh_permission{options,defaultPreset} + UiState.permission + DshPermissionOption（纯加法；PROTOCOL_VERSION 16→17）。
- **前端**：DshPermissionBar（输入框上方预设条旁边）+ 设置预设页默认下拉；legacy/未就绪（options 空）时隐藏。
- **验证**：tests/scratch/verify-permission.mjs 零 token 实 boot（get 默认 workspace-write-never + 三档切换读回 + 未知拒绝 + 幂等）。

---

## 3. 已完成的工作

### 3.1 server/dsh/ 交付物（全部文件）

```
E:/pi-web-ui/server/dsh/
├── runtime/
│   ├── launcher.mjs          # DSH 运行时子进程 launcher（boot 组合 + 事件管道 + 用户 patch 层）
│   ├── goal-rpc.mjs          # ⭐ jsonrpc wrapper 插件：goal/* + attachment/* + question/* RPC（直连 ctx.goals/attachments/userQuestions）
│   ├── runtime-root.mjs      # 运行时树解析共享模块（flat + dsh 嵌套布局）
│   ├── cordis.yml            # 空根 []（两层 patch 全在 boot patches 参数里）
│   └── override.patch.yml    # 会话根/默认模型/人设/沙箱/approval=never/permission preset/jsonrpc
├── dsh-client.ts             # DshRuntime（TS）：spawn launcher + JSON-RPC + goal RPC + kill/restart
├── dsh-serialize.ts          # 事件 → UiMessage + DshStreamAccumulator（chunk 增量）
├── dsh-sessions.ts           # JSONL 只读（zstdDecompressAll/readSessionLog/projectKey/回放）
├── dsh-agent-service.ts      # DshClientSession（协议对齐，goal=DSH 原生事件驱动）+ DshAgentService
└── （无 probe —— 人工验证探针已挪到 dev/dsh-probes/，不进发布产物）

> 开发/验证探针（`probe-mixed` / `probe-tools` / `probe-skills` / `probe-vision` /
> `probe-native-goal` / `probe-patch-seam`）现位于 `dev/dsh-probes/`（`dev/` 不入 npm 包）。
> 它们从 `server/dsh/runtime/` 取 launcher，路径已随搬家修正（见各文件里的 `DSH_DIR`）。
```

- **launcher 运行时树解析**：`$PI_WEB_DSH_RUNTIME` → 本包 node_modules → execPath 邻近 node_modules → `npm root -g`（win32 shell:true）。**支持 dsh 嵌套树**（`<root>/@deepseek-ai/dsh/node_modules`）。
- **jsonrpc 插件入口**：`createRequire(import.meta.url).resolve("@deepseek-ai/dsh-sdk-jsonrpc-server")`（主入口即可；⚠️ 包 exports 只暴露 "." 和 "./invariant"，**resolve 子路径 lib/index.js 会报 "not defined by exports"**）。
- **launcher 修复 jsonrpc 绝对路径**：loader 的 name 字段不支持 !!js → launcher 用 JS 把 env/项目解析写回 patch entry。
- **构建**：`npm run build:dsh-runtime`（scripts/copy-dsh-runtime.mjs）把 runtime 的 .mjs/.yml 拷贝到 dist/server/dsh/runtime/（tsc 只编译 .ts）；build 链已接上。

### 3.2 引擎分发 + 前端徽标

- `server/index.ts`：`ENGINE = PI_WEB_ENGINE === "dsh" ? "dsh" : "pi"`；`new DshAgentService(CWD, stateFile, DATA_DIR, getAgentDir())` vs `new AgentService(...)`；定义 `DispatchSession`（dispatch 表契约）与 `EngineService` 接口，pi/dsh 两引擎结构兼容。**agentDir 贯通**：auth.json 读写与 DshRuntime 的 key 读取都尊重 PI_CODING_AGENT_DIR（smoke 测试的临时 agent 目录才能隔离）。
- `/api/health` 返回 `engine` 字段；`ready` 消息带 `engine`。
- `server/control-socket.ts`：startControlServer 的 service 类型放宽为 `ControlService`（Pick serviceStatus/quiesce/unquiesce）。
- `server/protocol.ts`：ready 加 `engine?: string`；`dsh_patches_list`/`dsh_patches_rescan`（客户端）+ `dsh_patches`（服务端）协议消息；types.ts shim 自动同步（check:protocol ✓）。
- 前端：`web/src/use-chat.ts` state 加 `engine` + `dshPatches`；`FooterBar.tsx` 显示 DSH 徽标；`SettingsModal.tsx` 插件页签下加"DSH 用户补丁"区块（列表 + 重扫，仅 dsh 引擎显示）；i18n 加对应 key（zh/en）。

### 3.3 已验证（empirical）

- ✅ **probe-mixed.mjs 全链路**：initialize → prompt → 事件流（kinds 全）→ text-delta 拼接 "mixed tree works" → shutdown。
- ✅ **probe-patch-seam.mjs**：用户 patch 层生效（patch 把会话持久化根重定向到 marker 目录，prompt 后 JSONL 落在 marker 下）。
- ✅ **probe-native-goal.mjs**：goal/set → create+arm → **round-driver 自动续轮**（<goal_round> round=1）→ 模型 update_goal complete → goal/change 事件 → goal/clear 墓碑。DSH 原生 goal 全链路。
- ✅ **目标（DSH 原生，经 DshClientSession）**：setGoal → goal_status 流转（等待生成→进行中（第 1 轮）→✅ 已达成 verdict=pass）→ clearGoal 清空；<goal_round> 消息不泄漏进 UI。
- ✅ **launcher 单测**（dist 编译产物）boot 成功、initialize 响应。
- ✅ **DshRuntime 独立测试**：start 856ms、prompt 7ms、事件流完整；同进程多轮 turn completed。
- ✅ **真 key E2E（WS 全链路，新 key）**：ready(engine=dsh) → 真模型回复（"4；2+2 按算术规则等于 4。"）→ 原生 goal 循环 pass（"✅ 目标已达成"）→ dsh_patches 列表消息 → 会话 JSONL 持久化。全部通过。
- ✅ **系统消息过滤 + 重复去重**：user/message 只保留真正用户消息（agent-instructions/plugin/goal 过滤；重复文本去重）。
- ✅ **会话列表/切换**：list_sessions（JSONL 扫描）→ switch_session（回放 4+ 消息）。
- ✅ **历史会话续聊**：prompt 到 fromDisk 会话自动 fork + 上下文注入，模型正常回复。
- ✅ **abort**：kill 运行时 + 自动重启 + turn/end id collision 自动 fork 重发，模型恢复回复。
- ✅ **终端**：terminal_create/list/input/output（bash echo TERM_OK 回显）。
- ✅ **quiesce**：attach 拒绝抛 QuiesceRejectedError（index.ts 转 4403 close）+ prompt/newChat/setGoal 拒绝发错误 notice（含 quiesce）。
- ✅ **SCM**：scmQuery 走 FilesService（git-dir watcher → 外部提交推 scm_changed，scm-features-test 9/9）。
- ✅ **API key 管理**：set/clearProviderApiKey 对齐 pi 形状（{provider:{type,key}}）+ PI_CODING_AGENT_DIR 隔离（clear-provider-key-test 4/4）。
- ✅ **质量门**：`npm run typecheck`（server+web+tests）0 错；`npm run build` OK；`npm run test` 246 通过。
- ✅ **pi 引擎回归**：默认 PI_WEB_ENGINE=pi 未改行为（typecheck/build/单测/smoke 抽样全绿）。

### 3.5 dsh 引擎冒烟评估（PI_WEB_ENGINE=dsh，第二轮后 22/32 通过 + 2 环境跳过）

可复用（✓ 22 项）：global-search / goal-prefs / goal-test / plugin-cwd / plugin-http / mcp-bridge / plugin-settings / plugin-update / preview / quiesce / recursive-watch / scm-features / steer-queue-smoke / ssh-plugin / clear-provider-key（对齐后 4/4）/ snapshot-delta / **conv-cwd（第二轮转绿）** / **plugin-test（第二轮转绿）** / **plugin-bgtask（第二轮转绿）** / **plugin-command（第二轮转绿）** / **slash-commands（第二轮转绿）**。
不可复用（引擎差异，预期失败）：conv-cross-project / switch-session-background（依赖 pi mock provider "main/switch-session-mock"，**Windows 本地 pi 基线同样失败，非回归**）；fetch-models / refresh-models / vision-bridge（自定义 provider/视觉桥 v1 不支持）；left-panel-delete（pi 会话目录结构假设）；settings（仅剩 1 个断言：visionBridgeDefaultPrompt 非空，DSH 无视觉桥概念）。环境问题：db-client / vscode-editor（dev/plugins/ 缺失，pi 下同样失败）。

### 3.4 过程性踩坑（见 §6）

---

## 4. 下一步做什么（按序）

### 4.1 引擎主体收尾（已基本完成；goal 已改为 DSH 原生，见 §2.6）

- **目标（goal）**：✅ 完成 —— DSH 原生 goal 域（goal-rpc wrapper RPC + goal/change 事件翻译 + round-driver 自动轮次 + 模型自判定 complete/blocked）。与 pi 引擎差异（设计意图）：无独立审查会话；完成由模型自判定；locked 开关透传不映射行为（DSH 目标持续到 complete/blocked/轮尽）；reviewModel 忽略（无独立审查者）。
- **设置面板**：第二轮后全量存储回显（promptMode/customSystemPrompt/terminalToolsEnabled/terminalBash/thinkingWrap/toolsWrap/disabledSkills/disabledExtensions/disabledPlugins/reviewPrompt 经 ClientStateStore 持久化，跨重连存活）；仅 prompt 相关变化才重启运行时（DSH_PERSONA env 注入）；引擎专属设置项扩展机制（Engine-Contributed Settings）动态呈现 DSH 预设与三档权限、补丁与市场、问卷调研；通用底座设置项全量兼容。
- **视觉桥**：✅ 完成（§2.7）—— 真 image block（attachment/save + read RPC + vision-exp 模型 + 回放补图）。图片附件/工作区图片文件都走附件存储。注意：仅 deepseek-v4-flash-vision-exp 模型看图。
- **第三方自定义端点与模型接入（models.json）**：✅ 完成 —— DSH 引擎接入公共模型底座，自动枚举 `models.json` 中配置的第三方自定义端点模型（如 `antigravity-openai/gemini-3.8-flash` 等）；切换时动态解析 BaseURL 与 API Key 并注入子进程环境变量 `DEEPSEEK_BASE_URL` 与 `DEEPSEEK_API_KEY`，RPC 握手传递真实模型 ID，实现第三方 OpenAI 兼容端点在 DSH 运行时的直接调用执行。
- **Universal Agent 底座驱动化（DshAgentDriver）**：⚠️ 已退役 —— 曾尝试在 `server/universal/drivers/dsh-driver.ts` 实现 `BaseAgentDriver`，但由于 DSH 为具备 4 预设克隆挂载、独立 RPC 守护进程与原生 Goal 状态机的复合引擎（非简单单进程驱动），将复合引擎降格为轻量 Driver 存在抽象层级错配。为避免产生未经检验的第三套 DSH 运行时，该驱动已于 #733 彻底清理；DSH 与通用底座的收敛未来统一走 #469（自顶向下抽取共享 `BaseAgentService`）。
- **对话框（dialog_response）/ 扩展 UI 桥**：DSH 侧已有提问桥（question_pending/question_answer，§2.7）；pi 扩展 dialog（dialog_response）v1 仍忽略。
- **目标调研向导（startGoalWizard）**：✅ 完成（§2.7）—— 交互式（模型 ask_user_question 逐题提问 + 前端对话框 + GOAL: 收敛 + 自动设目标）。

### 4.2 用户 patch 扩展缝 ✅ 已实现

- launcher 读 `PI_WEB_DSH_DATA_DIR`（dsh-client 注入）→ `<dataDir>/dsh-patches/*.yml`（按文件名序，在 override 之后）append 进 boot patches；失败文件跳过 + stderr 日志。jsonrpc 路径写回对用户 patch 同样生效。
- 引擎方法：`listDshPatches()`（扫描 + dsh_patches 消息）/ `rescanDshPatches()`（重启运行时使新 patch 生效）。协议：`dsh_patches_list` / `dsh_patches_rescan`。
- 前端：设置面板「界面插件」页签下的「DSH 用户补丁」区块（文件列表 + 重扫按钮 + 目录提示）。

### 4.3 dsh 引擎冒烟 ✅ 已评估（见 §3.5）

- `PI_WEB_ENGINE=dsh node tests/run-smoke.mjs` 全量跑过：22/32 + 2 环境跳过（第二轮；conv-cwd/plugin-test/plugin-bgtask/plugin-command/slash-commands 转绿）；剩余失败全部归因为 pi 专属/设计差异/环境（见 §3.5 清单）。
- 真 key 手动全流程（对话/工具/会话持久化/换模型/中止）此前已验证；goal 原生循环已用真 key probe 验证。

### 4.4 已知 v1 简化项（与 pi 引擎的差异，前端可感知）

- **无逐字流式**：本机快速完成时 60ms 快照捕捉不到 streaming，但 message_delta 通道已实现（thinking/text 逐 token 走 message_delta，前端 patch streamingMessage），长响应可见流式。
- **queue 语义**：DSH 无 mid-run steering —— isStreaming 时 prompt 全部走 followUp（运行时 inbox 排队，run 结束后消费）；前端 queue 显示为"发送即清"（乐观消息 + agent/inbox/spliced 清理）。
- **工具执行状态**：tool/call（开始）+ tool/result（结束）→ tool_status 已发；无 tool_delta（DSH 不流式工具输出）。
- **后台任务**：tool/call bash → bg.snapshotBefore；tool/result bash → bg.trackAfterBash（端口 diff）已接。
- **goal 审查语义**（见 §2.6）：DSH 无独立审查者——"目标进行中（第 N 轮）…"由 round-driver 自动续轮驱动，完成/受阻由模型自判定；blocked 需连续 3 轮同条件。
- **斜杠命令**（第二轮已支持）：NATIVE_COMMANDS（new/model/cwd/resume/help/copy/reload/quit 等）+ 插件 registerCommand 全量拦截执行（prompt 前 parseSlash，非命令才发模型）；`/model` 支持动态模型目录匹配。

---

## 5. 任务清单状态

| #   | 任务                                                                                  | 状态                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 研究 DSH JSON-RPC 协议面                                                              | ✅ 完成（§2.1/§2.3 事件 ground truth）                                                                                                             |
| 2   | 通读 pi-web-ui agent-service.ts                                                       | ✅ 核心读完（快照/事件/会话/模型方法，作对齐参照）                                                                                                 |
| 3   | 通读 ds-web-ui 移植素材                                                               | ✅ 核心读完（dsh-client/serialize/agent-service JSONL 部分）                                                                                       |
| 4   | 设计 server/dsh/ + 引擎分发 + 徽标                                                    | ✅ 完成（DispatchSession/EngineService 接口 + ENGINE 分发 + health/ready engine + 前端徽标）                                                       |
| 5   | dsh 核心对话引擎                                                                      | ✅ 完成（prompt/事件折叠/快照/snapshot_delta/message_delta/tool_status/消息过滤去重）                                                              |
| 6   | dsh 会话管理                                                                          | ✅ 完成（JSONL 列表/回放/切换/删除 + fork 续聊 + id collision 自动 fork）                                                                          |
| 7   | 终端/SCM/后台任务/文件服务接入                                                        | ✅ 完成（TerminalManager/scm.ts/FilesService/BgServerTracker 复用 + WS 验证）                                                                      |
| 8   | 设置/模型配置/目标/视觉桥/插件对齐 + 用户 patch 缝                                    | 🔶 部分（**第二轮：设置全量存储回显 ✅、模型配置 v1 不支持、目标=DSH 原生 ✅、视觉桥 ✅、提问桥+交互式向导 ✅、用户 patch 缝 ✅、slash 命令 ✅**） |
| 9   | 前端徽标 + 引擎状态                                                                   | ✅ 完成                                                                                                                                            |
| 10  | typecheck/build/冒烟（双引擎）                                                        | ✅ typecheck/build/vitest 全绿；pi smoke 抽样回归绿；**dsh smoke 已评估（§3.5，22/32 + 2 环境跳过，失败全归因）**                                  |
| 11  | 二期：视觉桥（真 image block + vision-exp 模型 + 回放补图）                           | ✅ 完成（§2.7，probe-vision.mjs 实证）                                                                                                             |
| 12  | 二期：用户提问桥（question_pending/question_answer + QuestionDialog）                 | ✅ 完成（§2.7，WS 实证：提问→回答→模型回应）                                                                                                       |
| 13  | 二期：交互式调研向导（startGoalWizard 重写）                                          | ✅ 完成（§2.7，4 轮提问→GOAL 收敛→自动设目标实证）                                                                                                 |
| 14  | 第二轮：P0 稳定性（watchdog/竞态/内存回收/DEBUG/重试/提问超时）                       | ✅ 完成（§8.1 全部）                                                                                                                               |
| 15  | 第二轮：P1 体验对齐（vision 校验/设置面板/轮次检测/locked 语义/conv-cwd/保留期/搜索） | ✅ 完成（§8.2 全部；conv-cwd-test 转绿）                                                                                                           |
| 16  | 第二轮：P2 部分（模型目录动态化/fork 提示/提问排队/思考折叠）                         | ✅ 完成（§8.3 #17/19/20/21）                                                                                                                       |
| 17  | 第二轮：斜杠命令系统（NATIVE + 插件命令拦截执行）                                     | ✅ 完成（slash-commands/plugin-command/plugin-bgtask 转绿）                                                                                        |

---

## 6. 坑与备忘（避免重复踩）

1. **npm 在 bash 工具环境里会假死** —— 让用户在自己的终端跑；不要在工具里后台装大包。
2. **fnm multishell**：`npm root -g` 从 bash/node spawn 取空桶很正常；launcher 已把 execPath 邻近 node_modules 放前面。**每个 bash 命令是独立 multishell（execPath 不同），junction 路径只在当前 shell 存活**。
3. **cordis patch 语法**：id 定向替换 vs insert，错了报 duplicate loader entry id。
4. **JSON-RPC stdout 纯净**：runtime 的 stdout 只能有协议帧；任何日志都要 stderr（调试信息用 PI_WEB_DSH_DEBUG 门控打到 stderr）。
5. **中止=杀进程**：win32 用 `taskkill /pid X /T /F`；会话 JSONL 在磁盘，进程重建不丢。**abort 后原会话不可续聊（id collision）→ 必须 fork**。
6. **`.jsonl.zstd` 多帧解压**：zstdDecompressSync 只解首帧，要各帧分别解（dsh-sessions.ts 的 zstdDecompressAll）。
7. **会话目录名**：projectKey 风格（`--<cwd>--`，分隔符转 `-`，非法字符 `~XXXX`）。
8. **协议版本**：protocol.ts 加字段后跑 `npm run check:protocol`（types.ts shim 单源）。
9. **loader 的 name 字段不支持 !!js**（只插值 config）→ jsonrpc 插件绝对路径由 launcher JS 写回（launcher.mjs 的 jsonrpcEntry 解析段）。
10. **boot 的 patches 必须扁平**：`[...baseList, ...overrideList]`；嵌套数组被 applyEntryPatches 静默跳过（表现为"插件没挂上"）。
11. **permission-presets 整行全量替换**：approval=never 组合需显式 preset + defaultPreset（override.patch.yml 的 workspace-write-never）。
12. **运行时树在嵌套位置**：全局 `npm root -g/@deepseek-ai/` 只有 dsh 包；dsh-base/dsh-app-boot 在 `@deepseek-ai/dsh/node_modules/@deepseek-ai/`（runtime-root.mjs 的 runtimeBaseFor 检查两种布局）。
13. **require.resolve 子路径限制**：dsh-sdk-jsonrpc-server 的 exports 只暴露 "." 和 "./invariant"，resolve 必须用主入口。
14. **快照增量陷阱**：`emittedMessages = cur` 若保存数组引用，appendMessage push 同一数组会让 prev/cur 恒等 → slice(prev.length) 恒空 → 消息永不到前端。必须拷贝（`[...conv.messages]`）。
15. **流式时序**：本机快速完成时 60ms 延迟快照总被 assistant/message 抢跑（streaming 从未被捕捉）→ 必须走 message_delta 独立通道（text_delta/thinking_delta，与 pi SDK 的事件类型一致）。
16. **DSH 重复用户消息**：同文本 user/message 会重放 → 按文本去重；agent-instructions/plugin 过滤；**goal source 的 <goal_round> 轮次消息也要过滤**（不渲染，但用它更新轮数显示，round 在 source.round）。
17. **Windows 测试进程管理**：`pkill -f` 在 Git Bash 匹配不到 node 进程（pid 残留 + EADDRINUSE），用 `taskkill //PID <pid> //T //F`。
18. **服务器启动竞态**：DshRuntime.start() 并发调用必须共享同一 startPromise（否则重复 spawn launcher，prompt 写错 stdin）。
19. **Windows ESM 动态 import 绝对路径**：`import("E:\\...")` 报 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 必须 `import(pathToFileURL(p).href)`（goal-rpc.mjs 踩过）。
20. **dsh-goal view 是扁平结构**：`{id,revision,objective,phase,maxGoalRounds,roundsStarted,activation}`，无 goal 嵌套字段；无目标时 get() 返回 undefined（不是 {goal:null}）。
21. **goal/change 事件只在 mutation 时发**（create/edit/resume/complete/block/clear），轮次承认不发 —— 轮数显示靠 <goal_round> user/message 的 source.round 更新。
22. **auth.json 形状与路径**：pi 引擎形状 `{<provider>:{type:"api_key",key}}`，dsh 必须同形状（clear-provider-key-test 断言）；路径尊重 PI_CODING_AGENT_DIR（getAgentDir()），硬编码 ~/.pi/agent 会让测试/部署的临时 agent 目录隔离失效。⚠️ **clear-provider-key-test 会破坏真实 ~/.pi/agent/auth.json 的 deepseek key**（pi/dsh 都一样）——跑之前备份，跑完恢复。
23. **sdk-jsonrpc 插件可扩展**：官方包 export HarnessSdkJsonRpcServer/apply/Config/inject/name，可 import 子类化加 RPC 方法（goal-rpc.mjs 的模式）；inject 要加新服务依赖（"goals"）；loader 对插件文件的裸 import 走 node ESM 解析（混树安全，官方插件同理）。
24. **JSON-RPC 面无法触发 /goal 命令**：prompt 直进 inbox，命令运行时（ctx.commands）拦截不到；唯一可靠触发 = 扩展 RPC 方法直调 ctx.goals 服务动词。
25. **图片只对 vision 模型可用**：dsh-llm-deepseek adapter 默认目录仅 `deepseek-v4-flash-vision-exp` 有 inputModalities:[text,image]；flash/pro text-only → 图片被省略（模型会说"只接受文本"）。视觉标记必须 per-model。
26. **dsh-tool-ask-user 不在 base bundle**：base 只挂 user-questions 服务；ask_user_question 工具要 override.patch.yml 手动 insert（否则模型说"没有该工具"）。
27. **提问桥单 pending**：ctx.userQuestions 一个 context 只一个 provider；ask() 阻塞期间新提问报"已有提问等待回答"。前端 question_pending 只显示一个；提交前每题需 selected 或 custom 非空。
28. **附件字节校验**：attachment/save 用 saveImage（内部校验媒体类型/字节/像素上限），非 png/jpeg/webp/gif 或超限报错 → 调用方回退文本占位。
29. **Event loop 阻塞注意**：提问桥的 ask() await 挂起 agent 循环直到 answer/cancel/超时（10 分钟，PI_WEB_DSH_QUESTION_TIMEOUT_MS 可配）——前端不回答会卡住该会话，超时后工具报错模型继续。
30. **restart 竞态（旧 proc 迟到 exit）**：kill 后旧进程 exit 事件可能晚于新 initialize 到达 → exit handler 必须做 `this.proc !== spawned` 身份检查（dsh-client.ts doStart），否则旧 exit 的 failPending 会误 reject 新 initialize（报 "runtime killed (interrupt)"），且 intentional 判断错会误触发 watchdog 自动重启。
31. **设置回显字段写死残留**：dsh pushSettings 早期把 disabledPlugins/thinkingWrap/terminalBash 等写死为字面量——批次编辑被回滚后容易漏改；改完设置类回显记得 grep 确认无字面量残留。
32. **slash 拦截要 flushSnapshot**：prompt 拦截 slash 命令后必须 flushSnapshot（pi 的 exec 后同款），否则 snapshot-delta 类测试/前端拿不到命令后的增量。
33. **watchdog 与 kill 的区分**：onExit 的 intentional 由 `this.closed` 判断（kill()/close() 置 true）；意外崩溃时 closed=false → watchdog 限频重启（60s 内 2 次）。
34. **pi 插件参数是标准 JSON Schema，DSH 工具要 per-property 映射**：`required` 在 pi 是对象数组 `["x"]`，在 DSH 是每条属性上的 `required:true`——直接透传会让 DSH 编译器把 `type` 当属性名；必须经 `piParamsToDshSpec` 转换。
35. **重 spawn 后 ctx.tools 是全新的**：换模型/watchdog 重启后桥接工具全部丢失，必须靠 `runtime.onStarted` 回调重新 `syncPluginTools`（不能只在 attach 时同步一次）。
36. **工具结果须匹配 output schema**：桥接工具声明 `output:{schema:{type:'string'}, render}`，服务端归一化成字符串回传（`normalizeToolResult`）；返回非 string 会被 `snapshotToolValue`/schema 校验拒绝报 ToolOutputError。
37. **tools/invoke 仅 DEBUG**：零 key 验证完整往返（trampoline→通知→call-result 恢复）需运行时 `PI_WEB_DSH_DEBUG=1`，否则 RPC 报错；生产不可用。

---

## 7. 相关文件清单（新对话必读）

| 文件                                                     | 用途                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `E:/pi-web-ui/server/dsh/dsh-agent-service.ts`           | 引擎主体（DshClientSession 协议对齐 + goal=DSH 原生事件驱动 + DshAgentService）                |
| `E:/pi-web-ui/server/dsh/dsh-client.ts`                  | DshRuntime（launcher spawn + JSON-RPC + goal RPC + kill/restart）                              |
| `E:/pi-web-ui/server/dsh/dsh-serialize.ts`               | 事件 → UiMessage + DshStreamAccumulator                                                        |
| `E:/pi-web-ui/server/dsh/dsh-sessions.ts`                | JSONL 只读（列表/回放/fork 素材）                                                              |
| `E:/pi-web-ui/server/dsh/dsh-usage.ts`                   | 底栏统计纯映射（DSH usage → 四桶 / 上下文占用 / 日志取最后一条 usage）                         |
| `E:/pi-web-ui/tests/dsh-stats-test.mjs`                  | 底栏统计回归：假 runtime 灌直播帧/持久事件，零 key / 零子进程                                  |
| `E:/pi-web-ui/server/dsh/runtime/launcher.mjs`           | 运行时 launcher（boot 组合；jsonrpc wrapper 指向；用户 patch 层）                              |
| `E:/pi-web-ui/server/dsh/runtime/goal-rpc.mjs`           | ⭐ jsonrpc wrapper 插件：goal/set                                                              | get | clear | resume | edit + attachment/save | read + question/answer + 提问 provider 桥 |
| `E:/pi-web-ui/server/dsh/runtime/runtime-root.mjs`       | 运行时树解析（flat + 嵌套布局）                                                                |
| `E:/pi-web-ui/server/dsh/runtime/override.patch.yml`     | 组合覆盖层（permission preset 等）                                                             |
| `E:/pi-web-ui/dev/dsh-probes/probe-native-goal.mjs`      | DSH 原生 goal probe（goal/set→round-driver→complete→clear）                                    |
| `E:/pi-web-ui/dev/dsh-probes/probe-vision.mjs`           | 视觉桥 probe（attachment/save+read+vision 模型看图）                                           |
| `E:/pi-web-ui/dev/dsh-probes/probe-tools.mjs`            | 工具桥 probe（tools/sync+list 注册/列表/schema 转换 + tools/invoke 往返）                      |
| `E:/pi-web-ui/dev/dsh-probes/probe-skills.mjs`           | 技能启停 probe（filterSkillCatalogMessage 单测 + register/list/get/set-disabled 往返）         |
| `E:/pi-web-ui/tests/dsh-smoke-test.mjs`                  | dsh 引擎零 key 协议冒烟（已纳入 run-smoke ALL）                                                |
| `E:/pi-web-ui/tests/dsh-goal-test.mjs`                   | dsh goal 真 key 门控测试（set_goal→round-driver→complete→clear）                               |
| `E:/pi-web-ui/tests/dsh-question-test.mjs`               | dsh 提问桥真 key 门控测试（question_pending→answer→模型继续）                                  |
| `E:/pi-web-ui/tests/dsh-vision-test.mjs`                 | dsh 视觉桥真 key 门控测试（imageData→attachment/save→vision 模型看图）                         |
| `E:/pi-web-ui/tests/dsh-tools-test.mjs`                  | dsh 工具桥真 key 门控测试（模型调用桥接插件工具 test_echo → 服务端执行 → 结果回传）            |
| `E:/pi-web-ui/tests/dsh-mcp-test.mjs`                    | dsh MCP 工具桥真 key 门控测试（mcp.json → McpBridge 发现 mcp_echo → 模型调用 → MCP_ECHO 回传） |
| `E:/pi-web-ui/tests/dsh-ui-test.mjs`                     | dsh 浏览器 UI E2E（零 key Playwright：引擎徽标/目标条/DSH 补丁区块/技能说明，5/5）             |
| `E:/pi-web-ui/web/src/components/QuestionDialog.tsx`     | 模型提问对话框（单选/多选/自定义文本 + `Markdown(rawHtml)` 富渲染 + 选项 `preview` 预览框）    |
| `E:/pi-web-ui/dev/dsh-probes/probe-patch-seam.mjs`       | 用户 patch 层 probe（会话根重定向验证）                                                        |
| `E:/pi-web-ui/server/index.ts`                           | 引擎分发（ENGINE/EngineService/DispatchSession）+ dispatch 表 + dsh_patches 分支               |
| `E:/pi-web-ui/server/protocol.ts`                        | wire 协议唯一事实源（ready.engine + dsh_patches 消息）                                         |
| `E:/pi-web-ui/scripts/copy-dsh-runtime.mjs`              | build:dsh-runtime（拷贝 .mjs/.yml 到 dist）                                                    |
| `E:/pi-web-ui/server/agent-service.ts`                   | pi 引擎（协议对齐参照；QuiesceRejectedError 定义处）                                           |
| `E:/pi-web-ui/server/files-service.ts`                   | 文件/SCM 服务（scmQuery 带 git-dir watcher，dsh 复用）                                         |
| `E:/ds-web-ui/server/dsh-client.js` / `agent-service.js` | 移植源（JSONL 解码/事件适配参考）                                                              |

---

## 8. 后续优化路线图（用户待办，按优先级）

> 状态截止 2026-09-01（第二轮）：v1 功能齐备 + P0 全部完成 + P1 全部完成 + P2 部分完成，
> 冒烟 22/32 + 2 环境跳过（conv-cwd/plugin-*/slash-commands 转绿）。以下按「影响 × 成本」排序。

### 8.1 P0 — 稳定性 / 健壮性（✅ 全部完成）

| #   | 项                                | 状态与实现                                                                                                                                                                                                                                                                             |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **runtime 崩溃自动重启 watchdog** | ✅ `DshRuntime.onExit` 带 intentional 参数（kill/close 主动 vs 意外崩溃）；`handleRuntimeExit` 限频自动重启（60s 内最多 2 次，超限升级 error notice）；重启前复位全部 conv 的 streaming；旧进程迟到的 exit 事件不再误伤新 initialize（dsh-client 的 `this.proc !== spawned` 身份检查） |
| 2   | **setModel / abort 竞态**         | ✅ setModel 前检测活跃 run → 发 warning notice（"有对话正在运行，切换模型将中止当前所有运行"）                                                                                                                                                                                         |
| 3   | **convs 内存回收**                | ✅ 5min 定时 + newChat 触发 `reclaimIdleConversations`：非 active/非 streaming/无终端，未 listed 闲置 >30min、listed 闲置 >24h 回收（JSONL 在磁盘可回放）；setCwd 切项目时同步回收旧项目未列出会话                                                                                     |
| 4   | **PI_WEB_DSH_DEBUG 门控**         | ✅ dsh-client 加 `PI_WEB_DSH_DEBUG=1`：RPC 帧（-> / <-）、exit/kill/restart 生命周期打到 stderr                                                                                                                                                                                        |
| 5   | **start 失败重试**                | ✅ `startWithRetry`：1s/3s/9s 指数退避，最终失败才发 error notice（create 与 watchdog 共用）                                                                                                                                                                                           |
| 6   | **提问桥超时配置 + 前端倒计时**   | ✅ `PI_WEB_DSH_QUESTION_TIMEOUT_MS`（默认 10min）；question_pending 带 deadline；QuestionDialog 显示倒计时 + 归零自动取消（questionTimeout/questionTimeoutExpired i18n）                                                                                                               |

### 8.2 P1 — 体验对齐（✅ 全部完成）

| #   | 项                                     | 状态与实现                                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | **图片粘贴 vision 校验**               | ✅ ChatInput `currentModelNoVision()`：当前模型在 models 清单中 `vision === false` 时拒绝粘贴/拖拽/上传图片并提示（modelNoVision i18n）                                                                                                                                                                                           |
| 8   | **设置面板空列表**                     | ✅ DSH 下 skills/extensions 空列表显示说明文案（dshSkillsNote/dshExtensionsNote）；vision tab 隐藏；presets/disabledPlugins/terminalBash 等设置真实存储回显（ClientStateStore 持久化，跨重连存活）                                                                                                                                |
| 9   | **reviewPrompt / visionBridge 无效项** | ✅ vision tab 在 DSH 下隐藏（真图片直通 vision 模型）；review 区块显示 DSH 语义说明（dshReviewPromptNote）；reviewPrompt 仍存储经 DSH_PERSONA 注入                                                                                                                                                                                |
| 10  | **GoalBar 轮次用尽检测**               | ✅ applyGoalChange + `<goal_round>` 事件：round >= maxGoalRounds 且仍 active → status "已达轮数上限（N/M），目标未完成"                                                                                                                                                                                                           |
| 11  | **locked / reviewModel 语义**          | ✅ setGoal 里 locked=false → maxGoalRounds 强设 1（单轮近似）；locked=true 保留用户轮次；GoalBar 在 DSH 下隐藏 reviewModel 下拉（dshNoReviewModel 说明）                                                                                                                                                                          |
| 12  | **conv-cwd 冒烟对齐**                  | ✅ setCwd：notice 文案对齐（"已切换到工作目录"）、listFiles 主动刷新、pushProjects、旧项目 conv 回收；emitConversations 列 listed + 当前对话（有内容时，issue #140；空白对话不入列）；switchConversation 跨项目时切 cwd + 重启运行时。**conv-cwd-test 全过**（conv-cross-project 依赖 pi mock provider，pi 基线同样失败，非回归） |
| 13  | **会话 JSONL 保留期清理**              | ✅ `PI_WEB_DSH_SESSION_RETENTION_DAYS`（默认 90）：启动 10s 首清 + 每 24h 幂等清理（目录内最新文件 mtime 判活跃，JSONL 追加写不更新目录 mtime）                                                                                                                                                                                   |
| 14  | **session 搜索增强**                   | ✅ searchSessions 索引纳入 tool-result 的嵌套工具输出文本                                                                                                                                                                                                                                                                         |

### 8.3 P2 — 新能力

| #   | 项                             | 状态与实现                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | **工具桥（插件注入点）**       | ✅ 完成（§2.8）—— RPC `tools/sync` 注册（pi JSON Schema → DSH 参数映射）+ `tools/list` 校验 + `tools/call-result` 回传；trampoline execute 发 `tools.call.request` 通知 → 服务端跑插件实现 → `tools/call-result` 恢复。goal-rpc.mjs 并入（已有 transport）；`applyPluginAgentTools` 重同步 + `runtime.onStarted` 在每次启动后自动注册。真 key E2E 实证（模型调 test_echo → 插件回显 `ECHO:…` → 模型回复）                                       |
| 16  | **MCP 桥**                     | ✅ 完成（§2.9）—— **走 pi 的 McpBridge + #15 工具桥**：`<dataDir>/mcp.json` → McpBridge 启动 stdio MCP 服务器 → `adaptMcpTool` 把远端工具适配成 `PluginAgentTool` → 经 `pluginToolsProvider`（含 `mcpBridge.getTools()`）自动流入 #15 的 `tools/sync` 桥 → 模型调用 → `McpClient.call` 转发 → 结果回传。真 key E2E 实证（fake MCP 服务器 `mcp_echo` → `MCP_ECHO:marker`）。取舍：未用 DSH 本机 MCP client（那是另一套配置/生命周期，收益边际）  |
| 17  | **模型目录动态化**             | ✅ goal-rpc.mjs 加 `model/list`（ctx.llm.listModels）+ dsh-client.listModels + listModels 合并本地表（定价/上下文/vision 标记）与动态目录；setModel 校验含 dynamicModels。⚠️ 本轮修复隐藏 bug：goal-rpc 的 `inject` 缺 `"llm"`，导致 `ctx.llm.listModels` 报 `cannot get property "llm" without inject`，动态目录从未真正生效（本地表恰好 3 个模型掩盖了错误）——已补 `inject` 加入 `"llm"`                                                      |
| 18  | **技能启停 UI**                | ✅ 完成（§2.10）—— 新增 skills/list + skills/get + skills/set-disabled RPC（直连 `ctx.skills` SkillRegistry）；`settings_state.skills` 塞入真实 DSH 技能（enabled 由 disabledSkills 推导）；禁用集推送运行时，晚 `agent/pre-step` 钩子按 `server.disabledSkills` 过滤 skill-catalog 消息（自包含重建 `source.entries` + `<available_skills>` 块，不 import dsh-skill）。纯函数 `filterSkillCatalogMessage` 单测 + 注册/列表/禁用往返 probe 实证 |
| 19  | **fork 会话的目标迁移提示**    | ✅ forkConversation 检测原 conv 有 active goal（verdict=pending）→ notice 追加"原目标已随旧会话存档，如需继续请重新设置目标"                                                                                                                                                                                                                                                                                                                    |
| 20  | **提问桥并发排队**             | ✅ goal-rpc.mjs askUser 排队（深度 3，满则 reject），answer 后 `dispatchNextQuestion` 自动发下一个；一次只向浏览器展示一个                                                                                                                                                                                                                                                                                                                      |
| 21  | **流式 UI 增强（思考块折叠）** | ✅ 复用 ThinkingBlock 折叠（pi 同款）；根因是 dsh pushSettings 把 thinkingWrap 写死 true → 已改为 settings.thinkingWrap 默认 false（与 pi 一致），长思考默认折叠                                                                                                                                                                                                                                                                                |

### 8.4 测试与交付

| #   | 项                           | 现状                                                                                                                                                                                                                                                                                                                         | 方案 |
| --- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 22  | **dsh 专属冒烟套件**         | ✅ 完成（§8.6）—— `tests/dsh-smoke-test.mjs` 零 key 协议冒烟（已纳入 run-smoke ALL），`tests/dsh-goal-test.mjs` / `dsh-question-test.mjs` / `dsh-vision-test.mjs` 真 key 门控（无 key SKIP 退出 0）。⚠️ 顺带修复 P2-17 隐藏 bug：goal-rpc inject 缺 `llm` 导致动态模型目录从末真正生效（本地表恰好 3 个模型掩盖了错误）      |
| 23  | **浏览器 E2E（playwright）** | ✅ 零 key UI E2E（§2.11）—— `tests/dsh-ui-test.mjs`：引擎徽标（DSH）/目标条/设置面板「DSH 用户补丁」区块（扫 dsh-patches 展示文件）/技能页签 DSH 说明文案，5/5 通过。流式/图片粘贴/提问对话框的浏览器级渲染由协议级 dsh 测试（goal/question/vision）覆盖 + 引擎无关共享组件（StreamMarkdown/QuestionDialog/image-paste）保证 |
| 24  | **部署文档**                 | ✅ 完成（§8.7）—— `docs/deployment.md` 新增「引擎选择（pi / DeepSeek Harness）」章节（PI_WEB_ENGINE / DSH 运行时树 / 环境变量速览 / 用户补丁层 / systemd+launchd env 示例）；`Dockerfile` 加全局 dsh 运行时树安装；`docker-compose.yml` 加 DSH 注释。`docs/env-vars.md` 此前已含 DSH 变量                                    |

### 8.5 已知取舍（不打算改，除非用户要求）

- **无逐字流式**：message_delta 通道已实现，60ms 快照节流是设计使然（pi 同款）。
- **queue = 发送即清**：DSH 无 mid-run steering，isStreaming 时 prompt 走 followUp，前端乐观消息即时入流。
- **无独立审查者**：goal 完成/受阻由模型自判定（DSH 官方设计）；blocked 需连续 3 轮同条件。
- **abort = 重启运行时**：所有会话的运行一起停（DSH 协议面无 per-session close）。
- **模型配置表单 / 自定义 provider**：DSH 引擎只有内置 deepseek 模型，v1 明确不支持。

### 8.6 dsh 专属冒烟套件（#22，本轮完成）

把原先的临时 probe（mixed / native-goal / patch-seam / vision）转成正式 `tests/*-dsh-test.mjs` 用例，零 key 部分纳入 run-smoke，真 key 门控部分独立跑（无 key 打印 SKIP 退出 0）：

| 文件                          | 门控   | 覆盖                                                                                                                                                                                                                                                                                                                                                 | 状态                              |
| ----------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `tests/dsh-smoke-test.mjs`    | 零 key | ready.engine=dsh、初始推送（conversations/goal_status/settings_state/slash_commands/snapshot）、dsh_patches 列表、list_sessions、list_models（本地表+动态目录合并）、set_settings 回显+重连持久化、agent 预设（dsh_presets 默认/切换/改默认/非法拒绝）、权限三档（dsh_permission_set/default）、slash 拦截（/model /cwd）、terminal echo、scm_status | ✅ 全绿，**已纳入 run-smoke ALL** |
| `tests/dsh-goal-test.mjs`     | 真 key | set_goal → goal_status 进行中 → round-driver 自动续轮 → 模型自判定 complete → clear_goal 清空                                                                                                                                                                                                                                                        | ✅ 3/3，~3s                       |
| `tests/dsh-question-test.mjs` | 真 key | 模型 ask_user_question → question_pending → question_answer → 模型收到答案继续回复（text_delta）                                                                                                                                                                                                                                                     | ✅ 3/3                            |
| `tests/dsh-vision-test.mjs`   | 真 key | set_model vision-exp → imageData 附件 → attachment/save → 模型看图回复                                                                                                                                                                                                                                                                               | ✅ 1/1                            |
| `tests/dsh-tools-test.mjs`    | 真 key | 插件 registerAgentTool → 模型调用桥接工具 test_echo → 服务端执行 → ECHO:marker 回传模型与对话                                                                                                                                                                                                                                                        | ✅ 2/2                            |
| `tests/dsh-mcp-test.mjs`      | 真 key | mcp.json → McpBridge 发现 mcp_echo → 模型调用 → MCP_ECHO:marker 回传模型与对话                                                                                                                                                                                                                                                                       | ✅ 2/2                            |

**踩坑记录**：

- **用户 patch 文件不能 insert 重复的 dsh-session entry**（与 base bundle 的 `sessions` service 注册冲突 → boot 失败，表现为 initialize 报 `cannot create effect on inactive context`）——冒烟测试改用 probe-patch-seam 验证过的无害 persona 覆盖。
- **WS wait helper 超时必须从 waiters 移除自己**：超时后 stale pred 留在队列里会静默消费后续新消息，导致循环等不到真正目标状态——dsh-goal/qu estion/vision 的 connect 都内置了 `waiters.indexOf(entry)` 移除。
- **DSH text_delta 是逐字推送**（每个 delta 长度 1-2 字）：判定不能 `delta.length > 3`，要累计拼接判断（`repliedText.length >= 4`）。
- **message_delta 字段是 `assistantMessageEvent`**（`{type, contentIndex, delta}`），不是 `delta`。
- **Vision 测试 set_model 后要等 8s**（换模型=重启运行时 + vision boot），等 5s 不够。

### 8.7 部署文档（#24，本轮完成）

- `docs/deployment.md` 新增「引擎选择（pi / DeepSeek Harness）」章节：PI_WEB_ENGINE 切换、DSH 运行时树需求（`npm i -g @deepseek-ai/dsh@0.1.1-rc.2`）、DSH 环境变量速览表、用户补丁层（dsh-patches）、systemd/launchd 服务环境变量示例（`Environment=` / `EnvironmentVariables`）。
- `Dockerfile` runtime 阶段加 `RUN npm i -g @deepseek-ai/dsh@0.1.1-rc.2`（镜像自带 dsh 运行时树，`npm root -g` 可解析）。
- `docker-compose.yml` environment 加 DSH 注释（`PI_WEB_ENGINE` / `PI_WEB_DSH_PATCH_DIR` 示例）。
- `docs/env-vars.md` 此前已含全部 DSH 变量（第 19-25 行），无需改动。
