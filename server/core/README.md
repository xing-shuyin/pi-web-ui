# server/core —— 新树（pi 引擎编排层重写）

本目录是 `ClientSession`（16.8k 行 / 580 方法 / 478 字段）的替代实现。老树在 W7 之前保持可用：
`PI_WEB_PI_ENGINE=legacy|core` 二选一（默认 `legacy`）。

## 分层（唯一合法方向）

```
contracts  纯类型与端口，零实现        ← 谁都可以依赖它
kernel     聚合根与不变量，零 IO       ← 只依赖 contracts
domains    每域一个目录，自有状态       ← 只依赖 contracts + kernel（**域之间不互相 import**）
adapters   与外部世界的接边（SDK/状态/线）
app        门面（EngineService）与装配    ← 唯一允许 import 全部的地方
```

守卫：`tests/unit/core-boundaries.test.ts`（分层方向 / 域隔离 / 禁 import 老树 / 单文件 ≤600 行）。

## 状态所有权

`OWNERSHIP.md`：从老树自动扫描出的 98 个可变字段 → 域归属表（`node scripts/gen-core-ownership.mjs` 生成，`--check` 校验过期）。
**每个字段恰好一个所有者**；域的私有状态住在域自己的类里，`ClientSession` 那种「一个大对象装全部」的形态不再出现。

## 进度

| 波次  | 内容                                                                                             | 状态                                                       |
| ----- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| W0    | 骨架：ports / kernel（对话聚合 + 注册表 + 相位 + 排队）/ 门面壳 / 引擎开关 / 边界守卫 / 所有权表 | ✅                                                         |
| W1    | 对话内核：TurnRunner（唯一碰 SDK）、snapshots、history、生命周期                                 | ✅ turns / snapshots / history / ClientRuntime             |
| W2    | 快照投影、设置读模型、转录投影                                                                   | ✅                                                         |
| W3    | 适配器：SDK 开会话 / 版本化状态落盘                                                              | ✅（能开会话；喂轮与接线在 W4）                            |
| W4    | 连接期帧：settings_state / sessions / projects / models + 会话持有（SessionRegistry）            | ✅（models 先给空表，模型域在 W5）                         |
| W5    | 模型目录帧 / 会话可见面投影 / 打开历史会话                                                       | ✅（工具审批与流式增量在 W6）                              |
| W6    | 工具装载 + 审批协议面                                                                            | ✅（装载已生效；审批等待方已就位，调用方在 W7 自定义工具） |
| W7~W8 | 自定义工具（审批真正触发）/ 子代理 / 插件终端 / 删老树                                           | 未开始                                                     |
| W7    | 删老树（`agent-service.ts` 不存在）                                                              | 未开始                                                     |

W3 之后 `CoreEngine.attach()` 仍默认关闭（`CoreEngineNotReadyError`）：能实例化、能过契约测试、能给空对话出合法帧、能真开一份 SDK 会话，但**连接期帧（settings_state / sessions / models / projects）还没接**，所以还不接生产流量。

## 复用而不是重写

老树已经拆出的叶子模块（`session-turns` / `conversation-delivery` / `tool-manager` / `workspace-queue` /
`versioned-doc` / `conversation-rows` / `queue-utils` / `session-projection` / `approval-rules` / `files-service` …）
一律原样 import；新树只重写「把它们捏在一起」的编排层。叶子模块里的红线（单源、fail-closed、前缀缓存）
继续有效，改动它们要跑各自的守卫测试。

## 已定的口径（W0 期间裁定，改需在 PR 里说明）

- **出帧**：`SnapshotPublisher.flush({ changed: false })` 才会走 skip；调用方要「内容没变就不发」必须显式传参，别指望域自己判断内容。
- **交互收件箱**：`drain(kind)` 只摘除不结算（逃生口，用了要自己结算，否则等待方悬空）；`shouldAutoApprove` 是**单条规则**便捷口，整表「deny 优先」仍由 `approval-rules.ts` 负责。
- **工具门控**：`resolveActiveToolNames` 只做并集减法；调用方必须先过滤 `onDemand`（核心工具永不延迟），域里不做第二套兜底。
- **线适配器**：`DispatchSession` 现有 **183** 个唯一成员（184 条声明，`forkSession` 重复），清单由 `scripts/gen-core-dispatch-surface.mjs` 生成；未提供 handler 的成员**同步抛** `CoreEngineNotReadyError`（fail-closed，不返回 rejected promise）。
- **错误类**：`CoreEngineNotReadyError` 住在 `contracts/`（否则 `adapters` 要依赖 `app`，违反分层）。
- **轮次**：`deliverAs` 只在 `running` 相位可用；`running` 却不传 `deliverAs` 直接拒（不静默叠轮）；退役错误不做 `instanceof` 分支，靠「全程无 catch」结构性透传。
- **历史行**：`openIds` 只参与去重（不参与归属）；`cwd` 只筛磁盘历史行；纯磁盘历史行不带 `kind`。
- **attach**：`CoreEngine.attach` 需 `PI_WEB_PI_ENGINE_ATTACH=1`；默认关闭，原因是会话实体（SDK）还没接。
- **快照**：全量帧永远可出；增量帧拿不到 `appended` 之前降级为全量 `snapshot`（不假装增量）。
- **设置**：域只投影已有 `normalize*` 单源的 18 个键，其余键留给后续波次，避免在域里复制归一化。
- **转录**：`skippedLines` 合并三种口径（坏行 / 序列化为 null / 整份不可用）；`seq` 对 null 消息不占位。
- **状态落盘**：`StatePort.write` 保持同步签名，适配器**派发**一次异步落盘并另给 `flush()` 等待点（versioned-doc 只提供 async 写，不另开写入路径）。
- **开会话**：`openTurnSession` 有 `sessionFile` 只续开、不偷偷新建；结果必过 `guardSession`；`dispose` 不发 `session_shutdown`（留给生命周期波次裁定）。
- **会话持有**：`SessionRegistry` 开会话前先判相位（fail-closed），开会话失败不留半成品，`close` 幂等。
- **连接期帧**：由组合根装配进 `ClientRuntime.attachFrames`；`refreshSessions` 的历史根**取自真开过的会话文件目录**（不猜 SDK 布局），没开过会话就发空帧。
- **项目帧**：当前 cwd 的插入项 `lastUsed: 0`（客户端据此排在真实对话过的项目之后，但位置在最上）；来源读失败发空列表；沙盒项目待 W5。
- **设置帧**：`SettingsHost` 的 apply*/reload/promptSnapshot 在 W5 前是安全空值（绝不抛），`isDisposed`/`isStreaming` 是构造期快照。
- **模型帧**：域只认注入的 `runtimeFactory`（SDK 的 `ModelRuntime` 只在 `adapters/models/` 里建），失败发空表；`enabled` 高亮留给 app 层叠加。
- **会话可见面**：`adapters/sdk/view.ts` 把会话消息经 `serialize.ts` 投影成 `UiMessage`（id 稳定），并在开会话时订阅事件触发重帧；流式增量仍是「整段重投影」，细粒度 delta 待消息窗口域。
- **打开历史**：`openHistoryConversation` 先按 `sessionFile` 去重再建，读盘/投影失败不抛（空消息 + 计数）。
- **工具装载**：开会话前由装载域算 `resolveToolLoadout(...).tools` 传给 SDK；活动集只经 `resolveActiveToolNames` 这一个漏斗，装载域只备料（禁用集/平台支持/按需未加载）。
- **自定义工具**：`customToolsFor(conv)` 一个对话一份闭包（工具里要带会话身份）；`ask_user_question` 已接，经 `InteractionInbox` 的 question 类进出。
- **审批**：SDK 没有审批钩子——审批只能长在自定义工具里（`tool-guards.ts` 的 `askApproval`）。所以 `createApprovalWaiter` 现在只是协议面就绪（登记 → 发 `tool_approval_pending` → 结算 → 发 `tool_approval_resolved`），**内置工具仍绕过审批**，真正触发要等 W7 自定义工具。

## 源码约定

- tab 缩进、`printWidth 120`、import 带 `.js`、类型用 `import type`。
- **不写文件头注释**；只给非显然的约束留一句短说明（见 `docs/agent-rules.md` §六）。
- 门面（`app/core-engine.ts`）里禁止出现业务分支：每多一个 `if`，编排就回到了上帝对象。

## 交接清单（下一次接着做）

按「解锁价值 ÷ 成本」排序，每条都已标注现状与入口：

1. **审批真正生效**（最高价值）：SDK 没有审批钩子，内置 `bash`/`edit` 绕过 `askApproval`。
   做法：用 SDK 的 `createBashTool` / `createEditTool` 等工厂 + `server/tool-guards.ts` 的
   `withToolGuards({ askApproval: approvalWaiter.request })` 造出同名的自定义工具，
   在 `customToolsFor` 里替换内置同名工具；`approvalWaiter` 已经在 `app/core-engine.ts` 里建好、`resolveToolApproval` 已接。
   待验证：自定义工具与 `tools: string[]` 同名时 SDK 的覆盖语义（先写一条最小集成用例确认）。
2. **会话管理接 dispatch 表**：`deleteSession` / `renameSession` / `renameConversation` / `dismissConversation`
   已接进 `ClientRuntime.handlers()`（`isAllowedPath` 由组合根注入 `agentDir/sessions`）；
   还差「重命名标题落盘到会话文件头」（`renameSession` 目前只做归一，写盘要 `appendSessionInfo` 一类叶子）。
3. **`stop` 语义**：`abort()` 直接调 `session.abort()`；要补 `TurnRunner` 的 aborted 结算与 UI 回执。
4. **子代理 / 终端 / 插件运行态 / `present_files` / `communicate`**：都需要 `tool-host-factories.ts` 的宿主能力，
   一个域一个域搬（对应老树 580 方法里的 `subagent*` / `terminal*` / `plugin*` / `files` 几簇）。
5. **W9 删老树**：`agent-service.ts` 退场 + 18 个守卫重定向 + 71 个白盒测试按域重写
   （`tests/helpers/fake-session.ts` 会随之删除——它存在的唯一目的是给上帝对象造假体）。
