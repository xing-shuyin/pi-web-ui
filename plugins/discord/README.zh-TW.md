[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# Discord 機器人與工作臺 (Discord Plugin)

> Discord Bot 官方 Gateway WebSocket 出站長連線雙工對話外掛，支援雙向會話對話（零公網 IP / 免反代）、結構感知 Markdown 智慧分塊、白名單安全准入與訊息推送。零外部依賴（Node 內建 fetch + node:crypto + 全域性 WebSocket）。

## 功能特性

- 🤖 **Gateway WebSocket 出站長連線雙工對話**：基於 Discord 官方 Gateway (v10) 協議，客戶端主動發起出站長連線，**零公網 IP、免域名、免反向代理、免開放入站埠**，在區域網或個人電腦即可即開即用！
- 📦 **結構感知 Markdown 分塊**：針對 Discord 單條訊息上限（2000 字元），採用類似 `dsh-im` 的智慧分塊演算法，保證程式碼塊（\`\`\`）自動閉合與語法高亮不破損。
- ⚡ **文本指令**：支援 `/help`、`/new`、`/clear`、`/reset [提示詞]`、`/status`、`/stop`（別名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [絕對路徑]`（別名 `/workspace`）。未知指令返回幫助，不送模型。
- 🛡️ **安全白名單控制**：支援設定允許對話的 Discord User ID 白名單，未授權人員友好攔截，防止 Bot 被陌生人濫用。
- 💬 **持續會話與網頁續聊**：按使用者與頻道隔離，Discord thread 使用其獨立頻道 ID。同一 scope 持續使用同一賬號與上下文，穩定 sessionId 路由持久儲存；網頁繼續該會話時，回覆仍傳送到原頻道或 thread。
- 🛠️ **AI 工具**：向 AI 助手註冊 `discord` 工具，AI 可自主向 Discord 頻道推送訊息與通知。

## 配置指南

1. 開啟 [Discord Developer Portal](https://discord.com/developers/applications)；
2. 點選「New Application」建立應用，輸入應用名稱；
3. 進入「Bot」標籤頁，點選「Add Bot」生成機器人；
4. **重要**：在 Bot 頁面向下滾動，開啟 **Privileged Gateway Intents** 中的「MESSAGE CONTENT INTENT」與「SERVER MEMBERS INTENT」；
5. 點選「Reset Token」複製生成的 `Bot Token`；
6. 在「OAuth2」→「URL Generator」中勾選 `bot` 範圍，並授予 `Send Messages`、`Read Messages/View Channels` 許可權，複製生成的連結將機器人邀請到你的伺服器中；
7. 在 pi-web-ui 的 Discord 面板點選「⚙️ 配置憑證」，填入 Bot Token 並勾選「啟用 Discord 機器人雙向對話服務」即可！

## 媒體與執行邊界

- 接收訊息中的附件會真實下載至當前工作區的 `.channel-attachments/discord/`，需要外掛 `fs` 許可權和宿主檔案訪問授權；切換目錄必須是已授權、存在的絕對路徑。
- PNG/JPEG/GIF/WebP 通過 `host.chat({text, attachments:[{path,imageData,mimeType,name}]})` 投遞真實圖片資料，最多 8 張、單張 10 MiB、圖片合計 20 MiB；是否能理解圖片取決於所選模型。其他檔案以 `{path,mode:"reference",name}` 投遞本地路徑。未知格式和不支援的圖片型別明確提示。
- 音訊/語音及影片以檔案收發，不接入即時語音訊道、錄音或視訊通話，不自動轉寫或解碼；模型需要可用的讀取、轉寫或解碼工具。下載或投遞失敗會回覆錯誤。
- AI `discord` 工具的 `send` 支援 `file` 本地路徑（圖片、語音檔案、普通檔案、影片），通過平臺上傳真實位元組；統一上限 20 MiB，平臺或工作區可能施加更低限額。上傳失敗工具拋錯；回覆投遞失敗記入 lastError 並通知瀏覽器。
- 指令作為普通訊息傳送；頻道內需 @ 機器人，私聊可直接傳送。未註冊平臺原生 slash command。模型/思考設定下一次訊息生效，宿主校驗無效配置並反饋失敗。`default` 恢復外掛預設配置。
- 模型、思考強度、目錄、賬號 epoch 和穩定 sessionId 路由按使用者 + 頻道 + thread 隔離並持久化，外掛重新載入後恢復；執行中的臨時輸出不恢復。執行中拒絕第二條任務；`/stop` 可立即取消正在下載的附件並阻止後續派發。`/new`、`/clear`、`/reset` 可立即取消舊任務或附件下載並開啟空白會話，也可在命令後附提示詞直接執行；命令名支援大小寫和全形寫法，提示詞與路徑保持原樣。`/cwd`、`/workspace` 驗證目錄後同樣開啟新會話；查詢目錄不重置，驗證失敗保留原會話。舊任務遲到回執和結束事件不會覆蓋新會話或解除其忙碌狀態。重置保留模型、思考強度與目錄設定。`/model`、`/thinking` 設定引數仍需先停止並等待，成功設定均開啟新上下文；`default` 和思考強度值不區分大小寫，模型標識保留原樣。以上會話切換均更換賬號 epoch，確保 daemon 不復用舊會話，歷史保留。
- runId 存在時只允許精確匹配已認領的執行，未知 runId 不借用 session 路由。網頁無 runId 的事件必須先由相同 sessionId 的 `run_start` 建立執行，結束只發送一次，並只發送最後一條助手正文候選，不拼接工具呼叫前言。舊宿主的完整 clientId + conversationId 可在當前例項相容，匿名 `c1` 不認領。
- `/new`、`/clear`、`/reset`、目錄或模型設定變更撤銷舊 epoch 的路由；更換 Bot Token 撤銷全部舊賬號路由。網頁無穩定 runId 時 `/stop` 明確提示在網頁停止，不猜測 `c1` 作為中止目標。持久化或傳送失敗會反饋錯誤；回覆繼續走現有 Bot API 分塊傳送，不額外建立 webhook 通道。
- 收發使用模擬 API 行為測試，未以真實機器人憑據驗證平臺端到端。

Discord 檔案傳送還需 `Attach Files` 許可權，附件下載只接受官方 `cdn.discordapp.com` / `media.discordapp.net` HTTPS URL，不跟隨重定向；音影片以附件傳送，語音檔案不偽裝為原生語音訊息。
