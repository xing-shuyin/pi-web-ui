[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 微信通道（wechat-ilink）

微信掃碼登入，直連微信 ilink 後端（`https://ilinkai.weixin.qq.com`），協議與
騰訊官方的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) 同源
（見其 `docs/protocol_zh_CN.md`，MIT 協議）。

## 為什麼不需要公網

不出回撥、只出站：掃碼登入拿 `bot_token` → `getupdates` 長輪詢（35s）收訊息 →
`sendmessage` 回訊息。家裡內網、公司內網都能跑，不用開埠、不用公網 IP。

## 上手

1. 裝上外掛，開啟頂欄 💬 檢視，點「掃碼登入」，微信掃碼確認。
2. 有人發來訊息：白名單（設定 → 允許的使用者，或填 `*` 全放行）直接執行；
   陌生人先掛「待配對」，在視圖裡點允許/拒絕（並會推一條系統通知）。
3. 微信裡直接說話，agent 跑完回結果；跑超 `執行超時提醒` 先回“還在執行”。

## v1 範圍（誠實版）

- ⚡ **斜槓快捷指令**：支援單獨傳送 `/`（或 `/h`、`/help`）檢視簡化序號選單、`/clear`、`/reset` 或 `/new [提示]`（清空上下文開啟全新對話）、`/status`（檢視執行狀態與指標）、`/cwd [路徑]`（檢視或切換專案根目錄）、`/model [模型]`（檢視或切換模型）、`/thinking [強度]`（設定思考強度）、`/plan [on|off]`（計劃模式）、`/compact`（上下文壓縮）、`/stop` 或 `/abort`（中止當前任務）、`/reload`（過載擴充套件與技能）以及外掛擴充套件指令（如 `/todo`、`/note`、`/remind`），支援中文全形 `／` 與數字序號快捷輸入。
- 單賬號、文本訊息全雙工。
- **圖片/檔案雙向**（v0.5.0）：
  - **發**：AI 調 `wechat_send` 帶 `image`（圖片）或 `file`（其他附件，按副檔名分流 image/video/file），
    本地路徑（相對當前工作區）或 `http(s)` URL 都行；鏈路 = `getuploadurl` → AES-128-ECB 加密
    → CDN `POST`（讀 `x-encrypted-param`）→ `sendmessage` 的 `image_item`/`video_item`/`file_item`。
  - **收**：微信發來的圖片/檔案/影片下載後按 `image_item.aeskey`（hex）或 `media.aes_key` 解密，
    落到工作區 `.pi-wechat-media/`。圖片通過 `host.chat.attachments` 的 `imageData` / `mimeType` 作為真實圖片附件進入模型；檔案和影片以 `path` / `mode: reference` 附件進入宿主。需要支援該附件契約的宿主版本。
  - 下載單檔案上限 25MB；圖片單張 10MiB、最多 8 張、合計 20MiB。格式或限額失敗會直接告知使用者，不能讀取時不宣稱已理解內容。
  - 未接入語音識別（ASR）；收到語音直接提示無法聽取、請改發文字，並將此邊界傳給 agent。影片按檔案引用交付，不承諾自動理解畫面或聲音。
- 僅私聊：群聊和 thread 一律忽略，舊 `respondGroups` 設定不再放行，避免同用戶跨群合併私聊上下文。
- 每個已配對微信使用者按 ID 隔離獨立會話；持久化的每使用者序號進入 `accountId`，`/new`、`/clear`、`/reset`、工作區（`/cwd`、`/workspace`）、模型和思考強度切換會遞增，確保宿主不復用上一輪上下文。已有數字快捷命令、全形斜槓及大小寫形式使用相同的重置流程。這些命令同時讓當前微信使用者脫離網頁會話投遞，後續訊息持續使用新會話，外掛過載後仍保留；其他使用者不受影響。重置前尚未返回的宿主請求也會中止，不再認領舊執行。在微信外掛面板或設定中重新開啟「投遞到網頁當前會話」可恢復網頁同步。
- 媒體下載獨立執行（最多 4 個），不會阻塞後續 `/stop`；停止或新建會話後，尚未下載完成的媒體不會重新啟動任務。中止操作優先傳穩定 `runId`（老宿主回執無該欄位才回退實際 `conversationId`），過戶後仍可定位執行；等待宿主確認，失敗會明確提示。
- **微信發起的執行按 `runId` 認領，網頁續聊按穩定 `sessionId` 回傳**：在同一微信會話的網頁視圖裡主動發訊息，助手回覆也會發送給對應微信聯絡人。會話繫結與當前使用者會話代次關聯，`/new` 等重置會使舊繫結失效；共享檢視不改變執行歸屬。執行中發生過戶或區域性 `c1` 改名時，穩定身份仍可定位原聯絡人，不按單獨的區域性會話 ID 猜測。老宿主沒有 `sessionId` 時僅使用完整 `clientId + conversationId`；未建立身份繫結或存在多個聯絡人繫結歧義時不自動回傳。宿主未返回真實 `conversationId` 會明確反饋執行失敗。
- 過濾內部控制標記（如 [[plan:...]]、[[todo:...]]、[[conv:...]]、[[notify:...]]），只將使用者可見正文傳送到微信。
- 設定裡可配預設工作空間（顯式 pin cwd，防後臺啟動飄到 system32；
  Windows 下系統目錄直接拒絕）、模型 / 思考強度（兩個都是**下拉選擇**：模型列已配置
  鑑權的模型、思考強度列 SDK 檔位，留空 = 跟隨全域性預設），以及「投遞到網頁當前會話」
  （開 = 微信指令 steer 到瀏覽器正在開啟的對話，網頁即時可見）。
- 個人微信掃碼走官方 ilink 後端——比野路子 Hook 乾淨，但個人號自動化仍有
  平臺風險，小號先行、重要號三思。`bot_token` 存宿主加密機密（拷機解不開）。

## 檔案

- `index.mjs` 服務端：ilink 客戶端 + 登入/輪詢/配對/回包 + 媒體 CDN 收發 + `wechat_send` 工具
- `client/entry.mjs` 檢視：狀態/掃碼/配對/收件箱/手動傳送（文本 + 媒體路徑或 URL）
- `client/vendor/qrcode.js` 二維碼編碼器（kazuhikoarase/qrcode-generator 1.4.4，MIT，
  僅追加一行 ESM 匯出）：官方 `qrcode_img_content` 是 JS 跳轉頁不是圖片，
  掃的內容就是該 URL 本身，檢視在本地生成（與官方 CLI 的 qrcode-terminal 一致）
- 無頭呼叫走宿主 `host.chat`（`server/plugins.ts` + `AgentService.chatFromPlugin`），
  無瀏覽器也能跑；結果經 `onRunEvent(run_end)` 按 conversationId 關聯回包。

## 斜槓快捷指令

微信裡直接傳送斜槓指令（支援英文 `/`、中文全形 `／` 及簡寫序號 `1/cwd` / `/1` 等），通道直接快速回復，無需消耗 AI 模型額度：

- **快捷幫助選單**（發 `/`、`/h` 或 `/help`）：
  ```text
  可直接傳送 /序號（如 /1 或 /2 <提示>）快捷操作：
  1/cwd : 檢視或切換當前專案根目錄
  2/new : 清空上下文開啟全新會話 [提示]
  3/status : 檢視通道執行狀態與指標
  4/model : 檢視或切換當前模型 [名稱]
  5/thinking : 設定思考強度 <off|low|high|max>
  6/plan : 開啟或關閉計劃模式 [on|off]
  7/compact : 壓縮當前會話上下文 [說明]
  8/stop : 中止當前正在執行的任務
  9/reload : 重新載入擴充套件與配置
  10/help : 顯示全部命令 (或發 /)
  11/note : 存一條筆記 <正文>（已安裝外掛命令自動展示）
  12/todo : 加一條待辦 <內容>
  ...
  ```
- **核心命令支援**：
  - `1/cwd` 或 `/1` 或 `/cwd [路徑]`：檢視或切換專案根目錄（`/cwd default` 恢復預設）
  - `2/new` 或 `/2` 或 `/new [提示]`：清空上下文開啟新會話（可直接帶首條提示）
  - `3/status` 或 `/3` 或 `/status`：檢視通道狀態、賬號、模型與訊息統計
  - `4/model` 或 `/4` 或 `/model [模型]`：檢視或切換模型（`/model default` 恢復預設）
  - `5/thinking` 或 `/5` 或 `/thinking [強度]`：設定思考強度（off/minimal/low/medium/high/xhigh/max）
  - `6/plan` 或 `/6` 或 `/plan [on|off]`：開啟或關閉計劃模式（只規劃不實施修改）
  - `7/compact` 或 `/7` 或 `/compact`：壓縮當前會話上下文
  - `8/stop` 或 `/8` 或 `/stop`：中止當前正在執行的任務
  - `9/reload` 或 `/9` 或 `/reload`：重新載入系統擴充套件與配置
  - `10/help` 或 `/10` 或 `/h` 或 `/`：檢視幫助
- **配對成功自動推送**：管理員在 Web 控制台完成配對後，通道會自動向該微信使用者傳送簡潔的連線成功歡迎語及高頻命令速查。
- **第三方外掛指令透傳**：支援已安裝外掛註冊的命令（如 `/todo`、`/note`、`/remind` 等），微信傳送後直接執行並回顯外掛結果。
