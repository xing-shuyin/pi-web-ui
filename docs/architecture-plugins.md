# 插件系统

> 可选界面组件，存放在 `<dataDir>/plugins/`。不装即不存在，attach 时热重扫。

## 形态

一个插件 = `<dataDir>/plugins/<id>/` 目录：

- `manifest.json`（name/version/description）
- `index.mjs` 服务端入口（可选，`export default { activate(host) → deactivate? }`）
- `client/entry.mjs` 视图入口（可选，`export default { mount(el, ctx) → cleanup? }`）

**客户端依赖只能住在 `client/` 里**：宿主只服务 `client/*` 子树（见「静态服务」），所以
`client/entry.mjs` 的相对 import 一旦解析到 `client/` 之外（典型：写成了 `../sdk/index.mjs`），
浏览器会报 `Failed to fetch dynamically imported module` 并**整个 bundle 都不执行**（插件页空白，
而服务端毫无异常：manifest 校验通过、`active:true`、`error:null`）。`plugin create` 生成的骨架
因此把 plugin-sdk 拷**两份**（服务端 `sdk/`、客户端 `client/sdk/`，各含 `index.mjs` +
`client-utils.mjs`），生成后还跑一遍 `plugin-sdk/import-check.mjs` 把越界/缺失直接报成警告
（回归：`tests/plugin-scaffold-test.mjs` + `tests/unit/plugin-import-check.test.ts`）。

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
| `host.onRunEvent(h)`                      | 订阅运行轨迹事件（run_start/message/tool_start/tool_end/turn_*/run_end，pi 引擎；轨迹/时间线插件聚合「任务→思考→工具→文件→结果」用，payload 已截断封顶）                                                                                                                                                                                                                                                                                                                                                                             |
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
| `host.llm.complete(req)`                  | 孤立无工具的一次性模型补全（总结/翻译/分类，不建对话不进历史；`{prompt, system?, model?, maxChars?, timeoutMs?}` → `{ok, text?, model?, usage?, error?}`；要 `llm` 能力族，DSH 下回 `{ok:false}`）                                                                                                                                                                                                                                                                                                                                   |
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

| API                                        | 一句话                                                                                                                                                                                              | 门控（permissions 族）                     | 无注入回退                                                                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.conversations.list()`                | 本客户端运行中对话 + 当前项目历史会话（`{id,title,cwd,kind,isStreaming}`，历史最多 50）                                                                                                             | 无（只读）                                 | 空数组（插件显示空态）                                                                                                                                                                                                                              |
| `host.conversations.search(query, limit?)` | 复用 search_sessions 全文判定，回前 N 个 `{id,title}`                                                                                                                                               | 无（只读）                                 | 空数组                                                                                                                                                                                                                                              |
| `host.prompt(conversationId, text)`        | 向指定对话投递 prompt（非当前对话先 switch 再走 prompt 全路径；找不到对话回错）                                                                                                                     | `chat`                                     | `{ok:false,error}`（DSH 引擎亦如此）                                                                                                                                                                                                                |
| `host.steer(conversationId, text)`         | 向指定对话注入转向（`steerForPlugins`：本机直调 `sendUserMessage(text,{deliverAs:'steer'})`，跨客户端经 `steerElsewhere` 钩子）                                                                     | `chat`                                     | `{ok:false,error}`（未知对话/空文本/DSH 时）                                                                                                                                                                                                        |
| `host.abortRun(conversationId)`            | 中止指定对话（复用 abort 的 interruptRun，卡住/空转强制重置；未在跑幂等成功）                                                                                                                       | `chat`                                     | `{ok:false,error:"not supported"}`（DSH/无客户端时）                                                                                                                                                                                                |
| `host.chat(req)`                           | 无头投递外部文本（`{text,accountId?,cwd?,conversationId?,model?,thinkingLevel?}`：conversationId 命中走 steer 投递、miss 回落无头；cwd 须存在且非系统目录；模型/思考强度预切，失败即拒绝）          | `chat`                                     | 抛错（宿主未接 chatProvider / DSH 引擎 / 校验失败时）                                                                                                                                                                                               |
| `host.chatWait(...)`                       | 等一轮 run 结算再回                                                                                                                                                                                 | `chat`                                     | `{ok:false}`（不等，由调用方超时兜底）                                                                                                                                                                                                              |
| `host.llm.complete(req)`                   | 孤立无工具的一次性补全（`{prompt,system?,model?,maxChars?,timeoutMs?}` → `{ok,text?,model?,usage?,error?}`，不建对话；实现见 `server/plugin-llm.ts`，经 `completeForPlugins` + `llmProvider` 注入） | `llm`                                      | `{ok:false,error}`（DSH 引擎亦如此）                                                                                                                                                                                                                |
| `host.fs.watch(path, cb)`                  | 订阅文件变化（复用服务端 watcher）                                                                                                                                                                  | `fs:read`                                  | 不回调（静默无事件）                                                                                                                                                                                                                                |
| `host.scm(kind, opts?)`                    | 只读 git 查询（复用 server/scm.ts）                                                                                                                                                                 | `fs:read`                                  | `{ok:false,error}`                                                                                                                                                                                                                                  |
| `host.bash(cmd, opts?)`                    | 跑一条服务端 shell                                                                                                                                                                                  | `tools`                                    | `{ok:false,error:"not supported"}`                                                                                                                                                                                                                  |
| `host.schedule(spec, task, opts?)`         | 毫秒间隔或全 5 字段 cron（`"0 9 * * *"`，服务器本地时区）；`opts.persistent` 落盘 `<pluginDir>/schedules.json`，重启后重调即重建（要合法 id；`catchUp:"once"` 补跑一次），自动进后台任务面板        | 无（直跑，见 `server/plugin-schedule.ts`） | —（非法形状抛错）                                                                                                                                                                                                                                   |
| `host.models.list()`                       | `{id,provider,vision}`（走缓存目录，不触发网络 refresh）                                                                                                                                            | 无（只读）                                 | 空数组                                                                                                                                                                                                                                              |
| `host.onStats(cb)` / emitStats             | 会话统计推送（tokens/cost/contextUsage，见 `PluginStats`）                                                                                                                                          | 无                                         | 不推送（插件用快照 stats 兜底）                                                                                                                                                                                                                     |
| `host.onStreaming(cb)` / emitStreaming     | 流式增量推送                                                                                                                                                                                        | 无                                         | 不推送（插件轮询快照兜底）                                                                                                                                                                                                                          |
| `host.events.emit/on(topic, payload)`      | 插件间事件总线（`PluginBusEvent`，载荷 4KB 截断）                                                                                                                                                   | 无                                         | emit 丢弃、on 不回调                                                                                                                                                                                                                                |
| `host.net.fetch(url, opts?)`               | 出站网络（netAllowlist 全等/点号后缀命中才放）                                                                                                                                                      | `net`                                      | 拒绝并报缺白名单/缺 net 族                                                                                                                                                                                                                          |
| `host.dialog.*`                            | select/confirm/input（对齐扩展 ui 桥）                                                                                                                                                              | `ui`                                       | 抛错拒绝（调用方回退 notice 提示用户）                                                                                                                                                                                                              |
| `host.notifyAction(...)`                   | 通知条带动作按钮，点后回插件                                                                                                                                                                        | `ui`                                       | 退化成普通 notify（无按钮）                                                                                                                                                                                                                         |
| `host.shortcuts.register(...)`             | 注册快捷键（宿主负责冲突与展示）                                                                                                                                                                    | `ui`                                       | 忽略注册                                                                                                                                                                                                                                            |
| `host.searchProviders.register(...)`       | 全局搜索（Ctrl+K）结果提供方                                                                                                                                                                        | `ui`                                       | 不搜（无该来源）                                                                                                                                                                                                                                    |
| `host.composerProviders.register(...)`     | `@` 提及提供方（宿主 API v9）：`search(q)` 回 `{title,hint?,text?,attachments?}`，选中后文本写进光标处、附件进 chips                                                                                | `ui`                                       | 三个内置：文件（`@` + 文件名 → reference chip，经 search_files）、已授权页面（`@` + 标题/origin → `page` 网页引用 chip，读 page-picker 状态缓存）与技能（`@` 或 `@skill:` + 技能名 → `@skill:<name>` 词元，供 Pi 运行时扩展提升为系统级工作流指令） |
| `host.onTheme(cb)`                         | 主题切换订阅                                                                                                                                                                                        | 无                                         | 不回调（用首次下发主题）                                                                                                                                                                                                                            |
| 新 slot（`UiSlotId` 新增挂载点）           | 别名 + 枚举两端同口径（只改一边 = 注册了但界面上没有，见常见坑）                                                                                                                                    | `ui`                                       | 未知 slot 静默丢弃（既有语义）                                                                                                                                                                                                                      |
| 新 kind（toggle/input/progress 等）        | 开关态/输入值/进度经 `host.ui.update` 刷新，progress 越界宿主钳制（语义见 `tests/unit/plugin-extensions.test.ts`）                                                                                  | `ui`                                       | 不认识的 kind 按缺省 action 画                                                                                                                                                                                                                      |
| messageWidget（plugin-fence 消息级挂件）   | 在指定消息下挂小部件（renderer 的消息级形态，不共享 React 实例）                                                                                                                                    | `ui`                                       | 不挂载（消息原文不受影响）                                                                                                                                                                                                                          |

### 宿主设施（plugin-facilities.ts）

| 设施         | 说明                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `storage`    | `<pluginDir>/storage.json` 原子 KV                                   |
| `secrets`    | AES-256-GCM 加密机密，密钥 `<dataDir>/secrets.key`，拷机 fail closed |
| `ensureDeps` | npm 自动补装单飞                                                     |

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
- `plugin-sdk/` 起手包：`index.mjs`（`definePlugin` / `defineView` / `defineRenderer` /
  `actionHandler` / `getSetting` / `selectOptions`，零依赖纯 ESM，直接拷进插件目录）+
  `index.d.ts`（宿主接口精简类型，编辑器补全用）+ `README.md`（含 P0 新能力速览）。

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

- `icon`（emoji/单字符，顶栏 tab 替代通用拼图图标）
- `iconSvg`（内联 SVG 字符串，有则优先于 `icon` 渲染：顶栏视图 tab / 右栏 tab / 设置面板列表与市场都画 SVG；服务端只做形状校验（`<svg…</svg>`、≤8KB、无 script/事件处理器，见 `server/icon-svg.ts`），前端渲染前再 sanitize 一次（见 `web/src/plugin-icon.tsx`）；`icon` 保留作旧版回落）
- `description`（设置面板里的插件介绍；视图 tab 的悬浮提示只用插件名，不用它）
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
- `ui`（对象）：插件对宿主 UI 的**全部贡献**（slot 条目 + `arrange` 整理意图，见「UI 扩展点（slot 框架）」）；
  严格模式下需要 `permissions` 含 `ui` 族，否则整份忽略
- `build`（对象，可选）：源码安装时的构建声明（`{ install?, command, outputs? }`，见
  「源码安装（--build）」）
- `netAllowlist`（字符串数组）：出站主机白名单（permissions 含 `net` 时生效，未命中即拒，空 = 全拒）
- `engines`（对象，如 `{"pi-web-ui": ">=1.2.0"}`）：引擎约束，不满足即拒绝激活；范围支持 `>=`/`^`/精确，非法 range 放行（语义见 `tests/unit/plugin-extensions.test.ts` 的 satisfiesEngines）
- `peerPlugins`（字符串数组）：对等依赖的其它插件 id，缺失只警告不断活
- `requires`（对象，P2-8 硬依赖）：`{ hostApi?, families?, plugins? }`，任一条不满足即拒绝激活+教学式错误——`hostApi` 是宿主 API 下限（超前请升级）、`families` 须是已知族且须同时在自家 `permissions` 里声明、`plugins` 须已安装且激活成功。`ensureLoaded` 按依赖拓扑排序激活（环直接拒），提供方被删/失败后消费方一并反激活+留占位（级联一轮收敛，reload 重算刷新）

## 插件 AI 工具的可见性与开关

`host.registerAgentTool` 注册的工具以前只进会话、对用户不可见也不可关。现在两处可看、
一处可关：设置 → 界面插件里每个插件下展开自己的工具（名/label/description）并逐个开关；
设置 → 工具页底部有按插件分组的汇总区（同一开关）。实现：`UiPluginInfo.agentTools`
只读快照（`plugins.ts:agentToolsSnapshot`，随 `plugins` 清单下发，注册/注销经 `pushToAll`
刷新）；开关是全局 `disabledPluginTools` 名单（`client-state` 持久化 + 预设随行，未知条目保留，
重装仍关闭；DSH 无插件宿主，固定空数组）。会话创建与 `syncPluginTools` 按名单过滤
（MCP 桥工具同管线、同名单），设置变更经 `refreshPluginTools` 推全部分会话、live 生效无需 reload。

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

| 字段                                                         | 说明                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                    | 宿主 API 版本（`PLUGIN_HOST_API_VERSION`，当前 **11**；插件可用它判断宿主能力）                                                                                                                                                                                                                                                                                                  |
| `setView(view)`                                              | 切主视图（`"chat"` / `"terminal"` / `"git"` / `"plugin:<id>"`）                                                                                                                                                                                                                                                                                                                  |
| `startChat({ prompt, newChat?, cwd? })`                      | 新建对话（可选切工作目录）并把 prompt 作为用户消息发出；返回"已受理"                                                                                                                                                                                                                                                                                                             |
| `compose({ text?, attachments? })`                           | 把内容放进**输入框草稿**（用户补一句话再自己发），返回是否受理。与 startChat 的差别：**不要求连接就绪**（草稿是本地状态）、输入框没挂载时拒收。实现走 `web/src/composer-bridge.ts` 的模块级 sink（草稿文本在 ChatInput 内部 state、待发附件在 App state，两处各自注册自己那一半）；合并语义复用 `composer-draft.ts`（空则填入、非空追加、绝不覆盖），附件按 path+mode+行区间去重 |
| `openSession({ cwd?, folders?, roots?, prompt?, newChat? })` | 可等待的开会话：目录授权 + 多根工作区（见「项目 / 会话 API」）                                                                                                                                                                                                                                                                                                                   |
| `sessions.list()` / `sessions.open(id)`                      | 会话列表与打开：本客户端运行中的对话 + 当前项目的历史会话                                                                                                                                                                                                                                                                                                                        |
| `onUiAction(name, fn)`                                       | 接管 UI 条目的动作（slot 框架；旧名 `onTopbarAction` 保留为别名）                                                                                                                                                                                                                                                                                                                |
| `reloadCatalog(source, opts?)`                               | 插件市场目录同步（issue #148，见「插件市场」）                                                                                                                                                                                                                                                                                                                                   |

定义：`web/src/plugin-host.ts`（纯逻辑 `createPluginHostApi`，App 挂载时 `installPluginHostApi`）。
**时序坑**：服务端 `new_chat` 是异步的（`void cs.newChat()`），紧接着发 `prompt` 会落到旧对话，
所以 `startChat` 内部串行等：cwd 切过去 → 对话变空白/换新 → 才发 prompt（每步有超时，超时也发，不静默丢）。
现有用户：legado-web 插件的「🤖 AI 修复源 / AI 新建书源」按钮（阅读页与书源页一键把现场发给 AI 开新对话）。

`syncPluginViews(plugins, epoch)` 统一同步注册表：清单消失/被禁用即卸载视图（调 cleanup）、epoch 变化清 failed 重拉 bundle。

设置面板 ⚙ 有「界面插件」开关区（`set_settings.disabledPlugins`，持久化 client-state、纯 UI 隐藏不触发 runtime reload —— 被禁用的插件不算「界面布局」里的条目，它的贡献与 `arrange` 整份丢弃）+ **每行「更新/卸载」按钮**（更新需 CLI install 记录的来源 `.pi-source.json` → `UiPluginInfo.source`；两个操作都走**服务端后台作业** `plugin_job`，见下「插件市场」，不占用户终端、不关设置面板）+「界面布局」页（内置条目与插件条目的隐藏 / 排序 / 恢复，见「UI 扩展点（slot 框架）」）+「已授权目录」段（见「目录授权与跨目录 fs」）。

## 静态服务

`GET /plugins/:id/client/*` 映射到插件目录的 client/ 子树（**只暴露这个子树**——manifest 与服务端 index.mjs 可能含凭据，绝不下载；id 校验 + resolve 前缀防穿越）。dev 模式 vite 已代理 /plugins。

前端动态 import 的 bundle URL 经 `web/src/base-url.ts` 的 `appUrl()` 加上应用根前缀
（nginx 子路径反代时页面在 /pi/ 下，请求会变成 `/pi/plugins/<id>/client/entry.mjs`），
子路径部署无需任何额外配置；根部署时行为与根路径完全一致。

### 特权 DOM 访问（`dom` 能力族）

slot 框架的原则是「插件声明、宿主渲染」——插件碰不到宿主外壳的 DOM。需要突破
这一层（往顶栏/输入框/任意位置挂原生 DOM、改样式、拦事件）的插件声明
`permissions: ["dom"]`，并走**用户授权**：

- 服务端在 `<dataDir>/plugin-dom.json` 记授权表（`server/plugin-dom.ts` 的
  `PluginDomConsent`，与目录授权表同口径：全局共享、坏文件当空表、变更才落盘）。
- 未授权时该插件的 client bundle 直接 **403**（`server/index.ts` 静态门禁经
  `PluginManager.isDomBundleBlocked` 判定）—— bundle 与页同源，JS 层面拦不住
  `document`，门只能放在下发处。未授权的插件在清单里带 `wantsDom: true` +
  `error` 置灰说明原因。
- 授权/撤销走 `plugin_dom_consent`（设置面板插件行上的「授权/撤销 DOM 访问」按钮，
  带 ⚠ 警示），服务端写表后 **epoch+1 重推清单**（浏览器丢旧模块缓存重拉 bundle）。
- 已授权的 bundle 可用 `window.__piWebUiHost.dom.anchors()` 拿稳定挂载点
  （`data-pi-anchor="app|topbar|composer"`，v7 引入，`web/src/plugin-host.ts`）——
  bundle 原生就有 `document`，anchors 只是跨版本稳定的查询入口，不用再猜类名。

设计取舍：限制的不是**能力**（授权后就是完整 DOM），而是**谁可以**——用户在设置面板
点一次头。服务端 `index.mjs` 本来就是完整 Node 可信代码，不在此门禁内。

## MCP 工具桥（server/mcp-bridge.ts）

读取 `<dataDir>/mcp.json` 启动外部 MCP 服务器（stdio、换行分隔 JSON-RPC，零三方依赖；`{servers:{名:{command,args,cwd,env}}}`），握手 initialize→initialized→tools/list→tools/call 后把每个远端工具适配成 PluginAgentTool（名字归一化 sanitizeToolName），并入 plugin.d.ts 的 pluginToolsProvider（与插件工具同一 customTools 管线）。单服务器失败隔离（rejectAll + 日志，不炸进程）；dispose 时 kill 子进程；请求按 id 匹配 + 超时看门狗。

**子进程生命周期与自愈**：进程意外退出（OOM / 被外部 kill / 自己崩）后不永久失效 —— `McpClient.call()` 发现子进程已死就先**惰性重启**（重新 spawn + initialize 握手 + tools/list）再发调用；显式 `close()` 之后才永久停用（不复活）。惰性而非「退出即后台重启」是刻意的：配置写错的服务器只会在真被调用时试一次，不会空转拉进程（重启循环天然受调用频率约束）。三条不变量：并发调用共享同一次重连（`starting` promise；先判 `starting` 再判 `child`，否则第二个调用会抢在 initialize 应答前发 tools/call）、重启过程中被 close() 则回收刚启动的进程不留孤儿、启动/握手失败也回收半启动进程并让调用方拿到明确错误（`服务器进程已退出且自动重启失败：<根因>`，替代原来挂满超时的泛化报错）。重启后 `McpClient.tools` 重新拉取。

**配置热加载（server/mcp-hot-reload.ts）**：保存 `<dataDir>/mcp.json` 即生效，不必再重启服务。启动时 `McpBridge.load()` 照旧只跑一次，之后由这条监视线接管（`index.ts` 装配：`reload → mcpBridge.reload()`、`onToolsChanged → service.applyPluginAgentTools()`，后者就是「Bridge 层工具列表热刷新」那一半 —— `syncPluginToolsIntoSession` 按名字差集注入/移除，已有会话与新建会话都跟得上）。四条不变量：①**内容没变就不动任何子进程** —— 指纹按规范化快照（`mcpServerSnapshot`：只看 command/args/cwd/env/protocolVersion，env 键序与服务器顺序无关），编辑器保存、重排键、改缩进都不触发重启；②**只换规格真变了的服务器** —— `McpBridge.reload()` 返回 `{kept, started, stopped, failed, servers, tools}`，规格没变的沿用原实例（改一个不连带重启其它服务器），被移除/替换的旧实例最后才 close，不留孤儿；③**新规格起不来就保留旧实例**，配置写坏不等于把还能用的工具一起下线；④**JSON 解析失败只记日志 + 一条 warning 提示、保留在跑的服务器**（保存过程中的半写状态很常见），而**删掉 `mcp.json` 是有意清空全部服务器**，照常应用 —— 两种「没有配置」的语义刻意分开。监视用 `fs.watch`（`persistent: false`，不吊住进程），目录还不存在 / 网络盘不支持时自动回落到 2s 轮询。

**工具结果的 content 块按类型映射**（以前只拼 `type==="text"`，截图/图表类工具一律返回空串）：`image` 块原样透传为 SDK 的 `ImageContent`（`{type,data,mimeType}`，进会话后由 SDK 的 `normalizeToolResultImages` 统一缩放，超限图不会让 provider 整段报错）；文本型 `resource`（`resource.text`，filesystem 类 MCP 的 read_text_file 走这条）当文本透传；blob（PDF 等）与 audio 退化为「mimeType + 约 N 字节，无法内联」的提示（SDK 内容联合只有 text|image|thinking|toolCall，没有 blob 载体）；纯文本结果仍是拼接字符串（老形状不破坏既有调用方）。注意 Web UI 的工具卡按既有行为只渲染文本（工具结果里的图片在 `serialize.ts` 里是 `[image result]`），模型上下文不受影响。

## 插件市场（可一键安装的插件列表）

> 设置面板「界面插件」页上方新增的「插件市场」区：列表里每条插件一个「安装」
> 按钮。**安装 / 更新 / 卸载都走服务端后台作业**（`server/plugin-installer.ts`）：
> 真正执行的仍是 CLI（`pi-web-ui install|uninstall`，单一实现），但**不再开可见终端、
> 不关设置弹窗**——输出按行回传（`plugin_job`），面板上就地显示进度与失败输出（issue
> #152）。同一时刻只跑一个作业（两个 install 写同一目录必出半装状态），另有看门狗与取消。
> 已装过的显示「更新」（`install … --force`，保留 config.json）与「卸载」（两步确认）。
> 市场头部还有「源码构建」勾选项：安装/更新前先做隔离构建（等价 CLI `--build`，issue
> #150）——只装插件声明的构建依赖（`npm install --ignore-scripts`，不跑任意生命周期
> 脚本）→ 跑 manifest.build.command（缺省回落 package.json 的 `scripts.build`）→
> 校验 `outputs` → **成功后才替换目标目录**（失败时上一版插件原样可用）。
> 该勾选框语义是“强制重编”：只有源码没有产物的插件即使不勾也会自动构建（issue #165
> 的 `--build` 推断：有构建声明 + 双入口都缺 = 不构建必死，此时默认构建并先打印解析出
> 的 install/command；`--no-build` 可显式跳过，产物已提交的仓库不受影响）。

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

**从目录同步**（issue #165）：市场头部「从目录同步」按钮展开同步框 —— 填目录文档 URL
（http(s)）或本地绝对路径，一键走服务端现成的 `plugin_catalog_sync` 通道（与插件
`host.reloadCatalog` 同一条：同校验、同原子写盘；可选同步后安装全部条目 / 整体替换，
回执就地回显）。成功同步过的 URL 记浏览器 localStorage（最近 8 个），一点即重同步 ——
**安装前先读 spec**（DSH 对照 P0-3，`server/plugin-install-spec.ts` + `PluginInstaller.inspectInstallSpec`）：
在「添加插件」输入框填来源时，前端防抖 500ms 发 `plugin_install_inspect`，服务端在**动 CLI 之前**
做一次可解释的检查 —— ① 形状分类（`npm` / `github` / `url` / `path` / `invalid`）；② 本地已装判定
（`<dataDir>/plugins/<推导 id>` 存在 → 转成「更新」）；③ 本地路径源直接读它的 `manifest.json`；
④ GitHub 源用一次 `raw.githubusercontent` 探测（6s 超时，失败**不阻塞安装**）。结果归到七种
`problem`（`invalid-spec` / `already-installed` / `not-found` / `not-a-package` / `not-a-bundle` /
`network` / `unknown`），各带一句可读 detail 与 `suggestedId`，经 `plugin_install_inspect_result`
回到面板，在输入框下就地显示（探到 manifest 时顺带展示 name/version/description 供确认）。
`server/plugin-install-spec.ts` 本身是纯函数（不联网、不写盘），`server/plugin-catalog.ts` 的
宽松校验保持不变 —— 它只是**引导**，不是硬门禁。

**从目录同步**（issue #165）：市场头部「从目录同步」按钮展开同步框 —— 填目录文档 URL
（http(s)）或本地绝对路径，一键走服务端现成的 `plugin_catalog_sync` 通道（与插件
`host.reloadCatalog` 同一条：同校验、同原子写盘；可选同步后安装全部条目 / 整体替换，
回执就地回显）。成功同步过的 URL 记浏览器 localStorage（最近 8 个），一点即重同步 ——
第三方仓库不再需要为同步专门发一个占位插件。headless/预置场景另有两条同语义入口：
CLI `install --catalog <url>`（同步列表 + 逐条安装/更新，已安装默认跳过，`--force` 更新，
`--replace` 整体替换）与环境变量 `PI_WEB_PLUGIN_CATALOG_URL`（服务端启动时自动同步一次并
安装，失败只告警不阻断启动；见 `docs/env-vars.md`）。

## UI 扩展点（slot 框架，issue #146）

插件对宿主 UI 的贡献走**声明式挂载点（slot）**：插件只声明「有什么条目、想放哪儿」，渲染 / 排序 /
溢出 / 可访问性全部归宿主，**插件不碰 DOM**。契约在 `server/protocol.ts`（`UiSlotId` /
`UiContribution` / `UiArrangeOp` / `UiPluginUi` / `UiLayoutPrefs` / `UiSlotSpec`），服务端解析与运行时注册在
`server/plugins.ts`（`parseUiItem` / `parseUiContributions` / `parseUiArrange` / `UI_SLOTS` /
`UI_SLOT_ALIASES`），前端合并引擎是 `web/src/ui-slots.ts` 的 `buildUiSlots()`（纯函数，有单测）。

**失败不静默（DSH 对照 P0-1）**：`buildUiSlots(..., { diagnostics })` 可收集合并过程中的诊断
（未知 slot / 未知 kind / 宿主不认识的 `when` / arrange 目标不存在 / 同一插件重复声明同 id /
插件被禁用或激活失败），每条带 `pluginId` + `entryId` + `slot` 归因；不传 `diagnostics` 时行为
与原来**逐字一致**。App 把它们 `console.warn` 出来，设置面板「界面布局」页顶部同时渲染一个可
折叠横幅（`uiLayoutDiagTitle` / `uiLayoutDiagHint`）——以前这些情况是静默丢弃，表现为「注册了但
界面上没有」，最难排查。渲染层另配 `web/src/components/SlotErrorBoundary.tsx`：每个条目**独立**
包一层，某条目渲染抛错只丢它自己并就地置灰，不炸掉整条工具栏。

> 别和**插件视图 tab** 混起来：安装后出现在顶栏的 🧩 视图 tab（`plugin:<id>`）由 `plugins` 清单经
> `withPluginViewItems` 合成 `kind="view"` 条目（`<id>:__view`）后走 slot 框架，与宿主三连同流渲染
> （报错插件的 tab 由 TopBar 兜底置灰保留，因合并引擎会整份丢弃它的贡献）。

### 22 个挂载点

每个挂载点都有宿主定义的 `UiSlotSpec`：`cardinality` 为 `list` 时多个条目并列渲染，
为 `single` 时合并引擎按最终排序选出第一个可见条目，其余可见候选会被置为隐藏并产出布局诊断。
当前这 22 个已有挂载点全部是 `list`，因为它们都表达工具栏、菜单、tab 或页面入口的并列集合；
`modal.dialog` 的“同一时刻只开一个”是打开状态机约束，不是 slot cardinality。未来新增独占挂载点只需
在 `web/src/ui-slots.ts` 的 `UI_SLOT_SPECS` 标成 `single`，无需改变插件 manifest 形状。

| slot                         | 位置                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topbar.primary`             | 顶栏主栏（与内置 tab 同排；单一扁直流，见下方“顶栏平铺化”）                                                                                                                           |
| `topbar.overflow`            | 顶栏溢出菜单（被隐藏的条目＋直接声明在这里的常驻条目）                                                                                                                                |
| `bottombar`                  | 底栏（连接状态 / 上下文 / 成本那一条）                                                                                                                                                |
| `composer.leading`           | 输入框前置区（文件上传按钮左侧，纯插件新增位）                                                                                                                                        |
| `composer.actions`           | 输入框动作区（上传按钮右侧到发送按钮之间）                                                                                                                                            |
| `message.actions`            | 每条消息 hover 时的工具条                                                                                                                                                             |
| `rightpanel.tabs`            | 右栏 tab（默认是文件树）                                                                                                                                                              |
| `contextmenu.topbar`         | 顶栏条目右键菜单                                                                                                                                                                      |
| `contextmenu.message`        | 消息右键菜单                                                                                                                                                                          |
| `contextmenu.session`        | 左栏会话右键菜单                                                                                                                                                                      |
| `contextmenu.file`           | 文件树条目右键菜单                                                                                                                                                                    |
| `contextmenu.toolcall`       | 工具调用卡片的**工具名**右键菜单（宿主唯一菜单；内置一条「显示工具详细信息」，见 `ToolInfoDialog.tsx`）                                                                               |
| `settings.pages`             | 设置面板里的一整页（插件用 `mount()` 自己渲染）                                                                                                                                       |
| `leftpanel.projects.actions` | 左栏「最近项目」标题栏按钮（宿主「管理项目」按钮之后追加；无条目不画）                                                                                                                |
| `leftpanel.project`          | 左栏项目行内嵌区（项目名旁的徽标 / 快捷按钮；点击回传 `target={id: 项目路径, kind: "project"}`）                                                                                      |
| `leftpanel.running.actions`  | 左栏「运行的对话」标题栏按钮                                                                                                                                                          |
| `leftpanel.history.actions`  | 左栏「历史对话」标题栏按钮（宿主「新对话」按钮之后追加）                                                                                                                              |
| `contextmenu.project`        | 左栏项目行右键菜单（`target.kind="project"`；无可见条目时不抢浏览器右键）                                                                                                             |
| `leftpanel.running`          | 左栏「运行的对话」行内嵌区（只在运行行上出现；与 leftpanel.sessions 并集）                                                                                                            |
| `leftpanel.history`          | 左栏「历史对话」行内嵌区（只在历史行上出现；与 leftpanel.sessions 并集）                                                                                                              |
| `leftpanel.sections`         | 左栏三个分区的顺序与显隐（**仅宿主条目** `host:lp-*`；插件不能往里放条目，只能 arrange 隐藏）                                                                                         |
| `leftpanel.sessions`         | 左栏会话行内嵌区（会话标题旁的徽标 / 快捷按钮）                                                                                                                                       |
| `chat.header`                | 对话头部条（标题旁的操作区）                                                                                                                                                          |
| `chat.empty`                 | 空对话占位区（新对话的快捷入口）                                                                                                                                                      |
| `file.preview.toolbar`       | 文件预览工具条                                                                                                                                                                        |
| `terminal.toolbar`           | 终端工具条                                                                                                                                                                            |
| `scm.toolbar`                | SCM 面板工具条                                                                                                                                                                        |
| `goalbar.actions`            | 目标条动作区                                                                                                                                                                          |
| `notice.actions`             | 通知条动作区（notice 上的快捷按钮）                                                                                                                                                   |
| `tasks.panel`                | 「后台任务」面板（BgTasksModal）内容区：kind=`view` 的条目就地内嵌插件 bundle（同 `settings.pages` 的挂载口径），其余 kind 当动作按钮；宿主自己 diff 出来的后台进程仍走该面板原生列表 |
| `modal.dialog`               | 弹窗（`modal` 可简写；kind=`view` 的条目经宿主桥 `openModal` 按需打开，`closeModal` 关闭；同一时刻只开一个）                                                                          |

**自然简写**（`UI_SLOT_ALIASES`：解析时映射成完整名，让作者少踩坑）：`topbar`→`topbar.primary`、
`topbar.more`→`topbar.overflow`、`composer`→`composer.actions`、`message`→`message.actions`、`modal`→`modal.dialog`、
`rightpanel`→`rightpanel.tabs`、`settings`→`settings.pages`。没有别名的（`bottombar`、`composer.leading`、`tasks.panel` 与四个
`contextmenu.*`）必须写完整名；认不出的 slot 直接丢掉该条目（不报错、不崩）。`arrange` 的目标 slot
只接受完整名（不走别名）。

### manifest 里怎么写

```json
{
	"permissions": ["ui"],
	"ui": {
		"topbar": [
			{
				"id": "inbox",
				"label": "收件箱",
				"labelEn": "Inbox",
				"icon": "📬",
				"kind": "action",
				"action": "webmail:open-inbox",
				"group": "mail",
				"order": 10
			}
		],
		"contextmenu.file": [{ "id": "send", "label": "发到邮箱", "action": "webmail:send-file" }],
		"settings": [{ "id": "mail", "label": "邮箱", "icon": "📬" }],
		"arrange": [{ "id": "host:github", "hide": true }]
	}
}
```

两种形状都收：按 slot 分组（推荐，见上）或平铺 `{ "ui": { "items": [{ "slot": "...", ... }] } }`
（与运行时 `host.ui.register` 入参同形，两边复用同一套解析）。整份贡献共享一个 **32 条**上限、
`arrange` 上限 64 条；非法条目 / 重复 id / 认不出的 slot 静默丢弃（宽容但不放任：坏字段跳过，不因为
一条脏数据丢掉整份贡献）。

> 兼容性：这一版之前（同一 issue 的第一稿）的顶层 `manifest.topbar` 字段**已不再解析** —— 现在写
> `manifest.ui`（别名 `ui.topbar`）。保留兼容的只有宿主动作桥的旧名 `host.onTopbarAction`
> （= `onUiAction` 的别名，见「插件 → 宿主动作桥」）。

### 条目字段（`UiContribution`）

`id`（插件内唯一，须匹配插件 id 字符集；**全局 id = `<pluginId>:<id>`**，用户偏好与 `arrange` 的 key
就是它）、`label`（中文界面文案）+ `labelEn`、`icon`（emoji/单字符，或宿主图标词表里的名字）+ `iconSvg`（内联 SVG，有则优先于 `icon` 渲染）、
`hint` / `hintEn`（悬浮提示，落成渲染层的 `title` —— 只给一种语言时另一种回落它）、`kind`、`children`、
`order`（缺省 100，小的靠前）、`group`（同组连续排布）、`hidden`、`action`、`view`、`when`、`badge`。
文本字段会截断（label 60 / icon 16 / hint 200 字符）。

**kind 词表**：`view` | `action` | `badge` | `menu` | `page` | `organizer` | `divider` | `toggle` | `input` | `progress` | `select`（缺省 `action`；
`slot == "settings.pages"` 时缺省 `page`）。语义：`view` 切视图（`view` 缺省 `plugin:<id>`）；`action`
点击回给插件（经 `host.onUiAction`）；`badge` 只显示状态文本/角标（可经 `host.ui.update` 刷新）；
`menu` 展开 `children`；`page` 是设置面板里的一整页；`divider` 分隔线；`organizer` 是整理器（词表里
保留的种类，当前各渲染层没有专门处理）；`toggle` 开关（`checked`，点击回插件）、`input` 单行输入
（`value`，回车回插件时附带输入值）、`progress` 进度条（0-100，只展示）、`select` 下拉（`options` 候选 +
`value` 当前值，切换回 `onUiAction(itemId, value)`）。`select` 全槽位可画：顶栏/输入框/消息工具条/
终端-SCM-目标条共享工具条/底栏/左栏会话行/通知条落成原生下拉，右键菜单展开成子菜单（点选子项回
父条目 + value，见 `expandSelectEntries`），右栏 tab 按既有口径当 tab 打开（与 toggle/input 一致）。

**`children` 只一层**：解析时子项自己的 `children` 被清掉（防嵌套），子项也没有稳定的全局 id ——
所以子项**不参与** `arrange` 与用户偏好。当前实现里只有**右键菜单**把 `children` 画成子菜单
（`ContextMenu.tsx`），其它槽位只画父条目。

**`when`**：宿主上下文条件，宿主不认识的值直接忽略、不报错。当前只有右键菜单评估它
（`web/src/context-menu-state.ts` 的 `evaluateWhen` + `buildWhenContext`，`ContextMenu.tsx`
按槽位 + 被右键对象现场构造上下文）：字面量 `"disabled"` / `"never"` 恒置灰、`"always"` 恒可用、
以 `!` 开头的条件（如 `"!message.hasSelection"`，有上下文按上下文判、无上下文按 legacy 直接置灰），
以及肯定形适用条件 —— `file.isDir` / `file.isFile`（文件菜单，按 target.kind）、`session.isRunning`
（会话菜单）、`message.hasSelection`（消息菜单）—— 为假则**保留但置灰**。未知条件名默认可用
（未来加新条件不翻旧插件）。

### 合并优先级（四级）与「同一份计算」

每个 slot 的最终条目都由 `buildUiSlots(plugins, { locale, t, disabledPlugins, layout })` 算出：

| 层         | 来源                                                                                                                                                                                                                                     | 规则                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 宿主默认 | `BUILTIN_UI_ITEMS`（**109** 条 `host:*` 内置条目，覆盖 **12** 个 slot：顶栏 18 / 文件右键 27 / SCM 工具条 12 / 底栏 10 / 文件预览头栏 9 / 目标条 8 / 输入框动作 7 / 会话右键 6 / 消息工具条 5 / 终端工具条 3 / 左栏分区 3 / 右栏 tab 1） | 可见性、顺序、分组、文案的基线                                                                                                                       |
| 2 插件贡献 | `UiPluginInfo.ui.items`                                                                                                                                                                                                                  | 同 id 后声明的插件覆盖前面的（**位置仍按首次声明**，避免重声明把条目挤到列表尾部）；报错插件与「界面插件」里被禁用的插件整份丢弃                     |
| 3 插件安排 | `ui.arrange`（可改 `slot` / `hide` / `group` / `order` / `label` / `hint` / `icon` / `iconSvg`）                                                                                                                                         | 只能改**已存在**的条目（目标不存在 = 静默忽略）；改了别人的条目会记进它的 `arrangedBy`（含 `movedFrom`）—— 这是「插件不许偷偷改宿主 UI」的可见性保障 |
| 4 用户偏好 | `settings.uiLayout`（`UiLayoutPrefs`：`hidden` / `shown` / `order` / `groups` / `labels`）                                                                                                                                               | 最高：用户点过什么就由它最后说话；`shown` 在 `hidden` 之后应用（「显示」是对上一次隐藏的撤销，必须生效）                                             |

同 order / 无排序信息时保持声明顺序（稳定排序兜底）。**「同一份计算」是这套框架的核心不变量**：渲染层
（TopBar / FooterBar / ChatInput / Message(List) / RightPanel / LeftPanel / SettingsModal）与设置面板
「界面布局」页跑的是同一个 `buildUiSlots()` —— 布局页里看到的顺序 / 分组 / 文案就是界面上生效的，所以那页
能逐条隐藏（勾选框）、↑/↓ 调序、单条「恢复」与「全部恢复默认」，并给被插件改过的条目标一个「插件调整过」
（`arrangedBy`）。恢复只撤**用户偏好**（插件 `arrange` 的意图仍生效，要连它一起撤就禁用插件）；条目上的
`source` / `userOverrides` / `arrangedBy` / `movedFrom` 就是布局页用来解释「这条是谁挪走的」的依据。

**文案（`labels`）的落地规则**：`UiSlotEntry.label` 分两类 —— 宿主内置默认（`t(labelKey)`）与**显式指定**
（用户在布局页改名 / 插件 `arrange.label` / 插件自己声明的条目）；后者会置 `UiSlotEntry.labelExplicit`。
渲染层必须看这面旗：内置条目一直画的是自己写死的 i18n 文案与实时数值（顶栏按钮、底栏数值徐标），只有
`labelExplicit` 立着时才让位 ——名字型条目（视图三连 / 搜索 / 插件条目…）用用户文案顶掉内置文案；数值型
（上下文 / 成本 / 缓存 / 消息数 / 连接态…）把名字插在数值前，**不吞掉实时数据**（`BarItem` 里的 `named()` /
`withName()`）。没置旗时渲染结果与旧版逐字节一致，所以「插件的 label 与用户的改名对内置条目也真的生效」
（issue #555；回归：`tests/unit/bar-item-unified.test.ts`、`tests/ui-layout-ui-test.mjs`）。

### 溢出与隐藏

只有**顶栏**有溢出概念：主栏本身不限量（与底栏同款直排，窄屏横滑/桌面端换行），被 `hidden` 的条目、
以及直接声明在 `topbar.overflow` 的常驻条目进「⋯」溢出菜单 —— 也就是说插件能把宿主内置入口从主栏挪走，
但它在溢出菜单与布局页里都还在，用户点一下布局页的「恢复」就能拿回原位（插件能整理一切，却锁不死用户）。
其它槽位没有溢出：`hidden === true` 就是不显示（右键菜单连菜单项都不生成）。布局页按 22 个挂载点全量分组
（`SettingsModal.tsx` 的 `uiLayoutSections`，与 `SLOT_IDS` 同顺序——两边都严格按实际界面的 DOM/视觉顺序排：
顶栏 → 通知 → 左栏 → 主列 → 右栏 → 终端/Git 视图 → 底栏 → 悬浮层 → 右键菜单 → 设置页 → 对话框；搜索框可过滤，
搜索时 ↑↓ 禁用）。顶栏 / 底栏 / 输入框动作区在界面上按对齐段（左 start → 中 center → 右 end）分段渲染，
布局页同口径按段列出（段头即界面上的段），↑↓ 只在段内移动，换段走对齐下拉。左右停靠栏
（`sidebar.left` / `sidebar.right`）同口径但轴是**竖的**：start=靠上 → center=居中 → end=靠下，
布局页的段头与对齐下拉用「靠上/居中/靠下」措辞（同一套取值、同一份 `uiLayout.align` 偏好）。

**宿主内置条目同样受这些规则管**（这是「设置里看到的 == 界面上看到的」这条不变量的关键一半）：

| 位置                                                         | 渲染方式                                                                                                                                                                                                                                                                                      | 隐藏 / 调序的效果                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 顶栏全条目（品牌/历史/文件/新对话/视图三连/插件视图/工具组） | `TopBar.tsx`：**单一扁直流** —— 所有条目都是 `.topbar-flow` 的直接子节点（无任何按种类包裹的容器，也无两端贴边例外），宿主查 `hostNodes` 节点工厂、插件通用渲染（插件视图经 `withPluginViewItems` 合成 `kind="view"` 条目），`align` 只决定落两个 `.tb-spacer` 划出的 start/center/end 哪一段 | 勾掉 → 从主栏消失并进「⋯」溢出菜单（点回仍可用）；↑↓ 换位置；align 搬分区 —— 三者对**每一个**条目生效；**菜单型条目（声音/语言/主题/版本/GitHub/浏览器）整块组件搬进菜单**（不是只剩一个点了没反应的标题）；**桌面与手机同一份数据**：宽度放不下的条目按视觉顺序从尾部退进同一个「⋯」（`web/src/topbar-fit.ts` 实测宽度），旧版手机端那套 CSS 整组隐藏 + 硬编码「⋯」面板已删 |
| 底栏                                                         | 按 slot 顺序从 `bottombarItems` 渲染（`FooterBar.tsx`），左/中/右三区按 `align` 落位                                                                                                                                                                                                          | 勾掉 / ↑↓ / 对齐三者都生效                                                                                                                                                                                                                                                                                                                                                   |
| 输入框动作区（`composer.actions`）                           | `ChatInput.tsx`：宿主 7 项（上传/模板库/模型/思考/DSH 权限/预设/发送簇）＋插件按 slot 顺序交错渲染                                                                                                                                                                                            | 勾掉 / ↑↓ / 对齐三者都生效（发送簇 `align=end` 落右侧；藏掉发送后回车仍可发送）                                                                                                                                                                                                                                                                                              |
| 输入框前置区（`composer.leading`）                           | `ChatInput.tsx` 按 slot 顺序渲染在上传按钮左侧                                                                                                                                                                                                                                                | 勾掉 / ↑↓ 都生效（纯插件位，无内置条目）                                                                                                                                                                                                                                                                                                                                     |
| 消息 hover 工具条                                            | `Message.tsx` 跳过 `hidden` 的条目                                                                                                                                                                                                                                                            | 全被隐藏 → 整条容器都不画（不留空壳）                                                                                                                                                                                                                                                                                                                                        |
| 左右停靠栏（`sidebar.left` / `sidebar.right`）               | `SideDock.tsx`：`align` 读作竖轴（start=靠上 / center=居中 / end=靠下），三段各画一颗**内容高**的贴边药丸（空段不画底、也不吃点击），弹性格子把停靠栏撑满整列                                                                                                                                 | 勾掉 / ↑↓ / 对齐三者都生效；折叠按钮**只在悬浮模式**出现（流内收起省不下宽度），收起后只剩一个展开小按钮。回归 `side-dock-align-ui-test.mjs`                                                                                                                                                                                                                                 |
| 右栏 tab                                                     | `RightPanel.tsx` 按 slot 顺序渲染（含内置「文件」tab 的位置，不再固定第一）                                                                                                                                                                                                                   | 勾掉（含内置「文件」tab）/ ↑↓ 都生效                                                                                                                                                                                                                                                                                                                                         |
| 左栏三个分区（最近项目/运行的对话/历史对话）                 | `LeftPanel.tsx` 按 `web/src/left-sections.ts` 的计划渲染：顺序与显隐走宿主 `leftpanel.sections` 的三条条目（`host:lp-projects` / `host:lp-running` / `host:lp-history`，布局页可勾选 / 调序；插件 arrange 可隐藏，不能挪走）                                                                  | 勾掉 → 整区不渲染、不占权重；上下调序生效（分隔条按可见分区重新配对）                                                                                                                                                                                                                                                                                                        |
| 文件预览头栏                                                 | `FilePreview.tsx` 的 `.fp-head-actions`：宿主 9 项＋插件按 slot 顺序交错                                                                                                                                                                                                                      | 勾掉 / ↑↓ 都生效（markdown/html/编辑/换行/缩放仍受文件类型条件约束）                                                                                                                                                                                                                                                                                                         |
| 目标条                                                       | `GoalBar.tsx`：编辑行（设目标/提炼/锁定/收起）/ 选项行（审查模型/轮次）/ 活跃行（清除）/ 收起 pill 四簇分别按 slot 排序，插件跟随同行                                                                                                                                                         | 勾掉 / ↑↓ 都生效（pill 全藏且无插件条目时整条不占位）                                                                                                                                                                                                                                                                                                                        |
| SCM 面板                                                     | `SCMPanel.tsx`：头栏（视图 tab/刷新＋插件）与分支行（分支/切换/推送/拉取/提交输入/提交/全部提交）分别按 slot 排序                                                                                                                                                                             | 勾掉 / ↑↓ 都生效（分支名展示是纯信息不进槽位；底部「去终端」按钮只跟显隐）                                                                                                                                                                                                                                                                                                   |
| 终端面板                                                     | `TerminalPanel.tsx`：命令列表头（刷新/新建）与终端 tab 头（新建＋插件）分别按 slot 排序                                                                                                                                                                                                       | 勾掉 / ↑↓ 都生效（命令/标签行是数据，不动）                                                                                                                                                                                                                                                                                                                                  |

顶栏没有结构性容器划分：整条按 slot 顺序直排（连续同类才成组裹容器，组间顺序即 slot 顺序），布局页的 ↑↓ 跨
品牌/视图/工具真实换位（默认顺序号即旧版视觉顺序：history 锁扣首位、new-chat/files 工具组之尾，见
`BUILTIN_UI_ITEMS` 注释）。面板内部同理按簇划分（SCM 头栏↔分支行、终端双头、目标条四态各行、左栏纵向分区）。
`uiPrimary` 完全没传时（单测 / 未来别的调用方）渲染层退化为「按内置默认顺序全画」，不会因为拿不到 slot 数据就把顶栏清空。

### `host.ui.*`：运行时注册

| 方法                | 语义                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `register(items)`   | 注册 / 覆盖条目（同 id 覆盖 manifest 声明的，单次最多 32 条），返回注销函数（把本次注册的 id 移进 `removed`）                           |
| `update(id, patch)` | 部分更新一个**当前生效**的条目（manifest 的与运行时注册的都算；不存在的一律忽略，防插件凭空造条目绕过声明审查），典型用途是刷新 `badge` |
| `remove(id)`        | 移除条目 —— manifest 声明的也能移除（id 记进 `removed`，合并时不会复活，直到 reload 重新解析）                                          |
| `arrange(ops)`      | 追加整理意图（与 manifest 的 `arrange` 顺序拼接），只改已存在的条目并留痕 `arrangedBy`                                                  |
| `list()`            | 当前生效的贡献快照 `{ items, arrange }`（调试 / 自查用）                                                                                |

生效结果 = manifest 基线 + 运行时注册（同 id 覆盖、`removed` 删除），随 `plugins` 清单的
`UiPluginInfo.ui` 下发；每次 `register` / `update` / `remove` / `arrange` 都重推一次清单。注册时的 slot
解析与 manifest **同一套口径**（先映射别名、再校枚举）—— 早期运行时注册少了这一层校验，插件写个别名
（或写错）会得到一个前端不认识的 slot，表现为「注册了但界面上没有」，最难排查。

### 内置条目的实现留在组件里（踩过的坑）

App 只分发**插件**动作（`triggerPluginUiAction`：先找该插件名下的处理器，再按需加载它的 client bundle
后重试，都没人接管就提示一句）；`host:*` 内置条目的实现住在渲染 / 打开它的那个组件里，由组件按
`entry.id` 自己分派 —— 例如 `host:file-add-root` / `host:file-open-project` 在 `RightPanel.tsx`、
`host:conv-force-dismiss` 在 `LeftPanel.tsx`、`host:msg-edit-reask` 在 `Message.tsx`。原因：这些动作
需要组件自己的上下文（右键的是哪个目录、哪条对话、消息的附件与重问逻辑），App 拿不到。右键菜单因此还
要在打开时把「host 条目分派器」（`onHostAction`）随请求交给 `web/src/context-menu-state.ts` 的全局唯一
菜单状态。**踩过的坑**：早期把内置条目也当插件动作统一交给 App 分发，那些点击全都没反应（App 不知道
上下文，只能静默失败）。

### 弹窗（`modal.dialog`）

第 22 个槽位：插件声明 `kind="view"` 的条目，经宿主桥按需弹成弹窗（`PluginModal.tsx`）。

```json
{
	"permissions": ["ui"],
	"ui": {
		"modal": [{ "id": "preview", "label": "预览", "kind": "view", "view": "plugin:my-plugin" }]
	}
}
```

```js
// client/entry.mjs：某个按钮点一下弹自己的弹窗，关由用户（Esc/遮罩/✕）或 closeModal()
window.__piWebUiHost.onUiAction("my-plugin:open", () => {
	window.__piWebUiHost.openModal("my-plugin:preview");
});
```

- 开关走宿主桥 v10（`openModal(id)` / `closeModal()`）：id 是全局 id（`<pluginId>:<itemId>`），
  不存在 / 被用户在布局页隐藏 → 返回 `false`；同一时刻只开一个（后来者顶掉先开者）。
- 内容按 kind 分发：`view` 挂插件视图（bundle 按需加载，没好先转 loading，与顶栏动作同一条
  `ensurePluginViewLoaded`）；其它 kind 落成单个大按钮（点了回 `onUiAction` 并关弹窗）。
- 开关状态是浏览器本地态（不进快照、不进 layout）：刷新即关；`hidden` 只管“能不能开”。
- 布局页有独立“弹窗”分组（可隐藏条目；排序无意义——弹窗一次只开一个）。

## 目录授权与跨目录 fs（issue #146）

`host.fs` 有两条腿，分工明确：

- **工作区相对**（`list` / `read` / `readText` / `write` / `remove`）：`WorkspaceFS`，路径锚定**活 cwd 根**
  （跟随 `set_cwd`），越界拒绝。
- **跨目录**（`listPath` / `readPath` / `readTextPath` / `writePath` / `removePath`）：锚定「用户点过头的
  目录」，每次操作都要求路径已授权，否则抛错 —— 错误信息直接告诉你先 `await host.fs.requestAccess(dir)`。

**授权流程**（`requestAccess(dir, reason)`）：

1. 路径归一（`normalizeGrantPath`：只收**绝对路径**，相对路径直接拒绝）→ 落在工作区内（cwd + 额外工作
   区根）或已在授权表里 → 直接返回 `true`，**不打扰用户**。
2. 否则服务端向**所有在线客户端**推 `plugin_path_request`（`{ id, pluginId, path, reason? }`），浏览器弹
   确认框（`App.tsx`），用户答复经 `plugin_path_response` 回传 —— **只等第一个答复**；未答复 120 秒超时
   视为拒绝。
3. 同意即写进授权表 `<dataDir>/plugin-grants.json`（`server/plugin-grants.ts` 的 `PluginGrantsStore`），下次
   不再问；`authorizedDirs()` 返回本插件当前被批准的目录。

**授权表语义**：全局共享（不是 per-client —— 授权是「这台机器上的这套插件配置允许访问哪些目录」，任何
浏览器看到的都是同一份）；**父目录授权覆盖子目录**（目录授权天然是子树授权，否则用户只会一路盲点同意），
反向不成立（只批了 `/proj/a` 时访问 `/proj` 仍要问）；判定按路径分段边界做，不做裸前缀匹配（`/proj` 不
覆盖 `/project`）；win32 比较折大小写，但**存储保持写入时的形式**；读不出来 / JSON 坏 / 形状不对一律当
空表，且**不在读路径回写**（否则一次磁盘抖动就静默清空用户全部授权）；只有真正发生变更的写才落盘
（临时文件 + rename 原子写），写失败 best-effort（内存态仍生效，本次会话可用）。

**受支持路径 = 工作区（cwd）+ 额外工作区根 + 该插件的已授权目录**，其余一律抛错。这与「插件自己
`import node:fs` 碰任意路径」的差别就是宿主能强制的那一层 —— 插件的服务端代码本身是全权 Node 代码，要
真正限制得靠 OS 沙箱（不在本项目范围），所以这里的价值是让受支持路径覆盖更多场景，同时保证「用户知情 +
可撤销」。

**撤销**：设置面板「界面插件」页的「已授权目录」段列出授权表并逐条撤销（`plugin_path_revoke`；协议上还
支持按插件清空、整表清空）。另外浏览器里还有一份 localStorage 记录（`pi-web-ui:plugin-path-grants`，见
`App.tsx`）—— 那是**宿主动作桥**为了避免每次 `openSession` / `sessions.open` 都弹框而记的（「最近项目」
里的目录同样视为已知、不弹框），与插件自己 `host.fs` 用的服务端授权表是两回事。

## 能力动态授权（host.requestPermission）

manifest 管“有没有这个能力族”（静态），这张表管“运行时的具体范围”（动态）：

```js
// net：在白名单之外再加主机（免改 manifest 重装）
if (await host.requestPermission({ family: "net", hosts: ["api.example.com"], reason: "同步笔记本" })) {
	await host.net.fetch("https://api.example.com/notes");
}
// llm：把模型作用域交给用户定（空 models = 不限）
await host.requestPermission({ family: "llm", models: ["openai/gpt-4o-mini"], reason: "只用便宜模型总结" });
```

- **前置**：基础族必须已声明（net→`net`、llm→`llm`），否则直接 `false` 不弹框——与
  `requestAccess` 要求 `fs:read` 同口径。执行期强制：`net.fetch` 查静态白名单**或**动态表；
  `llm.complete` 声明即全开，但有模型作用域授权时收紧到批准的模型。
- **流程**：静态命中/已有授权 → 直接 `true`；否则经 `permissionRequester` 向所有在线客户端推
  `plugin_permission_request`，等第一个答复（120s 超时=拒绝；答复后推 `plugin_permission_resolved`
  让其它端收起）。`remember=true` 落盘 `<dataDir>/plugin-permissions.json`，否则只记内存（重启即失）。
- **审计/撤销**：`plugin_permissions` 快照（attach 推 + 变更重推，session 授权带标记），设置面板
  「已授权能力」段逐条撤销（`plugin_permission_revoke`，支持按插件/按族/按主机或模型/整表清空）。
- DSH/无浏览器时一律 `false`。实现：`server/plugin-permissions.ts` + `PluginManager.permGrants` +
  `index.ts` 接线（与目录授权同构）。

## 定时任务持久化（host.schedule 的 persistent）

```js
host.schedule("0 9 * * *", sendDailyReport, { persistent: true, id: "daily", catchUp: "once", label: "日报" });
```

- 声明从“分钟步长”升级到**全 5 字段 cron**（分 时 日 月 周，月/周支持英文名，日-周标准 OR 语义，
  服务器本地时区；旧 `"*/N * * * *"` 是子集照常工作）。毫秒数字仍收（内存版底线 10s，持久版 60s）。
- **引爆方式是分片的 setTimeout**：`armDelay()` 把「距离下次触发」切成 ≤6 小时的分片，醒来重算，
  真到点才触发；`nextCronFire` 在「一年内没有下一次」（如 `0 0 31 2 *`）时回 `null`、
  后台面板显示「不再触发」。原因：Node 的 setTimeout 延迟超过 2^31-1ms（≈24.8 天）会溢出成 1ms，
  配上「下次在 42 天/一年后」的合法表达式就是「1ms 后再触发」的死循环（触发还会回调插件 →
  写盘 + 广播）。回归：`tests/plugin-cron-overflow-test.mjs`。
- `persistent: true` 必须带合法 `id`：声明 + `lastRun` 落盘 `<pluginDir>/schedules.json`，每次
  `activate` **重调** `schedule()` 即重建（幂等：保留 `lastRun`/`createdAt`，只更新声明）。
  反激活只停表不断持久化；`off()`/面板停止 = 删声明（不再复活）。
- `catchUp: "once"`（缺省 `"skip"`）：重启发现漏跑（以上次触发/创建时间锚，下一次已在过去）
  15s 缓冲后补跑一次（等模型/网络就绪）。
- 持久任务自动进顶栏「后台任务」面板（⏰ + 下次时间，可停止）。实现：`server/plugin-schedule.ts`
  （解析/下次触发/落盘，纯函数单测）+ `plugins.ts` 接线。

## 项目组装 API（host.project.create，issue #146）

让插件把「几个仓库 + 若干配置文件」拼成一个工作区。**前置**：插件要有 `fs` 能力族，且目标目录在工作区内
或已授权（否则返回 `{ ok: false, error: "项目目录未授权：先 await host.fs.requestAccess(...)" }`）。

```js
const res = await host.project.create({
	dir: "/abs/path/to/workspace", // 必须**已存在**的绝对路径（本 API 不创建新的根）
	repos: [{ url: "git@github.com:me/app.git", subdir: "app", ref: "main" }],
	files: { "app/.env.example": "FOO=1\n" }, // 相对路径 → 文本（≤1MB/个、≤32 个）
	gitInit: false,
});
// res = { ok, error?, log, dir }；log 是逐行执行日志，进度同时以 notify 广播到浏览器
```

执行顺序：校验根目录 → 校验 `repos` / `files`（**纯计算，全部在动磁盘之前**）→ `mkdir` 子目录 →
`git clone --depth 1 [--branch <ref>]` → 写文件 → 可选 `git init`。三条硬约束：

- **越界拒绝**：`subdir` 与 `files` 的 key 一律按相对路径解析，resolve 后必须仍在 `dir` 之内（拒绝绝对
  路径与 `..`），并用 realpath 复核目标（或它最近一个已存在的祖先）—— 防 junction / 符号链接把写入引到
  目录之外；`replace: true` 不允许用在项目根（那是删用户自己的目录，不是「清空一个子目录」）。
- **不注入选项**：git 走 `spawn`、不过 shell；URL 以 `-` 开头直接拒绝（`--upload-pack=` 这类能让远端执行
  任意命令的选项注入，argv 数组挡不住）；git 子进程关掉一切交互式提问（`GIT_TERMINAL_PROMPT=0` /
  `GCM_INTERACTIVE=never` / ssh `BatchMode`），单条 git 命令 5 分钟超时后连坐整棵进程树 —— 服务端没有
  TTY，交互式认证会挂死到看门狗超时。
- **失败不留半成品**：任何一步失败立即停，返回 `{ ok: false, error, log }`（第一个失败点的原因 + 已走过
  的步骤），不吞错、不假装成功；一个半成品项目配上「成功」比直接报错更坏。

组装完的目录就是个普通目录 —— 接下来由插件自己决定去向（例如 `host.openSession({ cwd, roots })` 开一个
新会话，或 `set_cwd` 切过去）；`host.project.create` 不做任何隐式的切项目 / 开对话。

## 多根工作区（`set_workspace_roots`，issue #146）

**语义**：AI 仍只在主 cwd 里干活（pi SDK 是单 cwd 模型，多根**不**等于多工作区）；额外根只影响两件事
——「哪些路径算工作区内」（插件的受支持路径）与右栏文件树的根（一次只展一个根，不做合并视图）。

- **协议**：上行 `set_workspace_roots { roots? }`；快照字段 `UiState.workspaceRoots`（两个引擎都下发；DSH
  引擎没有插件宿主，多根只让文件树受益）。空数组 = 回到单根。
- **归一化**（`server/client-state.ts`：`normalizeWorkspaceRoots` / `MAX_WORKSPACE_ROOTS = 8`）：只收绝对
  路径、去重（win32 折大小写）、上限 8 个（不含主 cwd）、resolve 成规范形式；脏元素（数字 / 空串 / 对象）
  逐个丢弃而不是整份回落。刻意**不校验目录是否存在**：根可能是暂时断开的盘或挂载点，不该把用户设过的根
  静默清掉。
- **按项目持久化**：存在 client-state.json 的 `workspaceRoots[cwd]`，切项目就换成该项目自己那套；空数组会
  清掉该项目的键（不留空壳）。重复写同一份 = no-op（不推快照、不打扰插件）。
- **前端**：右栏 crumbs 里的**根选择器**（有根才渲染；列出主根 + 各额外根，可逐条移除 —— 移除正在浏览的
  那个根会退回主根）。**两个加根入口**：文件树右键「添加为工作区根」（只对目录行可见，已在列或就是主根时不显示）、
  底栏 cwd 选择器头部的「＋ 添加为工作区根」（把当前浏览的目录加成根 —— 底栏本来就是改工作目录的地方，用户找得到）。
  增删都走 `set_workspace_roots` 整份写回，服务端的值是唯一事实源。
- **插件侧影响**：`PluginManager.isInsideWorkspace()` 把 cwd 与**全部额外根**都算「工作区内」⇒ 这些根在
  `host.fs`（跨目录族）与 `host.project.create` 里**免授权**（用户加根 = 「我认它是我工作区的一部分」）。
  根变化经 `notifyWorkspaceRoots` 同步给插件宿主；刻意**不发** `onCwdChange` 钩子 —— 那个钩子的语义是
  「当前目录变了」。
- **为什么不放 localStorage**：多根不是纯 UI 偏好 —— 服务端的插件宿主（`isInsideWorkspace`）要据此决定
  哪些路径免授权，所以事实源在服务端、随快照下发（顺带得到多标签页一致与按项目持久化）。反过来，插件
  **不能**自己加根：`set_workspace_roots` 是宿主侧（用户）动作 —— 正因如此，`host.openSession` 的 `roots`
  里每个目录都要先过用户授权确认，不能拿 roots 当侧门。

## 项目 / 会话 API（host.openSession / host.sessions，issue #146）

`startChat({ prompt, cwd })` 是「已受理」的短形式（向后兼容）；需要等结果、需要目录授权、需要多根时用
可等待版本：

```js
const res = await host.openSession({ roots: ["/repo/a", "/repo/b"], prompt: "先看 README" });
// res = { ok: true, sessionId } | { ok: false, error }
```

- `cwd` / `folders` / `roots` 都给**绝对路径**：`cwd` 优先，否则取 `folders` / `roots` 的第一个当 cwd，
  其余目录当**额外工作区根**（最多 7 个，见「多根工作区」）。
- 目录**不在最近项目里**、本浏览器也没授权过时，宿主先弹确认框（确认结果记在浏览器 localStorage
  `pi-web-ui:plugin-path-grants`）；**每个额外根也要过这一关**（成了工作区根就意味着插件读它不必再授权，
  不能让 `roots` 当侧门）。用户拒绝 → `{ ok: false, error }`，当前会话与工作区不会被破坏。
- 顺序：授权 → 切 cwd（等服务端快照跟上）→ 写额外根（**在切项目之后**写：服务端按项目存根）→ 开新对话
  （等 activeId 落定）→ 可选发出 `prompt`；每步都有超时（默认 8s），超时 / 失败一律结构化返回
  `{ ok: false, error }`。

**会话列表与打开**（`host.sessions`，v2 引入）：

| 方法       | 行为                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list()`   | `{ id, title, cwd, kind, isStreaming? }` 数组：**本客户端运行中的对话**（`kind:"running"`，id = conversationId，cwd 各自带）＋ **当前项目的历史会话**（`kind:"history"`，id = session 文件路径，cwd = 当前 cwd —— 服务端的历史会话列表就是按 cwd 扫的）       |
| `open(id)` | 跨项目先切 cwd（同一套目录授权；不切就找不到目标文件）→ `running` 用 `switch_conversation`、`history` 用 `switch_session` → 等 activeId 变化；返回 `{ ok: true, sessionId }` 或 `{ ok: false, error }`（未连接 / 找不到 id / 切换超时都走这条回执，不抛异常） |

## 注册面目录（机器可读，P2-7）

类型唯一事实源 `server/protocol.ts#PluginApiCatalog`，装配 `server/plugin-api-catalog.ts`（静态 slot 例子+宿主方法表，单测锁住与源码同口径），占用者由 `PluginManager.getApiCatalog()` 现算（manifest 基线+运行时注册合并计数，只含条目数不含内容）。下发走 WS 只读查询 `plugin_api_catalog` → `plugin_api_catalog_result`（`requestId` 回显，不进快照/清单，按需拉）。给将来「AI 写插件」铺路（能力发现与执行分离，先查真实 API 再写码）；当前消费方是插件作者与后面的设置面板目录页。回归：`tests/unit/plugin-api-catalog.test.ts` + `tests/plugin-api-catalog-test.mjs`（已进 run-smoke）。

## 真实插件

| 插件          | 目录                             | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| demo-mailbox  | `plugins/demo-mailbox/`          | 内存邮箱 demo，plugin-test 夹具                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| mermaid       | `plugins/mermaid/`               | 📊 ` ```mermaid ` 围栏 → SVG（renderer 插件，自带 vendor 引擎本地优先加载）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| webmail       | `plugins/webmail/`               | 📬 网页邮箱，IMAP/SMTP 邮件管理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| vscode-editor | `plugins/vscode-editor/`         | 📝 编辑器 + SSH（原独立插件合并）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| sftp          | `plugins/sftp/`                  | ☁ 项目级 SFTP 同步：**配置跟着项目走** —— `<项目>/.pi/sftp.json`（多环境 profile）+ `.pi/sftp.local.json`（本机覆盖，两层深合并；插件自动把它加进 .gitignore）；**先算差异再传**（add / update / same / local-only / remote-only / conflict 六类，`sftp_sync` 默认 dryRun 只回报、显式 `dryRun:false` 才动文件）；删除永不真删（远端 `<remotePath>/.sftp-trash/<批次>/`、本地 `.pi/sftp-trash/<批次>/`，内部护栏保证垃圾桶不会被回传，按 `trashDays` 清理）；并发流式传输（`createReadStream`/`createWriteStream`，不再整文件进内存）+ `.sftp-tmp-*` 半成品 + rename 原子落盘 + 传后大小校验；凭据只写引用（`${secret:名}` 走 host.secrets 加密 / `${env:VAR}` / `${file:路径}`，残缺引用直接报错而不是静默成空密码），明文仅告警；`mappings` 子树映射、`compare=mtime+size` 带 2 秒容差与「无 mtime 就退化为比大小」的告警、远端 `readdir` 名字防穿越、symlink 跳过、`remotePath=/` 且开删除时强制降级；**一个** action 式 `sftp` AI 工具（status/save/secret/test/plan/sync/ls/read/write/mkdir/mv/rm/search；拆成十几个工具只会塞满上下文）+ 设置页开 `allowExec` 后才进 enum 的 `exec`（默认关：模型看不见的能力才是真关掉）+ 面板直通的手动 `POST /transfer`（远端树每行 ⬇ 下载、工具栏「上传本地对应目录」、本地文件树右键两条，固定 deletePolicy=none 所以手动推目录不会清远端）；视图 tab（连接管理 / profile 切换 / 差异清单 / 传输进度 / 远端文件树与编辑）+ 底栏状态徽标 + 文件右键「上传到远端」；一键迁移 `.vscode/sftp.json`（明文口令转加密机密）。回归：`tests/sftp-plugin-test.mjs` |
| db-client     | `plugins/db-client/`             | 🗄️ 数据库连接管理（mysql2/pg/mssql/sqlite/mongodb/redis）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| run-trace     | `plugins/run-trace/`             | 🧭 运行轨迹时间线：当前对话的横向泳道时间轴 + 分段分析（host.onRunEvent + getActiveConversation + onConversationChanged）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| legado-web    | `plugins/legado-web/`            | 📖 Legado 阅读（文本源）：搜索/发现/详情/目录/正文，书源与安卓版兼容；内嵌 Vite 前端（`client/app/`，iframe 视图）+ 自带 `/proxy`（跨域+GBK）与 `/store`（书源/书架/进度只落数据目录 `<dataDir>/legado-web/`，不写 localStorage）+ 四个 AI 修源工具（`legado_rules`/`legado_book_sources`/`legado_source_probe`/`legado_run_rule`，规则引擎跑在 worker 里，同步 JS 规则走 SharedArrayBuffer 桥）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| wechat-ilink  | `plugins/wechat-ilink/`          | 💬 微信通道：扫码登录直连微信 ilink 后端（openclaw-weixin 同源协议），出站长轮询收消息 + `host.chat` 无头驱动 agent + run_end 回包，无需公网 IP；陌生人配对 + `wechat_send` 工具；设置可配默认工作空间 / 模型（下拉）/ 思考强度（下拉）/ 投递到网页当前会话（issue #226）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| image-toolkit | `plugins/image-toolkit/`         | 🖼 图片工作台：压缩（目标体积二分逼近）/裁剪/缩放/旋转翻转/格式转换/批量 ZIP/水印/滤镜调色/信息与 EXIF/剪贴板与拖放导入，可读写工作区图片（`/ws/list\|image\|probe\|save\|settings`，走 `host.fs` 越界拒绝，原始字节不经 base64）+ 四个 AI 工具（`image_info`/`image_transform`/`image_compress`/`image_watermark`，PNG/BMP 用自带纯 JS 编解码、JPEG 经 `ensureDeps` 装纯 JS 的 jpeg-js）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| notes         | `plugins/notes/`                 | 📌 笔记 · 待办 · 提醒三合一：笔记（Markdown+标签+搜索）/待办（优先级/截止/重复）/提醒（一次性·每天·每周·每月·间隔·cron；定时只挂**一条** `host.schedule("* * * * *")` 每分钟巡检，每条提醒自己带 `nextDue` 落盘 —— 远期 cron 不交给宿主，避开它的 setTimeout 24.8 天溢出，见该插件 README）；顶栏 📌 开**可拖拽全局浮窗**（`dom:anchor` 免授权，位置/尺寸/最小化记忆，设置是窗口内的覆盖层；`view:false` + `preload:true` —— 没有独立视图 tab，但每次进页预加载 bundle 让提醒轮询/快捷键常驻）；数据在 `<dataDir>/notes/store.json`（原子写，删插件不删数据）；通道只用 HTTP（`/plugins-api/notes/store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | wait | op  | export`，长轮询推送，不依赖 mount 时的 ctx）；5 个 AI 工具 + `/note` `/todo` `/remind`。回归：`tests/notes-test.mjs`/`tests/notes-ui-test.mjs`/`tests/unit/notes-plugin.test.ts` |
| pm2-manager   | `plugins/pm2-manager/`           | 🚀 进程管家：用 pm2 统一托管 AI 的后台任务 —— 注册 action 式 `pm2` 工具（list / start / stop / restart / delete / logs / describe / install / version，description/snippet/guidelines 三处引导「长期任务走 pm2 更省心」）+ 内嵌进宿主「后台任务」面板（`view:false` + `ui["tasks.panel"]` 一条 kind="view"，与宿主自己 diff 出来的后台进程同一面板：状态/CPU/内存/重启/时长、日志、停止/重启/删除、未装 pm2 一键 `npm i -g pm2`）；跨平台一律走「`process.execPath` + pm2 的 JS 入口」，不碰 Windows 的 `.cmd` 垫片与 PATH。**刻意不接管**：不对 bash 做任何拦截或追加提示（无 `onToolPre` 闸门、无 `#bg-ok` 逃生门、无 `onToolPost` 催办），管不管由模型与用户自行决定。回归：`tests/pm2-manager-plugin-test.mjs` / `tests/unit/pm2-manager.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| page-picker   | `plugins/page-picker/extension/` | 🎯 网页元素拾取（**浏览器扩展**，不是 pi-web-ui 插件）：在开发网页上点选元素 → 采集定位串 / 命中的 CSS（Vite dev 下含源文件行号）/ React fiber 里的组件文件:行号 / 计算样式差异 → 渲染 Markdown → 经宿主动作桥 `compose()` 注入 pi-web-ui 输入框（`world:"MAIN"` 注入 + 闭合 Shadow DOM overlay；esbuild 打包 4 个入口 background/picker/bind/options，`npm run build:extension`）。点图标**先认页面**：是 pi-web-ui（宿主动作桥 `__piWebUiHost`，老版本退一步探同源 `/api/health`）→ 注入 `bind.js` 浮条问「要不要把这页绑成服务地址」（远程/局域网部署不用手打地址；缺授权则引导到带 `?bind=` 的选项页 —— `permissions.request` 要扩展自己页面里的手势），否则注入拾取器（拾取态底部常驻一条**细条**：本页 AI 授权状态 + 「让 AI 操作本页…」/「与另一页配对…」/「退出」—— AI 授权入口不再需要先点一个元素才从确认条里露出来；状态经 `page-picker:page-state` 查，授权表变化时自刷）。「发哪几类信息」是**多选**（页面上下文/定位/XPath+DOM/源码/文本/命中 CSS/计算样式/骨架 + 截图，另配 6 个预设），**没勾的在采集层就不采**（不是渲染时再删）                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 回归测试

| 测试文件                                   | 端口        | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ui-layout-ui-test.mjs`                    | 随机        | 布局不变量 E2E（真 Chrome，48 checks）：插件 arrange 藏宿主条目 / 插件条目与宿主同排 / 右栏 tab 顺序 / 勾掉与 ↑↓ 真的生效 / 隐藏的菜单型条目在溢出菜单里还能用 / 消息工具条整条不画 / **布局诊断横幅出现且点名插件与目标 id（P0-1）**（缺 Chrome 自动 SKIP，不入 run-smoke）                                                                                                                                                                                                                                                                                                                                             |
| `plugin-topbar-ui-test.mjs`                | 随机        | 插件顶栏条目（#146）+ 设置面板内后台卸载（#152）E2E：`ui.topbar` 声明的按钮渲染 / 点击按需加载 bundle 并命中宿主动作处理器（用旧名别名 `host.onTopbarAction` 注册）/ 设置面板出现「界面布局」管理段与「源码构建」勾选项 / 卸载走 plugin_job 且**面板全程不关** / 页面无 JS 报错（缺 Chrome 自动 SKIP，不入 run-smoke）。实测 **10 checks 全过**                                                                                                                                                                                                                                                                          |
| `plugin-jobs-test.mjs`                     | 随机        | 插件后台作业（#152）+ 市场目录同步（#148）：非法来源即时拒绝 / 真卸载成功（成功后重推列表）/ 卸载不存在→失败回执带输出尾部 / 本地 JSON 同步→原子写盘+推新条目 / 坏 JSON 不覆盖旧目录                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `plugin-settings-page-test.mjs`            | 随机        | `settings.pages` 插件页 E2E（真 Chrome，12 checks）：manifest 声明的页进设置面板导航 / `hidden:true` 的默认不在导航里 / `mount()` 渲染进画布 / 切走即卸载并调 cleanup / 再点回来重新挂载 / 布局页列出它并可隐藏（隐藏后当前分区回落默认页、不留空白）/ 页面无 JS 报错（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                                                             |
| `plugin-settings-select-ui-test.mjs`       | 随机        | 插件设置表单 select 下拉 E2E（真 Chrome，11 checks）：静态 `options` 照常渲染 / `optionsFrom: "models"` 列已配置鉴权的模型且首项 = 跟随全局默认 / `optionsFrom: "thinkingLevels"` 列 SDK 全档位（i18n 文案）/ 选中保存后 storage.json 落的是选中值 / 无 JS 报错（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                                                                   |
| `context-menu-ui-test.mjs`                 | 随机        | 右键菜单 E2E（真 Chrome，44 checks，实测全过）：文件树 / 列表空白处 / 左栏历史会话 / 运行的对话四条路径的菜单（条目按上下文增删：「以项目打开」只对目录行、「添加为工作区根」只在可加时出现、历史行没有「强行关闭对话」）/ 加根后出现根选择器且能切根 / 「强行关闭对话」两段确认（第一次点菜单不关）/「以项目打开」真的切了 cwd / 页面无 JS 报错（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                  |
| `workspace-roots-test.mjs`                 | 随机        | 多根工作区协议 E2E（已进 run-smoke，11 checks）：加根前插件读工作区外路径被拒（提示未授权）→ `set_workspace_roots` 落进快照 → 同一路径放行（免授权）/ 脏元素（相对路径、非字符串）丢弃 / 根列表是**覆盖**语义不是并集 / 按项目持久化（切走清空、切回还在）/ 空数组回到单根（又需要授权）                                                                                                                                                                                                                                                                                                                                 |
| `plugin-test.mjs`                          | 8978        | 清单推送 / message 回环 / 静默丢弃 / 静态服务 / 路径穿越拒绝 / 插件市场（plugin_catalog add/remove 回环 + 内置条目）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `plugin-command-test.mjs`                  | 8979        | 插件命令全链路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `plugin-http-test.mjs`                     | 8981        | host.route 全链路（GET/POST/404/500/异步 handler 抛错转 500 不打挂进程）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `pm2-manager-plugin-test.mjs`              | 随机        | pm2 进程管家 E2E（已进 run-smoke）：manifest 被宿主接受且无激活错误 / `ui["tasks.panel"]` 占位并入后台任务面板（`kind=view`）/ 服务端入口真激活 / `GET /status` 回结构化状态（installed + platform + installCommand）/ `POST /action` 挡非法入参 / 已删的 `POST /scan` 真回 404（遗留实例交给宿主面板）                                                                                                                                                                                                                                                                                                                  |
| `sftp-plugin-test.mjs`                     | 随机        | 项目级 SFTP 插件 E2E（已进 run-smoke，95 项断言）：配置解析 + 凭据脱敏（state 不含明文）/ 连通性与写权限探测 / 差异计划（默认 ignore 生效、远端独有项给出「为什么不清理」）/ dry-run 一个字节不动 / 真执行落盘且不留半成品 / 删除进垃圾桶且垃圾桶不被回传 / `${secret:}` 与 `${env:}` 引用 + 错误引用显式报错 / 远端 CRUD / 路径越界与非法 remotePath 拒绝 / down 覆盖、both 互补不删、mappings 子树映射 / `.vscode/sftp.json` 迁移后明文不入库 / 单个 action 式工具与 `exec` 开关 / 手动 `POST /transfer`（单文件上下传、远端目录反查本地目录、永不动删除策略）/ `scope=tree` 的远端路径 / `allowExec` 开时远端命令真跑 |
| `plugin-proxy-test.mjs`                    | 8984        | 通用代理 + live-preview 全链路（/liveserver 首页/相对子资源/md 渲染/目录列表/404/越界隔离/Range 206/SSE 首帧）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `plugin-bgtask-test.mjs`                   | 8982        | registerBackgroundTask 全链路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `plugin-leftpanel-running-test.mjs`        | 8985        | 左栏插件运行条目全链路：登记推送 / attach 补发全量 / clear 广播 / 心跳过期整组清空（P3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `plugin-settings-test.mjs`                 | 8983        | 声明式设置 schema 校验/持久化/回显（含 `optionsFrom` 动态候选值透传 + 不校验值）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `plugin-cwd-test.mjs`                      | 8989        | set_cwd→notifyCwd→广播全链路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mcp-bridge-test.mjs`                      | 8990        | MCP 服务器握手/工具调用/失败隔离（10 工具）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `fence-render-test.mjs`                    | 随机        | renderer 插件 E2E：```mermaid → SVG（本地 vendor）、无插件语言回退（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `plugin-update-test.mjs`                   | —           | install/check-updates/rollback 全链路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ssh-plugin-test.mjs`                      | 8964        | SSH 远程文件/终端全链路（mock SSH 服务端）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `db-client-test.mjs`                       | 8968        | SQLite 全链路协议冒烟                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `legado-web-test.mjs`                      | 8993        | legado-web：内嵌前端静态托管 / 代理（UTF-8+GBK、charset 驱动的 URL 与 body 编码、浏览器头不外泄、上游失败 502）/ 存储读写与非法键                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `legado-web-engine-test.mjs`               | 8995        | legado-web AI 修源接口：工具注册 / 书源文件读写 / 链路诊断（含 step 单步）/ 试规则 / 单段 CSS 规则回归 / 同步 `java.ajax`（零 token）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `legado-web-ai-fix-test.mjs`               | 8996        | legado-web 「AI 修复源 / 新建书源」按钮 E2E：harness 页充当宿主（假 `__piWebUiHost`）+ 内嵌阅读页点按钮 → 正文含现场 / 切 chat / 新对话 / cwd=书源目录（书源页 + 发现页 + 新建；缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `legado-web-explore-test.mjs`              | 8998/8999   | legado-web 发现页：收藏书源（下拉「⭐ 常用」分组 + 常用快捷行 + `prefs.json`）/ 直接搜这个源 / 分类浏览与搜索共用列表容器互不串味（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `legado-web-storage-test.mjs`              | 8997        | legado-web 存储契约：数据只落数据目录文件——1.8MB 书源 + 3000 章书架不报 QuotaExceededError / localStorage 无 `legado.*` 键 / 刷新后仍在 / 老浏览器数据一次性迁移 / 书源页搜索与 ⭐ 置顶落 `prefs.json`（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                                                                                                                            |
| 单测 `plugin-host.test.ts`                 | —           | 宿主动作桥：startChat 时序（等 cwd/等新对话才发 prompt）/ 未就绪拒绝 / newChat=false / compose 不依赖连接就绪                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 单测 `plugin-effects-install-spec.test.ts` | —           | **effect 栈**（逆序回卷 / 单条撤销幂等 / cleanup 抛错隔离与归因 / release 幂等；真实 `PluginManager` 反激活后工具·命令·路由·文件监听·总线订阅·自建 effect 全回收，`effects.size` 归零）+ **安装前 inspect**（`parseInstallSpec` 形状分类 / `inspectLocalInstallSpec` 已装与路径判定 / `inspectInstallSpec` 远端探测四种 problem，fetch 替身零网络）                                                                                                                                                                                                                                                                      |
| 单测 `ui-slots.test.ts`                    | —           | slot 合并引擎（含 **diagnostics** 6 例：未知 slot / 未知 kind / 未知 when / arrange 目标不存在 / 插件禁用或激活失败 / 重复声明的诊断与不误报）：内置条目表自检（id 前缀、文案 key 存在、`settings.pages` 不列内置）/ 四级优先级逐层覆盖（含同 id 覆盖但位置不变、arrange 只改已存在并留痕、用户偏好最高）/ `splitOverflow` 不重排不丢 / 恢复语义（单条清干净、不留空壳）                                                                                                                                                                                                                                                 |
| 单测 `plugin-ui-manifest.test.ts`          | —           | manifest `ui` 解析（39 例）：两种形状与混写、6 个别名映射、非法条目 / 重复 id / 非枚举 slot 丢弃、children 只一层、文本截断、arrange 形态与上限；`host.ui.*` 运行时注册（同 id 覆盖 manifest、注销、update 只改已存在、remove 不复活、单次上限、能力门控三态）                                                                                                                                                                                                                                                                                                                                                           |
| 单测 `context-menu.test.ts`                | —           | 右键菜单纯函数：坐标钳制、hidden 跳过与 divider 保留、分组聚类与稳定排序、置灰判定（`disabled` / `!` 前缀）、键盘环形导航与越界处理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 单测 `plugin-grants.test.ts`               | —           | 授权表：父目录覆盖子目录（按分段边界，`/proj` 不覆盖 `/project`）、反向不成立、win32 折大小写但存储保原形式、坏文件视为空表且不被改写、三种撤销粒度、非法 pluginId/相对路径拒绝                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 单测 `plugin-project.test.ts`              | —           | 项目组装：clone / 写文件 / git init 全流程与进度回调、越界（绝对路径 / `..` / 符号链接 realpath）与 `-` 开头 URL 拒绝、replace 不能用于根、超时与多仓库中途失败都不留半成品                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 单测 `workspace-roots.test.ts`             | —           | 多根（13 例）：归一化（绝对路径 / 去重 / 上限 8 / 脏元素逐个丢）、按项目与按客户端隔离读写、宿主侧 `isInsideWorkspace` 把根算进去、切项目不影响已设的根且 `notifyWorkspaceRoots` 幂等                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 单测 `composer-bridge.test.ts`             | —           | 输入框注入桥：sink 缺失即整笔拒收（不出现「附件加了文本没加」的半截状态）/ 空内容拒收 / 注销后拒收 / 脏入参不抛错                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `extension-release.yml`                    | —           | 打 tag 出浏览器扩展 zip（`npm run pack:extension` + Python zipfile 独立校验 manifest 在根目录且 CRC 全通过）并挂到 Release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 单测 `page-picker.test.ts`                 | —           | page-picker 纯逻辑（jsdom）：定位串（短且唯一 / 兄弟冲突收窄 / 兜底全 nth-of-type）、HTML 骨架、XPath 与 DOM 路径、契约 → Markdown（三档体积、降级不输出 undefined、base64 不进正文）+ 绑定文案 `bindView`（远程地址判同 / `?token=` 归一）+ 页面识别 `detectPiWebUi`（桥优先 / `/api/health` / 别的服务不误认 / 探不通 / 1.2s 自我中断）                                                                                                                                                                                                                                                                                |
| 单测 `page-picker-background.test.ts`      | —           | page-picker service worker（假 chrome）：投递决策与复制兜底、composeInPage 桥、截图裁剪数学（dpr 坐标 / 越界 / 可见比例 / 像素对齐）、截屏失败不影响投递、点图标分流（pi-web-ui 页 → 绑定浮条 / 普通页 → 拾取器 / 探测注不进去 → 回落）、`bindServer`（地址归一、已授权不打扰、缺授权回 needAuth 且**不写存储**）、本页授权状态查询（`page-picker:page-state`：未授权 / 已授权带授权表里的标题 / 非 http 页 origin 为空）                                                                                                                                                                                                |
| 单测 `page-picker-page-state.test.ts`      | —           | 拾取细条的状态文案（`grantView` 纯函数）：「正在查」（undefined）与「查不到」（null）分开说、非 http/https 页、未授权、已授权、已授权但总开关关着、标题等于 origin 的回落                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `composer-compose-test.mjs`                | 8900+       | 输入框注入桥 E2E（真 Chrome + 真服务端）：版本号 / compose 落进 textarea + 光标到末尾 / **不覆盖用户已打的字** / 附件去重与累加 / 文本+附件同时到位 / 空内容拒收 / 无 JS 报错（浏览器 E2E，不入 run-smoke，手动跑）                                                                                                                                                                                                                                                                                                                                                                                                      |
| 单测 `plugin-facilities.test.ts`           | —           | storage/secrets/deps/apiVersion 门控                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 单测 `plugin-settings.test.ts`             | —           | schema 解析/校验/持久化（含 `optionsFrom`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 单测 `plugin-setting-options.test.ts`      | —           | 插件 select 候选值合并（静态 `options` + 宿主 `optionsFrom`：空值优先/顺序/去重/当前值保留）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 单测 `mcp-bridge.test.ts`                  | —           | 握手/工具列表/调用/超时；自愈（崩溃后在途调用立即报错、下一次调用自动重启、并发调用共享同一次重连、启动即退出快速报错、close 后不复活）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 单测 `mcp-hot-reload.test.ts`              | —           | mcp.json 热加载：指纹策略（内容没变不重启 / 真变了才应用 / 坏 JSON 保留在跑的服务器且只提示一次 / 删文件 = 清空）、fs.watch 命中与目录不存在时回落轮询、dispose 后不再触发、端到端（真桥 + 真文件：改完工具表跟着变）；`mcp-bridge.test.ts` 另补 reload 语义（规格没变的沿用原实例 → pid 不变、只换变了的、失败保留旧实例、移除的旧进程真被杀掉）                                                                                                                                                                                                                                                                        |
| 单测 `plugin-updater.test.ts`              | —           | 备份/回滚/prune/资源解析                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 单测 `plugin-catalog.test.ts`              | —           | 插件市场：builtin+custom 合并/同 id 覆盖/source 校验/默认 id 推导/增删持久化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `notes-test.mjs`                           | 8914        | notes 插件协议 E2E：真清单解析（顶栏条目/5 个 AI 工具/3 个斜杠命令）、HTTP 通道（store/op/export）、**长轮询被改动唤醒**、重启后数据仍在（已进 run-smoke）                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `notes-ui-test.mjs`                        | 随机        | notes 浮窗 E2E（真 Chrome）：顶栏 📌 开浮窗 / 拖动 + 刷新后位置恢复（靠 `preload:true` 预加载）/ 快速捕获解析（明天 18:00、#标签、每天 9:00）/ 笔记输入即存落库 / **一次性提醒到点→长轮询→浏览器确认**（fireCount=1 且队列清空）/ 最小化小贴片 / 无独立视图（无 ⤢、无 .plugin-view）/ 日历在浮窗里 42 格 + 正文区裁剪不撑破面板 / 设置覆盖层（盖住正文、不压缩、语言标签不竖排、✕ 能关）/ 无 JS 报错（缺 Chrome 自动 SKIP，不入 run-smoke）                                                                                                                                                                              |
| `image-toolkit-core-test.mjs`              | —           | image-toolkit 纯 JS 图像内核：PNG（全 filter / 位深 / 调色板 / tRNS / 隔行报错）+ BMP 编解码往返、resize/crop/rotate/flip/adjust/水印/圆角/边框/直方图/主色、EXIF 解析                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `image-toolkit-test.mjs`                   | 8912        | image-toolkit 插件：假 host 直测 4 个 AI 工具与 6 条路由（含目标体积/批量逐项报错/越界拒绝/格式与缺依赖提示/内部配置存取）+ 真服务端接线 + 客户端纯逻辑（文案 key 对齐、尺寸与格式判定、ZIP 结构）                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `image-toolkit-view-test.mjs`              | 8913        | image-toolkit 视图 E2E（真 Chrome + 打桩工作区接口）：导入/队列/各 tab/裁剪拖拽与锁比例/精确体积/导出下载/批量 ZIP/存回工作区/切语言/无 JS 报错；另跑一遍手机端窄屏（390×780，`isMobile` + `hasTouch`）验证三栏堆叠为上下、队列转横向缩略图带、底部参数抽屉开合（点手柄收起、点 tab 自动展开）与触屏把手尺寸（缺 Chrome 自动 SKIP）                                                                                                                                                                                                                                                                                      |
| 单测 `page-picker-options.test.ts`         | —           | 设置页的 `?bind=` 面板（真 options.html + 假 chrome）：无参数不出现 / 预填地址与按钮文案随授权状态变 / 点击**真的写进存储**（归一后）/ 已是当前地址则不再提供绑定                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `page-picker-edge-ext-test.mjs`            | 8960+/9440+ | page-picker **装真扩展**的 E2E（真 `chrome.*`；实测 Edge 152 headless 仍接受 `--load-extension`，没 Edge 自动 SKIP）：裸 origin 会被真浏览器拒（`Invalid url pattern`，0.2.0 投递失败的真凶）+ 拾取→投递→Markdown 真落进 pi-web-ui 输入框 + 绑定浮条真弹出 / 非目标页真自退场                                                                                                                                                                                                                                                                                                                                            |
| `page-picker-test.mjs`                     | 8900+/9400+ | page-picker 扩展 E2E：注入真实 `dist/picker.js` + 真实 background 模块 + 真实 pi-web-ui 页面（Chromium 137 起 `--load-extension` 已被上游移除，自动化装不了真扩展，只能走等价路线）：选择器 / 命中的 CSS 行号（Vite `data-vite-dev-id`）/ React 源码位置与调用链 / 样式子集（只留与默认值不同的项）/ Markdown 落进真输入框 / 多选不串味 / 找不到页面时复制兜底 / 截图失败不影响投递 / 真 pi-web-ui 页与任意页各自认定 + 真实 `dist/bind.js` 浮条绑定后照常投递                                                                                                                                                           |
| `page-picker-ai-strip-test.mjs`            | 9600+       | 拾取浮层底部**常驻细条** E2E（真 Chrome + 真 `dist/picker.js`，无需服务端；断言前把闭合 shadow 临时改成 open —— 否则读不到细条）：拾取态就有「让 AI 操作本页…」/「与另一页配对…」/「退出」、点按钮真发 `grant-here`/`pair-here` 且有 toast、**细条不挡拾取**（点状态区穿透到背后元素）、进确认条细条让位、Esc 回拾取态、四种状态文案（未授权 / 已授权 / 总开关关着 / 查不到）                                                                                                                                                                                                                                            |
| 单测 `plugin-version-bump-guard.test.ts`   | —           | 插件版本号递增守卫：所有官方内置插件必须具备符合 SemVer 的版本声明；修改插件代码/功能（非纯文档）必须递增 `manifest.json` 版本号，确保随宿主自动热同步（`syncBuiltinPlugins`）正常触发                                                                                                                                                                                                                                                                                                                                                                                                                                   |
