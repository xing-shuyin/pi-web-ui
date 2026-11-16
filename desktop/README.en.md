**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# pi-web-ui desktop app (Electron)

The desktop app puts the pi-web-ui local service and the application window together, for users who want to open a desktop app directly; chat, files, terminal and the rest reuse the web version. Running the packaged desktop app needs no separate Node.js install to start the service, but whether Git/Bash, extra engines and their dependencies are available depends on the runtime bundled in the package and on the local machine.

- [Official site](https://xing-shuyin.github.io/pi-web-ui-site/) · [Full installation and model configuration](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)
- [Startup flags](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#cli-and-env) · [Local /setup configuration guide](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#setup-page)
- [Download the latest release](https://github.com/xing-shuyin/pi-web-ui/releases/latest)

## Switching between the built-in browser and the Agent

The desktop window has a built-in multi-tab browser and can switch between 「浏览器」(browser), 「Agent」, and 「分栏」(split pane) at the top. Switching reuses the existing page and Agent views, preserving site login state, typed input and Agent drafts. The browser starts first and the local Agent service starts in parallel; pages stay browsable when the service is unavailable.

The address bar accepts a URL or a search term, `Ctrl/Cmd+L` focuses the address bar, `Ctrl/Cmd+T` opens a new tab, `Ctrl/Cmd+W` closes a tab in browser mode, and `Ctrl/Cmd+Shift+1/2/3` switch between the three modes. Split mode has an adjustable width. The new tab page and browser settings provide entries for bookmarks, history, downloads, the password vault and extension loading; legacy AI Browser data can be imported from an old data directory, without overwriting existing files.

The built-in Agent connects to the local service automatically. To use a remote Web Agent, enter that service's address in browser settings and connect; then open that trusted address with the built-in browser, which can also operate other tabs through the native page bridge, with no page-picker install. AI actions, screenshots and script execution each have their own switch, with script execution off by default. Ordinary websites can't call browser control or read storage.

Office supports text/CSV editing plus read-only content preview for DOCX/XLSX/PPTX; complex layout, images and formula calculation are outside the current preview scope. Binary documents are never saved over as text. Local documents must be opened through the file picker first.

Module boundaries, permissions and build instructions are in [built-in browser architecture](../docs/architecture-browser.en.md).

## Device Center integrated browser

Clicking “打开中心”(Open Center) in the desktop app opens a separate Device Center window for logging in, creating an account and confirming pairing. The main window keeps polling the pairing result and completes binding automatically once confirmed; no system-browser tab needed. Opening the same center again reuses the window, and the window menu offers forward, back, reload and back to the center home page.

Each center origin uses its own persistent Electron session for login state, isolated from the local app and other centers. The remote window has no preload, no Node privileges, has sandbox enabled, forbids cross-origin navigation and browser permission requests, and doesn't ignore certificate errors. The window title always shows the actual center address. The plain web version still uses a native browser tab.

This capability requires updating and restarting the desktop shell; updating only the web static assets can't add preload/IPC capability. Older desktop shells keep using the original external-link approach. On failure to open, the page keeps the center address for manual access, and the main window's pairing wait is unaffected.

## Choosing and running

| Form                                               | Fits                                           | Install and start                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows NSIS installer `*-setup.exe`               | A fixed machine                                | Run the installer, choose the install directory, then open the app                                                                                 |
| macOS `.dmg`                                       | Mac desktop app                                | Drag the `.app` into Applications, then open it                                                                                                    |
| Linux `.AppImage`                                  | Linux desktop app                              | Make it executable and run it, e.g. `chmod +x ./文件名.AppImage`                                                                                   |
| Windows `pi-web-ui-desktop-<version>-portable.zip` | Carry the program and data on a portable drive | Extract fully into a writable directory and run `启动Pi.bat` or `PiPortable.bat` in the root, see [portable build notes](../launcher/README.en.md) |

The Windows portable ZIP is an Electron app plus a `.bat` launcher script and needs no Python to run; it isn't the same distribution form as the Python launcher. The current repo's `launcher/` contains no Python launcher. The macOS update ZIP is also not a Windows portable package.

Configure the model and authentication on first entry. `/setup` is for service access and network configuration, while the model API Key is configured in workspace settings; use the actual service address when opening setup, e.g. `http://127.0.0.1:8790/setup` on the default port, not the web version's `8787`.

Unsigned or notarized packages may be blocked by the system; the downloaded artifact is the source of truth. Windows may show a SmartScreen prompt. If macOS reports 「已损坏」(damaged) or Gatekeeper blocks it, after confirming the source is trustworthy and placing the app in Applications, clear the quarantine attribute and open it:

```bash
xattr -dr com.apple.quarantine /Applications/pi-web-ui-desktop.app
open -a /Applications/pi-web-ui-desktop.app
```

## Data, ports and usage limits

In non-portable mode, Electron's own state lives in the system's Electron `userData` directory; service data defaults to its `data/` subdirectory. The exact `userData` location depends on the OS and app name — confirm it from the startup log rather than treating the install directory as the data directory.

| Setting                    | Actual behaviour                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PI_WEB_DATA_DIR`          | Overrides the data directory for WebUI config, plugins, etc.; non-portable default `<userData>/data`, separate from the CLI's `~/.pi-web`                                              |
| `PI_CODING_AGENT_DIR`      | Overrides the pi config, auth and session directory; non-portable default shares `~/.pi/agent`                                                                                         |
| `PI_WEB_CWD`               | Overrides the initial workspace; non-portable default is the user's home directory, so specify a project directory explicitly instead of making the whole home directory the workspace |
| `PI_WEB_PORT`              | When set explicitly, that port is tried first; otherwise `8790` is preferred, falling back to a random free port if it's taken                                                         |
| `PI_WEB_HEALTH_TIMEOUT_MS` | Milliseconds to wait for `/api/health`, default `60000`; a positive value is at least `1000`, invalid or non-positive values fall back to the default                                  |
| Access-token env var       | Sets the service access token; the desktop window loads with `?token=` once to authenticate, after which the frontend strips the token from the URL                                    |
| `PI_WEB_DESKTOP_URL`       | Development mode only: points the window at an existing service; ignored in packaged builds, see the integration workflow below                                                        |
| `PI_WEB_SDK=bundled`       | Forces the bundled pi SDK; by default it follows a newer pi copy detected on the machine, see [environment variables](../docs/env-vars.en.md)                                          |

A fixed port keeps Chromium's Origin stable, which helps preserve localStorage settings such as theme and panel widths; after falling back to a random port, those per-origin UI states may differ. The desktop sidecar always listens on `127.0.0.1`; for remote deployment see the [deployment guide](../docs/deployment.en.md).

- When used alongside the CLI/web version, the shared `~/.pi/agent` by default contains session records, so two services won't operate the same conversation at once; set `PI_CODING_AGENT_DIR` to isolate them. Don't let two services write the same WebUI data-dir at the same time.
- `browser_page` depends on the browser page-picker extension and isn't available in the Electron window; open the service address in a browser that supports the extension and authorize the page there. Other browser tools have their own operating conditions.
- The renderer enables `contextIsolation` and `sandbox` and disables Node integration; external navigation goes through the URL guard, and allowed external links go to the system browser. Tools and external programs can still reach local resources — these settings aren't OS-level isolation.
- Portable mode redirects the main application data and doesn't guarantee that the OS, temp directories, external CLIs or user-chosen workspaces leave no traces.

## Upgrading and backup

Installed builds can check for, download and install updates from the app's update panel. The main process reads the GitHub Release's `latest*.yml` through `electron-updater`: on startup it only checks metadata and doesn't auto-download; once the user finishes downloading they can “install and restart”, and installing on exit is also allowed. Whether an update works depends on the platform's artifacts, feed, network and system signing requirements — not every extracted directory can be updated in place.

`npm i -g pi-web-ui@latest` updates the global npm package and doesn't replace the desktop app's internal `dist/server`. If an update fails, download the new package for the platform from the Release and install it; quit the app first and back up the WebUI data directory and the Agent directory. For the portable ZIP, follow the [manual upgrade steps for the portable build](../launcher/README.en.md#upgrade-and-migration) so upgrading doesn't change the portable layout.

## Running from source and building

The following commands all run from the repo root. Node.js **>=22.19.0**, npm, and a dependency install including devDependencies are required. Desktop scripts are defined in the root [package.json](../package.json); there is no separate `desktop/package.json`.

```bash
npm ci
npm run build           # build the server, frontend and accompanying runtime assets
npm run desktop:dev     # compile the desktop shell, then start the local sidecar with Electron
```

`desktop:dev` only runs `build:desktop` and then launches Electron; it doesn't rebuild the server or frontend, so re-run `npm run build` after changing those. For Vite hot reload, run `npm run dev` in one terminal (server on `8788`, frontend on `5173`) and start the desktop shell in another:

```bash
# POSIX shell
PI_WEB_DESKTOP_URL=http://localhost:5173 npm run desktop:dev
```

```powershell
# PowerShell
$env:PI_WEB_DESKTOP_URL = 'http://localhost:5173'
npm run desktop:dev
Remove-Item Env:PI_WEB_DESKTOP_URL
```

This override uses the existing address directly and starts no sidecar; integration-test data and ports are whatever the separately started dev service provides.

| Command                         | What it builds and outputs                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build:desktop`         | Compiles only the desktop shell with `desktop/tsconfig.json` into `dist/desktop/`                                                            |
| `npm run desktop:dist`          | Builds the app and desktop shell first, then produces the current platform's artifacts per the electron-builder config, output to `release/` |
| `npm run desktop:portable`      | Builds the app and desktop shell, then assembles Windows `release/PiWebUI-Portable/`; doesn't download Git/Node or produce a ZIP by default  |
| `npm run desktop:portable:full` | As above plus `--with-git`; "full" in the name doesn't mean a standalone Node.js is included                                                 |

Windows portable assembly is best done on Windows. After `npm run build` and `npm run build:desktop` are done, pass the assembly flags directly:

```bash
node scripts/make-portable.mjs --with-git --with-node --zip
# only when release/win-unpacked is confirmed to be this build's target:
node scripts/make-portable.mjs --skip-pack --with-git --with-node --zip
```

The assembly script isn't an upgrader: it replaces the output `app/` every time and clears the eight standard subdirectories under `data/`, so don't re-run it on a portable directory in use. It also reuses an existing `runtime/`, so the absence of download flags doesn't mean the output has no old runtime. When electron-builder fails, the script may fall back to an existing `release/win-unpacked`; confirm the version and runtime contents before distributing.

### Stuck at `packaging`

When electron-builder prints `• packaging platform=win32 ...` and then goes quiet for a long time, with CPU and network both idle, check in order (both causes look like "stuck"):

1. **Leftover download lock**: after a previous packaging run was `Ctrl+C`'d or force-killed, `%TEMP%\eb-dl-*.lock.lock` directories remain, and a new process waits for `proper-lockfile` to consider them expired (10 minutes) before continuing. Delete those directories and it resumes immediately.
2. **Re-downloading Electron**: even on a local cache hit, `@electron/get` still pulls `SHASUMS256.txt` to verify, and if a direct GitHub connection fails (`UND_ERR_CONNECT_TIMEOUT`) it falls back to re-downloading the 158MB Electron zip, commonly tens of KB/s in China. Mirrors are provided centrally by `scripts/lib/electron-mirror.mjs`, and `npm run desktop:dist` and `scripts/make-portable.mjs` already get `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` injected into the child process by the wrapper `scripts/run-electron-builder.mjs` (bring your own non-empty env var of the same name to override it, handy for going through a proxy). **Don't write these URLs into `.npmrc` again**: npm 11 warns on custom keys as unrecognized config one by one, and from npm 12 on `npm_config_*` is no longer passed through, so the mirror silently stops working (guard: `tests/unit/electron-mirror-guard.test.ts`). When bypassing the wrapper with `npx electron-builder` directly, bring those two env vars yourself.

The first `npm install` downloads the Electron binary from the `electron` package's postinstall, and no wrapper is available at that step: on networks in China, set `ELECTRON_MIRROR` first (or `electron_mirror` in a user-level `~/.npmrc`, at the cost of an unrecognized-config warning on every npm command).

To see exactly which step it's stuck on, re-run with `DEBUG='electron-builder*,@electron/get*'`; the log shows whether it's waiting on a lock or downloading.

`--with-git` / `PI_BUNDLE_PORTABLE_GIT=1` downloads PortableGit, `--with-node` / `PI_BUNDLE_PORTABLE_NODE=1` downloads a standalone Node.js; downloading and extracting need network access plus working `curl` and extraction tools. `--zip` additionally produces `release/pi-web-ui-desktop-<version>-portable.zip`. The current script always downloads Windows x64 Git/Node and is not a general cross-platform runtime. The full layout and how to top it up manually are in the [portable build notes](../launcher/README.en.md).

## Development architecture and packaging config

```text
Electron main process (desktop/main.ts)
  ├─ Electron binary + ELECTRON_RUN_AS_NODE=1
  │    └─ dist/server/index.js --host 127.0.0.1 --port <chosen port>
  └─ once /api/health is ready, BrowserWindow loads the local service
```

The server runs as a sidecar child process, reusing `dist/server` and `web/dist`; the frontend keeps using `appUrl("/ws")` and `location.host`, with no separate desktop wire protocol. A startup timeout, or the sidecar exiting before ready, makes the desktop app exit non-zero. Quitting the app cleans up the sidecar; on macOS the app can stay resident after all windows close; the current implementation exits when the Dock icon is clicked again, so the app has to be restarted. Only a full quit ends the service. A single-instance lock is used to focus the existing window on a second launch.

Keep these constraints when maintaining:

- [main.ts](./main.ts) is the main-process entry, [preload.cts](./preload.cts) provides the window and update IPC, [startup.ts](./startup.ts) handles startup helpers, and [portable.ts](./portable.ts) handles portable path detection and environment injection.
- An ESM entry can't top-level `await app.whenReady()`: Electron fires ready only after entry evaluation finishes, so they'd wait on each other. Keep the `app.whenReady().then(...)` startup form.
- [electron-builder.yml](./electron-builder.yml) overrides the root package's CLI entry to `dist/desktop/main.js` with `extraMetadata.main`; `asar: false` lets the sidecar and native modules run straight from the filesystem.
- `npmRebuild: false` relies on the current `node-pty` N-API prebuilt binaries; when upgrading native dependencies, re-verify target platform support — it doesn't justify promising that no platform needs build tools.
- Icons come from `web/public/icons/icon-1024.png`. Windows targets are NSIS + dir, macOS DMG + ZIP, Linux AppImage. The macOS ZIP is for the updater; Windows NSIS artifact names stay space-free so feed and Release asset URLs stay consistent.

## Release and signing

[desktop-release.yml](../.github/workflows/desktop-release.yml) builds on Windows/macOS/Linux runners and uploads Release assets when a `v*` tag is pushed; a manual run only produces a workflow artifact. electron-builder generates the artifacts and update metadata with `--publish never`, then `gh release upload` uploads them.

The current Windows CI also runs `make-portable.mjs --skip-pack --zip --with-git --with-node`, so a portable ZIP successfully produced by that workflow tries to bundle Git and a standalone Node; a local basic build has neither download option by default. Before distributing, still verify `runtime/git/cmd/git.exe` and `runtime/node/node.exe` — partial extraction failures in the script only emit warnings.

Windows CI is wired to SignPath, but the signing step is allowed to fail and the current config uses `test-signing`; not every Release artifact can be treated as trusted-signed. The portable directory is assembled before the signature replaces the installer, so the installer's signature doesn't tell you the signing state of the app inside the ZIP.

Local electron-builder can take a signing certificate via `CSC_LINK` and `CSC_KEY_PASSWORD`. macOS Developer ID signing and notarization need the corresponding Apple credentials and environment, e.g. `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`; check the build output and the actual artifacts for success. SignPath doesn't replace macOS signing/notarization, and a self-signed certificate doesn't equal system trust. The full release flow is in the [release guide](../docs/release.en.md).
