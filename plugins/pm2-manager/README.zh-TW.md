[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# pm2-manager · 程序管家

pm2 **安裝 / 管理 / 解除安裝一體**：沒裝 pm2 時面板一鍵安裝；裝好後面板直接起新應用
（安裝到 pm2），應用表看狀態/日誌、做停止/重啟/刪除；不用 pm2 時一鍵解除安裝本體。
AI 起的長期服務/除錯例項有一個統一去處：pm2 —— 於是**有名字、有狀態、有日誌、
能單獨停**，宿主頂欄「後臺任務」面板與外掛面板看到的是同一份列表。

> 現場問題：AI 除錯時後臺起一堆例項（本機實測一次遺留 12 個 `dist/server/index.js`，
> CPU 打滿），既不在任何列表裡也停不乾淨。這個外掛提供治它的工具與面板。

> **不接管**：本外掛不對 AI 的命令做任何攔截或追加提示（沒有 `onToolPre` 閘門、沒有
> `#bg-ok` 逃生門、沒有事後催辦）。寫不寫 `nohup` / 尾部 `&` 由模型自己決定，
> 使用者想看/想管就開面板。

## 它做了兩件事

| #   | 做什麼         | 怎麼做的                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **提示詞引導** | 註冊單個 action 式 `pm2` 工具，`description` / `promptSnippet` / `promptGuidelines` 三處告訴模型「長期任務走 pm2 更省心」，不必猜；`action=install/uninstall` 覆蓋 pm2 本體的裝卸                                                                                                                                                                                                                                 |
| 2   | **內嵌面板**   | 宿主「後臺任務」面板裡就地嵌一塊「pm2 託管的應用」（`view:false` + `ui["tasks.panel"]`）：應用表（狀態/CPU/記憶體/重啟/時長）、看日誌、停止/重啟/刪除；「➕ 啟動新應用」表單直接起服務（安裝到 pm2）；底部「解除安裝 pm2」二次確認後卸本體；pm2 缺失時一鍵安裝。宿主自己 diff 出來的裸程序列表仍在上方 —— 同一個面板，各管一段，不重複列（**不給每個應用註冊 `registerBackgroundTask`**，那會讓同一個應用列兩遍） |

## 給 AI 的用法（工具 `pm2`）

```
action=list                      # 列出託管的應用（含 CPU/記憶體/重啟/時長）
action=start name=api script=server.js args=["--port","8788"] cwd=/path
action=logs  name=api lines=100  # 讀輸出（不用再留一個無人看管的程序）
action=stop|restart|delete name=api      # name=all 可整批（delete=解除安裝單個應用，只刪記錄不卸本體）
action=install                   # 一鍵 npm i -g pm2（未安裝時）
action=uninstall                 # 解除安裝 pm2 本體（先 pm2 kill，再 npm uninstall -g pm2）
```

約定（寫在工具提示詞裡，模型每輪都能看到）：

- 起後臺/長期任務用 `action=start`，比 `nohup`、尾部 `&`、Windows `start`、`Start-Process` 更省心；
- 起第二份同名服務前先 `action=list`，不需要的用 `action=delete` 清掉；
- 想看輸出用 `action=logs`，別把程序丟在後臺不聞不問。

這些都是**建議**：外掛不攔截任何命令，AI 真用了脫管寫法也能跑，只是那些程序不在 pm2 列表裡。

面板首幀**不搶答**：首次 `GET /status` 回來前只顯示中性的「正在檢測 pm2 環境…」，不說
「未檢測到 pm2」也不說「沒有託管任何應用」—— 否則每次點開「後臺任務」都會先閃一下黃條
（看著像報錯，其實只是狀態還沒到）。

## 跨平臺

pm2 是 npm 全域性包，**Windows / macOS / Linux 都能跑**，本外掛在三個平臺上都走同一條呼叫鏈：

1. 先按 `設定.pm2Bin` → 環境變數 `PI_WEB_PM2` → node 字首（`dirname(process.execPath)/node_modules/pm2/bin/pm2`）
   找 pm2 的 **JS 入口**；
2. 都沒命中才去問 `npm root -g`（這一步才起子程序，且只在按需路徑上）；
3. 呼叫一律 `node <pm2 的 JS 入口> <args>` —— **不走 PATH、不碰 `.cmd` 墊片**，繞開
   Windows 上 `execFile("pm2")` 直接 EINVAL、以及服務化執行時 PATH 裡沒有全域性 bin 目錄兩個坑。

平臺差異只在一處：**Windows 不支援 `pm2 startup` 開機自啟**（官方限制），所以本外掛不碰自啟。
「遺留裸例項」的跨平臺掃描（netstat/ss/lsof + 程序樹）由**宿主**的後臺任務面板自己負責，本外掛
不再重複實現一套，避免同一份資訊在一個面板裡列兩遍。

## 設定

| key      | 預設 | 作用                                                                       |
| -------- | ---- | -------------------------------------------------------------------------- |
| `pm2Bin` | 空   | pm2 入口絕對路徑（留空自動探測）；填的是 `bin/pm2`（JS 入口），不是 `.cmd` |

## HTTP 路由（面板用）

`/plugins-api/pm2-manager/*`：`GET /status`、`POST /install`（裝本體）、`POST /uninstall`（卸本體，先 `pm2 kill` 再 `npm uninstall -g pm2`）、`POST /action`（`stop`/`restart`/`delete`/`logs`/`describe`/`start`，start 需 `script`）。刪單個應用走 `delete`（只刪記錄不卸本體），和卸本體是兩回事。

## 許可權

`ui`（`tasks.panel` 槽位）、`tools`（AI 工具）、`http`（面板路由）。

## 檔案

- `manifest.json`：manifest（含 settings schema、`view:false` 與 `ui["tasks.panel"]` 條目）
- `index.mjs`：服務端入口 —— 上半是**純函式區**（pm2 入口候選 / jlist 解析 / 格式化 / `buildPm2StartArgv` 拼 start 引數，單測直接從本檔案 import），下半是 activate（探測、AI 工具、HTTP 路由：裝本體 / 卸本體 / 管應用）
- `client/entry.mjs`：內嵌面板（`mount(container)` → 返回 cleanup；面板關閉或外掛過載時宿主調 cleanup 收攤）

> 純函式**刻意內聯**在 `index.mjs` 而不是單獨成檔案：宿主的 `plugins_reload` 只給
> `index.mjs` 的 import 加 `?e=<epoch>` 快取擊穿，被它靜態 import 的兄弟模組會命中
> Node ESM 模組快取 —— 改了不隨 reload 生效，必須重啟服務（踩過一次）。

- 單測：`tests/unit/pm2-manager.test.ts`（純函式 + 假宿主 activate，零埠零子程序，含裝卸常量與 `buildPm2StartArgv`）、
  `tests/unit/pm2-manager-panel.test.ts`（面板首幀不搶答、啟動表單下發 start、解除安裝二次確認）
