# 无人值守运行（Headless / Always-On）

面向「**不打开 Web 界面也要能干活**」的场景：机房、容器、树莓派、开机自启的 systemd/launchd 服务，
以及手机端只发 QQ/微信、从不看网页的用法。

## 1. 曾经的问题

宿主的执行会话是「属于连接」的：`AgentService.clients: Map<clientId, ClientSession>`，只有 WebSocket
attach 之后才有会话。渠道插件（QQ/微信/Telegram…）靠 `host.chat()` 伪造一个 `plugin:<id>:<account>`
伪客户端来寄生（`server/agent-service-daemon.ts` 的 `chatFromPlugin`）。

插件服务端入口的激活点却挂在 attach 上：`server/plugins.ts` 的 `ensureLoaded()` 只被
`server/index.ts` 的两处 attach 流程与手动 `reload()` 调用。于是：

| 场景                                | 结果                                                     |
| ----------------------------------- | -------------------------------------------------------- |
| 打开过页面，然后关掉页面            | ✅ 继续工作（WS 关闭只是 `detach`，不 `deactivate`）     |
| 进程/机器重启后从未打开页面         | ❌ 插件不激活 → 渠道长连接不建立 → 消息全丢              |
| `pi-web-ui server install` 开机自启 | ❌ 同上（`--no-browser` 只关自动开浏览器，不改变这一点） |

## 2. 现在的机制

两层，缺一不可：

### 2.1 `manifest.alwaysOn`：声明谁该常驻

```jsonc
{
	"id": "qq",
	"version": "0.2.1",
	"apiVersion": 2,
	"alwaysOn": true, // ← 新增：宿主启动时（无任何 WS 连接）就激活这个插件的 index.mjs
}
```

- 缺省 `false`：普通 UI 插件继续懒激活，避免开机拉起上百个插件的副作用（后台定时器、外部连接）。
- 只有 `alwaysOn: true` 会在启动阶段被激活；其余等首个客户端 attach。
- 校验：`server/plugin-manifest-validate.ts`（非布尔值给 warning 并当 false）。
- 解析与两个作用域：`server/plugins.ts` 的 `scan()` / `ensureLoaded(lang, { scope })` /
  `loadGeneration(..., scope)`，作用域 `all` 与 `alwaysOn` 各自持有独立的 in-flight promise，
  避免「启动阶段只加载子集」把后续 attach 的补齐逻辑吞掉。
- 自愈：`rescanAlwaysOn()` 清掉激活失败的常驻插件（`deactivateEntry` + 清 `attempted`）后重扫。

当前声明为常驻的内置插件：**qq、wechat-ilink、telegram、discord、slack、matrix、whatsapp、
imessage、feishu、dingtalk、wecom**（11 个外部消息渠道都要靠出站长连接收消息，收不到就永远没活干）。

**已安装副本怎么拿到新 manifest**：`server/plugins.ts` 的 `syncBuiltinPlugins()` 在每次 `scan()` 开头
把安装包内的 `plugins/<id>` 与 `<dataDir>/plugins/<id>` 比版本，源更高时 `ensureBackup` + 覆盖
（保留 `storage.json` / `secrets.bin` —— 这两个被 `.gitignore` 排除，发布包里没有，不会被覆盖）。
所以声明 `alwaysOn` 时**递增 manifest 版本号**即可让老用户重启后自动生效，不需要手动重装。

### 2.2 `BackgroundExecutorRegistry`：谁负责把它们拉起来

`server/background-executors.ts`。所有人（常驻插件、内置定时任务，未来还有 canvas worker /
device-task executor）都实现同一个契约，由**一个**注册表统一启动、探活、按策略自愈：

```ts
backgroundExecutors.register({
	id: "plugins:always-on",
	kind: "boot", // boot = 进程起来就跑；on-demand = 只登记
	restart: "on-failure", // 缺省 never：只报告，不反复拉起抖动的外部连接
	start: async () => {
		/* 失败就抛：注册表捕获、记入快照，不影响其它执行者，也不阻断 listen */
	},
	health: () => ({ ok: true, detail: "…", stats: { … } }),
});
```

启动时机在 `httpServer.listen()` 回调里（`server/index.ts`）：`startAll()` → `startProbing()`（60s，
`unref`）。三个硬约定：

1. **永不抛错**：一个坏执行者不会拖垮其它执行者，也不会阻断端口监听。
2. **失败隔离 + 快照**：`snapshot()` 有 `state / lastError / restarts / health / healthCheckedAt`。
3. **抖动静默**：`restart` 默认 `never`；`on-failure` 有 5min 冷却（以**上次启动时间**为基准）与
   3 次上限，超过后只在 health 里持续报红。

内置定时任务也从「模块顶层直接 `scheduler.start()`」改为注册成 `kind: "boot"` 的执行者，
于是它的启用时机、失败与健康快照与插件一致。

## 3. 观测：`/api/health`

```jsonc
{
	"ok": true, // 保持恒 true：page-picker 扩展靠它探测「这是不是 pi-web-ui」
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
	"unhealthy": [], // 只列 boot 类里 pending/failed/unhealthy 的，运维脚本看这个就够
}
```

排查顺序（QQ 不回话时）：

1. `curl /api/health` 看 `unhealthy` 是否为空、`plugins:always-on` 的 `stats.active` 是否等于插件总数。
2. 日志里搜 `[background]` / `[plugin:<id>] activate failed:`。
3. 插件自身配置（AppID/Secret、白名单、`botEnabled`）仍是前置条件：常驻只保证**入口被调用**，
   不替你填配置。QQ 的入口判断在 `plugins/qq/index.mjs` 的 `activate()`。

## 4. 无人语义（B 阶段）

「能被拉起」不等于「能自己跑完」。B 阶段补两件事。

### 4.1 提问与审批不再永久挂起

无人值守会话 = 伪客户端会话：`plugin:<id>:<account>`、`scheduler:<id>`、`canvas*`（判定唯一来源是
`server/client-id-utils.ts` 的 `isPseudoClientId`）。这类会话没有人在看 UI，所以：

| 场景                | 行为                                                                                                                  | 事实源                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `ask_user_question` | 按 `questionTimeoutSeconds`（默认 240s，设置面板可调）超时，返回 `{status:"timed_out"}`                               | `server/pending-question.ts` · `askUser()`          |
| 工具审批            | `unattendedApprovalTimeoutMs()` 返回超时（默认 120s，`PI_WEB_UNATTENDED_APPROVAL_TIMEOUT` 可覆盖，上限 1h）→ **拒绝** | `server/tool-approval.ts` · `requestToolApproval()` |

两条硬约定：

1. **超时一律走「拒绝」，绝不自动放行** —— 无人可点时替你批准危险操作是事故，不是自动化。
2. **超时要可解释**：会话里 emit 一条 warning notice（渠道侧会看到这条 trace），审计日志记
   `decisionSource: "unattended_timeout"`。要让它自动过，就改审批策略/白名单，而不是放宽超时。

普通会话（真人盯着）仍然是「永不超时」—— 这次只改了无人值守这一侧。

### 4.2 入站消息改成至少一次投递

`host.inbox`（`server/plugin-inbox.ts`）是宿主级的持久化投递账本：

```js
const claim = host.inbox.claim(`msg:${eventType}:${data.id}`, { channelId });
if (claim.status !== "new") return; // done / in-flight / dead → 别重复处理
try {
	const r = await host.chat({ text });
	host.inbox.complete(key, { conversationId: r.conversationId, runId: r.runId });
} catch (err) {
	host.inbox.fail(key, err);
	throw err;
}
```

语义（`tests/unit/plugin-inbox.test.ts` 覆盖）：

- 幂等键：同一 key 第二次 `claim` → `duplicate`（`reason: done | in-flight | dead`）。
- 至少一次：`claimed` 卡住超过 `stallMs`（10min）、或 `failed` 未到上限（`maxAttempts` 3）→
  **允许重投**（`attempts+1`）。进程崩溃不会丢消息，最坏重复投递一次。
- 有界：`<dataDir>/plugin-inbox/<pluginId>.json`，最多 2000 条 / `done` 保留 7 天，原子写 + 300ms debounce。
- 排障：`pending()`（卡住的）、`dead()`（超上限死信）。
- 接线：QQ 插件已接（替掉内存 500 条 `seenMessageIds`，且无 `host.inbox` 的老宿主自动回退）；
  其余渠道按同一模式接。

### 4.3 出站：失败有账本、按类别退避、死信可观测

入站（`host.inbox`）与出站（`host.delivery`）共用**同一个账本**（`server/plugin-ledger.ts`，
`direction: "in" | "out"`），所以「这条消息到底送到了没有」只有一个事实源。

```js
host.delivery.register({ channel: "qq", send: (item) => this.sendRaw(item.target, item.payload) });
// 立刻试一次：成功 sent / 可重试失败 queued（后台 pump 继续）/ 不可重试抛错
await host.delivery.send({ channel: "qq", key, target, payload, classify: classifyQqError });
```

三条硬约定（都不在插件里）：

1. **快路径不变**：`send()` 仍然立刻尝试一次并 `await`。只有「可重试失败」才转后台队列 ——
   不会把一条同步链路改成异步链路。
2. **按错误类别处置，不是无脑重试**（`DeliveryErrorClass`）：
   `network` / `rate_limited` / `unknown` 进退避队列（默认 5s → 30s → 2min → 10min）；
   `expired` 由插件内部的降级处理（QQ：改发主动消息）；`rejected` / `auth` **立即死信并抛错**，
   因为重试 100 次也不会成功，只会更快撞平台配额。
3. **TTL 兜底**（默认 10 分钟）：平台有被动回复窗口，超窗的消息重发没有意义，到点直接死信。

观测（`/api/health` → `executors[plugins:always-on].health.stats`）：

```jsonc
{
	"outbox": { "qq": { "queued": 0, "due": 0, "dead": 0, "done": 12, "inboxDead": 0 } },
	"outboxQueued": 0,
	"deadLetters": 0,
}
```

> ⚠️ `/api/health` 走的是 `backgroundExecutors.snapshotLive()`（实时刷新），不是 `snapshot()`。
> 后者返回**上一次 60s 探针的缓存** —— 用它会出现「账本已经是 done，health 还显示 queued」的假故障
> （2026-11 踩过，守卫在 `tests/unit/background-executors.test.ts`）。

## 5. 还没做的

| 缺口               | 说明                                                                                 | 方向                                                      |
| ------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 微信通道未接 inbox | 平台入站消息没有稳定 message id，合成 key（peer+文本）会误杀「同一用户连发相同文本」 | 等平台给出 `message_id`，或改用「先处理再推进 cursor」    |
| Outbox / 投递重试  | `complete/fail` 只记状态，出站失败不会自动重排队                                     | 用 `pending()` 做重放队列，或接 `workItems` 的 lease 语义 |
| 各渠道重复记账     | 各插件仍自己存 `sessionRoutes`/epoch                                                 | 收口到宿主 run ledger（`server/durable/`）                |
| 权限申请依赖弹窗   | `host.requestPermission` 无浏览器时一律 `false`（net/llm 两族）                      | 预置授权文件 / 启动参数，或首次 attach 时补申请           |

更长期的方向是把「会话」从 `ClientSession`（属于连接）拆成 actor + 多 sink 订阅
（conversation 是 actor，Web/QQ/推送/桌面壳都是订阅者），Web UI 退化为控制面。届时
`chatFromPlugin` 的伪客户端寄生可以整个删掉。
