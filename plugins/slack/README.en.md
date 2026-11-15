**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Slack bot and workbench (Slack Plugin)

> Slack bot plugin, built on the Slack official Socket Mode outbound WebSocket long connection. Supports two-way conversation (zero public IP / no reverse proxy), structure-aware Markdown (mrkdwn) chunking, whitelist access control, and channel/thread message push. Zero external third-party package dependencies (Node built-in fetch + node:crypto + global WebSocket).

## Features

- 🤖 **Socket Mode outbound WebSocket duplex conversation**: built on Slack's official Socket Mode, the client initiates the long connection itself — **zero public IP, no domain, no reverse proxy, no inbound ports opened**, ready to use on a LAN or a personal machine!
- 📦 **Structure-aware Markdown chunking**: against Slack message length limits, uses a smart chunking algorithm similar to `dsh-im`, keeping code blocks (\`\`\`) auto-closed and syntax highlighting intact.
- ⚡ **Text commands**: supports `/help`, `/new`, `/clear` (alias `/reset`; all three reset commands accept a prompt and dispatch it as written after the reset), `/status`, `/stop` (alias `/abort`), `/model [provider/id|default]`, `/thinking [off|minimal|low|medium|high|xhigh|default]`, `/cwd [绝对路径]` (alias `/workspace`). Commands accept full-width slashes and mixed case; an unknown command returns help and does not reach the model.
- 🛡️ **Whitelist access control**: configure a whitelist of Slack User IDs allowed to converse; unauthorized users get a friendly refusal, so strangers cannot abuse the bot.
- 💬 **Thread conversation replies**: supports follow-up replies inside channel threads, keeping the channel UI tidy.
- 🛠️ **AI tool**: registers a `slack` tool with the AI assistant, so the AI can push messages and notifications to Slack channels on its own.

## Configuration guide

1. Open the [Slack API developer console](https://api.slack.com/apps) and create an app (Create New App → From scratch);
2. Go to「Socket Mode」, turn on **Enable Socket Mode**, and generate an **App-Level Token** carrying the `connections:write` scope (starts with `xapp-`);
3. Go to「OAuth & Permissions」and add scopes under **Bot Token Scopes**:
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `im:history`
4. Click「Install to Workspace」to install the app, and copy the generated **Bot User OAuth Token** (starts with `xoxb-`);
5. Go to「Event Subscriptions」, enable event subscriptions, and add `app_mention` and `message.im` under **Subscribe to bot events**;
6. In the Slack panel of pi-web-ui click「⚙️ 配置凭证」(Configure credentials), enter the Bot Token and App-Level Token, and check「启用 Slack Socket Mode 机器人双向对话服务」(Enable the Slack Socket Mode bot two-way conversation service)!

## Media and runtime boundaries

- Attachments in received messages are genuinely downloaded into `.channel-attachments/slack/` in the current workspace, requiring the plugin's `fs` permission and host file access authorization; a directory switch must be an authorized, existing absolute path.
- PNG/JPEG/GIF/WebP deliver real image data via `host.chat({text, attachments:[{path,imageData,mimeType,name}]})`, at most 8, 10 MiB each, 20 MiB of images total; whether images can be understood depends on the chosen model. Other files are delivered as local paths via `{path,mode:"reference",name}`. Unknown formats and unsupported image types get explicit notices.
- Audio/voice and video are sent and received as files; the plugin does not join realtime voice channels, record, or make video calls, and does not transcribe or decode automatically; the model needs working read, transcription, or decoding tools. Download or delivery failures reply with an error.
- The AI `slack` tool's `send` supports a local `file` path (images, voice files, plain files, video) and uploads real bytes through the platform; unified limit 20 MiB, and the platform or workspace may impose lower limits. Upload failure raises in the tool; reply delivery failure is recorded in lastError and notifies the browser.
- Commands are sent as ordinary messages; in channels you must @ the bot, while direct messages work as-is. No platform-native slash command is registered. Model/thinking settings take effect on the next message; the host validates invalid configurations and reports the failure. `default` restores the plugin's default configuration.
- Model, thinking effort, directory, and session mapping are isolated by user + channel + thread (a plain Slack DM shares that DM session); the session mapping, settings, and epoch persist in `sessionRoutes`, so the same scope's session continues after a plugin reload. A second task is rejected while running; `/stop` immediately cancels attachments still downloading and blocks further dispatch. `/new`, `/clear` (`/reset`), `/cwd` (`/workspace`), `/model`, and `/thinking` must stop and wait before changing settings; they change the account epoch so the daemon does not reuse the old session. A model or thinking-effort switch opens new context, a parameterless query keeps context, and creating a new one does not delete history.
- Web continuation requires first receiving a `run_start` without `runId`, then returning via the bound stable SDK `sessionId` to the original user, channel, and thread; the old host only accepts a complete `clientId + conversationId` and never claims by anonymous `c1`. Events carrying `runId` must match the channel acknowledgement exactly; an unknown ID never borrows the session route. Each round returns only the last assistant body candidate, without concatenating tool preambles, and duplicate end events are not sent twice.
- `/new`, `/reset`, and context settings changes revoke routes of the old epoch, switching bot credentials clears the old account binding, and a reload does not resurrect revoked routes. When a web run has no exact `runId`, `/stop` says to stop on the web instead of guessing the canonical conversationId. Sending still goes through the original Slack API; errors stay in lastError and notify the web page.
- Sending and receiving are tested against simulated API behavior, not verified end-to-end against the platform with real bot credentials.

Slack attachments also need the Bot Token scopes `files:read` and `files:write` (reinstall the app after changing scopes). Uploads use `files.getUploadURLExternal` + byte upload + `files.completeUploadExternal`; file messages in channels still need to @ the bot, and replies stay in the original thread. Private file downloads only accept `files.slack.com` and do not follow redirects.
