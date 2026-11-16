**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Discord Bot and Workbench (Discord Plugin)

> A duplex conversation plugin over the official Discord Bot Gateway WebSocket outbound long connection, supporting two-way session conversation (zero public IP / no reverse proxy), structure-aware Markdown chunking, allowlist-based safe admission and message push. Zero external dependencies (Node built-in fetch + node:crypto + global WebSocket).

## Features

- 🤖 **Gateway WebSocket outbound long-connection duplex conversation**: built on the official Discord Gateway (v10) protocol, the client opens an outbound long connection — **zero public IP, no domain, no reverse proxy, no inbound ports to open** — ready to go on a LAN or a personal computer!
- 📦 **Structure-aware Markdown chunking**: for Discord's per-message cap of 2000 characters, it uses a smart chunking algorithm similar to `dsh-im` that keeps code blocks (\`\`\`) auto-closed and syntax highlighting unbroken.
- ⚡ **Text commands**: supports `/help`, `/new`, `/clear`, `/reset [prompt]`, `/status`, `/stop` (alias `/abort`), `/model [provider/id|default]`, `/thinking [off|minimal|low|medium|high|xhigh|default]`, `/cwd [absolute path]` (alias `/workspace`). Unknown commands return help and are never passed to the model.
- 🛡️ **Allowlist security control**: configure an allowlist of Discord User IDs allowed to converse; unauthorized users are turned away politely, keeping strangers from abusing the bot.
- 💬 **Persistent sessions and continuing on the web**: isolated per user and channel, with a Discord thread using its own channel ID. The same scope keeps using the same account and context, with stable sessionId routing persisted; when the web continues that session, replies still go to the original channel or thread.
- 🛠️ **AI tool**: registers a `discord` tool with the AI assistant, so the AI can push messages and notifications to Discord channels on its own.

## Setup Guide

1. Open the [Discord Developer Portal](https://discord.com/developers/applications);
2. Click "New Application" to create an application and enter an application name;
3. Go to the "Bot" tab and click "Add Bot" to generate the bot;
4. **Important**: on the Bot page, scroll down and enable "MESSAGE CONTENT INTENT" and "SERVER MEMBERS INTENT" under **Privileged Gateway Intents**;
5. Click "Reset Token" and copy the generated `Bot Token`;
6. Under "OAuth2" → "URL Generator", check the `bot` scope and grant `Send Messages` and `Read Messages/View Channels`, then copy the generated link to invite the bot to your server;
7. In the Discord panel of pi-web-ui, click 「配置凭证」(Configure credentials), fill in the Bot Token and check 「启用 Discord 机器人双向对话服务」(Enable two-way Discord bot conversation service) — done!

## Media and Runtime Boundaries

- Attachments in received messages are actually downloaded into `.channel-attachments/discord/` in the current workspace, which needs the plugin `fs` permission and host file access authorization; a directory switch must be an authorized, existing absolute path.
- PNG/JPEG/GIF/WebP are delivered as real image data through `host.chat({text, attachments:[{path,imageData,mimeType,name}]})`, at most 8 images, 10 MiB each and 20 MiB total for images; whether the images are understood depends on the chosen model. Other files are delivered as local paths via `{path,mode:"reference",name}`. Unknown formats and unsupported image types get an explicit notice.
- Audio/voice and video are sent and received as files; there is no real-time voice channel, recording or video call integration and no automatic transcription or decoding; the model needs a working read, transcription or decoding tool. Download or delivery failures are answered with an error.
- The `send` action of the AI `discord` tool accepts a `file` local path (image, voice file, regular file, video) and uploads the real bytes through the platform; the uniform cap is 20 MiB, and the platform or workspace may impose a lower limit. Upload failures throw from the tool; reply delivery failures are recorded in lastError and surfaced to the browser.
- Commands go out as ordinary messages; in channels you must @ the bot, while direct messages can be sent directly. No platform-native slash command is registered. Model/thinking settings take effect on the next message, and the host validates invalid configuration and reports the failure. `default` restores the plugin's default configuration.
- Model, thinking strength, directory, account epoch and stable sessionId routing are isolated per user + channel + thread and persisted, restored after a plugin reload; transient output of a running task is not restored. A second task is refused while one is running; `/stop` immediately cancels in-flight attachment downloads and blocks further dispatch. `/new`, `/clear` and `/reset` immediately cancel the old task or attachment downloads and open a blank session, and a prompt appended to the command runs right away; command names accept any case and full-width forms, while prompts and paths keep their original text. `/cwd` and `/workspace` validate the directory and then likewise open a new session; querying the directory does not reset, and a failed validation keeps the old session. Late acknowledgements and end events from the old task never overwrite the new session or clear its busy state. Reset preserves model, thinking strength and directory settings. `/model` and `/thinking` still require stopping and waiting first, and every successful setting opens a new context; `default` and thinking strength values ignore case, while model identifiers keep their original form. All the switches above rotate the account epoch so the daemon never reuses an old session, and history is preserved.
- When a runId exists, only an exact match against a claimed run is allowed; an unknown runId never borrows a session route. Events from the web without a runId require the run to be established first by a `run_start` with the same sessionId; the end is sent only once and only the last assistant body candidate is sent, without splicing in tool-call preambles. Complete clientId + conversationId pairs from old hosts remain compatible on the current instance; anonymous `c1` is never claimed.
- `/new`, `/clear`, `/reset` and directory or model setting changes revoke the old epoch's routes; changing the Bot Token revokes all old account routes. When a web run has no stable runId, `/stop` explicitly tells the user to stop it in the web UI and never guesses `c1` as the abort target. Persistence or send failures report an error; replies keep going out through the existing Bot API with chunked sends, and no extra webhook channel is established.
- Send and receive are tested against a simulated API; platform end-to-end has not been verified with real bot credentials.

Sending Discord files also needs the `Attach Files` permission; attachment downloads accept only HTTPS URLs on the official `cdn.discordapp.com` / `media.discordapp.net` and do not follow redirects; audio and video are sent as attachments, and voice files are never disguised as native voice messages.
