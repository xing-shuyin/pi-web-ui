**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# WeCom Workbench and Bot (WeCom Plugin)

WeCom group bot webhook push, self-built app connection checks, and a `WecomBotBridge` adapters can call. Zero external dependencies.

## Current integration boundary

The WeCom group bot webhook is a send-only endpoint; a webhook key cannot be used to receive group messages. This plugin ships no deployed enterprise-app callback receiver, signature verification or encryption/decryption service, and no network entry that feeds external inbound messages into `WecomBotBridge.onInboundMessage`. The workbench's 「启动机器人」(Start bot) only enables the internal bridge listener and must not be read as an established WeCom inbound connection. Real two-way conversations need an additional trusted callback adapter that verifies the signature and decrypts the payload before calling the bridge.

Bridge sessions are isolated by enterprise/app account, reply webhook, room (chatId / ChatId / roomId), channelId, threadId, sender and a persistent epoch. Adapters must pass real destination identifiers and the correct reply webhook. The stable sessionId in the host acknowledgement binds the original destination; a `run_start` without runId that continues the same session from the web page creates a separate reply task, which on completion sends only the final assistant candidate body and does not concatenate tool-call preambles. Duplicate end events for a finished task are not sent again; an unknown runId cannot borrow the session route.

Routes, scope accounts and epochs are stored in plugin storage; destination webhooks are stored through host secrets, and route records contain no plaintext key. A plugin reload restores stable session routes and inbound sessions; legacy hosts are supported only via a full clientId + conversationId (memory only), and a bare c1 is not claimed. reset, model/directory setters and credential changes revoke old routes; a reload does not restore revoked epochs. When a web task has no exact runId, `/stop` explicitly reports that it cannot abort safely and does not guess a canonical ID. Replies reuse the webhook send path and error checks; a missing key for the original destination or a platform rejection is logged as an error and is not re-routed to the current default webhook.

## Bridge commands

- `/help`: help.
- `/new [prompt]`, `/clear [prompt]`, `/reset [prompt]`: immediately isolate old tasks and in-flight deliveries and use a new host account and session; when a prompt is supplied it is executed literally, e.g. `/reset /stop` treats `/stop` as the prompt. Best-effort abort of the old task; late acknowledgements and replies do not restore the old binding.
- `/status`: internal runtime status and message counters.
- `/stop`, `/abort`: abort the task in the current scope through the host; while a delivery has not returned it asks you to retry later.
- `/model [provider/id|default]`: view or set the model for the scope.
- `/thinking [off|minimal|low|medium|high|xhigh|default]`: view or set the thinking level.
- `/cwd [路径|default]`, `/workspace [路径|default]`: view or set the working directory; default restores the panel default, and on the next delivery the host validates the path and creates a new session.

Command names are case-insensitive and accept full-width letters and full-width slashes; only the command name is character-normalized, while prompts and paths keep their original glyphs and internal whitespace. default and thinking levels are case-insensitive. Model, thinking level and directory preferences live only in bridge memory and revert to the panel defaults after a plugin reload; scope identity, epoch and stable session routes persist. Plain duplicate tasks are rejected while busy; reset and valid model, thinking-level and directory setters isolate the old context immediately without waiting for the old task or delivery acknowledgement, while queries and invalid arguments do not reset. Actual availability of models and thinking levels is validated by the host at delivery time; saving a command does not mean the model has been verified as usable.

## Media support

The bridge accepts the platform-recognized text already present in `voice` messages as `Recognition`/`recognition` and marks the source explicitly; without recognized text it does not claim a transcription. Images, files, videos, raw voice and unknown types get an explicit reply that they cannot be downloaded or decoded, and media URLs are not treated as visual input. WeCom media_id download, media decryption and ASR are not implemented, so the content of these media cannot be read.

Outbound provides Markdown/text messages and chunking against a UTF-8 byte budget. Uploading images, voice, files and videos is not provided yet.

## Configuration

Group push: add a group bot to the WeCom group, copy the key from the webhook and paste it into the workbench. It only sends messages to that group.

Self-built app connection check: enter CorpID, the app AgentId and Secret. The secret is stored in host secrets; these credentials do not create a callback service or media-receiving capability on their own.
