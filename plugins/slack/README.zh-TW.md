[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# Slack 機器人與工作臺 (Slack Plugin)

> Slack 機器人外掛，基於 Slack 官方 Socket Mode 出站 WebSocket 長連線，支援雙向會話對話（零公網 IP / 免反代）、結構感知 Markdown (mrkdwn) 智慧分塊、白名單安全准入與頻道/執行緒訊息推送。零外部第三方包依賴（Node 內建 fetch + node:crypto + 全域性 WebSocket）。

## 功能特性

- 🤖 **Socket Mode 出站 WebSocket 雙工對話**：基於 Slack 官方 Socket Mode，客戶端主動發起長連線，**零公網 IP、免域名、免反向代理、免開放入站埠**，在區域網或個人電腦即可即開即用！
- 📦 **結構感知 Markdown 分塊**：針對 Slack 訊息長度限制，採用類似 `dsh-im` 的智慧分塊演算法，保證程式碼塊（\`\`\`）自動閉合與語法高亮不破損。
- ⚡ **文本指令**：支援 `/help`、`/new`、`/clear`（別名 `/reset`，這三個重置命令均支援附帶提示詞，重置後按原文派發）、`/status`、`/stop`（別名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [絕對路徑]`（別名 `/workspace`）。命令支援全形斜槓與大小寫混寫，未知指令返回幫助，不送模型。
- 🛡️ **安全白名單控制**：支援設定允許對話的 Slack User ID 白名單，未授權人員友好攔截，防止 Bot 被陌生人濫用。
- 💬 **執行緒會話回覆**：支援在頻道執行緒（Thread）中跟進回覆，保持頻道介面整潔。
- 🛠️ **AI 工具**：向 AI 助手註冊 `slack` 工具，AI 可自主向 Slack 頻道推送訊息與通知。

## 配置指南

1. 開啟 [Slack API 開發者後臺](https://api.slack.com/apps) 並建立應用（Create New App → From scratch）；
2. 進入「Socket Mode」頁面，開啟 **Enable Socket Mode**，生成包含 `connections:write` 許可權的 **App-Level Token**（以 `xapp-` 開頭）；
3. 進入「OAuth & Permissions」頁面，在 **Bot Token Scopes** 中新增許可權：
   - `chat:write`
   - `app_mentions:read`
   - `channels:history`
   - `im:history`
4. 點選「Install to Workspace」完成安裝，複製生成的 **Bot User OAuth Token**（以 `xoxb-` 開頭）；
5. 進入「Event Subscriptions」開啟事件訂閱，在 **Subscribe to bot events** 中新增 `app_mention` 與 `message.im`；
6. 在 pi-web-ui 的 Slack 面板點選「⚙️ 配置憑證」，填入 Bot Token 與 App-Level Token，勾選「啟用 Slack Socket Mode 機器人雙向對話服務」即可！

## 媒體與執行邊界

- 接收訊息中的附件會真實下載至當前工作區的 `.channel-attachments/slack/`，需要外掛 `fs` 許可權和宿主檔案訪問授權；切換目錄必須是已授權、存在的絕對路徑。
- PNG/JPEG/GIF/WebP 通過 `host.chat({text, attachments:[{path,imageData,mimeType,name}]})` 投遞真實圖片資料，最多 8 張、單張 10 MiB、圖片合計 20 MiB；是否能理解圖片取決於所選模型。其他檔案以 `{path,mode:"reference",name}` 投遞本地路徑。未知格式和不支援的圖片型別明確提示。
- 音訊/語音及影片以檔案收發，不接入即時語音訊道、錄音或視訊通話，不自動轉寫或解碼；模型需要可用的讀取、轉寫或解碼工具。下載或投遞失敗會回覆錯誤。
- AI `slack` 工具的 `send` 支援 `file` 本地路徑（圖片、語音檔案、普通檔案、影片），通過平臺上傳真實位元組；統一上限 20 MiB，平臺或工作區可能施加更低限額。上傳失敗工具拋錯；回覆投遞失敗記入 lastError 並通知瀏覽器。
- 指令作為普通訊息傳送；頻道內需 @ 機器人，私聊可直接傳送。未註冊平臺原生 slash command。模型/思考設定下一次訊息生效，宿主校驗無效配置並反饋失敗。`default` 恢復外掛預設配置。
- 模型、思考強度、目錄和會話對映按使用者 + 頻道 + thread 隔離（Slack 普通私聊共用該私聊會話），會話對映、設定與 epoch 隨 `sessionRoutes` 持久儲存，外掛過載後可繼續同一 scope 的會話。執行中拒絕第二條任務；`/stop` 可立即取消正在下載的附件並阻止後續派發。`/new`、`/clear`（`/reset`）、`/cwd`（`/workspace`）、`/model`、`/thinking` 修改設定前需先停止並等待；它們會更換賬號 epoch，確保 daemon 不復用舊會話。模型或思考強度切換會開啟新上下文，無引數查詢保留上下文，新建不刪除歷史。
- 網頁續聊須先收到無 `runId` 的 `run_start`，再按已繫結的穩定 SDK `sessionId` 回傳到原使用者、頻道及 thread；舊宿主僅相容完整 `clientId + conversationId`，不會按匿名 `c1` 認領。帶 `runId` 的事件必須與通道回執精確匹配，未知 ID 不借用 session 路由。每輪僅回傳最後一個助手正文候選，不拼接工具前言，重複結束事件不重複傳送。
- `/new`、`/reset` 和上下文設定變更撤銷舊 epoch 的路由，切換機器人憑據清除舊賬號繫結，過載不會復活已撤銷路由。網頁執行沒有精確 `runId` 時，`/stop` 提示到網頁停止，不猜測 canonical conversationId。傳送仍走原 Slack API，錯誤保留在 lastError 並通知網頁。
- 收發使用模擬 API 行為測試，未以真實機器人憑據驗證平臺端到端。

Slack 附件還需 Bot Token scopes `files:read`、`files:write`（修改 scopes 後重新安裝應用）。上傳使用 `files.getUploadURLExternal` + 位元組上傳 + `files.completeUploadExternal`；頻道中的檔案訊息仍需 @ 機器人，回覆保持原 thread。私有檔案下載只接受 `files.slack.com` 且不跟隨重定向。
