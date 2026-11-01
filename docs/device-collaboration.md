# 群组 / Bot / 跨设备协作硬约束

> 服务端架构与部署链路见 [`device-center.md`](device-center.md)（Hub 与本机连接器、绑定与配对、部署）
> 与 [`device-center-deployment.md`](device-center-deployment.md)；远程桌面实现细节见 [`device-desktop.md`](device-desktop.md)；
> 分块文件同步细节见 [`device-file-sync.md`](device-file-sync.md)。
> **本文只收录「改代码时必须遵守」的硬约束**（原 `AGENTS.md`「设备中心与跨设备协作」整段迁入）。

## 1. 设备中心入口与本机 Hub

独立 Hub 与本机连接器位于 `server/device-center/`，部署与边界见 [`device-center.md`](device-center.md)。主界面「设备中心」为原生 `devices` 视图（`DeviceCenter.tsx`），旧 `/devices` 重定向到该视图；未绑定时通过进程内私有 loopback Hub 支持本机 Bot/群组（`local-hub.ts`，数据与外部绑定隔离），概览保留群组管理及连接/创建引导，离线或请求失败不得清空已知群组；本机 Hub 安装走 `hub-setup.ts` 的 loopback 同源接口与独立 Hub CLI，必须验证参数、隔离数据目录、互斥执行并在关闭时取消等待；配对接口仅允许回环来源与同源写入；群成员统一为 Bot，设备仅负责承载与连接。

## 2. 群任务派发与上下文

群任务优先派给显式 @ 的稳定 Bot ID；可选 `primaryBotId` 接收未指定目标的人类消息并续接该 Bot 最近有效会话，Bot 公开消息不触发默认派发，移除主 Bot 时清除设置。`group-context.ts` 冻结主 Bot 身份，执行器按群与 Bot 双重匹配注入协调职责，使用已有持久会话和相关请求回复完成委派，角色不扩张权限。机器人接力继承父任务预算，禁止无界互派。群上下文由 `group-context.ts` 在派发前冻结，近期公开消息随任务传输（24 KiB），不重复落盘；`device_collab read_history` 按稳定游标回查原文（每群保留 500 条，超长消息可分段），必须验证来源 Bot 的设备、账号及群成员身份；清空/淘汰使旧游标失效。历史是参考数据，不能授权派发或执行。

## 3. Bot 注册表与持久会话

`bots.ts` 按本机设备身份保存 Bot 的固定项目根、角色、模型及工具/Skill/MCP 白名单；群使用 `botIds`，消息使用 `targetBotIds`，任务与 `device_collab` 文件同步共用 Bot registry lease/revision；执行会话不得冒用其他 Bot。群 Bot 持久会话由 `hub-conversations.ts` 登记稳定地址及不可变的委派来源（sourceBotId/sourceConversationId/parentTaskId），新建与继续均可携带关联请求，设备 `runtime.ts` 原子保存精确转录映射，恢复须验证 Hub/设备/群/Bot 版本/目录；仅精确能力路径允许 `switch_session`。

## 4. 并发、调度与进度推送

同设备默认 4 个执行 + 32 个等待，可配置并发 1–16、等待 0–128，按群公平调度；按 Bot 与真实路径重叠工作区串行，独立工作区可并发；同一会话继续消息在前轮终态后投递，不打断工具。群进度经有界、按 attempt 校验的 SSE 推送，断线回退轮询并重同步；原生问卷与一次性工具审批使用任务绑定交互桥。请求/回复绑定原始会话与 requestId，结果只唤醒原发起者，自动继续共享任务链预算，人工新输入可开新链。忙碌或停止未确认时禁止换根，旧文件包不得落入新根。

## 5. 文件同步

文件同步先暂存预览后按 revision 导入，已有差异必须显式覆盖；`sync_files recursive:true` 支持有界目录传递，拒绝软链接/联接，跳过敏感/忽略项须返回排除摘要，不删除目标文件；凭据不得进入工具回执。

## 6. 远程页面隔离与跨设备代理

Hub 默认单端口 `/device/<id>/` 路径访问设备，以 CSP sandbox（禁止 allow-same-origin）与设备专属随机能力路径隔离远程页面；旧独立域/端口保留兼容。跨设备代理只放行账号范围群聊接口，不得暴露本机绑定、目录与设置接口。

## 7. 群任务恢复与报告

群任务恢复由 `task-recovery.ts` 管 task/attempt/lease 认领与持久终态 outbox，网络断开保留持有租约的本机执行，Hub 重启提供有界认领窗口；设备进程崩溃不盲重跑副作用。原始完整报告由独立 `task-report-outbox.ts` 持久后分块上传，结果 ACK 不能误删未上传报告；事件、报告与详情见 `task-journal.ts` / `task-report.ts`。**审计流空态不是错误**：任务存在但从未写入 journal 分段（排队中、首个进度事件前失败、早于日志功能）时，Hub `GET /tasks/:id/journal` 返回 200 空页（`items: []`，附加 `journalUnavailable`），只有任务/群不存在才 404；UI 的详情与日志必须独立加载，日志降级不得清空任务概览。**本地代理必须透传 Hub 的已脱敏失败原因**（`scrubHubMessage` 抹掉已知凭据与令牌样式串后回传 `error` + `hubStatus`），禁止把 4xx/5xx 统一塌缩成固定的「Hub rejected group request」。群计划复用只读硬闸门，本轮成功 `plan_update` 与最终计划匹配并获 Hub 确认后才就绪，人类批准另起实施轮次。画布绑定与 Bot 预设须校验真实 graph/cwd 和 registry revision，不以引用自动运行或热改在途权限。分块文件传输的暂存与后台任务必须绑定 Hub/设备/群/Bot/revision/真实目录；停止未确认禁止继续，双端实际 I/O fence 确认后才释放。

## 8. 交付与审查（交付 ≠ 验收）

群组开发交付独立于执行状态：`completed` 不代表验收通过。交付与审查协议统一在 `server/protocol.ts`，Bot 交付必须绑定自身运行任务、稳定对话及完整提交 SHA；审查绑定交付 ID 与 SHA，禁止 Bot 自审，新版本不得沿用旧版本验收。检查来源固定为 `bot_reported`，不得声称宿主或 CI 已验证，不自动执行声明的命令或合并。人类可启动独立集成流水线：目标设备固定 Bot 工作区创建隔离预合并，显式选择验证命令，最后确认按目标 SHA 原子更新；目标分支在任何工作树被检出时拒绝，禁止 hard reset 或自动推送，集成会话与操作代次须持久并绑定 exact delivery/review/Bot revision。交付/审查先持久化，幂等冲突明确拒绝，有界历史不得静默淘汰。详情见 [`device-center.md`](device-center.md)，完整回归 `tests/device-project-collaboration-test.mjs`。

## 9. 远程桌面

设备中心远程桌面由 `desktop.ts` 经既有 WebSocket 传输原生 JPEG，`desktop-native.ts` 管 Windows/macOS 助手，`desktop-linux.ts` 管 Linux X11（ffmpeg/xdotool）；不再依赖 VNC/noVNC。只读由服务端按连接强制，浏览器绘制 ACK 限制跨设备待确认帧，断开须释放输入。macOS 14+ 需屏幕录制/辅助功能权限，授权申请仅由设备本机「设备中心 → 本机远程桌面」按钮发起，远端连接只检查；`/api/device-desktop/local/*` 禁止经过 Hub/connector 中继。Wayland 尚不支持；启用状态保存在 `desktop-settings.json`。详见 [`device-desktop.md`](device-desktop.md)。
