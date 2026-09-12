# Legado 书源规则速查（本插件引擎的实际语义）

> 这份文档是 **给 AI 修书源用的知识库**（工具 `legado_rules` 原样返回它），也是人看的参考。
> 内容与 `app/src/core/analyzeRule.ts` / `analyzeUrl.ts` / `js.ts` / `webBook.ts` 的实现一致；
> 改引擎行为时同步改这里。

## 一、书源数据结构（`<dataDir>/legado-web/sources.json`）

```jsonc
{
  "bookSourceName": "示例源",
  "bookSourceUrl": "https://example.com", // 唯一键，也是相对地址的基准
  "bookSourceType": 0,                    // 0=文本（本插件只支持 0，非 0 会被过滤）
  "enabled": true,
  "header": "{\"User-Agent\":\"...\"}",   // JSON 字符串，随每个请求发出
  "enabledCookieJar": true,
  "searchUrl": "/search?key={{key}}&page={{page}}",  // 支持 {{}} 模板与 ,{...} 选项
  "exploreUrl": "@js:...",                            // 发现页：JS/JSON/「分类::url」文本
  "ruleSearch":  { "bookList": "...", "name": "...", "author": "...", "bookUrl": "...", ... },
  "ruleBookInfo":{ "init": "...", "name": "...", "tocUrl": "...", ... },
  "ruleToc":     { "chapterList": "...", "chapterName": "...", "chapterUrl": "...", "nextTocUrl": "..." },
  "ruleContent": { "content": "...", "nextContentUrl": "...", "sourceRegex": "...", "webJs": "..." }
}
```

`ruleSearch` 字段：`bookList, name, author, kind, wordCount, lastChapter, intro, coverUrl, bookUrl`
`ruleBookInfo`：`init, name, author, kind, wordCount, lastChapter, intro, coverUrl, tocUrl`
`ruleToc`：`chapterList, chapterName, chapterUrl, isVolume, updateTime, nextTocUrl`
`ruleContent`：`content, nextContentUrl, webJs, sourceRegex, replaceRegex, imageStyle`

求值顺序（`webBook.ts`）：
`searchUrl` → `ruleSearch.bookList` 得条目 → 逐条求 `name/author/bookUrl…` → 详情页 `ruleBookInfo.init`（重定根）→ 其余详情规则 → `tocUrl` → 目录页 `chapterList` → `chapterName/chapterUrl`（可分页 `nextTocUrl`）→ 正文页 `content`（可分页 `nextContentUrl`）。

## 二、规则求值（一条规则串怎么跑）

### 1. 模式判定（自动，除非显式前缀）

| 情况                                                   | 模式     |
| ------------------------------------------------------ | -------- |
| 前缀 `@@` / `@css:`                                    | CSS      |
| 前缀 `@xpath:` 或规则以 `/`、`(` 开头                  | XPath    |
| 前缀 `@json:` 或规则以 `$` 开头，**或页体本身是 JSON** | JSONPath |
| `@js:` 开头、`<js>…</js>` 包裹                         | JS       |
| 其余                                                   | CSS      |

**页体是 JSON 时所有规则按 JSONPath**，所以 API 源可以直接写 `data.list[*]` 而不用 `$.`。

### 2. 选择器 + 输出（CSS）

- `selector@output`：`output` ∈ `text`（默认）/`textNodes`/`ownText`/`html`/`all`/属性名（`@href`、`@src`、`@data-id`…）。
- `selector@a@href`：逐段收窄（先选 `selector`，再在其内选 `a`，取 `href`）。
- **单段规则**（没有 `@`）：先当**选择器**求值并取文本（对标安卓版：`#content`、`.title`、`h1` 都直接可用）；
  若在该范围内选不到任何元素，回退成「输出说明」（属性名，如条目范围内的 `href`、`text`）。
  → 因此 `ruleContent.content = "#content"`、`ruleSearch.name = ".title"` 都是合法的；
  条目范围内 `chapterUrl = "href"`、`chapterName = "text"` 同样合法。
- `:N` 是 jQuery 风格的第 N 个（`:0` = 第 1 个），会自动翻译成 `:eq(N)`；`:N` 后可继续 `@`。
- 多段用 `>`、空格、`,` 等标准 CSS 语法。

### 3. 组合分隔符（顶层切分，感知引号/括号嵌套）

| 写法                  | 语义                                                                  |
| --------------------- | --------------------------------------------------------------------- |
| `a \|\| b`            | 取第一个非空结果（备用规则，最常用）                                  |
| `a && b`              | 结果合并（列表拼接）                                                  |
| `a %% b`              | 拉链式合并（按条目交错，用于「选择器 %% 选择器」配对取值）            |
| `##正则`              | 对结果做替换/删除：`规则##正则` = 删除匹配；`规则##正则##替换` = 替换 |
| `规则##正则##替换###` | 只替换**首个**匹配（`###` 结尾）                                      |

### 4. 变量与模板

- `@put:{name: "规则"}` —— 求值并存入书源级变量（值也是规则，宽松 JSON：键可裸写）；**该段从规则里移除**。
- `@get:{name}` —— 取出变量（放在后面任意规则里）。
- `{{表达式}}` —— 模板代换：`{{key}}`/`{{page}}`/`{{baseUrl}}` 或任意 JS 表达式（`{{java.get("k")}}`）；
  以 `$.`/`@`/`/`/`(`/`<js>`/`@js:` 开头的 `{{}}` 视为**嵌套规则**，用当前内容求值（如 `{{$.book_id}}`）。
- URL 里的 `,{...}` 选项：`searchUrl = "/search?key={{key}},{\"method\":\"POST\",\"body\":\"...\",\"charset\":\"gbk\",\"headers\":{...}}"`。
  - 选项块按**宽松 JSON** 解析（对标安卓 Gson）：允许**单引号**字符串、裸键名、尾逗号，
    所以 `,{'method':'POST','body':'a=1'}` 这种社区常见写法直接可用；
  - `method` 非 GET 且未声明 `Content-Type` 时，默认补 `application/x-www-form-urlencoded`
    （否则服务端读不到表单参数：quickapi 会返回默认列表而不是搜索结果）；
  - `body` 里同样支持 `{{key}}`/`{{page}}` 模板。

### 5. JS 规则

- `@js:代码`（贪婪到规则结尾）或 `<js>代码</js>`；可与文本段**链式**：`selector@href` → `@js:...` 里用 `result` 拿上一段输出。
- 可用绑定：`result`（上一段输出）、`baseUrl`、`key`、`page`、`source`、`book`、`chapter`、`title`、`java`。
- `java` API（`js.ts`）：
  - `java.put(k,v)` / `java.get(k)`（1 参 = 取变量；2~3 参 = **同步 GET**）
  - `java.ajax(url)`、`java.connect(url, header?)`、`java.post(url, body, headers?)` —— **同步**请求（走插件代理/净抓取）
  - `java.base64Encode/Decode`、`java.md5Encode`、`java.log/toast`
  - `java.getElement(rule)` / `java.getElements(rule)` / `java.getString(rule)` / `java.getStringList(rule)`（按规则在当前内容上求值，返回带 `select/attr/text/size/get` 的元素外观）
  - `java.setContent(v)`（替换后续规则的求值内容）、`java.cache.get/put/getFile/putFile/delete`（键值缓存，只在**页面内存**：刷新重算，不落浏览器存储）
  - `java.t2s/s2t`、`java.getCookie`、`java.startBrowser` 等：**兼容占位**，不做真实转换/浏览器渲染。
- 正则列表规则：以 `:` 开头（如 `:regex`），去首个 `:` 后按 `&&` 串正则，最后一个正则的每处匹配成为一条（分组数组交给 `$1`/`$2` 取）。
- `$N`：正则列表条目的分组取值。

## 三、本引擎的已知差异（写规则时要避开）

- **WebJS 不支持**：`ruleContent.webJs`、`<webjs>`/`@webjs:` 一律跳过（需要浏览器渲染的源取不到正文）。
- 图片型/音频源（`bookSourceType != 0`）不支持。
- `java.t2s/s2t` 是占位（不做繁简转换）；`java.getCookie` 返回空串。
- XPath 走 `@xmldom/xmldom`，容错清洗 HTML 后再解析；复杂 XPath 可能不如浏览器宽松。
- 规则失败**不抛错**，只记 `ruleErrors`（`legado_source_probe` 会把失败明细列出来）。
- 正文为空时会有明确原因：盾页/乱码/空页、`sourceRegex` 未命中、站点提示（如「请升级App」）、WebJS。

- **修源边界（重要）**：只能改**书源数据**（`legado_book_sources` 的 `update`）。
  不要修改插件的任何文件/代码（`app/`、`client/`、`server/`、`*.mjs`）——插件是**安装产物**，
  用户点一次「更新」就整目录覆盖，改了也会丢；很多环境下本机根本没有它的源码仓库。
  碰上引擎能力不足的写法，给**等价规则的绕法**（绕）：
  - 如：`,{'method':'POST',...}` → 改双引号 JSON 并显式 `"headers":{"Content-Type":"application/x-www-form-urlencoded"}`；
  - 如需要浏览器渲染（WebJS）：直说换源。

## 四、修源流程（AI 照这个顺序做）

1. `legado_source_probe`（`dump: "snippet"`）跑一遍，看**哪一步**断：连通 / 搜索 / 详情 / 目录 / 正文。
   - 返回里每步都带：请求地址、HTTP 状态、页体大小与片段、解析出的值、该步用到的规则原文、新增的规则失败明细。
2. 断在哪步就只跑那步（`step: "content"` + `bookUrl: "<该步的地址>"`），必要时 `dump: "full"` 或 `dumpMax` 放大看页体。
3. `legado_run_rule` 拿真实页体试规则（`url` + `rule`，条目级用 `listRule`），确认改法有效再落盘。
4. `legado_book_sources` 的 `action: "update"` 只改坏掉的字段（深合并，不会动其它字段）。
5. 告诉用户刷新阅读页（浏览器里那份是内存副本，需要重新从后端 hydrate）；写完插件也会弹一条通知。

> 阅读页里的「🤖 AI 修复源」按钮就是自动帮你做完第 1 步的：它把书源、书籍、出错地址、
> 报错原文、当前相关规则一并送过来（并已把新对话的工作目录切到**书源所在目录** `dataDir`）；
> 提示词里还给了**书源文件**与**规则速查文件**（本文件）的路径，并明确要求**只改书源规则、不碰插件**。
> 收到这种请求时直接从第 2 步开始；不要重复问用户拿书源信息。
