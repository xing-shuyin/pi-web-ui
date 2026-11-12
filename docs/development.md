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
npm run dev:totp     # 本地 TOTP 测试站（http://127.0.0.1:8791，测内置浏览器「TOTP 验证器」的扫码/自动匹配/填码，见下文「TOTP 测试站」）
npm run typecheck    # 双端 tsc --noEmit（提交前必跑）
npm run check:protocol  # 守护协议单源 shim 机制（CI 必跑）
npm run ci:local     # 本地按 ci.yml 逐条复刻 CI 门禁（见下文「本地复刻 CI」；--profile static 秒级）
npm run hooks:install # 装 pre-push 钩子（默认跑 ci:local 的 static 档）
npm run format       # prettier 全仓库格式化（.prettierrc.json：tabs + 宽 120；提交前必跑）
npm run format:check # 只检查不改写（CI 跑这个）
npm run build        # build:web (vite) + build:server (tsc) + build:dsh-runtime + build:mermaid-vendor + build:runtrace-vendor
npm start            # 跑编译产物 dist/server/index.js（生产）
npm test             # Vitest 快池（快慢分层见下文「两个池」，≈180s）
npm run test:changed # 开发回路：只跑受 Git 改动影响的文件（改叶子模块时几秒~几十秒）
npm run test:integration # 重型集成池：真 git / 真子进程 / 真 Hub（≈170s）
npm run test:all     # 两池都跑（提交前/CI 的完整门禁）
npm run test:smoke   # 零 token 协议冒烟聚合跑器（tests/run-smoke.mjs，82 个自包含测试；--core 只跑 PR 快检子集；--no-build 跳过套件前的构建）
npm run test:freeze  # 冻结/重连回归测试（Playwright，需要本机 chromium headless）
```

Electron 相关依赖（`electron` / `electron-builder` 的二进制）走 npmmirror：打包命令（`desktop:dist`、`desktop:portable*`）已由 `scripts/run-electron-builder.mjs` 自动注入 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（默认值见 `scripts/lib/electron-mirror.mjs`）。这些镜像**禁止**写进 `.npmrc`——npm 11 会对自定义键告警，npm 12 起不再透传。首次 `npm install` 要下载 Electron 二进制，国内网络请先自带 `ELECTRON_MIRROR` 环境变量。

## 更新本地桌面 app（macOS）

改完浏览器/服务端代码，要让 `/Applications/pi-web-ui-desktop.app` 用上新包：

```bash
npm run build && npm run build:desktop
node scripts/run-electron-builder.mjs -c desktop/electron-builder.yml --dir   # 只出 release/mac-arm64/*.app
node scripts/update-local-app.mjs --dry-run   # 体检：产物在不在、已装的是不是同一份
node scripts/update-local-app.mjs            # 退出 app → 备份 → 替换 → 重新打开
```

- 安装包用 `--dir` 就够，不必走 `desktop:dist`（那会额外做 dmg + zip，几分钟起步）。
- 脚本幂等：已装包与产物指纹一致就直接退出；有锁/有别的实例在跑也退出。
- 备份只留一份（`/tmp/pi-web-ui-desktop.app.bak`），替换失败自动回滚；日志追加到 `/tmp/pi-app-update.log`。
- **不要**把它挂到 `launchctl`/守护进程下：launchd 会在脚本退出后重新拉起，形成「退出 app → 替换 → 重开」的无限循环（真实踩过）。要延后用 `--delay 30` 或 `nohup … &`，日志里不要用 `>` 截断。
- 会话服务端跑在 app 里（`:8790` 那个子进程），所以替换会中断当前对话的运行，历史已落盘、重开后继续。

## 命令执行防卡死

两条入口，职责不重叠：

| 场景                                 | 用哪个                                                 | 为什么                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 产品内（任意用户项目）跑长驻服务     | `bash({ background: true })`（`server/job-runner.ts`） | 进程挂在 server 里，prompt 立刻返回 job id + 日志路径，顶栏「后台任务」面板可见可停；不依赖 `scripts/`，npm / 桌面安装版天然可用 |
| 源码仓库 / CI / 人工终端跑一次性命令 | `scripts/safe-exec.mjs`                                | 调用方不常驻，靠 `--detach` 守护进程 + jobfile 三件套（`.pid`/`.state.json`/`.cursor`）托管                                      |

`background: true` 的 timeout 语义与前台**故意不同**（`server/bash-timeout.ts` 分两条归一）：前台缺省 120s、上限 3600s；后台缺省 / 传 0 = **不限**，显式正数才计时（上限 7 天，仅防手滑）。所以起 FastAPI 这类服务不会被“默认 120s”杀掉。日志落 `<dataDir>/jobs/<id>-<slug>.log`，任务结束（正常退出 / 超时 / 空闲 / 被停 / 起不来）会发一条通知，有对话归属时还会补一条系统消息。

`scripts/safe-exec.mjs` 是跨平台（Windows / macOS / Linux）的命令执行器，给 AI、CI 和人工终端共用。它治的是五类挂死：子进程 **stdin 接到空设备**（交互确认、pager、REPL 一律读到 EOF）、**硬超时 + 空闲超时**（连续 N 秒无任何输出判静默卡死）、**杀整棵进程树**（`server/process-utils.ts` 的 `killPidTree` 为单源：Win `taskkill /T /F`，Posix `kill(-pgid)`）、**原始输出先落盘只回显尾部**、**跨平台轮询**（`--wait` 在 Node 里计时，不拼 `sleep` / `&&` / `$?`）。

```bash
node scripts/safe-exec.mjs --timeout 60 -- npx vitest run tests/unit/foo.test.ts   # 短任务：单测/lint/typecheck
node scripts/safe-exec.mjs --timeout 600 --log .safe-exec/build.log -- npm run build # 长构建：必带 --log
node scripts/safe-exec.mjs --detach --timeout 1800 --idle-timeout 300 -- npm run build # >3 分钟：托管，立即返回
node scripts/safe-exec.mjs --wait .safe-exec/20260101T000000-npm-run-build.pid --wait-sec 10 --json  # 轮询
node scripts/safe-exec.mjs --status .safe-exec/20260101T000000-npm-run-build.pid --json              # 立即查
node scripts/safe-exec.mjs --kill .safe-exec/20260101T000000-npm-run-build.pid                      # 终止
```

`--detach` 起的是 **detached 守护进程**（内部模式 `--supervise`）：它自己每秒巡检空闲时长与总时长并强杀，**不依赖 AI 来轮询**——AI 崩了、终端关了，到点照样清场。父进程只写 job 规格就退出，**不持有日志句柄**（Windows 上正是这一步带来 `EBUSY` 和退出挂住）。Job 三件套：`.pid`（规格，一次性写）、`.state.json`（状态/终态）、`.cursor`（增量游标，供 `--wait` 只回新输出）。

状态机：`RUNNING` / `SUCCESS` / `FAILED` / `TIMEOUT` / `IDLE_TIMEOUT` / `KILLED` / `ENOENT` / `ABORTED`（守护进程被外部杀掉，或看门狗 8s 宽限后子进程仍未死 → 终态也可能是 `ABORTED`，先 `--kill` 再重跑）/ `UNKNOWN`。`--json` 输出 `status` / `exitCode` / `reason` / `elapsedSec` / `idleSec` / `childAlive` / `terminal` / `orphanAlive` / `pipesForced` / `newOutput` / `next`（`next` 就是下一条该跑的命令）。

`--status` 是**只读观测者**（只算增量、不推进 `.cursor`），`--wait` 才是消费者（推进游标）：前者可以随手反复调，不会偷走主循环的输出。子进程已退出但孙进程仍持有输出管道时，`--wait` 会先等 1.5s 排空，随后强拆管道并自行结算，标 `pipesForced: true`（旧实现会一直等到硬超时）。

退出码约定：`0` 成功、`124` 硬超时或空闲超时（**不许原样重试**，先读日志定位卡点再改分档）、`127` 命令不存在、`2` 用法错误，其余透传真实退出码。日志默认落 `.safe-exec/`（已 gitignore），可用 `--log` 指定。`--stream` 把输出实时 echo 到终端（给人看），默认只落盘 + 尾部 40 行。`--idle-timeout` 默认关闭：构建/类型检查本来就可能长时间安静，只有确认「正常运行必有心跳输出」的任务才开。

`--kill` 先杀子进程树（Posix 的 `-pid` 只对进程组组长有效），再收守护进程；只有子 PID 还没发布时才退化为单杀守护进程并明确告警。`ABORTED` 且子进程仍活的任务不会被当成「已结束」跳过，`--kill` 会继续清场并把终态改写成 `KILLED`。

Windows 上 `npx` / `npm` / `pnpm` / `yarn` 是 `.cmd` 垫片，直接 `spawn` 会 ENOENT：执行器会按 `PATHEXT` 解析，只有命中 `.cmd` / `.bat` 才转 cmd.exe（相对路径自动还原成反斜杠绝对路径），其余命令保持直连 spawn，不经 shell。

时限分档：单测/lint/typecheck 60 秒、全量构建 600 秒、预计 >3 分钟一律 `--detach` 托管；AI 的单次 bash 调用另有 pi 工具层 `timeout` 参数与会话看门狗兜底，三者不重叠也不互相替代。

**不要再手写 `timeout 60s` / `nohup ... &` / `ps -p` / `sleep 5` 前缀**：Windows 上 `timeout` 是「等待按键 N 秒」的 `timeout.exe`（语义正好相反），`nohup`、`ps -p`、`sleep` 的 cmd / PowerShell / bash 语法各不相同；空设备也不是一个名字（`/dev/null` vs `NUL`），`$?` 三元语法同样不通用。跨平台只能由 Node 包装器统一：等待用 `--wait`，查状态用 `--status --json`，终止用 `--kill`。

`--shell` 只在命令必须整行交给 shell 时用（`--shell "<整行命令>"`，必要时配 `--shell-bin`）。`--shell-bin auto` 在 Windows 下优先探测真 Git Bash（`C:\Program Files\Git\bin\bash.exe`），类 Unix 用 `bash -c`，因此 `cd /e/pi-web-ui && ...` 这类 POSIX 路径才不会被 `cmd.exe` 认错盘符；解释器也可以是 `powershell` / `pwsh`（走 `-NoProfile -NonInteractive -Command`）。

## CI

GitHub Actions ubuntu-latest（`.github/workflows/ci.yml`，push/PR → main 触发）拆成四个并行 job：

| job           | 内容                                                                                                                            | 说明                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `checks`      | `format:check → lint → check:protocol → i18n:check → typecheck → build → 插件 bundle 未漂移 → build:extension → pack:extension` | 全部秒级步骤，合成一个 job 避免反复装依赖                                                                             |
| `unit`        | `vitest run --shard=i/8`（i=1..8）                                                                                              | 单测 1047 文件 / 12000+ 条，单机要 6.5 分钟，是整个流程的瓶颈，分片后壁钟降到约 1/8；`fail-fast: false`，一片红不连坐 |
| `integration` | `npm run test:integration`                                                                                                      | 重型池（真 git / 真子进程 / 真 Hub）本来就是串行跑更稳                                                                |
| `smoke`       | `node tests/run-smoke.mjs`                                                                                                      | PR 走 `--core`、push main 走全量，逻辑未变                                                                            |

`unit` 与 `integration` 各自跑 `npm run build:server`（`tests/unit/atomic-file-generated.test.ts` 的逐字节比对需要 dist 在场）。`unit` 还要装 mobile 依赖（`npm --prefix mobile ci`）：`mobile-connections` / `mobile-push-controller` / `mobile-app` 三条用例 import `mobile/src/*`，缺 `@capacitor/core`、`@pi-mobile/native-local-engine` 会直接 `Cannot find package`。fork 数不再写死 8：`tests/lib/suite-partition.mjs` 的 `FAST_MAX_WORKERS` 按实际核数收口（`min(8, 核数)`）—— GitHub 的 runner 只有 4 vCPU，8 个 fork 抢 4 个核时并行系数只有 1.66×。片数取 8 而不是 4：每个 job 有 ~50s 固定开销（装依赖 + `build:server`），4 片时单测壁钟 ~110s、固定开销 ~50s；8 片把单测压到 ~55s，再往上只摊薄固定开销。浏览器型用例的预算统一走 `tests/lib/chrome.mjs` 的 `BROWSER_TEST_TIMEOUT_MS`（60s，与 `vitest.config.ts` 的 `testTimeout` 对齐）：4 vCPU runner 上 4 个 fork 同时冷启 Chrome，写死 20s 会假红。

同一分支的新推送会取消上一轮在跑的检查（`concurrency` + `cancel-in-progress`，只在 PR 上生效），连续 push 时不再排队跑过期提交。

冒烟清单（tests/run-smoke.mjs 的 ALL，82 个）只收**自包含、零 token、跨平台**的测试；attach 型（需外部 server）、需真模型、平台相关的脚本不进 CI，本地手动跑（分类见 run-smoke.mjs 头部注释）。

冒烟分层（CI 提速）：PR 跑 `--core` 快检子集（CORE，协议/安全/插件接线代表，2~4 分钟），push main + 每日 nightly（北京时间午夜）跑全量；`--retry-once` 让首轮失败重跑一次（标 FLAKY，重跑还挂才算真失败）。新测试默认进 ALL，跑得快（<20s）且稳才进 CORE（有 ALL↔CORE 同步守卫）。

`dist/` 由跑器在开跑前**串行构建一次**（CI 已在 Build 步骤构建过，可用 `--no-build` 跳过）。用例侧一律走 `tests/lib/ensure-build.mjs`，**不要**自己 `execSync("npm run build")`：默认 4 worker 并行下，一个用例重写 `dist/` 时另一个正在 `spawn dist/server/index.js`，会出「测试插件没被激活」之类与被测逻辑无关的假红。

### 本地复刻 CI（`npm run ci:local`）

本地绿 ≠ 远程绿，多数时候不是环境玄学，而是**本地根本没跑 CI 跑的东西**（2026-11 的 6 次 main 红里，4 次挂在 `Protocol smoke tests (full)`——它 PR 不跑、本地也不跑，只能在 main 上发现）。`npm run ci:local` 按 `.github/workflows/ci.yml` 的步骤与顺序逐条复刻，每步经 `scripts/safe-exec.mjs`（硬超时 + 杀进程树），日志落 `.safe-exec/`：

| 档位                                  | 覆盖                                                                           | 量级     |
| ------------------------------------- | ------------------------------------------------------------------------------ | -------- |
| `--profile static`（pre-push 默认档） | format:check → lint → check:protocol → i18n:check → typecheck（含 mobile）     | 1~3 分钟 |
| `--profile pr`                        | 静态 + build + 插件 bundle 重建 diff + 扩展打包 + vitest 两池 + smoke `--core` | ≈10 分钟 |
| `--profile full`（默认档）            | 上面全部 + smoke 全量（push main 才跑的那一步）                                | ≈16 分钟 |

`--only <id>` / `--from <id>` 断点重跑，`--list` 看步骤与 id，`--install` 先 `npm ci`（会重装 node_modules，慢）。

开跑前会打印「本地 ≠ CI 的已知偏差」：Node 大版本（CI 用 22）、非 Linux 平台（大小写敏感 import / 权限 / PTY）、工作区脏（CI 只看已提交内容）、改了 `web/src/i18n/messages/` 却没生成 12 个语言包。这几项 `ci:local` 治不了，只能靠容器或 CI 兜底——别把本地绿当万无一失。

钩子：`npm run hooks:install` 装 `pre-push`（默认跑 static 档；`CI_LOCAL_PROFILE=pr|full git push` 加严，`SKIP_CI_LOCAL=1 git push` 跳过），`npm run hooks:install -- --uninstall|--list` 管理。钩子源文件在 `scripts/git-hooks/`，不用 `core.hooksPath`（避免静默盖掉别人已装的钩子）。

## 前端构建更新与旧页面

`web/vite.config.ts` 不清空整个输出目录；`web/build-assets.ts` 在构建成功后保留当前与上一轮的 assets，并清理更早的文件，避免已打开页面在首次打开文件预览、设置等面板时请求已删除的懒加载模块。`.build-assets.json` 记录当前一轮资源；首次迁移时把已有 assets 作为上一轮保留。完整替换安装目录仍可能失去旧资源。

`web/src/chunk-recovery.ts` 统一处理 Vite preload 错误与根错误边界中的模块加载失败，通过 sessionStorage 记录恢复次数：同一构建最多自动刷新一次，跨构建至少间隔一分钟；持久错误或存储不可用时保留手动重试界面，避免循环刷新。一般应用异常不会触发自动刷新。

## TOTP 测试站（内置浏览器「TOTP 验证器」）

`npm run dev:totp`（`dev/totp-demo.mjs`，仅回环地址，无第三方依赖）起一个本地 2FA 站，用来跑通浏览器的完整链路：**扫码绑定 → 按 origin 自动匹配 → 一键填码 → 服务端校验**。

- `/setup/demo`：二维码页（`totp.scan` 截当前标签页找码，所以码要在视口内）；同源的登录页才能自动匹配。
- `/login/demo`：标准登录页，验证码框 `autocomplete="one-time-code"`（`fillTotpCode` 的第一优先级）。
- `/login-cells/demo`：6 个 `maxlength=1` 格子（逐格填码路径）。
- `/login-plain/demo`：无任何 otp/code 提示的单框（需先点输入框再填，测兜底路径）。
- `/api/code/:key`、`/api/account/:key`：当前码 / 密钥 + otpauth URI，方便 curl 对答案或手工导入。
- 三个账号分别覆盖 `SHA1/6位/30s`、`SHA256`、`8位/60s`，用于确认 otpauth 参数解析；密钥每次启动随机（`PI_TOTP_SECRET` 可固定 demo 账号）。

## 编码约定

- **缩进用 Tab**；前端组件小写文件名（`copy-button.tsx` 例外）；代码注释中英混写，UI 文案默认中文。
- **服务端语言包**：`serverStrings` 的 `{name}` 必须对应 `pick()` 第五个参数 `vars` 的键名（如 `{ count: rows.length }` 对应 `{count}`），不能直接照抄英文模板表达式。翻译须保留操作指引、命令字面量及拼接边界换行；改动后用实际语言包验证插值结果，键对齐检查不覆盖这些问题。
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

### 测试价值与精简

- **行为测试接到生产代码**：调用真实导出、渲染真实组件或执行生产闭包；测试内复制算法再验证副本不算生产行为覆盖。类型声明、参数解构、局部变量名不单独立 case。
- **源码守卫保留明确职责**：架构、安全、资源契约，以及暂时缺少行为验证的已知回归可以静态检查；同一约束集中到一个守卫，避免跨文件重复检查同一段源码。
- **删除重复项先核对替代关系**：生产路径、输入范围和约束强度须被保留测试覆盖；解析器还须保留有效样本数断言，避免全部跳过后假通过。不同边界仍需独立覆盖，不能只为减少 case 数合并。
- **复用只读输入，隔离可变状态**：同套件扫描源码一次，昂贵基础 fixture 可以复制到每例独立目录；Git 的 `.git`、索引、浏览器 context 等可变资源不跨用例共享。保留 Vitest 默认模块隔离。

`tests/unit/` 是历史目录名，里面还包含仓库扫描、真实 Git/CLI 与 Chromium 测试，不能都按「毫秒级纯函数」估算成本。优化先减少重复扫描、进程启动和过大的导入链，再用定向报告比较耗时；全量 CI 门禁保持覆盖。

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

本地迭代先运行与变更相关的 `npx vitest run <测试文件>`；涉及协议时运行 `npm run check:protocol` 和对应 `tests/*-test.mjs`，涉及真实 UI 交互时再跑相关浏览器测试。测试 server 使用隔离端口与独立 data-dir；Chromium 由 `tests/lib/chrome.mjs` 逐平台探测，`PI_WEB_CHROME` 可覆盖。提交前按 `AGENTS.md` 完成改动文件格式化、`npm run typecheck` 和相关单测；全量 `npm test` 与分层 `test:smoke` 继续由 CI 执行，共享基础设施变更时本地也应跑相应全量套件。

### 测试耗时观测（慢在哪）

`vitest.config.ts` 的 `silent: true` 会吞掉默认 reporter 的 per-file 行，全量跑十几分钟却看不到任何耗时。因此配了 `tests/lib/test-timing-reporter.mjs`：每条用例一行「结束时刻 + 耗时」，收尾再打「最慢文件 Top10 / 最慢用例 Top20」。

```bash
npm test                              # 默认 PI_TEST_TIMING=all，逐条打印
PI_TEST_TIMING=slow npm test          # 只打 ≥1s 的用例（PI_TEST_SLOW_MS 可改阈值）
PI_TEST_TIMING=off npm test           # 只留收尾小结
npx vitest run --reporter=json --outputFile=<tmp>/timing.json   # 事后逐用例复用
```

本地实测基线（Windows 12C/24T，1028 个文件 / ≈12.5k 用例）：墙钟 ≈705s，用例累计 ≈1955s，并行系数 2.78×。**约 75% 的时间集中在 6 个真实集成文件**（`device-hub-artifact-integration` / `device-local-integration` / `device-hub-integration` / `task-workspace` / `canvas-workspace` / `device-center-runtime-code-artifact`），它们真跑 git 子进程与 Hub HTTP；这些文件单跑最慢用例 17–52s，4 worker 满载下会被拉长约 2.3×。

两条据此定的规矩：① **重集成用例的超时预算写 90s**（与 `task-workspace` 对齐），别写 20–30s——那是零余量，满载时稳态假红，且每条假红要白烧 30s；② 同一文件内的用例是串行的，把几百秒的重活拆成多个文件比调 worker 数更有效。

### 两个池：默认快池 + 重型集成池

单选那个数字（`maxWorkers`）救不了这个套件：**重型池**从 4 抬到 8，同一条用例从 30s 膨胀到 83s、其余撞 60s/90s 预算，并发上去反而更慢且假红；而**快池**恰好相反，它卡在 1023 次 fork 上，worker 越多越快。所以按成本分层，清单单源在 [`tests/lib/suite-partition.mjs`](../tests/lib/suite-partition.mjs)（判据：实测 ≥60s）：

| 池           | 入口                       | 内容                                          | 预算                         |
| ------------ | -------------------------- | --------------------------------------------- | ---------------------------- |
| 快池（默认） | `npm test`                 | 除下表之外的全部单测（1023 文件 / 12.4k 条）  | 8 worker · 60s（实测 ≈186s） |
| 重型集成     | `npm run test:integration` | 6 个真 git / 真子进程 / 真 Hub 文件（111 条） | 4 worker · 90s（实测 ≈470s） |
| 全量         | `npm run test:all`         | 两个都跑                                      | —                            |

`PI_TEST_ALL=1 npx vitest run` 也能一次跑完全部；CI 的 `Unit tests` 与 `Integration tests` 两步分别跑两个池（`tests/unit/test-suite-partition.test.ts` 守卫「两边拼起来必须等于 `tests/unit/**` 全集」，防止某个文件被 exclude 后再也没人跑）。重文件新增时往清单里加一行即可。

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
