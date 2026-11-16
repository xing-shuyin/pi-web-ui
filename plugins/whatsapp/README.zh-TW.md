[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# WhatsApp 機器人與工作臺

基於 Meta WhatsApp Business Cloud API（Graph API v20.0），無第三方執行依賴。外掛版本 **0.2.5**。

## 命令與會話

支援 `/help`、`/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`、`/status`、`/stop`（別名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [absolute path]`（相容 `/workspace`）。未知斜槓命令直接提示，不交給模型。

模型與思考引數在下一次投遞時由宿主驗證；命令回覆不會偽稱模型已切換。目錄必須存在、已獲宿主檔案授權，切目錄會新建會話。命令名相容大小寫及全形字元（含全形斜槓），引數保留原文。`/new`、`/clear`、`/reset` 帶提示詞時，會在新會話執行該提示詞，提示詞以 `/` 開頭也作為正文傳送。模型、思考強度及目錄 setter 均重置上下文；`DEFAULT` 恢復預設，思考強度相容大小寫。

`/new`、`/clear`、`/reset` 立即使舊佇列、下載和在途投遞失效，解除舊會話繫結並輪換獨立賬號，保留模型、思考強度及目錄偏好，同時請求中止舊執行。遲到回執也會請求中止，舊事件不會恢復繫結；中止失敗會明確反饋。`/stop` 呼叫真實 `host.abortRun(runId || conversationId)`，優先穩定執行 ID，過戶或對話改名後仍準確中止。取消投遞後晚到的回執同樣優先使用其 `runId` 中止。

會話使用通道來源隔離賬號。使用 `await host.chat()` 回執的真實 `conversationId` 和穩定 `runId`，支援回執前到達的訊息及結束事件、會話過戶及改名。未返回穩定執行 ID 時明確報錯。傳送失敗記錄日誌、狀態並通知工作臺；投遞失敗、中止、模型錯誤、超時均有反饋。

## 媒體

- 收入圖片：通過 Meta 媒體 ID 查詢、下載真實二進位制，以 `attachments: [{path:"", imageData:base64, mimeType, name}]` 交給宿主；不會把 URL 或檔名當作圖片。支援 PNG/JPEG/WebP/GIF，其他型別明確告知無法解碼。
- 收入音訊、檔案、影片：以 `attachments: [{path:"", fileData:base64, mimeType, name}]` 交給宿主持久化。音影片明確說明外掛沒有自動轉錄/影片解碼能力，附件作為檔案參考，進一步解析取決於模型與工具。
- 所有入站附件（圖片、音訊、檔案、影片）單個最大 10 MiB；後設資料、Content-Length 及實際下載流均檢查上限。Meta 每個入站訊息只有一個媒體物件，外掛每次模型請求僅一份附件，因此符合宿主最多 8 張圖片、單附件 10 MiB、合計 20 MiB 的約束。
- 工作臺支援選擇圖片/音訊/檔案/影片型別、輸入工作區檔案路徑及 MIME 型別傳送；AI 工具 `whatsapp` 的 `send_media` 同樣支援工作區檔案上傳或已存在的 Meta `media_id`。工具 `send` 繼續傳送文本。
- 外發媒體使用 multipart 上傳後按媒體 ID 傳送，最大 20 MiB；具體 MIME/編碼/賬號能力還受 Meta API 限制，失敗會反饋。語音傳送為 audio 媒體，不額外承諾語音氣泡或語音合成。

## 配置與接入

在 Meta 開發者平臺啟用 WhatsApp Business，配置 Phone Number ID 與具有 `whatsapp_business_messaging` 許可權的 Access Token。在外掛面板測試、儲存並啟動機器人。Token 通過宿主 secrets 儲存，檔案訪問通過宿主 fs 許可權控制。

外掛接收入口是 `POST /plugins-api/whatsapp/inbox`（反向代理子路徑部署需加宿主字首），接受 Meta webhook 的 `entry[].changes[].value.messages[]` JSON。入口受宿主 `PI_WEB_TOKEN` 鑑權；機器人關閉時返回 503。需要配置可信的 webhook 中繼驗證 Meta 簽名，再攜帶宿主鑑權轉發 JSON。本外掛沒有公開直連 webhook 的 GET challenge 和 Meta 簽名驗證，不能直接把未鑑權公網回調當作可信輸入。

## 能力邊界

- 當前 Cloud API 僅支援業務號碼與使用者私聊。群/thread 訊息不送模型，不將群回覆降級發到私聊，限制記錄到狀態和日誌；沒有承諾群聊支援。
- 模型切換、無頭聊天和真實附件需要新版 pi 宿主支援；缺少 `conversationId/runId` 回執會拒絕不安全的關聯。不能在舊版宿主靠 URL 文本降級圖片。
- 音影片沒有內建轉錄、影片幀解碼或合成服務。無法解碼必須說明，不能編造媒體內容。
- Meta 24 小時服務視窗、模板訊息要求、收件號碼資格、媒體編碼支援及網路可達性由 Meta 管理；不承諾零封號或無限制傳送。
- 同一來源持續複用會話；目的地、獨立賬號、穩定 sessionId 與 reset epoch 經宿主 storage 儲存，外掛過載後恢復。網頁主動續聊的最終助手正文仍回原收件人；工具前言不拼入最終回覆，重複結束事件只發送一次。舊宿主僅接受完整 clientId + conversationId，不按匿名 c1 認領。
- `/new` 或業務賬號/Token 變化撤銷舊路由；舊事件不能恢復舊 epoch。網頁執行沒有 runId 時只能解除回傳繫結，明確報告無法精準中止，不猜測 canonical conversationId。執行中文本與 webhook 去重仍只在記憶體中保留，過載不會重發已結束執行。Meta 服務視窗到期仍由原 Cloud API 傳送並明確記錄錯誤，不自動傳送收費模板。

驗證：`npx vitest run tests/unit/whatsapp-features.test.ts tests/unit/whatsapp-behavior.test.ts tests/unit/whatsapp-session-routes.test.ts`。
