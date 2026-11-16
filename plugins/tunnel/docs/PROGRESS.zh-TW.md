[English](./PROGRESS.en.md) · [简体中文](./PROGRESS.md) · **繁體中文**

# pi-tunnel 階段進展文件

> 更新：2026-10-24 11:00 · 狀態：Phase 1 ✅ / Phase 2 ✅（v1.2.0）/ Phase 3a ✅（v1.3.0）/ **Phase 3b ✅ 驗收全過（v1.4.0+CLI p15）；裝置端 launchd 78 修復待主人跑 xattr**
> 本文件是跨會話續命的真相源：新會話接手先讀這裡。

## 架構速覽

- **mini**（172.16.120.11，執行 pi-web-ui）＝隧道 server；**筆記本 WDLMacBook-Pro.local**（使用者 gxg）＝出口裝置，經反向 WS 連入
- 源倉 `~/projects/pi-web-ui-upstream/plugins/tunnel/`（源倉有 auto 落倉守護，改動會被自動 commit，無需手動 git）
- 部署位 `~/.pi-web/plugins/tunnel/`（改完源倉必須 cp 過去，檔案層級：index.mjs 根 / assets/cli.mjs / client/entry.mjs）
- 備份：`~/WorkSpace/pdd-backup/tunnel-plugin-pre-*`（歷次部署前全量）
- 路由規範：REST 掛 `/plugins-api/tunnel/`（`?token=` 鑑權）；WS 8765；SOCKS5 1080（僅 127.0.0.1）
- token 來源：`~/.pi/secrets/com.xingshuyin.pi-web-ui.env` 的 `PI_WEB_TOKEN`

## 已交付

### Phase 1（SSH→SOCKS→控制通道閉環）✅

- SSH 方案廢棄（筆記本 22 靜默 drop，遠端登入未開）；走 WS 控制通道
- `POST /plugins-api/tunnel/device/task` → 筆記本 pi agent 端到端 PONG ✅（模型通道 wildwork/glm-5.3，LAN baseUrl `http://172.16.120.11:7863/v1`）

### Phase 2（v1.2.0，模型通道三級解析）✅

- 修復：①正則誤抓非會話模型（原 client-state.json 第一個 provider ≠ 會話）②標準 OpenAI 相容 provider 的 key 不注入
- `resolveModelEnv(model?)` 三級：override（面板任務帶 model）→ manual（storage.modelEnv 手動三元組）→ auto（會話 models.json + provider-keys.json）
- 面板新增"模型通道"卡（讀取/手動指定/恢復自動）；REST `/modelenv`（GET/POST/clear）
- 裝置端動態 models.json：`providers.tunnel` 注入 → `--model tunnel/<id>`（anthropic-messages 型 provider 裝置端不支援，只走 openai-completions）
- 日誌加 `src=auto/override/manual` 便於排障

### Phase 3a（pi_messenger 檔案橋）— 程式碼全部完成，驗收進行中

設計全文：[PHASE3-MESH-DESIGN.md](./PHASE3-MESH-DESIGN.zh-TW.md)（含即時性三層次分析）

已改動（源倉已同步部署位，v 提到 p10）：

1. `assets/cli.mjs`（p10）：`/task` 支援 `mesh/msgId/from` → 持久會話（`~/.pi-tunnel-agent/session.json` 記 sessionId，`--resume` 續聊）→ 完成後 WS 上行 `{t:'msg-res',msgId,to,ok,text,ms,err}`（text 取最後 message_end 的 assistant content）
2. `index.mjs`：mesh 橋模組（MESH_DIR=`~/.pi/agent/messenger`）——`meshAgentName()` 駝峰（WDLMacBook-Pro.local→RemoteWDLMacBookPro）、registry 讀寫（online/offline 自定義欄位 `offline:true`）、inbox watch（只消費裝置 agent 自己的 `<name>/*.json` 防環）、序列投遞（deviceCtrl /task，mesh 用三級解析預設通道，tools=read,grep，10min 超時）、上線補發（限 5 條，更舊回寫 skipped）、GET/POST `/mesh`（storage `meshEnabled` 開關）；WS `msg-res` case 寫發起方 inbox（wake 靠 pi-messenger watcher，**pi-messenger 零改動**）
3. `client/entry.mjs`：Mesh 橋卡（開關+狀態+佇列）
4. 踩坑修復：startTunnel 裡直接調 `meshEnabled()` 是 TDZ（const 箭頭函式在啟動路徑之後才定義）→ 改 setTimeout(0) 延遲到 activate 完成後；activate failed 已消除
5. 備份：`~/WorkSpace/pdd-backup/tunnel-plugin-pre-p3a-20261024-081351/`

## 驗收結果（2026-10-24 全部通過，v1.3.0）

| 驗收項                                                                 | 結果                            |
| ---------------------------------------------------------------------- | ------------------------------- |
| 服務啟用無錯（TDZ 根治後 activate failed=0）                           | ✅                              |
| registry 自動註冊 RemoteWDLMacBookPro + 裝置 CLI p12                   | ✅                              |
| mesh 端到端首條（PONG 回到發起方 inbox + wake）                        | ✅                              |
| `--session` 持久會話跨訊息記憶（裝置答"第 2 條，第 1 條是 mesh 驗收"） | ✅                              |
| TDZ 期滯留訊息補發（3 條 .done）                                       | ✅                              |
| launchd KeepAlive 自愈（程序死自動拉起）                               | ✅ **主人實測蓋屏重開自動回連** |

### "老要重跑"終審定論（2026-10-24）

1. ~~server 側 TDZ~~（已根治）：meshEnabled const TDZ 競態 → activate failed → WS 端點消失
2. **主因=Mac 睡眠**：電池模式自動睡眠 → 程序凍結 → WS 斷（物理規律非故障）；開蓋後 launchd KeepAlive 拉起回連——**主人實測蓋屏重開自動回連，自愈鏈完整**
3. 歷次"重跑"實為：喚醒後未等 5-10s 自愈就手動重跑（persistCmd 冪等，無害但沒必要）

- 裝置端 plist 已遠端讀取驗真：`KeepAlive=true` + `RunAtLoad=true` + 路徑全部正確展開（/Users/gxg/.local/bin/node）
- persistCmd 日誌路徑已改 `~/pi-tunnel-cli.log`（白名單內可遠端讀；裝置端現有 plist 仍是 /tmp 舊值，下次主人重新整理面板重跑時才換新）

### resume 誤診更正（p11→p12）

p11 註釋"`-n` 汙染 resume"是**誤診**：實際 args 是 `-ne`（no-extensions），`indexOf('-n')` 根本匹配不到；pi 原始碼實錘 `--resume` 無論組合什麼 flag 都必彈 TUI 選擇器。p12 改用 `--session <uuid>`（exact-id 本地匹配直接 open，零互動）——實測跨訊息記憶通過。

### 收尾狀態

- manifest 1.3.0 + CHANGELOG 1.3.0 條目已落；git auto 落倉靜候守護
- 遺留：面板 /device/task 無執行命令通道（special:"full" 欄位不存在，b9 摘要記錯）；deviceCtrl 裝置 id 為會話級遞增（a1→a2…），呼叫方須從 GET /status 動態取，硬編碼必撞 503

## Phase 3b（v1.4.0，2026-10-24）——打磨 + 多裝置路由修復

### 已落改動（源倉=部署位，備份 pdd-backup/tunnel-plugin-pre-p3b-20261024-095829）

1. **mesh 投遞按目標路由**：p3a 把所有訊息投給 activeAgent()（單裝置僥倖正確，多裝置必投錯）；現按 inbox 目錄（目標裝置 agent 名）→ registry.device 反查 aid 定向投遞，目標離線滯留等補發。`meshEnqueueFile(fp, nm)` 簽名變更，registry 裝置名欄位為 `device`（非 deviceName）
2. **裝置端會話管理（CLI p14）**：`GET /session` 快照（sessionId/updatedAt/size）+ `POST /session/reset`（刪 session.json）；server 側 `GET /mesh/session`、`POST /mesh/reset`（支援 ?agent= 指定，審計 mesh.sessionReset）；面板 Mesh 卡「會話/重置會話」按鈕
3. **README.md 重寫**：架構圖/能力矩陣/三級解析/排障表/mesh 用法，更新日誌補齊 1.2.0/1.3.0/1.4.0；CHANGELOG 重排（1.4.0→1.3.0→1.2.0→1.1.1）

### P3b 驗收（20261024 全部通過）

- [x] 裝置上線 p15（persistCmd 強刷 + 手動前臺跑驗證 CLI 本體正常）
- [x] GET /mesh/session 快照（exists/sessionId/updatedAt/size）
- [x] POST /mesh/reset 返回 removed=舊 sessionId，複查 exists:false
- [x] reset 後 mesh 首條 → 裝置回「PONG-p3b · 新會話已建立」→ 回覆到達 WildIce inbox
- [x] 單裝置路由迴歸：與 p3a 行為一致

### P3b 期事故與定論

1. **“裝置死迴圈”誤判**：日誌 9 次「mesh 橋已啟動」實為 pi-web-ui 每次重啟各打一條，非裝置重連——取證先分清日誌是哪一端的
2. **connect 廢棄卡死（CLI p15 修復）**：undici WebSocket 在 CONNECTING 態調 close() 不觸發 onclose，connectGuard 廢棄後重連鏈死亡（裝置 18min 無動作實錘）。修復：廢棄後 3s 複檢 readyState 仍 0 → exit(0) 由 launchd 重拉
3. **launchd 78 EX_CONFIG 定論（%h 佔位符）**：persistCmd 模板 plist `StandardOutPath=%h/pi-tunnel-cli.log`，launchd 不展開 %h → 日誌檔案建立失敗 → spawn 即 78（"手動能跑、launchd 拉不起"）。修復=模板改 `$HOME`（已部署）；裝置端主人 sed 改絕對路徑後 11:00:54 常駐上線。取證教訓：launchctl print 的 last exit code 是啟動層退出碼，先查 plist 路徑展開再查二進位制；quarantine/provenance 是紅鯡魚

## 關鍵陷阱備忘

- `cp $S/assets/cli.mjs $D/` 會丟 assets 層級（檔案落部署位根目錄）——必須 `cp ... $D/assets/cli.mjs` 且 diff 驗證
- kickstart 重啟服務會中斷正在執行的 bash 工具呼叫（合成結果提示"可能已執行"）——重啟命令單獨發
- `meshEnabled()` **必須**用 function 宣告（帶提升）：hello/離線鉤子可在 startTunnel await 讓出期觸發（const 箭頭 TDZ 競態已兩次致 activate failed，20261024 根治）
- pi CLI：`--resume`（無值形式）必彈 TUI 選擇器，與任何 flag 組合無關；跨程序續會話用 `--session <uuid>`（p12 實錘）
- deviceCtrl 裝置 id 會話級遞增（`a${nextAid++}`），裝置程序重啟後換號——呼叫方從 GET /status 動態取，硬編碼必 503
- CLI 自更新會主動退出程序——裝置端 launchd KeepAlive 已實錘自動拉起（主人蓋屏→開蓋實測回連）
- /device/fs browse 只返回 dirs 不返回檔案；讀檔案用 POST /device/fsread（返回 b64）
- 環節檔案：裝置端 cfg `~/.pi-tunnel-cli.json`；會話 `~/.pi-tunnel-agent/`；CLI 程序由裝置 launchd 常駐
- token 環境變數在 `~/.pi/secrets/com.xingshuyin.pi-web-ui.env`（32 字元）
