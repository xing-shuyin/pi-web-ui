[English](./architecture-browser.en.md) · [简体中文](./architecture-browser.md) · **繁體中文**

# 內建瀏覽器與桌面 Agent

桌面應用將瀏覽器與現有 pi-web-ui Agent 組合在一個視窗，支援 browser、agent、split 三種模式。啟動模式由設定項 `defaultMode` 決定，新使用者預設 agent（本地 Agent sidecar 並行啟動，就緒前由 shell 顯示啟動佔位）；Agent 失敗時可在佔位上一鍵切到瀏覽器。npm/純 Web 服務入口繼續使用現有路徑。

## 模組與邊界

- `browser/contracts.ts`：瀏覽器公共狀態和宿主介面；頁面請求型別從 `server/protocol.ts` 派生。
- `browser/runtime/manager.ts`：唯一標籤狀態源，管理 WebContentsView、導航、恢復、持久 session、下載和釋放。
- `browser/storage/index.ts`：書籤樹、歷史、設定、加密憑據和舊資料匯入。
- `browser/renderer/`：獨立瀏覽器外殼、新標籤頁、書籤/歷史/設定/下載面板、文件與媒體頁面，使用既有主題基線。
- `browser/automation/executor.ts`：頁面操作執行器，不依賴聊天 UI。
- `browser/preload.cts`：安全能力握手；只給已確認角色暴露對應介面。
- `desktop/browser-host.ts`：瀏覽器與 Agent 的組合佈局、IPC 角色驗證、站點許可權和使用者選擇檔案的授權。
- `desktop/browser-policy.ts`：可信地址及佈局純函式。
- `desktop/main.ts`：單一應用啟動、sidecar、更新與打包入口。

瀏覽器模組不匯入 Agent 執行時，後端也不匯入 Electron。後續瀏覽器位址列、標籤、導航、儲存和效能最佳化可在 browser 內獨立進行。Agent 通過宿主提供的專用原生檢視加入佈局。

## 視窗、模式與生命週期

BrowserWindow 的 webContents 載入本地 shell.html，標籤與專用 Agent 使用 WebContentsView。

- **browser 模式**：全寬完整瀏覽器，頂部 88px 瀏覽器外殼（標籤欄與位址列），下方為網頁檢視；右上角提供模式切換回 Agent / 分欄；
  標籤欄的每頁圖示跟站點走：主程序監聽 `page-favicon-updated`，只收 http(s) 與小尺寸 `data:image`（`pickTabFavicon`，超長 data URL 與 `javascript:`/`file:` 一律丟掉），主框架導航開始時先清空；外殼渲染成 `<img class="pb-tab-favicon">`，載入失敗或沒有圖示回退地球圖示，內部頁仍是 `π`。
- **agent 模式**：Agent 全尺寸全高佔據整個視口（y: 0 開始），不顯示任何瀏覽器標籤與位址列，保持與無結合時一致的純淨桌面體驗與視窗控制/拖拽，並在頂欄提供瀏覽器切換按鈕；
- **split 模式**：左右獨立並列。左側為完整的 Agent 檢視（從頂到底 y: 0），右側為獨立的瀏覽器（右側上方為區域性的瀏覽器外殼，下方為網頁檢視），效果類似在桌面並列開了 Agent 視窗與瀏覽器視窗。

啟動模式 = `BrowserSettings.defaultMode`（`agent` 預設 / `browser` / `split`）。兩個入口寫同一份設定：瀏覽器設定 → 啟動模式，以及應用設定彈窗 →「桌面應用」頁（僅桌面殼可見，經 `pi-desktop:browser-get/set-startup-mode` 走宿主 IPC）。執行期切換隻改當前會話，不寫回設定；舊版本存過的 `mode`（上次使用的模式）在首次讀取時遷移為 `defaultMode`，老使用者升級後啟動行為不變。agent / split 啟動時 Agent 首幀就緒前不顯示 Agent 檢視，由 shell 渲染 `pb-boot` 佔位（含失敗原因與「切換到瀏覽器模式」出口），就緒後再交給 Agent 檢視並聚焦。

切換模式複用同一個檢視並更新可見性、邊界和焦點，不過載頁面。隱藏頁保留有效尺寸，不縮成 1×1。標籤關閉時關閉對應 WebContents；應用關閉時清理標籤、下載、Agent 和掛起通道。

原生檢視不能被普通 DOM 的 z-index 覆蓋，所以外殼面板（書籤 / 歷史 / 下載 / 設定 / 擴充套件）**不再用 DOM 浮層 + 隱藏內容區**：一塊麵板 = 一個 `panel.html` 檢視（`WebContentsView`），比頁面檢視晚加入 `contentView` 即蓋在它上面，宿主按面板自己回報的尺寸把它擺成工具欄下沿、貼視窗右側的一塊矩形（`desktop/browser-policy.ts` 的 `panelLayerBounds`）。矩形之外的網頁與 Agent 分欄照常可見、可點——這正是修「一點開外掛列表，頁面和聊天全變黑」的地方。

- 開/收走 `panel` 動作（`{ open, panel }`）；同一個面板再點一次就是收起（工具欄按鈕本身是開關，不需要前端記狀態）。尺寸由面板頁回報（`{ size }`），面板自己量、宿主夾進可用區域；量不出來有兜底時長（`PANEL_LAYER_SHOW_DELAY`）。
- 面板在自己的視圖裡，`window` 事件跨不過去：書籤 / 設定 / 擴充套件的改動走 `panel` 的 `{ event }`，宿主轉發成 `pi-browser:panel-event`（`browser/preload.cts` 的 `onPanelEvent`），外殼與新標籤頁各自重新整理。
- 面板裡的動作要「先辦事再收面板」（導航、開擴充套件頁）：檢視銷燬會帶走後面那次 IPC。
- 內部標籤頁（新標籤頁等）自己的浮層仍用本頁 DOM：`dialog.show()` 而不是 `showModal()`——不要 `::backdrop` 遮罩、不把整窗變 inert，點面板外或 Esc 收起（`browser/renderer/panels.ts` 的 `handleOutsidePointer`/`handlePanelEscape`）。
- `overlay` 動作現在只服務外殼的搜尋浮層：那是蓋滿整塊內容區的 DOM 浮層，內容檢視得讓位，和麵板是兩回事。

Agent 可通過 `piDesktop.browser` 與宿主同步模式與標籤狀態。

視窗拖拽區（`-webkit-app-region`）不能掛在會消失的佈局產物上：Agent 頂欄原先只靠 `.tb-spacer` 供拖拽，而窄分欄進手機檢視後媒體查詢把 spacer 收成 `display: contents`（無盒子＝無拖拽區），整個頭部就再也拖不動視窗。現在 `body.is-desktop .topbar-flow` 自身宣告 `drag`，互動條目逐條 `no-drag`，與 spacer 是否存在無關；迴歸守衛見 `tests/unit/desktop-agent-input-regions.test.ts`。

## 本地與遠端 Web Agent

本地地址由實際 sidecar 啟動結果提供，不固定 8787。桌面預設服務埠依照 `desktop/startup.ts`。可以在瀏覽器設定中連線並記住 HTTP/HTTPS 遠端 Agent 地址。

使用內建瀏覽器開啟該受信任地址時：

```text
Agent 服務 → 頁面已有 WebSocket → page_request
→ __piWebUiHost.pageCall → __piBrowser.pageCall
→ 主程序授權檢查 → browser automation → 目標標籤
→ page_response 原路返回
```

`__piWebUiHost` 仍由 Web 應用維護。Web 前端優先檢測 `__piBrowser`，無原生能力時繼續原有 page-picker 路徑。無需隱藏 Electron UA、額外使用者外掛或固定 7801 匿名 HTTP API。普通系統瀏覽器中網頁的行為保持原有擴充套件接入方式。

此模式要求承載 Agent 網頁的連線線上；它不自動提供無人值守或跨裝置執行。也不自動讀取系統 Chrome 的標籤及登入態。

## 許可權與資料

每次 IPC 都檢查 mainFrame、當前 URL 和角色，不僅在 preload 初始化時檢查：

- 外殼和精確列入名單的本地內部頁可呼叫瀏覽器 UI、儲存和檔案選擇能力。
- 本地/已配置 Agent origin 的受信任頁面可呼叫頁面執行介面；普通網站不能操作其他標籤。
- 網站不獲得瀏覽器書籤、憑據或任意檔案系統介面。
- 網站許可權由 session handler 處理，敏感許可權明確授權並按 origin 儲存。
- eval 預設關閉，可在設定中顯式啟用。顯式目標失效不得回退操作其他標籤，同源多標籤應使用穩定 tabId。
- 「使用者當前開啟的是哪個標籤」屬於協議事實，不是客戶端猜測（原生側唯一事實源是 `BrowserManager.getActiveTabId()`）：`browser_page` 的 `pages`/`status` 給當前標籤打 `active: true` 並返回 `activeTabId`（只暴露可操作頁面，內部頁與呼叫方自己的檢視不算）；多標籤並存時仍要求顯式 `target`，報錯文案直接點名使用者當前開啟的那個標籤。page-picker 同理：已授權頁面裡只有最後一個聚焦視窗的 active 標籤會標 `active`，並給出 `activeOrigin`；未授權頁面即便在前臺也不上報（擴充套件不發 `tabs` 許可權，只對已授 host 許可權的 origin 查 `active: true, lastFocusedWindow: true`）。
- 本地檔案必須由系統選擇器授權，讀取上限 32 MiB，文本文件可儲存；二進位制 Office 文件只讀預覽，禁止把文本寫回原二進位制檔案。
- **口令框的值不出頁面**：兩條通道同一口徑 —— `read what=query` 不返回 `value`、`text` 置空，`read what=html` 克隆後清掉 `value` 屬性，`type` 回顯也不帶值。原生側事實源 `browser/automation/page-operation.ts` 的 `isPassword`；page-picker 側 `plugins/page-picker/extension/src/content/bridge-page.ts` 的 `isPassword`/`outerHtmlMasked`。改任何一側都要同步：口令框能照常 `type` 填寫，只是不再回顯。迴歸見 `tests/unit/page-picker-password-mask.test.ts` 與 `tests/page-picker-bridge-test.mjs`。
- 擴充套件安裝與「載入已解壓擴充套件」同信任級：只接受使用者手動選擇的目錄或 `.crx` 檔案。`.crx` 由主程序剝掉 `Cr24` 簽名頭後解包（條目數/體積上限，禁止越界路徑與連結，`manifest.json` 必須存在），**不校驗簽名**；解包目標 `userData/extensions/crx-<內容雜湊>`，同一檔案重灌不換路徑。裝過的目錄記入 `userData/extensions/installed.json`（`{ path, enabled }[]`，舊版純字串陣列仍可讀），重啟時只恢復 `enabled` 的那些（Electron 的 `loadExtension` 本身不持久）。
- 擴充套件面板由瀏覽器工具欄的擴充套件圖示（`shell.ts` 的拼圖按鈕，徽標=已啟用數量）開啟，和 Chrome 的擴充套件選單同一個入口語義：**一行一個擴充套件，點整行就開它自己的頁面**（`default_popup`，沒有就退到選項頁），啟停開關在行首，過載/選項/移除在行尾 `⋯`（與右鍵同一張原生選單）。面板是小浮層（`pb-dialog-compact`，360px 寬、高矮跟著列表走），不是整屏大窗。`extensions.list` 把「會話裡真正載入的」（`session.extensions.getAllExtensions()`）與「`installed.json` 記住的」合併，停用項的名字/版本回磁碟讀 manifest 補，已載入項帶上 `popup`（manifest 的 `action`/`browser_action`/`page_action` 的 `default_popup`，規則單源在 `browser/runtime/extension-state.ts`）。`extensions.toggle` 停用= `removeExtension`，啟用=重新 `loadExtension`；`extensions.reload` 先卸再裝同一目錄（改完擴充套件程式碼不用重啟應用）；`extensions.remove` 只解除安裝 + 從清單裡忘掉，**不刪磁碟目錄**（使用者選的解壓目錄不該被瀏覽器刪）。設定面板只留一個「管理擴充套件」入口，不再重複列出擴充套件。
- 工具欄上的擴充套件圖示由 `electron-chrome-extensions` 的 `<browser-action-list>` 渲染（見下節「擴充套件能力邊界」），點選開的就是 Chrome 語義的 `default_popup` / `onClicked`。擴充套件**面板**行是同一個語義：點整行走 `extensions.openPopup { path, anchor }`，用**同一 session 的獨立無邊框小窗**載入 `chrome-extension://<id>/<default_popup>`，定位在**滑鼠點下去的位置**（面板行記 `pointerdown` 的視口座標→螢幕座標；鍵盤或點在行外時回退到行右下角；按螢幕工作區收邊）、視窗是**直角**的（`roundedCorners: false`，macOS 預設圓角會把擴充套件頁四角切掉一塊）、失焦即關——同一擴充套件的頁面只保留一個視窗；開之前先收起面板（浮層不蓋在剛開啟的網頁上，網頁隨之還回來），但收面板不能把焦點搶回外殼——動作彈窗此刻正握著焦點，搶一下它就 blur 自關（mac 上實測「彈窗一閃而逝」）：`closePanelLayer()` 見到聚焦的動作彈窗就不還焦點，彈窗亮出後 300ms 內的失焦也不算關閉（`ACTION_POPUP_BLUR_GRACE_MS`），停用行則提示先啟用。彈窗視窗**按擴充套件頁自己要的尺寸開**（Chrome 的 popup 就是內容多大開多大，不是固定 400×560，否則窄頁面上兩側會空出一大條）：開窗前在頁面裡量尺寸，兩個口徑取小者：內容盒（`body.scrollWidth/scrollHeight`，固定寬度的彈窗——Dark Reader 那種 285px popup——在這裡最準）與後代盒子外接框（`body` 被視口撐滿時真正的尺寸在子元素上；和視口一樣寬/高的盒子只算被撐開的容器，比視口還高的算有效訊號；捲軸只在內容高度超過 Chrome 上限、真的會出豎滾動時才佔寬度）。取小者是必須的：絕對定位的 tooltip、動畫移出視口的摺疊區會把外接框撐到遠超內容，只信外接框就會量出 550px 寬、右邊留一條黑邊；隨後夾到 Chrome 的 800×600 上限內，量兩趟（寬度一變文字會重新折行），量不到就退回兜底尺寸；純函式與量尺寸指令碼在 `browser/runtime/extension-popup.ts`（單測 `tests/unit/extension-popup.test.ts`）。兩條路徑同一個口徑：Chromium 的首選尺寸模式（`preferred-size-changed`）對 `chrome-extension://` 頁面實測不發事件，所以工具欄動作圖示那條（庫的 `PopupView`）也被接管——宿主監聽 `browser-action-popup-created`，先給視窗一個正常視口、用同一套量法量出內容尺寸，再調庫自己的 `updatePosition()`（錨點與對齊在庫手裡）並 `show()`；不接管的話視窗會卡在 25×25 且一直藏著（點圖示沒反應）。選項頁走 `extensions.openOptions { path, anchor }`（`options_ui.page` 優先，其次舊式 `options_page`）：開了普通可調大小的視窗、失焦不關——Chrome 的「標籤頁 / 嵌在 chrome://extensions 裡」兩種展示在這裡統一成一個正常視窗，`open_in_tab` 不參與建模。瀏覽器導航策略不變——只有「已載入擴充套件自己宣告的頁面」能開，`extensionPageUrl` 會校驗 id 形狀並拒絕 `..`/絕對路徑/帶協議的路徑，不接受任意 `chrome-extension://` 地址；擴充套件頁裡的外部連結走系統瀏覽器（`setWindowOpenHandler` deny + `shell.openExternal`）。原生迴歸見 `tests/browser-desktop-smoke.mjs`（預置已解壓擴充套件 → 啟動恢復 → 彈窗 + 選項頁 → 停用/啟用/過載/移除）。
- 擴充套件行的 `⋯` 與右鍵是**同一張原生選單**（`extensions.menu { items, anchor }`）：選單項的文案、勾選態、可用態由渲染層拼（跟介面語言走），主程序只負責 `Menu.popup` 並把選中項 id 回傳，關掉選單返回 `null`；未載入的擴充套件不出現「彈窗 / 選項」。不再另寫一行用法提示——選單按鈕本身就是入口。
- 拖入 `.crx` 也走同一條安裝路徑：內部頁由 preload 的 `webUtils.getPathForFile` 取路徑後調 `extensions.installCrx { path }`；拖到網頁上的話由 `BrowserManager` 的導航守衛攔住 file:// 導航並交給 `onFileDrop`，主程序裝完用系統彈窗回報。

### 擴充套件能力邊界（Electron ≠ Chrome）

Electron 44 的擴充套件上下文只認 **15 個名稱空間**（`action alarms declarativeNetRequest dom extension i18n idle management offscreen proxy runtime scripting storage tabs webRequest`），`tabs` 還缺 `create/remove/captureVisibleTab`，`storage.sync` 沒有後端。擴充套件生態假設全套 API 都在，所以這裡分兩層：

**第一層：`electron-chrome-extensions`（`desktop/browser-host.ts`）——語義層，不擁有視窗。**
它在擴充套件 session 上補出 `windows / contextMenus / notifications / cookies / webNavigation / permissions / commands / downloads / topSites / privacy`，並把 tabs/windows 的寫操作回撥到**我們自己的模型**：`createTab → BrowserManager.createTab`、`selectTab → activateTab`、`removeTab → closeTab`、`createWindow → 獨立 BrowserWindow`（popup 型別給無邊框小窗，建完 `addTab` 讓 `chrome.tabs.query` 看得見）、`removeWindow → destroy`（拒絕關主視窗）、`requestPermissions → 彈原生確認`。標籤生命週期由 `BrowserManagerOptions.extensionHooks` 在 `createTab/activateTab` 處上報，右鍵選單走 `webContents.on("context-menu") → getContextMenuItems()` 拼原生 `Menu`（編輯項 → 擴充套件項 → 後退/前進/過載）。

工具欄動作：庫的 `<browser-action-list>` 由 `desktop/preload.cts` 裡的 `injectBrowserAction()` 注入（只對 `shell.html` 生效，preload 用 esbuild 打成單檔案——沙箱 preload 不能做模組解析），`shell.ts` 動態建立元素，`partition` 取 `browser/contracts.ts` 的 `BROWSER_EXTENSION_PARTITION`，主程序用 `setSessionPartitionResolver` 把它映射回 `session.fromPath()` 的瀏覽器 session；圖示走 `ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)` 提供的 `crx://`。點圖示就是 Chrome 的語義：開 `action.default_popup` 或觸發 `chrome.action.onClicked`，badge/title/icon 全由庫維護。

**第二層：`browser/runtime/extension-compat.ts`——只補第一層也沒蓋的缺口。**

- `chrome.tabs.captureVisibleTab / duplicate / move / highlight / discard`（庫沒實現）；
- `chrome.storage.sync` 落到 `local`（庫已對映一次，這裡是無庫時的兜底）；
- 入口三處都蓋：MV3 `background.service_worker` 包一層 `__pi-sw.js`（classic `importScripts`、`type: module` 用 `import`）、MV2 `background.scripts` 前插一行、`content_scripts` 逐個插（`world: "MAIN"` 不插），宣告的 popup/options 頁在 `<head>` 插 `<script src="/__pi-compat.js">`。
- **不再假裝成功**：調不通的成員回撥 `undefined` 並打一條 `[pi] chrome.<api> is not implemented` 警告，而不是返回 `[]/true` 騙擴充套件。

約束與邊界：

- 庫的 preload 最後會 `Object.freeze(chrome)`：**頂層新增名稱空間已經不可能**（例如 `fontSettings`），相容層只能往已有名稱空間裡補成員。
- 只寫 crx 解包目錄（`userData/extensions/crx-<hash>`），使用者自己「載入已解壓擴充套件」選的目錄一個位元組都不改；冪等，原 manifest 備份 `manifest.original.json`，版本標記 `__pi-compat.json`（`COMPAT_VERSION`，3 起配合語義層），開機自愈升級。
- **`declarativeNetRequest` 靜態規則由我們真正執行**（`browser/runtime/dnr.ts`）：Electron 自己的 DNR 只存不攔（實測確認），宿主讀已載入擴充套件 manifest 裡 `declarative_net_request.rule_resources` 的 JSON，編成 `session.webRequest.onBeforeRequest` 的判定——這是 Electron 裡唯一真能攔請求的通道。支援 `block`/`allow`、`urlFilter`/`regexFilter`、`resourceTypes`/`excludedResourceTypes`、`domains`/`requestDomains`/`initiatorDomains` 及排除項、優先順序（高者勝，同優先順序 allow 勝 block）；host 許可權門禁按 Chrome 語義（`example.com` 不覆蓋子域，子域要寫 `*.example.com`）。字面量預篩 + 正則體積/回引限制控制開銷與 ReDoS；內建頁面（`file:`）與擴充套件頁永不攔截。擴充套件載入/停用/移除/過載後合併成一次重新整理。
- 仍然做不到的：動態/會話 DNR 規則（存在擴充套件的 LevelDB 裡，主程序讀不到）、`redirect` / `modifyHeaders` / `allowAllRequests` 動作、`sidePanel` / `tabGroups` / `identity`、以及 `fontSettings` 這類庫不提供又被 freeze 擋住的名稱空間；MV2 的 `webRequest` blocking 仍可用但已被 Electron 44 標 deprecated。
- `chrome.tabs.captureVisibleTab` 有真實現：宿主把一小段橋指令碼（`browser/runtime/extension-bridge.ts`）掛到瀏覽器 session 的 frame / service-worker，擴充套件上下文裡才有 `__piExtensionBridge`（普通網頁 `location.protocol !== "chrome-extension:"`，什麼都不暴露）；主程序再校驗 sender 屬於同一 session 且來源是 `chrome-extension://`，截當前啟用標籤的 `capturePage()`，支援 `format: jpeg` + `quality`。
- 相容層還補了庫的兩個小缺口：`windows.getAll({ populate: true })` 用真實 `tabs.query` 填每個視窗的 `tabs`（庫的 dist 裡沒有 populate 實現）；`chrome.storage.sync` 落到 local。剩餘仍是空實現的只有 `tabs.duplicate / move / highlight / discard`。

判斷依據是主程序 stderr 裡的 Chromium 日誌（`ExtensionLoadWarning` / `Extension Error` 塊）。原生迴歸見 `tests/browser-desktop-smoke.mjs`：工具欄渲染動作按鈕 → 點選開 `chrome-extension://<id>/popup.html`、`extensions.list` 恢復、面板彈窗/選項頁、停用/啟用/過載/移除、`crx compat shim` 用例（手搓 crx → 解包 → 包裝 manifest → SW 用 `chrome.windows` 不崩 → 選項頁拿到庫名稱空間與相容層補的 `tabs` 成員 → 內容指令碼仍注入）。純函式與冪等性見 `tests/unit/extension-compat.test.ts`。

瀏覽器檔案與 session 位於 Electron userData/browser；Agent 原有資料目錄繼續使用原配置。憑據使用 Electron safeStorage，安全加密後端不可用時拒絕儲存。保險箱可由使用者明確選擇填寫當前網站，主程序與頁面內都檢查精確 origin，不自動提交表單。舊 AI Browser 資料可由使用者選擇舊目錄匯入，存在的目標檔案不會覆蓋；匯入錯誤單列報告。

## 頁面指令碼注入（Agent → 網頁）

Agent 可以給網頁注入指令碼：`browser_script` 工具（`server/browser-script-tool.ts`）→ `page_request`（`op: "script.list|status|create|update|remove|enable|disable|run"`）→ `desktop/browser-host.ts` 校驗呼叫方 → `browser/automation/scripts.ts` → `BrowserManager`。線協議不新增欄位（`op` 仍是字串），主程序側才真正注入。

- **一條記錄、兩種生命週期**：`PageScript`（`browser/runtime/scripts.ts`）的 `persistent` 決定它是寫進 `userData/browser/scripts.json`（重啟仍生效）還是隻存在記憶體（關掉瀏覽器即消失）。臨時指令碼在頁面重新整理後會重新注入，這正是「臨時」該有的語義；一次性改動 = 建臨時指令碼 → `run` → `remove`（順帶跑 cleanup）即可。
- **預設指向使用者當前標籤**：指令碼預設目標與 `browser_page` 的 active 語義同一事實源（`BrowserManager.getActiveTabId()`）——省略 `matches` 時新指令碼只作用於 target（預設為當前標籤）的站點，`script.run` 不給 target 時只打當前標籤，`script.status` 會帶 `activeTabId` 與每個標籤的 `active`。顯式傳 `[]` 或 `*` 才是全站。
- **指令碼不做能力限制**：不設程式碼體積、條數、匹配數上限，也不限制程式碼內容。指令碼在目標網頁裡跑，天然拿不到宿主橋（`__piBrowser` / `__piWebUiHost` 只存在於 Agent 頁面），主程序也從不執行指令碼程式碼。
- **注入時機**：`dom-ready` 用 `executeJavaScript`（不受頁面 CSP 限制）；`document-start` 用 CDP `Page.addScriptToEvaluateOnNewDocument`（只有它能搶在新文件首行），debugger 已被佔用時降級為 dom-ready 並記 `lastError`；`world: "isolated"` 走 `executeJavaScriptInIsolatedWorld` / CDP `worldName`，拿不到頁面 JS 控制代碼。CSS 走 `insertCSS`/`removeInsertedCSS`，比 JS 更乾淨地可撤銷。
- **每個文件只跑一次**：`BrowserManager` 在 `did-start-navigation`（非 same-document）重置該標籤的執行態，頁面裡還有一層 per-document `WeakMap` 令牌去重，重複的 `dom-ready` 或雙通道注入都不會讓同一指令碼在一個文件裡執行兩次。
- **可撤銷**：指令碼頂層 `return function () {...}` 即是清理鉤子，重跑/停用/刪除前先呼叫它；頁面裡的登錄檔 `window.__piPageScripts` 可直接在 DevTools 裡查。
- **可觀測**：`script.status` 按標籤返回 `{ injected, skipped: [{scriptId, reason}], errors }`（`scripts-disabled` / `internal-page` / `not-matched:<url>`），注入程式碼帶 `//# sourceURL=pi-script://<id>/<name>.js`，DevTools 裡可單獨斷點。
- **邊界**：內部頁（shell/newtab/workspace/office）從不注入；`allowScripts` 總開關關閉後全部跳過；普通網站無法通過任何入口管理指令碼（`scripts.*` 只對外殼內部頁開放）。設定面板「頁面指令碼」列出全部指令碼（臨時/永久徽標、來源、`document-start`/`isolated` 非預設徽標），可停用、檢視程式碼、刪除。

## 憑據保險庫（密碼 + TOTP）

工具欄鑰匙圖示 → `vault` 面板（`BROWSER_PANELS` 的一員，走同一套 `panel.html` 浮層檢視）。密碼與 TOTP 在使用者眼裡是同一件事（"這個網站的憑據"），所以合併成一塊麵板、兩個分段標籤，共用一套互動。外殼可以用 `panel { open, panel: "vault", tab: "totp" }` 指定先開哪個標籤（鑰匙圖示固定開 TOTP，設定裡的「開啟憑據保險庫」開密碼）。

### 共同互動（設計 C：圖示工具條）

- **動作只在頂部一行**：面板不給條目掛按鈕，動作統一收進標題欄的動作槽（`panels.ts` 的 `.pb-dialog-actions`）。按鈕純圖示（無障礙名走 `aria-label`），名字靠 `data-tip` 的 CSS 懸浮氣泡（`title` 留空，避免原生提示疊加）；最右兩個圖示用 `data-tip-end` 貼右對齊，免得被浮層圓角裁掉。工具條隨標籤切換：密碼是 `新增 ｜ 填入 / 顯示密碼 / 編輯 / 刪除`，TOTP 是 `掃碼 / 匯入圖片 / 新增 ｜ 填入 / 匯出此條 / 匯出全部 / 改名 / 上移 / 下移 / 刪除`。
- **先選中再操作**：點條目或鍵盤 ↑↓ 選中，工具條作用於選中那條；沒選中時動作圖示 `disabled`（灰度、`::after` 氣泡不彈），首尾兩端的上/下移也置灰。命中當前標籤頁的條目開啟即選中並置頂，所以「打開面板 → 點填入」兩下就完事。`Enter` 填到頁面；TOTP 標籤的 `Shift+Enter` 複製驗證碼、密碼標籤的是顯示/收起密碼。
- 設定面板裡的「密碼庫」段只留一句說明和一個入口（`vaultSection`），真正的增刪改都在這裡，避免兩處各維護一套列表。
- 面板浮層檢視（`panel.html`，`body.pb-panel-layer`）是第三套根：`[hidden]` 的全域性豁免名單裡必須帶上它，否則 `.pb-form{display:flex}` 之類的規則會把 `hidden=true` 的表單照樣畫出來（「新增」表單預設展開的 bug 就出在這裡）。

### 密碼

- **列表不下發明文**：`passwords.list` 返回投影 `{ id, name, url, username, createdAt, hasPassword }`（主程序 `browser-host.ts` 裡去掉 `password`），和 TOTP 的「secret 不出主程序」同一條口徑。要明文只有兩條口子：`passwords.reveal { id }`（使用者點「顯示密碼」時取一次，介面 10 秒後自動蓋回）和 `passwords.fill`（主程序內部取出來直接填頁面，明文不經過渲染層）。
- **寫回只走細粒度動作**：`passwords.upsert { id?, name, url, username, password? }`（`id` 存在即更新，`password` 留空表示沿用舊密碼）與 `passwords.remove { id }`。渲染層拿不到整份明文，所以不能讓它 `save` 全量列表——舊的 `passwords.save` 只保留給冒煙測試/遷移用。
- **填密碼校驗同源**：`passwords.fill` → `fillCredential()`，要求當前標籤頁與條目 `url` 的 **origin 完全相等**，且頁面上只有一個可見密碼框；填完只發 `input`/`change`，由使用者自己點提交。
- 加密仍然走 `BrowserStorage` 的 `enc:<safeStorage>`，`passwords.available`（= `isEncryptionAvailable()`）為假時面板顯示保險庫鎖定。

### TOTP

- **掃碼 = 截當前標籤頁，不讀 DOM**（`totp.scan` → `WebContents.capturePage()` → `browser/runtime/qr.ts`）：頁面裡的二維碼可能是 `<img>`、`<canvas>`、內聯 SVG、CSS 背景或 canvas 動態繪製，逐種抓法都要對付 CORS 與跨域畫布汙染；截圖對它們一視同仁，也不需要攝像頭許可權。代價是**二維碼必須可見於視口**，否則報錯讓使用者滾動。解碼用 `jsqr`（純 JS，唯一新增執行時依賴），`NativeImage.toBitmap()` 給的是 **BGRA**，`bgraToRgba()` 換序後再喂。圖片匯入（`totp.importImage`）走 `nativeImage.createFromDataURL()`，同一條解碼路徑。
- **只收 `otpauth://totp`**：`parseOtpauth()`（`browser/runtime/totp.ts`）拒絕普通網址二維碼與 `hotp`，報錯而不是把亂碼當金鑰；演算法/位數/週期都帶白名單（SHA1/SHA256/SHA512、6–8 位、1–3600s）。
- **secret 永不出主程序**：渲染層只拿 `PublicTotpEntry`（`publicTotp()` 投影，無 secret），要碼就發 `totp.code { id }` 讓主程序算（`totpCode()`，RFC 6238）。唯一會把 secret 帶出來的是使用者顯式點選的 `totp.export`（otpauth URI）。
- **加密**：`BrowserStorage.listTotp/saveTotp` 把 secret 存成 `enc:<safeStorage>`，落在 `userData/browser/totp.json`；`totp.available` 先行探測。
- **按站點自動匹配**：條目帶 `origin`（掃碼時那個頁面的 origin，只認 http/https 且只做精確相等——`https://github.com` 不覆蓋 `https://gist.github.com`）。當前標籤命中時工具欄圖示帶一個小圓點，面板把該條目置頂；命中判斷在渲染層做（`shell.ts` 的 `refreshTotpMatch`，資料來自 `totp.list`），改動後靠 `pb-vault-changed` 面板事件回灌。
- **填碼不自動提交**：`totp.fill` → `browser/runtime/credentials.ts` 的 `fillTotpCode`，站位順序是 `autocomplete="one-time-code"` → 一組 `maxlength=1` 的分格輸入框 → 名稱/佔位符像驗證碼的單框 → 當前聚焦的框；填完只發 `input`/`change`。
- 排序（`totp.reorder`）、改名/改繫結（`totp.update`）、刪除（`totp.remove`）都在工具條上，寫回同一份加密檔案；列表順序就是 `order` 欄位，未列出的條目在重排後保留在尾部，不丟資料。
- 純邏輯（Base32/HOTP/TOTP 的 RFC 6238 向量、otpauth 各種變體、投影、排序、origin 匹配、二維碼點陣圖解碼）全在 `tests/unit/totp.test.ts`，不依賴 Electron。

## 自定義新標籤頁與主題覆蓋（使用者改 / Agent 設計）

內建頁（shell / panel / newtab / office / workspace）是構建產物，只讀且打包後不可寫；使用者與 Agent 的自定義內容一律落在 **Electron `userData/browser/custom/`**：`newtab.html`（新標籤頁，自包含 HTML）與 `theme.css`（主題覆蓋）。單源在 `browser/runtime/customize.ts`（`BrowserCustomization`：路徑、大小上限、原子寫、狀態、回落規則）。

- **一個 kind 一個檔案**：新標籤頁就是一份完整 HTML（inline `<style>`/`<script>` 隨便寫，不引入模板語法或多檔案工程）；主題就是一份 CSS。寫空正文 = 恢復預設（不會留一個空白頁把人困住）；超過 512KB 直接報錯而不是截斷（擋住「把 20MB base64 圖片塞進新標籤頁」）。
- **誰開啟它**：`BrowserManager` 把 `newtab` / 空地址 / 舊的自定義地址統一換成 `customization.newTabUrl()`（`targetUrl()`），所以 Ctrl+T、工具欄 `+`、恢復上次標籤、面板裡的「預覽」走的是同一條路。沒有自定義檔案時回落 `dist/browser/renderer/newtab.html`。自定義頁在標籤狀態裡仍算 `internal`：`browser_page` 不把它當可操作頁面，頁面指令碼不注入，DNR 與導航護欄按內部頁處理。
- **與內建頁同權**：`isBrowserAssetUrl()`（`desktop/browser-policy.ts`）多收一個由宿主拼出來的路徑（`custom/newtab.html`），因此自定義頁能拿到 `piBrowserShell` 橋（`settings.get` / `bookmarks.list` / `tabs.create` / `navigate` …）。這是有意的取捨：它終究是本地檔案，且只有這樣 AI 設計的頁面才能有真能用的搜尋框和書籤膠囊。代價是**寫進這份 HTML 的內容等於拿到本地檔案與憑據橋的能力**，所以工具提示詞明確禁止把遠端指令碼或不可信標記塞進去。
- **改完立刻生效**：寫/刪新標籤頁 → 所有停在新標籤頁上的標籤過載（內建 ↔ 自定義互相撥）；寫/刪主題 → 已開啟的內部頁標籤先撤舊 key 再 `insertCSS`，**不整頁重新整理**（Office / 工作區裡的未儲存編輯不能因為換配色被刷掉）。外殼與面板不是標籤，由 `DesktopBrowserHost.applyChromeTheme()` 在各自 `dom-ready` 與寫入後注入。
- **兩條入口，一套實現**：設定面板「新標籤頁 / 主題」（`browser/renderer/panels.ts` 的 `designEditor`：正文框 + 儲存 / 預覽 / 恢復預設，顯示檔案絕對路徑）與 Agent 工具 `browser_design`（`server/browser-design-tool.ts`）都只說 `design.status|get|save|reset`，落到 `desktop/browser-host.ts` 的 `call()` 與 `BrowserManager` 同一組方法上。
- **預覽必須有可見頁面**：Electron 對隱藏 / 未掛載的 `WebContentsView` 調 `capturePage()` 會返回空圖或掛住（實測），所以 `design.preview` 會開或啟用一塊新標籤頁、必要時把視窗切到 browser 模式，再截圖（≤1280px、JPEG）；抓不到就如實報「需要可見頁面」，不做假成功。
- **自動化線上不加新欄位**：工具仍走既有 `page_request`，`op` 為 `design.status|get|save|reset|preview`（`browser/automation/design.ts` 的 `BrowserDesignHost`），在 `createBrowserExecutor` 裡先於「選目標標籤」分支處理——瀏覽器只剩內部頁時也照常可用。
- **寫壞了怎麼退**：主題是一份任意 CSS，理論上能把外殼藏沒。恢復路徑只有一條且必須真實可用——刪掉 `userData/browser/custom/theme.css`（或 `newtab.html`）後重啟，或讓 Agent 跑 `design.reset`；設定面板裡也直接顯示這兩個檔案的絕對路徑，方便外部編輯器處理。
- 迴歸：`tests/unit/browser-customize.test.ts`（儲存 / 大小 / 原子寫 / URL 識別）、`browser-design-tool.test.ts`（工具契約、kind 與 `browser/contracts.ts` 同構、`get` 截斷）、`browser-design-ops.test.ts`（executor 分支）。

## 構建與驗證

`npm run build:desktop` 編譯 desktop/browser TypeScript，再由 `scripts/build-browser.mjs` 獨立構建瀏覽器頁面到 dist/browser/renderer。現有 Agent Vite 入口不變。Electron 打包包含 dist/desktop、dist/browser、dist/server 和 web/dist。

相關單測：browser-runtime、browser-storage、browser-credentials、browser-automation、browser-desktop、browser-crx，以及 browser-control、plugin-host、browser-page-tool、desktop-startup 的既有測試。頁面指令碼的匹配/注入/去重/落盤迴歸在 `tests/unit/browser-scripts.test.ts`。桌面冒煙見 `tests/browser-desktop-smoke.mjs`，使用獨立臨時資料和測試服務，不觸碰使用者例項。
