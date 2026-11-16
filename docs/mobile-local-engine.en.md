**English** · [简体中文](./mobile-local-engine.md) · [繁體中文](./mobile-local-engine.zh-TW.md)

# Local engine: pi-web-ui for mobile runs fully standalone

> Goal: the phone does not depend on a PC. The APK carries its own Linux rootfs + Node + pi-web-ui, runs the server and the pi engine locally, and is driven by its own WebView UI — while keeping the existing remote-control capability.
> Reference implementation: `ccch1mneyyy/dsh-go` (a DeepSeek Harness Android client; its Flutter + proot rootless route is already proven on real devices). **Borrow only the architecture and the deployment technique, never its code** (AGPL-3.0).

## Positioning: a third connection mode

Today's mobile app ([`mobile.md`](mobile.en.md)) is a remote control: it bundles the React UI locally, connects to pi-web-ui on a PC, and tasks run on the PC. This document adds the "local engine":

| Mode             | Engine location  | Dependency | Entry point   |
| ---------------- | ---------------- | ---------- | ------------- |
| Direct / Hub     | PC               | PC online  | Unchanged     |
| **Local engine** | Inside the phone | None       | This document |

From the user's perspective: install the APK → one tap on 「安装运行环境」(Install runtime), which unpacks the rootfs → enter an API key → use it directly. UI, terminal, file tree, canvas, and plugins are the same set as the desktop app.

## Architecture

```
Capacitor WebView (full reuse of mobile/src)
  └─ http://127.0.0.1:<port>/  ← same origin + token exchanged for a Cookie
Kotlin native layer (new, packaged as a Capacitor plugin)
  ├─ LocalEnginePlugin        MethodChannel: status/install/start/stop/logs
  ├─ LocalEngineService       foreground service hosting the node process
  ├─ RuntimeInstaller         unpacks rootfs.tgz from the APK into filesDir/engine/
  └─ proot (libproot.so)      filesDir/engine/node … runs without root
rootfs (Ubuntu 24.04 arm64, split volumes inside APK assets)
  ├─ node (22.x LTS, exact pinned version)
  ├─ global npm: pi-web-ui + @earendil-works/pi-coding-agent
  ├─ git, ca-certificates, tzdata
  └─ node-pty native binding (compiled inside the rootfs at build time, ABI identical to runtime)
```

Start-up chain: the WebView calls `start` → the service brings up `node dist/server/index.js` under proot (`PI_WEB_HOST=127.0.0.1`, random `PI_WEB_PORT`, random `PI_WEB_TOKEN`, `PI_WEB_DATA_DIR=filesDir/data/`, `PI_WEB_CWD=filesDir/workspace/`) → stdout is parsed for `<port>` and the token → the WebView calls `loadUrl("http://127.0.0.1:<port>/?token=…")`. Everything after that rides the existing protocol and snapshots.

**Zero UI rewrite**: no self-built Flutter chat UI — reuse the `web/dist` build output directly (dsh-go also keeps "official Web + WebView" as a fallback route, which proves the path works; we make it the primary route, and the payoff is that every existing UI capability and theme carries over without porting).

## Repo strategy: one repo, with independence in the artifact layer

Code and scripts live next to `mobile/` in **this repo** (same origin as the existing Capacitor project):

| Dimension              | Same repo (chosen)                                                                                                                   | Separate repo                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Version consistency    | CI builds the rootfs straight from the same build, so protocol / UI / engine / node-pty binding are the same version by construction | Can only pin the published npm version, upgrades always lag one beat                                   |
| Existing project       | Local mode is just one more connection in `connections`; the plugin joins the existing Capacitor project                             | Either copy the whole Capacitor project, or start another shell — connection code drifts in two places |
| Git size               | The rootfs never enters git: CI builds it, artifacts go to Releases                                                                  | The same                                                                                               |
| Why dsh-go is separate | Upstream (DSH official) has no app project to reuse, it can only stand alone and consume the official npm package                    | Cloning it means giving up reuse of the existing project                                               |
| Release cadence        | `runtime.json`'s builtinVersion pins the pi-web-ui version; tagging `vX.Y.Z` produces the APK in passing                             | Keeping the two repos' release cadences aligned relies on people                                       |

The independence in "fully independent" refers to the **artifact**: the APK carries its own rootfs and needs no PC — not to physical separation of the codebase.

When to split out a separate repo (escape hatch): the UI moves to a Flutter rewrite (if iOS / HarmonyOS ambitions hold up), or the APK needs a channel cadence fully decoupled from npm. At that point `mobile/local-engine/` plus the native plugin directory move out wholesale and consume the `pi-web-ui@^x` npm package instead (the dsh-go way); the only thing to rewrite is the connection glue in the existing shell.

## Sources of truth (★ = the single source for this document)

| Capability                                             | Source of truth                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Local engine doc (this document) ★                     | `docs/mobile-local-engine.md`                                                                                            |
| Runtime build script ★                                 | `mobile/local-engine/runtime/build-runtime.sh` (built, for Linux/CI)                                                     |
| Android native layer ★                                 | `mobile/native/local-engine/` (local Capacitor plugin: TS bridge + Java native layer)                                    |
| Connection entry and the three modes                   | `mobile/src/connections.ts` · `mobile/src/connection.ts` · `mobile/src/ConnectionScreen.tsx`                             |
| Server connection modes / full env table               | [`env-vars.md`](env-vars.en.md) (`PI_WEB_PORT`/`PI_WEB_HOST`/`PI_WEB_TOKEN`/`PI_WEB_DATA_DIR`/`PI_WEB_CWD`/`PI_WEB_SDK`) |
| Mobile notifications and builds                        | [`mobile.md`](mobile.en.md)                                                                                              |
| Production shape (dist/server, web/dist, bin launcher) | `package.json` scripts · `bin/pi-web-ui.mjs`                                                                             |

## Runtime packaging (`mobile/local-engine/runtime/`)

Every input pins a version + sha256 (Tencent/Tsinghua mirrors); artifacts ship as split volumes in APK assets and are verified on unpack:

1. **Ubuntu 24.04 arm64 base rootfs** (official ubuntu-base tarball) + `dpkg` installing `tzdata ca-certificates git python3 make g++`; x64 build hosts assemble it through a `qemu-user-static` chroot.
2. **Node 22.x LTS** (≥22.19.0, see `engines`), the official linux-arm64 tar.xz, unpacked into `/usr/local`.
3. **npm packages**: `pi-web-ui` (the release contains `dist/server`, `web/dist`, `bin/`) + `@earendil-works/pi-coding-agent` installed globally; `PI_WEB_SDK` points at a fixed path inside the rootfs, bypassing any global discovery logic.
4. **node-pty** ^1.1.0 must be compiled natively by `npm install` inside the rootfs (Python + make + g++ are already in place from step 1; the build toolchain can be stripped afterwards to cut size).
5. The **proot** binary ships as `libproot.so` in jniLibs (only executable once `useLegacyPackaging` unpacks it into `nativeLibraryDir`); proot is GPL, so the release cites its source in THIRD_PARTY.
6. Artifacts in `out/arm64-v8a/`: `rootfs.tgz` volumes + `runtime.json` (abi, builtinVersion, baseId). An optional x86_64 flavor serves emulators.

### Install and upgrade transactions

A slimmed-down implementation of the dsh-go contract:

- The full rootfs lands only on first install or when the user confirms 「重置」(Reset); a normal upgrade never swaps the rootfs and replaces engine artifacts by exact path only (node, the `node_modules` release package directories), never `/usr` and `/opt` wholesale.
- `engine.prepare` writes to disk → `engine.upgrade` renames atomically → failures roll back; start-up recovers a half-finished transaction before cleaning up, rather than overwriting the whole root.

## Android native layer design

MethodChannel `pwu/localengine`, with state pushed over an event stream:

| Method           | Behavior                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `getStatus`      | `phase: notInstalled/installing/installed/starting/running/stopping/error` + version + baseUrl  |
| `install`        | Unpack volumes + verify; progress over the event stream                                         |
| `start` / `stop` | Managed by the foreground service; stdout ring log; automatic restart on crash (capped backoff) |
| `getLogSnapshot` | Last N log lines (seq increments, not reset by restarts), feeding the engine log page           |

- Data locations: `rootfs/root/piwebui-data/{data,workspace,pi-agent}` — all three are on the 「重置运行环境」(Reset runtime) keep list (reset rebuilds the rootfs only).
  `pi-agent` is pinned explicitly via `PI_CODING_AGENT_DIR`: pi's default `~/.pi/agent` lives inside the rootfs, is deleted along with it,
  and would wash away the API key configuration and chat history together.

- `targetSdk = 28` (the Termux approach, sidestepping the Android 10+ ban on `exec` in private directories; this project does not ship through Google Play, so there is no 28→35 constraint).
- Foreground service + partial wake lock + a battery-optimization allowlist onboarding page; a persistent notification shows run state.
- ABI product flavors `arm64` (real devices) / `x64` (emulators).

## App sandbox and rename (ENOSYS inside proot)

Symptom: the engine process starts, but every rename — `writeAtomicSync` (client-state etc.), `plugin-materialize` (built-in plugin materialization) — reports
`ENOSYS: function not implemented, rename …`.

The root cause is neither proot nor the rootfs:

- The app process carries a zygote-issued seccomp filter (`Seccomp_filters: 1` in `/proc/<pid>/status`); the same rootfs run via
  `adb shell run-as … proot …` (no seccomp) has `rename` / `renameat` / `renameat2` all succeed.
- The filter makes `renameat2` return ENOSYS outright; glibc 2.28+ `rename()` goes only through `renameat2` with no fallback (Node's `fs.rename*`
  all land there), so not a single rename succeeds inside the app process → the engine starts but cannot persist state.

The fix has two layers, touching neither call sites nor the `dist` inside the rootfs (no text patching):

1. **C shim baked into the rootfs (primary path, covers every child process)**: `mobile/local-engine/runtime/rename-preload.c` compiles into
   `/usr/local/lib/pi-mobile/librename-compat.so` and is registered in the rootfs's `/etc/ld.so.preload` — every glibc program in the
   guest (node, bash, git, mv) loads it at start-up, and `rename` / `renameat` are rerouted to `renameat` (which is on the allow list).
   proot itself is bionic and does not read this file. Measured: `rename` inside the app process succeeds again and the `[rename-compat]` fallback log is gone.
2. **Node-side JS fallback (old rootfs / missing shim)**:
   `assets/pi-localengine/rename-compat.cjs` wraps `fs.renameSync` / `fs.rename` / `fs.promises.rename`, degrading to "copy + delete source"
   **only** on ENOSYS (and ENOTSUP/EOPNOTSUPP); every other error code is rethrown as is. `LocalEngineService`
   writes it into `rootfs/root/.pi-mobile/rename-compat.cjs` on every start and injects it via `node --require`; a failed write only warns and never blocks.

Costs and boundaries:

- The C shim keeps rename's real semantics (`renameat` is still an atomic rename); atomicity is lost only on the fallback path (copy + delete source).
- The flagged semantics of `renameat2` (`RENAME_NOREPLACE` / `RENAME_EXCHANGE`) have no `renameat` equivalent; they keep the same
  ENOSYS failure semantics as the sandbox, with no pretended support.
- When an old rootfs (no shim) starts, the service says outright in the log that 「终端里的 git 等子进程可能仍报 ENOSYS」(child processes such as git in the terminal may still report ENOSYS).

## React connection layer (`mobile/src/`) changes

- `connections.ts`/`connection.ts` gain `kind: "local"`, shown only when `Capacitor.isNativePlatform()` (Android).
- `ConnectionScreen.tsx` gains a local-mode wizard: install the runtime (progress / retry on failure) → start → enter the workspace; failure branches offer 「查看引擎日志」(View engine logs) and 「重置运行环境」(Reset runtime).
- Local mode sets up no JPush push: the foreground service is always-on, so task-completion reminders go through system notifications directly (the service has its own UI, no Jiguang needed).
- Workspace directory guidance: in local mode the default workspace lives in the app's private directory; `PI_WEB_CWD` is written once and pinned, so users do not mistake a path outside `filesDir` for the root.

## Expected server-side changes (ideally zero)

In local mode the WebView opens `127.0.0.1:<port>` directly; after exchanging `?token=` for a Cookie everything is same-origin:

- `server/index.ts` already has loopback detection (`isLoopbackAddress`/`isLoopbackHost`) and the `mobileCors`/`mobileOriginAuthorized` channel (`server/mobile-origin.ts`); same-origin requests raise no origin issue.
- If a real device shows the WebView's initial request carrying an odd Origin (such as `null`), register a local-mode-only allow branch in `mobile-origin.ts` — the change stays confined to that one file.
- Approval gates, terminal PTY, and attachment upload keep their semantics on loopback; no platform-difference branches.

## Phased plan and acceptance

| Phase                               | Content                                                                                                                                   | Acceptance                                                                       | Status                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A. Runtime smoke test (dev machine) | Script produces the arm64 rootfs; `node dist/server/index.js` starts under qemu                                                           | Local curl of the home page returns 200, `PI_WEB_TOKEN` works, node-pty loads    | Script built, awaiting CI/qemu run                                             |
| B. Android shell                    | Plugin + foreground service + install wizard; the WebView opens the local service                                                         | One-tap install on a real device → chat works                                    | TS bridge + Java native layer + connection layer wired, awaiting a real device |
| C. Capability verification          | Terminal PTY seesaw, git tools, attachments, screenshots, settings persistence, foreground service surviving 30 minutes in the background | All green on a real device; a cold start after being killed restores the session | Blocked on B                                                                   |
| D. Upgrade and polish               | Ship a new runtime package through the upgrade transaction; x86_64 emulator package                                                       | Version swaps leave user data intact                                             | Not started (MVP uses reset instead of upgrade)                                |

### MVP implementation status

- ✅ Build script `build-runtime.sh`: pinned inputs (Ubuntu base / Node 22 / proot + sha256) → qemu chroot installing git/python3/make/g++ → `npm -g` installing pi-web-ui and the pi SDK → node-pty binding smoke test → 100MiB volumes + `runtime.json` (bytes/sha256 per volume) → `--sync-assets` writes the plugin assets.
- ✅ `mobile/native/local-engine/`: the `@pi-mobile/native-local-engine` local plugin (file: reference, auto-registered via `capacitor.plugins.json`). TS bridge `getStatus/install/start/stop/getLogSnapshot/reset` + `status/logs/progress` events; Java side: EngineState (state machine + 2000-line ring log, seq not reset by restarts), RuntimeInstaller (streaming sha256 over volumes → staging → atomic commit, symlink/exec bits restored), LocalEngineService (foreground service + proot/node process + random port/token + TCP readiness probe + crash restart with backoff ≤3 times), LocalEnginePlugin (the Capacitor bridge).
- ✅ Connection layer: `ConnectionMode` gains `"local"`; `ensureLocalEngineRunning()` starts the engine idempotently; ConnectionScreen shows three modes (Android adds 「本机运行」/Run locally) with progress / engine state / reset entry; boot restore re-runs the ensure flow for local (credentials are re-minted on every start).
- ⏳ TODO: CI runs phase A artifacts → real device (arm64) install → start → chat/terminal/settings acceptance; upgrade transaction (phase D).

Size estimate: rootfs + node + dependencies ≈ 250–450MB (arm64 single flavor), amortized into a single APK download; later upgrades ship only delta engine artifacts.

## Risks and mitigations

| Risk                                                                            | Mitigation                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| node-pty fails to compile in the ARM rootfs                                     | Phase A verifies up front; fallback: pre-install a `package.json`-pinned version inside the rootfs + an offline native module; if the terminal is unusable, gray out the terminal panel and run the main path |
| Phone vendors kill background processes                                         | Foreground service + allowlist onboarding; docs tell users to lift PiPilot's battery restrictions                                                                                                             |
| ROM policy on `exec` in private directories                                     | Stay on targetSdk 28; never raise targetSdk recklessly before Play listing                                                                                                                                    |
| `bin/pi-web-ui.mjs` carries desktop assumptions inside the rootfs (frp/homedir) | Start-up bypasses the bin wrapper and runs `node dist/server/index.js` directly; the bin launcher stays the single source for the PC shape                                                                    |
| AGPL boundary                                                                   | No dsh-go code is pulled in, only the approach restated; the proot GPL source citation ships with the release package                                                                                         |
| Emulators / niche ABIs                                                          | MVP promises arm64-v8a only; the x86_64 flavor is an optional artifact                                                                                                                                        |

## Out of scope

- No chat UI rewrite (Flutter/RN), no self-built `dsh_client`-style standalone protocol client; protocol consumption keeps going through the single `web/dist`.
- `server/protocol.ts` is untouched; no new API for local mode.
- MVP does not install the DSH engine (later an optional layer; the file: clone isolation in `docs/dsh-engine.md` is unaffected).
- No iOS commitment: the path matches dsh-go (CI reusable later), but this cycle invests nothing.
