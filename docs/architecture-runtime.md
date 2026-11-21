# 运行态：投递、结算与工具桥接

服务端跑起来之后的状态机：压缩期的入站投递、子代理完成证据与派发预算、运行账本与重启续跑、问卷队列，以及引擎检测与原版 CLI 接入；最后一节是工具/审批/后台任务/模式开关这些桥接细节。协议与状态内核见 [`architecture-core.md`](architecture-core.md)。

## 目录

- [压缩期的入站投递：一个门、一个队列、一个排空点（issues/929）](#压缩期的入站投递一个门一个队列一个排空点issues929)
- [子代理完成证据、结算边沿与派发预算](#子代理完成证据结算边沿与派发预算)
- [运行账本与重启续跑](#运行账本与重启续跑)
- [问卷队列与父代理请示](#问卷队列与父代理请示)
- [引擎与原生 CLI 的共用检测](#引擎与原生-cli-的共用检测)
- [Codex CLI 引擎](#codex-cli-引擎)
- [Claude Code / Codex 原版接入约定](#claude-code--codex-原版接入约定)
- [其他桥接](#其他桥接)
  - [工具结束实时状态（`tool_status`）](#工具结束实时状态toolstatus)
  - [工具挂死看门狗](#工具挂死看门狗)
  - [审批队列与共享展示](#审批队列与共享展示)
  - [审批三档放行与自定义规则库](#审批三档放行与自定义规则库)
  - [待答问卷进快照（重连恢复对话框）](#待答问卷进快照重连恢复对话框)
  - [后台任务列表](#后台任务列表)
  - [只停止 bash 命令（对话继续）](#只停止-bash-命令对话继续)
  - [edit 的 soft 参数（原 edit_soft 已合并进来）](#edit-的-soft-参数原-editsoft-已合并进来)
  - [read 覆盖：路径是目录时列出目录条目（`server/read-tool.ts`）](#read-覆盖路径是目录时列出目录条目serverread-toolts)
  - [覆盖与第三方扩展同名工具共存（`server/tool-overrides.ts`）](#覆盖与第三方扩展同名工具共存servertool-overridests)
  - [审查者模式：自动委派（`server/delegate-mode.ts`）](#审查者模式自动委派serverdelegate-modets)
  - [计划模式：只规划不实施（`server/plan-mode.ts`）](#计划模式只规划不实施serverplan-modets)
  - [模型操作浏览器页面（`browser_page` 工具）](#模型操作浏览器页面browserpage-工具)
  - [扩展 UI 桥](#扩展-ui-桥)
  - [Durable 引擎的数据来源：只认 AgentEvent，不读 `pi.live` 槽位（`server/durable/durable-event-projector.ts`）](#durable-引擎的数据来源只认-agentevent不读-pilive-槽位serverdurabledurable-event-projectorts)
  - [Correlated host conversation creation](#correlated-host-conversation-creation)

## 压缩期的入站投递：一个门、一个队列、一个排空点（issues/929）

往一个对话里塞文字只有四种可能：投进正在跑的一轮、开新一轮、**现在不能投（门关）**、对话没了。压缩是第三种——`session.prompt()` 在压缩期间直接抛错，而 `session.steer()` 只是把消息塞进「只有活轮才会取」的 steering 队列。旧实现让十几个调用点各自判断这件事，于是每多出一种门（压缩、等回话、过户）都会漏掉几处：子代理完成通知重试 8 秒后放弃、先把子代理记成「已通知」，`steer` 塞进一轮永远不会发生的队列，压缩结束后没人再送（issue #929 的两个症状）。

现在只有两处知道这件事：

- `server/conversation-delivery.ts` 是纯逻辑（不 import SDK、不碰 `Conversation`）：`deliveryMode()` 是唯一判定（`live / gated / idle / closed`），`ConversationDelivery` 是门关时唯一的去处（意图队列，按 tag 幂等、按 kind 合并）和门开时唯一的出口（`drain`：FIFO、可重入、撞上新关上的门就留着）。它允许用错误文案判定的**唯一**一处是 `isCompactionRejection()`。
- `Conversation.compaction` 是门相位的**唯一写者**，事件溯源：工具请求时置 `queued`（此刻 SDK 的 `isCompacting` 还是 false，正是旧实现漏掉的窗口），`compaction_start` 转 `running`，`compaction_end`（含失败/取消）清空。旧的 `pendingCompaction` / `compactionState` / `turn.compactionPending` 三个字段合并成它；UI 横幅与手机通知只读投影（`compactionBanner()`）。

五条不变量（动这里之前先读）：**门关不提交**；**门开必排空**（失败与取消路径同样排空）；「已通知 / 轮次 +1 / 熔断额度 −1」只在投递被接受后写（`commitIntent`，提交点副作用）；`steer` 只投给活轮，其余入队（回执 `queued` 才是承诺）；门相位的写者唯一。

排空点是一个闭集：`compaction_end`、`executeCompaction` 的 `finally`（`compact()` 抛错时兜底开闸）、`agent_settled`、等回话解除（`setConsultWaiting(parent,false)`）、以及 `emitConversations()` 的对账兜底。所以新增压缩来源（软上限自动压缩、SDK 回合内自动压缩、分支摘要）自动被覆盖；新增一种门只需往 `deliveryMode()` 加一个谓词，不必再碰投递点。

交互式 `prompt()` 在压缩期间也不再让人重发：**纯文本进同一条意图队列**（`kind: "user-prompt"`，tag 用正文，重复发送只排一条），`compaction_end` 排空时按「idle → 开新一轮」真送出去。语义跟直接发送对齐：`conv.autonomousTurnsWithoutUser = 0`、`wakeReason = "user"` 这些状态挪到提交点 `commitIntent`，压缩期间不预支；排队意图被丢弃（对话被关掉等）时如实报一条 warning，绝不静默。**带附件 / 引用 / 图片的不排队**：`buildAttachmentMessages`、画布引用、`@` 扫描都依赖当次会话状态，没法在排空时安全重放，仍当场拒绝并写明「等压缩结束后再发」。斜杠命令（要当场执行）与派活、目标执行者的路由同理不排队。

前端因此多一条 ack：服务端入队后发 `{ type: "prompt_queued", conversationId, text }`，`web/src/optimistic-queue.ts` 的 `markOptimisticPromptEchoQueued()` 把对应的乐观回显标记为「已入队」。标记过的回显不再按 15 秒 TTL 回收（压缩常超过 15 秒，气泡先消失再冒出来比直接报错更糟），改由 `reconcileOptimisticPromptEchoes()` 在真正的 user 消息落账时按正文对账收掉；只留一个 10 分钟的安全上限，防止服务端丢意图时留下永久幽灵气泡。

守卫：`tests/unit/delivery-gate-single-source.test.ts` 禁止别处直读 `isCompacting`、禁止手写 `deliverAs: "steer"`、禁止复活那三个旧字段，并给直连 `sendUserMessage` 的站点设上限；`tests/unit/delivery-gate-929.test.ts` 覆盖三个场景（父对话压缩期间子代理完成 → `compaction_end` 后补投一次；子代理压缩期间 `steer` → 门开后开新一轮；用户自己发的文本在压缩期间入队、门开后只发一次，带附件仍拒绝）；`tests/unit/optimistic-queue.test.ts` 覆盖「已入队回显不再按 TTL 消失」。


## 子代理完成证据、结算边沿与派发预算

子代理自述「做完了」不算证据。`conversation(action="complete")` 除 `summary` 外要求同时给 `evidence`：`{files:[], commands:[]}`（改过的文件、跑过的验证命令）、`{none:true}`（只读任务，声明没有文件改动）或 `{blocked:"原因"}`（做不完，如实报）。归一只在 `server/subagent-evidence.ts`：路径按 `/` 归一、命令压空白、去重并限量（50 文件 / 20 命令 / 单条 400 字符），空对象判非法。

对账不接受自述：`collectTranscriptFacts()` 从子代理自己的转录里抽**真改过的文件**（写入类工具调用的 path/file_path/paths/files，名单复用 `subagent-security-gate.ts` 的 `SUBAGENT_WRITE_TOOL_NAMES`）与**真跑过的命令**（bash/powershell 调用的 command、`bashExecution` 的 command+exitCode、`toolResult.isError` 回落标失败）。只有可证伪的冲突才驳回：声称跑过的命令在转录里找不到 / 那条命令在转录里失败 / 声称 `none` 但转录有写入；改过但未声明的文件、声称改过却找不到写入调用的文件只记疑点并降级 `partial`（bash 里 `sed`/`mv` 也会改文件，不能一票否决）。驳回时 `complete` 抛错并把矛盾列给子代理，让它先修正再登记；通过后证据存到 `conv.subagentEvidence`，裁决 `pass / partial / unverified / blocked` 随 `wait_all`、`get_result`、`list`、完成通知（`subagent-notify.ts`）一并呈现；同一裁决经 `ConversationSummary.subagentVerdict` 进左栏，`unverified / partial / blocked` 显示证据角标（`pass` 不占位），别让「没验证」看起来像「已验证」。缺证据不阻塞收口，但状态必须显示 `unverified`，父代理据此决定是否复核——宁可显式未验证，不要假成功。

`wait_all` 不再轮询。`server/subagent-settle.ts` 的 `SubagentSettleRegistry` 只提供**边沿**：运行 id 变化即唤醒订阅者，等待方醒来重算是否真的收口（并重扫新派生的后代与待交付请示）。`agent-service` 在回合结束、停止、移出、问卷队列变化、完成通知投递状态变化处 `notify/notifyAll`，`dispose` 时 `shutdown`。单次等待切片 30s，等待上限仍由看门狗 cap 决定；通用引擎（`universal-session.ts`）用自身的子代理监听实现同一接口，语义一致。判定「已收口」只有一条：拿不到快照（已移出/已结束回收）或显式终态，等待与「还剩谁」共用 `isSettled`，避免出现「全都完成了却报还有人在跑」。

一次调用可以扇出：`spawn` 的 `tasks[]` 一次派多个，先整批校验（prompt、key 形状与唯一性、模板可用、思考档位、隔离模式）再启动，一个不合法就一个都不启动；单批上限 `SUBAGENT_FANOUT_MAX = 16`，启动并发窗口 4（不与并发上限抢名额）。每个 task 可带 `key`（字母数字与 `_.-`，≤40），工具把 `key → 运行身份` 记在**本对话工具实例**的有界表（256 项）里，`wait_all / get_result / steer / stop` 的 `runIds` 接受 key 或真实 id。`steer` 回执区分 `delivered`（送进当前回合）/ `queued`（门关着，已挂起，门一开必定开新一轮）/ `restarted`（本来空闲，同会话开新一轮）/ `missed`（没有可投递通道），父代理不必猜。

并发与深度挡不住累计成本，所以加了第三道闸：`server/subagent-budget.ts` 按**运行树根**（沿 parent 走到最顶层会话的稳定执行身份）累计派发次数，默认 64（`PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN`，`0` 关闭）。预留在启动路径同步完成，失败退还，运行树根移出时 `forget`。子代理用量（`getSessionStats().tokens`）进快照的 `usage`，在列表与等待结果里以 `输入↓输出↑` 呈现，配合上下文软上限一起看成本。


## 运行账本与重启续跑

子代理的工作不能因为重启就消失。`server/subagent-ledger.ts` 把每次派发落到 `<dataDir>/subagent-runs/<runId>/`：

```
status.json     机器可读的当前状态（原子替换，最后写者胜）
events.jsonl    追加式生命周期流水（有字节上限，截断后只留一条标记）
```

写入纪律：所有写操作进每个 run 的**串行队列**，调用方一律 fire-and-forget；`status.json` 走 `writeAtomic`，事件用 `appendFile`；任何 IO 失败只记 `lastError()`，绝不让账本问题打断派发或回合结束（`dispose` 时 `flush()`）。有界：run 目录数默认 200（`PI_WEB_SUBAGENT_LEDGER_MAX_RUNS`，`0` 关闭整本账）、单 run 事件 256KB、`prompt` 8KB、`outputTail` 4KB、证据条目各 5 条。淘汰只挑已结束的 run，且要等该 run 的写队列排空再删目录——否则排队中的 `mkdir` 会把目录又建回来。

重启对账只认 `bootId`：每条记录带本进程随机身份，`recover()` 只把**别的 boot** 留下的 `running` 判成 `interrupted`，本进程的活运行一律不动；重复调用幂等。`ClientSession.create()` 里 fire-and-forget 调用一次，命中时推一条 notice（列出前 5 个标题与 id），告诉用户/模型可以 `get_result` 取已产出的证据或 `resume` 续跑。**主对话的重启恢复与子代理分开**：`streamingSummaries()`（daemon 记录「重启时正在流式」的入口）跳过子代理与持久化子会话，避免把 child 当成普通标签页重新打开、丢掉父子关系。

账本由运行态在各收口点同步：派发登记 `running`；回合结束、完成登记（含证据）、停止、移出、`steer` 重开一轮、工作树收尾分别 `upsert` + `event`（`spawned / turn_end / completion_requested / stopped / dismissed / steer_restart / worktree_finalized`）。读侧：`conversation(action="list")` 在活运行之后追加账本行（跳过已移出与仍在内存里的），`get_result` 在内存查不到时回落到账本，给出状态、证据、错误、工作树、`sessionFile` 与输出尾部。

`conversation(action="resume", runId, message?)` 的语义必须诚实：进程内子代理会话不落盘，**接不上原转录**，所以续跑是「带已知进度重派」（`mode: "relaunch"`）——提示词由 `buildResumePrompt()` 拼：原任务 + 中断前输出尾部 + 账本证据 + 保留的工作树 + 旧转录路径，并要求「别重做已完成的部分、守住已有结论、按证据收口」。工作树仍保留时直接以它为 `cwd` 重派（复用未提交改动，不新建工作树）；`persist=true` 的子代理转录仍在历史里可回看。`resumedBy` 标记新 run，重复续跑直接拒绝；还在进程里跑着的 run 也拒绝（先 `wait_all`/`get_result`）。

验证：`tests/unit/subagent-ledger.test.ts`（写入/重启读回/bootId 对账/事件截断/淘汰/关闭/续跑关系/提示词）、`tests/unit/subagent-ledger-tool.test.ts`（list 追加/get_result 回落/resume 成功与四类失败/无账本引擎降级）。


## 问卷队列与父代理请示

共用 `QuestionDialog` 保留单选选中新选项后立即进入下一题；再次点选已选项则取消并留在当前题，鼠标与数字键一致。末题默认等待提交按钮或 Enter；问卷底部可开启「最后一题点选后自动提交」，偏好保存在当前浏览器，单题问卷同样适用。切换偏好和恢复草稿不触发提交；取消选择后允许只交补充说明，隐藏条件题不提交答案。

标准 pi 引擎通过 `question_queue` 推送**本连接全部项目**的待答队列：本 `ClientSession` 自己的问卷不看 `cwd`（与工具审批同源，审批也遍历 `convs`），其他持有方（其他页面 / 定时任务 / 设备任务）的问卷仍只限同项目（跨页过户要求 `cwd` 相等）。每个请求保持稳定 ID、来源对话、顶层对话、持有方、创建时间、项目目录（`cwd`）及可选截止时间。顶层对话只在同一项目内回溯。顶层入口、来源对话与跨页面回答引用同一请求，回答按当前持有方结算，过户保留请求身份与期限。快照的 `pendingQuestion` 和即时 `question_pending` 保留其他引擎兼容；前端队列入口合并后只展示一个问卷。侧栏问号、问卷通知、跨页面摘要与“等待用户”状态共用服务端有效用户问卷查询，只包含 `audience="user"` 且尚未结算的请求；代理间 `request/consult` 在升级给用户前不得触发这些提示，已回答、取消或超时的请求立即退出。

`questionPresentation` 控制当前对话弹出并排队其他问卷（默认 `queue`）、全部自动弹出（`all`）或仅手动队列（`manual`）。`all` 跨项目同样自动弹出（这正是“所有对话”的含义）：其他项目的问卷带项目名标签，直接作答无需切项目，「跳转」由 `navigate_question` 走本页自有的 `switchConversation`（可跨项目并一并切工作区），只有跨页过户才要求 `cwd` 相等。工具审批独立使用 `toolApprovalPresentation`，同样支持这三种方式，默认 `all` 保持所有对话的审批依次自动弹出；该设置只控制提醒，不改变审批开关、规则与批准/拒绝结果。稍后回答保留问卷与草稿，取消为显式操作；来源跳转打开对应对话。

子代理用 `conversation(action="consult")` 请示直接父对话；父对话通过 `answer` 作答或 `escalate` 交给用户。`ask_user_question` 始终等待用户，父代理不得代答。`wait_all` 遇到尚未交付给当前父对话的请示提前返回 `needs_input`，同一请求不反复唤醒。父代理不可处理时升级用户，已有自动唤醒预算继续生效。

`questionTimeoutSeconds` 对新建子代理问卷及请示默认 240 秒，0 为不限时；主对话保持原等待策略。服务端负责期限和取消，超时返回明确结果，不自动采用推荐选项。升级不重置期限，浏览器倒计时不触发取消。问卷结束不等于执行会话结束，也不会提前释放并发名额。


## 引擎与原生 CLI 的共用检测

`server/engine-catalog.ts` 是引擎 ID、包名、安装命令和独立 CLI 能力的单源，供引擎管理、协议类型和 CLI 工作台使用。`server/engine-cli.ts` 统一解析 PATH、常见安装目录和全局包的 `package.json.bin`，并生成不经过 shell 的 `{file, args}`；版本探针、Claude/Codex 驱动与原生 PTY 都使用这份结果，不再各自维护路径查找逻辑。全局包位置继续复用 `global-loader.ts`，只安装库或残缺 bin 不代表存在可启动的 CLI。

引擎的 SDK/运行时可用性与独立 CLI 能力分别判断：Pi/DSH/Durable 可通过 SDK 或运行树工作；Pi Durable 没有独立 CLI；DSH 的 `dsh` 需要 profile，不能假设其包含默认终端界面。CLI 工作台的能力与启动约束见 [终端架构](architecture-terminal.md#原生-cli-工作台)。单项和批量引擎探测使用同一登记表与 TTL 缓存。


## Codex CLI 引擎

`codex` 通过 `server/universal/drivers/codex.ts` 接入通用底座，使用本机安装的 `@openai/codex` CLI。安装后先在终端运行 `codex login`；认证与服务商配置沿用 `~/.codex/`（或 `CODEX_HOME`），设置页的 Pi/Claude 服务商密钥不会注入 Codex。模型与推理强度按会话选择，默认模型跟随 CLI 配置。

驱动将 `codex exec --json` 的线程、正文、思考、工具和用量事件转换为通用事件，线程 ID 随会话持久化以便续接。执行使用工作区写入沙盒，不绕过 Codex 的安全限制。Codex 不提供宿主工具审批、历史编辑或分叉；通用底座按能力声明隐藏这些入口。停止请求必须终止对应子进程并完成有界清理。


## Claude Code / Codex 原版接入约定

**事实源**：`server/universal/drivers/claude-code.ts`、`drivers/codex.ts`、`server/universal/engine-mcp.ts`、`universal-attachments.ts`（`materializeUploads` / `describeCliAttachment`）。回归：`tests/unit/claude-driver-launch.test.ts`、`codex-driver.test.ts`、`universal-commands.test.ts`（第 4 组）、`universal-attachments.test.ts`。

- **执行即原版 CLI**：两个引擎都只启动本机 `claude` / `codex`，工具、登录、会话存储、CLAUDE.md/AGENTS.md、CLI 自己的 MCP 与技能全部由 CLI 负责；底座不模拟 CLI 能力。
- **图片**：Claude 走 `-p --input-format stream-json`，图片作为原生 `image` 块（>5MB 或非 png/jpeg/webp/gif 时落盘为文件交给 CLI 读取）；Codex 走 `--image`。
- **上传文件**：浏览器上传的 `fileData` 由底座先存入 `<dataDir>/uploads/<clientId>/`（与 Pi 共用清理策略），再以绝对路径告诉 CLI；禁止只传文件名。
- **MCP**：pi 配置的已启用服务器（`<agentDir>/mcp.json` + `<cwd>/.pi/mcp.json`，项目覆盖全局）**叠加**在 CLI 自身配置之上：Claude 用 0600 临时文件 `--mcp-config`（轮次结束删除，不用 `--strict-mcp-config`），Codex 用 `-c mcp_servers.*`，HTTP 头值经 `env_http_headers` 走环境变量以免出现在命令行；因驱动以 `--ask-for-approval never` 运行，桥接的服务器一律带 `default_tools_approval_mode="approve"`（否则 Codex 拒绝调用："requires approval, but approval policy is never"），与 Claude 的 `--dangerously-skip-permissions` 同级。pi 侧 OAuth 令牌不随之传递。
- **模型**：Claude 列表为 CLI 别名（`default` 不传 `--model`，跟随 CLI 配置；`opus`/`sonnet`/`haiku`）加 models.json 中兼容的自定义服务商；已下线的 `claude-3-*` 存档自动迁移为 `default`。会话构造时必须把当前模型同步给驱动。
- **斜杠命令**：Claude 的命令清单取自 CLI `system/init` 事件的 `slash_commands`，原样透传给 CLI（含 `/compact`、技能）；pi 自管 UI 状态的命令（`/new`、`/model`、`/name` 等）保留在 pi。通用底座不得伪造压缩（只裁剪界面消息而 CLI 上下文不变）；不支持原生压缩的引擎只提示。
- **会话 ID**：`createSession()` 不得返回占位 ID；真实 ID 来自 CLI 事件并经 `onSessionStarted` 回写，否则后续 `--resume` 会被 CLI 拒绝。
- **左栏归属与去重**（所有引擎）：左栏按 `ConversationSummary.sessionFile/sessionId` 与 `SessionSummary.path/sessionId` 认定「打开中的对话」与「历史会话」是同一条；按 `SessionSummary.cwd` 认定所属项目。通用底座的会话 `path` 是对话 ID（无项目 slug），因此对话摘要必须带 `sessionId`、历史行与 `sessions` 消息必须带 `cwd`，否则会重复显示且出现在每个项目下。`isSessionMatchingProject` 必须传会话对象（优先比 `cwd`），按路径判断时先看 `--slug--` 目录再看路径前缀——会话目录通常在家目录下，把 `~` 当项目时前缀规则会吞掉所有项目的会话。回归：`tests/unit/left-panel-engine-sessions.test.ts`、`universal-session-list.test.ts`、`list-sessions-dispatch.test.ts`。


## 其他桥接

### 工具结束实时状态（`tool_status`）

服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。bash 工具的 details 不带 exitCode（成功时返回 truncation 信息，失败时错误文本含 `Command exited with code N`），服务端从错误文本正则提取；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。

### 工具挂死看门狗

每个 `tool_execution_start` 都会为 toolCallId arm 一个看门狗 timer（**优先取设置面板「工具」页的 `ClientSettings.toolWatchdogTimeoutMs`**（分钟，0 = 禁用，逐 run 实时读取、无需 reload）；未设时回落环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒），再回落默认 20 分钟）——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。**若工具调用自己显式声明了更长的超时**（目前只有 bash 的 `args.timeout`，秒），看门狗自动顺延到 `max(基础值, 工具超时 + 5s)` —— 否则 AI 传 `timeout: 5400`（90 分钟）也会被 20 分钟的看门狗联同整轮对话一起剁掉。恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；看门狗超时也走同一 `interruptRun`。**只停止运行，不碰后台服务**——那些由「后台任务」面板单独管理。回归：`tests/unit/tool-watchdog.test.ts`。

**豁免 `ask_user_question`**：问卷阻塞等的是「人类回答」，不是挂死的工具——arm 前按工具名跳过（`tool_execution_start` 里 `event.toolName !== ASK_USER_QUESTION_TOOL_NAME`）。它的收场自有路子：用户回答/取消、会话 dispose（`cancelPendingQuestions`），**不限时**（标准 pi 引擎；DSH 引擎无此看门狗，提问走 `PI_WEB_DSH_QUESTION_TIMEOUT_MS` 自己的 10 分钟）。同理，问卷挂着也不算「失联」——stall 检查（`startStallTimer`，默认 180s 无 SDK 事件告警）对 `isWaitingOnUser(conv.id)` 的对话跳过。回归：`tests/question-bridge-test.mjs`（`PI_WEB_TOOL_TIMEOUT_MS=2000` 挂着不答超过阈值仍不终止）。

### 审批队列与共享展示

`UiState.pendingApprovals` 是当前连接持有的全部对话的权威待审批队列（含后台对话），按创建时间排序；完整快照与增量快照均携带，刷新或重连后可恢复。`pendingApproval` 保留单项兼容。即时 `tool_approval_pending` 按 ID 追加或更新，`tool_approval_resolved` 仅移除对应 ID，不能清空其他待办。答复仍通过服务端 `findPendingApproval` 按稳定 ID 定位原对话；允许同类/全部允许仍只作用于该对话。

前端问卷和审批共用 `PendingQueue` 的列表、数量、等待时间、稳定选择、跳转和稍后处理逻辑，分别保留 `QuestionDialog` 与审批编辑面板。新请求和快照不能抢占已打开的请求；审批编辑器只随请求 ID 初始化，避免快照覆盖正在编辑的参数。稍后处理只暂缓展示，不产生审批答复；暂缓状态仅在本次页面生命周期保存。

### 审批三档放行与自定义规则库

人机协同审批（`tool_approval_pending`）原先只有「批准 / 拒绝 / 修改并放行」三个单次选项，同一类高危操作反复出现时每次都要点。现在的审批系统分为**规则评估引擎**与**放行策略**两个层次：

#### 1. 自定义规则库与匹配引擎（`<dataDir>/approval-rules.json`）

规则由 `server/approval-rules.ts` 的 `ApprovalRulesStore` 持久化，所有客户端全局共享。规则在设置面板「审批规则」页可视化编辑与排序，按列表顺序自顶向下匹配，首个命中生效：

- **适用工具**（tools）：支持单工具（如 `bash`）、多工具组合（如 `["write", "edit", "patch"]`）或通配 `*`；
- **检查字段**（field）：`command`（命令字符串）、`path`（目标文件路径：认 `path` / `file_path` / `file` 三种写法，见 `extractTargetPath()`，扩展实现如 pi-better-edit 的 `edit` 用 `file`）、`params`（完整参数 JSON 字符串）；
- **匹配模式**（match）：
  - `regex`：大小写不敏感正则表达式匹配；
  - `glob`：路径通配符（支持 `*` 单段、`**` 跨目录跨段，统一归一化正反斜杠）；
  - `contains`：包含子串匹配；
  - `prefix`：前缀开头匹配；
  - `outside_workspace`：工作区外写入越界检测（基于当前工作区 cwd 与额外 roots 物理路径判定）；
- **命中动作**（action）：
  - `ask`：触发人机协同审批（弹窗让用户决定，支持就地编辑参数与允许同类）；
  - `deny`：直接拒绝阻断执行并向模型回传错误（不弹窗、不产生待审批 pending）；
  - `allow`：免审直接放行（白名单，跳过后续规则与内置检测，直接执行工具）。
- **内置规则转化**：原硬编码的 10 项内置高危检测（`rm -rf`、Windows `del /s /q`、磁盘格式化、破坏性 Git、危险 `chmod`、系统目录重定向、敏感配置 `.env`/SSH/Shell 以及越界写入）全部转换为默认内置规则（`builtin: true`），用户可自由停用、调整动作或一键恢复默认。

#### 2. 三档放行策略（运行时快速免问）

门禁统一在 `ClientSession.askApproval` 入口（纯函数 `approvalSuppressionReason(policy, enabled, categoryId)`，`server/tool-approval.ts`，单测 `tests/unit/tool-approval.test.ts`）：

1. **全局关**：设置 →「工具」页的「工具执行审批」总开关（`ClientSettings.toolApprovalEnabled`，默认开，纯运行开关不进预设）。关掉后一切审批都不弹——内置高危检测直接放行、插件 pre guard 的 `ask` 也按放行处理（`withToolGuard` 的 `ask` 分支只改 `needApproval`，最终都经 `askApproval` 定夺）；开关被关掉的那一刻，挂着的待审批项由 `autoApprovePendingApprovals` 全部按批准放行（不让人对着弹窗干等）。
2. **本对话全部允许**（弹窗按钮，`tool_approval_response.scope = "all"`）：该对话后续任何高危操作都不再询问。
3. **本对话允许同类**（弹窗按钮，`scope = "category"`，仅在本次命中规则档位时出现）：只放行同一档位。档位 = `UiApprovalCategory{ id, label, labelEn }`，id 稳定不许改名：`bash.rm-rf` / `bash.win-del` / `bash.disk` / `bash.git-destructive` / `bash.chmod` / `bash.system-redirect` / `file.sensitive.env` / `file.sensitive.ssh` / `file.sensitive.shell` / `file.outside-workspace` / `phone.gesture` / `phone.input` / `phone.key` / `phone.launch` / `plugin:<pluginId>`（插件 pre guard 的 `ask` 按插件分档）。无档位的拦截（自定义 reason）只受前两档影响。

**手机操控档（#902）**：`phone` 工具的 `op` 分读屏档（`status`/`dump`/`screenshot`）与操控档（`tap`/`long_press`/`swipe`/`input`/`key`/`launch`，单源 `server/phone-tool.ts` 的 `PHONE_READ_OPS` / `PHONE_CONTROL_OPS`）。**读屏档不建规则**（默认不拦截）；操控档由 `PHONE_APPROVAL_GROUPS` 派生出 4 条内置 `ask` 规则（`builtin.phone.*`，`field: "params"` 匹配 `op`，容空白/大小写），因此每档既能单独停用（等价于「只允许读屏」「launch 才问」这类粒度），也能按档「记住本类」。工具描述与设置文案必须写明「开启即授权整机操控，但每个操控 op 先问」，不要退回到「无逐操作审批」的旧口径。回归：`tests/unit/phone-tool-ops.test.ts`。

**策略挂在哪**：`Conversation.approvalPolicy = { allowAll, categories: Map<id, UiApprovalCategory> }`，**仅内存**（不落 client-state），且挂在对话对象上而不是 ClientSession——手动过户搬的就是对话本体，策略跟着走；重启服务 / 新对话即恢复询问。记住后同对话内**已被新策略覆盖的其它待审批项一并放行**（`approveCoveredPending`），并给一句回执 notice。

**撤销**：设置 →「工具」页列出当前对话已记住的放行（`UiSettingsState.approvalPolicy`，服务端 `approvalPolicyState()` 现取），逐条「撤销」走客户端 `set_approval_policy`（`allowAll` 赋值 + `categories` 作保留名单整体替换；纯内存态，不走 `set_settings`）。弹窗本身在策略生效后就不再出现，所以撤销入口必须留在设置里。

回归：`tests/approval-policy-test.mjs`（协议面：开关持久化 / 策略推回面板 / 垃圾消息 no-op）、`tests/approval-rules-test.mjs`（自定义规则协议面）、`tests/unit/approval-rules.test.ts`（匹配引擎单测）、`tests/unit/tool-approval.test.ts`（档位与三档判定）。

### 待答问卷进快照（重连恢复对话框）

`question_pending` 是即时通道：只推给「提问那一刻在线」的连接，刷新页面 / WS 重连 / 新标签页都收不到那条历史消息，而服务端还在阻塞等人回答——面板会凭空消失（`QuestionDialog` 没有别的入口）。因此待答问卷同时挂在快照上（`UiState.pendingQuestion`，标准引擎按对话过滤：`pendingQuestionForSnapshot()` 只带当前对话的那张，切回原对话会重推快照；DSH 的提问桥是 runtime 级的，不分对话）。前端 `use-chat.ts` 收到 `snapshot` / `snapshot_delta` 时用纯函数 `web/src/pending-question.ts` 的 `resolvePendingQuestion` 决定面板去留：快照有待答问卷就恢复（已答过的 id 跳过——回答消息与在途快照会交错），但只有「由快照恢复出来的」面板才接受快照收起（避免一张回答之前的旧快照把刚由即时通道弹出的面板闪掉）。单测 `tests/unit/pending-question.test.ts`。

### 后台任务列表

bash 工具执行前后各拍一次监听快照（`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 进程记入 `bgServers`（端口→pid→since→name，name 经 `lookupProcessName` tasklist/ps 尽力获取），启动后 notice 提示「可在顶栏「后台任务」里单独停止或全部关闭」；**列表按客户端持久**（ClientSession 字段，非对话级）——对话结束/切换/断线重连都不消失（attachSink 重推 `bg_servers`），只有任务被停或进程自行退出才移除（30s 定时器 `refreshBgServers` 重新对端口快照，port+pid 都匹配才算还活着，静默剔除死项）。

**自动清理遗留实例**（面板底部「自动清理遗留」下拉 + 「立即清理」）：阈值档位 `0/15/30/60/120` 分钟（`ClientSettings.bgAutoCleanupMin`，**默认 0 = 关**），同一个 30s 定时器里实时读设置 → `BgServerTracker.cleanStale(thresholdMs)`：先 `verifyBeforeKill` 复核端口→pid 归属（不对就剔条目，**绝不对陌生进程开杀**），再按 `staleLeftovers()`（纯函数，单测覆盖）挑出**未钉住**且 `now - since >= 阈值` 的条目 → `killPidTree` + 汇总 notice。面板每行可 📌 **钉住**（`set_bg_keep`）：钉住的永不参与自动清理（现场：调试时故意留着的 dev server 不该被扫掉）。手动「立即清理」在阈值为关时用 30 分钟兼底，消息可带 `minutes` 覆盖（>0 生效）。插件注册的常驻任务（`registerBackgroundTask`）**不参与**自动清理——它们在宿主进程内，由插件的 `stop` 回调负责。回归：`tests/unit/bg-servers.test.ts` / `tests/bg-cleanup-test.mjs`。

**误报过滤**（`BgServerTracker.filterAgentSpawned`）：端口 diff 只是候选，还需通过 `shouldTrackBackgroundServer` 判定才记入——① 进程名命中黑名单 `NON_AGENT_PROCESS_NAMES`（WeChat/QQ/Telegram 等桌面软件）直接跳过；② 一次 PowerShell CIM / `ps -Ao pid=,ppid=` 批量拉全量父子映射，沿父链回溯：撞上服务器进程（`process.pid`）或本次 diff 出的其他新 pid（bash 留下的中间层）→ 记录；完整回溯到系统根（pid 0/1）未命中 → 桌面软件自启（如自己开的 Chrome，父链是 explorer），跳过；断链（父已退出/reparent）→ 保守记录。**Chrome 不进黑名单**：Playwright 等由 AI 拉起的浏览器父链能回溯到服务器进程，与用户自开的 Chrome（父链 explorer）区分开。

协议：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按端口停单个）/ `kill_background_servers`（全部关闭，`killAllBackgroundServers` 对每个 pid `killPidTree`，Windows `taskkill /F /T`）/ `list_bg_servers`（面板打开时请求刷新）；前端 `BgTasksModal`（每个任务行「停止」+ 底部「全部关闭」「刷新」，空列表有占位文案）。

### 只停止 bash 命令（对话继续）

bash 工具卡片运行中显示「停止」→ 发 `{ type: "abort_bash" }` → `ClientSession.abortBash()`。服务端用 **killable bash 工具**（`makeKillableBashTool`，经 `customTools` 按 name 覆盖 SDK 内置 bash）：执行时把自己的 AbortController 注册进客户端级 `bashKills` 集合，abort 只杀这些 controller → bash 子进程进程树被杀（工具抛 "Command aborted"，被 agent-loop 捕获成工具错误结果）→ **agent run 与对话继续**；与 SDK `session.abortBash()`（只对扩展 `executeBash` 路径有效，agent 工具路径无效）不同，这里对对话中的 bash 工具调用真实生效。

命令被中止时 SDK 会把**终止前已输出的内容拼接进工具错误结果**（AI 能看到输出 + "Command aborted"）；随后 `abortBash()` 再 `sendUserMessage` 注入「用户手动停止」提示，让 AI 明确知道是用户手动而非失败。

### edit 的 soft 参数（原 edit_soft 已合并进来）

内置 `edit` 要求 oldText 与文件恰好匹配（含缩进/空白）。对缩进非语法意义的语言（如 JS/JSON），模型给出的 oldText 常与文件差几个空格/制表符而导致编辑失败。pi-web-ui 经 `customTools` **覆盖**内置 `edit`（`server/edit-tool.ts` 的 `makeEditToolDefinition`，包装点仍是 `toolOverrideSpecs` 的 `composeEdit`），在 `path` / `edits` 之外只加一个参数 `soft`：

- 不给 `soft`：原样转发 SDK 实现（含它自带的尾空白/全角字符宽松匹配），本宿主不重复实现精确匹配，两边不会漂移；提示词 guideline 明写「找不到文本就把同一处编辑换成 soft=true 重试」，模型一次自愈。
- `soft: true`：先试精确子串，失败后按「逐行核心（trim）序列一致」做宽松匹配（忽略行首/行尾空白差异），命中后**整行原样写入 newText**（缩进即最终缩进）。仅唯一匹配才写，重叠 edit 报错，并参与同一个 per-file 变异队列（`withFileMutationQueue`）。

`edit` 属核心内置工具（`CORE_TOOL_CATALOG`），不是 `AGENT_TOOL_CATALOG` 里的可开关项，因此没有「宽松编辑」开关：`soft` 由模型按需传。DSH 引擎不下发该参数。

**多 edit 必须按位置排序再逆序应用**（`applySoftEdits`）：所有 edit 都相对同一份原内容定位，得到各自的 `start/end` 后要**先按位置升序排**、再逆序套用，左侧偏移才稳定。早期实现漏了排序，直接按 edits 的传入顺序逆序应用 —— 模型若把靠后的 edit 写在前面，后面的替换先改变长度，前面的偏移随即串位，写出错乱内容（历史 bug：`protocol.ts` / `use-chat.ts` / `ChatInput.tsx` 被写坏）。内置 `edit` 同样是先按 `matchIndex` 排序（`edit-diff.js`），此处对齐。回归测试覆盖全部 6 种排列。

**非法片段防御**：宽松匹配要求 oldText 每行都是完整行。（a）精确命中若跨多行却首/尾未落在行边界（如 `a);\nfoo(`），直接子串替换会吃掉行首/行尾残留写出粘连内容（`foo(z();b);`）→ 拒绝并提示按整行给；（b）宽松阶段整块对不上、且首/尾行只是某行的一部分时，报「片段」错而非笼统的「找不到」；（c）单行片段（如 `b();`）不改行结构，照旧支持。

`soft` 只在宽松分支生效（`applySoftEdits`）：SDK 的宽松匹配管不到**行首**缩进，这里正好补上；非 soft 调用零额外开销，也不改写 SDK 会精确命中的区域。

### read 覆盖：路径是目录时列出目录条目（`server/read-tool.ts`）

SDK 内置 `read` 只处理文件（`read("server")` 直接 `EISDIR: illegal operation on a directory`），SDK 自带的 `ls` 又不在默认活跃集（`["read","bash","edit","write"]`）里，模型要看一眼目录只能改用 bash。pi-web-ui 因此经 `customTools` **按名覆盖**内置 `read`（bash 覆盖是先例）：用 `createReadToolDefinition(cwd)` 拿原实现当基底，`execute` 里先判路径是不是目录 —— 是目录就分流到 SDK 的 `createLsToolDefinition(cwd)`（一行一项、目录带 `/` 后缀、排序与条目/字节截断口径与 SDK `ls` 完全一致），正文前置一行 `[Directory: <path>]`；其余情况（文件、图片、路径不存在、读取报错）原样转发基底，行为与内置一致。目录分支里 `limit` 是条目上限、`offset` 忽略。

开关 `readDirEnabled`（设置 → 工具页首行，默认开）：这是**行为开关**（read 本体的开/关在设置页「核心工具」区，走 ActiveSet；这里管的是覆盖层列举目录的行为，与 read 工具本体是否启用无关），不是 ActiveSet 开关 —— 因此不进 `tool-manager.ts` 的 `AGENT_TOOL_CATALOG`，覆盖定义每次调用实时读设置（改动即时生效、无需 reload），也不进设置预设。DSH 引擎无 customTool 注册面（工具来自 shipped preset），不支持该覆盖，快照里恒为 true。

参数上额外接受 `file_path` 作为 `path` 的别名（部分客户端/模型习惯发 `file_path`）：schema 里 `path` 仍必填，靠 `prepareArguments` 在校验前把只有 `file_path` 的调用归一成 `path`（两者都给时 `path` 为准），转发内置实现时也带上归一后的 `path`。前端工具卡头的路径提示（`web/src/tool-args.ts`）本来就同时认这两个名（SDK 自带 renderers 亦然）。

**基底也可能是第三方扩展注册的 `read` 或 `bash`**：SDK 的合并链是 `[...扩展注册的工具, ...customTools]` 逐个后写赢，所以覆盖层若直接进创建时的 `customTools` 就会**静默顶掉**扩展的同名工具 —— 而官方 `docs/extensions.md` §Overriding Built-in Tools 明写扩展可以覆盖 `read`/`bash`/`edit`/`write` 等。因此 `bash` / `read` / `write` / `edit` 四处覆盖**不在创建时注册**，改由 `server/tool-overrides.ts` 在会话建好后注入，基底优先取扩展实现 —— 详见下一节「覆盖与第三方扩展同名工具共存」。

### 覆盖与第三方扩展同名工具共存（`server/tool-overrides.ts`）

pi-web-ui 覆盖了 SDK 内置 `bash` / `read` / `write` / `edit`。SDK 的注册表合并链是 `allCustomTools = [...扩展注册的工具, ...customTools]` 再逐个 `definitionRegistry.set(name, …)` —— **后写赢**：创建时把覆盖塞进 `customTools`，等于让 `docs/extensions.md`「扩展可覆盖内置工具」那句承诺失效（第三方扩展的同名工具永远轮不到，且审查/沙盒类扩展被彻底架空，例如 `@buyong/pi-codex-auto-review` 的 bash 审查完全不触发，命令直接裸奔，issue #750）。

现在的做法：这四处核心覆盖在**会话建好后**由 `installToolOverrides(session, specs)` 注入 —— 逐个按名字从 `session.extensionRunner.getAllRegisteredTools()` 取扩展实现当基底（取不到才用 pi-web-ui 自己的完整实现），交给 `composeWith` 装饰后**前置**写回 `session._customTools` 并 `_refreshToolRegistry()`（与插件工具同步 `syncPluginToolsIntoSession` 同一手法）：

- `bash`：有扩展 bash → 保留扩展自身的一切定义与独有参数（如审查参数 `sandbox_permissions`），外层包裹宿主硬安全闸门（目标审查回合只读 / 审查者模式拦截 / 计划模式硬闸门 / 沙箱越界硬围栏 / 会话只读权限 / 审批规则引擎 / 插件守卫），并桥接 `bashKills`（使 UI 中断按钮可中断扩展内部命令）与 `applyHeadTail`；没有 → 原生可中断 bash 与 PTY 终端 bash 自适应分流（`makeAdaptiveBashTool`）。检测到扩展接管时通过 notice 告知用户终端接管已让位。
- `read`：有扩展 read → `withReadDirSupport(扩展定义)` —— 基底的 name/label/描述/参数 schema/`prepareArguments`/render 槽位全部原样保留，只补一句目录说明、一条目录指引与目录分支（目录分支仍复用 SDK `ls` 的排序/`/` 后缀/截断口径）；没有 → `makeReadDirTool()`（内置基底 + 英文描述 + `file_path` 别名）。转发基底时**不改写扩展的参数**（`file_path` 归一只属于内置那份，扩展自带 `prepareArguments`）。
- `write` / `edit`：有扩展同名工具 → 把它的定义当权限沙箱包装的**基底**（执行时先过只读 / 工作区外拦截与审批，再委托扩展实现）；没有 → 包装 SDK 内置实现。

四条不变量：① 扩展那份实现的 schema / 描述 / prompt 指引 / 渲染不被替换（扩展独有参数如 better-edit 的 `windows` 照旧可用）；② 覆盖项前置 ⇒ pi-web-ui **插件**注册的同名工具（也是 customTools、比覆盖层后写）仍是最后赢家，与改动前的相对顺序一致；③ 重复注入幂等（同名先剔除再前置）；④ 会话对象形状不符（SDK 改私有字段名）返回 `null`，按「覆盖没装上」降级（等价改动前行为，不会更差）；`extensionRunner` 缺失时同样退回内置基底。

`extractTargetPath()`（`server/approval-rules.ts`）：权限沙箱与审批规则要按「目标文件」判定，必须认三种写法 —— SDK 内置用 `path`、`read` 有 `file_path` 别名、部分扩展（`pi-better-edit` 的 `edit`）用 `file`；只认 `path` 会在叠上扩展实现后取到空串、被判成工作区内而**静默放行**。规则引擎的 `path` 字段走同一个函数。

开关仍是行为开关（`readDirEnabled`），不进 `tool-manager.ts` 的 `AGENT_TOOL_CATALOG`；DSH 引擎无 customTool 注册面，不接。工具定义提示词遵循纯英文约定（`tests/unit/tool-prompt-hygiene.test.ts`）。回归：`tests/unit/tool-overrides.test.ts`（基底解析 / 前置顺序 / 幂等 / 降级）、`tests/unit/read-dir.test.ts`（`withReadDirSupport` 的 schema、描述、转发与目录分支）、`tests/unit/approval-rules.test.ts`（`extractTargetPath` 与规则字段）。

### 审查者模式：自动委派（`server/delegate-mode.ts`）

「强制 AI 开持久子代理」的服务端实现，形态是**会话级开关 + 全自动路由 + 纯委派闸门**（默认关）：

1. **自动路由**（`ClientSession.dispatchToDelegate`）：`prompt()` 一进来就问它要不要接管 —— 开着就把这条文本转给**一个常驻落盘执行对话**（每会话一个，跨轮复用；与目标模式 2.0 的执行对话同一通道：`spawnSubagentConversation(..., persist=true)`，落盘、进历史、可续聊）。首轮的 prompt 直接交给 spawn 起步，**之后**每轮才 `sendUserMessage` 追加（首轮再发一次会被 SDK 拒：`Agent is already processing a prompt`）。主对话这一轮**不跑模型**，只发一条 notice。执行对话跑完 → 主对话一条 notice（带最后一条回复摘要 + 左栏可打开），**不做自动验收**（v1 口径：验收由人/主对话下一轮做）。
2. **纯委派闸门**（`withDelegationGate`，挂在与计划模式同构的三处：customTools 整列 / `write`·`edit` 覆盖 / 常驻终端 `checkSafety`）：写类工具、非常规 bash（复用 `bashCommandIsReadOnly`）、**派发类工具**（`spawn`/`delegate_task`/`set_goal`/…）一律拒。派发类也拒的理由与计划模式不同：那边是「别绕开只读约束」，这边是「派活是服务端的活，别自己再开一份上下文」。
3. **软约束**（`DELEGATION_SYSTEM_PROMPT`）：提示模型它是审查者、该干什么（定验收标准 → 看 diff/测试 → 接受或提下一轮要求）。

**与计划模式的优先级**：计划模式开着时**不自动派活**（计划模式已把 spawn/旁路工具全拒，再自动派活就是死锁），提示词段也只注入一条 —— 计划模式那一轮自己在主对话里出计划。DSH 引擎没有 customTools 注册面（闸门无处可挂）→ `setDelegateMode` 明确回 notice 拒绝，不静默失败。

状态：布尔随会话转录落盘（customType `delegate/mode`，回放见 `readDelegateModeFromSession`）；**执行对话 id 不落盘** —— 它是本进程内的活对象，重启后首条请求重建（宁可多一个执行对话，也别指向一个不存在的 id）。判定纯函数（单测 `tests/unit/delegate-mode.test.ts`），端到端回归 `tests/delegate-mode-test.mjs`（零 token，已在 smoke ALL 列表）。

落盘执行对话持有普通对话 runtime，与目标模式的执行对话共用项目计数。默认不限数量；只有显式配置 `PI_WEB_MAX_OPEN_CONVERSATIONS` 后，满员时派活才会抛错并提示关掉模式或先释放名额。

### 计划模式：只规划不实施（`server/plan-mode.ts`）

目标条**展开行**里有个 **计划** 按钮（`host:goal-plan` 槽位，DSH 引擎不渲染 —— 它没有 customTools 注册面，闸门无处可挂）。它经历了两次调整：① 从输入框工具条的开关（`host:composer-plan`）搬进目标条 —— 语义是「拿你在这个框里写的输入去做规划」，与目标同属一条线，所以只挂编辑行、**不进折叠药丸**；② 从「开关」改成**一次性动作** —— 点一下 = `set_plan_mode{true}`（开闸门）紧跟一条 `prompt`（把目标输入当消息直接发出去），两条同 WS 按序到达 → 本轮就在闸门里跑；输入为空则只开闸门不发消息。按钮不再有 `active` / `aria-pressed` 常亮态，和同列的「提炼」「发送」一个口径：「点一下直接发」。目标模式被关掉（`goalModeEnabled=false`，整条目标区不渲染）时它也跟着一起隐藏。闸门本身仍是会话级、热生效：开启后**本对话只调研 + 出实施计划，不做任何改动**，产物是 `plan_update` 步骤看板（PlanBoard）+ 计划正文。**关闸门的唯一出口是计划看板里的「开始实施」**（PlanBoard.tsx：`set_plan_mode{false}` + 发一条实施请求）—— 删掉开关语义后必须补这个出口，否则进得去出不来。**与目标模式正交**：目标模式是「让执行者把目标做完」，计划模式是「先别动，把方案给我」。

两层防护，缺一不可：

1. **硬闸门（`withPlanModeGate`，唯一的强制点）**：装饰在工具定义外层、`execute` 之前判定一次，比权限沙箱与插件守卫更靠外。命中即返回 `isError` 的工具结果（`details.planModeDenied`），把「写进计划、等确认」的替代路径回给模型。挂载点三处：① 整列 `customTools`（含 bash 覆盖、`patch`、`eval`、子代理派发与排程工具）；② `installToolOverrides` 注入的 `write` / `edit`（`toolOverrideSpecs` 的 `composeWrite`/`composeEdit`，`edit` 自身带 `soft` 参数）；③ 常驻终端工具的 `checkSafety`。关闭时只多一层布尔判断。
2. **软约束（`PLAN_MODE_SYSTEM_PROMPT`）**：`appendSystemPromptOverride` 按当前会话状态追加一段纯英文硬规则，切换开关时 `session.reload()` 重建，下一轮即生效。这段提示词真正的载荷是两条：
   - **禁代码倾倒**（`## Output shape` 段）：`NEVER write the implementation` —— 不贴整文件、不贴完整函数、不给「成品版代码」，只描述改哪些文件、结构、关键决策、风险、验证方式与第一步；代码只允许「棘手处的短片段（~20 行、至多两处）」。**这条是硬闸门的补丁**：闸门让模型写不出文件，模型就会把整份实现当正文吐出来（烧 token 又没落地，实报过一次「让它写单页贪吃蛇，上来就贴几百行源码」）。注意回归：提示词段内禁中文（`tests/unit/plan-mode.test.ts` 有 CJK 断言，写「开始实施」这类 UI 字样要改写英文）。
   - **小需求走短计划**（`## Plan board` 段）：只有「3+ 步或有真未知」才先 `plan_update` 列 pending 步骤；「写个单页贪吃蛇」这类小而明确的需求**跳过看板**，直接给短计划（要动哪些文件 / 结构 / 验收 / 第一步），省一轮工具往返。

   提示词正文可在**设置面板 → 提示词 → 计划模式提示词**改：`planModePromptMode`（append/replace）+ `planModePrompt`（自定义正文），语义同视觉桥 / AI 提交信息（空自定义 = 内置默认，replace 下输入框预填内置默认供直接改），`buildPlanModePrompt` 纯函数拼装（单测覆盖三种组合）。**只改提示词，硬闸门不受影响** —— 服务端只读约束永远生效。该项不进设置预设（同 scmCommitMsgPrompt）。

判定纯函数（单测 `tests/unit/plan-mode.test.ts`）：`planModeDenial(toolName, params)` 分三类 —— **写类工具**（`write`/`edit`/`patch`/`rm`/`git` 等名单）直拒；**bash 只读白名单**（`splitShellSegments` 按 `;`/`&&`/`||`/`|` 切段，每段都要过：禁重定向 / 命令替换 / 后台 / heredoc，命令在白名单内，`git` 只放 `status|diff|log|show|blame|…` 等只读子命令，解释器只放行 `--version`/`--help`）—— 刻意保守，宁可拒一次让模型换命令；**旁路工具**（`spawn` / `delegate_task` / `set_goal` / 排程等）也拒：闸门是**会话级**的，子代理对话的 `planMode` 是 false，放行等于留后门。

状态随会话转录落盘（`plan/mode` 自定义条目，回放见 `readPlanModeFromSession`，与 `permission/preset` 同口径），切会话/重载恢复；快照字段 `UiState.planMode` 恒给布尔（用 `undefined` 会在 `snapshot_delta` 里丢键，前端 spread 合并会残留上一对话的 `true`）。已知边界：插件 / MCP 自带工具不经这三处挂载点，只受软约束约束。回归：`tests/plan-mode-test.mjs`（零 token：开关快照 / 写类被拒 / bash 读写分流 / 关闭后恢复 / 转录落盘）。

### 模型操作浏览器页面（`browser_page` 工具）

让模型直接读/操作你在浏览器里打开的页面（详见 `plugins/page-picker/README.md` 的「AI 操作页面」）。
**四段链路**，缺一段都不通：

```
模型 ── browser_page 工具（server/agent-service.ts makeBrowserPageTool）
  │   参数：op（pages/read/click/type/scroll/goto/wait/eval）+ target/origin + 各动作参数
  ▼
ClientSession.pageCall()  ── 发 page_request（带 id + timeoutMs，默认 30s/上限 120s，**有空闲超时**）
  │   没有「人类在等」，所以不进看门狗豁免；前端不在线时直接给可执行的错（“打开 pi-web-ui 页面”）
  ▼
浏览器里的 pi-web-ui 页面 ── use-chat.ts 收到 page_request → 宿主桥 `window.__piWebUiHost.pageCall()`
  │   （web/src/plugin-host.ts 的 `pageCall()`，宿主 API 自 v3 引入、当前 v11；桥不在就给一句“装/启用 page-picker 并刷新本页”）
  ▼
page-picker 扩展 ── content script → service worker → chrome.scripting.executeScript(world:MAIN)
  │   准入：sender.tab.url 必须是「已绑服务地址的 pi-web-ui 页面」+ 目标在扩展的授权列表里 + op 过白名单
  ▼
目标页面 ── 内置动作（read/click/type/...）在页面主世界里执行，结果原路回到模型（page_response）
```

**为什么另一端固定是 pi-web-ui 页面**：扩展只能被浏览器里的东西调（模型在服务端进程里），而
`window.__piWebUiHost` 是现成的、已认证的页面内桥（插件系统用了同一套）。代价：那个标签页得开着；
好处：服务端零新增监听、天然复用登录态，而且**人类看得见模型在动哪个浏览器**。

**协议**：`page_request`（server→client，`op` 由扩展解释、服务端只透传）/ `page_response`（client→server）。
不进快照（没有要人回答的东西；刷新即这次调用失败）—— 与 `question_pending` 的区别就在这。

**引用到对话（人在环中的入口）**：`web/src/components/BrowserControl.tsx` 把已授权页面做成
「网页引用」附件（`mode:"page"`，`path` = 页面 origin、`name` = 标题）；**只授权一个页面时顶栏按钮直接
变成该页面标题**（点主体=引用、右侧 ▾ =打开面板），多个页面时面板里每项都有「引用到对话」。
服务端 `attachments.ts` 对 `mode:"page"` **不 stat / 不读文件**，只给模型一句 `<browser-page url title>`：
「这个页面已授权，用 `browser_page`、`target=<origin>`」—— 用户不必在话里手打网址。
**截图**（`op:"shot"`）不走页面执行：`captureVisibleTab` 只能截活动标签页，且只认 `<all_urls>`
或 activeTab（普通 host 授权不够）—— 所以扩展先切页、截、裁（`planCrop`）、**切回**，并且
需要用户在扩展里额外授一次「所有网站」权限。图片回给模型有两条路：主模型能识图就在**工具结果里**
直接带 image block（当轮可见）；纯文本模型走 `ClientSession.transcribeToolImage()` → 视觉桥转写成
文字证据（与用户附件同一套选择逻辑与提示词）。

**闸门全在扩展侧**（授权表 + 白名单 + 总开关 + eval 开关）：服务端不做动作白名单，否则
「扩展能做什么」就散落在两处了。

**入口在网页侧**（顶栏「浏览器」按钮 + `web/src/browser-control.ts` + `BrowserControl.tsx`）：
能力在扩展里，网页只能做三件事 —— 报状态（扩展动作 `status`）、把人送到扩展设置页
（动作 `openOptions`，因为网页不能自己导航到 `chrome-extension://`）、给可照抄的例子。
状态是**按需查询**（不进快照流）：挂载后查一次 + 打开面板时刷新 + 45s 轮询。
模型在目标页面上动手时，页面右下角会闪一条「AI 正在操作本页」的提示（挂 shadow DOM、
pointer-events:none、2.2s 淡出），避免用户以为页面自己在动。回归：`tests/unit/browser-page-tool.test.ts`、
`tests/unit/page-picker-ai-ops.test.ts`、`tests/page-picker-bridge-test.mjs`、`tests/page-picker-edge-ext-test.mjs`。

### 扩展 UI 桥

扩展的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 消息；对话框经 `dialog_response` 回传，Esc 视为取消。`Dialog.tsx`（扩展对话框）与 `QuestionDialog.tsx`（共用模型问卷）的正文/选项/详情/预览都走 `Markdown(rawHtml)` 富渲染（markdown + 原始 HTML 混排，模型自选、信任模型；默认 `rawHtml=false` 的聊天正文渲染不受影响），可选项 `preview` 展示「选项预览」框。

**widget / status 按会话归属（issue #952）**：整个进程只有一个 `WebUIContext`，所有会话的扩展都往它上面 `setWidget`，早先只按 key 存 → 同名 key last-writer-wins，切会话时 `refresh()` 又是「内容没变就不发」，于是右侧面板会一直挂着上一个会话的清单（issue 报的「Todo list 不同步」就是这个）。现在：条目带 `convId`（`null` = 全局，只有内置 `markers` 这类渲染时自读 `activeId` 的组件用），每个会话的扩展经 `webUi.forConversation(conv.id)` 拿到打了归属的门面（必须是 own 属性覆盖：SDK 拿到 uiContext 会 `{...ui}` 复制一遍，Proxy 的拦截会被 spread 抹掉）；`snapshot()/refresh()` 只渲染当前会话 + 全局条目，**切换会话时强制重推一次 widgets + statuses**（切到没有 widget 的会话也要把面板清空），轮询里顺手清掉已关闭会话的条目（`isConversationAlive`）。根 context 上的 `setWidget` 归属「当前会话」，不再当全局。回归：`tests/unit/webui-context.test.ts`（「跨会话 widget / status 隔离」7 条）。

`snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。

### Durable 引擎的数据来源：只认 AgentEvent，不读 `pi.live` 槽位（`server/durable/durable-event-projector.ts`）

Pi Durable（`@earendil-works/pi-durable`）把同一件事分成两份投影，**职责不能混**：

- `pi.live`（`conv.watch()`）是**廉价可剪的运行期进度投影**：工具槽位只有 `running` 期间带 `output`，结算即被剪掉；
  槽位**从不携带 `input`**（模型发起调用的入参在工具任务的 `state.checkpoint` 里）。因此抓槽位拿不到入参、也拿不到回执。
- `watchEvents(harness, conversationId, ctx)` 才是权威事件流：`tool_execution_start.args`（引擎已从 checkpoint 解析好，
  嵌套调用直接给槽位的 `arguments`）、`tool_execution_end.entry`（模型调用，`model[0]` 是 ToolResultMessage）或
  `.result`（嵌套调用）、`message_start/message_update/message_end`（正文与思考）、`tool_execution_update`（进度输出）。

历史坑（#774）：驱动曾对 `pi.live` 做差分，读 `slot.input`（永不存在）与结算后的 `slot.output`（已剪），
导致工具卡命令空、结果空，并同链路污染落盘会话（`argumentsText: "{}"`）。现在全部改由 `DurableEventProjector`
投影事件流：按 `contentIndex` 记账已下发的正文/思考长度（流式增量与最终整段落盘不重复不丢字），
工具回执「成功只带 `output`、失败只带 `error`」向下游对齐；嵌套调用（`parentToolCallId`）不单独出卡片，
保住「一个父调用一张卡」的展示口径。回归：`tests/unit/durable-event-projector.test.ts`（含驱动不得再读 `slot.input/slot.output` 的守卫）。

### Correlated host conversation creation

Host startChat/openSession sends new_chat with an optional requestId and waits for new_chat_result carrying the same requestId and the exact conversationId captured by the engine on creation/reuse. Rejection, missing ACK or timeout cancels prompt delivery; observing an unrelated conversation switch is never sufficient. Older clients may omit requestId. Prompts may include targetConversationId (the UI conversationId, not the SDK sessionId); dispatch rejects a mismatch against activeConversationId before synchronously entering prompt. Engines capture the conversation before awaits and reject stale targets before entering streaming state.

Device center setup keeps remote read-only guidance available when local pairing APIs are forbidden. Setup metadata restores installed URLs; unsuccessful status queries do not imply absence. Installed but unhealthy or unowned centers show CLI diagnostics rather than reinstalling. Installation continues on the server when the page is left; reopening and reloading metadata restores progress and pairing actions.

