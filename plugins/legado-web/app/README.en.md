**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Legado Web (plugin-embedded build · text sources only + proxy mode)

The core reading pipeline extracted from `legado-E` (a Sigma / Legado reading derivative):
`search / discover / details / table of contents / body text`, with book-source JSON compatible with the Android app.

> **This source is embedded in the pi-web-ui `plugins/legado-web/` plugin** and runs as a plugin view
> (the 📖 top-bar tab). Build, install, proxy and storage are all the plugin's job:
>
> - UI: `client/app/` (the output of `npm run build` in this directory) served by the host at `/plugins/<id>/client/*`
> - Proxy: `GET/POST /plugins-api/legado-web/proxy` in the plugin server `../index.mjs` (CORS + GBK, implemented in `../net.mjs`)
> - Storage: plugin server `/plugins-api/legado-web/store`, landing in `<dataDir>/legado-web/*.json`
> - Base URL derivation: `src/core/apiBase.ts` (adapts the app prefix from the page path, no build-time config)
> - The rule engine also has a **Node bundled build** (`src/core/engine-entry.ts` → `../server/engine.mjs`),
>   used by the plugin's registered AI tools (diagnostics / rule trials); it is the same source as the browser copy
>
> Day-to-day builds go through `../build.mjs` at the plugin root (vite + esbuild); this directory keeps `npm run dev` for front-end-only debugging (no same-origin proxy, bring your own).

## Build

```bash
node ../build.mjs          # equivalent to npm install + npm run build in this directory
npm run build              # build only (npm install first)
```

## Structure

- `src/types.ts` — corresponds to `app/.../data/entities/BookSource.kt`
- `src/core/analyzeUrl.ts` — corresponds to `AnalyzeUrl` (`,{json}` + `{{key/page}}`)
- `src/core/js.ts` — JS rules (originally Rhino, now run natively). `java` mirrors the original bindings: `put/get` (cross-rule variables isolated per book source), `ajax/connect/get/post` (synchronous requests through the proxy), `base64Encode/Decode`, `md5Encode`, `log/toast`; inside `<js>` you get `result/baseUrl/key/page/source/book/chapter/title/java`, and `{{...}}` templates support `java.get(...)` too
- `src/core/analyzeRule.ts` — corresponds to `AnalyzeRule`: CSS (including the original base syntax and indexes, `@` narrowing segment by segment + separating the output) / XPath / JSONPath / Regex + `||`/`&&`/`%%` (nesting aware of separators) + `##` (no replacement = delete, with replacement = replace, `###` = first match) + `@put/@get/{{}}` (`{{$.x}}` evaluated by the nested rule) + JS chaining + prefix + `:N` compatibility. **No rule ever throws**; failures are recorded in `ruleErrors` (search the console for `[规则失败]`).
  **Single-segment rules** (no `@`): first treated as a selector + text extraction (matching the Android app, so `#content`/`.title##正则` work directly);
  if nothing is selected it falls back to the output spec (attribute name), so `chapterName="text"` and `chapterUrl="href"` remain valid in item scopes.
- `src/core/probe.ts` — pipeline diagnostics (for the AI fixing sources): runs connectivity/search/details/TOC/body step by step, reporting request URL and status, page-body snippet, parsed values, original rule text, and rule failure details
- JS rules execute natively (Rhino semantics: sloppy mode, completion return values, per-source isolated shared variables, `java.put/get/ajax/post`, array/element facades `toArray/size/get/select/attr/text`)
- `src/core/js.ts` — native JS rule execution (Rhino semantics: sloppy mode, completion return values, **per-source isolated sandbox** (implicit globals never leak across sources), `java.put/get/ajax/post/getElement/getString/setContent`, array/element facades `toArray/size/get/select/attr/text`)
- Empty / non-body content no longer yields a blank page: it tells you the reason directly and logs `[正文为空]` / `[正文非正文]` details to the console
- `src/core/pageProblem.ts` — shield-page / garbled-page / empty-page detection and network error classification (shared by "detection" and body fetching)
- **Delete / mark a source dead anywhere** ("if the book you opened doesn't work, delete it on the spot"): top of the Discover page (delete source / mark dead), discover load-failure card (delete source / mark dead / try another source), reader toolbar (delete source / remove from shelf), body failure card, details failure card, every shelf row (delete source), 「删除废源」(Delete dead sources) on the sources page — deleting a source also clears that source's detection records and discover cache
- **Deleting a source deletes its books**: every delete-source entry point (reader / shelf row / Discover page / failure cards / the batch 「删除废源」) **also removes that source's books from the shelf** (reading progress included), and the confirm dialog warns "this source's books will be removed too" first; progress cleanup happens only on source deletion (「移出书架」/Remove from shelf keeps progress, so re-adding the book resumes)
- **Deleting from the reader = one-stop source switch**: 「删源」(Delete source) in the reader toolbar or 「删掉这个源」(Delete this source) on the body failure card — after deleting (books included) it jumps to the 「发现」(Discover) page automatically and clears the reader state (never staying on the old body from a deleted source); if the deleted source is the one the Discover page is currently viewing, its category / result caches are cleared and a source is picked again
- **End-of-chapter navigation** (reach the bottom and turn the page): a 「← 上一章 / 目录 / 下一章 →」(← Previous / Contents / Next →) row at the end of the body (with 《书名》· chapter n of total), so finishing a chapter needs no scroll back to the top; after a chapter change it returns to the top, the first chapter greys out 「上一章」(Previous) and the last greys out 「下一章」(Next) with 「已是最后一章」("already the last chapter") spelled out (the top-bar buttons of the same name follow the same rule), and the end-of-chapter 「目录」(Contents) expands the TOC and scrolls to the top. The decision logic lives in `src/core/chapnav.ts` (pure functions, unit-tested)
- **Discover page**: pick a source → categories are parsed automatically (JS / JSON / text formats) → click a category to browse books + next page; filter controls (text/select/toggle) store their values in infoMap and wire into JS; a failed category load reports the reason
- Tested sources: Kuwo Novels (JSON API), Yueyou Novels (HTML) — search → details → TOC → body all pass; the Discover page scored 18/18 on working sources
- **Automatic dead-source detection and hiding** ("a book you cannot read also counts as dead"):
  - `快速检测废源` (quick dead-source check): site reachability + search — down / blocked / shield page / no search rule
  - `完整检测废源` (full dead-source check): continues into details / TOC / body; a broken chain, an empty body, or **a site notice instead of body text** (e.g. "version too old, please upgrade") all count as dead
  - The source list hides dead sources by default (suspicious ones can be hidden too), search skips dead sources by default (working sources only / all sources selectable), "delete dead sources" cleans up in one click, and detection runs automatically after import
  - **Automatic marking on read failure**: when reading a book confirms the source is broken (no body rule / WebJS / site notice / shield page / network unreachable), that source is marked dead automatically with a notice
- `src/core/explore.ts` — **discover (explore)**: parses `exploreUrl` (`@js:`/`<js>` yielding a JSON category array, a plain JSON array, or the legacy `分类::url` text) + loads lists on category click + `infoMap` filter values (feature-matching the original, including `java.t2s/s2t` compatibility stubs and `cache.getFile/putFile`)
- `src/core/check.ts` — **source detection**: three levels (reachability only / reachability + search / full pipeline), recording time and result per step, with failures boiled down to plain-language conclusions; results are `ok` / `dead` (site-level dead source, hideable) / `suspect` (suspicious: no search results / incompatible rules)
- `src/core/webBook.ts` — corresponds to the `model/webBook/*` five-piece set
- `src/core/request.ts` — all requests go through the proxy (base URL in `src/core/apiBase.ts`)
- `src/core/apiBase.ts` — API root derivation: inside the plugin → `<prefix>/plugins-api/legado-web`, standalone deployment → `VITE_API_BASE`
- `src/store.ts` — persistence: **memory as the source of truth + double write** to localStorage (a cache capped at 5MB; keys over the cap are skipped automatically) and a local file (`<dataDir>/legado-web/*.json`); `src/store-cache.ts` handles slimming / capacity decisions. On startup it calls `hydrateFromBackend()`: if the backend has data the backend wins, if the backend is empty while the browser has data it migrates automatically; when the backend is unavailable it falls back to browser-only
- `src/core/backend.ts` — local storage service client (`/store?key=<key>` to read, `POST` to write)
- `src/store.ts / src/main.ts` — shelf + four-page UI (shelf/search/sources/detection/reader)

## Storage

Book sources / shelf / reading progress / detection results **land only in data-directory files** (`<dataDir>/legado-web/*.json`, default `~/.pi-web/legado-web/`):

- Local file layout: `sources.json` (book sources), `shelf.json`, `progress.json`, `check.json`, `prefs.json` (machine-local preferences such as pinned sources)
- **No browser localStorage**: book sources run to several MB (too much for the 5MB quota, which once raised QuotaExceededError), and clearing the cache / switching browsers loses them
- The page keeps only an **in-memory mirror** (read synchronously while rendering); discover filter values and JS rule `java.cache` live in memory only as well
- Data in browsers from older versions gets a one-time read-only migration at startup (moved into files, then the old keys are deleted)
- Migrating data from an older legado-web: copy `server/data/*.json` into `<dataDir>/legado-web/`
- With the backend unavailable (e.g. front-end dev only) the status bar shows 「存储：仅内存（后端不可用，刷新会丢）」(Storage: memory only — backend unavailable, lost on refresh)
