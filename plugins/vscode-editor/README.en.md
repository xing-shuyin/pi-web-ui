**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# 📝 vscode-editor — pi-web-ui editor + SSH plugin (Remote-SSH)

A VSCode-like workbench view inside the pi-web-ui interface:

- **Multi-root file tree**: local workspace + saved SSH hosts (one tree, one set of tabs)
- **Workspace following**: after the main app switches project (`set_cwd`), the local tree
  root moves to the new project live — directory caches/expansion state are cleared and
  local tabs closed (prompting on unsaved changes), while remote SSH tabs and connections
  are untouched; `.vscode/sftp.json` is per project and re-read after the switch
- **CodeMirror 6 multi-tab editor**: local and remote files open together, syntax
  highlighting, Ctrl+S to save (remote files written back over SFTP), CRLF line endings
  preserved, Ctrl+P quick open (local)
- **Draggable terminal panel at the bottom**: several shells per connected host (xterm.js),
  window size syncing and keepalive; right-click a remote file/folder to open a terminal in
  its directory
- **Context menu inherits the host extension point (contextmenu.file)**: right-clicking the
  local file tree brings up the host's one global context menu, inheriting the host's
  built-in file operations and everything other plugins register (with `@plugins/sftp`, for
  example, 「上传到远端 / 上传此目录 / 从远端下载 / 添加到 SFTP 忽略」(upload to remote / upload
  this directory / download from remote / add to SFTP ignore) appear in full, with no
  separate configuration or upkeep inside the editor)
- **Download to computer** (context menu): local files download directly; remote
  files/folders bypass workspace mapping, a folder is tar.gz-packed in place on the remote
  side, and you choose where it lands
- **Upload files**: the toolbar ⬆ uploads to the workspace root in one click; the context
  menu item 「上传文件到此处…」(Upload file here…) (folder row → that folder, file row → its
  directory, **right-click on empty space** in the tree → that tree's root / the first
  connected SSH host's root; both local and remote SFTP supported); dropping files onto the
  tree — folder row → that folder, file row → its directory, empty space → the root (the
  chunked protocol confirms overwrites and shows progress; drops inside the tree are
  intercepted by the plugin and never trigger the main app's 「附加到对话」(Attach to
  conversation))

The formerly standalone ssh plugin is merged in: old host config in
`<pluginDir>/ssh-hosts.json` migrates automatically on first activation, nothing to move by
hand.

## SSH config auto-loading (same source as VSCode Remote-SSH)

- **Connect without importing**: the 「⚙ ssh config（自动加载）」(ssh config, auto-loaded) area
  at the top of the SSH panel lists every host in `~/.ssh/config`; click an alias to connect
  — whatever connects in VSCode connects here, and after editing the config a ⟳ refresh is
  enough, no import into manual hosts.
- **Identical syntax**: it is plain OpenSSH config. `Host` / `HostName` / `User` / `Port` /
  `IdentityFile` (all tried) / `ProxyJump` (comma-separated hops) / `ProxyCommand` (`%h`/`%p`
  expanded) / `ForwardAgent` are all supported; a `Host *` wildcard block is inherited as
  defaults (`ssh -G` semantics: first value wins); `Include` expands recursively (globs
  included, resolved relative to `~/.ssh/`) — it is the very file VSCode's
  `Remote-SSH: Open Configuration File` edits, and the panel's ✎ edits it in place (saving
  backs it up to `config.bak`).
- **Authentication matches the ssh command**: every IdentityFile is tried (`~` expanded) →
  the local default keys (`~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`) → `SSH_AUTH_SOCK`;
  config has no password field (same as VSCode), so use 「🏠 手动主机」(manual hosts) for
  password logins.
- Manual hosts (`ssh-hosts.json`, passwords/private keys in encrypted storage) and bulk
  import remain, and the AI's `vsc_ssh_connect` connects straight to a config host by passing
  the `alias` parameter.

## File tree interactions

- **Expand/collapse in place**: clicking a folder loads only that directory's children (with
  a 「⏳ 加载中」(loading) placeholder) without repainting the whole tree; collapsing is
  instant
- **Selection highlight**: clicking or right-clicking any row highlights it, and the toolbar
  ＋📄/＋📁 land in the currently selected directory (a selected file means its folder); a
  newly created item or copy becomes the selection
- **Context menu**: the local tree seamlessly inherits the host's `contextmenu.file` global
  menu, with full file operations and third-party plugin capabilities (e.g. `@plugins/sftp`);
  the remote tree supports: new / rename / delete (recursive for directories) / cut / copy /
  paste here (move or copy within the same scope) / duplicate (`foo_copy.js`,
  auto-incrementing on collision) / copy path / upload file here… / download to computer /
  open terminal (remote rows, scope-aware)
- **Filename search**: the 🔍 in either tree's toolbar (whole repo locally, narrowed from the
  current selection remotely), with results in the Ctrl+P overlay (remote hits carry a 🌐
  marker); click to open

## Unified scope model

scope = `"local" | connId`. Every frontend file operation
(list/read/write/create/rename/delete/copy/search) carries the scope and appends the connId
when remote — the server routes to the local fs or that connection's SFTP, and both ends
share one code path. `copy` semantics: `src` + `dest` are both full paths (local relative to
the workspace, remote absolute), an existing `dest` is always refused (the caller computes
the copy name with a `_copy` suffix), and `move: true` moves/renames; `search` is a
case-insensitive filename substring search (capped at 50, with `base` a relative path
locally and `baseDir` an absolute path remotely).

## Directory layout

```
vscode-editor/
├── manifest.json        # plugin manifest (id/icon/name)
├── index.mjs            # server entry: local file CRUD / SSH host management + connection pool + PTY shell + exec + remote SFTP operations
├── src/client.js        # client source (CodeMirror 6 + xterm.js)
├── build.mjs            # esbuild bundling script (xterm CSS inlined as text)
├── package.json         # build/dependency manifest (ssh2 is a devDep, installed at runtime by the server)
└── client/entry.mjs     # build output (self-contained bundle, loaded straight by the browser)
```

## Install / uninstall / update

```bash
# ── install ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor
pi-web-ui install plugins/vscode-editor  # or a local directory (development)
# optional: --data-dir <dir> for a custom data directory (default ~/.pi-web)

# ── list ──
pi-web-ui plugins                            # list installed plugins and ids

# ── update ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor --force
                                             # --force reinstalls over the top, i.e. updates
                                             # ⚠ back up ssh-hosts.json in the plugin directory and
                                             #   the workspace .vscode/sftp.json (host credentials/sync config) first

cp -r plugins/vscode-editor ~/.pi-web/plugins/  # local development: npm run build after editing src, then copy
                                             # Windows: %USERPROFILE%\.pi-web\plugins\vscode-editor
                                             # only manifest.json + index.mjs + client/ are needed,
                                             # node_modules / src / build.mjs need no copying

# ── uninstall ──
pi-web-ui uninstall vscode-editor            # remove the plugin directory (ssh-hosts.json goes with it)
# by hand: rm -rf ~/.pi-web/plugins/vscode-editor
```

Reload the page and a 📝 tab in the top bar means it worked. The ssh2 dependency does not
ship in the package; it is npm-installed into the plugin directory automatically on first
activation (if that fails, click the 「⚠ssh2」button in the sidebar to trigger it manually).
