# pi-web-ui

**English** | [简体中文](README.zh-CN.md)

A web chat interface for the [pi coding agent](https://pi.dev), built directly on
the **pi SDK** ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) —
no subprocess, no JSON-RPC shim. The agent runs in the server process and streams
events to the browser over WebSocket.

Inspired by [Pintra (pi-vsc)](https://github.com/bilalbentoumi/pi-vsc), which does
the same thing inside VS Code by spawning `pi --mode rpc`. This project instead
uses the SDK's `createAgentSessionRuntime` API in-process (the SDK docs recommend
this over RPC for Node.js apps), so you get type safety, direct state access, and
your existing pi auth/config/extensions — nothing extra to install or configure.

## Features

- 🧠 Full agent loop with **thinking** blocks (collapsible) and streaming text
- 🛠 Tool execution cards with **live output streaming**, status (queued → running → done/error), and copyable arguments
- 💬 Session **history persisted per browser** (localStorage clientId + per-client session dirs) — refresh or restart and your chats come back. The conversation panel also lists the pi CLI/TUI sessions for the current folder (tagged `TUI`), so you can resume a terminal conversation from the web UI
- 📂 **Project memory**: the last workspace of each browser is remembered and restored on restart; a "Recent projects" list in the left panel switches workspaces in one click, and each project keeps its own sessions so you can always pick up an old conversation
- ✏️ **Edit & re-ask**: every past question has an edit button — change it and re-ask from that point. The server forks a new branch session (keeping the full history before that question) while the original conversation stays untouched in the session list
- ⚡ **Long chats stay fast**: past 30 messages, older messages collapse into summary rows (role + first-line preview + block counts — no Markdown/thinking/tool output rendered); click to expand the full content. The latest 15 messages always render in full
- ⬇️ **Self-update**: the top-right corner shows the running version; the update panel checks npm for the latest release and can run `npm i -g` in one click (a restart is required to take effect)
- 🔄 Model & thinking-level cycling (same as pi's TUI), new chat, abort/stop
- 📎 Markdown rendering with GFM tables, syntax-highlighted code blocks and copy buttons
- 📁 Workspace-aware: the agent reads/edits/runs code in a configurable directory using **your** `~/.pi/agent` auth, models, skills and extensions
- 🌐 Multiple browser clients each get an isolated session (private session dir per clientId)
- 🖥 Built-in **terminal** (xterm.js + node-pty, no VS Code needed): three panes — a
  **command list** on the left (user-defined commands with `${pwd}` support, persisted in
  the project's `.pi/commands.json`), the **terminal** in the middle, and a VSCode-style
  **tab strip** on the right for multiple concurrent shells. Switch between chat and
  terminal views with the toggle in the top bar.

## Quick start
## Screenshots

![pi-web-ui main interface](assets/shot.jpeg)

## Quick start

Requires Node.js ≥ 22.19 (the pi SDK requires it; older Node fails with
`Unexpected token 'with'` when loading the SDK) and a configured pi install
(run `pi` once to log in).

```bash
npm install
npm run dev          # server on :8787, web UI on :5173 (auto-proxied)
# open http://localhost:5173
```

Production:

```bash
npm run build        # compiles server (tsc) + frontend (vite)
npm start            # serves everything on http://localhost:8787
```

## npm package (install / start / stop / update / uninstall)

The package is published on npm as [`pi-web-ui`](https://www.npmjs.com/package/pi-web-ui).

### Install

```bash
# install globally (recommended)
npm i -g pi-web-ui

# or run without installing (pulls the latest, starts on :8787)
npx pi-web-ui

# or install the local checkout (for testing changes before publishing)
npm i -g .
```

> **pi-managed npm?** If your `npm` is the pi wrapper that blocks dependency
> install scripts, approve node-pty's native build once after installing:
> `npm approve-scripts node-pty@1.1.0` (standard npm does this automatically).

### As a pi package (web UI inside pi)

`pi-web-ui` is also published as a **pi package** (`pi-package` on npm) so it
can be installed and used from within a pi session:

```bash
pi install npm:pi-web-ui
```

Once installed, a `/webui` command becomes available inside pi, launching the
local web UI against your current working directory:

```
/webui                      # start + open browser (current dir)
/webui --port 9000          # start on a specific port
/webui --no-browser         # start without opening the browser
/webui stop                 # stop the running instance
/webui status               # show URL / status
```

> **Note — `pi install` is NOT a global CLI install.**
>
> `pi install npm:pi-web-ui` only loads the package into pi's extension tree
> (`~/.pi/agent/npm/node_modules/`) and registers its extension for pi sessions.
> It does **not** put a `pi-web-ui` executable on your shell `PATH`, so you
> cannot run the `pi-web-ui` terminal command from that install. For the CLI you
> still need the global npm install above (`npm i -g pi-web-ui`), which is what
> `which pi-web-ui` resolves to. `pi install` ≠ `npm i -g`: one is for pi
> extensions, the other for a system-wide command. Both can coexist (the global
> 0.x CLI for terminal use, the pi package for the `/webui` in-pi entry).

### Start

```bash
pi-web-ui                                            # foreground, http://localhost:8787
PORT=9000 PI_WEB_CWD=/path/to/project pi-web-ui      # custom port / workspace
```

To run it in the background or auto-start on boot, use a system service —
see [Deploy &amp; auto-start on boot](#deploy--auto-start-on-boot) (systemd /
launchd / Docker).

The `pi-web-ui` command serves the built frontend and the WebSocket API from
wherever the package is installed — no repo checkout needed. It uses **your**
`~/.pi/agent` config (auth/models/skills) and stores per-client sessions under
`<PI_WEB_CWD>/.pi-web`.

### Stop

- **Foreground**: press `Ctrl+C` in the terminal running it.
- **systemd**: `sudo systemctl stop pi-web-ui`
- **launchd**: `launchctl bootout gui/$(id -u)/com.xingshuyin.pi-web-ui`
- **Windows (scheduled task)**: `pi-web-ui server stop` (or
  `schtasks /End /TN pi-web-ui`; stops the running instance, auto-start stays
  until `server uninstall`)
- **Docker**: `docker compose stop` (stop + remove the container: `docker compose down`)

(Background processes should be managed by a system service, not `nohup` —
service stop commands above also stop and disable auto-start.)

### Verify / version

```bash
pi-web-ui --version     # CLI version
npm ls -g pi-web-ui     # installed? which version?
which pi-web-ui         # executable location
```

### Update

```bash
npm i -g pi-web-ui@latest   # upgrade to the latest published version
# restart the server afterwards for the new version to take effect
```

### Uninstall

```bash
npm uninstall -g pi-web-ui
```

Uninstalling does **not** delete your chats: session data lives in
`<PI_WEB_CWD>/.pi-web` (or `PI_WEB_DATA_DIR`) and survives uninstall/upgrade.

### Manage as a system service (auto-start)

Install the server as a system service that starts on boot, with a custom
port and workspace:

```bash
pi-web-ui server install --port 9000 --cwd /path/to/project   # install + start
pi-web-ui server status                # running? auto-start?
pi-web-ui server restart               # restart (also applies config changes)
pi-web-ui server stop                  # stop + disable auto-start
pi-web-ui server start                 # start again
pi-web-ui server uninstall             # remove the service entirely
```

- **macOS** → launchd agent (no sudo): writes and loads
  `~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist`, restarts on crash
  (`KeepAlive`), logs to `/tmp/pi-web-ui.log` / `/tmp/pi-web-ui.err`.
- **Linux** → systemd unit (auto-sudo): writes
  `/etc/systemd/system/pi-web-ui.service` and runs `systemctl enable --now`,
  logs via `journalctl -u pi-web-ui -f`.
- **Windows** → Task Scheduler: creates a user task that starts at logon
  (same as a launchd agent; usually no admin needed, but on some machines
  `schtasks /Create` requires an elevated PowerShell — if `install` fails
  with `ERROR: Access is denied`, rerun it from an admin shell). It runs a
  PowerShell launcher generated at
  `%APPDATA%\pi-web-ui\pi-web-ui.ps1` via `powershell.exe -WindowStyle Hidden` — no black console window stays open, so there's nothing to
  accidentally close/kill. The launcher sets env, cd's to the workspace,
  launches node, appends logs to `%USERPROFILE%\pi-web-ui.log`. The task XML
  is saved next to it; restarts on failure. **Always pass `--cwd`
  explicitly** — the task inherits the installing shell's directory, and an
  admin shell defaults to `C:\WINDOWS\system32`, which the non-elevated
  task cannot write to (EPERM at startup). See
  [Windows — Task Scheduler](#windows--task-scheduler) for details.
- Options: `--port` (default 8787 or `$PORT`), `--cwd` (default `$PI_WEB_CWD`
  or the current directory), `--data-dir` (sessions), `--name` (custom service
  name; on macOS the label is `com.xingshuyin.pi-web-ui`, custom names become
  `com.<name>.server`). `--print` previews the generated unit/plist/task files
  without applying it.
- Rerunning `install` with new options regenerates the config and restarts the
  service — that's how you change the port/cwd of an installed service.

## Configuration

| Env var                    | Default           | Description                                                                                                                                                                             |
| -------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | `8787`          | HTTP/WebSocket port                                                                                                                                                                     |
| `PI_WEB_CWD`             | server's cwd      | The workspace directory the agent operates in (read/edit/bash/write)                                                                                                                    |
| `PI_WEB_DATA_DIR`        | `<cwd>/.pi-web` | Where per-client session dirs are stored                                                                                                                                                |
| `PI_WEB_INLINE_FILE_MAX` | `12288` (12KB)  | Text attachments at or below this size are inlined into the model context; larger files are passed as path references and the model reads them on demand (saves tokens for small edits) |
| `PI_CODING_AGENT_DIR`    | `~/.pi/agent`   | pi config dir (auth.json, models.json, skills, extensions)                                                                                                                              |

Example — point the agent at a project:

```bash
PI_WEB_CWD=/path/to/your/project npm run dev
```

## Architecture

```text
Browser (React + Vite)
   │  WebSocket JSON — snapshot-driven protocol (server/protocol.ts)
   ▼
server/index.ts        express static + ws endpoint
   │
server/agent-service.ts   per-client ClientSession:
   │   createAgentSessionRuntime({ sessionManager: SessionManager.continueRecent(cwd, sessionDir) })
   │   session.subscribe(events) → throttled full-state snapshots + live tool deltas
   ▼
@earendil-works/pi-coding-agent (SDK, in-process)
   │   ModelRuntime (auth from ~/.pi/agent) · tools · extensions · skills
   ▼
   your LLM provider
```

Key design points:

- **Snapshot-driven UI.** The server is the source of truth: after every SDK
  event it schedules a throttled (60 ms) full-state snapshot, and the browser
  renders purely from snapshots. Reconnects just re-request `get_state`. Large
  payloads (tool output, text) are capped during serialization (`server/serialize.ts`).
- **Live assistant streaming.** The in-progress message (SDK
  `agent.state.streamingMessage`) is serialized into every snapshot, so thinking
  blocks and answer text appear in the browser as they are generated — with a
  blinking cursor — instead of only after the turn finishes. The partial message
  gets a stable `stream-<ts>` id so it stays mounted (open thinking/tool blocks
  keep their state) across snapshots.
- **Size-aware attachments.** Clicking + on a file queues it as an attachment
  (shown as chips above the input). On send, the server attaches each file as an
  independent custom message (SDK `sendCustomMessage` + `nextTurn` asides) — the
  user message stays clean, and each file renders as its own collapsible card:
  small text files (≤ `PI_WEB_INLINE_FILE_MAX`, default 12KB) are inlined so the
  model sees them immediately; larger files are passed as a `<file path=...>`
  reference and the model reads them on demand with its `read` tool, so attaching
  a 5 MB file costs only a few tokens until the model actually looks at it.
  Images are always attached as image content.
- **Image Q&A.** Besides attaching workspace images from the right panel, you
  can **paste a screenshot (Ctrl+V), drag an image onto the input bar, or use
  the 🖼 upload button** — the browser downscales it to ≤1568px and encodes it,
  and it travels with the message (`prompt.attachments[].imageData`, base64),
  no workspace path needed. Attaching an image to a non-vision model shows a
  warning (the image would be ignored).
- **File chat.** Any local file (text or binary) can be dropped onto the input
  bar or picked via the 📎 button — the browser sends the bytes as base64
  (`prompt.attachments[].fileData`), the server persists them under
  `~/.pi-web/uploads/<clientId>/` and attaches: small text files are inlined so
  the model sees them immediately; large/binary files become absolute-path
  references the model reads on demand (its read tool accepts absolute paths).
  Cap: 20MB.
- **File preview with line selection.** Click a file name (or its 👁 button) in
  the right panel to open a preview modal with line numbers. Click / drag /
  Shift+click to select a line range, then “添加到对话” to queue it as a `lines`
  attachment — the server inlines only the selected range
  (`<file path=... lines="2-3">`), so you can point the agent at exactly the
  code you mean without dumping the whole file. Preview reads are capped at
  512 KB and binary files are detected and refused.
- **Live tool output.** `bash_execution_update` / `tool_execution_update` events
  are forwarded as lightweight `tool_delta` messages so terminal output streams
  in real time; the final output arrives in the toolResult message on the next
  snapshot, which supersedes the delta buffer.
- **Isolated sessions.** Each browser client gets `sessions/<clientId>/` under
  the data dir, resumed on reconnect via `SessionManager.continueRecent`.
- **Everything you already have.** No separate auth step — the SDK reads
  `~/.pi/agent/auth.json` and loads your global extensions/skills automatically.

## Terminal

Toggle the terminal view from the top bar (对话/终端). It replaces the chat layout
with three panes:

- **Left — 命令 (commands)**: click a command to open a terminal tab in its directory and
  run it. Add/edit/delete commands in the panel; they are saved to
  `<project>/.pi/commands.json` (committed to the repo, shared with teammates):

  ```json
  {
    "commands": [
      { "name": "dev", "command": "npm run dev", "cwd": "${pwd}" },
      { "name": "test", "command": "npm test", "cwd": "${pwd}/server" },
      { "name": "build", "command": "npm run build", "cwd": "~/other-project" }
    ]
  }
  ```

  `${pwd}` resolves to the agent's current working directory (the one shown in the chat
  view's file panel, changeable via set_cwd); `~` and relative paths also work. The `+`
  button at the top of the command panel creates a new entry.
- **Middle — the terminal**: each tab is a real PTY (your `$SHELL` on
  macOS/Linux; PowerShell or cmd.exe — `$COMSPEC` — on Windows); output
  streams live and you can type, Ctrl+C, resize, etc. exactly like a desktop
  terminal. Git Bash users on Windows get their `$SHELL` automatically.
- **Right — 终端 (tabs)**: VSCode-style vertical tab strip. `+` opens a plain shell in the
  current directory. Closing a tab kills its process.

Notes:

- Running commands keep running while you switch back to the chat view.
- Terminals are killed when the last browser tab for a client disconnects (no orphaned
  dev servers), so a dropped connection resets the terminal view.

## Protocol

See `server/protocol.ts` for the full wire format. Client → server: `hello`,
`prompt`, `abort`, `new_chat`, `cycle_model`, `cycle_thinking`, `get_state`,
`list_sessions`, `switch_session`, `list_files`, `list_models`, `set_model`,
`set_thinking`, `set_cwd`, `complete_path`, `dialog_response`,
`terminal_create`, `terminal_input`, `terminal_resize`, `terminal_kill`,
`run_command`, `list_commands`, `save_commands`.
Server → client: `ready`, `snapshot` (full `UiState`), `tool_delta`, `notice`,
`terminal_output`, `terminal_exit`, `commands`.

## Scripts

| Script                             | What it does                                            |
| ---------------------------------- | ------------------------------------------------------- |
| `npm run dev`                    | server (tsx watch) + Vite dev server with WS proxy      |
| `npm run build`                  | type-check + build frontend and server                  |
| `npm start`                      | run the production server (serves`web/dist`)          |
| `npm run typecheck`              | `tsc --noEmit` for both server and web                |
| `node terminal-smoke-test.mjs`   | WS-level terminal/commands protocol test (build first)  |
| `node terminal-browser-test.mjs` | headless-browser E2E of the terminal view (build first) |

## Deploy & auto-start on boot

Quickest path: `pi-web-ui server install --port 8787 --cwd /path` — installs
and starts the service on boot (see [Manage as a system service](#manage-as-a-system-service-auto-start)).
The manual alternatives below are kept for reference / non-standard setups.

### Docker (one command)

```bash
docker compose up -d     # builds, starts on :8787, auto-restarts on boot
docker compose stop      # stop (keeps the container)
docker compose down      # stop and remove the container
```

`restart: unless-stopped` in `docker-compose.yml` brings the server back up
whenever the Docker daemon starts (boot, crashes, reboots). Mount a volume for
`/app/.pi-web` (sessions persist) and, optionally, your `~/.pi/agent` config
and a workspace — see the comments in `docker-compose.yml`.

### Linux — systemd

```bash
sudo npm i -g pi-web-ui
sudo cp deploy/pi-web-ui.service /etc/systemd/system/
# edit User/WorkingDirectory/Environment in the unit first
sudo systemctl daemon-reload
sudo systemctl enable --now pi-web-ui     # starts now + on every boot
sudo systemctl stop pi-web-ui             # stop
sudo systemctl disable pi-web-ui          # stop auto-start on boot
journalctl -u pi-web-ui -f                # logs
```

### macOS — launchd

```bash
npm i -g pi-web-ui
cp deploy/com.xingshuyin.pi-web-ui.plist ~/Library/LaunchAgents/
# edit ProgramArguments / WorkingDirectory / PI_WEB_CWD (which pi-web-ui)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist
launchctl bootout gui/$(id -u)/com.xingshuyin.pi-web-ui   # stop + remove auto-start
# logs: /tmp/pi-web-ui.log, /tmp/pi-web-ui.err
```

### Windows — Task Scheduler

Easiest path (generates everything, no manual XML editing):

```bat
npm i -g pi-web-ui
pi-web-ui server install --port 8787 --cwd C:\path\to\project
pi-web-ui server status
pi-web-ui server restart
pi-web-ui server stop        :: stop the running instance (auto-start stays)
pi-web-ui server uninstall   :: remove the task entirely
```

What it does: writes `%APPDATA%\pi-web-ui\pi-web-ui.ps1` (a PowerShell launcher
that sets `PORT`/`PI_WEB_CWD`, cd's to the workspace, launches node and
appends output to `%USERPROFILE%\pi-web-ui.log`) plus the Task Scheduler XML,
then registers a **logon** task (`schtasks /Create /XML` — the task runs when
you log in, same as a launchd agent; usually no admin needed, but see the
troubleshooting note below if you get access denied). The task invokes
`powershell.exe -WindowStyle Hidden`, so the server runs with **no black
console window** — there is nothing to accidentally close or kill. Preview
both generated files without installing: `pi-web-ui server install --print`.

Manual alternative with `deploy/pi-web-ui-task.xml`: edit the paths, save the
file as **UTF-16 LE** (schtasks requires it), then
`schtasks /Create /TN "pi-web-ui" /XML pi-web-ui-task.xml /F` and
`schtasks /Run /TN "pi-web-ui"`.

> **Windows troubleshooting**
>
> - **`install` fails with `ERROR: Access is denied` (错误: 拒绝访问)** — on
>   some machines Task Scheduler refuses to let a non-elevated token create
>   tasks (deleting your own task with `schtasks /Delete` still works, which
>   is why `server uninstall` succeeds). Fix: run
>   `pi-web-ui server install` from an **elevated (admin) PowerShell**.
> - **Always pass `--cwd` explicitly, and point it at a user-writable
>   directory.** The task inherits the installing shell's current directory
>   as its working directory. Installing from an elevated shell without
>   `--cwd` registers the task with `C:\WINDOWS\system32`, and the server
>   then fails at startup with
>   `EPERM: operation not permitted, mkdir 'C:\WINDOWS\system32\.pi-web\sessions\...'`
>   because the logon task runs with a least-privilege token that cannot
>   write under `system32`. Use e.g. `--cwd C:\Users\<you>` (sessions then
>   go to `C:\Users\<you>\.pi-web`).
> - **Fix an already-broken task** (task created with the wrong directory):
>   `pi-web-ui server uninstall`, then
>   `pi-web-ui server install --cwd C:\Users\<you>` from an elevated shell.
>   Rerunning `install` with new options also regenerates the task in place.

> **Boot-start without login?** A logon task needs an interactive session, just
> like a launchd agent. For headless/always-on Windows use Docker (see above).

The three templates use `KeepAlive` / `Restart=on-failure` / `RestartOnFailure`
so the server survives crashes, and start at login/boot automatically.

## License

MIT
