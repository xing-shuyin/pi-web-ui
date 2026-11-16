[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# mermaid 外掛（renderer 外掛）

把訊息裡的 ` ```mermaid ` 圍欄渲染為 SVG 圖表——**fenced-code 渲染外掛機制**的第一個實現。

## 安裝（外掛不進 npm 包，隨倉庫分發）

```bash
# 從 GitHub 裝（主倉庫 plugins/mermaid 子目錄，install 原生支援子路徑）
pi-web-ui install xing-shuyin/pi-web-ui/plugins/mermaid

# 或本地已 clone 倉庫時，把目錄複製進資料目錄
cp -r plugins/mermaid "<dataDir>/plugins/mermaid"
```

裝完重新整理頁面即可；頂欄/設定面板的「介面外掛」裡能看到它。不需要時 `pi-web-ui uninstall mermaid` 或刪除目錄，` ```mermaid ` 回退普通程式碼塊。

## 引擎（本地 vendor 優先，CDN 回退）

- `client/vendor/mermaid.bundle.mjs` 是打包好的自包含引擎（構建產物，見
  `scripts/build-mermaid-vendor.mjs`）——**隨外掛目錄一起復制/安裝後完全離線渲染**，
  不碰網路；（放在 client/ 子樹是因為外掛的靜態服務只暴露 `/plugins/:id/client/*`）
- 如果目錄裡沒有 vendor（比如只想省體積只拷 manifest + entry.mjs），外掛自動
  回退 CDN（esm.sh）懶載入。**CDN 只是降級手段**：地址在 `client/entry.mjs`
  裡釘死與 vendor 一致的精確版本（`mermaid@12.0.0`）——浮動大版本會拉到行為
  不同的新引擎，渲染/主題 API 可能漂移；生產與離線環境應始終帶上 vendor；
- 離線環境需要 mermaid 時，把 `client/vendor/` 放進外掛目錄即可，無需改任何配置。

## 它是怎麼工作的

- `manifest.json` 宣告 `renderers: ["mermaid"]` + `view: false`（沒有獨立檢視 tab）。
- `client/entry.mjs` 匯出 `renderers.mermaid(code, ctx) → HTMLElement | null`。
- 主應用（`web/src/plugin-fence.ts`）維護「語言 → 外掛」登錄檔；`Markdown.tsx` 遇到
  ` ```mermaid ` 圍欄時**按需懶載入**本外掛 bundle 並渲染——平常聊天從不下載任何東西。

## 關閉渲染

不想要圖表渲染時 `pi-web-ui uninstall mermaid` 或刪除外掛目錄即可：沒有外掛認領
` `` ```mermaid `` ` 圍欄時，主應用總是按普通程式碼塊顯示，無需任何配置開關。

## 如何寫自己的 renderer 外掛

參照本目錄結構：`manifest.json` 宣告 `renderers:[...]`，`client/entry.mjs` 匯出
`{ renderers: { "<lang>": (code, ctx) => HTMLElement|null } }`。詳見
`docs/architecture-plugins.md` 的「fenced-code 渲染外掛（renderer plugins）」一節。
