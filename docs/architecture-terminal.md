# 终端架构

> 覆盖 PTY 管理、按键编码、输出合并、SCM git 查询、活力检测、终端接管 bash 等。

## 原生 bash 生命周期

`resolve-global-sdk.ts` 预加载时注册 `patch-bash-process.ts` 的 Node 模块加载钩子，在 SDK 原生 shell 模块首次编译前应用内存兼容补丁（#794），同时覆盖自带与跟随 SDK，继续复用 SDK 的 shell 配置、环境及进程树清理。不改写任何已安装 SDK 文件。未识别的上游结构会输出警告，不静默假定已修复。CLI、生产、桌面和开发服务均须在入口之前预加载该模块；直接导入 SDK 的测试不注册钩子、不产生磁盘副作用。另一个加载钩子 `patch-executable-lookup.ts`（#810）用同样的方式把 SDK 的 `which` / `<cmd> --version` 子进程探测换成 PATH 扫描（Android/Termux 默认开启，见 `docs/env-vars.md`），同样只改写内存中的 ESM 源码，未识别的结构同样告警而非假定已修复。

执行 timeout 只约束主进程运行阶段；收到 `exit` 即保存真实退出码并停止执行计时，之后等待输出关闭或 100ms 静默。输出收尾另有不可被持续输出延长的 1 秒上限，触及时明确标注停止收集并关闭本地读取端，避免后台子进程持有继承管道造成无限等待。正常退出不主动杀后台任务。取消及真正执行超时会调用 SDK 的进程树终止，并最多等待 1 秒清理，即使未收到 `exit`/`close` 也结算。所有结算路径释放监听器、输出流和计时器。

`timeout` 不改变原生/PTY 路由或持久性；Windows 仍只在显式 `persist: true` 且开启终端接管时走持久终端，避免一次性控制台耗尽。

`abort_bash` 的可选 `conversationId` 精确指定当前客户端持有的会话，省略时仅使用当前会话，不查找其他运行命令。原生、终端和扩展 bash 的控制器统一挂在稳定的 `Conversation` 对象上，执行时解析归属，随过户与 ID 冲突改名一起迁移。取消前捕获目标 runtime，停止提示只注入该 runtime；前端切换会话期间不发送停止请求。

## 终端管理

- **用户终端与 Agent 终端分层**：
  - **用户直接创建的终端**（UI 加号新建、运行自定义命令，`agentBash !== true`）：归属于 `ClientSession`（工作区级别），按客户端存活；在终端列表中**始终显示**，不再受单个对话切换、回退、删除或生命周期的影响和过滤；输出实时直接下发；只有用户手动关闭或进程自身退出时才销毁。
  - **Agent 内部接管/调用的终端**（`agentBash: true` 或 agent 工具调用的交互终端）：归属于单个 `Conversation`，跟随该对话的生命周期与活力检测（静默 ≥15s 注入 steer 提醒）。
- **统一列表推送与路由**：服务端 `pushTerminals()` 自动合并用户终端与当前对话的 Agent 终端；`handleTerminalMessage` 对输入（`terminal_input`）、大小调整（`terminal_resize`）、关闭（`terminal_kill`）、重命名（`rename_terminal`）通过 `findTerminalManager` 全局索引匹配目标终端，跨对话操作无缝直达。
- **所有 spawn 路径统一准入**：`terminal_create`（浏览器/agent）与 `run_command`（命令列表）共用 `validateId`（字母/数字/.-_:/≤80 字符）+ `ensureSpawnAllowed`（新 live PTY 需低于 `MAX_TERMINALS`；已在运行的同名终端原地重启不占新名额；**history 里的已退出终端不保留名额**——满员时重跑已退出终端同样拒绝，堵住"唯一 ID 无限生成 PTY"的洞）；失败统一走 `fail()`（notice + 终端内红色报错 + terminal_exit）。

## terminal_key 按键编码

`encodeTerminalKey(key, modifiers)` 是纯函数（导出，字节级断言在 terminal-smoke-test.mjs）：命名键按名称路由，Ctrl/Alt 组合绝不回退成"Ctrl+首字母"——Ctrl+ArrowUp=`ESC[1;5A`（非 Ctrl+A）、Ctrl+Enter=`ESC[13;5u`（非 Ctrl+E）；方向键/F1–F4/Home/End 带修饰符时用 xterm 修饰序列 `ESC[1;<m>X`，其余命名键用 CSI-u `ESC[<code>;<m>u`，普通字符 Ctrl 映射 A–Z→0x01–0x1A、Shift 大写、Alt 前缀 ESC。

## 输出合并

输出经带 `conversationId` 的 `terminal_output` 推给浏览器；未挂载终端保留 200KB 输出窗口，切回对话时回放。socket 断开不杀 PTY；切换/重连保留状态，对话被释放或服务关闭时才杀掉全部 PTY。

**终端输出微批合并**（`terminals.ts` 的 `queueOut`/`flushPending`，窗口 `OUTPUT_FLUSH_MS=16ms`）：`pty.onData` 每 chunk 先入 `pendingOut` 缓冲再统一 flush 一条 `terminal_output`——构建等场景每秒数百上千个小 chunk 的 WS 帧风暴降 10~50 倍；exit/kill/原地重启先 flush 再发退出事件保证顺序。

## node-pty × Node `--watch` 兼容自愈

`server/patch-node-pty.ts`（必须排在 node-pty 之前 import）：dev 脚本用 `node --watch`，watch 模式会向 node-pty 的 ConPTY worker / console-list agent 的 IPC 通道推 `watch:require`/`watch:import` 消息——node-pty 1.1.0 不识别，导致①每条都 `console.warn('Unexpected ConoutWorkerMessage')` 刷屏；②kill 路径把 watch 消息当 agent 回复，`message.consoleProcessList` 为 undefined 直接 `.forEach` 崩溃。补丁模块在启动时幂等地改写安装副本（仿 spawn-helper chmod 先例）；`terminals.ts` 里另有一层 console.warn 过滤兜底。生产（无 `--watch`）不受影响。

## SCM 源代码管理

`SCMPanel`（视图 `git`）的只读 git 查询走服务端 `server/scm.ts`，用 `execFile("git", …)` 直跑（不经过 shell——无提示符/回显/ANSI/zsh 差异），解析成结构化 JSON。

### 协议

客户端发 `scm_status`（status+branches(含远程,for-each-ref)+numstat）/ `scm_history`（提交图，懒加载——切到「提交树」tab 才查）/ `scm_filediff`（单文件 staged+worktree diff）/ `scm_commit`（hash 白名单校验后 git show），服务端必回一条 `scm_data`（echo reqId + kind，ok/error/notRepo），前端按 reqId 匹配 pending 槽位——每个请求必有且仅有一个响应，UI 不可能卡 loading；sendScm 在 socket 断开时不占槽位不置 busy（防转圈卡死）。路径校验：filediff 的 path 必须 resolve 后仍在工作区内；非 git 仓库返回 ok:true + notRepo:true（面板显示提示而非报错）。15s 超时/maxBuffer 16MB。

### 左栏宽度可调（issue #139）

改动文件 / 提交历史那一栏默认 300px，可拖它右边的分隔条（`.scm-divider`，双击复位到默认）：宽度写在 `.scm-body` 的内联 CSS 变量 `--scm-sidebar-w` 上，拖动中按容器宽度给 diff 区留最小宽度、松手才写 `localStorage`（键 `pi-web-ui:scm-sidebar-width`）。夹取与存档解析是纯函数（`web/src/scm-sidebar.ts` 的 `clampScmSidebarWidth` / `parseScmSidebarWidth`，单测 `tests/unit/scm-sidebar.test.ts`；浏览器回归 `tests/scm-test.mjs`：拖 +120px → 刷新保持 → 双击回 300）。CSS 那侧还有一条 `max-width: calc(100% - 220px)` 兜底：窗口变窄时不会把 diff 区挤没。

### git 目录 watcher

首次 scm_status 时 `git rev-parse --absolute-git-dir` 定位 .git 并 fs.watch（非递归——HEAD/index/packed-refs 都在顶层，覆盖 commit/stage/checkout），事件去抖 600ms 推 `scm_changed` → 前端静默 refresh（外部 CLI/IDE 改仓库实时反映）；setCwd/dispose/notRepo 时 unwatch；watch 失败静默降级为 30s 可见轮询兜底。

### 自动刷新触发器

全部走 silent refresh 不闪 spinner：scm_changed / 终端 tab 里 SCM 生成的 git 写命令 running→exit（标题 `/^git /`）/ 视图激活 / cwd 切换 / 30s 轮询。

### 写操作

仍走可见终端 tab（TerminalPanel 同款 tab 复用逻辑）并切到终端视图：提交/推送/拉取/切换分支（远程分支 `origin/x` → `git checkout -b x origin/x || git checkout x`）/ 单文件暂存（`git add -- <path>`，行 hover 显示 + 按钮）/ 取消暂存（`git reset HEAD -- <path>`，− 按钮），路径经单引号转义。分支下拉本地/远程分组（optgroup，i18n scmRemoteBranches）。

### 历史教训（已废弃的旧实现）

曾用隐藏 PTY + shell 变量拼接 sentinel 切分文本，踩过 xterm writer 覆盖解析器、zsh 提示符无尾换行粘行吞掉 `## main` 状态头、全局队列被流式期间的慢查询阻塞等三个坑。

## 终端活力检测（liveness watchdog）

`terminals.ts` 的 `noteAgentActivity` / `armIdleWatch` + agent-service 的 `notifyTerminalIdle`：agent 工具路径的 terminal(action=create/input/key) 会启动一个「静默纪元」——该终端连续 `PI_WEB_TERMINAL_IDLE_MS`（默认 15s）无输出且**该对话正在流式运行**时，经 onAgentIdle 回调由宿主 `sendUserMessage` 注入一条 steer 提醒唤醒 AI 去检查（等输入/已挂起）。

防骚扰设计：①用户手开的终端永不参与（只有工具包装层调 noteAgentActivity，浏览器路径不调）；②一次性——触发后解除武装，agent 再次触碰才重新计时；③纪元内任何输出/输入都重置倒计时；④退出/关闭即拆钟。系统提示词引导 TERMINAL_TOOLS_GUIDANCE 已告知模型该机制。回归：`tests/terminal-idle-test.mjs`（直接实例化 TerminalManager + 小阈值，零 token 不起 server；win32 未验证）。

## 终端接管 bash（terminal-backed bash）

bash 工具始终覆盖 SDK 内置 bash，并按设置开关 `terminalBash`（默认关）在两种实现间**动态分流**（agent-service 的 `makeAdaptiveBashTool`）：

- **关（默认）**：`makeKillableBashTool` —— 用 SDK 原生 `createBashToolDefinition`（纯进程 spawn，**不开终端**），就是覆盖前的行为；`persist` 在此路径无效，`head`/`tail` 对返回行做后处理。
- **开**：`makeTerminalBashTool` —— 命令写进可见终端（全部脚本经 `$'...'` 转义成一个物理行的 eval，再在外层捕获 `$?` 并打印哨兵，避免交互程序把下一行哨兵读成输入），哨兵带每次调用随机的 12 位 hex nonce，只认本次注入的那一个（真实输出里的 `[pi-exit:42]` 不会被当成真退出码）；等哨兵行拿到**真实退出码**后返回完整输出（`stripAnsi` 清理；按注入位置删回显行与重绘行，不吞真实输出）。此路径下 `persist` 决定终端**生命周期**，`head`/`tail` 决定返回行数。

原生 bash 包装层必须把 `execute` 的第 5 个参数（`ctx`）透传给 SDK 的 definition：SDK 用它在每条命令上注入 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL`，子 shell 继承这些值。不透传 `ctx` 时，SDK 仍会**清掉**继承来的会话变量，却写不进当前值（子 shell 里读到的是缺失或过期值）。这条只针对原生 bash；终端路径不走 SDK 的会话环境注入。另外，以 SDK 嵌入方式运行时，SDK 也不会自动设置 CLI 专用的 `AI_AGENT` / `PI_CODING_AGENT` 标记。

> 注意：`persist`/`head`/`tail` 始终出现在 bash 工具的参数 schema 里（双实现共用一份），关时 `persist` 被忽略，`head`/`tail` 仍生效。
>
> **提示词单源**：description / promptSnippet / promptGuidelines / 参数说明不在这几条路径里各写一份 —— 唯一事实源是 `server/tool-prompts.ts`，由 `makeKillableBashTool`（同时也是参数 schema 的宿主）、`makeTerminalBashTool`、`makeAdaptiveBashTool` 共同取用。`makeAdaptiveBashTool` 只覆盖 `execute`（分流）。历史上它额外覆盖 description，于是终端那份文案整段写死却永不发送 —— 一份会持续漂移的死副本（“prefer head/tail over piping” 曾只写在它里面）。

### 设置开下的 `persist` 语义

- **`persist=false`（默认，一次性）**：每次调用新建终端 `ai-bash-<n>`（`agentBash=true`），命令跑完 shell 用 `exit` 退场（进程结束），终端连同输出保留在 history 供查阅；阻塞到命令结束，不做静默解阻（接近普通 bash 语义）。**Windows 适配（issue #269）**：Windows 下 MSYS2 存在全局控制台硬编码上限 128（`\cygwin.shared` 的 `MAX_CONS 128`），且每次 `CreatePseudoConsole` 都会启动一个持久的 `conhost.exe`；高频创建一次性终端不仅极慢（每次约 1.3s），且累积达到 128 次后会导致 MSYS2 控制台分配彻底耗尽死锁。因此在 Windows 平台上，一次性命令（`persist !== true`）自动分流走原生 SDK bash（纯进程基于 pipe，极速 20ms、零控制台设备分配）；只有明确需要持久交互（`persist === true`）时才走常驻可见终端 `ai-bash`（始终复用单个终端，只占 1 个 slot）。
- **`persist=true`**：复用持久终端 `ai-bash`——shell 状态（cd/venv）跨调用保留，支持静默解阻后用 `terminal(action="wait"/"read"/"input"/"key")` 观察与交互。命令未完成时拒绝再次注入 bash，交互程序只能通过 input/key 驱动；嵌套 shell/SSH 的状态由其自身进程决定，不能假定外层命令已结束。

### Windows ConPTY 退出与 MSYS2 控制台释放（issue #215 / #269）

Windows 下的伪终端销毁存在两大架构陷阱：

1. **ConPTY 关机死锁（issue #215）**：进程退出时若直接调 `pty.kill()`（底层 `ClosePseudoConsole`），管道有未排空数据时会内核级同步死锁，冻住事件循环。
2. **MSYS2 控制台 slot 泄漏（issue #269）**：若无脑直接调 Node 的 `process.kill(pid)`（Win32 `TerminateProcess`），MSYS2 的 DLL 析构与控制台清理钩子被直接跳过，导致全局命名共享内存 `\cygwin.shared` 中的控制台设备 slot（上限 128）永久泄漏，累积后引发 `fatal error - console device allocation failure - too many consoles in use, max consoles is 128`。

`terminals.ts` 的 `killNative` 与终端生命周期对此做了精细分流：

- **进程已自然退出（`entry.exited === true`）**：绝对不调用 `process.kill(pid)`（避免误杀 PID 复用后的新进程），直接调用 `entry.pty.kill()` 释放 HPCON、socket 与 worker 句柄；因为进程已死、管道见 EOF，此时 `ClosePseudoConsole` 绝不会死锁。终端自然 `exit`、`this.history` 淘汰最老项（超出 32）、用户在 UI 关闭历史 tab 以及 `killAll` 时均执行该安全清理。
- **进程仍在运行（`!entry.exited`）**：先向 PTY 写入 `\x03exit\r` 尝试让 shell 正常退出并触发 MSYS2 清理钩子；若仍未退出才用 `process.kill(pid)` 强制兜底，最后调 `pty.kill()` 释放句柄（关机 `shutdown=true` 时跳过 `pty.kill()` 由 OS 回收）。
- **`conpty_console_list_agent` 容错（`patch-node-pty.ts`）**：给 node-pty 的 console-list agent 增加 try-catch，进程已死时 `AttachConsole` 失败不再抛出未捕获异常，安全返回空列表。

`head` / `tail`（1–5000）只返回输出的前/后 N 行，替代 `| head` / `| tail` 管道（管道会缓冲输出、让可见终端全程哑火、还易触发静默解阻）。纯函数 `applyHeadTail(text, head, tail)` 只对真实数据行切片，省略提示行单独包回，head+tail 组合时尾部不会少截一行。

### 尾部限输出管道自动化解 + 快照查询

`makeTerminalBashTool` 会在执行前把模型常写的**尾部限输出/透传管道**（`| tail [-n N|-N]` 不含 `-f`、`| less`、`| more`、`| cat`）拆掉：底层命令直跑（可见终端实时 + 真实退出码），只在返回给模型时按检测到的行数截末尾 N 行；`buildTerminalBashLine` 保留当前 shell 的 `$?` 与 pipefail 配置，不强制取管道首命令，也不把退出码 141 改写为成功。纯函数 `splitTopLevelPipes` / `detectTrailingLimiter` / `detectStdoutRedirect`（处理 `cmd > log 2>&1 | tail -N`：拆掉 tail 后补一个 `tail -N log` 让模型看到日志尾部）。`| grep`/`| head`/`| awk`/`| sed`/`| sort`/`| uniq` 等真过滤/变换**不拆**（拆掉丢语义或崩出海量未过滤输出），`tail -f/--follow` 也不拆，交 prompt 引导模型不用。`terminal(action="read")` 支持 head/tail/search 输出过滤，cursor 仍按原始流推进；内部活力提示的查询使用 `queryTerminalOutput(output, q, running, exitCode)`（带 1-based 行号），终端静默提示回送的最近行数由 `terminalIdleNotifyLines()`（可配 `PI_WEB_TERMINAL_IDLE_LINES`）控制。

### 行为语义（集中在设置开 + `persist=true`）

- ①默认阻塞到命令结束
- ②连续 `terminalBashIdleMs`（默认 15s，0=一直等）无输出 → **静默解阻**：立即返回「仍在后台运行」+ 已有输出，同时注册 `watchOutput` 完成观察器，命令真正结束后由宿主 `notifyTerminalBashDone` 通知 AI（流式中 sendUserMessage steer / 空闲时 sendCustomMessage nextTurn 排队不唤醒）
- ③shell 状态跨调用保留（cd/venv/ssh）
- ④后台化只结束当前等待，控制器、取消信号与 timeout 持续有效，直到该任务完成。abort_bash、超时或 signal 取消会关闭该 PTY，避免在未知前台程序状态下复用 shell；再次调用创建新 shell，原 cd/venv 状态随取消释放。
- ⑤pending 和等待绑定本次 nonce；旧任务完成不能清除新任务状态。PTY 退出/关闭/替换会唤醒等待者，已知退出码直接返回，不再误报超时。

开关经 `makeAdaptiveBashTool` 的 `useTerminal` 闭包每次调用读取 → 即时生效（customTools 固定于 runtime 创建，不能在创建时二选一）；`idleMs`/`defaultPersist` 同理从设置读取。回归：`tests/terminal-bash-test.mjs`（直接实例化 + 小阈值注入 + `persist`/`head`/`tail`/一次性/分流用例，零 token 不起 server；win32 未验证）。

**前端展示与配额**：持久 `ai-bash` 与一次性 `ai-bash-<n>` 都带 `TerminalInfo.agentBash=true`（该字段仅区分用途，归属由 ownerKind 决定），前端 `TerminalPanel` 把它们从用户终端标签里拆出来，单独归到「终端接管 bash」折叠分组（`term-folder`，可点开/收起）；`ensureSpawnAllowed` 也只按非 agent 终端计数，所以 AI 高频调用 bash 不会顶掉用户能开的终端名额。

## 统一 terminal 工具与权限边界

持久终端只注册一个 `terminal` 工具，`action` 为 `create/list/close/input/key/read/wait`。旧七工具不再出现在活跃工具列表。`list/read/wait` 为只读；`create/close/input/key` 会改变进程或输入状态。

- 计划模式、reader 预设和受限子代理保留只读动作；模型可见 schema 收窄 action 枚举，执行硬闸门仍独立检查实际 action。退出只读模式时恢复原 schema。
- 旧 `terminal_<action>` 审批规则按新工具的实际 action 兼容匹配；新 `terminal` 规则可以用 params 匹配 action。旧禁用开关保守迁移为禁用统一工具，避免升级后放开原先禁止的输入。
- 输入换行审批和 `key(Enter)` 审批保留；审批等待返回后再次检查取消信号，防止取消后发送输入。
- UI 的 `terminal_create/input/...` 是浏览器 wire 消息，与模型工具名独立。新增 `terminal_attach` 只附着已有 PTY、调整尺寸并回放 retained history，不创建、不重启；组件挂载只发送 attach。新建和显式重跑由用户操作直接发送。

## 终端归属与恢复

`TerminalInfo.ownerKind` 明确 `client` / `conversation`，与 `agentBash` 用途字段分离。普通 AI 创建的 shell 也属于 conversation；输入、resize、关闭、重命名和输出均携带归属，拒绝把同 ID 的另一归属终端当作回退目标。用户终端以当前项目根校验新建目录，已有进程的 cwd 与归属保持不变。服务端推送的是用户终端与当前对话终端的完整列表，前端权威对账并保留退出历史。

持久边界是同一服务进程内的 shell 复用与页面断线保活，不提供服务重启后的进程恢复。

## macOS launchd / TCC 问题

macOS 下若服务由 launchd 拉起（`process.ppid === 1`，LaunchAgent/孤儿进程），TCC 会把相机/麦克风权限归因到 node 本身（无 App Bundle、无 Info.plist）而静默拒绝——ffmpeg 取流会卡死在取帧。`terminals.ts` 检测该场景，在客户端首次创建终端时输出提示（改 url/文件源，或在自己已授权的终端里前台运行）。

## Windows shell 解析

`terminals.ts` 的 `resolveShell()` 每次创建终端时解析，优先 bash——`PI_WEB_SHELL` 显式 → `$SHELL` → Git Bash（ProgramFiles）→ busybox 兜底（`~/.pi-web/bin/bash.exe`，`ensure-bash.ts` 无 Git Bash 时自动下载 busybox-w32）→ `$COMSPEC` → powershell。与 SDK bash 工具（Git Bash / PATH 上的 bash）保持一致，避免 PowerShell/bash 混用挂死。
