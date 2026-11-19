# Web Inspect（网页拾取）

No-extension page capture for AI debugging — bookmarklet + tab + agent tools.

## 用法（3 步）

1. 打开 pi-web-ui 的 **🎯 Web Inspect** Tab，把书签 `WI-抓页+日志+点选` 拖到浏览器收藏夹；
2. 在目标网站（登录态照常用）点书签一次 = 发快照 + 开始记录点击/输入 + 进入点选模式（红框跟随，点中即回传，`Esc` 退出）；
3. 回 Tab 看日志 → **送入聊天**（经 `compose` 注入输入框）或让 AI 直接读工具。

## AI 工具（只读，v1）

- `web_inspect_state` — 最新页面 + 点选元素 + 近 20 条日志（Markdown）；
- `web_inspect_log {limit?, kind?}` — kind：`pick / snap / click / input / submit / change / note / event`。

## 为什么是书签而不是 iframe/扩展

- 登录页普遍 `X-Frame-Options: DENY`，iframe 嵌不进；书签跑在用户自己浏览器里，登录态天然可用（同 OpenCode Browse 的思路）；
- 跨域回传用无预检 GET 信标（`Image.src`），免 CORS、免装扩展、手机/桌面浏览器都可用；
- 快照 > 7KB 时信标截断 → 用 Tab 内「手动粘贴快照 JSON」（同源 POST，不受限）。

## 对标

| 能力 | Codex Browser Use | Playwright / chrome-devtools MCP | web-inspect v1 |
|---|---|---|---|
| snapshot → 按 ref/selector 操作 | ✅（自带浏览器/CDP） | ✅ snapshot+ref | 快照+selector ✅，反向操作 v2 |
| console 日志 | ✅ | ✅ | 点击/输入/提交日志 ✅（页面 console v2） |
| 登录态 | 扩展/自带浏览器 | 自带 profile | 用户真机浏览器 ✅ |
| Termux（无 Chrome） | ❌ | ❌ | ✅ |

## 路线图（v2）

- `web_inspect_act`：AI 下发点击/填表意图 → `sendTo` 指定 client → Tab 内确认后在书签页执行（pending Map + 超时，人必须在场点确认）；
- console 错误捕获（书签注入 `window.onerror` 上报）；
- 快照分片信标（`seq/total`）。

## Files

- `manifest.json`（`view:true` 顶栏 Tab，权限 `ui/tools/http`）
- `index.mjs`（信标 `/collect`、`/state`、`/collect POST`、两工具）
- `client/entry.mjs`（Tab UI + 书签生成 + compose 送入聊天）
