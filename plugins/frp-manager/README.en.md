**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# frp-manager · NAT traversal

All-in-one management for frp (fatedier/frp): **local tunnel list + frpc client + local frps for integration runs + one-click deployment of a remote public frps**, in the new TOML format (v0.52+).

## Features

| Tab               | What it does                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tunnel list       | Create, read, update and delete tcp/udp/http/https/stcp/xtcp rules, enable/disable them, start and stop frpc, one-click install                                                                                                                         |
| Client            | frpc.toml server target (serverAddr/serverPort/token/TLS); saving restarts it to take effect                                                                                                                                                            |
| Local frps        | Start a local frps for integration runs (bindPort/http/dashboard/subdomainHost), start and stop                                                                                                                                                         |
| Remote deployment | From the **shared SSH host library** (the same one used by the remote workbench/SFTP; saved connections can be picked directly) → **test connectivity** → **install frps over SSH** on the remote, or **copy the one-click script** and run it manually |
| Logs              | The last 200 lines of frpc / frps respectively                                                                                                                                                                                                          |

The `frp` tool given to the AI (action-style): `status|list|add|update|remove|toggle|set_server|frps_set|frpc_start|frpc_stop|frpc_restart|frps_start|frps_stop|logs|install|remote_list|remote_use|remote_probe|remote_deploy|remote_script`, with only three string fields as arguments: `action/name/json`.

## Data and binaries

- State: `<dataDir>/frp-manager/state.json` (common/proxies/frps/remote), with the generated `frpc.toml` / `frps.toml` in the same directory
- Binaries: `<dataDir>/frp-manager/bin/frpc[.exe]`, `frps[.exe]`; lookup order is Settings.frpcPath → bin/ → PATH
- One-click install: download per platform from `github.com/fatedier/frp/releases` (linux/darwin tar.gz, windows zip), then extract the binaries into bin/; if this machine cannot reach GitHub, copy frpc/frps from the official package into bin/ by hand
- Remote script: works on Debian/Ubuntu/CentOS, installing to `/usr/local/bin/frps` + `/etc/frp/frps.toml` + systemd `frps.service`; a direct install through a shared host ships it as base64 chunks (non-root automatically uses `sudo -n`), and on success the frpc server address is synced to that host

## Port reminder

Open these on the remote public machine: `bindPort/tcp` (default 7000, where frpc connects), `vhostHTTPPort` (used by http tunnels), and the `dashboard` port (7500). Local frpc only makes outbound connections to 7000 and needs no inbound port.

## Files

- `manifest.json`: `view:true` + `ui/tools/http`
- `index.mjs`: pure-function area (platform mapping/TOML/validation/remote script, directly importable by unit tests) + activate (state file/process supervision/AI tool/HTTP routes), deliberately a single file
- `client/entry.mjs`: the panel (`mount(container)` → cleanup)
