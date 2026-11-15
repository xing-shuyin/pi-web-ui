[English](./magpie-proxy.en.md) · [简体中文](./magpie-proxy.md) · **繁體中文**

# Magpie 反代接入

[Magpie](https://github.com/yetone/magpie) 將多個供應商、訂閱賬號和本地模型彙集到同一個閘道器。pi-web-ui 可通過標準相容協議連線，無需安裝額外外掛。

## 快捷配置

1. 啟動 Magpie，確認其中已配置可用的供應商或訂閱賬號。
2. 在 pi-web-ui 的模型配置中新增自定義服務商，點選 **Magpie** 快捷預設。
3. 預設填入 `http://127.0.0.1:3425/v1`、`openai-completions` 協議、Bearer 認證和本機佔位金鑰 `magpie`。已有輸入的金鑰或已儲存的金鑰優先保留。
4. 點選獲取模型列表，選擇所需模型並儲存，再在對話中選擇該供應商的模型。

模型 ID 必須沿用 Magpie 返回的完整值，包括供應商字首和 `group/...` 路由組名。可以在 Magpie 中建立路由組，讓多個上游模型共用一個模型 ID。

## 協議選擇

Magpie 支援協議轉換，可按需要修改自定義供應商的協議和地址：

| pi-web-ui 協議                   | Base URL                   |
| -------------------------------- | -------------------------- |
| `openai-completions`（快捷預設） | `http://127.0.0.1:3425/v1` |
| `openai-responses`               | `http://127.0.0.1:3425/v1` |
| `anthropic-messages`             | `http://127.0.0.1:3425`    |
| `google-generative-ai`           | `http://127.0.0.1:3425`    |

地址不要附加 `/chat/completions`、`/responses` 或 `/messages`。模型列表獲取走現有通用介面；OpenAI 相容入口為 `/v1/models`。

## 遠端服務與容器

地址由 **pi-web-ui 服務端**訪問。兩者執行在不同機器、Docker 容器或 WSL NAT 環境時，`127.0.0.1` 指向執行 pi-web-ui 服務端的環境，需要改為服務端可達的 Magpie 地址。

遠端訪問需在 Magpie 的 Settings → Network and sharing 中開啟區域網共享，在 Gateway → Gateway keys 中建立閘道器金鑰，並用該金鑰替換預設的 `magpie`。不要填寫上游供應商的金鑰。預設佔位值僅用於 Magpie 預設寬鬆的本機迴環訪問。

閘道器金鑰的模型許可權會影響 `/v1/models` 返回的列表。列表為空或請求被拒絕時，檢查 Magpie 中的賬號狀態、閘道器金鑰許可權和配額。

介面與認證依據：[Magpie 接入說明](https://github.com/yetone/magpie/blob/main/README.zh-CN.md)、[閘道器參考](https://github.com/yetone/magpie/blob/main/docs/reference.md)。
