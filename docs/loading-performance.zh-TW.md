[English](./loading-performance.en.md) · [简体中文](./loading-performance.md) · **繁體中文**

# 資源與歷史對話載入最佳化

## 首屏按需載入

`web/src/App.tsx` 使用動態匯入載入終端、Git 面板、畫布、設定、模型管理、檔案預覽、後臺任務、全域性搜尋和 TUI 彈窗。

`DeferredMount` 在檢視首次啟用前不掛載其子元件，因此不會觸發 React lazy 的下載。啟用後保持掛載，沿用外層隱藏容器及檢視的 active 屬性，保留終端、畫布和搜尋狀態。不能只用 CSS 隱藏 lazy 元件：隱藏的掛載仍然觸發下載。

TUI 通過 `tui-overlay-bridge.ts` 在程式碼下載期間按順序緩衝 ANSI 輸出，上限為 1,048,576 個 JavaScript 字元。新彈窗和關閉事件清除緩衝；掛載後請求服務端重新渲染完整螢幕，補償超過緩衝預算的輸出。即時幀繼續走橋接，不進入 React 快照。

## 歷史轉錄修復

`server/compaction-markers.ts` 的環檢測為已完成路徑建立集合。後續節點抵達已完成路徑即可停止，避免健康長鏈反覆向根回溯，將此步驟從 O(N²) 降到 O(N)，額外空間 O(N)。其他轉錄解析與 SDK 初始化成本仍然存在。

測試對照舊演算法窮舉 1,296 種四節點父圖，驗證斷環位置和統計一致；長鏈通過 Map 查詢次數上界檢查複雜度，不依賴不穩定的機器耗時閾值。

## 構建驗證

本次在同一工作區、同一 Vite 配置下對比原版和修改後的 `App.tsx`，構建至獨立目錄，不覆蓋 `web/dist`。統計 HTML 直接引用的入口 JS、modulepreload JS 和 CSS；每個檔案單獨 gzip 後求和。

| 指標                        |      原版 |  最佳化後 |         變化 |
| --------------------------- | --------: | --------: | -----------: |
| HTML 首屏引用資源原始體積   | 3,453 KiB | 2,468 KiB |       -28.5% |
| HTML 首屏引用資源 gzip 體積 |   950 KiB |   675 KiB |       -28.9% |
| HTML 直接引用資源數         |         8 |        11 |           +3 |
| 首屏 xterm JS/CSS           |        有 |        無 | 改為按需載入 |

這是構建資源預算，未計外掛執行時請求、字型等資源，也不是端到端載入耗時。共享依賴拆分會增加少量請求，終端、畫布和設定首次使用時需要下載各自程式碼。基礎 Markdown 仍屬於首屏依賴。現有構建仍有大 chunk 警告。

## 第二輪：公式資源與工具輸出

KaTeX 渲染器和 CSS 通過獨立 `math` 分包按內容載入。基礎 Markdown 和數學語法解析仍同步可用；含 `$`、反斜線、`math` 字樣或啟用 rawHtml 的內容會保守觸發請求，`disableMath` 禁止載入和公式排版。載入期間顯示基礎正文與公式原始碼，載入完成後共享訂閱通知已掛載訊息恢復公式。併發請求合併，失敗保留基礎正文，不自動迴圈重試。

第二輪使用同一配置分別構建至獨立目錄，首屏 JS/CSS 原始體積從 2,468 KiB 降至 2,185 KiB，gzip 從 675 KiB 降至 593 KiB（再減約 12%）；相對最初 950 KiB 累計減少約 38%。公式分包不在初始 HTML 的 preload 或樣式表引用中。遇到候選內容時瀏覽器仍會請求公式資源，因此上述預算代表無需公式時的初始引用體積。

獨立 Chrome + Vite 測試入口驗證了普通正文和 disableMath 不請求公式資源、首次公式非同步載入並恢復排版，以及 rawHtml 的指令碼與事件屬性仍被淨化。驗證使用臨時入口和獨立埠，未訪問使用者瀏覽器或執行中的服務。這驗證功能與請求時機，不代表生產環境載入秒數。

`server/serialize.ts` 的工具結果不再先 join 全部文本再截斷，而是在 100,000 個 UTF-16 碼元預算內拼接。分隔符、空段、截斷標記和圖片佔位語義保持不變；文本超限後仍處理後續圖片。此最佳化減少超大輸出的臨時字串分配，不改變完整轉錄或模型上下文。

## 第三輪：歷史列表和流式快照

`filterForkedParentSessions` 使用反向父關係和從葉節點出發的佇列，替代固定點演算法的反覆全圖掃描，複雜度為 O(V+E)。保留記錄順序、路徑歸一化、重複路徑、自引用、純環及陣列引用語義。測試在兩種記錄順序下對照舊演算法窮舉 4,096 種四節點關係圖，並以操作計數驗證長鏈線性增長。

流式助手快照原來先呼叫完整訊息序列化，再重新轉換一次 streaming content。現在共用助手後設資料裝配，只執行一次內容轉換；仍保留流式不完整 marker 清理及穩定訊息 ID。包含 `toJSON` 計數的測試防止工具引數恢復成雙重轉換。

可重複 CPU 基準：`node --import tsx scripts/benchmark-loading.mjs`。指令碼僅使用合成數據，不讀取使用者歷史或啟動服務。一次本機 Node v25.9.0 的中位數結果：

| 合成場景                   |     原演算法 |  最佳化後 |
| -------------------------- | -----------: | --------: |
| 512 節點 fork 鏈           |     5.661 ms |  1.291 ms |
| 2,048 節點 fork 鏈         |    71.937 ms |  3.761 ms |
| 8,192 節點 fork 鏈         | 1,548.894 ms | 14.819 ms |
| 100 次較大流式助手訊息轉換 |    17.837 ms |  9.284 ms |

fork 基準的舊演算法針對預歸一化單鏈重現原固定點傳播，不包含路徑歸一化成本；流式舊路徑對無 marker 的相同內容轉換兩次。結果用於說明演算法規模趨勢，不是完整會話載入時間，機器與併發負載會影響數值。

## 第四輪：歷史開啟分段診斷與分支解析快取

設定 `PI_WEB_LOAD_TIMING=1` 後重啟服務，開啟歷史對話時服務端控制台輸出 `[load-timing]` JSON。預設關閉，關閉時不讀時鐘、不生成階段陣列。記錄 outcome（loaded/reused/stopped/error）、totalMs 及 stages，各階段 ms 為距離上個標記的增量：

- `resolve-and-ownership`：路徑定位、歸屬檢查和進入讀取前的排程等待。
- `repair` / `sdk-open` / `branch-calibration`：轉錄修復、SDK 檔案開啟和分支校準。
- `preview`：預覽提取、推送和預覽後的排程等待。現有載入流程已經提供正文預覽。
- `runtime-init` / `bind-session`：執行環境建立、會話切換準備和繫結。
- `workspace-and-settings`：工作區跟隨和設定等同步呼叫。
- `snapshot-send`：服務端快照構造和同步傳送呼叫，不含網路送達、客戶端反序列化或繪製。

日誌不包含會話路徑、ID、正文，也不持久化額外的會話資料。複用、攔截和失敗路徑也有總耗時；尚未到達的階段不會出現。這些是服務端觀測值，不能直接當作點選到正文可見的時間。

`findBranchCandidates` 在每次呼叫內按節點物件快取時間戳解析，避免多個葉子重複解析共同祖先。600 層共享鏈、80 個葉子的測試中，候選生成與葉子選擇各自的 Date.parse 呼叫從 48,160 降至 680（約 -98.6%）。快取不會跨呼叫保留，修改過的節點下次分析仍會重新讀取。路徑遍歷、統計和全部 pathIds 的輸出仍按各分支深度之和增長，整體未改成線性演算法。

後續應結合這些日誌與瀏覽器效能記錄，分別測量冷啟動、快取命中、歷史對話開啟和已開啟對話切換；目前沒有宣稱端到端秒數收益，也沒有修改會話預覽協議。

## 第五輪：左欄渲染與會話列表掃描

- **左欄不再隨流式 token 重渲染**：`LeftPanel` 是 `memo` 元件，但 App 傳入內聯 `onOpenSandboxModal` 箭頭函式，每個 `message_delta` 都讓整棵專案樹重新協調。改為 `useCallback`；`transition` 只傳 `kind/target/progress` 的穩定子集，預覽訊息等欄位變化不再波及左欄。
- **專案樹資料模型 memo 化**：每專案的執行對話篩選、歷史會話歸屬、未讀統計從 JSX 內的 IIFE 抽到 `projectTreeModel`（`useMemo`）。執行對話按專案一次分桶；"是否有子代理" 用父 id 集合；"是否已落盤" 用按需構建的 sessionId 集合，替代 O(對話×會話) 的巢狀 `some`。`isSessionMatchingProject` 按專案快取正則與規範化結果，不再逐會話 `new RegExp`。
- **切專案少一次整表請求**：點專案標題只發 `set_cwd`，由服務端 `refreshSessionsOnSwitch` 推送列表；展開專案時的 `list_sessions` 移出 state updater（StrictMode 下 updater 會執行兩次）。
- **懸空工具呼叫修復加健康指紋快取**：`healDanglingToolCallFile` 每次開啟歷史對話都同步整檔案讀取並逐行 `JSON.parse`，且此前沒有快取；現與 `repairSessionFile` 一樣按 `mtimeMs:size` 記住健康檔案，未變化時跳過讀盤。
- **列表模式提前停止解析**：`loadSessionInfos(cwd, { listOnly: true })` 按 mtime 新→舊解析，湊夠 260 條本專案會話即停（左欄展示 200 條，餘量給 fork 父會話過濾）；快取命中的檔案照常納入。冷列表成本從「專案內全部轉錄位元組」降為「最新約 260 個檔案」。快取條目帶 `complete` 標記，全文搜尋、按 id 定位等需要全集的呼叫不會複用不完整快取。單檔案元資訊 LRU 由 512 提至 2048，避免來回展開多個專案時互相擠出、反覆全量重解析。
- **列表推送瘦身**：`SessionSummary.firstMessage` / `displayName` 截斷到 300 字元（首條訊息常是大段貼上，原先每次推送 ×200 行 ×2 份）。全文檢索走 `search_sessions`，不受影響。

測試：`tests/unit/dangling-tools.test.ts`（健康快取命中與檔案變化後重檢）、`tests/unit/session-cache-bounds.test.ts`（列表模式提前停止、全集請求不復用不完整快取）。

## 第六輪：開啟歷史對話的預處理與執行對話名額

### 預處理合併為一次非同步讀盤

`server/transcript-prepare.ts` 的 `prepareTranscriptForOpen` 替代原來的「鏈修復 + 懸空呼叫修復」兩段同步流程：

- 兩份健康指紋（`mtimeMs:size`）都命中：不讀盤。
- 否則 `fs.promises.readFile` 讀一次，兩項檢查共用文本；修復結束後按最終檔案狀態重新整理兩份指紋（懸空修復追加合成結果後，下次開啟仍命中）。
- 懸空檢查改為按需解析（`healDanglingToolCallsInText`）：先只取每行 id/parentId（長行只掃行首、且要求在第一個巢狀 `{` 之前），沿 parentId 從尾部回溯，只完整解析經過的行和尾部 assistant 之後的行。`lastId` 從尾部逐行完整解析確認，崩潰殘留的半截尾行不會被誤認。
- 語義與原流程一致：鏈修復改寫檔案時本次不做懸空修復；400 個隨機轉錄（分支、aborted/error、長行、半截尾行）上與原全量演算法結果逐一相同（`tests/unit/transcript-prepare.test.ts`）。

合成轉錄基準（`node --import tsx scripts/benchmark-transcript-open.mjs <MB>`，本機 Node v26.13.0，7 次中位數）：

| 場景                                 |   10 MB |    50 MB |
| ------------------------------------ | ------: | -------: |
| 懸空檢查：原逐行完整解析             | 24.7 ms | 218.2 ms |
| 懸空檢查：按需解析                   |  7.8 ms |  62.9 ms |
| 開啟預處理：原兩次同步讀（均無快取） | 71.2 ms | 514.5 ms |
| 開啟預處理：新，指紋未命中           | 51.5 ms | 360.9 ms |
| 開啟預處理：新，指紋命中             | 0.28 ms |  0.27 ms |

上游原流程的鏈修復有指紋快取、懸空檢查沒有，所以「再次開啟同一個未變化的大轉錄」原先仍要同步整讀 + 逐行解析（10 MB 約 30 ms、50 MB 約 250 ms，期間阻塞所有客戶端），現在約 0.3 ms。冷路徑剩餘耗時主要是 `repairSessionTranscript` 的 CPU 計算；SDK `SessionManager.open` 仍會再同步讀一次（待評估能否傳入已解析條目）。

### 執行對話名額：按 LRU 收起只查看過的歷史對話

- 從歷史開啟的對話標記為 `viewOnly`；在其中發訊息（開始投遞 / 重試）即清除。
- 開啟歷史對話時，名額預檢移到構建 agent runtime **之前**：原先達上限要先完整構建 runtime（擴充套件、技能、MCP）再 dispose，白白耗時。
- 超額時按 `lastActiveAt` 從舊到新收起 `viewOnly` 對話（不收當前對話、釘住、流式/壓縮/投遞中、終端在用、有存活子代理、有後臺 run/喚醒訂閱/後臺任務的對話），仍騰不出才拒絕；收起會提示具體對話，轉錄在磁碟上，可從歷史重新開啟。新建對話走同一邏輯。
- 當前對話隨後會被切走釋放時（`wouldDisplaceActive`，與 `displaceActive` 共用 `isRetainedOnDisplace` 判定）計入一個名額；該判定只在確實超額時才評估（涉及磁碟探測）。

測試：`tests/unit/open-conversation-lru.test.ts`。

## 第七輪：預覽→快照不再重掛載訊息列表

開啟歷史會話時，瀏覽器先收到 16 條預覽訊息，runtime 建好後再收到首個快照。原先這兩步的 `MessageList` key 不同（`transition.target` → `conversationId`），整列解除安裝重掛：滾動、實測高度、視窗化狀態全部丟失，尾部 Markdown 渲染兩遍，肉眼可見一次閃爍。而且即便 key 相同，預覽訊息的 id（`seq = 偏移 + i`）也與快照（每對話計數器）對不上，React 仍會重掛這些節點。

- **服務端：預覽使用快照同款 id。** `previewWithSnapshotIds` 對 `buildSessionContext().messages`（SDK 正是用它初始化 `agent.state.messages`）加 `withHistoricalCompactions`（與 `messagesOf` 共用），走同一個 `uiMessageKey`，只序列化尾部。使用者訊息 seq 按全序列精確計算。建好對話後 `seedConversationIds` 把 `msgIds/nextMsgId` 與尾部序列化結果寫入對話，首個快照直接命中快取，尾部不再重複序列化。`msgIds` 按內容鍵對映，擴充套件在 bind 時追加訊息也不改變已有 id。管理器不支援 `buildSessionContext` 時回退舊預覽、不下發種子。
- **協議：** `transition_progress` 新增可選 `conversationId` / `sessionFile`（預分配的對話 id，僅在 id 一致時下發），`PROTOCOL_VERSION` 43 → 44。
- **客戶端：** 預覽態用預分配 id 作 key 與 `conversationId`，與快照相同，同一個 `MessageList` 例項原地接收快照。`MessageList` 用渲染期派生 state 識別交接（StrictMode 安全）：按會話首幀口徑為更早訊息預置佔位、重置分頁視窗（預覽裡已顯示的尾部保持可見），且交接時預覽中已掛載的訊息不判為佔位，由隨後的 sweep 按實測高度決定。原地重置時受管元素表改為「只剔除不存在的 id」，不再整表清空（穩定 ref 回撥不會為原地保留的節點重新註冊）。

測試：`tests/unit/preview-snapshot-ids.test.ts`（預覽 id 與快照一致、種子不改變任何 id、同時間戳使用者訊息、歷史壓縮卡、system 訊息、回退路徑）；`tests/unit/message-list-preview-handoff.test.ts`（jsdom：交接後尾部 16 條零解除安裝、DOM 節點為同一例項，更早訊息未全量掛載；對照組換 key 時整列重掛）。

尚未在真實瀏覽器裡對大會話做端到端驗證（滾動位置與圖片/程式碼高亮的滯後高度），需要人工確認。

## 第八輪：左欄互動體驗

- **專案排序**：每次載入（重新整理頁面）按最近使用（`lastUsed`）新→舊排序；頁面開啟期間保持穩定（切換工作區不跳動），會話期間新出現的專案追加到末尾。可拖拽專案頭或在專案頭上按 Alt+↑/↓ 調整本次會話內的順序。廢棄原 `pi-web-ui:projects-order` 持久化排位（載入時清理殘留鍵）。
- **專案上限**：最近專案由 30 提到 100（`RECENT_PROJECTS_MAX`，記錄、合併讀取、推送共用；DSH 引擎同步）。
- **最近專案發現**：`pushProjects` 冷啟動先等待現有的會話頭輕量發現，再讀取持久化列表，確保僅存在於歷史會話中的工作區也出現在首份推送中。掃描單飛，60 秒內複用發現快取；過期後後臺續期，熱請求仍讀取當前持久化列表，保留新專案及刪除墓碑。迴歸：`tests/left-panel-delete-test.mjs`。
- **歷史最近專案遷移**：舊 per-client 記錄的清理不能丟失其專案。`ClientStateStore.load()` 首次載入先彙總所有 client 的墓碑，再將全域性與舊 per-client 專案按 `normalizePathKey` 去重、取最新 `lastUsed`，過濾全部墓碑並降序截斷至 `RECENT_PROJECTS_MAX`，最後清理死 client 並一併儲存。即使舊 client 已超過 30 天保留期或數量上限，其專案仍可跨重啟保留；後續 `remember()` 同時寫入全域性列表，定期清理沿用原期限，無需每次掃描磁碟歷史。迴歸：`tests/unit/client-state-cleanup.test.ts`、`tests/unit/client-state-recent-projects.test.ts`（過期 client 遷移與重啟、墓碑不復活、去重排序與上限）。
- **過濾框**：專案區頂部過濾專案名 / 路徑 / 已載入的對話標題；專案名命中照常顯示，否則只顯示命中的對話並展開；Esc 清空，↓ 進入列表。未載入會話列表的專案（未展開且無快取）只能按專案名命中，全文檢索仍走全域性搜尋。
- **鍵盤與無障礙**：`role="tree"` / `treeitem` + `aria-expanded` / `aria-current`；↑/↓ 行間移動、Home/End、→/← 展開收起、會話行 ← 回到專案頭。重新命名時行主體渲染為 div（不再把 input 嵌進 button）；「顯示更多」「已收起 N 條歷史」改為 button；僅懸停可見的行內操作在鍵盤聚焦時同樣顯示，並有 `:focus-visible` 描邊。
- **重新命名**：失焦即提交（原先失焦直接丟棄輸入）；提交後立即樂觀顯示新名字，服務端列表體現後撤銷覆蓋（10s 兜底過期）；Enter 後解除安裝觸發的 blur 不重複提交，Esc 取消不提交。
- **i18n**：左欄硬編碼中文（顯示更多、已收起、分支 / 排程 / 微信 / 飛書 / 釘釘徽標、電腦端開啟提示）移入字典並補齊 12 個語言包；三處重複的標題分類邏輯合併為 `categorizeTitle`。
- **執行列表推送**：`emitConversations` 每次對每條對話的 `existsSync + statSync` 改為一次 `statSync` 並按檔案快取 2s（保持同步傳送，不改變與快照的訊息先後順序）。

測試：`tests/unit/left-panel-stage-d.test.ts`（排序 / 拖拽 / Alt+方向鍵、過濾、鍵盤導航、tree 語義、重新命名失焦提交與去重）。

## 第九輪：會話列表掃描（位元組級 + 增量）與流式過濾器

### 列表元資訊：`server/session-list-scan.ts`

`scanSessionListInfo` 取代列表模式的 `parseSessionInfoFast` 實現（後者列表模式直接委託給它，全文模式不變）：

- 按位元組讀取、按換行位元組切行；已拿到 id 與首條使用者訊息後的長行（> 512 位元組、不含 `"session_info"`）不解碼成字串，只看行首判斷 message 並用 `Buffer.indexOf` 找第一個數值型 `"timestamp"`，規則與原實現一致。
- 需要完整解析、且超過 64K 字元的行先剔除內嵌 `"data":"…"`（base64 圖片）再 `JSON.parse`。
- **增量**：狀態記錄最後一個完整行之後的位元組偏移，以及檔案頭 128 位元組和偏移前 64 位元組兩處指紋。`loadSessionInfos` 把狀態存進單檔案元資訊快取；檔案 mtime/size 變化時帶著狀態續掃，兩處指紋都未變才只解析新增位元組，否則整份重掃（鏈修復改寫、截斷等）。末尾未寫完的半行計入本次結果但不推進偏移。
- 等價性：300 個隨機轉錄（長行、base64 圖片、改名、壞行、CRLF、末尾半行）上與原實現逐欄位相同（`tests/unit/session-list-scan.test.ts`，含增量 / 改寫 / 截斷 / 半行用例）。

合成轉錄基準（`node --import tsx scripts/benchmark-session-list.mjs <MB>`，本機 Node v26.13.0，5 次中位數）：

| 場景                          |    10 MB |      50 MB |
| ----------------------------- | -------: | ---------: |
| 原實現（逐字元過濾 + 字串行） | 259.6 ms | 1,328.8 ms |
| 位元組級全量掃描              |  44.0 ms |   208.7 ms |
| 追加一輪對話後增量續掃        |  1.58 ms |    1.88 ms |

活躍會話每輪結束都會讓列表重新整理重掃它；原先這一步隨轉錄大小線性增長，現在與已有長度無關。

### 流式過濾器：`BinaryStringFilter`

`sessionLines`（全文搜尋等仍走它）裡剔除 base64 的過濾器原為逐字元狀態機（每字元一次陣列 push、字串外每字元一次正則）。改為正則跳躍：字串內直接跳到下一個引號 / 轉義 / 換行，字串外跳到下一個非空白字元，普通字元整段切片輸出；狀態轉移不變。2,000 個隨機 JSONL 文本、隨機分塊（含切在轉義符、引號、代理對中間）上與原實現輸出逐位元組相同（`tests/unit/session-scan-filter.test.ts`）。10 MB 文本過濾：391.0 ms → 95.2 ms。

## 第十輪：開啟會話不再阻塞事件迴圈；會話列表服務端分頁

### 非同步分時片開啟（`server/session-open.ts`）

`switchSession` 裡的 `SessionManager.open`（同步 readSync 讀完整個轉錄 + 同步逐行 JSON.parse）改為 `openSessionManagerAsync`：`fs.promises.readFile` 非同步讀取，逐行解析每約 8 ms 讓出一次事件迴圈，再把解析好的條目交給 SDK 構造。SDK 本身在超大頭部時也走這條 `preloadedFileEntries` 構造路徑。

- 語義對齊 SDK `loadEntriesFromFile`：空行和壞行跳過，只收真值條目；首條必須是帶字串 id 的 session 頭，否則交回 SDK 原路徑（空檔案初始化、非 pi 會話報錯）；檔案末尾缺換行時在構造前補 `"\n"`。
- SDK 建構函式在型別上是 private：按執行時簽名呼叫，構造後核驗會話檔案、會話 id、條目數；任何一步不符或拋錯都回退 `SessionManager.open`。`PI_WEB_ASYNC_SESSION_OPEN=0` 可強制原路徑。已核對自帶 SDK 1.1.0 與本機全域性 1.5.0 的簽名相同，兩者都走預解析路徑（0 次回退），結果與 `SessionManager.open` 一致（條目、葉子、分支、檔案副作用）。
- 合成 50 MB 轉錄（`node --import tsx scripts/benchmark-session-open.mjs 50`，3 次中位數）：

|                           | 總耗時 | 事件迴圈最長停頓 |
| ------------------------- | -----: | ---------------: |
| `SessionManager.open`     | 192 ms |           192 ms |
| `openSessionManagerAsync` | 239 ms |            21 ms |

總 CPU 略增，但開啟大會話期間其他客戶端的流式輸出、心跳和操作不再被卡住。

### 會話列表分頁（B5）

- 協議（均為可選、向後相容；本批已 bump 到 v44）：`list_sessions` 加 `limit`（希望拿到的總條數），`sessions` 加 `hasMore`。
- 服務端按專案記住 `limit`（`setSessionListLimit`，夾在 [`SESSION_LIST_MIN = 20`, `SESSION_LIST_MAX = 5000`]），之後每輪對話後的自動重新整理沿用它，已展開的列表不會縮回。`loadSessionInfos` 的列表模式按 `SESSION_LIST_PARSE_LIMIT + (limit - SESSION_LIST_DEFAULT)` 提前停止解析：預設口徑仍是 260 個檔案，而首屏只要 20 條時只需掃 80 個。快取記錄這份列表是按多少條的需求解析的（`parsedFor`），需求更大時不復用。`hasMore` = 摘要多於 limit，或解析提前停止（還有未解析的舊檔案）。
- 客戶端：reducer 按專案記錄 `projectSessionsHasMore`。「顯示更多」在本地餘量用完、且服務端還有更多時，以下一頁的 limit 請求，按鈕顯示載入態。每個專案預設只渲染 `SESSION_ROWS_DEFAULT = 5` 條歷史會話，每點一次「顯示更多」多 `SESSION_ROWS_STEP = 10` 條；展開條數只活在本頁記憶體裡（舊版的 `pi-web-ui:lp-visible-counts` 持久化已廢棄並在載入時清除），重新整理頁面一律回到 5 條，不會把上次展開的幾十上百條原樣恢復。
- 首屏請求就是 `SESSION_LIST_FIRST_PAGE = 20`（= 服務端下限），比渲染的 5 條多要一些當本地餘量：下一次「顯示更多」不必再跑一輪網路 + 磁碟掃描。已展開到很多條的專案重掛載時，請求量跟著當前展開數走（`visible + 10`），列表不會縮回去。

測試：`tests/unit/session-open-async.test.ts`（與 `SessionManager.open` 逐項一致、預解析路徑不回退、可繼續追加寫入、非法 / 空檔案回退、開關、解析期間讓出事件迴圈）；`tests/unit/session-list-paging.test.ts`（翻頁、hasMore、limit 記憶與夾取（含下限）、reducer）；`tests/unit/left-panel-stage-d.test.ts` 新增 B5 用例（向服務端翻頁與載入態、本地餘量不發請求、重新整理不繼承舊條數）。

### 會話列表磁碟索引（`server/session-list-index.ts`）

列表要在每個專案裡找出「最新的 N 條」，原實現只能把最新的 260 個 `.jsonl` 整個掃一遍。本機 pi-web-ui 專案（1883 個會話檔案 / 1.5 GB，最新 260 個 275 MB）實測：冷啟動 readdir + stat 29 ms、掃描 463 ms，而真正展示的只有前幾屏。

- 索引把「檔案 mtime + size + 掃描狀態」落盤到 `<dataDir>/cache/session-list-index/<sha1(專案目錄)>.json`，命中就跳過整份檔案掃描。有效性判定與記憶體快取同一把尺子：**mtime 和 size 都沒變才認**（改名 / 壓縮 / 重寫都會改這兩者）。
- 純快取：刪掉、損壞、寫失敗都只是下次重掃，不影響任何會話資料；沒有 `dataDir`（無狀態儲存）時整套自動關閉。
- 存的就是 `SessionListScanState`，所以它同時是增量續掃的偏移：重啟後追加過的大會話從上次偏移接著讀（`previousScan`），簽名不符時 `scanSessionListInfo` 自己退回全掃。
- 單專案上限 3000 條 / 4 MiB（超了只留最新 1000 條），寫盤去抖 500 ms、原子替換；一輪列舉結束後按實際存在的檔案修剪（列舉不完整時只跳過修剪，不誤刪）；專案不再開啟的舊索引檔案超過 30 天、啟動後清一次（每次最多 20 個）。
- 列表摘要只建 `limit + 1` 條（命中索引後 `infos` 可能是專案全量），不再對上千條全建一遍再切。

實測（同目錄，首次請求 20 條 / 解析 80 個檔案）：

| 場景                      | readdir + stat |   掃描 |   合計 |
| ------------------------- | -------------: | -----: | -----: |
| 老口徑（解析最新 260 個） |          25 ms | 463 ms | 488 ms |
| 首屏 20 條（解析 80 個）  |          29 ms | 161 ms | 190 ms |
| 重啟後命中磁碟索引        |          20 ms |   4 ms |  24 ms |

測試：`tests/unit/session-list-index.test.ts`（落盤後重啟免解析：內容被換掉但 mtime + size 不變仍給出原元資訊；檔案變了才重掃；增量續掃補齊條數；刪檔案後條目消失；無 dataDir 時不落盤）。
