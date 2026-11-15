[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 📬 demo-mailbox —— 外掛開發示例

pi-web-ui 可選介面元件的**最小可執行示例**：演示「服務端入口 index.mjs +
客戶端檢視 client/entry.mjs + 雙向訊息」的完整鏈路。兼作
`tests/plugin-test.mjs` 的協議測試夾具。

## 它做什麼

- 記憶體裡預置兩封示例郵件 + 一個回聲表單
- 客戶端檢視渲染郵件列表和傳送表單；傳送的訊息經 WebSocket 到服務端，
  服務端廣播回所有開啟的頁面（多標籤頁即時同見）
- 演示 `host.onMessage` / `host.broadcast` / `host.notify` 三個宿主 API 的用法

## 目錄結構

```
demo-mailbox/
├── manifest.json      # 外掛清單（id/icon/name/version/description）
├── index.mjs          # 服務端入口：export default { activate(host) → deactivate? }
└── client/entry.mjs   # 檢視入口：export default { mount(el, ctx) → cleanup? }
```

## 本地試用

```bash
# ── 安裝 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/demo-mailbox
pi-web-ui install plugins/demo-mailbox   # 或本地目錄

# ── 檢視 / 解除安裝 ──
pi-web-ui plugins                            # 列出已裝外掛與 id
pi-web-ui uninstall demo-mailbox             # 或 rm -rf ~/.pi-web/plugins/demo-mailbox

# ── 更新 ──
pi-web-ui install ...同上... --force          # 覆蓋重灌
cp -r plugins/demo-mailbox ~/.pi-web/plugins/
```

重新整理頁面，頂欄出現 📬 標籤即成功。刪掉該目錄再重新整理即解除安裝——外掛
「不裝即不存在」，無需任何註冊步驟。

## 給外掛開發者的提示

- 服務端可以訪問 Node 全部能力（真實外掛如 webmail 在這裡接 IMAP/SMTP）；
  憑據只存 `<pluginDir>/`，不要寫進程式碼庫
- 客戶端與主應用只有兩條窄通道：`ctx.send()` 上行、`ctx.onData()` 下行，
  不共享 React 例項
- 帶請求語義的上行必須自帶 `reqId`，響應靠它匹配併發；無 reqId 的響應會被
  客戶端靜默丟棄
- 協議約定詳見 pi-web-ui 主 README「外掛」章節與 AGENTS.md
