# 上帝对象「重写」方案（C 方案 · 细化版）

> 状态：**提案（未落地）**。取代 [`giant-module-decomposition.md`](giant-module-decomposition.md) 里的 B（按域机械提取）作为选定路线。
> 一句话：**重写「pi 引擎的编排层」，而不是重写整个项目**——新树 `server/core/` 从零写，作为**第 6 个引擎实现**挂在已有的 `EngineService` 契约后面，按客户端/环境变量切换，逐域补齐，最后删老树。

---

## 0. 范围声明（先把不重写的东西钉死）

| 重写（新写代码） | **不重写（冻结，只允许复用/适配）** |
| --- | --- |
| `ClientSession`（16,781 行 / 580 方法 / 478 个字段）+ `AgentService` 容器（2,099 行） | WS 协议：`server/protocol.ts` 类型集 + `PROTOCOL_VERSION = 61`（桌面壳 pin，`desktop/protocol-expectation.ts`） |
| `server/dispatch-*.ts`（1,675 行的 `switch` 分发） | `EngineService` 49 个成员（只许追加可选成员，本期不用） |
| 会话/子代理/工具门控/审批/设置 的编排与状态归属 | 持久化格式：`session-open.ts` 的 SDK JSONL、`versioned-doc` 各档、客户端状态键、composer drafts |
| `web/src/use-chat.ts` 状态层 + `App.tsx` 编排（W8，独立波次） | 插件宿主 API、插件市场清单、`browser/`、`desktop/`、`device-center/`、`canvas/`、`dsh/`、`universal/` |
| — | 已被拆出的 167 个叶子模块（合计 71,635 行，见 §1 F1）：原样复用 |

**结论：重写的天花板是 ~1.9 万行编排 + 装配，不是 19 万行。** 318 万行级别的"整项目重写"不在本方案内。

---

## 1. 为什么这次能成立（四条事实 + 一条反面证明）

**F1 · 上帝对象是"汇"，不是"源"。**
`server/agent-service.ts` 直接 import 167 个模块（合计 71,635 行），而**只有 9 个文件反过来 import 它**：

```
agent-service-daemon · context-budget-runner · control-socket · dsh/dsh-agent-service
durable/index · index · subagent-helpers · subagent-notify · tool-host-factories
```

也就是说**整棵依赖树的叶子早就拆干净了**，烂的只是"把它们捏在一起的那 1.7 万行"。重写的成本集中在编排，不在能力。

**F2 · 引擎抽象已经存在，交付与回滚的车辆是现成的。**
`server/index.ts` 已有 `ensureEngine(engine: EngineId)` + 5 个实现（`pi` / `dsh` / `claude` / `codex` / `durable`）+ per-client 选择持久化（`saveClientEngine` / `getDefaultEngine`）+ 能力协商（`AgentEngineCapabilities`）。
→ **新实现可以像 `DshAgentService` 一样挂进去**；回滚 = 切一个设置项或一个 env，不是回滚一次发布。

**F3 · 安全网足够厚，而且大部分是黑盒。**
- `tests/unit` 1,270 文件 / **12,383 条**用例；其中只有 **71 个文件**用白盒假体（`fakeClientSession`/`new ClientSession`），即 **~93% 是黑盒**，重写不该碰它们。
- `tests/*.mjs` **242 条** playwright 端到端流程（`npm run test:smoke` / `smoke:core`），走真实浏览器 + 真实 WS。
- `npm run ci:local` 复刻 CI 全门禁（format / lint / protocol / i18n / 6 个 tsconfig / build / unit / integration / smoke）。

**F4 · 不变量已经被守卫固化，不用重新发明。**
18 个守卫测试直接按文件路径断言 `agent-service.ts` 里的行为（`session-turn-single-source`、`delivery-gate-single-source`、`snapshot-channel`、`session-projection`、`conversation-row-declared`、`prompt-base-scope`、`permission-persistence`、`plan-state`、`queued-attachments`、`session-list-refresh`、`switch-conversation-fast`、`concurrent-session-open`、`compact-context-tool`、`context-integration`、`tool-registration`、`tool-prompt-hygiene`、`bash-timeout`、`versioned-doc-single-source`、`engine-service-single-source`）。
→ 它们是**新树的验收规格**，而且已经写成机器可判定形式（§6 给了逐条落点）。

**反面证明（为什么老树上做 B 已经_FAIL_）：**

- 580 个方法里 525 个 <60 行 —— 不是"某段逻辑写崩了"，而是**没有所有权**；`convs` 被 172 个方法摸、`activeId` 70 个。
- 本想当窄接口的 `DispatchSession` 已经长到 **185 个成员**，退化成同一张上帝脸。
- 老树里已经出现 **4 条循环依赖**（`agent-service-daemon`、`subagent-helpers`、`subagent-notify`、`tool-host-factories`）——这是"边搬边长"路线走到底的必然产物。

---

## 2. 冻结契约（重写期间的硬约束）

| 契约 | 冻结内容 | 校验手段 |
| --- | --- | --- |
| 通信协议 | `ClientMessage` / `ServerMessage` 字段与语义；`PROTOCOL_VERSION` 保持 **61** | `npm run check:protocol` + `tests/unit/*protocol*` |
| 引擎契约 | `EngineService` 49 成员签名 | `tests/unit/engine-service-single-source.test.ts` |
| 会话文件 | SDK JSONL 格式、`session-open.ts` 读取路径、`repairSessionFile` 修复语义 | `concurrent-session-open` / `session-list-refresh` |
| 客户端状态 | `versioned-doc` 各档 schema（认不出就拒写） | `versioned-doc-single-source` |
| 插件 | 宿主 API、`plugins/catalog.json` builtin 范围、插件数据目录 | `plugin-*` 系列守卫 |
| 前端消费面 | `useChat()` 返回的 `chat` 形状（`chat.state` 204 处、`chat.settings` 54 处 …） | W8 前不动 |

> 违反其中任何一条 = 用户侧不可见地坏掉（插件崩、桌面壳拒绝连接、历史会话读不出），所以它们是"重写不能碰的墙"，也是回滚可行的前提。

---

## 3. 目标架构（新树）

```
server/core/
  contracts/                     # 纯类型：域间窄契约 + 端口（ports），零实现
    ports/transport.ts           #   TransportPort：send / broadcast / onDelivered
    ports/engine.ts              #   AgentEnginePort：对 SDK AgentSession 的最小抽象（只有 TurnRunner 用）
    ports/store.ts               #   StatePort：客户端状态读写（背后仍是 versioned-doc）
    ports/clock.ts fs.ts approval.ts
    dto/*.ts                     #   域间传值对象（不含行为）

  kernel/                        # 聚合根：只允许 contracts + 纯函数，禁 IO / 禁 emit / 禁 SDK
    conversation/conversation.ts         # 对话聚合：状态 + 不变量（标题/排队/队列模式/压缩点）
    conversation/registry.ts             # ConversationRegistry：convs / activeId / seq / 会话文件索引
    conversation/lifecycle.ts            # 建档·切换·分叉·回滚·编辑·删除·退役的状态迁移（纯函数）
    turn/turn-plan.ts                    # 一轮要做什么（工具集/提示词/模型）—— 纯计算

  domains/                       # 每域一个目录：持自己的状态，依赖 kernel + contracts
    turns/        # TurnRunner：唯一碰 SDK prompt 的地方（红线：喂一轮只有一个出口）
    snapshots/    # SnapshotPublisher：只经 snapshot-channel 出帧
    history/      # 会话列表扫描、transcript 准备、压缩标记
    subagents/    # 派发/预算/结算/账本/worktree/唤醒
    tools/        # 工具门控单漏斗、lazy tools、按需加载、提示词
    approvals/    # 审批队列 + 规则库 + 问卷 + 电话/页面回执（交互收件箱）
    settings/     # 设置/预设/模型/密钥（代理既有 settings-service/model-admin）
    plugins/      # 插件运行态、扩展重载、MCP 桥
    terminals/    # PTY / 原生 CLI / bash 接管
    goals/        # 目标模式 / 委派 / 计划
    bots/         # Bot 私有执行策略（只做路由与授权，执行仍走 turns）
    files/        # 文件树（复用 files-service）
    workspace/    # cwd / 根目录 / 沙盒 / 队列（复用 workspace-queue）

  adapters/                      # 与外部世界接边，可替换、可测试替身
    sdk/                         # @earendil-works/pi-coding-agent 适配
    state/                       # ClientStateStore / versioned-doc
    wire/                        # WS sink、共享会话、移动推送
    fs/ ssh/ plugins-host/

  app/
    core-engine.ts               # implements EngineService（唯一对外门面，49 成员）
    wire-router.ts               # ClientMessage → 用例：注册表 map，替代 1,675 行 switch
    client-registry.ts           # clientId → 客户端会话（顶替 AgentService 容器职责）
    composition-root.ts          # 唯一 new 的地方；端口装配、开关判定

  conformance/                   # 双实现一致性测试（W0 建）
```

**依赖方向（唯一合法）：** `contracts ← kernel ← domains ← app`；`adapters` 只被 `app` 装配、只依赖 `contracts`。
**守卫：** `server/core/**` 禁 import `agent-service.js`、禁 import 兄弟域（`contracts` 除外）、禁跨层反向 import —— 由新的 `tests/unit/core-boundaries.test.ts` 断言（解析 import 语句，仓库已有同类守卫写法）。

### 3.1 状态所有者表（478 个字段 → 新家）

这是重写最核心的一张表：**谁拥有可变状态，谁才允许改它**。样例（按现热度排序）：

| 现字段（热度） | 新家 | 说明 |
| --- | --- | --- |
| `convs`(172) · `activeId`(70) · `convSeq` · `sessionFileCache` | `kernel/conversation/registry` | 唯一写入口 `registry.upsert/remove/activate` |
| `emit`(141) · `flushSnapshot`(69) · `sinks` · `uiMessageCache` | `domains/snapshots` | 下行帧全部经 `snapshot-channel.ts`（红线不变） |
| `settingsSvc`(74) · `modelAdmin`(31) · `pluginModelKeys` | `domains/settings` | `applySessionModel` 仍是换模型唯一入口 |
| `cwd`(64) · `roots`(9) · `sandboxes`(15) | `domains/workspace` | 一律走 `workspace-queue.ts` |
| `conv()`(52) · `disposed`(40) · `clientId`(36) | `app/client-registry` + `kernel/registry` | 生命周期归容器，身份归注册表 |
| `stateStore`(60) | `adapters/state` | 只经 `StatePort` |
| `subagent*`(16 方法) · `allSubagentSessions`(16) | `domains/subagents` | 账本/结算/预算自带 |
| terminal 相关 · `nativeCli*` | `domains/terminals` | 复用 `terminals.ts` |
| plugin run / bg task / `mcpProjects` | `domains/plugins` | 复用 `plugins.ts` / `mcp-bridge.ts` |
| `goalSvc`(15) · `planManager`(14) | `domains/goals` | 复用 `goal-service.ts` / `plan-mode.ts` |
| `botExecution`(15) · `deliveryModeOf`(13) · `drainDeliveries`(11) | `domains/bots` + `domains/turns` | 投递门仍是 `conversation-delivery.ts` 单源 |

> 交付物补充：W1 之前先把这张表补全到 478 行（脚本：`/tmp` 那种字段热度扫描→落到 `server/core/OWNERSHIP.md`），**每个字段必须恰好一个所有者**，有争议的字段单列"待定"并在 W1 内裁定。

---

## 4. 交付载体与切换机制

1. **新引擎 id 沿用 `pi`**（用户设置里存的就是 `pi`，不改用户可见标识）；实现由环境变量决定：
   - `PI_WEB_PI_ENGINE=legacy`（W0~W5 默认）
   - `PI_WEB_PI_ENGINE=core`（W2 起可手动狗粮）
   - `PI_WEB_PI_ENGINE=shadow`（**只用于测试**：同进程双跑、比对下发帧，不用于生产）
2. **`ensureEngine("pi")` 里做一次二选一**：`PI_WEB_PI_ENGINE === "core" ? new CoreEngine(...) : new AgentService(...)`。改动面 = 1 个函数，回滚面 = 1 个 env。
3. **不存在"两套状态共存"**：切换是进程级/客户端级的，一个新对话只会落在一侧；老树的会话在切回 legacy 时照旧可读（会话文件格式不变）。
4. **灰度顺序**：本机 dogfood（W2）→ 单客户端设置项（W6）→ 新装默认（W7 之后）→ 删老树（W7）。

---

## 5. 分期计划（W0~W9）

> 单人 + 代理并行；括号里是并行化后可压缩的周数。合计 **12~14 周（可压到 8~10 周）**。

### W0 · 基座（1 周）

- 建 `server/core/{contracts,kernel,domains,adapters,app,conformance}` 骨架 + 头部中文注释（仓库规范：源码注释单源在 `docs/agent-rules.md` §六）。
- 写 `contracts/ports/*`：`TransportPort`、`AgentEnginePort`、`StatePort`、`ClockPort`。
- `app/core-engine.ts`：`implements EngineService`，49 个成员全 `throw new Error("not implemented")`，但 `attach/detach/get/quiesce/unquiesce/serviceStatus` 真实现 → **空引擎能起、能连、能断开**。
- `app/composition-root.ts` + `ensureEngine("pi")` 二选一开关。
- `conformance/` 脚手架：同一批场景测试**参数化跑两个实现**（`describe.each([legacy, core])`）。
- **验收**：`PI_WEB_PI_ENGINE=core npm run dev` 能连上、UI 不崩（只显示空会话列表）；`npm run typecheck` 绿；`core-boundaries` 守卫绿。

### W1 · 对话内核（2 周）—— 全案风险最高、必须先做

- `kernel/conversation/*`：聚合 + 注册表 + 生命周期纯函数（**零 IO**）。
- `domains/turns/turn-runner`：唯一碰 SDK 的 `session.prompt(...)`，经 `session-turns.ts`（红线：喂一轮只有一个出口）；压缩期投递走 `conversation-delivery.ts`。
- `domains/snapshots`：投影 + 出帧，只经 `snapshot-channel.ts`。
- `domains/history`：`loadSessionInfos`(229 行) + transcript 准备 + 分页。
- **验收**：单对话「发消息 / 流式 / 停止 / 排队 / 新对话 / 切会话」端到端可用；`smoke --core` 的 `stream-stability-ui`、`universal-stream-ui`、`conv-cwd`、`conv-cross-project` 在 `core` 下全绿；`session-turn-single-source` / `snapshot-channel` / `delivery-gate-single-source` 守卫重定向到新树并通过。

### W2 · 生命周期与退役（1.5 周）

- 分叉 `forkSession`(157) / 回滚 `rollbackSession`(125) / 编辑 `editMessage`(134) / 删除(123) / 过户 `insertTakeoverConvs`(132) / 退役 quiesce(`QuiesceRejectedError`)。
- 共享会话只读视图（`openSharedConversation` 系列）。
- **验收**：`fork-assistant-bubble`、`left-panel-delete`、`conv-pin`、`cross-client-session`、`cross-device-switch-session` 在 core 下全绿；过户回滚事务性测试（`takeover-rollback-test`）重定向通过。

### W3 · 工具与审批（1.5 周）

- `domains/tools`：`toolOverrideSpecs`(304) + `loadLazyTools`(118) + 单漏斗 `effectiveDisabledAgentTools()`（复用 `tool-manager.ts`，**不重写提示词**）。
- `domains/approvals`：`askApproval`(146)、`resolve*`(11)、问卷、电话/页面回执、规则库（复用 `tool-approval.ts` / `approval-rules.ts`）。
- **验收**：`approval-policy`、`approval-rules`、`tool-registration`、`tool-prompt-hygiene`、`lazy-tools` 全绿；`npm run test:smoke --core` 通过。

### W4 · 子代理（1.5 周）

- `domains/subagents`：`spawnSubagentConversation`(384)、`handoffSubagent`(159)、结算边沿、派发预算、运行账本、worktree、完成通知、回收定时器。
- **验收**：`subagents.test.ts`(1,747 行) 迁移后全绿；`tests/*-live-test.mjs` 里子代理相关流程在 core 下通过。

### W5 · 插件 / MCP / 终端（2 周）

- `domains/plugins`：run/bg task/扩展重载/MCP 桥（复用 `plugins.ts`、`mcp-bridge.ts`、`plugin-conversation-view.ts`）；**插件宿主 API 零改动**。
- `domains/terminals`：PTY / 原生 CLI / bash 接管（复用 `terminals.ts`、`native-cli.ts`）。
- **验收**：`plugin-jobs`、`plugin-grants`、`plugin-client-conversation`、`plugin-scaffold`、`terminal-*` 在 core 下全绿。

### W6 · 设置 / 模型 / 目标 / Bot（1.5 周）→ **默认档切 core**

- `domains/settings`：`setSettings`(119) + 12 个 `apply*` + 14 个 `refresh*` + 9 个 `push*`；`applySessionModel` 仍是换模型唯一入口。
- `domains/goals`（复用 `goal-service.ts` / `plan-mode.ts` / `delegate-mode.ts`）、`domains/bots`（`botOf` / 工具授权按执行会话解析）。
- **退出条件（gate）**：`PI_WEB_PI_ENGINE=shadow` 下双跑一致率 100%（§7 层 2）、`smoke` 全量在 core 下全绿 → 把默认档改成 `core`。

### W7 · 删旧树（1 周）—— 本方案"完成"的定义在这

- 删 `ClientSession` + `agent-service.ts` + `dispatch-*.ts` + `AgentService` 容器（若 `dsh`/`universal` 仍在用 `ClientSession` 类型，先切到 `contracts` 里的窄接口）。
- 解 4 条循环依赖；`fake-session.ts` 随之删除（它存在的唯一目的是给上帝对象造假体）。
- **守卫重定向**：18 个守卫从 `agent-service.ts` 指向 `server/core/**`（§6 表）。
- **71 个白盒测试**：按域重写到新域单位（这是 C 的收益之一——测试从"给 580 方法打桩"变成"测域行为"）。
- **验收**：`agent-service.ts` 不存在，`npm run ci:local` 全绿，二进制体积/启动时间不劣化。

### W8 · 前端状态层重写（2 周，可与 W1~W6 并行）

- `web/src/use-chat.ts`(3,369)：226 个 `case` → `web/src/chat/store.ts`（状态）+ `chat/reducer/<family>.ts`（注册表）+ `chat/selectors.ts`；**`useChat()` 返回的 `chat` 形状保持不变**（204 处消费点零改动）。
- `web/src/App.tsx`(3,931 / 163 hook)：抽 `useDraftAttachments` / `usePreviewOpenState` / `usePanelLayout` / `useModalStack` + `WorkspaceShell` 布局组件。
- `web/src/components/SettingsModal.tsx`(7,424 / 28 个内联 `tab ===`)：一 tab 一文件 + `SettingsFormContext`。
- **验收**：`tests/*-browser-test.mjs` 全绿；首屏 JS 体积与交互时延不劣化（记录 `loading-performance.md` 的基线）。

### W9 · 收尾（1 周）

- `tests/unit/file-size-budget.test.ts`：新树每个文件 ≤600 行，且只许降。
- `AGENTS.md` §1 事实源改指 `server/core/**`；`docs/architecture-core.md` 补「core 树分层与端口」一节。
- 性能对照：冷启动、常驻内存、首帧时延、`switch_conversation` 时延（红线 `switch-conversation-fast`）。
- 复盘：把"为什么会走到 580 方法"写进 `docs/root-cause-boundaries.md`。

---

## 6. 不变量迁移清单（18 条守卫 → 新树落点）

| 不变量 | 现守卫 | 新树落点 |
| --- | --- | --- |
| 喂一轮只有一个出口 | `session-turn-single-source` | `domains/turns/turn-runner.ts` 是唯一调用 `session-turns.ts` 的地方 |
| 入站投递门 | `delivery-gate-single-source` | `domains/turns/delivery`（`deliveryMode()` 单源） |
| 出帧单源 | `snapshot-channel` | `domains/snapshots`（禁在 emit 处手判全量/增量） |
| 会话投影 | `session-projection` | `adapters/wire/projection` |
| 左栏行归属 | `conversation-row-declared` | `domains/history` 调 `conversation-rows.ts`（`rowKind` 单源） |
| 提示词 base 归属 | `prompt-base-scope` | `domains/tools/prompt`（loader 级，禁客户端级"最近一次"） |
| 权限预设持久化 | `permission-persistence` | `domains/settings/permission` |
| 计划状态 | `plan-state` | `domains/goals/plan` |
| 排队附件 | `queued-attachments` | `kernel/conversation/queue` |
| 会话列表刷新 | `session-list-refresh` | `domains/history/list` |
| 切会话快 | `switch-conversation-fast` | `kernel/registry.activate`（禁同步重建） |
| 并发开会话 | `concurrent-session-open` | `adapters/sdk/open` |
| 压缩上下文 | `compact-context-tool` / `context-integration` | `domains/turns/compaction` |
| 工具注册三处联动 | `tool-registration` | `domains/tools/catalog` + `composition-root` |
| 工具提示词洁净 | `tool-prompt-hygiene` | `domains/tools/prompt`（复用 `tool-prompts.ts`） |
| bash 默认超时 | `bash-timeout` | `domains/terminals/bash`（复用 `bash-timeout.ts`） |
| 版本化存储 | `versioned-doc-single-source` | `adapters/state`（复用 `versioned-doc.ts`） |
| 引擎契约单源 | `engine-service-single-source` | `app/wire-router.ts` |

> 处理方式不是"改测试让它绿"，而是**先在新树里按规则写，再把守卫的正则指向新文件**；走不通说明新设计错了。

---

## 7. 测试战略（五层，缺一不可）

1. **契约层**：`EngineService` 49 个成员 × 双实现参数化（`conformance/engine-contract.test.ts`）。任何"新实现少一个成员语义"当场红。
2. **Golden 回放层（本方案的关键安全带，W0 建）**：
   - 录制器：`scripts/record-wire.mjs` 起真服务 + playwright 跑 12 条脚本（发消息/流式/停止/排队/切会话/分叉/压缩/审批/子代理/终端/插件/多客户端共享），把**下行帧序列**落到 `tests/fixtures/wire/<script>.jsonl`；
   - 归一化：抹掉 `id`/`ts`/耗时/`cwd` 绝对路径等易变字段；
   - 回放器：`conformance/golden-replay.test.ts` 对 `core` 实现重放同一批上行帧，断言"帧类型序列 + 关键字段等价"；
   - 价值：这是唯一能低成本发现"新实现少推了一帧/顺序不同"的机制，也是 `shadow` 模式的判定器。
3. **域单测**：新每个域自带纯单测（内核聚合用纯函数，无需假体——这正是重写的主要收益）。
4. **存量黑盒**：1,270 文件里 ~1,200 个**零改动**继续跑；242 条浏览器流程**零改动**继续跑。
5. **迁移层**：18 个守卫重定向 + 71 个白盒按域重写（W7）。

**每期门禁（DoD）：**

```bash
npx prettier --write <改动>
npm run typecheck && npm run lint && npm run check:protocol
npx vitest run tests/unit/core-boundaries.test.ts tests/unit/conformance tests/unit/<该域>
PI_WEB_PI_ENGINE=core node tests/run-smoke.mjs --core --no-build   # 该期相关编排
```

---

## 8. 风险登记 & kill criteria

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 重写期功能仍在开发，旧树与新树双份改动 | 合并冲突、双份 bug | 冻结规则：W1~W5 期间新功能只允许落在**叶子模块**（新树直接复用）；落在 `ClientSession` 的功能必须同步在 `core` 同域补一次，并在 PR 模板标注 |
| "重写"变"重写一半" | 两套实现长期共存 | **kill criteria**：W4 结束时 `core` 若未覆盖 60% 的 `smoke --core` 脚本 → 回退到 B 路线（B 文档里的 P0/P1 可直接继承），并保留已写的 kernel |
| Golden 回放噪声大（时间戳/并发顺序） | 误报淹没真问题 | 只断言"帧类型序列 + 业务字段"，易变字段白名单化；先录 3 条脚本打通再扩到 12 条 |
| 新树自己又长成上帝对象 | 白干 | `core-boundaries` + 文件 ≤600 行预算 + 每域一个 `DomainService`，`CoreEngine` 只允许委托（禁 `if`） |
| 插件/桌面壳被间接破坏 | 用户级事故 | §2 冻结契约 + `plugin-*` / `desktop/*` 守卫 + W5 结束前不动 `plugins.ts` 接口 |
| 单人估算失真 | 拖期 | 每期用 `smoke --core` 通过脚本数当**客观进度条**（12 → 24 → …），不看行数 |

---

## 9. 与 B 的成本对照（为什么选 C）

| | B 按域机械提取 | **C 重写编排层** |
| --- | --- | --- |
| 结果形态 | 580 个方法仍在类上（一行委托），god 接口不消失 | 无 `ClientSession`；域各自持状态 |
| 最终测试 | 71 个白盒假体继续存在（`fake-session` 要跟着演进） | 白盒消失，改域行为测试 |
| 工期 | 3~4 周 | 12~14 周（可压 8~10） |
| 中间态风险 | 低 | 中（靠 W0 基座 + golden 回放 + env 回滚压住） |
| 能否顺手修掉 4 条循环依赖 | 不能 | 能 |
| 收益 | 可读性/冲突面 | 可读性 + **所有权** + 可测试性 + onboarding |

**选 C 的唯一前提**：接受 12 周左右没有"用户可见产出"的投入，并接受重写期间功能开发受限。若不接受，B 的 P0/P1 可以立即开工且与 C 的 W0 不冲突（两者都从"建边界守卫 + 假体演进"起步）。

---

## 10. 立刻可以开工的前 5 个任务

1. `server/core/OWNERSHIP.md`：把 478 个字段跑成"字段 → 域"表（脚本扫 `this.*`），标注争议项。
2. `tests/unit/core-boundaries.test.ts`：新树四条禁令（禁 import 老树、禁跨域、禁反向依赖、文件 ≤600 行）。
3. `server/core/contracts/ports/{transport,engine,state}.ts` + `app/core-engine.ts` 空壳（`EngineService` 49 成员）+ `ensureEngine("pi")` 二选一开关。
4. `conformance/engine-contract.test.ts`：双实现参数化脚手架（`core` 先全 skip，随 W1 逐条打开）。
5. `scripts/record-wire.mjs` + 第一条 golden（`conv-cwd` 脚本）：证明回放机制能跑通，再扩到 12 条。

做完这 5 项（约 3~4 天），`PI_WEB_PI_ENGINE=core` 应该能起一个"能连、能断、不能聊"的引擎——这就是 C 的立足点。
