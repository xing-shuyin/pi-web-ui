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
