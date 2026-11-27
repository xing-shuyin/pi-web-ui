# 插件系统

插件的形态、协议、manifest、宿主扩展点与能力模型都在这里，内置插件与生命周期、MCP 运行时也在本文。界面侧集成与 slot 框架见 [`architecture-plugin-ui.md`](architecture-plugin-ui.md)，宿主 API 清单见 [`architecture-plugin-host-api.md`](architecture-plugin-host-api.md)，市场 / 验收 / 运营面见 [`architecture-plugin-market.md`](architecture-plugin-market.md)。

> 可选界面组件，存放在 `<dataDir>/plugins/`。不装即不存在，attach 时热重扫。

## 目录

- [GitHub 日常工作台](#github-日常工作台)
- [图片预览与 OCR 提供者](#图片预览与-ocr-提供者)
- [生命周期约束](#生命周期约束)
- [MCP 项目运行时](#mcp-项目运行时)
  - [MCP OAuth 登录](#mcp-oauth-登录)
- [形态](#形态)
- [协议](#协议)
- [宿主扩展点](#宿主扩展点)
  - [扩展 API（v2 新增）](#扩展-apiv2-新增)
  - [外部通道网页续聊回传](#外部通道网页续聊回传)
  - [外部通道会话重置](#外部通道会话重置)
  - [插件目录：代码是纯缓存，状态独立存放（`plugin-paths.ts`★ / `plugin-materialize.ts`★）](#插件目录代码是纯缓存状态独立存放plugin-pathsts--plugin-materializets)
  - [宿主设施（plugin-facilities.ts）](#宿主设施plugin-facilitiests)
  - [声明式设置（`secret` 类型 / `optionsFrom` 动态候选值）与插件 SDK（plugin-sdk/）](#声明式设置secret-类型--optionsfrom-动态候选值与插件-sdkplugin-sdk)
  - [插件样式与统一色彩契约（Plugin Style & Theme Contract）](#插件样式与统一色彩契约plugin-style--theme-contract)
  - [能力声明与强制（manifest.permissions）](#能力声明与强制manifestpermissions)
  - [能力派生与新增族（v2）](#能力派生与新增族v2)
- [可逆副作用（effect 栈，DSH 对照 P0-2）](#可逆副作用effect-栈dsh-对照-p0-2)
- [manifest 可选字段](#manifest-可选字段)
- [插件 AI 工具的可见性与开关](#插件-ai-工具的可见性与开关)
- [MCP 工具桥（server/mcp-bridge.ts）](#mcp-工具桥servermcp-bridgets)

## GitHub 日常工作台

`plugins/github-workbench/`（官方 catalog，v0.1.3）通过 `rightpanel.tabs` 在右侧「文件列表」旁提供带 GitHub SVG 图标的「工作台」Tab，与当前对话并排使用，复用服务机器的 `gh` 登录。窄侧栏采用列表／详情切换，容器宽度 ≥480px 时并排展示，类型分段按钮和可展开搜索适配侧栏宽度；样式统一使用宿主主题变量。Tab 卸载时只保留内存中的筛选、页码、选中项、滚动位置和分条目评论草稿，切回可恢复，刷新页面／重载插件后清空。读取请求随卸载取消；在途写入等待完成，跨挂载共享提交锁，避免重复评论。仓库自动识别与个人待办可独立使用；仓库待办、待我评审、分配给我、我创建的、提到我、自定义搜索均按更新时间分页。详情展示正文、最近一页评论及 PR 分支／合并状态／改动统计，支持引用到当前对话草稿、评论、关闭／重新打开。「引用到对话」与「交给 AI 处理」均只添加简短引用附件（类型、编号、仓库、链接），由用户填写处理要求并发送，已有正文和附件保留，同一引用自动去重。完整 diff、CI 与代码行评审由 GitHub 链接查看，AI 可按用户要求获取最新信息。

事实源：`plugins/github-workbench/index.mjs`（异步 `gh api` 与已鉴权 HTTP 路由）、`client/entry.mjs`（Shadow DOM 工作台、Tab 状态恢复及宿主 `compose` 引用附件桥）、`client/styles.mjs`（主题与容器自适应样式）、`manifest.json`；安装与搜索语法见[插件 README](../plugins/github-workbench/README.md)。路由只包含 `/status`、`/items`、`/detail`、`/comment`、`/state`，写请求固定参数并以 JSON stdin 传内容，无 shell。所有外部文本转义，输入／输出／分页／超时有上限；插件卸载终止后端子进程，Tab 切换取消读取，过期详情响应不覆盖新选择，失败评论保留草稿，避免重复提交。客户端从 bundle URL 保留部署根路径；仅支持 github.com。定向守卫：`tests/unit/github-workbench.test.ts`、`tests/unit/github-workbench-client.test.ts`。


## 图片预览与 OCR 提供者

宿主桥 API v15 新增 `host.openImagePreview({src, alt?, onSaveAnnotation?, actions?})` 与 `host.imageOcrProviders.register({id, label, labelEn?, recognize})`。`recognize({src, signal, onProgress})` 返回 `Promise<{text:string}>`；进度为 0–1。注册返回注销函数，`list()` 仅返回 id/显示名。`onSaveAnnotation(dataUrl)` 仅在调用方能接收标注结果时提供，保存回调成功后关闭预览。`actions` 可传 `{id,label,onSelect,closeOnSelect?}` 在统一工具栏保留调用方的操作；图片工作台生图画廊用它保留编辑、参考图、复制路径、下载，删除旧的独立灯箱；旧宿主缺少桥 API 时回退新窗口原图。

`web/src/image-ocr-providers.ts` 是客户端 OCR 注册单源，注册归属加载时的插件作用域；`plugin-loader.ts` 在禁用/卸载、重载纪元变化和加载失败时清理提供者；禁用移除 bundle 时递增导入缓存盐，确保同一纪元重新启用也会执行顶层注册，避免命中 ESM 缓存后提供者无法恢复。正在加载的已禁用插件不能迟到注册或重新进入已加载集合。共用 `ImageLightbox` 订阅该注册表并管理取消与迟到结果，插件不得忽略取消信号。`plugins/image-ocr` 以 `preload:true` 的无视图插件提供本地中英文识别，真正的引擎/字库懒加载，外层 Worker 的终止同时结束初始化与识别的子 Worker。首次使用需联网取得程序/字库，图片不上传至识别服务。

预览里的 OCR 按钮始终可见；提供者缺失时，宿主复用现有插件安装后台作业安装官方插件，禁用的插件走设置启用，安装进度/错误保留在当前预览。完整入口和待发附件标注边界见 [`architecture-attachments.md`](architecture-attachments.md#统一图片预览ocr-与附件标注)。


## 生命周期约束

插件管理器按代次区分 activating、loaded 与失效实例；reload 合并并发请求，立即撤销在途激活已注册的副作用。旧激活恢复后只能清理自身，不能回写新代次的注册表；失效 host 禁止继续注册，迟到异步资源也必须回收。工具同步的已应用名称集合属于每个 SDK session，不能放在跨会话共享的单一集合中。

官方 live-preview 的隔离与专用访问路径见 [附件架构](architecture-attachments.md#活动内容隔离)。官方 SFTP 与远程工作区复用 `plugin-sdk/ssh-host-trust.mjs`，未知/变更主机密钥拒绝连接，可信配置见 [环境变量](env-vars.md#ssh-主机身份验证)。


## MCP 项目运行时

`server/mcp-project-runtime.ts` 的 registry 按规范化绝对 cwd 创建独立 `McpBridge` 和配置 watcher；bridge 的 cwd 创建后不再改写。SDK 会话创建先等待项目初始化，工具快照与后续同步按稳定 `conversation.cwd` 选择；DSH provider 显式传入自身 cwd。插件 `host.mcp` 在异步操作入口捕获 cwd。

全局配置共享磁盘文件，不共享连接实例：全局管理操作刷新所有已创建项目，项目操作只刷新所属项目，外部文件保存由各项目 watcher 处理。初始化、reload 和销毁均保留所属 entry 身份；reload 排在初始 load 后，关闭时先停 watcher、关闭 bridge，再等待在途操作清理。工具变化同步已有会话并重新应用门控，同时刷新对应项目客户端的 MCP 列表和设置。

**资源生命周期**：每个项目各有一份 bridge 和 watcher，连接数量是保留项目有效服务器数之和（全局服务器也按项目各建连接）。registry 每分钟按最近访问顺序检查，空闲超过 5 分钟、没有任何 Pi/DSH 保留会话引用且没有在途初始化、reload 或创建租约的项目自动 `disposeProject(cwd)`。所有后台、空闲与子代理会话都计入引用；所有权检查缺失或失败时保守保留。SDK 创建全过程持有租约，释放时重新计时；watcher 与工具变更广播不延长用户空闲时间。没有项目数硬限，保留会话本身仍可固定连接；关闭会话后才能进入回收条件。回收定时器 unref，server shutdown 清除定时器并统一销毁、等待在途操作。

### MCP OAuth 登录

HTTP MCP 卡片的 OAuth 登录通过 `mcp_oauth_start {reqId,name,scope}` 发起；ClientSession 内的 `McpOAuthUi` 从捕获的 cwd 解析精确作用域配置，调用 `mcp-oauth-login.ts`。`mcp_oauth_result` 只返回请求 ID、登录 ID、授权/回调地址与状态，不返回凭据或供应商原始错误。登录 ID 与请求 ID 均绑定发起客户端，不能由其他客户端完成或取消。

弹窗每 1.5 秒发送 `mcp_oauth_status {reqId,id}` 观察本机回环自动回调；远程浏览器可以粘贴完整跳转地址并发送 `mcp_oauth_finish {reqId,id,redirectUrl}`。成功持久化后使用登录开始时捕获的项目刷新 registry 的所有已创建项目（凭据由 agentDir 共享），并发完成请求共用一次 reload。弹窗卸载发送 `mcp_oauth_cancel {reqId}`，ClientSession 销毁也会取消；启动过程中取消会回收迟到的登录实例。完成记录在下一次登录时回收，不占满客户端的八个活动登录槽。



## 形态

一个插件 = `<dataDir>/plugins/<id>/` 目录：

- `manifest.json`（name/version/description）
- `index.mjs` 服务端入口（可选，`export default { activate(host) → deactivate? }`）
- `client/entry.mjs` 视图入口（可选，`export default { mount(el, ctx) → cleanup? }`）

**客户端依赖只能住在 `client/` 里**：宿主只服务 `client/*` 子树（见「静态服务」），所以
`client/entry.mjs` 的相对 import 一旦解析到 `client/` 之外（典型：写成了 `../sdk/index.mjs`），
浏览器会报 `Failed to fetch dynamically imported module` 并**整个 bundle 都不执行**（插件页空白，
而服务端毫无异常：manifest 校验通过、`active:true`、`error:null`）。`plugin create` 生成的骨架
因此按运行环境复制 SDK：服务端 `sdk/` 含 `index.mjs`、`client.mjs`、`client-utils.mjs`、
`testing.mjs`；客户端 `client/sdk/` 只复制 `client.mjs` 和 `client-utils.mjs`，另生成仅转导出
`./client.mjs` 的兼容 `index.mjs`，保留既有客户端导入路径。新模板直接导入 `./sdk/client.mjs`，
测试模板导入 `./sdk/testing.mjs`。生成后还跑一遍 `plugin-sdk/import-check.mjs` 报告越界/缺失
（回归：`tests/plugin-scaffold-test.mjs` + `tests/unit/plugin-import-check.test.ts`）。

`plugin-sdk/client.mjs` 是浏览器入口，导出 `defineView`、`defineRenderer`、UI 辅助并转导出
`client-utils.mjs`；这两个文件及完整依赖闭包禁止任何 Node 内置模块导入，也不包含测试 Harness。
`testing.mjs` 只供 Node 测试，导出 `createMockHost`，直接使用 `node:path` 的 `resolve` / `sep`
解析本平台路径，不模拟其他平台。服务端/兼容总入口 `index.mjs` 导出 `definePlugin`，同时转导出
客户端及测试入口，因此旧服务端脚本仍可全量导入。类型入口为 `index.d.ts`、`client.d.ts`、
`testing.d.ts`（共用 `index.d.ts` 的接口声明）；包子路径为 `/client`、`/testing`。
守卫：`tests/unit/plugin-sdk-browser-safe.test.ts`、`plugin-host-primitives.test.ts`、`plugin-sdk-mock.test.ts`。

`SDK_VERSION` 定义在 `client.mjs`，与 SDK `package.json` 版本同步。`plugin upgrade-sdk` 分别按
服务端与客户端清单补齐/刷新文件，支持旧版本从 `index.mjs` 读版本，补建被客户端引用但缺失的
`client/sdk/`，移除客户端误拷的 `testing.mjs` 并保留客户端兼容入口；重复升级应保持幂等。

**不装即不存在**——目录不在就没有任何协议/UI 痕迹；attach 时重扫目录，新丢进来的插件无需重启服务即出现在顶栏视图 tab（import 每进程一次并缓存；删除目录 → 下次 attach 反激活）。


## 协议

| 方向 | 消息                   | 作用                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 上行 | `plugin_message`       | 路由到该插件的 onMessage 处理器，回调第二参为 clientId；未知/非法 id 静默丢弃                                                                                                                                                                                                                                                                                                        |
| 上行 | `plugins_reload`       | 服务端热重载：反激活全部→重扫激活→epoch+1→重推清单。**只给 `index.mjs` 的 import 加 `?e=<epoch>` 缓存击穿** —— 服务端入口若静态 `import` 了自己的兄弟模块（如 `./lib.mjs`），那些模块会命中 Node ESM 模块缓存，**改了不随 reload 生效（必须重启服务）**；想让改动 reload 即生效就把纯函数内联进 `index.mjs`（客户端 bundle 同理：走 `?e=` 重拉，但它 import 的兄弟文件同样会被缓存） |
| 下行 | `plugins`              | attach 时推清单（plugins, epoch），epoch 用作前端 import 缓存击穿参数 `?e=`                                                                                                                                                                                                                                                                                                          |
| 下行 | `plugin_data`          | 默认广播给所有 socket，前端按 pluginId 扇出给已加载视图                                                                                                                                                                                                                                                                                                                              |
| 上行 | `plugin_path_response` | 用户对 `plugin_path_request` 的答复（id 回显）；同意即写进授权表                                                                                                                                                                                                                                                                                                                     |
| 上行 | `plugin_path_revoke`   | 撤销授权：给 `pluginId` 清它的全部 / 给 `pluginId`+`path` 只清该目录 / 都不给 = 清空整张表                                                                                                                                                                                                                                                                                           |
| 下行 | `plugin_path_request`  | 插件要访问工作区外目录 → 浏览器确认弹窗（未答复 120s 超时视为拒绝）                                                                                                                                                                                                                                                                                                                  |
| 下行 | `plugin_grants`        | 授权表快照（attach 推 + 授权 / 撤销后重推；设置面板「已授权目录」段用）                                                                                                                                                                                                                                                                                                              |



## 宿主扩展点

| 方法                                      | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `host.notify(level, text)`                | 发系统通知条（notice，前端 toast）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `host.sendTo(clientId, payload)`          | 定向发给单个 socket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `host.onToolEvent(h)`                     | 订阅 SDK 工具执行事件（phase:start\|end, toolName, conversationId?, toolCallId?, durationMs?, isError?）                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `host.onToolPre(h)`                       | 工具 pre 拦截（仅 bash/read）：allow/deny（含原因给模型看）/ask（暂按拒绝执行）；首个阻断胜出，抛错/超时弃权；要 tools 族                                                                                                                                                                                                                                                                                                                                                                                                            |
| `host.onToolPost(h)`                      | 工具 post 编辑（仅 bash/read）：回 content 换正文（脱敏/改写）、additionalContext 补上下文；逐个合并，抛错跳过；要 tools 族                                                                                                                                                                                                                                                                                                                                                                                                          |
| `host.onRunEvent(h)`                      | 订阅运行轨迹事件（run_start/message/tool_start/tool_end/turn_*/run_end；pi 全量，DSH / Universal 产出 turn_*，turn_first_token 为每次模型请求的首包 TTFT；轨迹/时间线插件聚合「任务→思考→工具→文件→结果」用，payload 已截断封顶）                                                                                                                                                                                                                                                                                                                                                                             |
| `host.getActiveConversation(opts?)`       | 读取对话快照（标题/消息/流式消息/统计——轨迹视图直接显示打开对话的时间线；只读引用，广播前必须抽摘要，禁止原样下发）。`{clientId}` = 该标签页正在看的对话（多标签页互不干扰），不传 = 最近活跃的**非子代理**会话（子代理跑得再勤也不会把用户正看的对话挤出去，见 `server/plugin-conversation-view.ts`）；快照带 `clientId` / `isSubagent` / `sessionFile` 等字段。⚠️ `conversationId` 是**每客户端**分配的命名空间（每个标签页都从 `c1` 起）——判定「是不是同一条对话」请看 `sessionFile`，跨标签页身份请用 `clientId` + `sessionFile` |
| `host.onConversationChanged(h)`           | 订阅「当前打开对话变了」（切历史会话/切 running 对话/新对话/切项目——轨迹类插件靠它重拉时间线，不等轮询）                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `host.onClientModelChanged(h)`            | 订阅「某客户端对话的模型切换成功」（回调收到切换后的快照，按 `clientId` 过滤即可只看本页）；**只在模型真的变了时发**——重复点同一个模型 / 重连重放 `set_model` 不重复触发，切换失败不发（0.99 前只能靠轮询快照的 `model` 变化）                                                                                                                                                                                                                                                                                                       |
| `host.registerAgentTool(tool)`            | 注册供 AI 调用的工具，返回注销函数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `host.onAttach(h)`                        | 注册「新客户端接入」钩子（每次浏览器 attach，含 plugins_reload 后的重接入）                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `host.registerCommand(cmd)`               | 注册斜杠命令（SlashCommandInfo source=plugin → 选择器 + prompt 拦截执行）                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `host.route(method, path, handler)`       | 挂载 HTTP 路由（`/plugins-api/:id/*`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `host.registerProxy(prefix, target)`      | 注册通用反向代理前缀：子路径去前缀透传到 127.0.0.1:port（相对路径/Range/SSE/ws 天然可用；目标锁回环防 SSRF；要 `http` 族；live-preview 用它实现 `/liveserver` + `/md` 预览）                                                                                                                                                                                                                                                                                                                                                         |
| `host.fs`                                 | 文件访问：工作区相对（WorkspaceFS：`list/read/readText/write/remove` + `stat/mkdir/append/glob`，锚定活 cwd 根，越界拒绝）＋ 跨目录 `requestAccess` / `authorizedDirs` / `listPath` / `readPath` / `readTextPath` / `writePath` / `removePath` / `statPath` / `mkdirPath` / `appendPath` / `globPath`（见「目录授权与跨目录 fs」）                                                                                                                                                                                                   |
| `host.ui.*`                               | 运行时注册 / 更新 / 移除 UI 条目（`register` / `update` / `remove`）、`arrange` 整理其它条目、`list` 自查（见「UI 扩展点（slot 框架）」）                                                                                                                                                                                                                                                                                                                                                                                            |
| `host.project.create`                     | 在**已授权**目录里组装项目（mkdir / clone / 写文件 / git init，见「项目组装 API」）                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `host.llm.complete(req)`                  | 孤立无工具的一次性模型补全（总结/翻译/分类，不建对话不进历史；`{prompt, system?, model?, maxChars?, timeoutMs?, images?, signal?}` → `{ok, text?, model?, usage?, error?}`；要 `llm` 能力族，DSH 下回 `{ok:false}`）                                                                                                                                                                                                                                                                                                                 |
| `host.getSettings()`                      | 读取声明式设置（manifest.settings schema）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `host.onSettingsChanged(h)`               | 订阅设置变更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `host.registerBackgroundTask(task)`       | 注册插件常驻任务，并入顶栏「后台任务」面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `host.leftPanel.setRunning(items, opts?)` | 左栏「运行的对话」里登记插件运行条目（仅展示，需要能力 `ui`）。整体替换本插件条目并**同时作为心跳**；`opts.ttlMs` 缺省 60 秒、夹取 5 秒–1 小时，超时没有再次调用整组自动清空；反激活自动清空                                                                                                                                                                                                                                                                                                                                         |
| `host.leftPanel.clear()`                  | 立即清空本插件在左栏的运行条目                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `host.notifyCwd(cwd)`                     | 当主应用 set_cwd 成功后通知插件（幂等去重，异常隔离）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 扩展 API（v2 新增）

> 并行任务在 `server/plugins.ts` 加宿主方法本体、在 `web/` 加渲染（plugin-host v8、
> 新 slot/kind、messageWidget）；本节只定「调什么、要什么权限、拿不到回什么」。
> 接线位置：`server/index.ts`「插件扩展点 v2」块（`(pm as any).xxx` 防御性注入，
> PluginManager 无该字段时赋值无害）+ `server/agent-service.ts` 的 `*ForPlugins`
> 只读方法（复用现有逻辑组装数据，不 emit 不改状态）。DSH 引擎无这些方法，
> 一律走「无注入回退」列，绝不抛错。

| API                                        | 一句话                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 门控（permissions 族）                     | 无注入回退                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.conversations.list()`                | 本客户端运行中对话 + 当前项目历史会话（`{id,title,cwd,kind,isStreaming}`，历史最多 50）                                                                                                                                                                                                                                                                                                                                                                | 无（只读）                                 | 空数组（插件显示空态）                                                                                                                                                                                                                              |
| `host.conversations.search(query, limit?)` | 复用 search_sessions 全文判定，回前 N 个 `{id,title}`                                                                                                                                                                                                                                                                                                                                                                                                  | 无（只读）                                 | 空数组                                                                                                                                                                                                                                              |
| `host.prompt(conversationId, text)`        | 向指定对话投递 prompt（非当前对话先 switch 再走 prompt 全路径；找不到对话回错）                                                                                                                                                                                                                                                                                                                                                                        | `chat`                                     | `{ok:false,error}`（DSH 引擎亦如此）                                                                                                                                                                                                                |
| `host.steer(conversationId, text)`         | 向指定对话注入转向（`steerForPlugins`：本机直调 `sendUserMessage(text,{deliverAs:'steer'})`，跨客户端经 `steerElsewhere` 钩子）                                                                                                                                                                                                                                                                                                                        | `chat`                                     | `{ok:false,error}`（未知对话/空文本/DSH 时）                                                                                                                                                                                                        |
| `host.abortRun(conversationId)`            | 中止指定对话（复用 abort 的 interruptRun，卡住/空转强制重置；未在跑幂等成功）                                                                                                                                                                                                                                                                                                                                                                          | `chat`                                     | `{ok:false,error:"not supported"}`（DSH/无客户端时）                                                                                                                                                                                                |
| `host.chat(req)`                           | 无头投递外部文本（`{text,accountId?,cwd?,conversationId?,model?,thinkingLevel?}`：conversationId 命中走 steer 投递、miss 回落无头；cwd 须存在且非系统目录；模型/思考强度预切，失败即拒绝）。回执带稳定 `runId` 与 SDK `sessionId`：通道发起的轮次必须按 `runId` 认领 `onRunEvent`；已绑定通道会话中的网页续聊可按稳定 `sessionId` 回传，须校验联系人和会话重置代次，不能凭局部 `conversationId` 猜测。事件同样携带 `sessionId`，过户、改名不改变该身份 | `chat`                                     | 抛错（宿主未接 chatProvider / DSH 引擎 / 校验失败时）                                                                                                                                                                                               |
| `host.chatWait(...)`                       | 等一轮 run 结算再回                                                                                                                                                                                                                                                                                                                                                                                                                                    | `chat`                                     | `{ok:false}`（不等，由调用方超时兜底）                                                                                                                                                                                                              |
| `host.inbox.claim/complete/fail`           | 本地投递账本（至少一次 + 幂等键）：claim 幂等占位、complete/fail 记账、pending/dead 排障；跨重启有效，不依赖设备中心                                                                                                                                                                                                                                                                                                                                   | -（纯本地记账）                            | 无注入时 `claim` 恒返回 `new`（插件自行回退内存去重）                                                                                                                                                                                               |
| `host.llm.complete(req)`                   | 孤立无工具的一次性补全（`{prompt,system?,model?,maxChars?,timeoutMs?,images?,signal?}` → `{ok,text?,model?,usage?,error?}`，不建对话；实现见 `server/plugin-llm.ts`，经 `completeForPlugins` + `llmProvider` 注入）                                                                                                                                                                                                                                    | `llm`                                      | `{ok:false,error}`（DSH 引擎亦如此）                                                                                                                                                                                                                |
| `host.fs.watch(path, cb)`                  | 订阅文件变化（复用服务端 watcher）                                                                                                                                                                                                                                                                                                                                                                                                                     | `fs:read`                                  | 不回调（静默无事件）                                                                                                                                                                                                                                |
| `host.scm(kind, opts?)`                    | 只读 git 查询（复用 server/scm.ts）                                                                                                                                                                                                                                                                                                                                                                                                                    | `fs:read`                                  | `{ok:false,error}`                                                                                                                                                                                                                                  |
| `host.bash(cmd, opts?)`                    | 跑一条服务端 shell                                                                                                                                                                                                                                                                                                                                                                                                                                     | `tools`                                    | `{ok:false,error:"not supported"}`                                                                                                                                                                                                                  |
| `host.schedule(spec, task, opts?)`         | 毫秒间隔或全 5 字段 cron（`"0 9 * * *"`，服务器本地时区）；`opts.persistent` 落盘 `<pluginDir>/schedules.json`，重启后重调即重建（要合法 id；`catchUp:"once"` 补跑一次），自动进后台任务面板                                                                                                                                                                                                                                                           | 无（直跑，见 `server/plugin-schedule.ts`） | —（非法形状抛错）                                                                                                                                                                                                                                   |
| `host.models.list()`                       | `{id,provider,vision}`（走缓存目录，不触发网络 refresh）                                                                                                                                                                                                                                                                                                                                                                                               | 无（只读）                                 | 空数组                                                                                                                                                                                                                                              |
| `host.onStats(cb)` / emitStats             | 会话统计推送（tokens/cost/contextUsage，见 `PluginStats`）                                                                                                                                                                                                                                                                                                                                                                                             | 无                                         | 不推送（插件用快照 stats 兜底）                                                                                                                                                                                                                     |
| `host.onStreaming(cb)` / emitStreaming     | 流式增量推送                                                                                                                                                                                                                                                                                                                                                                                                                                           | 无                                         | 不推送（插件轮询快照兜底）                                                                                                                                                                                                                          |
| `host.events.emit/on(topic, payload)`      | 插件间事件总线（`PluginBusEvent`，载荷 4KB 截断）                                                                                                                                                                                                                                                                                                                                                                                                      | 无                                         | emit 丢弃、on 不回调                                                                                                                                                                                                                                |
| `host.net.fetch(url, opts?)`               | 出站网络（netAllowlist 全等/点号后缀命中才放）                                                                                                                                                                                                                                                                                                                                                                                                         | `net`                                      | 拒绝并报缺白名单/缺 net 族                                                                                                                                                                                                                          |
| `host.dialog.*`                            | select/confirm/input（对齐扩展 ui 桥）                                                                                                                                                                                                                                                                                                                                                                                                                 | `ui`                                       | 抛错拒绝（调用方回退 notice 提示用户）                                                                                                                                                                                                              |
| `host.notifyAction(...)`                   | 通知条带动作按钮，点后回插件                                                                                                                                                                                                                                                                                                                                                                                                                           | `ui`                                       | 退化成普通 notify（无按钮）                                                                                                                                                                                                                         |
| `host.shortcuts.register(...)`             | 注册快捷键（宿主负责冲突与展示）                                                                                                                                                                                                                                                                                                                                                                                                                       | `ui`                                       | 忽略注册                                                                                                                                                                                                                                            |
| `host.searchProviders.register(...)`       | 全局搜索（Ctrl+K）结果提供方                                                                                                                                                                                                                                                                                                                                                                                                                           | `ui`                                       | 不搜（无该来源）                                                                                                                                                                                                                                    |
| `host.composerProviders.register(...)`     | `@` 提及提供方（宿主 API v9）：`search(q)` 回 `{title,hint?,text?,attachments?}`，选中后文本写进光标处、附件进 chips                                                                                                                                                                                                                                                                                                                                   | `ui`                                       | 三个内置：文件（`@` + 文件名 → reference chip，经 search_files）、已授权页面（`@` + 标题/origin → `page` 网页引用 chip，读 page-picker 状态缓存）与技能（`@` 或 `@skill:` + 技能名 → `@skill:<name>` 词元，供 Pi 运行时扩展提升为系统级工作流指令） |
| `host.onTheme(cb)`                         | 主题切换订阅                                                                                                                                                                                                                                                                                                                                                                                                                                           | 无                                         | 不回调（用首次下发主题）                                                                                                                                                                                                                            |
| 新 slot（`UiSlotId` 新增挂载点）           | 别名 + 枚举两端同口径（只改一边 = 注册了但界面上没有，见常见坑）                                                                                                                                                                                                                                                                                                                                                                                       | `ui`                                       | 未知 slot 静默丢弃（既有语义）                                                                                                                                                                                                                      |
| 新 kind（toggle/input/progress 等）        | 开关态/输入值/进度经 `host.ui.update` 刷新，progress 越界宿主钳制（语义见 `tests/unit/plugin-extensions.test.ts`）                                                                                                                                                                                                                                                                                                                                     | `ui`                                       | 不认识的 kind 按缺省 action 画                                                                                                                                                                                                                      |
| messageWidget（plugin-fence 消息级挂件）   | 在指定消息下挂小部件（renderer 的消息级形态，不共享 React 实例）                                                                                                                                                                                                                                                                                                                                                                                       | `ui`                                       | 不挂载（消息原文不受影响）                                                                                                                                                                                                                          |

### 外部通道网页续聊回传

通道会话由联系人、群、频道及线程的稳定作用域持有，网页共享查看不改变执行归属。通道发起的运行按回执 `runId` 认领；网页主动发起且没有通道运行标记的运行，必须先收到 `run_start`，再按已绑定的 SDK `sessionId` 收集最终助手正文并回传原目的地。旧宿主只允许完整 `clientId + conversationId`，不得按裸 `c1` 猜测；未知 `runId` 不得借用会话绑定。结束事件重复到达不能重复投递。

路由恢复须同时校验通道账号、目的地、会话重置代次；重置、退出账号或切换作用域后旧绑定失效。工具调用前言不作为最终回复，超时回执和早到事件仍按同一身份规则处理。平台的 webhook、会话回复窗口、主动发送权限继续有效，失败须诚实反馈。插件及其路由辅助文件保持独立安装，不依赖其他通道插件目录。

### 外部通道会话重置

微信、QQ、Telegram、Discord、Slack、Matrix、飞书、钉钉、企业微信、WhatsApp 和 iMessage 的 `/new`、`/clear`、`/reset` 共用各通道自己的会话切换流程。命令词支持大小写和全角形式；参数原文保留，重置命令后的提示词直接进入新会话，不再次作为命令解析。已有数字快捷方式使用同一流程。

切换上下文必须同时轮换 `accountId` 中的会话代次并移除旧 `conversationId`，仅删除本地映射不能保证宿主创建空白会话。微信、QQ 的显式新建还须脱离旧网页投递绑定。工作区（`/cwd`、`/workspace`）、模型和思考强度的成功修改同样切换上下文；无参数查询保留当前上下文。

下载、排队和 `host.chat` 请求持有启动时的代次。重置后的迟到回执、结束事件和异步设置验证不得覆盖新会话状态；迟到的旧运行按真实 `runId` 中止。运行中不能切换的通道必须明确提示先停止，不能回报重置成功。历史记录保留，中止失败须告知用户。回归见 `tests/unit/channel-plugins.test.ts` 和各通道的行为、重置测试。

### 插件目录：代码是纯缓存，状态独立存放（`plugin-paths.ts`★ / `plugin-materialize.ts`★）

插件在数据目录里拆成两个互不干扰的根：

| 路径                          | 内容                                                  | 可丢弃？                                        |
| ----------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `<dataDir>/plugins/<id>/`     | 代码本体（manifest / index.mjs / client / 依赖）      | **可以**：随包插件可重放，`node_modules` 可重装 |
| `<dataDir>/plugin-data/<id>/` | 状态：`storage.json`、`secrets.bin`、`schedules.json` | **不可以**：用户配置、渠道授权、定时任务进度    |

- 状态路径只走 `pluginStateDir()` / `pluginStateFile()`；老布局（状态住在代码目录）在扫描/激活时由
  `migratePluginState()` 幂等搬过去，两边都有时以状态目录为准（绝不拿旧副本覆盖新状态）。
- 代码目录的物化由 `materializePlugin()` 负责，并留一份回执 `.pi-materialized.json`：
  **存在 ≠ 已准备** —— 回执登记的每个文件都还在才算装好；目录在但缺回执/缺文件 = 半残，下次启动就地补齐。
  新装走 staging + rename 原子落盘，复制后验收（`manifest.json` 在 + 文件数 > 0）失败就报错，绝不签收空目录。
- 复制黑名单（`.git` / `node_modules` / `whisper-cache`）**只允许**在 `server/fs-copy.ts` 里按
  **相对路径**判定。历史事故：三处各自拿 `cpSync` 的绝对路径去匹配 `node_modules`，而 npm -g 安装时
  包目录本身就在 `…/node_modules/pi-web-ui` 下，整棵树被过滤成空副本还被当成已安装（issue #856）。
- 卸载会同时删掉状态目录（重装不闯回旧设置）；回滚只回滚代码，状态不回滚。

### 宿主设施（plugin-facilities.ts）

| 设施         | 说明                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `storage`    | `<dataDir>/plugin-data/<id>/storage.json` 原子 KV                    |
| `secrets`    | AES-256-GCM 加密机密，密钥 `<dataDir>/secrets.key`，拷机 fail closed |
| `ensureDeps` | npm 自动补装单飞；带 range 的 spec 按版本判在位（见下条）            |

- 依赖版本：`host.ensureDeps(["pkg@~1.4.0"])` 里的 range 会真的比较已装版本（认 `1.2.3` / `^1.2.3` / `~1.2.3` / `>=1.2.3`，认不出的写法放行，避免每次请求都跑 `npm install`）。装了 range 外的旧版会被补装升级 —— 插件换依赖后，已装过老版本的用户才会真的换上新依赖（issue #995）；裸包名仍只判在位。

### 声明式设置（`secret` 类型 / `optionsFrom` 动态候选值）与插件 SDK（plugin-sdk/）

- `settings` schema 第六种类型 `secret`：与 `password`（前端掩码、明文存 storage.json）不同，
  `secret` 存加密 `secrets`（键 `setting:<key>`，明文永不落盘）。浏览器侧 `settingsValues` 只看到
  有无（布尔），插件运行时 `getSettings()` 才拿到真值；保存时空串 = 不改。`PluginSecrets`
  跨实例共享同一文件缓存（保存与读取走不同实例也不会读到旧值）。
- `settings` schema 的 `select` 除了静态 `options`，还可以写 **`optionsFrom`** 让宿主现算候选值
  （插件不必自己维护会过期的清单）：`"models"` = 已配置鉴权的模型（值 `provider/id`，
  标签同设置面板的模型选择器）/ `"thinkingLevels"` = SDK 思考强度档位（`off`…`max`，标签走
  `thinking.<值>`）。两者都会在最前面补一个空值选项 = **跟随全局默认**（插件侧拿到空串自行回落）；
  候选值在**浏览器侧**算（`web/src/plugin-setting-options.ts`，模型清单来自 `UiSettingsState.subagentModels`），
  因此服务端**不校验**带 `optionsFrom` 字段的值（只做 200 字符长度护栏），非法值由用的时候
  （如 `host.chat` 切模型）报错；当前存值不在清单里（模型被删/手改过 storage.json）时也保留，
  不被下拉静默吃掉。例：`wechat-ilink` 的「模型」「思考强度」即此两源。
- 表单布局：**单列行式**（标签固定左列 + 控件右列，勾选框贴标签，`hint` 常显在标签下的小字，
  ≤720px 上下堆叠），样式全在 `web/src/styles.css` 的 `.plugin-settings-*` 段；渲染在
  `web/src/components/PluginSettingsForm.tsx`。字段行带 `data-key`（= schema 的 `key`），
  便于按字段定位/调试。
- `plugin-sdk/` 起手包：服务端总入口 `index.mjs`、浏览器入口 `client.mjs`、Node 测试入口
  `testing.mjs` 与各自类型入口；运行环境和复制边界见上文「形态」，示例见 `plugin-sdk/README.md`。

### 插件样式与统一色彩契约（Plugin Style & Theme Contract）

所有挂载于宿主视图、抽屉、浮层或插槽的插件界面，必须遵循统一的主题色彩契约：

1. **统一继承宿主 CSS 变量**：
   插件挂载在宿主 DOM 树中，全局继承 `:root` 主题令牌（`--bg`, `--bg-elev`, `--border`, `--text`, `--accent`, `--accent-contrast` 等）。每一项可附加合理硬编码回退值保证无宿主时独立打开可用。
2. **实底配对反色令牌铁律（杜绝打地鼠白底白字）**：
   - **强调色实底**：`background: var(--accent)` 必须且只能配对前景 `color: var(--accent-contrast, #fff)`；严禁硬编码 `color: #fff`（在 `flow`/`wallpaper-flow` 等浅色/纯白强调色主题下会变成白底白字隐形）；
   - **别名变量必须成对声明**：插件若因作用域隔离私设命名空间变量（如 `--nt-accent`），**必须同时声明** `--nt-accent-contrast: var(--accent-contrast, #fff)`，严禁只别名底色而漏掉前景反色；
   - **语义色实底**：`background: var(--green|--amber|--red|--blue)` 必须配对 `color: var(--on-green|--on-amber|--on-red|--on-blue)`；
   - **染色/半透明底**：使用 `--accent-soft` 或 `color-mix(...)` 底色的控件，前景跟随常规正文色 `color: var(--text)`。
3. **推荐复用宿主组件基线**：
   宿主已全局注入 `.btn` 和 `.btn.primary`（已内置对比度与 hover 滤镜），主操作按钮推荐优先复用宿主 `.btn.primary`，避免重复手写。
4. **CI 静态体检硬拦截**：
   `tests/unit/accent-contrast.test.ts` 与 `tests/unit/semantic-contrast.test.ts` 会动态追溯所有内置插件代码中的别名与前缀变量，一旦出现未配对或硬编码白字即刻红牌阻断。

### 能力声明与强制（manifest.permissions）

宿主自控 API 按**能力族**强制拦截，未声明的族拒绝并报「缺哪族」：

| 声明族  | 覆盖的宿主 API                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs`    | `host.fs`（含跨目录 `*Path` 族）与 `host.project.create`                                                                                                         |
| `ui`    | manifest `"ui"` 与 `host.ui.*`（未声明 → 整份 `ui` 被忽略、运行时请求被拒）                                                                                      |
| `tools` | `host.registerAgentTool`                                                                                                                                         |
| `http`  | `host.route` + `host.registerProxy`                                                                                                                              |
| `chat`  | `host.chat`（无头调用）                                                                                                                                          |
| `llm`   | `host.llm.complete`（孤立无工具补全；实现见 `server/plugin-llm.ts`，经 agent-service `completeForPlugins` + index.ts `llmProvider` 注入；DSH 下回 `{ok:false}`） |
| `decorate` | manifest `chatDecorations`（聊天正文装饰）：客户端编译时校验，未声明即整份忽略；宿主执行，不需要 `dom` 授权（见 `architecture-plugin-ui.md` 的「聊天正文装饰」） |

`host.llm.supportsImages === true` 表示宿主支持图片入参。`images?: Array<{data: string; mimeType: string}>` 使用标准带 padding 的纯 base64（不带 data URL）；仅接受 JPEG/PNG/WebP，并校验解码签名与 MIME 一致。最多 8 张，每张解码后 ≤1 MiB，合计 ≤6 MiB；超限或无效输入在创建 SDK 会话前拒绝。图片通过 SDK `prompt(text, {images})` 传入；当前模型不支持图片时显式返回 `{ok:false,error}`。可选 `signal?: AbortSignal` 仅用于宿主进程内取消，不经 JSON 传输；取消或超时会 abort/dispose 会话，成功或失败均清除计时器。初始化期间取消后，迟到的会话也会回收；并发位保留到实际任务结束。

**严格模式** = 声明了 `permissions` **或** `apiVersion >= 2`；**旧全权模式** = 未声明 `permissions` 且
`apiVersion < 2`（放行但每激活期警告一次「apiVersion 2 起将默认拒绝」）。宿主 API 版本
`PLUGIN_API_VERSION = 2`，`apiVersion` 高于它的插件直接拒绝激活并提示升级 pi-web-ui（而不是运行期
撞 undefined 接口）。

### 能力派生与新增族（v2）

- `fs:read` / `fs:write` 由 `fs` 派生：旧 `fs` 等价于读写全开（向后兼容）；只声明 `fs:read` → 跨目录写（`*Path` 写族）与 `project.create` 被拒（读放行）；只声明 `fs:write` → 读被拒。缺哪族报错里写明哪族。
- `net` + `netAllowlist`：permissions 含 `net` 才可出站；manifest.netAllowlist 逐主机判定（全等或点号后缀，见 `tests/unit/plugin-extensions.test.ts` 的 hostMatches）；缺表/空表 = 全拒，未命中即拒。
- `dom:anchor`：仅限 anchors 挂载点的范围 DOM（免用户授权）；完整 `document` 仍需 `dom` + 用户授权（见「特权 DOM 访问」）——两者是「范围」与「整页」之别。


## 可逆副作用（effect 栈，DSH 对照 P0-2）

插件注册的一切都是**可逆副作用**。宿主内部的 `PluginEffectStack`（`server/plugins.ts`，
导出供单测）在插件激活期间收集每条注册/订阅的 disposer（带 label），反激活（禁用 / 卸载 /
`plugins_reload` / 关机）时**逆序回卷**：

| 注册面                                                                                                                                                                 | 栈里记的 label                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `host.registerAgentTool`                                                                                                                                               | `agentTool:<name>`                                                           |
| `host.registerCommand`                                                                                                                                                 | `command:/<name>`                                                            |
| `host.route`                                                                                                                                                           | `route:<METHOD> <path>`                                                      |
| `host.registerProxy`                                                                                                                                                   | `proxy:<prefix>`                                                             |
| `host.fs.watch`                                                                                                                                                        | `watch:<relPath>`                                                            |
| `host.schedule`                                                                                                                                                        | `schedule:<id>`                                                              |
| `host.registerBackgroundTask`                                                                                                                                          | `bgTask:<id>`                                                                |
| `host.leftPanel.setRunning`                                                                                                                                            | `leftPanel`（反激活时清空本插件条目）                                        |
| `host.ui.register`                                                                                                                                                     | `ui:register(<ids>)`                                                         |
| `host.events.on` / `onStats` / `onStreaming` / `onSettingsChanged` / `onMessage` / `onToolEvent` / `onRunEvent` / `onAttach` / `onCwdChange` / `onConversationChanged` | 对应方法名                                                                   |
| `host.effect(label, dispose)`                                                                                                                                          | `plugin:<label>`（插件**自建**的副作用：自建 interval / 监听器 / WebSocket） |

语义细节：

- 插件调用**返回的注销函数** = 只撤这一条（幂等）；不调用也无所谓 —— 反激活会兜底。
- `release()` 逆序跑，**cleanup 抛错只记一条诊断**（`pushRuntimeDiag`），不阻断其它清理；
  返回失败标签列表供日志。
- **激活中途失败**（`activate()` 抛错）时，这一轮已登记的副作用先逆序撤干净，再落错误占位行
  —— 半途注册的工具/路由/定时器不会留给一个已经坏掉的插件。
- `dispose()`（关机 / `reload()`）对每个插件先回卷 effect 栈、再兜底清按 pluginId 索引的
  代理前缀与后台任务，最后清空全局表。
- 单测：`tests/unit/plugin-effects-install-spec.test.ts`（逆序 / 幂等 / 抛错隔离 / 真实
  `PluginManager` 反激活后工具·命令·路由·总线订阅·自建 effect 全回收，`effects.size` 归零）。


## manifest 可选字段

- `name` / `nameEn`（插件显示名；`name` 是源语言（中文），`nameEn` 是英文。宿主**按全局界面语言**选词，插件不保存语言偏好 —— 见「插件界面语言」）
- `icon`（emoji/单字符，顶栏 tab 替代通用拼图图标）
- `iconSvg`（内联 SVG 字符串，有则优先于 `icon` 渲染：顶栏视图 tab / 右栏 tab / 设置面板列表与市场都画 SVG；服务端只做形状校验（`<svg…</svg>`、≤8KB、无 script/事件处理器，见 `server/icon-svg.ts`），前端渲染前再 sanitize 一次（见 `web/src/plugin-icon.tsx`）；`icon` 保留作旧版回落）
- `description` / `descriptionEn`（设置面板/市场里的插件介绍；视图 tab 的悬浮提示只用插件名，不用它）
- `version`
- `apiVersion`（与 `PLUGIN_API_VERSION` 比较，> 则拒绝激活并提示升级）
- `permissions`（能力声明数组）
- `settings`（声明式设置 schema → ⚙ 面板自动渲染表单）
- 用户 overlay（P2-9，不在 manifest 里）：`<dataDir>/plugin-overrides/<id>.json` 的 `settings` 节——三层合并 schema 默认 < overlay < 面板保存值。overlay 是用户钉住的新默认值（不 fork 改官方默认，更新不丢）；面板保存永远最高；secret 永不来自 overlay；坏键警告进诊断（`settingsSources` 标注每键来源 default/override/stored）
- `view`（布尔，缺省 `true`）：是否有独立视图 tab。**纯 renderer 插件写 `false`**，
  前端不会急着加载它的 bundle，只在消息里命中围栏时才懒加载
- `preload`（布尔，缺省 `false`）：`view:false` 时仍**每次进页预加载** client bundle。
  给「没有视图 tab、但顶层代码必须一直跑」的插件用（常驻浮窗、提醒轮询、快捷键…）：
  这类插件的 bundle 可以没有 `export default { mount }`，顶层代码跑完就算加载成功；
  实现见 `web/src/plugin-loader.ts` 的 `preloaded` 集合（不进视图注册表，因此不产生 tab）
- `renderers`（字符串数组）：该插件能渲染的 fenced-code 语言（`"mermaid"` 等），
  与 `client/entry.mjs` 的 `default.renderers[lang]` 一一对应
- `chatDecorations`（数组）：聊天正文装饰规则（`{ id?, pattern, flags?, style?: { color? / backgroundColor? / fontWeight? } }`），
  样式值可写成 `{ "setting": "<settingsSchema 的 key>" }` 让用户改；需要 `permissions` 含 `decorate`，
  由宿主用 CSS Custom Highlight 注入，只改颜色/字重、不改文本（见 `architecture-plugin-ui.md` 的「聊天正文装饰」）
- `ui`（对象）：插件对宿主 UI 的**全部贡献**（slot 条目 + `arrange` 整理意图，见「UI 扩展点（slot 框架）」）；
  严格模式下需要 `permissions` 含 `ui` 族，否则整份忽略
- `build`（对象，可选）：源码安装时的构建声明（`{ install?, command, outputs? }`，见
  「源码安装（--build）」）
- `netAllowlist`（字符串数组）：出站主机白名单（permissions 含 `net` 时生效，未命中即拒，空 = 全拒）
- `engines`（对象，如 `{"pi-web-ui": ">=1.2.0"}`）：引擎约束，不满足即拒绝激活；范围支持 `>=`/`^`/精确，非法 range 放行（语义见 `tests/unit/plugin-extensions.test.ts` 的 satisfiesEngines）
- `peerPlugins`（字符串数组）：对等依赖的其它插件 id，缺失只警告不断活
- `requires`（对象，P2-8 硬依赖）：`{ hostApi?, families?, plugins? }`，任一条不满足即拒绝激活+教学式错误——`hostApi` 是宿主 API 下限（超前请升级）、`families` 须是已知族且须同时在自家 `permissions` 里声明、`plugins` 须已安装且激活成功。`ensureLoaded` 按依赖拓扑排序激活（环直接拒），提供方被删/失败后消费方一并反激活+留占位（级联一轮收敛，reload 重算刷新）
- `agentToolsDefaultOn`（布尔，缺省 `false` 即默认关）：插件 AI 工具是否默认进入对话。不写就是默认关（新用户出厂`disabledPluginTools`里自带，需手动打开；只影响新用户与恢复默认，存量配置不动）；设为 `true` 即 opt-in 默认开。新增插件工具必须同步加入出厂名单，否则守卫测试会红（见 `tests/unit/plugin-tools-default-off.test.ts`）


## 插件 AI 工具的可见性与开关

`host.registerAgentTool` 注册的工具以前只进会话、对用户不可见也不可关。现在两处可看、
一处可关：设置 → 界面插件里每个插件下展开自己的工具（名/label/description）并逐个开关；
设置 → 工具页底部有按插件分组的汇总区（同一开关）。实现：`UiPluginInfo.agentTools`
只读快照（`plugins.ts:agentToolsSnapshot`，随 `plugins` 清单下发，注册/注销经 `pushToAll`
刷新）；开关是全局 `disabledPluginTools` 名单（`client-state` 持久化 + 预设随行，未知条目保留，
重装仍关闭；DSH 无插件宿主，固定空数组）。会话创建与 `syncPluginTools` 按名单过滤
（MCP 桥工具同管线、同名单），设置变更经 `refreshPluginTools` 推全部分会话、live 生效无需 reload。



## MCP 工具桥（server/mcp-bridge.ts）

**项目归属**：Bridge 与监视器按项目隔离，连接及回收边界见上文「MCP 项目运行时」。管理操作在 await 前捕获项目目录，避免管理页读写 B 的配置却重载 A 的实例。

**配置与状态**：项目同名配置覆盖全局配置，全局列表行标记 `overriddenBy`，不借用项目实例的工具与运行状态。新配置启动失败而保留旧实例时，状态带 `usingPreviousConfig` 和错误详情，管理页显示失败原因。参数编辑保留字符串数组的边界（包括空参数、空格和反斜线）；未编辑的 `protocolVersion` 等配置字段随保存保留。启用开关与实际运行状态分别展示。

**Skill 目录同步**：`server/skill-maintenance.ts` 将目录技能作为完整资源包复制或链接（Windows 目录链接使用 junction），包括脚本、参考资料和资源；独立 Markdown 技能保持单文件兼容。路径判断使用路径段及物理路径，拒绝递归目标、越界资源链接、循环和冲突，复制失败只清理本次创建的目标。

读取 `<dataDir>/mcp.json` 启动外部 MCP 服务器（stdio、换行分隔 JSON-RPC，零三方依赖；`{servers:{名:{command,args,cwd,env}}}`），握手 initialize→initialized→tools/list→tools/call 后把每个远端工具适配成 PluginAgentTool（命名与曝光方式见下一条），并入 plugin.d.ts 的 pluginToolsProvider（与插件工具同一 customTools 管线）。单服务器失败隔离（rejectAll + 日志，不炸进程）；dispose 时 kill 子进程；请求按 id 匹配 + 超时看门狗。

**工具的命名与暴露方式（`exposure` / `toolExposure`，issue #941）**：每个远端工具注册成 `mcp__<服务器>__<工具>`（服务器名里的 `-` 换成 `_`，工具名仍走 `sanitizeToolName`），并带上 `namespace = { name: "mcp__<服务器>", description: 该服务器 description }` 与解析出的 `exposure`；命名与暴露的唯一来源是 `mcp-bridge.ts` 的 `mcpToolRegistration()`（`server/plugins.ts` 的 `PluginAgentTool` 与 `packages/keel/src/agent-formatters.ts` 原样透传给 SDK 的 `ToolDefinition`，`getMcpToolServer()` 的 WeakMap 语义不变，Bot 的 `mcpServers` 白名单仍按服务器名匹配）。**默认 `codemode`（与 pi 一致）**：不内联声明进上下文、只在 codemode 脚本里调用，因此工具多的服务器（例如 63 个工具的驱动）不再把全部 schema 塞进提示词；`deferred` 走 `tool_search` 按需加载，`direct` 内联声明，`hidden` 注册但不可达。解析规则：`parseMcpConfig` 读 `exposure` 与 `toolExposure`，旧写法 `codemode-deferred` 归一成 `codemode`，非法值**逐项忽略**（写坏的旧 `mcp.json` 不因此失效，服务器照常起）；单工具解析 = exact 工具名优先 → 书写顺序第一个命中的 `*` 模式 → 服务器默认，模式匹配的是**服务器给出的原始工具名**（不是命名空间后的名字）。门控：`server/tool-manager.ts:applyAgentToolsGating()` 按 `namespace.name` 的 `mcp__` 前缀 + `exposure` 把非 `direct` 的 MCP 工具从 active 集里剔除（有 `deferred` 时补上 `tool_search`），`server/agent-service.ts` 的 `promptToolCatalog()` 用同一判据把 `deferred` 工具排除在「按需名单」之外。管理页的 MCP 编辑弹窗有「工具暴露方式」下拉编辑服务器默认值；保存规则（`server/mcp-manager.ts:exposureFields()`）= 请求里不带字段就保留文件原值、`null` 删掉字段（回到缺省）、非法值忽略。`exposure` / `toolExposure` 进热加载指纹（改了会 reload 一次），但**不重启子进程**：`sameMcpSpec()` 只比连接字段，命中就 `McpClient.updateSpec()` 就地换曝光。注意 SDK 的 `mcpNamespace` / `getMcpToolExposure` / `validateMcpServerConfig` 只从内部 `dist/core/mcp-servers.js` 导出、包 `exports` 未开该子路径（运行时 import 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`），所以本仓库按同口径本地实现，并在 `tests/unit/mcp-exposure.test.ts` 里直接对比 SDK dist 钉住等价（SDK 换产物布局则跳过该条）。

**command 解析（Windows 批处理 shim，issue #934）**：`mcp.json` 的 `command` 是用户按终端习惯写的（`npx` / `yarn` / `pnpm` / `uvx`）。Windows 上这些是 `.cmd` 批处理 shim，而不带 shell 的 `spawn` 走 CreateProcess —— 既不查 `PATHEXT` 也不能执行批处理（`npx` → ENOENT，`npx.cmd` → EINVAL），于是服务器「一个工具都不贡献」且界面上跟没配的条目一模一样。解析单源在 `server/command-spawn.ts` 的 `resolveCommandLaunch()`：复用 `findNativeCliExecutable`（PATH/PATHEXT + fnm/nvm/volta/scoop 等安装目录）定位，再用 `readNpmShimTargets` 把 npm cmd-shim 还原成 `node <入口 js>` **直启（保持 `shell:false`，无引号二次解析）**；只有还原不出来（用户自写 `.bat` / 间接型 shim）才退化成 `ComSpec /d /s /c` + 自行引号化（外层再包一层给 `/s` 剥、token 内引号写 `""`、配 `windowsVerbatimArguments`）。失败文案带 Windows 处置（`where npx` 有没有输出、改指 node 入口），并进 `getServerStatus().error` 显示到管理页；spawn `error` 时同步清 `this.child`，否则后续调用会对着不存在的进程空等超时。守卫：`tests/unit/command-spawn.test.ts`、`tests/unit/mcp-bridge.test.ts`。

**子进程生命周期与自愈**：进程意外退出（OOM / 被外部 kill / 自己崩）后不永久失效 —— `McpClient.call()` 发现子进程已死就先**惰性重启**（重新 spawn + initialize 握手 + tools/list）再发调用；显式 `close()` 之后才永久停用（不复活）。惰性而非「退出即后台重启」是刻意的：配置写错的服务器只会在真被调用时试一次，不会空转拉进程（重启循环天然受调用频率约束）。三条不变量：并发调用共享同一次重连（`starting` promise；先判 `starting` 再判 `child`，否则第二个调用会抢在 initialize 应答前发 tools/call）、重启过程中被 close() 则回收刚启动的进程不留孤儿、启动/握手失败也回收半启动进程并让调用方拿到明确错误（`服务器进程已退出且自动重启失败：<根因>`，替代原来挂满超时的泛化报错）。重启后 `McpClient.tools` 重新拉取。

**配置热加载（server/mcp-hot-reload.ts）**：保存 `<dataDir>/mcp.json` 即生效，不必再重启服务。启动时 `McpBridge.load()` 照旧只跑一次，之后由这条监视线接管（`index.ts` 装配：`reload → mcpBridge.reload()`、`onToolsChanged → service.applyPluginAgentTools()`，后者就是「Bridge 层工具列表热刷新」那一半 —— `syncPluginToolsIntoSession` 按名字差集注入/移除，已有会话与新建会话都跟得上）。四条不变量：①**内容没变就不动任何子进程** —— 指纹按规范化快照（`mcpServerSnapshot`：command/args/cwd/env/type/timeout/enabled/description/protocolVersion 以及 `exposure`/`toolExposure`，env 键序与服务器顺序无关；只改 exposure 时只 reload、不重启进程，见上文「工具的命名与暴露方式」），编辑器保存、重排键、改缩进都不触发重启；②**只换规格真变了的服务器** —— `McpBridge.reload()` 返回 `{kept, started, stopped, failed, servers, tools}`，规格没变的沿用原实例（改一个不连带重启其它服务器），被移除/替换的旧实例最后才 close，不留孤儿；③**新规格起不来就保留旧实例**，配置写坏不等于把还能用的工具一起下线；④**JSON 解析失败只记日志 + 一条 warning 提示、保留在跑的服务器**（保存过程中的半写状态很常见），而**删掉 `mcp.json` 是有意清空全部服务器**，照常应用 —— 两种「没有配置」的语义刻意分开。监视用 `fs.watch`（`persistent: false`，不吊住进程），目录还不存在 / 网络盘不支持时自动回落到 2s 轮询。

**工具结果的 content 块按类型映射**（以前只拼 `type==="text"`，截图/图表类工具一律返回空串）：`image` 块原样透传为 SDK 的 `ImageContent`（`{type,data,mimeType}`，进会话后由 SDK 的 `normalizeToolResultImages` 统一缩放，超限图不会让 provider 整段报错）；文本型 `resource`（`resource.text`，filesystem 类 MCP 的 read_text_file 走这条）当文本透传；blob（PDF 等）与 audio 退化为「mimeType + 约 N 字节，无法内联」的提示（SDK 内容联合只有 text|image|thinking|toolCall，没有 blob 载体）；纯文本结果仍是拼接字符串（老形状不破坏既有调用方）。注意 Web UI 的工具卡按既有行为只渲染文本（工具结果里的图片在 `serialize.ts` 里是 `[image result]`），模型上下文不受影响。

**OAuth 保护的远端服务器（`server/mcp-oauth.ts`，Issue #786）**：pi 的内置 MCP 扩展把每个服务器的 OAuth 状态存在 `<agent-dir>/mcp-auth.json`（键 `mcp__<服务器名>|<url>`，旧版只写 URL 的键仍读并接管），pi-web-ui 的桥直接**复用这份凭据**而不另建一套：请求前取 access token（临近过期 30s 先刷新，与 pi 同口径），发出 `Authorization: Bearer …`；收到 401 时用库里的 refresh token 强制刷新一次并重试同一请求，刷新结果按 pi 的格式（2 空格 JSON + 换行，0600）写回，刷新令牌轮换一并保留。并发/跨进程刷新用与 pi 同名的 `<agent-dir>/mcp-auth-refresh-<hash>.lock` 目录锁串行化（stale 20s），`staleToken` 判据保证「别的进程已换过 token」时不重复刷新（轮换下二次刷新会毁掉授权）。**网页登录**：管理页通过 `mcp_oauth_start/finish/status/cancel` 发起授权，`server/mcp-oauth-login.ts` 复用 `@earendil-works/pi-mcp/oauth` 的发现、动态客户端注册、PKCE 与授权码交换。临时 loopback 回调监听器自动完成本机浏览器授权；远程部署可将浏览器最终跳转的完整 URL 粘回管理页。随机 state、回调 origin/path 与单次交换检查保护授权归属；PKCE verifier 与令牌始终留在服务端，只有授权 URL、尝试 ID 与状态下发。未完成的状态只存内存，十分钟过期、取消或客户端销毁即中止网络请求并关闭监听。成功后在共享凭据库锁内合并写入，再重连发起时捕获的项目 Bridge；每个 ClientSession 独立管理登录，不能跨客户端提交别人的 ID。CLI 的 `pi mcp login <服务器>` 仍兼容。显式配置了 `Authorization` 头的服务器走静态凭据，完全不碰这里。

刷新写回在 `mcp-auth.json.lock` 内执行 compare-and-swap：比较网络调用前读到的来源键、tokens、绝对过期时间、客户端注册与 discovery。凭据被删除时不恢复；重新登录、客户端或授权端点发生变化时丢弃旧刷新结果，返回当前库里的 token（删除则为 null）。合并保留其它服务器与当前条目的非凭据字段；只有实际刷新旧 URL 键时才迁移并删除该旧键，独立的旧键不会被误删。刷新失败的回退也重新读库，避免发送注销前捕获的 token。

每个 HTTP RPC 从读取凭据前就登记为在途请求并启动超时；同一取消信号贯穿刷新锁/库锁等待、令牌请求、响应体、重试和写回前检查。401 的 `staleToken` 来自该请求实际发送的 Authorization，不能使用客户端共享的“最近 token”。并发刷新沿用跨进程锁串行化，不共享取消控制器：取消等待者不会终止持锁者，取消持锁者不会提交迟到结果，其余调用者自行重新读库。超时、调用方取消与 `close()` 立即结束 RPC；通知也有独立的 8s 截止时间并由 `close()` 取消。已在授权服务器发生的刷新令牌轮换无法撤回；本地取消会丢弃结果，此时可能需要重新登录。回归见 `tests/unit/mcp-oauth-concurrency.test.ts`。


