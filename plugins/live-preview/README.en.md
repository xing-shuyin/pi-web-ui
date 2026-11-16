**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# live-preview (live preview)

A Live Server-style preview plugin, with no standalone view tab — use it from the file tree in the right panel by right-clicking:

- 🌐 **Open with Live Server**: right-click a folder → open that directory; right-click a file / empty space in the list → open the current directory; clicking opens `/liveserver/...` in a new tab directly (relative-path css/js/images work, edits refresh automatically).
- 📝 **Preview Markdown** (shown on file rows only): `.md` files render via `/md/...`, other files fall back to Live Server; clicking opens in a new tab directly.
- 🧭 **Heading outline** (`/md` page): a table-of-contents column on the left — highlights on scroll, click to jump, drag to resize, `Ctrl/Cmd+\` to collapse; the toggle and width are stored in browser local storage. Not injected when there are fewer than 2 headings, or when the document already carries its own heading ids.

The real server binds only `127.0.0.1:<random port>` (external direct access being unreachable is fine); through the host's **generic proxy**
(`host.registerProxy`) it exposes just two same-origin prefixes to the outside: `/liveserver` and `/md`.

AI can call the `live_preview` tool (`path` takes a file or a directory, defaulting to the root) to get a preview URL;
by default it opens in a new tab of the default browser (disable with the tool's `open:false` or this page's setting; if the browser blocks the popup, click the link in the result).

## Notes

- Root = the current workspace (after `set_cwd` switches projects, refresh to see the new project); paths outside it are always rejected;
- Text is decoded by the host (falls back to GBK when UTF-8 fails), so legacy Chinese pages don't turn into mojibake;
- Preview file limit 10MB; a single `Range` segment is implemented (mp4 seeking works);
- Requires the `http` (register proxy) + `fs` (read workspace) + `tools` (`live_preview` tool) + `ui` (context menu) capabilities;
- Auto-refresh can be turned off in settings; the built-in server can be stopped from the background task panel in the top bar (reload the plugin to restore).
