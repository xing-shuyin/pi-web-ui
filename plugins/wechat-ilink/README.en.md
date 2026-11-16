**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# WeChat channel (wechat-ilink)

QR-code WeChat login, talking straight to the WeChat ilink backend (`https://ilinkai.weixin.qq.com`),
with the same protocol as Tencent's official [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)
(see its `docs/protocol_zh_CN.md`, MIT license).

## Why no public network is needed

No inbound callbacks, outbound only: log in by QR code to get `bot_token` → `getupdates` long polling
(35s) to receive messages → `sendmessage` to reply. It runs on a home LAN or a corporate intranet alike —
no open ports, no public IP.

## Getting started

1. Install the plugin, open the 💬 view in the top bar, click 「扫码登录」(Scan QR code), confirm in WeChat.
2. When someone sends a message: whitelisted senders (Settings → Allowed users, or `*` to allow everyone)
   run immediately; strangers are held as 「待配对」(Pending pairing) — approve or reject them in the view
   (a system notification is pushed as well).
3. Talk directly in WeChat; the agent replies with the result when the run finishes. Past `执行超时提醒`
   (execution-timeout reminder) it first replies "still running".

## v1 scope (honest version)

- ⚡ **Slash shortcuts**: a standalone `/` (or `/h`, `/help`) shows a simplified numbered menu, plus `/clear`, `/reset` or `/new [提示]` (clear context and start a brand-new conversation), `/status` (run state and metrics), `/cwd [路径]` (show or switch the project root), `/model [模型]` (show or switch the model), `/thinking [强度]` (set thinking strength), `/plan [on|off]` (plan mode), `/compact` (context compaction), `/stop` or `/abort` (abort the current task), `/reload` (reload extensions and skills), and plugin extension commands (e.g. `/todo`, `/note`, `/remind`); full-width Chinese `／` and numeric shortcuts are supported.
- Single account, full-duplex text messages.
- **Two-way images/files** (v0.5.0):
  - **Send**: the AI calls `wechat_send` with `image` (pictures) or `file` (other attachments, routed to image/video/file by extension);
    a local path (relative to the current workspace) or an `http(s)` URL both work; the chain is `getuploadurl` → AES-128-ECB encryption
    → CDN `POST` (reads `x-encrypted-param`) → `image_item`/`video_item`/`file_item` of `sendmessage`.
  - **Receive**: pictures/files/videos sent from WeChat are downloaded and decrypted with `image_item.aeskey` (hex) or `media.aes_key`,
    landing in `.pi-wechat-media/` in the workspace. Images enter the model as real image attachments through `imageData` / `mimeType`
    of `host.chat.attachments`; files and videos enter the host as `path` / `mode: reference` attachments. Requires a host version that
    supports this attachment contract.
  - Download limit is 25MB per file; images are 10MiB each, at most 8 of them, 20MiB total. Format or size-limit failures are reported
    to the user directly; when content cannot be read, it never claims to have understood it.
  - No speech recognition (ASR) is wired in; a voice message immediately gets a reply that audio cannot be heard and text should be sent
    instead, and that boundary is passed to the agent. Videos are delivered as file references — no promise of automatically
    understanding the picture or the sound.
- Private chats only: group chats and threads are ignored outright, and the old `respondGroups` setting no longer lets them through,
  so private-chat context is never merged across groups for the same user.
- Each paired WeChat user gets an isolated session keyed by ID; a persisted per-user sequence number feeds `accountId`, and `/new`, `/clear`, `/reset`, workspace (`/cwd`, `/workspace`), model and thinking-strength switches all increment it, so the host never reuses the previous round's context. Existing numeric shortcuts, full-width slashes and case variants use the same reset path. Those commands also detach the current WeChat user from web-session delivery — later messages keep using the new session, surviving a plugin reload; other users are unaffected. Host requests still outstanding before the reset are aborted instead of being claimed against the old run. Re-enable 「投递到网页当前会话」(Deliver to the current web conversation) in the WeChat plugin panel or settings to restore web synchronization.
- Media downloads run independently (at most 4) and never block a later `/stop`; after a stop or a new session, media that has not finished downloading does not restart the task. Abort prefers passing the stable `runId` (only when the old host's acknowledgement lacks that field does it fall back to the actual `conversationId`), so the run can still be located after a takeover; it waits for host confirmation and reports failures explicitly.
- **Runs started from WeChat are claimed by `runId`; continued chats on the web are routed back by stable `sessionId`**: sending a message proactively in the web view of the same WeChat session also delivers the assistant reply to the matching WeChat contact. The session binding is tied to the user's current session generation, so resets such as `/new` invalidate old bindings; shared viewing does not change execution ownership. If a takeover or a partial `c1` rename happened mid-run, the stable identity still locates the original contact — never guessing from a standalone local session ID. When the host has no `sessionId`, only the full `clientId + conversationId` is used; with no identity binding, or with ambiguous multiple-contact bindings, nothing is routed back automatically. If the host does not return a real `conversationId`, the execution failure is reported explicitly.
- Internal control markers (such as [[plan:...]], [[todo:...]], [[conv:...]], [[notify:...]]) are filtered out; only user-visible body text is sent to WeChat.
- Settings cover the default workspace (explicit cwd pin so a background start cannot drift into system32;
  system directories are rejected on Windows), model / thinking strength (both **dropdowns**: the model list holds models with configured
  auth, the thinking list holds SDK levels; empty = follow the global default), and 「投递到网页当前会话」
  (Deliver to the current web conversation) (on = WeChat commands steer into the conversation open in the browser, visible live on the web).
- Personal WeChat QR login goes through the official ilink backend — cleaner than a homebrew Hook, but automating a personal
  account still carries platform risk: start with a throwaway account, think twice with an important one. `bot_token` lives in the host's
  encrypted secrets (unreadable if the machine is copied).

## Files

- `index.mjs` server: ilink client + login/polling/pairing/replies + media CDN send/receive + the `wechat_send` tool
- `client/entry.mjs` view: status/QR login/pairing/inbox/manual send (text + media path or URL)
- `client/vendor/qrcode.js` QR encoder (kazuhikoarase/qrcode-generator 1.4.4, MIT,
  with just one ESM export line appended): the official `qrcode_img_content` is a JS redirect page, not an image,
  and what gets scanned is that URL itself, so the view generates the code locally (same as the official CLI's qrcode-terminal)
- Headless calls go through the host `host.chat` (`server/plugins.ts` + `AgentService.chatFromPlugin`),
  so it runs without a browser; results come back through `onRunEvent(run_end)`, correlated to the reply by conversationId.

## Slash shortcuts

Send slash commands straight in WeChat (English `/`, full-width Chinese `／` and numeric shortcuts `1/cwd` / `/1` are supported); the channel replies right away without spending AI model quota:

- **Quick help menu** (send `/`, `/h` or `/help`):
  ```text
  可直接发送 /序号（如 /1 或 /2 <提示>）快捷操作：
  1/cwd : 查看或切换当前项目根目录
  2/new : 清空上下文开启全新会话 [提示]
  3/status : 查看通道运行状态与指标
  4/model : 查看或切换当前模型 [名称]
  5/thinking : 设置思考强度 <off|low|high|max>
  6/plan : 开启或关闭计划模式 [on|off]
  7/compact : 压缩当前会话上下文 [说明]
  8/stop : 中止当前正在执行的任务
  9/reload : 重新加载扩展与配置
  10/help : 显示全部命令 (或发 /)
  11/note : 存一条笔记 <正文>（已安装插件命令自动展示）
  12/todo : 加一条待办 <内容>
  ...
  ```
- **Core commands supported**:
  - `1/cwd` or `/1` or `/cwd [路径]`: show or switch the project root (`/cwd default` restores the default)
  - `2/new` or `/2` or `/new [提示]`: clear context and start a new session (may carry the first prompt directly)
  - `3/status` or `/3` or `/status`: show channel status, account, model and message stats
  - `4/model` or `/4` or `/model [模型]`: show or switch the model (`/model default` restores the default)
  - `5/thinking` or `/5` or `/thinking [强度]`: set thinking strength (off/minimal/low/medium/high/xhigh/max)
  - `6/plan` or `/6` or `/plan [on|off]`: turn plan mode on or off (plan only, no modifications)
  - `7/compact` or `/7` or `/compact`: compact the current session context
  - `8/stop` or `/8` or `/stop`: abort the task currently running
  - `9/reload` or `/9` or `/reload`: reload system extensions and configuration
  - `10/help` or `/10` or `/h` or `/`: show help
- **Automatic push on successful pairing**: after an admin completes pairing in the web console, the channel automatically sends that WeChat user a short connection-success greeting plus a cheat sheet of the most-used commands.
- **Third-party plugin command passthrough**: commands registered by installed plugins (e.g. `/todo`, `/note`, `/remind`) are supported — send one in WeChat and it runs directly, echoing the plugin's result.
