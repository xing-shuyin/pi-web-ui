[English](./official-providers.en.md) · [简体中文](./official-providers.md) · **繁體中文**

# 官方供應商接入

普通安裝和便攜版均可通過「模型管理 → 新增供應商」選擇快速配置，填寫官方 API Key，再獲取模型列表或手動新增模型 ID 後儲存。

快速配置只填入協議與服務地址，不固定模型目錄；可用模型、許可權與額度由供應商決定。若供應商不支援模型列表查詢，請使用其控制台提供的模型 ID，並填寫對應上下文和輸出上限。

## 獲取模型列表

候選模型採納器只響應當前模型管理視窗主動發起的獲取請求，每個響應只消費一次。取消或採納後重新開啟管理頁，不會回放上次的候選列表；關閉前尚未完成的請求即使稍後返回，也不會在新視窗彈出採納器。探測請求 ID 跨視窗例項保持唯一，重新點選獲取仍可正常探測和採納。

實現位於 `web/src/components/ModelConfigModal.tsx`，迴歸測試位於 `tests/unit/model-config-fetch.test.ts`。

## 新增快速配置

| 供應商                            | 協議                    | 服務地址                                                 |
| --------------------------------- | ----------------------- | -------------------------------------------------------- |
| OpenAI                            | Responses               | `https://api.openai.com/v1`                              |
| Anthropic                         | Anthropic Messages      | `https://api.anthropic.com`                              |
| Google Gemini                     | Google Generative AI    | `https://generativelanguage.googleapis.com/v1beta`       |
| Alibaba Cloud Bailian (CN)        | OpenAI Chat Completions | `https://dashscope.aliyuncs.com/compatible-mode/v1`      |
| Alibaba Cloud Bailian (Singapore) | OpenAI Chat Completions | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` |
| MiniMax (CN)                      | Anthropic Messages      | `https://api.minimax.cn/anthropic`                       |
| MiniMax (International)           | Anthropic Messages      | `https://api.minimax.io/anthropic`                       |
| Mistral                           | OpenAI Chat Completions | `https://api.mistral.ai/v1`                              |
| Groq                              | OpenAI Chat Completions | `https://api.groq.com/openai/v1`                         |
| xAI                               | OpenAI Chat Completions | `https://api.x.ai/v1`                                    |

原有 DeepSeek、Moonshot、智譜和矽基流動等配置繼續可用。供應商若已出現在內建列表中，也可直接設定其 API Key，無需重複新增。不同地區的 API Key 與端點通常不可混用。

## 穩定性與維護

優先使用供應商公開、官方支援的 API，由 pi SDK 統一處理請求、流式響應、工具呼叫和憑據。新增快速配置不引入額外依賴、訂閱令牌提取、客戶端身份模擬或私有協議適配。

WorkBuddy、Qoder 的桌面訂閱登入沒有加入內建接入。參考 magpie 的社群訂閱適配需要跟隨登入與私有協議變化維護，不符合本專案本輪穩定優先的接入範圍。官方網頁或桌面訂閱通常不等於 API 額度，API 計費以對應供應商為準。

供應商仍可能調整官方 API 或模型；這類變更優先通過 SDK 升級、修改端點或重新整理模型目錄處理。快速配置位於 `web/src/components/ModelConfigModal.tsx`，不復制 SDK 模型表或流式實現。

參考文件：

- [百鍊 OpenAI 相容介面](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- [MiniMax Anthropic 相容介面](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)
- [OpenAI API](https://platform.openai.com/docs/api-reference)
- [Anthropic API](https://docs.anthropic.com/en/api/overview)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [Mistral API](https://docs.mistral.ai/api/)
- [Groq OpenAI 相容說明](https://console.groq.com/docs/openai)
- [xAI API](https://docs.x.ai/docs/api-reference)
