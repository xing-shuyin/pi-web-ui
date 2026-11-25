# keel 迁移实施计划（交付给长期执行会话）

> 目标：把 `packages/keel` 从「能聊的最小内核」补到「功能对等、可独立发布」，并在对等后让老树的 `agent-service.ts` 退场。
> 执行方式：**永久会话 + 并行子代理**。每个子代理只拿自己那批文件的权限与验收命令，接口变更一律回主会话合并。

## 0. 起点快照（2026-11-23，合并后）

| 项                     | 数值                                                            |
| ---------------------- | --------------------------------------------------------------- |
| `packages/keel/src`    | 74 文件 / 4,933 行                                              |
| keel 测试              | 33 文件 / 497 条（全绿）                                        |
| `DispatchSession` 成员 | **184**（去重后）                                               |
| 已实现 handler         | **19**                                                          |
| **未实现 handler**     | **165**                                                         |
| 随包待搬的老叶子       | **30 模块 / 13,526 行**（仍住在 `server/`）                     |
| 待反转成端口的宿主模块 | **4 模块 / 7,419 行**                                           |
| main 状态              | keel 已并入；`ci:local --profile pr` 全绿；`smoke --core` 22/22 |

未实现分布（守卫：`tests/unit/core-adapter-wire.test.ts` 会随生成物变化）：

| 域                          | 缺口 | 代表方法                                                                                                                                |
| --------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 模型 / 供应商               | 28   | `setModel` `setThinking` `setDefaultModel` `testModelConnection` `listModelsConfig` `setProviderApiKey` `startProviderOAuth`            |
| 设置 / 预设 / 审批规则      | 28   | `setSettings` `refreshSettings` `savePreset` `applyPreset` `importPreset` `saveApprovalRule(s)` `setApprovalPolicy` `pushSlashCommands` |
| 文件 / 目录 / 工作树 / 沙盒 | 25   | `listFiles` `readFile` `writeFile` `uploadFile` `createEntry` `renameEntry` `deleteEntry` `setCwd` `createSandbox` `diffSandbox`        |
| 终端 / CLI / 后台任务       | 18   | `abortBash` `listBgServers` `killBackgroundServer` `startBgScript` `newCliChat` `controlNativeCli` `handleTuiOverlay*`                  |
| 会话 / 消息                 | 17   | `switchConversation` `switchSession` `forkSession` `rollbackSession` `editMessage` `removeQueued` `retryLast` `pinSession`              |
| 插件 / MCP / 扩展 / 技能    | 16   | `reloadExtensions` `reloadMcp` `saveMcpServer` `installSkill` `checkUpdate(sAll)`                                                       |
| 目标 / 计划 / 委派          | 10   | `setGoal` `updatePlan` `addPlanStep` `setPlanMode` `setDelegateMode`                                                                    |
| DSH                         | 6    | `listDshPatches` `installDshPatch` `fetchDshMarket`                                                                                     |
| 其它                        | 17   | `scmQuery` `searchSessions` `pageCall` `resolvePhoneCall` `getToolPrompt` …                                                             |

## 0.1 现状（2026-11-25，与本文件的历史计划对照）

| 阶段 | 计划内容                                            | 现状                                                                                                                 |
| ---- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| P1   | 30 个老叶子搬进 keel（13,526 行）                   | **已完成**（保留预算表豁免的 6 个超 600 行文件）                                                                     |
| P2   | 4 个宿主模块反转成端口                              | **已完成**（`contracts/` 下有 30+ 端口；`server/core-*-adapter.ts` 是实现侧）                                        |
| P3   | 165 个 handler 从抛变真                             | **已完成**（分发面 **185/185**，`scripts/gen-core-dispatch-surface.mjs --check` 守卫）                               |
| P4   | 子系统对等（插件 / 画布 / 设备中心 / SCM / 更新）   | **已完成**（全部走端口 + 宿主适配器，`PluginManager` 原样复用）                                                      |
| P5   | 独立发布（workspaces / `dist` 产物 / 老 shim 退场） | **未做**：`package.json` 仍无 `workspaces`，主应用靠相对路径引 `packages/keel/src`；要发布再动，属于节奏问题不是缺口 |
| P6   | 老树退场（删 `agent-service.ts`）                   | **等拍板**（见下方清单的实际状态）                                                                                   |

`lsp` 这类**会拉起子进程**的能力按铁律 3 处理：执行体留宿主（`server/lsp-tool.ts`），
keel 只定义端口 `contracts/lsp.ts`（`liveDiagnostics` / `tool`）——内核里 `node:child_process` 保持 0 import。

## 1. 铁律（每个子代理的任务书里都要复述）

1. **不改协议**：`server/protocol.ts` 的类型与 `PROTOCOL_VERSION` 不碰；要加字段先回主会话裁定。
2. **不放宽分层守卫**：`packages/keel/src` 的 `contracts ← kernel ← domains ← app`、域间禁互引、SDK 只许出现在
   `domains/turns/feed.ts` + `adapters/{sdk,models,tools}/` —— 这些是**结论**，不是障碍。需要跨域能力时加到宿主的端口里。
3. **不为兼容保留第二套实现**：要么搬进来，要么走端口注入；**禁止**在 keel 里再写一份和老叶子并行的逻辑。
4. **单文件 ≤600 行**（老叶子搬入按预算表豁免，只许降）。
5. **不写文件头注释**；tab 缩进；import 带 `.js`；类型用 `import type`。
6. **每次改动必须能跑出证据**：`npx tsc -p tsconfig.server.json --noEmit`、`npx vitest run <相关>`、`npx prettier --check`、`npx oxlint`。
7. **不复用别人正在写的文件**：子代理只拿自己批次的路径；跨批次接口由主会话先冻结再分发。

## 2. 阶段计划

### P1 · 30 个老叶子搬进 keel（13,526 行）

清单（`packages/keel/README.md` 的「随包搬走」）：
`protocol` `session-turns` `session-projection` `conversation-rows` `queue-utils` `serialize` `versioned-doc`
`path-boundary` `session-open` `transcript-prepare` `session-branch` `session-parser` `session-search`
`session-scan` `session-list-scan` `i18n` `agent-formatters` `engine-capabilities` `tool-guards`
`tool-approval` `approval-rules` `pending-question` `ask-user-question-tool` `subagents`
`subagent-templates` `subagent-settle` `subagent-security-gate` `engine-service` `launch-origin` `orphan-manager`

**七条连带项（上一次尝试踩过，必须一次做完）**：

1. 动态 `import("…")` 类型引用也要重算（`engine-service.ts` 有 22 处，正则只处理 `from` 会漏）。
2. `*/index.ts` 的**基名撞车**：按 basename 兜底解析会把 `server/markers/index.ts` 误指到 `server/index.ts`；一律按完整相对路径重算。
3. `scripts/gen-core-dispatch-surface.mjs` 的 `SOURCE` 指向 `packages/keel/src/engine-service.ts`。
4. `tests/unit/core-boundaries.test.ts`：SDK 白名单前缀换成 `packages/keel/src/…`；`≤600 行` 加「老叶子搬入预算表」。
5. `tests/unit/keel-package.test.ts`：清单翻面——搬完的模块改为「不得再被引用」。
6. 老位置留 `export * from "../packages/keel/src/<m>.js"` 的 shim（app → keel，方向正确，主应用 100+ 处 import 不动）；
   `protocol.ts` **例外**：必须 `export type *`，且搬前先跑 `npm run check:protocol`。
7. **红线守卫扩扫描根**：`session-turn-single-source`、`versioned-doc-single-source`、`sync-child-process-guard` 等
   按 `server/**` 扫源码的守卫，必须同时扫 `packages/keel/src/**`，否则模块搬走后守卫静默失守。

验收：`npm run typecheck` + `npx vitest run` + `npm run check:protocol` + `npm run i18n:check` 全绿；
`packages/keel/README.md` 的依赖清单只剩 `PENDING_PORT` + `PORTS` 两桶（且两桶都只许变短）。

> **P1 口径修正（执行时实测）**：原验收写的是「清单只剩 4 个端口候选」，实测不成立——30 个叶子对**老树里
> 不在清单上的 33 个纯叶子**有首跳依赖（`plugins` / `remote-ssh-service` / `conversation-read-tool` /
> `hashline-engine` / `plan-mode` / `atomic-file` …，合计 15,662 行）。若把这 33 个也一起搬，闭包会继续
> 追出 **243 个模块 / 94,960 行**（含 `agent-service` 17.8k、`plugins` 5.2k），等于掏空整个 `server/`，与 P2
> 「端口反转」的存在意义直接冲突。故采用**三桶棘轮**：
>
> - `MOVED`（实际搬走的）——本次 62 个：原 30 个（`protocol` 单独一轮）+ 26 个**自含的纯工具叶子**
>   - `markers/` 7 个文件（`serialize` 依赖 `markers/index`，顺便解掉 `*/index.ts` 基名撞车）；
> - `PENDING_PORT`（6 个）——真正的宿主能力，由 P2/P4 端口反转逐个销账，**只许变短**；
> - `PORTS`（4 个）——P2 的四端口候选。
>
> 判据 `tests/unit/keel-package.test.ts` 同步改成两桶 + 两条棘轮（不再被引用就删行 / 宿主能力不许搬进来）。

### P2 · 四个宿主模块反转成端口（7,419 行）

| 模块                         | 新端口（`contracts/ports.ts` 或独立 `contracts/*.ts`）                  | 宿主实现位置                               |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| `client-state`（设置存储）   | `SettingsStorePort`：`get/getSnapshot/save/subscribe/version`           | `server/core-state-adapter.ts`（主应用侧） |
| `settings-service`（设置帧） | `SettingsFramePort`：`push()/refresh()`                                 | 同上                                       |
| `terminals`（PTY）           | `TerminalPort`：`managerFor(convId, cwd)`                               | 复用现有 `domains/terminals` 的 host 抽象  |
| `tool-manager`（工具目录）   | `ToolCatalogPort`：`entries()/platformSupported()/disabledOf(settings)` | 主应用侧                                   |

判据：keel 里对 `server/*` 的 import **归零**（`keel-package.test.ts` 断言 `appDepsOf === []`）。

### P3 · 补齐 165 个 handler（按「用户第一步会撞到什么」排序）

| 批次   | 域                       | 数量 | 先做理由                                | 复用/新建                                                                                                                                 |
| ------ | ------------------------ | ---- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **B1** | 模型 / 供应商            | 28   | 选不了模型、切不了思考档 → 大面积不可用 | `domains/models`（已有 catalog/push）+ 新建 `domains/providers`（密钥/OAuth）                                                             |
| **B2** | 设置 / 预设 / 审批规则   | 28   | 改任何设置都要                          | `domains/settings`（已有 read-model/patch/store）+ 宿主 `server/core-settings-adapter.ts`（`SettingsFramePort`）                          |
| **B3** | 文件 / 目录              | 25   | 左栏文件面板                            | 新建 `domains/files`（复用 `files-service` 叶子）+ `contracts/files.ts`                                                                   |
| **B4** | 会话 / 消息              | 17   | 切会话 / 分叉 / 回滚 / 编辑             | 扩 `domains/history` + `domains/sessions`；`getMessagesOfConversation` 走 transcript 投影                                                 |
| **B5** | 终端 / CLI / 后台任务    | 18   | 终端面板与 bash 接管                    | 扩 `domains/terminals`（`TerminalManager` 已有）+ 新建 `domains/background`（`bg-servers`/`job-runner` 叶子）                             |
| **B6** | 插件 / MCP / 扩展 / 技能 | 16   | 插件是生态入口                          | **不重写 `PluginManager`**：新建 `adapters/plugins/host.ts` 实现 `PluginHost` 的 A 类成员（见 README 三分表），B 类降级、C 类 unsupported |
| **B7** | 目标 / 计划 / 委派       | 10   | 目标模式                                | `domains/goals`（复用 `goal-service` / `plan-mode` / `delegate-mode`）                                                                    |
| **B8** | DSH + 其它               | 23   | 收尾                                    | `domains/dsh`（复用 `server/dsh/*`）+ 零散 handler                                                                                        |

每批的**完成定义（DoD）**：

1. `ClientRuntime.handlers()` 里对应成员从「抛」变「真实现」，并有一条 **happy path** 用例（真实调用一次）；
2. 失败路径不静默：要么抛带上下文的错，要么按协议回 `ok:false`；
3. 该批涉及的生成物重生成（`gen:core-ownership` / `gen:core-dispatch`）；
4. `npx vitest run tests/unit/core-*.test.ts tests/unit/keel-package.test.ts` + 该域老守卫（若有）全绿；
5. 提交信息写清「哪个 handler 从抛变真」。

### P4 · 子系统对等（插件 / 画布 / 设备中心 / SCM / 更新中心服务端）

- **插件**：按上面的 host 适配器路线；`PluginManager` 原样复用，不搬。
- **画布**：`server/canvas/**` 是独立子系统，按「端口 + 适配器」接，不进 keel 内核。
- **设备中心**：同上（`server/device-center/**`）。
- **SCM / 更新中心**：`scmQuery` / `scmGenCommitMessage` / `checkUpdate*` 属于宿主能力，走 `Predicate 端口` 注入。

### P5 · 独立发布

1. `package.json` 启用 `workspaces: ["packages/*"]`，lockfile 一并更新；
2. keel 出 `dist`（现在指向 `src/index.ts`，发布前改成 `dist/index.js` + `types`）；
3. 主应用改成 `"@earendil-works/keel": "^x.y.z"`，删掉老位置 30 个 shim；
4. CI 增加 keel 独立 job（typecheck + unit + 发布 dry-run）。

### P6 · 老树退场（**只在功能对等后**）

`agent-service.ts` 删除的前置条件（缺一不可）：

- [x] `PI_WEB_PI_ENGINE=core` 已成为默认（`app/engine-mode.ts`，回滚开关 `legacy` 仍在）；
      `server/index.ts` **已直连 `CoreEngine`**，不再经由 `AgentService` 或 `resolvePiEngineMode()` 分支；
      `npm run smoke` 全量 **96/98**，两条红都与引擎无关（`universal-stream-ui-test` 前端 fixture、
      `native-cli-smoke-test` 用 `legacy` 跑同样红）；
- [x] 165（实际 **185**）个 handler 全部有真实现，无「本引擎不支持」的空白项；
- [x] 红线守卫已重定向到 keel（`core-boundaries` 分层/行数/SDK 边界、`snapshot-channel`、
      `session-turn-single-source`、`host-faces-wiring` 等）；
- [ ] 71 个白盒测试按域重写到 keel：`tests/helpers/fake-session.ts` 仍被 **78** 个测试引用，未迁移。

**下线 `legacy` 的代价**：删 `server/agent-service.ts`（约 1.6 万行）+ 上面那批白盒测试重写。
收益只是「不留一份会漂移的第二实现」；风险是丢失唯一的外部对照基线。
**当前**：生产入口 `server/index.ts` 已不再引用 `AgentService`，legacy 在运行时不可达；
`agent-service.ts` 和 `agent-service-daemon.ts` 仅被 78 个白盒测试通过 `fake-session.ts` 引用。

## 3. 子代理协作协议

主会话（长期执行者）的职责：

1. **先冻结接口再分发**：任何跨批次的能力（端口、DTO、事件）由主会话写进 `contracts/`，子代理只许调用。
2. **路径不相交**：每个子代理的任务书里写死「只允许创建/修改这些路径」，其余一律不许动。
3. **并行度 2~3**：超过 3 个会互相等 `tsc`；同一文件绝不派给两个代理。
4. **收口即验收**：代理回报后，主会话自己跑一遍验收命令，再提交（不要相信"代理说绿了"）。
5. **每批一个 commit**，信息格式 `feat(keel/<域>): <handler 组> 从抛变真`。

## 4. 风险与止损

| 风险                                  | 缓解                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| 搬 30 个模块引爆大量守卫（P1 最大坑） | 按七条连带项一次做完；先改守卫再搬代码；单批可回退                                     |
| 插件 host 适配器越写越大              | 只做 A 类（约 30 个），B 类显式降级并记录，C 类 unsupported；不碰 `PluginManager` 内部 |
| handler 数量大，行为漂移              | 每批 DoD 强制一条 happy path 用例 + 老守卫回归                                         |
| keel 又长成上帝对象                   | `CoreEngine` 只许委托；`core-boundaries` + 单文件预算守卫                              |
| 主应用跟不动                          | 老位置留 shim 到 P5；P5 之前主应用 import 路径零改动                                   |

**止损线**：任一批次连续两轮无法让"该域老守卫 + keel 单测"同时变绿，就退回上一步，把该域降级为「宿主注入的端口」，并在 README 记录原因。

## 5. 立即可开工的前三个任务

1. `P1` 按七条连带项搬 30 个模块（先扩红线守卫的扫描根，再搬；`protocol` 最后单独一轮）。
2. `B1` 模型 / 供应商 28 个 handler（`setModel` + `setThinking` + `listModelsConfig` 优先，先让用户能选模型）。
3. `B2` 设置 28 个 handler（`setSettings` + `refreshSettings` 优先，先让设置页不炸）。
