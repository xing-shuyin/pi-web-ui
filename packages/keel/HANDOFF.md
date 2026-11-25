# 交接：keel 成为 pi 默认引擎（进行中）

> 分支 `keel/migration`（未 push）。本文件是给下一位接手者的事实清单，**不含推测**；
> 每条都带可复跑的命令或 `文件:行`。

## 0. 一句话状态

pi 的默认引擎**已从 legacy（`AgentService`）翻到 keel（`CoreEngine`）**。
**P1 ~ P6 批次已全数完工并提交**（最新提交 `b1cf2109`：`feat(keel): complete P6 takeover, orphan and subagent coordination`）。
单元测试全绿（15831 ✓）。冒烟已大幅追平至 **96/98**（legacy 基线 96/98）。
当前仅剩最后的 **P7（2 个待定用例）**，见 §4。

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
node tests/run-smoke.mjs              # 当前 ~96/98（基线 96/98）
PI_WEB_PI_ENGINE=legacy node tests/run-smoke.mjs   # 基线 95~96/98（对照用）
node .scratch/app-deps.mjs            # keel 对宿主模块依赖：必须是 0
node scripts/gen-core-dispatch-surface.mjs --check  # 185 成员
node scripts/gen-core-ownership.mjs --check
npm run lint                          # 0 错误
```

冒烟支持按名跑单个用例：`node tests/run-smoke.mjs --no-build <test-name>`。

## 3. 已完成批次（P1 ~ P6 全部落地）

1. **P1 组合根 notWired 组**（`bd363c79`）：
   `server/core-settings-adapter.ts` 补齐 `promptSnapshot`、`getLocale`、`applyToolGating`、`applySessionOverrides`、`applyCompactionOverrides`、`applyQueueModes` 等。
2. **P2 插件引擎级钩子 + `pluginClient`**（`872c3a2e`）：
   补齐 `onClientCwdChanged`、`onClientModelChanged`、`onConversationChanged`、`pluginClient()` 映射。
3. **P3 MCP 项目运行态**（`100e3102`）：
   接入 MCP 项目 `retain` / `prepare` 与 `mcpProjectCwds` / `refreshMcpProject`。
4. **P4 计划/审查者模式真门禁与派活链**（`6fccaba0`）：
   接入 `applyToolGating` 过滤活跃集，审查者模式生成 `delegateConvId`、派活 notice 并转发到执行对话。
5. **P5 Bot 私聊投影**（`d6e5e6c2`）：
   补齐 `SnapshotConversationView` 与 `ConversationsFrameFact` 的 `bot` / `botId` / `botName` 投影，绑定转录与会话目录。
6. **P6 takeover / orphan / 离线宽限 系列（8 个用例全部通过）**（`b1cf2109`）：
   - `packages/keel/src/app/engine-takeover.ts`：实现撞号改名、问卷与提问移交、会话与子代理完整迁移、回滚事务机制；
   - `packages/keel/src/app/engine-orphans.ts` / `engine-elsewhere.ts`：跨客户端孤儿识别、离线宽限到期清理、外部运行行广播；
   - `packages/keel/src/app/subagent-runtime.ts` / `subagents.ts`：修复子代理完成结算态、消除 `wait_all` 忙等卡死、`parentId` 稳定单源；
   - `packages/keel/src/domains/history/frame.ts`：修复已完成子代理在侧栏的常驻收口展示（`inRunningList` 涵盖 subagent 与 parentId）。
   - 冒烟用例 `conversation-takeover`、`orphan-*` 7 个用例、`subagent-takeover`（12/12 ALL PASS）全绿。

## 4. 剩余冒烟失败（仅剩 P7 最后 2 个用例）

### P7 · 两条待收尾用例

1. **`scm-features-test`**（15 通过 / 4 失败）：
   - 前 15 项（status/branch/history/diff/stats 等）全绿；
   - 仅挂在末尾的 4 项：`scm_commitmsg` 20s 内未收到回包（`FAIL: scm_commitmsg answered` / `kind echo` / `fails without credentials` / `carries an error message`）；
   - 代码线索：`packages/keel/src/domains/scm/handlers.ts:41-52` 与 `server/core-scm-adapter.ts:52-66`。排查重点：端口内部调用 `ModelRuntime.create` 或无凭证推断时是否出现未捕获 promise 挂住或超时。
2. **`device-project-collaboration-test`**：
   - 表现：Hub 派活成功，但设备端 mock `Requests: []`（SDK 0 次调用），任务停在未终态；
   - 排查线索：设备中心任务分发到 local runner 的 bridge 链路（`server/device-center/` 与 `server/device-collaboration` 调度）。

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

## 7. 下一批（P7 收尾目标）

P1 ~ P6 已全部落地，当前冒烟已追平 legacy（~96/98）。最后仅剩 P7 两条用例：

1. **`scm-features-test`**（15 通过 / 4 挂在 `scm_commitmsg`）：
   - 执行：`node tests/run-smoke.mjs --no-build scm-features-test`
   - 排查 `server/core-scm-adapter.ts:52-66` 的 `generateCommitMessage`：当缺少配置或凭证时，端口内部应当迅速抛错或返回错误对象，排查为何 20s 未发出 `scm_data` 回包。
2. **`device-project-collaboration-test`**：
   - 执行：`node tests/run-smoke.mjs --no-build device-project-collaboration-test`
   - 排查 Hub 派活给本机设备时的执行器接收端。
3. **两项追平后收尾发布**：
   - 全量冒烟：`node tests/run-smoke.mjs`
   - 将 `resolvePiEngineMode` 的 `legacy` 标记为已完成迁移（进入 `packages/keel/MIGRATION-PLAN.md` 阶段）。

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
