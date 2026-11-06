# pi-web-ui

[English](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.md) · [简体中文](https://github.com/xing-shuyin/pi-web-ui/blob/main/README.zh-CN.md) · **繁體中文**

[![npm 版本](https://img.shields.io/npm/v/pi-web-ui?color=cb3837&logo=npm)](https://www.npmjs.com/package/pi-web-ui)
[![Node.js](https://img.shields.io/node/v/pi-web-ui?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

pi-web-ui 是面向 AI 程式開發代理的 Web 工作台，將對話、檔案、終端機與 Git 放在同一個介面。它基於 [pi coding agent](https://github.com/badlogic/pi-mono)，支援在瀏覽器中使用，也提供 Electron 桌面版與 Windows 可攜版。

**[官方網站](https://xing-shuyin.github.io/pi-web-ui-site/)** · **[文件中心](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)** · [下載發行版](https://github.com/xing-shuyin/pi-web-ui/releases/latest) · [更新紀錄](CHANGELOG.md)

## 快速開始

npm、npx 和原始碼安裝需要 **Node.js ≥ 22.19.0** 與 npm。Windows 請先安裝 [Git for Windows](https://git-scm.com/downloads/win)，保留 Git Bash；Linux 請準備 Python 3、make 和 C++ 編譯工具鏈。

```bash
npm install -g pi-web-ui@latest
cd /path/to/your-project
pwu .
```

`pwu`、`piwebui`、`pi-web-ui` 是等價命令，所有子命令與選項通用。使用 `pwu [目錄]` 即可在指定專案目錄啟動。

預設開啟瀏覽器，網址為 `http://127.0.0.1:8787`。在工作台設定中配置模型供應商、憑證與模型，再開始對話。安裝完成不代表模型已經可用。

不安裝全域命令也可在專案目錄執行：

```bash
npx pi-web-ui@latest
```

若 npm 12+ 阻擋相依套件安裝指令碼，視需要使用以下命令；舊版 npm 使用上面的普通命令：

```bash
npm install -g --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
# npx 對應寫法：
npx --allow-scripts=node-pty,@google/genai,protobufjs pi-web-ui@latest
```

`node-pty` 需要安裝指令碼支援終端機功能，請勿用 `--ignore-scripts` 跳過。原生模組建置失敗時，參閱[安裝指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation)補齊平台工具鏈。

## 選擇安裝方式

| 方式              | 適用情境                   | 入口與說明                                                                                                            |
| ----------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| npm 全域安裝      | 經常使用 CLI、管理背景服務 | `npm install -g pi-web-ui@latest`                                                                                     |
| npx               | 快速試用、按需啟動         | `npx pi-web-ui@latest`；仍會使用 npm 快取與應用程式資料目錄                                                           |
| Electron 桌面版   | 獨立桌面視窗               | [Releases](https://github.com/xing-shuyin/pi-web-ui/releases/latest)：按系統與架構選安裝包；啟動應用程式無需另裝 Node |
| Windows 可攜版    | 解壓縮後使用、攜帶設定     | 同一 Releases 頁選擇 portable zip；解壓縮後執行 `启动Pi.bat` / `PiPortable.bat`，設定與工作區放在可攜目錄中           |
| Docker 原始碼建置 | 容器部署                   | 使用儲存庫的 `docker-compose.yml`，見下方步驟                                                                         |
| 原始碼執行        | 開發或自行建置             | `npm ci` → `npm run build` → `npm start`                                                                              |
| Android / Termux  | 手機本機執行               | 按[安裝指南的 Termux 一節](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#termux-install)準備原生建置環境     |

桌面安裝包、可攜包的具體平台與架構以該次 Release 附件為準。桌面應用程式中的外掛安裝和外部命令仍可能需要 Node/npm、Git 等工具；可攜版也可能使用系統網路、快取或外部工具。

## 前景執行與背景服務

前景預設使用目前目錄作為工作區；按 `Ctrl+C` 停止。伺服器上可停用自動開啟瀏覽器：

```bash
pi-web-ui --cwd "/path/to/project" --port 9000 --no-browser
```

確認專案、模型和終端機可用後，再安裝背景服務。**`server install` 會安裝並立即啟動服務**；`server start` 用於啟動已經安裝但停止的服務。

```bash
pi-web-ui server install --cwd "/path/to/project" --data-dir "/path/to/pi-data"
pi-web-ui server status
```

日常管理已安裝的服務：

```bash
pi-web-ui server start    # 僅在已安裝且停止時使用
pi-web-ui server status
pi-web-ui server restart
pi-web-ui server stop
```

不再需要背景服務時，另行執行：

```bash
pi-web-ui server uninstall
```

解除安裝服務不會解除安裝 npm 套件，也不會自動清理使用者資料。

macOS 使用使用者 launchd，Linux 使用 systemd，Windows 使用目前使用者登入自啟動 Run 登錄機碼。Windows 的實作不等同於系統層級 Windows Service；Linux 安裝所需權限取決於系統設定。

- 服務預設工作區為 **`~/pi-web-ui`**；前景預設目前目錄。
- CLI 服務資料預設放在 **`~/.pi-web`**，以執行帳戶的家目錄為準。
- pi Agent 設定預設放在 **`~/.pi/agent`**，與工作區、服務資料目錄不同。
- 建議明確固定工作區與資料目錄；服務環境未必繼承互動式終端機中的憑證和環境變數。
- `server install --print` 可預覽設定；使用 `--name my-pi` 安裝多個實例時，後續管理命令帶相同名稱。

更多部署與疑難排解說明見[啟動參數、服務與 /setup](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#cli-and-env)。

## 常用參數與 /setup

| 參數                   | 用途與預設值                                                 |
| ---------------------- | ------------------------------------------------------------ |
| `--cwd <dir>`          | 專案工作區；包含空格的路徑請加引號                           |
| `--port <n>`           | HTTP / WebSocket 連接埠，預設 `8787`                         |
| `--host <addr>`        | 監聽位址，預設 `127.0.0.1`；`0.0.0.0` 監聽所有 IPv4 網路介面 |
| `--data-dir <dir>`     | 服務資料目錄，預設 `~/.pi-web`                               |
| `--agent-dir <dir>`    | pi Agent 設定目錄，預設 `~/.pi/agent`                        |
| `--engine <pi\|dsh>`   | 執行引擎，預設 `pi`；DSH 需滿足其執行與模型設定要求          |
| `--no-browser`         | 前景啟動時不自動開啟瀏覽器                                   |
| `--help` / `--version` | 查看目前安裝版本支援的參數或版本號                           |

常用環境變數對應 `PI_WEB_CWD`、`PI_WEB_PORT`、`PI_WEB_HOST`、`PI_WEB_DATA_DIR`、`PI_CODING_AGENT_DIR` 與 `PI_WEB_ENGINE`。`PI_WEB_SDK=bundled` 可固定使用隨套件提供的 SDK；沒有 `--sdk` 參數。

### 本機設定入口

啟動後，在執行服務的機器上開啟 **`http://127.0.0.1:8787/setup`**，連接埠按實際設定替換。`/setup` 是瀏覽器路徑，用來設定存取通行碼與網路；模型 API Key、登入與模型選擇在工作台設定中完成。

`/setup` 僅接受回環連線和本機 Host，區域網路 IP、公開網域及帶代理轉送標頭的請求會被拒絕。遠端伺服器可透過 SSH 本機轉送存取：

```bash
ssh -N -L 18787:127.0.0.1:8787 user@your-server
# 保持連線，在本機瀏覽器開啟 http://127.0.0.1:18787/setup
```

1. 核對頁面顯示的設定檔路徑，確認實例正確。
2. 設定存取通行碼、監聽位址、連接埠及按需使用的 Host / Origin 允許清單。
3. 點擊「儲存設定」，確認儲存成功；隨機產生或複製連結本身不會儲存。
4. **通行碼儲存後立即熱更新；網路設定儲存後需重新啟動**對應程序或服務。

留空通行碼並儲存會關閉通行碼驗證。該頁面位於通行碼驗證前，本機使用者可在忘記通行碼時重設。帶通行碼的入口連結應按憑證保管。

設定儲存在 `<dataDir>/server-config.json`。支援對映的設定按 **命令列參數 → 環境變數 → 設定檔 → 預設值** 取值；CLI 不自動讀取任意 `.env` 檔案。工作區與引擎仍由啟動參數或環境設定。

例如啟動命令仍帶 `--port 9000`，重新啟動後就會覆寫 `/setup` 儲存的連接埠。通行碼雖能在目前實例熱更新，重新啟動時也需檢查 存取通行碼環境變數 是否覆寫儲存值。

跨裝置存取前設定通行碼、網路存取範圍與按需使用的 HTTPS。Host 允許清單檢查請求主機名稱，並非用戶端 IP 允許清單；不能當作額外的存取隔離保證。Docker 的連接埠對映也不等同於容器內回環連線，通常透過 Compose 設定網路與通行碼。

## 使用儲存庫 Compose 建置 Docker

```bash
git clone https://github.com/xing-shuyin/pi-web-ui.git
cd pi-web-ui
# 先編輯 docker-compose.yml，替換預設存取通行碼並按需設定掛載
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 pi-web-ui
```

Compose 使用 `build: .` 從本機原始碼建置，`pi-web-ui:latest` 是本機映像標籤。首次啟動前，將 存取通行碼環境變數 的範例值 `change-me` 換成自己的通行碼。

- 服務對映連接埠為 `8787:8787`，容器監聽 `0.0.0.0`；透過主機位址存取。
- 具名磁碟區 `pi-web-data` 掛載到 **`/app/.pi-web`**，儲存服務資料。
- 操作主機專案時，新增綁定掛載，例如 `/host/project:/workspace`，並設定 `PI_WEB_CWD: /workspace`。
- 如需重用 pi 設定，可按 Compose 註解掛載 Agent 目錄，並設定 `PI_CODING_AGENT_DIR`；模型憑證另行準備。

更新原始碼後再次執行 `docker compose up -d --build`。`docker compose down` 保留具名磁碟區；加 `--volumes` 會刪除磁碟區內資料。升級前備份資料，專案檔案也應放在持久掛載中。

更多步驟見 [Docker 原始碼安裝](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#docker-source-install)。

## 更新與移除

```bash
npm install -g pi-web-ui@latest
pi-web-ui server restart  # 已安裝服務時執行；前景程序自行重新啟動
```

桌面與可攜版請依對應套件的更新方式操作，保留實際資料目錄。移除前備份需要的對話、設定與憑證；npm 使用者先解除安裝服務，再執行 `npm uninstall -g pi-web-ui`。移除套件不會刪除另外儲存的使用者資料。

## 可以做什麼

- **對話與任務**：串流回覆、Markdown、圖片與附件、提示詞範本、歷史搜尋，以及多對話和子代理協作。
- **專案工作台**：檔案瀏覽與編輯、預覽、內建 PTY 終端機、Git 狀態和差異檢視，在對話旁完成日常專案操作。
- **執行控制**：工具審批、計畫模式、目標模式與審查委派，按任務選擇執行方式；實際權限取決於執行帳戶、工具與部署環境。
- **模型與擴充**：管理供應商和模型，使用 pi / DSH 引擎及各自支援的能力；透過外掛、MCP、技能和 UI 擴充點自訂工作台。
- **介面與部署**：多語言、主題、行動版面、瀏覽器與桌面入口，以及背景服務部署。

各引擎的對話格式、工具和設定能力存在差異，切換前請參閱[文件中心](https://xing-shuyin.github.io/pi-web-ui-site/docs.html)。介面中的審批與執行控制應結合實際系統權限使用。

## 介面預覽

以下為儲存庫現有截圖；具體介面隨版本與主題變化。

| 對話與提示詞                              | 設定面板                          |
| ----------------------------------------- | --------------------------------- |
| ![對話與提示詞](assets/chat-prompts.jpeg) | ![設定面板](assets/settings.jpeg) |

| 內建終端機                          | Git 工作區                     |
| ----------------------------------- | ------------------------------ |
| ![內建終端機](assets/terminal.jpeg) | ![Git 工作區](assets/git.jpeg) |

## 文件與外掛

- [完整安裝指南](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#installation) · [啟動與服務](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#cli-and-env)
- [遠端 SSH 專案](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#remote-ssh-projects) · [計畫、目標與審查流程](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#modes-guide)
- [MCP 與瀏覽器工具](https://xing-shuyin.github.io/pi-web-ui-site/docs.html#mcp-and-browser) · [外掛 SDK](plugin-sdk/README.md)
- [社群外掛目錄](https://github.com/xing-shuyin/pi-web-ui-plugins) · [環境變數](docs/env-vars.md) · [部署指南](docs/deployment.md)

可在工作台瀏覽外掛，或用 `pi-web-ui install owner/repo` 安裝、`pi-web-ui plugins` 檢視；權限與外部服務需求依外掛而異。

## 開發與貢獻

```bash
git clone https://github.com/xing-shuyin/pi-web-ui.git
cd pi-web-ui
npm ci
npm run dev
```

開發時存取 `http://localhost:5173`（Vite），後端預設連接埠為 `8788`。建置後執行：

```bash
npm run build
npm start
```

原始碼執行預設連接埠為 `8787`，`npm start` 不自動開啟瀏覽器。開發規範、測試與架構入口見 [AGENTS.md](AGENTS.md) 和[開發指南](docs/development.md)；桌面開發見 [desktop/README.md](desktop/README.md)。

歡迎透過 [Issues](https://github.com/xing-shuyin/pi-web-ui/issues) 回報問題或提出需求，透過 Pull Request 提交改進。回報問題時請附版本、系統、安裝方式、重現步驟與移除敏感資訊的日誌。

## 社群與聯絡

- QQ 交流群：`1126050727`
- [GitHub Discussions](https://github.com/xing-shuyin/pi-web-ui/discussions)：交流用法與想法
- [GitHub Issues](https://github.com/xing-shuyin/pi-web-ui/issues)：問題回報與需求建議
- [dsh-ui-tools](https://github.com/xing-shuyin/dsh-ui-tools)：作者相關專案，DSH 生態 UI 工具集

## 授權條款

本專案採用 [MIT License](LICENSE)。
