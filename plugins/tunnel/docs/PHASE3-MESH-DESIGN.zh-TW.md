[English](./PHASE3-MESH-DESIGN.en.md) · [简体中文](./PHASE3-MESH-DESIGN.md) · **繁體中文**

# pi-tunnel Phase 3 設計：pi_messenger 真 mesh 接入

> 狀態：**設計稿待拍板**（先設計後動工，2026-10-24）
> 前置：Phase 1（/device/task 零程式碼通路）✅、Phase 2（v1.2.0 模型通道三級解析）✅

---

## 1. 目標與現狀差距

**目標**：筆記本上的 pi agent 成為 mini 側 pi_messenger mesh 的正式成員——可被 `@`、可收 DM、有持久記憶、有 presence，而不是現在 `/device/task` 式的一次性無記憶執行器。

**現狀差距**（Phase 2 之後）：

| 能力     | Phase 2 現狀                     | mesh 要求                                      |
| -------- | -------------------------------- | ---------------------------------------------- |
| 觸達     | 面板/REST 手動 POST /device/task | mini 任意 pi 會話 `pi_messenger send` 直接可達 |
| 記憶     | `--no-session`，每次裸程序       | 持久 session，`--resume` 續聊                  |
| presence | devices 列表（面板私有）         | registry 條目，`list` 可見、狀態可查           |
| 回覆     | HTTP 響應同步返回                | 非同步投回發起方 inbox + 自動 wake             |

## 2. 核心洞察（方案成立的依據）

pi_messenger 是**純檔案 mesh，無 daemon**（README "How It Works"）：

- 登錄檔：`~/.pi/agent/messenger/registry/<Name>.json`（name/pid/sessionId/model/activity…）
- 訊息：`inbox/<收件名>/<ts>-<rand>.json`，格式 `{id, from, to, text, timestamp, replyTo}`
- wake：每個 pi 會話內的 pi-messenger 擴充套件 **fs.watch 自己的 inbox**（50ms debounce）→ `pi.sendMessage(deliverAs:"steer", triggerTurn:true)` 立即喚醒

**推論**：只要 mini 側有一個「橋」替裝置 agent 讀寫這兩個目錄，wake 機制**零改造免費獲得**——橋把回覆寫進發起方（mini 上某 pi 會話）的 inbox，發起方的 pi-messenger watcher 自然觸發 steer。

**即時性分析（三層次，20261024 補）**：

1. **通訊鏈路即時**（亞秒級，非輪詢）：send 寫 inbox → 橋 fs.watch（50ms debounce）→ WS ctrl 推送裝置；裝置完成 → WS 上行 → 橋寫回發起方 inbox → 發起方 watcher 50ms 內捕獲 → steer wake。整鏈無輪詢間隔，延遲毫秒級。
2. **裝置端 LLM 執行時間不免**：pi 收任務要思考/調工具（數秒到數分鐘）。mesh 是非同步的——對比 Phase 2 `/device/task` HTTP 同步等完（12~67s），發起方發完訊息即可繼續幹別的，不阻塞。
3. **發起方忙碌時回覆排隊不丟**：pi 的 steer 不打斷進行中的 turn——忙碌時回覆在下個 turn 邊界被消化；發起方已退出則留在 inbox，下次啟動補看。橋交付即忘，inbox 檔案即持久化。

## 3. 架構

```
mini (172.16.120.11)                          筆記本 (172.16.120.118)
┌─────────────────────────────┐   WS(8765)   ┌──────────────────────┐
│ mini pi 會話 A               │              │ tunnel CLI (launchd) │
│  └ pi-messenger 擴充套件         │              │  └ ctrl handler      │
│    ↕ inbox/<A>/ watch       │              │    ↕ spawn           │
│  橋（tunnel 外掛內，隨 server）│  ←ctrl-req── │  pi --resume <sid>   │
│  · watch inbox/<Remote*>/    │  ──msg-res→  │    --mode json       │
│  · 寫/刷 registry 條目        │  (新上行型別) │    持久 sessionId 儲存│
└─────────────────────────────┘              └──────────────────────┘
```

**訊息流（A 向裝置 agent 發 DM）**：

1. A：`pi_messenger {action:"send", to:"RemoteMbp", message:"…"}` → pi-messenger 寫 `inbox/RemoteMbp/…json`
2. 橋 watch 到新訊息 → deviceCtrl(ctrl-req `/task`，帶 `sessionId:resume`、`text`)
3. 裝置 CLI：`pi --resume <sid> -p <text> --mode json` → 流式收集最終 assistant 文本
4. CLI WS 上行 `{type:"msg-res", msgId, from:"RemoteMbp", text, to:<原發起方>, ok}` （**新增訊息型別**，CLI hello 後即可主動上行）
5. 橋收到 → 寫 `inbox/<發起方>/…json`（from=RemoteMbp, replyTo=原 msgId）→ 發起方 pi-messenger 自動 wake ✅
6. 橋更新 registry activity + audit 環

**關鍵點：pi-messenger 原始碼零改動。**

## 4. 改造點清單

| #   | 位置                                 | 改動                                                                                                         | 量級       |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------- |
| 1   | tunnel 外掛 server（源倉 index.mjs） | **mesh 橋模組**：inbox watcher + registry 管理 + msg-res 處理 + WS `msg-up` 上行接收                         | 主要工作量 |
| 2   | 裝置 cli.mjs（CLI_VER→p10）          | `/task` 支援 `sessionId` 模式：`new`→分配並持久化、`resume`→`--resume <sid>`；完成後經 WS 主動上行 `msg-res` | 中         |
| 3   | 面板 entry.mjs                       | 「模型通道」卡旁加「Mesh」卡：開關、裝置 agent 名、最近回覆預覽                                              | 小         |
| 4   | pi-messenger                         | **不動**                                                                                                     | 0          |

## 5. 關鍵設計決策

1. **裝置 agent = 一裝置一持久 agent**（命名 `Remote<裝置名>`，如 `RemoteMbp`）。會話存 `~/.pi-tunnel-agent.json`（sessionId/cwd/model）；面板提供 `重置會話`（新 session）。
2. **橋隨 server 常駐**，registry 條目 `pid` 用 server PID（橋程序）——pi-messenger 的 PID 存活檢查天然通過；**裝置離線由橋反映**：離線時把條目 `activity.lastActivityAt` 凍結並刪 `session` 欄位前加 `offline:true` 自定義欄位（pi-messenger 忽略未知欄位，安全）；上線恢復。
3. **離線積壓**：裝置離線期間 inbox 訊息留存，上線後橋按時間序補發（限最近 5 條，更舊的標 `skipped` 寫回發起方告知）。
4. **多裝置就緒**（P3b 已實現，原 v1 單裝置）：registry/inbox watcher 按裝置名引數化；meshDrain 按 inbox 目標反查裝置 aid 路由（不再是 activeAgent 兼單裝置）。新增裝置只需面板常駐命令接入，橋零改動
5. **模型通道**：裝置 pi 會話複用 v1.2.0 的三級解析（resolveModelEnv），會話啟動時解析一次並寫入裝置側 models.json（已有機制）。
6. **安全門禁**（mesh 通道比 /device/task 更易被 agent 自發觸發，必須設防）：
   - 開關預設關：storage `devcfg.meshEnabled:false`，面板 Mesh 卡開啟（主人手動）
   - 裝置端 tools 白名單維持 v1 策略（預設 `read,grep`，寫操作需面板提權——已有 fsWrite 治理）
   - 橋 audit：每條轉發進出均入審計環
   - **防環**：裝置 agent 不是 mini mesh 成員（它不跑 pi-messenger），回覆單向落地發起方 inbox；橋拒絕處理 `from=Remote*` 的訊息（裝置訊息不會回到裝置）
7. **steering 注入邊界**：發起方 pi 空閒時 steer 即新 turn；忙時排隊（pi 內建 steer 行為）。橋不重試注入，交付即忘（inbox 檔案即持久化）。

## 6. 風險與開放問題

- **R1 結果擷取**：`--mode json` 流的最終文本取最後一條 `message_end` 的 assistant `text`；含 toolCall 的輪次繼續等，直到 `agent_end`。已有 PONG 流驗證過該結構 ✅
- **R2 超時**：裝置 pi 任務可能長跑（>60s）。CLI `timeoutS` 上限調到 600（mesh 場景）；橋側 per-msg 超時 10min，超時回寫發起方「任務超時，裝置端仍在跑，結果將丟棄」（v1 簡化）
- **R3 會話膨脹**：持久 session 長聊會膨脹——v1 不處理（提供重置），v2 評估 `--no-session` 定期輪換或 compact
- **R4 多 pi 會話同時 send**：inbox 序列消費（橋單佇列），天然無併發衝突
- **開放 Q1**：裝置 agent 是否要能反向 `send` 給 mini 任意 agent（目前回復只回發起方）？v1 否（單向應答），反向發訊息留 v2
- **開放 Q2**：Crew 編排（plan/work）跨裝置任務——不在此期（Crew worker spawn 是 mini 本地行為，跨裝置 worker 是更遠期方向）

## 7. 實施分期與驗收

**P3a（橋 + 通道，預計一個工作時段）**

- index.mjs 橋模組 + WS msg-up；cli.mjs p10（sessionId + 上行）；面板 Mesh 卡
- 驗收：mini pi 會話 `send to=RemoteMbp "你是誰，report hostname"` → 收到 wake 回覆（含 gxg-mbp）→ `list` 可見 RemoteMbp → 再發一條驗證 `--resume` 記憶（第二問能複述第一問內容）

**P3b（打磨，20261024 已落地）**

- 離線補發、超時回寫、重置會話按鈕、README/CHANGELOG、裝置端 session 快照進面板

**P3b 實際落地與設計偏差**

1. **多裝置路由提前實現**（原 §5.4 "v1 只接 1 臺"）：meshDrain 改為按訊息所在 inbox 目錄（目標裝置 agent 名）→ registry.device 反查裝置 aid 定向投遞；目標離線則滯留等補發。單裝置/多裝置行為一致，驗收回歸通過
2. **會話管理端點**：CLI p14 `GET /session`（快照）+ `POST /session/reset`（刪 session.json）；server `GET /mesh/session`、`POST /mesh/reset`（支援 `?agent=` 指定裝置）；面板 Mesh 卡「會話/重置會話」按鈕
3. **CLI p15**：undici 在 CONNECTING 態 close() 不觸發 onclose，connectGuard 廢棄後重連鏈死亡 → 廢棄後 3s 複檢仍 0 則 exit(0) 由 launchd 重拉
4. **persistCmd 模板修復**：launchd 不展開 plist `StandardOutPath` 的 %h（spawn 即 78 EX_CONFIG）→ 改 `$HOME`（詳見 CHANGELOG 1.4.0 / PROGRESS 事故記錄）
5. 驗收全綠：裝置上線 p15（launchd 常駐）→ 快照 → reset removed → reset 後首條回覆「PONG-p3b · 新會話已建立」；滯留補發實測（積壓訊息上線後處理，10min 超時保護丟棄，queue 清零）

## 8. 備份與回滾

- 改前照例：`~/WorkSpace/pdd-backup/tunnel-plugin-pre-p3a-<ts>/` 全量歸檔
- CLI p10 推送失敗自動回滾（self-update 已有原子替換）；橋開關關掉即完全回到 Phase 2 行為
