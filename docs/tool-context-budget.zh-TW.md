[English](./tool-context-budget.en.md) · [简体中文](./tool-context-budget.md) · **繁體中文**

# 工具上下文預算（tool context budget）

> 模型每輪都要吞下「全部活躍工具」的名字 + 完整引數 schema。工具一多，這是幾萬字元的
> **固定開銷**（哪怕這輪只用 bash）。本文件記錄壓這塊開銷的四條手段、各自的取捨，以及
> **延遲載入為什麼不會打壞供應商的字首快取**（這是實現裡最容易踩壞的一條）。
>
> 相關程式碼：`server/load-tools-tool.ts`（按需載入入口）、`server/tool-manager.ts`（門控 +
> `lazyLoadingDisabledTools`）、`server/prompt-composer.ts`（提示詞目錄段）、
> `server/tool-prompt-overrides.ts`（逐工具文案覆蓋）、`server/agent-service.ts`
> 的 `applyToolGating` / `lazyToolCatalog` / `promptToolCatalog` / `loadLazyTools`。

## 請求級只讀結果去重

`server/request-context.ts` 通過 SDK `context` 事件構造本次請求檢視，不改寫 SDK 歷史、磁碟轉錄或 UI 訊息。僅對 `read` / `grep` / `find` 中引數與純文本輸出完全相同、輸出序列化長度至少 4096 字元的成功結果去重。保留首次全文及全部 tool call/result 配對，後續結果引用首次呼叫 id；錯誤、圖片、帶額外欄位的文本及無對應呼叫的結果保留原樣。

每次請求從當前上下文重建引用，不儲存跨請求索引，因此壓縮刪除舊證據後會自動保留新的首次全文。使用者介入、修改工具或未知工具（包括 codemode / 外掛）呼叫與結果均清空證據索引；混合讀寫批次不建立索引。同一查詢只與最近一份有效全文比較，內容變化、錯誤、小結果、圖片或結構化結果都會使該查詢的舊證據失效，防止內容 A → B → A 時跨版本引用。去重僅向後引用，不因後續訊息重寫較早的去重結果。不改寫 SDK 歷史或原有軟上限壓縮口徑。

### 大輸出持久證據

僅 pi 引擎接入。持久會話且 `read` 活躍時，按當前模型視窗的 70% 減去系統提示、活躍工具 schema 及輸出預留估算訊息預算（字元 / 3，非供應商精確 tokenizer）；預算不足才從較早輸出開始外接，最近兩條工具結果保留全文。成功的純文本 `read` / `grep` / `find` 結果達到 24000 字元後，儲存至 `<session.jsonl>.evidence/<sha256>.txt`，請求中保留前後各 3000 字元及可用 `read` 分頁讀取的穩定標識 `context-evidence:<sha256>`。`read` 在進入 SDK `tool_call` 與宿主許可權守衛前將標識解析為當前 SDK 會話證據目錄下的檔案路徑；不增加工具 schema，不繞過既有讀取實現。原始歷史保持不變；不處理錯誤、圖片、簽名文本和結構化結果。臨時會話及 SSH 工作區保留全文（遠端 `read` 無法讀取服務端本地證據路徑）。

證據檔案按會話隔離、以內容定址，已有檔案必須內容校驗通過；先寫臨時檔案再以排他硬連結提交，成功後才替換請求內容。使用有界分塊讀取、檔案控制代碼檢查及摘要校驗，拒絕符號連結和超限內容；取消貫穿佇列與 I/O，取消不回退成正常請求。同一會話的校驗、預算檢查與寫入序列執行，避免併發突破額度；不同會話互不阻塞。單檔案最多 1MiB，會話目錄在寫入前檢查 64MiB 預算；失敗或超額均保留原文。證據無自動過期；通過宿主刪除會話時，在刪除轉錄後按同一寫入佇列清理證據目錄，遲到寫入因轉錄不存在而回退原文。清理失敗會反饋刪除失敗。隨會話轉錄一起備份或遷移；僅複製 JSONL 不會攜帶證據目錄。未壓縮的原始工具輸出仍在轉錄中，因此分支或遷移後的請求可在新會話位置重建證據；新穩定標識在攜帶證據目錄遷移後可從新會話位置解析；舊版本已經進入壓縮摘要的絕對路徑仍需要原證據目錄可用。pi 宿主的訊息分支與編輯重問入口會在繼續執行前校驗並複製父會話證據，子會話獨立持有檔案，刪除父會話不影響子會話。複製失敗會反饋操作失敗；未釋出分支清理轉錄與資源，編輯重問在複製失敗後恢復原會話。外部只複製 JSONL 而沒有證據目錄時，摘要中的證據仍不可用。證據路徑仍受現有 `read` 許可權校驗，不提供額外 HTTP 下載入口。請求仍攜帶原始歷史供 SDK 壓縮統計，因此這不會降低 SDK 的壓縮觸發水位。

### 壓縮任務狀態與證據索引

`server/compaction-instructions.ts` 在 SDK 預設壓縮鏈路統一追加保留要求：目標、使用者約束、已驗證事實及證據、實際修改、驗證結果、未決問題與下一步。保留 SDK 自帶摘要格式，區分假設與事實、自述摘要與原始證據，不另起模型請求。覆蓋手動、軟上限與預設自動壓縮；擴充套件直接提供的自定義摘要仍由擴充套件負責。

摘要生成後、持久化前確定性附加證據索引，最多列 32 個穩定引用，完整列表可通過 `read({path:"context-evidence:index"})` 獲取。索引只含檔名，不注入正文，避免壓縮時模型看不到請求投影中的引用而遺忘證據。

SDK 沒有自動壓縮指令及許可權前別名解析的公開介面，分別用 `installCompactionInstructions` 和 `installEvidenceToolHooks` 的私有介面介面卡，檢查結構與引數個數，冪等安裝；SDK 不相容時保留預設行為。這些介面卡需要隨 SDK 升級迴歸驗證。

軟上限自動壓縮的自定義指令可通過設定項 `autoCompactionInstructions` 傳入（空 = 不傳，保持 SDK 預設摘要）：擴充套件可藉此讓 `session_before_compact` 鉤子接管自動壓縮的摘要生成，無需修改宿主原始碼。隻影響自動壓縮；手動 `/compact` 與 AI 的 `compact_context` 仍各自傳自己的指令。證據目錄仍需隨轉錄遷移，舊絕對路徑不自動改寫。

驗證：`tests/unit/request-context.test.ts`、`context-evidence.test.ts`、`compaction-instructions.test.ts`、`evidence-tool-hooks.test.ts`、`context-integration.test.ts`。

## 1. 一塊開銷有多大

以 30 個目錄/核心工具為例（設定頁「檢視工具 schema」能看到即時數字）：

| 組成                                           | 約            |
| ---------------------------------------------- | ------------- |
| 工具文字（description + snippet + guidelines） | 11.3k 字元    |
| 引數 schema（JSON，含引數說明/列舉/預設值）    | 18.6k 字元    |
| **下發工具 schema 合計**                       | **~33k 字元** |

引數 schema 是結構化的**契約**（列舉、預設值、範圍、逐 action 語義），刪了模型就會傳錯引數，
所以「摳字」這條路的下限很低（實測全量收斂後只能再降 ~11%）。

## 2. 四條手段

### 2.1 文案精簡（已做）

見 `AGENTS.md` 的「工具提示詞三處職責分離」。description = 做什麼 + 副作用；snippet = 觸發
條件（≤80c）；guidelines = 何時用/順序/禁止。同一件事只說一遍，守衛
`tests/unit/tool-prompt-hygiene.test.ts` 機器把關。

### 2.2 逐工具文案可編輯（已做）

設定 → 工具區「編輯文案」：`description` / `promptSnippet` / `promptGuidelines` 都能覆蓋，
留空 = 用出廠預設。存在 `ClientSettings.toolPromptOverrides`，打補丁落在 SDK 合併後的
`_toolRegistry` 上（核心內建 / 本專案工具 / 外掛 / MCP 一網打盡）。見
`server/tool-prompt-overrides.ts`。

### 2.3 延遲載入（本機制，**預設關**，可開；名單制）

開：`load_tools` 常駐；只有**按需名單**（`ClientSettings.toolOnDemandTools`，見 §2.6）裡的工具才走延遲——
它們在系統提示詞的 `{{tools}}` 段裡只有**名字 + 一行摘要**（目錄），引數 schema 不進上下文。模型
要用時先調 `load_tools(["patch","lsp"])`，那批工具被啟用，schema 才隨之下發。
名單外的工具（含核心工具 `bash` / `read` / `edit` / `write`）按開關/預設常駐可用；名單為空時等於都不延遲
（此時 `load_tools` 也不掛載、`{{tools}}` 段整段不輸出，見 §3）。

- 開關：設定 → 工具區「工具按需載入」（`ClientSettings.toolLazyLoading`，**出廠預設關**，即 `load_tools` 總閘）。
  預設關的理由：模型忘載入會先吃一次 `Tool <name> not found`（SDK 只認已宣告集），開箱
  即用優先；需要省上下文的例項自己開啟，部署級預設可用環境變數 `PI_WEB_TOOL_LAZY_LOADING=1`
  / `true` / `on` / `yes`（只作預設值，使用者已存檔的設定優先）。
  關著 = 按開關/預設直接全部活躍（與 pi 命令列一致，名單無效果）。**隻影響新會話與之後的門控重放**——
  不會把正在跑的對話裡的工具反向清空。
- 門控實現：延遲載入**不引入第二條門控路徑**。未載入的名單工具 = 臨時加進停用名單
  （`lazyLoadingDisabledTools(all, loaded, core, onDemand)`，`only` 即名單），走的還是 `applyAgentToolsGating` 那條鏈。載入只是把
  名字從名單裡拿出來。
- `load_tools` 是**常駐腳手架工具**，不入 `AGENT_TOOL_CATALOG`（不能單獨關掉它，只能用總開關控制有無），
  由 `applyAgentToolsGating` 的 `forceActive` 保證在非 standard 預設下也在活躍集裡
  （`ask` 預設本來就無工具，不強加）。
- 已載入集合按 **session 物件**存（`WeakMap`）：過戶搬的就是 session 本體，集合跟著走；
  會話從轉錄恢復時用當時的活躍集做種子（只記住名單裡的，上次載入過什麼就還是什麼）。
- 載入會**拒絕**：未知名字 / 不在名單裡（常駐直接調） / 已被使用者關閉 / 當前預設不允許 / 計劃模式閘門攔截 / 已經載入過
  —— 原因寫回工具結果，模型能自己糾正。
- **模型忘記載入、直接呼叫目錄裡的工具**（JIT 自動啟用）：SDK 在解析工具之前就派發了
  `tool_execution_start`，隨後因該工具不在活躍集回一條 `Tool <name> not found`；服務端在
  這個事件裡把該工具補進已載入集**並立刻重放門控**，於是它從下一輪起真的活躍 —— 模型原樣
  重試即成功，不必先繞道載入別的工具（issue #652）。
- 「已經載入過」按**活躍集**判斷，不只看已載入集合：只標記不啟用的半吊子狀態會被當成
  重新載入並修正，而不是回一句「已經載入過了」把模型堵死（同 #652）。
- DSH 引擎沒有 pi 工具註冊面，不適用（設定行不顯示，協議欄位恆為 false 佔位）。

### 2.4 共享子 schema 單源（大工具專用）

一個問題物件曾經在 `ask_user_question` / `communicate` / `conversation` 各抄一遍
（`preview` / `recommended` / `dependsOn` / `optionsMap` 這套富互動欄位），下發給模型
就是同一段結構的三份複製，改欄位還得改三處。現在統一在 `server/question-params.ts`：

- `richQuestionsSchema()`：富彈窗的全量欄位（`preview` / `dependsOn` / `optionsMap` 這些彈窗專屬能力的事實源）；
- `askQuestionsSchema()`：`ask_user_question` 下發給模型的派生檢視——去掉彈窗專屬欄位與裝飾關鍵字，模型只看到「問什麼、給哪些選項」，欄位定義仍只有富檔一處；
- **跨對話工具不再宣告問題/回答結構**：`communicate` 的 `request`/`reply` 與 `conversation`
  的 `consult`/`answer` 只收純文本 `message`，結構化提問只留在 `ask_user_question`。
  服務端在狀態機入口（`server/conversation-communication.ts` 的 `questionsFromMessage()` /
  `answersFromMessage()`）把文本折成內部結構：問題包成 `[{ id: "q1", question: message }]`，
  回答按待答問題展開成 `{ id, selected: [], custom: message }`。舊的結構化
  `questions`/`answers` 仍然照收（TypeBox 不寫 `additionalProperties: false`），由
  `checkQuestions`/`checkAnswers` 原樣校驗後轉發——**能力不減，只是不再付費下發結構**。

同期收緊同一批大工具的文案冗餘（實測，字元數含 description/snippet/guidelines，括號內為引數 schema 本體）：

| 工具           | 前                | 後                | 手段                                                                                                            |
| -------------- | ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| `conversation` | 4785（引數 4505） | 1998（引數 1718） | 結構化問題/回答結構下線、逐引數文案清零、`enum` 取代 `anyOf`、邊界校驗移進 handler、action 用一行簽名管全部引數 |
| `communicate`  | 2217（引數 1418） | 1266（引數 467）  | 同上：`questions`/`answers` 下線、`enum` 取代 `anyOf`、`minLength`/`min/max` 移進 handler                       |

判斷標準：引數 schema 是契約，欄位型別與 `enum` 不能刪；能刪的是**同一段結構/同一句話的
第二份複製**、逐欄位的 description（改成 `action` 欄位裡一行緊湊簽名）、機械邊界
（`minLength`/`minItems`/`minimum`/`maximum`，一律搬進 handler 用 `Math.min/Math.max` 兜底），
以及 description 裡的「何時用」（那是 snippet 的職責）。另一條路是徹底不付這筆錢：把這兩個
工具交給延遲載入（§2.3），代價是模型多一步 `load_tools`。

同一套標準現在覆蓋全部常駐工具（`read` / `bash` / `edit` / `write` / `ask_user_question` /
`browser_page` / `claim_files` / `present_files` / `skill` / `grep` / `find`）：匯出 schema 只剩
欄位名與型別，候選值寫 `enum`（`browser_page.op` 的簽名一句話交代每個 op 要哪些引數），逐欄位
說明只留真不自解釋的五個（`read.offset`、`bash.timeout`/`persist`、`edit.soft`、
`present_files.items[].focus`、`skill.name`）。`write` / `grep` / `find` 的實現仍是 SDK 內建，只是
文案與 schema 由 `server/tool-prompts.ts` 換掉（`withSlimPrompt()`），欄位名與 SDK 定義的一致性由
`tests/unit/tool-schema-slim.test.ts` 盯住。後續把同一把尺子推到其餘 15 個宿主/SDK 工具與 `sftp`
外掛（§2.5）。`codemode` 的 description 由 SDK 按每輪 loadout 現算（內含 `tools.<name>` 宣告），
宿主不覆蓋它，預算由 `codemodeInlineBudget` 控。

### 2.5 低頻/大工具同樣脫水（第二批，實測 −37%）

同一套標準此前只落在 11 個常駐工具上，其餘 15 個宿主/SDK 工具 + `sftp` 外掛沒人守，於是又長回來了：
`action` 用 `Type.Union([Type.Literal…])` 展開成 `anyOf` 的 const 陣列、`Type.Record()` 展開成
`patternProperties`、`minimum`/`maximum`/`minLength` 全在、逐欄位說明覆述一遍 action 語義。

現在按同一把尺子收斂（實測字元數：description + snippet + guidelines + 引數 schema 本體）：

| 工具              | 前   | 後   | 手段                                                                                             |
| ----------------- | ---- | ---- | ------------------------------------------------------------------------------------------------ |
| `canvas`          | 2946 | 2516 | 24 項 `action` 的 `anyOf/const` → `enum`；`Type.Record()` 的 `patternProperties` → `type:object` |
| `mcp_manage`      | 2777 | 1436 | 3 處 `anyOf` → `enum`、`env`/`headers` 的 `patternProperties` 下線、14 條欄位說明 → 1 行簽名     |
| `sandbox`         | 2245 | 1020 | 2 處 `anyOf` → `enum`、8 條欄位說明清零                                                          |
| `delegate_task`   | 2139 | 1554 | 7 個必填欄位的說明搬進 `promptGuidelines`（欄位契約不變，只換陳述位置）                          |
| `terminal`        | 2131 | 1274 | `anyOf` → `enum`、`minimum`/`maximum`/`minLength` 搬進 `create` 的 `Math.min/max` 兜底           |
| `schedule`        | 1685 | 881  | 逐欄位說明清零，只留 `schedule` 的 cron/延遲一句                                                 |
| `worktree`        | 1525 | 963  | 2 處 `anyOf` → `enum`/`type:["boolean","string"]`、7 條說明清零                                  |
| `lsp`             | 1526 | 803  | 8 條欄位說明 → 1 行 action 簽名、`minimum/maximum` 清零（handler 已 `Math.min/max`）             |
| `patch`           | 1295 | 1114 | `minimum/maximum` + 2 條說明清零（description 是 Hashline 語法本體，保留）                       |
| `plan_update`     | 1121 | 771  | 6 條欄位說明清零                                                                                 |
| `compact_context` | 1065 | 694  | `minimum/maximum` 清零（`calculateEffectiveKeepRecentTokens` 已夾緊）、只留 `focus` 一句         |
| `eval`            | 882  | 492  | `minimum/maximum` 清零（handler 已夾緊）、只留 `timeout`/`reset` 兩句                            |
| `powershell`      | 590  | 252  | 同 `write`/`grep`/`find`：SDK 實現 + `withSlimPrompt()` 換文案與 schema                          |
| `ls`              | 422  | 180  | 同上                                                                                             |
| `sftp`（外掛）    | 4851 | 2807 | 24 條欄位說明 → 1 行 action 簽名 + 6 條憑據欄位的關鍵提示；`manifest.json` 0.4.8 → 0.4.9         |

合計 **27.9k → 16.9k 字元（−39%）**；當時出廠預設常駐的那 9 個（`ls` / `patch` / `delegate_task` /
`sandbox` / `worktree` / `plan_update` / `compact_context` / `schedule` / `canvas`）**14.5k → 9.7k
（−33%，約省 1.3k tokens/輪）**。

> 後續產品決定（見 `server/tool-manager.ts` 目錄）：`ls` / `patch` / `delegate_task` / `sandbox` /
> `worktree` / `canvas` 均改為 `defaultOn: false`。出廠預設常駐的只剩 `plan_update` /
> `compact_context` / `schedule` 三個，上表的「出廠預設常駐」口徑按此收窄；`ls` / `patch` 等工具
> 的 schema 瘦身成果仍在，使用者顯式開啟後照舊受益。

**這一批刻意沒做的事**（都量過代價，結論是負收益）：

- **不刪工具**。`powershell` / `eval` / `lsp` / `terminal` / `mcp_manage` / `tool_search` 出廠
  `defaultOn: false`，在預設口徑裡本來就是 0 字元——刪掉只丟能力不省預算；`ls` / `patch` /
  `delegate_task` 是 `defaultOn: true` 的產品面（`tool-manager.ts` 目錄 + 設定行 + i18n + 守衛單測），
  刪的是功能不是開銷。`patch` 的 926 字元 description 是 Hashline 語法契約本身（`[path#TAG]`/`PUT`/`CUT`），
  刪了模型就寫不出補丁；`delegate_task` 的 7 個必填欄位是反「含糊派單」的校驗契約，改成可選就把
  `validateDelegation()` 的失敗模式放回來了——所以只搬陳述位置，不動必填性。
- **不合並 `sandbox` + `worktree`**。兩者都是「換 cwd」，但一個是 CoW 工作區、一個是 git 分支隔離，
  合併只省約 1.2k 字元（~330 tokens），代價是兩套 service/審批/設定行/許可權閘門併成一套 15 項 action 的
  混合列舉，且違反「一個能力一個工具名」。
- **不改預設開關去「延遲載入」它們**（當時結論）。延遲載入已經由 §2.3 的全域性開關提供；把 `canvas` /
  `sandbox` / `schedule` 這類主打功能預設改成待載入，是產品決定，不是預算最佳化的順帶結論。後來的
  產品決定是**直接預設關閉** `ls` / `patch` / `delegate_task` / `sandbox` / `worktree` / `canvas`
  （目錄 `defaultOn: false` + 出廠設定 `disabledAgentTools` 同名單），理由不再是預算，而是預設工具面
  收窄；`plan_update` / `compact_context` / `schedule` 仍預設開。

守衛：`tests/unit/tool-schema-slim.test.ts` 現在把上面 21 個工具全部納進來（含 `patternProperties`），
任何一條裝飾約束、任何一個白名單外的欄位說明都會紅。

### 2.6 按需名單：延遲範圍統一登錄檔（內建 + 外掛自動合併）

§2.3 的延遲載入是**名單制**（只有名單裡的才延遲，模型再調 `load_tools` 拉回來）。名單外的常駐，
名單為空等於都不延遲。

`toolOnDemandTools`（設定 → 工具區「按需工具列表」，協議欄位與預設欄位同名）就是這份延遲名單：

- **列進去 = 延遲**。開關開著時：不啟用、引數 schema 不進上下文，模型需先調 `load_tools` 拉取（載入後本對話後續常駐），也會被 JIT 自動啟用；
  開關關著時名單無效果（全部按開關/預設常駐）。`isNeverLazyTool()`（核心 4 件套 + `load_tools`）永不延遲，前後端共用同一語義。
- **統一登錄檔，不寫死**。`TOOL_NAME_PATTERN` + `foldLegacyToolName()` + `isValidToolName()` 是唯一命名口徑（見 `server/tool-manager.ts`）：
  內建直接收，外掛 / MCP / 未來工具按正則收，孤兒項（外掛已解除安裝/跨裝置）保留防丟；舊別名自動摺疊。
  前端庫存見 `web/src/tool-inventory.ts`（`buildOnDemandOptions`）：內建目錄 + 即時外掛庫存 + 孤兒兜底，
  所有工具管理 UI 都從此庫存派生，不再手寫 `[...AGENT, ...CORE]`。
- **劃分單源**。`partitionLazyTools({all, allowed, onDemand, loaded})` 一次算出 `{resident, pending, loadedLazy}`，
  門控/目錄/載入/JIT/提示詞基線共用同一劃分；`disabledToolSet()` 收斂計劃/委派/子代理閘門，`loadLazyTools` 不再手寫第二份。
- **不再硬關閉**。`effectiveDisabledAgentTools()` 不再併入名單，常駐/停用只由 `disabledAgentTools`（內建）+ `disabledPluginTools`（外掛，註冊層過濾）+ 預設與模式閘門決定。**沒有第二條門控路徑**——
  `applyAgentToolsGating` / `allowedToolNames` / 提示詞目錄讀的都是同一套允許集，延遲只是臨時加停用（`lazyLoadingDisabledTools(..., onDemand)`）。
- 與 §2.3 的關係：開關是 `load_tools` 總閘（開才有該工具），名單決定延遲範圍（含外掛）。DSH 引擎不適用（無 pi 工具註冊面，設定行不顯示）。
- 守衛：`tests/unit/tool-manager.test.ts`「按需名單 + 架構單源」用例釘住命名規則/別名/劃分/孤兒保留；`tests/lazy-tools-test.mjs` 開關開啟後先寫名單再建會話。

## 3. 硬約束：不能打壞字首快取

供應商的 prompt cache（Anthropic `cache_control`、OpenAI/DeepSeek 自動字首快取）是按**字首**
命中的：只要這一段和快取過的完全一致就命中，哪怕後面追加了新內容。所以我們只允許**追加式**
變化，絕不允許「中間改一個字」。

延遲載入天然踩這個坑：直觀實現會把「已載入」的工具從目錄段挪到「活躍工具」段——目錄段一
變，系統提示詞就變，整段快取報廢。**本實現刻意規避**：

1. **系統提示詞與已載入集合無關**。`{{tools}}` 在延遲載入下只列**按需名單**（
   `promptToolCatalog()`：登錄檔順序，**不過濾已載入**）且**不列常駐工具**——常駐工具的 schema 已全量
   下發，重複列只是白花 token；段首一句恆定**純英文**精簡說明（`On-demand tools (schema not attached — call load_tools with the names first):`，不進雙語，與工具提示詞口徑一致）。
   名單為空時這一段整段不輸出（沒有可載入的工具，`load_tools` 也不掛載）。
   載入前後逐位元組相同（只隨設定/預設變，不隨載入變）。
2. **guidelines 只取常駐**。延遲載入下系統提示詞的 Guidelines 段只含常駐工具（允許集 - 名單，含核心 +
   `load_tools`）的要點；被載入工具的要點**隨 `load_tools` 的回執文字**進對話（追加，不是
   改字首）。
3. **tools 陣列只追加**。載入只產生 `toolsAdded` 增量（SDK 的 `getToolStateChanges`），
   不會出現 `toolsRemoved`/redefinition；支援中途工具變更的供應商（Anthropic
   `defer_loading`、OpenAI `additional_tools` / `tool_search`）會把新增工具**錨在初始宣告
   上**流式注入（`resolveTranscriptTools` 的 `anchorsAdditions`），其餘供應商把當前列表
   原樣下發，也是「舊字首 + 新尾巴」。
4. **順序穩定**。目錄與基線名單都按登錄檔順序生成，同一設定下重複渲染結果一致。

迴歸：`tests/lazy-tools-test.mjs`（零 token，mock LLM）直接斷言
「載入前後 system 文本**逐位元組相同**」與「第二次的 tools 以第一次為**字首**」，並覆蓋
「模型直呼未載入工具 → 該工具自動啟用 → 原樣重試成功」這條 JIT 路徑（#652）。

⚠️ 會破壞快取的操作（都在我們的控制面內）：改 `toolPromptOverrides`（工具定義變了 →
redefinition）、關掉某個工具（`toolsRemoved` → 該對話之後只能走非錨定路徑）。這些是使用者
主動操作，一次性代價可接受；但**不要**在自動化路徑裡改這些。

## 4. 換來的收益與代價

（都是**開啟**這個開關之後的口徑；出廠預設關，所以下面是「想省上下文時才付的代價」）

- 收益：常駐 schema 取決於名單大小——名單把重量級工具都收進來時 33k → **~7k**（核心工具 + load_tools + 名單外常駐）。名單裡的工具體用不到就永遠不進上下文；
  系統提示詞本身也從 ~8.6k 降到 ~6.7k（guidelines 只剩常駐）。名單為空時開關等同關閉（既不延遲、也不掛 `load_tools`、不出按需段），記得先勾名單再開開關。
- 代價：模型多一步「先載入再用」。目錄（名字 + 一行摘要）仍常駐，發現性不丟；載入失敗會
  寫明原因。弱模型可能忘記載入——所以這個開關**出廠預設是關的**（見 §2.3）。
  另外目錄**不重複列常駐工具**（尤其核心 4 件），它們的 schema 本來就在 `tools` 裡。
