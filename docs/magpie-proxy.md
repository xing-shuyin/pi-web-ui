[English](./magpie-proxy.en.md) · **简体中文** · [繁體中文](./magpie-proxy.zh-TW.md)

# Magpie 反代接入

[Magpie](https://github.com/yetone/magpie) 将多个供应商、订阅账号和本地模型汇集到同一个网关。pi-web-ui 可通过标准兼容协议连接，无需安装额外插件。

## 快捷配置

1. 启动 Magpie，确认其中已配置可用的供应商或订阅账号。
2. 在 pi-web-ui 的模型配置中新增自定义服务商，点击 **Magpie** 快捷预设。
3. 预设填入 `http://127.0.0.1:3425/v1`、`openai-completions` 协议、Bearer 认证和本机占位密钥 `magpie`。已有输入的密钥或已保存的密钥优先保留。
4. 点击获取模型列表，选择所需模型并保存，再在对话中选择该供应商的模型。

模型 ID 必须沿用 Magpie 返回的完整值，包括供应商前缀和 `group/...` 路由组名。可以在 Magpie 中创建路由组，让多个上游模型共用一个模型 ID。

## 协议选择

Magpie 支持协议转换，可按需要修改自定义供应商的协议和地址：

| pi-web-ui 协议                   | Base URL                   |
| -------------------------------- | -------------------------- |
| `openai-completions`（快捷预设） | `http://127.0.0.1:3425/v1` |
| `openai-responses`               | `http://127.0.0.1:3425/v1` |
| `anthropic-messages`             | `http://127.0.0.1:3425`    |
| `google-generative-ai`           | `http://127.0.0.1:3425`    |

地址不要附加 `/chat/completions`、`/responses` 或 `/messages`。模型列表获取走现有通用接口；OpenAI 兼容入口为 `/v1/models`。

## 远程服务与容器

地址由 **pi-web-ui 服务端**访问。两者运行在不同机器、Docker 容器或 WSL NAT 环境时，`127.0.0.1` 指向运行 pi-web-ui 服务端的环境，需要改为服务端可达的 Magpie 地址。

远程访问需在 Magpie 的 Settings → Network and sharing 中开启局域网共享，在 Gateway → Gateway keys 中创建网关密钥，并用该密钥替换预设的 `magpie`。不要填写上游供应商的密钥。预设占位值仅用于 Magpie 默认宽松的本机回环访问。

网关密钥的模型权限会影响 `/v1/models` 返回的列表。列表为空或请求被拒绝时，检查 Magpie 中的账号状态、网关密钥权限和配额。

接口与认证依据：[Magpie 接入说明](https://github.com/yetone/magpie/blob/main/README.zh-CN.md)、[网关参考](https://github.com/yetone/magpie/blob/main/docs/reference.md)。
