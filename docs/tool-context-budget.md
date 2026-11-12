# 工具上下文预算（tool context budget）

> 模型每轮都要吞下「全部活跃工具」的名字 + 完整参数 schema。工具一多，这是几万字符的
> **固定开销**（哪怕这轮只用 bash）。本文档记录压这块开销的四条手段、各自的取舍，以及
> **延迟加载为什么不会打坏供应商的前缀缓存**（这是实现里最容易踩坏的一条）。
>
> 相关代码：`server/load-tools-tool.ts`（按需加载入口）、`server/tool-manager.ts`（门控 +
> `lazyLoadingDisabledTools`）、`server/prompt-composer.ts`（提示词目录段）、
> `server/tool-prompt-overrides.ts`（逐工具文案覆盖）、`server/agent-service.ts`
> 的 `applyToolGating` / `lazyToolCatalog` / `promptToolCatalog` / `loadLazyTools`。

## 请求级只读结果去重

`server/request-context.ts` 通过 SDK `context` 事件构造本次请求视图，不改写 SDK 历史、磁盘转录或 UI 消息。仅对 `read` / `grep` / `find` 中参数与纯文本输出完全相同、输出序列化长度至少 4096 字符的成功结果去重。保留首次全文及全部 tool call/result 配对，后续结果引用首次调用 id；错误、图片、带额外字段的文本及无对应调用的结果保留原样。

每次请求从当前上下文重建引用，不保存跨请求索引，因此压缩删除旧证据后会自动保留新的首次全文。用户介入、修改工具或未知工具（包括 codemode / 插件）调用与结果均清空证据索引；混合读写批次不建立索引。同一查询只与最近一份有效全文比较，内容变化、错误、小结果、图片或结构化结果都会使该查询的旧证据失效，防止内容 A → B → A 时跨版本引用。去重仅向后引用，不因后续消息重写较早的去重结果。不改写 SDK 历史或原有软上限压缩口径。

### 大输出持久证据

仅 pi 引擎接入。持久会话且 `read` 活跃时，按当前模型窗口的 70% 减去系统提示、活跃工具 schema 及输出预留估算消息预算（字符 / 3，非供应商精确 tokenizer）；预算不足才从较早输出开始外置，最近两条工具结果保留全文。成功的纯文本 `read` / `grep` / `find` 结果达到 24000 字符后，保存至 `<session.jsonl>.evidence/<sha256>.txt`，请求中保留前后各 3000 字符及可用 `read` 分页读取的稳定标识 `context-evidence:<sha256>`。`read` 在进入 SDK `tool_call` 与宿主权限守卫前将标识解析为当前 SDK 会话证据目录下的文件路径；不增加工具 schema，不绕过既有读取实现。原始历史保持不变；不处理错误、图片、签名文本和结构化结果。临时会话及 SSH 工作区保留全文（远程 `read` 无法读取服务端本地证据路径）。

证据文件按会话隔离、以内容寻址，已有文件必须内容校验通过；先写临时文件再以排他硬链接提交，成功后才替换请求内容。使用有界分块读取、文件句柄检查及摘要校验，拒绝符号链接和超限内容；取消贯穿队列与 I/O，取消不回退成正常请求。同一会话的校验、预算检查与写入串行执行，避免并发突破额度；不同会话互不阻塞。单文件最多 1MiB，会话目录在写入前检查 64MiB 预算；失败或超额均保留原文。证据无自动过期；通过宿主删除会话时，在删除转录后按同一写入队列清理证据目录，迟到写入因转录不存在而回退原文。清理失败会反馈删除失败。随会话转录一起备份或迁移；仅复制 JSONL 不会携带证据目录。未压缩的原始工具输出仍在转录中，因此分支或迁移后的请求可在新会话位置重建证据；新稳定标识在携带证据目录迁移后可从新会话位置解析；旧版本已经进入压缩摘要的绝对路径仍需要原证据目录可用。pi 宿主的消息分支与编辑重问入口会在继续执行前校验并复制父会话证据，子会话独立持有文件，删除父会话不影响子会话。复制失败会反馈操作失败；未发布分支清理转录与资源，编辑重问在复制失败后恢复原会话。外部只复制 JSONL 而没有证据目录时，摘要中的证据仍不可用。证据路径仍受现有 `read` 权限校验，不提供额外 HTTP 下载入口。请求仍携带原始历史供 SDK 压缩统计，因此这不会降低 SDK 的压缩触发水位。

### 压缩任务状态与证据索引

`server/compaction-instructions.ts` 在 SDK 默认压缩链路统一追加保留要求：目标、用户约束、已验证事实及证据、实际修改、验证结果、未决问题与下一步。保留 SDK 自带摘要格式，区分假设与事实、自述摘要与原始证据，不另起模型请求。覆盖手动、软上限与默认自动压缩；扩展直接提供的自定义摘要仍由扩展负责。

摘要生成后、持久化前确定性附加证据索引，最多列 32 个稳定引用，完整列表可通过 `read({path:"context-evidence:index"})` 获取。索引只含文件名，不注入正文，避免压缩时模型看不到请求投影中的引用而遗忘证据。

SDK 没有自动压缩指令及权限前别名解析的公开接口，分别用 `installCompactionInstructions` 和 `installEvidenceToolHooks` 的私有接口适配器，检查结构与参数个数，幂等安装；SDK 不兼容时保留默认行为。这些适配器需要随 SDK 升级回归验证。

软上限自动压缩的自定义指令可通过设置项 `autoCompactionInstructions` 传入（空 = 不传，保持 SDK 默认摘要）：扩展可借此让 `session_before_compact` 钩子接管自动压缩的摘要生成，无需修改宿主源码。只影响自动压缩；手动 `/compact` 与 AI 的 `compact_context` 仍各自传自己的指令。证据目录仍需随转录迁移，旧绝对路径不自动改写。

验证：`tests/unit/request-context.test.ts`、`context-evidence.test.ts`、`compaction-instructions.test.ts`、`evidence-tool-hooks.test.ts`、`context-integration.test.ts`。

## 1. 一块开销有多大

以 30 个目录/核心工具为例（设置页「查看工具 schema」能看到实时数字）：

| 组成                                           | 约            |
| ---------------------------------------------- | ------------- |
| 工具文字（description + snippet + guidelines） | 11.3k 字符    |
| 参数 schema（JSON，含参数说明/枚举/默认值）    | 18.6k 字符    |
| **下发工具 schema 合计**                       | **~33k 字符** |

参数 schema 是结构化的**契约**（枚举、默认值、范围、逐 action 语义），删了模型就会传错参数，
所以「抠字」这条路的下限很低（实测全量收敛后只能再降 ~11%）。

## 2. 四条手段

### 2.1 文案精简（已做）

见 `AGENTS.md` 的「工具提示词三处职责分离」。description = 做什么 + 副作用；snippet = 触发
条件（≤80c）；guidelines = 何时用/顺序/禁止。同一件事只说一遍，守卫
`tests/unit/tool-prompt-hygiene.test.ts` 机器把关。

### 2.2 逐工具文案可编辑（已做）

设置 → 工具区「编辑文案」：`description` / `promptSnippet` / `promptGuidelines` 都能覆盖，
留空 = 用出厂默认。存在 `ClientSettings.toolPromptOverrides`，打补丁落在 SDK 合并后的
`_toolRegistry` 上（核心内置 / 本项目工具 / 插件 / MCP 一网打尽）。见
`server/tool-prompt-overrides.ts`。

### 2.3 延迟加载（本机制，**默认关**，可开；名单制）

开：`load_tools` 常驻；只有**按需名单**（`ClientSettings.toolOnDemandTools`，见 §2.6）里的工具才走延迟——
它们在系统提示词的 `{{tools}}` 段里只有**名字 + 一行摘要**（目录），参数 schema 不进上下文。模型
要用时先调 `load_tools(["patch","lsp"])`，那批工具被激活，schema 才随之下发。
名单外的工具（含核心工具 `bash` / `read` / `edit` / `write`）按开关/预设常驻可用；名单为空时等于都不延迟
（此时 `load_tools` 也不挂载、`{{tools}}` 段整段不输出，见 §3）。

- 开关：设置 → 工具区「工具按需加载」（`ClientSettings.toolLazyLoading`，**出厂默认关**，即 `load_tools` 总闸）。
  默认关的理由：模型忘加载会先吃一次 `Tool <name> not found`（SDK 只认已声明集），开箱
  即用优先；需要省上下文的实例自己打开，部署级默认可用环境变量 `PI_WEB_TOOL_LAZY_LOADING=1`
  / `true` / `on` / `yes`（只作默认值，用户已存盘的设置优先）。
  关着 = 按开关/预设直接全部活跃（与 pi 命令行一致，名单无效果）。**只影响新会话与之后的门控重放**——
  不会把正在跑的对话里的工具反向清空。
- 门控实现：延迟加载**不引入第二条门控路径**。未加载的名单工具 = 临时加进禁用名单
  （`lazyLoadingDisabledTools(all, loaded, core, onDemand)`，`only` 即名单），走的还是 `applyAgentToolsGating` 那条链。加载只是把
  名字从名单里拿出来。
- `load_tools` 是**常驻脚手架工具**，不入 `AGENT_TOOL_CATALOG`（不能单独关掉它，只能用总开关控制有无），
  由 `applyAgentToolsGating` 的 `forceActive` 保证在非 standard 预设下也在活跃集里
  （`ask` 预设本来就无工具，不强加）。
- 已加载集合按 **session 对象**存（`WeakMap`）：过户搬的就是 session 本体，集合跟着走；
  会话从转录恢复时用当时的活跃集做种子（只记住名单里的，上次加载过什么就还是什么）。
- 加载会**拒绝**：未知名字 / 不在名单里（常驻直接调） / 已被用户关闭 / 当前预设不允许 / 计划模式闸门拦截 / 已经加载过
  —— 原因写回工具结果，模型能自己纠正。
- **模型忘记加载、直接调用目录里的工具**（JIT 自动激活）：SDK 在解析工具之前就派发了
  `tool_execution_start`，随后因该工具不在活跃集回一条 `Tool <name> not found`；服务端在
  这个事件里把该工具补进已加载集**并立刻重放门控**，于是它从下一轮起真的活跃 —— 模型原样
  重试即成功，不必先绕道加载别的工具（issue #652）。
- 「已经加载过」按**活跃集**判断，不只看已加载集合：只标记不激活的半吊子状态会被当成
  重新加载并修正，而不是回一句「已经加载过了」把模型堵死（同 #652）。
- DSH 引擎没有 pi 工具注册面，不适用（设置行不显示，协议字段恒为 false 占位）。

### 2.4 共享子 schema 单源（大工具专用）

一个问题对象曾经在 `ask_user_question` / `communicate` / `conversation` 各抄一遍
（`preview` / `recommended` / `dependsOn` / `optionsMap` 这套富交互字段），下发给模型
就是同一段结构的三份拷贝，改字段还得改三处。现在统一在 `server/question-params.ts`：

- `richQuestionsSchema()`：富弹窗的全量字段（`preview` / `dependsOn` / `optionsMap` 这些弹窗专属能力的事实源）；
- `askQuestionsSchema()`：`ask_user_question` 下发给模型的派生视图——去掉弹窗专属字段与装饰关键字，模型只看到「问什么、给哪些选项」，字段定义仍只有富档一处；
- **跨对话工具不再声明问题/回答结构**：`communicate` 的 `request`/`reply` 与 `conversation`
  的 `consult`/`answer` 只收纯文本 `message`，结构化提问只留在 `ask_user_question`。
  服务端在状态机入口（`server/conversation-communication.ts` 的 `questionsFromMessage()` /
  `answersFromMessage()`）把文本折成内部结构：问题包成 `[{ id: "q1", question: message }]`，
  回答按待答问题展开成 `{ id, selected: [], custom: message }`。旧的结构化
  `questions`/`answers` 仍然照收（TypeBox 不写 `additionalProperties: false`），由
  `checkQuestions`/`checkAnswers` 原样校验后转发——**能力不减，只是不再付费下发结构**。

同期收紧同一批大工具的文案冗余（实测，字符数含 description/snippet/guidelines，括号内为参数 schema 本体）：

| 工具           | 前                | 后                | 手段                                                                                                            |
| -------------- | ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `conversation` | 4785（参数 4505） | 1998（参数 1718） | 结构化问题/回答结构下线、逐参数文案清零、`enum` 取代 `anyOf`、边界校验移进 handler、action 用一行签名管全部参数 |
| `communicate`  | 2217（参数 1418） | 1266（参数 467）  | 同上：`questions`/`answers` 下线、`enum` 取代 `anyOf`、`minLength`/`min/max` 移进 handler                       |

判断标准：参数 schema 是契约，字段类型与 `enum` 不能删；能删的是**同一段结构/同一句话的
第二份拷贝**、逐字段的 description（改成 `action` 字段里一行紧凑签名）、机械边界
（`minLength`/`minItems`/`minimum`/`maximum`，一律搬进 handler 用 `Math.min/Math.max` 兜底），
以及 description 里的「何时用」（那是 snippet 的职责）。另一条路是彻底不付这笔钱：把这两个
工具交给延迟加载（§2.3），代价是模型多一步 `load_tools`。

同一套标准现在覆盖全部常驻工具（`read` / `bash` / `edit` / `write` / `ask_user_question` /
`browser_page` / `claim_files` / `present_files` / `skill` / `grep` / `find`）：导出 schema 只剩
字段名与类型，候选值写 `enum`（`browser_page.op` 的签名一句话交代每个 op 要哪些参数），逐字段
说明只留真不自解释的五个（`read.offset`、`bash.timeout`/`persist`、`edit.soft`、
`present_files.items[].focus`、`skill.name`）。`write` / `grep` / `find` 的实现仍是 SDK 内置，只是
文案与 schema 由 `server/tool-prompts.ts` 换掉（`withSlimPrompt()`），字段名与 SDK 定义的一致性由
`tests/unit/tool-schema-slim.test.ts` 盯住。后续把同一把尺子推到其余 15 个宿主/SDK 工具与 `sftp`
插件（§2.5）。`codemode` 的 description 由 SDK 按每轮 loadout 现算（内含 `tools.<name>` 声明），
宿主不覆盖它，预算由 `codemodeInlineBudget` 控。

### 2.5 低频/大工具同样脱水（第二批，实测 −37%）

同一套标准此前只落在 11 个常驻工具上，其余 15 个宿主/SDK 工具 + `sftp` 插件没人守，于是又长回来了：
`action` 用 `Type.Union([Type.Literal…])` 展开成 `anyOf` 的 const 数组、`Type.Record()` 展开成
`patternProperties`、`minimum`/`maximum`/`minLength` 全在、逐字段说明复述一遍 action 语义。

现在按同一把尺子收敛（实测字符数：description + snippet + guidelines + 参数 schema 本体）：

| 工具              | 前   | 后   | 手段                                                                                             |
| ----------------- | ---- | ---- | ------------------------------------------------------------------------------------------------ |
| `canvas`          | 2946 | 2516 | 24 项 `action` 的 `anyOf/const` → `enum`；`Type.Record()` 的 `patternProperties` → `type:object` |
| `mcp_manage`      | 2777 | 1436 | 3 处 `anyOf` → `enum`、`env`/`headers` 的 `patternProperties` 下线、14 条字段说明 → 1 行签名     |
| `sandbox`         | 2245 | 1020 | 2 处 `anyOf` → `enum`、8 条字段说明清零                                                          |
| `delegate_task`   | 2139 | 1554 | 7 个必填字段的说明搬进 `promptGuidelines`（字段契约不变，只换陈述位置）                          |
| `terminal`        | 2131 | 1274 | `anyOf` → `enum`、`minimum`/`maximum`/`minLength` 搬进 `create` 的 `Math.min/max` 兜底           |
| `schedule`        | 1685 | 881  | 逐字段说明清零，只留 `schedule` 的 cron/延迟一句                                                 |
| `worktree`        | 1525 | 963  | 2 处 `anyOf` → `enum`/`type:["boolean","string"]`、7 条说明清零                                  |
| `lsp`             | 1526 | 803  | 8 条字段说明 → 1 行 action 签名、`minimum/maximum` 清零（handler 已 `Math.min/max`）             |
| `patch`           | 1295 | 1114 | `minimum/maximum` + 2 条说明清零（description 是 Hashline 语法本体，保留）                       |
| `plan_update`     | 1121 | 771  | 6 条字段说明清零                                                                                 |
| `compact_context` | 1065 | 694  | `minimum/maximum` 清零（`calculateEffectiveKeepRecentTokens` 已夹紧）、只留 `focus` 一句         |
| `eval`            | 882  | 492  | `minimum/maximum` 清零（handler 已夹紧）、只留 `timeout`/`reset` 两句                            |
| `powershell`      | 590  | 252  | 同 `write`/`grep`/`find`：SDK 实现 + `withSlimPrompt()` 换文案与 schema                          |
| `ls`              | 422  | 180  | 同上                                                                                             |
| `sftp`（插件）    | 4851 | 2807 | 24 条字段说明 → 1 行 action 签名 + 6 条凭据字段的关键提示；`manifest.json` 0.4.8 → 0.4.9         |

合计 **27.9k → 16.9k 字符（−39%）**；当时出厂默认常驻的那 9 个（`ls` / `patch` / `delegate_task` /
`sandbox` / `worktree` / `plan_update` / `compact_context` / `schedule` / `canvas`）**14.5k → 9.7k
（−33%，约省 1.3k tokens/轮）**。

> 后续产品决定（见 `server/tool-manager.ts` 目录）：`ls` / `patch` / `delegate_task` / `sandbox` /
> `worktree` / `canvas` 均改为 `defaultOn: false`。出厂默认常驻的只剩 `plan_update` /
> `compact_context` / `schedule` 三个，上表的「出厂默认常驻」口径按此收窄；`ls` / `patch` 等工具
> 的 schema 瘦身成果仍在，用户显式打开后照旧受益。

**这一批刻意没做的事**（都量过代价，结论是负收益）：

- **不删工具**。`powershell` / `eval` / `lsp` / `terminal` / `mcp_manage` / `tool_search` 出厂
  `defaultOn: false`，在默认口径里本来就是 0 字符——删掉只丢能力不省预算；`ls` / `patch` /
  `delegate_task` 是 `defaultOn: true` 的产品面（`tool-manager.ts` 目录 + 设置行 + i18n + 守卫单测），
  删的是功能不是开销。`patch` 的 926 字符 description 是 Hashline 语法契约本身（`[path#TAG]`/`PUT`/`CUT`），
  删了模型就写不出补丁；`delegate_task` 的 7 个必填字段是反「含糊派单」的校验契约，改成可选就把
  `validateDelegation()` 的失败模式放回来了——所以只搬陈述位置，不动必填性。
- **不合并 `sandbox` + `worktree`**。两者都是「换 cwd」，但一个是 CoW 工作区、一个是 git 分支隔离，
  合并只省约 1.2k 字符（~330 tokens），代价是两套 service/审批/设置行/权限闸门并成一套 15 项 action 的
  混合枚举，且违反「一个能力一个工具名」。
- **不改默认开关去「延迟加载」它们**（当时结论）。延迟加载已经由 §2.3 的全局开关提供；把 `canvas` /
  `sandbox` / `schedule` 这类主打功能默认改成待加载，是产品决定，不是预算优化的顺带结论。后来的
  产品决定是**直接默认关闭** `ls` / `patch` / `delegate_task` / `sandbox` / `worktree` / `canvas`
  （目录 `defaultOn: false` + 出厂设置 `disabledAgentTools` 同名单），理由不再是预算，而是默认工具面
  收窄；`plan_update` / `compact_context` / `schedule` 仍默认开。

守卫：`tests/unit/tool-schema-slim.test.ts` 现在把上面 21 个工具全部纳进来（含 `patternProperties`），
任何一条装饰约束、任何一个白名单外的字段说明都会红。

### 2.6 按需名单：延迟范围统一注册表（内置 + 插件自动合并）

§2.3 的延迟加载是**名单制**（只有名单里的才延迟，模型再调 `load_tools` 拉回来）。名单外的常驻，
名单为空等于都不延迟。

`toolOnDemandTools`（设置 → 工具区「按需工具列表」，协议字段与预设字段同名）就是这份延迟名单：

- **列进去 = 延迟**。开关开着时：不激活、参数 schema 不进上下文，模型需先调 `load_tools` 拉取（加载后本对话后续常驻），也会被 JIT 自动激活；
  开关关着时名单无效果（全部按开关/预设常驻）。`isNeverLazyTool()`（核心 4 件套 + `load_tools`）永不延迟，前后端共用同一语义。
- **统一注册表，不写死**。`TOOL_NAME_PATTERN` + `foldLegacyToolName()` + `isValidToolName()` 是唯一命名口径（见 `server/tool-manager.ts`）：
  内置直接收，插件 / MCP / 未来工具按正则收，孤儿项（插件已卸载/跨设备）保留防丢；旧别名自动折叠。
  前端库存见 `web/src/tool-inventory.ts`（`buildOnDemandOptions`）：内置目录 + 实时插件库存 + 孤儿兜底，
  所有工具管理 UI 都从此库存派生，不再手写 `[...AGENT, ...CORE]`。
- **划分单源**。`partitionLazyTools({all, allowed, onDemand, loaded})` 一次算出 `{resident, pending, loadedLazy}`，
  门控/目录/加载/JIT/提示词基线共用同一划分；`disabledToolSet()` 收敛计划/委派/子代理闸门，`loadLazyTools` 不再手写第二份。
- **不再硬关闭**。`effectiveDisabledAgentTools()` 不再并入名单，常驻/禁用只由 `disabledAgentTools`（内置）+ `disabledPluginTools`（插件，注册层过滤）+ 预设与模式闸门决定。**没有第二条门控路径**——
  `applyAgentToolsGating` / `allowedToolNames` / 提示词目录读的都是同一套允许集，延迟只是临时加禁用（`lazyLoadingDisabledTools(..., onDemand)`）。
- 与 §2.3 的关系：开关是 `load_tools` 总闸（开才有该工具），名单决定延迟范围（含插件）。DSH 引擎不适用（无 pi 工具注册面，设置行不显示）。
- 守卫：`tests/unit/tool-manager.test.ts`「按需名单 + 架构单源」用例钉住命名规则/别名/划分/孤儿保留；`tests/lazy-tools-test.mjs` 开关打开后先写名单再建会话。

## 3. 硬约束：不能打坏前缀缓存

供应商的 prompt cache（Anthropic `cache_control`、OpenAI/DeepSeek 自动前缀缓存）是按**前缀**
命中的：只要这一段和缓存过的完全一致就命中，哪怕后面追加了新内容。所以我们只允许**追加式**
变化，绝不允许「中间改一个字」。

延迟加载天然踩这个坑：直观实现会把「已加载」的工具从目录段挪到「活跃工具」段——目录段一
变，系统提示词就变，整段缓存报废。**本实现刻意规避**：

1. **系统提示词与已加载集合无关**。`{{tools}}` 在延迟加载下只列**按需名单**（
   `promptToolCatalog()`：注册表顺序，**不过滤已加载**）且**不列常驻工具**——常驻工具的 schema 已全量
   下发，重复列只是白花 token；段首一句恒定**纯英文**精简说明（`On-demand tools (schema not attached — call load_tools with the names first):`，不进双语，与工具提示词口径一致）。
   名单为空时这一段整段不输出（没有可加载的工具，`load_tools` 也不挂载）。
   加载前后逐字节相同（只随设置/预设变，不随加载变）。
2. **guidelines 只取常驻**。延迟加载下系统提示词的 Guidelines 段只含常驻工具（允许集 - 名单，含核心 +
   `load_tools`）的要点；被加载工具的要点**随 `load_tools` 的回执文字**进对话（追加，不是
   改前缀）。
3. **tools 数组只追加**。加载只产生 `toolsAdded` 增量（SDK 的 `getToolStateChanges`），
   不会出现 `toolsRemoved`/redefinition；支持中途工具变更的供应商（Anthropic
   `defer_loading`、OpenAI `additional_tools` / `tool_search`）会把新增工具**锚在初始声明
   上**流式注入（`resolveTranscriptTools` 的 `anchorsAdditions`），其余供应商把当前列表
   原样下发，也是「旧前缀 + 新尾巴」。
4. **顺序稳定**。目录与基线名单都按注册表顺序生成，同一设置下重复渲染结果一致。

回归：`tests/lazy-tools-test.mjs`（零 token，mock LLM）直接断言
「加载前后 system 文本**逐字节相同**」与「第二次的 tools 以第一次为**前缀**」，并覆盖
「模型直呼未加载工具 → 该工具自动激活 → 原样重试成功」这条 JIT 路径（#652）。

⚠️ 会破坏缓存的操作（都在我们的控制面内）：改 `toolPromptOverrides`（工具定义变了 →
redefinition）、关掉某个工具（`toolsRemoved` → 该对话之后只能走非锚定路径）。这些是用户
主动操作，一次性代价可接受；但**不要**在自动化路径里改这些。

## 4. 换来的收益与代价

（都是**开启**这个开关之后的口径；出厂默认关，所以下面是「想省上下文时才付的代价」）

- 收益：常驻 schema 取决于名单大小——名单把重量级工具都收进来时 33k → **~7k**（核心工具 + load_tools + 名单外常驻）。名单里的工具体用不到就永远不进上下文；
  系统提示词本身也从 ~8.6k 降到 ~6.7k（guidelines 只剩常驻）。名单为空时开关等同关闭（既不延迟、也不挂 `load_tools`、不出按需段），记得先勾名单再开开关。
- 代价：模型多一步「先加载再用」。目录（名字 + 一行摘要）仍常驻，发现性不丢；加载失败会
  写明原因。弱模型可能忘记加载——所以这个开关**出厂默认是关的**（见 §2.3）。
  另外目录**不重复列常驻工具**（尤其核心 4 件），它们的 schema 本来就在 `tools` 里。
