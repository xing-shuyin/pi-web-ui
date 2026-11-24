| **B5a** | 终端查询 / 项目脚本 | 4 | ✅ 是 | `getTerminalCwd` / `findTerminalManager` / `listProjectScripts`；`project-scripts` 搬进 keel |
| **B5b** | 后台任务 | 8 | ⏳ 否 | 契约 + 域 + 接线全就绪，**等宿主适配器**（要拼 `BgServerTracker` + `JobRegistry`；`abortBash` 还缺对话级 bash kill 句柄） |
| B5 未做 | `getUserTerminalManager` | — | — | 老树是「客户端级终端」，keel 只有「每对话一份」；归 P4 |
| B5 未做 | `newCliChat` / `openBotChat` / `controlNativeCli` / TUI 浮层 3 个 | — | — | `native-cli-session`（682 行）+ 插件 Bot 子系统，归 P4 |

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
| P3     | 补齐 165 个 handler（B1~B8）                                                        | 🚧 已真实现 137 / 165（B1~B7 + P4 重绑链）；剩余 28 见下表与 B8 清单 |
| P5     | 发布 `@earendil-works/keel`，主应用改成版本依赖；启用 npm workspaces                | 未开始                                                               |

## handler 进度

「运行时可用」= 有宿主适配器在跑；「接线就绪」= 契约 + 域 + 接线都完成，只差一个宿主适配器（P4 补上零改动生效）。
端口未注入时对应 handler **同步抛** `CoreEngineNotReadyError`（fail-closed，不是 rejected promise）。

| 批次    | 域                                                                | handler | 状态                | 备注                                                                                                                                                             |
| ------- | ----------------------------------------------------------------- | ------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —       | 骨架期（W1~W7 已接）                                              | 22      | 可用                | 出帧 / 会话 / 审批回包 / 终端句柄 / 列表                                                                                                                         |
| **B1**  | 模型 / 供应商                                                     | 28      | 可用                | 4 个真逻辑（选模型 / 思考档 / 全局默认），24 个走 `ModelAdminPort` 纯转发                                                                                        |
| **B2**  | 设置 / 预设 / 审批 / 命令                                         | 20      | 可用                | 16 走 `SettingsFramePort`，`setApprovalPolicy` 归聚合根，3 个斜杠命令                                                                                            |
| **B3a** | 文件 / 目录                                                       | 15      | 可用                | 13 个走 `FilesService`；`makeDir(setAsCwd)` 是「建目录 → 切工作区」两步                                                                                          |
| **B3b** | Git 工作树                                                        | 3       | 可用                | `worktree-service` 三支纯函数直通；内核只编排「删当前树先回退 cwd」                                                                                              |
| **B4a** | 会话状态                                                          | 7       | 可用                | 切对话 / 队列摘除 / 草稿 / 计数 / 取消息 / 子代理收口；`composer-drafts` 一并搬进 keel                                                                           |
| **B5a** | 终端查询 / 项目脚本                                               | 4       | 可用                | `getTerminalCwd` / `findTerminalManager` / `listProjectScripts`；`project-scripts` 搬进 keel                                                                     |
| **B5b** | 后台任务                                                          | 8       | 可用                | 宿主 `core-background-adapter`（`BgServerTracker` + `JobRegistry`）；`abortBash` 仍缺对话级 bash kill 句柄                                                       |
| **B6**  | 插件 / MCP / 扩展 / 技能                                          | 14      | 可用                | `PluginsPort` 14 个直通宿主叶子（mcp-manager / 市场 / 技能盘 / 插件更新）；`installPiAgent` 不在本组                                                             |
| **B3c** | 沙盒                                                              | 7       | 可用                | 宿主 `core-sandbox-adapter`（`SandboxManager`）；内核编排「建/升后切工作区」「reset/apply/destroy 前后迁 owner」                                                 |
| **P4**  | 会话实体重绑组                                                    | 6       | 可用                | `rebindSession` 单原语（先建后拆、失败真回滚）：`setCwd` / `setWorkspaceRoots` / `switchSession` / `pinSession` / `setConversationPinned` / `pushSessionsForCwd` |
| —       | 引擎预设 6 + `setClaudePermissionMode`                            | 0       | 显式不支持          | 依赖 `tool-manager` 目录 / SDK 分支写入 / claude driver，退到 B8/P4                                                                                              |
| **B7**  | 消息编辑 / 删除 / 重试                                            | 3       | 可用                | `domains/turns/edits` + `adapters/sdk/session-edits`（截断→重问/摘条/补发）；失败真回滚 + 相位回收                                                               |
| —       | `forkSession` / `rollbackSession`                                 | 0       | 待 P4               | 只差一个 SDK 窄口：`forkSession` 要 `ForkPort.createBranchFile`；`rollbackSession` 要 `TurnCapableSession.branchTo`（见下）                                      |
| —       | `setConversationPinned` 内存态                                    | 0       | 待 conversations 帧 | 磁盘钉子已真（`settings-store`）；左侧「运行中列表」的内存态要等 `conversations` 帧生产者                                                                        |
| —       | `getUserTerminalManager`                                          | 0       | 待 P4               | 老树是「客户端级终端」，keel 只有「每对话一份」                                                                                                                  |
| —       | `newCliChat` / `openBotChat` / `controlNativeCli` / TUI 浮层 3 个 | 0       | 待 P4               | `native-cli-session`（682 行）+ 插件 Bot 子系统                                                                                                                  |

两个新端口都由宿主编译期结构直通（不做参数搬运）：
`server/core-model-adapter.ts`（`ModelAdminPort`）、`server/core-settings-adapter.ts` +
`server/core-commands-adapter.ts`（`SettingsFramePort` / `SlashCommandsPort`）。
端口未注入时对应 handler **同步抛** `CoreEngineNotReadyError`（fail-closed，不是 rejected promise）。

**沙盒 / 工作树是全貌字段**（`UiState.sandbox` / `UiState.worktree`）：进程级、跟着 cwd 走，
由每次组帧现取；`undefined` 不出键、显式 `null` 出键（客户端据此清横幅）。

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
