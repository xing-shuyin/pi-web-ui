# 目标模式 2.0 设计：把「目标审查」变成对话

> **状态**：**已实施，且只剩一条路径**。目标模式 2.0 = 服务端驱动 + 执行对话干活 + **当前对话当审查者**（本文的 Plan A，下文简称「执行对话模式」）。v1 的隐藏隔离审查会话与自治标记路径（`runGoalReview` / `isAutonomous` / `GOAL_COMPLETION_RE`）已按产品决策**删除**；Plan B（审查者=角色子代理）与 `reviewMode` 开关**不再实现**。实施细节与偏差见 §11。
> 关联：#385（AI 提炼超时，已有 PR #386 待合）、#389（Goal & Plan，本设计可与之 Phase 1 合流）。
> **修订记录**
>
> - **v2.2（本次）**：**只保留新模式** —— 删除 self 路径与模式开关（协议去掉 `reviewMode`；`GoalStatus.reviewModel` 字段名保留给 DSH，pi 侧语义改为「调研模型」）；缺角色桥 / 建不出执行对话 = 拒绝或中止，**没有降级路径**。见 §11.2 表末三行。
> - **v2.1**：Plan A 实施完成 —— 与 v2 设计的差异、文件/函数地图、验证结果与已知遗留见 §11。
> - **v2**：把 v1 的 A/B 两案收敛成**同一台服务端循环**的三种配置（§4），A 案改为「服务端跑完执行轮、主对话只做审查」；只读改用现成 `permissionPreset` + 模板扩展白名单，**砍掉新增模板 `tools` 字段**；角色对话默认 `persist=false`；补 5 处事实纠正（§2）+ 失效矩阵（§4.6）+ 决策结论（§6）。
> - v1：Plan A（主对话=审查者）/ Plan B（主对话=执行者）两案并列。

---

## 0. 现状与痛点

今天的「目标模式」是一条**单向的、服务端编排的自动化流水线**：

```
GoalBar 设目标
  → setGoal 注入一条 user 消息「【目标已设定】…请开始实现」   （goal-service.ts setGoal）
  → 主对话执行
  → agent_end 钩子                                            （agent-service.ts:5086）
  → runGoalReview 拉起一个【隐藏的、inMemory 的隔离会话】        （goal-service.ts:1148）
       · 喂：目标文本 + 主对话最后一段输出 + git diff（截 60k，GIT_DIFF_CAP）
       · 要它只回 {"verdict":"pass|fail","feedback":"…"}
  → pass：清空目标；fail：把 feedback 当成普通 user 消息打回主对话
```

痛点（都指向「审查不是对话」）：

| #   | 痛点                                      | 根因位置                                                                                                                                                       |
| --- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **审查过程完全不可见**                    | 隔离会话 inMemory、不落盘、左栏无入口，用户只能看到一句「审查中（第 N 轮）」                                                                                   |
| 2   | **审查每轮失忆**                          | 每轮 `createAgentSessionServices` 新建会话（`:1274`），reviewer 记不住上轮说过什么，重复提同一条意见                                                           |
| 3   | **执行侧也失忆**                          | feedback 是一次性 user 消息；执行方只能靠自己的上下文接住，没有结构化交接                                                                                      |
| 4   | **每轮硬喂 60k diff**                     | `buildDiffFingerprint`（`:160`）+ 60k 截断，token 成本高，且截断后的 diff 会让「是否真在推进」判错                                                             |
| 5   | **没有真正的「审核对话」**                | 用户想干预审查（"这条你再核实一下"）只能取消目标重来                                                                                                           |
| 6   | **审查挂死时循环永久卡住**（v2 新增）     | `await reviewer.prompt(...)`（`:1321`）**没有超时**，隔离会话不返回就永远停在「审查中」                                                                        |
| 7   | **默认路径其实根本没有审查者**（v2 新增） | `reviewModel === null`（默认）→ `isAutonomous`（`:1231`）走「主模型自己写【目标已达成】+ 服务端熔断」，与痛点 1–5 描述的是**两条不同的代码路径**，必须一起收编 |

**用户诉求**：把目标审查本身变成一个对话。两种设想（v1 的核心）：

- **A**：当前对话 = 审查对话，另开一个**常驻子代理**执行任务；子代理结束回到当前对话审查；不通过就给子代理发消息改。
- **B**：反过来 —— 当前对话执行，**审查单独开一个子代理/对话**。

---

## 1. 结论（TL;DR）

1. **底座已经有了，不需要新机制。** 第一方子代理**就是一个普通对话**（`subagents.ts:14-24`）：左栏可见、可点开、可输入（=steer）、可中止。改造点只有一句：**把「隐藏的隔离会话」换成「角色对话」**。
2. **A 与 B 的差别只有"谁是执行者、谁是审查者"** → 抽一层「角色对话（role conversation）」，写**一台**状态机，A/B 是它的两个配置（§4、§5），不是两套实现。
3. **编排权完全归服务端。** 服务端持有：目标文本、轮次预算、停滞/同错熔断、verdict 解析、代次作废、角色对话的出生与收尾。**一轮 = 一次派发 + 一次判定，模型不得自循环**（v1 的 A 案把 spawn→wait→steer→wait 的循环交给模型，会让轮次预算与停滞检测同时失效 —— v2 已改，见 §5.2）。
4. **推荐配置：⚡ B（当前对话执行，审查是常驻角色子代理），默认。** 用户的输入框始终对着真正在干活的那个会话；审查天然隔离、可只读、可指定便宜模型。
5. **只读不需要新模板字段**。`permissionPreset` 是**按对话**生效且热读的（`makeConversation` `:4107` 赋值；`wrapWrite/Edit/Bash` 每轮 `getPermission()` `:3917/:3925/:3961/:7187`）→ 角色子代理建好后置 `read-only` 即完成门禁；再让 reviewer 模板的 `enabledExtensions` 非空，插件/MCP 工具整体不进该会话（`agent-service.ts:3976`）。v1 的 `SubagentTemplate.tools` 字段因此**不需要**。
6. **角色对话默认 `persist=false`**：`persist` 只决定「是否留档到历史」，不影响左栏可见/可输入；而 `persist=true` 的子代理 `isSubagent=false`，会**占掉项目 8 个普通对话名额之一**（`:2392-2418`）。
7. **默认行为零变化。** `reviewMode` 默认 `"self"`（= 今天的自治路径）；已设置 `reviewModel` 的客户端自动升级为 `"reviewer"`（它们本来就在用外置审查，换成角色对话只是把隔离会话换成可见会话，token 量级不变）。回滚仍靠既有总开关 `goalModeEnabled`。
8. **落地顺序：先 B（PR-1/2），观察真实使用后再决定 A（PR-3）。** 不为一个未验证的交互提前建抽象。

---

## 2. 底座事实（已逐条核实；❗=对 v1 的纠正）

| 事实                                                                                                                                                                                       | 位置                                                           | 对本设计的意义                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 子代理 = 一个标记 `isSubagent` 的普通 Conversation（inMemory 或 persist），出现在左栏「运行的对话」带徽标，用户可点开/输入/中止/移出，运行态复用现有快照与消息管线                         | `subagents.ts:14-24`、`agent-service.ts:2382-2560`             | 「审查变成对话」零新机制；左栏徽标就是入口                                                                                                                            |
| `subagent_spawn` 已支持 `model`（`provider/id`）、`template`、`cwd`、`persist`                                                                                                             | `subagents.ts:195-231`                                         | 角色对话的模型/模板/目录全部现成                                                                                                                                      |
| **`steerSubagent` = `sendUserMessage(msg, isStreaming ? {deliverAs:"steer"} : undefined)`** —— 对**已完成**的子代理发消息就是开启新一轮                                                    | `agent-service.ts:2999-3002`                                   | 「审查不通过就让执行者改」天然成立                                                                                                                                    |
| ❗ **`steerSubagent` 对已消失的会话静默 no-op**（`if (!conv?.session) return;`），`subagent_get_result` 才会明确报 not found                                                               | `agent-service.ts:2999`、`subagents.ts:316-330`                | 循环每步**必须先查存在性**，否则会「以为已派单、实际没人做」而空转到熔断                                                                                              |
| ❗ **`subagent_get_result` 没有 `view` 参数**（v1 写错了）；它只返回 snapshot 的 `output`，而 `output = getLastAssistantText()`（最后一条 assistant 文本）                                 | `subagents.ts:297-357`、`agent-service.ts:2614`                | 想让审查者读执行者细节，要用 **`conversation(action="read")`**（`view: chat/full`、`maxChars ≤ 60000`，`conversation-read-tool.ts:228/327`），并支持按 live convId 读 |
| `subagent` 工具 `wait_all` 阻塞上限 = `max(min(60s, 0.8×工具看门狗), 5s)`，超时返回未完成清单（禁轮询）                                                                                    | `subagents.ts:42-45, 476-560`                                  | 这是**模型**的等待旋钮；服务端自己的等待必须事件驱动（§4.4）                                                                                                          |
| 子代理模型优先级：显式 `model` > 模板 `model` > 设置面板 `subagentDefaultModel` > 跟随派发会话当前模型；思考强度同理                                                                       | `agent-service.ts:2494-2545`                                   | 角色模型偏好的默认值链条已存在                                                                                                                                        |
| `SubagentTemplate` 只有 `systemPrompt / enabledSkills / enabledExtensions / model / thinkingLevel / enabled` —— **没有工具白名单**                                                         | `subagent-templates.ts:36-61`                                  | 只读改走 `permissionPreset` + 扩展白名单（§1-5），不改模板结构                                                                                                        |
| 子代理 `bindExtensions` 用 `WebUIContext.headless()`：UI 输出丢弃、**弹窗按取消返回**                                                                                                      | `agent-service.ts:2477-2487`                                   | 角色对话**不能向用户提问**，契约必须明令禁止（否则拿到「取消」后卡死）                                                                                                |
| 子代理工具 + `delegate_task` **无条件注册**进每个会话的 customTools                                                                                                                        | `agent-service.ts:3977-3996`                                   | 编排可由模型用工具做，不需要新增工具 —— 但 2.0 主动**不**让模型拥有轮次控制（§3）                                                                                     |
| 权限沙箱对 `write`/`edit`/`edit_soft`/`bash` 四处 wrapper **动态读 `getPermission()`**，`conv.permissionPreset` 按对话生效、热切换                                                         | `agent-service.ts:683, 804, 923, 1097, 3917, 3961, 7187`       | 角色对话的「只读门禁」= 建好后置 `read-only`，零改造成本；与 #389 Phase 2 的 plan gate 同一套门控                                                                     |
| `setPermissionPreset` 只作用于 active conv（`this.conv`）                                                                                                                                  | `agent-service.ts:7360`                                        | 需要一个「按 convId 设权限」的内部变体（§4.4）                                                                                                                        |
| ❗ **`reviewModel === null`（默认）时不建审查会话**：走 `isAutonomous`（`:1231`）——主模型自报 `GOAL_COMPLETION_RE` 标记 + 服务端熔断（`sameErrorRounds`/`stagnantRounds` ≥2 判 `blocked`） | `goal-service.ts:1231-1281`                                    | 2.0 必须把它作为第三种配置 `self` 显式保留并收编，不能假装现状只有隔离审查                                                                                            |
| ❗ **`await reviewer.prompt(...)` 无超时**                                                                                                                                                 | `goal-service.ts:1321`                                         | 顺便在角色模式下补审查 deadline（§4.6），今天是可以永久卡住的                                                                                                         |
| 限额：`MAX_SUBAGENTS = 16`（内存子代理）；❗`persist=true` 的「子代理」`isSubagent=false` → 计入 `MAX_OPEN_CONVERSATIONS = 8`（每项目普通对话）                                            | `agent-service.ts:1860-1864, 2382-2423`                        | 角色对话默认 `persist=false`；留档是可选偏好                                                                                                                          |
| 目标模式总开关 `goalModeEnabled` 默认 true；`reviewPrompt` / `reviewDisabledSkills` 在 client-state（每客户端）                                                                            | `client-state.ts:758, 246-248`、`settings-service.ts:122`      | 回滚开关与审查配置面的现状                                                                                                                                            |
| ❗ 过户（takeover）：**子代理随父对话一起搬**（`collectSubagentDescendantIds`），但 `goal` 状态**不搬**                                                                                    | `agent-service.ts:12415`（搬）、`:12369-12440`（无 goal 处理） | 角色循环跨页/过户会断 → §4.6 失效矩阵；反之 `persist=false` 的角色对话能跟着主对话走，是加分项                                                                        |
| `PlanManager.describePlan(convId)` 已存在（带步骤序号/状态/当前步），`UiState.plan` 已在全量快照里                                                                                         | `plan-manager.ts:110-131`、`protocol.ts:208`                   | 审查契约可零成本带上计划进度（#389 Phase 1 的合流点）                                                                                                                 |
| 通配符事实：新对话三连 / i18n / 协议单源 / UI 扩展点三规则等硬约束见 `docs/agent-rules.md`                                                                                                 | —                                                              | 本设计的改动清单（§7）逐条对齐这些约束                                                                                                                                |

---

## 3. 分层原则（先定，否则 A/B 各写一遍）

| 层         | 归属                            | 内容                                                                                                                         |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 状态机     | **服务端**（`goal-service.ts`） | 目标文本、锁与轮次预算（`maxRounds`，0=不限）、停滞熔断、`parseReviewerVerdict` 解析、代次作废、超时与降级、quiesce 与总开关 |
| 一轮的工作 | **模型**（角色对话）            | 这一轮怎么干 / 怎么核实、产出什么、审查者的 `{"verdict","feedback"}`                                                         |
| 可见性     | **角色对话**                    | 执行/审查过程必须落在某个左栏可点开的对话里，而不是隐藏会话                                                                  |

**新增第 4 条（v2 关键）：轮次所有权归服务端。**

> 一轮 =「服务端派一次活 + 服务端判一次定」。模型可以在**一轮之内**自由用工具（读、跑测试、grep），但**不得**自己驱动下一轮：不许自己 `subagent_spawn` 兄弟角色、不许自己 `subagent_wait_all` 等执行者、不许自己决定"再来一轮"。
> 理由：轮次编号、停滞指纹、同错计数、代次作废全是服务端算的（`:1208-1229`），模型一旦自循环，这些口径全部失真 —— 服务端只在 `agent_end` 看到一次结果。

推论：**只有一处结构化契约**（审查者的 verdict JSON）；执行侧只给自由文本，进展一律由服务端实测（`git diff` 指纹 + 会话错误特征）。

---

## 4. 推荐的统一循环（v2 核心）

### 4.1 抽象

```
目标模式 = 一台服务端循环 + 两个角色槽位

  executor 槽：主对话（用户自己的会话） 或 角色子代理
  reviewer 槽：主对话 或 角色子代理 或 无（self 自治）

  三种配置（§5）：
    ⚡ reviewer ：executor=主对话   reviewer=角色子代理   ← 推荐默认
    🧭 delegated：executor=角色子代理 reviewer=主对话     ← v1 的 A 案
    🕯 self     ：executor=主对话   reviewer=无           ← 今天的默认行为
```

```ts
/** 目标模式下的一个「角色对话」。 */
interface RoleAgent {
	kind: "executor" | "reviewer";
	/** 承载该角色的对话 id；= goal.conversationId 表示就是主对话本身。 */
	convId: string;
	/** true = 服务端拉起的子代理（可 dismiss / 可重启）；false = 主对话（只能注入消息）。 */
	spawned: boolean;
	/** 必须恒等于主对话 cwd：审查要看同一工作区的实际改动。 */
	cwd: string;
	/** 代次：角色对话被外部关掉后重建，旧回调据此作废。 */
	generation: number;
}
```

### 4.2 一轮的时序（服务端驱动，A/B 完全同构）

```
ROUND r（服务端）:
 ① 派发  executor ← 任务消息（goal + 第 r 轮 + 上一轮 feedback）
         主对话：sendUserMessage(…, {deliverAs: isStreaming ? "steer" : "followUp"})
         子代理：r==1 ? spawnRoleAgent(…) : sendRoleAgent(convId, …)
 ② 等待  waitRoleAgent(executor, deadline)          # 事件驱动，非轮询
 ③ 取样  服务端实测：git diff 指纹（buildDiffFingerprint）+ 会话错误特征（extractErrorSnippet）
         —— 取数对象是 **executor 所在的会话**，不是"主对话"（v1 在这里会取错）
 ④ 审查  reviewer ← 审查消息（goal + "第 r 轮" + executor 自述 + 可选计划进度）
 ⑤ 等待  waitRoleAgent(reviewer, REVIEW_DEADLINE) → 取文本 → parseReviewerVerdict
 ⑥ 判定  服务端（唯一裁判）：
          pass      → 清目标、收掉角色对话、通知
          revise    → r++，feedback 进 ①
          blocked   → 停滞/同错熔断（服务端算，不问模型）
          exhausted → 轮次预算用尽 / 单次模式
          invalid   → 无 JSON：按 fail 处理，raw 当 feedback（沿用现状），或按配置重试一次
```

- 与 v1 的本质差别：**②⑤ 的等待属于服务端**，模型在角色轮里只做「这一轮的工作」。v1 的 A 案把这套循环交给主对话模型（spawn→wait→steer→wait→JSON），轮次预算与停滞检测会失效。
- 顺带收益：审查轮不再依赖 `subagent_wait_all`（60s 上限、需要模型反复 wait），审查 deadline 由服务端统一管（治痛点 6）。

### 4.3 契约（发进角色对话的两段话）

**执行轮（发给 executor 槽）**

```
【目标 · 第 N/M 轮】
<目标全文>

上一轮审查意见（第 N-1 轮，若存在）：
<feedback 原文>

要求：直接动手改工作区，做完用一段话说明「改了什么、怎么验证的」。
禁止：向用户提问（本对话是自动流程，弹窗会被按取消返回）；
      自己派生/等待别的子代理（轮次由服务端控制）；
      只在回复里描述而不真正修改文件。
```

**审查轮（发给 reviewer 槽）**

```
你是严格、独立的验收者。只判断目标是否被完全满足，不看它说了什么，看工作区实际状态。

【目标】<目标全文>
【这是第 N/M 轮】
【执行者本轮自述】<executor 最后一条 assistant 文本；为空则注明"（无自述）">
【计划进度（可选，只有存在计划时才有）】<planManager.describePlan(convId)>

你可以（也只应该）用只读手段核实：read / grep / scm（只读 git）/ 只读 bash（跑测试）。
禁止：修改任何文件（本对话已置只读，写工具会直接报错）；
      向用户提问（弹窗按取消返回）；
      派生或等待子代理（轮次由服务端控制）；
      在回复里放 JSON 以外的任何文本。

只输出一个 JSON：
{"verdict":"pass","feedback":"<一句话：满足了什么>"}
{"verdict":"fail","feedback":"<可直接执行的具体待改项>"}
```

契约写作遵守仓库约定：服务端 `pick(lang, zh, en, key, vars)`，key 全局唯一（`goal.role.exec`、`goal.role.review`…），notice 推 UI 用 `text` + `textEn` 双字段。

### 4.4 GoalHost 需要新增的回调（唯一真正的工程量）

```ts
interface GoalHost {
	// …现有（gitDiff / reviewSettings / emit / flushSnapshot / isDisposed / quiesceBlocked / getConv …）

	/** 拉角色对话：走 spawnSubagentConversation 同一通道（模板/模型/思考强度/配额全复用）。
	 *  permissionPreset 在建 conv 时写入（避免首轮工具调用抢跑在权限生效之前）。 */
	spawnRoleAgent(opts: {
		role: "executor" | "reviewer";
		prompt: string;
		cwd: string; // 恒等于主对话 cwd
		template?: string; // 默认 "goal-executor" / "goal-reviewer"（内置，设置面板可覆盖）
		model?: string | null; // null = 模板模型 → 面板默认 → 跟随主对话
		thinkingLevel?: string;
		permissionPreset?: string; // reviewer 传 "read-only"
		persist?: boolean; // 默认 false
	}): Promise<string>; // → convId

	/** 事件驱动的「等这一轮跑完」：订阅该会话 agent_end（agent-service.ts:5085 已有钩子位），
	 *  返回 done / error / canceled / timeout / gone。严禁实现成轮询。 */
	waitRoleAgent(convId: string, timeoutMs: number): Promise<"done" | "error" | "canceled" | "timeout" | "gone">;

	/** 续跑/追问：子代理 = 新回合；主对话 = 用户消息（按 4.3-① 的输入策略排队）。 */
	sendRoleAgent(convId: string, message: string, opts?: { deliverAs?: "steer" | "followUp" }): Promise<boolean>;

	/** 角色对话的最后一条 assistant 文本（= snapshot.output，agent-service.ts:2614）。 */
	readRoleAgent(convId: string): string | undefined;

	/** 收尾：目标清除/完成/受阻时 dismiss 角色子代理（主对话槽位是 no-op）。 */
	dismissRoleAgent(convId: string): Promise<void>;

	/** 按 convId 设权限（`setPermissionPreset` 只作用于 active conv，需要这个变体）。 */
	setConvPermission(convId: string, preset: string | null): void;

	/** 会话是否还在（子代理被 dismiss/移出后 steer 会静默 no-op，必须显式判）。 */
	hasConv(convId: string): boolean;
}
```

实现要点（都是既有代码的小改）：

- `waitRoleAgent` 的事件源：`onEvent` 的 `agent_end` 分支（`agent-service.ts:5040-5086`，那里已经在处理 `conv.isSubagent` 的结局上报）挂一个 `Map<convId, resolver>`；`error/canceled` 从既有 `subagentRunOutcome(conv)` 取。
- `spawnRoleAgent` 复用 `spawnSubagentConversation`，新增两个可选参数（`permissionPreset`、`role`），角色名写进 `conv.subagentType`（左栏徽标显示 `goal-executor` / `goal-reviewer`）。
- 角色对话也得 `persist=false` 时**不进历史**但**进左栏列表**（现有行为，无需改）。

### 4.5 判定与熔断的取数口径（v2 修正点）

| 信号                          | 现状取数                                        | 2.0 取数（A/B 通用）                                                                                                                         |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作区进展（diff 指纹）       | `mainConv.cwd`（`:1224`）                       | **不变**：始终是主对话 cwd（两个槽位同 cwd，这是硬约束）                                                                                     |
| 错误特征（`sameErrorRounds`） | `mainSession`（`:1208`）                        | **改为 executor 所在会话** —— delegated 配置下主对话是审查者，它的工具报错（如 wait 超时）不代表执行受挫                                     |
| 轮次编号 / 预算               | `g.round` + `locked`/`maxRounds`                | **不变**（服务端算，契约里写明"第 N/M 轮"，与 v1 一致）                                                                                      |
| `blocked` 判定                | `sameErrorRounds >= 2 \|\| stagnantRounds >= 2` | **不变**；仅在 `self` 配置下由"审查缺席"触发，reviewer/delegated 配置下**先问审查者、熔断独立于 verdict 计算**，触发时直接终止并注入受阻说明 |

### 4.6 失效矩阵（v2 新增，逐条对应可测用例）

| 场景                                  | 检测点                                                                       | 处理                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 角色对话被用户 dismiss / 批量移出     | 每步前 `hasConv(roleConvId)`                                                 | reviewer 槽：**重建一次**（便宜、无状态）后继续；executor 槽：状态置"受阻（执行对话已失联）"，等用户处置（重建会丢执行者记忆）          |
| 角色轮跑完但报错（provider 400/超时） | `waitRoleAgent → "error"`                                                    | 审查者报错 → 按 fail 处理（feedback = 错误文本）或重试一次；执行者报错 → 计入 `sameErrorRounds`                                         |
| 角色轮超时                            | `REVIEW_DEADLINE`（建议 10 min）/ executor deadline（建议 = 工具看门狗口径） | 审查者：按 fail + "审查超时"；执行者：`stopRoleAgent` 后按 fail 处理，避免永久卡住（治痛点 6）                                          |
| 子代理配额满（16 内存 / 8 普通对话）  | `spawnRoleAgent` 抛错                                                        | **降级**：角色槽退化为 `self`（无审查者）或"主对话兼任"，并发一条 warning notice；循环不因配额死掉                                      |
| quiesce（服务排空）/ dispose          | 既有 `quiesceBlocked()` / `isDisposed()`                                     | 与现状一致：中途不再派单，状态置"已中止"，角色对话一并收掉                                                                              |
| 服务重启                              | 内存态全丢（goal 本身也不落盘）                                              | 语义与现状一致；GoalBar 显示"角色对话已失联"，允许重开                                                                                  |
| 过户（takeover）跨页                  | 目标 conv 搬走，`goal` 状态不搬                                              | `persist=false` 的角色对话**跟着父对话一起搬**（`agent-service.ts:12415`），新持有方重建循环；文档明确"过户后续跑一轮，历史轮次从 0 计" |
| 用户中途 clear goal / 改目标          | 既有 `goalGeneration` / `goalReviewGeneration`                               | 沿用：所有在飞的 `waitRoleAgent` 回调比代次后作废；角色对话收掉                                                                         |
| 用户手动中止主对话（Stop）            | 既有 `onAgentEnd(conv, true)`                                                | 沿用：清目标、收角色对话、通知"已手动停止"                                                                                              |

---

## 5. 三种配置

### 5.1 ⚡ `reviewer`：主对话执行，审查是角色子代理（**推荐默认**，= v1 的 Plan B）

| 维度       | 结论                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 用户视角   | 输入框对着真正干活的人；随时插话、随时中止；审查在左栏徽标里可点开逐条看，甚至可以自己 steer 它（"这条再核实一下"） |
| 审查独立性 | 隔离会话 + 只读预设 + 扩展白名单（无插件写工具）                                                                    |
| token      | 少：reviewer 在同 cwd 自己核实，不必服务端硬喂 60k diff；每轮只吃「目标 + 自述 + 计划进度」                         |
| 审查者记忆 | 复用同一 convId（上轮说过什么它记得），避免重复提同一条意见                                                         |
| 改造量     | 小：`runGoalReview` 里"自建隔离 session"的一段（`:1274-1337`）换成三个 host 回调                                    |
| 风险       | 子代理 headless → 不能问用户（契约明令）；配额占用（降级见 §4.6）                                                   |

### 5.2 🧭 `delegated`：主对话=审查者，执行者是常驻角色子代理（= v1 的 Plan A，**v2 改了驱动方式**）

与 v1 写法的差异（务必对齐）：

| 项         | v1 写法                                                                                                             | v2 写法（推荐）                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 轮次驱动   | kick 让主对话自己 `subagent_spawn` → `wait_all` → `get_result` → 视情况 `steer` 再回到 wait（内层循环不受预算约束） | 服务端在 ①②③ 之后才把「本轮已完成的执行自述 + 第 N/M 轮」注入主对话，主对话**只做审查**一职                                                          |
| 主对话占用 | 整个执行期（可能几十分钟）都在一个长回合里，用户无法正常使用                                                        | 只有审查回合被占用；执行期间主对话空闲，用户照常聊天                                                                                                 |
| 轮次预算   | 内层循环越界，`stagnantRounds` 只在最外层看到一次 diff                                                              | 每轮都有独立的 diff 指纹与错误特征取样（§4.5）                                                                                                       |
| 审查只读   | 需给主对话**临时**置 `read-only` 再恢复（要防覆盖用户手动切换）                                                     | **不需要**：主对话的执行期与审查期分离，审查回合里的写工具仍可拒绝（同上，但恢复窗口极短且由服务端在 ⑤ 之后立即还原）；若嫌麻烦，PR-3 可只靠契约约束 |
| 输入冲突   | 用户消息会被 `steer` 进审查回合（语义冲突）                                                                         | 审查回合只持续一次模型往返（通常几十秒），期间用户消息按 `followUp` 排队                                                                             |
| 代价       | —                                                                                                                   | 追加约束：`onAgentEnd(main)` 只在服务端处于 `awaiting_verdict` 标记时才当审查结果读；否则当普通对话（用户插话）忽略                                  |

主线仍是 §4.2 那六步，只是 ① 的槽位换成子代理、④ 的槽位换成主对话。适合"我设个目标就不管了，但要能看见它在审什么"的用户。

### 5.3 🕯 `self`：无审查者（**今天的默认行为，保留**）

- `reviewModel === null` 时的既有路径：主模型自报 `GOAL_COMPLETION_RE` 标记 → pass；`sameErrorRounds/stagnantRounds ≥ 2` → blocked；否则继续（`:1231-1281`）。
- 保留理由：零额外会话、零额外 token、DSH 与轻量用户仍需要；且"自报标记不可靠"这件事本身要靠 §5.1 去解决，而不是删掉退路。
- 与 2.0 的关系：`self` 是**降级落点**（配额满/角色失联/用户关掉角色模式），所以它必须健在。

### 5.4 👥 双代理（不做）

两个角色都是子代理、主对话只剩编排 —— 主对话里什么都看不见，用户要在两个徽标之间来回跳。**理由不足，不实现**；若将来要做，§4 的抽象天然支持（两个槽位都 `spawned=true`），无需返工。

---

## 6. 决策结论（v1 §9 待决点 + 新增决策）

| #   | 决策                                                                         | 理由                                                                                                                                   | 代价 / 缓解                                                                                                     |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D1  | **先做 B（`reviewer`），A（`delegated`）后置**                               | 先验证"审查成为对话"是否真的更好用，避免为一个未验证交互提前建抽象；B 改造面小、风险低                                                 | A 的入口按钮先隐藏（配置位留着），验完再开                                                                      |
| D2  | **审查者必须只读，但不用新增 `SubagentTemplate.tools`**                      | 现成机制就够：按 conv 的 `permissionPreset=read-only`（热生效）+ 模板 `enabledExtensions` 非空（顺带挡掉无 SDK 身份的插件/MCP 写工具） | 自研插件若绕过 wrapper 直接写文件仍拦不住 → 写明"只读是尽力而为，不是安全边界"；想更严再考虑 `tools`            |
| D3  | **角色对话默认 `persist=false`，留档做成一个偏好开关**                       | 可见性不依赖 persist（左栏徽标照常）；persist 会占 8 个普通对话名额之一、并写盘                                                        | 重启即丢（与 goal 内存态一致）；想让用户回看多轮审查就打开开关                                                  |
| D4  | **`self` 保留为第三种配置，默认值不动**                                      | 默认变行为 = 每个用户都被换掉审查机制；且 `self` 是配额耗尽时的降级落点                                                                | 需要在设置面板把三种档位讲清楚（一句话 + 影响）                                                                 |
| D5  | **`reviewModel` 已设置的客户端自动升级为 `reviewer`**                        | 这批人本来就在用外置审查会话 → 换成可见角色对话，token 量级不变、体验严格变好，迁移零成本                                              | 需要一次性迁移提示（notice 说明"审查已变为可点开的对话"）                                                       |
| D6  | **编排全归服务端；模型不得自循环、不得派生兄弟角色**                         | §3 第 4 条：否则轮次编号/停滞指纹/同错计数全部失真                                                                                     | 契约里明令禁止；模型若违规（派了子代理），服务端在 `agent_end` 检测到本轮没产出 JSON → 按 fail + 记一次异常     |
| D7  | **执行侧不引入新 JSON 契约，只保留审查者 verdict 一个结构化出口**            | 解析面越小越稳（现有 `parseReviewerVerdict` 双兜底已单测覆盖）                                                                         | 执行者的"完成度"由工作区实测 + 审查者判定，不靠执行者自报                                                       |
| D8  | **`delegated` 配置下，执行者的产物交接 = 服务端取"最后一条 assistant 文本"** | 与 `self` 读 `getLastAssistantText()` 同口径；不引入新工具                                                                             | 想看细节时，人/审查者用 `conversation(action:"read", view:"chat")`（v1 误以为 `subagent_get_result` 能带 view） |
| D9  | **A/B 共用一份协议字段与一份状态机**                                         | 两个槽位 = 同一结构的两份实例；避免两套并行实现                                                                                        | 协议里用 `roles: { executor?, reviewer? }` 而不是 `planA/planB` 两串字段                                        |
| D10 | **不为目标模式新增工具**（不需要 `goal_role_spawn` 之类）                    | 角色对话由服务端通过 host 回调拉起；模型侧只用现成 `subagent_*`（且明确限制其用途）                                                    | 也就避开了"新增可开关工具动三处 + FACTORY_TOOLS 单测"的全套流程                                                 |

---

## 7. 改动清单（对齐仓库硬约束）

### 7.1 协议（单源 `server/protocol.ts`，`scripts/check-protocol-sync.mjs` 守护）

```ts
export interface GoalStatus {
	// …现有字段全部保留
	/** 2.0：审查配置。"self"（默认，现状）| "reviewer"（主对话执行）| "delegated"（主对话审查）。 */
	reviewMode?: "self" | "reviewer" | "delegated";
	/** 2.0：循环相位，供 GoalBar 显示与输入降级。 */
	phase?: "idle" | "dispatching" | "executing" | "reviewing" | "blocked";
	/** 2.0：执行模型（"provider/id"；null = 跟随，delegated 配置用）。 */
	execModel?: string | null;
	/** 2.0：两个槽位的当前承载对话（主对话时 convId === conversationId）。 */
	roles?: {
		executor?: { convId: string; spawned: boolean; state?: string };
		reviewer?: { convId: string; spawned: boolean; state?: string };
	};
}
```

- 全部可选（`undefined` = 旧行为），前端不认识就忽略。
- 复用既有 `switch_conversation { id }`（`protocol.ts:533`）实现「👁 打开角色对话」，不需要新消息。
- 角色偏好（`reviewMode` / `execModel` / 留档开关）随既有 `set_goal_prefs`（`protocol.ts:797-823`）扩展字段，落 `client-state.json`（与 `reviewModel` 同口径）。

### 7.2 服务端

| 文件                           | 改动                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/goal-service.ts`       | `runGoalReview` 拆成 §4.2 六步；新增 `RoleAgent` 状态、`reviewMode` 分支、`REVIEW_DEADLINE`、失联降级；`startRoleRound/waitForRole/applyVerdict` 纯函数化（可单测）；错误特征取数改为 executor 会话（§4.5） |
| `server/agent-service.ts`      | 实现 §4.4 的 8 个 host 回调；`spawnSubagentConversation` 增 `permissionPreset`/`role` 可选参数；`onEvent` 的 `agent_end` 钩子（`:5085` 附近）加"角色轮结束"通知；`GoalHost` 接线（`:3525-3545`）            |
| `server/subagent-templates.ts` | 内置两个模板 `goal-executor` / `goal-reviewer`（缺省创建，可被用户改/停用）：reviewer 模板 = append 模式 + 明确只读契约 + `enabledExtensions` 非空；表面无新增字段（D2）                                    |
| 迁移                           | 启动时若用户已有 `reviewPrompt`（`client-state.ts:246`），把它塞进 `goal-reviewer` 模板的 `systemPrompt`（append），只做一次 → 避免两个配置面                                                               |

### 7.3 前端 / 设置面 / i18n

| 文件                                   | 改动                                                                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/src/components/GoalBar.tsx`       | 活跃行增：`phase` 文案、`👁 打开执行/审查对话`；两个新宿主 id 必须进 `GOAL_DEFAULT_ORDER`（slot 顺序驱动，见 `docs/agent-rules.md`「UI 扩展点与浮层规则」） |
| `web/src/components/SettingsModal.tsx` | 「目标审查」区（`:3718` 一带）增三档 `reviewMode` 单选 + 执行模型下拉 + 留档开关                                                                           |
| `web/src/i18n.tsx` + `locales/*.json`  | 新文案两边都加（`tests/unit/locales.test.ts` 锁对齐）；改完跑 `npm run changelog:i18n`；**value 只许字符串字面量**（i18n-diff 手写解析器）                 |
| 服务端 i18n (`pick`)                   | 新 key `goal.role.*` 全局唯一；多行走 `getServerBlock`；notice 用 `text`+`textEn`                                                                          |

### 7.4 测试

| 层     | 内容                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 单测   | 新建 `tests/unit/goal-role-loop.test.ts`：用 **fake GoalHost**（先例见 `tests/unit/goal-wizard-target.test.ts`）脚本化 verdict，断言轮次推进/pass/revise/blocked/降级/代次作废/失联重建；`parseReviewerVerdict` 复用不动 |
| 单测   | `tests/unit/goal-autonomous.test.ts` 扩展：`self` 配置行为零变化（回归护栏）                                                                                                                                             |
| 冒烟   | `tests/run-smoke.mjs` 的 ALL 列表里扩展 `goal-prefs-test`（新偏好往返）；`goal-test` 增 `reviewMode` 分支                                                                                                                |
| 真模型 | `goal-review-loop`（live）加一条：`reviewMode="reviewer"` 全流程 + 左栏出现角色对话 + 清目标后角色对话被 dismiss                                                                                                         |
| 手工   | 端口 ≥8900、data-dir `mkdtempSync` 隔离、精确清理自己进程、**禁 `pkill -f`**（AGENTS §5）                                                                                                                                |

---

## 8. 里程碑

| PR                        | 内容                                                                                                                            | 依赖   | 验收                                                                            | 回滚                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **PR-1**                  | GoalHost 8 回调 + `runGoalReview` 换实现（`reviewMode="reviewer"`）+ 内置 `goal-reviewer` 模板 + 只读预设 + deadline + 失联降级 | —      | `reviewMode="reviewer"` 下：审查可见、复用同一 convId、超时不再卡死、配额满降级 | 新增字段可选，`reviewMode` 默认 `self`；单 PR revert |
| **PR-2**                  | 前端：GoalBar 相位/`👁` 按钮 + 设置面板三档 + i18n + 迁移（D5）                                                                  | PR-1   | 老用户 `reviewModel` 已设 → 自动进入 `reviewer` 并收到一次性提示                | 前端可回退，服务端行为不变                           |
| **PR-1.5**（可并入 PR-1） | reviewer 模板编辑面（复用既有子代理模板设置 UI，无需新字段）                                                                    | PR-1   | 只读契约/扩展白名单可视化可改                                                   | 独立 revert                                          |
| **PR-3**                  | `delegated` 配置（§5.2）+ `execModel` + 审查期输入策略                                                                          | PR-1/2 | A 案：执行期主对话可用、审查回合只占一次往返、轮次预算生效                      | `reviewMode` 切回 `reviewer`/`self`                  |
| **PR-4**                  | 与 #389 Phase 1 合流：审查契约带 `planManager.describePlan(convId)`（逐项核对步骤）                                             | PR-1   | 有计划时 verdict 能引用步骤状态                                                 | 契约段可选                                           |

> 与 #389 的另两个合流点：#389 Phase 2 的 plan gate 与 D2 的 `permissionPreset` 门控**同一套代码**，建议同 PR 或紧邻落地；#385/PR #386 是独立 bug 修复，先合。

---

## 9. 风险与回滚

| 风险                                                          | 缓解                                                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 审查权从「服务端确定性」变成「模型自律」，JSON 契约遵从率下降 | 保留现有双解析兜底（`parseReviewerVerdict`：平衡括号 → 宽松正则 → 都没有按 fail + raw 当 feedback）；契约加 few-shot；遵从率下降时可配置重试一次  |
| 模型违规自循环 / 谎报轮次                                     | 轮次编号由服务端写进契约；`agent_end` 校验"本轮是否真产出了 verdict JSON"，没有就按 fail + 记异常（D6）                                           |
| 角色对话被外部关掉 / 服务重启                                 | §4.6 失效矩阵：reviewer 重建一次，executor 报受阻等用户处置；GoalBar 显示"角色对话已失联"并可重开                                                 |
| 子代理配额（16 / 8）被目标模式吃满                            | 角色对话**落盘**（占 8 个普通对话名额之一，满员时 spawn 抛错 → 降级为 `self` + 明确提示）；每个目标最多 1 个 executor；清目标即移出（转录留历史） |
| 只读被绕过（自研插件直接写文件）                              | 明确定位为"尽力而为"；模板扩展白名单已挡掉插件/MCP 工具；如要更严再加 `SubagentTemplate.tools`（D2 的后续）                                       |
| `delegated` 的 review turn 判定误伤用户插话                   | 只在服务端 `awaiting_verdict` 标记期间把 `onAgentEnd(main)` 当审查结果；其余 agent_end 一律忽略（单测覆盖）                                       |
| 配额/超时/失联的叠加态                                        | 全部收敛到 §4.6 一张矩阵，每行一个可测用例（fake host 驱动，不需要真模型）                                                                        |

**回滚策略**：延续 v1 —— 全部新行为挂在既有总开关 `goalModeEnabled` 之下；`reviewMode` 默认 `self`（= 今天）；协议新增字段全可选；`self` 路径（自治 + 熔断）**一行不动**，任何 PR 单独 revert 都不影响老行为。

---

## 10. 参考

- 代码：`server/goal-service.ts`（状态机 / `runGoalReview:1148` / 自治路径 `:1231` / 契约 `reviewerPrompt:1074`）、`server/subagents.ts`（子代理=对话、工具集、`WAIT_CAP_MS:42`）、`server/agent-service.ts`（`spawnSubagentConversation:2382`、`steerSubagent:2999`、`toSubagentSnapshot:2585`、customTools `:3977`、权限门控 `:3917/:7360`、`makeConversation:4107`、看门狗 `:4415`、过户 `:12369`）、`server/subagent-templates.ts`、`server/plan-manager.ts:110`、`server/conversation-read-tool.ts:228/327`
- 协议：`server/protocol.ts`（目标消息族 `:729-745`、`switch_conversation:533`、`dismiss_conversation:1048`、`GoalStatus:1382`、`PlanStep:1220`、`UiState.plan:208`）
- 前端：`web/src/components/GoalBar.tsx`（`GOAL_DEFAULT_ORDER` + slot 合并）、`web/src/components/SettingsModal.tsx:3718`、`web/src/i18n.tsx`
- Issue：#385（AI 提炼超时，PR #386 待合）、#389（Goal & Plan）
- 主题文档：`docs/architecture-core.md`（快照驱动 / 协议单源）、`docs/architecture-plugins.md`（UI 扩展点与 slot 兼容）、`docs/agent-rules.md`（禁令清单）

---

## 11. 实施记录：Plan A（🧭 `delegated`）已落地

> 本节描述**当前代码的真实行为**（v2.1）；上面 §4 的抽象与本节一致，§5.2 的「v2 写法」即下表的实现。

### 11.1 落地位置

| 层     | 位置                                                                      | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 协议   | `server/protocol.ts`                                                      | `GoalReviewMode`（`self` / `delegated`）、`GoalRoleRef`、`GoalStatus.{reviewMode,phase,execModel,roles}`；`set_goal` / `set_goal_prefs` 各加 `reviewMode?` / `execModel?`（全可选，`undefined` = 旧行为）                                                                                                                                                                                                                                             |
| 偏好   | `server/client-state.ts`                                                  | `goalPrefs.{reviewMode,execModel}`（全局记忆，随 reload 恢复）                                                                                                                                                                                                                                                                                                                                                                                        |
| 循环   | `server/goal-service.ts`                                                  | `isDelegated` / `roleBridgeReady` / `roleDeadline` / `isCurrentDelegated` / `startDelegatedLoop` / `runDelegatedLoop` / `dispatchExecutor` / `sampleRound` / `askDelegatedReview` / `waitMainIdle` / `deliverAndWait` / `deliverDelegatedVerdict` / `finishDelegated` / `degradeToSelf` / `stopDelegated`；契约文案 `executorRoundPrompt` / `reviewerRoundPrompt` / `verdictRetryPrompt` / `roleFailureText`；纯函数 `extractErrorSnippetFromSession` |
| 宿主桥 | `server/agent-service.ts`                                                 | GoalHost 新增 `spawnRoleAgent` / `waitRoleAgent` / `sendRoleAgent` / `readRoleAgent` / `stopRoleAgent` / `dismissRoleAgent` / `hasConv` / `roleDeadlineMs`；回合结束等待者 `turnEndWaiters` + `waitConversationTurnEnd` / `roleOutcomeOf` / `notifyTurnEnd`（agent_end 与中止路径各唤醒一次）；`conv.kickoff` 记录 spawn 的投递 Promise；`removeConversation` 唤醒等待者为 `gone`                                                                     |
| 前端   | `web/src/components/GoalBar.tsx`、`ui-slots.ts`、`i18n.tsx`、`styles.css` | 执行方式开关（⚡ 直奔 / 🧭 委托）、委托执行者模型下拉、活跃行「执行对话」一键打开（`switch_conversation`）；三个新宿主 slot id（`host:goal-mode` / `host:goal-execmodel` / `host:goal-openrole`）+ `.goalbar-btn.mode` 样式                                                                                                                                                                                                                           |
| 测试   | `tests/unit/goal-delegated.test.ts`、`tests/goal-delegated-test.mjs`      | 8 个 fake-host 单测（派活/审查/pass/fail 续轮/无 JSON 重试/熔断/超时降级/清目标代次作废）+ 零 token 端到端冒烟（已在 `tests/run-smoke.mjs` 的 ALL 列表）                                                                                                                                                                                                                                                                                              |

### 11.2 与 v2 设计的差异（以实现为准）

| #   | v2 设计                                     | 实际实现                                                                                                                                                                                                                                                                              | 原因                                                                                                                     |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | 审查期把主对话临时置 `read-only`            | **未启用**：只靠契约「只读核实」约束                                                                                                                                                                                                                                                  | 主对话是用户自己的会话，临时改它的权限预设侵入性太强；executor 有写权限是必须的（它就是干活的）                          |
| 2   | `goal-executor` / `goal-reviewer` 内置模板  | **未建模板**：角色对话用主会话默认配置                                                                                                                                                                                                                                                | Plan A 的审查者是主对话、执行者不需要收窄技能/扩展；模板留给 Plan B 的 reviewer                                          |
| 3   | 留档开关（`persist` 可选）                  | **已改为落盘 `persist=true`**（普通持久化对话，`conv-` 前缀，转录进历史）。代价：① 占「每项目 8 个普通对话」名额之一（满员时 spawn 抛错 → 降级 self + 明确提示）；② 左栏不再有「子代理」微标 → 改用 `[目标执行] <目标摘要>` 标题保持可辨识；③ 完成/受阻后移出左栏但转录留在历史可回看 | 实施反馈“希望落盘”：执行者转录能回看、别随服务重启就消失。代价已在上方列明，并各有补偿（降级提示 / 标题前缀 / 历史回看） |
| 4   | 审查 deadline 建议 10 分钟                  | 与执行轮统一 = 工具看门狗（默认 20 分钟，`roleDeadlineMs()`）                                                                                                                                                                                                                         | 一个旋钮更好解释；审查也可能跑长测试                                                                                     |
| 5   | 熔断「先问审查者，独立于 verdict 计算」     | 取样后、**问审查者之前**就判熔断                                                                                                                                                                                                                                                      | 停滞/同错是服务端实测信号，先判可省下整轮审查 token                                                                      |
| 6   | （未展开）目标进行中改执行方式              | 只记偏好 + notice，**下一个目标生效**                                                                                                                                                                                                                                                 | 半途换轨会留下孤儿循环、丢掉执行者记忆（换模型对已存在的执行对话也无效）                                                 |
| 7   | 审查无 JSON → 按 fail 处理 / 或重试一次     | 「收紧契约」重试 **1** 次，仍无 → `blocked` 收尾（保留目标）                                                                                                                                                                                                                          | 避免把「模型没按契约回」误记成一整轮失败并继续烧 token                                                                   |
| 8   | （实施后补）失联/中止 = 停止                | 执行对话被移出 / 被手动中止（子代理 ⏹）= **终点事件**：循环立即收束（blocked）、清掉指向死对话的 `roles`、**不再派下一轮**                                                                                                                                                            | 实施反馈：“关掉执行对话后它又自己启动” —— 中止/关闭就是要停；执行者记忆已失，换人干不如停                                |
| 9   | （实施后补）停止按钮                        | 目标条 ✕ 原本 `disabled={goal.reviewing}`，而委托循环全程 `reviewing=true` —— 恰在最想停的时候没得停。改为**始终可点**：循环中变红色「■ 停止目标」，点它 = `clear_goal`（停掉并移出执行对话）                                                                                         | `clearGoal` 本就能安全停（代次守卫），按钮禁用没必要；受阻文案也补了“点 ■ 停止目标退出”的指引                            |
| 10  | 三种配置并存（self / reviewer / delegated） | **只保留 delegated**：`reviewMode` 字段与模式开关（⚡/🧭）全部删除；v1 的 self 路径（隐藏隔离审查会话 + 自治标记 `GOAL_COMPLETION_RE`）整段删除                                                                                                                                       | 产品决策：只保留新模式。DSH 引擎有自己的目标实现，不受此影响                                                             |
| 11  | spawn 失败 → 降级 self；缺角色桥 → 降级     | 改为**没有降级**：缺桥 → `setGoal` 在动目标状态前就拒绝；spawn 失败（配额满）→ `abortOnSpawnFailure` 当场中止并把原因摆上目标条                                                                                                                                                       | 既然只剩一条路径，降级等于「偷偷换一种行为」；宁可响亮失败                                                               |
| 12  | `GoalStatus.reviewModel` = 审查模型         | 字段**保留**（DSH 的 `makeGoalStatus` 仍构造它，删了要动 DSH），但 pi 侧语义改为**调研（向导）模型**记忆位；pi 目标审查不再有独立模型（审查者就是当前对话）                                                                                                                           | 兼容优先 + 前端把下拉文案改成「调研模型」，不新增字段也不动 DSH                                                          |

### 11.3 关键实现细节（踩过的坑）

- **spawn 的投递是 fire-and-forget**：`spawnSubagentConversation` 里 `sendUserMessage` 不 await，服务端紧接着「等本回合结束」会把「还没开跑」误判成「已跑完」（空取样 → 下一轮派活撞车）。解决：`conv.kickoff` 记下投递 Promise + `waitConversationTurnEnd` 的 3s 启动宽限。
- **`steerSubagent` 对已消失会话静默 no-op**：循环每步前用 `hasConv` 判存在性，失联按 `blocked` 收尾（不静默换个「新人」继续）。
- **取数口径**：停滞指纹吃工作区 `git diff`（与主对话同一个 cwd），错误特征吃**执行者会话**（`readRoleAgent` 返回的 `errorSnippet`）——主对话作为审查者，它的工具报错不代表执行受挫。
- **用户插话**：审查指令投递前先 `waitMainIdle`（等主对话空闲，最多一个 deadline），否则会被当成 `steer` 插进用户自己的回合。
- **代次守卫**：`stopDelegated` 唤醒 verdict 等待者为 `gone`；迟到的 verdict 因 `awaitingVerdict` 已清 / 代次不符而被丢弃（单测覆盖）。
- **「中止 / 关闭就是停止」**：`waitRoleAgent` 返回 `canceled`（子代理被 ⏹/abort）或 `gone`（对话被移出 / 服务重启）时，循环**立即收束**，不再 steer 下一轮；只有 `error` / `timeout`（可恢复的失败）才在预算内进下一轮。停掉后 GoalBar 的「■ 停止目标」随时可点。
- **折叠态只是一枚药丸，不是面板**：收起时 `GoalBar` 只渲染 `.goalbar-collapsed`（**刻意不带 `.goalbar` 类**）—— `.goalbar` 那套边框/底色/圆角/内边距在收起时全是多余，主题再用 `.goalbar { border-top: … !important }` 一画，就是一条横跨整列的带子横在最后一条消息上把它切断（实报「折叠时一整行遮挡底部消息」）。药丸行自带 `min-width:0` + `max-width:100%` + `overflow:hidden`，插件往 pill 行贡献条目也顶不宽。守卫：`tests/unit/goalbar-collapsed-pill.test.ts`。

### 11.4 验证状态（本次本地实施）

- `npm run check:protocol` ✓ · `tsc -p tsconfig.server.json` ✓ · `oxlint`（改动文件零告警）✓ · `prettier --check` ✓
- `vitest run`：3082 passed（含 delegated 单测 11 例）；`goal-test` / `goal-prefs-test` / `goal-delegated-test` 冒烟全绿
- 既有失败（与本改动无关，实施前即存在）：`tests/unit/read-dir.test.ts`（SDK `ls` 抛 Path not found）、`tests/plugin-test.mjs`（测试内 fetch body 二次读取）

### 11.6 审计修复（目标模式全功能审计，A1–A6）

> 2026-09：对委托循环的六处设计缺陷修补（探针见 `tests/unit/goal-delegated.test.ts` 的 A1–A6 回归例 + `goal-review-pure.test.ts`）。全部向后兼容：协议零新增字段，`GoalHost.isGitRepo` 缺席即按旧行为。

| #     | 修补                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 位置                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A1    | **熔断提到 outcome 分支之前 + 执行连败熔断**：`sampleRound` 后先判 `sameError/stagnant ≥ 2`，不再被 `error/timeout → continue` 跳过；新增 `conv.failedRounds`（done 即清零），error/timeout 连续 2 轮（`EXEC_FAILED_ROUNDS_LIMIT`）直接 `blocked` 并给出 `timeout-repeat` / `error-repeat` 文案 —— 默认「不限轮」下不再无限空转                                                                                                                                                                                                                                                                                                                                                                                                                            | `goal-service.ts` `runDelegatedLoop` / `roleFailureText`                                                        |
| A2    | **非 git 目录跳过停滞计数**：`GoalHost` 新增可选 `isGitRepo(cwd)`（缺席 = 默认有，老 fake host 不动）；不可用时 `stagnantRounds`/`lastDiff` 冻结，错误与连败熔断照常。pi 宿主用 `git rev-parse --is-inside-work-tree` 实现。纯问答/回答类目标不再第 2 轮被误熔断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `goal-service.ts` `sampleRound`、`agent-service.ts` 接线                                                        |
| A3    | **重设目标排队接力**：`startDelegatedLoop` 不再 `has → return` 静默丢弃，改记 `delegatedPending`；旧循环 `finally` 里消费并启动新循环（代次过期则首个守卫即退出）。`stopDelegated` 顺带清排队项。`setGoal` 紧跟 `clearGoal` 不再留下「等待生成…却永不派活」的死目标                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `goal-service.ts`                                                                                               |
| A4    | **审查回合 abort 只作废本次审查**：`onAgentEnd(aborted)` 若 `awaitingVerdict` 非空 → settle `invalid`（走无 JSON 重试/受阻）+ 返回「审查回合已中止」notice，目标与执行对话保留。此前是整个目标连同执行者一起清掉                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `goal-service.ts` `onAgentEnd`                                                                                  |
| A5    | **verdict 取最后一个合法 JSON**：`parseReviewerVerdict` 全扫平衡 `{...}`，最后一个 `verdict: pass\|fail` 胜出（正则兜底同样）；审查契约的两个完整示例改为字段说明 + 不可解析占位符 `{"<pass\|fail>"}`，模型复述示例不再假通过                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `goal-service.ts` 解析器 + `reviewerRoundPrompt`                                                                |
| CLEAN | **多轮沉积清理**：删只写不读的 `verdictRetry`、v1 残留 `goalReviewGeneration`（两接口 + 初始化 + 测试 fake）、零调用的 `reviewPrefs` getter ×2、GoalBar 死串 `host:goal-mode`；`clearGoal` 里重复的 `goal.reviewing = false` 去重；提 `resetLoopCounters` / `clearGoalFields` / `roundBudgetOf`（四处重置点 + 两处预算计算收敛，`finishDelegated` 的展示用预算保持原语义）；`detachRoleExec` 收敛 stop/dismiss 两处（finish 侧保留 await 保收尾顺序，stop 侧 fire-and-forget 保同步上下文，pending 误删回归 A3 已排除）；`RoleAgentRead` 类型三处复用；`reviewCardText` 走 `roundsLabel` + 显示钳制后预算；`allBalancedJsonObjects` 输入封顶 32k 取尾（平方级扫描防超长回复）；`lastToolNameOfSession` 注释与实现对齐；fold 复用 `asText` 删本地重复实现   | `goal-service.ts`、`agent-service.ts`、`settings-service.ts`、`GoalBar.tsx`、`goal-review-fold.ts`、两测试 fake |
| UX1   | **审查回合折叠**：契约（审查指令 + 重试指令，中英）末尾加稳定机器行 `[goal-review]`；前端 `goal-review-fold.ts` 识别指令与纯 verdict JSON，`MessageList` 默认渲染成 `CollapsedMessage` 摘要行（指令→审查中…/结论→已通过·未通过，复用既有 key 零新增文案），点开展开（`expanded` 记忆）；`CollapsedMessage` 加可选 `summary` prop。带闲话的非纯 JSON 保持展开                                                                                                                                                                                                                                                                                                                                                                                               | `goal-service.ts`（标记）、`goal-review-fold.ts`（新）、`MessageList.tsx`、`CollapsedMessage.tsx`               |
| UX2   | **执行者实时进度**：`GoalRoleRef` += `streaming?/activity?/activityEn?`（轮次边界刷新，非每 token）；`GoalHost.readRoleAgent` += 同名 vitals（老 host 缺字段即跳过）；`snapshotExecutor` 在派活/取样点刷新（在跑+有工具→「xx 运行中」，否则自述头 60 字）；目标条 detail 行展示                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `protocol.ts`、`goal-service.ts`、`agent-service.ts`、`GoalBar.tsx`                                             |
| UX3   | **轮次/预算 + token 可视化**：芯片按预算显示 `第 N/M 轮`/`第 N 轮·不限`（前端按现有 key 组装，零新增文案）；用量累计（执行者派活-取样差值 + 审查者投递-verdict 差值，`getSessionStats` 只在轮次边界读）→ `GoalStatus.usage?` → 目标条 `· 1.8k tokens`（title 给精确值）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `protocol.ts`、`goal-service.ts`、`agent-service.ts`（stats 取数）、`GoalBar.tsx`                               |
| UX4   | **目标历史**：`GoalHistoryEntry`（目标/终态/轮次/原因/时间）+ `GoalStatus.history?`；`finishDelegated` 全终态与 `abortOnSpawnFailure` 落袋（cap 20，内存态，清目标不清空）；目标条编辑行「历史 (N)」下拉（无新 slot，直接渲染），点条目回填输入框（不直发）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `protocol.ts`、`goal-service.ts`、`GoalBar.tsx`、`i18n` + 8 语言包（`goalHistory`）                             |
| B3    | **审查卡片 + 插话顺延**：服务端开始发 `goal-review` custom 卡（前端 `Message.tsx` 的专属卡片分支与 `msg-goal-review` 样式早已存在，只缺发送方，零协议/前端改动）—— 审查开始卡（`deliverAndWait` 投指令前）+ 结论卡（pass/fail 人话，裸 JSON 仍在流里但不再是唯一载体）；`prompt()` 入口处纯文本 steer 插话顺延（`shouldDeferPromptForReview` 纯函数：followUp/斜杠直通，带附件响亮拒绝保草稿），verdict 落定后 `flushDeferredPrompts` 按序 followUp 发出（take 语义，`deliverAndWait` 与 `stopDelegated` 互斥、先到先得）—— 一次插话再也烧不掉整个目标                                                                                                                                                                                                     | `goal-service.ts`（卡片 + 队列）、`agent-service.ts`（`prompt()` 顺延）、`goal-review-gate.ts`（判定）          |
| B1    | **审查回合硬闸门**：新模块 `server/goal-review-gate.ts`（纯函数 `goalReviewDenial`，单测 `goal-review-gate.test.ts` 9 例）—— 写类 / 非常规 bash / 派发类（D6：轮次由服务端控制，禁 spawn/steer/stop/wait/排程/改模式开目标）/ `ask_user_question` 在 `awaitingVerdict` 置位期间一律拒；`agent-service.ts` 加 `withGoalReviewGate`（最外层）+ `goalReviewTurnOf(ownerId)`，三处包裹点（edit_soft / customTools `.map` / `planGate` 覆盖）+ 常驻终端 `checkSafety`；闸门无状态，verdict 落定自动恢复。bash 在计划白名单之外另放测试形状（`npm test` / `npx vitest` / `pytest` / `go test` 等，`npm run deploy` 照拒），兑现契约「跑测试」承诺；契约文案加一句硬拦截预告。已知局限（与计划/审查者闸门同口径）：动态补入的插件工具、自研插件直写文件不在覆盖面 | `goal-review-gate.ts`（新）、`agent-service.ts`、`goal-service.ts`（契约一句）                                  |
| B4    | **总开关关闭停掉在飞目标**：`SettingsHost` 新增可选 `onGoalModeDisabled`，`set()` 在 on→off 跃迁时调一次（预设不带总开关，`set()` 是唯一变异点）；pi 宿主接到 `GoalService.stopAllGoals()` —— 所有在飞循环按代次作废 + 执行者停并移出 + 目标状态清空 + 发 notice，无在飞目标/调研时无声；在跑的调研向导一并中止（`clearGoal` 的中止块抽成 `abortWizard()` 复用）                                                                                                                                                                                                                                                                                                                                                                                           | `settings-service.ts`、`agent-service.ts` 接线、`goal-service.ts` `stopAllGoals`                                |
| B5    | **quiesce 排空不再派新一轮**：`setGoal` 排空期直接拒绝（宿主 `quiesceBlocked()` 自带 notice，清目标不受影响）；循环顶排空检查 → `blocked` 收尾 + `quiesce` 原因文案（存量回合跑完，下一轮不再派，与设计文档 §4.6 同口径）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `goal-service.ts` `setGoal` / `runDelegatedLoop` / `roleFailureText`                                            |
| B7    | **活跃芯片跟随 `phase`**：`reviewing` 期 `phase === "executing"` 显示「执行中…」，否则「审查中…」（缺席回落旧行为）。新增 `goalBarExecuting` 文案（`i18n.tsx` 中英 + 8 语言包同位 + `changelog:i18n`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `GoalBar.tsx`、`i18n.tsx`、`locales/*.json`、`goalbar-phase-chip.test.ts`                                       |
| A6    | **blocked/exhausted 也移出执行对话**：`finishDelegated` 顶部统一 `stop + dismiss` 并清 `roles`（转录已落盘，历史可回看）。此前只有 pass 移出，受阻常驻占「每项目 8 个普通对话」名额，连续失败目标会把名额吃满                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `goal-service.ts` `finishDelegated`                                                                             |
| B8    | **计划看板审查联动与向导步骤提取（#389 Phase 1）**：`GoalHost` 接入 `getPlan`/`describePlan`/`setPlan`；审查契约（`reviewerRoundPrompt`）自动注入当前会话的 `describePlan` 看板摘要，消除验收盲区；向导（`startGoalWizard`）产物经 `parseWizardOutput` 解析结构化 `STEPS:` 并自动注入 `PlanManager`，向导落地后步骤看板立即可见                                                                                                                                                                                                                                                                                                                                                                                                                            | `goal-service.ts`、`agent-service.ts`                                                                           |
| B9    | **审查者输入补齐「执行者到底跑了什么」（#543 §1）**：新模块 `server/goal-evidence.ts`（纯函数 `collectToolEvidence` / `formatEvidenceDigest` / `sessionMessagesOf` / `buildEvidenceDigest`，单测 `goal-evidence.test.ts`）；`GoalHost` 新增**可选** `readRoleEvidence(convId)`（`agent-service` 用执行者会话最近的 `bashExecution` / `toolResult` 生成：工具名 + 参数提示 + 输出尾部，单条 400 字符、整段 6000 字符封顶，超出丢最早并标注）；`reviewerRoundPrompt` 在「执行者本轮自述」后注入证据段 —— 缺席 / 读失败 = 不注入（老 host、fake host 零改动）                                                                                                                                                                                                 | `goal-evidence.ts`、`goal-service.ts`、`agent-service.ts`                                                       |
| B10   | **判定口径四条 + 空 feedback 兜底（#543 §2/§3）**：审查契约（中英双模板）内置「只判本轮**声称完成**的条目 / 未声称的后续阶段不构成 fail / 忽略与目标无关的本地改动 / 无命令或文件证据必须 fail 并点名缺哪条输出 / feedback 不得为空」；`ensureReviewerFeedback` 统一在 verdict 落地处兜底（fail 且上一轮有意见 → 沿用并标注，两轮都空 → 给可执行的失败说明，pass 且无说明 → 不编造理由只补中性标注），审查结论卡与下一轮执行者提示词共用同一份文案。回归：`goal-delegated.test.ts` E1–E5                                                                                                                                                                                                                                                                   | `goal-service.ts`                                                                                               |

### 11.5 已知遗留 / 后续

1. **审查者只读门禁未启用**（D2 的一半）：主对话是用户自己的会话，审查回合靠契约「只读核实」约束，没有临时改它的 `permissionPreset`。要硬门禁需实现「按 convId 设权限」（§4.4 已列该回调）。
2. **过户（takeover）**：执行对话随父对话搬（`collectSubagentDescendantIds`），但 `goal` 状态不搬 → 新持有方需重设目标；未做自动续跑。
3. **服务重启**：goal 状态是内存态（重启即丢）；执行对话**已落盘**，转录可在历史里回看，但循环不会自动续跑。
4. **计划联动（#389 Phase 1）**：已完成（见 B8，审查契约带 `describePlan`、向导产出带步骤看板）。
5. **DSH 引擎**：仍是它自己那套目标实现（模型自判定 + round-driver），未接入执行对话模式；设置里的 `reviewPrompt` 对它仍然有效。
