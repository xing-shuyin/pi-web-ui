**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Windows Electron portable build launch guide

This directory provides the `.bat` launch and shortcut scripts used by the Windows Electron portable package. Download `pi-web-ui-desktop-<版本>-portable.zip` and extract it completely to use it; downloading this directory alone gives you no application and cannot start pi-web-ui.

The launcher here is not the Python launcher: this directory has no Python scripts, and none is needed to run these batch entry points. If you use a separately distributed Python launcher, follow that package's own install and run instructions; do not mix in the directory layout or build commands from here.

- [Official site](https://xing-shuyin.github.io/pi-web-ui-site/) · [Full install and model configuration](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)
- [Local /setup configuration guide](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#setup-page) · [Download the latest Release](https://github.com/xing-shuyin/pi-web-ui/releases/latest)
- [Electron desktop development and build guide](https://github.com/xing-shuyin/pi-web-ui/blob/main/desktop/README.md)

## Extract and launch

1. Extract the ZIP completely into a writable directory, e.g. `PiWebUI-Portable/` on an external drive. Do not run it from inside the archive, and do not move only the EXE out of `app/`.
2. Double-click `启动Pi.bat` or `PiPortable.bat` in the root directory. The former is only a Chinese-named entry point that calls the latter. The script resolves paths from its own location, so the whole directory can be moved and still launch.
3. Configure models and authentication inside the app, then choose a workspace. The default project directory is `data/workspace/`; projects chosen on another drive are not migrated along with the portable directory.
4. When finished, quit the app completely, wait for the terminal and other child processes to exit, then eject the drive.

The desktop service tries `127.0.0.1:8790` by default and falls back to a random free port when it is taken. Model configuration and service access configuration are separate matters; `/setup` covers the access token, listening and other service settings — see the official site guide above for concrete access restrictions and steps. To open it in a browser, use the actual service address.

Running the desktop app itself uses Electron's built-in Node runtime and needs no system Node.js. `node`, `npm` and `npx` in the terminal do need a standalone Node.js; Git/Bash workflows need PortableGit or the equivalent tools on the machine. **Not every portable package bundles a standalone Node.js and Git by default.**

## Directory layout and data

```text
PiWebUI-Portable/
├── PiPortable.bat             # actual launch entry
├── 启动Pi.bat                 # calls PiPortable.bat
├── CreateDesktopShortcut.bat  # creates the Windows desktop shortcut
├── 创建桌面快捷方式.bat       # calls the English-named shortcut script
├── README.md                  # this guide, also copied to the package root
├── Portable.flag              # Electron portable-mode marker
├── app/                       # full Electron app; do not keep only the EXE
│   ├── pi-web-ui-desktop.exe
│   └── ...
├── runtime/                   # optional standalone tools; a directory does not mean installed
│   ├── git/                   # PortableGit: cmd/git.exe, bin/bash.exe, etc.
│   └── node/                  # standalone Node.js: node.exe, npm.cmd, npx.cmd, etc.
├── data/
│   ├── agent/                 # pi config, auth.json, models.json and session history
│   ├── web/                   # WebUI config, plugins, approval rules, uploads and other data
│   ├── electron/              # Electron state, cookies and session cache
│   ├── workspace/             # default project workspace
│   ├── git/                   # global Git config .gitconfig
│   ├── home/                  # redirected HOME/USERPROFILE, e.g. .ssh created by tools
│   ├── npm-global/            # npm global packages and commands when using the portable Node
│   └── npm-cache/             # npm cache when using the portable Node
└── checks/                    # launch diagnostic messages
    ├── fatal-app.*.txt
    ├── warn-git.*.txt
    └── run-info.*.txt
```

`data/agent/` may hold API keys, `data/home/` may hold SSH keys, and `data/web/` may hold sensitive configuration. Guard backups carefully; do not redistribute a used `data/` together with the program. Portable launch does not automatically import existing local pi configuration; to reuse it, stop the relevant services and selectively copy the configuration or sessions from `~/.pi/agent` into `data/agent/`.

These redirections make the main application data travel with the directory; they are not a "zero trace" guarantee. Windows, antivirus software, temp directories, external CLIs, credential managers and user-specified paths may still produce data outside the package; the scripts do not clean host records either.

## Git, Node and extra engines

Check files, not just directory names:

| Capability needed                      | File the script recognizes | Behavior after launch                                                                    |
| -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| Git, Bash, SSH and other Windows tools | `runtime/git/cmd/git.exe`  | Adds the PortableGit path to PATH; sets `SHELL` and `PI_WEB_SHELL` when Bash is found    |
| `node`, `npm`, `npx`                   | `runtime/node/node.exe`    | Adds the standalone Node and `data/npm-global` to PATH, sets npm prefix/cache to `data/` |

Without bundled Git the script warns and continues launching; those capabilities then depend on the system environment. Without a standalone Node no npm environment is mounted and the terminal keeps whatever commands the system PATH offers. Electron's built-in runtime does not mean `npm` is available in the terminal.

To add them manually, quit the app first:

- Download a suitable PortableGit from [Git for Windows Releases](https://github.com/git-for-windows/git/releases) and extract its contents into `runtime/git/`, making sure there is no extra nested directory. It provides Git/Bash tools on Windows, not a full Linux system.
- Get the required Windows ZIP from the [Node.js download page](https://nodejs.org/en/download) (the project requires Node.js >=22.19.0) and put its files into `runtime/node/`, making sure `node.exe` sits directly in that directory. Pick the architecture matching the target machine.

After a restart, check `git --version`, `node --version` and `npm --version` in the app terminal. With the portable Node, e.g. `npm i -g @anthropic-ai/claude-code` or `npm i -g @deepseek-ai/dsh` puts npm global packages into `data/npm-global/`; these extra engines may still need network access, authentication, other dependencies or their own data paths, and may need reconfiguration after switching machines.

## Shortcuts

Double-click `创建桌面快捷方式.bat` or `CreateDesktopShortcut.bat`; the script writes `Pi Web UI.lnk` to the current user's desktop via PowerShell and `WScript.Shell`, updating any link of the same name. The link targets the launch script in the portable package, the icon comes from `app/pi-web-ui-desktop.exe`, and the launch window is set to minimized.

The shortcut stores the absolute path from creation time. Re-create it after moving the folder or changing drive letters; delete the desktop link manually when it is no longer needed. This operation writes files on the host.

## Upgrade and migration

1. Quit the old app completely and stop any related terminals and external tools still running.
2. Back up the whole old directory, at minimum the complete `data/` plus the external workspaces or custom data directories actually in use.
3. Extract the new ZIP into a **new directory**, copy the old `data/` into the new package, and keep the new package's `app/`, launch scripts, `Portable.flag` and `checks/`.
4. Migrate tools you installed yourself from the old `runtime/` as needed; if the new package already ships a newer version, check version and compatibility first instead of overwriting with the old one.
5. Launch the new directory, verify model authentication, sessions, workspace and tools, then dispose of the old directory and re-create shortcuts.

The portable ZIP should not rely on the installed-version updater to maintain its layout; prefer the manual migration above. A global `npm i -g pi-web-ui@latest` does not replace the Electron app in `app/`.

**Do not upgrade a directory in use by re-running `scripts/make-portable.mjs`.** It is a distribution assembly tool that wipes `agent`, `web`, `git`, `home`, `workspace`, `electron`, `npm-global`, `npm-cache` under `release/PiWebUI-Portable/data/` and replaces `app/`.

## Launch scripts, environment variables and build boundaries

`PiPortable.bat` first checks `app/pi-web-ui-desktop.exe` and exits when it is missing; checks for optional runtimes only verify the entry file, not whether dependencies are complete. `checks/` shows supplementary messages according to the console code page: 936 selects GBK, 65001 selects UTF-8, and other code pages still get the basic English messages inside the script.

When launched through the BAT, the script overwrites the following variables with in-package paths:

| Variable                                 | Value set by the BAT                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PI_PORTABLE` / `PI_PORTABLE_ROOT`       | `1` / script directory                                                                                |
| `PI_CODING_AGENT_DIR`                    | `<package root>/data/agent`                                                                           |
| `PI_WEB_DATA_DIR`                        | `<package root>/data/web`                                                                             |
| `PI_WEB_CWD`                             | `<package root>/data/workspace`                                                                       |
| `GIT_CONFIG_GLOBAL`                      | `<package root>/data/git/.gitconfig`                                                                  |
| `HOME` / `USERPROFILE`                   | `<package root>/data/home`                                                                            |
| `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE` | `<package root>/data/npm-global` / `<package root>/data/npm-cache` when a standalone Node is detected |

The script also passes `--user-data-dir=<package root>/data/electron` and forwards extra arguments to the EXE; this does not mean every WebUI CLI argument is handled by the desktop shell. Variables the BAT does not reset, such as `PI_WEB_PORT` and `PI_WEB_HEALTH_TIMEOUT_MS`, can be inherited from the parent process.

Electron's own portable detection is implemented in `desktop/portable.ts`: it recognizes `PI_PORTABLE_ROOT`, `PORTABLE_EXECUTABLE_DIR`, `PI_PORTABLE=1/true`, and also `Portable.flag`, `portable.flag`, `data/`, `runtime/git`, `runtime/node` next to the EXE or at specific parent levels. So in a complete layout, opening `app/pi-web-ui-desktop.exe` directly also activates portable mode.

To customize data locations, launch the EXE directly and set absolute paths for `PI_PORTABLE_DATA_DIR`, `PI_WEB_DATA_DIR`, `PI_CODING_AGENT_DIR`, `PI_WEB_CWD`, `PI_PORTABLE_HOME`, `GIT_CONFIG_GLOBAL` as needed; when a portable Node is detected, `NPM_CONFIG_PREFIX` and `NPM_CONFIG_CACHE` are supported as well. `PI_PORTABLE_DATA_DIR` only changes the default base directory for the remaining paths that are not overridden — it **does not move existing data**. Launched through the BAT, its hardcoded assignments and `--user-data-dir` still apply, so do not assume a single variable moves all data.

Source builds happen at the repository root, with scripts in the root `package.json`:

```bash
npm ci
npm run desktop:portable       # build and assemble the directory; no Git/Node download by default
# or: npm run desktop:portable:full  # adds Git, still no automatic standalone Node download
```

Once the server, front end and desktop shell are built, run:

```bash
node scripts/make-portable.mjs --with-git --with-node --zip
```

Output is `release/PiWebUI-Portable/`; with `--zip` it also produces `release/pi-web-ui-desktop-<版本>-portable.zip`. `--skip-pack` only skips electron-builder and requires an existing correct `release/win-unpacked/`; the assembly script itself does not compile source. `PI_BUNDLE_PORTABLE_GIT=1` and `PI_BUNDLE_PORTABLE_NODE=1` are each equivalent to the corresponding download option.

Current Release CI explicitly uses `--with-git --with-node`, but the local base commands do not download these two by default, and the assembly script reuses an existing `runtime/`. The current automatic download sources are Windows x64 Git/Node; an extraction failure may only print a warning; distributors must check the actual files and versions and cannot claim "fully bundled" from a command name or an existing directory.
