# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) | **简体中文**

[![npm 版本](https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-web-ui)
[![Node.js](https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white)](https://nodejs.org/)
[![许可证](https://img.shields.io/github/license/xing-shuyin/pi-web-ui)](LICENSE)

> 一个精致的 pi 浏览器界面：流式对话、查看工具调用、管理文件，
> 在一个工作台里完成开发任务。

[pi 编码智能体](https://pi.dev) 的 Web 聊天界面 —— 智能体通过 pi SDK 在服务端进程内运行，
事件经 WebSocket 流式推送到浏览器。支持思考块与工具调用、附件与图片问答、内置终端、
模型管理，以及设置面板（自定义系统提示词、技能/插件开关、设置预设一键应用）等功能。
需要 Node.js ≥ 22.19 及配置好的 pi 环境。

## 作者的其他项目

> **正在使用 DSH 构建工具？**
>
> [**dsh-ui-tools**](https://github.com/xing-shuyin/dsh-ui-tools) 是作者的配套项目，
> 用于在 DSH 生态中构建和扩展 UI 工具。

## 功能特性

**对话**

- WebSocket 流式聊天 —— pi SDK 在服务端进程内运行，事件以快照（60ms 节流）推送，浏览器按快照渲染。
- 思考块、工具调用卡片、bash 输出，实时显示状态（执行中 → 已结束 · 等模型 · 耗时）。
- **补充（steer）** —— 回复流式中可排队发送跟进消息，当前回合工具结算后立即注入（对应 pi CLI 的 Enter 打断语义）。
- **斜杠命令** —— 输入 `/` 弹出命令选择器（内置 / 扩展 / 模板 / 技能）；内置 `/new /model /compact /cwd /thinking /resume`，另有 `/help`（命令清单）与 `/copy`（复制上一条回复）。`/new` 可带首条提示（`/new 修一下失败的测试`），会作为新对话的第一条消息发出去。
- **每项目多对话并发** —— 每个对话独立 agent runtime，切走后仍在后台运行；「运行的对话」列表显示流式进度，可随时切回。
- **编辑重问** —— 把任意历史问题 fork 成新分支重新提问，原对话不受影响。
- 超过 30 条的消息自动折叠为摘要行（惰性渲染，点击展开）。
- 问题导航 —— 右侧浮动导航条 + 每个问题顶部的序号标签，一键跳转。
- **提示词模板** —— 空对话状态展示一键模板库（仓库初始化、代码审查、调研、合并冲突……）；点卡片即填入输入框，也可把当前草稿存成自己的模板。
- **模型报错自动重试** —— 按对话可配置重试次数（默认 6，`0` = 失败即停）；次数用完则失败轮次标红，红色报错旁有一键「重试」按钮。
- **排队可控** —— 排队/插队的气泡可以 ✕ 移除，也可以 ↩ **撤回**：文字落回输入框（输入框非空时另起一行追加，绝不覆盖正在打的字）。
- **消息自带信息** —— 每条消息头部显示角色、产出它的模型和本地 `HH:MM` 时间，每段文本都有复制按钮。附件渲染为独立可折叠卡片（模式徽章 `lines`/`ref`/`bridged`/`inline n lines` + 复制按钮 + 视觉桥「已转写」说明），技能调用渲染为技能卡（展开可见完整 `SKILL.md`），你输入的参数单独成气泡。
- **压缩看得见** —— 上下文压缩显示为一张卡片（「已压缩 N tokens」），到货时自动展开并跳转；压缩进行中横幅实时计数（「正在压缩 · 12s」）并标明触发原因（手动 / 阈值 / 溢出）。

**项目与会话**

- **切换项目** —— 工作区根目录（agent 读写的位置、终端启动位置）随时可切，不用重启：
  - **右下角状态栏的路径** —— 点 `📁 <路径>` 打开目录选择器：`Tab` 补全、`↑` 回上级、`💻` 跳到「电脑」根以便换盘符、点文件夹进入后按「选择」，或直接「选择当前目录」；「＋ 新建文件夹」可当场建目录，`Esc` 或点击别处关闭。
  - **右侧文件树** —— 在任意文件夹上点右键 →「以项目打开」（同一菜单里还有「上传文件到此文件夹」）。
  - **左栏「最近项目」**，或输入框里 `/cwd <路径>`（只输 `/cwd` 显示当前目录）。
  - 启动默认工作目录来自 `--cwd <dir>` / `PI_WEB_CWD`。
- **对话并行** —— 每个对话独立 agent runtime，切走后仍在后台流式；每项目最多同时 8 个（子代理不计入）。
- **「运行的对话」列表** —— 按项目分组（当前项目置顶），子代理缩进挂在父对话下，带子代理 / 报错（悬停看原因）/ 流式徽标；✎ 行内改名；✕ 可选「仅关已结束的子代理」或「强行全关」（运行中会二次确认）；右键某行只作用于该对话的子代理子树。
- **历史会话** —— 读的是 `<agentDir>/sessions/--<cwd>--/`，也就是 pi CLI/TUI 写的同一份转录：浏览器和终端里的 `pi` 共用每个项目的一份列表。支持 ✎ 行内重命名（写入的 `session_info` 与 pi 的 `/name` 同机制）与两步确认删除。
- **最近项目** —— 本浏览器的记录 ∪ 所有有转录的目录，去掉你删过的（墓碑）和不存在的路径，按最近使用排序（显示 20 条，最多存 30）。
- **回到现场** —— 重连会恢复上次用的工作目录（并提示落在哪），标签标题可显示当前项目名，每个项目记住自己的「模型 + 该服务商当前密钥」用于**新建**对话（已有内容的对话不被覆盖）。
- 上次关服时仍在回答的对话，会在下次连接时一次性提示「上次运行被打断」，而不是历史里凭空少一段。

**搜索与导航**

- **全局搜索（Ctrl/Cmd+K）** —— 一个输入框搜三处：对话转录全文（含助手输出，最多 50 条、每条带跳转锚点）、最近项目、工作区文件名（受限遍历：50 条结果 / 2 万条目 / 4 秒 / 深度 24，触顶时会明确提示而不是卡住）。`↑`/`↓` + `Enter` 打开、`Esc` 关闭；点对话＝恢复并跳到命中消息，点项目＝切工作区并重搜，点文件＝打开预览。
- **会话内搜索（Ctrl/Cmd+F）** —— 搜当前对话**实际渲染出来的文本**（大小写不敏感，走 CSS Custom Highlight API 高亮），`Enter` 下一个、`Shift+Enter` 上一个、`Esc` 关闭。被折叠的旧消息用消息数据建索引，所以长会话仍可搜——只有你跳到的那一条才会展开。
- **长会话体验** —— 超过 30 条的消息折叠成摘要行（含思考/工具/bash/图片计数与 90 字预览）；问题导航条列出问过的每个问题；上滚后浮出「回到底部」；只有贴底时才自动跟随输出（你主动上滚就不会被拽回）；远离视口的消息替换为等高占位。

**子代理与模板**

- **第一方子代理** —— 后台派发独立对话并行做调研 / 实现 / 审查（`subagent_spawn`）；与普通对话一样在左栏管理：实时查看输出、补充（steer）、中止、移出。内存会话——不进历史 / resume 列表，可嵌套派发。
- **子代理模板** —— 设置面板「子代理模板」里配置可复用预设：角色系统提示词（追加或整体替换）+ 技能/扩展白名单。AI 用 `subagent_templates` 工具查询清单、`subagent_spawn(template="…")` 选用，也可以不传模板按主会话默认配置运行。停用的模板保留在面板可随时重新启用，但对 AI 工具不可见（查不到、不能选）。模板全局共享（`<dataDir>/subagent-templates.json`，所有浏览器客户端一致）。首次运行自带 6 个内置模板（review / implement / research / scout / audit / delegate，改编自 pi-subagents 社区项目），面板标「默认」徽标，可像普通模板一样修改或删除。

**文件、图片与附件**

- 三种附件模式：`inline`（≤12KB 内联）、`reference`（仅路径引用）、`lines`（选中行），超限自动降级。
- 粘贴 / 拖拽 / 上传图片 —— 浏览器端自动缩放，模型支持识图时作为图片内容发送（不支持时提示警告）。
- **视觉桥** —— 当前模型不支持识图时，把图片交给自动发现的视觉模型转写成文字证据（按批次缓存，可在设置里指定模型/开关）。
- 免工作区路径附加任意文件 —— 存入全局上传目录，小文件内联，其余以绝对路径引用。
- 文件预览 —— 行号、点选/拖拽/Shift 选区（可添加到对话为 lines 附件）、GBK 回退解码、二进制十六进制视图、媒体 HTTP 预览（支持 Range）、下载按钮。
- 实时文件树 —— 服务端对当前列出目录 fs.watch，改动即静默重列；超大目录显示截断提示。
- **能浏览到工作区之外** —— 文件树可以越过工作区根到 💻「此电脑」层，列出所有盘符（POSIX 下是 `/`）；面包屑可直接跳到任意层级，`..` 回上级；目录被删/改名/无权限时降级为空列表 + 提示，而不是报错页。
- **行内操作** —— 悬停文件：下载 / 内联附件（＋）/ 引用附件（🔗）/ 复制名称 / 复制路径；悬停文件夹：引用附件、复制名称、复制路径（纯 HTTP 环境下剪贴板不可用时自动走兜底实现）。
- **从文件树上传** —— 右键**文件夹行** →「上传文件到此文件夹」（同一菜单里还有「以项目打开」）；右键文件行或面板空白 →「上传文件到当前目录」（你正在浏览的那一层）。把系统文件拖到文件夹行上就上传到那一个文件夹（该行高亮），拖到面板则上传到当前目录；拖入的是**文件夹**会明确提示不支持，而不是静默没反应。单文件上限 100MB，空文件会被拒绝，文件名只取 basename 并替换 Windows 非法字符（限 200 字），目标目录不存在会自动创建，上传完成后列表会刷新——哪怕你当时正浏览别的地方。
- **列表状态的边界** —— Windows/macOS 用工作区根的递归监听，**任何**子目录的改动都会刷新（400ms 防抖）；不支持监听的网络盘回退为 10 秒轮询（每个工作区只提示一次）；POSIX 隐藏构建噪声（`node_modules`、`.git`、`dist`、`.venv` ……）且最多 500 条，Windows 只隐藏依赖/VCS/数据目录且最多 2000 条，两者被截断时都会明说。
- **预览也是编辑器** —— 文本文件可直接改并用 Ctrl/Cmd+S 保存（限 2MB、未改动时保存置灰、带未保存改动关闭会先确认）；Markdown 可切渲染/原文；HTML 在沙箱 iframe 里渲染，走目录映射 URL 让相对 CSS/图片正常加载（「启用脚本」是逐文件开关，且永不开同源）；图片/视频走 HTTP Range 流式；二进制给十六进制视图；文本支持行号、点选/拖拽/Shift 选区（作为 `lines` 附件添加）、50–200% 缩放、自动换行开关与全屏。
- **下载不跟安全浏览打架** —— 先取字节再用浏览器的保存框存档（不支持时回退 blob 链接，超 200MB 走原生下载），Windows 非法文件名自动改写，取消保存框不算错误。

**终端与 Git**

- 内置终端（xterm.js + node-pty），每客户端独立 PTY 管理；Windows 优先 Git Bash，回退到随包下载的 busybox，再回退 `cmd`。同时最多 16 个在线终端（agent 自己开的不计入），每个标签切换时保留自己的 8000 行回滚；标签可行内重命名、可关闭（真杀进程），退出码会写进回滚。
- **常用命令列表** —— 终端侧栏上半是当前项目的 `.pi/commands.json` 列表（`name` + `command` + `cwd`，`${pwd}` 展开为工作区）：点一行即运行（同名标签复用并重启，类 VSCode task），可增删改，也能从磁盘重读文件。
- **AI bash 分组** —— agent 通过终端接管开的终端收进可折叠的「AI bash」分组，不会淹没你自己的标签。
- **终端接管 bash**（设置 → 工具，默认关）—— 开启后 agent 的 `bash` 工具在可见的常驻终端里跑，而不是隐藏进程，因此 `cd`/venv/ssh 等 shell 状态能跨调用保留；静默阈值（默认 15 秒，`0` = 一直等）决定何时把安静的命令转后台，`head`/`tail` 控制模型要读的行数。
- **活力检测** —— agent 用过的终端在对话仍流式时长时间没输出，服务端会把尾部输出作为 steer 推给 AI（「去读/回答/关掉它」），而不是干等。
- **源代码管理（Git）面板** —— 经隐藏查询终端展示 status / branch / diff / 历史 / 未跟踪文件，另有逐文件暂存（＋）与取消暂存（－）、提交框（Enter 提交、兼容输入法）与「全部提交」（`git add -A && git commit`）、本地/远程跟踪分支分组的切换器（选远程分支会在本地建跟踪分支）、分离 HEAD 与 `↑领先 ↓落后` 徽标。「提交树」页加载 `git log --graph` 并可看每个提交的完整 diff。写操作（提交 / 切分支 / 推送 / 拉取）都在可见终端里跑并自动切到终端视图；仓库真实 git 目录变动时（含 worktree）以及 30 秒轮询兜底都会自动刷新，因此在浏览器之外提交也能自己出现在面板里。

**模型与设置**

- 模型管理 —— UI 里编辑 models.json、按 provider 设置 API key（密钥/headers 永不下发浏览器）。
  - **模型选择器** —— 可按名称/provider/id 搜索，多个服务商时左侧有服务商栏；你常用的模型自动置顶并标「用过 N 次」，另带推理/视觉徽标；打开时滚到当前模型，底栏固定「刷新模型 / 管理模型」。
  - **一个服务商多把密钥** —— 内置服务商可存多个命名密钥（`<agentDir>/provider-keys.json`）：加第二把不会丢掉第一把，可按名激活/删除（删掉当前活跃的会自动提升下一把）。选择器按密钥分组列出，点某把密钥下的模型即切过去；浏览器只拿到密钥昵称。
  - **自定义服务商** —— 可增删改（API 类型、`baseUrl`、密钥、可选鉴权头）并逐模型配置上下文窗口/最大输出/文本或图片/推理；**抓取模型**在**服务端**探测 `/models`（所以局域网/回环地址不受 CORS 限制）并合并结果，已保存的服务商也能重新探测。手改过的 `models.json` 用「重新加载 models.json」拉进来（允许注释，与 SDK 一致）。
- 思考强度（thinking level）按模型切换 —— 共七档，模型不支持的档位置灰，而不是静默换到别的档。
- 首次配置引导 —— 没装 pi CLI 时可直接一键安装（失败有详情、可重试/跳过），然后选服务商 + 填密钥就能开用。
- 设置面板：
  - **系统提示词** —— 11 个来源（soul / tools / guidelines / pi 文档 / append / persona / terminal / markers / context / skills / cwd）拼成的 `{{token}}` 组合模板，点 token 芯片即可追加；每个来源可单独覆盖（`auto` 徽标、「以默认为底改写」、单独恢复默认，环境类来源保持只读）；另有两个查看器分别展示**实际生效的完整提示词**与**真正发给模型的工具 schema**。
  - **输入历史与快捷短语** —— 历史有上限（1–500 条，可选单条字数上限，两步确认清空），用 `↑`/`↓` 在光标位于草稿首/末**视觉行**时翻（自动折行的行也算）；输入框上方的快捷短语可逐条编辑/上下移/删除/恢复默认。
  - **技能** —— 逐个启停，另有「全文」芯片把整个 `SKILL.md` 注入提示词（单文件 8KB、总量 32KB）。
  - **扩展** —— 逐个启停，`npm:` 装的可在可见终端里一键卸载（`pi remove npm:<包名>`）。
  - **界面插件 / 目标审查 / 视觉桥 / 子代理模板** 各有自己的页，见 [界面插件](#界面插件)。
  - **预设** —— 把当前组合（提示词模板/模式/覆盖、技能与扩展开关、工具开关、终端接管、重试次数、审查提示词、技能全文名单）存成命名预设，随时应用或删除；有意**不**包含（问卷、目标模式、显示偏好、视觉桥、默认子代理模型、快捷短语），应用预设后它们保持原值。
  - **生效时机** —— 工具开关、重试次数、显示偏好、标记与技能全文名单即时生效；提示词模板/覆盖与技能扩展开关需重载会话，回答中改的会延后到「本回复结束后生效」（有提示）。
  - **显示偏好** —— 思考块默认展开或折叠、工具卡默认展开、宽屏聊天列（宽屏下取消 860px 上限）、标签标题显示项目名、聊天壁纸（地址或上传，带压暗/模糊滑杆）。
- 主题切换 —— 顶栏选择主题；主题是纯 `:root` 调色板覆盖（布局唯一在 styles.css）。如何添加自定义主题或向仓库贡献主题，见 [主题](#主题)。

**代理工具与内联标记**

- **工具开关** —— 设置 →「工具」把所有可选工具逐个列出：7 个终端工具（默认**关**）、7 个 `subagent_*` 工具（默认开）、`edit_soft`（默认关）、`delegate_task`/`ask_user_question`/`todo_list`（默认开）。开关即时生效、不重启，工具只是被禁用仍保留注册以便随时开回；`bash` 与 SDK 自带的 `edit`/`read` 有意不可关。
- **内联标记** —— 状态改变不需要工具往返，AI 直接把标记写进回复：任务列表用 `[[todo:new:<主题>]]` / `[[todo:set:<id>,in_progress]]` / `[[todo:remove:<id>]]` / `[[todo:dep:<id>,blocks=<id>]]`，不打断的提醒用 `[[notify:<级别>:<内容>]]`，改对话标题用 `[[conv:rename:<标题>]]`。气泡定稿即执行，标记写错会以浏览器提示回显；任务列表同时以常驻 widget 显示在右栏文件树下方（`N/M done` + ✓/◐/○），跟随当前对话，且因为存在该对话自己的会话分支里，刷新后仍在。设置 →「工具」另有总开关与逐标记开关（这两项全局共享）。
- **`edit_soft`** —— 更宽松的 `edit`（默认关）：缩进/空白导致内置工具失败时用它，先精确子串、再按去空白逐行核心匹配，`newText` 原样写入并保留文件换行符/BOM，结果带 diff 与 unified patch。
- **`delegate_task`** —— 强制六段派单（TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT）并在服务端校验：模板不可用、任务少于 20 字或任一段为空都会被打回，并把可用模板清单回给模型。卡片按六段结构化展示，跑完后可一键跳到对应子代理对话。
- **`ask_user_question`** —— pi 引擎本身没有问卷工具，这是 pi-web-ui 加的：模型可以问结构化问题（单选/多选 + 富文本选项预览 + 自由文本），以对话框弹出；回答作为工具结果回给模型，取消则以工具错误返回，等你回答的时间不受工具看门狗限制，未答的问卷刷新/重连后会恢复。
- **MCP 服务器** —— 放一份 `<dataDir>/mcp.json`（`{"servers":{"github":{"command":"node","args":["mcp.js"],"cwd":"/x"}}}`），该 stdio MCP 服务器声明的工具就会作为普通工具交给 AI（服务端执行）；某一个起不来只记一行日志，不影响其他。文件在启动时读取，改完需重启 pi-web-ui。
- **扩展 UI 桥** —— pi 扩展可以驱动浏览器：`setWidget` 在文件树下方渲染实时面板（点标题居中放大），`setStatus` 在底栏显示状态文本，`notify` 弹通知，`select`/`confirm`/`input` 在输入框上方弹出非模态请求面板（选项走 Markdown 渲染，`Esc` 当作取消）；widget 文本里的 ANSI 色码会被剥掉，不会把扩展底栏变成转义序列噪声。
- **插件能力** —— 插件可注册 `/命令`（选择器标 plugin 来源、服务端执行不耗 token）、注册带停止按钮的后台任务、声明设置表单、订阅运行/工具/对话事件，并在前端经 `window.__piWebUiHost` 切视图、新建对话。详见 [界面插件](#界面插件)。

**声音与通知**

- **声音提醒** —— 总开关 + 四个事件各自开关（提问 / 完成 / 开始 / 报错），每个都带试听按钮，另有音量滑杆（0–100%）。
- **桌面 / 系统通知** —— 默认关；开启时在点击处申请浏览器权限，被拒则自动关回（并记住）。通知经 Service Worker 发出，所以装成 PWA 后后台也能收到，覆盖「完成 / 提问 / 报错」，点通知会把应用窗口拉到前台。你明显正在看页面时不会打扰——包括 Windows 上浏览器仍声称有焦点/可见但窗口已最小化的情况（改用原生窗口矩形判定）。

**PWA 与离线**

- **可安装** —— 带 web app manifest（独立窗口、192/512/1024 + maskable 图标、`./` 相对路径所以子路径部署也能装），Chrome/Edge 的「安装应用」或手机「添加到主屏幕」即可得到独立窗口与图标。
- **离线应用壳** —— Service Worker 对导航请求走网络优先 + 缓存外壳兜底（后端宕机/重启时页面仍能打开），哈希静态资源缓存优先，而 `/ws`、`/api`、`/themes`、`/plugins` 永不缓存；新 worker 会立即接管已打开的页面。
- **该提醒时才提醒** —— 页面加载的构建与服务端 wire 协议不一致时（比如刚更新完）会固定显示刷新提示条；标签标题可显示当前项目文件夹。

**语言与语言包**

- 顶栏语言菜单按母语名列出所有语言，「获取更多语言」打开的管理器列出 8 个可下载语言包的版本与下载/移除按钮（另有刷新）；语言包落在 `<dataDir>/locales/`，所以也能手工放进去做完全离线的安装。
- 首次访问没有存过选择时，按浏览器语言 → 实例默认（`PI_WEB_LOCALE`）→ 英文的顺序决定；一旦你选过就一直跟着。
- 服务端面向模型/工具的文案也跟随同一语言（工具返回值、提示词段落、提醒），所以中文界面下 `subagent_list` 这类工具也返回中文。

**目标（Goal）模式**

- GoalBar 目标栏 —— 设置目标 + 审查模型 + 最大轮数 + 锁定开关。
- 目标调研向导（「AI 提炼」）—— 通过引导式问卷把原始需求收敛成明确目标。
- 自动审查循环 —— 每轮结束后用独立审查会话核对「目标 + 最终文本 + git diff HEAD」；不达标就把审查意见作为 steer 注入重改，直到通过或达到轮数上限。

**DeepSeek Harness（DSH）引擎**

- **引擎可切换** —— `PI_WEB_ENGINE=pi|dsh`（默认 `pi`）。pi 引擎在进程内跑 pi SDK；**DSH 引擎**把官方 [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh)（DeepSeek Harness）运行时作为子进程拉起。`/api/health` 返回 `engine`；底栏显示 DSH 徽标。
- **同一套 wire 协议** —— DSH 引擎实现与 pi 相同的 WebSocket 协议，目标/审查、SCM、后台任务、设置、插件、终端、message_delta 与快照全部一致。
- **原生目标机制** —— DSH 自己的目标状态机 + round-driver 自动续轮；完成/受阻由模型自判定（无独立审查会话）。目标向导经模型 `ask_user_question` 驱动。
- **真图片块** —— 图片作为真正的 image 内容发给支持视觉的 DeepSeek 模型（如 `deepseek-v4-flash-vision-exp`）；纯文本模型走文字转写桥。
- **提问对话框** —— 模型 `ask_user_question` 弹出浏览器对话框（单选/多选 + 自由文本），支持排队与倒计时。
- **工具 & MCP 桥** —— 插件 AI 工具与外部 MCP 服务器（`mcp.json`）都桥进 DSH 运行时，DSH 模型可直接调用（服务端执行）。
- **技能启停** —— 设置面板暴露 DSH 技能目录；禁用即运行时过滤该技能，模型不可见。
- **DSH 用户补丁** —— 在 `<dataDir>/dsh-patches/` 放 `.yml` Cordis 补丁扩展运行时，设置面板一键重扫生效；设置 →「插件」会列出补丁文件（大小/时间）与解析后的目录路径，坏文件跳过并把错误打到运行时的 stderr。

**DSH 与 pi 引擎的差异**（切换前值得知道）：

- 思考强度固定 `high`，改档会回答「DeepSeek V4 只支持高思考强度」。
- 底栏的 token/成本/上下文按 DeepSeek 官方每百万定价与 100 万窗口计算。
- 打开历史会话是只读回放：一发消息就会开**新分支**并把旧对话作为上下文注入（运行时不允许原地续聊）；编辑重问同理。
- **停止**会杀掉运行时进程树，所以所有进行中的 DSH 对话都会停（有提示），半成品目标会先清除；不支持只中止 bash 工具。
- 会话存在 `<dataDir>/dsh-sessions/`（与 pi 引擎的转录隔离），超过 `PI_WEB_DSH_SESSION_RETENTION_DAYS`（90）天自动清理；每项目最多同时 8 个对话；运行时崩溃按 1s/3s/9s 退避重启，60 秒内最多 2 次，超限就停下并提示你去查 API key 与 DSH 依赖。
- 工具跑在 `workspace-write` 沙箱里、审批为 never——你的「停止」按钮就是控制阀。问卷是逐题向导（带选项预览与倒计时）。
- pi 专属能力（会话重命名、`/compact`、`/reload`、扩展热重载、子代理模板、自定义服务商/多密钥、服务商模型探测、装 pi CLI、视觉桥、逐工具开关）都会给明确提示并被隐藏入口，而不是静默失败。

**后台任务**

- 后台任务面板 —— 在 bash 前后对比监听端口，检测 agent 启动的服务并列出端口 / pid / 名称 / 命令行（点命令行可展开全文）；可单独停止或全部关闭，顶栏按钮带实时数量徽标。
- 列表属于**浏览器客户端**而非对话：切项目、切对话、重连都不丢，服务端每 30 秒刷新一次并剔除已退出的进程。检测会排除已知桌面软件，以及父链回溯到 `explorer` 而不是服务进程的进程（所以你自己开的浏览器不会被当成「AI 启动的服务」）。
- 插件注册的任务带 🧩 标记与实时状态文本，走插件自己的停止回调（比如邮件轮询任务）。
- 工具看门狗 —— 单个工具调用超过 20 分钟自动中断会话（`PI_WEB_TOOL_TIMEOUT_MS`，问卷豁免）。
- **只停止 bash 命令** —— 中止运行中的 bash 工具而不打断对话。
- **失联警告** —— 流式运行完全没事件超过 3 分钟（`PI_WEB_STALL_NOTIFY_MS`，`0` = 关）会指名对话地提醒一句，但不自动中止。

**安全与运维**

- 默认只绑 loopback；局域网 / 容器需显式 `PI_WEB_HOST=0.0.0.0`。
- **口令鉴权** —— `PI_WEB_TOKEN` 可经 `Authorization: Bearer …`、`X-PI-Token: …`、`?token=…` 或 `pi_web_token` cookie 任一通过；`?token=` 链接一次登录、从地址栏抹除并把口令写入 cookie，每次授权请求都会刷新它，失效 cookie 在 401 时立即过期——所以改完口令后一次正确的 `?token=` 进入就永久恢复。`/api/health` 保持开放给探针。
- WebSocket Origin/Host 同权威校验 —— 跨源页面直接拒绝（403），`Origin: null`（`file://` 页面）一律拒绝，设了口令时凭据不对会在升级前就被 401；反代场景用 `PI_WEB_ALLOW_ORIGINS` 白名单。
- **Host 白名单** —— `PI_WEB_ALLOW_HOSTS=host1,host2` 在始终生效的同权威校验之上再加一层严格主机名白名单。
- **实例收窄** —— `PI_WEB_TABS=chat,terminal,git` 只开放这些标签页，未列出的标签页在**服务端**也会被拒绝（对应消息返回说明），`chat` 永不可关。`PI_WEB_MANAGED=1` 声明实例由外部部署管理：自更新、装 pi CLI、插件市场安装都会被服务端拒绝并给出原因，前端也隐藏这些入口（版本按钮变成纯标签）。
- **文件边界** —— 工作区相对路径的读写一律做 `..` 逃逸校验（工作区外的路径只能经显式绝对路径/机器浏览到达）；`/api/file` 内联只放行图片/视频/HTML，二进制不可能被 `<img>` 带走——其他类型必须走 `?download=1`（附件下载）。HTML 预览路由一律以 sandbox 下发。
- 本地控制 socket 提供 `server status|quiesce|unquiesce`（排空模式：拒绝新 prompt/编辑重问/会话恢复，DSH 下还会拒绝新客户端连接，存量跑完）。
- 凭据不下发浏览器 —— provider headers（可能含 Authorization）永不发送到前端，服务商 API key 只以昵称形式到达浏览器。
- 9 种界面语言（中英内置 + 8 个可下载语言包：德/西/法/意/日/韩/葡/俄），语言包可在顶栏菜单里装/卸（见上方「语言与语言包」）。
- **保留期** —— `uploads/` 里超过 `PI_WEB_UPLOAD_RETENTION_DAYS`（14 天，`0` = 不清理）的文件会在启动时与之后每 6 小时清理一次；DSH 会话有自己 90 天的清理。
- **运维看门狗**（工具超时、模型失联、终端活力）都可调，见 [环境变量调优](#环境变量调优)。

**部署与更新**

- 前台运行 / 全局 npm 安装 / Docker（见 [Docker](#docker)）/ macOS launchd / Linux systemd / Windows 登录自启（HKCU `Run` 键 + 无控制台启动器 + 崩溃看门狗）/ 桌面快捷方式（`server shortcut`）。
- `server install --print` 只打印将要写入的 launchd plist / systemd unit / Windows 启动器就退出，可在真正安装前先审阅。
- **更新面板** —— 版本按钮在有新版本时显示黄点，另有「N 个更新」徽标；「检查全部更新」会比对本体、全局安装的 pi 核心与 `<agentDir>/npm/package.json` 里声明的直接依赖，每行都能单独更新，另有「全部更新」与「重新检查」；命令在可见终端里跑（pi 扩展走 `pi update npm:<名字>`，这是唯一能更新 pi 真正加载的那份的命令；其余走 `npm i -g <名字>@latest`）。刚发布不足 30 分钟会提醒 npm 缓存元数据可能还没同步。被 launchd/systemd/Windows 看门狗托管的实例多一个「重启服务」按钮；前台运行的实例没有，因为没有东西会把它拉回来。
- **命令行更新插件** —— `pi-web-ui plugins --check-updates` 逐个对比插件记录的提交与远端 HEAD 并给出确切更新命令；每次 `install --force` 都会把旧版本快照到 `<dataDir>/plugin-backups/`（只留最近 3 份，拷贝失败自动回滚），所以 `pi-web-ui plugins --rollback <id>` 可以退回上一版。
- pi CLI 里还有 `/webui`（来自随包的 `extensions/webui.ts`）：`/webui` 从 8787 起挑第一个空闲端口拉起服务，`--port 9000`、`--cwd <路径>`、`--no-browser`、`status`、`stop` 分别控制它；每个 pi 会话一个子进程，会话关闭时回收，不留孤儿进程。

## 快捷键

| 按键                        | 作用                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Enter`                     | 发送。触屏设备上 `Enter` 改为换行，`Ctrl/Cmd+Enter` 才发送（Windows 触屏笔记本当作桌面）。                                             |
| `Shift+Enter`               | 输入框内换行。                                                                                                                         |
| `↑` / `↓`                   | 光标在首/末**视觉行**时翻全局输入历史（跨对话持久化；自动折行的行也算，一段长草稿按 `↑` 是逐行上移光标而不是切历史）；`Esc` 回到草稿。 |
| `Ctrl/Cmd+K`                | 全局搜索（对话 / 项目 / 工作区文件名）。                                                                                               |
| `Ctrl/Cmd+F`                | 搜当前对话 —— `Enter` 下一个命中，`Shift+Enter` 上一个，`Esc` 关闭。                                                                   |
| `/`                         | 打开斜杠命令选择器（`↑`/`↓` 选择、`Tab` 或 `Enter` 补全、`Esc` 关闭；输入空格则自动关闭）。                                            |
| `Ctrl/Cmd+S`                | 预览里编辑文件时保存。                                                                                                                 |
| `Ctrl/Cmd+A`                | 预览里全选行（光标不在文本框时）。                                                                                                     |
| `Ctrl/Cmd+Enter`            | 提交「编辑重问」编辑器。                                                                                                               |
| `Ctrl/Cmd+C` / `Ctrl/Cmd+V` | 终端里：有选中则复制（无选中时 `^C` 仍发给 shell）/ 原生粘贴。                                                                         |
| `Esc`                       | 关闭预览、对话框、命令选择器、问卷或扩展请求面板（预览有未保存改动时会先问）。                                                         |
| 拖放                        | 窗口任意位置拖入文件 = 附件到对话；拖到文件树 = 上传到那一个目录；不支持拖文件夹（展开后选文件）。                                     |

## 界面截图

![对话 + 提示词模板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/chat-prompts.jpeg)

_对话 + 提示词模板_

![运行轨迹时间线](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/trajectory.jpeg)

_运行轨迹时间线（run-trace 插件）_

![设置面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/settings.jpeg)

_设置面板_

![内置终端](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/terminal.jpeg)

_内置终端_

![Git 源代码管理面板](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/git.jpeg)

_Git 源代码管理面板_

## 安装

```bash
npm i -g pi-web-ui            # 全局安装（推荐）
npx pi-web-ui                 # 或免安装直接跑（拉取最新版，启动在 :8787）
npm i -g .                    # 或安装本地 checkout
```

**npm ≥ 12？** npm 12+ 默认阻止依赖安装脚本（会看到 `npm warn install-scripts … blocked` 警告）。
node-pty 是原生模块，需要放行其脚本（其余两个包只是 no-op/纯提示，一并放行可消除警告）：

```bash
npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```

### Termux（Android）

pi-web-ui 可以通过 [Termux](https://termux.dev) 在 Android 上运行，但原生依赖
`node-pty` 需要编译工具链，而且 Android 有几个值得注意的坑：

1. **先安装编译工具链** —— `node-pty` 需要 Python 和 C 工具链：

   ```bash
   pkg install python clang make binutils
   ```

2. **给 node-pty 构建指定一个占位 NDK 路径**。在 Android 上，gyp 会报
   `Undefined variable android_ndk_path`，除非该变量有定义：

   ```bash
   GYP_DEFINES="android_ndk_path=' '" npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
   ```

3. **如果安装后 `pi-web-ui` 无法执行**（Android 上 exec 位和/或 shebang 可能
   被破坏）：恢复它：

   ```bash
   chmod +x "$(command -v pi-web-ui)"
   sed -i 's/\r$//' "$(command -v pi-web-ui)"
   ```

4. **后台运行时加上 `--no-browser`**（没有桌面浏览器可以自动打开）：

   ```bash
   setsid nohup pi-web-ui --no-browser --cwd /path/to/workspace >~/pi-web.log 2>&1 &
   ```

   `setsid` 把服务器从启动它的 shell 的进程组中脱离，关闭 Termux 会话也不会
   带走服务器 —— 单靠 `nohup` 在父进程组被杀时是不够的。

启动时的 `[control] socket error: EACCES …/.pi-web/pi-web-ui.sock` 警告在
Android 上无害：`pi-web-ui server stop/restart` 无法通过 control socket 工作，
但 Web UI 本身不受影响。

## 启动

**前台启动**

```bash
pi-web-ui                                           # 前台，http://localhost:8787
```

**启动参数 & 环境变量** —— 每个设置既能用命令行的 `--flag` 传，也能用环境变量设（flag 优先）。
二者任选一种即可：

| 参数                 | 环境变量              | 默认          | 作用                                              |
| -------------------- | --------------------- | ------------- | ------------------------------------------------- |
| `--port <n>`         | `PI_WEB_PORT`         | `8787`        | HTTP 端口                                         |
| `--cwd <dir>`        | `PI_WEB_CWD`          | 当前目录      | 工作区根（读/写/终端）                            |
| `--data-dir <dir>`   | `PI_WEB_DATA_DIR`     | `~/.pi-web`   | 数据目录（界面状态/插件/上传/主题/语言包）        |
| `--engine <pi\|dsh>` | `PI_WEB_ENGINE`       | `pi`          | 智能体引擎；`--engine dsh` = DeepSeek Harness     |
| `--host <addr>`      | `PI_WEB_HOST`         | `127.0.0.1`   | 监听地址（`0.0.0.0` 供局域网/Docker）             |
| `--agent-dir <dir>`  | `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（auth.json、models.json、会话、技能） |
| `--no-browser`       | —                     | 关            | 启动但不自动打开浏览器                            |
| _仅环境变量_         | `PI_WEB_TOKEN`        | 空            | 可选共享鉴权口令                                  |
| _仅环境变量_         | `PI_WEB_DSH_*`        | —             | dsh 运行时、补丁与调试设置                        |

两者等价 —— 任选其一：

```bash
pi-web-ui --engine dsh --port 9000 --cwd /path/to/project
PI_WEB_ENGINE=dsh PI_WEB_PORT=9000 PI_WEB_CWD=/path/to/project pi-web-ui
```

若用 dsh 引擎，需先安装运行时（`npm i -g @deepseek-ai/dsh@0.1.1-rc.2`）并准备 DeepSeek API key
（读 `~/.pi/agent/auth.json`，在服务商/API key 面板设置）。

## 停止

- **前台**：在运行它的终端里按 `Ctrl+C`。
- **作为服务**：`pi-web-ui server stop`。**Linux 和 Windows** 上会保留开机自启（下次登录/开机会回来，直到 `server uninstall`）；**macOS** 上 `stop` 会卸载 launchd 代理，因此不再登录自启——用 `pi-web-ui server start` 恢复。

## 更新

```bash
npm i -g pi-web-ui@latest     # 升级到最新发布版本
pi-web-ui server restart      # 重启服务使新版本生效（前台运行则手动重启）
```

## 卸载

```bash
npm uninstall -g pi-web-ui
```

卸载**不会**删除你的聊天记录：历史面板里的转录存在 `<agentDir>/sessions/`（默认 `~/.pi/agent/sessions/`，按项目分子目录），其余状态（界面设置、最近项目、插件、上传、主题、语言包）存在 `<dataDir>`（默认 `~/.pi-web/`）。两者都能跨卸载/升级/重装保留，之后重跑 `pi-web-ui server install` 会重新读到（若要删除它们，先备份 `sessions/` 与 `plugins/` —— 卸载本身永不动这两处）。

## 作为系统服务（开机自启）

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project   # 安装 + 启动
pi-web-ui server status                     # 运行中？开机自启？
pi-web-ui server restart                    # 重启（应用配置/版本变更）
pi-web-ui server stop                       # 停止（开机自启保留）
pi-web-ui server start                      # 再次启动
pi-web-ui server uninstall                  # 彻底移除服务
pi-web-ui server shortcut                   # 桌面一键启动图标
pi-web-ui server quiesce                    # 排空：拒绝新的对话/消息，存量运行继续跑完
pi-web-ui server unquiesce                  # 解除排空，恢复接收新工作
```

`server status` 还会经本地控制 socket 显示实时状态（版本、PID、排空状态、
浏览器连接数、运行中对话数）——`quiesce`/`unquiesce` 也走同一个 socket。

- **macOS** → launchd 代理（无需 sudo），日志 `/tmp/pi-web-ui.log` / `.err`
- **Linux** → systemd unit（`systemctl enable --now`），日志 `journalctl -u pi-web-ui -f`
- **Windows** → 登录自启 Run 键（HKCU，无需管理员）+ wscript 无窗口启动器 + 10 秒崩溃看门狗（PID 写在 `%APPDATA%\pi-web-ui\`）

选项：`--port`（默认 8787）、`--cwd`（工作目录）、`--data-dir`（数据目录）、
`--engine <pi|dsh>`、`--host`、`--agent-dir`、`--name`（自定义服务名）、
`--print`（只打印将生成的配置，不安装）。重复执行 `server install`
并传入新选项即可重新生成配置并重启服务 —— 这就是修改已装服务端口/工作目录/引擎的方式。
`--engine` / `--host` / `--agent-dir` 会自动烘焙进服务；仅环境变量的（`PI_WEB_TOKEN`、
`PI_WEB_DSH_*`）需手动写进服务配置。见上方「启动参数 & 环境变量」表。

```bash
pi-web-ui server install --engine dsh --port 9000 --cwd /path/to/project
```

## Docker

镜像会构建前后端、保留 `node-pty` 需要的编译工具链、预装 DSH 运行时（所以 `PI_WEB_ENGINE=dsh` 无需额外步骤）、以非 root 的 `node` 用户运行，并声明 `/app/.pi-web` 为数据卷：

```bash
docker compose up -d          # 然后打开 http://localhost:8787
```

`docker-compose.yml` 已设好容器必需的 `PI_WEB_HOST=0.0.0.0`（端口映射的前提），并用命名卷 `pi-web-data` 持久化数据目录。文件里注释掉的块覆盖常见容器调整 —— 切 DSH 引擎、挂 `dsh-patches` 目录、把项目挂为 `PI_WEB_CWD`、把 `~/.pi/agent` 只读挂为 `PI_CODING_AGENT_DIR`（让容器能看到你的 API key 与模型配置）：

```yaml
services:
  pi-web-ui:
    build: .
    ports: ["8787:8787"]
    environment:
      PI_WEB_HOST: 0.0.0.0
      # PI_WEB_ENGINE: dsh
    volumes:
      - pi-web-data:/app/.pi-web
      # - ./my-project:/workspace:ro
      # - ~/.pi/agent:/root/.pi/agent:ro
volumes:
  pi-web-data:
```

## 界面插件

插件是可选的界面组件（顶栏多出一个 tab，背后是插件自己的视图，可带服务端入口和 AI 工具）。
它们安装在**数据目录的 plugins 文件夹**（`<dataDir>/plugins/<id>/`，默认
`~/.pi-web/plugins/`）—— 一个插件就是一个目录：`manifest.json` + 可选服务端入口
（`index.mjs`）+ 可选视图入口（`client/entry.mjs`）。目录不存在 = 没有插件，界面上不会有任何痕迹。

### 插件目录

以下插件随本仓库发布（`plugins/<id>/`），可直接从 GitHub 安装：

| 插件                                                                                                      | 功能                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 📬 [网页邮箱 webmail](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail)                 | IMAP 收件箱浏览/搜索/阅读/标记/删除 + SMTP 发信、新邮件通知，可选「允许 AI 管理邮箱」（六个 `mail_*` AI 工具）。首次激活自动补装 npm 依赖。                                                                                                                                                                        |
| 🗄️ [数据库 db-client](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client)               | 数据库工作台：MySQL / PostgreSQL / SQLite / SQL Server / MongoDB / Redis 连接管理 + 库表树 —— 表结构、分页排序、SQL 编辑器、行编辑。驱动首次使用自动安装。                                                                                                                                                         |
| 📝 [编辑器 + SSH vscode-editor](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor) | 类 VSCode 工作台：多根文件树（本地 + SSH 主机）、CodeMirror 多标签编辑器、Remote-SSH 远程文件浏览/编辑、可拖拽多终端面板（xterm.js）、SFTP 同步与下载到电脑。自动安装 `ssh2`。                                                                                                                                     |
| 📊 [图表 mermaid](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/mermaid)                     | 把对话里的 ` ```mermaid ` 围栏渲染成 SVG 图表（fenced-code 渲染插件，本地引擎离线优先）。                                                                                                                                                                                                                          |
| 🧭 [运行轨迹 run-trace](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/run-trace)             | 运行轨迹：任务 → 思考 → 工具 → 文件改动 → 结果的时间线聚合视图，支持回放与节点详情。                                                                                                                                                                                                                               |
| 📖 [阅读 legado-web](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/legado-web)               | Legado 阅读（文本源）：基于兼容安卓书源的搜书 / 发现 / 详情 / 目录 / 正文阅读，支持书源导入、检测与删废源，并提供四个修源 AI 工具（`legado_rules`、`legado_book_sources`、`legado_source_probe`、`legado_run_rule`）与「🤖 AI 修复源」按钮（带失败现场直接开新对话）。书源/书架/进度存在 `<dataDir>/legado-web/`。 |

`plugins/demo-mailbox` 作为最小插件模板保留在仓库里（服务端入口 + 客户端视图 + 双向消息协议），兼作测试夹具——想自己写插件从这里入手。

也可以直接在界面里装：**设置 → 界面插件 → 插件市场**列出可维护插件（同一套，随包在 `plugins/catalog.json`）并提供**安装 / 更新 / 卸载**（更新保留 `config.json`），还能用「添加插件」把任何第三方插件（填 `owner/repo` 或 `owner/repo/子目录`）加进列表——你加的条目存在 `<dataDir>/plugin-catalog.json`。插件作者想让插件进内置列表，往 `plugins/catalog.json` 提一行 PR 即可。

安装示例（网页邮箱）：

```bash
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail
```

每个插件在仓库里的目录都带独立 `README.md`，含完整功能清单、配置说明与注意事项。

### 安装

从 GitHub 安装（支持以下任意源写法）：

```bash
pi-web-ui install owner/repo                                  # 简写
pi-web-ui install https://github.com/owner/repo               # 完整 URL（.git 可省）
pi-web-ui install https://github.com/o/r/tree/dev/sub/dir     # 指定分支 + 仓库内子目录
pi-web-ui install owner/repo#v1.2                             # 指定分支/tag（#后缀对以上任意写法都适用）
pi-web-ui install /path/to/plugin-dir                         # 本地目录直接安装（开发调试用）
```

常用选项：

- `--name <id>` —— 自定义插件 id / 目录名（默认取仓库名或子目录名；仅限字母数字-`-`/`_`）。
- `--force` —— 目标目录已存在时覆盖安装。插件本地的 `config.json`（凭据等）在升级时会原样保留。
- `--data-dir <dir>` —— 覆盖数据目录（默认 `~/.pi-web`）。

CLI 会浅克隆仓库（无 git 时回退 tarball 下载），定位其中的 `manifest.json`
（包括仓库内子目录里的），然后把插件拷贝到 `<dataDir>/plugins/<id>/`。

**没装 git？没有网络？** 直接把插件目录手工拷进 `~/.pi-web/plugins/` 也行——效果完全一样。

### 更新

对同一来源重新执行 `install` 并加 `--force` 即覆盖更新：

```bash
# 例：把网页邮箱插件更新到仓库里的最新版
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force
```

- 升级时会自动保留插件目录里的 `config.json`（账号凭据等）。
- 存放在插件目录**其他位置**的本地数据不在保留范围内（如 db-client 的
  `db-connections.json`、vscode-editor 的 `ssh-hosts.json`）——强制重装前请先备份。
- 更新后刷新浏览器即可生效，无需重启服务。
- 想知道哪些插件过时了：`pi-web-ui plugins --check-updates` 逐个对比记录的提交与远端 HEAD；退回上一版用 `pi-web-ui plugins --rollback <id>`（每次 `--force` 升级前都会自动备份旧目录，只留最近 3 份）。

### 生效方式

服务运行中只需**刷新浏览器**——新插件在 attach 时即被加载，无需重启；服务未运行则下次启动生效。
每个插件会在顶栏出现一个 tab（🧩 或插件自带图标）。

### 列出 / 停用 / 卸载

```bash
pi-web-ui plugins             # 列出已装插件（id / 名称 / 版本 / 描述）
pi-web-ui uninstall <id>      # 卸载插件
```

- 想临时隐藏某个插件而不卸载：设置面板（⚙）→「界面插件」开关即可——按客户端持久化、纯 UI
  隐藏，无需重启，随时可重新打开。
- `uninstall` 会删除插件目录；刷新浏览器后 tab 即消失。写在插件目录内的配置文件也会一并删除——
  如需保留请先备份 `<dataDir>/plugins/<id>/config.json`。

## 浏览器扩展

### 🎯 网页元素拾取（page-picker）

在**开发中的网页**上点选元素，把它整理成 AI 能直接动手的上下文，一键注入 pi-web-ui 的对话输入框
（`Alt+Shift+P` 或点扩展图标 → hover 高亮 → 点击拾取 → `Shift`+点击多选 → 写备注 → 「添加到对话」）。

它不是 pi-web-ui 的服务端插件，而是一个**浏览器扩展**（所以不走 `pi-web-ui install`）：

**下载装**（不需要 Node）：[`page-picker-extension.zip`](https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip) →
解压 → `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」→ 选解压出的目录 →
点扩展的「扩展程序选项」填 pi-web-ui 地址（远程地址先点「授权该地址」）。

详细说明（交互、采集了什么、远程部署、已知限制）见
[`plugins/page-picker/README.md`](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/page-picker)。

采集的不是截图，而是**能让 AI 一次改对**的东西：React fiber 里的组件源码位置（`Card.tsx:18:5` +
调用链）、Vue SFC 文件、命中的 CSS 规则**源文件与行号**（Vite dev 下精确反推）、
只保留「与默认值不同」的计算样式子集、短且唯一的定位串、HTML 骨架与折叠文本；
可选元素截图会走对话附件。

## 主题

每个主题是**一份纯 `:root` 调色板覆盖** —— 只写 CSS 变量的声明文件（变量全集见 `web/src/styles.css` 的 `:root`：`--bg/--accent/--term-*` 基础色，加 `--tooltip-bg/--code-bg/--notice-*` 等派生色）。布局只存在于打包的 `web/src/styles.css` 里，选主题只是覆盖变量，因此任何主题都能在所有版本上工作，改布局也不需要碰主题文件。内置主题由 `node make-light-theme.mjs` 生成。

内置主题随 npm 包分发（`themes/`）：`white`（浅色）、`cyberpunk` / `dazzle`（深色）、`translucent` / `transparent`（壁纸友好半透明/全透明，可配对话壁纸）。主题选择器在顶栏（🌞 图标），当前选择按浏览器存在 `localStorage`。

### 使用主题

在顶栏直接选择即可 —— 内置主题和用户主题合并显示在同一个菜单里；同名 id 时用户主题优先。

### 本地添加主题（无需 GitHub）

把任意 CSS 文件丢进**数据目录的 themes 文件夹**就会自动出现在主题菜单里 —— 不用重启、不用重新构建：

1. 找到数据目录（默认 `~/.pi-web`，可用 `PI_WEB_DATA_DIR` 覆盖）。
2. 创建 `<dataDir>/themes/` 并放入你的样式表，例如 `~/.pi-web/themes/my-theme.css`。
3. 刷新页面，在顶栏选择它。**文件名（去掉 `.css`）** 就是菜单里显示的主题 id。

```
~/.pi-web/
└── themes/
    └── my-theme.css          # 菜单里显示为 "my-theme"
```

最容易的写法：复制一个内置调色板（如源码仓库里的 `themes/white.css`），改 `:root` 颜色即可 —— 想覆盖哪些变量就列哪些，没列的会落到 `styles.css` 的深色默认值。注意：

- **终端跟随主题** —— 在你的 `:root` 里设置 `--term-*` 变量（终端 ANSI 配色 + `--term-bg`），xterm 画布和它的内边距容器都会自动适配（默认值见 `styles.css`）。
- 代码高亮色（打包自带 `highlight.js` 的 `github-dark.css`）在浅色主题下必须覆盖，否则代码会看不清 —— 参照 `themes/white.css` 末尾的 `.hljs` 覆盖写法（深色主题可跳过）。
- 主题 id 必须匹配 `^[A-Za-z0-9_-]+$`（不能有点和斜杠 —— 服务端有路径穿越防护）。

### 向仓库贡献主题（GitHub）

想让你的主题随包分发给所有人？在 [github.com/xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui) 开一个 Pull Request：

1. Fork 并 clone 仓库。
2. 创建 `themes/<id>.css` —— 一份纯 `:root` 调色板。以 `themes/white.css`（浅色）或 `themes/cyberpunk.css`（深色）为模板。
3. 本地验证：运行 `npm run dev`，用顶栏主题选择器确认你的主题能被列出、渲染正确（对话卡片、代码块、工具调用卡片、Git/终端面板）。
4. 如果你改了 `styles.css` 的变量清单，用 `node make-light-theme.mjs` 重新生成全部内置主题。
5. 提交（`git add themes/<id>.css`）并开 PR。`themes/` 已在 npm 包 `files` 白名单里，合并发布后 `npm i -g pi-web-ui` 即可把你的主题带给所有人。

合并主题的规则：必须是单一 CSS 文件、设置 `--term-*` 变量保证终端可读、浅色主题覆盖 `.hljs` 语法高亮色以保证代码可读。

## 环境变量调优

以下全部可选——默认值就是开发时一直在用的配置。完整参考：[`docs/env-vars.md`](docs/env-vars.md)。

| 变量                           | 默认               | 作用                                                                                                                                                                                                           |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_WEB_TOOL_TIMEOUT_MS`       | `1200000`（20 分） | 单工具调用看门狗；超时自动中止（`ask_user_question` 豁免）。                                                                                                                                                   |
| `PI_WEB_STALL_NOTIFY_MS`       | `180000`（3 分）   | 流式运行完全没事件时给警告（不中止）；`0` = 关。                                                                                                                                                               |
| `PI_WEB_TERMINAL_IDLE_MS`      | `15000`            | AI 开过的终端静默这么久就催它去看一眼；`0` = 关。                                                                                                                                                              |
| `PI_WEB_TERMINAL_IDLE_LINES`   | `10`               | 该催命消息回送的终端尾部行数（1–500）。                                                                                                                                                                        |
| `PI_WEB_INLINE_FILE_MAX`       | `12288`（12KB）    | 小于它且无工作区归属的上传文件被内联而不是只给路径。                                                                                                                                                           |
| `PI_WEB_VISION_TIMEOUT_MS`     | `90000`            | 视觉桥整批转写的超时。                                                                                                                                                                                         |
| `PI_WEB_UPLOAD_RETENTION_DAYS` | `14`               | `<dataDir>/uploads/` 保留天数；`0` = 不清理。                                                                                                                                                                  |
| `PI_WEB_SHELL`                 | 自动               | 仅 Windows：node-pty 用哪个 shell（自动顺序：`PI_WEB_SHELL` → `$SHELL` → Git Bash → 随包 busybox → `%COMSPEC%` → PowerShell）。                                                                                |
| `PI_WEB_TABS`                  | 全部标签页         | 逗号分隔的标签页白名单（`chat,terminal,git,search,tasks,settings,plugins`）；未列入的在服务端也被拒绝，`chat` 不可关。                                                                                         |
| `PI_WEB_MANAGED`               | 关                 | `1`/`true` 声明实例由外部部署管理：自更新、装 pi CLI、装插件都被拒绝并说明原因，前端也隐藏入口。                                                                                                               |
| `PI_WEB_ALLOW_HOSTS`           | 空                 | 严格的主机名白名单（叠加在始终生效的同权威校验之上）。                                                                                                                                                         |
| `PI_WEB_LOCALE`                | 空                 | 首访回退语言（显式选择与浏览器语言优先级更高）。                                                                                                                                                               |
| `PI_WEB_LOCALE_BASE_URL`       | GitHub raw         | 语言包下载根 —— 指向镜像即可做离线/内网安装。                                                                                                                                                                  |
| `PI_WEB_PKG_ROOT`              | 自动               | 显式指定包根目录（非标准安装位置时用）。                                                                                                                                                                       |
| `PI_CODING_AGENT_SESSION_DIR`  | 空                 | 让 pi 把转录扁平写入该目录（而非 `<agentDir>/sessions/--<cwd>--/`，会改变历史列表读到的内容）。                                                                                                                |
| `DSH_*`                        | —                  | DSH 运行时旋钮：`PI_WEB_DSH_RUNTIME`、`PI_WEB_DSH_DATA_DIR`、`PI_WEB_DSH_PATCH_DIR`、`PI_WEB_DSH_QUESTION_TIMEOUT_MS`、`PI_WEB_DSH_TOOL_TIMEOUT_MS`、`PI_WEB_DSH_SESSION_RETENTION_DAYS`、`PI_WEB_DSH_DEBUG`。 |

## 安全

- **默认只绑 loopback** —— 服务器只监听 `127.0.0.1`，不暴露到网络；需要局域网访问或
  Docker 端口映射时显式设置 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置）。
- **WebSocket Origin 校验** —— 浏览器页面连 `/ws` 时其 Origin 的 hostname **和端口**
  必须与请求 Host 一致，跨源页面直接 403；无 Origin 的非浏览器客户端不受影响。
  反向代理场景可用 `PI_WEB_ALLOW_ORIGINS=http://你的域名:端口` 放行。
- **Quiesce 排空** —— `server quiesce` 后拒绝新的 prompt/编辑重问/会话恢复，存量运行
  跑完为止（升级/备份前用）；`server unquiesce` 恢复。
- **凭据不下发浏览器** —— provider 的 `headers`（可能含 Authorization / API key）
  永不发给浏览器；模型管理 UI 编辑其他字段，服务端自动保留 headers。

## 反向代理（nginx）

pi-web-ui 默认只绑 loopback，同机 nginx 反代是官方支持的远程访问方式（无需
`PI_WEB_HOST=0.0.0.0`）：

```nginx
# pi-web-ui 在 127.0.0.1:8787，对外暴露为 https://your-host/pi/
server {
    listen 443 ssl;
    server_name your-host;
    # ssl_certificate ... / ssl_certificate_key ...

    # 应用入口（剥掉 /pi/ 前缀）
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # 必须用 $http_host（保留端口）—— 服务端的 Origin 校验比较完整权威
        # （hostname + 端口），$host 会丢掉端口导致 403
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket —— 必须原样转发 Host，否则升级被 403（页面能开，
    # 但对话/终端一直重连）
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # 构建产物的绝对路径资源/API（根路径，不带 /pi/）
    location /assets/  { proxy_pass http://127.0.0.1:8787; }
    location = /favicon.svg           { proxy_pass http://127.0.0.1:8787; }
    location = /api/file   { proxy_pass http://127.0.0.1:8787; }
    location = /api/health { proxy_pass http://127.0.0.1:8787; }
}
```

要点：

- **`Host` 必须用 `$http_host`**（保留端口），`/pi/` 和 `/ws` 都要 —— Origin 校验比较
  hostname **和**端口。`proxy_set_header Host $host` 或不设置（默认上游地址
  `127.0.0.1:8787`）都会 403。
- **同源自动通过**：只要浏览器 Origin 与转发后的 Host 一致（普通反代天然如此），
  就无需 `PI_WEB_ALLOW_ORIGINS`；仅当浏览器 Origin 与后端看到的 Host 不同
  （如 TLS 终止代理改了端口）才需要设置。
- **不要开 `proxy_protocol`**（除非确实要真实客户端 IP）：它会让 nginx 拒绝所有
  不带 PROXY 头的连接，局域网直连和 frp 以外的客户端全挂。用 frp 时同样去掉
  `transport.proxyProtocolVersion`（除非 nginx 也 listen proxy_protocol）。
- **局域网免代理访问**：直接设 `PI_WEB_HOST=0.0.0.0`（加防火墙规则），
  或把上面的 server 块放到 80/443 端口。

带 frp 内网穿透的完整可运行示例：`deploy/nginx-subpath.conf`。

## 参与贡献

pi-web-ui 是一个小型开源项目 —— **你的贡献就是它成长的力量**。代码、插件、主题、文档、翻译、想法，统统欢迎；每一个合并的 PR 都会随下一次 `npm publish` 送达所有用户。❤️

| 贡献方式               | 如何开始                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🧩 **写插件**          | 打造你自己的界面 tab + AI 工具。以 `plugins/demo-mailbox` 为最小模板（它兼作测试夹具），本地开发后既可开 PR 收录进[插件目录](#插件目录)，也可独立发布。                                                     |
| 🎨 **贡献主题**        | 以 `themes/white.css`（浅色）或 `themes/cyberpunk.css`（深色）为纯调色板模板，调整 `:root` 配色 + `--term-*` + `.hljs`，用 `npm run dev` 验证后开 PR —— 完整步骤见[向仓库贡献主题](#向仓库贡献主题github)。 |
| 💻 **修 bug / 加功能** | 在 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 里挑一个，或提出新想法。Fork → 分支 → PR。代码约定见 `AGENTS.md`（Tab 缩进、i18n 双语 key、协议改动只动 `server/protocol.ts`）。               |
| 📖 **文档与翻译**      | 完善 README、补插件文档、改错别字，或帮忙把界面/文档翻译成更多语言。                                                                                                                                        |
| 💡 **想法与反馈**      | 在 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 或 [Discussions](https://github.com/xing-shuyin/pi-web-ui/discussions) 里开帖 —— 功能建议、bug 报告、界面优化点子、部署经验分享都欢迎。        |

**开 PR 前**，快速自检能让维护者更省心：

- `npm run check:protocol` + `npm test` —— 协议同步与单元测试。
- `npm run typecheck` —— 无类型错误。
- `npm run build` —— 前后端都能编译。
- 涉及协议改动：`server/index.ts` 与 `web/src/use-chat.ts` 两端 dispatch 都要加分支（详见 `AGENTS.md`「协议单源」）。

> 喜欢 pi-web-ui？给仓库点个 ⭐，帮助更多人发现它。如果你在上面做了很酷的东西（插件、主题、部署方案），记得告诉我们 —— 我们乐于展示社区作品。

## License

MIT
