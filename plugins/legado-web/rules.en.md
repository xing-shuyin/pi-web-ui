**English** · [简体中文](./rules.md) · [繁體中文](./rules.zh-TW.md)

# Legado book-source rules cheat sheet (actual semantics of this plugin engine)

> This document is a **knowledge base for AI to fix book sources** (the `legado_rules` tool returns it verbatim); it is also a reference for humans.
> Content matches the implementation in `app/src/core/analyzeRule.ts` / `analyzeUrl.ts` / `js.ts` / `webBook.ts`;
> when engine behavior changes, update this file too.

## 1. Book-source data structure (`<dataDir>/legado-web/sources.json`)

```jsonc
{
  "bookSourceName": "Example source",
  "bookSourceUrl": "https://example.com", // unique key, also the base for relative URLs
  "bookSourceType": 0,                    // 0 = text (this plugin supports 0 only; non-0 is filtered out)
  "enabled": true,
  "header": "{\"User-Agent\":\"...\"}",   // JSON string, sent with every request
  "enabledCookieJar": true,
  "searchUrl": "/search?key={{key}}&page={{page}}",  // supports {{}} templates and ,{...} options
  "exploreUrl": "@js:...",                            // discover page: JS / JSON / "category::url" text
  "ruleSearch":  { "bookList": "...", "name": "...", "author": "...", "bookUrl": "...", ... },
  "ruleBookInfo":{ "init": "...", "name": "...", "tocUrl": "...", ... },
  "ruleToc":     { "chapterList": "...", "chapterName": "...", "chapterUrl": "...", "nextTocUrl": "..." },
  "ruleContent": { "content": "...", "nextContentUrl": "...", "sourceRegex": "...", "webJs": "..." }
}
```

`ruleSearch` fields: `bookList, name, author, kind, wordCount, lastChapter, intro, coverUrl, bookUrl`
`ruleBookInfo`: `init, name, author, kind, wordCount, lastChapter, intro, coverUrl, tocUrl`
`ruleToc`: `chapterList, chapterName, chapterUrl, isVolume, updateTime, nextTocUrl`
`ruleContent`: `content, nextContentUrl, webJs, sourceRegex, replaceRegex, imageStyle`

Evaluation order (`webBook.ts`):
`searchUrl` → `ruleSearch.bookList` yields entries → evaluate `name/author/bookUrl…` per entry → detail page `ruleBookInfo.init` (re-roots) → remaining detail rules → `tocUrl` → TOC page `chapterList` → `chapterName/chapterUrl` (paged via `nextTocUrl`) → content page `content` (paged via `nextContentUrl`).

## 2. Rule evaluation (how a rule string runs)

### 1. Mode detection (automatic unless a prefix is explicit)

| Case                                                                              | Mode     |
| --------------------------------------------------------------------------------- | -------- |
| Prefix `@@` / `@css:`                                                             | CSS      |
| Prefix `@xpath:`, or the rule starts with `/` or `(`                              | XPath    |
| Prefix `@json:`, or the rule starts with `$`, **or the page body itself is JSON** | JSONPath |
| Starts with `@js:`, wrapped in `<js>…</js>`                                       | JS       |
| Anything else                                                                     | CSS      |

**When the page body is JSON, every rule runs as JSONPath**, so an API source can write `data.list[*]` directly without `$.`.

### 2. Selector + output (CSS)

- `selector@output`: `output` ∈ `text` (default) / `textNodes` / `ownText` / `html` / `all` / an attribute name (`@href`, `@src`, `@data-id`…).
- `selector@a@href`: narrow segment by segment (select `selector`, then `a` inside it, take `href`).
- **Single-segment rule** (no `@`): evaluated first as a **selector** and its text taken (matching the Android version: `#content`, `.title`, `h1` all work directly);
  if no element matches within that scope, it falls back to "output spec" (an attribute name, e.g. `href`, `text` inside the entry scope).
  → So `ruleContent.content = "#content"` and `ruleSearch.name = ".title"` are both legal;
  inside entry scope `chapterUrl = "href"` and `chapterName = "text"` are equally legal.
- `:N` is jQuery-style the Nth match (`:0` = the 1st), auto-translated to `:eq(N)`; `:N` can be followed by further `@`.
- Multiple segments use standard CSS syntax: `>`, spaces, `,` and so on.

### 3. Combinator separators (top-level split, quote/bracket aware)

| Syntax                        | Semantics                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `a \|\| b`                    | First non-empty result (fallback rule, the most common)                                            |
| `a && b`                      | Merge results (concatenate lists)                                                                  |
| `a %% b`                      | Zipper merge (interleave per entry; pairs values across "selector %% selector")                    |
| `##regex`                     | Replace/delete on the result: `rule##regex` = delete matches; `rule##regex##replacement` = replace |
| `rule##regex##replacement###` | Replace only the **first** match (trailing `###`)                                                  |

### 4. Variables and templates

- `@put:{name: "rule"}` — evaluate and store into a source-level variable (the value is a rule too, lenient JSON: bare keys allowed); **this segment is removed from the rule**.
- `@get:{name}` — read the variable back (in any later rule).
- `{{expression}}` — template substitution: `{{key}}`/`{{page}}`/`{{baseUrl}}` or any JS expression (`{{java.get("k")}}`);
  a `{{}}` starting with `$.`/`@`/`/`/`(`/`<js>`/`@js:` counts as a **nested rule**, evaluated against the current content (e.g. `{{$.book_id}}`).
- `,{...}` options in a URL: `searchUrl = "/search?key={{key}},{\"method\":\"POST\",\"body\":\"...\",\"charset\":\"gbk\",\"headers\":{...}}"`.
  - The option block is parsed as **lenient JSON** (matching Android Gson): **single-quoted** strings, bare keys and trailing commas are allowed,
    so the community-common `,{'method':'POST','body':'a=1'}` works as-is;
  - when `method` is not GET and no `Content-Type` is declared, `application/x-www-form-urlencoded` is filled in by default
    (otherwise the server cannot read the form parameters: quickapi returns the default list instead of search results);
  - `body` also supports `{{key}}`/`{{page}}` templates.

### 5. JS rules

- `@js:code` (greedy to the end of the rule) or `<js>code</js>`; can be **chained** after text segments: `selector@href` → read the previous output as `result` inside `@js:...`.
- Available bindings: `result` (previous segment output), `baseUrl`, `key`, `page`, `source`, `book`, `chapter`, `title`, `java`.
- `java` API (`js.ts`):
  - `java.put(k,v)` / `java.get(k)` (1 arg = read variable; 2–3 args = **synchronous GET**)
  - `java.ajax(url)`, `java.connect(url, header?)`, `java.post(url, body, headers?)` — **synchronous** requests (through the plugin proxy / clean fetch)
  - `java.base64Encode/Decode`, `java.md5Encode`, `java.log/toast`
  - `java.getElement(rule)` / `java.getElements(rule)` / `java.getString(rule)` / `java.getStringList(rule)` (evaluate a rule against the current content, returning element facades with `select/attr/text/size/get`)
  - `java.setContent(v)` (replace the content for later rules), `java.cache.get/put/getFile/putFile/delete` (key-value cache, **page memory only**: recomputed on refresh, never written to browser storage)
  - `java.t2s/s2t`, `java.getCookie`, `java.startBrowser` and friends: **compatibility placeholders**, no real conversion or browser rendering.
- Regex list rules: start with `:` (e.g. `:regex`); strip the leading `:` and join the regexes with `&&`, and every match of the last regex becomes an entry (capture groups feed `$1`/`$2`).
- `$N`: capture-group value of a regex-list entry.

## 3. Known differences in this engine (avoid them when writing rules)

- **WebJS unsupported**: `ruleContent.webJs`, `<webjs>`/`@webjs:` are skipped outright (sources that need browser rendering cannot get the body).
- **Site shield pages (Cloudflare / gateway challenge / CDN block)**: when a direct request returns 403 plus a shield page, add `allowBrowser: true` to that source
  (`legado_book_sources update` deep-merges the field) and the backend re-fetches once with headless Chrome/Edge on the local machine;
  when no browser is installed locally, the original behavior stands. The other route is cookies: have the user visit the site once in a desktop browser
  and paste the whole `document.cookie` string into the `Cookie` field of the source `header` (that is exactly what the inline 「🍪」 button on the book-source page is for; it re-checks automatically after import).
  When the headless browser is also detected / manual interactive verification is required, say straight out: switch source.
- Image/audio sources (`bookSourceType != 0`) unsupported.
- `java.t2s/s2t` are placeholders (no traditional/simplified conversion); `java.getCookie` returns an empty string.
- XPath goes through `@xmldom/xmldom`, parsing after lenient HTML cleanup; complex XPath may be less forgiving than a browser.
- Rule failures **do not throw**; they are only recorded in `ruleErrors` (`legado_source_probe` lists the failure details).
- An empty body always has an explicit reason: shield page / mojibake / empty page, `sourceRegex` miss, site message (e.g. 「请升级App」(Please upgrade the app)), WebJS.

- **Fix-source boundary (important)**: only **book-source data** may be changed (the `update` of `legado_book_sources`).
  Do not modify any plugin file/code (`app/`, `client/`, `server/`, `*.mjs`) — the plugin is an **installed artifact**;
  one click of 「更新」(Update) overwrites the whole directory and any edit is lost; in many environments the source repo is not even on the machine.
  When the engine lacks a capability, give a **workaround with an equivalent rule** (绕):
  - e.g. `,{'method':'POST',...}` → switch to double-quoted JSON with an explicit `"headers":{"Content-Type":"application/x-www-form-urlencoded"}`;
  - when browser rendering (WebJS) is required: say straight out that the source must be replaced.

## 4. Fix-source workflow (AI follows this order)

1. Run `legado_source_probe` (`dump: "snippet"`) once and see **which step** breaks: connectivity / search / detail / TOC / body.
   - Every step in the response carries: request URL, HTTP status, body size and snippet, the parsed values, the verbatim rules used in that step, and newly added rule failure details.
2. Run only the broken step (`step: "content"` + `bookUrl: "<the URL for that step>"`), with `dump: "full"` or a larger `dumpMax` when needed to inspect the body.
3. Try rules against the real body with `legado_run_rule` (`url` + `rule`, `listRule` at entry level); confirm the fix works before writing it.
4. `legado_book_sources` with `action: "update"` changes only the broken fields (deep merge, other fields untouched).
5. Re-run `legado_source_probe` over the repaired chain to confirm; once it passes, if the source was ever marked dead/suspicious
   (health status is visible in `legado_book_sources` `list`), clear the mark with `action: "unmark"` —
   **otherwise the page hides dead sources by default and the user thinks the source is gone**. After unmarking, the page re-reads and the source reappears.
6. Tell the user to refresh the reading page (the copy in the browser is in-memory and must be re-hydrated from the backend); the plugin also pops a notification once the write is done.

> The 「🤖 AI 修复源」(AI fix source) button on the reading page does step 1 for you automatically: it sends the book source, the book, the failing URL,
> the verbatim error and the currently relevant rules together (and has already switched the new conversation's working directory to the **book-source directory** `dataDir`);
> the prompt also gives the paths of the **book-source file** and the **rules cheat sheet** (this file), and explicitly requires **changing only book-source rules, never touching the plugin**.
> On such a request, start from step 2; do not ask the user again for book-source information.
