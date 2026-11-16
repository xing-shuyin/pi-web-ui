[English](./goal-conversation-design.en.md) · [简体中文](./goal-conversation-design.md) · **繁體中文**

# 目標模式 2.0 設計：把「目標審查」變成對話

> **狀態**：**已實施，且只剩一條路徑**。目標模式 2.0 = 服務端驅動 + 執行對話幹活 + **當前對話當審查者**（本文的 Plan A，下文簡稱「執行對話模式」）。v1 的隱藏隔離審查會話與自治標記路徑（`runGoalReview` / `isAutonomous` / `GOAL_COMPLETION_RE`）已按產品決策**刪除**；Plan B（審查者=角色子代理）與 `reviewMode` 開關**不再實現**。實施細節與偏差見 §11。
> 關聯：#385（AI 提煉超時，已有 PR #386 待合）、#389（Goal & Plan，本設計可與之 Phase 1 合流）。
> **修訂記錄**
>
> - **v2.2（本次）**：**只保留新模式** —— 刪除 self 路徑與模式開關（協議去掉 `reviewMode`；`GoalStatus.reviewModel` 欄位名保留給 DSH，pi 側語義改為「調研模型」）；缺角色橋 / 建不出執行對話 = 拒絕或中止，**沒有降級路徑**。見 §11.2 表末三行。
> - **v2.1**：Plan A 實施完成 —— 與 v2 設計的差異、檔案/函式地圖、驗證結果與已知遺留見 §11。
> - **v2**：把 v1 的 A/B 兩案收斂成**同一臺服務端迴圈**的三種配置（§4），A 案改為「服務端跑完執行輪、主對話只做審查」；只讀改用現成 `permissionPreset` + 模板擴充套件白名單，**砍掉新增模板 `tools` 欄位**；角色對話預設 `persist=false`；補 5 處事實糾正（§2）+ 失效矩陣（§4.6）+ 決策結論（§6）。
> - v1：Plan A（主對話=審查者）/ Plan B（主對話=執行者）兩案並列。

---

## 0. 現狀與痛點

今天的「目標模式」是一條**單向的、服務端編排的自動化流水線**：

```
GoalBar 設目標
  → setGoal 注入一條 user 訊息「【目標已設定】…請開始實現」   （goal-service.ts setGoal）
  → 主對話執行
  → agent_end 鉤子                                            （agent-service.ts:5086）
  → runGoalReview 拉起一個【隱藏的、inMemory 的隔離會話】        （goal-service.ts:1148）
       · 喂：目標文本 + 主對話最後一段輸出 + git diff（截 60k，GIT_DIFF_CAP）
       · 要它只回 {"verdict":"pass|fail","feedback":"…"}
  → pass：清空目標；fail：把 feedback 當成普通 user 訊息打回主對話
```

痛點（都指向「審查不是對話」）：

| #   | 痛點                                      | 根因位置                                                                                                                                                         |
| --- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **審查過程完全不可見**                    | 隔離會話 inMemory、不落盤、左欄無入口，使用者只能看到一句「審查中（第 N 輪）」                                                                                   |
| 2   | **審查每輪失憶**                          | 每輪 `createAgentSessionServices` 新建會話（`:1274`），reviewer 記不住上輪說過什麼，重複提同一條意見                                                             |
| 3   | **執行側也失憶**                          | feedback 是一次性 user 訊息；執行方只能靠自己的上下文接住，沒有結構化交接                                                                                        |
| 4   | **每輪硬喂 60k diff**                     | `buildDiffFingerprint`（`:160`）+ 60k 截斷，token 成本高，且截斷後的 diff 會讓「是否真在推進」判錯                                                               |
| 5   | **沒有真正的「稽核對話」**                | 使用者想幹預審查（"這條你再核實一下"）只能取消目標重來                                                                                                           |
| 6   | **審查掛死時迴圈永久卡住**（v2 新增）     | `await reviewer.prompt(...)`（`:1321`）**沒有超時**，隔離會話不返回就永遠停在「審查中」                                                                          |
| 7   | **預設路徑其實根本沒有審查者**（v2 新增） | `reviewModel === null`（預設）→ `isAutonomous`（`:1231`）走「主模型自己寫【目標已達成】+ 服務端熔斷」，與痛點 1–5 描述的是**兩條不同的程式碼路徑**，必須一起收編 |

**使用者訴求**：把目標審查本身變成一個對話。兩種設想（v1 的核心）：

- **A**：當前對話 = 審查對話，另開一個**常駐子代理**執行任務；子代理結束回到當前對話審查；不通過就給子代理發訊息改。
- **B**：反過來 —— 當前對話執行，**審查單獨開一個子代理/對話**。

---

## 1. 結論（TL;DR）

1. **底座已經有了，不需要新機制。** 第一方子代理**就是一個普通對話**（`subagents.ts:14-24`）：左欄可見、可點開、可輸入（=steer）、可中止。改造點只有一句：**把「隱藏的隔離會話」換成「角色對話」**。
2. **A 與 B 的差別只有"誰是執行者、誰是審查者"** → 抽一層「角色對話（role conversation）」，寫**一臺**狀態機，A/B 是它的兩個配置（§4、§5），不是兩套實現。
3. **編排權完全歸服務端。** 服務端持有：目標文本、輪次預算、停滯/同錯熔斷、verdict 解析、代次作廢、角色對話的出生與收尾。**一輪 = 一次派發 + 一次判定，模型不得自迴圈**（v1 的 A 案把 spawn→wait→steer→wait 的迴圈交給模型，會讓輪次預算與停滯檢測同時失效 —— v2 已改，見 §5.2）。
4. **推薦配置：⚡ B（當前對話執行，審查是常駐角色子代理），預設。** 使用者的輸入框始終對著真正在幹活的那個會話；審查天然隔離、可只讀、可指定便宜模型。
5. **只讀不需要新模板欄位**。`permissionPreset` 是**按對話**生效且熱讀的（`makeConversation` `:4107` 賦值；`wrapWrite/Edit/Bash` 每輪 `getPermission()` `:3917/:3925/:3961/:7187`）→ 角色子代理建好後置 `read-only` 即完成門禁；再讓 reviewer 模板的 `enabledExtensions` 非空，外掛/MCP 工具整體不進該會話（`agent-service.ts:3976`）。v1 的 `SubagentTemplate.tools` 欄位因此**不需要**。
6. **角色對話預設 `persist=false`**：`persist` 只決定「是否留檔到歷史」，不影響左欄可見/可輸入；而 `persist=true` 的子代理 `isSubagent=false`，會**計入專案駐留普通對話數（預設不限，僅顯式配置 `PI_WEB_MAX_OPEN_CONVERSATIONS` 時限制）**（`:2392-2418`）。
7. **預設行為零變化。** `reviewMode` 預設 `"self"`（= 今天的自治路徑）；已設定 `reviewModel` 的客戶端自動升級為 `"reviewer"`（它們本來就在用外接審查，換成角色對話只是把隔離會話換成可見會話，token 量級不變）。回滾仍靠既有總開關 `goalModeEnabled`。
8. **落地順序：先 B（PR-1/2），觀察真實使用後再決定 A（PR-3）。** 不為一個未驗證的互動提前建抽象。

---

## 2. 底座事實（已逐條核實；❗=對 v1 的糾正）

| 事實                                                                                                                                                                                       | 位置                                                           | 對本設計的意義                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 子代理 = 一個標記 `isSubagent` 的普通 Conversation（inMemory 或 persist），出現在左欄「執行的對話」帶徽標，使用者可點開/輸入/中止/移出，執行態複用現有快照與訊息管線                       | `subagents.ts:14-24`、`agent-service.ts:2382-2560`             | 「審查變成對話」零新機制；左欄徽標就是入口                                                                                                                            |
| `subagent_spawn` 已支援 `model`（`provider/id`）、`template`、`cwd`、`persist`                                                                                                             | `subagents.ts:195-231`                                         | 角色對話的模型/模板/目錄全部現成                                                                                                                                      |
| **`steerSubagent` = `sendUserMessage(msg, isStreaming ? {deliverAs:"steer"} : undefined)`** —— 對**已完成**的子代理發訊息就是開啟新一輪                                                    | `agent-service.ts:2999-3002`                                   | 「審查不通過就讓執行者改」天然成立                                                                                                                                    |
| ❗ **`steerSubagent` 對已消失的會話靜默 no-op**（`if (!conv?.session) return;`），`subagent_get_result` 才會明確報 not found                                                               | `agent-service.ts:2999`、`subagents.ts:316-330`                | 迴圈每步**必須先查存在性**，否則會「以為已派單、實際沒人做」而空轉到熔斷                                                                                              |
| ❗ **`subagent_get_result` 沒有 `view` 引數**（v1 寫錯了）；它只返回 snapshot 的 `output`，而 `output = getLastAssistantText()`（最後一條 assistant 文本）                                 | `subagents.ts:297-357`、`agent-service.ts:2614`                | 想讓審查者讀執行者細節，要用 **`conversation(action="read")`**（`view: chat/full`、`maxChars ≤ 60000`，`conversation-read-tool.ts:228/327`），並支援按 live convId 讀 |
| `subagent` 工具 `wait_all` 阻塞上限 = `max(min(60s, 0.8×工具看門狗), 5s)`，超時返回未完成清單（禁輪詢）                                                                                    | `subagents.ts:42-45, 476-560`                                  | 這是**模型**的等待旋鈕；服務端自己的等待必須事件驅動（§4.4）                                                                                                          |
| 子代理模型優先順序：顯式 `model` > 模板 `model` > 設定面板 `subagentDefaultModel` > 跟隨派發會話當前模型；思考強度同理                                                                     | `agent-service.ts:2494-2545`                                   | 角色模型偏好的預設值鏈條已存在                                                                                                                                        |
| `SubagentTemplate` 只有 `systemPrompt / enabledSkills / enabledExtensions / model / thinkingLevel / enabled` —— **沒有工具白名單**                                                         | `subagent-templates.ts:36-61`                                  | 只讀改走 `permissionPreset` + 擴充套件白名單（§1-5），不改模板結構                                                                                                    |
| 子代理 `bindExtensions` 用 `WebUIContext.headless()`：UI 輸出丟棄、**彈窗按取消返回**                                                                                                      | `agent-service.ts:2477-2487`                                   | 角色對話**不能向用戶提問**，契約必須明令禁止（否則拿到「取消」後卡死）                                                                                                |
| 子代理工具 + `delegate_task` **無條件註冊**進每個會話的 customTools                                                                                                                        | `agent-service.ts:3977-3996`                                   | 編排可由模型用工具做，不需要新增工具 —— 但 2.0 主動**不**讓模型擁有輪次控制（§3）                                                                                     |
| 許可權沙箱對 `write`/`edit`/`bash` 三處 wrapper **動態讀 `getPermission()`**，`conv.permissionPreset` 按對話生效、熱切換                                                                   | `agent-service.ts:683, 804, 923, 1097, 3917, 3961, 7187`       | 角色對話的「只讀門禁」= 建好後置 `read-only`，零改造成本；與 #389 Phase 2 的 plan gate 同一套門控                                                                     |
| `setPermissionPreset` 只作用於 active conv（`this.conv`）                                                                                                                                  | `agent-service.ts:7360`                                        | 需要一個「按 convId 設許可權」的內部變體（§4.4）                                                                                                                      |
| ❗ **`reviewModel === null`（預設）時不建審查會話**：走 `isAutonomous`（`:1231`）——主模型自報 `GOAL_COMPLETION_RE` 標記 + 服務端熔斷（`sameErrorRounds`/`stagnantRounds` ≥2 判 `blocked`） | `goal-service.ts:1231-1281`                                    | 2.0 必須把它作為第三種配置 `self` 顯式保留並收編，不能假裝現狀只有隔離審查                                                                                            |
| ❗ **`await reviewer.prompt(...)` 無超時**                                                                                                                                                 | `goal-service.ts:1321`                                         | 順便在角色模式下補審查 deadline（§4.6），今天是可以永久卡住的                                                                                                         |
| 限額：`MAX_SUBAGENTS = 16`（記憶體子代理）；❗`persist=true` 的「子代理」`isSubagent=false` → 計入每專案駐留普通對話數（預設不限，`PI_WEB_MAX_OPEN_CONVERSATIONS` 可顯式啟用上限）         | `agent-service.ts:1860-1864, 2382-2423`                        | 角色對話預設 `persist=false`；留檔是可選偏好                                                                                                                          |
| 目標模式總開關 `goalModeEnabled` 預設 true；`reviewPrompt` / `reviewDisabledSkills` 在 client-state（每客戶端）                                                                            | `client-state.ts:758, 246-248`、`settings-service.ts:122`      | 回滾開關與審查配置面的現狀                                                                                                                                            |
| ❗ 過戶（takeover）：**子代理隨父對話一起搬**（`collectSubagentDescendantIds`），但 `goal` 狀態**不搬**                                                                                    | `agent-service.ts:12415`（搬）、`:12369-12440`（無 goal 處理） | 角色迴圈跨頁/過戶會斷 → §4.6 失效矩陣；反之 `persist=false` 的角色對話能跟著主對話走，是加分項                                                                        |
| `PlanManager.describePlan(convId)` 已存在（帶步驟序號/狀態/當前步），`UiState.plan` 已在全量快照裡                                                                                         | `plan-manager.ts:110-131`、`protocol.ts:208`                   | 審查契約可零成本帶上計劃進度（#389 Phase 1 的合流點）                                                                                                                 |
| 萬用字元事實：新對話三連 / i18n / 協議單源 / UI 擴充套件點三規則等硬約束見 `docs/agent-rules.md`                                                                                           | —                                                              | 本設計的改動清單（§7）逐條對齊這些約束                                                                                                                                |

---

## 3. 分層原則（先定，否則 A/B 各寫一遍）

| 層         | 歸屬                            | 內容                                                                                                                         |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 狀態機     | **服務端**（`goal-service.ts`） | 目標文本、鎖與輪次預算（`maxRounds`，0=不限）、停滯熔斷、`parseReviewerVerdict` 解析、代次作廢、超時與降級、quiesce 與總開關 |
| 一輪的工作 | **模型**（角色對話）            | 這一輪怎麼幹 / 怎麼核實、產出什麼、審查者的 `{"verdict","feedback"}`                                                         |
| 可見性     | **角色對話**                    | 執行/審查過程必須落在某個左欄可點開的對話裡，而不是隱藏會話                                                                  |

**新增第 4 條（v2 關鍵）：輪次所有權歸服務端。**

> 一輪 =「服務端派一次活 + 服務端判一次定」。模型可以在**一輪之內**自由用工具（讀、跑測試、grep），但**不得**自己驅動下一輪：不許自己 `subagent_spawn` 兄弟角色、不許自己 `subagent_wait_all` 等執行者、不許自己決定"再來一輪"。
> 理由：輪次編號、停滯指紋、同錯計數、代次作廢全是服務端算的（`:1208-1229`），模型一旦自迴圈，這些口徑全部失真 —— 服務端只在 `agent_end` 看到一次結果。

推論：**只有一處結構化契約**（審查者的 verdict JSON）；執行側只給自由文本，進展一律由服務端實測（`git diff` 指紋 + 會話錯誤特徵）。

---

## 4. 推薦的統一迴圈（v2 核心）

### 4.1 抽象

```
目標模式 = 一臺服務端迴圈 + 兩個角色槽位

  executor 槽：主對話（使用者自己的會話） 或 角色子代理
  reviewer 槽：主對話 或 角色子代理 或 無（self 自治）

  三種配置（§5）：
    ⚡ reviewer ：executor=主對話   reviewer=角色子代理   ← 推薦預設
    🧭 delegated：executor=角色子代理 reviewer=主對話     ← v1 的 A 案
    🕯 self     ：executor=主對話   reviewer=無           ← 今天的預設行為
```

```ts
/** 目標模式下的一個「角色對話」。 */
interface RoleAgent {
	kind: "executor" | "reviewer";
	/** 承載該角色的對話 id；= goal.conversationId 表示就是主對話本身。 */
	convId: string;
	/** true = 服務端拉起的子代理（可 dismiss / 可重啟）；false = 主對話（只能注入訊息）。 */
	spawned: boolean;
	/** 必須恆等於主對話 cwd：審查要看同一工作區的實際改動。 */
	cwd: string;
	/** 代次：角色對話被外部關掉後重建，舊回撥據此作廢。 */
	generation: number;
}
```

### 4.2 一輪的時序（服務端驅動，A/B 完全同構）

```
ROUND r（服務端）:
 ① 派發  executor ← 任務訊息（goal + 第 r 輪 + 上一輪 feedback）
         主對話：sendUserMessage(…, {deliverAs: isStreaming ? "steer" : "followUp"})
         子代理：r==1 ? spawnRoleAgent(…) : sendRoleAgent(convId, …)
 ② 等待  waitRoleAgent(executor, deadline)          # 事件驅動，非輪詢
 ③ 取樣  服務端實測：git diff 指紋（buildDiffFingerprint）+ 會話錯誤特徵（extractErrorSnippet）
         —— 取數物件是 **executor 所在的會話**，不是"主對話"（v1 在這裡會取錯）
 ④ 審查  reviewer ← 審查訊息（goal + "第 r 輪" + executor 自述 + 可選計劃進度）
 ⑤ 等待  waitRoleAgent(reviewer, REVIEW_DEADLINE) → 取文本 → parseReviewerVerdict
 ⑥ 判定  服務端（唯一裁判）：
          pass      → 清目標、收掉角色對話、通知
          revise    → r++，feedback 進 ①
          blocked   → 停滯/同錯熔斷（服務端算，不問模型）
          exhausted → 輪次預算用盡 / 單次模式
          invalid   → 無 JSON：按 fail 處理，raw 當 feedback（沿用現狀），或按配置重試一次
```

- 與 v1 的本質差別：**②⑤ 的等待屬於服務端**，模型在角色輪裡只做「這一輪的工作」。v1 的 A 案把這套迴圈交給主對話模型（spawn→wait→steer→wait→JSON），輪次預算與停滯檢測會失效。
- 順帶收益：審查輪不再依賴 `subagent_wait_all`（60s 上限、需要模型反覆 wait），審查 deadline 由服務端統一管（治痛點 6）。

### 4.3 契約（發進角色對話的兩段話）

**執行輪（發給 executor 槽）**

```
【目標 · 第 N/M 輪】
<目標全文>

上一輪審查意見（第 N-1 輪，若存在）：
<feedback 原文>

要求：直接動手改工作區，做完用一段話說明「改了什麼、怎麼驗證的」。
禁止：向用戶提問（本對話是自動流程，彈窗會被按取消返回）；
      自己派生/等待別的子代理（輪次由服務端控制）；
      只在回覆裡描述而不真正修改檔案。
```

**審查輪（發給 reviewer 槽）**

```
你是嚴格、獨立的驗收者。只判斷目標是否被完全滿足，不看它說了什麼，看工作區實際狀態。

【目標】<目標全文>
【這是第 N/M 輪】
【執行者本輪自述】<executor 最後一條 assistant 文本；為空則註明"（無自述）">
【計劃進度（可選，只有存在計劃時才有）】<planManager.describePlan(convId)>

你可以（也只應該）用只讀手段核實：read / grep / scm（只讀 git）/ 只讀 bash（跑測試）。
禁止：修改任何檔案（本對話已置只讀，寫工具會直接報錯）；
      向用戶提問（彈窗按取消返回）；
      派生或等待子代理（輪次由服務端控制）；
      在回覆裡放 JSON 以外的任何文本。

只輸出一個 JSON：
{"verdict":"pass","feedback":"<一句話：滿足了什麼>"}
{"verdict":"fail","feedback":"<可直接執行的具體待改項>"}
```

契約寫作遵守倉庫約定：服務端 `pick(lang, zh, en, key, vars)`，key 全域性唯一（`goal.role.exec`、`goal.role.review`…），notice 推 UI 用 `text` + `textEn` 雙欄位。

### 4.4 GoalHost 需要新增的回撥（唯一真正的工程量）

```ts
interface GoalHost {
	// …現有（gitDiff / reviewSettings / emit / flushSnapshot / isDisposed / quiesceBlocked / getConv …）

	/** 拉角色對話：走 spawnSubagentConversation 同一通道（模板/模型/思考強度/配額全複用）。
	 *  permissionPreset 在建 conv 時寫入（避免首輪工具呼叫搶跑在許可權生效之前）。 */
	spawnRoleAgent(opts: {
		role: "executor" | "reviewer";
		prompt: string;
		cwd: string; // 恆等於主對話 cwd
		template?: string; // 預設 "goal-executor" / "goal-reviewer"（內建，設定面板可覆蓋）
		model?: string | null; // null = 模板模型 → 面板預設 → 跟隨主對話
		thinkingLevel?: string;
		permissionPreset?: string; // reviewer 傳 "read-only"
		persist?: boolean; // 預設 false
	}): Promise<string>; // → convId

	/** 事件驅動的「等這一輪跑完」：訂閱該會話 agent_end（agent-service.ts:5085 已有鉤子位），
	 *  返回 done / error / canceled / timeout / gone。嚴禁實現成輪詢。 */
	waitRoleAgent(convId: string, timeoutMs: number): Promise<"done" | "error" | "canceled" | "timeout" | "gone">;

	/** 續跑/追問：子代理 = 新回合；主對話 = 使用者訊息（按 4.3-① 的輸入策略排隊）。 */
	sendRoleAgent(convId: string, message: string, opts?: { deliverAs?: "steer" | "followUp" }): Promise<boolean>;

	/** 角色對話的最後一條 assistant 文本（= snapshot.output，agent-service.ts:2614）。 */
	readRoleAgent(convId: string): string | undefined;

	/** 收尾：目標清除/完成/受阻時 dismiss 角色子代理（主對話槽位是 no-op）。 */
	dismissRoleAgent(convId: string): Promise<void>;

	/** 按 convId 設許可權（`setPermissionPreset` 只作用於 active conv，需要這個變體）。 */
	setConvPermission(convId: string, preset: string | null): void;

	/** 會話是否還在（子代理被 dismiss/移出後 steer 會靜默 no-op，必須顯式判）。 */
	hasConv(convId: string): boolean;
}
```

實現要點（都是既有程式碼的小改）：

- `waitRoleAgent` 的事件源：`onEvent` 的 `agent_end` 分支（`agent-service.ts:5040-5086`，那裡已經在處理 `conv.isSubagent` 的結局上報）掛一個 `Map<convId, resolver>`；`error/canceled` 從既有 `subagentRunOutcome(conv)` 取。
- `spawnRoleAgent` 複用 `spawnSubagentConversation`，新增兩個可選引數（`permissionPreset`、`role`），角色名寫進 `conv.subagentType`（左欄徽標顯示 `goal-executor` / `goal-reviewer`）。
- 角色對話也得 `persist=false` 時**不進歷史**但**進左欄列表**（現有行為，無需改）。

### 4.5 判定與熔斷的取數口徑（v2 修正點）

| 訊號                          | 現狀取數                                        | 2.0 取數（A/B 通用）                                                                                                                         |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作區進展（diff 指紋）       | `mainConv.cwd`（`:1224`）                       | **不變**：始終是主對話 cwd（兩個槽位同 cwd，這是硬約束）                                                                                     |
| 錯誤特徵（`sameErrorRounds`） | `mainSession`（`:1208`）                        | **改為 executor 所在會話** —— delegated 配置下主對話是審查者，它的工具報錯（如 wait 超時）不代表執行受挫                                     |
| 輪次編號 / 預算               | `g.round` + `locked`/`maxRounds`                | **不變**（服務端算，契約裡寫明"第 N/M 輪"，與 v1 一致）                                                                                      |
| `blocked` 判定                | `sameErrorRounds >= 2 \|\| stagnantRounds >= 2` | **不變**；僅在 `self` 配置下由"審查缺席"觸發，reviewer/delegated 配置下**先問審查者、熔斷獨立於 verdict 計算**，觸發時直接終止並注入受阻說明 |

### 4.6 失效矩陣（v2 新增，逐條對應可測用例）

| 場景                                   | 檢測點                                                                       | 處理                                                                                                                                    |
| -------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 角色對話被使用者 dismiss / 批次移出    | 每步前 `hasConv(roleConvId)`                                                 | reviewer 槽：**重建一次**（便宜、無狀態）後繼續；executor 槽：狀態置"受阻（執行對話已失聯）"，等使用者處置（重建會丟執行者記憶）        |
| 角色輪跑完但報錯（provider 400/超時）  | `waitRoleAgent → "error"`                                                    | 審查者報錯 → 按 fail 處理（feedback = 錯誤文本）或重試一次；執行者報錯 → 計入 `sameErrorRounds`                                         |
| 角色輪超時                             | `REVIEW_DEADLINE`（建議 10 min）/ executor deadline（建議 = 工具看門狗口徑） | 審查者：按 fail + "審查超時"；執行者：`stopRoleAgent` 後按 fail 處理，避免永久卡住（治痛點 6）                                          |
| 子代理配額滿（16 記憶體 / 8 普通對話） | `spawnRoleAgent` 拋錯                                                        | **降級**：角色槽退化為 `self`（無審查者）或"主對話兼任"，併發一條 warning notice；迴圈不因配額死掉                                      |
| quiesce（服務排空）/ dispose           | 既有 `quiesceBlocked()` / `isDisposed()`                                     | 與現狀一致：中途不再派單，狀態置"已中止"，角色對話一併收掉                                                                              |
| 服務重啟                               | 記憶體態全丟（goal 本身也不落盤）                                            | 語義與現狀一致；GoalBar 顯示"角色對話已失聯"，允許重開                                                                                  |
| 過戶（takeover）跨頁                   | 目標 conv 搬走，`goal` 狀態不搬                                              | `persist=false` 的角色對話**跟著父對話一起搬**（`agent-service.ts:12415`），新持有方重建迴圈；文件明確"過戶後續跑一輪，歷史輪次從 0 計" |
| 使用者中途 clear goal / 改目標         | 既有 `goalGeneration` / `goalReviewGeneration`                               | 沿用：所有在飛的 `waitRoleAgent` 回撥比代次後作廢；角色對話收掉                                                                         |
| 使用者手動中止主對話（Stop）           | 既有 `onAgentEnd(conv, true)`                                                | 沿用：清目標、收角色對話、通知"已手動停止"                                                                                              |

---

## 5. 三種配置

### 5.1 ⚡ `reviewer`：主對話執行，審查是角色子代理（**推薦預設**，= v1 的 Plan B）

| 維度       | 結論                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------- |
| 使用者視角 | 輸入框對著真正幹活的人；隨時插話、隨時中止；審查在左欄徽標裡可點開逐條看，甚至可以自己 steer 它（"這條再核實一下"） |
| 審查獨立性 | 隔離會話 + 只讀預設 + 擴充套件白名單（無外掛寫工具）                                                                |
| token      | 少：reviewer 在同 cwd 自己核實，不必服務端硬喂 60k diff；每輪只吃「目標 + 自述 + 計劃進度」                         |
| 審查者記憶 | 複用同一 convId（上輪說過什麼它記得），避免重複提同一條意見                                                         |
| 改造量     | 小：`runGoalReview` 裡"自建隔離 session"的一段（`:1274-1337`）換成三個 host 回撥                                    |
| 風險       | 子代理 headless → 不能問使用者（契約明令）；配額佔用（降級見 §4.6）                                                 |

### 5.2 🧭 `delegated`：主對話=審查者，執行者是常駐角色子代理（= v1 的 Plan A，**v2 改了驅動方式**）

與 v1 寫法的差異（務必對齊）：

| 項         | v1 寫法                                                                                                             | v2 寫法（推薦）                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 輪次驅動   | kick 讓主對話自己 `subagent_spawn` → `wait_all` → `get_result` → 視情況 `steer` 再回到 wait（內層迴圈不受預算約束） | 服務端在 ①②③ 之後才把「本輪已完成的執行自述 + 第 N/M 輪」注入主對話，主對話**只做審查**一職                                                          |
| 主對話佔用 | 整個執行期（可能幾十分鐘）都在一個長回合裡，使用者無法正常使用                                                      | 只有審查回合被佔用；執行期間主對話空閒，使用者照常聊天                                                                                               |
| 輪次預算   | 內層迴圈越界，`stagnantRounds` 只在最外層看到一次 diff                                                              | 每輪都有獨立的 diff 指紋與錯誤特徵取樣（§4.5）                                                                                                       |
| 審查只讀   | 需給主對話**臨時**置 `read-only` 再恢復（要防覆蓋使用者手動切換）                                                   | **不需要**：主對話的執行期與審查期分離，審查回合裡的寫工具仍可拒絕（同上，但恢復視窗極短且由服務端在 ⑤ 之後立即還原）；若嫌麻煩，PR-3 可只靠契約約束 |
| 輸入衝突   | 使用者訊息會被 `steer` 進審查回合（語義衝突）                                                                       | 審查回合只持續一次模型往返（通常幾十秒），期間使用者訊息按 `followUp` 排隊                                                                           |
| 代價       | —                                                                                                                   | 追加約束：`onAgentEnd(main)` 只在服務端處於 `awaiting_verdict` 標記時才當審查結果讀；否則當普通對話（使用者插話）忽略                                |

主線仍是 §4.2 那六步，只是 ① 的槽位換成子代理、④ 的槽位換成主對話。適合"我設個目標就不管了，但要能看見它在審什麼"的使用者。

### 5.3 🕯 `self`：無審查者（**今天的預設行為，保留**）

- `reviewModel === null` 時的既有路徑：主模型自報 `GOAL_COMPLETION_RE` 標記 → pass；`sameErrorRounds/stagnantRounds ≥ 2` → blocked；否則繼續（`:1231-1281`）。
- 保留理由：零額外會話、零額外 token、DSH 與輕量使用者仍需要；且"自報標記不可靠"這件事本身要靠 §5.1 去解決，而不是刪掉退路。
- 與 2.0 的關係：`self` 是**降級落點**（配額滿/角色失聯/使用者關掉角色模式），所以它必須健在。

### 5.4 👥 雙代理（不做）

兩個角色都是子代理、主對話只剩編排 —— 主對話裡什麼都看不見，使用者要在兩個徽標之間來回跳。**理由不足，不實現**；若將來要做，§4 的抽象天然支援（兩個槽位都 `spawned=true`），無需返工。

---

## 6. 決策結論（v1 §9 待決點 + 新增決策）

| #   | 決策                                                                         | 理由                                                                                                                                   | 代價 / 緩解                                                                                                     |
| --- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| D1  | **先做 B（`reviewer`），A（`delegated`）後置**                               | 先驗證"審查成為對話"是否真的更好用，避免為一個未驗證互動提前建抽象；B 改造面小、風險低                                                 | A 的入口按鈕先隱藏（配置位留著），驗完再開                                                                      |
| D2  | **審查者必須只讀，但不用新增 `SubagentTemplate.tools`**                      | 現成機制就夠：按 conv 的 `permissionPreset=read-only`（熱生效）+ 模板 `enabledExtensions` 非空（順帶擋掉無 SDK 身份的外掛/MCP 寫工具） | 自研外掛若繞過 wrapper 直接寫檔案仍攔不住 → 寫明"只讀是盡力而為，不是安全邊界"；想更嚴再考慮 `tools`            |
| D3  | **角色對話預設 `persist=false`，留檔做成一個偏好開關**                       | 可見性不依賴 persist（左欄徽標照常）；persist 會持有普通對話 runtime 並寫盤，僅顯式配置專案上限時佔名額                                | 重啟即丟（與 goal 記憶體態一致）；想讓使用者回看多輪審查就開啟開關                                              |
| D4  | **`self` 保留為第三種配置，預設值不動**                                      | 預設變行為 = 每個使用者都被換掉審查機制；且 `self` 是配額耗盡時的降級落點                                                              | 需要在設定面板把三種檔位講清楚（一句話 + 影響）                                                                 |
| D5  | **`reviewModel` 已設定的客戶端自動升級為 `reviewer`**                        | 這批人本來就在用外接審查會話 → 換成可見角色對話，token 量級不變、體驗嚴格變好，遷移零成本                                              | 需要一次性遷移提示（notice 說明"審查已變為可點開的對話"）                                                       |
| D6  | **編排全歸服務端；模型不得自迴圈、不得派生兄弟角色**                         | §3 第 4 條：否則輪次編號/停滯指紋/同錯計數全部失真                                                                                     | 契約裡明令禁止；模型若違規（派了子代理），服務端在 `agent_end` 檢測到本輪沒產出 JSON → 按 fail + 記一次異常     |
| D7  | **執行側不引入新 JSON 契約，只保留審查者 verdict 一個結構化出口**            | 解析面越小越穩（現有 `parseReviewerVerdict` 雙兜底已單測覆蓋）                                                                         | 執行者的"完成度"由工作區實測 + 審查者判定，不靠執行者自報                                                       |
| D8  | **`delegated` 配置下，執行者的產物交接 = 服務端取"最後一條 assistant 文本"** | 與 `self` 讀 `getLastAssistantText()` 同口徑；不引入新工具                                                                             | 想看細節時，人/審查者用 `conversation(action:"read", view:"chat")`（v1 誤以為 `subagent_get_result` 能帶 view） |
| D9  | **A/B 共用一份協議欄位與一份狀態機**                                         | 兩個槽位 = 同一結構的兩份例項；避免兩套並行實現                                                                                        | 協議裡用 `roles: { executor?, reviewer? }` 而不是 `planA/planB` 兩串欄位                                        |
| D10 | **不為目標模式新增工具**（不需要 `goal_role_spawn` 之類）                    | 角色對話由服務端通過 host 回撥拉起；模型側只用現成 `subagent_*`（且明確限制其用途）                                                    | 也就避開了"新增可開關工具動三處 + FACTORY_TOOLS 單測"的全套流程                                                 |

---

## 7. 改動清單（對齊倉庫硬約束）

### 7.1 協議（單源 `server/protocol.ts`，`scripts/check-protocol-sync.mjs` 守護）

```ts
export interface GoalStatus {
	// …現有欄位全部保留
	/** 2.0：審查配置。"self"（預設，現狀）| "reviewer"（主對話執行）| "delegated"（主對話審查）。 */
	reviewMode?: "self" | "reviewer" | "delegated";
	/** 2.0：迴圈相位，供 GoalBar 顯示與輸入降級。 */
	phase?: "idle" | "dispatching" | "executing" | "reviewing" | "blocked";
	/** 2.0：執行模型（"provider/id"；null = 跟隨，delegated 配置用）。 */
	execModel?: string | null;
	/** 2.0：兩個槽位的當前承載對話（主對話時 convId === conversationId）。 */
	roles?: {
		executor?: { convId: string; spawned: boolean; state?: string };
		reviewer?: { convId: string; spawned: boolean; state?: string };
	};
}
```

- 全部可選（`undefined` = 舊行為），前端不認識就忽略。
- 複用既有 `switch_conversation { id }`（`protocol.ts:533`）實現「👁 開啟角色對話」，不需要新訊息。
- 角色偏好（`reviewMode` / `execModel` / 留檔開關）隨既有 `set_goal_prefs`（`protocol.ts:797-823`）擴充套件欄位，落 `client-state.json`（與 `reviewModel` 同口徑）。

### 7.2 服務端

| 檔案                           | 改動                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/goal-service.ts`       | `runGoalReview` 拆成 §4.2 六步；新增 `RoleAgent` 狀態、`reviewMode` 分支、`REVIEW_DEADLINE`、失聯降級；`startRoleRound/waitForRole/applyVerdict` 純函式化（可單測）；錯誤特徵取數改為 executor 會話（§4.5） |
| `server/agent-service.ts`      | 實現 §4.4 的 8 個 host 回撥；`spawnSubagentConversation` 增 `permissionPreset`/`role` 可選引數；`onEvent` 的 `agent_end` 鉤子（`:5085` 附近）加"角色輪結束"通知；`GoalHost` 接線（`:3525-3545`）            |
| `server/subagent-templates.ts` | 內建兩個模板 `goal-executor` / `goal-reviewer`（預設建立，可被使用者改/停用）：reviewer 模板 = append 模式 + 明確只讀契約 + `enabledExtensions` 非空；表面無新增欄位（D2）                                  |
| 遷移                           | 啟動時若使用者已有 `reviewPrompt`（`client-state.ts:246`），把它塞進 `goal-reviewer` 模板的 `systemPrompt`（append），只做一次 → 避免兩個配置面                                                             |

### 7.3 前端 / 設定面 / i18n

| 檔案                                   | 改動                                                                                                                                                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/src/components/GoalBar.tsx`       | 活躍行增：`phase` 文案、`👁 開啟執行/審查對話`；兩個新宿主 id 必須進 `GOAL_DEFAULT_ORDER`（slot 順序驅動，見 `docs/agent-rules.md`「UI 擴充套件點與浮層規則」） |
| `web/src/components/SettingsModal.tsx` | 「目標審查」區（`:3718` 一帶）增三檔 `reviewMode` 單選 + 執行模型下拉 + 留檔開關                                                                               |
| `web/src/i18n.tsx` + `locales/*.json`  | 新文案兩邊都加（`tests/unit/locales.test.ts` 鎖對齊）；改完跑 `npm run changelog:i18n`；**value 只許字串字面量**（i18n-diff 手寫解析器）                       |
| 服務端 i18n (`pick`)                   | 新 key `goal.role.*` 全域性唯一；多行走 `getServerBlock`；notice 用 `text`+`textEn`                                                                            |

### 7.4 測試

| 層     | 內容                                                                                                                                                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 單測   | 新建 `tests/unit/goal-role-loop.test.ts`：用 **fake GoalHost**（先例見 `tests/unit/goal-wizard-target.test.ts`）指令碼化 verdict，斷言輪次推進/pass/revise/blocked/降級/代次作廢/失聯重建；`parseReviewerVerdict` 複用不動 |
| 單測   | `tests/unit/goal-autonomous.test.ts` 擴充套件：`self` 配置行為零變化（迴歸護欄）                                                                                                                                           |
| 冒煙   | `tests/run-smoke.mjs` 的 ALL 列表裡擴充套件 `goal-prefs-test`（新偏好往返）；`goal-test` 增 `reviewMode` 分支                                                                                                              |
| 真模型 | `goal-review-loop`（live）加一條：`reviewMode="reviewer"` 全流程 + 左欄出現角色對話 + 清目標后角色對話被 dismiss                                                                                                           |
| 手工   | 埠 ≥8900、data-dir `mkdtempSync` 隔離、精確清理自己程序、**禁 `pkill -f`**（AGENTS §5）                                                                                                                                    |

---

## 8. 里程碑

| PR                        | 內容                                                                                                                            | 依賴   | 驗收                                                                            | 回滾                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **PR-1**                  | GoalHost 8 回撥 + `runGoalReview` 換實現（`reviewMode="reviewer"`）+ 內建 `goal-reviewer` 模板 + 只讀預設 + deadline + 失聯降級 | —      | `reviewMode="reviewer"` 下：審查可見、複用同一 convId、超時不再卡死、配額滿降級 | 新增欄位可選，`reviewMode` 預設 `self`；單 PR revert |
| **PR-2**                  | 前端：GoalBar 相位/`👁` 按鈕 + 設定面板三檔 + i18n + 遷移（D5）                                                                  | PR-1   | 老使用者 `reviewModel` 已設 → 自動進入 `reviewer` 並收到一次性提示              | 前端可回退，服務端行為不變                           |
| **PR-1.5**（可併入 PR-1） | reviewer 模板編輯面（複用既有子代理模板設定 UI，無需新欄位）                                                                    | PR-1   | 只讀契約/擴充套件白名單視覺化可改                                               | 獨立 revert                                          |
| **PR-3**                  | `delegated` 配置（§5.2）+ `execModel` + 審查期輸入策略                                                                          | PR-1/2 | A 案：執行期主對話可用、審查回合只佔一次往返、輪次預算生效                      | `reviewMode` 切回 `reviewer`/`self`                  |
| **PR-4**                  | 與 #389 Phase 1 合流：審查契約帶 `planManager.describePlan(convId)`（逐項核對步驟）                                             | PR-1   | 有計劃時 verdict 能引用步驟狀態                                                 | 契約段可選                                           |

> 與 #389 的另兩個合流點：#389 Phase 2 的 plan gate 與 D2 的 `permissionPreset` 門控**同一套程式碼**，建議同 PR 或緊鄰落地；#385/PR #386 是獨立 bug 修復，先合。

---

## 9. 風險與回滾

| 風險                                                          | 緩解                                                                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 審查權從「服務端確定性」變成「模型自律」，JSON 契約遵從率下降 | 保留現有雙解析兜底（`parseReviewerVerdict`：平衡括號 → 寬鬆正則 → 都沒有按 fail + raw 當 feedback）；契約加 few-shot；遵從率下降時可配置重試一次             |
| 模型違規自迴圈 / 謊報輪次                                     | 輪次編號由服務端寫進契約；`agent_end` 校驗"本輪是否真產出了 verdict JSON"，沒有就按 fail + 記異常（D6）                                                      |
| 角色對話被外部關掉 / 服務重啟                                 | §4.6 失效矩陣：reviewer 重建一次，executor 報受阻等使用者處置；GoalBar 顯示"角色對話已失聯"並可重開                                                          |
| 子代理併發或顯式配置的普通對話配額被目標模式吃滿              | 角色對話**落盤**（預設不限普通對話數量；顯式配置上限且滿員時 spawn 拋錯 → 降級為 `self` + 明確提示）；每個目標最多 1 個 executor；清目標即移出（轉錄留歷史） |
| 只讀被繞過（自研外掛直接寫檔案）                              | 明確定位為"盡力而為"；模板擴充套件白名單已擋掉外掛/MCP 工具；如要更嚴再加 `SubagentTemplate.tools`（D2 的後續）                                              |
| `delegated` 的 review turn 判定誤傷使用者插話                 | 只在服務端 `awaiting_verdict` 標記期間把 `onAgentEnd(main)` 當審查結果；其餘 agent_end 一律忽略（單測覆蓋）                                                  |
| 配額/超時/失聯的疊加態                                        | 全部收斂到 §4.6 一張矩陣，每行一個可測用例（fake host 驅動，不需要真模型）                                                                                   |

**回滾策略**：延續 v1 —— 全部新行為掛在既有總開關 `goalModeEnabled` 之下；`reviewMode` 預設 `self`（= 今天）；協議新增欄位全可選；`self` 路徑（自治 + 熔斷）**一行不動**，任何 PR 單獨 revert 都不影響老行為。

---

## 10. 參考

- 程式碼：`server/goal-service.ts`（狀態機 / `runGoalReview:1148` / 自治路徑 `:1231` / 契約 `reviewerPrompt:1074`）、`server/subagents.ts`（子代理=對話、工具集、`WAIT_CAP_MS:42`）、`server/agent-service.ts`（`spawnSubagentConversation:2382`、`steerSubagent:2999`、`toSubagentSnapshot:2585`、customTools `:3977`、許可權門控 `:3917/:7360`、`makeConversation:4107`、看門狗 `:4415`、過戶 `:12369`）、`server/subagent-templates.ts`、`server/plan-manager.ts:110`、`server/conversation-read-tool.ts:228/327`
- 協議：`server/protocol.ts`（目標訊息族 `:729-745`、`switch_conversation:533`、`dismiss_conversation:1048`、`GoalStatus:1382`、`PlanStep:1220`、`UiState.plan:208`）
- 前端：`web/src/components/GoalBar.tsx`（`GOAL_DEFAULT_ORDER` + slot 合併）、`web/src/components/SettingsModal.tsx:3718`、`web/src/i18n.tsx`
- Issue：#385（AI 提煉超時，PR #386 待合）、#389（Goal & Plan）
- 主題文件：`docs/architecture-core.md`（快照驅動 / 協議單源）、`docs/architecture-plugins.md`（UI 擴充套件點與 slot 相容）、`docs/agent-rules.md`（禁令清單）

---

## 11. 實施記錄：Plan A（🧭 `delegated`）已落地

> 本節描述**當前程式碼的真實行為**（v2.1）；上面 §4 的抽象與本節一致，§5.2 的「v2 寫法」即下表的實現。

### 11.1 落地位置

| 層     | 位置                                                                      | 內容                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 協議   | `server/protocol.ts`                                                      | `GoalReviewMode`（`self` / `delegated`）、`GoalRoleRef`、`GoalStatus.{reviewMode,phase,execModel,roles}`；`set_goal` / `set_goal_prefs` 各加 `reviewMode?` / `execModel?`（全可選，`undefined` = 舊行為）                                                                                                                                                                                                                                             |
| 偏好   | `server/client-state.ts`                                                  | `goalPrefs.{reviewMode,execModel}`（全域性記憶，隨 reload 恢復）                                                                                                                                                                                                                                                                                                                                                                                      |
| 迴圈   | `server/goal-service.ts`                                                  | `isDelegated` / `roleBridgeReady` / `roleDeadline` / `isCurrentDelegated` / `startDelegatedLoop` / `runDelegatedLoop` / `dispatchExecutor` / `sampleRound` / `askDelegatedReview` / `waitMainIdle` / `deliverAndWait` / `deliverDelegatedVerdict` / `finishDelegated` / `degradeToSelf` / `stopDelegated`；契約文案 `executorRoundPrompt` / `reviewerRoundPrompt` / `verdictRetryPrompt` / `roleFailureText`；純函式 `extractErrorSnippetFromSession` |
| 宿主橋 | `server/agent-service.ts`                                                 | GoalHost 新增 `spawnRoleAgent` / `waitRoleAgent` / `sendRoleAgent` / `readRoleAgent` / `stopRoleAgent` / `dismissRoleAgent` / `hasConv` / `roleDeadlineMs`；回合結束等待者 `turnEndWaiters` + `waitConversationTurnEnd` / `roleOutcomeOf` / `notifyTurnEnd`（agent_end 與中止路徑各喚醒一次）；`conv.kickoff` 記錄 spawn 的投遞 Promise；`removeConversation` 喚醒等待者為 `gone`                                                                     |
| 前端   | `web/src/components/GoalBar.tsx`、`ui-slots.ts`、`i18n.tsx`、`styles.css` | 執行方式開關（⚡ 直奔 / 🧭 委託）、委託執行者模型下拉、活躍行「執行對話」一鍵開啟（`switch_conversation`）；三個新宿主 slot id（`host:goal-mode` / `host:goal-execmodel` / `host:goal-openrole`）+ `.goalbar-btn.mode` 樣式                                                                                                                                                                                                                           |
| 測試   | `tests/unit/goal-delegated.test.ts`、`tests/goal-delegated-test.mjs`      | 8 個 fake-host 單測（派活/審查/pass/fail 續輪/無 JSON 重試/熔斷/超時降級/清目標代次作廢）+ 零 token 端到端冒煙（已在 `tests/run-smoke.mjs` 的 ALL 列表）                                                                                                                                                                                                                                                                                              |

### 11.2 與 v2 設計的差異（以實現為準）

| #   | v2 設計                                     | 實際實現                                                                                                                                                                                                                                                                                             | 原因                                                                                                                     |
| --- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | 審查期把主對話臨時置 `read-only`            | **未啟用**：只靠契約「只讀核實」約束                                                                                                                                                                                                                                                                 | 主對話是使用者自己的會話，臨時改它的許可權預設侵入性太強；executor 有寫許可權是必須的（它就是幹活的）                    |
| 2   | `goal-executor` / `goal-reviewer` 內建模板  | **未建模板**：角色對話用主會話預設配置                                                                                                                                                                                                                                                               | Plan A 的審查者是主對話、執行者不需要收窄技能/擴充套件；模板留給 Plan B 的 reviewer                                      |
| 3   | 留檔開關（`persist` 可選）                  | **已改為落盤 `persist=true`**（普通持久化對話，`conv-` 字首，轉錄進歷史）。代價：① 持有普通對話 runtime（預設不限數量；顯式配置上限且滿員時 spawn 拋錯 → 降級 self + 明確提示）；② 左欄不再有「子代理」微標 → 改用 `[目標執行] <目標摘要>` 標題保持可辨識；③ 完成/受阻後移出左欄但轉錄留在歷史可回看 | 實施反饋“希望落盤”：執行者轉錄能回看、別隨服務重啟就消失。代價已在上方列明，並各有補償（降級提示 / 標題字首 / 歷史回看） |
| 4   | 審查 deadline 建議 10 分鐘                  | 與執行輪統一 = 工具看門狗（預設 20 分鐘，`roleDeadlineMs()`）                                                                                                                                                                                                                                        | 一個旋鈕更好解釋；審查也可能跑長測試                                                                                     |
| 5   | 熔斷「先問審查者，獨立於 verdict 計算」     | 取樣後、**問審查者之前**就判熔斷                                                                                                                                                                                                                                                                     | 停滯/同錯是服務端實測訊號，先判可省下整輪審查 token                                                                      |
| 6   | （未展開）目標進行中改執行方式              | 只記偏好 + notice，**下一個目標生效**                                                                                                                                                                                                                                                                | 半途換軌會留下孤兒迴圈、丟掉執行者記憶（換模型對已存在的執行對話也無效）                                                 |
| 7   | 審查無 JSON → 按 fail 處理 / 或重試一次     | 「收緊契約」重試 **1** 次，仍無 → `blocked` 收尾（保留目標）                                                                                                                                                                                                                                         | 避免把「模型沒按契約回」誤記成一整輪失敗並繼續燒 token                                                                   |
| 8   | （實施後補）失聯/中止 = 停止                | 執行對話被移出 / 被手動中止（子代理 ⏹）= **終點事件**：迴圈立即收束（blocked）、清掉指向死對話的 `roles`、**不再派下一輪**                                                                                                                                                                           | 實施反饋：“關掉執行對話後它又自己啟動” —— 中止/關閉就是要停；執行者記憶已失，換人幹不如停                                |
| 9   | （實施後補）停止按鈕                        | 目標條 ✕ 原本 `disabled={goal.reviewing}`，而委託迴圈全程 `reviewing=true` —— 恰在最想停的時候沒得停。改為**始終可點**：迴圈中變紅色「■ 停止目標」，點它 = `clear_goal`（停掉並移出執行對話）                                                                                                        | `clearGoal` 本就能安全停（代次守衛），按鈕停用沒必要；受阻文案也補了“點 ■ 停止目標退出”的指引                            |
| 10  | 三種配置並存（self / reviewer / delegated） | **只保留 delegated**：`reviewMode` 欄位與模式開關（⚡/🧭）全部刪除；v1 的 self 路徑（隱藏隔離審查會話 + 自治標記 `GOAL_COMPLETION_RE`）整段刪除                                                                                                                                                      | 產品決策：只保留新模式。DSH 引擎有自己的目標實現，不受此影響                                                             |
| 11  | spawn 失敗 → 降級 self；缺角色橋 → 降級     | 改為**沒有降級**：缺橋 → `setGoal` 在動目標狀態前就拒絕；spawn 失敗（配額滿）→ `abortOnSpawnFailure` 當場中止並把原因擺上目標條                                                                                                                                                                      | 既然只剩一條路徑，降級等於「偷偷換一種行為」；寧可響亮失敗                                                               |
| 12  | `GoalStatus.reviewModel` = 審查模型         | 欄位**保留**（DSH 的 `makeGoalStatus` 仍構造它，刪了要動 DSH），但 pi 側語義改為**調研（嚮導）模型**記憶位；pi 目標審查不再有獨立模型（審查者就是當前對話）                                                                                                                                          | 相容優先 + 前端把下拉文案改成「調研模型」，不新增欄位也不動 DSH                                                          |

### 11.3 關鍵實現細節（踩過的坑）

- **spawn 的投遞是 fire-and-forget**：`spawnSubagentConversation` 裡 `sendUserMessage` 不 await，服務端緊接著「等本回合結束」會把「還沒開跑」誤判成「已跑完」（空取樣 → 下一輪派活撞車）。解決：`conv.kickoff` 記下投遞 Promise + `waitConversationTurnEnd` 的 3s 啟動寬限。
- **`steerSubagent` 對已消失會話靜默 no-op**：迴圈每步前用 `hasConv` 判存在性，失聯按 `blocked` 收尾（不靜默換個「新人」繼續）。
- **取數口徑**：停滯指紋吃工作區 `git diff`（與主對話同一個 cwd），錯誤特徵吃**執行者會話**（`readRoleAgent` 返回的 `errorSnippet`）——主對話作為審查者，它的工具報錯不代表執行受挫。
- **使用者插話**：審查指令投遞前先 `waitMainIdle`（等主對話空閒，最多一個 deadline），否則會被當成 `steer` 插進使用者自己的回合。
- **代次守衛**：`stopDelegated` 喚醒 verdict 等待者為 `gone`；遲到的 verdict 因 `awaitingVerdict` 已清 / 代次不符而被丟棄（單測覆蓋）。
- **「中止 / 關閉就是停止」**：`waitRoleAgent` 返回 `canceled`（子代理被 ⏹/abort）或 `gone`（對話被移出 / 服務重啟）時，迴圈**立即收束**，不再 steer 下一輪；只有 `error` / `timeout`（可恢復的失敗）才在預算內進下一輪。停掉後 GoalBar 的「■ 停止目標」隨時可點。
- **摺疊態只是一枚藥丸，不是面板**：收起時 `GoalBar` 只渲染 `.goalbar-collapsed`（**刻意不帶 `.goalbar` 類**）—— `.goalbar` 那套邊框/底色/圓角/內邊距在收起時全是多餘，主題再用 `.goalbar { border-top: … !important }` 一畫，就是一條橫跨整列的帶子橫在最後一條訊息上把它切斷（實報「摺疊時一整行遮擋底部訊息」）。藥丸行自帶 `min-width:0` + `max-width:100%` + `overflow:hidden`，外掛往 pill 行貢獻條目也頂不寬。守衛：`tests/unit/goalbar-collapsed-pill.test.ts`。

### 11.4 驗證狀態（本次本地實施）

- `npm run check:protocol` ✓ · `tsc -p tsconfig.server.json` ✓ · `oxlint`（改動檔案零告警）✓ · `prettier --check` ✓
- `vitest run`：3082 passed（含 delegated 單測 11 例）；`goal-test` / `goal-prefs-test` / `goal-delegated-test` 冒煙全綠
- 既有失敗（與本改動無關，實施前即存在）：`tests/unit/read-dir.test.ts`（SDK `ls` 拋 Path not found）、`tests/plugin-test.mjs`（測試內 fetch body 二次讀取）

### 11.6 審計修復（目標模式全功能審計，A1–A6）

> 2026-09：對委託迴圈的六處設計缺陷修補（探針見 `tests/unit/goal-delegated.test.ts` 的 A1–A6 迴歸例 + `goal-review-pure.test.ts`）。全部向後相容：協議零新增欄位，`GoalHost.isGitRepo` 缺席即按舊行為。

| #     | 修補                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 位置                                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A1    | **熔斷提到 outcome 分支之前 + 執行連敗熔斷**：`sampleRound` 後先判 `sameError/stagnant ≥ 2`，不再被 `error/timeout → continue` 跳過；新增 `conv.failedRounds`（done 即清零），error/timeout 連續 2 輪（`EXEC_FAILED_ROUNDS_LIMIT`）直接 `blocked` 並給出 `timeout-repeat` / `error-repeat` 文案 —— 預設「不限輪」下不再無限空轉                                                                                                                                                                                                                                                                                                                                                                                                                                        | `goal-service.ts` `runDelegatedLoop` / `roleFailureText`                                                        |
| A2    | **非 git 目錄跳過停滯計數**：`GoalHost` 新增可選 `isGitRepo(cwd)`（缺席 = 預設有，老 fake host 不動）；不可用時 `stagnantRounds`/`lastDiff` 凍結，錯誤與連敗熔斷照常。pi 宿主用 `git rev-parse --is-inside-work-tree` 實現。純問答/回答類目標不再第 2 輪被誤熔斷                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `goal-service.ts` `sampleRound`、`agent-service.ts` 接線                                                        |
| A3    | **重設目標排隊接力**：`startDelegatedLoop` 不再 `has → return` 靜默丟棄，改記 `delegatedPending`；舊迴圈 `finally` 裡消費並啟動新迴圈（代次過期則首個守衛即退出）。`stopDelegated` 順帶清排隊項。`setGoal` 緊跟 `clearGoal` 不再留下「等待生成…卻永不派活」的死目標                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `goal-service.ts`                                                                                               |
| A4    | **審查回合 abort 只作廢本次審查**：`onAgentEnd(aborted)` 若 `awaitingVerdict` 非空 → settle `invalid`（走無 JSON 重試/受阻）+ 返回「審查回合已中止」notice，目標與執行對話保留。此前是整個目標連同執行者一起清掉                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `goal-service.ts` `onAgentEnd`                                                                                  |
| A5    | **verdict 取最後一個合法 JSON**：`parseReviewerVerdict` 全掃平衡 `{...}`，最後一個 `verdict: pass\|fail` 勝出（正則兜底同樣）；審查契約的兩個完整示例改為欄位說明 + 不可解析佔位符 `{"<pass\|fail>"}`，模型複述示例不再假通過                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `goal-service.ts` 解析器 + `reviewerRoundPrompt`                                                                |
| CLEAN | **多輪沉積清理**：刪只寫不讀的 `verdictRetry`、v1 殘留 `goalReviewGeneration`（兩介面 + 初始化 + 測試 fake）、零呼叫的 `reviewPrefs` getter ×2、GoalBar 死串 `host:goal-mode`；`clearGoal` 裡重複的 `goal.reviewing = false` 去重；提 `resetLoopCounters` / `clearGoalFields` / `roundBudgetOf`（四處重置點 + 兩處預算計算收斂，`finishDelegated` 的展示用預算保持原語義）；`detachRoleExec` 收斂 stop/dismiss 兩處（finish 側保留 await 保收尾順序，stop 側 fire-and-forget 保同步上下文，pending 誤刪迴歸 A3 已排除）；`RoleAgentRead` 型別三處複用；`reviewCardText` 走 `roundsLabel` + 顯示鉗制後預算；`allBalancedJsonObjects` 輸入封頂 32k 取尾（平方級掃描防超長回覆）；`lastToolNameOfSession` 註釋與實現對齊；fold 複用 `asText` 刪本地重複實現               | `goal-service.ts`、`agent-service.ts`、`settings-service.ts`、`GoalBar.tsx`、`goal-review-fold.ts`、兩測試 fake |
| UX1   | **審查回合折疊**：契約（審查指令 + 重試指令，中英）末尾加穩定機器行 `[goal-review]`；前端 `goal-review-fold.ts` 識別指令與純 verdict JSON，`MessageList` 預設渲染成 `CollapsedMessage` 摘要行（指令→審查中…/結論→已通過·未通過，複用既有 key 零新增文案），點開展開（`expanded` 記憶）；`CollapsedMessage` 加可選 `summary` prop。帶閒話的非純 JSON 保持展開                                                                                                                                                                                                                                                                                                                                                                                                           | `goal-service.ts`（標記）、`goal-review-fold.ts`（新）、`MessageList.tsx`、`CollapsedMessage.tsx`               |
| UX2   | **執行者即時進度**：`GoalRoleRef` += `streaming?/activity?/activityEn?`（輪次邊界重新整理，非每 token）；`GoalHost.readRoleAgent` += 同名 vitals（老 host 缺欄位即跳過）；`snapshotExecutor` 在派活/取樣點重新整理（在跑+有工具→「xx 執行中」，否則自述頭 60 字）；目標條 detail 行展示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `protocol.ts`、`goal-service.ts`、`agent-service.ts`、`GoalBar.tsx`                                             |
| UX3   | **輪次/預算 + token 視覺化**：晶片按預算顯示 `第 N/M 輪`/`第 N 輪·不限`（前端按現有 key 組裝，零新增文案）；用量累計（執行者派活-取樣差值 + 審查者投遞-verdict 差值，`getSessionStats` 只在輪次邊界讀）→ `GoalStatus.usage?` → 目標條 `· 1.8k tokens`（title 給精確值）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `protocol.ts`、`goal-service.ts`、`agent-service.ts`（stats 取數）、`GoalBar.tsx`                               |
| UX4   | **目標歷史**：`GoalHistoryEntry`（目標/終態/輪次/原因/時間）+ `GoalStatus.history?`；`finishDelegated` 全終態與 `abortOnSpawnFailure` 落袋（cap 20，記憶體態，清目標不清空）；目標條編輯行「歷史 (N)」下拉（無新 slot，直接渲染），點條目回填輸入框（不直髮）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `protocol.ts`、`goal-service.ts`、`GoalBar.tsx`、`i18n` + 8 語言包（`goalHistory`）                             |
| B3    | **審查卡片 + 插話順延**：服務端開始發 `goal-review` custom 卡（前端 `Message.tsx` 的專屬卡片分支與 `msg-goal-review` 樣式早已存在，只缺傳送方，零協議/前端改動）—— 審查開始卡（`deliverAndWait` 投指令前）+ 結論卡（pass/fail 人話，裸 JSON 仍在流裡但不再是唯一載體）；`prompt()` 入口處純文本 steer 插話順延（`shouldDeferPromptForReview` 純函式：followUp/斜槓直通，帶附件響亮拒絕保草稿），verdict 落定後 `flushDeferredPrompts` 按序 followUp 發出（take 語義，`deliverAndWait` 與 `stopDelegated` 互斥、先到先得）—— 一次插話再也燒不掉整個目標                                                                                                                                                                                                                 | `goal-service.ts`（卡片 + 佇列）、`agent-service.ts`（`prompt()` 順延）、`goal-review-gate.ts`（判定）          |
| B1    | **審查回合硬閘門**：新模組 `server/goal-review-gate.ts`（純函式 `goalReviewDenial`，單測 `goal-review-gate.test.ts` 9 例）—— 寫類 / 非常規 bash / 派發類（D6：輪次由服務端控制，禁 spawn/steer/stop/wait/排程/改模式開目標）/ `ask_user_question` 在 `awaitingVerdict` 置位期間一律拒；`agent-service.ts` 加 `withGoalReviewGate`（最外層）+ `goalReviewTurnOf(ownerId)`，三處包裹點（`customTools` `.map` / `planGate` 覆蓋 / `edit` 的 soft 分支）+ 常駐終端 `checkSafety`；閘門無狀態，verdict 落定自動恢復。bash 在計劃白名單之外另放測試形狀（`npm test` / `npx vitest` / `pytest` / `go test` 等，`npm run deploy` 照拒），兌現契約「跑測試」承諾；契約文案加一句硬攔截預告。已知侷限（與計劃/審查者閘門同口徑）：動態補入的外掛工具、自研外掛直寫檔案不在覆蓋面 | `goal-review-gate.ts`（新）、`agent-service.ts`、`goal-service.ts`（契約一句）                                  |
| B4    | **總開關關閉停掉在飛目標**：`SettingsHost` 新增可選 `onGoalModeDisabled`，`set()` 在 on→off 躍遷時調一次（預設不帶總開關，`set()` 是唯一變異點）；pi 宿主接到 `GoalService.stopAllGoals()` —— 所有在飛迴圈按代次作廢 + 執行者停並移出 + 目標狀態清空 + 發 notice，無在飛目標/調研時無聲；在跑的調研嚮導一併中止（`clearGoal` 的中止塊抽成 `abortWizard()` 複用）                                                                                                                                                                                                                                                                                                                                                                                                       | `settings-service.ts`、`agent-service.ts` 接線、`goal-service.ts` `stopAllGoals`                                |
| B5    | **quiesce 排空不再派新一輪**：`setGoal` 排空期直接拒絕（宿主 `quiesceBlocked()` 自帶 notice，清目標不受影響）；迴圈頂排空檢查 → `blocked` 收尾 + `quiesce` 原因文案（存量回合跑完，下一輪不再派，與設計文件 §4.6 同口徑）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `goal-service.ts` `setGoal` / `runDelegatedLoop` / `roleFailureText`                                            |
| B7    | **活躍晶片跟隨 `phase`**：`reviewing` 期 `phase === "executing"` 顯示「執行中…」，否則「審查中…」（缺席回落舊行為）。新增 `goalBarExecuting` 文案（`i18n.tsx` 中英 + 8 語言包同位 + `changelog:i18n`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `GoalBar.tsx`、`i18n.tsx`、`locales/*.json`、`goalbar-phase-chip.test.ts`                                       |
| A6    | **blocked/exhausted 也移出執行對話**：`finishDelegated` 頂部統一 `stop + dismiss` 並清 `roles`（轉錄已落盤，歷史可回看）。此前只有 pass 移出，受阻常駐佔「每專案 8 個普通對話」名額，連續失敗目標會把名額吃滿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `goal-service.ts` `finishDelegated`                                                                             |
| B8    | **計劃看板審查聯動與嚮導步驟提取（#389 Phase 1）**：`GoalHost` 接入 `getPlan`/`describePlan`/`setPlan`；審查契約（`reviewerRoundPrompt`）自動注入當前會話的 `describePlan` 看板摘要，消除驗收盲區；嚮導（`startGoalWizard`）產物經 `parseWizardOutput` 解析結構化 `STEPS:` 並自動注入 `PlanManager`，嚮導落地後步驟看板立即可見                                                                                                                                                                                                                                                                                                                                                                                                                                        | `goal-service.ts`、`agent-service.ts`                                                                           |
| B9    | **審查者輸入補齊「執行者到底跑了什麼」（#543 §1）**：新模組 `server/goal-evidence.ts`（純函式 `collectToolEvidence` / `formatEvidenceDigest` / `sessionMessagesOf` / `buildEvidenceDigest`，單測 `goal-evidence.test.ts`）；`GoalHost` 新增**可選** `readRoleEvidence(convId)`（`agent-service` 用執行者會話最近的 `bashExecution` / `toolResult` 生成：工具名 + 引數提示 + 輸出尾部，單條 400 字元、整段 6000 字元封頂，超出丟最早並標註）；`reviewerRoundPrompt` 在「執行者本輪自述」後注入證據段 —— 缺席 / 讀失敗 = 不注入（老 host、fake host 零改動）                                                                                                                                                                                                             | `goal-evidence.ts`、`goal-service.ts`、`agent-service.ts`                                                       |
| B10   | **判定口徑四條 + 空 feedback 兜底（#543 §2/§3）**：審查契約（中英雙模板）內建「只判本輪**聲稱完成**的條目 / 未聲稱的後續階段不構成 fail / 忽略與目標無關的本地改動 / 無命令或檔案證據必須 fail 並點名缺哪條輸出 / feedback 不得為空」；`ensureReviewerFeedback` 統一在 verdict 落地處兜底（fail 且上一輪有意見 → 沿用並標註，兩輪都空 → 給可執行的失敗說明，pass 且無說明 → 不編造理由只補中性標註），審查結論卡與下一輪執行者提示詞共用同一份文案。迴歸：`goal-delegated.test.ts` E1–E5                                                                                                                                                                                                                                                                               | `goal-service.ts`                                                                                               |

### 11.5 已知遺留 / 後續

1. **審查者只讀門禁未啟用**（D2 的一半）：主對話是使用者自己的會話，審查回合靠契約「只讀核實」約束，沒有臨時改它的 `permissionPreset`。要硬門禁需實現「按 convId 設許可權」（§4.4 已列該回調）。
2. **過戶（takeover）**：執行對話隨父對話搬（`collectSubagentDescendantIds`），但 `goal` 狀態不搬 → 新持有方需重設目標；未做自動續跑。
3. **服務重啟**：goal 狀態是記憶體態（重啟即丟）；執行對話**已落盤**，轉錄可在歷史裡回看，但迴圈不會自動續跑。
4. **計劃聯動（#389 Phase 1）**：已完成（見 B8，審查契約帶 `describePlan`、嚮導產出帶步驟看板）。
5. **DSH 引擎**：仍是它自己那套目標實現（模型自判定 + round-driver），未接入執行對話模式；設定裡的 `reviewPrompt` 對它仍然有效。
