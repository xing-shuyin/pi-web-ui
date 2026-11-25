# 交接：keel 成为 pi 默认引擎（进行中）

> 分支 `keel/migration`（未 push）。本文件是给下一位接手者的事实清单，**不含推测**；
> 每条都带可复跑的命令或 `文件:行`。

## 0. 一句话状态（2026-11-25 更新）

pi 的默认引擎**已是 keel（`CoreEngine`）**；**分发面 185/185、P1~P7 批次全部落地**。

| 口径                                                          | 结果                                               |
| ------------------------------------------------------------- | -------------------------------------------------- |
| `npx vitest run tests/unit`                                   | 16000 用例 / 0 ✗（并行跑有 3~6 条已知抖动，见 §6） |
| `node tests/run-smoke.mjs --no-build`（默认 keel）            | **95/98**                                          |
| `PI_WEB_PI_ENGINE=legacy node tests/run-smoke.mjs --no-build` | 对照基线（同机 95~96）                             |

### 仍然红的三条（都已定性，不是「不知道」）

| 测试                       | 归属             | 事实                                                                               |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `universal-stream-ui-test` | **与 keel 无关** | 纯前端 fixture + Vite，不碰引擎                                                    |
| `native-cli-smoke-test`    | **与 keel 无关** | legacy 跑同样红（PTY/环境），不是迁移缺口                                          |
| `running-list-test`        | keel 缺口        | 前 8 条断言绿；卡在「切回一条已经跑完的后台对话」时活动指针没跟过去（legacy 全绿） |

## 0.1 2026-11-25 这一轮修掉的（每条都是真根因，逐条可复验）

| 症状                                                      | 根因                                                                                                                                                                                                 | 证据                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| message-window / bot-chat-reopen / subagent-template 全红 | `statsOfSession` 直接吃 SDK `getSessionStats()`，它对**没有 `usage` 的 assistant 会抛** → 抛在出帧里，整条出帧链断                                                                                   | 三条转绿                                             |
| snapshot-frame-budget                                     | attach 收尾 `flush({forceFull:true})` 与连接期那帧重复；`publisher.flush()` 又被 60ms 合并闸静默吞掉                                                                                                 | 转绿                                                 |
| 附件 / 回滚 / 工作区根                                    | `client-assembly.createHostFaces({...})` **漏传** `attachments` / `presetTranscript`（重建装配表时少两行）                                                                                           | 转绿 + `KNOWN_UNWIRED` 清空                          |
| 扩展 `session_start` 从没发过                             | keel 从没调 `session.bindExtensions()`；现在 `UiBridgePort.uiContextFor` → `openTurnSession` 里绑                                                                                                    | subagent-ui-context 转绿                             |
| 启动不恢复最近会话 / 运行列表被拆                         | ① keel 恒建空白对话（老 `continueRecent`）→ 新 `app/leading-session.ts`；② 换活动对话从不判「保留」→ 判据单源 `domains/sessions/retain.ts`，装配层只喂宿主证据（子代理运行 / 等唤醒订阅 / 后台任务） | left-panel-delete / takeover-rollback 转绿           |
| 项目发现不了                                              | 扫盘根写成 `dataDir/sessions`，会话实际住 `agentDir/sessions`（分目录部署必红）                                                                                                                      | 同上                                                 |
| 删当前会话                                                | 老实现先挑开（次新，无则空白）再删；keel 直接删 → 剩一条挂着死文件的对话                                                                                                                             | `app/session-delete.ts`                              |
| 过户回滚把在跑的会话弄没                                  | 回滚无条件 `transferFrom`，把目标那份空壳盖在来源活会话上                                                                                                                                            | 只搬「真插进目标」的 + `transferFrom` 不覆盖已有会话 |
| 别处（elsewhere）行消失                                   | `findSessionOwner` 跳过离线持有方且不透出 `connected` → 每个新连接都续上别人的转录                                                                                                                   | idle/offline-takeover 转绿                           |
| 按需加载全空                                              | 没有门控重放点、`load_tools` 本体没搬、JIT 自动激活没接                                                                                                                                              | `lazy-tools-test` 20/20                              |
| 切项目后不看项目                                          | 扫盘根 + 连接期恢复 + 跨项目切对话不带 cwd（老 `applyCwdSideEffects`）                                                                                                                               | conv-cross-project 转绿                              |

### 已知但**故意未修**（写清原因，别当漏项）

- 宿主 `server/client-state.ts` 的加载/保存两处：状态文件缺 `toolOnDemandTools` 键时会被写成 `[]`，
  把出厂名单（7 个重量级工具）清零 → 工具 schema 从 ~7k 涨回 33k。**两套引擎同源**，而且
  `lazy-tools-test` 的「名单为空」用例**依赖**这个行为；修它要连带改那条用例（另开一个改动）。
- `patch` 工具没带 LSP 实时诊断：`server/lsp-tool.ts`（1522 行）还没迁进 keel。
- 老 `displaceActive` 的两支还没搬：`conv.transferring`（过户中不换）与 `promptInFlight &&
!isStreaming` 的 info notice；`promptedSinceActive` 内核也没有状态位（`listed && promptedSinceActive`
  这一支今天不可达 → 「打开过但没说过话、被切走」的对话老引擎留、keel 会退役）。

## 1. 开关（回滚只要一条环境变量）

| 变量                      | 默认   | 作用                                                       |
| ------------------------- | ------ | ---------------------------------------------------------- |
| `PI_WEB_PI_ENGINE`        | `core` | 设 `legacy` 立刻回老实现（迁移止损口，不是并行第二套实现） |
| `PI_WEB_PI_ENGINE_ATTACH` | 开     | 设 `0` 只建引擎、不接连接（隔离排查用）                    |

实现：`packages/keel/src/app/engine-mode.ts`。

## 2. 复现与验收

```bash
npm run typecheck                                   # 6 个 tsconfig，当前 0 错误
npx vitest run tests/unit                           # 16000 用例 / 0 ✗
rm -rf dist/packages dist/server && npm run build    # 干净产物（并行构建会互相踩）
node tests/run-smoke.mjs --no-build                  # 当前 95/98
node tests/run-smoke.mjs --no-build <test-name>      # 单跑（--no-build 复用已有 dist）
PI_WEB_PI_ENGINE=legacy node tests/run-smoke.mjs --no-build   # 对照
node .scratch/app-deps.mjs                          # keel 对宿主模块依赖：必须是 0
node scripts/gen-core-dispatch-surface.mjs --check  # 185 成员
node scripts/gen-core-ownership.mjs --check
npm run lint
```

调试冒烟的注意事项（都踩过）：

- 冒烟 spawn 的 server 是 `stdio: "ignore"`：`console.error` **看不到**，要落盘就用
  `appendFileSync`，**提交前删干净**；
- 端口是固定的（8900~9100）：同一时刻只跑一份，跑前 `netstat -ano | grep -E ":(89|90)"` 看一眼；
- `--no-build` 只认已有 `dist/server/index.js`；产物不全时 runner 会直接报「产物不存在」。

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

## 4. 剩余冒烟失败

见 §0「仍然红的三条」。上面 P7 那两例（`scm-features-test` / `device-project-collaboration-test`）
已经绿了，别再按旧清单找。

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

`npx vitest run tests/unit` 并行跑时偶发、**单跑必绿**（重子进程 / 端口争用 / 临时目录占用）：

| 用例                                                                  | 现象                                                                    |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `canvas-runtime-i18n.test.ts`                                         | 「replaces stale in-progress action metadata after server restart」偶发 |
| `device-mobile-notifications.test.ts`                                 | 「keeps a bounded outbox…」偶发                                         |
| `group-ecosystem-http-ws.test.ts`                                     | `ENOTEMPTY`                                                             |
| `device-center-portals` / `plugin-sparse-install` / `systemd-install` | 并行下偶发，单跑全绿                                                    |
| 冒烟 `subagent-template-test`                                         | 并行跑偶发，单跑 6/6 绿                                                 |

判定口径：**先单跑**。单跑红才是回归。

## 7. 下一批

全量冒烟 95/98，剩下三条已定性（见 §0）。真正还要做的：

1. **`running-list-test`**：切回「已跑完的后台对话」时活动指针不动（legacy 全绿）。
   起手：先把 `switch_conversation` 的**真实派发链**找出来（我打过探针的四处都没触发，
   说明不是我以为的那条路），再查目标对话是否已被退役（帧里有行 ≠ 注册表里有它）。
2. `patch` 的 LSP 实时诊断（`server/lsp-tool.ts` 未迁移）。
3. 宿主 `client-state.ts` 的 `toolOnDemandTools` 清零 bug（见 §0.1「故意未修」）。
4. 老 `displaceActive` 剩下两支（`conv.transferring` / `promptInFlight` 的 info notice）与
   `promptedSinceActive` 状态位。

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
