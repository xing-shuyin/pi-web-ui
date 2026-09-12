# 插件系统

> 可选界面组件，存放在 `<dataDir>/plugins/`。不装即不存在，attach 时热重扫。

## 形态

一个插件 = `<dataDir>/plugins/<id>/` 目录：

- `manifest.json`（name/version/description）
- `index.mjs` 服务端入口（可选，`export default { activate(host) → deactivate? }`）
- `client/entry.mjs` 视图入口（可选，`export default { mount(el, ctx) → cleanup? }`）

**不装即不存在**——目录不在就没有任何协议/UI 痕迹；attach 时重扫目录，新丢进来的插件无需重启服务即出现在顶栏视图 tab（import 每进程一次并缓存；删除目录 → 下次 attach 反激活）。

## 协议

| 方向 | 消息             | 作用                                                                          |
| ---- | ---------------- | ----------------------------------------------------------------------------- |
| 上行 | `plugin_message` | 路由到该插件的 onMessage 处理器，回调第二参为 clientId；未知/非法 id 静默丢弃 |
| 上行 | `plugins_reload` | 服务端热重载：反激活全部→重扫激活→epoch+1→重推清单                            |
| 下行 | `plugins`        | attach 时推清单（plugins, epoch），epoch 用作前端 import 缓存击穿参数 `?e=`   |
| 下行 | `plugin_data`    | 默认广播给所有 socket，前端按 pluginId 扇出给已加载视图                       |

## 宿主扩展点

| 方法                                | 作用                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.notify(level, text)`          | 发系统通知条（notice，前端 toast）                                                                                                                       |
| `host.sendTo(clientId, payload)`    | 定向发给单个 socket                                                                                                                                      |
| `host.onToolEvent(h)`               | 订阅 SDK 工具执行事件（phase:start\|end, toolName, conversationId?, toolCallId?, durationMs?, isError?）                                                 |
| `host.onRunEvent(h)`                | 订阅运行轨迹事件（run_start/message/tool_start/tool_end/turn_*/run_end，pi 引擎；轨迹/时间线插件聚合「任务→思考→工具→文件→结果」用，payload 已截断封顶） |
| `host.getActiveConversation()`      | 读取当前打开对话的快照（标题/消息/流式消息/统计——轨迹视图直接显示打开对话的时间线；只读引用，广播前必须抽摘要，禁止原样下发）                            |
| `host.onConversationChanged(h)`     | 订阅「当前打开对话变了」（切历史会话/切 running 对话/新对话/切项目——轨迹类插件靠它重拉时间线，不等轮询）                                                 |
| `host.registerAgentTool(tool)`      | 注册供 AI 调用的工具，返回注销函数                                                                                                                       |
| `host.onAttach(h)`                  | 注册「新客户端接入」钩子（每次浏览器 attach，含 plugins_reload 后的重接入）                                                                              |
| `host.registerCommand(cmd)`         | 注册斜杠命令（SlashCommandInfo source=plugin → 选择器 + prompt 拦截执行）                                                                                |
| `host.route(method, path, handler)` | 挂载 HTTP 路由（`/plugins-api/:id/*`）                                                                                                                   |
| `host.fs`                           | 受限工作区文件访问（WorkspaceFS，路径锚定活 cwd 根，越界拒绝）                                                                                           |
| `host.getSettings()`                | 读取声明式设置（manifest.settings schema）                                                                                                               |
| `host.onSettingsChanged(h)`         | 订阅设置变更                                                                                                                                             |
| `host.registerBackgroundTask(task)` | 注册插件常驻任务，并入顶栏「后台任务」面板                                                                                                               |
| `host.notifyCwd(cwd)`               | 当主应用 set_cwd 成功后通知插件（幂等去重，异常隔离）                                                                                                    |

### 宿主设施（plugin-facilities.ts）

| 设施         | 说明                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `storage`    | `<pluginDir>/storage.json` 原子 KV                                   |
| `secrets`    | AES-256-GCM 加密机密，密钥 `<dataDir>/secrets.key`，拷机 fail closed |
| `ensureDeps` | npm 自动补装单飞                                                     |

### 能力声明与强制（manifest.permissions）

写了=严格模式，宿主自控 API（registerAgentTool→tools / route→http / host.fs→fs）按声明族强制拦截，未声明的族拒绝并报「缺哪族」；未写且 apiVersion<2=旧全权（放行但每激活期警告一次，v2 起默认拒绝已预埋）。

## manifest 可选字段

- `icon`（emoji/单字符，顶栏 tab 替代通用拼图图标）
- `description`（tab 悬浮提示）
- `version`
- `apiVersion`（与 `PLUGIN_API_VERSION` 比较，> 则拒绝激活并提示升级）
- `permissions`（能力声明数组）
- `settings`（声明式设置 schema → ⚙ 面板自动渲染表单）
- `view`（布尔，缺省 `true`）：是否有独立视图 tab。**纯 renderer 插件写 `false`**，
  前端不会急着加载它的 bundle，只在消息里命中围栏时才懒加载
- `renderers`（字符串数组）：该插件能渲染的 fenced-code 语言（`"mermaid"` 等），
  与 `client/entry.mjs` 的 `default.renderers[lang]` 一一对应

## fenced-code 渲染插件（renderer plugins）

> 让消息里 ` ```lang ` 围栏由插件渲染成自定义 DOM（第一个实现：mermaid → SVG）。

**形态**：`manifest.json` 声明 `view:false, renderers:["lang"]`，`client/entry.mjs`
默认导出 `{ renderers: { lang: (code, ctx) => HTMLElement|null } }`。返回 `null`
＝不渲染，回退普通代码块。renderer 是任意技术栈（不共享 React 实例），主应用只
负责把返回的 DOM 挂进消息流；ctx 与视图 mount 同一套窄通道（`send`/`onData`）。

**协议**：`UiPluginInfo` 新增 `renderers`/`view` 两个可选字段，随 plugins 清单推送。

**分发**：插件不进 npm 包，随 GitHub 仓库分发——`pi-web-ui install <owner>/<repo>/<subdir>`
（install 原生支持子路径 source）或复制目录到 `<dataDir>/plugins/`。需要大引擎的
renderer 插件可自带 vendor（如 mermaid 插件 `vendor/mermaid.bundle.mjs`，构建产物随
插件分发，本地优先加载、缺省回退 CDN）。

**前端路由**：`web/src/plugin-fence.ts` 维护「语言 → 插件 id」注册表（由 plugins
清单构建），`Markdown.tsx` 的 `PreWithCopy` 遇到 ` ```lang ` 围栏时查表——有插件
认领则交给 `PluginFenceBlock` **按需懒加载**该插件 bundle 并渲染（命中才下载，
与视图插件在 `syncPluginViews` 里常驻加载不同）；加载中/失败/返回 null 一律回退
普通代码块，绝不空白。epoch（plugins_reload）变化时清缓存并 `?e=` 重拉。

**注意**：renderer 是浏览器直接执行的裸 ESM，**不能 import npm 包**（无 bare
specifier 解析）。需要大依赖的插件自带打包 bundle（如 vscode-editor）或自带
vendor 本地加载（如 mermaid 插件 `vendor/mermaid.bundle.mjs`，本地优先、缺省回退 CDN）。

## 前端集成

App 按 chat.plugins 动态 import 各插件的 client bundle（`/* @vite-ignore */`），TopBar 为每个插件加一个 🧩 tab（激活失败的置灰）；插件不共享 React 实例，与主应用只有 ctx.send/onData 两条窄通道。

### 插件 → 宿主动作桥（`window.__piWebUiHost`）

插件 bundle 是裸 ESM，import 不到应用模块；需要主应用配合的**动作**（不只是数据）走 `window.__piWebUiHost`：

| 字段                                    | 说明                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                               | 宿主 API 版本（当前 2；插件可用它判断宿主能力）                                                                                                                                                                                                                                                                                                                                  |
| `setView(view)`                         | 切主视图（`"chat"` / `"terminal"` / `"git"` / `"plugin:<id>"`）                                                                                                                                                                                                                                                                                                                  |
| `startChat({ prompt, newChat?, cwd? })` | 新建对话（可选切工作目录）并把 prompt 作为用户消息发出；返回"已受理"                                                                                                                                                                                                                                                                                                             |
| `compose({ text?, attachments? })`      | 把内容放进**输入框草稿**（用户补一句话再自己发），返回是否受理。与 startChat 的差别：**不要求连接就绪**（草稿是本地状态）、输入框没挂载时拒收。实现走 `web/src/composer-bridge.ts` 的模块级 sink（草稿文本在 ChatInput 内部 state、待发附件在 App state，两处各自注册自己那一半）；合并语义复用 `composer-draft.ts`（空则填入、非空追加、绝不覆盖），附件按 path+mode+行区间去重 |

定义：`web/src/plugin-host.ts`（纯逻辑 `createPluginHostApi`，App 挂载时 `installPluginHostApi`）。
**时序坑**：服务端 `new_chat` 是异步的（`void cs.newChat()`），紧接着发 `prompt` 会落到旧对话，
所以 `startChat` 内部串行等：cwd 切过去 → 对话变空白/换新 → 才发 prompt（每步有超时，超时也发，不静默丢）。
现有用户：legado-web 插件的「🤖 AI 修复源 / AI 新建书源」按钮（阅读页与书源页一键把现场发给 AI 开新对话）。

`syncPluginViews(plugins, epoch)` 统一同步注册表：清单消失/被禁用即卸载视图（调 cleanup）、epoch 变化清 failed 重拉 bundle。

设置面板 ⚙ 有「界面插件」开关区（`set_settings.disabledPlugins`，持久化 client-state、纯 UI 隐藏不触发 runtime reload）+ **每行「更新/卸载」按钮**（更新需 CLI install 记录的来源 `.pi-source.json` → `UiPluginInfo.source`；两个操作都走可见终端 tab，退出后 App 观察器发 `plugins_reload` 热重载）。

## 静态服务

`GET /plugins/:id/client/*` 映射到插件目录的 client/ 子树（**只暴露这个子树**——manifest 与服务端 index.mjs 可能含凭据，绝不下载；id 校验 + resolve 前缀防穿越）。dev 模式 vite 已代理 /plugins。

前端动态 import 的 bundle URL 经 `web/src/base-url.ts` 的 `appUrl()` 加上应用根前缀
（nginx 子路径反代时页面在 /pi/ 下，请求会变成 `/pi/plugins/<id>/client/entry.mjs`），
子路径部署无需任何额外配置；根部署时行为与根路径完全一致。

## MCP 工具桥（server/mcp-bridge.ts）

读取 `<dataDir>/mcp.json` 启动外部 MCP 服务器（stdio、换行分隔 JSON-RPC，零三方依赖；`{servers:{名:{command,args,cwd,env}}}`），握手 initialize→initialized→tools/list→tools/call 后把每个远端工具适配成 PluginAgentTool（名字归一化 sanitizeToolName），并入 plugin.d.ts 的 pluginToolsProvider（与插件工具同一 customTools 管线）。单服务器失败隔离（rejectAll + 日志，不炸进程）；dispose 时 kill 子进程；请求按 id 匹配 + 超时看门狗。

## 插件市场（可一键安装的插件列表）

> 设置面板「界面插件」页上方新增的「插件市场」区：列表里每条插件一个「安装」
> 按钮，点一下即在可见终端跑 `pi-web-ui install <source> --name <id>`，装完
> 自动重载。已装过的显示「更新」（`install … --force`，保留 config.json）与
> 「卸载」（两步确认，`pi-web-ui uninstall <id>`）——**安装 / 更新 / 卸载全套**。

**两层来源合并**（`server/plugin-catalog.ts`）：

| 层      | 位置                                                                   | 谁维护                                                                        |
| ------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| builtin | `<pkgRoot>/plugins/catalog.json`（随包发布，npm files 白名单含该文件） | 官方/社区 —— 往这个文件加一条 + PR 即入列表                                   |
| custom  | `<dataDir>/plugin-catalog.json`                                        | 用户 —— 设置面板「添加插件」表单填 source/名称/简介，任何第三方插件都能进列表 |

条目 = `{ id, name?, description?, descriptionEn?, icon?, source, homepage? }`；
同 id 时 custom 覆盖 builtin。`id` 是安装落盘目录名
（`<dataDir>/plugins/<id>`），前端用「列表 id ∈ 已装插件 id」判断安装态；
`source` 与 CLI 同格式（owner/repo[/子目录][#分支]），服务端只做宽松校验
（不拉网络，不碰 manifest —— 展示信息由条目作者填）。

**协议**：`plugin_catalog`（下行，attach 即推 + add/remove 后重推，带 epoch）／
`plugin_catalog_add` / `plugin_catalog_remove`（上行，服务端校验 + 原子写
custom 文件 + notice 回显）。内置条目不可经 UI 移除。

## 真实插件

| 插件          | 目录                             | 说明                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| demo-mailbox  | `plugins/demo-mailbox/`          | 内存邮箱 demo，plugin-test 夹具                                                                                                                                                                                                                                                                                                                                                                  |
| mermaid       | `plugins/mermaid/`               | 📊 ` ```mermaid ` 围栏 → SVG（renderer 插件，自带 vendor 引擎本地优先加载）                                                                                                                                                                                                                                                                                                                      |
| webmail       | `plugins/webmail/`               | 📬 网页邮箱，IMAP/SMTP 邮件管理                                                                                                                                                                                                                                                                                                                                                                  |
| vscode-editor | `plugins/vscode-editor/`         | 📝 编辑器 + SSH（原独立插件合并）                                                                                                                                                                                                                                                                                                                                                                |
| db-client     | `plugins/db-client/`             | 🗄️ 数据库连接管理（mysql2/pg/mssql/sqlite/mongodb/redis）                                                                                                                                                                                                                                                                                                                                        |
| run-trace     | `plugins/run-trace/`             | 🧭 运行轨迹时间线：当前对话的横向泳道时间轴 + 分段分析（host.onRunEvent + getActiveConversation + onConversationChanged）                                                                                                                                                                                                                                                                        |
| legado-web    | `plugins/legado-web/`            | 📖 Legado 阅读（文本源）：搜索/发现/详情/目录/正文，书源与安卓版兼容；内嵌 Vite 前端（`client/app/`，iframe 视图）+ 自带 `/proxy`（跨域+GBK）与 `/store`（书源/书架/进度只落数据目录 `<dataDir>/legado-web/`，不写 localStorage）+ 四个 AI 修源工具（`legado_rules`/`legado_book_sources`/`legado_source_probe`/`legado_run_rule`，规则引擎跑在 worker 里，同步 JS 规则走 SharedArrayBuffer 桥） |
| image-toolkit | `plugins/image-toolkit/`         | 🖼 图片工作台：压缩（目标体积二分逼近）/裁剪/缩放/旋转翻转/格式转换/批量 ZIP/水印/滤镜调色/信息与 EXIF/剪贴板与拖放导入，可读写工作区图片（`/ws/list\|image\|probe\|save\|settings`，走 `host.fs` 越界拒绝，原始字节不经 base64）+ 四个 AI 工具（`image_info`/`image_transform`/`image_compress`/`image_watermark`，PNG/BMP 用自带纯 JS 编解码、JPEG 经 `ensureDeps` 装纯 JS 的 jpeg-js）         |
| page-picker   | `plugins/page-picker/extension/` | 🎯 网页元素拾取（**浏览器扩展**，不是 pi-web-ui 插件）：在开发网页上点选元素 → 采集定位串 / 命中的 CSS（Vite dev 下含源文件行号）/ React fiber 里的组件文件:行号 / 计算样式差异 → 渲染 Markdown → 经宿主动作桥 `compose()` 注入 pi-web-ui 输入框（`world:"MAIN"` 注入 + 闭合 Shadow DOM overlay；esbuild 打包，`npm run build:extension`）                                                       |

## 回归测试

| 测试文件                              | 端口        | 说明                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin-test.mjs`                     | 8978        | 清单推送 / message 回环 / 静默丢弃 / 静态服务 / 路径穿越拒绝 / 插件市场（plugin_catalog add/remove 回环 + 内置条目）                                                                                                                                                                                                                                                                |
| `plugin-command-test.mjs`             | 8979        | 插件命令全链路                                                                                                                                                                                                                                                                                                                                                                      |
| `plugin-http-test.mjs`                | 8981        | host.route 全链路（GET/POST/404/500/异步 handler 抛错转 500 不打挂进程）                                                                                                                                                                                                                                                                                                            |
| `plugin-bgtask-test.mjs`              | 8982        | registerBackgroundTask 全链路                                                                                                                                                                                                                                                                                                                                                       |
| `plugin-settings-test.mjs`            | 8983        | 声明式设置 schema 校验/持久化/回显                                                                                                                                                                                                                                                                                                                                                  |
| `plugin-cwd-test.mjs`                 | 8989        | set_cwd→notifyCwd→广播全链路                                                                                                                                                                                                                                                                                                                                                        |
| `mcp-bridge-test.mjs`                 | 8990        | MCP 服务器握手/工具调用/失败隔离                                                                                                                                                                                                                                                                                                                                                    |
| `fence-render-test.mjs`               | 随机        | renderer 插件 E2E：```mermaid → SVG（本地 vendor）、无插件语言回退（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                           |
| `plugin-update-test.mjs`              | —           | install/check-updates/rollback 全链路                                                                                                                                                                                                                                                                                                                                               |
| `ssh-plugin-test.mjs`                 | 8964        | SSH 远程文件/终端全链路（mock SSH 服务端）                                                                                                                                                                                                                                                                                                                                          |
| `db-client-test.mjs`                  | 8968        | SQLite 全链路协议冒烟                                                                                                                                                                                                                                                                                                                                                               |
| `legado-web-test.mjs`                 | 8993        | legado-web：内嵌前端静态托管 / 代理（UTF-8+GBK、charset 驱动的 URL 与 body 编码、浏览器头不外泄、上游失败 502）/ 存储读写与非法键                                                                                                                                                                                                                                                   |
| `legado-web-engine-test.mjs`          | 8995        | legado-web AI 修源接口：工具注册 / 书源文件读写 / 链路诊断（含 step 单步）/ 试规则 / 单段 CSS 规则回归 / 同步 `java.ajax`（零 token）                                                                                                                                                                                                                                               |
| `legado-web-ai-fix-test.mjs`          | 8996        | legado-web 「AI 修复源 / 新建书源」按钮 E2E：harness 页充当宿主（假 `__piWebUiHost`）+ 内嵌阅读页点按钮 → 正文含现场 / 切 chat / 新对话 / cwd=书源目录（书源页 + 发现页 + 新建；缺 Chrome 自动 SKIP）                                                                                                                                                                               |
| `legado-web-explore-test.mjs`         | 8998/8999   | legado-web 发现页：收藏书源（下拉「⭐ 常用」分组 + 常用快捷行 + `prefs.json`）/ 直接搜这个源 / 分类浏览与搜索共用列表容器互不串味（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                            |
| `legado-web-storage-test.mjs`         | 8997        | legado-web 存储契约：数据只落数据目录文件——1.8MB 书源 + 3000 章书架不报 QuotaExceededError / localStorage 无 `legado.*` 键 / 刷新后仍在 / 老浏览器数据一次性迁移 / 书源页搜索与 ⭐ 置顶落 `prefs.json`（缺 Chrome 自动 SKIP）                                                                                                                                                       |
| 单测 `plugin-host.test.ts`            | —           | 宿主动作桥：startChat 时序（等 cwd/等新对话才发 prompt）/ 未就绪拒绝 / newChat=false / compose 不依赖连接就绪                                                                                                                                                                                                                                                                       |
| 单测 `composer-bridge.test.ts`        | —           | 输入框注入桥：sink 缺失即整笔拒收（不出现「附件加了文本没加」的半截状态）/ 空内容拒收 / 注销后拒收 / 脏入参不抛错                                                                                                                                                                                                                                                                   |
| `extension-release.yml`               | —           | 打 tag 出浏览器扩展 zip（`npm run pack:extension` + Python zipfile 独立校验 manifest 在根目录且 CRC 全通过）并挂到 Release                                                                                                                                                                                                                                                          |
| 单测 `page-picker.test.ts`            | —           | page-picker 纯逻辑（jsdom）：定位串（短且唯一 / 兄弟冲突收窄 / 兜底全 nth-of-type）、HTML 骨架、XPath 与 DOM 路径、契约 → Markdown（三档体积、降级不输出 undefined、base64 不进正文）                                                                                                                                                                                               |
| 单测 `page-picker-background.test.ts` | —           | page-picker service worker（假 chrome）：投递决策与复制兜底、composeInPage 桥、截图裁剪数学（dpr 坐标 / 越界 / 可见比例 / 像素对齐）、截屏失败不影响投递                                                                                                                                                                                                                            |
| `composer-compose-test.mjs`           | 8900+       | 输入框注入桥 E2E（真 Chrome + 真服务端）：版本号 / compose 落进 textarea + 光标到末尾 / **不覆盖用户已打的字** / 附件去重与累加 / 文本+附件同时到位 / 空内容拒收 / 无 JS 报错（浏览器 E2E，不入 run-smoke，手动跑）                                                                                                                                                                 |
| 单测 `plugin-facilities.test.ts`      | —           | storage/secrets/deps/apiVersion 门控                                                                                                                                                                                                                                                                                                                                                |
| 单测 `plugin-settings.test.ts`        | —           | schema 解析/校验/持久化                                                                                                                                                                                                                                                                                                                                                             |
| 单测 `mcp-bridge.test.ts`             | —           | 握手/工具列表/调用/超时                                                                                                                                                                                                                                                                                                                                                             |
| 单测 `plugin-updater.test.ts`         | —           | 备份/回滚/prune/资源解析                                                                                                                                                                                                                                                                                                                                                            |
| 单测 `plugin-catalog.test.ts`         | —           | 插件市场：builtin+custom 合并/同 id 覆盖/source 校验/默认 id 推导/增删持久化                                                                                                                                                                                                                                                                                                        |
| `image-toolkit-core-test.mjs`         | —           | image-toolkit 纯 JS 图像内核：PNG（全 filter / 位深 / 调色板 / tRNS / 隔行报错）+ BMP 编解码往返、resize/crop/rotate/flip/adjust/水印/圆角/边框/直方图/主色、EXIF 解析                                                                                                                                                                                                              |
| `image-toolkit-test.mjs`              | 8912        | image-toolkit 插件：假 host 直测 4 个 AI 工具与 5 条路由（含目标体积/批量逐项报错/越界拒绝/格式与缺依赖提示）+ 真服务端接线 + 客户端纯逻辑（文案 key 对齐、尺寸与格式判定、ZIP 结构）                                                                                                                                                                                               |
| `image-toolkit-view-test.mjs`         | 8913        | image-toolkit 视图 E2E（真 Chrome + 打桩工作区接口）：导入/队列/各 tab/裁剪拖拽与锁比例/精确体积/导出下载/批量 ZIP/存回工作区/切语言/无 JS 报错（缺 Chrome 自动 SKIP）                                                                                                                                                                                                              |
| `page-picker-test.mjs`                | 8900+/9400+ | page-picker 扩展 E2E：注入真实 `dist/picker.js` + 真实 background 模块 + 真实 pi-web-ui 页面（Chromium 137 起 `--load-extension` 已被上游移除，自动化装不了真扩展，只能走等价路线）：选择器 / 命中的 CSS 行号（Vite `data-vite-dev-id`）/ React 源码位置与调用链 / 样式子集（只留与默认值不同的项）/ Markdown 落进真输入框 / 多选不串味 / 找不到页面时复制兜底 / 截图失败不影响投递 |
