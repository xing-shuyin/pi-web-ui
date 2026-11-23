# 巨型模块拆解方案（ClientSession / App / SettingsModal / use-chat）

> 状态：**提案（已被取代）**。字后选定路线是 C（重写编排层），见 [`god-object-rewrite-plan.md`](god-object-rewrite-plan.md)；本文的 **P0 地基（边界守卫 / 快照预算 / 假体跟随）** 仍作为 C 的回退路线（C 的 kill criteria）保留。
>
> 目标是把当前 21 个 >2500 行、176 个 >800 行的源文件，按「状态归属」而不是「行数」拆成高内聚、低耦合的域，且全程行为不变、可逐步回滚。
> 相关红线：[`agent-rules.md`](../agent-rules.md#四架构与运行态约束) · 既有接缝范例 `server/engine-service.ts` 的 `DispatchSession` + `server/dispatch-*.ts`。

## 1. 结论先行

1. **这不是「文件太大」的问题，是「一个可变聚合体承载了全部域」的问题**。`ClientSession` 16,781 行、580 个方法、478 个不同的 `this.*` 成员；其中 `convs` 被 172 个方法碰、`activeId` 70 个 —— 光把方法搬到别的文件，会让 20 个模块互相递归 import，耦合反而上升。
2. **拆解轴必须是「状态 + 生命周期」，不是「方法名」**：谁拥有那份字段，谁就搬到那个域里；`ClientSession` 退化成 **组合根 + 传输口**。
3. **接缝用本仓库已经验证过的模式**：`<domain>/contract.ts`（窄接口）+ `<domain>/impl.ts`（`fn(host, …)` 纯函数/类）+ 类上的**一行委托**。第一步不动 342 处外部调用点，因此可以一个域一个 PR 往前推，每步都能 `typecheck` + 单测。
4. **前端同病同治**：`SettingsModal`（28 个内联 `tab ===` 块）、`use-chat`（单 switch 226 个 case）、`App.tsx`（163 个 hook）分别对应「块渲染」「消息 reducer」「编排层」，拆法与后端同构。
5. **必须有防回潮机制**：行数预算守卫（只许降）+ 模块边界守卫。否则拆完半年又长回来 —— 这才是历史上真正失败的环节。

## 2. 一次测量（事实）

| 指标 | 数值 |
| --- | --- |
| 源文件 >800 行 / >1500 行 / >2500 行 | 176 / 58 / 21 |
| `server/agent-service.ts` | 17,839 行；`ClientSession` 占 16,781 行 |
| `ClientSession` 方法数 / 不同 `this.*` 成员数 | 580 / 478 |
| 方法体分布 | >300 行 6 个、150~300 行 8 个、60~150 行 41 个、**<60 行 525 个** |
| 被其它 server 模块调用的方法（去重） | ≈342 个 |
| 引用 `ClientSession` 的文件 | 95（server + tests + web/desktop 类型） |
| `DispatchSession`（本该是窄接口） | 185 个成员 —— 已退化成同一张上帝脸 |
| `web/src/components/SettingsModal.tsx` | 7,424 行，28 处 `{tab === "…"}`，25 个 tab id |
| `web/src/use-chat.ts` | 3,369 行，单个 `switch (msg.type)` 226 个 case（848→2281 行） |
| `web/src/App.tsx` | 3,931 行，163 个 `use*` 调用 |
| `server/protocol.ts` | 4,123 行，204 个 interface，纯类型（无运行时导出，前端 `types.ts` 是 re-export shim） |
| 安全网 | `tests/unit` 1,272 个测试文件；`npm run typecheck` 覆盖 6 个 tsconfig；`npm run ci:local` |

字段热度（占用方法数，前 12）：`convs` 172 · `emit` 141 · `settingsSvc` 74 · `activeId` 70 · `flushSnapshot` 69 · `cwd` 64 · `stateStore` 60 · `conv()` 52 · `disposed` 40 · `clientId` 36 · `getLang` 33 · `modelAdmin` 31。

## 3. 根因：三种病，一个共同点

| 病种 | 典型 | 病因 | 正确药方 |
| --- | --- | --- | --- |
| **上帝聚合体** | `ClientSession`(580 方法) · `AgentService`(72) · `hub.ts` | 状态、业务、传输、注册表全在一个对象里；方法虽小（525 个 <60 行）但**共享同一批可变字段** | 按字段簇切子聚合（`ConversationRegistry` / `SubagentRuntime` / `TerminalHost`…），方法跟着状态走 |
| **上帝组件** | `SettingsModal`(7.4k) · `App.tsx`(3.9k) · `LeftPanel`(3.3k) | 独立功能的内联渲染块 + 共享闭包状态 | 一 tab/一面板一文件 + 显式 props（或单一 `SettingsContext`），纯机械搬移 |
| **宽而平** | `protocol.ts`(204 interface) · `dsh-agent-service` | 单源文件物理过大，逻辑不复杂 | 按域拆文件 + barrel re-export，**零设计变更**，只为可读性与合并冲突 |

共同点：**内聚不是被「文件大小」破坏的，而是被「没有所有权边界」破坏的**。所以拆解的第一性问题永远是：*这份可变状态归谁？谁允许写它？*

## 4. 方案对比

| | A. 纯物理切文件 | B. 按域拆状态聚合（推荐） | C. 重写/新架构并行 | D. 只加 lint 上限 |
| --- | --- | --- | --- | --- |
| 做法 | 把 17.8k 行按行号切 `part1/2/3` | 每个域一个子聚合 + 窄 host 契约，类上留委托 | 新模块树重写，旧模块冻结 | 启用 max-lines，逐文件豁免 |
| 内聚 | ❌ 不提高 | ✅ 状态与行为同处 | ✅ 最高 | ❌ 只是停止恶化 |
| 风险 | 🔴 高（拆出 20 个互相 import 的模块，共享字段靠导入对方） | 🟡 低（每步可 typecheck + 单测） | 🔴 极高（1272 测试 + 342 调用点全部重验） | 🟢 无 |
| 工作量 | 2~3 天 | 后端 10 步 + 前端 4 步，约 3~4 周 | 2~3 个月 | 0.5 天 |
| 值不值得 | 单独做＝负收益（可读性换耦合） | ✅ | ❌ 没有用户价值支撑 | 只能当附录 |

**结论：选 B；A 只作为 B 里「纯类型文件」和「无状态渲染块」这两类的执行手法；D 作为 B 的收尾守卫（见 §7）。**

## 5. 推荐方案的接缝约定

```
server/<domain>/
  contract.ts    # 该域对外暴露的窄接口（10~30 个成员），只描述「域需要宿主提供什么」
  impl.ts        # 域实现：class DomainRuntime { constructor(host: DomainHost) } 或 fn(host, …)
  index.ts       # barrel（可选）
```

四条硬约定：

1. **状态跟着域走**：域的私有字段搬进 `impl.ts` 的类里，`ClientSession` 的构造函数 new 一次并持有引用（组合根）。
2. **域之间不互相 import**：只允许 `contract.ts` 之间 type-only 引用；需要跨域能力时，加到宿主的窄契约里，由 `ClientSession` 转发（显式依赖 > 隐式 import）。
3. **`ClientSession` 上的同名方法先保留为一行委托**（`listFiles(p) { return this.filesDomain.listFiles(p) }`）。这一步让**342 个外部调用点零改动**、95 个引用文件零改动。
4. **`server/agent-service.ts` 这个路径和 `ClientSession` 这个类名不能变**：`tests/helpers/fake-session.ts` 直接解析该文件里该类的类体推导字段默认值，`tests/unit/fake-session-sync.test.ts` 还断言「>60 个字段 + 原型方法全在假体上可取」。改路径/类名＝打断整条测试假体链。

## 6. 分阶段路线

### P0 地基（前置，必须先做，1~2 天）

| 步骤 | 内容 | 为什么必须在前面 |
| --- | --- | --- |
| P0.1 | **让测试假体跟随组合**：扩展 `tests/helpers/fake-session.ts`，支持从 `SOURCES` 里的多个类推导字段，并在 `fakeClientSession()` 里按 `collaborators` 声明递归造子假体 | 状态一搬出 `ClientSession`，现有「`cs.convs = new Map()`」式覆写会失效；先改假体，后面的搬移才不会被 1,272 个测试反噬 |
| P0.2 | **行数预算守卫** `tests/unit/file-size-budget.test.ts`：把当前超限文件按现值写入上限，规则「只许降、新文件 >800 行直接红」 | 拆解的第一天就要防止回潮，否则边拆边长 |
| P0.3 | **模块边界守卫** `tests/unit/module-boundaries.test.ts`：①`server/<domain>/**` 不得 import `agent-service.js`；②域之间不得互相 import（除 `contract.ts` type-only）；③`plugins/*/client/vendor/**` 与 `plugins/office/artifacts/**` 白名单排除 | 把「低耦合」变成可执行断言，而不是口头约定 |

### P1~P9 后端（按状态内聚度排序，不是按行数）

排序依据：**一个域能不能把字段一起带走** + **扇入大小**。

| 阶段 | 域 | 搬走什么（现状位置） | 带走的状态 | 关键方法（示例） | 预估 |
| --- | --- | --- | --- | --- | --- |
| **P1** | 会话注册表与生命周期 | `newChat`(220) · `switchSession`(329) · `loadSessionInfos`(229) · `forkSession`(157) · `rollbackSession`(125) · `deleteSession`(123) · `dismissConversation`(158) · `insertTakeoverConvs`(132) | `convs` · `activeId` · `convSeq` · `sessionFileCache` | `makeConversation` · `conversationIdOfSession` · `removeConversation` · `emitConversations`(120) | 3~4 天 |
| **P2** | 出帧/快照编排 | 141 个方法碰 `emit`、69 个碰 `flushSnapshot` | `sinks` · 定时器 · `uiMessageCache` | `emit` · `scheduleSnapshot` · `buildLightState`(118) · `emitSnapshotNow` | 2~3 天（`snapshot-channel.ts` 已是出帧单源，这里搬的是**编排**） |
| **P3** | 子代理运行态 | `spawnSubagentConversation`(384) · `handoffSubagent`(159) · 16 个 `subagent*` 方法 + 结算/预算/账本访问器 | `subagentSettleStore` · `subagentSpawnBudgetStore` · `subagentLedgerStore` | `subagentOwnerOf` · `recordSubagentRunStart` · `startSubagentRecycleTimer` | 2~3 天 |
| **P4** | 设置 / 模型 / 预设 | `setSettings`(119) · 12 个 `apply*` · 14 个 `refresh*` · 9 个 `push*` | `settingsSvc` 相关代理、`modelAdmin`、`pluginModelKeys` | `setModel` · `applySessionModel`（红线：换模型只走它） · `pushSettings` | 2 天 |
| **P5** | 插件 / 扩展 / MCP 运行态 | `reload*`(5) · `check*`(4) · plugin run/bg task 桥 | plugin run 注册表 · `mcpProjects` | `reloadExtensions` · `reloadMcp` · `syncPluginToolsIntoSession` | 2 天 |
| **P6** | 终端 / 原生 CLI | `apply*Terminal*` · `notifyTerminal*` · `handleTuiOverlay*` · `startNativeCliTerminal` | terminal manager 工厂与句柄 | `makeTerminalManager` · `handleNativeCliEvent` | 2 天 |
| **P7** | 工具门控 / 提示词 | `toolOverrideSpecs`(304) · `loadLazyTools`(118) · `botToolAuthorization` 系 | 工具开关快照 · 按需加载集合 | `applyToolGating` · `lazy*`(8) · `getToolPrompt` | 2 天 |
| **P8** | 交互收件箱（审批/问卷/电话/页面） | `askApproval`(146) · `resolve*`(11) | pending 审批/问题注册表 | `resolveToolApproval` · `resolveQuestion` · `cancelPendingApprovals` | 1~2 天 |
| **P9** | 目标 / 计划 / Bot 策略 | goal(13 方法) · plan(4) · bot(7) | `goalSvc` · `planManager` · `botExecution` 代理 | `setGoal` · `updatePlan` · `botOf` | 1~2 天 |

> `dsh-agent-service.ts`(5,966) 与 `agent-service.ts` 共用同一套拆法，等 P1~P9 的接缝定型后照搬（预估 3~4 天）。`hub.ts`(4,313) 同理，但它属于设备中心，可独立排期。

### P10~P13 前端

| 阶段 | 对象 | 手法 | 预估 |
| --- | --- | --- | --- |
| **P10** | `SettingsModal`(7,424) | 28 个 `{tab === "x" && (…)}` 各自抽成 `web/src/settings/tabs/<Tab>.tsx`；`settings` / `setPartial` / `chat` 走单一 `SettingsFormContext`；tab 表已存在（`tabs` 数组 + `TAB_GROUPS`），改成 `render: ComponentType` 即可 | 2 天（纯机械，收益最大） |
| **P11** | `use-chat.ts`(3,369) | 226 个 case 抽成 `web/src/chat-messages/<family>.ts`，注册表 `Record<ServerMessage["type"], Handler>`，上下文用窄接口 `ChatMessageContext`（与后端 `DispatchSession` 同构）；保留 `switch` 里未识别类型的 `default` 兜底 | 3 天 |
| **P12** | `App.tsx`(3,931) | 按「一块状态 + 一组副作用」抽 hook：`useDraftAttachments` / `usePreviewOpenState` / `usePanelLayout` / `useModalStack`；渲染层抽 `WorkspaceShell`（顶栏 + 三栏 + 底坞） | 4~5 天（最需要回归测试） |
| **P13** | `LeftPanel`(3,326) · `Message`(2,251) · `ChatInput`(2,249) | 行/列表/筛选分离；`Message` 按消息类型分渲染器 | 3 天 |

### P14 纯类型拆分（零风险，可插队）

`server/protocol.ts` → `server/protocol/{core,chat,files,terminal,device,canvas,plugin,bot}.ts`，`protocol.ts` 只留 `export type * from "./protocol/*.js"`。

三条约束（现有守卫已经覆盖）：`checks:protocol` 要求 `protocol.ts` 无运行时导出、`web/src/types.ts` 仍是 `export type * from "../../server/protocol"` shim。改动后跑 `npm run check:protocol` 即可验证。

## 7. 防回潮机制（方案的一部分，不是可选项）

1. **行数预算只许降**：`tests/unit/file-size-budget.test.ts` 维护 `{ "server/agent-service.ts": 17839, … }`，每完成一个 Pn 就把上限改成实际值；文件超限即红。新文件默认上限 800 行。
2. **边界断言**：§6 P0.3 的 `module-boundaries.test.ts`；外加「`agent-service.ts` 内 `ClientSession` 只允许委托」的纯度守卫（阈值随阶段下调：`ClientSession` 内 `if`/`switch` 数量上限只许降）。
3. **文档跟随**：每拆完一个域，在 `AGENTS.md` §1 表格里把事实源指向新目录，并按 `tests/unit/docs-index.test.ts` 的锚点规则补 `docs/`（拆解细节写进 `docs/architecture-core.md` 的对应小节，不放本提案）。

## 8. 每一步的 DoD（完成定义）

```bash
npx prettier --write <改动文件>
npm run typecheck     # 6 个 tsconfig 零错误
npx vitest run tests/unit/<相关域>.test.ts tests/unit/fake-session-sync.test.ts \
              tests/unit/file-size-budget.test.ts tests/unit/module-boundaries.test.ts
npm run lint
```

- 该域手工验收路径（如会话切换、子代理派发、设置保存）行为不变；
- `git diff` 里**只有搬移 + 委托**，没有顺手改行为（纯搬移的 review 成本才是可控的）；
- 预算上限已下调，`AGENTS.md`/文档事实源已更新。

## 9. 不做的事

- ❌ 不动 `plugins/legado-web/server/engine.mjs`(60,028)、`plugins/vscode-editor/client/entry.mjs`(44,323)、`plugins/*/client/vendor/**`、`plugins/office/artifacts/**`：第三方引擎/构建产物，改了必被覆盖。
- ❌ 不为了拆而改公开方法名（342 个调用点是成本，不是收益）。
- ❌ 不重写 `ClientSession`（C 方案）。
- ❌ 不拆 `protocol.ts` 的语义（它本来就该是纯类型单源），只做物理拆分。
- ❌ 不把域拆成独立 npm 包（当前是单仓库单进程，包边界只增加成本）。

## 10. 建议的启动顺序

1. **P0.1 假体跟随 + P0.2 预算守卫 + P0.3 边界守卫**（1~2 天，先把「拆」变成可持续的机械动作）。
2. **P14 协议纯类型拆分**（半天，练手 + 立刻见效，风险为零）。
3. **P10 SettingsModal**（2 天，前端收益最快、最机械）。
4. **P1 会话注册表**（后端第一个真域，验证接缝约定；它的结论决定 P2~P9 的写法）。

做完这四步，再决定是否继续 —— 前三步合计不到一周，就能把「巨型模块」从长期趋势变成单调下降的曲线。
