# 官方供应商接入

普通安装和便携版均可通过「模型管理 → 添加供应商」选择快速配置，填写官方 API Key，再获取模型列表或手动添加模型 ID 后保存。

快速配置只填入协议与服务地址，不固定模型目录；可用模型、权限与额度由供应商决定。若供应商不支持模型列表查询，请使用其控制台提供的模型 ID，并填写对应上下文和输出上限。

## 获取模型列表

候选模型采纳器只响应当前模型管理窗口主动发起的获取请求，每个响应只消费一次。取消或采纳后重新打开管理页，不会回放上次的候选列表；关闭前尚未完成的请求即使稍后返回，也不会在新窗口弹出采纳器。探测请求 ID 跨窗口实例保持唯一，重新点击获取仍可正常探测和采纳。

实现位于 `web/src/components/ModelConfigModal.tsx`，回归测试位于 `tests/unit/model-config-fetch.test.ts`。

## 新增快速配置

| 供应商                            | 协议                    | 服务地址                                                 |
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

原有 DeepSeek、Moonshot、智谱和硅基流动等配置继续可用。供应商若已出现在内置列表中，也可直接设置其 API Key，无需重复添加。不同地区的 API Key 与端点通常不可混用。

## 稳定性与维护

优先使用供应商公开、官方支持的 API，由 pi SDK 统一处理请求、流式响应、工具调用和凭据。新增快速配置不引入额外依赖、订阅令牌提取、客户端身份模拟或私有协议适配。

WorkBuddy、Qoder 的桌面订阅登录没有加入内置接入。参考 magpie 的社区订阅适配需要跟随登录与私有协议变化维护，不符合本项目本轮稳定优先的接入范围。官方网页或桌面订阅通常不等于 API 额度，API 计费以对应供应商为准。

供应商仍可能调整官方 API 或模型；这类变更优先通过 SDK 升级、修改端点或刷新模型目录处理。快速配置位于 `web/src/components/ModelConfigModal.tsx`，不复制 SDK 模型表或流式实现。

参考文档：

- [百炼 OpenAI 兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- [MiniMax Anthropic 兼容接口](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)
- [OpenAI API](https://platform.openai.com/docs/api-reference)
- [Anthropic API](https://docs.anthropic.com/en/api/overview)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [Mistral API](https://docs.mistral.ai/api/)
- [Groq OpenAI 兼容说明](https://console.groq.com/docs/openai)
- [xAI API](https://docs.x.ai/docs/api-reference)

## 反代接入：Antigravity-Manager

[Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) 是本机 8045 端口的协议反代：把 Google / Anthropic 的 Web Session 转成标准 API。pi-web-ui 把它当普通自定义服务商接，三步通：

1. 顶栏模型下拉 →「⚙ 管理模型」→「新增服务商」
2. 点「填入 Antigravity（OpenAI 通道）」，粘贴反代的 API Key（Docker 启动时的 `API_KEY`；桌面版在「API 反代」页查看）
3. 点「自动获取模型列表」→「保存」，即时生效（写 `models.json` + 热重载）

### 双通道

一条自定义供应商记录一次只能有一种 `api` 类型，所以有两个模板：

| 通道 | 模板按钮 | `api` | `baseUrl` | 对应反代接口 |
| --- | --- | --- | --- | --- |
| OpenAI（推荐先配） | 填入 Antigravity（OpenAI 通道） | `openai-completions` | `http://127.0.0.1:8045/v1` | `POST /v1/chat/completions`、`GET /v1/models` |
| Anthropic（Claude 全功能） | 填入 Antigravity（Anthropic 通道） | `anthropic-messages` | `http://127.0.0.1:8045`（不带 `/v1`） | `POST /v1/messages`（Tool Use + Thinking 全支持） |

两个通道可共存（供应商 ID 分别为 `antigravity` / `antigravity-anthropic`，已存在时自动加 `-2` 后缀，不覆盖）。

### 原理与注意事项

- 反代鉴权是 `Authorization: Bearer <API_KEY>`（同时认 `x-api-key` / `x-goog-api-key`），模板把「自动添加 Authorization 请求头」保持开启即可。
- `GET /v1/models` 返回标准 OpenAI 格式 `{ data: [{ id }] }`，只有 id 没有其他元数据——「自动获取」建行后，名字含 `thinking` 的会自动勾选推理（见下面的全局规则），上下文长度 / 识图按需手补。
- 模板永远不碰已填的 API Key；`providerId` 为空时才填，不会覆盖已有手写 ID。
- 反代改了端口（非默认 8045）时，把填好的 `baseUrl` 中的端口改一下即可，其余不动。

> **全局规则**：自动获取解析模型 id 时含 `thinking`（忽略大小写）即勾选推理，适用于所有自定义供应商（Ollama / vLLM / 各类代理）。只增不减：误伤时取消勾选即可（下次刷新/获取对该 id 会再次补勾，以端点元数据和手填为准管理即可）。

### 自动补参数（所有自定义供应商通用）

编辑表单「模型」区有点「补参数」按钮 + 一个依据输入框：

- **留空点按钮**：服务端按模型 id 查公开目录（OpenRouter 主、models.dev 辅，服务端 24h 缓存）自动补上下文长度、输出上限、识图与推理。
- **填依据**：每行一条 `模型 id = 依据`，依据是目录模型 id（如 `claude-sonnet-4-5-thinking = anthropic/claude-sonnet-4-5`）或模型页 URL。
- **只填空**：手填过的值永远不动；补上的行会标出来源（OpenRouter / models.dev / 依据 / 网页，别名匹配会注明）。
- **匹配不上**：列出未匹配 id 与相近家族建议，点建议即填入依据框，改后重跑一次。
- 参考源不可达（离线）时明确报错，不写假数据。

## 反代接入：Magpie

[Magpie](https://github.com/yetone/magpie) 将多个供应商、订阅账号和本地模型汇集到同一个网关。pi-web-ui 可通过标准兼容协议连接，无需安装额外插件。

### 快捷配置

1. 启动 Magpie，确认其中已配置可用的供应商或订阅账号。
2. 在 pi-web-ui 的模型配置中新增自定义服务商，点击 **Magpie** 快捷预设。
3. 预设填入 `http://127.0.0.1:3425/v1`、`openai-completions` 协议、Bearer 认证和本机占位密钥 `magpie`。已有输入的密钥或已保存的密钥优先保留。
4. 点击获取模型列表，选择所需模型并保存，再在对话中选择该供应商的模型。

模型 ID 必须沿用 Magpie 返回的完整值，包括供应商前缀和 `group/...` 路由组名。可以在 Magpie 中创建路由组，让多个上游模型共用一个模型 ID。

### 协议选择

Magpie 支持协议转换，可按需要修改自定义供应商的协议和地址：

| pi-web-ui 协议 | Base URL |
| --- | --- |
| `openai-completions`（快捷预设） | `http://127.0.0.1:3425/v1` |
| `openai-responses` | `http://127.0.0.1:3425/v1` |
| `anthropic-messages` | `http://127.0.0.1:3425` |
| `google-generative-ai` | `http://127.0.0.1:3425` |

地址不要附加 `/chat/completions`、`/responses` 或 `/messages`。模型列表获取走现有通用接口；OpenAI 兼容入口为 `/v1/models`。

### 远程服务与容器

地址由 **pi-web-ui 服务端**访问。两者运行在不同机器、Docker 容器或 WSL NAT 环境时，`127.0.0.1` 指向运行 pi-web-ui 服务端的环境，需要改为服务端可达的 Magpie 地址。

远程访问需在 Magpie 的 Settings → Network and sharing 中开启局域网共享，在 Gateway → Gateway keys 中创建网关密钥，并用该密钥替换预设的 `magpie`。不要填写上游供应商的密钥。预设占位值仅用于 Magpie 默认宽松的本机回环访问。

网关密钥的模型权限会影响 `/v1/models` 返回的列表。列表为空或请求被拒绝时，检查 Magpie 中的账号状态、网关密钥权限和配额。

接口与认证依据：[Magpie 接入说明](https://github.com/yetone/magpie/blob/main/README.zh-CN.md)、[网关参考](https://github.com/yetone/magpie/blob/main/docs/reference.md)。
