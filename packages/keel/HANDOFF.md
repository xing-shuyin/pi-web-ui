# 交接：keel 成为 pi 默认引擎（进行中）

> 分支 `keel/migration`（未 push）。本文件是给下一位接手者的事实清单，**不含推测**；
> 每条都带可复跑的命令或 `文件:行`。

## 0. 一句话状态

pi 的默认引擎**已从 legacy（`AgentService`）翻到 keel（`CoreEngine`）**，但冒烟还没追平：
**61/98**（翻转前 legacy 基线 96/98）。单元测试已全绿。剩下的都是「core 模式缺行为」，
清单在 §4，已定位到文件与行，不需要重新分诊。

## 1. 开关（回滚只要一条环境变量）

| 变量                      | 默认   | 作用                                                       |
| ------------------------- | ------ | ---------------------------------------------------------- |
| `PI_WEB_PI_ENGINE`        | `core` | 设 `legacy` 立刻回老实现（迁移止损口，不是并行第二套实现） |
| `PI_WEB_PI_ENGINE_ATTACH` | 开     | 设 `0` 只建引擎、不接连接（隔离排查用）                    |

实现：`packages/keel/src/app/engine-mode.ts`。

## 2. 复现与验收

```bash
npm run typecheck                     # 6 个 tsconfig，当前 0 错误
npx vitest run                        # 当前 15831 ✓ / 0 ✗ / 53 ○（1 个 clock flake 见 §6）
node tests/run-smoke.mjs              # 当前 61/98
PI_WEB_PI_ENGINE=legacy node tests/run-smoke.mjs   # 基线 95~96/98（对照用）
node .scratch/app-deps.mjs            # keel 对宿主模块依赖：必须是 0
node scripts/gen-core-dispatch-surface.mjs --check  # 185 成员
node scripts/gen-core-ownership.mjs --check
```

冒烟支持按名跑单个用例：`node tests/run-smoke.mjs slash-commands-test ...`。

## 3. 本批已完成（三层）

### 3.1 分发面 185/185，零 unsupported

所有 `DispatchSession` 成员都有实实现，最后 7 个「别的引擎专属」走端口转发（宿主包现有实现）：
`contracts/engine-extras.ts` + `domains/engine-extras/` + `server/core-engine-extras-adapter.ts`。
DSH 补丁 6 与 `setClaudePermissionMode` 在 pi 连接上调到会回可读错，不静默假成功。

### 3.2 引擎级钩子补齐（调研说原来的 1/13 → 5/13）

`app/dispatch-handlers.ts` + `host-faces.ts`：

- 插件 AI 工具 / 命令目录真进会话工具表（`slash_commands` 帧带 `source:"plugin"`）
- tool 守卫 pre/post 挂在内核重建的 `bash/write/edit` 上
- `recordInterruptedRuns` 真写 `ClientStateStore`
- `refreshBackgroundServers` 真出面板行

### 3.3 出帧红线第一次有守卫

`tests/unit/snapshot-channel-single-source.test.ts`：闸外不许出现 `type:"snapshot(_delta)"` 字面量、
不许自持会话级基线、`forceFull` 只许作转发形参。**先红后绿**抓到并修掉了 dsh / universal 各自手判全量/增量。

### 3.4 本批冒烟修复（42 → 61）

| 根因                                               | 修法落点                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **A** attach 不建首条对话（27 用例的第一步就超时） | `app/connection-init.ts` 的 `initializeConnection()`（`core-engine.ts:442` 调用）                                |
| **B** 连接期不推初始态帧                           | 同上：对照 legacy `attachSink()` 的 12 类帧一次推全                                                              |
| **K** 同 clientId 重连不换 send / quiesce 不拦     | 同上 + `core-engine.ts` attach 路径                                                                              |
| **C** `new_chat` / `set_cwd` 变更后不出帧          | `domains/sessions/workspace.ts` + `rebindFrames().pushConversations()`                                           |
| **D** `prompt` 不执行斜杠命令                      | `app/prompt-entry.ts` 的 `submit()`：斜杠优先、命中不进模型；命令表仍全在宿主 `SlashCommandsService`             |
| **F** `get_state{rev}` 的 `since` 被丢             | `domains/snapshots/publisher.ts`（内容未变不发帧；rev 不匹配补全量）                                             |
| **H** `prompt` 丢 attachments                      | `contracts/attachments.ts` + `domains/turns/attachments.ts` + `server/core-attachments-adapter.ts`（接线已补完） |
| **I** 历史列表根未知                               | `client-runtime.ts` 的 `historyRoot()`：学到的目录优先，否则按 legacy 公式现算                                   |
| **J/G/L 部分**                                     | `snapshot-view.ts` 的 `isEphemeral`、`builders.ts` 的 `stats`、`server/core-model-adapter.ts` 的模型运行时预热   |

## 4. 剩余冒烟失败（35 个）——已分诊，按此顺序做

> 分诊原文 `.scratch/smoke-triage.md`（16 个根因表 + 证据）。以下是**尚未修**的部分。

### P1 · 组合根的 `notWired` 组（一次能带绿 4~6 个用例）

`server/core-settings-adapter.ts:108-134` 里这些还是空实现：
`applyToolGating`、`applySessionOverrides`、`applyCompactionOverrides`、`applyQueueModes`、
`applyRetryOverrides`、`applyCodemodeOverrides`、`promptSnapshot`、`getLocale`。
影响用例：`settings-test`（卡 `effectiveSystemPrompt`）、`tool-prompt-test`（`toolsSchema` len=0）、
`lazy-tools-test`（设置改了但会话活跃集不变）、`subagent-template-test`（zh-TW 永远出厂简中）。
建议一行级先补 `promptSnapshot`（接宿主 `prompt-composer`）与 `getLocale`（`stateStore.get(clientId).locale`）。

### P2 · 插件引擎级钩子还差 8 个（带绿 `plugin-cwd` / `plugin-client-conversation`）

`onClientCwdChanged` / `onClientModelChanged` / `onConversationChanged` / `readConversationForPlugins` /
`onToolEvent` / `onRunEvent` / `chatFromPlugin` / `onClientCwdChanged` 在 `packages/keel/src` 里 0 个调用点；
`pluginClient()` 在 `CoreEngine` 上不存在（`server/index.ts:2342-2346` 走 `piServiceInstance.pluginClient()` → 被 try/catch 吞）。
调用点必须在 `core-engine.ts`（有机生命周期的地方）。

### P3 · MCP 项目运行态（`mcp-bridge-test`）

`grep mcpProject packages/keel/src` 只有 `engine-service.ts:424-425` 两条声明。legacy 在会话创建时
`mcpProjects?.retain(cwd)`（`agent-service.ts:5052`）与 `prepare(cwd)`（`:5078`）；组合根
`server/index.ts:2200-2211` 的 `isProjectInUse` 依赖 `svc.mcpProjectCwds?.()`。

### P4 · 计划/审查者模式的真门禁（`plan-mode-test` / `delegate-mode-test`）

快照字段会翻，但会话工具表没跟上：`applyToolGating` 空实现（同 P1），以及派活链缺失。

### P5 · Bot 私聊投影（`bot-chat-reopen-test`）

`contracts/snapshot-view.ts` / `domains/history/frame.ts` 都没有 `bot`/`botId` 字段，`boundTo()` 永假。

### P6 · takeover / orphan / 离线宽限 系列（8 个用例）

首跳已通（A 修复后能跑到问卷/notice），缺的是 legacy 的「跨客户端孤儿账」：
`findAdoptableOrphan`、离线宽限、问卷桥。注意 `takeover-rollback-test` 在 **legacy 下也一样红**（既有缺陷，别当回归）。

### P7 · 两条未定位（`.scratch/smoke-triage.md` §4）

- `device-project-collaboration-test`：Hub 派活成功但设备侧 mock `Requests: []`（一次 SDK 都没调）
- `scm-features-test`：`scm_commitmsg` 20s 无回帧，链路看似齐全，疑似端口内 `ModelRuntime.create` / 无凭证推断挂住

## 5. 架构红线（改之前务必读）

- `server/protocol.ts` 与 `PROTOCOL_VERSION` 不动；`packages/keel/src/protocol.ts` 只有 `4123/4124` 的预算（只许降）。
- 分层：`contracts ← kernel ← domains ← app`；adapters 只依赖 contracts+kernel+adapters；域间禁互引。
  SDK 只许在 `domains/turns/feed.ts` 与 `adapters/{sdk,models,tools}/`。
- 单文件 ≤600 行（守卫按 `split("\n")` 计数，即实际 599 行）。当前最紧：`client-runtime.ts` 358、
  `dispatch-handlers.ts` 496、`host-faces.ts` 374、`core-engine.ts` 414。
- 端口未注入 → handler **同步抛** `CoreEngineNotReadyError`（不用 `async` 包，否则变 rejected promise）。
  可选钩子未注入 = 「没有钩子」，不是硬依赖。
- **不为兼容留第二套实现**：要搬就搬、要包就包，不许复制一份逻辑。
- 改完必跑：`npm run typecheck`、`npx vitest run`、`node .scratch/app-deps.mjs`（必须 0）、
  `gen-core-dispatch-surface/ownership --check`、`npx prettier --check`、`npm run lint`。

## 6. 已知 flake（不要当回归）

| 用例                           | 现象                                     | 判定                 |
| ------------------------------ | ---------------------------------------- | -------------------- |
| `scheduler-tasks.test.ts`      | cron 排期在并行负载下偶发 1 条           | 单跑 34/34 绿        |
| `universal-subagent-record`    | `EPERM rmdir`                            | Windows 临时目录占用 |
| `group-ecosystem-http-ws`      | `ENOTEMPTY`                              | 同上                 |
| `desktop-files` 硬链接 staging | 并行下偶发                               | 单跑绿               |
| `conv-cwd`（冒烟）             | `--jobs=2` 下偶发连到别的用例遗留 server | 单跑 `--jobs=1` 稳定 |

## 7. 下一批建议（按性价比）

1. **P1 组合根 notWired**（4~6 个用例，改动小、风险低）→ 冒烟上 65 左右
2. **P2 插件钩子**（2 个用例，但要碰 `core-engine.ts` 生命周期）→ 67 左右
3. **P3/P4**（MCP retain + 工具门禁真生效）→ 70 左右
4. **P5/P6**（Bot 投影 + 孤儿移交）→ 这两块是真正的新能力，建议单独排期
5. 追平后：把 `resolvePiEngineMode` 的 `legacy` 分支标成 deprecated，再进 P5 发布
   （`packages/keel/MIGRATION-PLAN.md` 的 P5~P6）

## 8. 用子代理的方式（本会话实操，建议照搬）

这一轮迁移几乎全靠子代理推进（单批 2~3 个并行）。**这套流程本身是交付物的一部分**，照做能省大量返工。

### 8.1 分工：共享文件只能有一个主人

- `app/core-engine.ts` / `app/client-runtime.ts` / `app/host-faces.ts` / `server/index.ts` 是**所有轨都想改**的地方。
  做法：指定**一个轨独占**，其它轨只交「可粘贴 patch（目标文件 + 行号 + 代码）」，由调度方合并。
- 域文件按目录切（`domains/goals/**` vs `domains/turns/**` vs `domains/sandbox/**`），互不重叠。
- 并行度 2~3；超过 3 个时冲突收益比会反转。

### 8.2 任务书必须有的六段

1. **背景 + 根因证据**（`文件:行`，让代理不用重新调研）
2. **你的文件面（独占）** —— 明确列出
3. **绝对不能改** —— 尤其是别的轨正在写的文件、`protocol.ts`、`web/src/**`、别的会话的文件
4. **验收命令**（可复跑的那几行）
5. **止损线**（做不动就回退该项并写清差哪一行接口，**不许写空实现**）
6. **回报格式**（逐项：改法/文件行数/实测输出/未做项）

### 8.3 铁律要写进每一份任务书（代理不会自动遵守）

- 不改 `server/protocol.ts` / `PROTOCOL_VERSION` / `packages/keel/src/protocol.ts`（4123/4124）
- 不放宽 `core-boundaries`；单文件 ≤600 行（守卫按 `split("\n")`）；tab 缩进；import 带 `.js`
- **不为兼容留第二套实现**：要搬就搬、要包就包
- 端口未注入 → handler **同步抛** `CoreEngineNotReadyError`
- `appDepsOf` 必须仍为 **0**
- **不 commit、禁 `git add -A`**

### 8.4 调度方必须自己复验（不要信「绿了」）

每批回来至少自己跑一遍：`npm run typecheck` + `npx vitest run` + `node .scratch/app-deps.mjs`（看实测输出，
不是看断言）+ `gen-core-{dispatch-surface,ownership}.mjs --check` + `prettier --check` + `npm run lint`。
本会话就靠这一步抓到过「代理说绿了，但 `protocol.ts` 预算超了 1 行」「`OWNERSHIP.md` 过期」这类。

### 8.5 先分诊，再派实现轨

冒烟从 42/98 起步时，**第一个子代理只做只读分诊**（跑两轮 core/legacy 冒烟取差集 → 16 个根因表），
之后三条实现轨各自对着根因表干活，一次就把 42 推到 61。比让代理自己边查边改快得多。

### 8.6 停止条件（踩过）

代理上下文 >600k 且**连续两轮输出同一句话**（在反复读同一批文件）→ 直接 `conversation stop`，
把它已改的东西留住（`git status` 确认），换一个**范围更小**的新代理接手。
本会话的 `smoke-lane-c` 就是这样卡在 G/I/J 上，停掉后由主会话补完接线。

### 8.7 一次踩坑的教训：`git add -A` 会吞掉别人的改动

工作区里同时有**另一个会话**在改 `web/src/**`（问卷队列、终端抽屉直角）。本会话一次 `git add -A`
把它们卷进了 keel 提交，事后用 `git reset --soft HEAD~1` 拆成独立提交（`c635a5dc`）。
**结论**：提交前先 `git status` 逐文件确认归属；跨会话协作时只 `git add <显式路径>`。
