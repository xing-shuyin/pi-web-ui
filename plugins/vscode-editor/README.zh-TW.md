[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# 📝 vscode-editor —— pi-web-ui 編輯器 + SSH 外掛（Remote-SSH）

在 pi-web-ui 介面裡提供一個類 VSCode 的工作臺檢視：

- **多根檔案樹**：本地工作區 + 已儲存的 SSH 主機（同一棵樹、同一組標籤頁）
- **工作區跟隨**：主應用切換專案（set_cwd）後，本地樹根目錄即時切到新專案——
  自動清理目錄快取/展開狀態、關閉本地標籤（有未儲存修改會提示），遠端 SSH
  標籤與連線不受影響；`.vscode/sftp.json` 每專案獨立，切換後自動重讀
- **CodeMirror 6 多標籤編輯器**：本地/遠端檔案同開，語法高亮、Ctrl+S 儲存
  （遠端檔案經 SFTP 寫回）、CRLF 行尾保留、Ctrl+P 快速開啟（本地）
- **底部可拖拽終端面板**：每臺已連線主機可開多個 shell（xterm.js），視窗
  尺寸同步、keepalive 保活；右鍵遠端檔案/資料夾可在所在目錄開啟終端
- **右鍵選單繼承宿主擴充套件點（contextmenu.file）**：本地檔案樹右鍵直接撥出宿主
  全域性統一的右鍵選單，自動繼承宿主內建檔案操作及所有其他外掛註冊的能力
  （如配合 `@plugins/sftp` 外掛時，右鍵自動出現「上傳到遠端 / 上傳此目錄 / 從遠端下載 /
  新增到 SFTP 忽略」等完整能力，無需在編輯器內單獨配置與維護）
- **下載到電腦**（右鍵選單）：本地檔案直下；遠端檔案/資料夾不經工作區對映、
  資料夾在遠端就地 tar.gz 打包，儲存位置自選
- **上傳檔案**：工具欄 ⬆ 一鍵上傳到工作區根目錄；右鍵選單「上傳檔案到此處…」
  （資料夾行 → 該資料夾、檔案行 → 其所在目錄、樹內**空白處右鍵** → 該樹根目錄/
  首臺已連 SSH 主機根；本地與遠端 SFTP 均支援）；拖拽檔案到檔案樹——資料夾行 →
  該資料夾、檔案行 → 其所在目錄、空白處 → 根目錄（分片協議帶覆蓋確認與進度提示，
  樹內拖拽會被外掛攔截，不會觸發主應用的「附加到對話」）

原獨立的 ssh 外掛已合併進來：舊 `<pluginDir>/ssh-hosts.json` 主機配置在首次
啟用時自動遷移，無需手工搬。

## SSH config 自動載入（與 VSCode Remote-SSH 同源）

- **免匯入直連**：SSH 面板頂部「⚙ ssh config（自動載入）」區直接列出
  `~/.ssh/config` 裡的所有主機，點別名即連——VSCode 裡能連的這裡也能連，
  改完 config 點 ⟳ 重新整理即生效，無需匯入到手動主機。
- **寫法完全一樣**：就是 OpenSSH config 語法。`Host` / `HostName` / `User` /
  `Port` / `IdentityFile`（多個全試）/ `ProxyJump`（多跳逗號分隔）/
  `ProxyCommand`（`%h`/`%p` 展開）/ `ForwardAgent` 全支援；`Host *` 通配塊作
  預設值繼承（`ssh -G` 語義：首值優先）；`Include` 遞迴展開（含 glob，
  相對 `~/.ssh/` 解析）——VSCode 的 `Remote-SSH: Open Configuration File`
  改的同一個檔案，面板 ✎ 可直接編輯（儲存自動備份 `config.bak`）。
- **認證同 ssh 命令**：IdentityFile 全部試讀（`~` 展開）→ 本機預設私鑰
  （`~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`）→ `SSH_AUTH_SOCK`；
  config 裡沒有密碼欄位（和 VSCode 一樣），要用密碼登入的請用「🏠 手動主機」。
- 手動主機（`ssh-hosts.json`，密碼/私鑰進加密儲存）與批次匯入保留，AI 的
  `vsc_ssh_connect` 傳 `alias` 引數可直連 config 主機。

## 檔案樹互動

- **原地展開/收起**：點資料夾只加載該目錄子列表（帶「⏳ 載入中」佔位），
  不整樹重繪閃爍；收起零延遲
- **選中高亮**：點/右鍵任意行都高亮選中，工具欄 ＋📄/＋📁 以當前選中目錄
  為落點（選檔案則落在其所在資料夾）；新建/建立副本成功後新條目成為選中項
- **右鍵選單**：本地樹無縫繼承宿主 `contextmenu.file` 全域性右鍵選單，具備
  完整的檔案操作與第三方外掛（如 `@plugins/sftp`）能力；遠端樹支援：新建 / 重新命名 /
  刪除（目錄遞迴刪）/ 剪下 / 複製 / 貼上到此處（同 scope 內移動或複製）/
  建立副本（`foo_copy.js`，重名自動遞增）/ 複製路徑 / 上傳檔案到此處… /
  下載到電腦 / 開啟終端（遠端行，scope 感知）
- **檔名搜尋**：兩棵樹工具欄 🔍（本地全倉 / 遠端以當前選中目錄為起點收窄），
  結果複用 Ctrl+P 浮層（遠端命中帶 🌐 標記），點選即開啟

## 統一範圍模型

scope = `"local" | connId`。前端所有檔案操作（list/read/write/create/rename/
delete/copy/search）攜帶 scope，遠端時自動附加 connId——服務端據此路由到本地
fs 或該連線的 SFTP，前後端共用一套程式碼路徑。`copy` 語義：`src` + `dest` 均為
完整路徑（本地相對工作區、遠端絕對路徑），`dest` 已存在一律拒絕（副本名由
呼叫方按 `_copy` 字尾算好），`move: true` 為移動/改名；`search` 為檔名
大小寫不敏感子串搜尋（50 條封頂，本地 `base` 相對路徑、遠端 `baseDir` 絕對路徑）。

## 目錄結構

```
vscode-editor/
├── manifest.json        # 外掛清單（id/icon/name）
├── index.mjs            # 服務端入口：本地檔案 CRUD / SSH 主機管理 + 連線池 + PTY shell + exec + 遠端 SFTP 操作
├── src/client.js        # 客戶端原始碼（CodeMirror 6 + xterm.js）
├── build.mjs            # esbuild 打包指令碼（xterm CSS 內聯為文本）
├── package.json         # 構建/依賴清單（ssh2 為 devDep，執行時由服務端自動補裝）
└── client/entry.mjs     # 構建產物（自包含 bundle，瀏覽器直接載入）
```

## 安裝 / 解除安裝 / 更新

```bash
# ── 安裝 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor
pi-web-ui install plugins/vscode-editor  # 或本地目錄（開發態）
# 可選：--data-dir <dir> 自定義資料目錄（預設 ~/.pi-web）

# ── 檢視 ──
pi-web-ui plugins                            # 列出已裝外掛與 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/vscode-editor --force
                                             # --force 覆蓋重灌即更新
                                             # ⚠ 先備份外掛目錄裡的 ssh-hosts.json 與
                                             #   工作區 .vscode/sftp.json（主機憑據/同步配置）

cp -r plugins/vscode-editor ~/.pi-web/plugins/  # 本地開發態：改完 src 後先 npm run build 再複製
                                             # Windows: %USERPROFILE%\.pi-web\plugins\vscode-editor
                                             # 只需 manifest.json + index.mjs + client/ 三部分，
                                             # node_modules / src / build.mjs 不需要複製

# ── 解除安裝 ──
pi-web-ui uninstall vscode-editor            # 移除外掛目錄（ssh-hosts.json 一併刪除）
# 手動方式：rm -rf ~/.pi-web/plugins/vscode-editor
```

重新整理頁面後頂欄出現 📝 標籤即成功。依賴 ssh2 不隨包分發，首次啟用自動 npm
補裝到外掛目錄（失敗可點側欄「⚠ssh2」按鈕手動觸發）。
