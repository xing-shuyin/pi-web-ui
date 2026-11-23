| **B5a** | 终端查询 / 项目脚本 | 4 | ✅ 是 | `getTerminalCwd` / `findTerminalManager` / `listProjectScripts`；`project-scripts` 搬进 keel |
| **B5b** | 后台任务 | 8 | ⏳ 否 | 契约 + 域 + 接线全就绪，**等宿主适配器**（要拼 `BgServerTracker` + `JobRegistry`；`abortBash` 还缺对话级 bash kill 句柄） |
| B5 未做 | `getUserTerminalManager` | — | — | 老树是「客户端级终端」，keel 只有「每对话一份」；归 P4 |
| B5 未做 | `newCliChat` / `openBotChat` / `controlNativeCli` / TUI 浮层 3 个 | — | — | `native-cli-session`（682 行）+ 插件 Bot 子系统，归 P4 |

# keel —— 会话编排内核

`keel`（龙骨）是被 `server/core` 抽出来的独立项目：编码智能体的会话编排内核。
它只管「对话、轮次、工具与审批、子代理、出帧、历史」，**不认识 UI、不认识插件面板、不认识 PTY**。

主应用（`pi-web-ui`）是它的第一个消费方。

## 现在到哪一步

| 阶段   | 内容                                                                                | 状态                                                                    |
| ------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **P0** | 包骨架 + 依赖清单守卫（本目录）                                                     | ✅                                                                      |
| P1     | 把 30 个随包模块物理搬进 `src/`，`src/index.ts` 的桥删掉                            | ✅ 63 个（29 + `protocol` + 33 个连带叶子），老位置留 shim              |
| P2     | 剩下 4 个（settings / terminals / tool-manager / client-state）反转成端口，宿主注入 | 未开始                                                                  |
| P3     | 补齐 165 个 handler（B1~B8）                                                        | 🚧 已真实现 99 / 163（B1~B5 前四批）；另有 8 个「接线就绪」等宿主适配器 |
| P5     | 发布 `@earendil-works/keel`，主应用改成版本依赖；启用 npm workspaces                | 未开始                                                                  |

## handler 进度

「运行时可用」= 有宿主适配器在跑；「接线就绪」= 契约 + 域 + 接线都完成，只差一个宿主适配器（P4 补上零改动生效）。
端口未注入时对应 handler **同步抛** `CoreEngineNotReadyError`（fail-closed，不是 rejected promise）。

| 批次    | 域                                                                | handler | 状态       | 备注                                                                                         |
| ------- | ----------------------------------------------------------------- | ------- | ---------- | -------------------------------------------------------------------------------------------- |
| —       | 骨架期（W1~W7 已接）                                              | 22      | 可用       | 出帧 / 会话 / 审批回包 / 终端句柄 / 列表                                                     |
| **B1**  | 模型 / 供应商                                                     | 28      | 可用       | 4 个真逻辑（选模型 / 思考档 / 全局默认），24 个走 `ModelAdminPort` 纯转发                    |
| **B2**  | 设置 / 预设 / 审批 / 命令                                         | 20      | 可用       | 16 走 `SettingsFramePort`，`setApprovalPolicy` 归聚合根，3 个斜杠命令                        |
| **B3a** | 文件 / 目录                                                       | 15      | 可用       | 13 个走 `FilesService`；`makeDir(setAsCwd)` 是「建目录 → 切工作区」两步                      |
| **B3b** | Git 工作树                                                        | 3       | 可用       | `worktree-service` 三支纯函数直通；内核只编排「删当前树先回退 cwd」                          |
| **B4a** | 会话状态                                                          | 7       | 可用       | 切对话 / 队列摘除 / 草稿 / 计数 / 取消息 / 子代理收口；`composer-drafts` 一并搬进 keel       |
| **B5a** | 终端查询 / 项目脚本                                               | 4       | 可用       | `getTerminalCwd` / `findTerminalManager` / `listProjectScripts`；`project-scripts` 搬进 keel |
| **B5b** | 后台任务                                                          | 8       | 接线就绪   | 要拼 `BgServerTracker` + `JobRegistry`；`abortBash` 还缺对话级 bash kill 句柄                |
| B3 备   | 沙盒                                                              | 7       | 接线就绪   | 契约 + 域 + 27 条用例已落地；要 `coordinateSandboxLifecycle` + `setCwd` 一起抽               |
| —       | 引擎预设 6 + `setClaudePermissionMode`                            | 0       | 显式不支持 | 依赖 `tool-manager` 目录 / SDK 分支写入 / claude driver，退到 B8/P4                          |
| —       | `setCwd` / `setWorkspaceRoots`                                    | 0       | 显式报错   | 宿主实现 `createCoreWorkspaceUnavailable` 明说「core 引擎暂不支持」，不静默                  |
| —       | `switchSession` / `forkSession` / `rollbackSession`               | 0       | 待 P4      | 与 `setCwd`、沙盒共用「释放旧会话 → 起新会话 → 推帧」链                                      |
| —       | `editMessage` / `deleteMessage` / `retryLast`                     | 0       | 待 P4      | 要 `TurnCapableSession` 的消息编辑窄面                                                       |
| —       | `pinSession` / `setConversationPinned`                            | 0       | 待 P2      | 要 `client-state.setSessionPinned` + `conversations` 帧                                      |
| —       | `getUserTerminalManager`                                          | 0       | 待 P4      | 老树是「客户端级终端」，keel 只有「每对话一份」                                              |
| —       | `newCliChat` / `openBotChat` / `controlNativeCli` / TUI 浮层 3 个 | 0       | 待 P4      | `native-cli-session`（682 行）+ 插件 Bot 子系统                                              |

两个新端口都由宿主编译期结构直通（不做参数搬运）：
`server/core-model-adapter.ts`（`ModelAdminPort`）、`server/core-settings-adapter.ts` +
`server/core-commands-adapter.ts`（`SettingsFramePort` / `SlashCommandsPort`）。
端口未注入时对应 handler **同步抛** `CoreEngineNotReadyError`（fail-closed，不是 rejected promise）。

**沙盒 / 工作树是全貌字段**（`UiState.sandbox` / `UiState.worktree`）：进程级、跟着 cwd 走，
由每次组帧现取；`undefined` 不出键、显式 `null` 出键（客户端据此清横幅）。

## 为什么 P0 不启用 npm workspaces

workspaces 要求 lockfile 里登记 workspace 包，`npm ci` 会因此校验失败——在主应用还没真正依赖 keel 之前启用它，
等于给 CI 埋一颗「锁文件不同步」的雷。P0 用 **tsconfig paths + 依赖清单守卫**拿到同样的边界，
等 P3 真正发布时再启用 workspaces（那时 lockfile 会随发布一起更新）。

## 依赖清单（P1 后：三桶棘轮，只许变短）

`src/` 当前允许 import 的 app 模块（守卫：`tests/unit/keel-package.test.ts`）。**除下面两桶以外的任何
`server/*` 依赖都会红**——这是「新增耦合」的唯一门禁。

**PENDING_PORT（6 个，P2/P4 端口反转销账）**
被搬进来的老叶子的首跳宿主依赖。它们不是「新树要的耦合」，而是叶子本来就有的边；销账方式是把宿主能力反转成端口：

| 模块                     | 谁在用                                                | 销账方式                                                                |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `plugins`                | `engine-service` / `agent-formatters`（均 type-only） | P4 插件 host 适配器 + 窄类型进 `contracts/`                             |
| `remote-ssh-service`     | `tool-guards`                                         | P4 远程工作区端口                                                       |
| `conversation-read-tool` | `session-projection`                                  | P4 宿主工具注入                                                         |
| `quick-ask-context`      | `engine-service`                                      | P4 随手问端口                                                           |
| `native-cli`             | `session-list-scan`                                   | P4/B5 终端端口                                                          |
| `approval-default-rules` | `approval-rules`                                      | 内置规则表随 `phone-tool` 一起端口化（`phone-tool` 直连 SDK，不进内核） |

**PORTS（4 个，P2 反转成端口）**
`client-state`（设置存储）· `settings-service`（设置帧）· `terminals`（PTY）· `tool-manager`（工具目录）

**已经搬进来的（62 个）**
30 个原计划模块（除 `protocol`，它单独一轮）+ 33 个「纯叶子」连带项：
`atomic-file` `text-quote` `attachment-store` `model-error` `engine-catalog` `transcript-scan`
`serialized-json-writer` `client-id-utils` `conversation-tool-names` `question-params` `approval-audit`
`tool-overrides` `mobile-notification-events` `quick-ask-settings` `delegate-mode` `plugin-tool-guard`
`browser-page-tool` `subagent-evidence` `subagent-ledger` `subagent-templates-hant` `goal-review-gate`
`conversation-communication` `dangling-tools` `compaction-markers` `plan-mode` `hashline-engine`

- `markers/`（`index` `registry` `marker` `store` `builtins/{notify,rename,action}`）

连带项为什么必须一起搬：`session-projection` / `serialize` / `transcript-prepare` / `tool-guards` / `subagents`
这些叶子对上面这些纯工具叶子有**首跳依赖**；只搬 30 个会让依赖清单暴涨，而纯叶子（自身零宿主依赖）
搬进来的边际成本只有一次机械移动。

老位置（`server/<m>.ts`）一律只剩 `export * from "../packages/keel/src/<m>.js";` 的 shim，
主应用 100+ 处 import 不用动，直到 P5 删 shim。

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
