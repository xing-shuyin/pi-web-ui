[English](./agent-rules.en.md) · [简体中文](./agent-rules.md) · **繁體中文**

# 編碼紅線細則（原 AGENTS.md §9 全文）

> `AGENTS.md` 只保留「功能 → 事實原始檔 → 文件」的對映與一行紅線索引；**細則全在這裡**。
> 改程式碼前按主題跳到對應章節，改完跑該條標註的守衛測試。

本檔案收納的章節：

- [一、通訊協議與資料安全](#一通訊協議與資料安全)
- [二、工具定義與提示詞規範](#二工具定義與提示詞規範)
- [三、UI 佈局與樣式規範](#三ui-佈局與樣式規範)
- [四、架構與執行態約束](#四架構與執行態約束)
- [五、其餘邊界（只在別處維護，見連結）](#五其餘邊界只在別處維護見連結)
- [六、原始碼註釋](#六原始碼註釋)

以下規則由歷史線上問題與核心架構硬約束提煉而成，編寫程式碼時必須嚴格遵守。

## 一、通訊協議與資料安全

- **`details` 欄位硬限制 ≤64KB**：下發與持久化會超限整包丟棄。新工具嚴禁塞入大塊原始資料（參照 `present-files-tool.ts` 做摘錄預算）；前端渲染必須支援無 details 降級（`present-items.ts`）。
- **服務端 URL 必須包裹 `appUrl()`**：包括 `/ws`、`/api/*`、`/plugins/*`、`/themes/*`，杜絕反向代理子路徑部署時 404。
- **Token Cookie 校驗前必須解碼**：`pi_web_token` 經 `encodeURIComponent` 儲存，服務端讀取必須先 `decodeCookieToken` 再校驗（`server/auth-cookie.ts`）。
- **未登入頁口令表單必須原生 POST**（`POST /__pi/auth`，`server/auth-login.ts`）：賬號域 `autocomplete="username"` + 密碼域 `autocomplete="current-password"` + 真實表單提交（禁 JS `preventDefault()` 拼 `?token=` 跳轉），否則瀏覽器密碼管理器不會詢問儲存密碼；回跳地址一律過 `sanitizeNextPath`（禁開放重定向、剔 `token`）（守衛：`tests/unit/auth-login.test.ts` · `tests/unit/unauthorized-page.test.ts`）。
- **工作區嚴禁使用家目錄根**：禁止設定 `$HOME` 為工作區根，防止遞迴掃描壞掛載造成事件迴圈卡死。
- **遠期定時器必須使用 `armDelay` 分片**：Node.js 中 `setTimeout` 超過 2^31-1 毫秒（約 24.8 天）會整型溢位被截斷為 1ms 從而引發死迴圈。超過 6 小時任務必須分片（守衛：`plugin-cron-overflow-test.mjs`）。
- **文本解碼與行號統計規範**：預覽與附件統一使用 `decodeText`（UTF-8 → GBK → latin1）；`countLines` 不計末尾空行，前端需 pop 末尾空串。詳見 [`architecture-attachments.md`](architecture-attachments.md)。

## 二、工具定義與提示詞規範

> 與 [`development.md`](development.md)「編碼約定」、[`tool-context-budget.md`](tool-context-budget.md) 互補：本節是**禁令視角**，那兩處是工作原理。

- **工具提示詞三處職責分離（嚴禁跨處複述）**：
  1. Tool Schema 的 `description`：僅描述「做什麼與邊界」，≤600 字元；
  2. 系統提示詞中的 `promptSnippet`：僅寫「何時觸發」，≤80 字元，不帶工具名字首；
  3. `Guidelines` 段落的 `promptGuidelines`：僅寫「呼叫順序/禁令/跨工具路由」。
     _必須使用精煉純英文，違規會被守衛單測攔截_（守衛：`tests/unit/tool-prompt-hygiene.test.ts`）。`bash` / `edit` 的模型可見文案單源在 `server/tool-prompts.ts`。
- **編輯能力只有一個工具名**：寬鬆匹配是 `edit` 的引數 `soft: true`（`server/edit-tool.ts`），**禁止**再新增 `edit_soft` 這類第二個編輯工具：同名能力拆成兩個工具會逼模型二選一，並把開關、提示詞、審批規則三處聯動憑空翻倍。舊存檔裡的相關開關只需在歸一化裡折算，不留執行時分支。
- **工具延遲載入硬約束：絕不破壞字首快取**：
  供應商 Prompt Cache 依賴系統提示詞字首完全一致。系統提示詞 `{{tools}}` 目錄必須保持完整且不隨已載入狀態變化；新載入工具的要點隨 `load_tools` 回執進入對話；登錄檔僅允許追加（`toolsAdded`），嚴禁就地修改或刪除（守衛：`tests/lazy-tools-test.mjs`，文件：[`tool-context-budget.md`](tool-context-budget.md)）。
- **單工具多執行路徑必須提示詞單源**：以 bash 為例，原生、終端和自適應分流路徑共用 `server/tool-prompts.ts`，禁止在 execute 覆蓋實現中硬編碼或複製描述。
- **bash / powershell 的預設超時單源在 `server/bash-timeout.ts`**：模型漏傳 `timeout` 時按 `DEFAULT_BASH_TIMEOUT_SEC`（120s，`PI_WEB_BASH_TIMEOUT_SEC` 可改）執行，過大值夾到 `MAX_BASH_TIMEOUT_SEC`（1 小時）—— 不得退回「無超時」只等會話看門狗（預設 20 分鐘）收屍。三條執行路徑（`bash-tool.ts` 本地/SSH、`terminals.ts` 終端接管、`agent-service.ts` 的 powershell）必須都過 `withDefaultBashTimeout()`，禁止各處另寫數值或把 `0` 當「不限」（SDK 對 0/負數直接拋 `Invalid timeout`）（守衛：`tests/unit/bash-timeout.test.ts`）。
- **Schema 只寫欄位名與型別**：匯出的 JSON Schema 裡不放 `minItems` / `maxItems` / `minimum` / `maximum` / `minLength` / `anyOf` 這類裝飾約束，也不給自解釋的欄位寫 `description`；約束校驗搬到 handler（`readArguments` 一類），候選值寫 `enum`，每個引數能填什麼寫在該引數的**唯一**一句簽名裡（`communicate`、`browser_page` 的 `action`/`op` 就是範例）。少數確實不自解釋的欄位（`read.offset`、`bash.persist`、`edit.soft`、`present_files.items[].focus`、`skill.name`）才留一句短說明。SDK 自帶但文案歸我們的 `write` / `grep` / `find` 用 `withSlimPrompt()` 在 `server/tool-prompts.ts` 裡換文案與 schema，實現仍走 SDK（守衛：`tests/unit/tool-schema-slim.test.ts`，它同時比對欄位名與 SDK 內建定義，SDK 增刪引數會直接報紅）。
- **工具關閉只有一個漏斗**：`disabledAgentTools`（開關）與 `toolOnDemandTools`（按需列表）都由 `effectiveDisabledAgentTools()` 取並集，只做減法、不產生第二條門控路徑；禁止為新開關另寫一套 `setActiveTools` 過濾（守衛：`tests/unit/tool-manager.test.ts`「按需列表」用例）。
- **新增工具三處聯動**：新增可開關工具必須同時登記到 `tool-manager.ts`（`AGENT_TOOL_CATALOG` 事實源）、`agent-service.ts`（`customTools` 列表）以及 `tests/unit/tool-registration.test.ts`；內建工具覆蓋必須走 `tool-overrides.ts`。
- **逐工具文案可編輯機制**：使用者自定義文案僅作為偏好存入 `toolPromptOverrides`，新增可配置維度必須同步打補丁邏輯、wire 協議與設定頁編輯器三處（守衛：`tests/unit/tool-prompt-overrides.test.ts`）。

## 三、UI 佈局與樣式規範

> 共享基線是 `web/src/styles.css`；主題見 [`architecture-core.md`](architecture-core.md)「主題切換」。

- **專案選中態只跟隨當前開啟的專案**：執行中、未讀狀態通過專案徽標表達，不得為其他專案標題新增狀態底色；保留普通懸停反饋。

- **CSS 變數必須先定義後引用**：未定義的 `var(--x)` 會導致整條 CSS 宣告失效；內聯程式碼的 `--link-soft` 在 `--bg` 上須滿足文字令牌的 ≥4:1 對比度門檻（守衛：`tests/unit/css-tokens.test.ts`、`theme-text-contrast.test.ts`；行內程式碼檢查已併入文字令牌守衛）。
- **桌面殼（Electron）的貼頂浮層必須讓出 macOS 紅黃綠按鈕**：按鈕由原生繪製、浮在 WebView 上不佔佈局（`desktop/main.ts` 的 `trafficLightPosition`），頂欄靠 `padding-left` 讓位；任何 `position: fixed; top: 0` 的貼頂浮層（手機/窄分欄佈局下的 `.panel-drawer`）必須用 `var(--desktop-titlebar-h, 0px)` 往下讓（`padding-top` 或 `top: calc(...)`），否則窄分欄時專案列表頭正好壓住關閉按鈕。該令牌只在 `body.is-desktop-mac:not(.is-desktop-fullscreen)` 下為 38px，其他環境為 0。
- **強調色實底上的文字必須走 `--accent-contrast`**：`background: var(--accent)` 配 `color: #fff` 會在淺色強調主題（`flow`/`wallpaper-flow` 的純白、`wallpaper-obsidian` 的 `#e2e8f0`、`aetheris`/`cyberpunk`/`nord` 等）變成白底白字，按鈕直接隱形。前景一律寫 `var(--accent-contrast, #fff)`；外掛同理：若私設字首別名（如 `--xxx-accent: var(--accent)`）**必須成對宣告** `--xxx-accent-contrast: var(--accent-contrast, #fff)`，推薦直接複用宿主全域性 `.btn.primary`，嚴禁私設單向底色別名而硬編碼白字；半透明 `color-mix(… var(--accent) 30% …)` 染色底則用 `var(--text)`；主題若把 `--accent` 定成淺色，必須同時宣告反色的 `--accent-contrast`（守衛：`tests/unit/accent-contrast.test.ts`、`semantic-contrast.test.ts` 動態符號追蹤別名）。
- **語義色實底同理走 `--on-*`**：`background: var(--green|--red|--amber|--blue|--send-blue|--stop-red)` 配 `color: #fff` 同樣會隱形（預設主題 `--amber` 白字 1.67:1、`--green` 1.92:1、`--red` 2.77:1）。前景寫 `var(--on-green|--on-red|--on-amber|--on-blue|--on-send-blue|--on-stop-red)`；狀態色按「白/深取對比更高者」派生、動作色（blue/send/stop）白字 ≥3:1 就保留白字，主題側由 `make-light-theme.mjs` 自動派生（守衛：`tests/unit/semantic-contrast.test.ts`）。
- **主題的「文字令牌」必須有明暗下限**：`--text-faint`（3.05:1）、`--accent`（3.5:1）、`--amber/--green/--red/--blue/--link/--link-soft/--info-blue/--skill-blue/--auth-green/--plugin-purple/--amber-text/--red-text/--err-text/--md-strong/--code-text`（4.5:1）在 `--bg` 與 `--bg-elev2` 上必須夠對比——亮色主題照抄深色預設值會讓警告文字、狀態 chip、連結整體糊掉（曾出現 `--plugin-purple` 1.50:1）。`make-light-theme.mjs` 的 `TEXT_FLOORS` 會自動保持色相壓暗，手寫主題自行宣告（守衛：`tests/unit/theme-text-contrast.test.ts`）。
- **長文本與長路徑防溢位標準**：
  - 行容器（flex 容器）必須新增 `min-width: 0` 與 `max-width: 100%`；
  - 可斷行文本（`.md` 內正文、路徑）必須使用 `overflow-wrap: anywhere` 與 `word-break: break-word`；
  - 單行文本使用 `overflow: hidden` 與 `text-overflow: ellipsis`；
  - 獨立面板與彈窗列表（如計劃看板、沙箱差異）必須宣告 `overscroll-behavior: contain` 防止整頁捲軸穿透；但流內工具輸出與程式碼文本塊等非獨立浮層容器嚴禁宣告 `overscroll-behavior: contain`，防止滾輪黑洞鎖死外部對話流（守衛：`tests/unit/text-wrap.test.ts`）。
- **卡頭與操作按鈕落點規範**：
  - 摺疊卡頭（`.chead`）右端**僅放置自身複製鍵**（`.chead-copy`，釘 `flex: none`），卡頭內嚴禁懸掛訊息級操作按鈕；卡頭提示文本設定 `flex: 0 1 auto` + `min-width: 0` 吸收縮放，窄屏下限制最大寬度，嚴停用 `flex-wrap: wrap`。
  - 訊息級操作欄（`.msg-actions`）僅對有正文的助手訊息和使用者訊息生效；助手訊息操作欄必須緊錨在最後一個正文塊後，杜絕與工具卡分離。
- **UI 擴充套件點與浮層規則**：
  - 下拉選單必須 Portal 到 `body` + `fixed` 佈局，防止被父容器 `overflow` 截斷；
  - 浮層統一使用 `useFloatingPanel`，禁止在 `scroll` 事件中強制關閉浮層（僅重算錨點，通過 mousedown/Escape 關閉）；
  - **疊人式浮層禁寫死 z-index**：能蓋在另一個浮層之上的浮層（工具詳情、檔案預覽、圖片預覽、全屏 diff、審批/授權彈窗……）一律用 `web/src/overlay-stack.ts` 的 `useOverlayZIndex()` 取層號，內聯 `style.zIndex` 覆蓋主題；疊棧從 `var(--z-overlay-stack)`（100000）起、按開啟順序往上排，臨時通知固定在 `var(--z-notice)`（100050）永遠在最上。**不要再給“比誰高”另挑一個更大的數字**（100001/100005 那類疊上去只會把下一個套娃浮層又蓋住）；需要自開 stacking context 的彈窗用 `.overlay-layer` 殼。靜態浮層最高 10000（守衛：`tests/unit/overlay-stack.test.ts`）。
  - 側邊停靠欄（`SideDock`）為流內 flex 專案，浮動模式由 `sideDockFloat` 控制，嚴禁寫死 fixed 遮擋側邊按鈕。
- **輸入框上方那條帶子屬於訊息區**：快捷短語行只是浮在它上面，正文從晶片**之間**的縫裡透出來（晶片本身是實底小卡片，壓在正文上必須壓得住字）。帶子高度單源在 `.main` 的 `--composer-strip`（= `--composer-pad-top` + ChatInput 實測寫入的 `--quick-row-h` + 6px）；改輸入區上內邊距或短語行留白必須同時顧三處：`.messages-wrap` 的負 margin、`.messages` 的底部留白、以及按容器底緣定位的 `.scroll-bottom` / `.qn-rail`（都要 `+ var(--composer-strip)` 回補），嚴禁把短語行改回 `position: absolute`（會與藥丸/浮標搶同一條帶子，折行時必疊）。守衛：`messages-behind-composer.test.ts`。
- **拖拽與觸控互動標準**：
  - 圖示編輯與拖拽必須監聽 Pointer 事件，嚴禁使用 HTML5 DnD（移動端觸屏不觸發）；內建圖示須在 `host-icon.tsx` 登記；選單行文字統一 12.5px（守衛：`host-icon.test.ts`、`topbar-overflow-menu.test.ts`）。
  - 手機端橫滑手勢（`swipe-drawer.ts`）必須避開系統側滑區，手勢期間直寫內聯 transform 停用動畫過渡，鬆手後清理內聯值交由 CSS 類過渡；移動端遮罩常駐（守衛：`swipe-drawer.test.ts`）。
- **訊息操作語義**：提示懸浮即顯且簡短；重新提問和編輯後重問在當前會話截斷原問題及後續內容後重發；分叉包含所選訊息並建立新對話；回退開啟對應使用者問題的編輯框，提交後在當前會話重問，取消不改歷史。詳見 [`architecture-core.md`](architecture-core.md)「訊息操作」。
- **新會話初始化互動**：切換或新建會話須經 `focusComposer()` 聚焦（觸屏除外），非 chat 檢視自動切回，待發附件 chips 隨新會話清空（守衛：`composer-draft.test.ts`）。

## 四、架構與執行態約束

- **目標模式 2.0 執行鐵律**：主對話作為審查者，服務端另起落盤執行者；輪次、代次與停滯熔斷全由服務端管控，嚴禁模型自行呼叫 wait/spawn；審查指令必須注入執行證據（`goal-evidence.ts`）；會話中止或關閉即停止迴圈，不得無限續輪（守衛：`goal-delegated.test.ts`、`goal-evidence.test.ts`，文件：[`goal-conversation-design.md`](goal-conversation-design.md)）。
- **審查者委派模式（Delegate Mode）**：開啟後主對話只審不幹，使用者輸入自動派發給常駐執行會話；閘門強制攔截寫操作與子代理派發；計劃模式優先順序高於委派（`server/delegate-mode.ts`、`server/plan-mode.ts`）。
- **預設依賴與部分應用**：交換文件頂層 `plugins` 僅攜帶外掛需求後設資料，不含配置、金鑰、儲存或授權；安裝複用顯式 `plugin_job`。部分預設未攜帶的欄位不得補預設或清空當前設定，`plugins` 不得進入執行設定；儲存、應用、延後載入和應用失敗分別回執（見 [`preset-sharing.md`](preset-sharing.md)）。
- **預設分享必須白名單嚴格淨化**：匯入外部 JSON 必須通過 `server/preset-share.ts` 白名單校驗（`preset-fields.ts`），丟棄未知欄位，執行 dryRun 確認，嚴禁未經校驗直接攤入 `ClientSettings`（守衛：`preset-share.test.ts`，文件：[`preset-sharing.md`](preset-sharing.md)）。
- **原子寫 / 重試單源在 `server/atomic-file.ts`**：`writeAtomicSync` / `writeAtomic` / `readFileSyncRetry` 自帶 EPERM/EACCES/EBUSY 的**真退避**（20/60/150/400ms）——Windows 上防毒與索引器會短暫佔用剛寫完的檔案，`rename` 的瞬時失敗是常態，空轉重試（無 sleep）等於沒重試。Hub 升級 worker 不能 import TS，故 `bin/lib/atomic-file.mjs` 由 `npm run gen:atomic`（`build:server` 末尾自動跑）從同一份實現生成，禁手改；升級記賬寫失敗**不得**阻斷回滾（先恢復舊服務，後設資料降級為盡力而為）（守衛：`atomic-file.test.ts`、`atomic-file-generated.test.ts`、`hub-upgrade-runtime.test.ts`）。
- **Windows 最小化通知**：Windows 最小化時頁面 visibility 狀態不準確，必須通過視窗尺寸矩形判斷（`isCollapsedWindow`）；通知禁止攜帶 `tag` 欄位，防止被系統靜默吞併。
- **壓縮軟上限必須雙層監控，換模型必須走 `applySessionModel`**：SDK 的 `compaction.reserveTokens` 是**回合內**唯一的檢查點（工具呼叫間隙 `_compactBeforeNextAssistantResponse`），必須逐會話算成 `cw - cap`，否則自治長跑（子代理 / 單回合幾十次工具呼叫）全程無空閒態，永不會壓（`#773`）；且 reserve 依賴會話**當前**模型，任何裸 `session.setModel()` 都會讓判定線卡在上一模型的 `W - C` 上，換模型一律走 `applySessionModel`；cap ≤ keepRecent + headroom 時不注射（否則每個工具間隙重壓一次）。`server/soft-cap.ts`。
- **直連 `ModelRuntime` 必須自帶 `sessionId`**：SDK 只在 AgentSession 內注入 `options.sessionId`；繞過會話直調 `completeSimple` / `streamSimple` 的模組（隨手問、提交資訊生成、視覺轉寫、群路由）必須傳 `modelSessionId()`（`server/model-session.ts`：同一話題傳穩定種子，一次性呼叫不傳），否則 opencode / opencode-go 閘道器缺 `x-opencode-session` 頭會直接 400 `MissingSessionID`（守衛：`tests/unit/model-session.test.ts`）。
- **模型目錄官方整表替換**：通過 `patch-remote-catalog.ts` 冪等改寫 SDK 目錄，不殘留舊定義，升級後自動重新應用。
- **DSH 執行態三規則**：shipped 預設使用 `preset-clones.ts` 的 file: 克隆隔離；問卷與過濾鉤子掛 agent scope；統計指標吃直播幀與 assistant/message.usage（`dsh-usage.ts`）。見 [`dsh-engine.md`](dsh-engine.md)。
- **會話過戶與狀態遷移**：`take_over_conversation` 完整搬遷 runtime 本體，且**是事務性的**（源側已摘、目標側接入失敗就原樣搬回，絕不留「還在跑但沒人持有」的幽靈會話，見 `#556` / `tests/takeover-rollback-test.mjs`）；**斷連殘骸的「另一處」行有寬限期**（`PI_WEB_OFFLINE_ROWS_TTL_MS`，預設 30 分鐘，標 `ownerOffline`，仍可過戶——手機 run 途中關頁面後換裝置仍能接管）；`ask_user_question` / `browser_page` 解析建立時的 session 物件（`bridgeTarget`）；跨頁答覆帶 owner。
- **工作區命令必須序列（`#872`）**：`cs.cwd` / 活動對話 / runtime 繫結是同一組可變狀態，改它們的命令（`set_cwd` / `new_chat` / `new_cli_chat` / `switch_session` / `switch_conversation` / `fork_session` / `rollback_session` / `make_dir(setAsCwd)` / 沙盒切換）一律走 `server/workspace-queue.ts` 的會話級 FIFO（派發層「同步認領 + 入隊」）；建會話可用 `new_chat.cwd` 宣告目標，切不過去就不建（回執 `ok:false`）。**禁止**在前端逐處補 cwd、也禁止把建會話寫成不等 `set_cwd` 的併發呼叫。客戶端意圖單源為 `web/src/pending-workspace.ts`（守衛：`tests/unit/workspace-queue.test.ts`、`tests/unit/pending-workspace.test.ts`）。
- **宿主提供的包只能宣告在 `peerDependencies`（`"*"`）**：pi 擴充套件載入器只掃 `dependencies`（命中 `@earendil-works/pi-coding-agent` / `typebox` 就告警：巢狀副本會繞開載入器注入、搞出重複執行時模組）。本包同時是擴充套件與獨立服務端，服務端子程序真要這兩個包（`PI_WEB_SDK=bundled` 也要自帶副本）→ 落在 `optionalDependencies`（npm 預設照裝）。守衛 `tests/unit/extension-host-packages.test.ts`。
- **佈局頁改名 / 外掛 `arrange.label` 必須落到渲染層**：合併引擎對「顯式指定的文案」置 `UiSlotEntry.labelExplicit`；內建條目（頂欄按鈕、底欄數值徽標）一直畫寫死的 i18n 與即時數值，只有旗立著時才讓位（名字型頂掉內建文案；數值型把名字插在數值前，不吞即時資料）。只在設定頁生效 = 假承諾（`#555`，守衛 `tests/unit/bar-item-unified.test.ts`）。
- **外掛修改必須遞增版本號（Bump Version）**：內建官方外掛（`plugins/<id>/`）凡修改了程式碼/功能/靜態資源（非純文件），必須同步遞增 `manifest.json` 中的 `version`（若有 `package.json` 的 `version` 須保持一致）。原因：隨包熱同步（`syncBuiltinPlugins`）與更新器（`plugin-updater`）均以 `compareVersions(srcVer, tgtVer) > 0` 作為升級判定的唯一權威事實源；若漏改版本號，老使用者更新主程式後資料目錄中的舊外掛程式碼永遠不會被熱更新覆蓋，導致缺陷滯留（守衛：`tests/unit/plugin-version-bump-guard.test.ts`）。
- **外掛程式碼目錄是純快取，狀態只住 `plugin-data/<id>/`**：`plugins/<id>/` 會被物化/升級重放（完整性由回執 `.pi-materialized.json` 裁定，半殘就地補齊），所以設定 / 機密 / 定時任務 / 能力確認標記一律走 `pluginStateDir()`，不得寫在程式碼目錄裡；複製黑名單隻能在 `server/fs-copy.ts` 按**相對路徑**判定——`cpSync` 的 filter 拿到的是絕對路徑，npm -g 安裝（包目錄本身就含 `node_modules`）會把整棵樹過濾成空副本還被當成已安裝（守衛：`tests/unit/plugin-copy-single-source.test.ts`、`plugin-bundled.test.ts`、`plugin-paths.test.ts`，來源 `#856`）。
- **修改測試外掛一定要及時更新本地外掛**：本地實際執行載入的外掛位於資料目錄（`<dataDir>/plugins/<id>/`，如 `~/.pi-web/plugins/<id>/`）。修改或測試工作區內建外掛時，除遞增版本號外，必須及時將最新原始碼同步覆蓋至本地資料目錄的對應外掛中，防止開發除錯時因舊程式碼快取導致行為脫節。
- **國際化字面量要求**：`i18n.tsx` 的詞條值必須使用字串字面量（僅允許 `+` 拼接），確保 `scripts/i18n-diff.mjs` 靜態解析器正常執行。

- **服務端禁同步子程序呼叫（`spawnSync` / `execSync` / `execFileSync`）**：這三個 API 在事件迴圈執行緒上 fork+exec，並**一直阻塞到子程序結束**。子程序如果卡在 `exec()` 之前（Termux/Android 上實測能穩定復現），主執行緒就永遠停在 spawn 錯誤管道的 `read()` 上——定時器、socket、`/api/health` 全部停擺，只能靠外部 watchdog 殺程序。非同步 `spawn` / `execFile` 不會被拖到子程序結束，`timeout` 也只對非同步版有意義（同步版根本回不到超時處理）。兩條可行路線：換成非同步 spawn + 超時；或者把答案**靜態推導**出來（`server/global-loader.ts` 的 npm prefix、`server/dsh/runtime/runtime-root.mjs` 的計算式字首都是這麼改的）。掃描範圍包含**外掛主程序程式碼**（`server/plugins.ts` 用 `import()` 把 `plugins/<id>/index.mjs` 載進主程序，與伺服器共用事件迴圈；`bin/`、`assets/`、`build.mjs` 這類獨立程序的東西除外）。存量按**次數**登記在守衛的只減不增名單裡，新程式碼請直接走非同步或靜態推導（守衛：`tests/unit/sync-child-process-guard.test.ts`，來源 `#830`）。

## 五、其餘邊界（只在別處維護，見連結）

這些條目已在專門文件裡詳細維護，`AGENTS.md` 只保留一行指標，新增內容請寫進對應文件：

| 邊界                                                                          | 文件                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 設定同步（`SettingsService.push()` / `refreshSettings()` / `applyRuntime()`） | [`architecture-core.md`](architecture-core.md)「非同步歸屬與持久化邊界」 |
| pi 請求上下文投影、`context-evidence` 證據、壓縮任務指令                      | [`tool-context-budget.md`](tool-context-budget.md)                       |
| 跨 await 歸屬、取消訊號、代次、歷史分頁、CSP sandbox、SSH known_hosts         | [`architecture-core.md`](architecture-core.md)「非同步歸屬與持久化邊界」 |
| WS 限額、attach 佇列、歷史搜尋、壓縮恢復 sidecar、檔案儲存、任務持久化        | [`architecture-core.md`](architecture-core.md)「命令、搜尋與恢復狀態」   |
| 沙盒身份、基線寫回、生命週期                                                  | [`architecture-sandbox.md`](architecture-sandbox.md)                     |
| 穩定歸屬、工作樹清理、取消代次                                                | [`root-cause-boundaries.md`](root-cause-boundaries.md)                   |
| 群組 / Bot / 跨裝置協作                                                       | [`device-collaboration.md`](device-collaboration.md)                     |
| 畫布版本、執行代次、產物隔離                                                  | [`architecture-canvas.md`](architecture-canvas.md)                       |
| MCP 專案執行態                                                                | [`architecture-plugins.md`](architecture-plugins.md)「MCP 專案執行時」   |
| 提示詞模板與 `/命令`                                                          | [`development.md`](development.md)「提示詞模板命令」                     |

## 六、原始碼註釋

- 預設不寫原始碼註釋；刪除複述程式碼、檔案頭介紹、分段標題、歷史變更、臨時說明和註釋掉的廢程式碼，避免過期說明誤導後續判斷。維護規則與架構說明放在對應 `docs/` 文件。
- 保留許可證、型別與構建/檢查指令、執行時讀取的後設資料，以及解釋非顯然安全邊界或約束的簡短說明；字串、正則和模板裡的文本按實際用途判斷。
- 測試按實際程式碼結構或穩定標識定位原始碼，不依賴普通註釋的文字。

## 七、終端命令執行（防卡死）

掛死只有五類根因，規則按**根因**寫，不要按「看起來卡住的命令」逐個打補丁（`| sort` 只是緩衝導致看不到進度，讀的是 EOF，本身不會死鎖）：

1. **等 stdin**：`npx` 安裝確認、`git commit` 無 `-m`、REPL、`read -p`。必須顯式非互動（`CI=true`、`npx --yes`、`npm i --no-audit --no-fund`、`git commit -m`）；執行器一律把子程序 stdin 接 `/dev/null`，讀到 EOF 即返回。
2. **不退出**：`--watch`、dev server、前臺 daemon、死迴圈。禁止前臺跑。**產品內（任意使用者專案）用 `bash({background:true})`**：呼叫立即返回 job id + 日誌路徑，程序登記在頂欄「後臺任務」面板（可單獨停止 / 全部關閉 / 不參與遺留清理）；原始碼倉庫與 CI 裡仍用 `safe-exec --detach` 託管 + 輪詢。
3. **pager**：`less` / `more` / `git log` 預設分頁器等 TTY 按鍵。用 `PAGER=cat`、`GIT_PAGER=cat`、`git --no-pager`；執行器預設注入。
4. **輸出淹沒上下文 / 後臺子程序繼承 stdout**：原始輸出先落盤，只回顯尾部；分析用 `grep` / `read --offset` 分步讀，禁止 `cmd | sort` / `| less` / `| head` 這類必須吃到 EOF、T 掉 TTY 或持住管道控制代碼才算完的直連管道。
5. **靜默卡死**：程序活著但再也不產出（等鎖、等網路、等一個拿不到的控制代碼、把活丟給已死的孫程序）。靠 `--idle-timeout` 判：連續 N 秒零輸出即強殺。只給「正常跑必有心跳輸出」的任務開（預設關閉）；構建 / 型別檢查這類天然安靜的別開。

時長分檔與用法（`scripts/safe-exec.mjs`，跨平臺 Node 包裝器）：

| 場景               | 命令                                                               | 判據                                    |
| ------------------ | ------------------------------------------------------------------ | --------------------------------------- |
| 單測 / lint / 型別 | `node scripts/safe-exec.mjs --timeout 60 -- npx vitest run <file>` | 超時返回 `124`                          |
| 全量構建 / 編譯    | `--timeout 600`，必帶 `--log`                                      | 超時返回 `124`                          |
| 預計 >3 分鐘       | `--detach` 託管 → `--wait <jobfile> --json` 輪詢 → `--kill` 終止   | 啟動立即返回；`--wait` 提前結束提前返回 |
| AI 單次工具呼叫    | pi `bash` 工具的 `timeout` 引數 + 會話級工具看門狗                 | 超時 `session.abort()`                  |

`124` 意味著**換策略**，不是重試：先讀日誌定位卡點（慢？卡網路？等鎖？），再調分檔或改後臺。程序樹終止以 `server/process-utils.ts` 的 `killPidTree` 為單源，不另行手寫 `taskkill` / `kill -9` 片段。守衛：`tests/unit/safe-exec.test.ts`。

後臺託管協議（AI 照抄即可，禁自行發明輪詢方式）：

1. **起**：`--detach --timeout <總秒> [--idle-timeout <N>] --log <path> -- <cmd...>`，從輸出（或 `--json`）拿 `job=<jobfile>`。
2. **等**：只跑 `node scripts/safe-exec.mjs --wait "<jobfile>" --wait-sec 10 --json`。它內部計時，任務提前結束立刻返回，到點則返回這段時間的 `newOutput`（游標已推進，**不會重複輸出**）。不寫 `sleep`、不拼 `&&`、不依賴 `$?`。
3. **判**：`status` 為 `RUNNING` 繼續 `--wait`；`SUCCESS` / `FAILED` 看 `exitCode` 與日誌；`ABORTED`（含 `childAlive: true` 的「看門狗寬限後未死透」）說明子程序還在跑，先 `--kill` 再重跑；`TIMEOUT` / `IDLE_TIMEOUT` 禁止原樣重試，先讀日誌改分檔或去掉管道；`pipesForced: true` 說明有孫程序繼承了輸出管道且已強制結算，日誌可能只到 exit 為止。
4. **收**：`--kill "<jobfile>"` 先殺子程序樹再收守護程序；產物三件套 `.pid` / `.state.json` / `.cursor` 留在日誌旁，終態後可直接刪。`--status` 可以隨手查（只讀，不消費增量），別用 `--status` 代替 `--wait` 做輪詢迴圈。
