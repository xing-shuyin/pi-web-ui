**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# browser-use · Always-on Chrome automation and smart search plugin

An always-on Chrome automation plugin built on [DrissionPage](https://www.drissionpage.cn) that registers **one** native tool, `browser_use`, for the AI: page interaction and web search (`action: "search"`) in one, saving one tool definition and one round of decision cost.

## Core features

- **Fast search on a real browser (`browser_use(action: "search")`)**:
  - **Isolated background tab (Tab Isolation)**: searches run silently in a dedicated background Worker tab — whether the foreground is reading a document, filling a form or waiting on the user, it **never clobbers the active foreground page**; foreground focus is fully preserved after the search.
  - **CDP fast image-free rendering (Fast SERP)**: low-level CDP blocks images, video, fonts and third-party tracking scripts, so the page is ready in milliseconds, end-to-end speed improves 50%–70%, and bandwidth drops sharply.
  - **Freshness filter and publish-time extraction**: supports the `timeRange` parameter (`day` past 24 hours, `week` past week, `month` past month, `year` past year) and automatically distills an absolute date (e.g. `2024-03-15`) or relative time (e.g. `3小时前`) out of SERP cards, eliminating the knowledge-freshness blind spot.
  - **Real landing-page cleanup (Clean URLs)**: deeply decodes the tracking redirect layers of Google, DuckDuckGo, Bing and others, resolves Baidu `mu`/`data-tools` plus the real Sogou and 360 landing pages, so later reading is not blocked by 302 hotlink protection.
  - **One step, no round trip**: builds the search parameters directly and extracts results in seconds, avoiding the multi-round trip of "open home page → find input box → type text → press Enter → wait for snapshot"; a single Tool Call returns results immediately.
  - **Aggressive ad and noise filtering**: built-in precise DOM filters for the major search engines strip commercial promotions, sponsored ads, cookie popups and noisy sidebars, keeping only genuine organic results.
  - **Related query suggestions (Related Queries)**: automatically extracts the related search terms at the bottom of the SERP, extending the agent's divergent retrieval.
  - **Seamless multi-engine fallback (Fallback)**: supports 8 major engines by default, including `bing` (balanced Chinese/English, unblocked domestically), `google` (global frontier), `baidu` (native Chinese) and `duckduckgo` (no tracking); on a captcha or anti-scraping block it degrades smoothly to a backup engine to keep search reliable.
  - **Instant answer card parsing**: prioritizes instant answers (Instant Answer / Featured Snippets) such as weather, exchange rates, code snippets and definition cards, so the answer is hit without opening the landing page.
  - **Minimal token budget**: extracts title, direct link, precise snippet and publishing source, keeping a full screen of results at 500–1000 tokens so it does not crowd a long context window.
- **Zero-config always-on browser**: no hand-editing Chrome launch flags or debug ports. The plugin starts or connects an always-on real Chrome window (default port `9333`, its own sandboxed profile, never conflicting with the user's daily Chrome).
- **Unified background task management**: the browser runtime registers automatically with the Web UI's **「后台任务」**(Background tasks) panel (showing the current port and open tab count), where one click on **[停止]**(Stop) gracefully closes the browser at any time; fully wired into the host's "auto-clean leftovers" and "close all".
- **Idle timeout auto-close**: exits after long inactivity to free system memory and CPU (default: close after 15 minutes without any operation; adjustable in plugin settings from 0 to 180 minutes, where 0 means never auto-close).
- **Natural human-agent collaboration**: the window is visible on the desktop and stays open for the session. Users can open tabs and log in by QR code by hand in that window (WeChat/Taobao/GitHub etc.), and the AI takes over already-open pages at any time with `tabs` and `switch`.
- **Extreme token savings**: the unique `snapshot -i` page snapshot extracts only human-visible interactive elements (numbered like `[1] [button] 登录`), stripping tens of thousands of lines of redundant DOM and CSS/JS internals.
- **Full interaction coverage**: click, type, dropdown select, checkbox toggle, focus-and-type, key combos (`Enter`, `ctrl+a` etc.), smooth scrolling, JS expression execution, full-page screenshots.
- **Native anti-scraping penetration**: inherits DrissionPage's low-level Chromium CDP optimizations, with highly human-like characteristics that risk control and captchas rarely block.

## Installation and dependencies

1. **Enable the plugin**: pi-web-ui settings → Plugin management, turn on `browser-use`.
2. **Requirements**: Python 3 installed (and Chrome or Chromium installed).
   - On first use the plugin script creates a `.venv` in the plugin directory and installs `drissionpage` via pip (about 20–30 seconds, then ready automatically).
   - If an environment with `drissionpage` already exists, it is reused first.

## Plugin settings

Configurable under pi-web-ui settings → Plugin management → the `browser-use` gear icon:

- **Headless mode** (`headless`):
  - Default: `true` (already on by default)
  - Notes: when on, the always-on Chrome runs silently in the background and never pops a desktop window in the way; to observe the browser by hand or log in to a specific site by QR code, temporarily turn this off in settings.
- **Idle auto-close (minutes)** (`idleTimeoutMinutes`):
  - Default: `15` minutes
  - Range: `0`–`180` minutes
  - Notes: when neither the AI nor the user has done anything to the always-on browser within the configured time, the background triggers a graceful exit to fully free memory; `0` keeps it always-on and never auto-closes.
- **Default search engine** (`defaultEngine`):
  - Default: `"auto"` (adaptive smart fallback)
  - Options: `auto`, `bing`, `baidu`, `sogou`, `so`, `google`, `duckduckgo`, `brave`, `yahoo`
  - Notes: the default preference when no engine is given explicitly; on captchas or anti-scraping it retries down the fallback chain automatically.
- **Fast search mode** (`fastSearch`):
  - Default: `true`
  - Notes: during search, low-level CDP blocks downloads of images, fonts and media, so pages parse in milliseconds and both bandwidth and time drop sharply.
- **Search tab isolation** (`searchTabIsolation`):
  - Default: `true`
  - Notes: runs the search in a dedicated background tab, never disturbing or covering the page you are interacting with in the foreground.

## Precise background task management

The browser runtime registers itself with the **「后台任务」** panel in the Web UI's top-right corner or status bar:

- **Live status awareness**: shows the current port (`9333`), the open tab count and the headless mode state in real time;
- **One-click precise stop**: clicking **[停止]** in the background task list first sends a graceful exit signal, backed by a port-level forceful release, so the Chrome process is fully shut down and the port fully released within 1–2 seconds — no zombie processes left behind;
- **Wired into the host lifecycle**: supports the Web UI's "close all" and "auto-clean leftover tasks" mechanisms, starting and stopping gracefully with the app.

## Search capability: `browser_use(action: "search")`

Search is not registered as a separate tool; it is carried by the `search` action of `browser_use`; prefer that action when searching the web for the latest news, debugging errors or finding official docs (a keyword mistakenly passed in `text` is still detected as a fallback):

| Parameter `param` | Type      | Required | Description                                                                                                                                                                                                                          |
| :---------------- | :-------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`           | `string`  | Yes      | Search keywords; supports engine advanced syntax (e.g. `site:github.com`, `"exact phrase"`)                                                                                                                                          |
| `engine`          | `string`  | No       | Search engine: `"auto"` (smart pick by default), `"bing"` (Microsoft Bing), `"sogou"` (Sogou), `"so"` (360 Search), `"baidu"` (Baidu), `"google"`, `"duckduckgo"`, `"brave"`, `"yahoo"`                                              |
| `timeRange`       | `string`  | No       | **Freshness filter**: `"day"` (past 24 hours), `"week"` (past week), `"month"` (past month), `"year"` (past year), `"all"` (everything, default)                                                                                     |
| `page`            | `number`  | No       | **Search result page number**: default `1` (first page); passing `2`, `3` etc. pages precisely through each engine's native page offset to reach deep results                                                                        |
| `fetchTopContent` | `boolean` | No       | **Search-and-read in one**: while searching, also extracts the core clean body text (1500–2000 characters) of the top-ranked authoritative organic result in the background, so one Tool Call does "search + read" (default `false`) |
| `limit`           | `number`  | No       | Maximum number of organic results returned (1–20, `8` by default)                                                                                                                                                                    |
| `officialOnly`    | `boolean` | No       | **Official and authoritative site filter**: prefer/keep only officially certified sites and authoritative open-source docs (default `false`)                                                                                         |

### How to make search hit official and authoritative sites precisely (and eliminate ads entirely)

In a web full of knock-off download sites, reseller promotions and marketing rewrites, `browser_use(action: "search")` puts official and authoritative sites first on three axes:

1. **Automatic detection of official badges (Official Badges)**:
   - built-in DOM recognizers for the official certification marks of the major engines (e.g. Baidu `.c-icon-v` official certification, 360 `.icon-official` official shield, Sogou `.vr-official` label, Google/Bing official knowledge cards);
   - once an engine certifies a site as the real official one, the system tags it `🏷️ [官网/权威]` and **forces it into the top spot**.
2. **Authority top-level domain boost (Authority Domain Boost)**:
   - official code repos (`github.com`, `apache.org` etc.), authoritative organizations (`*.gov`, `*.edu`, `*.org`), official technical docs (`developer.mozilla.org`, `readthedocs.io` etc.) and official package hosts (`npmjs.com`, `pypi.org`, `crates.io`) are automatically judged high-authority and recommended first.
3. **Physical ad annihilation across engines**:
   - in the browser's V8 context it removes DOM trees carrying ad signatures such as `.b_ad`, `.ec_wise_ad`, `.e-prom`, `.sponsor`, `#taw`, `[data-text-ad]`, keeping commercial promotion out of the model's view.
4. **Specify `officialOnly: true`**:
   - when you only want official links (e.g. to find the real home page of an open-source project or download an official installer), turn this on to filter out every non-official blog or redistributor.

### Search engine matrix and selection strategy

| Search engine code `engine`      | Engine name               | Fit and strengths                                                                                                                    | Ad filtering and landing-page restoration                                            |
| :------------------------------- | :------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------- |
| **`auto`** (recommended default) | Fully automatic selection | Tries Bing and domestic fast engines first; on a block or captcha, **millisecond-level adaptive rotation** keeps a 100% success rate | Inherits the best cleanup rules of every engine                                      |
| **`bing`**                       | Microsoft Bing            | Unblocked domestically, good Chinese and English quality, instant answers and code cards                                             | Strongly strips `.b_ad` bid promotions and sidebar noise                             |
| **`sogou`**                      | Sogou Search              | China's second-largest Chinese engine, rich Zhihu/WeChat ecosystem, **very low risk control, almost zero captchas**                  | Removes `.sponsor` promotion, extracts the real landing page                         |
| **`so`** / **`360`**             | 360 Search                | Mainstream Chinese security engine, very fast, loose and stable anti-scraping                                                        | Filters `.e-prom` commercial promotion, restores `data-url`                          |
| **`baidu`**                      | Baidu Search              | Richest local information, life wiki and community content                                                                           | Deeply filters Baijiahao promotion, parses `mu`/`data-tools` to restore the real URL |
| **`google`**                     | Google Search             | The world's frontier authoritative technical and foreign-language material                                                           | Filters Google sponsored cards and internal-link redirects                           |
| **`duckduckgo`**                 | DuckDuckGo                | Geek and privacy search, zero tracking                                                                                               | Decrypts `uddg` to restore a clean landing page                                      |
| **`brave`**                      | Brave Search              | A new independent global privacy engine that does not rely on Google/Bing indexes                                                    | Extracts its own cards and filters sidebar popovers                                  |
| **`yahoo`**                      | Yahoo Search              | Classic global multilingual general search                                                                                           | Extracts organic results and snippets                                                |

> **Universal fallback engine (Universal Fallback)**: for any search engine on the market, even after a page redesign, the built-in adaptive heuristics still recognize high-quality title + snippet cards in the page body.

### Zero results must state whether it was "blocked" or "really nothing"

Zero results is the easiest scenario to misread: **"no results found" does not mean the keywords find nothing**, it is likely an anti-scraping captcha or an unreachable network. So on zero results `browser_use(action: "search")` no longer emits one canned line but reports the real reason engine by engine:

```
⚠️ 没有拿到任何结果，但这不等于「搜不到」——各引擎实际回报：
    · baidu — 人机验证/反爬拦截：百度安全验证（页面被重定向到验证页 https://wappass.baidu.com/...）
    · sogou — 人机验证/反爬拦截：搜狗反爬拦截
    · google — 网络不可达：浏览器网络错误（ERR_CONNECTION_TIMED_OUT）
诊断：2 个引擎被人机验证/反爬拦截，1 个网络不可达。
```

Three hard mechanisms go with it:

1. **Block detection covers real verification pages**: URL signatures (`wappass.baidu.com`, `/antispider/`, `qcaptcha.so.com`, `google.com/sorry`) take precedence over body keywords, plus Chrome error pages (`ERR_CONNECTION_TIMED_OUT` / 无法访问此网站, i.e. This site can't be reached) and captcha widget probes; only when the engine itself says "no related results" is it classified as **truly no results**.
2. **Engine health self-check (cached)**: probes TCP reachability for each engine domain and remembers recently blocked engines. A non-preferred engine confirmed unreachable/just blocked is skipped with the reason annotated instead of wasting a 6-second timeout on each of the four overseas engines (saving 20–40 seconds per search).
3. **Mutually exclusive search, no cross-contamination**: all searches share one background worker tab marked via `window.name` (surviving navigation, no more leaks from a fresh tab each time), serialized by an in-process queue plus a cross-process file lock — concurrent searches do not stomp each other's pages, so no cross-contaminated results and no false "no results".

Related environment variables:

| Variable                 | Default | Effect                                                                                   |
| :----------------------- | :------ | :--------------------------------------------------------------------------------------- |
| `DP_ENGINE_HEALTH_TTL`   | `600`   | Seconds to cache the engine reachability probe (0 = probe every time)                    |
| `DP_ENGINE_BLOCK_TTL`    | `900`   | Cooldown seconds for a blocked engine (skipped directly while cooling, unless preferred) |
| `DP_SEARCH_LOCK_TIMEOUT` | `90`    | Max seconds to wait for the search file lock (gives up on the lock to avoid hanging)     |
| `DP_SEARCH_LOCK_STALE`   | `120`   | A lock older than this many seconds counts as stale and is cleaned up                    |

Call example:

```json
{
	"query": "DrissionPage CDP 常见报错解决 site:github.com",
	"engine": "bing",
	"limit": 5
}
```

## Interaction tool: `browser_use`

The AI can drive the always-on browser (search included) directly with native tool calls:

| Action `action`     | Key parameters                                                                                      | Description                                                                                                                                                                                |
| :------------------ | :-------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`            | `query`(or `text`), `engine?`, `timeRange?`, `page?`, `fetchTopContent?`, `limit?`, `officialOnly?` | Runs a real-browser search and extracts organic results directly (the former `browser_search` capability is fully merged into this action)                                                 |
| `read_page`         | `url?`, `maxChars?`                                                                                 | Reader mode extracts the clean body text and core code blocks of a page, filtering all noise and ads; supports HTML tables to Markdown, code block syntax highlighting (very token-frugal) |
| `open`              | `url`                                                                                               | Opens the URL in the current tab (auto-prefixes `https://`)                                                                                                                                |
| `new`               | `url`                                                                                               | Opens the URL in a new tab                                                                                                                                                                 |
| `tabs`              | -                                                                                                   | Lists all tabs (index, title, URL and active state)                                                                                                                                        |
| `switch`            | `target`                                                                                            | Switches tabs by index (e.g. `"2"`), title or URL fragment                                                                                                                                 |
| `close`             | `target?`                                                                                           | Closes a tab (defaults to the active one)                                                                                                                                                  |
| `snapshot`          | `interactiveOnly?`                                                                                  | Returns a page structure snapshot; with `interactiveOnly: true` only numbered interactive elements                                                                                         |
| `click`             | `target`, `byJs?`                                                                                   | Clicks an element (snapshot index `"3"`, text `"Sign in"` or a CSS selector)                                                                                                               |
| `input`             | `target`, `text`                                                                                    | Clears and types text                                                                                                                                                                      |
| `select`            | `target`, `option`                                                                                  | Dropdown selection (by option text, value or index)                                                                                                                                        |
| `check` / `uncheck` | `target`                                                                                            | Checks / unchecks a checkbox or radio button                                                                                                                                               |
| `type`              | `text`                                                                                              | Types directly into the currently focused element                                                                                                                                          |
| `press`             | `key`                                                                                               | Fires a key or shortcut (e.g. `"Enter"`, `"ctrl+a"`, `"Escape"`)                                                                                                                           |
| `hover`             | `target`                                                                                            | Hovers the mouse over an element                                                                                                                                                           |
| `scroll`            | `scroll`                                                                                            | Scrolls the page: `"top"`, `"bottom"`, `"up"`, `"down"` or a pixel value                                                                                                                   |
| `wait`              | `seconds`                                                                                           | Waits the given number of seconds                                                                                                                                                          |
| `js` / `jsx`        | `code`                                                                                              | Runs JavaScript code or evaluates an expression                                                                                                                                            |
| `console`           | `level?`, `clear?`, `limit?`, `query?`                                                              | Shows the current tab's console logs (auto-captures `log`/`warn`/`error` and uncaught exceptions, filterable by level and clearable)                                                       |
| `screenshot`        | `path?`, `fullPage?`                                                                                | Takes a page screenshot (supports fullPage long images)                                                                                                                                    |
| `quit`              | -                                                                                                   | Closes the always-on browser window and ends the current automation session                                                                                                                |

## Typical conversation examples

- _"Look up the official PEP progress for removing the GIL in Python 3.13"_  
  → the AI calls `browser_use(action: "search", query: "Python 3.13 free threaded GIL PEP")`  
  → within 2 seconds it returns a compact, ad-free organic result list with official links.

- _"Search GitHub for the popular DrissionPage library and read the body details"_  
  → the AI calls `browser_use(action: "search", query: "DrissionPage github repo", limit: 3)` to get candidate URLs  
  → the AI calls `browser_use(action: "read_page", url: "https://github.com/g1879/DrissionPage")` to extract the clean README body in seconds (zero junk code and ads, about 1,500 tokens).

- _"Why did the page I just opened error out — what did the console print?"_  
  → the AI calls `browser_use(action: "console", level: "error")`  
  → immediately gets every uncaught exception (Uncaught Exception), Promise Rejection and `console.error` output captured on the page, with file stacks.
