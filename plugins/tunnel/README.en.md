**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# 🔗 tunnel — network tunnel plugin for pi-web-ui

Reverse tunnel: your other devices (laptop / desktop / phone terminal) **connect inbound** to the machine running pi-web-ui,
and the AI uses "the network the device sits in" as its egress for network probes and access — **zero public exposure, NAT traversal for free**;
DNS resolves on the egress device, so you measure the real result for that device's network.

It can also turn devices into **command nodes**: the AI runs a pi agent on the device over the control channel (`/device/task`),
and the device agent joins pi_messenger as `Remote<CamelCaseHostname>`; any session can `send` to it directly (mesh bridge).

## Changelog

### 1.4.0 (2026-10-24) P3b polish

- mesh delivery routes by target: messages go through the inbox directory (named after the device agent) → the registry reverse-looks-up the device aid (the p3a version wrongly delivered to activeAgent, which misdelivers whenever several devices exist)
- Device-side session snapshot/reset: CLI `/session` (GET, read-only) + `/session/reset` (POST); server `GET /mesh/session`, `POST /mesh/reset`; panel Mesh card 「会话/重置」(Session/Reset) buttons
- README rewritten to the current capability surface; device CLI p14

### 1.3.0 (2026-10-24) Phase 3a: pi_messenger mesh bridge

- Device agent joins pi_messenger: pure file bridge (registry/inbox/offline redelivery/stuck queue), zero changes to pi-messenger
- Device-side persistent session: `--session <uuid>` remembers across messages (`--resume` always pops the TUI selector, confirmed unusable and dropped)
- TDZ race fixed at the root: `meshEnabled` becomes a function declaration (a const arrow, triggered by an async hook during the startup yield window, caused activate failed)
- Bring-up redelivery capped at 5, 10min timeout write-back, panel Mesh card

### 1.2.0 (2026-10-23) Phase 2: three-level model channel resolution

- Fix regex catching non-session models, and keys of standard OpenAI-compatible providers not being injected
- `resolveModelEnv(model?)`: override → manual (storage.modelEnv) → auto (session models.json + provider-keys.json)
- Device-side dynamic models.json injects `providers.tunnel`; panel 「模型通道」(Model channel) card + `GET/POST/clear /modelenv`
- New `POST /device/task`: bare device-side pi agent execution (-p --mode json), control channel end-to-end (Phase 1)

### 1.1.1 (2026-10-22)

Disconnect self-healing fixed in three layers (serial real-world debugging):

- Server isAlive heartbeat killed connections on a single miss → 3 consecutive misses (≈90s) of grace
- ver handshake p7≠p8 blocked self-update → server-issued and CLI version numbers now change in sync
- Same-name device "same capability, reject new connection" → the new connection always wins (twin takeover, two processes kicking each other converge)
- CLI reconnect hung with no connect response (SYN black hole) → discard after 10s and start over (battle-verified)

### 1.1.0 (2026-10-20)

- Heartbeat keepalive + zombie-connection detection forcing reconnect; connect/disconnect logs carry timestamps
- spawn instead of execFile (paths with spaces); dual-label uninstall and config hot reload

## How it works

```
[AI inside pi-web-ui] --SOCKS5(127.0.0.1:<socksPort>)--> [tunnel plugin] --WebSocket--> [your device: cli] --> target
```

- The device-side CLI is a single-file Node script (≥22) that **dials outbound** to the host, needing no public IP or port mapping
- Multiple devices coexist: all online devices stay independent, SOCKS traffic goes through the "current egress device"; if the egress drops off it **switches automatically**
- The server stays resident with the host process (launchd / service manager), and the panel can start or stop it at any time

## Features

- **Panel** (separate view tab): three-state tunnel status light, egress device list (online status / OS / one-click switch),
  service start/stop, access-token view and reset, one-click copy of always-on install commands for three platforms (macOS / Windows / Linux)
- **AI tool `tunnel_fetch`**: send HTTP requests through the tunnel (the data plane executes on the egress device's network);
  just say "use the tunnel to check my egress IP" in a conversation
- **One-click CLI distribution**: the panel downloads a CLI with the token already injected; once a device connects it appears in the device list
- **Multi-platform always-on**: install commands for macOS (launchd) / Windows (schtasks) / Linux (systemd --user),
  shown per OS tab; install once for start-on-boot + reconnect-on-drop
- **Notifications**: device connect/disconnect, egress switch and token reset are pushed via `host.notify`

## Install

Panel 「插件」(Plugins) → install → enter this repository's plugin directory:

```
xing-shuyin/pi-web-ui/tree/main/plugins/tunnel
```

Or CLI: `pi-web-ui install xing-shuyin/pi-web-ui/tree/main/plugins/tunnel`

## Device onboarding

1. In the panel's 「设备常驻化」(Device always-on) pick your OS tab and copy the command to run in that device's terminal
   (or 「下载 CLI」(Download CLI) first and run it manually: `node pi-tunnel-cli.mjs`)
2. Once the device appears in the 「出口设备」(Egress devices) list the AI can use it; with multiple devices click 「设为出口」(Set as egress) to switch

## AI-side usage

```
tunnel_fetch {url: "http://myip.ipip.net"}          # real egress IP of the egress device's network
tunnel_fetch {url: "http://192.168.x.1/", timeout: 5}  # probe the gateway on the egress device's LAN
```

**Device command (control channel, all REST calls carry ?token=PI_WEB_TOKEN)**:

```
POST /plugins-api/tunnel/device/task  {id, prompt, tools:"read,grep", timeoutS:600}   # bare pi execution on the device
GET  /plugins-api/tunnel/status        # device list and aid (id increments per session, must be fetched dynamically)
POST /plugins-api/tunnel/device/hw    {id}                                            # hardware overview
```

**mesh bridge** (after enabling it in the panel): `pi_messenger send to=RemoteWDLMacBookPro "…"` —
the device-side pi answers in a persistent session, the reply automatically returns to the initiator's inbox and is wake-injected into the conversation;
`GET /mesh/session` reads the snapshot, `POST /mesh/reset` resets the memory.

## Security and authentication model

- **SOCKS5 egress**: listens on `127.0.0.1` only; external processes outside the host machine cannot reach it.
- **WS tunnel access auth**: the WS tunnel (`:wsPort`) endpoints (`/agent`, `/cli`, `/status`) require the tunnel's own token (`?token=`, SHA-256-based constant-time comparison against timing side channels).
- **Panel routes and token leak prevention**: panel routes (`/plugins-api/tunnel/*`) are protected by host auth (`PI_WEB_TOKEN`). When the host does not set `PI_WEB_TOKEN`, the tunnel token served by `/status` is automatically redacted (preventing total credential exposure across the chain when frp-style reverse proxies expose the service publicly without a host password).
- **Connection and command isolation**: SOCKS data transfer, control commands (`ctrl-resp` uses high-entropy random UUIDs) and Mesh async replies are all hard-bound to the target device `aid`, blocking cross-device forgery, answer racing or SOCKS hijacking in multi-device setups.
- **Capability model and hard task gates**: the remote task channel (`/device/task`) and file reads/writes are constrained by device capabilities (`fsRead`, `fsWrite`) through hard gates at all three layers — panel, server and CLI. When a device has `fsWrite=false`, no write/execute tools (`bash,edit,write`) may ever be dispatched; `/fs/browse` directory browsing is limited to the user's home directory or mounted storage volumes, and enumerating sensitive system root directories is prohibited.
- **Transport security and credential-at-rest risk (important)**:
  - The tunnel link is plaintext by default (`ws://` and `http://`). When connecting over the public internet, **strongly prefer fronting it with an HTTPS / WSS reverse proxy** (such as Nginx, Caddy or FRP with TLS), or use a WireGuard VPN.
  - Model credentials needed for device-side task execution are handed to the peer at dispatch time and stored with `0600` permissions at `~/.pi-tunnel-agent/models.json`; when the panel remotely uninstalls a device they are wiped completely.
- **Lifecycle safety closure**: stopping the tunnel or resetting the token (`/rotate`) actively terminates all existing device connections and closes the Mesh bridge, releasing file-watch handles and timers.

## Settings

| Key       | Default | Description                                         |
| --------- | ------- | --------------------------------------------------- |
| wsPort    | 8765    | WS tunnel port (all interfaces, devices connect in) |
| socksPort | 1080    | SOCKS5 port (127.0.0.1 only)                        |

## Development

- Source layout: `manifest.json` + `index.mjs` (server, fully inline) + `client/entry.mjs` (panel)
  - `assets/cli.mjs` (device-side CLI template; token and address are injected on `/cli` download) + `client/sdk/` (SDK copy)
- After changing the server, `cp` to the deployed location and restart the host with `launchctl kickstart -k gui/501/com.xingshuyin.pi-web-ui`
  (a browser refresh only updates the panel, it does not reload the server)
- Version hard rule: `CLI_VER_PUBLISH` in `index.mjs` and `CLI_VER` in `assets/cli.mjs` must be bumped together (missing one stalled both the p11 and p12 pushes)
