# 部署

pi-web-ui 是纯 Web 服务（Node + Express + WebSocket）；另有 **Electron 桌面壳**（`desktop/`，见 `desktop/README.md`）—— 随机空闲口起同一个 server + BrowserWindow，网页版零改动，三平台安装包（Windows/macOS/Linux）随 GitHub Release 发布（CI 出包，当前未签名）。

## CLI

`pwu`、`piwebui`、`pi-web-ui` 是同一 CLI 的等价命令，所有子命令和选项通用。全局安装或更新后即可使用 `pwu`。前台启动可传一个已有目录（相对或绝对路径，含空格时加引号），与 `--cwd` 不能同时使用；目录参数优先于 `PI_WEB_CWD`。与子命令同名的目录请使用 `./目录名` 或 `--cwd`。

```bash
pwu .                                    # 以当前目录启动
pwu ./my-project --port 9000              # 以指定目录启动
pi-web-ui --port 9000 --cwd /path          # 前台
pi-web-ui install <源> [--name --force --data-dir]  # 安装 GitHub 界面插件到 <dataDir>/plugins/
#                                源: owner/repo · https://github.com/o/r[/tree/分支/子目录] · #分支 · 本地目录；刷新浏览器即生效
pi-web-ui plugins / uninstall <id>          # 列出 / 卸载界面插件
pi-web-ui plugins --check-updates          # 逐个对比远端 HEAD，列出可更新插件
pi-web-ui plugins --rollback <id>          # 回滚到最近一份更新前备份（<dataDir>/plugin-backups/）
pi-web-ui server install [--port --cwd --data-dir --name]   # 开机自启：
#                                           #   macOS→launchd（无需 sudo）
#                                           #   Linux→systemd（自动 sudo）
#                                           #   Windows→登录自启 Run 键（HKCU，无需管理员；wscript 隐藏启动无黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一键启动」图标（启动服务并打开浏览器）：
#                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服务未运行则在本
#                                           #     隐藏窗口前台启动并记录 PID，server stop/uninstall 可止停）
#                                           #   macOS→桌面 .command 双击启动器（已装 launchd 则 kickstart，否则终端前台）
#                                           #   Linux→桌面 .desktop 图标 + ~/.local/share/pi-web-ui 启动脚本（systemctl 优先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（端口映射 + 挂载数据目录）
```

> Windows 自启服务 = HKCU 登录 Run 键 + wscript/VBS 隐藏启动器（生成在 `%APPDATA%\pi-web-ui\`，
> 无黑窗、无需管理员）；ps1 内置看门狗，服务器崩溃 10 秒后自动重启。旧版本的计划任务安装会在
> install 时自动迁移（删除任务，改用 Run 键）。服务安装未指定 --cwd 时默认以用户主目录为工作目录
> （前台启动仍默认当前目录）。

> uninstall 会自动移除桌面图标；未装服务时桌面快捷方式启动的实例在 status/stop 中单独报告（PS1 前台+记录 PID）。

## 引擎选择

默认使用 pi 引擎（`@earendil-works/pi-coding-agent` SDK，进程内）。用 `--engine dsh`
（或设 `PI_WEB_ENGINE=dsh`）切换为 DeepSeek Harness（DSH）子进程引擎：

```bash
pi-web-ui --engine dsh --port 9000 --cwd /path        # flag 优先
PI_WEB_ENGINE=dsh pi-web-ui --port 9000 --cwd /path   # 环境变量后备
```

- **运行中可切换**：界面中的引擎选择器可在 pi、DSH、Claude Code、Codex 与 Durable 间切换；启动参数设置默认引擎。
- **共用界面协议**：各引擎共用 `server/protocol.ts`，支持的目标、审查、工具及会话操作由能力声明控制。
- DSH 架构与差异见 `docs/dsh-engine.md`。
- **Codex**：先运行 `npm i -g @openai/codex` 和 `codex login`，然后在选择器中切换，或使用 `pi-web-ui --engine codex --cwd /path` 启动。沿用本机 Codex 配置与认证；详情见 `docs/architecture-core.md` 的 Codex CLI 引擎章节。

前台启动的其它设置也都是 flag：`--port` / `--cwd` / `--data-dir` / `--host` /
`--agent-dir`（flag 优先，环境变量后备）。

### DSH 运行时树（必备依赖）

DSH 引擎把官方 `@deepseek-ai/dsh` 运行时作为子进程拉起，需要一棵完整的运行时树：

```bash
npm i -g @deepseek-ai/dsh@0.1.1-rc.2   # 全局安装（自带嵌套运行时树，约 196 包）
```

运行时树解析顺序：`PI_WEB_DSH_RUNTIME`（显式指定）→ 本包 node_modules →
`execPath` 邻近 node_modules → `npm root -g`。三种布局（本包全量安装 / fnm / 全局）
都能命中；解析失败时服务启动会报错并给出提示。诊断：`PI_WEB_DSH_DEBUG=1` 把
运行时 RPC 帧与生命周期事件打到 stderr。

### DSH 环境变量速览

| 变量                                | 默认              | 作用                                                                            |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `PI_WEB_ENGINE`                     | `pi`              | 引擎：`pi` / `dsh` / `claude` / `codex` / `durable`（启动默认值，界面可热切换） |
| `PI_WEB_DSH_RUNTIME`                | 自动解析          | 运行时树根（node_modules 根，含 `@deepseek-ai/dsh-base`）                       |
| `PI_WEB_DSH_DATA_DIR`               | `PI_WEB_DATA_DIR` | DSH 专用数据目录（用户 patch 层 `<dir>/dsh-patches/*.yml`）                     |
| `PI_WEB_DSH_PATCH_DIR`              | 空                | 用户 patch 目录显式覆盖（优先级高于推导）                                       |
| `PI_WEB_DSH_QUESTION_TIMEOUT_MS`    | `600000`          | 模型 ask_user_question 提问桥超时（前端倒计时）                                 |
| `PI_WEB_DSH_SESSION_RETENTION_DAYS` | `90`              | 会话 JSONL 保留天数（0 = 关闭清理）                                             |
| `PI_WEB_DSH_DEBUG`                  | 空                | `1` 时输出运行时诊断到 stderr                                                   |

完整列表见 `docs/env-vars.md`。

### 用户补丁层（dsh-patches）

DSH 引擎在官方配置之上叠加两层 patch：内置 `override.patch.yml` + 用户层。用户把
`*.yml`（cordis patch 语法，与官方 `cordis.patch.yml` 同构）放进
`<dataDir>/dsh-patches/`（或 `PI_WEB_DSH_PATCH_DIR` 指定目录），launcher 按文件名序
在 override 之后加载；设置面板「界面插件」页签可查看列表并重扫（重扫会重启运行时）。

### 服务安装（systemd / launchd）加引擎

`pi-web-ui server install` 会把 `--engine` / `--host` / `--agent-dir` 一并烘焙进服务配置：

```bash
pi-web-ui server install --engine dsh --port 9000 --cwd /path
```

Linux 的 `server install` 会把调用者环境中的 `PI_WEB_TOKEN` 一并写入 systemd unit。
端口为 1–1023（例如 80/443）时，自动添加以下配置，让服务以原用户运行而无需 root：

```ini
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

默认端口 8787 等非特权端口不会增加 capability。安装器在提权前生成配置，随后仅对安装文件
及 `systemctl` 操作使用 sudo，因此不会因 sudo 清理环境而丢失端口、host、token、PATH 或用户工作目录。
示例（在普通用户的 Bash 中运行，无需在整条命令前加 sudo）：

```bash
read -rsp 'PI_WEB_TOKEN: ' PI_WEB_TOKEN; echo
export PI_WEB_TOKEN
PI_WEB_HOST=0.0.0.0 PI_WEB_PORT=80 pi-web-ui server install --cwd "$HOME/projects/pi-web-cwd"
unset PI_WEB_TOKEN
```

unit 以 root 所有、0600 权限安装；配置通过 stdin 交给安装命令，token 不进入命令行参数。
重新安装会 daemon-reload 并重启服务，使修改后的配置立即生效（会中断当前连接）。
每次重新安装都应再次提供 `PI_WEB_TOKEN`；未提供时生成的 unit 不含该变量，显式空值则清除鉴权口令。
`--print` 仍不安装、不提权，但会打印包含 token 的完整 unit，请勿公开其输出。
环境变量不是秘密存储：systemd 的管理接口及服务进程仍可能暴露环境，不要仅依赖文件权限保护凭据。
监听 `0.0.0.0` 前请确认网络访问范围；公网部署应使用 TLS 反代，HTTP 本身不加密口令。

DSH 专属运行时变量（`PI_WEB_DSH_RUNTIME` 等）仍需手动加入服务配置。
`PI_WEB_TOKEN` 没有命令行 flag；非 Linux 平台仍需手动编辑服务配置：

```ini
# systemd: /etc/systemd/system/pi-web-ui.service 的 [Service] 段
Environment=PI_WEB_DSH_RUNTIME=/usr/local/lib/node_modules
Environment=PI_WEB_DSH_DATA_DIR=/var/lib/pi-web-ui
Environment=PI_WEB_TOKEN=s3cret
# reload: sudo systemctl daemon-reload && sudo systemctl restart pi-web-ui
```

```xml
<!-- launchd: ~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist 的 dict 内 -->
<key>EnvironmentVariables</key>
<dict>
    <key>PI_WEB_DSH_RUNTIME</key><string>/usr/local/lib/node_modules</string>
    <key>PI_WEB_TOKEN</key><string>s3cret</string>
</dict>
<!-- reload: launchctl bootout gui/$(id -u)/com.xingshuyin.pi-web-ui && \
            launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist -->
```

注意：launchd/systemd 运行环境极简（无 PATH/无 locale），全局 `dsh` 若装在用户目录
（如 `~/.local`），请用 `PI_WEB_DSH_RUNTIME` 显式指定，否则解析不到。

## 子路径反代（nginx 挂在 /pi/ 等路径下）

页面挂在 `https://example.com/pi/` 而非根路径时，nginx 需要**剥离前缀**转发。
浏览器侧会自动从页面 baseURI 推导应用根（/pi/），插件 bundle、WebSocket（`/pi/ws`）、
`/api`、`/themes` 全部请求都会带上 `/pi/` 前缀。

```nginx
# 配合 WebSocket 升级映射（建议写在 http {} 块中）：
# map $http_upgrade $connection_upgrade {
#     default upgrade;
#     ''      close;
# }

server {
    listen 80;
    server_name example.com;

    # 子路径 WebSocket：前端在 /pi/ 基础路径下连接 /pi/ws，剥离前缀转发到 /ws
    location /pi/ws {
        proxy_pass http://127.0.0.1:8787/ws;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # 关键是 proxy_pass 末尾的 /：剥离 /pi 前缀后透传给后端（8787 为默认端口）
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # WebSocket 升级头必须透传
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # 必须用 $http_host 保留端口（服务端的 Origin 校验包含主机名与端口，$host 会丢掉端口导致 403）
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

注意：

- **`Host` 必须使用 `$http_host`**（保留原始端口）——后端的 Origin 校验要求 hostname 与端口完全一致，若使用 `$host` 会丢弃非标准端口引发 403。
- **长连接超时**：WebSocket 需要显式声明 `proxy_read_timeout 3600s;`，避免终端或长时间 AI 回答因 nginx 默认 60s 超时而意外断连。
- 官方 dist 的静态资源是根绝对路径（`/assets/...`），与 JS 里的应用根推导无关。
  要让 HTML 在 /pi/ 下渲染，二选一：① 另加一条 `location /assets/ { proxy_pass
http://127.0.0.1:8787; }` 转发静态资源；② 用 `vite build --base=/pi/` 重新构建
  （产物里 assets 引用与 `import.meta.env.BASE_URL` 均为 /pi/，与 baseURI 推导
  结果一致，两种方式可混用）。
- 插件目录（`<dataDir>/plugins/`）不需要在 nginx 单独配置——客户端请求
  `/pi/plugins/...`，剥离前缀后由后端标准路由处理。完整示例见 `deploy/nginx-subpath.conf`。
