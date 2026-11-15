**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Run trace (run-trace)

A harness-like agent run-trace view: it shows the timeline of the **currently open conversation** directly and analyzes it — a top lane timeline for the big picture, click a segment for **analysis** (source/status/duration/share) instead of reading the conversation content again.

## What it looks like

```
🧭 运行轨迹 ● 实时    [写小说 ●当前] [修 bug]        搜索 [____]  ▶ 回放  EN  🗑
─────────────────────────────────────────────────────────────
09:01                                    用时 12分        09:13
输入  ▓▓────▓▓────────────────────────────────────────────
模型  ──▓▓▓▓▓▓▓▓▓▓▓▓▓────────────────────────────────────
工具  ──────▓▓▓▓▓▓─────────────────────────────────────────
──────────────────────────────┬────────────────────────────
分段列表                       │ 详情（概述/预览/原始内容/来源）
🧭 用户 · 第 1 轮 · 写个小说    │ 来源  工具 · edit
💭 思考                        │ 状态  已完成
✅ edit · novel.md · 1.2s      │ 时长  1.2s
📝 改动 1 个文件                │ 轮次  第 1 轮
🏁 …                           │ 📈 edit：累计 3 次 · 平均 1.1s ·
                               │   失败率 0% · 占工具耗时 62%
```

- **Top swimlanes**: the professional timeline engine vis-timeline (vendored, offline-first) — adaptive millisecond ticks, wheel zoom, drag pan, one-click fit; tool segments are colored by tool name (read = cyan, write = amber, bash = purple, the rest hash-assigned, legend the same color as the block), failures in red, running ones blinking, and clicking a block selects that segment; a missing vendor falls back to the CDN, and if that fails to a hand-written timeline.
- **Live flow (follow)**: while the conversation runs, the timeline anchors to "now" — **blocks slide smoothly left frame by frame while the time ticks stay pinned at fixed screen positions** (tick values scroll with time), a fixed "now" vertical line sits 40px from the right edge of the plot area, and new events appear against it and flow left; the right edge of a running block stays pinned to the "now" line and grows with real time. Wheel zoom does not exit follow (it re-anchors at the new zoom level), drag pan pauses follow (click「跟随」(Follow) to resume), and the end of a run exits smoothly with no content jump.
- **Left column**: segment list (user/thinking/reply/tool/file/system chips + time + duration).
- **Right column**: four-tab detail for the selected segment —
  - **Overview**: source/status/duration/round/length/position + analysis (tool segments: that tool's cumulative calls/average duration/failure rate/share of tool time).
  - **Preview/raw content/source**: content and provenance (message key, call id, round, conversation).
- **With nothing selected**: conversation-level analysis (total duration/rounds/tool calls and failures/tool time/slowest tools Top/file changes/phase distribution).
- **Replay**: plays in **real time** — each block dwells for its actual duration (second-long tools flash by, a long thinking block dwells that long), the playhead advances along the timeline and follows the window automatically; variable speed (0.5/1/2/4×), a「跳过空闲」(Skip idle) checkbox compresses long gaps between rounds; drag the progress bar to seek, plus play/pause.
- **Bilingual (Chinese/English)**, with filters (lane toggles + search).

## How it works

- Full history: `host.getActiveConversation()` (all messages + stats of the currently open conversation) → opening a conversation gives the complete timeline, and switching back to an older one gives it too.
- Live increments: `host.onRunEvent`'s tool_start/tool_end append or update tool segments in place (with exact duration/params/result); message/run_* events trigger a history refetch (debounced 300ms) + 5s streaming / 30s idle polling.
- Durations: the assistant timestamp is the message creation moment (the generation start, always right after the previous toolResult in the transcript): thinking/reply are laid out backwards from that moment, with duration estimated from character count (~50 chars/second), capped at the next message's timestamp (generation must finish before it), proportionally compressed when over the window, and joined to the tool call's start at the end; tool segment duration = result moment − call start (pure execution, no generation); instantaneous/very short events get a ≈2px minimum in the display layer only (a narrow bar derived from the current zoom window, so it stays visible and clickable), block widths stay strictly aligned with timeline ticks and converge back to the real duration once zoomed in — no more fixed fake widths stacking serial tool calls into a pile of rows.
- The initial overview auto-focuses the "active stretch": long idle gaps between rounds are trimmed so real work fills the viewport (falls back to the full range when rounds are quite scattered, no forced trim); the「⤢ 适应」(Fit) button still shows everything.
- Follow smoothness comes from two stages, "per-frame CSS transform displacement + window commit": `setWindow` fires once only after accumulated displacement ≥90px (the commit synchronously triggers a full vis redraw, so item re-layout and the transform reset land in the same frame, invisible to the eye); during follow the vis axes/grid are hidden and the plugin draws its own ruler (fixed position, values scrolling every second, step auto-chosen from 1s to 1 day by zoom).
- File segments: after a write-type tool (edit/write/patch…) succeeds, the path is pulled from the **call parameters**; historical toolCall parameters are covered the same way.
- Message bodies are not shipped by default (a single one can reach 200K): the list carries summaries only, details are pulled per segment on demand.
- Timeline vendor: `npm run build:runtrace-vendor` (rebuild after upgrading vis-timeline; the artifact is committed to git).

## Limitations

- Currently covers the **pi engine** only (the dsh engine has no snapshots/events, so the view is an empty state).
- Across restarts only the most recently opened conversation is kept ( the transcript itself is the source of truth, switching back rebuilds it; the plugin stores nothing extra).
