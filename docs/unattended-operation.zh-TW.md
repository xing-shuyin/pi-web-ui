[English](./unattended-operation.en.md) · [简体中文](./unattended-operation.md) · **繁體中文**

# 無人值守執行（Headless / Always-On）

面向「**不開啟 Web 介面也要能幹活**」的場景：機房、容器、樹莓派、開機自啟的 systemd/launchd 服務，
以及手機端只發 QQ/微信、從不看網頁的用法。

## 1. 曾經的問題

宿主的執行會話是「屬於連線」的：`AgentService.clients: Map<clientId, ClientSession>`，只有 WebSocket
attach 之後才有會話。渠道外掛（QQ/微信/Telegram…）靠 `host.chat()` 偽造一個 `plugin:<id>:<account>`
偽客戶端來寄生（`server/agent-service-daemon.ts` 的 `chatFromPlugin`）。

外掛服務端入口的啟用點卻掛在 attach 上：`server/plugins.ts` 的 `ensureLoaded()` 只被
`server/index.ts` 的兩處 attach 流程與手動 `reload()` 呼叫。於是：

| 場景                                | 結果                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| 開啟過頁面，然後關掉頁面            | ✅ 繼續工作（WS 關閉只是 `detach`，不 `deactivate`）     |
| 程序/機器重啟後從未開啟頁面         | ❌ 外掛不啟用 → 渠道長連線不建立 → 訊息全丟              |
| `pi-web-ui server install` 開機自啟 | ❌ 同上（`--no-browser` 只關自動開瀏覽器，不改變這一點） |

## 2. 現在的機制

兩層，缺一不可：

### 2.1 `manifest.alwaysOn`：宣告誰該常駐

```jsonc
{
	"id": "qq",
	"version": "0.2.1",
	"apiVersion": 2,
	"alwaysOn": true, // ← 新增：宿主啟動時（無任何 WS 連線）就啟用這個外掛的 index.mjs
}
```

- 預設 `false`：普通 UI 外掛繼續懶啟用，避免開機拉起上百個外掛的副作用（後臺定時器、外部連線）。
- 只有 `alwaysOn: true` 會在啟動階段被啟用；其餘等首個客戶端 attach。
- 校驗：`server/plugin-manifest-validate.ts`（非布林值給 warning 並當 false）。
- 解析與兩個作用域：`server/plugins.ts` 的 `scan()` / `ensureLoaded(lang, { scope })` /
  `loadGeneration(..., scope)`，作用域 `all` 與 `alwaysOn` 各自持有獨立的 in-flight promise，
  避免「啟動階段只加載子集」把後續 attach 的補齊邏輯吞掉。
- 自愈：`rescanAlwaysOn()` 清掉啟用失敗的常駐外掛（`deactivateEntry` + 清 `attempted`）後重掃。

當前宣告為常駐的內建外掛：**qq、wechat-ilink、telegram、discord、slack、matrix、whatsapp、
imessage、feishu、dingtalk、wecom**（11 個外部訊息渠道都要靠出站長連線收訊息，收不到就永遠沒活幹）。

**已安裝副本怎麼拿到新 manifest**：`server/plugins.ts` 的 `syncBuiltinPlugins()` 在每次 `scan()` 開頭
把安裝包內的 `plugins/<id>` 與 `<dataDir>/plugins/<id>` 比版本，源更高時 `ensureBackup` + 覆蓋。
使用者狀態（`storage.json` / `secrets.bin` / `schedules.json`）不在程式碼目錄裡，而是
`<dataDir>/plugin-data/<id>/`，所以覆蓋程式碼永遠碰不到配置；半殘的程式碼目錄會按物化回執自動補齊。
所以宣告 `alwaysOn` 時**遞增 manifest 版本號**即可讓老使用者重啟後自動生效，不需要手動重灌。

### 2.2 `BackgroundExecutorRegistry`：誰負責把它們拉起來

`server/background-executors.ts`。所有人（常駐外掛、內建定時任務，未來還有 canvas worker /
device-task executor）都實現同一個契約，由**一個**登錄檔統一啟動、探活、按策略自愈：

```ts
backgroundExecutors.register({
	id: "plugins:always-on",
	kind: "boot", // boot = 程序起來就跑；on-demand = 只登記
	restart: "on-failure", // 預設 never：只報告，不反覆拉起抖動的外部連線
	start: async () => {
		/* 失敗就拋：登錄檔捕獲、記入快照，不影響其它執行者，也不阻斷 listen */
	},
	health: () => ({ ok: true, detail: "…", stats: { … } }),
});
```

啟動時機在 `httpServer.listen()` 回撥裡（`server/index.ts`）：`startAll()` → `startProbing()`（60s，
`unref`）。三個硬約定：

1. **永不拋錯**：一個壞執行者不會拖垮其它執行者，也不會阻斷埠監聽。
2. **失敗隔離 + 快照**：`snapshot()` 有 `state / lastError / restarts / health / healthCheckedAt`。
3. **抖動靜默**：`restart` 預設 `never`；`on-failure` 有 5min 冷卻（以**上次啟動時間**為基準）與
   3 次上限，超過後只在 health 裡持續報紅。

內建定時任務也從「模組頂層直接 `scheduler.start()`」改為註冊成 `kind: "boot"` 的執行者，
於是它的啟用時機、失敗與健康快照與外掛一致。

## 3. 觀測：`/api/health`

```jsonc
{
	"ok": true, // 保持恆 true：page-picker 擴充套件靠它探測「這是不是 pi-web-ui」
	"piVersion": "0.118.0",
	"engine": "pi",
	"executors": [
		{
			"id": "plugins:always-on",
			"kind": "boot",
			"state": "running",
			"startedAt": 1762400000000,
			"restarts": 0,
			"health": { "ok": true, "detail": "11 alwaysOn plugin(s) active", "stats": { "active": 11, "total": 11 } },
		},
		{
			"id": "scheduler",
			"kind": "boot",
			"state": "running",
			"health": { "ok": true, "detail": "3 task(s), 2 enabled" },
		},
	],
	"unhealthy": [], // 只列 boot 類裡 pending/failed/unhealthy 的，運維指令碼看這個就夠
}
```

排查順序（QQ 不回話時）：

1. `curl /api/health` 看 `unhealthy` 是否為空、`plugins:always-on` 的 `stats.active` 是否等於外掛總數。
2. 日誌裡搜 `[background]` / `[plugin:<id>] activate failed:`。
3. 外掛自身配置（AppID/Secret、白名單、`botEnabled`）仍是前置條件：常駐只保證**入口被呼叫**，
   不替你填配置。QQ 的入口判斷在 `plugins/qq/index.mjs` 的 `activate()`。

## 4. 無人語義（B 階段）

「能被拉起」不等於「能自己跑完」。B 階段補兩件事。

### 4.1 提問與審批不再永久掛起

無人值守會話 = 偽客戶端會話：`plugin:<id>:<account>`、`scheduler:<id>`、`canvas*`（判定唯一來源是
`server/client-id-utils.ts` 的 `isPseudoClientId`）。這類會話沒有人在看 UI，所以：

| 場景                | 行為                                                                                                                  | 事實源                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `ask_user_question` | 按 `questionTimeoutSeconds`（預設 240s，設定面板可調）超時，返回 `{status:"timed_out"}`                               | `server/pending-question.ts` · `askUser()`          |
| 工具審批            | `unattendedApprovalTimeoutMs()` 返回超時（預設 120s，`PI_WEB_UNATTENDED_APPROVAL_TIMEOUT` 可覆蓋，上限 1h）→ **拒絕** | `server/tool-approval.ts` · `requestToolApproval()` |

兩條硬約定：

1. **超時一律走「拒絕」，絕不自動放行** —— 無人可點時替你批准危險操作是事故，不是自動化。
2. **超時要可解釋**：會話裡 emit 一條 warning notice（渠道側會看到這條 trace），審計日誌記
   `decisionSource: "unattended_timeout"`。要讓它自動過，就改審批策略/白名單，而不是放寬超時。

普通會話（真人盯著）仍然是「永不超時」—— 這次只改了無人值守這一側。

### 4.2 入站訊息改成至少一次投遞

`host.inbox`（`server/plugin-inbox.ts`）是宿主級的持久化投遞賬本：

```js
const claim = host.inbox.claim(`msg:${eventType}:${data.id}`, { channelId });
if (claim.status !== "new") return; // done / in-flight / dead → 別重複處理
try {
	const r = await host.chat({ text });
	host.inbox.complete(key, { conversationId: r.conversationId, runId: r.runId });
} catch (err) {
	host.inbox.fail(key, err);
	throw err;
}
```

語義（`tests/unit/plugin-inbox.test.ts` 覆蓋）：

- 冪等鍵：同一 key 第二次 `claim` → `duplicate`（`reason: done | in-flight | dead`）。
- 至少一次：`claimed` 卡住超過 `stallMs`（10min）、或 `failed` 未到上限（`maxAttempts` 3）→
  **允許重投**（`attempts+1`）。程序崩潰不會丟訊息，最壞重複投遞一次。
- 有界：`<dataDir>/plugin-inbox/<pluginId>.json`，最多 2000 條 / `done` 保留 7 天，原子寫 + 300ms debounce。
- 排障：`pending()`（卡住的）、`dead()`（超上限死信）。
- 接線：QQ 外掛已接（替掉記憶體 500 條 `seenMessageIds`，且無 `host.inbox` 的老宿主自動回退）；
  其餘渠道按同一模式接。

### 4.3 出站：失敗有賬本、按類別退避、死信可觀測

入站（`host.inbox`）與出站（`host.delivery`）共用**同一個賬本**（`server/plugin-ledger.ts`，
`direction: "in" | "out"`），所以「這條訊息到底送到了沒有」只有一個事實源。

```js
host.delivery.register({ channel: "qq", send: (item) => this.sendRaw(item.target, item.payload) });
// 立刻試一次：成功 sent / 可重試失敗 queued（後臺 pump 繼續）/ 不可重試拋錯
await host.delivery.send({ channel: "qq", key, target, payload, classify: classifyQqError });
```

三條硬約定（都不在外掛裡）：

1. **快路徑不變**：`send()` 仍然立刻嘗試一次並 `await`。只有「可重試失敗」才轉後臺佇列 ——
   不會把一條同步鏈路改成非同步鏈路。
2. **按錯誤類別處置，不是無腦重試**（`DeliveryErrorClass`）：
   `network` / `rate_limited` / `unknown` 進退避佇列（預設 5s → 30s → 2min → 10min）；
   `expired` 由外掛內部的降級處理（QQ：改發主動訊息）；`rejected` / `auth` **立即死信並拋錯**，
   因為重試 100 次也不會成功，只會更快撞平臺配額。
3. **TTL 兜底**（預設 10 分鐘）：平臺有被動回覆視窗，超窗的訊息重發沒有意義，到點直接死信。

觀測（`/api/health` → `executors[plugins:always-on].health.stats`）：

```jsonc
{
	"outbox": { "qq": { "queued": 0, "due": 0, "dead": 0, "done": 12, "inboxDead": 0 } },
	"outboxQueued": 0,
	"deadLetters": 0,
}
```

> ⚠️ `/api/health` 走的是 `backgroundExecutors.snapshotLive()`（即時重新整理），不是 `snapshot()`。
> 後者返回**上一次 60s 探針的快取** —— 用它會出現「賬本已經是 done，health 還顯示 queued」的假故障
> （2026-11 踩過，守衛在 `tests/unit/background-executors.test.ts`）。

## 5. 還沒做的

| 缺口               | 說明                                                                                   | 方向                                                      |
| ------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 微信通道未接 inbox | 平臺入站訊息沒有穩定 message id，合成 key（peer+文本）會誤殺「同一使用者連發相同文本」 | 等平臺給出 `message_id`，或改用「先處理再推進 cursor」    |
| Outbox / 投遞重試  | `complete/fail` 只記狀態，出站失敗不會自動重排隊                                       | 用 `pending()` 做重放佇列，或接 `workItems` 的 lease 語義 |
| 各渠道重複記賬     | 各外掛仍自己存 `sessionRoutes`/epoch                                                   | 收口到宿主 run ledger（`server/durable/`）                |
| 許可權申請依賴彈窗 | `host.requestPermission` 無瀏覽器時一律 `false`（net/llm 兩族）                        | 預置授權檔案 / 啟動引數，或首次 attach 時補申請           |

更長期的方向是把「會話」從 `ClientSession`（屬於連線）拆成 actor + 多 sink 訂閱
（conversation 是 actor，Web/QQ/推送/桌面殼都是訂閱者），Web UI 退化為控制面。屆時
`chatFromPlugin` 的偽客戶端寄生可以整個刪掉。
