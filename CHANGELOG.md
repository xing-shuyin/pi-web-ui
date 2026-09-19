# Changelog

> 面向使用者的版本变更记录：升级前先看这里，再决定是否升级。
> 版本号规则：npm 上的版本不带 `v` 前缀（如 `0.70.0`），GitHub 的 tag / Release 带 `v` 前缀（如 `v0.70.0`），两者数字部分一一对应。
> 日期为 npm 发布时间（UTC+8 换算后的日历日）。

格式说明：`Added` 新增功能、`Fixed` 修复、`Changed` 行为/样式变更、`i18n` 多语言相关。
每个版本的内容按"实际合入该版本发布的提交"归档（以 `package.json` 的 version 变更提交为准），
而不是按提交日期聚类——连续快速发布的 patch 版本以此为准最准确。

## [Unreleased]

## [0.91.0] — 2026-09-19

### Added

- **SCM 提交树过滤 + 提交信息历史** —— 提交树列表头新增过滤框：按主题 / 作者 / hash / 分支·标签实时过滤（空格分隔多关键字 AND 语义，计数徽标显示「命中/总数」，切工作区自动重置）；提交输入框支持 ↑/↓ 回溯最近用过的提交信息（shell 风格：↑ 记住当前草稿并翻回历史，↓ 逐级退回，localStorage 存最近 20 条，去重置顶、隐私模式静默降级）。纯前端零协议改动；过滤与回溯的纯函数带单测（`scm-history-filter` / `scm-commit-history`）。
- **SCM「AI 生成提交信息」**（#233）—— 源代码管理面板提交输入行新增「AI 生成」按钮：服务端采集当前改动（有暂存按暂存 diff，否则全部改动含未跟踪，附近期提交主题作风格参考），用当前对话模型一次性补全（`completeSimple`，同视觉桥通路，不进对话上下文、不打断流式），生成的一行提交信息直接填入输入框。提示词可在设置「提示词」页追加/替换（`scmCommitMsgPrompt*`，不进设置预设）；60s 超时、任何失败恰好应答一次（ok:false + 可读错误，按钮不卡死）；生成语言跟随仓库近期提交。协议 v18（`scm_commitmsg` / `scm_data.kind:"commitmsg"`）；DSH 引擎无此能力，入口报错兜底。回归：`scm-features-test`（无凭据零 token 路径）。
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

[Unreleased]: https://github.com/xing-shuyin/pi-web-ui/compare/v0.91.0...main
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
