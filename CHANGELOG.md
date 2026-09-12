# Changelog

> 面向使用者的版本变更记录：升级前先看这里，再决定是否升级。
> 版本号规则：npm 上的版本不带 `v` 前缀（如 `0.70.0`），GitHub 的 tag / Release 带 `v` 前缀（如 `v0.70.0`），两者数字部分一一对应。
> 日期为 npm 发布时间（UTC+8 换算后的日历日）。

格式说明：`Added` 新增功能、`Fixed` 修复、`Changed` 行为/样式变更、`i18n` 多语言相关。
每个版本的内容按"实际合入该版本发布的提交"归档（以 `package.json` 的 version 变更提交为准），
而不是按提交日期聚类——连续快速发布的 patch 版本以此为准最准确。

## [Unreleased]

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

[Unreleased]: https://github.com/xing-shuyin/pi-web-ui/compare/v0.80.1...main
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
