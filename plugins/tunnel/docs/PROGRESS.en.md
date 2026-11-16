**English** · [简体中文](./PROGRESS.md) · [繁體中文](./PROGRESS.zh-TW.md)

# pi-tunnel phase progress document

> Updated: 2026-10-24 11:00 · Status: Phase 1 ✅ / Phase 2 ✅ (v1.2.0) / Phase 3a ✅ (v1.3.0) / **Phase 3b ✅ acceptance fully passed (v1.4.0+CLI p15); the device-side launchd 78 fix waits for the owner to run xattr**
> This document is the source of truth for carrying work across sessions: read it first when taking over a new session.

## Architecture at a glance

- **mini** (172.16.120.11, running pi-web-ui) = the tunnel server; **laptop WDLMacBook-Pro.local** (user gxg) = the egress device, connecting in over a reverse WS
- Source repo `~/projects/pi-web-ui-upstream/plugins/tunnel/` (the source repo has an auto-commit watcher, so changes are committed automatically and no manual git is needed)
- Deploy location `~/.pi-web/plugins/tunnel/` (after changing the source repo you must cp it over; layout: index.mjs at the root / assets/cli.mjs / client/entry.mjs)
- Backups: `~/WorkSpace/pdd-backup/tunnel-plugin-pre-*` (full archive before every deployment)
- Route conventions: REST under `/plugins-api/tunnel/` (`?token=` auth); WS 8765; SOCKS5 1080 (127.0.0.1 only)
- Token source: `PI_WEB_TOKEN` in `~/.pi/secrets/com.xingshuyin.pi-web-ui.env`

## Delivered

### Phase 1 (SSH→SOCKS→control channel closed loop) ✅

- SSH approach abandoned (the laptop silently drops port 22 and remote login is off); use the WS control channel
- `POST /plugins-api/tunnel/device/task` → end-to-end PONG from the laptop's pi agent ✅ (model channel wildwork/glm-5.3, LAN baseUrl `http://172.16.120.11:7863/v1`)

### Phase 2 (v1.2.0, three-tier model channel resolution) ✅

- Fixes: ① the regex grabbed a non-session model (the first provider in client-state.json ≠ the session) ② the key of a standard OpenAI-compatible provider was not injected
- `resolveModelEnv(model?)` in three tiers: override (a panel task carrying model) → manual (the manual triple in storage.modelEnv) → auto (the session's models.json + provider-keys.json)
- New 「模型通道」(Model channel) card in the panel (read / set manually / restore auto); REST `/modelenv` (GET/POST/clear)
- Dynamic models.json on the device: `providers.tunnel` injected → `--model tunnel/<id>` (anthropic-messages providers are unsupported on the device, openai-completions only)
- Logs carry `src=auto/override/manual` for troubleshooting

### Phase 3a (pi_messenger file bridge) — all code done, acceptance in progress

Full design: [PHASE3-MESH-DESIGN.md](./PHASE3-MESH-DESIGN.en.md) (including the three-layer latency analysis)

Changed so far (source repo synced to the deploy location, version bumped to p10):

1. `assets/cli.mjs` (p10): `/task` accepts `mesh/msgId/from` → persistent session (`~/.pi-tunnel-agent/session.json` stores the sessionId, `--resume` continues the chat) → on completion uplinks over WS `{t:'msg-res',msgId,to,ok,text,ms,err}` (text is the assistant content of the last message_end)
2. `index.mjs`: mesh bridge module (MESH_DIR=`~/.pi/agent/messenger`) — `meshAgentName()` camel-cases (WDLMacBook-Pro.local→RemoteWDLMacBookPro), registry reads/writes (online/offline via the custom field `offline:true`), inbox watch (consumes only the device agent's own `<name>/*.json`, preventing loops), serial delivery (deviceCtrl /task; mesh uses the three-tier resolution's default channel, tools=read,grep, 10min timeout), replay on reconnect (max 5, older ones written back as skipped), GET/POST `/mesh` (storage `meshEnabled` toggle); the WS `msg-res` case writes the initiator's inbox (wake relies on the pi-messenger watcher, **zero changes to pi-messenger**)
3. `client/entry.mjs`: Mesh bridge card (toggle + status + queue)
4. Pitfall fix: calling `meshEnabled()` directly in startTunnel was a TDZ (the const arrow function is defined after the startup path) → deferred with setTimeout(0) until activate completes; activate failed is gone
5. Backup: `~/WorkSpace/pdd-backup/tunnel-plugin-pre-p3a-20261024-081351/`

## Acceptance results (all passed 2026-10-24, v1.3.0)

| Acceptance item                                                                                                                                              | Result                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Service activates without errors (activate failed=0 after the TDZ fix)                                                                                       | ✅                                                                  |
| registry auto-registers RemoteWDLMacBookPro + device CLI p12                                                                                                 | ✅                                                                  |
| First end-to-end mesh message (PONG back in the initiator's inbox + wake)                                                                                    | ✅                                                                  |
| `--session` persistent session remembers across messages (the device answers 「第 2 条，第 1 条是 mesh 验收」(message 2; message 1 was the mesh acceptance)) | ✅                                                                  |
| Stranded messages replayed after the TDZ period (3 .done)                                                                                                    | ✅                                                                  |
| launchd KeepAlive self-heals (a dead process is restarted automatically)                                                                                     | ✅ **the owner verified lid-close/reopen reconnects automatically** |

### Final verdict on "keep having to rerun" (2026-10-24)

1. ~~server-side TDZ~~ (fixed for good): the meshEnabled const TDZ race → activate failed → the WS endpoint disappeared
2. **Root cause = Mac sleep**: auto-sleep on battery → the process freezes → the WS drops (physics, not a fault); opening the lid, launchd KeepAlive brings it back and it reconnects — **the owner verified lid-close/reopen reconnects automatically; the self-healing chain is complete**
3. Every earlier "rerun" was really this: no wait for the 5-10s self-heal after wake before rerunning by hand (persistCmd is idempotent, harmless but pointless)

- The device-side plist was read remotely and verified: `KeepAlive=true` + `RunAtLoad=true` + every path expanded correctly (/Users/gxg/.local/bin/node)
- The persistCmd log path changed to `~/pi-tunnel-cli.log` (allowlisted, readable remotely; the plist on the device still holds the old /tmp value and only changes the next time the owner refreshes the panel and reruns)

### Correcting the resume misdiagnosis (p11→p12)

The p11 comment "`-n` pollutes resume" was a **misdiagnosis**: the actual args are `-ne` (no-extensions), which `indexOf('-n')` never matches; the pi source proves `--resume` always pops the TUI selector no matter which flags are combined. p12 switched to `--session <uuid>` (exact-id local match opens directly, zero interaction) — cross-message memory verified live.

### Wrap-up state

- manifest 1.3.0 + the CHANGELOG 1.3.0 entry are in; the git auto-commit watcher does the rest
- Outstanding: the panel's /device/task has no execution-command channel (the special:"full" field does not exist; the b9 summary recorded it wrong); the deviceCtrl device id increments per session (a1→a2…), so callers must take it dynamically from GET /status — a hardcoded one always hits 503

## Phase 3b (v1.4.0, 2026-10-24) — polish + multi-device routing fix

### Landed changes (source repo = deploy location, backup pdd-backup/tunnel-plugin-pre-p3b-20261024-095829)

1. **mesh delivery routes by target**: p3a sent everything to activeAgent() (accidentally right with a single device, always wrong with several); it now goes from the inbox directory (target device agent name) → registry.device lookup for the aid → targeted delivery, with an offline target held back for replay. `meshEnqueueFile(fp, nm)` signature changed; the registry device-name field is `device` (not deviceName)
2. **Device-side session management (CLI p14)**: `GET /session` snapshot (sessionId/updatedAt/size) + `POST /session/reset` (deletes session.json); server side `GET /mesh/session`, `POST /mesh/reset` (supports ?agent= and audits mesh.sessionReset); panel Mesh card 「会话/重置会话」(Session / Reset session) buttons
3. **README.md rewritten**: architecture diagram/capability matrix/three-tier resolution/troubleshooting table/mesh usage, changelog filled in for 1.2.0/1.3.0/1.4.0; CHANGELOG reordered (1.4.0→1.3.0→1.2.0→1.1.1)

### P3b acceptance (all passed 20261024)

- [x] Device online on p15 (persistCmd force-refresh + running the CLI in the foreground by hand to confirm the binary itself is fine)
- [x] GET /mesh/session snapshot (exists/sessionId/updatedAt/size)
- [x] POST /mesh/reset returns removed=the old sessionId, re-check shows exists:false
- [x] First mesh message after reset → the device replies 「PONG-p3b · 新会话已建立」(PONG-p3b · new session established) → the reply lands in the WildIce inbox
- [x] Single-device routing regression: identical to p3a behavior

### P3b incidents and verdicts

1. **The "device death loop" misdiagnosis**: 9 「mesh 桥已启动」(mesh bridge started) log lines were one per pi-web-ui restart, not device reconnects — establish which side a log line comes from before drawing conclusions
2. **connect discard hangs (fixed in CLI p15)**: undici WebSocket does not fire onclose when close() is called in CONNECTING state, so once connectGuard is discarded the reconnect chain dies (confirmed by 18min of device silence). Fix: re-check readyState 3s after discarding, exit(0) if still 0 and let launchd restart it
3. **launchd 78 EX_CONFIG verdict (%h placeholder)**: the persistCmd template plist had `StandardOutPath=%h/pi-tunnel-cli.log`, launchd does not expand %h → creating the log file fails → spawn fails with 78 ("runs by hand, launchd cannot start it"). Fix = template switched to `$HOME` (deployed); after the owner sed-ed the plist to an absolute path on the device it came up as an always-on service at 11:00:54. Evidence lesson: launchctl print's last exit code is the launch-layer exit code — check plist path expansion before the binary; quarantine/provenance is a red herring

## Key pitfalls cheat sheet

- `cp $S/assets/cli.mjs $D/` loses the assets level (the file lands in the deploy root) — you must `cp ... $D/assets/cli.mjs` and verify with diff
- kickstart restarting the service interrupts in-flight bash tool calls (the synthesized result says "may have executed") — send the restart command on its own
- `meshEnabled()` **must** be a hoisted function declaration: the hello/offline hooks can fire while startTunnel yields on an await (the const arrow TDZ race caused activate failed twice; fixed for good 20261024)
- pi CLI: `--resume` (the valueless form) always pops the TUI selector regardless of which flags are combined; continue a session across processes with `--session <uuid>` (proven in p12)
- The deviceCtrl device id increments per session (`a${nextAid++}`) and changes when the device process restarts — callers take it dynamically from GET /status; a hardcoded one always 503s
- A CLI self-update exits the process on purpose — launchd KeepAlive on the device has been proven to restart it (the owner's lid-close → lid-open test reconnected)
- /device/fs browse returns dirs only, no files; read files with POST /device/fsread (returns b64)
- Key files: device-side cfg `~/.pi-tunnel-cli.json`; session `~/.pi-tunnel-agent/`; the CLI process is kept always-on by the device's launchd
- The token env var lives in `~/.pi/secrets/com.xingshuyin.pi-web-ui.env` (32 characters)
