# Web Inspect（网页拾取 / Web Inspect）

No-extension page capture for AI debugging — bookmarklet + side-by-side browser/steps tab + 6 agent tools.

## Layout

```
┌ icon toolbar: [→] [snap] [pick]      page ────────┐
├──────────────────────────────┬───────────┤
│                              │ Capture | Steps | Send   │
│  browser (iframe, left)      │ ① guide / URL+Go         │ sidebar (right,
│                              │ ② pick/snap/bookmarklet  │  resizable, default
│                              │ ③ task → Send tab        │  320px, remembered)
│                              ├───────────┤
│                              │ [Final & send to chat]  │ pinned bottom
└──────────────────────────────┴───────────┘
```

- Left: browser pane with address bar. Same-origin pages (localhost dev,
  liveserver previews) are observed directly: clicks/inputs recorded,
  Pick mode outlines elements in-page, Snap captures 60 elements.
- Framing-blocked sites (most logins): open them in your own tab and click
  the bookmarklet — snapshots/picks/logs stream into the same steps list.
- Right: resizable steps sidebar (drag `⇔`, width remembered in localStorage,
  default from settings).

## Flow (step by step)

1. Open the 🎯 tab, type a URL → `visit` step recorded;
2. Click **Pick**, click an element → `pick` step with CSS selector;
3. Type in the page → `input` steps (passwords masked per settings);
4. Write the task in the box → **Final & send to chat**: saves
   `web-inspect/report-<ts>.md` in the workspace and attaches it to the
   composer as a file reference. Then describe the fix and send.

## Model protocol (MCP-style JSON-Schema tools)

In-chat models call these directly (description + input schema, like MCP tools).
No separate MCP server: pi-web-ui exposes plugin functions to models as agent
tools, which is the same contract.

| tool | what |
|---|---|
| `web_inspect_state` | page + pick + recent log (Markdown) |
| `web_inspect_log {limit?, kind?}` | log tail: `pick/snap/click/input/submit/change/note/event/step` |
| `web_inspect_steps {limit?}` | ordered steps with selectors — replay/debug what the user did |
| `web_inspect_note {text}` | append a note (visible in tab) |
| `web_inspect_clear` | clear log + steps |
| `web_inspect_report {task?}` | save Markdown report under `web-inspect/`, return `{path, markdown}` |

## Settings (manifest `settings` → pi-web-ui settings page)

- `sidebarWidth` (default 320): steps sidebar width, draggable in-tab;
- `maskPasswords` (default true): password inputs logged as typed, no values;
- `autoSnapshot` (default true): auto-capture after opening same-origin pages;
- `maxSteps` (default 100): oldest steps dropped past the limit.

## i18n

Tab UI: `client/i18n.mjs` (`en` + `zh`), locale follows the global
`pi-web-ui:lang` via `createPluginI18n` (localStorage → `<html lang>` →
navigator). Bookmarklet strings pick zh/en via `navigator.language`.
Server/agent strings are English-only (repo prompt-hygiene rule).

## Why bookmarklet instead of iframe/extension

Login pages mostly send `X-Frame-Options: DENY`; the bookmarklet runs in the
user's own browser, so login sessions just work (same idea as OpenCode Browse).
Cross-origin beacons use preflight-free GET (`Image.src`), no CORS, no install,
phones and desktops both work. Snapshots > 7KB truncate → re-capture or narrow
the page (chunked beacons are v2).

## Reference mapping

| need | Codex Browser Use | Playwright / chrome-devtools MCP | web-inspect |
|---|---|---|---|
| snapshot → act by ref | ✅ (own browser/CDP) | ✅ snapshot+ref | snapshot+selector ✅, reverse-act v2 |
| console log | ✅ | ✅ | click/input/submit log ✅ (page console v2) |
| login session | extension/own browser | own profile | user's real browser ✅ |
| no-Chrome hosts (Termux) | ❌ | ❌ | ✅ |

## Roadmap (v2)

- `web_inspect_act`: agent → page actions via `sendTo` + on-screen confirm;
- page console-error capture; snapshot chunking (`seq/total`).

## Files

- `manifest.json` (`view:true`, `ui/tools/http/fs/fs:write`, 4 settings)
- `index.mjs` (beacon `/collect`, `/state`, `/settings`, `/report`, 6 tools)
- `client/entry.mjs` (browser+steps layout, same-origin observe/pick/snap)
- `client/i18n.mjs` (en/zh)
