[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# Matrix (去中心化) 機器人與工作臺 (Matrix Plugin)

> Matrix 機器人外掛（實驗功能），基於 Matrix Client-Server API (v3) 出站 Sync 長輪詢，支援雙向會話對話（零公網 IP / 免反代）、結構感知 Markdown 智慧分塊、白名單安全准入與房間訊息推送。零外部第三方包依賴（Node 內建 fetch + node:crypto）。

## 功能特性

- 🤖 **去中心化 Matrix 出站 Sync 雙工長輪詢**：基於 Matrix Client-Server 官方規範，客戶端主動發起出站長輪詢，**零公網 IP、免域名備案、免反向代理、免開放入站埠**，支援連線自建 Synapse 或公共 Matrix 伺服器（如 matrix.org）！
- 📦 **結構感知 Markdown 分塊**：針對訊息長度限制，採用類似 `dsh-im` 的智慧分塊演算法，保證程式碼塊（\`\`\`）自動閉合與語法高亮不破損。
- ⚡ **斜槓快捷指令**：支援 `/help`、`/new`、`/clear`（別名 `/reset`，這三個重置命令均支援附帶提示詞，重置後按原文派發）、`/status`、`/stop`（別名 `/abort`）、`/model [provider/id|default]`、`/thinking [off|minimal|low|medium|high|xhigh|default]`、`/cwd [絕對目錄]`（別名 `/workspace`）。命令支援全形斜槓與大小寫混寫，未知命令會提示幫助，不投遞模型。模型從宿主可用目錄校驗；目錄須存在且通過宿主檔案許可權檢查。執行時須先停止並等待結束才能新建會話或切目錄。
- 🛡️ **安全白名單控制**：支援設定允許對話的 Matrix User ID 白名單（形如 `@user:matrix.org`），未授權人員友好攔截，防止 Bot 被陌生人濫用。
- 💬 **多房間與群聊支援**：支援在 Matrix 房間中接收訊息並回復，按房間、thread、傳送者隔離上下文與命令設定，回覆保持原 thread。執行以穩定 runId 認領，支援回執前到達的訊息及結束事件。
- 🛠️ **AI 工具**：向 AI 助手註冊 `matrix` 工具，AI 可自主向 Matrix 房間推送訊息與通知。

## 配置指南

1. 擁有一個 Matrix 賬號（可在 [matrix.org](https://matrix.org/) 註冊，或使用私有部署的 Synapse / Conduit 伺服器）；
2. 使用 Element Web 或其他客戶端登入後，在「個人設定」→「幫助與關於」中複製你的 **Access Token** 與 **Homeserver URL**；
3. 將該機器人賬號邀請到你的目標 Matrix 房間；
4. 在 pi-web-ui 的 Matrix 面板點選「⚙️ 配置憑證」，填入 Homeserver URL 與 Access Token，勾選「啟用 Matrix 機器人雙向對話服務」；
5. 點選「🔌 測試連線」驗證通過後點選「💾 儲存配置」即可開始對話。

## 媒體與限制

- 接收圖片、音訊（含語音）、檔案、影片：從認證 Matrix media API 下載原始位元組到所選工作區 `.matrix-media/`，再傳給 `host.chat({text, attachments})`。PNG/JPEG/WebP/GIF 圖片通過 `{path:"", imageData:base64, mimeType, name}` 傳入；其他媒體用 `{path:absolutePath, mode:"reference", name}` 引用，並提示模型使用 read 或可用工具。視覺能力取決於模型；渠道不自動轉錄語音或解碼影片，無法解析時必須說明。
- 每個 Matrix 訊息接收一個媒體附件，因此圖片每次至多一張且不超過 10 MiB（低於宿主 8 張/合計 20 MiB 上限），其他附件不超過 25 MiB；流式讀取同樣限制位元組數。檔案保留在工作區，需自行清理。額外目錄須事先在宿主授權，渠道不會繞過檔案許可權。
- `matrix` 工具 `action=send` 支援 `path`（工作區內本地路徑）、`media_type=image|audio|file|video`、`mimetype`、`text`、`thread_id`：真實讀取檔案、上傳原始位元組併發送相應 Matrix 媒體事件。路徑越界、下載/上傳/傳送失敗均返回錯誤；入站失敗嘗試回覆原 thread，回覆本身失敗記錄日誌及狀態錯誤。
- **不支援 E2EE**：沒有裝置金鑰、Olm/Megolm 解密、金鑰備份或加密上傳。加密房間訊息和加密附件明確拒絕，出站先查房間狀態並拒絕向加密房間傳送明文。請使用機器人已加入的未加密房間；無法讀取房間狀態也會拒絕傳送。無法解密的事件無法讀取 thread 關係。
- 首次無持久游標的同步只建立游標，不重放歷史。命令偏好為記憶體態；穩定 `sessionId` 回傳路由及作用域 epoch 持久化，外掛過載後仍可將網頁續輪的最終回答送回原房間與執行緒。舊宿主僅支援完整 `clientId + conversationId` 記憶體路由，不接受裸 `c1`。帶 `runId` 的事件只匹配精確執行，未知 ID 不借用會話；無 `runId` 的網頁續輪必須由 `run_start` 建立記錄，結束後只回傳一次，助手訊息以最後候選替換前文並排除工具呼叫前言。網頁執行無可取消的執行 ID 時，`/stop` 明確報告無法安全停止，不猜測會話 ID。切換 Homeserver 或憑據清空舊路由；`/new`、`/clear`（`/reset`）、`/cwd`（`/workspace`）和模型、思考強度切換會輪換 peer epoch 與 accountId，確保宿主建立全新上下文，保留原歷史；無引數查詢保留上下文。執行中修改設定須先停止並等待結束。`/stop` 可立即取消當前附件下載，取消或切換後不會派發舊附件訊息；停止任務保留會話路由供後續網頁續輪使用。
