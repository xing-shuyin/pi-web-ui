**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# SoL-Pi Status and Savings Plugin (SoL-Pi Savings & Plan)

Counts and shows, in real time, the context tokens [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) saved in the currently open session (Observation Pack compression of large tool results, online boundary compaction) along with Plan progress.

Borrowing the bottom-bar adaptation design from [atfa/pi-sol-plan-footer](https://github.com/atfa/pi-sol-plan-footer), it shows the live data directly in `pi-web-ui`'s bottom status bar (`bottombar`).

---

## Features

- ⚡ **Token savings tracking**: analyzes the session message stream in real time and counts the context tokens the packed large tool results (Observation Pack) save the user on every model request;
- 🎯 **Plan status display**: if the session has online context planning (`sol-pi-online-context-state-v1`), extracts the current step (such as `[Plan 1/3 ◐]`) and shows it in sync;
- 📊 **Compact bottom-bar design**: rendered right in the `pi-web-ui` bottom bar, with a tooltip on hover carrying per-tool details and size statistics;
- 🔍 **Click for details**: click the bottom-bar badge to open the current session's full savings data, per-tool breakdown and plan details.

---

## Installation

Enable the `sol-savings` plugin in one click under 「设置 → 插件市场」(Settings → Plugin Marketplace) in `pi-web-ui`, or run:

```bash
pi-web-ui install xing-shuyin/pi-web-ui/plugins/sol-savings
```
