**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# 📬 webmail — pi-web-ui webmail plugin

A complete mailbox management view inside the pi-web-ui interface (the 📬 tab in the top bar):
IMAP receiving + SMTP sending + new-mail notifications, and the mailbox can be opened up to the AI for direct management.

## Features

- **Inbox**: browse / keyword search (subject, sender, recipient) / read the full body /
  mark read or unread / delete mail / **one-click translation** (Chinese ↔ English, AI model selectable, side-by-side with the original, copy the translation) / **quote mail into a conversation** (inject the mail into the main chat input box in one click)
- **Sending**: SMTP, supporting plain text and **HTML bodies** (`multipart/alternative`, with a plain-text fallback carried automatically), plus CC
- **New-mail notifications**: periodically polls the INBOX unread count and pops a notification bar through `host.notify`
  when new mail appears (poll interval configurable, default 60s)
- **AI mailbox management**: once dependencies are installed it registers an action-style `mail` tool (`action` =
  `list` / `read` / `search` / `send` / `manage` / `folders`) that sends HTML and plain-text mail; just say
  「看看最近有什么邮件」("show me recent mail") in a conversation. To retire it, turn entries off one by one in the
  「注册的 AI 工具」(Registered AI tools) group on the Settings → 「工具」(Tools) page (the tool is not registered while dependencies are incomplete)

## Configuration

The settings panel stores `<dataDir>/plugins/webmail/config.json` (a local file with the same security model as pi's
auth.json; passwords are covered below — encrypted secrets preferred):

| Field                  | Description                                  |
| ---------------------- | -------------------------------------------- |
| IMAP host / port / TLS | Incoming server (e.g. imap.qq.com:993)       |
| SMTP host / port / TLS | Outgoing server (e.g. smtp.qq.com:465)       |
| Username / password    | Mailbox account and password or app password |
| Poll interval pollSec  | Unread check period, default 60s             |

Config echoes are masked: only whether `hasPass` exists is returned; the password never travels back to the browser.

Passwords go into the host's encrypted secrets first (`host.secrets`, AES-256-GCM →
`<dataDir>/plugin-data/webmail/secrets.bin`), and once written `pass` in config.json is empty.
When an older host has no secrets facility, or writing the secret to disk fails (read-only directory / full disk), the password
falls back to plaintext in config.json with a one-time notice — plaintext beats saving and then losing the password.

## Install / uninstall / update

```bash
# ── install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail
pi-web-ui install plugins/webmail        # or a local directory (development)
# optional: --data-dir <dir> to use a custom data directory (default ~/.pi-web)

# ── list ──
pi-web-ui plugins                            # list installed plugins and their ids

# ── update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force
                                             # --force reinstalls over the top, i.e. updates
                                             # ⚠ back up config.json (account credentials) in the plugin directory first

cp -r plugins/webmail ~/.pi-web/plugins/ # local development: copy straight over
                                             # Windows: %USERPROFILE%\.pi-web\plugins\webmail

# ── uninstall ──
pi-web-ui uninstall webmail                  # removes the plugin directory (config.json goes with it)
# manual: rm -rf ~/.pi-web/plugins/webmail
```

Refresh the browser and it takes effect. The imapflow / mailparser / nodemailer dependencies are **not shipped with the package**:
the first activation npm-installs them into the plugin directory; if that fails, click 「安装依赖」(Install dependencies) in the view.

## Regression tests

- `tests/unit/plugin-tools.test.ts`: diff sync + registration lifecycle (vitest)
- `tests/unit/webmail-secrets.test.ts`: password persistence (with secrets available it only goes into the secret; a failed
  write falls back to plaintext; leaving it blank on a second save keeps the stored password)
