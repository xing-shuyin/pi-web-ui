**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# DingTalk robot and workbench

The enterprise robot receives messages through the DingTalk Stream gateway, so no public callback port is needed; it uses Node built-in WebSocket, fetch and crypto, with no sibling plugin dependencies. Custom group robot webhooks separately support text and Markdown notifications.

## Configuration

1. Create an enterprise internal app on the DingTalk open platform, enable the robot and Stream mode, and obtain the AppKey, AppSecret and robotCode.
2. Configure the robot's message, download, upload and send permissions; fill in the credentials and robot code in the plugin panel to enable two-way conversations. Secrets are stored through host secrets.
3. Staff ID allowlist, default working directory, model and thinking level are configurable. Once the allowlist is set, messages with no sender identity or with a sender not on the list are rejected.
4. Custom group notifications take a webhook URL and an optional signing secret. Custom webhooks have different permissions from the enterprise robot media APIs.

## Commands

| Command                                                       | Behavior                                                                                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/help`                                                       | Show commands and media limits                                                                    |
| `/new`, `/clear`, `/reset [prompt]`                           | Rotate the isolated account; the optional prompt runs immediately in the new context              |
| `/status`                                                     | Current real session, run ID, model, thinking level, directory and last error                     |
| `/stop`, `/abort`                                             | Call the host `abortRun` by the stable runId first; report failures explicitly                    |
| `/model [provider/id\|default]`                               | Query or set the model preference for the current channel conversation                            |
| `/thinking [off\|minimal\|low\|medium\|high\|xhigh\|default]` | Query or set the thinking level                                                                   |
| `/cwd [absolute path\|default]`                               | Query or set the working directory; the directory must exist, and switching enables a new context |

`/workspace` is a compatibility alias for `/cwd`. An unknown command only replies with the help hint and is not delivered to the model. Command names are case-insensitive and accept full-width letters and full-width slashes; `DEFAULT` and thinking levels are case-insensitive. All three reset aliases accept an optional prompt and keep its literal content; `/new /stop` passes `/stop` as model input. Model, thinking level and directory settings all rotate the isolated account and open a new context, invalidating operations already in flight; a late directory validation does not overwrite a later reset. A regular message before the current run finishes returns a wait hint and does not overwrite a run awaiting its reply. `/stop` is not queued behind media download or chat delivery: the stop request is acknowledged immediately; media preparation stops delivering once it completes, and if the host acknowledgement has not returned yet, the run is aborted by runId when it arrives. The download itself may still run to completion or to its 30-second timeout. Final availability of the model and directory is verified by the host on the next delivery; the plugin does not claim the switch already succeeded.

Sessions are isolated by robot account, enterprise, group/direct message, channel, thread and sender, and the scope's isolated account and reset generation are persisted. The stable `sessionId` returned by a newer host is used to store the reply route; a web-initiated `run_start` with no runId can establish this round's reply along that route and still land at the original destination. An older host only supports in-memory compatibility on an exact `clientId + conversationId` and never claims a bare `c1`. An unknown runId is never claimed through a sessionId; events before the acknowledgement are replayed only by the acknowledgement's exact runId. Each round replies once at the end, using the last assistant body candidate; an empty body or a tool call clears the preamble candidate, and tool execution preambles are not concatenated. A web task with no exact runId can only be stopped from the web page, with explicit feedback from the plugin; the plugin never guesses a conversationId to abort.

## Receiving media

Supports `picture`/`image`, rich-text image, `audio`/`voice`, `file` and `video` callbacks. The `downloadCode`/`pictureDownloadCode` in the message is used to call the enterprise robot download API and fetch the actual content:

- PNG/JPEG/GIF/WebP images are passed as `host.chat({text, attachments:[{path:"", imageData, mimeType, name}]})`; a download URL never substitutes for the image.
- Files, voice and video come in as `{path:"", fileData, mimeType, name}` attachments and are persisted by the host. A generic binary MIME is used for now and the callback filename is preserved.
- Each inbound media item (image, file, voice, video) is capped at 10MiB, up to 8 images per message, 20MiB of media in total, and up to 16 rich-text fragments per message. Downloads have size limits and timeouts.
- Voice and video keep the original file; this plugin provides no speech recognition, video frame extraction or audio/video decoding. That is stated explicitly on receipt, and actual understanding depends on the tools available to the model. Images get a format signature check, not full pixel decoding; a corrupt image with a valid signature can still make the host or model fail.
- Unsupported types such as location and card, a missing download code, authentication failure, missing permission, download failure and format check failure are all reported. Delivery is refused when there is no sessionWebhook, with the status error recorded.

Requires a newer host that supports `host.chat.attachments`. Image understanding also depends on an available vision model or the host vision bridge. The plugin offers no URL-text fallback for older hosts.

## Sending media

The `dingtalk` AI tool supports `action:"media"`; the UI message interface also accepts `type:"send_media", payload:{...}`. The panel has no separate media upload form today. Specify a local `path`, `mediaType` and exactly one recipient target, `openConversationId` (group) or `userId` (employee direct message):

| mediaType | Input and limits                                                                       |
| --------- | -------------------------------------------------------------------------------------- |
| `image`   | PNG/JPEG/GIF/WebP; upload the local file, then send a native image                     |
| `audio`   | AMR file plus `duration` in seconds; other formats must be converted or sent as a file |
| `file`    | Local file; filename and extension are preserved                                       |
| `video`   | MP4, `duration` in seconds and a `coverPath` image cover                               |

Each uploaded file is at most 20MiB; DingTalk's actual format, size, duration and permission limits may be stricter, and platform errors are reported as-is. A media_id is obtained through the upload API, then the enterprise robot group or direct-message send API is called; custom/session webhooks do not support arbitrary binary media. Attachments produced by the model are not forwarded automatically; call the media tool explicitly and name the recipient target.

All webhook and media requests check the HTTP status and the platform error code; a failed reply is recorded as the last error in `/status`. When the webhook has expired or the network is down, there is no guarantee the error itself can still reach the original conversation.

`/new`, `/clear` and `/reset` rotate the isolated account immediately and keep the model, thinking level and directory preferences; a reset works even while a download or host delivery is still outstanding. An old download, a delayed acknowledgement and task events do not rebind to the new session, and a known old task is asked to abort; a failed abort is reported explicitly. The plugin does not queue inbound messages, so the new session can take the next message immediately.

The Stream reconnects after a disconnect; stop/reload keeps the persistent scope, preferences, generation and stable sessionId route, does not reset the context and does not resume unfinished tasks. Reset, model/directory settings and a robot account change revoke the old route, and a reload does not resurrect an old generation. Message deduplication and the legacy host owner route live in memory only. A reply goes through the original sessionWebhook first; on failure, the enterprise robot send API is reused to the original destination only when the original callback carries an explicit group/direct type and an exact recipient target; a missing target, missing permission or platform rejection records the real error and never retargets to the configured group webhook. There is no integration-test evidence with real DingTalk credentials yet; automated tests cover gateway messages, HTTP requests, attachments, persistent routing and the host event contract, but permissions, media templates and duration fields still need validation in an enterprise environment.
