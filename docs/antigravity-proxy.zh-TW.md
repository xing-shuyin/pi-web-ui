[English](./antigravity-proxy.en.md) · [简体中文](./antigravity-proxy.md) · **繁體中文**

# Antigravity-Manager 反代接入

[Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) 是本機 8045
埠的協議反代：把 Google / Anthropic 的 Web Session 轉成標準 API。pi-web-ui
把它當成普通的自定義服務商來接——三步通：

1. 頂欄模型下拉 →「⚙ 管理模型」→「新增服務商」
2. 點「填入 Antigravity（OpenAI 通道）」，貼上反代的 API Key
   （Docker 啟動時的 `API_KEY`；桌面版在「API 反代」頁檢視）
3. 點「自動獲取模型列表」→「儲存」，即時生效（寫 `models.json` + 熱過載）

## 雙通道

一條自定義供應商記錄一次只能有一種 `api` 型別，所以有兩個模板：

| 通道                       | 模板按鈕                           | `api`                | `baseUrl`                             | 對應反代介面                                      |
| -------------------------- | ---------------------------------- | -------------------- | ------------------------------------- | ------------------------------------------------- |
| OpenAI（推薦先配）         | 填入 Antigravity（OpenAI 通道）    | `openai-completions` | `http://127.0.0.1:8045/v1`            | `POST /v1/chat/completions`、`GET /v1/models`     |
| Anthropic（Claude 全功能） | 填入 Antigravity（Anthropic 通道） | `anthropic-messages` | `http://127.0.0.1:8045`（不帶 `/v1`） | `POST /v1/messages`（Tool Use + Thinking 全支援） |

兩個通道可共存（供應商 ID 分別為 `antigravity` /
`antigravity-anthropic`，已存在時自動加 `-2` 字尾，不覆蓋）。

## 原理與注意事項

- 反代鑑權是 `Authorization: Bearer <API_KEY>`（同時認 `x-api-key` /
  `x-goog-api-key`），模板把「自動新增 Authorization 請求頭」保持開啟即可。
- `GET /v1/models` 返回標準 OpenAI 格式 `{ data: [{ id }] }`，只有 id
  沒有其他後設資料——「自動獲取」建行後，名字含 `thinking` 的會自動勾選推理
  （全域性規則，見下），上下文長度 / 識圖按需手補。

> **全域性規則**：自動獲取解析模型 id 時含 `thinking`（忽略大小寫）即勾選推理，
> 適用於所有自定義供應商（Ollama / vLLM / 各類代理）。只增不減：誤傷時取消勾選即可
> （下次重新整理/獲取對該 id 會再次補勾，以端點後設資料和手填為準管理即可）。

- 模板永遠不碰已填的 API Key；`providerId` 為空時才填，不會覆蓋已有手寫 ID。
- 反代改了埠（非預設 8045）時，把填好的 `baseUrl` 中的埠改一下即可，
  其餘不動。

## 自動補引數（所有自定義供應商通用）

編輯表單「模型」區有點「補引數」按鈕 + 一個依據輸入框：

- **留空點按鈕**：服務端按模型 id 查公開目錄（OpenRouter 主、models.dev 輔，
  服務端 24h 快取）自動補上下文長度、輸出上限、識圖與推理。
- **填依據**：每行一條 `模型 id = 依據`，依據是目錄模型 id
  （如 `claude-sonnet-4-5-thinking = anthropic/claude-sonnet-4-5`）或模型頁 URL。
- **只填空**：手填過的值永遠不動；補上的行會標出來源
  （OpenRouter / models.dev / 依據 / 網頁，別名匹配會註明）。
- **匹配不上**：列出未匹配 id 與相近家族建議，點建議即填入依據框，改後重跑一次。
- 參考源不可達（離線）時明確報錯，不寫假資料。
