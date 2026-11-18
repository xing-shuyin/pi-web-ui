# 消息中心（Message Hub）可行性报告

> 你的想法可以落地，而且不需要重写任何一个渠道。
> 一句话形态：**宿主增加一个「渠道注册表 + 归一化收件箱」的薄内核，AI 只看一个 `message` 工具，
> 人只看一个内置「消息」视图（不是插件），渠道插件继续各自管自己的协议、鉴权、路由与会话代次。**
>
> 本报告只讨论方案与边界，不含实现代码。事实基线全部可在仓库里核对（附文件:行号）。
> **两项已定决策**：① 面板是内置功能（不做插件）；② 首个对接渠道是飞书。

---

## 0. 结论摘要

| 问题                          | 现状                                                                                                                                                                                  | 结论                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 装多个渠道会不会多出重复工具  | 会。11 个渠道插件各自注册工具（`qq` / `telegram` / … / `wechat_send`），10 个工具的参数 schema 合计 **13,373 字符 ≈ 3.8k tokens / 轮**（实测，见 §2.1），且 AI 无法枚举「有哪些渠道」 | 收敛到 **1 个 `message` 工具（≈1.6KB）**，省约 3.4k tokens/轮                                                                                         |
| 能否"看有哪些渠道"            | 不能。渠道清单只存在于前端 UI 条目与 `plugins` 清单里，AI 侧无入口                                                                                                                    | 宿主侧注册表 + `action=channels`；schema 用纯 `string` 而非动态 enum，避免打坏前缀缓存                                                                |
| 能否"看收到了哪些消息"        | 不能。每个渠道各有一套内存态收件箱/未读计数（如 feishu `countUnread`），彼此不可见，重启即散                                                                                          | 宿主归一化记账（旁路观测），带"处置结果"（已派发/白名单丢弃/命中命令/发送失败）                                                                       |
| 能否"发消息"                  | 能，但每个渠道一套 target 形状（chat_id / channel_id / room_id / openid / 手机号…），AI 靠猜                                                                                          | 统一 `send`，目标用**不透明目录 id**，平台格式与上传仍留在插件内                                                                                      |
| **飞书能不能随时收发**        | 飞书工具已有 `chats/list/read/search/send/reply/recall/react/webhook` 九个 action（`plugins/feishu/index.mjs:844`）                                                                   | **没有 QQ 那种"被动回复窗口 + 主动消息额度"限制**，AI 可以在应用可用范围内主动发；但有另一类限制（可用范围、机器人在群、API 频控、媒体格式），见 §1.4 |
| **QQ 为什么过一段时间发不了** | 被动回复带 `msg_id`，过期即失败；插件按错误码识别后降级"主动消息"，而主动消息受平台权限与额度限制（`plugins/qq/README.md:27`、`index.mjs:1192`）                                      | 你的观察是对的。**这不是 bug，是平台模型**；注册表必须把 `proactive` 作为一等能力暴露给 AI，不能假装所有渠道等价                                      |
| 面板形态                      | —                                                                                                                                                                                     | **内置视图**（`view:"messages"`），不是插件。文件集见 §4.5                                                                                            |
| 要不要统一入站投递/会话路由   | —                                                                                                                                                                                     | **不要碰**。红线 `delivery-gate-single-source`：入站投递只由 `deliveryMode()` 判定；`/new`、accountId epoch、runId 归属仍是各插件事实源               |
| 代价                          | —                                                                                                                                                                                     | 新增约 **4.5k–5.5k 行**（含测试），11 个渠道各加 **40–120 行** adapter；**P0a（内核 + 工具 + 飞书）5–7 人日，P0b（内置视图）5–7 人日**                |

**一句话风险**：技术风险不高，真正的坑是三件产品事实——① 各平台 target 形状无法统一（用"不透明目录 id"绕开）；② 平台发送能力不等价（飞书可主动、QQ 有窗口/额度），必须进契约而不是补丁；③ 多数平台**不允许读历史消息**（Telegram Bot API 根本没有历史接口），所以消息中心只能"从装上那天起记账"——**飞书是例外，它有 `GET /im/v1/messages`，这也是先接它的关键理由**。

---

## 1. 事实基线（可核对，不是猜测）

### 1.1 每个渠道各注册一个工具，形状互不相同

| 渠道     | 工具名        | 文件:行                               | `action`                                                               | 目标字段（AI 必须自己猜该怎么填）                                                      |
| -------- | ------------- | ------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| QQ       | `qq`          | `plugins/qq/index.mjs:2037`           | send / status                                                          | `channel_id` / `user_openid` / `group_openid` + `image` / `file`                       |
| Telegram | `telegram`    | `plugins/telegram/index.mjs:260`      | send / status                                                          | `chat_id` + `media` / `media_type` / `message_thread_id`                               |
| Discord  | `discord`     | `plugins/discord/index.mjs:330`       | send / status                                                          | `channel_id`                                                                           |
| Slack    | `slack`       | `plugins/slack/index.mjs:309`         | send / status                                                          | `channel` + `thread_ts`                                                                |
| 飞书     | `feishu`      | `plugins/feishu/index.mjs:844`        | chats / list / read / search / send / reply / recall / react / webhook | `chat_id` / `open_id` / `receive_id_type` / `message_id`                               |
| 钉钉     | `dingtalk`    | `plugins/dingtalk/index.mjs:174`      | send / status                                                          | 群 / 单聊 / webhook                                                                    |
| Matrix   | `matrix`      | `plugins/matrix/index.mjs:732`        | send / status                                                          | `room_id` + thread                                                                     |
| WhatsApp | `whatsapp`    | `plugins/whatsapp/index.mjs:136`      | send / status                                                          | 手机号 / 模板                                                                          |
| iMessage | `imessage`    | `plugins/imessage/index.mjs:88`       | send / status                                                          | handle / 群 GUID                                                                       |
| 企业微信 | `wecom`       | `plugins/wecom/index.mjs:582`         | send / status                                                          | webhook / chat_id                                                                      |
| 微信通道 | `wechat_send` | `plugins/wechat-ilink/index.mjs:1898` | —（专用形状）                                                          | `to` = 微信用户 ID，注释原文「visible in the view's inbox」= **AI 只能被用户口头告知** |

观察：10 个渠道是"同一件事的 10 份平行实现"，第 11 个（微信）连形状都不同。**飞书是唯一一个已经把"列会话/读消息/搜索/回复"做进工具里的渠道**——它本身就是一个迷你消息中心，这就是先接它的理由。

### 1.2 重复的不只是工具，还有实现与 UI

| 重复物                 | 现状                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `markdown-chunks.mjs`  | **10 份，md5 完全相同**（`397d1e14…`）：qq / telegram / discord / slack / feishu / dingtalk / matrix / whatsapp / imessage / wecom 各一份 |
| `channel-behavior.mjs` | 4 份（telegram 447 / discord 567 / slack 453 / matrix 106 行），其中 discord 与 slack 的副本 md5 相同、另两份已分叉                       |
| 渠道工作台前端         | 每个渠道 300–460 行 `client/entry.mjs`（whatsapp 361 / telegram 349 / slack 350 / wecom 363 / wechat-ilink 464 …），结构高度相似          |
| 顶栏 + 底栏 UI         | 10 个 manifest 各声明 1 个视图 tab + 1 个底栏徽标 → 装 10 个渠道 = **10 个 tab + 10 个徽标**                                              |
| 未读轮询               | 各写一套（feishu `countUnread` + `pollNewMessages`，`plugins/feishu/index.mjs:758`）                                                      |

> 这些副本**本轮不合并**（插件独立安装是既有硬约束，合并 = 破坏可独立升级）。内置消息中心的价值是"不再多第 11 份"，而不是"顺手清洗历史债"。

### 1.3 宿主已有可复用的积木（这是可行性的关键）

| 积木                                      | 位置                                                                                                                                           | 消息中心怎么用                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `host.chat(req)` 无头投递                 | `server/plugins.ts:312` + `agent-service.ts`                                                                                                   | **不改**。仍由插件决定"这条消息要不要喂给 agent"                               |
| `host.delivery.register({channel, send})` | `server/plugin-delivery.ts`                                                                                                                    | 已有"按渠道登记出站发送器"的雏形，只剩 QQ 用了（`plugins/qq/index.mjs:2000`）  |
| `host.inbox`（入站账本）                  | `server/plugin-ledger.ts` + `plugin-inbox.ts`                                                                                                  | 语义是"至少一次去重"，不是"可查询的消息日志" → 不复用表，只复用原子写/保留策略 |
| `host.services.provide/get`               | `server/plugins.ts:3875`                                                                                                                       | 插件间能力发现的现成通道（先例：`remoteSsh`，`plugins/sftp/index.mjs:381`）    |
| `host.events.emit/on`                     | `plugin-sdk/index.d.ts:608`                                                                                                                    | 载荷 4KB 截断 → 只适合通知"有新消息"，不适合传正文                             |
| 内置视图范式                              | `web/src/ui-slots.ts:149` `BUILTIN_UI_ITEMS`（`view:"terminal"/"git"/"canvas"/"devices"`）、`web/src/App.tsx:3374` view-pane + `DeferredMount` | 内置「消息」视图照抄这条链路，不新造范式                                       |
| 工具折叠先例                              | `terminal`（6→1）、`conversation`（9→1）、`sftp`（`docs/architecture-plugins.md` 原文「拆成十几个工具只会塞满上下文」）                        | 统一工具是**已被本仓库验证过的范式**，不是新发明                               |
| 工具开关与懒加载                          | `disabledPluginTools` / `agentToolsDefaultOn` / `load_tools` + `tool_search`                                                                   | 收编后旧工具的下线与逃生门                                                     |
| 单测守卫                                  | `tool-registration` / `tool-prompt-hygiene` / `tool-schema-slim` / `plugin-version-bump-guard` / `i18n-catalog`                                | 新增工具、改插件与内置 UI 文案必须过的门                                       |

**结论：不需要新的机制，只需要一个新的"聚合点"。**

### 1.4 飞书 vs QQ：发送约束的真实差别（你问的核心）

| 维度             | **飞书（自建应用）**                                                                                               | **QQ（官方机器人）**                                                                                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 被动回复时间窗口 | **没有**。发消息不带"必须在收到某条消息后 N 分钟内"的约束                                                          | **有**。被动回复 payload 必须带 `msg_id`（`plugins/qq/index.mjs:1185`），过期后该回复链路失效                                                                                                                              |
| 过期后的行为     | 不存在这条路径                                                                                                     | 代码识别 `expire / 304023 / 304024 / 304026 / 40040003 / 50006` 为 `expired`，降级为不带 `msg_id` 的"主动消息"（`plugins/qq/index.mjs:1192–1228`）；README 原文：「实际受平台权限和额度限制」（`plugins/qq/README.md:27`） |
| AI 主动发通知    | **可以常态工作**（用户/群在应用可用范围内、机器人在群里）                                                          | 受平台权限 + 主动消息额度；用完后就是你说的"过一段时间 AI 就无法主动发消息"                                                                                                                                                |
| 历史消息         | **可读**：`GET /open-apis/im/v1/messages`，插件已实现 `chats/list/read/search`                                     | 无通用历史读取接口                                                                                                                                                                                                         |
| 其它限制         | 应用可用范围、机器人须在群内、API 频控（插件当前**没有**显式 429 退避）、媒体格式/10MiB、Webhook 仅群且仅文本/卡片 | 富媒体格式/配额、频道只接受公网 URL、单实例 Gateway 锁、`/gateway` 100017 限流（60s–5min 退避）                                                                                                                            |

**精确回答你的问题**：飞书**不是"任何时候收发都绝对没有限制"**，而是**没有 QQ 那种"时间窗口 + 主动消息额度"**。它的限制是另一类——范围（可用范围 / 机器人在群）、频率（API 频控）、格式（媒体/卡片），这些是稳定可预期的；QQ 的限制会**随时间变化**（窗口过期、额度耗尽），这正是消息中心 API 必须暴露 `proactive` 能力的原因。

同理可对照：`docs/external-channel-capabilities.md:22` 明确写了 **WhatsApp 受 24 小时窗口和模板要求限制**；企业微信 Webhook 只能单向群推送（同文档 `:20`）；Telegram / Discord / Slack / Matrix 没有被动窗口，但各有权限与媒体上限。

---

## 2. 痛点量化

### 2.1 上下文成本（硬成本，每轮都付）

实测 10 个 `registerTool` 块（`name` → `async execute`，含 description / promptSnippet / guidelines / parameters）：

```
qq 1549 · telegram 1121 · discord 952 · slack 1079 · feishu 2928
dingtalk 1547 · matrix 1050 · whatsapp 1267 · imessage 1026 · wecom 854
合计 13,373 字符 ≈ 3.8k tokens / 轮（按字符/3.5 估，与 `docs/tool-context-budget.md` 的口径一致）
```

统一工具后：单工具 ≈ 1.2–1.8KB 字符 ≈ **0.4–0.5k tokens**，净省 **≈3.4k tokens/轮**。
按一天 200 轮算，约省 68 万 tokens/天——这是"装越多渠道越亏"的直接来源。

### 2.2 认知成本（AI 侧）

- 现在 AI 想发消息：先在一堆工具名里找 `telegram`，再猜 `chat_id` 该填什么；猜错就报错，用户还得去 UI 里拷 id。
- 现在 AI 想知道"有人找我吗"：**只有飞书能答**（它自己有 `list/read`），其余 10 个工具的 `action` 只有 send/status。
- 现在 AI 想知道"哪些渠道现在能主动发"：**完全无从判断**，于是对 QQ 的窗口过期/额度耗尽只能事后失败。

### 2.3 运维成本

- 一条入站消息"为什么没回"没有单一答案：白名单丢弃、命中 `/help`、`host.chat` 失败、平台发送失败、会话 epoch 未命中……散在 11 个插件的 log 里。
- 未读数是 UI 局部状态，重启清零；跨渠道"我今天收到几条"无人能答。

---

## 3. 方案对比

|                       | **A. 宿主渠道注册表（推荐）**                                                                    | B. 一个"消息中心"大插件                                     | C. 只做懒加载/提示词收敛（补丁）            |
| --------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------- |
| 形态                  | `server/message-hub.ts` + `plugin-sdk` 的 `host.messaging.*` + 宿主工具 `message` + **内置视图** | 插件消费 11 个渠道 `provide` 出来的 service                 | 只把渠道工具塞进 `lazyLoadingDisabledTools` |
| 上下文收益            | ✅ 3.8k → 0.4k                                                                                   | ✅ 同 A                                                     | ⚠️ 视模型何时加载，平均仍有 1–2k            |
| AI 能看到"有哪些渠道" | ✅ 注册表 + `proactive` 能力                                                                     | ✅                                                          | ❌                                          |
| AI 能看到"收到了什么" | ✅ 归一化收件箱                                                                                  | ✅                                                          | ❌                                          |
| 渠道能力差异可表达    | ✅ `proactive` / `history` / 媒体上限进契约                                                      | ✅                                                          | ❌                                          |
| 改动面                | 宿主 ~900 行 + 契约 ~70 行 + 飞书 ~80 行 + 内置 UI ~700 行                                       | 11 个渠道都要改（provide）+ 新插件（更大）                  | 1 行设置                                    |
| 依赖时序              | 注册表天然解耦，插件按需注册/注销                                                                | ❌ 面板插件激活顺序敏感                                     | 无                                          |
| 违反既有硬约束        | 无                                                                                               | ⚠️ 跨插件目录依赖倾向（`architecture-plugins.md` 明确禁止） | 无                                          |
| 卸载后 AI 还能发消息  | ✅ 视图是 UI，能力在宿主                                                                         | ❌ 卸载面板 = 工具消失                                      | ✅                                          |
| 生产可用期            | P0a/P0b 分期上线                                                                                 | 需一次改完 11 个渠道                                        | 立刻可用但只解决 1/3 问题                   |

**推荐 A**，并把 C 作为落地前的临时缓解（成本 1 行设置，可以今天就开）。

---

## 4. 推荐架构

### 4.1 分层

```
┌─────────────────────────────── 人（内置，不是插件） ──────────────────────────┐
│  内置视图 view:"messages" → web/src/components/MessageCenter.tsx             │
│  顶栏/底栏条目来自 BUILTIN_UI_ITEMS；数据走 WS: message_hub → _result         │
└───────────────────────────────┬──────────────────────────────────────────────┘
┌───────────────────────────────┴─────────────────────────────── AI ────────────┐
│  宿主内置工具 `message`（channels / inbox / read / send / status）             │
└───────────────────────────────┬──────────────────────────────────────────────┘
                        server/message-hub.ts  ★唯一聚合点
         registry（谁在线/能力/账号） │ store（归一化消息 + 未读） │ router（发送）
┌───────────────────────────────┴──────────────────────────────────────────────┐
│  channel adapter（每个渠道插件内 40–120 行，不 import 别的插件目录）           │
└──────┬─────────┬──────────┬──────────┬──────────┬────────────────────────────┘
     飞书       telegram    slack     QQ        …（协议/鉴权/路由/epoch 全在本插件）
   ★首个接入
```

**不可跨越的线**：hub 不认识平台 API、不做 markdown 分块、不上传媒体、不判定"该不该回"、不改 accountId epoch。它只做四件事：**枚举、记账、校验、路由**。

### 4.2 契约（`plugin-sdk/index.d.ts` 新增，单一事实源）

```ts
export type ProactiveMode =
	| "always" // 飞书/Telegram/Discord/Slack：可随时主动发（仍受频控/范围）
	| "windowed" // QQ/WhatsApp：被动窗口 + 主动额度，会过期
	| "webhook-only"; // 企业微信 Webhook：只能单向推群

export interface ChannelPeer {
	/** 不透明目录 id，由插件生成且稳定：`<channel>:<本地键>`。宿主只用它，不解释它。 */
	id: string;
	name: string;
	kind: "dm" | "group" | "channel" | "thread";
	thread?: string;
	/** 平台原始 id（chat_id/openid/room_id…），仅排障展示，AI 不用它。 */
	raw?: Record<string, string>;
}

export interface ChannelCapabilities {
	sendText: boolean;
	sendMedia: boolean;
	mediaMaxBytes?: number;
	/** "platform" = 插件能回补平台历史（飞书已具备）；"none" = 只能记观测到的消息。 */
	history: "none" | "platform";
	/** 直接回答"AI 能不能随时主动发"——QQ 必须诚实上报 windowed。 */
	proactive: ProactiveMode;
	groups: boolean;
	threads: boolean;
	unread: boolean;
}

export interface MessageHubChannel {
	id: string; // "feishu"
	label: string;
	icon?: string;
	capabilities: ChannelCapabilities;
	status(): Promise<{ state: "ok" | "off" | "unconfigured" | "error"; detail?: string; account?: string }>;
	listPeers?(opts?: { query?: string; limit?: number }): Promise<ChannelPeer[]>;
	/** 历史回补：只有 history="platform" 的渠道实现（飞书直接复用 list/read）。 */
	readHistory?(peerId: string, opts: { limit: number; cursor?: string }): Promise<NormalizedMessage[]>;
	send(input: {
		peerId: string;
		thread?: string;
		text?: string;
		media?: string[];
		key?: string; // 幂等键，缺省由宿主派生
	}): Promise<
		| { ok: true; messageId?: string }
		| {
				ok: false;
				error: string;
				retryable?: boolean;
				/** windowed 渠道过期/额度耗尽时必填，UI 与 AI 都要看得见。 */
				reason?: "passive_expired" | "quota_exhausted" | "rate_limited" | "out_of_scope";
		  }
	>;
}

// host 新增
host.messaging: {
	registerChannel(channel: MessageHubChannel): () => void;
	/** 入站观测：白名单/命令解析之后调用，只落库，不改投递语义。 */
	observe(record: {
		channel: string;
		peer: ChannelPeer;
		text: string;
		at?: number;
		messageId?: string;
		outcome: "dispatched" | "ignored" | "command" | "rejected" | "error";
		detail?: string;
		conversationId?: string;
		attachments?: Array<{ kind: string; name?: string; size?: number }>;
	}): void;
	markRead(input: { channel: string; peerId?: string; upTo?: string }): void;
	snapshot(opts?: { channel?: string; peerId?: string; limit?: number }): Promise<MessageHubSnapshot>;
};
```

设计要点（每条都是为了不踩坑）：

1. **`peerId` 不透明**。宿主与 AI 从不解析它，因此不需要"跨平台地址统一"这个无解题。想按原始 handle 发（如"发给 +8613800…"）时先 `listPeers({query})` 查目录，查不到就诚实报错——不做模糊匹配。
2. **`proactive` 是一等能力**（你这次提的问题直接催生的设计）。`action=channels` 会逐渠道返回 `proactive` / `history`；对 `windowed` 渠道，`send` 失败必须带 `reason`，AI 才能说"QQ 的被动窗口过期了，得让用户先发一条或换渠道"，而不是笼统报"发送失败"。
3. **`observe` 是旁路**。放在插件自己的入站回调里，白名单与命令解析之后、投递前后皆可。**不新增 `host.chat` 字段**，不触碰 issue #929 的投递门（`docs/architecture-core.md#压缩期的入站投递一个门一个队列一个排空点issues929`）。
4. **发送不重试**。`send` 失败把 `retryable` 交给模型/用户；平台级重试仍归插件（QQ 已用 `host.delivery`）。飞书插件目前**没有显式 429 退避**，这是实现缺口，交给 hub 侧的 `rate_limited` 分类 + 退避（复用 `server/plugin-delivery.ts` 的分类语义），不是给平台加窗口。
5. **飞书的历史回补是特例而非通则**。`readHistory` 只给 `history:"platform"` 的渠道实现；飞书直接复用已有的 `chats/list/read`（`plugins/feishu/index.mjs:844`），不用重写平台调用。

### 4.3 统一工具 `message`

```json5
{
	action: "channels | inbox | read | send | status",
	channel: "string", // 注意：纯 string，不用动态 enum
	peer: "string",
	thread: "string",
	text: "string",
	media: "string",
	limit: "number",
	cursor: "string",
}
```

| action     | 语义                                                                | 输出预算（硬上限）                |
| ---------- | ------------------------------------------------------------------- | --------------------------------- |
| `channels` | 已注册渠道 + 在线状态 + **`proactive`/`history` 能力** + 联系人数量 | ≤2KB                              |
| `inbox`    | 按时间倒序的归一化消息（默认 20 条，最多 50）                       | ≤8KB，`truncated` + `cursor` 分页 |
| `read`     | 按 id 取正文（默认 5 条，每条 4KB）                                 | ≤20KB                             |
| `send`     | 经 adapter 发送，返回 messageId 或带 `reason` 的明确错误            | ≤1KB                              |
| `status`   | 某渠道的连接/账号/失败统计                                          | ≤2KB                              |

三条硬约束：

1. **schema 里不放动态状态**。`channel` 是 `string` 而不是当前渠道名的 enum——否则装/卸渠道就改 schema，前缀缓存整段报废（`docs/tool-context-budget.md#3-硬约束不能打坏前缀缓存`）。
2. **输出必须分页**。500 条消息一次性返回就是分分钟爆上下文；默认 20 条 + 正文 500 字符摘要 + `cursor` 续读。
3. **提示词三处分离**：`description` / `promptSnippet` / `promptGuidelines`（"先 channels 再 send"、"QQ 是 windowed，过期要换渠道或让用户先发"、"飞书可回补历史，其它渠道只记观测值"、"发送前与用户确认一次"），纯英文精简，遵守 `tool-prompt-hygiene` / `tool-schema-slim`。

### 4.4 工具收敛三档

| 档位     | 行为                                                                                                                                            | 默认                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `off`    | 只有老工具，hub 不注册工具、不记账                                                                                                              | —                         |
| `mirror` | 新增 `message`（五个 action 全开，含 `send`），**老工具全部保留**——两份能力并存，用来灰度验证「AI 先列渠道再发」是否真的更好用                  | **P0 默认**               |
| `merge`  | 新增 `message`（含 `send`），已接入 hub 的渠道**隐藏其旧工具**（写入独立的 `hubMergedChannelTools` 名单，不动用户手选的 `disabledPluginTools`） | P1 默认（需一次确认弹窗） |

逃生门：任何被隐藏的旧工具在设置里一键恢复；hub 未接入的渠道（第三方新渠道）自动留在老档，**不阻塞生态**。

### 4.5 内置「消息」视图（已定：不做插件）

复用仓库已有的内置视图链路，不新造范式：

| 层       | 文件                                                                                                                   | 改动                                                                                                                                                   |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 条目注册 | `web/src/ui-slots.ts:149` `BUILTIN_UI_ITEMS`                                                                           | 加 `host:messages`，`view:"messages"`，`kind:"view"`，顶栏/底栏各一条。布局页勾选/调序免费拿到（`SettingsModal.tsx` 按 slot 全量渲染）                 |
| 视图类型 | `web/src/components/BarItem.tsx:54` `ViewName`                                                                         | 联合类型加 `"messages"`；底栏条目的未读徽标渲染                                                                                                        |
| 视图渲染 | `web/src/App.tsx:3374`（canvas）/`:3406`（devices）                                                                    | 加一段 `view-pane` + `DeferredMount active={view==="messages"}`；`handleViewChange`（`:2322`）放行；手机端 `setDrawer(...)` 分支照 devices/canvas 处理 |
| 组件     | `web/src/components/MessageCenter.tsx`（新）                                                                           | 两栏：渠道/联系人树 + 消息流 + 输入框；顶部 `proactive` 提示（QQ 显示"主动发送受限"）                                                                  |
| 数据面   | `server/protocol.ts`（协议单源）+ `server/index.ts` / `dispatch-domain-handlers.ts`（派发，仿 `:756 search_sessions`） | WS 只读查询 `message_hub` → `message_hub_result`（`reqId` 回显，不进快照）；动作 `message_hub_action`（send / markRead）                               |
| 文案     | `web/src/i18n/catalog.ts` + `web/src/i18n/messages/core/{zh,en}.json`                                                  | 新增 key 必须双语齐全（`i18n-catalog` 守卫）                                                                                                           |
| 样式     | `web/src/styles.css`                                                                                                   | `.mc-*` 一组，单文件主题基线；用既有色彩令牌，遵守对比度守卫                                                                                           |

**为什么内置更好**（相对插件形态）：AI 能力与界面同生命周期、不依赖插件安装顺序、可以用宿主自己的布局页/主题/i18n/移动端抽屉体系；代价是触碰到几个共享热点文件（`App.tsx` / `styles.css` / `protocol.ts` / i18n），**这些文件当前正被其它并行窗口修改，落地前要协调或串行**（见 §8）。

### 4.6 渠道 target 与发送能力映射（可行性论证的核心表）

| 渠道     | 平台目标                                   | `peerId` 构成                 | `proactive`                 | `history`      | 插件发送时仍要做的事                         |
| -------- | ------------------------------------------ | ----------------------------- | --------------------------- | -------------- | -------------------------------------------- |
| **飞书** | chat_id / open_id / email / webhook        | `feishu:<chat_id>`            | **`always`**（受范围/频控） | **`platform`** | 分块、卡片、Opus/MP4、thread reply           |
| QQ       | guild channel / user_openid / group_openid | `qq:<openid 或 channel_id>`   | **`windowed`**              | none           | 被动 msg_id→过期降级主动、富媒体、token 缓存 |
| WhatsApp | 手机号（MSISDN）                           | `whatsapp:<wa_id>`            | **`windowed`**              | none           | 24h 客户服务窗口、模板、multipart            |
| 企业微信 | webhook / chat_id                          | `wecom:<chat_id>`             | `webhook-only`              | none           | 文本/Markdown、回调适配器提示                |
| Telegram | chat_id / @username + forum topic          | `telegram:<chat_id>`          | `always`                    | none           | 分块、20MiB 校验、`message_thread_id`        |
| Discord  | channel_id                                 | `discord:<channel_id>`        | `always`                    | none           | multipart、Intent 缺失报错                   |
| Slack    | channel + thread_ts                        | `slack:<channel>:<thread_ts>` | `always`                    | none           | 外部上传 URL、files:write                    |
| 钉钉     | 群 / 单聊 / webhook                        | `dingtalk:<conversationId>`   | `always`                    | none           | AMR、封面 MP4                                |
| Matrix   | room_id + thread                           | `matrix:<room>:<thread>`      | `always`                    | none           | mxc 上传、E2EE 明确拒绝                      |
| iMessage | handle / 群 GUID                           | `imessage:<handle>`           | `always`                    | none           | AppleScript、macOS 权限                      |
| 微信通道 | wxid（仅私聊）                             | `wechat:<wxid>`               | `always`                    | none           | 已配对校验、媒体路径解析                     |

结论：**每个渠道都能映射**，且映射键就是"上一次收到消息时自然产生的那个 id"——不需要任何新的平台调用，也不需要用户手输 id。飞书是唯一 `history:"platform"` 的渠道，所以先接它就能同时验证"列表 / 收件箱 / 发送"三件事。

---

## 5. 数据与隐私

| 项       | 设计                                                                                                       | 理由                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 存储位置 | `<dataDir>/message-hub/messages.json` + `peers.json`                                                       | 宿主自管数据目录的既有惯例（同级还有 `plugin-inbox/`、`plugin-data/`）；不进项目目录 |
| 写入     | 原子写 + debounce（复用 `server/atomic-file.ts`，与 `plugin-ledger.ts` 同手法）                            | 崩溃最多丢几百毫秒，可接受                                                           |
| 保留     | 默认 30 天 / 每渠道 2000 条 / 正文截 4KB                                                                   | 无上限=数据无界增长；4KB 足够识别消息，全文按需 `read`；飞书可回补历史，不必全存     |
| 附件     | 只存 `{kind,name,size}` 引用，**不存字节**                                                                 | 避免消息中心变成第二个附件库（`details` ≤64KB 红线同理）                             |
| 脱敏     | token / bot 前缀 / `Bearer …` / 手机号中间四位 / 邮箱本地部分，统一在 `server/plugin-message-normalize.ts` | 消息中心是"所有渠道的明文汇聚点"，泄露面最大的地方必须是单点脱敏                     |
| 暴露面   | 新增 WS _ops 只走既有 loopback + Cookie 鉴权，不新增公网路由                                               | 与 `docs/architecture-core.md` 安全边界一致                                          |
| 能力开关 | `merge` 档需要一次明确确认（弹窗），且默认**禁止跨渠道转发**                                               | 防"AI 把飞书内容转发到别的群"这类不可撤销事故                                        |

---

## 6. 分期与验收

### P0a — 内核 + 工具 + 飞书单渠道（5–7 人日，零行为变化）

- 新增：`server/message-hub.ts`、`server/message-hub-store.ts`、`server/message-hub-tool.ts`、`server/plugin-message-normalize.ts`
- 契约：`plugin-sdk/index.d.ts` 的 `host.messaging.*`；`server/plugins.ts` 接线（`PluginManager` 注入，无注入时插件侧全部 no-op）
- 工具：`tool-manager.ts` 目录项 + `agent-service.ts` 注册（`tool-registration` 三处联动）
- **只接飞书**：adapter ≈80 行（`listPeers` / `readHistory` 直接复用现有 `chats/list/read`，`send` 复用现有 `POST /im/v1/messages`，`observe` 在入站回调加一行）
- 验收：
  1. `message({action:"channels"})` 返回飞书 + `proactive:"always"` + `history:"platform"`；工具总数从 1（原 `feishu`）变 2（`feishu` + `message`，`mirror` 档）
  2. AI 问"最近谁给我发消息"→ `inbox` 有记录且 `outcome` 正确；`read` 能取到飞书历史里的一条
  3. `send` 走 hub 与走老 `feishu` 工具**回执等价**（同 messageId、同失败文案）
  4. 停用飞书插件 → hub 自动 deregister，工具不再列出该渠道，**不报错**
  5. 旧行为回归：`tests/unit/channel-plugins.test.ts` 与飞书行为测试零改动通过

### P0b — 内置「消息」视图（5–7 人日）

- 按 §4.5 文件集接入；WS `message_hub` / `message_hub_result` / `message_hub_action` 在 `protocol.ts` 单源定义
- 验收：顶栏/底栏出现「消息」入口，布局页可隐藏/调序；面板能列渠道/联系人、读收件箱、发一条飞书消息；手机上不破版；`i18n-catalog` / 主题对比度 / overlay-stack 守卫通过

### P1 — 全量收编（8–12 人日）

- 其余 10 个渠道接 adapter；**QQ 接入时 `proactive:"windowed"` 必须在 `channels` 输出里可见**，UI 要给出"主动发送可能受限"的提示
- `merge` 档开关 + `hubMergedChannelTools` + 设置页恢复入口；渠道底栏徽标可汇总到内置「消息」徽标（布局页可恢复）
- 验收：装 10 个渠道时工具数 10 → 1；飞书/QQ 两种 `proactive` 在 UI 与工具输出里表现不同且都诚实

### P2 — 增值能力（可选）

- 跨渠道搜索、按联系人聚合的会话视图、面板内"回复到原会话"（仍由插件决定投递，hub 不直接 `prompt`/`steer`）
- 给飞书补 `rate_limited` 退避（hub 侧统一，不改平台语义）

---

## 7. 工作量与并行拆分

| 任务                    | 文件集（互不重叠）                                                                                                                                                                                                           | 估时              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| T1 宿主内核 + 契约      | `server/message-hub*.ts`、`server/plugin-message-normalize.ts`、`plugin-sdk/index.d.ts`、`server/plugins.ts`                                                                                                                 | 3 人日            |
| T2 工具目录与门控       | `server/tool-manager.ts`、`server/agent-service.ts`（注册点）、`web/src/i18n/messages/core/{zh,en}.json`（工具文案）、`tests/unit/tool-registration.test.ts`                                                                 | 1.5 人日          |
| T3 飞书 adapter         | `plugins/feishu/index.mjs`、`manifest.json`、`README.md`                                                                                                                                                                     | 0.5 人日          |
| T4 内置视图             | `web/src/components/MessageCenter.tsx`（新）、`web/src/App.tsx`、`web/src/components/BarItem.tsx`、`web/src/ui-slots.ts`、`web/src/styles.css`、`server/protocol.ts`、`server/index.ts`、`tests/unit/message-hub-ui.test.ts` | 6–8 人日          |
| T5 其它渠道 adapter ×10 | `plugins/<channel>/index.mjs` + `manifest.json` + `README.md`（每渠道独立）                                                                                                                                                  | 10 × 0.5 ≈ 5 人日 |
| T6 测试与守卫           | `tests/unit/message-hub*.test.ts`、`tests/message-hub-test.mjs`、`tests/run-smoke.mjs`                                                                                                                                       | 3 人日            |

**并行条件**：T1 先冻结 §4.2 契约（半天评审）；T3 依赖 T1；T4 依赖 T1 的 WS 投影形状；T5 可完全并行。**T1 / T2 / T4 都在共享热点文件上（插件宿主、协议、App、styles、i18n），建议一人顺序做完或明确错峰**——当前有其它窗口正在改这些文件。

---

## 8. 风险与对策

| 风险                                                 | 影响                        | 对策                                                                                      |
| ---------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| 目标地址统一无解                                     | AI 仍然发不出去             | 不统一：不透明 `peerId` + 目录查询；不做模糊匹配                                          |
| **渠道发送能力不等价（QQ 窗口/额度、WhatsApp 24h）** | AI 以为都能主动发，事后失败 | `proactive` 进契约与 `channels` 输出；`send` 失败带 `reason`；UI 明示；不承诺"随时可达"   |
| 平台历史不可读                                       | 用户以为能看到全部历史      | `capabilities.history` 诚实上报；飞书是 `platform` 并注明范围；其它渠道标"从这里开始记账" |
| 消息正文进了上下文                                   | 一次 `inbox` 就爆预算       | 默认 20 条 + 500 字符摘要 + cursor；全文要 `read`                                         |
| 双记账 / 重复发送                                    | 用户收到两条                | 幂等键 + `plugin-ledger` 同款去重；hub 不自己重试                                         |
| `merge` 档误伤第三方渠道                             | 生态插件被隐藏              | 只隐藏"已注册 adapter"的渠道；一键恢复；默认不隐藏                                        |
| 明文汇聚点泄露                                       | 所有渠道内容一次泄露        | 单点脱敏 + 保留上限 + 只存引用 + 默认禁跨渠道转发                                         |
| 触碰投递门（#929）                                   | 压缩期消息丢失/重复         | hub 全程旁路，不新增 `host.chat` 字段、不直连 `sendUserMessage`/`steer`                   |
| **内置视图改共享热点文件**                           | 与并行窗口冲突、守卫失败    | 落地前错峰；`App.tsx`/`styles.css`/`protocol.ts`/i18n 由一人集中改；CI 守卫逐项过         |
| 11 个插件版本号漏递增                                | 守卫失败                    | `plugin-version-bump-guard` 已在 CI；每个 adapter PR 单独递增                             |

---

## 9. 明确不做（Non-goals）

1. **不做平台历史全量回放**（飞书可按其 API 回补，其它渠道做不到；不承诺全局一致）。
2. **不合并各渠道的会话/epoch/路由状态**——`/new` 代次、runId 归属、白名单判定仍归插件。
3. **不接管系统通知/推送**（`host.notify`、手机推送保持现状）。
4. **不把 10 份 `markdown-chunks.mjs` 合并**（独立安装约束；合并属于另一个专项）。
5. **不让 hub 直接对会话 `prompt`/`steer`**（红线 `delivery-gate-single-source`）。
6. **不做"能读所有渠道私有数据"的万能工具**——hub 只暴露收件箱与发送，不暴露平台账号凭据。
7. **不为 QQ 的主动消息额度做"自动攒额度/定时补发"**——平台配额不可绕过，只做诚实提示。

---

## 10. 决策状态

| #   | 决策                 | 状态     | 结论                                                                                                               |
| --- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| D1  | 统一工具名           | 待定     | 建议 `message`（与 `conversation`/`terminal`/`sftp` 同风格；`ALL_KNOWN_SET` 无冲突）                               |
| D2  | 首个渠道             | **已定** | **飞书**：唯一同时具备 `chats/list/read/search/send/reply` 与无被动窗口的渠道；QQ 排到 P1 并以 `windowed` 能力接入 |
| D3  | 面板形态             | **已定** | **内置视图**（`view:"messages"` + `BUILTIN_UI_ITEMS`），不做插件                                                   |
| D4  | 保留策略默认值       | 待定     | 建议 30 天 / 2000 条/渠道 / 正文 4KB                                                                               |
| D5  | `merge` 档何时默认开 | 待定     | 建议 P1 末、飞书 + QQ 双渠道稳定后再开，且需一次确认弹窗                                                           |

---

## 附录 A：一页纸 MVP（如果只想先花 1 天验证价值）

只做三件事，不动内置 UI：

1. `server/message-hub.ts` 骨架 + `host.messaging.registerChannel`（空实现也生效）；
2. 宿主 `message` 工具，只支持 `action=channels` + `inbox`，渠道清单靠 manifest 的 `chat`/`tools` 权限与工具名推导（**零改造**，是近似值，够验证体验）；
3. 飞书入站回调加一行 `host.messaging.observe(...)`，复用它已有的 `chats/list/read`。

一天后你就能对着 AI 问"我现在有哪些消息渠道？飞书最近谁给我发过消息？"——这是整件事的 80% 体验价值，内置面板随后按 P0b 接上。
