# 核心架构

本文是协议与状态内核：快照驱动、协议单源、异步归属与持久化、命令 / 搜索 / 恢复状态、对话通信与任务完成、多对话并发、全局运行态与安全边界。界面状态与样式见 [`architecture-ui.md`](architecture-ui.md)，运行态（压缩投递、子代理、账本、问卷、引擎与工具桥接）见 [`architecture-runtime.md`](architecture-runtime.md)。

> 改代码前必读：跨端、运行态、审批、并发改动都先对齐本文；界面与运行态细节在分篇里。

## 目录

- [快照驱动](#快照驱动)
  - [`message_delta` 实时增量通道](#messagedelta-实时增量通道)
  - [`tool_delta` 同协议](#tooldelta-同协议)
  - [文件认领的运行生命周期](#文件认领的运行生命周期)
  - [协议版本协商](#协议版本协商)
  - [历史消息按需加载（服务端窗口化，`server/message-window.ts`）](#历史消息按需加载服务端窗口化servermessage-windowts)
- [协议单源（types.ts 是 re-export shim，不再手工同步）](#协议单源typests-是-re-export-shim不再手工同步)
- [异步归属与持久化边界](#异步归属与持久化边界)
- [命令、搜索与恢复状态](#命令搜索与恢复状态)
- [对话通信与任务完成](#对话通信与任务完成)
- [会话退役与扩展运行态（#958）](#会话退役与扩展运行态958)
- [全局运行态（app-globals.ts：不逐层传 props）](#全局运行态app-globalsts不逐层传-props)
  - [全局动作：`appSend`](#全局动作appsend)
- [安全边界](#安全边界)
- [多对话并发](#多对话并发)

## 快照驱动

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推快照（`UiState`），浏览器只按快照渲染。重连只需重发 `get_state`。
- **出帧闸单源（issue #965）**：`server/snapshot-channel.ts` 的 `SnapshotChannel` 是唯一决定「这帧发不发 / 发增量还是全量」的地方，**每个 sink（一个 WS 连接、一个共享 viewer）一份基线**。不变式只有一条：
  1. 内容键（除 `messages` 外的字段 + 消息 id 序列，**剔除 `rev`/`version` 这两个每帧自增的计数**）与本 sink 上一帧相同 → **一帧不发**；
  2. 与本 sink 上一帧构成纯追加 → `snapshot_delta`，`baseRev` 取**本 sink** 的上一帧 rev；
  3. 其余（换会话 / 非前缀变化 / 新 sink）→ 全量 `snapshot`；
  4. `deliver()` 返回 `false`（背压丢弃 / 视图切换过滤）→ 不提交基线，下一次 flush 自动补全量。

  基线挂在 sink 上而不是会话上的原因：`emit()` 是多 sink 扇出，共用一份基线时落后方必然 `baseRev` 失配 → 客户端 `get_state` → 再发一帧全量，同一份内容被连发多遍（首屏实测 4 帧 × 356KB 全量的来源）。**新增出帧路径不要再自己判全量/增量**，接 `SnapshotChannel` 就行。回归：`tests/unit/snapshot-channel.test.ts`、`tests/snapshot-frame-budget-test.mjs`（冷开 1 帧全量 + 空转 5s < 4KB）。

- **`get_state` 是 per-connection 的握手**：客户端可带 `rev`（`{ type: "get_state", rev }`），命中本连接基线且内容未变 → 不回包，落后则回增量，对不上才回全量（`respondWithSnapshot()`）；不带 `rev` 视为「我没有状态」→ 恒回全量。所以**不要**再在 attach / 切会话 / 回滚路径上写 `flushSnapshot(true)`：新 sink 本来就没有基线，第一帧必然是全量。
- **增量快照（协议 v2）**：前端 reducer 按 rev 链合并，缺口触发防抖 `get_state`；背压下 delta 与 snapshot 同样可丢弃，丢包靠 rev 链断裂自愈。**测试适配**：等「动作后快照」的测试必须同时接受 snapshot_delta（参照 conv-cwd/vision-bridge 的 rev 链合并写法）；连接后的首个快照恒为全量。
- **计算也只在生产者做一次**：`messagesOf()` 的缓存判据是「`agent.state.messages` 逐条引用未变」而不是「重算签名再比」（后者对 4000 条会话每帧全表 map + 拼几十 KB 字符串，短路发生在工作量之后）；`withHistoricalCompactions()` 用（叶指针, 条数, 数组引用）挡掉每帧一次的 `getBranch()`；`sessionStats()` 用（`getLeafId`, `getEntryCount`）做 O(1) 失效判据，**不按时间窗**猜（时间窗在「遍历多个会话」的调用形状里必然互相踢掉）。
- **插件状态推送也不重发相同内容**：`host.broadcast()` 在宿主侧按连接记指纹，内容相同的 `plugin_data` 直接跳过（新连接没有记录，首次一定拿得到）。
- **WS permessage-deflate**：WebSocketServer 开启压缩（threshold 16KB），大会话多 MB snapshot 线上传输降数倍；小消息（notice/心跳）不压省 CPU。
- **多标签页序列化共享**：emit 把同一消息对象发给客户端的所有 socket，index.ts 用 WeakMap 按对象身份缓存 stringify 结果——N 个标签页共享一次序列化，新 snapshot 即新对象自动失效。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息投影缓存（逐条引用比对）命中时复用同一个数组，前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点"低/中"看起来"改不了"）。

### `message_delta` 实时增量通道

`message_update` 事件 → 只对**活动对话**推 `message_delta`（`conversationId` + 每对话单调 `seq` + `messageId = stream-<ts>`（与 `serializeStreamingMessage` 的稳定 id 一致）+ 实时 usage + 剥离 `partial` 后的 thinking/text delta）。它**不经 snapshot 通道**——`send()` 背压只丢 snapshot（`tool_delta` 另有一条 1MB 的 socket 积压上限，见下），`message_delta` 永远可达，大会话不再因背压停更。前端 `applyMessageDelta`（`web/src/message-delta.ts` 纯函数、不可变——StrictMode 双调 reducer 会把原地 mutation 加倍）patch `streamingMessage` + `stats.tokens`；seq 缺口触发防抖 `get_state` 重同步；snapshot 权威收敛。

同时：delta 活跃期（1.5s 内有增量）snapshot 降为**事件驱动检查点**——agent_end / tool_execution_end 立即 flush，其余事件走 2s 兜底定时器（增量负责流畅度、快照只做边界校准）。单测：`tests/unit/message-delta.test.ts`。

### `tool_delta` 同协议

也带 `conversationId` + `seq`，与 message_delta 共享同一每对话单调序列（`conv.deltaSeq`）；前端按对话 Map 追踪 seq，仅活动对话缺口触发重同步（后台对话切回时 snapshot 收敛）。

它是**累积全文 + `mode:"replace"`**（每帧最多 64KB），所以 socket 积压超 `TOOL_DELTA_BACKPRESSURE_BYTES`（1MB）时服务端丢这一帧——慢客户端不控就是无界写内存。丢帧不影响最终一致：工具结束时 `tool_execution_end` 的那次快照带着完整结果。

### 文件认领的运行生命周期

`server/claim-store.ts` 的认领只覆盖一次实际运行：正常完成、最终报错、用户停止或强制重置时，`ClientSession` 按对话 ID 立即释放全部认领，无需关闭或移除对话。SDK 的 `agent_end` 可能早于重试、压缩或扩展续跑结束，尚未 idle 时保留认领，到 `agent_settled` 才释放；已经 idle 的引擎可在 `agent_end` 释放。提示词投递异常的 `finally` 和强制重置路径也负责清理。关闭对话时的清理和默认 30 分钟 TTL 作为兜底，新一轮运行需要重新认领。

### 协议版本协商

`hello` 可带 `protocolVersion`，`ready` 回带服务端版本；前端比对不一致时显示持久刷新横幅（应用原地更新后「界面新的/WS 旧的」混跑防护）。常量只有一份 `server/protocol-version.ts`，前端 `web/src/protocol-version.ts` 只做 re-export；`check:protocol` 校验它仍是单源（守卫 `tests/unit/protocol-version-single-source.test.ts`）——改协议必须 bump 这一处。

### 历史消息按需加载（服务端窗口化，`server/message-window.ts`）

前端「向上分页」只做到**不渲染**，数据仍是全量到手：实测一份 287 条 / 17MB 的转录序列化后快照 4MB，打开对话要等整份传完 + parse。所以再把窗口挪到服务端：

- **挂载点**：每连接唯一的发送漏斗（`server/index.ts` 的 `send` 外包一层 `MessageWindowTap`）。五个引擎（pi / DSH / claude / codex / durable）都经这条漏斗，引擎侧**零改动**、口径统一；将来新引擎自动继承。
- **裁剪**：`snapshot` 的 `state.messages` 裁成尾部窗口并回填 `historyStart`（窗口首条在全量里的下标）/ `historyTotal`；条数上限 `PI_WEB_HISTORY_WINDOW`（默认 300）+ **字符预算** 150 万字符（截图/tool 输出会把窗口压更短，实测同一份会话 4.00MB → 1.28MB）。`snapshot_delta` 只把新追加的并入缓存并回填两个计数。
- **翻页**：`load_earlier_messages {count|all}` → 服务端回 `earlier_messages`（新增的更早一段，客户端**前插**）。窗口起点**单调不增**：客户端翻过的页不会被后续全量快照（重连 / `get_state`）推回去。
- **不碰 `rev`/`baseRev`**：各引擎增量语义不同，改写版本号会破坏它们的自愈链；翻页只是补齐更早内容，与 rev 无关。
- **前端配合**（`web/src/components/MessageList.tsx`）：`hasEarlier` = 本地未展示 + `historyStart`；滚轮接近顶部/点「加载更早」时本地够用就本地撑开，否则向服务端要一页；打开页内搜索或「全部展开」时 `all: true` 一次拉全，保证搜得到全文。
- **兼容**：两个字段都是可选的（缺省 = 全量）。旧前端连新服务端只是少了一段历史又无从翻页，故 `PROTOCOL_VERSION` bump 到 34 触发刷新横幅。
- **回归**：`tests/unit/message-window.test.ts`（窗口起点/预算/翻页纯逻辑）+ `tests/message-window-test.mjs`（WS 报文级：首帧窗口、无缝翻页、`get_state` 不回退、`all` 到底回空页）。

## 协议单源（types.ts 是 re-export shim，不再手工同步）

`packages/keel/src/protocol.ts` 是唯一事实源；`web/src/types.ts` 用 `export type * from "../../server/protocol"` 全量再导出（纯类型，构建时擦除），前端本地类型（FileContent/FileListing/ToolStatus）附在 shim 下方。

新增/修改任何消息：只改 `protocol.ts`，然后在 `server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch 各加一个分支。注意 protocol.ts 必须保持**纯类型导出**（不能加 const/function 等运行时代码，否则破坏 type-only 前提）；`npm run check:protocol` 守护这两个不变量。

## 异步归属与持久化边界

- 编辑重问在入口捕获 Conversation/runtime，历史截断、缓存清理及实际 SDK prompt 全程使用该目标；异步恢复后验证对象仍被持有，禁止重新取活动会话。工具按稳定 SDK session 解析当前持有方，过户后审批与权限均使用新持有方。
- 工具守卫及审批等待绑定 AbortSignal，每个异步守卫/审批恢复点和执行前检查取消；取消会移除 pending 审批，不能仅扫描取消当时的待办。
- 持久化子代理和新建会话在异步初始化前预留项目名额；历史打开与派生分支提交时计入在途预留。子代理初始化失败清理已注册会话、runtime、终端和临时目录，并回收本次空工作树。
- ClientStateStore 共享设置按实际字段 patch 合并，保存成功才发布版本事件；SettingsService 订阅并串行应用运行态变更，读取冻结快照，销毁时退订。ComposerDraftsStore 按文件共享状态，避免各客户端整表覆盖。两者均是进程内协调，不支持多个独立服务进程同时写同一 data-dir。
- 设置状态推送、资源发现与运行时重载分离：`SettingsService.push()` 只读取已保存配置和当前会话内存目录，新建/切换对话不扫描磁盘、不清理配置、不触发 reload；打开设置的 `get_settings` 经 `refreshSettings()` → `refreshResources()` 显式扫描技能并清理失效偏好，只更新目录，不自动应用到运行时。设置修改和 `reload_extensions` 才走 `applyRuntime()`，流式期间延后；重载完成后刷新资源目录。外部安装/删除技能在重新打开设置后反映，运行态通过显式重载更新；目录缓存按项目 cwd 隔离。
- 原子写只允许同目录临时文件替换；重命名失败有限重试后报错，禁止回退截断原文件。设置/草稿保存失败必须反馈，内存与磁盘不得假装同时成功。
- 历史窗口携带 historyGeneration；历史重写或缓存重建使旧分页请求失效，锚点不存在/错位返回 resyncRequired，客户端请求全量同步。重复全量快照保留字符预算确定的窗口，只有翻页向前扩展。旧 socket 回调必须先验证身份，才可清理共享终端桥。

## 命令、搜索与恢复状态

- WS 握手限时 15 秒，握手消息最多 16KiB；普通控制消息最多 1MiB，附件消息沿用上传预算。attach 队列最多 256 条且累计不超过 8MiB，超限关闭连接，不静默丢弃已排队操作。限额单源为 `server/payload-limits.ts`。
- 设置保存先校验并写盘，成功后才更新运行口令。定时任务配置先持久化再发布内存及通知；运行记录写失败反馈错误，但推进内存触发时间以避免重复执行。外部副作用不保证跨进程恰好一次。
- 历史搜索与列表展示上限分离，搜索全部候选；转录按流读取，限制并发，匹配和锚点单次扫描完成，不以 256K 正文缓存决定命中。新查询取消旧查询，切项目后不发布旧结果。极大的单条普通文本记录仍需单记录内存。
- 压缩恢复状态由宿主写入 `<sessionFile>.compaction-state.json`，完成事件仅经 SDK `appendCustomEntry` 写入转录，禁止直接改写运行中的 SDK 会话文件。所有恢复入口消费中断状态，无接收端时通知进入待发队列；旧转录损坏修复仍保留。
- `terminal_output.reset` 表示历史替换；实时输出继续追加。回放前先 flush 合并中的实时输出；显示终端支持重置，SCM 解析器跳过历史替换帧。
- 插件 HTTP 代理把下游提前关闭传递到上游；上游截断终止下游，完整响应正常完成。

## 对话通信与任务完成

协作消息只在决策、阻塞、接口变化或交付时发送，普通进度合并到阶段汇报；正文优先说明变化、接收方行动及详情位置。同一发送者向同一收件人发送的完全相同正文，在收件箱未消费期间复用消息 ID，避免重复投递与唤醒；消费后允许再次发送。注入模型时使用简洁文本保留来源地址、完整正文及协作数据的权限边界，省略内部路由 JSON 和冗余 ID；结构化请求保留 requestId、完整问题及回复方式，收件箱协议保持不变。

`communicate` 统一同项目执行对话的 `send/request/reply/escalate/read`；目标支持 `parent`、`root` 和稳定对话 ID。独立 coordinator 以 Conversation 对象身份保存收件箱与问答关系，过户不重建身份。`read` 同时返回可达对话目录与稳定执行身份地址，跨页面同名对话优先使用该地址；来源 endpoint 必须贯穿投递，不得按接收方局部 ID 重新推断发送者。通信项目沿服务端登记的父子对话链解析：独立 cwd/克隆中的子代理继承仍可解析的祖先项目，受管 worktree 映射到主仓库；无关独立克隆不因仓库相同而互通，祖先不可达时回落到最后可解析对话的目录。项目标识统一经 `normalizePathKey` 规范化。消息是带来源的协作数据，不授予执行权限；宿主仍按执行对话校验沙盒和 Bot 边界，父子关系不豁免这些限制。只读子代理可通信，计划/委派审查/目标审查模式拒绝通过此工具派发工作。

`send` 返回投递或排队状态，不等待接收方处理任务；`read` 分页读取并消费自己的收件箱，熔断期间消息仍保留。`request` 等待回答，服务端限制消息字节、队列与请求数量并拒绝请求循环；参数只收纯文本 `message`（`questionsFromMessage()` 折成单个内部问题），结构化 `questions` 仍照收。`reply` 仅允许原接收对话，`message` 按待答问题展开成 `custom` 回答，旧 `answers` 结构仍照收；`escalate` 将同一 PendingQuestion 交给用户，沿用原始截止时间。`wait_all` 为待当前对话处理的请求提前返回。旧 `handoff/consult/answer/escalate` 作为兼容入口转接通信服务；历史挂起问卷保持可结算。

任务完成通过 `conversation(action="complete", summary, evidence)` 登记，与发送消息分开；证据与转录对账的规则见下一节。`spawn.notifyOnDone` 保留布尔兼容并支持 `"manual"`。manual 本轮退出但还有运行中下级、问卷、通信或待投递子结果时保持 taskPending，禁止提前通知、消费结果或结算工作树；完成登记不能绕过这些条件。所有依赖收口后使用显式 summary，未登记则以最终正文兜底。错误与取消继续通知，自动唤醒不清除手动完成意图。当前 manual 和通信宿主为 pi 引擎，Universal 明确拒绝不支持的 manual 模式。

## 全局运行态（app-globals.ts：不逐层传 props）

`web/src/app-globals.ts` 是模块级单例 store，放「**整棵树都要知道**」的少量运行态：服务端身份/能力（整个连接内只变一次）+ 连接态与当前工作目录（低频变化，靠单字段订阅隔离）：

| 字段                            | 来源                                                         | 谁在用                                                                                                             |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `engine`（`"pi"` / `"dsh"`）    | `ready.engine`（老服务端不传 → 回落 `"pi"`）                 | FooterBar 引擎图标、GoalBar/SettingsModal/ChatInput 的 DSH gating（无审查模型 / 无插件市场 / 无 mid-run steering） |
| `managed`（`PI_WEB_MANAGED=1`） | `ready.managed`                                              | TopBar 更新入口、PiSetupModal 安装引导、SettingsModal 插件市场                                                     |
| `tabs`（`PI_WEB_TABS`）         | `ready.tabs`                                                 | 顶栏视图 tab 白名单（undefined = 全部）                                                                            |
| `service`（被哪个平台服务托管） | `ready.service`（`packages/keel/src/launch-origin.ts` 探测） | TopBar 更新面板的「重启服务」按钮（缺省 = 前台/dev/Docker → 不画按钮，服务端也拒绝 `restart_service`）             |
| `appVersion` / `serverVersion`  | `ready`                                                      | TopBar 版本号                                                                                                      |
| `status` / `ready`              | useChat 的 reducer（`status` 动作 / hello+快照）             | 左栏（能不能拉清单）、ChatInput（输入框能不能用）、TopBar / FooterBar 的连接点                                     |
| `cwd`（当前对话的工作目录）     | `chat.state?.cwd`                                            | 左栏分组与「当前」标记、右栏路径拼接、全局搜索的当前项目标记、底栏目录选择器                                       |

写入点两处，都是单一来源、只镜像不复制：`use-chat.ts` 收到 `ready` 时写身份/能力（**在 dispatch 之前**同步落地，不闪一帧 `pi`）；另一个 effect 把 `ready` / `status` / `cwd` 镜像过来（值就是 reducer 里的真值，最多晚一帧 —— 对应默认值只会是「未就绪 / 未连接 / 空目录」，看不出来）。非 React 代码用 `getAppGlobals()` / `subscribeAppGlobals()`。

**读取规矩**：窄 props 的组件（`LeftPanel` / `RightPanel` / `ChatInput` / `GlobalSearchModal`）一律从全局读，不再要 prop；本来就吃整个 `ChatState` 的组件（`App` / `TopBar` / `FooterBar`）直接读 `chat.*`（自己就持有数据，没必要绕一圈）。两边的值来自同一个 reducer，不会不一致。

**订阅粒度**：只用一个字段时用 `useAppField("cwd")`（getSnapshot 只取一个字段，比较走 `Object.is`）—— `useAppGlobals()` 在任何字段变化时都会重渲染订阅者，只有确实要整对象时才用它。`cwd` 就是靠这条隔离的：切项目的通知只到真正读 cwd 的组件，不会把只读 `engine` 的组件也带上。

### 全局动作：`appSend`

发送器也放这里（下半部分）：`use-chat` 装配 `setAppSend(send)`，其他任何地方 `import { appSend }` 直接用 —— 它引用稳定、不进 state、不触发重渲染，所以不需要 hook。`web/src/App.tsx` 里因此不再有 `send={send}` 的逐层传参：对话框、弹窗、面板、插件视图、终端、SCM 全部自己取。

两点例外（故意的）：

- `LeftPanel` / `RightPanel` 的 prop 叫 **`panelSend`** —— 它们拿的是 App 的包装函数（顺手关手机抽屉的副作用），语义不同，不能换成全局发送器。
- **装配必须在 render 期间**（`setAppSend(send)` 直接写在 `useCallback` 后面，不是 `useEffect`）：子组件的 effect 先于父组件跑，放 effect 里装配会让「挂载即发请求」的弹窗（PiSetupModal / ModelConfigModal / TerminalPanel）在 `appSend` 还是空的时候调用而静默丢包。`send` 是 `useCallback([])` 的稳定引用，重复赋值无副作用。未装配/未连接时 `appSend` 返回 `false`（与 `send` 的既有语义一致）。

**两条纪律（否则会引入难查的渲染 bug）**：

1. **只放极少变化的字段**。`messages` / `state` / `settings` / `streaming` 这类快照流里的数据**绝不**放进来：`ChatInput` / `GoalBar` 等 `memo()` 组件靠「窄 props + 引用稳定」躲开流式重渲染，而 store 通知**绕过 `memo()`** 直接重渲染订阅者 —— 放错一个字段就是每个 token 重渲染一次输入框。
2. **快照引用必须稳定**：`getSnapshot()` 返回模块级 `cached`，只有 `setAppGlobals` 真正改了字段才替换对象并通知（数组按元素比、字段值相等则静默 return）—— 否则 `useSyncExternalStore` 会判定「快照每次都变」而无限重渲染。重连重放 `ready` 时靠这条不白刷一遍。

回归：`tests/unit/app-globals.test.ts`（合并语义/同值不通知/退订/回落）与 `tests/unit/question-dialog.test.ts`（组件测试改用 `setAppSend` 注入 + 记录发出的消息）。

## 会话退役与扩展运行态（#958）

- **退役是终态，不是「无记忆再跑一轮」**：SDK 的 `AgentSession.dispose()` 只给 `ExtensionRunner` 打 `staleMessage`，`sdk.js` 的 `extensionRunnerRef.current` 仍指向它，`transformContext` 只判 `if (!runner)`——于是「已 dispose 的会话被再喂一轮」时每轮全量 `structuredClone` + 每个扩展一条带栈 stale 报错（实测单会话 3,659 条 / 9.7 MB 日志 / 单核 53%）。
- **两个单源（`packages/keel/src/session-turns.ts`）**：
  - **退役**：`guardSession(session)` 在宿主接手会话时（`makeConversation` / `bindSession`）包一层 `dispose`，任何来源的 dispose 都把它记进 `retired`（WeakSet，按会话身份），并顺手清 `_extensionRunnerRef.current`；`isRetiredSession()` 是唯一判定。幂等，不吞原 dispose。
  - **会话身份**：`Conversation.session` 是 `conv.runtime.session` 的**只读投影**（接口 `readonly session` + `makeConversation` 里的 getter 读 `this.runtime.session`）：换会话只有一种写法——赋值 `conv.runtime`。`server/` 内出现 `conv.session = …` 会被守卫测试直接判红（此前两个字段可各自漂移，正是「退役会话仍被喂轮」的温床）。
  - **喂轮**：`promptSession()` / `steerSession()` / `runTurn()` 是**唯一**出口，退役即抛 `SessionRetiredError`（`code: "session_retired"`）。**server/ 内禁止直连 `sendUserMessage` / `session.steer` / `session.prompt`**，由 `tests/unit/session-turn-single-source.test.ts` 静态守卫（原 `delivery-gate-single-source` 里「直连 SDK 站点数」的上限已收紧为 0）。
  - 签名刻意**不是 async**：把 SDK 的 promise 原样返回，微任务时序与改造前一致（投递队列的假体测试按 tick 数收尾）；退役时用 rejected promise 报错，`void promptSession(...).catch(...)` 依旧成立。
- **退役窗口里的投递不丢也不谎报**：退役是**门的一个谓词**（`GateInput.retired`，#958），不是各调用点各自去 catch 的异常——`deliveryModeOf` 先把退役算成 `gated`，`ConversationDelivery` 的队列语义原样成立：意图留队（回执 `queued`），`bindSession` 结束后统一 `drainDeliveries` 重投，`steerSubagentRound` 从 `missed` 变成排队。**不**算 `closed`：force reset 里「旧 session 已 dispose、新 session 还没绑」的窗口是暂时的，判 closed 会把排队消息全丢掉；也不再去读僵尸 session 的 `isStreaming`（那是上一轮残留的读数，旧门下会让 `steer` 塞进一轮死轮）。`deliverIntent` / `deliverFromOutside` 的 `SessionRetiredError` 捕获保留作**压舱**（门判完之后、提交之前那一瞬）。唯一的例外是**用户自己刚打的那段字**：退役窗口里不排队，只给一句「正在重置，稍后重发」——这个窗口可能以 reset 失败告终（那时没有任何排空点），排了就成了一句看不见的承诺。
- **宿主侧 SDK 补丁 `server/patch-extension-runner.ts`**（`resolve-global-sdk.ts` 预加载时注册 Node 加载钩子，**只改写内存中的源码**，与 `patch-bash-process.ts` / `patch-executable-lookup.ts` 同一做法）：`dist/core/extensions/runner.js` 的 `emitContext` / `emitToolCall` 先判 `staleMessage` 直接返回（不 clone；工具调用直接 `{ block: true }`，退役会话不执行工具，也不让审批/沙箱门槛被静默跳过），`dist/core/agent-session.js` 的 `dispose()` 顺手清 `_extensionRunnerRef.current`。上游自己修好后补丁自动转 `already`；结构认不出时打 `[extension-runner]` 告警而**不**假定已修复。
- **宿主内联扩展统一 stale-safe**：`server/extension-guards.ts` 的 `staleSafe(handler, { onStale })` 是唯一入口——只吞 stale 一种错误，其它照旧抛给 SDK 的 `onError`。改请求的钩子（`context` / `before_agent_start` / `before_provider_request`）用缺省 `skip`；守卫钩子（`pi-webui-sandbox-final-gate` 的 `tool_call`）必须显式 `onStale: () => ({ block: true })` 保持 **fail-closed**。
- **扩展报错按会话去重**：`makeExtensionErrorReporter` **先判重再写日志**——计数表挂在会话上（`extensionErrorCounts`，跨 `bindSession` / reload 不重置，`removeConversation` 时清），同一「扩展 · 钩子 · 报错」首次带栈一条，之后每跨一个数量级补一条不带栈的计数行（`extensionErrorLogPlan`），键数超过 `EXTENSION_ERROR_KEY_CAP` 就重置计数防无界增长；界面通知仍只报一次。日志行数由 O(轮次) 降为 O(log n)。
- 回归：`tests/unit/session-turn-single-source.test.ts`（唯一出口 / 退役 fail-closed / dispose 幂等 / ref 清理）、`tests/unit/extension-runner-patch.test.ts`（补丁三态 / URL 识别 / 日志去重 / stale ctx 降级 / 真中止仍抛）、`tests/unit/delivery-gate-929.test.ts` 的「issues/958 · 退役窗口」组（退役算 gated、僵尸 `isStreaming` 不被相信、外部投递留队后只补投一次、用户文本只提示不排假队）。

## 安全边界

- **默认只绑 loopback**（`PI_WEB_HOST`，默认 `127.0.0.1`）：本地个人工具不暴露到网络；局域网/容器需显式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置，Docker 端口映射才能工作）。
- **WS 升级做 Origin/Host 同权威校验**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`）：Origin 存在时其 hostname+**有效端口**必须与请求 Host 一致（浏览器里 `example-host:8445` 与 `example-host:9443` 是不同源）；非浏览器客户端（无 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名单绕过（dev:server 已内置 `http://localhost:5173,http://127.0.0.1:5173`，反代场景自配）；`PI_WEB_ALLOW_HOSTS` 可选严格 hostname 白名单。**不要**加回「本地任意端口放行」——那正是提案要修的洞。
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：进入排空后**拒绝一切新工作**——新 prompt（native slash 命令例外，纯配置无 token）、new_chat、edit_message fork、switch_session、goal wizard；存量运行继续跑完。已知 clientId 仍可 attach 看存量（发 notice 提示），**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**，浏览器重连循环在 unquiesce 后自动恢复。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 经本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-web-ui-<port>`）与运行中进程通信，`status` 报告真实 socket 数（`noteSocketOpen/Close`，index.ts 维护）、active/pending 计数、quiesce 状态；无鉴权 HTTP 端点。
- **provider headers 不下发浏览器**（`models_config` 不再携带 `headers` 字段，可能含 Authorization/API key）：`saveModelConfig` 保存时若 config 无 headers 则保留旧值（`prevHeaders`）。`UiProviderConfig.headers` 已从 protocol.ts / types.ts 删除，前端没有任何地方编辑 headers（仅 apiKey 经独立消息 `set_provider_api_key` 走浏览器）。
- **内置服务商多密钥（不复制模型列表 + 纯名字通信）**：一个内置服务商（如 opencode/openai）可同时持有**多把 API key**，存于 `<agentDir>/provider-keys.json`（`{ <providerId>: { activeKeyName, keys:[{name,apiKey}] } }`），**模型目录始终复用该服务商的默认系统目录**，绝不复制进 models.json（`clone_provider` 只保留给程序化/测试路径，UI 已改为多密钥管理）。**安全**：前端**永远只拿到钥匙的**名字**（`ProviderKeyInfo={name,active}`），**原始 key 值 / 掩码片段（masked）一律不出服务端**——key 值只在添加时经 WS 上传一次落盘（同 auth.json）；`activate_provider_key`/`remove_provider_key` 都**按名字**寻址，服务端解析存储值。协议：`list_provider_keys` / `add_provider_key`（`{provider, apiKey, name?}`，名字自动去重）/ `activate_provider_key` / `remove_provider_key`，服务端回 `provider_keys`。**activeKey 与 auth.json + 运行时 override 同步**（`applyActiveKey`），切 key 后 `pushModels` 重推该服务商模型。前端模型下拉对多 key 服务商在左侧「供应商」栏**按 key 拆成多个条目**（供应商名在上、key 名在下，如 opencode 下 key1/key2 各一条，不拼接 `opencode-key2name`），**选中某 key 条目即只显示该服务商模型一次，点模型即切换激活 key** 再选模型——无需静态副本、始终最新；单 key 服务商仍显示普通单一条目。
- **内置服务商 OAuth（开放授权）登录**：`ProviderStatus` 同时下发 `supportsApiKey`、`supportsOAuth`、`oauthName` 与 `usingOAuth`，模型管理页和首次设置页据此只展示服务商真正支持的认证入口及对应账号名称。登录由服务端 `ProviderOAuthFlowManager` 驱动 SDK（软件开发工具包）的 `ModelRuntime.login`，浏览器只接收选择题、验证地址、设备验证码和进度；SDK 返回的访问令牌与刷新令牌不进入 wire 协议。每个流程使用 `flowId + promptId` 关联回复，可取消；活动流程留在 `ClientSession`，浏览器重连后通过 `provider_oauth_flows` 恢复当前公开状态。登录成功后 OAuth 凭据成为该服务商的活动认证，并清除各项目保存的 API key 选择，防止切换项目时覆盖；登出统一调用 SDK 的 `logout`。
- **token 反射防护**（issue #45）：`PI_WEB_TOKEN` 鉴权中间件里，`/api/health` 保持开放供探针，但 `Set-Cookie` 只在请求确实携带有效 token（`tokenOk(req)`）时才下发——匿名命中 `/api/health` 绝不反射真实 token cookie。回归：`tests/token-auth-test.mjs` 的「health does NOT leak pi_web_token」检查。
- **未登录页走原生表单登录**（`server/unauthorized-page.ts` + `server/auth-login.ts`，`POST /__pi/auth`）：口令表单是**真 POST → 303 → GET**，并带 `autocomplete="username"` 的账号域 + `autocomplete="current-password"` 的密码域——只有这样才能让 Chrome/Safari/Firefox 在登录后询问「是否保存密码」（历史实现是 JS `preventDefault()` + `?token=` 跳转，浏览器不认为是登录，永远不弹）。回跳目标统一走 `sanitizeNextPath`：只允许同源绝对路径（禁 `//host`、`\`、控制字符）并剔除 `token`/`__tried_cached_token`/`auth_error` 查询参数；口令错误 303 回 `?auth_error=1`，未登录页据此渲染「口令不正确」。`?token=` / Bearer / X-PI-Token 旧路径全部保留。回归：`tests/unit/auth-login.test.ts`、`tests/unit/unauthorized-page.test.ts`、`tests/token-auth-test.mjs`。
- **dev 兼容**：vite :5173 代理 /ws 到 :8788 时 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 内置）放行，勿删。

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

## 多对话并发

- **引擎契约单源 `packages/keel/src/engine-service.ts`**：`EngineService`（谁能接客户端）与 `DispatchSession`（一个会话能干什么）、`TerminalManagerLike` 只在这里声明。五个引擎（pi / dsh / claude / codex / durable）都显式 `implements EngineService`，服务模块不得再从 `server/index.ts` 取这些类型（入口是装配代码，被当类型库 import 就是一条「服务 → 入口」的回边）。守卫：`tests/unit/engine-service-single-source.test.ts`。
- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：`new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；`switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。**对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；没有则新建一个并恢复该项目最近的持久会话）。
- **工作区命令必须串行（#872）**：`cs.cwd`、活动对话、runtime 绑定是同一组可变状态，而改它们的命令（`set_cwd` / `new_chat` / `new_cli_chat` / `switch_session` / `switch_conversation` / `fork_session` / `rollback_session` / `make_dir(setAsCwd)` / 沙盒切换）都是异步重活（stat、恢复最近会话、挂载 runtime、复制沙盒）。ws 消息逐条派发，上一条还在 await，下一条已经在跑 —— 「先切项目再新建对话」抢跑时 `newChat()` 读到的还是旧 cwd，新对话就落进上一个项目（左栏里像「消失」了）。
  - **唯一单源 `server/workspace-queue.ts`**：派发层对上述命令只做「同步认领 + 入队」，按会话实例 FIFO，后一条等前一条落定；空闲时只多一个微任务。新增工作区命令必须入队，且**不得**在 handler 里自己写「等一会儿再干」。
  - **声明式目标目录**：`new_chat` 可带 `cwd`（`ClientMessage`），服务端在同一条队列任务里「切工作区 → 核验 → 建会话」；**切不过去就不建会话**（错误提示 + `new_chat_result ok:false`），绝不静默落到旧项目。`new_cli_chat` 自带 cwd，自验证、不受这条拦截。
  - **客户端意图单源**：`web/src/pending-workspace.ts` 记住「已声明、未确认」的 `set_cwd` 目标，并自动挂到紧随其后的 `new_chat` 上（各入口不各自记一遍，禁逐处补 cwd）；快照落到目标目录或 cwd 过渡 `done`/`error` 即清理。
  - **入队的命令必须自己是有界的**（自带超时 / 中止）：队列是 FIFO，一条永不落定的命令会堵住该客户端所有工作区操作。`prompt` 与文件类命令不进队（各走自己的路）。
  - 回归：`tests/unit/workspace-queue.test.ts`、`tests/unit/pending-workspace.test.ts`。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd，**跨项目切换同样入列**）→ `listed=true`；从历史显式恢复的会话在打开时即设 `listed=true` + `promptedSinceActive=true`，首次切走不发新消息也保留。
  - **临时对话防丢失（#793）**：已开始的 `isEphemeral` 对话切走时始终保留并设 `listed=true`，不依赖全局 `retainFinishedConversations`、原先的 `listed` 或本次是否发新消息；重复打开再切走同样保留。空白临时对话仍可自动回收，显式 ✕ 仍可销毁；保留不代表落盘，需「保存为正式对话」才能进入历史。
  - 留在列表：后台跑完不移出（用户可能还没看结果）；**还有“用过”的存活 PTY 的对话也留在列表**（终端里可能有仍在跑的任务），但**已退出、仅保留输出的终端不阻止移出**——AI 结束且终端全部跑完后切走，`removeConversation` 顺带 `killAll()` 关闭残留终端并从列表消失（`openTerminals` 传 `terminals.countBlockingLive()`，只统计存活且用过的 PTY——**没动过的空 shell（点开终端 tab 自动建的那个）不算**，切走/✕ 移出时随对话一起释放，不拦截）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，`removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。**子代理豁免切换关闭**：活动的是子代理时切走永远保留（`listed=true`，`displaceActive()` 返回 null）——点开看过就切走也不释放，后台任务继续跑；清理走显式动作（单条 `dismiss_conversation` / 右键批量 `dismiss_finished_subagents`）。
  - **展示口径 vs `listed`**（issue #140）：左栏推什么由 `shownInRunningList()` 决定 = `listed` **或** 「当前对话 + 已经有内容」（有消息，或已被首条提示词命名——命名与首条消息同一时刻，`prompt()` 里那个 rename 块顺手 `emitConversations()`；`agent_start` 再补一次让「流式中」绿点立刻亮起来）。空白新对话仍不入列（防连点「新建对话」堆出一排空条目）。这是**纯展示口径**：`listed` 的语义、以及 `displaceActive` / `shouldRetainActive` 那套运行时释放规则完全不变（换走时该释放的仍然释放）——所以当前对话那一行的 ✕ 必须按同一口径判定（`dismissConversation` 的「不在列表里就 no-op」用的是同一个函数），否则会出现「行在、点 ✕ 没反应」。回归测试：`tests/running-list-test.mjs`（零 token mock 模型）+ `tests/panel-layout-test.mjs`（真浏览器：区标题/「当前」样式/流式绿点）。
  - 关闭父对话连带提示：`dismiss_conversation` 带 `withFinishedSubagents=true` 时连带关闭该对话下已结束的子代理（传递后代，与批量口径一致；active 的跳过）——只关不运行的：运行中的后代不受影响，关完后若还有后代剩下父级暂留并提示；只有运行中的后代时拒绝。不传 flag + 存在已结束子代理后代时拒绝并提示。前端：父行有子代理后代时 ✕ 点一次展开两个选项——「仅关已结束（{n}）」（= 按行批量 `dismiss_finished_subagents`，父级保留）/「强行全关」（`force=true`，见下）。
  - 强行关闭 `force=true`：中止自身运行（如在跑，`interruptRun`）+ 中止全部子代理后代（运行中的也停，`stopSubagent`）再整体移出；终端/审查/后台唤醒等保留态一并放行。active 对话也可关闭（`vacateActive`：优先切到其他已列出对话，否则新建一个再移）。DSH 引擎无子代理：force 只放行 active/终端限制，运行中仍拒绝，请先停止对话。前端：所有行（含选中/运行中）都显示 ✕；无子代理的运行中行两段确认强行关闭（`dismissStreamingConfirm`）；行右键菜单同样有两个选项（`forceDismissConversation` 两段确认）。
- **跨客户端「另一处」行（issue #145 / #291）**：`listExternalRunning(excludeClientId)` 把别的 `ClientSession` 里仍持有的对话下发给左栏（只读感知 + 手动过户入口，`owner`/`convId` 定位目标）。**断连残骸**（最后一个浏览器断开、`sinkCount()===0`）的行在宽限期内仍下发并标 `ownerOffline`（前端「离线」徽标），过期后消失 —— 宽限期 `PI_WEB_OFFLINE_ROWS_TTL_MS`（默认 30 分钟；`0`/`off` = 不下发 = 旧口径）。为什么需要它：手机端「run 途中关页面 → run 在服务端继续跑完」之后，换设备打开网页既看不到行也没法过户（#291 跳过了 sinkCount=0 的残骸），只能去历史对话里开 —— 而残留 runtime 仍持有那份转录，历史里开等于给同一份 JSONL 造第二个 writer。宽限期的到期时刻取「断开时刻」与「最后一次活动」的较晚者（断开后还在跑的后台任务不吃 TTL，每有流式变化就重排），到期由 `armOfflineRowExpiry` 定时器推一次让行消失（回调只推不重排，避免 1s 轮询）。回归：`tests/offline-takeover-test.mjs`、`tests/elsewhere-lifecycle-test.mjs`、`tests/unit/elsewhere-dedup.test.ts`。
- **无人值守持有方的子代理行也要透出**：定时任务（`scheduler:<id>`）、插件（`plugin:<id>:<acct>`）、设备任务这些持有方没人给它开浏览器，它的**内存子代理**（`conv.isSubagent`，即 `persist=false`）如果只走自己的对话列表就永远看不见 —— 侧栏里只能看到父行，定时任务里跑的子代理彻底没有落脚点。所以 `streamingSummariesAll()` 对 `isUnattendedClientId()`（伪客户端 + 设备任务）不再跳过子代理，行上带 `isSubagent` + `parentId`（同持有方父会话 id）；`listExternalRunning` 只在父行也在同一批里时才下发，否则客户端会把子代理当根行顶到列表顶部（`LeftPanel` 另有同一道孤儿过滤，作为父行被本地去重挡掉时的兜底）。子代理行一律**只读**打开（`open_shared_conversation { readOnly: true }`，服务端本来也只允许只读共享子代理），✕ 走 `daemon.dismissConversation` 的 `conv.isSubagent` 分支只收这一行，绝不因一行子代理拆掉整个定时任务持有方。回归：`tests/unit/elsewhere-dedup.test.ts`。
- **定时任务的对话随时可查看（直接打开，不走「另一处」）**：定时任务有两种落地方式 —— 绑了 `conversationId`/`sessionFile` 的唤醒原对话（报告就落在那个对话里），没绑的无头执行走伪持有方 `scheduler:<taskId>`。后者的对话**不喂进侧栏「另一处」**（跑完就断流，不会常驻一行），而是当普通对话直接打开：每次运行的记录存 `sessionFile`（`SchedulerRunRecord.sessionFile`，`chatFromScheduler` 用「此刻的对话」取文件，避免跑完/被接手后 id 过期），面板的「上次运行 / 历史」上有「查看对话」，发 `open_scheduled_conversation { taskId, conversationId?, sessionFile? }`；服务端只认该任务运行记录里真记过的文件，然后走普通 `switch_session` 打开（不是只读共享）。`switchSession` 对 `scheduler:` 持有方改为**放手后再开**（`releaseScheduledConversation` 关掉后台那条 runtime，避免两个 writer 抢同一份转录），这一轮还在跑则明确拒绝并提示等结束。代价：打开即接手，后台下一次触发会开一条新会话（不再写回已归用户的那份）。回归：`tests/unit/scheduler-tasks.test.ts`、`tests/unit/scheduler-panel.test.ts`、`tests/unit/elsewhere-pseudo.test.ts`。
- **过户是事务性的（#556）**：`take_over_conversation` 分两步（源会话 `detachTakeoverConversations` 摘除 → 目标会话 `insertTakeoverConvs` 接入），中间那一瞬间对话两头都不挂 —— 只要第二步报错，runtime 还在跑但任何列表都不包含它（「幽灵会话」，刷新页面无敕，只有重启服务才能靠落盘会话恢复）。现在接入失败就把整包原样搬回源会话（`returnTakeoverPayload`：先 `reclaimTakeoverConvs` 摘掉已部分插入的残留，再用同一套 insert 接线接回源页面并切回 active），两边都收到诚实的回执；二次失败时宁可留在目标页面（接入方已给主对话置 `listed`）也不落到无人持有的空档。回归：`tests/takeover-rollback-test.mjs`（测试专用故障注入 `PI_WEB_TEST_TAKEOVER_FAIL_INSERT`）。
- **驻留对话默认不限数量**，新建、恢复历史、派生及持久化子代理共用 `getMaxOpenConversations()`。仅将 `PI_WEB_MAX_OPEN_CONVERSATIONS` 设为有限正数才启用按项目的数量上限（向下取整，最小 1）；未配置、`0`、负数或非法值均不限。此上限统计持有 runtime 的普通对话，包含已结束但仍驻留的对话及 `persist=true` 的持久化子代理；`isSubagent` 内存子代理和临时会话不占位。显式启用上限时保留并发创建预留和历史对话 LRU 收起；默认无限制时不因数量收起已有对话。它用于可选的资源控制，不能代表正在执行的任务数。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- **项目切换记住 {模型, key} + 全局默认模型**：`client-state` 持久化 `projectModels`（cwd→"provider/id"）与 `projectProviderKeys`（cwd→provider→keyName）。**选模型即刻保存**（`setModel` → `rememberProjectModel`，不等一次问答——SDK 只有存在 assistant 消息后才把 `model_change` 落盘，否则新对话选完模型就切走会丢）；**切换项目/会话时恢复**（`restoreProjectModelForCwd` + `restoreProjectProviderKeysForCwd` 于 set_cwd / switch_conversation / switch_session / ClientSession.create），新对话也会套上该项目上次的 {模型, key}。模型/密钥被删时恢复静默跳过。**全局默认**（`defaultModel` + `defaultProviderKeys`，存 `__settings__` 全局键、全客户端共享）：模型下拉底部「☆ 设为全局默认」把当前模型（含当时 key）记成全局默认，行上 ★ 标记；无项目记忆的新项目回落到它（`set_default_model` / `clear_default_model` / `default_model` 推送，attach 即推；pi / DSH / 通用引擎各自按引擎键存，共用同一套菜单按钮）。菜单的 `defaultModel` **三态别混**：`undefined` = 这本菜单不管默认模型（Bot 模型 / 目标评审模型，不画 ☆）、`null` = 还没有默认（仍要画 ☆ 否则第一台默认永远设不上；`ChatInput.defaultModel` 是必填，禁写成 `?? undefined`）、字符串 = 当前默认。设/清除只走一个出口 `toggleModelDefault()`（`UniversalModelPicker.tsx`），回归：`tests/unit/universal-model-picker.test.ts`。回落链：项目记忆 > 全局默认 > SDK 默认；key 同理（`restoreKeyForModel` 先项目 pin 再全局 pin）。删 key 时全局引用同步改指（`repointDeletedKeyInDefault`）。回归：`tests/unit/default-model.test.ts`。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）推**全部项目已入列的对话 + 当前对话（有内容后，见 `shownInRunningList`）**（前端按 `cwd` 分组显示，当前项目不显示组标题）+ `activeId`（activeId 只在还是个空白对话时才不出现在列表里）；`switch_conversation`（ClientMessage）**可跨项目切换**——切到其他项目的对话时同步切换工作区，补齐 `set_cwd` 的副作用（文件树/会话历史/项目顺序/命令目录/onCwdChanged 钩子）。
- `switch_session`（恢复持久会话）会为目标会话创建独立 runtime，再按上述生命周期把当前对话移到后台；若目标会话已在运行列表中则直接复用其 conversation，绝不因打开历史记录中断当前生成。回归测试：`tests/switch-session-background-test.mjs`。`edit_message` 在**当前**对话内 fork；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- **服务重启后自动继续**：`resumeInterrupted` 按转录文件定位恢复后的 conversation，直接向它的 SDK session 投递 `restart-resume` 自定义消息（`display:false`、`triggerTurn:true`），保留 SDK 的重试、压缩和完成事件；不追加用户「继续」气泡，实时消息和重新打开历史时均隐藏该内部恢复标记。各对话独立启动，不等待上一条运行结束；并发切换 `activeId` 不改变续跑目标，已关闭或已有任务的对话跳过。回归：`tests/unit/restart-resume.test.ts`。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮 + `当前` 副标签、流式绿点；空白新对话不显示该区），MessageList 以 conversationId 为 key 强制切换重挂载。跨项目分组见 `web/src/conv-groups.ts`（纯函数 + 单测）：**当前项目那组不显示组标题**，判定以「当前对话在哪个组」为准（`currentCwd` 只当回落）——`conversations` 推送先到、带新 cwd 的快照后到，只按 `cwd` 判定会让当前项目在切换那一帧被当成「别的项目」而闪一下项目名（bin 浏览器逐帧回归 `tests/conv-group-flash-test.mjs`）。
