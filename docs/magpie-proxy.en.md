**English** · [简体中文](./magpie-proxy.md) · [繁體中文](./magpie-proxy.zh-TW.md)

# Magpie reverse-proxy access

[Magpie](https://github.com/yetone/magpie) aggregates multiple providers, subscription accounts and local models behind one gateway. pi-web-ui connects over a standards-compatible protocol, with no extra plugin to install.

## Quick setup

1. Start Magpie and confirm it has a usable provider or subscription account configured.
2. In pi-web-ui's model configuration, add a custom provider and click the **Magpie** quick preset.
3. The preset fills in `http://127.0.0.1:3425/v1`, the `openai-completions` protocol, Bearer auth and the local placeholder key `magpie`. An already-entered or already-saved key takes precedence.
4. Click to fetch the model list, select the models you need and save, then pick that provider's model in the conversation.

Model IDs must use the full value Magpie returns, including the provider prefix and the `group/...` routing group name. You can create routing groups in Magpie so several upstream models share one model ID.

## Protocol selection

Magpie supports protocol conversion; change the custom provider's protocol and address as needed:

| pi-web-ui protocol                  | Base URL                   |
| ----------------------------------- | -------------------------- |
| `openai-completions` (quick preset) | `http://127.0.0.1:3425/v1` |
| `openai-responses`                  | `http://127.0.0.1:3425/v1` |
| `anthropic-messages`                | `http://127.0.0.1:3425`    |
| `google-generative-ai`              | `http://127.0.0.1:3425`    |

Do not append `/chat/completions`, `/responses` or `/messages` to the address. Model-list fetching uses the existing generic endpoint; the OpenAI-compatible entry is `/v1/models`.

## Remote services and containers

The address is reached by the **pi-web-ui server**. When the two run on different machines, in Docker containers or behind WSL NAT, `127.0.0.1` points at the environment running the pi-web-ui server and must be replaced with a Magpie address the server can reach.

For remote access, enable LAN sharing in Magpie's Settings → Network and sharing, create a gateway key in Gateway → Gateway keys, and replace the preset's `magpie` with that key. Do not enter an upstream provider's key. The preset placeholder only covers Magpie's default permissive loopback access.

The gateway key's model permissions affect the list `/v1/models` returns. When the list is empty or the request is rejected, check the account status, gateway key permissions and quota in Magpie.

Interface and auth references: [Magpie integration guide](https://github.com/yetone/magpie/blob/main/README.zh-CN.md), [gateway reference](https://github.com/yetone/magpie/blob/main/docs/reference.md).
