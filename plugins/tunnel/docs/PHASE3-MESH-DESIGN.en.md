**English** · [简体中文](./PHASE3-MESH-DESIGN.md) · [繁體中文](./PHASE3-MESH-DESIGN.zh-TW.md)

# pi-tunnel Phase 3 design: real mesh integration for pi_messenger

> Status: **design draft awaiting sign-off** (design first, then build, 2026-10-24)
> Prerequisites: Phase 1 (/device/task zero-code path) ✅, Phase 2 (v1.2.0 three-tier model channel resolution) ✅

---

## 1. Goal and current gap

**Goal**: the pi agent on the laptop becomes a full member of the pi_messenger mesh on the mini side — addressable with `@`, receives DMs, has persistent memory, has presence — instead of the one-shot, memoryless executor that `/device/task` is today.

**Current gap** (after Phase 2):

| Capability   | Phase 2 current state                       | Mesh requirement                                                  |
| ------------ | ------------------------------------------- | ----------------------------------------------------------------- |
| Reachability | manual POST /device/task from panel/REST    | any pi session on the mini reaches it via `pi_messenger send`     |
| Memory       | `--no-session`, a bare process every time   | persistent session, `--resume` continues the conversation         |
| presence     | devices list (panel-private)                | registry entry, visible to `list`, status queryable               |
| Reply        | returned synchronously in the HTTP response | posted asynchronously into the initiator's inbox + automatic wake |

## 2. Core insight (why this approach holds)

pi_messenger is a **pure file-based mesh, no daemon** (README "How It Works"):

- Registry: `~/.pi/agent/messenger/registry/<Name>.json` (name/pid/sessionId/model/activity…)
- Messages: `inbox/<recipient>/<ts>-<rand>.json`, format `{id, from, to, text, timestamp, replyTo}`
- wake: the pi-messenger extension inside each pi session **fs.watches its own inbox** (50ms debounce) → `pi.sendMessage(deliverAs:"steer", triggerTurn:true)` wakes it immediately

**Corollary**: as long as the mini side has a "bridge" that reads and writes these two directories on behalf of the device agent, the wake mechanism comes **free with zero changes** — the bridge writes the reply into the initiator's inbox (some pi session on the mini) and the initiator's pi-messenger watcher triggers steer on its own.

**Latency analysis (three layers, added 20261024)**:

1. **The transport chain is real time** (sub-second, no polling): send writes the inbox → bridge fs.watch (50ms debounce) → WS ctrl pushes to the device; the device finishes → WS uplink → bridge writes back into the initiator's inbox → the initiator's watcher picks it up within 50ms → steer wake. No polling interval anywhere in the chain; latency in the millisecond range.
2. **Device-side LLM execution time is not waived**: pi has to think and call tools for the task (seconds to minutes). The mesh is asynchronous — unlike Phase 2's `/device/task` HTTP call that waits synchronously (12~67s), the initiator can move on to other work the moment the message is sent.
3. **Replies queue instead of getting lost while the initiator is busy**: pi's steer does not interrupt an in-flight turn — when busy, the reply is consumed at the next turn boundary; if the initiator has exited, it stays in the inbox and is read on the next start. The bridge delivers and forgets; the inbox file is the persistence.

## 3. Architecture

```
mini (172.16.120.11)                                    laptop (172.16.120.118)
┌────────────────────────────────────────────┐      WS(8765)      ┌──────────────────────────┐
│ mini pi session A                          │                    │ tunnel CLI (launchd)     │
│ └ pi-messenger extension                   │                    │ └ ctrl handler           │
│   ↕ inbox/<A>/ watch                       │                    │   ↕ spawn                │
│ bridge (in tunnel plugin, with server)     │    ←ctrl-req──     │ pi --resume <sid>        │
│ · watch inbox/<Remote*>/                   │     ──msg-res→     │  --mode json             │
│ · write/refresh registry                   │ (new uplink type)  │ persisted sessionId      │
└────────────────────────────────────────────┘                    └──────────────────────────┘
```

**Message flow (A sends a DM to the device agent)**:

1. A: `pi_messenger {action:"send", to:"RemoteMbp", message:"…"}` → pi-messenger writes `inbox/RemoteMbp/…json`
2. Bridge sees the new message → deviceCtrl(ctrl-req `/task` with `sessionId:resume`, `text`)
3. Device CLI: `pi --resume <sid> -p <text> --mode json` → streams and collects the final assistant text
4. CLI uplinks over WS `{type:"msg-res", msgId, from:"RemoteMbp", text, to:<original initiator>, ok}` (**new message type**; the CLI can uplink on its own right after hello)
5. Bridge receives it → writes `inbox/<initiator>/…json` (from=RemoteMbp, replyTo=original msgId) → the initiator's pi-messenger wakes automatically ✅
6. Bridge updates registry activity + audit ring

**Key point: zero changes to pi-messenger source.**

## 4. Change list

| #   | Location                                            | Change                                                                                                                           | Size          |
| --- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| 1   | tunnel plugin server (index.mjs in the source repo) | **mesh bridge module**: inbox watcher + registry management + msg-res handling + WS `msg-up` uplink reception                    | main workload |
| 2   | device cli.mjs (CLI_VER→p10)                        | `/task` gains a `sessionId` mode: `new`→allocate and persist, `resume`→`--resume <sid>`; uplinks `msg-res` over WS on completion | medium        |
| 3   | panel entry.mjs                                     | add a 「Mesh」card next to the 「模型通道」(Model channel) card: toggle, device agent name, latest reply preview                 | small         |
| 4   | pi-messenger                                        | **untouched**                                                                                                                    | 0             |

## 5. Key design decisions

1. **Device agent = one persistent agent per device** (named `Remote<device name>`, e.g. `RemoteMbp`). Session state lives in `~/.pi-tunnel-agent.json` (sessionId/cwd/model); the panel offers `重置会话` (Reset session) for a fresh session.
2. **The bridge is always-on alongside the server**; the registry entry's `pid` is the server PID (the bridge process) — pi-messenger's PID liveness check passes for free; **device offline is reflected by the bridge**: while offline it freezes the entry's `activity.lastActivityAt` and adds an `offline:true` custom field before dropping the `session` field (pi-messenger ignores unknown fields, so this is safe); restores on reconnect.
3. **Offline backlog**: inbox messages persist while the device is offline; on reconnect the bridge replays them in time order (last 5 only, older ones are written back to the initiator marked `skipped`).
4. **Multi-device readiness** (implemented in P3b; v1 was single-device): registry/inbox watcher parameterized by device name; meshDrain routes by looking up the device aid from the inbox target (no more activeAgent doubling as the one device). Adding a device only needs the panel's always-on command to join it; the bridge needs zero changes
5. **Model channel**: the device pi session reuses the v1.2.0 three-tier resolution (resolveModelEnv), resolving once at session start and writing into the device-side models.json (existing mechanism).
6. **Security gate** (the mesh channel is easier for an agent to trigger spontaneously than /device/task, so it must be defended):
   - Toggle off by default: storage `devcfg.meshEnabled:false`, switched on from the panel's Mesh card (owner, by hand)
   - Device-side tools allowlist keeps the v1 policy (`read,grep` by default; writes need a panel grant — the existing fsWrite governance)
   - Bridge audit: every forwarded message in and out lands in the audit ring
   - **Loop prevention**: the device agent is not a member of the mini mesh (it does not run pi-messenger), so replies land one-way in the initiator's inbox; the bridge refuses messages with `from=Remote*` (device messages never travel back to a device)
7. **Steering injection boundary**: when the initiator's pi is idle, steer starts a new turn; when busy it queues (pi's built-in steer behavior). The bridge does not retry injection — deliver and forget (the inbox file is the persistence).

## 6. Risks and open questions

- **R1 Result extraction**: the final text of the `--mode json` stream is the assistant `text` of the last `message_end`; rounds containing toolCall keep waiting until `agent_end`. The PONG stream already validated this structure ✅
- **R2 Timeout**: device pi tasks can run long (>60s). The CLI `timeoutS` ceiling goes to 600 (mesh scenario); the bridge applies a 10min per-msg timeout, writing back to the initiator on expiry: 「任务超时，设备端仍在跑，结果将丢弃」(task timed out, the device side is still running, the result will be discarded) (v1 simplification)
- **R3 Session bloat**: a persistent session grows with long chats — v1 does not handle it (offers reset), v2 evaluates `--no-session` periodic rotation or compact
- **R4 Several pi sessions sending at once**: the inbox is consumed serially (single bridge queue), so there are no concurrency conflicts by construction
- **Open Q1**: should the device agent be able to `send` back to any agent on the mini (today replies only go to the initiator)? v1: no (one-way replies), reverse sending is left for v2
- **Open Q2**: Crew orchestration (plan/work) across devices — not in this phase (Crew worker spawn is local to the mini; cross-device workers are a much later direction)

## 7. Phasing and acceptance

**P3a (bridge + channel, estimated one work session)**

- index.mjs bridge module + WS msg-up; cli.mjs p10 (sessionId + uplink); panel Mesh card
- Acceptance: a mini pi session runs `send to=RemoteMbp "你是谁，report hostname"` → gets a wake reply (containing gxg-mbp) → `list` shows RemoteMbp → send another one to verify `--resume` memory (the second question can restate the content of the first)

**P3b (polish, landed 20261024)**

- Offline replay, timeout write-back, reset-session button, README/CHANGELOG, device-side session snapshot in the panel

**What P3b actually shipped vs. the design**

1. **Multi-device routing implemented early** (original §5.4 "v1 connects 1 device"): meshDrain now looks up the device aid in registry.device from the inbox directory the message sits in (the target device agent name) and delivers to it; if the target is offline the message stays put awaiting replay. Single- and multi-device behavior is identical; acceptance regression passed
2. **Session management endpoints**: CLI p14 `GET /session` (snapshot) + `POST /session/reset` (deletes session.json); server `GET /mesh/session`, `POST /mesh/reset` (supports `?agent=` to pick a device); panel Mesh card 「会话/重置会话」(Session / Reset session) buttons
3. **CLI p15**: undici does not fire onclose when close() is called in the CONNECTING state, so once connectGuard is discarded the reconnect chain dies → re-check 3s after discarding, exit(0) if still 0 and let launchd restart it
4. **persistCmd template fix**: launchd does not expand %h in the plist's `StandardOutPath` (spawn fails with 78 EX_CONFIG immediately) → switched to `$HOME` (see CHANGELOG 1.4.0 / the incident notes in PROGRESS)
5. Acceptance fully green: device online on p15 (launchd always-on) → snapshot → reset removed → first reply after reset 「PONG-p3b · 新会话已建立」(PONG-p3b · new session established); stranded replay verified live (backlog processed after reconnect, 10min timeout protection discards, queue drained to zero)

## 8. Backup and rollback

- As usual before changes: full archive to `~/WorkSpace/pdd-backup/tunnel-plugin-pre-p3a-<ts>/`
- CLI p10 rolls back automatically when the push fails (self-update already does atomic replacement); switching the bridge off returns fully to Phase 2 behavior
