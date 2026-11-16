**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Scheduled Task Sign-off Center (Approval Gate)

An asynchronous pending-item sign-off center plugin for scheduled tasks, background batch jobs and external callers.

> **Architectural distinction**:
> This plugin is an **async task decision ledger** (a scheduled task discovers a pending item and registers it; a human reviews it in one place in the UI and jumps to the conversation to handle it);
> real-time interception of high-risk tool calls in the agent runtime, pop-up approval, allowlist memory and the decision log are the server's **built-in security capability** (`server/tool-approval.ts`) and do not depend on this plugin.

## Features

1. **Centralized pending ledger**: the top bar's 「拍板」(Sign-off) tab and a red-dot badge show how many items await sign-off, aggregating everything unresolved.
2. **Generic CLI**: ships the command-line tool `bin/approval-gate.mjs` so any cron script or automation task can register an item in one call.
3. **Conversation linkage and automatic clearing**:
   - associates the given `conversationId` at registration time;
   - one click on a pending item jumps into that conversation for review;
   - supports `--auto-session`: the item is registered first, `pi -p` automatically starts a snapshot session with a generated prompt template, and the ledger clears automatically once the user signs off inside the conversation.
4. **Secure authentication**: the CLI passes the auth token in HTTP request headers (`x-pi-token` / `Authorization: Bearer`), so the token never leaks through a URL query string.

## CLI usage

```bash
# register a plain sign-off item
approval-gate register --task "每日备份检查" --title "发现 3 个过期未归档镜像，是否清理？" --project /path/to/project

# create a snapshot session and link it automatically
approval-gate register --task "依赖安全告警" --title "发现 CVE-2026-xxxx" --auto-session "请审查依赖漏洞并评估升级方案"

# list pending items
approval-gate list --pending

# mark resolved or dismissed
approval-gate resolve --id apv-xxx --status resolved
approval-gate resolve --id apv-xxx --status dismissed
```
