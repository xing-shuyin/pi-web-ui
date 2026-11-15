**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# page-picker · Web element picking (browser extension)

Click elements on **the page you are developing**, turn them into context an AI can act on directly, and inject it into the pi-web-ui conversation composer in one step.

There is also a **page bridge** (two **paired** pages reading and writing each other) and **AI page control** (letting the model in a conversation read and write pages you authorize) — see below.

```
Press Alt+Shift+P on the page you're developing (or click the extension icon)
   → hover highlights, click to pick (Shift+click to multi-select)
   → write a note in the bottom bar
   → "Add to conversation"
   → the pi-web-ui composer now holds the formatted context; add "these three spacings are inconsistent" and send
```

What gets collected is not a screenshot but **the things that let an AI get it right in one pass**:

| What gets collected                                                | Why it matters                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **React component source location** (`Card.tsx:18:5` + call chain) | Dug out of the fiber's `_debugSource`. This is the dividing line between "the AI gets it right in one pass" and "the AI greps the whole repo"                                                                        |
| **Vue SFC file**                                                   | Taken from the component instance's `__file` (file only, no line numbers — no fake line numbers invented)                                                                                                            |
| **Matched CSS: file + source line number**                         | In Vite dev the textContent of `<style data-vite-dev-id>` matches the source file byte for byte, so line numbers can be derived exactly                                                                              |
| **Computed style subset**                                          | **Reports only properties that differ from default/inherited values** (a probe element with the same tag is built on the spot for comparison). A real card usually comes down to 3~5 lines instead of 300 properties |
| Selector / XPath / DOM path                                        | Prefers the short unique one (`#card` > `section#card` > fall back to all-`:nth-of-type`)                                                                                                                            |
| HTML skeleton + collapsed text                                     | Structure rather than the whole `outerHTML` tree (deep child nodes collapsed to `…`)                                                                                                                                 |
| Element screenshot (optional)                                      | Goes in as a conversation attachment, not base64 stuffed into the body                                                                                                                                               |

**You check what gets sent**: page context / locator info / XPath and DOM path / source location / text /
matched CSS / computed styles / HTML skeleton, one toggle each — anything unchecked is **not collected at all** (not just
not rendered), so "just the source this time" and "just the styles this time" are both the leanest option there is. If that is too much work, use a preset:
Lean / **Standard (default)** / Full / Just find where to fix (selector+source) / Debug styles only / Text/structure only.

**Presets and per-item checkboxes can be changed right on the pick bar** (the row of chips in the bar that appears after you click elements; `Alt+1~6` is the same entry point),
no need to go back to the extension options page — judgements like "just the source location this time" only come up while standing on the page looking at the element.
Changing them **immediately re-collects the selected elements under the new profile**, so what the bar shows is what gets sent this time; the choice is written back to the extension settings
(options page stays in sync, the next pick reuses it). The preset also decides capture depth (text length, skeleton depth); per-item checkboxes do not change depth.

## Install

The extension is **not in the Chrome Web Store** (listing it needs a developer account + review, and this extension's service address is something you fill in yourself,
so a store build buys nothing extra). Three paths, pick one by who you are:

### ① Download and install (recommended, no Node needed)

**Download**: [`page-picker-extension.zip`](https://github.com/xing-shuyin/pi-web-ui/releases/latest/download/page-picker-extension.zip)
(always points at the latest; to pin a version, go to the [Releases](https://github.com/xing-shuyin/pi-web-ui/releases) page
and grab the one with the version number)

1. Unzip (you get a directory containing `manifest.json`)
2. Open `chrome://extensions` in Chrome / Edge (Edge uses `edge://extensions`)
3. Turn on **"Developer mode"** in the top right
4. Click **"Load unpacked"** and select the directory unzipped in step 1
5. Set the service address (either way):
   - **Least work**: open your pi-web-ui page first, then click the extension icon **on that page** — the extension recognizes it as
     pi-web-ui and pops "This page is pi-web-ui. Set it as the pick service address?" at the bottom of the page;
     click "Set as service address" and you're done (address/port/sub-path are all derived from the current page, nothing to type)
   - Manual: click the extension's **"Extension options"**: fill in the pi-web-ui address (default `http://127.0.0.1:8787`);
     for a remote/LAN address, click **"Authorize this address"** first, then **"Test connection"**

> After installing, `chrome://extensions` shows a "Developer mode extension" notice; that is normal for every
> unlisted extension (occasionally Chrome pops "Disable developer mode extensions" after an update — click Keep).

### ② Install from source (for people changing the code)

```bash
npm run build:extension        # esbuild bundle into plugins/page-picker/extension/dist/
```

Then install via steps 3~4 of ① above, except the directory is `plugins/page-picker/extension/` in the repo.
After changing source, re-run `npm run build:extension` and click the refresh icon for this extension in `chrome://extensions`.

### ③ Pack into a zip for distribution (build your own)

```bash
npm run pack:extension         # → release/page-picker-extension-<version>.zip (with CRC self-check)
```

CI runs the same command when tagging and attaches the zip to the GitHub Release (see `.github/workflows/extension-release.yml`),
so the link in ① is always current.

### Permission footprint

Only `localhost` / `127.0.0.1` host permissions are pre-installed, plus `activeTab` (temporary access to the
current tab **only for the moment you click the icon**); no always-on injection into every site. Switching to a LAN IP / domain / https address requires an authorization for that one
origin — **click the icon once on the pi-web-ui page at that address** and it walks you through it (see "Choosing the service address").

### Prerequisite: a recent enough pi-web-ui

The extension injects content through the host action bridge `window.__piWebUiHost.compose()` on the pi-web-ui page
(host API **v2**). When an older pi-web-ui lacks that method, the extension explicitly says "version too old" and falls back to
copying Markdown — never a silent failure. (**The bind bar is not version-limited**: without the bridge it falls back to probing the same-origin
`/api/health`, which still identifies the page.)

## Remote / LAN deployment (pi-web-ui not on this machine)

**It works, and nothing has to be installed on the server** — the extension is purely browser-side; delivery goes through
"the pi-web-ui page open in the browser", not a server API. So the typical remote setup looks like this:

```
[your browser]
  ├─ Tab A: https://pi.example.com/          ← pi-web-ui (over on a remote server)
  └─ Tab B: http://localhost:5173/settings   ← the site you're developing/debugging
        ↑ press Alt+Shift+P here to pick → content is injected into Tab A's composer
```

The only thing to get right remotely or on a LAN is **setting the service address correctly (and authorizing that one origin)** —
see the next section, where ① exists exactly for this.

## Choosing the service address (local / LAN / remote alike)

Neither the address nor the port is fixed (locally it may be `localhost:8787` or `127.0.0.1:9000`; remotely
`http://203.0.113.10:8787` or a reverse-proxied domain), so the extension does not guess — **both paths work**:

### ① Click the icon once on the pi-web-ui page (recommended)

The extension probes the current page first:

- **It is pi-web-ui** (looks for the host action bridge on the page; older versions get one same-origin `/api/health` probe) → a bar pops up at the bottom
  asking "Set it as the pick service address?" → click **"Set as service address"**. Address, port and sub-path are all
  derived from the current page, nothing to type; if it is already this address it just says "already bound" instead of asking again;
  the bar also carries **"Pick elements on this page"** (used when developing pi-web-ui itself).
- **Not pi-web-ui** → enter pick mode as usual (a **persistent thin bar** appears at the bottom at the same time: status +
  **"Let AI control this page…"** + **"Pair with another page…"** + **"Exit"**, see "AI page control" below).

If that remote address is **not yet authorized**, the bar says so and offers an "Open settings to authorize" button — because
`chrome.permissions.request` must be issued from an extension page (the browser demands a user gesture; a button on a web page doesn't
count), so this is not a redundant step, it is the permission model.

### ② Fill it in on the options page (equivalent; use this when troubleshooting)

1. On the extension options page change the address to `https://pi.example.com` (or LAN `http://192.168.1.10:8787`,
   reverse-proxy sub-path `https://host/pi`)
2. Click "Authorize this address" (this step is mandatory: the manifest only pre-installs `localhost` / `127.0.0.1`,
   every other address must be authorized explicitly; without it you cannot even "find that tab")
3. Click "Test connection" — it tells you both **whether the server is up** and **whether that page is open in the browser**

> Local deployments need **no authorization** whether you use `localhost` or another port (the pre-installed `http://localhost/*`,
> `http://127.0.0.1/*` patterns are port wildcards); just make sure the address on the options page is character-for-character identical to the one in your address bar
> — matching is strict (it would rather report "page not found" than inject into a debug site with a similar prefix).

Remote caveats:

| Situation                                                | Behavior                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| pi-web-ui page **closed** (server running, no page open) | Delivery fails → copy Markdown fallback. **By design**: the injection target is that page                                                   |
| Address not authorized                                   | Explicit "Not authorized `https://pi.example.com/*` — go to the options page and click authorize", plus copy fallback                       |
| Several tabs open (including the site you are debugging) | Re-verified by URL, delivered only to the pi-web-ui page; **never injected into the debug site or a prefix-similar site**                   |
| Reverse proxy with a sub-path (`https://host/pi/`)       | Supported (authorization is per origin, page matching uses the path prefix you entered)                                                     |
| `PI_WEB_TOKEN` enabled                                   | Irrelevant to the extension: auth is carried by the page itself (cookie/URL); the extension only writes into an already signed-in page      |
| HTTPS + self-signed cert                                 | The browser must trust that cert first, otherwise the page won't open and there is nothing to inject into                                   |
| Server and browser on different machines                 | No problem at all; the extension never talks to the server directly (only "Test connection" on the options page fetches `/api/health` once) |

## Interaction

| Action                                                                     | Effect                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extension icon / `Alt+Shift+P`                                             | **Current page is pi-web-ui** → asks whether to bind it as the service address; otherwise enters pick mode (a persistent thin bar appears at the bottom too: "Let AI control this page…" is right there, no need to click an element first) |
| (bottom thin bar) Let AI control this page / Pair with another page / Exit | Opens the authorization panel on the extension options page (pre-filled with this page) / opens the pairing panel (pre-filled with this end) / exits picking                                                                                |
| (bind bar) Set as service address / Pick on this page / Close              | Writes settings / picks like a normal page / closes the bar (`Esc` does the same)                                                                                                                                                           |
| hover                                                                      | Highlight + size/tag tooltip                                                                                                                                                                                                                |
| click                                                                      | Picks that element and enters the confirm bar (normal flow)                                                                                                                                                                                 |
| `Shift`+click                                                              | Appends to the multi-selection, stays in pick mode                                                                                                                                                                                          |
| `Enter`                                                                    | Go from pick mode to the confirm bar                                                                                                                                                                                                        |
| `Backspace`                                                                | Undo the last one                                                                                                                                                                                                                           |
| `Alt+1~6`                                                                  | One-key preset switch (Lean/Standard/Full/Fix location/Styles/Text) — works in both pick mode and the confirm bar                                                                                                                           |
| `Ctrl/⌘+Enter`                                                             | Send directly (the whole flow is keyboard-drivable)                                                                                                                                                                                         |
| `Esc`                                                                      | Confirm bar → back to pick mode; pick mode → exit (discard)                                                                                                                                                                                 |

Each element is one row in the confirm bar: selector + a "what is wrong with this element" note box + ✕ to remove. Above the element list sits a row of **preset chips**
(Lean / Standard / Full / Fix location / Styles / Text) + **"Adjust items ▾"** on the right (expands 8 per-item checkboxes, equivalent to the options page,
collapsed by default); below the preset row a summary states "what is being sent now + capture depth"; below that one more overall note.

## Fallbacks when things fail

**"Clicked add and nothing happened" never happens**:

| Situation                                                                   | Behavior                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No pi-web-ui page open                                                      | Notice + **Markdown copied to the clipboard**, paste into the composer by hand                                                                                                                                                                         |
| Clicked the icon on the pi-web-ui page (by accident)                        | Not an error: asks "Set it as the service address" instead, and also offers "Pick elements on this page"                                                                                                                                               |
| background fails to identify the page (CSP / permissions / odd environment) | The bar **identifies again by itself** (same-origin `/api/health` + DOM shape): if it is pi-web-ui it asks about binding as usual, if not it exits on its own and lets the worker re-inject the picker — never "clicked the icon and nothing happened" |
| Clicked "Set as service address" but an authorization is missing            | The bar says which authorization is missing and offers "Open settings to authorize" (a click on that kind of page cannot supply the gesture the browser wants)                                                                                         |
| pi-web-ui version too old (no compose)                                      | Explicitly says to upgrade and refresh the page, copy fallback as well                                                                                                                                                                                 |
| Composer not ready yet                                                      | Says to refresh the page and retry, copy fallback as well                                                                                                                                                                                              |
| Screenshot failed (no activeTab etc.)                                       | Just no screenshot; Markdown is delivered as usual                                                                                                                                                                                                     |
| Page cannot be injected (`chrome://`, store pages)                          | Extension badge `!` + tooltip stating the reason                                                                                                                                                                                                       |

## AI page control (a tool that lets the model read and write web pages)

This is the extension's second real job: **let the model in a conversation operate pages you have open in the browser** —
read their content, click buttons, fill forms, scroll, navigate, and run a script in them when needed.

```
You say: "read the amounts of the first 10 rows on the backend orders page, sorted by amount"
   → the model calls browser_page (op: read / click / …)
   → the server pushes it to the pi-web-ui page in the browser
   → the extension executes it on **the target page you authorized**, and the result travels back to the model
```

**The other end is always the pi-web-ui page** (the model's actions enter the extension from there), so unlike the page bridge there are not two ends to configure —
you only authorize **the page being operated on**. The cost: **that pi-web-ui tab must be open** (same trade-off as pick delivery).

### How to enable it

**The entry point is the "Browser control" button in the pi-web-ui top bar** (it doubles as the status panel):

- Open it to see "is the extension installed / how many pages are authorized / the state of both master switches";
- It contains an **"Open extension settings page"** button — a web page cannot navigate to `chrome-extension://` itself, so the extension does that step;
- The panel also shows two examples you can copy and use as-is.

Three authorization steps:

1. **Click the extension icon once on the target page** — it becomes a candidate; the **bottom thin bar** in pick mode shows
   this page's authorization state directly (not authorized / authorized / master switch off);
2. Click **"Let AI control this page…"** on the thin bar (the same-named button in the confirm bar, or just fill in the address on the extension options page);
3. Click **"Authorize this page"** on the extension options page (this step also requests the host permission for that address).

After authorizing, go back to that page and the thin bar **turns into "Authorized · the model can operate this page" by itself** (the extension watches the
authorization table, so no second icon click and no page reload).

You can also **revoke authorization** on the options page at any time (once revoked, the model can no longer touch that page).

### Referencing a page into the conversation (no typing URLs)

Once authorized, having the model operate a page does not require writing the URL in the message — the top-bar button is the entry point:

- **Only one page authorized**: the top-bar button **becomes that page's title**; one click puts a "page reference" into the composer;
  the **▾** on its right is the original status panel (authorization management / switches / refresh all live there).
- **Several pages authorized**: the button stays "Browser control · N"; open the panel and every page has **"Reference into conversation"**,
  and you can reference several in a row.
- What lands in the composer is a `🌐 page title` attachment chip — the same kind of thing as "reference a file" (removable, multiple,
  mixable with file attachments) and it is **not sent automatically**: add "read out the first ten rows" and send.
- On send the server attaches a note for the model (`<browser-page url title>`): **this page is authorized, use `browser_page` with
  `target=` this origin** — the model does not have to guess the URL from your message, nor go fetch the page.

**While the model works inside a page, a hint flashes in the bottom-right corner of that page** ("AI is operating this page · click #submit") —
informational only, no interception, fades after 2 seconds, so you don't think the page is moving by itself.

### What the model can do

| Action   | Parameters                                            | Notes                                                                                                                                    |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pages`  | —                                                     | Lists authorized pages (title, whether open, and the one the user is looking at as `active:true`) — the model looks here before working  |
| `read`   | `what`: text / html / title / url / query; `selector` | Reads the page or one element; `query` returns an element summary (text/size/input value)                                                |
| `click`  | `selector`, `index?`                                  | Scrolls into view first, then dispatches a real click (page listeners receive it)                                                        |
| `type`   | `selector`, `text`, `clear?`, `submit?`               | Types (native setter + re-dispatched input/change, so React controlled components accept it too); `submit` sends Enter                   |
| `scroll` | `selector?`, `to?{x,y}`, `by?{x,y}`                   | Scrolls, or scrolls an element into view                                                                                                 |
| `goto`   | `url`                                                 | Navigates (returns the result first, then navigates, so the call never turns into "no response")                                         |
| `wait`   | `selector?`, `text?`, `timeoutMs?`                    | Waits for an element/text to appear (what SPA async rendering relies on)                                                                 |
| `eval`   | `code`                                                | Executes a snippet of JS in the page (**off by default**, see below)                                                                     |
| `shot`   | `selector?`, `maxEdge?`                               | **Screenshot** (the AI's eyes): whole viewport or one element, long edge 1280 by default, max 1568. Needs extra authorization, see below |

Besides listing pages, `pages` / `status` also answer "**which page is the user looking at**": the `active` tab in the last focused window,
with the corresponding page marked `active: true` and `activeOrigin` given alongside the list. No extra `tabs` permission is required here — the query
`{ active: true, lastFocusedWindow: true }` only runs for **origins with host permission**; unauthorized pages are never reported to the model even when in the foreground.
With several authorized pages stacked up the model still **must pass an explicit `target`** (it may not silently pick one), and the error text names the origin the user is looking at.

### Three layers of switches

| Switch                                | Location                            | Default                                        |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| `browser_page` tool                   | pi-web-ui settings → Tools          | on                                             |
| "Allow AI page control" master switch | Extension options → AI page control | on                                             |
| "Allow arbitrary JS (eval)"           | Extension options → AI page control | **off**                                        |
| "Allow screenshots (shot)"            | Extension options → AI page control | on (but one permission grant first, see below) |

`read` / `click` / `type` / `scroll` / `goto` / `wait` all "do things with events the page already reacts to";
`eval` is "hand the page to a model-written script" — it can change data and submit forms, so it is off by default and must be turned on by hand.

### Screenshots (the AI's eyes) and the vision bridge

By default the model can only read DOM text via `read` — questions like "does this page look right" are beyond it. `shot` fills that gap:
capture the viewport or one element; **a multimodal main model just looks at the image, a text-only model is auto-transcribed through the vision bridge**
(the same logic as a user pasting an image: it works if the setting is on, no extra configuration).

Two costs you must know:

| Cost                    | Notes                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Extra authorization** | The browser's screenshot API only accepts `<all_urls>` or "the temporary grant from the moment you clicked the icon" (a normal host grant is not enough). So turning on "Allow screenshots" pops **"Read your data on all websites"** once — decline and it stays off, the model can still use `read`. |
| **Switches tabs**       | Screenshots can only capture the **current active tab**: the extension brings the target page to the front first and **switches straight back** afterwards (also on failure). Your focus jumps for a moment.                                                                                           |

Screenshots have a default long edge of 1280, max 1568 (JPEG, size stays manageable); with `selector` the image is cropped to the element (if the element is almost entirely out of the viewport it is **not captured**, rather than handing back a misleading fragment).

### Security model

- **The authorization list is the only credential**: not a single byte is injected into an unauthorized page, and the model cannot click there either;
- **Only initiated from the pi-web-ui page**: the extension only accepts "the pi-web-ui page in the browser bound to the service address" as caller
  (judged by `sender.tab.url`); every other page and external program is rejected;
- **Action allowlist**: 12 actions in total (the 9 in the table above + host-side `status` / `openOptions` / `metrics`); any other action name is rejected outright (otherwise a script inside a page could order the extension around);
- Authorization always needs one click on the options page (host permissions require a user gesture), so "handing a page to the AI" is always a human decision.

### What it says on failure

| Situation                                | What the model sees                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| No page authorized                       | "No pages authorized for the AI yet — go to the options page and authorize" |
| Target page not open                     | "Page (http://…) not open — open it in a tab first"                         |
| Several pages and no target given        | "Several pages are authorized — pick one with target"                       |
| Selector matched nothing                 | "Selector didn't match: #xxx" (with a next-step suggestion)                 |
| `wait` timed out                         | Returns `found: null` + how long it took (no error, the model decides)      |
| eval enabled but the page CSP forbids it | An error with a "use read/click/type instead" suggestion                    |
| No pi-web-ui page in the browser         | "Please open a pi-web-ui page first" (said before the tool times out)       |

### Known limitations

- **The pi-web-ui page must be open** (and in that browser): the model's actions can only enter the extension from there.
- **The desktop app (Electron shell) cannot do this**: the desktop window has no Chrome extension runtime and extensions cannot be installed
  (issue #153) — open the same pi-web-ui address in your system browser (the web version); the panel has a button that takes you there.
- **`eval` is bound by the target page's CSP**: when a page forbids `unsafe-eval` (plenty of production sites do), eval is unusable —
  that is the browser's rule, not a bug (to change data use click/type).
- The bridge is installed in the **top frame**; elements inside cross-origin iframes are unreachable.
- `chrome://`, extension pages, store pages and `file://` (needs manual allow) cannot be authorized.
- **Third-party scripts** in the page can also see the injected `window.__piBridge` (same boundary as the page bridge) —
  so only authorize pages you trust.

## Page bridge: let two pages read and write each other

Picking is one-directional (web page → pi-web-ui composer). The **page bridge** opens up the other half: two
**paired** pages can call each other — across origins, across tabs, across windows.

Only an extension can do this in a browser: a cross-origin `postMessage` needs a return handle from `window.open` and cooperation on the other side,
and `BroadcastChannel` / `localStorage` are same-origin only.

```js
// Page B (callee): register capabilities
window.__piBridge.on("orders", () => [...document.querySelectorAll(".order")].map((el) => el.textContent));
window.__piBridge.on("highlight", ({ id }) => document.querySelector(`#${id}`)?.scrollIntoView());

// Page A (caller): call it
const orders = await window.__piBridge.call({ op: "orders" }); // no to needed with a single peer
await window.__piBridge.call({ to: "https://other.example", op: "highlight", args: { id: "row-3" } });
window.__piBridge.peers; // who I can talk to (array, reference only)
```

| Method                                 | Description                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `on(op, handler)`                      | Registers an operation (`op` is a non-empty short string); returns an unregister function. `handler` runs when the peer calls it |
| `off(op)`                              | Unregisters                                                                                                                      |
| `call({ op, args?, to?, timeoutMs? })` | Calls the peer, resolves with its return value; rejects with an `Error` carrying the reason                                      |
| `peers`                                | Current peer origin list (**reference only**; admittance is decided by the extension background from the pair table)             |
| `version` / `self`                     | Protocol version / this page's origin                                                                                            |

**How to enable it** (**no typing addresses**):

1. **Click the extension icon once in each of the two pages** you want to pair (just the pick click) — they become candidates;
2. The pick bar on the development page also has a "Pair with another page…" button: one click pre-fills **this page** and opens the settings page directly;
3. On the options page under "Page bridge", click the other endpoint's input, pick it from the dropdown, then click "Authorize and add pair".

**Off by default**: only the pairs listed can talk; a page does not sprout an extra channel just because the extension is installed.

> Why candidates are limited to "pages you clicked the icon on": listing all tabs would either need host permissions (unauthorized sites hide their url)
> or the `tabs` permission (which prompts "read your browsing history" at install) — one extra scary-looking permission for a dropdown
> is a bad trade. At the moment you click the icon you already hold `activeTab`, so url and title are readable.

### Contract and limits

| Item                | Rule                                                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data                | Must be JSON-serializable (two JS heaps isolated across origins, only plain data crosses). DOM nodes / functions / circular references do not get through |
| Payload size        | Arguments ≤ 256KB; result ≤ 512KB (exceeding it errors out rather than dragging the service worker down)                                                  |
| `op`                | Non-empty, ≤ 64 characters, no control characters                                                                                                         |
| Timeout             | 5s by default, 30s max; the **page side** enforces it (the Promise never hangs)                                                                           |
| Peer not open       | "Peer page not open — open it in a tab first"                                                                                                             |
| Peer has no such op | The error lists **what it did register** (so you don't diff code across two pages)                                                                        |
| Cannot be injected  | `chrome://`, extension pages, store pages and `file://` (needs manual allow) cannot be paired                                                             |
| iframe              | The bridge lives in the **top frame**; a page inside a cross-origin iframe counts as its own page (with its own origin)                                   |

### Security model (important)

- **Deny by default**: any unpaired origin is rejected, and so is any pair that is disabled in the table.
- **Only the sender counts**: the extension background decides "who are you" solely from `sender.tab.url`; **no field in the message body counts**
  — otherwise page A could claim to be page B and walk off with all of B's data.
- **Authorization needs a user gesture**: adding a pair requires a click on the options page (`chrome.permissions.request` does not accept
  a button on a web page), so "opening a bridge" always carries one human confirmation.
- **`window.__piBridge` lives in the page's main world**: **any script** in a paired page (including third-party ads/analytics) can reach it.
  That is a physical boundary of the MAIN world, not an implementation defect — so **only bridge pages you trust**.

Failures are always one readable sentence ("peer hasn't registered…", "not paired yet…", "not authorized…") — never "clicked and nothing happened".

## Why an extension is required

"Click elements on any web page" can only be done by code inside the browser (it has to read the DOM of the page you opened,
and run across sites). Every alternative is worse:

- **Bookmarklet**: nothing to install, but blocked by page CSP (sites whose `script-src` lacks
  `unsafe-inline` kill it outright), and it cannot reliably get results into a pi-web-ui page on another origin.
- **DevTools Snippets alone**: paste a snippet by hand, find it and run it yourself every time; no hover highlight, no multi-select.

So the extension is the only clean way; the price is installing it once in **the browser you use it from** (loading it in developer mode
is enough, no store listing needed).

## Known limitations

- **Automated extension install: not Chrome, but Edge works**. Chrome 137 removed `--load-extension` (verified on local
  Chrome 153: `chrome://extensions` cannot install it), so the main E2E takes the equivalent route of "inject the real `dist/picker.js`
  - real background module + real pi-web-ui page" (`tests/page-picker-test.mjs`);
    but **Edge (152, headless) still accepts `--load-extension`** in practice, so there is a second E2E that **installs the real extension**
    (`tests/page-picker-edge-ext-test.mjs`, SKIPped when Edge is absent) — it runs real `chrome.*` and catches things like
    "a fake chrome does not validate match patterns" (that is how 0.2.0's delivery failure slipped through).
    Manually loading an unpacked extension is unaffected.
- Screenshots only capture the **currently visible area** (`captureVisibleTab`); when an element is almost entirely outside the viewport it is not captured, rather than returning a misleading fragment.
- Vue gives you the file but no line numbers (SFC line info needs a sourcemap to recover); production builds have no `_debugSource`, so
  React/Vue locating degrades naturally to "the matched CSS location".
- Cross-origin stylesheets hide `cssRules` → only that sheet is skipped; other sources' rules and picking itself are unaffected.
- Delivery **depends on the pi-web-ui page being open** (an architectural trade-off: it goes through `compose()` on the page instead of a server
  API, which buys zero server changes and free reuse of the login state and draft merging; the price is copy fallback when the page is closed).
  Making it "receive even when the page is closed" would mean adding an HTTP receiving route in a server plugin — a different path.

## Distribution (for maintainers)

| Channel                                  | Status                                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GitHub Release zip                       | ✅ automatic on tag (`extension-release.yml`), file name `page-picker-extension-<version>.zip` + an unversioned stable alias |
| Repository source                        | ✅ `plugins/page-picker/extension/`, needs `npm run build:extension`                                                         |
| Chrome Web Store                         | ❌ not listed (needs a developer account + review; a store build of a user-configured-address extension gains nothing)       |
| `pi-web-ui install` / plugin marketplace | ❌ not applicable — that channel installs **pi-web-ui server plugins**, not browser extensions                               |

## Self-test

```bash
npm run build:extension && npx tsc -p plugins/page-picker/extension/tsconfig.json --noEmit
npx vitest run tests/unit/page-picker.test.ts tests/unit/page-picker-background.test.ts tests/unit/page-picker-options.test.ts tests/unit/page-picker-preset-ui.test.ts
npm run build   # repo build (E2E needs dist/server)
node tests/page-picker-test.mjs
node tests/page-picker-bridge-test.mjs   # page bridge: two real pages reading/writing each other
node tests/page-picker-edge-ext-test.mjs   # installs the real extension (needs Edge, otherwise SKIP)
```

- `tests/unit/page-picker.test.ts`: locator strings / HTML skeleton / contract → Markdown (jsdom) +
  bind copy `bindView` + page detection `detectPiWebUi` (real bridge / `/api/health` / probe fails / timeout self-abort)
- `tests/unit/page-picker-background.test.ts`: service worker decisions (fake chrome, **validating match patterns the way real Chrome does**) + crop math + icon-click routing (pi-web-ui page → bind bar; normal page → picker; probe unavailable → bar self-check) + bind/authorization failure paths
- `tests/unit/page-picker-options.test.ts`: the `?bind=` panel on the settings page + **page bridge pair management**
  (real options.html + fake chrome: add/delete/disable really persist and notify the worker; invalid addresses and unauthorized origins do not persist)
- `tests/unit/page-picker-bridge.test.ts`: **admission and routing** for the page bridge and AI page control (fake chrome + fake window) —
  **the sender decides (claiming to be the peer in the message body gets you nowhere)**, multiple peers require an explicit target, peer not open/not registered/result too large,
  non-cloneable results, results with a mismatched token are ignored, repeated injection preserves handlers, the three roles (host/authorized page/paired page),
  and **self-containment of page-side functions** (`toString` then rebuild still works — referencing module scope would throw ReferenceError in the page)
- `tests/unit/page-picker-ai-ops.test.ts`: the AI's built-in actions (real jsdom) — the four `what` kinds of `read`,
  `query` summaries and limit, `click` really dispatched, `type` going through the **native setter** plus input/change re-dispatch (that React controlled-component trap),
  `wait` polling and timeout, `goto` returning the result before navigating, `eval` return values/errors, no built-in actions on unauthorized pages, the allowlist being exactly twelve entries
- `tests/unit/page-picker-preset-ui.test.ts`: the preset controls on the bar (real clicks in jsdom): chip click callbacks,
  per-item checkboxes, **rejecting the removal of the last item**, the collapsible panel, `Alt+1~6` parsing, summary text
- `tests/page-picker-test.mjs`: end to end (real Chrome + real pi-web-ui page + real probe/bind bar + the bar exiting on its own)
- `tests/page-picker-bridge-test.mjs`: page bridge end to end (two real ports = two origins + real `dist/bridge.js`
  - real background logic): A reads B's data, B changes A's DOM, unpaired pages cannot call anyone,
    peer not open/not registered/handler throws/non-cloneable result each come with a one-sentence reason, deleting a pair really tears the bridge down
- `tests/page-picker-edge-ext-test.mjs`: end to end with the **real extension installed** (real `chrome.*`: delivery really lands in the composer, the bind bar really pops,
  non-target pages really exit on their own, the page bridge really calls across origins, **AI page control (real `executeScript` injection into MAIN world, then real title read/real click/eval toggle/allowlist)**); needs Edge on the machine, SKIPped otherwise
