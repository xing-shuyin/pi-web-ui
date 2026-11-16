[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# frp-manager · 內網穿透

frp（fatedier/frp）一站式管理：**本機穿透列表 + 客戶端 frpc + 本地 frps 聯調 + 遠端公網 frps 一鍵部署**，TOML 新版格式（v0.52+）。

## 功能

| 頁籤      | 做什麼                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 穿透列表  | tcp/udp/http/https/stcp/xtcp 規則增刪改查、啟用/停用，frpc 啟停，一鍵安裝                                                               |
| 客戶端    | frpc.toml 服務端指向（serverAddr/serverPort/token/TLS），儲存後重啟生效                                                                 |
| 本地 frps | 本機起 frps 聯調（bindPort/http/dashboard/subdomainHost），啟停                                                                         |
| 遠端部署  | 從**共享 SSH 主機庫**（與遠端工作臺/SFTP 同一份，已儲存連線直接選）→ **測試連通** → **SSH 直裝**遠端 frps，或**複製一鍵指令碼**手動執行 |
| 日誌      | frpc / frps 各自最近 200 行                                                                                                             |

給 AI 的工具 `frp`（action 式）：`status|list|add|update|remove|toggle|set_server|frps_set|frpc_start|frpc_stop|frpc_restart|frps_start|frps_stop|logs|install|remote_list|remote_use|remote_probe|remote_deploy|remote_script`，引數只有 `action/name/json` 三個字串欄位。

## 資料與二進位制

- 狀態：`<dataDir>/frp-manager/state.json`（common/proxies/frps/remote），生成的 `frpc.toml` / `frps.toml` 同目錄
- 二進位制：`<dataDir>/frp-manager/bin/frpc[.exe]`、`frps[.exe]`；查詢順序 設定.frpcPath → bin/ → PATH
- 一鍵安裝：從 `github.com/fatedier/frp/releases` 按平臺下載（linux/darwin tar.gz，windows zip），解壓後提二進位制到 bin/；本機連不上 GitHub 時手動把官方包裡的 frpc/frps 拷進 bin/ 即可
- 遠端指令碼：Debian/Ubuntu/CentOS 通用，裝到 `/usr/local/bin/frps` + `/etc/frp/frps.toml` + systemd `frps.service`；經共享主機直裝時 base64 分片下發（非 root 自動 `sudo -n`），成功後 frpc 服務端地址自動同步為該主機

## 埠提醒

遠端公網機需放行：`bindPort/tcp`（預設 7000，frpc 連入）、`vhostHTTPPort`（http 穿透用）、`dashboard` 埠（7500）。本機 frpc 只出站連 7000，無需開入站。

## 檔案

- `manifest.json`：`view:true` + `ui/tools/http`
- `index.mjs`：純函式區（平臺對映/TOML/校驗/遠端指令碼，單測可直引）+ activate（狀態檔案/程序託管/AI 工具/HTTP 路由），刻意單檔案
- `client/entry.mjs`：面板（`mount(container)` → cleanup）
