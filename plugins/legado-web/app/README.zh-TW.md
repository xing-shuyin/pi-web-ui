[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# Legado Web（外掛內嵌版 · 僅文本源 + 代理模式）

從 `legado-E`（閱讀 Sigma / Legado 衍生）剝離的核心讀書鏈路：
`搜尋 / 發現 / 詳情 / 目錄 / 正文`，書源 JSON 與 Android 版相容。

> **這份原始碼內嵌在 pi-web-ui 的 `plugins/legado-web/` 外掛裡**，作為外掛檢視
> （📖 頂欄 tab）執行。構建、安裝、代理與儲存都由外掛承擔：
>
> - 介面：`client/app/`（本目錄 `npm run build` 的產物）經宿主 `/plugins/<id>/client/*` 託管
> - 代理：外掛服務端 `../index.mjs` 的 `GET/POST /plugins-api/legado-web/proxy`（CORS + GBK，實現在 `../net.mjs`）
> - 儲存：外掛服務端 `/plugins-api/legado-web/store`，落 `<dataDir>/legado-web/*.json`
> - 基址推導：`src/core/apiBase.ts`（按頁面路徑自適應應用字首，無構建期配置）
> - 規則引擎還有一份 **Node 打包版**（`src/core/engine-entry.ts` → `../server/engine.mjs`），
>   給外掛註冊的 AI 工具（診斷/試規則）用，與瀏覽器裡這份是同一份原始碼
>
> 日常構建走外掛根的 `../build.mjs`（vite + esbuild）；本目錄保留 `npm run dev` 僅供純前端除錯（無同源代理，需自備）。

## 構建

```bash
node ../build.mjs          # 等價於本目錄 npm install + npm run build
npm run build              # 僅構建（需先 npm install）
```

## 結構

- `src/types.ts` — 對應 `app/.../data/entities/BookSource.kt`
- `src/core/analyzeUrl.ts` — 對應 `AnalyzeUrl`（`,{json}` + `{{key/page}}`）
- `src/core/js.ts` — JS 規則（原 Rhino，直跑原生）。`java` 對標原版 bindings：`put/get`（按書源隔離的跨規則變數）、`ajax/connect/get/post`（經代理同步請求）、`base64Encode/Decode`、`md5Encode`、`log/toast`；`<js>` 內可用 `result/baseUrl/key/page/source/book/chapter/title/java`，`{{...}}` 模板同樣支援 `java.get(...)`
- `src/core/analyzeRule.ts` — 對應 `AnalyzeRule`：CSS（含原版基寫法與索引、`@` 逐段收窄+輸出分離）/XPath/JSONPath/Regex + `||`/`&&`/`%%`（分隔符感知巢狀）+ `##`（無替換=刪除，有替換=替換，`###`=首匹配）+ `@put/@get/{{}}`（`{{$.x}}` 按巢狀規則求值）+ JS 鏈式 + 字首 + `:N` 相容。**任何規則都不拋錯**，失敗記入 `ruleErrors`（console 搜 `[規則失敗]`）。
  **單段規則**（無 `@`）：先當選擇器 + 取文本（對標安卓版，`#content`/`.title##正則` 直接可用）；
  選不到再退回輸出說明（屬性名），所以條目範圍裡 `chapterName="text"`、`chapterUrl="href"` 依舊有效。
- `src/core/probe.ts` — 鏈路診斷（AI 修源用）：逐步跑連通/搜尋/詳情/目錄/正文，回報請求地址與狀態、頁體片段、解析值、規則原文、規則失敗明細
- JS 規則原生執行（Rhino 語義：鬆散模式、completion 返回值、按源隔離共享變數、`java.put/get/ajax/post`、陣列/元素外觀 `toArray/size/get/select/attr/text`）
- `src/core/js.ts` — JS 規則原生執行（Rhino 語義：鬆散模式、completion 返回值、**按源隔離沙箱**（隱式全域性不串源）、`java.put/get/ajax/post/getElement/getString/setContent`、陣列/元素外觀 `toArray/size/get/select/attr/text`）
- 正文為空/非正文不再白頁：會直接告訴你原因，並在 console 打 `[正文為空]` / `[正文非正文]` 詳情
- `src/core/pageProblem.ts` — 盾頁/亂碼/空頁識別與網路錯誤分類（“檢測”與正文抓取共用）
- **隨處刪源/標廢源**（“開啟的書不能用就當場刪掉”）：發現頁頂部（刪源/標廢源）、發現載入失敗卡片（刪源/標廢源/換個源）、閱讀頁工具欄（刪源/移出書架）、正文失敗卡片、詳情失敗卡片、書架每行（刪源）、書源頁「刪除廢源」——刪源會同時清掉該源的檢測記錄與發現快取
- **刪源就刪書**：所有刪源入口（閱讀頁/書架行/發現頁/失敗卡片/「刪除廢源」批次）都會把書架上該源的書**一併移出**（含閱讀進度），確認框會先提醒“該源的書會一併移出”；進度清理只發生在刪源（「移出書架」仍保留進度，重加書可接著讀）
- **閱讀頁刪源 = 一條龍換源**：閱讀頁工具欄「刪源」或正文失敗卡片的「刪掉這個源」——刪源（連書）後自動跳到「發現」頁，並把閱讀頁狀態清空（不留在已刪源的舊正文上）；若被刪的源正是發現頁當前檢視的源，會清掉它的分類/結果快取重新選源
- **章末導航**（讀到底就能翻章）：正文末尾一條「← 上一章 / 目錄 / 下一章 →」（帶《書名》· 第 n/總 章），讀完這一章不用滾回頂部；換章後自動回頂，第一章「上一章」、最後一章「下一章」置灰並寫明「已是最後一章」（頂欄同名按鈕同規則），章末「目錄」展開目錄並回頂。判斷邏輯在 `src/core/chapnav.ts`（純函式，有單測）
- **發現頁**：選書源 → 自動解析分類（JS/JSON/文本三種格式）→ 點分類看書 + 下一頁；篩選類控制元件（text/select/toggle）值存 infoMap 並對接 JS；分類載入失敗會給出原因
- 已實測源：酷我小說（JSON API）、閱友小說（HTML），搜尋→詳情→目錄→正文全通；發現頁在可用源上 18/18 成功
- **廢源自動檢測與隱藏**（“書看不了也算廢源”）：
  - `快速檢測廢源`：站點連通 + 搜尋，抓掛了/被牆/盾頁/無搜尋規則
  - `完整檢測廢源`：再跟到詳情/目錄/正文，鏈斷裂、正文為空、**返回的不是正文而是站點提示**（如“版本過低請升級”）都算廢源
  - 書源列表預設隱藏廢源（可同時隱藏可疑）、搜尋預設跳過廢源（可選僅可用源/全部源）、“刪除廢源”一鍵清理、匯入後自動檢測
  - **閱讀失敗自動標記**：讀某書時確認是源失效（無正文規則/WebJS/站點提示/盾頁/網路不可達），自動將該源標為廢源並提示
- `src/core/explore.ts` — **發現（explore）**：解析 `exploreUrl`（`@js:`/`<js>` 產出 JSON 分類陣列、直接 JSON 陣列、舊式 `分類::url` 文本）+ 分類點選載入列表 + `infoMap` 篩選值（對拼原版，含 `java.t2s/s2t` 相容佔位、`cache.getFile/putFile`）
- `src/core/check.ts` — **書源檢測**：三檔（僅連通 / 連通+搜尋 / 完整鏈路），分步記錄耗時與結果，失敗分成人話結論；結果分為 `ok` / `dead`（站點級廢源，可隱藏）/ `suspect`（可疑：搜尋無結果/規則不相容）
- `src/core/webBook.ts` — 對應 `model/webBook/*` 五件套
- `src/core/request.ts` — 統一走代理請求（基址見 `src/core/apiBase.ts`）
- `src/core/apiBase.ts` — 介面根推導：外掛內 → `<字首>/plugins-api/legado-web`，獨立部署 → `VITE_API_BASE`
- `src/store.ts` — 持久化：**記憶體為事實源 + 雙寫** localStorage（快取，有 5MB 上限，超上限的鍵自動跳過）與本地檔案（`<dataDir>/legado-web/*.json`）；`src/store-cache.ts` 負責瘦身/容量判定。啟動時調 `hydrateFromBackend()`：後端有資料以後端為準，後端為空而瀏覽器有則自動遷移過去；後端不可用時自動回退成僅瀏覽器
- `src/core/backend.ts` — 本地儲存服務客戶端（`/store?key=<鍵>` 讀、`POST` 寫）
- `src/store.ts / src/main.ts` — 書架 + 四頁 UI（書架/搜尋/書源/檢測/閱讀）

## 儲存

書源 / 書架 / 閱讀進度 / 檢測結果**只落資料目錄檔案**（`<dataDir>/legado-web/*.json`，預設 `~/.pi-web/legado-web/`）：

- 本地檔案位置：`sources.json`（書源）、`shelf.json`、`progress.json`、`check.json`、`prefs.json`（置頂書源等本機偏好）
- **不寫瀏覽器 localStorage**：書源動輒幾 MB（5MB 配額裝不下，曾報 QuotaExceededError），清快取/換瀏覽器還會丟
- 頁面裡只留一份**記憶體映象**（渲染同步讀）；發現頁篩選值、JS 規則 `java.cache` 同樣只放記憶體
- 老版本瀏覽器裡的資料啟動時做一次性只讀遷移（搬進檔案後刪掉老鍵）
- 從舊版 legado-web 搬資料：把 `server/data/*.json` 拷進 `<dataDir>/legado-web/` 即可
- 後端不可用（如只跑前端 dev）時狀態列會提示「儲存：僅記憶體（後端不可用，重新整理會丟）」

