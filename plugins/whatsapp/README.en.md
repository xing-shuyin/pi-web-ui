**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# WhatsApp Bot and Workbench

Built on the Meta WhatsApp Business Cloud API (Graph API v20.0) with no third-party runtime dependencies. Plugin version **0.2.5**.

## Commands and Sessions

Supports `/help`, `/new [prompt]`, `/clear [prompt]`, `/reset [prompt]`, `/status`, `/stop` (alias `/abort`), `/model [provider/id|default]`, `/thinking [off|minimal|low|medium|high|xhigh|default]`, `/cwd [absolute path]` (alias `/workspace`). Unknown slash commands get a direct hint and are never passed to the model.

The host validates model and thinking parameters on the next delivery; command replies never pretend the model has switched. The directory must exist and carry host file authorization; switching directories creates a new session. Command names accept any case and full-width characters (including the full-width slash); arguments keep their original text. When `/new`, `/clear` or `/reset` carries a prompt, that prompt runs in the new session, and a prompt starting with `/` is still sent as message body. The model, thinking strength and directory setters all reset context; `DEFAULT` restores the default, and thinking strength accepts any case.

`/new`, `/clear` and `/reset` immediately invalidate the old queue, downloads and in-flight deliveries, unbind the old session and rotate the standalone account, preserving model, thinking strength and directory preferences while requesting abort of the old run. Late acknowledgements also request an abort, and old events never restore the binding; abort failures are reported explicitly. `/stop` calls the real `host.abortRun(runId || conversationId)`, preferring the stable run ID so it still aborts accurately after a takeover or conversation rename. Acknowledgements that arrive late after a delivery is cancelled likewise prefer their `runId` for the abort.

Sessions isolate accounts by channel origin. It uses the real `conversationId` and stable `runId` from the `await host.chat()` acknowledgement, supporting messages and end events that arrive before the acknowledgement, plus session takeover and rename. A missing stable run ID is reported explicitly as an error. Send failures are logged, recorded in state and surfaced to the workbench; delivery failures, aborts, model errors and timeouts all produce feedback.

## Media

- Inbound images: look up the Meta media ID and download the real binary, then hand it to the host as `attachments: [{path:"", imageData:base64, mimeType, name}]`; URLs or file names are never treated as images. PNG/JPEG/WebP/GIF are supported; other types are told explicitly that they cannot be decoded.
- Inbound audio, files and video: handed to the host for persistence as `attachments: [{path:"", fileData:base64, mimeType, name}]`. For audio and video it states plainly that the plugin has no automatic transcription or video decoding; the attachment serves as a file reference, and further parsing depends on the model and its tools.
- Every inbound attachment (image, audio, file, video) is capped at 10 MiB each; the cap is checked against metadata, Content-Length and the actual download stream. Meta carries only one media object per inbound message and the plugin sends at most one attachment per model request, so the host constraint of at most 8 images, 10 MiB per attachment and 20 MiB total holds.
- The workbench can send by picking an image/audio/file/video type and entering a workspace file path plus MIME type; the `whatsapp` AI tool's `send_media` likewise supports uploading a workspace file or reusing an existing Meta `media_id`. The `send` tool keeps sending text.
- Outbound media is uploaded via multipart and then sent by media ID, up to 20 MiB; the concrete MIME, encoding and account capabilities are further limited by the Meta API, and failures are reported. Voice goes out as audio media, with no extra promise of a voice bubble or speech synthesis.

## Configuration and Access

Enable WhatsApp Business on the Meta developer platform and configure the Phone Number ID plus an Access Token with the `whatsapp_business_messaging` permission. Test, save and start the bot in the plugin panel. The token lives in host secrets, and file access is governed by host fs permissions.

The plugin's inbound entrypoint is `POST /plugins-api/whatsapp/inbox` (deployments behind a reverse-proxy subpath need the host prefix), accepting the Meta webhook `entry[].changes[].value.messages[]` JSON. The entrypoint is authenticated by the host `PI_WEB_TOKEN`; it returns 503 while the bot is disabled. Run a trusted webhook relay that verifies the Meta signature and then forwards the JSON with host auth attached. This plugin has no public direct-webhook GET challenge and no Meta signature verification, so an unauthenticated public callback cannot be treated as trusted input.

## Capability Boundaries

- The Cloud API currently supports only business-number-to-user private chat. Group/thread messages are not passed to the model and group replies are not downgraded into private chat; the restriction is recorded in state and logs. Group chat support is not promised.
- Model switching, headless chat and real attachments require a recent pi host; an acknowledgement missing `conversationId/runId` makes the plugin refuse an unsafe association. Do not fall back to URL text to send images on an old host.
- Audio and video have no built-in transcription, video frame decoding or synthesis service. Undecodable media must be stated as such; media content must never be fabricated.
- The Meta 24-hour service window, template message requirements, recipient number eligibility, media encoding support and network reachability are all managed by Meta; no zero-ban or unlimited-sending guarantee.
- The same origin keeps reusing its session; destination, standalone account, stable sessionId and reset epoch are persisted through host storage and restored after a plugin reload. When the web UI continues the conversation itself, the final assistant body still goes back to the original recipient; tool preambles are not spliced into the final reply and duplicate end events are sent only once. Old hosts accept only a complete clientId + conversationId, never claiming by anonymous c1.
- `/new` or a change of business account/token revokes the old routes; old events cannot restore the old epoch. When a web run has no runId, the plugin can only drop the reply binding and reports explicitly that a precise abort is impossible, without guessing a canonical conversationId. In-flight text and webhook dedup state still live only in memory, and a reload never resends a finished run. Messages past the Meta service window are still sent through the original Cloud API with the error recorded explicitly, and paid templates are never sent automatically.

Verification: `npx vitest run tests/unit/whatsapp-features.test.ts tests/unit/whatsapp-behavior.test.ts tests/unit/whatsapp-session-routes.test.ts`.
