[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 額度看板（Quota Watch）

一屏看清**當前供應商**還剩多少額度。外掛在**服務端**讀本機已有的 CLI 登入態，再向廠商介面查額度，
瀏覽器只負責畫卡片 —— 憑據不下發、不上傳、不落盤。

> 視角是單一的：**當前會話的模型屬於哪家，就只查哪家、只顯示哪家**。
> 別家的訂閱即使在本機登入著也不會被請求 —— 底欄 60s 輪詢一次，為不相干的來源出網既慢又容易撞限流，
> 而你要看的永遠是當前模型那一家。想看別家？切到那個模型即可。

## 支援哪些來源

| 平臺                  | 憑據（自動探測）                                | 介面                                 | 展示                         |
| --------------------- | ----------------------------------------------- | ------------------------------------ | ---------------------------- |
| Claude Code           | `~/.claude/.credentials.json`                   | `api.anthropic.com/api/oauth/usage`  | 5 小時 / 每週 / 分模型視窗   |
| Codex（ChatGPT 訂閱） | `~/.codex/auth.json`                            | `chatgpt.com/backend-api/wham/usage` | 主 / 次視窗 + 贈送額度       |
| DeepSeek              | 設定裡填 API Key，或環境變數 `DEEPSEEK_API_KEY` | `api.deepseek.com/user/balance`      | 賬戶餘額（贈送 / 充值拆分）  |
| OpenCode（Go 訂閱）   | 本機 pi 已存的 opencode 憑據，或設定裡填 Key    | `opencode.ai/console/api/go/status`  | 5 小時 / 每週 / 每月剩餘額度 |

「自動探測」的含義：你只要在對應 CLI / IDE 裡登入過，外掛就能查到，**不需要再填任何東西**。
登入態過期時外掛在記憶體裡用 refresh_token 續期，**不會改寫**你的憑據檔案。
每張憑據只會被「當前模型就屬於它」這一個條件喚起。

## 使用

1. 裝好外掛後，底欄「當前對話費用」後面會多一段 `$0.8201 / DS ¥14.46`；**點它就在旁邊彈一張小卡片**
   （只畫當前供應商：餘額大字 + 贈送/充值拆分 + 重置倒計時，`⟳` 強制重新整理，點外面 / Esc 關掉）。
   沒有頂欄 tab、沒有全屏看板 —— 看完即走，不把使用者從對話裡踢出去。
2. 設定 → 外掛 → 額度看板：可關掉不想要的來源（關掉 = 即使當前模型是那家也不請求）、填 DeepSeek Key、改快取時長。
3. 讓 AI 查額度：內建工具 `quota_status`（`action=status`，可選 `refresh=true` 繞過快取），
   模型會在你問「我還有多少額度」時自己呼叫 —— 同樣只答當前供應商。

## 為什麼這些介面能查到訂閱額度

這些平臺給官方 CLI / IDE 用的就是這幾條介面，外掛的做法與客戶端一致：

- **Claude Code**：`api/oauth/usage` 返回 `five_hour` / `seven_day` / `seven_day_opus` 的 `utilization`
  與 `resets_at`；token 過期用 Claude Code 的公開 OAuth 客戶端續期。
- **Codex**：`backend-api/wham/usage` 返回 `rate_limit.primary_window` / `secondary_window` 的
  `used_percent`、`limit_window_seconds`、`reset_at`，以及 `credits`。
- **DeepSeek**：只有餘額介面，沒有訂閱視窗，所以卡片只展示餘額數字（附贈送 / 充值拆分），不畫進度條 ——
  餘額的「百分比」沒有語義。
- **OpenCode**：`console/api/go/status` 返回訂閱三檔用量計（`access.meters` 的 `fiveHour` / `week` / `month`，
  微美分 `usedMicroCents / limitMicroCents`），外掛換算成剩餘百分比 + `resetsAt` 倒計時。
  免費模型（Iceman Contributor Free 等）在 Go 表裡是 Unlimited，不佔訂閱視窗 —— 顯示的永遠是賬號維度的剩餘額度。
  沒有訂閱視窗的賬號降級為只展示本機登入態列表。

介面是各傢俬有但穩定的 CLI 通道，任何一個平臺改協議時，外掛會顯示「查詢失敗 + 原因」而不是靜默消失。

## 底欄狀態板（斜槓接在「當前對話費用」後面，自動識別當前供應商）

底欄那段文本**不是外掛自己的 chip**：外掛通過 `window.__piWebUiHost.setFooterStatus()` 把文本交給宿主，
宿主把它嵌進**內建費用格**裡、用斜槓接續 —— 也就是

```
347.1K / 1M   1128   $0.8201 / DS ¥14.46   99.2%   ⚡SoL-Pi 省 28.9M …
```

- 嵌在費用格里而不是另立一個底欄條目：使用者在「介面佈局」裡排過底欄順序，獨立條目的 `order`
  保證不了相鄰；嵌進同一格就永遠緊貼，也沒有孤立的斜槓（無資料時整段不渲染）。
- 內容跟著**當前會話的模型**走（`badge.mjs` 的 `providerFromModel`），**只顯示這一家**：

  | 當前模型                                   | 識別到的來源 | 顯示                |
  | ------------------------------------------ | ------------ | ------------------- |
  | `auto/deepseek-v4.1-flash`、`*/deepseek-*` | DeepSeek     | `DS ¥15.82`（餘額） |
  | `*/claude-sonnet-4`、`*anthropic*`         | Claude Code  | `CL 58%`            |
  | `*/gpt-5.1-codex`、`*codex*`、`*/o3-*`     | Codex        | `CX 12.3%`          |

- 只有一段文字，沒有「當前 + 最緊」這類多來源模式：別家不會出網查詢，也就沒有數字可並排。
  認不出模型（自建模型 / 關掉了對應開關）時**整段不渲染** —— 不留 `額度 --` 這種既佔地方又沒資訊的殘片。
- 當前這家自己壞著時照樣顯示故障碼：`⇅` 網路不可達、`≠` 登入失效、`!` 查詢失敗、`—` 未登入 ——
  當前供應商掛了正是最該知道的事。
- **點它彈的跟隨浮層是宿主渲染的，外掛只給內容**：`setFooterStatus(key, { text, tip, content: { render } })`，
  `render(container)` 往宿主給的容器裡畫那幾行（`client/card.mjs`，引用要穩定 —— 宿主按引用比較，
  每次輪詢新建會讓開著的卡片重掛）。
  外殼歸宿主（`web/src/components/FooterSlotPopover.tsx` + `use-floating-panel`）：預設貼錨點**上方**、
  塞不下翻到下方、右對齊後夾進視口，滾動 / 改視窗尺寸跟著重新定位，點外面 / Esc / 再點一次那段文字關閉，
  錨點消失即關，`z-index: 9000`（壓過底欄、低於模態），列表區最高 `min(52vh, 320px)` 可滾、`prefers-reduced-motion`
  下不出場動畫。**需要宿主 API ≥ 18**（`content` 能力）；更老的宿主會忽略它，底欄只剩文字 + tooltip。
  外掛自己**不寫** `position: fixed` / z-index / 外層陰影 —— 浮層角色屬於認識錨點的那一方。
- **網路失敗不當成登入失敗**：`fetch failed` / TLS / 超時判為 `network`（`⇅`），提示「開代理/VPN 後重新整理」，
  同時**立刻停手**，不會拿同一個死域名把多個賬號挨個撞一遍（以前燒掉 40s）。單次探測總預算 20s，
  額度請求 8s、檔位 5s，成功過的域名會被記住排最前。
- 節拍：客戶端（`preload: true`）訂閱**唯一一份快照**（見下節），閒著 60s 一次、浮層開著 15s 一次，
  視窗重新聚焦時立即補一次；外掛停用/解除安裝時宿主清掉它寫的槽（`clearFooterStatusesOf`）。

## 重新整理鏈路：一份快照，兩個檢視

舊實現裡底欄文本與浮層**各拉一次** `/summary`、各持一個時間戳，於是出現了最刺眼的一種 bug：
在彈窗裡點了 `⟳`，浮層變了，**底欄那格要等到下一個整分鐘才變** —— 使用者看到的結論就是「重新整理沒用」。

現在只有一條鏈：

```
        /summary  ──►  client/store.mjs（唯一來源，去重 in-flight）
                            │
                 ┌──────────┴──────────┐
           底欄 host:quota        浮層卡片 content.render
```

- `client/store.mjs`：一次重新整理 = 一次請求 + 通知所有訂閱者。浮層裡點 `⟳` 走的就是這裡，
  所以**底欄與卡片在同一幀更新**；同時刻只有一個請求在飛，兩邊撞在一起時後者複用前者的結果。
- 節奏：`hold()` 的持有者 > 0（浮層開著）時 15s，否則 60s；頁面不可見時不發請求。
- **TTL 分檔**（服務端 `index.mjs`）：訂閱視窗（Claude / Codex）按設定裡的分鐘數，
  預設 5 分鐘；餘額型（DeepSeek）固定 **60 秒** —— 餘額每發一次請求就變，5 分鐘快取太鈍，
  這正是「餘額更新不及時」的根因。
- **可見的新鮮度**：`/summary` 多返回 `updatedAt / staleMs / ttlMs / lastGoodAt`，卡片的
  「剛剛 / 12 秒前」每秒自己在走，超過 TTL 自動轉琥珀色並標「陳舊」；`⟳` 外圈那道環就是
  距下次自動重新整理的進度，不用猜。
- **失敗不抹數字**：採集失敗時服務端把上次成功讀到的餘額/視窗帶回來，並標 `stale + staleSince`，
  卡片顯示「數值來自上次成功讀取 · 5 分鐘前」；底欄徽標仍然是故障碼（`⇅`/`!`），不偽造一個健康的餘額。
- 卡片排版（`client/card.mjs` + `client/styles.mjs`）：主數字 26px、拆分退成 chips、低餘額（≤¥5）整卡轉紅、
  餘額變化時做一次 1 秒底色脈衝；訂閱型沒有餘額主數字，新鮮度改擺在頭部，視窗進度條照舊。

## 協議是怎麼驗證的（沒有真登入也能驗）

廠商的私有介面沒法查文件，所以用**錯誤碼當證據**：請求形狀對、client_id 對，伺服器才會回特定錯誤。

| 探測                                                         | 真實返回                                                      | 結論                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------- |
| Anthropic refresh（client `9d1c250a…` + 亂編 refresh token） | `400 invalid_grant`                                           | 端點 / client_id / body 全對（形狀錯會是 4xx invalid_request） |
| Anthropic refresh（亂編 client_id）                          | `400 Client with id … not found`                              | 反向對照：上面那條 `invalid_grant` 才有意義                    |
| `api/oauth/usage`（假 bearer）                               | `401 authentication_error: OAuth access token is invalid.`    | 端點存在，`anthropic-beta` 不被拒                              |
| OpenAI refresh（`app_EMoam…` + 亂編 token）                  | `401 code: token_expired`                                     | client_id 正確                                                 |
| OpenAI refresh（亂編 client_id）                             | `401 code: invalid_client`                                    | 反向對照                                                       |
| `backend-api/wham/usage`、`codex/usage`（假 bearer）         | `401 {"detail":"Could not parse your authentication token…"}` | 兩條 usage 端點都真實存在                                      |

這些錯誤碼同時被 `providers/util.mjs` 的 `needsReauth()` 直接消費 —— 「登入態失效」判定不靠猜 HTTP 狀態，
而是認 `invalid_grant` / `token_expired` / `invalid_client` / `authentication_error`，網路故障不會被誤報成「請重新登入」。

解析側對結構漂移有兩層防禦：視窗長度收 `limit_window_seconds` / `window_minutes` 兩種寫法；主路徑解析
不出視窗時，按「任意 `*window*` 物件帶 `used_percent`」做一次限深掃描兜底（限 4 個視窗，避免把怪結構讀成假資料）。

## 同類開源專案對照（2026-11）

做這個外掛前先查過：這件事已有不少成熟實現，欄位名與介面形狀就是照它們交叉校準的。

| 專案                                                                                                            | ★     | 形態                  | 覆蓋                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ----- | --------------------- | ---------------------------------------------------------------------------------------------------------- |
| [steipete/CodexBar](https://github.com/steipete/CodexBar)                                                       | 23k   | macOS 選單欄（Swift） | Codex + Claude Code，**免登入**複用本機登入態 —— 本外掛的 Codex/Claude 欄位名與 OAuth 形狀即以其原始碼為準 |
| [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)                                           | 19.8k | 桌面端（Rust）        | Antigravity / Codex / Copilot / Cursor 等賬號管理與配額                                                    |
| [jlcodes99/vscode-antigravity-cockpit](https://github.com/jlcodes99/vscode-antigravity-cockpit)                 | 4.8k  | VS Code 擴充套件      | 只做 Antigravity 配額看板                                                                                  |
| [nguyenphutrong/quotio](https://github.com/nguyenphutrong/quotio)                                               | 4.9k  | macOS 選單欄（Rust）  | 多家訂閱賬號統一看板                                                                                       |
| [Javis603/token-monitor](https://github.com/Javis603/token-monitor)                                             | 3.6k  | 桌面小元件（JS）      | 52+ 程式設計工具 token / 成本 / 限額                                                                       |
| [wusimpl/AntigravityQuotaWatcher](https://github.com/wusimpl/AntigravityQuotaWatcher)                           | 2.2k  | 瀏覽器/編輯器外掛     | Antigravity 模型配額                                                                                       |
| [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)       | 8.8k  | 終端監控（Python）    | Claude Code 用量、預測與告警                                                                               |
| [Dicklesworthstone/coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) | 91    | CLI（Rust）           | 16+ provider 統一查詢                                                                                      |

差異：這些都是**獨立應用或 CLI**，要另裝、另起程序，`pi-web-ui` 裡看不到。本外掛是宿主內外掛 ——
不額外裝任何東西，額度直接進對話介面，並且模型自己能用 `quota_status` 工具查。代價是隻在本宿主裡可用。

## 許可權

`ui`（檢視）、`http`（外掛自己的 HTTP 路由）、`net`（出站，僅 manifest 中 `netAllowlist` 列出的主機）。
服務端程式碼用 `node:fs` 讀本機憑據檔案 —— 這是外掛的既有許可權模型（設定面板裡可隨時停用）。

## 迴歸

```bash
npx vitest run tests/unit/quota-watch.test.ts tests/unit/quota-watch-card.test.ts
```

覆蓋：manifest 形狀、三個 provider 的請求與解析（含視窗歸一化）、access token 過期續期、
401 重試、無登入態的降級、本機 pi 憑據兜底、**只查當前供應商**（別家不出網 / 關掉開關不出網 / 認不出模型不出網）、
徽標與 tooltip 的單供應商文案、AI 摘要文案；**重新整理鏈路**（TTL 分檔、失敗保留上次成功的數字、
兩張卡共用一份快照且重新整理後同時更新、浮層關掉後輪詢回到慢檔）；卡片內容（餘額/視窗/空態/陳舊態/強制重新整理/清理）。
浮層外殼的定位與開合由宿主負責，迴歸在 `tests/unit/footer-slot-popover.test.ts`（`FooterBar` 裡點那段文字 → 浮層 + 清理）
與 `tests/unit/floating-panel.test.ts`（`computeFloatingPosition` 的翻轉/鉗制）。
