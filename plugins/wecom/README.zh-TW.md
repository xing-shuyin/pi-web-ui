[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 企業微信工作臺與機器人 (WeCom Plugin)

企業微信群機器人 Webhook 推送、自建應用連線檢查，以及可由介面卡呼叫的 `WecomBotBridge`。零外部依賴。

## 當前接入邊界

企微群機器人的 Webhook 是傳送介面，不能憑 Webhook Key 接收群訊息。本外掛目前沒有部署企業應用回撥接收、簽名驗證及加解密服務，也沒有把外部入站訊息接入 `WecomBotBridge.onInboundMessage` 的網路入口。工作臺“啟動機器人”僅啟用內部橋接監聽，不能視為已建立企微入站連線。實際雙向對話需要額外的可信回調適配器，完成簽名驗證、解密後呼叫該橋接。

橋接會話按企業/應用賬號、回覆 Webhook、room（chatId / ChatId / roomId）、channelId、threadId、傳送者及持久 epoch 隔離。介面卡必須傳真實目的地標識和正確的回覆 Webhook。宿主回執中的穩定 sessionId 繫結原目的地；網頁主動續聊同一 session 的無 runId `run_start` 會建立獨立回覆任務，結束後只發送最後一條助手候選正文，不拼接工具呼叫前言。已結束任務的重複結束事件不再次傳送；未知 runId 不能借用 session 路由。

路由、scope 賬號與 epoch 儲存到外掛 storage；目的地 Webhook 通過宿主 secrets 儲存，路由記錄不含明文金鑰。外掛過載可恢復穩定 session 路由及入站會話；舊宿主僅以完整 clientId + conversationId 相容（僅記憶體），裸 c1 不認領。reset、模型/目錄 setter 以及賬號憑據變更撤銷舊路由；過載不恢復已撤銷 epoch。網頁任務沒有精確 runId 時 `/stop` 明確返回無法安全中止，不猜測 canonical ID。回覆複用 Webhook 傳送與錯誤校驗，缺少原目的地金鑰或平臺拒收會記錄錯誤，不改投當前預設 Webhook。

## 橋接命令

- `/help`：幫助。
- `/new [prompt]`、`/clear [prompt]`、`/reset [prompt]`：立即隔離舊任務和在途投遞，使用新的宿主賬號及會話；提供 prompt 時直接執行原文，例如 `/reset /stop` 會把 `/stop` 當作提示詞。會盡力中止舊任務，遲到的回執和回覆不會恢復舊繫結。
- `/status`：內部執行狀態及訊息計數。
- `/stop`、`/abort`：通過宿主中止當前範圍的任務；投遞尚未返回時提示稍後重試。
- `/model [provider/id|default]`：檢視或設定該範圍的模型。
- `/thinking [off|minimal|low|medium|high|xhigh|default]`：檢視或設定思考強度。
- `/cwd [路徑|default]`、`/workspace [路徑|default]`：檢視或設定工作目錄，default 恢復面板預設值，下次投遞由宿主校驗路徑並建立新會話。

命令名不區分大小寫，支援全形字母和全形斜槓；僅命令名做字元規範化，prompt 與路徑保留原文字形和內部空白。default 與思考強度不區分大小寫。模型、思考強度和目錄偏好僅存於橋接記憶體，外掛過載後回到面板預設配置；scope 身份、epoch 與穩定會話路由持續儲存。普通重複任務在忙碌時拒絕；重置及有效的模型、思考強度、目錄 setter 均立即隔離舊上下文，不等待舊任務或投遞迴執，查詢和無效引數不重置。模型與思考強度的實際可用性由宿主投遞時校驗，命令儲存不代表模型已驗證可用。

## 媒體支援

橋接接受 `voice` 訊息已有的 `Recognition`/`recognition` 平臺識別文本，並明確標記來源；沒有識別文本時不宣稱已轉寫。圖片、檔案、影片、原始語音和未知型別明確回覆無法下載或解碼，不把媒體 URL 當作視覺輸入。當前未實現企微 media_id 下載、媒體解密或 ASR，不能讀取這些媒體的內容。

出站提供 Markdown/文本訊息和 UTF-8 位元組預算分塊。尚未提供圖片、語音、檔案、影片上傳發送。

## 配置

群推送：在企微群中新增群機器人，複製 Webhook 中的 key，填入工作臺。僅用於向對應群傳送訊息。

企業自建應用連線檢查：填寫 CorpID、應用 AgentId 與 Secret。金鑰由宿主 secrets 儲存；這些憑據不會自動建立回撥服務或媒體接收能力。
