# 界面状态与样式

前端的可见契约：本轮计时、完成通知（网页 / 手机 / 桌面定位）、侧栏历史会话加载、项目排序、工作树入口、消息操作、随手问小窗，以及主题、CSS 分层与中央列几何。跨端协议与状态内核见 [`architecture-core.md`](architecture-core.md)，运行态见 [`architecture-runtime.md`](architecture-runtime.md)。

## 目录

- [本轮对话计时](#本轮对话计时)
- [协作完成通知](#协作完成通知)
- [手机系统通知与多设备](#手机系统通知与多设备)
- [桌面通知定位对话](#桌面通知定位对话)
- [侧栏历史会话加载](#侧栏历史会话加载)
- [项目（工作区）排序](#项目工作区排序)
- [工作树入口](#工作树入口)
- [对话协作工具兼容](#对话协作工具兼容)
- [消息操作](#消息操作)
- [安静模式（issue #956）](#安静模式issue-956)
- [HTTP 请求（`web/src/api-client.ts` 单源）](#http-请求websrcapi-clientts-单源)
- [随手问独立小窗](#随手问独立小窗)
- [主题切换](#主题切换)
- [CSS 分层（`@layer guard, base, theme, drawer;`）](#css-分层layer-guard-base-theme-drawer)
- [中央列几何（消息列与输入框永远等宽对齐）](#中央列几何消息列与输入框永远等宽对齐)

## 本轮对话计时

底部 `host:working` 使用 `UiState.turnTiming` 的服务端时间戳：消息开始投递时启动，工具调用、插队和自动重试沿用同一时钟；本轮结束或停止时记录 `finishedAt`，保留最终用时，下一轮重新开始。快照显式下发 `null` 清空无计时的会话，避免切换对话残留。前端每秒刷新显示，完成后停止定时器；计时文本独立于可隐藏的状态标签，以兼容窄屏布局。

## 协作完成通知

pi 引擎的 `steeringMode` 与 `followUpMode` 默认均为 `all`：在各自交付点将当前队列按入队顺序一次全部送达。设置页分别提供开关，关闭对应项后使用 `one-at-a-time`，适合逐轮处理独立任务。偏好由 Web UI 配置持久化，修改立即更新全部存活 pi 会话；新建、恢复及 SDK reload 后通过统一会话覆盖入口重放，不写入用户的 pi CLI 设置。其他引擎保持各自队列语义。

每个运行对话以 Conversation 对象绑定唯一 `exec-UUID` 身份，通信地址复用该身份；父子关系在派发时一次绑定父对象，`cN` 仅作持有方局部显示编号。过户保留对象与身份，只改变持有方及显示编号，禁止维护全局 `cN → cN` 别名。完成通知队列、父子请示、项目祖先解析、任务依赖和等待展开均使用稳定身份；父对话关闭后身份失效，即使编号被复用也不重绑。旧编号只允许本地或全局唯一解析，歧义时返回不可用。完成通知只投递原父对话，关闭后降级为系统 Notice。身份只在进程内运行生命周期有效，不持久恢复旧对象或过期地址。

完成提示音、桌面通知和结束播报使用独立的工作状态边沿：`isStreaming || completionPending`。`completionPending` 在活动快照和运行会话摘要中发布，包含排队 steering/follow-up、提示投递窗口，以及子代理通知的聚合等待和异步投递；不会改变 `isStreaming` 的输出语义。子代理通知在异步结算工作树和投递期间持续占用待办计数，投递完成或失败后通过父对话当前持有方刷新状态。连续续跑直到队列排空才触发一次完成通知，前台、后台均适用。

## 手机系统通知与多设备

React + Capacitor 手机客户端、Hub 账号隔离推送与设备切换见 [`mobile.md`](mobile.md)。手机通知由服务端 `onNotificationEvent` 权威事件触发，不依赖 WebSocket sinks；重试、压缩、人工等待与子任务依赖未收口时不得提前报告完成。

通知点击携带实例、设备、session 与 owner / conversation 标识。跨客户端通过 `open_shared_conversation` 的 `readOnly: true` 查看原执行对象，快照的 `sharedConversation.readOnly` 驱动只读 UI；服务端只允许查询及已有问卷 / 单次审批答复，拒绝 prompt、终端、设置和工作区写操作。该模式可查看 independent / 子代理，但不放宽普通共享入口，也不搬迁 owner 或重新 load 会话。

共享视图不抢左栏行操作：`dismiss / rename / pin / persist_conversation` 指向的不是当前共享会话时不算共享操作——本端会话交回本端分发，跨端 elsewhere 行由 `daemon.dismissConversation` 路由（`server/index.ts` 门面必须接线，否则 ✕ 静默无效）；只读共享仍只放行 viewer 自己持有的会话。行角标的分叉身份同理要跨重启：`forkFrom` 只在内存，客户端判角标必须同时看 `forked`（引擎从会话文件头 `parentSession` 推出）与历史行的 `parentSessionPath`，否则重开/别处运行的分叉会话会掉成普通行。

## 桌面通知定位对话

`web/src/notify.ts` 在创建通知时固化目标会话的 `#s=<sessionId>` 深链；后台完成和后台问卷显式传入各自的稳定 `sessionId`，避免用户切换对话或等待 Service Worker 注册期间通知目标漂移。链接沿用部署子路径，移除 `token` 和 `view` 查询参数，鉴权沿用 Cookie。通知继续不设置 `tag`，避免 Windows 静默替换旧提醒。

`web/public/sw.js` 的 `notificationclick` 优先唤起已显示目标会话的同源应用窗口，再通过 `pi-web-ui:notification-click` 消息让页面复用现有深链路由切换会话；没有应用窗口时直接打开目标深链。已有页面无需重载，接收点击时退出群组或其他页面并显示聊天；连接尚未就绪时由现有待处理深链机制延后切换。普通 `new Notification()` 回退也通过同一订阅入口处理点击。目标 URL 与窗口必须位于应用同源和部署作用域内，旧通知缺少目标时回到应用入口。

验证：`tests/unit/notification-click.test.ts` 覆盖前后台目标固化、Worker 缺失或失败后的页面通知、消息订阅与清理、已有窗口转发、新窗口深链、子路径及同源边界；`tests/unit/session-url.test.ts` 维护深链格式和稳定会话标识契约。

## 侧栏历史会话加载

项目内会话顺序由 `web/src/conversation-order.ts` 维护页面生命周期内的统一记录，历史行与活动行共用排序。首次加载以服务端最新历史摘要完成初始化，允许它替换预热缓存中的旧时间；初始化完成后冻结排序依据，刷新页面才重新加载最新顺序。后续新发现的会话追加到末尾，只有用户成功发送消息（含插队、排队与附件消息）才将对应会话移到所属项目全部会话顶部。流式输出、工具调用、子代理创建/结束、后台通知、问卷、错误、修改时间更新、常驻标记或打开/切换会话均不触发重排。

界面 `appSend` 为 prompt 附带只在前端传递的 `userInitiated` 上下文；`useChat.send` 在 WebSocket 发送成功后更新顺序，插件直接调用发送器或显式关闭该上下文时不置顶，空白或未连接发送也不置顶。原生 CLI 只消费 `native_cli_prompt_submitted` 窄事件（Claude/Codex `UserPromptSubmit`、Pi `input(source=interactive)`），按 session 与 eventId 去重；终端输出、普通按键、粘贴和 working 状态都不能替代用户提交信号。

会话 ID、sessionId 与文件路径关联到同一位置，保证活动/历史表示切换、重新打开或过户后保留顺序。子代理保持父子树（含工作树子代理），向子代理直接发送消息时整体提升所属父树。顺序只保存在页面内存，不写入存储；项目排位见「项目（工作区）排序」。

## 项目（工作区）排序

项目顺序与「最近对话」时间解耦，事实源：`server/client-state.ts` 的 `remember(clientId, cwd, { promote })` 与 `web/src/project-order-settings.ts`。

- **时间只认真实对话**：`promote`（默认）只在真的发消息时调用（pi `ClientSession.prompt`、`dsh` 与 `universal` 的 `prompt`），刷新该项目 `lastUsed` 并推 `projects`。浏览/切换/恢复（`set_cwd`、`switchConversation`、打开历史对话、连接时恢复 `lastCwd`）一律 `{ promote: false }`：只写 `lastCwd`、清 tombstone，未登记的补一条 `lastUsed: 0`，不动时间；`withCurrentCwd()` 也不再给当前项目打时间戳。否则「只是点开看看」会把项目顶到最新，下次加载顺序就变了。
- **磁盘 mtime 不参与排序**：`mergeDiscoveredProjects()`（扫盘发现历史里才有的项目）只登记**没登记过**的项目，用其磁盘 mtime 当初始排序值；已登记项目的 `lastUsed` 一概不改写。会话文件的 mtime 会被流式输出、持久化、压缩、打开重写刷新，拿它顶 `lastUsed` 就等于「切到别的项目的对话」会把那个项目顶到最上面（跨项目切换对话会 `invalidateProjectsCache()` 触发一次扫盘，症状因此表现为「有时切对话项目顺序就变了」）。回归：`tests/unit/client-state-recent-projects.test.ts`。
- **客户端两种模式**（localStorage）：自动模式（默认）按 `lastUsed` 降序，`lastUsed === 0`（从没对话过）回退到「本浏览器首次出现时间」，所以新添加的项目天然在最上方；手动模式（设置「项目顺序全靠手动」）只认持久化的拖拽/添加顺序，新出现的项目置顶，聊天不再重排。拖拽或 Alt+↑/↓ 会自动切到手动模式。切模式不跳变：自动模式持续把当前顺序镜像进存储，手动模式直接接手眼前排列。
- 项目行右侧时间只在 `lastUsed > 0` 时显示；验证：`tests/unit/left-panel-stage-d.test.ts`、`tests/unit/left-panel-actions.test.ts`、`tests/unit/left-panel-open-conv-order.test.ts`、`tests/unit/client-state-recent-projects.test.ts`。相邻项目节点之间使用主题边框色分隔线与间距，分隔范围覆盖整个会话子树。

「运行中对话」（`conversations`）和「历史会话」（`sessions`）是两个通道，但常常指向同一批会话，左栏必须把它们认成同一条，否则同一条会话会渲染成两行。分工：**行归属由引擎裁定、身份由客户端归一**。

- 行归属：`ConversationSummary.rowKind`（`packages/keel/src/conversation-rows.ts`★ 单源）—— `open` = 对话自占一行（运行中 / 等回答 / 子代理 / 固定 / 临时 / 原生 CLI / 未落盘），`history` = 已由历史行代表。三个引擎（pi `agent-service`、claude/codex `universal`、`dsh`）都在推送前算好；客户端只读 `rowKind !== "history"`，**不再自己按 `sessionFile` / `pinned` / 磁盘索引猜**。`hasHistoryRow` 未声明时默认 `open`（宁可多一行也不让对话凭空消失）。
- 身份：`web/src/session-identity.ts` 的强键（对话 id / sessionId 或规范文件名推导的 uuid / 会话文件路径）；裸 token 的 path 视为会话 id（universal 底座就是这种形态），所以引擎即使漏发 `sessionId` 也不会重复。弱键 `fn:`（裸文件名）只用于关联状态点、未读与停止按钮，不能参与去重（不同目录可能同名）。
- 引擎侧的 `conversations` 摘要必须带 `sessionId`（= 会话 id）与 `modified`，否则客户端既认不出身份、也显示不出时间、排序也不对。

兼容分支：客户端只在**整个 payload 都没带 `rowKind`**（旧服务端 / 移动端与服务器版本错位）时走 `legacyOwnsRow()` 启发式；新版本发过后可整块删除（删除条件写在函数注释里）。协议改动同步 bump `PROTOCOL_VERSION`（单源 `server/protocol-version.ts`）。验证：`tests/unit/conversation-rows.test.ts`、`tests/unit/conversation-rows-engine.test.ts`、`tests/unit/conversation-row-declared.test.ts`（引擎漏声明即红）、`tests/unit/session-identity.test.ts`、`tests/unit/left-panel-row-kind.test.ts`、`tests/unit/left-panel-universal-dedupe.test.ts`。

验证：`tests/unit/conversation-order.test.ts`、`tests/unit/use-chat-conversation-order.test.ts`、`tests/unit/left-panel-open-conv-order.test.ts` 与侧栏搜索、折叠、操作回归。

本地对话、历史会话与“另一处”对话运行完成后，尚未查看时统一在行尾显示蓝色对勾；查看后清除该标记。所有会话状态图标（加载/运行转圈、等待问题、错误、未查看对勾）通过 `ConversationRowIndicator` 共用最右侧 14px 槽位，位于类别/预设徽标之后；显示状态图标时隐藏时间，没有状态图标时才显示时间。

刷新时会先恢复项目及展开状态，再建立连接。`LeftPanel` 只在 `ready` 且 `status === "open"` 后请求已展开项目的历史会话，且只有 `panelSend` 成功才登记已请求与加载状态；断线时清除请求记录，重连后自动补发。手动展开与自动恢复共用请求记录，避免重复请求。服务端返回空数组 `[]` 同样表示加载完成，应自动显示“暂无历史会话”，无需点击项目。

删除历史会话后同时刷新当前项目与记录所属项目的列表；所属项目从删除前捕获的运行对话或转录头确定，SSH 本机缓存路径还原为逻辑工作区 URI。列表失效会递增扫描代次并解除旧扫描的复用；失效前启动的扫描不能回写文件或列表缓存，其调用方沿用原项目与分页参数重读，避免旧 `sessions` 消息重新显示已删条目。扫描结束只清理自身仍持有的在途记录。验证：`tests/unit/native-cli-conversation.test.ts` 与 `tests/unit/session-cache-bounds.test.ts`。

会话跑完一轮后按**该会话自己的 cwd** 补推一次会话列表（`ClientTurnLifecycle.scheduleSessionsPush`：首轮立刻推，600ms 内的后续轮次合并成一次尾部推送；只推客户端已请求过的项目，运行时销毁时清定时器）。内容变化只做缓存失效而不推送时，前端「运行中」分组会随着会话结束把那一行移走，左栏又没有新列表填进来——用户看到的是「对话跑完就消失了，点一下项目才回来」；若改成推迟到节流窗口结束再推，中间的空窗就是可见的闪烁。当前内核在 `TurnRunner` 的 streaming 归位边界先启动刷新，再通知宿主推运行列表；连接期首推与前端 `list_sessions` 都会登记项目请求。验证：`tests/unit/session-list-refresh.test.ts`。

置顶归属由**会话文件 header 的 `cwd`** 决定，不是由「当前在哪个项目里点的钉住」决定：`pinSession()` 先 `readCwdFromSessionHeader()` 再记账，预打开置顶会话前再用 `pinnedPathsOwnedBy()` 按归属过滤一次。在项目 A 的视图下钉住属于 B 的会话，记录落在 B 名下；历史上钉错项目的脏数据（`client-state.json` 里同一路径挂在两个 cwd 键下）也会被这层过滤拦住，不会把 B 的会话预打开进 A。验证：`tests/unit/pin-session-cwd.test.ts`。

钉住 / 取消钉住后要按**会话自己的 cwd 推一次 `sessions` 摘要**：历史行上的 📌 来自摘要里的 `pinned`（`isSessionPinned()` 现算），`emitConversations()` 只刷新运行中与活动行、不动摘要——不推的话取消钉住后图标得等点一下项目重新拉列表才消失。`setConversationPinned()` 推 `conv.cwd`；`pinSession()` 在记账用的 `pinCwd` 与当前 `cwd` 不同时改推 `pushSessionsForCwd(pinCwd)`。验证：`tests/unit/pin-badge-refresh.test.ts`。项目的展开/收起状态持久化在 `pi-web-ui:lp-expanded-projects`：刷新时**完全按记录恢复**，只有「首次使用、没有任何记录」才展开当前项目，`currentCwd` 变化的 effect 在首帧不动作（否则收起来的项目一刷新又自动弹开），之后切换项目才自动展开。钉住的历史行在项目收起时仍然显示（`isPinnedRowVisible()`；刷新后一直是收起状态、从没展开过的项目也要挂载子节点，并且不受 `maxVisible` 截断），否则一收起项目它就从左栏消失，钉住等于没钉。历史行的右键菜单按**该行自己的 `pinned`** 判断显示「钉住」还是「取消钉住」：跨项目的历史行不在当前项目的 `sessions` 列表里，只查列表会永远显示「钉住」（点下去还会再钉一次）。验证：`tests/unit/pin-badge-refresh.test.ts` 与 `tests/unit/left-panel-actions.test.ts`（跨项目历史行用例）。

侧栏子代理树从一级开始每层缩进 12px，有无子代理的行使用相同标题基线，层级仅通过缩进表达，不绘制连接线。折叠按钮使用细描边箭头并随深度同步右移；图标为 12×12px，独立点击区域为 18×24px，与标题保持 2px 间隔，提供悬停及键盘焦点反馈。运行中和其他客户端的对话树共用同一布局，按钮通过 `aria-expanded` 表达展开状态。层内样式与 `styles.css` 末尾结构复位规则保持一致，避免主题或选中态覆盖缩进。

跨项目历史读取统一走 `pushSessionsForCwd`。UniversalSession（Claude/Codex）按请求项目读取存档并应用该项目的标题与分页限制，返回 `sessions.cwd` 和每行 `cwd`；读取不会切换当前工作区或覆盖活动对话列表。`use-session-list-requests.ts` 按项目跟踪回执，20 秒未返回时显示可重试状态；其他项目的回执不能结束本项目的加载。断线和引擎切换清理旧请求，重连后重新读取已展开项目，迟到的有效回执可恢复列表。验证见 `universal-session-list.test.ts`、`left-panel-session-loading.test.ts`。

## 工作树入口

Git 工作树通过顶栏 `host:worktrees` 项目入口显示数量与未提交改动状态点，不再自动弹出或常驻警告横幅。入口参与统一布局及溢出菜单，点击切到 `worktrees` 页内视图；列表展示主仓库、当前工作树、完整分支名与路径，长文本换行。切换操作等待服务端 cwd/currentPath 确认后返回聊天，失败不提前退出；移除收在每项管理详情，确认后沿用非强制删除。

`useWorktreeRefresh` 独立于详情页挂载，通过 `refresh_worktrees` 请求重新检测服务端事实：页面可见时每 30 秒一次，窗口重新聚焦或页面恢复可见时立即刷新；隐藏页面暂停检测。响应绑定发起时的项目 cwd，切项目后不得发布旧项目结果。不再使用旧横幅的 localStorage 忽略状态。

## 对话协作工具兼容

对话协作只有一个工具名 `conversation`，支持子代理及持久对话；转录、文件与状态按需读取统一使用 `conversation(action="read"/"files"/"status")`，原 `conversation_read` 不再独立注册。历史别名 `subagent` 已删除：`makeSubagentTools()` 只产出 `conversation` 一个定义，前端也只渲染一个开关。

工具注册仍以 `server/tool-manager.ts` 的 `AGENT_TOOL_CATALOG` 为事实源。旧存档里的 `subagent` 与 `subagent_*`（`LEGACY_SUBAGENT_TOOL_NAMES`）在 `normalizeDisabledAgentTools()` 里折算成 `conversation`，因此老预设的禁用状态依旧生效，但不会复活成独立开关；`toolPromptOverrides` 里的旧 `subagent` 覆盖同样在归一化时并入 `conversation`。

## 消息操作

消息操作栏的提示应悬浮即显，使用简短动作名。复制主键复制 Markdown，下拉选择其他格式。重新提问通过 `edit_message` 在当前会话移除原问题及后续内容，原样重发问题和附件；编辑后重问先打开编辑框，提交时执行同一路径。分叉通过 `fork_session { position: "at" }` 保留所选消息及之前的上下文，建立新对话且不自动发送。回退按钮打开当前问题（助手消息则定位到对应用户问题）的编辑框，提交后在当前会话重问；取消编辑不改变历史。消息回退编辑与可选工作区文件还原是独立操作。

pi 的 `schedule` 创建任务时单独持久化创建来源（稳定 SDK 会话文件 + tool call ID），不随投递目标重绑变化。`edit_message` 只撤销当前分支被舍弃后缀中创建、尚未启动的任务（包括周期和画布任务）；先原子写入调度存储，再同步提交重问分支标记。调度写失败保留原历史并停止重问；分支提交失败恢复原 leaf 和任务，恢复也失败则明确报错。开始执行前持久化 `startedAt`，只用于阻止重问撤销已尝试的外部操作，不提供跨进程恰好一次语义。普通分叉、旁支、其他会话、已启动任务和无来源旧任务均保留；未接入内置 schedule 的引擎及直接 checkpoint rollback 不在此清理路径。

## 安静模式（issue #956）

**事实源**：判定单源 `web/src/quiet-fold.ts`（纯函数，无 React / DOM / 协议）、偏好单源 `web/src/quiet-mode.ts`（localStorage，仿 `chat-width-settings.ts` 的 `useSyncExternalStore` 形态）、渲染接入 `web/src/components/MessageList.tsx`、设置入口 `web/src/components/SettingsModal.tsx`。

- 语义：每个 turn 只保留最后一条有文本的助手消息，其余压成一条 `quiet_fold` 条目；折叠行永远排在保留内容之前。turn 边界只认真实用户消息——子代理的派发 / 进度 / 完成通知在协议里是 `role: "user"` + 协作信封（`parseCollabMessage`），当成边界会把真正的最终回复判成中间消息并藏掉。轮末在最终回复之后的无文本活动（裸工具簇等）并进本轮已有折叠行；整轮只有「回复 + 尾部活动」时折叠行插到本轮开头——两处都为了守住「折叠行在前」这条不变量。
- 快捷开关：`host:quiet-mode` 在顶栏是一枚与 zen mode 同形的 flip-flop chip（`web/src/ui-slots.ts` 登记 → `BarItem.tsx` 四栏通用渲染 → `TopBar.tsx` 兜底清单 / 溢出分发 / chip 三处），点击直接翻转 `quietMode.enabled` 并落盘；设置页里的开关和两档呈现是同一份偏好的另一个入口。
- 永远保留：协作信封正文（子代理结果）、带 `errorMessage` 的消息、自定义卡片（附件 / 插件 / goal 审阅，自带 `reviewFoldKind` 语义）、`streamingId` 指向的消息（否则首字出现前打字机消失）、外部传入的 `keepIds`。
- 两种呈现共用同一份判定：`fold` 复用既有 `.msg-collapsed` 规格（角色标 + 计数 chips + 展开），`zero` 用 `.quiet-gap` 一行 12px 留白，只在 hover / focus 时露出入口。展开态 `quietExpanded` 是组件内瞬时状态，不持久化——每次进会话默认干净。
- 不变量：纯展示层开关，`UiMessage` / 协议 / `use-chat` / 服务端一条不动；被折叠的消息**不渲染**，绝不用 `display:none` 隐藏（否则主题的 `.msg-*` 结构改写、复制与搜索、滚动定位都会看到幽灵节点）。搜索与导出图片自动退出安静视图（与 `needsFullHistory` 同一条约定），保证命中项可见。
- 安静视图极小，因此 `virtualOn` 直接关掉窗口化，让 `hidden` / `pinned` / 测量 / 锚定那一整套机制整体绕过，而不是去和它协调。
- 主题零适配：折叠行与留白只用既有 class 家族（`.msg-*` / `.msg-collapsed`）和既有令牌，不新增主题变量——38 个主题（含改写 `.msg-*` 的 `aetheris` 等）一份都不用改。

验证：`tests/unit/quiet-mode-fold.test.ts`（turn 边界、协作信封、错误与流式保留、多轮独立折叠、轮末活动并入、计数与偏好归一化）、`tests/unit/quiet-mode-toggle.test.ts`（顶栏条目登记 + 两处渲染点接线 + 翻转落盘）。

## HTTP 请求（`web/src/api-client.ts` 单源）

调 `/api/*` 统一走 `web/src/api-client.ts`：`requestJson<T>(path, { body, signal })` 拿 JSON，`apiFetch(path, init)` 拿原始 `Response`（二进制 / 文本 / 自定义失败处理），两者都自带 `withToken(appUrl(path))` 与 JSON 请求体序列化。

失败回执只在这里解读一次：服务端 `{ error, code?, detail? }` 解成 `ApiFailure`（含 `serverError`、`code`、`detail`），`requestJson` 默认抛 `ApiError`（带 `status/code/detail`），需要领域错误就用 `errorFor: (failure) => new MyError(...)` 映射——`instanceof` 照旧可用。

禁令：不许再写「`res.json().catch(() => ({}))` + 自己拼 `data.error || HTTP xxx`」这套手活。各处自写的后果是同一种失败在不同面板显示成三种文案，口令/超时逻辑也改不动。存量直接 `fetch(withToken(...))` 的文件列在 `tests/unit/api-client-single-source.test.ts` 的名单里，只许变短。

## 随手问独立小窗

**事实源**：`web/src/components/QuickAskPopover.tsx`、`QuickAskAttachments.tsx`、`web/src/use-draggable-popover.ts`、`web/src/quick-ask.ts`、`web/src/quick-ask-context.ts`、`server/quick-ask.ts`、`server/quick-ask-context.ts`、`server/model-session.ts`；设置 UI 为 `web/src/components/QuickAskSettings.tsx`，独立设置单源为 `packages/keel/src/quick-ask-settings.ts`。

- 右下角常驻入口支持鼠标 / 触屏拖动，轻点或按 Enter / Space 打开默认位于右下角的轻量浮窗；拖动松手不会误触打开，窗口缩放后入口保持在视口内。在消息正文选中文字后的「解释 / 翻译」入口也打开同一小窗。标题栏空白、图标与标题支持鼠标 / 触屏拖动，按钮和语言选择器保留原有操作；拖动时收起更多菜单，入口与浮窗各自保存位置到当前页面内存，收起再打开及新话题沿用位置，刷新恢复默认。指针捕获保证移出标题栏后继续拖动；窗口缩放、浮窗内容展开或流式增高时重新约束位置，保持浮窗在视口内。采用「一句即懂」紧凑布局：宽度上限 320px，高度随内容变化，标题与选文合为一行；回答与小窗历史始终直接渲染完整 Markdown，长内容在回答区内滚动，不截断预览，也不提供「展开 / 收起回答」步骤。选文点击后展开，追问框按需出现；空白新话题自动显示输入框，手动追问保持输入框可用。标题栏直接显示「新话题」加号，一次点击清空当前问答并取消生成；完整回答复制、当前模型信息与独立对话说明收进「更多操作」浮层；菜单复用 `useFloatingPanel`，支持视口边界定位、点击外部与 Esc 关闭。完整回答阅读区最高 290px，流式、停止或错误时保留可直接阅读的正文，停止与重试均可直接操作。正文保持 14px 并使用主题令牌，窄屏不放大为全宽卡片。小窗无背景遮罩，点击或滚动主对话不会关闭，也不改变主对话草稿、消息和阅读位置；Esc 或关闭按钮收起。
- 普通提问在小窗内连续追问，提供代码示例和一句话总结快捷追问；历史仅保留于当前页面内存。真实模型文本增量按动画帧合并渲染 Markdown；停止或失败保留已收到的文本，重试从当前问题重新生成。仅当用户停留在问答区底部时跟随新内容，上翻阅读不被拉回。收起后保留历史、草稿和阅读位置且请求可继续；完成后入口显示提示点。页面刷新清空。「新话题」清空历史并取消正在生成的请求；点击「解释」同样开启新话题，避免前次问答影响解释。
- 设置 → 随手问（所有主对话引擎均可用）采用 A「紧凑分组」：基础、划词翻译、附件与引用、提示词 / 模板四组卡片；模型与思考、目标语言与风格并排，引用范围按需展开，三个提示词只展开一个编辑器。切换、收起、失焦或卸载编辑器均保存草稿；恢复默认只作用于对应模板。设置弹窗外层负责拉取快照，内容组件仅在快照就绪后挂载，避免首次加载的空快照改变 Hook 调用顺序。默认跟随当前模型；主引擎模型与独立 SDK 不兼容时，使用首个可用 SDK 模型，明确配置失效则报错。思考为 `off`，系统提示词为空，解释模板为 `解释下: {{input}}`。关闭常驻入口仍可通过选中文字解释或翻译进入。
- 划词翻译默认启用，目标语言 `auto` 跟随界面语言，支持自然、直译、技术三种风格；选中的原文始终显示在提问气泡里（气泡即用户消息本身，不再有「展开原文」开关）。翻译模板只对 `{{input}}` 与 `{{targetLanguage}}` 做字面替换，选文里的美元符号或模板字样不被二次插值。结果卡头可临时改目标语言并重新请求，不改变保存的默认目标。每次解释或翻译都从新话题开始，取消未完成的引用快照，不将上次小窗问答带入新选文。请求失败时网络级错误（`Failed to fetch`）统一转成可读提示，不再把浏览器原始报错丢给用户。
- 小窗底部附件按钮支持上传文本 / 图片、选择本地文件夹以及显式引用当前对话。操作行另有一个「当前对话」开关（仅在有进行中的对话时可用）：打开后立即取一次快照挂成引用标签，之后每次提问前重取最新快照，并用 `stripQuickAskAttachment` 把同一来源的旧副本从历史里挤掉，保证每轮只有一份最新上下文（默认关闭，不改变「不自动携带主对话」的默认行为）；再点一次开关或移除标签即关闭。会话、文件、文件夹和正文文件路径的右键菜单提供「引用到随手问」；内置条目复用 `contextmenu.session` / `contextmenu.file` 的 hidden/order，引用入口可关闭。右键时固化目标 ID、owner、sessionFile 或 path/cwd，异步过程中不回读 active。引用显示为可移除标签，超过两项折叠；添加引用不触发提问、不改主对话草稿。
- `POST /api/quick-ask/context` 接收 `{source, scope?, clientId?}`：源可为文件、目录、显式会话，或 `{kind:"upload", name, data:base64, mimeType?}` 上传。返回 `{attachment}` 文本 / 图片快照；仅提取用户和助手正文，不包含 system、工具、预设或主会话提示词，读取不切换会话。会话默认最近 10 条，可选完整对话；目录默认清单，可选清单与文本，限制深度 2、100 项并跳过 symlink。源 ID 按规范来源稳定生成，重复引用去重；上传按名称与内容生成 ID。上下文读取支持取消和 15 秒超时；远程 SSH 工作区当前返回明确的不支持错误。
- `POST /api/quick-ask` 接收小窗自己的 `messages: [{role: "user" | "assistant", content: string, attachments?: QuickAskAttachment[]}]` 与可选 `fallbackModel: "provider/id"`。附件仅允许挂在用户轮次；首次使用或内容改变时发送快照，未变化的追问引用不重复消耗预算。旧轮次快照保持不变，移除待引用标签不重写旧轮次。每个话题最多 8 项附件，单文本 32,768 字符、含来源边界的总文本 65,536 字符；单文件 / 图片 2 MiB、图片合计 6 MiB。文件编码和图片魔数统一在服务端校验，未知二进制、图片不受模型支持或超限均明确报错。
- 这是主会话附件 path-only 规则的局部例外：随手问不创建 AgentSession、没有文件读取工具，因此仅对用户明确添加的引用读取有限快照，并作为对应用户消息中的不可信参考文本 / 图片块交给独立 ModelRuntime；绝不提升成 system，也不会自动扫描或附加当前主对话；唯一的例外是用户显式打开的「当前对话」开关：它同样只把快照放进对应用户消息，快照刷新失败时就地提示、问题照常发送。
- `/api/quick-ask` 默认返回 `{text, model}`；客户端以 `Accept: application/x-ndjson` 请求真实流式输出，事件单源为 `packages/keel/src/protocol.ts` 的 `QuickAskStreamEvent`：`start` 提供模型，`delta` 追加文本，`done` 提供权威最终文本，`error` 终止流并报告错误。响应带 `no-transform` 与 `X-Accel-Buffering: no`，防止压缩或代理缓存增量。客户端使用增量 UTF-8 解码，缺少终止事件视为失败；中途错误保留先前片段。服务端仅从独立设置读取系统提示词和模型参数，直接调用 ModelRuntime 的流式接口，不创建 AgentSession，不隐式读取主对话历史、预设、项目提示词或工具。因为绕过了宿主会话，`sessionId` 必须自带（`server/model-session.ts` 的 `modelSessionId()`：同一话题传首条用户消息作种子，跨轮保持同一路由与缓存；一次性调用不传种子），否则 opencode / opencode-go 网关缺 `x-opencode-session` 头会直接 400 `MissingSessionID`。客户端取消与超时均中止请求，包括已经发送响应头后的超时；被取消的旧响应不能写回新话题。
- `GET /api/quick-ask/models` 从同一个独立模型运行时返回 `{models: [{provider, id, label}]}`，供所有主引擎下的小窗设置选择模型，避免依赖 Pi 专有的子代理模型列表。模型目录请求同样支持取消与超时。
- 未显式添加引用时，主会话只提供默认模型 ID。选中文字入口通过 `openQuickAsk` 事件发送文本快照，按独立解释模板插值后作为首条用户消息，不携带消息 ID、工具结果元数据或主会话提示词。

验证：`tests/unit/quick-ask*.test.ts`（设置、模板、流式、菜单、快照边界、预算、图片与取消）、`tests/unit/quick-ask-context-switch.test.ts`（「当前对话」开关：开启即取快照、每轮刷新且只留最新一份、关掉/移除标签后不再携带）、`tests/quick-ask-ui-test.mjs`（桌面 / 移动端，入口与标题栏拖动、拖后防误触、轻点与键盘打开、位置保留与视口边界，A 设置保存恢复、翻译切换、真实文本 / 图片上传、文件 / 文件夹右键、当前对话显式引用、去重与重置隔离）；原有主对话引用流程保留在 `tests/quote-selection-ui-test.mjs`。

## 主题切换

- **机制**：`web/src/styles.css` 是**共享基线**（默认深色主题 + 全局布局，抽离出来只为方便复用，不是对主题的限制）；主题文件是**完整样式表**，可覆盖任何东西（`:root` 变量、任意选择器、布局改动、自带新 token 皆可——主题 link 后加载，在层叠中胜出）。选主题时前端注入 `<link id="theme-stylesheet" href="/themes/<id>.css">`（`web/src/theme.ts` 的 `applyTheme`，localStorage 键 `pi-web-ui:theme`，`main.tsx` 首帧前应用防闪烁）。唯一硬性要求：`var()` 引用的 token 必须在某处有定义（主题自带定义也算，见下“变量必须先有定义”）。
- **服务端**：`GET /api/themes` 列主题（`server/themes.ts` 的 `listThemes`），`GET /themes/:id.css` 发文件（`resolveThemeFile`，用户目录优先）。id 必须匹配 `ID_RE`（`^[A-Za-z0-9_-]+$`）防路径穿越。两个路由在 `server/index.ts` 注册于 SPA catch-all 之前（否则被吞返回 index.html）。dev 模式 Vite 需在 `web/vite.config.ts` 代理 `/themes`（已加）。
- **主题来源**：内置 `<pkgRoot>/themes/*.css`（随 npm 包分发，`package.json` files 白名单含 `themes/`）；用户自定义直接往 `<dataDir>/themes/` 丢 CSS 文件即可（id 冲突时用户覆盖内置）。`pkgRoot` 经 `resolvePkgRoot()` 向上找含 package.json 的祖先解析，dev(server/) 与 prod(dist/server/) 均正确。
- **浅色主题**：`themes/white.css`（显示名「白色」：纯白底 + GitHub 蓝强调）与 `themes/paper.css`（显示名「暖纸」：暖纸米黄底 + 赭石强调，护眼）与 `themes/mist.css`（显示名「雾蓝灰」：雾蓝灰底 + 天青蓝强调，冷淡风）与 `themes/sakura.css`（显示名「樱粉」：粉白底 + 樱粉强调，柔和风）与 `themes/md-preview.css`（显示名「紫晕」）+ `themes/cyberpunk.css`（赛博朋克）+ `themes/dazzle.css`（炫彩）均由 `scripts/make-light-theme.mjs` 从 `styles.css` 的 `:root` 变量清单生成**纯调色板文件**（生成器读 styles.css 解析全部变量名，主题只覆盖差异值，仅输出与宿主默认值不同的 `:root` 变量 + 可选公共样式 import / 非布局 tail：white/paper/mist/sakura 带 `.hljs` 浅色高亮覆盖、md-preview 带 body 渐变 + chrome 透明）。styles.css 新增共享变量后主题自动继承；重跑 `node scripts/make-light-theme.mjs` 更新调色板派生值。相同的底栏结构集中在 `themes/bases/statusbar-flat-base.css`，生成器保留对应 import，避免手工补丁在重新生成后丢失。
- **开关状态契约**：插件、设置/MCP/定时任务、设备中心共用 `styles.css` 的开关外观规则，各页面只保留尺寸和滑块位移。每个内置主题显式声明 `--switch-bg-off`、`--switch-border-off`、`--switch-knob`、`--switch-bg-on`、`--switch-border-on`、`--switch-knob-on`；开启滑块按底色选择深/浅色，禁止页面自行使用强调色或写死白色。生成器始终输出这六项（即使等于默认值）；`switch-theme.test.ts` 检查全部主题两态滑块对比度 ≥3:1。
- **主题显示名**：css 首行 `/* theme-name: 中文名 */` 即为下拉里的显示名（`listThemes` 读文件头 300 字节解析），缺省回退文件 id——文件名必须是 ASCII（id 校验 `ID_RE`），中文靠这个标记。第二行可选 `/* theme-name-en: English Name */`（英文 UI 用，无则回退中文名）；两行都由 `scripts/make-light-theme.mjs` 生成，手改主题文件头会被下次重跑覆盖——改英文名要改生成器。
- **面板收起/展开按钮对照色（issue #100）**：`.panel-collapse-btn` resting 态即带底色 + 边框（与窄屏顶栏 `.panel-toggle` 同级），前景/底/边框走专用 `--control-fg/--control-bg/--control-border`（默认取正文次级色而非 `--text-faint`），展开条 `.panel-rail` 加宽到 26px、图标套「药丸」底——在浅色/自定义主题下也不再隐形。主题可独立覆盖这三个变量；浅色默认值在生成器的 `LIGHT_DERIVED` 里。
- **聊天背景图/壁纸（issue #100）**：`--bg-image: none`（主题可写成 `url(...)` 自带一张）+ `--bg-image-dim`（`--bg` 压暗不透明度，默认 0.78）+ `--bg-image-blur`。`body.has-wallpaper` 时 body 全屏铺两层 fixed 壁纸：`body::before` 放图（cover 居中 + 模糊）/`body::after` 压暗；`.app` 抬 z-index 1 到壁纸之上，消息区/输入区透明直接见壁纸。**容器背景优先**：顶栏/底栏/左右面板背景是独立变量 `--topbar-bg`/`--statusbar-bg`/`--panel-bg`（默认 `color-mix` 半透明 → 壁纸从两侧与顶/底栏下透出），主题把某变量覆盖回实色（如 `var(--bg-elev)`）即关闭该区壁纸、设 `transparent` 即完全透图；统一透图率调 `--wallpaper-panel-alpha`（默认 62%，越小透图越多）。同层还有两类组件底板：卡片级 `--card-bg`（工具调用卡 `.toolcall`、快捷短语 `.quick-chip`、新对话提示词模板卡 `.empty-template`、展开条 `.panel-rail`、全部消息气泡 `.thinking`/`.bashblock`/`.skillcard`/`.attachcard`/`.queued-bubble`/`.retry-notice`）与控件级 `--chip-bg`（顶栏 `.chip`/`.tb-tab`/下拉菜单 `.dd-menu`、goalbar 收起态提示 `.goalbar-hint`、折叠钮 `.panel-collapse-btn`、代码面 `.codeblock pre`/`.termline`/`.toolcall-output pre`、工具参数块 `.toolcall-args pre`），默认同样半透明、共用 `--wallpaper-panel-alpha`，主题可单独覆盖回实色；整块聊天面板（`.main`：消息区 + goalbar / 问卷面板占的那一段 + 输入区）共用 `--msgs-bg`（同式半透明，气泡立在统一玻璃面上略实一层形成层次，覆盖回 `transparent` 恢复全透）。**只涂在容器上**：消息区 / 输入区 / goalbar / 问卷面板再各自上色的话，元素之间的间隙与列外区域会露裸背景 —— 浅色与壁纸主题下就是一条横跨整个面板、比聊天区差一档的带子（goalbar 一出现特别明显），所以 goalbar 与问卷面板不带自己的底色（只留边框与投影）；无壁纸时两层 `display:none`，且背景变量默认半透明叠在纯色上色差极小。输入框盒子 `--inputbox-bg` 默认与 `--chip-bg` 同式跟随 `--wallpaper-panel-alpha`。下拉弹窗（声音/语言/主题/模型/思考强度等 `.dd-menu`）背景走 `--menu-bg`：默认跟随 `--chip-bg` 半透，两个透明主题覆盖回 `var(--bg-elev2)` 实色保密集列表可读。终端视图读 `--term-bg`（xterm canvas + 容器）：默认实色不参与（终端可读性优先），半透明主题可覆盖成 `color-mix` 半透明随整体透图。内置「半透明」主题（`themes/translucent.css`）专配壁纸：`--wallpaper-panel-alpha: 45%` 整体统一容器色（顶栏/底栏/面板/卡片/控件/输入框全部联动）+ `--term-bg: color-mix(#0b0d12 45%, transparent)` 终端也透 + `--bg-image-dim: 0.72`，不配壁纸时观感偏暗属预期。「全透明」主题（`themes/transparent.css`）是极致版：`--wallpaper-panel-alpha: 0%`（全部 color-mix 表面 = transparent，含 `--term-bg`），只留边框与文字；文字靠压暗加重（`--bg-image-dim: 0.85`），尾段把实色 hover/浮动反馈（菜单项、折叠摘要、展开条、折叠键、复制键、滚到底按钮）统一改 25% 半透底保可用性，并再减一层代码面噪音：`--code-border: transparent` / `--code-pad: 0`（工具参数块 `.toolcall-args pre`、工具输出块 `.toolcall-output pre`、终端行 `.termline` 的边框与内边距）＋隐藏与卡头重复的终端图标 `.termline-icon`。代码面边框/内边距走 `--code-border`/`--code-pad`（默认 `var(--border-soft)`/`8px 10px`），卡片正文内边距 `--card-body-pad`（思考块 `.thinking-body` 与工具卡 `.toolcall-body` 共用 `4px 14px 12px`，保证同一条消息里两种卡片文字左缘对齐）。用户自定义地址存浏览器 localStorage（`pi-web-ui:wallpaper`，`web/src/wallpaper.ts`：URL 白名单 http(s)/blob/data:image/站内相对路径，内联变量覆盖主题，`useWallpaperEffect` 在 App 顶层应用并监听主题切换重算）， UI 在设置 → 消息显示（地址框失焦/回车提交，压暗/模糊滑杆即时预览；也可点「上传图片」选本地文件——复用粘贴图片管线等比缩 ≤1568px + 重编码为 data: URL 存 localStorage，上传失败/过大时行内提示；data: 图不回填输入框，下方缩略图即表示生效中，清除按钮同时清掉地址与预览）。
- **变量必须先有定义（幽灵 token 陷阱）**：`var(--x)` 引用一个全仓没有任何 `--x:` 声明的自定义属性，按规范是 guaranteed-invalid —— 整条声明在计算值阶段失效（不带 fallback 的 `background` 直接**没有背景**；`box-shadow` 连投影与聚焦光环一起丢；带 fallback 的静默用硬编码值，浅色主题下必是深色块）。`--bg-elev1`（正确名是 `--bg-elev`）全史未定义却被 10 处引用，goalbar 因此一直没有填充。新增/改名变量后跑 `tests/unit/css-tokens.test.ts`（静态体检：扫 `web/src` + `plugins` + `themes` + `web/index.html` 的每个 `var()` 引用，带 fallback 的也查；运行时注入的变量与刻意写的中性兜底在该测试的豁免表里登记并写明理由——新增豁免要一并写理由）。
- **终端跟随主题**：xterm 画布经 `web/src/theme.ts` 的 `buildTermTheme()` 读 `--term-*` 变量，主题切换时 `TermXterm.tsx` 监听 `pi-web-ui:theme-change` 事件用 `term.options.theme` 热更新画布；CSS 容器 `.term-main` / `.term-xterm .xterm-viewport` 用 `var(--term-bg)`，与画布自动融合。styles.css 改动后重跑 `node scripts/make-light-theme.mjs` 重新生成。
- **按钮状态契约**：普通按钮统一用 `--button-bg/fg/border`、`--button-hover-bg/fg/border`；实底主按钮统一用 `--button-primary-bg/fg` 与 `--button-primary-hover-bg/fg`；危险按钮用 `--button-danger-bg/fg` 与 `--button-danger-hover-bg/fg`。主题优先覆盖成对变量，避免重复复制组件选择器。主按钮默认保持悬浮文字/底色配对，以外圈提示悬浮，禁止整体 brightness 滤镜同时改字与底。发送/停止的悬浮底色分别配 `--on-send-blue-hover` / `--on-stop-red-hover`，不能假设普通状态前景仍可读。`node tests/theme-buttons-test.mjs` 无需构建或启动服务，在真实 Chrome 中逐主题验证十类按钮普通/悬浮态的最终层叠与透明背景合成，对比度下限 3:1；无 Chrome 明确 SKIP，已加入全量冒烟。
- **回归**：`theme-test.mjs`（端口 8937，隔离 data-dir）：列表/内置/用户主题、注入 link、浅色生效、刷新持久、用户主题可应用、回默认移除 link。

## CSS 分层（`@layer guard, base, theme, drawer;`）

- **为什么分层**：`web/src/styles.css` 是共享基线、主题是后加载的完整样式表，两者在同一份文档里争权重。分层重构前，能跨文件夺权的唯一手段就是 `!important`（叹号 important）：基线 218 处、主题侧 613 处（`bases/obsidian-base.css` 220、`bases/zhujian-base.css` 143、`bases/zhupi-base.css` 132、`aetheris.css` 118），主题要压住基线只能继续加码，越改越沉——典型的军备竞赛。改成显式分层 + 无层覆盖区后基线只剩 1 处（mermaid 运行时内联 style，见下），胜负由**层序**决定，叹号 important 不再是夺权工具。
- **四层职责**（顺序声明只有一处：`web/src/styles.css` 顶部的 `@layer guard, base, theme, drawer;`，早于所有层块，层序按此固定）：
  - `@layer base`：整份基线样式（`web/src/styles.css` 内容）。默认层，正常写选择器，不加 `!important`。
  - `@layer theme`：主题样式。**服务端统一下发**——`server/themes.ts` 的 `readThemeCss()` 内联展开 `@import` 后把整份文本包进 `@layer theme { … }`（只包最外层一次；递归内联的子文件原样返回，否则会变成嵌套层）。`themes/**/*.css` 源文件因此**不需要**自己写 `@layer`，也不需要 `!important`：只要写在主题里就天然压过 base。
  - `@layer drawer`：底部面板与源码管理面板（`web/src/drawer.css`，经 `@import … layer(drawer)` 引入）。它排在最后，因此能压过 base 里的同名规则，**不必靠复合类提权**；新增组件层只能追加到这个位置之后。
  - `@layer guard`：唯一活口是 mermaid——它用 d3 `.style()` 把字号写成 SVG 内联 `style`，任何普通声明都压不住，只能留这一处叹号 important（`styles.css` 末尾，写明原因）。guard 先声明，层序反转后它的 important 恒胜。别把普通样式挪进来偷懒。
- **无层覆盖区**（`styles.css` 末尾、所有层块之后）：需要盖过主题或未分层三方库（highlight.js `github-dark.css`，bundle 里后加载）的结构性复位放这里——代码行清零（同为无层后靠更高权重盖过 `pre code.hljs`）、折叠态 `.goalbar.goalbar-collapsed` 抹皮（无层一句盖住 theme 层面板皮）、xterm 视口底色（`xterm.css` 的 `#000` 会把终端底部漏成一条黑边，层内写同属性是空转）。**未分层的普通声明永远胜过任何层内的普通声明**，所以这里不需要叹号 important。分包引入的 CSS（如 `web/src/model-management.css` 经 `@import … layer(base)`）与插件样式同样必须进层，不能裸奔成无层。
- **层序规则（两个方向相反，最容易踩）**：普通声明按**层声明顺序**后者胜（`theme` > `base` > `guard`）；带叹号 important 的声明**反向**——先声明的层胜（`guard` > `base` > `theme`）。所以 guard 层的价值恰在于它**先**声明：mermaid 那一处例外放进去就能盖住运行时内联；而 base/theme 里写叹号 important 只会把自己钉死，越写越糟。另注：**未分层的样式永远胜过任何层内的普通声明**——这正是「无层覆盖区」能零提权盖住主题与 highlight.js 的原因。
- **新增样式时的规矩**：① 主题里**禁止**叹号 important，一律靠 theme 层胜出；② 基线里同层权重不够时用**复合类提权**（如 `.canvas-dropdown-item.canvas-inline-create`），不准加叹号 important；③ 要盖主题/三方库普通声明时用文件末尾**无层覆盖区**，不准加叹号 important；④ 只有运行时内联 `style`（如 mermaid）才配写，必须写明原因并收进 `@layer guard`；⑤ 主题不要再写 `#root .foo` 这类 ID 加权选择器和基线抢权重（层序已解决，残余的 ID 加权属于历史包袱，改到即删）。守卫：`tests/unit/css-layers.test.ts`（基线叹号 important ≤ 1、`themes/**/*.css` 必须为 0、层声明与 guard 位置、文档契约）。
- **视觉回归闸门**（改了任何样式都必须过）：`npm run audit:themes`（当前树截图 → `.theme-audit/current`）→ `npm run audit:diff`（与 `.theme-audit/baseline` 逐像素比对）。固定 fixture DOM（含气泡/Markdown/表格/代码/思考卡/工具卡/胶囊流/输入岛/顶栏/侧边停靠栏/快捷短语/插件图标/`hide-model-row` 紧凑模式）+ 每个主题一张图（35 个主题），单主题差异 > **0.05%** 即退出码 1。
  - 基线快照 `.theme-audit/baseline` 是「分层重构完成时」的状态（已 gitignore）。要拿**重构前**的基线只能开一个 `HEAD` 的 git worktree 再拍：`git worktree add ../baseline HEAD` → `node scripts/theme-audit.mjs --root ../baseline --out .theme-audit/pristine`。
  - 只有当差异确属「有意改进」时才允许重建基线；否则先查层序（`theme` 被 `base` 压住是最常见的错）。
- **已接受的有意差异（主题为准）**：分层后 `theme` 层恒胜 `base`，以下 4 处历史上是基线的 `!important` 赢、现在按主题样式渲染 —— 这是**定案，不是缺陷**，不要再用对齐块把它们打回旧值（zhujian/zhupi/aetheris 顶栏那组对齐块是历史特例，后续新主题姿态请以主题直出为准）：
  1. `flow` / `flow-light` / `wallpaper-flow`：`.msg-assistant` 上下 padding 取主题的 `0`（原被基线紧凑模式的 2px/4px 盖）——夹具差异 ~2.0%；
  2. `flow` / `translucent` / `transparent`：`.quick-chip.active` 取主题底色（原被基线强调底盖）——差异 ~0.5%；
  3. `aetheris`：`.chip` 圆角与 `.bar-item` 内边距取主题值；
  4. `wallpaper-obsidian`：插件图标 `.plugin-icon-svg` 颜色取主题值。

## 中央列几何（消息列与输入框永远等宽对齐）

- **唯一事实源**：`.main` 上的四个 token —— `--chat-pad`（列最小左右留白：桌面 20px / 手机 14px / 宽屏聊天列 260px）、`--chat-max`（列宽上限 860px；宽屏聊天列设成 `100%` 取消上限）、`--chat-rail`（提问导航条让位，桌面 48px）、`--chat-inset = max(--chat-pad, (100% - --chat-max) / 2, --chat-rail)`。消息列、输入框、goalbar、`/` 命令菜单、扩展问卷面板一律只用 `--chat-inset`（`.inputbar` 用它做左右 padding，子元素全是自适应宽度），**不允许**再出现 `max-width: 860px; margin: 0 auto` / `calc(100% - Npx)` 这类逐元素校正——两列等宽只是同一个值的两个使用点。
- **百分比基准**：`--chat-inset` 内含百分比，只在「包含块宽度 == `.main` 内容宽」的元素上使用（`.messages` / `.inputbar` / `.goalbar` / `.dialog-inline`）；fixed 浮层（文件预览的 markdown 缩放列、`/help` 面板）自成包含块，仍走定距写法。
- **滚动容器补偿**：`.messages` 带 `scrollbar-gutter: stable both-edges`，内容盒左右各被扣掉一条 gutter，所以它用 `padding-inline: max(0px, calc(var(--chat-inset) - var(--msgs-gutter)))`（外面那层 `max(0px, …)` 是防御：负 padding 会让整条声明失效、内容直接贴边）；`--msgs-gutter` 由 `web/src/scrollbar-gutter.ts` 维护——首帧前用与 `.messages` 同设置的探针给初值（必须 `overflow-y: auto` + `stable both-edges`，用 `overflow-y: scroll` 量到的是叠加层滚动条 0px，与实际占位宽度不符，这正是历史上「消息列比输入框窄 20px」的根因），`.messages` 挂载后改用真实元素实测并覆盖，窗口尺寸变化时再校一次。
- **提问导航条让位**：`qn-rail` 钉在消息区右侧 14~38px，桌面（≥641px，rail 仅此时存在）恒定预留 `--chat-rail: 48px`，左右同时加 → 两列依旧等宽、左右边缘依旧对齐；主列够宽时（居中留白 > 48px）`max()` 取原值，宽屏观感不变。恒定预留而非「有 rail 才预留」是为了避免第一条消息发出、rail 出现时整列突然缩 28px。
- **回归**：`tests/chat-column-align-test.mjs`（多视口 × 宽屏聊天列开关 × 手机，逐一比对 `.msg` / `.msg-text` / `.msg-collapsed` / `.retry-notice` / `.inputbox` / `.goalbar` / `.slash-menu` / `.dialog-inline` 的左右边缘与宽度，并断言 rail 不压消息列）。
