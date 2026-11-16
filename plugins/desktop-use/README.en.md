**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Desktop control (desktop-use) 🖱️

Let the AI drive the **Windows / macOS desktop**: controls are located through native system accessibility APIs, while custom-drawn UIs are located via window screenshots plus offline OCR. Input on Windows goes through nut-js (installed automatically) with PowerShell as fallback; macOS uses the Swift native backend built into this plugin, with no external plugin or third-party input library.

## macOS setup and boundaries

- Requires macOS 12+ and Apple Command Line Tools (`xcode-select --install`). The first call compiles the source shipped with the plugin via the system `xcrun swiftc`, caching into the current user's temp directory; no executables are downloaded.
- Allow the host that launches the service (e.g. Terminal or the Electron desktop app) in 「系统设置 → 隐私与安全性 → 辅助功能」(System Settings → Privacy & Security → Accessibility); screenshots and OCR additionally need 「屏幕录制」(Screen Recording). A host restart may be required after granting. The plugin only checks permissions and never pops the system permission prompt itself.
- Control queries use Accessibility, screenshots use CoreGraphics, offline OCR uses Vision; window screenshots are scaled by actual pixels and then converted to screen logical coordinates, so Retina works.
- `desktop_key` accepts `cmd+c` / `command+c` / `meta+c` (mapped to Command), and `option` maps to Alt; `ctrl` keeps Control semantics.
- Chinese and emoji are typed through native Unicode keyboard events without touching the clipboard. Clicks, typing, shortcuts, scrolling and dragging affect the current mouse/keyboard and focus — **this is not an isolated background desktop**; operating on another Space or a minimized app is not promised.
- The current Windows development environment can only verify JS routing and the protocol; Swift compilation, system authorization, multi-display and target-app interaction must be accepted on a Mac.

## Install and uninstall

- **Install**: `pi-web-ui install <仓库>/plugins/desktop-use` (or copy this directory to `<dataDir>/plugins/desktop-use/`). The server's hot rescan activates it as soon as it lands.
- **Windows dependencies install automatically**: the input library `@nut-tree-fork/nut-js` is not in the install package, so after activation the plugin runs **`npm install` in the background** (directory lock against concurrency + 10-minute watchdog + top-bar progress notification, same as db-client). Before it finishes, click/type tools report "installing, try later"; **element queries are unaffected** (pure PowerShell, zero dependencies).
- **Uninstall**: `pi-web-ui uninstall desktop-use` deletes the whole directory; `node_modules` lives inside it, so the **dependencies vanish with it** and nothing is left behind. If the automatic install failed, run the command from the notification once inside the plugin directory.

## AI tools (8, each can be turned off in Settings → Plugin tools)

| Tool                 | What it does                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `desktop_elements`   | Query controls without a screenshot: `scope=foreground/desktop/window` + `query` filter, returns a `dump` snapshot key + `id` list (valid 90 seconds)                                                                                 |
| `desktop_click`      | Click an element: ① click the center of a UIA element by `dump+id`; ② screenshot path: pass `shot+x+y` (pixel coordinates) or `shot+text` (click straight on OCR-recognized text); left/right/middle button and double-click optional |
| `desktop_type`       | Type text; Chinese/emoji paste via the clipboard automatically; supports `shot+click_text` (click to focus on OCR text first) or `shot+x+y` or `id` to click before typing                                                            |
| `desktop_key`        | Press keys, e.g. `enter` / `ctrl+c` / `alt+F4` / `win+r`                                                                                                                                                                              |
| `desktop_window`     | `list` top-level windows / `focus` one to the foreground by title substring                                                                                                                                                           |
| `desktop_screenshot` | Screenshot by window: returns the image + the window's top-left screen coordinates and scale factor + **OCR text recognition with exact coordinates inside the image** (the entry point for interacting with custom-drawn UIs)        |

| `desktop_scroll` | Scroll at a `shot+x+y/text` or `dump+id` position, four directions, `amount=1–100` (default 3 notches) |
| `desktop_drag` | Drag from `x+y` to `to_x+to_y` within the same new screenshot, `duration_ms=100–2000` (default 500ms); re-queries afterwards |

Conventions: **query first, click after** — never guess an id, never reuse an expired snapshot; confirm with the user before close/delete/submit/payment.

## Interacting with custom-drawn UIs (screenshot path + OCR, verified on WeChat)

UIs `desktop_elements` cannot see (WeChat/QQ/games) go this way:

1. `desktop_screenshot` (`process=Weixin` or `dump+id`) → gives you the image + a `shot` key + the window's top-left corner + **the OCR list of text inside the image (with exact rectangles and center coordinates)** + **the current mouse pointer position** (the real pointer is drawn into the image with its coordinates, so the last landing point can be confirmed)
2. **Locating (two channels)**:
   - **Channel A (click text directly, most recommended)**: pass `shot="s1"` + `text="发送"` straight to `desktop_click`; the plugin matches the text center in the OCR results and converts it to a click, no manual coordinate math. Duplicate matches report candidate coordinates and require `occurrence=1/2/…` (in OCR list order) to choose explicitly; `desktop_type`'s `click_text` accepts this parameter too. OCR can misread — check the screenshot before clicking.
   - **Channel B (pixel coordinates)**: read `中心 (cx, cy)` (center) from the text list OCR returns, or pick pixels `{x, y}` from the image yourself, then call `desktop_click(shot="s1", x=cx, y=cy)`.
3. **Type text**: call `desktop_type` with `shot="s1"` + `click_text="搜索"` (or `x+y`) + `text="张三"` → the plugin does it **in one step**: clicks the target text center to focus, waits 250ms, then types immediately (Chinese pastes via the clipboard, English goes through the keyboard), **avoiding a two-call sequence where switching back to the browser between turns defocuses the window and the text is never typed**.

Screenshots are valid for 90 seconds (re-capture if the window moves). Implementation notes:

- Uses `Windows.Media.Ocr` (WinRT API) built into Windows 10/11 natively — fully offline, zero external dependencies, only ~150ms per call.
- PrintWindow `flags=2` is required to capture Qt content (`flags=0` gives a black image); the blank check only looks at the central 80% (borders inflate whole-image variance); occluded windows can still be captured — only a blank result requires `focus` to the foreground first.

## Finding windows: by process, not by title

Many app window titles change (the WeChat main window title is just your nickname), so `desktop_window list` and
`desktop_elements scope=window` both support finding by **process name**:

- WeChat: `process=Weixin` (older builds `WeChat`), window class `Qt51514QWindowIcon`
- Browsers: `process=msedge` / `chrome` / `firefox`

## Limitations

- Windows only (the tools error out directly when `process.platform !== win32`).
- Qt/custom-drawn apps like WeChat: the window can be located, but internal elements may be invisible in the UIA tree. The built-in WinRT OCR helps locate visible text, with recognition quality affected by font, scaling and contrast; buttons without text still need the screenshot path.
- Pure icon buttons (the rare case with no text and an empty UIA tree): use the screenshot path and click pixels `{x, y}` inside the image, optionally calibrated against the mouse pointer drawn in the image.
- Custom-drawn UIs (games, Canvas, some Electron custom-drawn areas) are empty in the UIA tree — such targets can now be interacted with by locating OCR text directly.
- Chinese input depends on the clipboard: don't move focus away while typing; with locating parameters the target is clicked first, without them the current focus receives the input. After pasting it waits for the target to read, then restores the previous text clipboard; non-text content such as images cannot be restored yet.
- Screenshot coordinates must lie inside the image; re-locate after the window moves, gets occluded or its content changes — the 90-second validity does not mean the UI stays unchanged in the meantime.
- Once the mouse button is pressed for a drag, it completes and releases within at most ~2.2 seconds before honoring cancel, so force-killing the helper process never leaves the button held down.

## Implementation references

0.4.0 took design cues from [Windows-MCP](https://github.com/cursortouch/windows-mcp)'s input tools, independently implementing four-direction scrolling and duration-bounded dragging; no Python/MCP dependency was added and no upstream source was copied. Fixed unreleased shortcut keys, OCR duplicate names defaulting to clicking the first match, and out-of-image screenshot coordinates.
