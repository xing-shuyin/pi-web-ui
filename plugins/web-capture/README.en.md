**English** · [简体中文](./README.md)

# Web Capture

No-extension page capture for AI debugging — bookmarklet + side-by-side browser/steps tab + 6 agent tools. Bilingual (Chinese/English, follows the host UI language).

## Layout

```
┌ icon toolbar: [→] [snap] [pick]      page ────────┐
├──────────────────────────────┬───────────┤
│                              │ Capture | Steps | Send   │
│  browser (iframe, left)      │ ① guide / URL+Go         │ sidebar (right,
│                              │ ② pick/snap/bookmarklet  │  resizable, default
│  (URL input centered when     │ ③ task → Send tab        │  320px, remembered)
│   no page yet)               ├───────────┤
│                              │ [Final & send to chat]  │ Send tab only
└──────────────────────────────┴───────────┘
```

- Left: browser pane (iframe, max height, no header bar). Same-origin pages
  (localhost dev, liveserver previews) are observed directly: clicks/inputs
  recorded, **Pick** outlines elements in-page, **Snap** captures 60 elements.
  Empty state shows a centered URL input instead of a blank page.
- Right: resizable steps sidebar (`⇔` drag, width remembered, default from
  settings). Three tabs: **Capture** (numbered 1-2-3 guide) / **Steps**
  (list + note/clear) / **Send** (task box + **Final & send** at its bottom).
- Framing-blocked sites (most logins): open them in your own tab and click
  the bookmarklet — snapshot/pick/click/input logs stream into the same steps
  (preflight-free GET beacon, no CORS; passwords masked per settings).

## Flow

1. Open the 🎯 tab, type a URL (or pick one from Capture) → `visit` step;
2. Click Pick, click an element → `pick` step with CSS selector;
3. Type in the page → `input` steps (passwords masked);
4. Write the task in Send → **Final & send to chat**: saves
   `web-capture/report-<ts>.md` in the workspace and attaches it to the
   composer as a file reference. Then describe the fix and send.

## Model protocol (MCP-style JSON-Schema tools)

In-chat models call these directly (name + description + input schema, the
same contract as MCP tools). pi-web-ui exposes plugin functions to models as
agent tools, so no separate MCP server is needed.

| tool                             | what                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| `web_capture_state`              | page + pick + recent log (Markdown)                                  |
| `web_capture_log {limit?,kind?}` | log tail: `pick/snap/click/input/submit/change/note/event/step`      |
| `web_capture_steps {limit?}`     | ordered steps with selectors — replay/debug what the user did        |
| `web_capture_note {text}`        | append a note (visible in tab)                                       |
| `web_capture_clear`              | clear log + steps                                                    |
| `web_capture_report {task?}`     | save Markdown report under `web-capture/`, return `{path, markdown}` |

## Settings (manifest `settings` → pi-web-ui settings page)

- `sidebarWidth` (default 320): steps sidebar width, draggable in-tab;
- `maskPasswords` (default true): password inputs logged as typed, no values;
- `autoSnapshot` (default true): auto-capture after opening same-origin pages;
- `maxSteps` (default 100): oldest steps dropped past the limit.

## i18n

Bilingual tab UI (zh/en dictionaries in `client/i18n.mjs`, following the host
UI language via `createPluginI18n`). Server/agent strings are English per the
repo prompt-hygiene rule.

## Network requirements (read this if the page looks broken)

- The proxy fetches the page **server-side**: `localhost` means the machine
  running pi-web-ui. Dev server on another box? Use its LAN/Tailscale address
  in the URL bar, not `localhost`.
- Assets/API/HMR go **directly from your browser** to the target
  (absolute URLs resolved via `<base>`). If the browser can't reach the dev
  server (remote phone vs local dev), the shell loads but data doesn't —
  open the page in a real tab instead (same network as the dev server).
- Login cookies are never forwarded by the proxy — logged-in pages must use
  the bookmarklet.

## Why bookmarklet instead of iframe/extension

Login pages mostly send `X-Frame-Options: DENY`; the bookmarklet runs in the
user's own browser, so login sessions just work (same idea as OpenCode Browse).
Cross-origin beacons use preflight-free GET (`Image.src`), no CORS, no install,
phones and desktops both work. Snapshots > 7KB truncate → re-capture or narrow
the page (chunked beacons are v2).

## Reference mapping

| need                     | Codex Browser Use     | Playwright / chrome-devtools MCP | web-capture                                 |
| ------------------------ | --------------------- | -------------------------------- | ------------------------------------------- |
| snapshot → act by ref    | ✅ (own browser/CDP)  | ✅ snapshot+ref                  | snapshot+selector ✅, reverse-act v2        |
| console log              | ✅                    | ✅                               | click/input/submit log ✅ (page console v2) |
| login session            | extension/own browser | own profile                      | user's real browser ✅                      |
| no-Chrome hosts (Termux) | ❌                    | ❌                               | ✅                                          |

## Roadmap (v2)

- `web_capture_act`: agent → page via `sendTo` + on-screen confirm;
- page console-error capture; snapshot chunking (`seq/total`).

## Files

- `manifest.json` (`view:true`, `ui/tools/http/fs/fs:write`, 4 settings)
- `index.mjs` (beacon `/collect`, `/state`, `/settings`, `/report`, 6 tools)
- `client/entry.mjs` (browser+steps layout, same-origin observe/pick/snap)
- `client/i18n.mjs` (zh/en)
