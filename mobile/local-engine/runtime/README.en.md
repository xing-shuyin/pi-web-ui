**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# mobile/local-engine

On-device mobile engine (Android): the APK bundles a Linux rootfs + Node + pi-web-ui, hosted by a foreground service and run through proot without root. Design doc and source of truth: [`docs/mobile-local-engine.md`](../../../docs/mobile-local-engine.en.md).

## Directory

| Path                       | Contents                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `runtime/build-runtime.sh` | rootfs build script (Linux/CI, needs root + qemu-user-static)                                          |
| `runtime/out/<abi>/`       | archived build artifacts (gitignore)                                                                   |
| `../native/local-engine/`  | Capacitor local plugin: TS bridge + Java native layer (installer / foreground service / state machine) |

## Build (CI or WSL/Linux)

```bash
cd mobile/local-engine/runtime
sudo RUNTIME_REVISION=r1 ./build-runtime.sh arm64 --sync-assets
```

- `--sync-assets` copies `runtime.json + rootfs.tgz.part-*` into
  `mobile/native/local-engine/android/src/main/assets/localengine/` (gitignore; when not populated, the APK cannot install the runtime and reports an explicit error).
- Volumes are 100MiB; `runtime.json.volumes` records each volume's bytes/sha256, and the installer commits extraction only after streaming validation.
- Pinned inputs: Ubuntu base / Node LTS / proot (termux static binary); both the image and URLs can be overridden with environment variables.
- The x86_64 package is for emulator smoke tests: `sudo RUNTIME_REVISION=r1 ./build-runtime.sh x86_64 --sync-assets`.

## Phase A smoke test (no Android device)

On the same Linux machine:

```bash
chroot out-rootfs env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/root \
  PI_WEB_HOST=127.0.0.1 PI_WEB_PORT=0 PI_WEB_DATA_DIR=/tmp/pwu-data PI_WEB_CWD=/tmp/pwu-ws \
  node --import /usr/local/lib/node_modules/pi-web-ui/dist/server/resolve-global-sdk.js \
       /usr/local/lib/node_modules/pi-web-ui/dist/server/index.js
```

Acceptance: `node-pty` loads, the home page is reachable, `PI_WEB_TOKEN` takes effect. Real-device verification of the proot form happens in phase B/C.

## Known limitations (MVP)

- Upgrade transactions are not implemented: changing versions after install requires「重置本机引擎」(Reset the local engine) first (`reset` keeps user data in `filesDir/data`).
- Fallback for node left behind after the proot main process is killed: destroy on service stop → destroyForcibly after 3s; extreme ROMs may leave orphan processes, and the port is reassigned before the engine restarts, so availability is unaffected.
- The iOS bridge is not implemented (out of scope this cycle).
