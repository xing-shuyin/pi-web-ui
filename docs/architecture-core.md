# 核心架构

> 改代码前必读。本文档覆盖快照驱动、协议单源、安全边界、主题切换、多对话并发等全局架构决策。

## 快照驱动

- **服务端是唯一事实源**：每次 SDK 事件后节流 60ms 推快照（`UiState`），浏览器只按快照渲染。重连只需重发 `get_state`。
- **增量快照（协议 v2）**：持久化消息内容不可变 + 对象引用稳定，`emitSnapshotNow` 用 O(n) 指针等同性遍历检测追加式增长——能追加则发 `snapshot_delta`（轻字段 + `appended` 尾部，baseRev 链），中途变更/截断/切会话/强制 resync 回落全量 `snapshot`。前端 reducer 按 rev 链合并，缺口触发防抖 `get_state`；背压下 delta 与 snapshot 同样可丢弃，丢包靠 rev 链断裂自愈。`get_state` 恒返全量。回归：`snapshot-delta-test`。**测试适配**：等「动作后快照」的测试必须同时接受 snapshot_delta（参照 conv-cwd/vision-bridge 的 rev 链合并写法）；连接后的首个快照恒为全量。
- **WS permessage-deflate**：WebSocketServer 开启压缩（threshold 16KB），大会话多 MB snapshot 线上传输降数倍；小消息（notice/心跳）不压省 CPU。
- **多标签页序列化共享**：emit 把同一消息对象发给客户端的所有 socket，index.ts 用 WeakMap 按对象身份缓存 stringify 结果——N 个标签页共享一次序列化，新 snapshot 即新对象自动失效。
- 序列化时**对象引用稳定**：`uiMessageCache` + 消息数组签名比对，消息没变就不重建数组，前端 `React.memo` 因此能跳过整条消息——**不要**破坏这个缓存（stable id、引用复用）。
- `UiState` 携带 `thinkingLevel`（当前生效）和 `availableThinkingLevels`（当前模型实际支持的级别，SDK 会把集合外的请求静默就近钳制——UI 只能启用这些，否则用户点"低/中"看起来"改不了"）。

### `message_delta` 实时增量通道

`message_update` 事件 → 只对**活动对话**推 `message_delta`（`conversationId` + 每对话单调 `seq` + `messageId = stream-<ts>`（与 `serializeStreamingMessage` 的稳定 id 一致）+ 实时 usage + 剥离 `partial` 后的 thinking/text delta）。它**不经 snapshot 通道**——`send()` 背压只丢 snapshot，增量永远可达，大会话不再因背压停更。前端 `applyMessageDelta`（`web/src/message-delta.ts` 纯函数、不可变——StrictMode 双调 reducer 会把原地 mutation 加倍）patch `streamingMessage` + `stats.tokens`；seq 缺口触发防抖 `get_state` 重同步；snapshot 权威收敛。

同时：delta 活跃期（1.5s 内有增量）snapshot 降为**事件驱动检查点**——agent_end / tool_execution_end 立即 flush，其余事件走 2s 兜底定时器（增量负责流畅度、快照只做边界校准）。单测：`tests/unit/message-delta.test.ts`。

### `tool_delta` 同协议

也带 `conversationId` + `seq`，与 message_delta 共享同一每对话单调序列（`conv.deltaSeq`）；前端按对话 Map 追踪 seq，仅活动对话缺口触发重同步（后台对话切回时 snapshot 收敛）。

### 协议版本协商

`hello` 可带 `protocolVersion`，`ready` 回带服务端版本；前端比对不一致时显示持久刷新横幅（应用原地更新后「界面新的/WS 旧的」混跑防护）。常量在 server/ 与 web/ 各一份 protocol-version.ts，`check:protocol` 校验两份一致——改协议时必须同步 bump。

### 历史消息按需加载（服务端窗口化，`server/message-window.ts`）

前端「向上分页」只做到**不渲染**，数据仍是全量到手：实测一份 287 条 / 17MB 的转录序列化后快照 4MB，打开对话要等整份传完 + parse。所以再把窗口挪到服务端：

- **挂载点**：每连接唯一的发送漏斗（`server/index.ts` 的 `send` 外包一层 `MessageWindowTap`）。四个引擎（pi / DSH / claude / durable）都经这条漏斗，引擎侧**零改动**、口径统一；将来新引擎自动继承。
- **裁剪**：`snapshot` 的 `state.messages` 裁成尾部窗口并回填 `historyStart`（窗口首条在全量里的下标）/ `historyTotal`；条数上限 `PI_WEB_HISTORY_WINDOW`（默认 300）+ **字符预算** 150 万字符（截图/tool 输出会把窗口压更短，实测同一份会话 4.00MB → 1.28MB）。`snapshot_delta` 只把新追加的并入缓存并回填两个计数。
- **翻页**：`load_earlier_messages {count|all}` → 服务端回 `earlier_messages`（新增的更早一段，客户端**前插**）。窗口起点**单调不增**：客户端翻过的页不会被后续全量快照（重连 / `get_state`）推回去。
- **不碰 `rev`/`baseRev`**：各引擎增量语义不同，改写版本号会破坏它们的自愈链；翻页只是补齐更早内容，与 rev 无关。
- **前端配合**（`web/src/components/MessageList.tsx`）：`hasEarlier` = 本地未展示 + `historyStart`；滚轮接近顶部/点「加载更早」时本地够用就本地撑开，否则向服务端要一页；打开页内搜索或「全部展开」时 `all: true` 一次拉全，保证搜得到全文。
- **兼容**：两个字段都是可选的（缺省 = 全量）。旧前端连新服务端只是少了一段历史又无从翻页，故 `PROTOCOL_VERSION` bump 到 34 触发刷新横幅。
- **回归**：`tests/unit/message-window.test.ts`（窗口起点/预算/翻页纯逻辑）+ `tests/message-window-test.mjs`（WS 报文级：首帧窗口、无缝翻页、`get_state` 不回退、`all` 到底回空页）。

## 协议单源（types.ts 是 re-export shim，不再手工同步）

`server/protocol.ts` 是唯一事实源；`web/src/types.ts` 用 `export type * from "../../server/protocol"` 全量再导出（纯类型，构建时擦除），前端本地类型（FileContent/FileListing/ToolStatus）附在 shim 下方。

新增/修改任何消息：只改 `protocol.ts`，然后在 `server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch 各加一个分支。注意 protocol.ts 必须保持**纯类型导出**（不能加 const/function 等运行时代码，否则破坏 type-only 前提）；`npm run check:protocol` 守护这两个不变量。

## 全局运行态（app-globals.ts：不逐层传 props）

`web/src/app-globals.ts` 是模块级单例 store，放「**整棵树都要知道**」的少量运行态：服务端身份/能力（整个连接内只变一次）+ 连接态与当前工作目录（低频变化，靠单字段订阅隔离）：

| 字段                            | 来源                                              | 谁在用                                                                                                             |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `engine`（`"pi"` / `"dsh"`）    | `ready.engine`（老服务端不传 → 回落 `"pi"`）      | FooterBar 引擎图标、GoalBar/SettingsModal/ChatInput 的 DSH gating（无审查模型 / 无插件市场 / 无 mid-run steering） |
| `managed`（`PI_WEB_MANAGED=1`） | `ready.managed`                                   | TopBar 更新入口、PiSetupModal 安装引导、SettingsModal 插件市场                                                     |
| `tabs`（`PI_WEB_TABS`）         | `ready.tabs`                                      | 顶栏视图 tab 白名单（undefined = 全部）                                                                            |
| `service`（被哪个平台服务托管） | `ready.service`（`server/launch-origin.ts` 探测） | TopBar 更新面板的「重启服务」按钮（缺省 = 前台/dev/Docker → 不画按钮，服务端也拒绝 `restart_service`）             |
| `appVersion` / `serverVersion`  | `ready`                                           | TopBar 版本号                                                                                                      |
| `status` / `ready`              | useChat 的 reducer（`status` 动作 / hello+快照）  | 左栏（能不能拉清单）、ChatInput（输入框能不能用）、TopBar / FooterBar 的连接点                                     |
| `cwd`（当前对话的工作目录）     | `chat.state?.cwd`                                 | 左栏分组与「当前」标记、右栏路径拼接、全局搜索的当前项目标记、底栏目录选择器                                       |

写入点两处，都是单一来源、只镜像不复制：`use-chat.ts` 收到 `ready` 时写身份/能力（**在 dispatch 之前**同步落地，不闪一帧 `pi`）；另一个 effect 把 `ready` / `status` / `cwd` 镜像过来（值就是 reducer 里的真值，最多晚一帧 —— 对应默认值只会是「未就绪 / 未连接 / 空目录」，看不出来）。非 React 代码用 `getAppGlobals()` / `subscribeAppGlobals()`。

**读取规矩**：窄 props 的组件（`LeftPanel` / `RightPanel` / `ChatInput` / `GlobalSearchModal`）一律从全局读，不再要 prop；本来就吃整个 `ChatState` 的组件（`App` / `TopBar` / `FooterBar`）直接读 `chat.*`（自己就持有数据，没必要绕一圈）。两边的值来自同一个 reducer，不会不一致。

**订阅粒度**：只用一个字段时用 `useAppField("cwd")`（getSnapshot 只取一个字段，比较走 `Object.is`）—— `useAppGlobals()` 在任何字段变化时都会重渲染订阅者，只有确实要整对象时才用它。`cwd` 就是靠这条隔离的：切项目的通知只到真正读 cwd 的组件，不会把只读 `engine` 的组件也带上。

### 全局动作：`appSend`

发送器也放这里（下半部分）：`use-chat` 装配 `setAppSend(send)`，其他任何地方 `import { appSend }` 直接用 —— 它引用稳定、不进 state、不触发重渲染，所以不需要 hook。`web/src/App.tsx` 里因此不再有 `send={send}` 的逐层传参：对话框、弹窗、面板、插件视图、终端、SCM 全部自己取。

两点例外（故意的）：

- `LeftPanel` / `RightPanel` 的 prop 叫 **`panelSend`** —— 它们拿的是 App 的包装函数（顺手关手机抽屉的副作用），语义不同，不能换成全局发送器。
- **装配必须在 render 期间**（`setAppSend(send)` 直接写在 `useCallback` 后面，不是 `useEffect`）：子组件的 effect 先于父组件跑，放 effect 里装配会让「挂载即发请求」的弹窗（PiSetupModal / ModelConfigModal / TerminalPanel）在 `appSend` 还是空的时候调用而静默丢包。`send` 是 `useCallback([])` 的稳定引用，重复赋值无副作用。未装配/未连接时 `appSend` 返回 `false`（与 `send` 的既有语义一致）。

**两条纪律（否则会引入难查的渲染 bug）**：

1. **只放极少变化的字段**。`messages` / `state` / `settings` / `streaming` 这类快照流里的数据**绝不**放进来：`ChatInput` / `GoalBar` 等 `memo()` 组件靠「窄 props + 引用稳定」躲开流式重渲染，而 store 通知**绕过 `memo()`** 直接重渲染订阅者 —— 放错一个字段就是每个 token 重渲染一次输入框。
2. **快照引用必须稳定**：`getSnapshot()` 返回模块级 `cached`，只有 `setAppGlobals` 真正改了字段才替换对象并通知（数组按元素比、字段值相等则静默 return）—— 否则 `useSyncExternalStore` 会判定「快照每次都变」而无限重渲染。重连重放 `ready` 时靠这条不白刷一遍。

回归：`tests/unit/app-globals.test.ts`（合并语义/同值不通知/退订/回落）与 `tests/unit/dsh-question-dialog.test.ts`（组件测试改用 `setAppSend` 注入 + 记录发出的消息）。

## 安全边界

- **默认只绑 loopback**（`PI_WEB_HOST`，默认 `127.0.0.1`）：本地个人工具不暴露到网络；局域网/容器需显式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已内置，Docker 端口映射才能工作）。
- **WS 升级做 Origin/Host 同权威校验**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手动 `handleUpgrade`）：Origin 存在时其 hostname+**有效端口**必须与请求 Host 一致（浏览器里 `example-host:8445` 与 `example-host:9443` 是不同源）；非浏览器客户端（无 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名单绕过（dev:server 已内置 `http://localhost:5173,http://127.0.0.1:5173`，反代场景自配）；`PI_WEB_ALLOW_HOSTS` 可选严格 hostname 白名单。**不要**加回「本地任意端口放行」——那正是提案要修的洞。
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：进入排空后**拒绝一切新工作**——新 prompt（native slash 命令例外，纯配置无 token）、new_chat、edit_message fork、switch_session、goal wizard；存量运行继续跑完。已知 clientId 仍可 attach 看存量（发 notice 提示），**全新客户端 attach 抛 `QuiesceRejectedError` → index.ts 以 4403 关 WS**，浏览器重连循环在 unquiesce 后自动恢复。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 经本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-web-ui-<port>`）与运行中进程通信，`status` 报告真实 socket 数（`noteSocketOpen/Close`，index.ts 维护）、active/pending 计数、quiesce 状态；无鉴权 HTTP 端点。
- **provider headers 不下发浏览器**（`models_config` 不再携带 `headers` 字段，可能含 Authorization/API key）：`saveModelConfig` 保存时若 config 无 headers 则保留旧值（`prevHeaders`）。`UiProviderConfig.headers` 已从 protocol.ts / types.ts 删除，前端没有任何地方编辑 headers（仅 apiKey 经独立消息 `set_provider_api_key` 走浏览器）。
- **内置服务商多密钥（不复制模型列表 + 纯名字通信）**：一个内置服务商（如 opencode/openai）可同时持有**多把 API key**，存于 `<agentDir>/provider-keys.json`（`{ <providerId>: { activeKeyName, keys:[{name,apiKey}] } }`），**模型目录始终复用该服务商的默认系统目录**，绝不复制进 models.json（`clone_provider` 只保留给程序化/测试路径，UI 已改为多密钥管理）。**安全**：前端**永远只拿到钥匙的**名字**（`ProviderKeyInfo={name,active}`），**原始 key 值 / 掩码片段（masked）一律不出服务端**——key 值只在添加时经 WS 上传一次落盘（同 auth.json）；`activate_provider_key`/`remove_provider_key` 都**按名字**寻址，服务端解析存储值。协议：`list_provider_keys` / `add_provider_key`（`{provider, apiKey, name?}`，名字自动去重）/ `activate_provider_key` / `remove_provider_key`，服务端回 `provider_keys`。**activeKey 与 auth.json + 运行时 override 同步**（`applyActiveKey`），切 key 后 `pushModels` 重推该服务商模型。前端模型下拉对多 key 服务商在左侧「供应商」栏**按 key 拆成多个条目**（供应商名在上、key 名在下，如 opencode 下 key1/key2 各一条，不拼接 `opencode-key2name`），**选中某 key 条目即只显示该服务商模型一次，点模型即切换激活 key** 再选模型——无需静态副本、始终最新；单 key 服务商仍显示普通单一条目。
- **内置服务商 OAuth（开放授权）登录**：`ProviderStatus` 同时下发 `supportsApiKey`、`supportsOAuth`、`oauthName` 与 `usingOAuth`，模型管理页和首次设置页据此只展示服务商真正支持的认证入口及对应账号名称。登录由服务端 `ProviderOAuthFlowManager` 驱动 SDK（软件开发工具包）的 `ModelRuntime.login`，浏览器只接收选择题、验证地址、设备验证码和进度；SDK 返回的访问令牌与刷新令牌不进入 wire 协议。每个流程使用 `flowId + promptId` 关联回复，可取消；活动流程留在 `ClientSession`，浏览器重连后通过 `provider_oauth_flows` 恢复当前公开状态。登录成功后 OAuth 凭据成为该服务商的活动认证，并清除各项目保存的 API key 选择，防止切换项目时覆盖；登出统一调用 SDK 的 `logout`。
- **token 反射防护**（issue #45）：`PI_WEB_TOKEN` 鉴权中间件里，`/api/health` 保持开放供探针，但 `Set-Cookie` 只在请求确实携带有效 token（`tokenOk(req)`）时才下发——匿名命中 `/api/health` 绝不反射真实 token cookie。回归：`tests/token-auth-test.mjs` 的「health does NOT leak pi_web_token」检查。
- **dev 兼容**：vite :5173 代理 /ws 到 :8788 时 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 内置）放行，勿删。

## 主题切换

- **机制**：`web/src/styles.css` 是**共享基线**（默认深色主题 + 全局布局，抽离出来只为方便复用，不是对主题的限制）；主题文件是**完整样式表**，可覆盖任何东西（`:root` 变量、任意选择器、布局改动、自带新 token 皆可——主题 link 后加载，在层叠中胜出）。选主题时前端注入 `<link id="theme-stylesheet" href="/themes/<id>.css">`（`web/src/theme.ts` 的 `applyTheme`，localStorage 键 `pi-web-ui:theme`，`main.tsx` 首帧前应用防闪烁）。唯一硬性要求：`var()` 引用的 token 必须在某处有定义（主题自带定义也算，见下“变量必须先有定义”）。
- **服务端**：`GET /api/themes` 列主题（`server/themes.ts` 的 `listThemes`），`GET /themes/:id.css` 发文件（`resolveThemeFile`，用户目录优先）。id 必须匹配 `ID_RE`（`^[A-Za-z0-9_-]+$`）防路径穿越。两个路由在 `server/index.ts` 注册于 SPA catch-all 之前（否则被吞返回 index.html）。dev 模式 Vite 需在 `web/vite.config.ts` 代理 `/themes`（已加）。
- **主题来源**：内置 `<pkgRoot>/themes/*.css`（随 npm 包分发，`package.json` files 白名单含 `themes/`）；用户自定义直接往 `<dataDir>/themes/` 丢 CSS 文件即可（id 冲突时用户覆盖内置）。`pkgRoot` 经 `resolvePkgRoot()` 向上找含 package.json 的祖先解析，dev(server/) 与 prod(dist/server/) 均正确。
- **浅色主题**：`themes/white.css`（显示名「白色」：纯白底 + GitHub 蓝强调）与 `themes/paper.css`（显示名「暖纸」：暖纸米黄底 + 赭石强调，护眼）与 `themes/mist.css`（显示名「雾蓝灰」：雾蓝灰底 + 天青蓝强调，冷淡风）与 `themes/sakura.css`（显示名「樱粉」：粉白底 + 樱粉强调，柔和风）与 `themes/md-preview.css`（显示名「紫晕」）+ `themes/cyberpunk.css`（赛博朋克）+ `themes/dazzle.css`（炫彩）均由根目录脚本 `make-light-theme.mjs` 从 `styles.css` 的 `:root` 变量清单生成**纯调色板文件**（生成器读 styles.css 解析全部变量名，主题只覆盖差异值，输出完整 `:root` + 可选非布局 tail：white/paper/mist/sakura 带 `.hljs` 浅色高亮覆盖、md-preview 带 body 渐变 + chrome 透明）。styles.css 新增变量后重跑 `node make-light-theme.mjs` 即自动同步进所有内置主题（新变量默认用深色值）。
- **主题显示名**：css 首行 `/* theme-name: 中文名 */` 即为下拉里的显示名（`listThemes` 读文件头 300 字节解析），缺省回退文件 id——文件名必须是 ASCII（id 校验 `ID_RE`），中文靠这个标记。第二行可选 `/* theme-name-en: English Name */`（英文 UI 用，无则回退中文名）；两行都由 `make-light-theme.mjs` 生成，手改主题文件头会被下次重跑覆盖——改英文名要改生成器。
- **面板收起/展开按钮对照色（issue #100）**：`.panel-collapse-btn` resting 态即带底色 + 边框（与窄屏顶栏 `.panel-toggle` 同级），前景/底/边框走专用 `--control-fg/--control-bg/--control-border`（默认取正文次级色而非 `--text-faint`），展开条 `.panel-rail` 加宽到 26px、图标套「药丸」底——在浅色/自定义主题下也不再隐形。主题可独立覆盖这三个变量；浅色默认值在生成器的 `LIGHT_DERIVED` 里。
- **聊天背景图/壁纸（issue #100）**：`--bg-image: none`（主题可写成 `url(...)` 自带一张）+ `--bg-image-dim`（`--bg` 压暗不透明度，默认 0.78）+ `--bg-image-blur`。`body.has-wallpaper` 时 body 全屏铺两层 fixed 壁纸：`body::before` 放图（cover 居中 + 模糊）/`body::after` 压暗；`.app` 抬 z-index 1 到壁纸之上，消息区/输入区透明直接见壁纸。**容器背景优先**：顶栏/底栏/左右面板背景是独立变量 `--topbar-bg`/`--statusbar-bg`/`--panel-bg`（默认 `color-mix` 半透明 → 壁纸从两侧与顶/底栏下透出），主题把某变量覆盖回实色（如 `var(--bg-elev)`）即关闭该区壁纸、设 `transparent` 即完全透图；统一透图率调 `--wallpaper-panel-alpha`（默认 62%，越小透图越多）。同层还有两类组件底板：卡片级 `--card-bg`（工具调用卡 `.toolcall`、快捷短语 `.quick-chip`、新对话提示词模板卡 `.empty-template`、展开条 `.panel-rail`、全部消息气泡 `.thinking`/`.bashblock`/`.skillcard`/`.attachcard`/`.queued-bubble`/`.retry-notice`）与控件级 `--chip-bg`（顶栏 `.chip`/`.tb-tab`/下拉菜单 `.dd-menu`、goalbar 收起态提示 `.goalbar-hint`、折叠钮 `.panel-collapse-btn`、代码面 `.codeblock pre`/`.termline`/`.toolcall-output pre`、工具参数块 `.toolcall-args pre`），默认同样半透明、共用 `--wallpaper-panel-alpha`，主题可单独覆盖回实色；整块聊天面板（`.main`：消息区 + goalbar / 问卷面板占的那一段 + 输入区）共用 `--msgs-bg`（同式半透明，气泡立在统一玻璃面上略实一层形成层次，覆盖回 `transparent` 恢复全透）。**只涂在容器上**：消息区 / 输入区 / goalbar / 问卷面板再各自上色的话，元素之间的间隙与列外区域会露裸背景 —— 浅色与壁纸主题下就是一条横跨整个面板、比聊天区差一档的带子（goalbar 一出现特别明显），所以 goalbar 与问卷面板不带自己的底色（只留边框与投影）；无壁纸时两层 `display:none`，且背景变量默认半透明叠在纯色上色差极小。输入框盒子 `--inputbox-bg` 默认与 `--chip-bg` 同式跟随 `--wallpaper-panel-alpha`。下拉弹窗（声音/语言/主题/模型/思考强度等 `.dd-menu`）背景走 `--menu-bg`：默认跟随 `--chip-bg` 半透，两个透明主题覆盖回 `var(--bg-elev2)` 实色保密集列表可读。终端视图读 `--term-bg`（xterm canvas + 容器）：默认实色不参与（终端可读性优先），半透明主题可覆盖成 `color-mix` 半透明随整体透图。内置「半透明」主题（`themes/translucent.css`）专配壁纸：`--wallpaper-panel-alpha: 45%` 整体统一容器色（顶栏/底栏/面板/卡片/控件/输入框全部联动）+ `--term-bg: color-mix(#0b0d12 45%, transparent)` 终端也透 + `--bg-image-dim: 0.72`，不配壁纸时观感偏暗属预期。「全透明」主题（`themes/transparent.css`）是极致版：`--wallpaper-panel-alpha: 0%`（全部 color-mix 表面 = transparent，含 `--term-bg`），只留边框与文字；文字靠压暗加重（`--bg-image-dim: 0.85`），尾段把实色 hover/浮动反馈（菜单项、折叠摘要、展开条、折叠键、复制键、滚到底按钮）统一改 25% 半透底保可用性，并再减一层代码面噪音：`--code-border: transparent` / `--code-pad: 0`（工具参数块 `.toolcall-args pre`、工具输出块 `.toolcall-output pre`、终端行 `.termline` 的边框与内边距）＋隐藏与卡头重复的终端图标 `.termline-icon`。代码面边框/内边距走 `--code-border`/`--code-pad`（默认 `var(--border-soft)`/`8px 10px`），卡片正文内边距 `--card-body-pad`（思考块 `.thinking-body` 与工具卡 `.toolcall-body` 共用 `4px 14px 12px`，保证同一条消息里两种卡片文字左缘对齐）。用户自定义地址存浏览器 localStorage（`pi-web-ui:wallpaper`，`web/src/wallpaper.ts`：URL 白名单 http(s)/blob/data:image/站内相对路径，内联变量覆盖主题，`useWallpaperEffect` 在 App 顶层应用并监听主题切换重算）， UI 在设置 → 消息显示（地址框失焦/回车提交，压暗/模糊滑杆即时预览；也可点「上传图片」选本地文件——复用粘贴图片管线等比缩 ≤1568px + 重编码为 data: URL 存 localStorage，上传失败/过大时行内提示；data: 图不回填输入框，下方缩略图即表示生效中，清除按钮同时清掉地址与预览）。
- **变量必须先有定义（幽灵 token 陷阱）**：`var(--x)` 引用一个全仓没有任何 `--x:` 声明的自定义属性，按规范是 guaranteed-invalid —— 整条声明在计算值阶段失效（不带 fallback 的 `background` 直接**没有背景**；`box-shadow` 连投影与聚焦光环一起丢；带 fallback 的静默用硬编码值，浅色主题下必是深色块）。`--bg-elev1`（正确名是 `--bg-elev`）全史未定义却被 10 处引用，goalbar 因此一直没有填充。新增/改名变量后跑 `tests/unit/css-tokens.test.ts`（静态体检：扫 `web/src` + `plugins` + `themes` + `web/index.html` 的每个 `var()` 引用，带 fallback 的也查；运行时注入的变量与刻意写的中性兜底在该测试的豁免表里登记并写明理由——新增豁免要一并写理由）。
- **终端跟随主题**：xterm 画布经 `web/src/theme.ts` 的 `buildTermTheme()` 读 `--term-*` 变量，主题切换时 `TermXterm.tsx` 监听 `pi-web-ui:theme-change` 事件用 `term.options.theme` 热更新画布；CSS 容器 `.term-main` / `.term-xterm .xterm-viewport` 用 `var(--term-bg)`，与画布自动融合。styles.css 改动后重跑 `node make-light-theme.mjs` 重新生成。
- **回归**：`theme-test.mjs`（端口 8937，隔离 data-dir）：列表/内置/用户主题、注入 link、浅色生效、刷新持久、用户主题可应用、回默认移除 link。

## CSS 分层（`@layer guard, base, theme;`）

- **为什么分层**：`web/src/styles.css` 是共享基线、主题是后加载的完整样式表，两者在同一份文档里争权重。分层重构前，能跨文件夺权的唯一手段就是 `!important`（叹号 important）：基线 218 处、主题侧 613 处（`bases/obsidian-base.css` 220、`bases/zhujian-base.css` 143、`bases/zhupi-base.css` 132、`aetheris.css` 118），主题要压住基线只能继续加码，越改越沉——典型的军备竞赛。改成显式分层 + 无层覆盖区后基线只剩 1 处（mermaid 运行时内联 style，见下），胜负由**层序**决定，叹号 important 不再是夺权工具。
- **三层职责**（顺序声明只有一处：`web/src/styles.css` 顶部的 `@layer guard, base, theme;`，早于所有层块，层序按此固定）：
  - `@layer base`：整份基线样式（`web/src/styles.css` 内容）。默认层，正常写选择器，不加 `!important`。
  - `@layer theme`：主题样式。**服务端统一下发**——`server/themes.ts` 的 `readThemeCss()` 内联展开 `@import` 后把整份文本包进 `@layer theme { … }`（只包最外层一次；递归内联的子文件原样返回，否则会变成嵌套层）。`themes/**/*.css` 源文件因此**不需要**自己写 `@layer`，也不需要 `!important`：只要写在主题里就天然压过 base。
  - `@layer guard`：唯一活口是 mermaid——它用 d3 `.style()` 把字号写成 SVG 内联 `style`，任何普通声明都压不住，只能留这一处叹号 important（`styles.css` 末尾，写明原因）。guard 先声明，层序反转后它的 important 恒胜。别把普通样式挪进来偷懒。
- **无层覆盖区**（`styles.css` 末尾、所有层块之后）：需要盖过主题或未分层三方库（highlight.js `github-dark.css`，bundle 里后加载）的结构性复位放这里——代码行清零（同为无层后靠更高权重盖过 `pre code.hljs`）、折叠态 `.goalbar.goalbar-collapsed` 抹皮（无层一句盖住 theme 层面板皮）。**未分层的普通声明永远胜过任何层内的普通声明**，所以这里不需要叹号 important。分包引入的 CSS（如 `web/src/model-management.css` 经 `@import … layer(base)`）与插件样式同样必须进层，不能裸奔成无层。
- **层序规则（两个方向相反，最容易踩）**：普通声明按**层声明顺序**后者胜（`theme` > `base` > `guard`）；带叹号 important 的声明**反向**——先声明的层胜（`guard` > `base` > `theme`）。所以 guard 层的价值恰在于它**先**声明：mermaid 那一处例外放进去就能盖住运行时内联；而 base/theme 里写叹号 important 只会把自己钉死，越写越糟。另注：**未分层的样式永远胜过任何层内的普通声明**——这正是「无层覆盖区」能零提权盖住主题与 highlight.js 的原因。
- **新增样式时的规矩**：① 主题里**禁止**叹号 important，一律靠 theme 层胜出；② 基线里同层权重不够时用**复合类提权**（如 `.canvas-dropdown-item.canvas-inline-create`），不准加叹号 important；③ 要盖主题/三方库普通声明时用文件末尾**无层覆盖区**，不准加叹号 important；④ 只有运行时内联 `style`（如 mermaid）才配写，必须写明原因并收进 `@layer guard`；⑤ 主题不要再写 `#root .foo` 这类 ID 加权选择器和基线抢权重（层序已解决，残余的 ID 加权属于历史包袱，改到即删）。守卫：`tests/unit/css-layers.test.ts`（基线叹号 important ≤ 1、`themes/**/*.css` 必须为 0、层声明与 guard 位置、文档契约）。
- **视觉回归闸门**（改了任何样式都必须过）：`npm run audit:themes`（当前树截图 → `.theme-audit/current`）→ `npm run audit:diff`（与 `.theme-audit/baseline` 逐像素比对）。固定 fixture DOM（含气泡/Markdown/表格/代码/思考卡/工具卡/胶囊流/输入岛/顶栏/侧边停靠栏/快捷短语/插件图标/`hide-model-row` 紧凑模式）+ 每个主题一张图（35 个主题），单主题差异 > **0.05%** 即退出码 1。
  - 基线快照 `.theme-audit/baseline` 是「分层重构完成时」的状态（已 gitignore）。要拿**重构前**的基线只能开一个 `HEAD` 的 git worktree 再拍：`git worktree add ../baseline HEAD` → `node scripts/theme-audit.mjs --root ../baseline --out .theme-audit/pristine`。
  - 只有当差异确属「有意改进」时才允许重建基线；否则先查层序（`theme` 被 `base` 压住是最常见的错）。
- **已接受的有意差异（主题为准）**：分层后 `theme` 层恒胜 `base`，以下 4 处历史上是基线的 `!important` 赢、现在按主题样式渲染 —— 这是**定案，不是缺陷**，不要再用对齐块把它们打回旧值（zhujian/zhupi/aetheris 顶栏那组对齐块是历史特例，后续新主题姿态请以主题直出为准）：
  1. `flow` / `flow-light` / `wallpaper-flow`：`.msg-assistant` 上下 padding 取主题的 `0`（原被基线紧凑模式的 2px/4px 盖）——夹具差异 ~2.0%；
  2. `flow` / `translucent` / `transparent`：`.quick-chip.active` 取主题底色（原被基线强调底盖）——差异 ~0.5%；
  3. `aetheris`：`.chip` 圆角与 `.bar-item` 内边距取主题值；
  4. `wallpaper-obsidian`：插件图标 `.plugin-icon-svg` 颜色取主题值。

## 中央列几何（消息列与输入框永远等宽对齐）

- **唯一事实源**：`.main` 上的四个 token —— `--chat-pad`（列最小左右留白：桌面 20px / 手机 14px / 宽屏聊天列 260px）、`--chat-max`（列宽上限 860px；宽屏聊天列设成 `100%` 取消上限）、`--chat-rail`（提问导航条让位，桌面 48px）、`--chat-inset = max(--chat-pad, (100% - --chat-max) / 2, --chat-rail)`。消息列、输入框、goalbar、`/` 命令菜单、扩展问卷面板一律只用 `--chat-inset`（`.inputbar` 用它做左右 padding，子元素全是自适应宽度），**不允许**再出现 `max-width: 860px; margin: 0 auto` / `calc(100% - Npx)` 这类逐元素校正——两列等宽只是同一个值的两个使用点。
- **百分比基准**：`--chat-inset` 内含百分比，只在「包含块宽度 == `.main` 内容宽」的元素上使用（`.messages` / `.inputbar` / `.goalbar` / `.dialog-inline`）；fixed 浮层（文件预览的 markdown 缩放列、`/help` 面板）自成包含块，仍走定距写法。
- **滚动容器补偿**：`.messages` 带 `scrollbar-gutter: stable both-edges`，内容盒左右各被扣掉一条 gutter，所以它用 `padding-inline: max(0px, calc(var(--chat-inset) - var(--msgs-gutter)))`（外面那层 `max(0px, …)` 是防御：负 padding 会让整条声明失效、内容直接贴边）；`--msgs-gutter` 由 `web/src/scrollbar-gutter.ts` 维护——首帧前用与 `.messages` 同设置的探针给初值（必须 `overflow-y: auto` + `stable both-edges`，用 `overflow-y: scroll` 量到的是叠加层滚动条 0px，与实际占位宽度不符，这正是历史上「消息列比输入框窄 20px」的根因），`.messages` 挂载后改用真实元素实测并覆盖，窗口尺寸变化时再校一次。
- **提问导航条让位**：`qn-rail` 钉在消息区右侧 14~38px，桌面（≥641px，rail 仅此时存在）恒定预留 `--chat-rail: 48px`，左右同时加 → 两列依旧等宽、左右边缘依旧对齐；主列够宽时（居中留白 > 48px）`max()` 取原值，宽屏观感不变。恒定预留而非「有 rail 才预留」是为了避免第一条消息发出、rail 出现时整列突然缩 28px。
- **回归**：`tests/chat-column-align-test.mjs`（多视口 × 宽屏聊天列开关 × 手机，逐一比对 `.msg` / `.msg-text` / `.msg-collapsed` / `.retry-notice` / `.inputbox` / `.goalbar` / `.slash-menu` / `.dialog-inline` 的左右边缘与宽度，并断言 rail 不压消息列）。

## 多对话并发

- 每客户端 `convs: Map<convId, Conversation>`，**每个对话一个独立 `AgentSessionRuntime`**：`new_chat` 新建 runtime + 新 session 文件（旧对话继续在后台跑，不中断）；`switch_conversation` 只换 `activeId`（不碰其他 runtime）；`runtime`/`session` 访问器指向当前活动对话。**对话按项目归属**：`conv.cwd` 即所属项目，每个项目各自的活动对话互不干扰。
- **`set_cwd` 不再重建当前对话**——改为切到目标项目自己的对话（该项目最近活动的那个；没有则新建一个并恢复该项目最近的持久会话）。
- **「运行的对话」列表生命周期**（每个对话 `listed` / `promptedSinceActive` / `lastActiveAt` 三字段）：
  - 入列：活动对话**正在流式输出时**被挤到后台（new_chat / switch_conversation / set_cwd，**跨项目切换同样入列**）→ `listed=true`；
  - 留在列表：后台跑完不移出（用户可能还没看结果）；**还有“用过”的存活 PTY 的对话也留在列表**（终端里可能有仍在跑的任务），但**已退出、仅保留输出的终端不阻止移出**——AI 结束且终端全部跑完后切走，`removeConversation` 顺带 `killAll()` 关闭残留终端并从列表消失（`openTerminals` 传 `terminals.countBlockingLive()`，只统计存活且用过的 PTY——**没动过的空 shell（点开终端 tab 自动建的那个）不算**，切走/✕ 移出时随对话一起释放，不拦截）；
  - 移出：打开它（切为活动）→ 没有继续对话（期间没发过 prompt）→ 切走时 `displaceActive()` 返回它，`removeConversation` 释放 runtime（会话已持久化，历史列表仍可恢复）。**子代理豁免切换关闭**：活动的是子代理时切走永远保留（`listed=true`，`displaceActive()` 返回 null）——点开看过就切走也不释放，后台任务继续跑；清理走显式动作（单条 `dismiss_conversation` / 右键批量 `dismiss_finished_subagents`）。
  - **展示口径 vs `listed`**（issue #140）：左栏推什么由 `shownInRunningList()` 决定 = `listed` **或** 「当前对话 + 已经有内容」（有消息，或已被首条提示词命名——命名与首条消息同一时刻，`prompt()` 里那个 rename 块顺手 `emitConversations()`；`agent_start` 再补一次让「流式中」绿点立刻亮起来）。空白新对话仍不入列（防连点「新建对话」堆出一排空条目）。这是**纯展示口径**：`listed` 的语义、以及 `displaceActive` / `shouldRetainActive` / `MAX_OPEN_CONVERSATIONS` 那套「什么算运行中」的规则完全不变（换走时该释放的仍然释放）——所以当前对话那一行的 ✕ 必须按同一口径判定（`dismissConversation` 的「不在列表里就 no-op」用的是同一个函数），否则会出现「行在、点 ✕ 没反应」。回归测试：`tests/running-list-test.mjs`（零 token mock 模型）+ `tests/panel-layout-test.mjs`（真浏览器：区标题/「当前」样式/流式绿点）。
  - 关闭父对话连带提示：`dismiss_conversation` 带 `withFinishedSubagents=true` 时连带关闭该对话下已结束的子代理（传递后代，与批量口径一致；active 的跳过）——只关不运行的：运行中的后代不受影响，关完后若还有后代剩下父级暂留并提示；只有运行中的后代时拒绝。不传 flag + 存在已结束子代理后代时拒绝并提示。前端：父行有子代理后代时 ✕ 点一次展开两个选项——「仅关已结束（{n}）」（= 按行批量 `dismiss_finished_subagents`，父级保留）/「强行全关」（`force=true`，见下）。
  - 强行关闭 `force=true`：中止自身运行（如在跑，`interruptRun`）+ 中止全部子代理后代（运行中的也停，`stopSubagent`）再整体移出；终端/审查/后台唤醒等保留态一并放行。active 对话也可关闭（`vacateActive`：优先切到其他已列出对话，否则新建一个再移）。DSH 引擎无子代理：force 只放行 active/终端限制，运行中仍拒绝（单 runtime 无法单独 abort，请先点停止）。前端：所有行（含选中/运行中）都显示 ✕；无子代理的运行中行两段确认强行关闭（`dismissStreamingConfirm`）；行右键菜单同样有两个选项（`forceDismissConversation` 两段确认）。
- **跨客户端「另一处」行（issue #145 / #291）**：`listExternalRunning(excludeClientId)` 把别的 `ClientSession` 里仍持有的对话下发给左栏（只读感知 + 手动过户入口，`owner`/`convId` 定位目标）。**断连残骸**（最后一个浏览器断开、`sinkCount()===0`）的行在宽限期内仍下发并标 `ownerOffline`（前端「离线」徽标），过期后消失 —— 宽限期 `PI_WEB_OFFLINE_ROWS_TTL_MS`（默认 30 分钟；`0`/`off` = 不下发 = 旧口径）。为什么需要它：手机端「run 途中关页面 → run 在服务端继续跑完」之后，换设备打开网页既看不到行也没法过户（#291 跳过了 sinkCount=0 的残骸），只能去历史对话里开 —— 而残留 runtime 仍持有那份转录，历史里开等于给同一份 JSONL 造第二个 writer。宽限期的到期时刻取「断开时刻」与「最后一次活动」的较晚者（断开后还在跑的后台任务不吃 TTL，每有流式变化就重排），到期由 `armOfflineRowExpiry` 定时器推一次让行消失（回调只推不重排，避免 1s 轮询）。回归：`tests/offline-takeover-test.mjs`、`tests/elsewhere-lifecycle-test.mjs`、`tests/unit/elsewhere-dedup.test.ts`。
- **过户是事务性的（#556）**：`take_over_conversation` 分两步（源会话 `detachTakeoverConversations` 摘除 → 目标会话 `insertTakeoverConvs` 接入），中间那一瞬间对话两头都不挂 —— 只要第二步报错，runtime 还在跑但任何列表都不包含它（「幽灵会话」，刷新页面无敕，只有重启服务才能靠落盘会话恢复）。现在接入失败就把整包原样搬回源会话（`returnTakeoverPayload`：先 `reclaimTakeoverConvs` 摘掉已部分插入的残留，再用同一套 insert 接线接回源页面并切回 active），两边都收到诚实的回执；二次失败时宁可留在目标页面（接入方已给主对话置 `listed`）也不落到无人持有的空档。回归：`tests/takeover-rollback-test.mjs`（测试专用故障注入 `PI_WEB_TEST_TAKEOVER_FAIL_INSERT`）。
- 上限 `MAX_OPEN_CONVERSATIONS = 8` **按项目计，且只计普通对话——子代理（`isSubagent`，inMemory 后台任务）不占位、不被拦截**，超出时 new_chat / switch_session 发 warning notice。
- 所有对话共享**一个 ModelRuntime**（首个对话创建时播种，`makeRuntimeFactory` 传入复用）——顶栏换模型对全部对话生效。**消息序列化缓存（msgIds/uiMessageCache/签名）按对话隔离**：两个对话可能产生相同的 (role, timestamp) 键，共享会串号。
- **项目切换记住 {模型, key} + 全局默认模型**：`client-state` 持久化 `projectModels`（cwd→"provider/id"）与 `projectProviderKeys`（cwd→provider→keyName）。**选模型即刻保存**（`setModel` → `rememberProjectModel`，不等一次问答——SDK 只有存在 assistant 消息后才把 `model_change` 落盘，否则新对话选完模型就切走会丢）；**切换项目/会话时恢复**（`restoreProjectModelForCwd` + `restoreProjectProviderKeysForCwd` 于 set_cwd / switch_conversation / switch_session / ClientSession.create），新对话也会套上该项目上次的 {模型, key}。模型/密钥被删时恢复静默跳过。**全局默认**（`defaultModel` + `defaultProviderKeys`，存 `__settings__` 全局键、全客户端共享）：模型下拉底部「☆ 设为全局默认」把当前模型（含当时 key）记成全局默认，行上 ★ 标记；无项目记忆的新项目回落到它（`set_default_model` / `clear_default_model` / `default_model` 推送，attach 即推；pi 引擎专有，DSH 下按钮隐藏）。回落链：项目记忆 > 全局默认 > SDK 默认；key 同理（`restoreKeyForModel` 先项目 pin 再全局 pin）。删 key 时全局引用同步改指（`repointDeletedKeyInDefault`）。回归：`tests/unit/default-model.test.ts`。
- `snapshot` 带 `conversationId`；`conversations`（ServerMessage）推**全部项目已入列的对话 + 当前对话（有内容后，见 `shownInRunningList`）**（前端按 `cwd` 分组显示，当前项目不显示组标题）+ `activeId`（activeId 只在还是个空白对话时才不出现在列表里）；`switch_conversation`（ClientMessage）**可跨项目切换**——切到其他项目的对话时同步切换工作区，补齐 `set_cwd` 的副作用（文件树/会话历史/项目顺序/命令目录/onCwdChanged 钩子）。
- `switch_session`（恢复持久会话）会为目标会话创建独立 runtime，再按上述生命周期把当前对话移到后台；若目标会话已在运行列表中则直接复用其 conversation，绝不因打开历史记录中断当前生成。回归测试：`tests/switch-session-background-test.mjs`。`edit_message` 在**当前**对话内 fork；`dispose` 遍历销毁全部对话；attachSink 重连时补推 conversations。
- 前端：左栏「运行的对话」区（≥1 个时显示，活跃高亮 + `当前` 副标签、流式绿点；空白新对话不显示该区），MessageList 以 conversationId 为 key 强制切换重挂载。跨项目分组见 `web/src/conv-groups.ts`（纯函数 + 单测）：**当前项目那组不显示组标题**，判定以「当前对话在哪个组」为准（`currentCwd` 只当回落）——`conversations` 推送先到、带新 cwd 的快照后到，只按 `cwd` 判定会让当前项目在切换那一帧被当成「别的项目」而闪一下项目名（bin 浏览器逐帧回归 `tests/conv-group-flash-test.mjs`）。

## 其他桥接

### 工具结束实时状态（`tool_status`）

服务端 `onEvent` 监听 `tool_execution_start/end`（AI 调工具路径，注意区别于 `bash_execution_update`——那是 `!cmd`/终端直接执行路径专属）。`tool_execution_end` 触发时立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先于** toolResult 快照落盘——浏览器 tool 卡片随即从「执行中」切到「已结束 · 等模型 · 耗时」，一眼区分「命令还在跑」vs「命令完了在等模型响应」。bash 工具的 details 不带 exitCode（成功时返回 truncation 信息，失败时错误文本含 `Command exited with code N`），服务端从错误文本正则提取；`tool_execution_start` 时刻记在 `conv.toolStartTimes`（按对话隔离）算真实执行耗时。前端 `toolStatuses` Map 在 toolResult 落盘（snapshot prune）后清除，回落到权威的 toolResult 状态。

### 工具挂死看门狗

每个 `tool_execution_start` 都会为 toolCallId arm 一个看门狗 timer（**优先取设置面板「工具」页的 `ClientSettings.toolWatchdogTimeoutMs`**（分钟，0 = 禁用，逐 run 实时读取、无需 reload）；未设时回落环境变量 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒），再回落默认 20 分钟）——超时仍在跑就 `session.abort()`（杀进程树）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都会清掉对应 timer。**若工具调用自己显式声明了更长的超时**（目前只有 bash 的 `args.timeout`，秒），看门狗自动顺延到 `max(基础值, 工具超时 + 5s)` —— 否则 AI 传 `timeout: 5400`（90 分钟）也会被 20 分钟的看门狗联同整轮对话一起剁掉。恢复重建 + 重绑会话（同一 conv 记录，UI 不掉线）；看门狗超时也走同一 `interruptRun`。**只停止运行，不碰后台服务**——那些由「后台任务」面板单独管理。回归：`tests/unit/tool-watchdog.test.ts`。

**豁免 `ask_user_question`**：问卷阻塞等的是「人类回答」，不是挂死的工具——arm 前按工具名跳过（`tool_execution_start` 里 `event.toolName !== ASK_USER_QUESTION_TOOL_NAME`）。它的收场自有路子：用户回答/取消、会话 dispose（`cancelPendingQuestions`），**不限时**（标准 pi 引擎；DSH 引擎无此看门狗，提问走 `PI_WEB_DSH_QUESTION_TIMEOUT_MS` 自己的 10 分钟）。同理，问卷挂着也不算「失联」——stall 检查（`startStallTimer`，默认 180s 无 SDK 事件告警）对 `isWaitingOnUser(conv.id)` 的对话跳过。回归：`tests/question-bridge-test.mjs`（`PI_WEB_TOOL_TIMEOUT_MS=2000` 挂着不答超过阈值仍不终止）。

### 审批三档放行与自定义规则库

人机协同审批（`tool_approval_pending`）原先只有「批准 / 拒绝 / 修改并放行」三个单次选项，同一类高危操作反复出现时每次都要点。现在的审批系统分为**规则评估引擎**与**放行策略**两个层次：

#### 1. 自定义规则库与匹配引擎（`<dataDir>/approval-rules.json`）

规则由 `server/approval-rules.ts` 的 `ApprovalRulesStore` 持久化，所有客户端全局共享。规则在设置面板「审批规则」页可视化编辑与排序，按列表顺序自顶向下匹配，首个命中生效：

- **适用工具**（tools）：支持单工具（如 `bash`）、多工具组合（如 `["write", "edit", "edit_soft"]`）或通配 `*`；
- **检查字段**（field）：`command`（命令字符串）、`path`（目标文件路径：认 `path` / `file_path` / `file` 三种写法，见 `extractTargetPath()`，扩展实现如 pi-better-edit 的 `edit` 用 `file`）、`params`（完整参数 JSON 字符串）；
- **匹配模式**（match）：
  - `regex`：大小写不敏感正则表达式匹配；
  - `glob`：路径通配符（支持 `*` 单段、`**` 跨目录跨段，统一归一化正反斜杠）；
  - `contains`：包含子串匹配；
  - `prefix`：前缀开头匹配；
  - `outside_workspace`：工作区外写入越界检测（基于当前工作区 cwd 与额外 roots 物理路径判定）；
- **命中动作**（action）：
  - `ask`：触发人机协同审批（弹窗让用户决定，支持就地编辑参数与允许同类）；
  - `deny`：直接拒绝阻断执行并向模型回传错误（不弹窗、不产生待审批 pending）；
  - `allow`：免审直接放行（白名单，跳过后续规则与内置检测，直接执行工具）。
- **内置规则转化**：原硬编码的 10 项内置高危检测（`rm -rf`、Windows `del /s /q`、磁盘格式化、破坏性 Git、危险 `chmod`、系统目录重定向、敏感配置 `.env`/SSH/Shell 以及越界写入）全部转换为默认内置规则（`builtin: true`），用户可自由停用、调整动作或一键恢复默认。

#### 2. 三档放行策略（运行时快速免问）

门禁统一在 `ClientSession.askApproval` 入口（纯函数 `approvalSuppressionReason(policy, enabled, categoryId)`，`server/tool-approval.ts`，单测 `tests/unit/tool-approval.test.ts`）：

1. **全局关**：设置 →「工具」页的「工具执行审批」总开关（`ClientSettings.toolApprovalEnabled`，默认开，纯运行开关不进预设）。关掉后一切审批都不弹——内置高危检测直接放行、插件 pre guard 的 `ask` 也按放行处理（`withToolGuard` 的 `ask` 分支只改 `needApproval`，最终都经 `askApproval` 定夺）；开关被关掉的那一刻，挂着的待审批项由 `autoApprovePendingApprovals` 全部按批准放行（不让人对着弹窗干等）。
2. **本对话全部允许**（弹窗按钮，`tool_approval_response.scope = "all"`）：该对话后续任何高危操作都不再询问。
3. **本对话允许同类**（弹窗按钮，`scope = "category"`，仅在本次命中规则档位时出现）：只放行同一档位。档位 = `UiApprovalCategory{ id, label, labelEn }`，id 稳定不许改名：`bash.rm-rf` / `bash.win-del` / `bash.disk` / `bash.git-destructive` / `bash.chmod` / `bash.system-redirect` / `file.sensitive.env` / `file.sensitive.ssh` / `file.sensitive.shell` / `file.outside-workspace` / `plugin:<pluginId>`（插件 pre guard 的 `ask` 按插件分档）。无档位的拦截（自定义 reason）只受前两档影响。

**策略挂在哪**：`Conversation.approvalPolicy = { allowAll, categories: Map<id, UiApprovalCategory> }`，**仅内存**（不落 client-state），且挂在对话对象上而不是 ClientSession——手动过户搬的就是对话本体，策略跟着走；重启服务 / 新对话即恢复询问。记住后同对话内**已被新策略覆盖的其它待审批项一并放行**（`approveCoveredPending`），并给一句回执 notice。

**撤销**：设置 →「工具」页列出当前对话已记住的放行（`UiSettingsState.approvalPolicy`，服务端 `approvalPolicyState()` 现取），逐条「撤销」走客户端 `set_approval_policy`（`allowAll` 赋值 + `categories` 作保留名单整体替换；纯内存态，不走 `set_settings`）。弹窗本身在策略生效后就不再出现，所以撤销入口必须留在设置里。

回归：`tests/approval-policy-test.mjs`（协议面：开关持久化 / 策略推回面板 / 垃圾消息 no-op）、`tests/approval-rules-test.mjs`（自定义规则协议面）、`tests/unit/approval-rules.test.ts`（匹配引擎单测）、`tests/unit/tool-approval.test.ts`（档位与三档判定）。

### 待答问卷进快照（重连恢复对话框）

`question_pending` 是即时通道：只推给「提问那一刻在线」的连接，刷新页面 / WS 重连 / 新标签页都收不到那条历史消息，而服务端还在阻塞等人回答——面板会凭空消失（`DshQuestionDialog` 没有别的入口）。因此待答问卷同时挂在快照上（`UiState.pendingQuestion`，标准引擎按对话过滤：`pendingQuestionForSnapshot()` 只带当前对话的那张，切回原对话会重推快照；DSH 的提问桥是 runtime 级的，不分对话）。前端 `use-chat.ts` 收到 `snapshot` / `snapshot_delta` 时用纯函数 `web/src/pending-question.ts` 的 `resolvePendingQuestion` 决定面板去留：快照有待答问卷就恢复（已答过的 id 跳过——回答消息与在途快照会交错），但只有「由快照恢复出来的」面板才接受快照收起（避免一张回答之前的旧快照把刚由即时通道弹出的面板闪掉）。单测 `tests/unit/pending-question.test.ts`。

### 后台任务列表

bash 工具执行前后各拍一次监听快照（`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 进程记入 `bgServers`（端口→pid→since→name，name 经 `lookupProcessName` tasklist/ps 尽力获取），启动后 notice 提示「可在顶栏「后台任务」里单独停止或全部关闭」；**列表按客户端持久**（ClientSession 字段，非对话级）——对话结束/切换/断线重连都不消失（attachSink 重推 `bg_servers`），只有任务被停或进程自行退出才移除（30s 定时器 `refreshBgServers` 重新对端口快照，port+pid 都匹配才算还活着，静默剔除死项）。

**自动清理遗留实例**（面板底部「自动清理遗留」下拉 + 「立即清理」）：阈值档位 `0/15/30/60/120` 分钟（`ClientSettings.bgAutoCleanupMin`，**默认 0 = 关**），同一个 30s 定时器里实时读设置 → `BgServerTracker.cleanStale(thresholdMs)`：先 `verifyBeforeKill` 复核端口→pid 归属（不对就剔条目，**绝不对陌生进程开杀**），再按 `staleLeftovers()`（纯函数，单测覆盖）挑出**未钉住**且 `now - since >= 阈值` 的条目 → `killPidTree` + 汇总 notice。面板每行可 📌 **钉住**（`set_bg_keep`）：钉住的永不参与自动清理（现场：调试时故意留着的 dev server 不该被扫掉）。手动「立即清理」在阈值为关时用 30 分钟兼底，消息可带 `minutes` 覆盖（>0 生效）。插件注册的常驻任务（`registerBackgroundTask`）**不参与**自动清理——它们在宿主进程内，由插件的 `stop` 回调负责。回归：`tests/unit/bg-servers.test.ts` / `tests/bg-cleanup-test.mjs`。

**误报过滤**（`BgServerTracker.filterAgentSpawned`）：端口 diff 只是候选，还需通过 `shouldTrackBackgroundServer` 判定才记入——① 进程名命中黑名单 `NON_AGENT_PROCESS_NAMES`（WeChat/QQ/Telegram 等桌面软件）直接跳过；② 一次 PowerShell CIM / `ps -Ao pid=,ppid=` 批量拉全量父子映射，沿父链回溯：撞上服务器进程（`process.pid`）或本次 diff 出的其他新 pid（bash 留下的中间层）→ 记录；完整回溯到系统根（pid 0/1）未命中 → 桌面软件自启（如自己开的 Chrome，父链是 explorer），跳过；断链（父已退出/reparent）→ 保守记录。**Chrome 不进黑名单**：Playwright 等由 AI 拉起的浏览器父链能回溯到服务器进程，与用户自开的 Chrome（父链 explorer）区分开。

协议：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按端口停单个）/ `kill_background_servers`（全部关闭，`killAllBackgroundServers` 对每个 pid `killPidTree`，Windows `taskkill /F /T`）/ `list_bg_servers`（面板打开时请求刷新）；前端 `BgTasksModal`（每个任务行「停止」+ 底部「全部关闭」「刷新」，空列表有占位文案）。

### 只停止 bash 命令（对话继续）

bash 工具卡片运行中显示「停止」→ 发 `{ type: "abort_bash" }` → `ClientSession.abortBash()`。服务端用 **killable bash 工具**（`makeKillableBashTool`，经 `customTools` 按 name 覆盖 SDK 内置 bash）：执行时把自己的 AbortController 注册进客户端级 `bashKills` 集合，abort 只杀这些 controller → bash 子进程进程树被杀（工具抛 "Command aborted"，被 agent-loop 捕获成工具错误结果）→ **agent run 与对话继续**；与 SDK `session.abortBash()`（只对扩展 `executeBash` 路径有效，agent 工具路径无效）不同，这里对对话中的 bash 工具调用真实生效。

命令被中止时 SDK 会把**终止前已输出的内容拼接进工具错误结果**（AI 能看到输出 + "Command aborted"）；随后 `abortBash()` 再 `sendUserMessage` 注入「用户手动停止」提示，让 AI 明确知道是用户手动而非失败。

### 独立宽松编辑工具 edit_soft（不覆盖内置 edit）

内置 `edit` 要求 oldText 与文件恰好匹配（含缩进/空白）。对缩进非语法意义的语言（如 JS/JSON），模型给出的 oldText 常与文件差几个空格/制表符而导致编辑失败。pi-web-ui 经 `customTools` 注入一个**不覆盖**内置 `edit` 的独立工具 `edit_soft`（`server/edit-soft-tool.ts`）：先用精确子串匹配，失败后按「逐行核心（trim）序列一致」做宽松匹配（忽略行首/行尾空白差异），命中后**整行原样写入 newText**（缩进即最终缩进）。仅唯一匹配才写，重叠 edit 报错，并参与同一个 per-file 变异队列（`withFileMutationQueue`）。

**多 edit 必须按位置排序再逆序应用**（`applySoftEdits`）：所有 edit 都相对同一份原内容定位，得到各自的 `start/end` 后要**先按位置升序排**、再逆序套用，左侧偏移才稳定。早期实现漏了排序，直接按 edits 的传入顺序逆序应用 —— 模型若把靠后的 edit 写在前面，后面的替换先改变长度，前面的偏移随即串位，写出错乱内容（历史 bug：`protocol.ts` / `use-chat.ts` / `ChatInput.tsx` 被写坏）。内置 `edit` 同样是先按 `matchIndex` 排序（`edit-diff.js`），此处对齐。回归测试覆盖全部 6 种排列。

**非法片段防御**：宽松匹配要求 oldText 每行都是完整行。（a）精确命中若跨多行却首/尾未落在行边界（如 `a);\nfoo(`），直接子串替换会吃掉行首/行尾残留写出粘连内容（`foo(z();b);`）→ 拒绝并提示按整行给；（b）宽松阶段整块对不上、且首/尾行只是某行的一部分时，报「片段」错而非笼统的「找不到」；（c）单行片段（如 `b();`）不改行结构，照旧支持。

开关走统一工具管理（`server/tool-manager.ts` 的 `disabledAgentTools`，默认关）：关闭时该工具从活跃集移除（`applyAgentToolsGating` 经 `setActiveToolsByName`，与终端/子代理工具同一机制，live 生效无需 reload），不会出现在 Available tools 段。DSH 引擎无该工具，设置面板无「工具」分区。

### read 覆盖：路径是目录时列出目录条目（`server/read-tool.ts`）

SDK 内置 `read` 只处理文件（`read("server")` 直接 `EISDIR: illegal operation on a directory`），SDK 自带的 `ls` 又不在默认活跃集（`["read","bash","edit","write"]`）里，模型要看一眼目录只能改用 bash。pi-web-ui 因此经 `customTools` **按名覆盖**内置 `read`（bash 覆盖是先例）：用 `createReadToolDefinition(cwd)` 拿原实现当基底，`execute` 里先判路径是不是目录 —— 是目录就分流到 SDK 的 `createLsToolDefinition(cwd)`（一行一项、目录带 `/` 后缀、排序与条目/字节截断口径与 SDK `ls` 完全一致），正文前置一行 `[Directory: <path>]`；其余情况（文件、图片、路径不存在、读取报错）原样转发基底，行为与内置一致。目录分支里 `limit` 是条目上限、`offset` 忽略。

开关 `readDirEnabled`（设置 → 工具页首行，默认开）：这是**行为开关**（read 本体的开/关在设置页「核心工具」区，走 ActiveSet；这里管的是覆盖层列举目录的行为，与 read 工具本体是否启用无关），不是 ActiveSet 开关 —— 因此不进 `tool-manager.ts` 的 `AGENT_TOOL_CATALOG`，覆盖定义每次调用实时读设置（改动即时生效、无需 reload），也不进设置预设。DSH 引擎无 customTool 注册面（工具来自 shipped preset），不支持该覆盖，快照里恒为 true。

参数上额外接受 `file_path` 作为 `path` 的别名（部分客户端/模型习惯发 `file_path`）：schema 里 `path` 仍必填，靠 `prepareArguments` 在校验前把只有 `file_path` 的调用归一成 `path`（两者都给时 `path` 为准），转发内置实现时也带上归一后的 `path`。前端工具卡头的路径提示（`web/src/tool-args.ts`）本来就同时认这两个名（SDK 自带 renderers 亦然）。

**基底也可能是第三方扩展注册的 `read` 或 `bash`**：SDK 的合并链是 `[...扩展注册的工具, ...customTools]` 逐个后写赢，所以覆盖层若直接进创建时的 `customTools` 就会**静默顶掉**扩展的同名工具 —— 而官方 `docs/extensions.md` §Overriding Built-in Tools 明写扩展可以覆盖 `read`/`bash`/`edit`/`write` 等。因此 `bash` / `read` / `write` / `edit` 四处覆盖**不在创建时注册**，改由 `server/tool-overrides.ts` 在会话建好后注入，基底优先取扩展实现 —— 详见下一节「覆盖与第三方扩展同名工具共存」。

### 覆盖与第三方扩展同名工具共存（`server/tool-overrides.ts`）

pi-web-ui 覆盖了 SDK 内置 `bash` / `read` / `write` / `edit`。SDK 的注册表合并链是 `allCustomTools = [...扩展注册的工具, ...customTools]` 再逐个 `definitionRegistry.set(name, …)` —— **后写赢**：创建时把覆盖塞进 `customTools`，等于让 `docs/extensions.md`「扩展可覆盖内置工具」那句承诺失效（第三方扩展的同名工具永远轮不到，且审查/沙盒类扩展被彻底架空，例如 `@buyong/pi-codex-auto-review` 的 bash 审查完全不触发，命令直接裸奔，issue #750）。

现在的做法：这四处核心覆盖在**会话建好后**由 `installToolOverrides(session, specs)` 注入 —— 逐个按名字从 `session.extensionRunner.getAllRegisteredTools()` 取扩展实现当基底（取不到才用 pi-web-ui 自己的完整实现），交给 `composeWith` 装饰后**前置**写回 `session._customTools` 并 `_refreshToolRegistry()`（与插件工具同步 `syncPluginToolsIntoSession` 同一手法）：

- `bash`：有扩展 bash → 保留扩展自身的一切定义与独有参数（如审查参数 `sandbox_permissions`），外层包裹宿主硬安全闸门（目标审查回合只读 / 审查者模式拦截 / 计划模式硬闸门 / 沙箱越界硬围栏 / 会话只读权限 / 审批规则引擎 / 插件守卫），并桥接 `bashKills`（使 UI 中断按钮可中断扩展内部命令）与 `applyHeadTail`；没有 → 原生可中断 bash 与 PTY 终端 bash 自适应分流（`makeAdaptiveBashTool`）。检测到扩展接管时通过 notice 告知用户终端接管已让位。
- `read`：有扩展 read → `withReadDirSupport(扩展定义)` —— 基底的 name/label/描述/参数 schema/`prepareArguments`/render 槽位全部原样保留，只补一句目录说明、一条目录指引与目录分支（目录分支仍复用 SDK `ls` 的排序/`/` 后缀/截断口径）；没有 → `makeReadDirTool()`（内置基底 + 英文描述 + `file_path` 别名）。转发基底时**不改写扩展的参数**（`file_path` 归一只属于内置那份，扩展自带 `prepareArguments`）。
- `write` / `edit`：有扩展同名工具 → 把它的定义当权限沙箱包装的**基底**（执行时先过只读 / 工作区外拦截与审批，再委托扩展实现）；没有 → 包装 SDK 内置实现。

四条不变量：① 扩展那份实现的 schema / 描述 / prompt 指引 / 渲染不被替换（扩展独有参数如 better-edit 的 `windows` 照旧可用）；② 覆盖项前置 ⇒ pi-web-ui **插件**注册的同名工具（也是 customTools、比覆盖层后写）仍是最后赢家，与改动前的相对顺序一致；③ 重复注入幂等（同名先剔除再前置）；④ 会话对象形状不符（SDK 改私有字段名）返回 `null`，按「覆盖没装上」降级（等价改动前行为，不会更差）；`extensionRunner` 缺失时同样退回内置基底。

`extractTargetPath()`（`server/approval-rules.ts`）：权限沙箱与审批规则要按「目标文件」判定，必须认三种写法 —— SDK 内置用 `path`、`read` 有 `file_path` 别名、部分扩展（`pi-better-edit` 的 `edit`）用 `file`；只认 `path` 会在叠上扩展实现后取到空串、被判成工作区内而**静默放行**。规则引擎的 `path` 字段走同一个函数。

开关仍是行为开关（`readDirEnabled`），不进 `tool-manager.ts` 的 `AGENT_TOOL_CATALOG`；DSH 引擎无 customTool 注册面，不接。工具定义提示词遵循纯英文约定（`tests/unit/tool-prompt-hygiene.test.ts`）。回归：`tests/unit/tool-overrides.test.ts`（基底解析 / 前置顺序 / 幂等 / 降级）、`tests/unit/read-dir.test.ts`（`withReadDirSupport` 的 schema、描述、转发与目录分支）、`tests/unit/approval-rules.test.ts`（`extractTargetPath` 与规则字段）。

### 审查者模式：自动委派（`server/delegate-mode.ts`）

「强制 AI 开持久子代理」的服务端实现，形态是**会话级开关 + 全自动路由 + 纯委派闸门**（默认关）：

1. **自动路由**（`ClientSession.dispatchToDelegate`）：`prompt()` 一进来就问它要不要接管 —— 开着就把这条文本转给**一个常驻落盘执行对话**（每会话一个，跨轮复用；与目标模式 2.0 的执行对话同一通道：`spawnSubagentConversation(..., persist=true)`，落盘、进历史、可续聊）。首轮的 prompt 直接交给 spawn 起步，**之后**每轮才 `sendUserMessage` 追加（首轮再发一次会被 SDK 拒：`Agent is already processing a prompt`）。主对话这一轮**不跑模型**，只发一条 notice。执行对话跑完 → 主对话一条 notice（带最后一条回复摘要 + 左栏可打开），**不做自动验收**（v1 口径：验收由人/主对话下一轮做）。
2. **纯委派闸门**（`withDelegationGate`，挂在与计划模式同构的三处：customTools 整列 / `write`·`edit` 覆盖 / 常驻终端 `checkSafety`）：写类工具、非常规 bash（复用 `bashCommandIsReadOnly`）、**派发类工具**（`spawn`/`delegate_task`/`set_goal`/…）一律拒。派发类也拒的理由与计划模式不同：那边是「别绕开只读约束」，这边是「派活是服务端的活，别自己再开一份上下文」。
3. **软约束**（`DELEGATION_SYSTEM_PROMPT`）：提示模型它是审查者、该干什么（定验收标准 → 看 diff/测试 → 接受或提下一轮要求）。

**与计划模式的优先级**：计划模式开着时**不自动派活**（计划模式已把 spawn/旁路工具全拒，再自动派活就是死锁），提示词段也只注入一条 —— 计划模式那一轮自己在主对话里出计划。DSH 引擎没有 customTools 注册面（闸门无处可挂）→ `setDelegateMode` 明确回 notice 拒绝，不静默失败。

状态：布尔随会话转录落盘（customType `delegate/mode`，回放见 `readDelegateModeFromSession`）；**执行对话 id 不落盘** —— 它是本进程内的活对象，重启后首条请求重建（宁可多一个执行对话，也别指向一个不存在的 id）。判定纯函数（单测 `tests/unit/delegate-mode.test.ts`），端到端回归 `tests/delegate-mode-test.mjs`（零 token，已在 smoke ALL 列表）。

⚠️ 落盘执行对话占「每项目 8 个普通对话」名额之一（与目标模式的执行对话同一个池子）—— 满员时派活会抛错并提示关掉模式或先释放名额。

### 计划模式：只规划不实施（`server/plan-mode.ts`）

目标条**展开行**里有个 **计划** 按钮（`host:goal-plan` 槽位，DSH 引擎不渲染 —— 它没有 customTools 注册面，闸门无处可挂）。它经历了两次调整：① 从输入框工具条的开关（`host:composer-plan`）搬进目标条 —— 语义是「拿你在这个框里写的输入去做规划」，与目标同属一条线，所以只挂编辑行、**不进折叠药丸**；② 从「开关」改成**一次性动作** —— 点一下 = `set_plan_mode{true}`（开闸门）紧跟一条 `prompt`（把目标输入当消息直接发出去），两条同 WS 按序到达 → 本轮就在闸门里跑；输入为空则只开闸门不发消息。按钮不再有 `active` / `aria-pressed` 常亮态，和同列的「提炼」「发送」一个口径：「点一下直接发」。目标模式被关掉（`goalModeEnabled=false`，整条目标区不渲染）时它也跟着一起隐藏。闸门本身仍是会话级、热生效：开启后**本对话只调研 + 出实施计划，不做任何改动**，产物是 `plan_update` 步骤看板（PlanBoard）+ 计划正文。**关闸门的唯一出口是计划看板里的「开始实施」**（PlanBoard.tsx：`set_plan_mode{false}` + 发一条实施请求）—— 删掉开关语义后必须补这个出口，否则进得去出不来。**与目标模式正交**：目标模式是「让执行者把目标做完」，计划模式是「先别动，把方案给我」。

两层防护，缺一不可：

1. **硬闸门（`withPlanModeGate`，唯一的强制点）**：装饰在工具定义外层、`execute` 之前判定一次，比权限沙箱与插件守卫更靠外。命中即返回 `isError` 的工具结果（`details.planModeDenied`），把「写进计划、等确认」的替代路径回给模型。挂载点三处：① 整列 `customTools`（含 bash 覆盖、`edit_soft`、`patch`、`eval`、子代理派发与排程工具）；② `installToolOverrides` 注入的 `write` / `edit`（`toolOverrideSpecs` 的 `composeWrite`/`composeEdit`）；③ 常驻终端工具的 `checkSafety`。关闭时只多一层布尔判断。
2. **软约束（`PLAN_MODE_SYSTEM_PROMPT`）**：`appendSystemPromptOverride` 按当前会话状态追加一段纯英文硬规则，切换开关时 `session.reload()` 重建，下一轮即生效。这段提示词真正的载荷是两条：
   - **禁代码倾倒**（`## Output shape` 段）：`NEVER write the implementation` —— 不贴整文件、不贴完整函数、不给「成品版代码」，只描述改哪些文件、结构、关键决策、风险、验证方式与第一步；代码只允许「棘手处的短片段（~20 行、至多两处）」。**这条是硬闸门的补丁**：闸门让模型写不出文件，模型就会把整份实现当正文吐出来（烧 token 又没落地，实报过一次「让它写单页贪吃蛇，上来就贴几百行源码」）。注意回归：提示词段内禁中文（`tests/unit/plan-mode.test.ts` 有 CJK 断言，写「开始实施」这类 UI 字样要改写英文）。
   - **小需求走短计划**（`## Plan board` 段）：只有「3+ 步或有真未知」才先 `plan_update` 列 pending 步骤；「写个单页贪吃蛇」这类小而明确的需求**跳过看板**，直接给短计划（要动哪些文件 / 结构 / 验收 / 第一步），省一轮工具往返。

   提示词正文可在**设置面板 → 提示词 → 计划模式提示词**改：`planModePromptMode`（append/replace）+ `planModePrompt`（自定义正文），语义同视觉桥 / AI 提交信息（空自定义 = 内置默认，replace 下输入框预填内置默认供直接改），`buildPlanModePrompt` 纯函数拼装（单测覆盖三种组合）。**只改提示词，硬闸门不受影响** —— 服务端只读约束永远生效。该项不进设置预设（同 scmCommitMsgPrompt）。

判定纯函数（单测 `tests/unit/plan-mode.test.ts`）：`planModeDenial(toolName, params)` 分三类 —— **写类工具**（`write`/`edit`/`patch`/`rm`/`git` 等名单）直拒；**bash 只读白名单**（`splitShellSegments` 按 `;`/`&&`/`||`/`|` 切段，每段都要过：禁重定向 / 命令替换 / 后台 / heredoc，命令在白名单内，`git` 只放 `status|diff|log|show|blame|…` 等只读子命令，解释器只放行 `--version`/`--help`）—— 刻意保守，宁可拒一次让模型换命令；**旁路工具**（`spawn` / `delegate_task` / `set_goal` / 排程等）也拒：闸门是**会话级**的，子代理对话的 `planMode` 是 false，放行等于留后门。

状态随会话转录落盘（`plan/mode` 自定义条目，回放见 `readPlanModeFromSession`，与 `permission/preset` 同口径），切会话/重载恢复；快照字段 `UiState.planMode` 恒给布尔（用 `undefined` 会在 `snapshot_delta` 里丢键，前端 spread 合并会残留上一对话的 `true`）。已知边界：插件 / MCP 自带工具不经这三处挂载点，只受软约束约束。回归：`tests/plan-mode-test.mjs`（零 token：开关快照 / 写类被拒 / bash 读写分流 / 关闭后恢复 / 转录落盘）。

### 模型操作浏览器页面（`browser_page` 工具）

让模型直接读/操作你在浏览器里打开的页面（详见 `plugins/page-picker/README.md` 的「AI 操作页面」）。
**四段链路**，缺一段都不通：

```
模型 ── browser_page 工具（server/agent-service.ts makeBrowserPageTool）
  │   参数：op（pages/read/click/type/scroll/goto/wait/eval）+ target/origin + 各动作参数
  ▼
ClientSession.pageCall()  ── 发 page_request（带 id + timeoutMs，默认 30s/上限 120s，**有空闲超时**）
  │   没有「人类在等」，所以不进看门狗豁免；前端不在线时直接给可执行的错（“打开 pi-web-ui 页面”）
  ▼
浏览器里的 pi-web-ui 页面 ── use-chat.ts 收到 page_request → 宿主桥 `window.__piWebUiHost.pageCall()`
  │   （web/src/plugin-host.ts 的 `pageCall()`，宿主 API 自 v3 引入、当前 v11；桥不在就给一句“装/启用 page-picker 并刷新本页”）
  ▼
page-picker 扩展 ── content script → service worker → chrome.scripting.executeScript(world:MAIN)
  │   准入：sender.tab.url 必须是「已绑服务地址的 pi-web-ui 页面」+ 目标在扩展的授权列表里 + op 过白名单
  ▼
目标页面 ── 内置动作（read/click/type/...）在页面主世界里执行，结果原路回到模型（page_response）
```

**为什么另一端固定是 pi-web-ui 页面**：扩展只能被浏览器里的东西调（模型在服务端进程里），而
`window.__piWebUiHost` 是现成的、已认证的页面内桥（插件系统用了同一套）。代价：那个标签页得开着；
好处：服务端零新增监听、天然复用登录态，而且**人类看得见模型在动哪个浏览器**。

**协议**：`page_request`（server→client，`op` 由扩展解释、服务端只透传）/ `page_response`（client→server）。
不进快照（没有要人回答的东西；刷新即这次调用失败）—— 与 `question_pending` 的区别就在这。

**引用到对话（人在环中的入口）**：`web/src/components/BrowserControl.tsx` 把已授权页面做成
「网页引用」附件（`mode:"page"`，`path` = 页面 origin、`name` = 标题）；**只授权一个页面时顶栏按钮直接
变成该页面标题**（点主体=引用、右侧 ▾ =打开面板），多个页面时面板里每项都有「引用到对话」。
服务端 `attachments.ts` 对 `mode:"page"` **不 stat / 不读文件**，只给模型一句 `<browser-page url title>`：
「这个页面已授权，用 `browser_page`、`target=<origin>`」—— 用户不必在话里手打网址。
**截图**（`op:"shot"`）不走页面执行：`captureVisibleTab` 只能截活动标签页，且只认 `<all_urls>`
或 activeTab（普通 host 授权不够）—— 所以扩展先切页、截、裁（`planCrop`）、**切回**，并且
需要用户在扩展里额外授一次「所有网站」权限。图片回给模型有两条路：主模型能识图就在**工具结果里**
直接带 image block（当轮可见）；纯文本模型走 `ClientSession.transcribeToolImage()` → 视觉桥转写成
文字证据（与用户附件同一套选择逻辑与提示词）。

**闸门全在扩展侧**（授权表 + 白名单 + 总开关 + eval 开关）：服务端不做动作白名单，否则
「扩展能做什么」就散落在两处了。

**入口在网页侧**（顶栏「浏览器操作」按钮 + `web/src/browser-control.ts` + `BrowserControl.tsx`）：
能力在扩展里，网页只能做三件事 —— 报状态（扩展动作 `status`）、把人送到扩展设置页
（动作 `openOptions`，因为网页不能自己导航到 `chrome-extension://`）、给可照抄的例子。
状态是**按需查询**（不进快照流）：挂载后查一次 + 打开面板时刷新 + 45s 轮询。
模型在目标页面上动手时，页面右下角会闪一条「AI 正在操作本页」的提示（挂 shadow DOM、
pointer-events:none、2.2s 淡出），避免用户以为页面自己在动。回归：`tests/unit/browser-page-tool.test.ts`、
`tests/unit/page-picker-ai-ops.test.ts`、`tests/page-picker-bridge-test.mjs`、`tests/page-picker-edge-ext-test.mjs`。

### 扩展 UI 桥

扩展的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 消息；对话框经 `dialog_response` 回传，Esc 视为取消。`Dialog.tsx`（扩展对话框）与 `DshQuestionDialog.tsx`（DSH 模型提问桥）的正文/选项/详情/预览都走 `Markdown(rawHtml)` 富渲染（markdown + 原始 HTML 混排，模型自选、信任模型；默认 `rawHtml=false` 的聊天正文渲染不受影响），可选项 `preview` 展示「选项预览」框。

`snapshot` 里 `streamingMessage` 是进行中的消息（60ms 粒度流式），`messages` 是已落盘的。

### Durable 引擎的数据来源：只认 AgentEvent，不读 `pi.live` 槽位（`server/durable/durable-event-projector.ts`）

Pi Durable（`@earendil-works/pi-durable`）把同一件事分成两份投影，**职责不能混**：

- `pi.live`（`conv.watch()`）是**廉价可剪的运行期进度投影**：工具槽位只有 `running` 期间带 `output`，结算即被剪掉；
  槽位**从不携带 `input`**（模型发起调用的入参在工具任务的 `state.checkpoint` 里）。因此抓槽位拿不到入参、也拿不到回执。
- `watchEvents(harness, conversationId, ctx)` 才是权威事件流：`tool_execution_start.args`（引擎已从 checkpoint 解析好，
  嵌套调用直接给槽位的 `arguments`）、`tool_execution_end.entry`（模型调用，`model[0]` 是 ToolResultMessage）或
  `.result`（嵌套调用）、`message_start/message_update/message_end`（正文与思考）、`tool_execution_update`（进度输出）。

历史坑（#774）：驱动曾对 `pi.live` 做差分，读 `slot.input`（永不存在）与结算后的 `slot.output`（已剪），
导致工具卡命令空、结果空，并同链路污染落盘会话（`argumentsText: "{}"`）。现在全部改由 `DurableEventProjector`
投影事件流：按 `contentIndex` 记账已下发的正文/思考长度（流式增量与最终整段落盘不重复不丢字），
工具回执「成功只带 `output`、失败只带 `error`」向下游对齐；嵌套调用（`parentToolCallId`）不单独出卡片，
保住「一个父调用一张卡」的展示口径。回归：`tests/unit/durable-event-projector.test.ts`（含驱动不得再读 `slot.input/slot.output` 的守卫）。
