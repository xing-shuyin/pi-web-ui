# Browser module

This module brings the AI Browser project into pi-web-ui without relocating the existing server, web, or desktop directories. The browser can continue to evolve independently of the Agent.

- `contracts.ts`: public state and host API; page request types derive from the existing wire protocol.
- `runtime/`: tab/session/navigation/download lifecycle and explicit credential filling. `runtime/crx.ts` strips the `.crx` signature header, extracts the payload zip (path/size/entry limits, no links) and validates `manifest.json`, because Electron's extension API only loads unpacked directories.
- `storage/`: bookmarks, history, settings, encrypted credentials and legacy data import.
- `automation/`: native page actions and screenshots, without a dependency on the chat UI. `automation/scripts.ts` implements the `script.*` operations (create / update / remove / enable / disable / run) that back the Agent's `browser_script` tool.
- `runtime/scripts.ts`: page-script records and matching (`PageScript`). `persistent` decides whether a script is written to `userData/browser/scripts.json` or lives only in memory for this run; matching accepts host globs, full-URL globs, `re:<regex>` and `*` (empty list = every http(s) page). Scripts are deliberately unlimited in size, count and capability — they run inside the page, so they never reach the host bridge, and the main process never evaluates their code.
- `renderer/`: browser chrome, new tab, management panels and document/media views.
- `preload.cts`: sandbox-compatible capability handshake.

The desktop composition lives in `desktop/browser-host.ts`. It supplies the Agent view, validates callers, and arranges browser/Agent/split layouts. Browser code must not import the Agent runtime or hardcode an Agent server address.

There is one tab state source, `BrowserManager`. UI and automation consume that source. Changing display modes preserves existing views. Browser settings and session data live under the application's `userData/browser` directory.

`BrowserManager.getActiveTabId()` is the single answer to "which tab does the user currently have open". The automation `pages`/`status` listing marks that tab with `active: true` and returns `activeTabId`, but only when the tab is operable: an internal page or the caller's own view is never reported as the page the user is viewing. Automation still needs an explicit `target` while several tabs are open; the ambiguity error names the tab the user is viewing so the caller can pass it.

Native control is available only to the configured Agent service's origin and base path. Browser shell/storage actions are restricted to exact bundled internal pages. All requests are checked again in the main process, including the current main frame and URL. System Chrome users keep the existing extension integration.

Page scripts are injected from the main process: `executeJavaScript` at `dom-ready`, CDP `Page.addScriptToEvaluateOnNewDocument` for `document-start`, `insertCSS` for styles, and `executeJavaScriptInIsolatedWorld` when a script asks for the isolated world. Operations without an explicit target resolve against the user's current tab (`getActiveTabId()`), the same source the `active` flag on `pages` uses, so a default never lands on a background tab. A script runs once per document (the run state resets on `did-start-navigation`, and the page keeps a per-document token map as a second guard), may `return` a cleanup function that runs before re-injection, disablement or removal, and is reported through `script.status` (`injected` / `skipped` / `errors`). Internal pages are never injected, and `allowScripts` is the single kill switch shown in the settings panel.

Extension installs are remembered in `userData/extensions/installed.json` and reloaded on the next start (Electron's `loadExtension` does not persist by itself). `.crx` installs land in `userData/extensions/crx-<content hash>`, so reinstalling the same file keeps the extension id and its storage.

Two install entry points share one code path: the settings panel (`extensions.installCrx` with no `path`) and drag-and-drop (internal pages resolve the file path in preload via `webUtils.getPathForFile` and pass `{ path }`; drops landing on web content are caught by `BrowserManager`'s navigation guard and go through `onFileDrop`).

Build with `npm run build:desktop`; start the full application after `npm run build` with `npm run desktop:dev`. The independent renderer interaction check is `node browser/renderer/verify-ui.mjs`. Native desktop regression is `node tests/browser-desktop-smoke.mjs`; it uses isolated temporary data and does not build implicitly.

See [architecture and security boundaries](../docs/architecture-browser.md) and [renderer behavior](renderer/README.md) before changing module boundaries.
