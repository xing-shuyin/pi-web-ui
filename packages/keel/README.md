# keel —— 会话编排内核

`keel`（龙骨）是被 `server/core` 抽出来的独立项目：编码智能体的会话编排内核。
它只管「对话、轮次、工具与审批、子代理、出帧、历史」，**不认识 UI、不认识插件面板、不认识 PTY**。

主应用（`pi-web-ui`）是它的第一个消费方。

## 现在到哪一步

| 阶段   | 内容                                                                                | 状态                                                                 |
| ------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **P0** | 包骨架 + 依赖清单守卫（本目录）                                                     | ✅                                                                   |
| P1     | 把 30 个随包模块物理搬进 `src/`，`src/index.ts` 的桥删掉                            | ✅ 63 个（29 + `protocol` + 33 个连带叶子），老位置留 shim           |
| P2     | 剩下 4 个（settings / terminals / tool-manager / client-state）反转成端口，宿主注入 | ✅ 依赖 10 → **0**（`SettingsStorePort` / `SettingsFramePort` 落地） |
| P3     | 补齐 185 个 handler（B1~B8）                                                        | ✅ 可用 185 · 未实现 0 · 显式不支持 0（口径见下）                    |
| P5     | 发布 `@earendil-works/keel`，主应用改成版本依赖；启用 npm workspaces                | 未开始                                                               |

**数字口径（唯一可复现口径，别再拿估数当账；基线 = 提交 `6a93e03c`，与 `.scratch/gap-audit.md` 同源）**

- **分母 185** = `packages/keel/src/adapters/wire/dispatch-surface.ts` 的 `DISPATCH_SURFACE` 项数（生成物；源 = `packages/keel/src/engine-service.ts` 的 `interface DispatchSession`，186 行声明去掉重复的 `forkSession`）。守卫 `tests/unit/core-adapter-wire.test.ts`（成员数 = 声明数、无重复）。
- **内核真提供 185** = 运行时枚举 `ClientRuntime.handlers()` 得 **185** 个键（适配器只填 `DISPATCH_SURFACE` 的成员），逐项等于面成员；「没有一个是兜底」由装配层逐项非空证明（守卫 `tests/unit/core-domain-engine-extras.test.ts` 末条：`createDispatchHandlers()` 的 185 个成员全部非空）。155 是审计基线 `6a93e03c` 的值，之后 +30（含引擎专属面 7）。
- **缺 0** = 185 − 185：最后 7 个（DSH 补丁 6 + `setClaudePermissionMode`）不再是「显式不支持」，改成**端口化转发**（`contracts/engine-extras.ts` + `domains/engine-extras/`，宿主 `server/core-engine-extras-adapter.ts` 包现有实现）。内核仍不认识 DSH / claude，端口未注入即同步抛；注入了但引擎不对时宿主回可读错（不静默假成功）。
- **可用 185**：`abortBash` 已改为内核自卫（`domains/background/bash-kills.ts` 登记 AbortController，SDK bash 的 `signal` 真杀进程树），native-cli 4 个也已接上宿主口，「跑不动」清零；引擎专属面 7 个走端口（见下一节末两行）。
- 计划期的「165」作废：任何提交点的 `DispatchSession` 都不是 165（取证 `.scratch/gap-audit.md` §4.2）。旧算式「155 可用 + 2 接线就绪 + 剩 10」三处都错：分母错、余数错（应 30）、接线就绪实为 0。

## handler 进度

状态只有四种：
**可用** = 内核 handler + 宿主适配器都在真跑；
**跑不动** = 内核有 handler，但宿主端口恒抛或 `notWired`（这种记「可用」就是骗人）；
**未实现** = 内核里根本没这个 handler；
**显式不支持** = 判定为不属本引擎（DSH 补丁）或别的引擎专属（claude driver）——**现状 0 个**：那 7 个改成端口化转发后按「引擎专属面」单列（见「最后 7 个」一节）。

两条失败路径的报错文案不同：**端口**没注入 → `CoreEngineNotReadyError(<端口名>)`；**成员**内核没注册 → 适配器兜底 `CoreEngineNotReadyError("dispatch.<成员>")`（`packages/keel/src/adapters/wire/dispatch-adapter.ts:25-27,45-48`），由 wire 层统一兜成一条 `notice`。两条都是同步抛（fail-closed，不是 rejected promise）。

| 批次    | 域                                                                                                                               | handler | 状态           | 备注                                                                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —       | 骨架期（W1~W7 已接）                                                                                                             | 22      | 可用           | 出帧 / 会话 / 审批回包 / 终端句柄 / 列表                                                                                                                                                                                                    |
| **B1**  | 模型 / 供应商                                                                                                                    | 28      | 可用           | 4 个真逻辑（选模型 / 思考档 / 全局默认），24 个走 `ModelAdminPort` 纯转发                                                                                                                                                                   |
| **B2**  | 设置 / 预设 / 审批 / 命令                                                                                                        | 20      | 可用           | 16 走 `SettingsFramePort`，`setApprovalPolicy` 归聚合根，3 个斜杠命令（20 是分批期口径，实测 22，见下表脚注）                                                                                                                               |
| **B3a** | 文件 / 目录                                                                                                                      | 15      | 可用           | 13 个走 `FilesService`；`makeDir(setAsCwd)` 是「建目录 → 切工作区」两步                                                                                                                                                                     |
| **B3b** | Git 工作树                                                                                                                       | 3       | 可用           | `worktree-service` 三支纯函数直通；内核只编排「删当前树先回退 cwd」                                                                                                                                                                         |
| **B4a** | 会话状态                                                                                                                         | 7       | 可用           | 切对话 / 队列摘除 / 草稿 / 计数 / 取消息 / 子代理收口；`composer-drafts` 一并搬进 keel                                                                                                                                                      |
| **B5a** | 终端查询 / 项目脚本                                                                                                              | 4       | 可用           | `getTerminalCwd` / `findTerminalManager` / `listProjectScripts`；`project-scripts` 搬进 keel                                                                                                                                                |
| **B5b** | 后台任务                                                                                                                         | 7       | 可用           | 宿主 `core-background-adapter`（`BgServerTracker` + `JobRegistry`）；`abortBash` 内核自卫（`domains/background/bash-kills.ts`）                                                                                                             |
| —       | `abortBash`（停止对话级 bash）                                                                                                   | 1       | 可用           | 内核按对话登记 `AbortController`，SDK bash 的 `AbortSignal` 真杀进程树；无在跑时与老实现同样只发 notice                                                                                                                                     |
| —       | `scmQuery` / `scmGenCommitMessage`                                                                                               | 2       | 可用           | `FilesPort.scmQuery` 直通宿主 `FilesService`；提交信息推断走新 `ScmCommitMessagePort`（宿主 `core-scm-adapter`，帧由内核发）                                                                                                                |
| **B6**  | 插件 / MCP / 扩展 / 技能                                                                                                         | 14      | 可用           | `PluginsPort` 14 个直通宿主叶子（mcp-manager / 市场 / 技能盘 / 插件更新）；`installPiAgent` 不在本组                                                                                                                                        |
| **B3c** | 沙盒                                                                                                                             | 7       | 可用           | 宿主 `core-sandbox-adapter`（`SandboxManager`）；内核编排「建/升后切工作区」「reset/apply/destroy 前后迁 owner」                                                                                                                            |
| **P4**  | 会话实体重绑组                                                                                                                   | 5       | 可用           | `rebindSession` 单原语（先建后拆、失败真回滚）：`setCwd` / `setWorkspaceRoots` / `switchSession` / `pinSession` / `pushSessionsForCwd`；`setConversationPinned` 只在本表单列记一次（旧台账两行各记一次）                                    |
| —       | DSH 补丁 6（`listDshPatches` / `rescanDshPatches` / `installDshPatch` / `toggleDshPatch` / `deleteDshPatch` / `fetchDshMarket`） | 6       | 可用（端口化） | `DshPatchPort` + `domains/engine-extras`（只转发）→ 宿主 `core-engine-extras-adapter` 直通 `DshClientSession` 六个现有方法（`server/dsh/dsh-agent-service.ts`，一行业务没搬）；非 dsh 引擎调到时回可读错。UI 侧仍由 `engine === "dsh"` 门控 |
| —       | `setClaudePermissionMode`                                                                                                        | 1       | 可用（端口化） | `EnginePermissionModePort` 直通 `server/universal/universal-session.ts:1151`（写 `drivers/claude-code.ts:58` 的模块级单例，逻辑一行没搬）；非 claude 引擎回可读错（不再静默假成功）                                                         |
| **B7**  | 消息编辑 / 删除 / 重试                                                                                                           | 3       | 可用           | `domains/turns/edits` + `adapters/sdk/session-edits`（截断→重问/摘条/补发）；失败真回滚 + 相位回收                                                                                                                                          |
| **B7**  | 目标 / 计划 / 委派                                                                                                               | 6       | 可用           | 计划落 `plans.json`（按会话 id 记账）+ `plan_updated` 帧；目标偏好落 `client-state.json`（`SettingsStorePort`）+ `goal_status`；交接走唯一喂轮出口                                                                                          |
| —       | 目标运行 3 + 模式开关 2 + 预设 2                                                                                                 | 7       | 可用           | `GoalRunPort`（执行/审查子对话 + `onTurnSettled` 逐轮）/ `ChatModePort`（模式条目 + 工具门禁 + reload）/ 预设：工具集真重设（同一漏斗 `applyAgentToolsGating`）+ 提示词真重载 + `permission` 条目重启可读回                                 |
| —       | `forkSession` / `rollbackSession`                                                                                                | 2       | 可用           | `ForkPort.createBranchFile`（新 manager 派生、原文件零写入）+ `branchTo` 叶指针复位；两边各自 append 只写自己的文件                                                                                                                         |
| —       | `setConversationPinned` 内存态                                                                                                   | 1       | 可用           | `domains/sessions/pins.ts` 的 `ConversationPinIndex`（磁盘钉子 + 内存态 + `conversations` 帧一起真）                                                                                                                                        |
| —       | `getUserTerminalManager`                                                                                                         | 1       | 可用           | 设计裁定：`ClientTerminalManager` 钉成 `undefined`（给真实例会变成「能建、点不动」，各调用点已有 `?? getTerminalManager(conv)` 兜底）                                                                                                       |
| —       | `openBotChat`                                                                                                                    | 1       | 可用           | 默认复用同一私聊、`fresh` 才新开                                                                                                                                                                                                            |
| —       | native-cli 4（`newCliChat` / `controlNativeCli` / `updateNativeCliTitleFromInput` / `getNativeCliConversation`）                 | 4       | 可用           | 宿主 `server/native-cli-host.ts` 四个口全接上（`launch`/`statusOf`/`applyTitle`/`reconnect`）；重启后自动重挂仍差「历史打开 → CLI 域」一行调用                                                                                              |

**本表与 185 的关系（不凑数）**：本表是**分批视角**，同一成员可能出现在多行（如 `setConversationPinned` 既算 P4 也单列过，已去重；预设 2 个既算在「目标/模式」行也在审计表里），所以各行相加 ≠ 184。**权威口径只看上面「数字口径」块与下一节的逐项名单**：185 = **185（内核真提供）**，适配器兜底 **0**（`abortBash` 已转正、native-cli 4 个宿主口全接、引擎专属面 7 个走端口）。

两个新端口都由宿主编译期结构直通（不做参数搬运）：
`server/core-model-adapter.ts`（`ModelAdminPort`）、`server/core-settings-adapter.ts` +
`server/core-commands-adapter.ts`（`SettingsFramePort` / `SlashCommandsPort`）。

**沙盒 / 工作树是全貌字段**（`UiState.sandbox` / `UiState.worktree`）：进程级、跟着 cwd 走，
由每次组帧现取；`undefined` 不出键、显式 `null` 出键（客户端据此清横幅）。

## 最后 7 个（引擎专属面，已端口化）

算术：**185（面）− 185（内核真提供）= 0**。审计基线（`6a93e03c`）的 30 行取证表在
`.scratch/gap-audit.md` §1；此后按「A 组 7 · B 组 5 · C 组 8 · 预设 2 · native-cli 4 · scm 2 · 引擎专属 7」逐批销账。

| 成员                                                                                                               | 内核侧                                                                                              | 宿主侧（包现有实现，逻辑零搬家）                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `listDshPatches` / `rescanDshPatches` / `installDshPatch` / `toggleDshPatch` / `deleteDshPatch` / `fetchDshMarket` | `contracts/engine-extras.ts` 的 `DshPatchPort` + `domains/engine-extras/`（只转发，未注入即同步抛） | `DshClientSession` 的六个现有方法（`server/dsh/dsh-agent-service.ts`，经 `DshAgentService.get(clientId)` 拿到）                         |
| `setClaudePermissionMode`                                                                                          | `EnginePermissionModePort`                                                                          | `UniversalSession.setClaudePermissionMode`（`server/universal/universal-session.ts:1151`，写 `drivers/claude-code.ts:58` 的模块级单例） |

引擎门控：不是那个引擎时内核照常转发、宿主回可读错
（`dsh patch management (listDshPatches) is only available on the dsh engine: this connection runs the "pi" engine`），
不静默假成功；前端仍由 `engine === "dsh"` / claude 能力位门控，正常路径走不到这条错。

另：`abortBash` 已转正——内核 `domains/background/bash-kills.ts` 按对话登记 `AbortController`，
SDK bash 的 `AbortSignal` 会真杀进程树；端口零参与（不再需要宿主句柄）。

## P4 会话实体重绑链（一次做对，四个入口共享）

老树每次重绑都重复同一套四步：**释放旧会话 → 在新 cwd 建会话 → 重算快照/推帧 → 失败回滚**。
P4 把它收成一份原语 `domains/sessions/rebind.ts` 的 `rebindSession(ctx, request)`，四个入口只提供「目标从哪来」：

| 入口                     | 目标从哪来                                                                     | 备注                                                    |
| ------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `setCwd`                 | 宿主 `WorkspaceHostPort.resolveTarget`（`~` / 相对 / 远程 URI / `@root` 拒绝） | 目标与当前一致 → info notice，不重绑                    |
| `setWorkspaceRoots`      | 不走重绑：落盘 + 刷工作区 + 宿主收尾                                           | 归一后没变就不刷帧                                      |
| `switchSession`          | 转录 header 的 cwd（读不出用当前工作区）                                       | 已开着的转录直接复用，不建第二份                        |
| 沙盒 reset/apply/destroy | `SandboxPort.locate` + `planSandboxLifecycle`（纯编排）                        | 先把 cwd 在沙盒里的对话迁到源项目，reset/apply 之后迁回 |
| 换工作树                 | 逐字就是 `setCwd`                                                              | 删当前工作树前先回退 cwd（既有行为）                    |

口径（改需在 PR 里说明）：

- **先建后拆**：新对话先注册成候选（不激活、不出帧），候选会话真开起来之后才退役/摘除/释放旧对话。
  因此失败回滚是「什么都不用修」——旧对话与旧会话从头到尾没被碰过（`rebindSession` 只清理候选）。
- **跨 `await` 只认稳定 id**：活动指针在函数入口取值，失败按 id 复位，不重读 `activeConv()`。
- **`WorkspacePort` 的实现搬进了内核**（`domains/sessions/workspace.ts`）：它还叫 `setCwd`，但已经是
  「内核重绑链」而不是宿主方法；宿主只剩 `WorkspaceHostPort`（`resolveTarget` / `onChanged`）。
  沙盒 / 工作树 / `makeDir(setAsCwd)` 三个域都落到这一份，没有第二套。
- **`cs.cwd` / `cs.workspaceRoots` 是活值**：`dispatch-adapter` 用取值口读，换完工作区立即是新目录
  （否则宿主还会按旧根解析附件 / 文件 / SCM）。
- **沙盒失败口径**：宿主自己发 `notice(error)` 且**不 reject**（老树逐字同口径），用**空路径**
  （`SandboxCreated.path` / `SandboxPromoted.targetPath` 的空串）表达「别切工作区」。
- **钉住**：磁盘上的钉子归设置存储（`setSessionPinned`，按会话 header 的 cwd 记账）；
  `sessions` 帧按 `isPinned` 投影出 `pinned`，所以取消钉住后图标真会消失。
  内存里的「运行列表钉住」要 `conversations` 帧生产者，本引擎还没有——不假装有状态。

**仍然缺的接口（下一步只差这一行）**：

- `forkSession`：`rebindSession({cwd, sessionFile, prepare})` 已就绪，缺「按消息从现有转录派生一份新文件」的宿主/SDK 窄口
  （老实现是 `SessionManager.createBranchedSession(leafId)` + `copyContextEvidence`）→ 建议加 `contracts/session.ts` 的 `ForkPort`。
- `rollbackSession`：老实现是 `sessionManager.branch(entryId)` + `session.reload()`（**不换会话**），
  缺 `TurnCapableSession.branchTo(entryId)` 这一行窄面（由 `adapters/sdk/session-opener.ts` 从 `manager` + `session.reload()` 接出）。
  重新开会话做不到回滚：`branch()` 只改内存游标、不写盘，重开等于回到原分支。

## 为什么 P0 不启用 npm workspaces

workspaces 要求 lockfile 里登记 workspace 包，`npm ci` 会因此校验失败——在主应用还没真正依赖 keel 之前启用它，
等于给 CI 埋一颗「锁文件不同步」的雷。P0 用 **tsconfig paths + 依赖清单守卫**拿到同样的边界，
等 P3 真正发布时再启用 workspaces（那时 lockfile 会随发布一起更新）。

## 依赖清单（P2 后：棘轮只剩“禁止新增”，只许变短）

`src/` 当前允许 import 的 app 模块（守卫：`tests/unit/keel-package.test.ts`）。**P2 后两桶都已清空：
任何 `server/*` 依赖都会红**——这是「新增耦合」的唯一门禁。

**PENDING_PORT（0 个）**
被搬进来的老叶子的首跳宿主依赖已全部销账（端口反转或改 keel 内单源/窄类型）：
`plugins` / `remote-ssh-service` / `conversation-read-tool` / `quick-ask-context` / `native-cli` /
`approval-default-rules` / `terminals` / `tool-manager` / `client-state` / `settings-service`。

**PORTS（0 个，P2 已反完）**
`client-state` → `SettingsStorePort` · `settings-service` → `SettingsFramePort`（本就在的端口）·
`terminals` → `createManager` 工厂注入 · `tool-manager` → 整份搬入（纯数据，不需要端口）

**已经搬进来的（62 个 + P2 的 5 个）**
30 个原计划模块（除 `protocol`，它单独一轮）+ 33 个「纯叶子」连带项：
`atomic-file` `text-quote` `attachment-store` `model-error` `engine-catalog` `transcript-scan`
`serialized-json-writer` `client-id-utils` `conversation-tool-names` `question-params` `approval-audit`
`tool-overrides` `mobile-notification-events` `quick-ask-settings` `delegate-mode` `plugin-tool-guard`
`browser-page-tool` `subagent-evidence` `subagent-ledger` `subagent-templates-hant` `goal-review-gate`
`conversation-communication` `dangling-tools` `compaction-markers` `plan-mode` `hashline-engine`
P2 略进的：`settings-schema` `settings-normalize` `ui-layout` `projects-schema` `plugin-ui-slots`

- `markers/`（`index` `registry` `marker` `store` `builtins/{notify,rename,action}`）

连带项为什么必须一起搬：`session-projection` / `serialize` / `transcript-prepare` / `tool-guards` / `subagents`
这些叶子对上面这些纯工具叶子有**首跳依赖**；只搬 30 个会让依赖清单暴涨，而纯叶子（自身零宿主依赖）
搬进来的边际成本只有一次机械移动。

老位置（`server/<m>.ts`）一律只剩 `export * from "../packages/keel/src/<m>.js";` 的 shim，
主应用 100+ 处 import 不用动，直到 P5 删 shim。

## P2 依赖销账（keel 引了多少宿主模块）

判据：`tests/unit/keel-package.test.ts` 的 `appDepsOf`（静态 import 与动态 `import()` 都算）。
**目标是 0**；每批只许变小。

| 批次  | 剩    | 这一步做了什么                                                                                                                                                                                                                                                                                                                                           |
| ----- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2 前 | 10    | client-state / settings-service / terminals / tool-manager / plugins / quick-ask-context / remote-ssh-service / conversation-read-tool / native-cli / approval-default-rules                                                                                                                                                                             |
| 1     | 7     | 工具**名字**表进 `tool-names.ts`；`native-cli-meta` / `transcript-input` 纯函数搬入（连带 `conversation-touches`）；远程 URI 层进 `remote-workspace.ts`，SSH 操作改 `RemoteSdkOperationsFactory` 注入                                                                                                                                                    |
| 2     | 6     | `terminals` 销账：命令文件进 `commands-file.ts`（路径解析注入）、PTY 改 `createManager` 工厂注入                                                                                                                                                                                                                                                         |
| 3     | 4     | `tool-manager` 整份搬入（纯数据 748 行，**不需要端口**）；`plugins` / `quick-ask-context` 改窄类型；`approval-default-rules` + 手机分档搬入                                                                                                                                                                                                              |
| 4     | 2     | 收尾：余 `client-state`、`settings-service` —— 都是「设置」面，见下一行                                                                                                                                                                                                                                                                                  |
| 完成  | **0** | 设置 schema（`ClientSettings` / 各 `normalize*` / `normalizePathKey` / 纯形状）搬进 `settings-schema` + `settings-normalize` + `ui-layout` + `projects-schema`；存储走 `SettingsStorePort`（宿主 `server/core-state-adapter.ts` 结构直通），设置帧/预设/审批规则走 `SettingsFramePort`（`SettingsService` 的构造搬回 `server/core-settings-adapter.ts`） |

判据之外的收益：`SettingsStorePort` 与 `SettingsFramePort` 已落地；`ToolCatalogPort` / `TerminalPort`
不需要单独端口（纯数据 / 工厂注入）。

## 契约

- 入口只有 `src/index.ts`；宿主不得 import 包内其它路径。
- 内核不得 import 宿主的 UI / 插件 / 面板 / PTY 实现（P1 后由守卫强制）。
- 现有不变量继续有效：喂轮单出口、出帧单源、退役 fail-closed、版本化存储单源、前缀缓存只追加。

## P1b 预习笔记（一次尝试后的实测结论，已全部落地）

试搬 29 个模块（除 `protocol`）后回退：机械搬移本身没问题，**连带项比预想多**。下次按这份清单一次做完：

1. **动态 `import("…")` 类型引用**：正则只处理 `from "…"` 会漏掉 `import("./protocol.js").X`（`engine-service.ts` 里有 22 处）。
2. **`index.ts` 基名撞车**：按 basename 兜底解析会把 `server/markers/index.ts` 误指向 `server/index.ts`；必须按完整相对路径重算。
3. **生成脚本要改源**：`gen-core-dispatch-surface.mjs` 的 `SOURCE` 必须指向 `packages/keel/src/engine-service.ts`，否则 `--check` 直接红。
4. **`core-boundaries` 双改**：SDK 边界白名单前缀要换成 `packages/keel/src/…`；`≤600 行` 要加一张「老叶子搬入预算表」（`subagents` 2,190 行、`tool-guards` 915 行…），且预算只降不升。
5. **`keel-package` 清单要翻面**：搬完的模块从「仍被引用」改为「不得再被引用」；`client-state` / `settings-service` / `terminals` / `tool-manager` 四个仍是 P2 的端口候选。
6. **shim 方向**：老位置留 `export * from "../packages/keel/src/<m>.js"`（app → keel，方向正确），主应用 100+ 处 import 不用动；`protocol.ts` 例外——必须是 `export type *` 且搬前先跑 `npm run check:protocol`。
7. **老守卫要扩扫描根**：`session-turn-single-source`、`versioned-doc-single-source` 等按 `server/**` 扫源码的红线守卫，搬完必须同时扫 `packages/keel/src/**`，否则静默失守。
