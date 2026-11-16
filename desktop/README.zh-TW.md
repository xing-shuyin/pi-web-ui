[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# pi-web-ui 桌面版（Electron）

桌面版把 pi-web-ui 本地服務和應用視窗放在一起，適合希望直接開啟桌面應用的使用者；聊天、檔案、終端等功能複用網頁版。執行已打包的桌面應用無需另裝 Node.js 來啟動服務，但 Git/Bash、額外引擎及其依賴是否可用，取決於包內執行時和本機環境。

- [官網](https://xing-shuyin.github.io/pi-web-ui-site/) · [完整安裝與模型配置](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)
- [啟動引數](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#cli-and-env) · [本地 /setup 配置指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#setup-page)
- [下載最新 Release](https://github.com/xing-shuyin/pi-web-ui/releases/latest)

## 內建瀏覽器與 Agent 切換

桌面視窗內建多標籤瀏覽器，可在頂部切換「瀏覽器」「Agent」「分欄」。切換複用已有網頁和 Agent 檢視，保留網頁登入態、輸入內容和 Agent 草稿。瀏覽器先啟動，本地 Agent 服務並行啟動；服務不可用時仍可瀏覽網頁。

位址列支援輸入網址或搜尋詞，`Ctrl/Cmd+L` 聚焦位址列，`Ctrl/Cmd+T` 新建標籤，瀏覽器模式下 `Ctrl/Cmd+W` 關閉標籤，`Ctrl/Cmd+Shift+1/2/3` 切換三種模式。分欄模式可調整寬度。新標籤頁與瀏覽器設定提供書籤、歷史、下載、密碼保險箱和擴充套件載入入口；舊 AI Browser 資料可以選擇舊資料目錄匯入，已有檔案不會覆蓋。

內建 Agent 自動連線本地服務。需要使用遠端 Web Agent 時，在瀏覽器設定中填寫該服務地址並連線；之後使用內建瀏覽器開啟這個受信任地址，也可以通過原生頁面橋操作其他標籤，無需安裝 page-picker。AI 操作、截圖和指令碼執行各有開關，指令碼執行預設關閉。普通網站無法呼叫瀏覽器控制或讀取儲存。

Office 支援文本/CSV 編輯，以及 DOCX/XLSX/PPTX 的只讀內容預覽；複雜排版、圖片與公式計算不在當前預覽範圍。二進位制文件不會被當作文本覆蓋儲存。本地文件必須先通過檔案選擇器開啟。

模組邊界、許可權和構建說明見 [內建瀏覽器架構](../docs/architecture-browser.zh-TW.md)。

## 裝置中心整合瀏覽器

桌面端點選“開啟中心”，會開啟獨立的裝置中心視窗，用於登入、建立賬號及確認配對。主視窗繼續輪詢配對結果，確認後自動完成繫結；無需依賴系統瀏覽器的新標籤。相同中心重複開啟會複用視窗，視窗選單提供前進、後退、重新整理和返回中心首頁。

每個中心 origin 使用獨立的持久化 Electron session 儲存登入狀態，與本地應用及其他中心隔離。遠端視窗無 preload、無 Node 許可權、啟用 sandbox，不允許跨 origin 導航和瀏覽器許可權申請，不忽略證書錯誤。視窗標題始終顯示實際中心地址。普通網頁版仍使用瀏覽器原生新標籤。

此能力需要更新並重啟桌面殼，僅更新 Web 靜態資源不能增加 preload/IPC 能力。舊版桌面殼繼續使用原有外鏈方式。開啟失敗時頁面保留中心地址供手動訪問，主視窗配對等待狀態不受影響。

## 選擇與執行

| 形式                                            | 適用場景                 | 安裝和啟動                                                                                                        |
| ----------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Windows NSIS 安裝包 `*-setup.exe`               | 固定電腦使用             | 執行安裝程式，選擇安裝目錄，再開啟應用                                                                            |
| macOS `.dmg`                                    | Mac 桌面應用             | 將 `.app` 拖入 Applications 後開啟                                                                                |
| Linux `.AppImage`                               | Linux 桌面應用           | 賦予執行許可權後執行，如 `chmod +x ./檔名.AppImage`                                                               |
| Windows `pi-web-ui-desktop-<版本>-portable.zip` | 隨行動硬碟攜帶程式和資料 | 完整解壓到可寫目錄，執行根目錄的 `啟動Pi.bat` 或 `PiPortable.bat`，詳見 [便攜版說明](../launcher/README.zh-TW.md) |

Windows 便攜 ZIP 是 Electron 應用加 `.bat` 啟動指令碼，執行它不需要 Python；它與 Python launcher 不是同一種分發形式。當前倉庫的 `launcher/` 不含 Python 啟動器。macOS 的更新用 ZIP 也不是 Windows 便攜包。

首次進入應用後配置模型與認證。`/setup` 用於服務訪問與網路配置，模型 API Key 在工作區設定中配置；需要開啟 setup 時使用實際服務地址，例如預設埠下的 `http://127.0.0.1:8790/setup`，不要照搬網頁版的 `8787`。

未經簽名或公證的包可能被系統攔截，具體以下載產物為準。Windows 可能顯示 SmartScreen 提示。macOS 若提示“已損壞”或被 Gatekeeper 攔截，在確認來源可信並將應用放入 Applications 後，可清除隔離屬性再開啟：

```bash
xattr -dr com.apple.quarantine /Applications/pi-web-ui-desktop.app
open -a /Applications/pi-web-ui-desktop.app
```

## 資料、埠與使用限制

非便攜模式下，Electron 自身狀態位於系統的 Electron `userData` 目錄；服務資料預設在其 `data/` 子目錄。`userData` 的具體位置受系統與應用名影響，應結合啟動日誌確認，不要將安裝目錄當成資料目錄。

| 配置                       | 實際行為                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `PI_WEB_DATA_DIR`          | 覆蓋 WebUI 配置、外掛等資料目錄；非便攜預設 `<userData>/data`，與 CLI 的 `~/.pi-web` 分開                   |
| `PI_CODING_AGENT_DIR`      | 覆蓋 pi 配置、認證與會話目錄；非便攜預設共享 `~/.pi/agent`                                                  |
| `PI_WEB_CWD`               | 覆蓋初始工作區；非便攜程式碼預設使用者主目錄，建議顯式指定專案目錄，避免把整個家目錄作為工作區              |
| `PI_WEB_PORT`              | 顯式指定時優先嚐試該埠；未設時優先 `8790`，所選端口占用則退回隨機空閒口                                     |
| `PI_WEB_HEALTH_TIMEOUT_MS` | 等待 `/api/health` 的毫秒數，預設 `60000`；正數最少 `1000`，非法值或非正數回落預設值                        |
| 訪問口令環境變數           | 設定服務訪問口令；桌面視窗首次載入時帶 `?token=` 完成鑑權，隨後前端清除 URL 中的 token                      |
| `PI_WEB_DESKTOP_URL`       | 僅開發模式可將視窗指向已有服務；打包版忽略，見下文聯調方式                                                  |
| `PI_WEB_SDK=bundled`       | 強制使用自帶 pi SDK；預設會在檢測到機器上更新的 pi 副本時跟隨，詳情見 [環境變數](../docs/env-vars.zh-TW.md) |

固定埠讓 Chromium 的 Origin 保持穩定，有助於保留主題、面板寬度等 localStorage 設定；回落隨機埠後，這些按 Origin 儲存的介面狀態可能不同。桌面 sidecar 固定監聽 `127.0.0.1`；需要遠端部署請參考[部署文件](../docs/deployment.zh-TW.md)。

- 與 CLI/網頁版並用時，預設共享的 `~/.pi/agent` 包含會話記錄，避免兩個服務同時操作同一對話；要隔離可設定 `PI_CODING_AGENT_DIR`。不要讓兩個服務同時寫同一 WebUI data-dir。
- `browser_page` 依賴瀏覽器 page-picker 擴充套件，在 Electron 視窗中不可用；請在支援該擴充套件的瀏覽器中開啟服務地址並授權頁面。其他瀏覽器工具有各自的執行條件。
- renderer 開啟 `contextIsolation`、`sandbox`，關閉 Node 整合；應用外部導航經過 URL 守衛，允許的外鏈交給系統瀏覽器。工具和外部程式仍可能訪問本機資源，這些設定不等於作業系統級隔離。
- 便攜模式重定向主要應用資料，不保證作業系統、臨時目錄、外部 CLI 或使用者選擇的工作區不留下痕跡。

## 升級與備份

安裝版可在應用更新面板檢查、下載並安裝更新。主程序通過 `electron-updater` 讀取 GitHub Release 的 `latest*.yml`：啟動時僅檢查後設資料，不自動下載；使用者下載完成後可“安裝並重啟”，退出時也允許安裝。能否更新取決於對應平臺的產物、feed、網路和系統簽名要求，不能保證每一種解包目錄都支援原地更新。

`npm i -g pi-web-ui@latest` 更新的是全域性 npm 包，不會替換桌面應用內部的 `dist/server`。更新失敗時，從 Release 下載對應平臺的新包安裝；先退出應用並備份 WebUI 資料目錄及 Agent 目錄。便攜 ZIP 應按[便攜版手動升級步驟](../launcher/README.zh-TW.md#升級與遷移)操作，避免更新後改變便攜佈局。

## 從原始碼執行與構建

以下命令均在倉庫根目錄執行。需要 Node.js **>=22.19.0**、npm，以及包含 devDependencies 的依賴安裝。桌面 scripts 定義在根 [package.json](../package.json)，沒有獨立的 `desktop/package.json`。

```bash
npm ci
npm run build           # 生成服務端、前端和配套執行資源
npm run desktop:dev     # 編譯桌面殼，再以 Electron 啟動本地 sidecar
```

`desktop:dev` 只執行 `build:desktop` 後啟動 Electron，不會重建服務端或前端；修改這些內容後需要重新 `npm run build`。需要 Vite 熱更新時，在一個終端執行 `npm run dev`（服務端 `8788`、前端 `5173`），另一個終端啟動桌面殼：

```bash
# POSIX shell
PI_WEB_DESKTOP_URL=http://localhost:5173 npm run desktop:dev
```

```powershell
# PowerShell
$env:PI_WEB_DESKTOP_URL = 'http://localhost:5173'
npm run desktop:dev
Remove-Item Env:PI_WEB_DESKTOP_URL
```

此 override 直接使用已有地址，不另起 sidecar；聯調資料與埠由單獨啟動的開發服務決定。

| 命令                            | 構建內容與輸出                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run build:desktop`         | 僅用 `desktop/tsconfig.json` 編譯桌面殼到 `dist/desktop/`                                     |
| `npm run desktop:dist`          | 先構建應用與桌面殼，再按 electron-builder 配置生成當前平臺產物，輸出到 `release/`             |
| `npm run desktop:portable`      | 構建應用與桌面殼，再組裝 Windows `release/PiWebUI-Portable/`；預設不下載 Git/Node，不生成 ZIP |
| `npm run desktop:portable:full` | 同上，但增加 `--with-git`；名稱中的 full 不表示包含獨立 Node.js                               |

Windows 便攜組裝建議在 Windows 上執行。已完成 `npm run build` 和 `npm run build:desktop` 後，可直接傳組裝引數：

```bash
node scripts/make-portable.mjs --with-git --with-node --zip
# 僅當 release/win-unpacked 已確認是本次目標構建時：
node scripts/make-portable.mjs --skip-pack --with-git --with-node --zip
```

組裝指令碼不是升級器：每次都會替換輸出的 `app/` 並清空 `data/` 下的八個標準子目錄，勿在使用中的便攜目錄上重跑。它還會複用已有 `runtime/`，所以無下載引數不代表輸出一定不含舊執行時。electron-builder 失敗時，指令碼可能回落到已有 `release/win-unpacked`；分發前確認版本與執行時內容。

### 卡在 `packaging` 不動

electron-builder 列印 `• packaging platform=win32 ...` 之後長時間無輸出、CPU 與網路都靜止時，按順序排查（兩種原因看起來都是「卡住」）：

1. **殘留下載鎖**：上次打包被 `Ctrl+C`/強殺後，`%TEMP%\eb-dl-*.lock.lock` 目錄會殘留，新程序要等 `proper-lockfile` 判定過期（10 分鐘）才繼續。刪掉這些目錄即可立刻恢復。
2. **重新下載 Electron**：`@electron/get` 命中本地快取後仍要拉 `SHASUMS256.txt` 做校驗，直連 GitHub 失敗（`UND_ERR_CONNECT_TIMEOUT`）就會回落到重下 158MB 的 Electron zip，國內常見幾十 KB/s。映象統一由 `scripts/lib/electron-mirror.mjs` 提供，`npm run desktop:dist` 與 `scripts/make-portable.mjs` 已經由包裝器 `scripts/run-electron-builder.mjs` 在子程序裡注入 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（自己帶同名的非空環境變數即可覆蓋，方便走代理）。**不要再把這些 URL 寫進 `.npmrc`**：npm 11 會把自定義鍵當成未識別配置逐條告警，npm 12 起不再透傳 `npm_config_*`，映象會靜默失效（守衛：`tests/unit/electron-mirror-guard.test.ts`）。繞過包裝器直接 `npx electron-builder` 時，需自行帶上述兩個環境變數。

首次 `npm install` 會由 `electron` 包的 postinstall 下載 Electron 二進位制，那一步沒有包裝器可用：國內網路請先設定 `ELECTRON_MIRROR`（或使用者級 `~/.npmrc` 的 `electron_mirror`，代價是每條 npm 命令都會有一條未識別配置警告）。

想看它究竟停在哪一步，加 `DEBUG='electron-builder*,@electron/get*'` 重跑，日誌會顯示是等鎖還是下載。

`--with-git` / `PI_BUNDLE_PORTABLE_GIT=1` 下載 PortableGit，`--with-node` / `PI_BUNDLE_PORTABLE_NODE=1` 下載獨立 Node.js；下載和解壓需要網路及可用的 `curl`、解壓工具。`--zip` 額外生成 `release/pi-web-ui-desktop-<版本>-portable.zip`。當前指令碼固定下載 Windows x64 的 Git/Node，不是通用跨平臺執行時。完整佈局與手動補充方法見[便攜版說明](../launcher/README.zh-TW.md)。

## 開發架構與打包配置

```text
Electron 主程序（desktop/main.ts）
  ├─ Electron 二進位制 + ELECTRON_RUN_AS_NODE=1
  │    └─ dist/server/index.js --host 127.0.0.1 --port <選定埠>
  └─ /api/health 就緒後，BrowserWindow 載入本地服務
```

服務端以 sidecar 子程序執行，複用 `dist/server` 和 `web/dist`；前端繼續使用 `appUrl("/ws")` 與 `location.host`，無需另起桌面 wire 協議。啟動超時或 sidecar 在就緒前退出會使桌面應用非零退出。應用退出時清理 sidecar；macOS 關閉所有視窗後應用仍可駐留；當前實現再次點選 Dock 時會退出，需重新啟動應用。完全退出才結束服務。單例項鎖用於再次啟動時聚焦已有視窗。

維護時需保留這些約束：

- [main.ts](./main.ts) 是主程序入口，[preload.cts](./preload.cts) 提供視窗和更新 IPC，[startup.ts](./startup.ts) 負責啟動輔助邏輯，[portable.ts](./portable.ts) 負責便攜路徑探測與環境注入。
- ESM 入口不能頂層 `await app.whenReady()`：Electron 等入口求值結束才發 ready，會互相等待。保持 `app.whenReady().then(...)` 的啟動方式。
- [electron-builder.yml](./electron-builder.yml) 用 `extraMetadata.main` 覆蓋根包的 CLI 入口為 `dist/desktop/main.js`；`asar: false` 讓 sidecar 和原生模組直接從檔案系統執行。
- `npmRebuild: false` 基於當前 `node-pty` 的 N-API 預編譯產物；升級原生依賴時需重新核實目標平臺支援，不能據此承諾所有平臺都不需要編譯工具。
- 圖示來源為 `web/public/icons/icon-1024.png`。Windows 目標為 NSIS + dir，macOS 為 DMG + ZIP，Linux 為 AppImage。macOS ZIP 用於 updater；Windows NSIS 產物名保持無空格，避免 feed 與 Release 資產 URL 不一致。

## 釋出與簽名

[desktop-release.yml](../.github/workflows/desktop-release.yml) 在 `v*` tag 推送時，分別在 Windows/macOS/Linux runner 構建並上傳 Release 資產；手動執行只生成 workflow artifact。electron-builder 使用 `--publish never` 生成產物與更新後設資料，隨後由 `gh release upload` 上傳。

當前 Windows CI 另執行 `make-portable.mjs --skip-pack --zip --with-git --with-node`，因此該工作流成功生成的便攜 ZIP 會嘗試捆綁 Git 與獨立 Node；本地基礎構建沒有這兩個預設下載選項。分發前仍需核實 `runtime/git/cmd/git.exe` 和 `runtime/node/node.exe`，指令碼部分解壓失敗僅發出警告。

Windows CI 已接入 SignPath，但簽名步驟允許失敗，且當前配置使用 `test-signing`；不能把所有 Release 產物視為已受信任簽名。便攜目錄在簽名替換安裝器之前組裝，也不能從安裝器簽名推斷 ZIP 內應用的簽名狀態。

本地 electron-builder 可通過 `CSC_LINK` 和 `CSC_KEY_PASSWORD` 提供簽名證書。macOS 的 Developer ID 簽名和公證需要相應 Apple 憑據與環境，例如 `APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；是否成功應檢查構建輸出及實際產物。SignPath 不替代 macOS 簽名/公證，自簽名證書也不等於獲得系統信任。完整發布流程見[釋出文件](../docs/release.zh-TW.md)。
