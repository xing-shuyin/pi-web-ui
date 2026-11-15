**English** · [简体中文](./official-providers.md) · [繁體中文](./official-providers.zh-TW.md)

# Official provider integration

Both the normal install and the portable build can use 「模型管理 → 添加供应商」(Model management → Add provider) for quick configuration: enter the official API key, then fetch the model list or add model IDs manually and save.

Quick configuration only fills in the protocol and service URL; it does not pin a model catalog — available models, permissions and quotas are up to the provider. If a provider does not support model-list queries, use the model IDs its console provides and fill in the matching context and output limits.

## Fetching the model list

The candidate-model adopter only responds to fetch requests actively initiated from the current model-management window, and each response is consumed once. Reopening the management page after cancelling or adopting does not replay the previous candidate list; requests still pending at close are not surfaced in a new window even if they return later. Probe request IDs stay unique across window instances, so clicking fetch again still probes and adopts normally.

The implementation lives in `web/src/components/ModelConfigModal.tsx`; the regression test lives in `tests/unit/model-config-fetch.test.ts`.

## Adding a quick configuration

| Provider                          | Protocol                | Service URL                                              |
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

Existing DeepSeek, Moonshot, Zhipu and SiliconFlow configurations keep working. If a provider already appears in the built-in list, just set its API key — no need to add it again. API keys and endpoints from different regions are usually not interchangeable.

## Stability and maintenance

Prefer providers' public, officially supported APIs, with the pi SDK handling requests, streaming responses, tool calls and credentials uniformly. New quick configurations add no extra dependencies, subscription-token extraction, client identity spoofing or private protocol adapters.

WorkBuddy and Qoder desktop subscription logins are not built in. The community subscription adapters magpie references need maintenance that tracks login and private-protocol changes, which does not fit this round's stability-first integration scope. Official web or desktop subscriptions usually are not API quota; API billing follows the provider.

Providers may still change their official APIs or models; handle such changes primarily through SDK upgrades, endpoint changes or catalog refreshes. Quick configurations live in `web/src/components/ModelConfigModal.tsx` and do not copy the SDK model table or the streaming implementation.

Reference docs:

- [Bailian OpenAI-compatible API](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)
- [MiniMax Anthropic-compatible API](https://platform.minimax.cn/docs/api-reference/text-anthropic-api)
- [OpenAI API](https://platform.openai.com/docs/api-reference)
- [Anthropic API](https://docs.anthropic.com/en/api/overview)
- [Gemini API](https://ai.google.dev/gemini-api/docs)
- [Mistral API](https://docs.mistral.ai/api/)
- [Groq OpenAI compatibility notes](https://console.groq.com/docs/openai)
- [xAI API](https://docs.x.ai/docs/api-reference)
