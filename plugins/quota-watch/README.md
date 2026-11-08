# 额度看板（Quota Watch）

一屏看清**当前供应商**还剩多少额度。插件在**服务端**读本机已有的 CLI 登录态，再向厂商接口查额度，
浏览器只负责画卡片 —— 凭据不下发、不上传、不落盘。

> 视角是单一的：**当前会话的模型属于哪家，就只查哪家、只显示哪家**。
> 别家的订阅即使在本机登录着也不会被请求 —— 底栏 60s 轮询一次，为不相干的来源出网既慢又容易撞限流，
> 而你要看的永远是当前模型那一家。想看别家？切到那个模型即可。

## 支持哪些来源

| 平台                                 | 凭据（自动探测）                                                                            | 接口                                                                    | 展示                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| Antigravity（反重力，IDE + agy CLI） | `~/.gemini/antigravity-cli/antigravity-oauth-token`、`~/.antigravity_tools/accounts/*.json` | `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` | 每周 / 5 小时窗口剩余百分比 + 重置时间 + 订阅档位 |
| Claude Code                          | `~/.claude/.credentials.json`                                                               | `api.anthropic.com/api/oauth/usage`                                     | 5 小时 / 每周 / 分模型窗口                        |
| Codex（ChatGPT 订阅）                | `~/.codex/auth.json`                                                                        | `chatgpt.com/backend-api/wham/usage`                                    | 主 / 次窗口 + 赠送额度                            |
| DeepSeek                             | 设置里填 API Key，或环境变量 `DEEPSEEK_API_KEY`                                             | `api.deepseek.com/user/balance`                                         | 账户余额（赠送 / 充值拆分）                       |

「自动探测」的含义：你只要在对应 CLI / IDE 里登录过，插件就能查到，**不需要再填任何东西**。
登录态过期时插件在内存里用 refresh_token 续期，**不会改写**你的凭据文件。
每张凭据只会被「当前模型就属于它」这一个条件唤起。

## 使用

1. 装好插件后，底栏「当前对话费用」后面会多一段 `$0.8201 / DS ¥14.46`；**点它就在旁边弹一张小卡片**
   （只画当前供应商：余额大字 + 赠送/充值拆分 + 重置倒计时，`⟳` 强制刷新，点外面 / Esc 关掉）。
   没有顶栏 tab、没有全屏看板 —— 看完即走，不把用户从对话里踢出去。
2. 设置 → 插件 → 额度看板：可关掉不想要的来源（关掉 = 即使当前模型是那家也不请求）、填 DeepSeek Key、改缓存时长。
3. 让 AI 查额度：内置工具 `quota_status`（`action=status`，可选 `refresh=true` 绕过缓存），
   模型会在你问「我还有多少额度」时自己调用 —— 同样只答当前供应商。

## 为什么这些接口能查到订阅额度

这些平台给官方 CLI / IDE 用的就是这几条接口，插件的做法与客户端一致：

- **Antigravity**：用官方 `agy` 客户端内置的 Google OAuth 公开客户端换取 access token，再调客户端的
  `retrieveUserQuotaSummary`（返回 `groups[].buckets[].remainingFraction` 与 `resetTime`）。
- **Claude Code**：`api/oauth/usage` 返回 `five_hour` / `seven_day` / `seven_day_opus` 的 `utilization`
  与 `resets_at`；token 过期用 Claude Code 的公开 OAuth 客户端续期。
- **Codex**：`backend-api/wham/usage` 返回 `rate_limit.primary_window` / `secondary_window` 的
  `used_percent`、`limit_window_seconds`、`reset_at`，以及 `credits`。
- **DeepSeek**：只有余额接口，没有订阅窗口，所以卡片只展示余额数字（附赠送 / 充值拆分），不画进度条 ——
  余额的「百分比」没有语义。

接口是各家私有但稳定的 CLI 通道，任何一个平台改协议时，插件会显示「查询失败 + 原因」而不是静默消失。

## 底栏状态板（斜杠接在「当前对话费用」后面，自动识别当前供应商）

底栏那段文本**不是插件自己的 chip**：插件通过 `window.__piWebUiHost.setFooterStatus()` 把文本交给宿主，
宿主把它嵌进**内置费用格**里、用斜杠接续 —— 也就是

```
347.1K / 1M   1128   $0.8201 / DS ¥14.46   99.2%   ⚡SoL-Pi 省 28.9M …
```

- 嵌在费用格里而不是另立一个底栏条目：用户在「界面布局」里排过底栏顺序，独立条目的 `order`
  保证不了相邻；嵌进同一格就永远紧贴，也没有孤立的斜杠（无数据时整段不渲染）。
- 内容跟着**当前会话的模型**走（`badge.mjs` 的 `providerFromModel`），**只显示这一家**：

  | 当前模型                                   | 识别到的来源 | 显示                |
  | ------------------------------------------ | ------------ | ------------------- |
  | `auto/deepseek-v4.1-flash`、`*/deepseek-*` | DeepSeek     | `DS ¥15.82`（余额） |
  | `*/claude-sonnet-4`、`*anthropic*`         | Claude Code  | `CL 58%`            |
  | `*/gpt-5.1-codex`、`*codex*`、`*/o3-*`     | Codex        | `CX 12.3%`          |
  | `*/gemini-3-pro`、`*antigravity*`          | Antigravity  | `AG 100%`           |

- 只有一段文字，没有「当前 + 最紧」这类多来源模式：别家不会出网查询，也就没有数字可并排。
  认不出模型（自建模型 / 关掉了对应开关）时**整段不渲染** —— 不留 `额度 --` 这种既占地方又没信息的残片。
- 当前这家自己坏着时照样显示故障码：`⇅` 网络不可达、`≠` 登录失效、`!` 查询失败、`—` 未登录 ——
  当前供应商挂了正是最该知道的事。
- **点它弹的跟随浮层是宿主渲染的，插件只给内容**：`setFooterStatus(key, { text, tip, content: { render } })`，
  `render(container)` 往宿主给的容器里画那几行（`client/card.mjs`，引用要稳定 —— 宿主按引用比较，
  每次轮询新建会让开着的卡片重挂）。
  外壳归宿主（`web/src/components/FooterSlotPopover.tsx` + `use-floating-panel`）：默认贴锚点**上方**、
  塞不下翻到下方、右对齐后夹进视口，滚动 / 改窗口尺寸跟着重新定位，点外面 / Esc / 再点一次那段文字关闭，
  锚点消失即关，`z-index: 9000`（压过底栏、低于模态），列表区最高 `min(52vh, 320px)` 可滚、`prefers-reduced-motion`
  下不出场动画。**需要宿主 API ≥ 18**（`content` 能力）；更老的宿主会忽略它，底栏只剩文字 + tooltip。
  插件自己**不写** `position: fixed` / z-index / 外层阴影 —— 浮层角色属于认识锚点的那一方。
- **网络失败不当成登录失败**：`fetch failed` / TLS / 超时判为 `network`（`⇅`），提示「开代理/VPN 后刷新」，
  同时**立刻停手**，不会拿同一个死域名把多个账号挨个撞一遍（以前烧掉 40s）。单次探测总预算 20s，
  额度请求 8s、档位 5s，成功过的域名会被记住排最前。
- 节拍：客户端（`preload: true`）订阅**唯一一份快照**（见下节），闲着 60s 一次、浮层开着 15s 一次，
  窗口重新聚焦时立即补一次；插件停用/卸载时宿主清掉它写的槽（`clearFooterStatusesOf`）。

## 刷新链路：一份快照，两个视图

旧实现里底栏文本与浮层**各拉一次** `/summary`、各持一个时间戳，于是出现了最刺眼的一种 bug：
在弹窗里点了 `⟳`，浮层变了，**底栏那格要等到下一个整分钟才变** —— 用户看到的结论就是「刷新没用」。

现在只有一条链：

```
        /summary  ──►  client/store.mjs（唯一来源，去重 in-flight）
                            │
                 ┌──────────┴──────────┐
           底栏 host:quota        浮层卡片 content.render
```

- `client/store.mjs`：一次刷新 = 一次请求 + 通知所有订阅者。浮层里点 `⟳` 走的就是这里，
  所以**底栏与卡片在同一帧更新**；同时刻只有一个请求在飞，两边撞在一起时后者复用前者的结果。
- 节奏：`hold()` 的持有者 > 0（浮层开着）时 15s，否则 60s；页面不可见时不发请求。
- **TTL 分档**（服务端 `index.mjs`）：订阅窗口（Antigravity / Claude / Codex）按设置里的分钟数，
  默认 5 分钟；余额型（DeepSeek）固定 **60 秒** —— 余额每发一次请求就变，5 分钟缓存太钝，
  这正是「余额更新不及时」的根因。
- **可见的新鲜度**：`/summary` 多返回 `updatedAt / staleMs / ttlMs / lastGoodAt`，卡片的
  「刚刚 / 12 秒前」每秒自己在走，超过 TTL 自动转琥珀色并标「陈旧」；`⟳` 外圈那道环就是
  距下次自动刷新的进度，不用猜。
- **失败不抹数字**：采集失败时服务端把上次成功读到的余额/窗口带回来，并标 `stale + staleSince`，
  卡片显示「数值来自上次成功读取 · 5 分钟前」；底栏徽标仍然是故障码（`⇅`/`!`），不伪造一个健康的余额。
- 卡片排版（`client/card.mjs` + `client/styles.mjs`）：主数字 26px、拆分退成 chips、低余额（≤¥5）整卡转红、
  余额变化时做一次 1 秒底色脉冲；订阅型没有余额主数字，新鲜度改摆在头部，窗口进度条照旧。

## 协议是怎么验证的（没有真登录也能验）

厂商的私有接口没法查文档，所以用**错误码当证据**：请求形状对、client_id 对，服务器才会回特定错误。

| 探测                                                         | 真实返回                                                      | 结论                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Anthropic refresh（client `9d1c250a…` + 乱编 refresh token） | `400 invalid_grant`                                           | 端点 / client_id / body 全对（形状错会是 4xx invalid_request） |
| Anthropic refresh（乱编 client_id）                          | `400 Client with id … not found`                              | 反向对照：上面那条 `invalid_grant` 才有意义                    |
| `api/oauth/usage`（假 bearer）                               | `401 authentication_error: OAuth access token is invalid.`    | 端点存在，`anthropic-beta` 不被拒                              |
| OpenAI refresh（`app_EMoam…` + 乱编 token）                  | `401 code: token_expired`                                     | client_id 正确                                                 |
| OpenAI refresh（乱编 client_id）                             | `401 code: invalid_client`                                    | 反向对照                                                       |
| `backend-api/wham/usage`、`codex/usage`（假 bearer）         | `401 {"detail":"Could not parse your authentication token…"}` | 两条 usage 端点都真实存在                                      |

这些错误码同时被 `providers/util.mjs` 的 `needsReauth()` 直接消费 —— 「登录态失效」判定不靠猜 HTTP 状态，
而是认 `invalid_grant` / `token_expired` / `invalid_client` / `authentication_error`，网络故障不会被误报成「请重新登录」。

解析侧对结构漂移有两层防御：窗口长度收 `limit_window_seconds` / `window_minutes` 两种写法；主路径解析
不出窗口时，按「任意 `*window*` 对象带 `used_percent`」做一次限深扫描兜底（限 4 个窗口，避免把怪结构读成假数据）。

## 同类开源项目对照（2026-11）

做这个插件前先查过：这件事已有不少成熟实现，字段名与接口形状就是照它们交叉校准的。

| 项目                                                                                                            | ★     | 形态                  | 覆盖                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ----- | --------------------- | -------------------------------------------------------------------------------------------------------- |
| [steipete/CodexBar](https://github.com/steipete/CodexBar)                                                       | 23k   | macOS 菜单栏（Swift） | Codex + Claude Code，**免登录**复用本机登录态 —— 本插件的 Codex/Claude 字段名与 OAuth 形状即以其源码为准 |
| [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)                                           | 19.8k | 桌面端（Rust）        | Antigravity / Codex / Copilot / Cursor 等账号管理与配额                                                  |
| [jlcodes99/vscode-antigravity-cockpit](https://github.com/jlcodes99/vscode-antigravity-cockpit)                 | 4.8k  | VS Code 扩展          | 只做 Antigravity 配额看板                                                                                |
| [nguyenphutrong/quotio](https://github.com/nguyenphutrong/quotio)                                               | 4.9k  | macOS 菜单栏（Rust）  | 多家订阅账号统一看板                                                                                     |
| [Javis603/token-monitor](https://github.com/Javis603/token-monitor)                                             | 3.6k  | 桌面小组件（JS）      | 52+ 编程工具 token / 成本 / 限额                                                                         |
| [wusimpl/AntigravityQuotaWatcher](https://github.com/wusimpl/AntigravityQuotaWatcher)                           | 2.2k  | 浏览器/编辑器插件     | Antigravity 模型配额                                                                                     |
| [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)       | 8.8k  | 终端监控（Python）    | Claude Code 用量、预测与告警                                                                             |
| [Dicklesworthstone/coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) | 91    | CLI（Rust）           | 16+ provider 统一查询                                                                                    |

差异：这些都是**独立应用或 CLI**，要另装、另起进程，`pi-web-ui` 里看不到。本插件是宿主内插件 ——
不额外装任何东西，额度直接进对话界面，并且模型自己能用 `quota_status` 工具查。代价是只在本宿主里可用。

## 权限

`ui`（视图）、`http`（插件自己的 HTTP 路由）、`net`（出站，仅 manifest 中 `netAllowlist` 列出的主机）。
服务端代码用 `node:fs` 读本机凭据文件 —— 这是插件的既有权限模型（设置面板里可随时停用）。

## 回归

```bash
npx vitest run tests/unit/quota-watch.test.ts tests/unit/quota-watch-card.test.ts
```

覆盖：manifest 形状、四个 provider 的请求与解析（含窗口归一化）、access token 过期续期、
401 重试、无登录态的降级、本机 pi 凭据兜底、**只查当前供应商**（别家不出网 / 关掉开关不出网 / 认不出模型不出网）、
徽标与 tooltip 的单供应商文案、AI 摘要文案；**刷新链路**（TTL 分档、失败保留上次成功的数字、
两张卡共用一份快照且刷新后同时更新、浮层关掉后轮询回到慢档）；卡片内容（余额/窗口/空态/陈旧态/强制刷新/清理）。
浮层外壳的定位与开合由宿主负责，回归在 `tests/unit/footer-slot-popover.test.ts`（`FooterBar` 里点那段文字 → 浮层 + 清理）
与 `tests/unit/floating-panel.test.ts`（`computeFloatingPosition` 的翻转/钳制）。
