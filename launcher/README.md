[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# Windows Electron 便携版启动说明

本目录提供 Windows Electron 便携包使用的 `.bat` 启动与快捷方式脚本。下载 `pi-web-ui-desktop-<版本>-portable.zip` 后，完整解压即可使用；单独下载此目录没有应用程序，不能启动 pi-web-ui。

这里的启动器不是 Python launcher：当前目录没有 Python 脚本，也不需要 Python 来运行这些批处理入口。如果你使用的是另行分发的 Python launcher，请遵循该分发包自己的安装和运行说明，不要混用此处的目录布局或构建命令。

- [官网](https://xing-shuyin.github.io/pi-web-ui-site/) · [完整安装与模型配置](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)
- [本地 /setup 配置指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#setup-page) · [下载最新 Release](https://github.com/xing-shuyin/pi-web-ui/releases/latest)
- [Electron 桌面开发与构建说明](https://github.com/xing-shuyin/pi-web-ui/blob/main/desktop/README.md)

## 解压与启动

1. 将 ZIP 完整解压到可写目录，例如移动硬盘上的 `PiWebUI-Portable/`。不要在压缩包内直接运行，也不要只移动 `app/` 中的 EXE。
2. 双击根目录的 `启动Pi.bat` 或 `PiPortable.bat`。前者只是中文名入口，实际调用后者。脚本按自身位置计算路径，整目录移动后仍可启动。
3. 在应用内配置模型与认证，再选择工作区。默认项目目录是 `data/workspace/`；如选择其他磁盘上的项目，这些项目文件不会自动随便携目录迁移。
4. 使用结束后先完全退出应用，等待终端和其他子进程结束，再弹出移动硬盘。

桌面服务默认尝试 `127.0.0.1:8790`，端口占用时改用随机空闲端口。模型配置与服务访问配置是不同事项；`/setup` 用于访问口令、监听等服务设置，具体访问限制和步骤见上方官网指南。若需要在浏览器打开，请使用实际服务地址。

运行桌面应用本身使用 Electron 内置的 Node 运行能力，不需要系统 Node.js。终端中的 `node`、`npm`、`npx` 则需要独立 Node.js；Git/Bash 工作流需要 PortableGit 或本机对应工具。**不是所有便携包都默认捆绑独立 Node.js 和 Git。**

## 目录布局与数据

```text
PiWebUI-Portable/
├── PiPortable.bat             # 实际启动入口
├── 启动Pi.bat                 # 调用 PiPortable.bat
├── CreateDesktopShortcut.bat  # 创建 Windows 桌面快捷方式
├── 创建桌面快捷方式.bat       # 调用英文名快捷方式脚本
├── README.md                  # 本说明也会复制到分发包根目录
├── Portable.flag              # Electron 便携模式标记
├── app/                       # 完整 Electron 应用，不能只保留 EXE
│   ├── pi-web-ui-desktop.exe
│   └── ...
├── runtime/                   # 可选独立工具；目录存在不代表已安装
│   ├── git/                   # PortableGit：cmd/git.exe、bin/bash.exe 等
│   └── node/                  # 独立 Node.js：node.exe、npm.cmd、npx.cmd 等
├── data/
│   ├── agent/                 # pi 配置、auth.json、models.json 与会话历史
│   ├── web/                   # WebUI 配置、插件、审批规则、上传等数据
│   ├── electron/              # Electron 状态、Cookies 与 session 缓存
│   ├── workspace/             # 默认项目工作区
│   ├── git/                   # Git 全局配置 .gitconfig
│   ├── home/                  # 重定向的 HOME/USERPROFILE，如工具创建的 .ssh
│   ├── npm-global/            # 使用便携 Node 时的 npm 全局包和命令
│   └── npm-cache/             # 使用便携 Node 时的 npm 缓存
└── checks/                    # 启动诊断文案
    ├── fatal-app.*.txt
    ├── warn-git.*.txt
    └── run-info.*.txt
```

`data/agent/` 中可能有 API Key，`data/home/` 中可能有 SSH 密钥，`data/web/` 中也可能有敏感配置。备份时妥善保管；不要将使用过的 `data/` 随程序重新分发。便携启动不会自动导入本机现有的 pi 配置；需要复用时，退出相关服务后选择性复制 `~/.pi/agent` 的配置或会话到 `data/agent/`。

这些重定向让主要应用数据随目录携带，不是“零痕迹”保证。Windows、杀毒软件、临时目录、外部 CLI、凭据管理器及用户自行指定的路径仍可能产生包外数据；脚本也不会清理宿主机记录。

## Git、Node 与额外引擎

检查文件而不是只看目录名：

| 需要的能力                     | 脚本识别的文件            | 启动后的行为                                                                 |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| Git、Bash、SSH 等 Windows 工具 | `runtime/git/cmd/git.exe` | 将 PortableGit 路径加入 PATH；找到 Bash 时设置 `SHELL` 与 `PI_WEB_SHELL`     |
| `node`、`npm`、`npx`           | `runtime/node/node.exe`   | 加入独立 Node 与 `data/npm-global` 到 PATH，设置 npm prefix/cache 到 `data/` |

没有内置 Git 时脚本提示后继续启动，相关能力依赖系统环境；没有独立 Node 时不执行 npm 环境挂载，终端会沿用系统 PATH 中可用的命令。Electron 自带的运行能力不等同于在终端提供了 `npm`。

需要手动补充时，退出应用后：

- 从 [Git for Windows Releases](https://github.com/git-for-windows/git/releases) 下载合适的 PortableGit，解压内容到 `runtime/git/`，确保不是多套了一层目录。它提供 Windows 下的 Git/Bash 工具，不是完整 Linux 系统。
- 从 [Node.js 下载页](https://nodejs.org/en/download) 获取符合要求的 Windows ZIP（项目要求 Node.js >=22.19.0），将包内文件放到 `runtime/node/`，确保 `node.exe` 直接在该目录中。选择与目标机器匹配的架构。

重启后可在应用终端运行 `git --version`、`node --version`、`npm --version` 检查。使用便携 Node 时，例如 `npm i -g @anthropic-ai/claude-code` 或 `npm i -g @deepseek-ai/dsh` 会将 npm 全局包放到 `data/npm-global/`；这些额外引擎仍可能需要联网、认证、其他依赖或独立数据路径，换电脑后也可能需要重新配置。

## 快捷方式

双击 `创建桌面快捷方式.bat` 或 `CreateDesktopShortcut.bat`，脚本通过 PowerShell 和 `WScript.Shell` 在当前用户桌面写入 `Pi Web UI.lnk`，同名链接会被更新。链接指向便携包中的启动脚本，图标来自 `app/pi-web-ui-desktop.exe`，启动窗口设为最小化。

快捷方式保存的是创建时的绝对路径。移动文件夹或更换盘符后应重新创建；不需要时手动删除桌面链接即可。此操作会在宿主机写文件。

## 升级与迁移

1. 完全退出旧应用，停止仍在运行的相关终端与外部工具。
2. 备份整个旧目录，至少保留完整的 `data/`，以及实际使用的外部工作区或自定义数据目录。
3. 将新版本 ZIP 解压到**新目录**，把旧 `data/` 复制到新包中，保留新包的 `app/`、启动脚本、`Portable.flag` 和 `checks/`。
4. 按需迁移旧 `runtime/` 中自行安装的工具；如新包已包含新版工具，先检查版本与兼容性，避免直接覆盖回旧版。
5. 启动新目录，核对模型认证、会话、工作区与工具，再处理旧目录并重建快捷方式。

便携 ZIP 不应依赖安装版更新器来维护布局；优先采用上述手动迁移方式。全局执行 `npm i -g pi-web-ui@latest` 不会替换 `app/` 中的 Electron 应用。

**不要通过重跑 `scripts/make-portable.mjs` 升级正在使用的目录。** 它是分发包组装工具，会清空 `release/PiWebUI-Portable/data/` 下的 `agent`、`web`、`git`、`home`、`workspace`、`electron`、`npm-global`、`npm-cache`，并替换 `app/`。

## 启动脚本、环境变量与构建边界

`PiPortable.bat` 首先检查 `app/pi-web-ui-desktop.exe`，缺失时退出；对可选运行时的检查只验证入口文件，并不验证依赖是否完整。`checks/` 按控制台代码页显示补充信息：936 选择 GBK、65001 选择 UTF-8，其他代码页仍有脚本内的英文基础提示。

通过 BAT 启动时，脚本会覆盖以下变量为包内路径：

| 变量                                     | BAT 设置值                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `PI_PORTABLE` / `PI_PORTABLE_ROOT`       | `1` / 脚本所在目录                                                          |
| `PI_CODING_AGENT_DIR`                    | `<包根>/data/agent`                                                         |
| `PI_WEB_DATA_DIR`                        | `<包根>/data/web`                                                           |
| `PI_WEB_CWD`                             | `<包根>/data/workspace`                                                     |
| `GIT_CONFIG_GLOBAL`                      | `<包根>/data/git/.gitconfig`                                                |
| `HOME` / `USERPROFILE`                   | `<包根>/data/home`                                                          |
| `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE` | 检测到独立 Node 时设置为 `<包根>/data/npm-global` / `<包根>/data/npm-cache` |

脚本另传 `--user-data-dir=<包根>/data/electron` 并将额外参数转发给 EXE；这不表示所有 WebUI CLI 参数都会被桌面壳处理。`PI_WEB_PORT`、`PI_WEB_HEALTH_TIMEOUT_MS` 等未被 BAT 重设的变量可从父进程继承。

Electron 自身的便携探测由 `desktop/portable.ts` 实现：识别 `PI_PORTABLE_ROOT`、`PORTABLE_EXECUTABLE_DIR`、`PI_PORTABLE=1/true`，也识别 EXE 同级或特定父级的 `Portable.flag`、`portable.flag`、`data/`、`runtime/git`、`runtime/node`。因此在完整布局中直接打开 `app/pi-web-ui-desktop.exe` 也可激活便携模式。

需要自定义数据位置时，可直接启动 EXE，并按需设置绝对路径的 `PI_PORTABLE_DATA_DIR`、`PI_WEB_DATA_DIR`、`PI_CODING_AGENT_DIR`、`PI_WEB_CWD`、`PI_PORTABLE_HOME`、`GIT_CONFIG_GLOBAL`；检测到便携 Node 时也支持 `NPM_CONFIG_PREFIX`、`NPM_CONFIG_CACHE`。`PI_PORTABLE_DATA_DIR` 只改变其余未覆盖路径的默认基目录，**不会移动旧数据**。若经 BAT 启动，其硬编码赋值和 `--user-data-dir` 仍会生效，不能假定只设置一个变量就把所有数据搬走。

源码构建在仓库根进行，scripts 位于根 `package.json`：

```bash
npm ci
npm run desktop:portable       # 构建并组装目录，默认不下载 Git/Node
# 或：npm run desktop:portable:full  # 增加 Git，仍不自动下载独立 Node
```

已经构建服务端、前端与桌面壳后，可执行：

```bash
node scripts/make-portable.mjs --with-git --with-node --zip
```

输出为 `release/PiWebUI-Portable/`，加 `--zip` 时额外生成 `release/pi-web-ui-desktop-<版本>-portable.zip`。`--skip-pack` 仅跳过 electron-builder，要求已有正确的 `release/win-unpacked/`；组装脚本本身不编译源码。`PI_BUNDLE_PORTABLE_GIT=1` 与 `PI_BUNDLE_PORTABLE_NODE=1` 分别等效于对应下载选项。

当前 Release CI 显式使用 `--with-git --with-node`，但本地基础命令没有这两个默认下载行为，组装脚本还会复用已有 `runtime/`。当前自动下载源是 Windows x64 的 Git/Node，解压失败可能仅打印警告；分发者需要检查实际文件和版本，不能仅凭命令名或目录存在宣称“完整捆绑”。
