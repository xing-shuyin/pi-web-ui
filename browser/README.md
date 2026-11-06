# Browser module

This module brings the AI Browser project into pi-web-ui without relocating the existing server, web, or desktop directories. The browser can continue to evolve independently of the Agent.

- `contracts.ts`: public state and host API; page request types derive from the existing wire protocol.
- `runtime/`: tab/session/navigation/download lifecycle and explicit credential filling.
- `storage/`: bookmarks, history, settings, encrypted credentials and legacy data import.
- `automation/`: native page actions and screenshots, without a dependency on the chat UI.
- `renderer/`: browser chrome, new tab, management panels and document/media views.
- `preload.cts`: sandbox-compatible capability handshake.

The desktop composition lives in `desktop/browser-host.ts`. It supplies the Agent view, validates callers, and arranges browser/Agent/split layouts. Browser code must not import the Agent runtime or hardcode an Agent server address.

There is one tab state source, `BrowserManager`. UI and automation consume that source. Changing display modes preserves existing views. Browser settings and session data live under the application's `userData/browser` directory.

Native control is available only to the configured Agent service's origin and base path. Browser shell/storage actions are restricted to exact bundled internal pages. All requests are checked again in the main process, including the current main frame and URL. System Chrome users keep the existing extension integration.

Build with `npm run build:desktop`; start the full application after `npm run build` with `npm run desktop:dev`. The independent renderer interaction check is `node browser/renderer/verify-ui.mjs`. Native desktop regression is `node tests/browser-desktop-smoke.mjs`; it uses isolated temporary data and does not build implicitly.

See [architecture and security boundaries](../docs/architecture-browser.md) and [renderer behavior](renderer/README.md) before changing module boundaries.
