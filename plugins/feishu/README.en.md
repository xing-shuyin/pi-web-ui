**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# 🐦 feishu — pi-web-ui Feishu workspace plugin

A complete Feishu / Lark workspace inside the pi-web-ui interface (top-bar 🐦 飞书 (Feishu) tab):
two-way conversation send and receive through a Feishu custom app, custom group-bot Webhook card push, new-message polling alerts, and Feishu interaction surfaced for the AI to drive directly. The HTTP API uses the built-in fetch and crypto; the duplex long connection uses the official `@larksuiteoapi/node-sdk`, installed through the host's `ensureDeps` when missing.

## Features

- **Conversations and channels**:
  - Browse the group and one-to-one conversations the bot has joined
  - Add custom quick recipients by hand (`chat_id` `oc_...`, `open_id` `ou_...`, user email)
  - Built-in virtual Webhook push channel (`__webhook__`): a group-bot Webhook alone is enough even without a custom app
- **Message browsing and reading**:
  - View and parse many Feishu message types: plain text (`text`), rich text (`post`), interactive cards (`interactive`), images, files, videos, business cards and more
  - Keyword search over the current conversation or recent chat history
  - **One-click quote into a conversation**: format a Feishu message as a quote and inject it into the main chat input
  - **Smart translation**: Chinese↔English, optionally through a specific AI model, URLs and code blocks protected automatically, with Google GTX as the fast fallback
  - **Raw data view**: expand to inspect the raw JSON structure delivered by the Feishu Open API
- **Message sending and rich interaction**:
  - Send plain text, rich text (with a title) or Feishu interactive cards (Markdown plus 10 card title color themes: blue, green, orange, red, purple and more)
  - Reply directly or **reply in thread**
  - One-click **recall** of messages the bot sent
  - **Reactions**: 👍 like, 👌 OK, ❤️ heart, 👏 applause, ✅ done, 🔥 fire
- **Custom bot Webhook**:
  - Push to a Feishu group custom-bot Webhook address
  - HMAC-SHA256 signing secret support, with `timestamp` and `sign` computed automatically
  - Webhook push history kept locally for auditing and troubleshooting
- **Status bar and new-message alerts**:
  - Periodic background polling for new messages in monitored conversations (60s by default, configurable)
  - On a new message, `host.notify` raises a desktop/web notification and triggers a broadcast
  - Status bar shows a live badge (`🐦 3 未读` (3 unread) / `🐦 ✓` / `🐦 Webhook` / `🐦 未配置` (not configured))
- **AI Feishu management tool (`feishu`)**:
  - Once activated, registers an action-style `feishu` tool with the host:
    - `chats`: list groups and conversations
    - `list`: recent messages in a conversation
    - `read`: read one message's details and body
    - `search`: search message content
    - `send`: send text/rich text/card messages to a group or person
    - `reply`: reply to a given message (thread replies supported)
    - `recall`: recall a message the bot sent
    - `react`: add a reaction to a message
    - `webhook`: push a card or text straight through a group-bot Webhook
  - Strict prompt and safety rules apply: before sending, the model is prompted to confirm target and content with the user first

## 0.3.0 Duplex commands and media

Every command is handled locally by the channel: `/help`, `/new [prompt]`, `/clear [prompt]`, `/reset [prompt]`, `/status`, `/stop` (alias `/abort`), `/model [provider/id|default]`, `/thinking [off|minimal|low|medium|high|xhigh|default]`, `/cwd [absolute path|default]` (alias `/workspace`). Command names accept any case, full-width letters and full-width slashes; thinking effort and `default` are case-insensitive. The prompt after a reset becomes the new conversation input directly, keeping internal whitespace and literal content such as `/stop` or `@文本`, and is no longer parsed as a command. Unknown commands get an immediate reply and are never sent to the model.

Sessions are isolated by sender, chat and thread. Creating, clearing and switching directory each bump the account epoch, so the host builds a brand-new context; old history is kept. `/new`, `/clear`, `/reset` and the model, thinking-effort and directory setters all reset the current scope immediately and request a stop of the old run; old messages that were downloading, awaiting reaction feedback or awaiting acknowledgement are neither delivered nor restored to the old binding; other chats and threads are unaffected. A reset that happens before the model list has been validated invalidates that setter, so a late validation cannot overwrite the new context. `default` clears that override and restores the plugin's configured default. The directory gets only an absolute-path check; existence and access limits are validated by the host on the next delivery. Models are validated against the host list; model and thinking effort are really passed on the next request, and the host confirms final support. Preferences live in working memory only; the epoch and stable session routing are persisted and survive a reload.

The bot downloads images (including images inside rich text), files, voice and video and delivers real bytes to `host.chat({text, attachments})`. Images use `imageData`, other files use `fileData`, and the host persists them; this needs a host version that supports the attachment contract. At most 8 images, at most 10MiB per image or fileData attachment; imageData and fileData from the same message share a cumulative 20MiB budget, counted in raw bytes before Base64. Images may be PNG/JPEG/GIF/WebP, detected by file header; full pixel decoding is left to the host/model. Missing resource permission, failed download and unsupported formats are all reported explicitly. The channel has no ASR, audio transcoding or video decoding of its own; audio and video go to model tools as files, content understanding is not guaranteed, and the limitation is stated on receipt.

The AI `feishu` tool's `send/reply` accept `msg_type=image|audio|file|media` plus `file_path`, read a real local file, upload it to Feishu and send it; audio must be Opus, video must be MP4, and a real millisecond `duration` is required. Other formats can be sent as `file`. File reads are subject to host fs authorization (the plugin adds the fs permission), at most 10MiB per file. Media sending happens only through the AI tool; the workspace input still sends text/cards, and Webhook does not support media. Arbitrary paths in assistant output are never uploaded automatically — the tool must be called.

Acknowledgements must carry real `conversationId/runId`; events are correlated by stable runId only, and both early messages/end events and takeover renames are handled. Chunked replies all target the original message and keep its thread. The stop command is handled on a bypass path, tasks still downloading are cancelled before dispatch, and tasks awaiting acknowledgement call the host's abortRun once the acknowledgement arrives; a host run with no acknowledgement yet is never claimed to be aborted. Run errors, empty results and failed replies all attempt text feedback; when Feishu is entirely unavailable only an error is logged — there is no persistent retry queue.

## 0.3.2 Persistent sessions and web-page continuation

Same sender, chat and thread keep using the original session; once the host returns a stable `sessionId`, the plugin persists the app account fingerprint, scope, epoch and the original message/thread destination. When the web page continues that session on its own initiative, the final assistant candidate replies to the original message and keeps the thread; tool preambles are never concatenated into the final answer. The original request is correlated strictly by runId; unknown runIds and events carrying only `c1` never claim the route. An old host supports web-page continuation within the current load only when it provides both the full clientId and conversationId.

Resets such as `/new` revoke the current scope route and persist a new epoch; changing app credentials or platform revokes all old routes. Normal stop and plugin reload do not reset the session; they restore only the stable sessionId route, never unfinished runs or old answers. When a web task has no runId and abortRun cannot be called precisely, the command tells the user to stop from the web page instead of guessing the canonical conversationId. Sending keeps using the existing Feishu message reply API; failures keep the state error and attempt a text hint, with no persistent send retry queue. Route persistence failures surface the latest error too.

## Configuration

Click 「⚙ 配置」 (Config) at the top right of the workspace to open the settings panel:

| Field                         | Description                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Access mode / platform preset | Feishu China (`open.feishu.cn`) / Lark international (`open.larksuite.com`) / custom-bot Webhook only / custom private gateway |
| App ID (`cli_xxx`)            | Feishu Open Platform → Custom App → Credentials & Basic Info                                                                   |
| App Secret                    | Custom app secret (encrypted at rest, masked automatically when sent back to the frontend)                                     |
| Default chat ID               | Optional, e.g. `oc_xxx`; when empty the first group chat is used                                                               |
| Poll interval pollSec         | New-message check period in seconds, 60s by default (15s minimum)                                                              |
| Webhook address               | Feishu group-bot Webhook address (fill only this if you do not need a custom app — card push still works)                      |
| Webhook signing secret        | Optional, the custom bot's security signing secret (stored HMAC-SHA256 encrypted)                                              |

Secrets are stored first in the host's secure secret store (`host.secrets`, AES-256-GCM encrypted at rest).

## Install / uninstall / update

```bash
# ── install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu
pi-web-ui install plugins/feishu        # local directory, dev mode

# ── inspect ──
pi-web-ui plugins                        # list installed plugins and ids

# ── update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu --force
cp -r plugins/feishu ~/.pi-web/plugins/  # local dev: overwrite directly

# ── uninstall ──
pi-web-ui uninstall feishu
```

## Regression tests

- `tests/unit/feishu-session-routes.test.ts`: two scopes sharing c1 concurrently, web-page callbacks, duplicate/unknown events, reset, reload and account changes
- `tests/unit/feishu-runtime.test.ts`: commands, epoch, bypass stop, real media attachments, upload, stable runId and cross-group/thread isolation behaviour
- `tests/unit/feishu-features.test.ts`: pure-function unit tests (message parsing, card generation, Webhook HMAC signing, URL protection and format conversion)
- `tests/unit/feishu-secrets.test.ts`: encrypted persistence and masking of sensitive credentials
