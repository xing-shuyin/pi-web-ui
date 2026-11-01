# 开发工作流

## 官方供应商

普通安装及便携版共用模型管理的官方 API 快速配置入口，协议、端点、地区与维护边界见 [官方供应商接入](official-providers.md)。

## 提示词模板命令

模板编辑器可设置可选命令（例如 `/pr`），正文用 `{{input}}` 标记参数插入位置。发送 `/pr 798` 时，输入框将所有占位符替换为 `798` 后发送；无占位符则将参数追加到正文末尾。支持多行参数，不递归展开；已有系统、扩展、技能和插件命令优先，同名模板命令不接管它们。

自定义模板、内置覆盖和移出标记保存在服务端 `<dataDir>/prompt-templates.json`，通过已鉴权的 `/api/prompt-templates` 读取与逐条修改，原子提交成功后才更新界面。切回浏览器窗口时刷新列表。旧 `localStorage` 模板自动迁移，服务端同 ID 条目优先，迁移成功后删除浏览器旧数据；失败时保留并显示错误。

## 上下文用量明细

顶栏、底栏与侧栏的上下文徽标均可点击展开明细，显示已用比例、分类占用条和剩余空间。再次点击、点击外部或按 Esc 关闭；滚动只更新定位，切换对话或引擎会关闭面板。面板通过 `useFloatingPanel` 定位并 Portal 到 `body`，适配浅色、深色主题及窄屏。

pi 引擎在 `stats.contextUsage.categories` 中提供分类估算：系统提示词、记忆文件、工具、技能、工具调用与结果、消息、其他。基础开销沿用设置面板的实际模板、覆盖、禁用项和工具 schema；消息按当前模型上下文估算，不读取浏览器分页转录。分类随 250ms 统计缓存更新，并按权威总用量分配整数 token，差额归入「其他」，不改变原有总量与压缩判定。分类是会话内容估算，不是供应商返回的实际请求分类；请求视图中的精确去重、证据外置及扩展转换可能改变占比，按总量校准不能使各分类变成精确计费数据。消息缓存只复用最后一条之前的稳定前缀，末条在 SDK 异步扩展替换后须重新估算。只提供总量的引擎显示已用和剩余空间。配置软上限时，面板与徽标使用相同分母，并另外列出软上限和模型容量。

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

## 前端构建更新与旧页面

`web/vite.config.ts` 不清空整个输出目录；`web/build-assets.ts` 在构建成功后保留当前与上一轮的 assets，并清理更早的文件，避免已打开页面在首次打开文件预览、设置等面板时请求已删除的懒加载模块。`.build-assets.json` 记录当前一轮资源；首次迁移时把已有 assets 作为上一轮保留。完整替换安装目录仍可能失去旧资源。

`web/src/chunk-recovery.ts` 统一处理 Vite preload 错误与根错误边界中的模块加载失败，通过 sessionStorage 记录恢复次数：同一构建最多自动刷新一次，跨构建至少间隔一分钟；持久错误或存储不可用时保留手动重试界面，避免循环刷新。一般应用异常不会触发自动刷新。

## 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **i18n**：所有用户可见字符串走 `useT()`；改 `i18n.tsx` 必须同时给 `zh`/`en` 两个内置 locale 各加一个 key（`en` 的类型是 `Record<keyof typeof zh, string>`，漏一个会编译报错，这是特性不是 bug）。另外 `locales/*.json` 的 12 个可下载语言包（de/es/fr/it/ja/ko/pt/ru/tr/zh-Hant/zh-HK/zh-TW）也要同步加 key 且顺序与 `zh` 一致——`tests/unit/locales.test.ts` 锁这条对齐。繁中系语言包不手改：跑 `node --import tsx scripts/zh-tw-locale/build-all.mjs .`（详见 `scripts/zh-tw-locale/README.md`）一键从简中整份重新生成。
- **通知文案**：服务端 notice 写中文 `text` + 英文 `textEn`（客户端按 locale 二选一；中英双语字段，见 `ChatInput` 的 `description`/`descriptionEn` 先例）。发给模型的提示保持中文。
- **样式**：全部在 `styles.css`，按 `/* ---- 组件名 ---- */` 分区；颜色用 CSS 变量（`--bg-elev*`、`--border*`、`--text*`、`--accent*`、`--amber`、`--green`、`--red`）。新写/改名变量前先确认它**真有定义**：引用未定义的自定义属性按规范是 guaranteed-invalid，整条声明在计算值阶段失效（不带 fallback 的 `background` 直接没背景、`box-shadow` 连投影一起丢；带 fallback 的静默用硬编码值 → 浅色主题下是深色块）。`tests/unit/css-tokens.test.ts` 静态体检全仓 `var()` 引用，新增变量后跑一次。
- 文件列表 `IGNORED_ENTRIES`（node_modules/.git/dist 等）在 `files-service.ts` 顶部维护（分平台两套）。
- **lint（oxlint）**：`npm run lint` 必须零警告；`lint:fix` 只修机械项。`.oxlintrc.json` 关掉的三条是故意：`no-control-regex`（文件名清洗正则）、`unicorn/no-new-array` 与 `typescript/no-this-alias`（oxlint 忽略行内 disable 注释，改写法反而伤可读性）。广播循环的 `[...set]` 拷贝是故意的（处理器可能在 emit 中途退订），行内有注释，别“优化”掉。
- **工具提示词（发给模型的工具定义）三处职责严格分开**：`description` = 做什么 + 副作用/边界；`promptSnippet` = 触发条件（进系统提示词 `Available tools` 列表，渲染为 `- name: snippet`，所以不写工具名前缀，≤80c）；`promptGuidelines` = 何时用 / 顺序 / 禁止 / 跨工具路由。**同一条信息只说一遍**：snippet 不复述 description、guideline 不复述 description、参数说明不复述主描述；同一个 schema 块（如 SSH 凭据、连接/库参数）被多个工具用时抽共享常量（所有工具 schema 同时在上下文里，重复就是纯浪费）。操作语法参考类工具（`patch-tool`）的 op 表是唯一文档位，不拆。守卫 `tests/unit/tool-prompt-hygiene.test.ts`（CI 必跑）：纯英文 + 长度上限 + snippet 前缀/复述检测 + 同文件同义重复检测。
- **两种实现共用一套提示词时必须单源**：同一个工具有多条执行路径（如 bash 的原生/终端/分流）时，模型看的定义只应来自一个模块（`server/tool-prompts.ts`），分流器只覆盖 `execute`。被覆盖的那份仍会被无意识地维护——它永远不发送，只会漂移。
- 新增协议消息 → 只改 server/protocol.ts（见 `docs/architecture-core.md`「协议单源」），再在两端 dispatch/onmessage switch 各加分支。
- **宿主提供的包只能声明在 `peerDependencies`（`"*"`）**：pi 扩展加载器（`resource-loader.js` 的 `collectExtensionPackageWarnings`）只扫 `dependencies` —— 命中 `@earendil-works/pi-coding-agent` / `typebox` 就警告「装下的嵌套副本会绕开扩展加载器、搞出重复运行时模块」。本包同时是「pi 扩展」与「独立服务端/CLI」，服务端子进程真的要这两个包（`server/` 下 typebox 20+ 处引用、SDK 遍布全仓），`PI_WEB_SDK=bundled` 也需要自带副本 → 它们落在 `optionalDependencies`（npm 默认照装，加载器不看这个字段；见 `package.json`）。守卫：`tests/unit/extension-host-packages.test.ts`（谁搬回 `dependencies` 就红）。

## 文档约定：AGENTS.md 只做索引

`AGENTS.md` 是「关键功能 → 事实源文件 → 文档」的映射表，**不承载细则**（细则写进对应 `docs/`）；`docs/README.md` 是文档总索引（每份文档的主题、权重 ★★★/★★/★/○ 与「按场景阅读路线」）。新增做法：

1. 细则写进 `docs/agent-rules.md`（协议/工具提示词/UI 样式/运行态红线）或对应主题文档；
2. 在 `docs/README.md` 对应权重组补一行，并在 `AGENTS.md` 的映射表补一行（功能 / 事实源文件 / 文档链接），必要时在 §3 红线表补一行 + 守卫测试名；
3. 跑 `npx vitest run tests/unit/agents-md.test.ts tests/unit/docs-index.test.ts`：前者守卫 `AGENTS.md` 体量（≤150 行 / ≤20KB）、`docs/` 链接与锚点存活、关键文档仍在索引中、§3 点名的守卫测试文件存在、映射里点名的源文件存在；后者守卫 `docs/README.md` 覆盖全部 `docs/*.md`、链接与锚点存活、每份文档都登记在带权重的分组里。

历史上它曾因把设备中心/群组、画布、环境变量全表、UI 红线抄成正文而胀到 51KB / 281 行，每个会话都在为细则付费且细节逐渐与 `docs/` 走样，故改为索引形态（全文备份 `AGENTS.md.bak`）。

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

### 单测并发与浏览器等待

`vitest.config.ts` 将 worker 上限设为 4，避免全量测试中的 Chrome、文件扫描与子进程争用 runner 资源。浏览器启动预算应独立于业务断言；跨 frame 的消息、URL 或 DOM 更新须等待对应可观察状态，不以另一个异步事件完成代替目标状态已更新。

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
