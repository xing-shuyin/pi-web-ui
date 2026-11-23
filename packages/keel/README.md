# keel —— 会话编排内核

`keel`（龙骨）是被 `server/core` 抽出来的独立项目：编码智能体的会话编排内核。
它只管「对话、轮次、工具与审批、子代理、出帧、历史」，**不认识 UI、不认识插件面板、不认识 PTY**。

主应用（`pi-web-ui`）是它的第一个消费方。

## 现在到哪一步

| 阶段   | 内容                                                                                | 状态                  |
| ------ | ----------------------------------------------------------------------------------- | --------------------- |
| **P0** | 包骨架 + 依赖清单守卫（本目录）                                                     | ✅ 进行中的就是这一步 |
| P1     | 把 30 个随包模块物理搬进 `src/`，`src/index.ts` 的桥删掉                            | 未开始                |
| P2     | 剩下 4 个（settings / terminals / tool-manager / client-state）反转成端口，宿主注入 | 未开始                |
| P3     | 发布 `@earendil-works/keel`，主应用改成版本依赖；启用 npm workspaces                | 未开始                |

## 为什么 P0 不启用 npm workspaces

workspaces 要求 lockfile 里登记 workspace 包，`npm ci` 会因此校验失败——在主应用还没真正依赖 keel 之前启用它，
等于给 CI 埋一颗「锁文件不同步」的雷。P0 用 **tsconfig paths + 依赖清单守卫**拿到同样的边界，
等 P3 真正发布时再启用 workspaces（那时 lockfile 会随发布一起更新）。

## 依赖清单（P0 冻结，只许变短）

`src/` 当前允许 import 的 app 模块（守卫：`tests/unit/keel-package.test.ts`）。
P1 之后这张表逐行划掉，搬进 `src/`；**新增一行都会红**。

**随包搬走（30 个 / 13,526 行）**
`protocol` `session-turns` `session-projection` `conversation-rows` `queue-utils` `serialize`
`versioned-doc` `path-boundary` `session-open` `transcript-prepare` `session-branch` `session-parser`
`session-search` `session-scan` `session-list-scan` `i18n` `agent-formatters` `engine-capabilities`
`tool-guards` `tool-approval` `approval-rules` `pending-question` `ask-user-question-tool` `subagents`
`subagent-templates` `subagent-settle` `subagent-security-gate` `engine-service` `launch-origin` `orphan-manager`

**留在宿主、反转成端口（4 个 / 7,419 行）**
`client-state`（设置存储）· `settings-service`（设置帧）· `terminals`（PTY）· `tool-manager`（工具目录）

## 契约

- 入口只有 `src/index.ts`；宿主不得 import 包内其它路径。
- 内核不得 import 宿主的 UI / 插件 / 面板 / PTY 实现（P1 后由守卫强制）。
- 现有不变量继续有效：喂轮单出口、出帧单源、退役 fail-closed、版本化存储单源、前缀缓存只追加。
