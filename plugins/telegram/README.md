# Telegram

Telegram Bot API long polling integration. Configure a BotFather token in the plugin settings and enable the bot. Tokens are stored through the host secret store; `allowedUsers` accepts numeric Telegram sender IDs. Empty whitelist denies everyone by default; set `allowAllSenders: true` explicitly only for public bots. The bot requires outbound HTTPS; no public webhook is needed.

Private chats accept messages directly. In groups, mention `@yourbot`, use `/command@yourbot`, or reply to the bot. Commands addressed to other bots are ignored. Sessions, model, thinking and workspace preferences are isolated by chat ID, forum topic ID and sender ID. Replies retain the originating topic and message. Preferences are in memory and reset when the plugin restarts. Active runs are tracked by the host's stable `runId`, including events arriving before the chat receipt and conversation renames.

Stable host `sessionId` routes and conversation choices persist across plugin restarts, retaining the bot account, chat, topic, sender and reset epoch. Continuing that same session on the web sends its final assistant message back to the original Telegram destination once. Intermediate tool preambles are replaced by the last assistant candidate. Older hosts require the complete client ID and conversation ID; bare `c1` and unknown run IDs cannot claim a route. `/new` and account changes revoke old routes. Reload preserves routes without reviving reset sessions. A web run without a run ID can be detached from delivery, but cannot be precisely aborted; the command reports this limitation. Delivery and persistence failures appear in plugin status/logs.

Commands:

- `/help` (`/start`): list commands.
- `/new [prompt]`, `/clear [prompt]`, `/reset [prompt]`: invalidate this peer's active runs, downloads and queued messages immediately. An optional prompt starts in the new conversation. Stored history is not deleted; peer preferences remain. Commands accept case-insensitive ASCII/fullwidth spelling and an optional `@bot` suffix.
- `/status`: show this peer's conversation, running count and preferences.
- `/stop`, `/abort`: stop only this peer's active runs.
- `/model [provider/id]`: show available models or select one from the host model catalog.
- `/thinking [off|minimal|low|medium|high|xhigh]`: inspect or change thinking effort.
- `/cwd [absolute path]`, `/workspace [absolute path]`: inspect or change workspace. The directory must exist; filesystem roots, the home root and common system directories are rejected. The host applies its own additional workspace validation.

Preference changes require stopping active runs first and start a fresh conversation. Unknown slash commands return help and never reach the model. Dispatch, attachment download, validation and agent failures are reported in chat. Reply delivery failures are recorded in plugin status/logs.

Incoming photos, voice, audio, documents, videos, video notes and animations are downloaded from Telegram into private temporary files on the server (20 MiB per file). Photos and supported image documents use `host.chat({text, attachments:[{path:"",imageData:base64,mimeType,name}]})`; each image is limited to 10 MiB. The host enforces at most eight images and 20 MiB aggregate decoded image bytes per request. Other files use `{path:absoluteDownloadedPath,mode:"reference",name}`. The prompt includes the local path and instructs the agent to use `read` as needed. Temporary downloads are retained for conversation access and need periodic cleanup by the server operator. Unsupported message types produce explicit feedback.

The plugin does not itself transcribe audio or decode video. The agent is instructed to explicitly report decoding failures and ask for a transcript or supported still image when its available tools cannot decode the attachment. Image understanding depends on the selected model's capabilities. Telegram albums arrive as individual messages; this plugin does not combine albums into one request.

The `telegram` agent tool supports `action:"status"` or `action:"send"`. For text, provide `chat_id` and `text`. For media, provide `media` (local server path or HTTP(S) URL), optional `text` as caption, and `media_type`: `photo`, `document`, `audio`, `voice`, `video`, or `animation`. Optional `message_thread_id` targets a forum topic. The plugin reads/downloads the bytes and uploads multipart data to Telegram rather than sending a path as text. Uploads are limited to 20 MiB; Telegram may impose stricter format and method limits. URL downloads require server network access. Local paths refer to the server, not the Telegram user's device.

Example tool arguments:

```json
{ "action": "send", "chat_id": "123456", "media": "/srv/report.pdf", "media_type": "document", "text": "Report" }
```
