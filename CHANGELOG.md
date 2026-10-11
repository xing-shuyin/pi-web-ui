# Changelog

> 面向使用者的版本变更记录：升级前先看这里，再决定是否升级。
> 版本号规则：npm 上的版本不带 `v` 前缀（如 `0.70.0`），GitHub 的 tag / Release 带 `v` 前缀（如 `v0.70.0`），两者数字部分一一对应。
> 日期为 npm 发布时间（UTC+8 换算后的日历日）。

格式说明：`Added` 新增功能、`Fixed` 修复、`Changed` 行为/样式变更、`i18n` 多语言相关。
每个版本的内容按"实际合入该版本发布的提交"归档（以 `package.json` 的 version 变更提交为准），
而不是按提交日期聚类——连续快速发布的 patch 版本以此为准最准确。

## [Unreleased]

## [0.103.1] — 2026-10-11

### Fixed

- **终端退出事件分发与冒烟测试就绪状态加固** —— 修复 `TerminalManager` 在监听到底层 PTY 进程退出（`pty.onExit`）时因提前置位 `entry.exited` 导致 `exit()` 方法首行守卫误拦截，使得 `terminal_exit` 事件无法分发至客户端的缺陷；加固 `terminal-smoke-test` 中子进程创建与命令回显的异步轮询等待，确保不同平台与慢速 CI 环境下测试结果确定性。

## [0.103.0] — 2026-10-11

### Added

- **远程工作区支持（Remote SSH Workspace）** —— 支持通过 `ssh://[user@]host[:port]/path` URI 直接连接远程 Linux/Unix 主机作为当前对话的工作区；本地提供安全的工作区会话投影（`remote-workspaces/<slug>`），所有对话记录、草稿与运行数据 100% 在本地安全落盘；文件服务、SCM 版本管理、终端 PTY、只读探测与文件读写工具全面原生适配远程执行。
- **远程主机配置与环境探针（Remote Host & Probe）** —— 目录浏览器新增远程 SSH 模式；支持保存并管理多个远程连接配置；连接建立后自动探测远端系统架构及 Git / Node / Bash 基础工具安装情况，并提供工具缺失一键自动安装引导；支持直接浏览远程服务器文件树并一键打开作为工作区。
- **虚拟 TUI 交互浮层（Virtual TUI Modal & Bridge）** —— 终端管理器新增虚拟 TUI 浮层支持；当工具启动交互式命令行或全屏终端应用时，Web 前端自动唤起全屏/半屏 TUI 交互弹窗，无缝桥接键盘输入与屏幕缓冲区渲染。
- **官网与文档中心导航指引** —— README 首页新增 pi-web-ui 官方网站与详细文档中心快捷访问链接。

### Fixed

- **会话物理路径与远程目录解析健壮性** —— 修复在部分未初始化或 mock 状态下 `stateStore` 访问异常的问题，并在非远程工作区场景提供零损耗快速回退。
- **样式与 CSS 变量兼容性修复** —— 统一目录浏览器 SSH 相关面板的 Hover 高亮样式为系统标准 `--bg-elev2`，消除未定义变量告警。

<!-- auto-i18n:start -->
### i18n

- 前端新增 key（21）：`workspaceModeLocal`、`workspaceModeRemote`、`sshHost`、`sshPort`、`sshUser`、`sshAuthType`、`sshPassword`、`sshKeyPath`、`sshAgent`、`sshSaveProfile`、`sshProfileName`、`sshConnectAndProbe`、`sshConnecting`、`sshSavedProfiles`、`sshInstallTool`、`sshInstalling`、`sshSkipAndBrowse`、`sshOpenRemoteWorkspace`、`sshDisconnect`、`sshDeleteProfileConfirm`、`tuiOverlayTitle`
<!-- auto-i18n:end -->

## [0.102.0] — 2026-10-10

### Added

- **问卷卡片与交互式选项组件（QuestionnaireCard）** —— 在对话消息流中支持内联交互式问卷卡片，清晰呈现多分支选项、推荐选项徽标与单选/多选表单；支持键盘数字快捷键快速选定；支持附带原因拒绝或提交自定义说明；支持问卷草稿持久化与会话切换恢复（`question-draft`）。
- **CodeMode 代码运行模式与 Token 预算配置** —— 设置面板支持针对 CodeMode 工具进行模式切换（常规模式 `on` / 严格纯代码模式 `only`）以及内联提示词 Token 预算调节（`codemodeInlineBudget`），参数完整纳入预设共享与白名单体系。
- **插件升级自动保护凭据与持久化存储** —— CLI 在插件升级或强制重装时自动暂存并无损还原 `config.json`、`secrets.bin` 与 `storage.json`，防止插件升级导致凭据与私有状态丢失；新增内置插件版本变更守卫单测，保证插件代码更新时版本号严格递增。
- **桌面端会话深度链接与打包流程增强（#583 #584 #587）** —— 桌面端支持会话深度链接拉起；优化打包健康探测与 Token 鉴权流程；支持提示词模板填入时二次确认覆盖或追加（#586）；CI 集成 SignPath Windows 安装包测试签名。
- **SFTP 插件深度增强与引擎优化** —— 扩充默认 SSH 私钥探测路径与连接稳定性；优化客户端文件操作列表与动作响应机制。

<!-- auto-i18n:start -->
### i18n

- 前端新增 key（28）：`modelQuestionRejectWithNote`、`modelQuestionRejectWithNoteTip`、`recommended`、`keyShortcutTip`、`questionCardWaiting`、`questionCardCancelled`、`questionCardRejectReason`、`questionCardUserCustom`、`questionCardNoSelection`、`tpl.confirmFillTitle`、`tpl.confirmFillDesc`、`tpl.confirmFillAppend`、`tpl.confirmFillOverwrite`、`pluginOfficialMarket`、`pluginOfficialMarketHint`、`pluginOfficialLink`、`pluginOfficialLinkHint`、`copyConversationLink`、`copyMessageLink`、`codemodeModeLabel`、`codemodeModeHint`、`codemodeModeOn`、`codemodeModeOnly`、`codemodeInlineBudgetLabel`、`codemodeInlineBudgetHint`、`codemodeNestedApprovalBadge`、`codemodeNestedApprovalDesc`、`codemodeSavedImages`
<!-- auto-i18n:end -->

## [0.101.0] — 2026-10-10

### Added

- **消息列表常驻渲染窗口可配置（#570）** —— 设置面板新增「常驻渲染消息数」（`keepRecentMessages`，范围 5–100 条，默认 15），用户可按机器性能与对话习惯自定义尾部完整渲染的消息数量，更早的历史消息自动折叠为可展开的摘要行；同时将惰性窗口化（占位符渲染）门槛与折叠判据解耦，配置项完整纳入预设白名单管理。
- **扩展左栏插件插槽与分区管理并支持插件登记运行态条目** —— 左栏插件插槽体系扩充，支持插件按项目工作区、运行中会话与历史会话三个不同分区分别登记插槽动作；开放插件向左栏直接注册带状态徽标（运行中/已完成/出错）的实时运行态条目。
- **插件市场收录 md-chat 社区对话归档插件（#581）** —— 官方插件清单新增 md-chat 社区对话归档插件，支持一键浏览与归档 Markdown 格式的会话记录。

### Fixed

- **终端输出清洗与 ConPTY 吞输出彻底修复（#571、#572、#573）** —— 修复 Windows ConPTY 下由于哨兵未如期在真实输出之前回显，导致正文输出被整段误删吞掉的问题；终端输出清洗不再死板假定哨兵与正文顺序；哨兵每次执行注入随机 nonce，清洗严格按注入位置删行，规避真实输出包含哨兵字面量时被误杀；收尾清洗去除提示符残留；修复未闭合括号组或括号内部管道 `|` 被当成顶层限输出管道拆分的 Bug，未闭合组不再注入哨兵；语法不完整的 bash 命令直接拒绝并返回明确语法错误（不注入、不建空终端），不再空等后误判为「后台运行」；`#` 注释不再误判未闭合引号或管道；`terminal_read` 增加 `commandPending` 状态标志。
- **Windows 上扩展加载支持 file:// 协议 URL（#580）** —— Windows 平台上 `--import` 绝对路径（含驱动器盘符 `C:\`）改用 `file://` URL 规范传入 Node.js，修复 Node.js ESM 加载器抛出 `ERR_UNSUPPORTED_ESM_URL_SCHEME` 导致服务无法启动的严重问题，并补充加载异常捕获与友好控制台日志。
- **命令审批高危命中全量列出与规则表单源化（#578）** —— 命令审批弹窗中，同一规则在多段或复合命令中的每处命中均完整高亮并列出；卡片与降级高亮统一收敛至后端规则引擎事实源（彻底移除前端维护的第二份黑名单）；补充 `git reset --hard`、`git clean -f` 等 git 破坏性操作的匹配规则。
- **会话清理不误杀第三方后台任务（#576）** —— 当当前进程内检测到正在运行的第三方后台任务（如 `.pi/tasks` 托管的任务）时保留会话运行时，切换工作目录或从界面移出会话时不再误发 SIGTERM 信号杀掉正在跑的后台任务。
- **悬空工具调用结果归因明确化（#574）** —— 服务重启或意外中断导致的悬空工具调用，合成结果按真实原因归因，不再一律误报为「超时/流卡死」，并向模型与用户友好提示命令可能已在系统后台部分执行。
- **用户主动中止渲染为中性状态（#575）** —— 用户主动点击停止或因新交互被抢占的回合，统一在中性样式下渲染为「已中止本轮」，消除红色的报错视觉干扰与不适宜的「立刻重试」按钮。
- **显式移出会话不再受「刚聊过」保护误拦（#579）** —— 会话列表中点击 ✕ 显式移出会话时，准确识别用户明确意图，不再被「刚聊过」安全保护拦截，避免弹出误导性文案。
- **会话置顶标记 📌 前置防截断（#568）** —— 左侧栏会话列表中将置顶图钉图标前置放置在会话标题前，避免因长标题发生 CSS 省略截断而将置顶标记完全隐藏。
- **跨标签页会话运行时去重与分支校准（#567）** —— 消除跨客户端或多标签页打开同一会话时可能产生的重复运行时实例，并在分支切换后校准过期的叶子节点引用。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（130）：`settingsMcp`、`settingsMcpDesc`、`mcpReload`、`mcpAddServer`、`mcpFilterAll`、`mcpFilterGlobal`、`mcpFilterProject`、`mcpGlobalPath`、`mcpProjectPath`、`mcpEmptyTitle`、`mcpEmptyDesc`、`mcpQuickAdd`、`mcpScopeGlobal`、`mcpScopeProject`、`mcpScopeGlobalHint`、`mcpScopeProjectHint`、`mcpStatusRunning`、`mcpStatusStopped`、`mcpStatusError`、`mcpEnableHint`、`mcpDisableHint`、`mcpToolsCount`、`mcpDeleteConfirmTitle`、`mcpDeleteConfirmDesc`、`mcpAddModalTitle`、`mcpEditModalTitle`、`mcpPresetSelect`、`mcpScopeLabel`、`mcpNameLabel`、`mcpNamePlaceholder`、`mcpTransportLabel`、`mcpTransportStdio`、`mcpTransportHttp`、`mcpCommandLabel`、`mcpCommandPlaceholder`、`mcpArgsLabel`、`mcpArgsPlaceholder`、`mcpCwdLabel`、`mcpCwdPlaceholder`、`mcpEnvLabel`、`mcpAddEnv`、`mcpEnvKeyPlaceholder`、`mcpEnvValuePlaceholder`、`mcpUrlLabel`、`mcpUrlPlaceholder`、`mcpHeadersLabel`、`mcpAddHeader`、`mcpHeaderKeyPlaceholder`、`mcpHeaderValuePlaceholder`、`mcpDescriptionLabel`、`mcpDescriptionPlaceholder`、`mcpEnabledLabel`、`mcpEnabledDesc`、`mcpPresetCustom`、`mcpPresetCustomDesc`、`mcpPresetFilesystem`、`mcpPresetFilesystemDesc`、`mcpPresetFetch`、`mcpPresetFetchDesc`、`mcpPresetMemory`、`mcpPresetMemoryDesc`、`mcpPresetGithub`、`mcpPresetGithubDesc`、`mcpPresetSqlite`、`mcpPresetSqliteDesc`、`mcpTabConfigured`、`mcpTabMarket`、`mcpBrowseMarket`、`mcpMarketSearchPlaceholder`、`mcpBadgeOfficial`、`mcpConfigured`、`mcpAddGlobal`、`mcpAddProject`、`mcpAddGlobalHint`、`mcpAddProjectHint`、`skillTabInstalled`、`skillTabMarket`、`skillEmptyDesc`、`skillBrowseMarket`、`skillMarketSearchPlaceholder`、`skillCatAll`、`skillCatQuality`、`skillCatWorkflow`、`skillCatArchitecture`、`skillCatDevops`、`skillCatStack`、`skillInspectPrompt`、`skillInstalled`、`skillInstallGlobal`、`skillInstallProject`、`skillInstallGlobalHint`、`skillInstallProjectHint`、`skillInspectModalTitle`、`mcpSourceSelectLabel`、`mcpSourceSmithery`、`mcpSourceGithub`、`mcpSourceCustom`、`mcpSourceCustomPlaceholder`、`mcpMarketLoading`、`mcpMarketRetry`、`skillRepoSelect`、`skillRepoDefault`、`skillRepoCustom`、`skillRepoCustomPlaceholder`、`skillMarketLoading`、`skillContentLoading`、`skillMarketRetry`、`turnStopped`、`keepRecent`、`keepRecentDesc`、`uiLayoutLeftProjectsActions`、`uiLayoutLeftProject`、`uiLayoutLeftRunningActions`、`uiLayoutLeftHistoryActions`、`uiLayoutLeftSections`、`uiLayoutLeftRunning`、`uiLayoutLeftHistory`、`leftPanelPluginGroup`、`pluginRunStatusRunning`、`pluginRunStatusDone`、`pluginRunStatusError`、`uiLayoutContextProject`、`codemodeEnabledDesc`、`codemodeOffHint`、`codemodeNestedCalls`、`codemodeScript`、`codemodeFullOutput`、`toolSearchEnabledDesc`、`toolSearchOffHint`、`toolSearchLoaded`
- 前端中文变更（1）：`pluginTopbarMore`
- 前端英文变更（1）：`pluginTopbarMore`
- 服务端新增 key（1）：`terminals.bash.incomplete`
- 服务端文案变更（2）：`scm.commitmsg.timeout`、`terminals.bash.timeout`
- 服务端删除 key（1）：`terminals.bash.nosentinel.note`

<!-- auto-i18n:end -->

## [0.100.0] — 2026-10-08

### Added

- **高危命令高亮与命中清单（#566）** —— 执行审查与人机协同审批全面强化：审批弹窗展示结构化的「高危命中清单」（精确指出命中哪条规则、哪个字段、第几个字符起以及命中片段内容），针对 bash 命令在转义 JSON 参数框上方呈现直观高亮的命令预览，解决多命令串联时肉眼难寻危险点的问题；对话中的终端命令卡片（`Message` 与 `ToolCallBlock`）以及审查者执行证据（`goal-evidence`）同步标记高危命令片段。判定单源来自同一规则引擎，保持纯展示增强与现有「显示即提交」参数契约。回归：`tests/unit/approval-rules.test.ts`、`tests/unit/tool-approval.test.ts`。
- **左栏「运行的对话」子代理可折叠（#564）** —— 父对话（挂有子代理时）行首增加展开/折叠箭头，点按可一键收起其所有后代子代理；折叠状态持久化在本地存储（刷新与切对话保持）。折叠后父行展示「{n} 个子代理」徽标；当后台子代理正在运行（绿色脉冲呼吸灯）、等待问卷输入（问号徽标）或报错时，父行徽标同步显色提示，绝不静默吞没子代理状态。关闭已结束子代理与会话右键菜单不受折叠影响。回归：`tests/unit/conv-groups.test.ts`。
- **工具描述可编辑（设置→工具区「编辑文案」）** —— 每个工具行新增编辑入口，三处模型可见文案都可逐工具覆盖：`description`（tool schema 里的工具说明）、`promptSnippet`（系统提示词 Available tools 列表的一行）、`promptGuidelines`（Guidelines 段要点）；留空 = 用工具自带默认（默认文案折叠可见，可一键恢复）。覆盖持久化在设置里（不进预设），改动即时对**所有工具**生效（核心内置 / 本项目工具 / 插件 / MCP），会话中途改动也会重新声明工具；DSH 引擎无 pi 工具注册面，入口隐藏。
- **工具延迟加载（默认开，可在设置→工具区关掉）** —— 默认只有核心工具（bash/read/edit/write）与 `load_tools` 的完整参数 schema 常驻；其余工具在系统提示词里只有「名字 + 一行摘要」（目录），模型要用时先调 `load_tools(["patch","lsp"])`，那批工具的 schema 才随之下发（加载后本对话后续轮次都可用；已被关闭/预设不允许/计划模式拦截的名字会被拒绝并给出原因）。常驻工具 schema 约 **33k → 7k 字符**，系统提示词也由 ~8.6k 降到 ~6.7k。**不损坏供应商前缀缓存**：系统提示词的目录段与已加载集合无关（逐字节不变）、被加载工具的 guidelines 随加载回执而非提示词、tools 数组只产生追加增量（回归 `lazy-tools-test` 逐字断言）。激活由用户/模型触发；只影响新会话与之后的门控重放，不会反向清空正在跑的对话。DSH 引擎不适用。
- **建议操作按钮（内联标记 `[[action:suggest:…]]`）** —— 模型可以在回复里挂一排「下一步」按钮：正文中的 `[[action:suggest:继续]]` 渲染成对话最底部的按钮，点一下就以该文字**作为用户消息**直接发出（你自己发新消息后建议自动清空）。按钮文字与实际发送内容可以不同：`[[action:suggest:看详情,prompt=把刚才的 diff 展开]]`（`label=` / `prompt=` 的 kwargs 写法同样支持），`[[action:clear:all]]` 清空当前建议。标记设置里对应新增「建议操作标记 action/suggest」（`suggest` 是别名），关掉即不解析；建议随对话落盘，刷新页面或过户到另一台设备后按钮仍在。
- **新插件「进程管家」（pm2-manager）** —— 把 AI 起的后台任务统一交给 pm2：顶栏「后台任务」面板里多出「pm2 托管的应用」一节（状态 / CPU / 内存 / 重启次数 / 日志，可单独停止、重启、删除），AI 同时拿到一个 `pm2` 工具（list / start / stop / restart / delete / logs / describe / install / version），两条路径看的是同一份列表。**插件不接管 bash**：不对命令做任何拦截或追加提示，用不用 pm2 由模型和用户自行决定。机器上没有 pm2 时面板里有「安装 pm2」按钮（`npm i -g pm2`），AI 也能直接装。安装：插件市场搜「进程管家」。
- **后台任务自动清理** —— AI 起的孤儿端口实例可以定时收拾：面板里选阈值（分钟；0 = 关，默认关；对应设置 / 预设字段「后台任务自动清理」），到点的实例被停掉；被 📌 钉住的永远不清理，另有「立即清理」按钮按当前阈值清一次（策略为关时兜底 30 分钟）。阈值改完即时生效，不用重启服务；pi 与 DSH 两个引擎行为一致。
- **设置 → 界面布局新增「编辑图标」入口** —— 以前只有侧栏能开拖拽式图标编辑器，现在设置面板的「界面布局」页签里直接有按钮打开它（同一个编辑器、同一份布局偏好）；该页签的条目清单里同时多了「后台任务面板」（`tasks.panel`），面板内的插件条目从此可排序 / 隐藏。

### Changed

- **「进程管家」插件不再强行接管后台启动** —— 移除 `host.onToolPre` 硬闸门（`nohup` / 尾部 `&` / `start` / `Start-Process` 等脱管写法不再被拒并指路）、`#bg-ok` 逃生门与随之而来的告知通知、`host.onToolPost` 的 pm2 复核催办，以及它配套的 `guardMode` 设置项；`description` / `promptGuidelines` 里「被拒后改用 action=start」那一条同步删除。插件现在只提供两样东西：`pm2` 工具（不变）与「pm2 托管的应用」面板（不再显示拦截开关状态）—— 拦不拦、用不用 pm2，回到模型与用户自己。

- **预设覆盖到全部设置 + 导入时可选** —— 「保存为预设 / 导出 / 分享到社区」现在携带**全部设置**（`ClientSettings` 47 个字段：逐工具文案覆盖、工具按需加载、各专用提示词、界面布局/显示/快捷短语、子代理默认模型、隐藏插件等，与设置页一一对应；字段清单与分组在零依赖的 `server/preset-fields.ts`，前后端共用）。旧版文档、以及「只导入一部分」都能用：`SettingsPreset` 改为 `Partial<ClientSettings>`，应用预设时缺哪个字段就保持当前值。**导入预览里可以按分组/按字段勾选**（默认全选；未勾选的字段不落盘、也不改你当前的值；一个都不勾则拒写）。仍不进预设的：标记开关、审批规则、子代理模板、以及纯前端 localStorage 偏好（墙纸/宽屏/声音通知等）——它们各在自己的存储里。
- **底栏 / 侧栏 / 顶栏的图标条目统一到同一个组件** —— 三处栏位原先各写一套「图标 + 文字 + 动作」渲染（图标尺寸、文字截断、悬停态、插件条目的点击分派各不相同，同一个插件在不同栏位表现不一致），现在统一走 `web/src/components/BarItem.tsx`：一份实现负责图标 / 文案 / 禁用态 / 点击分派，插件条目在三处外观与行为一致。顶栏里未被你显式排过序的插件视图默认从 Git 图标之后开始排，你拖过位置就严格按你的顺序。内部重构，已保存的布局偏好（排序 / 隐藏）不受影响。

- **工具描述进一步精简（模型可见文字 -11.0%，schema -1924 字符）** —— 去掉描述 / guidelines / 参数说明里已由 JSON Schema 约束、参数自身或另一处工具信息覆盖的重复句（`browser_page` 的 target/timeoutMs 说明与 op 矩阵重复、`delegate_task` 的模板名枚举与收集方式说明、`compact_context` 的 token 区间（schema 已有 min/max）、`subagent`/`conversation_read`/`present_files`/`schedule` 的多余措辞等），并按项目自身口径（description = 做什么 + 副作用，不写「何时用」）收紧多处文案；`lsp` 的动作表从多行压缩成一段（op 与语义不变）。`edit`：SDK 原描述与它自带的 guidelines 逐条复述同一批规则，无扩展覆盖时（fallback）改由本项目提供精简版（有扩展 edit 时仍用扩展文案，参数 schema/执行体不变）。30 个目录/核心工具：文字合计 12734→11328 字符，参数说明 19480→18594，下发工具 schema 35085→33161。
- **定时任务三件套合并为单 `schedule` 工具** —— `schedule_task` / `schedule_list` / `schedule_cancel` 三个独立工具合并为一个 action 式 `schedule`：`action=create` 建任务、`action=list` 查看、`action=cancel` 按 id 取消。工具条目从 3 个减为 1 个（设置页「工具」照常循环渲染；旧版本关掉过任意一个 `schedule_*` 的用户会保持关闭，禁用名单自动迁移）。计划 / 审查者 / 目标审查三道只读闸门的派发名单同步为 `schedule`（保守起见整工具拒，调度面在这三道闸门都不需要）。
- **webmail 插件六个 AI 工具合并为单 `mail` 工具** —— `mail_list` / `mail_read` / `mail_search` / `mail_send` / `mail_manage` / `mail_folders` 合并为一个 action 式 `mail`（`action=list|read|search|send|manage|folders`），邮件条数、正文、发信与批量标记/删除的返回文本与参数语义不变；`mail_send` 原有的「发送前先与用户确认一次」守则原样保留。工具条目从 6 个减为 1 个；设置页「注册的 AI 工具」开关同步为单行。
- **工具提示词全量收敛（少 18.5% 字符）** —— 模型同一轮里能同时看到三处工具信息（tool schema 的 `description`、`Available tools` 列表里的 `promptSnippet`、`Guidelines` 段里的 `promptGuidelines`），过去大量内容是同一句话的三份复述。现在职责严格分开：`description` 只写「做什么 + 副作用/边界」（≤600c）、`promptSnippet` 只写触发条件（≤80c、不再重复工具名前缀、不再复述描述）、`promptGuidelines` 只管「何时用/顺序/禁止/跨工具路由」；同一个参数块被多个工具复用的（SSH 凭据、数据库连接/库参数、桌面坐标）抽成共享常量。服务端内置工具少 6.1k 字符（-24.7%，其中 1.1k 是 `terminals.ts` 里**永不发送**的终端版 bash 文案死副本），插件侧少 3.8k（-13.5%）。bash 的提示词与参数 schema 统一到新增的 `server/tool-prompts.ts`（原生/终端/分流三路径单源）。守卫升级：`tests/unit/tool-prompt-hygiene.test.ts` 新增长度上限、snippet 工具名前缀、snippet/guideline 复述检测与同文件同义重复检测。
- **工作区影子快照作用域收敛到对话 cwd 子树（Dual-State Rollback）** —— 之前 `createWorkspaceSnapshot` / `restoreWorkspaceSnapshot` 按整仓处理（`git add -A` + `git read-tree -u --reset` + 裸 `git clean -fd`），对话 cwd 在子目录时回滚会误伤同仓库的兄弟目录与仓库根文件。现在快照只暂存 cwd 子树（`git add -A -- .`，commit-tree 顶层只有该子目录一个条目），还原区分根目录与子目录：根目录保持原有的原子 `read-tree` + `clean`；子目录采用「`git rm -r --cached` + `git checkout <ref> -- <前缀>` + `git clean -fd -- <前缀>`」，前缀取自 `git rev-parse --show-prefix` 并以 `:(top)` 锚定到仓库根，快照中无对应子树文件时容错跳过检出；兄弟目录与仓库根在还原后保持被篡改的状态不变。回归：`tests/unit/workspace-snapshot.test.ts`（覆盖子目录、嵌套子目录、空子目录与空根目录作用域用例）。

### Fixed

- **SDK 跟随逻辑支持 PATH 与多全局包管理器探测（#559）** —— 修复在 git 克隆部署或直跑 dist 场景下，祖先链扫描够不到全局 prefix 导致「安装全局引擎后重启界面仍跑旧自带副本」的问题。新增 PATH 探测（符号链接、Windows .cmd/.ps1 解析、同级/上级 node_modules）与 npm/pnpm 全局 prefix 目录探测，并保持绝不降级的既有口径。回归：`tests/unit/sdk-origin.test.ts`。
- **pnpm 隔离安装下 SDK 缺失导致启动崩溃修复（#562）** —— 修复 pnpm 全局安装在裁剪/隔离可选依赖时，因未安装自带副本且 Node 静态 import 找不到 `@earendil-works/pi-coding-agent` 而抛错崩溃的问题。当检测到随包自带副本不存在时，自动切换至选用机器上发现的可用全局 SDK 副本，并在钩子中补充 `typebox` 的兜底解析路径；若全机均未安装任何 SDK，启动时输出双语清晰指引。回归：`tests/unit/resolve-global-sdk.test.ts`。
- **问卷「补充回答」输入框里敲英文按回车，不再被当成提交** —— macOS 中文输入法（鼠须管 / Squirrel、微信输入法等）在编码态下敲 Enter 是「把未上屏的编码原样上屏」，但问卷输入框只判了 `e.key === "Enter"`，于是那记上屏回车直接触发「下一步 / 提交」，刚上屏的文字被当作答案发给模型、面板随之收起，而服务端挂起提问已 resolve，**没有修改答案的入口**。现在问卷输入框与聊天输入框共用同一套输入法判定（组合态 `isComposing`、退化环境的 `keyCode 229`、以及 compositionend 后 50ms 内的那个 `isComposing=false` 回车），上屏回车一律放行给输入法；聊天输入框的既有行为不变。回归：`tests/unit/dsh-question-dialog.test.ts`、`tests/unit/ime-guard.test.ts`。

- **界面布局页的「改名」对内置条目是假承诺** —— 底栏数字徽标（上下文 / 成本 / 缓存命中 / 消息数 / 连接态…）与顶栏按钮的文案一直是写死的 i18n 与实际数值，改名只写进设置页那一行、界面上不动，重开设置有值、条目标题却还是旧的。现在合并引擎给「被显式指定过的文案」打旗（`UiSlotEntry.labelExplicit`，用户改名与插件 `arrange.label` 都算），渲染层看旗让位：名字型条目用你的文案顶掉内置文案，数值型条目把名字插在数值前（改名只换名字，不吞掉实时数据；成本仍是 `名字 $0.0123`）。没改过名的条目渲染结果与旧版逐字节一致。回归：`tests/unit/bar-item-unified.test.ts`、`tests/ui-layout-ui-test.mjs`（该脚本里两处按「底栏文字里有『上下文』」定位的旧断言一并改成按条目 id 定位 —— 它们本来永远失败，只是脚本不在 CI 里没被发现）。
- **pi 启动时报「宿主提供的扩展包必须只声明在 peerDependencies」** —— `@earendil-works/pi-coding-agent` 与 `typebox` 同时躺在 `dependencies` 与 `peerDependencies` 里，pi 的扩展加载器一看到 `dependencies` 就告警（怕装下嵌套副本绕开加载器注入、搞出两份 typebox 运行时）。这两个包本包**确实要**用（服务端进程直接 import，`PI_WEB_SDK=bundled` 也承诺自带副本可用），所以移进 `optionalDependencies`：npm 默认照装（自带副本不丢），而加载器只读 `dependencies`，告警消失。守卫 `tests/unit/extension-host-packages.test.ts` 拦「谁搬回去」。
- **过户夭折后对话变成「幽灵会话」（#556）** —— 过户是「源会话先摘除、目标会话再接入」两步，中间那一瞬间对话两头都不挂；只要第二步报错，runtime 还在跑但谁的列表里都没有，刷新页面也找不回来，只有重启服务才能靠落盘会话恢复。现在这一步是**事务性**的：接入失败就把整包对话原样搬回源页面（含订阅 / 终端 / 待答问卷 / 待审批 / 看门狗剩余时间）并切回去，两边都收到诚实的回执；万不得已也宁可留在目标页面的运行列表里，绝不落到无人持有的空档。过户进来的主对话同时显式置 `listed`，即使后续切换失败也一定在运行列表里可见。回归：`tests/takeover-rollback-test.mjs`（故障注入）。
- **手机上关掉页面后，另一台设备上「看不到也过不了户」的对话现在能接管了** —— 手机上 run 途中把页面关掉（run 在服务端继续跑完），换一台设备打开网页时，那条对话此前既不在左栏「运行的对话」里（断连残骸按 #291 被跳过），也没法过户；落地提示却让人「在左栏过户或从历史里打开」，而从历史里打开等于给同一份 JSONL 造第二个 writer。现在断连残骸的对话行在宽限期内（`PI_WEB_OFFLINE_ROWS_TTL_MS`，默认 30 分钟）仍会下发，带「离线」徽标、点两次即可过户到当前页（跑动中的任务也搬 runtime 本体过来继续跑完）；宽限期过后行自动消失（#291「残骸不永久占位」仍然成立），`0`/`off` 可关掉离线行回到旧口径。回归：`tests/offline-takeover-test.mjs`、`tests/elsewhere-lifecycle-test.mjs`、`tests/unit/elsewhere-dedup.test.ts`。
- **朱批 / 朱批·夜 主题的行内代码看不清** —— 两套主题的 `--link-soft`（文件预览、问卷对话框里内联代码 chip 的前景色）恰好写反了：浅色主题拿了浅桃色 `#e8c9b8`、深色主题拿了深棕 `#5a3020`，叠上 chip 底色后对比度只剩 1.2~1.4:1（其余主题 2.4~12:1），行内代码几乎隐形。已对调为 `#5a3020`（浅色，8.4:1）/ `#e8c9b8`（深色，9.7:1）。新增守卫 `tests/unit/theme-inline-code-contrast.test.ts`：逐套主题体检 `--link-soft` 与 `--bg` 的对比度，拦「前景色写反」这类灾难性回归。
- **冷启动 / 手机唤醒后卡在加载态** —— 新标签页或刷新页面首次接入时，服务端重发的快照可能只是增量 `snapshot_delta`，客户端拿不到全量基线就一直停在加载态；现在「新连接首次快照」与「快照重发」一律强制走全量（`forceFull`）。另外手机锁屏 / 切后台挂一整晚后唤醒，连接常常是「开着但不通」的半死状态，页面现在会在 `visibilitychange` / `pageshow` / `online` 时主动校验并立刻重连（掐掉退避等待），不用再手动刷新。
- **新建分叉会把提问前面的附件卡片一起带进去** —— `fork` / 分支的截断点原先按「上一条消息」取，会把服务端提问前置注入的附件条目（文件引用等）算进上一轮，于是分叉出来的新会话开头挂着一份本该属于原轮次的附件卡片。现在截断点先上溯跳过这些前置条目，取到**本轮提问之前**的基准 entry（首轮提问则为空），补 `session-fork` 单测。
- **插件注册的守卫晚一步注入就不生效** —— 插件在服务启动之后才加载 / 重载时，此前已绑定的工具守卫读到的是空值，等于闸门静默失效。现在这类「可能晚一点才注入」的守卫包成**调用时解析**的代理（回归 `tests/unit/tool-guard-late-binding.test.ts`），启动顺序不再影响拦截。
- **点开「后台任务」面板时，进程管家那块总会闪一下「未检测到 pm2」** —— 面板 bundle 原先的初始状态写死 `installed:false`，首帧先把黄条画出来，状态回来后再抹掉；且宿主升级后 `<dataDir>/plugins` 里的已安装官方插件未自动同步更新（停留在旧版本）。现在三个层面彻底根治：① 服务端新增**随包官方插件自动热同步机制**（启动/重载时若已装插件版本落后于随包 catalog 官方插件，自动备份并增量升级，不再滞留旧版代码）；② 客户端增加**模块级已知状态缓存与异常隔离**（同一会话内二次打开首帧直接复用已知结论秒开无闪烁；网络或接口异常绝不把环境误报为「未检测到」）；③ 服务端扩充 Windows 默认 npm 与 PATH 候选路径，启动时毫秒级命中，并为探测增加 Promise 并发防抖。回归：`tests/unit/pm2-manager-panel.test.ts`、`tests/unit/plugin-manager.test.ts`。插件版本 0.3.1 → 0.3.2。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（97）：`bgTaskKeep`、`bgTaskKeepOn`、`bgTaskCleanup`、`bgTaskCleanupOff`、`bgTaskCleanupMinutes`、`bgTaskCleanupHint`、`bgTaskCleanNow`、`bgTaskCleanNowHint`、`collapseSubagents`、`expandSubagents`、`subagentBadgeCount`、`subagentsStreamingTip`、`subagentsQuestionTip`、`subagentsErrorTip`、`subagentsCountTip`、`toolApprovalHitsTitle`、`approvalHitPos`、`approvalCommandPreview`、`markerGroupAction`、`actionSuggestions`、`actionSuggestionsTip`、`toolLazyLoading`、`toolLazyLoadingDesc`、`uiLayoutTasksPanel`、`presetShare`、`presetShareShareBtn`、`presetShareImportBtn`、`presetShareBrowseBtn`、`presetShareTabExport`、`presetShareTabImport`、`presetShareTabBrowse`、`presetShareSource`、`presetShareSourceCurrent`、`presetShareDescription`、`presetShareDescriptionPlaceholder`、`presetShareTags`、`presetShareTagsPlaceholder`、`presetShareAuthor`、`presetExportJson`、`presetExportDownload`、`presetShareSubmit`、`presetShareHint`、`presetShareSubmitting`、`presetShareOpenWebTitle`、`presetShareOpenWebBtn`、`presetShareOpenIssueBtn`、`presetShareCopyJson`、`presetSharePopupBlocked`、`presetShareBrowserCopied`、`presetImportText`、`presetImportTextPlaceholder`、`presetImportPickFile`、`presetImportFromUrl`、`presetImportUrlPlaceholder`、`presetImportPreview`、`presetImportFields`、`presetImportIgnored`、`presetImportRejected`、`presetImportReplaces`、`presetImportApply`、`presetImportConfirm`、`presetImportPick`、`presetImportSelectAll`、`presetImportSelectNone`、`presetImportAllSelected`、`presetImportNoneSelected`、`presetImportPickHint`、`presetGroupPrompt`、`presetGroupTools`、`presetGroupTerminal`、`presetGroupSkills`、`presetGroupAi`、`presetGroupUi`、`presetGroupEngine`、`presetGroupOther`、`presetImportImported`、`presetBrowseEmpty`、`presetBrowseLoading`、`presetBrowseSearch`、`presetBrowseRefresh`、`presetBrowseCached`、`presetBrowseImport`、`presetBrowseIssue`、`presetBadgeTemplate`、`presetBadgeReview`、`toolPromptEdit`、`toolPromptEdited`、`toolPromptHint`、`toolPromptDescription`、`toolPromptSnippet`、`toolPromptGuidelines`、`toolPromptDefault`、`toolPromptReset`、`toolPromptSave`、`toolPromptUnavailable`、`elsewhereOfflineBadge`、`elsewhereOfflineTip`
- 前端中文变更（2）：`settingsMarkersDesc`、`scheduleTaskEnabledDesc`
- 前端英文变更（2）：`settingsMarkersDesc`、`scheduleTaskEnabledDesc`
- 服务端新增 key（38）：`loadtools.notready`、`loadtools.unknown`、`loadtools.always`、`loadtools.already`、`loadtools.disabled`、`loadtools.preset`、`goal.role.review.feedback.pass`、`goal.role.review.feedback.prev`、`goal.role.review.feedback.empty`、`loadtools.names.empty`、`loadtools.loaded`、`loadtools.rejected`、`loadtools.none`、`markers.action.guidance`、`markers.action.cleared`、`markers.action.unknown.operation`、`markers.action.requires.text`、`markers.action.already.exists`、`markers.action.added`、`presets.catalog.disabled`、`presets.catalog.url`、`presets.catalog.failed`、`presets.share.currentName`、`presets.share.missing`、`presets.import.noneSelected`、`presets.import.url.host`、`presets.import.url.scheme`、`presets.import.fetch.failed`、`presets.share.apiTokenInvalid`、`presets.share.apiTokenPermission`、`presets.share.apiGeneralFailed`、`presets.share.ghMissingHint`、`presets.share.ghNotLoggedInHint`、`presets.share.fallbackHint`、`presets.share.disabled`、`prompt.tools.lazy`、`sched.action.missing`、`sched.action.unknown`
- 服务端文案变更（4）：`goal.role.review`、`sched.list.empty`、`sched.cancel.empty.id`、`sched.cancel.not.found`

<!-- auto-i18n:end -->

## [0.99.0] — 2026-10-03

### Added

- **手机端边缘横滑抽屉手势** —— 从屏幕左/右边缘向内横滑拉出左侧会话面板或右侧工具面板，手势支持全行程实时跟手跟随、常驻遮罩层透明度渐显，并具备横向主导轴向识别与代码块/宽表格横向滚动元素避让。回归：`swipe-drawer.test.ts`、`swipe-drawer-ui-test`。
- **侧边图标停靠栏竖轴对齐（#443）** —— 侧边停靠栏（`SideDock`）支持「靠上 / 居中 / 靠下」三档竖轴对齐模式，三段贴边药丸自适应内容高度，并在设置页「界面布局」对齐选项及拖拽式图标编辑模式中打通。回归：`ui-layout-edit.test.ts`、`side-dock-align-ui-test`。

### Fixed

- **任务计划跨会话隔离防串台** —— `PlanManager` 架构重构：按持久化 `sessionId` 独立落盘至 `<dataDir>/plans.json`，而运行时按 `conversationId` 存入只活在进程内存的临时缓存，启动与载入时严格过滤易变短 ID（`c\d+`），绑定新会话时主动清理旧内存缓存，杜绝服务重启或短 ID 复用导致新会话被上一会话的任务串台附体。回归：`plan-state.test.ts`。
- **工具契约与运行时脱节修复（#462、#537）** —— 落地三处未对齐的契约细节：`eval` 将 `python` 别名统一归一为 `py`，非法语言显式抛错提示候选；`patch` 真正接入 schema 声明的 `timeout`（1-300s）超时控制并通过 Promise.race 竞速；`bash` 的 `head`/`tail` 参数严密钳制在 schema 上限 5000 以内，防止异常大数冲垮工具结果缓冲与转录。
- **目标模式 `stopDelegated` 串行化与时序窗口（#464、#536）** —— `stopDelegated` 改为按会话串行化队列执行，`setGoal`/`clearGoal`/`stopAllGoals` 增加 `await` 落定，解决满员边缘重设目标时旧执行者尚未完全移出、同步名额检查误报「名额已满」的问题。

### Changed

- **抽出 CollapsibleHead 公共壳组件（#476、#539）** —— 提取统一的 `CollapsibleHead` 组件，将 `ThinkingBlock`、`ToolCallBlock` 及 `Message`（附件卡/压缩摘要/技能卡）五处内联的可折叠区块头骨架代码收敛统一，键控行为与 ARIA 规范保持一致。
- **清理 memoizeWithTtl 死码并为手写 TTL 补充注释（#470、#538）** —— 移除全仓零消费的 `memoizeWithTtl` 死码，并为 `agent-service` 的 `piCliProbe`（安装后即时失效）与 `model-enrich` 的 `catalogCache`（双键异步 fetch）补充语义注释。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（3）：`uiLayoutAlignTop`、`uiLayoutAlignMiddle`、`uiLayoutAlignBottom`

<!-- auto-i18n:end -->

## [0.98.0] — 2026-10-03

### Added

- **聊天内容引用（#430）** —— 选中消息里的文字或代码，点浮动按钮即可把原文作为引用卡片加进输入框：支持多条引用、展开查看、逐条移除与重复去重，发送后能在历史消息里回看，编辑重问时保留。标准引擎与 DSH 引擎的消息序列化、草稿恢复、流式提问都已适配。回归：`quote-selection.test.ts`、`text-quote.test.ts`、`dsh-edit-quotes.test.ts`、`quote-selection-ui-test.mjs`。
- **图标编辑模式：拖拽调整四个栏的布局（#443）** —— 顶栏「⋯」→「编辑图标」进入。顶栏 / 底栏 / 左侧边栏 / 右侧边栏四个栏与「待放回」托盘同处一面板，把条目从一个栏拖到另一个栏、或拖回托盘，即直接改写同一份 `uiLayout`（order / align / slots / hidden），与设置页的布局选项实时互通；内置条目的图标名登记在 `host-icon.tsx`（否则编辑面板里只剩文字）。拖拽用 pointer 事件而非 HTML5 DnD（DnD 在触屏上不触发）。「⋯」溢出菜单因此改为顶栏有任意条目时常驻——否则用户根本进不来。回归：`ui-layout-edit.test.ts`、`host-icon.test.ts`、`ui-layout-ui-test`（真 Chrome）。
- **顶栏/底栏条目可移动到上下左右（右键路径）** —— 条目右键菜单新增「移至顶部 / 底部 / 左侧 / 右侧」，与上面的拖拽是同一份 `uiLayout` 的两个入口；左右侧边停靠栏可折叠展开，偏好持久化。
- **侧边图标停靠栏改为布局内槽位（#443）** —— `SideDock` 不再是 `position:fixed` 贴边浮层，而是 `.layout` 里的 flex 子项：面板与主区主动向它让出宽度，不再压住面板里的按钮；该侧没有图标时整条不渲染（连宽度都不占）。想要旧行为可在「设置 → 界面布局 → 侧边图标悬浮显示」（`uiLayout.sideDockFloat`）打开。
- **全屏预览增强** —— 预览头双击（避开按钮 / 链接 / 输入框）切换全屏；图片预览点击图片即关闭（`clickToCloseImage`）；HTML 预览工具条新增「在新标签页打开」外链（`openInNewTab`）；不需要编辑栏时页脚不再占位。
- **子代理 `wait_all` 阻塞上限可配（#449）** —— 上限从硬编码 60 秒提升到 0.8×看门狗（默认约 16 分钟），可用 `PI_WEB_SUBAGENT_WAIT_CAP_SECONDS` 覆盖：长子代理任务不再被迫每 60 秒重发一次 `wait_all` 烧轮次。
- **任务计划跨重启/跨刷新持久化** —— 计划不再只活在内存：按 `sessionId` 落盘到 `<dataDir>/plans.json`，并随会话转录（`plan/update` custom entry）一起走；重建会话时按「落盘文件 → 转录 → 历史 `plan_update` 工具调用」三重兼容顺序回放，旧会话也能找回看板。回归：`plan-state.test.ts`。
- **任务看板折叠态精简为单行状态条** —— 折叠时只留「标题 + 进度徽标 + 当前步骤」，进度以底边 2px 细线呈现（零额外高度）；「净室执行 / 复制 Markdown / 清空」收进展开态，「开始实施」在两种状态都可达。
- **`ask_user_question` 提问框可折叠（#480）** —— 模型提问卡支持折叠/展开，长问卷不再长期占满消息区。

### Fixed

- **系统提示词不再吞掉其他扩展的增补（#455）** —— 自定义了提示词模板/覆盖、或使用非 standard 预设、或禁用了工具时，内置的提示词组装曾整体替换该轮系统提示词，把别的扩展前置/后置注入的内容（如 `<invoked_skill>` 块）一起丢掉。现在会先把扩展的首尾增补摘出来，渲染完再原样套回去；子代理模板 replace 同样不再丢掉前置增补。
- **计划模式只读闸门堵住成体系旁路（#436）** —— 六处旁路一次性收口：`terminal_input`/`terminal_key` 从计划模式工具集里整条剔除（PTY 行编辑缓冲在 shell 进程里，无法在服务端可靠镜像，只查缓冲会同时误伤与漏放）；`eval` 补进计划 / 审查者 / 目标审查三道闸门的封禁名单（它是能直接落盘的写路径）；`BYPASS_TOOLS` / `DISPATCH_TOOLS` 里那批**根本不存在**的工具名（`spawn`/`subagent_spawn`/`schedule_agent`/`set_plan_mode` 等）换成真实注册名，并抽成共享的 `SESSION_DISPATCH_TOOLS`（`delegate_task` + 真实存在的 `schedule_task`），三处不再各自漂移；`subagent` 只放行 `get_result`/`list`/`templates`，`steer`/`stop`/`wait_all`/`handoff` 与未知/缺失 action 一律按旁路拒绝（`steer` 最狠：能把写指令注进一个 `planMode=false`、工具齐全的会话）；打开历史会话 / 派生分支 / 冷启动续会话三条注册路径补上 `applyToolGating` 重放，计划模式不再「闸门生效但写工具仍在模型视野里」。回归：`plan-mode` 相关单测。
- **计划模式有了可靠退出路径（#435）** —— 看板为空时整个 UI 曾无出口（开关已从输入框移除，唯一出口是看板里的「开始实施」）。现在空计划也能从目标条/看板退出计划模式，且状态随转录持久化后仍能正确恢复。
- **长驻服务内存单调上涨（#440）** —— `sessionFileCache` 原本是无上限的静态 Map，值里还带着整份转录文本（`allMessagesText`，长会话可达数 MB），删掉/改名/轮转出去的转录永远留在内存里。现在列表缓存改成 LRU 上限 512 条且只存元数据；全文搜索改为按需加载到独立小缓存（256 条、30 秒 TTL、单条 256K 字符上限），删除/改名失效与 200 候选的列表语义保持不变。
- **`client-state.json` 膨胀与界面冻结（#441）** —— 死 `clientId` 键（来自 sessionStorage，每开一个标签页就多一个）此前永不清理，文件与 `save()` 的同步序列化开销线性增长；`getRecentProjects()` 又会在截断到 30 条**之前**对每条合并路径做同步 `existsSync`，Windows 上一个断连网络盘就能把事件循环卡住数秒、冻住所有客户端的 WS/HTTP。现在加载时做保守清扫（30 天不活跃或超出 50 条上限才淘汰，`__settings__` 永不淘汰），探测改成先排序截断再用 `fsPromises.access` 并发探活，`discoverRecentProjectsFromDisk` 的三处同步调用一并异步化。
- **扁平布局下历史会话列表串项目（#438）** —— 设了 `PI_CODING_AGENT_SESSION_DIR` 时 pi 把各项目转录平铺在会话根目录（cwd 是文件内字段），但快路径从未按 cwd 过滤，导致 A 项目的历史面板里混进 B/C 项目的会话、点一下整个工作区就被切走。现在按全仓统一的 `normalizePathKey` 过滤，并且 200 条名额在**过滤之后**分配——别的项目不再把当前项目挤出自己的列表。
- **会话缓存首帧种子不校验 cwd（#439）** —— localStorage 里的会话缓存与快照守卫不看 cwd，刷新或切项目时会先显示上一个项目的会话；删除/重命名也不跨标签页失效。
- **LSP 截断口径如实上报（#447）** —— `cascade` 超 25 个引用方时静默截断且谎报完整，现在文本头与 `details` 都报真实总数并补「还有 N 个未分析」尾注；`documentSymbol` 改为按**展平后**的符号数截断（与文本大纲口径一致，截断的父节点连子树一起去掉），并加序列化体积预算，超大 `.d.ts` / protobuf 文件不再因为整条 `details` 超 64KB 被整块丢弃。
- **WS 半开连接与背压（#460）** —— 补上 ping/pong 半开连接回收；heartbeat / notice / 调度广播不再绕过 `bufferedAmount` 背压直写死 socket。
- **迟到的异步副作用复活（#461）** —— 反激活或连接失败后，迟到的异步回调曾把已该结束的东西重新拉起来：vscode-editor 留下僵尸 `connecting`、db-client 工具复活、webmail 泄漏 IMAP 连接、dsh-client 在 close 之后重启运行时。
- **`lsp`/`patch` 文案未接多语言（#463）** —— 工具返回文案恒英文、scheduler 校验错误中文直通，统一改走 `pick()`。
- **DSH 视觉附件链路无上限（#467）** —— 视觉附件链路补体量上限与 stdin 背压；`dsh-sessions` 的 zstd 魔数切帧误命中导致的静默丢事件一并修掉。
- **`ChatInput` 发送按钮白名单漏附件类型（#493）** —— `canSubmit` 漏了 `reference`/`lines`/`page` 附件：纯引用消息发送按钮恒灰但回车照发，流式胶囊也不出现。
- **后台问卷横幅「切入会话」永久消失（#494）** —— 它复用了 `onClose`，把 `questionId` 记进「已关闭」集合，未作答切走后就再也收不到常驻提醒。
- **插件目录授权并发覆盖（#495）** —— confirm 没有 busy 守卫，并发授权第二个覆盖第一个，先到的 Promise 永不 settle、悬挂整条 `openSession` 链。
- **@ 补全与全局搜索抢通道（#496）** —— 两者共用 `chat.fileSearch` 但 `reqId` 编号空间重叠，并发时结果交叉串 feed。
- **@ 补全浮层词元坐标失效（#442）** —— 光标移动或程序化改文后旧坐标仍被使用，接受补全会把正文拼接写坏。
- **纯附件提问「直接重问」无效（#443）** —— 只贴图不写字的提问上按钮可见但点击静默无效。
- **PWA 旧缓存永不淘汰（#504）** —— Service Worker 静态缓存名硬编码 `v1` 且 activate 只清异名缓存，升级后旧 hash 资产永久堆积。
- **受限网络下安装白等 7.5 分钟（#529）** —— 插件安装的探测/安装阶段补超时与快速失败。
- **语音输入两处（#445, #446）** —— auto 引擎下本地「超 8 分钟 413 / 忙 429」的前置拦截直接抛出、绕过远端兜底；Whisper 安装轮询器用全局 overlay 判活，可跨浮层存活并在完成回调里无条件 `startRecorderFlow`，劫持或双重开启录音。
- **vscode-editor「ssh config 自动加载」全链路失效（#429）** —— `loadFile` 作用域错误（ReferenceError 被静默吞掉），并加固了日志。
- **插件目录非中文语言下恒中文（#505, #432）** —— `catalog.json` 补 `nameEn` 字段并接进 schema 白名单与市场渲染，非 zh 语言不再恒显示中文名。
- **语言包「中文假翻译」（#502）** —— de/es/fr/it/ko/ru 六个包里各约 130 条的值是中文原文，而 pack 值优先于 en 回落，等于系统性地把中文当成译文发出去；逐条修正并补上文档（#478：README 工具清单、`wait_all` 描述、6 个环境变量、serverStrings 的 ja/pt 缺口）。
- **db-client 两处硬伤（#458）** —— 三家 SQL 长连接没有 `error` 监听，一个连接错误就能崩掉主进程；Mongo 的保存/删除 100% 抛 `ObjectId` ReferenceError（从未可用）。回归：`tests/unit`。
- **DSH 提问桥超时后队列永久停摆（#459）** —— `goal-rpc` 的 pending 超时后排队中的提问 Promise 永不 settle，agent 卡死在工具调用上；超时路径现在统一 settle 并派发下一个。
- **legado 规则引擎启动超时后永久瘫痪（#466）** —— worker 启动超时后 `ready` 永久 rejected，桥再也起不来；现在会复位 worker。`/store`、`/proxy` 的 `readRawBody` 补 10MB 上限。
- **`forceReset` 后事件订阅不重挂 / 幽灵重建（#484, #485）** —— 重建非活跃会话（子代理/角色对话）后事件订阅没挂回去，表现为快照冻结、看门狗失聪、`turnEndWaiters` 死等；强行关闭与 `forceReset` 交错还会把已移除会话幽灵重建，泄漏无主 runtime 与扩展宿主子进程。
- **模型列表刷新回滚并发编辑（#486）** —— `refreshProviderModels` 的读-改-写没有互斥，probe 的网络窗口里用户对同一服务商的编辑会被旧快照静默回滚；现在以盘上最新条目为合并基准。
- **abort/移除会话不结算挂起审批（#487）** —— `pendingQuestions`/`pendingApprovals` 里的悬挂条目会让失联检测被永久豁免，弹窗还会跨轮残留；现在就地结算。
- **`wait_all` 把「已移出」当「仍在运行」（#488）** —— 等待集合里含被移出的子代理时必然白等满 cap（#449 的放大）；现在视为终态。
- **插件 reload 让剩余守卫整体跳过（#489）** —— reload/uninstall 原地清空 `loaded` Map，`evaluateToolPre` 的迭代器静默终止，剩余插件的 pre 守卫整体 fail-open；改为对快照迭代。
- **目标重设污染新目标（#490）** —— `dispatchExecutor` spawn 后没有代次复检就写回老执行者，`deliverAndWait` 登记 `verdictWaiter` 前也有 `await` 窗口；两处都补上复检。
- **可崩全服的 `unhandledRejection`（#491）** —— dispatch 的 `queue_remove` 是唯一缺 `void` 的 async 调用，且 `removeQueued` 内 `clearQueue` 无 try；现已消除该点。
- **新对话窗口静默吞消息（#492）** —— 新对话 displacement 与 runtime 创建窗口重叠时 `prompt` 被 abort 静默丢弃（无 notice、草稿已清），现在补「消息未送达」回执。
- **`mcp.json` 读失败被当空配置（#497）** —— EBUSY/EACCES 被当成空配置，会把在跑的 MCP 服务器全杀掉并推「热加载成功 0 个」的误导通知；现在按坏配置口径保留在跑的服务器，仅 ENOENT 视为删除。
- **markers 三处（#499）** —— `todo dep` 英文反馈方向颠倒、`new` 主题含逗号被静默截断、notify guidance 宣称协议里并不存在的 `success` 级别。
- **session-migrate 可伪造官方会话（#500）** —— fallback 导入没有来源标记，能伪造出看起来像官方的会话记录，且插件内直写会话库绕过了 outside-workspace 审批；现在补 `[imported-from]` 提示与会话头来源元数据。
- **内置预览页可被注入（#501）** —— live-preview 的 Markdown 链接/图片替换没有 scheme 白名单，`javascript:` href 可注入同源预览页。
- **直启路径端口校验（#506）** —— `--port abc` 曾静默绑随机端口并打印 `http://localhost:NaN`，现在 fail-fast。
- **只读 `bash` 白名单的 `find` 旁路（#483）** —— 白名单命中不等于只读：`find` 的 `-exec`/`-delete`/`-fprintf` 族现在按写副作用拒绝，一条常规 `find` 语法不再能绕过计划模式的三道只读闸门。
- **@ 引用正文写相对路径（#532）** —— 引用正文改用相对路径，同名文件/文件夹在输入框与聊天记录里可区分；退格整块删除与 chip 的 ✕ 反查口径同步对齐。
- **Windows 更新面板缺 `pi-core` 行（#533）** —— `readPiCoreVersionFromDisk()` 只认 npm 的 POSIX 布局，Windows 下 cmd-shim 是普通脚本、`realpathSync` 原样返回，向上找 `package.json` 永远找不到；现在先试 `<bin 同级>/node_modules/<pkg>/package.json`，探测不到时也保留该行并诚实标注「无法检测」而不是假装不存在。
- **Windows `server install` 生成的 VBS 无效（#534）** —— PowerShell 7 的 `C:\Program Files\PowerShell\7\pwsh.exe` 含空格却没加引号，Windows Script Host 报 `80070002`，登录自启与桌面快捷方式都起不来。
- **已钉住的对话跨服务重启持久化（#433）** —— 钉住状态持久化至 `client-state.json`，服务重启后自动恢复常驻运行列表，历史会话列表同步展示 📌 置顶标记并支持右键切换钉住状态。
- **计划模式净室执行（Clean Handoff）原子化（#434）** —— 修复净室执行前端四发消息由于服务端异步分发导致的竞态，提供原子协议通道 `plan_clean_handoff`，确保旧会话计划闸门关闭、新隔离会话原子就绪并承接计划步骤与目标后再发起实施。
- **压缩历史展开区只读防护与序号对齐（#437）** —— 压缩历史展开视窗右键菜单禁用派生分支、回滚与生成长图等写/非会话操作，序列化复用全局序号生成器，杜绝序号重计与碰撞。
- **PlanBoard 任务看板并发编辑防范（#444）** —— 看板步骤状态切换、内容修改、增量新增与删除改走单步骤级增量协议（`plan_step_update`、`plan_step_delete`、`plan_step_add`），解决快速连点与模型流式更新互相整组清改问题，前端即时响应 `plan_updated` 广播。
- **多轮压缩历史折叠卡片链式展示与错误本地化（#448）** —— 多次压缩的会话按分支链完整展示前序历史压缩卡片，各卡片按链式切分边界独立展开早期折叠内容；优化压缩记录未找到时的错误提示并接入多语言。
- **第三方 subagent 扩展同名工具透传支持（#481）** —— 修复内置 `subagent` 工具与第三方扩展（如 `pi-subagents`）同名冲突问题；当第三方扩展注册了同名工具且内置 `subagent` 被关闭/禁用时，自动透传扩展工具，不再强制顶替或剔除。
- **作为 Pi 扩展包安装时宿主 SDK 识别与加载器告警修复（#482）** —— 声明可选 `peerDependencies` 解决扩展加载器告警；`/webui` 子进程显式透传宿主 SDK 路径并加载 `resolve-global-sdk` 钩子，使服务准确跟随宿主 SDK 版本。
- **恢复模型管理中的第二把密钥与刷新模型功能（#456）** —— 恢复模型管理面板中克隆内置提供商添加第二把密钥与刷新已存提供商模型列表的功能与按钮。
- **防止会话交接记录与展开历史无界内存增长（#465）** —— `subagentHandoffs` 增加上限容量保护，前端被折叠压缩历史展开缓存改用 LRU 淘汰机制，防止长时间会话内存泄漏。
- **目标审查循环状态机健壮性强化（#464, #457）** —— `goal_ask` 超时定时器保证在 `finally` 中清理，避免残留定时器误杀后续调研；`stopDelegated` 异步等待执行者完全移出，消除容量误判；会话过户时主动唤醒等待者并清理目标审查阻塞态。
- **工具参数 TypeBox 约束与运行时一致性校准（#462）** —— `eval` 工具在执行 TypeScript 代码时启用原生类型剥离（`--experimental-strip-types`）；`lsp`、`terminals`、`compact_context`、`patch` 工具参数范围严格钳制与上下限校准。
- **插件更新检查不再误报** —— 版本号相同就绝不报更新（即使 monorepo 仓库 HEAD SHA 变化）；子目录源插件抓不到远端清单时明确报「无法检查（未能获取远端插件清单）」，不再拿仓库根 SHA 当版本号；随包（`pkgRoot`）插件版本可离线直读。CLI `pi-web-ui check-updates` 同步改为按版本号（而非 SHA）展示「已装 → 远端」差距。安装/卸载插件完成后立即重算更新状态，不必等下次轮询。
- **已结束的对话过户到另一处后可直接继续（#484）** —— 过户只换页面持有者、不重建 runtime，但新页面的会话订阅此前没挂回去，导致过户后发消息收不到回复（必须刷新页面）。现在过户尾部显式重挂事件订阅。回归：`idle-takeover-test`。

### Changed

- **清掉 103 个没人引用的 i18n key（#472）** —— 前端字典里积了一批没人读的翻译（旧模型管理 UI 残留 54 个、旧语言选择键 10 个、提示词/工具开关重构残留等），白白拖着 8 个语言包一起翻译与审阅。现新增守卫 `tests/unit/i18n-dead-keys.test.ts`（随 `npx vitest run` 进 CI）：字典里出现全仓零引用的 key 就直接红，并列出清单。模板拼接的动态 key（`thinking.*` / `promptTok_*`）已显式白名单。
- **服务端与前端死码清理（#468, #473）** —— 服务端：删掉协议死链（`cycle_model`/`cycle_thinking`、上行 `subagent_handoff`）、`sendControlCommand` 死副本、16 个零引用导出与一批死设置类型；`plugin_job_cancel` 反向补上 UI 入口（设置页作业状态行加「取消」），插件安装/更新这类长任务终于能中止。前端：删掉 11 个只被自己单测养活的 hook/util（约 1000 行）、7 个全死导出、`ui-slots` 三条「可拖可隐藏但对渲染毫无影响」的假条目（`host:lp-projects/lp-running/lp-history`），184 个仅本文件使用的导出去掉 `export`。
- **基础工具层统一、目录选择器同构合并、复制与格式化组件抽离（#470, #474, #475, #476, #477）** —— 服务端路径归一化 6 套语义分派、手抄 15+ 处的原子写、三份 TTL memoize 收敛为一套；`FooterBar` 与 `ProjectPicker` 复刻的两套目录浏览器（约 250 行同构）合并；`SettingsModal` 6 个逐行同构的提示词覆盖区块与两套 list+modal 编辑器合并；前端复制反馈 8 处内联、`formatSize` 6 份、可折叠区块头 3 份抽成共享组件；11 个插件里逐字复刻的 `esc`/`hostApi`/`apiBase` 等 client utils 下沉到 plugin-sdk 共享层。
- **构建期依赖归类与产物守卫（#468）** —— 16 个只被 `web/src` 用、随 vite 打进 `web/dist` 的包移入 devDependencies（npm 用户的安装体积与供应链面纯收益）；探针从 `server/dsh/` 挪到 `dev/dsh-probes/`（`dev/` 不进 npm 包）；新增 `.gitattributes` 与 CI 步骤「重新生成插件 bundle / vendor 后 `git diff --exit-code`」，改了 `src/` 忘了重新生成会被当场拦下。
- **CI 与 lint 覆盖补口（#479, #503）** —— `lint`/`lint:fix` 纳入 `bin/`（4400 行主入口不再零 lint 防护）；`check:protocol` 补 git 启发式：`protocol.ts` 相对上一个 tag 有 diff 而 `PROTOCOL_VERSION` 未 bump 即报错。
- **`release-notes.mjs --write-changelog` 替换串改函数形式（#498, #515）** —— i18n 文案含 `$&`、`` $` `` 等替换模式时不再静默写坏 `CHANGELOG.md`。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（26）：`openInNewTab`、`clickToCloseImage`、`compactedHistoryNotFound`、`uiLayoutSideDockFloat`、`uiIconEdit`、`uiIconEditTitle`、`uiIconEditHint`、`uiIconEditTray`、`uiIconEditDropHere`、`uiLayoutSidebarLeft`、`uiLayoutSidebarRight`、`uiLayoutPosition`、`uiLayoutPosTop`、`uiLayoutPosBottom`、`uiLayoutPosLeft`、`uiLayoutPosRight`、`moveToTop`、`moveToBottom`、`moveToLeft`、`moveToRight`、`sideDockCollapse`、`sideDockExpand`、`quoteSelection`、`quoteText`、`quoteSource`、`removeQuote`
- 前端删除 key（103）：`langZh`、`langEn`、`langIt`、`langJa`、`langKo`、`langFr`、`langDe`、`langEs`、`langRu`、`langPt`、`manageModelsTitle`、`setGlobalDefault`、`clearGlobalDefault`、`globalDefaultBadge`、`slashHelpHint`、`renameSessionConfirm`、`dismissConversationWithSubagents`、`dismissConversationWithSubagentsMixed`、`toolApprovalCommand`、`toolApprovalReason`、`approvalRuleResetConfirm`、`approvalRuleDeleteConfirm`、`planBoardSteps`、`planBoardProgress`、`planBoardNoPlan`、`editHint`、`updateTip`、`pluginAllUpToDate`、`fileSaved`、`dshVisionHiddenNote`、`questionNavTip`、`planModeTipOn`、`scmQueryFailed`、`scmTooManyFailures`、`editProvider`、`builtinProviders`、`hintKeyOnly`、`providerAuthHint`、`keyReady`、`replaceKey`、`replaceKeyTitle`、`cloneProviderTitle`、`pasteKey`、`providerIdPlaceholder`、`baseUrlExamplePh`、`saveAllBatch`、`advancedEdit`、`batchCreateProviders`、`secondKeyTitle`、`noBaseUrlShort`、`providerNameLabel`、`providerNameHint`、`apiKeyLabel`、`secondKeyPlaceholder`、`batchDesc`、`batchKeyLabel`、`modelsCountShort`、`customProviders`、`customDesc`、`noCustomProviders`、`refreshBuiltinCatalog`、`appendModelTitle`、`appendModelIdPh`、`appendModelNamePh`、`appendModelAdd`、`appendModelBusy`、`appendModelCancel`、`appendModelApiTitle`、`appendModelApiAuto`、`appendModelBaseUrlPh`、`modelsCount`、`addProvider`、`modelsTitle`、`modelIdReq`、`textImage`、`maxOutput`、`removeModel`、`addModel`、`fetchModelsErr`、`antigravityTemplateTitle`、`antigravityTemplateDesc`、`antigravityFillOpenAI`、`antigravityFillAnthropic`、`enrichHintPh`、`enrichModelsCancelled`、`goalBarActive`、`goalBarStatusPending`、`goalWizardAnswer`、`promptHistoryCleared`、`settingsPromptMode`、`promptAppendHint`、`promptReplaceHint`、`promptPlaceholder`、`promptReadonlyLockedBadge`、`reviewPromptHint`、`settingsTerminalTools`、`terminalToolsOffHint`、`settingsEditTools`、`visionBridgePromptAppendHint`、`visionBridgePromptReplaceHint`、`dshPresetCurrent`、`schedulerNameLabel`、`schedulerPromptLabel`
- 前端中文变更（3）：`planBoardTitle`、`planImplementBtn`、`planCleanHandoffBtn`
- 前端英文变更（4）：`planBoardTitle`、`planImplementBtn`、`planCleanHandoffBtn`、`browserControlExample2`
- 服务端新增 key（1）：`pluginupdate.subpath.manifest.failed`
- 服务端文案变更（2）：`markers.todo.dep.blocks.updated`、`subagents.wait.pending`
- 服务端删除 key（1）：`markers.todo.list.empty`

## [0.97.0] — 2026-09-26

### Added

- **左侧边栏历史会话置顶（#388）** —— 支持置顶/取消置顶历史会话，置顶项目始终固定在会话历史列表顶端，配合本地客户端状态持久化，多窗口即时同步；优化磁盘扫描算法，仅按需快速探测头部读取元数据，大幅提升大历史会话加载响应速度。回归：`tests/unit/client-state-recent-projects.test.ts`。

- **规划门禁与净室交接范式升级（#389）** —— 吸收主流规划与看板范式（DSH / narumitw / plannotator），全面升级「计划与目标」联动架构：
  - **只读规划门禁（Plan Gate）与状态机**：开启计划模式后自动剥离写类工具及旁路工具，物理级杜绝代码倾倒；
  - **净室新会话交接（Clean Handoff）**：支持一键将规划好的目标与步骤交接至全新隔离会话中施工，避免长推理上下文污染；
  - **可视化编辑与导出**：任务看板支持 Markdown 一键复制/导出，步骤支持内联编辑、新增、删除与状态切换；
  - **目标审查深度联动**：审查指令自动附带任务看板步骤推进状态，核验计划真实完成度。
    回归：`tests/plan-mode-test.mjs`、`tests/unit/goal-delegated.test.ts`。

- **对话可「钉住」常驻运行列表** —— 左栏「运行的对话」右键新增「钉住」：被钉的对话切到别的对话也不释放运行时（空闲、无存活终端、无后台任务时同样保留，优先级高于「打开未继续即移出」等所有自动规则），直到显式移出或强行关闭；取消钉住后立即恢复原有释放策略。进程内有效、不落盘。回归：`tests/unit/conv-pin.test.ts`、`tests/unit/wait-subscription-scan.test.ts`、`tests/conv-pin-browser-test.mjs`（真浏览器右键 → 钉住/取消钉住 → 切走仍留存 / 对照移出）。

- **上下文压缩后支持展开/查看被折叠的历史对话（#398）** —— 严格解耦「UI 展示流」与「LLM 推理视窗」：触发压缩（Compaction）后，在 `CompactionCard` 底部提供「展开查看被折叠的历史」操作栏，按需（On-demand）从会话 DAG 祖先链中还原被该节点折叠的原始历史消息（含提问、回答与工具输出），并以只读流视窗呈现，不占用后续推理 Token，解决长对话截断后无法回溯方案与日志的痛点。回归：`tests/unit/compacted-history.test.ts`。

- **粘贴任意文件直接附加** —— 在输入框粘贴从文件管理器复制的文件（文本、PDF、压缩包等）会像拖拽一样变成待发附件，不再只能贴图片：粘贴与拖拽现在共用同一条分流逻辑（图片走视觉管线并保留 text-only 模型的拦截，其余走 fileData 上传，20MB 上限同口径），纯文本粘贴完全不受影响。回归：`tests/unit/clipboard-files.test.ts` + `tests/file-paste-browser-test.mjs`。

- **语音输入可主动选识别方式（#383）** —— 麦克风浮层新增常驻的「切换识别方式」面板（浏览器联网识别 / 本地 Whisper / 远端接口），选中即用并写回插件设置，下次点 🎤 直接走这一档；「转写引擎」设为本地或远端时，点 🎤 直接走对应引擎（本地没装就直接弹一键安装，不必再干等浏览器联网失败几秒）。

### Fixed

- **任务看板 / 目标条窄屏排版协调** — 手机宽度下任务看板的「任务看板」「0/6 (0%)」被当前步骤挤成逐字竖排（行内 flex 子项默认 `min-width: auto` 且允许收缩，CJK 逐字断行），目标条的「最大轮数」标签同样竖排、「锁定：应用到后续所有回合」被挤成两行。现改为：看板标题与计数钉死不收缩、当前步骤 chip 放不下就整块换到第二行（宽屏仍同行）；目标条输入框独占一行、按钮组换行右对齐，偏好行允许整块换行、模型长 id 断行不外溢，锁定说明与标签不再被压扁。回归：`tests/unit/text-wrap.test.ts`、`tests/unit/css-tokens.test.ts`、`tests/chat-column-align-test.mjs`。
- **本地语音运行时「装成功却报没装上」（#383）** —— 修复安装本地 Whisper 后仍报「npm install 没跑通」：Node 的 CJS 解析会把 `package.json` 不存在的负结果缓存整个进程，装完复查永远命中它。依赖探测改为「解析失败再看文件是否已落盘」，插件侧也改为直接按 `package.json` 定位 transformers.js 入口，不再依赖被污染的解析缓存（非重启服务即可恢复）。
- **模型下载源可配（#383）** —— 新增「模型下载源」设置（也认环境变量 `HF_ENDPOINT`），国内直连 huggingface.co 超时时可填 `https://hf-mirror.com`。
- **语音浮层计时器泄漏** —— 切换识别方式时上一个浮层的计时器不再残留（此前每切一次泄一个 500ms 定时器）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（67）：`elsewherePseudoBadge`、`elsewherePseudoTip`、`pinConversation`、`unpinConversation`、`pinnedConversation`、`planImplementBtn`、`planImplementTip`、`planImplementRequest`、`planBoardExportMarkdown`、`planBoardExportSuccess`、`planCleanHandoffBtn`、`planCleanHandoffTip`、`planCleanHandoffPrompt`、`planBoardAddStep`、`planBoardEditStep`、`planBoardDeleteStep`、`planBoardStepTitlePlaceholder`、`planBoardStepDescPlaceholder`、`placeholderPlanMode`、`planModeBadge`、`viewCompactedHistory`、`hideCompactedHistory`、`compactedHistoryLoading`、`compactedHistoryEmpty`、`compactedHistoryBadge`、`compactedHistoryTurns`、`planMode`、`planActionBtn`、`planActionTip`、`planModeTip`、`planModeTipOn`、`goalBarExecModel`、`goalBarExecModelTip`、`goalBarOpenExec`、`goalBarOpenExecTip`、`goalBarStaleBackend`、`goalBarStop`、`goalBarExecuting`、`goalHistory`、`delegateMode`、`delegateModeDesc`、`delegateModeOffHint`、`delegateModeBadge`、`delegateModeBadgeTip`、`delegateModeOpenTip`、`toolCorePowershellDesc`、`toolCoreLsDesc`、`toolCoreGrepDesc`、`toolCoreFindDesc`、`pluginToolsDisabledByPlugin`、`pluginDisabledInPlugins`、`toolDescSubagent`、`planModePromptSettingsTitle`、`planModePromptSettingsDesc`、`planModePromptMode`、`planModePromptPlaceholder`、`planModePromptSettingsHint`、`preset.standard`、`preset.minimal`、`preset.code`、`preset.reader`、`preset.ask`、`preset.standardDesc`、`preset.minimalDesc`、`preset.codeDesc`、`preset.readerDesc`、`preset.askDesc`
- 前端中文变更（9）：`planBoardTitle`、`goalBarPlaceholder`、`goalBarSet`、`goalBarReviewModel`、`goalBarMaxRoundsTip`、`goalWizardBtn`、`toolsCoreHint`、`toolsSubagentDepHint`、`delegateTaskOffHint`
- 前端英文变更（9）：`planBoardTitle`、`goalBarPlaceholder`、`goalBarSet`、`goalBarReviewModel`、`goalBarMaxRoundsTip`、`goalWizardBtn`、`toolsCoreHint`、`toolsSubagentDepHint`、`delegateTaskOffHint`
- 服务端新增 key（18）：`agent.role.stop`、`goal.role.blocked`、`goal.role.conv_title`、`goal.role.exec`、`goal.role.card.start`、`goal.role.card.result`、`goal.role.review`、`goal.role.review.retry`、`subagents.action.missing`、`subagents.spawn.missing.prompt`、`subagents.get.missing.runId`、`subagents.steer.missing.runId`、`subagents.steer.missing.message`、`subagents.stop.missing.runId`、`subagents.wait.item.missing`、`subagents.handoff.missing.toRunId`、`subagents.handoff.missing.payload`、`subagents.action.unknown`
- 服务端文案变更（10）：`delegate.validate.agent`、`delegate.validate.short`、`delegate.started`、`subagents.spawn.template.unavailable`、`subagents.spawn.started`、`subagents.steer.not.found`、`subagents.stop.not.found`、`subagents.wait.empty`、`subagents.templates.list`、`subagents.handoff.not.found`
- 服务端删除 key（9）：`goal.set.kick`、`goal.wizard.kick`、`goal.review.incomplete`、`goal.autonomous.pass`、`goal.review.blocked`、`goal.autonomous.continue`、`goal.review.error`、`goal.review.blocked_msg`、`goal.review.revise`

<!-- auto-i18n:end -->

## [0.96.1] — 2026-09-26

### Fixed

- **插件安装审批弹窗层级提升与进度反馈补齐（#382）** —— 将能力与目录访问审批弹窗提升至高于设置弹窗的顶层浮层（`z-index: 350`），无需关闭设置页；修复「记住并允许」未持久化问题，授权写入 `plugin-permissions.json` 并在再次安装时直接放行；点击安装即刻反馈等待确认/执行中状态，已安装列表补挂进度条，关闭弹窗后主界面提供全局进度指示。
- **顶栏全部居中对齐时偏右修复** —— 修复当顶栏条目全部设为居中时，因右侧缺失占位弹簧（`tb-spacer`）导致条目被左侧单个弹簧推向最右侧的问题，确保中间条目精准水平居中。
- **设置保存回执时序修复** —— 确保 `set_settings` 在触发 `needsReload` 重启前先行持久化并推送状态回执。

### Changed

- **朱批与朱批·夜主题界面精细化** —— 顶栏控件全面素色化（透明底、无边框，悬停现 hairline）；消息折叠条内边距清零，折叠指示三角光学对齐左侧墨线；输入框边框微调，发送/停止按钮微调为圆形；输入框底部模型选择、思考强度、预设等按钮去边框透明底，悬停显示细边框。
- **输入框与顶栏控件排版微调** —— 顶栏 chip 统一幽灵化；输入框底部模型与思考强度 chip 尺寸微调收紧；思考强度 Chip 文案精简为 `{level}`，保留 tooltip 说明；预设选择器图标优化为 `FiSliders`。

<!-- auto-i18n:start -->

### i18n

- 前端中文变更（1）：`thinkingChip`
- 前端英文变更（1）：`thinkingChip`

<!-- auto-i18n:end -->

## [0.96.0] — 2026-09-26

### Added

- **内置 LSP 工具新增四个语义动作（#331 Phase 1）** —— `documentSymbol`（分层符号大纲，带行跨度与 300 条防洪截断）、`read_symbol`（按符号名/点分路径精准读取实现体，双遍扫描精确匹配优先、400 行截断、未命中时自愈提示可用符号）、`workspaceSymbol`（工作区全局符号搜索，100 条上限，可不传 `path` 自动探测主文件路由语言服务）、`cascade`（编辑影响级联：查引用方文件并聚合其编译诊断，改坏签名当轮即暴露）。提示词开销保持 ~350 tokens；设置页工具说明中英文同步。
- **系统提示词与工具 schema token 占用实时估算** —— 设置面板「系统提示词」支持直接查看当前会话实际生效的完整系统提示词与工具 schema 定义，并展示粗略 token 估算值与上下文总占用；工作区与活跃会话切换时主动同步最新设置快照，避免提示词上下文陈旧。
- **核心内置工具独立开关与运行时门控** —— 设置页新增「核心工具」配置区，支持独立开启/禁用 `bash`、`read`、`edit`、`write` 原生核心工具；工具禁用状态随会话即时生效，并在系统提示词与 tools schema 中同步过滤与剔除，杜绝无效工具调用。
- **新增内置主题** —— 新增三款内置现代与古典主题：赛博科幻暗色 HUD 风格「以太座舱 (Aetheris HUD)」、古籍朱印浅色风「朱批 (Vermilion Manuscript)」与深色夜读风「朱批·夜 (Vermilion Night)」。
- **消息气泡复制菜单与直接重问增强** —— 消息底栏复制按钮升级为下拉菜单，支持一键复制 Markdown、纯文本或生成长图 PNG；新增「直接重问」快捷按钮，无需重新聚焦编辑框即可立即复用上一条指令；消息气泡增加右键上下文菜单，支持快速复制、编辑/直接重问、派生分支、回滚到此与语音朗读。
- **TTS 语音朗读与流式生成提示音** —— 助手消息气泡支持单条 TTS 语音朗读与停止；新增流式开始与完成提示音，后台生成完毕及时提醒。

### Fixed

- **非全功能预设（如代码开发/极简/纯对话）下提示词泄露已禁用工具指南修复** —— `before_agent_start` 提示词组装现在严格按会话当前真正处于活跃状态的工具集合（`activeTools`）过滤 Guidelines 与 Snippets，防止未启用的工具（如 `plan_update`、`ask_user_question`、`subagent_*` 等）的提示词指南被无差别注入到给模型的系统提示词中；彻底解决在「代码开发」预设下 AI 因收到动代码前调用 `plan_update` 的硬性指令而误调用未激活工具导致报错无效的问题；会话创建（`makeRuntimeFactory`）与重载（`reloadSession`）全生命周期对齐当前会话预设门控。
- **助手气泡 Fork / 回滚无法解析修复（#381）** —— 统一 `server/serialize.ts` 的 `uiMessageId` 与 `findEntryByUiId` 算法为单一事实源，彻底修复从助手气泡触发分支派生（Fork）或回滚到此消息时因 ID 生成算法漂移导致的解析失败问题。
- **悬空工具调用修复收紧分支与上线检查（#332）** —— `healDanglingToolCallFile` 与 `findDanglingToolCalls` 现在严格过滤 `stopReason` 为 `error` 或 `aborted` 的 assistant（不上线幽灵调用，避免在文件尾补合成结果构造出孤儿 `role: "tool"` 导致 DeepSeek/OpenAI 400 报错），且文件落盘修复仅沿活跃分支 `lastId` 向上回溯当前尾部生效 assistant，彻底跳过老分支遗留的悬空调用，防止跨分支污染。
- **微信通道插件问题修复（#345）** —— 微信回包自动剥离内部控制标记（如 `[[plan:...]]`、`[[todo:...]]`、`[[conv:...]]`、`[[notify:...]]` 等），仅向微信发送用户可见正文；按微信用户 ID 隔离 `accountId`（`wx_${hash}`），为每个用户分配独立的伪客户端与会话，防止上下文串扰与关闭冲突；增加 `earlyRuns` 机制妥善承接极快完成的运行事件，消除回包竞态。
- **SoL-Pi 节能看板弹窗展示优化** —— 扩展运行与配置区域默认采用折叠组件收拢，避免未折叠时挤占弹窗主视区。

### Changed

- **输入框 `@` 提及支持技能（skills）自动补全** —— 在消息文本任意位置键入 `@` 或 `@skill:` 即可弹出技能候选列表（名称匹配优先于描述匹配，支持中英文双语描述检索与 `@page` 页面置顶防挤占）；点选后自动在光标处插入 `@skill:<name>` 词元，与 Pi 运行时的技能提升扩展无缝联动。
- **收敛型澄清提问与决策就绪型计划规范（#330）** —— `ask_user_question` 现在单次严格限制 1~~3 个问题（优先 1 个，超过 3 个直接报错阻断，防止问卷轰炸），选项 schema 收紧为 2~~4 个互斥选项且推荐方案置顶，选项 description 要求一句话说明影响与权衡；`plan_update` 提示词升级为「决策就绪型」规划：动代码前先在步骤中落实排查发现（Discovery）、受影响文件清单（File Touch List）与风险回滚预案（Rollback），并随执行实时流转步骤状态。目标向导（`goal_ask` / wizardPrompt）与 DSH 澄清提示词同步对齐收敛型交互。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（49）：`reaskDirectly`、`reaskDirectlyTip`、`kindPlugin`、`pluginCheckUpdates`、`pluginCheckUpdatesHint`、`pluginUpdateAvailableBadge`、`pluginUpdateAvailableDetail`、`pluginAllUpToDate`、`piCoreSplitRun`、`piSdkSplitNote`、`piSdkBundledNote`、`installGlobalEngineBtn`、`installGlobalEngineTabTitle`、`saveResultUnknown`、`questionNoneAvailable`、`notifyApprovalTitle`、`notifyApprovalBody`、`notifyApprovalBodyTool`、`sound.approval`、`sound.approval.desc`、`settingsSoundVoice`、`ttsHeader`、`ttsEnable`、`ttsEnableDesc`、`ttsAnnounce`、`ttsAnnounceDesc`、`ttsReadReplies`、`ttsReadRepliesDesc`、`ttsRate`、`ttsVoice`、`ttsVoiceAuto`、`ttsVoiceOnline`、`ttsUnavailable`、`ttsPreviewLine`、`ttsAnnounceDone`、`ttsAnnounceQuestion`、`ttsAnnounceError`、`ttsAnnounceApproval`、`speakMsg`、`stopSpeakingMsg`、`apiKeySavedHint`、`settingsViewPromptTokens`、`settingsPromptContextTotal`、`toolsSectionCore`、`toolsCoreHint`、`toolCoreBashDesc`、`toolCoreReadDesc`、`toolCoreEditDesc`、`toolCoreWriteDesc`
- 前端中文变更（2）：`settingsViewToolsSchema`、`lspToolEnabledDesc`
- 前端英文变更（2）：`settingsViewToolsSchema`、`lspToolEnabledDesc`
- 服务端新增 key（3）：`plugincatalog.sync.doc.invalid`、`terminals.bash.nosentinel.note`、`terminals.command.blocked`
- 服务端文案变更（1）：`terminals.bash.timeout`
- 服务端删除 key（2）：`plugincatalog.sync.source.invalid`、`plugincatalog.sync.read.failed`

<!-- auto-i18n:end -->

## [0.95.0] — 2026-09-24

### Added

- **临时对话（🎭 无痕会话，issue #285）** — 顶栏「新对话」旁新增 **🎭 临时对话** 按钮：新开的对话**只活在内存里**（`SessionManager.inMemory`，不落盘、不进历史会话列表、不计入每项目 8 个的持久对话名额），关闭即销毁，用来跑连通性探测、随手一问、或临时分析不想留档的敏感内容。临时对话在左栏「运行的对话」里带紫色「临时」徽标，对话流顶部常驻一条提示条（🎭 当前为临时对话…）并附「💾 保存为正式对话」按钮 —— 这就是**一键转正**：点一下即把内存里的全部消息落盘成 `.jsonl`、清掉临时标记、登记进历史（对话 id 与内容原地保留，不丢上下文）；不想点按钮也可以右键该行选同一动作。转正后与普通对话完全一致（可继续、可派生分支、可被 AI 按 path 读）。DSH 引擎不提供该入口（其 `newChat` 无 inMemory 分流，画出来只会得到普通持久对话）。回归：`tests/ephemeral-chat-test.mjs`（含「普通新对话确实落盘」的对照组）。

- **审批规则可自定义（规则引擎 + 设置面板管理）** — 支持在设置面板「审批规则」页自由添加、编辑、启用/停用、排序和删除审批拦截规则，规则持久化于全局 `<dataDir>/approval-rules.json`（对所有会话实时生效）。支持多工具匹配（bash / write / edit / edit_soft / 通配 *）、多字段检测（命令 command / 路径 path / 完整参数 JSON params）以及五种匹配模式（正则 regex / 通配符 glob / 包含 contains / 前缀 prefix / 工作区外写入 outside_workspace）；命中动作支持「需审批」(ask)、「直接拒绝」(deny，向模型报错且不弹窗) 与「免审放行」(allow，白名单直接执行)。内置高危规则（rm -rf / 破坏性 git / 格式化 / chmod / 敏感文件 / 越界写入等）均转化为可自定义规则，可独立停用、修改动作或一键恢复默认。
- **审批不再一次次弹（三档放行）** — 人机协同审批弹窗现在有三条「别再问我」的路：① **全局关**（设置 →「工具」页的「工具执行审批」总开关，默认开）——关掉后一切审批都不弹（内置高危检测直接放行，插件 pre guard 的 `ask` 也按放行处理）；② 弹窗里的「**本对话全部允许**」——本对话后续高危操作都不再询问；③ 弹窗里的「**本对话允许同类**」——只对同一规则档位生效（`rm -rf` 类删除 / 破坏性 git / 磁盘写入 / 危险 chmod / 写入系统目录 / 敏感文件 `.env`·SSH·shell 配置 / 工作区外写入 / 每个插件各自一档），弹窗里会写明本次命中的档位。记住后同对话内已被覆盖的其它待审批项一并放行；撤销入口在设置 →「工具」页（列出当前对话已记住的放行，逐条「撤销」）。策略**只存内存**且跟对话走（手动过户一起搬），重启服务或新对话即恢复询问；全局开关被关掉时挂着的弹窗也自动放行，不让人对着窗口干等。
- **插件安装前先读 spec（引导式安装）** — 在设置面板「插件市场 → 添加插件」填来源时，输入框下方就地给出结论（防抖 500ms 自动检查，不必等 CLI 跑完再猜）：来源形状分类（npm / GitHub 仓库 / URL / 本地路径）、是否已装同名插件、以及 GitHub 源的远端有没有 `manifest.json`；探到 manifest 时顺带展示插件名 / 版本 / 简介供确认。失败归到七种原因（形状不对 / 已装 / 远端找不到 / 不是插件包 / manifest 不合法 / 连不上远端 / 未知），各给一句人话与修复建议。远端探测失败只作提示，**不阻塞安装**。
- **插件副作用统一回收（effect 栈）** — 宿主的每个插件注册面（AI 工具 / 斜杠命令 / HTTP 路由 / 反向代理 / 文件监听 / 定时任务 / 后台任务 / UI 条目 / 事件订阅 / 统计与流式订阅）现在都在插件内部登记为可逆副作用，插件被禁用、卸载或热重载时**逆序回卷**；插件忘记调用返回的注销函数也不会再留下孤儿订阅、定时器、路由或文件监听（这些正是热重载后事件双触发、定时器叠加、watcher 堆积的根因）。插件自建的副作用可用新 API `host.effect(label, dispose)` 挂进同一个栈。插件激活中途失败时，已注册的东西也会被撤干净。
- **界面布局诊断（失败不再静默）** — 插件声明了宿主不认识的挂载点 / 条目种类 / `when` 条件，或整理意图（arrange）指向了不存在的条目，或插件被禁用 / 激活失败时，设置面板「界面 ☰ → 界面布局」页顶部会出现可折叠的「布局诊断」横幅，逐条点名**哪个插件的哪个条目、为什么没出现在界面上**（同时控制台留一条）。以前这些情况是静默丢弃，表现为「注册了但界面上没有」，最难排查。
- **单个条目崩溃不再炸掉整条工具栏** — 每个挂载点条目独立包一层错误边界：某个插件条目渲染抛错时只丢它自己并就地置一个可点的灰色占位（点开在控制台看细节），顶栏 / 底栏 / 右栏的其余条目照常工作。
- **插件设置 overlay（层式组合）** — `<dataDir>/plugin-overrides/<id>.json` 的 `settings` 节：三层合并 schema 默认 < overlay < 面板保存值。overlay 是用户钉住的新默认值（不 fork 改官方默认，更新不丢）；面板保存永远最高；secret 永不来自 overlay；坏键警告进诊断；每键来源标在 `settingsSources`（default/override/stored）。
- **机器可读的注册面目录（WS 只读查询）** — `plugin_api_catalog` → `plugin_api_catalog_result`：22 个 slot（别名/kind/可抄例子）+ 工具目录 + 宿主方法表（需要族+最小例子）+ 当前占用者（现算，只含条目数）。类型在 `protocol.ts#PluginApiCatalog`，装配 `server/plugin-api-catalog.ts`，单测锁住与源码同口径。给将来「AI 写插件」铺路。
- **插件硬依赖声明（manifest.requires）** — `{ hostApi?, families?, plugins? }`：任一条不满足即拒绝激活+教学式错误（区别于 `peerPlugins` 的缺失只警告）。`ensureLoaded` 按依赖拓扑排序激活（被依赖者先行，环直接拒），提供方被删/失败后消费方一并反激活+留占位。决定启动时机的是依赖，不是目录顺序。
- **插件可拦截工具执行（pre/post 两阶段，仅 bash/read）** — 插件经 `host.onToolPre` 在危险命令执行前拒掉（`deny` 带原因给模型看，`ask` 待确认暂按拒绝执行），经 `host.onToolPost` 给输出脱敏/改写或补 `additionalContext`。首个阻断胜出，守卫抛错/超时按弃权（不挂住工具调用）。注册要 `tools` 能力；只覆盖已接管的 `bash`/`read`（DSH 引擎无 customTool 注册面不接）。
- **Office 文档随处可看** — 内置文件预览现在能打开 `.docx` / `.xlsx` / `.xlsm`：服务端零依赖解析（zip 解包 + 提文本，15MB 文件上限 / 64MB 解包上限防 zip 炸弹）转成 Markdown 下发，预览弹窗直接渲染表格与段落（协议未动，仍走 `file_content kind:text`）。文件树、附件、中文名/括号文件名都走同一条链路；Office 文件在预览里**不可编辑**（防把文本写回二进制）。表格表头固定为 A/B/C…列标（不拿第一行数据冒充，避免通知类首行被染成紫色表头），每表最多 500 行、全文 20 万字符，超出截断并按实际行数提示（复用 `previewLinesTruncated`，不新增文案 key）。预览样式走 `.fp-office` 独立作用域：紧凑行高（杀掉格子内 `<p>` 边距、空格子占位防塌）、横向滚动条常驻、表头吸顶。实现在 `server/office-parse.ts`（与 `plugins/office-preview` 的解析器互为镜像，改一处请同步另一处），单测 `tests/unit/office-parse.test.ts`（另用 headless Chrome 对 1.4MB 真文件做过渲染截图回归：行高/常驻滚动条/吸顶表头/零 JS 报错）。
- **受控的持久代码求值沙箱工具 `eval`（opt-in，默认关）** — 新第一方 customTool：在隔离子进程中执行 Python（`py`）或 JavaScript/TypeScript（`js`/`ts`），变量与导入跨调用保持，顶层表达式自动求值回显（省掉以往 `write` 临时脚本 → `bash` 跑 → 删文件的三步流程）。设计要点：① 默认关（`AGENT_TOOL_CATALOG` 里 `defaultOn: false`），关掉 AI 不知道有它，杜绝「什么问题都塞进内核」的工具挤占；② 每个会话一个独立内核进程 + 独立临时目录（cwd 不落在项目里，项目路径经 `PROJECT_DIR` 变量显式引用），关对话 / 停服务即回收进程树（Windows `taskkill /F /T`，Unix `SIGKILL` 进程组），不留孤儿；③ 单请求默认 15s、上限 120s 硬超时，超时杀进程树后内核自动重启，不会把会话拖死；④ 驱动协议串行排队，并行 `eval` 调用不会互相覆盖 resolver；⑤ stderr 持续排空，避免原生扩展写满管道缓冲造成假超时。DSH 引擎无 customTool 注册面，不接。

### Changed

- **插件 manifest 校验失败即拒（P1-6）** — 坏 manifest 不再带病启动：`id` 非法/与目录名不一致、`apiVersion` 非法、未知能力拼写、`engines`/`permissions`/`ui` 坏形状、v2 不声明 `permissions`、有 `ui` 声明却无 `ui` 能力，都会拒绝激活（scan 置红 + 诊断随清单下发，activate 重判）。以前其中两类（v2 无能力声明、只有别的能力却写 `ui`）是"激活成功但 ui 静默忽略"，现在是明确拒绝；纯警告（坏文本字段/坏数组字段/截断）仍不阻断。未来版本（`apiVersion` 大于宿主）仍走版本门出"请升级"，校验层不抢错。

### Fixed

- **目标调研向导：切会话不再丢弃调研成果，且消息流里有「原始目标草案」卡片（#292）** — 两处修复：① `setGoal` 新增 `targetConvId`，调研收敛后把目标写到**发起调研的那个对话**（原来是硬读 `activeConv` 再一刀切丢：「已切换对话，目标调研结果已丢弃」——用户在向导问答期间切去看代码/文档是常态，多轮问答瞬间白做）；发起会话已关闭时响亮拒绝而不是静默丢。完成通知随之改成点名会话（`🎯 会话「title」目标调研完成，目标已设为…`），取消/无结果时也告诉用户草案还在哪儿。② 调研开始先往发起对话推一张只读「🎯 原始目标草案」卡片，排在所有提问之前——调研被超时/取消打断后，用户至少能把自己最初写的那段需求读回来、复制重试，而不是面对一片空白。
- **子代理（in-memory 会话）的扩展错误不再按轮数刷屏（#298）** — `SessionManager.inMemory(cwd)` 建出来的子代理会话取不到会话目录（`getSessionDir()` 返回空串），而 SDK 的 `ExtensionRunner.emitContext()` 在**每次 provider 请求**前都会跑一遍扩展的 `context` hook，于是「会话目录依赖型」扩展（如 SoL-Pi 的 `runtimeRoot()`）每轮都抛同一个错。原 `bindExtensions` 的 `onError` 把错误原样广播成 notice：不去重、不带会话归属、不落服务端日志，一个子代理跑 N 轮就弹 N 条，且看不出是哪个会话出的问题。现改为共享的 `makeExtensionErrorReporter()`：① 同一会话内「扩展 + 事件 + 错误文本」只提示一次；② 子代理的 notice 带 `子代理 <conversationId>：` 前缀（与同函数内其它子代理通知口径一致）；③ 全量错误（含 extensionPath / event / stack）始终 `console.error` 落服务端日志。主对话（持久会话）行为不变，只是多了去重与日志。
- **插件市场仅同步列表时保留已激活插件实例（#296，感谢 @StarryJia）** — 启动预同步和手动目录同步不再重载插件，避免重新激活时重复广播当前工作目录。
- **浅色主题通知配色修复（#296，感谢 @StarryJia）** — 修复 9 个浅色主题下 notice 的背景和边框配色，使用动态基色混合提升文本对比度。

- **macOS 服务版开页不再永久卡「正在连接」（#295）** — `server install` 的默认工作区从用户主目录改为干净的 `~/pi-web-ui`（不存在即建；显式 `--cwd`/`PI_WEB_CWD` 保持原语义）：SDK 初始化期的同步目录扫描不再落在 `$HOME` 上（iCloud 占位符/外部卷坏挂载曾让 `scandir/open` 在内核挂起、整个事件循环假死，`hello` 后永远收不到 `ready`，连 `server status` 控制通道一起超时）。另两道保险：① `hello` 后服务端先回 `ready`（传输握手不再等会话初始化，快照随后到），`attach` 超过 8s 未完成先给一句可见提示；② `attach` 里恢复上次工作目录的 `statSync` 改异步，坏挂载只挡本连接、不冻事件循环。老服务仍指着家目录时启动日志会提示重装迁移。回归：`systemd-install` 单测对齐新默认 + `plugin-proxy-test` 的插件路由判活改按真实内容（此前按 HTTP 200 判活会被 SPA catch-all 误导）。
- **工具看门狗强制重置不再留下悬空 toolCall（#280）** — 流式卡死 → 看门狗 abort 无效 → `forceResetConversation` 从磁盘重建时，内存里未落盘的工具结果蒸发，文件尾留下「有调用、无结果」的悬空 toolCall；重建后继续 prompt 会把非法转录链喂给 provider（请求有发起迹象但零落盘、零报错）。现三处修复：① 重建前向**本次对话自己的会话文件**补一条合成 toolResult（append-only，历史字节不动），重建后弹提示建议重执行工具；② 重建改回**同文件**（`SessionManager.open(ownFile)`），不再按 cwd 取最近（多会话会接错文件）；③ 发送前/打开历史会话时复查转录尾，残留悬空即自动补合成结果，补不上则响亮拒绝发送（不再静默黑洞）。另：重建后旧扩展 ctx 的 `stale` 警告是 SDK 侧对已替换会话的预期失效（旧钩子不再可用），非数据丢失原因。
- **`edit_soft` 多 edit 不再串位（会写坏文件的 bug）** — 一次调用带多个 edit 且**按降序给出**（靠后的区域写在前面）时，旧实现按 edits 的传入顺序逆序应用而不先按位置排序 → 后面的替换先改变长度、前面的偏移串位，写出错乱/粘连内容（历史 bug：`protocol.ts`、`use-chat.ts`、`ChatInput.tsx` 被写坏）。现改为按位置升序再逆序应用（与内置 `edit` 先按 `matchIndex` 排序一致），任意给出顺序结果都一致；补了覆盖全部 6 种排列的回归测试。
- **`edit_soft` 拒绝跨行未对齐的非法片段** — oldText 跨多行但首/尾未落在行边界（如 `a);\nfoo(`）时，旧的精确子串替换会吃掉行首/行尾残留、写出粘连内容（`foo(z();b);`）；现直接拒绝并提示按整行给出。另：宽松匹配整块对不上、且首/尾行只是某行一部分时，报针对性的「片段」错而非笼统的「找不到」。单行片段仍照旧支持。
- **任务执行看板与对话列等宽** — Plan Mode 的任务执行看板（`PlanBoard`）此前写死左右各 16px 外边距，没走 `.main` 的列 token（`--chat-inset`）：桌面 / 宽屏聊天列下比消息列与输入框宽一截、手机上又比它们窄一点，左右边缘始终对不齐。现改为同一条列 token（`.plan-board` 落进 `styles.css`，与 `.goalbar` / 问卷面板同口径），任何视口宽度与「宽屏聊天列」开关下都与输入框严格齐平。回归：`tests/chat-column-align-test.mjs` 新增看板条目。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（104）：`newChatEphemeral`、`newChatEphemeralTip`、`ephemeralBadge`、`ephemeralBannerText`、`elsewhereActions`、`takeoverConfirm`、`saveEphemeral`、`forkSession`、`forkSessionTip`、`rollbackSession`、`rollbackSessionTip`、`rollbackConfirm`、`rollbackRestoreWorkspace`、`rollbackRestoreWorkspaceTip`、`toolApprovalTitle`、`toolApprovalApprove`、`toolApprovalDeny`、`toolApprovalEditAndRun`、`toolApprovalRiskAlert`、`toolApprovalCommand`、`toolApprovalParams`、`toolApprovalEditPlaceholder`、`toolApprovalReason`、`toolApprovalCategory`、`toolApprovalAllowCategory`、`toolApprovalAllowCategoryHint`、`toolApprovalAllowConversation`、`toolApprovalAllowConversationHint`、`toolApprovalEnabled`、`toolApprovalEnabledDesc`、`toolApprovalPolicyTitle`、`toolApprovalPolicyAllowAll`、`toolApprovalPolicyRevoke`、`toolApprovalPolicyHint`、`settingsApprovalRules`、`settingsApprovalRulesDesc`、`manageApprovalRules`、`approvalRuleNew`、`approvalRuleEdit`、`approvalRuleDelete`、`approvalRuleReset`、`approvalRuleResetConfirm`、`approvalRuleDeleteConfirm`、`approvalRuleActionAsk`、`approvalRuleActionDeny`、`approvalRuleActionAllow`、`approvalRuleTools`、`approvalRuleToolsTip`、`approvalRuleField`、`approvalRuleFieldCommand`、`approvalRuleFieldPath`、`approvalRuleFieldParams`、`approvalRuleMatch`、`approvalRuleMatchRegex`、`approvalRuleMatchGlob`、`approvalRuleMatchContains`、`approvalRuleMatchPrefix`、`approvalRuleMatchOutsideWs`、`approvalRuleValue`、`approvalRuleValueTip`、`approvalRuleLabel`、`approvalRuleLabelEn`、`approvalRuleReason`、`approvalRuleReasonEn`、`approvalRuleEnabled`、`approvalRuleBuiltin`、`approvalRuleEmpty`、`approvalRuleMoveUp`、`approvalRuleMoveDown`、`planBoardTitle`、`planBoardSteps`、`planBoardProgress`、`planBoardNoPlan`、`planBoardCompleted`、`planBoardInProgress`、`planBoardPending`、`planBoardFailed`、`clear`、`confirm`、`forkBadge`、`forkBadgeTip`、`goalBarBlocked`、`toolsPresetBanner`、`toolsBackToStandard`、`toolsBlockedByPreset`、`skillsHiddenByPreset`、`terminalBashMaxForegroundMs`、`terminalBashMaxForegroundMsDesc`、`pluginInspectAlreadyInstalled`、`pluginInspectInvalid`、`pluginInspectNotPlugin`、`pluginInspectNetwork`、`uiLayoutDiagTitle`、`uiLayoutDiagHint`、`planUpdateEnabledDesc`、`planUpdateOffHint`、`compactContextEnabledDesc`、`compactContextOffHint`、`evalEnabledDesc`、`evalOffHint`、`patchToolEnabledDesc`、`patchToolOffHint`、`lspToolEnabledDesc`、`lspToolOffHint`
- 前端删除 key（1）：`attachInlineTip`
- 前端中文变更（2）：`hostResourcesTip`、`noPresets`
- 前端英文变更（2）：`hostResourcesTip`、`noPresets`
- 服务端新增 key（14）：`editsoft.fragment.not.supported`、`goal.wizard.draft.card`、`goal.autonomous.pass`、`goal.review.blocked`、`goal.autonomous.continue`、`goal.review.blocked_msg`、`plugins.requires.cycle`、`plugins.manifest.invalid`、`plugins.requires.cascade`、`subagents.handoff.self`、`subagents.handoff.not.found`、`subagents.handoff.success`、`subagents.handoff.failed`、`terminals.bash.background.elapsed`
- 服务端文案变更（1）：`terminals.bash.background.running`
- 服务端删除 key（2）：`dsh.attach.file.large`、`dsh.attach.file.ref.fallback`

<!-- auto-i18n:end -->

## [0.94.1] — 2026-09-22

### Fixed

- **HTTP 代理的 `undici` 提升为直接依赖 + 懒加载** — `undici` 从传递依赖提升为 `dependencies` 直接依赖（`^8.9.0`），版本漂移不再悄悄改变代理行为；`server/http-proxy.ts` 改为运行时懒加载，缺失时只告警并停用代理，不再崩溃服务端启动。

### Changed

- **深青（dark-teal）主题微调（PR #277，感谢 @A5Kush）** — 深色下粗体改用主题青（`--text-strong`）更显眼，`--bg-elev2` 提亮，品牌渐变与部分描边换成符合主题的青色。
- **主题机制文档修正** — 主题是完整样式表（可覆盖 `:root` 变量 / 任意选择器 / 布局改动 / 自带新 token），`styles.css` 只是共享基线；之前文档里「主题 = 纯 `:root` 调色板、改布局永不碰主题」的说法已过时（`AGENTS.md` / `docs/architecture-core.md` 同步）。

## [0.94.0] — 2026-09-22

### Added

- **复制为图片：预览面板 + 标题 / 边框 / 水印 + 多轮勾选拼接（#274）** — 点「复制为图片」打开右侧停靠面板（不挡对话）。可选标题、边框、自定义水印（默认 `pi-web-ui`）；对话里勾选多条消息，按时间线从早到晚竖排拼成一张 2x PNG。面板提供「包含工具调用 / 包含思考过程」两个开关（默认关），勾上后把对应块加进图并强制展开，不改对话里原有折叠状态。超长则降到 1x 或拒绝复制，避免黑图。
- **压缩软上限（Soft Cap）支持人性化 tokens 单位输入与纯数字智能识别** — 设置「消息显示」页与按模型覆盖的压缩阈值输入框全面支持人类习惯的缩写（如 `300k`、`1.5M`、`300,000`、`300_000`）；纯数字且 `<= 1000`（如 `300`、`128`、`64`）自动智能识别为 K tokens（`300` → `300,000`），回显自动格式化为整千/整百万可读缩写，避免手滑漏输 0。
- **全局跨标签页/重启共享的项目模型与 Provider Key 记忆** — 将项目绑定的模型与服务商密钥提升至全局持久化层（`GLOBAL_SETTINGS_KEY`）。新开标签页、切换工作区或重启浏览器时，确定恢复该项目最后使用的模型与密钥；全新空白会话创建时提前解析并注入目标模型，且在 `setModel` 前优先恢复对应的 provider key，彻底解决新对话鉴权失败与回退内置硬编码模型的问题。

### Changed

- **官方插件清单内置为默认来源（`PI_WEB_PLUGIN_CATALOG_URL`）** —— 服务端启动时未配置该环境变量时，自动拉取官方社区清单 `https://xing-shuyin.github.io/pi-web-ui-plugins/catalog.json` 并同步进插件市场列表（**仅更新列表供用户按需安装，不自动安装插件**）；显式设为空串或 `off`/`0`/`false`/`no` 可关闭；仅当显式设置 `PI_WEB_PLUGIN_CATALOG_INSTALL=1` 时才在开机时顺手自动安装全部插件（headless/容器预置镜像场景）。
- **界面交互防选区干扰与遮罩层重绘优化** —— 侧边栏（会话列表、项目列表、文件树）、顶栏、右键菜单、消息头部及技能卡片头部等不可交互文本区域增加 `user-select: none`，防止高频双击或拖拽时意外选中文本；弹窗与文件预览遮罩层移除 `backdrop-filter: blur` 改用纯色半透明实底，并添加 `overscroll-behavior: contain` 与硬件加速，消除滚动穿透并显著降低大消息流时的重绘负担。

### Fixed

- **复制为图片浅色主题色差（#273）** — html-to-image 把 `color-mix(...)` / 半透明 `rgba` 画到默认黑画布上，浅色气泡变成深紫、深字叠黑底。导出前把计算色拍成不透明 rgb，画布底用主题 `--card-bg`/`--bg` 实底，并去掉 `backdrop-filter`（否则 SVG 里会变成黑罩）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（13）：`saveAsImage`、`copyImageBtn`、`savingImage`、`imageTitle`、`imageTitlePlaceholder`、`imageBorder`、`imageWatermark`、`imageWatermarkPlaceholder`、`exportSelectHint`、`exportTooLong`、`exportSelectedCount`、`exportIncludeTools`、`exportIncludeThinking`
- 前端中文变更（2）：`softCapHint`、`softCapOff`
- 前端英文变更（2）：`softCapHint`、`softCapOff`

<!-- auto-i18n:end -->

## [0.93.0] — 2026-09-21

### Added

- **支持 HTTP 代理配置传导（`httpProxy`）** —— 服务端启动时自动读取 pi agent 配置（`~/.pi/agent`）中的 `httpProxy` 设置，并与环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 结合，自动设置 Node.js 内置 fetch 及 undici 的全局代理调度器，确保所有出网 HTTP 请求（模型调用、插件下载等）在代理环境下稳定工作。
- **可配置的单工具看门狗超时（`toolWatchdogTimeoutMs`）** —— 设置「工具」页新增单工具超时配置，支持自定义单次工具调用的看门狗超时毫秒数（0 表示禁用看门狗；`PI_WEB_TOOL_TIMEOUT_MS` 环境变量只作为默认值；工具自身声明的更长超时如 bash `timeout` 仍获尊重）。
- **子代理会话持久化落盘（`persist_conversation`）** —— 支持将原本仅存在于内存中的临时子代理会话持久化保存为常规历史会话，方便后续长期回顾与复盘。
- **工具输出图片查看增强与开关** —— 工具结果中的图片支持点击放大查看，设置「消息显示」页新增「工具图片」开关（`toolImagesEnabled`），可按需控制工具结果中图片的内联显示。
- **社区插件 multi-git 与社区插件收录机制（PR #271）** —— 插件市场首次收录外部独立维护的社区插件 `multi-git`（多仓库 Git 总览，来源 `EinErste/pi-web-multigit`）；文档（README / README.zh-CN）同步增加社区插件章节，规范外部来源声明与安装流程。
- **社区需求与投票墙插件（`feature-board`）** —— 官方插件库新增 `feature-board` 插件及配套 Cloudflare Worker 后端代码，支持社区用户查看热门功能建议、提交新需求以及投票交互。
- **工具调用卡片的工具名上右键，就能看这个工具的「定义说明」** —— 在工具卡头部（工具名那一行）右键，选「显示工具详细信息」：弹窗里给出它的说明、系统提示词里的摘要与要点、来源（SDK 内置 / 扩展 / 插件）与当前是否启用，以及**参数表**（参数名 / 类型 / 必填 / 说明，嵌套对象按层级缩进）＋ 可折叠的原始 JSON Schema。定义是静态大对象（不进快照、不占上下文），点开时按名现取一次；DSH 引擎拿不到工具定义时明确写「当前引擎不支持」，而不是给一个空窗。右键工具卡不抢浏览器菜单（点在代码块/输入框上、或页面里已选中文字时照旧给系统菜单），也不会顶掉整条消息的右键菜单；新槽位 `contextmenu.toolcall` 同样进了设置 → 「界面布局」页（可隐藏 / 调序），插件也能往这个菜单里加自己的条目。

- **read 工具可直接读目录 + 接受 `file_path`** —— 模型把目录路径交给 read 时不再报 `EISDIR`，改为列出目录条目（一行一项、目录带 `/` 后缀，`limit` 此时是条目上限），看目录不必再走 bash 的 `ls`；read 同时也接受 `file_path`（`path` 的别名，两者都给时 `path` 为准）。实现是覆盖内置 read（同名 customTool），文件/图片/不存在的路径行为与原来完全一致；设置 → 工具页新增「read 读目录」开关（默认开），关掉即恢复内置行为。仅 pi 引擎生效（DSH 引擎的工具来自预设，无此覆盖面）。

### Fixed

- **Windows 下开启 terminalBash 长期运行不再导致 MSYS2 控制台耗尽死锁（issue #269）** —— 在 Windows 下开启「终端接管 bash」（`terminalBash: true`）时，之前每一次一次性命令（`persist=false`）都会自增创建新的 ConPTY 终端；不仅启动极慢（每次约 1.3s），且子进程退出或异常关闭时通过 Win32 `TerminateProcess` 硬杀会跳过 MSYS2 清理钩子，导致内核命名共享内存 `\cygwin.shared` 中的控制台设备 slot（上限 128）永久泄漏，累积约 128 次后报错 `fatal error - console device allocation failure - too many consoles in use, max consoles is 128` 并导致后续所有 bash 工具全面瘫痪。现在做了三重修复：① Windows 平台开启 `terminalBash` 时，一次性命令（`persist !== true`）自动分流走原生 SDK bash（纯进程基于 pipe，极速 20ms、零控制台设备分配），只有明确需要持久交互（`persist === true`）时才进入常驻可见终端 `ai-bash`（始终复用单个终端，只占 1 个 slot）；② 改进伪终端退出机制：子进程已退出时绝不再调 `process.kill(pid)`，直接释放 PTY 句柄；运行中被关闭时先写 `\x03exit\r` 尝试优雅退出再兜底强杀；终端自然 exit、history 淘汰和 `killAll` 时一律安全释放底层 ConPTY 句柄；③ 为 node-pty 的 `conpty_console_list_agent` 增加 try-catch 补丁，进程已死时 `AttachConsole` 失败不再抛出未捕获异常。
- **流式回复期间不再每帧重算整份会话统计（issue #259）** —— SDK 的 `session.getSessionStats()` 要遍历整份转写，而 `message_delta` 之前**每个流式帧**都调它一次（只为填 `usage`）。实测 6000 条转写的会话跑 6002 帧时，这一条链吃掉了流式阶段 **27.6%** 的 CPU（2123ms）。现在按 250ms 做短缓存（并按键到 session 实例，切换对话不会拿到上一份的读数）：实测流式 CPU **4.859s → 1.328s（3.7×）**，快照字节数完全不变。长会话（尤其并行子代理 × 长转写）下卡顿的主因之一。
- **长会话快照与折叠消息列表不再随子代理并发退化（issue #259）** —— 服务端不再让后台对话的 `tool_execution_end` / `agent_end` 给当前激活对话白刷快照；超过 4096 条转写时，序列化缓存改为只回收已不在当前转写里的死条目，保持消息对象引用稳定，让 `snapshot_delta` 继续生效。客户端折叠摘要行启用 `content-visibility: auto` 并固定占位高度，展开箭头改为纯 CSS，避免每行挂一个 SVG + polyline。6000 条历史消息 + 8 个子代理 × 5 次 bash 的实测：全量快照 **3 条 / 14.925MB → 0 条 / 0MB**，增量快照 **0 条 → 3 条 / 4KB**；折叠行内 SVG/polyline **3990/3990 → 0/0**，`.messages` 内元素约减少 22%。
- **pi SDK 依赖范围不再把 0.86.x 挡在门外，并说清「服务跑的是自带副本」（issue #260）** —— `package.json` 里 SDK 的范围原本是 `^0.85.1`，而 `^` 对 0.x 的语义是 `>=0.85.1 <0.86.0`：上游发到 0.86.1 也永远装不进来，只会一直用自带的 0.85.1 副本；而 npm 全局安装**不 hoist**（实测），Node 又「嵌套优先于祖先」，所以用户 `npm i -g @earendil-works/pi-coding-agent@latest` 改的是全局那份，服务加载的仍是自带那份 —— 表现为「升了 0.86.1，横幅和 `/api/health` 还显示 0.85.1」。现在范围放宽到 `>=0.85.1 <0.87.0`，并新增 `server/sdk-origin.ts`：启动横幅在检测到「有更新的副本被遮蔽」时给出提示，`/api/health` 新增 `piSdkCopies` 列出所有可解析到的副本（第一项 = 实际生效），README 也写明「升级全局 pi CLI 不会改变本服务运行的 SDK」。**另提供显式开关**：`PI_WEB_SDK=global` 时（issue #260 的另一半诉求）改用祖先链上**更新**的那份副本，否则回落自带副本 —— 默认仍是自带副本，因为不同机器跑不同 SDK 会让 bug 无法复现。
- **设了 `PI_CODING_AGENT_SESSION_DIR` 的用户不再「历史列得出来、却点不开」** —— 历史/最近项目从这个额外会话根扫盘，而打开 / 删除 / 改名的守卫只认 `<agentDir>/sessions/` 一个根：一点就报「路径不在允许范围内」，删不掉也改不了名。现在打开类操作与**列表同口径**（两个根都认），守卫的意图（只许开会话转录、不许开任意文件）没有放宽 —— 仍然必须是某个会话根下的转录。
- **`voice-input` 插件补上 `tools` 能力声明** —— 它的 manifest `permissions` 里少了 `tools`，而它要注册 `transcribe_audio` 工具；宿主对工具注册点是**硬门控**（未声明 `tools` 即拒绝注册），所以这个 AI 工具实际上**永远不会出现**在工具列表里，只在插件诊断里留一句话。其余所有注册 AI 工具的插件都声明了它；单测也补上了这条断言（以前没断言，所以缺声明时测试照绿）。输入框旁的 🎤 / 📷 不受影响（那两个走的是界面动作，不是 AI 工具）。

- **跨会话弹窗污染** —— 修复了当后台运行的子代理或其他会话触发提问（`ask_user_question`）时，问卷弹窗会无视当前正浏览的对话、强行在全局弹出的问题。现在问卷对话框只会在属于它的会话里弹出（其他会话只会正常出现「?」角标），切换到其他会话时会自动收起，切回原会话时也会自动恢复显示弹窗（仅 pi 引擎，DSH 引擎提问无会话归属保持原状）。
- **Android / Termux 上的文件面板与「选择目录」能用了（issue #262，PR #263）** —— 三处都是同一个原因的不同表现：① **目录符号链接在所有平台都按目标分类**（原来只有 Windows 分支跟随符号链接，posix 下 `~/storage/shared` 这类链接被判成「文件」）：文件树里能进去、不再显示成文件，只列目录的选择对话框也不再是一片空白；② **机器根（「此电脑」）在 `readdir("/")` 被拒时回落**到 `$HOME` 与 `/storage/emulated/0`（Android 上 `ls /` 本身就失败，原来点进去是死路）；③ **路径栏支持 `~` 展开**（`completePath` / `makeDir` 早就这么做，`listFiles` 漏了，于是 `~/storage/shared` 被当成工作区相对路径、静默变成空列表）。断链仍回落成文件；搜索的深度上限兼作环保护，Linux / macOS / Windows 行为不变。
- **`PI_WEB_TOKEN` 含 `=` 等特殊字符时不再「进得去、用不了」（issue #261）** —— 口令里带 `=`（base64 尾巴上最常见）、`+`、空格或非 ASCII 时，浏览器经 `?token=…` 进去那一次是 200，之后**每个资源请求都 401**（页面停在背景色）：服务端把口令按 `encodeURIComponent` 写进 cookie（RFC 6265 的 cookie-value 只允许 ASCII，`=` 必须转义），读取时却拿转义后的 `%3D` 去和原文的 `=` 比，永远不相等。现在读取 cookie 时先解码再比（新增 `decodeCookieToken`，脏值解不开就原样返回、不会把请求打成 500），手写 / 旧客户端的明文 cookie 仍然接受；`tests/token-auth-test.mjs` 增加整个特殊字符口令的场景（`?token=` → 仅凭 cookie 导航 → WS 凭 cookie 连接 → 明文 cookie），把修复撤掉即变红。
- **插件 bundle 的加载作用域不再互相覆盖（issue #268 里定位到的一条真实竞态）** —— 加载插件 bundle 时，「设插件作用域 + import」是**并发**跑的，而作用域是模块级变量：两个 bundle 求值交错时，后启动的那个会把全局作用域改成自己的 id，前一个插件在顶层 / 异步回调（如 notes 插件的 `whenBridge`）里注册的动作就落到**别人**名下（键从 `notes:notes:toggle` 变成 `<别的插件>:notes:toggle`）。宿主派发时按自己的 id 与裸名都查不到 → `kind: "action"` 的条目一点就弹「插件没有接管这个动作」（`kind: "view"` 的条目走视图分支、不过这张表，所以只有 action 中招）。现在两者串成一条闸门（`createScopedImporter`，导出以便单测），单个插件加载失败也不会卡住后面的插件。
- **认领工具（`claim_files`）补进工具目录 + 设置页开关** —— 之前它是常驻注册、不进 `AGENT_TOOL_CATALOG` 的例外，所以设置 → 工具页里根本找不到它（想关都关不掉）。现在按新增可开关工具的三处走：目录项（默认开，纯 advisory，关掉只少一路事前提醒、事后触碰集照常工作）＋ 设置页「其他」组开关行（紧跟「读取别的对话」）＋ 中英文案与 8 个语言包同步；工具目录 25→26。仅 pi 引擎（DSH 引擎无 customTool 注册面，提醒里照样能看到认领）。

### Changed

- **文件行右键也能「上传文件到当前目录」** —— 上传入口原先只对**目录**行显示，右键一个文件时菜单里根本没有这一项（想往当前目录传文件只能去右键空白处）。现在文件行也给，落点是它所在的目录：当前目录里的文件显示「上传文件到当前目录」，子目录里的文件显示「上传文件到文件夹」；只有机器根（不能往盘符根写）仍然隐藏，文件树右键菜单的其余条目不变。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（34）：`themeLight`、`themeDark`、`quickPhrasesSendTip`、`persistSubagent`、`toolImages`、`toolImagesDesc`、`toolImageZoom`、`toolWatchdogTimeout`、`toolWatchdogTimeoutDesc`、`toolWatchdogOff`、`uiLayoutContextToolcall`、`pluginSettingsTitle`、`pluginSettingsShow`、`pluginSettingsHide`、`claimFilesEnabledDesc`、`claimFilesOffHint`、`toolInfoMenuLabel`、`toolInfoTitle`、`toolInfoLoading`、`toolInfoUnsupported`、`toolInfoMissing`、`toolInfoActive`、`toolInfoInactive`、`toolInfoSource`、`toolInfoDescription`、`toolInfoNoDescription`、`toolInfoPromptSnippet`、`toolInfoGuidelines`、`toolInfoParams`、`toolInfoParamsNone`、`toolInfoSchemaDropped`、`toolInfoRawSchema`、`toolInfoRequired`、`toolInfoFootnote`
- 前端中文变更（1）：`elsewhereTip`
- 前端英文变更（1）：`elsewhereTip`
- 服务端新增 key（1）：`agent.conv.limit.reached`
- 服务端文案变更（2）：`subagents.spawn.started`、`subagents.list.empty`

<!-- auto-i18n:end -->

## [0.92.0] — 2026-09-20

### Added

- **插件设置的 `select` 候选值可由宿主现算（`optionsFrom`）** —— manifest `settings` 里写 `"type": "select", "optionsFrom": "models" | "thinkingLevels"` 即可让宿主在浏览器侧现算候选值：模型列已配置鉴权的模型（值 `provider/id`，标签同设置面板的模型选择器）、思考强度列 SDK 档位（`off`…`max`，文案走 `thinking.<值>`）；两者自动带一个空值选项 = 跟随全局默认，插件不用自己维护会过期的静态表。服务端不校验这类值（清单在浏览器侧、随配置变化），只留 200 字符长度护栏，非法值由用的时候（如 `host.chat` 切模型）报错；当前存值不在清单里（模型被删/手改过 storage.json）时也保留，不被下拉静默吃掉。
- **自定义模型提供商「补参数」支持随时中断与实时进度反馈** —— 模型配置面板中点击「补参数」后，新增实时进度显示（下载 OpenRouter / models.dev 目录、抓取依据网页、逐个匹配参数 N/M 与百分比），并提供「✕ 取消」按钮；点击取消后服务端立即截断网络连接与批处理，并自动保留中断前已匹配的模型行，避免弱网时无响应或无法停止。
- **微信通道（wechat-ilink）设置里的「模型」「思考强度」改下拉选择** —— 旧版是手打 `provider/id` 文本框，打错要到微信里跑完一轮才发现（切换失败）。现在从清单里选，空 = 跟随全局默认。
- **read 工具可直接读目录** —— 模型把目录路径交给 read 时不再报 `EISDIR`，改为列出目录条目（一行一项、目录带 `/` 后缀，`limit` 此时是条目上限），看目录不必再走 bash 的 `ls`。实现是覆盖内置 read（同名 customTool），文件/图片/不存在的路径行为与原来完全一致；read 也因此接受 `file_path`（`path` 的别名，两者都给时 `path` 为准）。设置 → 工具页新增「read 读目录」开关（默认开），关掉即恢复内置行为。仅 pi 引擎生效（DSH 引擎的工具来自预设，无此覆盖面）。
- **浏览器扩展（page-picker）：点一次图标就能看见「让 AI 操作本页」** —— AI 授权入口原来只挂在拾取**确认条**里（必须先在页面上点一个元素它才出现，「只想授权」的人白点一下）。现在拾取态底部常驻一条细条：直接显示本页授权状态（未授权 / 已授权 / 「AI 操作页面」总开关关着 / 查不到后台），并给出「让 AI 操作本页…」「与另一页配对…」「退出」；在扩展设置页点完「授权该页面」回到那个页面，细条自己变成「已授权 · 模型可操作本页」（扩展监听授权表变化，不用重新点图标、不用刷新）。细条只有按钮可点，其余区域点击照旧穿透到页面元素 —— 不影响拾取手感。
- **AI 可以主动把文件「拿给你看」（`present_files`）** —— 新工具让模型把产物直接推到对话里成卡片：图片、视频、音频**在消息内直接显示/播放**（不折叠、不用点），文本/代码/Markdown/HTML 给开头摘录 + 「预览」按钮开文件预览弹窗（行号、选区、加进对话都在那边），不能内联的（PDF/二进制）只给下载与本地打开；每一行都带「预览 / 本地打开（用默认应用打开文件）/ 在文件夹中显示 / 下载 / 复制路径」，其中「本地打开」「在文件夹中显示」与右栏文件树右键菜单**同一套协议**（服务器跑在别的机器上时由服务端明确提示不支持，不是默默没反应）；路径不存在时卡片直接标红说明，不会给你一个点不动的东西。模型还能把某个文件标成「先看这个」，配合设置 → 消息显示新增的「自动打开 AI 展示的预览」开关（默认关）就能自动把预览窗弹出来（只对刚发生的卡片生效，翻旧会话不会突然弹窗）。工具目录 24→25（默认开，**设置 → 工具页有独立开关**，可随时关掉）。仅 pi 引擎（DSH 引擎的工具来自预设，无此覆盖面）。

- **插件可以「没有独立视图、但每次进页都常驻加载」（manifest `preload`）** —— 有的插件根本不需要自己的 tab（界面全在浮窗 / 输入框按钮 / 消息卡片里），但它的客户端代码必须一直在跑（到点提醒的长轮询、快捷键、常驻浮窗的状态恢复）。以前这种插件只有两条路：要么写 `view: false`（宿主**不**预加载，只有点它的按钮才 import → 刷新页面后提醒/浮窗全停摆），要么被迫留一个没人用的视图 tab。现在 manifest 写 `"view": false, "preload": true` 即可：宿主每次进页都预加载它的 bundle（顶层代码跑完即算加载成功，**可以没有 `default.mount`**），但仍不给它视图 tab。笔记插件是第一个用户（见下面 Changed）。
- **SCM 提交树过滤 + 提交信息历史** —— 提交树列表头新增过滤框：按主题 / 作者 / hash / 分支·标签实时过滤（空格分隔多关键字 AND 语义，计数徽标显示「命中/总数」，切工作区自动重置）；提交输入框支持 ↑/↓ 回溯最近用过的提交信息（shell 风格：↑ 记住当前草稿并翻回历史，↓ 逐级退回，localStorage 存最近 20 条，去重置顶、隐私模式静默降级）。纯前端零协议改动；过滤与回溯的纯函数带单测（`scm-history-filter` / `scm-commit-history`）。
- **顶栏插件改成单个 🧩 入口（插件视图默认不再占顶栏）** —— 以前装了视图的插件每个都在顶栏占一个 tab，插件一多就被挤进「⋯」，装得越多越难找。现在顶栏只留一个 🧩：点开是全部已装插件的面板，每行带图钉（钉住的插件视图 tab 才回到顶栏直流），行首把手可拖拽排序、聚焦后也能用 ↑/↓ 调序（只改插件视图彼此的相对次序，其它条目的排序偏好原样保留），点行本身直接切到该插件视图，底部「管理插件」直达设置 → 插件 → 市场。纯渲染器插件（`view: false`）与报错插件照样列出（后者行内显示原因），但不给图钉、行不可点。**升级注意**：插件视图默认「未钉住」= 不再出现在顶栏，之前装过插件的用户需要在 🧩 面板里挨个钉回来；钉住状态与设置「界面布局」页的勾选框是同一套存储与语义，两边改都生效。顺带两处修正：插件视图不再被历史排序偏好挤到对话/终端之前（独立区段排在 Git 之后），以及「设置」入口被固定保护 —— 不能被插件 arrange 或布局偏好隐藏（布局页该行勾选框置灰），空间不够时它也优先留下、不让位给「⋯」（`fitTopbar` 常驻项先占预算）。

### Fixed

- **设置「工具」页漏挂的两个工具开关（`skill` / `present_files`）补齐** —— 该页的工具行是手写的，终端组/子代理组按名单循环渲染，成“其他”组逐个手写，因此工具只进 `AGENT_TOOL_CATALOG` 目录、忘了写行的时候，会出现「目录里有、设置里找不到」：工具默认开着且关不掉。现在两个开关都在「其他」组里，并新增静态守卫单测（`tests/unit/settings-tool-rows.test.ts`）：目录里每个工具必须能被设置页渲染（循环组或显式行），今后再漏会直接 CI 报红。

### Changed

- **笔记插件：去掉独立视图 tab，浮窗成为唯一界面（插件 0.2.0）** —— 以前它有两个入口：顶栏按钮开浮窗 + 🧩 插件面板里的「笔记」行开一个完整视图 tab（浮窗头部还多一个 `⤢` 按钮指向它），同一件事三个入口。现在只留一个：顶栏 **📌**（图标从「日历打勾」换成图钉，与浮窗头部同一枚）开合浮窗，浮窗里工作。同时修了浮窗里四处布局毛病：① 正文区不再按内容撑高（实测 440px 的窗口里列表高 600px，日历会画到底栏和设置层上去），现在自己收缩成可滚动的一块；② 设置从「挤在窗口底部的第三块」（一开就把正文压成一条缝、还套了两层容器）改成**盖在正文之上的覆盖层**（自带标题栏 + ✕，内部滚动，正文不被压缩）；③ 设置里「语言」标签不再被下拉框挤成竖排两个字；④ 底栏在窄窗里从三行压成一行（提醒那句长了给省略号），日历格子在窄窗里也矮了一档。**升级注意**：已装插件需要更新一次（`pi-web-ui install --name notes --force` 或重装），且改完 manifest 后要触发一次重扫（设置 → 插件 → 重新扫描，或重启服务）才会生效。
- **插件声明式设置表单改成单列行式布局** —— 旧版是 `auto-fit` 网格 + `space-between`：窄列时长标签被逐字挤成**竖排**（如「允许的用户默认工作空间」一个字一行），勾选框被甩到行最右端、与标签断开，输入框/下拉/数字框宽度也各自为政。现在统一为「标签固定左列（不压缩、超长省略号 + 悬浮看全名）+ 控件右列（文本/下拉 420px、数字 120px、勾选框贴标签）」，行间细分隔线；`hint` 从只挂 `title` tooltip 改为**常显在标签下的小字**（最多两行）；窄窗口（≤720px）标签与控件上下堆叠。纯渲染层改动，manifest `settings` schema、`plugin_settings` 协议与既有 class 名（`.plugin-settings-field/-save/-reset/-form`）均未变。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（45）：`setGlobalDefault`、`clearGlobalDefault`、`globalDefaultBadge`、`themeGroupClassics`、`themeGroupBuiltin`、`scmHistoryFilterPlaceholder`、`scmHistoryFilterTip`、`scmHistoryFilterEmpty`、`scmCommitHistoryTip`、`antigravityTemplateTitle`、`antigravityTemplateDesc`、`antigravityFillOpenAI`、`antigravityFillAnthropic`、`enrichModels`、`enrichModelsHint`、`enrichHintPh`、`enrichingModels`、`enrichModelsCancel`、`enrichModelsAbort`、`enrichCancelling`、`enrichModelsCancelled`、`enrichModelsOk`、`enrichModelsErr`、`enrichModelsNeedIds`、`readDirEnabled`、`readDirEnabledDesc`、`pluginMenuTitle`、`pluginMenuPin`、`pluginMenuUnpin`、`pluginMenuReorder`、`pluginMenuReorderHint`、`pluginMenuManage`、`pluginMenuEmpty`、`pluginMenuNoView`、`uiLayoutRequired`、`pluginSettingsInherit`、`presentOpenLocal`、`presentMissing`、`presentEmpty`、`presentAutoOpen`、`presentAutoOpenDesc`、`presentFilesEnabledDesc`、`presentFilesOffHint`、`skillEnabledDesc`、`skillOffHint`
- 服务端新增 key（45）：`claimfiles.no.store`、`claimfiles.list.empty`、`claimfiles.list.ttl`、`claimfiles.list.head`、`claimfiles.release.all`、`claimfiles.bad.paths`、`claimfiles.bad.outside`、`claimfiles.claim.ok`、`claimfiles.claim.conflict`、`claimfiles.claim.noop`、`claimfiles.release.paths`、`claimfiles.bad.action`、`convread.read.query.head`、`convread.read.chat.note`、`convread.list.bad.kind`、`convread.list.running.more`、`convread.list.history.more`、`convread.list.head.running`、`convread.list.head.history`、`convread.list.head.all`、`convread.read.bad.view`、`convread.read.query.empty`、`convread.files.empty`、`convread.files.more`、`convread.files.head`、`convread.files.claims`、`convread.status.head`、`convread.status.last.tool`、`convread.status.no.tool`、`convread.status.last.say`、`convread.status.no.say`、`convread.status.touched`、`convread.status.touched.none`、`convread.status.waiting`、`convread.status.claims`、`models.enrich.empty`、`models.enrich.cancelled`、`present.files.result.head`、`present.files.result.kindDir`、`present.files.result.missing`、`present.files.result.tail`、`present.files.result.allMissing`、`present.files.result.disabled`、`present.files.result.noItems`、`read.dir.header`
- 服务端文案变更（1）：`convread.bad.action`

<!-- auto-i18n:end -->

## [0.91.0] — 2026-09-19

### Added

- **消息一键复制三件套**（#228）—— 消息 hover 工具条新增「复制纯文本 / 复制 Markdown / 复制为图片」：纯文本走轻量去标记（标题/加粗/链接/表格/代码围栏只去标记留内容）；Markdown 取原始源码；图片用 html-to-image（按需加载）把气泡导出 2x PNG 写剪贴板（工具条/复制键/流式光标自动排除）。三个都是 `message.actions` 槽位条目（`host:msg-copy-text/markdown/image`），布局页可隐藏/调序。
- **上下文压缩软上限 Soft Cap**（#229）—— 设置「对话」页可设全局压缩阈值（tokens）+ 按模型覆盖（`provider/id`，如 `xai/grok-4 → 190000`）：会话 tokens 到线即触发已有压缩流程，不再堆到物理上限（防 Grok 类阶梯计费翻倍与长上下文降智）。实现为 `compaction.reserveTokens = window - cap` 的 SDK SettingsManager 覆盖（与重试次数同一 live 机制，reload/建会话/换模型后重放，关闭时回填 SDK 默认 16384）；底栏上下文条按 `cap/window` 画琥珀色标记线 + hover 显示阈值。pi 引擎独有（DSH 运行时无此概念，保持关闭）。
- **SCM「AI 生成」提交信息**（#233）—— SCM 面板提交输入行旁新增生成按钮：服务端汇总暂存区 + 工作区 diff（各截 12000 字符并标注截断）+ numstat + 近 15 条提交主题拼提示词，风格跟随仓库近期提交；走 `completeSimple` 一次性补全（不进对话上下文、不打断流式回复），60s 超时；无模型/非仓库/无改动/失败一律恰好应答一次，按钮不卡转圈。提示词可在设置 → 提示词「AI 提交信息」区块追加/替换（不进预设）。
- **技能全文按名加载工具 `skill`** —— 名录只渲染 name/description，模型不再拼 `location` 路径调 read，需要正文时调 `skill({name})` 精确命中（单文件 8KB 封顶，禁用集由宿主过滤）；工具目录 23→24（默认开）。
- **插件通道对齐定时任务能力**（#226）—— `host.chat` 新增 `cwd` / `conversationId` / `model` / `thinkingLevel` 四个可选参数：`cwd` 显式 pin 工作空间（不存在即拒绝，Windows 下系统目录如 System32 直接拒绝，防后台启动时 cwd 飘到 system32 高危执行）；`conversationId` 命中运行中对话时走 steer 语义投递（网页端实时可见，miss 则回落无头执行）；`model` / `thinkingLevel` 投递前预切，失败即拒绝不回落。`wechat-ilink` 跟进：设置里可配默认工作空间、模型、思考强度与「投递到网页当前会话」开关。

### Changed

- **插件运行相位 + 坏 manifest 占位行 + 顶栏缺省收起** —— 设置面板插件清单新增运行相位（failed/disabled/active/idle，汇总条 + 行内圆点 + 重扫按钮）；坏 manifest 目录不再静默跳过，清单里出占位行标红给原因（`error` + `view:false`，不激活）；顶栏低频条目（浏览器操作/声音/语言/主题/版本/GitHub）缺省收进「⋯」，布局页可勾回。

### Fixed

- **插件图标 SVG 清洗误杀** —— 白名单比较改大小写不敏感（`viewBox` 曾被整条剥掉致坐标系映射失效）；补 `ry`/`points`/`fill-opacity`/`stroke-opacity` 等缺属性（run-trace 的 FiActivity 整图标不可见即 `points` 被剥）；`script`/`style`/`title`/`desc`/`foreignObject` 整棵删除（子节点外来命名空间，展平会漏进 SVG）；catalog 补 10 个插件 `iconSvg`。
- **全部组件更新面板列表项防压扁**（#224）—— 补 `flex-shrink: 0` + 悬停暴露错误详情。
- **插件设置保存后重启即丢（storage 旧快照回写）** —— `PluginStorage` 首次 `load()` 后**缓存永不失效**，而 `storage.json` 有两个写入者：插件自己，以及设置面板的 `saveSettingsValues`（直写磁盘的 `settings` 键，不经过该缓存）。长轮询插件每隔几秒就 `storage.set("cursor", …)` 一次，于是把整份旧快照回写，把面板刚保存的 `settings` 抹成 `undefined` —— 表现为「面板里改了设置、当次会话生效、重启后全部回落默认」。现改为写前重读磁盘（`set`/`delete` 无条件重读，不受 mtime 粒度影响），两个写入者各自保留自己的键；读路径仍走缓存。
- **`host.chat` / 定时任务的模型切换静默失败**（#226 的「失败即拒绝」未真正生效）—— `ClientSession.setModel` 为兼容 UI 把异常吞成 notice（面板要看到原因，调用方是 fire-and-forget），**永不 reject**，于是插件与定时任务里 `try { await cs.setModel(m) } catch` 的 catch 永不触发：模型 ID 打错或没配供应商密钥时，会静默按旧模型跑完整轮次（账单与效果都和用户预期不符）。新增 `switchModelOrThrow`（切完复核当前模型，不符即抛）供无头路径使用；UI 路径的 `setModel` 语义不变。
- **子代理 8 项修复** —— `steer`/`stop` 对不存在的 runId 不再谎报成功（先查快照，找不到回未找到 + 指引查 `subagent_list`）；`wait_all` 收口长输出改留头 10 行 + 留尾 30 行（旧实现只取前 30 行，结论在尾部会被丢掉）；子代理数量上限 16 个（每客户端全局计，超限抛错由工具转友好文本，AI 可改串行/等收口后重试）；`spawn`/`delegate` 的启动失败（上限/runtime 创建失败/坏 cwd）转返回文本不再直抛工具异常；相对 `cwd` 按派发者目录解析（旧实现相对 server 进程 cwd 落到别处）；跟随模型/思考强度/项目密钥改读真正的派发者会话（旧实现读派发瞬间 active，后台派发会跟错）；模板 replace 在 SDK 提示词边界串对不上时前置拼接兜底（旧实现静默回退默认 persona）；模板非空扩展白名单不再漏进插件/MCP 工具（工厂期不注册 + `refreshPluginTools` 不回补）；快照补上 `prompt`（截断 2000 字符）与 `canceled` 终态；`replace + 空提示词` 模板保存期直接拦截（只想限白名单请用 append）。
- **升级后主题 CSS 全部 404**（#223）—— 0.90.1 的 Express 4→5 升级后，`sendFile`/`download` 默认 `dotfiles=ignore`，绝对路径含隐藏目录段（如 `~/.pi-web`、`~/.local`、`~/.nvm`）的文件一律被判 404。已对主题 CSS、插件 bundle、文件预览/下载、打包下载、首页等全部绝对路径发送点显式放行（路径本身仍由各路由的 id 白名单/工作区 containment 校验把关），并加冒烟回归 `theme-dotfile-test`。
- **插件 client bundle 在默认 `~/.pi-web` 下 404**（#230）—— 经实测验证为已修复问题的重复报告：#223 的泛化修复已覆盖插件路由（`dotfiles: "allow"` + `splatParam` 数组兼容），单文件/多级 splat 200、越界 `../..` 404 拦截，直接关闭无代码改动。
- **定时任务压缩/重启后静默转无头**（#231）—— `schedule_task` 只绑内存对话 id（`c1/c2…`，各客户端从 0 计数、重启/切走即失效），压缩或重启后触发必然误判 closed/gone，巡检报告静默落进后台历史、前台毫无动静。现创建时同时快照落盘会话文件（压缩/重启后稳定）：触发先按会话文件重认同一会话（含换新 id 自动重绑定，下次直达）；原句柄断开时先回落同项目活跃对话并广播提示；同项目无存活对话才无头执行且明确广播去向。同时 id 唤醒加 `cwd` 护栏（跨项目同 id 必然撞车，不校验会把报告投进无关项目）。
- **重复压缩标记导致会话打不开**（#235）—— 多次上下文压缩后转录里攒下多个同名 `pi-web-ui-compaction-done` 标记；若标记恰为文件末行，重启后新消息的 parent 会记成该共享 id，SDK 的 last-wins 索引把它解析到最后一个标记（其 parent 前指同子树）→ 回溯成环，`getBranch` 死循环直到 `RangeError: Invalid array length`，整个会话报 `Failed to initialize session`。现标记 id 每次唯一（`clearCompactionPending` 改按 `customType` 定位本次 pending），四个会话打开点（首屏恢复/切项目/打开历史/强制重置）遇到坏转录自动修一次再试：残留 pending 移除（子节点旁路到 pending 的 parent，marker 对上下文零贡献，仍弹"可 /compact 重试"）、重复 id 改名＋引用改指最近的前序同名、残余环截断；改前同目录留 `.bak` 备份（已存在不覆盖，保最早现场）。
- **插件子目录文件 404，插件面板白屏**（#225）—— 0.90.1 的 Express 4→5 迁移把通配路由改成命名 `*splat`，但多段路径在 Express 5 里是**数组**（`["a","b.mjs"]`），直接 `String()` 会拼成 `"a,b.mjs"`：插件 vendor 分包/CSS、嵌套文件 HTTP 预览、插件子路径 API（`/plugins/*`、`/plugins-api/*`、`/api/preview/*` 三处）全挂。已加 `splatParam` 统一拼回 `/`（下游越界/包含校验不变），回归进 `plugin-test`（vendor 嵌套）/`plugin-http-test`（多段 API）/新增 `preview-http-test`。另：切到 bundle 没加载出来的插件视图不再静默空白——给「加载中/失败原因 + 重试」占位（`PluginViewFallback`，重试带 `&r=` 击穿 ESM 模块表的失败缓存），真机 E2E 验证过。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（36）：`brand`、`pluginViewLoading`、`pluginViewLoadFailed`、`pluginViewLoadFailedHint`、`pluginViewRetry`、`softCapTokens`、`softCapHint`、`softCapOff`、`softCapByModel`、`softCapByModelHint`、`softCapModelId`、`softCapAdd`、`softCapRemove`、`softCapMarker`、`copyText`、`copyMarkdown`、`copyImage`、`copyFailed`、`scmGenMsg`、`scmGenMsgRunning`、`scmGenMsgTip`、`scmGenMsgFail`、`parallelReminderEnabled`、`parallelReminderEnabledDesc`、`parallelReminderOffHint`、`scmCommitMsgSettingsTitle`、`scmCommitMsgSettingsDesc`、`scmCommitMsgPromptPlaceholder`、`scmCommitMsgSettingsHint`、`uiLayoutTopbarText`、`pluginPhaseActive`、`pluginPhaseDisabled`、`pluginPhaseFailed`、`pluginPhaseIdle`、`pluginRescan`、`pluginRescanHint`
- 前端删除 key（2）：`brandLogo`、`brandName`
- 服务端新增 key（21）：`agent.subagent.limit.reached`、`scm.commitmsg.no.model`、`scm.commitmsg.no.changes`、`scm.commitmsg.model.terminated`、`scm.commitmsg.empty`、`scm.commitmsg.not.repo`、`scm.commitmsg.timeout`、`delegate.start.failed`、`plugins.manifest.broken`、`prompt.skills.intro.use.skill`、`skill.catalog.empty`、`skill.catalog.title`、`skill.catalog.hint`、`skill.not.found`、`skill.no.filepath`、`skill.file.unreadable`、`skill.file.empty`、`skill.file.failed`、`subagents.spawn.failed`、`subagents.steer.not.found`、`subagents.stop.not.found`
- 服务端文案变更（1）：`subagents.wait.empty`
- 服务端删除 key（1）：`prompt.skills.intro.use.read`

<!-- auto-i18n:end -->

## [0.90.1] — 2026-09-18

### Added

- **多标签页对话过户 + 跨页作答 + 残留自动认领** —— 右键 elsewhere 行可把整段对话（含子代理后代、等答复问卷、看门狗剩余计时）过户到本页并切过去；别处的待答问卷可拉到本页作答；关浏览器重开后、无其他在线标签时自动认领最近的有内容残留。

### Changed

- **依赖大版本升级**：Express 4→5（通配路由改 `*splat` 具名写法）、React 18→19（JSX 类型改显式导入）、Vite 6→8（分包改 `advancedChunks.groups`、裸 CSS 导入加类型兜底）、mermaid 11→12（vendor 包 `--mermaid-*` 主题钩子入 CSS 白名单），其余小版本同步跟进。
- **systemd 安装器**（#219）—— 监听 1024 以下端口时自动加 `CAP_NET_BIND_SERVICE`（仍以安装用户运行，不改 root）；`PI_WEB_TOKEN` 持久化进 unit 文件（0600 权限）；详见 `docs/deployment.md`。

### Fixed

- **桌面版自动更新接线导致启动即闪退**（#220）—— `electron-updater` 的 `autoUpdater` 是用 `Object.defineProperty` 懒 getter 导出的，Node 的 ESM 具名导出探测看不到它，`const { autoUpdater } = await import("electron-updater")` 恒为 `undefined`，`wireAutoUpdater` 随即抛 `TypeError`，使 0.90.0 桌面版（macOS 实测，同一份 `dist/desktop/main.js` 也用于 Windows/Linux）装完根本打不开。改为回落到 `default` 再取一次，两者都取不到则降级为“更新不可用”，不再拖垮启动。

- **手机端触摸拖动滚动**（#218）—— 触屏拖动内容滚动，兜底 xterm 6.0.0 的触摸滚动回归。
- **Windows 关机跳过 `pty.kill`**（#215 跟进）—— 根治 ConPTY 关停死锁。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（3）：`takeoverConversation`、`takeoverHasQuestion`、`waitingQuestionBadge`
- 前端中文变更（1）：`elsewhereTip`
- 前端英文变更（1）：`elsewhereTip`

<!-- auto-i18n:end -->

## [0.90.0] — 2026-09-18

### Added

- **手机端顶栏折叠** —— ≤768px 宽度时顶栏只保留 ☰ / 新对话 / 打开项目 / 📁，其余入口一律退进同一个「⋯」溢出菜单（与桌面端实测溢出走同一通道，不是第二套硬藏面板）；📁 去文字变纯图标按钮，钉在 ⋯ 右边最右；跨断点实时切换。
- **顶栏自适应溢出 + 项目选择器 + 定时任务工具** —— 顶栏按实测宽度自动把放不下的入口收进「⋯」菜单（窗口变宽自动回来）；顶栏直选打开项目；定时任务可配 AI 工具。
- **文件管理：压缩解压与文件夹上传**（#190）—— 文件树新增压缩 / 解压缩动作，支持整个文件夹上传（含冲突策略与大小限制提示）。
- **底栏主机资源监控** —— 底栏实时显示主机处理器与内存使用率，悬浮看明细。

### Changed

- **设置面板 macOS 分组风视觉重构 + 内容区对齐精修**。
- **左栏操作区布局溢出修复 + 精简界面入口**。
- **布局页按界面顺序分组** —— 顶栏溢出菜单保序保样式，布局偏好里的分组与界面实际顺序一致。

### Fixed

- **发送失败给出可见错误提示** —— 发送失败不再静默吞掉，界面上直接提示。
- **排队消息按索引删除**（#200）—— `removeQueued` 按索引删，文本只做回退匹配，重复文本不再连带误删。
- **更新面板：过时行按钮优先 + git 扩展名填充**（#202）。
- **↑ 翻历史可靠进入 prompt 历史**；**提交后按时间戳水位丢弃过期草稿**；**switchSession 限定 sessions 根目录**；**折叠控制展开时保持在左侧**。
- **在资源管理器中显示 / 默认打开不再压住 GUI 窗口**；**git 扩展更新命令加 `git:` 前缀，更新面板隐藏 SHA 并修复横向滚动**。
- **Windows ConPTY 关停死锁改走外部看门狗**（#215）；**心跳定时器 unref，不再阻塞进程退出**。
- **无挂载 widget 时跳过刷新**（perf）；**未知消息类型节流打日志**；**WS maxPayload 对齐 100MB 上限**。
- **安全**：TLS 下 `pi_web_token` cookie 加 `Secure` 标记；`shell.openExternal` 前做 URL scheme 白名单校验。
- **设置重载失败打日志**，不再静默吞错。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（27）：`brandLogo`、`brandName`、`manageProjects`、`projectPickerTitle`、`newProject`、`projectName`、`createAndOpenProject`、`invalidProjectName`、`openProject`、`fileCompress`、`fileExtract`、`fileCompressDownload`、`fileUploadFolder`、`fileChooseFolder`、`fileExtractDestination`、`fileConflictPolicy`、`fileConflictSkip`、`fileConflictOverwrite`、`fileConflictError`、`fileArchiveLimits`、`fileFolderUploadHint`、`fileTransferBusy`、`fileTransferFailed`、`conversationReadEnabledDesc`、`conversationReadOffHint`、`scheduleTaskEnabledDesc`、`scheduleTaskOffHint`
- 服务端新增 key（9）：`sched.not.wired`、`sched.task.bad.schedule`、`sched.task.interval.too.short`、`sched.task.empty.prompt`、`sched.task.no.cwd`、`sched.list.empty`、`sched.cancel.empty.id`、`sched.cancel.not.found`、`sched.cancel.ok`

<!-- auto-i18n:end -->

## [0.89.0] — 2026-09-17

### Added

- **文件树右键：在资源管理器中显示 / 用默认应用打开**（issue #187）—— 文件/目录右键新增「在资源管理器中显示」（Windows 选中文件、macOS 访达定位、Linux 打开所在目录）与「用默认应用打开」（仅文件，如 Excel 开 xlsx）。服务端 `spawn` 直调系统命令（detached，不占进程），远端/无桌面主机回 warning 提示。

- **插件宿主 API v11：模型目录 + 定模型开对话**（issue #188）—— 插件经 `models.list()` 拿到已配置的模型目录（canonical `provider/model`，与 `set_model` 同口径，给插件做真实的模型选择器用），`startChat` / `openSession` 新增 `model` 选项（须在目录里，非法直接拒绝、不建对话、不动旧对话的模型；newChat 时先建新对话再把**新对话**切到该模型）。

- **插件通用反向代理 + 实时预览插件（live-preview）** —— 插件经 `host.registerProxy(prefix, 127.0.0.1:port)` 把真服务（只绑回环地址，外部不可达也无妨）挂到同源前缀下对外暴露：去前缀原样透传（相对路径/Range/SSE/ws upgrade 全可用，目标锁死回环防 SSRF，鉴权继承主站口令）；live-preview 用它实现 `/liveserver`（HTML 预览：目录默认 index.html、改文件 SSE 自动刷新）与 `/md`（Markdown 渲染），另带 `live_preview` AI 工具。

- **内置定时任务调度**（issue #184）—— 设置面板新增「定时任务」页：任务名称/说明、执行目标项目（cwd）、Cron 表达式（常用预设一键选 + 自定义 5 字段）或固定间隔、可选模型与思考强度、启用/停用；任务列表展示下次触发与上次状态（成功/失败/耗时/手动标记），支持手动立即运行与历史记录（近 20 次）。触发经无头伪客户端执行（每任务独立会话、无浏览器也能跑，最长等 10 分钟回填真实结果），跑完推送通知；配置落盘 `<dataDir>/scheduler-tasks.json`（全局共享，重启不丢，catchUp 可补跑一次）。标准 pi 引擎可用，DSH 下该页隐藏。

- **输入框可拖拽调高** —— 输入框顶部悬停出现抓手，上下拖动直接固定输入区高度（40–720px，内容少也撑大，localStorage 持久化），双击恢复自适应高度。

- **桌面版应用内更新**（issue #180）—— 桌面壳的服务随应用包发布，`npm i -g` 换的是别处：顶栏更新面板在桌面里改走 electron-updater（检查 → 下载 → 安装并重启，全程面板内完成，另有下载页直链兜底）；太旧的桌面壳（无更新通道）只给下载页指引。mac 产物补 zip（增量更新通道只吃 zip），Windows 安装包文件名去空格（修更新 feed 里下载链接 404）。
- **「全部组件更新」覆盖 git 源扩展**（issue #178）—— `settings.json` 里 `git:` 源的扩展以前在更新面板里根本不出现。现在全局 + 项目两级 settings 的 git 条目各列一行（远端 `git ls-remote` 比对，`pi update <host>/<path>` 一键更新）；`PI_WEB_GIT_EXTENSION_CHECK=0` 可关掉这一路（大仓库逃生口）。
- **设置面板：界面布局独立分组 + 插件市场子页签** —— 「界面布局」从界面插件页里搬出来自成一组；插件市场拆出「市场 / 插件列表」子页签，已安装插件另列一页，不再和市场列表挤在一起。
- **插件 AI 工具统一门控** —— 插件经 `registerAgentTool` 注册的 AI 工具在设置 → 工具里按插件列出，可逐个关闭（关闭即从会话移除、重开立即加回，无需 reload；禁用记录保留，重装仍保持关闭）。webmail 的「允许 AI 管理邮箱」插件内开关同步取消（改常驻，走统一门控关）。
- **数据库插件注册 AI 工具**（db-client）—— `db_connections` / `db_databases` / `db_tables` / `db_schema` / `db_rows` / `db_query` / `db_redis_keys` / `db_redis_get` / `db_redis_cmd` 常驻注册（开关走上面的统一门控），模型可按连接 id / 名称直接查库；AI 打开的连接不计入面板状态点。
- **编辑器插件 AI 自主操作（vscode-editor 0.4.0）** —— 注册 15 个 `vsc_sftp_*` / `vsc_ssh_*` / `vsc_remote_*` 工具：模型可自己读/存 SFTP 同步配置（`.vscode/sftp.json`，vscode-sftp 兼容）、测试连接、一键上传/下载代码，新建 SSH 主机、拨号、远端执行命令、远端文件列表/读写/复制/删除/搜索；与界面表单共用同一套后端校验（`upsertSyncCfg` / `upsertSshHost` / `buildSshOpts` 收敛，旧逻辑原样迁移）。
- **编辑器文件树与右栏文件列表对齐** —— 右键剪切/复制/粘贴（同 scope 内移动或复制）、创建副本（`_copy` 自动递增）、复制路径、两棵树工具栏 🔍 文件名搜索（结果复用 Ctrl+P 浮层，远端带 🌐 标记）；远端删除改为递归（含非空目录）、远端写/建自动补父目录；新增 `copy` / `search` 服务端动作（本地 + 远端 SFTP 共用）。

### Changed

- **切项目更快** —— 冷切换先回 ack，模型/key 恢复扔后台做（带代际 guard，半路又切走自动丢弃，做完补一次快照刷新模型栏）；历史面板没打开过不扫盘；最近项目列表 15s 缓存 + 并发搭车，不再反复扫盘。

### Fixed

- **顶栏「⋯」溢出菜单不再裁掉搬进来的语言/主题等下拉（issue #183，#162 的回归）** —— 溢出菜单 portal 化之后，菜单项的无作用域 `button` 规则盖掉了嵌套 Dropdown 触发器（`.chip`）与面板行（`.dd-item`）的 flex 布局，且 portal 自身的纵向滚动在横向上也裁掉了宽 340px 的嵌套面板（标题切成 `ANGUAGE`）。菜单项规则收紧为直子选择器；嵌套面板打开时 portal 经 `:has(.dd-menu)` 门控放行横向溢出（平时长列表照样内滚）。
- **残留 AI bash 不再把对话钉在列表里**（issue #181）—— 终端接管 bash 留下的 ai-bash 记录是 agent 的内部执行记录，随对话一起释放；以前它们被算成“存活终端”，移出/✕ 关对话时被拦截，会话永久赖在运行列表里。现在移出与关闭拦截只看用户亲手用过的终端，pi 与 DSH 双端同修。
- **Windows 下 `/webui` 启动不再闪一下控制台窗口**（#176，社区）—— spawn 补 `windowsHide`，`detached` 只在非 Windows 下设；POSIX 行为不变。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（89）：`composerResize`、`updateDesktopNote`、`updateDesktopCheck`、`updateDesktopChecking`、`updateDesktopAvailable`、`updateDesktopDownload`、`updateDesktopDownloading`、`updateDesktopDownloaded`、`updateDesktopInstall`、`updateDesktopManual`、`updateDesktopError`、`updateDesktopNoBridge`、`kindGitExtension`、`fileReveal`、`fileOpenDefault`、`refreshBuiltinCatalog`、`refreshBuiltinHint`、`refreshBuiltinBusy`、`refreshBuiltinOk`、`refreshBuiltinFail`、`appendModel`、`appendModelTitle`、`appendModelIdPh`、`appendModelNamePh`、`appendModelAdd`、`appendModelBusy`、`appendModelCancel`、`appendModelOk`、`appendModelFail`、`appendModelApiTitle`、`appendModelApiAuto`、`appendModelBaseUrlPh`、`toolsSectionPlugin`、`toolsPluginHint`、`pluginToolsSection`、`pluginToolsEmpty`、`pluginToolOffHint`、`pluginListTab`、`settingsScheduler`、`schedulerDesc`、`schedulerEmpty`、`schedulerNew`、`schedulerEdit`、`schedulerDelete`、`schedulerRunNow`、`schedulerRunning`、`schedulerEnable`、`schedulerDisable`、`schedulerEnabled`、`schedulerDisabled`、`schedulerNameLabel`、`schedulerNamePlaceholder`、`schedulerDescPlaceholder`、`schedulerCwdLabel`、`schedulerCwdPlaceholder`、`schedulerUseCurrentCwd`、`schedulerKindLabel`、`schedulerKindCron`、`schedulerKindInterval`、`schedulerCronPlaceholder`、`schedulerPresetDaily`、`schedulerPresetHourly`、`schedulerPresetHalfHour`、`schedulerPresetWorkday`、`schedulerPresetMonday`、`schedulerPresetCustom`、`schedulerIntervalMinutes`、`schedulerPromptLabel`、`schedulerPromptPlaceholder`、`schedulerModelLabel`、`schedulerThinkingLabel`、`schedulerCatchUp`、`schedulerCatchUpHint`、`schedulerNextFire`、`schedulerLastRun`、`schedulerNeverRun`、`schedulerHistory`、`schedulerManualBadge`、`schedulerRunOk`、`schedulerRunFail`、`schedulerConfirmDelete`、`schedulerSave`、`schedulerCancelEdit`、`copyConversationId`、`copyConversationPath`、`quoteConversation`、`quoteConversationShort`、`attachConversation`、`attachConversationShort`
- 服务端新增 key（6）：`convread.list.bad.scope`、`convread.read.bad.args`、`convread.read.id.not.found`、`convread.read.path.not.found`、`convread.bad.action`、`dsh.provider.builtin.refresh.unsupported`

<!-- auto-i18n:end -->

## [0.88.0] — 2026-09-16

### Added

- **底栏主机资源指标**（#174）—— 底栏实时显示主机处理器与内存使用率，悬浮看明细；`bottombar` 对齐方式改为数据驱动，随布局偏好走。
- **布局槽位全量接线** —— `chat.header` / `chat.empty` / `file.preview.toolbar` 接上渲染（无贡献时 DOM 与原来一致）；设置布局页从 9 槽补到 21 槽，新增搜索过滤、align 对齐、改名、`uiLayoutMovedFrom` 移自显示。
- **输入框新增前置槽位 `composer.leading`** —— 第三方插件终于可以把图标放到文件上传按钮左侧了（以前 `composer.actions` 只能排在上传右侧）。写法与其它槽位一致（`"ui": { "composer.leading": [...] }`，必须写完整名、没有简写别名），排序/隐藏/布局页偏好全套生效。
- **插件宿主能力扩展 + `plugin-sdk` 起手包** —— 新增 `host.llm`（模型调用）、`host.schedule`（定时任务）、`host.permissions`（权限声明）、`composerProviders`（输入框内容源）；`plugin-sdk/` 开箱即用的类型 + 运行时 + README，可直接抄起手。
- **插件诊断输出 + `create` 脚手架 + `host.log` 日志面板** —— manifest / UI 贡献被丢弃时给出原因（设置面板可展开查看，不再是静默消失）；`plugin create` 一键搭架子（minimal / ui-slot / agent-tool / renderer 四模板，`--with-test` 附带单测）；运行时日志分级落盘（内存环形缓冲 + 面板级别过滤/清空）；另附 `createMockHost` 本地单测 harness + `plugin upgrade-sdk`。

### Changed

- `slot-toolbar` 抽成独立模块，`TerminalPanel` 恢复 lazy / xterm 拆包（首屏包体积回落）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（46）：`hostResources`、`hostProcessor`、`hostMemory`、`hostResourcesTip`、`uiLayoutComposerLeading`、`uiLayoutModal`、`uiLayoutContextTopbar`、`uiLayoutContextMessage`、`uiLayoutContextSession`、`uiLayoutContextFile`、`uiLayoutLeftSessions`、`uiLayoutChatHeader`、`uiLayoutChatEmpty`、`uiLayoutFilePreview`、`uiLayoutTerminal`、`uiLayoutScm`、`uiLayoutGoalbar`、`uiLayoutNotice`、`uiLayoutSearch`、`uiLayoutMovedFrom`、`uiLayoutAlign`、`uiLayoutRename`、`pluginPermTitle`、`pluginPermBodyNet`、`pluginPermBodyLlm`、`pluginPermOnce`、`pluginPermAlways`、`pluginPermsTitle`、`pluginPermsHint`、`pluginPermsEmpty`、`pluginPermSession`、`pluginPermNet`、`pluginPermLlm`、`pluginPermUnscoped`、`pluginDiagTitle`、`pluginDiagShow`、`pluginDiagHide`、`pluginLogTitle`、`pluginLogShow`、`pluginLogHide`、`pluginLogLevel`、`pluginLogAll`、`pluginLogEmpty`、`pluginLogClear`、`pluginSecretSet`、`pluginSecretUnset`
- 服务端新增 key（1）：`plugins.settings.too.long`

<!-- auto-i18n:end -->

## [0.87.2] — 2026-09-16

### Fixed

- **关机/重启不再永久挂起**（#172）—— `disposeAll()` 卡在僵死会话/PTY/挂起句柄时进程以前永远退不出，第二次 Ctrl+C 还被吞掉。现在关机有 5 秒看门狗兜底（超时强制退出，未完成不等待）；关机中再收到信号立即按信号退出（130/143）而不是吞掉；先 `terminate` 全部 WS 半开连接 + `closeAllConnections` 再 `close`，死掉的浏览器页/发不完 body 的半开请求不再拖住退出。回归：`tests/shutdown-test.mjs`（win32 下跨进程 SIGINT 到不了 handler，直接 SKIP；ubuntu CI 正常跑），已进冒烟清单。
- **没动过的空 shell 不再钉住对话** —— 点开终端 tab 自动建的那个空 shell（一次都没敲过键盘/没跑过命令/agent 没碰过）以前算“还有存活终端”，切对话/✕ 关对话时被拦截或赖在运行列表里。现在 `TerminalManager` 新增 `countBlockingLive()`（只统计存活**且用过**的 PTY：`inputChecked` 成功输入与 `noteAgentActivity` 置位，`runCommand`/ai-bash 天生即用过），pi 与 DSH 两端的对话保留（`displaceActive`/`listed`）、关闭拦截、空闲回收、项目切换回收统一切到该口径；空 shell 切走/✕ 时随对话一起释放（`removeConversation` 里 `killAll`）。回归：`terminal-smoke-test` 新增 pristine/ai-bash 口径断言。

## [0.87.1] — 2026-09-16

### Added

- **重启服务不再杀死进行中的对话，回来自动续上**（#171）—— 以前升级/手工重启会把在跑的 run 静默杀死，用户得去历史对话里手动找回。现在关停与 `restart_service` 都会先把仍在 streaming 的会话记下来（含 session 文件）；重连后首次 attach 自动逐个重开并发送一句「继续」，从持久化上下文接着跑；恢复完视图回到原来停的那条，后台续跑的不抢焦点。没有 session 文件的才回落为黄色提醒。pi 引擎独有（DSH 暂无此记录）。

- **语音输入本地模型新增 `small` 档** —— 2.44 亿参数（约 500MB 下载），中文同音字明显少于 base；代价是 CPU 转写比 base 慢 3~4 倍。设置 → 界面插件 → 语音输入 → 本地模型，切换后点 🎤 按提示安装即可（之前下的 base/tiny 留着不碍事）。

### Fixed

- **`npm start` 带进来的环境变量不再污染子进程**（#169）—— `npm start` 会把 `npm_config_*` / `npm_package_*` / `npm_lifecycle_*` 导出给所有子进程，服务端拉起的 shell、`pi update` 等会继承到 `npm_config_allow_scripts`，npm 在项目级安装里直接拒绝（EALLOWSCRIPTS）。现在服务端启动时一次性 scrub，unit 文件不用动，所有 spawn 路径一次修好。
- **组件更新面板把“有更新的”排前面**（#170）—— 以前按 manifest 顺序列，可用的更新常被埋在一堆“已是最新”下面。现在服务端统一排序：pi-web-ui 与 pi-core 置顶（状态无关），然后有更新的、已最新的，最后是出错的；各客户端看到同一顺序。
- **语音输入“识别成功了还弹服务端录音”** —— 点「改用服务端录音」（或自动降级）时 `abort()` 激起的 `onend` 把已识别的半截文字又收尾一次：字进了输入框，录音浮层也弹了出来。现在切服务端途中立旗吞掉多余事件；自动降级时有字优先收尾（挂起的切换自动取消）、没字才进录音。
- **语音输入服务端转写永远为空** —— 录音分片收尾误用了声道平均的 `downmix`，把整段录音按时间“平均”成 128 个采样的糊发给 Whisper，只能回空。改成按时间轴拼接；模型本身没问题（之前 `ready:true` 是真的）。
- **dark-teal 主题的分体发送按钮阴影补上**（#168，社区）—— `.split-send` 漏进了发送/停止按钮的阴影规则，hover 光晕一并补齐。

## [0.87.0] — 2026-09-16

### Added

- **插件市场支持「从目录同步」**（issue #165）—— 设置面板插件市场头部新增同步入口：填一个目录文档 URL（http(s)）或本地绝对路径，一键同步可安装列表（走服务端现成的 `plugin_catalog_sync` 通道：同校验、同原子写盘；可选同步后安装全部条目 / 整体替换，逐条安装结果就地回显）。成功同步过的 URL 记在浏览器 localStorage（最近 8 个），一点即重同步。第三方仓库从此不需要再为同步专门发一个占位插件。
- **`install --catalog <url>` 与 `PI_WEB_PLUGIN_CATALOG_URL`**（issue #165）—— headless/预置场景：CLI 从目录文档同步列表并逐条安装/更新（已安装默认跳过，`--force` 更新，`--replace` 整体替换，单条失败不中断整批；`--build` / `--no-build` 对逐条同样生效）；服务端启动时若配了该环境变量则自动同步一次并安装，失败只告警不阻断启动。

- **插件特权 DOM 授权 + 宿主 API v7**（#159）—— 插件 bundle 与主应用同源，JS 层面拦不住它碰 `document`，真正的门禁只能放在 bundle 下发处：manifest `permissions` 含 `dom` 族的插件 bundle 默认 403，需用户在设置面板逐个授权（`<dataDir>/plugin-dom.json`，整机全局，授权后 epoch+1 让浏览器重拉）；只挂载锚点范围 DOM 的 `dom:anchor` 免用户授权。`apiVersion` 高于宿主则拒绝激活并提示升级 pi-web-ui。
- **输入框 `@` 提及文件/目录**（#159）—— `@` 后直接搜工作区文件，点选即追加附件 chip（inline/reference/lines）；`a@b` 这类邮箱不误触，中文无空格书写（`请看@文件`）也能触发。
- **右栏文件树右键操作** —— 文件/文件夹右键可新建文件/文件夹、重命名、复制/剪切/粘贴、创建副本、删除、上传文件，行尾按钮可复制名称/路径；文件夹右键「以项目打开」切换项目。右栏 `?` 帮助条同步写明全部手势。
- **内置服务商 OAuth 登录**（#159）—— 模型配置按服务商认证能力切换 OAuth 与 API Key 两套入口：设备验证码、交互提示、取消、重连恢复与登出，凭据隔离存放。
- **改 `mcp.json` 保存即生效**（#158）—— `fs.watch` 盯配置（防抖 300ms + 指纹比对，不支持时回落轮询）：规格等价的服务器沿用原实例（改一个不连带重启其它），新增/变更的先启动成功才换入，坏配置只提示一次、不断掉在跑的工具；工具表变更实时推给已有会话与新建会话。另修 `protocolVersion` 解析（握手与热加载指纹口径一致）。
- **右栏直达用户目录与桌面** —— 文件树面包屑新增 🏠（用户主目录）与 🖥️（桌面，Linux 读 XDG user-dirs，中文环境认 `~/桌面`）；旧服务不提供时按钮自动隐藏。

- **DSH 引擎复刻 dsh-web 四模式 Agent 预设** —— standard（全功能）/ PTC（`run_code` 组合面）/ minimal（单持久 shell）/ cordis（组合创作），与官方同名录同语义：新对话下拉选择、空白会话可切换、首轮发言后锁定、默认预设在设置面板配置、自建预设（`$DSH_HOME/.agent-presets`）照常上架。自定义系统提示词改走独立 host section（standard/ptc/cordis 下发，minimal 按官方语义压住）。已知限制：自建组合里写裸包名的无法挂载（launcher 式 boot 的 baseUrl 所限）；问卷/技能目录钩子改挂 agent scope（旧 host 写法在新版运行时已失效）。

- **未发送的输入框草稿跨刷新/切换自动恢复**（issue #166，单中心文件方案）—— 以前刷新页面、切会话再回来，输入框里没发出去的字全丢。现在打字时前端每 2s 防抖 + 失焦/切会话即时把草稿存到服务端 `<dataDir>/composer-drafts.json`（按 sessionId 键入，每会话只留最新一条；`localStorage` 同步镜像一层，兜住崩溃和关闭页面的最后一击），切会话/`newChat`/刷新重连时的全量快照把草稿带回来（本地没动过才恢复，绝不覆盖正在打的字）。发送成功、会话删除即清，30 天未更新兜底清扫。增量快照不带草稿（无 60ms 热帧开销），不进 LLM 上下文、不污染历史搜索，pi 引擎独有（DSH 暂无）。
- **语音输入插件支持一键安装本地 Whisper** —— 🎤 浮层里点一下，服务端自动装 transformers.js 运行时 + 下载模型（base 约 290MB / tiny 约 150MB，可在设置里切），以后录音不出本机、不要 key 也能转写；新 `engine` 设置（auto/local/remote，默认 auto 本地优先、挂了切远端）。服务端录音改走浏览器现场编码的 16k 单声道 WAV（AudioWorklet，ScriptProcessor 兜底），不再拼 MediaRecorder mime，服务端也无需装 ffmpeg。

### Fixed

- **插件 `ensureDeps` 遇到带版本号的依赖永远判缺失** —— `isDepAvailable` 把 `foo@1.2.3` 原样丢给 `require.resolve`（它不认 `@后缀`，恒 `MODULE_NOT_FOUND`），于是 pin 了版本的插件每次都重跑 `npm install`，装完还报“仍缺”。现在先剥掉版本再探测（只判存在，不审计版本；安装时 pin 照走）。
- **语音输入在 Edge 上“完全不能识别”且报错看不懂** —— 现在浮层按错误码给中文解释：非安全上下文（`http://局域网IP` 打开被浏览器掐语音+麦克风，指路 localhost）、`network`（Edge 语音服务要联网，代理/VPN 可能拦）、`not-allowed`（麦克风权限，指路地址栏 🔒）；听写中多了一个「改用服务端录音」按钮，一键绕过抽风的浏览器识别；浏览器静默断句续听加了 2 次上限，防无限空转。
- **DSH 引擎在新版 dsh 运行时下无法启动** —— wrapper 调的 `ctx.userQuestions.registerProvider` 已被上游删除，boot 直接 `TypeError` 崩溃。现在按官方 waterfall 语义把问卷 answerer 注册到每个 agent scope。
- **DSH 引擎底栏没有上下文占用 / 缓存命中 / 回复速率** —— 新版 dsh 运行时取消了持久的 `assistant/chunk`（逐 chunk 事件），
  改成 agent scope 的 `agent/assistant-stream` 直播帧，usage 只在结算时随 `assistant/message.usage` 落一次；jsonrpc 面两样都收不到，
  于是 streamingMessage / 速率 / 底栏统计全空。现在 wrapper 用 `{ global: true }` 订阅直播帧转成 `assistant.stream` 通知，服务端与老
  `assistant/chunk` 共用一条 chunk 管线（`conv.liveChunks` 互斥），usage 走 `assistant/message.usage` 回填；没有 usage 时上下文显示 `—`
  而不是 `0 / 1.0M`。回归：`tests/unit/dsh-usage.test.ts` + `tests/dsh-stats-test.mjs`（已进冒烟清单）。
- **DSH 部署人设（`override.patch.yml`）键名写错** —— `persona:` 不是 schema 字段（应为 `personaPrefix:`），被 zod 静默丢弃，自定义系统提示词一直没进过运行时。
- **同 sessionId 重建抛 `already exists`** —— 运行时重启/优雅关闭后，磁盘已有的会话 id 走 `agents.create` 必撞；现在自动转 `agents.resume`（官方恢复路径，附带缝合被中断的 turn），预设按日志记录优先恢复。
- **只有源码的插件不再装出“沉默的死插件”**（issue #165）—— `install` 在“有构建声明但无产物”时默认直接构建（以前只打印一行极易错过的提示，装完是个什么都不加载的空目录），构建前先打印解析出的 install/command；产物已提交的仓库行为不变。`--no-build` 保留旧的装空目录行为（明确打印跳过原因），与 `--build` 互斥。设置面板的「源码构建」勾选框语义相应变为“强制重编”（不勾选时源码插件也会自动构建）。
- **顶栏「⋯」溢出菜单在 DOM 里但永远点不到**（issue #162）—— 菜单元件挂在 `.view-switch{overflow:hidden}`（桌面端圆角药丸容器的裁剪）/ `.topbar-actions` 横滑容器（窄屏 ≤768px）里面，往下展开的部分全被祖先裁掉，`z-index` 再高也出不来；藏进溢出菜单的条目实际不可达。现在菜单经 portal 到 `document.body` + `position: fixed`（与右键菜单同路），按触发按钮实测锚定、视口钳制（下方放不下翻到上方），并补上点外面 / Esc 关闭（滚动/缩放时重跟锚点，不关闭）。另修一个连带坑：关闭回调若是内联箭头，effect 每 render 解绑/重绑全套 document 监听，离散按键可能正好落在空窗里导致 Esc 丢键 —— 关闭走 ref，监听只装一次。回归：`tests/ui-layout-ui-test.mjs` 新增「真的可见可点」断言（`elementFromPoint` 落在菜单内）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（61）：`atMentions`、`atMenuHint`、`fileOpenPreview`、`fileEnterDir`、`fileNewFile`、`fileNewDir`、`fileRename`、`fileNamePlaceholder`、`fileDuplicate`、`fileCut`、`fileCopyEntry`、`filePaste`、`fileDelete`、`fileDeleteConfirm`、`fileCopyRelPath`、`fileRefresh`、`providerAuthHint`、`oauthLogin`、`oauthLogout`、`oauthConnected`、`oauthDeviceCode`、`oauthOpenVerification`、`oauthContinue`、`pluginCatalogSync`、`pluginCatalogSyncHint`、`pluginCatalogSyncSource`、`pluginCatalogSyncSubmit`、`pluginCatalogSyncInstall`、`pluginCatalogSyncReplace`、`pluginCatalogSyncRecent`、`pluginCatalogSyncOk`、`pluginCatalogSyncInstalled`、`dshPreset`、`dshPresetNewChat`、`dshPresetLocked`、`dshPresetBlankOnly`、`dshPresetBroken`、`dshPresetUser`、`dshPresetDefaultTag`、`dshPresetCurrent`、`dshPresetMinimalNote`、`dshDefaultPreset`、`dshDefaultPresetDesc`、`dshPresetUserNote`、`dshPerm`、`dshPermReadOnly`、`dshPermReadOnlyDesc`、`dshPermWorkspaceWrite`、`dshPermWorkspaceWriteDesc`、`dshPermFullAccess`、`dshPermFullAccessDesc`、`dshPermFullAccessTag`、`dshPermCustom`、`dshPermConfirmFull`、`dshPermDefault`、`dshPermDefaultDesc`、`pluginDomNeed`、`pluginDomDesc`、`pluginDomGrant`、`pluginDomRevoke`、`pluginDomGranted`
- 前端中文变更（1）：`pluginBuildHint`
- 前端英文变更（1）：`pluginBuildHint`
- 服务端新增 key（2）：`plugininstaller.build.conflict`、`plugins.host.engines.mismatch`

<!-- auto-i18n:end -->

## [0.86.2] — 2026-09-15

### Fixed

- **升级重启后主题下拉可能只剩深色** —— 主题列表是页面打开时一次性拉取的（`useTheme` 只在挂载时 fetch，没有重试）：若那次请求撞上服务端重启窗口而扑空，列表就永远是空的 —— 聊天（WS 自动重连）与其他数据（快照自动恢复）都不受影响，所以看起来「只有主题丢了」。现在主题下拉与「⋯」溢出菜单打开时，若列表为空会自动补拉一次。遇到时刷新页面（Ctrl+R）同样可恢复。

## [0.86.1] — 2026-09-15

### Fixed

- **插件后台作业的取消/看门狗在 Linux/macOS 上杀不掉进程** —— `PluginInstaller` 起 CLI 子进程时没设 `detached`，POSIX 下子进程跟 server 同进程组，`killPidTree` 的 `kill(-pid)` 指向一个不存在的组而静默失败：取消点了没反应、超时作业也杀不掉，单作业锁还一直占着（直到 30 分钟看门狗……它自己也杀不掉）。Windows 走 `taskkill` 不受影响，所以本地一直是绿的、CI（ubuntu-latest）的 busy 单测连续 5 秒超时挂红。现在与 `plugin-project.ts` 同一写法：非 Windows 起独立进程组，整棵树一次带走。

## [0.86.0] — 2026-09-15

### Added

- **插件安装 / 更新 / 卸载改为后台作业，不再抢走设置面板**（issue #152）—— 以前点安装会在可见终端里跑 CLI，同时把设置弹窗
  关掉、主视图切到终端；连装几个插件就得「装一个、重开设置、再导航回市场」。现在作业跑在服务端（`server/plugin-installer.ts`
  ，执行的仍是同一个 CLI），输出按行回传，**设置面板原地显示进度**（进行中带最后一行输出，失败可就地展开输出尾部）；同一时刻
  只允许一个作业（两个 install 写同一目录必出半装状态），另有 15 分钟看门狗与「取消」。托管实例（`PI_WEB_MANAGED=1`）与
  CLI 缺失都会明确拒绝。
- **`host.reloadCatalog()`：受支持的插件市场目录同步**（issue #148）—— 第三方插件以前只能派发私有浏览器事件 + 开可见终
  端来同步自己的插件清单（私有事件随时会变、宿主更新没有回执）。现在有一条一等公民路径：`reloadCatalog(url 或本地路径,
{ install?, replace? })` —— 服务端拉取 → 用市场「添加到列表」同一套规则校验 → **原子写** `<dataDir>/plugin-catalog.json`
  （形状不对 / 解析失败 / 读不到时一个字节都不写，旧目录保持有效）→ 可选逐条安装（已装走更新，失败逐条记录不中断整批）→
  重载插件并把新列表推给所有客户端 → 结构化回执 `{ok, error?, entries?, installed?}`。
- **插件 UI 扩展点框架：11 个挂载点，插件只声明、宿主负责渲染**（issue #146 完整版）—— v1 那条 `topbar` 专用声明长成
  了一套通用 slot 框架。manifest 的 `ui` 字段（或运行时 `host.ui.*`）可以往 `topbar.primary` / `topbar.overflow` /
  `bottombar` / `composer.actions` / `message.actions` / `rightpanel.tabs` / `contextmenu.topbar|message|session|file` /
  `settings.pages` 这 11 个挂载点声明条目（`{id, label, labelEn?, icon?, kind?, order?, group?, hidden?, action?, view?,
when?, children?}`，也收 `topbar` / `settings` 这类简写别名）；宿主负责渲染、排序、**溢出菜单**、可访问性、用户偏好与
  审计，插件不碰 DOM，动作由插件客户端经 `host.onUiAction(name, fn)` 接管（按需加载它的 bundle，最终没人接管就提示一句，
  不让按钮看起来点了没用）。
  - **插件能整理宿主内置条目**：`ui.arrange` 可以把内置入口（id 形如 `host:settings`）移到别的槽位、隐藏、改顺序/分组/
    文案。内置条目表是 `web/src/ui-slots.ts` 的 `BUILTIN_UI_ITEMS`（32 条，逐条对应代码里真实存在的入口，不臆造）。
  - **用户偏好永远最后说话**：设置面板「界面插件 → 界面布局」按槽位列出所有条目，可逐条隐藏 / ↑↓ 调序 / 「恢复」单条
    或全部；被插件动过的条目标「插件调整过」并给恢复按钮。**顶栏、底栏、右键菜单看到的顺序与设置里一致** —— 两边跑
    同一个纯函数（`buildUiSlots`），这是本框架的核心不变量。隐藏的条目仍能在顶栏溢出菜单里点到，不是消失。
  - **宿主内置条目也真的听布局页**（本轮补齐）：底栏那一条、顶栏「桌面工具组」（搜索 / 浏览器操作 / 后台任务 / 设置 /
    声音 / 语言 / 主题 / 版本 / GitHub）、视图三连、右上（历史 / 文件 / 新对话）、消息 hover 工具条、右栏 tab 全部改成
    按 slot 结果渲染 —— 勾掉即消失、↑↓ 真的换位置（以前一部分写死在组件 JSX 里，勾选框是摆设）。被隐藏的**菜单型**
    条目（声音 / 语言 / 主题 / 版本 / GitHub / 浏览器操作）会把整个组件搬进「⋯」溢出菜单（点了照旧能用），
    扁平动作类（搜索 / 任务 / 设置 / 历史 / 文件 / 新对话）在菜单里是一条可点的菜单项；一条都不剩时消息工具条
    整条不画，不留空壳。
  - **插件条目的悬浮提示真的会显示**：`hint` / `hintEn`（可被 `arrange` 改写）会落成渲染层的 `title`
    （顶栏条目、底栏条目、右键菜单项、右栏 tab、设置面板插件页），只给一种语言时另一种回落它 ——
    以前这个字段只被解析、没有任何渲染层用它。
  - **通用右键菜单**：右栏文件树与左栏会话原先各弹一套本地 `.ctx-menu`，现在由 `App` 里唯一的 `ContextMenu.tsx`
    渲染（portal + fixed 定位 + 先渲染再实测尺寸钳制，不被滚动容器裁剪）；内置条目（上传到文件夹 / 以项目打开 / 添加为
    工作区根 / 关闭已结束子代理…）照旧。四个 `contextmenu.*` 槽位都已就绪，但**宿主今天只在文件树与会话两处有内置条目**
    （消息/顶栏两处还没有右键菜单，所以一条都不登记 —— 宁缺勿造），插件可以往这四个槽位加自己的操作。
- **插件自定义设置页**（issue #146）—— manifest `ui.settings`（或 `kind: "page"`）声明一页，设置面板左侧导航就多一项，
  内容由 `PluginPage.tsx` 挂载插件自己的 client bundle 渲染（`mount(container, ctx)`，**切走即调 cleanup** —— 设置页是
  「看完就走」的场景，不让插件的定时器一直留在 DOM 里）。插件页排在内置分区之后；`hidden: true` 的页默认不出现，用户
  可在「界面布局」里放出来。插件配置从此有个像样的落点，不必再抢一个顶栏视图 tab。
- **插件能在工作区外读写文件，但每一次都要用户点过头**（issue #146）—— 新增目录授权表 `server/plugin-grants.ts`（存
  `<dataDir>/plugin-grants.json`，与 UI 偏好分文件存，可审计、可手改、设置面板「已授权目录」可撤销）：
  `host.fs.requestAccess(dir, reason)` 弹确认框，同意后可勾「记住」。授权天然是**子树**授权（批准 `/proj` 就覆盖
  `/proj/src`；反向不成立 —— 只批了 `/proj/a` 时读 `/proj` 仍要再问）。`host.fs.authorizedDirs()` 列已授权目录，
  `listPath` / `readPath` / `readTextPath` / `writePath` / `removePath` 每次操作都要求路径已授权（本来就在工作区内的
  免打扰）。以前插件只能靠裸 `node:fs` 无告知地碰任意路径，现在多了一条「用户点过头才算数」的受支持路径。
- **`host.project.create()`：让宿主帮插件组装一个项目**（issue #146）—— 插件给一份规格（根目录 + 要 clone 的仓库 +
  要写的文件 + 可选 `git init`），宿主逐行回报进度：clone（不走 shell）、写文件、失败即停并回传**第一个**失败点与已走过
  的日志 —— 插件会把日志原样展示给用户，一个半成品项目配「成功」比直接报错更坏。所有校验在**动磁盘之前**做完；路径过
  三道越界防线（拒绝绝对路径与 `..`，目标最近一个已存在祖先的 realpath 仍须落在授权根内），junction / 符号链接也带不
  出去。根目录必须已授权或本来就在工作区内。
- **额外工作区根：一个项目可以挂多个目录**（issue #146 完整版）—— 以前右栏文件树只看当前工作目录，插件想读同机的兄弟
  目录得单独授权。现在右栏有「工作区根」选择器：右键文件树条目「添加为工作区根」即可在树里切换浏览（选择器里能切根、
  能移除根；加根有两个入口：文件树右键「添加为工作区根」、底栏工作目录选择器里的「＋ 添加为工作区根」），
  **按项目（cwd）持久化**、上限 8 个、切项目各带各的。语义边界写死：**AI 仍然只在主 cwd 里干活**（终端与
  「以项目打开」口径不变），变的只是「哪些算工作区内」—— 因此插件 `host.fs.*` 读这些根**不必再单独授权**（见上一条）。
  插件也可经 `host.openSession({ folders/roots })` 一次给出 cwd + 额外根。
- **插件会话 API `host.sessions` 与宿主 API v6**（issue #146 完整版）—— 插件现在能列出**可打开的会话**
  （`sessions.list()`：本客户端运行中的对话 + 当前项目的历史会话，带 title / cwd / kind / isStreaming）并打开其中一个
  （`sessions.open(id)`）；`host.openSession()` 也从「只支持单目录」升级为支持多根 —— `folders` / `roots` 的第一个当
  cwd，其余当额外工作区根，每个目录都要过授权确认（`startChat` 仍是那条无需等待的短形式）。宿主 API 版本 4 → **6**
  （4 加了 `reloadCatalog` / `openSession` / `onTopbarAction`，5 把顶栏动作推广成通用 `onUiAction`，6 加了 `sessions`
  与多根 `openSession`；`onTopbarAction` 保留为别名）。插件可用 `version` 判断宿主能力，老宿主上不会拿到 undefined 接口。
- **`pi-web-ui install --build`：源码安装时隔离构建**（issue #150）—— 插件仓库可以只提交 TypeScript 源码，不必再把
  `index.mjs` / `client/entry.mjs` 产物提交进仓库。构建在临时目录里完成：只装插件声明的构建依赖
  （`npm install --ignore-scripts`，不执行任意生命周期脚本）→ 跑 manifest.build.command（缺省回落 package.json 的
  `scripts.build`）→ 校验 `outputs` 产物齐全 → **成功后才替换目标目录**（失败时上一版插件原样可用、无半装状态）。设置面
  板的插件市场有「源码构建」勾选项，等价 `--build`，网络安装入口全部纳入托管实例（`PI_WEB_MANAGED`）拒绝面。
- **vscode-editor 插件：SSH 主机支持私钥路径 / 口令 / agent，还能从 `~/.ssh/config` 批量导入**（issue #149）—— 以前主机编辑只有密码与内联 PEM 私钥两项：带口令的私钥没地方填口令（连上就挂），用 `~/.ssh/id_rsa` 这类文件路径的得把私钥全文粘贴进来，ssh-agent 更没入口。现在编辑框多了三项：私钥路径（支持 `~` 展开，填写则优先用文件、不必粘贴全文）、私钥口令 passphrase（留空=保持不变，连接时透给 ssh2）、agent socket（如 `$SSH_AUTH_SOCK`，与密码/私钥互斥）；「从 ssh config 导入」按钮解析本机 `~/.ssh/config` 列出候选（已导入的标出跳过），勾选批量导入 —— 导入只存私钥路径引用，不读私钥内容。解析语义对齐 OpenSSH：同块先出现的值优先，`Host *` 块只充当默认值继承、不产出候选，含通配符的别名不产出。
- **检查更新走你自己的 npm 源，不再卡在官方源上**（issue #151）—— 配了镜像/私有源的用户（`<agentDir>/npm/.npmrc`，`pi update` 经 npm 本来就认这一份），以前顶栏更新检查还直连 `registry.npmjs.org`：镜像用户查不到新版、私有源用户直接 401。现在检查更新读同一份 `.npmrc` 解析 registry + 认证头（`_authToken` 优先、`_auth` 其次，同源才带），无文件/无配置时回落官方源。pi 与 DSH 双引擎同修。
- **桌面版里「浏览器操作」给明确结论，不再让人白装扩展**（issue #153）—— 桌面窗口（Electron）里没有 Chrome 扩展运行时，page-picker 扩展永远装不上；以前面板还是网页版那四步安装引导，用户跟着做完才发现此路不通，模型调 `browser_page` 还要干等 3 秒桥超时。现在桌面壳里面板直接给结论 + 「用默认浏览器打开当前地址」按钮（去网页版按四步装即可），`queryBrowserControl` 与服务端 `pageCall` 都短路返回「改用网页版」的错误，不碰扩展桥。
- **桌面版点对话里的链接不再把窗口带走**（issue #154）—— 以前对话正文里的外链是裸 `href`，桌面壳里一点就是同帧导航：整个应用窗口被带到外部页面（无地址栏、无后退键，只能重启）。现在两层修复：正文外链统一 `target="_blank"`（网页版行为也更符合预期：新标签页打开；站内锚点与相对路径不动），桌面壳另加 `will-navigate` 守卫 —— 应用自身 origin 放行，其余一律转系统浏览器（`setWindowOpenHandler` 只拦新窗口请求，拦不住同帧导航，所以两层都要）。

### Changed

- **插件 `apiVersion: 2` 起「不写 `permissions`」等于默认拒绝**（issue #146 完整版）—— 宿主设施版本升到
  `PLUGIN_API_VERSION = 2`。以前 `permissions` 缺省是「旧格式全权模式」：受控宿主 API 一律放行、只在日志里警告一次；
  现在只要 manifest 声明了 `apiVersion: 2`，没写 `permissions` 就按**空能力集**处理 —— `fs` / `http` / `tools` / `ui` /
  `chat` 这些受控入口逐个拒绝（`manifest.ui` 整份忽略），日志里写明缺哪个能力族。**对插件作者的含义**：升到 2 就得同时
  补上 `permissions`（哪怕只是加一个顶栏按钮，也要写 `"permissions": ["ui"]`）。不写 `apiVersion` 的老插件仍是 v1 +
  旧全权模式（只警告、行为不变），所以升级可以按插件逐个进行；`apiVersion` 比宿主新才会被拒绝激活，并提示升级 pi-web-ui。

### Fixed

- **「看不见的第二个 agent」不会再出现了**（issue #145）—— 换设备 / 新开标签页打开一条正在跑的对话，以前 UI 显示空闲可发，一发消息就给同一份会话再开一支 run，两支 agent 在同一工作区并行动手、事后只有一支可查。现在服务端跨客户端查重：同一份记录在别处正在跑时，`switch_session` / `prompt` 直接拒绝并告诉你去原窗口继续，第二个 writer 从机制上造不出来；owner 空闲后可正常打开（会提醒你别处也开着、只留一处发送）。**新标签页也不再默认落进正在跑的那条**：初始恢复与切项目首访恢复在建之前就查一遍，命中正在跑就停在空白新对话并告诉你原因。同项目不同对话仍可并行（适合改不同文件），但两边都会收到并行提醒，AI 还会收到一条冲突评估提醒（拿不准就用 `ask_user_question` 让你选：并行 / 等它跑完 / 只读围观）。左栏「运行的对话」里直接能看到其他标签页 / 设备的运行（带“另一处”标签，只读不可点）。pi 与 DSH 双引擎同修，回归测试 `tests/cross-client-session-test.mjs`（改前红改后绿，覆盖拒绝双写/默认落点/并行感知）。
- **刷新页面不再把已退出的 AI bash 终端复活成用户终端并反复弹「终端数量已达上限」**（issue #147）—— 开着「终端接管 bash」跑一批命令后，每个一次性 AI 终端都会在 history 里留一条记录；以前刷新/重连/切对话时前端会为其中每一条重发 `terminal_create`（还不带 `agentBash`），服务端于是把它们重建成普通用户终端：白白拉起几十个 shell 进程不说，攒到 16 个就触发上限报错、每条再各弹一次全局通知。现在三层修复：前端挂载时发现终端已退出（`running === false`）就只做展示（保留输出照旧由服务端 replay 推送），不再重建 PTY；`terminal_create` 消息新增 `agentBash` 字段并全链路透传；服务端 `create()` 在字段缺省（旧前端）时从 history 继承原有身份。已退出的**用户**终端在满额时重建仍被拒绝（history 不预留名额），`terminal_create` 工具建的常驻终端也照旧计入用户名额。回归测试 `tests/terminal-smoke-test.mjs`（WS 透传 + 继承/拒绝口径）。
- **输入框里的一行 JSX 注释不再渲染成可见文本** —— `ChatInput.tsx` 里 `/* … */` 写在了 JSX 子节点位置，会被当成文本渲染出来；已改为 `{/* … */}`。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（44）：`elsewhereBadge`、`elsewhereTip`、`workspaceRoots`、`workspaceRootsHint`、`addWorkspaceRoot`、`addWorkspaceRootHint`、`removeWorkspaceRoot`、`browserControlDesktop`、`browserControlDesktopLead`、`browserControlOpenInBrowser`、`devNoCache`、`devNoCacheDesc`、`autoReload`、`autoReloadDesc`、`pluginJobRunning`、`pluginJobDone`、`pluginJobFailed`、`pluginBuildSource`、`pluginBuildHint`、`uiLayoutTitle`、`uiLayoutHint`、`pluginTopbarMore`、`uiLayoutTopbar`、`uiLayoutTopbarOverflow`、`uiLayoutBottombar`、`uiLayoutComposer`、`uiLayoutMessage`、`uiLayoutRightPanel`、`uiLayoutSettingsPages`、`uiLayoutRestore`、`uiLayoutRestoreAll`、`uiLayoutArranged`、`uiLayoutEmpty`、`pluginGrantsTitle`、`pluginGrantsHint`、`pluginGrantsEmpty`、`pluginGrantsRevoke`、`pluginGrantRequestTitle`、`pluginGrantRequestBody`、`pluginGrantAllow`、`pluginGrantDeny`、`pluginUiNoHandler`、`pluginSessionGrantTitle`、`pluginSessionGrantBody`
- 前端中文变更（3）：`pluginUpdateHint`、`pluginInstallHint`、`pluginUninstallHint`
- 前端英文变更（3）：`pluginUpdateHint`、`pluginInstallHint`、`pluginUninstallHint`
- 服务端新增 key（15）：`plugincatalog.sync.fetch.failed`、`plugincatalog.sync.http`、`plugincatalog.sync.too.large`、`plugincatalog.sync.source.invalid`、`plugincatalog.sync.read.failed`、`plugincatalog.sync.source.missing`、`plugincatalog.sync.parse.failed`、`plugincatalog.sync.shape`、`plugininstaller.id.invalid`、`plugininstaller.source.invalid`、`plugininstaller.managed`、`plugininstaller.busy`、`plugininstaller.cli.missing`、`plugininstaller.cancelled`、`plugininstaller.timeout`

<!-- auto-i18n:end -->

## [0.85.0] — 2026-09-14

### Added

- **微信里也能指挥 agent 了**：新插件 `wechat-ilink`（💬 微信通道）——微信扫码登录，直连微信 ilink 后端（与腾讯官方 `openclaw-weixin` 同源协议），出站长轮询收消息，家里内网、公司内网都能跑，不用开端口、不用公网 IP。白名单用户（或填 `*` 全放行）的消息自动投给 agent，跑完回结果；陌生人先挂「待配对」，在视图里点允许/拒绝。附带 `wechat_send` 工具，agent 可主动发微信消息。
  - 通道能力由宿主新扩展点 `host.chat` 承载（`server/plugins.ts` + `AgentService.chatFromPlugin`）：无头调用、无浏览器也能跑，每个（插件，账号）独立伪客户端，fire-and-forget 投递、运行结果经 `onRunEvent(run_end)` 按 conversationId 关联回包；需要 manifest `chat` 能力声明，文本 8000 字封顶。
  - v1 诚实范围：单账号、文本全双工，图片/语音/文件只转写占位；默认只回私聊；与该服务 cwd 下最近会话共享（peer 名拼进前缀，per-peer 独立会话以后再加）。`bot_token` 存宿主加密机密。
- **「浏览器操作」面板有了扩展安装引导** —— 扩展不在 Chrome 应用商店，以前用户卡在第一步。现在面板里直接给下载按钮（`page-picker-extension.zip`，永远最新版，走 GitHub Release latest 别名）+ 四步图文（解压 → 开发者模式 → 加载已解压 → 点图标设为服务地址，地址端口不用手填）。
- **image-toolkit 的配置搬进插件自己家里了** —— 以前 7 项设置走 ⚙ 面板 → 界面插件的声明式 `settings`（manifest 已删）；现在存在插件自己的 storage（`config` 键），在 🖼 视图右上角 ⚙ 里改，并新增内部配置存取路由（视图 ↔ 服务端经 `settings` 广播同步，改完即时生效，按需上/下架 AI 工具）。老版本声明式设置一次性自动迁移（读不到就全默认，坏值归一化回默认值，绝不带崩工具/视图）。
- **`legado_book_sources` 多了 `unmark`** —— AI 修完源、验证通过后调它摘掉废源/可疑标记，否则页面默认隐藏废源、用户会以为源丢了（`rules.md` 修源流程已同步到 6 步：先 `probe` 验证、再 `unmark`、最后提醒刷新）。
- **Legado 阅读页不再拿旧规则误判废源** —— AI 刚修完规则时，页面内存里还是旧的，之前失败一次就记废源。现在失败前先比对磁盘新规则的「可读性指纹」（搜索/发现/头/四条解析规则变了才算新），命中则按新规则重读并提示重试，这次失败不记废源。另：发现页书源下拉的筛选词重渲染不再丢失。

### Changed

- **`browser_page` 工具默认关了**（原来默认开）—— AI 动用户浏览器，应该是 opt-in 才开；关掉后顶栏「浏览器操作」入口整个隐藏（面板里的例子与「引用到对话」都是教模型用 `browser_page` 的，工具不在留着只会给出做不到的承诺）。扩展侧总开关关了则保留面板，好把人送去开开关。

### Fixed

- **机密存储重启后全炸的 bug 修了** —— `secrets.key` 的读法把文件缓冲直接 `.toString("hex")`（hex 文本又做了一次 hex 编码），重启后 key 变成 65 字节，AES-256-GCM 全线报 "Invalid key length"。现在按 UTF-8 读 hex 文本再解码，并校验 32 字节：长度不对视为损坏、重新生成（旧机密按 fail closed 丢弃，总比所有机密操作全炸好；单测 `plugin-facilities.test.ts` 回归）。
- **Windows 上新终端偶发吃掉首字节** —— 刚 spawn 的 PTY 在 shell 还没开始读时就写入，ConPTY 会丢最前面的字节，经典症状是 `pi-web-ui` 到达时变成 `i-web-ui`。现在复用输出就绪信号（首包输出即 shell 可读，1.5s 超时兜底；重启/kill 掉的过期条目跳过），命令只在就绪后写入。
- **目标（goal）展开时内容不再被挤扁**（issue #141）—— `.goalbar` 纵向容器原来是 `align-items: center`，展开态的两行被压成内容宽度，输入框缩成一小截。现在容器改 `align-items: stretch` 让展开的行铺满整列，只有折叠态（小药丸）保留居中。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（7）：`browserControlInstall`、`browserControlInstallLead`、`browserControlInstallDownload`、`browserControlInstallStep1`、`browserControlInstallStep2`、`browserControlInstallStep3`、`browserControlInstallStep4`

<!-- auto-i18n:end -->

## [0.84.0] — 2026-09-13

### Added

- **Git 视图的左栏可以拖宽了**（issue #139）—— 改动文件 / 提交历史那一栏原来固定 300px，路径或分支名一长就被截断且无处可展。现在拖它右边的分隔条即可调宽（**双击复位**），宽度**跨会话记住**（`localStorage`）；拖动时按容器宽度收敛，保证 diff 区不会被挤没（额外还有一条 `max-width` 兜底）。
  - 与左右主面板同一套手感（拖动分隔条、双击复位、松开才写存档）；纯函数 `web/src/scm-sidebar.ts` + 单测 `tests/unit/scm-sidebar.test.ts`，真浏览器回归 `tests/scm-test.mjs`（拖 +120px → 刷新后保持 → 双击回 300px）。

### Fixed

- **正在聊的那条对话不再从左栏「运行的对话」里消失**（issue #140）—— 原来新对话只有「被换到后台且仍在流式输出」时才入列，于是你在当前对话里发消息时，左栏里根本没有它；只开一条对话时连「运行的对话」这个标题都不渲染，观感像是对话丢了。现在**当前对话一旦有内容**（有消息、或已被首条提示词命名）就立刻出现在列表里（还在流式输出时也会亮起绿点），行上标「当前」、点击是安全的空动作。
  - **空白新对话仍然不入列**（连点「新建对话」不会堆出一排空条目），历史对话列表也不受影响。
  - 这是**纯展示口径**：`listed` 的语义，以及「被挤出后台时是保留还是释放 runtime」「每项目 8 个上限」这些规则完全没变（换走时该释放的仍然释放）；列表里当前对话那一行的 ✕ 按同一口径判定，真能移出（不再静默无反应）。
  - 回归：`tests/unit/…` 无（口径在服务端），零 token 协议测试 `tests/running-list-test.mjs`（空白不入列 / 流式中入列 / 跑完留住 / 当前行 ✕ 可移出 / 后台运行语义不变），真浏览器 `tests/panel-layout-test.mjs`（区标题、「当前」副标签、流式绿点、只有一行）。DSH 引擎同口径一并改了（共用同一套左栏与 wire 协议）。

- **切项目时左栏不再闪一下项目名**（#140 那个改动的回归）—— 切项目会自动切到该项目的对话；如果切过去时那个项目只有一条对话（就是这条当前对话），列表里只有一组，它顶上原来会闪出一行项目名再消失（实测约 8ms 一帧）。原因是两个信号不同时到达：`conversations` 推送先到（activeId 已是新项目的对话），带新 `cwd` 的快照后到，只按 `cwd` 分组的那一帧就把当前项目当成了「别的项目」。
  - 现在**只要当前对话在列表里，就认它所在的分组为当前项目**（`currentCwd` 只在它不在列表里时——空白新对话——作为回落），并直接置顶，顺带免掉随后的位置跳动；其他项目的后台运行照旧显示项目名。
  - 分组逻辑抽成纯函数 `web/src/conv-groups.ts` + 单测 `tests/unit/conv-groups.test.ts`，另有真浏览器逐帧回归 `tests/conv-group-flash-test.mjs`（MutationObserver 记录每一帧 DOM，两个方向都断言不再渲染项目名；改回只看 `cwd` 即变红）。

<!-- auto-i18n:start -->

### i18n

- 服务端新增 key（1）：`terminals.cwd.outside.workspace`

<!-- auto-i18n:end -->

## [0.83.0] — 2026-09-13

### Added

- **子代理模板可以固定思考强度了**（issue #130）——模板原来只能固定模型、提示词与白名单：`explore` 想跑快点、`review` / `oracle` 想往深处想，只能跟主对话共用一个档位；更隐蔽的是子代理原本一律吃 SDK 默认档（medium），主对话调到 `xhigh` 也传不过去。现在模板编辑器里多了一个**思考强度**下拉（off / minimal / low / medium / high / xhigh / max，与顶栏那个下拉共用同一份档位与文案）：
  - **留空 = 跟随主对话当前强度**（与「模型留空 = 跟随主对话当前模型」同语义）；指定了就用该档位 —— 于是「角色 + 模型 + 强度」能配成一套固定组合。
  - **模型不支持的档位自动收敛**（SDK 行为：非推理模型只能 `off`，`xhigh` / `max` 需要模型声明 `thinkingLevelMap`），收敛不报错、不影响派发。唯一行为变化：子代理默认强度从「SDK 默认档」变成「跟随主对话」。
  - AI 侧的 `subagent_templates` 清单里每个模板都报出模型与思考强度（没配的写「跟随主对话…」），派单时不用猜。
  - 脏数据宽容：老 `subagent-templates.json` 没这个字段 → 空（跟随主对话）；值写错（如 `ultra`）当未配置处理，不报错也不猜。
  - 回归：单测（字段归一 / 只认七档 / 内置模板不预设强度 / 工具输出报出强度）、协议冒烟 `subagent-template-test.mjs`（wire 透传 + 非法值归一 + 落盘）、新增零 token 端到端 `subagent-thinking-test.mjs`（mock provider + reasoning 模型：模板 `high` → high、留空 → 跟随主对话的 `low`、模板 `max` → 收敛成 high；改动前这三条全是 medium）。

- **「浏览器操作」面板支持把已授权页面一键引用到对话** —— 之前要让模型操作某个页面，得在话里手打网址。现在：只授权了**一个**页面时，顶栏按钮直接变成那个页面的标题（点主体就把引用放进输入框，右侧 ▾ 仍是状态面板）；多个页面时，面板里每项都有「引用到对话」，可连续引用多个。
  - 引用进输入框的是 `🌐 页面标题` 的附件 chip（与「引用文件」同一套：可删、可多条、可和文件附件混搭），**不自动发送** —— 你补一句「把前十条读出来」再发；编辑重问时照旧恢复。
  - 发送时服务端把附件渲染成给模型的一句话（`<browser-page url title>`）：**这个页面已授权、用 `browser_page`、`target=` 该 origin** —— 模型不必从自然语言里猜网址，也不会跑去抓网页。
  - 回归：`browser-control.test.ts`（单页紧凑态判定 / 引用附件形状）、`attachments.test.ts`（不读文件 + target 提示 + 属性转义）、`question-attachments.test.ts`（重问恢复），以及 `browser-cite-test.mjs` E2E（单页按钮、点击引用、去重、chip 删除、多页面板引用）。

- **`browser_page` 支持截图（`op:"shot"`）：模型终于“看得见”页面** —— 之前它只能靠 `read` 读 DOM 文本，「这页看起来对不对」这类问题答不了。截图支持整屏或指定元素（按 rect 裁剪，元素几乎不在视口里时不截，而不是给一张碎图），长边默认 1280 / 上限 1568（JPEG）。
  - **主模型能识图就直接给图**（当轮可见）；**纯文本模型自动走视觉桥转写**（与用户粘贴图片同一套逻辑与提示词，设置里开着就生效，无需额外配置）。注意：`deliverAs:"nextTurn"` 的附件通道要等下一次用户发言才注入，所以截图**不能**走那条路——必须在工具结果里给图或转写文本。
  - **两个必须知道的代价**（选项页与 README 都写明）：① 浏览器的 `captureVisibleTab` 只认 `<all_urls>` 或「点图标那一刻的 activeTab」，普通 host 授权不够 —— 所以打开「允许截图」会弹一次「读取您在所有网站上的数据」，不给就保持关闭（模型仍能用 `read`）；② 截图只能截当前活动标签页，扩展会先把目标页切到前台、**截完立刻切回**（失败也切回）。
  - 开关：「允许截图」默认开（但要先授一次权限），关掉后 `shot` 直接被拒并说明去哪开。
  - 回归：`page-picker-bridge.test.ts` 的 shot 用例（切页顺序、失败也切回、按 rect 裁剪、没权限时明确拒绝、开关关闭）、`browser-page-tool.test.ts` 的结果组装（给 image block 且 data 是纯 base64 / 走视觉桥带 `<vision-bridge>` / 桥不可用时说明原因 / 老替身不炸）、`page-picker-ai-ops.test.ts` 的 `metrics`，以及真扩展 E2E（截图开关与权限门控的文案）。真扩展 E2E 还抓到一个真 bug：`captureVisibleTab` 的 `quality` 必须是 **0-100 的整数**，传 0.72 会报 `expected integer`。

- **「AI 操作浏览器页面」在 pi-web-ui 侧终于有入口了**（顶栏「浏览器操作」按钮 + 状态面板）。上一版把能力做完了（`browser_page` 工具 + 扩展授权表），但之前**用户那边一片空白**：不知道有这个能力、不知道去哪开通、不知道能说什么。现在：
  - 顶栏按钮显示状态（授权了几个页面），需要你动手时（未授权 / 总开关关）变成醒目色；
  - 面板里报「扩展在不在 / 已授权的页面（标题 + 地址 + 开没开）/ 两个总开关」、给出授权三步、两句可照拄的例子；
  - **「打开扩展设置页」按钮**：网页不能自己导航到 `chrome-extension://`（浏览器会拦），所以这一步由扩展代劳（新动作 `openOptions`）；状态查询走新动作 `status`。
- **AI 在页面上动手时，那个页面会闪一条提示**：「AI 正在操作本页 · click #submit」（右下角、挂 shadow DOM、只报信不拦截、2.2s 淡出、不堆叠、卸桥时一并清掉）—— 否则用户会以为页面自己在动。
- 回归：`tests/unit/browser-control.test.ts`（状态查询与开设置页的四种失败/成功路径）、`page-picker-ai-ops.test.ts` 的提示条用例、`tests/page-picker-edge-ext-test.mjs` 里真扩展下的 `status` / `openOptions`（真的开出一个设置页）。

- **模型多了一个 `browser_page` 工具：直接操作你在浏览器里授权的页面**（需要 pi-web-ui 0.83.0+ 与 page-picker 扩展 0.4.0+）。以前人只能把页面“描述”给 AI（拾取元素→粘上下文），现在模型可以在对话里直接读那个页面、点它的按钮、填表单、滚动、跳转，必要时在它里跑一段脚本。
  - **链路**：模型调工具 → 服务端把请求推给浏览器里那个 pi-web-ui 页面（新协议消息 `page_request`）→ 页面经宿主桥 `window.__piWebUiHost.pageCall()` 转给扩展 → 扩展在授权页面上执行 → 结果原路回到模型（`page_response`）。所以**那个 pi-web-ui 标签页得开着**（与拾取投递同一个取舍）。
  - **只需授权被操作的那个页面**：另一端固定是 pi-web-ui 页面，不用像页面桥那样配两端。授权在扩展选项页点一次（顺带申请 host 权限），可随时收回。
  - **八个动作**：`pages` / `read`（文本/HTML/title/url/元素查询）/ `click` / `type`（走原生 setter + 补发 input/change，React 受控组件也认；`submit` 发回车）/ `scroll` / `goto`（先回结果再跳）/ `wait`（等元素或文案）/ `eval`。
  - **三层开关**：pi-web-ui 设置→工具里的 `browser_page`、扩展选项页的「允许 AI 操作页面」总开关、以及单独一项 **`eval`（默认关）** —— eval 等于把页面交给模型写的脚本，要用得手动打开。
  - **安全边界**：授权列表是唯一凭据（未授权页面一个字节都不注入）；只有“浏览器里那个已绑服务地址的 pi-web-ui 页面”能发起（用 `sender.tab.url` 判定）；动作名过白名单（其它一律拒）。
  - **失败都说人话**：没授权去选项页授权 / 页面没打开 / 多个页面要指定 target / 选择器没匹上 / wait 超时返回 `found:null` / 页面 CSP 禁了 eval 时提示换动作 / 浏览器里没开 pi-web-ui 页面时提前退出。
  - 已知边界（写进 README 与选项页）：eval 受目标页面 CSP 约束；桥只在顶层帧，跨源 iframe 拿不到；`chrome://`/扩展页/商店页/`file://` 不能授权；页面里的第三方脚本也能看到注入的 `window.__piBridge`（与页面桥同一个边界）。
  - 回归：`tests/unit/browser-page-tool.test.ts`（工具 schema、args 组装、超时归一、`pageCall` 超时/迟到响应/无前端/中止）、`tests/unit/page-picker-ai-ops.test.ts`（八个动作的真 jsdom 行为）、`page-picker-bridge.test.ts` 的 AI 路由（宿主/授权页/配对页三角色、总开关与 eval 开关、白名单、`pages` 由 worker 直答）、`tests/unit/plugin-host-page-call.test.ts`（宿主桥 pageCall 的三条纪律）、`tests/page-picker-bridge-test.mjs` 与 `tests/page-picker-edge-ext-test.mjs`（**真浏览器**：宿主读授权页标题、真点击、eval 开关、宿主页面不走配对表）。

- **page-picker 扩展：页面桥 —— 两个配对过的页面可以互相读写**（跨源、跨标签页、跨窗口）。拾取是单向的（网页 → pi-web-ui 输入框），这块把另一个方向也打开：对端页面 `window.__piBridge.on("orders", () => …)` 注册能力，这边 `await window.__piBridge.call({ op: "orders" })` 拿到数据，或者调 `highlight` 去操作对端的 DOM。浏览器里只有扩展能做到这件事（跨源 `postMessage` 要 `window.open` 的句柄且对方配合，`BroadcastChannel` / `localStorage` 只限同源）。
  - **默认关闭，只认配对**：选项页「页面桥」里填两个 origin → 点「授权并添加配对」（权限申请必须在扩展自己的页面上点，网页上的按钮给不了浏览器要的手势）。没配对的页面一个字节都不注入。
  - **地址不用手打**：在要配对的两个页面里各点一次扩展图标，它们就进了候选下拉（点过图标那一刻有 `activeTab`，url 与标题都可读；不为此多要 host/`tabs` 权限）；开发页的拾取浮条上还有「与另一页配对…」按钮，点一下把本页预填好并直接打开设置页的配对面板。
  - **准入只看 `sender.tab.url`**：消息体里自称是对端也不作数 —— 否则 A 页面可以冒充 B，把 B 的数据全拿走。停用的配对同样拒绝，且与「没配对」分开报原因（一个是去启用、一个是去添加）。
  - **失败都说人话**：对端没打开、对端没注册那个 op（报错里列出它注册了什么）、结果过大（参数 ≤ 256KB / 结果 ≤ 512KB）、返回值不可克隆（循环引用）、对端 handler 抛错、超时（默认 5s，页面侧自己兜底，Promise 不会悬着）。对端刚导航完（桥还没装上）会自动补装一次再重试。
  - **注入时机**：SW 启动、配对表变更、页面导航完成时协调；删配对/停用会把页面上的桥卸下。
  - 已知边界（写在选项页与 README 里，不藏）：桥在页面**主世界**，所以被配对页面里的任何脚本（含第三方广告/统计）都摸得到 `window.__piBridge` —— 只对你信任的页面开桥；`chrome://`、扩展页、商店页、`file://` 不能配对；桥装在顶层帧。
  - 回归：`tests/unit/page-picker-bridge.test.ts`（准入/路由/体积/页面侧函数的自包含性/配对候选）、`page-picker-options.test.ts` 的配对管理单测（加/删/停用真的落盘并通知 worker、候选下拉与 `?pair=` 深链预填）、`tests/page-picker-bridge-test.mjs` 浏览器 E2E（**两个真实 origin + 真实 `dist/bridge.js` + 真实 background 逻辑**：A 读 B 的数据、B 改 A 的 DOM、没配对的页面调不动任何人、删配对后桥真的被卸下），以及 `tests/page-picker-edge-ext-test.mjs` 的**真扩展**场景（真 `executeScript` 注入 MAIN world + 真 `storage.local` 喂候选下拉）。

- **page-picker 扩展：六个预设与「发送什么」的逐项勾选，在拾取页面上就能改** —— 原来只有扩展选项页能改（为了改一个勾选得去开 `chrome://extensions`），而「这次只要源码位置」「这次只排查样式」这种判断，恰恰是站在页面上看着元素时才有的。现在点完元素后，**底部确认条里就有一排预设 chip**（精简 / 标准 / 完整 / 改对地方 / 样式 / 文案），右边「调整项 ▾」可展开 8 项逐项勾选（与选项页等价，默认收起）；拾取阶段的信息条上常显当前预设，`Alt+1~6` 是同一个入口（键盘也能把整套流程走完）。
  - 改完**立刻按新档位重新采集已经选好的元素**：快照是点击那一刻取的，不重采就会出现「浮条上写着精简、发出去的还是完整档」；元素已被页面换掉（SPA 重渲染）时保留原快照，不影响投递。
  - 选择会**写回扩展设置**（选项页同步可见、下次拾取沿用；只写 `detail` + `sections` 两个键，不碰服务地址与口令）。后台没响应时在**摘要行尾**说明「没同步到扩展设置（这次的选择只在本页生效）」—— 不用 toast，因为确认条正开着，盖住它反而看不清。
  - **不允许勾到一项不剩**（空列表在契约里会回落标准组合，那会让人以为「我全取消了它还发」）：取消最后一项直接拒绝并提示。
  - 回归：预设短名 / `applySectionToggle` / 热键解析单测，浮条控件单测（jsdom 真点击：点 chip 回调、逐项勾选、拒绝清空、折叠面板、告警文案），service worker 写回单测（脏数据回落 / 只写两个键 / 写失败报错），E2E 页面上切预设后落盘 + 已选元素重采 + 发出去的 Markdown 真的变瘦。

- **图片工具插件适配手机端**：三栏硬布局（队列 236px + 舞台 + 参数栏 320px，一条 media query 都没有）在手机上必定挤爆 —— 现在视口 ≤ 640px 时改成上下堆叠：队列变成顶部横向缩略图带（只留缩略图与删除，名字/尺寸在手机宽度里全是省略号），参数栏变成底部抽屉（默认半开；顶上那条手柄一点就收起，只剩 tab 行 + 动作行，舞台立刻高一倍以上；抽屉收着时点任意 tab 会自动展开），舞台独占剩余高度，各区块自己滚，不会把宿主的 `.plugin-view` 顶出外层滚动条。
  - 窄屏下按钮不再折行（中文按钮被压窄会变成竖排的「适应」），状态条改横向滚、不再换行把舞台越顶越小；弹窗 / 工作区列表贴边，行高按能点中做。
  - 触屏（`pointer: coarse`）裁剪把手 11px → 20px、滑杆与勾选框同步加高；裁剪拖动本来就吃 `touch-action: none`，不会和页面滚动打架。
  - 宽屏三栏布局与尺寸未动（回归里仍断言桌面三栏宽度与总高度）。
  - 回归：`image-toolkit-view-test.mjs` 新增手机端一段（真 Chrome 390×780 + `isMobile`/`hasTouch`：堆叠方向、横向缩略图带、自下而上顺序、无横向溢出、抽屉收起与点 tab 展开、收起后舞台变高、触屏把手尺寸），并给测试页补上与宿主一致的 `<meta name="viewport">`（缺了它 `isMobile` 模拟下布局宽度是 980，断点根本不命中）。

### Fixed

- **右栏扩展区不再是一块「浅色主题下的深灰块」**：那块 widget 容器写死了 `background: rgba(0, 0, 0, 0.15)` —— 深色主题下正好，浅色 / 暖纸 / 雾蓝 / 樱粉主题下就是一块压在浅底上的深灰。现改成主题 token `--sunken-bg`（深色 = 15% 黑；浅色系按各自色调给 4%~5% 低透），`make-light-theme.mjs` 的 LIGHT_DERIVED / PAPER / MIST / SAKURA 各补一条、7 个内置主题由生成器同步重出。
  - 语义写进 token 注释：**布局里禁止写死 `rgba(0,0,0,…)`**，凹陷内容面（比所在底板低一层的区域）一律引用 `--sunken-bg` —— 与上一版那批幽灵 token 同一条纪律。

- **goalbar / 问卷面板的背景不再比聊天区差一档**（PR #131 的观感跟进）——上一版把 goalbar 的幽灵 token 修好之后，它（和问卷面板）成了一块带底色的卡片；而它们所在的那一段（消息区与输入区之间）**只有卡片自己有底色**，卡片四周与列外区域的间隙露的是裸页面背景 —— 浅色与壁纸主题下就是**一条比聊天区更暗、一直横到面板两侧的带子**（深色主题差得少一点，同样能看出来）。
  - 玻璃底上移到容器：`.main` 整块聊天面板统一涂 `--msgs-bg`（消息区 + goalbar / 问卷面板那一段 + 输入区），`.messages-wrap` 与 `.inputbar` 不再各涂一层 —— 叠加两层反而比 goalbar 区亮一档，会换一条新的横向色阶。
  - goalbar 与问卷面板**不再自带底色**（即 0.82.0 的观感）：背景 = 聊天背景，活动态靠琥珀边框、问卷靠强调色边框 + 投影区分；折叠态的小 pill 仍是控件底（`--chip-bg`），选项预览块（`.question-preview`）与问卷底部 sticky 条保持原样。

- **修掉一批「幽灵 CSS 变量」：goalbar、问卷面板、插件按钮在浅色主题下不再是深色块**（PR #131）—— 引用一个**全史从未定义**的自定义属性，按 CSS 规范是 guaranteed-invalid：**整条声明在计算值阶段失效**。`--bg-elev1`（正确名是 `--bg-elev`）从引入它的那笔提交起就是笔误，后果是：goalbar 全家**没有填充**（看着像故意画个框）、输入框丢掉整条 `box-shadow`（连聚焦光环一起没）、插件里带 fallback 的写法则静默用硬编码 `#16161d` → 白色 / 雾蓝 / 暖纸 / 樱粉主题下是深色块。同批还修了 `--glow-inset`（全史未定义）与 `--text-2`（全史未定义，`color` 回落 inherit → 比预期亮）。
  - 按语义改回已定义变量（与 13be9ab 那批改名同方向）：菜单内说明块 / 按钮 / 徽章 → `--bg-elev`；消息头悬停 → `--bg-elev2`（用 elev 的话白色主题下等于卡片色，悬停看不见）；`--glow-inset` → `--glow-05`（`--glow-*` 家族最小的高光，各主题已有对应浅色值）；`--text-2` → `--text-dim`；webmail / demo-mailbox 的 `--bg-elev1` / `--bg-elev0` → `--bg-elev` / `--bg`（保留原 fallback）。
  - **goalbar 与问卷面板改走壁纸体系**：`.goalbar` → `--card-bg`、`.goalbar-hint` → `--chip-bg`、`.goalbar-active` 的 8% 琥珀叠色同步换底；`.dialog-inline`（扩展弹窗 / 提问对话框）与 `.question-preview` → `--card-bg` —— 它们本来就是列内卡片（与消息列同宽），原来写死 `--bg-elev2` 在壁纸 / 半透明主题下与四周玻璃面板有明显色阶差。问卷的 sticky 底栏保持实色（它的职责是遮住从下面滚过的正文，半透会让正文透出来）。
  - 顺手删掉 `.goalbar-hint` 里那句被同规则后句覆盖的 `background: transparent`（正是它让「没有填充」看起来像有意为之）。
  - 新增静态体检 `tests/unit/css-tokens.test.ts`：扫 `web/src` + `plugins` + `themes` + `web/index.html` 里每个 `var()` 引用，要求全仓某处有 `--x:` 声明（带 fallback 的也查）；豁免运行时注入（`--fp-zoom` / `--left-w` / `--right-w` / `--rail-gap` / `--msgs-gutter`）、刻意的中性兜底（`--bg-input` / `--border-subtle` / `--muted` / `--warning`）与 vendored 的 `--vscode-*`。改前跑它报 14 + 5 处（styles.css 14 处无 fallback，插件 5 处带 fallback），改后归零 —— prettier / oxlint / 浏览器 E2E 都拦不住这种静默退化，所以让它进 CI。

- **MCP 桥的子进程崩溃后不再永久失效（自动重启，不用重启服务）**（PR #129）——外部 MCP 服务器被 OOM 杀掉、被外部 kill、或自己崩了之后，桥原来只把在途请求报错、把子进程句柄置空，**之后所有工具调用都写进空气**：挂满 60 秒报一句 `tools/call 超时`，而且**每次都是**这样，只有重启服务才能恢复。现在下一次工具调用会**先惰性重启**（重新 spawn + `initialize` 握手 + `tools/list`）再发；重启失败就直接抛「服务器进程已退出且自动重启失败：<根因>」，不再干等 60 秒。惰性而非退出即重启是刻意的：配置写错的服务器只在真被调用时试一次，不会空转拉进程。
  - 三条生命周期不变量：显式关闭后**永久停用**（不复活）、重启过程中被关闭会回收刚起的进程**不留孤儿**、**并发调用共享同一次重连**（先判 `starting` 再判 `child`，否则第二个调用会抢在 `initialize` 应答前发 `tools/call`）。顺手修掉 spawn/握手失败漏子进程、退出后写 stdin 的 EPIPE（可能触发未捕获异常）两个隐患。
  - 回归：单测 5 例（在途调用立即报「进程退出」而非挂超时 → 下一次调用自动重启成功、启动即退出的服务器快速报错、`close()` 后不再重启、崩溃后经 `PluginAgentTool.execute` 真实转发路径恢复）；夹具新增 `crash` 自杀工具（工具数 8→9，冒烟同步），并开始按真 MCP 语义**在 `initialize` 应答写出前拒绝 `tools/call`（-32002）** —— 并发抢跑会因此变成可见失败。

- **page-picker 扩展：拾取时顶部信息条不再被挤成「竖排文字」** —— 它一直是 `left:50% + translateX(-50%)`（没有 `right`），也就是可用宽度只有 `50vw`，`max-width: 92vw` 实际从没生效；窗口一窄或提示一多，里面的字就被压成一行一个字。改成 `width: fit-content; margin: 0 auto`（居中效果不变）并允许**整项**换行；底部的提示条（toast）同一处理。

- **子代理会话里的扩展不再因为调用新 UI API 崩溃，也不会卡在无人应答的弹窗上**（PR #128）——子代理原来只拿到 `{ theme, setStatus, setWidget, notify }` 四个方法的 mock，扩展一旦调用 `ExtensionUIContext` 上的其他方法（`setWorkingVisible` / `setToolsExpanded` / `setTheme` …）就 TypeError，浏览器上还多一条 error toast；补成完整 `WebUIContext` 之后换了个坑：那个上下文没有浏览器面板，`select / confirm / input` 照旧挂 Promise，第一个在子代理里问用户问题的扩展会**永久 await**（只有 20 分钟的工具看门狗兜底）。现在子代理用 `WebUIContext.headless()`：方法面与主对话完全一致，但 UI 输出全部丢弃（不会与主对话的 widget/status 串台）、widget 组件工厂不调用（不留下没人 dispose 的组件）、弹窗立即按「取消」返回。
  - 回归：`tests/unit/webui-context.test.ts`（弹窗立即取消 / 输出丢弃 / 不构造组件）+ `tests/subagent-ui-context-test.mjs`（零 token 端到端：探针扩展把 21 个新 UI 方法都调一遍，再断言子代理侧 `confirm=null`、主对话侧仍是「没人答」；改动前这两条分别挂 4 项与 1 项）。

暂无其他未发布内容。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（28）：`browserPageEnabledDesc`、`browserPageOffHint`、`browserControl`、`browserControlTip`、`browserControlChecking`、`browserControlOffline`、`browserControlEmpty`、`browserControlDisabled`、`browserControlPages`、`browserControlPageOpen`、`browserControlPageClosed`、`browserControlExamples`、`browserControlExample1`、`browserControlExample2`、`browserControlOpenOptions`、`browserControlRefresh`、`browserControlCite`、`browserControlCiteTip`、`browserControlCiteNote`、`browserControlCited`、`browserControlCiteFailed`、`browserControlOpenPanel`、`browserControlSingleTip`、`attachPage`、`attachPageShort`、`tplThinkingLabel`、`tplThinkingFollowMain`、`tplThinkingHint`
- 前端中文变更（2）：`settingsSubagentTemplatesDesc`、`noSubagentTemplates`
- 前端英文变更（2）：`settingsSubagentTemplatesDesc`、`noSubagentTemplates`

<!-- auto-i18n:end -->

## [0.82.0] — 2026-09-13

### Added

- **page-picker 扩展：「发送什么」改成逐项多选（另配 6 个预设）**——原来只有三档详细度（精简/标准/完整），要么一起多、要么一起少；实际用起来常是「这次只要源码位置」「这次只要样式，别的别发」。现在设置页可以逐项勾：页面上下文 / 定位信息（选择器+尺寸）/ XPath 与 DOM 路径 / 源码位置（React/Vue 文件:行号 + 组件链）/ 文本 / 命中的 CSS 规则 / 计算样式 / HTML 骨架（元素截图仍是单独一项）。**没勾的在采集层就不采**，不只是渲染时丢掉——生成 HTML 骨架、读 CSSOM 这些本身就有开销，顺手也把这点省掉。预设覆盖常见组合：精简 / 标准（默认）/ 完整 / 只要能改对地方（选择器+源码）/ 只排查样式（命中 CSS+计算样式）/ 只看文案结构（文本+骨架），一键勾好之后还可以手动增减（预设同时决定采集深浅：文本长度、骨架深度、选择器深度）。老设置（只有 `detail`）升级后按原档位预勾，行为不变。
  - 回归：`sectionsForDepth`/`normalizeSections`/`presetForSections` 单测、采集层「没勾就不采」单测（jsdom）、渲染层「只输出勾选项」单测、设置页多选 UI 单测（勾选真的落盘 / 预设联动 / 全不勾会提示并回落标准组合）、E2E 用自定义组合真投递一遍。

暂无其他未发布内容。

## [0.81.2] — 2026-09-13

### Fixed

- **page-picker 扩展：修「pi-web-ui 页面明明开着，却报『没找到打开的 pi-web-ui 页面』」**——0.2.0 查找目标标签页时传的过滤条件是 `["<地址>/*", "<地址>"]`，而**裸地址（没有路径的 origin）不是合法 match pattern**：真 Chrome/Edge 的 `chrome.tabs.query` 会直接抛 `Invalid url pattern 'http://localhost:8787'`，那个异常被 catch 成了「没找到页面」，于是拾取结果只能退化成「复制到剪贴板」（选项页「测试连接」里的同名查询也一并修）。现在查询只用 origin 级模式（`http://localhost:8787/*`），路径前缀仍由 `tabMatchesBase` 严格复核（子路径反代、前缀相似的站点都不受影响）。
  - 这个 bug 能活着发布，是因为单测/E2E 用的是**假 chrome**，它不校验 match pattern：现在假 chrome 也按真 Chrome 的规则校验入参（`isValidMatchPattern`），这类坑会直接挂在单测上。
  - 另加一条**装真扩展**的 E2E（`tests/page-picker-edge-ext-test.mjs`）：实测 Edge（152，headless）仍接受 `--load-extension`，所以能在真 `chrome.*` 上把「拾取 → 投递 → Markdown 真的落进 pi-web-ui 输入框」跑一遍（没装 Edge 自动 SKIP）。
- **page-picker 扩展：修「在 pi-web-ui 页面上点图标没任何反应」**——绑定浮条原来完全依赖 background 的 MAIN world 探测（`__piWebUiHost` / `/api/health`），那个注入一旦被 CSP/权限/环境挡住，就会静默回落到拾取器，用户看到的就是「新功能没出现」。现在：探测不可用时也照旧注入浮条，**浮条自己再认一次页面**（同源 `/api/health` + 标题/输入框 DOM 兵形），认出是 pi-web-ui 就正常问「要不要绑成服务地址」，不是就自己退场并请 worker 补注入拾取器——**「点了图标什么都没发生」在三条路上都不可能发生**；路由决策同时打进 service worker 控制台，方便排障。

暂无其他未发布内容。

## [0.81.1] — 2026-09-13

### Added

- **page-picker 扩展：在 pi-web-ui 页面上点一下图标就能绑定服务地址**——远程/局域网部署时地址是 `http://39.99.235.208:8787` 这种、端口也不固定，原来只能去选项页手打地址再点「授权该地址」。现在点扩展图标会**先认当前页**：页面上有宿主动作桥 `__piWebUiHost` 即认定，老版本则退一步探一次同源 `/api/health`（`{ok, piVersion}` 才算数，所以任何「所有路径都回 200」的站点都不会被误认）；认出是 pi-web-ui 就在页面底部弹浮条问「要不要把它设为拾取服务地址」，点一下即可（地址/端口/子路径全部按当前页面算，`?token=`、hash、尾斜杠都会归一掉），已经是当前地址时只说明现状不再多问，浮条上另有「在本页拾取元素」（开发 pi-web-ui 自己时用得上）。缺那一个 origin 的授权时，浮条会提示并给一个「打开设置页授权」按钮 —— `chrome.permissions.request` 必须在扩展自己的页面里点（网页上的按钮给不了浏览器要的手势），那个页面带 `?bind=` 预填地址、一键授权 + 绑定。**普通页面点图标的行为一点没变**（仍是进入拾取模式），也**绝不静默改地址**（改前一定在页面上问一次）。回归：`detectPiWebUi`/`bindView` 单测 + service worker 分流单测 + `?bind=` 面板单测（真 options.html）+ E2E（真 pi-web-ui 页 / 真夹具页各自认定 + 浮条绑定后照常投递）。

## [0.81.0] — 2026-09-12

### Added

- **宿主动作桥新增 `compose()`：把内容放进输入框草稿（宿主 API v1 → v2）**——`startChat()` 是「新建对话并把一段话直接发出去」（脚本化，`prompt` 立刻发），但「元素拾取」这类场景需要的是**人在环中**：内容先落进输入框，用户补一句「这三处间距不一致」再自己发。现在 `window.__piWebUiHost.compose({ text?, attachments? })` 干这件事，与 `startChat` 的差别是**不要求连接就绪**（草稿是本地状态，断线也能先攒着）且输入框没挂载时明确拒收（返回 false，不静默丢）。合并语义复用「撤回消息放回输入框」的同一个纯函数（空则填入、非空追加、**绝不覆盖用户正在打的内容**）；附件按 path+mode+行区间去重，与手动 attach 的口径一致。定义见 `web/src/plugin-host.ts` + `web/src/composer-bridge.ts`（草稿在 ChatInput、附件在 App，两处各自注册自己那一半）。
- **浏览器扩展「网页元素拾取」（`plugins/page-picker`）**：在开发中的网页上点选元素，整理成 AI 能直接动手的上下文，一键注入 pi-web-ui 输入框（`Alt+Shift+P` / 扩展图标 → hover 高亮 → 点击拾取，`Shift`+点击多选，`Esc` 退出，`Ctrl+Enter` 直接发送）。采集的不是截图而是**能让 AI 一次改对**的东西：React fiber 里的组件源码位置（`Card.tsx:18:5` + 调用链）、Vue SFC 文件、命中的 CSS 规则**源文件与行号**（Vite dev 的 `<style data-vite-dev-id>` 的 textContent 与源文件逐字对应，行号可精确反推）、计算样式里**只保留与默认值/继承值不同的项**（现场造同 tag 空元素当探针比对，一个真实卡片通常只剩 3~5 行而不是 300 个属性）、短且唯一的定位串（`#card` > `section.card` > 兜底全 `:nth-of-type`，兄弟冲突会在父级内补 `:nth-of-type` 收窄）、HTML 骨架、可选元素截图（走对话附件，不是把 base64 塞进正文）。详细度三档（精简/标准/完整）在**采集层**就生效。失败一律有兜底：没开 pi-web-ui 页面 / 版本过旧 / 输入框未就绪 / 截屏失败，都会把 Markdown 复制到剪贴板并说明原因，**绝不出现「点了添加什么都没发生」**。
  - 装法：下载 [`page-picker-extension.zip`](https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip)（打 tag 由 `.github/workflows/extension-release.yml` 自动出包，含 CRC 自校验；zip 打包器是自写的零依赖实现，Windows 上也能出同样的包）→ 解压 → `chrome://extensions` 开发者模式「加载已解压的扩展程序」。也可以从源码 `npm run build:extension` 后加载 `plugins/page-picker/extension/`。远程/局域网部署只需在选项页多点一下「授权该地址」。
- **`pi-web-ui` 命令行/插件市场不适用于浏览器扩展**：那条通道装的是**服务端插件**（`<dataDir>/plugins/<id>/`），装不了浏览器扩展 —— 这一点在根 README 与插件 README 里都写明了，免得有人对着 `pi-web-ui install` 找半天。

- **legado-web 插件：阅读页章末导航（读到底就能翻章）**——阅读页原来只有顶部工具栏有「上一章 / 下一章」，正文读到页面底部什么也没有，这一章看完想接着读必须滚回顶部。现在正文末尾多一条「← 上一章 / 目录 / 下一章 →」（跟在正文下面，带《书名》· 第 n/总 章），换章后自动回到页面顶部；第一章「上一章」、最后一章「下一章」置灰并写明「已是最后一章」（顶栏同名按钮同规则，不再点了没反应），章末「目录」展开目录并回到顶部。回归：`tests/unit/legado-chapnav.test.ts`（禁用态与文案边界：首章/中间章/末章/单章/空目录）+ `tests/legado-web-reader-test.mjs`（真浏览器 + 3 章假书源，钉住导航条长在正文末尾、换章回顶、末章置灰、目录展开）。

### Fixed

- **输入框里自动折行的长草稿，按 `↑` 会误触历史回溯、打断正在进行的编辑**（issue #127）——历史回溯的边界判定原先只看**逻辑行**（value 里有没有 `\n`），可输入框是按宽度自动折行的：一段没有换行符的长草稿在界面上明明是多行，却被当成「只有一行」，光标停在第三行按 `↑` 也直接切到上一条历史（`↓` 能切回来、草稿没丢，但编辑被打断，想改上一行只能动鼠标）。现在改按**视觉行**判定：新增 `web/src/caret-visual-line.ts`，把与折行相关的样式（字体 / 行高 / 字距 / `white-space` / `overflow-wrap`）拷到一个隐藏镜像 div 上，塞入「光标前的文本 + 一个零宽标记」，量标记的 `offsetTop` —— 与 textarea 自身的折行规则一致（`pre-wrap` + `break-word`），于是「光标上方 / 下方还有没有可见行」直接比像素：首视觉行 ⇔ 标记贴顶，末视觉行 ⇔ 与文末标记同高。拿不到布局的宿主（SSR / jsdom / 未挂载 / `display:none`）回落到旧的逻辑行判定，宁可少一次精确判定也不误判成「可以翻历史」；有选区、输入法组合中一律不碰历史。功能本身没退化：光标真的走到首 / 末视觉行后照旧翻历史，`Esc` / `↓` 仍能回到草稿。回归：`tests/unit/caret-visual-line.test.ts`（像素折算 + 无布局回落 + 选区 / 空输入框边界）+ `tests/composer-history-test.mjs`（真浏览器：折成 4 行的无换行草稿要按满 4 次 `↑` 才切历史、前 3 次逐行上移且内容不变、`↓` 切回草稿、换行草稿与单行草稿的老边界行为不变、测量节点不残留草稿正文）。

- **MCP 桥把非文本内容块静默丢掉：截图 / 图像生成 / 图表类工具一律返回空串**——`server/mcp-bridge.ts` 的 `McpClient.call()` 以前只拼 `type === "text"` 的块，`image` 与 `resource` 块被直接丢弃，模型既不报错也拿不到任何东西，工具形同虚设（同一 `browser_screenshot` 调用：桥内得到 `""`，桥外直连 stdio 是 22840 字符的 `image/png`）。现在按块类型保序映射：`image` 原样透传成 SDK 的 `ImageContent`（`{type,data,mimeType}`，进会话后由 SDK 的 `normalizeToolResultImages` 统一缩放，超大图不会再让 provider 整段报错）；**文本型 `resource`（`resource.text`）当文本透传**——MCP 的 `EmbeddedResource` 分 TextResourceContents 与 BlobResourceContents 两种，前者是真实正文（filesystem 类 MCP 的 read_text_file 就走这条），退化成「已跳过」等于把文件内容吞掉；PDF 这类 blob 与 audio 退化为「mimeType + 约 N 字节，无法内联」的提示（SDK 内容联合只有 text/image/thinking/toolCall，没有 blob 载体）；纯文本结果仍返回拼接字符串（老形状不变，不破坏既有调用方）。回归：`tests/unit/mcp-bridge.test.ts`（image 逐字保真 / 文本资源不丢正文 / blob 退化提示 / 混合保序）+ `tests/mcp-bridge-test.mjs`（e2e 握手 8 tools）。限定：Web UI 的工具卡按既有行为只渲染文本（工具结果里的图片在序列化时是 `[image result]`），图片会进**模型上下文**但不在 tool 卡里显示。

- **命令行 `pi-web-ui install <插件> --force` 之后插件一直「不存在」**：CLI 装插件是先整目录删掉再拷新的（`install --force` 的 rm→cp 窗口），撞上这个窗口期的一次插件扫描会把插件当成「已卸载」反激活；而反激活时没把插件从 `attempted` 集合里摘掉，目录回来后永远不会再激活——插件的 HTTP 路由（如 legado-web 的 `/plugins-api/legado-web/proxy`）与 AI 工具在本进程内彻底消失，前端只报「代理请求失败 404 <url>」，CLI 承诺的「服务运行中刷新浏览器即可加载」失效，必须重启服务才恢复。现在反激活会摘掉 `attempted` 并推进 epoch（重新 `import` 拿到磁盘上的新代码、浏览器也重拉插件 client bundle），刷新浏览器即自愈。回归：`tests/unit/plugin-manager.test.ts`（目录消失→回来必须重新激活且用新代码）+ `tests/plugin-test.mjs`（真实 HTTP 路由的 rm→cp 窗口自愈）。

<!-- auto-i18n:start -->

### i18n

- 本版无文案增量（相对 v0.80.2，已核查）。

<!-- auto-i18n:end -->

## [0.80.2] — 2026-09-12

### Added

- **新官方插件 legado-web（📖 阅读）**：把 [Legado / 阅读](https://github.com/gedoor/legado) 的读书链路搬进 pi-web-ui——搜索 / 发现 / 详情 / 目录 / 正文，书源 JSON 与安卓版兼容，另带书源导入、废源检测与清理。插件自带内嵌前端需要的一切后端：跨域 + GBK 代理、本地存储（书源 / 书架 / 阅读进度只落数据目录 `<dataDir>/legado-web/`，不写浏览器 localStorage）、静态托管。安装 `pi-web-ui install xing-shuyin/pi-web-ui/plugins/legado-web`（插件市场里也可一键装），刷新后顶栏多一个 📖 tab。
  - **顺带给 AI 配了修源接口**：四个 agent 工具 `legado_rules`（规则速查）/ `legado_book_sources`（读书源文件、只改坏掉的那几个字段）/ `legado_source_probe`（逐步跑链路，回报每步请求、HTTP 状态、用到的规则与失败明细）/ `legado_run_rule`（拿真实页体试一条规则再落盘）；阅读页与书源页的「🤖 AI 修复源 / AI 新建书源」按钮把现场直接发给 AI 并开一个新对话（工作目录限定在插件数据目录）。规则引擎跑在 worker 里，同步 JS 规则（`java.ajax` 等）走 SharedArrayBuffer 桥。
- **插件 → 宿主动作桥 `window.__piWebUiHost`**：插件 client bundle 是裸 ESM，import 不到应用模块，之前只能往宿主发数据；现在也能让主应用**做事**——`setView("chat" | "terminal" | "git" | "plugin:<id>")` 切主视图，`startChat({ prompt, newChat?, cwd? })` 新建对话（可选切工作目录）并把 prompt 作为用户消息发出去。时序上 `startChat` 会串行等「cwd 切过去 → 对话换成新空白」才发 prompt（服务端 `new_chat` 是异步的，紧接着发会落到旧对话），每步都有超时，超时也发、不静默丢。定义见 `web/src/plugin-host.ts`。

### Changed

- **升级 SDK `@earendil-works/pi-coding-agent` 0.84.4 → 0.85.1**（上游带来 `@earendil-works/chord`、Anthropic SDK 0.123.0、esbuild 0.28 等）；本仓库代码无需跟着改。
- **README 中英双版按当前实况重写**：功能清单补全（快捷键、Docker、队列撤回、消息构成、项目与会话、搜索与导航、文件树、终端与 Git、模型与设置、Agent 工具与内联标记、声音与通知、PWA、调优用环境变量等章节），中英两边同步并修掉失效锚点。
- 插件运行期数据 `plugins/*/storage/` 加入 `.gitignore`；legado-web 的上游前端源码与构建产物加入 `.prettierignore`（保持上游风格，不被格式化重排）。

### Fixed

- nginx 子路径示例配置删掉 `favicon-streaming.svg` 的那条 `location`：该图标早已不存在，留着只会让人以为得额外补一个文件。

<!-- auto-i18n:start -->

### i18n

- 本版无文案增量（相对 v0.80.1，已核查）。

<!-- auto-i18n:end -->

## [0.80.1] — 2026-09-12

### Added

- **更新面板新增「重启服务」**：由 `pi-web-ui server start|install` 起的实例，更新面板底部多一个按钮，点一下服务就重启（等价于 `pi-web-ui server restart`）——更新完立即生效，不用回终端。服务端 `server/launch-origin.ts` 判定本实例是不是被平台服务托管（launchd / systemd / Windows watchdog），判定结果随 `ready.service` 下发，`pi-web-ui server status` 也会显示启动方式；认不出来（前台 `pi-web-ui`、`npm run dev`、Docker）就不画按钮、也拒绝 `restart_service`——那里没有 supervisor，退出就真的停了。已装好的服务不用重装（运行时靠 `XPC_SERVICE_NAME` / `INVOCATION_ID` / `%APPDATA%\pi-web-ui\<name>.pid` 对比 `process.ppid` 识别），新装的另外烘焙 `PI_WEB_LAUNCHED_BY=service` / `PI_WEB_SERVICE_NAME`。回归：`tests/restart-service-test.mjs`。

### Fixed

- **终端接管 bash 修复：没有尾部管道的命令不再报 `Cannot read properties of null (reading 'segment')`（issue #121）**：`date`、`ls | head -5` 这类命令没有「尾部限输出管道」，`detectTrailingLimiter()` 返回 `null`，而 #91 v2 的取值重构把原本的可选链写成了非空断言 `limiter!.segment` —— 结果几乎每条一次性 bash 命令都在取值处直接 TypeError（只有以 `| tail` / `| less` / `| more` / `| cat` 结尾的命令能跑）。现已改回可选链（这几个值只在真的拆掉管道时才被取用）。回归：`tests/unit/terminal-bash-limiter.test.ts`（桩终端钉住取值路径，CI 必跑）；`tests/terminal-bash-test.mjs` 同步恢复可跑（动态导入走 `pathToFileURL`，Windows 上也跑得起来；提示文案断言钉死中文；一次性终端退出改为轮询而非固定等待）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（3）：`restartService`、`restartingService`、`restartServiceTip`
- 服务端新增 key（2）：`terminals.headtail.omitted.below`、`terminals.headtail.omitted.above`

<!-- auto-i18n:end -->

## [0.80.0] — 2026-09-12

### Added

- **桌面版（Electron 外壳）**：同一套服务端 + 前端装进一个原生窗口——主进程用随机空闲口起 `dist/server/index.js`（`ELECTRON_RUN_AS_NODE` 当纯 Node 用，不再额外捆一个 Node），`/api/health` 就绪后 `BrowserWindow` 直接加载该地址，因此前端 `appUrl("/ws")`、`server/protocol.ts` 全部零改动。可与网页版并存：不抢 `8787`（`PI_WEB_PORT` 被占用时自动退到随机空闲口）、独立数据目录（`<userData>/data`）、独立单实例锁；外链丢给系统浏览器，renderer 走 `contextIsolation + sandbox` 且无 Node。Windows（NSIS，可选安装目录）/ macOS（dmg）/ Linux（AppImage）安装包随每个 Release 由 CI 并行出包并附在 Release 页面；开发用 `npm run desktop:dev`，本地打包用 `npm run desktop:dist`。
  - 当前三平台产物都**未签名**：Windows 首启有 SmartScreen「未知发布者」提示，macOS 首次需右键 → 打开（Gatekeeper），进展见仓库 README 的 Code signing policy 一节。

### Changed

- 桌面版图标复用网页版 PWA 图标（`web/public/icons/icon-1024.png`），网页版与桌面版换图标只改一处。
- 仓库自检现在覆盖桌面壳：`npm run typecheck` / `format:check` / `lint` 都把 `desktop/` 纳入范围。

## [0.79.0] — 2026-09-11

### Added

- 聊天消息支持渲染 LaTeX 公式（issue #116）：`$...$` 行内、`$$...$$` 独立行块走 KaTeX 渲染（`remark-math + rehype-katex`，字体随包离线可用）；代码围栏/行内 code 不受影响，公式写坏了只显示红色源码不打断整条消息。
- 排队/插队气泡新增「撤回」按钮 ↩（#118）：点一下把该条消息从队列取回、文字落回输入框（输入框非空时追加到末尾，绝不覆盖正在打的字），改完直接重发；连续撤回多条按序追加。队列里只存文本，撤回只回文字（附件不恢复）。
- 新增 paper（暖纸）/ mist（雾蓝灰）/ sakura（樱粉）三套浅色主题：主题切换器与 `make-light-theme.mjs` 生成器同步增强，终端配色跟随主题；`vscode-editor` / `db-client` 插件同步跟随亮色（见下 Fixed）。

### Fixed

- `vscode-editor` 插件跟随亮色主题：之前文件树/标签栏/弹窗底色引用了主应用不存在的 `--bg-elev0/1` 变量，亮色下永远回退到深色硬编码值；编辑器（CodeMirror `oneDark`）与底部 SSH 终端配色也是写死的深色。现在底色改走 `--bg/--bg-elev`，编辑器亮色用跟随 `--bg/--text/--accent` 的浅色壳（暗色仍是 `oneDark`，Compartment 热切换），终端读 `--term-*` 调色板；主应用切换主题时（`pi-web-ui:theme-change`）已打开的编辑器与存活终端一起换肤，无需重载。
- `db-client` 插件跟随亮色主题：同上，文件树/主区/表头/弹窗输入框底色引用的 `--bg-elev0/1` 改走 `--bg/--bg-elev`（该插件无自绘深色组件，一次变量映射即完整跟随）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（1）：`queueRecallTip`

<!-- auto-i18n:end -->

## [0.78.0] — 2026-09-11

### Added

- 文件预览支持渲染 HTML（`README.html` 这类文件不再只看到源码）：打开 `.html` / `.htm` / `.xhtml` 默认是**渲染视图**，工具栏的 👁/`</>` 与 Markdown 一样一键切源码，进编辑态自动落到源码。渲染走**沙箱 iframe**，页面里的 JavaScript 默认**不执行**（工具条显示「🛡 脚本已禁用（静态预览）」），要跑脚本得对**当前这个文件**点「启用脚本」显式放开（切文件即复位、不持久化、不写进任何配置）；无论开关如何，iframe 一律**不带 `allow-same-origin`** —— 页面拿不到本应用的同源/DOM/cookie/存储，表单提交与顶层跳转同样被挡（脚本开时工具条换成「⚠ 脚本已启用」并说明后果）。渲染地址是新增的目录映射路由，页面里的**相对引用**（`<link href="../web/src/styles.css">`、`./app.js`、图片…）按浏览器正常语义解析加载：
  - `/api/preview/<工作区相对路径>`（机器浏览的绝对路径用 `__abs__/` 前缀），各路径段 URI 编码；`.html` 文档下发 `Content-Security-Policy: sandbox`（`?allowJs=1` 时 `sandbox allow-scripts`，**永不**加 `allow-same-origin`）与 `X-Content-Type-Options: nosniff`，其余子资源按真实 content-type 直送；`..` 越界由 `workspacePath()` 拒绝（400 `path outside workspace`）。
  - `/api/file` 直出的 HTML 也带上 `sandbox` CSP——把预览地址单独在新标签页打开，一样拿不到应用源。

### Fixed

- 重试与提示词模板「直发」补记模型使用次数：这两个入口都是「沿用当前模型再发一轮」，之前不计入 `model-usage`，模型下拉的「按使用次数排序」会漏掉这部分（现在与正常发送一致；模板直发记的是当前模型）。
- `vscode-editor` 插件中止上传时临时文件可能残留（Windows）：`abortUploadEntry` 旧写法是 `void fh.close()` 后立刻 `unlink` 并把错误吞掉，而 close 是异步的 —— 句柄还没关就删会 `EBUSY/EPERM`，目标目录里就留下 `.vsc-upload-*.part`。现在改成 `await close()` → `await unlink()`，且 `upload_abort` 等清理完再回响应（客户端随后就会去核验目录）；定时清扫与 `deactivate` 两条路径改为不等（`void`）。

### Changed

- 排队/插队消息改成和正式用户消息**同一套气泡**（`MessageList.tsx` 的 `QueuedMessage` 复用 `.msg-user` 结构）：Markdown 渲染（代码块/列表/链接等不再是一坨纯文本）、角色行显示「你」、状态 tag（插队/排队）与移除 ✕ 排在同一行；未发送仍用**虚线边框 + 0.75 透明度**区分，服务端真正下发后直接变成正常消息气泡（外观不再跳变）。`styles.css` 里旧的 `.queued-bubble` / `.queued-text` / `.queued-remove` 一套样式一并删除。
- 官方插件做手机竖屏（≤640px）适配，桌面端表现不变：`db-client`（连接侧栏变左滑抽屉、库表树变可折叠面板、结果表格在容器内横滑、Redis 键列表改上下排、触摸目标加大、输入框提到 16px 防 iOS 聚焦缩放）、`vscode-editor`（文件树变抽屉 + 顶栏 ☰、选中文件自动收起）、`run-trace`（三段改上下堆叠、时间轴压到 200px、回放条允许换行、触屏色块热区加大）、`webmail`、`demo-mailbox`。
- `docs/architecture-attachments.md` 的文件预览协议补一节「HTML 渲染走目录映射的 HTTP」（沙箱策略与相对引用语义）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（8）：`showHtmlSource`、`showHtmlPreview`、`htmlJsOff`、`htmlJsOffTip`、`htmlJsOn`、`htmlJsOnTip`、`htmlEnableJs`、`htmlDisableJs`

<!-- auto-i18n:end -->

## [0.77.0] — 2026-09-11

### Added

- 结构化派单工具 `delegate_task`：六段式派单（agent + TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT，有最小长度）+ 服务端校验——模板不可用、缺段、太短直接报错打回，模型补全后重试。执行体复用子代理 spawn 通道（真会话、白名单、模型优先级、左栏徽标、等待/改向/停止）。前端派单卡片：卡头 ◈ agent 芯片 + 「查看子代理」一键跳转，六段式正文（脏参数不抛错）。
- 7 个 specialist 子代理模板（移植自 oh-my-pi 内置 agents，改写为真子代理提示词）：`oracle`（只读架构/难 bug 顾问）、`librarian`（外部文档调研）、`explore`（代码库侦察）、`metis`（计划前澄清）、`momus`（计划评审）、`multimodal-looker`（PDF/图片/图表解读）、`sisyphus-junior`（单点执行）。`subagent_spawn(template=)` 直接选用；老用户已有模板文件时一次性自动补齐（sidecar 记录已播种名单，此后删除不再复活）。
- skill 全文注入（设置 → 技能页，按技能单独勾选“全文”）：勾选的技能 `{{skills}}` 展开为正文（oh-my-pi 式 `### Skill:` / 引用描述 / 全文格式；单文件 8KB、总量 32KB 封顶，超限回落名录），不勾选的仍为名录由模型按需读取。改动下一轮即生效，随预设保存/应用。
- Agent 工具统一开关：设置新增「工具」tab，18 个工具（持久终端 7＋子代理 7＋`edit_soft`/`delegate_task`/`ask_user_question`/`markers_list`）逐个开关，标记管理（总开关＋分组＋查询工具）也并入该 tab（原标记页移除），后端收成 `tool-manager.ts` 单一出入口（`setAgentToolEnabled`/`applyAgentToolsGating`），改动 live 生效无需 reload，随预设保存/应用；旧的终端/编辑/问卷开关自动迁移，旧客户端照常用。

### Fixed

- 排队气泡的 ✕ 只删一条（#113）：`removeFirstOccurrence(list, text)`（`server/queue-utils.ts`，纯函数可单测）只移除第一处匹配，`removeQueued` 的两条队列（插队 / 排队）都改用它。旧实现重建队列时用值过滤（`filter((t) => t !== text)`），同一条文本被排队两次时点一次 ✕ 会把两条一起删掉，而气泡只消失一条（要等下一次 `queue_update` 才对齐）；现在与气泡 UI、本地显示镜像、DSH 引擎的「删第一条」语义一致。回归 `tests/unit/queue-utils.test.ts`（6 例）。
- 手机端聊天内容贴边（列内缩被算成 0）：两个原因都堵上了。① `--chat-pad` 回调到 14px（= 改前 `.msg` 自带的 14px 内边距）——中央列收敛成一条 token 时手机上取了 10px，消息文字/卡片比原来贴边 4px，输入框也跟着从 10px 调到 14px，两边仍齐平。② `--msgs-gutter` 不再只信首帧前的探针：`.messages` 挂载后改用真实元素实测并覆盖，窗口尺寸变化（含手机横竖屏）时再校一次——个别浏览器/设备上探针与真实滚动容器的 gutter 对不上，会把消息列多缩/少缩一条 gutter。另外 `.messages` 的左右内缩改成 `max(0px, calc(--chat-inset - --msgs-gutter))`、上下留白改用 `padding-block` 独立声明：相减出负值时旧写法会让整条 `padding` 声明失效（连上下留白一起丢，内容直接贴边），现在最坏只是不扣那一条 gutter。回归 `tests/chat-column-align-test.mjs` 增加「消息列不贴边」断言（内缩不得小于列留白）。
- 输入框底部工具条在窄屏下重叠：428px 左右「思考」chip 会压到右侧的 发送/停止（流式时右侧最宽）。两处修正：① 工具条里的 chip（含外层 `.dropdown` 锚点）补上 `min-width: 0` / `flex-shrink: 1`，模型名与思考等级先收缩、再省略号截断，不再溢出到右侧按钮上（桌面窗口窄到主列放不下时同样有用）；② 纯图标阈值从 420px 提到 560px：窄屏直接隐藏 模型名/思考等级/下拉箭头，chip 放大到 34×30，只留图标（文字交给 title 悬浮）。回归 `tests/composer-overlap-test.mjs`（320–1200px 扫描，注入流式时的「排队|插队」对半胶囊，断言左侧不压右侧、胶囊 78px 且两半等宽、≤560px chip 只剩图标）。

### Changed

- 新增全局运行态 `web/src/app-globals.ts`（模块级 store + `useSyncExternalStore`，`useAppGlobals()` / `useIsDsh()` / `useIsManaged()`）：`engine`、`managed`、`tabs`、`appVersion`、`serverVersion` 这些「整棵树都要知道、整个连接内只变一次」的信息不再从 App 逐层传 props —— GoalBar / SettingsModal / PiSetupModal / TopBar / FooterBar / ChatInput 改读全局（DSH 的四处 gating、受管实例的更新/插件入口都不再依赖“谁记得传这个 prop”）。写入点只有一处：`use-chat.ts` 收到 `ready` 时（同步于 dispatch 之前，不会闪一帧 pi）。顺带修正 DSH 下「插队」名不副实：DSH 无 mid-run steering（prompt 一律 followUp），运行中只渲染「排队」半段（收成 38px 圆），placeholder 也换成 `placeholderStreamingQueued`（回车与点排队都是本轮结束后才发）。回归 `tests/unit/app-globals.test.ts`。
- WebSocket 发送器也收进全局：`appSend`（`web/src/app-globals.ts` 下半部分，`use-chat` 用 `setAppSend` 装配）—— 19 个组件的 `send` prop 全部删除，`App.tsx` 少 19 处逐层传参（对话框/弹窗/面板/插件视图/终端/SCM/底栏全部自己取），`ClientMessage` 依赖也随之从这些文件消失；测试（`dsh-question-dialog.test.ts`）改用 `setAppSend` 注入并记录发出的消息，组件仍可测。两个例外是故意的：`LeftPanel` / `RightPanel` 的 prop 改名为 `panelSend`（它们拿的是 App 的包装函数，带「顺手关手机抽屉」的副作用，不能换成全局发送器）；装配写在 render 期间而非 effect —— 子组件 effect 先于父组件跑，放 effect 里装配会让「挂载即发请求」的弹窗在 appSend 还是空的时候静默丢包。
- 全局运行态再扩三项：`ready` / `status` / `cwd`。`LeftPanel`（三个都收）、`RightPanel`（cwd）、`ChatInput`（ready）、`GlobalSearchModal`（cwd）不再要这些 prop，改从 `useAppField(key)` 单字段订阅 —— cwd 是低频字段，单字段订阅让「切项目」的通知只到真正读 cwd 的组件，不会连带重渲染只读 engine 的组件。写入点：`use-chat.ts` 里一个 effect 把 reducer 的真值镜像过去（单一来源，最多晚一帧；默认值只会是「未就绪 / 未连接 / 空目录」，看不出来）。本来就吃整个 ChatState 的 `App` / `TopBar` / `FooterBar` 仍直读 `chat.*`（自己就持有数据，不必绕一圈）。
- 运行中发送位改成「排队｜插队」对半胶囊：空闲态那颗发送圆钮在流式中原地变形为 78×38 的蓝胶囊，两半各 38px、中间一条 1px 半透明白线——左半「排队」（列表图标，加入队列，整轮跑完才发）、右半「插队」（↑，回车语义，本回合立刻响应，与 Enter 同一条路径）。原文字版「排队」药丸及其 ≤560px「收成图标」的兜底一并删除（窄屏右侧最宽从文字药丸降到固定 78px）；空输入时整颗胶囊变暗、两半禁用（尺寸位置不动，工具条不跳），有文字或纯附件时解锁。停止语义与它们相反，仍是右侧独立的蓝圆，不并入胶囊。`tests/supplement-test.mjs` 同步改为点左半，并断言「空输入两半禁用 → 输入后解锁」。文案变更：前端新增 key `steerTip`。
- 设置面板减负：常驻列表里的静态解释全部收进标题/开关旁的「?」悬浮提示（含 7 个「已关闭」后果说明、重试次数、子代理默认模型、全文注入说明等）；行内只保留计数、空状态、报错与动态状态（如当前转写模型）。文案 key 无增减。
- 问卷（`ask_user_question`）不再被工具挂死看门狗剁掉：以前它跟普通工具一样被算作「一个工具跑了 20 分钟」（`PI_WEB_TOOL_TIMEOUT_MS`），到点就 abort 整轮对话并弹「工具执行超过…已自动终止」——把还在思考的用户连对话一起终止。现在按工具名豁免：问卷等的是人类回答，不是挂死的工具，收场只走用户回答/取消与会话 dispose，**不限时**。同理，问卷挂着也不再算「失联」（stall 告警默认 180s 无 SDK 事件，对该对话跳过）。同时补上「刷新/重连后问卷对话框不再消失」：`question_pending` 是即时通道，只推给提问那一刻在线的连接，刷新页面/新标签页都拿不到那条历史消息，而服务端还在阻塞等人回答；现在待答问卷同时挂在快照（`UiState.pendingQuestion`，标准引擎只带当前对话的那张，切回原对话会重推快照）上，两个引擎（标准 pi / DSH）重连后都会把面板恢复出来，由快照恢复的面板也能被快照收起（另一标签页答完/服务端取消），但即时通道弹出的面板不会被在途旧快照闪掉，已答过的问卷也不会被在途旧快照重新弹出。回归 `tests/question-bridge-test.mjs`（零 token，本地假模型驱动整条链路）+ `tests/unit/pending-question.test.ts`。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（28）：`placeholderStreamingQueued`、`steerTip`、`settingsTools`、`toolsSectionTerminal`、`toolsSectionSubagent`、`toolsSectionOther`、`toolsSubagentDepHint`、`delegateTaskEnabledDesc`、`delegateTaskOffHint`、`todoListEnabledDesc`、`todoListOffHint`、`toolDescSubagentSpawn`、`toolDescSubagentGetResult`、`toolDescSubagentSteer`、`toolDescSubagentList`、`toolDescSubagentStop`、`toolDescSubagentWaitAll`、`toolDescSubagentTemplates`、`skillFullTextLabel`、`skillFullTextDesc`、`skillFullTextShort`、`delegateOpenSubagent`、`delegateSecTask`、`delegateSecExpected`、`delegateSecTools`、`delegateSecMustDo`、`delegateSecMustNotDo`、`delegateSecContext`
- 服务端新增 key（3）：`delegate.validate.agent`、`delegate.validate.short`、`delegate.started`

<!-- auto-i18n:end -->

## [0.76.0] — 2026-09-11

### Added

- 桌面通知的诊断能力（默认不显示在界面上）：`sendTestNotification()` 会立刻发一条系统通知（不受「页面不在眼前」抑制影响，且带 `requireInteraction` 不会自己滑走），并汇报走的是 service worker 还是页面通知、失败原因、**浏览器到底有没有留下这条通知**（`getNotifications()`，区分「系统层面被压住」与「浏览器直接丢了」）与判定依据（焦点 / 可见性 / 是否最小化 / 空闲秒数）。界面在 `web/src/components/NotifyToggle.tsx` 的 `SHOW_NOTIFY_TEST_PANEL` 常量后面，排障时改成 `true`。

### Fixed

- **Windows 上窗口最小化后依然收不到任何桌面通知**（v0.75.0 只修了一半）：Win11 实测，窗口最小化后 `document.hasFocus()` 仍是 `true`、`visibilityState` 仍是 `"visible"`，连 `blur`/`visibilitychange` 都不发 —— 「只看焦点」和「焦点 **且** 可见」两种条件都在这个场景下把通知全部静默掉。现在改用只有最小化会变的那组信号判定（原生窗口矩形：`screenX/screenY` 跳到屏幕外的「最小化坐标」，`outerWidth/Height` 塌成标题栏；`isCollapsedWindow`，有单测），并且在 Windows 上额外要求「最近 2 分钟内有过页面交互」才背静默 —— 这个平台的焦点/可见性都不可信，宁可多提醒一次也不漏。非 Windows 平台行为不变（其焦点/可见性可信）。
- 通知发送路径不再因 service worker 抛错而彻底静默：注册存在但还没 active（首次加载 / 刚更新后）时 `showNotification` 会失败，现在会退回页面通知，两者都失败也会把原因带出来（诊断按钮里看得到）。
- 修掉「只有第一次弹、之后怎么都不弹」：通知带固定 `tag` 时，Windows 把同 tag 的新通知当成**替掉旧条目**，而且是静默的 —— 没有横幅、没有提示音，只要系统通知中心里还躺着一条 pi-web-ui 通知，后续每一条都会被无声替换（页面上看 `showNotification` 明明成功了）。现在干脆不用 tag（也不依赖 `renotify` —— 实测它在 Windows toast 这层不起作用），每条都是全新 toast；代价是通知中心里会累积几条。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（9）：`notifyTest`、`notifyTestBody`、`notifyTestSent`、`notifyTestFailed`、`notifyTestState`、`notifyTestHeld`、`notifyTestDropped`、`notifyTestGateSuppressed`、`notifyTestGateOpen`
- 前端中文变更（1）：`notifyEnableDesc`
- 前端英文变更（1）：`notifyEnableDesc`

<!-- auto-i18n:end -->

## [0.75.0] — 2026-09-11

### Added

- 桌面通知（PWA）的 Windows 适配：
  - 点击通知现在经 service worker 的 `notificationclick` 聚焦/唤回原本的窗口（匹配 URL 优先、其次任一应用窗口，都没有才新开）——之前 Windows/Linux 上点通知等于没反应，只能眼看着横幅消失。
  - 通知不可用时区分原因：地址不是安全上下文（非 localhost 的 http，局域网 IP / 主机名访问的常见「在这台机器起服务、从另一台电脑打开」情形）与「浏览器不支持」分别给提示；不可用时开关置灰，不再假装能打开。
  - Windows 上额外提示系统层开关：「设置 → 系统 → 通知」要允许浏览器（或已安装的应用），并关闭专注助手/勿扰；同时说明关窗即进程结束、之后不再提醒。
  - 提示文字改为换行显示（原来被单行省略号截断）。

### Fixed

- 桌面通知在 Windows 最小化后完全不提醒：抑制条件从「有焦点就跳过」改为「有焦点 **且** 页面可见才跳过」（`shouldSuppressNotify`，有单测）。Windows 上最小化窗口可能仍报 `document.hasFocus() === true`，而 Page Visibility 在最小化/被遮挡/后台标签页都会报 `hidden`——原来那套只判焦点的写法正好在本功能存在的场景下把通知全部静默掉。
- 本地 Playwright E2E 脚本在 Windows 上无法启动：`spawn` 的 cwd/脚本参数用的是 `URL.pathname`（Windows 上得到 `/E:/...`）→ 直接 ENOENT；改为 `fileURLToPath`，清理服务端进程在 win32 改用 `tests/lib/port-utils.mjs` 的 `freePort`（负数 PID 的进程组在 Windows 不存在，旧写法会留下监听进程）。`tests/sound-settings-test.mjs` 补上了通知开关的断言（渲染 / 置灰规则 / 状态与持久化一致 / 刷新后保持）。
- 设置面板「标记」列表的描述与「?」提示跟随界面语言（#111）：之前发的是静态中文 guidance，任何 UI 语言都显示中文（含葡语/日语等已翻译语言）。改用与系统提示词组装同一条语言感知路径 `getGuidance(lang)`，无该字段的标记仍回退静态值。
- 消息列与输入框宽度不一致、左右边缘对不上：根因是布局里有十几处各自为政的 `max-width: 860px; margin: 0 auto` / `calc(100% - Npx)`（手机端 `.msg` 内边距 14px vs 输入框 10px、窄列下只有消息行加 48px 右 margin、宽屏聊天列另写一套 260px margin），外加 `--msgs-gutter` 探针量错了滚动条（`overflow-y: scroll` 量到叠加层滚动条 0px，而 `.messages` 的 `stable both-edges` 实际每侧占位 10px）→ Windows 上消息列恒比输入框窄 20px。现在「中央列几何」收敛成 `.main` 上的四个 token（`--chat-pad` / `--chat-max` / `--chat-rail` / `--chat-inset`），消息列、输入框、goalbar、`/` 菜单、问卷面板都只用 `--chat-inset`：任何视口宽度、宽屏聊天列开关开关、手机、窄列避开提问导航条时都自动等宽且左右边缘对齐。新增回归 `tests/chat-column-align-test.mjs`（见 `docs/architecture-core.md` 的「中央列几何」）。
- Windows 触屏笔记本 / 二合一上回车发不出去：触屏判定原来只看 `(pointer: coarse)`，这类机器的主指针（触屏或触控板）常被判为粗指针 → 回车被当成换行，只能手点发送按钮。改为「粗指针 **且** 无 hover **且** 非桌面系统」的判定（`web/src/touch-device.ts` 纯函数，有单测）：Windows / ChromeOS / Linux 桌面一律按有物理键盘的桌面处理（Android 的 UA 里也带 Linux，已排除），iPad 靠 `maxTouchPoints > 1` 与真 Mac 区分。

### Changed

- 移动端界面收紧：
  - 顶栏所有控件（视图 tab / chip / 左右折叠按钮）统一高度；文件面板折叠按钮移出可横滑的 `.topbar-actions`、固定在右上角——之前窄屏上会被 tab/chip 挤出屏幕外。
  - 底栏手机端改为单行紧凑显示：上下文标签与进度条收起、只留「已用 / 窗口」数字；速率前加一个小转圈（窄屏省略「工作中」文案）；工作目录宽度不够时省略号截断。
  - 提示词模板选择器与编辑弹窗改为「头尾固定、中段滚动」：模板多、字段区高时标题与操作按钮不再被滚走。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（2）：`notifyInsecure`、`notifyWindowsHint`
- 前端中文变更（2）：`notifyEnableDesc`、`notifyDenied`
- 前端英文变更（2）：`notifyEnableDesc`、`notifyDenied`

<!-- auto-i18n:end -->

## [0.74.0] — 2026-09-10

### Added

- 右栏扩展 widgets 区高度可拖拽（#109）：文件区与 widgets 区改为与左栏同款的「权重分割」——两区之间新增分隔条（拖动改高度、双击复位、`localStorage` 键 `pi-web-ui:rp-sizes` 记忆），widgets 不再被 `max-height: 40%` 写死；无 widgets 时布局与改动前一致。

### Changed

- run-trace 插件「跟随」改为真正的实时流动：色块匀速平滑左移（逐帧亚像素位移，不再一秒一跳），**时间刻度线钉在屏幕固定位置完全不移动**（跟随期间自绘刻度尺并隐藏 vis 自带轴/网格，刻度数值随时间滚动；绘图区右侧 40px 处有固定的「现在」竖线，新事件贴着它出现再往左流走）。缩放（滚轮）不再退出跟随——按新缩放级别重新锚定「现在」；拖拽平移仍会暂停跟随（再点「跟随」恢复）。运行结束时平滑退出、内容不跳。
- 工具卡头（状态图标右侧）显示关键参数提示：**文件路径**（`.toolcall-path`，读/写/编辑类工具的 `path`/`file_path` 等参数；超长保尾段，完整值在 title 悬浮提示）+ **超时**（`.toolcall-timeout`，从正文终端行移来：bash 卡折叠时也能看到，且任何带 `timeout` 参数的工具都显示，不限 bash）。提取逻辑抽成纯函数 `web/src/tool-args.ts`（有单测）：正则扫描前 256KB 而非 JSON.parse——1 流式半截 JSON 下 `path` 一落地就显示；2 write 的大 content 不会每次渲染都解析；3 AI 把参数填错（非 JSON / 类型不对 / 缺字段 / 超长 / 带控制字符）一律静默不显示、绝不抛错。
- 工具卡正文内边距与思考块统一：`.toolcall-body` 由 `8px 12px 10px` 改为与 `.thinking-body` 同值，两者共用新变量 `--card-body-pad`（`4px 14px 12px`）——同一条消息里两种卡片的文字左缘对齐。所有主题生效；`.compaction-body` 仍是自己的 `8px 12px 10px`。
- 全透明主题（`themes/transparent.css`）下的工具卡减噪：工具参数块（`.toolcall-args pre`）、工具输出块（`.toolcall-output pre`）与终端行（`.termline`）不再画边框、也不留内边距（新增语义变量 `--code-border` / `--code-pad`，默认 `var(--border-soft)` / `8px 10px`）；终端行与卡头重复的终端图标（`.termline-icon`）隐藏。理由：全透下这三处没有容器色（`--chip-bg` = 0%），实色边框、外凸内边距与孤立的绿色图标只剩视觉噪音。其他主题与 markdown 围栏代码块 `.codeblock pre` 保持原样。
- 左栏分区高度拖动改用与右栏共享的 `panel-sash.ts` 纯函数（同一套权重换算与最小像素钳制）：修掉极端情况下（权重一大一小 + 面板被压得很矮）会算出 ≤0 权重、导致分区高度错乱的旧行为；拖动手感、双击复位与存档格式（`pi-web-ui:lp-sizes`）不变。

## [0.73.0] — 2026-09-10

### Added

- 运行对话强行关闭：左栏所有对话行（含选中/运行中）都有关闭 ✕；有子代理后代时点 ✕ 展开两个选项——仅关已结束的子代理 / 强行全关（`dismiss_conversation` 新增 `force` 参数：中止自身与全部子代理的运行再整体移出，active 对话自动让出；行右键菜单同步）。DSH 引擎 force 放行 active/终端限制（运行中仍需先停止）。
- 模型列表刷新改为官方目录整表替换：`server/patch-remote-catalog.ts` 在启动时幂等改写 SDK 的 `remote-catalog-provider`，内置服务商（opencode-go 等）在拿到 pi.dev 远程数据后**整表跟随官方目录**，不再与内置静态目录做并集（无旧模型残留、无「新增 N 个」噪音）。补丁失败自动跳过，回落 SDK 默认语义。
- 模型下拉显示模型 ID：顶栏与目标条的模型下拉在服务商名后补上 `provider/id` 的 id 部分，同名模型可区分。
- run-trace 插件：运行中对话的时间线自动跟随最新时刻（右侧留 40px 余量后向左滚动）。

### Fixed

- 问卷（`ask_user_question`）弹出时补上提示音与系统通知：之前只监听扩展 dialog 的 id，问卷出来静默无声。
- 问卷选项超长文本不再撑破弹窗：选项 label 由「单行省略号」改为自动换行，桌面端选项行可换行；选项内 markdown（表格/代码块/长链接）限制在容器内、超宽时内部横滚。
- run-trace 插件只在服务端 active 对话变化时跟随（含 state 漏推时的自愈）：手动查看历史对话不再被重复推送拽回当前对话。
- 子代理模板「系统提示词」输入框占位符按语言使用全角/半角冒号。
- 保存服务商时保留 models.json 中 UI 不认识的字段（#106，经 #108）：改为以磁盘旧条目为底合并，provider 级 `headers`/自定义键与模型级 `api`/`baseUrl`/`cost`/`compat`/`thinkingLevelMap` 不再被静默删除；表单字段语义不变（提供即写、清空即删）。
- 外部改动 models.json 后可手动重载（#107）：模型管理页新增「重新加载配置」按钮（`reload_models_config`，复用保存末尾的刷新路径），从磁盘重读并重推模型列表，无需重启服务；页面附带提示文案。
- 纯覆盖内置 provider 的条目也能「刷新」模型列表（#107）：`refreshProviderModels` 在条目缺 provider 级 `baseUrl` 时回退运行时已知地址（仅探测用，不写回磁盘，条目仍保持纯覆盖）。
- db-client（MySQL）防注入补强：`qMysql` 对库名/表名/列名做严格标识符白名单校验，非法标识符直接报错（与已合入的 `??` 标识符占位符传入改造配套）。

### Changed

- 中英文 README 重构：截图换成新的对话 / 终端 / 轨迹 / Git / 设置五张，旧图删除，安装与配置说明重排。
- 对话框内边距与粘性头（sticky）偏移微调。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（13）：`dismissFinishedSubagents`、`dismissFinishedSubagentsScoped`、`dismissConversationWithSubagents`、`dismissConversationWithSubagentsMixed`、`dismissStreamingConfirm`、`dismissFinishedOnly`、`dismissForceAll`、`forceDismissTitle`、`forceDismissConversation`、`forceDismissConfirm`、`noFinishedSubagents`、`reloadModelsConfig`、`reloadModelsHint`
- 服务端新增 key（1）：`subagents.wait.empty`

## [0.72.0] — 2026-09-09

### Added

- 模型报错自动重试次数设置（`retryMaxAttempts`，对话设置）：大模型 API 出错时按次数自动重试；次数用完本轮停止并标红，最后一轮红色报错旁有「重试」按钮（`retry_last`，协议 v15），手动再跑一轮；设为 0 则失败即停。面板值覆盖注入 SDK 默认（含子代理与会话重建）。
- 发布时翻译增量自动公示：`scripts/i18n-diff.mjs`（对比 base tag，统计前端 `zh/en` 与服务端 `pick` 新增/变更的 key）与 `scripts/release-notes.mjs`（拼 GitHub Release 说明，`### i18n` 现场生成；`npm run changelog:i18n` 自动维护本节）；打 tag 推送后 Action 自动创建/更新 Release。

### Fixed

- 多密钥按项目自愈：删除密钥时所有引用该密钥的项目跟随接管密钥（无剩余则解绑）；清空服务商密钥时清掉全部项目的残留引用；切换到不存在的密钥不再种下 stale 引用；切项目自动恢复改为静默 + 不存在即删引用，切项目不再刷屏报错。

### Changed

- 设置「消息显示」改名「对话」（中英 + 8 语言包同步）。

<!-- auto-i18n:start -->

### i18n

- 前端新增 key（4）：`modelRetryAttempts`、`modelRetryHint`、`retryNow`、`retryLastTip`
- 前端中文变更（1）：`settingsMessageDisplay`
- 前端英文变更（1）：`settingsMessageDisplay`

<!-- auto-i18n:end -->

## [0.71.0] — 2026-09-09

### Added

- 全屏壁纸与容器背景变量，新增半透明（translucent）/全透明（transparent）主题。
- 右侧文件列表加"复制名称 / 复制路径"按钮。

### Fixed

- CollapsedMessage：`button` 改 `div`，窄消息区 rail 避让仅桌面生效。

### Changed

- prettier 收尾：`web/src/i18n.tsx` 上游 drift 格式化（post-#102）。

## [0.70.0] — 2026-09-09

### Added

- 全局共享设置：服务端持久化 + 服务端 quick-phrases 种子、quick-seed 标记、动态 marker overlay。
- 输入框快捷短语改为服务端下发种子；超长 notice 自动换行。
- 聊天壁纸设置基础（issue #100，含主题 cyberpunk 壁纸变量与 `wallpaper-settings` 单测；全屏壁纸与容器背景变量见 0.71.0）。
- 终端"运行中"列表只统计存活 PTY（countLive）。

### Fixed

- 语言包 slot 语法与换行转义；条件分支预渲染 segments。

### i18n

- 葡萄牙语 serverStrings 163 条翻译 + 文案润色。

### Changed

- 面板按钮对比度、主题英文名、思考/工具头重排。

## [0.69.0] — 2026-09-08

### Added

- 目标模式总开关：关闭时隐藏目标条，阻断向导与审查。
- `PI_WEB_TABS`（实例提供哪些 tab）与 `PI_WEB_MANAGED`（外部更新的实例）及文档。
- 首次访问语言跟随浏览器，而非固定默认。

### Fixed

- 用户气泡保留单个换行；快捷短语输入后重新聚焦。
- 子代理归属其所属会话（issue #95）。
- E2E 明确上报 zh locale；terminal-smoke 与终端工具默认关对齐。

### Changed

- pt-BR 文案润色；`index.mjs` 参数化查询（#97）。

## [0.68.2] — 2026-09-08

### Added

- 意大利语（it） locale；可下载语言包（核心只带 zh/en）。
- 标准 pi 引擎接入 `ask_user_question` 问卷。
- 文本块与思考块复制按钮。

### Fixed

- 网页终端里 vim 无法输入（提高 Vite 构建 target）。
- Android/Termux 死锁：服务端热路径消除全部 fork。
- pt-BR 字符串润色（markers 描述 + locale 列表报错）。

## [0.68.1] — 2026-09-07

### Added

- 运行轨迹时间线插件：`host.onRunEvent` 轨迹事件通道、harness 式轨迹分析 v2、vis-timeline 专业引擎（vendor 自带）、工具按名着色 + 图例、自绘即时悬浮层。
- 浏览器标题显示项目名。

### Fixed

- webmail：secret 存储失败时不再丢密码。
- 宽屏消息列/输入列按实测滚动条宽精确对齐；重试提示条幅与消息正文列同宽；goalbar 对齐。

## [0.68.0] — 2026-09-07

### Added

- 输入框快捷短语：一键发送 + 设置页管理。

## [0.67.0] — 2026-09-07

### Added

- 系统提示词模板组合（system prompt template composition）+ `edit_soft` 宽松编辑工具。

## [0.66.0] — 2026-09-07

### Added

- Termux（Android）安装指南。
- Mermaid 图表跟随当前主题。

### Fixed

- 同步 pi CLI 探测改为异步后台探测（解决死锁，#79）。
- Mermaid 主题同步与排版规整。

## [0.65.0] — 2026-09-06

### Added

- 插件市场 + fenced-code 渲染插件（mermaid 插件化）。
- 超宽屏聊天列开关。

## [0.64.8] — 2026-09-06

### Fixed

- 后台服务列表过滤桌面软件噪音进程。

## [0.64.7] — 2026-09-06

### Added

- 子代理父子链接树、保留与干净 rpc 绑定。

## [0.64.6] — 2026-09-06

### Added

- 子代理：错误透出、模型选择、`wait-for-all` 工具。

## [0.64.5] — 2026-09-06

### Fixed

- 重启浏览器恢复上次工作目录。
- 目录消失时列表/会话刷新不再崩溃（issue #74）。

## [0.64.4] — 2026-09-06

### Added

- 设置 → 显示：mermaid 图表渲染开关。

### Fixed

- 历史/最近项目遵循 `PI_CODING_AGENT_SESSION_DIR`。

## [0.64.3] — 2026-09-05

### Added

- `pi-web-ui --help` 中英双语（按 LANG 检测，#72）。

## [0.64.2] — 2026-09-05

### Added

- mermaid 代码块渲染为图表。
- 机器浏览模式：`@root` 机器根 + 绝对 wire 路径跨盘符浏览。

### Fixed

- `PI_WEB_TOKEN` 改口令后 cookie 自动刷新/过期，一次 `?token=` 即恢复（issue #71）。
- mermaid 原生 SVG 尺寸、流式路径渲染、取消渲染清理；宽图表可读宽度保持。

## [0.64.1] — 2026-09-05

### Added

- 33 条 notice 的英文 textEn、locale 实时退出横幅与页面标题。

### Fixed

- 移动端发送按钮盖过思考强度底弹层（#70）。
- Windows 下 stale-marker 单测时间戳（pre-1970 mtime 回绕到 2106）。

## [0.64.0] — 2026-09-04

### Added

- 全局提示词历史、目录选择器（含新建文件夹）与 UI 抛光。

## [0.63.4] — 2026-09-04

- 版本重发（随带 `rename` 内置 marker 一行修正），无功能变更。

## [0.63.3] — 2026-09-04

### Added

- PWA 支持与移动端键盘回车换行（#64）；会话结束/需输入时桌面通知（#65）；PWA 资源与通知图标子路径感知（nginx `/pi/` 部署）。
- 历史对话与终端标签 UI 重命名（#63）；`/name` 命令重命名当前会话（#66）。
- 行内 marker 系统：todo/svc/notify/rename，无需工具往返。

### Fixed

- SCM 提交遵循暂存区，并新增"提交全部"。

## [0.63.2] — 2026-09-03

### Fixed

- 主题名跟随界面语言（英文用 nameEn，#61）。
- terminal-smoke 改轮询 shell banner，消除慢 CI 机器抖动。

## [0.63.1] — 2026-09-03

### Fixed

- 左侧栏折叠区块统一样式：折叠后三标题一致、切换不位移、收起按钮垂直居中、标题高亮通栏居中。

## [0.63.0] — 2026-09-03

### Added

- 子代理模板：角色系统提示词（append/replace）+ 技能/扩展白名单，AI 可选用、可停用，内置 6 个默认模板。
- 对话可从运行列表移出（dismiss_conversation）+ pi-subagents 存活检测（WIP）。

### Changed

- 全仓库 prettier（Tab/120）与 oxlint 接入 CI（#57/#58）。
- DSH notice、终端退出横幅、目标状态跟随界面语言（#54 及后续）。

### Fixed

- 插件目录搬迁后坏掉的冒烟测试 fixture（#59）。

## [0.62.1] — 2026-09-03

### Fixed

- SCM 的 `git add/reset` 路径引号闭合（issue #51）。

## [0.62.0] — 2026-09-02

### Added

- 排队消息可删除（✕）；底部栏实时缓存命中率与生成速率。

### Fixed

- `terminal_create` 带 title 下发，服务端不再用中文默认覆盖。

## [0.61.0] — 2026-09-02

### Added

- 内置服务商多密钥管理 + 项目级模型/key 记忆。

## 更早版本

0.62 之前的版本没有逐版归档，以下是发布提交记录中的要点（详见 `git log`）：

- 0.60.0（2026-09-02）：移除 `PORT` 环境变量兼容，仅保留 `PI_WEB_PORT`；修复 `--host` 直启失效。
- 0.59.0（2026-09-01）、0.58.0（2026-08-30）。
- 0.56.1 / 0.55.0 / 0.53.0 / 0.51.0（2026-08-30）。
- 0.50.0 / 0.49.0（2026-08-29）：0.49.0 起移除 Electron 桌面壳，只保留纯 Web。
- 0.48.3 / 0.48.2（2026-08-29）：pi SDK 升到 `^0.84.4`。
- 0.44.1（2026-08-28）。
- 0.35.1（2026-08-27）：编辑重问保留附件（#18）+ 全窗口拖放（#19）。
- 0.29.0（2026-08-23）：全局搜索弹窗（Ctrl+K）+ 消息列表惰性窗口化。

[Unreleased]: https://github.com/xing-shuyin/pi-web-ui/compare/v0.101.0...main
[0.103.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.103.1
[0.103.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.103.0
[0.102.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.102.0
[0.101.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.101.0
[0.100.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.100.0
[0.99.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.99.0
[0.98.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.98.0
[0.97.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.97.0
[0.96.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.96.1
[0.96.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.96.0
[0.95.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.95.0
[0.94.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.94.1
[0.94.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.94.0
[0.93.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.93.0
[0.92.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.92.0
[0.91.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.91.0
[0.90.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.90.1
[0.90.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.90.0
[0.89.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.89.0
[0.88.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.88.0
[0.87.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.87.2
[0.87.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.87.1
[0.87.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.87.0
[0.86.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.86.2
[0.86.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.86.1
[0.86.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.86.0
[0.84.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.84.0
[0.83.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.83.0
[0.80.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.80.1
[0.80.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.80.0
[0.79.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.79.0
[0.78.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.78.0
[0.77.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.77.0
[0.76.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.76.0
[0.75.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.75.0
[0.74.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.74.0
[0.73.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.73.0
[0.72.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.72.0
[0.71.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.71.0
[0.70.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.70.0
[0.69.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.69.0
[0.68.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.68.2
[0.68.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.68.1
[0.68.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.68.0
[0.67.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.67.0
[0.66.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.66.0
[0.65.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.65.0
[0.64.8]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.8
[0.64.7]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.7
[0.64.6]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.6
[0.64.5]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.5
[0.64.4]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.4
[0.64.3]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.3
[0.64.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.2
[0.64.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.1
[0.64.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.64.0
[0.63.4]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.4
[0.63.3]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.3
[0.63.2]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.2
[0.63.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.1
[0.63.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.63.0
[0.62.1]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.62.1
[0.62.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.62.0
[0.61.0]: https://github.com/xing-shuyin/pi-web-ui/releases/tag/v0.61.0
