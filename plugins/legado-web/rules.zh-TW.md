[English](./rules.en.md) · [简体中文](./rules.md) · **繁體中文**

# Legado 書源規則速查（本外掛引擎的實際語義）

> 這份文件是 **給 AI 修書源用的知識庫**（工具 `legado_rules` 原樣返回它），也是人看的參考。
> 內容與 `app/src/core/analyzeRule.ts` / `analyzeUrl.ts` / `js.ts` / `webBook.ts` 的實現一致；
> 改引擎行為時同步改這裡。

## 一、書源資料結構（`<dataDir>/legado-web/sources.json`）

```jsonc
{
  "bookSourceName": "示例源",
  "bookSourceUrl": "https://example.com", // 唯一鍵，也是相對地址的基準
  "bookSourceType": 0,                    // 0=文本（本外掛只支援 0，非 0 會被過濾）
  "enabled": true,
  "header": "{\"User-Agent\":\"...\"}",   // JSON 字串，隨每個請求發出
  "enabledCookieJar": true,
  "searchUrl": "/search?key={{key}}&page={{page}}",  // 支援 {{}} 模板與 ,{...} 選項
  "exploreUrl": "@js:...",                            // 發現頁：JS/JSON/「分類::url」文本
  "ruleSearch":  { "bookList": "...", "name": "...", "author": "...", "bookUrl": "...", ... },
  "ruleBookInfo":{ "init": "...", "name": "...", "tocUrl": "...", ... },
  "ruleToc":     { "chapterList": "...", "chapterName": "...", "chapterUrl": "...", "nextTocUrl": "..." },
  "ruleContent": { "content": "...", "nextContentUrl": "...", "sourceRegex": "...", "webJs": "..." }
}
```

`ruleSearch` 欄位：`bookList, name, author, kind, wordCount, lastChapter, intro, coverUrl, bookUrl`
`ruleBookInfo`：`init, name, author, kind, wordCount, lastChapter, intro, coverUrl, tocUrl`
`ruleToc`：`chapterList, chapterName, chapterUrl, isVolume, updateTime, nextTocUrl`
`ruleContent`：`content, nextContentUrl, webJs, sourceRegex, replaceRegex, imageStyle`

求值順序（`webBook.ts`）：
`searchUrl` → `ruleSearch.bookList` 得條目 → 逐條求 `name/author/bookUrl…` → 詳情頁 `ruleBookInfo.init`（重定根）→ 其餘詳情規則 → `tocUrl` → 目錄頁 `chapterList` → `chapterName/chapterUrl`（可分頁 `nextTocUrl`）→ 正文頁 `content`（可分頁 `nextContentUrl`）。

## 二、規則求值（一條規則串怎麼跑）

### 1. 模式判定（自動，除非顯式字首）

| 情況                                                   | 模式     |
| ------------------------------------------------------ | -------- |
| 字首 `@@` / `@css:`                                    | CSS      |
| 字首 `@xpath:` 或規則以 `/`、`(` 開頭                  | XPath    |
| 字首 `@json:` 或規則以 `$` 開頭，**或頁體本身是 JSON** | JSONPath |
| `@js:` 開頭、`<js>…</js>` 包裹                         | JS       |
| 其餘                                                   | CSS      |

**頁體是 JSON 時所有規則按 JSONPath**，所以 API 源可以直接寫 `data.list[*]` 而不用 `$.`。

### 2. 選擇器 + 輸出（CSS）

- `selector@output`：`output` ∈ `text`（預設）/`textNodes`/`ownText`/`html`/`all`/屬性名（`@href`、`@src`、`@data-id`…）。
- `selector@a@href`：逐段收窄（先選 `selector`，再在其內選 `a`，取 `href`）。
- **單段規則**（沒有 `@`）：先當**選擇器**求值並取文本（對標安卓版：`#content`、`.title`、`h1` 都直接可用）；
  若在該範圍內選不到任何元素，回退成「輸出說明」（屬性名，如條目範圍內的 `href`、`text`）。
  → 因此 `ruleContent.content = "#content"`、`ruleSearch.name = ".title"` 都是合法的；
  條目範圍內 `chapterUrl = "href"`、`chapterName = "text"` 同樣合法。
- `:N` 是 jQuery 風格的第 N 個（`:0` = 第 1 個），會自動翻譯成 `:eq(N)`；`:N` 後可繼續 `@`。
- 多段用 `>`、空格、`,` 等標準 CSS 語法。

### 3. 組合分隔符（頂層切分，感知引號/括號巢狀）

| 寫法                  | 語義                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `a \|\| b`            | 取第一個非空結果（備用規則，最常用）                                  |
| `a && b`              | 結果合併（列表拼接）                                                  |
| `a %% b`              | 拉鏈式合併（按條目交錯，用於「選擇器 %% 選擇器」配對取值）            |
| `##正則`              | 對結果做替換/刪除：`規則##正則` = 刪除匹配；`規則##正則##替換` = 替換 |
| `規則##正則##替換###` | 只替換**首個**匹配（`###` 結尾）                                      |

### 4. 變數與模板

- `@put:{name: "規則"}` —— 求值並存入書源級變數（值也是規則，寬鬆 JSON：鍵可裸寫）；**該段從規則裡移除**。
- `@get:{name}` —— 取出變數（放在後面任意規則裡）。
- `{{表示式}}` —— 模板代換：`{{key}}`/`{{page}}`/`{{baseUrl}}` 或任意 JS 表示式（`{{java.get("k")}}`）；
  以 `$.`/`@`/`/`/`(`/`<js>`/`@js:` 開頭的 `{{}}` 視為**巢狀規則**，用當前內容求值（如 `{{$.book_id}}`）。
- URL 裡的 `,{...}` 選項：`searchUrl = "/search?key={{key}},{\"method\":\"POST\",\"body\":\"...\",\"charset\":\"gbk\",\"headers\":{...}}"`。
  - 選項塊按**寬鬆 JSON** 解析（對標安卓 Gson）：允許**單引號**字串、裸鍵名、尾逗號，
    所以 `,{'method':'POST','body':'a=1'}` 這種社群常見寫法直接可用；
  - `method` 非 GET 且未宣告 `Content-Type` 時，預設補 `application/x-www-form-urlencoded`
    （否則服務端讀不到表單引數：quickapi 會返回預設列表而不是搜尋結果）；
  - `body` 裡同樣支援 `{{key}}`/`{{page}}` 模板。

### 5. JS 規則

- `@js:程式碼`（貪婪到規則結尾）或 `<js>程式碼</js>`；可與文本段**鏈式**：`selector@href` → `@js:...` 裡用 `result` 拿上一段輸出。
- 可用繫結：`result`（上一段輸出）、`baseUrl`、`key`、`page`、`source`、`book`、`chapter`、`title`、`java`。
- `java` API（`js.ts`）：
  - `java.put(k,v)` / `java.get(k)`（1 參 = 取變數；2~3 參 = **同步 GET**）
  - `java.ajax(url)`、`java.connect(url, header?)`、`java.post(url, body, headers?)` —— **同步**請求（走外掛代理/淨抓取）
  - `java.base64Encode/Decode`、`java.md5Encode`、`java.log/toast`
  - `java.getElement(rule)` / `java.getElements(rule)` / `java.getString(rule)` / `java.getStringList(rule)`（按規則在當前內容上求值，返回帶 `select/attr/text/size/get` 的元素外觀）
  - `java.setContent(v)`（替換後續規則的求值內容）、`java.cache.get/put/getFile/putFile/delete`（鍵值快取，只在**頁面記憶體**：重新整理重算，不落瀏覽器儲存）
  - `java.t2s/s2t`、`java.getCookie`、`java.startBrowser` 等：**相容佔位**，不做真實轉換/瀏覽器渲染。
- 正則列表規則：以 `:` 開頭（如 `:regex`），去首個 `:` 後按 `&&` 串正則，最後一個正則的每處匹配成為一條（分組陣列交給 `$1`/`$2` 取）。
- `$N`：正則列表條目的分組取值。

## 三、本引擎的已知差異（寫規則時要避開）

- **WebJS 不支援**：`ruleContent.webJs`、`<webjs>`/`@webjs:` 一律跳過（需要瀏覽器渲染的源取不到正文）。
- **站點盾頁（Cloudflare/閘道器質詢/CDN 攔截）**：直連返回 403 + 盾頁時，可給該源加 `allowBrowser: true`
  （`legado_book_sources update` 深合併該欄位即可），後端用本機 Chrome/Edge 無頭渲染重抓一次；
  本機沒裝瀏覽器時保持原行為。另一條路是 Cookie：讓使用者在電腦瀏覽器正常訪問該站一次，
  把 `document.cookie` 整串貼進源 `header` 的 `Cookie` 欄位（書源頁行內「🍪」按鈕就是幹這個的，匯入後自動重檢）。
  無頭也被識別 / 需要人工互動驗證時，直說換源。
- 圖片型/音訊源（`bookSourceType != 0`）不支援。
- `java.t2s/s2t` 是佔位（不做繁簡轉換）；`java.getCookie` 返回空串。
- XPath 走 `@xmldom/xmldom`，容錯清洗 HTML 後再解析；複雜 XPath 可能不如瀏覽器寬鬆。
- 規則失敗**不拋錯**，只記 `ruleErrors`（`legado_source_probe` 會把失敗明細列出來）。
- 正文為空時會有明確原因：盾頁/亂碼/空頁、`sourceRegex` 未命中、站點提示（如「請升級App」）、WebJS。

- **修源邊界（重要）**：只能改**書源資料**（`legado_book_sources` 的 `update`）。
  不要修改外掛的任何檔案/程式碼（`app/`、`client/`、`server/`、`*.mjs`）——外掛是**安裝產物**，
  使用者點一次「更新」就整目錄覆蓋，改了也會丟；很多環境下本機根本沒有它的原始碼倉庫。
  碰上引擎能力不足的寫法，給**等價規則的繞法**（繞）：
  - 如：`,{'method':'POST',...}` → 改雙引號 JSON 並顯式 `"headers":{"Content-Type":"application/x-www-form-urlencoded"}`；
  - 如需要瀏覽器渲染（WebJS）：直說換源。

## 四、修源流程（AI 照這個順序做）

1. `legado_source_probe`（`dump: "snippet"`）跑一遍，看**哪一步**斷：連通 / 搜尋 / 詳情 / 目錄 / 正文。
   - 返回裡每步都帶：請求地址、HTTP 狀態、頁體大小與片段、解析出的值、該步用到的規則原文、新增的規則失敗明細。
2. 斷在哪步就只跑那步（`step: "content"` + `bookUrl: "<該步的地址>"`），必要時 `dump: "full"` 或 `dumpMax` 放大看頁體。
3. `legado_run_rule` 拿真實頁體試規則（`url` + `rule`，條目級用 `listRule`），確認改法有效再落盤。
4. `legado_book_sources` 的 `action: "update"` 只改壞掉的欄位（深合併，不會動其它欄位）。
5. `legado_source_probe` 把修好的鏈路再跑一遍確認；通過後如果該源曾被標成廢源/可疑
   （`legado_book_sources` 的 `list` 裡能看到健康狀態），用 `action: "unmark"` 把標記摘掉——
   **否則頁面預設隱藏廢源，使用者會以為源丟了**。摘完標記頁面會自動重讀出現。
6. 告訴使用者重新整理閱讀頁（瀏覽器裡那份是記憶體副本，需要重新從後端 hydrate）；寫完外掛也會彈一條通知。

> 閱讀頁裡的「🤖 AI 修復源」按鈕就是自動幫你做完第 1 步的：它把書源、書籍、出錯地址、
> 報錯原文、當前相關規則一併送過來（並已把新對話的工作目錄切到**書源所在目錄** `dataDir`）；
> 提示詞裡還給了**書原始檔**與**規則速查檔案**（本檔案）的路徑，並明確要求**只改書源規則、不碰外掛**。
> 收到這種請求時直接從第 2 步開始；不要重複問使用者拿書源資訊。
