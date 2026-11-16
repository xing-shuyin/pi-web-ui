**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Remote workbench

The remote workbench reuses the host `remoteSsh` service and `<dataDir>/global-hosts.json`, sharing SSH hosts and encrypted credentials with the remote workspace and the SFTP plugin. The plugin's own groups, tasks, command snippets, and tunnel configuration are stored separately and never copy SSH passwords.

## Hosts and config import

The host dashboard supports search, groups, and environment tags; environment and group are workbench metadata and do not change host SSH credentials. Health checks run on demand and return load, memory, and disk metrics; metrics that cannot be collected are never faked as normal values.

Importing `~/.ssh/config` supports keyword case, quoted paths, multiple host aliases, wildcard inheritance, exclusion rules, first-assignment-wins, and Include file expansion. Include is capped at 8 levels, 64 files, 1 MiB total, to prevent cycles and unbounded scanning.

Connection semantics the host cannot fully express, such as `ProxyJump`, `ProxyCommand`, and `Match`, show an explicit warning and block the import. An Include failure also blocks importing an incomplete configuration. The server rescans on import, so tampering with browser-submitted parameters cannot bypass the checks.

## Terminals and session recovery

Tabs, two columns, four panes, adaptive tiling, and maximizing an individual terminal are supported. Terminal output is written to xterm as a byte stream, preserving UTF-8 characters split across packets; output is queued within bounds, and SSH output speed is controlled by consumption acknowledgements.

Closing the workbench panel and closing a terminal are different operations: unmounting the panel detaches from the terminal, while explicitly closing a terminal closes the SSH channel. Each browser tab stores an unguessable recovery credential that restores the terminal on remount; the credential is never written into the shared host config. Detached sessions expire, and plugin reloads or service restarts clean up in-memory SSH channels.

To keep remote tasks across service restarts, optionally use tmux mode, provided tmux is installed on the target machine. Closing the SSH channel does not terminate processes inside tmux.

Terminals provide buffer search, parameterized command snippets, multi-line paste preview, and log export. When broadcast is on, the actual target list is shown; credential input goes only to the corresponding terminal and never enters the broadcast or the model context. Terminal output itself may still contain remote program echoes and cannot replace the remote program's own confidentiality settings.

## Multi-host tasks and AI commands

The task center supports selecting hosts, setting concurrency, viewing per-host status, cancelling tasks, and retrying failed hosts. A retry runs only the selected failed items and does not re-run successful hosts. Failures writing run state or configuration are surfaced to the user; unfinished tasks are marked interrupted after a service restart, and commands are not re-run automatically.

`remote_term` supports listing hosts, probing, running commands, and reading output in pages by log ID. Command execution uses a bounded output summary and keeps the full output in a local log with a total size cap; reaching the cap reports the truncation. Logs may contain sensitive information from commands and their output, so never put passwords directly on the command line.

Timeouts, user cancellation, and plugin uninstall close the execution channel and reclaim the listener. The SSH protocol cannot guarantee that the remote process and all its children have stopped, and results state this limitation explicitly; tasks with side effects should verify remote state before retrying. The working directory is shell-quoted, so spaces and special characters in paths do not change the command structure.

A host's dangerous-command protection only blocks known dangerous patterns and cannot fully understand arbitrary shell, scripts, or SQL; production should still use a least-privilege account.

## Tunnels and files

Port forwarding listens on `127.0.0.1` of the machine running the pi-web-ui service, not of the machine hosting the browser viewing the page. It supports saving configurations, starting, stopping, deleting, viewing status and errors, and reconnecting per configuration. Stopping a tunnel closes both the listener and established connections.

The lightweight file panel provides directory browsing, size-limited text preview, and file upload. Uploads limit the file name and size and use exclusive creation, avoiding accidental overwrites of existing remote files. For complex transfers keep using the SFTP plugin with the shared host config.

## Verification and development

- `npx vitest run tests/unit/remote-workbench-*.test.ts`: config parsing, execution cancellation and budgets, terminal ownership and recovery, task and tunnel lifecycles.
- `node tests/remote-workbench-ui-test.mjs`: browser interaction regression against an independent mock backend, without touching real SSH hosts; Chrome probing uses `tests/lib/chrome.mjs`.
- When changing plugin code, bump the version in `manifest.json` and sync the plugin in the local data directory. If the install directory is a directory junction into this repo, the source is already synced, but the server still needs a plugin reload before it uses the new modules.
