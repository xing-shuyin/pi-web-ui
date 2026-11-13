# Issue #885 分诊：Full Pi CLI 继承 + 统一扩展管理

> 只读核实，不改逻辑。并行 PR 在跑，本次只写本文档，不碰 `SCMPanel` / `vscode-editor` 相关文件。
> 核实日期：2026-11-13；工作目录 `E:/pi-web-ui`；无 gh token，未拉取远端 issue 全文，按任务描述中的“史诗（7 节 11 条验收）”做分诊。

## 结论前置（给非技术读者）

- **#885 “完全不继承”不成立**：WebUI 与 Pi CLI 已经共用同一个 `agentDir`（默认 `~/.pi/agent`），`auth.json / models.json / mcp.json / skills` 都是同一份；SDK 内置扩展也会加载。
- **#885 后半句成立**：缺的是“统一管理界面”和“防覆盖的显式声明”。即：用户看不到“这个扩展到底来自 Pi CLI / WebUI / 外部”，坏了看不到错误详情，想开关要翻好几个地方，一键刷新也没有。
- **值得做，但不要一次做完**：继承链是底座（已通），管理 UI 是上层（缺 5–6 块）。一次全做会同时碰运行时、设置、插件市场、MCP 热加载，极易与并行 PR 冲突，且任何一块 regression 都会导致会话起不来。拆成 6 个可独立上线的小任务，第一步只做“只读清单”，零风险。

## 1. 这次读了什么（证据链）

| 文件                                      | 看了什么                                                                                                                                                       | 结论                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `server/agent-service.ts:4055`            | `const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir()`                                                                                            | 与 SDK 共用 `agentDir`，环境变量可覆盖            |
| `server/agent-service.ts:3743–3789`       | `ClientSession` 构造存 `this.agentDir`，`agentDir: () => this.agentDir` 传给 `SettingsService`                                                                 | 全会话共享同一目录身份                            |
| `server/agent-service.ts:4233, 4319`      | `getSdkBuiltinExtensionFactories()` + `disabledBuiltinExtensions: ["mcp"]`，`extensionsOverride` 按 `disabledExtensions` 过滤                                  | SDK 内置扩展已加载，唯独 `mcp` 被显式禁用走自家桥 |
| `server/sdk-builtin-extensions.ts:25–81`  | `resolveSdkExtensionsIndexPath()` → `builtInExtensions`（跳过 `mcp`），兜底 `codemode / tool-search`（`hidden: true, replaceable: true`）                      | 内置扩展来源是 SDK 包本身，隐藏但可替换           |
| `server/mcp-bridge.ts:13–36`              | `getGlobalMcpPath(agentDir)` → `<agentDir>/mcp.json`；`getProjectMcpPath(cwd)` → `<cwd>/.pi/mcp.json`；另有 `dataDir/mcp.json` 遗留兼容                        | MCP 双层继承：全局 + 项目                         |
| `server/agent-service.ts:4284–4315, 9295` | `discoverDiskSkills({ cwd, agentDir, workspaceRoots })` + `mergeSkillCollections(res.skills, discovered)`，再按 `disabledSkills / enabledSkills / preset` 过滤 | Skill 双层继承：SDK 自带 + 磁盘发现合并           |
| `server/client-state.ts:846–880`          | `isExtensionDisabled / isExtensionEnabled` + `extensionKeyCandidates`；`isInternalExtension`（`<inline: / <builtin: / hidden`）永不禁用                        | Pi CLI 自定义扩展会被继承，但内部扩展锁死不可关   |
| `server/plugins.ts:2561–2720`             | `ensureLoaded({ scope: "all" \| "alwaysOn" })`，`ensureAlwaysOnLoaded` 开机无 WS 时只拉 `manifest.alwaysOn`，其余懒激活                                        | WebUI 插件是另一套体系，与 SDK 扩展完全分开       |
| `server/tool-manager.ts:1–60`             | 只有工具名常量与门禁（`CANVAS / TERMINAL / MCP_MANAGE / SKILL` 等），不管扩展加载                                                                              | 工具开关 ≠ 扩展管理，不要混为一谈                 |

一句话：**底座已通（同一 agentDir + 同一 MCP/Skill/Extension 过滤器），上层缺（统一视图 + 统一开关 + 错误详情 + 一键刷新 + 防覆盖声明）**。

## 2. 现状已继承什么

1. **身份目录**：`agentDir` 单源，`auth.json`（登录）、`models.json`（模型）、`mcp.json`（全局 MCP）、`skills/`（全局技能）、`sessions/`、`bot-sessions/` 全共用。改 Pi CLI 的登录，WebUI 立刻生效，反之亦然。
2. **SDK 内置扩展**：`codemode / tool-search` 等经 `getSdkBuiltinExtensionFactories()` 注入 `createAgentSessionServices({ extensionFactories })`。`mcp` 是唯一被禁的内置扩展（走 WebUI 自己的 `McpBridge`，避免双跑）。
3. **MCP 配置**：全局 `<agentDir>/mcp.json` + 项目 `<cwd>/.pi/mcp.json` 双层合并，另有 `dataDir/mcp.json` 旧路径兜底。`mcp_manage` 工具描述里也写了这两条路径。
4. **Skills**：SDK `res.skills` 与本地 `discoverDiskSkills` 合并，支持 `global / project / ancestor / package` 多 scope，再走预设与 `disabledSkills` 门禁。
5. **第三方扩展过滤**：Pi CLI 装的自定义扩展会出现在 `res.extensions`，WebUI 用 `disabledExtensions / enabledExtensions`（`extensionKeyCandidates` 匹配）做启停，内部扩展（`hidden / <inline: / <builtin:`）强制保留。

## 3. 缺什么（#885 真正要补的）

1. **没有统一列表**：SDK 扩展、WebUI UI 插件（`server/plugins.ts`）、MCP servers 三处各说各话。设置页能看到 WebUI 插件的 `来源 owner/repo`（`pluginCatalogSource` 文案已存在），但看不到 SDK 扩展的来源（Pi CLI / WebUI / 外部）。
2. **没有统一启停**：SDK 扩展走 `disabledExtensions`，Skill 走 `disabledSkills`，WebUI 插件走 `alwaysOn + 懒激活`。用户要关一个能力，得猜它是哪类。
3. **没有错误详情**：`bindExtensions({ onError: makeExtensionErrorReporter })` 的错误只进 notice / 日志，没有“哪个扩展挂了、为什么挂、点哪重试”的面板。`alwaysOnSnapshot()` 有体检快照，但只给 `/api/health` 用，前端没展示。
4. **没有一键刷新**：MCP 有热加载（`mcp-hot-reload.ts` 监听 `mcp.json`），WebUI 插件有 `rescanAlwaysOn`（只管失败的常驻插件），SDK 扩展没有。三者没合成一个“刷新”按钮。
5. **没有防覆盖显式声明**：`<agentDir>/mcp.json` vs `<cwd>/.pi/mcp.json` vs `dataDir/mcp.json` 的优先级只写在代码里（`mcp-bridge.ts`），文档和 UI 里没写。用户不知道项目配置会不会盖掉全局配置，`PI_CODING_AGENT_DIR` 改了之后更懵。

## 4. 拆解：6 个可独立交付的子任务

> 原则：只读先行 → 只展示 → 再动开关 → 最后动加载。每条可单独提 PR、单独回滚。

### T1 — 统一扩展清单只读 API + 文档（S）

- 做什么：在服务端拼一个只读聚合（SDK `extensions` + WebUI `plugins.list()` + MCP `listAllMcpServers`），字段至少 `id / kind(sdk-extension | webui-plugin | mcp-server | skill) / source(Pi CLI / WebUI / 外部 / 内置) / enabled / error?`；先只打日志 + 写文档，不接 UI。
- 验收：调一次新接口，能看到三类条目且 `source` 不为空；`hidden:true` 的内置扩展标注为“内置”，不参与计数；有单测覆盖聚合函数。
- 估算：**S（1 天内）**。
- 为什么先做：零 UI 风险，后续 T2–T6 都依赖这份清单口径。

### T2 — 设置页/插件市场补“来源”展示（S）

- 做什么：纯展示。在现有插件行 / 扩展行加 `来源：Pi CLI / WebUI / 外部` 文案 + 错误 tip 入口，不改任何开关逻辑。动文件限 `docs/ + 最多 1 个展示文件`，改前 `claim_files` 先占。
- 验收：三类来源在 UI 上可区分；`无来源信息`（`uiPluginNoSource`）保持原样；无逻辑变更，`typecheck + 相关单测` 通过。
- 估算：**S**。
- 依赖：T1 的 `source` 口径。

### T3 — 统一启停：三套开关打通（M）

- 做什么：把 `disabledExtensions / disabledSkills / disabledAgentTools` 与 WebUI 插件的启用态收敛到同一份“扩展期望状态”；`alwaysOn` 常驻插件的停用要显式确认（避免停掉后台执行者依赖）。
- 验收：在统一列表点停用 → 对应 `disabled*` 落盘 + 会话 `reload` 生效；再启用可恢复；内部扩展（`isInternalExtension`）拒绝停用并给出原因。
- 估算：**M（2–4 天）**。
- 风险：动运行时门禁，需与目标模式 / 委派模式的工具闸门联测。

### T4 — 错误详情 + 一键刷新（M）

- 做什么：把 `makeExtensionErrorReporter` 的错误、`alwaysOnSnapshot()`、`mcp-hot-reload` 的失败收敛到“扩展详情抽屉”；一个“刷新”按钮按序调 `session.reload() → rescanAlwaysOn() → mcp reload`，每步有进度与结果。
- 验收：模拟一个坏 MCP server / 坏插件，能看到错误堆栈摘要 + “重试”按钮；刷新后恢复，无需重启服务端。
- 估算：**M**。
- 依赖：T1 清单；不碰会话过户逻辑。

### T5 — 防覆盖显式声明：优先级文档 + UI 提示（S）

- 做什么：把 `mcp-bridge.ts` 的优先级（`agentDir/mcp.json > dataDir/mcp.json` 遗留，项目 `.pi/mcp.json` 与全局合并）和 `PI_CODING_AGENT_DIR` 的覆盖语义写成文档 + 设置页小字提示；必要时在写入时弹“你正在覆盖全局配置”确认。
- 验收：文档说清三条路径谁赢；UI 上改项目 MCP 时能看到“仅影响本项目”提示；有单测锁住 `getGlobalMcpPath / getProjectMcpPath` 顺序。
- 估算：**S**。
- 为什么独立：纯文档 + 文案，零运行时风险，可随时合。

### T6 — MCP 项目运行态收敛（L）

- 做什么：把 `mcp-project-runtime.ts`（项目态）、`McpBridge`（桥）、后台执行者的 `allowedServers` 收敛到 T1 清单的 `mcp-server` 项；项目切换时自动 `prepare/retain`，失败不拖死整个会话。
- 验收：切项目后 MCP 列表自动更新；单个 server 启动失败只标红该 server，会话照常可用；有集成单测。
- 估算：**L（约 1 周，可再拆）**。
- 放最后：涉及多会话并发 + 沙盒门禁，面最大。

## 5. 为什么不一次做完

1. **面太大**：7 节 11 条验收横跨运行时（`agent-service`）、插件宿主（`plugins`）、MCP 桥、设置 UI，一次合入等于把三套开关同时换掉，回滚都不知道回哪段。
2. **易冲突**：另一并行任务正在改展示层（本任务已避开 `SCMPanel` / `vscode-editor`）；大 PR 必撞车。
3. **风险不对等**：T1/T2/T5 是只读 + 文案，随时可合；T3/T4/T6 动运行时，一个 regression 就是“会话起不来 / 工具全没”。先拿小的建立清单口径，大的才敢动。
4. **验收可测性**：拆开后每条都有“看得见的完成态”（清单能调通 / 来源能看见 / 开关能记住 / 错误能重试），一次做完则 11 条验收搅在一起，测不出谁坏了。

## 6. 第一步建议

**只做 T1（只读聚合 + 单测 + 本文档）**。理由：不碰 UI、不碰运行时、不与并行 PR 抢文件；一旦清单口径定下来，T2 的展示文案、T3 的开关、T4 的错误详情才有共同语言。如果连 T1 都觉得重，那就只合本文档，下次按 T1 开工。

本次任务按要求**没有做 T2 的代码改动**（只改了本文档一个 md），所以无展示文件变更、无需 `claim_files` 占位。

## 7. 是否建议提交

- **建议提交本文档**：纯新增 `docs/issue-885-triage.md`，无逻辑变更，`prettier` 已跑，不影响构建与并行 PR。
- 提交前：`npx prettier --write docs/issue-885-triage.md`（已执行）即可；`typecheck / 全量构建` 按任务要求不跑。
- 下一步（另起 PR）：T1 只读 API，或 T2 纯展示（记得 `claim_files` + 最多 1 个展示文件 + 避开 `SCMPanel` / `vscode-editor`）。

## 附：给维护者的一句话

Pi CLI 的东西 WebUI 本来就继承着，别再传“完全不继承”；真正的债是“看不见、关不掉、坏了不知道找谁”。先把清单（T1）和来源展示（T2）补上，#885 就完成了一半。
