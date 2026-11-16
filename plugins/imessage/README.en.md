**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# iMessage

Sends text plus local images, voice, files and videos through macOS Messages, and receives messages by read-only polling of `~/Library/Messages/chat.db`. No public ingress required.

## Requirements

macOS only, and Messages must be signed in to an Apple ID. The terminal or app running pi-web-ui needs 「完整磁盘访问权限」(Full Disk Access) to read chat.db and 「自动化 → Messages」(Automation → Messages) to send messages. The system must provide `/usr/bin/sqlite3` and `/usr/bin/osascript`. When these conditions are not met it shows an error or unsupported and cannot pretend to be online on Windows/Linux.

At startup the latest database record becomes the cursor; only messages arriving afterwards are received, with one read-only query every two seconds. Messages from downtime are not replayed. Apple provides no public Messages receive API, and the database schema and AppleScript behavior may change with system updates; this implementation is not an official Apple bot API. A rich-text message that carries only attributedBody and no text gets an explicit prompt to resend it as plain text.

## Commands

Supports `/help`, `/new [prompt]`, `/clear [prompt]`, `/reset [prompt]`, `/status`, `/stop` (`/abort`), `/model [provider/id|default]`, `/thinking [off|minimal|low|medium|high|xhigh|default]`, `/cwd [目录|default]`. `/workspace` is a compatibility alias for the directory command. Command tokens accept any case, full-width letters and full-width slashes; `default` and thinking levels ignore case. Unknown commands and invalid arguments are reported back directly and never sent to the model.

`/new`, `/clear` and `/reset` create a new context without deleting history; when a prompt is attached, its literal body is executed in the new session at once, keeping newlines and spaces, so a body such as `/stop` is not parsed as a command again. Setting the model, thinking level or directory also rotates the account and unbinds the old session, and `default` restores the configured default. A setter command without arguments only queries the current value. Control commands are handled immediately, invalidating preparation requests not yet started, queued messages and late start acknowledgements from before the reset; a late async directory validation cannot override a later reset. Reset and the model/thinking setters also unbind the old task immediately while a task is running and request a stop; a failed stop is reported explicitly, and old task replies are no longer associated with the new session. `/cwd` and `/workspace` must stop a started running task and wait for it to finish before switching. Model, thinking level and working directory are isolated per sender and per group chat/thread; a host rejection of the model or directory is reported as a start failure. Session association uses the host's real conversationId and a stable runId, supporting end events that arrive before the chat acknowledgement as well as session takeover.

## Media

Incoming PNG/JPEG/GIF/WebP is passed to the host as real `attachments.imageData`: at most 8 images, 10 MiB each, 20 MiB total. Unknown or unsupported images such as HEIC get an explicit reply and are not passed off as understood.

Audio, video, text and common application files enter the host as reference attachments with an absolute local path. Audio and video carry the note 「是否可转录/理解取决于模型与工具」(whether they can be transcribed or understood depends on the model and tools); the plugin has no built-in ASR or video decoder. A failed attachment read replies with an error.

The AI `imessage` tool and the plugin's `send_message` interface support a local `file` path and can send it together with `text`. Messages decides the exact format, compression and size limits; AppleScript success only means the system accepted the send request, not that the recipient has received or read it. Files produced by the assistant are not sent automatically — call the tool explicitly. Group replies target the original chat GUID so they cannot be misfiled as a direct message; Apple Messages offers no thread-targeted send API usable by this bridge, so sessions in different threads of the same group stay isolated while replies land in the original group.

## Continued session callback

The host acknowledgement for an inbound message binds a stable `sessionId` to the original iMessage group/thread/sender route and persists it. When the web page continues that session, only a `run_start` without `runId` can create a separate pending reply; the final assistant message replaces earlier text and `run_end` replies only once. Events carrying a `runId` match only that exact run, and an unknown run never borrows the session route.

Legacy hosts support memory routing only when both `clientId` and `conversationId` are provided; a bare number such as `c1` does not constitute an identity. Legacy host routes are not restored across plugin reloads. `/reset`, `/new`, `/clear` and model/directory switches revoke old routes and persist the session generation, so a revoked old session is not restored after a reload. Account or default-recipient changes invalidate old routes. `/stop` keeps the web page able to continue later; when a web run has no exact `runId`, the bot asks you to stop it on the web page and does not guess the abort target.

## Verification scope

Commands, early events, runId ownership, cross-group/thread, image attachments, file references, AppleScript sending, polling and error feedback all have mocked-behavior tests. Real macOS end-to-end verification still needs a machine with an Apple ID and the permissions above.
