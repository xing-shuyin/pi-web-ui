**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# QQ Bot and workbench (QQBot Plugin)

> QQ bot plugin, built on the Tencent official open platform QQBot WebSocket outbound long connection. Supports two-way conversation (zero public IP / no reverse proxy), structure-aware Markdown chunking, whitelist access control, and channel/group message push. Basic text and media send/receive uses Node built-ins; automatic voice replies install the SILK encoder on demand.

## Features

- 🤖 **QQBot official WebSocket outbound long connection with duplex conversation**: built on the Tencent official open platform QQBot Gateway protocol, the client initiates the long connection itself — **zero public IP, no domain filing, no reverse proxy, no inbound ports opened**, ready to use on a LAN or a personal machine!
- 📦 **Structure-aware Markdown chunking**: against QQ message length limits, uses a smart chunking algorithm similar to `dsh-im`, keeping code blocks (\`\`\`) auto-closed and syntax highlighting intact.
- ⚡ **Slash shortcuts**: `/help`, `/clear` or `/new` (clear context and start a fresh conversation), `/status` (bot online metrics), `/abort` (same as `/stop`, `/8`; aborts the task at the current destination and says so explicitly on failure).
- 🛡️ **Whitelist access control**: configure whitelists of QQ OpenID / user IDs allowed to converse; unauthorized users get a friendly refusal, so strangers cannot abuse the bot.
- 💬 **Passive message replies and multi-target support**: QQ channel sub-channels (@bot), QQ group chats (@bot), and direct friend messages, automatically linking `msg_id` passive replies.
- 🛠️ **AI tool**: registers a `qq` tool with the AI assistant, so the AI can push messages and notifications to QQ channels on its own.
- 🖼️ **Rich media in both directions (image/voice/video/file)**:
  - **In**: attachments sent to QQ (the `attachments` in the event; Tencent CDN, with expiry) are downloaded into `.pi-qq-media/` in the workspace. PNG/JPEG/GIF/WebP images enter the model as `imageData` attachments (at most 8, 10MiB each, 20MiB total); other image formats get an explicit conversion notice. Files, audio, and video are passed to the host as path-reference attachments; the model is not promised to understand audio/video directly. Voice prefers downloading `voice_wav_url` (saved with a WAV name) and keeps the platform ASR text even when the download fails or persistence is off; without platform ASR the plugin states plainly that it does not transcribe and asks for text or a transcription tool. Single-item download limit is 25MiB; over-limit or failed downloads degrade to placeholder text (never swallow the message);
    「接收图片/文件落地」(Receive images/files to disk) is toggleable in settings.
  - **Out**: the `qq` tool adds `image` / `file` (local path or http(s) URL) and `user_openid` /
    `group_openid` targets. The chain = `POST /v2/{users|groups}/{openid}/files`
    (local files ≤ 5MB go as base64 `file_data`, larger ones go `upload_prepare` → chunked PUT →
    `upload_part_finish` → merge to get `file_info`) → `msg_type=7` + `media.file_info`.
    Above the soft limits (image 20MB / video 30MB / voice 20MB), QQ degrades the message to a file card.
  - **Channel restrictions**: QQ channel sub-channels only accept an `image` field carrying a **public http(s) URL**; local files have no
    upload path — either send via direct/group chat first, or provide a public link (the workbench reports an error directly).

Group chats and channels isolate sessions by "user + destination + thread (if the event provides one)"; direct chats isolate by user. `/new`, `/clear`, and `/cwd` switches bump that peer's session epoch and swap the host accountId at the same time, avoiding reuse of old context. Commands are handled before attachment downloads; `/stop` does not wait for media downloads. The real conversationId in the acknowledgement continues the conversation; the stable runId carries event ownership after takeover; pre-acknowledgement events replay only when they match that runId. Sending again while the same session is executing prompts the user to wait or abort. When a web page opens that QQ session and actively continues it, the final assistant reply is also returned to the corresponding direct chat, group, or channel; the return binding uses the stable SDK `sessionId` and validates the destination and current session epoch. After a reset such as `/new`, the old session no longer receives replies; the plugin does not guess the contact from a local `c1`. When several people are bound to the same web session the binding is ambiguous, so nothing is returned automatically. With `bindActive` explicitly enabled, the host's current session is used; a runtime already owning that session refuses to be overwritten.

For tasks started from the web with no channel run marker, QQ `/stop` says to stop on the web side instead of aborting by local session number. Outside QQ's passive reply window the plugin attempts a proactive send, actually bounded by platform permissions and quota; delivery failures show in the QQ panel status.

## Automatic voice replies

QQ workbench →「机器人凭证与高级设置」(Bot credentials and advanced settings) →「自动回复语音」(Automatic voice reply), choose「语音回复」(Voice reply) or「语音和文字」(Voice and text), then pick the engine, voice, and speaking rate and save. Text replies stay the default.

- `builtin` uses the server's system voice and needs no TTS plugin. Windows uses installed system voices, macOS uses `say`, and Linux needs `espeak-ng` / `espeak`.
- With a TTS plugin installed and enabled, `doubao-tts`, `deepseek-tts`, and their voices become selectable; engines that other plugins register with the unified TTS center also appear in the list. Credentials are configured in the plugin providing that engine.
- Final answers in direct chats, group chats, and bound web sessions support voice; channels, command acknowledgements, and progress notices stay text. Long replies read the opening aloud while keeping the full text; if voice generation, transcoding, or sending fails, the plugin falls back to the full text, and advanced settings show the reason.
- The first QQ voice synthesis installs `silk-wasm` on demand; compressed audio such as AAC installs `ffmpeg-static` on demand. System WAV only needs the SILK encoder.

Engine registration, system voices, API, and cancellation rules: see [`docs/architecture-tts.md`](../../docs/architecture-tts.en.md).

## Configuration guide

1. Open the [QQ open platform](https://q.qq.com/) and register/sign in to a developer account;
2. Open the「机器人」(Bots) admin console and create a bot application;
3. Get the bot's **AppID** and **ClientSecret**;
4. Configure the bot name, avatar, and permission list in the bot settings;
5. In the QQ panel of pi-web-ui click「⚙️ 配置凭证」(Configure credentials), fill in AppID and ClientSecret, and check「启用 QQ 机器人双向会话对话服务」(Enable the QQ bot two-way conversation service)!

## Connection troubleshooting

- **`Failed to obtain QQ Gateway URL: 接口调用超过频率限制 (100017)`**: `/gateway` is rate limited, almost always from a reconnect storm or multiple hosts contending, not from message volume.
  - One AppID allows a single Gateway long connection. The plugin writes a single-instance lock at `qq/bot-<appId>.lock` in the data directory: a second host (for example dev + production, or another `npm run dev`) only reports「已在另一个宿主进程连接」(already connected in another host process) and backs off, no longer opening a duplicate long connection; it takes over automatically once the holder stops.
  - Reconnects use exponential backoff (5s→10s→…→120s); on 100017 it waits at least 60s, and the `/gateway` URL and access_token are reused while valid, so reconnects do not fetch them again every time.
  - To force an immediate manual retry click「⚡ 启停服务」(Start/stop service), which resets the backoff and reconnects.
