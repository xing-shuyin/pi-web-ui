**English** · [简体中文](./device-center-deployment.md) · [繁體中文](./device-center-deployment.zh-TW.md)

# pi-web-ui Device Center Deployment Guide

For server administrators and AI deployment assistants new to pi-web-ui. You can deploy Device Center from this document alone, without reading project source or prior conversations.

- Project: https://github.com/xing-shuyin/pi-web-ui
- Web page for this document: https://github.com/xing-shuyin/pi-web-ui/blob/main/docs/device-center-deployment.md
- Raw text for this document: https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/docs/device-center-deployment.md

## 1. What gets deployed

pi-web-ui is the web UI for a coding agent. Device Center (Hub) is its standalone service, responsible for accounts, device connections, group chat and cross-device collaboration. Each computer running pi-web-ui connects out to the Hub, so no public inbound port is needed on any of them.

This guide deploys the Hub, not the main chat service. The Hub defaults to port **8790**; the main chat service defaults to 8787. Running the Hub needs no model API Key and no running chat service.

Public Linux uses automatic HTTPS by default; a domain is not required, and a public IPv4 can also obtain a trusted certificate. For a new deployment run `pi-web-ui hub install --public-url https://<actual public IPv4 or domain> --allow-registration`; after updating an existing Hub run `pi-web-ui hub https`. The installer manages certificates, the HTTPS/WebSocket gateway and automatic renewal, and is not tied to a fixed server. Prerequisites and compatible migration: [automatic public HTTPS deployment](device-center.en.md#automatic-public-https-deployment).

HTTP still fits a trusted intranet or temporary verification, used explicitly with `--https=off`; an existing TLS proxy uses `--https=external`, and the installer does not overwrite it. Section 4 below keeps the full troubleshooting steps for explicit HTTP.

## 2. Information needed before deployment

| Information       | Example or default                       | Purpose                                                                                                                         |
| ----------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Deployment target | Current machine / remote server          | "Current machine" is the machine hosting the service that performs the deployment, not necessarily the machine with the browser |
| Server address    | `203.0.113.10` or the real hostname      | SSH connection and deriving the access URL                                                                                      |
| SSH port          | `22`                                     | Remote login port, different from the Hub port                                                                                  |
| Login account     | `deploy` or an existing server account   | A regular account works; installing system dependencies may need sudo                                                           |
| Authentication    | Password / SSH key / existing SSH config | Used over a secure channel, never written into chat messages                                                                    |
| Hub access port   | `8790`                                   | HTTP reaches this port directly by default; prefer 1024–65535                                                                   |
| Domain (optional) | `hub.example.com`                        | A domain the user owns and can change DNS for                                                                                   |
| HTTPS (optional)  | On by default for public Linux           | Issues and renews certificates automatically; needs public TCP 80/443                                                           |

`203.0.113.10` and `hub.example.com` in this document are examples and must be replaced with real values. Example commands target a Linux/macOS shell; Windows uses the equivalent PowerShell paths and environment variable syntax.

A public IP may be NAT-mapped by the cloud platform; do not assume it can be bound to the server's network interface. LAN deployments use a LAN address the devices can reach. The browser URL, the SSH address and the final device access address may also differ, and each needs separate verification.

### Credentials and SSH connections

Server passwords, private keys and sudo passwords are only for secure SSH or terminal interaction. Never paste them into AI conversations, deployment summaries, command arguments, logs or documents. Use them only for the current connection by default; persisting a connection must be the user's explicit choice.

Verify the SSH host identity and `known_hosts` before executing remotely. For an unknown host, check the fingerprint through a trusted channel first; when a fingerprint changes, investigate the cause instead of bypassing the check with an option that disables host verification. Account passwords do not replace host identity verification.

If the deployment assistant has no secure credential entry point or authorized SSH execution tool, state that limitation, guide the user to run commands in their own SSH terminal and return results that contain no keys. Never claim a remote operation happened.

## 3. Pre-install checks

Check on the **actual target server**; do not infer a remote environment from the local one:

1. OS, architecture, current account, home directory, disk space and sudo capability.
2. `node --version`, `npm --version`; Node.js must be **>= 22.19.0**.
3. `command -v pi-web-ui`, `pi-web-ui hub --help`, and `status --json` of an existing Hub, to confirm whether it is installed.
4. Whether the target port is taken, and whether Nginx, Caddy or an existing site is present.
5. Whether package sources, the npm registry and certificate services (HTTPS only) are reachable.
6. System firewall, cloud security group, NAT and the external access path.
7. Whether Linux has a working systemd user service; containers or systems without a user bus cannot be assumed to support it.

When an existing deployment is found, confirm its account, data directory, run-as account and access address first. Keep the existing config and data; avoid duplicate installs, overwriting the service or switching to an empty data directory.

Prefer reusing a suitable Node.js when installing dependencies; if a new install is needed, use fnm for a supported LTS release and make sure the Node executable the service later uses stays in place. Do not uninstall a runtime that other services depend on.

## 4. Explicit HTTP: intranet or temporary verification

The following uses a remote Linux server with access port 8790 as the example.

### 4.1 Install the software

Run on the target server, under the account that will run the Hub:

```bash
node --version
npm --version
npm install -g pi-web-ui
pi-web-ui hub --help
```

If the npm global directory is not writable, prefer that account's fnm or a user-level npm prefix and confirm PATH. Do not switch every step to root just because of a permission error.

### 4.2 Install and start the Hub

```bash
pi-web-ui hub install --https=off --host 0.0.0.0 --port 8790 --public-url http://203.0.113.10:8790 --allow-registration
pi-web-ui hub status --json
```

Flags:

- `--host 0.0.0.0`: listen on all IPv4 interfaces so other devices can connect.
- `--port 8790`: the port the Hub service listens on, not the SSH port.
- `--public-url http://203.0.113.10:8790`: the root address other devices actually use; no path, query parameters or credentials. Must not be `0.0.0.0`.
- `--allow-registration`: temporarily allow account creation; turn it off once the needed accounts exist.
- `--data-dir`: optional, defaults to `~/.pi-device-hub` of the run-as account. Must be separate from the main chat service data directory.

`install` saves the config, sets up autostart and starts the service. Supported mechanisms are Linux `systemd --user`, macOS user LaunchAgent and Windows logon scheduled task.

**To start on Linux without anyone logged in**, an administrator must enable linger for the actual run-as account; replace `deploy` below with the real account:

```bash
sudo loginctl enable-linger deploy
```

After enabling it, check the user service and its state after a reboot; never promise boot availability from a successful install alone. Windows logon scheduled tasks and macOS user LaunchAgents usually need the corresponding user to log in and should not be described as running at system boot.

With no usable service manager, verify in the foreground first:

```bash
pi-web-ui hub --host 0.0.0.0 --port 8790 --public-url http://203.0.113.10:8790 --allow-registration
```

A foreground process stops when the terminal exits. Long-running use needs a process manager that fits the actual environment, stated in the deployment result; do not start two Hubs.

### 4.3 Open the port

The default HTTP setup needs inbound TCP 8790. Identify the actual firewall first, then change the matching rule, e.g. only when the server runs UFW:

```bash
sudo ufw allow 8790/tcp
```

Cloud servers also need the same port opened in the cloud console; behind router NAT, configure port forwarding. Keep existing SSH rules, do not disable the whole firewall and do not open unrelated ports. When you cannot operate the cloud console for the user, give the protocol, port, source range and where to change it.

### 4.4 Steps the user must complete

At the step where an action happens, the AI should give a short action card stating who does it, where, what to enter and how to verify afterwards, rather than a vague “please open the port” at the end. Server-side configuration that authorized tools can complete is executed directly; places you cannot reach, such as the cloud console, go to the user.

For example, a default HTTP deployment can prompt like this:

> **You need to open the port in the cloud server console**
>
> The Hub is running, but external access is still unverified. Open the cloud provider console, find the security group or instance firewall attached to this server and add an inbound allow rule:
>
> - Protocol: TCP.
> - Target port: 8790 (use the port actually chosen this time, not SSH's 22).
> - Source: when only yourself or a fixed network uses it, enter the device's egress IP/CIDR; to let arbitrary network devices connect, you may choose `0.0.0.0/0`, which opens this service port to all IPv4 addresses.
> - Direction and action: inbound, allow; save and confirm the rule is attached to this instance.
>
> Tell me when it is done and I will re-check `http://<actual server address>:8790/health`. Do not close the existing SSH rules for now.

Cloud providers may call this a “security group”, “firewall” or “lightweight application server firewall”. Confirm the provider and instance type in use first, then give the matching navigation; when unsure, name the feature to look for instead of inventing menus. Some platforms also need subnet network ACLs, load balancers or port mappings checked; troubleshoot against the actual network topology.

Action prompts vary with the plan:

| User action                | When needed                              | Specific information the AI should give                                                            |
| -------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Open in cloud console      | Cloud security group blocks it           | Instance, inbound TCP port, source range, rule association and verification address                |
| Provide install privileges | System dependencies need sudo            | Which step needs privileges, guided input in a secure terminal; never require passwords in chat    |
| Domain DNS configuration   | The user chose a domain                  | Record type, host record, target IP; existing conflicting records must be checked                  |
| Open the HTTPS entry       | A directly exposed HTTPS proxy is chosen | Usually TCP 443, plus 80 for certificate validation or redirects, decided by the certificate plan  |
| NAT port forwarding        | Behind a router or mapped network        | External port, internal address and port, protocol and the final public URL                        |
| Create an account          | Hub is reachable for the first time      | Which address to open, creating the account in the web UI, when to disable registration afterwards |
| Device binding             | The user starts connecting computers     | Each computer opens Device Center, which URL to enter, how to confirm the binding succeeds         |

Do not demand that the user open 22, 80, 443 and 8790 all at once: open SSH only when remote administration needs it; plain HTTP needs only the actual Hub port; with a reverse proxy on the same machine the Hub port need not be exposed publicly. IPv6 uses the corresponding source rules, and only when an IPv6 deployment is really required.

While waiting on the user, the status should read “service started, awaiting cloud security group” or “external verification pending”, never “deployment complete”. Keep the current progress and resume at verification once the user is done; if it still fails, check the system firewall, cloud rules, NAT and DNS layer by layer instead of making the user add the same rule over and over.

### 4.5 Layered verification

Check on the target server:

```bash
pi-web-ui hub status --json
curl --fail --show-error http://127.0.0.1:8790/health
```

`/health` should return HTTP 200 with JSON containing `service: "pi-device-hub"` and `status: "ok"`. Then check from another device that actually needs to connect:

```bash
curl --fail --show-error http://203.0.113.10:8790/health
```

Local health, external reachability, browser usability and a successful device connection are separate levels of verification. If the execution environment cannot reach the server from outside, state “verified inside the server, external pending”. A page that opens in the browser does not mean the WebSocket collaboration path has passed.

## 5. Optional: domain and HTTPS

### 5.1 Domain only, keep HTTP

Point the domain's A record at the server's public IPv4. Set an AAAA record only when the server and network support IPv6. The device access address can be `http://hub.example.com:8790`, and 8790 still has to be open.

To keep HTTP explicitly, also pass `--https=off` at install time; otherwise a public Linux install enables HTTPS automatically.

### 5.2 Domain + HTTPS

By default the installer configures a built-in TLS gateway. With an existing Caddy/Nginx, use `--https=external` to keep the existing proxy; the external proxy approach follows. The Hub itself keeps listening on internal HTTP.

First install example:

```bash
pi-web-ui hub install --https=external --host 127.0.0.1 --port 8790 --public-url https://hub.example.com --allow-registration
```

When Caddy and the Hub are on the same machine, the domain already exists and no other service holds 80/443, a site config example:

```caddyfile
hub.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

Caddy proxies WebSockets. With Nginx you must also forward the WebSocket Upgrade, the original Host and the proxy protocol headers correctly, and configure suitable long-connection timeouts. The proxy must support Device Center's streaming connections and remote access paths; verifying the landing page alone is not enough.

Check DNS, 80/443, the firewall and existing sites first; merge the config into the existing proxy and run a syntax check before reloading. Do not overwrite the whole existing config. If the proxy runs on another machine or in a container, `127.0.0.1` may not reach the Hub; set the listen address and access control per the actual network.

The Hub's `--public-url` must be a root origin such as `https://hub.example.com`; this guide does not use a `/hub` subpath. Do not just switch the URL from HTTP to HTTPS without configuring a TLS entry point.

### 5.3 Migrating an existing HTTP deployment

First record `status --json`, the run-as account, the data directory and the registration policy, and back up the data and proxy config. The current CLI's `restart` accepts no deployment flags other than the registration switch; never invent `restart --public-url ...`.

After updating to a build that supports automatic HTTPS, run `pi-web-ui hub https`, or pass `--public-url https://<actual domain>` to set the new address. It verifies HTTPS and keeps existing device credential connections; if verification fails it restores the previous config. Do not uninstall and reinstall or switch data directories. Close the old HTTP port only after every device has moved to the HTTPS address.

## 6. Create an account and connect devices

1. Open the final access address in a browser and create the needed accounts. The user enters the login password on the hub page.
2. In pi-web-ui on each computer, open “Device Center”, choose to connect to an existing hub, enter the same final address and follow the page flow to log in and bind the device.
3. Confirm the device is online in the hub, then create bots and groups and verify messaging and the expected collaboration capabilities.
4. Once the accounts exist, disable registration on the target server under the same run-as account:

```bash
pi-web-ui hub restart --allow-registration=false
pi-web-ui hub status --json
```

Disabling registration does not delete existing accounts. To create more accounts, temporarily `restart --allow-registration=true` and disable it again afterwards. Whether to disable it depends on the user's account creation plan; do not disable it before the user has created accounts.

## 7. Routine operations and recovery

```bash
pi-web-ui hub status --json
pi-web-ui hub stop
pi-web-ui hub start
pi-web-ui hub restart
```

These operations require the same account that installed the service. The `status` output includes running, ownership and registration state; confirm the running instance is the saved one.

Before upgrading, record the version, data directory and config and back up; stop the service, update the npm package, then start and verify. If fnm switches the Node version, confirm the Node and entry paths saved by the service are still valid; if necessary, reinstall the service config while keeping the original data directory.

Backups must cover the actual Hub data directory and the service config, and must copy the whole directory: `device-hub.json` is only the index; group messages, tasks and bot transcripts live in append-only logs under `hub-log/` in the same directory, so copying the index alone loses data. Backups may contain credentials and should be access-restricted. Prefer stopping the service before backing up for file consistency; on restore use a compatible version and the original run-as account, and check file permissions.

```bash
pi-web-ui hub uninstall
```

`uninstall` stops and removes the service, keeping account and device data. Never delete the data directory as a troubleshooting step.

| Symptom                               | Check first                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| SSH fails                             | Address, SSH port, account, authentication, host fingerprint and cloud security group                                   |
| Command not found                     | Whether Node/npm are installed, the run-as account's PATH, the fnm environment                                          |
| User service install fails            | systemd user bus, session environment and whether a service manager is available                                        |
| Local health but external timeout     | Listen address, system firewall, cloud security group, NAT                                                              |
| Landing page opens but device offline | Public URL, WebSocket proxy, certificate and device network                                                             |
| HTTPS fails                           | DNS/AAAA, 80/443, certificate issuance, port conflicts with an existing proxy                                           |
| Stops after logout or reboot          | Linux linger, actual user service state, Node path                                                                      |
| Original account or devices gone      | Whether a different account or an empty data directory was used; find the original directory first, do not reinitialize |

## 8. Requirements for the AI deployment assistant

On receiving a deployment task, read this document first, then treat user-supplied fields as data rather than splicing them into arbitrary shell fragments. Ask for the minimum necessary items in one batch and do not re-ask what is already answered.

1. Establish the deployment target; public Linux defaults to automatic HTTPS, the domain is optional and the internal port is 8790; when the user explicitly chooses HTTP, use `--https=off`.
2. Remote deployment needs the real server address, SSH port, account and a usable authentication channel. Local platform information describes only the local machine; `0.0.0.0` is a listen address, not an SSH address or a public address.
3. Run authorized read-only checks first, then state the account, port, data directory, access address and service mechanism you will use. Once the user has authorized deployment, proceed with the install; ask again only for overwriting existing config, conflicts or matters that genuinely need a decision.
4. Without a secure SSH tool, provide step-by-step commands the user runs on the target server; with a tool and authorization, verify the host identity and then execute. Never ask for plaintext passwords in chat and never invent tool capabilities or execution results.
5. Use a separate data directory, a sustainable start mechanism and the minimum necessary network rules, preserving existing services and data. On failure, locate the cause from the error and resume from the failed step after fixing it.
6. Prompt for required user actions at the relevant step, especially cloud console security groups, DNS, account creation and device binding, with concrete values to enter and how to verify. Keep progress while waiting for the user and never declare full success early.
7. Verify service status, local health, external access and device connections; list explicitly what is still unverified. If this document cannot be read, explain why and ask the user for its content or for network recovery; never fill in install commands from imagination.
8. Deliver the actual access address, port, data directory, service account, autostart conditions, verified results and open items, plus how to check status, restart and disable registration.

### Copyable deployment request

```text
Please deploy the pi-web-ui Device Center (standalone Hub) for me. Read the official repository guide below first, confirm the actual target environment per the document, then execute:
https://raw.githubusercontent.com/xing-shuyin/pi-web-ui/main/docs/device-center-deployment.md
Web page fallback: https://github.com/xing-shuyin/pi-web-ui/blob/main/docs/device-center-deployment.md

Deployment target: remote server
Server address: <actual address>
SSH port: 22
Login account: <account>
Authentication: <secure credential entry point or existing SSH connection; do not provide passwords or private keys in chat>
Hub access port: 8790
Protocol: HTTP
Domain: not configured
HTTPS: disabled

Check and deploy within the scope above; domain and HTTPS are both optional.
If an installation already exists, keep its data and config first and state the exact choice on conflict.
When you need me to open a port in the cloud console or configure DNS, tell me exactly where, the protocol, the actual port, the source range and the values to enter.
Keep progress while waiting for me, continue verification afterwards and do not declare external availability early.
When done, provide the actual access address, autostart conditions, verification results and the steps to connect devices.
```

## 9. Capability boundaries of the current AI entry point

The current pi-web-ui remote deployment entry provides the server address, SSH port, login account, authentication method and hub internal port, defaults to `https://<server address>` and supports public IPv4 deployment without a domain. The HTTPS switch and optional domain are in the connection settings, and the page shows user-action prompts for cloud security groups, source ranges, account creation and external verification.

Clicking “Start AI-assisted deployment” opens a new deployment conversation carrying the public guide link, the selected connection information, the deployment config and limited environment information about the current service, keeping the original conversation. The page collects no passwords or private keys and does not open an SSH connection just because the button was clicked; password authentication happens in the subsequent secure SSH terminal.

If direct connection support is offered later, connection credentials should go to the backend connection module; the AI receives only a connection handle and detection results, and shows real progress across connect, check, install, start and verify.

The public links in this document only resolve after the document is merged into the repository's `main`. Unpublished workspace changes do not appear on GitHub automatically. To pin installed software to an exact version, read the same path under a version tag that actually exists; historical tags predating this document do not contain this file.

## TURN (coturn)

Under symmetric NAT / CGNAT, UDP hole punching always fails and a TURN relay is required. The Hub only handles signalling; TURN is a separate service (it can sit on the same machine as the Hub). Minimal working config (Ubuntu/Debian, security group opening 3478/udp and the relay port range):

```bash
apt-get install -y coturn
cat >/etc/turnserver.conf <<"EOF"
listening-port=3478
fingerprint
lt-cred-mech
realm=pi-web-ui
external-ip=<server public IP>
min-port=49160
max-port=49200
no-multicast-peers
no-cli
# Long-term credentials: must match PI_DEVICE_TURN_USERNAME / PI_DEVICE_TURN_CREDENTIAL on the device side
user=pi:<strong password>
EOF
sed -i "s/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/" /etc/default/coturn
systemctl enable --now coturn
```

Verify:

```bash
# Should return XOR-MAPPED-ADDRESS (two STUN requests on the same port mapping identically = cone NAT, hole punching works)
turnutils_uclient -u pi -w <password> -p 3478 <server IP>
```

Device side (both ends):

```bash
PI_DEVICE_TURN=turn:<server IP>:3478 \nPI_DEVICE_TURN_USERNAME=pi \nPI_DEVICE_TURN_CREDENTIAL=<strong password> \npi-web-ui server restart
```

Key points:

- Only `turn:` + UDP is needed; `turns:` (TLS) requires certificates and adds latency, and is not required.
- `external-ip` must be the public IP; otherwise coturn hands out internal mappings and clients receive unreachable candidates.
- Size bandwidth for the H.264 channel: about 12 Mbps at 1440p60, 6 Mbps at 1080p60 and 18 Mbps per stream at 1440p120.
- To verify the path only, narrow `min-port`/`max-port` to 40 ports first and widen them by concurrency for production use.
- When relaying is active the server log shows `P2P is relayed through TURN`; the UI path still shows `p2p`.
