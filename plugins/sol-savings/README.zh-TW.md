[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# SoL-Pi 狀態與節省統計外掛 (SoL-Pi Savings & Plan)

即時統計並展示 [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) 在當前開啟會話中節省的上下文 Token（Observation Pack 大工具結果壓縮、線上邊界壓縮）與 Plan 規劃進度。

借鑑 [atfa/pi-sol-plan-footer](https://github.com/atfa/pi-sol-plan-footer) 的底欄適配設計，將即時資料直接展示在 `pi-web-ui` 的底部狀態列（`bottombar`）中。

---

## 特性

- ⚡ **Token 節省追蹤**：即時分析會話訊息流，統計被打包的大工具結果（Observation Pack）每次模型請求為使用者節省的上下文 Token 數；
- 🎯 **規劃狀態展示**：如果會話中存在在線上下文規劃（`sol-pi-online-context-state-v1`），提取當前步驟（如 `[Plan 1/3 ◐]`）並同步展示；
- 📊 **緊湊底欄設計**：直接展示在 `pi-web-ui` 底欄，懸停可檢視包含工具明細與體積統計的 Tooltip；
- 🔍 **點選檢視明細**：點選底欄徽標，彈出當前會話完整的節省資料、工具細分與計劃詳情。

---

## 安裝

在 `pi-web-ui` 的「設定 → 外掛市場」中一鍵啟用 `sol-savings` 外掛，或執行：

```bash
pi-web-ui install xing-shuyin/pi-web-ui/plugins/sol-savings
```
