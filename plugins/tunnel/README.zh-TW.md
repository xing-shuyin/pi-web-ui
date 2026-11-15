[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 🔗 tunnel —— pi-web-ui 網路隧道外掛

反向隧道：你的其他裝置（筆記本/桌上型電腦/手機終端）**主動連入** pi-web-ui 所在機器，
AI 由此以「裝置所在網路」為出口做網路巡檢與訪問——**零公網暴露、天然穿 NAT**，
DNS 在出口裝置側解析，測得即該裝置所在網路的真實結果。

並可將裝置接成**指揮節點**：AI 經控制通道在裝置上執行 pi agent（`/device/task`），
裝置 agent 以 `Remote<駝峰主機名>` 身份接入 pi_messenger，任意會話 `send` 直達（mesh 橋）。

## 更新日誌

### 1.4.0（2026-10-24）P3b 打磨

- mesh 投遞按目標路由：訊息經 inbox 目錄（裝置 agent 名）→ registry 反查裝置 aid（p3a 版本錯誤地投給 activeAgent，多裝置必投錯）
- 裝置端會話快照/重置：CLI `/session`（GET，只讀）+ `/session/reset`（POST）；server `GET /mesh/session`、`POST /mesh/reset`；面板 Mesh 卡「會話/重置」按鈕
- README 重寫至當前能力面；裝置 CLI p14

### 1.3.0（2026-10-24）Phase 3a：pi_messenger mesh 橋

- 裝置 agent 接入 pi_messenger：純檔案橋（registry/inbox/離線補發/滯留佇列），pi-messenger 零改動
- 裝置端持久會話：`--session <uuid>` 跨訊息記憶（`--resume` 必彈 TUI 選擇器，實錘棄用）
- TDZ 競態根治：`meshEnabled` 改 function 宣告（const 箭頭被非同步鉤子在啟動讓出期觸發致 activate failed）
- 上線補發限 5 條、10min 超時回寫、面板 Mesh 卡

### 1.2.0（2026-10-23）Phase 2：模型通道三級解析

- 修復正則誤抓非會話模型 + 標準 OpenAI 相容 provider 的 key 不注入
- `resolveModelEnv(model?)`：override → manual（storage.modelEnv）→ auto（會話 models.json + provider-keys.json）
- 裝置端動態 models.json 注入 `providers.tunnel`；面板「模型通道」卡 + `GET/POST/clear /modelenv`
- 新增 `POST /device/task`：裝置端 pi agent 裸執行（-p --mode json），控制通道端到端打通（Phase 1）

### 1.1.1（2026-10-22）

斷線自愈三層修復（實戰連環排查）：

- 服務端 isAlive 心跳單 miss 誤殺 → 連續 3 miss（≈90s）寬限
- ver 握手 p7≠p8 阻塞自更新 → 服務端下發與 CLI 版本號同步改
- 同名裝置「能力相同拒新連線」→ 新連線必勝（twin 接管，雙程序互踢收斂）
- CLI 重連 connect 無響應掛死（SYN 黑洞）→ 10s 兕底廢棄重來（已實戰驗證）

### 1.1.0（2026-10-20）

- 心跳保活 + 殭屍連線判定強制重連；連線/斷開日誌帶時間戳
- spawn 替代 execFile（路徑含空格）；雙 label 解除安裝與配置熱更

## 工作原理

```
[pi-web-ui 內的 AI] --SOCKS5(127.0.0.1:<socksPort>)--> [tunnel 外掛] --WebSocket--> [你的裝置: cli] --> 目標
```

- 裝置側 CLI 為單檔案 Node 指令碼（≥22），**主動出站**連宿主，無需公網 IP / 埠對映
- 多裝置共存：所有線上裝置互不干擾，SOCKS 流量走「當前出口裝置」；出口掉線**自動切換**
- 服務端隨宿主程序常駐（launchd/服務託管），面板可隨時啟停

## 功能

- **面板**（獨立檢視 tab）：隧道狀態三態燈、出口裝置列表（線上狀態/系統/一鍵切換）、
  服務啟停、接入令牌檢視與重置、三平臺（macOS/Windows/Linux）常駐安裝命令一鍵複製
- **AI 工具 `tunnel_fetch`**：經隧道發 HTTP 請求（資料面在出口裝置網路執行），
  對話裡直接說「用隧道看下我的出口 IP」即可
- **CLI 一鍵分發**：面板下載已注入令牌的 CLI；裝置接入後出現在裝置列表
- **多平臺常駐化**：macOS(launchd) / Windows(schtasks) / Linux(systemd --user) 安裝命令
  按 OS 頁籤展示，裝一次開機自啟 + 掉線自愈
- **通知**：裝置連入/斷開、出口切換、令牌重置經 `host.notify` 推送

## 安裝

面板「外掛」→ 安裝 → 填入本倉庫外掛目錄：

```
xing-shuyin/pi-web-ui/tree/main/plugins/tunnel
```

或 CLI：`pi-web-ui install xing-shuyin/pi-web-ui/tree/main/plugins/tunnel`

## 裝置接入

1. 面板「裝置常駐化」選你的系統頁籤，複製命令到該裝置終端執行
   （或先「下載 CLI」再手動執行：`node pi-tunnel-cli.mjs`）
2. 裝置出現在「出口裝置」列表後，即可被 AI 使用；多臺裝置可點「設為出口」切換

## AI 側用法

```
tunnel_fetch {url: "http://myip.ipip.net"}          # 查出口裝置網路的真實出口 IP
tunnel_fetch {url: "http://192.168.x.1/", timeout: 5}  # 探測出口裝置所在內網的閘道器
```

**裝置指揮（控制通道，REST 均帶 ?token=PI_WEB_TOKEN）**：

```
POST /plugins-api/tunnel/device/task  {id, prompt, tools:"read,grep", timeoutS:600}   # 裝置端 pi 裸執行
GET  /plugins-api/tunnel/status        # 裝置列表與 aid（id 會話級遞增，必須動態取）
POST /plugins-api/tunnel/device/hw    {id}                                            # 硬體概覽
```

**mesh 橋**（面板開啟後）：`pi_messenger send to=RemoteWDLMacBookPro "…"`——
裝置端 pi 以持久會話應答，回覆自動回到發起方 inbox 並 wake 注入會話；
`GET /mesh/session` 查快照、`POST /mesh/reset` 重置記憶。

## 安全與鑑權模型

- **SOCKS5 出口**：僅監聽 `127.0.0.1`，宿主本機之外的外部程序不可訪問。
- **WS 隧道接入鑑權**：WS 隧道（`:wsPort`）端點（`/agent`、`/cli`、`/status`）強制要求隧道自身令牌（`?token=`，基於 SHA-256 的常時時間比較防時序側通道）。
- **面板路由與令牌防洩露**：面板路由（`/plugins-api/tunnel/*`）受宿主鑑權（`PI_WEB_TOKEN`）保護。當宿主未設定 `PI_WEB_TOKEN` 時，`/status` 下發的隧道令牌會自動脫敏（防止 frp 等反代公網暴露未設宿主口令時憑證全鏈路裸奔）。
- **連線與指令隔離**：SOCKS 資料傳輸、控制指令（`ctrl-resp` 使用高熵隨機 UUID）、Mesh 非同步回包均強制繫結目標裝置 `aid`，阻斷多裝置環境下的跨裝置偽造、搶答或 SOCKS 劫持。
- **能力模型與任務硬閘門**：遠端任務通道（`/device/task`）與檔案讀寫均受裝置能力（`fsRead`、`fsWrite`）在面板、服務端與 CLI 三層硬閘門約束。當裝置 `fsWrite=false` 時，嚴禁下發任何寫/執行類工具（`bash,edit,write`）；`/fs/browse` 目錄瀏覽限定在使用者主目錄或掛載儲存卷，禁止列舉系統敏感根目錄。
- **傳輸安全與憑據落地風險（重要）**：
  - 隧道預設鏈路為明文（`ws://` 與 `http://`）。若通過公網連線，**強烈建議前置 HTTPS / WSS 反向代理**（如 Nginx、Caddy 或開啟 TLS 的 FRP），或使用 WireGuard VPN 專網。
  - 裝置端執行任務所需的模型憑據在派發時臨時下發至對端，以 `0600` 許可權儲存於 `~/.pi-tunnel-agent/models.json`；面板下發裝置自解除安裝時自動徹底清除。
- **生命週期安全閉環**：停止隧道或重置令牌（`/rotate`）時主動終止所有存量裝置連線，並關閉 Mesh 橋回收系統檔案監聽控制代碼與定時器。

## 設定

| 鍵        | 預設 | 說明                            |
| --------- | ---- | ------------------------------- |
| wsPort    | 8765 | WS 隧道埠（全網絡卡，裝置連入） |
| socksPort | 1080 | SOCKS5 埠（僅 127.0.0.1）       |

## 開發

- 原始碼結構：`manifest.json` + `index.mjs`（服務端，全內聯）+ `client/entry.mjs`（面板）
  - `assets/cli.mjs`（裝置側 CLI 模板，`/cli` 下載時注入令牌與地址）+ `client/sdk/`（SDK 複製）
- 服務端改動後需 `cp` 至部署位並 `launchctl kickstart -k gui/501/com.xingshuyin.pi-web-ui` 重啟宿主
  （瀏覽器重新整理只更新面板，不過載服務端）
- 版本鐵律：`index.mjs` 的 `CLI_VER_PUBLISH` 與 `assets/cli.mjs` 的 `CLI_VER` 必須同步改（漏改致 p11/p12 兩輪推送卡死）
