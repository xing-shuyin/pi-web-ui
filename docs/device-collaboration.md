# 群组 / Bot / 跨设备协作硬约束

> 服务端架构与部署链路见 [`device-center.md`](device-center.md)（Hub 与本机连接器、绑定与配对、部署）
> 与 [`device-center-deployment.md`](device-center-deployment.md)；远程桌面实现细节见 [`device-desktop.md`](device-desktop.md)；
> 分块文件同步细节见 [`device-file-sync.md`](device-file-sync.md)。
> **本文只收录「改代码时必须遵守」的硬约束**（原 `AGENTS.md`「设备中心与跨设备协作」整段迁入）。

## 1. 设备中心入口与本机 Hub

独立 Hub 与本机连接器位于 `server/device-center/`，部署与边界见 [`device-center.md`](device-center.md)。主界面「设备中心」为原生 `devices` 视图（`DeviceCenter.tsx`），旧 `/devices` 重定向到该视图；未绑定时通过进程内私有 loopback Hub 支持本机 Bot/群组（`local-hub.ts`，数据与外部绑定隔离），概览保留群组管理及连接/创建引导，离线或请求失败不得清空已知群组；本机 Hub 安装走 `hub-setup.ts` 的 loopback 同源接口与独立 Hub CLI，必须验证参数、隔离数据目录、互斥执行并在关闭时取消等待；配对接口仅允许回环来源与同源写入；群成员统一为 Bot，设备仅负责承载与连接。

## 2. 群任务派发与上下文

群任务优先派给显式 @ 的稳定 Bot ID；可选 `primaryBotId` 接收未指定目标的人类消息并续接该 Bot 最近有效会话，Bot 公开消息不触发默认派发，移除主 Bot 时清除设置。`group-context.ts` 冻结主 Bot 身份，执行器按群与 Bot 双重匹配注入协调职责，使用已有持久会话和相关请求回复完成委派，角色不扩张权限。机器人接力继承父任务预算，禁止无界互派。Hub 持久化分两层：`device-hub.json` 为索引（`version: 2` 同 schema，`messages`/`tasks`/`conversationMessages` 为空数组），消息、任务与转录写入 `hub-log/` 下按群/按会话的追加日志；每笔事务先将索引与三个集合的增删差量写入 `hub-wal.jsonl`（递增序号与内容校验和），刷新到磁盘后才算提交；随后更新追加日志（`upsert`/`del` 行），最后原子替换带 `checkpointSeq` 的索引并清理已投影 WAL。投影失败不撤销已提交事务，必须保留 WAL、推进已提交内存版本，并在后续写入或重启时幂等补投影；不得复用序号或把已提交结果报告为普通失败。墓碑达到阈值后按存活行压缩，加载时按群保留 500 条并修复崩溃半行；WAL 完整行损坏须拒绝打开，仅不完整尾行可以修复。`readPersistedHub()` 只在内存重放，不修文件、不创建目录。旧版内联数据在 `open()` 时自动迁移；回退旧版本前必须导出完整状态（旧版读索引只能看到空集合）。群上下文由 `group-context.ts` 在派发前冻结，近期公开消息随任务传输（24 KiB），普通聊天不重复落盘；显式契约任务将实际选入的上下文封存到下述 Manifest；`device_collab read_history` 按稳定游标回查原文（每群保留 500 条，超长消息可分段），必须验证来源 Bot 的设备、账号及群成员身份；清空/淘汰使旧游标失效。历史是参考数据，不能授权派发或执行。人类消息未显式给出 `targetBotIds` 时，由 Hub 按群成员解析正文 `@Name` / `@Name(<id>)`；同名多成员不猜、非成员不派发，不因客户端未解析而回落到主 Bot。消息可携带 `replyToMessageId`，必须指向同群消息。

### 2.1 版本化契约与代码任务

`device_collab` 的 `send_task`、`conversation_create`、`conversation_send` 以及对应 Hub / 本机代理入口接收 `executionMode` 和嵌套 `contract`。缺省模式为 `chat`。`code` 必须提供确定的 `baseline: { repositoryId, commit }`；commit 为完整 SHA，repositoryId 由本机规范化网络 origin（剥除凭据，保留仓库路径大小写）或无 origin 仓库的全部排序根提交摘要推导，不能用任意标签或本机路径代替。常见 SSH、SCP 与 HTTPS 默认端口地址可映射到相同 host/path；本地、file 与未知传输 origin 明确拒绝。`contract` 支持业务 `id`、递增 `revision`、目标、约束、验收条件与有序 `inputArtifacts`。Hub 计算内容摘要；客户端不能提供权威 Manifest 或审批证据。相同幂等键的精确重试复用契约，内容冲突拒绝；同一业务 id/revision 只能对应一个内容摘要；旧版本仍 queued、running、持有已发租约或处于恢复窗口时，新版本请求返回 409。旧版本结算后才可创建新版本；已提交旧结果丢 ACK 后仍可精确重放确认，旧业务版本不能为新版本提供接受证明。

`work-contract.ts` 是契约、`ContextManifest` 和 `DeviceArtifact` 的摘要与验证入口。契约任务首次派发前，将实际选入的群上下文、taskState、有序输入产物 id/digest 引用、执行设备/Bot/revision 的策略引用和实际预算连同契约版本一次封存到任务事务。延期、重试与重启派发使用原 Manifest，不重新选取历史。摘要覆盖规范 JSON，输入必须复制并深度冻结；未知字段、损坏摘要和不匹配的契约引用均拒绝。

`task-workspace.ts` 将源仓库、设备、Bot revision、task/attempt、契约和 Manifest 摘要绑定到本机注册的 opaque handle。网络传入的目录或仿制 JSON 不能成为执行能力。本批代码任务要求 Bot.cwd 为本地 Git 顶层目录、源 checkout 干净，且工作区数据目录位于源仓库之外；子目录 Bot 明确拒绝且不留下临时工作树，Canvas 原有子目录行为不变。代码任务沿用按 Bot 与源根的保守调度锁，创建隔离工作树不自动放宽并发。代码任务使用新执行会话，真实工具 cwd 必须来自经过验证的 handle；不得在另一工作区恢复旧转录。基线、HEAD、Git common-dir、gitdir 回指与真实路径须在跨 await 的关键边界复核。工作树只隔离修改位置，**不构成文件系统或网络安全沙盒**，原有工具权限与审批继续生效。

契约 JSON 上限 256 KiB，Manifest 上限 96 KiB，契约创建请求上限 384 KiB；输入产物至多 8 份且受契约总量限制。已封存的 context/taskState 只随 Manifest 传输，外层不重复复制；派发前按完整 JSON 帧检查 512 KiB 上限，超限拒绝投递且不切断设备连接。输入产物携带内容与 SHA-256，不能引用发送设备的本地路径。每份输入补丁先证明其从声明基线生成的 outputTree，再按契约顺序合成；冲突、篡改或过大补丁明确失败。本批支持累计补丁的单父链与多个不重叠输入；将某祖先及已包含它的后继同时作为输入会显式冲突，不自动推断或去重依赖图。空补丁是合法的无修改产物。输出为从固定 baseline 到 outputTree 的累计 binary patch，同时记录本次执行的 inputTree；原始补丁上限 128 KiB。首次捕获固定产物身份与摘要，重发不得重新生成。Git retention ref 保留基线与产物对象，用户源 checkout 和 index 保持不变。准备与快照期间禁用 hooks、fsmonitor 以及所有配置来源的命令过滤器；快照按原始文件字节生成，避免隐式 clean/smudge 转换。

执行结束、产物捕获、独立验证、交付接受是四类不同事实。代码执行阶段记录 `executionCompleted`、`artifactProduced` 和产物内容；独立验证与交付接受使用下节的 Integration / Review 证据闭环，不因终态 `completed` 或 Bot 自报检查自动成立。代码任务必须在确认执行器停止并成功捕获产物后才能报告完成；捕获失败仍可保存执行已结束这一事实。产物和证明进入持久 Outbox、终态指纹及 Hub 的不可变接纳记录，ACK 对应实际提交内容。

若 Hub 已持久结算其他终态，或原 attempt 已永久失效，设备收到绑定原 task/attempt/status/fingerprint 的永久拒收回执后，将完整原结果与有限原因码原子移入持久隔离区；此后不继续重放该条，也不妨碍其他结果上传。字段或摘要不匹配、一般请求失败、网络错误与持久化错误不得触发隔离。隔离区独立限制为 128 条 / 2 MiB，满时保留原待发结果并拒绝继续清除；不会淘汰旧证据。统一 `task-recovery-state.json` 写为 version 2，兼容读取 version 1 及旧双文件状态，隔离区与活跃租约、待发结果同次原子提交，总状态文件上限 8 MiB。回退不认识 version 2 的旧设备代码前须备份并转换全部恢复状态，不能删除隔离区以绕过检查。

所有显式契约任务及其会话（包括聊天契约、无产物的失败代码任务）均不受普通 500 条历史 / 已关闭会话裁剪影响，重启加载也必须保留；契约身份和最高版本不能因历史裁剪消失。普通无契约聊天仍按原策略保留。历史页面及工具结果只展示有界的契约、Manifest、产物身份与独立事实，原任务保留完整证据。`device_collab task_evidence` 使用 `evidenceKind: "artifact"`、`taskId`、`expectedDigest` 和字节 `offset` / `limit` 分页读取原始补丁；每页最多 24 KiB 原始字节，返回 base64 内容与补丁 SHA-256、产物摘要及来源 metadata。读取必须通过同账号、设备、群与会话校验，后续输入须重组完整内容并校验摘要。自动清理不得删除脏工作树或额外提交；已捕获产物的 retention refs 暂不自动过期，显式清空或删除群会清除 Hub 侧的契约、会话和证据记录并重置该群的业务版本权威，设备仓库中的保留对象需要另行显式维护。

### 2.2 产物验证与按契约验收

沿用 `Delivery → Integration → Review`，不另建验收集合。当前运行中的作者 Bot 可用 `conversation_deliver` 的 `artifactTaskId` 登记同一会话内、同 Bot / revision / 设备先前完成的代码产物；当前任务提供写入权限，已完成任务提供不可变产物身份，二者不得混用。Hub 从已提交任务派生 `artifactRef` 和封存的 `acceptanceCriteria`，不接受调用方自造引用、摘要、criteria 或验证结论。产物交付不需要也不伪造 commit；旧 commit 交付继续要求 repository、完整 baseCommit / commit 与自报 checks。

产物可在验收前准备 Integration。设备核对规范仓库身份、基线、累计补丁与 outputTree，物化真实 Git commit 后复用现有临时合并与 CAS 适配器；本阶段要求目标分支 HEAD 等于产物基线，preparedTree 必须等于 outputTree，不自动 fetch、变基或合并已前进的目标。inputTree 仅用于审计，补丁始终从 baseline 重放。公开记录只携带产物引用和摘要，原始补丁仍经受控证据入口读取。`task_evidence` 按 deliveryId 读取产物时必须定位该交付的 artifactTaskId，显式 taskId / expectedDigest 冲突应拒绝。工具摘要保留每条完整条件并标明 `acceptanceCriteriaCount` / `acceptanceCriteriaTruncated`，不得把截短的条件当作完整要求。条件总量超出摘要预算时，用 `evidenceKind: "acceptance"`、deliveryId 和 `expectedDigest: artifactRef.contractDigest` 按字节分页读取封存数组的规范 JSON，每页至多 24 KiB；重组 base64 后验证 criteriaDigest，再解析全部条件。

验证命令计划由已鉴权的账户所有者在验证界面首次明确提交并冻结，包含有序 commands、内容摘要、授权账号和时间；Bot 调用身份必须保留到 Hub 判定，不能将 Bot 请求当作账户所有者授权。Bot 只能重用既有且完全相同的授权计划。模型文本、自报 checks、补丁内的 package.json 或一个正确摘要都不产生命令授权。设备仍核对目标 Bot 的工具 / 命令权限、revision 和根占用；验证只运行受信计划中的前台命令，单条最多 300 秒、总计 600 秒，输出有界并记录摘要；RPC、代理与界面的截止时间统一由 `verification-limits.ts` 留出停止及传输余量。工作树不构成恶意代码安全沙盒。

真实验证结果必须包含与计划完全同序同数量的检查、退出码、输出摘要、物化 commit，以及执行前后树身份。只有全部 exitCode=0、检查状态一致且前后树均等于 preparedTree 时，Hub 才能按白名单事实计算 verification 摘要。单独的 verified 状态、空检查或漏项不能构成凭证。每个 Integration 的成功凭证不可被重验覆盖；需要不同计划或重新验证时新建 Integration。

独立 Review 必须绑定 delivery 的 artifactDigest、integrationId、verificationDigest 及同一契约 / Manifest。accepted 还须按封存 acceptanceCriteria 的索引逐项提交 `criteriaResults: { criterionIndex, verdict, evidence }`，完整覆盖且全部 met，作者不能评审自己的交付。changes_requested 可以先于成功验证，但仍绑定确切产物。契约升级、设备 / Bot revision / 群成员变化、错误产物或其他 Integration 的凭证不能为当前交付提供接受证明；纯 commit 相等或两个缺失 commit 相等都不能匹配产物 Review。

确认集成的所有模式都要求真实成功凭证，不能从 prepared / failed 直接应用，也不将旧的无凭证 verified 标志升级成可信证据。产物还要求当前匹配的 accepted Review 与契约版本。开始 apply 前冻结证据身份，并阻止同一交付 / Review / 契约在未关闭的发布意图存在期间被替换；发出新的写操作前重核 operation、成员身份与目标。已授权写操作的历史结果按原意图核验，发布后的权限变化不会抹除已发生的效果。设备确认前再次核对验证凭证、工作树、preparedTree 和目标 SHA。取消先中止并等待拥有的进程树停止，再清理；停止无法确认时保留根占用、Bot lease 和工作区，不报告成功或强制删除。账户所有者可按原持久会话身份取消旧集成，目标 Bot 被禁用、换 revision 或移出群不会授予新的执行权限，也不应阻止单纯停止与清理。升级前完全缺少明确停止标记和真实验证凭证的旧会话，会保守隔离对应 Bot / 根；只有 Hub 明确记录为 prepared、尚未启动验证的旧现场可按原身份取消。旧 failed 也可能来自未确认停止的超时，不能据此自动清理；其他不确定现场需要本机维护者核查，不自动删除或据缺标记放行新任务。发布意图、设备持久回执及回查规则见下一节。

### 2.3 发布意图与崩溃后回查

Hub 在首次发送发布 RPC 前，先通过现有 WAL 事务持久保存不可变 `publishIntent`。意图绑定原账号、群、会话、Integration、设备、Bot revision、交付与 Review 快照、真实验证凭证、仓库身份、目标 ref、旧提交和待发布树。共享原始 Git commit 构造器以固定身份、时间、父提交顺序及含意图摘要的消息计算唯一候选提交；重试不得重新生成不同提交。协议为 48。包含摘要与候选 SHA 的完整意图按实际序列化 UTF-8 字节限制为 384 KiB；各字段单独合法但总证明超限时，Hub 在意图提交与 RPC 前明确拒绝，避免触发 512 KiB 中继帧上限。构造器识别 SHA-1 / SHA-256 对象格式，但代码产物路径的既有 SHA-1 限制仍然适用，不能由构造器支持推导出全部产物链支持 SHA-256。

设备发布日志独立于验证会话与临时工作树。日志先预留有界记录，再创建候选对象和保留 ref；CAS 前持久记录 `cas_started`，确知 CAS 成功后持久记录 `publishReceipt`，再返回或清理会话。日志损坏、容量不足或保存失败会阻止新的 CAS，未决记录与取消栅栏不会自动淘汰。候选保留 ref 使关联树和父提交不因工作树清理或通常的 Git GC 丢失。文件采用原子替换并刷新；该恢复承诺覆盖进程崩溃。Windows 目录元数据与 Git 对象闭包的掉电持久性不在此承诺内，不能等同于主机突然断电后的完整事务保证。

`publishReceipt` 表示已观察到的历史发布效果，保留 `cas_exit`、`target_exact` 或 `target_descendant` 的证明来源；看到候选或后代不单独证明是谁执行了写操作。`publishObservation` 单独记录当前目标 ref，后续移动不会把历史回执改成失败。`conversation_read` 的工具摘要只投影意图标识、候选 SHA、回执来源、当前观察和停止事实，保留现有输出预算；不复制完整封存证明、私有仓库路径、进程 ID 或原始日志。CAS 已开始但没有回执时，即使分支仍等于旧 SHA，也不能证明发布从未发生：它可能被其他操作者回退。此时保留未知，不自动重试或覆盖外部修改。

启动、设备重连和手动 `POST .../integrations/:id/reconcile` 只查询原发布日志与仓库身份。Git 回查不创建对象、ref、工作树或提交，不运行验证，也不执行 CAS；它不依赖原工作树仍存在、当前 Bot 仍启用或新的执行 lease。对未知结果的回查可以补存证据，但不会自动续发写操作。重复 apply 在已有意图时返回当前记录，不能充当隐式重试。

只有持有账号所有者身份的人工请求可以调用 `POST .../integrations/:id/resume`，并须提交完全匹配的意图 ID、摘要及候选 SHA，通过当前权限与版本校验。设备还必须有持久证据证明 CAS 尚未开始，或已经明确拒绝且确认停止；`cas_started` 后结果未知不满足恢复条件。Bot 凭证不能恢复未知发布。取消先在同一操作门禁内持久封闭未来写入，迟到 confirm 也受栅栏约束；CAS 已成功则返回已发布事实。`publishStop.closed` 只表示未来写入已封闭，`stopConfirmed` 单独表示原发布子进程已确认停止；`fencedAt` 与仅在正向停止证明下存在的 `stoppedAt` 分开记录。若不能判明过去效果，保留 `publishStop.pastEffect = unknown`，界面展示历史结果未知，不能解释成确定未发布。发布子进程停止未知时，原 Bot / 根占用继续隔离并持久恢复；验证进程的停止标记或从分支推断的发布回执都不能替代发布子进程停止证明。本批对重启后无法确认停止的 Git 子进程采用保守隔离，需本机维护者核查，未扩展为 Git Job 监管。

旧的已应用记录保留原有历史标记，不补造意图或回执；缺少意图的旧进行中记录不自动发布，也不从旧状态推导新证据。工作树、进程监管与日志不是安全沙盒；第三方直接修改仓库、同账号恶意进程及 POSIX 自行脱离进程组仍受既有边界限制。

## 3. Bot 注册表与持久会话

`bots.ts` 按本机设备身份保存 Bot 的固定项目根、角色、模型及工具/Skill/MCP 白名单；群使用 `botIds`，消息使用 `targetBotIds`，任务与 `device_collab` 文件同步共用 Bot registry lease/revision；执行会话不得冒用其他 Bot。群 Bot 持久会话由 `hub-conversations.ts` 登记稳定地址及不可变的委派来源（sourceBotId/sourceConversationId/parentTaskId），新建与继续均可携带关联请求，设备 `runtime.ts` 原子保存精确转录映射，恢复须验证 Hub/设备/群/Bot 版本/目录；仅精确能力路径允许 `switch_session`。

## 4. 并发、调度与进度推送

同设备默认 4 个执行 + 32 个等待，可配置并发 1–16、等待 0–128，按群公平调度；房间公平历史持久化到设备数据目录 `task-scheduler-state.json`（防抖原子写入、重启恢复、损坏按中性启动）；按 Bot 与真实路径重叠工作区串行，独立工作区可并发；同一会话继续消息在前轮终态后投递，不打断工具。群进度经有界、按 attempt 校验的 SSE 推送，断线回退轮询并重同步；原生问卷与一次性工具审批使用任务绑定交互桥。请求/回复绑定原始会话与 requestId，结果只唤醒原发起者，自动继续共享任务链预算，人工新输入可开新链。忙碌或停止未确认时禁止换根，旧文件包不得落入新根。

## 5. 文件同步

文件同步先暂存预览后按 revision 导入，已有差异必须显式覆盖；`sync_files recursive:true` 支持有界目录传递，拒绝软链接/联接，跳过敏感/忽略项须返回排除摘要，不删除目标文件；凭据不得进入工具回执。

## 6. 远程页面隔离与跨设备代理

Hub 默认单端口 `/device/<id>/` 路径访问设备，以 CSP sandbox（禁止 allow-same-origin）与设备专属随机能力路径隔离远程页面；旧独立域/端口保留兼容。跨设备代理只放行账号范围群聊接口，不得暴露本机绑定、目录与设置接口。

## 7. 群任务恢复与报告

群任务恢复由 `task-recovery.ts` 管 task/attempt/lease 认领与持久终态 outbox，网络断开保留持有租约的本机执行，Hub 重启提供有界认领窗口；设备进程崩溃不盲重跑副作用。设备租约与终态统一保存在版本化的 `task-recovery-state.json`：完成时一次原子替换同时加入结果、移除租约，恢复中再次崩溃也必须保留可恢复记录；旧 `task-active-leases.json` / `task-recovery-outbox.json` 只在新文件写入成功后清理，损坏状态不得覆盖。记录与重放按 Hub/设备身份隔离，执行前为活跃租约预留结果容量。相同 task/attempt 的结果不可变：同内容重放幂等，不同内容拒绝；终态传输使用持久条目，ACK 必须绑定 Hub 已持久结果且与条目匹配，禁止未经结算确认直接回显请求摘要或无摘要删除结果。旧摘要格式仅用于兼容已持久结果；新摘要按字段明确编码，避免文本分隔符歧义。

v0.116.0 的旧 `task-recovery-outbox.json` 在完成时未保存 leaseToken/generation，并已删除对应活跃租约；迁移不会凭 attemptId 或旧摘要补造租约。此类结果只在连接凭据认证通过、设备/账号/Bot/群/attempt 全部匹配，且 Hub 已持久的终态、报告、错误及报告元数据逐字段相同时得到幂等正 ACK，不修改结果、租约或触发下游；不得借此补写产物或执行证明。确认后回传条目原有旧摘要，即使 Hub 已保存新摘要也能清除此条重放。尚未结算的旧结果因无法证明租约，收到 `legacy_lease_missing` 永久负 ACK；已结算但内容不同使用 `terminal_conflict`，过期 attempt 使用 `attempt_expired`。设备按原 task/attempt/status/fingerprint 校验回执后，把完整结果和原因原子写入 version 2 的持久 quarantine，重启及重连不再自动发送该条，连接继续服务其他任务。`legacy_lease_missing` 表示需要人工恢复核查的失败：维护者可从隔离记录取回报告、核验实际副作用后决定后续处理，不能将其当作任务成功，也不能直接重新执行原副作用。新任务及任何携带错误或不完整租约的结果仍执行原有 token/generation fencing。

终态接纳校验 task/attempt、Bot/设备身份与已颁租约 token/generation；旧执行不得覆盖已停止任务或推进新任务。创建、完成和启动恢复共用依赖就绪规则：前驱 completed 才可放行，失败、取消或中断必须阻塞或级联终止，不能只检查“前驱已终态”。未发出租约的 queued 任务可恢复派发；已颁租约但尚未持久 running 的 queued 任务也可能在执行，必须进入认领窗口，不能立即换代重派。窗口到期统一幂等结算，并通知父任务与下游。排队任务本身作为持久派发意图，内存中的已发送集合只能防当前进程重复发送，不能承担恢复事实源。原始完整报告由独立 `task-report-outbox.ts` 持久后分块上传，结果 ACK 不能误删未上传报告；事件、报告与详情见 `task-journal.ts` / `task-report.ts`。**审计流空态不是错误**：任务存在但从未写入 journal 分段（排队中、首个进度事件前失败、早于日志功能）时，Hub `GET /tasks/:id/journal` 返回 200 空页（`items: []`，附加 `journalUnavailable`），只有任务/群不存在才 404；UI 的详情与日志必须独立加载，日志降级不得清空任务概览。**本地代理必须透传 Hub 的已脱敏失败原因**（`scrubHubMessage` 抹掉已知凭据与令牌样式串后回传 `error` + `hubStatus`），禁止把 4xx/5xx 统一塌缩成固定的「Hub rejected group request」。群计划复用只读硬闸门，本轮成功 `plan_update` 与最终计划匹配并获 Hub 确认后才就绪，人类批准另起实施轮次。画布绑定与 Bot 预设须校验真实 graph/cwd 和 registry revision，不以引用自动运行或热改在途权限。分块文件传输的暂存与后台任务必须绑定 Hub/设备/群/Bot/revision/真实目录；停止未确认禁止继续，双端实际 I/O fence 确认后才释放。

## 8. 交付与审查（交付 ≠ 验收）

群组开发交付独立于执行状态：`completed` 不代表验收通过。交付与审查协议统一在 `server/protocol.ts`，Bot 交付必须绑定自身运行任务、稳定对话及完整提交 SHA；审查绑定交付 ID 与 SHA，禁止 Bot 自审，新版本不得沿用旧版本验收。检查来源固定为 `bot_reported`，不得声称宿主或 CI 已验证，不自动执行声明的命令或合并。人类可启动独立集成流水线：目标设备固定 Bot 工作区创建隔离预合并，显式选择验证命令，最后确认按目标 SHA 原子更新；目标分支在任何工作树被检出时拒绝，禁止 hard reset 或自动推送，集成会话与操作代次须持久并绑定 exact delivery/review/Bot revision。交付/审查先持久化，幂等冲突明确拒绝，有界历史不得静默淘汰。详情见 [`device-center.md`](device-center.md)，完整回归 `tests/device-project-collaboration-test.mjs`。

## 9. 远程桌面

设备中心远程桌面由 `desktop.ts` 经既有 WebSocket 传输原生 JPEG，`desktop-native.ts` 管 Windows/macOS 助手，`desktop-linux.ts` 管 Linux X11（ffmpeg/xdotool）；不再依赖 VNC/noVNC。只读由服务端按连接强制，浏览器绘制 ACK 限制跨设备待确认帧，断开须释放输入。macOS 14+ 需屏幕录制/辅助功能权限，授权申请仅由设备本机「设备中心 → 本机远程桌面」按钮发起，远端连接只检查；`/api/device-desktop/local/*` 禁止经过 Hub/connector 中继。Wayland 尚不支持；启用状态保存在 `desktop-settings.json`。详见 [`device-desktop.md`](device-desktop.md)。

## 10. 群组 Webhook 集成

群组支持入站（Incoming）与出站（Outgoing）双向 Webhook：

- **入站 Webhook**：每个群组可创建多个入站端点，生成独立的安全 Token。外部系统（如 CI/CD、报警、脚本）向 `/api/rooms/:id/webhooks/incoming/:webhookId?token=...` 发送 HTTP POST JSON 请求（支持 `text`、`senderName`、`targetBotIds`、`replyToMessageId`）。若开启 `allowBotTrigger`（默认），外部消息按群规则自动分发给显式提及或主 Bot（`primaryBotId`），唤醒 Bot 执行任务并在群内协作。
- **出站 Webhook**：群组可配置多个外部通知地址，订阅群事件（`message`、`task_completed`、`task_failed`、`delivery`）。事件产生时异步向外部发送 JSON 载荷；支持配置 `secret`，通过 `X-Pi-Signature: sha256=...` 附带 HMAC-SHA256 签名校验。出站请求带 5 秒超时保护与异常隔离，不阻断主流程。
- **Hub 中转支持**：入站支持切换或配置公共 Hub 中转地址（`hubRelayBaseUrl`），外部请求由公网 Hub 集中接收并调度给内网设备上的 Bot；出站 Webhook 支持可选开关 `relayViaHub`，开启时由 Hub 服务器作为出口代理代发，关闭时供局域网内网直连模式使用。
