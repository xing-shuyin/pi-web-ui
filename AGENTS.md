# AGENTS.md — pi-web-ui 关键功能 → 事实源 → 文档

> **本文件只做映射与索引，不写细则**：想知道某块能力怎么改、有哪些禁令，按下表去读 `docs/` 对应文档。
> 新规则请写进对应 docs（红线细则执行 [`docs/agent-rules.md`](docs/agent-rules.md)），**不要再往本文件堆段落**——体积与死链由 `tests/unit/agents-md.test.ts` 守卫。
> 修改本文件后在 pi 里 `/reload`。精简前的全文备份：`AGENTS.md.bak`。

## 0. 是什么

pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：浏览器对话、文件树、附件、内置终端、模型管理、插件市场、设备中心/群组、画布工作流、Electron 桌面壳。
技术栈：Node（>= 22.19.0）+ Express + `ws` 后端 · React 19 + Vite 前端 · xterm.js + node-pty 终端 · 单文件 `web/src/styles.css` 主题基线。版本号 `package.json` 与 `package-lock.json` 两处同步。

## 1. 关键功能 → 事实源文件 → 文档

| 功能                                           | 事实源文件（★=唯一单源）                                                                                  | 文档                                                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **文档总索引**（主题 / 权重 / 按场景阅读路线） | —                                                                                                         | [`docs/README.md`](docs/README.md)                                                                                                                                                                          |
| 快照驱动 / 协议单源 / 多对话并发               | `server/protocol.ts`★ · `server/agent-service.ts` · `web/src/app-globals.ts` · `web/src/types.ts`（shim） | [`architecture-core.md`](docs/architecture-core.md)                                                                                                                                                         |
| 安全边界（loopback/Origin/Cookie/appUrl）      | `server/index.ts` · `server/auth-cookie.ts`                                                               | [`architecture-core.md`](docs/architecture-core.md) · [`agent-rules.md`](docs/agent-rules.md#一通信协议与数据安全)                                                                                          |
| 系统提示词组装                                 | `server/prompt-composer.ts`                                                                               | [`architecture-system-prompt.md`](docs/architecture-system-prompt.md)                                                                                                                                       |
| 工具开关 / 工具提示词 / 内置工具覆盖           | `server/tool-manager.ts`★ · `server/tool-prompts.ts`★ · `server/tool-overrides.ts`                        | [`agent-rules.md`](docs/agent-rules.md#二工具定义与提示词规范) · [`tool-context-budget.md`](docs/tool-context-budget.md)                                                                                    |
| 上下文预算 / 延迟加载 / 证据外置               | `server/soft-cap.ts` · `request-context.ts` · `evidence-tool-hooks.ts`                                    | [`tool-context-budget.md`](docs/tool-context-budget.md)                                                                                                                                                     |
| 工具审批门禁与规则库                           | `server/tool-approval.ts`                                                                                 | [`architecture-core.md`](docs/architecture-core.md#审批队列与共享展示)                                                                                                                                      |
| 终端 PTY / bash 接管 / SCM                     | `server/terminals.ts` · `patch-bash-process.ts`                                                           | [`architecture-terminal.md`](docs/architecture-terminal.md)                                                                                                                                                 |
| 附件 / 图片 / 预览 / 上传下载                  | `server/file-save.ts` · `decodeText`                                                                      | [`architecture-attachments.md`](docs/architecture-attachments.md)                                                                                                                                           |
| 插件体系 / UI 插槽 / MCP 项目运行态            | `server/plugins.ts` · `web/src/ui-slots.ts`★ · `server/mcp-project-runtime.ts`                            | [`architecture-plugins.md`](docs/architecture-plugins.md)                                                                                                                                                   |
| 子代理 / 对话通信 / 工作树 / 过户              | `server/subagents.ts` · `conversation-identity.ts` · `take_over_conversation`                             | [`architecture-core.md`](docs/architecture-core.md) · [`root-cause-boundaries.md`](docs/root-cause-boundaries.md)                                                                                           |
| 目标模式 2.0 / 委派 / 计划模式                 | `server/goal-service.ts` · `server/delegate-mode.ts` · `server/plan-mode.ts`                              | [`goal-conversation-design.md`](docs/goal-conversation-design.md) · [`agent-rules.md`](docs/agent-rules.md#四架构与运行态约束)                                                                              |
| DSH 预设 / 问卷 / 底栏统计                     | `server/dsh-*.ts` · `server/dsh/dsh-usage.ts`                                                             | [`dsh-engine.md`](docs/dsh-engine.md)                                                                                                                                                                       |
| 沙盒工作区                                     | `docs/architecture-sandbox.md` 列出的执行会话身份链                                                       | [`architecture-sandbox.md`](docs/architecture-sandbox.md)                                                                                                                                                   |
| 设备中心 / 群组 Bot / 远程桌面 / 文件同步      | `server/device-center/`（`hub-conversations.ts` · `task-recovery.ts` · `desktop*.ts`）                    | [`device-center.md`](docs/device-center.md) · [`device-collaboration.md`](docs/device-collaboration.md) · [`device-desktop.md`](docs/device-desktop.md) · [`device-file-sync.md`](docs/device-file-sync.md) |
| 画布协同（版本 / 运行 / 产物）                 | `server/canvas/`（`canvas-dispatch.ts` · `canvas-workspace.ts`）                                          | [`architecture-canvas.md`](docs/architecture-canvas.md)                                                                                                                                                     |
| 预设导入导出 / 社区分享                        | `server/preset-share.ts` · `preset-fields.ts`                                                             | [`preset-sharing.md`](docs/preset-sharing.md)                                                                                                                                                               |
| UI 布局 / 主题 / 样式红线                      | `web/src/styles.css` · `themes/`                                                                          | [`agent-rules.md`](docs/agent-rules.md#三ui-布局与样式规范)                                                                                                                                                 |
| 目录结构与全量文件清单                         | —                                                                                                         | [`directory-reference.md`](docs/directory-reference.md)                                                                                                                                                     |

## 2. 工程流

| 主题            | 文档                                    | 常用入口                                                                                         |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 开发工作流 / CI | [`development.md`](docs/development.md) | `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run test:smoke`         |
| 测试规范        | [`development.md`](docs/development.md) | 端口 ≥8900、data-dir `mkdtemp`、禁 `pkill -f`、冒烟禁用 `ensure-build.mjs`                       |
| 发布            | [`release.md`](docs/release.md)         | `npm run changelog:i18n` → commit → tag `vX.Y.Z` → `npm publish`                                 |
| 部署            | [`deployment.md`](docs/deployment.md)   | `pi-web-ui server install` · `docker compose up -d`                                              |
| 环境变量全表    | [`env-vars.md`](docs/env-vars.md)       | `PI_WEB_PORT` · `PI_WEB_HOST` · `PI_WEB_CWD` · `PI_WEB_DATA_DIR` · `PI_WEB_TOKEN` · `PI_WEB_SDK` |

## 3. 红线（细则 + 守卫测试见 `docs/agent-rules.md`）

| 一句话禁令                                                                                                               | 守卫                                      |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `details` ≤64KB；服务端 URL 必须包 `appUrl()`；Cookie 校验前先解码                                                       | —                                         |
| 工具提示词三处职责分离、纯英文精简；延迟加载禁改前缀                                                                     | `tool-prompt-hygiene` · `lazy-tools-test` |
| 强调色/语义色实底文字走 `--accent-contrast` / `--on-*`                                                                   | `accent-contrast` · `semantic-contrast`   |
| 主题文字令牌有对比度下限；长文本/路径防溢出三件套                                                                        | `theme-text-contrast` · `text-wrap`       |
| 独立浮层才可 `overscroll-behavior: contain`；卡头只放自身复制键                                                          | `text-wrap` · `messages-behind-composer`  |
| 输入框上带子单源 `--composer-strip`，禁把短语行改回 `absolute`                                                           | `messages-behind-composer`                |
| 压缩软上限双层监控；换模型只走 `applySessionModel`                                                                       | —                                         |
| 会话过户必须事务性回滚；跨 await 用稳定身份，禁读 active                                                                 | `takeover-rollback-test`                  |
| 宿主提供的包只进 `peerDependencies`（子进程副本进 `optionalDependencies`）                                               | `extension-host-packages`                 |
| 改内置插件必须递增 `manifest.json` 版本号，并同步本地数据目录插件                                                        | `plugin-version-bump-guard`               |
| 预设分享必须白名单净化 + dryRun                                                                                          | `preset-share`                            |
| 远期定时器 >6h 必须 `armDelay` 分片                                                                                      | `plugin-cron-overflow-test`               |
| 新增可开关工具三处联动（catalog / customTools / 注册单测）                                                               | `tool-registration`                       |
| 提示词 base（SYSTEM.md / APPEND_SYSTEM.md）归属 session 的 loader，禁客户端级「最近一次」字段                            | `prompt-base-scope`                       |
| 插件 `arrange.label` 改名必须落到渲染层                                                                                  | `bar-item-unified`                        |
| 会话/守护假体一律走 `tests/helpers/fake-session.ts`（字段默认值从生产源码推导），禁手搓 `Object.create(原型)` 逐个补字段 | `fake-session-sync`                       |
| 存量手搓会话假体只许变短（名单外新增即红，迁移完成须删名单行）                                                           | `fake-session-adoption`                   |

## 4. 提交前三连验（CI 硬门禁）

1. `npx prettier --write <改动文件>`
2. `npm run typecheck`（5 个 tsconfig 零错误；单测 mock 用 `{} as any`）
3. `npx vitest run <相关单测>`

---

_结构/流程/能力变更时：改对应 `docs/` 文档，并在上表登记入口；本文件保持索引形态。修改后 `/reload`。_
