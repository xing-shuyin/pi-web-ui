**English** · [简体中文](./unattended-operation.md) · [繁體中文](./unattended-operation.zh-TW.md)

# Unattended Operation (Headless / Always-On)

For the "**must get work done without opening the Web UI**" case: server rooms, containers, Raspberry Pis,
systemd/launchd services with boot autostart, and phone-only usage where the user only sends QQ/WeChat
messages and never opens a web page.

## 1. The Problem Before

The host's execution sessions are "owned by the connection": `AgentService.clients: Map<clientId, ClientSession>`,
and a session exists only after a WebSocket attaches. Channel plugins (QQ/WeChat/Telegram…) parasitize by
having `host.chat()` forge a `plugin:<id>:<account>` pseudo-client (see `chatFromPlugin` in
`server/agent-service-daemon.ts`).

But the activation point for a plugin's server entry hangs off attach: `ensureLoaded()` in `server/plugins.ts`
is only called by the two attach flows in `server/index.ts` and by a manual `reload()`. So:

| Scenario                                            | Result                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Opened a page, then closed it                       | ✅ Keeps working (closing the WS only does `detach`, not `deactivate`)                                   |
| Never opened a page since a process/machine restart | ❌ Plugin never activates → the channel's long-lived connection is never established → all messages lost |
| `pi-web-ui server install` with boot autostart      | ❌ Same as above (`--no-browser` only disables auto-opening the browser, it does not change this)        |

## 2. The Current Mechanism

Two layers, both required:

### 2.1 `manifest.alwaysOn`: declare who stays always-on

```jsonc
{
	"id": "qq",
	"version": "0.2.1",
	"apiVersion": 2,
	"alwaysOn": true, // ← new: activate this plugin's index.mjs at host startup (with zero WS connections)
}
```

- Defaults to `false`: ordinary UI plugins stay lazily activated, avoiding the side effects of booting
  hundreds of plugins at startup (background timers, outbound connections).
- Only `alwaysOn: true` plugins activate during startup; the rest wait for the first client attach.
- Validation: `server/plugin-manifest-validate.ts` (a non-boolean value logs a warning and is treated as false).
- Parsing and the two scopes: `scan()` / `ensureLoaded(lang, { scope })` /
  `loadGeneration(..., scope)` in `server/plugins.ts`. The `all` and `alwaysOn` scopes each hold their own
  in-flight promise, so "startup only loads a subset" cannot swallow the catch-up logic for later attaches.
- Self-healing: `rescanAlwaysOn()` clears always-on plugins that failed to activate (`deactivateEntry` +
  clearing `attempted`) and then rescans.

Built-in plugins currently declared always-on: **qq, wechat-ilink, telegram, discord, slack, matrix, whatsapp,
imessage, feishu, dingtalk, wecom** (all 11 external messaging channels rely on outbound long-lived connections
to receive messages; without them there is never any work to do).

**How an installed copy gets the new manifest**: at the start of every `scan()`, `syncBuiltinPlugins()` in
`server/plugins.ts` compares the version of `plugins/<id>` inside the install package against
`<dataDir>/plugins/<id>`, and runs `ensureBackup` + overwrite when the source is newer.
User state (`storage.json` / `secrets.bin` / `schedules.json`) does not live in the code directory but in
`<dataDir>/plugin-data/<id>/`, so overwriting code can never touch configuration; a half-broken code directory
is repaired automatically from the materialization acknowledgement.
So when you declare `alwaysOn`, **bump the manifest version number** and old users pick it up after a restart,
with no manual reinstall.

### 2.2 `BackgroundExecutorRegistry`: who brings them up

`server/background-executors.ts`. Everyone (always-on plugins, built-in scheduled tasks, and later canvas workers /
device-task executors) implements the same contract, and **one** registry starts them, probes them, and
self-heals them by policy:

```ts
backgroundExecutors.register({
	id: "plugins:always-on",
	kind: "boot", // boot = run as soon as the process starts; on-demand = register only
	restart: "on-failure", // defaults to never: report only, do not repeatedly restart flapping external connections
	start: async () => {
		/* throw on failure: the registry catches it, records it in the snapshot, and neither affects other executors nor blocks listen */
	},
	health: () => ({ ok: true, detail: "…", stats: { … } }),
});
```

Startup happens in the `httpServer.listen()` callback (`server/index.ts`): `startAll()` → `startProbing()` (60s,
`unref`). Three hard rules:

1. **Never throw**: one bad executor cannot drag down the others or block port listening.
2. **Failure isolation + snapshot**: `snapshot()` exposes `state / lastError / restarts / health / healthCheckedAt`.
3. **Flap damping**: `restart` defaults to `never`; `on-failure` has a 5min cooldown (measured from **the last
   start time**) and a cap of 3 attempts, after which it only keeps reporting red in health.

Built-in scheduled tasks also changed from "call `scheduler.start()` directly at module top level" to registering
as a `kind: "boot"` executor, so their activation timing, failures and health snapshot match the plugins.

## 3. Observability: `/api/health`

```jsonc
{
	"ok": true, // stays always true: the page-picker extension uses it to detect "is this pi-web-ui"
	"piVersion": "0.118.0",
	"engine": "pi",
	"executors": [
		{
			"id": "plugins:always-on",
			"kind": "boot",
			"state": "running",
			"startedAt": 1762400000000,
			"restarts": 0,
			"health": { "ok": true, "detail": "11 alwaysOn plugin(s) active", "stats": { "active": 11, "total": 11 } },
		},
		{
			"id": "scheduler",
			"kind": "boot",
			"state": "running",
			"health": { "ok": true, "detail": "3 task(s), 2 enabled" },
		},
	],
	"unhealthy": [], // lists only boot-kind executors that are pending/failed/unhealthy; enough for ops scripts
}
```

Troubleshooting order (when QQ stops replying):

1. `curl /api/health` and check that `unhealthy` is empty and that `plugins:always-on`'s `stats.active` equals
   the total plugin count.
2. Search the logs for `[background]` / `[plugin:<id>] activate failed:`.
3. The plugin's own configuration (AppID/Secret, allowlist, `botEnabled`) is still a precondition: always-on only
   guarantees **that the entry point is called**, it does not fill in configuration for you. QQ's entry check is
   in `activate()` in `plugins/qq/index.mjs`.

## 4. Unattended Semantics (Phase B)

"Can be brought up" is not "can run to completion on its own". Phase B adds two things.

### 4.1 Questions and approvals no longer hang forever

An unattended session = a pseudo-client session: `plugin:<id>:<account>`, `scheduler:<id>`, `canvas*` (the single
source of truth for the decision is `isPseudoClientId` in `server/client-id-utils.ts`). Nobody watches the UI for
these sessions, so:

| Scenario            | Behavior                                                                                                                                          | Source of truth                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `ask_user_question` | Times out after `questionTimeoutSeconds` (default 240s, adjustable in the settings panel) and returns `{status:"timed_out"}`                      | `server/pending-question.ts` · `askUser()`          |
| Tool approval       | `unattendedApprovalTimeoutMs()` returns the timeout (default 120s, overridable via `PI_WEB_UNATTENDED_APPROVAL_TIMEOUT`, capped at 1h) → **deny** | `server/tool-approval.ts` · `requestToolApproval()` |

Two hard rules:

1. **A timeout always means "deny", never automatic approval** — approving a dangerous operation for you when
   nobody is there to click is an incident, not automation.
2. **Timeouts must be explainable**: the session emits a warning notice (the channel side sees this trace) and the
   audit log records `decisionSource: "unattended_timeout"`. If you want something to pass automatically, change
   the approval policy / allowlist, not the timeout.

Ordinary sessions (with a human watching) still never time out — this change only touched the unattended side.

### 4.2 Inbound messages switch to at-least-once delivery

`host.inbox` (`server/plugin-inbox.ts`) is a host-level persistent delivery ledger:

```js
const claim = host.inbox.claim(`msg:${eventType}:${data.id}`, { channelId });
if (claim.status !== "new") return; // done / in-flight / dead → do not process again
try {
	const r = await host.chat({ text });
	host.inbox.complete(key, { conversationId: r.conversationId, runId: r.runId });
} catch (err) {
	host.inbox.fail(key, err);
	throw err;
}
```

Semantics (covered by `tests/unit/plugin-inbox.test.ts`):

- Idempotency key: a second `claim` on the same key → `duplicate` (`reason: done | in-flight | dead`).
- At-least-once: a `claimed` entry stuck longer than `stallMs` (10min), or a `failed` entry below the cap
  (`maxAttempts` 3) → **redelivery allowed** (`attempts+1`). A process crash does not lose messages; worst case
  they are delivered twice.
- Bounded: `<dataDir>/plugin-inbox/<pluginId>.json`, at most 2000 entries / `done` kept for 7 days, atomic write
  - 300ms debounce.
- Debugging: `pending()` (stuck entries), `dead()` (dead letters beyond the cap).
- Wiring: the QQ plugin is already wired (replacing the in-memory 500-entry `seenMessageIds`, with automatic
  fallback on old hosts that lack `host.inbox`); the remaining channels follow the same pattern.

### 4.3 Outbound: failures have a ledger, backoff is classified, dead letters are observable

Inbound (`host.inbox`) and outbound (`host.delivery`) share **the same ledger** (`server/plugin-ledger.ts`,
`direction: "in" | "out"`), so "was this message actually delivered" has exactly one source of truth.

```js
host.delivery.register({ channel: "qq", send: (item) => this.sendRaw(item.target, item.payload) });
// try once immediately: success → sent / retryable failure → queued (the background pump continues) / non-retryable → throw
await host.delivery.send({ channel: "qq", key, target, payload, classify: classifyQqError });
```

Three hard rules (none of them live in the plugin):

1. **Fast path unchanged**: `send()` still attempts once immediately and `await`s. Only "retryable failure" moves
   to the background queue — a synchronous path is never silently turned into an asynchronous one.
2. **Handle by error class, not blind retries** (`DeliveryErrorClass`):
   `network` / `rate_limited` / `unknown` enter the backoff queue (default 5s → 30s → 2min → 10min);
   `expired` is handled by the plugin's internal degradation (QQ: switch to an active message); `rejected` /
   `auth` **dead-letter and throw immediately**, because retrying 100 times will not succeed — it only hits
   platform quotas faster.
3. **TTL safety net** (default 10 minutes): platforms have a passive-reply window, so resending a message past it
   is pointless; entries dead-letter when it expires.

Observability (`/api/health` → `executors[plugins:always-on].health.stats`):

```jsonc
{
	"outbox": { "qq": { "queued": 0, "due": 0, "dead": 0, "done": 12, "inboxDead": 0 } },
	"outboxQueued": 0,
	"deadLetters": 0,
}
```

> ⚠️ `/api/health` goes through `backgroundExecutors.snapshotLive()` (live refresh), not `snapshot()`.
> The latter returns **the cached result of the last 60s probe** — using it produces phantom failures where
> "the ledger already says done but health still says queued" (hit in 2026-11; the guard test is in `tests/unit/background-executors.test.ts`).

## 5. Not Done Yet

| Gap                                   | Description                                                                                                                                         | Direction                                                                                         |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| WeChat channel has no inbox           | Platform inbound messages have no stable message id; a synthesized key (peer + text) would wrongly drop "the same user sending the same text twice" | Wait for the platform's `message_id`, or switch to "process first, advance the cursor afterwards" |
| Outbox / delivery retry               | `complete/fail` only records state; outbound failures are not requeued automatically                                                                | Use `pending()` as a replay queue, or adopt the `workItems` lease semantics                       |
| Duplicate bookkeeping per channel     | Each plugin still keeps its own `sessionRoutes`/epoch                                                                                               | Consolidate into the host run ledger (`server/durable/`)                                          |
| Permission requests depend on a popup | `host.requestPermission` always returns `false` when no browser is present (both net and llm families)                                              | Pre-seeded grant file / launch arguments, or request again on the first attach                    |

The longer-term direction is to split "session" from `ClientSession` (owned by the connection) into an actor +
multi-sink subscriptions (the conversation is the actor; Web/QQ/push/desktop app are all subscribers), with the
Web UI degrading into a control plane. At that point the pseudo-client parasitism in `chatFromPlugin` can be
deleted entirely.
