[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# Windows Electron 便攜版啟動說明

本目錄提供 Windows Electron 便攜包使用的 `.bat` 啟動與快捷方式指令碼。下載 `pi-web-ui-desktop-<版本>-portable.zip` 後，完整解壓即可使用；單獨下載此目錄沒有應用程式，不能啟動 pi-web-ui。

這裡的啟動器不是 Python launcher：當前目錄沒有 Python 指令碼，也不需要 Python 來執行這些批處理入口。如果你使用的是另行分發的 Python launcher，請遵循該分發包自己的安裝和執行說明，不要混用此處的目錄佈局或構建命令。

- [官網](https://xing-shuyin.github.io/pi-web-ui-site/) · [完整安裝與模型配置](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)
- [本地 /setup 配置指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#setup-page) · [下載最新 Release](https://github.com/xing-shuyin/pi-web-ui/releases/latest)
- [Electron 桌面開發與構建說明](https://github.com/xing-shuyin/pi-web-ui/blob/main/desktop/README.md)

## 解壓與啟動

1. 將 ZIP 完整解壓到可寫目錄，例如行動硬碟上的 `PiWebUI-Portable/`。不要在壓縮包內直接執行，也不要只移動 `app/` 中的 EXE。
2. 雙擊根目錄的 `啟動Pi.bat` 或 `PiPortable.bat`。前者只是中文名入口，實際呼叫後者。指令碼按自身位置計算路徑，整目錄移動後仍可啟動。
3. 在應用內配置模型與認證，再選擇工作區。預設專案目錄是 `data/workspace/`；如選擇其他磁碟上的專案，這些專案檔案不會自動隨便攜目錄遷移。
4. 使用結束後先完全退出應用，等待終端和其他子程序結束，再彈出行動硬碟。

桌面服務預設嘗試 `127.0.0.1:8790`，端口占用時改用隨機空閒埠。模型配置與服務訪問配置是不同事項；`/setup` 用於訪問口令、監聽等服務設定，具體訪問限制和步驟見上方官網指南。若需要在瀏覽器開啟，請使用實際服務地址。

執行桌面應用本身使用 Electron 內建的 Node 執行能力，不需要系統 Node.js。終端中的 `node`、`npm`、`npx` 則需要獨立 Node.js；Git/Bash 工作流需要 PortableGit 或本機對應工具。**不是所有便攜包都預設捆綁獨立 Node.js 和 Git。**

## 目錄佈局與資料

```text
PiWebUI-Portable/
├── PiPortable.bat             # 實際啟動入口
├── 啟動Pi.bat                 # 呼叫 PiPortable.bat
├── CreateDesktopShortcut.bat  # 建立 Windows 桌面快捷方式
├── 建立桌面快捷方式.bat       # 呼叫英文名快捷方式指令碼
├── README.md                  # 本說明也會複製到分發包根目錄
├── Portable.flag              # Electron 便攜模式標記
├── app/                       # 完整 Electron 應用，不能只保留 EXE
│   ├── pi-web-ui-desktop.exe
│   └── ...
├── runtime/                   # 可選獨立工具；目錄存在不代表已安裝
│   ├── git/                   # PortableGit：cmd/git.exe、bin/bash.exe 等
│   └── node/                  # 獨立 Node.js：node.exe、npm.cmd、npx.cmd 等
├── data/
│   ├── agent/                 # pi 配置、auth.json、models.json 與會話歷史
│   ├── web/                   # WebUI 配置、外掛、審批規則、上傳等資料
│   ├── electron/              # Electron 狀態、Cookies 與 session 快取
│   ├── workspace/             # 預設專案工作區
│   ├── git/                   # Git 全域性配置 .gitconfig
│   ├── home/                  # 重定向的 HOME/USERPROFILE，如工具建立的 .ssh
│   ├── npm-global/            # 使用便攜 Node 時的 npm 全域性包和命令
│   └── npm-cache/             # 使用便攜 Node 時的 npm 快取
└── checks/                    # 啟動診斷文案
    ├── fatal-app.*.txt
    ├── warn-git.*.txt
    └── run-info.*.txt
```

`data/agent/` 中可能有 API Key，`data/home/` 中可能有 SSH 金鑰，`data/web/` 中也可能有敏感配置。備份時妥善保管；不要將使用過的 `data/` 隨程式重新分發。便攜啟動不會自動匯入本機現有的 pi 配置；需要複用時，退出相關服務後選擇性複製 `~/.pi/agent` 的配置或會話到 `data/agent/`。

這些重定向讓主要應用資料隨目錄攜帶，不是“零痕跡”保證。Windows、防毒軟體、臨時目錄、外部 CLI、憑據管理器及使用者自行指定的路徑仍可能產生包外資料；指令碼也不會清理宿主機記錄。

## Git、Node 與額外引擎

檢查檔案而不是隻看目錄名：

| 需要的能力                     | 指令碼識別的檔案          | 啟動後的行為                                                                 |
| ------------------------------ | ------------------------- | ---------------------------------------------------------------------------- |
| Git、Bash、SSH 等 Windows 工具 | `runtime/git/cmd/git.exe` | 將 PortableGit 路徑加入 PATH；找到 Bash 時設定 `SHELL` 與 `PI_WEB_SHELL`     |
| `node`、`npm`、`npx`           | `runtime/node/node.exe`   | 加入獨立 Node 與 `data/npm-global` 到 PATH，設定 npm prefix/cache 到 `data/` |

沒有內建 Git 時指令碼提示後繼續啟動，相關能力依賴系統環境；沒有獨立 Node 時不執行 npm 環境掛載，終端會沿用系統 PATH 中可用的命令。Electron 自帶的執行能力不等同於在終端提供了 `npm`。

需要手動補充時，退出應用後：

- 從 [Git for Windows Releases](https://github.com/git-for-windows/git/releases) 下載合適的 PortableGit，解壓內容到 `runtime/git/`，確保不是多套了一層目錄。它提供 Windows 下的 Git/Bash 工具，不是完整 Linux 系統。
- 從 [Node.js 下載頁](https://nodejs.org/en/download) 獲取符合要求的 Windows ZIP（專案要求 Node.js >=22.19.0），將包內檔案放到 `runtime/node/`，確保 `node.exe` 直接在該目錄中。選擇與目標機器匹配的架構。

重啟後可在應用終端執行 `git --version`、`node --version`、`npm --version` 檢查。使用便攜 Node 時，例如 `npm i -g @anthropic-ai/claude-code` 或 `npm i -g @deepseek-ai/dsh` 會將 npm 全域性包放到 `data/npm-global/`；這些額外引擎仍可能需要聯網、認證、其他依賴或獨立資料路徑，換電腦後也可能需要重新配置。

## 快捷方式

雙擊 `建立桌面快捷方式.bat` 或 `CreateDesktopShortcut.bat`，指令碼通過 PowerShell 和 `WScript.Shell` 在當前使用者桌面寫入 `Pi Web UI.lnk`，同名連結會被更新。連結指向便攜包中的啟動指令碼，圖示來自 `app/pi-web-ui-desktop.exe`，啟動視窗設為最小化。

快捷方式儲存的是建立時的絕對路徑。移動資料夾或更換磁碟機代號後應重新建立；不需要時手動刪除桌面連結即可。此操作會在宿主機寫檔案。

## 升級與遷移

1. 完全退出舊應用，停止仍在執行的相關終端與外部工具。
2. 備份整個舊目錄，至少保留完整的 `data/`，以及實際使用的外部工作區或自定義資料目錄。
3. 將新版本 ZIP 解壓到**新目錄**，把舊 `data/` 複製到新包中，保留新包的 `app/`、啟動指令碼、`Portable.flag` 和 `checks/`。
4. 按需遷移舊 `runtime/` 中自行安裝的工具；如新包已包含新版工具，先檢查版本與相容性，避免直接覆蓋回舊版。
5. 啟動新目錄，核對模型認證、會話、工作區與工具，再處理舊目錄並重建快捷方式。

便攜 ZIP 不應依賴安裝版更新器來維護佈局；優先採用上述手動遷移方式。全域性執行 `npm i -g pi-web-ui@latest` 不會替換 `app/` 中的 Electron 應用。

**不要通過重跑 `scripts/make-portable.mjs` 升級正在使用的目錄。** 它是分發包組裝工具，會清空 `release/PiWebUI-Portable/data/` 下的 `agent`、`web`、`git`、`home`、`workspace`、`electron`、`npm-global`、`npm-cache`，並替換 `app/`。

## 啟動指令碼、環境變數與構建邊界

`PiPortable.bat` 首先檢查 `app/pi-web-ui-desktop.exe`，缺失時退出；對可選執行時的檢查只驗證入口檔案，並不驗證依賴是否完整。`checks/` 按控制台內碼表顯示補充資訊：936 選擇 GBK、65001 選擇 UTF-8，其他內碼表仍有指令碼內的英文基礎提示。

通過 BAT 啟動時，指令碼會覆蓋以下變數為包內路徑：

| 變數                                     | BAT 設定值                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `PI_PORTABLE` / `PI_PORTABLE_ROOT`       | `1` / 指令碼所在目錄                                                        |
| `PI_CODING_AGENT_DIR`                    | `<包根>/data/agent`                                                         |
| `PI_WEB_DATA_DIR`                        | `<包根>/data/web`                                                           |
| `PI_WEB_CWD`                             | `<包根>/data/workspace`                                                     |
| `GIT_CONFIG_GLOBAL`                      | `<包根>/data/git/.gitconfig`                                                |
| `HOME` / `USERPROFILE`                   | `<包根>/data/home`                                                          |
| `NPM_CONFIG_PREFIX` / `NPM_CONFIG_CACHE` | 檢測到獨立 Node 時設定為 `<包根>/data/npm-global` / `<包根>/data/npm-cache` |

指令碼另傳 `--user-data-dir=<包根>/data/electron` 並將額外引數轉發給 EXE；這不表示所有 WebUI CLI 引數都會被桌面殼處理。`PI_WEB_PORT`、`PI_WEB_HEALTH_TIMEOUT_MS` 等未被 BAT 重設的變數可從父程序繼承。

Electron 自身的便攜探測由 `desktop/portable.ts` 實現：識別 `PI_PORTABLE_ROOT`、`PORTABLE_EXECUTABLE_DIR`、`PI_PORTABLE=1/true`，也識別 EXE 同級或特定父級的 `Portable.flag`、`portable.flag`、`data/`、`runtime/git`、`runtime/node`。因此在完整佈局中直接開啟 `app/pi-web-ui-desktop.exe` 也可啟用便攜模式。

需要自定義資料位置時，可直接啟動 EXE，並按需設定絕對路徑的 `PI_PORTABLE_DATA_DIR`、`PI_WEB_DATA_DIR`、`PI_CODING_AGENT_DIR`、`PI_WEB_CWD`、`PI_PORTABLE_HOME`、`GIT_CONFIG_GLOBAL`；檢測到便攜 Node 時也支援 `NPM_CONFIG_PREFIX`、`NPM_CONFIG_CACHE`。`PI_PORTABLE_DATA_DIR` 只改變其餘未覆蓋路徑的預設基目錄，**不會移動舊資料**。若經 BAT 啟動，其硬編碼賦值和 `--user-data-dir` 仍會生效，不能假定只設置一個變數就把所有資料搬走。

原始碼構建在倉庫根進行，scripts 位於根 `package.json`：

```bash
npm ci
npm run desktop:portable       # 構建並組裝目錄，預設不下載 Git/Node
# 或：npm run desktop:portable:full  # 增加 Git，仍不自動下載獨立 Node
```

已經構建服務端、前端與桌面殼後，可執行：

```bash
node scripts/make-portable.mjs --with-git --with-node --zip
```

輸出為 `release/PiWebUI-Portable/`，加 `--zip` 時額外生成 `release/pi-web-ui-desktop-<版本>-portable.zip`。`--skip-pack` 僅跳過 electron-builder，要求已有正確的 `release/win-unpacked/`；組裝指令碼本身不編譯原始碼。`PI_BUNDLE_PORTABLE_GIT=1` 與 `PI_BUNDLE_PORTABLE_NODE=1` 分別等效於對應下載選項。

當前 Release CI 顯式使用 `--with-git --with-node`，但本地基礎命令沒有這兩個預設下載行為，組裝指令碼還會複用已有 `runtime/`。當前自動下載源是 Windows x64 的 Git/Node，解壓失敗可能僅列印警告；分發者需要檢查實際檔案和版本，不能僅憑命令名或目錄存在宣稱“完整捆綁”。
