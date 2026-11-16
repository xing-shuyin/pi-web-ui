[English](./architecture-core.en.md) · [简体中文](./architecture-core.md) · **繁體中文**

# 核心架構

> 改程式碼前必讀。本文件覆蓋快照驅動、協議單源、安全邊界、主題切換、多對話併發等全域性架構決策。

## 本輪對話計時

底部 `host:working` 使用 `UiState.turnTiming` 的服務端時間戳：訊息開始投遞時啟動，工具呼叫、插隊和自動重試沿用同一時鐘；本輪結束或停止時記錄 `finishedAt`，保留最終用時，下一輪重新開始。快照顯式下發 `null` 清空無計時的會話，避免切換對話殘留。前端每秒重新整理顯示，完成後停止定時器；計時文本獨立於可隱藏的狀態標籤，以相容窄屏佈局。

## 協作完成通知

pi 引擎的 `steeringMode` 與 `followUpMode` 預設均為 `all`：在各自交付點將當前佇列按入隊順序一次全部送達。設定頁分別提供開關，關閉對應項後使用 `one-at-a-time`，適合逐輪處理獨立任務。偏好由 Web UI 配置持久化，修改立即更新全部存活 pi 會話；新建、恢復及 SDK reload 後通過統一會話覆蓋入口重放，不寫入使用者的 pi CLI 設定。其他引擎保持各自佇列語義。

每個執行對話以 Conversation 物件繫結唯一 `exec-UUID` 身份，通訊地址複用該身份；父子關係在派發時一次繫結父物件，`cN` 僅作持有方區域性顯示編號。過戶保留物件與身份，只改變持有方及顯示編號，禁止維護全域性 `cN → cN` 別名。完成通知佇列、父子請示、專案祖先解析、任務依賴和等待展開均使用穩定身份；父對話關閉後身份失效，即使編號被複用也不重綁。舊編號只允許本地或全域性唯一解析，歧義時返回不可用。完成通知只投遞原父對話，關閉後降級為系統 Notice。身份只在程序內執行生命週期有效，不持久恢復舊物件或過期地址。

完成提示音、桌面通知和結束播報使用獨立的工作狀態邊沿：`isStreaming || completionPending`。`completionPending` 在活動快照和執行會話摘要中釋出，包含排隊 steering/follow-up、提示投遞視窗，以及子代理通知的聚合等待和非同步投遞；不會改變 `isStreaming` 的輸出語義。子代理通知在非同步結算工作樹和投遞期間持續佔用待辦計數，投遞完成或失敗後通過父對話當前持有方重新整理狀態。連續續跑直到佇列排空才觸發一次完成通知，前臺、後臺均適用。

## 手機系統通知與多裝置

React + Capacitor 手機客戶端、Hub 賬號隔離推送與裝置切換見 [`mobile.md`](mobile.md)。手機通知由服務端 `onNotificationEvent` 權威事件觸發，不依賴 WebSocket sinks；重試、壓縮、人工等待與子任務依賴未收口時不得提前報告完成。

通知點選攜帶例項、裝置、session 與 owner / conversation 標識。跨客戶端通過 `open_shared_conversation` 的 `readOnly: true` 檢視原執行物件，快照的 `sharedConversation.readOnly` 驅動只讀 UI；服務端只允許查詢及已有問卷 / 單次審批答覆，拒絕 prompt、終端、設定和工作區寫操作。該模式可檢視 independent / 子代理，但不放寬普通共享入口，也不搬遷 owner 或重新 load 會話。

共享檢視不搶左欄行操作：`dismiss / rename / pin / persist_conversation` 指向的不是當前共享會話時不算共享操作——本端會話交回本端分發，跨端 elsewhere 行由 `daemon.dismissConversation` 路由（`server/index.ts` 門面必須接線，否則 ✕ 靜默無效）；只讀共享仍只放行 viewer 自己持有的會話。行角標的分叉身份同理要跨重啟：`forkFrom` 只在記憶體，客戶端判角標必須同時看 `forked`（引擎從會話檔案頭 `parentSession` 推出）與歷史行的 `parentSessionPath`，否則重開/別處執行的分叉會話會掉成普通行。

## 桌面通知定位對話

`web/src/notify.ts` 在建立通知時固化目標會話的 `#s=<sessionId>` 深鏈；後臺完成和後臺問卷顯式傳入各自的穩定 `sessionId`，避免使用者切換對話或等待 Service Worker 註冊期間通知目標漂移。連結沿用部署子路徑，移除 `token` 和 `view` 查詢引數，鑑權沿用 Cookie。通知繼續不設定 `tag`，避免 Windows 靜默替換舊提醒。

`web/public/sw.js` 的 `notificationclick` 優先喚起已顯示目標會話的同源應用視窗，再通過 `pi-web-ui:notification-click` 訊息讓頁面複用現有深鏈路由切換會話；沒有應用視窗時直接開啟目標深鏈。已有頁面無需過載，接收點選時退出群組或其他頁面並顯示聊天；連線尚未就緒時由現有待處理深鏈機制延後切換。普通 `new Notification()` 回退也通過同一訂閱入口處理點選。目標 URL 與視窗必須位於應用同源和部署作用域內，舊通知缺少目標時回到應用入口。

驗證：`tests/unit/notification-click.test.ts` 覆蓋前後臺目標固化、Worker 缺失或失敗後的頁面通知、訊息訂閱與清理、已有視窗轉發、新視窗深鏈、子路徑及同源邊界；`tests/unit/session-url.test.ts` 維護深鏈格式和穩定會話標識契約。

## 側欄歷史會話載入

專案內會話順序由 `web/src/conversation-order.ts` 維護頁面生命週期內的統一記錄，歷史行與活動行共用排序。首次載入以服務端最新歷史摘要完成初始化，允許它替換預熱快取中的舊時間；初始化完成後凍結排序依據，重新整理頁面才重新載入最新順序。後續新發現的會話追加到末尾，只有使用者成功傳送訊息（含插隊、排隊與附件訊息）才將對應會話移到所屬專案全部會話頂部。流式輸出、工具呼叫、子代理建立/結束、後臺通知、問卷、錯誤、修改時間更新、常駐標記或開啟/切換會話均不觸發重排。

介面 `appSend` 為 prompt 附帶只在前端傳遞的 `userInitiated` 上下文；`useChat.send` 在 WebSocket 傳送成功後更新順序，外掛直接呼叫傳送器或顯式關閉該上下文時不置頂，空白或未連線傳送也不置頂。原生 CLI 只消費 `native_cli_prompt_submitted` 窄事件（Claude/Codex `UserPromptSubmit`、Pi `input(source=interactive)`），按 session 與 eventId 去重；終端輸出、普通按鍵、貼上和 working 狀態都不能替代使用者提交訊號。

會話 ID、sessionId 與檔案路徑關聯到同一位置，保證活動/歷史表示切換、重新開啟或過戶後保留順序。子代理保持父子樹（含工作樹子代理），向子代理直接傳送訊息時整體提升所屬父樹。順序只儲存在頁面記憶體，不寫入儲存；專案排位見「專案（工作區）排序」。

## 專案（工作區）排序

專案順序與「最近對話」時間解耦，事實源：`server/client-state.ts` 的 `remember(clientId, cwd, { promote })` 與 `web/src/project-order-settings.ts`。

- **時間只認真實對話**：`promote`（預設）只在真的發訊息時呼叫（pi `ClientSession.prompt`、`dsh` 與 `universal` 的 `prompt`），重新整理該專案 `lastUsed` 並推 `projects`。瀏覽/切換/恢復（`set_cwd`、`switchConversation`、開啟歷史對話、連線時恢復 `lastCwd`）一律 `{ promote: false }`：只寫 `lastCwd`、清 tombstone，未登記的補一條 `lastUsed: 0`，不動時間；`withCurrentCwd()` 也不再給當前專案打時間戳。否則「只是點開看看」會把專案頂到最新，下次載入順序就變了。
- **客戶端兩種模式**（localStorage）：自動模式（預設）按 `lastUsed` 降序，`lastUsed === 0`（從沒對話過）回退到「本瀏覽器首次出現時間」，所以新新增的專案天然在最上方；手動模式（設定「專案順序全靠手動」）只認持久化的拖拽/新增順序，新出現的專案置頂，聊天不再重排。拖拽或 Alt+↑/↓ 會自動切到手動模式。切模式不跳變：自動模式持續把當前順序映象進儲存，手動模式直接接手眼前排列。
- 專案行右側時間只在 `lastUsed > 0` 時顯示；驗證：`tests/unit/left-panel-stage-d.test.ts`、`tests/unit/left-panel-actions.test.ts`、`tests/unit/left-panel-open-conv-order.test.ts`、`tests/unit/client-state-recent-projects.test.ts`。相鄰專案節點之間使用主題邊框色分隔線與間距，分隔範圍覆蓋整個會話子樹。

「執行中對話」（`conversations`）和「歷史會話」（`sessions`）是兩個通道，但常常指向同一批會話，左欄必須把它們認成同一條，否則同一條會話會渲染成兩行。分工：**行歸屬由引擎裁定、身份由客戶端歸一**。

- 行歸屬：`ConversationSummary.rowKind`（`server/conversation-rows.ts`★ 單源）—— `open` = 對話自佔一行（執行中 / 等回答 / 子代理 / 固定 / 臨時 / 原生 CLI / 未落盤），`history` = 已由歷史行代表。三個引擎（pi `agent-service`、claude/codex `universal`、`dsh`）都在推送前算好；客戶端只讀 `rowKind !== "history"`，**不再自己按 `sessionFile` / `pinned` / 磁碟索引猜**。`hasHistoryRow` 未宣告時預設 `open`（寧可多一行也不讓對話憑空消失）。
- 身份：`web/src/session-identity.ts` 的強鍵（對話 id / sessionId 或規範檔案名推導的 uuid / 會話檔案路徑）；裸 token 的 path 視為會話 id（universal 底座就是這種形態），所以引擎即使漏發 `sessionId` 也不會重複。弱鍵 `fn:`（裸檔名）只用於關聯狀態點、未讀與停止按鈕，不能參與去重（不同目錄可能同名）。
- 引擎側的 `conversations` 摘要必須帶 `sessionId`（= 會話 id）與 `modified`，否則客戶端既認不出身份、也顯示不出時間、排序也不對。

相容分支：客戶端只在**整個 payload 都沒帶 `rowKind`**（舊服務端 / 移動端與伺服器版本錯位）時走 `legacyOwnsRow()` 啟發式；新版本發過後可整塊刪除（刪除條件寫在函式註釋裡）。協議改動同步 bump `PROTOCOL_VERSION`（雙端 `protocol-version.ts`）。驗證：`tests/unit/conversation-rows.test.ts`、`tests/unit/conversation-rows-engine.test.ts`、`tests/unit/conversation-row-declared.test.ts`（引擎漏宣告即紅）、`tests/unit/session-identity.test.ts`、`tests/unit/left-panel-row-kind.test.ts`、`tests/unit/left-panel-universal-dedupe.test.ts`。

驗證：`tests/unit/conversation-order.test.ts`、`tests/unit/use-chat-conversation-order.test.ts`、`tests/unit/left-panel-open-conv-order.test.ts` 與側欄搜尋、摺疊、操作迴歸。

本地對話、歷史會話與“另一處”對話執行完成後，尚未檢視時統一在行尾顯示藍色對勾；檢視後清除該標記。所有會話狀態圖示（載入/執行轉圈、等待問題、錯誤、未檢視對勾）通過 `ConversationRowIndicator` 共用最右側 14px 槽位，位於類別/預設徽標之後；顯示狀態圖示時隱藏時間，沒有狀態圖示時才顯示時間。

重新整理時會先恢復專案及展開狀態，再建立連線。`LeftPanel` 只在 `ready` 且 `status === "open"` 後請求已展開專案的歷史會話，且只有 `panelSend` 成功才登記已請求與載入狀態；斷線時清除請求記錄，重連後自動補發。手動展開與自動恢復共用請求記錄，避免重複請求。服務端返回空陣列 `[]` 同樣表示載入完成，應自動顯示“暫無歷史會話”，無需點選專案。

刪除歷史會話後同時重新整理當前專案與記錄所屬專案的列表；所屬專案從刪除前捕獲的執行對話或轉錄頭確定，SSH 本機快取路徑還原為邏輯工作區 URI。列表失效會遞增掃描代次並解除舊掃描的複用；失效前啟動的掃描不能回寫檔案或列表快取，其呼叫方沿用原專案與分頁引數重讀，避免舊 `sessions` 訊息重新顯示已刪條目。掃描結束只清理自身仍持有的在途記錄。驗證：`tests/unit/native-cli-conversation.test.ts` 與 `tests/unit/session-cache-bounds.test.ts`。

會話跑完一輪（`turn_end`）後按**該會話自己的 cwd** 補推一次會話列表（`scheduleSessionsPush`：首輪立刻推，600ms 內的後續輪次合併成一次尾部推送；客戶端沒請求過列表不推，會話銷燬時清定時器）。內容變化只做快取失效而不推送時，前端「執行中」分組會隨著會話結束把那一行移走，左欄又沒有新列表填進來——使用者看到的是「對話跑完就消失了，點一下專案才回來」；若改成推遲到節流視窗結束再推，中間的空窗就是可見的閃爍。推送前先刪掉該 cwd 的 `sessionInfosCache`，否則 TTL 30s 的舊列表會被原樣推回去。驗證：`tests/unit/session-list-refresh.test.ts`。

置頂歸屬由**會話檔案 header 的 `cwd`** 決定，不是由「當前在哪個專案裡點的釘住」決定：`pinSession()` 先 `readCwdFromSessionHeader()` 再記賬，預開啟置頂會話前再用 `pinnedPathsOwnedBy()` 按歸屬過濾一次。在專案 A 的檢視下釘住屬於 B 的會話，記錄落在 B 名下；歷史上釘錯專案的髒資料（`client-state.json` 裡同一路徑掛在兩個 cwd 鍵下）也會被這層過濾攔住，不會把 B 的會話預開啟進 A。驗證：`tests/unit/pin-session-cwd.test.ts`。

釘住 / 取消釘住後要按**會話自己的 cwd 推一次 `sessions` 摘要**：歷史行上的 📌 來自摘要裡的 `pinned`（`isSessionPinned()` 現算），`emitConversations()` 只重新整理執行中與活動行、不動摘要——不推的話取消釘住後圖標得等點一下專案重新拉列表才消失。`setConversationPinned()` 推 `conv.cwd`；`pinSession()` 在記賬用的 `pinCwd` 與當前 `cwd` 不同時改推 `pushSessionsForCwd(pinCwd)`。驗證：`tests/unit/pin-badge-refresh.test.ts`。專案的展開/收起狀態持久化在 `pi-web-ui:lp-expanded-projects`：重新整理時**完全按記錄恢復**，只有「首次使用、沒有任何記錄」才展開當前專案，`currentCwd` 變化的 effect 在首幀不動作（否則收起來的專案一重新整理又自動彈開），之後切換專案才自動展開。釘住的歷史行在專案收起時仍然顯示（`isPinnedRowVisible()`；重新整理後一直是收起狀態、從沒展開過的專案也要掛載子節點，並且不受 `maxVisible` 截斷），否則一收起專案它就從左欄消失，釘住等於沒釘。歷史行的右鍵選單按**該行自己的 `pinned`** 判斷顯示「釘住」還是「取消釘住」：跨專案的歷史行不在當前專案的 `sessions` 列表裡，只查列表會永遠顯示「釘住」（點下去還會再釘一次）。驗證：`tests/unit/pin-badge-refresh.test.ts` 與 `tests/unit/left-panel-actions.test.ts`（跨專案歷史行用例）。

側欄子代理樹從一級開始每層縮排 12px，有無子代理的行使用相同標題基線，層級僅通過縮排表達，不繪製連線線。摺疊按鈕使用細描邊箭頭並隨深度同步右移；圖示為 12×12px，獨立點選區域為 18×24px，與標題保持 2px 間隔，提供懸停及鍵盤焦點反饋。執行中和其他客戶端的對話樹共用同一佈局，按鈕通過 `aria-expanded` 表達展開狀態。層內樣式與 `styles.css` 末尾結構復位規則保持一致，避免主題或選中態覆蓋縮排。

跨專案歷史讀取統一走 `pushSessionsForCwd`。UniversalSession（Claude/Codex）按請求專案讀取存檔並應用該專案的標題與分頁限制，返回 `sessions.cwd` 和每行 `cwd`；讀取不會切換當前工作區或覆蓋活動對話列表。`use-session-list-requests.ts` 按專案跟蹤回執，20 秒未返回時顯示可重試狀態；其他專案的回執不能結束本專案的載入。斷線和引擎切換清理舊請求，重連後重新讀取已展開專案，遲到的有效回執可恢復列表。驗證見 `universal-session-list.test.ts`、`left-panel-session-loading.test.ts`。

## 工作樹入口

Git 工作樹通過頂欄 `host:worktrees` 專案入口顯示數量與未提交改動狀態點，不再自動彈出或常駐警告橫幅。入口參與統一佈局及溢位選單，點選切到 `worktrees` 頁內檢視；列表展示主倉庫、當前工作樹、完整分支名與路徑，長文本換行。切換操作等待服務端 cwd/currentPath 確認後返回聊天，失敗不提前退出；移除收在每項管理詳情，確認後沿用非強制刪除。

`useWorktreeRefresh` 獨立於詳情頁掛載，通過 `refresh_worktrees` 請求重新檢測服務端事實：頁面可見時每 30 秒一次，視窗重新聚焦或頁面恢復可見時立即重新整理；隱藏頁面暫停檢測。響應繫結發起時的專案 cwd，切專案後不得釋出舊專案結果。不再使用舊橫幅的 localStorage 忽略狀態。

## 對話協作工具相容

對話協作只有一個工具名 `conversation`，支援子代理及持久對話；轉錄、檔案與狀態按需讀取統一使用 `conversation(action="read"/"files"/"status")`，原 `conversation_read` 不再獨立註冊。歷史別名 `subagent` 已刪除：`makeSubagentTools()` 只產出 `conversation` 一個定義，前端也只渲染一個開關。

工具註冊仍以 `server/tool-manager.ts` 的 `AGENT_TOOL_CATALOG` 為事實源。舊存檔裡的 `subagent` 與 `subagent_*`（`LEGACY_SUBAGENT_TOOL_NAMES`）在 `normalizeDisabledAgentTools()` 裡折算成 `conversation`，因此老預設的停用狀態依舊生效，但不會復活成獨立開關；`toolPromptOverrides` 裡的舊 `subagent` 覆蓋同樣在歸一化時併入 `conversation`。

## 非同步歸屬與持久化邊界

- 編輯重問在入口捕獲 Conversation/runtime，歷史截斷、快取清理及實際 SDK prompt 全程使用該目標；非同步恢復後驗證物件仍被持有，禁止重新取活動會話。工具按穩定 SDK session 解析當前持有方，過戶後審批與許可權均使用新持有方。
- 工具守衛及審批等待繫結 AbortSignal，每個非同步守衛/審批恢復點和執行前檢查取消；取消會移除 pending 審批，不能僅掃描取消當時的待辦。
- 持久化子代理和新建會話在非同步初始化前預留專案名額；歷史開啟與派生分支提交時計入在途預留。子代理初始化失敗清理已註冊會話、runtime、終端和臨時目錄，並回收本次空工作樹。
- ClientStateStore 共享設定按實際欄位 patch 合併，儲存成功才釋出版本事件；SettingsService 訂閱並序列應用執行態變更，讀取凍結快照，銷燬時退訂。ComposerDraftsStore 按檔案共享狀態，避免各客戶端整表覆蓋。兩者均是程序內協調，不支援多個獨立服務程序同時寫同一 data-dir。
- 設定狀態推送、資源發現與執行時過載分離：`SettingsService.push()` 只讀取已儲存配置和當前會話記憶體目錄，新建/切換對話不掃描磁碟、不清理配置、不觸發 reload；開啟設定的 `get_settings` 經 `refreshSettings()` → `refreshResources()` 顯式掃描技能並清理失效偏好，只更新目錄，不自動應用到執行時。設定修改和 `reload_extensions` 才走 `applyRuntime()`，流式期間延後；過載完成後重新整理資源目錄。外部安裝/刪除技能在重新開啟設定後反映，執行態通過顯式過載更新；目錄快取按專案 cwd 隔離。
- 原子寫只允許同目錄臨時檔案替換；重新命名失敗有限重試後報錯，禁止回退截斷原檔案。設定/草稿儲存失敗必須反饋，記憶體與磁碟不得假裝同時成功。
- 歷史視窗攜帶 historyGeneration；歷史重寫或快取重建使舊分頁請求失效，錨點不存在/錯位返回 resyncRequired，客戶端請求全量同步。重複全量快照保留字元預算確定的視窗，只有翻頁向前擴充套件。舊 socket 回撥必須先驗證身份，才可清理共享終端橋。

## 命令、搜尋與恢復狀態

- WS 握手限時 15 秒，握手訊息最多 16KiB；普通控制訊息最多 1MiB，附件訊息沿用上傳預算。attach 佇列最多 256 條且累計不超過 8MiB，超限關閉連線，不靜默丟棄已排隊操作。限額單源為 `server/payload-limits.ts`。
- 設定儲存先校驗並寫盤，成功後才更新執行口令。定時任務配置先持久化再發布記憶體及通知；執行記錄寫失敗反饋錯誤，但推進記憶體觸發時間以避免重複執行。外部副作用不保證跨程序恰好一次。
- 歷史搜尋與列表展示上限分離，搜尋全部候選；轉錄按流讀取，限制併發，匹配和錨點單次掃描完成，不以 256K 正文快取決定命中。新查詢取消舊查詢，切專案後不釋出舊結果。極大的單條普通文本記錄仍需單記錄記憶體。
- 壓縮恢復狀態由宿主寫入 `<sessionFile>.compaction-state.json`，完成事件僅經 SDK `appendCustomEntry` 寫入轉錄，禁止直接改寫執行中的 SDK 會話檔案。所有恢復入口消費中斷狀態，無接收端時通知進入待發佇列；舊轉錄損壞修復仍保留。
- `terminal_output.reset` 表示歷史替換；即時輸出繼續追加。回放前先 flush 合併中的即時輸出；顯示終端支援重置，SCM 解析器跳過歷史替換幀。
- 外掛 HTTP 代理把下游提前關閉傳遞到上游；上游截斷終止下游，完整響應正常完成。

## 訊息操作

訊息操作欄的提示應懸浮即顯，使用簡短動作名。複製主鍵複製 Markdown，下拉選擇其他格式。重新提問通過 `edit_message` 在當前會話移除原問題及後續內容，原樣重發問題和附件；編輯後重問先開啟編輯框，提交時執行同一路徑。分叉通過 `fork_session { position: "at" }` 保留所選訊息及之前的上下文，建立新對話且不自動傳送。回退按鈕開啟當前問題（助手訊息則定位到對應使用者問題）的編輯框，提交後在當前會話重問；取消編輯不改變歷史。訊息回退編輯與可選工作區檔案還原是獨立操作。

pi 的 `schedule` 建立任務時單獨持久化建立來源（穩定 SDK 會話檔案 + tool call ID），不隨投遞目標重綁變化。`edit_message` 只撤銷當前分支被捨棄字尾中建立、尚未啟動的任務（包括週期和畫布任務）；先原子寫入排程儲存，再同步提交重問分支標記。排程寫失敗保留原歷史並停止重問；分支提交失敗恢復原 leaf 和任務，恢復也失敗則明確報錯。開始執行前持久化 `startedAt`，只用於阻止重問撤銷已嘗試的外部操作，不提供跨程序恰好一次語義。普通分叉、旁支、其他會話、已啟動任務和無來源舊任務均保留；未接入內建 schedule 的引擎及直接 checkpoint rollback 不在此清理路徑。

## 快照驅動

- **服務端是唯一事實源**：每次 SDK 事件後節流 60ms 推快照（`UiState`），瀏覽器只按快照渲染。重連只需重發 `get_state`。
- **增量快照（協議 v2）**：持久化訊息內容不可變 + 物件引用穩定，`emitSnapshotNow` 用 O(n) 指標等同性遍歷檢測追加式增長——能追加則發 `snapshot_delta`（輕欄位 + `appended` 尾部，baseRev 鏈），中途變更/截斷/切會話/強制 resync 回落全量 `snapshot`。前端 reducer 按 rev 鏈合併，缺口觸發防抖 `get_state`；背壓下 delta 與 snapshot 同樣可丟棄，丟包靠 rev 鏈斷裂自愈。`get_state` 恆返全量。迴歸：`snapshot-delta-test`。**測試適配**：等「動作後快照」的測試必須同時接受 snapshot_delta（參照 conv-cwd/vision-bridge 的 rev 鏈合併寫法）；連線後的首個快照恆為全量。
- **WS permessage-deflate**：WebSocketServer 開啟壓縮（threshold 16KB），大會話多 MB snapshot 線上傳輸降數倍；小訊息（notice/心跳）不壓省 CPU。
- **多標籤頁序列化共享**：emit 把同一訊息物件發給客戶端的所有 socket，index.ts 用 WeakMap 按物件身份快取 stringify 結果——N 個標籤頁共享一次序列化，新 snapshot 即新物件自動失效。
- 序列化時**物件引用穩定**：`uiMessageCache` + 訊息陣列簽名比對，訊息沒變就不重建陣列，前端 `React.memo` 因此能跳過整條訊息——**不要**破壞這個快取（stable id、引用複用）。
- `UiState` 攜帶 `thinkingLevel`（當前生效）和 `availableThinkingLevels`（當前模型實際支援的級別，SDK 會把集合外的請求靜默就近鉗制——UI 只能啟用這些，否則使用者點"低/中"看起來"改不了"）。

### `message_delta` 即時增量通道

`message_update` 事件 → 只對**活動對話**推 `message_delta`（`conversationId` + 每對話單調 `seq` + `messageId = stream-<ts>`（與 `serializeStreamingMessage` 的穩定 id 一致）+ 即時 usage + 剝離 `partial` 後的 thinking/text delta）。它**不經 snapshot 通道**——`send()` 背壓只丟 snapshot，增量永遠可達，大會話不再因背壓停更。前端 `applyMessageDelta`（`web/src/message-delta.ts` 純函式、不可變——StrictMode 雙調 reducer 會把原地 mutation 加倍）patch `streamingMessage` + `stats.tokens`；seq 缺口觸發防抖 `get_state` 重同步；snapshot 權威收斂。

同時：delta 活躍期（1.5s 內有增量）snapshot 降為**事件驅動檢查點**——agent_end / tool_execution_end 立即 flush，其餘事件走 2s 兜底定時器（增量負責流暢度、快照只做邊界校準）。單測：`tests/unit/message-delta.test.ts`。

### `tool_delta` 同協議

也帶 `conversationId` + `seq`，與 message_delta 共享同一每對話單調序列（`conv.deltaSeq`）；前端按對話 Map 追蹤 seq，僅活動對話缺口觸發重同步（後臺對話切回時 snapshot 收斂）。

### 檔案認領的執行生命週期

`server/claim-store.ts` 的認領只覆蓋一次實際執行：正常完成、最終報錯、使用者停止或強制重置時，`ClientSession` 按對話 ID 立即釋放全部認領，無需關閉或移除對話。SDK 的 `agent_end` 可能早於重試、壓縮或擴充套件續跑結束，尚未 idle 時保留認領，到 `agent_settled` 才釋放；已經 idle 的引擎可在 `agent_end` 釋放。提示詞投遞異常的 `finally` 和強制重置路徑也負責清理。關閉對話時的清理和預設 30 分鐘 TTL 作為兜底，新一輪執行需要重新認領。

### 協議版本協商

`hello` 可帶 `protocolVersion`，`ready` 迴帶服務端版本；前端比對不一致時顯示持久重新整理橫幅（應用原地更新後「介面新的/WS 舊的」混跑防護）。常量在 server/ 與 web/ 各一份 protocol-version.ts，`check:protocol` 校驗兩份一致——改協議時必須同步 bump。

### 歷史訊息按需載入（服務端視窗化，`server/message-window.ts`）

前端「向上分頁」只做到**不渲染**，資料仍是全量到手：實測一份 287 條 / 17MB 的轉錄序列化後快照 4MB，開啟對話要等整份傳完 + parse。所以再把視窗挪到服務端：

- **掛載點**：每連線唯一的傳送漏斗（`server/index.ts` 的 `send` 外包一層 `MessageWindowTap`）。五個引擎（pi / DSH / claude / codex / durable）都經這條漏斗，引擎側**零改動**、口徑統一；將來新引擎自動繼承。
- **裁剪**：`snapshot` 的 `state.messages` 裁成尾部視窗並回填 `historyStart`（視窗首條在全量裡的下標）/ `historyTotal`；條數上限 `PI_WEB_HISTORY_WINDOW`（預設 300）+ **字元預算** 150 萬字符（截圖/tool 輸出會把視窗壓更短，實測同一份會話 4.00MB → 1.28MB）。`snapshot_delta` 只把新追加的併入快取並回填兩個計數。
- **翻頁**：`load_earlier_messages {count|all}` → 服務端回 `earlier_messages`（新增的更早一段，客戶端**前插**）。視窗起點**單調不增**：客戶端翻過的頁不會被後續全量快照（重連 / `get_state`）推回去。
- **不碰 `rev`/`baseRev`**：各引擎增量語義不同，改寫版本號會破壞它們的自愈鏈；翻頁只是補齊更早內容，與 rev 無關。
- **前端配合**（`web/src/components/MessageList.tsx`）：`hasEarlier` = 本地未展示 + `historyStart`；滾輪接近頂部/點「載入更早」時本地夠用就本地撐開，否則向服務端要一頁；開啟頁內搜尋或「全部展開」時 `all: true` 一次拉全，保證搜得到全文。
- **相容**：兩個欄位都是可選的（預設 = 全量）。舊前端連新服務端只是少了一段歷史又無從翻頁，故 `PROTOCOL_VERSION` bump 到 34 觸發重新整理橫幅。
- **迴歸**：`tests/unit/message-window.test.ts`（視窗起點/預算/翻頁純邏輯）+ `tests/message-window-test.mjs`（WS 報文級：首幀視窗、無縫翻頁、`get_state` 不回退、`all` 到底回空頁）。

## 協議單源（types.ts 是 re-export shim，不再手工同步）

`server/protocol.ts` 是唯一事實源；`web/src/types.ts` 用 `export type * from "../../server/protocol"` 全量再匯出（純型別，構建時擦除），前端本地型別（FileContent/FileListing/ToolStatus）附在 shim 下方。

新增/修改任何訊息：只改 `protocol.ts`，然後在 `server/index.ts` 的 `dispatch` switch 和 `web/src/use-chat.ts` 的 `onmessage` switch 各加一個分支。注意 protocol.ts 必須保持**純型別匯出**（不能加 const/function 等執行時程式碼，否則破壞 type-only 前提）；`npm run check:protocol` 守護這兩個不變數。

## 對話通訊與任務完成

協作訊息只在決策、阻塞、介面變化或交付時傳送，普通進度合併到階段彙報；正文優先說明變化、接收方行動及詳情位置。同一傳送者向同一收件人傳送的完全相同正文，在收件箱未消費期間複用訊息 ID，避免重複投遞與喚醒；消費後允許再次傳送。注入模型時使用簡潔文本保留來源地址、完整正文及協作資料的許可權邊界，省略內部路由 JSON 和冗餘 ID；結構化請求保留 requestId、完整問題及回覆方式，收件箱協議保持不變。

`communicate` 統一同專案執行對話的 `send/request/reply/escalate/read`；目標支援 `parent`、`root` 和穩定對話 ID。獨立 coordinator 以 Conversation 物件身份儲存收件箱與問答關係，過戶不重建身份。`read` 同時返回可達對話目錄與穩定執行身份地址，跨頁面同名對話優先使用該地址；來源 endpoint 必須貫穿投遞，不得按接收方區域性 ID 重新推斷髮送者。通訊專案沿服務端登記的父子對話鏈解析：獨立 cwd/克隆中的子代理繼承仍可解析的祖先專案，受管 worktree 對映到主倉庫；無關獨立克隆不因倉庫相同而互通，祖先不可達時回落到最後可解析對話的目錄。專案標識統一經 `normalizePathKey` 規範化。訊息是帶來源的協作資料，不授予執行許可權；宿主仍按執行對話校驗沙盒和 Bot 邊界，父子關係不豁免這些限制。只讀子代理可通訊，計劃/委派審查/目標審查模式拒絕通過此工具派發工作。

`send` 返回投遞或排隊狀態，不等待接收方處理任務；`read` 分頁讀取並消費自己的收件箱，熔斷期間訊息仍保留。`request` 等待回答，服務端限制訊息位元組、佇列與請求數量並拒絕請求迴圈；引數只收純文本 `message`（`questionsFromMessage()` 折成單個內部問題），結構化 `questions` 仍照收。`reply` 僅允許原接收對話，`message` 按待答問題展開成 `custom` 回答，舊 `answers` 結構仍照收；`escalate` 將同一 PendingQuestion 交給使用者，沿用原始截止時間。`wait_all` 為待當前對話處理的請求提前返回。舊 `handoff/consult/answer/escalate` 作為相容入口轉接通訊服務；歷史掛起問卷保持可結算。

任務完成通過 `conversation(action="complete", summary, evidence)` 登記，與傳送訊息分開；證據與轉錄對賬的規則見下一節。`spawn.notifyOnDone` 保留布林相容並支援 `"manual"`。manual 本輪退出但還有執行中下級、問卷、通訊或待投遞子結果時保持 taskPending，禁止提前通知、消費結果或結算工作樹；完成登記不能繞過這些條件。所有依賴收口後使用顯式 summary，未登記則以最終正文兜底。錯誤與取消繼續通知，自動喚醒不清除手動完成意圖。當前 manual 和通訊宿主為 pi 引擎，Universal 明確拒絕不支援的 manual 模式。

## 子代理完成證據、結算邊沿與派發預算

子代理自述「做完了」不算證據。`conversation(action="complete")` 除 `summary` 外要求同時給 `evidence`：`{files:[], commands:[]}`（改過的檔案、跑過的驗證命令）、`{none:true}`（只讀任務，宣告沒有檔案改動）或 `{blocked:"原因"}`（做不完，如實報）。歸一隻在 `server/subagent-evidence.ts`：路徑按 `/` 歸一、命令壓空白、去重並限量（50 檔案 / 20 命令 / 單條 400 字元），空物件判非法。

對賬不接受自述：`collectTranscriptFacts()` 從子代理自己的轉錄裡抽**真改過的檔案**（寫入類工具呼叫的 path/file_path/paths/files，名單複用 `subagent-security-gate.ts` 的 `SUBAGENT_WRITE_TOOL_NAMES`）與**真跑過的命令**（bash/powershell 呼叫的 command、`bashExecution` 的 command+exitCode、`toolResult.isError` 回落標失敗）。只有可證偽的衝突才駁回：聲稱跑過的命令在轉錄裡找不到 / 那條命令在轉錄裡失敗 / 聲稱 `none` 但轉錄有寫入；改過但未宣告的檔案、聲稱改過卻找不到寫入呼叫的檔案只記疑點並降級 `partial`（bash 裡 `sed`/`mv` 也會改檔案，不能一票否決）。駁回時 `complete` 拋錯並把矛盾列給子代理，讓它先修正再登記；通過後證據存到 `conv.subagentEvidence`，裁決 `pass / partial / unverified / blocked` 隨 `wait_all`、`get_result`、`list`、完成通知（`subagent-notify.ts`）一併呈現；同一裁決經 `ConversationSummary.subagentVerdict` 進左欄，`unverified / partial / blocked` 顯示證據角標（`pass` 不佔位），別讓「沒驗證」看起來像「已驗證」。缺證據不阻塞收口，但狀態必須顯示 `unverified`，父代理據此決定是否複核——寧可顯式未驗證，不要假成功。

`wait_all` 不再輪詢。`server/subagent-settle.ts` 的 `SubagentSettleRegistry` 只提供**邊沿**：執行 id 變化即喚醒訂閱者，等待方醒來重算是否真的收口（並重掃新派生的後代與待交付請示）。`agent-service` 在回合結束、停止、移出、問卷佇列變化、完成通知投遞狀態變化處 `notify/notifyAll`，`dispose` 時 `shutdown`。單次等待切片 30s，等待上限仍由看門狗 cap 決定；通用引擎（`universal-session.ts`）用自身的子代理監聽實現同一介面，語義一致。判定「已收口」只有一條：拿不到快照（已移出/已結束回收）或顯式終態，等待與「還剩誰」共用 `isSettled`，避免出現「全都完成了卻報還有人在跑」。

一次呼叫可以扇出：`spawn` 的 `tasks[]` 一次派多個，先整批校驗（prompt、key 形狀與唯一性、模板可用、思考檔位、隔離模式）再啟動，一個不合法就一個都不啟動；單批上限 `SUBAGENT_FANOUT_MAX = 16`，啟動併發視窗 4（不與併發上限搶名額）。每個 task 可帶 `key`（字母數字與 `_.-`，≤40），工具把 `key → 執行身份` 記在**本對話工具例項**的有界表（256 項）裡，`wait_all / get_result / steer / stop` 的 `runIds` 接受 key 或真實 id。`steer` 回執區分 `delivered`（送進當前回合）/ `queued`（排隊等回合結束）/ `restarted`（本來空閒，同會話開新一輪）/ `missed`（沒有可投遞通道），父代理不必猜。

併發與深度擋不住累計成本，所以加了第三道閘：`server/subagent-budget.ts` 按**執行樹根**（沿 parent 走到最頂層會話的穩定執行身份）累計派發次數，預設 64（`PI_WEB_SUBAGENT_MAX_SPAWNS_PER_RUN`，`0` 關閉）。預留在啟動路徑同步完成，失敗退還，執行樹根移出時 `forget`。子代理用量（`getSessionStats().tokens`）進快照的 `usage`，在列表與等待結果裡以 `輸入↓輸出↑` 呈現，配合上下文軟上限一起看成本。

## 執行賬本與重啟續跑

子代理的工作不能因為重啟就消失。`server/subagent-ledger.ts` 把每次派發落到 `<dataDir>/subagent-runs/<runId>/`：

```
status.json     機器可讀的當前狀態（原子替換，最後寫者勝）
events.jsonl    追加式生命週期流水（有位元組上限，截斷後只留一條標記）
```

寫入紀律：所有寫操作進每個 run 的**序列佇列**，呼叫方一律 fire-and-forget；`status.json` 走 `writeAtomic`，事件用 `appendFile`；任何 IO 失敗只記 `lastError()`，絕不讓賬本問題打斷派發或回合結束（`dispose` 時 `flush()`）。有界：run 目錄數預設 200（`PI_WEB_SUBAGENT_LEDGER_MAX_RUNS`，`0` 關閉整本賬）、單 run 事件 256KB、`prompt` 8KB、`outputTail` 4KB、證據條目各 5 條。淘汰只挑已結束的 run，且要等該 run 的寫佇列排空再刪目錄——否則排隊中的 `mkdir` 會把目錄又建回來。

重啟對賬只認 `bootId`：每條記錄帶本程序隨機身份，`recover()` 只把**別的 boot** 留下的 `running` 判成 `interrupted`，本程序的活執行一律不動；重複呼叫冪等。`ClientSession.create()` 裡 fire-and-forget 呼叫一次，命中時推一條 notice（列出前 5 個標題與 id），告訴使用者/模型可以 `get_result` 取已產出的證據或 `resume` 續跑。**主對話的重啟恢復與子代理分開**：`streamingSummaries()`（daemon 記錄「重啟時正在流式」的入口）跳過子代理與持久化子會話，避免把 child 當成普通標籤頁重新開啟、丟掉父子關係。

賬本由執行態在各收口點同步：派發登記 `running`；回合結束、完成登記（含證據）、停止、移出、`steer` 重開一輪、工作樹收尾分別 `upsert` + `event`（`spawned / turn_end / completion_requested / stopped / dismissed / steer_restart / worktree_finalized`）。讀側：`conversation(action="list")` 在活執行之後追加賬本行（跳過已移出與仍在記憶體裡的），`get_result` 在記憶體查不到時回落到賬本，給出狀態、證據、錯誤、工作樹、`sessionFile` 與輸出尾部。

`conversation(action="resume", runId, message?)` 的語義必須誠實：程序內子代理會話不落盤，**接不上原轉錄**，所以續跑是「帶已知進度重派」（`mode: "relaunch"`）——提示詞由 `buildResumePrompt()` 拼：原任務 + 中斷前輸出尾部 + 賬本證據 + 保留的工作樹 + 舊轉錄路徑，並要求「別重做已完成的部分、守住已有結論、按證據收口」。工作樹仍保留時直接以它為 `cwd` 重派（複用未提交改動，不新建工作樹）；`persist=true` 的子代理轉錄仍在歷史裡可回看。`resumedBy` 標記新 run，重複續跑直接拒絕；還在程序裡跑著的 run 也拒絕（先 `wait_all`/`get_result`）。

驗證：`tests/unit/subagent-ledger.test.ts`（寫入/重啟讀回/bootId 對賬/事件截斷/淘汰/關閉/續跑關係/提示詞）、`tests/unit/subagent-ledger-tool.test.ts`（list 追加/get_result 回落/resume 成功與四類失敗/無賬本引擎降級）。

## 問卷佇列與父代理請示

共用 `QuestionDialog` 保留單選選中新選項後立即進入下一題；再次點選已選項則取消並留在當前題，滑鼠與數字鍵一致。末題預設等待提交按鈕或 Enter；問卷底部可開啟「最後一題點選後自動提交」，偏好儲存在當前瀏覽器，單題問卷同樣適用。切換偏好和恢復草稿不觸發提交；取消選擇後允許只交補充說明，隱藏條件題不提交答案。

標準 pi 引擎通過 `question_queue` 推送當前專案完整待答佇列；每個請求保持穩定 ID、來源對話、頂層對話、持有方、建立時間及可選截止時間。頂層入口、來源對話與跨頁面回答引用同一請求，回答按當前持有方結算，過戶保留請求身份與期限。快照的 `pendingQuestion` 和即時 `question_pending` 保留其他引擎相容；前端佇列入口合併後只展示一個問卷。側欄問號、問卷通知、跨頁面摘要與“等待使用者”狀態共用服務端有效使用者問卷查詢，只包含 `audience="user"` 且尚未結算的請求；代理間 `request/consult` 在升級給使用者前不得觸發這些提示，已回答、取消或超時的請求立即退出。

`questionPresentation` 控制當前對話彈出並排隊其他問卷（預設 `queue`）、全部自動彈出（`all`）或僅手動佇列（`manual`）。工具審批獨立使用 `toolApprovalPresentation`，同樣支援這三種方式，預設 `all` 保持所有對話的審批依次自動彈出；該設定只控制提醒，不改變審批開關、規則與批准/拒絕結果。稍後回答保留問卷與草稿，取消為顯式操作；來源跳轉開啟對應對話。當前專案以外的問卷不得進入佇列。

子代理用 `conversation(action="consult")` 請示直接父對話；父對話通過 `answer` 作答或 `escalate` 交給使用者。`ask_user_question` 始終等待使用者，父代理不得代答。`wait_all` 遇到尚未交付給當前父對話的請示提前返回 `needs_input`，同一請求不反覆喚醒。父代理不可處理時升級使用者，已有自動喚醒預算繼續生效。

`questionTimeoutSeconds` 對新建子代理問卷及請示預設 240 秒，0 為不限時；主對話保持原等待策略。服務端負責期限和取消，超時返回明確結果，不自動採用推薦選項。升級不重置期限，瀏覽器倒計時不觸發取消。問卷結束不等於執行會話結束，也不會提前釋放併發名額。

## 全域性執行態（app-globals.ts：不逐層傳 props）

`web/src/app-globals.ts` 是模組級單例 store，放「**整棵樹都要知道**」的少量執行態：服務端身份/能力（整個連線內只變一次）+ 連線態與當前工作目錄（低頻變化，靠單欄位訂閱隔離）：

| 欄位                            | 來源                                              | 誰在用                                                                                                             |
| ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `engine`（`"pi"` / `"dsh"`）    | `ready.engine`（老服務端不傳 → 回落 `"pi"`）      | FooterBar 引擎圖示、GoalBar/SettingsModal/ChatInput 的 DSH gating（無審查模型 / 無外掛市場 / 無 mid-run steering） |
| `managed`（`PI_WEB_MANAGED=1`） | `ready.managed`                                   | TopBar 更新入口、PiSetupModal 安裝引導、SettingsModal 外掛市場                                                     |
| `tabs`（`PI_WEB_TABS`）         | `ready.tabs`                                      | 頂欄檢視 tab 白名單（undefined = 全部）                                                                            |
| `service`（被哪個平臺服務託管） | `ready.service`（`server/launch-origin.ts` 探測） | TopBar 更新面板的「重啟服務」按鈕（預設 = 前臺/dev/Docker → 不畫按鈕，服務端也拒絕 `restart_service`）             |
| `appVersion` / `serverVersion`  | `ready`                                           | TopBar 版本號                                                                                                      |
| `status` / `ready`              | useChat 的 reducer（`status` 動作 / hello+快照）  | 左欄（能不能拉清單）、ChatInput（輸入框能不能用）、TopBar / FooterBar 的連線點                                     |
| `cwd`（當前對話的工作目錄）     | `chat.state?.cwd`                                 | 左欄分組與「當前」標記、右欄路徑拼接、全域性搜尋的當前專案標記、底欄目錄選擇器                                     |

寫入點兩處，都是單一來源、只映象不復制：`use-chat.ts` 收到 `ready` 時寫身份/能力（**在 dispatch 之前**同步落地，不閃一幀 `pi`）；另一個 effect 把 `ready` / `status` / `cwd` 映象過來（值就是 reducer 裡的真值，最多晚一幀 —— 對應預設值只會是「未就緒 / 未連線 / 空目錄」，看不出來）。非 React 程式碼用 `getAppGlobals()` / `subscribeAppGlobals()`。

**讀取規矩**：窄 props 的元件（`LeftPanel` / `RightPanel` / `ChatInput` / `GlobalSearchModal`）一律從全域性讀，不再要 prop；本來就吃整個 `ChatState` 的元件（`App` / `TopBar` / `FooterBar`）直接讀 `chat.*`（自己就持有資料，沒必要繞一圈）。兩邊的值來自同一個 reducer，不會不一致。

**訂閱粒度**：只用一個欄位時用 `useAppField("cwd")`（getSnapshot 只取一個欄位，比較走 `Object.is`）—— `useAppGlobals()` 在任何欄位變化時都會重渲染訂閱者，只有確實要整物件時才用它。`cwd` 就是靠這條隔離的：切專案的通知只到真正讀 cwd 的元件，不會把只讀 `engine` 的元件也帶上。

### 全域性動作：`appSend`

傳送器也放這裡（下半部分）：`use-chat` 裝配 `setAppSend(send)`，其他任何地方 `import { appSend }` 直接用 —— 它引用穩定、不進 state、不觸發重渲染，所以不需要 hook。`web/src/App.tsx` 裡因此不再有 `send={send}` 的逐層傳參：對話方塊、彈窗、面板、外掛檢視、終端、SCM 全部自己取。

兩點例外（故意的）：

- `LeftPanel` / `RightPanel` 的 prop 叫 **`panelSend`** —— 它們拿的是 App 的包裝函式（順手關手機抽屜的副作用），語義不同，不能換成全域性傳送器。
- **裝配必須在 render 期間**（`setAppSend(send)` 直接寫在 `useCallback` 後面，不是 `useEffect`）：子元件的 effect 先於父元件跑，放 effect 裡裝配會讓「掛載即發請求」的彈窗（PiSetupModal / ModelConfigModal / TerminalPanel）在 `appSend` 還是空的時候呼叫而靜默丟包。`send` 是 `useCallback([])` 的穩定引用，重複賦值無副作用。未裝配/未連線時 `appSend` 返回 `false`（與 `send` 的既有語義一致）。

**兩條紀律（否則會引入難查的渲染 bug）**：

1. **只放極少變化的欄位**。`messages` / `state` / `settings` / `streaming` 這類快照流裡的資料**絕不**放進來：`ChatInput` / `GoalBar` 等 `memo()` 元件靠「窄 props + 引用穩定」躲開流式重渲染，而 store 通知**繞過 `memo()`** 直接重渲染訂閱者 —— 放錯一個欄位就是每個 token 重渲染一次輸入框。
2. **快照引用必須穩定**：`getSnapshot()` 返回模組級 `cached`，只有 `setAppGlobals` 真正改了欄位才替換物件並通知（陣列按元素比、欄位值相等則靜默 return）—— 否則 `useSyncExternalStore` 會判定「快照每次都變」而無限重渲染。重連重放 `ready` 時靠這條不白刷一遍。

迴歸：`tests/unit/app-globals.test.ts`（合併語義/同值不通知/退訂/回落）與 `tests/unit/question-dialog.test.ts`（元件測試改用 `setAppSend` 注入 + 記錄發出的訊息）。

## 引擎與原生 CLI 的共用檢測

`server/engine-catalog.ts` 是引擎 ID、包名、安裝命令和獨立 CLI 能力的單源，供引擎管理、協議型別和 CLI 工作臺使用。`server/engine-cli.ts` 統一解析 PATH、常見安裝目錄和全域性包的 `package.json.bin`，並生成不經過 shell 的 `{file, args}`；版本探針、Claude/Codex 驅動與原生 PTY 都使用這份結果，不再各自維護路徑查詢邏輯。全域性包位置繼續複用 `global-loader.ts`，只安裝庫或殘缺 bin 不代表存在可啟動的 CLI。

引擎的 SDK/執行時可用性與獨立 CLI 能力分別判斷：Pi/DSH/Durable 可通過 SDK 或執行樹工作；Pi Durable 沒有獨立 CLI；DSH 的 `dsh` 需要 profile，不能假設其包含預設終端介面。CLI 工作臺的能力與啟動約束見 [終端架構](architecture-terminal.md#原生-cli-工作臺)。單項和批次引擎探測使用同一登記表與 TTL 快取。

## Codex CLI 引擎

`codex` 通過 `server/universal/drivers/codex.ts` 接入通用底座，使用本機安裝的 `@openai/codex` CLI。安裝後先在終端執行 `codex login`；認證與服務商配置沿用 `~/.codex/`（或 `CODEX_HOME`），設定頁的 Pi/Claude 服務商金鑰不會注入 Codex。模型與推理強度按會話選擇，預設模型跟隨 CLI 配置。

驅動將 `codex exec --json` 的執行緒、正文、思考、工具和用量事件轉換為通用事件，執行緒 ID 隨會話持久化以便續接。執行使用工作區寫入沙盒，不繞過 Codex 的安全限制。Codex 不提供宿主工具審批、歷史編輯或分叉；通用底座按能力宣告隱藏這些入口。停止請求必須終止對應子程序並完成有界清理。

## Claude Code / Codex 原版接入約定

**事實源**：`server/universal/drivers/claude-code.ts`、`drivers/codex.ts`、`server/universal/engine-mcp.ts`、`universal-attachments.ts`（`materializeUploads` / `describeCliAttachment`）。迴歸：`tests/unit/claude-driver-launch.test.ts`、`codex-driver.test.ts`、`universal-commands.test.ts`（第 4 組）、`universal-attachments.test.ts`。

- **執行即原版 CLI**：兩個引擎都只啟動本機 `claude` / `codex`，工具、登入、會話儲存、CLAUDE.md/AGENTS.md、CLI 自己的 MCP 與技能全部由 CLI 負責；底座不模擬 CLI 能力。
- **圖片**：Claude 走 `-p --input-format stream-json`，圖片作為原生 `image` 塊（>5MB 或非 png/jpeg/webp/gif 時落盤為檔案交給 CLI 讀取）；Codex 走 `--image`。
- **上傳檔案**：瀏覽器上傳的 `fileData` 由底座先存入 `<dataDir>/uploads/<clientId>/`（與 Pi 共用清理策略），再以絕對路徑告訴 CLI；禁止只傳檔名。
- **MCP**：pi 配置的已啟用伺服器（`<agentDir>/mcp.json` + `<cwd>/.pi/mcp.json`，專案覆蓋全域性）**疊加**在 CLI 自身配置之上：Claude 用 0600 臨時檔案 `--mcp-config`（輪次結束刪除，不用 `--strict-mcp-config`），Codex 用 `-c mcp_servers.*`，HTTP 頭值經 `env_http_headers` 走環境變數以免出現在命令列；因驅動以 `--ask-for-approval never` 執行，橋接的伺服器一律帶 `default_tools_approval_mode="approve"`（否則 Codex 拒絕呼叫："requires approval, but approval policy is never"），與 Claude 的 `--dangerously-skip-permissions` 同級。pi 側 OAuth 令牌不隨之傳遞。
- **模型**：Claude 列表為 CLI 別名（`default` 不傳 `--model`，跟隨 CLI 配置；`opus`/`sonnet`/`haiku`）加 models.json 中相容的自定義服務商；已下線的 `claude-3-*` 存檔自動遷移為 `default`。會話構造時必須把當前模型同步給驅動。
- **斜槓命令**：Claude 的命令清單取自 CLI `system/init` 事件的 `slash_commands`，原樣透傳給 CLI（含 `/compact`、技能）；pi 自管 UI 狀態的命令（`/new`、`/model`、`/name` 等）保留在 pi。通用底座不得偽造壓縮（只裁剪介面訊息而 CLI 上下文不變）；不支援原生壓縮的引擎只提示。
- **會話 ID**：`createSession()` 不得返回佔位 ID；真實 ID 來自 CLI 事件並經 `onSessionStarted` 回寫，否則後續 `--resume` 會被 CLI 拒絕。
- **左欄歸屬與去重**（所有引擎）：左欄按 `ConversationSummary.sessionFile/sessionId` 與 `SessionSummary.path/sessionId` 認定「開啟中的對話」與「歷史會話」是同一條；按 `SessionSummary.cwd` 認定所屬專案。通用底座的會話 `path` 是對話 ID（無專案 slug），因此對話摘要必須帶 `sessionId`、歷史行與 `sessions` 訊息必須帶 `cwd`，否則會重複顯示且出現在每個專案下。`isSessionMatchingProject` 必須傳會話物件（優先比 `cwd`），按路徑判斷時先看 `--slug--` 目錄再看路徑字首——會話目錄通常在家目錄下，把 `~` 當專案時字首規則會吞掉所有專案的會話。迴歸：`tests/unit/left-panel-engine-sessions.test.ts`、`universal-session-list.test.ts`、`list-sessions-dispatch.test.ts`。

## 隨手問獨立小窗

**事實源**：`web/src/components/QuickAskPopover.tsx`、`QuickAskAttachments.tsx`、`web/src/use-draggable-popover.ts`、`web/src/quick-ask.ts`、`web/src/quick-ask-context.ts`、`server/quick-ask.ts`、`server/quick-ask-context.ts`、`server/model-session.ts`；設定 UI 為 `web/src/components/QuickAskSettings.tsx`，獨立設定單源為 `server/quick-ask-settings.ts`。

- 右下角常駐入口支援滑鼠 / 觸屏拖動，輕點或按 Enter / Space 開啟預設位於右下角的輕量浮窗；拖動鬆手不會誤觸開啟，視窗縮放後入口保持在視口內。在訊息正文選中文字後的「解釋 / 翻譯」入口也開啟同一小窗。標題欄空白、圖示與標題支援滑鼠 / 觸屏拖動，按鈕和語言選擇器保留原有操作；拖動時收起更多選單，入口與浮窗各自儲存位置到當前頁面記憶體，收起再開啟及新話題沿用位置，重新整理恢復預設。指標捕獲保證移出標題欄後繼續拖動；視窗縮放、浮窗內容展開或流式增高時重新約束位置，保持浮窗在視口內。採用「一句即懂」緊湊佈局：寬度上限 320px，高度隨內容變化，標題與選文合為一行；回答與小窗歷史始終直接渲染完整 Markdown，長內容在回答區內滾動，不截斷預覽，也不提供「展開 / 收起回答」步驟。選文點選後展開，追問框按需出現；空白新話題自動顯示輸入框，手動追問保持輸入框可用。標題欄直接顯示「新話題」加號，一次點選清空當前問答並取消生成；完整回答複製、當前模型資訊與獨立對話說明收進「更多操作」浮層；選單複用 `useFloatingPanel`，支援視口邊界定位、點選外部與 Esc 關閉。完整回答閱讀區最高 290px，流式、停止或錯誤時保留可直接閱讀的正文，停止與重試均可直接操作。正文保持 14px 並使用主題令牌，窄屏不放大為全寬卡片。小窗無背景遮罩，點選或滾動主對話不會關閉，也不改變主對話草稿、訊息和閱讀位置；Esc 或關閉按鈕收起。
- 普通提問在小窗內連續追問，提供程式碼示例和一句話總結快捷追問；歷史僅保留於當前頁面記憶體。真實模型文本增量按動畫幀合併渲染 Markdown；停止或失敗保留已收到的文本，重試從當前問題重新生成。僅當用戶停留在問答區底部時跟隨新內容，上翻閱讀不被拉回。收起後保留歷史、草稿和閱讀位置且請求可繼續；完成後入口顯示提示點。頁面重新整理清空。「新話題」清空歷史並取消正在生成的請求；點選「解釋」同樣開啟新話題，避免前次問答影響解釋。
- 設定 → 隨手問（所有主對話引擎均可用）採用 A「緊湊分組」：基礎、劃詞翻譯、附件與引用、提示詞 / 模板四組卡片；模型與思考、目標語言與風格並排，引用範圍按需展開，三個提示詞只展開一個編輯器。切換、收起、失焦或解除安裝編輯器均儲存草稿；恢復預設只作用於對應模板。設定彈窗外層負責拉取快照，內容元件僅在快照就緒後掛載，避免首次載入的空快照改變 Hook 呼叫順序。預設跟隨當前模型；主引擎模型與獨立 SDK 不相容時，使用首個可用 SDK 模型，明確配置失效則報錯。思考為 `off`，系統提示詞為空，解釋模板為 `解釋下: {{input}}`。關閉常駐入口仍可通過選中文字解釋或翻譯進入。
- 劃詞翻譯預設啟用，目標語言 `auto` 跟隨介面語言，支援自然、直譯、技術三種風格；選中的原文始終顯示在提問氣泡裡（氣泡即使用者訊息本身，不再有「展開原文」開關）。翻譯模板只對 `{{input}}` 與 `{{targetLanguage}}` 做字面替換，選文裡的美元符號或模板字樣不被二次插值。結果卡頭可臨時改目標語言並重新請求，不改變儲存的預設目標。每次解釋或翻譯都從新話題開始，取消未完成的引用快照，不將上次小窗問答帶入新選文。請求失敗時網路級錯誤（`Failed to fetch`）統一轉成可讀提示，不再把瀏覽器原始報錯丟給使用者。
- 小窗底部附件按鈕支援上傳文本 / 圖片、選擇本地資料夾以及顯式引用當前對話。會話、檔案、資料夾和正文檔案路徑的右鍵選單提供「引用到隨手問」；內建條目複用 `contextmenu.session` / `contextmenu.file` 的 hidden/order，引用入口可關閉。右鍵時固化目標 ID、owner、sessionFile 或 path/cwd，非同步過程中不回讀 active。引用顯示為可移除標籤，超過兩項摺疊；新增引用不觸發提問、不改主對話草稿。
- `POST /api/quick-ask/context` 接收 `{source, scope?, clientId?}`：源可為檔案、目錄、顯式會話，或 `{kind:"upload", name, data:base64, mimeType?}` 上傳。返回 `{attachment}` 文本 / 圖片快照；僅提取使用者和助手正文，不包含 system、工具、預設或主會話提示詞，讀取不切換會話。會話預設最近 10 條，可選完整對話；目錄預設清單，可選清單與文本，限制深度 2、100 項並跳過 symlink。源 ID 按規範來源穩定生成，重複引用去重；上傳按名稱與內容生成 ID。上下文讀取支援取消和 15 秒超時；遠端 SSH 工作區當前返回明確的不支援錯誤。
- `POST /api/quick-ask` 接收小窗自己的 `messages: [{role: "user" | "assistant", content: string, attachments?: QuickAskAttachment[]}]` 與可選 `fallbackModel: "provider/id"`。附件僅允許掛在使用者輪次；首次使用或內容改變時傳送快照，未變化的追問引用不重複消耗預算。舊輪次快照保持不變，移除待引用標籤不重寫舊輪次。每個話題最多 8 項附件，單文本 32,768 字元、含來源邊界的總文本 65,536 字元；單檔案 / 圖片 2 MiB、圖片合計 6 MiB。檔案編碼和圖片魔數統一在服務端校驗，未知二進位制、圖片不受模型支援或超限均明確報錯。
- 這是主會話附件 path-only 規則的區域性例外：隨手問不建立 AgentSession、沒有檔案讀取工具，因此僅對使用者明確新增的引用讀取有限快照，並作為對應使用者訊息中的不可信參考文本 / 圖片塊交給獨立 ModelRuntime；絕不提升成 system，也不會自動掃描或附加當前主對話。
- `/api/quick-ask` 預設返回 `{text, model}`；客戶端以 `Accept: application/x-ndjson` 請求真實流式輸出，事件單源為 `server/protocol.ts` 的 `QuickAskStreamEvent`：`start` 提供模型，`delta` 追加文本，`done` 提供權威最終文本，`error` 終止流並報告錯誤。響應帶 `no-transform` 與 `X-Accel-Buffering: no`，防止壓縮或代理快取增量。客戶端使用增量 UTF-8 解碼，缺少終止事件視為失敗；中途錯誤保留先前片段。服務端僅從獨立設定讀取系統提示詞和模型引數，直接呼叫 ModelRuntime 的流式介面，不建立 AgentSession，不隱式讀取主對話歷史、預設、專案提示詞或工具。因為繞過了宿主會話，`sessionId` 必須自帶（`server/model-session.ts` 的 `modelSessionId()`：同一話題傳首條使用者訊息作種子，跨輪保持同一路由與快取；一次性呼叫不傳種子），否則 opencode / opencode-go 閘道器缺 `x-opencode-session` 頭會直接 400 `MissingSessionID`。客戶端取消與超時均中止請求，包括已經發送響應頭後的超時；被取消的舊響應不能寫回新話題。
- `GET /api/quick-ask/models` 從同一個獨立模型執行時返回 `{models: [{provider, id, label}]}`，供所有主引擎下的小窗設定選擇模型，避免依賴 Pi 專有的子代理模型列表。模型目錄請求同樣支援取消與超時。
- 未顯式新增引用時，主會話只提供預設模型 ID。選中文字入口通過 `openQuickAsk` 事件傳送文本快照，按獨立解釋模板插值後作為首條使用者訊息，不攜帶訊息 ID、工具結果後設資料或主會話提示詞。

驗證：`tests/unit/quick-ask*.test.ts`（設定、模板、流式、選單、快照邊界、預算、圖片與取消）、`tests/quick-ask-ui-test.mjs`（桌面 / 移動端，入口與標題欄拖動、拖後防誤觸、輕點與鍵盤開啟、位置保留與視口邊界，A 設定儲存恢復、翻譯切換、真實文本 / 圖片上傳、檔案 / 資料夾右鍵、當前對話顯式引用、去重與重置隔離）；原有主對話引用流程保留在 `tests/quote-selection-ui-test.mjs`。

## 安全邊界

- **預設只綁 loopback**（`PI_WEB_HOST`，預設 `127.0.0.1`）：本地個人工具不暴露到網路；區域網/容器需顯式 `PI_WEB_HOST=0.0.0.0`（docker-compose.yml 已內建，Docker 埠對映才能工作）。
- **WS 升級做 Origin/Host 同權威校驗**（`server/index.ts` 的 `originAllowed`，`WebSocketServer({ noServer: true })` + 手動 `handleUpgrade`）：Origin 存在時其 hostname+**有效埠**必須與請求 Host 一致（瀏覽器裡 `example-host:8445` 與 `example-host:9443` 是不同源）；非瀏覽器客戶端（無 Origin）放行；`PI_WEB_ALLOW_ORIGINS` 白名單繞過（dev:server 已內建 `http://localhost:5173,http://127.0.0.1:5173`，反代場景自配）；`PI_WEB_ALLOW_HOSTS` 可選嚴格 hostname 白名單。**不要**加回「本地任意埠放行」——那正是提案要修的洞。
- **quiesce 准入控制**（`AgentService.quiesce/unquiesce`）：進入排空後**拒絕一切新工作**——新 prompt（native slash 命令例外，純配置無 token）、new_chat、edit_message fork、switch_session、goal wizard；存量執行繼續跑完。已知 clientId 仍可 attach 看存量（發 notice 提示），**全新客戶端 attach 拋 `QuiesceRejectedError` → index.ts 以 4403 關 WS**，瀏覽器重連迴圈在 unquiesce 後自動恢復。
- **控制 socket**（`server/control-socket.ts`）：CLI 的 `server status|quiesce|unquiesce` 經本地 mode-0600 unix socket / Windows 命名管道（`\\.\pipe\pi-web-ui-<port>`）與執行中程序通訊，`status` 報告真實 socket 數（`noteSocketOpen/Close`，index.ts 維護）、active/pending 計數、quiesce 狀態；無鑑權 HTTP 端點。
- **provider headers 不下發瀏覽器**（`models_config` 不再攜帶 `headers` 欄位，可能含 Authorization/API key）：`saveModelConfig` 儲存時若 config 無 headers 則保留舊值（`prevHeaders`）。`UiProviderConfig.headers` 已從 protocol.ts / types.ts 刪除，前端沒有任何地方編輯 headers（僅 apiKey 經獨立訊息 `set_provider_api_key` 走瀏覽器）。
- **內建服務商多金鑰（不復制模型列表 + 純名字通訊）**：一個內建服務商（如 opencode/openai）可同時持有**多把 API key**，存於 `<agentDir>/provider-keys.json`（`{ <providerId>: { activeKeyName, keys:[{name,apiKey}] } }`），**模型目錄始終複用該服務商的預設系統目錄**，絕不復制進 models.json（`clone_provider` 只保留給程式化/測試路徑，UI 已改為多金鑰管理）。**安全**：前端**永遠只拿到鑰匙的**名字**（`ProviderKeyInfo={name,active}`），**原始 key 值 / 掩碼片段（masked）一律不出服務端**——key 值只在新增時經 WS 上傳一次落盤（同 auth.json）；`activate_provider_key`/`remove_provider_key` 都**按名字**定址，服務端解析儲存值。協議：`list_provider_keys` / `add_provider_key`（`{provider, apiKey, name?}`，名字自動去重）/ `activate_provider_key` / `remove_provider_key`，服務端回 `provider_keys`。**activeKey 與 auth.json + 執行時 override 同步**（`applyActiveKey`），切 key 後 `pushModels` 重推該服務商模型。前端模型下拉對多 key 服務商在左側「供應商」欄**按 key 拆成多個條目**（供應商名在上、key 名在下，如 opencode 下 key1/key2 各一條，不拼接 `opencode-key2name`），**選中某 key 條目即只顯示該服務商模型一次，點模型即切換啟用 key** 再選模型——無需靜態副本、始終最新；單 key 服務商仍顯示普通單一條目。
- **內建服務商 OAuth（開放授權）登入**：`ProviderStatus` 同時下發 `supportsApiKey`、`supportsOAuth`、`oauthName` 與 `usingOAuth`，模型管理頁和首次設定頁據此只展示服務商真正支援的認證入口及對應賬號名稱。登入由服務端 `ProviderOAuthFlowManager` 驅動 SDK（軟體開發工具包）的 `ModelRuntime.login`，瀏覽器只接收選擇題、驗證地址、裝置驗證碼和進度；SDK 返回的訪問令牌與重新整理令牌不進入 wire 協議。每個流程使用 `flowId + promptId` 關聯回覆，可取消；活動流程留在 `ClientSession`，瀏覽器重連後通過 `provider_oauth_flows` 恢復當前公開狀態。登入成功後 OAuth 憑據成為該服務商的活動認證，並清除各專案儲存的 API key 選擇，防止切換專案時覆蓋；登出統一呼叫 SDK 的 `logout`。
- **token 反射防護**（issue #45）：`PI_WEB_TOKEN` 鑑權中介軟體裡，`/api/health` 保持開放供探針，但 `Set-Cookie` 只在請求確實攜帶有效 token（`tokenOk(req)`）時才下發——匿名命中 `/api/health` 絕不反射真實 token cookie。迴歸：`tests/token-auth-test.mjs` 的「health does NOT leak pi_web_token」檢查。
- **未登入頁走原生表單登入**（`server/unauthorized-page.ts` + `server/auth-login.ts`，`POST /__pi/auth`）：口令表單是**真 POST → 303 → GET**，並帶 `autocomplete="username"` 的賬號域 + `autocomplete="current-password"` 的密碼域——只有這樣才能讓 Chrome/Safari/Firefox 在登入後詢問「是否儲存密碼」（歷史實現是 JS `preventDefault()` + `?token=` 跳轉，瀏覽器不認為是登入，永遠不彈）。回跳目標統一走 `sanitizeNextPath`：只允許同源絕對路徑（禁 `//host`、`\`、控制字元）並剔除 `token`/`__tried_cached_token`/`auth_error` 查詢引數；口令錯誤 303 回 `?auth_error=1`，未登入頁據此渲染「口令不正確」。`?token=` / Bearer / X-PI-Token 舊路徑全部保留。迴歸：`tests/unit/auth-login.test.ts`、`tests/unit/unauthorized-page.test.ts`、`tests/token-auth-test.mjs`。
- **dev 相容**：vite :5173 代理 /ws 到 :8788 時 Origin(:5173) ≠ Host(:8788)，靠 `PI_WEB_ALLOW_ORIGINS`（dev:server 內建）放行，勿刪。

## 主題切換

- **機制**：`web/src/styles.css` 是**共享基線**（預設深色主題 + 全域性佈局，抽離出來只為方便複用，不是對主題的限制）；主題檔案是**完整樣式表**，可覆蓋任何東西（`:root` 變數、任意選擇器、佈局改動、自帶新 token 皆可——主題 link 後加載，在層疊中勝出）。選主題時前端注入 `<link id="theme-stylesheet" href="/themes/<id>.css">`（`web/src/theme.ts` 的 `applyTheme`，localStorage 鍵 `pi-web-ui:theme`，`main.tsx` 首幀前應用防閃爍）。唯一硬性要求：`var()` 引用的 token 必須在某處有定義（主題自帶定義也算，見下“變數必須先有定義”）。
- **服務端**：`GET /api/themes` 列主題（`server/themes.ts` 的 `listThemes`），`GET /themes/:id.css` 發文件（`resolveThemeFile`，使用者目錄優先）。id 必須匹配 `ID_RE`（`^[A-Za-z0-9_-]+$`）防路徑穿越。兩個路由在 `server/index.ts` 註冊於 SPA catch-all 之前（否則被吞返回 index.html）。dev 模式 Vite 需在 `web/vite.config.ts` 代理 `/themes`（已加）。
- **主題來源**：內建 `<pkgRoot>/themes/*.css`（隨 npm 包分發，`package.json` files 白名單含 `themes/`）；使用者自定義直接往 `<dataDir>/themes/` 丟 CSS 檔案即可（id 衝突時使用者覆蓋內建）。`pkgRoot` 經 `resolvePkgRoot()` 向上找含 package.json 的祖先解析，dev(server/) 與 prod(dist/server/) 均正確。
- **淺色主題**：`themes/white.css`（顯示名「白色」：純白底 + GitHub 藍強調）與 `themes/paper.css`（顯示名「暖紙」：暖紙米黃底 + 赭石強調，護眼）與 `themes/mist.css`（顯示名「霧藍灰」：霧藍灰底 + 天青藍強調，冷淡風）與 `themes/sakura.css`（顯示名「櫻粉」：粉白底 + 櫻粉強調，柔和風）與 `themes/md-preview.css`（顯示名「紫暈」）+ `themes/cyberpunk.css`（賽博朋克）+ `themes/dazzle.css`（炫彩）均由根目錄指令碼 `make-light-theme.mjs` 從 `styles.css` 的 `:root` 變數清單生成**純調色盤檔案**（生成器讀 styles.css 解析全部變數名，主題只覆蓋差異值，僅輸出與宿主預設值不同的 `:root` 變數 + 可選公共樣式 import / 非佈局 tail：white/paper/mist/sakura 帶 `.hljs` 淺色高亮覆蓋、md-preview 帶 body 漸變 + chrome 透明）。styles.css 新增共享變數後主題自動繼承；重跑 `node make-light-theme.mjs` 更新調色盤派生值。相同的底欄結構集中在 `themes/bases/statusbar-flat-base.css`，生成器保留對應 import，避免手工補丁在重新生成後丟失。
- **開關狀態契約**：外掛、設定/MCP/定時任務、裝置中心共用 `styles.css` 的開關外觀規則，各頁面只保留尺寸和滑塊位移。每個內建主題顯式宣告 `--switch-bg-off`、`--switch-border-off`、`--switch-knob`、`--switch-bg-on`、`--switch-border-on`、`--switch-knob-on`；開啟滑塊按底色選擇深/淺色，禁止頁面自行使用強調色或寫死白色。生成器始終輸出這六項（即使等於預設值）；`switch-theme.test.ts` 檢查全部主題兩態滑塊對比度 ≥3:1。
- **主題顯示名**：css 首行 `/* theme-name: 中文名 */` 即為下拉里的顯示名（`listThemes` 讀檔案頭 300 位元組解析），預設回退檔案 id——檔名必須是 ASCII（id 校驗 `ID_RE`），中文靠這個標記。第二行可選 `/* theme-name-en: English Name */`（英文 UI 用，無則回退中文名）；兩行都由 `make-light-theme.mjs` 生成，手改主題檔案頭會被下次重跑覆蓋——改英文名要改生成器。
- **面板收起/展開按鈕對照色（issue #100）**：`.panel-collapse-btn` resting 態即帶底色 + 邊框（與窄屏頂欄 `.panel-toggle` 同級），前景/底/邊框走專用 `--control-fg/--control-bg/--control-border`（預設取正文次級色而非 `--text-faint`），展開條 `.panel-rail` 加寬到 26px、圖示套「藥丸」底——在淺色/自定義主題下也不再隱形。主題可獨立覆蓋這三個變數；淺色預設值在生成器的 `LIGHT_DERIVED` 裡。
- **聊天背景圖/桌布（issue #100）**：`--bg-image: none`（主題可寫成 `url(...)` 自帶一張）+ `--bg-image-dim`（`--bg` 壓暗不透明度，預設 0.78）+ `--bg-image-blur`。`body.has-wallpaper` 時 body 全屏鋪兩層 fixed 桌布：`body::before` 放圖（cover 居中 + 模糊）/`body::after` 壓暗；`.app` 抬 z-index 1 到桌布之上，訊息區/輸入區透明直接見桌布。**容器背景優先**：頂欄/底欄/左右面板背景是獨立變數 `--topbar-bg`/`--statusbar-bg`/`--panel-bg`（預設 `color-mix` 半透明 → 桌布從兩側與頂/底欄下透出），主題把某變數覆蓋回實色（如 `var(--bg-elev)`）即關閉該區桌布、設 `transparent` 即完全透圖；統一透圖率調 `--wallpaper-panel-alpha`（預設 62%，越小透圖越多）。同層還有兩類元件底板：卡片級 `--card-bg`（工具呼叫卡 `.toolcall`、快捷短語 `.quick-chip`、新對話提示詞模板卡 `.empty-template`、展開條 `.panel-rail`、全部訊息氣泡 `.thinking`/`.bashblock`/`.skillcard`/`.attachcard`/`.queued-bubble`/`.retry-notice`）與控制元件級 `--chip-bg`（頂欄 `.chip`/`.tb-tab`/下拉選單 `.dd-menu`、goalbar 收起態提示 `.goalbar-hint`、摺疊鈕 `.panel-collapse-btn`、程式碼面 `.codeblock pre`/`.termline`/`.toolcall-output pre`、工具引數塊 `.toolcall-args pre`），默認同樣半透明、共用 `--wallpaper-panel-alpha`，主題可單獨覆蓋回實色；整塊聊天面板（`.main`：訊息區 + goalbar / 問卷面板佔的那一段 + 輸入區）共用 `--msgs-bg`（同式半透明，氣泡立在統一玻璃面上略實一層形成層次，覆蓋回 `transparent` 恢復全透）。**只塗在容器上**：訊息區 / 輸入區 / goalbar / 問卷面板再各自上色的話，元素之間的間隙與列外區域會露裸背景 —— 淺色與桌布主題下就是一條橫跨整個面板、比聊天區差一檔的帶子（goalbar 一齣現特別明顯），所以 goalbar 與問卷面板不帶自己的底色（只留邊框與投影）；無桌布時兩層 `display:none`，且背景變數預設半透明疊在純色上色差極小。輸入框盒子 `--inputbox-bg` 預設與 `--chip-bg` 同式跟隨 `--wallpaper-panel-alpha`。下拉彈窗（聲音/語言/主題/模型/思考強度等 `.dd-menu`）背景走 `--menu-bg`：預設跟隨 `--chip-bg` 半透，兩個透明主題覆蓋回 `var(--bg-elev2)` 實色保密集列表可讀。終端檢視讀 `--term-bg`（xterm canvas + 容器）：預設實色不參與（終端可讀性優先），半透明主題可覆蓋成 `color-mix` 半透明隨整體透圖。內建「半透明」主題（`themes/translucent.css`）專配桌布：`--wallpaper-panel-alpha: 45%` 整體統一容器色（頂欄/底欄/面板/卡片/控制元件/輸入框全部聯動）+ `--term-bg: color-mix(#0b0d12 45%, transparent)` 終端也透 + `--bg-image-dim: 0.72`，不配桌布時觀感偏暗屬預期。「全透明」主題（`themes/transparent.css`）是極致版：`--wallpaper-panel-alpha: 0%`（全部 color-mix 表面 = transparent，含 `--term-bg`），只留邊框與文字；文字靠壓暗加重（`--bg-image-dim: 0.85`），尾段把實色 hover/浮動反饋（選單項、摺疊摘要、展開條、摺疊鍵、複製鍵、滾到底按鈕）統一改 25% 半透底保可用性，並再減一層程式碼面噪音：`--code-border: transparent` / `--code-pad: 0`（工具引數塊 `.toolcall-args pre`、工具輸出塊 `.toolcall-output pre`、終端行 `.termline` 的邊框與內邊距）＋隱藏與卡頭重複的終端圖示 `.termline-icon`。程式碼面邊框/內邊距走 `--code-border`/`--code-pad`（預設 `var(--border-soft)`/`8px 10px`），卡片正文內邊距 `--card-body-pad`（思考塊 `.thinking-body` 與工具卡 `.toolcall-body` 共用 `4px 14px 12px`，保證同一條訊息裡兩種卡片文字左緣對齊）。使用者自定義地址存瀏覽器 localStorage（`pi-web-ui:wallpaper`，`web/src/wallpaper.ts`：URL 白名單 http(s)/blob/data:image/站內相對路徑，內聯變數覆蓋主題，`useWallpaperEffect` 在 App 頂層應用並監聽主題切換重算）， UI 在設定 → 訊息顯示（地址框失焦/回車提交，壓暗/模糊滑桿即時預覽；也可點「上傳圖片」選本地檔案——複用貼上圖片管線等比縮 ≤1568px + 重編碼為 data: URL 存 localStorage，上傳失敗/過大時行內提示；data: 圖不回填輸入框，下方縮圖即表示生效中，清除按鈕同時清掉地址與預覽）。
- **變數必須先有定義（幽靈 token 陷阱）**：`var(--x)` 引用一個全倉沒有任何 `--x:` 宣告的自定義屬性，按規範是 guaranteed-invalid —— 整條宣告在計算值階段失效（不帶 fallback 的 `background` 直接**沒有背景**；`box-shadow` 連投影與聚焦光環一起丟；帶 fallback 的靜默用硬編碼值，淺色主題下必是深色塊）。`--bg-elev1`（正確名是 `--bg-elev`）全史未定義卻被 10 處引用，goalbar 因此一直沒有填充。新增/改名變數後跑 `tests/unit/css-tokens.test.ts`（靜態體檢：掃 `web/src` + `plugins` + `themes` + `web/index.html` 的每個 `var()` 引用，帶 fallback 的也查；執行時注入的變數與刻意寫的中性兜底在該測試的豁免表裡登記並寫明理由——新增豁免要一併寫理由）。
- **終端跟隨主題**：xterm 畫布經 `web/src/theme.ts` 的 `buildTermTheme()` 讀 `--term-*` 變數，主題切換時 `TermXterm.tsx` 監聽 `pi-web-ui:theme-change` 事件用 `term.options.theme` 熱更新畫布；CSS 容器 `.term-main` / `.term-xterm .xterm-viewport` 用 `var(--term-bg)`，與畫布自動融合。styles.css 改動後重跑 `node make-light-theme.mjs` 重新生成。
- **按鈕狀態契約**：普通按鈕統一用 `--button-bg/fg/border`、`--button-hover-bg/fg/border`；實底主按鈕統一用 `--button-primary-bg/fg` 與 `--button-primary-hover-bg/fg`；危險按鈕用 `--button-danger-bg/fg` 與 `--button-danger-hover-bg/fg`。主題優先覆蓋成對變數，避免重複複製元件選擇器。主按鈕預設保持懸浮文字/底色配對，以外圈提示懸浮，禁止整體 brightness 濾鏡同時改字與底。傳送/停止的懸浮底色分別配 `--on-send-blue-hover` / `--on-stop-red-hover`，不能假設普通狀態前景仍可讀。`node tests/theme-buttons-test.mjs` 無需構建或啟動服務，在真實 Chrome 中逐主題驗證十類按鈕普通/懸浮態的最終層疊與透明背景合成，對比度下限 3:1；無 Chrome 明確 SKIP，已加入全量冒煙。
- **迴歸**：`theme-test.mjs`（埠 8937，隔離 data-dir）：列表/內建/使用者主題、注入 link、淺色生效、重新整理持久、使用者主題可應用、回預設移除 link。

## CSS 分層（`@layer guard, base, theme, drawer;`）

- **為什麼分層**：`web/src/styles.css` 是共享基線、主題是後加載的完整樣式表，兩者在同一份文件裡爭權重。分層重構前，能跨檔案奪權的唯一手段就是 `!important`（歎號 important）：基線 218 處、主題側 613 處（`bases/obsidian-base.css` 220、`bases/zhujian-base.css` 143、`bases/zhupi-base.css` 132、`aetheris.css` 118），主題要壓住基線只能繼續加碼，越改越沉——典型的軍備競賽。改成顯式分層 + 無層覆蓋區後基線只剩 1 處（mermaid 執行時內聯 style，見下），勝負由**層序**決定，歎號 important 不再是奪權工具。
- **四層職責**（順序宣告只有一處：`web/src/styles.css` 頂部的 `@layer guard, base, theme, drawer;`，早於所有層塊，層序按此固定）：
  - `@layer base`：整份基線樣式（`web/src/styles.css` 內容）。預設層，正常寫選擇器，不加 `!important`。
  - `@layer theme`：主題樣式。**服務端統一下發**——`server/themes.ts` 的 `readThemeCss()` 內聯展開 `@import` 後把整份文本包進 `@layer theme { … }`（只包最外層一次；遞迴內聯的子檔案原樣返回，否則會變成巢狀層）。`themes/**/*.css` 原始檔因此**不需要**自己寫 `@layer`，也不需要 `!important`：只要寫在主題裡就天然壓過 base。
  - `@layer drawer`：底部面板與原始碼管理面板（`web/src/drawer.css`，經 `@import … layer(drawer)` 引入）。它排在最後，因此能壓過 base 裡的同名規則，**不必靠複合類提權**；新增元件層只能追加到這個位置之後。
  - `@layer guard`：唯一活口是 mermaid——它用 d3 `.style()` 把字號寫成 SVG 內聯 `style`，任何普通宣告都壓不住，只能留這一處歎號 important（`styles.css` 末尾，寫明原因）。guard 先宣告，層序反轉後它的 important 恆勝。別把普通樣式挪進來偷懶。
- **無層覆蓋區**（`styles.css` 末尾、所有層塊之後）：需要蓋過主題或未分層三方庫（highlight.js `github-dark.css`，bundle 裡後加載）的結構性復位放這裡——程式碼行清零（同為無層後靠更高權重蓋過 `pre code.hljs`）、摺疊態 `.goalbar.goalbar-collapsed` 抹皮（無層一句蓋住 theme 層面板皮）。**未分層的普通宣告永遠勝過任何層內的普通宣告**，所以這裡不需要歎號 important。分包引入的 CSS（如 `web/src/model-management.css` 經 `@import … layer(base)`）與外掛樣式同樣必須進層，不能裸奔成無層。
- **層序規則（兩個方向相反，最容易踩）**：普通宣告按**層宣告順序**後者勝（`theme` > `base` > `guard`）；帶歎號 important 的宣告**反向**——先宣告的層勝（`guard` > `base` > `theme`）。所以 guard 層的價值恰在於它**先**宣告：mermaid 那一處例外放進去就能蓋住執行時內聯；而 base/theme 裡寫歎號 important 只會把自己釘死，越寫越糟。另注：**未分層的樣式永遠勝過任何層內的普通宣告**——這正是「無層覆蓋區」能零提權蓋住主題與 highlight.js 的原因。
- **新增樣式時的規矩**：① 主題裡**禁止**歎號 important，一律靠 theme 層勝出；② 基線裡同層權重不夠時用**複合類提權**（如 `.canvas-dropdown-item.canvas-inline-create`），不準加歎號 important；③ 要蓋主題/三方庫普通宣告時用檔案末尾**無層覆蓋區**，不準加歎號 important；④ 只有執行時內聯 `style`（如 mermaid）才配寫，必須寫明原因並收進 `@layer guard`；⑤ 主題不要再寫 `#root .foo` 這類 ID 加權選擇器和基線搶權重（層序已解決，殘餘的 ID 加權屬於歷史包袱，改到即刪）。守衛：`tests/unit/css-layers.test.ts`（基線歎號 important ≤ 1、`themes/**/*.css` 必須為 0、層宣告與 guard 位置、文件契約）。
- **視覺迴歸閘門**（改了任何樣式都必須過）：`npm run audit:themes`（當前樹截圖 → `.theme-audit/current`）→ `npm run audit:diff`（與 `.theme-audit/baseline` 逐畫素比對）。固定 fixture DOM（含氣泡/Markdown/表格/程式碼/思考卡/工具卡/膠囊流/輸入島/頂欄/側邊停靠欄/快捷短語/外掛圖示/`hide-model-row` 緊湊模式）+ 每個主題一張圖（35 個主題），單主題差異 > **0.05%** 即退出碼 1。
  - 基線快照 `.theme-audit/baseline` 是「分層重構完成時」的狀態（已 gitignore）。要拿**重構前**的基線只能開一個 `HEAD` 的 git worktree 再拍：`git worktree add ../baseline HEAD` → `node scripts/theme-audit.mjs --root ../baseline --out .theme-audit/pristine`。
  - 只有當差異確屬「有意改進」時才允許重建基線；否則先查層序（`theme` 被 `base` 壓住是最常見的錯）。
- **已接受的有意差異（主題為準）**：分層後 `theme` 層恆勝 `base`，以下 4 處歷史上是基線的 `!important` 贏、現在按主題樣式渲染 —— 這是**定案，不是缺陷**，不要再用對齊塊把它們打回舊值（zhujian/zhupi/aetheris 頂欄那組對齊塊是歷史特例，後續新主題姿態請以主題直出為準）：
  1. `flow` / `flow-light` / `wallpaper-flow`：`.msg-assistant` 上下 padding 取主題的 `0`（原被基線緊湊模式的 2px/4px 蓋）——夾具差異 ~2.0%；
  2. `flow` / `translucent` / `transparent`：`.quick-chip.active` 取主題底色（原被基線強調底蓋）——差異 ~0.5%；
  3. `aetheris`：`.chip` 圓角與 `.bar-item` 內邊距取主題值；
  4. `wallpaper-obsidian`：外掛圖示 `.plugin-icon-svg` 顏色取主題值。

## 中央列幾何（訊息列與輸入框永遠等寬對齊）

- **唯一事實源**：`.main` 上的四個 token —— `--chat-pad`（列最小左右留白：桌面 20px / 手機 14px / 寬屏聊天列 260px）、`--chat-max`（列寬上限 860px；寬屏聊天列設成 `100%` 取消上限）、`--chat-rail`（提問導航條讓位，桌面 48px）、`--chat-inset = max(--chat-pad, (100% - --chat-max) / 2, --chat-rail)`。訊息列、輸入框、goalbar、`/` 命令選單、擴充套件問卷面板一律只用 `--chat-inset`（`.inputbar` 用它做左右 padding，子元素全是自適應寬度），**不允許**再出現 `max-width: 860px; margin: 0 auto` / `calc(100% - Npx)` 這類逐元素校正——兩列等寬只是同一個值的兩個使用點。
- **百分比基準**：`--chat-inset` 內含百分比，只在「包含塊寬度 == `.main` 內容寬」的元素上使用（`.messages` / `.inputbar` / `.goalbar` / `.dialog-inline`）；fixed 浮層（檔案預覽的 markdown 縮放列、`/help` 面板）自成包含塊，仍走定距寫法。
- **滾動容器補償**：`.messages` 帶 `scrollbar-gutter: stable both-edges`，內容盒左右各被扣掉一條 gutter，所以它用 `padding-inline: max(0px, calc(var(--chat-inset) - var(--msgs-gutter)))`（外面那層 `max(0px, …)` 是防禦：負 padding 會讓整條宣告失效、內容直接貼邊）；`--msgs-gutter` 由 `web/src/scrollbar-gutter.ts` 維護——首幀前用與 `.messages` 同設定的探針給初值（必須 `overflow-y: auto` + `stable both-edges`，用 `overflow-y: scroll` 量到的是疊加層捲軸 0px，與實際佔位寬度不符，這正是歷史上「訊息列比輸入框窄 20px」的根因），`.messages` 掛載後改用真實元素實測並覆蓋，視窗尺寸變化時再校一次。
- **提問導航條讓位**：`qn-rail` 釘在訊息區右側 14~38px，桌面（≥641px，rail 僅此時存在）恆定預留 `--chat-rail: 48px`，左右同時加 → 兩列依舊等寬、左右邊緣依舊對齊；主列夠寬時（居中留白 > 48px）`max()` 取原值，寬屏觀感不變。恆定預留而非「有 rail 才預留」是為了避免第一條訊息發出、rail 出現時整列突然縮 28px。
- **迴歸**：`tests/chat-column-align-test.mjs`（多視口 × 寬屏聊天列開關 × 手機，逐一比對 `.msg` / `.msg-text` / `.msg-collapsed` / `.retry-notice` / `.inputbox` / `.goalbar` / `.slash-menu` / `.dialog-inline` 的左右邊緣與寬度，並斷言 rail 不壓訊息列）。

## 多對話併發

- 每客戶端 `convs: Map<convId, Conversation>`，**每個對話一個獨立 `AgentSessionRuntime`**：`new_chat` 新建 runtime + 新 session 檔案（舊對話繼續在後臺跑，不中斷）；`switch_conversation` 只換 `activeId`（不碰其他 runtime）；`runtime`/`session` 訪問器指向當前活動對話。**對話按專案歸屬**：`conv.cwd` 即所屬專案，每個專案各自的活動對話互不干擾。
- **`set_cwd` 不再重建當前對話**——改為切到目標專案自己的對話（該專案最近活動的那個；沒有則新建一個並恢復該專案最近的持久會話）。
- **工作區命令必須序列（#872）**：`cs.cwd`、活動對話、runtime 繫結是同一組可變狀態，而改它們的命令（`set_cwd` / `new_chat` / `new_cli_chat` / `switch_session` / `switch_conversation` / `fork_session` / `rollback_session` / `make_dir(setAsCwd)` / 沙盒切換）都是非同步重活（stat、恢復最近會話、掛載 runtime、複製沙盒）。ws 訊息逐條派發，上一條還在 await，下一條已經在跑 —— 「先切專案再新建對話」搶跑時 `newChat()` 讀到的還是舊 cwd，新對話就落進上一個專案（左欄裡像「消失」了）。
  - **唯一單源 `server/workspace-queue.ts`**：派發層對上述命令只做「同步認領 + 入隊」，按會話例項 FIFO，後一條等前一條落定；空閒時只多一個微任務。新增工作區命令必須入隊，且**不得**在 handler 裡自己寫「等一會兒再幹」。
  - **宣告式目標目錄**：`new_chat` 可帶 `cwd`（`ClientMessage`），服務端在同一條佇列任務裡「切工作區 → 核驗 → 建會話」；**切不過去就不建會話**（錯誤提示 + `new_chat_result ok:false`），絕不靜默落到舊專案。`new_cli_chat` 自帶 cwd，自驗證、不受這條攔截。
  - **客戶端意圖單源**：`web/src/pending-workspace.ts` 記住「已宣告、未確認」的 `set_cwd` 目標，並自動掛到緊隨其後的 `new_chat` 上（各入口不各自記一遍，禁逐處補 cwd）；快照落到目標目錄或 cwd 過渡 `done`/`error` 即清理。
  - **入隊的命令必須自己是有界的**（自帶超時 / 中止）：佇列是 FIFO，一條永不落定的命令會堵住該客戶端所有工作區操作。`prompt` 與檔案類命令不進隊（各走自己的路）。
  - 迴歸：`tests/unit/workspace-queue.test.ts`、`tests/unit/pending-workspace.test.ts`。
- **「執行的對話」列表生命週期**（每個對話 `listed` / `promptedSinceActive` / `lastActiveAt` 三欄位）：
  - 入列：活動對話**正在流式輸出時**被擠到後臺（new_chat / switch_conversation / set_cwd，**跨專案切換同樣入列**）→ `listed=true`；從歷史顯式恢復的會話在開啟時即設 `listed=true` + `promptedSinceActive=true`，首次切走不發新訊息也保留。
  - **臨時對話防丟失（#793）**：已開始的 `isEphemeral` 對話切走時始終保留並設 `listed=true`，不依賴全域性 `retainFinishedConversations`、原先的 `listed` 或本次是否發新訊息；重複開啟再切走同樣保留。空白臨時對話仍可自動回收，顯式 ✕ 仍可銷燬；保留不代表落盤，需「儲存為正式對話」才能進入歷史。
  - 留在列表：後臺跑完不移出（使用者可能還沒看結果）；**還有“用過”的存活 PTY 的對話也留在列表**（終端裡可能有仍在跑的任務），但**已退出、僅保留輸出的終端不阻止移出**——AI 結束且終端全部跑完後切走，`removeConversation` 順帶 `killAll()` 關閉殘留終端並從列表消失（`openTerminals` 傳 `terminals.countBlockingLive()`，只統計存活且用過的 PTY——**沒動過的空 shell（點開終端 tab 自動建的那個）不算**，切走/✕ 移出時隨對話一起釋放，不攔截）；
  - 移出：開啟它（切為活動）→ 沒有繼續對話（期間沒發過 prompt）→ 切走時 `displaceActive()` 返回它，`removeConversation` 釋放 runtime（會話已持久化，歷史列表仍可恢復）。**子代理豁免切換關閉**：活動的是子代理時切走永遠保留（`listed=true`，`displaceActive()` 返回 null）——點開看過就切走也不釋放，後臺任務繼續跑；清理走顯式動作（單條 `dismiss_conversation` / 右鍵批次 `dismiss_finished_subagents`）。
  - **展示口徑 vs `listed`**（issue #140）：左欄推什麼由 `shownInRunningList()` 決定 = `listed` **或** 「當前對話 + 已經有內容」（有訊息，或已被首條提示詞命名——命名與首條訊息同一時刻，`prompt()` 裡那個 rename 塊順手 `emitConversations()`；`agent_start` 再補一次讓「流式中」綠點立刻亮起來）。空白新對話仍不入列（防連點「新建對話」堆出一排空條目）。這是**純展示口徑**：`listed` 的語義、以及 `displaceActive` / `shouldRetainActive` 那套執行時釋放規則完全不變（換走時該釋放的仍然釋放）——所以當前對話那一行的 ✕ 必須按同一口徑判定（`dismissConversation` 的「不在列表裡就 no-op」用的是同一個函式），否則會出現「行在、點 ✕ 沒反應」。迴歸測試：`tests/running-list-test.mjs`（零 token mock 模型）+ `tests/panel-layout-test.mjs`（真瀏覽器：區標題/「當前」樣式/流式綠點）。
  - 關閉父對話連帶提示：`dismiss_conversation` 帶 `withFinishedSubagents=true` 時連帶關閉該對話下已結束的子代理（傳遞後代，與批次口徑一致；active 的跳過）——只關不執行的：執行中的後代不受影響，關完後若還有後代剩下父級暫留並提示；只有執行中的後代時拒絕。不傳 flag + 存在已結束子代理後代時拒絕並提示。前端：父行有子代理後代時 ✕ 點一次展開兩個選項——「僅關已結束（{n}）」（= 按行批次 `dismiss_finished_subagents`，父級保留）/「強行全關」（`force=true`，見下）。
  - 強行關閉 `force=true`：中止自身執行（如在跑，`interruptRun`）+ 中止全部子代理後代（執行中的也停，`stopSubagent`）再整體移出；終端/審查/後臺喚醒等保留態一併放行。active 對話也可關閉（`vacateActive`：優先切到其他已列出對話，否則新建一個再移）。DSH 引擎無子代理：force 只放行 active/終端限制，執行中仍拒絕（單 runtime 無法單獨 abort，請先點停止）。前端：所有行（含選中/執行中）都顯示 ✕；無子代理的執行中行兩段確認強行關閉（`dismissStreamingConfirm`）；行右鍵選單同樣有兩個選項（`forceDismissConversation` 兩段確認）。
- **跨客戶端「另一處」行（issue #145 / #291）**：`listExternalRunning(excludeClientId)` 把別的 `ClientSession` 裡仍持有的對話下發給左欄（只讀感知 + 手動過戶入口，`owner`/`convId` 定位目標）。**斷連殘骸**（最後一個瀏覽器斷開、`sinkCount()===0`）的行在寬限期內仍下發並標 `ownerOffline`（前端「離線」徽標），過期後消失 —— 寬限期 `PI_WEB_OFFLINE_ROWS_TTL_MS`（預設 30 分鐘；`0`/`off` = 不下發 = 舊口徑）。為什麼需要它：手機端「run 途中關頁面 → run 在服務端繼續跑完」之後，換裝置開啟網頁既看不到行也沒法過戶（#291 跳過了 sinkCount=0 的殘骸），只能去歷史對話裡開 —— 而殘留 runtime 仍持有那份轉錄，歷史裡開等於給同一份 JSONL 造第二個 writer。寬限期的到期時刻取「斷開時刻」與「最後一次活動」的較晚者（斷開後還在跑的後臺任務不吃 TTL，每有流式變化就重排），到期由 `armOfflineRowExpiry` 定時器推一次讓行消失（回撥只推不重排，避免 1s 輪詢）。迴歸：`tests/offline-takeover-test.mjs`、`tests/elsewhere-lifecycle-test.mjs`、`tests/unit/elsewhere-dedup.test.ts`。
- **過戶是事務性的（#556）**：`take_over_conversation` 分兩步（源會話 `detachTakeoverConversations` 摘除 → 目標會話 `insertTakeoverConvs` 接入），中間那一瞬間對話兩頭都不掛 —— 只要第二步報錯，runtime 還在跑但任何列表都不包含它（「幽靈會話」，重新整理頁面無敕，只有重啟服務才能靠落盤會話恢復）。現在接入失敗就把整包原樣搬回源會話（`returnTakeoverPayload`：先 `reclaimTakeoverConvs` 摘掉已部分插入的殘留，再用同一套 insert 接線接回源頁面並切回 active），兩邊都收到誠實的回執；二次失敗時寧可留在目標頁面（接入方已給主對話置 `listed`）也不落到無人持有的空檔。迴歸：`tests/takeover-rollback-test.mjs`（測試專用故障注入 `PI_WEB_TEST_TAKEOVER_FAIL_INSERT`）。
- **駐留對話預設不限數量**，新建、恢復歷史、派生及持久化子代理共用 `getMaxOpenConversations()`。僅將 `PI_WEB_MAX_OPEN_CONVERSATIONS` 設為有限正數才啟用按專案的數量上限（向下取整，最小 1）；未配置、`0`、負數或非法值均不限。此上限統計持有 runtime 的普通對話，包含已結束但仍駐留的對話及 `persist=true` 的持久化子代理；`isSubagent` 記憶體子代理和臨時會話不佔位。顯式啟用上限時保留併發建立預留和歷史對話 LRU 收起；預設無限制時不因數量收起已有對話。它用於可選的資源控制，不能代表正在執行的任務數。
- 所有對話共享**一個 ModelRuntime**（首個對話建立時播種，`makeRuntimeFactory` 傳入複用）——頂欄換模型對全部對話生效。**訊息序列化快取（msgIds/uiMessageCache/簽名）按對話隔離**：兩個對話可能產生相同的 (role, timestamp) 鍵，共享會串號。
- **專案切換記住 {模型, key} + 全域性預設模型**：`client-state` 持久化 `projectModels`（cwd→"provider/id"）與 `projectProviderKeys`（cwd→provider→keyName）。**選模型即刻儲存**（`setModel` → `rememberProjectModel`，不等一次問答——SDK 只有存在 assistant 訊息後才把 `model_change` 落盤，否則新對話選完模型就切走會丟）；**切換專案/會話時恢復**（`restoreProjectModelForCwd` + `restoreProjectProviderKeysForCwd` 於 set_cwd / switch_conversation / switch_session / ClientSession.create），新對話也會套上該專案上次的 {模型, key}。模型/金鑰被刪時恢復靜默跳過。**全域性預設**（`defaultModel` + `defaultProviderKeys`，存 `__settings__` 全域性鍵、全客戶端共享）：模型下拉底部「☆ 設為全域性預設」把當前模型（含當時 key）記成全域性預設，行上 ★ 標記；無專案記憶的新專案回落到它（`set_default_model` / `clear_default_model` / `default_model` 推送，attach 即推；pi 引擎專有，DSH 下按鈕隱藏）。回落鏈：專案記憶 > 全域性預設 > SDK 預設；key 同理（`restoreKeyForModel` 先專案 pin 再全域性 pin）。刪 key 時全域性引用同步改指（`repointDeletedKeyInDefault`）。迴歸：`tests/unit/default-model.test.ts`。
- `snapshot` 帶 `conversationId`；`conversations`（ServerMessage）推**全部專案已入列的對話 + 當前對話（有內容後，見 `shownInRunningList`）**（前端按 `cwd` 分組顯示，當前專案不顯示組標題）+ `activeId`（activeId 只在還是個空白對話時才不出現在列表裡）；`switch_conversation`（ClientMessage）**可跨專案切換**——切到其他專案的對話時同步切換工作區，補齊 `set_cwd` 的副作用（檔案樹/會話歷史/專案順序/命令目錄/onCwdChanged 鉤子）。
- `switch_session`（恢復持久會話）會為目標會話建立獨立 runtime，再按上述生命週期把當前對話移到後臺；若目標會話已在執行列表中則直接複用其 conversation，絕不因開啟歷史記錄中斷當前生成。迴歸測試：`tests/switch-session-background-test.mjs`。`edit_message` 在**當前**對話內 fork；`dispose` 遍歷銷燬全部對話；attachSink 重連時補推 conversations。
- **服務重啟後自動繼續**：`resumeInterrupted` 按轉錄檔案定位恢復後的 conversation，直接向它的 SDK session 投遞 `restart-resume` 自定義訊息（`display:false`、`triggerTurn:true`），保留 SDK 的重試、壓縮和完成事件；不追加使用者「繼續」氣泡，即時訊息和重新開啟歷史時均隱藏該內部恢復標記。各對話獨立啟動，不等待上一條執行結束；併發切換 `activeId` 不改變續跑目標，已關閉或已有任務的對話跳過。迴歸：`tests/unit/restart-resume.test.ts`。
- 前端：左欄「執行的對話」區（≥1 個時顯示，活躍高亮 + `當前` 副標籤、流式綠點；空白新對話不顯示該區），MessageList 以 conversationId 為 key 強制切換重掛載。跨專案分組見 `web/src/conv-groups.ts`（純函式 + 單測）：**當前專案那組不顯示組標題**，判定以「當前對話在哪個組」為準（`currentCwd` 只當回落）——`conversations` 推送先到、帶新 cwd 的快照後到，只按 `cwd` 判定會讓當前專案在切換那一幀被當成「別的專案」而閃一下專案名（bin 瀏覽器逐幀迴歸 `tests/conv-group-flash-test.mjs`）。

## 其他橋接

### 工具結束即時狀態（`tool_status`）

服務端 `onEvent` 監聽 `tool_execution_start/end`（AI 調工具路徑，注意區別於 `bash_execution_update`——那是 `!cmd`/終端直接執行路徑專屬）。`tool_execution_end` 觸發時立即推 `tool_status`（toolCallId/toolName/isError/exitCode/durationMs），**先於** toolResult 快照落盤——瀏覽器 tool 卡片隨即從「執行中」切到「已結束 · 等模型 · 耗時」，一眼區分「命令還在跑」vs「命令完了在等模型響應」。bash 工具的 details 不帶 exitCode（成功時返回 truncation 資訊，失敗時錯誤文本含 `Command exited with code N`），服務端從錯誤文本正則提取；`tool_execution_start` 時刻記在 `conv.toolStartTimes`（按對話隔離）算真實執行耗時。前端 `toolStatuses` Map 在 toolResult 落盤（snapshot prune）後清除，回落到權威的 toolResult 狀態。

### 工具掛死看門狗

每個 `tool_execution_start` 都會為 toolCallId arm 一個看門狗 timer（**優先取設定面板「工具」頁的 `ClientSettings.toolWatchdogTimeoutMs`**（分鐘，0 = 停用，逐 run 即時讀取、無需 reload）；未設時回落環境變數 `PI_WEB_TOOL_TIMEOUT_MS`（毫秒），再回落預設 20 分鐘）——超時仍在跑就 `session.abort()`（殺程序樹）+ warning notice，`tool_execution_end` / `removeConversation` / `dispose` 都會清掉對應 timer。**若工具呼叫自己顯式聲明瞭更長的超時**（目前只有 bash 的 `args.timeout`，秒），看門狗自動順延到 `max(基礎值, 工具超時 + 5s)` —— 否則 AI 傳 `timeout: 5400`（90 分鐘）也會被 20 分鐘的看門狗聯同整輪對話一起剁掉。恢復重建 + 重綁會話（同一 conv 記錄，UI 不掉線）；看門狗超時也走同一 `interruptRun`。**只停止執行，不碰後臺服務**——那些由「後臺任務」面板單獨管理。迴歸：`tests/unit/tool-watchdog.test.ts`。

**豁免 `ask_user_question`**：問卷阻塞等的是「人類回答」，不是掛死的工具——arm 前按工具名跳過（`tool_execution_start` 裡 `event.toolName !== ASK_USER_QUESTION_TOOL_NAME`）。它的收場自有路子：使用者回答/取消、會話 dispose（`cancelPendingQuestions`），**不限時**（標準 pi 引擎；DSH 引擎無此看門狗，提問走 `PI_WEB_DSH_QUESTION_TIMEOUT_MS` 自己的 10 分鐘）。同理，問卷掛著也不算「失聯」——stall 檢查（`startStallTimer`，預設 180s 無 SDK 事件告警）對 `isWaitingOnUser(conv.id)` 的對話跳過。迴歸：`tests/question-bridge-test.mjs`（`PI_WEB_TOOL_TIMEOUT_MS=2000` 掛著不答超過閾值仍不終止）。

### 審批佇列與共享展示

`UiState.pendingApprovals` 是當前連線持有的全部對話的權威待審批佇列（含後臺對話），按建立時間排序；完整快照與增量快照均攜帶，重新整理或重連後可恢復。`pendingApproval` 保留單項相容。即時 `tool_approval_pending` 按 ID 追加或更新，`tool_approval_resolved` 僅移除對應 ID，不能清空其他待辦。答覆仍通過服務端 `findPendingApproval` 按穩定 ID 定位原對話；允許同類/全部允許仍只作用於該對話。

前端問卷和審批共用 `PendingQueue` 的列表、數量、等待時間、穩定選擇、跳轉和稍後處理邏輯，分別保留 `QuestionDialog` 與審批編輯面板。新請求和快照不能搶佔已開啟的請求；審批編輯器只隨請求 ID 初始化，避免快照覆蓋正在編輯的引數。稍後處理只暫緩展示，不產生審批答覆；暫緩狀態僅在本次頁面生命週期儲存。

### 審批三檔放行與自定義規則庫

人機協同審批（`tool_approval_pending`）原先只有「批准 / 拒絕 / 修改並放行」三個單次選項，同一類高危操作反覆出現時每次都要點。現在的審批系統分為**規則評估引擎**與**放行策略**兩個層次：

#### 1. 自定義規則庫與匹配引擎（`<dataDir>/approval-rules.json`）

規則由 `server/approval-rules.ts` 的 `ApprovalRulesStore` 持久化，所有客戶端全域性共享。規則在設定面板「審批規則」頁視覺化編輯與排序，按列表順序自頂向下匹配，首個命中生效：

- **適用工具**（tools）：支援單工具（如 `bash`）、多工具組合（如 `["write", "edit", "patch"]`）或通配 `*`；
- **檢查欄位**（field）：`command`（命令字串）、`path`（目標檔案路徑：認 `path` / `file_path` / `file` 三種寫法，見 `extractTargetPath()`，擴充套件實現如 pi-better-edit 的 `edit` 用 `file`）、`params`（完整引數 JSON 字串）；
- **匹配模式**（match）：
  - `regex`：大小寫不敏感正規表示式匹配；
  - `glob`：路徑萬用字元（支援 `*` 單段、`**` 跨目錄跨段，統一歸一化正反斜槓）；
  - `contains`：包含子串匹配；
  - `prefix`：字首開頭匹配；
  - `outside_workspace`：工作區外寫入越界檢測（基於當前工作區 cwd 與額外 roots 物理路徑判定）；
- **命中動作**（action）：
  - `ask`：觸發人機協同審批（彈窗讓使用者決定，支援就地編輯引數與允許同類）；
  - `deny`：直接拒絕阻斷執行並向模型回傳錯誤（不彈窗、不產生待審批 pending）；
  - `allow`：免審直接放行（白名單，跳過後續規則與內建檢測，直接執行工具）。
- **內建規則轉化**：原硬編碼的 10 項內建高危檢測（`rm -rf`、Windows `del /s /q`、磁碟格式化、破壞性 Git、危險 `chmod`、系統目錄重定向、敏感配置 `.env`/SSH/Shell 以及越界寫入）全部轉換為預設內建規則（`builtin: true`），使用者可自由停用、調整動作或一鍵恢復預設。

#### 2. 三檔放行策略（執行時快速免問）

門禁統一在 `ClientSession.askApproval` 入口（純函式 `approvalSuppressionReason(policy, enabled, categoryId)`，`server/tool-approval.ts`，單測 `tests/unit/tool-approval.test.ts`）：

1. **全域性關**：設定 →「工具」頁的「工具執行審批」總開關（`ClientSettings.toolApprovalEnabled`，預設開，純執行開關不進預設）。關掉後一切審批都不彈——內建高危檢測直接放行、外掛 pre guard 的 `ask` 也按放行處理（`withToolGuard` 的 `ask` 分支只改 `needApproval`，最終都經 `askApproval` 定奪）；開關被關掉的那一刻，掛著的待審批項由 `autoApprovePendingApprovals` 全部按批准放行（不讓人對著彈窗乾等）。
2. **本對話全部允許**（彈窗按鈕，`tool_approval_response.scope = "all"`）：該對話後續任何高危操作都不再詢問。
3. **本對話允許同類**（彈窗按鈕，`scope = "category"`，僅在本次命中規則檔位時出現）：只放行同一檔位。檔位 = `UiApprovalCategory{ id, label, labelEn }`，id 穩定不許改名：`bash.rm-rf` / `bash.win-del` / `bash.disk` / `bash.git-destructive` / `bash.chmod` / `bash.system-redirect` / `file.sensitive.env` / `file.sensitive.ssh` / `file.sensitive.shell` / `file.outside-workspace` / `phone.gesture` / `phone.input` / `phone.key` / `phone.launch` / `plugin:<pluginId>`（外掛 pre guard 的 `ask` 按外掛分檔）。無檔位的攔截（自定義 reason）只受前兩檔影響。

**手機操控檔（#902）**：`phone` 工具的 `op` 分讀屏檔（`status`/`dump`/`screenshot`）與操控檔（`tap`/`long_press`/`swipe`/`input`/`key`/`launch`，單源 `server/phone-tool.ts` 的 `PHONE_READ_OPS` / `PHONE_CONTROL_OPS`）。**讀屏檔不建規則**（預設不攔截）；操控檔由 `PHONE_APPROVAL_GROUPS` 派生出 4 條內建 `ask` 規則（`builtin.phone.*`，`field: "params"` 匹配 `op`，容空白/大小寫），因此每檔既能單獨停用（等價於「只允許讀屏」「launch 才問」這類粒度），也能按檔「記住本類」。工具描述與設定文案必須寫明「開啟即授權整機操控，但每個操控 op 先問」，不要退回到「無逐操作審批」的舊口徑。迴歸：`tests/unit/phone-tool-ops.test.ts`。

**策略掛在哪**：`Conversation.approvalPolicy = { allowAll, categories: Map<id, UiApprovalCategory> }`，**僅記憶體**（不落 client-state），且掛在對話物件上而不是 ClientSession——手動過戶搬的就是對話本體，策略跟著走；重啟服務 / 新對話即恢復詢問。記住後同對話內**已被新策略覆蓋的其它待審批項一併放行**（`approveCoveredPending`），並給一句回執 notice。

**撤銷**：設定 →「工具」頁列出當前對話已記住的放行（`UiSettingsState.approvalPolicy`，服務端 `approvalPolicyState()` 現取），逐條「撤銷」走客戶端 `set_approval_policy`（`allowAll` 賦值 + `categories` 作保留名單整體替換；純記憶體態，不走 `set_settings`）。彈窗本身在策略生效後就不再出現，所以撤銷入口必須留在設定裡。

迴歸：`tests/approval-policy-test.mjs`（協議面：開關持久化 / 策略推回面板 / 垃圾訊息 no-op）、`tests/approval-rules-test.mjs`（自定義規則協議面）、`tests/unit/approval-rules.test.ts`（匹配引擎單測）、`tests/unit/tool-approval.test.ts`（檔位與三檔判定）。

### 待答問卷進快照（重連恢復對話方塊）

`question_pending` 是即時通道：只推給「提問那一刻線上」的連線，重新整理頁面 / WS 重連 / 新標籤頁都收不到那條歷史訊息，而服務端還在阻塞等人回答——面板會憑空消失（`QuestionDialog` 沒有別的入口）。因此待答問卷同時掛在快照上（`UiState.pendingQuestion`，標準引擎按對話過濾：`pendingQuestionForSnapshot()` 只帶當前對話的那張，切回原對話會重推快照；DSH 的提問橋是 runtime 級的，不分對話）。前端 `use-chat.ts` 收到 `snapshot` / `snapshot_delta` 時用純函式 `web/src/pending-question.ts` 的 `resolvePendingQuestion` 決定面板去留：快照有待答問卷就恢復（已答過的 id 跳過——回答訊息與在途快照會交錯），但只有「由快照恢復出來的」面板才接受快照收起（避免一張回答之前的舊快照把剛由即時通道彈出的面板閃掉）。單測 `tests/unit/pending-question.test.ts`。

### 後臺任務列表

bash 工具執行前後各拍一次監聽快照（`snapshotListeningPorts`，Windows netstat / POSIX lsof），diff 出的新增 LISTENING 程序記入 `bgServers`（埠→pid→since→name，name 經 `lookupProcessName` tasklist/ps 盡力獲取），啟動後 notice 提示「可在頂欄「後臺任務」裡單獨停止或全部關閉」；**列表按客戶端持久**（ClientSession 欄位，非對話級）——對話結束/切換/斷線重連都不消失（attachSink 重推 `bg_servers`），只有任務被停或程序自行退出才移除（30s 定時器 `refreshBgServers` 重新對埠快照，port+pid 都匹配才算還活著，靜默剔除死項）。

**自動清理遺留例項**（面板底部「自動清理遺留」下拉 + 「立即清理」）：閾值檔位 `0/15/30/60/120` 分鐘（`ClientSettings.bgAutoCleanupMin`，**預設 0 = 關**），同一個 30s 定時器裡實時讀設定 → `BgServerTracker.cleanStale(thresholdMs)`：先 `verifyBeforeKill` 複核埠→pid 歸屬（不對就剔條目，**絕不對陌生程序開殺**），再按 `staleLeftovers()`（純函式，單測覆蓋）挑出**未釘住**且 `now - since >= 閾值` 的條目 → `killPidTree` + 彙總 notice。面板每行可 📌 **釘住**（`set_bg_keep`）：釘住的永不參與自動清理（現場：除錯時故意留著的 dev server 不該被掃掉）。手動「立即清理」在閾值為關時用 30 分鐘兼底，訊息可帶 `minutes` 覆蓋（>0 生效）。外掛註冊的常駐任務（`registerBackgroundTask`）**不參與**自動清理——它們在宿主程序內，由外掛的 `stop` 回撥負責。迴歸：`tests/unit/bg-servers.test.ts` / `tests/bg-cleanup-test.mjs`。

**誤報過濾**（`BgServerTracker.filterAgentSpawned`）：埠 diff 只是候選，還需通過 `shouldTrackBackgroundServer` 判定才記入——① 程序名命中黑名單 `NON_AGENT_PROCESS_NAMES`（WeChat/QQ/Telegram 等桌面軟體）直接跳過；② 一次 PowerShell CIM / `ps -Ao pid=,ppid=` 批次拉全量父子對映，沿父鏈回溯：撞上伺服器程序（`process.pid`）或本次 diff 出的其他新 pid（bash 留下的中間層）→ 記錄；完整回溯到系統根（pid 0/1）未命中 → 桌面軟體自啟（如自己開的 Chrome，父鏈是 explorer），跳過；斷鏈（父已退出/reparent）→ 保守記錄。**Chrome 不進黑名單**：Playwright 等由 AI 拉起的瀏覽器父鏈能回溯到伺服器程序，與使用者自開的 Chrome（父鏈 explorer）區分開。

協議：`bg_servers`（ServerMessage，推送全量列表）/ `kill_background_server`（按埠停單個）/ `kill_background_servers`（全部關閉，`killAllBackgroundServers` 對每個 pid `killPidTree`，Windows `taskkill /F /T`）/ `list_bg_servers`（面板開啟時請求重新整理）；前端 `BgTasksModal`（每個任務行「停止」+ 底部「全部關閉」「重新整理」，空列表有佔位文案）。

### 只停止 bash 命令（對話繼續）

bash 工具卡片執行中顯示「停止」→ 發 `{ type: "abort_bash" }` → `ClientSession.abortBash()`。服務端用 **killable bash 工具**（`makeKillableBashTool`，經 `customTools` 按 name 覆蓋 SDK 內建 bash）：執行時把自己的 AbortController 註冊進客戶端級 `bashKills` 集合，abort 只殺這些 controller → bash 子程序程序樹被殺（工具拋 "Command aborted"，被 agent-loop 捕獲成工具錯誤結果）→ **agent run 與對話繼續**；與 SDK `session.abortBash()`（只對擴充套件 `executeBash` 路徑有效，agent 工具路徑無效）不同，這裡對對話中的 bash 工具呼叫真實生效。

命令被中止時 SDK 會把**終止前已輸出的內容拼接進工具錯誤結果**（AI 能看到輸出 + "Command aborted"）；隨後 `abortBash()` 再 `sendUserMessage` 注入「使用者手動停止」提示，讓 AI 明確知道是使用者手動而非失敗。

### edit 的 soft 引數（原 edit_soft 已合併進來）

內建 `edit` 要求 oldText 與檔案恰好匹配（含縮排/空白）。對縮排非語法意義的語言（如 JS/JSON），模型給出的 oldText 常與檔案差幾個空格/製表符而導致編輯失敗。pi-web-ui 經 `customTools` **覆蓋**內建 `edit`（`server/edit-tool.ts` 的 `makeEditToolDefinition`，包裝點仍是 `toolOverrideSpecs` 的 `composeEdit`），在 `path` / `edits` 之外只加一個引數 `soft`：

- 不給 `soft`：原樣轉發 SDK 實現（含它自帶的尾空白/全形字元寬鬆匹配），本宿主不重複實現精確匹配，兩邊不會漂移；提示詞 guideline 明寫「找不到文本就把同一處編輯換成 soft=true 重試」，模型一次自愈。
- `soft: true`：先試精確子串，失敗後按「逐行核心（trim）序列一致」做寬鬆匹配（忽略行首/行尾空白差異），命中後**整行原樣寫入 newText**（縮排即最終縮排）。僅唯一匹配才寫，重疊 edit 報錯，並參與同一個 per-file 變異佇列（`withFileMutationQueue`）。

`edit` 屬核心內建工具（`CORE_TOOL_CATALOG`），不是 `AGENT_TOOL_CATALOG` 裡的可開關項，因此沒有「寬鬆編輯」開關：`soft` 由模型按需傳。DSH 引擎不下發該引數。

**多 edit 必須按位置排序再逆序應用**（`applySoftEdits`）：所有 edit 都相對同一份原內容定位，得到各自的 `start/end` 後要**先按位置升序排**、再逆序套用，左側偏移才穩定。早期實現漏了排序，直接按 edits 的傳入順序逆序應用 —— 模型若把靠後的 edit 寫在前面，後面的替換先改變長度，前面的偏移隨即串位，寫出錯亂內容（歷史 bug：`protocol.ts` / `use-chat.ts` / `ChatInput.tsx` 被寫壞）。內建 `edit` 同樣是先按 `matchIndex` 排序（`edit-diff.js`），此處對齊。迴歸測試覆蓋全部 6 種排列。

**非法片段防禦**：寬鬆匹配要求 oldText 每行都是完整行。（a）精確命中若跨多行卻首/尾未落在行邊界（如 `a);\nfoo(`），直接子串替換會吃掉行首/行尾殘留寫出粘連內容（`foo(z();b);`）→ 拒絕並提示按整行給；（b）寬鬆階段整塊對不上、且首/尾行只是某行的一部分時，報「片段」錯而非籠統的「找不到」；（c）單行片段（如 `b();`）不改行結構，照舊支援。

`soft` 只在寬鬆分支生效（`applySoftEdits`）：SDK 的寬鬆匹配管不到**行首**縮排，這裡正好補上；非 soft 呼叫零額外開銷，也不改寫 SDK 會精確命中的區域。

### read 覆蓋：路徑是目錄時列出目錄條目（`server/read-tool.ts`）

SDK 內建 `read` 只處理檔案（`read("server")` 直接 `EISDIR: illegal operation on a directory`），SDK 自帶的 `ls` 又不在預設活躍集（`["read","bash","edit","write"]`）裡，模型要看一眼目錄只能改用 bash。pi-web-ui 因此經 `customTools` **按名覆蓋**內建 `read`（bash 覆蓋是先例）：用 `createReadToolDefinition(cwd)` 拿原實現當基底，`execute` 裡先判路徑是不是目錄 —— 是目錄就分流到 SDK 的 `createLsToolDefinition(cwd)`（一行一項、目錄帶 `/` 字尾、排序與條目/位元組截斷口徑與 SDK `ls` 完全一致），正文前置一行 `[Directory: <path>]`；其餘情況（檔案、圖片、路徑不存在、讀取報錯）原樣轉發基底，行為與內建一致。目錄分支裡 `limit` 是條目上限、`offset` 忽略。

開關 `readDirEnabled`（設定 → 工具頁首行，預設開）：這是**行為開關**（read 本體的開/關在設定頁「核心工具」區，走 ActiveSet；這裡管的是覆蓋層列舉目錄的行為，與 read 工具本體是否啟用無關），不是 ActiveSet 開關 —— 因此不進 `tool-manager.ts` 的 `AGENT_TOOL_CATALOG`，覆蓋定義每次呼叫即時讀設定（改動即時生效、無需 reload），也不進設定預設。DSH 引擎無 customTool 註冊面（工具來自 shipped preset），不支援該覆蓋，快照裡恆為 true。

引數上額外接受 `file_path` 作為 `path` 的別名（部分客戶端/模型習慣發 `file_path`）：schema 裡 `path` 仍必填，靠 `prepareArguments` 在校驗前把只有 `file_path` 的呼叫歸一成 `path`（兩者都給時 `path` 為準），轉發內建實現時也帶上歸一後的 `path`。前端工具卡頭的路徑提示（`web/src/tool-args.ts`）本來就同時認這兩個名（SDK 自帶 renderers 亦然）。

**基底也可能是第三方擴充套件註冊的 `read` 或 `bash`**：SDK 的合併鏈是 `[...擴充套件註冊的工具, ...customTools]` 逐個後寫贏，所以覆蓋層若直接進建立時的 `customTools` 就會**靜默頂掉**擴充套件的同名工具 —— 而官方 `docs/extensions.md` §Overriding Built-in Tools 明寫擴充套件可以覆蓋 `read`/`bash`/`edit`/`write` 等。因此 `bash` / `read` / `write` / `edit` 四處覆蓋**不在建立時註冊**，改由 `server/tool-overrides.ts` 在會話建好後注入，基底優先取擴充套件實現 —— 詳見下一節「覆蓋與第三方擴充套件同名工具共存」。

### 覆蓋與第三方擴充套件同名工具共存（`server/tool-overrides.ts`）

pi-web-ui 覆蓋了 SDK 內建 `bash` / `read` / `write` / `edit`。SDK 的登錄檔合併鏈是 `allCustomTools = [...擴充套件註冊的工具, ...customTools]` 再逐個 `definitionRegistry.set(name, …)` —— **後寫贏**：建立時把覆蓋塞進 `customTools`，等於讓 `docs/extensions.md`「擴充套件可覆蓋內建工具」那句承諾失效（第三方擴充套件的同名工具永遠輪不到，且審查/沙盒類擴充套件被徹底架空，例如 `@buyong/pi-codex-auto-review` 的 bash 審查完全不觸發，命令直接裸奔，issue #750）。

現在的做法：這四處核心覆蓋在**會話建好後**由 `installToolOverrides(session, specs)` 注入 —— 逐個按名字從 `session.extensionRunner.getAllRegisteredTools()` 取擴充套件實現當基底（取不到才用 pi-web-ui 自己的完整實現），交給 `composeWith` 裝飾後**前置**寫回 `session._customTools` 並 `_refreshToolRegistry()`（與外掛工具同步 `syncPluginToolsIntoSession` 同一手法）：

- `bash`：有擴充套件 bash → 保留擴充套件自身的一切定義與獨有引數（如審查引數 `sandbox_permissions`），外層包裹宿主硬安全閘門（目標審查回合只讀 / 審查者模式攔截 / 計劃模式硬閘門 / 沙箱越界硬圍欄 / 會話只讀許可權 / 審批規則引擎 / 外掛守衛），並橋接 `bashKills`（使 UI 中斷按鈕可中斷擴充套件內部命令）與 `applyHeadTail`；沒有 → 原生可中斷 bash 與 PTY 終端 bash 自適應分流（`makeAdaptiveBashTool`）。檢測到擴充套件接管時通過 notice 告知使用者終端接管已讓位。
- `read`：有擴充套件 read → `withReadDirSupport(擴充套件定義)` —— 基底的 name/label/描述/引數 schema/`prepareArguments`/render 槽位全部原樣保留，只補一句目錄說明、一條目錄指引與目錄分支（目錄分支仍復用 SDK `ls` 的排序/`/` 字尾/截斷口徑）；沒有 → `makeReadDirTool()`（內建基底 + 英文描述 + `file_path` 別名）。轉發基底時**不改寫擴充套件的引數**（`file_path` 歸一隻屬於內建那份，擴充套件自帶 `prepareArguments`）。
- `write` / `edit`：有擴充套件同名工具 → 把它的定義當權限沙箱包裝的**基底**（執行時先過只讀 / 工作區外攔截與審批，再委託擴充套件實現）；沒有 → 包裝 SDK 內建實現。

四條不變數：① 擴充套件那份實現的 schema / 描述 / prompt 指引 / 渲染不被替換（擴充套件獨有引數如 better-edit 的 `windows` 照舊可用）；② 覆蓋項前置 ⇒ pi-web-ui **外掛**註冊的同名工具（也是 customTools、比覆蓋層後寫）仍是最後贏家，與改動前的相對順序一致；③ 重複注入冪等（同名先剔除再前置）；④ 會話物件形狀不符（SDK 改私有欄位名）返回 `null`，按「覆蓋沒裝上」降級（等價改動前行為，不會更差）；`extensionRunner` 缺失時同樣退回內建基底。

`extractTargetPath()`（`server/approval-rules.ts`）：許可權沙箱與審批規則要按「目標檔案」判定，必須認三種寫法 —— SDK 內建用 `path`、`read` 有 `file_path` 別名、部分擴充套件（`pi-better-edit` 的 `edit`）用 `file`；只認 `path` 會在疊上擴充套件實現後取到空串、被判成工作區內而**靜默放行**。規則引擎的 `path` 欄位走同一個函式。

開關仍是行為開關（`readDirEnabled`），不進 `tool-manager.ts` 的 `AGENT_TOOL_CATALOG`；DSH 引擎無 customTool 註冊面，不接。工具定義提示詞遵循純英文約定（`tests/unit/tool-prompt-hygiene.test.ts`）。迴歸：`tests/unit/tool-overrides.test.ts`（基底解析 / 前置順序 / 冪等 / 降級）、`tests/unit/read-dir.test.ts`（`withReadDirSupport` 的 schema、描述、轉發與目錄分支）、`tests/unit/approval-rules.test.ts`（`extractTargetPath` 與規則欄位）。

### 審查者模式：自動委派（`server/delegate-mode.ts`）

「強制 AI 開持久子代理」的服務端實現，形態是**會話級開關 + 全自動路由 + 純委派閘門**（預設關）：

1. **自動路由**（`ClientSession.dispatchToDelegate`）：`prompt()` 一進來就問它要不要接管 —— 開著就把這條文本轉給**一個常駐落盤執行對話**（每會話一個，跨輪複用；與目標模式 2.0 的執行對話同一通道：`spawnSubagentConversation(..., persist=true)`，落盤、進歷史、可續聊）。首輪的 prompt 直接交給 spawn 起步，**之後**每輪才 `sendUserMessage` 追加（首輪再發一次會被 SDK 拒：`Agent is already processing a prompt`）。主對話這一輪**不跑模型**，只發一條 notice。執行對話跑完 → 主對話一條 notice（帶最後一條回覆摘要 + 左欄可開啟），**不做自動驗收**（v1 口徑：驗收由人/主對話下一輪做）。
2. **純委派閘門**（`withDelegationGate`，掛在與計劃模式同構的三處：customTools 整列 / `write`·`edit` 覆蓋 / 常駐終端 `checkSafety`）：寫類工具、非常規 bash（複用 `bashCommandIsReadOnly`）、**派發類工具**（`spawn`/`delegate_task`/`set_goal`/…）一律拒。派發類也拒的理由與計劃模式不同：那邊是「別繞開只讀約束」，這邊是「派活是服務端的活，別自己再開一份上下文」。
3. **軟約束**（`DELEGATION_SYSTEM_PROMPT`）：提示模型它是審查者、該幹什麼（定驗收標準 → 看 diff/測試 → 接受或提下一輪要求）。

**與計劃模式的優先順序**：計劃模式開著時**不自動派活**（計劃模式已把 spawn/旁路工具全拒，再自動派活就是死鎖），提示詞段也只注入一條 —— 計劃模式那一輪自己在主對話裡出計劃。DSH 引擎沒有 customTools 註冊面（閘門無處可掛）→ `setDelegateMode` 明確回 notice 拒絕，不靜默失敗。

狀態：布林隨會話轉錄落盤（customType `delegate/mode`，回放見 `readDelegateModeFromSession`）；**執行對話 id 不落盤** —— 它是本程序內的活物件，重啟後首條請求重建（寧可多一個執行對話，也別指向一個不存在的 id）。判定純函式（單測 `tests/unit/delegate-mode.test.ts`），端到端迴歸 `tests/delegate-mode-test.mjs`（零 token，已在 smoke ALL 列表）。

落盤執行對話持有普通對話 runtime，與目標模式的執行對話共用專案計數。預設不限數量；只有顯式配置 `PI_WEB_MAX_OPEN_CONVERSATIONS` 後，滿員時派活才會拋錯並提示關掉模式或先釋放名額。

### 計劃模式：只規劃不實施（`server/plan-mode.ts`）

目標條**展開行**裡有個 **計劃** 按鈕（`host:goal-plan` 槽位，DSH 引擎不渲染 —— 它沒有 customTools 註冊面，閘門無處可掛）。它經歷了兩次調整：① 從輸入框工具條的開關（`host:composer-plan`）搬進目標條 —— 語義是「拿你在這個框裡寫的輸入去做規劃」，與目標同屬一條線，所以只掛編輯行、**不進摺疊藥丸**；② 從「開關」改成**一次性動作** —— 點一下 = `set_plan_mode{true}`（開閘門）緊跟一條 `prompt`（把目標輸入當訊息直接發出去），兩條同 WS 按序到達 → 本輪就在閘門裡跑；輸入為空則只開閘門不發訊息。按鈕不再有 `active` / `aria-pressed` 常亮態，和同列的「提煉」「傳送」一個口徑：「點一下直接發」。目標模式被關掉（`goalModeEnabled=false`，整條目標區不渲染）時它也跟著一起隱藏。閘門本身仍是會話級、熱生效：開啟後**本對話只調研 + 出實施計劃，不做任何改動**，產物是 `plan_update` 步驟看板（PlanBoard）+ 計劃正文。**關閘門的唯一齣口是計劃看板裡的「開始實施」**（PlanBoard.tsx：`set_plan_mode{false}` + 發一條實施請求）—— 刪掉開關語義後必須補這個出口，否則進得去出不來。**與目標模式正交**：目標模式是「讓執行者把目標做完」，計劃模式是「先別動，把方案給我」。

兩層防護，缺一不可：

1. **硬閘門（`withPlanModeGate`，唯一的強制點）**：裝飾在工具定義外層、`execute` 之前判定一次，比許可權沙箱與外掛守衛更靠外。命中即返回 `isError` 的工具結果（`details.planModeDenied`），把「寫進計劃、等確認」的替代路徑回給模型。掛載點三處：① 整列 `customTools`（含 bash 覆蓋、`patch`、`eval`、子代理派發與排程工具）；② `installToolOverrides` 注入的 `write` / `edit`（`toolOverrideSpecs` 的 `composeWrite`/`composeEdit`，`edit` 自身帶 `soft` 引數）；③ 常駐終端工具的 `checkSafety`。關閉時只多一層布林判斷。
2. **軟約束（`PLAN_MODE_SYSTEM_PROMPT`）**：`appendSystemPromptOverride` 按當前會話狀態追加一段純英文硬規則，切換開關時 `session.reload()` 重建，下一輪即生效。這段提示詞真正的載荷是兩條：
   - **禁程式碼傾倒**（`## Output shape` 段）：`NEVER write the implementation` —— 不貼整檔案、不貼完整函式、不給「成品版程式碼」，只描述改哪些檔案、結構、關鍵決策、風險、驗證方式與第一步；程式碼只允許「棘手處的短片段（~20 行、至多兩處）」。**這條是硬閘門的補丁**：閘門讓模型寫不出檔案，模型就會把整份實現當正文吐出來（燒 token 又沒落地，實報過一次「讓它寫單頁貪吃蛇，上來就貼幾百行原始碼」）。注意迴歸：提示詞段內禁中文（`tests/unit/plan-mode.test.ts` 有 CJK 斷言，寫「開始實施」這類 UI 字樣要改寫英文）。
   - **小需求走短計劃**（`## Plan board` 段）：只有「3+ 步或有真未知」才先 `plan_update` 列 pending 步驟；「寫個單頁貪吃蛇」這類小而明確的需求**跳過看板**，直接給短計劃（要動哪些檔案 / 結構 / 驗收 / 第一步），省一輪工具往返。

   提示詞正文可在**設定面板 → 提示詞 → 計劃模式提示詞**改：`planModePromptMode`（append/replace）+ `planModePrompt`（自定義正文），語義同視覺橋 / AI 提交資訊（空自定義 = 內建預設，replace 下輸入框預填內建預設供直接改），`buildPlanModePrompt` 純函式拼裝（單測覆蓋三種組合）。**只改提示詞，硬閘門不受影響** —— 服務端只讀約束永遠生效。該項不進設定預設（同 scmCommitMsgPrompt）。

判定純函式（單測 `tests/unit/plan-mode.test.ts`）：`planModeDenial(toolName, params)` 分三類 —— **寫類工具**（`write`/`edit`/`patch`/`rm`/`git` 等名單）直拒；**bash 只讀白名單**（`splitShellSegments` 按 `;`/`&&`/`||`/`|` 切段，每段都要過：禁重定向 / 命令替換 / 後臺 / heredoc，命令在白名單內，`git` 只放 `status|diff|log|show|blame|…` 等只讀子命令，直譯器只放行 `--version`/`--help`）—— 刻意保守，寧可拒一次讓模型換命令；**旁路工具**（`spawn` / `delegate_task` / `set_goal` / 排程等）也拒：閘門是**會話級**的，子代理對話的 `planMode` 是 false，放行等於留後門。

狀態隨會話轉錄落盤（`plan/mode` 自定義條目，回放見 `readPlanModeFromSession`，與 `permission/preset` 同口徑），切會話/過載恢復；快照欄位 `UiState.planMode` 恆給布林（用 `undefined` 會在 `snapshot_delta` 裡丟鍵，前端 spread 合併會殘留上一對話的 `true`）。已知邊界：外掛 / MCP 自帶工具不經這三處掛載點，只受軟約束約束。迴歸：`tests/plan-mode-test.mjs`（零 token：開關快照 / 寫類被拒 / bash 讀寫分流 / 關閉後恢復 / 轉錄落盤）。

### 模型操作瀏覽器頁面（`browser_page` 工具）

讓模型直接讀/操作你在瀏覽器裡開啟的頁面（詳見 `plugins/page-picker/README.md` 的「AI 操作頁面」）。
**四段鏈路**，缺一段都不通：

```
模型 ── browser_page 工具（server/agent-service.ts makeBrowserPageTool）
  │   引數：op（pages/read/click/type/scroll/goto/wait/eval）+ target/origin + 各動作引數
  ▼
ClientSession.pageCall()  ── 發 page_request（帶 id + timeoutMs，預設 30s/上限 120s，**有空閒超時**）
  │   沒有「人類在等」，所以不進看門狗豁免；前端不線上時直接給可執行的錯（“開啟 pi-web-ui 頁面”）
  ▼
瀏覽器裡的 pi-web-ui 頁面 ── use-chat.ts 收到 page_request → 宿主橋 `window.__piWebUiHost.pageCall()`
  │   （web/src/plugin-host.ts 的 `pageCall()`，宿主 API 自 v3 引入、當前 v11；橋不在就給一句“裝/啟用 page-picker 並重新整理本頁”）
  ▼
page-picker 擴充套件 ── content script → service worker → chrome.scripting.executeScript(world:MAIN)
  │   准入：sender.tab.url 必須是「已綁服務地址的 pi-web-ui 頁面」+ 目標在擴充套件的授權列表裡 + op 過白名單
  ▼
目標頁面 ── 內建動作（read/click/type/...）在頁面主世界裡執行，結果原路回到模型（page_response）
```

**為什麼另一端固定是 pi-web-ui 頁面**：擴充套件只能被瀏覽器裡的東西調（模型在服務端程序裡），而
`window.__piWebUiHost` 是現成的、已認證的頁面內橋（外掛系統用了同一套）。代價：那個標籤頁得開著；
好處：服務端零新增監聽、天然複用登入態，而且**人類看得見模型在動哪個瀏覽器**。

**協議**：`page_request`（server→client，`op` 由擴充套件解釋、服務端只透傳）/ `page_response`（client→server）。
不進快照（沒有要人回答的東西；重新整理即這次呼叫失敗）—— 與 `question_pending` 的區別就在這。

**引用到對話（人在環中的入口）**：`web/src/components/BrowserControl.tsx` 把已授權頁面做成
「網頁引用」附件（`mode:"page"`，`path` = 頁面 origin、`name` = 標題）；**只授權一個頁面時頂欄按鈕直接
變成該頁面標題**（點主體=引用、右側 ▾ =打開面板），多個頁面時面板裡每項都有「引用到對話」。
服務端 `attachments.ts` 對 `mode:"page"` **不 stat / 不讀檔案**，只給模型一句 `<browser-page url title>`：
「這個頁面已授權，用 `browser_page`、`target=<origin>`」—— 使用者不必在話裡手打網址。
**截圖**（`op:"shot"`）不走頁面執行：`captureVisibleTab` 只能截活動標籤頁，且只認 `<all_urls>`
或 activeTab（普通 host 授權不夠）—— 所以擴充套件先切頁、截、裁（`planCrop`）、**切回**，並且
需要使用者在擴充套件裡額外授一次「所有網站」許可權。圖片回給模型有兩條路：主模型能識圖就在**工具結果裡**
直接帶 image block（當輪可見）；純文本模型走 `ClientSession.transcribeToolImage()` → 視覺橋轉寫成
文字證據（與使用者附件同一套選擇邏輯與提示詞）。

**閘門全在擴充套件側**（授權表 + 白名單 + 總開關 + eval 開關）：服務端不做動作白名單，否則
「擴充套件能做什麼」就散落在兩處了。

**入口在網頁側**（頂欄「瀏覽器」按鈕 + `web/src/browser-control.ts` + `BrowserControl.tsx`）：
能力在擴充套件裡，網頁只能做三件事 —— 報狀態（擴充套件動作 `status`）、把人送到擴充套件設定頁
（動作 `openOptions`，因為網頁不能自己導航到 `chrome-extension://`）、給可照抄的例子。
狀態是**按需查詢**（不進快照流）：掛載後查一次 + 打開面板時重新整理 + 45s 輪詢。
模型在目標頁面上動手時，頁面右下角會閃一條「AI 正在操作本頁」的提示（掛 shadow DOM、
pointer-events:none、2.2s 淡出），避免使用者以為頁面自己在動。迴歸：`tests/unit/browser-page-tool.test.ts`、
`tests/unit/page-picker-ai-ops.test.ts`、`tests/page-picker-bridge-test.mjs`、`tests/page-picker-edge-ext-test.mjs`。

### 擴充套件 UI 橋

擴充套件的 `setWidget/setStatus/notify/select/confirm/input` → `widgets/statuses/notice/dialog` 訊息；對話方塊經 `dialog_response` 回傳，Esc 視為取消。`Dialog.tsx`（擴充套件對話方塊）與 `QuestionDialog.tsx`（共用模型問卷）的正文/選項/詳情/預覽都走 `Markdown(rawHtml)` 富渲染（markdown + 原始 HTML 混排，模型自選、信任模型；預設 `rawHtml=false` 的聊天正文渲染不受影響），可選項 `preview` 展示「選項預覽」框。

`snapshot` 裡 `streamingMessage` 是進行中的訊息（60ms 粒度流式），`messages` 是已落盤的。

### Durable 引擎的資料來源：只認 AgentEvent，不讀 `pi.live` 槽位（`server/durable/durable-event-projector.ts`）

Pi Durable（`@earendil-works/pi-durable`）把同一件事分成兩份投影，**職責不能混**：

- `pi.live`（`conv.watch()`）是**廉價可剪的執行期進度投影**：工具槽位只有 `running` 期間帶 `output`，結算即被剪掉；
  槽位**從不攜帶 `input`**（模型發起呼叫的入參在工具任務的 `state.checkpoint` 裡）。因此抓槽位拿不到入參、也拿不到回執。
- `watchEvents(harness, conversationId, ctx)` 才是權威事件流：`tool_execution_start.args`（引擎已從 checkpoint 解析好，
  巢狀呼叫直接給槽位的 `arguments`）、`tool_execution_end.entry`（模型呼叫，`model[0]` 是 ToolResultMessage）或
  `.result`（巢狀呼叫）、`message_start/message_update/message_end`（正文與思考）、`tool_execution_update`（進度輸出）。

歷史坑（#774）：驅動曾對 `pi.live` 做差分，讀 `slot.input`（永不存在）與結算後的 `slot.output`（已剪），
導致工具卡命令空、結果空，並同鏈路汙染落盤會話（`argumentsText: "{}"`）。現在全部改由 `DurableEventProjector`
投影事件流：按 `contentIndex` 記賬已下發的正文/思考長度（流式增量與最終整段落盤不重複不丟字），
工具回執「成功只帶 `output`、失敗只帶 `error`」向下遊對齊；巢狀呼叫（`parentToolCallId`）不單獨出卡片，
保住「一個父呼叫一張卡」的展示口徑。迴歸：`tests/unit/durable-event-projector.test.ts`（含驅動不得再讀 `slot.input/slot.output` 的守衛）。

### Correlated host conversation creation

Host startChat/openSession sends new_chat with an optional requestId and waits for new_chat_result carrying the same requestId and the exact conversationId captured by the engine on creation/reuse. Rejection, missing ACK or timeout cancels prompt delivery; observing an unrelated conversation switch is never sufficient. Older clients may omit requestId. Prompts may include targetConversationId (the UI conversationId, not the SDK sessionId); dispatch rejects a mismatch against activeConversationId before synchronously entering prompt. Engines capture the conversation before awaits and reject stale targets before entering streaming state.

Device center setup keeps remote read-only guidance available when local pairing APIs are forbidden. Setup metadata restores installed URLs; unsuccessful status queries do not imply absence. Installed but unhealthy or unowned centers show CLI diagnostics rather than reinstalling. Installation continues on the server when the page is left; reopening and reloading metadata restores progress and pairing actions.
