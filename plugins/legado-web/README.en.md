**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# legado-web (📖 Reading)

Brings the core reading chain of [Legado / 阅读](https://github.com/gedoor/legado) into pi-web-ui:
**search / discover / details / table of contents / content**, with book source JSON compatible with the Android version, plus source import, dead-source detection and cleanup.

The UI is the original `legado-web` (Vite + vanilla TS) app, **embedded full-frame in the plugin view** (iframe),
and the plugin provides every backend it needs: CORS+GBK proxy, local storage, static hosting.

It also ships a **source-repair API** for AI (agent tools `legado_rules` / `legado_book_sources` /
`legado_source_probe` / `legado_run_rule`): the agent can read the rule reference, read source files, step the chain to see where it breaks,
try rules against real page bodies, then change only the broken fields (see "AI source-repair API" below).

## Installation

```bash
# install straight from the local repo (dev/debug)
pi-web-ui install <repo>/plugins/legado-web

# after pushing to GitHub
pi-web-ui install <owner>/<repo>/plugins/legado-web
```

Once installed, refresh the browser and a 📖 tab appears in the top bar (hide it under settings panel →「界面插件」(UI plugins)).

## Build

`client/app/` (the embedded frontend) and `server/engine.mjs` (the rule engine used for AI diagnosis) are both build artifacts,
shipped with the plugin. After changing `app/src/`:

```bash
node plugins/legado-web/build.mjs            # auto npm install + vite build + esbuild engine when node_modules is missing
node plugins/legado-web/build.mjs --install  # force reinstall dependencies
pi-web-ui install <repo>/plugins/legado-web --force   # overwrite install (the plugin dir also carries a copy of the artifacts)
```

## Structure

```
plugins/legado-web/
├── manifest.json      # id/name/icon 📖, permissions: http (host.route) + net (outbound fetching) + tools (AI tools)
├── index.mjs          # server entry: /proxy, /store, and registers the four AI tools
├── net.mjs            # shared fetch layer (GBK codec + cookie jar), shared by UI/engine/sync bridge
├── store.mjs          # data persistence (<dataDir>/legado-web/<键>.json, atomic write)
├── tools.mjs          # AI tools: legado_rules / legado_book_sources / legado_source_probe / legado_run_rule
├── rules.md           # book source rule reference (for humans + the AI knowledge base; legado_rules returns it verbatim)
├── engine-bridge.mjs  # engine bridge on the main-process side (worker lifecycle + rebuild on timeout)
├── engine-host.mjs    # engine worker: injects transport, localStorage shim, runs probe/check/rule
├── sync-bridge.mjs    # sync bridge (Atomics.wait inside a worker thread, for synchronous rules like java.ajax)
├── sync-worker.mjs    # sync bridge worker: really sends requests, writes results back to shared memory
├── client/
│   ├── entry.mjs      # view entry: iframe filling the view (dependency-free plain DOM, no toolbar)
│   ├── ai-fix.mjs     # "AI fix source" body assembly (pure functions, shared by entry.mjs and tests)
│   └── app/           # embedded frontend build artifacts (index.html + assets/*, generated, do not edit)
├── server/
│   └── engine.mjs     # rule engine build artifact (esbuild bundles app/src/core/engine-entry.ts, do not edit)
├── app/               # embedded frontend source (from legado-web, see its README)
│   ├── src/core/      # book source rule engine (analyzeRule/analyzeUrl/js/webBook/check/probe…)
│   └── vite.config.ts # base './' + outDir ../client/app
└── build.mjs          # build script (npm install + vite build + esbuild engine)
```

## AI source-repair API (agent tools)

The plugin registers four tools (the `tools` family in `manifest.permissions`), letting the agent go "know the rules → read the source files →
step the chain to find the cause → try rules to verify → write the fix back":

| Tool                  | Purpose                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `legado_rules`        | Returns `rules.md` (rule syntax/fields/differences/flow reference); an optional `topic` returns just one chapter                                                                                                               |
| `legado_book_sources` | Reads source files: `list` (filterable by name/URL, with health status) / `get` / `update` (**deep merge** by field) / `add` / `remove`                                                                                        |
| `legado_source_probe` | Steps through「连通 → 搜索 → 详情 → 目录 → 正文」(connect → search → details → TOC → content), reporting per step: request URL/status/page snippet, parsed values, the **rule text** used, and any new **rule failure detail** |
| `legado_run_rule`     | Fetches a page and trial-runs a single rule (`listRule` supports entry-level sub-rules); returns the page snippet and the real evaluation result                                                                               |

Implementation notes:

- The rule engine runs in a **worker thread** (`engine-bridge.mjs` + `engine-host.mjs`) — one diagnosis makes several external requests (seconds to tens of seconds) and must not block the main process's WS/HTTP; on timeout or crash the worker is rebuilt automatically.
- The engine artifact is bundled by esbuild from `app/src/core/engine-entry.ts` into `server/engine.mjs` (`platform=node`), **the same source** as the rule engine in the browser, with identical behavior.
- `java.ajax/connect/get/post` in book source JS rules are synchronous: the browser uses sync XHR, and Node implements them via `sync-bridge.mjs` (nested worker + `SharedArrayBuffer` + `Atomics.wait`), so sources with such rules can be diagnosed too.
- The engine side injects a `localStorage` in-memory shim (for `java.cache`/infoMap), an async transport (`net.mjs`, the same implementation as the UI's `/proxy`) and a sync transport.
- Write operations call `host.notify` to tell the user to refresh the reading page (the copy in the browser is an in-memory mirror).

## Discover page: favorite sources + search this source directly

The discover page (browsing categories by `exploreUrl`) has two conveniences:

| Feature                       | Notes                                                                                                                                                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **☆ Favorite / ⭐ Favorited** | Adds the current source to favorites: the dropdown gains a「⭐ 常用（收藏）」(⭐ Frequent (favorites)) group at the top, plus a「⭐ 常用」button below so **one click switches source** (no digging through the dropdown every time)                                                         |
| **Search this source**        | Type a keyword in the discover page's search box → calls the current source's own search endpoint → results appear in the same list below (titled「🔍 搜索「x」」), no switching to the "Search" page; when nothing is found or the request errors, the「🤖 AI 修复源」button is right there |
| Category browsing             | Clicking a category paginates as usual (`下一页`); search and category browsing share one list container but don't bleed into each other                                                                                                                                                     |

Favorites are a local preference (the same data as ⭐ pinning on the book source page): `{"pinned":[书源URL…]}` in
`<dataDir>/legado-web/prefs.json` — both pages see the same set of "frequent sources", and deleting a source clears it there too.

## "AI fix source" button (reading page → AI conversation)

Everywhere the embedded reading page can't read a book, there's `🤖 AI 修复源`:

- Reading page toolbar (the current book) + the card for failed content loading
- The card for failed details loading
- Every row in the source list (shown only for sources that fail detection)
- The `🤖 AI 新建书源` button in the「导入书源」(Import sources) card at the top of the source page: **fill in just a website link**; the AI fetches pages itself, writes searchUrl / ruleSearch / ruleBookInfo / ruleToc / ruleContent, verifies with legado_source_probe, and finally persists with legado_book_sources add

With many sources (hundreds is common), these help you find things on the source page:

| Feature                 | Notes                                                                                                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Search box**          | Real-time filter by "name / address / group" (debounced input, cursor preserved, Esc clears); the title bar shows「匹配「xx」N 个」                                                                                                               |
| **⭐ Pin**              | A ⭐/☆ button on the left of each row: pinned sources move to the top (pinned rows get an accent bar on the left); click「取消全部置顶」(unpin all) to clear in one go                                                                            |
| **Pinned only**         | Check to show only pinned sources (combined with search it's a "favorites group")                                                                                                                                                                 |
| Hide dead / suspect     | Filter by detection result; the per-row「标回可用」(mark usable again) clears a false verdict                                                                                                                                                     |
| **🍪 Import Cookie**    | Inline button: paste the site's `document.cookie` from your desktop browser and it goes into that source's header for outgoing requests (bypassing shields/login); re-checks automatically after import                                           |
| **🌐 Browser fallback** | Inline toggle (needs Chrome/Edge installed locally; the plugin only detects, never bundles): when on, a source that hits a shield page is re-fetched by rendering in the real local browser; when not installed the button warns and does nothing |

Pinning is a **local preference** (not a field in the book source JSON), stored as `{"pinned":[书源URL…]}` in `<dataDir>/legado-web/prefs.json`; deleting a source clears its pins along the way.

- Every failed item on the detection page
- Discover page: the source-selection row (any source can be fixed manually) + category parse failures + category load failure cards

The「AI 新建书源」body looks like this (one link only, the rest goes to the AI):

```
【AI 新建书源】请为下面这个网站新建一个 Legado 文本书源（bookSourceType=0）并存盘。只加书源数据，不要改阅读插件本身。
- 网站：https://www.example.com
- 书源文件（要加进去的就是它）：~/.pi-web/legado-web/sources.json
- 规则速查（只读）：<插件目录>/rules.md
- 工作目录：~/.pi-web/legado-web
1) legado_rules 看语义 → 2) legado_run_rule 抓首页找搜索入口 → 3) 写 searchUrl+ruleSearch 并验证 →
4) ruleBookInfo/ruleToc/ruleContent 逐步验证 → 5) legado_source_probe 跑全链路 → 6) legado_book_sources add 存盘
```

What happens when you click it:

```
阅读页（iframe）  postMessage {type:"legado:ai-fix", context:{书源/书籍/出错地址/报错/相关规则}}
   ↓
entry.mjs（插件视图，同源 + source 校验）→ client/ai-fix.mjs 组正文
   ↓  window.__piWebUiHost.startChat({ prompt, newChat:true, cwd: 书源所在目录 })
pi-web-ui 主应用：切到「对话」视图 → 新建对话（cwd = `<dataDir>/legado-web`）→ 自动发送
   ↓
AI 拿到正文后：legado_rules → legado_source_probe → legado_run_rule → legado_book_sources update
```

Details:

- **Only change source data, never the plugin itself**: the body points at the **source file** (`<dataDir>/legado-web/sources.json`) and the **rule reference file** (`<plugin directory>/rules.md`, read-only reference);
  the plugin directory is still mentioned but explicitly marked **read-only** (`install --force` overwrites the whole directory, and this machine may not even have the sources), with a hard requirement: "do not modify app/, client/, server/, *.mjs; for forms the engine doesn't support, give an equivalent rule workaround".
- **cwd = the directory holding the sources** (dataDir, where `sources.json`/`shelf.json`/`check.json` live) — the AI's workspace is the data it needs to change, not the plugin code.
- Directory info (source file / rule reference / dataDir / pluginDir / workspace) is returned by the plugin server when it receives `{type:"info"}`.
- `startChat` waits for `set_cwd` → waits until the new conversation is really ready (server-side `new_chat` is async; without waiting the prompt lands in the old conversation) → then sends; every step has a timeout, and on timeout it still sends, never silently dropping the message.
- The host API is `window.__piWebUiHost` (defined in `web/src/plugin-host.ts`, currently `version: 11`). When the host is too old to have this API, the button degrades to "copy the AI-facing body to the clipboard + a hint" instead of silently doing nothing.

### Engine deviation fixed along the way

CSS evaluation in `app/src/core/analyzeRule.ts` used to treat a **single-segment rule** as an "output spec" rather than a selector,
so forms like `ruleContent.content = "#content"` and `ruleSearch.name = ".title##正则"` (extremely common in real sources)
never resolved to a value. Now: keywords (`text/textNodes/ownText/html/all`) still count as output, everything else is first treated as a **selector + text extraction**,
falling back to output spec when the selection finds nothing (preserving `href`/`text` forms inside entry scope). Both sides (embedded UI and AI engine) take effect together.

## Protocol (host.route, actual path `/plugins-api/legado-web/*`)

| Route                  | Method     | Notes                                                                                                                                |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/proxy?url=&charset=` | GET / POST | Fetches source sites: bypasses CORS, URL-encodes Chinese and POST bodies per `charset`, decodes GBK, isolates cookie jars per domain |
| `/store[?key=<键>]`    | GET        | No `key` → `{keys:[…]}`; with `key` → `{value}` (404 `{value:null}` when absent)                                                     |
| `/store?meta=1[&key=]` | GET        | File version of each key (or a single key) `{metas:{<键>:{size,mtime}}}` — the frontend uses this to detect **external changes**     |
| `/store?key=<键>`      | POST       | body `{value:…}` → atomic write to `<dataDir>/legado-web/<键>.json`, returns `{ok,bytes,meta}`                                       |

- **Zero npm dependencies**: GBK decoding uses the built-in `TextDecoder('gbk')`; encoding uses a lazily built reverse lookup table (walks the GBK double-byte space to build the mapping backwards, ~20ms, built only when a non-UTF-8 charset is used).
- **Never forward browser request headers**: only the default UA/Accept and the source's own declared `headers` — otherwise pi-web's token cookie would be carried to third-party sites (regression in `tests/legado-web-test.mjs`).
- **Private network/loopback blacklist (SSRF protection)**: `/proxy` refuses to fetch loopback, private network and link-local targets (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, CGNAT 100.64/10, multicast/reserved ranges, `::1`, `fe80::/10`, `fc00::/7`, `*.localhost`); domains are judged by DNS resolution results and redirects are re-checked hop by hop (followed manually, ≤5 hops). If a self-hosted source site needs to be fetched from the same machine, set the `LEGADO_ALLOW_PRIVATE_HOSTS=<hostname or IP, comma-separated>` environment variable to allow it explicitly.
- Static assets don't get plugin routes: `client/app/` is served by the host at `/plugins/<id>/client/*`; the frontend loads with relative paths, and the app root prefix (nginx subpath `/pi`) adapts automatically (`app/src/core/apiBase.ts`).

## Book source security (read this first)

Book sources are **rules + JS code written by third parties**; adding a source is equivalent to "allowing this code to run on your machine":

- **Source JS runs with the plugin process's privileges** (the embedded UI in the browser, AI diagnosis in the plugin worker), with no real sandbox isolation (an architectural limit — the original Legado's Rhino approach doesn't have it either): it can send arbitrary HTTP requests via `java.ajax` and read/write the in-memory cache and variable scope the plugin provides. **Only import sources from trusted origins**; avoid no-name "do-everything sources".
- **Time budget**: a single rule JS evaluation that exceeds 3 seconds aborts as a failure (`app/src/core/js.ts` cooperative checks + engine worker task timeout as a backstop); slow rules/infinite loops can't drag down the host.
- **`/proxy` never touches the intranet**: see the blacklist above; sources cannot fetch `127.0.0.1`, intranet ranges or cloud metadata addresses (169.254.169.254).
- **Data plane**: source data only lands in `<dataDir>/legado-web/*.json`; source JS cannot reach the host token, cookies or filesystem (the `java` bridge only exposes the methods rules need; see `makeJava` in `app/src/core/js.ts`).

## Data

Book sources / bookshelf / reading progress / detection results **only land in data directory files**: `<dataDir>/legado-web/*.json`
(`sources.json` / `shelf.json` / `progress.json` / `check.json`, plus the local preference `prefs.json` holding pinned sources; the default is `~/.pi-web/legado-web/`).

- **No writes to browser localStorage**: sources are routinely several MB (the 5MB quota can't hold them; QuotaExceededError was actually reported), and wiping cache/switching browsers loses them;
- the page keeps only an **in-memory mirror** (rendering reads synchronously, so render only after `hydrateFromBackend()`);
- discover page filters and `java.cache` for source JS rules also stay in memory only (recomputed on refresh);
- data that old versions kept in the browser gets a **one-time read-only migration** at startup (moved into files, then the old keys are deleted);
- when the backend is unavailable the status bar says「存储：仅内存（后端不可用，刷新会丢）」(storage: memory only — backend unavailable, lost on refresh).

### Refresh and the "hide dead sources" trap

- **Automatic refresh**: deleting a source / "delete dead sources" / import / finishing detection re-renders the affected pages (sources/search/detection/bookshelf, and discover when needed) in one pass;
- **Automatic external-change detection**: when `sources.json` etc. in the data directory is changed by **someone else** (the `legado_book_sources` AI tool, another page, a manual edit),
  the page compares the file's `size+mtime` on **page switch** and when the **tab/window becomes visible again**, and rereads + re-renders when it changed.
  The reading page also **re-fetches the current chapter's content** with the new rules (and the TOC too when the TOC rule changed) —
  "the AI said it's fixed but the reading page still shows the old result" is exactly this: the page used to read the file only once at startup;
- **Manual refresh (fallback)**: "Refresh" on the source/detection pages (reread all data and re-render), "Refresh data" on the search page,
  "Refresh" in the reading page toolbar, and "Refresh data and retry" on each failure card — all the same thing:
  **reread** from the data directory files, then rerun the current step with the new rules (discover categories / this chapter's content);
- **Deleting a source clears its detection record** (including the http/https and trailing `/` `#` variants of the same URL) — otherwise the top bar's「废源 N」(N dead sources) and the detection page keep showing deleted sources, looking like a refresh failure;
- **Hidden isn't deleted**: the source page has「隐藏废源」(hide dead sources) checked by default, search defaults to "skip dead sources", and the discover page filters `kind==='dead'` too,
  so a source judged dead **disappears in all three places**. The page tells you how many are hidden, and each source row has「标回可用」(mark usable again) to return it to unchecked state (no re-import needed).

> **Why not inside the plugin directory**: `pi-web-ui install --force` (the settings panel's "Update") deletes the whole plugin directory first,
> keeping only `config.json` — data like 700 book sources would be wiped by an update there. In `<dataDir>/legado-web/`
> it survives upgrade/reinstall/uninstall; to clear it, `rm -rf <dataDir>/legado-web`. Old versions'
> `storage/*.json` in the plugin directory is still read as a fallback source and moved over the first time it's read.

Moving data from an old legado-web (standalone deployment):

```bash
cp <legado-web>/server/data/*.json <dataDir>/legado-web/
```

## Tests

```bash
npm run build:server && node tests/legado-web-test.mjs         # ports 8993/8994: protocol/proxy/storage
node tests/legado-web-engine-test.mjs                          # port 8995: AI tools + rule engine (zero tokens)
node tests/legado-web-ai-fix-test.mjs                          # port 8996: "AI fix source" button E2E (auto-SKIP when Chrome is missing)
node tests/legado-web-storage-test.mjs                         # port 8997: storage degradation under large data (auto-SKIP when Chrome is missing)
node tests/legado-web-explore-test.mjs                         # ports 8998/8999: discover page + favorite sources E2E (auto-SKIP when Chrome is missing)
node tests/legado-web-reader-test.mjs                          # ports 8971/8972: reading page chapter-end navigation E2E (auto-SKIP when Chrome is missing)
```

`legado-web-test`: manifest push / embedded frontend static hosting / proxy UTF-8+GBK / charset encoding (URL and POST body) /
custom header forwarding / no browser header leakage / upstream failure 502 / storage read-write, large payloads, invalid keys / **`GET /store?meta=1` version info (external-change detection)**.

`legado-web-engine-test`: four tools registered / `legado_rules` content / "AI fix source" body assembly / source file list·get·add·update (deep-merge persistence)·remove /
chain diagnosis (including `step` single-step mode) / rule trials (page-level + entry-level) / single-segment CSS rule regression / synchronous `java.ajax` in source JS rules / info response for the frontend's directory query.

`legado-web-ai-fix-test`: bridge E2E — a harness page impersonates the host (fake `window.__piWebUiHost`) + a real embedded reading page; clicking「🤖 AI 修复源」asserts the body carries the context, the chat view was switched, a new conversation was requested, and cwd = the source directory (dataDir); run once each from the source page and the discover page.

`legado-web-storage-test` (Chrome): storage contract — 1.8MB of sources + a 3000-chapter bookshelf doesn't report QuotaExceededError,
after the run localStorage has **not a single `legado.*` key left**, data still there after a refresh (from files), old browser data migrated into files with the old keys cleared.

`legado-web-explore-test` (Chrome): discover page「★ 收藏书源」(★ favorite sources) + search this source directly + category browsing.

`legado-web-reader-test` (Chrome): reading page **chapter-end navigation** — "previous chapter / contents / next chapter" at the end of the content,
previous chapter greyed out on the first chapter, reading to the bottom and tapping next chapter switches chapters and scrolls to top, next chapter greyed out on the last chapter +「已是最后一章」(already the last chapter), chapter-end contents expand and scroll to top.

The first two are in `npm run test:smoke`; the pure-logic unit tests for chapter-end navigation are in `tests/unit/legado-chapnav.test.ts`;
the host action bridge timing has its own unit test at `tests/unit/plugin-host.test.ts`.
