# AGENTS.md — pi-web-ui 项目指南

> 给 AI 编码助手（pi / Claude Code / Cursor 等）看的高层指南，细节按主题在 `docs/`。
> 修改后在 pi 里跑 `/reload`。精简前全文备份：`AGENTS.md.bak`。

## 1. 项目是什么

pi-web-ui 是 pi 编码智能体（`@earendil-works/pi-coding-agent` SDK）的 Web 聊天界面：
浏览器对话、文件树、附件、内置终端（xterm.js + node-pty）、模型管理、声音提醒、中英文切换。
一条命令可跑，可 Docker / systemd / launchd / Windows 计划任务部署。
另有 **Electron 桌面壳**（`desktop/`，随机空闲口起同一 server，网页版零改动；见 `desktop/README.md`）。

- 仓库：`git@github.com:xing-shuyin/pi-web-ui.git`；npm 包 `pi-web-ui`
- Node **>= 22.19.0**；版本 `package.json` 与 `package-lock.json` 两处同步

## 2. 技术栈

| 层     | 技术                                                                   |
| ------ | ---------------------------------------------------------------------- |
| 后端   | Node + Express（静态 + `/api/health`）+ `ws`（`/ws`）                  |
| 前端   | React 19 + Vite 8 + react-markdown + highlight.js + xterm.js           |
| 智能体 | `@earendil-works/pi-coding-agent` SDK（进程内，读 `~/.pi/agent` 配置） |
| 终端   | node-pty（服务端 PTY）+ `@xterm/xterm`（经 terminal bridge 转发）      |
| 样式   | 单文件 `web/src/styles.css`（CSS 变量主题，默认深色）                  |

## 3. 目录结构

完整注释版目录树与全量文件清单见 `docs/directory-reference.md`。

- **顶层架构**：`server/`（后端 ESM 服务）· `web/`（前端 React 界面）· `bin/pi-web-ui.mjs`（CLI 入口）· `desktop/`（Electron 壳）· `deploy/`（守护进程配置示例）· `themes/`（主题样式表）· `plugins/`（官方插件体系，`catalog.json` 为市场清单）· `extensions/`（pi 扩展 `/webui`）· `docs/`（详尽架构与设计文档）· `tests/`（测试套件）。
- **server 核心事实源与入口（★=关键事实源）**：
  `protocol.ts`★（跨端 wire 协议唯一事实源）· `index.ts`（Express + WS 服务路由与心跳）· `agent-service.ts`（ClientSession / 运行态 / customTools 注册）· `tool-manager.ts`★（`AGENT_TOOL_CATALOG` 工具开关唯一事实源）· `tool-prompts.ts`★（bash 等工具提示词单源）· `tool-overrides.ts`（SDK 内置工具安全覆盖基底）· `client-state.ts`（持久化配置）· `tool-approval.ts`（审批门禁与规则库）· `plugins.ts`（UI 插槽与插件运行时）· `subagents.ts`（子代理管理）· `terminals.ts`（PTY 终端与 bash 接管）· `soft-cap.ts`（上下文软上限纯函数）· `goal-service.ts`（目标模式 2.0 审查会话编排）· `plan-mode.ts`（计划模式硬闸门）· `delegate-mode.ts`（审查者模式自动委派）· `preset-share.ts`（预设导入导出四道闸门净化）。
- **web/src 核心模块（★=优先阅读）**：
  `use-chat.ts`★（WS 通信 + Reducer + 终端 Bridge）· `app-globals.ts`★（模块级全局 Store + `appSend`，高频快照流禁入）· `ui-slots.ts`★（宿主 33 个 UI 扩展插槽与四层合并）· `types.ts`（协议类型 shim，受脚本守护）· `styles.css`（全应用共享 CSS 变量与主题基线）· `i18n.tsx`（前端双语国际化）· `composer-bridge.ts`（输入框草稿管理与自动聚焦）· `topbar-fit.ts`（顶栏溢出测量）· `use-floating-panel.ts`（浮层统管 Hook）。
- **测试与 CI 套件**：
  `tests/run-smoke.mjs`（零 token 冒烟聚合列表）· `tests/unit/`（vitest 纯函数单测）· `tests/*-test.mjs`（Playwright / WS 集成测试，无 Chrome 自动 SKIP）；CI 矩阵见 `.github/workflows/ci.yml`。

## 4. 核心架构与设计索引

详细文档位于 `docs/<主题>.md`，以下为各模块核心设计原则与事实源：

`docs/` 索引（找详细文档先看这里，均为 `docs/<名>.md`）：**architecture-core** 快照驱动/协议单源/安全边界/主题/多对话并发 · **architecture-attachments** 附件/图片/视觉桥/上传预览下载 · **architecture-terminal** 终端 PTY/SCM/活力检测/bash 接管 · **architecture-plugins** 插件形态/协议/宿主扩展点/MCP 桥/多根工作区 · **architecture-system-prompt** 系统提示词组装链路与 override 钩子 · **tool-context-budget** 工具上下文预算（文案精简 / 逐工具覆盖 / **延迟加载** + 前缀缓存硬约束）· **dsh-engine** DSH 预设/问卷/底栏统计/工具桥 · **goal-conversation-design** 目标模式 2.0（把目标审查变成对话：执行对话干活 + 当前对话当审查者；**已实施且只剩这一条路径** —— v1 的隐藏隔离审查会话 + 自治标记路径已删除，轮次/熔断/代次全在服务端，见该文档 §4/§11）· **development** 开发工作流/CI/编码约定/测试规范 · **release** 发布流程 · **deployment** 部署 · **env-vars** 环境变量全表 · **preset-sharing** 预设导入/导出/社区共享仓库（交换格式 / 白名单净化 / 一键分享 / 浏览列表）· **antigravity-proxy** 反代接入 · **directory-reference** 完整注释版目录树

| 主题                  | 文档                               | 一句话                                                                                                                                                                                                                        |
| --------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 快照驱动              | `docs/architecture-core.md`        | 服务端唯一事实源，60ms 节流；`snapshot_delta` 增量 + `message_delta` 实时通道；`send()` 背压超阈丢 snapshot（幂等，250ms 重试）；`get_state`/`flushSnapshot` 立即推一次                                                       |
| 协议单源              | 同上                               | 只改 `server/protocol.ts`，两端 switch 各加分支；`web/src/types.ts` 是 shim                                                                                                                                                   |
| 全局运行态            | 同上                               | 整树共享放 `app-globals.ts`（`useAppField` 单字段订阅，组件不收 `send` prop 用 `appSend`）；快照流数据禁入 store                                                                                                              |
| 安全边界              | 同上                               | 默认 loopback；WS Origin/Host 校验；quiesce 准入；provider headers 不下发浏览器                                                                                                                                               |
| 主题                  | 同上                               | styles.css 是共享基线；主题=完整样式表可覆盖一切；终端跟随主题                                                                                                                                                                |
| 多对话并发            | 同上                               | 每对话独立 runtime，上限 8/项目（子代理不计）；运行列表口径 listed ∪ 有内容的当前对话；clientId 存 sessionStorage，每标签页独立                                                                                               |
| 附件/预览             | `docs/architecture-attachments.md` | 只给路径引用（`reference`/`lines`，内容不注入）；预览 512KB 上限+嗅探+GBK 回退；媒体走 HTTP Range；下载绕 Safe Browsing                                                                                                       |
| 终端/SCM              | `docs/architecture-terminal.md`    | 每 Conversation 一个 TerminalManager；`terminalBash` 开关分流（`persist` 决定一次性/ai-bash 持久）；SCM 只读走 execFile，写操作走可见终端                                                                                     |
| 工具开关/read 目录    | `docs/architecture-core.md`        | `AGENT_TOOL_CATALOG` 唯一事实源；`read` 覆盖目录走 ls 口径（`readDirEnabled` 是行为开关，不入目录；仅 pi 引擎）；`read`/`write`/`edit` 三处覆盖与第三方扩展同名工具的共存（基底 = 扩展实现优先）见 `server/tool-overrides.ts` |
| 审批                  | `server/tool-approval.ts`          | 规则库 `<dataDir>/approval-rules.json`（ask/deny/allow）；三档放行：全局关→本对话全部允许→允许同类；记忆只在内存，随过户搬                                                                                                    |
| 问卷/草稿进快照       | `docs/architecture-core.md`        | `UiState.pendingQuestion`（刷新恢复）+ `UiState.draft`（只跟全量快照，`draft_update` 自带 sessionId）                                                                                                                         |
| 临时对话              | `server/agent-service.ts`          | `new_chat {ephemeral:true}`→内存不落盘；`UiState.isEphemeral` 恒存在于 light state；`persist_conversation` 一键转正（id 不变）                                                                                                |
| 插件/UI 扩展点        | `docs/architecture-plugins.md`     | `<dataDir>/plugins/<id>/`；manifest `ui` 与 `host.ui.register()` 同一套别名+枚举；合并「宿主<插件<arrange<用户偏好」；插件不碰 DOM；`PLUGIN_API_VERSION=2`                                                                    |
| 多根工作区            | 同上                               | `set_workspace_roots` 按项目 cwd 存（上限 8）；**额外根=工作区内**，插件读免授权；AI 只在主 cwd 干活                                                                                                                          |
| 子代理模板            | `server/subagent-templates.ts`     | 全局共享；append/replace + 白名单 + 可选模型/强度（空=跟随）；停用对 AI 不可见                                                                                                                                                |
| DSH                   | `docs/dsh-engine.md`               | 四预设 file: 克隆 mount；问卷/技能钩子挂 agent scope（host 收不到 scoped 事件）；底栏统计吃直播帧+usage（`dsh-usage.ts`）                                                                                                     |
| 压缩软上限            | `server/soft-cap.ts`               | C→`reserveTokens=W−C` live 注入；关/非法回填 16384；pi 引擎独有                                                                                                                                                               |
| 看门狗                | `docs/architecture-core.md`        | 20 分钟 abort 会话（不碰后台服务）；`ask_user_question` 豁免                                                                                                                                                                  |
| present_files         | `server/present-files-tool.ts`     | 只读探测+摘录预算走 `details`；前端无 details 也能渲染（参数解析+合并）；远端本地打开报不支持                                                                                                                                 |
| browser_page/对话引用 | `docs/architecture-core.md`        | 闸门在扩展侧；对话引用只发 `<conversation-ref>` aside，模型经 `conversation_read` 按需取                                                                                                                                      |
| 计划模式              | `server/plan-mode.ts`              | 目标条展开行「只规划」触发；动态剔除写工具并施加硬闸门拦截；禁倾倒大段代码；必须通过计划看板「开始实施」退出；回归 `plan-mode-test`。                                                                                         |
| 审查者模式            | `server/delegate-mode.ts`          | 开启后主会话只审不干，Prompt 自动投递常驻执行对话；硬闸门拦截一切写类与派发工具；计划模式优先级高于委派；回归 `delegate-mode-test`。                                                                                          |

## 5. 开发工作流

> 详见 `docs/development.md`

```bash
npm run dev          # node --watch 后端(:8788) + vite 前端(:5173)
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run format       # prettier（提交前必跑；只检查用 format:check）
npm run lint         # oxlint（提交前必跑；自动修用 lint:fix）
npm run build        # build:web + build:server
npm start            # 跑 dist/server/index.js（生产）
npm test             # vitest
npm run test:smoke   # 零 token 冒烟
```

约定：缩进 Tab；样式全在 `styles.css`；协议消息只改 `protocol.ts`（§4）；服务端 URL 一律 `appUrl()` 包一层（§9）。
i18n：前端 `useT()`，核心 `zh`/`en`（新 key 两处都加，`tests/unit/locales.test.ts` 锁对齐；语言包 `locales/*.json` 缺 key 回落英文）；守卫 `tests/unit/i18n-dead-keys.test.ts` 拦「加了没人引用的 key」（模板拼接的 `thinking.*` / `promptTok_*` 在白名单里）；
服务端 `pick(lang,zh,en,key?)`（key 全局唯一 `<模块>.<slug>`；多行 `getServerBlock`）；**工具定义提示词（description/promptSnippet/promptGuidelines）纯英文精简**，守卫 `tests/unit/tool-prompt-hygiene.test.ts`；notice 推 UI 用 `text`+`textEn` 双字段。
测试：端口 ≥8900 隔离；data-dir `mkdtempSync` 隔离；精确清理自己进程；**禁 `pkill -f`**；冒烟用例**不得自己 `npm run build`**（并行下互相踩 `dist/` 出假红），需要 dist 一律调 `tests/lib/ensure-build.mjs`（跑器开跑前已串行构建一次，CI 用 `--no-build`）。
Playwright：Chrome 路径走 `tests/lib/chrome.mjs`（`PI_WEB_CHROME` 可覆盖）；仓库根用 `fileURLToPath(new URL("..", import.meta.url))`（Windows 下 `URL.pathname` 会 ENOENT）；win32 清理走 `tests/lib/port-utils.mjs` 的 `freePort`。

## 6. 发布流程

> 详见 `docs/release.md`

```bash
npm run typecheck && npm run build
npm run changelog:i18n   # 文案有增减必跑
git add -A && git commit -m "feat(xxx): 描述"   # 不带 Co-authored-by
git push origin main
git tag vX.Y.Z && git push origin vX.Y.Z   # tag 带 v，与 npm 版本一致；Action 自动建 Release+桌面包
npm publish
```

版本须高于 registry；升级后 `pi-web-ui server restart`；发布前检查示例文件不泄密；Release 说明预览：`node scripts/release-notes.mjs X.Y.Z --base v<上版>`。

## 7. 常用环境变量

> 完整参数全表与高级配置见 `docs/env-vars.md`

| 变量                        | 默认                            | 作用                                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_WEB_PORT`               | `8787`                          | HTTP 端口                                                                                                                                                                                                                                                                    |
| `PI_WEB_HOST`               | `127.0.0.1`                     | 监听地址（默认 loopback）                                                                                                                                                                                                                                                    |
| `PI_WEB_CWD`                | `process.cwd()`                 | 智能体工作区                                                                                                                                                                                                                                                                 |
| `PI_WEB_DATA_DIR`           | `~/.pi-web`                     | 数据目录                                                                                                                                                                                                                                                                     |
| `PI_WEB_SDK`                | `global`                        | #321 起默认跟随：机器上有**更新**的 pi 副本（祖先链，如全局 pi CLI）就用它（多份取最高），没有或更旧回落自带副本；`bundled`/off/0/false/no = 强制自带（可复现，报 bug 用）。升级全局 pi 后**重启服务**即生效；更新面板会亮「运行中 vs 机器上」差距并提供「安装全局引擎」入口 |
| `PI_WEB_TOKEN`              | 空                              | 共享口令鉴权                                                                                                                                                                                                                                                                 |
| `PI_WEB_PLUGIN_CATALOG_URL` | 官方清单                        | 市场目录来源；空/`off`/`0`/`false`/`no` 关闭；`PI_WEB_PLUGIN_CATALOG_INSTALL=1` 才开机自动安装                                                                                                                                                                               |
| `PI_WEB_TOOL_TIMEOUT_MS`    | 20 分钟                         | 看门狗超时（`ask_user_question` 豁免）                                                                                                                                                                                                                                       |
| `PI_WEB_TOOL_LAZY_LOADING`  | `1`（开）                       | 工具延迟加载的**部署级默认**（设置页开关优先）：`0`/`false`/`off` = 全部工具直接活跃（见 `docs/tool-context-budget.md`）                                                                                                                                                     |
| `PI_WEB_PRESET_REPO`        | `xing-shuyin/pi-web-ui-presets` | 设置预设的社区共享仓库（`owner/name`）；`off`/`0`/`false`/`no` = 关闭一键分享（导入/导出仍可用），见 `docs/preset-sharing.md`                                                                                                                                                |
| `PI_WEB_PRESET_CATALOG_URL` | 仓库 `index.json` 的 raw 地址   | 「浏览分享」的列表来源；空串或 `off` = 关闭浏览；5 分钟缓存 + 刷新绕过，失败保留上次列表                                                                                                                                                                                     |
| `PI_WEB_PRESET_GH`          | `gh`                            | 一键分享调用的 GitHub CLI 路径（不可用时先试令牌 API，再回落「复制 JSON + 打开预填建 Issue 页」）                                                                                                                                                                            |
| `PI_WEB_PRESET_TOKEN`       | 空                              | 无 gh 时直连 GitHub API 的令牌（`PI_WEB_PRESET_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`）：有令牌就不需要 gh；不设也能用（预填页点一下 Submit）                                                                                                                                  |

## 8. 部署

> 详见 `docs/deployment.md`

- 前台：`pi-web-ui --port 9000 --cwd /path`
- 自启：`pi-web-ui server install`（macOS→launchd / Linux→systemd / Windows→登录 Run 键，免管理员）
- Docker：`docker compose up -d`

## 9. 现行有效开发禁令与避坑清单

以下规则由历史线上问题与核心架构硬约束提炼而成，编写代码时必须严格遵守：

### 1. 通信协议与数据安全

- **`details` 字段硬限制 ≤64KB**：下发与持久化会超限整包丢弃。新工具严禁塞入大块原始数据（参照 `present-files-tool.ts` 做摘录预算）；前端渲染必须支持无 details 降级（`present-items.ts`）。
- **服务端 URL 必须包裹 `appUrl()`**：包括 `/ws`、`/api/*`、`/plugins/*`、`/themes/*`，杜绝反向代理子路径部署时 404。
- **Token Cookie 校验前必须解码**：`pi_web_token` 经 `encodeURIComponent` 存储，服务端读取必须先 `decodeCookieToken` 再校验（`server/auth-cookie.ts`）。
- **工作区严禁使用家目录根**：禁止设置 `$HOME` 为工作区根，防止递归扫描坏挂载造成事件循环卡死。
- **远期定时器必须使用 `armDelay` 分片**：Node.js 中 `setTimeout` 超过 2^31-1 毫秒（约 24.8 天）会整型溢出被截断为 1ms 从而引发死循环。超过 6 小时任务必须分片（守卫：`plugin-cron-overflow-test.mjs`）。
- **文本解码与行号统计规范**：预览与附件统一使用 `decodeText`（UTF-8 → GBK → latin1）；`countLines` 不计末尾空行，前端需 pop 末尾空串。

### 2. 工具定义与提示词规范

- **工具提示词三处职责分离（严禁跨处复述）**：
  1. Tool Schema 的 `description`：仅描述“做什么与边界”，≤600 字符；
  2. 系统提示词中的 `promptSnippet`：仅写“何时触发”，≤80 字符，不带工具名前缀；
  3. `Guidelines` 段落的 `promptGuidelines`：仅写“调用顺序/禁令/跨工具路由”。
     _必须使用精炼纯英文，违规会被守卫单测拦截_（守卫：`tests/unit/tool-prompt-hygiene.test.ts`）。`edit` 工具提示词亦归本项目单源覆盖（`agent-service.ts`）。
- **工具延迟加载硬约束：绝不破坏前缀缓存**：
  供应商 Prompt Cache 依赖系统提示词前缀完全一致。系统提示词 `{{tools}}` 目录必须保持完整且不随已加载状态变化；新加载工具的要点随 `load_tools` 回执进入对话；注册表仅允许追加（`toolsAdded`），严禁就地修改或删除（守卫：`tests/lazy-tools-test.mjs`，文档：`docs/tool-context-budget.md`）。
- **单工具多执行路径必须提示词单源**：以 bash 为例，原生、终端和自适应分流路径共用 `server/tool-prompts.ts`，禁止在 execute 覆盖实现中硬编码或复制描述。
- **新增工具三处联动**：新增可开关工具必须同时登记到 `tool-manager.ts`（`AGENT_TOOL_CATALOG` 事实源）、`agent-service.ts`（`customTools` 列表）以及 `tests/unit/tool-registration.test.ts`；内置工具覆盖必须走 `tool-overrides.ts`。
- **逐工具文案可编辑机制**：用户自定义文案仅作为偏好存入 `toolPromptOverrides`，新增可配置维度必须同步打补丁逻辑、wire 协议与设置页编辑器三处（守卫：`tests/unit/tool-prompt-overrides.test.ts`）。

### 3. UI 布局与样式规范

- **CSS 变量必须先定义后引用**：未定义的 `var(--x)` 会导致整条 CSS 声明失效；内联代码前景色与背景色对比度必须 ≥2:1（守卫：`tests/unit/css-tokens.test.ts`、`theme-inline-code-contrast.test.ts`）。
- **长文本与长路径防溢出标准**：
  - 行容器（flex 容器）必须添加 `min-width: 0` 与 `max-width: 100%`；
  - 可断行文本（`.md` 内正文、路径）必须使用 `overflow-wrap: anywhere` 与 `word-break: break-word`；
  - 单行文本使用 `overflow: hidden` 与 `text-overflow: ellipsis`；
  - 高度受限列表必须声明 `overscroll-behavior: contain` 防止整页滚动条穿透（守卫：`tests/unit/text-wrap.test.ts`）。
- **卡头与操作按钮落点规范**：
  - 折叠卡头（`.chead`）右端**仅放置自身复制键**（`.chead-copy`，钉 `flex: none`），卡头内严禁悬挂消息级操作按钮；卡头提示文本设置 `flex: 0 1 auto` + `min-width: 0` 吸收缩放，窄屏下限制最大宽度，严禁用 `flex-wrap: wrap`。
  - 消息级操作栏（`.msg-actions`）仅对有正文的助手消息和用户消息生效；助手消息操作栏必须紧锚在最后一个正文块后，杜绝与工具卡分离。
- **UI 扩展点与浮层规则**：
  - 下拉菜单必须 Portal 到 `body` + `fixed` 布局，防止被父容器 `overflow` 截断；
  - 浮层统一使用 `useFloatingPanel`，禁止在 `scroll` 事件中强制关闭浮层（仅重算锚点，通过 mousedown/Escape 关闭）；
  - 侧边停靠栏（`SideDock`）为流内 flex 项目，浮动模式由 `sideDockFloat` 控制，严禁写死 fixed 遮挡侧边按钮。
- **输入框上方那条带子属于消息区**：快捷短语行只是浮在它上面，正文从芯片**之间**的缝里透出来（芯片本身是实底小卡片，压在正文上必须压得住字）。带子高度单源在 `.main` 的 `--composer-strip`（= `--composer-pad-top` + ChatInput 实测写入的 `--quick-row-h` + 6px）；改输入区上内边距或短语行留白必须同时顾三处：`.messages-wrap` 的负 margin、`.messages` 的底部留白、以及按容器底缘定位的 `.scroll-bottom` / `.qn-rail`（都要 `+ var(--composer-strip)` 回补），严禁把短语行改回 `position: absolute`（会与药丸/浮标抢同一条带子，折行时必叠）。守卫：`messages-behind-composer.test.ts`。
- **拖拽与触控交互标准**：
  - 图标编辑与拖拽必须监听 Pointer 事件，严禁使用 HTML5 DnD（移动端触屏不触发）；内置图标须在 `host-icon.tsx` 登记；菜单行文字统一 12.5px（守卫：`host-icon.test.ts`、`topbar-overflow-menu.test.ts`）。
  - 手机端横滑手势（`swipe-drawer.ts`）必须避开系统侧滑区，手势期间直写内联 transform 禁用动画过渡，松手后清理内联值交由 CSS 类过渡；移动端遮罩常驻（守卫：`swipe-drawer.test.ts`）。
- **新会话初始化交互**：切换或新建会话须经 `focusComposer()` 聚焦（触屏除外），非 chat 视图自动切回，待发附件 chips 随新会话清空（守卫：`composer-draft.test.ts`）。

### 4. 架构与运行态约束

- **目标模式 2.0 运行铁律**：主对话作为审查者，服务端另起落盘执行者；轮次、代次与停滞熔断全由服务端管控，严禁模型自行调用 wait/spawn；审查指令必须注入执行证据（`goal-evidence.ts`）；会话中止或关闭即停止循环，不得无限续轮（守卫：`goal-delegated.test.ts`、`goal-evidence.test.ts`，文档：`docs/goal-conversation-design.md`）。
- **审查者委派模式（Delegate Mode）**：开启后主对话只审不干，用户输入自动派发给常驻执行会话；闸门强制拦截写操作与子代理派发；计划模式优先级高于委派。
- **预设分享必须白名单严格净化**：导入外部 JSON 必须通过 `server/preset-share.ts` 白名单校验（`preset-fields.ts`），丢弃未知字段，执行 dryRun 确认，严禁未经校验直接摊入 `ClientSettings`（守卫：`preset-share.test.ts`，文档：`docs/preset-sharing.md`）。
- **Windows 最小化通知**：Windows 最小化时页面 visibility 状态不准确，必须通过窗口尺寸矩形判断（`isCollapsedWindow`）；通知禁止携带 `tag` 字段，防止被系统静默吞并。
- **模型目录官方整表替换**：通过 `patch-remote-catalog.ts` 幂等改写 SDK 目录，不残留旧定义，升级后自动重新应用。
- **DSH 运行态三规则**：shipped 预设使用 `preset-clones.ts` 的 file: 克隆隔离；问卷与过滤钩子挂 agent scope；统计指标吃直播帧与 assistant/message.usage（`dsh-usage.ts`）。
- **会话过户与状态迁移**：`take_over_conversation` 完整搬迁 runtime 本体，且**是事务性的**（源侧已摘、目标侧接入失败就原样搬回，绝不留「还在跑但没人持有」的幽灵会话，见 `#556` / `tests/takeover-rollback-test.mjs`）；**断连残骸的「另一处」行有宽限期**（`PI_WEB_OFFLINE_ROWS_TTL_MS`，默认 30 分钟，标 `ownerOffline`，仍可过户——手机 run 途中关页面后换设备仍能接管）；`ask_user_question` / `browser_page` 解析创建时的 session 对象（`bridgeTarget`）；跨页答复带 owner。
- **宿主提供的包只能声明在 `peerDependencies`（`"*"`）**：pi 扩展加载器只扫 `dependencies`（命中 `@earendil-works/pi-coding-agent` / `typebox` 就告警：嵌套副本会绕开加载器注入、搞出重复运行时模块）。本包同时是扩展与独立服务端，服务端子进程真要这两个包（`PI_WEB_SDK=bundled` 也要自带副本）→ 落在 `optionalDependencies`（npm 默认照装）。守卫 `tests/unit/extension-host-packages.test.ts`。
- **布局页改名 / 插件 `arrange.label` 必须落到渲染层**：合并引擎对「显式指定的文案」置 `UiSlotEntry.labelExplicit`；内置条目（顶栏按钮、底栏数值徽标）一直画写死的 i18n 与实时数值，只有旗立着时才让位（名字型顶掉内置文案；数值型把名字插在数值前，不吞实时数据）。只在设置页生效 = 假承诺（`#555`，守卫 `tests/unit/bar-item-unified.test.ts`）。
- **插件修改必须递增版本号（Bump Version）**：内置官方插件（`plugins/<id>/`）凡修改了代码/功能/静态资源（非纯文档），必须同步递增 `manifest.json` 中的 `version`（若有 `package.json` 的 `version` 须保持一致）。原因：随包热同步（`syncBuiltinPlugins`）与更新器（`plugin-updater`）均以 `compareVersions(srcVer, tgtVer) > 0` 作为升级判定的唯一权威事实源；若漏改版本号，老用户更新主程序后数据目录中的旧插件代码永远不会被热更新覆盖，导致缺陷滞留（守卫：`tests/unit/plugin-version-bump-guard.test.ts`）。
- **国际化字面量要求**：`i18n.tsx` 的词条值必须使用字符串字面量（仅允许 `+` 拼接），确保 `scripts/i18n-diff.mjs` 静态解析器正常运行。

### 5. 提交前三连验（防 CI 失败铁律）

任何修改在提交 PR 或交付前，**必须依次通过以下三道硬验证**：

1. `npx prettier --write <改动文件>`：确保代码风格符合 Prettier 规则（CI 第一步硬门禁）；
2. `npm run typecheck`：确保全项目 5 个 tsconfig 零类型错误（编写单测 mock 上下文严禁传裸 `{}`，必须使用 `{} as any` 避免 TS2740）；
3. `npx vitest run <相关单测>`：确保改动模块所有单元测试全部通过。

---

_结构/流程变更时同步更新本文件及相关 `docs/`。修改后运行 `/reload` 生效。_
