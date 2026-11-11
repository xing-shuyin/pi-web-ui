# frp-manager · 内网穿透

frp（fatedier/frp）一站式管理：**本机穿透列表 + 客户端 frpc + 本地 frps 联调 + 远端公网 frps 一键部署**，TOML 新版格式（v0.52+）。

## 功能

| 页签      | 做什么                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 穿透列表  | tcp/udp/http/https/stcp/xtcp 规则增删改查、启用/禁用，frpc 启停，一键安装                                                             |
| 客户端    | frpc.toml 服务端指向（serverAddr/serverPort/token/TLS），保存后重启生效                                                               |
| 本地 frps | 本机起 frps 联调（bindPort/http/dashboard/subdomainHost），启停                                                                       |
| 远端部署  | 从**共享 SSH 主机库**（与远程工作台/SFTP 同一份，已保存连接直接选）→ **测试连通** → **SSH 直装**远端 frps，或**复制一键脚本**手动执行 |
| 日志      | frpc / frps 各自最近 200 行                                                                                                           |

给 AI 的工具 `frp`（action 式）：`status|list|add|update|remove|toggle|set_server|frps_set|frpc_start|frpc_stop|frpc_restart|frps_start|frps_stop|logs|install|remote_list|remote_use|remote_probe|remote_deploy|remote_script`，参数只有 `action/name/json` 三个字符串字段。

## 数据与二进制

- 状态：`<dataDir>/frp-manager/state.json`（common/proxies/frps/remote），生成的 `frpc.toml` / `frps.toml` 同目录
- 二进制：`<dataDir>/frp-manager/bin/frpc[.exe]`、`frps[.exe]`；查找顺序 设置.frpcPath → bin/ → PATH
- 一键安装：从 `github.com/fatedier/frp/releases` 按平台下载（linux/darwin tar.gz，windows zip），解压后提二进制到 bin/；本机连不上 GitHub 时手动把官方包里的 frpc/frps 拷进 bin/ 即可
- 远端脚本：Debian/Ubuntu/CentOS 通用，装到 `/usr/local/bin/frps` + `/etc/frp/frps.toml` + systemd `frps.service`；经共享主机直装时 base64 分片下发（非 root 自动 `sudo -n`），成功后 frpc 服务端地址自动同步为该主机

## 端口提醒

远端公网机需放行：`bindPort/tcp`（默认 7000，frpc 连入）、`vhostHTTPPort`（http 穿透用）、`dashboard` 端口（7500）。本机 frpc 只出站连 7000，无需开入站。

## 文件

- `manifest.json`：`view:true` + `ui/tools/http`
- `index.mjs`：纯函数区（平台映射/TOML/校验/远端脚本，单测可直引）+ activate（状态文件/进程托管/AI 工具/HTTP 路由），刻意单文件
- `client/entry.mjs`：面板（`mount(container)` → cleanup）
