[English](./CHANGELOG.en.md) · [简体中文](./CHANGELOG.md) · **繁體中文**

# pi-tunnel CHANGELOG

## 1.5.0（2026-10-24）安全修復：wsPort 鑑權 + 裝置安裝鏈路修正

### wsPort 鑑權（上游 60daa53d 移植）

- **security(/cli /status /pi-pkg)**：WS 匯聚口（:8765 全網絡卡）此前無鑑權——任意同網可達主機可下載內嵌完整 token 的 CLI 原始碼（冒充裝置/踢掉真裝置/劫持 SOCKS 出口）、讀裝置拓撲、拉 agent 離線包。三端點統一 `?token=` 校驗（`tnlAuthed`，失配 401）。宿主 route 通道（/plugins-api/tunnel/*）由面板自身鑑權體系保護，不變更。
- **feat(snapshot)**：statusSnapshot 增發完整 `token`（僅授信面板可得），面板用它拼裝置安裝命令。

### 裝置安裝鏈路修正（配合鑑權）

- **fix(persistCmd)**：三平臺 curl 下載 /cli、/pi-pkg 補 `?token=`（否則升級後設備裝不上）。
- **fix(/pi-pkg wsPort 缺失)**：persistCmd 從 wsPort 下載 pi-agent.tgz，但 wsPort handler 只有 /cli /status——裝置會下到純文本、tar 解包必失敗。wsPort 補 /pi-pkg 分支（同款鑑權，流式回 404）。

### 部署注意（破壞性變更）

- 升級到 1.5.0 後，舊版 persistCmd（無 token）復跑會 401；新命令從面板「網路隧道」頁複製即可。

## 1.4.0（2026-10-24）P3b 打磨

### persistCmd 模板修復（launchd %h 實錘）

- **fix(persistCmd)**：macOS plist `StandardOutPath` 的 `%h/pi-tunnel-cli.log` launchd 不展開佔位符 → 日誌檔案建立失敗 → spawn 即 `78 EX_CONFIG`（裝置反覆"手動能跑、launchd 拉不起"的最終根因）。改 `$HOME/pi-tunnel-cli.log`（heredoc 展開為絕對路徑）；Linux systemd 的 %h 合法保留

### 裝置端 CLI p15（connect 廢棄卡死修復）

- **fix(connectGuard)**：undici WebSocket 在 CONNECTING 態調 close() 不觸發 onclose，廢棄後重連鏈死亡（裝置 18min 無動作實錘）。廢棄後 3s 複檢 readyState 仍 0 → exit(0) 由 launchd KeepAlive 重拉（程序級重啟是唯一可靠復位）

### 多裝置路由修復

- **fix(mesh 投遞路由)**：p3a 版本把所有訊息投給 `activeAgent()`（單裝置僥倖正確，多裝置必投錯）。現按訊息所在 inbox 目錄（目標裝置 agent 名）→ registry `device` 欄位反查裝置 aid 定向投遞；目標離線則滯留等上線補發（`meshEnqueueFile` 簽名加 `nm`）

### 裝置端會話管理

- **feat(CLI p14)**：`GET /session`（快照：sessionId/updatedAt/size，只讀）+ `POST /session/reset`（刪 `~/.pi-tunnel-agent/session.json`，下條訊息開新會話）
- **feat(server)**：`GET /mesh/session`、`POST /mesh/reset`（均支援 `?agent=`/`agentName` 指定裝置，預設活躍裝置；審計 `mesh.sessionReset`）
- **feat(面板)**：Mesh 卡新增「會話」（快照彈窗）+「重置會話」（confirm 後調 reset）按鈕

### 文件

- README 重寫至當前能力面（架構圖/能力矩陣/三級解析/排障表/mesh 用法），更新日誌補 1.2.0/1.3.0/1.4.0

## 1.3.0（2026-10-24）Phase 3a：pi_messenger mesh 橋

### 新增

- **mesh 橋**：裝置 agent 以 `Remote<駝峰主機名>` 接入 pi_messenger——純檔案橋（registry/inbox watch/離線補發限 5 條/滯留佇列），pi-messenger 零改動；`GET/POST /mesh` 開關 + 面板 Mesh 卡
- **裝置端持久會話**：`--session <uuid>` 跨訊息記憶（CLI p12→p14）；上行 `{t:'msg-res'}` 回發起方 inbox + wake

### 修復（附根因）

- **mesh resume**：`--resume` 無論組合什麼 flag 必彈 TUI 會話選擇器（pi dist/cli/args.js + main.js 原始碼實錘），p11 誤診為 `-n` 汙染；改 `--session <uuid>`（exact-id 本地匹配直接 open 零互動），跨訊息記憶實測通過
- **TDZ 競態**：`meshEnabled` 由 const 箭頭改 function 宣告——hello/離線鉤子可在 startTunnel await 讓出期觸發，先後兩次致 activate failed（"時好時壞"真兇）
- **ver 下發同步**：握手 `t:"ver"` 硬編碼與 assets/cli.mjs CLI_VER 兩輪漏改（p11/p12 卡推送）；改 `CLI_VER_PUBLISH` 常量

### 定論

- **launchd KeepAlive 自愈實錘**（1.3.0 期內驗證）：主人蓋屏→開蓋→自動回連；裝置端 plist `KeepAlive=true` 遠端讀取驗真。"老要重跑"主因=Mac 睡眠（物理規律非故障），喚醒後 5-10s 自愈無需重跑

## 1.2.0（2026-10-24）

### 模型通道重寫（修復 Phase 1 暴露的兩缺陷）

- **fix(resolveModelEnv)**：廢除「正則掃 client-state.json 全文取第一個 `provider/model`」的偽實現——它命中的是 `projectModels` 裡任意專案條目（如 WorkSpace 的 ark 模型），並非當前會話模型；且 client-state 無可靠的"當前模型"欄位，該路徑不可修，直接移除。
- **fix(標準 provider 不注 key)**：舊版標準 provider 返回 `{env:{}}` 只傳模型 ID，裝置端 pi 無憑據直接報 `No API key found`；新版統一注入 `OPENAI_BASE_URL` + `OPENAI_API_KEY`。
- **feat(三級解析)**：新 `resolveModelEnv(wantModel)` 語義改為「為裝置任務挑一條可用模型通道」：
  1. 請求級 override：`POST /device/task` 帶 `model="provider/model[/…]"` 精確解析該 provider；
  2. 面板手動 modelEnv（storage 三元組）；
  3. 自動列舉 `models.json` providers ∩ `provider-keys.json`，僅 openai-completions 型；內網閘道器 baseUrl（127.0.0.1/localhost）自動換算 `lanIp` 並優先排序（裝置同網段直連，流量不出公網）。
- **feat(REST)**：`GET /modelenv`（manual/resolved/candidates，key 只回尾部 4 位）、`POST /modelenv`（儲存手動三元組 / `{clear:true}` 恢復自動）。
- **feat(面板)**：「網路隧道」頁新增**模型通道**卡：生效狀態（來源/模型/key 尾部）、手動三元組編輯（key 不回填）、恢復自動、自動候選展示。
- **邊界**：anthropic-messages 型 provider（minimax-cn/ark-anthropic）裝置端暫不支援注入（裝置 CLI 的 `/task` 僅對 `OPENAI_*` 回寫裝置側 models.json），選中時返回明確錯誤；後續版本評估。
- 日誌：`[tunnel] task → …` 增加 `src=` 欄位（override/manual/auto）便於排障。

## 1.1.1 及更早

見 `git log -- plugins/tunnel/`。
