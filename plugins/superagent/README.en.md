**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Built-in external channel module (Superagent 0.1.5)

Built-in channel adapter for GitHub / Feishu. It hands verified external events to the host work-item service, where the **group's standalone AI Router routes and a Bot executes**, then writes back to the original channel through the host's persistent outbox. The plugin ships no LLM, executor or router of its own.

Background write-back polls only channels that have both room mappings and send credentials configured: GitHub needs an API Token, Feishu needs an App ID and App Secret. Without them it stays idle and resumes polling on its own once the config is complete, no restart needed. A normal round waits 15 seconds after it finishes; a failed host outbox call backs off exponentially up to a 5 minute retry interval, warns once per round of sustained failure and logs once on recovery. Warnings contain only the HTTP status code where available and connection troubleshooting hints — never upstream responses or secrets.

The implementation was written independently; it copies no source from `dsh-superagent-prototype` and pulls in none of its dependencies.

## Built-in entry point and host requirements

Superagent ships with the pi-web-ui main program, is prepared and loaded automatically on first start, and needs no separate download or install command. Configuration lives under **设备连接与跨平台协作 → 外部渠道**(device connections and cross-platform collaboration → external channels); there is no separate Superagent entry in the top bar anymore. It starts in observe mode and receives events once channel credentials and room mappings are filled in.

This is a host built-in: it appears in no plugin marketplace, installed list, plugin menu, layout editor or enable/disable toggle, and cannot be managed through the regular plugin install / update / uninstall interfaces. Internally it reuses the plugin host's isolation and routing; the code upgrades with the main program while secrets and settings are preserved. Stale plugin-disable or uninstall records do not stop the built-in channels from loading; if module files are missing the host re-prepares them on the next scan. To pause automatic execution, set the channel to observe or remove its mappings.

The plugin directory holds `manifest.json`, `server.mjs`, `main.mjs`, `style.css`, plus `index.mjs` / `client/entry.mjs` to satisfy the host's fixed discovery rules. The client entry loads its page through the plugin's own asset route, so deployments under an app sub-path work. No extra npm dependencies.

The host must provide:

- `host.route(method, path, handler)`, with requests carrying the raw **Buffer** `req.rawBody` — it must not be rebuilt from parsed JSON; inbound limit 1 MiB.
- `host.storage.get/set` and encrypted `host.secrets.get/set/delete`. Config stores only whether a secret exists; plaintext secrets go to encrypted storage alone.
- `host.fetch` (or Node fetch) supporting standard Response; plugin tests inject fetch and never touch real channels.
- `host.workItems`, with the host isolating the plugin connector identity and requiring the `chat` permission; the API is in the table below.
- The host exposes exactly two routes ahead of main-site authentication, `POST /api/superagent/webhooks/github` and `POST /api/superagent/webhooks/feishu`, forwarding to the plugin's `/webhooks/github` / `/webhooks/feishu`. Those two entries accept channel verification only; config and management routes stay behind main-site authentication. If the host API is missing or the raw bytes are unavailable, ingestion is refused rather than degraded to unsigned.

| Host API                                        | Return value / contract                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `rooms()`                                       | `[{id,name?}]`, used to configure mappings                                                                                                      |
| `ingest(input)`                                 | Work item; the persistent dedup key is provider + eventId, the same ID with different content is rejected, a replay never escalates permissions |
| `list({roomId?})`                               | Array of work items                                                                                                                             |
| `get(id)`                                       | Work item or undefined                                                                                                                          |
| `update(id, patch)`                             | Updated work item; an explicit `authorized:true` means manual authorization, false means revocation                                             |
| `claimDelivery({provider,limit?})`              | Array of deliveries, claimed atomically with a lease attached                                                                                   |
| `completeDelivery(id,{leaseToken,externalId?})` | Lease confirmation                                                                                                                              |
| `failDelivery(id,{leaseToken,error})`           | Records the lease failure; the host owns backoff and the later re-claim                                                                         |

`ingest` input: `{provider,channelId,threadId,eventId,title,text,authorId,kind,roomId,mode,authorized}`. The adapter builds each of these fields one by one; authorization, room and execution config from the payload are never passed through. The work-item DTO has at least `id/provider/channelId/threadId/roomId/authorId/status/authorized/manualAuthorized`. `manualAuthorized` maps to the domain's `authorization.mode==='auto' && authorization.origin==='manual'`. delivery: `{id,leaseToken,workItemId,provider,channelId,threadId,text}`. The host owns retry timing, lease-expiry recovery and persistence.

## Page and permissions

In the Device Center's **外部渠道**(external channels) view you configure both channels' credentials, mode, author allowlists and room mappings, see the work-item list / full detail, and pause, resume, complete, manually authorize or revoke authorization. “重试到期回写”(Retry due write-backs) claims only queue items already due for retry by the host.

- Defaults to `observe`. An event carries automatic authorization only when the config saved on this machine is `auto`, the author is on the allowlist, the channel is mapped to a room and (for GitHub) the repository is on the allowlist too.
- GitHub authors are entered as **numeric user IDs**, not renameable logins; Feishu authors use `open_id`. Repository names are case-insensitive, every other identity matches exactly.
- One mapping per line, `owner/repo=roomId` or `chat_id=roomId`. An unknown channel returns `ignored` with a hint to set the mapping first, and creates no roomless work item. An unauthorized author on a mapped channel still creates an observe work item.
- Config changes, work-item management and manually triggered write-backs additionally check that the socket is loopback; when an Origin is present it must be same-origin with the Host. Reaching the page through a remote device can read the list, but changes need a local connection. This check relies on the real socket and never trusts forwarded IP headers.
- Secrets are never returned to the UI in plaintext. Each one offers “保留 / 替换 / 清空”(keep / replace / clear): keep is the default, replace requires a new value, clear must be chosen explicitly; after saving the inputs are blank again. Every change validates config and rooms before writing secrets.
- Write-back re-reads the work item first and re-checks authorization right before actually sending the message. The item must be `authorized`; automatic authorization must also pass the current config, author, repository and room-mapping checks; manual authorization alone can allow execution and write-back for that single item. `blocked` / `cancelled` forbid write-back, `completed` allows the final result to be sent. Revoking an item's authorization stops further sends; a message the channel already accepted cannot be recalled.

## GitHub

1. Save the Webhook Secret, GitHub API Token, repositories and room mappings on the page. The token needs issue / PR comment write permission and comment read permission on the target repositories.
2. Set the GitHub webhook Content type to `application/json`, put in the `/api/superagent/webhooks/github` URL shown on the page, and make the Secret match the page.
3. Subscribe to Issues, Issue comments, Pull requests, Pull request reviews, Pull request review comments.

Accepted actions:

| GitHub event                  | Action                                                               |
| ----------------------------- | -------------------------------------------------------------------- |
| `issues`                      | opened / edited / reopened / closed                                  |
| `issue_comment`               | created / edited                                                     |
| `pull_request`                | opened / edited / reopened / closed / synchronize / ready_for_review |
| `pull_request_review`         | submitted / edited                                                   |
| `pull_request_review_comment` | created / edited                                                     |

`X-Hub-Signature-256` is verified as HMAC-SHA256 over the raw bytes with a constant-time comparison. `X-GitHub-Delivery` is the event ID; `repository.full_name` the channel; `#number` the thread; `sender.id` the author. Bot events and content carrying this plugin's write-back marker never create work items. Write-backs for PR reviews and inline comments all go to the PR's regular conversation comments.

Write-back only talks to the fixed `https://api.github.com`, rejects redirects and never accepts an API URL supplied in the payload. Every reply carries a stable `<!-- pi-superagent:sha256(deliveryId) -->` marker. Before retrying it pages through to find the original comment and, if found, only confirms the host delivery. At most 2,000 comments are scanned; past that it stops sending and reports failure rather than miss an old marker and duplicate. A lost host acknowledgement or a plugin restart is still recoverable from the original channel marker.

## Feishu support scope

This version supports **signed plaintext or AES-encrypted callbacks**: URL challenge and v2 `im.message.receive_v1` user text events. It verifies the signature over the raw request bytes and the time window first, then decrypts in Feishu's official `IV || AES-256-CBC` format, then checks the Verification Token and App ID; a wrong key, ciphertext or token is rejected. Algorithm format follows the [official Feishu Node SDK](https://github.com/larksuite/node-sdk/blob/main/utils/aes-cipher.ts). Card callbacks, rich text, images and app-bot messages are not supported.

Configure the Verification Token, the Encrypt Key used for signatures and the App ID; outbound also needs the App Secret, the app must have the bot send-message permission and be inside the target group. The event subscription URL is the `/api/superagent/webhooks/feishu` shown on the page.

It checks the event token, `X-Lark-Signature = SHA256(timestamp + nonce + EncryptKey + rawBody)`, a five minute window and the App ID together. The challenge is checked for token and signature too. Messages identify identities via `sender.sender_id.open_id` / `chat_id` / `header.event_id` and are tied to `root_id || parent_id || message_id`. Replies only ever go to the original thread, and an external payload cannot name the recipient. Tenant tokens are cached in memory only and the cache is cleared once credentials are saved.

Each delivery is written back under a fixed UUID; the channel's dedup window for that UUID is finite, so the plugin does not treat it as a permanent idempotency guarantee:

- It persists the time of the first attempt before sending; once a message ID comes back it persists the acknowledgement first, then confirms the host lease. Even if the host acknowledgement is lost, a later retry can confirm that acknowledgement directly without resending.
- A network error without an acknowledgement may still have landed in the channel. It only retries automatically with the same UUID **within 45 minutes** of the first attempt, leaving margin inside the channel's one hour dedup window.
- With no acknowledgement past 45 minutes it stops sending automatically and marks the delivery with the error `manual reconciliation`: the user must check Feishu and handle it by hand. The plugin never wipes the attempt record and resends blindly.

## Plugin API

These paths are prefixed with `/plugins-api/superagent` and stay behind the host's main-site authentication:

| Method / path                                   | Purpose                                                                  |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /config`                                   | Config plus booleans for whether each secret exists                      |
| `PUT /config`                                   | `{config, secrets:{key:{action:'keep'                                    | 'set'    | 'clear',value?}}}` |
| `GET /rooms`                                    | Available group rooms                                                    |
| `GET /items?roomId=`                            | Work-item list                                                           |
| `GET /item?id=`                                 | Work-item detail                                                         |
| `POST /items/update`                            | `{id,action:'pause'                                                      | 'resume' | 'complete'         | 'authorize' | 'observe'}` |
| `POST /deliver`                                 | Claims due write-backs and returns this round's success / failure counts |
| `GET /assets/main.mjs`, `GET /assets/style.css` | Page assets                                                              |

On the page, pause maps to `blocked`, resume to `open`, complete to `completed`. Every update accepts only the fixed patch for its action, never arbitrary field edits. The background loop claims due outbox entries every 15 seconds, one per channel per pass, so claiming a batch and then waiting cannot let leases expire; uninstalling clears polling and routes. A single network request times out at 15 seconds and each delivery shares a 40 second network budget, leaving time to confirm inside the host's current 60 second lease; error records keep neither upstream responses nor secrets.

Inbound also keeps a persistent acknowledgement cache of the 4,096 most recent events for concurrency and restart dedup; **permanent dedup still takes the host work-item store as its source of truth**. GitHub signature verification has no freshness window of its own, so replay safety rests on the host's event uniqueness constraint.

## Verification

```sh
npx prettier --write plugins/superagent tests/unit/superagent-plugin.test.ts
npx vitest run tests/unit/superagent-plugin.test.ts
npm run typecheck
```

The tests call the real routes registered on a fake host and inject fetch; they open no port and never touch real GitHub / Feishu. Coverage: config keep / clear, page actions, signatures and raw bytes, identity and authorization, concurrent / restart replay, lease confirmation, retry on failure, revocation, write-back dedup, and refusing to send once Feishu's dedup window is exceeded.
