[English](./dsh-engine.en.md) · [简体中文](./dsh-engine.md) · **繁體中文**

# pi-web-ui × DeepSeek Harness（dsh）雙引擎改造 —— 工作交接文件

> 本文件是**跨對話交接**用：記錄已定決策、已完成工作、進行中/受阻狀態、剩餘計劃與所有環境事實。
> 新對話開始時：**先讀本檔案**，再讀 `E:/pi-web-ui/server/dsh/` 下的程式碼與註釋，按"下一步做什麼"繼續。
> 當前時間：2026-09-01 凌晨（對話推進到 dsh 引擎核心對話全鏈路驗證通過）。

---

## 0. 目標（使用者拍板的三項決策）

1. **引擎可切換**：`PI_WEB_ENGINE=pi|dsh` 環境變數啟動時切換（預設 pi），重啟生效；前端顯示引擎徽標；`/api/health` 返回 `engine` 欄位。
2. **介面功能完全一樣**：dsh 引擎要按現行 pi-web-ui wire 協議（protocol.ts）全量對齊 —— 目標/審查、SCM、後臺任務、設定面板、模型配置、外掛、終端、訊息增量（message_delta/快照/snapshot_delta/tool_status）全都工作。
3. **架構 = 服務端引擎分發**：保留現有 pi 路徑零改動；新增 `server/dsh/`（從 ds-web-ui 移植適配 + 升級到現行協議）；`server/index.ts` 按引擎選擇實現類。同一 wire 協議，前端改動極小。

---

## 1. 環境事實（實測，勿重查）

| 項                      | 值                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工作區                  | `E:/pi-web-ui`（pi-web-ui 倉庫，當前專案）                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 參考實現                | `E:/ds-web-ui`（xing-shuyin 的 DSH 版 pi-web-ui 移植，**僅參考**，用的是舊版分散包 `0.1.0-rc.6`）                                                                                                                                                                                                                                                                                                                                                           |
| Node                    | v24.20.0（fnm 管理）                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DeepSeek key            | `~/.pi/agent/auth.json` 的 `deepseek.key`（**2026-09-01 使用者重新提供 sk-f0e6…d99，len 35**），**dsh 執行時能複用**（ds-web-ui 就這麼幹）。⚠️ clear-provider-key-test 會清掉它 —— 跑前備份，跑後恢復（dsh 已尊重 PI_CODING_AGENT_DIR，正常測試不會再碰真實 auth.json）                                                                                                                                                                                     |
| 全域性 dsh 執行時       | 推薦安裝最新版（如 `npm i -g @deepseek-ai/dsh` 或 `@deepseek-ai/dsh@0.2.1-rc.2`）。其**巢狀樹** `dsh/node_modules/@deepseek-ai/`（300+ 個包）即完整執行時樹（dsh-base/dsh-app-boot/全部工具/loader peers 都在）。⚠️ **dsh-base 不在頂層 `npm root -g/@deepseek-ai/`（只有 dsh 一個包），執行時樹解析必須查巢狀位置**（runtime-root.mjs 已處理）                                                                                                             |
| pi-web-ui 本地 dsh 依賴 | 已在 package.json 更新為最新：`@deepseek-ai/dsh-sdk-jsonrpc-server@^0.2.1-rc.2`、`@deepseek-ai/dsh-sdk-protocol@^0.2.1-rc.2`。`goal-rpc.mjs` 會自動優先連結當前執行時樹同源依賴，實現同樹自洽。                                                                                                                                                                                                                                                             |
| **版本族與相容策略**    | 最新基線對齊：`dsh@0.2.1-rc.2`、`dsh-sdk-jsonrpc-server@0.2.1-rc.2`、`dsh-sdk-protocol@0.2.1-rc.2`。版本族按 major.minor（如 `0.2`）劃分。✨ **預設寬鬆執行策略（不限制版本預設最新）**：啟動器預設以環境或全域性中檢測到的最新可用執行時嘗試啟動（優先同族最高版本）；若遇到不同版本族僅列印提示資訊而不做提前退出，儘可能向前相容；僅在真正 boot 失敗且版本不符時才給出版本排查建議；若需要強制攔截跨版本混用，可顯式配置 `PI_WEB_DSH_STRICT_VERSION=1`。 |

---

## 2. DSH 研究結論（關鍵，決定實現策略）

### 2.1 JSON-RPC 協議面（官方最新 0.1.5-rc.3，仍是精簡面）

- **RPC 方法僅 3 個**：`initialize`（cwd/provider/model/maxTokens）、`session/prompt`（sessionId + contentBlocks → 返回 `{messageId}`，**按需隱式建會話**）、`shutdown`。
- **通知**：`session.event`（sessionId + event，全量持久事件）、`session.status`（running/idle）、`subagent.started` / `subagent.finished`。
- **官方明確限制**：無 per-session close、無 prompt 取消、無 per-prompt 結果 → **中止 = 強殺執行時程序**，**換模型 = 重啟執行時**，**會話管理/列表/回放 = 直讀 JSONL**。
- 每程序一個 provider/model；`initialize` 無 provider adapter 時自動掛 dsh-llm-deepseek fallback。

### 2.2 執行時組合（已實證可 boot）

- 用 `@deepseek-ai/dsh-app-boot` 的 `boot(binName, configPath, patches, prepare, bareModuleBaseUrl)`：config = 空 `[]`，patches = [dsh-base bundle patch, override patch]。
- **dsh-base bundle** = 官方所有 profile 的共享底座（78 行：llm/session/agent/agent-loop/settings-file/credentials-local/jsonl 持久化/全部工具/goal/plan-mode/skill/subagent/workflow/search/審批）。
- **bareModuleBaseUrl**（裸包名解析的唯一 base）→ 執行時樹；**混樹掛專案依賴的 jsonrpc 外掛必須走絕對路徑**。
- patch 語法鐵律：**重複 base 的 id 用 `- id: … name: … config: …` 定向替換（last-write-wins）；新行用 `- insert: [...]`**。
- ⚠️ **patch 列表必須是扁平結構**：boot 的 patches 引數是"patch entry 列表"（`[{insert:...}, {id:...,...}]`），傳巢狀陣列會被 applyEntryPatches 當無 id 的 entry 靜默跳過（本次踩過的坑，見 §6.10）。
- ⚠️ **loader 只對 entry 的 config 做 !!js 插值，name 欄位不支援 !!js**（disabled 支援）→ jsonrpc 外掛絕對路徑由 launcher 用 JS 寫回 patch entry 的 name（§6.9）。
- ⚠️ **permission-presets 整行 config 全量替換**：approval=never + workspace-write 組合必須顯式補一個 preset（workspace-write-never）並設 defaultPreset，否則報 "composed sandbox and approval defaults match no preset"。
- 無頭執行注意：base 的 approval 策略 `ask` 會卡死工具呼叫 → override 改 `policy: 'never'`（web UI 的 Stop 按鈕是使用者控制手段）。
- `installFailLoud(BIN_NAME, process, release)` 第二個引數是 process 物件不是 pid。
- loader 的 AggregateError 明細在 `err.aggregateErrors ?? err.errors`（逐層 cause 遞迴列印才看得到）。

### 2.3 事件面 ground truth（實測 dump，序列化依據）

`session.event` 通知 params = `{ sessionId, event: { type, seq, time, data } }`：

- **user/message** data: `{ content[], source: {kind}, role, id }`。⚠️ 系統注入訊息的 source.kind = `agent-instructions` / `plugin` / `skill-catalog` / `goal`（workspace 指令/執行時上下文快照/技能目錄/目標輪次，或含 `<system-reminder>`/`<goal_round>`）——必須過濾，否則 UI 顯示垃圾氣泡。
- **assistant/message** data: `{ turn, step, message: { role, content[], id, time } }`（完整訊息；content 裡 reasoning/text/tool-call 塊）。
- **tool/result** data: `{ turn, step, message: { role:"user", content:[{type:"tool-result", toolCallId, content[], isError}] } }`。
- **assistant/chunk** data.chunk: `block-start {index, blockType: reasoning|text|tool-call}`、`reasoning-delta {index, text}`、`text-delta {index, text}`、`tool-call-delta {index, id, name, argumentsDelta}`、`block-end {index, block}`、`usage {usage:{inputTokens,outputTokens,cacheReadTokens}}`、`finish {reason}`。
- **新版執行時換事件面**（老 0.1.1-rc.2 的持久 `assistant/chunk` 已取消）：逐 chunk 輸出改發 agent scope 的
  `agent/assistant-stream`（`{agent, frame}`，frame = `start` / `chunk{index,time,chunk}` / `end`，chunk 形狀與上面同構）；
  一次模型呼叫的 usage 只在結算時隨持久 `assistant/message.usage`（`{inputTokens,outputTokens,cacheReadTokens?,cacheWriteTokens?}`）落一次。
  該直播事件 host 側收不到 → launcher 掛的 wrapper（`runtime/goal-rpc.mjs`）在建構子裡用 `{ global: true }` 訂閱，轉成
  `assistant.stream` 通知（`{sessionId, frame}`）；服務端 `handleAssistantStream` 與老 `assistant/chunk` 共用 `applyStreamChunk`，
  用 `conv.liveChunks` 標記互斥。底欄口徑（上下文佔用 / 快取命中 / 回覆速率）的純對映 = `server/dsh/dsh-usage.ts`。
- **turn/end** data.reason：`{kind: "completed"|"max-tokens"|"error", error?: {message, code}}`。⚠️ 恢復會話時 kind="error" + message 含 "id collision"（見 §2.4）。
- **session/title** data: `{title}`。
- **agent/inbox/spliced** data: `{target, start, inserted: [messages], removedCount}`（prompt 注入；可據此清理 followUp 佇列）。

### 2.4 ⚠️ 關鍵限制（2026-09-15 預設改造已解決大半）：會話恢復走 resume

- **同進程內多輪對話**：正常（live session 複用，turn completed）。
- **跨程序/重啟後恢復**：SDK 的 agents.create 在磁碟已有同 id 時拋 session already exists（store 在 boot 時從磁碟水合）。wrapper 的 createSession 捕獲後自動轉 agents.resume（官方恢復路徑，自動縫合被中斷的 turn；setup 照跑，預設按日誌記錄優先掛載）—— prompt/goal/select 三條建立路徑都經這裡，重啟後續聊不再撞牆。
- **保留的 fork 邏輯**：switch_session 只讀回放（fromDisk 標記）→ prompt 自動 fork 新會話（歷史作上下文注入）；turn/end 的 id collision 自動 forkAndReprompt 仍在（abort 重啟後原會話不可續聊場景的兜底）。
- ds-web-ui 同樣撞上此限制（Resuming a persisted session is not supported... disk log → id collision），其對策也是新建會話繼續（我們多走了官方 resume，能續則續）。

### 2.5 擴充套件性結論（答覆使用者"還有 npx dsh web 的擴充套件性嗎"）

- **agent 側擴充套件性全保留**：執行時就是同一棵官方 Cordis 外掛樹（MCP client、subagent、goal、plan、skill、workflow、搜尋全在）。
- **dsh web 的 UI 生態** 與 pi-web-ui 前端是兩套介面，不互斥。
- **使用者外掛擴充套件縫（已實現，見 §4.2）**：launcher 載入 `<dataDir>/dsh-patches/*.yml` 使用者 patch 層。
- pi-web-ui 自己的"外掛 AI 工具"（registerAgentTool）無注入點，v1 宣告不支援，二期做"工具橋" Cordis 外掛。

### 2.6 ⭐ DSH 原生 goal 機制（使用者拍板：goal 直接適配 DSH，不自造審查會話）

執行時樹自帶完整 goal 棧（base bundle 預設啟用）：`dsh-goal`（狀態域）+ `dsh-goal-round-driver`（輪次驅動）+ `dsh-tool-goal`（模型工具）+ `dsh-command-goal`（/goal 命令）。

- **狀態域 dsh-goal**：事件源化 same-session 目標狀態，`ctx.goals` 服務動詞 get/create/edit/pause/resume/complete/block/clear；每次 mutation 追加 durable `goal/change` 事件（全量快照）。生命週期：active → complete | blocked | paused；啟用（armed）**不持久化**，程序重啟/會話 resume/fork 後 disarm，需 resume 重 arm。
- **輪次驅動 dsh-goal-round-driver**：agent idle + active armed goal + 剩餘輪次 → 自動排隊一條 `<goal_round>` user 訊息（source.kind=goal，帶 round 號）→ 模型繼續幹活 → 直到模型調 update_goal complete/blocked 或輪次用盡。**不需要我們驅動**。
- **模型工具 dsh-tool-goal**：get_goal/create_goal/update_goal（edit/pause/resume/complete/blocked）；goal policy 要求證據充分才 complete；blocked 需同一條件連續 3 輪（blockedAfterConsecutiveRounds: 3）。
- **⚠️ 無獨立審查者（官方明確）**："evaluator-backed certification is deferred"——完成/受阻由模型自判定，不是獨立審查會話。與 pi 引擎審查哲學不同，這是 DSH 的設計意圖（goal 輪次 = 自動迭代，非審查-修改迴圈）。
- **觸發方式（關鍵）**：JSON-RPC 面只有 initialize/session/prompt/shutdown，`/goal` 命令走 ctx.commands（prompt 直進 inbox 攔截不到）；唯一可靠觸發 = **自寫 wrapper 外掛給 jsonrpc 加 goal RPC**（見下）。
- **goal/change 事件**：經官方 jsonrpc 的 `ctx.on("session/event")` 全量轉發自然到達（含 operation/goal{phase,roundsStarted,maxGoalRounds,blockedReason}/roundsStarted）。
- **輪次訊息過濾**：`<goal_round>` 是 source.kind=goal 的 user/message，必須過濾不進 UI（同時用它更新輪數顯示，round 在 source.round）。
- **view 是扁平結構**：`{id,revision,objective,phase,maxGoalRounds,roundsStarted,blockedReason?,activation}`，無 goal 巢狀欄位；無目標時 get 返回 undefined。
- **wrapper 外掛實現**（server/dsh/runtime/goal-rpc.mjs）：import 官方 `HarnessSdkJsonRpcServer`（官方包 export 它）子類化 + handleRequest 加 goal/set|get|clear|resume|edit 分支，inject 加 "goals"，shutdown/transport 語義照抄官方 apply。launcher patch 的 sdk-jsonrpc name 指向 wrapper（官方入口經 env PI_WEB_DSH_JSONRPC_ENTRY 傳進去）。
- **UI 對映**：phase active→reviewing=true/"目標進行中（第 N 輪）…"；complete→verdict=pass/"✅ 目標已達成"；blocked→verdict=fail+feedback=blockedReason；clear→清空。goal 狀態 per-conversation（DshConversation.goal + dsGoal），隨會話切換推 goal_status。

### 2.7 ⭐ 二期：視覺橋 + 使用者提問橋 + 互動式調研嚮導（均實證通過）

**視覺橋**（真圖片，替代 v1 文本佔位）：

- DSH 附件機制：`dsh-attachment`（ctx.attachments 服務，base 已掛 attachment-local 儲存後端）+ `ImageAttachmentRef`（durable，含 sha256 雜湊）+ `EncodedImageAttachment`（base64 wire 格式）。image 塊 = `{type:'image', attachment: ref}`。
- **僅 `deepseek-v4-flash-vision-exp` 模型支援圖片**（adapter 預設目錄 inputModalities: [text,image]）；flash/pro 是 text-only 路由 → 圖片被省略（模型會說"只接受文本"）。DSH_MODELS 現在帶 per-model vision 標記，前端據此啟用/停用圖片貼上。
- RPC：`attachment/save`（base64 → ref，調 ctx.attachments.saveImage，位元組/媒體型別校驗）+ `attachment/read`（ref → base64，回放補圖）。模型請求側由 dsh-llm-deepseek adapter 自動把 ref 轉 file-id/inline parts。
- 接入：buildContentBlocks 的 imageData/工作區圖片檔案 → save → image 塊；樂觀訊息帶 dataUrl 圖塊；user/message 事件回放時 hydrateImageBlocks 非同步讀回補 dataUrl。
- 實測：vision-exp 模型準確描述專案截圖（"pi-web-ui 設定面板"+ 讀出 UI 文字）。

**使用者提問橋**（= pi 引擎 WebUIContext 等價物）：

- DSH 機制：`dsh-user-questions`（ctx.userQuestions.ask() 阻塞等答案，registerProvider 註冊 UI 側）+ `dsh-tool-ask-user`（ask_user_question 工具，**base bundle 未掛，需 override.patch.yml 手動 insert**）。
- 橋實現（goal-rpc.mjs）：apply 裡 `ctx.userQuestions.registerProvider({ ask })` → 發 `question.pending` 通知 → 等 `question/answer` RPC（帶 answers/cancelled）→ 恢復工具結果。單客戶端隔離（每客戶端一 runtime）。取消 → reject → 工具報錯 → 模型繼續。
- 協議：客戶端 `question_answer`；服務端 `question_pending`（questions 含 options{label,description,preview?}/multiSelect）。
- 前端：QuestionDialog.tsx（每題單選/多選 + 自由文本補充 + 提交/取消，複用 .dialog-inline 樣式）。`question/detail/description/preview` 走 `Markdown(rawHtml)` 富渲染（模型可自選 markdown 或 HTML）；選中帶 `preview` 的選項時展示「選項預覽」框，對齊 rpiv-ask-user-question。`preview` 為可選新增，DSH 模型未發時前端回退純文本。
- 實測：模型 ask_user_question → 瀏覽器收到"喜歡什麼顏色 紅/藍/綠" → 答"藍+偏深藍" → 模型回應"你選擇的是藍（偏深藍）"。

**互動式調研嚮導**（startGoalWizard 重寫，替代一鍵設定）：

- 主會話 prompt 嚮導指令（wizardPrompt：用 ask_user_question 逐題提問收斂，最後只輸出 GOAL: 行，禁止直接 create_goal）；conv.turnWaiter 等本輪 turn/end（提問-回答-收斂在同一輪）；解析 GOAL: 行 → setGoal。clearGoal 中斷在跑的嚮導。
- 實測：模型連問 4 輪（交付形式/儲存/功能範圍/技術約束，帶選項）→ 收斂 "GOAL: 在 pi-web-ui 專案新增獨立待辦網頁應用（React+Vite，中文，localStorage 持久化）…" → 自動設目標 → round-driver 自動進第 1 輪。

### 2.8 ⭐ 三期：工具橋（外掛 AI 工具注入點，⚠ 真 key E2E 實證）

把 pi-web-ui 外掛經 `host.registerAgentTool` 註冊的 AI 工具橋成 DSH 原生工具，讓 DSH 模型能呼叫它們（服務端跑外掛實現）。注入點 = `ctx.tools.register(defineTool({...}))`（dsh-tools 匯出 defineTool，dsh-tool-goal 同款用法）。

**協議（goal-rpc.mjs wrapper，已在 transport 上併入）：**

- `tools/sync`（server→runtime）：註冊/替換一批外掛工具。每個用 `defineTool({name, description, parameters, output:{schema:{type:'string'}, render}, execute:trampoline})`。trampoline execute 發 `tools.call.request` 通知（帶 id/name/args/sessionId）→ await；收到 `tools/call-result` RPC 後 resolve，工具結果字串傳回模型。
- `tools/list`（server→runtime）：返回 `ctx.tools.schemas()`（零 key 校驗/除錯用）。
- `tools/invoke`（⚠ 僅 `PI_WEB_DSH_DEBUG=1`）：繞過模型直接觸發一個已註冊橋接工具的完整往返，供零 key probe 驗證 trampoline → 通知 → call-result 恢復。
- `tools/call-result`（server→runtime）：服務端跑完外掛實現後回傳 `{id, result, isError}`，恢復橋接呼叫（isError→reject→模型看到工具錯誤）。

**服務端（dsh-client.ts + dsh-agent-service.ts）：**

- `DshRuntime.onStarted`：每次成功 initialize（含初次/換模型/watchdog 重啟）後，宿主 `syncPluginTools()` 把 `pluginToolsProvider()` 的外掛工具註冊進執行時（重 spawn 後 ctx.tools 是全新的，必須重註冊）。
- `handleToolCallRequest`：收 `tools.call.request` → 按 name 在 `pluginToolsProvider()` 找工具 → 調 `tool.execute(id, args, signal)`（服務端跑外掛）→ `normalizeToolResult` 歸一化（`{content}` / string / object）→ `tools/call-result` 回傳。
- `applyPluginAgentTools`：外掛工具列表變化 → 各客戶端執行時重同步。

**schema 轉換**：pi 外掛用標準 JSON Schema（`{type,properties,required[]}`），DSH 要 per-property 對映（`required` 掛在每條屬性上）——`piParamsToDshSpec` 純函式轉換（DSH 僅支援嚴格子集：`type` 陣列如 `["string","null"]` 對映為 `oneOf`、`anyOf` 轉為 `oneOf`、`object` 補齊顯式 `additionalProperties: true`、遞迴規整巢狀欄位與去除 unsupported DSL keys，單工具註冊失敗異常隔離不阻斷全量 sync）。

**v1 簡化**：模型只見 name/description/parameters；promptSnippet/promptGuidelines/label 不上模型；onUpdate 流式部分結果不轉發；無 tools_delta（DSH 不流式工具輸出）；`tools/invoke` 僅除錯。

**實測（真 key E2E）**：最小外掛註冊 `test_echo` → 模型收到指令呼叫它（引數 message=marker）→ 外掛在服務端返回 `ECHO:<marker>` → `tools/call-result` 回傳 → 工具結果與模型回覆都出現在對話裡。零 key probe（`dev/dsh-probes/probe-tools.mjs`）驗證註冊/列表/schema 轉換/`tools/invoke` 往返，`tests/dsh-tools-test.mjs` 真 key 門控。

### 2.9 ⭐ MCP 工具橋（#16，真 key E2E 實證）

**直接複用 pi 的 McpBridge + #15 工具橋**，無需另起爐灶。MCP 工具本就是 `PluginAgentTool`（`adaptMcpTool`），且 `index.ts` 已把 `mcpBridge.getTools()` 併入 `pluginToolsProvider` → #15 的 `tools/sync` 會自動橋接它們。

鏈路：`<dataDir>/mcp.json`（`{servers:{<名>:{command,args,cwd,env}}}`）→ `McpBridge.load()` 啟動 stdio MCP 伺服器（NDJSON JSON-RPC）→ 握手 `initialize`/`notifications/initialized` → `tools/list` 發現工具 → `adaptMcpTool` 適配（sanitize 工具名 + inputSchema 作 parameters + execute→`McpClient.call`）→ `pluginToolsProvider()` 返回 → `syncPluginTools` 註冊進 DSH → 模型呼叫 → `handleToolCallRequest` 跑 `execute` → `McpClient.call` 轉發 MCP 伺服器 → 結果 `tools/call-result` 回傳模型。

**取捨**：DSH 執行時樹自帶 MCP client（cordis 外掛），但那需要另配 mcp 定義與生命週期管理；pi 的 McpBridge 已是成熟、帶日誌/超時/多伺服器容錯的實現，且已隨 `pluginToolsProvider` 自動接入。**MCP 工具與外掛工具在 DSH 側完全同形（都是橋接工具），無特判**。

**實證**：`tests/dsh-mcp-test.mjs`（真 key 門控）——fake stdio MCP 伺服器暴露 `mcp_echo` → 模型呼叫 → `MCP_ECHO:marker` 回傳模型與對話（2/2 PASS）。

### 2.10 ⭐ 技能啟停 UI（#18，零 key probe 實證）

把 DSH 原生技能（`dsh-skill` SkillRegistry）暴露給前端設定面板，並讓 `disabledSkills` 真正生效（執行時過濾模型可見的技能目錄）。

**RPC（goal-rpc.mjs，ctx.skills 直連）**：

- `skills/list` → `ctx.skills.list()`（名稱/描述/invocation）；`skills/get` → `ctx.skills.get(name)`；`skills/set-disabled` → 存伺服器例項 `disabledSkills` 集合。
- `skills/register`（⚠ 僅 `PI_WEB_DSH_DEBUG=1`）→ 註冊執行時技能，供零 key probe 驗證 list。

**服務端**：`settings_state.skills` 從 `runtime.listSkills()` 拉取並對映成 `UiSkillInfo`（`enabled = !disabledSkills.has(name)`），快取到 `skillsCache` 供 pushSettings 同步；`set_settings.disabledSkills` 變化時 `pushDisabledSkillsToRuntime()` 同步 + `refreshSkillsFromRuntime()` 重新整理。`runtime.onStarted` 也並行重新整理。

**執行時停用（關鍵）**：DSH 技能目錄由 `dsh-tool-skill` 的 `agent/pre-step` 鉤子注入（`ctx.skills.snapshot()` → renderCatalogMessage，訊息帶 `source.kind='skill-catalog'` 與結構化 `source.entries`）；技能本身不支援 per-skill 排除。因此 goal-rpc 掛一個**晚** `agent/pre-step` 鉤子（註冊在 base 之後 → 後跑），按 `server.disabledSkills` 過濾 `source.entries` 並重建 `<available_skills>` 塊（`filterSkillCatalogMessage` 純函式，自包含 escapeText/rebuildCatalogText——**不 import dsh-skill**，因其非專案直依賴，Node 原生解析會失敗）。

**取捨**：停用走執行時目錄過濾（晚鉤子），而非「patch 層重配置/重啟」——無需重啟即生效；全部停用時給「本會話無可啟用技能」佔位。模型可見性過濾由純函式 + RPC 往返驗證（端到端需種技能檔案 + 模型列舉，Dev 環境未納入）。

**實證**：`dev/dsh-probes/probe-skills.mjs`（零 key）——`filterSkillCatalogMessage` 單測（部分停用/全停用/無操作）+ `skills/register`→`list`→`get`→`set-disabled` 往返。`settings_state.skills` 在 `refreshSkillsFromRuntime` 時填充（無技能檔案時為空陣列，不崩）。

### 2.11 ⭐ 瀏覽器 UI E2E（#23，零 key Playwright）

`tests/dsh-ui-test.mjs`（Playwright + `CHROME_PATH`，自動探測本機 Chrome）：

1. **引擎徽標**——`ready(engine=dsh)` 後 FooterBar 渲染 `.engine-badge.engine-dsh` 顯示 "DSH"。
2. **目標條**——Dsh 引擎下 GoalBar 正常渲染。
3. **設定面板「介面外掛」**——「DSH 使用者補丁」區塊展示 `<dataDir>/dsh-patches/*.yml` 檔案（測試放無害 persona 覆蓋補丁，驗證掃描與展示）。
4. **技能頁籤**——顯示 DSH 說明文案（`dshSkillsNote`）。

**範圍取捨**：流式渲染 / 圖片貼上（vision-exp）/ 提問對話方塊的瀏覽器級渲染需真 key + 模型時序，易 flaky，由協議級 dsh 測試（`dsh-goal/question/vision`）覆蓋 + 引擎無關共享元件（StreamMarkdown/QuestionDialog/image-paste）保證；本 E2E 專注 DSH 專屬 UI chromium（徽標/補丁/目標條/技能說明），零 key、可進 CI。

### 2.12 ⭐ Agent 預設（dsh-web 四模式復刻，2026-09-15）

官方 dsh-web 的會話組合機制：host 只留登錄檔/沙箱/持久化，agent 工具全部下沉到預設 composition（standard/ptc/minimal/cordis + 使用者自建），每會話建立一個掛載。pi-web-ui 此前是單全域性組合（全部會話共享工具+人設），本節復刻官方語義。

- **執行時**：override.patch.yml 補 personaPrefix 修鍵 + code-runtime/ptcRuntime + subagent-model-selection-settings + cordis-host-runner + pi-webui-custom-prompt（獨立 host section，標準/ptc/cordis 下發、minimal 壓住）+ tool-ask-user（host 行保留）；agent-plane disable 全表 + roster 由服務端動態生成 dsh-preset-plane.patch.yml（原子生效，缺失回落 legacy）。
- **file: 克隆**（server/dsh/preset-clones.ts）：launcher boot 下 shipped 預設裸包名不可解析（baseUrl=config 目錄），故複製 composition 並把裸名改寫成執行時樹入口檔案的 file: URL（按 exports→main→lib/index.js 解析，子路徑同理），roster 以 clone 目錄為唯一 system 根。每次啟動重生成（跟隨執行時樹升級），單測 tests/unit/preset-clones.test.ts。
- **wrapper**（goal-rpc.mjs）：createSession 覆寫（meta.agentPreset 進 header + setup 裡 mount/問卷 waterfall/技能過濾鉤子/失敗轉 host 直連）+ 同 id 轉 agents.resume + projection-prior（日誌記錄 > 建立引數 > 預設）；preset/list|assign|select + DEBUG 的 preset/tools、debug/assemble；minimal 下橋接工具與問卷呼叫期拒絕（雙語錯）；提問橋 P0 修法（registerProvider 已被上游刪除，改 agent scope waterfall）。
- **Node 側**：conv.agentPreset/presetLocked/assignedGen（runtimeGen 世代重登）+ 預設預設持久化（client-state）+ 回放定預設（selected 事件/header，sessionLogPreset）+ fork 繼承；協議 UiAgentPreset/dsh_presets/select/default/new_chat{preset}/快照 agentPreset/會話摘要欄位（純加法，PROTOCOL_VERSION 不升）。
- **前端**：DshPresetBar（當前徽標 + 空白切換下拉 + 以此預設開新對話）+ 左欄 preset-badge + 設定預設頁（預設下拉 + 名錄卡片）；legacy（名錄空）時整套隱藏。
- **已知限制**：自建預設寫裸包名無法掛載（baseUrl 所限，名錄報 broken）；host 橋接工具（外掛/問卷）在 minimal 的工具目錄裡可見但呼叫被拒；問卷 waterfall 與技能過濾鉤子的真 turn 遞送尚未實證（無可用模型 key：deepseek 直連 key 無餘額、opencode-go 閘道器要 x-opencode-session 頭）；minimal 在當前執行時樹是單持久 shell（使用者 dsh-web 文案的雙工具是新版，兩邊以執行時樹為準）。
- **驗證**：tests/dsh-smoke-test.mjs 新增 2.5 節（名錄四預設無 broken + 快照/new_chat/切換/預設/非法拒絕）；tests/unit/dsh-sessions.test.ts；零 token 實 boot 驗證（工具目錄 standard27/minimal2/ptc27+run_code/cordis34、assemble section、NO_PROVIDER 通路）。

### 2.13 ⭐ 許可權預設三檔（官方 /permission 彈窗復刻，2026-09-15）

官方 dsh-web 的許可權行：permissions projection（options + currentValue，custom 僅展示）+ /permission 命令熱切換（寫會話日誌）+ 新會話預設（settings permission.defaultPreset）。pi-web-ui 此前是 workspace-write-never 寫死（approval=never），本節復刻三檔可切換。

- **wrapper**（goal-rpc.mjs）：inject 加 `permissionPresets`（⚠️ service 註冊名，不是外掛 id `permission`；寫錯則 boot 報 pending waiting for service）+ `approval`；permission/get|set RPC（set 照抄官方命令：`permission.apply(session, name, policy => approval.setPolicy(agent, policy))`，未知預設走 {ok:false} 信封；handleRequest switch 必須註冊方法名，否則 unknown method）。
- **Node 側**：conv.permissionPreset（快照 permission 欄位）+ 選項表快取 + per-client 預設持久化（client-state defaultPermissionPreset）+ 回放定許可權（permission/preset 事件最後一條，sessionLogPermission）；attach/切會話/執行時啟動/首輪 prompt 前拉取，首輪前把 per-client 預設熱應用（一致時 apply 無事件零噪音）。
- **三檔對映**：前端只提供 read-only / workspace-write-never（標“工作區內修改”）/ danger-full-access；官方 workspace-write（approval ask）無頭下無應答者註定 fail closed，是死路，不提供。完全許可權走內聯兩步確認（官方 confirm 同款語義）。
- **協議**：ClientMessage dsh_permission_set/default + ServerMessage dsh_permission{options,defaultPreset} + UiState.permission + DshPermissionOption（純加法；PROTOCOL_VERSION 16→17）。
- **前端**：DshPermissionBar（輸入框上方預設條旁邊）+ 設定預設頁預設下拉；legacy/未就緒（options 空）時隱藏。
- **驗證**：tests/scratch/verify-permission.mjs 零 token 實 boot（get 預設 workspace-write-never + 三檔切換讀回 + 未知拒絕 + 冪等）。

---

## 3. 已完成的工作

### 3.1 server/dsh/ 交付物（全部檔案）

```
E:/pi-web-ui/server/dsh/
├── runtime/
│   ├── launcher.mjs          # DSH 執行時子程序 launcher（boot 組合 + 事件管道 + 使用者 patch 層）
│   ├── goal-rpc.mjs          # ⭐ jsonrpc wrapper 外掛：goal/* + attachment/* + question/* RPC（直連 ctx.goals/attachments/userQuestions）
│   ├── runtime-root.mjs      # 執行時樹解析共享模組（flat + dsh 巢狀佈局）
│   ├── cordis.yml            # 空根 []（兩層 patch 全在 boot patches 引數裡）
│   └── override.patch.yml    # 會話根/預設模型/人設/沙箱/approval=never/permission preset/jsonrpc
├── dsh-client.ts             # DshRuntime（TS）：spawn launcher + JSON-RPC + goal RPC + kill/restart
├── dsh-serialize.ts          # 事件 → UiMessage + DshStreamAccumulator（chunk 增量）
├── dsh-sessions.ts           # JSONL 只讀（zstdDecompressAll/readSessionLog/projectKey/回放）
├── dsh-agent-service.ts      # DshClientSession（協議對齊，goal=DSH 原生事件驅動）+ DshAgentService
└── （無 probe —— 人工驗證探針已挪到 dev/dsh-probes/，不進發布產物）

> 開發/驗證探針（`probe-mixed` / `probe-tools` / `probe-skills` / `probe-vision` /
> `probe-native-goal` / `probe-patch-seam`）現位於 `dev/dsh-probes/`（`dev/` 不入 npm 包）。
> 它們從 `server/dsh/runtime/` 取 launcher，路徑已隨搬家修正（見各檔案裡的 `DSH_DIR`）。
```

- **launcher 執行時樹解析**：`$PI_WEB_DSH_RUNTIME` → 本包 node_modules → execPath 鄰近 node_modules → `npm root -g`（win32 shell:true）。**支援 dsh 巢狀樹**（`<root>/@deepseek-ai/dsh/node_modules`）。
- **jsonrpc 外掛入口**：`createRequire(import.meta.url).resolve("@deepseek-ai/dsh-sdk-jsonrpc-server")`（主入口即可；⚠️ 包 exports 只暴露 "." 和 "./invariant"，**resolve 子路徑 lib/index.js 會報 "not defined by exports"**）。
- **launcher 修復 jsonrpc 絕對路徑**：loader 的 name 欄位不支援 !!js → launcher 用 JS 把 env/專案解析寫回 patch entry。
- **構建**：`npm run build:dsh-runtime`（scripts/copy-dsh-runtime.mjs）把 runtime 的 .mjs/.yml 複製到 dist/server/dsh/runtime/（tsc 只編譯 .ts）；build 鏈已接上。

### 3.2 引擎分發 + 前端徽標

- `server/index.ts`：`ENGINE = PI_WEB_ENGINE === "dsh" ? "dsh" : "pi"`；`new DshAgentService(CWD, stateFile, DATA_DIR, getAgentDir())` vs `new AgentService(...)`；定義 `DispatchSession`（dispatch 表契約）與 `EngineService` 介面，pi/dsh 兩引擎結構相容。**agentDir 貫通**：auth.json 讀寫與 DshRuntime 的 key 讀取都尊重 PI_CODING_AGENT_DIR（smoke 測試的臨時 agent 目錄才能隔離）。
- `/api/health` 返回 `engine` 欄位；`ready` 訊息帶 `engine`。
- `server/control-socket.ts`：startControlServer 的 service 型別放寬為 `ControlService`（Pick serviceStatus/quiesce/unquiesce）。
- `server/protocol.ts`：ready 加 `engine?: string`；`dsh_patches_list`/`dsh_patches_rescan`（客戶端）+ `dsh_patches`（服務端）協議訊息；types.ts shim 自動同步（check:protocol ✓）。
- 前端：`web/src/use-chat.ts` state 加 `engine` + `dshPatches`；`FooterBar.tsx` 顯示 DSH 徽標；`SettingsModal.tsx` 外掛頁簽下加"DSH 使用者補丁"區塊（列表 + 重掃，僅 dsh 引擎顯示）；i18n 加對應 key（zh/en）。

### 3.3 已驗證（empirical）

- ✅ **probe-mixed.mjs 全鏈路**：initialize → prompt → 事件流（kinds 全）→ text-delta 拼接 "mixed tree works" → shutdown。
- ✅ **probe-patch-seam.mjs**：使用者 patch 層生效（patch 把會話持久化根重定向到 marker 目錄，prompt 後 JSONL 落在 marker 下）。
- ✅ **probe-native-goal.mjs**：goal/set → create+arm → **round-driver 自動續輪**（<goal_round> round=1）→ 模型 update_goal complete → goal/change 事件 → goal/clear 墓碑。DSH 原生 goal 全鏈路。
- ✅ **目標（DSH 原生，經 DshClientSession）**：setGoal → goal_status 流轉（等待生成→進行中（第 1 輪）→✅ 已達成 verdict=pass）→ clearGoal 清空；<goal_round> 訊息不洩漏進 UI。
- ✅ **launcher 單測**（dist 編譯產物）boot 成功、initialize 響應。
- ✅ **DshRuntime 獨立測試**：start 856ms、prompt 7ms、事件流完整；同進程多輪 turn completed。
- ✅ **真 key E2E（WS 全鏈路，新 key）**：ready(engine=dsh) → 真模型回覆（"4；2+2 按算術規則等於 4。"）→ 原生 goal 迴圈 pass（"✅ 目標已達成"）→ dsh_patches 列表訊息 → 會話 JSONL 持久化。全部通過。
- ✅ **系統訊息過濾 + 重複去重**：user/message 只保留真正使用者訊息（agent-instructions/plugin/goal 過濾；重複文本去重）。
- ✅ **會話列表/切換**：list_sessions（JSONL 掃描）→ switch_session（回放 4+ 訊息）。
- ✅ **歷史會話續聊**：prompt 到 fromDisk 會話自動 fork + 上下文注入，模型正常回復。
- ✅ **abort**：kill 執行時 + 自動重啟 + turn/end id collision 自動 fork 重發，模型恢復回覆。
- ✅ **終端**：terminal_create/list/input/output（bash echo TERM_OK 回顯）。
- ✅ **quiesce**：attach 拒絕拋 QuiesceRejectedError（index.ts 轉 4403 close）+ prompt/newChat/setGoal 拒絕發錯誤 notice（含 quiesce）。
- ✅ **SCM**：scmQuery 走 FilesService（git-dir watcher → 外部提交推 scm_changed，scm-features-test 9/9）。
- ✅ **API key 管理**：set/clearProviderApiKey 對齊 pi 形狀（{provider:{type,key}}）+ PI_CODING_AGENT_DIR 隔離（clear-provider-key-test 4/4）。
- ✅ **質量門**：`npm run typecheck`（server+web+tests）0 錯；`npm run build` OK；`npm run test` 246 通過。
- ✅ **pi 引擎迴歸**：預設 PI_WEB_ENGINE=pi 未改行為（typecheck/build/單測/smoke 抽樣全綠）。

### 3.5 dsh 引擎冒煙評估（PI_WEB_ENGINE=dsh，第二輪後 22/32 通過 + 2 環境跳過）

可複用（✓ 22 項）：global-search / goal-prefs / goal-test / plugin-cwd / plugin-http / mcp-bridge / plugin-settings / plugin-update / preview / quiesce / recursive-watch / scm-features / steer-queue-smoke / ssh-plugin / clear-provider-key（對齊後 4/4）/ snapshot-delta / **conv-cwd（第二輪轉綠）** / **plugin-test（第二輪轉綠）** / **plugin-bgtask（第二輪轉綠）** / **plugin-command（第二輪轉綠）** / **slash-commands（第二輪轉綠）**。
不可複用（引擎差異，預期失敗）：conv-cross-project / switch-session-background（依賴 pi mock provider "main/switch-session-mock"，**Windows 本地 pi 基線同樣失敗，非迴歸**）；fetch-models / refresh-models / vision-bridge（自定義 provider/視覺橋 v1 不支援）；left-panel-delete（pi 會話目錄結構假設）；settings（僅剩 1 個斷言：visionBridgeDefaultPrompt 非空，DSH 無視覺橋概念）。環境問題：db-client / vscode-editor（dev/plugins/ 缺失，pi 下同樣失敗）。

### 3.4 過程性踩坑（見 §6）

---

## 4. 下一步做什麼（按序）

### 4.1 引擎主體收尾（已基本完成；goal 已改為 DSH 原生，見 §2.6）

- **目標（goal）**：✅ 完成 —— DSH 原生 goal 域（goal-rpc wrapper RPC + goal/change 事件翻譯 + round-driver 自動輪次 + 模型自判定 complete/blocked）。與 pi 引擎差異（設計意圖）：無獨立審查會話；完成由模型自判定；locked 開關透傳不對映行為（DSH 目標持續到 complete/blocked/輪盡）；reviewModel 忽略（無獨立審查者）。
- **設定面板**：第二輪後全量儲存回顯（promptMode/customSystemPrompt/terminalToolsEnabled/terminalBash/thinkingWrap/toolsWrap/disabledSkills/disabledExtensions/disabledPlugins/reviewPrompt 經 ClientStateStore 持久化，跨重連存活）；僅 prompt 相關變化才重啟執行時（DSH_PERSONA env 注入）；引擎專屬設定項擴充套件機制（Engine-Contributed Settings）動態呈現 DSH 預設與三檔許可權、補丁與市場、問卷調研；通用底座設定項全量相容。
- **視覺橋**：✅ 完成（§2.7）—— 真 image block（attachment/save + read RPC + vision-exp 模型 + 回放補圖）。圖片附件/工作區圖片檔案都走附件儲存。注意：僅 deepseek-v4-flash-vision-exp 模型看圖。
- **第三方自定義端點與模型接入（models.json）**：✅ 完成 —— DSH 引擎接入公共模型底座，自動列舉 `models.json` 中配置的第三方自定義端點模型（如 `antigravity-openai/gemini-3.8-flash` 等）；切換時動態解析 BaseURL 與 API Key 並注入子程序環境變數 `DEEPSEEK_BASE_URL` 與 `DEEPSEEK_API_KEY`，RPC 握手傳遞真實模型 ID，實現第三方 OpenAI 相容端點在 DSH 執行時的直接呼叫執行。
- **Universal Agent 底座驅動化（DshAgentDriver）**：⚠️ 已退役 —— 曾嘗試在 `server/universal/drivers/dsh-driver.ts` 實現 `BaseAgentDriver`，但由於 DSH 為具備 4 預設克隆掛載、獨立 RPC 守護程序與原生 Goal 狀態機的複合引擎（非簡單單程序驅動），將複合引擎降格為輕量 Driver 存在抽象層級錯配。為避免產生未經檢驗的第三套 DSH 執行時，該驅動已於 #733 徹底清理；DSH 與通用底座的收斂未來統一走 #469（自頂向下抽取共享 `BaseAgentService`）。
- **對話方塊（dialog_response）/ 擴充套件 UI 橋**：DSH 側已有提問橋（question_pending/question_answer，§2.7）；pi 擴充套件 dialog（dialog_response）v1 仍忽略。
- **目標調研嚮導（startGoalWizard）**：✅ 完成（§2.7）—— 互動式（模型 ask_user_question 逐題提問 + 前端對話方塊 + GOAL: 收斂 + 自動設目標）。

### 4.2 使用者 patch 擴充套件縫 ✅ 已實現

- launcher 讀 `PI_WEB_DSH_DATA_DIR`（dsh-client 注入）→ `<dataDir>/dsh-patches/*.yml`（按檔名序，在 override 之後）append 進 boot patches；失敗檔案跳過 + stderr 日誌。jsonrpc 路徑寫回對使用者 patch 同樣生效。
- 引擎方法：`listDshPatches()`（掃描 + dsh_patches 訊息）/ `rescanDshPatches()`（重啟執行時使新 patch 生效）。協議：`dsh_patches_list` / `dsh_patches_rescan`。
- 前端：設定面板「介面外掛」頁簽下的「DSH 使用者補丁」區塊（檔案列表 + 重掃按鈕 + 目錄提示）。

### 4.3 dsh 引擎冒煙 ✅ 已評估（見 §3.5）

- `PI_WEB_ENGINE=dsh node tests/run-smoke.mjs` 全量跑過：22/32 + 2 環境跳過（第二輪；conv-cwd/plugin-test/plugin-bgtask/plugin-command/slash-commands 轉綠）；剩餘失敗全部歸因為 pi 專屬/設計差異/環境（見 §3.5 清單）。
- 真 key 手動全流程（對話/工具/會話持久化/換模型/中止）此前已驗證；goal 原生迴圈已用真 key probe 驗證。

### 4.4 已知 v1 簡化項（與 pi 引擎的差異，前端可感知）

- **無逐字流式**：本機快速完成時 60ms 快照捕捉不到 streaming，但 message_delta 通道已實現（thinking/text 逐 token 走 message_delta，前端 patch streamingMessage），長響應可見流式。
- **queue 語義**：DSH 無 mid-run steering —— isStreaming 時 prompt 全部走 followUp（執行時 inbox 排隊，run 結束後消費）；前端 queue 顯示為"傳送即清"（樂觀訊息 + agent/inbox/spliced 清理）。
- **工具執行狀態**：tool/call（開始）+ tool/result（結束）→ tool_status 已發；無 tool_delta（DSH 不流式工具輸出）。
- **後臺任務**：tool/call bash → bg.snapshotBefore；tool/result bash → bg.trackAfterBash（埠 diff）已接。
- **goal 審查語義**（見 §2.6）：DSH 無獨立審查者——"目標進行中（第 N 輪）…"由 round-driver 自動續輪驅動，完成/受阻由模型自判定；blocked 需連續 3 輪同條件。
- **斜槓命令**（第二輪已支援）：NATIVE_COMMANDS（new/model/cwd/resume/help/copy/reload/quit 等）+ 外掛 registerCommand 全量攔截執行（prompt 前 parseSlash，非命令才發模型）；`/model` 支援動態模型目錄匹配。

---

## 5. 任務清單狀態

| #   | 任務                                                                                  | 狀態                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 研究 DSH JSON-RPC 協議面                                                              | ✅ 完成（§2.1/§2.3 事件 ground truth）                                                                                                               |
| 2   | 通讀 pi-web-ui agent-service.ts                                                       | ✅ 核心讀完（快照/事件/會話/模型方法，作對齊參照）                                                                                                   |
| 3   | 通讀 ds-web-ui 移植素材                                                               | ✅ 核心讀完（dsh-client/serialize/agent-service JSONL 部分）                                                                                         |
| 4   | 設計 server/dsh/ + 引擎分發 + 徽標                                                    | ✅ 完成（DispatchSession/EngineService 介面 + ENGINE 分發 + health/ready engine + 前端徽標）                                                         |
| 5   | dsh 核心對話引擎                                                                      | ✅ 完成（prompt/事件摺疊/快照/snapshot_delta/message_delta/tool_status/訊息過濾去重）                                                                |
| 6   | dsh 會話管理                                                                          | ✅ 完成（JSONL 列表/回放/切換/刪除 + fork 續聊 + id collision 自動 fork）                                                                            |
| 7   | 終端/SCM/後臺任務/檔案服務接入                                                        | ✅ 完成（TerminalManager/scm.ts/FilesService/BgServerTracker 複用 + WS 驗證）                                                                        |
| 8   | 設定/模型配置/目標/視覺橋/外掛對齊 + 使用者 patch 縫                                  | 🔶 部分（**第二輪：設定全量儲存回顯 ✅、模型配置 v1 不支援、目標=DSH 原生 ✅、視覺橋 ✅、提問橋+互動式嚮導 ✅、使用者 patch 縫 ✅、slash 命令 ✅**） |
| 9   | 前端徽標 + 引擎狀態                                                                   | ✅ 完成                                                                                                                                              |
| 10  | typecheck/build/冒煙（雙引擎）                                                        | ✅ typecheck/build/vitest 全綠；pi smoke 抽樣迴歸綠；**dsh smoke 已評估（§3.5，22/32 + 2 環境跳過，失敗全歸因）**                                    |
| 11  | 二期：視覺橋（真 image block + vision-exp 模型 + 回放補圖）                           | ✅ 完成（§2.7，probe-vision.mjs 實證）                                                                                                               |
| 12  | 二期：使用者提問橋（question_pending/question_answer + QuestionDialog）               | ✅ 完成（§2.7，WS 實證：提問→回答→模型回應）                                                                                                         |
| 13  | 二期：互動式調研嚮導（startGoalWizard 重寫）                                          | ✅ 完成（§2.7，4 輪提問→GOAL 收斂→自動設目標實證）                                                                                                   |
| 14  | 第二輪：P0 穩定性（watchdog/競態/記憶體回收/DEBUG/重試/提問超時）                     | ✅ 完成（§8.1 全部）                                                                                                                                 |
| 15  | 第二輪：P1 體驗對齊（vision 校驗/設定面板/輪次檢測/locked 語義/conv-cwd/保留期/搜尋） | ✅ 完成（§8.2 全部；conv-cwd-test 轉綠）                                                                                                             |
| 16  | 第二輪：P2 部分（模型目錄動態化/fork 提示/提問排隊/思考摺疊）                         | ✅ 完成（§8.3 #17/19/20/21）                                                                                                                         |
| 17  | 第二輪：斜槓命令系統（NATIVE + 外掛命令攔截執行）                                     | ✅ 完成（slash-commands/plugin-command/plugin-bgtask 轉綠）                                                                                          |

---

## 6. 坑與備忘（避免重複踩）

1. **npm 在 bash 工具環境裡會假死** —— 讓使用者在自己的終端跑；不要在工具裡後臺裝大包。
2. **fnm multishell**：`npm root -g` 從 bash/node spawn 取空桶很正常；launcher 已把 execPath 鄰近 node_modules 放前面。**每個 bash 命令是獨立 multishell（execPath 不同），junction 路徑只在當前 shell 存活**。
3. **cordis patch 語法**：id 定向替換 vs insert，錯了報 duplicate loader entry id。
4. **JSON-RPC stdout 純淨**：runtime 的 stdout 只能有協議幀；任何日誌都要 stderr（除錯資訊用 PI_WEB_DSH_DEBUG 門控打到 stderr）。
5. **中止=殺程序**：win32 用 `taskkill /pid X /T /F`；會話 JSONL 在磁碟，程序重建不丟。**abort 後原會話不可續聊（id collision）→ 必須 fork**。
6. **`.jsonl.zstd` 多幀解壓**：zstdDecompressSync 只解首幀，要各幀分別解（dsh-sessions.ts 的 zstdDecompressAll）。
7. **會話目錄名**：projectKey 風格（`--<cwd>--`，分隔符轉 `-`，非法字元 `~XXXX`）。
8. **協議版本**：protocol.ts 加欄位後跑 `npm run check:protocol`（types.ts shim 單源）。
9. **loader 的 name 欄位不支援 !!js**（只插值 config）→ jsonrpc 外掛絕對路徑由 launcher JS 寫回（launcher.mjs 的 jsonrpcEntry 解析段）。
10. **boot 的 patches 必須扁平**：`[...baseList, ...overrideList]`；巢狀陣列被 applyEntryPatches 靜默跳過（表現為"外掛沒掛上"）。
11. **permission-presets 整行全量替換**：approval=never 組合需顯式 preset + defaultPreset（override.patch.yml 的 workspace-write-never）。
12. **執行時樹在巢狀位置**：全域性 `npm root -g/@deepseek-ai/` 只有 dsh 包；dsh-base/dsh-app-boot 在 `@deepseek-ai/dsh/node_modules/@deepseek-ai/`（runtime-root.mjs 的 runtimeBaseFor 檢查兩種佈局）。
13. **require.resolve 子路徑限制**：dsh-sdk-jsonrpc-server 的 exports 只暴露 "." 和 "./invariant"，resolve 必須用主入口。
14. **快照增量陷阱**：`emittedMessages = cur` 若儲存陣列引用，appendMessage push 同一陣列會讓 prev/cur 恆等 → slice(prev.length) 恆空 → 訊息永不到前端。必須複製（`[...conv.messages]`）。
15. **流式時序**：本機快速完成時 60ms 延遲快照總被 assistant/message 搶跑（streaming 從未被捕捉）→ 必須走 message_delta 獨立通道（text_delta/thinking_delta，與 pi SDK 的事件型別一致）。
16. **DSH 重複使用者訊息**：同文本 user/message 會重放 → 按文本去重；agent-instructions/plugin 過濾；**goal source 的 <goal_round> 輪次訊息也要過濾**（不渲染，但用它更新輪數顯示，round 在 source.round）。
17. **Windows 測試程序管理**：`pkill -f` 在 Git Bash 匹配不到 node 程序（pid 殘留 + EADDRINUSE），用 `taskkill //PID <pid> //T //F`。
18. **伺服器啟動競態**：DshRuntime.start() 併發呼叫必須共享同一 startPromise（否則重複 spawn launcher，prompt 寫錯 stdin）。
19. **Windows ESM 動態 import 絕對路徑**：`import("E:\\...")` 報 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 必須 `import(pathToFileURL(p).href)`（goal-rpc.mjs 踩過）。
20. **dsh-goal view 是扁平結構**：`{id,revision,objective,phase,maxGoalRounds,roundsStarted,activation}`，無 goal 巢狀欄位；無目標時 get() 返回 undefined（不是 {goal:null}）。
21. **goal/change 事件只在 mutation 時發**（create/edit/resume/complete/block/clear），輪次承認不發 —— 輪數顯示靠 <goal_round> user/message 的 source.round 更新。
22. **auth.json 形狀與路徑**：pi 引擎形狀 `{<provider>:{type:"api_key",key}}`，dsh 必須同形狀（clear-provider-key-test 斷言）；路徑尊重 PI_CODING_AGENT_DIR（getAgentDir()），硬編碼 ~/.pi/agent 會讓測試/部署的臨時 agent 目錄隔離失效。⚠️ **clear-provider-key-test 會破壞真實 ~/.pi/agent/auth.json 的 deepseek key**（pi/dsh 都一樣）——跑之前備份，跑完恢復。
23. **sdk-jsonrpc 外掛可擴充套件**：官方包 export HarnessSdkJsonRpcServer/apply/Config/inject/name，可 import 子類化加 RPC 方法（goal-rpc.mjs 的模式）；inject 要加新服務依賴（"goals"）；loader 對外掛檔案的裸 import 走 node ESM 解析（混樹安全，官方外掛同理）。
24. **JSON-RPC 面無法觸發 /goal 命令**：prompt 直進 inbox，命令執行時（ctx.commands）攔截不到；唯一可靠觸發 = 擴充套件 RPC 方法直調 ctx.goals 服務動詞。
25. **圖片只對 vision 模型可用**：dsh-llm-deepseek adapter 預設目錄僅 `deepseek-v4-flash-vision-exp` 有 inputModalities:[text,image]；flash/pro text-only → 圖片被省略（模型會說"只接受文本"）。視覺標記必須 per-model。
26. **dsh-tool-ask-user 不在 base bundle**：base 只掛 user-questions 服務；ask_user_question 工具要 override.patch.yml 手動 insert（否則模型說"沒有該工具"）。
27. **提問橋單 pending**：ctx.userQuestions 一個 context 只一個 provider；ask() 阻塞期間新提問報"已有提問等待回答"。前端 question_pending 只顯示一個；提交前每題需 selected 或 custom 非空。
28. **附件位元組校驗**：attachment/save 用 saveImage（內部校驗媒體型別/位元組/畫素上限），非 png/jpeg/webp/gif 或超限報錯 → 呼叫方回退文本佔位。
29. **Event loop 阻塞注意**：提問橋的 ask() await 掛起 agent 迴圈直到 answer/cancel/超時（10 分鐘，PI_WEB_DSH_QUESTION_TIMEOUT_MS 可配）——前端不回答會卡住該會話，超時後工具報錯模型繼續。
30. **restart 競態（舊 proc 遲到 exit）**：kill 後舊程序 exit 事件可能晚於新 initialize 到達 → exit handler 必須做 `this.proc !== spawned` 身份檢查（dsh-client.ts doStart），否則舊 exit 的 failPending 會誤 reject 新 initialize（報 "runtime killed (interrupt)"），且 intentional 判斷錯會誤觸發 watchdog 自動重啟。
31. **設定回顯欄位寫死殘留**：dsh pushSettings 早期把 disabledPlugins/thinkingWrap/terminalBash 等寫死為字面量——批次編輯被回滾後容易漏改；改完設定類回顯記得 grep 確認無字面量殘留。
32. **slash 攔截要 flushSnapshot**：prompt 攔截 slash 命令後必須 flushSnapshot（pi 的 exec 後同款），否則 snapshot-delta 類測試/前端拿不到命令後的增量。
33. **watchdog 與 kill 的區分**：onExit 的 intentional 由 `this.closed` 判斷（kill()/close() 置 true）；意外崩潰時 closed=false → watchdog 限頻重啟（60s 內 2 次）。
34. **pi 外掛引數是標準 JSON Schema，DSH 工具要 per-property 對映**：`required` 在 pi 是物件陣列 `["x"]`，在 DSH 是每條屬性上的 `required:true`——直接透傳會讓 DSH 編譯器把 `type` 當屬性名；必須經 `piParamsToDshSpec` 轉換。
35. **重 spawn 後 ctx.tools 是全新的**：換模型/watchdog 重啟後橋接工具全部丟失，必須靠 `runtime.onStarted` 回撥重新 `syncPluginTools`（不能只在 attach 時同步一次）。
36. **工具結果須匹配 output schema**：橋接工具宣告 `output:{schema:{type:'string'}, render}`，服務端歸一化成字串回傳（`normalizeToolResult`）；返回非 string 會被 `snapshotToolValue`/schema 校驗拒絕報 ToolOutputError。
37. **tools/invoke 僅 DEBUG**：零 key 驗證完整往返（trampoline→通知→call-result 恢復）需執行時 `PI_WEB_DSH_DEBUG=1`，否則 RPC 報錯；生產不可用。

---

## 7. 相關檔案清單（新對話必讀）

| 檔案                                                     | 用途                                                                                           |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `E:/pi-web-ui/server/dsh/dsh-agent-service.ts`           | 引擎主體（DshClientSession 協議對齊 + goal=DSH 原生事件驅動 + DshAgentService）                |
| `E:/pi-web-ui/server/dsh/dsh-client.ts`                  | DshRuntime（launcher spawn + JSON-RPC + goal RPC + kill/restart）                              |
| `E:/pi-web-ui/server/dsh/dsh-serialize.ts`               | 事件 → UiMessage + DshStreamAccumulator                                                        |
| `E:/pi-web-ui/server/dsh/dsh-sessions.ts`                | JSONL 只讀（列表/回放/fork 素材）                                                              |
| `E:/pi-web-ui/server/dsh/dsh-usage.ts`                   | 底欄統計純對映（DSH usage → 四桶 / 上下文佔用 / 日誌取最後一條 usage）                         |
| `E:/pi-web-ui/tests/dsh-stats-test.mjs`                  | 底欄統計迴歸：假 runtime 灌直播幀/持久事件，零 key / 零子程序                                  |
| `E:/pi-web-ui/server/dsh/runtime/launcher.mjs`           | 執行時 launcher（boot 組合；jsonrpc wrapper 指向；使用者 patch 層）                            |
| `E:/pi-web-ui/server/dsh/runtime/goal-rpc.mjs`           | ⭐ jsonrpc wrapper 外掛：goal/set                                                              | get | clear | resume | edit + attachment/save | read + question/answer + 提問 provider 橋 |
| `E:/pi-web-ui/server/dsh/runtime/runtime-root.mjs`       | 執行時樹解析（flat + 巢狀佈局）                                                                |
| `E:/pi-web-ui/server/dsh/runtime/override.patch.yml`     | 組合覆蓋層（permission preset 等）                                                             |
| `E:/pi-web-ui/dev/dsh-probes/probe-native-goal.mjs`      | DSH 原生 goal probe（goal/set→round-driver→complete→clear）                                    |
| `E:/pi-web-ui/dev/dsh-probes/probe-vision.mjs`           | 視覺橋 probe（attachment/save+read+vision 模型看圖）                                           |
| `E:/pi-web-ui/dev/dsh-probes/probe-tools.mjs`            | 工具橋 probe（tools/sync+list 註冊/列表/schema 轉換 + tools/invoke 往返）                      |
| `E:/pi-web-ui/dev/dsh-probes/probe-skills.mjs`           | 技能啟停 probe（filterSkillCatalogMessage 單測 + register/list/get/set-disabled 往返）         |
| `E:/pi-web-ui/tests/dsh-smoke-test.mjs`                  | dsh 引擎零 key 協議冒煙（已納入 run-smoke ALL）                                                |
| `E:/pi-web-ui/tests/dsh-goal-test.mjs`                   | dsh goal 真 key 門控測試（set_goal→round-driver→complete→clear）                               |
| `E:/pi-web-ui/tests/dsh-question-test.mjs`               | dsh 提問橋真 key 門控測試（question_pending→answer→模型繼續）                                  |
| `E:/pi-web-ui/tests/dsh-vision-test.mjs`                 | dsh 視覺橋真 key 門控測試（imageData→attachment/save→vision 模型看圖）                         |
| `E:/pi-web-ui/tests/dsh-tools-test.mjs`                  | dsh 工具橋真 key 門控測試（模型呼叫橋接外掛工具 test_echo → 服務端執行 → 結果回傳）            |
| `E:/pi-web-ui/tests/dsh-mcp-test.mjs`                    | dsh MCP 工具橋真 key 門控測試（mcp.json → McpBridge 發現 mcp_echo → 模型呼叫 → MCP_ECHO 回傳） |
| `E:/pi-web-ui/tests/dsh-ui-test.mjs`                     | dsh 瀏覽器 UI E2E（零 key Playwright：引擎徽標/目標條/DSH 補丁區塊/技能說明，5/5）             |
| `E:/pi-web-ui/web/src/components/QuestionDialog.tsx`     | 模型提問對話方塊（單選/多選/自定義文本 + `Markdown(rawHtml)` 富渲染 + 選項 `preview` 預覽框）  |
| `E:/pi-web-ui/dev/dsh-probes/probe-patch-seam.mjs`       | 使用者 patch 層 probe（會話根重定向驗證）                                                      |
| `E:/pi-web-ui/server/index.ts`                           | 引擎分發（ENGINE/EngineService/DispatchSession）+ dispatch 表 + dsh_patches 分支               |
| `E:/pi-web-ui/server/protocol.ts`                        | wire 協議唯一事實源（ready.engine + dsh_patches 訊息）                                         |
| `E:/pi-web-ui/scripts/copy-dsh-runtime.mjs`              | build:dsh-runtime（複製 .mjs/.yml 到 dist）                                                    |
| `E:/pi-web-ui/server/agent-service.ts`                   | pi 引擎（協議對齊參照；QuiesceRejectedError 定義處）                                           |
| `E:/pi-web-ui/server/files-service.ts`                   | 檔案/SCM 服務（scmQuery 帶 git-dir watcher，dsh 複用）                                         |
| `E:/ds-web-ui/server/dsh-client.js` / `agent-service.js` | 移植源（JSONL 解碼/事件適配參考）                                                              |

---

## 8. 後續最佳化路線圖（使用者待辦，按優先順序）

> 狀態截止 2026-09-01（第二輪）：v1 功能齊備 + P0 全部完成 + P1 全部完成 + P2 部分完成，
> 冒煙 22/32 + 2 環境跳過（conv-cwd/plugin-*/slash-commands 轉綠）。以下按「影響 × 成本」排序。

### 8.1 P0 — 穩定性 / 健壯性（✅ 全部完成）

| #   | 項                                | 狀態與實現                                                                                                                                                                                                                                                                             |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **runtime 崩潰自動重啟 watchdog** | ✅ `DshRuntime.onExit` 帶 intentional 引數（kill/close 主動 vs 意外崩潰）；`handleRuntimeExit` 限頻自動重啟（60s 內最多 2 次，超限升級 error notice）；重啟前復位全部 conv 的 streaming；舊程序遲到的 exit 事件不再誤傷新 initialize（dsh-client 的 `this.proc !== spawned` 身份檢查） |
| 2   | **setModel / abort 競態**         | ✅ setModel 前檢測活躍 run → 發 warning notice（"有對話正在執行，切換模型將中止當前所有執行"）                                                                                                                                                                                         |
| 3   | **convs 記憶體回收**              | ✅ 5min 定時 + newChat 觸發 `reclaimIdleConversations`：非 active/非 streaming/無終端，未 listed 閒置 >30min、listed 閒置 >24h 回收（JSONL 在磁碟可回放）；setCwd 切專案時同步回收舊專案未列出會話                                                                                     |
| 4   | **PI_WEB_DSH_DEBUG 門控**         | ✅ dsh-client 加 `PI_WEB_DSH_DEBUG=1`：RPC 幀（-> / <-）、exit/kill/restart 生命週期打到 stderr                                                                                                                                                                                        |
| 5   | **start 失敗重試**                | ✅ `startWithRetry`：1s/3s/9s 指數退避，最終失敗才發 error notice（create 與 watchdog 共用）                                                                                                                                                                                           |
| 6   | **提問橋超時配置 + 前端倒計時**   | ✅ `PI_WEB_DSH_QUESTION_TIMEOUT_MS`（預設 10min）；question_pending 帶 deadline；QuestionDialog 顯示倒計時 + 歸零自動取消（questionTimeout/questionTimeoutExpired i18n）                                                                                                               |

### 8.2 P1 — 體驗對齊（✅ 全部完成）

| #   | 項                                     | 狀態與實現                                                                                                                                                                                                                                                                                                                            |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 7   | **圖片貼上 vision 校驗**               | ✅ ChatInput `currentModelNoVision()`：當前模型在 models 清單中 `vision === false` 時拒絕貼上/拖拽/上傳圖片並提示（modelNoVision i18n）                                                                                                                                                                                               |
| 8   | **設定面板空列表**                     | ✅ DSH 下 skills/extensions 空列表顯示說明文案（dshSkillsNote/dshExtensionsNote）；vision tab 隱藏；presets/disabledPlugins/terminalBash 等設定真實儲存回顯（ClientStateStore 持久化，跨重連存活）                                                                                                                                    |
| 9   | **reviewPrompt / visionBridge 無效項** | ✅ vision tab 在 DSH 下隱藏（真圖片直通 vision 模型）；review 區塊顯示 DSH 語義說明（dshReviewPromptNote）；reviewPrompt 仍儲存經 DSH_PERSONA 注入                                                                                                                                                                                    |
| 10  | **GoalBar 輪次用盡檢測**               | ✅ applyGoalChange + `<goal_round>` 事件：round >= maxGoalRounds 且仍 active → status "已達輪數上限（N/M），目標未完成"                                                                                                                                                                                                               |
| 11  | **locked / reviewModel 語義**          | ✅ setGoal 裡 locked=false → maxGoalRounds 強設 1（單輪近似）；locked=true 保留使用者輪次；GoalBar 在 DSH 下隱藏 reviewModel 下拉（dshNoReviewModel 說明）                                                                                                                                                                            |
| 12  | **conv-cwd 冒煙對齊**                  | ✅ setCwd：notice 文案對齊（"已切換到工作目錄"）、listFiles 主動重新整理、pushProjects、舊專案 conv 回收；emitConversations 列 listed + 當前對話（有內容時，issue #140；空白對話不入列）；switchConversation 跨專案時切 cwd + 重啟執行時。**conv-cwd-test 全過**（conv-cross-project 依賴 pi mock provider，pi 基線同樣失敗，非迴歸） |
| 13  | **會話 JSONL 保留期清理**              | ✅ `PI_WEB_DSH_SESSION_RETENTION_DAYS`（預設 90）：啟動 10s 首清 + 每 24h 冪等清理（目錄內最新檔案 mtime 判活躍，JSONL 追加寫不更新目錄 mtime）                                                                                                                                                                                       |
| 14  | **session 搜尋增強**                   | ✅ searchSessions 索引納入 tool-result 的巢狀工具輸出文本                                                                                                                                                                                                                                                                             |

### 8.3 P2 — 新能力

| #   | 項                             | 狀態與實現                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | **工具橋（外掛注入點）**       | ✅ 完成（§2.8）—— RPC `tools/sync` 註冊（pi JSON Schema → DSH 引數對映）+ `tools/list` 校驗 + `tools/call-result` 回傳；trampoline execute 發 `tools.call.request` 通知 → 服務端跑外掛實現 → `tools/call-result` 恢復。goal-rpc.mjs 併入（已有 transport）；`applyPluginAgentTools` 重同步 + `runtime.onStarted` 在每次啟動後自動註冊。真 key E2E 實證（模型調 test_echo → 外掛回顯 `ECHO:…` → 模型回覆）                                       |
| 16  | **MCP 橋**                     | ✅ 完成（§2.9）—— **走 pi 的 McpBridge + #15 工具橋**：`<dataDir>/mcp.json` → McpBridge 啟動 stdio MCP 伺服器 → `adaptMcpTool` 把遠端工具適配成 `PluginAgentTool` → 經 `pluginToolsProvider`（含 `mcpBridge.getTools()`）自動流入 #15 的 `tools/sync` 橋 → 模型呼叫 → `McpClient.call` 轉發 → 結果回傳。真 key E2E 實證（fake MCP 伺服器 `mcp_echo` → `MCP_ECHO:marker`）。取捨：未用 DSH 本機 MCP client（那是另一套配置/生命週期，收益邊際）  |
| 17  | **模型目錄動態化**             | ✅ goal-rpc.mjs 加 `model/list`（ctx.llm.listModels）+ dsh-client.listModels + listModels 合併本地表（定價/上下文/vision 標記）與動態目錄；setModel 校驗含 dynamicModels。⚠️ 本輪修復隱藏 bug：goal-rpc 的 `inject` 缺 `"llm"`，導致 `ctx.llm.listModels` 報 `cannot get property "llm" without inject`，動態目錄從未真正生效（本地表恰好 3 個模型掩蓋了錯誤）——已補 `inject` 加入 `"llm"`                                                      |
| 18  | **技能啟停 UI**                | ✅ 完成（§2.10）—— 新增 skills/list + skills/get + skills/set-disabled RPC（直連 `ctx.skills` SkillRegistry）；`settings_state.skills` 塞入真實 DSH 技能（enabled 由 disabledSkills 推導）；停用集推送執行時，晚 `agent/pre-step` 鉤子按 `server.disabledSkills` 過濾 skill-catalog 訊息（自包含重建 `source.entries` + `<available_skills>` 塊，不 import dsh-skill）。純函式 `filterSkillCatalogMessage` 單測 + 註冊/列表/停用往返 probe 實證 |
| 19  | **fork 會話的目標遷移提示**    | ✅ forkConversation 檢測原 conv 有 active goal（verdict=pending）→ notice 追加"原目標已隨舊會話存檔，如需繼續請重新設定目標"                                                                                                                                                                                                                                                                                                                    |
| 20  | **提問橋併發排隊**             | ✅ goal-rpc.mjs askUser 排隊（深度 3，滿則 reject），answer 後 `dispatchNextQuestion` 自動發下一個；一次只向瀏覽器展示一個                                                                                                                                                                                                                                                                                                                      |
| 21  | **流式 UI 增強（思考塊摺疊）** | ✅ 複用 ThinkingBlock 摺疊（pi 同款）；根因是 dsh pushSettings 把 thinkingWrap 寫死 true → 已改為 settings.thinkingWrap 預設 false（與 pi 一致），長思考預設摺疊                                                                                                                                                                                                                                                                                |

### 8.4 測試與交付

| #   | 項                           | 現狀                                                                                                                                                                                                                                                                                                                             | 方案 |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 22  | **dsh 專屬冒煙套件**         | ✅ 完成（§8.6）—— `tests/dsh-smoke-test.mjs` 零 key 協議冒煙（已納入 run-smoke ALL），`tests/dsh-goal-test.mjs` / `dsh-question-test.mjs` / `dsh-vision-test.mjs` 真 key 門控（無 key SKIP 退出 0）。⚠️ 順帶修復 P2-17 隱藏 bug：goal-rpc inject 缺 `llm` 導致動態模型目錄從末真正生效（本地表恰好 3 個模型掩蓋了錯誤）          |
| 23  | **瀏覽器 E2E（playwright）** | ✅ 零 key UI E2E（§2.11）—— `tests/dsh-ui-test.mjs`：引擎徽標（DSH）/目標條/設定面板「DSH 使用者補丁」區塊（掃 dsh-patches 展示檔案）/技能頁籤 DSH 說明文案，5/5 通過。流式/圖片貼上/提問對話方塊的瀏覽器級渲染由協議級 dsh 測試（goal/question/vision）覆蓋 + 引擎無關共享元件（StreamMarkdown/QuestionDialog/image-paste）保證 |
| 24  | **部署文件**                 | ✅ 完成（§8.7）—— `docs/deployment.md` 新增「引擎選擇（pi / DeepSeek Harness）」章節（PI_WEB_ENGINE / DSH 執行時樹 / 環境變數速覽 / 使用者補丁層 / systemd+launchd env 示例）；`Dockerfile` 加全域性 dsh 執行時樹安裝；`docker-compose.yml` 加 DSH 註釋。`docs/env-vars.md` 此前已含 DSH 變數                                    |

### 8.5 已知取捨（不打算改，除非使用者要求）

- **無逐字流式**：message_delta 通道已實現，60ms 快照節流是設計使然（pi 同款）。
- **queue = 傳送即清**：DSH 無 mid-run steering，isStreaming 時 prompt 走 followUp，前端樂觀訊息即時入流。
- **無獨立審查者**：goal 完成/受阻由模型自判定（DSH 官方設計）；blocked 需連續 3 輪同條件。
- **abort = 重啟執行時**：所有會話的執行一起停（DSH 協議面無 per-session close）。
- **模型配置表單 / 自定義 provider**：DSH 引擎只有內建 deepseek 模型，v1 明確不支援。

### 8.6 dsh 專屬冒煙套件（#22，本輪完成）

把原先的臨時 probe（mixed / native-goal / patch-seam / vision）轉成正式 `tests/*-dsh-test.mjs` 用例，零 key 部分納入 run-smoke，真 key 門控部分獨立跑（無 key 列印 SKIP 退出 0）：

| 檔案                          | 門控   | 覆蓋                                                                                                                                                                                                                                                                                                                                                   | 狀態                              |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| `tests/dsh-smoke-test.mjs`    | 零 key | ready.engine=dsh、初始推送（conversations/goal_status/settings_state/slash_commands/snapshot）、dsh_patches 列表、list_sessions、list_models（本地表+動態目錄合併）、set_settings 回顯+重連持久化、agent 預設（dsh_presets 預設/切換/改預設/非法拒絕）、許可權三檔（dsh_permission_set/default）、slash 攔截（/model /cwd）、terminal echo、scm_status | ✅ 全綠，**已納入 run-smoke ALL** |
| `tests/dsh-goal-test.mjs`     | 真 key | set_goal → goal_status 進行中 → round-driver 自動續輪 → 模型自判定 complete → clear_goal 清空                                                                                                                                                                                                                                                          | ✅ 3/3，~3s                       |
| `tests/dsh-question-test.mjs` | 真 key | 模型 ask_user_question → question_pending → question_answer → 模型收到答案繼續回覆（text_delta）                                                                                                                                                                                                                                                       | ✅ 3/3                            |
| `tests/dsh-vision-test.mjs`   | 真 key | set_model vision-exp → imageData 附件 → attachment/save → 模型看圖回覆                                                                                                                                                                                                                                                                                 | ✅ 1/1                            |
| `tests/dsh-tools-test.mjs`    | 真 key | 外掛 registerAgentTool → 模型呼叫橋接工具 test_echo → 服務端執行 → ECHO:marker 回傳模型與對話                                                                                                                                                                                                                                                          | ✅ 2/2                            |
| `tests/dsh-mcp-test.mjs`      | 真 key | mcp.json → McpBridge 發現 mcp_echo → 模型呼叫 → MCP_ECHO:marker 回傳模型與對話                                                                                                                                                                                                                                                                         | ✅ 2/2                            |

**踩坑記錄**：

- **使用者 patch 檔案不能 insert 重複的 dsh-session entry**（與 base bundle 的 `sessions` service 註冊衝突 → boot 失敗，表現為 initialize 報 `cannot create effect on inactive context`）——冒煙測試改用 probe-patch-seam 驗證過的無害 persona 覆蓋。
- **WS wait helper 超時必須從 waiters 移除自己**：超時後 stale pred 留在佇列裡會靜默消費後續新訊息，導致迴圈等不到真正目標狀態——dsh-goal/qu estion/vision 的 connect 都內建了 `waiters.indexOf(entry)` 移除。
- **DSH text_delta 是逐字推送**（每個 delta 長度 1-2 字）：判定不能 `delta.length > 3`，要累計拼接判斷（`repliedText.length >= 4`）。
- **message_delta 欄位是 `assistantMessageEvent`**（`{type, contentIndex, delta}`），不是 `delta`。
- **Vision 測試 set_model 後要等 8s**（換模型=重啟執行時 + vision boot），等 5s 不夠。

### 8.7 部署文件（#24，本輪完成）

- `docs/deployment.md` 新增「引擎選擇（pi / DeepSeek Harness）」章節：PI_WEB_ENGINE 切換、DSH 執行時樹需求（`npm i -g @deepseek-ai/dsh@0.1.1-rc.2`）、DSH 環境變數速覽表、使用者補丁層（dsh-patches）、systemd/launchd 服務環境變數示例（`Environment=` / `EnvironmentVariables`）。
- `Dockerfile` runtime 階段加 `RUN npm i -g @deepseek-ai/dsh@0.1.1-rc.2`（映象自帶 dsh 執行時樹，`npm root -g` 可解析）。
- `docker-compose.yml` environment 加 DSH 註釋（`PI_WEB_ENGINE` / `PI_WEB_DSH_PATCH_DIR` 示例）。
- `docs/env-vars.md` 此前已含全部 DSH 變數（第 19-25 行），無需改動。
