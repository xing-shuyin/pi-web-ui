[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# 📝 vscode-editor —— pi-web-ui 编辑器 + SSH 插件（Remote-SSH）

在 pi-web-ui 界面里提供一个类 VSCode 的工作台视图：

- **多根文件树**：本地工作区 + 已保存的 SSH 主机（同一棵树、同一组标签页）
- **工作区跟随**：主应用切换项目（set_cwd）后，本地树根目录实时切到新项目——
  自动清理目录缓存/展开状态、关闭本地标签（有未保存修改会提示），远端 SSH
  标签与连接不受影响；`.vscode/sftp.json` 每项目独立，切换后自动重读
- **CodeMirror 6 多标签编辑器**：本地/远程文件同开，语法高亮、Ctrl+S 保存
  （远程文件经 SFTP 写回）、CRLF 行尾保留、Ctrl+P 快速打开（本地）
- **VS Code 式标签管理**（issue #920）：标签右键菜单提供固定/取消固定、向右拆分、
  向下拆分、在编辑组之间移动、合并分组、关闭/关闭其他/关闭右侧；标签可拖拽排序、
  跨组拖拽（空组自动收起），未保存的编辑随标签一起迁移。窄屏下左右拆分自动改为上下堆叠
- **界面语言只跟宿主**：插件不保存自己的语言偏好，由 `__piWebUiHost.locale`
  （`current()` / `onChange()`）决定中英文；manifest 提供 `nameEn` / `descriptionEn`，
  英文界面下顶栏标题、插件菜单、设置面板与插件内文案一致切英文

> 编辑组与标签是插件自己的运行态（宿主只提供语言与布局能力，没有通用编辑器 tab API ——
> 只有一个编辑器类插件时抽公共层得不偿失）。插件视图在切换工具时**保持挂载**（只隐藏），
> 所以组结构、当前标签与未保存内容会保留；刷新页面后重置。

- **底部可拖拽终端面板**：每台已连接主机可开多个 shell（xterm.js），窗口
  尺寸同步、keepalive 保活；右键远端文件/文件夹可在所在目录打开终端
- **右键菜单继承宿主扩展点（contextmenu.file）**：本地文件树右键直接呼出宿主
  全局统一的右键菜单，自动继承宿主内置文件操作及所有其他插件注册的能力
  （如配合 `@plugins/sftp` 插件时，右键自动出现「上传到远端 / 上传此目录 / 从远端下载 /
  添加到 SFTP 忽略」等完整能力，无需在编辑器内单独配置与维护）
- **下载到电脑**（右键菜单）：本地文件直下；远端文件/文件夹不经工作区映射、
  文件夹在远端就地 tar.gz 打包，保存位置自选
- **上传文件**：工具栏 ⬆ 一键上传到工作区根目录；右键菜单「上传文件到此处…」
  （文件夹行 → 该文件夹、文件行 → 其所在目录、树内**空白处右键** → 该树根目录/
  首台已连 SSH 主机根；本地与远端 SFTP 均支持）；拖拽文件到文件树——文件夹行 →
  该文件夹、文件行 → 其所在目录、空白处 → 根目录（分片协议带覆盖确认与进度提示，
  树内拖拽会被插件拦截，不会触发主应用的「附加到对话」）

原独立的 ssh 插件已合并进来：旧 `<pluginDir>/ssh-hosts.json` 主机配置在首次
激活时自动迁移，无需手工搬。

## SSH config 自动加载（与 VSCode Remote-SSH 同源）

- **免导入直连**：SSH 面板顶部「⚙ ssh config（自动加载）」区直接列出
  `~/.ssh/config` 里的所有主机，点别名即连——VSCode 里能连的这里也能连，
  改完 config 点 ⟳ 刷新即生效，无需导入到手动主机。
- **写法完全一样**：就是 OpenSSH config 语法。`Host` / `HostName` / `User` /
  `Port` / `IdentityFile`（多个全试）/ `ProxyJump`（多跳逗号分隔）/
  `ProxyCommand`（`%h`/`%p` 展开）/ `ForwardAgent` 全支持；`Host *` 通配块作
  默认值继承（`ssh -G` 语义：首值优先）；`Include` 递归展开（含 glob，
  相对 `~/.ssh/` 解析）——VSCode 的 `Remote-SSH: Open Configuration File`
  改的同一个文件，面板 ✎ 可直接编辑（保存自动备份 `config.bak`）。
- **认证同 ssh 命令**：IdentityFile 全部试读（`~` 展开）→ 本机默认私钥
  （`~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`）→ `SSH_AUTH_SOCK`；
  config 里没有密码字段（和 VSCode 一样），要用密码登录的请用「🏠 手动主机」。
- 手动主机（`ssh-hosts.json`，密码/私钥进加密存储）与批量导入保留，AI 的
  `vsc_ssh_connect` 传 `alias` 参数可直连 config 主机。

## 文件树交互

- **原地展开/收起**：点文件夹只加载该目录子列表（带「⏳ 加载中」占位），
  不整树重绘闪烁；收起零延迟
- **选中高亮**：点/右键任意行都高亮选中，工具栏 ＋📄/＋📁 以当前选中目录
  为落点（选文件则落在其所在文件夹）；新建/创建副本成功后新条目成为选中项
- **右键菜单**：本地树无缝继承宿主 `contextmenu.file` 全局右键菜单，具备
  完整的文件操作与第三方插件（如 `@plugins/sftp`）能力；远端树支持：新建 / 重命名 /
  删除（目录递归删）/ 剪切 / 复制 / 粘贴到此处（同 scope 内移动或复制）/
  创建副本（`foo_copy.js`，重名自动递增）/ 复制路径 / 上传文件到此处… /
  下载到电脑 / 打开终端（远端行，scope 感知）
- **文件名搜索**：两棵树工具栏 🔍（本地全仓 / 远端以当前选中目录为起点收窄），
  结果复用 Ctrl+P 浮层（远端命中带 🌐 标记），点选即打开

## 统一范围模型

scope = `"local" | connId`。前端所有文件操作（list/read/write/create/rename/
delete/copy/search）携带 scope，远程时自动附加 connId——服务端据此路由到本地
fs 或该连接的 SFTP，前后端共用一套代码路径。`copy` 语义：`src` + `dest` 均为
完整路径（本地相对工作区、远端绝对路径），`dest` 已存在一律拒绝（副本名由
调用方按 `_copy` 后缀算好），`move: true` 为移动/改名；`search` 为文件名
大小写不敏感子串搜索（50 条封顶，本地 `base` 相对路径、远端 `baseDir` 绝对路径）。

## 目录结构

```
vscode-editor/
├── manifest.json        # 插件清单（id/icon/name）
├── index.mjs            # 服务端入口：本地文件 CRUD / SSH 主机管理 + 连接池 + PTY shell + exec + 远程 SFTP 操作
├── src/client.js        # 客户端源码（CodeMirror 6 + xterm.js）
├── build.mjs            # esbuild 打包脚本（xterm CSS 内联为文本）
├── package.json         # 构建/依赖清单（ssh2 为 devDep，运行时由服务端自动补装）
└── client/entry.mjs     # 构建产物（自包含 bundle，浏览器直接加载）
```

## 安装 / 卸载 / 更新

```bash
# ── 安装 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor
pi-web-ui install plugins/vscode-editor  # 或本地目录（开发态）
# 可选：--data-dir <dir> 自定义数据目录（默认 ~/.pi-web）

# ── 查看 ──
pi-web-ui plugins                            # 列出已装插件与 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor --force
                                             # --force 覆盖重装即更新
                                             # ⚠ 先备份插件目录里的 ssh-hosts.json 与
                                             #   工作区 .vscode/sftp.json（主机凭据/同步配置）

cp -r plugins/vscode-editor ~/.pi-web/plugins/  # 本地开发态：改完 src 后先 npm run build 再拷贝
                                             # Windows: %USERPROFILE%\.pi-web\plugins\vscode-editor
                                             # 只需 manifest.json + index.mjs + client/ 三部分，
                                             # node_modules / src / build.mjs 不需要拷贝

# ── 卸载 ──
pi-web-ui uninstall vscode-editor            # 移除插件目录（ssh-hosts.json 一并删除）
# 手动方式：rm -rf ~/.pi-web/plugins/vscode-editor
```

刷新页面后顶栏出现 📝 标签即成功。依赖 ssh2 不随包分发，首次激活自动 npm
补装到插件目录（失败可点侧栏「⚠ssh2」按钮手动触发）。
