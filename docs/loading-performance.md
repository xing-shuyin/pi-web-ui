# 资源与历史对话加载优化

## 首屏按需加载

`web/src/App.tsx` 使用动态导入加载终端、Git 面板、画布、设置、模型管理、文件预览、后台任务、全局搜索和 TUI 弹窗。

`DeferredMount` 在视图首次激活前不挂载其子组件，因此不会触发 React lazy 的下载。激活后保持挂载，沿用外层隐藏容器及视图的 active 属性，保留终端、画布和搜索状态。不能只用 CSS 隐藏 lazy 组件：隐藏的挂载仍然触发下载。

TUI 通过 `tui-overlay-bridge.ts` 在代码下载期间按顺序缓冲 ANSI 输出，上限为 1,048,576 个 JavaScript 字符。新弹窗和关闭事件清除缓冲；挂载后请求服务端重新渲染完整屏幕，补偿超过缓冲预算的输出。实时帧继续走桥接，不进入 React 快照。

## 历史转录修复

`server/compaction-markers.ts` 的环检测为已完成路径建立集合。后续节点抵达已完成路径即可停止，避免健康长链反复向根回溯，将此步骤从 O(N²) 降到 O(N)，额外空间 O(N)。其他转录解析与 SDK 初始化成本仍然存在。

测试对照旧算法穷举 1,296 种四节点父图，验证断环位置和统计一致；长链通过 Map 查找次数上界检查复杂度，不依赖不稳定的机器耗时阈值。

## 构建验证

本次在同一工作区、同一 Vite 配置下对比原版和修改后的 `App.tsx`，构建至独立目录，不覆盖 `web/dist`。统计 HTML 直接引用的入口 JS、modulepreload JS 和 CSS；每个文件单独 gzip 后求和。

| 指标                        |      原版 |    优化后 |         变化 |
| --------------------------- | --------: | --------: | -----------: |
| HTML 首屏引用资源原始体积   | 3,453 KiB | 2,468 KiB |       -28.5% |
| HTML 首屏引用资源 gzip 体积 |   950 KiB |   675 KiB |       -28.9% |
| HTML 直接引用资源数         |         8 |        11 |           +3 |
| 首屏 xterm JS/CSS           |        有 |        无 | 改为按需加载 |

这是构建资源预算，未计插件运行时请求、字体等资源，也不是端到端加载耗时。共享依赖拆分会增加少量请求，终端、画布和设置首次使用时需要下载各自代码。基础 Markdown 仍属于首屏依赖。现有构建仍有大 chunk 警告。

## 第二轮：公式资源与工具输出

KaTeX 渲染器和 CSS 通过独立 `math` 分包按内容加载。基础 Markdown 和数学语法解析仍同步可用；含 `$`、反斜线、`math` 字样或启用 rawHtml 的内容会保守触发请求，`disableMath` 禁止加载和公式排版。加载期间显示基础正文与公式源码，加载完成后共享订阅通知已挂载消息恢复公式。并发请求合并，失败保留基础正文，不自动循环重试。

第二轮使用同一配置分别构建至独立目录，首屏 JS/CSS 原始体积从 2,468 KiB 降至 2,185 KiB，gzip 从 675 KiB 降至 593 KiB（再减约 12%）；相对最初 950 KiB 累计减少约 38%。公式分包不在初始 HTML 的 preload 或样式表引用中。遇到候选内容时浏览器仍会请求公式资源，因此上述预算代表无需公式时的初始引用体积。

独立 Chrome + Vite 测试入口验证了普通正文和 disableMath 不请求公式资源、首次公式异步加载并恢复排版，以及 rawHtml 的脚本与事件属性仍被净化。验证使用临时入口和独立端口，未访问用户浏览器或运行中的服务。这验证功能与请求时机，不代表生产环境加载秒数。

`server/serialize.ts` 的工具结果不再先 join 全部文本再截断，而是在 100,000 个 UTF-16 码元预算内拼接。分隔符、空段、截断标记和图片占位语义保持不变；文本超限后仍处理后续图片。此优化减少超大输出的临时字符串分配，不改变完整转录或模型上下文。

## 第三轮：历史列表和流式快照

`filterForkedParentSessions` 使用反向父关系和从叶节点出发的队列，替代固定点算法的反复全图扫描，复杂度为 O(V+E)。保留记录顺序、路径归一化、重复路径、自引用、纯环及数组引用语义。测试在两种记录顺序下对照旧算法穷举 4,096 种四节点关系图，并以操作计数验证长链线性增长。

流式助手快照原来先调用完整消息序列化，再重新转换一次 streaming content。现在共用助手元数据装配，只执行一次内容转换；仍保留流式不完整 marker 清理及稳定消息 ID。包含 `toJSON` 计数的测试防止工具参数恢复成双重转换。

可重复 CPU 基准：`node --import tsx scripts/benchmark-loading.mjs`。脚本仅使用合成数据，不读取用户历史或启动服务。一次本机 Node v25.9.0 的中位数结果：

| 合成场景                   |       原算法 |    优化后 |
| -------------------------- | -----------: | --------: |
| 512 节点 fork 链           |     5.661 ms |  1.291 ms |
| 2,048 节点 fork 链         |    71.937 ms |  3.761 ms |
| 8,192 节点 fork 链         | 1,548.894 ms | 14.819 ms |
| 100 次较大流式助手消息转换 |    17.837 ms |  9.284 ms |

fork 基准的旧算法针对预归一化单链重现原固定点传播，不包含路径归一化成本；流式旧路径对无 marker 的相同内容转换两次。结果用于说明算法规模趋势，不是完整会话加载时间，机器与并发负载会影响数值。

## 第四轮：历史打开分段诊断与分支解析缓存

设置 `PI_WEB_LOAD_TIMING=1` 后重启服务，打开历史对话时服务端控制台输出 `[load-timing]` JSON。默认关闭，关闭时不读时钟、不生成阶段数组。记录 outcome（loaded/reused/stopped/error）、totalMs 及 stages，各阶段 ms 为距离上个标记的增量：

- `resolve-and-ownership`：路径定位、归属检查和进入读取前的调度等待。
- `repair` / `sdk-open` / `branch-calibration`：转录修复、SDK 文件打开和分支校准。
- `preview`：预览提取、推送和预览后的调度等待。现有加载流程已经提供正文预览。
- `runtime-init` / `bind-session`：运行环境创建、会话切换准备和绑定。
- `workspace-and-settings`：工作区跟随和设置等同步调用。
- `snapshot-send`：服务端快照构造和同步发送调用，不含网络送达、客户端反序列化或绘制。

日志不包含会话路径、ID、正文，也不持久化额外的会话数据。复用、拦截和失败路径也有总耗时；尚未到达的阶段不会出现。这些是服务端观测值，不能直接当作点击到正文可见的时间。

`findBranchCandidates` 在每次调用内按节点对象缓存时间戳解析，避免多个叶子重复解析共同祖先。600 层共享链、80 个叶子的测试中，候选生成与叶子选择各自的 Date.parse 调用从 48,160 降至 680（约 -98.6%）。缓存不会跨调用保留，修改过的节点下次分析仍会重新读取。路径遍历、统计和全部 pathIds 的输出仍按各分支深度之和增长，整体未改成线性算法。

后续应结合这些日志与浏览器性能记录，分别测量冷启动、缓存命中、历史对话打开和已打开对话切换；目前没有宣称端到端秒数收益，也没有修改会话预览协议。

## 第五轮：左栏渲染与会话列表扫描

- **左栏不再随流式 token 重渲染**：`LeftPanel` 是 `memo` 组件，但 App 传入内联 `onOpenSandboxModal` 箭头函数，每个 `message_delta` 都让整棵项目树重新协调。改为 `useCallback`；`transition` 只传 `kind/target/progress` 的稳定子集，预览消息等字段变化不再波及左栏。
- **项目树数据模型 memo 化**：每项目的运行对话筛选、历史会话归属、未读统计从 JSX 内的 IIFE 抽到 `projectTreeModel`（`useMemo`）。运行对话按项目一次分桶；"是否有子代理" 用父 id 集合；"是否已落盘" 用按需构建的 sessionId 集合，替代 O(对话×会话) 的嵌套 `some`。`isSessionMatchingProject` 按项目缓存正则与规范化结果，不再逐会话 `new RegExp`。
- **切项目少一次整表请求**：点项目标题只发 `set_cwd`，由服务端 `refreshSessionsOnSwitch` 推送列表；展开项目时的 `list_sessions` 移出 state updater（StrictMode 下 updater 会执行两次）。
- **悬空工具调用修复加健康指纹缓存**：`healDanglingToolCallFile` 每次打开历史对话都同步整文件读取并逐行 `JSON.parse`，且此前没有缓存；现与 `repairSessionFile` 一样按 `mtimeMs:size` 记住健康文件，未变化时跳过读盘。
- **列表模式提前停止解析**：`loadSessionInfos(cwd, { listOnly: true })` 按 mtime 新→旧解析，凑够 260 条本项目会话即停（左栏展示 200 条，余量给 fork 父会话过滤）；缓存命中的文件照常纳入。冷列表成本从「项目内全部转录字节」降为「最新约 260 个文件」。缓存条目带 `complete` 标记，全文搜索、按 id 定位等需要全集的调用不会复用不完整缓存。单文件元信息 LRU 由 512 提至 2048，避免来回展开多个项目时互相挤出、反复全量重解析。
- **列表推送瘦身**：`SessionSummary.firstMessage` / `displayName` 截断到 300 字符（首条消息常是大段粘贴，原先每次推送 ×200 行 ×2 份）。全文检索走 `search_sessions`，不受影响。

测试：`tests/unit/dangling-tools.test.ts`（健康缓存命中与文件变化后重检）、`tests/unit/session-cache-bounds.test.ts`（列表模式提前停止、全集请求不复用不完整缓存）。

## 第六轮：打开历史对话的预处理与运行对话名额

### 预处理合并为一次异步读盘

`server/transcript-prepare.ts` 的 `prepareTranscriptForOpen` 替代原来的「链修复 + 悬空调用修复」两段同步流程：

- 两份健康指纹（`mtimeMs:size`）都命中：不读盘。
- 否则 `fs.promises.readFile` 读一次，两项检查共用文本；修复结束后按最终文件状态刷新两份指纹（悬空修复追加合成结果后，下次打开仍命中）。
- 悬空检查改为按需解析（`healDanglingToolCallsInText`）：先只取每行 id/parentId（长行只扫行首、且要求在第一个嵌套 `{` 之前），沿 parentId 从尾部回溯，只完整解析经过的行和尾部 assistant 之后的行。`lastId` 从尾部逐行完整解析确认，崩溃残留的半截尾行不会被误认。
- 语义与原流程一致：链修复改写文件时本次不做悬空修复；400 个随机转录（分支、aborted/error、长行、半截尾行）上与原全量算法结果逐一相同（`tests/unit/transcript-prepare.test.ts`）。

合成转录基准（`node --import tsx scripts/benchmark-transcript-open.mjs <MB>`，本机 Node v26.13.0，7 次中位数）：

| 场景                                 |   10 MB |    50 MB |
| ------------------------------------ | ------: | -------: |
| 悬空检查：原逐行完整解析             | 24.7 ms | 218.2 ms |
| 悬空检查：按需解析                   |  7.8 ms |  62.9 ms |
| 打开预处理：原两次同步读（均无缓存） | 71.2 ms | 514.5 ms |
| 打开预处理：新，指纹未命中           | 51.5 ms | 360.9 ms |
| 打开预处理：新，指纹命中             | 0.28 ms |  0.27 ms |

上游原流程的链修复有指纹缓存、悬空检查没有，所以「再次打开同一个未变化的大转录」原先仍要同步整读 + 逐行解析（10 MB 约 30 ms、50 MB 约 250 ms，期间阻塞所有客户端），现在约 0.3 ms。冷路径剩余耗时主要是 `repairSessionTranscript` 的 CPU 计算；SDK `SessionManager.open` 仍会再同步读一次（待评估能否传入已解析条目）。

### 运行对话名额：按 LRU 收起只查看过的历史对话

- 从历史打开的对话标记为 `viewOnly`；在其中发消息（开始投递 / 重试）即清除。
- 打开历史对话时，名额预检移到构建 agent runtime **之前**：原先达上限要先完整构建 runtime（扩展、技能、MCP）再 dispose，白白耗时。
- 超额时按 `lastActiveAt` 从旧到新收起 `viewOnly` 对话（不收当前对话、钉住、流式/压缩/投递中、终端在用、有存活子代理、有后台 run/唤醒订阅/后台任务的对话），仍腾不出才拒绝；收起会提示具体对话，转录在磁盘上，可从历史重新打开。新建对话走同一逻辑。
- 当前对话随后会被切走释放时（`wouldDisplaceActive`，与 `displaceActive` 共用 `isRetainedOnDisplace` 判定）计入一个名额；该判定只在确实超额时才评估（涉及磁盘探测）。

测试：`tests/unit/open-conversation-lru.test.ts`。

## 第七轮：预览→快照不再重挂载消息列表

打开历史会话时，浏览器先收到 16 条预览消息，runtime 建好后再收到首个快照。原先这两步的 `MessageList` key 不同（`transition.target` → `conversationId`），整列卸载重挂：滚动、实测高度、窗口化状态全部丢失，尾部 Markdown 渲染两遍，肉眼可见一次闪烁。而且即便 key 相同，预览消息的 id（`seq = 偏移 + i`）也与快照（每对话计数器）对不上，React 仍会重挂这些节点。

- **服务端：预览使用快照同款 id。** `previewWithSnapshotIds` 对 `buildSessionContext().messages`（SDK 正是用它初始化 `agent.state.messages`）加 `withHistoricalCompactions`（与 `messagesOf` 共用），走同一个 `uiMessageKey`，只序列化尾部。用户消息 seq 按全序列精确计算。建好对话后 `seedConversationIds` 把 `msgIds/nextMsgId` 与尾部序列化结果写入对话，首个快照直接命中缓存，尾部不再重复序列化。`msgIds` 按内容键映射，扩展在 bind 时追加消息也不改变已有 id。管理器不支持 `buildSessionContext` 时回退旧预览、不下发种子。
- **协议：** `transition_progress` 新增可选 `conversationId` / `sessionFile`（预分配的对话 id，仅在 id 一致时下发），`PROTOCOL_VERSION` 43 → 44。
- **客户端：** 预览态用预分配 id 作 key 与 `conversationId`，与快照相同，同一个 `MessageList` 实例原地接收快照。`MessageList` 用渲染期派生 state 识别交接（StrictMode 安全）：按会话首帧口径为更早消息预置占位、重置分页窗口（预览里已显示的尾部保持可见），且交接时预览中已挂载的消息不判为占位，由随后的 sweep 按实测高度决定。原地重置时受管元素表改为「只剔除不存在的 id」，不再整表清空（稳定 ref 回调不会为原地保留的节点重新注册）。

测试：`tests/unit/preview-snapshot-ids.test.ts`（预览 id 与快照一致、种子不改变任何 id、同时间戳用户消息、历史压缩卡、system 消息、回退路径）；`tests/unit/message-list-preview-handoff.test.ts`（jsdom：交接后尾部 16 条零卸载、DOM 节点为同一实例，更早消息未全量挂载；对照组换 key 时整列重挂）。

尚未在真实浏览器里对大会话做端到端验证（滚动位置与图片/代码高亮的滞后高度），需要人工确认。

## 第八轮：左栏交互体验

- **项目排序**：每次加载（刷新页面）按最近使用（`lastUsed`）新→旧排序；页面打开期间保持稳定（切换工作区不跳动），会话期间新出现的项目追加到末尾。可拖拽项目头或在项目头上按 Alt+↑/↓ 调整本次会话内的顺序。废弃原 `pi-web-ui:projects-order` 持久化排位（加载时清理残留键）。
- **项目上限**：最近项目由 30 提到 100（`RECENT_PROJECTS_MAX`，记录、合并读取、推送共用；DSH 引擎同步）。
- **过滤框**：项目区顶部过滤项目名 / 路径 / 已加载的对话标题；项目名命中照常显示，否则只显示命中的对话并展开；Esc 清空，↓ 进入列表。未加载会话列表的项目（未展开且无缓存）只能按项目名命中，全文检索仍走全局搜索。
- **键盘与无障碍**：`role="tree"` / `treeitem` + `aria-expanded` / `aria-current`；↑/↓ 行间移动、Home/End、→/← 展开收起、会话行 ← 回到项目头。重命名时行主体渲染为 div（不再把 input 嵌进 button）；「显示更多」「已收起 N 条历史」改为 button；仅悬停可见的行内操作在键盘聚焦时同样显示，并有 `:focus-visible` 描边。
- **重命名**：失焦即提交（原先失焦直接丢弃输入）；提交后立即乐观显示新名字，服务端列表体现后撤销覆盖（10s 兜底过期）；Enter 后卸载触发的 blur 不重复提交，Esc 取消不提交。
- **i18n**：左栏硬编码中文（显示更多、已收起、分支 / 调度 / 微信 / 飞书 / 钉钉徽标、电脑端打开提示）移入字典并补齐 12 个语言包；三处重复的标题分类逻辑合并为 `categorizeTitle`。
- **运行列表推送**：`emitConversations` 每次对每条对话的 `existsSync + statSync` 改为一次 `statSync` 并按文件缓存 2s（保持同步发送，不改变与快照的消息先后顺序）。

测试：`tests/unit/left-panel-stage-d.test.ts`（排序 / 拖拽 / Alt+方向键、过滤、键盘导航、tree 语义、重命名失焦提交与去重）。

## 第九轮：会话列表扫描（字节级 + 增量）与流式过滤器

### 列表元信息：`server/session-list-scan.ts`

`scanSessionListInfo` 取代列表模式的 `parseSessionInfoFast` 实现（后者列表模式直接委托给它，全文模式不变）：

- 按字节读取、按换行字节切行；已拿到 id 与首条用户消息后的长行（> 512 字节、不含 `"session_info"`）不解码成字符串，只看行首判断 message 并用 `Buffer.indexOf` 找第一个数值型 `"timestamp"`，规则与原实现一致。
- 需要完整解析、且超过 64K 字符的行先剔除内嵌 `"data":"…"`（base64 图片）再 `JSON.parse`。
- **增量**：状态记录最后一个完整行之后的字节偏移，以及文件头 128 字节和偏移前 64 字节两处指纹。`loadSessionInfos` 把状态存进单文件元信息缓存；文件 mtime/size 变化时带着状态续扫，两处指纹都未变才只解析新增字节，否则整份重扫（链修复改写、截断等）。末尾未写完的半行计入本次结果但不推进偏移。
- 等价性：300 个随机转录（长行、base64 图片、改名、坏行、CRLF、末尾半行）上与原实现逐字段相同（`tests/unit/session-list-scan.test.ts`，含增量 / 改写 / 截断 / 半行用例）。

合成转录基准（`node --import tsx scripts/benchmark-session-list.mjs <MB>`，本机 Node v26.13.0，5 次中位数）：

| 场景                            |    10 MB |      50 MB |
| ------------------------------- | -------: | ---------: |
| 原实现（逐字符过滤 + 字符串行） | 259.6 ms | 1,328.8 ms |
| 字节级全量扫描                  |  44.0 ms |   208.7 ms |
| 追加一轮对话后增量续扫          |  1.58 ms |    1.88 ms |

活跃会话每轮结束都会让列表刷新重扫它；原先这一步随转录大小线性增长，现在与已有长度无关。

### 流式过滤器：`BinaryStringFilter`

`sessionLines`（全文搜索等仍走它）里剔除 base64 的过滤器原为逐字符状态机（每字符一次数组 push、字符串外每字符一次正则）。改为正则跳跃：字符串内直接跳到下一个引号 / 转义 / 换行，字符串外跳到下一个非空白字符，普通字符整段切片输出；状态转移不变。2,000 个随机 JSONL 文本、随机分块（含切在转义符、引号、代理对中间）上与原实现输出逐字节相同（`tests/unit/session-scan-filter.test.ts`）。10 MB 文本过滤：391.0 ms → 95.2 ms。

## 第十轮：打开会话不再阻塞事件循环；会话列表服务端分页

### 异步分时片打开（`server/session-open.ts`）

`switchSession` 里的 `SessionManager.open`（同步 readSync 读完整个转录 + 同步逐行 JSON.parse）改为 `openSessionManagerAsync`：`fs.promises.readFile` 异步读取，逐行解析每约 8 ms 让出一次事件循环，再把解析好的条目交给 SDK 构造。SDK 本身在超大头部时也走这条 `preloadedFileEntries` 构造路径。

- 语义对齐 SDK `loadEntriesFromFile`：空行和坏行跳过，只收真值条目；首条必须是带字符串 id 的 session 头，否则交回 SDK 原路径（空文件初始化、非 pi 会话报错）；文件末尾缺换行时在构造前补 `"\n"`。
- SDK 构造函数在类型上是 private：按运行时签名调用，构造后核验会话文件、会话 id、条目数；任何一步不符或抛错都回退 `SessionManager.open`。`PI_WEB_ASYNC_SESSION_OPEN=0` 可强制原路径。已核对自带 SDK 1.1.0 与本机全局 1.5.0 的签名相同，两者都走预解析路径（0 次回退），结果与 `SessionManager.open` 一致（条目、叶子、分支、文件副作用）。
- 合成 50 MB 转录（`node --import tsx scripts/benchmark-session-open.mjs 50`，3 次中位数）：

|                           | 总耗时 | 事件循环最长停顿 |
| ------------------------- | -----: | ---------------: |
| `SessionManager.open`     | 192 ms |           192 ms |
| `openSessionManagerAsync` | 239 ms |            21 ms |

总 CPU 略增，但打开大会话期间其他客户端的流式输出、心跳和操作不再被卡住。

### 会话列表分页（B5）

- 协议（均为可选、向后兼容；本批已 bump 到 v44）：`list_sessions` 加 `limit`（希望拿到的总条数），`sessions` 加 `hasMore`。
- 服务端按项目记住 `limit`（`setSessionListLimit`，夹在 [200, 5000]），之后每轮对话后的自动刷新沿用它，已展开的列表不会缩回 200。`loadSessionInfos` 的列表模式按 `limit + 60` 提前停止解析。缓存记录这份列表是按多少条的需求解析的（`parsedFor`），需求更大时不复用。`hasMore` = 摘要多于 limit，或解析提前停止（还有未解析的旧文件）。
- 客户端：reducer 按项目记录 `projectSessionsHasMore`。「显示更多」在本地余量用完、且服务端还有更多时，以下一页的 limit 请求，按钮显示加载态。每个项目展开到的条数持久化（`pi-web-ui:lp-visible-counts`），刷新或展开项目时按此前条数请求，超过 200 条的会话不再只能靠全局搜索找到。

测试：`tests/unit/session-open-async.test.ts`（与 `SessionManager.open` 逐项一致、预解析路径不回退、可继续追加写入、非法 / 空文件回退、开关、解析期间让出事件循环）；`tests/unit/session-list-paging.test.ts`（翻页、hasMore、limit 记忆与夹取、reducer）；`tests/unit/left-panel-stage-d.test.ts` 新增 B5 用例（向服务端翻页与加载态、本地余量不发请求、条数持久化后按条数请求）。
