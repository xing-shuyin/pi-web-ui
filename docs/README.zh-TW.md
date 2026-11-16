[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# docs/ 文件總索引

> 本倉庫文件的**唯一入口**。`AGENTS.md` 只放「關鍵功能 → 事實原始檔 → 文件」的對映，本檔案放「每份文件講什麼、多重、什麼時候該讀」。
> 新增 / 刪除 / 改名文件必須同步本索引（守衛：`tests/unit/docs-index.test.ts`）。
> 每份文件都有英文與繁體中文版：同目錄下的 `檔名.en.md` 與 `檔名.zh-TW.md`，三份檔案頂部可互相切換語言；本索引只登記中文原稿。覆蓋度自查：`npm run docs:i18n`（`--check` 為門禁版本）；`docs/*.html` 設計稿同樣有 `.en.html` / `.zh-TW.html` 版本（守衛：`npm run docs:i18n:html`）；`CHANGELOG.md` 由釋出指令碼生成。

## 權重含義

| 標記 | 含義                                                       | 閱讀方式               |
| ---- | ---------------------------------------------------------- | ---------------------- |
| ★★★  | 動核心程式碼前必讀：全域性架構決策、跨模組紅線、程式碼地圖 | 通讀                   |
| ★★   | 碰對應模組前必讀：該模組的實現邊界、狀態機、常見坑         | 通讀該篇               |
| ★    | 運維 / 部署 / 配置接入：改環境、上線、連供應商時查         | 按需查表               |
| ○    | 參考材料：設計稿、歷史審查、審查證據、示例預設             | 不必通讀，按追溯需要讀 |

紅線細則（顏色令牌、`details` 上限、提示詞三處分離、壓縮軟上限、過戶事務性等）**統一在 [`agent-rules.md`](agent-rules.md)**，其它文件不再複述禁令。

## 一、全域性必讀（★★★）

| 文件                                                 | 主題                                                                                                                                | 何時讀                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| [`architecture-core.md`](architecture-core.md)       | 核心架構：快照驅動、協議單源、安全邊界、主題與 CSS 分層、中央列幾何、多對話併發、審批、問卷、非同步歸屬與持久化、命令/搜尋/恢復狀態 | 任何跨端、執行態、審批、併發改動     |
| [`architecture-plugins.md`](architecture-plugins.md) | 外掛體系：manifest、34 個 UI 插槽與四層合併、宿主 API、MCP 專案執行態、多根工作區、定時任務、市場與更新                             | 外掛、UI 擴充套件點、MCP、工作區改動 |
| [`architecture-tts.md`](architecture-tts.md)         | 統一 TTS 引擎中心：系統音色、外掛註冊、音訊合成、網頁播報與 QQ 自動語音回覆                                                         | 語音、TTS 引擎與音色、QQ 回覆改動    |
| [`agent-rules.md`](agent-rules.md)                   | 編碼紅線細則：協議與資料安全、工具提示詞三處分離、UI 樣式與對比度、執行態鐵律、邊界指標表                                           | 提交前自查；改樣式/提示詞/執行態前   |
| [`development.md`](development.md)                   | 開發工作流：常用命令、CI 矩陣、編碼約定、AGENTS.md 索引約定、斜槓命令目錄、測試規範                                                 | 每天；動測試或無把握的寫法時         |
| [`directory-reference.md`](directory-reference.md)   | 目錄樹參考：每個檔案幹什麼（★ 標單源/入口）                                                                                         | 找檔案、判斷該改哪一層               |

## 二、模組專題（★★）

| 文件                                                             | 主題                                                                                                | 何時讀                                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`architecture-browser.md`](architecture-browser.md)             | 內建瀏覽器模組、桌面 browser/agent/split、可信原生頁面橋、資料與打包                                | 動瀏覽器、桌面組合、Web 原生操作                 |
| [`plugin-hongguo.md`](plugin-hongguo.md)                         | hongguo 外掛：懸浮 / 分屏播放、選集續播、媒體代理、FFmpeg、快取與常駐生命週期                       | 動短劇播放器、播放佈局或媒體介面                 |
| [`mobile.md`](mobile.md)                                         | React + Capacitor 手機客戶端、裝置中心登入與多裝置切換、極光 / APNs 通知與構建驗收                  | 動手機 App、後臺通知、native 裝置連線            |
| [`mobile-local-engine.md`](mobile-local-engine.md)               | 本機引擎：APK 內 rootfs + Node 跑 pi-web-ui、proot 免 root、三模式連線與倉庫策略                    | 動 mobile/local-engine、Android 殼、手機獨立執行 |
| [`architecture-terminal.md`](architecture-terminal.md)           | 終端 PTY、SCM 只讀走 execFile、`ownerKind` 歸屬、bash 接管分流、SDK process patch hook              | 動終端、bash 路由、Git 面板                      |
| [`architecture-attachments.md`](architecture-attachments.md)     | 附件 / 圖片 / 視覺橋、預覽嗅探與 GBK 回退、512KB 上限、媒體 Range、上傳下載安全                     | 動附件、預覽、檔案儲存                           |
| [`architecture-system-prompt.md`](architecture-system-prompt.md) | 系統提示片語裝鏈路：`compose` 模板、`{{tools}}` 目錄、override 鉤子、專案上下文檔案                 | 動提示詞、工具描述、上下文注入                   |
| [`tool-context-budget.md`](tool-context-budget.md)               | 工具上下文預算：文案精簡、逐工具覆蓋、延遲載入、字首快取硬約束、只讀去重、證據外接、壓縮指令        | 工具多到吃預算、延遲載入、上下文最佳化           |
| [`i18n.md`](i18n.md)                                             | 模組字典、全部語言翻譯源、語言包同步與 Canvas 執行訊息                                              | 動介面文案、語言包或翻譯工具                     |
| [`architecture-canvas.md`](architecture-canvas.md)               | 畫布協同：`@畫布` 引用、revision 儲存、定時觸發、每輪執行與返工、Git 隔離產物                       | 動畫布、圖形工作流、產物回寫                     |
| [`architecture-sandbox.md`](architecture-sandbox.md)             | 沙盒工作區：身份與准入、基線寫回三方比較、生命週期凍結、驗證重點                                    | 動沙盒、寫回、執行邊界                           |
| [`root-cause-boundaries.md`](root-cause-boundaries.md)           | 根因整改邊界：穩定歸屬、取消代次、持久提交與安全清理、工作樹清理、HTTP 傳輸                         | 動非同步/歸屬/清理/網路請求                      |
| [`goal-conversation-design.md`](goal-conversation-design.md)     | 目標模式 2.0 設計：執行對話 + 審查者主對話、服務端輪次與熔斷、證據注入                              | 動目標模式、審查迴圈                             |
| [`dsh-engine.md`](dsh-engine.md)                                 | DSH 雙引擎：四預設 file: 克隆隔離、問卷與技能鉤子掛 agent scope、底欄統計吃直播幀                   | 動 DSH 預設 / 問卷 / 統計                        |
| [`preset-sharing.md`](preset-sharing.md)                         | 預設匯入匯出：白名單淨化、dryRun、一鍵分享、社群目錄與 gh 回落                                      | 動設定預設、分享流程                             |
| [`device-center.md`](device-center.md)                           | 裝置中心：Hub 與聯結器、繫結配對、群聊、單埠 `/device/<id>/` 與 CSP sandbox                         | 動裝置中心服務端                                 |
| [`device-collaboration.md`](device-collaboration.md)             | 群組 / Bot / 跨裝置協作硬約束：任務派發、Bot registry lease、併發排程、任務恢復、交付審查、遠端桌面 | 動群任務、Bot、跨裝置協作、交付流                |
| [`group-orchestration.md`](group-orchestration.md)               | 群組 AI 路由、工單持久化、Superagent 渠道與執行協作                                                 | 動群組排程與工單                                 |
| [`device-desktop.md`](device-desktop.md)                         | 遠端桌面：原生 JPEG over WS、平臺許可權、只讀強制、停用中繼的本地介面                               | 動遠端桌面                                       |
| [`streaming-stability.md`](streaming-stability.md)               | 流式訊息穩定性：身份貫穿三層、不解除安裝不重置、不移動閱讀位置                                      | 動訊息渲染 / 流式狀態                            |
| [`loading-performance.md`](loading-performance.md)               | 載入最佳化：首屏動態匯入、`DeferredMount` 語義、歷史對話載入                                        | 動首屏、懶載入、大列表                           |

## 三、運維與接入（★）

| 文件                                                                               | 主題                                                                 | 何時讀                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------ |
| [`env-vars.md`](env-vars.md)                                                       | 環境變數全表（埠/鑑權/資料目錄/引擎/視窗/預設/SSH/遠端桌面）         | 改配置、排查行為差異                 |
| [`deployment.md`](deployment.md)                                                   | 部署：前臺、自啟（launchd/systemd/Run 鍵）、Docker、反代與子路徑     | 上線、裝機、守護程序                 |
| [`device-center-deployment.md`](device-center-deployment.md)                       | 裝置中心獨立部署：Hub 拓撲、賬號、聯結器、域名與 TLS                 | 部署裝置中心                         |
| [`hub-upgrade-release-testing.md`](hub-upgrade-release-testing.md)                 | Hub 升級流程與釋出前升級驗證                                         | 釋出與驗證 Hub 更新                  |
| [`release.md`](release.md)                                                         | 釋出：版本號、changelog:i18n、tag 與 Action、npm publish             | 發版                                 |
| [`official-providers.md`](official-providers.md)                                   | 官方供應商快速配置                                                   | 接官方 API Key                       |
| [`antigravity-proxy.md`](antigravity-proxy.md)                                     | Antigravity-Manager 反代接入（本機 8045）                            | 用反代接 Google/Anthropic            |
| [`magpie-proxy.md`](magpie-proxy.md)                                               | Magpie 反代接入（多供應商統一閘道器）                                | 用 Magpie 聚合供應商                 |
| [`external-channel-capabilities.md`](external-channel-capabilities.md)             | 外部訊息渠道：11 個平臺命令與能力矩陣                                | 接微信/QQ/飛書/Telegram 等           |
| [`unattended-operation.md`](unattended-operation.md)                               | 無人值守：`manifest.alwaysOn` 與後臺執行者登錄檔、`/api/health` 探針 | 不開網頁也要跑（機房/容器/開機自啟） |
| [`daily-ai-maintainer-workflow.md`](daily-ai-maintainer-workflow.md)               | 每日 AI 倉庫維護：執行鎖、分診順序、交付形態                         | 維護定時維護任務                     |
| [`workflows/daily-ai-maintainer-setup.md`](workflows/daily-ai-maintainer-setup.md) | 上述工作流的落地配置（含 `workflows/*.canvas.json` 畫布定義）        | 首次搭維護流水線                     |

## 四、參考材料（○，不必通讀）

| 位置                                                                                                                                                                                                                                                                                                                                                             | 內容                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`agent-bot-design.md`](agent-bot-design.md)                                                                                                                                                                                                                                                                                                                     | Bot 獨立化設計稿：直聊/派活/投遞、一句話建立、獨立記憶與預算 |
| [`issue-885-triage.md`](issue-885-triage.md)                                                                                                                                                                                                                                                                                                                     | #885 分診記錄：驗收條目逐條核實與 6 步拆分建議               |
| [`device-file-sync.md`](device-file-sync.md)                                                                                                                                                                                                                                                                                                                     | 分塊目錄匯出（`prepare({recursive})`）的邊界與拒絕規則       |
| [`audits/root-cause-review-2026-10-29.md`](audits/root-cause-review-2026-10-29.md)                                                                                                                                                                                                                                                                               | 根因整改審查證據（對應 `root-cause-boundaries.md`）          |
| [`test-performance-audit.md`](test-performance-audit.md)                                                                                                                                                                                                                                                                                                         | 單測效能審計：實測基線、快/重兩池、未解瓶頸                  |
| [`reviews/canvas-usability-review-2026-07.md`](reviews/canvas-usability-review-2026-07.md)                                                                                                                                                                                                                                                                       | 畫布可用性評審記錄                                           |
| [`proposals/`](proposals)                                                                                                                                                                                                                                                                                                                                        | 舊提案（issue #769 diff 視覺化兩個 HTML 方案）               |
| [`composer-height-solutions.html`](composer-height-solutions.html) · [`plugin-market-redesign.html`](plugin-market-redesign.html) · [`settings-modern-redesign.html`](settings-modern-redesign.html) · [`settings-mobile-redesign.html`](settings-mobile-redesign.html) · [`device-directory-redesign-proposals.html`](device-directory-redesign-proposals.html) | 互動/視覺設計稿（HTML，瀏覽器直接看）                        |
| [`presets/README.md`](presets/README.md) · [`examples/`](examples)                                                                                                                                                                                                                                                                                               | 預設交換格式示例與內建預設樣例                               |

## 五、按場景的閱讀路線

| 我要…                        | 先讀                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| 改跨端協議 / 快照 / 會話     | `architecture-core.md` → `agent-rules.md`（協議與資料安全）                                   |
| 加或改工具                   | `agent-rules.md`（工具與提示詞）→ `tool-context-budget.md` → `architecture-system-prompt.md`  |
| 改樣式 / 主題 / 佈局         | `agent-rules.md`（UI 佈局與樣式）→ `architecture-core.md`（主題、CSS 分層、中央列幾何）       |
| 動終端 / bash                | `architecture-terminal.md` → `agent-rules.md`（命令與恢復狀態邊界）                           |
| 動畫布 / 圖形工作流          | `architecture-canvas.md` → `root-cause-boundaries.md`                                         |
| 動 Bot 獨立化 / 記憶         | `agent-bot-design.md` → `device-collaboration.md` → `tool-context-budget.md`                  |
| 動群組 / 裝置中心            | `device-collaboration.md` → `device-center.md` → `device-center-deployment.md`                |
| 動外掛 / UI 插槽 / MCP       | `architecture-plugins.md` → `agent-rules.md`（外掛版本號、`arrange.label`、peerDependencies） |
| 動目標模式 / 委派 / 計劃模式 | `goal-conversation-design.md` → `agent-rules.md`（執行態鐵律）                                |
| 動沙盒                       | `architecture-sandbox.md` → `root-cause-boundaries.md`                                        |
| 不開網頁也要跑 / 常駐執行者  | `unattended-operation.md` → `architecture-plugins.md`（生命週期與許可權）                     |
| 排查記憶體 / 上下文爆炸      | `tool-context-budget.md` → `loading-performance.md` → `streaming-stability.md`                |
| 部署 / 排障環境變數          | `deployment.md` → `env-vars.md`（裝置中心另見 `device-center-deployment.md`）                 |

## 六、維護約定

1. **一處一件事**：細則寫進對應主題文件；`AGENTS.md` 只登記入口，本索引登記主題與權重。
2. **新增文件** = 建檔案 + 在本索引對應分組加一行（寫明主題、權重、何時讀）+ 必要時在 `AGENTS.md` 對映表補一行。
3. **紅線不散落**：新增禁令寫進 `agent-rules.md`，並在 `AGENTS.md` §3 補一行 + 守衛測試名。
4. 守衛：`tests/unit/docs-index.test.ts`（本索引覆蓋全部 `docs/*.md`、連結與錨點存活、每行有權重標記）、`tests/unit/agents-md.test.ts`（`AGENTS.md` 體量與死鏈）。
