**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# AI Response Speed Monitor Plugin (Response Speed)

Monitors the AI's latest and average response speed in real time and shows both in the bottom status bar, with independent measurement for every iteration of an AI self-loop.

## What is response speed?

**Response speed** (Time to First Token, **TTFT**):
the time from **sending a message request to the AI until the first reply data packet comes back**.

It reflects the combined latency of model network delay, inference cold-start queuing, server-side processing and first-token generation.

## Key features

- 📊 **Dual metrics in the bottom status bar (latest / average)**:
  - shows the current conversation's latest request and its historical average as a modern, minimal badge in the bottom bar (`bottombar`) (compact pure values such as `12.7/14.3`; hover reveals the full description and millisecond timings);
  - clean and stable: never shows 「响应中…」(Responding…), always the conversation's previous duration, so reading immersion is not broken;
  - clean design: no floating window injected in the top-right corner, no hacking the underlying WebSocket — everything is driven by the server's authoritative run trace.
- 💬 **Independent recording and isolation per conversation**:
  - each session records and aggregates TTFT samples on its own, with no cross-talk;
  - switching conversations updates the bottom bar instantly and seamlessly to that conversation's latest and average, and a new conversation starts measuring from an empty state.
- 🔄 **Independent measurement for every AI self-loop iteration**:
  - when the AI calls tools and enters a self-loop (multi-turn) after the tools finish, every new request to the model **gets its own timing**;
  - the first-packet latency of every turn is captured accurately.
- 📈 **Multi-dimensional stats and dashboard**:
  - click the bottom-bar badge to open the current conversation's response speed dashboard;
  - view average response speed (Average Latency)
  - view current/latest answer speed (Latest Latency)
  - view fastest and slowest response times (Min / Max Latency)
  - a sample-by-sample history table and one-click clearing of the current conversation's records.

## Installation and configuration

The plugin ships in the official plugin set at `plugins/response-speed` and works out of the box.
Enable it under Settings -> UI plugins and it takes effect.
