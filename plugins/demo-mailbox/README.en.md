**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# 📬 demo-mailbox — plugin development example

A **minimal runnable example** of a pi-web-ui optional UI component: it demonstrates the
full chain of "server entry index.mjs + client view client/entry.mjs + two-way messages". It doubles as
the protocol test fixture for `tests/plugin-test.mjs`.

## What it does

- Two sample emails preset in memory + an echo form
- The client view renders the mail list and the send form; a sent message goes over WebSocket to the server,
  which broadcasts it back to every open page (all tabs see it live)
- Demonstrates the three host APIs `host.onMessage` / `host.broadcast` / `host.notify`

## Directory layout

```
demo-mailbox/
├── manifest.json      # plugin manifest (id/icon/name/version/description)
├── index.mjs          # server entry: export default { activate(host) → deactivate? }
└── client/entry.mjs   # view entry: export default { mount(el, ctx) → cleanup? }
```

## Try it locally

```bash
# ── install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/demo-mailbox
pi-web-ui install plugins/demo-mailbox   # or a local directory

# ── inspect / uninstall ──
pi-web-ui plugins                            # list installed plugins and ids
pi-web-ui uninstall demo-mailbox             # or rm -rf ~/.pi-web/plugins/demo-mailbox

# ── update ──
pi-web-ui install ...as above... --force      # overwrite reinstall
cp -r plugins/demo-mailbox ~/.pi-web/plugins/
```

Refresh the page; a 📬 tab in the top bar means success. Delete the directory and refresh to uninstall — a plugin
"does not exist unless installed", with no registration step.

## Notes for plugin developers

- The server side has all of Node's capabilities (a real plugin such as webmail talks IMAP/SMTP here);
  credentials live only in `<pluginDir>/`, never in the codebase
- Client and main app have just two narrow channels: `ctx.send()` upstream, `ctx.onData()` downstream,
  with no shared React instance
- Upstream messages with request semantics must carry a `reqId`; responses match on it for concurrency, and
  responses without a reqId are silently dropped by the client
- For protocol conventions see the "Plugins" chapter of the pi-web-ui main README and AGENTS.md
