[English](./architecture-plugins.en.md) · [简体中文](./architecture-plugins.md) · **繁體中文**

# 外掛系統

語音引擎只向服務端 `host.tts.registerEngine()` 註冊，系統播報、QQ 與其他工具統一通過 `host.tts` 呼叫。瀏覽器 `ttsProviders` 僅保留中心目錄的只讀入口，詳見 [`architecture-tts.md`](architecture-tts.md)。

> 可選介面元件，存放在 `<dataDir>/plugins/`。不裝即不存在，attach 時熱重掃。

## GitHub 日常工作臺

`plugins/github-workbench/`（官方 catalog，v0.1.3）通過 `rightpanel.tabs` 在右側「檔案列表」旁提供帶 GitHub SVG 圖示的「工作臺」Tab，與當前對話並排使用，複用服務機器的 `gh` 登入。窄側欄採用列表／詳情切換，容器寬度 ≥480px 時並排展示，型別分段按鈕和可展開搜尋適配側欄寬度；樣式統一使用宿主主題變數。Tab 解除安裝時只保留記憶體中的篩選、頁碼、選中項、滾動位置和分條目評論草稿，切回可恢復，重新整理頁面／過載外掛後清空。讀取請求隨解除安裝取消；在途寫入等待完成，跨掛載共享提交鎖，避免重複評論。倉庫自動識別與個人待辦可獨立使用；倉庫待辦、待我評審、分配給我、我建立的、提到我、自定義搜尋均按更新時間分頁。詳情展示正文、最近一頁評論及 PR 分支／合併狀態／改動統計，支援引用到當前對話草稿、評論、關閉／重新開啟。「引用到對話」與「交給 AI 處理」均只新增簡短引用附件（型別、編號、倉庫、連結），由使用者填寫處理要求併發送，已有正文和附件保留，同一引用自動去重。完整 diff、CI 與程式碼行評審由 GitHub 連結檢視，AI 可按使用者要求獲取最新資訊。

事實源：`plugins/github-workbench/index.mjs`（非同步 `gh api` 與已鑑權 HTTP 路由）、`client/entry.mjs`（Shadow DOM 工作臺、Tab 狀態恢復及宿主 `compose` 引用附件橋）、`client/styles.mjs`（主題與容器自適應樣式）、`manifest.json`；安裝與搜尋語法見[外掛 README](../plugins/github-workbench/README.md)。路由只包含 `/status`、`/items`、`/detail`、`/comment`、`/state`，寫請求固定引數並以 JSON stdin 傳內容，無 shell。所有外部文本轉義，輸入／輸出／分頁／超時有上限；外掛解除安裝終止後端子程序，Tab 切換取消讀取，過期詳情響應不覆蓋新選擇，失敗評論保留草稿，避免重複提交。客戶端從 bundle URL 保留部署根路徑；僅支援 github.com。定向守衛：`tests/unit/github-workbench.test.ts`、`tests/unit/github-workbench-client.test.ts`。

## 圖片預覽與 OCR 提供者

宿主橋 API v15 新增 `host.openImagePreview({src, alt?, onSaveAnnotation?, actions?})` 與 `host.imageOcrProviders.register({id, label, labelEn?, recognize})`。`recognize({src, signal, onProgress})` 返回 `Promise<{text:string}>`；進度為 0–1。註冊返回登出函式，`list()` 僅返回 id/顯示名。`onSaveAnnotation(dataUrl)` 僅在呼叫方能接收標註結果時提供，儲存回撥成功後關閉預覽。`actions` 可傳 `{id,label,onSelect,closeOnSelect?}` 在統一工具欄保留呼叫方的操作；圖片工作臺生圖畫廊用它保留編輯、參考圖、複製路徑、下載，刪除舊的獨立燈箱；舊宿主缺少橋 API 時回退新視窗原圖。

`web/src/image-ocr-providers.ts` 是客戶端 OCR 註冊單源，註冊歸屬載入時的外掛作用域；`plugin-loader.ts` 在停用/解除安裝、過載紀元變化和載入失敗時清理提供者；停用移除 bundle 時遞增匯入快取鹽，確保同一紀元重新啟用也會執行頂層註冊，避免命中 ESM 快取後提供者無法恢復。正在載入的已停用外掛不能遲到註冊或重新進入已載入集合。共用 `ImageLightbox` 訂閱該登錄檔並管理取消與遲到結果，外掛不得忽略取消訊號。`plugins/image-ocr` 以 `preload:true` 的無檢視外掛提供本地中英文識別，真正的引擎/字型檔懶載入，外層 Worker 的終止同時結束初始化與識別的子 Worker。首次使用需聯網取得程式/字型檔，圖片不上傳至識別服務。

預覽裡的 OCR 按鈕始終可見；提供者缺失時，宿主複用現有外掛安裝後臺作業安裝官方外掛，停用的外掛走設定啟用，安裝進度/錯誤保留在當前預覽。完整入口和待發附件標註邊界見 [`architecture-attachments.md`](architecture-attachments.md#統一圖片預覽ocr-與附件標註)。

## 生命週期約束

外掛管理器按代次區分 activating、loaded 與失效例項；reload 合併併發請求，立即撤銷在途啟用已註冊的副作用。舊啟用恢復後只能清理自身，不能回寫新代次的登錄檔；失效 host 禁止繼續註冊，遲到非同步資源也必須回收。工具同步的已應用名稱集合屬於每個 SDK session，不能放在跨會話共享的單一集合中。

官方 live-preview 的隔離與專用訪問路徑見 [附件架構](architecture-attachments.md#活動內容隔離)。官方 SFTP 與遠端工作區複用 `plugin-sdk/ssh-host-trust.mjs`，未知/變更主機金鑰拒絕連線，可信配置見 [環境變數](env-vars.md#ssh-主機身份驗證)。

## MCP 專案執行時

`server/mcp-project-runtime.ts` 的 registry 按規範化絕對 cwd 建立獨立 `McpBridge` 和配置 watcher；bridge 的 cwd 建立後不再改寫。SDK 會話建立先等待專案初始化，工具快照與後續同步按穩定 `conversation.cwd` 選擇；DSH provider 顯式傳入自身 cwd。外掛 `host.mcp` 在非同步操作入口捕獲 cwd。

全域性配置共享磁碟檔案，不共享連線例項：全域性管理操作重新整理所有已建立專案，專案操作只重新整理所屬專案，外部檔案儲存由各專案 watcher 處理。初始化、reload 和銷燬均保留所屬 entry 身份；reload 排在初始 load 後，關閉時先停 watcher、關閉 bridge，再等待在途操作清理。工具變化同步已有會話並重新應用門控，同時重新整理對應專案客戶端的 MCP 列表和設定。

**資源生命週期**：每個專案各有一份 bridge 和 watcher，連線數量是保留專案有效伺服器數之和（全域性伺服器也按專案各建連線）。registry 每分鐘按最近訪問順序檢查，空閒超過 5 分鐘、沒有任何 Pi/DSH 保留會話引用且沒有在途初始化、reload 或建立租約的專案自動 `disposeProject(cwd)`。所有後臺、空閒與子代理會話都計入引用；所有權檢查缺失或失敗時保守保留。SDK 建立全過程持有租約，釋放時重新計時；watcher 與工具變更廣播不延長使用者空閒時間。沒有專案數硬限，保留會話本身仍可固定連線；關閉會話後才能進入回收條件。回收定時器 unref，server shutdown 清除定時器並統一銷燬、等待在途操作。

### MCP OAuth 登入

HTTP MCP 卡片的 OAuth 登入通過 `mcp_oauth_start {reqId,name,scope}` 發起；ClientSession 內的 `McpOAuthUi` 從捕獲的 cwd 解析精確作用域配置，呼叫 `mcp-oauth-login.ts`。`mcp_oauth_result` 只返回請求 ID、登入 ID、授權/回撥地址與狀態，不返回憑據或供應商原始錯誤。登入 ID 與請求 ID 均繫結發起客戶端，不能由其他客戶端完成或取消。

彈窗每 1.5 秒傳送 `mcp_oauth_status {reqId,id}` 觀察本機迴環自動回撥；遠端瀏覽器可以貼上完整跳轉地址併發送 `mcp_oauth_finish {reqId,id,redirectUrl}`。成功持久化後使用登入開始時捕獲的專案重新整理 registry 的所有已建立專案（憑據由 agentDir 共享），併發完成請求共用一次 reload。彈窗解除安裝傳送 `mcp_oauth_cancel {reqId}`，ClientSession 銷燬也會取消；啟動過程中取消會回收遲到的登入例項。完成記錄在下一次登入時回收，不佔滿客戶端的八個活動登入槽。

## 形態

一個外掛 = `<dataDir>/plugins/<id>/` 目錄：

- `manifest.json`（name/version/description）
- `index.mjs` 服務端入口（可選，`export default { activate(host) → deactivate? }`）
- `client/entry.mjs` 檢視入口（可選，`export default { mount(el, ctx) → cleanup? }`）

**客戶端依賴只能住在 `client/` 裡**：宿主只服務 `client/*` 子樹（見「靜態服務」），所以
`client/entry.mjs` 的相對 import 一旦解析到 `client/` 之外（典型：寫成了 `../sdk/index.mjs`），
瀏覽器會報 `Failed to fetch dynamically imported module` 並**整個 bundle 都不執行**（外掛頁空白，
而服務端毫無異常：manifest 校驗通過、`active:true`、`error:null`）。`plugin create` 生成的骨架
因此按執行環境複製 SDK：服務端 `sdk/` 含 `index.mjs`、`client.mjs`、`client-utils.mjs`、
`testing.mjs`；客戶端 `client/sdk/` 只複製 `client.mjs` 和 `client-utils.mjs`，另生成僅轉匯出
`./client.mjs` 的相容 `index.mjs`，保留既有客戶端匯入路徑。新模板直接匯入 `./sdk/client.mjs`，
測試模板匯入 `./sdk/testing.mjs`。生成後還跑一遍 `plugin-sdk/import-check.mjs` 報告越界/缺失
（迴歸：`tests/plugin-scaffold-test.mjs` + `tests/unit/plugin-import-check.test.ts`）。

`plugin-sdk/client.mjs` 是瀏覽器入口，匯出 `defineView`、`defineRenderer`、UI 輔助並轉匯出
`client-utils.mjs`；這兩個檔案及完整依賴閉包禁止任何 Node 內建模組匯入，也不包含測試 Harness。
`testing.mjs` 只供 Node 測試，匯出 `createMockHost`，直接使用 `node:path` 的 `resolve` / `sep`
解析本平臺路徑，不模擬其他平臺。服務端/相容總入口 `index.mjs` 匯出 `definePlugin`，同時轉匯出
客戶端及測試入口，因此舊服務端指令碼仍可全量匯入。型別入口為 `index.d.ts`、`client.d.ts`、
`testing.d.ts`（共用 `index.d.ts` 的介面宣告）；包子路徑為 `/client`、`/testing`。
守衛：`tests/unit/plugin-sdk-browser-safe.test.ts`、`plugin-host-primitives.test.ts`、`plugin-sdk-mock.test.ts`。

`SDK_VERSION` 定義在 `client.mjs`，與 SDK `package.json` 版本同步。`plugin upgrade-sdk` 分別按
服務端與客戶端清單補齊/重新整理檔案，支援舊版本從 `index.mjs` 讀版本，補建被客戶端引用但缺失的
`client/sdk/`，移除客戶端誤拷的 `testing.mjs` 並保留客戶端相容入口；重複升級應保持冪等。

**不裝即不存在**——目錄不在就沒有任何協議/UI 痕跡；attach 時重掃目錄，新丟進來的外掛無需重啟服務即出現在頂欄檢視 tab（import 每程序一次並快取；刪除目錄 → 下次 attach 反啟用）。

## 協議

| 方向 | 訊息                   | 作用                                                                                                                                                                                                                                                                                                                                                                                 |
| ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 上行 | `plugin_message`       | 路由到該外掛的 onMessage 處理器，回撥第二參為 clientId；未知/非法 id 靜默丟棄                                                                                                                                                                                                                                                                                                        |
| 上行 | `plugins_reload`       | 服務端熱過載：反啟用全部→重掃啟用→epoch+1→重推清單。**只給 `index.mjs` 的 import 加 `?e=<epoch>` 快取擊穿** —— 服務端入口若靜態 `import` 了自己的兄弟模組（如 `./lib.mjs`），那些模組會命中 Node ESM 模組快取，**改了不隨 reload 生效（必須重啟服務）**；想讓改動 reload 即生效就把純函式內聯進 `index.mjs`（客戶端 bundle 同理：走 `?e=` 重拉，但它 import 的兄弟檔案同樣會被快取） |
| 下行 | `plugins`              | attach 時推清單（plugins, epoch），epoch 用作前端 import 快取擊穿引數 `?e=`                                                                                                                                                                                                                                                                                                          |
| 下行 | `plugin_data`          | 預設廣播給所有 socket，前端按 pluginId 扇出給已載入檢視                                                                                                                                                                                                                                                                                                                              |
| 上行 | `plugin_path_response` | 使用者對 `plugin_path_request` 的答覆（id 回顯）；同意即寫進授權表                                                                                                                                                                                                                                                                                                                   |
| 上行 | `plugin_path_revoke`   | 撤銷授權：給 `pluginId` 清它的全部 / 給 `pluginId`+`path` 只清該目錄 / 都不給 = 清空整張表                                                                                                                                                                                                                                                                                           |
| 下行 | `plugin_path_request`  | 外掛要訪問工作區外目錄 → 瀏覽器確認彈窗（未答覆 120s 超時視為拒絕）                                                                                                                                                                                                                                                                                                                  |
| 下行 | `plugin_grants`        | 授權錶快照（attach 推 + 授權 / 撤銷後重推；設定面板「已授權目錄」段用）                                                                                                                                                                                                                                                                                                              |

## 宿主擴充套件點

| 方法                                      | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.notify(level, text)`                | 發系統通知條（notice，前端 toast）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `host.sendTo(clientId, payload)`          | 定向發給單個 socket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `host.onToolEvent(h)`                     | 訂閱 SDK 工具執行事件（phase:start\|end, toolName, conversationId?, toolCallId?, durationMs?, isError?）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `host.onToolPre(h)`                       | 工具 pre 攔截（僅 bash/read）：allow/deny（含原因給模型看）/ask（暫按拒絕執行）；首個阻斷勝出，拋錯/超時棄權；要 tools 族                                                                                                                                                                                                                                                                                                                                                                                                              |
| `host.onToolPost(h)`                      | 工具 post 編輯（僅 bash/read）：回 content 換正文（脫敏/改寫）、additionalContext 補上下文；逐個合併，拋錯跳過；要 tools 族                                                                                                                                                                                                                                                                                                                                                                                                            |
| `host.onRunEvent(h)`                      | 訂閱執行軌跡事件（run_start/message/tool_start/tool_end/turn_*/run_end，pi 引擎；軌跡/時間線外掛聚合「任務→思考→工具→檔案→結果」用，payload 已截斷封頂）                                                                                                                                                                                                                                                                                                                                                                               |
| `host.getActiveConversation(opts?)`       | 讀取對話快照（標題/訊息/流式訊息/統計——軌跡檢視直接顯示開啟對話的時間線；只讀引用，廣播前必須抽摘要，禁止原樣下發）。`{clientId}` = 該標籤頁正在看的對話（多標籤頁互不干擾），不傳 = 最近活躍的**非子代理**會話（子代理跑得再勤也不會把使用者正看的對話擠出去，見 `server/plugin-conversation-view.ts`）；快照帶 `clientId` / `isSubagent` / `sessionFile` 等欄位。⚠️ `conversationId` 是**每客戶端**分配的名稱空間（每個標籤頁都從 `c1` 起）——判定「是不是同一條對話」請看 `sessionFile`，跨標籤頁身份請用 `clientId` + `sessionFile` |
| `host.onConversationChanged(h)`           | 訂閱「當前開啟對話變了」（切歷史會話/切 running 對話/新對話/切專案——軌跡類外掛靠它重拉時間線，不等輪詢）                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `host.onClientModelChanged(h)`            | 訂閱「某客戶端對話的模型切換成功」（回撥收到切換後的快照，按 `clientId` 過濾即可只看本頁）；**只在模型真的變了時發**——重複點同一個模型 / 重連重放 `set_model` 不重複觸發，切換失敗不發（0.99 前只能靠輪詢快照的 `model` 變化）                                                                                                                                                                                                                                                                                                         |
| `host.registerAgentTool(tool)`            | 註冊供 AI 呼叫的工具，返回登出函式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `host.onAttach(h)`                        | 註冊「新客戶端接入」鉤子（每次瀏覽器 attach，含 plugins_reload 後的重接入）                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `host.registerCommand(cmd)`               | 註冊斜槓命令（SlashCommandInfo source=plugin → 選擇器 + prompt 攔截執行）                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `host.route(method, path, handler)`       | 掛載 HTTP 路由（`/plugins-api/:id/*`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `host.registerProxy(prefix, target)`      | 註冊通用反向代理字首：子路徑去字首透傳到 127.0.0.1:port（相對路徑/Range/SSE/ws 天然可用；目標鎖迴環防 SSRF；要 `http` 族；live-preview 用它實現 `/liveserver` + `/md` 預覽）                                                                                                                                                                                                                                                                                                                                                           |
| `host.fs`                                 | 檔案訪問：工作區相對（WorkspaceFS：`list/read/readText/write/remove` + `stat/mkdir/append/glob`，錨定活 cwd 根，越界拒絕）＋ 跨目錄 `requestAccess` / `authorizedDirs` / `listPath` / `readPath` / `readTextPath` / `writePath` / `removePath` / `statPath` / `mkdirPath` / `appendPath` / `globPath`（見「目錄授權與跨目錄 fs」）                                                                                                                                                                                                     |
| `host.ui.*`                               | 執行時註冊 / 更新 / 移除 UI 條目（`register` / `update` / `remove`）、`arrange` 整理其它條目、`list` 自查（見「UI 擴充套件點（slot 框架）」）                                                                                                                                                                                                                                                                                                                                                                                          |
| `host.project.create`                     | 在**已授權**目錄裡組裝專案（mkdir / clone / 寫檔案 / git init，見「專案組裝 API」）                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `host.llm.complete(req)`                  | 孤立無工具的一次性模型補全（總結/翻譯/分類，不建對話不進歷史；`{prompt, system?, model?, maxChars?, timeoutMs?, images?, signal?}` → `{ok, text?, model?, usage?, error?}`；要 `llm` 能力族，DSH 下回 `{ok:false}`）                                                                                                                                                                                                                                                                                                                   |
| `host.getSettings()`                      | 讀取宣告式設定（manifest.settings schema）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `host.onSettingsChanged(h)`               | 訂閱設定變更                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `host.registerBackgroundTask(task)`       | 註冊外掛常駐任務，併入頂欄「後臺任務」面板                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `host.leftPanel.setRunning(items, opts?)` | 左欄「執行的對話」裡登記外掛執行條目（僅展示，需要能力 `ui`）。整體替換本外掛條目並**同時作為心跳**；`opts.ttlMs` 預設 60 秒、夾取 5 秒–1 小時，超時沒有再次呼叫整組自動清空；反啟用自動清空                                                                                                                                                                                                                                                                                                                                           |
| `host.leftPanel.clear()`                  | 立即清空本外掛在左欄的執行條目                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `host.notifyCwd(cwd)`                     | 當主應用 set_cwd 成功後通知外掛（冪等去重，異常隔離）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 擴充套件 API（v2 新增）

> 並行任務在 `server/plugins.ts` 加宿主方法本體、在 `web/` 加渲染（plugin-host v8、
> 新 slot/kind、messageWidget）；本節只定「調什麼、要什麼許可權、拿不到回什麼」。
> 接線位置：`server/index.ts`「外掛擴充套件點 v2」塊（`(pm as any).xxx` 防禦性注入，
> PluginManager 無該欄位時賦值無害）+ `server/agent-service.ts` 的 `*ForPlugins`
> 只讀方法（複用現有邏輯組裝資料，不 emit 不改狀態）。DSH 引擎無這些方法，
> 一律走「無注入回退」列，絕不拋錯。

| API                                        | 一句話                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 門控（permissions 族）                     | 無注入回退                                                                                                                                                                                                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host.conversations.list()`                | 本客戶端執行中對話 + 當前專案歷史會話（`{id,title,cwd,kind,isStreaming}`，歷史最多 50）                                                                                                                                                                                                                                                                                                                                                                  | 無（只讀）                                 | 空陣列（外掛顯示空態）                                                                                                                                                                                                                                |
| `host.conversations.search(query, limit?)` | 複用 search_sessions 全文判定，回前 N 個 `{id,title}`                                                                                                                                                                                                                                                                                                                                                                                                    | 無（只讀）                                 | 空陣列                                                                                                                                                                                                                                                |
| `host.prompt(conversationId, text)`        | 向指定對話投遞 prompt（非當前對話先 switch 再走 prompt 全路徑；找不到對話回錯）                                                                                                                                                                                                                                                                                                                                                                          | `chat`                                     | `{ok:false,error}`（DSH 引擎亦如此）                                                                                                                                                                                                                  |
| `host.steer(conversationId, text)`         | 向指定對話注入轉向（`steerForPlugins`：本機直調 `sendUserMessage(text,{deliverAs:'steer'})`，跨客戶端經 `steerElsewhere` 鉤子）                                                                                                                                                                                                                                                                                                                          | `chat`                                     | `{ok:false,error}`（未知對話/空文本/DSH 時）                                                                                                                                                                                                          |
| `host.abortRun(conversationId)`            | 中止指定對話（複用 abort 的 interruptRun，卡住/空轉強制重置；未在跑冪等成功）                                                                                                                                                                                                                                                                                                                                                                            | `chat`                                     | `{ok:false,error:"not supported"}`（DSH/無客戶端時）                                                                                                                                                                                                  |
| `host.chat(req)`                           | 無頭投遞外部文本（`{text,accountId?,cwd?,conversationId?,model?,thinkingLevel?}`：conversationId 命中走 steer 投遞、miss 回落無頭；cwd 須存在且非系統目錄；模型/思考強度預切，失敗即拒絕）。回執帶穩定 `runId` 與 SDK `sessionId`：通道發起的輪次必須按 `runId` 認領 `onRunEvent`；已繫結通道會話中的網頁續聊可按穩定 `sessionId` 回傳，須校驗聯絡人和會話重置代次，不能憑區域性 `conversationId` 猜測。事件同樣攜帶 `sessionId`，過戶、改名不改變該身份 | `chat`                                     | 拋錯（宿主未接 chatProvider / DSH 引擎 / 校驗失敗時）                                                                                                                                                                                                 |
| `host.chatWait(...)`                       | 等一輪 run 結算再回                                                                                                                                                                                                                                                                                                                                                                                                                                      | `chat`                                     | `{ok:false}`（不等，由呼叫方超時兜底）                                                                                                                                                                                                                |
| `host.inbox.claim/complete/fail`           | 本地投遞賬本（至少一次 + 冪等鍵）：claim 冪等佔位、complete/fail 記賬、pending/dead 排障；跨重啟有效，不依賴裝置中心                                                                                                                                                                                                                                                                                                                                     | -（純本地記賬）                            | 無注入時 `claim` 恆返回 `new`（外掛自行回退記憶體去重）                                                                                                                                                                                               |
| `host.llm.complete(req)`                   | 孤立無工具的一次性補全（`{prompt,system?,model?,maxChars?,timeoutMs?,images?,signal?}` → `{ok,text?,model?,usage?,error?}`，不建對話；實現見 `server/plugin-llm.ts`，經 `completeForPlugins` + `llmProvider` 注入）                                                                                                                                                                                                                                      | `llm`                                      | `{ok:false,error}`（DSH 引擎亦如此）                                                                                                                                                                                                                  |
| `host.fs.watch(path, cb)`                  | 訂閱檔案變化（複用服務端 watcher）                                                                                                                                                                                                                                                                                                                                                                                                                       | `fs:read`                                  | 不回撥（靜默無事件）                                                                                                                                                                                                                                  |
| `host.scm(kind, opts?)`                    | 只讀 git 查詢（複用 server/scm.ts）                                                                                                                                                                                                                                                                                                                                                                                                                      | `fs:read`                                  | `{ok:false,error}`                                                                                                                                                                                                                                    |
| `host.bash(cmd, opts?)`                    | 跑一條服務端 shell                                                                                                                                                                                                                                                                                                                                                                                                                                       | `tools`                                    | `{ok:false,error:"not supported"}`                                                                                                                                                                                                                    |
| `host.schedule(spec, task, opts?)`         | 毫秒間隔或全 5 欄位 cron（`"0 9 * * *"`，伺服器本地時區）；`opts.persistent` 落盤 `<pluginDir>/schedules.json`，重啟後重調即重建（要合法 id；`catchUp:"once"` 補跑一次），自動進後臺任務面板                                                                                                                                                                                                                                                             | 無（直跑，見 `server/plugin-schedule.ts`） | —（非法形狀拋錯）                                                                                                                                                                                                                                     |
| `host.models.list()`                       | `{id,provider,vision}`（走快取目錄，不觸發網路 refresh）                                                                                                                                                                                                                                                                                                                                                                                                 | 無（只讀）                                 | 空陣列                                                                                                                                                                                                                                                |
| `host.onStats(cb)` / emitStats             | 會話統計推送（tokens/cost/contextUsage，見 `PluginStats`）                                                                                                                                                                                                                                                                                                                                                                                               | 無                                         | 不推送（外掛用快照 stats 兜底）                                                                                                                                                                                                                       |
| `host.onStreaming(cb)` / emitStreaming     | 流式增量推送                                                                                                                                                                                                                                                                                                                                                                                                                                             | 無                                         | 不推送（外掛輪詢快照兜底）                                                                                                                                                                                                                            |
| `host.events.emit/on(topic, payload)`      | 外掛間事件匯流排（`PluginBusEvent`，載荷 4KB 截斷）                                                                                                                                                                                                                                                                                                                                                                                                      | 無                                         | emit 丟棄、on 不回撥                                                                                                                                                                                                                                  |
| `host.net.fetch(url, opts?)`               | 出站網路（netAllowlist 全等/點號字尾命中才放）                                                                                                                                                                                                                                                                                                                                                                                                           | `net`                                      | 拒絕並報缺白名單/缺 net 族                                                                                                                                                                                                                            |
| `host.dialog.*`                            | select/confirm/input（對齊擴充套件 ui 橋）                                                                                                                                                                                                                                                                                                                                                                                                               | `ui`                                       | 拋錯拒絕（呼叫方回退 notice 提示使用者）                                                                                                                                                                                                              |
| `host.notifyAction(...)`                   | 通知條帶動作按鈕，點後回外掛                                                                                                                                                                                                                                                                                                                                                                                                                             | `ui`                                       | 退化成普通 notify（無按鈕）                                                                                                                                                                                                                           |
| `host.shortcuts.register(...)`             | 註冊快捷鍵（宿主負責衝突與展示）                                                                                                                                                                                                                                                                                                                                                                                                                         | `ui`                                       | 忽略註冊                                                                                                                                                                                                                                              |
| `host.searchProviders.register(...)`       | 全域性搜尋（Ctrl+K）結果提供方                                                                                                                                                                                                                                                                                                                                                                                                                           | `ui`                                       | 不搜（無該來源）                                                                                                                                                                                                                                      |
| `host.composerProviders.register(...)`     | `@` 提及提供方（宿主 API v9）：`search(q)` 回 `{title,hint?,text?,attachments?}`，選中後文本寫進游標處、附件進 chips                                                                                                                                                                                                                                                                                                                                     | `ui`                                       | 三個內建：檔案（`@` + 檔名 → reference chip，經 search_files）、已授權頁面（`@` + 標題/origin → `page` 網頁引用 chip，讀 page-picker 狀態快取）與技能（`@` 或 `@skill:` + 技能名 → `@skill:<name>` 詞元，供 Pi 執行時擴充套件提升為系統級工作流指令） |
| `host.onTheme(cb)`                         | 主題切換訂閱                                                                                                                                                                                                                                                                                                                                                                                                                                             | 無                                         | 不回撥（用首次下發主題）                                                                                                                                                                                                                              |
| 新 slot（`UiSlotId` 新增掛載點）           | 別名 + 列舉兩端同口徑（只改一邊 = 註冊了但介面上沒有，見常見坑）                                                                                                                                                                                                                                                                                                                                                                                         | `ui`                                       | 未知 slot 靜默丟棄（既有語義）                                                                                                                                                                                                                        |
| 新 kind（toggle/input/progress 等）        | 開關態/輸入值/進度經 `host.ui.update` 重新整理，progress 越界宿主鉗制（語義見 `tests/unit/plugin-extensions.test.ts`）                                                                                                                                                                                                                                                                                                                                   | `ui`                                       | 不認識的 kind 按預設 action 畫                                                                                                                                                                                                                        |
| messageWidget（plugin-fence 訊息級掛件）   | 在指定訊息下掛小部件（renderer 的訊息級形態，不共享 React 例項）                                                                                                                                                                                                                                                                                                                                                                                         | `ui`                                       | 不掛載（訊息原文不受影響）                                                                                                                                                                                                                            |

### 外部通道網頁續聊回傳

通道會話由聯絡人、群、頻道及執行緒的穩定作用域持有，網頁共享檢視不改變執行歸屬。通道發起的執行按回執 `runId` 認領；網頁主動發起且沒有通道執行標記的執行，必須先收到 `run_start`，再按已繫結的 SDK `sessionId` 收集最終助手正文並回傳原目的地。舊宿主只允許完整 `clientId + conversationId`，不得按裸 `c1` 猜測；未知 `runId` 不得借用會話繫結。結束事件重複到達不能重複投遞。

路由恢復須同時校驗通道賬號、目的地、會話重置代次；重置、退出賬號或切換作用域後舊繫結失效。工具呼叫前言不作為最終回覆，超時回執和早到事件仍按同一身份規則處理。平臺的 webhook、會話回覆視窗、主動傳送許可權繼續有效，失敗須誠實反饋。外掛及其路由輔助檔案保持獨立安裝，不依賴其他通道外掛目錄。

### 外部通道會話重置

微信、QQ、Telegram、Discord、Slack、Matrix、飛書、釘釘、企業微信、WhatsApp 和 iMessage 的 `/new`、`/clear`、`/reset` 共用各通道自己的會話切換流程。命令詞支援大小寫和全形形式；引數原文保留，重置命令後的提示詞直接進入新會話，不再次作為命令解析。已有數字快捷方式使用同一流程。

切換上下文必須同時輪換 `accountId` 中的會話代次並移除舊 `conversationId`，僅刪除本地對映不能保證宿主建立空白會話。微信、QQ 的顯式新建還須脫離舊網頁投遞繫結。工作區（`/cwd`、`/workspace`）、模型和思考強度的成功修改同樣切換上下文；無引數查詢保留當前上下文。

下載、排隊和 `host.chat` 請求持有啟動時的代次。重置後的遲到回執、結束事件和非同步設定驗證不得覆蓋新會話狀態；遲到的舊執行按真實 `runId` 中止。執行中不能切換的通道必須明確提示先停止，不能回報重置成功。歷史記錄保留，中止失敗須告知使用者。迴歸見 `tests/unit/channel-plugins.test.ts` 和各通道的行為、重置測試。

### 外掛目錄：程式碼是純快取，狀態獨立存放（`plugin-paths.ts`★ / `plugin-materialize.ts`★）

外掛在資料目錄裡拆成兩個互不干擾的根：

| 路徑                          | 內容                                                  | 可丟棄？                                        |
| ----------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| `<dataDir>/plugins/<id>/`     | 程式碼本體（manifest / index.mjs / client / 依賴）    | **可以**：隨包外掛可重放，`node_modules` 可重灌 |
| `<dataDir>/plugin-data/<id>/` | 狀態：`storage.json`、`secrets.bin`、`schedules.json` | **不可以**：使用者配置、渠道授權、定時任務進度  |

- 狀態路徑只走 `pluginStateDir()` / `pluginStateFile()`；老佈局（狀態住在程式碼目錄）在掃描/啟用時由
  `migratePluginState()` 冪等搬過去，兩邊都有時以狀態目錄為準（絕不拿舊副本覆蓋新狀態）。
- 程式碼目錄的物化由 `materializePlugin()` 負責，並留一份回執 `.pi-materialized.json`：
  **存在 ≠ 已準備** —— 回執登記的每個檔案都還在才算裝好；目錄在但缺回執/缺檔案 = 半殘，下次啟動就地補齊。
  新裝走 staging + rename 原子落盤，複製後驗收（`manifest.json` 在 + 檔案數 > 0）失敗就報錯，絕不簽收空目錄。
- 複製黑名單（`.git` / `node_modules` / `whisper-cache`）**只允許**在 `server/fs-copy.ts` 裡按
  **相對路徑**判定。歷史事故：三處各自拿 `cpSync` 的絕對路徑去匹配 `node_modules`，而 npm -g 安裝時
  包目錄本身就在 `…/node_modules/pi-web-ui` 下，整棵樹被過濾成空副本還被當成已安裝（issue #856）。
- 解除安裝會同時刪掉狀態目錄（重灌不闖回舊設定）；回滾只回滾程式碼，狀態不回滾。

### 宿主設施（plugin-facilities.ts）

| 設施         | 說明                                                                 |
| ------------ | -------------------------------------------------------------------- |
| `storage`    | `<dataDir>/plugin-data/<id>/storage.json` 原子 KV                    |
| `secrets`    | AES-256-GCM 加密機密，金鑰 `<dataDir>/secrets.key`，拷機 fail closed |
| `ensureDeps` | npm 自動補裝單飛                                                     |

### 宣告式設定（`secret` 型別 / `optionsFrom` 動態候選值）與外掛 SDK（plugin-sdk/）

- `settings` schema 第六種型別 `secret`：與 `password`（前端掩碼、明文存 storage.json）不同，
  `secret` 存加密 `secrets`（鍵 `setting:<key>`，明文永不落盤）。瀏覽器側 `settingsValues` 只看到
  有無（布林），外掛執行時 `getSettings()` 才拿到真值；儲存時空串 = 不改。`PluginSecrets`
  跨例項共享同一檔案快取（儲存與讀取走不同例項也不會讀到舊值）。
- `settings` schema 的 `select` 除了靜態 `options`，還可以寫 **`optionsFrom`** 讓宿主現算候選值
  （外掛不必自己維護會過期的清單）：`"models"` = 已配置鑑權的模型（值 `provider/id`，
  標籤同設定面板的模型選擇器）/ `"thinkingLevels"` = SDK 思考強度檔位（`off`…`max`，標籤走
  `thinking.<值>`）。兩者都會在最前面補一個空值選項 = **跟隨全域性預設**（外掛側拿到空串自行回落）；
  候選值在**瀏覽器側**算（`web/src/plugin-setting-options.ts`，模型清單來自 `UiSettingsState.subagentModels`），
  因此服務端**不校驗**帶 `optionsFrom` 欄位的值（只做 200 字元長度護欄），非法值由用的時候
  （如 `host.chat` 切模型）報錯；當前存值不在清單裡（模型被刪/手改過 storage.json）時也保留，
  不被下拉靜默吃掉。例：`wechat-ilink` 的「模型」「思考強度」即此兩源。
- 表單佈局：**單列行式**（標籤固定左列 + 控制元件右列，勾選框貼標籤，`hint` 常顯在標籤下的小字，
  ≤720px 上下堆疊），樣式全在 `web/src/styles.css` 的 `.plugin-settings-*` 段；渲染在
  `web/src/components/PluginSettingsForm.tsx`。欄位行帶 `data-key`（= schema 的 `key`），
  便於按欄位定位/除錯。
- `plugin-sdk/` 起手包：服務端總入口 `index.mjs`、瀏覽器入口 `client.mjs`、Node 測試入口
  `testing.mjs` 與各自型別入口；執行環境和複製邊界見上文「形態」，示例見 `plugin-sdk/README.md`。

### 外掛樣式與統一色彩契約（Plugin Style & Theme Contract）

所有掛載於宿主檢視、抽屜、浮層或插槽的外掛介面，必須遵循統一的主題色彩契約：

1. **統一繼承宿主 CSS 變數**：
   外掛掛載在宿主 DOM 樹中，全域性繼承 `:root` 主題令牌（`--bg`, `--bg-elev`, `--border`, `--text`, `--accent`, `--accent-contrast` 等）。每一項可附加合理硬編碼回退值保證無宿主時獨立開啟可用。
2. **實底配對反色令牌鐵律（杜絕打地鼠白底白字）**：
   - **強調色實底**：`background: var(--accent)` 必須且只能配對前景 `color: var(--accent-contrast, #fff)`；嚴禁硬編碼 `color: #fff`（在 `flow`/`wallpaper-flow` 等淺色/純白強調色主題下會變成白底白字隱形）；
   - **別名變數必須成對宣告**：外掛若因作用域隔離私設名稱空間變數（如 `--nt-accent`），**必須同時宣告** `--nt-accent-contrast: var(--accent-contrast, #fff)`，嚴禁只別名底色而漏掉前景反色；
   - **語義色實底**：`background: var(--green|--amber|--red|--blue)` 必須配對 `color: var(--on-green|--on-amber|--on-red|--on-blue)`；
   - **染色/半透明底**：使用 `--accent-soft` 或 `color-mix(...)` 底色的控制元件，前景跟隨常規正文色 `color: var(--text)`。
3. **推薦複用宿主元件基線**：
   宿主已全域性注入 `.btn` 和 `.btn.primary`（已內建對比度與 hover 濾鏡），主操作按鈕推薦優先複用宿主 `.btn.primary`，避免重複手寫。
4. **CI 靜態體檢硬攔截**：
   `tests/unit/accent-contrast.test.ts` 與 `tests/unit/semantic-contrast.test.ts` 會動態追溯所有內建外掛程式碼中的別名與字首變數，一旦出現未配對或硬編碼白字即刻紅牌阻斷。

### 能力宣告與強制（manifest.permissions）

宿主自控 API 按**能力族**強制攔截，未宣告的族拒絕並報「缺哪族」：

| 宣告族  | 覆蓋的宿主 API                                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs`    | `host.fs`（含跨目錄 `*Path` 族）與 `host.project.create`                                                                                                         |
| `ui`    | manifest `"ui"` 與 `host.ui.*`（未宣告 → 整份 `ui` 被忽略、執行時請求被拒）                                                                                      |
| `tools` | `host.registerAgentTool`                                                                                                                                         |
| `http`  | `host.route` + `host.registerProxy`                                                                                                                              |
| `chat`  | `host.chat`（無頭呼叫）                                                                                                                                          |
| `llm`   | `host.llm.complete`（孤立無工具補全；實現見 `server/plugin-llm.ts`，經 agent-service `completeForPlugins` + index.ts `llmProvider` 注入；DSH 下回 `{ok:false}`） |

`host.llm.supportsImages === true` 表示宿主支援圖片入參。`images?: Array<{data: string; mimeType: string}>` 使用標準帶 padding 的純 base64（不帶 data URL）；僅接受 JPEG/PNG/WebP，並校驗解碼簽名與 MIME 一致。最多 8 張，每張解碼後 ≤1 MiB，合計 ≤6 MiB；超限或無效輸入在建立 SDK 會話前拒絕。圖片通過 SDK `prompt(text, {images})` 傳入；當前模型不支援圖片時顯式返回 `{ok:false,error}`。可選 `signal?: AbortSignal` 僅用於宿主程序內取消，不經 JSON 傳輸；取消或超時會 abort/dispose 會話，成功或失敗均清除計時器。初始化期間取消後，遲到的會話也會回收；併發位保留到實際任務結束。

**嚴格模式** = 聲明瞭 `permissions` **或** `apiVersion >= 2`；**舊全權模式** = 未宣告 `permissions` 且
`apiVersion < 2`（放行但每啟用期警告一次「apiVersion 2 起將預設拒絕」）。宿主 API 版本
`PLUGIN_API_VERSION = 2`，`apiVersion` 高於它的外掛直接拒絕啟用並提示升級 pi-web-ui（而不是執行期
撞 undefined 介面）。

### 能力派生與新增族（v2）

- `fs:read` / `fs:write` 由 `fs` 派生：舊 `fs` 等價於讀寫全開（向後相容）；只宣告 `fs:read` → 跨目錄寫（`*Path` 寫族）與 `project.create` 被拒（讀放行）；只宣告 `fs:write` → 讀被拒。缺哪族報錯裡寫明哪族。
- `net` + `netAllowlist`：permissions 含 `net` 才可出站；manifest.netAllowlist 逐主機判定（全等或點號字尾，見 `tests/unit/plugin-extensions.test.ts` 的 hostMatches）；缺表/空表 = 全拒，未命中即拒。
- `dom:anchor`：僅限 anchors 掛載點的範圍 DOM（免使用者授權）；完整 `document` 仍需 `dom` + 使用者授權（見「特權 DOM 訪問」）——兩者是「範圍」與「整頁」之別。

## 可逆副作用（effect 棧，DSH 對照 P0-2）

外掛註冊的一切都是**可逆副作用**。宿主內部的 `PluginEffectStack`（`server/plugins.ts`，
匯出供單測）在外掛啟用期間收集每條註冊/訂閱的 disposer（帶 label），反啟用（停用 / 解除安裝 /
`plugins_reload` / 關機）時**逆序回捲**：

| 註冊面                                                                                                                                                                 | 棧裡記的 label                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `host.registerAgentTool`                                                                                                                                               | `agentTool:<name>`                                                           |
| `host.registerCommand`                                                                                                                                                 | `command:/<name>`                                                            |
| `host.route`                                                                                                                                                           | `route:<METHOD> <path>`                                                      |
| `host.registerProxy`                                                                                                                                                   | `proxy:<prefix>`                                                             |
| `host.fs.watch`                                                                                                                                                        | `watch:<relPath>`                                                            |
| `host.schedule`                                                                                                                                                        | `schedule:<id>`                                                              |
| `host.registerBackgroundTask`                                                                                                                                          | `bgTask:<id>`                                                                |
| `host.leftPanel.setRunning`                                                                                                                                            | `leftPanel`（反啟用時清空本外掛條目）                                        |
| `host.ui.register`                                                                                                                                                     | `ui:register(<ids>)`                                                         |
| `host.events.on` / `onStats` / `onStreaming` / `onSettingsChanged` / `onMessage` / `onToolEvent` / `onRunEvent` / `onAttach` / `onCwdChange` / `onConversationChanged` | 對應方法名                                                                   |
| `host.effect(label, dispose)`                                                                                                                                          | `plugin:<label>`（外掛**自建**的副作用：自建 interval / 監聽器 / WebSocket） |

語義細節：

- 外掛呼叫**返回的登出函式** = 只撤這一條（冪等）；不呼叫也無所謂 —— 反啟用會兜底。
- `release()` 逆序跑，**cleanup 拋錯只記一條診斷**（`pushRuntimeDiag`），不阻斷其它清理；
  返回失敗標籤列表供日誌。
- **啟用中途失敗**（`activate()` 拋錯）時，這一輪已登記的副作用先逆序撤乾淨，再落錯誤佔位行
  —— 半途註冊的工具/路由/定時器不會留給一個已經壞掉的外掛。
- `dispose()`（關機 / `reload()`）對每個外掛先回卷 effect 棧、再兜底清按 pluginId 索引的
  代理字首與後臺任務，最後清空全域性表。
- 單測：`tests/unit/plugin-effects-install-spec.test.ts`（逆序 / 冪等 / 拋錯隔離 / 真實
  `PluginManager` 反啟用後工具·命令·路由·匯流排訂閱·自建 effect 全回收，`effects.size` 歸零）。

## manifest 可選欄位

- `icon`（emoji/單字元，頂欄 tab 替代通用拼圖圖示）
- `iconSvg`（內聯 SVG 字串，有則優先於 `icon` 渲染：頂欄檢視 tab / 右欄 tab / 設定面板列表與市場都畫 SVG；服務端只做形狀校驗（`<svg…</svg>`、≤8KB、無 script/事件處理器，見 `server/icon-svg.ts`），前端渲染前再 sanitize 一次（見 `web/src/plugin-icon.tsx`）；`icon` 保留作舊版回落）
- `description`（設定面板裡的外掛介紹；檢視 tab 的懸浮提示只用外掛名，不用它）
- `version`
- `apiVersion`（與 `PLUGIN_API_VERSION` 比較，> 則拒絕啟用並提示升級）
- `permissions`（能力宣告陣列）
- `settings`（宣告式設定 schema → ⚙ 面板自動渲染表單）
- 使用者 overlay（P2-9，不在 manifest 裡）：`<dataDir>/plugin-overrides/<id>.json` 的 `settings` 節——三層合併 schema 預設 < overlay < 面板儲存值。overlay 是使用者釘住的新預設值（不 fork 改官方預設，更新不丟）；面板儲存永遠最高；secret 永不來自 overlay；壞鍵警告進診斷（`settingsSources` 標註每鍵來源 default/override/stored）
- `view`（布林，預設 `true`）：是否有獨立檢視 tab。**純 renderer 外掛寫 `false`**，
  前端不會急著載入它的 bundle，只在訊息裡命中圍欄時才懶載入
- `preload`（布林，預設 `false`）：`view:false` 時仍**每次進頁預載入** client bundle。
  給「沒有檢視 tab、但頂層程式碼必須一直跑」的外掛用（常駐浮窗、提醒輪詢、快捷鍵…）：
  這類外掛的 bundle 可以沒有 `export default { mount }`，頂層程式碼跑完就算載入成功；
  實現見 `web/src/plugin-loader.ts` 的 `preloaded` 集合（不進檢視登錄檔，因此不產生 tab）
- `renderers`（字串陣列）：該外掛能渲染的 fenced-code 語言（`"mermaid"` 等），
  與 `client/entry.mjs` 的 `default.renderers[lang]` 一一對應
- `ui`（物件）：外掛對宿主 UI 的**全部貢獻**（slot 條目 + `arrange` 整理意圖，見「UI 擴充套件點（slot 框架）」）；
  嚴格模式下需要 `permissions` 含 `ui` 族，否則整份忽略
- `build`（物件，可選）：原始碼安裝時的構建宣告（`{ install?, command, outputs? }`，見
  「原始碼安裝（--build）」）
- `netAllowlist`（字串陣列）：出站主機白名單（permissions 含 `net` 時生效，未命中即拒，空 = 全拒）
- `engines`（物件，如 `{"pi-web-ui": ">=1.2.0"}`）：引擎約束，不滿足即拒絕啟用；範圍支援 `>=`/`^`/精確，非法 range 放行（語義見 `tests/unit/plugin-extensions.test.ts` 的 satisfiesEngines）
- `peerPlugins`（字串陣列）：對等依賴的其它外掛 id，缺失只警告不斷活
- `requires`（物件，P2-8 硬依賴）：`{ hostApi?, families?, plugins? }`，任一條不滿足即拒絕啟用+教學式錯誤——`hostApi` 是宿主 API 下限（超前請升級）、`families` 須是已知族且須同時在自家 `permissions` 裡宣告、`plugins` 須已安裝且啟用成功。`ensureLoaded` 按依賴拓撲排序啟用（環直接拒），提供方被刪/失敗後消費方一併反啟用+留佔位（級聯一輪收斂，reload 重算重新整理）
- `agentToolsDefaultOn`（布林，預設 `false` 即預設關）：外掛 AI 工具是否預設進入對話。不寫就是預設關（新使用者出廠`disabledPluginTools`裡自帶，需手動開啟；隻影響新使用者與恢復預設，存量配置不動）；設為 `true` 即 opt-in 預設開。新增外掛工具必須同步加入出廠名單，否則守衛測試會紅（見 `tests/unit/plugin-tools-default-off.test.ts`）

## 外掛 AI 工具的可見性與開關

`host.registerAgentTool` 註冊的工具以前只進會話、對使用者不可見也不可關。現在兩處可看、
一處可關：設定 → 介面外掛裡每個外掛下展開自己的工具（名/label/description）並逐個開關；
設定 → 工具頁底部有按外掛分組的彙總區（同一開關）。實現：`UiPluginInfo.agentTools`
只讀快照（`plugins.ts:agentToolsSnapshot`，隨 `plugins` 清單下發，註冊/登出經 `pushToAll`
重新整理）；開關是全域性 `disabledPluginTools` 名單（`client-state` 持久化 + 預設隨行，未知條目保留，
重灌仍關閉；DSH 無外掛宿主，固定空陣列）。會話建立與 `syncPluginTools` 按名單過濾
（MCP 橋工具同管線、同名單），設定變更經 `refreshPluginTools` 推全部分會話、live 生效無需 reload。

## fenced-code 渲染外掛（renderer plugins）

> 讓訊息裡 ` ```lang ` 圍欄由外掛渲染成自定義 DOM（第一個實現：mermaid → SVG）。

**形態**：`manifest.json` 宣告 `view:false, renderers:["lang"]`，`client/entry.mjs`
預設匯出 `{ renderers: { lang: (code, ctx) => HTMLElement|null } }`。返回 `null`
＝不渲染，回退普通程式碼塊。renderer 是任意技術棧（不共享 React 例項），主應用只
負責把返回的 DOM 掛進訊息流；ctx 與檢視 mount 同一套窄通道（`send`/`onData`）。

**協議**：`UiPluginInfo` 新增 `renderers`/`view` 兩個可選欄位，隨 plugins 清單推送。

**分發**：普通外掛隨 GitHub 倉庫分發；Superagent 等明確隨包的內建模組除外。普通外掛使用 `pi-web-ui install <owner>/<repo>/<subdir>`
（install 原生支援子路徑 source）或複製目錄到 `<dataDir>/plugins/`。需要大引擎的
renderer 外掛可自帶 vendor（如 mermaid 外掛 `vendor/mermaid.bundle.mjs`，構建產物隨
外掛分發，本地優先載入、預設回退 CDN）。

**前端路由**：`web/src/plugin-fence.ts` 維護「語言 → 外掛 id」登錄檔（由 plugins
清單構建），`Markdown.tsx` 的 `PreWithCopy` 遇到 ` ```lang ` 圍欄時查表——有外掛
認領則交給 `PluginFenceBlock` **按需懶載入**該外掛 bundle 並渲染（命中才下載，
與檢視外掛在 `syncPluginViews` 裡常駐載入不同）；載入中/失敗/返回 null 一律回退
普通程式碼塊，絕不空白。epoch（plugins_reload）變化時清快取並 `?e=` 重拉。

**注意**：renderer 是瀏覽器直接執行的裸 ESM，**不能 import npm 包**（無 bare
specifier 解析）。需要大依賴的外掛自帶打包 bundle（如 vscode-editor）或自帶
vendor 本地載入（如 mermaid 外掛 `vendor/mermaid.bundle.mjs`，本地優先、預設回退 CDN）。

## 前端整合

App 按 chat.plugins 動態 import 各外掛的 client bundle（`/* @vite-ignore */`），TopBar 為每個外掛加一個 🧩 tab（啟用失敗的置灰）；外掛不共享 React 例項，與主應用只有 ctx.send/onData 兩條窄通道。

### 外掛 → 宿主動作橋（`window.__piWebUiHost`）

外掛 bundle 是裸 ESM，import 不到應用模組；需要主應用配合的**動作**（不只是資料）走 `window.__piWebUiHost`：

| 欄位                                                         | 說明                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                                    | 宿主 API 版本（`PLUGIN_HOST_API_VERSION`，當前 **18**；外掛可用它判斷宿主能力）                                                                                                                                                                                                                                                                                                                                 |
| `setView(view)`                                              | 切主檢視（`"chat"` / `"terminal"` / `"git"` / `"plugin:<id>"`）                                                                                                                                                                                                                                                                                                                                                 |
| `startChat({ prompt, newChat?, cwd? })`                      | 新建對話（可選切工作目錄）並把 prompt 作為使用者訊息發出；返回"已受理"                                                                                                                                                                                                                                                                                                                                          |
| `compose({ text?, attachments? })`                           | 把內容放進**輸入框草稿**（使用者補一句話再自己發），返回是否受理。與 startChat 的差別：**不要求連線就緒**（草稿是本地狀態）、輸入框沒掛載時拒收。實現走 `web/src/composer-bridge.ts` 的模組級 sink（草稿文本在 ChatInput 內部 state、待發附件在 App state，兩處各自注冊自己那一半）；合併語義複用 `composer-draft.ts`（空則填入、非空追加、絕不覆蓋），附件按 path+mode+行區間去重                              |
| `openSession({ cwd?, folders?, roots?, prompt?, newChat? })` | 可等待的開會話：目錄授權 + 多根工作區（見「專案 / 會話 API」）                                                                                                                                                                                                                                                                                                                                                  |
| `sessions.list()` / `sessions.open(id)`                      | 會話列表與開啟：本客戶端執行中的對話 + 當前專案的歷史會話                                                                                                                                                                                                                                                                                                                                                       |
| `onUiAction(name, fn)`                                       | 接管 UI 條目的動作（slot 框架；舊名 `onTopbarAction` 保留為別名）                                                                                                                                                                                                                                                                                                                                               |
| `setFooterStatus(key, value)`                                | 往**宿主內建**的底欄狀態槽（`host:cost` 那一格，斜槓接在「當前對話費用」後面）寫一段文本；`value.content.render(container)` 可選 —— 給了它，點這段文字時**宿主**彈跟隨浮層並把容器交給外掛畫內容（v18 起）：錨點、上下翻轉、滾動跟隨、點外/Esc 關閉、層級與主題全歸宿主（`components/FooterSlotPopover.tsx` + `use-floating-panel`），外掛不寫 `position:fixed`、不搶 z-index。傳 `null` 清槽（浮層一起消失）。 |
| `locale`                                                     | **宿主全域語言單源**（v19）：`locale.current()` 回傳目前 locale tag（首次掛載即可讀，不必猜 localStorage），`locale.onChange(fn)` 訂閱切換。外掛只維護自己的 ZH/EN 字典，用這個 tag 選詞；**不得**儲存獨立語言偏好。舊名 `onLocale` 保留為別名。見「插件介面語言」。                                                                                                                                            |
| `reloadCatalog(source, opts?)`                               | 外掛市場目錄同步（issue #148，見「外掛市場」）                                                                                                                                                                                                                                                                                                                                                                  |

定義：`web/src/plugin-host.ts`（純邏輯 `createPluginHostApi`，App 掛載時 `installPluginHostApi`）。
**時序坑**：服務端 `new_chat` 是非同步的（`void cs.newChat()`），緊接著發 `prompt` 會落到舊對話，
所以 `startChat` 內部序列等：cwd 切過去 → 對話變空白/換新 → 才發 prompt（每步有超時，超時也發，不靜默丟）。
現有使用者：legado-web 外掛的「🤖 AI 修復源 / AI 新建書源」按鈕（閱讀頁與書源頁一鍵把現場發給 AI 開新對話）。

`syncPluginViews(plugins, epoch)` 統一同步登錄檔：清單消失/被停用即解除安裝檢視（調 cleanup）、epoch 變化清 failed 重拉 bundle。

設定面板 ⚙ 有「介面外掛」開關區（`set_settings.disabledPlugins`，持久化 client-state、純 UI 隱藏不觸發 runtime reload —— 被停用的外掛不算「介面佈局」裡的條目，它的貢獻與 `arrange` 整份丟棄）+ **安裝即啟用**（`plugin_job` 的 `install` 作業成功後，服務端把該 id 從 `disabledPlugins` 摘掉再重推列表：出廠預設設定把一批可選外掛寫在停用清單裡，不同步啟用就會出現「裝好了但介面上找不到」；`update` / `uninstall` 不動這條狀態，使用者顯式停用過的外掛升級後保持停用——邏輯單源 `enablePluginAfterInstall()` @ `server/plugin-installer.ts`，寫入點 `AgentService.enableInstalledPlugin()`）+ **每行「更新/解除安裝」按鈕**（更新需 CLI install 記錄的來源 `.pi-source.json` → `UiPluginInfo.source`；兩個操作都走**服務端後臺作業** `plugin_job`，見下「外掛市場」，不佔使用者終端、不關設定面板）+「介面佈局」頁（內建條目與外掛條目的隱藏 / 排序 / 恢復，見「UI 擴充套件點（slot 框架）」）+「已授權目錄」段（見「目錄授權與跨目錄 fs」）。

## 常駐播放器：紅果短劇

`plugins/hongguo/` 將 [dsh-hongguo](https://github.com/frostming/dsh-hongguo) 移植到原生外掛介面，支援搜尋、選集、續播、自動連播以及懸浮 / 分屏切換。佈局只使用 `dom.anchors().app`，同一個影片元素常駐，切換佈局和對話不會重新載入影片。部署、FFmpeg、快取及介面細節見 [紅果短劇外掛](plugin-hongguo.md)。

常駐 `preload: true` 客戶端可在預設匯出中提供 `dispose(): void`。`plugin-loader.ts` 在外掛停用、移除、報錯、epoch 過載以及非同步載入結果過期時呼叫它；外掛應暫停媒體、取消請求 / 訂閱、移除浮層並恢復佈局。無此方法的舊外掛繼續按原協議載入。

## 靜態服務

`GET /plugins/:id/client/*` 對映到外掛目錄的 client/ 子樹（**只暴露這個子樹**——manifest 與服務端 index.mjs 可能含憑據，絕不下載；id 校驗 + resolve 字首防穿越）。dev 模式 vite 已代理 /plugins。

前端動態 import 的 bundle URL 經 `web/src/base-url.ts` 的 `appUrl()` 加上應用根字首
（nginx 子路徑反代時頁面在 /pi/ 下，請求會變成 `/pi/plugins/<id>/client/entry.mjs`），
子路徑部署無需任何額外配置；根部署時行為與根路徑完全一致。

### 特權 DOM 訪問（`dom` 能力族）

slot 框架的原則是「外掛宣告、宿主渲染」——外掛碰不到宿主外殼的 DOM。需要突破
這一層（往頂欄/輸入框/任意位置掛原生 DOM、改樣式、攔事件）的外掛宣告
`permissions: ["dom"]`，並走**使用者授權**：

- 服務端在 `<dataDir>/plugin-dom.json` 記授權表（`server/plugin-dom.ts` 的
  `PluginDomConsent`，與目錄授權表同口徑：全域性共享、壞檔案當空表、變更才落盤）。
- 未授權時該外掛的 client bundle 直接 **403**（`server/index.ts` 靜態門禁經
  `PluginManager.isDomBundleBlocked` 判定）—— bundle 與頁同源，JS 層面攔不住
  `document`，門只能放在下發處。未授權的外掛在清單裡帶 `wantsDom: true` +
  `error` 置灰說明原因。
- 授權/撤銷走 `plugin_dom_consent`（設定面板外掛行上的「授權/撤銷 DOM 訪問」按鈕，
  帶 ⚠ 警示），服務端寫表後 **epoch+1 重推清單**（瀏覽器丟舊模組快取重拉 bundle）。
- 已授權的 bundle 可用 `window.__piWebUiHost.dom.anchors()` 拿穩定掛載點
  （`data-pi-anchor="app|topbar|composer"`，v7 引入，`web/src/plugin-host.ts`）——
  bundle 原生就有 `document`，anchors 只是跨版本穩定的查詢入口，不用再猜類名。

設計取捨：限制的不是**能力**（授權後就是完整 DOM），而是**誰可以**——使用者在設定面板
點一次頭。服務端 `index.mjs` 本來就是完整 Node 可信程式碼，不在此門禁內。

## MCP 工具橋（server/mcp-bridge.ts）

**專案歸屬**：Bridge 與監視器按專案隔離，連線及回收邊界見上文「MCP 專案執行時」。管理操作在 await 前捕獲專案目錄，避免管理頁讀寫 B 的配置卻過載 A 的例項。

**配置與狀態**：專案同名配置覆蓋全域性配置，全域性列表行標記 `overriddenBy`，不借用專案例項的工具與執行狀態。新配置啟動失敗而保留舊例項時，狀態帶 `usingPreviousConfig` 和錯誤詳情，管理頁顯示失敗原因。引數編輯保留字串陣列的邊界（包括空引數、空格和反斜線）；未編輯的 `protocolVersion` 等配置欄位隨儲存保留。啟用開關與實際執行狀態分別展示。

**Skill 目錄同步**：`server/skill-maintenance.ts` 將目錄技能作為完整資源包複製或連結（Windows 目錄連結使用 junction），包括指令碼、參考資料和資源；獨立 Markdown 技能保持單檔案相容。路徑判斷使用路徑段及物理路徑，拒絕遞迴目標、越界資源連結、迴圈和衝突，複製失敗只清理本次建立的目標。

讀取 `<dataDir>/mcp.json` 啟動外部 MCP 伺服器（stdio、換行分隔 JSON-RPC，零三方依賴；`{servers:{名:{command,args,cwd,env}}}`），握手 initialize→initialized→tools/list→tools/call 後把每個遠端工具適配成 PluginAgentTool（名字歸一化 sanitizeToolName），併入 plugin.d.ts 的 pluginToolsProvider（與外掛工具同一 customTools 管線）。單伺服器失敗隔離（rejectAll + 日誌，不炸程序）；dispose 時 kill 子程序；請求按 id 匹配 + 超時看門狗。

**子程序生命週期與自愈**：程序意外退出（OOM / 被外部 kill / 自己崩）後不永久失效 —— `McpClient.call()` 發現子程序已死就先**惰性重啟**（重新 spawn + initialize 握手 + tools/list）再發呼叫；顯式 `close()` 之後才永久停用（不復活）。惰性而非「退出即後臺重啟」是刻意的：配置寫錯的伺服器只會在真被呼叫時試一次，不會空轉拉程序（重啟迴圈天然受呼叫頻率約束）。三條不變數：併發呼叫共享同一次重連（`starting` promise；先判 `starting` 再判 `child`，否則第二個呼叫會搶在 initialize 應答前發 tools/call）、重啟過程中被 close() 則回收剛啟動的程序不留孤兒、啟動/握手失敗也回收半啟動程序並讓呼叫方拿到明確錯誤（`伺服器程序已退出且自動重啟失敗：<根因>`，替代原來掛滿超時的泛化報錯）。重啟後 `McpClient.tools` 重新拉取。

**配置熱載入（server/mcp-hot-reload.ts）**：儲存 `<dataDir>/mcp.json` 即生效，不必再重啟服務。啟動時 `McpBridge.load()` 照舊只跑一次，之後由這條監視線接管（`index.ts` 裝配：`reload → mcpBridge.reload()`、`onToolsChanged → service.applyPluginAgentTools()`，後者就是「Bridge 層工具列表熱重新整理」那一半 —— `syncPluginToolsIntoSession` 按名字差集註入/移除，已有會話與新建會話都跟得上）。四條不變數：①**內容沒變就不動任何子程序** —— 指紋按規範化快照（`mcpServerSnapshot`：只看 command/args/cwd/env/protocolVersion，env 鍵序與伺服器順序無關），編輯器儲存、重排鍵、改縮排都不觸發重啟；②**只換規格真變了的伺服器** —— `McpBridge.reload()` 返回 `{kept, started, stopped, failed, servers, tools}`，規格沒變的沿用原例項（改一個不連帶重啟其它伺服器），被移除/替換的舊例項最後才 close，不留孤兒；③**新規格起不來就保留舊例項**，配置寫壞不等於把還能用的工具一起下線；④**JSON 解析失敗只記日誌 + 一條 warning 提示、保留在跑的伺服器**（儲存過程中的半寫狀態很常見），而**刪掉 `mcp.json` 是有意清空全部伺服器**，照常應用 —— 兩種「沒有配置」的語義刻意分開。監視用 `fs.watch`（`persistent: false`，不弔住程序），目錄還不存在 / 網路盤不支援時自動回落到 2s 輪詢。

**工具結果的 content 塊按型別對映**（以前只拼 `type==="text"`，截圖/圖表類工具一律返回空串）：`image` 塊原樣透傳為 SDK 的 `ImageContent`（`{type,data,mimeType}`，進會話後由 SDK 的 `normalizeToolResultImages` 統一縮放，超限圖不會讓 provider 整段報錯）；文本型 `resource`（`resource.text`，filesystem 類 MCP 的 read_text_file 走這條）當文本透傳；blob（PDF 等）與 audio 退化為「mimeType + 約 N 位元組，無法內聯」的提示（SDK 內容聯合只有 text|image|thinking|toolCall，沒有 blob 載體）；純文本結果仍是拼接字串（老形狀不破壞既有呼叫方）。注意 Web UI 的工具卡按既有行為只渲染文本（工具結果裡的圖片在 `serialize.ts` 裡是 `[image result]`），模型上下文不受影響。

**OAuth 保護的遠端伺服器（`server/mcp-oauth.ts`，Issue #786）**：pi 的內建 MCP 擴充套件把每個伺服器的 OAuth 狀態存在 `<agent-dir>/mcp-auth.json`（鍵 `mcp__<伺服器名>|<url>`，舊版只寫 URL 的鍵仍讀並接管），pi-web-ui 的橋直接**複用這份憑據**而不另建一套：請求前取 access token（臨近過期 30s 先重新整理，與 pi 同口徑），發出 `Authorization: Bearer …`；收到 401 時用庫裡的 refresh token 強制重新整理一次並重試同一請求，重新整理結果按 pi 的格式（2 空格 JSON + 換行，0600）寫回，重新整理令牌輪換一併保留。併發/跨程序重新整理用與 pi 同名的 `<agent-dir>/mcp-auth-refresh-<hash>.lock` 目錄鎖序列化（stale 20s），`staleToken` 判據保證「別的程序已換過 token」時不重複重新整理（輪換下二次重新整理會毀掉授權）。**網頁登入**：管理頁通過 `mcp_oauth_start/finish/status/cancel` 發起授權，`server/mcp-oauth-login.ts` 複用 `@earendil-works/pi-mcp/oauth` 的發現、動態客戶端註冊、PKCE 與授權碼交換。臨時 loopback 回撥監聽器自動完成本機瀏覽器授權；遠端部署可將瀏覽器最終跳轉的完整 URL 粘回管理頁。隨機 state、回撥 origin/path 與單次交換檢查保護授權歸屬；PKCE verifier 與令牌始終留在服務端，只有授權 URL、嘗試 ID 與狀態下發。未完成的狀態只存記憶體，十分鐘過期、取消或客戶端銷燬即中止網路請求並關閉監聽。成功後在共享憑據庫鎖內合併寫入，再重連發起時捕獲的專案 Bridge；每個 ClientSession 獨立管理登入，不能跨客戶端提交別人的 ID。CLI 的 `pi mcp login <伺服器>` 仍相容。顯式配置了 `Authorization` 頭的伺服器走靜態憑據，完全不碰這裡。

重新整理寫回在 `mcp-auth.json.lock` 內執行 compare-and-swap：比較網路呼叫前讀到的來源鍵、tokens、絕對過期時間、客戶端註冊與 discovery。憑據被刪除時不恢復；重新登入、客戶端或授權端點發生變化時丟棄舊重新整理結果，返回當前庫裡的 token（刪除則為 null）。合併保留其它伺服器與當前條目的非憑據欄位；只有實際重新整理舊 URL 鍵時才遷移並刪除該舊鍵，獨立的舊鍵不會被誤刪。重新整理失敗的回退也重新讀庫，避免傳送登出前捕獲的 token。

每個 HTTP RPC 從讀取憑據前就登記為在途請求並啟動超時；同一取消訊號貫穿重新整理鎖/庫鎖等待、令牌請求、響應體、重試和寫回前檢查。401 的 `staleToken` 來自該請求實際傳送的 Authorization，不能使用客戶端共享的“最近 token”。併發重新整理沿用跨程序鎖序列化，不共享取消控制器：取消等待者不會終止持鎖者，取消持鎖者不會提交遲到結果，其餘呼叫者自行重新讀庫。超時、呼叫方取消與 `close()` 立即結束 RPC；通知也有獨立的 8s 截止時間並由 `close()` 取消。已在授權伺服器發生的重新整理令牌輪換無法撤回；本地取消會丟棄結果，此時可能需要重新登入。迴歸見 `tests/unit/mcp-oauth-concurrency.test.ts`。

## 外掛市場（可一鍵安裝的外掛列表）

> 設定面板「介面外掛」頁上方新增的「外掛市場」區：列表裡每條外掛一個「安裝」
> 按鈕。**安裝 / 更新 / 解除安裝都走服務端後臺作業**（`server/plugin-installer.ts`）：
> 真正執行的仍是 CLI（`pi-web-ui install|uninstall`，單一實現），但**不再開可見終端、
> 不關設定彈窗**——輸出按行回傳（`plugin_job`），面板上就地顯示進度與失敗輸出（issue
> #152）。同一時刻只跑一個作業（兩個 install 寫同一目錄必出半裝狀態），另有看門狗與取消。
> 已裝過的顯示「更新」（`install … --force`，保留 config.json）與「解除安裝」（兩步確認）。
> 市場頭部還有「原始碼構建」勾選項：安裝/更新前先做隔離構建（等價 CLI `--build`，issue
> #150）——只裝外掛宣告的構建依賴（`npm install --ignore-scripts`，不跑任意生命週期
> 指令碼）→ 跑 manifest.build.command（預設回落 package.json 的 `scripts.build`）→
> 校驗 `outputs` → **成功後才替換目標目錄**（失敗時上一版外掛原樣可用）。
> 該勾選框語義是“強制重編”：只有原始碼沒有產物的外掛即使不勾也會自動構建（issue #165
> 的 `--build` 推斷：有構建宣告 + 雙入口都缺 = 不構建必死，此時預設構建並先列印解析出
> 的 install/command；`--no-build` 可顯式跳過，產物已提交的倉庫不受影響）。

**外掛安裝與更新的三級加速與稀疏檢出（Sparse Checkout & Fast Path）**：
為杜絕每次安裝/更新子目錄外掛時全量 clone 數十兆完整 Git 倉庫的問題，CLI 與後臺作業實施三級最佳化：

1. **隨包本地優先通路（Local Bundled Fast Path）**：官方內建外掛（`plugins/<id>`）在全新安裝或主程序升級（隨包版本高於已裝版本）時，優先直接使用宿主隨包原生代碼，零網路耗時、零流量；離線或網路故障時自動降級回退到隨包；`--remote` 引數可強制走遠端。
2. **Git 稀疏拉取與 Blobless 過濾（Sparse + Blobless Checkout）**：針對遠端子目錄外掛，優先採用 `git clone --depth 1 --filter=blob:none --sparse --no-checkout` 配合 `git sparse-checkout set <subpath>`，只拉取提交樹後設資料與目標子目錄的檔案 blob，不下載非必要倉庫內容（全倉數十兆流量降至幾十 KB）；遇舊版 Git 自動平滑降級常規 shallow clone 與 tarball 直連。
3. **批次安裝/更新會話級倉庫快取（Shared Repo Cache）**：在目錄同步（`--catalog`）或多外掛批次操作中，同源倉庫僅拉取一次後設資料，多個子目錄通過 `git sparse-checkout add` 增量檢出複用，杜絕同一倉庫連續重複 clone。

**三層來源合併**（`server/plugin-catalog.ts`）：

| 層        | 位置                                                                   | 誰維護                                                                                                                                                                                                | 徽章        |
| --------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| builtin   | `<pkgRoot>/plugins/catalog.json`（隨包釋出，npm files 白名單含該檔案） | **只放本倉庫自帶的外掛**（`plugins/<id>` 同目錄、`source` 指 `xing-shuyin/pi-web-ui`）—— 往這個檔案加一條 + PR 即入列表；第三方外掛不進這裡                                                           | —（不打標） |
| community | `<dataDir>/community-catalog.json`                                     | 社群生態目錄同步寫入（`plugin_catalog_sync` 的 community 目標）；第三方外掛在 [pi-web-ui-plugins](https://github.com/xing-shuyin/pi-web-ui-plugins) 提交 `plugins/<id>/plugin.json`，開機預設拉該清單 | 社群        |
| custom    | `<dataDir>/plugin-catalog.json`                                        | 使用者 —— 設定面板「新增外掛」表單填 source/名稱/簡介，任何第三方外掛都能進列表                                                                                                                       | 手動新增    |

條目 = `{ id, name?, description?, descriptionEn?, icon?, source, homepage? }`；
同 id 時 custom 覆蓋 builtin（`overridesBuiltin`），**例外：同 id 且同 `source` 視為同一條目重複登記**
（典型成因是把整份官方目錄同步進了 custom 檔案），保留原層與 origin，否則徽章會在
「宿主自帶/手動新增」之間無意義地抖動。builtin 條目就是專案自己的官方外掛，**預設不打任何徽章**；
徽章只在條目不是官方自帶時才出現（community / custom），且只描述登記在哪一層，與安裝後的執行時能力無關 ——
裝完都落到 `<dataDir>/plugins/<id>`，同一套 manifest／許可權審批／載入鏈路。
`id` 是安裝落盤目錄名
（`<dataDir>/plugins/<id>`），前端用「列表 id ∈ 已裝外掛 id」判斷安裝態；
`source` 與 CLI 同格式（owner/repo[/子目錄][#分支]），服務端只做寬鬆校驗
（不拉網路，不碰 manifest —— 展示資訊由條目作者填）。

**協議**：`plugin_catalog`（下行，attach 即推 + add/remove 後重推，帶 epoch）／
`plugin_catalog_add` / `plugin_catalog_remove`（上行，服務端校驗 + 原子寫
custom 檔案 + notice 回顯）。內建/社群條目不可經 UI 移除，只有 custom 條目帶刪除按鈕。

**從目錄同步**（issue #165）：市場頭部「從目錄同步」按鈕展開同步框 —— 填目錄文件 URL
（http(s)）或本地絕對路徑，一鍵走服務端現成的 `plugin_catalog_sync` 通道（與外掛
`host.reloadCatalog` 同一條：同校驗、同原子寫盤；可選同步後安裝全部條目 / 整體替換，
回執就地回顯）。成功同步過的 URL 記瀏覽器 localStorage（最近 8 個），一點即重同步 ——
**安裝前先讀 spec**（DSH 對照 P0-3，`server/plugin-install-spec.ts` + `PluginInstaller.inspectInstallSpec`）：
在「新增外掛」輸入框填來源時，前端防抖 500ms 發 `plugin_install_inspect`，服務端在**動 CLI 之前**
做一次可解釋的檢查 —— ① 形狀分類（`npm` / `github` / `url` / `path` / `invalid`）；② 本地已裝判定
（`<dataDir>/plugins/<推導 id>` 存在 → 轉成「更新」）；③ 本地路徑源直接讀它的 `manifest.json`；
④ GitHub 源用一次 `raw.githubusercontent` 探測（6s 超時，失敗**不阻塞安裝**）。結果歸到七種
`problem`（`invalid-spec` / `already-installed` / `not-found` / `not-a-package` / `not-a-bundle` /
`network` / `unknown`），各帶一句可讀 detail 與 `suggestedId`，經 `plugin_install_inspect_result`
回到面板，在輸入框下就地顯示（探到 manifest 時順帶展示 name/version/description 供確認）。
`server/plugin-install-spec.ts` 本身是純函式（不聯網、不寫盤），`server/plugin-catalog.ts` 的
寬鬆校驗保持不變 —— 它只是**引導**，不是硬門禁。

**從目錄同步**（issue #165）：市場頭部「從目錄同步」按鈕展開同步框 —— 填目錄文件 URL
（http(s)）或本地絕對路徑，一鍵走服務端現成的 `plugin_catalog_sync` 通道（與外掛
`host.reloadCatalog` 同一條：同校驗、同原子寫盤；可選同步後安裝全部條目 / 整體替換，
回執就地回顯）。成功同步過的 URL 記瀏覽器 localStorage（最近 8 個），一點即重同步 ——
第三方倉庫不再需要為同步專門發一個佔位外掛。headless/預置場景另有兩條同語義入口：
CLI `install --catalog <url>`（同步列表 + 逐條安裝/更新，已安裝預設跳過，`--force` 更新，
`--replace` 整體替換）與環境變數 `PI_WEB_PLUGIN_CATALOG_URL`（服務端啟動時自動同步一次並
安裝，失敗只告警不阻斷啟動；見 `docs/env-vars.md`）。

## UI 擴充套件點（slot 框架，issue #146）

外掛對宿主 UI 的貢獻走**宣告式掛載點（slot）**：外掛只宣告「有什麼條目、想放哪兒」，渲染 / 排序 /
溢位 / 可訪問性全部歸宿主，**外掛不碰 DOM**。契約在 `server/protocol.ts`（`UiSlotId` /
`UiContribution` / `UiArrangeOp` / `UiPluginUi` / `UiLayoutPrefs` / `UiSlotSpec`），服務端解析與執行時註冊在
`server/plugins.ts`（`parseUiItem` / `parseUiContributions` / `parseUiArrange` / `UI_SLOTS` /
`UI_SLOT_ALIASES`），前端合併引擎是 `web/src/ui-slots.ts` 的 `buildUiSlots()`（純函式，有單測）。

**失敗不靜默（DSH 對照 P0-1）**：`buildUiSlots(..., { diagnostics })` 可收集合並過程中的診斷
（未知 slot / 未知 kind / 宿主不認識的 `when` / arrange 目標不存在 / 同一外掛重複宣告同 id /
外掛被停用或啟用失敗），每條帶 `pluginId` + `entryId` + `slot` 歸因；不傳 `diagnostics` 時行為
與原來**逐字一致**。App 把它們 `console.warn` 出來，設定面板「介面佈局」頁頂部同時渲染一個可
摺疊橫幅（`uiLayoutDiagTitle` / `uiLayoutDiagHint`）——以前這些情況是靜默丟棄，表現為「註冊了但
介面上沒有」，最難排查。渲染層另配 `web/src/components/SlotErrorBoundary.tsx`：每個條目**獨立**
包一層，某條目渲染拋錯只丟它自己並就地置灰，不炸掉整條工具欄。

> 別和**外掛檢視 tab** 混起來：安裝後出現在頂欄的 🧩 檢視 tab（`plugin:<id>`）由 `plugins` 清單經
> `withPluginViewItems` 合成 `kind="view"` 條目（`<id>:__view`）後走 slot 框架，與宿主三連同流渲染
> （報錯外掛的 tab 由 TopBar 兜底置灰保留，因合併引擎會整份丟棄它的貢獻）。

### 22 個掛載點

每個掛載點都有宿主定義的 `UiSlotSpec`：`cardinality` 為 `list` 時多個條目並列渲染，
為 `single` 時合併引擎按最終排序選出第一個可見條目，其餘可見候選會被置為隱藏併產出佈局診斷。
當前這 22 個已有掛載點全部是 `list`，因為它們都表達工具欄、選單、tab 或頁面入口的並列集合；
`modal.dialog` 的“同一時刻只開一個”是開啟狀態機約束，不是 slot cardinality。未來新增獨佔掛載點只需
在 `web/src/ui-slots.ts` 的 `UI_SLOT_SPECS` 標成 `single`，無需改變外掛 manifest 形狀。

| slot                         | 位置                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `topbar.primary`             | 頂欄主欄（與內建 tab 同排；單一扁直流，見下方“頂欄平鋪化”）                                                                                                                           |
| `topbar.overflow`            | 頂欄溢位選單（被隱藏的條目＋直接宣告在這裡的常駐條目）                                                                                                                                |
| `bottombar`                  | 底欄（連線狀態 / 上下文 / 成本那一條）                                                                                                                                                |
| `composer.leading`           | 輸入框前置區（檔案上傳按鈕左側，純外掛新增位）                                                                                                                                        |
| `composer.actions`           | 輸入框動作區（上傳按鈕右側到傳送按鈕之間）                                                                                                                                            |
| `message.actions`            | 每條訊息 hover 時的工具條                                                                                                                                                             |
| `rightpanel.tabs`            | 右欄 tab（預設是檔案樹 + 原始碼管理）                                                                                                                                                 |
| `bottomdock.tabs`            | 底部面板 tab（預設是終端；標籤 >1 時才出現標籤條）                                                                                                                                    |
| `contextmenu.topbar`         | 頂欄條目右鍵選單                                                                                                                                                                      |
| `contextmenu.message`        | 訊息右鍵選單                                                                                                                                                                          |
| `contextmenu.session`        | 左欄會話右鍵選單                                                                                                                                                                      |
| `contextmenu.file`           | 檔案樹條目右鍵選單                                                                                                                                                                    |
| `contextmenu.search`         | 全域性搜尋（Ctrl+K）結果行右鍵選單（`target.kind` 為 `session` / `project` / `file` / `folder` / `plugin`；`when` 可用 `search.isSession` 一類判據）                                  |
| `contextmenu.toolcall`       | 工具呼叫卡片的**工具名**右鍵選單（宿主唯一選單；內建一條「顯示工具詳細資訊」，見 `ToolInfoDialog.tsx`）                                                                               |
| `contextmenu.bot`            | 左欄「智慧體」Bot 列右鍵選單（`target.kind="agent-bot"`；宿主條目：私聊 / 引用到對話 / 編輯 / 裝置中心管理 / 記憶 / 複製 ID，見 `AgentBotsSection.tsx`）                              |
| `settings.pages`             | 設定面板裡的一整頁（外掛用 `mount()` 自己渲染）                                                                                                                                       |
| `leftpanel.projects.actions` | 左欄「最近專案」標題欄按鈕（宿主「管理專案」按鈕之後追加；無條目不畫）                                                                                                                |
| `leftpanel.project`          | 左欄專案行內嵌區（專案名旁的徽標 / 快捷按鈕；點選回傳 `target={id: 專案路徑, kind: "project"}`）                                                                                      |
| `leftpanel.running.actions`  | 左欄「執行的對話」標題欄按鈕                                                                                                                                                          |
| `leftpanel.history.actions`  | 左欄「歷史對話」標題欄按鈕（宿主「新對話」按鈕之後追加）                                                                                                                              |
| `contextmenu.project`        | 左欄專案行右鍵選單（`target.kind="project"`；無可見條目時不搶瀏覽器右鍵）                                                                                                             |
| `leftpanel.running`          | 左欄「執行的對話」行內嵌區（只在執行行上出現；與 leftpanel.sessions 並集）                                                                                                            |
| `leftpanel.history`          | 左欄「歷史對話」行內嵌區（只在歷史行上出現；與 leftpanel.sessions 並集）                                                                                                              |
| `leftpanel.sections`         | 左欄三個分割槽的順序與顯隱（**僅宿主條目** `host:lp-*`；外掛不能往裡放條目，只能 arrange 隱藏）                                                                                       |
| `leftpanel.sessions`         | 左欄會話行內嵌區（會話標題旁的徽標 / 快捷按鈕）                                                                                                                                       |
| `chat.header`                | 對話頭部條（標題旁的操作區）                                                                                                                                                          |
| `chat.empty`                 | 空對話佔位區（新對話的快捷入口）                                                                                                                                                      |
| `file.preview.toolbar`       | 檔案預覽工具條                                                                                                                                                                        |
| `terminal.toolbar`           | 終端工具條                                                                                                                                                                            |
| `scm.toolbar`                | SCM 面板工具條                                                                                                                                                                        |
| `goalbar.actions`            | 目標條動作區                                                                                                                                                                          |
| `notice.actions`             | 通知條動作區（notice 上的快捷按鈕）                                                                                                                                                   |
| `tasks.panel`                | 「後臺任務」面板（BgTasksModal）內容區：kind=`view` 的條目就地內嵌外掛 bundle（同 `settings.pages` 的掛載口徑），其餘 kind 當動作按鈕；宿主自己 diff 出來的後臺程序仍走該面板原生列表 |
| `modal.dialog`               | 彈窗（`modal` 可簡寫；kind=`view` 的條目經宿主橋 `openModal` 按需開啟，`closeModal` 關閉；同一時刻只開一個）                                                                          |

**自然簡寫**（`UI_SLOT_ALIASES`：解析時對映成完整名，讓作者少踩坑）：`topbar`→`topbar.primary`、
`topbar.more`→`topbar.overflow`、`composer`→`composer.actions`、`message`→`message.actions`、`modal`→`modal.dialog`、
`rightpanel`→`rightpanel.tabs`、`bottomdock`/`bottompanel`→`bottomdock.tabs`、`settings`→`settings.pages`。沒有別名的（`bottombar`、`composer.leading`、`tasks.panel` 與五個
`contextmenu.*`）必須寫完整名；認不出的 slot 直接丟掉該條目（不報錯、不崩）。`arrange` 的目標 slot
只接受完整名（不走別名）。

### 插件介面語言（全域語言單源，issue #920）

插件**不儲存自己的語言偏好**。介面語言只有一份事實源：宿主傳到前端的 locale（`web/src/ui-locale.ts` → `useI18n().locale`），按下面兩條使用：

| 位置                                                                | 怎麼取值                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件名 / 描述（宿主渲染：頂欄 tab、插件選單、設定面板、插件頁錯誤） | manifest 同時寫 `name`（中文）與 `nameEn`（英文）、`description` / `descriptionEn`；客戶端統一走 `web/src/plugin-name.ts` 的 `pluginDisplayName()` / `pluginDisplayDescription()` 按 locale 選詞。**不要在元件裡直接讀 `p.name`。**                                                                                     |
| 插件自畫的介面（按鈕 / 選單 / 提示）                                | `createPluginI18n({ zh, en })`（SDK 0.4.0，`@pi-web-ui/plugin-sdk/client`）—— 一個 `t(key, vars)` + `onChange`，語言歸一與回落全在 SDK 裡；要自己實作時底線是 `window.__piWebUiHost.locale.current()` 取首幀、`locale.onChange(fn)` 訂閱切換，外掛自帶 ZH/EN 字典，非中英宿主語言回落到英文。舊欄位 `onLocale` 仍可用。 |

頂欄自動生成的插件檢視條目（`<id>:__view`）由 `web/src/ui-slots.ts` 的 `withPluginViewItems()` 同時填 `label` / `labelEn`，渲染層按 `zh` 選詞；插件自己貢獻的 `ui.items` 仍用 `label` / `labelEn` 欄位。

參考實作：`plugins/vscode-editor/src/client.js` 的 `hostLangRaw()` + `followHostLang()`（刪掉了自帶的語言開關）。

**SDK 側的 `createPluginI18n`（issue #939）**：宿主 SDK 0.4.0 起在 `plugin-sdk/client.mjs` 匯出 `createPluginI18n()`，實作見 `plugin-sdk/client-utils.mjs`：接受 `{ zh, en }` 或 locale tag 鍵名（也相容 `createPluginI18n(zhDict, enDict)` 位置參數），回傳 `{ t, lang, locale, current, onChange, destroy }`；`zh-CN` / `zh-TW` 都歸一到 `zh`，其餘語言回 `en`，缺詞回落到另一語言的同名 key 再回落到 key，插值支援 `{x}` / `{{x}}` / `${x}`。這同時是那類線上事故的解法：插件程式碼比宿主新、卻 import 了宿主沒有的 SDK 匯出時，瀏覽器直接 `SyntaxError: Importing binding name 'createPluginI18n' is not found`（服務端日誌乾淨），守衛在 `tests/unit/plugin-sdk-export-contract.test.ts`（插件宣告什麼匯出，宿主就必須真的有），行為守衛在 `tests/unit/plugin-sdk-i18n.test.ts`。

**設定 → 工具頁不留寫死文案**：三態標籤、批次按鈕、搜尋框佔位、插件兌底名一律走 i18n key，分類標題只由 `web/src/tool-inventory.ts` 的 `titleKey` / `subKey` 給出（渲染層不再按 id 另寫一套標題），守衛在 `tests/unit/settings-tool-rows.test.ts`。

### manifest 裡怎麼寫

```json
{
	"permissions": ["ui"],
	"ui": {
		"topbar": [
			{
				"id": "inbox",
				"label": "收件箱",
				"labelEn": "Inbox",
				"icon": "📬",
				"kind": "action",
				"action": "webmail:open-inbox",
				"group": "mail",
				"order": 10
			}
		],
		"contextmenu.file": [{ "id": "send", "label": "發到郵箱", "action": "webmail:send-file" }],
		"settings": [{ "id": "mail", "label": "郵箱", "icon": "📬" }],
		"arrange": [{ "id": "host:github", "hide": true }]
	}
}
```

兩種形狀都收：按 slot 分組（推薦，見上）或平鋪 `{ "ui": { "items": [{ "slot": "...", ... }] } }`
（與執行時 `host.ui.register` 入參同形，兩邊複用同一套解析）。整份貢獻共享一個 **32 條**上限、
`arrange` 上限 64 條；非法條目 / 重複 id / 認不出的 slot 靜默丟棄（寬容但不放任：壞欄位跳過，不因為
一條髒資料丟掉整份貢獻）。

> 相容性：這一版之前（同一 issue 的第一稿）的頂層 `manifest.topbar` 欄位**已不再解析** —— 現在寫
> `manifest.ui`（別名 `ui.topbar`）。保留相容的只有宿主動作橋的舊名 `host.onTopbarAction`
> （= `onUiAction` 的別名，見「外掛 → 宿主動作橋」）。

### 條目欄位（`UiContribution`）

`id`（外掛內唯一，須匹配外掛 id 字元集；**全域性 id = `<pluginId>:<id>`**，使用者偏好與 `arrange` 的 key
就是它）、`label`（中文介面文案）+ `labelEn`、`icon`（emoji/單字元，或宿主圖示詞表裡的名字）+ `iconSvg`（內聯 SVG，有則優先於 `icon` 渲染）、
`hint` / `hintEn`（懸浮提示，落成渲染層的 `title` —— 只給一種語言時另一種回落它）、`kind`、`children`、
`order`（預設 100，小的靠前）、`group`（同組連續排布）、`hidden`、`action`、`view`、`when`、`badge`。
文本欄位會截斷（label 60 / icon 16 / hint 200 字元）。

**kind 詞表**：`view` | `action` | `badge` | `menu` | `page` | `organizer` | `divider` | `toggle` | `input` | `progress` | `select`（預設 `action`；
`slot == "settings.pages"` 時預設 `page`）。語義：`view` 切檢視（`view` 預設 `plugin:<id>`）；`action`
點選回給外掛（經 `host.onUiAction`）；`badge` 只顯示狀態文本/角標（可經 `host.ui.update` 重新整理）；
`menu` 展開 `children`；`page` 是設定面板裡的一整頁；`divider` 分隔線；`organizer` 是整理器（詞表裡
保留的種類，當前各渲染層沒有專門處理）；`toggle` 開關（`checked`，點選回外掛）、`input` 單行輸入
（`value`，回車回外掛時附帶輸入值）、`progress` 進度條（0-100，只展示）、`select` 下拉（`options` 候選 +
`value` 當前值，切換回 `onUiAction(itemId, value)`）。`select` 全槽位可畫：頂欄/輸入框/訊息工具條/
終端-SCM-目標條共享工具條/底欄/左欄會話行/通知條落成原生下拉，右鍵選單展開成子選單（點選子項回
父條目 + value，見 `expandSelectEntries`），右欄 tab 按既有口徑當 tab 開啟（與 toggle/input 一致）。

**`children` 只一層**：解析時子項自己的 `children` 被清掉（防巢狀），子項也沒有穩定的全域性 id ——
所以子項**不參與** `arrange` 與使用者偏好。當前實現裡只有**右鍵選單**把 `children` 畫成子選單
（`ContextMenu.tsx`），其它槽位只畫父條目。

**`when`**：宿主上下文條件，宿主不認識的值直接忽略、不報錯。當前只有右鍵選單評估它
（`web/src/context-menu-state.ts` 的 `evaluateWhen` + `buildWhenContext`，`ContextMenu.tsx`
按槽位 + 被右鍵物件現場構造上下文）：字面量 `"disabled"` / `"never"` 恆置灰、`"always"` 恆可用、
以 `!` 開頭的條件（如 `"!message.hasSelection"`，有上下文按上下文判、無上下文按 legacy 直接置灰），
以及肯定形適用條件 —— `file.isDir` / `file.isFile`（檔案選單，按 target.kind）、`session.isRunning`
（會話選單）、`message.hasSelection`（訊息選單）、`search.isSession` / `search.isProject` / `search.isFile` /
`search.isFolder` / `search.isPlugin`（全域性搜尋選單，按 target.kind）—— 為假則**保留但置灰**。未知條件名預設可用
（未來加新條件不翻舊外掛）。

### 合併優先順序（四級）與「同一份計算」

每個 slot 的最終條目都由 `buildUiSlots(plugins, { locale, t, disabledPlugins, layout })` 算出：

| 層           | 來源                                                                                                                                                                                                                                                     | 規則                                                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 宿主預設   | `BUILTIN_UI_ITEMS`（**119** 條 `host:*` 內建條目，覆蓋 **13** 個 slot：頂欄 18 / 檔案右鍵 27 / SCM 工具條 12 / 底欄 10 / 檔案預覽頭欄 9 / 目標條 8 / 輸入框動作 7 / 會話右鍵 6 / 訊息工具條 5 / 終端工具條 3 / 搜尋右鍵 10 / 左欄分割槽 3 / 右欄 tab 1） | 可見性、順序、分組、文案的基線                                                                                                                       |
| 2 外掛貢獻   | `UiPluginInfo.ui.items`                                                                                                                                                                                                                                  | 同 id 後宣告的外掛覆蓋前面的（**位置仍按首次宣告**，避免重宣告把條目擠到列表尾部）；報錯外掛與「介面外掛」裡被停用的外掛整份丟棄                     |
| 3 外掛安排   | `ui.arrange`（可改 `slot` / `hide` / `group` / `order` / `label` / `hint` / `icon` / `iconSvg`）                                                                                                                                                         | 只能改**已存在**的條目（目標不存在 = 靜默忽略）；改了別人的條目會記進它的 `arrangedBy`（含 `movedFrom`）—— 這是「外掛不許偷偷改宿主 UI」的可見性保障 |
| 4 使用者偏好 | `settings.uiLayout`（`UiLayoutPrefs`：`hidden` / `shown` / `order` / `groups` / `labels`）                                                                                                                                                               | 最高：使用者點過什麼就由它最後說話；`shown` 在 `hidden` 之後應用（「顯示」是對上一次隱藏的撤銷，必須生效）                                           |

同 order / 無排序資訊時保持宣告順序（穩定排序兜底）。**「同一份計算」是這套框架的核心不變數**：渲染層
（TopBar / FooterBar / ChatInput / Message(List) / RightPanel / LeftPanel / SettingsModal）與設定面板
「介面佈局」頁跑的是同一個 `buildUiSlots()` —— 佈局頁裡看到的順序 / 分組 / 文案就是介面上生效的，所以那頁
能逐條隱藏（勾選框）、↑/↓ 調序、單條「恢復」與「全部恢復預設」，並給被外掛改過的條目標一個「外掛調整過」
（`arrangedBy`）。恢復只撤**使用者偏好**（外掛 `arrange` 的意圖仍生效，要連它一起撤就停用外掛）；條目上的
`source` / `userOverrides` / `arrangedBy` / `movedFrom` 就是佈局頁用來解釋「這條是誰挪走的」的依據。

**文案（`labels`）的落地規則**：`UiSlotEntry.label` 分兩類 —— 宿主內建預設（`t(labelKey)`）與**顯式指定**
（使用者在佈局頁改名 / 外掛 `arrange.label` / 外掛自己宣告的條目）；後者會置 `UiSlotEntry.labelExplicit`。
渲染層必須看這面旗：內建條目一直畫的是自己寫死的 i18n 文案與即時數值（頂欄按鈕、底欄數值徐標），只有
`labelExplicit` 立著時才讓位 ——名字型條目（檢視三連 / 搜尋 / 外掛條目…）用使用者文案頂掉內建文案；數值型
（上下文 / 成本 / 快取 / 訊息數 / 連線態…）把名字插在數值前，**不吞掉即時資料**（`BarItem` 裡的 `named()` /
`withName()`）。沒置旗時渲染結果與舊版逐位元組一致，所以「外掛的 label 與使用者的改名對內建條目也真的生效」
（issue #555；迴歸：`tests/unit/bar-item-unified.test.ts`、`tests/ui-layout-ui-test.mjs`）。

### 溢位與隱藏

只有**頂欄**有溢位概念：主欄本身不限量（與底欄同款直排，窄屏橫滑/桌面端換行），被 `hidden` 的條目、
以及直接宣告在 `topbar.overflow` 的常駐條目進「⋯」溢位選單 —— 也就是說外掛能把宿主內建入口從主欄挪走，
但它在溢位選單與佈局頁裡都還在，使用者點一下佈局頁的「恢復」就能拿回原位（外掛能整理一切，卻鎖不死使用者）。
其它槽位沒有溢位：`hidden === true` 就是不顯示（右鍵選單連選單項都不生成）。佈局頁按 22 個掛載點全量分組
（`SettingsModal.tsx` 的 `uiLayoutSections`，與 `SLOT_IDS` 同順序——兩邊都嚴格按實際介面的 DOM/視覺順序排：
頂欄 → 通知 → 左欄 → 主列 → 右欄 → 終端/Git 檢視 → 底欄 → 懸浮層 → 右鍵選單 → 設定頁 → 對話方塊；搜尋框可過濾，
搜尋時 ↑↓ 停用）。頂欄 / 底欄 / 輸入框動作區在介面上按對齊段（左 start → 中 center → 右 end）分段渲染，
佈局頁同口徑按段列出（段頭即介面上的段），↑↓ 只在段內移動，換段走對齊下拉。左右停靠欄
（`sidebar.left` / `sidebar.right`）同口徑但軸是**豎的**：start=靠上 → center=居中 → end=靠下，
佈局頁的段頭與對齊下拉用「靠上/居中/靠下」措辭（同一套取值、同一份 `uiLayout.align` 偏好）。

**宿主內建條目同樣受這些規則管**（這是「設定裡看到的 == 介面上看到的」這條不變數的關鍵一半）：

| 位置                                                         | 渲染方式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 隱藏 / 調序的效果                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 頂欄全條目（品牌/歷史/檔案/新對話/檢視三連/外掛檢視/工具組） | `TopBar.tsx`：**單一扁直流** —— 所有條目都是 `.topbar-flow` 的直接子節點（無任何按種類包裹的容器，也無兩端貼邊例外），宿主查 `hostNodes` 節點工廠、外掛通用渲染（外掛檢視經 `withPluginViewItems` 合成 `kind="view"` 條目），`align` 只決定落兩個 `.tb-spacer` 劃出的 start/center/end 哪一段                                                                                                                                                                                                                      | 勾掉 → 從主欄消失並進「⋯」溢位選單（點回仍可用）；↑↓ 換位置；align 搬分割槽 —— 三者對**每一個**條目生效；**選單型條目（聲音/語言/主題/版本/GitHub/瀏覽器）整塊元件搬進選單**（不是隻剩一個點了沒反應的標題）；**桌面與手機同一份資料**：寬度放不下的條目按視覺順序從尾部退進同一個「⋯」（`web/src/topbar-fit.ts` 實測寬度），舊版手機端那套 CSS 整組隱藏 + 硬編碼「⋯」面板已刪 |
| 底欄                                                         | 按 slot 順序從 `bottombarItems` 渲染（`FooterBar.tsx`），左/中/右三區按 `align` 落位                                                                                                                                                                                                                                                                                                                                                                                                                               | 勾掉 / ↑↓ / 對齊三者都生效                                                                                                                                                                                                                                                                                                                                                     |
| 輸入框動作區（`composer.actions`）                           | `ChatInput.tsx`：宿主 7 項（上傳/模板庫/模型/思考/DSH 許可權/預設/傳送簇）＋外掛按 slot 順序交錯渲染                                                                                                                                                                                                                                                                                                                                                                                                               | 勾掉 / ↑↓ / 對齊三者都生效（傳送簇 `align=end` 落右側；藏掉髮送後回車仍可傳送）                                                                                                                                                                                                                                                                                                |
| 輸入框前置區（`composer.leading`）                           | `ChatInput.tsx` 按 slot 順序渲染在上傳按鈕左側                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 勾掉 / ↑↓ 都生效（純外掛位，無內建條目）                                                                                                                                                                                                                                                                                                                                       |
| 訊息 hover 工具條                                            | `Message.tsx` 跳過 `hidden` 的條目                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 全被隱藏 → 整條容器都不畫（不留空殼）                                                                                                                                                                                                                                                                                                                                          |
| 左右停靠欄（`sidebar.left` / `sidebar.right`）               | `SideDock.tsx`：`align` 讀作豎軸（start=靠上 / center=居中 / end=靠下），三段各畫一顆**內容高**的貼邊藥丸（空段不畫底、也不吃點選），彈性格子把停靠欄撐滿整列                                                                                                                                                                                                                                                                                                                                                      | 勾掉 / ↑↓ / 對齊三者都生效；摺疊按鈕**只在懸浮模式**出現（流內收起省不下寬度），收起後只剩一個展開小按鈕。迴歸 `side-dock-align-ui-test.mjs`                                                                                                                                                                                                                                   |
| 右欄 tab                                                     | `RightPanel.tsx` 按 slot 順序渲染（含內建「檔案」tab 的位置，不再固定第一）                                                                                                                                                                                                                                                                                                                                                                                                                                        | 勾掉（含內建「檔案」tab）/ ↑↓ 都生效                                                                                                                                                                                                                                                                                                                                           |
| 左欄分割槽（最近專案 / 群組；執行的對話與歷史已併入專案樹）  | `LeftPanel.tsx` 按 `web/src/left-sections.ts` 的計劃渲染：順序與顯隱走宿主 `leftpanel.sections` 的條目（`host:lp-projects` / `host:lp-groups`，佈局頁可勾選 / 調序；外掛 arrange 可隱藏，不能挪走）。`host:lp-running` / `host:lp-history` 兩個條目仍在登錄檔裡（`leftpanel.running` / `leftpanel.history` 行內插槽與外掛 arrange 相容用），但 `sectionNodes` 的 `convs` / `sessions` 恆為 `null` —— 執行中與歷史會話都在「最近專案」樹內按時間分組渲染，所以這兩條不再進佈局頁（`HIDDEN_FROM_LAYOUT_ITEM_IDS`）。 | 勾掉 → 整區不渲染、不佔權重；上下調序生效（分隔條按可見分割槽重新配對）。專案區塊頭的「專案 / 群組」tab 與群組分割槽的顯隱同源：勾掉群組分割槽，該 tab 一併消失，記憶的模式回落 `projects`。                                                                                                                                                                                   |
| 檔案預覽頭欄                                                 | `FilePreview.tsx` 的 `.fp-head-actions`：宿主 9 項＋外掛按 slot 順序交錯                                                                                                                                                                                                                                                                                                                                                                                                                                           | 勾掉 / ↑↓ 都生效（markdown/html/編輯/換行/縮放仍受檔案型別條件約束）                                                                                                                                                                                                                                                                                                           |
| 目標條                                                       | `GoalBar.tsx`：編輯行（設目標/提煉/鎖定/收起）/ 選項行（審查模型/輪次）/ 活躍行（清除）/ 收起 pill 四簇分別按 slot 排序，外掛跟隨同行                                                                                                                                                                                                                                                                                                                                                                              | 勾掉 / ↑↓ 都生效（pill 全藏且無外掛條目時整條不佔位）                                                                                                                                                                                                                                                                                                                          |
| SCM 面板                                                     | `SCMPanel.tsx`：頭欄（檢視 tab/重新整理＋外掛）與分支行（分支/切換/推送/拉取/提交輸入/提交/全部提交）分別按 slot 排序                                                                                                                                                                                                                                                                                                                                                                                              | 勾掉 / ↑↓ 都生效（分支名展示是純資訊不進槽位；底部「去終端」按鈕只跟顯隱）                                                                                                                                                                                                                                                                                                     |
| 終端面板                                                     | `TerminalPanel.tsx`：命令列表頭（重新整理/新建）與終端 tab 頭（新建＋外掛）分別按 slot 排序                                                                                                                                                                                                                                                                                                                                                                                                                        | 勾掉 / ↑↓ 都生效（命令/標籤行是資料，不動）                                                                                                                                                                                                                                                                                                                                    |

頂欄沒有結構性容器劃分：整條按 slot 順序直排（連續同類才成組裹容器，組間順序即 slot 順序），佈局頁的 ↑↓ 跨
品牌/檢視/工具真實換位（預設順序號即舊版視覺順序：history 鎖釦首位、new-chat/files 工具組之尾，見
`BUILTIN_UI_ITEMS` 註釋）。面板內部同理按簇劃分（SCM 頭欄↔分支行、終端雙頭、目標條四態各行、左欄縱向分割槽）。
`uiPrimary` 完全沒傳時（單測 / 未來別的呼叫方）渲染層退化為「按內建預設順序全畫」，不會因為拿不到 slot 資料就把頂欄清空。

### `host.ui.*`：執行時註冊

| 方法                | 語義                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `register(items)`   | 註冊 / 覆蓋條目（同 id 覆蓋 manifest 宣告的，單次最多 32 條），返回登出函式（把本次註冊的 id 移進 `removed`）                               |
| `update(id, patch)` | 部分更新一個**當前生效**的條目（manifest 的與執行時註冊的都算；不存在的一律忽略，防外掛憑空造條目繞過宣告審查），典型用途是重新整理 `badge` |
| `remove(id)`        | 移除條目 —— manifest 宣告的也能移除（id 記進 `removed`，合併時不會復活，直到 reload 重新解析）                                              |
| `arrange(ops)`      | 追加整理意圖（與 manifest 的 `arrange` 順序拼接），只改已存在的條目並留痕 `arrangedBy`                                                      |
| `list()`            | 當前生效的貢獻快照 `{ items, arrange }`（除錯 / 自查用）                                                                                    |

生效結果 = manifest 基線 + 執行時註冊（同 id 覆蓋、`removed` 刪除），隨 `plugins` 清單的
`UiPluginInfo.ui` 下發；每次 `register` / `update` / `remove` / `arrange` 都重推一次清單。註冊時的 slot
解析與 manifest **同一套口徑**（先對映別名、再校列舉）—— 早期執行時註冊少了這一層校驗，外掛寫個別名
（或寫錯）會得到一個前端不認識的 slot，表現為「註冊了但介面上沒有」，最難排查。

### 內建條目的實現留在元件裡（踩過的坑）

App 只分發**外掛**動作（`triggerPluginUiAction`：先找該外掛名下的處理器，再按需載入它的 client bundle
後重試，都沒人接管就提示一句）；`host:*` 內建條目的實現住在渲染 / 開啟它的那個元件裡，由元件按
`entry.id` 自己分派 —— 例如 `host:file-add-root` / `host:file-open-project` 在 `RightPanel.tsx`、
`host:conv-force-dismiss` 在 `LeftPanel.tsx`、`host:msg-edit-reask` 在 `Message.tsx`。原因：這些動作
需要元件自己的上下文（右鍵的是哪個目錄、哪條對話、訊息的附件與重問邏輯），App 拿不到。右鍵選單因此還
要在開啟時把「host 條目分派器」（`onHostAction`）隨請求交給 `web/src/context-menu-state.ts` 的全域性唯一
選單狀態。**踩過的坑**：早期把內建條目也當外掛動作統一交給 App 分發，那些點選全都沒反應（App 不知道
上下文，只能靜默失敗）。

### 彈窗（`modal.dialog`）

第 22 個槽位：外掛宣告 `kind="view"` 的條目，經宿主橋按需彈成彈窗（`PluginModal.tsx`）。

```json
{
	"permissions": ["ui"],
	"ui": {
		"modal": [{ "id": "preview", "label": "預覽", "kind": "view", "view": "plugin:my-plugin" }]
	}
}
```

```js
// client/entry.mjs：某個按鈕點一下彈自己的彈窗，關由使用者（Esc/遮罩/✕）或 closeModal()
window.__piWebUiHost.onUiAction("my-plugin:open", () => {
	window.__piWebUiHost.openModal("my-plugin:preview");
});
```

- 開關走宿主橋 v10（`openModal(id)` / `closeModal()`）：id 是全域性 id（`<pluginId>:<itemId>`），
  不存在 / 被使用者在佈局頁隱藏 → 返回 `false`；同一時刻只開一個（後來者頂掉先開者）。
- 內容按 kind 分發：`view` 掛外掛檢視（bundle 按需載入，沒好先轉 loading，與頂欄動作同一條
  `ensurePluginViewLoaded`）；其它 kind 落成單個大按鈕（點了回 `onUiAction` 並關彈窗）。
- 開關狀態是瀏覽器本地態（不進快照、不進 layout）：重新整理即關；`hidden` 只管“能不能開”。
- 佈局頁有獨立“彈窗”分組（可隱藏條目；排序無意義——彈窗一次只開一個）。

## 目錄授權與跨目錄 fs（issue #146）

`host.fs` 有兩條腿，分工明確：

- **工作區相對**（`list` / `read` / `readText` / `write` / `remove`）：`WorkspaceFS`，路徑錨定**活 cwd 根**
  （跟隨 `set_cwd`），越界拒絕。
- **跨目錄**（`listPath` / `readPath` / `readTextPath` / `writePath` / `removePath`）：錨定「使用者點過頭的
  目錄」，每次操作都要求路徑已授權，否則拋錯 —— 錯誤資訊直接告訴你先 `await host.fs.requestAccess(dir)`。

**授權流程**（`requestAccess(dir, reason)`）：

1. 路徑歸一（`normalizeGrantPath`：只收**絕對路徑**，相對路徑直接拒絕）→ 落在工作區內（cwd + 額外工作
   區根）或已在授權表裡 → 直接返回 `true`，**不打擾使用者**。
2. 否則服務端向**所有線上客戶端**推 `plugin_path_request`（`{ id, pluginId, path, reason? }`），瀏覽器彈
   確認框（`App.tsx`），使用者答覆經 `plugin_path_response` 回傳 —— **只等第一個答覆**；未答覆 120 秒超時
   視為拒絕。
3. 同意即寫進授權表 `<dataDir>/plugin-grants.json`（`server/plugin-grants.ts` 的 `PluginGrantsStore`），下次
   不再問；`authorizedDirs()` 返回本外掛當前被批准的目錄。

**授權表語義**：全域性共享（不是 per-client —— 授權是「這臺機器上的這套外掛配置允許訪問哪些目錄」，任何
瀏覽器看到的都是同一份）；**父目錄授權覆蓋子目錄**（目錄授權天然是子樹授權，否則使用者只會一路盲點同意），
反向不成立（只批了 `/proj/a` 時訪問 `/proj` 仍要問）；判定按路徑分段邊界做，不做裸字首匹配（`/proj` 不
覆蓋 `/project`）；win32 比較折大小寫，但**儲存保持寫入時的形式**；讀不出來 / JSON 壞 / 形狀不對一律當
空表，且**不在讀路徑回寫**（否則一次磁碟抖動就靜默清空使用者全部授權）；只有真正發生變更的寫才落盤
（臨時檔案 + rename 原子寫），寫失敗 best-effort（記憶體態仍生效，本次會話可用）。

**受支援路徑 = 工作區（cwd）+ 額外工作區根 + 該外掛的已授權目錄**，其餘一律拋錯。這與「外掛自己
`import node:fs` 碰任意路徑」的差別就是宿主能強制的那一層 —— 外掛的服務端程式碼本身是全權 Node 程式碼，要
真正限制得靠 OS 沙箱（不在本專案範圍），所以這裡的價值是讓受支援路徑覆蓋更多場景，同時保證「使用者知情 +
可撤銷」。

**撤銷**：設定面板「介面外掛」頁的「已授權目錄」段列出授權表並逐條撤銷（`plugin_path_revoke`；協議上還
支援按外掛清空、整表清空）。另外瀏覽器裡還有一份 localStorage 記錄（`pi-web-ui:plugin-path-grants`，見
`App.tsx`）—— 那是**宿主動作橋**為了避免每次 `openSession` / `sessions.open` 都彈框而記的（「最近專案」
裡的目錄同樣視為已知、不彈框），與外掛自己 `host.fs` 用的服務端授權表是兩回事。

## 能力動態授權（host.requestPermission）

manifest 管“有沒有這個能力族”（靜態），這張表管“執行時的具體範圍”（動態）：

```js
// net：在白名單之外再加主機（免改 manifest 重灌）
if (await host.requestPermission({ family: "net", hosts: ["api.example.com"], reason: "同步筆記本" })) {
	await host.net.fetch("https://api.example.com/notes");
}
// llm：把模型作用域交給使用者定（空 models = 不限）
await host.requestPermission({ family: "llm", models: ["openai/gpt-4o-mini"], reason: "只用便宜模型總結" });
```

- **前置**：基礎族必須已宣告（net→`net`、llm→`llm`），否則直接 `false` 不彈框——與
  `requestAccess` 要求 `fs:read` 同口徑。執行期強制：`net.fetch` 查靜態白名單**或**動態表；
  `llm.complete` 宣告即全開，但有模型作用域授權時收緊到批准的模型。
- **流程**：靜態命中/已有授權 → 直接 `true`；否則經 `permissionRequester` 向所有線上客戶端推
  `plugin_permission_request`，等第一個答覆（120s 超時=拒絕；答覆後推 `plugin_permission_resolved`
  讓其它端收起）。`remember=true` 落盤 `<dataDir>/plugin-permissions.json`，否則只記記憶體（重啟即失）。
- **審計/撤銷**：`plugin_permissions` 快照（attach 推 + 變更重推，session 授權帶標記），設定面板
  「已授權能力」段逐條撤銷（`plugin_permission_revoke`，支援按外掛/按族/按主機或模型/整表清空）。
- DSH/無瀏覽器時一律 `false`。實現：`server/plugin-permissions.ts` + `PluginManager.permGrants` +
  `index.ts` 接線（與目錄授權同構）。

## 定時任務持久化（host.schedule 的 persistent）

```js
host.schedule("0 9 * * *", sendDailyReport, { persistent: true, id: "daily", catchUp: "once", label: "日報" });
```

- 宣告從“分鐘步長”升級到**全 5 欄位 cron**（分 時 日 月 周，月/周支援英文名，日-周標準 OR 語義，
  伺服器本地時區；舊 `"*/N * * * *"` 是子集照常工作）。毫秒數字仍收（記憶體版底線 10s，持久版 60s）。
- **引爆方式是分片的 setTimeout**：`armDelay()` 把「距離下次觸發」切成 ≤6 小時的分片，醒來重算，
  真到點才觸發；`nextCronFire` 在「一年內沒有下一次」（如 `0 0 31 2 *`）時回 `null`、
  後臺面板顯示「不再觸發」。原因：Node 的 setTimeout 延遲超過 2^31-1ms（≈24.8 天）會溢位成 1ms，
  配上「下次在 42 天/一年後」的合法表示式就是「1ms 後再觸發」的死迴圈（觸發還會回撥外掛 →
  寫盤 + 廣播）。迴歸：`tests/plugin-cron-overflow-test.mjs`。
- `persistent: true` 必須帶合法 `id`：宣告 + `lastRun` 落盤 `<pluginDir>/schedules.json`，每次
  `activate` **重調** `schedule()` 即重建（冪等：保留 `lastRun`/`createdAt`，只更新宣告）。
  反啟用只停表不斷持久化；`off()`/面板停止 = 刪宣告（不再復活）。
- `catchUp: "once"`（預設 `"skip"`）：重啟發現漏跑（以上次觸發/建立時間錨，下一次已在過去）
  15s 緩衝後補跑一次（等模型/網路就緒）。
- 持久任務自動進頂欄「後臺任務」面板（⏰ + 下次時間，可停止）。實現：`server/plugin-schedule.ts`
  （解析/下次觸發/落盤，純函式單測）+ `plugins.ts` 接線。

## 專案組裝 API（host.project.create，issue #146）

讓外掛把「幾個倉庫 + 若干配置檔案」拼成一個工作區。**前置**：外掛要有 `fs` 能力族，且目標目錄在工作區內
或已授權（否則返回 `{ ok: false, error: "專案目錄未授權：先 await host.fs.requestAccess(...)" }`）。

```js
const res = await host.project.create({
	dir: "/abs/path/to/workspace", // 必須**已存在**的絕對路徑（本 API 不建立新的根）
	repos: [{ url: "git@github.com:me/app.git", subdir: "app", ref: "main" }],
	files: { "app/.env.example": "FOO=1\n" }, // 相對路徑 → 文本（≤1MB/個、≤32 個）
	gitInit: false,
});
// res = { ok, error?, log, dir }；log 是逐行執行日誌，進度同時以 notify 廣播到瀏覽器
```

執行順序：校驗根目錄 → 校驗 `repos` / `files`（**純計算，全部在動磁碟之前**）→ `mkdir` 子目錄 →
`git clone --depth 1 [--branch <ref>]` → 寫檔案 → 可選 `git init`。三條硬約束：

- **越界拒絕**：`subdir` 與 `files` 的 key 一律按相對路徑解析，resolve 後必須仍在 `dir` 之內（拒絕絕對
  路徑與 `..`），並用 realpath 複核目標（或它最近一個已存在的祖先）—— 防 junction / 符號連結把寫入引到
  目錄之外；`replace: true` 不允許用在專案根（那是刪使用者自己的目錄，不是「清空一個子目錄」）。
- **不注入選項**：git 走 `spawn`、不過 shell；URL 以 `-` 開頭直接拒絕（`--upload-pack=` 這類能讓遠端執行
  任意命令的選項注入，argv 陣列擋不住）；git 子程序關掉一切互動式提問（`GIT_TERMINAL_PROMPT=0` /
  `GCM_INTERACTIVE=never` / ssh `BatchMode`），單條 git 命令 5 分鐘超時後連坐整棵程序樹 —— 服務端沒有
  TTY，互動式認證會掛死到看門狗超時。
- **失敗不留半成品**：任何一步失敗立即停，返回 `{ ok: false, error, log }`（第一個失敗點的原因 + 已走過
  的步驟），不吞錯、不假裝成功；一個半成品專案配上「成功」比直接報錯更壞。

組裝完的目錄就是個普通目錄 —— 接下來由外掛自己決定去向（例如 `host.openSession({ cwd, roots })` 開一個
新會話，或 `set_cwd` 切過去）；`host.project.create` 不做任何隱式的切專案 / 開對話。

## 外掛 HTTP 請求的工作區歸屬

檔案預覽的 `ctx.apiUrl()` 自動攜帶當前標籤頁的 `clientId`。宿主根據該客戶端捕獲 cwd 和額外根，並通過 `AsyncLocalStorage` 貫穿整個非同步 HTTP handler；`host.cwd`、`resolveInWorkspace` 和宿主檔案訪問使用此請求快照，不受其他標籤頁切專案影響。顯式提供未知客戶端時拒絕請求；未提供客戶端的舊介面繼續使用請求開始時的全域性工作區快照。

## 多根工作區（`set_workspace_roots`，issue #146）

**語義**：AI 仍只在主 cwd 裡幹活（pi SDK 是單 cwd 模型，多根**不**等於多工作區）；額外根隻影響兩件事
——「哪些路徑算工作區內」（外掛的受支援路徑）與右欄檔案樹的根（一次只展一個根，不做合併檢視）。

- **協議**：上行 `set_workspace_roots { roots? }`；快照欄位 `UiState.workspaceRoots`（兩個引擎都下發；DSH
  引擎沒有外掛宿主，多根只讓檔案樹受益）。空陣列 = 回到單根。
- **歸一化**（`server/client-state.ts`：`normalizeWorkspaceRoots` / `MAX_WORKSPACE_ROOTS = 8`）：只收絕對
  路徑、去重（win32 折大小寫）、上限 8 個（不含主 cwd）、resolve 成規範形式；髒元素（數字 / 空串 / 物件）
  逐個丟棄而不是整份回落。刻意**不校驗目錄是否存在**：根可能是暫時斷開的盤或掛載點，不該把使用者設過的根
  靜默清掉。
- **按專案持久化**：存在 client-state.json 的 `workspaceRoots[cwd]`，切專案就換成該專案自己那套；空陣列會
  清掉該專案的鍵（不留空殼）。重複寫同一份 = no-op（不推快照、不打擾外掛）。
- **前端**：右欄 crumbs 裡的**根選擇器**（有根才渲染；列出主根 + 各額外根，可逐條移除 —— 移除正在瀏覽的
  那個根會退回主根）。**兩個加根入口**：檔案樹右鍵「新增為工作區根」（只對目錄行可見，已在列或就是主根時不顯示）、
  底欄 cwd 選擇器頭部的「＋ 新增為工作區根」（把當前瀏覽的目錄加成根 —— 底欄本來就是改工作目錄的地方，使用者找得到）。
  增刪都走 `set_workspace_roots` 整份寫回，服務端的值是唯一事實源。
- **外掛側影響**：`PluginManager.isInsideWorkspace()` 把 cwd 與**全部額外根**都算「工作區內」⇒ 這些根在
  `host.fs`（跨目錄族）與 `host.project.create` 裡**免授權**（使用者加根 = 「我認它是我工作區的一部分」）。
  根變化經 `notifyWorkspaceRoots` 同步給外掛宿主；刻意**不發** `onCwdChange` 鉤子 —— 那個鉤子的語義是
  「當前目錄變了」。
- **為什麼不放 localStorage**：多根不是純 UI 偏好 —— 服務端的外掛宿主（`isInsideWorkspace`）要據此決定
  哪些路徑免授權，所以事實源在服務端、隨快照下發（順帶得到多標籤頁一致與按專案持久化）。反過來，外掛
  **不能**自己加根：`set_workspace_roots` 是宿主側（使用者）動作 —— 正因如此，`host.openSession` 的 `roots`
  裡每個目錄都要先過使用者授權確認，不能拿 roots 當側門。

## 專案 / 會話 API（host.openSession / host.sessions，issue #146）

`startChat({ prompt, cwd })` 是「已受理」的短形式（向後相容）；需要等結果、需要目錄授權、需要多根時用
可等待版本：

```js
const res = await host.openSession({ roots: ["/repo/a", "/repo/b"], prompt: "先看 README" });
// res = { ok: true, sessionId } | { ok: false, error }
```

- `cwd` / `folders` / `roots` 都給**絕對路徑**：`cwd` 優先，否則取 `folders` / `roots` 的第一個當 cwd，
  其餘目錄當**額外工作區根**（最多 7 個，見「多根工作區」）。
- 目錄**不在最近專案裡**、本瀏覽器也沒授權過時，宿主先彈確認框（確認結果記在瀏覽器 localStorage
  `pi-web-ui:plugin-path-grants`）；**每個額外根也要過這一關**（成了工作區根就意味著外掛讀它不必再授權，
  不能讓 `roots` 當側門）。使用者拒絕 → `{ ok: false, error }`，當前會話與工作區不會被破壞。
- 順序：授權 → 切 cwd（等服務端快照跟上）→ 寫額外根（**在切專案之後**寫：服務端按專案存根）→ 開新對話
  （等 activeId 落定）→ 可選發出 `prompt`；每步都有超時（預設 8s），超時 / 失敗一律結構化返回
  `{ ok: false, error }`。

**會話列表與開啟**（`host.sessions`，v2 引入）：

| 方法       | 行為                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list()`   | `{ id, title, cwd, kind, isStreaming? }` 陣列：**本客戶端執行中的對話**（`kind:"running"`，id = conversationId，cwd 各自帶）＋ **當前專案的歷史會話**（`kind:"history"`，id = session 檔案路徑，cwd = 當前 cwd —— 服務端的歷史會話列表就是按 cwd 掃的）       |
| `open(id)` | 跨專案先切 cwd（同一套目錄授權；不切就找不到目標檔案）→ `running` 用 `switch_conversation`、`history` 用 `switch_session` → 等 activeId 變化；返回 `{ ok: true, sessionId }` 或 `{ ok: false, error }`（未連線 / 找不到 id / 切換超時都走這條回執，不拋異常） |

## 註冊面目錄（機器可讀，P2-7）

型別唯一事實源 `server/protocol.ts#PluginApiCatalog`，裝配 `server/plugin-api-catalog.ts`（靜態 slot 例子+宿主方法表，單測鎖住與原始碼同口徑），佔用者由 `PluginManager.getApiCatalog()` 現算（manifest 基線+執行時註冊合併計數，只含條目數不含內容）。下發走 WS 只讀查詢 `plugin_api_catalog` → `plugin_api_catalog_result`（`requestId` 回顯，不進快照/清單，按需拉）。給將來「AI 寫外掛」鋪路（能力發現與執行分離，先查真實 API 再寫碼）；當前消費方是外掛作者與後面的設定面板目錄頁。迴歸：`tests/unit/plugin-api-catalog.test.ts` + `tests/plugin-api-catalog-test.mjs`（已進 run-smoke）。

## 真實外掛

| 外掛          | 目錄                             | 說明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| demo-mailbox  | `plugins/demo-mailbox/`          | 記憶體郵箱 demo，plugin-test 夾具                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| mermaid       | `plugins/mermaid/`               | 📊 ` ```mermaid ` 圍欄 → SVG（renderer 外掛，自帶 vendor 引擎本地優先載入）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| webmail       | `plugins/webmail/`               | 📬 網頁郵箱，IMAP/SMTP 郵件管理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| vscode-editor | `plugins/vscode-editor/`         | 📝 編輯器 + SSH（原獨立外掛合併）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| sftp          | `plugins/sftp/`                  | ☁ 專案級 SFTP 同步：**配置跟著專案走** —— `<專案>/.pi/sftp.json`（多環境 profile）+ `.pi/sftp.local.json`（本機覆蓋，兩層深合併；外掛自動把它加進 .gitignore）；**先算差異再傳**（add / update / same / local-only / remote-only / conflict 六類，`sftp_sync` 預設 dryRun 只回報、顯式 `dryRun:false` 才動檔案）；刪除永不真刪（遠端 `<remotePath>/.sftp-trash/<批次>/`、本地 `.pi/sftp-trash/<批次>/`，內部護欄保證垃圾桶不會被回傳，按 `trashDays` 清理）；併發流式傳輸（`createReadStream`/`createWriteStream`，不再整檔案進記憶體）+ `.sftp-tmp-*` 半成品 + rename 原子落盤 + 傳後大小校驗；憑據只寫引用（`${secret:名}` 走 host.secrets 加密 / `${env:VAR}` / `${file:路徑}`，殘缺引用直接報錯而不是靜默成空密碼），明文僅告警；`mappings` 子樹對映、`compare=mtime+size` 帶 2 秒容差與「無 mtime 就退化為比大小」的告警、遠端 `readdir` 名字防穿越、symlink 跳過、`remotePath=/` 且開刪除時強制降級；**一個** action 式 `sftp` AI 工具（status/save/secret/test/plan/sync/ls/read/write/mkdir/mv/rm/search；拆成十幾個工具只會塞滿上下文）+ 設定頁開 `allowExec` 後才進 enum 的 `exec`（預設關：模型看不見的能力才是真關掉）+ 面板直通的手動 `POST /transfer`（遠端樹每行 ⬇ 下載、工具欄「上傳本地對應目錄」、本地檔案樹右鍵兩條，固定 deletePolicy=none 所以手動推目錄不會清遠端）；檢視 tab（連線管理 / profile 切換 / 差異清單 / 傳輸進度 / 遠端檔案樹與編輯）+ 底欄狀態徽標 + 檔案右鍵「上傳到遠端」；一鍵遷移 `.vscode/sftp.json`（明文口令轉加密機密）。迴歸：`tests/sftp-plugin-test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| db-client     | `plugins/db-client/`             | 🗄️ 資料庫連線管理（mysql2/pg/mssql/sqlite/mongodb/redis）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| run-trace     | `plugins/run-trace/`             | 🧭 執行軌跡時間線：當前對話的橫向泳道時間軸 + 分段分析（host.onRunEvent + getActiveConversation + onConversationChanged）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| legado-web    | `plugins/legado-web/`            | 📖 Legado 閱讀（文本源）：搜尋/發現/詳情/目錄/正文，書源與安卓版相容；內嵌 Vite 前端（`client/app/`，iframe 檢視）+ 自帶 `/proxy`（跨域+GBK）與 `/store`（書源/書架/進度只落資料目錄 `<dataDir>/legado-web/`，不寫 localStorage）+ 四個 AI 修源工具（`legado_rules`/`legado_book_sources`/`legado_source_probe`/`legado_run_rule`，規則引擎跑在 worker 裡，同步 JS 規則走 SharedArrayBuffer 橋）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| wechat-ilink  | `plugins/wechat-ilink/`          | 💬 微信通道：掃碼登入直連微信 ilink 後端（openclaw-weixin 同源協議），出站長輪詢收訊息 + `host.chat` 無頭驅動 agent + run_end 回包，無需公網 IP；陌生人配對 + `wechat_send` 工具；設定可配預設工作空間 / 模型（下拉）/ 思考強度（下拉）/ 投遞到網頁當前會話（issue #226）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| image-toolkit | `plugins/image-toolkit/`         | 🖼 圖片工作臺：壓縮（目標體積二分逼近）/裁剪/縮放/旋轉翻轉/格式轉換/批次 ZIP/水印/濾鏡調色/資訊與 EXIF/剪貼簿與拖放匯入，可讀寫工作區圖片（`/ws/list\|image\|probe\|save\|settings`，走 `host.fs` 越界拒絕，原始位元組不經 base64）+ 四個 AI 工具（`image_info`/`image_transform`/`image_compress`/`image_watermark`，PNG/BMP 用自帶純 JS 編解碼、JPEG 經 `ensureDeps` 裝純 JS 的 jpeg-js）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| notes         | `plugins/notes/`                 | 📌 筆記 · 待辦 · 提醒三合一：筆記（Markdown+標籤+搜尋）/待辦（優先順序/截止/重複）/提醒（一次性·每天·每週·每月·間隔·cron；定時只掛**一條** `host.schedule("* * * * *")` 每分鐘巡檢，每條提醒自己帶 `nextDue` 落盤 —— 遠期 cron 不交給宿主，避開它的 setTimeout 24.8 天溢位，見該外掛 README）；頂欄 📌 開**可拖拽全域性浮窗**（`dom:anchor` 免授權，位置/尺寸/最小化記憶，設定是視窗內的覆蓋層；`view:false` + `preload:true` —— 沒有獨立檢視 tab，但每次進頁預載入 bundle 讓提醒輪詢/快捷鍵常駐）；資料在 `<dataDir>/notes/store.json`（原子寫，刪外掛不刪資料）；通道只用 HTTP（`/plugins-api/notes/store                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | wait | op  | export`，長輪詢推送，不依賴 mount 時的 ctx）；5 個 AI 工具 + `/note` `/todo` `/remind`。迴歸：`tests/notes-test.mjs`/`tests/notes-ui-test.mjs`/`tests/unit/notes-plugin.test.ts` |
| quota-watch   | `plugins/quota-watch/`           | 📊 訂閱額度看板（**底欄徽標 + 宿主跟隨浮層**，沒有 `ui.modal` / 頂欄檢視 tab、`view:false` + `preload:true`）：當前會話的模型自動對映到**唯一**額度來源（`badge.mjs` 純函式：`deepseek/*`→DeepSeek、`*/claude-*`→Claude、`*/gpt-*` / `codex/*`→Codex、`*/gemini-*`→Antigravity）；**只查當前供應商是刻意的** —— 底欄 60s 輪詢一次，為別家出網既慢又容易撞限流，而使用者要看的永遠是當前模型那一家；認不出模型 / 該來源被關掉時什麼都不查、什麼都不顯示。**底欄不是外掛的 chip**：外掛客戶端（`preload:true`）輪詢 `/summary` 後調 `window.__piWebUiHost.setFooterStatus()` 把文本交給宿主，宿主把它**嵌進內建費用格**（`BarItem.tsx` 的 `host:cost`，DOM `data-bar-item="host:cost-quota"`）用斜槓接續成 `$0.8201 / DS ¥14.46` —— 不另立底欄條目是因為使用者可在「介面佈局」裡排順序，獨立條目的 `order` 保證不了與費用相鄰；無資料時整段不渲染，不留孤立斜槓；外掛停用/移除時 `clearFooterStatusesOf()` 清槽。文本只有當前供應商一段（`providerFromModel` 認出哪家就只查哪家；當前這家自己壞著時照樣給故障碼：⇅ 網路不可達 / ≠ 登入失效 / ! 查詢失敗 / — 未登入）。**點它的小卡片是宿主渲染的**：外掛只給 `content.render(container)`（`client/card.mjs`，穩定引用），浮層外殼 / 定位（預設貼錨點上方、塞不下翻轉、夾進視口）/ 跟隨 / 點外與 Esc 關閉 / `z-index: 9000` 全在宿主（`components/FooterSlotPopover.tsx`）；卡片裡的 `⟳` 走 `?force=1`；其餘：**服務端**讀本機 CLI 登入態（`~/.gemini/antigravity-cli`、`~/.antigravity_tools/accounts`、`~/.claude/.credentials.json`、`~/.codex/auth.json`，DeepSeek 依次取設定 → `DEEPSEEK_API_KEY` → `~/.pi/agent/{auth,provider-keys}.json`），過期 access token 只在記憶體裡用 refresh_token 續期（**不回寫憑據檔案**）；四個 provider 各自把廠商視窗歸一成 `{ usedPercent, remainingPercent, resetAt }`（Antigravity `remainingFraction`、Claude `utilization`、Codex `used_percent`+`limit_window_seconds`），換供應商時快取按供應商失效、不會拿上一家的數字糊弄；`GET /summary?force=1` 供彈窗與工具共用**一份**快照（服務端按來源分檔快取：訂閱型按設定 5 分鐘、餘額型 60 秒，並回傳 `updatedAt/staleMs/ttlMs/lastGoodAt`）；客戶端只有一份資料來源 `client/store.mjs` —— 底欄與浮層訂閱同一快照，浮層裡點 ⟳ 兩邊同幀更新（舊實現各拉一次，才會「點了重新整理底欄不動」），浮層開著 15s、閒著 60s，採集失敗時保留上次成功的數字並標 `stale`（底欄徽標仍給故障碼，不偽造健康餘額）；action 式 `quota_status` 工具讓 AI 直接查額度。出站只走 `netAllowlist` 列出的主機。迴歸：`tests/unit/quota-watch.test.ts` + `tests/unit/quota-watch-card.test.ts` |
| pm2-manager   | `plugins/pm2-manager/`           | 🚀 程序管家：用 pm2 統一託管 AI 的後臺任務 —— 註冊 action 式 `pm2` 工具（list / start / stop / restart / delete / logs / describe / install / version，description/snippet/guidelines 三處引導「長期任務走 pm2 更省心」）+ 內嵌進宿主「後臺任務」面板（`view:false` + `ui["tasks.panel"]` 一條 kind="view"，與宿主自己 diff 出來的後臺程序同一面板：狀態/CPU/記憶體/重啟/時長、日誌、停止/重啟/刪除、未裝 pm2 一鍵 `npm i -g pm2`）；跨平臺一律走「`process.execPath` + pm2 的 JS 入口」，不碰 Windows 的 `.cmd` 墊片與 PATH。**刻意不接管**：不對 bash 做任何攔截或追加提示（無 `onToolPre` 閘門、無 `#bg-ok` 逃生門、無 `onToolPost` 催辦），管不管由模型與使用者自行決定。迴歸：`tests/pm2-manager-plugin-test.mjs` / `tests/unit/pm2-manager.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| page-picker   | `plugins/page-picker/extension/` | 🎯 網頁元素拾取（**瀏覽器擴充套件**，不是 pi-web-ui 外掛）：在開發網頁上點選元素 → 採集定位串 / 命中的 CSS（Vite dev 下含原始檔行號）/ React fiber 裡的元件檔案:行號 / 計算樣式差異 → 渲染 Markdown → 經宿主動作橋 `compose()` 注入 pi-web-ui 輸入框（`world:"MAIN"` 注入 + 閉合 Shadow DOM overlay；esbuild 打包 4 個入口 background/picker/bind/options，`npm run build:extension`）。點圖示**先認頁面**：是 pi-web-ui（宿主動作橋 `__piWebUiHost`，老版本退一步探同源 `/api/health`）→ 注入 `bind.js` 浮條問「要不要把這頁綁成服務地址」（遠端/區域網部署不用手打地址；缺授權則引導到帶 `?bind=` 的選項頁 —— `permissions.request` 要擴充套件自己頁面裡的手勢），否則注入拾取器（拾取態底部常駐一條**細條**：本頁 AI 授權狀態 + 「讓 AI 操作本頁…」/「與另一頁配對…」/「退出」—— AI 授權入口不再需要先點一個元素才從確認條裡露出來；狀態經 `page-picker:page-state` 查，授權表變化時自刷）。「發哪幾類資訊」是**多選**（頁面上下文/定位/XPath+DOM/原始碼/文本/命中 CSS/計算樣式/骨架 + 截圖，另配 6 個預設），**沒勾的在採集層就不採**（不是渲染時再刪）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## 迴歸測試

| 測試檔案                                   | 埠          | 說明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui-layout-ui-test.mjs`                    | 隨機        | 佈局不變數 E2E（真 Chrome，48 checks）：外掛 arrange 藏宿主條目 / 外掛條目與宿主同排 / 右欄 tab 順序 / 勾掉與 ↑↓ 真的生效 / 隱藏的選單型條目在溢位選單裡還能用 / 訊息工具條整條不畫 / **佈局診斷橫幅出現且點名外掛與目標 id（P0-1）**（缺 Chrome 自動 SKIP，不入 run-smoke）                                                                                                                                                                                                                                                                                                                                                 |
| `plugin-topbar-ui-test.mjs`                | 隨機        | 外掛頂欄條目（#146）+ 設定面板內後臺解除安裝（#152）E2E：`ui.topbar` 宣告的按鈕渲染 / 點選按需載入 bundle 並命中宿主動作處理器（用舊名別名 `host.onTopbarAction` 註冊）/ 設定面板出現「介面佈局」管理段與「原始碼構建」勾選項 / 解除安裝走 plugin_job 且**面板全程不關** / 頁面無 JS 報錯（缺 Chrome 自動 SKIP，不入 run-smoke）。實測 **10 checks 全過**                                                                                                                                                                                                                                                                    |
| `plugin-jobs-test.mjs`                     | 隨機        | 外掛後臺作業（#152）+ 市場目錄同步（#148）：非法來源即時拒絕 / 真解除安裝成功（成功後重推列表）/ 解除安裝不存在→失敗回執帶輸出尾部 / 本地 JSON 同步→原子寫盤+推新條目 / 壞 JSON 不覆蓋舊目錄                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `plugin-settings-page-test.mjs`            | 隨機        | `settings.pages` 外掛頁 E2E（真 Chrome，12 checks）：manifest 宣告的頁進設定面板導航 / `hidden:true` 的預設不在導航裡 / `mount()` 渲染進畫布 / 切走即解除安裝並調 cleanup / 再點回來重新掛載 / 佈局頁列出它並可隱藏（隱藏後當前分割槽回落預設頁、不留空白）/ 頁面無 JS 報錯（缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                                                                                           |
| `plugin-settings-select-ui-test.mjs`       | 隨機        | 外掛設定表單 select 下拉 E2E（真 Chrome，11 checks）：靜態 `options` 照常渲染 / `optionsFrom: "models"` 列已配置鑑權的模型且首項 = 跟隨全域性預設 / `optionsFrom: "thinkingLevels"` 列 SDK 全檔位（i18n 文案）/ 選中儲存後 storage.json 落的是選中值 / 無 JS 報錯（缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                                                                                                     |
| `context-menu-ui-test.mjs`                 | 隨機        | 右鍵選單 E2E（真 Chrome，44 checks，實測全過）：檔案樹 / 列表空白處 / 左欄歷史會話 / 執行的對話四條路徑的選單（條目按上下文增刪：「以專案開啟」只對目錄行、「新增為工作區根」只在可加時出現、歷史行沒有「強行關閉對話」）/ 加根後出現根選擇器且能切根 / 「強行關閉對話」兩段確認（第一次點選單不關）/「以專案開啟」真的切了 cwd / 頁面無 JS 報錯（缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                      |
| `workspace-roots-test.mjs`                 | 隨機        | 多根工作區協議 E2E（已進 run-smoke，11 checks）：加根前外掛讀工作區外路徑被拒（提示未授權）→ `set_workspace_roots` 落進快照 → 同一路徑放行（免授權）/ 髒元素（相對路徑、非字串）丟棄 / 根列表是**覆蓋**語義不是並集 / 按專案持久化（切走清空、切回還在）/ 空陣列回到單根（又需要授權）                                                                                                                                                                                                                                                                                                                                       |
| `plugin-test.mjs`                          | 8978        | 清單推送 / message 迴環 / 靜默丟棄 / 靜態服務 / 路徑穿越拒絕 / 外掛市場（plugin_catalog add/remove 迴環 + 內建條目）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `plugin-command-test.mjs`                  | 8979        | 外掛命令全鏈路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plugin-http-test.mjs`                     | 8981        | host.route 全鏈路（GET/POST/404/500/非同步 handler 拋錯轉 500 不打掛進程）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pm2-manager-plugin-test.mjs`              | 隨機        | pm2 程序管家 E2E（已進 run-smoke）：manifest 被宿主接受且無啟用錯誤 / `ui["tasks.panel"]` 佔位併入後臺任務面板（`kind=view`）/ 服務端入口真啟用 / `GET /status` 回結構化狀態（installed + platform + installCommand）/ `POST /action` 擋非法入參 / 已刪的 `POST /scan` 真回 404（遺留例項交給宿主面板）                                                                                                                                                                                                                                                                                                                      |
| `sftp-plugin-test.mjs`                     | 隨機        | 專案級 SFTP 外掛 E2E（已進 run-smoke，95 項斷言）：配置解析 + 憑據脫敏（state 不含明文）/ 連通性與寫許可權探測 / 差異計劃（預設 ignore 生效、遠端獨有項給出「為什麼不清理」）/ dry-run 一個位元組不動 / 真執行落盤且不留半成品 / 刪除進垃圾桶且垃圾桶不被回傳 / `${secret:}` 與 `${env:}` 引用 + 錯誤引用顯式報錯 / 遠端 CRUD / 路徑越界與非法 remotePath 拒絕 / down 覆蓋、both 互補不刪、mappings 子樹對映 / `.vscode/sftp.json` 遷移後明文不入庫 / 單個 action 式工具與 `exec` 開關 / 手動 `POST /transfer`（單檔案上下傳、遠端目錄反查本地目錄、永不動刪除策略）/ `scope=tree` 的遠端路徑 / `allowExec` 開時遠端命令真跑 |
| `plugin-proxy-test.mjs`                    | 8984        | 通用代理 + live-preview 全鏈路（/liveserver 首頁/相對子資源/md 渲染/目錄列表/404/越界隔離/Range 206/SSE 首幀）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `plugin-bgtask-test.mjs`                   | 8982        | registerBackgroundTask 全鏈路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `plugin-leftpanel-running-test.mjs`        | 8985        | 左欄外掛執行條目全鏈路：登記推送 / attach 補發全量 / clear 廣播 / 心跳過期整組清空（P3）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `plugin-settings-test.mjs`                 | 8983        | 宣告式設定 schema 校驗/持久化/回顯（含 `optionsFrom` 動態候選值透傳 + 不校驗值）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `plugin-cwd-test.mjs`                      | 8989        | set_cwd→notifyCwd→廣播全鏈路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `mcp-bridge-test.mjs`                      | 8990        | MCP 伺服器握手/工具呼叫/失敗隔離（10 工具）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fence-render-test.mjs`                    | 隨機        | renderer 外掛 E2E：```mermaid → SVG（本地 vendor）、無外掛語言回退（缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `plugin-update-test.mjs`                   | —           | install/check-updates/rollback 全鏈路                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ssh-plugin-test.mjs`                      | 8964        | SSH 遠端檔案/終端全鏈路（mock SSH 服務端）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `db-client-test.mjs`                       | 8968        | SQLite 全鏈路協議冒煙                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `legado-web-test.mjs`                      | 8993        | legado-web：內嵌前端靜態託管 / 代理（UTF-8+GBK、charset 驅動的 URL 與 body 編碼、瀏覽器頭不外洩、上游失敗 502）/ 儲存讀寫與非法鍵                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `legado-web-engine-test.mjs`               | 8995        | legado-web AI 修源介面：工具註冊 / 書原始檔讀寫 / 鏈路診斷（含 step 單步）/ 試規則 / 單段 CSS 規則迴歸 / 同步 `java.ajax`（零 token）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `legado-web-ai-fix-test.mjs`               | 8996        | legado-web 「AI 修復源 / 新建書源」按鈕 E2E：harness 頁充當宿主（假 `__piWebUiHost`）+ 內嵌閱讀頁點按鈕 → 正文含現場 / 切 chat / 新對話 / cwd=書源目錄（書源頁 + 發現頁 + 新建；缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `legado-web-explore-test.mjs`              | 8998/8999   | legado-web 發現頁：收藏書源（下拉「⭐ 常用」分組 + 常用快捷行 + `prefs.json`）/ 直接搜這個源 / 分類瀏覽與搜尋共用列表容器互不串味（缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `legado-web-storage-test.mjs`              | 8997        | legado-web 儲存契約：資料只落資料目錄檔案——1.8MB 書源 + 3000 章書架不報 QuotaExceededError / localStorage 無 `legado.*` 鍵 / 重新整理後仍在 / 老瀏覽器資料一次性遷移 / 書源頁搜尋與 ⭐ 置頂落 `prefs.json`（缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                                                                                                                                                            |
| 單測 `plugin-host.test.ts`                 | —           | 宿主動作橋：startChat 時序（等 cwd/等新對話才發 prompt）/ 未就緒拒絕 / newChat=false / compose 不依賴連線就緒                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 單測 `plugin-effects-install-spec.test.ts` | —           | **effect 棧**（逆序回捲 / 單條撤銷冪等 / cleanup 拋錯隔離與歸因 / release 冪等；真實 `PluginManager` 反啟用後工具·命令·路由·檔案監聽·匯流排訂閱·自建 effect 全回收，`effects.size` 歸零）+ **安裝前 inspect**（`parseInstallSpec` 形狀分類 / `inspectLocalInstallSpec` 已裝與路徑判定 / `inspectInstallSpec` 遠端探測四種 problem，fetch 替身零網路）                                                                                                                                                                                                                                                                        |
| 單測 `ui-slots.test.ts`                    | —           | slot 合併引擎（含 **diagnostics** 6 例：未知 slot / 未知 kind / 未知 when / arrange 目標不存在 / 外掛停用或啟用失敗 / 重複宣告的診斷與不誤報）：內建條目表自檢（id 字首、文案 key 存在、`settings.pages` 不列內建）/ 四級優先順序逐層覆蓋（含同 id 覆蓋但位置不變、arrange 只改已存在並留痕、使用者偏好最高）/ `splitOverflow` 不重排不丟 / 恢復語義（單條清乾淨、不留空殼）                                                                                                                                                                                                                                                 |
| 單測 `plugin-ui-manifest.test.ts`          | —           | manifest `ui` 解析（39 例）：兩種形狀與混寫、6 個別名對映、非法條目 / 重複 id / 非列舉 slot 丟棄、children 只一層、文本截斷、arrange 形態與上限；`host.ui.*` 執行時註冊（同 id 覆蓋 manifest、登出、update 只改已存在、remove 不復活、單次上限、能力門控三態）                                                                                                                                                                                                                                                                                                                                                               |
| 單測 `context-menu.test.ts`                | —           | 右鍵選單純函式：座標鉗制、hidden 跳過與 divider 保留、分組聚類與穩定排序、置灰判定（`disabled` / `!` 字首）、鍵盤環形導航與越界處理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 單測 `plugin-grants.test.ts`               | —           | 授權表：父目錄覆蓋子目錄（按分段邊界，`/proj` 不覆蓋 `/project`）、反向不成立、win32 折大小寫但儲存保原形式、壞檔案視為空表且不被改寫、三種撤銷粒度、非法 pluginId/相對路徑拒絕                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 單測 `plugin-project.test.ts`              | —           | 專案組裝：clone / 寫檔案 / git init 全流程與進度回撥、越界（絕對路徑 / `..` / 符號連結 realpath）與 `-` 開頭 URL 拒絕、replace 不能用於根、超時與多倉庫中途失敗都不留半成品                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 單測 `workspace-roots.test.ts`             | —           | 多根（13 例）：歸一化（絕對路徑 / 去重 / 上限 8 / 髒元素逐個丟）、按專案與按客戶端隔離讀寫、宿主側 `isInsideWorkspace` 把根算進去、切專案不影響已設的根且 `notifyWorkspaceRoots` 冪等                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 單測 `composer-bridge.test.ts`             | —           | 輸入框注入橋：sink 缺失即整筆拒收（不出現「附件加了文本沒加」的半截狀態）/ 空內容拒收 / 登出後拒收 / 髒入參不拋錯                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `extension-release.yml`                    | —           | 打 tag 出瀏覽器擴充套件 zip（`npm run pack:extension` + Python zipfile 獨立校驗 manifest 在根目錄且 CRC 全通過）並掛到 Release                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 單測 `page-picker.test.ts`                 | —           | page-picker 純邏輯（jsdom）：定位串（短且唯一 / 兄弟衝突收窄 / 兜底全 nth-of-type）、HTML 骨架、XPath 與 DOM 路徑、契約 → Markdown（三檔體積、降級不輸出 undefined、base64 不進正文）+ 繫結文案 `bindView`（遠端地址判同 / `?token=` 歸一）+ 頁面識別 `detectPiWebUi`（橋優先 / `/api/health` / 別的服務不誤認 / 探不通 / 1.2s 自我中斷）                                                                                                                                                                                                                                                                                    |
| 單測 `page-picker-background.test.ts`      | —           | page-picker service worker（假 chrome）：投遞決策與複製兜底、composeInPage 橋、截圖裁剪數學（dpr 座標 / 越界 / 可見比例 / 畫素對齊）、截圖失敗不影響投遞、點圖示分流（pi-web-ui 頁 → 繫結浮條 / 普通頁 → 拾取器 / 探測注不進去 → 回落）、`bindServer`（地址歸一、已授權不打擾、缺授權回 needAuth 且**不寫儲存**）、本頁授權狀態查詢（`page-picker:page-state`：未授權 / 已授權帶授權表裡的標題 / 非 http 頁 origin 為空）                                                                                                                                                                                                    |
| 單測 `page-picker-page-state.test.ts`      | —           | 拾取細條的狀態文案（`grantView` 純函式）：「正在查」（undefined）與「查不到」（null）分開說、非 http/https 頁、未授權、已授權、已授權但總開關關著、標題等於 origin 的回落                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `composer-compose-test.mjs`                | 8900+       | 輸入框注入橋 E2E（真 Chrome + 真服務端）：版本號 / compose 落進 textarea + 游標到末尾 / **不覆蓋使用者已打的字** / 附件去重與累加 / 文本+附件同時到位 / 空內容拒收 / 無 JS 報錯（瀏覽器 E2E，不入 run-smoke，手動跑）                                                                                                                                                                                                                                                                                                                                                                                                        |
| 單測 `plugin-facilities.test.ts`           | —           | storage/secrets/deps/apiVersion 門控                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 單測 `plugin-settings.test.ts`             | —           | schema 解析/校驗/持久化（含 `optionsFrom`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 單測 `plugin-setting-options.test.ts`      | —           | 外掛 select 候選值合併（靜態 `options` + 宿主 `optionsFrom`：空值優先/順序/去重/當前值保留）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 單測 `mcp-bridge.test.ts`                  | —           | 握手/工具列表/呼叫/超時；自愈（崩潰後在途呼叫立即報錯、下一次呼叫自動重啟、併發呼叫共享同一次重連、啟動即退出快速報錯、close 後不復活）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 單測 `mcp-hot-reload.test.ts`              | —           | mcp.json 熱載入：指紋策略（內容沒變不重啟 / 真變了才應用 / 壞 JSON 保留在跑的伺服器且只提示一次 / 刪檔案 = 清空）、fs.watch 命中與目錄不存在時回落輪詢、dispose 後不再觸發、端到端（真橋 + 真檔案：改完工具表跟著變）；`mcp-bridge.test.ts` 另補 reload 語義（規格沒變的沿用原例項 → pid 不變、只換變了的、失敗保留舊例項、移除的舊程序真被殺掉）                                                                                                                                                                                                                                                                            |
| 單測 `mcp-oauth-login.test.ts`             | —           | 網頁 OAuth 發現/註冊/PKCE、手動與 loopback 回撥、state 校驗、取消及共享憑據持久化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 單測 `mcp-oauth.test.ts`                   | —           | MCP OAuth 憑據複用（Issue #786）：鍵口徑（`mcp__<名>\|<url>` 與舊 URL 鍵）、未過期直接發/過期先重新整理、重新整理令牌輪換與保留、舊鍵遷移、壞檔案容錯、`invalid_grant` → 需要登入且庫不動、401 強制重新整理、別程序已換 token 不重複重新整理、併發只重新整理一次、`client_secret_basic`、McpClient 的 `Authorization` 頭與 401→重新整理→重試、無憑據時的可操作錯誤                                                                                                                                                                                                                                                           |
| 單測 `plugin-updater.test.ts`              | —           | 備份/回滾/prune/資源解析                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 單測 `plugin-catalog.test.ts`              | —           | 外掛市場：builtin+custom 合併/同 id 覆蓋/source 校驗/預設 id 推導/增刪持久化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `notes-test.mjs`                           | 8914        | notes 外掛協議 E2E：真清單解析（頂欄條目/5 個 AI 工具/3 個斜槓命令）、HTTP 通道（store/op/export）、**長輪詢被改動喚醒**、重啟後資料仍在（已進 run-smoke）                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `notes-ui-test.mjs`                        | 隨機        | notes 浮窗 E2E（真 Chrome）：頂欄 📌 開浮窗 / 拖動 + 重新整理後位置恢復（靠 `preload:true` 預載入）/ 快速捕獲解析（明天 18:00、#標籤、每天 9:00）/ 筆記輸入即存落庫 / **一次性提醒到點→長輪詢→瀏覽器確認**（fireCount=1 且佇列清空）/ 最小化小貼片 / 無獨立檢視（無 ⤢、無 .plugin-view）/ 日曆在浮窗裡 42 格 + 正文區裁剪不撐破面板 / 設定覆蓋層（蓋住正文、不壓縮、語言標籤不豎排、✕ 能關）/ 無 JS 報錯（缺 Chrome 自動 SKIP，不入 run-smoke）                                                                                                                                                                              |
| `image-toolkit-core-test.mjs`              | —           | image-toolkit 純 JS 影像核心：PNG（全 filter / 位深 / 調色盤 / tRNS / 隔行報錯）+ BMP 編解碼往返、resize/crop/rotate/flip/adjust/水印/圓角/邊框/直方圖/主色、EXIF 解析                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `image-toolkit-test.mjs`                   | 8912        | image-toolkit 外掛：假 host 直測 4 個 AI 工具與 6 條路由（含目標體積/批次逐項報錯/越界拒絕/格式與缺依賴提示/內部配置存取）+ 真服務端接線 + 客戶端純邏輯（文案 key 對齊、尺寸與格式判定、ZIP 結構）                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `image-toolkit-view-test.mjs`              | 8913        | image-toolkit 檢視 E2E（真 Chrome + 打樁工作區介面）：匯入/佇列/各 tab/裁剪拖拽與鎖比例/精確體積/匯出下載/批次 ZIP/存回工作區/切語言/無 JS 報錯；另跑一遍手機端窄屏（390×780，`isMobile` + `hasTouch`）驗證三欄堆疊為上下、佇列轉橫向縮圖帶、底部引數抽屜開合（點手柄收起、點 tab 自動展開）與觸屏把手尺寸（缺 Chrome 自動 SKIP）                                                                                                                                                                                                                                                                                            |
| 單測 `page-picker-options.test.ts`         | —           | 設定頁的 `?bind=` 面板（真 options.html + 假 chrome）：無引數不出現 / 預填地址與按鈕文案隨授權狀態變 / 點選**真的寫進儲存**（歸一後）/ 已是當前地址則不再提供繫結                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `page-picker-edge-ext-test.mjs`            | 8960+/9440+ | page-picker **裝真擴充套件**的 E2E（真 `chrome.*`；實測 Edge 152 headless 仍接受 `--load-extension`，沒 Edge 自動 SKIP）：裸 origin 會被真瀏覽器拒（`Invalid url pattern`，0.2.0 投遞失敗的真兇）+ 拾取→投遞→Markdown 真落進 pi-web-ui 輸入框 + 繫結浮條真彈出 / 非目標頁真自退場                                                                                                                                                                                                                                                                                                                                            |
| `page-picker-test.mjs`                     | 8900+/9400+ | page-picker 擴充套件 E2E：注入真實 `dist/picker.js` + 真實 background 模組 + 真實 pi-web-ui 頁面（Chromium 137 起 `--load-extension` 已被上游移除，自動化裝不了真擴充套件，只能走等價路線）：選擇器 / 命中的 CSS 行號（Vite `data-vite-dev-id`）/ React 原始碼位置與呼叫鏈 / 樣式子集（只留與預設值不同的項）/ Markdown 落進真輸入框 / 多選不串味 / 找不到頁面時複製兜底 / 截圖失敗不影響投遞 / 真 pi-web-ui 頁與任意頁各自認定 + 真實 `dist/bind.js` 浮條繫結後照常投遞                                                                                                                                                     |
| `page-picker-ai-strip-test.mjs`            | 9600+       | 拾取浮層底部**常駐細條** E2E（真 Chrome + 真 `dist/picker.js`，無需服務端；斷言前把閉合 shadow 臨時改成 open —— 否則讀不到細條）：拾取態就有「讓 AI 操作本頁…」/「與另一頁配對…」/「退出」、點按鈕真發 `grant-here`/`pair-here` 且有 toast、**細條不擋拾取**（點狀態區穿透到背後元素）、進確認條細條讓位、Esc 回拾取態、四種狀態文案（未授權 / 已授權 / 總開關關著 / 查不到）                                                                                                                                                                                                                                                |
| 單測 `plugin-version-bump-guard.test.ts`   | —           | 外掛版本號遞增守衛：所有官方內建外掛必須具備符合 SemVer 的版本宣告；修改外掛程式碼/功能（非純文件）必須遞增 `manifest.json` 版本號，確保隨宿主自動熱同步（`syncBuiltinPlugins`）正常觸發                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 群組工單宿主 API 與 Superagent 公開 Webhook

`host.workItems`（契約見 `plugin-sdk/index.d.ts`）複用存量 `chat` 許可權。宿主信任具備該許可權的外掛根據本地配置提交工單授權；外部 payload 不是授權來源。`server/plugins.ts` 注入外掛自身的 `connectorId`，經 `server/device-center/local.ts` 轉發到 Hub，在賬號 / 群組與來源範圍內處理，不由外掛提供另一套模型或執行器。

- `rooms`、`ingest`、`list`、`get`、`update`：對映房間、接收去重事件、讀取工單及按業務 revision 更新；當前 `list` 返回首個有界預覽頁，不承諾全部歷史。
- `claimDelivery`、`completeDelivery`、`failDelivery`：領取持久 outbox、持租約確認或記錄失敗，由宿主安排後續重試。
- 工單授權不替代每事件授權：未通過作者白名單的 followup 不能借已有 auto 工單執行，人工授權的 `authorizedEventId` 僅綁定當前最新事件。初始描述保持，followup 作為獨立事件證據；task 結果不自動完成業務工單。

Superagent 0.1.3 是宿主內建的 GitHub / 飛書渠道模組，內部複用外掛執行時。後臺 outbox 只輪詢配置了房間對映和傳送憑據的渠道；未配置時保持空閒，配置補全後自動恢復。輪詢序列執行，正常每輪結束後等待 15 秒，宿主呼叫失敗時指數退避至最長 5 分鐘；同一輪故障只警告一次，恢復成功記錄一次，診斷只包含可用的 HTTP 狀態碼與連線排查提示，不回顯上游錯誤內容。解除安裝後不再排程、跨渠道領取或輸出輪詢日誌。主站認證前只精確放行 `POST /api/superagent/webhooks/github` 與 `POST /api/superagent/webhooks/feishu`，轉至外掛對應路由並校驗渠道簽名。請求上限 **1 MiB**，宿主儲存原始位元組 Buffer（`req.rawBody`，rawBuffer 語義）供驗籤；外掛不可用或原始位元組不可用時拒絕。配置、工單管理和手動回寫繼續使用 `/plugins-api/superagent/*` 原有主站認證與外掛校驗，不能據此公開整個外掛名稱空間。

UI 和遠端裝置路徑沿用 `appUrl()` / 外掛 `apiBase()`，保留應用根路徑與認證。公開回調採用外掛頁面顯示的可達 URL，不把遠端頁面根路徑當作隱含中轉。Superagent 目錄進入 npm 釋出白名單，`server/builtin-modules.ts` 宣告宿主必需模組，由 `server/plugin-bundled.ts` 在掃描前離線準備，首次啟動即可從 **裝置連線與跨平臺協作 → 外部渠道** 開啟；無需額外安裝或獨立頂欄入口。`DeviceChannels` 通過現有作用域匯入器與 `PluginView` 內嵌檢視，沿用窄上下文與解除安裝清理，按 epoch 重新整理並隔離過期載入；顯式重試會更新 bundle 快取鹽。內建模組不會顯示在普通外掛市場、已安裝列表、選單、佈局或許可權列表；管理數量與更新提示也排除它，普通安裝 / 更新 / 解除安裝及自定義同名覆蓋入口拒絕操作。舊外掛停用 / 解除安裝記錄不控制宿主模組，缺失檔案會重新準備，既有設定和金鑰保留。`<dataDir>/bundled-plugin-installs.json` 只繼續控制普通可選預裝外掛的首次準備，不作為必需模組的安裝依據。飛書支援明文或 AES 加密的簽名 text 回撥，超過 45 分鐘無回執的不確定投遞需人工核對；GitHub 通過穩定 comment marker 恢復重試。真實外部憑據與渠道未在本輪聯通，mock 測試不代表上線。

完整職責、群組頂部 AI Router / 工單抽屜用法、WAL 四集合、凍結 plan / lease / 配置 fence / effect receipts、分頁與上下文預算見 [群組獨立 AI Router 與 Superagent](group-orchestration.md)；渠道配置和支援範圍見 [Superagent README](../plugins/superagent/README.md)。

## 設定頁：擴充套件三選單與外掛摺疊詳情

設定頁「擴充套件」分組**並排 3 根導航**：技能 / MCP 伺服器 / 外掛（`SettingsModal.tsx` 的 `tabs[]` 與 `TAB_GROUPS`）。技能、MCP 各自保留原有子頁與元件（`McpServersPanel` 只挪位置），不併入外掛頁；工具開關、審批規則、介面佈局、預設等宿主內建能力仍留原分組。

**外掛頁兩個子頁**（`pluginTab`）：

- **安裝的外掛**：`<InstalledPluginsPanel/>` 單列摺疊列表，同時聚合 `chat.plugins`（介面外掛）與 `settings.extensions`（Pi / agent 會話擴充套件），並從服務端 `extension_inventory_data`（`server/extension-inventory.ts`）補出 SDK 內建擴充套件的健康、錯誤原文與工具數。點行就地展開詳情，同時最多展開一項，**不設左右分欄**；介面外掛詳情含配置項（`PluginSettingsForm`）、`settings.pages` 外掛頁（`PluginPage`）、執行日誌；Pi 擴充套件詳情含註冊能力與載入資訊。啟停分別寫回 `settings.disabledPlugins` / `settings.disabledExtensions`，統一列表只是投影，**不新建第三份狀態**；SDK 隱藏內建擴充套件標「只讀」。Pi 擴充套件沒有內建市場，新增 / 解除安裝走終端 `pi install npm:<pkg>` / `pi remove npm:<pkg>`。
- **外掛市場**：介面外掛市場全部控制元件原樣保留（官方 / 社群分割槽、自定義 catalog 源、同步並批次安裝、提交新外掛、官方倉庫連結、檢查更新、安裝 job 進度），資料仍來自 `plugins/catalog.json`、`OFFICIAL_PLUGIN_CATALOG_URL` 與 `chat.pluginCatalog`；技能市場、MCP 市場仍在各自選單，不搬到這裡。

`pluginSub` 是派生值（installed 子頁為 `"installed"`，市場子頁為 `marketOrigin`），讓原有市場段無需重寫。`extension_inventory` 請求改由 `tab === "plugins"` 觸發，新列表讀同一份清單。

刪除的入口：舊「介面外掛」tab、舊「外掛」tab 的 Pi 擴充套件列表、`PluginManagerModal` 在 `TopBar` 的掛載、`settings.pages` 生成的一級 tab（`plugin-page:*`）、`ExtensionInventory` 只讀清單的掛載、`PluginMenu` 的「外掛設定」按鈕。頂欄 🧩 降級為只讀快捷啟動器，僅保留一個「管理外掛 →」深鏈（`openSettings("plugins")`）。DSH 引擎的外掛市場與補丁管理保留在 `dsh-extensions` tab（advanced 分組），不進「外掛市場」。

`PluginManagerModal.tsx` / `ExtensionInventory.tsx` 檔案保留（前者仍有單測直接渲染，後者仍是服務端清單能力的來源），但不再掛在使用者可見的設定 / 頂欄入口上。新增 i18n key 在 `web/src/i18n/messages/core/{zh,en}.json`，改動後需 `npm run i18n:sync`；樣式字首 `.ip-*` 在 `web/src/styles.css` 末層。
