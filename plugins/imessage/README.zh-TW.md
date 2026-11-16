[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# iMessage

通過 macOS Messages 傳送文字及本地圖片、語音、檔案、影片，並只讀輪詢 `~/Library/Messages/chat.db` 接收訊息。無需公網入口。

## 執行條件

僅支援 macOS，Messages 必須登入 Apple ID。執行 pi-web-ui 的終端或應用須獲「完整磁碟訪問許可權」（讀取 chat.db）和「自動化 → Messages」許可權（傳送訊息）。系統須提供 `/usr/bin/sqlite3`、`/usr/bin/osascript`。不滿足條件會顯示錯誤或 unsupported，不能在 Windows/Linux 假裝線上。

啟動時以資料庫最新記錄為游標，僅接收之後到達的訊息，每兩秒只讀查詢一次。停機期間訊息不補發。Apple 未提供公開的 Messages 接收 API，資料庫 schema 和 AppleScript 行為可能隨系統更新變化；此實現並非蘋果官方機器人 API。資料庫僅含 attributedBody 而無 text 的富文本訊息會收到明確的純文本重發提示。

## 命令

支援 `/help`、`/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`、`/status`、`/stop`（`/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [目錄|default]`。`/workspace` 為目錄命令相容別名。命令 token 支援大小寫、全形字母和全形斜槓；`default` 與思考強度忽略大小寫。未知命令及無效引數直接反饋，不送模型。

`/new`、`/clear`、`/reset` 建立新上下文，不刪除歷史；攜帶 prompt 時立即在新會話執行其字面正文，保留換行與空格，正文 `/stop` 等不會再次解析為命令。設定模型、思考強度或目錄也會輪換賬號、解綁舊會話，`default` 恢復配置預設值。無引數的設定命令只查詢當前值。控制命令立即處理，使重置前尚未啟動的準備請求、排隊訊息及遲到啟動回執失效；非同步目錄驗證遲到不能覆蓋後來的重置。重置與 model/thinking setter 在任務執行中也會立即解綁舊任務並請求停止；停止失敗會明確反饋，舊任務回覆不再關聯新會話。`/cwd`、`/workspace` 在已啟動任務執行中須先停止並等待結束再切換。模型、思考強度和工作目錄按傳送者與群聊/thread 隔離；宿主拒絕模型/目錄會反饋啟動失敗。會話關聯使用宿主真實 conversationId 和穩定 runId，支援早於 chat 回執到達的結束事件及會話過戶。

## 媒體

接收 PNG/JPEG/GIF/WebP 時，以真實 `attachments.imageData` 傳給宿主：最多 8 張，單張 10 MiB，總計 20 MiB。HEIC 等未知或不支援影像明確反饋，不偽裝為已理解。

音訊、影片、文本及常見 application 檔案以絕對本地路徑 reference 附件送入宿主。音影片會提示「是否可轉錄/理解取決於模型與工具」；外掛沒有內建 ASR 或影片解碼器。附件讀取失敗會回覆錯誤。

AI `imessage` 工具和外掛 `send_message` 介面支援 `file` 本地路徑，可與 `text` 一起傳送。Messages 決定具體格式、壓縮和大小限制，AppleScript 成功僅表示系統接受傳送請求，不表示收件人已送達/已讀。助手輸出的檔案不會自動傳送，應明確呼叫工具。群聊回覆使用原始 chat GUID 定向傳送，避免錯發為私聊；Apple Messages 不提供此橋接可用的 thread 定向傳送介面，同群不同 thread 會話隔離，但回覆落在原群。

## 持續會話回傳

入站訊息的宿主回執會繫結穩定 `sessionId` 與原 iMessage 群組/thread/傳送者路由，並持久儲存。網頁繼續該會話時，只有無 `runId` 的 `run_start` 能建立獨立待回覆項；最終助手訊息替換此前文本，`run_end` 僅回覆一次。攜帶 `runId` 的事件只匹配精確執行，未知執行不會借用會話路由。

舊宿主僅在同時提供 `clientId` 與 `conversationId` 時支援記憶體路由，裸 `c1` 等編號不構成身份。舊宿主路由不會跨外掛過載恢復。`/reset`、`/new`、`/clear` 及模型/目錄切換撤銷舊路由並持久儲存會話代次，過載後不會恢復已撤銷的舊會話。賬號或預設收件人變更會使舊路由失效。`/stop` 保留後續網頁繼續能力；網頁執行缺少精確 `runId` 時，機器人會提示在網頁停止，不猜測中止目標。

## 驗證範圍

命令、早到事件、runId 歸屬、跨群/thread、圖片附件、檔案引用、傳送 AppleScript、輪詢和錯誤反饋均有模擬行為測試。真實 macOS 端到端驗證仍需有 Apple ID 與上述許可權的機器。
