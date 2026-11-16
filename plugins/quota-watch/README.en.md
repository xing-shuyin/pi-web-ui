**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Quota Watch (quota dashboard)

See how much quota **the current provider** has left on one screen. The plugin reads the machine's existing CLI login state **on the server side**, then queries the vendor's endpoint for quota;
the browser only draws the card — credentials are never sent down, uploaded, or written to disk.

> The viewpoint is single: **whichever provider the current session's model belongs to is the only one queried and the only one shown**.
> Another provider's subscription isn't requested even if it's logged in on this machine — the footer polls every 60s, and going out to unrelated sources is slow and easily trips rate limits,
> while the one you want to see is always the current model's. Want to see another? Switch to that model.

## Which sources are supported

| Platform            | Credential (auto-detected)                                            | Endpoint                             | Display                                   |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| Claude Code         | `~/.claude/.credentials.json`                                         | `api.anthropic.com/api/oauth/usage`  | 5-hour / weekly / per-model windows       |
| Codex (ChatGPT sub) | `~/.codex/auth.json`                                                  | `chatgpt.com/backend-api/wham/usage` | primary / secondary window + bonus quota  |
| DeepSeek            | API Key in settings, or the `DEEPSEEK_API_KEY` env var                | `api.deepseek.com/user/balance`      | Account balance (bonus / top-up split)    |
| OpenCode (Go sub)   | The opencode credential local pi already stored, or a Key in settings | `opencode.ai/console/api/go/status`  | 5-hour / weekly / monthly remaining quota |

"Auto-detected" means: as long as you've logged in through the corresponding CLI / IDE, the plugin can read it — **nothing else to fill in**.
When the login state expires, the plugin refreshes it in memory with the refresh_token and **never rewrites** your credential files.
Each credential is only brought up by the one condition "the current model belongs to it".

## Usage

1. After installing the plugin, the footer gains a segment after 「当前对话费用」(current conversation cost): `$0.8201 / DS ¥14.46`; **click it and a small card pops up next to it**
   (only the current provider: big balance number + bonus/top-up split + reset countdown, `⟳` forces a refresh, click outside / Esc to close).
   No top-bar tab, no full-screen dashboard — look and leave, without kicking the user out of the conversation.
2. Settings → Plugins → Quota Watch: turn off sources you don't want (off = not requested even if the current model is that provider), fill in the DeepSeek Key, change the cache duration.
3. Let the AI check quota: the built-in tool `quota_status` (`action=status`, optionally `refresh=true` to bypass the cache),
   the model calls it itself when you ask "how much quota do I have left" — likewise answering only for the current provider.

## Why these endpoints expose subscription quota

These platforms use exactly these endpoints for their official CLI / IDE, and the plugin does what the client does:

- **Claude Code**: `api/oauth/usage` returns the `utilization` and `resets_at` of `five_hour` / `seven_day` / `seven_day_opus`;
  an expired token is refreshed through Claude Code's public OAuth client.
- **Codex**: `backend-api/wham/usage` returns `used_percent`, `limit_window_seconds`, `reset_at` of `rate_limit.primary_window` / `secondary_window`,
  plus `credits`.
- **DeepSeek**: only a balance endpoint, no subscription window, so the card shows just the balance number (with a bonus / top-up split) and draws no progress bar —
  a "percentage" of a balance has no meaning.
- **OpenCode**: `console/api/go/status` returns the three subscription usage meters (`fiveHour` / `week` / `month` of `access.meters`,
  micro-cents `usedMicroCents / limitMicroCents`), which the plugin converts into a remaining percentage + a `resetsAt` countdown.
  Free models (Iceman Contributor Free etc.) are Unlimited in the Go table and don't consume subscription windows —
  the display is always the account-level remaining quota. Accounts without a subscription window degrade to showing only the local login-state list.

The endpoints are each vendor's private but stable CLI channel; when any platform changes its protocol, the plugin shows 「查询失败 + 原因」(query failed + reason) instead of silently vanishing.

## Footer status board (a slash continuation after 「当前对话费用」, auto-detecting the current provider)

That footer text **isn't the plugin's own chip**: the plugin hands the text to the host via `window.__piWebUiHost.setFooterStatus()`,
and the host embeds it in the **built-in cost cell**, continued with a slash — that is

```
347.1K / 1M   1128   $0.8201 / DS ¥14.46   99.2%   ⚡SoL-Pi 省 28.9M …
```

- Embedded in the cost cell rather than standing as its own footer item: users have ordered the footer in 「界面布局」(layout), and a separate item's `order`
  can't guarantee adjacency; embedded in the same cell it's always adjacent, with no orphan slash (the whole segment isn't rendered when there's no data).
- The content follows **the current session's model** (`providerFromModel` in `badge.mjs`), showing **only that one provider**:

  | Current model                              | Detected source | Display               |
  | ------------------------------------------ | --------------- | --------------------- |
  | `auto/deepseek-v4.1-flash`, `*/deepseek-*` | DeepSeek        | `DS ¥15.82` (balance) |
  | `*/claude-sonnet-4`, `*anthropic*`         | Claude Code     | `CL 58%`              |
  | `*/gpt-5.1-codex`, `*codex*`, `*/o3-*`     | Codex           | `CX 12.3%`            |

- Only one segment of text, no multi-source mode like "current + tightest": other providers never go out to the network, so there are no numbers to put side by side.
  When the model isn't recognized (self-hosted model / the matching switch is off) **the whole segment isn't rendered** — no leftover fragment like `额度 --` that takes up space with no information.
- When the current provider itself is broken, the failure code still shows: `⇅` network unreachable, `≠` login invalid, `!` query failed, `—` not logged in —
  the current provider being down is exactly what you most need to know.
- **The follow-up overlay opened by clicking it is rendered by the host; the plugin supplies content only**: `setFooterStatus(key, { text, tip, content: { render } })`,
  and `render(container)` draws those lines into the container the host hands over (`client/card.mjs`; the reference must be stable — the host compares by reference,
  and creating a new one on every poll remounts an open card).
  The shell belongs to the host (`web/src/components/FooterSlotPopover.tsx` + `use-floating-panel`): by default it sits **above** the anchor,
  flips below when it doesn't fit, right-aligns then clamps into the viewport, repositions on scroll / window resize, closes on outside click / Esc / clicking that text again,
  closes when the anchor disappears, `z-index: 9000` (above the footer, below modals), the list area caps at `min(52vh, 320px)` and scrolls, and there's no entrance animation
  under `prefers-reduced-motion`. **Requires host API ≥ 18** (the `content` capability); older hosts ignore it and the footer keeps just text + tooltip.
  The plugin itself **doesn't write** `position: fixed` / z-index / outer shadows — the overlay role belongs to the side that knows the anchor.
- **A network failure isn't treated as a login failure**: `fetch failed` / TLS / timeout are classified as `network` (`⇅`), with the hint "refresh after enabling a proxy/VPN",
  and it **stops immediately** instead of hitting several accounts one by one on the same dead domain (this used to burn 40s). One probe's total budget is 20s,
  quota request 8s, tiers 5s, and domains that have succeeded are remembered and sorted first.
- Cadence: the client (`preload: true`) subscribes to **a single snapshot** (see the next section), once every 60s when idle and every 15s while the overlay is open,
  plus an immediate catch-up when the window regains focus; when the plugin is disabled/uninstalled the host clears the slot it wrote (`clearFooterStatusesOf`).

## Refresh path: one snapshot, two views

In the old implementation the footer text and the overlay **each pulled** `/summary` and each held a timestamp, which produced the most grating bug of all:
click `⟳` in the popup, the overlay changes, **but the footer cell waits until the next whole minute** — the conclusion the user draws is "the refresh does nothing".

Now there's only one chain:

```
        /summary  ──►  client/store.mjs (single source, in-flight dedupe)
                            │
                 ┌──────────┴──────────┐
           footer host:quota   floating card content.render
```

- `client/store.mjs`: one refresh = one request + notify all subscribers. Clicking `⟳` in the overlay goes through here,
  so **the footer and the card update in the same frame**; only one request is in flight at a time, and when the two sides collide the later one reuses the former's result.
- Cadence: 15s while there's a `hold()` holder > 0 (overlay open), otherwise 60s; no requests while the page is hidden.
- **TTL tiers** (server `index.mjs`): subscription windows (Claude / Codex) follow the minutes in settings,
  default 5 minutes; balance-type sources (DeepSeek) are fixed at **60 seconds** — a balance changes with every request, and a 5-minute cache is too blunt,
  which is exactly the root cause of "balance updates are late".
- **Visible freshness**: `/summary` additionally returns `updatedAt / staleMs / ttlMs / lastGoodAt`, and the card's
  「刚刚 / 12 秒前」(just now / 12 seconds ago) ticks every second on its own, turning amber and marked 「陈旧」(stale) once past the TTL; the ring outside `⟳` is
  the progress to the next automatic refresh — no guessing.
- **A failure doesn't wipe the numbers**: on a collection failure the server carries back the balance/window it read successfully last time and marks `stale + staleSince`,
  and the card shows 「数值来自上次成功读取 · 5 分钟前」(value from the last successful read · 5 minutes ago); the footer badge stays the failure code (`⇅`/`!`) and never fakes a healthy balance.
- Card typography (`client/card.mjs` + `client/styles.mjs`): the main number at 26px, splits demoted to chips, a low balance (≤¥5) turns the whole card red,
  and a balance change triggers a 1-second background pulse; subscription types have no main balance number, so freshness moves to the header and the window progress bar stays as before.

## How the protocol was verified (works without a real login)

The vendors' private endpoints have no documentation, so **error codes are the evidence**: only with the right request shape and the right client_id does the server return a specific error.

| Probe                                                            | Actual response                                               | Conclusion                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Anthropic refresh (client `9d1c250a…` + a made-up refresh token) | `400 invalid_grant`                                           | Endpoint / client_id / body all correct (a wrong shape gives 4xx invalid_request) |
| Anthropic refresh (made-up client_id)                            | `400 Client with id … not found`                              | Reverse control: only then does the `invalid_grant` above mean anything           |
| `api/oauth/usage` (fake bearer)                                  | `401 authentication_error: OAuth access token is invalid.`    | The endpoint exists and `anthropic-beta` isn't rejected                           |
| OpenAI refresh (`app_EMoam…` + a made-up token)                  | `401 code: token_expired`                                     | client_id is correct                                                              |
| OpenAI refresh (made-up client_id)                               | `401 code: invalid_client`                                    | Reverse control                                                                   |
| `backend-api/wham/usage`, `codex/usage` (fake bearer)            | `401 {"detail":"Could not parse your authentication token…"}` | Both usage endpoints really exist                                                 |

These error codes are consumed directly by `needsReauth()` in `providers/util.mjs` — the "login invalid" decision doesn't guess from HTTP status
but recognizes `invalid_grant` / `token_expired` / `invalid_client` / `authentication_error`, so a network failure is never misreported as "please log in again".

Parsing has two layers of defense against structural drift: window length accepts both the `limit_window_seconds` / `window_minutes` spellings; when the main path can't
derive a window, it falls back to a depth-limited scan of "any `*window*` object carrying `used_percent`" (capped at 4 windows, to avoid reading a weird structure as fake data).

## Comparison with similar open-source projects (2026-11)

Checked before building this plugin: this problem already has plenty of mature implementations, and the field names and endpoint shapes were cross-calibrated against them.

| Project                                                                                                         | ★     | Form                      | Coverage                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ----- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [steipete/CodexBar](https://github.com/steipete/CodexBar)                                                       | 23k   | macOS menu bar (Swift)    | Codex + Claude Code, **no login** — reuses the machine's login state; this plugin's Codex/Claude field names and OAuth shape follow its source |
| [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)                                           | 19.8k | Desktop (Rust)            | Account management and quota for Antigravity / Codex / Copilot / Cursor etc.                                                                   |
| [jlcodes99/vscode-antigravity-cockpit](https://github.com/jlcodes99/vscode-antigravity-cockpit)                 | 4.8k  | VS Code extension         | Antigravity quota board only                                                                                                                   |
| [nguyenphutrong/quotio](https://github.com/nguyenphutrong/quotio)                                               | 4.9k  | macOS menu bar (Rust)     | Unified board for multiple subscription accounts                                                                                               |
| [Javis603/token-monitor](https://github.com/Javis603/token-monitor)                                             | 3.6k  | Desktop widget (JS)       | Token / cost / limits for 52+ coding tools                                                                                                     |
| [wusimpl/AntigravityQuotaWatcher](https://github.com/wusimpl/AntigravityQuotaWatcher)                           | 2.2k  | Browser/editor plugin     | Antigravity model quota                                                                                                                        |
| [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor)       | 8.8k  | Terminal monitor (Python) | Claude Code usage, predictions and alerts                                                                                                      |
| [Dicklesworthstone/coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) | 91    | CLI (Rust)                | Unified queries for 16+ providers                                                                                                              |

Difference: these are all **standalone apps or CLIs** that need separate installation and processes, invisible inside `pi-web-ui`. This plugin is a host-internal plugin —
nothing extra to install, quota goes straight into the conversation UI, and the model itself can query it with the `quota_status` tool. The cost is that it only works in this host.

## Permissions

`ui` (views), `http` (the plugin's own HTTP routes), `net` (outbound, only the hosts listed in `netAllowlist` in the manifest).
Server code uses `node:fs` to read local credential files — that's the plugin's existing permission model (it can be disabled at any time in the settings panel).

## Regression

```bash
npx vitest run tests/unit/quota-watch.test.ts tests/unit/quota-watch-card.test.ts
```

Covers: manifest shape, request and parsing for the three providers (including window normalization), access token expiry renewal,
401 retry, degradation without login state, local pi credential fallback, **querying only the current provider** (no network for others / no network when the switch is off / no network when the model isn't recognized),
single-provider wording for the badge and tooltip, AI summary wording; **the refresh chain** (TTL tiers, keeping the last successful numbers on failure,
both cards sharing one snapshot and updating together after a refresh, polling returning to the slow tier once the overlay closes); card content (balance/window/empty state/stale state/forced refresh/cleanup).
The overlay shell's positioning and open/close are the host's responsibility, regressed in `tests/unit/footer-slot-popover.test.ts` (`FooterBar`: clicking that text → overlay + cleanup)
and `tests/unit/floating-panel.test.ts` (`computeFloatingPosition`'s flipping/clamping).
