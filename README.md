<div align="center">

# 💬 pi-web-ui

**English** | [Chinese (Simplified)](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.zh-CN.md)

*The polished browser cockpit for the [pi coding agent](https://pi.dev).*

<p>
  <a href="https://www.npmjs.com/package/pi-web-ui"><img src="https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm&label=pi-web-ui" alt="npm version"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white" alt="Node.js"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/xing-shuyin/pi-web-ui" alt="License"></a>
  <a href="https://www.npmjs.com/package/pi-web-ui"><img src="https://img.shields.io/npm/dm/pi-web-ui?label=downloads" alt="npm downloads"></a>
  <a href="https://github.com/xing-shuyin/pi-web-ui/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/xing-shuyin/pi-web-ui/ci.yml?branch=main&label=CI" alt="CI status"></a>
  <a href="https://github.com/xing-shuyin/pi-web-ui/stargazers"><img src="https://img.shields.io/github/stars/xing-shuyin/pi-web-ui?style=social" alt="GitHub stars"></a>
  <a href="https://github.com/xing-shuyin/pi-web-ui/fork"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat" alt="PRs welcome"></a>
</p>

Stream conversations, inspect tool calls, manage files, and run your workspace — all from one place.

![Git source control panel](https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot4.jpeg)

</div>

A web chat interface for the [pi coding agent](https://pi.dev). The agent runs
**in-process** via the pi SDK and streams events to the browser over WebSocket:
thinking blocks, tool calls, file trees, a built-in terminal, model management,
theme switching, and a full settings panel — tuned for daily development.

> **Requirements** — Node.js ≥ 22.19 and a configured pi install.

## More from the author

> **Building with DSH?**
>
> [**dsh-ui-tools**](https://github.com/xing-shuyin/dsh-ui-tools) is the author's companion project for building and extending UI tools in the DSH ecosystem.

## ✨ Highlights

| 💬 **Chat that works like you do** | 🖼️ **Files & images** | 🧩 **Extensible by design** | 🔒 **Private by default** |
| --- | --- | --- | --- |
| Streaming replies, steer & follow-up queueing, slash commands, multiple conversations per project, edit-&-re-ask. | Attach files, paste images, ask about pictures (vision bridge), preview anything with GBK fallback. | Drop-in UI **plugins** (extra top-bar tabs + agent tools) and standalone **themes** — no rebuild, no restart. | Loopback-only, credential-safe: provider keys & headers never reach the browser. |

## 📚 Table of Contents

- 🚀 [Features](#features)
- 🖼️ [Screenshots](#screenshots)
- 📦 [Install](#install)
- ⚡ [Quick start](#quick-start)
- 🖥️ [System service](#system-service)
- 🧩 [Plugins](#plugins)
- 🎨 [Themes](#themes)
- 🔒 [Security](#security)
- 🌐 [Reverse proxy (nginx)](#reverse-proxy-nginx)
- 🤝 [Contribute](#contribute)
- 📄 [License](#license)

## Features

### 💬 Chat

- **Streaming agent chat over WebSocket** — the pi SDK runs in-process; events are pushed as snapshots (60 ms throttled) and the browser renders them.
- Thinking blocks, tool-call cards and bash outputs with live status (running → finished · waiting for the model · duration).
- **Steer (follow-up queueing)** — send a follow-up while the agent is replying; it is queued and injected as soon as the current turn's tool calls settle (the "Interrupt" equivalent of the pi CLI).
- **Slash commands** — `/` opens a command picker (built-in / extension / template / skill); built-ins include `/new /model /compact /cwd /thinking /resume`, plus `/help` (command list) and `/copy` (copy last reply).
- **Multiple conversations per project** — each conversation gets its own agent runtime and keeps running in the background after you switch away; the "Running conversations" list shows stream progress and lets you switch back.
- **Edit & re-ask** — fork any past question into a new branch and re-prompt; the original conversation stays untouched.
- Long threads auto-collapse messages older than 30 into lazy summary rows (click to expand).
- Question navigation — a floating rail plus per-question tags to jump between questions.

### 🖼️ Files, images & attachments

- Three attachment modes: `inline` (≤12 KB), `reference` (path only), `lines` (selected ranges) — over-limit ones degrade automatically.
- Paste / drag-drop / upload images — resized client-side and sent as image content when the model supports vision (warning otherwise).
- **Vision bridge** — when the current model is text-only, images are transcribed into text evidence by an auto-discovered vision model (cached per batch; model & on/off configurable in Settings).
- Attach arbitrary files without a workspace path — stored in a global uploads dir, inlined when small, referenced by absolute path otherwise.
- File preview — line numbers, click/drag/Shift selection (add to chat as `lines`), GBK fallback decoding, binary hex view, media preview over HTTP with Range support, and a download button.
- Live file tree — the server watches the listed directory (`fs.watch`) and re-lists on change; oversized directories show a truncation warning.

### 🖥️ Terminal & Git

- Built-in terminal (xterm.js + node-pty) with per-client PTY management; Windows auto-selects Git Bash (busybox fallback).
- **Source control (Git) panel** — status / branch / diff / untracked files via a hidden query terminal; commit, switch branch, push and pull run in the visible terminal and auto-switch to the terminal view.

### 🎛️ Models & settings

- Theme switching — pick a theme in the top bar; themes are pure `:root` palette overrides on top of the single layout stylesheet (default dark + bundled light/dark palettes). See [Themes](#themes) for how to add your own or contribute one.
- Model management — edit `models.json` in the UI and set per-provider API keys (keys/headers never leave the server).
- Thinking level per model (only the levels the model actually supports are shown).
- First-run setup wizard.
- Settings panel — system prompt (append or replace), toggle skills/extensions on/off with immediate effect, save/apply/delete settings presets, and vision-bridge model & switch.

### 🎯 Goal mode

- Goal bar — set a target with a review model, max rounds and a lock switch.
- Goal wizard (**AI Refine**) — turns a raw request into a concrete goal through a guided questionnaire.
- Automatic review loop — after each turn an independent review session checks the goal against the final text and `git diff HEAD`; on fail the feedback is injected as steer until it passes (or the round cap is hit).

### 🤖 DeepSeek Harness engine

- **Switchable engine** — `PI_WEB_ENGINE=pi|dsh` (default `pi`). The pi engine runs the agent in-process via the pi SDK; the **DSH engine** runs the official [`@deepseek-ai/dsh`](https://github.com/deepseek-ai/dsh) (DeepSeek Harness) runtime as a subprocess. `/api/health` reports `engine`; the footer shows a DSH badge.
- **Same wire protocol** — the DSH engine implements the same WebSocket protocol, so goal mode, SCM, background tasks, settings, plugins, terminals, message-delta & snapshots all work identically.
- **Native goal machinery** — DSH's own goal state machine + round-driver auto-continues rounds; the model judges completion/blocked (no separate review session). The goal wizard drives it via the model's `ask_user_question`.
- **Real image blocks** — photos are sent as true image content to vision-capable DeepSeek models (e.g. `deepseek-v4-flash-vision-exp`); text-only models get a text-transcription bridge instead.
- **Question dialog** — the model's `ask_user_question` surfaces as a browser dialog (single/multi-select + free text) with queueing and a countdown.
- **Tools & MCP bridge** — plugin AI tools and external MCP servers (`mcp.json`) are bridged into the DSH runtime, so the DSH model can call them (executed server-side).
- **Skill enable/disable** — the DSH skill catalog is exposed in Settings; disabling a skill filters it out of the model's view at runtime.
- **DSH user patches** — drop `.yml` Cordis patches into `<dataDir>/dsh-patches/` to extend the runtime and reload from Settings.

### ⚙️ Background tasks

- Background-task panel — servers launched by the agent are detected via port snapshots and listed (port/pid/name); stop one or kill all.
- Tool watchdog — a tool call running over 20 minutes is aborted automatically.
- **Stop bash command only** — abort a running bash tool without killing the conversation.

### 🛡️ Safety & operations

- Loopback-only by default; set `PI_WEB_HOST=0.0.0.0` for LAN / containers.
- WebSocket Origin/Host same-authority check — cross-origin pages are rejected (403); `PI_WEB_ALLOW_ORIGINS` whitelist for reverse proxies.
- Quiesce drain mode via a local control socket (`server status|quiesce|unquiesce`).
- Credentials stay server-side — provider headers are never sent to the browser.
- Sound alerts, Chinese/English UI, and a recent-projects list (click to switch workspace).

### 🚢 Deploy & update

- Foreground, global npm install, Docker (docker-compose), macOS launchd, Linux systemd, Windows Task Scheduler, and a desktop shortcut (`server shortcut`).
- In-app self-update — checks the npm registry, installs and auto-restarts the service.


## Screenshots

<table>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot1.png" alt="Settings panel"><br><sub>Settings panel</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot2.jpeg" alt="Built-in terminal"><br><sub>Built-in terminal</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot3.jpeg" alt="Chat interface"><br><sub>Chat interface</sub></td>
    <td align="center"><img src="https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/assets/shot4.jpeg" alt="Git source control panel"><br><sub>Git source control panel</sub></td>
  </tr>
</table>


## Install

```bash
npm i -g pi-web-ui            # global install (recommended)
npx pi-web-ui                 # or run without installing (latest, starts on :8787)
npm i -g .                    # or install the local checkout
```

**npm ≥ 12?** npm 12+ blocks dependency install scripts by default (you'll see
`npm warn install-scripts … blocked`). node-pty is a native module, so allow its
script (the other two packages it lists are harmless no-ops — allowing them just
silences the warning):

```bash
npm i -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```


## Quick start

**Start (foreground)**

```bash
pi-web-ui                                           # foreground, http://localhost:8787
```

**Start flags & environment variables** — every setting can be passed as a `--flag` on the command
line **or** set as an environment variable (flag wins). Pick whichever you prefer:

| Flag | Env var | Default | Purpose |
| --- | --- | --- | --- |
| `--port <n>` | `PI_WEB_PORT` | `8787` | HTTP port |
| `--cwd <dir>` | `PI_WEB_CWD` | current dir | workspace root (read/write/terminal) |
| `--data-dir <dir>` | `PI_WEB_DATA_DIR` | `~/.pi-web` | data dir (sessions, plugins, uploads) |
| `--engine <pi\|dsh>` | `PI_WEB_ENGINE` | `pi` | agent engine; `--engine dsh` = DeepSeek Harness |
| `--host <addr>` | `PI_WEB_HOST` | `127.0.0.1` | listen address (`0.0.0.0` for LAN/Docker) |
| `--agent-dir <dir>` | `PI_CODING_AGENT_DIR` | `~/.pi/agent` | pi config dir (auth.json, models, skills) |
| _env only_ | `PI_WEB_TOKEN` | empty | optional shared auth token |
| _env only_ | `PI_WEB_DSH_*` | — | dsh runtime, patches & debug settings |

The two are equivalent — pick one:

```bash
pi-web-ui --engine dsh --port 9000 --cwd /path/to/project
PI_WEB_ENGINE=dsh PI_WEB_PORT=9000 PI_WEB_CWD=/path/to/project pi-web-ui
```

For the DSH engine also install the runtime (`npm i -g @deepseek-ai/dsh@0.1.1-rc.2`) and set a
DeepSeek API key (read from `~/.pi/agent/auth.json`, set in the provider/API-key panel).

**Stop**

- **Foreground**: press `Ctrl+C` in the terminal running it.
- **As a service**: `pi-web-ui server stop` (stops the instance; auto-start stays until `server uninstall`).

**Update**

```bash
npm i -g pi-web-ui@latest     # upgrade to the latest published version
pi-web-ui server restart      # restart the service to apply it (foreground: restart manually)
```

**Uninstall**

```bash
npm uninstall -g pi-web-ui
```

Uninstalling does **not** delete your chats — session data lives in
`<cwd>/.pi-web` (or `PI_WEB_DATA_DIR`) and survives uninstall/upgrade.


## System service

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project   # install + start
pi-web-ui server status                     # running? auto-start?
pi-web-ui server restart                    # restart (applies config/version changes)
pi-web-ui server stop                       # stop (auto-start stays)
pi-web-ui server start                      # start again
pi-web-ui server uninstall                  # remove the service entirely
pi-web-ui server shortcut                   # desktop one-click launch icon
pi-web-ui server quiesce                    # drain: refuse NEW chats/messages, let running ones finish
pi-web-ui server unquiesce                  # reopen admission
```

`server status` also shows live stats via a local control socket (version,
PID, quiesce state, connected browsers, running conversations) — the same
socket drives `quiesce`/`unquiesce`.

- **macOS** → launchd agent (no sudo), logs to `/tmp/pi-web-ui.log` / `.err`
- **Linux** → systemd unit (`systemctl enable --now`), logs via `journalctl -u pi-web-ui -f`
- **Windows** → Task Scheduler logon task (hidden PowerShell window, no black console)

Options: `--port` (default 8787), `--cwd` (workspace), `--data-dir` (sessions),
`--engine <pi|dsh>`, `--host`, `--agent-dir`, `--name` (custom service name). Rerunning
`server install` with new options regenerates the config and restarts the service — that's how
you change its port/cwd/engine. `--engine` / `--host` / `--agent-dir` are baked into the service
automatically; env-only vars (`PI_WEB_TOKEN`, `PI_WEB_DSH_*`) must be added to the service config
by hand. See the [start flags table](#quick-start) above.

```bash
pi-web-ui server install --engine dsh --port 9000 --cwd /path/to/project
```


## Plugins

Plugins are optional UI components (extra top-bar tabs backed by their own
client view, optionally with a server-side entry and agent tools). They live in
your **data-dir plugins folder** (`<dataDir>/plugins/<id>/`, default
`~/.pi-web/plugins/`) — a plugin is simply a directory containing
`manifest.json`, an optional server entry (`index.mjs`) and an optional view
entry (`client/entry.mjs`). No plugin directories = no plugins, nothing shows
up in the UI.

### Plugin catalog

These plugins ship in this repository (`plugins/<id>/`) and can be installed
straight from GitHub:

| Plugin | What it does |
| --- | --- |
| 📬 [webmail](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail) | IMAP inbox browsing / search / read / mark / delete + SMTP sending, new-mail notifications, and an optional "allow AI to manage my mailbox" switch (six `mail_*` agent tools). Auto-installs its npm deps on first activation. |
| 🗄️ [db-client](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client) | Database workbench: connection manager + schema tree for MySQL / PostgreSQL / SQLite / SQL Server / MongoDB / Redis — table structure, paginated data with sorting, SQL editor, and row editing. Drivers auto-install on first use. |
| 📝 [vscode-editor](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor) | VS Code-like workbench: multi-root file tree (local + SSH hosts), CodeMirror multi-tab editor, Remote-SSH remote file browsing/editing, draggable multi-terminal panel (xterm.js), SFTP sync & upload/download to your computer. Auto-installs `ssh2`. |
| 📬 [demo-mailbox](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/demo-mailbox) | Minimal example plugin demonstrating the server entry + client view + two-way message protocol. Doubles as the plugin test fixture — start here if you want to write your own. |

Example — install the webmail plugin:

```bash
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail
```

Each plugin's directory in the repo has its own `README.md` with full feature
lists, configuration and per-plugin caveats.

### Installing

From GitHub (any of these source forms):

```bash
pi-web-ui install owner/repo                                  # shorthand
pi-web-ui install https://github.com/owner/repo               # full URL (.git optional)
pi-web-ui install https://github.com/o/r/tree/dev/sub/dir     # branch + subdirectory inside the repo
pi-web-ui install owner/repo#v1.2                             # pin a branch/tag (#suffix works on any form above)
pi-web-ui install /path/to/plugin-dir                         # local directory (for development)
```

Useful options:

- `--name <id>` — custom plugin id / directory name (defaults to the repo or
  subdirectory name; letters/digits/`-`/`_` only).
- `--force` — overwrite an existing installation. Your plugin's local
  `config.json` (credentials etc.) is preserved across upgrades.
- `--data-dir <dir>` — override the data dir (default `~/.pi-web`).

The CLI clones the repo (shallow; falls back to a tarball download without
git), locates the `manifest.json` (including inside subdirectories) and copies
the plugin into `<dataDir>/plugins/<id>/`.

**No git? No network?** You can also just copy a plugin directory into
`~/.pi-web/plugins/` by hand — same result.

### Updating

Re-run `install` against the same source with `--force`:

```bash
# example: update the webmail plugin to the latest version in the repo
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/webmail --force
```

- The upgrade preserves the plugin's local `config.json` automatically.
- Plugins that store other local state inside their directory (e.g. db-client's
  `db-connections.json`, vscode-editor's `ssh-hosts.json`) are **not** covered
  by that preservation — back those up before a forced reinstall.
- Refresh the browser afterwards; no server restart needed.

### Activating

If the server is running, just **refresh the browser** — new plugins are picked
up on attach without a restart. If it isn't, they load on next start. Each
plugin appears as a tab (🧩 or its own icon) in the top bar.

### Listing / disabling / uninstalling

```bash
pi-web-ui plugins             # list installed plugins (id / name / version / description)
pi-web-ui uninstall <id>      # remove a plugin
```

- To temporarily hide a plugin without uninstalling, use the **Settings panel
  (⚙) → UI plugins** switches — stored per client, purely visual, no restart
  needed. Re-enable any time.
- `uninstall` deletes the plugin directory; refresh the browser and its tab
  disappears. Plugin configuration written inside the plugin dir is removed
  too — back up `<dataDir>/plugins/<id>/config.json` first if you need it.


## Themes

Each theme is a **pure `:root` palette override** — a small CSS file that only sets CSS variables (see the `:root` block in `web/src/styles.css` for the full variable list: base colors `--bg/--accent/--term-*` plus derived colors like `--tooltip-bg/--code-bg/--notice-*`). The layout lives ONLY in the bundled `web/src/styles.css`; picking a theme overrides the variables, so every theme works with every build and layout changes never touch themes. Built-in themes are generated by `node make-light-theme.mjs`.

Built-in themes ship in the npm package (`themes/`, e.g. the bundled light theme). The theme picker lives in the top bar (🌞 icon); the current choice is stored per browser in `localStorage`.

### Using a theme

Just pick it in the top bar — built-in and user themes are merged in the same menu. User themes win over built-ins on the same id.

### Providing a theme locally (no GitHub needed)

Any CSS file dropped into your **data-dir themes folder** shows up in the theme menu automatically — no restart, no rebuild:

1. Find your data dir (default `~/.pi-web`, override with `PI_WEB_DATA_DIR`).
2. Create `<dataDir>/themes/` and drop your stylesheet in: e.g. `~/.pi-web/themes/my-theme.css`.
3. Reload the page and pick it in the top bar. The **file name (without `.css`)** is the theme id shown in the menu.

```
~/.pi-web/
└── themes/
    └── my-theme.css          # appears in the menu as "my-theme"
```

Easiest way to write one: copy a built-in palette (e.g. `themes/white.css` from the source repo) and change the `:root` colors — list every variable you want to override; unlisted ones fall back to the dark defaults in `styles.css`. Notes:

- The **terminal follows the theme** — set the `--term-*` variables (terminal ANSI palette + `--term-bg`) in your `:root` and both the xterm canvas and its padded container adapt automatically (see the defaults in `styles.css`).
- Syntax-highlight colors (`highlight.js`'s `github-dark.css` is bundled) must be overridden in your theme file or code will be unreadable on light themes — see the `.hljs` overrides at the bottom of `themes/white.css` for the pattern (dark themes can skip it).
- Theme ids must match `^[A-Za-z0-9_-]+$` (no dots/slashes — path-traversal guard on the server).

### Contributing a theme to the repository (GitHub)

Want your theme shipped to everyone? Open a pull request at [github.com/xing-shuyin/pi-web-ui](https://github.com/xing-shuyin/pi-web-ui):

1. Fork the repo and clone it.
2. Create your theme as `themes/<id>.css` — a pure `:root` palette. Copy `themes/white.css` (or `themes/cyberpunk.css` for a dark palette) as the starting template.
3. Verify locally: run `npm run dev`, then use the top bar theme picker — your theme must be listed and render correctly (chat cards, code blocks, tool-call cards, git/terminal panels).
4. Regenerate all built-in themes with `node make-light-theme.mjs` when you changed the variable list in `styles.css`.
5. Commit (`git add themes/<id>.css`) and open the PR. The `themes/` folder is already in the npm package `files` whitelist, so once merged and released, `npm i -g pi-web-ui` will ship your theme to everyone.

Rules for merged themes: the file must be a single CSS file, set the `--term-*` variables for a readable terminal, and override `.hljs` syntax colors for readable code on light themes.


## Security

- **Loopback-only by default** — the server binds `127.0.0.1` and is not
  reachable from the network unless you explicitly set `PI_WEB_HOST=0.0.0.0`
  (e.g. LAN access, Docker port mapping — the compose file sets it for you).
- **WebSocket origin check** — browser pages connecting to `/ws` must present
  an `Origin` whose hostname **and port** match the request `Host`;
  cross-origin pages are rejected with 403. Non-browser clients (no `Origin`)
  are unaffected. Add `PI_WEB_ALLOW_ORIGINS=http://your-host:port` for
  reverse-proxy setups.
- **Quiesce** — `server quiesce` refuses new prompts/forks/session resumes
  until you `server unquiesce`; in-flight runs finish cleanly (useful before
  upgrades/backups).
- **Credentials stay server-side** — provider `headers` (which may carry
  `Authorization` / API keys) are never sent to the browser; the model
  management UI edits everything else and the server preserves the headers.


## Reverse proxy (nginx)

Serve pi-web-ui behind nginx on the same host (it binds loopback only, so a
same-machine reverse proxy is the supported remote-access path — no
`PI_WEB_HOST=0.0.0.0` needed):

```nginx
# pi-web-ui on 127.0.0.1:8787, exposed as https://your-host/pi/
server {
    listen 443 ssl;
    server_name your-host;
    # ssl_certificate ... / ssl_certificate_key ...

    # App entry at a sub-path (strips the /pi/ prefix)
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # $http_host keeps the port — the server's origin check compares the
        # full authority (hostname AND port). $host would drop it and get 403.
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket — MUST forward Host identically or the upgrade is 403'd
    # (page loads, but chat/terminal keep reconnecting)
    location /ws {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # Absolute-path assets/API the built frontend requests (root, not /pi/)
    location /assets/  { proxy_pass http://127.0.0.1:8787; }
    location = /favicon.svg           { proxy_pass http://127.0.0.1:8787; }
    location = /favicon-streaming.svg { proxy_pass http://127.0.0.1:8787; }
    location = /api/file   { proxy_pass http://127.0.0.1:8787; }
    location = /api/health { proxy_pass http://127.0.0.1:8787; }
}
```

Key points:

- **`Host` must be `$http_host`** (keeps the port) on both `/pi/` and `/ws` —
  the origin check compares hostname **and** port. `proxy_set_header Host $host`
  or leaving it unset (defaults to the upstream `127.0.0.1:8787`) both fail with 403.
- **Same-origin works automatically**: as long as the browser's `Origin` equals
  the forwarded `Host` (it does through a plain proxy), no
  `PI_WEB_ALLOW_ORIGINS` is needed. Only set it when the browser origin differs
  from the Host the server sees (e.g. a TLS-terminating proxy that changes the
  port).
- **No `proxy_protocol` unless you really need real client IPs**: it makes
  nginx reject every connection that does not send a PROXY header, which
  breaks direct LAN access and any non-frp clients. With frp, drop
  `transport.proxyProtocolVersion` from the proxy config unless nginx listens
  with `proxy_protocol` too.
- **LAN access without a proxy**: just set `PI_WEB_HOST=0.0.0.0` (and a
  firewall rule) — or put the whole server block above on port 80/443.

Full working example (with an frp tunnel): `deploy/nginx-subpath.conf`.


## Contribute

pi-web-ui is a small open-source project — **your contributions are what make it grow**. Code, plugins, themes, docs, translations, ideas: everything is welcome, and every merged PR ships to all users with the next `npm publish`. ❤️

| Way to contribute | How to get started |
| --- | --- |
| 🧩 **Write a plugin** | Build your own UI tab + agent tools. Copy `plugins/demo-mailbox` as the minimal template (it doubles as the test fixture), develop locally, then either open a PR to ship it in the [catalog](#plugin-catalog) or [publish it standalone](https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins). |
| 🎨 **Contribute a theme** | Copy `themes/white.css` (light) or `themes/cyberpunk.css` (dark) as a pure-palette template, tweak the `:root` palette + `--term-*` + `.hljs`, verify with `npm run dev`, then open a PR — full walkthrough in [Contributing a theme](#contributing-a-theme-to-the-repository-github). |
| 💻 **Fix a bug / add a feature** | Look for [open issues](https://github.com/xing-shuyin/pi-web-ui/issues) or propose something new. Fork → branch → PR. Keep the code conventions in `AGENTS.md` (tabs, i18n keys in both languages, protocol changes in `server/protocol.ts`). |
| 📖 **Docs & translations** | Improve the READMEs, write plugin docs, fix typos, or help translate the UI / docs into more languages. |
| 💡 **Ideas & feedback** | Open an [issue](https://github.com/xing-shuyin/pi-web-ui/issues) or start a [discussion](https://github.com/xing-shuyin/pi-web-ui/discussions) — feature requests, bug reports, UI polish ideas, deployment experience reports. |

**Before opening a PR**, a quick sanity pass keeps reviewers happy:

- `npm run format` — prettier formatting (tabs, width 120; CI checks it).
- `npm run check:protocol` + `npm test` — protocol sync and unit tests.
- `npm run typecheck` — no type errors.
- `npm run build` — both frontend and backend compile.
- For protocol changes: add branches in both `server/index.ts` and `web/src/use-chat.ts` (see the "Protocol single source" note in `AGENTS.md`).

> Enjoying pi-web-ui? Give the repo a ⭐ — it helps others find it. And if you
> built something cool on top (plugin, theme, deployment recipe), tell us — we
> love showcasing community work.


## License

[MIT](LICENSE)