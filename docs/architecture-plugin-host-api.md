# 插件宿主 API 清单

宿主暴露给插件的全部能力边界：MCP 工具桥、目录授权与跨目录 fs、能力动态授权、定时任务、项目组装与会话 API、HTTP 请求的工作区归属、多根工作区，以及机器可读的注册面目录。插件内核见 [`architecture-plugins.md`](architecture-plugins.md)。

## 目录

- [目录授权与跨目录 fs（issue #146）](#目录授权与跨目录-fsissue-146)
- [能力动态授权（host.requestPermission）](#能力动态授权hostrequestpermission)
- [定时任务持久化（host.schedule 的 persistent）](#定时任务持久化hostschedule-的-persistent)
- [项目组装 API（host.project.create，issue #146）](#项目组装-apihostprojectcreateissue-146)
- [插件 HTTP 请求的工作区归属](#插件-http-请求的工作区归属)
- [多根工作区（`set_workspace_roots`，issue #146）](#多根工作区setworkspacerootsissue-146)
- [项目 / 会话 API（host.openSession / host.sessions，issue #146）](#项目--会话-apihostopensession--hostsessionsissue-146)
- [注册面目录（机器可读，P2-7）](#注册面目录机器可读p2-7)
- [群组工单宿主 API 与 Superagent 公开 Webhook](#群组工单宿主-api-与-superagent-公开-webhook)

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


## 插件 HTTP 请求的工作区归属

文件预览的 `ctx.apiUrl()` 自动携带当前标签页的 `clientId`。宿主根据该客户端捕获 cwd 和额外根，并通过 `AsyncLocalStorage` 贯穿整个异步 HTTP handler；`host.cwd`、`resolveInWorkspace` 和宿主文件访问使用此请求快照，不受其他标签页切项目影响。显式提供未知客户端时拒绝请求；未提供客户端的旧接口继续使用请求开始时的全局工作区快照。


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



## 群组工单宿主 API 与 Superagent 公开 Webhook

`host.workItems`（契约见 `plugin-sdk/index.d.ts`）复用存量 `chat` 权限。宿主信任具备该权限的插件根据本地配置提交工单授权；外部 payload 不是授权来源。`server/plugins.ts` 注入插件自身的 `connectorId`，经 `server/device-center/local.ts` 转发到 Hub，在账号 / 群组与来源范围内处理，不由插件提供另一套模型或执行器。

- `rooms`、`ingest`、`list`、`get`、`update`：映射房间、接收去重事件、读取工单及按业务 revision 更新；当前 `list` 返回首个有界预览页，不承诺全部历史。
- `claimDelivery`、`completeDelivery`、`failDelivery`：领取持久 outbox、持租约确认或记录失败，由宿主安排后续重试。
- 工单授权不替代每事件授权：未通过作者白名单的 followup 不能借已有 auto 工单执行，人工授权的 `authorizedEventId` 仅绑定当前最新事件。初始描述保持，followup 作为独立事件证据；task 结果不自动完成业务工单。

Superagent 0.1.3 是宿主内置的 GitHub / 飞书渠道模块，内部复用插件运行时。后台 outbox 只轮询配置了房间映射和发送凭据的渠道；未配置时保持空闲，配置补全后自动恢复。轮询串行执行，正常每轮结束后等待 15 秒，宿主调用失败时指数退避至最长 5 分钟；同一轮故障只警告一次，恢复成功记录一次，诊断只包含可用的 HTTP 状态码与连接排查提示，不回显上游错误内容。卸载后不再排程、跨渠道领取或输出轮询日志。主站认证前只精确放行 `POST /api/superagent/webhooks/github` 与 `POST /api/superagent/webhooks/feishu`，转至插件对应路由并校验渠道签名。请求上限 **1 MiB**，宿主保存原始字节 Buffer（`req.rawBody`，rawBuffer 语义）供验签；插件不可用或原始字节不可用时拒绝。配置、工单管理和手动回写继续使用 `/plugins-api/superagent/*` 原有主站认证与插件校验，不能据此公开整个插件命名空间。

UI 和远程设备路径沿用 `appUrl()` / 插件 `apiBase()`，保留应用根路径与认证。公开回调采用插件页面显示的可达 URL，不把远程页面根路径当作隐含中转。Superagent 目录进入 npm 发布白名单，`server/builtin-modules.ts` 声明宿主必需模块，由 `server/plugin-bundled.ts` 在扫描前离线准备，首次启动即可从 **设备连接与跨平台协作 → 外部渠道** 打开；无需额外安装或独立顶栏入口。`DeviceChannels` 通过现有作用域导入器与 `PluginView` 内嵌视图，沿用窄上下文与卸载清理，按 epoch 刷新并隔离过期加载；显式重试会更新 bundle 缓存盐。内置模块不会显示在普通插件市场、已安装列表、菜单、布局或权限列表；管理数量与更新提示也排除它，普通安装 / 更新 / 卸载及自定义同名覆盖入口拒绝操作。旧插件禁用 / 卸载记录不控制宿主模块，缺失文件会重新准备，既有设置和密钥保留。`<dataDir>/bundled-plugin-installs.json` 只继续控制普通可选预装插件的首次准备，不作为必需模块的安装依据。飞书支持明文或 AES 加密的签名 text 回调，超过 45 分钟无回执的不确定投递需人工核对；GitHub 通过稳定 comment marker 恢复重试。真实外部凭据与渠道未在本轮联通，mock 测试不代表上线。

完整职责、群组顶部 AI Router / 工单抽屉用法、WAL 四集合、冻结 plan / lease / 配置 fence / effect receipts、分页与上下文预算见 [群组独立 AI Router 与 Superagent](group-orchestration.md)；渠道配置和支持范围见 [Superagent README](../plugins/superagent/README.md)。


