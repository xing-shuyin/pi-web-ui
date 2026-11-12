<!-- prettier-ignore-start -->
# AGENTS.md — pi-web-ui 关键功能 → 事实源 → 文档

> **本文件只做映射与索引，不写细则**：想知道某块能力怎么改、有哪些禁令，按下表去读 `docs/` 对应文档。
> 新规则请写进对应 `docs/`（红线细则执行 [`docs/agent-rules.md`](docs/agent-rules.md)），**不要再往本文件堆段落**——体积与死链由 `tests/unit/agents-md.test.ts` 守卫。
> 修改本文件后在 pi 里 `/reload`。精简前的全文备份：`AGENTS.md.bak`。

## 0. 是什么

pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：浏览器对话、文件树、附件、内置终端、模型管理、插件市场、设备中心/群组、画布工作流、Electron 桌面壳。
技术栈：Node（>= 22.19.0）+ Express + `ws` 后端 · React 19 + Vite 前端 · xterm.js + node-pty 终端 · 单文件 `web/src/styles.css` 主题基线。版本号 `package.json` 与 `package-lock.json` 两处同步。

## 1. 关键功能 → 事实源文件 → 文档

| 功能 | 事实源文件（★=唯一单源） | 文档 |
| --- | --- | --- |
| **文档总索引**（主题 / 权重 / 按场景阅读路线） | — | [`docs/README.md`](docs/README.md) |
| 快照驱动 / 协议单源 / 多对话并发 | `server/protocol.ts`★ · `server/agent-service.ts` · `web/src/app-globals.ts` · `web/src/types.ts`（shim） | [`architecture-core.md`](docs/architecture-core.md) |
| 侧栏会话排序 / 用户发送置顶 / 对话↔历史行归属与身份 | `web/src/conversation-order.ts`★ · `server/conversation-rows.ts`★ · `web/src/session-identity.ts`★ · `web/src/components/LeftPanel.tsx` · `web/src/use-chat.ts` | [`architecture-core.md`](docs/architecture-core.md#侧栏历史会话加载) |
| 安全边界（loopback/Origin/Cookie/appUrl） | `server/index.ts` · `server/auth-cookie.ts` | [`architecture-core.md`](docs/architecture-core.md) · [`agent-rules.md`](docs/agent-rules.md#一通信协议与数据安全) |
| 随手问 / 选中文字解释 | `server/quick-ask.ts` · `web/src/quick-ask.ts` · `web/src/components/QuickAskPopover.tsx` | [`architecture-core.md`](docs/architecture-core.md#随手问独立小窗) |
| 系统提示词组装 / 设置保存回执 | `server/prompt-composer.ts`★ · `web/src/settings-sync.ts`★（pending overlay + 回执） | [`architecture-system-prompt.md`](docs/architecture-system-prompt.md) |
| 工具开关 / 工具提示词 / 内置工具覆盖 | `server/tool-manager.ts`★ · `server/tool-prompts.ts`★ · `server/tool-overrides.ts` · `server/bash-timeout.ts`（bash/powershell 默认超时单源） | [`agent-rules.md`](docs/agent-rules.md#二工具定义与提示词规范) · [`tool-context-budget.md`](docs/tool-context-budget.md) |
| 上下文预算 / 延迟加载 / 证据外置 | `server/soft-cap.ts` · `server/request-context.ts` · `server/evidence-tool-hooks.ts` | [`tool-context-budget.md`](docs/tool-context-budget.md) |
| 工具审批门禁与规则库 | `server/tool-approval.ts` | [`architecture-core.md`](docs/architecture-core.md#审批队列与共享展示) |
| 内置浏览器 / 桌面三模式 / Web 原生桥 | `browser/` · `desktop/browser-host.ts` · `web/src/browser-control.ts` | [`architecture-browser.md`](docs/architecture-browser.md) |
| 凭据保险库（密码 + TOTP，图标工具条 / 扫码 / 按站点匹配 / 填码） | `browser/renderer/vault.ts`★ · `browser/runtime/totp.ts`★ · `browser/runtime/qr.ts` · `browser/runtime/credentials.ts` · `desktop/browser-host.ts`（密码只下发投影） · `browser/storage/index.ts` | [`architecture-browser.md`](docs/architecture-browser.md#凭据保险库密码--totp) |
| 页面脚本注入（临时 / 永久，`browser_script`） | `browser/runtime/scripts.ts` · `browser/automation/scripts.ts` · `server/browser-script-tool.ts` | [`architecture-browser.md`](docs/architecture-browser.md) |
| 手机 App / 多设备切换 / 原生通知 | `mobile/` · `web/src/mobile-runtime.ts` · `server/mobile-push.ts` · `server/device-center/hub-mobile.ts` | [`mobile.md`](docs/mobile.md) |
| 终端 PTY / 原生 CLI / bash 接管 / SCM | `server/terminals.ts` · `server/native-cli.ts` · `server/engine-catalog.ts`★ · `server/engine-cli.ts` · `web/src/components/NativeCliPanel.tsx` | [`architecture-terminal.md`](docs/architecture-terminal.md) |
| 命令执行防卡死 / 硬超时 / 后台托管 | `server/job-runner.ts`★（`bash({background:true})` 进程内 job）· `scripts/safe-exec.mjs`（源码仓库 / CI 执行器）· `server/process-utils.ts`（`killPidTree` 单源） | [`development.md`](docs/development.md#命令执行防卡死) · [`agent-rules.md`](docs/agent-rules.md#七终端命令执行防卡死) |
| 附件 / 图片预览 / OCR / 标注 / 系统截图 | `server/file-save.ts` · `web/src/components/ImageLightbox.tsx` · `plugins/image-ocr/` · `server/system-screenshot.ts` · `server/system-screenshot-macos.ts` | [`architecture-attachments.md`](docs/architecture-attachments.md) |
| 插件体系 / UI 插槽 / MCP 项目运行态 | `server/plugins.ts` · `web/src/ui-slots.ts`★ · `server/mcp-project-runtime.ts` | [`architecture-plugins.md`](docs/architecture-plugins.md) |
| 插件物化（代码纯缓存）/ 状态目录 | `server/plugin-paths.ts`★ · `server/plugin-materialize.ts`★ · `server/fs-copy.ts`★ | [`architecture-plugins.md`](docs/architecture-plugins.md#插件目录代码是纯缓存状态独立存放plugin-pathsts--plugin-materializets) |
| 统一 TTS / 系统语音 / 插件音色 / QQ 语音回复 | `server/tts-service.ts`★ · `server/tts-system.ts` · `server/tts-routes.ts` · `web/src/tts-client.ts` · `plugins/qq/voice.mjs` | [`architecture-tts.md`](docs/architecture-tts.md) |
| 子代理 / 对话通信 / 工作树 / 过户 | `server/subagents.ts` · `server/conversation-identity.ts` · `#take_over_conversation` | [`architecture-core.md`](docs/architecture-core.md) · [`root-cause-boundaries.md`](docs/root-cause-boundaries.md) |
| 目标模式 2.0 / 委派 / 计划模式 | `server/goal-service.ts` · `server/delegate-mode.ts` · `server/plan-mode.ts` | [`goal-conversation-design.md`](docs/goal-conversation-design.md) · [`agent-rules.md`](docs/agent-rules.md#四架构与运行态约束) |
| 无人值守 / 常驻执行者 / `alwaysOn` 插件 | `server/background-executors.ts`★ · `server/plugins.ts`（`ensureLoaded` scope） · `manifest.alwaysOn` | [`unattended-operation.md`](docs/unattended-operation.md) |
| DSH 预设 / 问卷 / 底栏统计 | `server/dsh-*.ts` · `server/dsh/dsh-usage.ts` | [`dsh-engine.md`](docs/dsh-engine.md) |
| 沙盒工作区 | `docs/architecture-sandbox.md` 列出的执行会话身份链 | [`architecture-sandbox.md`](docs/architecture-sandbox.md) |
| 设备中心 / 群组 Bot / 远程桌面 / 文件同步 | `server/device-center/`（`hub-conversations.ts` · `task-recovery.ts` · `desktop*.ts`） | [`device-center.md`](docs/device-center.md) · [`device-collaboration.md`](docs/device-collaboration.md) · [`device-desktop.md`](docs/device-desktop.md) · [`device-file-sync.md`](docs/device-file-sync.md) |
| Hub 在线升级 / 发布包验收 | `bin/hub-upgrade.mjs`★ · `server/device-center/hub-upgrade.ts` · `tests/hub-upgrade-release-test.mjs` | [`device-center.md`](docs/device-center.md#hub-在线升级) · [`hub-upgrade-release-testing.md`](docs/hub-upgrade-release-testing.md) |
| 画布协同（版本 / 运行 / 产物） | `server/canvas/` · `server/workspace-handle.ts`（共享工作树原语） | [`architecture-canvas.md`](docs/architecture-canvas.md) |
| 预设导入导出 / 社区分享 | `server/preset-share.ts` · `server/preset-fields.ts` | [`preset-sharing.md`](docs/preset-sharing.md) |
| 本地化 / 模块字典 / 语言包同步 | `web/src/i18n/catalog.ts`★ · `web/src/i18n/messages/` · `scripts/lib/i18n-catalog.mjs` | [`i18n.md`](docs/i18n.md) |
| UI 布局 / 主题 / 样式红线 | `web/src/styles.css` · `themes/` | [`agent-rules.md`](docs/agent-rules.md#三ui-布局与样式规范) |
| 目录结构与全量文件清单 | — | [`directory-reference.md`](docs/directory-reference.md) |

## 2. 工程流

| 主题 | 文档 | 常用入口 |
| --- | --- | --- |
| 开发工作流 / CI | [`development.md`](docs/development.md) | `npm run dev` · `npm run typecheck` · `npm run lint` · `npm test` · `npm run test:smoke` · `npm run ci:local`（本地复刻 CI 门禁） |
| 测试规范 | [`development.md`](docs/development.md) | 端口 ≥8900、data-dir `mkdtemp`、禁 `pkill -f`、冒烟禁用 `ensure-build.mjs` |
| 发布 | [`release.md`](docs/release.md) | `npm run changelog:i18n` → commit → tag `vX.Y.Z`（自动桌面/说明）→ 手机包 `npm run release:local -- vX.Y.Z --skip-desktop` → `npm run release:npm` → `npm run release:check` |
| 部署 | [`deployment.md`](docs/deployment.md) | `pi-web-ui server install` · `docker compose up -d` |
| 环境变量全表 | [`env-vars.md`](docs/env-vars.md) | `PI_WEB_PORT` · `PI_WEB_HOST` · `PI_WEB_CWD` · `PI_WEB_DATA_DIR` · `PI_WEB_TOKEN` · `PI_WEB_SDK` |

## 3. 红线（细则见 `docs/agent-rules.md`，守卫均对应 `tests/unit/<守卫>.test.ts`）

| 域 | 一句话禁令 | 守卫 |
| --- | --- | --- |
| **安全/协议** | `details` ≤64KB；服务端 URL 必包 `appUrl()`；Cookie 校验前先解码；未登录页口令表单必须原生 `POST /__pi/auth`（禁 JS 拼 `?token=`） | `auth-login` |
| **提示词/工具** | 工具提示词三处职责分离、纯英文精简；导出 schema 只留字段名/类型（装饰约束与自解释字段说明不写） | `tool-prompt-hygiene` · `tool-schema-slim` · `lazy-tools-test` |
| **提示词/工具** | 新增可开关工具三处联动（catalog / customTools / 注册单测） | `tool-registration` |
| **提示词/工具** | 提示词 base（SYSTEM.md / APPEND_SYSTEM.md）归属 session 的 loader，禁客户端级「最近一次」字段 | `prompt-base-scope` |
| **服务端/运行态** | 压缩软上限双层监控；换模型只走 `applySessionModel` | — |
| **服务端/运行态** | 会话过户必须事务性回滚；跨 await 用稳定身份，禁读 active | `takeover-rollback-test` |
| **服务端/运行态** | 工作区命令（set_cwd/new_chat/switch_*/沙盒）一律走 `server/workspace-queue.ts` 队列；`new_chat.cwd` 切不过去就不建会话 | `workspace-queue` · `pending-workspace` |
| **服务端/运行态** | 服务端禁同步子进程（`spawnSync`/`execSync`/`execFileSync`），热路径改异步 spawn 或静态推导 | `sync-child-process-guard` |
| **服务端/运行态** | 远期定时器 >6h 必须 `armDelay` 分片；预设分享必须白名单净化 + dryRun | `plugin-cron-overflow-test` · `preset-share` |
| **前端/样式** | 强调色/语义色实底文字走 `--accent-contrast` / `--on-*`；主题文字令牌有对比度下限 | `accent-contrast` · `semantic-contrast` · `theme-text-contrast` |
| **前端/样式** | 长文本/路径防溢出三件套；独立浮层才可 `overscroll-behavior: contain`；卡头只放自身复制键 | `text-wrap` · `messages-behind-composer` |
| **前端/样式** | 叠栈浮层禁写死 z-index，一律 `useOverlayZIndex()`；输入框上带子单源 `--composer-strip`，禁把短语行改回 `absolute` | `overlay-stack` · `messages-behind-composer` |
| **前端/状态** | 左栏「运行中对话 / 历史会话」行归属只由 `server/conversation-rows.ts`（`rowKind`）裁定、身份只走 `web/src/session-identity.ts`，禁在组件里另写临时键 | `session-identity` · `conversation-row-declared` |
| **插件/依赖** | 宿主提供的包只进 `peerDependencies`（子进程副本进 `optionalDependencies`） | `extension-host-packages` |
| **插件/依赖** | 复制黑名单只走 `server/fs-copy.ts` 按相对路径判定；插件代码目录可重建、状态只住 `plugin-data/<id>/` | `plugin-copy-single-source` · `plugin-bundled` |
| **插件/依赖** | 插件市场 builtin 清单 `plugins/catalog.json` 只收本仓库 `plugins/<id>` 自带的插件；第三方插件登记到社区清单仓库 | `plugin-catalog-builtin-scope` |
| **插件/依赖** | 改内置插件必递增 `manifest.json` 版本号并同步数据目录；插件 `arrange.label` 改名必落到渲染层 | `plugin-version-bump-guard` · `bar-item-unified` |
| **测试规范** | 会话/守护假体一律走 `tests/helpers/fake-session.ts`（默认值从生产源码推导），禁手搓 `Object.create`（存量名单只许变短，迁移完删名单行） | `fake-session-sync` · `fake-session-adoption` |
| **终端/执行** | 长驻服务走 `bash({background:true})`（面板可停）；源码仓库/CI 死命令走 `safe-exec`（硬超时 + 杀进程树 + 日志先落盘）；禁前台 watch/pager/等 stdin，禁手写 `timeout`/`nohup` 前缀 | `safe-exec` |

## 4. 提交前三连验（CI 硬门禁）

1. `npx prettier --write <改动文件>`
2. `npm run typecheck`（5 个 tsconfig 零错误；单测 mock 用 `{} as any`）
3. `npx vitest run <相关单测>`
<!-- prettier-ignore-end -->
