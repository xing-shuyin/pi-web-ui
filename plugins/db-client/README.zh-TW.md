[English](./README.en.md) · [简体中文](./README.md) · **繁體中文**

# db-client —— 資料庫連線管理外掛

pi-web-ui 介面外掛，類似 [vscode-database-client](https://github.com/cweijan/vscode-database-client)
的網頁版精簡體驗：連線管理 + 庫表樹瀏覽 + 表結構檢視 + 資料分頁瀏覽 + SQL 查詢編輯器。

## 支援的資料庫

| 型別            | 驅動                | 預設埠        | 說明                                                                          |
| --------------- | ------------------- | ------------- | ----------------------------------------------------------------------------- |
| MySQL / MariaDB | mysql2              | 3306          | 庫/表/檢視、列+索引+DDL（SHOW CREATE TABLE）、分頁排序、SQL                   |
| PostgreSQL      | pg                  | 5432          | public schema 表/物化檢視/普通檢視、主鍵/索引、跨庫切換瀏覽、SQL              |
| SQLite          | node:sqlite（內建） | —（檔案路徑） | 開啟本地 .db 檔案，零額外依賴；PRAGMA 結構、分頁、SQL、行編輯（≥ Node 22.13） |
| SQL Server      | mssql               | 1433          | 自動探測 schema、OFFSET/FETCH 分頁、SQL                                       |
| MongoDB         | mongodb             | 27017         | 庫/集合樹、文件分頁（JSON 過濾條件如 `{"age":{"$gt":18}}`）、索引；不支援 SQL |
| Redis           | ioredis             | 6379          | 鍵模式掃描、鍵詳情（型別/TTL/大小/值預覽）、原始命令列                        |

驅動依賴**不隨包分發**：首次啟用自動 `npm install` 到外掛目錄（也可點左欄「安裝驅動」手動觸發）。
只裝了部分驅動也能用對應型別，未裝的型別在連線時報友好提示。

## 安裝 / 解除安裝 / 更新

```bash
# ── 安裝 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client
pi-web-ui install plugins/db-client      # 或本地目錄（開發態）
# 可選：--data-dir <dir> 自定義資料目錄（預設 ~/.pi-web）

# ── 檢視 ──
pi-web-ui plugins                            # 列出已裝外掛與 id

# ── 更新 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/db-client --force
                                             # --force 覆蓋重灌即更新
                                             # ⚠ 先備份外掛目錄裡的 db-connections.json（連線憑據）

cp -r plugins/db-client ~/.pi-web/plugins/  # 本地開發態：改完 src 後先 npm run build 再複製
                                             # Windows: %USERPROFILE%\.pi-web\plugins\db-client

# ── 解除安裝 ──
pi-web-ui uninstall db-client                # 移除外掛目錄（db-connections.json 一併刪除）
# 手動方式：rm -rf ~/.pi-web/plugins/db-client
```

重新整理瀏覽器即生效（頂欄出現 🗄️ 標籤頁）。

## 功能

- **連線管理**：新建 / 編輯 / 刪除 / 測試連線；配置存本機 `<dataDir>/plugins/db-client/db-connections.json`，**連線密碼走宿主加密機密（`host.secrets`，AES-256-GCM），檔案裡不再落明文**（舊版宿主沒有機密設施時回退明文；`uri` 裡內嵌的憑據無法可靠拆分，仍在檔案裡），回顯脫敏
- **多連線並存**：最多同時開啟 8 個，互不干擾，斷線自動提示
- **資料瀏覽**：分頁（首頁/上下頁/末頁）、點選列頭排序、NULL 弱化顯示、行數統計（大表用估算行數）
- **結構檢視**：列清單（型別/可空/主鍵/預設值/備註）、索引、DDL 文本
- **SQL 編輯器**：Ctrl/Cmd+Enter 執行，顯示耗時與影響行數，結果表格化
- **MongoDB**：集合瀏覽 + JSON 過濾條件分頁查文件
- **行編輯**：雙擊單元格直接改值（Enter 提交 / Esc 取消）、懸停刪除單行、「＋ 新增行」表單；
  無主鍵的 SQLite 表自動用 rowid 定位；輸入 NULL（大寫）表示寫入 SQL NULL
- **MongoDB 編輯**：文件 JSON 視覺化編輯（✎）/ 刪除 / 新增；_id 十六進位制字串自動還原 ObjectId
- **Redis 編輯**：字串鍵值線上修改儲存
- **Redis**：pattern 掃描鍵列表、TTL/型別徽標、值按型別渲染（string/hash/list/set/zset/stream）、任意原始命令

## 協議

上行 `{ action, reqId, ... }`，下行響應 `{ res: true, reqId, ok, ... }`（reqId 匹配）；
事件 `{ event: "conn_closed", ... }` 定向推送；狀態廣播 `{ kind: "state", state }`。
詳見 `index.mjs` 頭部註釋。

## 迴歸測試

```bash
npm run build:server
node tests/db-client-test.mjs   # 埠 8968，SQLite 全鏈路協議測試（零 token 零依賴，已進 run-smoke 清單）
```
