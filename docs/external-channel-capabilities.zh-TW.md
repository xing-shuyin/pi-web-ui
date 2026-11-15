[English](./external-channel-capabilities.en.md) · [简体中文](./external-channel-capabilities.md) · **繁體中文**

# 外部訊息渠道能力與使用說明

覆蓋微信 iLink、QQ、企業微信、飛書、釘釘、Telegram、Discord、Slack、Matrix、WhatsApp、iMessage 共 11 個渠道。各平臺的 API 許可權、賬號資格與格式限制仍然適用。

## 統一行為

11 個渠道均處理 `/help`、`/new`、`/clear`、`/status`、`/stop`（別名 `/abort`）、`/model`、`/thinking`、`/cwd`（別名 `/workspace`）。未知命令回覆幫助，不投遞模型。Discord/Slack 指令是普通訊息中的文本指令，沒有註冊平臺原生 slash-command endpoint。

會話按傳送者和會話空間隔離：Telegram chat/topic、Discord channel（包括獨立 thread channel）、Slack channel/thread、Matrix room/thread。會話對映是否持久化依渠道而異；Telegram、Discord、Slack、Matrix 的偏好與對映儲存在外掛記憶體，重啟會重置。新建/清空及目錄切換會更換 peer account epoch，下一次 host.chat 使用不同 accountId，避免 daemon 複用舊上下文。歷史記錄保留。模型切換開啟新上下文；執行中切換限制見各外掛 README。

所有橋接消費 host.chat 回執中的真實 conversationId、穩定 runId，並緩衝回執前到達的助手訊息與結束事件。按 runId 認領事件，避免會話過戶或重新命名後錯回。停止優先傳穩定 runId；下載期間的停止取消後續模型投遞。派發、下載、模型執行失敗有渠道反饋；傳送本身失敗記錄狀態/日誌，Discord/Slack/Matrix 還使用宿主通知能力（若可用）。

## 媒體能力與限制

| 渠道             | 入站                                                                         | 出站及主要限制                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 微信 iLink 0.5.3 | 私聊圖片作為視覺附件，檔案/影片提供本地引用；語音有識別文本時消費識別結果    | 保留 ilink 文本/圖片/檔案/影片傳送；僅私聊，拒絕群/thread；無內建 ASR                                                     |
| QQ 0.1.16        | 圖片視覺附件、檔案/音影片本地引用，保留平臺已有語音識別文本                  | 保留富媒體傳送；群/頻道/thread/使用者隔離；傳送格式、配額與授權依 QQ API                                                  |
| 企業微信 0.1.7   | 可信回調適配器可投遞文本/平臺語音識別文本；無法下載的媒體明確反饋            | 當前沒有入站回撥網路服務，Webhook 僅傳送文本/Markdown；不宣稱開箱即用雙向媒體聊天                                         |
| 飛書 0.3.0       | 圖片視覺輸入，其他媒體作為持久化檔案；群/thread 原位回覆                     | 圖片、檔案、Opus 音訊、MP4 影片（需時長），受機器人許可權與編碼限制                                                       |
| 釘釘 0.2.0       | Stream 真實入口，圖片視覺輸入，其他媒體持久化檔案；企業/群/thread/使用者隔離 | 企業機器人支援圖片、AMR 音訊、檔案、帶封面 MP4；Webhook 僅文本/Markdown                                                   |
| WhatsApp 0.2.3   | Meta 媒體 ID 下載圖片/音訊/檔案/影片；僅私聊                                 | multipart 上傳媒體；需可信中繼驗證簽名後攜宿主 token 轉發。尚無直接 Meta challenge/簽名驗證，受 24 小時視窗和模板要求限制 |
| iMessage 0.2.0   | macOS 只讀 chat.db 輪詢，圖片視覺輸入，其餘本地引用；群 GUID 定向            | Messages AppleScript 傳送本地媒體；僅 macOS，需系統許可權；thread 隔離但不支援蘋果原生原位 thread 回覆                    |

| 渠道     | 入站                                                                                 | 出站                                                                                              | 真實限制                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Telegram | photo、圖片文件、voice、audio、document、video、video_note、animation 下載真實位元組 | 工具上傳本地檔案或 HTTP(S) URL，支援 photo/document/audio/voice/video/animation，保留 forum topic | 單檔案本地限制 20 MiB；Bot API 仍有格式/方法限制。相簿按獨立訊息處理，不聚合。下載保留於伺服器臨時目錄，需要定期清理         |
| Discord  | 訊息 attachments 下載，圖片視覺附件，其他型別檔案引用                                | 工具以 multipart 上傳本地檔案；圖片/音訊/影片/普通檔案均可作為附件                                | 本地限制 20 MiB，伺服器/賬號可能更低；不連線語音訊道，不提供語音訊息錄製後設資料；需啟用 Message Content Intent 和頻道許可權 |
| Slack    | 帶鑑權下載私有 files，圖片視覺附件，其他型別檔案引用                                 | 工具使用外部上傳 URL 和 completeUploadExternal 上傳本地檔案                                       | 本地限制 20 MiB；需 files:read/files:write 與相應訊息事件許可權；無 huddle/即時語音；頻道附件訊息須提及機器人                |
| Matrix   | m.image/m.audio/m.file/m.video，通過鑑權媒體下載                                     | 工作區內本地檔案上傳 mxc 後傳送對應訊息，支援 thread                                              | 檔案本地限制 25 MiB，homeserver 可更低；不支援 E2EE 房間/附件解密，明確報錯；不解碼即時通話                                  |

PNG/JPEG/GIF/WebP 按既有 PromptAttachment 合同傳 `{path, imageData:base64, mimeType, name}`，每請求最多 8 張、單圖 10 MiB、圖片合計 20 MiB，最終還受宿主校驗與模型視覺能力限制。Telegram 和 Matrix 一條事件通常只有一個媒體。非圖片按 `{path:absoluteDownloadedPath, mode:"reference", name}` 輸入；模型接收真實檔案引用，而不是遠端下載連結。

飛書/釘釘通過 base64 輸入的媒體單份最大 10 MiB、混合合計 20 MiB；WhatsApp 入站單媒體最大 10 MiB。出站飛書最大 10 MiB，釘釘/WhatsApp 最大 20 MiB，仍受各平臺限制。本地路徑引用不佔 base64 位元組預算。

音影片收發不等於自動理解：外掛不內建語音轉寫或影片解碼。收到音影片或不支援的圖片/未知檔案型別會明確說明，模型需要可用的轉寫、解碼或文件讀取工具。無法理解時必須反饋，不能靜默丟棄附件。附件下載位置及授權要求見各外掛 README；工作區檔案需宿主 fs 許可權。

## 驗證與部署

本輪行為測試使用 mock 平臺 HTTP/API 和 host.chat，覆蓋真實附件內容、命令攔截、賬號 epoch、群/thread 隔離、穩定 runId 與早到結束事件，以及停止下載等競態。沒有使用生產機器人憑據做真實平臺端到端測試。

實際檢查的本機外掛目錄為 `C:\Users\c\.pi-web\plugins`，已同步其中已安裝的 QQ、微信原始碼，並核驗 secrets/storage 未變；其他九個渠道未安裝，未自動安裝。Telegram/Matrix 版本為 0.2.0，Discord/Slack 為 0.1.7。

公共宿主現在通過 `host.chat({text, attachments})` 真正透傳附件；最多 8 份，base64 附件單份 10 MiB、合計 20 MiB，超過限制明確拒絕而不截斷；本地路徑引用按原有附件許可權鏈處理。`host.abortRun(runId)` 支援按 `pr-` 穩定標識查詢過戶後的真正執行，失效標識返回失敗，不誤停同名會話。

本輪聯合驗證：29 個相關測試檔案、404 項測試通過，覆蓋宿主媒體輸入、停止歸屬和各渠道行為；外掛版本、工具提示詞與 manifest 許可權另有守衛檢查。Prettier、全專案五組 TypeScript 檢查、lint 與差異空白檢查通過。生產賬號真實平臺端到端聯調仍需分別驗證。
