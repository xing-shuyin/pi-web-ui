**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# pm2-manager · process keeper

pm2 **install / manage / uninstall in one**: with pm2 missing, the panel installs it in one click; once installed, the panel starts
new apps directly (installing them into pm2), the app table shows status/logs and does stop/restart/delete; when pm2 is not wanted,
one click uninstalls pm2 itself. Long-running services and debug instances started by the AI get one home: pm2 — so they are
**named, stateful, logged and individually stoppable**, and the host top bar's 「后台任务」(Background tasks) panel and the plugin
panel show the same list.

> Field problem: while debugging, the AI leaves a pile of background instances (one local measurement: 12 leftover
> `dist/server/index.js`, CPU pegged), none of them in any list and impossible to stop cleanly. This plugin provides the tools
> and the panel that fix it.

> **No takeover**: the plugin intercepts nothing and appends no hints to the AI's commands (no `onToolPre` gate, no
> `#bg-ok` escape hatch, no after-the-fact nudging). Whether to write `nohup` / a trailing `&` is the model's decision; users
> who want to look or intervene open the panel.

## Two things it does

| #   | What it does        | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Prompt guidance** | Registers a single action-style `pm2` tool; its `description` / `promptSnippet` / `promptGuidelines` tell the model in all three places that "long-running tasks are easier via pm2", no guessing needed; `action=install/uninstall` covers installing and removing pm2 itself                                                                                                                                                                                                                                                                                                                                                                                              |
| 2   | **Embedded panel**  | Embeds a 「pm2 托管的应用」(pm2-managed apps) block right inside the host 「后台任务」(Background tasks) panel (`view:false` + `ui["tasks.panel"]`): app table (status/CPU/memory/restarts/uptime), view logs, stop/restart/delete; the 「➕ 启动新应用」(Start a new app) form starts a service directly (installing it into pm2); at the bottom 「卸载 pm2」(Uninstall pm2) removes pm2 itself after a second confirmation; one-click install when pm2 is missing. The host's own diffed bare-process list stays above — one panel, each part minding its own segment, nothing listed twice (**no `registerBackgroundTask` per app**, that would list the same app twice) |

## Usage for the AI (tool `pm2`)

```
action=list                      # list managed apps (with CPU/memory/restarts/uptime)
action=start name=api script=server.js args=["--port","8788"] cwd=/path
action=logs  name=api lines=100  # read output (no need to leave an unattended process behind)
action=stop|restart|delete name=api      # name=all for a whole batch (delete = uninstall a single app, removing the record only, not pm2 itself)
action=install                   # one-click npm i -g pm2 (when not installed)
action=uninstall                 # uninstall pm2 itself (pm2 kill first, then npm uninstall -g pm2)
```

Conventions (written into the tool prompt, visible to the model every turn):

- Start background/long-running tasks with `action=start` — easier than `nohup`, a trailing `&`, Windows `start` or `Start-Process`;
- Run `action=list` before starting a second service under the same name, and clear unneeded ones with `action=delete`;
- Use `action=logs` to read output; don't abandon a process in the background.

All of these are **suggestions**: the plugin intercepts nothing, and an AI that uses unmanaged patterns still runs — those
processes just aren't in the pm2 list.

The panel's first frame **does not jump to conclusions**: until the first `GET /status` comes back it shows only the neutral
「正在检测 pm2 环境…」(Checking the pm2 environment…), neither 「未检测到 pm2」(pm2 not detected) nor 「没有托管任何应用」
(No managed apps) — otherwise every open of 「后台任务」 flashes a yellow bar first (looks like an error, but the status simply
hasn't arrived yet).

## Cross-platform

pm2 is a global npm package, **it runs on Windows / macOS / Linux**, and the plugin uses the same call chain on all three:

1. Look for pm2's **JS entry** via `设置.pm2Bin` (the `pm2Bin` setting) → the `PI_WEB_PM2` env var → the node prefix (`dirname(process.execPath)/node_modules/pm2/bin/pm2`);
2. Only when none of those hit does it ask `npm root -g` (the one step that spawns a child process, and only on the on-demand path);
3. Every call is `node <pm2's JS entry> <args>` — **never PATH, never the `.cmd` shim**, dodging two traps: `execFile("pm2")`
   failing straight with EINVAL on Windows, and a service runtime whose PATH has no global bin directory.

The only platform difference is one: **Windows does not support `pm2 startup` boot autostart** (an upstream limitation), so the plugin
leaves autostart alone. The cross-platform scan for 「遗留裸实例」(leftover bare instances) (netstat/ss/lsof + process tree) is the
**host's** background-task panel's own job; the plugin does not reimplement it, so the same information isn't listed twice in one panel.

## Settings

| key      | default | purpose                                                                                                |
| -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `pm2Bin` | empty   | Absolute path of the pm2 entry (empty = auto-detect); point it at `bin/pm2` (the JS entry), not `.cmd` |

## HTTP routes (for the panel)

`/plugins-api/pm2-manager/*`: `GET /status`, `POST /install` (install pm2 itself), `POST /uninstall` (uninstall pm2 itself: `pm2 kill` first, then `npm uninstall -g pm2`), `POST /action` (`stop`/`restart`/`delete`/`logs`/`describe`/`start`; start requires `script`). Deleting a single app goes through `delete` (record only, pm2 stays) — a different thing from uninstalling pm2.

## Permissions

`ui` (`tasks.panel` slot), `tools` (AI tools), `http` (panel routes).

## Files

- `manifest.json`: the manifest (settings schema, `view:false` and the `ui["tasks.panel"]` entry)
- `index.mjs`: server entry — the top half is the **pure-function area** (pm2 entry candidates / jlist parsing / formatting / `buildPm2StartArgv` assembling the start args; unit tests import straight from this file), the bottom half is activate (detection, AI tool, HTTP routes: install pm2 itself / uninstall pm2 itself / manage apps)
- `client/entry.mjs`: the embedded panel (`mount(container)` → returns cleanup; the host calls cleanup to tear down when the panel closes or the plugin reloads)

> The pure functions are **deliberately inlined** in `index.mjs` instead of living in a separate file: the host's `plugins_reload` only
> cache-busts the `index.mjs` import with `?e=<epoch>`, while sibling modules it statically imports hit the Node ESM module cache —
> edits don't take effect on reload, a service restart is required (bitten once).

- Unit tests: `tests/unit/pm2-manager.test.ts` (pure functions + fake-host activate, zero ports, zero child processes, including the
  install/uninstall constants and `buildPm2StartArgv`), `tests/unit/pm2-manager-panel.test.ts` (first frame doesn't jump to conclusions, the start form dispatches start, uninstall second confirmation)
