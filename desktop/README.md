# pi-web-ui 桌面版（Electron）

桌面版把 pi-web-ui 本地服务和应用窗口放在一起，适合希望直接打开桌面应用的用户；聊天、文件、终端等功能复用网页版。运行已打包的桌面应用无需另装 Node.js 来启动服务，但 Git/Bash、额外引擎及其依赖是否可用，取决于包内运行时和本机环境。

- [官网](https://xing-shuyin.github.io/pi-web-ui-site/) · [完整安装与模型配置](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)
- [启动参数](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#cli-and-env) · [本地 /setup 配置指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#setup-page)
- [下载最新 Release](https://github.com/xing-shuyin/pi-web-ui/releases/latest)

## 内置浏览器与 Agent 切换

桌面窗口内置多标签浏览器，可在顶部切换「浏览器」「Agent」「分栏」。切换复用已有网页和 Agent 视图，保留网页登录态、输入内容和 Agent 草稿。浏览器先启动，本地 Agent 服务并行启动；服务不可用时仍可浏览网页。

地址栏支持输入网址或搜索词，`Ctrl/Cmd+L` 聚焦地址栏，`Ctrl/Cmd+T` 新建标签，浏览器模式下 `Ctrl/Cmd+W` 关闭标签，`Ctrl/Cmd+Shift+1/2/3` 切换三种模式。分栏模式可调整宽度。新标签页与浏览器设置提供书签、历史、下载、密码保险箱和扩展加载入口；旧 AI Browser 数据可以选择旧数据目录导入，已有文件不会覆盖。

内置 Agent 自动连接本地服务。需要使用远端 Web Agent 时，在浏览器设置中填写该服务地址并连接；之后使用内置浏览器打开这个受信任地址，也可以通过原生页面桥操作其他标签，无需安装 page-picker。AI 操作、截图和脚本执行各有开关，脚本执行默认关闭。普通网站无法调用浏览器控制或读取存储。

Office 支持文本/CSV 编辑，以及 DOCX/XLSX/PPTX 的只读内容预览；复杂排版、图片与公式计算不在当前预览范围。二进制文档不会被当作文本覆盖保存。本地文档必须先通过文件选择器打开。

模块边界、权限和构建说明见 [内置浏览器架构](../docs/architecture-browser.md)。

## 设备中心集成浏览器

桌面端点击“打开中心”，会打开独立的设备中心窗口，用于登录、创建账号及确认配对。主窗口继续轮询配对结果，确认后自动完成绑定；无需依赖系统浏览器的新标签。相同中心重复打开会复用窗口，窗口菜单提供前进、后退、刷新和返回中心首页。

每个中心 origin 使用独立的持久化 Electron session 保存登录状态，与本地应用及其他中心隔离。远程窗口无 preload、无 Node 权限、启用 sandbox，不允许跨 origin 导航和浏览器权限申请，不忽略证书错误。窗口标题始终显示实际中心地址。普通网页版仍使用浏览器原生新标签。

此能力需要更新并重启桌面壳，仅更新 Web 静态资源不能增加 preload/IPC 能力。旧版桌面壳继续使用原有外链方式。打开失败时页面保留中心地址供手动访问，主窗口配对等待状态不受影响。

## 选择与运行

| 形式                                            | 适用场景                 | 安装和启动                                                                                                  |
| ----------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Windows NSIS 安装包 `*-setup.exe`               | 固定电脑使用             | 运行安装程序，选择安装目录，再打开应用                                                                      |
| macOS `.dmg`                                    | Mac 桌面应用             | 将 `.app` 拖入 Applications 后打开                                                                          |
| Linux `.AppImage`                               | Linux 桌面应用           | 赋予执行权限后运行，如 `chmod +x ./文件名.AppImage`                                                         |
| Windows `pi-web-ui-desktop-<版本>-portable.zip` | 随移动硬盘携带程序和数据 | 完整解压到可写目录，运行根目录的 `启动Pi.bat` 或 `PiPortable.bat`，详见 [便携版说明](../launcher/README.md) |

Windows 便携 ZIP 是 Electron 应用加 `.bat` 启动脚本，运行它不需要 Python；它与 Python launcher 不是同一种分发形式。当前仓库的 `launcher/` 不含 Python 启动器。macOS 的更新用 ZIP 也不是 Windows 便携包。

首次进入应用后配置模型与认证。`/setup` 用于服务访问与网络配置，模型 API Key 在工作区设置中配置；需要打开 setup 时使用实际服务地址，例如默认端口下的 `http://127.0.0.1:8790/setup`，不要照搬网页版的 `8787`。

未经签名或公证的包可能被系统拦截，具体以下载产物为准。Windows 可能显示 SmartScreen 提示。macOS 若提示“已损坏”或被 Gatekeeper 拦截，在确认来源可信并将应用放入 Applications 后，可清除隔离属性再打开：

```bash
xattr -dr com.apple.quarantine /Applications/pi-web-ui-desktop.app
open -a /Applications/pi-web-ui-desktop.app
```

## 数据、端口与使用限制

非便携模式下，Electron 自身状态位于系统的 Electron `userData` 目录；服务数据默认在其 `data/` 子目录。`userData` 的具体位置受系统与应用名影响，应结合启动日志确认，不要将安装目录当成数据目录。

| 配置                       | 实际行为                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PI_WEB_DATA_DIR`          | 覆盖 WebUI 配置、插件等数据目录；非便携默认 `<userData>/data`，与 CLI 的 `~/.pi-web` 分开             |
| `PI_CODING_AGENT_DIR`      | 覆盖 pi 配置、认证与会话目录；非便携默认共享 `~/.pi/agent`                                            |
| `PI_WEB_CWD`               | 覆盖初始工作区；非便携代码默认用户主目录，建议显式指定项目目录，避免把整个家目录作为工作区            |
| `PI_WEB_PORT`              | 显式指定时优先尝试该端口；未设时优先 `8790`，所选端口占用则退回随机空闲口                             |
| `PI_WEB_HEALTH_TIMEOUT_MS` | 等待 `/api/health` 的毫秒数，默认 `60000`；正数最少 `1000`，非法值或非正数回落默认值                  |
| 访问口令环境变量           | 设置服务访问口令；桌面窗口首次加载时带 `?token=` 完成鉴权，随后前端清除 URL 中的 token                |
| `PI_WEB_DESKTOP_URL`       | 仅开发模式可将窗口指向已有服务；打包版忽略，见下文联调方式                                            |
| `PI_WEB_SDK=bundled`       | 强制使用自带 pi SDK；默认会在检测到机器上更新的 pi 副本时跟随，详情见 [环境变量](../docs/env-vars.md) |

固定端口让 Chromium 的 Origin 保持稳定，有助于保留主题、面板宽度等 localStorage 设置；回落随机端口后，这些按 Origin 保存的界面状态可能不同。桌面 sidecar 固定监听 `127.0.0.1`；需要远程部署请参考[部署文档](../docs/deployment.md)。

- 与 CLI/网页版并用时，默认共享的 `~/.pi/agent` 包含会话记录，避免两个服务同时操作同一对话；要隔离可设置 `PI_CODING_AGENT_DIR`。不要让两个服务同时写同一 WebUI data-dir。
- `browser_page` 依赖浏览器 page-picker 扩展，在 Electron 窗口中不可用；请在支持该扩展的浏览器中打开服务地址并授权页面。其他浏览器工具有各自的运行条件。
- renderer 开启 `contextIsolation`、`sandbox`，关闭 Node 集成；应用外部导航经过 URL 守卫，允许的外链交给系统浏览器。工具和外部程序仍可能访问本机资源，这些设置不等于操作系统级隔离。
- 便携模式重定向主要应用数据，不保证操作系统、临时目录、外部 CLI 或用户选择的工作区不留下痕迹。

## 升级与备份

安装版可在应用更新面板检查、下载并安装更新。主进程通过 `electron-updater` 读取 GitHub Release 的 `latest*.yml`：启动时仅检查元数据，不自动下载；用户下载完成后可“安装并重启”，退出时也允许安装。能否更新取决于对应平台的产物、feed、网络和系统签名要求，不能保证每一种解包目录都支持原地更新。

`npm i -g pi-web-ui@latest` 更新的是全局 npm 包，不会替换桌面应用内部的 `dist/server`。更新失败时，从 Release 下载对应平台的新包安装；先退出应用并备份 WebUI 数据目录及 Agent 目录。便携 ZIP 应按[便携版手动升级步骤](../launcher/README.md#升级与迁移)操作，避免更新后改变便携布局。

## 从源码运行与构建

以下命令均在仓库根目录执行。需要 Node.js **>=22.19.0**、npm，以及包含 devDependencies 的依赖安装。桌面 scripts 定义在根 [package.json](../package.json)，没有独立的 `desktop/package.json`。

```bash
npm ci
npm run build           # 生成服务端、前端和配套运行资源
npm run desktop:dev     # 编译桌面壳，再以 Electron 启动本地 sidecar
```

`desktop:dev` 只执行 `build:desktop` 后启动 Electron，不会重建服务端或前端；修改这些内容后需要重新 `npm run build`。需要 Vite 热更新时，在一个终端执行 `npm run dev`（服务端 `8788`、前端 `5173`），另一个终端启动桌面壳：

```bash
# POSIX shell
PI_WEB_DESKTOP_URL=http://localhost:5173 npm run desktop:dev
```

```powershell
# PowerShell
$env:PI_WEB_DESKTOP_URL = 'http://localhost:5173'
npm run desktop:dev
Remove-Item Env:PI_WEB_DESKTOP_URL
```

此 override 直接使用已有地址，不另起 sidecar；联调数据与端口由单独启动的开发服务决定。

| 命令                            | 构建内容与输出                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run build:desktop`         | 仅用 `desktop/tsconfig.json` 编译桌面壳到 `dist/desktop/`                                     |
| `npm run desktop:dist`          | 先构建应用与桌面壳，再按 electron-builder 配置生成当前平台产物，输出到 `release/`             |
| `npm run desktop:portable`      | 构建应用与桌面壳，再组装 Windows `release/PiWebUI-Portable/`；默认不下载 Git/Node，不生成 ZIP |
| `npm run desktop:portable:full` | 同上，但增加 `--with-git`；名称中的 full 不表示包含独立 Node.js                               |

Windows 便携组装建议在 Windows 上执行。已完成 `npm run build` 和 `npm run build:desktop` 后，可直接传组装参数：

```bash
node scripts/make-portable.mjs --with-git --with-node --zip
# 仅当 release/win-unpacked 已确认是本次目标构建时：
node scripts/make-portable.mjs --skip-pack --with-git --with-node --zip
```

组装脚本不是升级器：每次都会替换输出的 `app/` 并清空 `data/` 下的八个标准子目录，勿在使用中的便携目录上重跑。它还会复用已有 `runtime/`，所以无下载参数不代表输出一定不含旧运行时。electron-builder 失败时，脚本可能回落到已有 `release/win-unpacked`；分发前确认版本与运行时内容。

`--with-git` / `PI_BUNDLE_PORTABLE_GIT=1` 下载 PortableGit，`--with-node` / `PI_BUNDLE_PORTABLE_NODE=1` 下载独立 Node.js；下载和解压需要网络及可用的 `curl`、解压工具。`--zip` 额外生成 `release/pi-web-ui-desktop-<版本>-portable.zip`。当前脚本固定下载 Windows x64 的 Git/Node，不是通用跨平台运行时。完整布局与手动补充方法见[便携版说明](../launcher/README.md)。

## 开发架构与打包配置

```text
Electron 主进程（desktop/main.ts）
  ├─ Electron 二进制 + ELECTRON_RUN_AS_NODE=1
  │    └─ dist/server/index.js --host 127.0.0.1 --port <选定端口>
  └─ /api/health 就绪后，BrowserWindow 加载本地服务
```

服务端以 sidecar 子进程运行，复用 `dist/server` 和 `web/dist`；前端继续使用 `appUrl("/ws")` 与 `location.host`，无需另起桌面 wire 协议。启动超时或 sidecar 在就绪前退出会使桌面应用非零退出。应用退出时清理 sidecar；macOS 关闭所有窗口后应用仍可驻留；当前实现再次点击 Dock 时会退出，需重新启动应用。完全退出才结束服务。单实例锁用于再次启动时聚焦已有窗口。

维护时需保留这些约束：

- [main.ts](./main.ts) 是主进程入口，[preload.cts](./preload.cts) 提供窗口和更新 IPC，[startup.ts](./startup.ts) 负责启动辅助逻辑，[portable.ts](./portable.ts) 负责便携路径探测与环境注入。
- ESM 入口不能顶层 `await app.whenReady()`：Electron 等入口求值结束才发 ready，会互相等待。保持 `app.whenReady().then(...)` 的启动方式。
- [electron-builder.yml](./electron-builder.yml) 用 `extraMetadata.main` 覆盖根包的 CLI 入口为 `dist/desktop/main.js`；`asar: false` 让 sidecar 和原生模块直接从文件系统运行。
- `npmRebuild: false` 基于当前 `node-pty` 的 N-API 预编译产物；升级原生依赖时需重新核实目标平台支持，不能据此承诺所有平台都不需要编译工具。
- 图标来源为 `web/public/icons/icon-1024.png`。Windows 目标为 NSIS + dir，macOS 为 DMG + ZIP，Linux 为 AppImage。macOS ZIP 用于 updater；Windows NSIS 产物名保持无空格，避免 feed 与 Release 资产 URL 不一致。

## 发布与签名

[desktop-release.yml](../.github/workflows/desktop-release.yml) 在 `v*` tag 推送时，分别在 Windows/macOS/Linux runner 构建并上传 Release 资产；手动运行只生成 workflow artifact。electron-builder 使用 `--publish never` 生成产物与更新元数据，随后由 `gh release upload` 上传。

当前 Windows CI 另执行 `make-portable.mjs --skip-pack --zip --with-git --with-node`，因此该工作流成功生成的便携 ZIP 会尝试捆绑 Git 与独立 Node；本地基础构建没有这两个默认下载选项。分发前仍需核实 `runtime/git/cmd/git.exe` 和 `runtime/node/node.exe`，脚本部分解压失败仅发出警告。

Windows CI 已接入 SignPath，但签名步骤允许失败，且当前配置使用 `test-signing`；不能把所有 Release 产物视为已受信任签名。便携目录在签名替换安装器之前组装，也不能从安装器签名推断 ZIP 内应用的签名状态。

本地 electron-builder 可通过 `CSC_LINK` 和 `CSC_KEY_PASSWORD` 提供签名证书。macOS 的 Developer ID 签名和公证需要相应 Apple 凭据与环境，例如 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；是否成功应检查构建输出及实际产物。SignPath 不替代 macOS 签名/公证，自签名证书也不等于获得系统信任。完整发布流程见[发布文档](../docs/release.md)。
