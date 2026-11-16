[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 內建外部渠道模組（Superagent 0.1.5）

GitHub / 飛書的內建渠道適配模組。將驗證過的外部事件交給宿主工單服務，由**群組獨立 AI Router 路由、Bot 執行**，再通過宿主持久 outbox 回寫原渠道。外掛不包含自己的 LLM、執行器或路由器。

後臺回寫只輪詢已配置房間對映與傳送憑據的渠道：GitHub 需要 API Token，飛書需要 App ID 和 App Secret。未配置時保持空閒，補全配置後自動恢復輪詢，無需重啟。正常每輪結束後等待 15 秒；宿主 outbox 呼叫失敗時指數退避，重試間隔最長 5 分鐘，每輪持續故障只警告一次，成功恢復後記錄一次。警告僅包含可用的 HTTP 狀態碼與連線排查提示，不輸出上游響應或金鑰。

實現獨立編寫，沒有複製 `dsh-superagent-prototype` 原始碼或引入其依賴。

## 內建入口與宿主要求

Superagent 隨 pi-web-ui 主程式提供，首次啟動自動準備並載入，無需另行下載或執行安裝命令。從 **裝置連線與跨平臺協作 → 外部渠道** 進入配置，不再提供獨立 Superagent 頂欄入口。預設觀察模式，填寫渠道憑據和房間對映後接收事件。

這是宿主內建功能，不出現在外掛市場、已安裝列表、外掛選單、佈局編輯或啟停開關中，也不能經普通外掛安裝 / 更新 / 解除安裝介面管理。內部複用外掛宿主的隔離與路由能力，程式碼隨主程序升級同步，金鑰和設定保留。舊的外掛停用或解除安裝記錄不會阻止內建渠道載入；模組檔案缺失時由宿主在下次掃描準備。要暫停自動執行，將渠道設為 observe 或移除對應對映。

外掛目錄包含 `manifest.json`、`server.mjs`、`main.mjs`、`style.css`，以及相容宿主固定發現規則的 `index.mjs` / `client/entry.mjs`。客戶端入口通過外掛自己的資源路由載入頁面，相容應用子路徑部署。無額外 npm 依賴。

要求宿主提供：

- `host.route(method, path, handler)`，請求具備原始 **Buffer** `req.rawBody`，不能從已解析 JSON 重新構造；入站上限 1 MiB。
- `host.storage.get/set` 和加密 `host.secrets.get/set/delete`。配置只儲存 secret 是否存在的狀態，金鑰明文只交給加密儲存。
- `host.fetch`（或 Node fetch），支援標準 Response；外掛測試注入 fetch，不訪問真實渠道。
- `host.workItems`，由宿主隔離外掛 connector 身份，要求 `chat` 許可權；介面見下表。
- 宿主在主站認證前精確公開兩條 `POST /api/superagent/webhooks/github`、`POST /api/superagent/webhooks/feishu`，轉發給外掛 `/webhooks/github` / `/webhooks/feishu`。這兩條入口只接受渠道驗證；配置和管理路由繼續受主站認證保護。宿主 API 未安裝或原始位元組不可用時拒絕接收，不降級為不驗籤。

| 宿主介面                                        | 返回值 / 約定                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| `rooms()`                                       | `[{id,name?}]`，用於配置對映                                                |
| `ingest(input)`                                 | 工單；持久去重鍵為 provider + eventId，同 ID 不同內容拒絕，重放不提升許可權 |
| `list({roomId?})`                               | 工單陣列                                                                    |
| `get(id)`                                       | 工單或 undefined                                                            |
| `update(id, patch)`                             | 更新後的工單；顯式 `authorized:true` 表示人工授權，false 表示撤權           |
| `claimDelivery({provider,limit?})`              | delivery 陣列，原子領取並附帶租約                                           |
| `completeDelivery(id,{leaseToken,externalId?})` | 租約確認                                                                    |
| `failDelivery(id,{leaseToken,error})`           | 租約失敗記錄，宿主負責退避和後續重新領取                                    |

`ingest` 輸入：`{provider,channelId,threadId,eventId,title,text,authorId,kind,roomId,mode,authorized}`。這組欄位由介面卡逐項構造，payload 中的授權、房間和執行配置不透傳。工單 DTO 至少具備 `id/provider/channelId/threadId/roomId/authorId/status/authorized/manualAuthorized`。`manualAuthorized` 對應領域 `authorization.mode==='auto' && authorization.origin==='manual'`。delivery：`{id,leaseToken,workItemId,provider,channelId,threadId,text}`。宿主負責重試時間、租約到期恢復和持久化。

## 頁面與許可權

在裝置中心的 **外部渠道** 中，可配置兩渠道的憑證、模式、作者白名單和房間對映，檢視工單列表 / 完整詳情，暫停、恢復、完成、人工授權或撤銷授權。點選“重試到期回寫”只領取已到宿主重試時間的佇列專案。

- 預設 `observe`。只有本機儲存的配置為 `auto`、作者在允許名單中、渠道已對映到房間，而且 GitHub 倉庫也在允許名單中，事件才攜帶自動授權。
- GitHub 作者填寫**數字使用者 ID**，不使用可改名的登入名；飛書作者填寫 `open_id`。倉庫名大小寫不敏感，其他身份精確匹配。
- 對映每行 `owner/repo=roomId` 或 `chat_id=roomId`。未知渠道返回 `ignored`，提示先設定對映，不建立無房間工單。已對映的未授權作者仍建立觀察工單。
- 配置修改、工單管理和手動觸發回寫額外檢查 socket 是 loopback；存在 Origin 時必須與 Host 同源。通過遠端裝置訪問頁面可以讀列表，但需要本機連線修改。此檢查依賴真實 socket，不信任轉發 IP 請求頭。
- 金鑰不返回 UI 明文。每項有“保留 / 替換 / 清空”：預設保留，替換必須輸入新值，清空必須顯式選擇；儲存後輸入框再次留空。所有變更先驗證配置和房間，再寫金鑰。
- 回寫先重讀工單，並在真正傳送訊息前再次核對授權。工單必須 `authorized`，自動授權還要通過當前配置、作者、倉庫和房間對映檢查；人工授權可獨立允許單工單執行和回寫。`blocked` / `cancelled` 禁止回寫，`completed` 允許傳送最終結果。撤銷工單授權會停止後續訊息傳送；已經被渠道接受的訊息不能撤回。

## GitHub

1. 在頁面儲存 Webhook Secret、GitHub API Token、倉庫和房間對映。Token 需要目標倉庫 issue / PR 評論寫入許可權及評論讀取許可權。
2. GitHub webhook Content type 設定 `application/json`，URL 填頁面顯示的 `/api/superagent/webhooks/github`，Secret 與頁面一致。
3. 訂閱 Issues、Issue comments、Pull requests、Pull request reviews、Pull request review comments。

接收的動作：

| GitHub 事件                   | 動作                                                                 |
| ----------------------------- | -------------------------------------------------------------------- |
| `issues`                      | opened / edited / reopened / closed                                  |
| `issue_comment`               | created / edited                                                     |
| `pull_request`                | opened / edited / reopened / closed / synchronize / ready_for_review |
| `pull_request_review`         | submitted / edited                                                   |
| `pull_request_review_comment` | created / edited                                                     |

使用 `X-Hub-Signature-256` 對原始位元組做 HMAC-SHA256 並恆時比較。`X-GitHub-Delivery` 作為事件 ID；`repository.full_name` 作為渠道；`#number` 作為執行緒；`sender.id` 作為作者。Bot 事件和帶本外掛回寫標記的內容不再建立工單。PR review 和行內評論的回寫統一寫入 PR 的普通會話評論。

回寫只訪問固定 `https://api.github.com`，拒絕重定向，不接受 payload 提供的 API URL。每條回覆帶穩定 `<!-- pi-superagent:sha256(deliveryId) -->` 標記。重試前逐頁查詢原評論，找到則只確認宿主 delivery。最多檢查 2,000 條評論；超過此範圍停止傳送並報告失敗，避免遺漏舊標記導致重複。宿主確認丟失、外掛重啟後仍可靠原渠道標記恢復。

## 飛書支援範圍

本版本支援**攜帶有效簽名的明文或 AES 加密回撥**：URL challenge 和 v2 `im.message.receive_v1` 使用者文本事件。先校驗原始請求位元組的簽名及時間窗，再按飛書官方 `IV || AES-256-CBC` 格式解密，最後校驗 Verification Token 和 App ID；錯誤金鑰、密文或 Token 均拒絕。演算法格式參考[飛書官方 Node SDK](https://github.com/larksuite/node-sdk/blob/main/utils/aes-cipher.ts)。不支援卡片回撥、富文本、圖片和應用機器人訊息。

需配置 Verification Token、簽名使用的 Encrypt Key、App ID；外發還需 App Secret，應用具備相應機器人發訊息許可權並在目標群內。事件訂閱 URL 填頁面顯示的 `/api/superagent/webhooks/feishu`。

同時校驗事件 token、`X-Lark-Signature = SHA256(timestamp + nonce + EncryptKey + rawBody)`、五分鐘時間窗和 App ID。challenge 也校驗 token 與簽名。訊息使用 `sender.sender_id.open_id` / `chat_id` / `header.event_id` 識別身份，並關聯 `root_id || parent_id || message_id`。只回復原執行緒，不接受外部 payload 指定收件目標。租戶 token 只在記憶體快取，憑證儲存後清快取。

每個 delivery 使用固定 UUID 回寫；該 UUID 的渠道防重時間有限，外掛不會把它當作永久冪等保證：

- 傳送前持久記錄第一次嘗試時間；成功取得訊息 ID 後先持久儲存回執，再確認宿主租約。即使宿主確認丟失，後續重試可直接確認該回執，無需重發。
- 未取得回執的網路錯誤可能已經在渠道落地。只在首次嘗試後 **45 分鐘內**自動使用同一 UUID 重試，為渠道一小時防重視窗留出餘量。
- 超過 45 分鐘仍無回執則停止自動傳送，delivery 錯誤標記 `manual reconciliation`，需要使用者在飛書核對和人工處理；外掛不會清空嘗試記錄後盲目重發。

## 外掛 API

以下路徑以 `/plugins-api/superagent` 為字首，繼續由宿主主站認證保護：

| 方法 / 路徑                                     | 用途                                  |
| ----------------------------------------------- | ------------------------------------- |
| `GET /config`                                   | 配置和金鑰存在布林值                  |
| `PUT /config`                                   | `{config, secrets:{key:{action:'keep' | 'set'    | 'clear',value?}}}` |
| `GET /rooms`                                    | 可用群組房間                          |
| `GET /items?roomId=`                            | 工單列表                              |
| `GET /item?id=`                                 | 工單詳情                              |
| `POST /items/update`                            | `{id,action:'pause'                   | 'resume' | 'complete'         | 'authorize' | 'observe'}` |
| `POST /deliver`                                 | 領取到期回寫並返回本輪成功 / 失敗數   |
| `GET /assets/main.mjs`、`GET /assets/style.css` | 頁面資源                              |

頁面 pause 對應 `blocked`、resume 對應 `open`、complete 對應 `completed`。所有更新只接受上述動作對應的固定 patch，不接受任意欄位修改。後臺每 15 秒領取到期 outbox，單次每渠道只領取一條，避免批次領取後等待導致租約過期；解除安裝清除輪詢和路由。單個網路請求超時 15 秒，每條 delivery 共用 40 秒網路預算，為宿主當前 60 秒租約預留確認時間；錯誤記錄不儲存上游響應或金鑰。

入站另有 4,096 個最近事件的持久回執快取，用於併發和重啟去重；**永久防重仍以宿主工單儲存為事實源**。GitHub 驗籤本身沒有新鮮度視窗，重放安全依賴宿主事件唯一約束。

## 驗證

```sh
npx prettier --write plugins/superagent tests/unit/superagent-plugin.test.ts
npx vitest run tests/unit/superagent-plugin.test.ts
npm run typecheck
```

測試直接呼叫偽 host 註冊的真實路由，注入 fetch，不啟埠或訪問真實 GitHub / 飛書。覆蓋配置保留 / 清空、頁面操作、簽名與原始位元組、身份與授權、併發 / 重啟重放、租約確認、失敗重試、撤權、回寫防重及飛書超出防重視窗後的拒絕傳送。
