[English](./deployment.en.md) · [简体中文](./deployment.md) · **繁體中文**

# 部署

pi-web-ui 是純 Web 服務（Node + Express + WebSocket）；另有 **Electron 桌面殼**（`desktop/`，見 `desktop/README.md`）—— 隨機空閒口起同一個 server + BrowserWindow，網頁版零改動，三平臺安裝包（Windows/macOS/Linux）隨 GitHub Release 釋出（CI 出包，當前未簽名）。

## CLI

`pwu`、`piwebui`、`pi-web-ui` 是同一 CLI 的等價命令，所有子命令和選項通用。全域性安裝或更新後即可使用 `pwu`。前臺啟動可傳一個已有目錄（相對或絕對路徑，含空格時加引號），與 `--cwd` 不能同時使用；目錄引數優先於 `PI_WEB_CWD`。與子命令同名的目錄請使用 `./目錄名` 或 `--cwd`。

```bash
pwu .                                    # 以當前目錄啟動
pwu ./my-project --port 9000              # 以指定目錄啟動
pi-web-ui --port 9000 --cwd /path          # 前臺
pi-web-ui install <源> [--name --force --data-dir]  # 安裝 GitHub 介面外掛到 <dataDir>/plugins/
#                                源: owner/repo · https://github.com/o/r[/tree/分支/子目錄] · #分支 · 本地目錄；重新整理瀏覽器即生效
pi-web-ui plugins / uninstall <id>          # 列出 / 解除安裝介面外掛
pi-web-ui plugins --check-updates          # 逐個對比遠端 HEAD，列出可更新外掛
pi-web-ui plugins --rollback <id>          # 回滾到最近一份更新前備份（<dataDir>/plugin-backups/）
pi-web-ui server install [--port --cwd --data-dir --name]   # 開機自啟：
#                                           #   macOS→launchd（無需 sudo）
#                                           #   Linux→systemd（自動 sudo）
#                                           #   Windows→登入自啟 Run 鍵（HKCU，無需管理員；wscript 隱藏啟動無黑窗）
pi-web-ui server shortcut [--port --cwd --data-dir --name]  # 桌面「一鍵啟動」圖示（啟動服務並開啟瀏覽器）：
#                                           #   Windows→桌面 .lnk（WScript.Shell COM，OneDrive 安全；服務未執行則在本
#                                           #     隱藏視窗前臺啟動並記錄 PID，server stop/uninstall 可止停）
#                                           #   macOS→桌面 .command 雙擊啟動器（已裝 launchd 則 kickstart，否則終端前臺）
#                                           #   Linux→桌面 .desktop 圖示 + ~/.local/share/pi-web-ui 啟動指令碼（systemctl 優先）
pi-web-ui server status|restart|stop|uninstall
# Docker：docker-compose.yml（埠對映 + 掛載資料目錄）
```

> Windows 自啟服務 = HKCU 登入 Run 鍵 + wscript/VBS 隱藏啟動器（生成在 `%APPDATA%\pi-web-ui\`，
> 無黑窗、無需管理員）；ps1 內建看門狗，伺服器崩潰 10 秒後自動重啟。舊版本的計劃任務安裝會在
> install 時自動遷移（刪除任務，改用 Run 鍵）。服務安裝未指定 --cwd 時預設以使用者主目錄為工作目錄
> （前臺啟動仍預設當前目錄）。

> uninstall 會自動移除桌面圖示；未裝服務時桌面快捷方式啟動的例項在 status/stop 中單獨報告（PS1 前臺+記錄 PID）。

## 引擎選擇

預設使用 pi 引擎（`@earendil-works/pi-coding-agent` SDK，程序內）。用 `--engine dsh`
（或設 `PI_WEB_ENGINE=dsh`）切換為 DeepSeek Harness（DSH）子程序引擎：

```bash
pi-web-ui --engine dsh --port 9000 --cwd /path        # flag 優先
PI_WEB_ENGINE=dsh pi-web-ui --port 9000 --cwd /path   # 環境變數後備
```

- **執行中可切換**：介面中的引擎選擇器可在 pi、DSH、Claude Code、Codex 與 Durable 間切換；啟動引數設定預設引擎。
- **共用介面協議**：各引擎共用 `server/protocol.ts`，支援的目標、審查、工具及會話操作由能力宣告控制。
- DSH 架構與差異見 `docs/dsh-engine.md`。
- **Codex**：先執行 `npm i -g @openai/codex` 和 `codex login`，然後在選擇器中切換，或使用 `pi-web-ui --engine codex --cwd /path` 啟動。沿用本機 Codex 配置與認證；詳情見 `docs/architecture-core.md` 的 Codex CLI 引擎章節。

前臺啟動的其它設定也都是 flag：`--port` / `--cwd` / `--data-dir` / `--host` /
`--agent-dir`（flag 優先，環境變數後備）。

### DSH 執行時樹（必備依賴）

DSH 引擎把官方 `@deepseek-ai/dsh` 執行時作為子程序拉起，需要一棵完整的執行時樹：

```bash
npm i -g @deepseek-ai/dsh@0.1.1-rc.2   # 全域性安裝（自帶巢狀執行時樹，約 196 包）
```

執行時樹解析順序：`PI_WEB_DSH_RUNTIME`（顯式指定）→ 本包 node_modules →
`execPath` 鄰近 node_modules → `npm root -g`。三種佈局（本包全量安裝 / fnm / 全域性）
都能命中；解析失敗時服務啟動會報錯並給出提示。診斷：`PI_WEB_DSH_DEBUG=1` 把
執行時 RPC 幀與生命週期事件打到 stderr。

### DSH 環境變數速覽

| 變數                                | 預設              | 作用                                                                            |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `PI_WEB_ENGINE`                     | `pi`              | 引擎：`pi` / `dsh` / `claude` / `codex` / `durable`（啟動預設值，介面可熱切換） |
| `PI_WEB_DSH_RUNTIME`                | 自動解析          | 執行時樹根（node_modules 根，含 `@deepseek-ai/dsh-base`）                       |
| `PI_WEB_DSH_DATA_DIR`               | `PI_WEB_DATA_DIR` | DSH 專用資料目錄（使用者 patch 層 `<dir>/dsh-patches/*.yml`）                   |
| `PI_WEB_DSH_PATCH_DIR`              | 空                | 使用者 patch 目錄顯式覆蓋（優先順序高於推導）                                   |
| `PI_WEB_DSH_QUESTION_TIMEOUT_MS`    | `600000`          | 模型 ask_user_question 提問橋超時（前端倒計時）                                 |
| `PI_WEB_DSH_SESSION_RETENTION_DAYS` | `90`              | 會話 JSONL 保留天數（0 = 關閉清理）                                             |
| `PI_WEB_DSH_DEBUG`                  | 空                | `1` 時輸出執行時診斷到 stderr                                                   |

完整列表見 `docs/env-vars.md`。

### 使用者補丁層（dsh-patches）

DSH 引擎在官方配置之上疊加兩層 patch：內建 `override.patch.yml` + 使用者層。使用者把
`*.yml`（cordis patch 語法，與官方 `cordis.patch.yml` 同構）放進
`<dataDir>/dsh-patches/`（或 `PI_WEB_DSH_PATCH_DIR` 指定目錄），launcher 按檔名序
在 override 之後載入；設定面板「介面外掛」頁籤可檢視列表並重掃（重掃會重啟執行時）。

### 服務安裝（systemd / launchd）加引擎

`pi-web-ui server install` 會把 `--engine` / `--host` / `--agent-dir` 一併烘焙進服務配置：

```bash
pi-web-ui server install --engine dsh --port 9000 --cwd /path
```

Linux 的 `server install` 會把呼叫者環境中的 `PI_WEB_TOKEN` 一併寫入 systemd unit。
埠為 1–1023（例如 80/443）時，自動新增以下配置，讓服務以原使用者執行而無需 root：

```ini
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE
```

預設埠 8787 等非特權埠不會增加 capability。安裝器在提權前生成配置，隨後僅對安裝檔案
及 `systemctl` 操作使用 sudo，因此不會因 sudo 清理環境而丟失埠、host、token、PATH 或使用者工作目錄。
示例（在普通使用者的 Bash 中執行，無需在整條命令前加 sudo）：

```bash
read -rsp 'PI_WEB_TOKEN: ' PI_WEB_TOKEN; echo
export PI_WEB_TOKEN
PI_WEB_HOST=0.0.0.0 PI_WEB_PORT=80 pi-web-ui server install --cwd "$HOME/projects/pi-web-cwd"
unset PI_WEB_TOKEN
```

unit 以 root 所有、0600 許可權安裝；配置通過 stdin 交給安裝命令，token 不進入命令列引數。
重新安裝會 daemon-reload 並重啟服務，使修改後的配置立即生效（會中斷當前連線）。
每次重新安裝都應再次提供 `PI_WEB_TOKEN`；未提供時生成的 unit 不含該變數，顯式空值則清除鑑權口令。
`--print` 仍不安裝、不提權，但會列印包含 token 的完整 unit，請勿公開其輸出。
環境變數不是秘密儲存：systemd 的管理介面及服務程序仍可能暴露環境，不要僅依賴檔案許可權保護憑據。
監聽 `0.0.0.0` 前請確認網路訪問範圍；公網部署應使用 TLS 反代，HTTP 本身不加密口令。

DSH 專屬執行時變數（`PI_WEB_DSH_RUNTIME` 等）仍需手動加入服務配置。
`PI_WEB_TOKEN` 沒有命令列 flag；非 Linux 平臺仍需手動編輯服務配置：

```ini
# systemd: /etc/systemd/system/pi-web-ui.service 的 [Service] 段
Environment=PI_WEB_DSH_RUNTIME=/usr/local/lib/node_modules
Environment=PI_WEB_DSH_DATA_DIR=/var/lib/pi-web-ui
Environment=PI_WEB_TOKEN=s3cret
# reload: sudo systemctl daemon-reload && sudo systemctl restart pi-web-ui
```

```xml
<!-- launchd: ~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist 的 dict 內 -->
<key>EnvironmentVariables</key>
<dict>
    <key>PI_WEB_DSH_RUNTIME</key><string>/usr/local/lib/node_modules</string>
    <key>PI_WEB_TOKEN</key><string>s3cret</string>
</dict>
<!-- reload: launchctl bootout gui/$(id -u)/com.xingshuyin.pi-web-ui && \
            launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.xingshuyin.pi-web-ui.plist -->
```

注意：launchd/systemd 執行環境極簡（無 PATH/無 locale），全域性 `dsh` 若裝在使用者目錄
（如 `~/.local`），請用 `PI_WEB_DSH_RUNTIME` 顯式指定，否則解析不到。

## 子路徑反代（nginx 掛在 /pi/ 等路徑下）

頁面掛在 `https://example.com/pi/` 而非根路徑時，nginx 需要**剝離字首**轉發。
瀏覽器側會自動從頁面 baseURI 推導應用根（/pi/），外掛 bundle、WebSocket（`/pi/ws`）、
`/api`、`/themes` 全部請求都會帶上 `/pi/` 字首。

```nginx
# 配合 WebSocket 升級對映（建議寫在 http {} 塊中）：
# map $http_upgrade $connection_upgrade {
#     default upgrade;
#     ''      close;
# }

server {
    listen 80;
    server_name example.com;

    # 子路徑 WebSocket：前端在 /pi/ 基礎路徑下連線 /pi/ws，剝離字首轉發到 /ws
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

    # 關鍵是 proxy_pass 末尾的 /：剝離 /pi 字首後透傳給後端（8787 為預設埠）
    location /pi/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        # WebSocket 升級頭必須透傳
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        # 必須用 $http_host 保留埠（服務端的 Origin 校驗包含主機名與埠，$host 會丟掉埠導致 403）
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

注意：

- **`Host` 必須使用 `$http_host`**（保留原始埠）——後端的 Origin 校驗要求 hostname 與埠完全一致，若使用 `$host` 會丟棄非標準埠引發 403。
- **長連線超時**：WebSocket 需要顯式宣告 `proxy_read_timeout 3600s;`，避免終端或長時間 AI 回答因 nginx 預設 60s 超時而意外斷連。
- 官方 dist 的靜態資源是根絕對路徑（`/assets/...`），與 JS 裡的應用根推導無關。
  要讓 HTML 在 /pi/ 下渲染，二選一：① 另加一條 `location /assets/ { proxy_pass
http://127.0.0.1:8787; }` 轉發靜態資源；② 用 `vite build --base=/pi/` 重新構建
  （產物裡 assets 引用與 `import.meta.env.BASE_URL` 均為 /pi/，與 baseURI 推導
  結果一致，兩種方式可混用）。
- 外掛目錄（`<dataDir>/plugins/`）不需要在 nginx 單獨配置——客戶端請求
  `/pi/plugins/...`，剝離字首後由後端標準路由處理。完整示例見 `deploy/nginx-subpath.conf`。
