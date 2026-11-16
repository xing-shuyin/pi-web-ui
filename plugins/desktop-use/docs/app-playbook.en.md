**English** · [简体中文](./app-playbook.md) · [繁體中文](./app-playbook.zh-TW.md)

# Playbook and best practices for common desktop apps (Desktop App Playbook)

> This document records the operating patterns, pitfalls and cross-turn stability rules for the `desktop-use` plugin when it drives common Windows software — especially WeChat, QQ and other self-drawn UIs and complex multi-window apps.

---

## 1. Core stability iron rules (must read)

### Iron rule 1: across turns / after user confirmation, always re-focus first

- **Symptom**: when the AI calls `ask_user_question` to pop a question dialog for the user to confirm, or the user clicks in the browser chat UI, **the system's foreground window is guaranteed to become the browser**.
- **Consequence**: calling `desktop_key(keys="enter")` right after that dispatches the key event to the browser (or the focused page element swallows it), and the target software never receives it!
- **Correct approach**: **before any operation that sends keys, text or clicks to the target software, unconditionally call `desktop_window(action="focus", title="...")` once**.

### Iron rule 2: on self-drawn UIs, paste instead of clicking blind coordinates

- **Symptom**: in WeChat, QQ and other apps built on Qt or a self-drawn engine, the input box is usually **active by default (cursor blinking)** when the window has focus.
- **Risk**: blindly passing a guessed or mis-scaled coordinate (`shot+x+y`) to "click first, then type" can land outside the input box and blur the input that was already focused!
- **Correct approach**:
  1. First `desktop_window(action="focus", title="...")` to activate the window;
  2. Then call `desktop_type(text="...")` directly (no x/y; it pastes through the clipboard + Ctrl+V internally);
  3. Screenshot to check; if it really is not focused, use `desktop_screenshot` to observe the actual cursor or input-box position and then click precisely.

### Iron rule 3: multi-monitor and DPI scaling protection

- Multi-monitor setups can produce negative coordinates (e.g. X < 0 when a secondary screen sits left of the primary).
- The plugin's `input.ps1` and `screenshot.ps1` both enable `SetProcessDpiAwareness(2)` and normalize coordinates through the `MOUSEEVENTF_VIRTUALDESK` virtual screen; never do your own integer rounding or ignore DPI scaling outside the plugin.

---

## 2. App chapter: WeChat (WeChat / Weixin)

### App profile

| Attribute               | Description                                                                                                                        |
| :---------------------- | :--------------------------------------------------------------------------------------------------------------------------------- |
| **Process name**        | `Weixin.exe`                                                                                                                       |
| **Window class name**   | `Qt51514QWindowIcon`                                                                                                               |
| **Window title**        | Dynamic, usually the **nickname of the currently signed-in user** (e.g. 「邢书印」)                                                |
| **UI architecture**     | Qt self-drawn UI; `desktop_elements` (UI Automation) can only enumerate the outer container — **inner controls have no UIA nodes** |
| **Interaction channel** | Screenshot stream (`desktop_screenshot`) + clipboard paste (`desktop_type`) + top-level keys (`desktop_key`)                       |

### Standard flow (message-sending pattern)

```
[1. Activate the WeChat window]
  desktop_window(action="focus", title="<user nickname or Weixin>")

[2. Screenshot to confirm the current conversation]
  desktop_screenshot(process="Weixin")
  - Check whether the chat list on the left or the conversation title at the top is the target (e.g. 「文件传输助手」 (File Transfer))
  - If not: click the matching spot in the search box or the chat list to switch

[3. Enter the message content]
  desktop_type(text="the content to send")
  - Note: the WeChat input box is active by default, so typing pastes through the clipboard; no x/y needed

[4. Screenshot the input box again]
  desktop_screenshot(process="Weixin")
  - Confirm the text is in the input box and the 「发送」 (Send) button at the bottom right turned green

[5. Irreversible operations: confirm with the user]
  ask_user_question(...) tell the user what will be sent and to whom

[6. Sending after user confirmation (the core step!)]
  a. desktop_window(action="focus", title="<user nickname>")  <-- ★ refocus first!
  b. desktop_key(keys="enter")                                <-- send the message
  c. desktop_screenshot(process="Weixin")                     <-- screenshot to verify the bubble landed
```

### Common issues and troubleshooting

1. **Q: Why did Enter not send the message?**
   - **A**: Check whether the previous step had a dialog or a browser interaction. If so, `desktop_window(action="focus")` must run before `enter`. Also check that WeChat's 「发送快捷键」 (send shortcut) is Enter (Enter sends by default, Ctrl+Enter inserts a newline).
2. **Q: Why is the typed text missing or garbled?**
   - **A**: `desktop_type` detects Chinese automatically and pastes through the system clipboard; make sure WeChat is in the foreground and the input caret is blinking when it runs.

---

## 3. App chapter: QQ / DingTalk / Feishu

- **QQ (QQ.exe)**: NT architecture (Electron self-drawn). The input box likewise stays active while the window is focused, and the flow is basically the same as WeChat.
- **钉钉 (DingTalk.exe)** / **飞书 (Feishu.exe)**: Electron architecture. If UIA can enumerate some input boxes, prefer `dump+id`; if enumeration returns an empty shell, follow WeChat's screenshot + paste flow entirely.

---

## 4. App chapter: browsers (Chrome / Edge)

- **UI architecture**: supports UI Automation (accessibility must be enabled / assistive technology supported).
- **Address bar / tabs**:
  - Switch tabs: `desktop_key(keys="ctrl+tab")` or `ctrl+1`..`ctrl+9`.
  - Open a new tab: `desktop_key(keys="ctrl+t")`.
  - Focus the address bar: `desktop_key(keys="ctrl+l")` or `desktop_key(keys="alt+d")`.
  - Find in page: `desktop_key(keys="ctrl+f")`.

---

## 5. App chapter: Windows Terminal / Command Prompt

- **Windows Terminal (wt.exe)** / **cmd.exe** / **powershell.exe**:
  - Keys can be sent by keyboard directly once focused, but note that selection mode (cursor becomes a white block / output paused) has to be exited with `esc` or `enter`.
  - To paste into a terminal, prefer `desktop_key(keys="ctrl+shift+v")` or `desktop_type`.
