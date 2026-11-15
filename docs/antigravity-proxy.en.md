**English** · [简体中文](./antigravity-proxy.md) · [繁體中文](./antigravity-proxy.zh-TW.md)

# Connecting the Antigravity-Manager reverse proxy

[Antigravity-Manager](https://github.com/lbjlaq/Antigravity-Manager) is a protocol reverse proxy on port 8045 of this machine: it turns Google / Anthropic web sessions into a standard API. pi-web-ui connects to it as an ordinary custom provider — three steps:

1. Top bar model dropdown →「⚙ 管理模型」(Manage models) →「新增服务商」(Add provider)
2. Click「填入 Antigravity（OpenAI 通道）」(Fill in Antigravity (OpenAI channel)) and paste the proxy's API Key
   (the `API_KEY` at Docker startup; on the desktop app see the「API 反代」(API proxy) page)
3. Click「自动获取模型列表」(Auto-fetch model list) →「保存」(Save) and it takes effect immediately (writes `models.json` + hot reload)

## Two channels

A single custom provider record can only have one `api` type, so there are two templates:

| Channel                             | Template button                         | `api`                | `baseUrl`                               | Proxy endpoint                                            |
| ----------------------------------- | --------------------------------------- | -------------------- | --------------------------------------- | --------------------------------------------------------- |
| OpenAI (configure first)            | Fill in Antigravity (OpenAI channel)    | `openai-completions` | `http://127.0.0.1:8045/v1`              | `POST /v1/chat/completions`, `GET /v1/models`             |
| Anthropic (full Claude feature set) | Fill in Antigravity (Anthropic channel) | `anthropic-messages` | `http://127.0.0.1:8045` (without `/v1`) | `POST /v1/messages` (Tool Use + Thinking fully supported) |

Both channels can coexist (provider IDs `antigravity` /
`antigravity-anthropic`; an existing one gets a `-2` suffix automatically instead of being overwritten).

## How it works and caveats

- Proxy auth is `Authorization: Bearer <API_KEY>` (it also accepts `x-api-key` /
  `x-goog-api-key`), so keeping the template's "automatically add the Authorization header" on is enough.
- `GET /v1/models` returns the standard OpenAI shape `{ data: [{ id }] }` with only ids
  and no other metadata — once "auto-fetch" creates the rows, names containing `thinking` get reasoning
  checked automatically (global rule, see below); context length / vision must be filled in by hand.

> **Global rule**: when auto-fetch parses model ids, containing `thinking` (case-insensitive) checks reasoning.
> This applies to all custom providers (Ollama / vLLM / proxies of every kind). It only adds, never removes: uncheck
> when it misfires (the next refresh/fetch re-checks that id; manage it from endpoint metadata and manual values).

- Templates never touch an already filled API Key; it is filled only when `providerId` is empty, and never overwrites a handwritten ID.
- If the proxy runs on a non-default port (not 8045), change the port in the filled `baseUrl` and leave everything else alone.

## Auto-filling parameters (works for every custom provider)

The edit form's "Models" section has a「补参数」(Fill parameters) button plus a basis input:

- **Click with the input empty**: the server looks the model id up in public catalogs (OpenRouter primary,
  models.dev secondary, 24h server-side cache) and fills context length, output limit, vision, and reasoning.
- **With a basis**: one `模型 id = 依据` (model id = basis) per line, the basis being a catalog model id
  (e.g. `claude-sonnet-4-5-thinking = anthropic/claude-sonnet-4-5`) or a model page URL.
- **Blanks only**: hand-entered values are never touched; filled rows show their source
  (OpenRouter / models.dev / basis / web page; alias matches are noted).
- **No match**: lists the unmatched ids plus nearby-family suggestions; clicking a suggestion fills the basis box, and you re-run once after editing.
- When a reference source is unreachable (offline) it fails explicitly and writes no fake data.
