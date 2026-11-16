[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# legado-web（📖 閱讀）

把 [Legado / 閱讀](https://github.com/gedoor/legado) 的核心讀書鏈路搬進 pi-web-ui：
**搜尋 / 發現 / 詳情 / 目錄 / 正文**，書源 JSON 與安卓版相容，另帶書源匯入、廢源檢測與清理。

介面是原 `legado-web`（Vite + vanilla TS）應用，**整幅內嵌在外掛視圖裡**（iframe），
外掛負責它需要的一切後端：跨域+GBK 代理、本地儲存、靜態託管。

另外給 AI 配了一套**修源介面**（agent 工具 `legado_rules` / `legado_book_sources` /
`legado_source_probe` / `legado_run_rule`）：agent 能讀規則速查、讀書原始檔、逐步跑鏈路看斷在哪一步、
拿真實頁體試規則，然後只改壞掉的欄位（詳見下文「AI 修源介面」）。

## 安裝

```bash
# 本機倉庫裡直接裝（開發除錯）
pi-web-ui install <repo>/plugins/legado-web

# 已推到 GitHub 後
pi-web-ui install <owner>/<repo>/plugins/legado-web
```

裝好重新整理瀏覽器，頂欄出現 📖 tab（設定面板 →「介面外掛」裡可隱藏）。

## 構建

`client/app/`（內嵌前端）與 `server/engine.mjs`（AI 診斷用的規則引擎）都是構建產物，
隨外掛分發。改了 `app/src/` 後：

```bash
node plugins/legado-web/build.mjs            # 缺 node_modules 時自動 npm install + vite build + esbuild 引擎
node plugins/legado-web/build.mjs --install  # 強制重灌依賴
pi-web-ui install <repo>/plugins/legado-web --force   # 覆蓋安裝（外掛目錄裡也有一份產物）
```

## 結構

```
plugins/legado-web/
├── manifest.json      # id/name/icon 📖，permissions: http（host.route）+ net（出站抓取）+ tools（AI 工具）
├── index.mjs          # 服務端入口：/proxy、/store，並註冊四個 AI 工具
├── net.mjs            # 公共抓取層（GBK 編解碼 + cookie jar），UI/引擎/同步橋共用
├── store.mjs          # 資料落盤（<dataDir>/legado-web/<鍵>.json，原子寫）
├── tools.mjs          # AI 工具：legado_rules / legado_book_sources / legado_source_probe / legado_run_rule
├── rules.md           # 書源規則速查（人看 + AI 的知識庫，legado_rules 原樣返回）
├── engine-bridge.mjs  # 主程序側的引擎橋（worker 生命週期 + 超時重建）
├── engine-host.mjs    # 引擎 worker：注入 transport、localStorage 墊片，跑 probe/check/rule
├── sync-bridge.mjs    # 同步橋（worker 執行緒裡 Atomics.wait，給 java.ajax 這類同步規則用）
├── sync-worker.mjs    # 同步橋 worker：真發請求，結果寫回共享記憶體
├── client/
│   ├── entry.mjs      # 檢視入口：佔滿檢視的 iframe（零依賴純 DOM，無工具欄）
│   ├── ai-fix.mjs     # 「AI 修復源」正文組裝（純函式，entry.mjs 與測試共用）
│   └── app/           # 內嵌前端構建產物（index.html + assets/*，構建生成，勿手改）
├── server/
│   └── engine.mjs     # 規則引擎構建產物（esbuild 從 app/src/core/engine-entry.ts 打包，勿手改）
├── app/               # 內嵌前端原始碼（源自 legado-web，見其 README）
│   ├── src/core/      # 書源規則引擎（analyzeRule/analyzeUrl/js/webBook/check/probe…）
│   └── vite.config.ts # base './' + outDir ../client/app
└── build.mjs          # 構建指令碼（npm install + vite build + esbuild 引擎）
```

## AI 修源介面（agent 工具）

外掛註冊了四個工具（`manifest.permissions` 裡的 `tools` 族），讓 agent 能“知道規則 → 讀書原始檔 →
跑鏈路找病因 → 試規則驗證 → 改回去”：

| 工具                  | 作用                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `legado_rules`        | 返回 `rules.md`（規則語法/欄位/差異/流程速查），可帶 `topic` 只要某章                                                                |
| `legado_book_sources` | 讀書原始檔：`list`（可按名字/URL 過濾，帶健康狀態）/ `get` / `update`（按欄位**深合併**）/ `add` / `remove`                          |
| `legado_source_probe` | 逐步跑「連通 → 搜尋 → 詳情 → 目錄 → 正文」，每步回報：請求地址/狀態/頁體片段、解析出的值、用到的**規則原文**、新增的**規則失敗明細** |
| `legado_run_rule`     | 抓頁試跑單條規則（`listRule` 支援條目級子規則），返回頁體片段與真實求值結果                                                          |

實現要點：

- 規則引擎跑在 **worker 執行緒**裡（`engine-bridge.mjs` + `engine-host.mjs`）——一次診斷要發好幾個外部請求（幾秒到幾十秒），不能卡住主程序的 WS/HTTP；超時或崩潰自動重建 worker。
- 引擎產物由 esbuild 從 `app/src/core/engine-entry.ts` 打成 `server/engine.mjs`（`platform=node`），與瀏覽器裡那份規則引擎**同一份原始碼**，行為一致。
- 書源 JS 規則裡的 `java.ajax/connect/get/post` 是同步語義：瀏覽器用同步 XHR，Node 裡由 `sync-bridge.mjs`（巢狀 worker + `SharedArrayBuffer` + `Atomics.wait`）實現，所以帶這類規則的源也能診斷。
- 引擎側注入了 `localStorage` 記憶體墊片（供 `java.cache`/infoMap）、非同步 transport（`net.mjs`，與 UI 的 `/proxy` 同一份實現）與同步 transport。
- 寫操作會 `host.notify` 提醒使用者重新整理閱讀頁（瀏覽器裡那份是記憶體副本）。

## 發現頁：收藏書源 + 直接搜這個源

發現頁（按 `exploreUrl` 瀏覽分類）上有兩件省事的事：

| 功能                   | 說明                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **☆ 收藏 / ⭐ 已收藏** | 收藏當前書源：下拉里多一個「⭐ 常用（收藏）」分組排在最前，下面還會多一行「⭐ 常用」按鈕，**點一下直接切源**（不用每次下拉翻）                                      |
| **直接搜這個源**       | 發現頁的搜尋框輸入關鍵詞 → 調當前源自己的搜尋介面 → 結果就列在下面同一個列表裡（標題寫「🔍 搜尋「x」」），不用切到「搜尋」頁；搜不到/報錯時旁邊就有「🤖 AI 修復源」 |
| 分類瀏覽               | 點分類照常翻頁（`下一頁`）；搜尋與分類共用一個列表容器，互不串味                                                                                                    |

收藏就是本機偏好（和書源頁的 ⭐ 置頂同一份資料）：`<dataDir>/legado-web/prefs.json` 的
`{"pinned":[書源URL…]}` —— 兩個頁面看到的是同一批"常用源"，刪源會一起清掉。

## 「AI 修復源」按鈕（閱讀頁 → AI 對話）

內嵌閱讀頁裡凡是“這本書讀不了”的地方都有 `🤖 AI 修復源`：

- 閱讀頁工具欄（當前這本書）+ 正文載入失敗的卡片
- 詳情載入失敗的卡片
- 書源列表每行（檢測不通過的源才顯示）
- 書源頁頂部「匯入書源」卡片裡的 `🤖 AI 新建書源`：**只填一個網站連結**，AI 自己抓頁寫出 searchUrl / ruleSearch / ruleBookInfo / ruleToc / ruleContent 並用 legado_source_probe 驗證，最後 legado_book_sources add 存檔

書源多的時候（幾百個很常見）靠這幾件在書源頁裡找：

| 功能                | 說明                                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **搜尋框**          | 按「名稱 / 地址 / 分組」即時過濾（輸入防抖、游標不丟，Esc 清空）；標題欄會寫「匹配「xx」N 個」                         |
| **⭐ 置頂**         | 每行左側一個 ⭐/☆ 按鈕：置頂的源排到列表最前（置頂行左側有強調色條），點「取消全部置頂」一鍵清                         |
| **只看置頂**        | 勾上只顯示已置頂的源（配合搜尋等於"收藏夾分組"）                                                                       |
| 隱藏廢源 / 隱藏可疑 | 按檢測結果過濾；單行的「標回可用」可清掉誤判                                                                           |
| **🍪 匯入 Cookie**  | 行內按鈕：把電腦瀏覽器裡該站的 `document.cookie` 粘進來，並進該源 header 代發（過盾/登入），匯入後自動重檢             |
| **🌐 瀏覽器回退**   | 行內開關（需本機裝 Chrome/Edge，外掛只檢測不捆綁）：開啟後該源命中盾頁時用本機真瀏覽器渲染重抓；沒裝則按鈕提示且不生效 |

置頂是**本機偏好**（不是書源 JSON 的欄位），存 `<dataDir>/legado-web/prefs.json` 的 `{"pinned":[書源URL…]}`；刪源時會順手把它的置頂清掉。

- 檢測頁每個失敗項
- 發現頁：書源選擇行（任何源都可手動修）+ 分類解析失敗處 + 分類載入失敗卡片

「AI 新建書源」的正文長這樣（只要一個連結，其餘交給 AI）：

```
【AI 新建書源】請為下面這個網站新建一個 Legado 文本書源（bookSourceType=0）並存盤。只加書源資料，不要改閱讀外掛本身。
- 網站：https://www.example.com
- 書原始檔（要加進去的就是它）：~/.pi-web/legado-web/sources.json
- 規則速查（只讀）：<外掛目錄>/rules.md
- 工作目錄：~/.pi-web/legado-web
1) legado_rules 看語義 → 2) legado_run_rule 抓首頁找搜尋入口 → 3) 寫 searchUrl+ruleSearch 並驗證 →
4) ruleBookInfo/ruleToc/ruleContent 逐步驗證 → 5) legado_source_probe 跑全鏈路 → 6) legado_book_sources add 存檔
```

點下去發生什麼：

```
閱讀頁（iframe）  postMessage {type:"legado:ai-fix", context:{書源/書籍/出錯地址/報錯/相關規則}}
   ↓
entry.mjs（外掛檢視，同源 + source 校驗）→ client/ai-fix.mjs 組正文
   ↓  window.__piWebUiHost.startChat({ prompt, newChat:true, cwd: 書源所在目錄 })
pi-web-ui 主應用：切到「對話」檢視 → 新建對話（cwd = `<dataDir>/legado-web`）→ 自動傳送
   ↓
AI 拿到正文後：legado_rules → legado_source_probe → legado_run_rule → legado_book_sources update
```

細節：

- **只改書源資料，不碰外掛本體**：正文裡給的是**書原始檔**（`<dataDir>/legado-web/sources.json`）與**規則速查檔案**（`<外掛目錄>/rules.md`，只讀參考）；
  外掛目錄仍然會告知，但明確標為**只讀**（install --force 會整目錄覆蓋，本機也可能沒有原始碼），並硬性要求「不要修改 app/、client/、server/、*.mjs，引擎不支援的寫法給等價規則繞法」。
- **cwd = 書源所在目錄**（dataDir，`sources.json`/`shelf.json`/`check.json` 就在那兒）——AI 的工作區就是它要改的那份資料，而不是外掛程式碼。
- 目錄資訊（書原始檔 / 規則速查 / dataDir / pluginDir / workspace）由外掛服務端在收到 `{type:"info"}` 時回。
- `startChat` 會等 `set_cwd` → 等新對話真的就緒（服務端的 `new_chat` 是非同步的，不等的話 prompt 會落到舊對話）→ 才發訊息；每步都有超時，超時也照發，不靜默丟訊息。
- 宿主 API 是 `window.__piWebUiHost`（定義見 `web/src/plugin-host.ts`，當前 `version: 11`）。宿主舊到沒有這個 API 時，按鈕退化成「把給 AI 的正文複製到剪貼簿 + 提示」，不做啞操作。

### 順手修掉的引擎偏差

`app/src/core/analyzeRule.ts` 的 CSS 求值原本把**單段規則**當“輸出說明”而非選擇器，
導致 `ruleContent.content = "#content"`、`ruleSearch.name = ".title##正則"` 這類寫法（真實書源裡極常見）
一律取不到值。現改為：關鍵字（`text/textNodes/ownText/html/all`）仍當輸出，其餘先當**選擇器 + 取文本**，
選不到再退回輸出說明（保住條目範圍裡的 `href`/`text` 寫法）。兩端（內嵌 UI 與 AI 引擎）同步生效。

## 協議（host.route，實際路徑 `/plugins-api/legado-web/*`）

| 路由                   | 方法       | 說明                                                                                   |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------- |
| `/proxy?url=&charset=` | GET / POST | 抓書源站：繞 CORS、按 `charset` 編 URL 中文與 POST body、GBK 解碼、按域隔離 cookie jar |
| `/store[?key=<鍵>]`    | GET        | 無 `key` → `{keys:[…]}`；有 `key` → `{value}`（不存在 404 `{value:null}`）             |
| `/store?meta=1[&key=]` | GET        | 各鍵（或單個鍵）檔案版本 `{metas:{<鍵>:{size,mtime}}}`——前端據此發現**外部改動**       |
| `/store?key=<鍵>`      | POST       | body `{value:…}` → 原子寫 `<dataDir>/legado-web/<鍵>.json`，回 `{ok,bytes,meta}`       |

- **零 npm 依賴**：GBK 解碼用內建 `TextDecoder('gbk')`；編碼用惰性構建的反查表（遍歷 GBK 雙位元組空間反向建對映，約 20ms、只在用到非 UTF-8 charset 時構建）。
- **絕不透傳瀏覽器請求頭**：只帶預設 UA/Accept 與書源自己宣告的 `headers`——否則 pi-web 的 token cookie 會被帶去第三方站點（`tests/legado-web-test.mjs` 有迴歸）。
- **私網/迴環黑名單（SSRF 防護）**：`/proxy` 拒絕抓取回環、私網、鏈路本地目標（127/8、10/8、172.16/12、192.168/16、169.254/16、0/8、CGNAT 100.64/10、組播/保留段、`::1`、`fe80::/10`、`fc00::/7`、`*.localhost`），域名按 DNS 解析結果判定，重定向逐跳複查（手動跟、≤5 跳）。本機自建書源站需要抓自己的話，設環境變數 `LEGADO_ALLOW_PRIVATE_HOSTS=<主機名或IP，逗號分隔>` 顯式放行。
- 靜態資源不用外掛掛路由：`client/app/` 由宿主 `/plugins/<id>/client/*` 託管；前端用相對路徑載入，應用根字首（nginx 子路徑 `/pi`）自適應（`app/src/core/apiBase.ts`）。

## 書源安全（務必先讀）

書源是**第三方寫的規則 + JS 程式碼**，新增書源等於「允許這段程式碼在你的機器上執行」：

- **書源 JS 以外掛程序許可權執行**（內嵌 UI 在瀏覽器裡、AI 診斷在外掛 worker 裡），沒有真正的沙箱隔離（架構級限制，對標原版 Legado 的 Rhino 方案也沒有）：它能通過 `java.ajax` 發任意 HTTP 請求、讀寫本外掛提供的記憶體快取與變數作用域。**只匯入可信來源的書源**，不要來路不明的「全能書源」。
- **時間預算**：單條規則 JS 求值超過 3 秒按失敗中止（`app/src/core/js.ts` 協作式檢查 + 引擎 worker 任務超時兜底），慢規則/死迴圈不會拖垮宿主。
- **`/proxy` 不碰內網**：見上方黑名單說明；書源抓不到 `127.0.0.1`、內網網段與雲後設資料地址（169.254.169.254）。
- **資料面**：書源資料只落 `<dataDir>/legado-web/*.json`，書源 JS 拿不到宿主 token、cookies 與檔案系統（`java` 橋只暴露規則需要的方法，見 `app/src/core/js.ts` 的 `makeJava`）。

## 資料

書源 / 書架 / 閱讀進度 / 檢測結果**只落資料目錄檔案**：`<dataDir>/legado-web/*.json`
（`sources.json` / `shelf.json` / `progress.json` / `check.json`，另有本機偏好 `prefs.json` 存置頂書源；預設在 `~/.pi-web/legado-web/`）。

- **不寫瀏覽器 localStorage**：書源動輒幾 MB（5MB 配額裝不下，曾報 QuotaExceededError），而且清快取/換瀏覽器就沒了；
- 頁面裡只留一份**記憶體映象**（渲染是同步讀，所以要在 `hydrateFromBackend()` 之後才渲染）；
- 發現頁篩選值、書源 JS 規則的 `java.cache` 也只放記憶體（重新整理重算）；
- 老版本存在瀏覽器裡的資料會在啟動時做**一次性只讀遷移**（搬進檔案後把老鍵刪掉）；
- 後端不可用時狀態列會寫「儲存：僅記憶體（後端不可用，重新整理會丟）」。

### 重新整理與「廢源隱藏」的坑

- **自動重新整理**：刪源/「刪除廢源」/匯入/檢測完都會把受影響頁（書源/搜尋/檢測/書架，必要時發現）一次重渲染；
- **外部改動自動探測**：資料目錄裡的 `sources.json` 等被**別人**改了（AI 工具 `legado_book_sources`、另一個頁面、手工編輯），
  頁面會在**切頁**、**標籤頁/視窗重新可見**時比對檔案的 `size+mtime`，發現變了就自動重讀並重渲染。
  閱讀頁會順帶用新規則**重拉當前章正文**（目錄規則變了還會重拉目錄）——
  “AI 說修好了、切回閱讀頁卻還是舊結果”就是這個：以前頁面只在啟動時讀過一次檔案；
- **手動重新整理（兜底）**：書源頁/檢測頁「重新整理」（重讀全部資料再重渲染）、搜尋頁「重新整理資料」、
  閱讀頁工具欄「重新整理」、以及各失敗卡片上的「重新整理資料重試」——都是同一件事：
  從資料目錄檔案**重讀**，然後用新規則重跑當前這一步（發現分類 / 這一章正文）；
- **刪源會清檢測記錄**（連同 http/https、末尾 `/` `#` 的同址變體）——否則頂欄「廢源 N」與檢測頁會掛著已刪源，看著像沒重新整理；
- **被隱藏不等於被刪**：書源頁預設勾著「隱藏廢源」，搜尋預設「跳過廢源」，發現頁也過濾 `kind==='dead'`，
  所以一個源被判廢后會**三處都看不見**。頁面會提示隱藏了幾個，單個源可點行內「標回可用」回到未檢（不用重新匯入）。

> **為什麼不在外掛目錄**：`pi-web-ui install --force`（設定面板的「更新」）會先刪掉整個外掛目錄、
> 只保留 `config.json`——700 個書源這種資料放那裡會被更新洗掉。放 `<dataDir>/legado-web/` 則
> 升級/重灌/解除安裝都不受影響；想清空就 `rm -rf <dataDir>/legado-web`。舊版外掛目錄裡的
> `storage/*.json` 仍會被當作回退源讀取，並在首次讀到時就搬過來。

從舊版 legado-web（獨立部署）搬資料：

```bash
cp <legado-web>/server/data/*.json <dataDir>/legado-web/
```

## 測試

```bash
npm run build:server && node tests/legado-web-test.mjs         # 埠 8993/8994：協議/代理/儲存
node tests/legado-web-engine-test.mjs                          # 埠 8995：AI 工具 + 規則引擎（零 token）
node tests/legado-web-ai-fix-test.mjs                          # 埠 8996：「AI 修復源」按鈕 E2E（缺 Chrome 自動 SKIP）
node tests/legado-web-storage-test.mjs                         # 埠 8997：大數據量下的儲存降級（缺 Chrome 自動 SKIP）
node tests/legado-web-explore-test.mjs                         # 埠 8998/8999：發現頁 + 收藏書源 E2E（缺 Chrome 自動 SKIP）
node tests/legado-web-reader-test.mjs                          # 埠 8971/8972：閱讀頁章末導航 E2E（缺 Chrome 自動 SKIP）
```

`legado-web-test`：清單推送 / 內嵌前端靜態託管 / 代理 UTF-8+GBK / charset 編碼（URL 與 POST body）/
自定義頭透傳 / 瀏覽器頭不外洩 / 上游失敗 502 / 儲存讀寫·大 payload·非法鍵 / **`GET /store?meta=1` 版本資訊（外部改動探測）**。

`legado-web-engine-test`：四個工具註冊 / `legado_rules` 內容 / 「AI 修復源」正文組裝 / 書原始檔 list·get·add·update（深合併落盤）·remove /
鏈路診斷（含 `step` 單步模式）/ 試規則（頁面級 + 條目級）/ 單段 CSS 規則迴歸 / 書源 JS 規則的同步 `java.ajax` / 前端問目錄的 info 回包。

`legado-web-ai-fix-test`：橋接 E2E——harness 頁冒充宿主（假 `window.__piWebUiHost`）+ 真內嵌閱讀頁，點「🤖 AI 修復源」後斷言正文含現場、切了 chat 檢視、要求新對話、cwd = 書源所在目錄（dataDir）；書源頁與發現頁各測一次。

`legado-web-storage-test`（Chrome）：儲存契約——1.8MB 書源 + 3000 章書架下不報 QuotaExceededError、
跑完後 localStorage **一個 `legado.*` 鍵都不剩**、重新整理後資料仍在（來自檔案）、老瀏覽器資料被遷進檔案且老鍵被清。

`legado-web-explore-test`（Chrome）：發現頁「★ 收藏書源」+ 直接搜這個源 + 分類瀏覽。

`legado-web-reader-test`（Chrome）：閱讀頁**章末導航**——正文末尾出現「上一章 / 目錄 / 下一章」、
第一章上一章置灰、讀到底點下一章換章並回頂、最後一章下一章置灰 + 「已是最後一章」、章末目錄展開並回頂。

前兩個進了 `npm run test:smoke`；章末導航的純邏輯單測在 `tests/unit/legado-chapnav.test.ts`；
宿主動作橋的時序另有單測 `tests/unit/plugin-host.test.ts`。
