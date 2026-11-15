[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 🐦 feishu —— pi-web-ui 飛書工作臺外掛

在 pi-web-ui 介面裡提供一個完整的飛書 / Lark 工作臺（頂欄 🐦 飛書 標籤頁）：
支援飛書企業自建應用雙向會話收發與自定義群機器人 Webhook 卡片推送，新訊息輪詢提醒，並將飛書互動能力開放給 AI 直接排程。HTTP API 使用內建 fetch 與 crypto；雙工長連線使用官方 `@larksuiteoapi/node-sdk`，缺失時通過宿主 `ensureDeps` 安裝。

## 功能

- **會話與通道**：
  - 瀏覽機器人加入的群聊與單聊會話
  - 支援手動新增自定義快捷接收人（`chat_id` `oc_...`、`open_id` `ou_...`、使用者郵箱）
  - 內建虛擬 Webhook 推送通道（`__webhook__`），即使沒有企業自建應用，僅憑群機器人 Webhook 也可完整使用
- **訊息瀏覽與閱讀**：
  - 支援檢視與解析多種飛書訊息型別：純文本（`text`）、富文本（`post`）、互動卡片（`interactive`）、圖片、檔案、影片、名片等
  - 關鍵詞搜尋當前會話或近期聊天記錄
  - **一鍵引用到對話**：一鍵將飛書訊息格式化引用注入主聊天輸入框
  - **智慧翻譯**：支援中英互譯、可選特定 AI 模型翻譯，自動保護 URL 與程式碼塊，內建 Google GTX 快速回退
  - **原始資料檢視**：可展開檢視飛書 Open API 下發的原始 JSON 結構
- **訊息傳送與富互動**：
  - 傳送純文本、富文本（帶標題）或飛書互動卡片（支援 Markdown 與 10 種卡片標題配色主題：藍色、綠色、橙色、紅色、紫色等）
  - 支援直接回復或**話題內回覆**（reply in thread）
  - 支援一鍵**撤回**（recall）機器人傳送的訊息
  - 支援**表情回應**（reactions）：👍 點贊、👌 好的、❤️ 愛心、👏 鼓掌、✅ 完成、🔥 火焰
- **自定義機器人 Webhook**：
  - 支援飛書群自定義機器人 Webhook 地址推送
  - 支援基於 HMAC-SHA256 的簽名校驗金鑰（Secret），自動計算 `timestamp` 與 `sign`
  - 本地自動留存 Webhook 推送歷史，方便追溯和排查
- **狀態列與新訊息提醒**：
  - 後臺週期性輪詢監控會話新訊息（預設 60s，可自定義）
  - 發現新訊息時通過 `host.notify` 彈出桌面/網頁通知並觸發廣播
  - 狀態列即時顯示徽標（`🐦 3 未讀` / `🐦 ✓` / `🐦 Webhook` / `🐦 未配置`）
- **AI 飛書管理工具 (`feishu`)**：
  - 啟用後向宿主註冊 action 式 `feishu` 工具：
    - `chats`：列出群聊與會話列表
    - `list`：獲取會話近期訊息列表
    - `read`：閱讀單條訊息詳情與正文
    - `search`：搜尋訊息內容
    - `send`：向群或個人傳送文本/富文本/卡片訊息
    - `reply`：回覆指定訊息（支援話題內回覆）
    - `recall`：撤回機器人傳送的訊息
    - `react`：為訊息新增表情回應
    - `webhook`：直接通過群機器人 Webhook 推送卡片或文本
  - 遵循嚴格的提示詞與安全規範，傳送前提示模型先向使用者確認目標與內容

## 0.3.0 雙工命令與媒體

命令均在通道本地處理：`/help`、`/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`、`/status`、`/stop`（別名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [絕對路徑|default]`（別名 `/workspace`）。命令名相容大小寫、全形字母和全形斜槓；思考強度與 default 不區分大小寫。重置後的 prompt 直接作為新會話輸入，保留內部空白及字面 `/stop`、`@文本` 等內容，不再解析為命令。未知命令直接反饋，不送模型。

會話按傳送人、聊天和 thread 隔離。新建、清空及切換目錄均遞增賬號 epoch，確保宿主建立全新上下文；舊歷史保留。`/new`、`/clear`、`/reset` 及模型、思考強度、目錄 setter 均立即重置當前作用域並請求停止舊執行，下載、表情反饋和回執等待中的舊訊息不再投遞或恢復舊繫結；其他聊天和 thread 不受影響。模型列表驗證完成前發生的重置會使該 setter 失效，避免遲到驗證覆蓋新上下文。default 清除該項覆蓋並恢復外掛配置預設值。目錄只做絕對路徑檢查，存在性與訪問限制由宿主在下一次投遞時驗證。模型從宿主列表校驗，模型與思考強度在下一次請求真實傳遞，最終支援情況由宿主驗證。偏好只儲存在執行記憶體；epoch 與穩定 session 路由持久化，過載後仍保留。

機器人下載圖片（包括富文本內圖片）、檔案、語音及影片，向 `host.chat({text, attachments})` 投遞真實位元組。圖片使用 `imageData`，其他檔案使用 `fileData`，由宿主持久化；需要支援該附件契約的新版宿主。圖片最多 8 張，每個圖片或 fileData 附件最多 10MiB；同一訊息的 imageData 與 fileData 共用累計 20MiB 預算，按 Base64 編碼前的原始位元組數計算。圖片支援 PNG/JPEG/GIF/WebP，以檔案頭檢查格式；完整畫素解碼由宿主/模型完成。資源許可權不足、下載失敗、不支援的格式均明確反饋。通道不自帶 ASR、音訊轉碼或影片解碼；音影片作為檔案交給模型工具處理，不能保證內容理解，收到時明確告知限制。

AI 工具 `feishu` 的 `send/reply` 支援 `msg_type=image|audio|file|media` 與 `file_path`，讀取真實本地檔案、上傳飛書後傳送；音訊僅 Opus、影片僅 MP4，須提供真實毫秒 `duration`。其他格式可用 `file` 傳送。檔案讀受宿主 fs 授權限制（外掛新增 fs 許可權），單檔案最多 10MiB。媒體傳送通過 AI 工具執行；工作臺輸入框仍為文本/卡片，Webhook 不支援媒體。助手輸出的任意路徑不會自動上傳，須呼叫工具傳送。

回執必須含真實 `conversationId/runId`，事件只按穩定 runId 關聯，支援早到訊息/結束事件和過戶改名。分塊全部回覆原訊息並保持 thread。停止命令旁路處理，下載中的任務取消派發，等待回執的任務在收到回執後呼叫宿主 abortRun；不會偽稱已中止尚無回執的宿主執行。執行錯誤、空結果和回信失敗均嘗試文字反饋；飛書完全不可用時只能記錄錯誤，無持久重試佇列。

## 0.3.2 持續會話與網頁續聊

同一傳送人、聊天及 thread 持續使用原會話；宿主返回穩定 `sessionId` 後，外掛持久化應用賬號指紋、scope、epoch 與原訊息/thread 目的地。網頁在該 session 主動續聊時，最終助手候選會回覆原訊息並保持 thread；工具前言不會與最終答覆拼接。原請求嚴格按 runId 關聯，未知 runId、僅有 `c1` 的事件不會認領路由；舊宿主僅在同時提供完整 clientId/conversationId 時支援本次載入內的網頁續聊。

`/new` 等重置撤銷當前 scope 路由並持久化新 epoch，應用憑據/平臺變更撤銷全部舊路由。普通停止與外掛過載不重置 session；只恢復穩定 sessionId 路由，不恢復未完成執行或重發舊答覆。網頁無 runId 的任務無法精準呼叫 abortRun 時，命令明確提示從網頁停止，不猜測 canonical conversationId。傳送繼續使用現有飛書訊息回覆 API；失敗保留狀態錯誤並嘗試文字提示，無持久傳送重試佇列。路由持久化失敗也會顯示最近錯誤。

## 配置

在工作臺點選右上角「⚙ 配置」即可開啟設定面板：

| 欄位                | 說明                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 接入模式 / 平臺預設 | 飛書國內版 (`open.feishu.cn`) / Lark 國際版 (`open.larksuite.com`) / 僅自定義機器人 Webhook / 自定義私有化閘道器 |
| App ID (`cli_xxx`)  | 飛書開放平臺 → 企業自建應用 → 憑證與基礎資訊                                                                     |
| App Secret          | 企業自建應用金鑰（加密落盤儲存，前端回傳自動脫敏）                                                               |
| 預設會話 ID         | 可選，如 `oc_xxx`，留空時預設取首個群聊                                                                          |
| 輪詢間隔 pollSec    | 新訊息檢查週期（秒），預設 60s（最低 15s）                                                                       |
| Webhook 地址        | 飛書群機器人 Webhook 地址（如不需要自建應用，僅填此處即可使用卡片推送）                                          |
| Webhook 簽名金鑰    | 可選，自定義機器人的安全簽名金鑰（HMAC-SHA256 加密儲存）                                                         |

金鑰優先儲存於宿主的安全機密庫（`host.secrets`，AES-256-GCM 加密落盤）。

## 安裝 / 解除安裝 / 更新

```bash
# ── 安裝 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu
pi-web-ui install plugins/feishu        # 本地目錄開發態

# ── 檢視 ──
pi-web-ui plugins                        # 列出已裝外掛與 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/feishu --force
cp -r plugins/feishu ~/.pi-web/plugins/  # 本地開發直接覆蓋

# ── 解除安裝 ──
pi-web-ui uninstall feishu
```

## 迴歸測試

- `tests/unit/feishu-session-routes.test.ts`：兩 scope 同 c1 併發、網頁回傳、重複/未知事件、重置、過載與賬號變更
- `tests/unit/feishu-runtime.test.ts`：命令、epoch、旁路停止、真實媒體附件、上傳、穩定 runId 與跨群/thread 隔離行為測試
- `tests/unit/feishu-features.test.ts`：純函式單元測試（訊息解析、卡片生成、Webhook HMAC 簽名、URL 保護與格式轉換）
- `tests/unit/feishu-secrets.test.ts`：敏感憑證加密持久化與脫敏測試
