# pi-tunnel Phase 3 设计：pi_messenger 真 mesh 接入

> 状态：**设计稿待拍板**（先设计后动工，2026-10-24）
> 前置：Phase 1（/device/task 零代码通路）✅、Phase 2（v1.2.0 模型通道三级解析）✅

---

## 1. 目标与现状差距

**目标**：笔记本上的 pi agent 成为 mini 侧 pi_messenger mesh 的正式成员——可被 `@`、可收 DM、有持久记忆、有 presence，而不是现在 `/device/task` 式的一次性无记忆执行器。

**现状差距**（Phase 2 之后）：

| 能力     | Phase 2 现状                     | mesh 要求                                      |
| -------- | -------------------------------- | ---------------------------------------------- |
| 触达     | 面板/REST 手动 POST /device/task | mini 任意 pi 会话 `pi_messenger send` 直接可达 |
| 记忆     | `--no-session`，每次裸进程       | 持久 session，`--resume` 续聊                  |
| presence | devices 列表（面板私有）         | registry 条目，`list` 可见、状态可查           |
| 回复     | HTTP 响应同步返回                | 异步投回发起方 inbox + 自动 wake               |

## 2. 核心洞察（方案成立的依据）

pi_messenger 是**纯文件 mesh，无 daemon**（README "How It Works"）：

- 注册表：`~/.pi/agent/messenger/registry/<Name>.json`（name/pid/sessionId/model/activity…）
- 消息：`inbox/<收件名>/<ts>-<rand>.json`，格式 `{id, from, to, text, timestamp, replyTo}`
- wake：每个 pi 会话内的 pi-messenger 扩展 **fs.watch 自己的 inbox**（50ms debounce）→ `pi.sendMessage(deliverAs:"steer", triggerTurn:true)` 立即唤醒

**推论**：只要 mini 侧有一个「桥」替设备 agent 读写这两个目录，wake 机制**零改造免费获得**——桥把回复写进发起方（mini 上某 pi 会话）的 inbox，发起方的 pi-messenger watcher 自然触发 steer。

**实时性分析（三层次，20261024 补）**：

1. **通信链路实时**（亚秒级，非轮询）：send 写 inbox → 桥 fs.watch（50ms debounce）→ WS ctrl 推送设备；设备完成 → WS 上行 → 桥写回发起方 inbox → 发起方 watcher 50ms 内捕获 → steer wake。整链无轮询间隔，延迟毫秒级。
2. **设备端 LLM 执行时间不免**：pi 收任务要思考/调工具（数秒到数分钟）。mesh 是异步的——对比 Phase 2 `/device/task` HTTP 同步等完（12~67s），发起方发完消息即可继续干别的，不阻塞。
3. **发起方忙碌时回复排队不丢**：pi 的 steer 不打断进行中的 turn——忙碌时回复在下个 turn 边界被消化；发起方已退出则留在 inbox，下次启动补看。桥交付即忘，inbox 文件即持久化。

## 3. 架构

```
mini (172.16.120.11)                          笔记本 (172.16.120.118)
┌─────────────────────────────┐   WS(8765)   ┌──────────────────────┐
│ mini pi 会话 A               │              │ tunnel CLI (launchd) │
│  └ pi-messenger 扩展         │              │  └ ctrl handler      │
│    ↕ inbox/<A>/ watch       │              │    ↕ spawn           │
│  桥（tunnel 插件内，随 server）│  ←ctrl-req── │  pi --resume <sid>   │
│  · watch inbox/<Remote*>/    │  ──msg-res→  │    --mode json       │
│  · 写/刷 registry 条目        │  (新上行类型) │    持久 sessionId 存储│
└─────────────────────────────┘              └──────────────────────┘
```

**消息流（A 向设备 agent 发 DM）**：

1. A：`pi_messenger {action:"send", to:"RemoteMbp", message:"…"}` → pi-messenger 写 `inbox/RemoteMbp/…json`
2. 桥 watch 到新消息 → deviceCtrl(ctrl-req `/task`，带 `sessionId:resume`、`text`)
3. 设备 CLI：`pi --resume <sid> -p <text> --mode json` → 流式收集最终 assistant 文本
4. CLI WS 上行 `{type:"msg-res", msgId, from:"RemoteMbp", text, to:<原发起方>, ok}` （**新增消息类型**，CLI hello 后即可主动上行）
5. 桥收到 → 写 `inbox/<发起方>/…json`（from=RemoteMbp, replyTo=原 msgId）→ 发起方 pi-messenger 自动 wake ✅
6. 桥更新 registry activity + audit 环

**关键点：pi-messenger 源码零改动。**

## 4. 改造点清单

| #   | 位置                                 | 改动                                                                                                         | 量级       |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | tunnel 插件 server（源仓 index.mjs） | **mesh 桥模块**：inbox watcher + registry 管理 + msg-res 处理 + WS `msg-up` 上行接收                         | 主要工作量 |
| 2   | 设备 cli.mjs（CLI_VER→p10）          | `/task` 支持 `sessionId` 模式：`new`→分配并持久化、`resume`→`--resume <sid>`；完成后经 WS 主动上行 `msg-res` | 中         |
| 3   | 面板 entry.mjs                       | 「模型通道」卡旁加「Mesh」卡：开关、设备 agent 名、最近回复预览                                              | 小         |
| 4   | pi-messenger                         | **不动**                                                                                                     | 0          |

## 5. 关键设计决策

1. **设备 agent = 一设备一持久 agent**（命名 `Remote<设备名>`，如 `RemoteMbp`）。会话存 `~/.pi-tunnel-agent.json`（sessionId/cwd/model）；面板提供 `重置会话`（新 session）。
2. **桥随 server 常驻**，registry 条目 `pid` 用 server PID（桥进程）——pi-messenger 的 PID 存活检查天然通过；**设备离线由桥反映**：离线时把条目 `activity.lastActivityAt` 冻结并删 `session` 字段前加 `offline:true` 自定义字段（pi-messenger 忽略未知字段，安全）；上线恢复。
3. **离线积压**：设备离线期间 inbox 消息留存，上线后桥按时间序补发（限最近 5 条，更旧的标 `skipped` 写回发起方告知）。
4. **多设备就绪**（P3b 已实现，原 v1 单设备）：registry/inbox watcher 按设备名参数化；meshDrain 按 inbox 目标反查设备 aid 路由（不再是 activeAgent 兼单设备）。新增设备只需面板常驻命令接入，桥零改动
5. **模型通道**：设备 pi 会话复用 v1.2.0 的三级解析（resolveModelEnv），会话启动时解析一次并写入设备侧 models.json（已有机制）。
6. **安全门禁**（mesh 通道比 /device/task 更易被 agent 自发触发，必须设防）：
   - 开关默认关：storage `devcfg.meshEnabled:false`，面板 Mesh 卡开启（主人手动）
   - 设备端 tools 白名单维持 v1 策略（默认 `read,grep`，写操作需面板提权——已有 fsWrite 治理）
   - 桥 audit：每条转发进出均入审计环
   - **防环**：设备 agent 不是 mini mesh 成员（它不跑 pi-messenger），回复单向落地发起方 inbox；桥拒绝处理 `from=Remote*` 的消息（设备消息不会回到设备）
7. **steering 注入边界**：发起方 pi 空闲时 steer 即新 turn；忙时排队（pi 内建 steer 行为）。桥不重试注入，交付即忘（inbox 文件即持久化）。

## 6. 风险与开放问题

- **R1 结果截取**：`--mode json` 流的最终文本取最后一条 `message_end` 的 assistant `text`；含 toolCall 的轮次继续等，直到 `agent_end`。已有 PONG 流验证过该结构 ✅
- **R2 超时**：设备 pi 任务可能长跑（>60s）。CLI `timeoutS` 上限调到 600（mesh 场景）；桥侧 per-msg 超时 10min，超时回写发起方「任务超时，设备端仍在跑，结果将丢弃」（v1 简化）
- **R3 会话膨胀**：持久 session 长聊会膨胀——v1 不处理（提供重置），v2 评估 `--no-session` 定期轮换或 compact
- **R4 多 pi 会话同时 send**：inbox 串行消费（桥单队列），天然无并发冲突
- **开放 Q1**：设备 agent 是否要能反向 `send` 给 mini 任意 agent（目前回复只回发起方）？v1 否（单向应答），反向发消息留 v2
- **开放 Q2**：Crew 编排（plan/work）跨设备任务——不在此期（Crew worker spawn 是 mini 本地行为，跨设备 worker 是更远期方向）

## 7. 实施分期与验收

**P3a（桥 + 通道，预计一个工作时段）**

- index.mjs 桥模块 + WS msg-up；cli.mjs p10（sessionId + 上行）；面板 Mesh 卡
- 验收：mini pi 会话 `send to=RemoteMbp "你是谁，report hostname"` → 收到 wake 回复（含 gxg-mbp）→ `list` 可见 RemoteMbp → 再发一条验证 `--resume` 记忆（第二问能复述第一问内容）

**P3b（打磨，20261024 已落地）**

- 离线补发、超时回写、重置会话按钮、README/CHANGELOG、设备端 session 快照进面板

**P3b 实际落地与设计偏差**

1. **多设备路由提前实现**（原 §5.4 "v1 只接 1 台"）：meshDrain 改为按消息所在 inbox 目录（目标设备 agent 名）→ registry.device 反查设备 aid 定向投递；目标离线则滞留等补发。单设备/多设备行为一致，验收回归通过
2. **会话管理端点**：CLI p14 `GET /session`（快照）+ `POST /session/reset`（删 session.json）；server `GET /mesh/session`、`POST /mesh/reset`（支持 `?agent=` 指定设备）；面板 Mesh 卡「会话/重置会话」按钮
3. **CLI p15**：undici 在 CONNECTING 态 close() 不触发 onclose，connectGuard 废弃后重连链死亡 → 废弃后 3s 复检仍 0 则 exit(0) 由 launchd 重拉
4. **persistCmd 模板修复**：launchd 不展开 plist `StandardOutPath` 的 %h（spawn 即 78 EX_CONFIG）→ 改 `$HOME`（详见 CHANGELOG 1.4.0 / PROGRESS 事故记录）
5. 验收全绿：设备上线 p15（launchd 常驻）→ 快照 → reset removed → reset 后首条回复「PONG-p3b · 新会话已建立」；滞留补发实测（积压消息上线后处理，10min 超时保护丢弃，queue 清零）

## 8. 备份与回滚

- 改前照例：`~/WorkSpace/pdd-backup/tunnel-plugin-pre-p3a-<ts>/` 全量归档
- CLI p10 推送失败自动回滚（self-update 已有原子替换）；桥开关关掉即完全回到 Phase 2 行为
