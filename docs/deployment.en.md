**English** · [简体中文](./deployment.md) · [繁體中文](./deployment.zh-TW.md)

# Deployment

pi-web-ui is a pure web service (Node + Express + WebSocket); it also ships an **Electron desktop shell** (`desktop/`, see `desktop/README.md`) — it starts the same server + BrowserWindow on a random free port with zero changes to the web version, and three-platform installers (Windows/macOS/Linux) are published with GitHub Releases (built by CI, currently unsigned).

## CLI

`pwu`, `piwebui` and `pi-web-ui` are equivalent commands of the same CLI; every subcommand and option is shared. Install or update globally and `pwu` is ready to use. Foreground start accepts an existing directory (relative or absolute path, quote it when it contains spaces), which cannot be combined with `--cwd`; the directory argument takes precedence over `PI_WEB_CWD`. For a directory named like a subcommand, use `./目录名` or `--cwd`.

```bash
pwu .                                    # start in the current directory
pwu ./my-project --port 9000              # start in the given directory
pi-web-ui --port 9000 --cwd /path          # foreground
pi-web-ui install <源> [--name --force --data-dir]  # install a GitHub UI plugin into <dataDir>/plugins/
#                                source: owner/repo · https://github.com/o/r[/tree/分支/子目录] · #分支 · local directory; takes effect on browser refresh
pi-web-ui plugins / uninstall <id>          # list / uninstall UI plugins
pi-web-ui plugins --check-updates          # compare against the remote HEAD one by one, list updatable plugins
pi-web-ui plugins --rollback <id>          # roll back to the most recent pre-update backup (<dataDir>/plugin-backups/)
pi-web-ui server install [--port --cwd --data-dir --name]   # start on boot:
#                                           #   macOS→launchd (no sudo needed)
#                                           #   Linux→systemd (auto sudo)
#                                           #   Windows→login autostart Run key (HKCU, no admin needed; wscript hidden launch, no console window)
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # desktop "one-click launch" icon (start the service and open the browser):
#                                           #   Windows→desktop .lnk (WScript.Shell COM, OneDrive-safe; if the service is not running, it
#                                           #     starts in the foreground in a hidden window and records the PID, so server stop/uninstall can stop it)
#                                           #   macOS→desktop .command double-click launcher (kickstart if launchd is installed, otherwise foreground in a terminal)
#                                           #   Linux→desktop .desktop icon + ~/.local/share/pi-web-ui launch script (systemctl preferred)
pi-web-ui server status|restart|stop|uninstall
# Docker: docker-compose.yml (port mapping + mounted data directory)
```

> Windows autostart service = HKCU logon Run key + wscript/VBS hidden launcher (generated in `%APPDATA%\pi-web-ui\`,
> no console window, no admin needed); the ps1 has a built-in watchdog that restarts the server 10 seconds after a crash. Task Scheduler installs
> from older versions migrate automatically during install (the task is deleted, the Run key is used instead). When --cwd is not given at
> install time, the service defaults to the user's home directory as its working directory (foreground start still defaults to the current directory).

> uninstall removes the desktop icon automatically; when no service is installed, instances started from the desktop shortcut are reported separately in status/stop (PS1 foreground + recorded PID).

## Engine selection

The pi engine is the default (`@earendil-works/pi-coding-agent` SDK, in-process). Pass `--engine dsh`
(or set `PI_WEB_ENGINE=dsh`) to switch to the DeepSeek Harness (DSH) child-process engine:

```bash
pi-web-ui --engine dsh --port 9000 --cwd /path        # flag wins
PI_WEB_ENGINE=dsh pi-web-ui --port 9000 --cwd /path   # environment variable fallback
```

- **Switchable at runtime**: the engine selector in the UI switches between pi, DSH, Claude Code, Codex and Durable; the startup argument sets the default engine.
- **Shared UI protocol**: all engines share `server/protocol.ts`; the supported goals, review, tools and session operations are governed by capability declarations.
- For the DSH architecture and differences, see `docs/dsh-engine.md`.
- **Codex**: run `npm i -g @openai/codex` and `codex login` first, then switch in the selector, or start with `pi-web-ui --engine codex --cwd /path`. It reuses the local Codex configuration and authentication; see the Codex CLI engine section of `docs/architecture-core.md` for details.

Every other foreground-start setting is a flag too: `--port` / `--cwd` / `--data-dir` / `--host` /
`--agent-dir` (flag first, environment variable as fallback).

### DSH runtime tree (required dependency)

The DSH engine starts the official `@deepseek-ai/dsh` runtime as a child process and needs a complete runtime tree:

```bash
npm i -g @deepseek-ai/dsh@0.1.1-rc.2   # global install (ships the nested runtime tree, ~196 packages)
```

Runtime tree resolution order: `PI_WEB_DSH_RUNTIME` (explicit) → this package's node_modules →
node_modules next to `execPath` → `npm root -g`. All three layouts (full install in this package / fnm / global)
hit; when resolution fails, server startup reports an error with a hint. Diagnostics: `PI_WEB_DSH_DEBUG=1` dumps
runtime RPC frames and lifecycle events to stderr.

### DSH environment variables at a glance

| Variable                            | Default           | Purpose                                                                                           |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `PI_WEB_ENGINE`                     | `pi`              | Engine: `pi` / `dsh` / `claude` / `codex` / `durable` (startup default, hot-switchable in the UI) |
| `PI_WEB_DSH_RUNTIME`                | auto-resolved     | Runtime tree root (node_modules root containing `@deepseek-ai/dsh-base`)                          |
| `PI_WEB_DSH_DATA_DIR`               | `PI_WEB_DATA_DIR` | DSH-specific data directory (user patch layer `<dir>/dsh-patches/*.yml`)                          |
| `PI_WEB_DSH_PATCH_DIR`              | empty             | Explicit override of the user patch directory (takes priority over derivation)                    |
| `PI_WEB_DSH_QUESTION_TIMEOUT_MS`    | `600000`          | Timeout of the model's ask_user_question bridge (frontend countdown)                              |
| `PI_WEB_DSH_SESSION_RETENTION_DAYS` | `90`              | Session JSONL retention in days (0 = disable cleanup)                                             |
| `PI_WEB_DSH_DEBUG`                  | empty             | `1` writes runtime diagnostics to stderr                                                          |

See `docs/env-vars.md` for the full list.

### User patch layer (dsh-patches)

The DSH engine stacks two patch layers on top of the official configuration: the built-in `override.patch.yml` plus the user layer. Put
`*.yml` files (cordis patch syntax, isomorphic to the official `cordis.patch.yml`) into
`<dataDir>/dsh-patches/` (or the directory given by `PI_WEB_DSH_PATCH_DIR`); the launcher loads them in
filename order after the override; the 「界面插件」(Interface plugins) tab of the settings panel lists them and offers a rescan (a rescan restarts the runtime).

### Service install (systemd / launchd) with an engine

`pi-web-ui server install` bakes `--engine` / `--host` / `--agent-dir` into the service configuration:

```bash
pi-web-ui server install --engine dsh --port 9000 --cwd /path
```

On Linux, `server install` writes the caller environment's `PI_WEB_TOKEN` into the systemd unit as well.
For ports 1–1023 (e.g. 80/443) it adds the following so the service runs as the original user without root:

```ini
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

Non-privileged ports such as the default 8787 get no extra capability. The installer generates the configuration before escalating, then
uses sudo only for the install files and the `systemctl` calls, so a sudo environment scrub cannot lose the port, host, token, PATH or the user's working directory.
Example (run in a normal user's Bash, no sudo prefix for the whole command):

```bash
read -rsp 'PI_WEB_TOKEN: ' PI_WEB_TOKEN; echo
export PI_WEB_TOKEN
PI_WEB_HOST=0.0.0.0 PI_WEB_PORT=80 pi-web-ui server install --cwd "$HOME/projects/pi-web-cwd"
unset PI_WEB_TOKEN
```

The unit is installed root-owned with mode 0600; the configuration is passed to the install command over stdin, so the token never lands on the command line.
Reinstalling triggers a daemon-reload and restarts the service, so the changed configuration takes effect immediately (this drops current connections).
Provide `PI_WEB_TOKEN` again on every reinstall; without it the generated unit has no such variable, and an explicit empty value clears the auth passphrase.
`--print` still installs nothing and escalates nothing, but prints the complete unit including the token — do not expose its output.
Environment variables are not secret storage: systemd's management interface and the service process can still expose the environment, so do not rely on file permissions alone to protect credentials.
Before listening on `0.0.0.0`, confirm the network exposure; public deployments should use a TLS reverse proxy — HTTP does not encrypt the passphrase.

DSH-specific runtime variables (`PI_WEB_DSH_RUNTIME` and friends) still have to be added to the service configuration by hand.
`PI_WEB_TOKEN` has no command-line flag; non-Linux platforms still need manual service configuration:

```ini
# systemd: the [Service] section of /etc/systemd/system/pi-web-ui.service
Environment=PI_WEB_DSH_RUNTIME=/usr/local/lib/node_modules
Environment=PI_WEB_DSH_DATA_DIR=/var/lib/pi-web-ui
Environment=PI_WEB_TOKEN=s3cret
# reload: sudo systemctl daemon-reload && sudo systemctl restart pi-web-ui
```

```xml
<!-- launchd: inside the dict of ~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist -->
<key>EnvironmentVariables</key>
<dict>
    <key>PI_WEB_DSH_RUNTIME</key><string>/usr/local/lib/node_modules</string>
    <key>PI_WEB_TOKEN</key><string>s3cret</string>
</dict>
<!-- reload: launchctl bootout gui/$(id -u)/com.xingshuyin.pi-web-ui && \
            launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist -->
```

Note: the launchd/systemd runtime environment is minimal (no PATH, no locale). If a global `dsh` is installed in a user directory
(e.g. `~/.local`), point `PI_WEB_DSH_RUNTIME` at it explicitly, otherwise resolution fails.

## Subpath reverse proxy (nginx mounted under /pi/ and similar)

When the page is served at `https://example.com/pi/` instead of the root, nginx must **strip the prefix** before forwarding.
The browser side derives the app root (/pi/) from the page baseURI automatically; plugin bundles, the WebSocket (`/pi/ws`),
`/api` and `/themes` requests all carry the `/pi/` prefix.

```nginx
# Together with the WebSocket upgrade map (recommended in the http {} block):
# map $http_upgrade $connection_upgrade {
#     default upgrade;
#     ''      close;
# }

server {
    listen 80;
    server_name example.com;

    # Subpath WebSocket: the frontend connects to /pi/ws under the /pi/ base path; strip the prefix and forward to /ws
    location /pi/ws {
        proxy_pass http://127.0.0.1:8787/ws;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # The key is the trailing / in proxy_pass: the /pi prefix is stripped before passing to the backend (8787 is the default port)
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # WebSocket upgrade headers must be forwarded
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # $http_host is required to keep the port (the server-side Origin check includes hostname and port; $host drops the port and causes a 403)
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Notes:

- **`Host` must use `$http_host`** (preserving the original port) — the backend's Origin check requires hostname and port to match exactly; using `$host` drops non-standard ports and triggers a 403.
- **Long connection timeouts**: WebSockets need an explicit `proxy_read_timeout 3600s;`, otherwise terminals or long AI answers drop unexpectedly after nginx's default 60s timeout.
- The official dist ships static assets with root-absolute paths (`/assets/...`), independent of the app root derivation in JS.
  To render the HTML under /pi/, pick one: ① add another `location /assets/ { proxy_pass
http://127.0.0.1:8787; }` to forward static assets; ② rebuild with `vite build --base=/pi/`
  (in the output, the assets references and `import.meta.env.BASE_URL` are both /pi/, consistent with the baseURI
  derivation; the two approaches can be mixed).
- The plugin directory (`<dataDir>/plugins/`) needs no separate nginx configuration — clients request
  `/pi/plugins/...`, which the backend's standard routes handle after the prefix is stripped. See `deploy/nginx-subpath.conf` for a complete example.
