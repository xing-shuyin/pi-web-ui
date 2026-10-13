# 开发工作流

## 常用命令

```bash
npm run dev          # 并行：node --watch --import tsx 后端(:8788，dev:server 脚本，cross-env 固定 PI_WEB_PORT=8788，
#                     避开全局 pi-web-ui 的默认 :8787) + vite 前端(:5173，代理 /ws 到 :8788)。
#                     注意：不要用 `tsx watch` 起后端——它在 Windows 下、stdio 为管道（concurrently 的 spawn 方式）
#                     时会静默挂死（tsx 上游 bug），改用 Node 原生 --watch。
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run check:protocol  # 守护协议单源 shim 机制（CI 必跑）
npm run format       # prettier 全仓库格式化（.prettierrc.json：tabs + 宽 120；提交前必跑）
npm run format:check # 只检查不改写（CI 跑这个）
npm run build        # build:web (vite) + build:server (tsc) + build:dsh-runtime + build:mermaid-vendor + build:runtrace-vendor
npm start            # 跑编译产物 dist/server/index.js（生产）
npm test             # vitest 纯函数单测（tests/unit/，毫秒级零 token）
npm run test:smoke   # 零 token 协议冒烟聚合跑器（tests/run-smoke.mjs，82 个自包含测试；--core 只跑 PR 快检子集；--no-build 跳过套件前的构建）
npm run test:freeze  # 冻结/重连回归测试（Playwright，需要本机 chromium headless）
```

## CI

GitHub Actions ubuntu-latest（`.github/workflows/ci.yml`，push/PR → main 触发）：`format:check → lint → check:protocol → typecheck → build → build:extension → pack:extension → vitest → test:smoke`。

冒烟清单（tests/run-smoke.mjs 的 ALL，82 个）只收**自包含、零 token、跨平台**的测试；attach 型（需外部 server）、需真模型、平台相关的脚本不进 CI，本地手动跑（分类见 run-smoke.mjs 头部注释）。

冒烟分层（CI 提速）：PR 跑 `--core` 快检子集（CORE，协议/安全/插件接线代表，2~4 分钟），push main + 每日 nightly（北京时间午夜）跑全量；`--retry-once` 让首轮失败重跑一次（标 FLAKY，重跑还挂才算真失败）。新测试默认进 ALL，跑得快（<20s）且稳才进 CORE（有 ALL↔CORE 同步守卫）。

`dist/` 由跑器在开跑前**串行构建一次**（CI 已在 Build 步骤构建过，可用 `--no-build` 跳过）。用例侧一律走 `tests/lib/ensure-build.mjs`，**不要**自己 `execSync("npm run build")`：默认 4 worker 并行下，一个用例重写 `dist/` 时另一个正在 `spawn dist/server/index.js`，会出「测试插件没被激活」之类与被测逻辑无关的假红。

## 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **i18n**：所有用户可见字符串走 `useT()`；改 `i18n.tsx` 必须同时给 `zh`/`en` 两个内置 locale 各加一个 key（`en` 的类型是 `Record<keyof typeof zh, string>`，漏一个会编译报错，这是特性不是 bug）。另外 `locales/*.json` 的 9 个可下载语言包（de/es/fr/it/ja/ko/pt/ru/zh-TW）也要同步加 key 且顺序与 `zh` 一致——`tests/unit/locales.test.ts` 锁这条对齐。zh-TW（繁中）不手改：跑 `scripts/zh-tw-locale/`（README 有步骤）从简中整份重新生成。
- **通知文案**：服务端 notice 写中文 `text` + 英文 `textEn`（客户端按 locale 二选一；中英双语字段，见 `ChatInput` 的 `description`/`descriptionEn` 先例）。发给模型的提示保持中文。
- **样式**：全部在 `styles.css`，按 `/* ---- 组件名 ---- */` 分区；颜色用 CSS 变量（`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--amber`、`--green`、`--red`）。新写/改名变量前先确认它**真有定义**：引用未定义的自定义属性按规范是 guaranteed-invalid，整条声明在计算值阶段失效（不带 fallback 的 `background` 直接没背景、`box-shadow` 连投影一起丢；带 fallback 的静默用硬编码值 → 浅色主题下是深色块）。`tests/unit/css-tokens.test.ts` 静态体检全仓 `var()` 引用，新增变量后跑一次。
- 文件列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `files-service.ts` 顶部维护（分平台两套）。
- **lint（oxlint）**：`npm run lint` 必须零警告；`lint:fix` 只修机械项。`.oxlintrc.json` 关掉的三条是故意：`no-control-regex`（文件名清洗正则）、`unicorn/no-new-array` 与 `typescript/no-this-alias`（oxlint 忽略行内 disable 注释，改写法反而伤可读性）。广播循环的 `[...set]` 拷贝是故意的（处理器可能在 emit 中途退订），行内有注释，别“优化”掉。
- **工具提示词（发给模型的工具定义）三处职责严格分开**：`description` = 做什么 + 副作用/边界；`promptSnippet` = 触发条件（进系统提示词 `Available tools` 列表，渲染为 `- name: snippet`，所以不写工具名前缀，≤80c）；`promptGuidelines` = 何时用 / 顺序 / 禁止 / 跨工具路由。**同一条信息只说一遍**：snippet 不复述 description、guideline 不复述 description、参数说明不复述主描述；同一个 schema 块（如 SSH 凭据、连接/库参数）被多个工具用时抽共享常量（所有工具 schema 同时在上下文里，重复就是纯浪费）。操作语法参考类工具（`patch-tool`）的 op 表是唯一文档位，不拆。守卫 `tests/unit/tool-prompt-hygiene.test.ts`（CI 必跑）：纯英文 + 长度上限 + snippet 前缀/复述检测 + 同文件同义重复检测。
- **两种实现共用一套提示词时必须单源**：同一个工具有多条执行路径（如 bash 的原生/终端/分流）时，模型看的定义只应来自一个模块（`server/tool-prompts.ts`），分流器只覆盖 `execute`。被覆盖的那份仍会被无意识地维护——它永远不发送，只会漂移。
- 新增协议消息 → 只改 server/protocol.ts（见 `docs/architecture-core.md`「协议单源」），再在两端 dispatch/onmessage switch 各加分支。
- **宿主提供的包只能声明在 `peerDependencies`（`"*"`）**：pi 扩展加载器（`resource-loader.js` 的 `collectExtensionPackageWarnings`）只扫 `dependencies` —— 命中 `@earendil-works/pi-coding-agent` / `typebox` 就警告「装下的嵌套副本会绕开扩展加载器、搞出重复运行时模块」。本包同时是「pi 扩展」与「独立服务端/CLI」，服务端子进程真的要这两个包（`server/` 下 typebox 20+ 处引用、SDK 遍布全仓），`PI_WEB_SDK=bundled` 也需要自带副本 → 它们落在 `optionalDependencies`（npm 默认照装，加载器不看这个字段；见 `package.json`）。守卫：`tests/unit/extension-host-packages.test.ts`（谁搬回 `dependencies` 就红）。

## 斜杠命令目录

服务端 `pushSlashCommands()` 收集当前活动会话的扩展命令（`session.extensionRunner.getRegisteredCommands()`）+ 模板（`promptTemplates`）+ 技能（`resourceLoader.getSkills()` → `skill:<name>`）加上 11 个内置命令（NATIVE_COMMANDS：/new /name /model /compact /cwd /thinking /resume /reload /help /copy /pi-web-ui:quit），经 `slash_commands` 消息推送（attach / set_cwd / new_chat / switch_conversation / switch_session / get_commands 时刷新）；内置命令在 `prompt()` 里拦截（`execNativeCommand`，含 /model 模糊匹配、/thinking 中英别名、`/reload` 调 `session.reload()` 重新发现扩展/技能/模板后重推目录），其余透传 SDK（SDK 会展开扩展/技能/模板命令）。

注意 SDK 的 `getSkills()` 返回的是会话创建时的内存快照——删除/新增 skill 文件后必须 `/reload`（或 /new / 切项目重建 runtime）才生效。改动时保持 `NATIVE_COMMANDS` 与 `execNativeCommand()` 同步。回归：`slash-commands-test.mjs`。

## 验证清单

1. `npm run typecheck` 零错误
2. 涉及 UI → `npm run dev` 手动过一遍交互
3. 涉及 ws 协议 → `tests/` 下有现成脚本可参照：先跑 `npm run test:smoke`（自包含协议测试全量），单个用 `node tests/xxx-test.mjs`（需先 `npm run build`；浏览器 E2E 需要本机 Chrome，路径由 `tests/lib/chrome.mjs` 逐平台探测，`PI_WEB_CHROME` 可覆盖）

## 测试规范

### 全局 vs 本地

用户日常可能正用**全局安装**的 `pi-web-ui`（`npm root -g` 下的 `pi-web-ui`，默认端口 `8787`）跑着对话/工作。开发改造对象永远是**本地仓库**（clone 下来的 pi-web-ui 目录）。用户会在自己测试时手动关闭全局 dev、切到本地。

**绝对不要杀全局进程/占 8787**：禁止 `pkill -f "dist/server/index.js"`——它会命中全局 server（端口 8787），把用户正在用的会话打断。清理只针对**自己启动的测试 server**。

### 隔离端口

每个 `*-test.mjs` 用独立端口（≥8900，避开 8787/5173/3300），并在启动 server 前先 `lsof -ti :PORT -sTCP:LISTEN` 确认空闲；若被占，改端口而非硬杀。

### 精确清理自己起的进程

spawn 后记录 `server.pid`，测试收尾（含异常 catch 路径）用 `process.kill(pid, 'SIGTERM')` 只杀自己启动的。多开几个 server 时用各自 PID 逐个杀，别用宽泛模式匹配。

### data-dir 隔离

测试 server 设 `PI_WEB_DATA_DIR` 为 `mkdtempSync(tmpdir…)`，`PI_WEB_CWD` 指本地仓库——避免污染真实 user data / client-state / session。

### 自包含 vs 外部依赖

能进 `tests/run-smoke.mjs` 清单的测试必须**自起 server + 自清理**；不进清单的分两类（原因写在 run-smoke.mjs 头部注释）：

- ①attach 型需外部已运行 server——ws-session-test / file-upload-test / image-paste-test / commands-test(8791) / edit-reask-test / projects-test
- ②需真模型——goal-abort-test / goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test / tool-status-test（title-jsonl-test 已修复可本地跑；win32 下 terminal-smoke / restart-handoff 自动跳过）

### 需要真模型/走审查调研的（goal-*, wizard）

会真实调用 LLM、耗 token 且依赖本机模型（opencode-go 可能慢/卡）——写测试时区分「协议冒烟（无 token，如 goal-test/goal-prefs 的 set/clear 轮序）」和「live（真调用）」两类，避免误以为功能坏。

### 验证项

每改完一版，`npm run check:protocol` + `npm test` → 本地 server（隔离端口+独立 data-dir）→ 对应 `tests/*-test.mjs` 或 `npm run test:smoke` → `npm run typecheck` → 涉及 UI 再用 `playwright` 浏览器测试（chromium 由 `tests/lib/chrome.mjs` 逐平台探测，`PI_WEB_CHROME` 可覆盖）。

### 测试家族速查

| 测试组                 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **goal 家族**          | `goal-test`=协议冒烟；`goal-prefs-test`=偏好持久化；`goal-pill-test`=GoalBar UI；`goal-rounds-test`=最大轮数输入；`goal-autostart-test`=自动触发生成；`goal-abort-test`=Stop 清除 goal；`goal-wizard-test`=问卷收敛；`goal-wizard-cancel-test`=调研取消/超时；`goal-review-loop-test`=锁定+无限轮数审查循环（需真模型）                                                                                                     |
| **settings 家族**      | `settings-test.mjs`（端口 8931）：设置面板协议冒烟——settings_state 推送 / get_settings / set_settings / save_preset / apply_preset / delete_preset / 重连持久化                                                                                                                                                                                                                                                             |
| **global-search 家族** | `global-search-test.mjs`（端口 8962）=search_files 协议冒烟；`global-search-ui-test.mjs`（端口 8963）=真 Chrome headless UI 测试                                                                                                                                                                                                                                                                                            |
| **scm 家族**           | `scm-features-test.mjs`=SCM v2 功能协议测试（懒加载 history / 远程分支 / git-dir watcher）；`scm-test.mjs`=SCM 面板 E2E（真 Chrome headless）                                                                                                                                                                                                                                                                               |
| **其他**               | `lazy-window-test.mjs`=消息列表惰性窗口化 E2E；`terminal-bash-test.mjs`=终端接管 bash 回归；`quiesce-test.mjs`（端口 8911）=安全加固冒烟；`fetch-models-test.mjs`（端口 8955）=模型列表自动获取；`clone-provider-test.mjs`（端口 8965）=内置供应商复制；`model-config-ui-test.mjs`=模型管理 UI（真 Chrome）；`vision-bridge-test.mjs`（端口 8945）=视觉桥端到端；`vision-bridge-ui-test.mjs`=视觉桥设置面板 UI（真 Chrome） |

**Playwright 脚本**：Chrome 路径不再写死——`tests/lib/chrome.mjs` 逐平台探测（`PI_WEB_CHROME` 可覆盖）。跨平台两条硬规则：① 脚本里取仓库根用 `fileURLToPath(new URL("..", import.meta.url))`，`URL.pathname` 在 Windows 上是 `/E:/...`，`spawn` 的 cwd/脚本参数都会 ENOENT；② 服务端进程清理在 win32 用 `tests/lib/port-utils.mjs` 的 `freePort(port)`（Windows 没有负数 PID 的进程组，`process.kill(-pid)` 静默失败会留下监听进程）。

**测试脚本里禁止在 try 块内直接 `process.exit`**：`process.exit` 会跳过 `finally`，spawn 的 server 永远不会被杀 → 每次运行泄漏一个进程，下次跑同端口测试报 "port busy — abort"（steer-queue-smoke 踩过，已修：设 ok 标志 + finally 里杀进程并等端口释放再 exit）。
