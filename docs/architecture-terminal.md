# 终端架构

> 覆盖 PTY 管理、原生 CLI 工作台、按键编码、输出合并、SCM git 查询、活力检测、终端接管 bash 等。

## Windows PTY 与输入法定位

本地 PTY 在 Windows 上通过 `node-pty` 的 `useConptyDll: true` 使用包内附带的 ConPTY。系统自带的旧版 ConPTY 会在光标隐藏时重绘屏幕，却丢弃 CLI 最后发出的光标定位序列；TUI 绘制的输入光标与 xterm 实际光标因此分离，中文输入法候选栏会落在状态栏或窗口底部。包内 ConPTY 保留这些序列，使 xterm 的输入 textarea 跟随 CLI 的真实输入位置。该设置覆盖本地 shell、原生 CLI 和 bash 接管终端，远程虚拟 PTY 不受影响。

`tests/native-cli-smoke-test.mjs` 使用真实 PTY 验证：隐藏光标后绘制输入行和右侧状态栏，再移回输入行，最终定位序列必须到达客户端；该回归与粘贴、重连、退出、重启共用完整链路。

## 原生 CLI 工作台

- 标准 Pi `ClientSession` 宿主内，每次创建 CLI 都新增独立 `Conversation`，与该宿主的普通聊天共用 `ConversationSummary` 列表、项目列表、文件树和预览；类型由当前对话快照决定，不保存为客户端全局标签。启动配置可选择 Pi、Claude Code、Codex、Antigravity（agy）等具备独立 CLI 的程序，这与当前聊天宿主引擎不同。DSH、Claude、Codex、Durable 等其他聊天宿主暂未适配 `new_cli_chat`，请求返回错误 notice 与失败回执；不会自动切换用户引擎，也未聚合跨引擎列表。`PI_WEB_TABS` 由 `terminal` 开关统一管控 CLI 与普通终端，服务端也拒绝禁用后的输入。
- 事实源：`server/native-cli.ts`（启动配置、类型持久化、输入与文件准备）、`server/native-cli-model.ts`（运行时模型连接解析与子进程认证适配）、`server/native-cli-state.ts`（原生会话绑定与事件游标）、`server/native-cli-runtime.ts`（宿主/终端适配契约）、`server/native-cli-session.ts` / `native-cli-session-hooks.ts`（精确续接与官方事件）、`server/remote-cli-persistence.ts`（tmux 保活与实例控制）、`server/remote-native-cli.ts`（远端检测与安全启动数据）、`server/native-cli-routes.ts`（按需检测 API）、`server/native-cli-remote-files.ts`（远端引用与附件暂存）、`server/native-cli-remote-cleanup.ts`（离线清理重试）、`server/remote-ssh-service.ts`（共享 SSH 通道与租约）、`server/native-cli-references.ts`（页面、对话、画布引用内容物化）、`server/engine-catalog.ts`（引擎、包名与 CLI 能力单源）、`server/engine-cli.ts`（共用启动解析与版本探针）、`server/native-cli-discovery.ts`（本机 CLI 路径检测）、`server/terminals.ts`（真实 PTY 生命周期）、`server/dispatch-domain-handlers.ts`（创建与粘贴路由）、`web/src/components/NativeCliCreateModal.tsx`（创建弹窗与展开式新建控件）、`web/src/components/NativeCliPanel.tsx`（内嵌 TermXterm）、`web/src/native-cli-reference.ts`（引用计划与目标）、`web/src/native-cli.css`（主题样式）。
- 从其他本地或 SSH 项目新建 CLI 时，启动成功后将窗口当前目录切到目标项目，停止旧项目的 Git 监听，再刷新工作区根目录、项目列表、会话、文件树与命令；页面快照使用目标目录。启动失败时保留原项目和活动对话。
- 原有新建对话按钮悬浮或聚焦时，同一控件向左扩展出仅显示终端图标的 CLI 点击区：两区均以原按钮高度为边长，左右等宽对称，共享整块背景和外轮廓；操作文字通过悬浮提示与无障碍标签提供，右侧「＋」的位置与普通对话行为不变；CLI 区域与原按钮同属一个 DOM group，不再使用独立浮层。展开与收起通过宽度和负边距同步过渡，不挤动相邻操作；关闭时 CLI 区域隐藏且不可聚焦。左侧顶部「＋」菜单也提供「新建 CLI 对话」，使用当前项目目录，复用同一个引擎选择弹窗。两处均遵循 `terminal` 功能开关。
- 预设与引擎管理共用 `ENGINE_CATALOG`，从 `cliCommand` 派生可直接启动的 Pi、DSH（`dsh-tui`）、Claude Code、Codex、Antigravity（`agy`）。agy 是独立交互式 CLI，直接启动原生 TUI，不走 IDE 启动器、`--print` 或 ACP；[官方安装说明](https://antigravity.google/docs/getting-started?tab=cli)，macOS/Linux 原生路径 `~/.local/bin/agy`，Windows `%LOCALAPPDATA%\\agy\\bin\\agy.exe`，服务端无 PATH 时也会检测。首次运行保留 CLI 自身的主题、渲染、工作区信任及登录流程。agy 没有 npm 包及 SDK 聊天驱动，不进入 SDK 引擎安装和升级目录；`NativeCliEngineId` 与 `BuiltinEngineId` 分别描述 CLI 预设和 SDK 引擎。
- DSH 原生 CLI 预设基于生态交互式 TUI 包 `@deepseek-harness-tui/dsh-tui`（命令 `dsh-tui` / 别名 `dst`，底层由 `@deepseek-ai/dsh` 驱动，安装命令 `npm i -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui`）。DSH 沿用其自身 profile 配置与环境变量/模型凭据，CLI 启动模型继承保持关闭（`cliModelArgs: null`）。Pi Durable 仅提供库 API、没有 npm bin，选项禁用并说明无独立 CLI，服务端同样拒绝启动。
- 直接启动交互式 CLI，默认沿用目标主机的环境与登录配置；启用 Claude/Codex 模型继承时按下述规则将连接信息传给子进程。不加跳过权限参数，不解析回答为聊天消息。参数每行一个，不把输入当 Shell 表达式执行。
- 设置 → 模型与提供商 →「CLI 启动模型」以 `nativeCliInheritModel` 保存各 CLI 的独立继承开关，默认全部关闭；这是全局共享的启动偏好，不进入主代理预设。支持能力由 `ENGINE_CATALOG.cliModelArgs` 单源声明：Pi 传 `--provider` 与 `--model`，Claude Code / Codex / Antigravity 传 `--model`，自定义命令不猜测其参数格式。开启时 `newCliChat` 在首次 await 前捕获当前对话的模型 `{ provider, id }`，保存到 `NativeCliConfig.model` 并持久化进原生 CLI 元信息；没有当前模型则继续使用 CLI 默认配置。已有 CLI、显式重启及历史恢复沿用捕获值，不受后续模型选择或开关变化影响。用户显式 `--model` / `-m`（含 `=value`）与 Pi 的 `--provider` 参数分别优先，`--` 之后的文本不当作选项。Claude Code / Codex 在每次创建、重启及历史恢复时，通过宿主 SDK `modelRuntime.getAuth` 重新解析该提供商的运行时 API 密钥、端点与请求头，支持当前密钥与动态认证配置；不把密钥写入 `NativeCliConfig`、会话元信息、协议快照或 CLI 全局配置。Claude 通过子进程的 `ANTHROPIC_BASE_URL`、官方 API-key 或自定义端点 token 环境变量连接，并清除与该连接冲突的 OAuth/云平台环境变量。Codex 通过 `-c` 指定临时 Responses provider，密钥和请求头值只用环境变量引用，不进入 argv。提供商仍需支持对应 CLI 的协议（Claude 的 Anthropic Messages，Codex 的 Responses）。Pi / Antigravity 仅传模型参数，认证与端点沿用各 CLI 自身配置；SDK 订阅 OAuth 不转换成 API key，仍需 CLI 自身登录。异步认证期间关闭终端或对话会取消待启动请求，防止迟到凭据解析重新拉起进程。
- 本地启动的预设通过 `resolveEngineCliLaunch` 在每次启动时自动检测运行 pi-web-ui 的机器：先按 `PATH` 顺序查找，再查用户原生安装目录（如 `~/.local/bin`）、当前 Node 目录、npm prefix、pnpm / Volta / Bun / Scoop 目录及 fnm / nvm 持久版本目录。多个持久版本按版本号降序查找；若仍无启动器，复用 `global-loader.ts` 的全局包检测，并核对对应 `package.json.bin` 的真实入口。包已安装不等于 CLI 入口可用。不扫描整盘，路径检测不执行 shell 或额外探测命令，不缓存未安装结果。POSIX 下跳过没有执行权限的候选，npm 的 JavaScript 入口经相邻 Node 或服务端当前 Node 直接启动，不依赖 shell 中的 `node` 命令；显式自定义路径保持优先，检测失败提示安装 CLI 或配置自定义路径。远程浏览器使用的是服务端机器的 CLI，无法检测浏览器所在机器的安装。创建弹窗打开时对本地工作区调用同一检测 API（`target: "local"`），未安装的预设置灰并显示“未安装”，安装命令取自 `ENGINE_CATALOG.installCommand`，一键安装复用宿主既有的 `pi-web-ui:plugin-run-command` 事件在终端标签里执行（agy 没有 npm 命令，链接到官方安装说明）；检测本身失败（如 terminal 功能关闭）时不禁用预设，回退到直接创建，避免探测把创建卡死。
- 引擎管理中的 CLI 版本探针、Claude/Codex 驱动实际启动、原生 PTY 工作台共用 `engine-cli.ts`，驱动不再维护各自的 PATH、版本管理器或 npm 入口查找。版本探针仅执行共用解析结果加 `--version`；Pi/DSH/Durable 的 SDK 或运行时可用性仍按各自引擎契约判断，不把库可用性强行等同于独立 CLI。
- Windows 上解析 npm `.cmd` 包装脚本中的字面入口：Node 脚本经 Node 启动，原生 `.exe` / `.com`（如 Claude Code）直接启动。参数保持独立 argv，不经 `cmd.exe` 展开；需要变量展开、附加参数或命令的包装脚本仍拒绝，用户可配置实际可执行文件。
- `new_cli_chat { config: NativeCliConfig, cwd?, requestId? }` 创建并激活独立 CLI；有 `requestId` 时复用 `new_chat_result { requestId, ok, conversationId? }` 回执。`UiState.nativeCli?` 与 `ConversationSummary.nativeCli?` 均为 `NativeCliConversation { config, terminalId, status? }`。SDK runtime 仅作为现有 Conversation 的宿主，普通 `prompt()` 拒绝向 CLI 发送模型消息；CLI 不参与空白聊天重用。
- CLI 使用已有 conversation-owned PTY；输入、粘贴、attach、resize、kill 带 `conversationId` 与 `ownerKind: "conversation"` 精确路由。`TerminalInfo.nativeCli` 保留启动配置，同一个 PTY 只挂一个 xterm writer。启动目录固定为创建时的项目目录，切换项目不会改变进程 cwd。
- 切换普通聊天或不同 CLI、重新连接和网页刷新仅 attach 已有 PTY并回放其缓冲；切走与 LRU 自动收起不会释放 CLI。进程退出后保留 descriptor 与输出，用户显式用 `terminal_create`（`ownerKind: "conversation"`、所属 `conversationId`、descriptor 的 `terminalId`）重启。重启配置和 cwd 从对话读取，忽略客户端覆盖；重启失败保留旧输出。显式关闭对话才整体释放 runtime 与 PTY。
- 创建前先准备 SDK 宿主与 PTY，成功后再激活；SSH 启动等待远端目录、可执行文件与无回显引导握手确认。创建失败释放新资源并保留原活动对话；同一终端的并发创建共用一次启动，关闭或宿主释放会取消待启动请求，迟到通道立即关闭；pending 实例同样参与终端归属查询，确保首次启动阶段的关闭能命中原 owner。远程创建设置 90 秒截止，到期后拒绝迟到激活；前端等待回执 120 秒，避免先报超时后又切入新 CLI。session custom entry `webui/native-cli { version: 1, config }` 保存类型，即使没有聊天消息也显式写盘；从历史打开时恢复 CLI descriptor、分配当前 runtime 的 terminalId；保活会话优先挂接原进程，进程已结束时才按精确原生绑定启动续接进程。历史启动失败仍保留 CLI 类型，可显式重试；损坏或未知版本的类型元信息拒绝打开，避免误当聊天。原生聊天转录仍由 CLI 自身保存；独立 `webui/native-cli-state` 元信息保存精确会话绑定与事件游标，恢复时自动补原生续接参数。普通 PTY 不跨服务重启恢复进程或缓冲；启用 SSH tmux 保活后可重新挂接仍存活的原进程。
- 创建 CLI 后主动重建并推送所属项目的 `sessions` 历史列表，不依赖 SDK 消息事件或用户再次展开项目；若创建前的目录扫描仍在进行，待其结束后丢弃旧缓存再扫描。历史扫描器从同一 `webui/native-cli` marker 提取配置，`SessionSummary.nativeCli?: NativeCliConfig` 投影历史类型（没有运行时 `terminalId`）；零 SDK 消息仍保持 `messageCount: 0`，不伪造普通聊天消息。增量扫描、长配置行与改名均保留类型元信息。
- `NativeCliPanel` 只内嵌 `TermXterm`，没有独立 composer。用户直接在原生 CLI 输入文字；当前 CLI 激活时通过共享 `composer-bridge` target 与右栏 `App.attach` 将引用注入终端。引用走 `terminal_cli_paste`，以 `requestId` 等待 `terminal_cli_paste_result`；服务端清理控制字符后向同一 PTY 一次写入 bracketed paste，**不追加 Enter**，不通过屏幕文本猜测 CLI 是否等待输入。
- 异步读取页面、对话或画布时，先捕获目标 manager 与 PTY 进程实例；await 后只向原实例粘贴。切换对话不会改投新 CLI，退出后同 ID 重建的进程也拒绝接收旧请求。物化或粘贴失败、断线、ACK 超时显示 notice，不自动 Enter，不自动重试。
- 文件和目录传真实路径，可附行号；显式选取的绝对路径沿用普通附件策略，允许右栏机器浏览和额外 root 的引用。相对路径及其符号链接必须留在 CLI cwd 内；上传文件和图片保存到现有 per-client uploads 目录后传实际路径，uploadPath 始终校验当前客户端归属。图片是否可读由 CLI 决定，此功能不代表原生多模态注入。小段文本引用保留原文，超过 PTY 预算的引用落盘；已授权页面读取可见文本，对话读取真实转录，画布导出真实 JSON，交给 CLI 的是实际内容文件路径。读取失败或内容为空时失败回执，不降级为只有 URL/ID 的元信息。
- SSH 工作区支持 POSIX（Linux/macOS）远端 CLI。复用已保存的 SSH 主机、认证、known_hosts 与连接池，不增加独立凭据表；未知或变更的主机密钥仍通过现有 SSH 工作区流程确认。`cwd` 保持规范的 `ssh://user@host:port/path`，SDK 宿主与历史通过 `resolveWorkspaceSessionDir` 存在本机缓存，`.pi-remote-uri` 保留真实远端身份；启动、重开和历史恢复始终在对应远端目录执行。远端 Windows 暂不支持，不会降级到本机执行。
- 创建弹窗按需请求 `appUrl('/api/native-cli/discovery?cwd=…')`，显示可用预设和不可用原因（SSH 还显示主机、目录与保活状态）；关闭、重试或切换项目时取消旧检测并忽略迟到结果。API 受现有鉴权与 terminal 功能开关保护。远端检测与启动共用远端 PATH，覆盖原生、agy、npm/pnpm/Volta/fnm/nvm 安装目录；不使用本机 Node、PATH 或 `.cmd`。自定义可执行文件填写远端命令或路径。SSH 预设必须由检测确认才可点击，本地预设只在检测明确报告缺席时禁用。
- SSH 使用 `createCommandPty` 的 exec + PTY 通道。非交互 POSIX 引导先验证目录与可执行权限并关闭回显，收到随机握手标记后通过 stdin 传入有界的安全引用环境变量；密钥不进入 exec 命令、argv、shell 历史、配置或日志。恢复终端模式后 exec 原生 CLI，不依赖远端 Python/Node，也不依赖 `AcceptEnv`。继承的模型地址必须从远端可访问，`localhost` 指向远端本机；不自动创建模型代理隧道。纯 POSIX 引导不能确认所有 execve 失败类型，坏解释器等立即退出仍通过退出事件呈现。
- 活跃远程 shell、CLI 与 exec 持有连接租约，阻止原 30 分钟空闲回收误关运行中的通道；完成、取消、断线均释放租约。未启用保活时，显式关闭只关闭所属通道；启用保活后先确认所属 tmux 实例停止。两者均保留共享连接上的其他会话，不会把 `exit` 当作 CLI 输入。断线后保留输出和退出状态，用户显式重开；原生菜单、工具权限和登录由 CLI 自己处理。
- 远程引用使用真实 POSIX 路径，默认验证同主机、工作区及 realpath/symlink 边界；工作区外绝对路径只能由服务端显式授权。本机 `uploadPath` 使用解析后的实例 `dataDir`（包含 `--data-dir` 覆盖）校验 per-client 归属，与物化引用的保存位置保持同源；图片、上传与页面/对话/画布物化文件经 SFTP 写入随机 `/tmp/pi-native-cli-<UUID>` 目录（0700），再粘贴远端路径；首期不递归上传目录。成功粘贴将暂存清理绑定到捕获的进程实例；保活会话同时持久化目录所有权，仅在确认进程退出或停止后清理。失败、取消与迟到 mkdir 也清理；离线清理失败保留路径并在服务运行期间后台退避重试。
- 左栏运行中的 CLI 对话单击关闭即发送 `dismiss_conversation`，确认进程停止后释放运行时并保留历史；停止失败保留对话供重试。历史记录删除仍需二次确认，`delete_session` 先确认所属进程停止并移出运行对话，再删除记录，适用于前台及后台 CLI。会话自带的 CLI 终端参与切换保活（`countBlockingLive`），但不计入阻止移出的用户终端（`countUserBlockingLive`）；用户另开的交互式终端和独立 CLI 标签仍保护现场。删除成功后推送记录所属项目的最新历史列表，跨项目及 SSH 历史无需刷新页面；删除前启动的旧列表扫描失效后重读，不能回灌已删记录。

## 原生 bash 生命周期

`resolve-global-sdk.ts` 预加载时注册 `patch-bash-process.ts` 的 Node 模块加载钩子，在 SDK 原生 shell 模块首次编译前应用内存兼容补丁（#794），同时覆盖自带与跟随 SDK，继续复用 SDK 的 shell 配置、环境及进程树清理。不改写任何已安装 SDK 文件。未识别的上游结构会输出警告，不静默假定已修复。CLI、生产、桌面和开发服务均须在入口之前预加载该模块；直接导入 SDK 的测试不注册钩子、不产生磁盘副作用。另一个加载钩子 `patch-executable-lookup.ts`（#810）用同样的方式把 SDK 的 `which` / `<cmd> --version` 子进程探测换成 PATH 扫描（Android/Termux 默认开启，见 `docs/env-vars.md`），同样只改写内存中的 ESM 源码，未识别的结构同样告警而非假定已修复。

执行 timeout 只约束主进程运行阶段；收到 `exit` 即保存真实退出码并停止执行计时，之后等待输出关闭或 100ms 静默。输出收尾另有不可被持续输出延长的 1 秒上限，触及时明确标注停止收集并关闭本地读取端，避免后台子进程持有继承管道造成无限等待。正常退出不主动杀后台任务。取消及真正执行超时会调用 SDK 的进程树终止，并最多等待 1 秒清理，即使未收到 `exit`/`close` 也结算。所有结算路径释放监听器、输出流和计时器。

`timeout` 不改变原生/PTY 路由或持久性；Windows 仍只在显式 `persist: true` 且开启终端接管时走持久终端，避免一次性控制台耗尽。

`abort_bash` 的可选 `conversationId` 精确指定当前客户端持有的会话，省略时仅使用当前会话，不查找其他运行命令。原生、终端和扩展 bash 的控制器统一挂在稳定的 `Conversation` 对象上，执行时解析归属，随过户与 ID 冲突改名一起迁移。取消前捕获目标 runtime，停止提示只注入该 runtime；前端切换会话期间不发送停止请求。

### 原生会话续接、远程保活与状态

- `webui/native-cli-state { version: 1, key, preset, cwd, nativeId?, processId?, lastEventId?, seenEventIds, stagingPaths? }` 是服务端所有的绑定元信息，与客户端可填写的 `NativeCliConfig` 分开。`key` 是独立 UUID，历史恢复校验引擎和工作区，不按项目「最近一次」猜测原生会话。内部 hook 参数、提供商密钥、脚本内容不进入公开配置或快照；返回的启动配置只用于当前进程。
- Pi 使用独立会话目录和精确 `--session`；Claude 使用同一 UUID 的 `--session-id` / `--resume`；支持官方 hooks 的 Codex 从 SessionStart 捕获精确线程 ID，后续 `resume <ID>`，不回退 `--last`。agy 支持基于 `--settings` 的 hooks 生命周期事件与首次 ID 捕获（SessionStart / PreInvocation / PreToolUse / Stop），用户传 `--disable-hooks` 时降级为进程状态；dsh 与 Custom 保留进程状态。用户显式会话参数优先；绑定会话已丢失时明确失败，不换成别人的历史。相同 key 的 `native-id` 在对应转录验证存在后可恢复父层尚未持久的 ID 或会话切换；不读取项目 latest。
- 生命周期来自官方事件：Pi 的 interactive input、agent_settled、用户提问事件，以及 Claude/Codex 的 SessionStart、UserPromptSubmit、Stop、PermissionRequest 等。`working` 不等价于用户发送；独立 `submitted` 才投影为 `native_cli_prompt_submitted`，供侧栏排序消费，不触发 OS 通知。用户现有 hooks/settings 保持优先，Codex 按事件避让（包含合法 TOML 引号键）；没有可靠事件时降级为进程状态，不解析屏幕猜测完成或授权。新增 hooks 的首次信任由 CLI 自身官方界面处理，不跳过权限。
- 原生记录位于本地 `<dataDir>/native-cli/<key>` 或远端 `~/.pi-web/native-cli/<key>`，私有目录 0700、记录/脚本 0600。事件文件有界；恢复时按持久游标继续消费，无游标的历史基线不重放提交或完成事件。派生身份事件独立去重，只有原始 SessionStart 的 cursor 或后续语义事件推进游标，避免身份落盘后中断丢失完成。新进程不回放旧进程活动或提问，挂接活进程则继续补读。观察器错误和合成进程错误不替换原生游标。自然退出先 `flush()` 再停止观察，取消的 done 仅更新空闲状态，不发送完成通知。
- `NativeCliConversation.status` 提供启动、运行、工作、等待输入/授权、断开、退出与错误信息，以及最近活动、原生 ID 和续接能力。单轮错误保留活 PTY 可写，只显示错误；SSH 断开不当作任务完成。可靠 done/error/question/approval 同时走有界去重的浏览器事件与统一 `onNotificationEvent` 手机通知接口；导航使用宿主 Web/SDK sessionId，原生 ID 仅用于续接和显示，通知不携带正文。手机等只读共享视图仅展示状态与原生 ID，不挂接 PTY、注册 composer 或显示进程控制；原生提问和权限操作仍需在拥有该 CLI 的可写窗口处理。
- SSH 创建弹窗按需检测 tmux（要求 ≥3.2），默认不启用保活。勾选后通过固定 `TMUX_TMPDIR=/tmp` 与 `tmux -L pi-web-cli-<UUID>` 使用 UID 私有 socket 目录，避开超长 HOME 的 Unix socket 长度限制。每次实际新建写随机实例 generation；原子创建、probe、attach 与 handle stop 校验实例，旧 handle 不会终止同 key 的新进程。`remain-on-exit` 保留退出状态，宿主定期 probe 获取真实退出码；网络不可达不能当作已结束。
- 「断开连接」只关闭当前 attachment，保留远端进程、观察器与仍在使用的附件；「重新连接」优先 probe + 严格 attach-only，已有进程不依赖旧 CLI 路径、当前模型凭据或转录文件仍存在，原 CLI 已升级/提供商已变更也可重挂。挂接期间实例消失则报重试，不启动占位程序。只有进程确实不存在时才重新解析 CLI、模型并走精确续接。
- 「停止」、显式关闭对话或删除历史先确认远端 stop；确认失败保留归属/历史供重试。服务关闭、SSH 丢线及用户 detach 都不发送 stop；待重连 manager 的关服路径同样使用 `shutdown: true`。同一 terminalId 的 stop/create 串行，跨 await 校验实例，取消清理完成前不复用待启动槽。历史没有 live handle 时可按已验证绑定独立 stop，不需要启动 CLI。
- 保活会话把 SFTP 暂存目录所有权写进绑定，断线或关服不删仍可能被远端任务读取的文件；确认退出/停止后清理，失联失败进入现有退避清理队列。该实现不保证本机服务停止期间发送通知，也不自动安装 tmux 或搭建模型网络隧道。

## 终端管理

- **用户终端与 Agent 终端分层**：
  - **用户直接创建的终端**（UI 加号新建、运行自定义命令，`agentBash !== true`）：归属于 `ClientSession`（工作区级别），按客户端存活；在终端列表中**始终显示**，不再受单个对话切换、回退、删除或生命周期的影响和过滤；输出实时直接下发；只有用户手动关闭或进程自身退出时才销毁。
  - **CLI 会话终端**：归属于单个 CLI `Conversation`，切换始终保留，关闭对话才回收；不进入 client-owned 全局终端标签。
  - **Agent 内部接管/调用的终端**（`agentBash: true` 或 agent 工具调用的交互终端）：归属于单个 `Conversation`，跟随该对话的生命周期与活力检测（静默 ≥15s 注入 steer 提醒）。
- **统一列表推送与路由**：服务端 `pushTerminals()` 自动合并用户终端与当前对话的 Agent 终端；`handleTerminalMessage` 对输入（`terminal_input`）、大小调整（`terminal_resize`）、关闭（`terminal_kill`）、重命名（`rename_terminal`）通过 `findTerminalManager` 全局索引匹配目标终端，跨对话操作无缝直达。
- **所有 spawn 路径统一准入**：`terminal_create`（浏览器/agent）与 `run_command`（命令列表）共用 `validateId`（字母/数字/.-_:/≤80 字符）+ `ensureSpawnAllowed`（新 live PTY 需低于 `MAX_TERMINALS`；已在运行的同名终端原地重启不占新名额；**history 里的已退出终端不保留名额**——满员时重跑已退出终端同样拒绝，堵住"唯一 ID 无限生成 PTY"的洞）；失败统一走 `fail()`（notice + 终端内红色报错 + terminal_exit）。

## terminal_key 按键编码

`encodeTerminalKey(key, modifiers)` 是纯函数（导出，字节级断言在 terminal-smoke-test.mjs）：命名键按名称路由，Ctrl/Alt 组合绝不回退成"Ctrl+首字母"——Ctrl+ArrowUp=`ESC[1;5A`（非 Ctrl+A）、Ctrl+Enter=`ESC[13;5u`（非 Ctrl+E）；方向键/F1–F4/Home/End 带修饰符时用 xterm 修饰序列 `ESC[1;<m>X`，其余命名键用 CSI-u `ESC[<code>;<m>u`，普通字符 Ctrl 映射 A–Z→0x01–0x1A、Shift 大写、Alt 前缀 ESC。

## 输出合并

输出经带 `conversationId` 的 `terminal_output` 推给浏览器；未挂载终端保留 2MB 输出窗口，切回对话时回放。socket 断开不杀 PTY；切换/重连保留状态，对话被释放或服务关闭时才杀掉全部 PTY。

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

防骚扰设计：①用户手开的终端永不参与（只有工具包装层调 noteAgentActivity，浏览器路径不调）；②一次性——触发后解除武装，agent 再次触碰才重新计时；③纪元内任何输出/输入都重置倒计时；④退出/关闭即拆钟。提醒文案本身就是自包含的 steer 消息（含终端的 id、最近输出、建议的 read/input/key/close 动作），它已告知模型该怎么做；全局终端引导段已下线，不再另占系统提示词。回归：`tests/terminal-idle-test.mjs`（直接实例化 TerminalManager + 小阈值，零 token 不起 server；win32 未验证）。

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

`TerminalInfo.ownerKind` 明确 `client` / `conversation`，与 `agentBash` 用途字段分离。普通 AI 创建的 shell 也属于 conversation；输入、resize、关闭、重命名和输出均携带归属，拒绝把同 ID 的另一归属终端当作回退目标。用户终端以当前项目根校验新建目录，已有进程的 cwd 与归属保持不变。服务端推送的是用户终端与当前对话终端的完整列表，前端权威对账并保留退出历史。会话管理器自己的 `terminal_list` 必须经 `pushTerminals()` 合并，后台会话的列表变动不直接覆盖前台。合并列表及 `ownerKind=client` 的输出/退出不经过当前对话信封过滤；列表先于新快照到达时保留两边会话身份，渲染层仅展示当前会话的行，避免丢掉客户端 CLI 或把另一个会话的终端显示进来。

持久边界是同一服务进程内的 shell 复用与页面断线保活，不提供服务重启后的进程恢复。

## macOS launchd / TCC 问题

macOS 下若服务由 launchd 拉起（`process.ppid === 1`，LaunchAgent/孤儿进程），TCC 会把相机/麦克风权限归因到 node 本身（无 App Bundle、无 Info.plist）而静默拒绝——ffmpeg 取流会卡死在取帧。`terminals.ts` 检测该场景，在客户端首次创建终端时输出提示（改 url/文件源，或在自己已授权的终端里前台运行）。

## Windows shell 解析

`terminals.ts` 的 `resolveShell()` 每次创建终端时解析，优先 bash——`PI_WEB_SHELL` 显式 → `$SHELL` → Git Bash（ProgramFiles）→ busybox 兜底（`~/.pi-web/bin/bash.exe`，`ensure-bash.ts` 无 Git Bash 时自动下载 busybox-w32）→ `$COMSPEC` → powershell。与 SDK bash 工具（Git Bash / PATH 上的 bash）保持一致，避免 PowerShell/bash 混用挂死。

bash 工具本身与 pi CLI 同源：`server/bash-tool.ts` 把 `settings.json` 的 `shellPath`（全局 agent 目录 + 项目 `.pi/settings.json`，`SettingsManager.getShellPath()`）透传给 `createLocalBashOperations`，缺失时才是上面那套 Git Bash / PATH 探测（issue #866）。终端面板不读该配置——它只认 `PI_WEB_SHELL`，两者的差异是故意的：终端是给用户看一眼的可见 shell，bash 工具要跟 CLI 行为对齐。
