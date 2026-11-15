**English** · [简体中文](./CHANGELOG.md) · [繁體中文](./CHANGELOG.zh-TW.md)

# pi-tunnel CHANGELOG

## 1.5.0 (2026-10-24) Security fix: wsPort auth + device install chain corrections

### wsPort auth (ported from upstream 60daa53d)

- **security(/cli /status /pi-pkg)**: The WS aggregation port (:8765, all interfaces) previously had no auth — any host reachable on the same network could download CLI sources embedding the full token (impersonating a device / kicking out the real device / hijacking the SOCKS egress), read the device topology, or pull the agent offline package. All three endpoints now share a `?token=` check (`tnlAuthed`, 401 on mismatch). The host route channel (/plugins-api/tunnel/*) is protected by the panel's own auth and unchanged.
- **feat(snapshot)**: statusSnapshot now also emits the full `token` (only a trusted panel can obtain it); the panel uses it to assemble device install commands.

### Device install chain corrections (alongside the auth work)

- **fix(persistCmd)**: curl downloads of /cli and /pi-pkg on all three platforms now append `?token=` (otherwise devices cannot install after the upgrade).
- **fix(/pi-pkg missing on wsPort)**: persistCmd downloads pi-agent.tgz from wsPort, but the wsPort handler only had /cli and /status — devices would download plain text and tar unpacking would always fail. wsPort now has a /pi-pkg branch (same auth, streams a 404).

### Deployment note (breaking change)

- After upgrading to 1.5.0, re-running an old persistCmd (no token) returns 401; copy the new command from the 「网络隧道」(Network tunnel) page in the panel.

## 1.4.0 (2026-10-24) P3b polish

### persistCmd template fix (launchd %h confirmed)

- **fix(persistCmd)**: launchd does not expand the placeholder in the macOS plist `StandardOutPath` `%h/pi-tunnel-cli.log` → the log file cannot be created → spawn fails at once with `78 EX_CONFIG` (the final root cause of devices repeatedly reporting "works manually, launchd won't bring it up"). Changed to `$HOME/pi-tunnel-cli.log` (the heredoc expands it to an absolute path); %h stays legal and kept on Linux systemd

### Device-side CLI p15 (fix abandoned-connection hang)

- **fix(connectGuard)**: an undici WebSocket in the CONNECTING state does not fire onclose when close() is called, so once abandoned the reconnect chain dies (confirmed: device idle for 18min). After abandonment, re-check readyState 3s later; still 0 → exit(0) so launchd KeepAlive pulls it back up (a process-level restart is the only reliable reset)

### Multi-device routing fix

- **fix(mesh delivery routing)**: the p3a version delivered every message to `activeAgent()` (accidentally correct with one device, always wrong with several). Now it resolves the target device aid from the message's inbox directory (the target device agent name) → the registry `device` field and delivers there; if the target is offline the message stays queued until it comes online (`meshEnqueueFile` signature gains `nm`)

### Device-side session management

- **feat(CLI p14)**: `GET /session` (snapshot: sessionId/updatedAt/size, read-only) + `POST /session/reset` (deletes `~/.pi-tunnel-agent/session.json`, the next message starts a new session)
- **feat(server)**: `GET /mesh/session`, `POST /mesh/reset` (both accept `?agent=`/`agentName` to target a device, default the active device; audit `mesh.sessionReset`)
- **feat(panel)**: the Mesh card gains 「会话」(Session) (snapshot dialog) and 「重置会话」(Reset session) (calls reset after confirm) buttons

### Docs

- README rewritten up to the current capability surface (architecture diagram / capability matrix / three-level resolution / troubleshooting table / mesh usage), changelog filled in for 1.2.0/1.3.0/1.4.0

## 1.3.0 (2026-10-24) Phase 3a: pi_messenger mesh bridge

### Added

- **mesh bridge**: device agents join pi_messenger as `Remote<驼峰主机名>` (i.e. the host name in camel case) — a pure file bridge (registry/inbox watch/offline resend capped at 5/backlog queue), zero changes to pi-messenger; `GET/POST /mesh` toggle + a Mesh card in the panel
- **device-side persistent session**: `--session <uuid>` carries memory across messages (CLI p12→p14); the uplink `{t:'msg-res'}` returns to the initiator's inbox + wake

### Fixes (with root causes)

- **mesh resume**: `--resume` always pops the TUI session picker no matter which flags are combined (confirmed in pi dist/cli/args.js + main.js source); p11 misdiagnosed it as `-n` pollution. Switched to `--session <uuid>` (exact-id local match opens directly, zero interaction); cross-message memory verified in practice
- **TDZ race**: `meshEnabled` changed from a const arrow to a function declaration — the hello/offline hooks can fire during the startTunnel await, causing activate failed twice (the real culprit behind "works sometimes")
- **ver handshake sync**: the hardcoded `t:"ver"` handshake and assets/cli.mjs CLI_VER were missed in two rounds (p11/p12 stalled pushes); replaced with a `CLI_VER_PUBLISH` constant

### Conclusions

- **launchd KeepAlive self-healing confirmed** (verified during 1.3.0): owner closes the lid → opens it → reconnects automatically; the device-side plist `KeepAlive=true` was verified by remote read. The main cause of "always re-run" is Mac sleep (physics, not a fault); it self-heals 5-10s after wake, no re-run needed

## 1.2.0 (2026-10-24)

### Model channel rewrite (fixes two defects exposed in Phase 1)

- **fix(resolveModelEnv)**: retired the fake implementation that "regex-scanned all of client-state.json for the first `provider/model`" — what it matched was an arbitrary project entry in `projectModels` (e.g. WorkSpace's ark model), not the current session's model; client-state also has no reliable "current model" field, so that path is unfixable and was removed outright.
- **fix(standard provider gets no key)**: the old standard provider returned `{env:{}}`, passing only a model ID, so the device-side pi had no credentials and reported `No API key found`; the new version injects `OPENAI_BASE_URL` + `OPENAI_API_KEY` uniformly.
- **feat(three-level resolution)**: the new `resolveModelEnv(wantModel)` semantics are "pick a usable model channel for the device task":
  1. request-level override: `POST /device/task` with `model="provider/model[/…]"` resolves that provider exactly;
  2. panel manual modelEnv (the storage triple);
  3. automatically enumerate `models.json` providers ∩ `provider-keys.json`, openai-completions type only; an intranet gateway baseUrl (127.0.0.1/localhost) is translated to `lanIp` automatically and sorted first (devices on the same subnet connect directly, traffic never leaves the public network).
- **feat(REST)**: `GET /modelenv` (manual/resolved/candidates, key returns only the last 4 chars), `POST /modelenv` (save the manual triple / `{clear:true}` to restore auto).
- **feat(panel)**: the 「网络隧道」(Network tunnel) page gains a **model channel** card: effective state (source/model/key tail), manual triple editing (key not back-filled), restore auto, auto candidate display.
- **Boundary**: anthropic-messages type providers (minimax-cn/ark-anthropic) cannot be injected on the device side yet (the device CLI's `/task` only writes `OPENAI_*` back to the device-side models.json), a clear error is returned when selected; to be evaluated in a later version.
- Logging: `[tunnel] task → …` gains a `src=` field (override/manual/auto) for troubleshooting.

## 1.1.1 and earlier

See `git log -- plugins/tunnel/`.
