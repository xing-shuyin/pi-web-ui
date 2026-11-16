[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# SoL-Pi 状态与节省统计插件 (SoL-Pi Savings & Plan)

实时统计并展示 [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) 在当前打开会话中节省的上下文 Token（Observation Pack 大工具结果压缩、在线边界压缩）与 Plan 规划进度。

借鉴 [atfa/pi-sol-plan-footer](https://github.com/atfa/pi-sol-plan-footer) 的底栏适配设计，将实时数据直接展示在 `pi-web-ui` 的底部状态栏（`bottombar`）中。

---

## 特性

- ⚡ **Token 节省追踪**：实时分析会话消息流，统计被打包的大工具结果（Observation Pack）每次模型请求为用户节省的上下文 Token 数；
- 🎯 **规划状态展示**：如果会话中存在在线上下文规划（`sol-pi-online-context-state-v1`），提取当前步骤（如 `[Plan 1/3 ◐]`）并同步展示；
- 📊 **紧凑底栏设计**：直接展示在 `pi-web-ui` 底栏，悬停可查看包含工具明细与体积统计的 Tooltip；
- 🔍 **点击查看明细**：点击底栏徽标，弹出当前会话完整的节省数据、工具细分与计划详情。

---

## 安装

在 `pi-web-ui` 的「设置 → 插件市场」中一键启用 `sol-savings` 插件，或运行：

```bash
pi-web-ui install xing-shuyin/pi-web-ui/plugins/sol-savings
```
